/**
 * Cookie 注入（移植自 `FnSession.cookies()`）。
 *
 * 名字照 fnOS 前端 bundle：会话 `fnos-token`（SameSite=Strict、**不设过期**）、
 * 长期 `fnos-long-token`（30 天）、入口 `entry-token`（写到 `.<relayHost>` 域）、中继再加 `mode=relay`。
 * ⛔ 不是 `Trim-MC-token`（那个名字 bundle 里根本没有，社区文档写的）。
 *
 * `cookieSpecs()` 是纯函数（可单测），`applyCookies()` 才碰 Electron。
 */

const LONG_TOKEN_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * @param {{token:string, longToken?:string, entryToken?:string, setCookies?:string[]}} session
 * @param {{baseUrl:string, relayHost?:string|null}} target
 * @returns {Array<object>} 交给 `session.cookies.set` 的参数
 */
export function cookieSpecs(session, target) {
  const baseUrl = String(target.baseUrl || '').replace(/\/+$/, '');
  const relayHost = target.relayHost || null;
  const specs = [];
  const seen = new Set();

  if (relayHost) {
    specs.push({ url: baseUrl, name: 'mode', value: 'relay', path: '/', secure: true });
    seen.add('mode');
  }

  // 服务端 Set-Cookie 原样（只取 name=value）
  for (const line of session.setCookies || []) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    specs.push({ url: baseUrl, name, value, path: '/', secure: true });
  }

  if (session.token && !seen.has('fnos-token')) {
    // 会话 Cookie：⛔ 不给 expirationDate（给了就变成持久 Cookie，退出后仍在）
    specs.push({ url: baseUrl, name: 'fnos-token', value: session.token, path: '/', secure: true, sameSite: 'strict' });
    seen.add('fnos-token');
  }

  if (session.longToken) {
    const expirationDate = Math.floor(Date.now() / 1000) + LONG_TOKEN_MAX_AGE;
    specs.push({
      url: baseUrl,
      name: 'fnos-long-token',
      value: session.longToken,
      path: '/',
      secure: true,
      sameSite: 'strict',
      expirationDate,
    });
  }

  if (session.entryToken) {
    const spec = { url: baseUrl, name: 'entry-token', value: session.entryToken, path: '/', secure: true };
    // 同一个 set 里同时给 url 与 domain
    if (relayHost) spec.domain = `.${relayHost}`;
    specs.push(spec);
  }

  return specs;
}

/** 写入远程视图的 Cookie 罐。返回写成功的条数（失败只记日志，⛔ 不中断导航）。 */
export async function applyCookies(session, target, cookieStore, logger = () => {}) {
  const specs = cookieSpecs(session, target);
  let ok = 0;
  for (const spec of specs) {
    try {
      await cookieStore.set(spec);
      ok += 1;
    } catch (e) {
      logger(`Cookie 写入失败：${spec.name}（${e.message}）`);
    }
  }
  return { total: specs.length, ok };
}

/**
 * 退出登录：清掉远程视图分区里的全部 Cookie（保留 TOFU 与偏好，与 Android 一致）。
 *
 * ⚠️ Electron 的 `Cookies` **没有 `clear()`**（0.1.4 调了，日志里是
 * `cookieStore.clear is not a function`，于是 Cookie 根本没清）。正确做法是在 **Session** 上
 * `clearStorageData({ storages: ['cookies'] })`；拿不到 Session 时退化成一條条 `cookies.remove`。
 *
 * @param {object} session - 传 **Session**（不是 session.cookies）；为兼容老调用也接受 `{ cookies }`
 */
export async function clearCookies(session, logger = () => {}) {
  const target = session?.cookies ? session : { cookies: session };
  try {
    if (typeof session?.clearStorageData === 'function') {
      await session.clearStorageData({ storages: ['cookies'] });
      return true;
    }
    // 退化路径：把该会话能看到的 Cookie 全删掉
    const list = await target.cookies.get({});
    for (const cookie of list) {
      const host = String(cookie.domain || '').replace(/^\./, '');
      const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
      await target.cookies.remove(url, cookie.name);
    }
    logger(`Cookie 已逐条清理（${list.length} 条）`);
    return true;
  } catch (e) {
    logger(`清理 Cookie 失败：${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------- ZXDesk 网页会话（zxdesk_sid）

export const WEB_SESSION_COOKIE = 'zxdesk_sid';

const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

/**
 * 从 `Cookies.get()` 的结果里挑出 `zxdesk_sid`，做成可落盘的记录（**不落其它 Cookie**）。
 * @returns {null|{name:string, value:string, host:string, domain:string, path:string, secure:boolean, httpOnly:boolean, sameSite:string, savedAt:number}}
 */
export function pickWebSession(cookieList, url) {
  const cookie = (cookieList || []).find((c) => c && c.name === WEB_SESSION_COOKIE && c.value);
  if (!cookie) return null;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  }
  if (!host) return null;
  return {
    name: WEB_SESSION_COOKIE,
    value: cookie.value,
    host,
    domain: typeof cookie.domain === 'string' && cookie.domain ? cookie.domain.toLowerCase() : host,
    path: typeof cookie.path === 'string' && cookie.path ? cookie.path : '/',
    secure: cookie.secure !== false,
    httpOnly: cookie.httpOnly === true,
    sameSite: SAME_SITE.has(cookie.sameSite) ? cookie.sameSite : 'lax',
    savedAt: Date.now(),
  };
}

/**
 * 回注用的参数。**host 必须一致** —— LAN 与中继是不同 host，⛔ 不能把 A 地址的会话带到 B。
 * 会话级 Cookie ⇒ 不给 `expirationDate`。
 * @returns {null|object} 交给 `cookies.set`
 */
export function webSessionSpec(webSession, { baseUrl } = {}) {
  if (!webSession || webSession.name !== WEB_SESSION_COOKIE || !webSession.value) return null;
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!webSession.host || host !== String(webSession.host).toLowerCase()) return null;
  return {
    url: baseUrl,
    name: WEB_SESSION_COOKIE,
    value: webSession.value,
    path: webSession.path || '/',
    secure: webSession.secure !== false,
    httpOnly: webSession.httpOnly === true,
    sameSite: SAME_SITE.has(webSession.sameSite) ? webSession.sameSite : 'lax',
  };
}
