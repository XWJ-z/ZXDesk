/**
 * http-util.js —— HTTP 读写与错误出口（请求体 / 响应 / 四条错误规则）
 *
 * 功能：`readBody` / `readRawBody` 读请求体（后者带上传字节上限，超限立刻回 413）、
 *      ⭐ `readBodyToFile` 把上传字节**边收边写磁盘**（文件落盘用，超限同样先回 413）、
 *      `json` 发 JSON、`fail` 统一收口错误（记日志 + 响应体带 `readOnly`）、
 *      `httpError` 造可抛的错误、`notFound` 统一 404、`idParam` 解析路径里的 id、
 *      `writeResult` 把「改没改动」写成统一响应、`badDateRange` 判日期区间、
 *      ⭐ `rfc5987` 编码附件下载的中文文件名（见下）。
 *
 * ⚠️ **错误出口只有四条规则，不要加第五种写法**（输入不合法 400 / 鉴权 401·403·429 /
 *    404 不存在与越权逐字一致 / 413 上传超限）：细节见 `docs/公共/架构文档/01-架构总览.md`。
 * ⚠️ 在 `readBody` / `readRawBody` 的回调里 `throw` 是**安全**的 —— 两者的 `cb()` 都包在
 *    `try/catch` 里并转给 `fail()`；这两个回调跑在 `'end'` 事件里，外层 `createServer` 的
 *    `try/catch` **抓不到**，不在这层接住，请求会挂到超时（只读降级抛的 503 就属于这一类）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.13
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { logLine, store } = require('./context.js');

// ---- 请求体 JSON 解析 ----
/**
 * 功能：读完请求体并解析成 JSON（空体或解析失败一律得到 null），再把结果交给回调 `cb`。
 *
 * 说明：⚠️ 必须在**这里**兜住异常：回调跑在 'end' 事件里，外层 createServer 的 try/catch 是**抓不到**的。
 * 只读降级时 store 的写操作会抛 503，若不在这一层接住，请求会挂到超时且前端只看到「无响应」。
 *
 * @param {Object} req - HTTP 请求对象（Node `http.IncomingMessage`）
 * @param {Object} res - HTTP 响应对象，仅在回调抛错时经 `fail()` 使用
 * @param {function(?*)} cb - 解析完成后的回调，收到解析结果；其内部 `throw` 由本函数转给 `fail()`
 * @returns {void}
 */
function readBody(req, res, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 2e6) req.destroy();
  });
  req.on('end', () => {
    let parsed = null;
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch (_e) {
        parsed = null;
      }
    }
    try {
      cb(parsed);
    } catch (e) {
      fail(res, e);
    }
  });
}

/**
 * 功能：以 JSON 形式回一个响应（状态码 + `application/json` 响应头 + 序列化后的对象）。
 * @param {Object} res - HTTP 响应对象
 * @param {number} code - HTTP 状态码
 * @param {*} obj - 要序列化的响应体
 * @returns {void}
 */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 上传体积上限（课表文件一般只有几十 KB，给到 2MB 已足够宽松） */
const MAX_UPLOAD = 2 * 1024 * 1024;

/**
 * 功能：收**原始字节**的请求体读取器（课表文件导入专用）—— 读完把 `Buffer` 交给回调，超限则回 413。
 *
 * 说明：⚠️ 现有 `readBody` **不能用**：它用**字符串拼接**（会把二进制撕碎）且只认 JSON。
 * ⚠️ 超限时**必须先回 413 再销毁请求**：只 `req.destroy()` 的话前端看到的是「无响应」，
 *    而不是一句能读懂的原因（与 AGENTS.md §六「错误出口要盖住异步回调」同一类问题）。
 * ⚠️ 回调跑在 `'end'` 事件里，外层 `createServer` 的 try/catch 抓不到 —— 必须在这里接住。
 *
 * @param {Object} req - HTTP 请求对象（Node `http.IncomingMessage`）
 * @param {Object} res - HTTP 响应对象，超限时用于回 413
 * @param {function(Buffer)} cb - 读取完成后的回调，收到完整请求体字节；其内部 `throw` 由本函数转给 `fail()`
 * @param {number} [limit] - 可选，请求体字节上限，默认 `MAX_UPLOAD`（2MB）
 * @param {string} [tooBigMsg] - 可选，超限时回给用户的**那句话**（缺省是课表导入那套措辞；
 *      ⭐ 0.8.6 加：AI 带图那条路由要的是「图太大」的说法，⛔ 不能说成「课表文件」）
 * @returns {void}
 */
