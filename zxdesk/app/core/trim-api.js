'use strict';
/**
 * trim-api.js —— 调飞牛开放平台后端能力的**唯一出口**（Unix Socket）
 *
 * 功能：把「应用服务端怎么调 `trim.*`」收在一个文件里 —— 认证（`TRIM_API_TOKEN`）、
 *      Unix Socket 地址、请求 / 响应形状、超时、错误收口，以及一个**可注入的假实现**（测试用）。
 *
 * ⭐ 为什么必须走后端：
 *   · `trim.file.getUserAccessibleFolders` / `delUserAccessibleFolder` **只能**由应用服务端
 *     经 Unix Socket `/var/run/trim_open_gateway_apiscope.socket` 调（官方口径）；
 *   · token 由系统启动应用脚本时注入环境变量，**⛔ 不能落库、不能进日志、不能回前端** ——
 *     所以它只能待在服务端进程里。
 *
 * ⚠️⚠️ **两条安全口径（官方文档原话，抄进来免得被忘）**：
 *   ① 「拿到授权路径不代表可以绕过当前使用用户的系统权限」—— 授权列表只是「用户同意过」，
 *      不是「我们有权读写任何东西」，写盘前仍要按应用账号自己的权限试；
 *   ② 「不要信任客户端传入的用户 ID，请使用网关鉴权 Header」—— 授权与查询用的 uid
 *      只从 `X-Trim-Userid`（见 `gateway.js` 的 `gatewayUser()`）来，⛔ 不接受请求体里的 uid。
 *
 * ⚠️ token 每次调用现读 `process.env`：官方明说它会在重新注册 / 重装后变化。
 * ⚠️ 失败一律抛**带 code 的错误**，由路由层收口成 409（⛔ 不降级成「随便用」）：
 *    查不到授权就等于「不能碰这个目录」，不是「先试试看」。
 *
 * @author zx
 * @date   2026-11-08
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md §6.7、docs/公共/开发方案/2026-11-08-0.9.8-第5轮修改.md §九~§十
 */

const http = require('node:http');

/** 后端开放能力的 Unix Socket（官方固定路径；可用环境变量覆盖，便于测试与别的部署） */
const SOCKET_PATH = process.env.TRIM_API_SOCKET || '/var/run/trim_open_gateway_apiscope.socket';

/** 本应用在开放平台里的 appname（与 `manifest` 的 `appname` 逐字一致） */
const APP_NAME = process.env.TRIM_APP_NAME || 'zxdesk';

/** 后端能力的固定路径 */
const API_PATH = '/api/v1/trimapp';

/** 单次调用超时（毫秒）：本地 Socket，超过这个数基本就是网关没起来 */
const TIMEOUT_MS = 5000;

/** 授权列表的内存缓存时长：30 秒（面板连点「刷新」不该每次都打网关）；可用环境变量覆盖（测试用 0） */
const CACHE_MS = Number(process.env.TRIM_CACHE_MS == null ? 30000 : process.env.TRIM_CACHE_MS) || 0;

/**
 * 语义化路径的缓存时长：5 分钟。
 *
 * 说明：⭐ 与授权列表的 30 秒**刻意不同**：授权状态是用户在飞牛里随时会改的东西，
 *      而「`/vol1/1000/photo` 在文件管理器里叫什么」只在**存储改名 / 改挂载点**时才变 ——
 *      这种变化由面板的「刷新」按钮显式触发（它会 `invalidate()`），不需要靠短 TTL 兜。
 *      给长一点是为了让「打开附件位置面板」永远不再等一次网关往返。
 * @type {number}
 */
const PATH_CACHE_MS = Number(process.env.TRIM_PATH_CACHE_MS == null ? 300000 : process.env.TRIM_PATH_CACHE_MS) || 0;

/** 一次 `convertPath` 最多传几条路径（官方没写上限，这里自己给自己一个界，避免请求体失控） */
const MAX_CONVERT = 50;

/** 测试注入的假实现；`null` = 真调 Socket */
let impl = null;

/** 请求序号（只用于把响应与请求对上） */
let seq = 0;

