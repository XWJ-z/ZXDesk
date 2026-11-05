/**
 * conn-ui.js —— UI 侧共享的连接交互（发消息 / 连接流程 / 授权并连接 / 状态轮询）
 *
 * 功能：`send` 给消息加超时；`connectFlow` 走「已授权就直接连」；
 *      `authorizeAndConnect` 在用户手势里申请权限再连接；`pollWhile` 在登录等待期间收割状态。
 *
 * ⚠️ 设置不是独立标签页，而是 popup / 侧边栏里的一个视图（`app.js` 的 cardSettings）。
 *    `permissions.request` 的授权点在本模块，必须在点击事件里发起；
 *    手势丢失时回 `need_settings`，让用户在设置视图再点一次。
 * ⚠️ 本模块**任何异常都收敛成确定状态**（failed / need_settings），⛔ 不能有「无限转圈」。
 * ⚠️ 授权成功后要自己再发一次 `conn:start`：只靠 SW 的 `permissions.onAdded` 续跑，
 *    在权限传播延迟时会失败。onAdded 只作为「popup 在授权中被关掉」的兜底，
 *    两边用 `takePending` 取走即删做防双跑。
 *
 * ⛔ UI 不发任何网络请求 —— 解析用纯函数 `lib/address.js`，其余全走消息。
 *
 * @author zx
 * @since 0.1.4
 * 相关：Project/Edge/README.md
 */
import { parseInput, originsFor } from '../lib/address.js';
import { MSG } from '../lib/messages.js';
import { setPending, clearPending, takePending } from '../lib/store.js';