function readRawBody(req, res, cb, limit = MAX_UPLOAD, tooBigMsg) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return; // 超限后不再缓存（但保持监听，让请求体被自然读掉，见下）
    size += c.length;
    if (size > limit) {
      aborted = true;
      json(res, 413, {
        error:
          tooBigMsg ||
          `文件太大（上限 ${Math.round(limit / 1024 / 1024)} MB）。课表文件一般只有几十 KB，请确认选对了文件。`,
      });
      // ⚠️ **不要在这里立刻 `req.destroy()`**：那会让仍在写请求体的客户端收到连接重置，
      //    表现为「网络错误」而不是我们刚写下去的那句 413（实测偶发、难复现）。
      //    正确做法是**保持 data 监听**（请求体会被自然读掉并丢弃），让客户端写完并读到响应。
      //    只有荒唐体积（8 倍上限）才直接断 —— 那种输入前端本就会先拦一次。
      if (size > limit * 8) req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let buf;
    try {
      buf = Buffer.concat(chunks);
    } catch (_e) {
      buf = Buffer.alloc(0);
    }
    try {
      cb(buf);
    } catch (e) {
      fail(res, e);
    }
  });
  req.on('error', () => {
    /* 客户端中断：不写响应，也不抛 */
  });
}

/**
 * 功能：把**上传的原始字节边收边写磁盘**的请求体读取器 —— 读完把落盘结果交给回调，超限则回 413。
 *
 * 说明：⭐⭐ 这是 0.8.12 · 2f 新增的**核心层能力**（协作附件要落盘）：既有 `readRawBody()` 把整个
 *      请求体**全缓存在内存里**（`const chunks = []`，上限 2MB），一个 10MB 的文件用它就是把
 *      二进制压在堆上。⚠️ 它**不改动也不删除** `readRawBody()` —— 课表导入 / AI 带图照旧走那边。
 *
 * ⚠️⭐ 两条**已经踩过**的硬规矩（别改）：
 *  ① **超限先回 413、再让请求体被自然读掉**：超限时立刻 `json(res, 413)`，随后 `data` 监听
 *     **保持不动**（字节被读掉并丢弃）—— ⛔ **绝不 `req.destroy()`**：实测那样客户端收到的是
 *     「网络错误」而不是我们刚写下去的那句 413（偶发、难复现）。
 *  ② **回调跑在 `'end'` 事件里，外层 `createServer` 的 `try/catch` 抓不到** ⇒ 写盘失败 / 超限 /
 *     中途断开**全部在本函数内部收口**（转给 `fail()` 或直接 `json()`），⛔ 绝不把异常抛进事件。
 *
 * ⚠️ 超限 / 写盘失败 / 客户端中断时**不许留下半个文件**：字节先写临时名 `<dir>/.<name>.part`，
 *    写完才 `rename` 成 `<dir>/<name>`；超限或写失败时把临时文件删掉。
 * ⚠️ 空体（0 字节）不落盘：回调收到 `{ path: null, size: 0 }`，由调用方决定怎么提示。
 * ⚠️ 磁盘文件名**由调用方给**（只用 id ＋ 扩展名），⛔ 绝不用用户上传时的原名。
 *
 * @param {Object} req - HTTP 请求对象（Node `http.IncomingMessage`）
 * @param {Object} res - HTTP 响应对象，超限 / 写失败时用于回响应
 * @param {Object} opts - 选项
 * @param {string} opts.dir - 落盘目录（本函数会按需递归创建）
 * @param {string} opts.name - 落盘文件名（⚠️ 由调用方保证只含安全字符，⛔ 不是用户给的名字）
 * @param {number} [opts.limit] - 字节上限，默认 `MAX_UPLOAD`
 * @param {string} [opts.tooBigMsg] - 超限时回给用户的那**句话**
 * @param {function({path: ?string, size: number})} opts.onDone - 成功回调，收到落盘路径与字节数
 *      （空体时 `path` 为 null）；其内部 `throw` 由本函数转给 `fail()`
 * @returns {void}
 */