/** uid → `{ at, paths }` 的短缓存（用户授权） */
const cache = new Map();

/** 应用共享授权目录的短缓存（不分用户：管理员给**本应用**授权的目录） */
let sharedCache = { at: 0, paths: [] };

/**
 * 语义化路径缓存：`路径 → { at, semantic }`。
 *
 * ⚠️ 键是**路径字符串**、不是 uid：同一个路径换个账号看，文件管理器里的位置是一样的。
 * ⚠️ 值里带用户名（「admin 的文件」）—— 只用于本账号自己的界面，⛔ 不进日志、不进错误话术。
 * @type {Map.<string, {at: number, semantic: string}>}
 */
const pathCache = new Map();

/**
 * 最近一次 `convertPath` 的**结论**（只给诊断用，⛔ 不参与任何判断）。
 *
 * 说明：⭐⭐ 这个能力有四种「拿不到」的原因（没 token / 网关不可达 /
 *      系统低于 1.2.0401 未开这个接口 / 应用没声明 `trim.file.path`），而四种在页面上
 *      **表现完全一样** —— 都退成 `…/末两段`。用户只会说「没实现」，维护者只能猜。
 *      这里把原因留一份，由 `settings` 回应给前端，面板底部照着说一句人话。
 *      ⚠️ 只是**结论与一句话**，不含路径、不含 token、不进日志。
 * @type {{ok: boolean, code: string, reason: string, status: ?string, msg: string, resultKind: string, at: number}}
 */
let convertDiag = { ok: false, code: '', reason: '', status: null, msg: '', resultKind: '', at: 0 };

/**
 * 功能：造一个带 `code` 的错误（路由层据此回 409 与一句人话）。
 * @param {string} code - 机器可读的错误码
 * @param {string} message - 给用户看的中文
 * @returns {Error} 错误对象
 */
function trimError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

/**
 * 功能：注入假实现（**只给测试用**）。
 *
 * 说明：⚠️ 测试机上没有 gateway socket，不注入就一个用例都跑不起来。
 *      假实现的形状与真调用一致：`(req, data) => Promise<data>`（`data` 是响应里的 `data` 字段）。
 * @param {?Function} fake - 假实现；传 `null` 恢复真调用
 * @returns {void}
 */
function setImpl(fake) {
  impl = typeof fake === 'function' ? fake : null;
  cache.clear();
  // ⚠️ 共享授权那份缓存**也必须清**：它是 30 秒 TTL，不清的话换了假实现还会拿到上一份结果
  //    （测试里表现为「第二步永远是第一步的答案」）。生产路径不调本函数。
  sharedCache = { at: 0, paths: [] };
}

/**
 * 功能：清掉授权列表缓存（撤销 / 新授权之后必须调一次）。
 * @param {?number} uid - 只清某个账号；不传清全部
 * @returns {void}
 */
function invalidate(uid) {
  sharedCache = { at: 0, paths: [] };
  pathCache.clear();
  if (uid === undefined || uid === null) cache.clear();
  else cache.delete(Number(uid));
  // ⭐ 通知订阅方（`location-auth` 就是订阅者）：授权一变，那些**拿着本模块结果**算出来的
  //    结论也一起过期了。⛔ 别让调用方各自记得去清 —— 那正是「漏一处就一直弹」的来源。
  for (const fn of invalidateHooks) {
    try {
      fn(uid);
    } catch (_e) {
      /* 订阅方自己出错不许影响清单刷新 */
    }
  }
}

/** 订阅「授权清单已作废」的钩子（⛔ 只给核心模块注册，业务模块不要往这里加） @type {Set.<Function>} */
const invalidateHooks = new Set();

/**
 * 功能：注册一个「授权清单被作废」的回调。
 * @param {Function} fn - `(uid) => void`
 * @returns {void}
 */
function onInvalidate(fn) {
  if (typeof fn === 'function') invalidateHooks.add(fn);
}

