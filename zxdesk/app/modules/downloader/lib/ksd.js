'use strict';
/**
 * modules/downloader/lib/ksd.js —— 与**快手作品下载器**（KSD）说话的唯一出口
 *
 * 功能：`normalizeServiceUrl()`（地址白名单：只允许本机 / 内网）、`request()`（发一次 `/api/v1/*`，
 * 带超时与错误归拢）、`upstreamError()` / `networkError()`（把 KSD 的技术错误翻成一句人话）。
 *
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、Project/Tools/ks-downloader/API.md
 */

const http = require('node:http');
const https = require('node:https');

/** 默认地址（KSD 只绑回环） @type {string} */
const DEFAULT_URL = 'http://127.0.0.1:5599';

/** KSD 的首选端口（不设 `KSD_API_PORT` 时从这里起往后试） @type {number} */
const DEFAULT_PORT = 5599;

/** 顺延的个数（与 KSD 的实现一致：5599 被占就试 5600…，最多 10 个） @type {number} */
const PORT_SPAN = 10;

/** 探端口的超时：只回常量，本机 800 毫秒还没答就是没人 @type {number} */
const TIMEOUT_PROBE_MS = 800;

/** KSD 在飞牛里的页面地址（「去选保存目录」那条提示要给一个能点的链接） @type {string} */
const OPEN_URL = '/app/ksdownloader/';

/** 普通查询的超时（`/me`、`/tasks`、`/version`） @type {number} */
const TIMEOUT_READ_MS = 8000;

/** 解析的超时（KSD 要起子进程去打通上游，比查询慢一个量级） @type {number} */
const TIMEOUT_PARSE_MS = 30000;

/**
 * 功能：造一个带 HTTP 语义的错误（`routes.js` 与 `core/http-util.js` 的 `fail()` 认这两个字段）。
 * @param {number} status - 对前端的状态码
 * @param {string} message - 人话
 * @param {Object} [extra] - 附加字段（如 `openUrl`：把「去哪选保存目录」直接给界面）
 * @returns {Error} 错误对象
 */
function fail(status, message, extra) {
  return Object.assign(new Error(message), { status, extra: extra || null });
}

/**
 * 功能：判断一个主机名算不算「本机 / 内网」。
 *
 * 说明：允许四类 —— 回环、RFC1918 私网
 * （`10/8`、`172.16/12`、`192.168/16`）、`.lan` 结尾的局域网名。
 * 回环整段都算：`.1` 是 KSD 的默认值，别的 127.x 同样只在本机可达，并不放宽边界。
 */
function isLocalHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.endsWith('.lan')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 功能：判断主机名是不是**本机回环**（只有这种地址才值得扫端口）。
 * @param {string} host - 主机名
 * @returns {boolean} 回环则为 true
 */
function isLoopbackHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * 功能：拼「主机 ＋ 端口」这一段（IPv6 字面量要带方括号）。
 * @param {string} hostname - `URL.hostname`（可能带方括号）
 * @param {number|string} port - 端口
 * @returns {string} 形如 `.1:5599` / `[::1]:5599`
 */
function hostPort(hostname, port) {
  const bare = String(hostname || '').replace(/^\[|\]$/g, '');
  return `${bare.includes(':') ? `[${bare}]` : bare}:${port}`;
}

/**
 * 功能：校验并规整用户填的地址；不合法直接抛 400。
 *
 * 说明：⚠️ 会**去掉结尾斜杠与路径**：KSD 的接口都在 `/api/v1` 下，
 * 用户多贴一个 `/api/v1` 或尾斜杠时，拼出来的路径会变成 `/api/v1/api/v1/parse`。
 * 这里只保留「协议 + 主机 + 端口」，把「接口路径」这件事收回本文件。
 */
function normalizeServiceUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw fail(400, '请填快手作品下载器的地址，一般是 http://127.0.0.1:5599');
  let u;
  try {
    u = new URL(text);
  } catch (_e) {
    throw fail(400, '这个地址填得不对，要以 http:// 开头，例如 http://127.0.0.1:5599');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw fail(400, '地址要以 http:// 开头，例如 http://127.0.0.1:5599');
  }
  if (u.username || u.password) throw fail(400, '地址里不要带用户名和密码');
  if (!isLocalHost(u.hostname)) {
    throw fail(400, '地址不对，只能填本机或内网地址（127.0.0.1 / 192.168.x.x 这类）');
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${hostPort(u.hostname, port)}`;
}

/**
 * 功能：列出该去问的候选端口（不含已经试过的那个）。
 *
 * 说明：⭐ 默认就是 KSD 的顺延区间 `5599~5608`。`ZXDESK_KSD_PROBE_PORTS` 是**测试用的接缝**：
 * 用例里的假下载器落在随机端口，扫真实区间会撞上这台机器上已装的实例（那是别人的进程，
 * 不能当成被测行为）。生产环境不设它，走默认区间。
 */
function probePorts(base) {
  const override = String(process.env.ZXDESK_KSD_PROBE_PORTS || '').trim();
  let list;
  if (override) {
    list = override
      .split(',')
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  } else {
    list = [];
    for (let i = 0; i < PORT_SPAN; i += 1) list.push(DEFAULT_PORT + i);
  }
  let own = 0;
  try {
    own = Number(new URL(base).port) || 0;
  } catch (_e) {
    own = 0;
  }
  return list.filter((p) => p !== own);
}

/**
 * 功能：问一个地址「你是不是快手作品下载器」。
 *
 * 说明：⚠️ 判据是 `/api/v1/info` 的 `app === 'ksdownloader'` ＋ 端口是数字：光看「有 HTTP 在听」
 * 会把 5599 上的任何服务都当成它。`listening: false` 也算不是（那是自检里的未监听态）。
 * @param {string} base - 候选地址
 */
async function probeInfo(base) {
  let res;
  try {
    res = await request({ base, method: 'GET', path: '/api/v1/info', timeoutMs: TIMEOUT_PROBE_MS });
  } catch (_e) {
    return null;
  }
  const body = res.body;
  if (res.status !== 200 || !body || body.app !== 'ksdownloader' || body.listening === false) return null;
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const u = new URL(base);
  return { base: `${u.protocol}//${hostPort(u.hostname, port)}`, port };
}