/** 单条消息上限 —— SW 冷启动 + 握手最坏 12s，30s 还没回话就不是「慢」而是坏了（⛔ 不许无限等） */
const SEND_TIMEOUT = 30_000;
/** 授权 resolve 后等权限传播到 SW 的 fetch（⛔ 别删：删了就回到「每次要连两次」） */
const PERM_SETTLE_MS = 300;
/** 「SW 已在跑，我只收割」的轮询节奏与次数 */
const HARVEST_MS = 1500;
const HARVEST_TRIES = 8;
/** 「SW 自动续跑」结果的有效期 —— 更早的那条是上一次连接的遗留，⛔ 不能当本次结果 */
const LAST_CONN_FRESH_MS = 120_000;
/** need_login 期间的轮询上限，与 `lib/connect.js` 的 LOGIN_MAX_MS 对齐（那边 10 分钟就停） */
const LOGIN_WAIT_MAX_MS = 10 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 功能：给 promise 加超时（sendMessage 在 SW 没醒/崩掉时可能永不回话）。 */
function withTimeout(p, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(tag || 'timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** @returns {Promise<any>} SW 的应答（带 30s 上限，超时即 reject ⇒ 调用方给确定失败态） */
export function send(type, payload) {
  return withTimeout(chrome.runtime.sendMessage({ type, payload }), SEND_TIMEOUT, 'messaging_timeout');
}

/** @returns {Promise<{p:object, origins:string[]}|{invalid:string}|null>} 输入解析 + 权限 origins */
export function resolveOrigins(input) {
  return Promise.resolve(originsFor(parseInput(input)));
}

/**
 * 功能：收割 SW 侧（onAdded 续跑）的结果 —— 轮询 `conn:status`，最后一次读 `conn:last`。
 * @param {number} [tries]
 * @returns {Promise<object>} Status（connected / failed / need_login / idle）
 */
async function harvest(tries = HARVEST_TRIES) {
  for (let i = 0; i < tries; i++) {
    await sleep(HARVEST_MS);
    const st = await send(MSG.status).catch(() => null);
    if (st && (st.state === 'connected' || st.state === 'failed' || st.state === 'need_login')) return st;
  }
  const last = await send(MSG.lastConn).catch(() => null);
  // ⚠️ 只认 2 分钟内的结果：更早的那条是上一次连接的遗留，拿它当本次结果会说错话
  const fresh = last && last.status && last.at && Date.now() - last.at < LAST_CONN_FRESH_MS;
  return fresh ? last.status : { state: 'idle' };
}

/**
 * 功能：连接流程（不带授权）—— 解析 → 判已授权 → `conn:start` / 回 `need_settings`。
 * @param {string} input - 用户输入（FNID / IP / 域名 / 完整地址）
 * @returns {Promise<object>} Status（未授权 ⇒ `{state:'need_settings', input}`）
 */
export async function connectFlow(input) {
  try {
    const o = await resolveOrigins(input);
    if (!o) return { state: 'failed', error: 'address_invalid', input };
    if (o.invalid) return { state: 'failed', error: o.invalid, input };
    const p = o.p;
    const granted = await chrome.permissions.contains({ origins: o.origins });
    if (!granted) return { state: 'need_settings', input };
    return await send(MSG.start, { input, kind: p.kind, origin: p.origin, id: p.id });
  } catch (e) {
    return { state: 'failed', error: 'network', detail: String((e && e.message) || e) };
  }
}

/**
 * 功能：授权并连接（一步到位）：
 *   1. 连接意图先落 `storage.session`（pendingConnect —— popup 被授权弹窗关掉也不丢）；
 *   2. 手势内 `permissions.request`（手势丢了 ⇒ 回 need_settings，不静默失败）；
 *   3. 授权成功 ⇒ 等 300ms ⇒ **自己发 `conn:start`**（主路径，真机验证过）；
 *   4. `takePending` 取不到 ⇒ 说明 SW 的 `permissions.onAdded` 已抢先接手 ⇒ 只收割它的结果。
 * @param {string} input - 用户输入
 * @returns {Promise<object>} Status（终态：connected / failed / need_login / need_settings）
 */
export async function authorizeAndConnect(input) {
  let o;
  try {
    o = await resolveOrigins(input);
  } catch (_e) {
    return { state: 'failed', error: 'address_invalid', input };
  }
  if (!o) return { state: 'failed', error: 'address_invalid', input };
  if (o.invalid) return { state: 'failed', error: o.invalid, input };
  const p = o.p;

  // 连接意图先落盘再授权（storage.session 瞬态失败不阻断主流程）
  await setPending({ input, kind: p.kind, origin: p.origin, id: p.id, at: Date.now() }).catch(() => {});

  let hadPerm = false;
  let granted;
  try {
    hadPerm = await chrome.permissions.contains({ origins: o.origins });
    granted = await chrome.permissions.request({ origins: o.origins }); // ⭐ 授权点（手势内）
  } catch (_e) {
    granted = false; // 手势丢失等 ⇒ 走 need_settings，让用户在设置视图再点一次
  }
  if (!granted) {
    await clearPending().catch(() => {});
    return { state: 'need_settings', input, denied: hadPerm };
  }

  await sleep(PERM_SETTLE_MS); // ⚠️ 权限传播：删了这行就回到「连两次」

  // 防双跑：onAdded 已把 pending 取走 ⇒ 它正在跑，这里只收割
  let mine;
  try {
    mine = await takePending();
  } catch (_e) {
    mine = null;
  }
  if (!mine) return harvest();

  try {
    return await send(MSG.start, { input, kind: p.kind, origin: p.origin, id: p.id });
  } catch (e) {
    // SW 不可达 / 超时：先看一眼是不是 onAdded 那边成了，否则如实报失败（⛔ 不假装在连）
    const st = await harvest(3);
    return st && st.state !== 'idle' ? st : { state: 'failed', error: 'network', detail: String((e && e.message) || e) };
  } finally {
    await clearPending().catch(() => {});
  }
}

/**
 * 功能：need_login 期间的 2 s 轮询 —— SW 的登录轮询不推 UI，UI 自己收割状态。
 * ⚠️ 有上限（与 SW 侧 10 分钟同口径）：侧边栏可以一直开着，⛔ 不能永远每 2 s 打一次真握手。
 * @param {(status: object) => boolean} onStatus - 返回 false 停止轮询
 * @param {number} [maxMs] - 轮询上限，缺省 10 分钟
 * @returns {() => void} 停止函数
 */
export function pollWhile(onStatus, maxMs = LOGIN_WAIT_MAX_MS) {
  const deadline = Date.now() + maxMs;
  const timer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(timer); // 停在 need_login（「重新打开」可再起），⛔ 不无限打
      return;
    }
    try {
      const st = await send(MSG.status);
      if (onStatus(st) === false) clearInterval(timer);
    } catch (_e) {
      /* SW 瞬时不可达，下一轮再说 */
    }
  }, 2000);
  return () => clearInterval(timer);
}
