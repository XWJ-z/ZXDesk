'use strict';
/**
 * core/version-check.js —— 各端最新版本检测
 * 功能：回答「飞牛 / Windows / 安卓 / 浏览器扩展 各自的最新版本是哪个」，并把
 * 「本机这份飞牛包相对服务器是**旧了**、**还是比服务器更新**」判成四个状态之一
 * @author zx
 * @date   2026-10-27
 * @since 0.9.7
 * 相关：Project/server/update-api/README.md、Project/windows/src/main/update/client.js、
 */

const http = require('node:http');
const https = require('node:https');

/**
 * 版本接口（正式环境）。换地址改这里，或用 `ZXDESK_UPDATE_API` 临时覆盖
 * @type {string}
 */
const DEFAULT_API_URL = 'https://api.zxdesk.xwjznh.cn/api/version';

/**
 * 参与检测的四端（顺序 = 界面上从上到下的顺序）。
 * @type {Array.<{key: string, label: string}>}
 */
const PLATFORMS = Object.freeze([
  { key: 'fnos', label: '飞牛 fnOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'android', label: '安卓' },
  { key: 'edge', label: '浏览器扩展' },
]);

/** 只查正式通道（测试通道不对外，界面上也不该出现两套数字） @type {string} */
const CHANNEL = 'stable';

/** 建连闸：从发出请求到收到响应头。跨公网握手正常 1~3 秒，5 秒已经很宽裕。 @type {number} */
const CONNECT_TIMEOUT_MS = 5000;

/** 总时长闸：从发出到响应体读完。 @type {number} */
const TOTAL_TIMEOUT_MS = 8000;

/** 响应体上限（字节）：正常响应约 2 KB，超过 8 KB 一定是坏东西，不必再读。 @type {number} */
const MAX_BODY = 8 * 1024;

/** 结果缓存时长（毫秒）。@type {number} */
const CACHE_MS = 10 * 60 * 1000;

/** 状态 → 界面上的那一小段字。`unknown` 是空串：不可比时**什么都不标**。 @type {Object} */
const STATE_LABEL = Object.freeze({ ahead: '测试版', behind: '有新版本', same: '已是最新', unknown: '' });

/** 版本号形态：`` / `` / `1.2`（缺位补 0）/ `-beta.2`。 @type {RegExp} */
const VERSION_RE = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:-([0-9A-Za-z]{1,16}(?:\.[0-9A-Za-z]{1,16})*))?$/;

/** 只有回环地址允许走明文 http（本地联调桩服务）。 @type {Set.<string>} */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** 缓存：`{ at, payload }`；进程内一份（多账号共用同一个结果）。 @type {?{at: number, payload: Object}} */
let cache = null;

/** 单飞：同一时刻只允许一次真实请求，后来者拿同一个 promise。 @type {?Promise.<Object>} */
let inflight = null;

/**
 * 功能：解析版本号（纯函数）。
 * @param {*} value - 版本串
 * @returns {?{nums: number[], pre: string[]}} 解析结果；形态不认识时为 null
 */
function parseVersion(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  return { nums, pre: m[4] ? m[4].split('.') : [] };
}

/**
 * 功能：比较两个版本号（纯函数）。
 * @param {*} left - 左值
 * @param {*} right - 右值
 * @returns {(-1|0|1|null)} 左小右 -1、相等 0、左大右 1；任一侧不可解析为 null
 */
function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i] ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const len = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1; // 数字标识小于字母标识
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a.pre.length === b.pre.length) return 0;
  return a.pre.length > b.pre.length ? 1 : -1;
}

/**
 * 功能：判定「本机这一份」相对服务器最新版处在什么状态（纯函数）。
 *
 * 说明：⭐ 口径 —— **当前版本 > 服务器版本 ⇒ 提示「测试版」**
 * （本地跑的是还没对外发布的包）。反向（服务器更新）由 `behind` 表达，界面上写「有新版本」。
 * `ahead`（测试版）**只用在一处**：「应用版本」旁那一颗标。界面上的「各端最新版本」列表
 */