/**
 * 功能：真调一次开放平台（Unix Socket ＋ Bearer token）。
 * @param {string} req - 能力标识（如 `trim.file.getUserAccessibleFolders`）
 * @param {Object} data - 该能力的参数
 * @returns {Promise<*>} 响应里的 `data`
 * @throws {Error} 没有 token / 网关不可达 / 业务码非 0 时抛出（带 `code`）
 */
function rawCall(req, data) {
  const token = process.env.TRIM_API_TOKEN;
  if (!token) throw trimError('TRIM_NO_TOKEN', '拿不到开放平台的调用凭据（TRIM_API_TOKEN），请从飞牛桌面重新打开本应用后再试');
  const body = Buffer.from(JSON.stringify({ reqId: String((seq += 1)), req, appName: APP_NAME, data: data || {} }), 'utf8');
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        socketPath: SOCKET_PATH,
        path: API_PATH,
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        /** 响应体累加（这个接口的响应都很小，不必流式） */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (_e) {
            reject(trimError('TRIM_BAD_RESPONSE', '开放平台回了看不懂的内容，请稍后再试'));
            return;
          }
          if (!parsed || Number(parsed.code) !== 0) {
            reject(trimError('TRIM_API_ERROR', (parsed && parsed.msg) || '开放平台拒绝了这次调用'));
            return;
          }
          resolve(parsed.data);
        });
      },
    );
    r.on('timeout', () => {
      r.destroy(trimError('TRIM_TIMEOUT', '连不上飞牛开放平台（超时），请确认应用是从飞牛桌面打开的'));
    });
    r.on('error', (e) => {
      // ⚠️ ENOENT / ECONNREFUSED 都意味着「不是在飞牛里跑」—— 给同一句话，别把 errno 丢给用户
      if (e && e.code && /^(ENOENT|ECONNREFUSED|EACCES)$/.test(String(e.code))) {
        reject(trimError('TRIM_NO_GATEWAY', '连不上飞牛开放平台 —— 附件授权只能在飞牛里操作（局域网直连 / 独立客户端不支持授权）'));
        return;
      }
      reject(e && e.status ? e : trimError('TRIM_CALL_FAILED', (e && e.message) || '调用开放平台失败'));
    });
    r.end(body);
  });
}

/**
 * 功能：调一个后端能力（有假实现就走假的）。
 * @param {string} req - 能力标识
 * @param {Object} data - 参数
 * @returns {Promise<*>} 响应里的 `data`
 * @throws {Error} 见 `rawCall()`
 */
async function call(req, data) {
  if (impl) return impl(req, data);
  return rawCall(req, data);
}

/**
 * 功能：查某个飞牛用户**授权给本应用**的目录列表。
 *
 * 说明：⚠️ 只含**目录**授权，不含文件授权（官方口径）。30 秒内存缓存：
 *      面板连点刷新、每次上传前的校验都走它，不缓存就会把网关打满。
 * @param {number} uid - 飞牛用户 uid（**只从网关 Header 来**）
 * @returns {Promise<Array.<string>>} 绝对路径数组（可能为空）
 * @throws {Error} 网关不可达 / 无 token / 业务码非 0
 */
async function getUserAccessibleFolders(uid) {
  const key = Number(uid);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.paths.slice();
  const data = await call('trim.file.getUserAccessibleFolders', { uid: key });
  const paths = Array.isArray(data && data.paths) ? data.paths.map((p) => String(p)) : [];
  cache.set(key, { at: Date.now(), paths });
  return paths.slice();
}

/**
 * 功能：查**管理员授权给本应用**的目录（飞牛「应用设置 → 访问权限」里配的那些）。
 *
 * 说明：⭐⭐ 这是最省事的一条路：管理员在飞牛里给过 ZXDesk 一个目录之后，应用直接用，
 *      **不需要**再让用户在自己的页面里选一次。所以附件目录的取值顺序是
 *      「共享授权目录 → 用户个人授权目录」，两者都没有才提示去授权。
 *      ⚠️ 这个接口**不带 uid**（授权对象是应用，不是某个用户）。
 * @returns {Promise<Array.<string>>} 目录绝对路径（可能为空）
 * @throws {Error} 网关不可达 / 无 token / 业务码非 0
 */
