/**
 * core/vault-watch.js —— 密码库自动锁定的**唯一计时者**
 *
 * 功能：每 20 秒问一次 `GET /api/vault/status`，按服务端给的 `remainingSeconds`
 * 排一个**精确到期**的定时器；到点再问一次，确认「解锁 → 锁定」的转变，
 * 然后向全页派两个事件：
 * `zx:vault-locking`（剩余 ≤ 30 秒）—— 给正在编辑的屏提个醒…
 *
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/开发方案/2026-11-09-0.9.8-第7轮修改.md §十一、docs/公共/架构文档/16-密码库.md
 */

import { api } from './api.js';

/** 轮询间隔（毫秒）：一次 status 约 1.6 ms，20 秒一次可以忽略 */
const POLL_MS = 20000;

/** 剩余多少秒时先提醒一次（方案定的 30 秒：够人把手上那句话写完） */
const WARN_SECONDS = 30;

/** 启动过没有（`startVaultWatch()` 幂等 —— 两端 `init()` 各调一次也不会起两套） */
let started = false;

/** 主轮询句柄 */
let pollTimer = null;

/** 精确到期句柄 */
let dueTimer = null;

/** 上一次确认的解锁态：`null` = 还不知道（第一次问出来之前不派任何事件） */
let lastUnlocked = null;

/** 这一轮锁定期里「30 秒提醒」派过没有（每次重新解锁都要复位） */
let warned = false;

/**
 * 功能：派「锁上了」—— 各屏据此关弹层、回锁屏。
 *
 * 说明：⚠️ 事件名写成**字面量**（不走一个通用 `fire(name)` 包装）：
 *      `frontend-modules.test.js` 靠静态扫描 `new CustomEvent('zx:…')` 来核对
 *      「派发方与监听方成对」。包一层函数它扫不到，就会把这里判成「只监听没人发」。
 * @returns {void}
 */
function fireLocked() {
  document.dispatchEvent(new CustomEvent('zx:vault-locked', { detail: {} }));
}

/**
 * 功能：派「还剩 N 秒要锁了」—— 给正在编辑的屏提个醒。
 * @param {number} seconds - 剩余秒数
 * @returns {void}
 */
function fireLocking(seconds) {
  document.dispatchEvent(new CustomEvent('zx:vault-locking', { detail: { seconds } }));
}

/**
 * 功能：清掉「精确到期」定时器。
 * @returns {void}
 */
function clearDue() {
  if (dueTimer) clearTimeout(dueTimer);
  dueTimer = null;
}

/**
 * 功能：问一次状态、派事件、重排定时器。
 *
 * 说明：⚠️ 这里**吞掉所有异常**：网络抖动 / 401（`api()` 已经在跳登录页）都不该
 *      让监听方以为「锁上了」或「没锁」—— 状态不确定时**保持上一次结论**，等下一轮。
 * @returns {Promise.<void>}
 */
async function ask() {
  let st;
  try {
    st = await api('GET', '/api/vault/status');
  } catch (_e) {
    return;
  }
  if (!st || typeof st !== 'object') return;

  const on = st.unlocked === true;
  // ⭐ 只认「解锁 → 锁定」这一次转变：首次问出来是锁着（比如刚进页面）不该弹提示
  if (lastUnlocked === true && !on) fireLocked();
  lastUnlocked = on;

  clearDue();
  if (!on) {
    warned = false;
    return;
  }

  const left = Math.max(0, Math.round(Number(st.remainingSeconds) || 0));
  if (left <= WARN_SECONDS && left > 0 && !warned) {
    warned = true;
    fireLocking(left);
  }
  // 到期后**再问一次**才判定锁定（service 端到点才算过期，早 1 秒问到的还是解锁态）
  dueTimer = setTimeout(() => {
    ask();
  }, Math.max(1000, (left + 1) * 1000));
}

/**
 * 功能：启动计时（幂等）。
 *
 * 说明：桌面 `desktop/app.js` 与手机 `mobile/app.js` 的 `init()` 里各调一次。
 *      ⚠️ 页面在后台时 setInterval 会被节流，所以另挂了 `visibilitychange` 补问。
 * @returns {void}
 */
export function startVaultWatch() {
  if (started) return;
  started = true;
  ask();
  pollTimer = setInterval(ask, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    // 回到前台立刻补一次（后台可能已经过了到期时间，而定时器还没跑）
    if (!document.hidden) ask();
  });
}

/**
 * 功能：停掉计时（**只给测试与调试用**：正常页面不需要停）。
 * @returns {void}
 */
export function stopVaultWatch() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  clearDue();
  started = false;
  lastUnlocked = null;
  warned = false;
}
