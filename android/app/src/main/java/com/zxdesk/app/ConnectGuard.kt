/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.app

/**
 * 连接节流：连续失败后按阶梯冷却，避开飞牛账号侧的风控。
 *
 */
class ConnectGuard(private val prefs: Prefs) {

    /**
     * 还要等多久才允许再发起连接。
     * @return 剩余毫秒；0 表示可以连
     */
    fun remainingMs(): Long {
        resetIfIdle()
        val left = prefs.connectCooldownUntil - System.currentTimeMillis()
        return if (left > 0) left else 0L
    }

    /**
     * 记一次连接失败，并给出这次要冷却多久。
     * @return 本次冷却毫秒；0 表示不冷却
     */
    fun registerFailure(): Long {
        resetIfIdle()
        val now = System.currentTimeMillis()
        val count = prefs.connectFailCount + 1
        prefs.connectFailCount = count
        prefs.connectLastAttemptAt = now
        val cooldown = cooldownFor(count)
        if (cooldown <= 0) return 0L
        prefs.connectCooldownUntil = now + cooldown
        return cooldown
    }

    /** 连接成功：清零失败计数、冷却与「最近一次尝试」。 */
    fun reset() {
        prefs.connectFailCount = 0
        prefs.connectCooldownUntil = 0L
        prefs.connectLastAttemptAt = 0L
    }

    /** 5 分钟没有新尝试 ⇒ 把上一次的账一笔勾销（判据只看「最近一次尝试」的时间戳）。 */
    private fun resetIfIdle() {
        val last = prefs.connectLastAttemptAt
        if (last <= 0) return
        if (System.currentTimeMillis() - last <= IDLE_RESET_MS) return
        prefs.connectFailCount = 0
        prefs.connectCooldownUntil = 0L
        prefs.connectLastAttemptAt = 0L
    }

    /**
     * 第 N 次失败之后罚多久。
     *
     */
    private fun cooldownFor(count: Int): Long = when {
        count <= 3 -> 0L
        count == 4 -> 5_000L
        count == 5 -> 0L
        count == 6 -> 15_000L
        count == 7 -> 30_000L
        else -> 60_000L
    }

    private companion object {
        /** 5 分钟没有任何连接尝试 ⇒ 清零。 */
        const val IDLE_RESET_MS = 5 * 60_000L
    }
}
