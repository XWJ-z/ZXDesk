/**
 * 功能：连接编排（一期方案 §四 + 二期方案 §三）—— host / FNID 两条路并存、互相不猜。
 *
 * 状态机：idle → resolving → connected / need_login / failed。
 * - host：UI 解析并授权 ⇒ 握手（网关前缀优先）⇒ health 判登录 ⇒ need_login 开 `{base}/login.html`；
 * - FNID：`resolveFnId` ⇒ `https://<relay>` ⇒ 同一套握手；443 失败 ⇒ 端口兜底 `:httpsPort`；
 *   未登录**开门户** `https://fnos.net/<fnid>/`（中继根是灰屏桌面壳，不是登录页）。
 * - D4：网关未登录回 `200 + text/plain "invalid token"`（一期误判成 not_zxdesk）⇒ 现在按
 *   `need_nas_login` / 门户处理；访问码 HTML ⇒ `access_code`。
 * - R4 红线：`conn:status` 每次真握手，重启后如实报 need_login，⛔ 不假装已连接。
 */
import { fetchHealth } from './api.js';
import { parseInput, linkType } from './address.js';
import { resolveFnId, portalUrl } from './fnid.js';
import { ensureRelayCookie, fetchUserName } from './session.js';
import { getConn, setConn, clearConn } from './store.js';

const LOGIN_POLL_MS = 2000;
const LOGIN_MAX_MS = 10 * 60_000;

/** SW 内存态：登录等待轮询（SW 被杀 ⇒ 轮询断 ⇒ UI 下次 conn:status 真握手会纠正，不会卡死） */
let loginWait = null; // { base, tick, timer, deadline }

// ---- 握手 ----

/**
 * 功能：候选 base 依次握手（网关前缀优先，方案 §4.2）。
 * ⭐ 0.1.3 真机反馈「每次都要连接两次才能连上」：授权刚 resolve 时 SW 的 fetch 偶发
 *    权限未生效 ⇒ 首轮全败。**全盲失败（无 hit 且无网关信号）自动整轮重试一次**（隔 500ms）；
 *    有明确信号（网关要登录 / 访问码）说明请求通了，不重试直接报。
 * @returns {Promise<{base:?string, mode?:'gateway'|'direct', needNasLogin:boolean, accessCode:boolean}>}
 */
async function handshake(origin) {
  const bases = [`${origin}/app/zxdesk`, origin];
  let last = { base: null, needNasLogin: false, accessCode: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    let needNasLogin = false;
    let accessCode = false;
    for (const base of bases) {
      const r = await fetchHealth(base);
      if (r.hit) return { base, mode: base.endsWith('/app/zxdesk') ? 'gateway' : 'direct', needNasLogin, accessCode };
      if (r.accessCode) accessCode = true;
      else if (r.html || r.nasLogin) needNasLogin = true;
    }
    last = { base: null, needNasLogin, accessCode };
    if (needNasLogin || accessCode) return last; // 请求通了，信号明确
  }
  return last; // 两轮全盲败
}

/** 功能：握手失败 ⇒ 统一挑错误码（访问码 > 网关要登录 > 不是 ZXDesk）。 */
function handshakeError(h) {
  return h.accessCode ? 'access_code' : h.needNasLogin ? 'need_nas_login' : 'not_zxdesk';
}

// ---- 状态拼装 ----

/** 功能：`Status` 的公共字段（origin/input/base/mode/link/fnid 全从存储记录来，不另设真相源）。 */
async function statusBase(conn) {
  return {
    base: conn.base,
    input: conn.input,
    origin: conn.origin,
    mode: conn.mode,
    link: conn.link,
    fnid: conn.fnid,
    lastVerified: conn.lastVerified,
  };
}

/** 功能：连接成功收尾 —— 落盘 isValid、补中继 Cookie、取用户名（仅展示）。 */
async function sealConnected(conn) {
  const lastVerified = Date.now();
  const saved = await setConn({ ...conn, isValid: true, lastVerified });
  await ensureRelayCookie(saved.base);
  const user = { name: await fetchUserName(saved.base) };
  return { state: 'connected', ...(await statusBase(saved)), user };
}

/**
 * 功能：health 收口 —— 已登录 ⇒ connected；未登录/网关要登录 ⇒ 登录引导；访问码/网络 ⇒ failed。
 * @param {object} conn - 连接种子（含 base）
 * @param {{portalForFnid:boolean}} opt - FNID ⇒ 未登录开门户；host ⇒ 网关要登录按 need_nas_login 报
 */
async function afterHealth(conn, { portalForFnid }) {
  const health = await fetchHealth(conn.base);
  if (health.hit && health.authenticated) return sealConnected(conn);

  if (!health.hit) {
    if (health.accessCode) return { state: 'failed', error: 'access_code', ...(await statusBase(conn)) };
    if (health.nasLogin && !portalForFnid) return { state: 'failed', error: 'need_nas_login', ...(await statusBase(conn)) };
    if (!health.nasLogin && !health.html) return { state: 'failed', error: 'network', ...(await statusBase(conn)) };
    // nasLogin（FNID，网关会话缺失）或 HTML ⇒ 走登录引导
  }

  await setConn(conn); // 先落盘（isValid:false）—— 断开/换地址才有得清
  const loginUrl = conn.fnid ? portalUrl(conn.fnid) : conn.base + '/login.html';
  const opened = await openLoginPage(loginUrl);
  if (!opened) return { state: 'failed', error: 'open_login_failed', ...(await statusBase(conn)) };
  startLoginWait(conn.base);
  return { state: 'need_login', ...(await statusBase(conn)) };
}

// ---- 对外：连接 ----

