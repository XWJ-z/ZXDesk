/**
 * ZXDesk工作台 Windows 客户端
 * 文件：guard.js
 * 职责：连接节流（逐条移植自 `Project/Android/app/.../ConnectGuard.kt`）
 *
 * 为什么要有它：飞牛对「短时间内的反复连接 / 登录取证」有风控，触发之后**一段时间直接不让连**
 * —— 实测里即使走自己的 DDNS 域名解析到同一台 NAS 也照样中招。用户在登录页连点「连接」，
 * 自己看着是「重试一下」，在服务端就是一次又一次的失败取证，几下就把自己关在门外。
 * Windows 端 0.2.5 及以前完全没有这层，表现是「越试越进不去」，而且**重启应用也没用**
 * （风控是按来源 IP + 账号记的，不是按进程记的）。
 *
 * 阶梯（与 Android `ConnectGuard` 完全一致）：
 * - **前 3 次不罚** —— 第一次多半是密码打错，立刻禁掉会让人以为「客户端连不上」；
 * - 第 4 次罚 **5 秒**，罚完还能再试**两次**（第 5、6 次）；
 * - 第 6 次罚 **15 秒**，罚完还能再试**一次**；
 * - 第 7 次罚 **30 秒**；
 * - 第 8 次起每次罚 **60 秒**（封顶不再涨：风控窗口本身也就几分钟，罚更久等于把人锁在门外）；
 * - **5 分钟没有任何连接尝试 ⇒ 计数与冷却一起清零**（吃个饭回来接着试，不该还背着上次的账）。
 *
 * ⚠️ 计数与截止时间都进 `prefs.json`：**杀进程重开不清零**。
 * ⚠️ 连上就清零，正常使用不该被历史失败拖住。
 * ⚠️ **网络类失败不计入**（DNS 解析不了 / 连不上 / 超时）—— 那是环境问题，换个网就能好，
 *    按「密码错」罚冷却只会让用户白等。判断在调用方（`isNetworkFailure`）。
 */

/** 5 分钟没有任何连接尝试 ⇒ 清零。 */
export const IDLE_RESET_MS = 5 * 60_000;

/**
 * 第 N 次失败之后罚多久。
 *
 * ⚠️ 第 5 次返回 0 是**故意的**：口径是「罚 5 秒之后还能再试两次」，
 * 那两次里的第二次不该再罚一次 —— 真正的下一档在「两次用完之后」。
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