async function getSharedAccessibleFolders() {
  if (sharedCache.at && Date.now() - sharedCache.at < CACHE_MS) return sharedCache.paths.slice();
  const data = await call('trim.file.getSharedAccessibleFolders', {});
  const paths = Array.isArray(data && data.paths) ? data.paths.map((p) => String(p)) : [];
  sharedCache = { at: Date.now(), paths };
  return paths.slice();
}

/**
 * 功能：删掉某个飞牛用户对本应用的一条目录授权（**只删授权，⛔ 不删任何文件**）。
 * @param {number} uid - 飞牛用户 uid
 * @param {string} path - 目录绝对路径
 * @returns {Promise<boolean>} 平台说删成功了就 true
 * @throws {Error} 网关不可达 / 无 token / 业务码非 0
 */
async function delUserAccessibleFolder(uid, path) {
  const data = await call('trim.file.delUserAccessibleFolder', { uid: Number(uid), path: String(path) });
  invalidate(uid);
  return !!(data && data.suc);
}

/**
 * 功能：把内部路径（`/vol1/1000/photo`）转成**文件管理器里的语义化路径**
 *      （`存储空间1/admin 的文件/photo`）—— 飞牛后端能力 `trim.file.convertPath`。
 *
 * 说明：⭐⭐ 页面上**不再出现** `/vol1/...`（内部路径对用户没有意义）。
 *      几条刻意的设计：
 *      · **一次一批**（去重、最多 50 条）：面板一屏就要转「当前目录 + N 条历史根 + M 条已授权」，
 *        一条一次会把网关打成一串串行往返；
 *      · **失败不抛**：网关不可达 / 系统太老（< 1.2.0401）/ 业务码非 0，一律回**已经拿到的那部分**
 *        （空 Map 也算正常返回），由展示层走「`…/末两段`」兜底 —— 路径只是提示，
 *        ⛔ 不该因为它把整块「附件位置」面板打成错误；
 *      · **整批被拒就逐条重试**（见 `fillConverted()`）：一条已失效的历史目录不该让整屏都退兜底；
 *      · **失败原因留一份**（见 `convertStatus()`）：四种「拿不到」在页面上一模一样，
 *        不记原因就只能猜「是不是没做」；
 *      · **`language` 写死 `zh-CN`**：本应用只有中文界面，平台配置也写明 `systemLanguage` 固定 `zh-CN`；
 *        读 `Accept-Language` 反而会造出「同一台机器两种路径写法」；
 *      · **缓存键是路径字符串**：同一个路径换账号看语义一样；`invalidate()` 会一起清掉
 *        （存储改名 / 点「刷新」后必须立刻看到新名字）。
 *
 * @param {Array.<string>|string} paths - 一个或多个绝对路径
 * @param {string} [language] - 语言（本应用只传 `zh-CN`）
 * @returns {Promise.<Map.<string, string>>} `路径 → 语义化路径`（转不到的不在 Map 里）
 */
async function convertPaths(paths, language) {
  const raw = Array.isArray(paths) ? paths : [paths];
  /** @type {Array.<string>} */
  const list = [];
  for (const p of raw) {
    const s = String(p == null ? '' : p);
    if (s && !list.includes(s)) list.push(s);
    if (list.length >= MAX_CONVERT) break;
  }
  /** @type {Map.<string, string>} */
  const out = new Map();
  if (!list.length) return out;

  const need = splitCached(list, out);
  if (!need.length) return out;
  await fillConverted(need, language || 'zh-CN', out);
  return out;
}

/**
 * 功能：把缓存命中不了的那部分挑出来（顺带把命中的写进 `out`）。
 * @param {Array.<string>} list - 去重后的路径
 * @param {Map.<string, string>} out - 收集器
 * @returns {Array.<string>} 需要真问网关的那些
 */
function splitCached(list, out) {
  const now = Date.now();
  /** @type {Array.<string>} */
  const need = [];
  for (const p of list) {
    const hit = pathCache.get(p);
    if (hit && PATH_CACHE_MS > 0 && now - hit.at < PATH_CACHE_MS) out.set(p, hit.semantic);
    else need.push(p);
  }
  return need;
}

