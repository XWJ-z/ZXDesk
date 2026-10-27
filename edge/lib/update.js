/**
 * 功能：版本检测 —— 问一次更新服务器「浏览器扩展的最新版本是哪个」，比本机新就留给界面提示。
 *
 * ⚠️ 只在浏览器启动（`runtime.onStartup`）与安装/更新（`runtime.onInstalled`）各跑一次，
 *    ⛔ 不轮询、⛔ 不在 SW 每次唤醒时跑。
 * ⚠️ 查不到必须安静降级：当成「没有新版本」，⛔ 不许影响收藏与连接的任何流程。
 * ⚠️ 全插件唯一的「非 NAS」联网点：只发平台名，⛔ 不带 Cookie（不传 `credentials`）、
 *    ⛔ 不带账号、收藏内容或任何设备标识。
 * ⚠️ 扩展没有该域名的 host 权限，跨域要靠服务端 `Access-Control-Allow-Origin: *` 放行；
 *    服务端一旦收窄成官网域名，这里的检测会静默失效（权限与口径见 README §五）。
 */
import { getUpdate, setUpdate } from './store.js';

const API = 'https://api.zxdesk.xwjznh.cn/api/version/edge';
/** 安装包下载地址（百度网盘，`pwd` 参数自带提取码）；接口下发 `fallbackUrl` 时以接口为准 */
const PAN_URL = 'https://pan.baidu.com/s/1vJ5lUMSYJ7TXbFOptu44_g?pwd=c6fr';
const PAN_CODE = 'c6fr';
const TIMEOUT = 6000;

/**
 * 版本号取前三段数字（`0.1.6` / `v0.1.6` / `0.1`）。
 * ⚠️ 不能用字符串比较：`0.1.10` 的字典序在 `0.1.9` 之前，会把旧版当新版提示。
 * ⚠️ 后缀（`-beta.1`）按同号处理，不区分预发布 —— 本端没有 beta 通道。
 */
const VERSION_RE = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?/;

/**
 * @param {unknown} value
 * @returns {number[]|null} 三段数字（缺位补 0）；无法解析返回 null
 */
export function parseVersion(value) {
  const m = VERSION_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
  return nums.every(Number.isSafeInteger) ? nums : null;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {-1|0|1|null} 左小右 -1、相等 0、左大右 1；任一侧无法解析返回 null
 */
export function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** `candidate` 是否比 `current` 新；任一侧不可解析一律 false（宁可漏提示，不提示错）。 */
export function isNewer(candidate, current) {
  return compareVersion(candidate, current) === 1;
}

/** 检测接口地址 —— 界面上的「打开接口自测」也要用它，所以带出去。 @type {string} */
export const VERSION_API = API;

/**
 * 功能：拉一次最新版本并落盘。
 * ⚠️ 失败要能说出「哪一步断的」：启动时的气泡可以安静降级，但设置里手动点的那次必须如实回报，
 *    否则用户只看到「连不上」，谁也没法判断是断网、被拦、服务器 5xx，还是后台还是旧版。
 * @returns {Promise<{ok:true, rec:object}|{ok:false, code:string}>}
 *   code ∈ `timeout`｜`network`｜`http_<状态码>`｜`bad_json`｜`bad_data`｜`storage`｜`exception`
 */
export async function checkForUpdate() {
  let res;
  try {
    res = await fetch(API, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const code = timeout ? 'timeout' : 'network';
    console.warn('[zxdesk] 版本检测没成：', code, (e && e.message) || e);
    return { ok: false, code };
  }
  if (!res.ok) {
    console.warn('[zxdesk] 版本检测没成：http_' + res.status);
    return { ok: false, code: 'http_' + res.status };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    console.warn('[zxdesk] 版本检测没成：bad_json', (e && e.message) || e);
    return { ok: false, code: 'bad_json' };
  }
  const data = body && body.ok ? body.data : null;
  if (!data || !parseVersion(data.version)) {
    console.warn('[zxdesk] 版本检测没成：bad_data', JSON.stringify(body).slice(0, 200));
    return { ok: false, code: 'bad_data' };
  }

  const fallback = String(data.fallbackUrl || '');
  const rec = {
    current: chrome.runtime.getManifest().version,
    latest: String(data.version),
    url: /^https?:\/\//i.test(fallback) ? fallback : PAN_URL,
  };
  try {
    await setUpdate(rec);
  } catch (e) {
    console.warn('[zxdesk] 检测结果没存下来：', (e && e.message) || e);
    return { ok: false, code: 'storage' };
  }
  return { ok: true, rec };
}

/**
 * 功能：要不要提示 —— 本机已追上（手装新版）、这一版已被关掉过，都不提示。
 * @param {?object} rec - 存储里的检测结果 {latest, dismissed, url}
 * @param {string} current - 本机版本
 * @returns {boolean}
 */
export function shouldPrompt(rec, current) {
  if (!rec || !rec.latest || rec.latest === rec.dismissed) return false;
  return isNewer(rec.latest, current);
}

/**
 * 功能：检测结果 → 界面要的载荷（补齐下载地址与提取码；服务端换成别的地址就没有码）。
 * @param {{current:string, latest:string, url?:string}} rec - 一次检测结果
 * @returns {{current:string, latest:string, url:string, code:string}}
 */
export function promptOf(rec) {
  const url = rec.url || PAN_URL;
  return { current: rec.current, latest: rec.latest, url, code: url === PAN_URL ? PAN_CODE : '' };
}

/**
 * 功能：读「要不要提示」的结论，并补齐界面要用的下载信息。
 * @param {string} [current] - 本机版本，缺省取 manifest
 * @returns {Promise<?{current:string, latest:string, url:string, code:string}>}
 */
export async function readUpdate(current = chrome.runtime.getManifest().version) {
  const rec = await getUpdate();
  if (!shouldPrompt(rec, current)) return null;
  return promptOf({ ...rec, current });
}

/** 功能：用户关掉气泡 ⇒ 记住这一版不再提示（服务器再出新版会重新提示，判据在 `readUpdate`）。 */
export async function dismissUpdate(version) {
  await setUpdate({ dismissed: String(version || '') });
}
