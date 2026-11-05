/*
 * ZXDesk工作台 Android 客户端
 * 文件：ConnectGuard.kt
 * 职责：连接节流，连续失败后按阶梯冷却，避开账号侧风控
 */

package com.zxdesk.app

/**
 * 连接节流：连续失败后按阶梯冷却，避开飞牛账号侧的风控。
 *
 * 为什么要有它：飞牛对「短时间内的反复连接 / 登录取证」有风控，触发之后**一段时间直接不让连**
 * —— 实测里即使走自己的 DDNS 域名解析到同一台 NAS 也照样中招。用户在登录页连点「连接」，
 * 自己看着是「重试一下」，在服务端就是一次又一次的失败取证，几下就把自己关在门外。
 *
 * 阶梯（老大 2026-11-02 定的口径）：
 * - **前 3 次不罚** —— 第一次多半是密码打错，立刻禁掉会让人以为「应用连不上」；
 * - 第 4 次罚 **5 秒**，罚完还能再试**两次**（第 5、6 次）；
 * - 第 6 次罚 **15 秒**，罚完还能再试**一次**；
 * - 第 7 次罚 **30 秒**；
 * - 第 8 次起每次罚 **60 秒**（封顶不再涨：风控窗口本身也就几分钟，罚更久等于把人锁在门外）。
 * - **5 分钟没有任何连接尝试 ⇒ 计数与冷却一起清零**（吃个饭回来接着试，不该还背着上次的账）。
 *
 * ⚠️ 计数与截止时间都落盘（[Prefs]）：**杀进程重开不清零**。
 *    只放内存等于给用户留一条「绕过限制继续撞风控」的路 —— 而风控是按来源 IP 记的，
 *    绕过一次就是替自己多攒一次失败。
 * ⚠️ 连上就清零（[reset]）：正常使用不该被历史失败拖住。
 */
class ConnectGuard(private val prefs: Prefs) {

    /**
     * 还要等多久才允许再发起连接。
     *
     * @return 剩余毫秒；0 表示可以连
     */
    fun remainingMs(): Long {
        resetIfIdle()
        val left = prefs.connectCooldownUntil - System.currentTimeMillis()
        return if (left > 0) left else 0L
    }

    /**
     * 记一次连接失败，并给出这次要冷却多久。
     *
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
     * ⚠️ 第 5 次返回 0 是**故意的**：口径是「罚 5 秒之后还能再试两次」，
     *    那两次里的第二次不该再罚一次 —— 真正的下一档在「两次用完之后」。
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