function readBodyToFile(req, res, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : MAX_UPLOAD;
  const onDone = typeof o.onDone === 'function' ? o.onDone : () => {};
  const tmpPath = path.join(o.dir, '.' + o.name + '.part');
  const finalPath = path.join(o.dir, o.name);
  let fd = null;
  let size = 0;
  let aborted = false;
  let failed = false;

  /** 功能：关掉已打开的临时文件句柄（没打开就什么都不做）。 */
  const closeTmp = () => {
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch (_e) {
      /* 已经关了：忽略 */
    }
    fd = null;
  };
  /** 功能：把临时文件清掉（超限 / 写失败 / 客户端中断都走它）—— 宁可没有，也不留半个。 */
  const discard = () => {
    closeTmp();
    try {
      fs.unlinkSync(tmpPath);
    } catch (_e) {
      /* 还没建 / 已删：忽略 */
    }
  };

  req.on('data', (c) => {
    if (aborted || failed) return; // 已收口：保持监听，只为把请求体自然读掉
    size += c.length;
    if (size > limit) {
      aborted = true;
      discard();
      // ⚠️ 先回 413，再让请求体被自然读掉；⛔ 绝不 req.destroy()（见函数说明第 ① 条）。
      json(res, 413, {
        error: o.tooBigMsg || `文件太大（上限 ${Math.round(limit / 1024 / 1024)} MB）。`,
      });
      return;
    }
    if (fd === null) {
      try {
        fs.mkdirSync(o.dir, { recursive: true });
        fd = fs.openSync(tmpPath, 'w');
      } catch (_e) {
        failed = true;
        discard();
        fail(res, httpError(500, '文件保存失败，请稍后再试'));
        return;
      }
    }
    try {
      fs.writeSync(fd, c);
    } catch (_e) {
      failed = true;
      discard();
      fail(res, httpError(500, '文件保存失败，请稍后再试'));
    }
  });

  req.on('end', () => {
    if (aborted || failed) return;
    closeTmp();
    if (size === 0) {
      discard();
      try {
        onDone({ path: null, size: 0 });
      } catch (e) {
        fail(res, e);
      }
      return;
    }
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (_e) {
      discard();
      fail(res, httpError(500, '文件保存失败，请稍后再试'));
      return;
    }
    try {
      onDone({ path: finalPath, size });
    } catch (e) {
      fail(res, e);
    }
  });

  req.on('error', () => {
    // 客户端中断：清掉半个文件，不写响应、也不抛
    aborted = true;
    discard();
  });
}

/**
 * 功能：统一错误出口 —— 把 `throw` 出来的错误转成 JSON 响应（状态码取 `e.status`，默认 500），并记一行日志。
 *
 * 说明：读只读降级抛出的错误自带 status=503，会把「不能写」的原因原样传给前端。
 *
 * ⚠️ 这里**只**处理 `throw` 出来的错误（含 `httpError`）—— 谁该走 fail、谁该直接 `json()`
 *    的规则写在 `httpError` 的注释里，别把 401/404 挪进来（它们的响应体必须逐字固定）。
 *
 * @param {Object} res - HTTP 响应对象
 * @param {Error} e - 捕获到的错误，可带 `status`（HTTP 状态码）与 `extra`（附加字段）
 * @returns {void}
 */
function fail(res, e) {
  const code = e && e.status ? e.status : 500;
  logLine(code >= 500 ? 'error' : 'warn', `请求失败(${code}): ${(e && e.message) || e}`);
  if (res.headersSent) return;
  json(res, code, {
    error: (e && e.message) || 'internal',
    // `readOnly` 让前端在任何一次失败上都能顺手确认「现在是不是只读降级」，不需要额外探一次 health
    readOnly: !!(store && store.info().readOnly),
    ...((e && e.extra) || {}),
  });
}

/**
 * 功能：把 URL 里的一段路径参数解析成数字 id。
 * @param {string} p - 路径中的一段（如 `parts[2]`）
 * @returns {?number} 可解析成有限数字时返回该数字，否则返回 null
 */
