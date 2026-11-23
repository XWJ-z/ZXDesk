/**
 * http-util.js —— HTTP 读写与错误出口（请求体 / 响应 / 四条错误规则）
 *
 * 功能：`readBody` / `readRawBody` 读请求体（后者带上传字节上限，超限立刻回 413）、
 * `readBodyToFile` 把上传字节**边收边写磁盘**（文件落盘用，超限同样先回 413）、
 * `json` 发 JSON、`fail` 统一收口错误（记日志 + 响应体带 `readOnly`）、
 * `httpError` 造可抛的错误、`notFound` 统一 404、`idParam` 解析路径里的 id…
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
 */
function readBody(req, res, cb) {
  let body = '';
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) {
      /* 已经回过 413：继续把请求体读掉并丢弃，让客户端写完、读到那句响应。
         表现是「网络错误」而不是我们刚写下去的 413（`readRawBody` 同一口径）。 */
      size += c.length;
      if (size > 16e6) req.destroy();
      return;
    }
    size += c.length;
    body += c;
    if (size > 2e6) {
      tooBig = true;
      body = '';
      json(res, 413, { error: '请求体过大' });
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    let parsed = null;
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch (_e) {
        parsed = null;
      }
    }
    try {
      const r = cb(parsed);
      // 回调可能是 `async (b) => …`：async 函数体里抛的错**不会**被上面的同步 try/catch 接住 ——
      // 它变成一句没人等的 rejected promise，请求就永远悬着（客户端只看到「转 30 秒然后超时」）。
      // `fail()` 自己判了 `headersSent`，响应已经写过时不会二次写。
      if (r && typeof r.then === 'function') r.catch((e) => fail(res, e));
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
 * 超限时**必须先回 413 再销毁请求**：只 `req.destroy()` 的话前端看到的是「无响应」，
 * 而不是一句能读懂的原因（与 AGENTS.md §六「错误出口要盖住异步回调」同一类问题）。
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
      // 表现为「网络错误」而不是我们刚写下去的那句 413（实测偶发、难复现）。
      // 正确做法是**保持 data 监听**（请求体会被自然读掉并丢弃），让客户端写完并读到响应。
      // 只有荒唐体积（8 倍上限）才直接断 —— 那种输入前端本就会先拦一次。
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
 * 请求体**全缓存在内存里**（`const chunks = []`，上限 2MB），一个 10MB 的文件用它就是把
 * 二进制压在堆上。⚠️ 它**不改动也不删除** `readRawBody()` —— 课表导入 / AI 带图照旧走那边。
 *
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
      // 先回 413，再让请求体被自然读掉；⛔ 绝不 req.destroy()（见函数说明第 ① 条）。
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
 * 这里**只**处理 `throw` 出来的错误（含 `httpError`）—— 谁该走 fail、谁该直接 `json()`
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
 */
function idParam(p) {
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

/**
 * 功能：回「不存在」的 404 响应（响应体固定为 `{ error: 'not found' }`）。
 *
 *
 * 「这个 id 是别人的」与「这个 id 根本不存在」必须返回**逐字一样**的响应，
 * 所以这里**不能**回 403：403 等于告诉对方「这条记录存在，只是不归你」。
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
 * **输入不合法（400）/ 服务端内部错误（5xx）** → `throw httpError(...)`，由 `fail()` 统一收口
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
 * 两份并存时「`'()*!` 有没有转义」这种边界只要有一处写错，用户下载到的就是
 * **一坨没有名字的文件**，而服务端**不报错**。
 * 不能直接用 `encodeURIComponent`：它会放过 `'()*!` 这几个字符，而 RFC 5987 里
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