/**
 * 功能：把响应里的 `data.result` 收进 `out` 与缓存。
 * @param {Array.<Object>} rows - `[{ path, semanticPath }]`
 * @param {Map.<string, string>} out - 收集器
 * @returns {number} 真正收下的条数
 */
function absorbConverted(rows, out) {
  let n = 0;
  for (const row of rows) {
    const p = String((row && row.path) || '');
    const sem = String((row && row.semanticPath) || '');
    // ⚠️ `semanticPath` 为空 = 飞牛也说「这条转不了」（没映射 / 不在任何存储里），
    //    不是错误，跳过即可 —— 由展示层退 `…/末两段`
    if (!p || !sem) continue;
    out.set(p, sem);
    pathCache.set(p, { at: Date.now(), semantic: sem });
    n += 1;
  }
  return n;
}

/**
 * 功能：从一次响应里挑出「结果行」与状态 —— 兼容两种包裹。
 *
 * 说明：⭐⭐ 文档写的形状是 `data.result`，但网关某些版本
 *      会把整份 `{status, result}` 再包一层成 `data.data`。原实现只认前者 ⇒ 拿到
 *      `undefined` 就当「转不了」，页面上只能退兜底，看起来与「没实现」一模一样。
 *      ⚠️ 只读、不猜：两种都不像就回 `null`（由调用方按失败处理）。
 * @param {*} data - `rawCall` resolve 出来的 `data`
 * @returns {?{rows: Array.<Object>, status: *, kind: string}} 结果行与来源标记；认不出为 `null`
 */
function pickConvertRows(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.result)) return { rows: data.result, status: data.status, kind: 'data.result' };
  const inner = data.data;
  if (inner && typeof inner === 'object' && Array.isArray(inner.result)) {
    return {
      rows: inner.result,
      status: inner.status === undefined ? data.status : inner.status,
      kind: 'data.data.result',
    };
  }
  return null;
}

/** 上一次已经记过日志的失败指纹（`code|status|kind`）—— 同一次失败⛔ 不刷屏 */
let loggedFail = '';

/**
 * 功能：记一次「拿不到语义路径」的结论，并按指纹**只记一行**日志。
 *
 * 说明：⚠️ 日志里⛔ 不含任何路径（`semanticPath` 带用户名，`path` 是设备目录结构）——
 *      只留 status / msg / resultKind 三个排查用的形状标记。
 * @param {string} code - 机器可读原因码（进 `settings.pathConvert.code`）
 * @param {string} reason - 给用户的一句人话
 * @param {{status?: *, msg?: string, resultKind?: string}} [extra] - 诊断用的原始形状
 * @returns {void}
 */
function diagFail(code, reason, extra) {
  const e = extra || {};
  convertDiag = {
    ok: false,
    code,
    reason,
    status: e.status === undefined || e.status === null ? null : String(e.status),
    msg: String(e.msg || ''),
    resultKind: String(e.resultKind || ''),
    at: Date.now(),
  };
  const fp = `${code}|${convertDiag.status}|${convertDiag.resultKind}`;
  if (fp === loggedFail) return;
  loggedFail = fp;
  try {
    // ⚠️ 惰性 require：`core/context` 的加载链比本文件长，顶层 require 容易绕进循环依赖
    const { logLine } = require('./context.js');
    logLine(
      'warn',
      `路径转换未生效：status=${convertDiag.status === null ? '(无)' : convertDiag.status} ` +
        `msg=${convertDiag.msg || '(空)'} resultKind=${convertDiag.resultKind || '(认不出)'}`,
    );
  } catch (_e) {
    // 日志写不进去不是把主流程带崩的理由
  }
}