function idParam(p) {
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

/**
 * 功能：回「不存在」的 404 响应（响应体固定为 `{ error: 'not found' }`）。
 *
 * 说明：越权 / 不存在**统一 404**（方案 §六 #6）。
 *
 * ⚠️「这个 id 是别人的」与「这个 id 根本不存在」必须返回**逐字一样**的响应，
 *    否则状态码本身就成了探测「别人有哪些 id」的通道。
 * ⚠️ 所以这里**不能**回 403：403 等于告诉对方「这条记录存在，只是不归你」。
 *
 * @param {Object} res - HTTP 响应对象
 * @returns {void}
 */
function notFound(res) {
  return json(res, 404, { error: 'not found' });
}

/**
 * 功能：写操作收口 —— 确实改到了回 `200 {ok:true}`，一条都没动（不属于本人 / 不存在）则回 404。
 * @param {Object} res - HTTP 响应对象
 * @param {boolean} changed - 存储层报告的受影响行数是否为真
 * @returns {void}
 */
function writeResult(res, changed) {
  if (!changed) return notFound(res);
  return json(res, 200, { ok: true });
}

/**
 * 功能：校验任务日期区间 —— 请求里**同时**带了任务日与截止日期时，要求任务日不晚于截止日期。
 * @param {Object} b - 请求体对象
 * @returns {?string} 区间不合法时返回中文错误文案，合法（或只带了一个日期）返回 null
 */
function badDateRange(b) {
  const s = b && b.start_date,
    e = b && b.due_date;
  if (s && e && s > e) return '任务日不能晚于截止日期';
  return null;
}

/**
 * 功能：构造一个带 HTTP 状态码的 `Error`，交给 `fail()` 统一收口成响应。
 *
 * 说明：抛一个带状态码的错误（由 `fail()` 统一转成响应）。
 *
 * ⭐ 0.1.3 起这是**输入/服务端错误**的唯一出口（审查报告 C1）。规则如下，别再加第四种写法：
 *    · **输入不合法（400）/ 服务端内部错误（5xx）** → `throw httpError(...)`，由 `fail()` 统一收口
 *      （统一记日志 + 带 `readOnly`），只读降级抛的 503 走的也是这条。
 *    · **鉴权/授权结果（401 / 403 / 429）** → 直接 `json()`：它们是「谁在敲门」的答案、不是请求格式错，
 *      而且响应体要**逐字固定**（前端按 `error` 分支判断），不该掺入 `readOnly` 这类附加字段。
 *    · **不存在 / 越权（404）** → 一律 `notFound()`：两种情况响应体必须逐字一致，否则状态码就成了
 *      探测「别人的 id 存不存在」的通道。
 *    · **上传超限（413）** → 直接 `json()`：必须在请求体还没读完时立刻回（见 `readRawBody` 注释）。
 *
 * ⚠️ 在 `readBody` / `readRawBody` 的回调里 `throw` 是**安全的**：两者的 `cb()` 都包在
 *    try/catch 里并转给 `fail()` —— 那两个回调跑在 `'end'` 事件里，外层 `createServer`
 *    的 try/catch 抓不到（见 `readBody` 顶部的注解）。
 *
 * `extra` 用于必须原样带给前端的附加字段（如课表导入失败的 `code` / `saw`）。
 *
 * @param {number} status - HTTP 状态码（400 / 404 / 503 等）
 * @param {string} message - 直接展示给用户的中文说明
 * @param {?Object} [extra] - 可选，需要原样带进响应体的附加字段
 * @returns {Error} 带 `status`（以及可选 `extra`）的错误对象
 */
function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

/**
 * 功能：按 RFC 5987 编码 `filename*` 的值（attr-char 之外一律百分号转义）—— 附件下载的中文名。
 *
 * 说明：⭐ **全仓只有这一份**（`core/routes/backup.js` 从前自带一份局部实现，0.8.3 收口到这里）——
 *      两份并存时「`'()*!` 有没有转义」这种边界只要有一处写错，用户下载到的就是
 *      **一坨没有名字的文件**，而服务端**不报错**。
 *      ⚠️ 不能直接用 `encodeURIComponent`：它会放过 `'()*!` 这几个字符，而 RFC 5987 里
 *      它们**必须**转义 —— 不转义时严格实现的浏览器会把整个文件名丢掉。
 *      ⚠️ 用法：`filename="<ASCII 兜底名>"; filename*=UTF-8''${rfc5987('<中文名>')}`
 *      （`filename=` 只允许 ASCII，塞中文会被浏览器丢掉或变乱码 ⇒ 两者必须**成对**出现）。
 *
 * @param {string} s - 原始（可能含中文的）文件名
 * @returns {string} 可放进 `filename*=UTF-8''` 后面的编码串
 */
function rfc5987(s) {
  return encodeURIComponent(String(s)).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

module.exports = {
  readBody,
  json,
  MAX_UPLOAD,
  readRawBody,
  readBodyToFile,
  fail,
  idParam,
  notFound,
  writeResult,
  badDateRange,
  httpError,
  rfc5987,
};
