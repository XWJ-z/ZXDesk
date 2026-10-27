package com.zxdesk.app.update

/**
 * 版本与更新在界面上的阶段。
 *
 * ⛔ 别把「检查中」和「下载中」合成一个布尔量：两者的按钮、进度条与可取消性都不一样。
 */
enum class UpdatePhase {
    /** 还没查过（或静默检查失败，界面上仍是「检查更新」）。 */
    IDLE,
    CHECKING,

    /** 查过了，已是最新或该端还没有发布记录。 */
    LATEST,
    AVAILABLE,
    DOWNLOADING,

    /** 包已下载并通过大小 / SHA256 / 包内版本三道校验，可以安装。 */
    READY,
    ERROR,
}

/**
 * 抽屉里「版本与更新」要做的事都从这里读。
 *
 * [progress] 为 null = 还不知道总大小（服务端没给 fileSize 时），界面用不定进度条。
 */
data class UpdateState(
    val phase: UpdatePhase = UpdatePhase.IDLE,
    val current: String = "",
    val currentCode: Long = 0,
    val latest: String? = null,
    val available: Boolean = false,
    /** 服务端点名 force 或当前版本低于 minVersion：必须更新（按钮不给「以后再说」）。 */
    val mustUpdate: Boolean = false,
    val notes: String = "",
    val fileName: String = "",
    val fileSize: Long = 0,
    val progress: Int? = null,
    val filePath: String = "",
    val fallbackUrl: String = "",
    /** 这次「下载更新」已经试了几次（0 = 还没开始）。 */
    val attempts: Int = 0,
    /** 连续失败到上限后置位：界面给「去网盘手动更新」出口并停止重试。 */
    val giveUp: Boolean = false,
    val error: String? = null,
    val checkedAt: Long = 0,
) {
    /** 主按钮文案：一个阶段只给一个主动作，避免抽屉里堆一排按钮。 */
    val actionLabel: String
        get() = when (phase) {
            UpdatePhase.IDLE -> "检查更新"
            UpdatePhase.CHECKING -> "正在检查…"
            UpdatePhase.LATEST -> "检查更新"
            UpdatePhase.AVAILABLE -> "下载更新"
            UpdatePhase.DOWNLOADING -> "正在下载…"
            UpdatePhase.READY -> "立即安装"
            UpdatePhase.ERROR -> if (available) "重新下载" else "检查更新"
        }

    /** 主按钮能不能点。 */
    val actionEnabled: Boolean
        get() = phase != UpdatePhase.CHECKING && phase != UpdatePhase.DOWNLOADING
}
