'use strict';
/**
 * modules/downloader/routes.js —— **视频下载器**的七条接口
 * 功能：`/api/downloader/*` 一处收全部 —— 连接状态 / 连接设置读写 / 解析 / 建任务 / 任务列表 / 单条任务。
 * 本模块**自己不下载、不存任务、不存 Cookie**：解析与建任务转发给快手作品下载器（KSD），
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、Project/Tools/ks-downloader/API.md
 */

const { AUTH_SECRET, store } = require('../../core/context.js');
const { fail, httpError, json, notFound, readBody } = require('../../core/http-util.js');
const { grantUidOf } = require('../../core/grant-tree.js');
const cred = require('./lib/cred.js');
const ksd = require('./lib/ksd.js');

/** 链接最长多少个字符（与 KSD 的限制一致：超过它对不了，早一点说清） @type {number} */
const MAX_URL_CHARS = 2048;

/**
 * 功能：取本账号的令牌密钥。
 * @param {number} uid - 账号 id
 * @returns {Buffer} 32 字节密钥
 */
function keyOf(uid) {
  return cred.deriveKey(AUTH_SECRET, uid);
}

/**
 * 功能：把库里的设置行翻成**能回给界面**的形状（⛔ 不含令牌与任何密文）。
 * @param {?Object} row - 设置行
 * @returns {{serviceUrl: string, hasToken: boolean, ksdUid: ?number, updatedAt: string}} 可回包形状
 */
function publicSettings(row) {
  const r = row || {};
  return {
    serviceUrl: r.service_url ? String(r.service_url) : '',
    hasToken: cred.isSealed(r),
    ksdUid: r.ksd_uid == null || r.ksd_uid === '' ? null : Number(r.ksd_uid),
    updatedAt: r.updated_at ? String(r.updated_at) : '',
  };
}

/**
 * 功能：解开该账号存着的令牌；没有 / 解不开都给出各自的说法。
 * @param {number} uid - 账号 id
 * @param {?Object} row - 设置行
 * @returns {string} 令牌明文
 * @throws {Error} 没存过令牌、或密文解不开时抛出（400）
 */
function openToken(uid, row) {
  if (!cred.isSealed(row)) {
    throw httpError(400, '还没填令牌：在快手作品下载器的「配置 → API 令牌」里生成一把，填到这里');
  }
  try {
    const token = cred.open(keyOf(uid), uid, {
      iv: row.token_iv,
      cipher: row.token_cipher,
      tag: row.token_tag,
    });
    if (!token) throw new Error('empty');
    return token;
  } catch (_e) {
    // 不把 GCM 的错抛出去：换过实例密钥 / 密文被改动 / 三列不齐，对使用者都是同一件事 —— 重填一次
    throw httpError(400, '保存的令牌打不开了（本机的加密材料换过），请重新填一次令牌');
  }
}

/**
 * 功能：取「地址 ＋ 令牌」这一对；没配置就给出能照着做的提示。
 * @param {number} uid - 账号 id
 * @returns {{base: string, token: string, row: Object}} 连接信息
 * @throws {Error} 没配置 / 地址不合法 / 令牌解不开时抛出（400）
 */
function connOf(uid) {
  const row = store.getDownloaderRow(uid);
  if (!row || !row.service_url) {
    throw httpError(400, '还没连接快手作品下载器：先点右上角「⚙ 配置」填好地址与令牌，再回来试');
  }
  // 库里的地址再校验一遍：它可能在别的版本里被写进去过（或库被手工改过），
  // 这一步是「出网之前的最后一道」—— 白名单只在这里兑现才算真的兑现。
  const base = ksd.normalizeServiceUrl(row.service_url);
  return { base, token: openToken(uid, row), row };
}

/**
 * 功能：向 KSD 发一次请求并把「非 200」翻成人话（连接层错误也在这里翻）。
 * @param {Object} o - `{base, token, method, path, body?, timeoutMs?}`
 * @returns {Promise.<Object>} KSD 的回包（已确认是 2xx）
 * @throws {Error} 连接失败 / 超时 / KSD 回非 2xx 时抛出
 */
async function ask(o) {
  let res;
  try {
    res = await ksd.request(o);
  } catch (e) {
    throw ksd.networkError(e);
  }
  if (res.status >= 200 && res.status < 300) return res.body || {};
  throw ksd.upstreamError(res.status, res.body);
}

