/**
 * ZXDesk工作台 Windows 客户端
 */

/** 5 分钟没有任何连接尝试 ⇒ 清零。 */
export const IDLE_RESET_MS = 5 * 60_000;

/**
 * 第 N 次失败之后罚多久。
 *
 */
export function cooldownFor(count) {
  if (count <= 3) return 0;
  if (count === 4) return 5_000;
  if (count === 5) return 0;
  if (count === 6) return 15_000;
  if (count === 7) return 30_000;
  return 60_000;
}

export class ConnectGuard {
  /**
   * @param {object} prefs - `PrefsStore`（要 `get()` 与 `patch()`）
   * @param {Function} [now] - 时钟（测试注入）
   */
  constructor(prefs, now = Date.now) {
    this.prefs = prefs;
    this.now = now;
  }

  /** 5 分钟没有新尝试 ⇒ 把上一次的账一笔勾销（判据只看「最近一次尝试」的时间戳）。 */
  resetIfIdle() {
    const value = this.prefs.get();
    const last = value.connectLastAttemptAt || 0;
    if (last <= 0) return;
    if (this.now() - last <= IDLE_RESET_MS) return;
    this.prefs.patch({ connectFailCount: 0, connectCooldownUntil: 0, connectLastAttemptAt: 0 });
  }

  /** 还要等多久才允许再发起连接（毫秒）；0 = 可以连。 */
  remainingMs() {
    this.resetIfIdle();
    const left = (this.prefs.get().connectCooldownUntil || 0) - this.now();
    return left > 0 ? left : 0;
  }

  /**
   * 记一次连接失败。
   * @returns {number} 本次冷却毫秒；0 表示不冷却
   */
  registerFailure() {
    this.resetIfIdle();
    const at = this.now();
    const count = (this.prefs.get().connectFailCount || 0) + 1;
    const cooldown = cooldownFor(count);
    this.prefs.patch({
      connectFailCount: count,
      connectLastAttemptAt: at,
      connectCooldownUntil: cooldown > 0 ? at + cooldown : 0,
    });
    return cooldown;
  }

  /** 连接成功（或明确不是账号问题：访问码闸门）：清零。 */
  reset() {
    const value = this.prefs.get();
    if (!value.connectFailCount && !value.connectCooldownUntil && !value.connectLastAttemptAt) return;
    this.prefs.patch({ connectFailCount: 0, connectCooldownUntil: 0, connectLastAttemptAt: 0 });
  }
}