/**
 * 功能：`conn:start` —— UI 已用 `parseInput` 识别并申请权限（user gesture 必须在 UI 层拿）。
 * @param {{input:string, kind?:'host'|'fnid', origin?:string, id?:string}} p
 * @returns {Promise<object>} Status
 */
export async function connect(p) {
  if (p.kind === 'fnid' || (!p.origin && p.id)) return connectFnid(p);
  return connectHost(p);
}

/** host 路：origin 来自 UI（或现场解析），握手复用，登录走 `{base}/login.html`。 */
async function connectHost(p) {
  let origin = p.origin;
  if (!origin) {
    const n = parseInput(p.input);
    if (!n) return { state: 'failed', error: 'address_invalid', input: p.input };
    if (n.kind === 'invalid') return { state: 'failed', error: n.error, input: p.input };
    if (n.kind === 'fnid') return connectFnid({ ...p, kind: 'fnid', id: n.id });
    origin = n.origin;
  }
  const seed = { origin, input: p.input || origin, link: linkType(origin), hostPermGranted: true, isValid: false };
  const h = await handshake(origin);
  if (!h.base) return { state: 'failed', error: handshakeError(h), origin, input: seed.input };
  return afterHealth({ ...seed, base: h.base, mode: h.mode }, { portalForFnid: false });
}

/** FNID 路：解析 ⇒ `https://<relay>` ⇒ 握手（443 失败用 `:httpsPort` 兜底）⇒ 登录开门户。 */
async function connectFnid(p) {
  const seed = { input: p.input, fnid: p.id, hostPermGranted: true, isValid: false };
  // ⭐ 0.1.3：解析失败（权限传播延迟 / 瞬时网络）自动重试一次——fn_id_not_found 是明确答案，不重试
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await resolveFnId(p.id);
      break;
    } catch (e) {
      const code = (e && e.code) || 'fn_unreachable';
      if (code === 'fn_id_not_found' || code === 'fn_id_invalid' || attempt === 1) {
        return { state: 'failed', error: code, input: p.input, fnid: p.id };
      }
      await new Promise((r2) => setTimeout(r2, 500));
    }
  }
  seed.origin = 'https://' + r.relay;
  seed.link = 'relay';
  let h = await handshake(seed.origin);
  if (!h.base && r.httpsPort) {
    const alt = seed.origin + ':' + r.httpsPort; // 端口兜底（方案 §三）
    const h2 = await handshake(alt);
    if (h2.base) {
      seed.origin = alt;
      h = h2;
    }
  }
  if (!h.base) return { state: 'failed', error: handshakeError(h), origin: seed.origin, input: seed.input, fnid: p.id };
  return afterHealth({ ...seed, base: h.base, mode: h.mode }, { portalForFnid: true });
}

// ---- 对外：状态 ----

/**
 * 功能：`conn:status` / `conn:recheck` —— **真握手**，不做假连接（R4 红线）。
 * 有登录轮询在跑时直接报 need_login（不与轮询抢请求）。
 */
export async function status() {
  const conn = await getConn();
  if (!conn) return { state: 'idle' };
  if (loginWait && loginWait.base === conn.base) return { state: 'need_login', ...(await statusBase(conn)) };

  const health = await fetchHealth(conn.base);
  if (health.hit && health.authenticated) {
    stopLoginWait();
    return sealConnected(conn);
  }
  if (health.hit || health.nasLogin) return { state: 'need_login', ...(await statusBase(conn)) }; // 网页端登出 / 网关会话没了
  if (health.accessCode) return { state: 'failed', error: 'access_code', ...(await statusBase(conn)) };
  return { state: 'failed', error: 'network', ...(await statusBase(conn)) };
}

// ---- 登录引导（一期 §4.4 / 二期 §三：入口按 kind 选门户或 login.html）----

/** 功能：打开登录页 / 门户标签。失败返回 false（`open_login_failed`）。 */
async function openLoginPage(url) {
  try {
    await chrome.tabs.create({ url });
    return true;
  } catch (_e) {
    return false;
  }
}

/** 功能：启动 2 s 轮询（上限 10 分钟）；`cookies.onChanged` 会调 `onCookieChanged()` 插队。 */
function startLoginWait(base) {
  stopLoginWait();
  loginWait = { base, timer: null, deadline: Date.now() + LOGIN_MAX_MS };
  const tick = async () => {
    if (!loginWait || loginWait.base !== base) return;
    if (Date.now() > loginWait.deadline) {
      stopLoginWait(); // 超时 ⇒ 停在 need_login（「重新打开」可再起），不报错
      return;
    }
    const health = await fetchHealth(base);
    if (health.hit && health.authenticated) {
      stopLoginWait();
      return; // 状态由 UI 下一次 conn:status 收割（UI 在 need_login 期间 2 s 轮询）
    }
    loginWait.timer = setTimeout(tick, LOGIN_POLL_MS);
  };
  loginWait.tick = tick; // 供 onCookieChanged 插队时复用同一条轮询链
  loginWait.timer = setTimeout(tick, LOGIN_POLL_MS);
}

function stopLoginWait() {
  if (loginWait) {
    clearTimeout(loginWait.timer);
    loginWait = null;
  }
}

/** 功能：`zxdesk_sid` 变化 ⇒ 登录等待轮询插队（网页里刚登出/登录都要尽快反映）；已连接态按需 status，不常驻。 */
export function onCookieChanged(name) {
  if (name === 'zxdesk_sid' && loginWait && loginWait.tick) {
    clearTimeout(loginWait.timer);
    loginWait.timer = setTimeout(loginWait.tick, 500);
  }
}

// ---- 对外：断开 ----

/** 功能：`conn:disconnect` —— 清本地数据（conn + cache），停轮询；⛔ 不碰浏览器 Cookie。 */
export async function disconnect() {
  stopLoginWait();
  await clearConn();
  return { ok: true };
}