/**
 * 功能：在顺延区间里找「真正在听的那个端口」。
 * @param {string} base - 连不上的那个地址（已规整）
 */
async function discover(base) {
  let u;
  try {
    u = new URL(base);
  } catch (_e) {
    return null;
  }
  if (!isLoopbackHost(u.hostname)) return null;
  for (const port of probePorts(base)) {
    const found = await probeInfo(`${u.protocol}//${hostPort(u.hostname, port)}`);
    if (found) return found;
  }
  return null;
}

/**
 * 功能：向 KSD 发一次请求，把响应收成 `{status, body}`（不抛 HTTP 状态，只抛网络层错误）。
 *
 * 说明：⚠️ 状态码不在这里翻 —— 同一条 400 在「解析」和「建任务」下含义不同，
 * 归拢放在 `upstreamError()`，调用方按自己的场景选。
 * 响应体不是 JSON 时 `body` 为 null：KSD 出错时一定有 JSON，
 */
function request(o) {
  const base = new URL(o.base);
  const mod = base.protocol === 'https:' ? https : http;
  const payload = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body), 'utf8');
  const headers = { Accept: 'application/json' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(payload.length);
  }
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : TIMEOUT_READ_MS;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        // WHATWG URL 的 `hostname` 对 IPv6 字面量带方括号（`[::1]`），而 `http.request` 要的是裸地址
        host: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: o.path,
        method: o.method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch (_e) {
              // 非 JSON：`body` 保持 null，由调用方按「对面不是下载器」处理
            }
          }
          resolve({ status: Number(res.statusCode) || 0, body });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 功能：把 KSD 的错误体翻成一句人话（带对前端的状态码）。
 *
 * 说明：⭐ 状态码的选择口径 —— **这是谁的问题就说谁的状态**：
 * 令牌不对 / 地址不对 / 链接不对 / 没选保存目录 ⇒ 400（使用者可以改）；
 * 太频繁 / 队列满 ⇒ 429（等一会儿再来，与 KSD 同义）；
 */
function upstreamError(status, body) {
  const code = String((body && body.error) || '');
  // 下载器回 401 **不能**原样以 401 交出去：前端的 `core/api.js` 见到 401 会当成
  // 「本应用的会话过期」直接跳登录页 —— 用户只是令牌填错了，却被自己的下载器踢下线。
  // 这里归成 400（入参问题，本屏就能改），文案保持「令牌无效」不变。
  if (status === 401) return fail(400, '令牌无效或已吊销，请重新生成');
  // 403 有两种含义，别混成一句：`insufficient_scope` 是令牌少一档权限（`required` 说明缺哪档），
  if (status === 403 && code === 'insufficient_scope') {
    const need = String((body && body.required) || '').trim();
    return fail(
      400,
      need === 'config'
        ? '这把令牌没有「配置写入」权限：去快手作品下载器的「配置 → API 令牌」重新生成一把并勾上它'
        : '这把令牌权限不够，去快手作品下载器的「配置 → API 令牌」看看它有哪些权限',
    );
  }
  if (status === 403) return fail(400, '地址不对，只能填本机地址');
  if (code === 'no_save_dir' || code === 'dir_not_authorized' || code === 'dir_unusable' || code === 'dir_escapes_root') {
    return fail(400, '请先去快手作品下载器里选好保存目录，再回来点下载', { openUrl: OPEN_URL });
  }
  if (status === 429) {
    return fail(
      429,
      code === 'queue_full' ? '下载器那边排队太多了，等几条下完再试' : '调用太频繁，等几秒再试',
    );
  }
  if (status === 404) return fail(404, '没有找到这个任务');
  if (status === 503) return fail(503, '快手作品下载器暂时读不到授权信息，稍后重试');
  if (status === 500) return fail(502, '快手作品下载器自己的令牌表读不出来，去它的页面检查一下数据目录');
  if (status === 400) return fail(400, '链接不对，检查一下');
  if (status === 502) return fail(502, '解析失败：多半是快手 Cookie 过期，去快手作品下载器里重新配一次');
  return fail(502, `快手作品下载器返回了看不懂的结果（HTTP ${status}）`);
}

/**
 * 功能：把连接层错误翻成人话。
 *
 * 说明：⭐ 四种最常见的成因合并成一句、并**列出全部可能**：没装、没启动、端口不对、被防火墙拦。
 * 分开说需要更多信息（而这里拿不到），合成一句反而更好用 —— 使用者按这四个方向自查一遍就能定位。
 *
 */
function networkError(e) {
  const code = String((e && e.code) || '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return fail(502, '连上了快手作品下载器但等太久没回应，稍后再试；一直这样就去它页面看看是不是卡住了');
  }
  return fail(502, '没连上快手作品下载器（未安装 / 没启动 / 端口不对）');
}

module.exports = {
  DEFAULT_URL,
  DEFAULT_PORT,
  OPEN_URL,
  TIMEOUT_READ_MS,
  TIMEOUT_PARSE_MS,
  TIMEOUT_PROBE_MS,
  isLocalHost,
  isLoopbackHost,
  normalizeServiceUrl,
  probePorts,
  probeInfo,
  discover,
  request,
  upstreamError,
  networkError,
};