/**
 * 功能：把「这把令牌有哪几档权限」收成只含已知三档的一份（顺序固定，未知档丢掉）。
 *
 * 说明：⭐ 三档是**累积**的：`config` ⊃ `task` ⊃ `read`。只认白名单，上游哪天加第四档，
 * 不该顺着我们的状态接口漏进界面（界面也不认识它）。
 * @param {*} raw - `/me` 回的 `scopes`
 */
function scopesOf(raw) {
  const list = Array.isArray(raw) ? raw.map((x) => String(x).trim().toLowerCase()) : [];
  return ['read', 'task', 'config'].filter((s) => list.includes(s));
}

/**
 * 功能：把 `/me` 的 `capabilities`（**按令牌裁剪过的**）收成只含界面上那几个已知字段的一份。
 * @param {?Object} c - `/me` 的 `capabilities`
 * @returns {Object} 能力布尔 ＋ 两条限流数字
 */
function tokenCapsOf(c) {
  const raw = c && typeof c === 'object' ? c : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    parse: raw.parse === true,
    createTask: raw.createTask === true,
    retry: raw.retry === true,
    clearHistory: raw.clearHistory === true,
    configRead: raw.configRead === true,
    configWrite: raw.configWrite === true,
    cookiesRead: raw.cookiesRead === true,
    cookiesWrite: raw.cookiesWrite === true,
    dirsRead: raw.dirsRead === true,
    createTaskPerMinute: num(raw.createTaskPerMinute),
    configWritePerMinute: num(raw.configWritePerMinute),
    maxActiveTasks: num(raw.maxActiveTasks),
  };
}

/**
 * 功能：问 KSD「这把令牌是谁的、它能做什么」。
 * @param {string} base - 地址
 * @param {string} token - 令牌
 * @returns {Promise.<{uid: number, name: string, tokenId: string, scopes: Array.<string>, capabilities: Object}>} 身份
 * @throws {Error} 令牌无效 / 连不上时抛出
 */
async function meOf(base, token) {
  const me = await ask({ base, token, method: 'GET', path: '/api/v1/me', timeoutMs: ksd.TIMEOUT_READ_MS });
  return {
    uid: Number(me.uid),
    name: String(me.name || ''),
    tokenId: String(me.tokenId || ''),
    scopes: scopesOf(me.scopes),
    capabilities: tokenCapsOf(me.capabilities),
  };
}

/**
 * 功能：问一句「这个地址上是不是快手作品下载器，接口是第几版」。
 *
 * 说明：⚠️ 为什么不用 `ask()`：这里要把「连不上」与「那个端口上是别的服务」都归成 502 ——
 * 两者都该触发端口发现；而 `ask()` 会把 404 之类按业务错误报出去（「没有找到这个任务」，
 * @param {string} base - 地址
 */
async function versionOf(base) {
  let res;
  try {
    res = await ksd.request({ base, method: 'GET', path: '/api/v1/version', timeoutMs: ksd.TIMEOUT_READ_MS });
  } catch (e) {
    throw ksd.networkError(e);
  }
  if (res.status >= 200 && res.status < 300 && res.body && res.body.app === 'ksdownloader') return res.body;
  if (res.body && res.body.error) throw ksd.upstreamError(res.status, res.body);
  throw httpError(502, '那个地址上不是快手作品下载器：核对一下地址与端口');
}

/**
 * 功能：从请求里取飞牛用户 uid（取不到回 null）。
 *
 * 说明：⚠️ 只有走飞牛统一网关的访问才带这个身份（`X-Trim-Userid`）。局域网直连 / 独立客户端没有，
 * 那种情况**不是错误**：令牌归属核不了就如实说「这次没核」，⛔ 不因此把保存整个拒掉
 *
 */
