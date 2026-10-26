/**
 * 功能：UI 侧共享的连接交互 —— 发消息、连接流程、授权并连接、状态轮询。
 *
 * ⭐ 口径（0.1.4 真机反馈「设置也是侧边栏或者弹窗，而不是全屏幕进入」）：
 *    设置不是独立标签页，而是 popup/侧边栏里的一个视图（app.js cardSettings），
 *    `permissions.request` 的授权点在本模块 —— 依然是手势内调用（点按钮触发），
 *    手势丢失时回 `need_settings` 让用户在设置视图再点一次。
 *
 * ⭐ 0.1.4 真机修「一直连接中，连不上 NAS」（2026-10-24 23:5x）——两条硬伤：
 *    1. `originsFor` 只回 `{origins}`，这里却读 `o.p.kind` ⇒ 连接第一行 TypeError，
 *       异常没人接 ⇒ UI 永远停在「连接中…」。现在 `p` 由 address.js 一并带回，且本模块
 *       **任何异常都收敛成确定状态**（failed/need_settings），⛔ 不再有「无限转圈」。
 *    2. 0.1.3 的「授权后等 300ms 再 connect」在 0.1.4 迁设置页时被删了，改成只靠 SW 的
 *       `permissions.onAdded` 续跑 —— 权限传播延迟下那一跑必败。现在**回归自己跑**
 *       （0.1.3 真机验证过的路径），onAdded 只作为「popup 在授权中被关掉」的兜底；
 *       用 `takePending` 取走即删做**防双跑**。
 * ⛔ UI 不发任何网络请求（分层纪律 1）——解析用纯函数 `lib/address.js`，其余全走消息。
 */
import { parseInput, originsFor } from '../lib/address.js';
import { MSG } from '../lib/messages.js';
import { setPending, clearPending, takePending } from '../lib/store.js';

/** 单条消息上限 —— SW 冷启动 + 握手最坏 12s，30s 还没回话就不是「慢」而是坏了（⛔ 不许无限等） */
const SEND_TIMEOUT = 30_000;
/** 授权 resolve 后等权限传播到 SW 的 fetch（0.1.3 真机结论，⛔ 别删） */
const PERM_SETTLE_MS = 300;
/** 「SW 已在跑，我只收割」的轮询节奏与次数 */
const HARVEST_MS = 1500;
const HARVEST_TRIES = 8;

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
  return last && last.status ? last.status : { state: 'idle' };
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
 *   1. 连接意图先落 `storage.session`（pendingConnect —— 硬规则 2，popup 被授权弹窗关掉也不丢）；
 *   2. 手势内 `permissions.request`（手势丢了 ⇒ 回 need_settings，不静默失败）；
 *   3. 授权成功 ⇒ 等 300ms ⇒ **自己发 `conn:start`**（主路径，0.1.3 真机验证过）；
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

  // 硬规则 2：连接意图先落盘再授权（session 瞬态失败不阻断主流程）
  await setPending({ input, kind: p.kind, origin: p.origin, id: p.id, at: Date.now() }).catch(() => {});

  let hadPerm = false;
  let granted = false;
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

  await sleep(PERM_SETTLE_MS); // ⭐ 权限传播：删了这行就回到「连两次」（0.1.3 真机结论）

  // 防双跑：onAdded 已把 pending 取走 ⇒ 它正在跑，这里只收割
  let mine = null;
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
 * @param {(status: object) => boolean} onStatus - 返回 false 停止轮询
 * @returns {() => void} 停止函数
 */
export function pollWhile(onStatus) {
  const timer = setInterval(async () => {
    try {
      const st = await send(MSG.status);
      if (onStatus(st) === false) clearInterval(timer);
    } catch (_e) {
      /* SW 瞬时不可达，下一轮再说 */
    }
  }, 2000);
  return () => clearInterval(timer);
}
