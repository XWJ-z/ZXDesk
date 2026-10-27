/**
 * 功能：会话侧（方案 §4.3）—— 中继域判定、`zxdesk_sid` 读取、中继 `mode=relay` Cookie 保活、用户名展示。
 *
 * ⭐ M0 实测的两个口径：
 * - 会话注入走 `credentials:'include'`（浏览器自动带 Cookie），**不手工拼 Cookie 头**；
 * - `cookies.getAll({url})` 在真机上可能返回 0 条（异常），而 `cookies.get` 找得到 ⇒
 *   `sidInfo()` 用 `cookies.get` 做存在性判定（`cookie_missing` 的判据）。
 */
import { fetchJson } from './api.js';

/** 飞牛中继域（与 Android 壳 RELAY_COOKIE 同口径，方案 §4.3） */
export const RELAY_RE = /\.(5ddd\.com|fnos\.net|fynas\.net)$/;
export const SID_NAME = 'zxdesk_sid';

/**
 * 功能：读会话 Cookie 的**属性**（⛔ 值不返回、不落日志——凭据纪律）。
 * @returns {Promise<{found:boolean, length?:number, httpOnly?:boolean, sessionLevel?:boolean}>}
 */
export async function sidInfo(base) {
  const c = await chrome.cookies.get({ url: base, name: SID_NAME });
  if (!c) return { found: false };
  return {
    found: true,
    length: (c.value || '').length,
    httpOnly: c.httpOnly,
    sessionLevel: c.expirationDate == null, // 服务端刻意不加 Max-Age ⇒ 会话级（关浏览器即失效，不是缺陷）
  };
}

/** 功能：中继域补 `mode=relay` Cookie（本插件唯一会写的 Cookie；其它域一个都不写）。 */
export async function ensureRelayCookie(base) {
  let host;
  try {
    host = new URL(base).hostname;
  } catch (_e) {
    return;
  }
  if (!RELAY_RE.test(host)) return;
  try {
    await chrome.cookies.set({
      url: base,
      name: 'mode',
      value: 'relay',
      path: '/',
      secure: base.startsWith('https'),
    });
  } catch (_e) {
    /* 写不上不挡连接——中继票据本就该在网页登录时已种下 */
  }
}

/**
 * 功能：取当前账号名（**仅展示，不落盘**——方案 §4.2）。
 * 服务端口径：`GET /api/auth/me` 直接回 user 行，展示名是 `displayName`（兜底 `username`）。
 * @returns {Promise<?string>} 拿不到（接口变了/未登录）就返回 null，⛔ 不当错误
 */
export async function fetchUserName(base) {
  try {
    const { data } = await fetchJson(base + '/api/auth/me', { timeout: 3000 });
    if (!data) return null;
    return String(data.displayName || data.username || '') || null;
  } catch (_e) {
    return null;
  }
}
