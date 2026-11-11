/**
 * ZXDesk工作台 Windows 客户端
 * 文件：cookies.js
 * 职责：Cookie 注入（移植自 `FnSession.cookies()`）
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
 * 合并多份 Cookie 头（`name=value; …`），同名以后给的为准。
 *
 * 为什么需要：原生探测与 WS 握手要同时带「登录会话 Cookie」和「远程视图分区里的网关 Cookie」
 * （访问码过了之后网关种下的那份）。两份直接接起来会出现同名两条，服务端行为不可预期；
 * 而浏览器里的那份是服务端续期过的，应该覆盖登录时的快照（Android 0.2.17 的踩坑）。
 *
 * @param {...string} parts
 * @returns {string}
 */
export function mergeCookieHeader(...parts) {
  const out = [];
  const index = new Map();
  for (const part of parts) {
    for (const raw of String(part || '').split(';')) {
      const pair = raw.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      if (!name) continue;
      if (index.has(name)) out[index.get(name)] = pair;
      else {
        index.set(name, out.length);
        out.push(pair);
      }
    }
  }
  return out.join('; ');
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

// ---------------------------------------------------------------- 网关凭据（访问码）

/**
 * 这些名字属于「飞牛登录会话 / ZXDesk 网页会话」，各有各的落盘通道，⛔ 不进网关凭据。
 * - `fnos-token` / `fnos-long-token` / `entry-token` → `FnSession`（session.bin 里的 session 段）；
 * - `zxdesk_sid` → `webSession`（同样在 session.bin，但单独一段、带 host 校验）；
 * - `mode=relay` → 每次按 relayHost 重新算出来。
 */
const NON_GATEWAY_NAMES = new Set(['fnos-token', 'fnos-long-token', 'entry-token', 'zxdesk_sid', 'mode']);

/** 网关凭据最多存几条（防某个部署往浏览器里塞一堆无关 Cookie 把快照撑大）。 */
export const GATEWAY_COOKIE_LIMIT = 20;

/**
 * 从分区 Cookie 里挑出**网关凭据**（访问码过完之后网关种下的那几条）。
 *
 * 为什么要落盘：Electron 的 `persist:` 分区只持久化**带有效期**的 Cookie，会话级 Cookie
 * 应用一关就没了。而飞牛网关的访问码 Cookie 正是会话级 —— 于「每次启动都要重新输一次访问码」。
 * 这里把它按 `session.bin`（safeStorage 加密）存起来，启动时回注；过期的由网关自己再拦一次。
 *
 * @param {Array<object>} cookieList - `session.cookies.get({url})` 的结果
 * @param {number} [now] - 当前秒级时间戳（测试注入）
 * @returns {Array<object>} 可直接交给 `cookies.set` 的规格
 */
export function pickGatewayCookies(cookieList, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const cookie of cookieList || []) {
    if (!cookie || !cookie.name || !cookie.value) continue;
    if (NON_GATEWAY_NAMES.has(cookie.name)) continue;
    // 已经过期的别存（回注一个死 Cookie 只会在请求里多一个脏字段）
    if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0 && cookie.expirationDate <= now) continue;
    out.push({
      name: cookie.name,
      value: cookie.value,
      domain: String(cookie.domain || ''),
      path: typeof cookie.path === 'string' && cookie.path ? cookie.path : '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true,
      sameSite: SAME_SITE.has(cookie.sameSite) ? cookie.sameSite : 'unspecified',
      ...(typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0
        ? { expirationDate: cookie.expirationDate }
        : {}),
    });
    if (out.length >= GATEWAY_COOKIE_LIMIT) break;
  }
  return out;
}

/**
 * 回注网关凭据。
 *
 * ⚠️ `url` 与 `domain` 的取舍：Electron 在 `url` 与 `domain` 冲突时会直接抛错，
 * 所以只有当 Cookie 的 domain 与当前主机**不完全相同**（带了父域 / 子域）时才显式给 domain。
 */
export function gatewayCookieSpecs(list, { baseUrl } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return [];
  // ⚠️ 不要写成 `let host = ''`：下面 try 里一定赋值、catch 里直接 return，
  //    初始空串从没被读过（`no-useless-assignment` 会判它，零警告门禁会挡出包）。
  let host;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return [];
  }
  const specs = [];
  for (const cookie of list || []) {
    if (!cookie || !cookie.name || typeof cookie.value !== 'string') continue;
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    const spec = {
      url: base,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true,
    };
    if (domain && domain !== host) spec.domain = cookie.domain;
    if (SAME_SITE.has(cookie.sameSite)) spec.sameSite = cookie.sameSite;
    if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) {
      spec.expirationDate = cookie.expirationDate;
    }
    specs.push(spec);
  }
  return specs;
}

/** 把网关凭据写进分区（失败只记日志，⛔ 不中断导航）。 */
export async function applyGatewayCookies(list, target, cookieStore, logger = () => {}) {
  const specs = gatewayCookieSpecs(list, target);
  let ok = 0;
  for (const spec of specs) {
    try {
      await cookieStore.set(spec);
      ok += 1;
    } catch (e) {
      logger(`网关凭据回注失败：${spec.name}（${e.message}）`);
    }
  }
  return { total: specs.length, ok };
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
  let host;
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
  let host;
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