function gatewayUidOrNull(req) {
  try {
    return grantUidOf(req);
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：把下载器 `/version` 的 `capabilities` 收成**只含已知字段**的一小份。
 *
 * 说明：⚠️ 白名单而不是原样透传：这份回包会进界面（配置弹窗里那三行），
 * 上游哪天加了内部字段，不该顺着我们的状态接口漏出去。
 * @param {?Object} c - 上游 `capabilities`
 */
function capsOf(c) {
  const raw = c && typeof c === 'object' ? c : {};
  return {
    parse: raw.parse === true,
    task: raw.task === true,
    progress: raw.progress === true,
    cancel: raw.cancel === true,
    createTaskPerMinute: Number.isFinite(Number(raw.createTaskPerMinute)) ? Number(raw.createTaskPerMinute) : 0,
    maxActiveTasks: Number.isFinite(Number(raw.maxActiveTasks)) ? Number(raw.maxActiveTasks) : 0,
  };
}

/**
 * 功能：`GET /status` —— 这一屏该显示「还没连」「连不上（为什么）」「可用」三者之一。
 *
 * 说明：⭐⭐ 连不上时**顺手找一次端口**（KSD 的 5599 被占会往后顺延，而这里存的是手填地址）：
 * 找到就换过去、落库，并在回包里留 `discoveredFrom`（原来的那个地址）让界面说清楚。
 * 只在本机回环地址上找，且只有 502（连不上 / 不是它）才触发 —— 令牌错不换端口。
 */
async function statusOf(uid) {
  const row = store.getDownloaderRow(uid);
  const out = {
    configured: false,
    available: false,
    serviceUrl: '',
    ksdUid: null,
    apiVersion: null,
    capabilities: capsOf(null),
    scopes: [],
    tokenCapabilities: tokenCapsOf(null),
    discoveredFrom: '',
    reason: '',
  };
  if (!row || !row.service_url) {
    out.reason = '还没连接快手作品下载器：点右上角「⚙ 配置」填上地址与令牌，保存后就通了';
    return out;
  }
  out.configured = true;
  out.serviceUrl = String(row.service_url);
  out.ksdUid = row.ksd_uid == null || row.ksd_uid === '' ? null : Number(row.ksd_uid);
  let base;
  try {
    base = ksd.normalizeServiceUrl(row.service_url);
  } catch (e) {
    out.reason = e.message;
    return out;
  }
  if (!cred.isSealed(row)) {
    out.reason = '还没填令牌：在快手作品下载器的「配置 → API 令牌」里生成一把，填到这里';
    return out;
  }
  let token;
  try {
    token = openToken(uid, row);
  } catch (e) {
    out.reason = e.message;
    return out;
  }

  let ver;
  try {
    ver = await versionOf(base);
  } catch (e) {
    // 只有「连不上 / 那个端口上不是它」（都是 502）才去找端口：令牌类错误说明对面就是它，
    // 换一个端口只会换一句说法，还会把「令牌填错了」藏起来。
    if (e.status !== 502) {
      out.reason = e.message;
      return out;
    }
    const found = await ksd.discover(base);
    if (!found) {
      out.reason = `${e.message}（也自动找过顺延的端口，没有在听的快手作品下载器）`;
      return out;
    }
    out.discoveredFrom = base;
    base = found.base;
    out.serviceUrl = base;
    // 跟上就落库：不落的话每次进屏都要再扫一圈，而且「保存并测试」会把旧地址又写回去
    store.putDownloaderRow(uid, { service_url: base });
    try {
      ver = await versionOf(base);
    } catch (e2) {
      out.reason = e2.message;
      return out;
    }
  }
  out.apiVersion = ver.apiVersion != null ? Number(ver.apiVersion) : null;
  // 配置弹窗里「下载器自身的设置」那几行就靠它（能力 / 限流）；连不上的时候保持全 0，界面上不显示
  out.capabilities = capsOf(ver.capabilities);
  try {
    const me = await meOf(base, token);
    out.ksdUid = me.uid;
    // 这把令牌到底能干什么：⛔ 不靠撞错误猜（`/me` 回了按令牌裁剪过的能力与三档权限）
    out.scopes = me.scopes;
    out.tokenCapabilities = me.capabilities;
  } catch (e) {
    out.reason = e.message;
    return out;
  }
  out.available = true;
  return out;
}

/**
 * 功能：把「要下载的链接」规整成一个字符串（只做长度与空值检查，形状交给 KSD 判）。
 * @param {*} raw - 请求体里的 `url`
 * @returns {string} 链接
 * @throws {Error} 空 / 太长时抛出（400）
 */
function urlOf(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw httpError(400, '请把快手作品的链接贴进来');
  if (text.length > MAX_URL_CHARS) throw httpError(400, `链接最多 ${MAX_URL_CHARS} 个字符`);
  if (!/^https?:\/\//i.test(text)) throw httpError(400, '链接要以 http:// 或 https:// 开头');
  return text;
}

/**
 * 功能：处理 `/api/downloader` 及其子路径。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径片段
 */
function handleDownloader({ req, res, parts, url, method, uid }) {
  const kind = parts[2];

  /** 功能：跑一段异步逻辑，失败交给统一的错误出口。 @param {Promise} p @returns {void} */
  const run = (p) => {
    p.catch((e) => fail(res, e));
  };

  if (kind === 'status' && method === 'GET' && parts.length === 3) {
    return run(
      statusOf(uid).then((out) => json(res, 200, out)),
    );
  }

  if (kind === 'settings' && parts.length === 3) {
    if (method === 'GET') return json(res, 200, publicSettings(store.getDownloaderRow(uid)));
    if (method === 'PUT') {
      return readBody(req, res, async (b) => {
        const body = b && typeof b === 'object' ? b : {};
        const hasUrl = Object.prototype.hasOwnProperty.call(body, 'serviceUrl');
        const hasToken = Object.prototype.hasOwnProperty.call(body, 'token');
        if (!hasUrl && !hasToken) throw httpError(400, '没有要保存的内容');
        const rawUrl = hasUrl ? String(body.serviceUrl == null ? '' : body.serviceUrl).trim() : '';
        const rawToken = hasToken ? String(body.token == null ? '' : body.token).trim() : '';

        const prev = store.getDownloaderRow(uid);
        // 空串 ＝ 不改（界面上「只换令牌」不必重填地址）
        let serviceUrl = prev && prev.service_url ? String(prev.service_url) : ksd.DEFAULT_URL;
        if (rawUrl) serviceUrl = ksd.normalizeServiceUrl(rawUrl);

        const fields = { service_url: serviceUrl };
        let verified = false;
        if (rawToken) {
          // 保存前先问一句「这把令牌是谁的」：令牌与账号对不上时，后面每一次调用都会互相打脸
          const me = await meOf(serviceUrl, rawToken);
          const grantUid = gatewayUidOrNull(req);
          if (grantUid !== null) {
            verified = true;
            if (me.uid !== grantUid) throw httpError(400, '这个令牌属于另一个飞牛账号，换一把属于当前账号的');
          }
          const sealed = cred.seal(keyOf(uid), uid, rawToken);
          fields.token_iv = sealed.iv;
          fields.token_cipher = sealed.cipher;
          fields.token_tag = sealed.tag;
          fields.ksd_uid = Number.isFinite(me.uid) ? me.uid : null;
        }

        store.putDownloaderRow(uid, fields);
        return json(res, 200, Object.assign(publicSettings(store.getDownloaderRow(uid)), { verified }));
      });
    }
    return notFound(res);
  }

  if (kind === 'parse' && method === 'POST' && parts.length === 3) {
    return readBody(req, res, async (b) => {
      const url2 = urlOf(b && b.url);
      const conn = connOf(uid);
      const out = await ask({
        base: conn.base,
        token: conn.token,
        method: 'POST',
        path: '/api/v1/parse',
        body: { url: url2 },
        // 解析要等 KSD 起子进程打通上游，用查询那一档超时会天天失败
        timeoutMs: ksd.TIMEOUT_PARSE_MS,
      });
      return json(res, 200, out);
    });
  }

  if (kind === 'tasks') {
    if (parts.length === 3 && method === 'POST') {
      return readBody(req, res, async (b) => {
        const url2 = urlOf(b && b.url);
        const conn = connOf(uid);
        const out = await ask({
          base: conn.base,
          token: conn.token,
          method: 'POST',
          path: '/api/v1/tasks',
          body: { url: url2 },
          timeoutMs: ksd.TIMEOUT_READ_MS,
        });
        return json(res, 200, out);
      });
    }
    if (parts.length === 3 && method === 'GET') {
      // 查询串**原样透传**（`scope` / `page` / `size` / `status` / `q`）：本应用不认识这些参数的含义，
      const qs = (url && url.searchParams && url.searchParams.toString()) || '';
      const conn = connOf(uid);
      return run(
        ask({
          base: conn.base,
          token: conn.token,
          method: 'GET',
          path: '/api/v1/tasks' + (qs ? `?${qs}` : ''),
          timeoutMs: ksd.TIMEOUT_READ_MS,
        }).then((out) => json(res, 200, out)),
      );
    }
    if (parts.length === 4 && method === 'GET') {
      // 任务 id 进的是**路径**：编码一次，避免有人用 `%2F` / `..` 之类把请求带到别处
      const id = String(parts[3] || '').trim();
      if (!id) return notFound(res);
      const conn = connOf(uid);
      return run(
        ask({
          base: conn.base,
          token: conn.token,
          method: 'GET',
          path: `/api/v1/tasks/${encodeURIComponent(id)}`,
          timeoutMs: ksd.TIMEOUT_READ_MS,
        }).then((out) => json(res, 200, out)),
      );
    }
    return notFound(res);
  }

  return notFound(res);
}

// 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/downloader` 上
module.exports = { downloader: handleDownloader };