/**
 * 功能：真调一次 `trim.file.convertPath`；整批没结果时**逐条重试**（单条用字符串）。
 *
 * 说明：⭐⭐ 为什么要拆单条：飞牛对「其中一条路径不成立」（文件夹刚被删掉 / 不在任何存储里）
 *      的行为是**整批 `status` 非 0**，而不是逐条给空。原实现一遇到非 0 就整批作废，
 *      结果是「历史目录里有一个已经不在了 ⇒ 整个面板一条语义路径都出不来」——
 *      页面上看起来就是**这个功能没做**。逐条重试只在异常路径上跑（正常一次就成），
 *      代价可以忽略；但⛔ 网关层失败（没 token / 连不上 / 超时）不重试 —— 拆成单条也一样死，
 *      白打 50 次只会把网关拖慢。
 *      ⭐ 再放宽两条：
 *      · **单条也用字符串**试一次（有的网关版本不接受数组，`path` 必须是 string）；
 *      · **只要收到能用的 `semanticPath` 就收**，不再要求 `status === 0`
 *        （`status` 缺失 / 用非 0 表示「部分成功」的版本同样能出结果）。
 * @param {Array.<string>} list - 需要转换的路径（已去重）
 * @param {string} language - 展示语言
 * @param {Map.<string, string>} out - 收集器
 * @returns {Promise.<void>} 无返回值（结果写进 `out`）
 */
async function fillConverted(list, language, out) {
  let data;
  try {
    // 官方口径：`data.path` 支持单个字符串或数组，`language` 必填
    data = await call('trim.file.convertPath', { path: list, language });
  } catch (e) {
    // ⭐ 网关层失败（没 token / 连不上 / 超时）：原因原样留给诊断，⛔ 不逐条重试
    diagFail((e && e.code) || 'TRIM_CALL_FAILED', (e && e.message) || '调用开放平台失败', {});
    return;
  }

  const picked = pickConvertRows(data);
  let got = picked ? absorbConverted(picked.rows, out) : 0;
  if (got > 0) {
    convertDiag = {
      ok: true,
      code: Number(picked.status) === 0 ? '' : 'TRIM_PATH_PARTIAL',
      reason: '',
      status: picked.status === undefined ? null : String(picked.status),
      msg: '',
      resultKind: picked.kind,
      at: Date.now(),
    };
    loggedFail = '';
    return;
  }

  // ---- 一条都没收下：逐条再试（单条传**字符串**，兼容器接受数组的网关版本）----
  for (const p of list) {
    try {
      const one = await call('trim.file.convertPath', { path: p, language });
      const pk = pickConvertRows(one);
      if (pk) got += absorbConverted(pk.rows, out);
    } catch (_e) {
      // ⚠️ 单条也失败就跳过；只要还有别的成功，就按「部分可用」记，⛔ 不把整批说成失败
    }
  }
  if (got > 0) {
    convertDiag = {
      ok: true,
      code: 'TRIM_PATH_PARTIAL',
      reason: '',
      status: picked && picked.status !== undefined ? String(picked.status) : null,
      msg: '',
      resultKind: picked ? picked.kind : '',
      at: Date.now(),
    };
    loggedFail = '';
    return;
  }
  diagFail(
    'TRIM_PATH_REJECTED',
    '飞牛没有返回可展示的路径名称 —— 这个能力要求飞牛系统 1.2.0401 及以上，' +
      '且应用包声明了「路径转换」权限；从旧版本升级上来的应用需要重新安装一次才会重新登记权限。',
    {
      status: picked ? picked.status : null,
      msg: (data && data.msg) || '',
      resultKind: picked ? picked.kind : '',
    },
  );
}

/**
 * 功能：读最近一次路径转换的结论（**只给诊断用**，界面只在 `ok === false` 时说一句兜底话）。
 * @returns {{ok: boolean, code: string, reason: string, status: ?string, msg: string, resultKind: string, at: number}} 副本
 */
function convertStatus() {
  return Object.assign({}, convertDiag);
}

module.exports = {
  SOCKET_PATH,
  APP_NAME,
  setImpl,
  invalidate,
  onInvalidate,
  getSharedAccessibleFolders,
  getUserAccessibleFolders,
  delUserAccessibleFolder,
  convertPaths,
  convertStatus,
};