function stateOf(current, latest) {
  const c = compareVersion(current, latest);
  const state = c === null ? 'unknown' : c > 0 ? 'ahead' : c < 0 ? 'behind' : 'same';
  return { state, label: STATE_LABEL[state] };
}

/**
 * 功能：把毫秒时间戳格式化成 `YYYY-MM-DD HH:mm`（东八区 = 进程本地时区，与存储层口径一致）。
 * @param {number} ms - 毫秒时间戳
 */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 功能：取版本接口地址（`ZXDESK_UPDATE_API` 可覆盖）。
 * @returns {string} 接口地址原文
 */
function resolveApiUrl() {
  return String(process.env.ZXDESK_UPDATE_API || DEFAULT_API_URL).trim();
}

/**
 * 功能：拼出这次要请求的 URL（带 channel / platform / current 三个参数）。
 *
 * 说明：⚠️ 只放行 https；明文 http **只给回环地址**（本地联调桩服务）。公网明文等于把
 * 「最新版本是哪个」交给中间人改，用户会看到一条假的新版本提示。
 *
 */
function buildUrl(current) {
  let url;
  try {
    url = new URL(resolveApiUrl());
  } catch (_e) {
    return { ok: false, reason: 'config', message: '版本接口地址不可用' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))) {
    return { ok: false, reason: 'config', message: '版本接口地址必须是 https' };
  }
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('platform', 'fnos');
  if (current) url.searchParams.set('current', String(current));
  return { ok: true, url };
}

/**
 * 功能：发一次 GET 并把响应体解析成 JSON —— **不抛错**，失败翻成 `{ok:false, reason, message}`。
 *
 * 说明：⭐ 双闸与 AI 客户端同一套思路（`modules/ai/lib/openai-client.js`）：建连闸抓「地址错 /
 * 对方不在线」，总时长闸抓「连上了但半天不吐字」。两道都到点就 `req.destroy()`。
 * 错误话术是给用户看的，**不带地址、不带上游原文**（设置页不该出现开发者词汇）。
 */
function requestJson(opts) {
  const o = opts || {};
  const built = buildUrl(o.current);
  if (!built.ok) return Promise.resolve({ ok: false, reason: built.reason, message: built.message });
  const url = built.url;
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    // 两个闸门句柄必须在 `finish()` **之前**声明：`mod.request()` 同步抛错时 `finish()`
    // 会在 `connectTimer` 赋值之前就被调用 —— 写成 `const` 就是一次 TDZ 崩（报错还指向 clearTimeout）
    let connectTimer = null;
    let totalTimer = null;
    const finish = (value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      resolve(value);
      return true;
    };
    totalTimer = setTimeout(() => {
      if (finish({ ok: false, reason: 'timeout', message: '更新服务器没有响应（超时了）' }) && req) req.destroy();
    }, TOTAL_TIMEOUT_MS);

    try {
      req = mod.request(url, { method: 'GET', headers: { accept: 'application/json' } }, (res) => {
        clearTimeout(connectTimer);
        if (res.statusCode !== 200) {
          // 404 = 服务器还没有任何发布记录：与「读不到」一样安静降级，不当错误弹给用户
          const notPublished = res.statusCode === 404;
          res.resume();
          finish({
            ok: false,
            reason: notPublished ? 'empty' : 'http',
            message: notPublished ? '更新服务器上还没有发布记录' : `更新服务器返回了 HTTP ${res.statusCode}`,
          });
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            finish({ ok: false, reason: 'invalid', message: '更新服务器返回的内容太大了' });
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          let data;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (_e) {
            finish({ ok: false, reason: 'invalid', message: '更新服务器返回的内容看不懂' });
            return;
          }
          finish({ ok: true, data });
        });
      });
    } catch (_e) {
      finish({ ok: false, reason: 'network', message: '连不上更新服务器' });
      return;
    }

    connectTimer = setTimeout(() => {
      if (finish({ ok: false, reason: 'timeout', message: '连不上更新服务器（超时了）' })) req.destroy();
    }, CONNECT_TIMEOUT_MS);

    req.on('error', () => {
      finish({ ok: false, reason: 'network', message: '连不上更新服务器' });
    });
    req.end();
  });
}

/**
 * 功能：把接口原始响应折成界面要的那份结构（纯函数）。
 *
 * 说明：⚠️ 四端各自独立演进，**某端没有发布记录是正常的**（`data` 里就少一个键）——
 * 那种情况给 `version:''`，界面写「暂无发布记录」，⛔ 不要因此让整份结果失败。
 * 只有「一个端都没有」才算整份失败（那不是缺记录，是接口返回了空壳）。
 */
function buildPayload(raw, current, at) {
  const fail = (reason, message) => ({ ok: false, current: String(current || ''), reason, message });
  if (!raw || typeof raw !== 'object') return fail('invalid', '更新服务器返回的内容看不懂');
  if (raw.ok !== true) return fail('invalid', '更新服务器返回了失败结果');
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const items = [];
  for (const p of PLATFORMS) {
    const row = data[p.key] && typeof data[p.key] === 'object' ? data[p.key] : null;
    const version = row ? String(row.version || '').trim() : '';
    const st = p.key === 'fnos' && version ? stateOf(current, version) : { state: 'unknown', label: '' };
    // ：「高版本且**没有发布**的版本才是测试版，发布了一定会在
    // 服务器更新的」。⇒ 列表里这些版本号**全部来自服务器、都已经发布过**，已发布就不可能是测试版，
    // 列表里唯一有意义的状态是 `behind`（服务器比本机新 ⇒「有新版本」）；
    const listLabel = st.state === 'behind' ? st.label : '';
    items.push({
      platform: p.key,
      label: p.label,
      version,
      publishedAt: row && row.publishedAt ? String(row.publishedAt) : '',
      state: st.state,
      stateLabel: st.label,
      listLabel,
    });
  }
  if (!items.some((it) => it.version)) return fail('empty', '更新服务器上还没有发布记录');
  return {
    ok: true,
    current: String(current || ''),
    channel: String(raw.channel || CHANNEL),
    checkedAt: stamp(at),
    items,
  };
}

/**
 *
 * 说明：⭐ `force` 只用来跳过缓存（同一个人连点两下「刷新」不该被 10 分钟的缓存挡住？
 */
function loadVersions(opts) {
  const o = opts || {};
  const current = String(o.current || '');
  const now = typeof o.now === 'function' ? o.now() : Date.now();
  if (!o.force && cache && now - cache.at < CACHE_MS) return Promise.resolve({ ...cache.payload, fromCache: true });
  if (inflight) return inflight;

  const fetchJson = typeof o.fetchJson === 'function' ? o.fetchJson : requestJson;
  const p = (async () => {
    const res = await fetchJson({ current });
    if (!res || res.ok !== true) {
      return {
        ok: false,
        current,
        checkedAt: stamp(now),
        reason: (res && res.reason) || 'network',
        message: (res && res.message) || '连不上更新服务器',
      };
    }
    const payload = buildPayload(res.data, current, now);
    if (payload.ok) cache = { at: now, payload };
    return payload;
  })();
  inflight = p.finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * 功能：清掉进程内缓存（测试与「刚发完版想立刻验证」用）。
 * @returns {void}
 */
function clearCache() {
  cache = null;
}

module.exports = {
  DEFAULT_API_URL,
  PLATFORMS,
  CHANNEL,
  CACHE_MS,
  STATE_LABEL,
  parseVersion,
  compareVersion,
  stateOf,
  stamp,
  buildUrl,
  buildPayload,
  requestJson,
  loadVersions,
  clearCache,
};
