package com.zxdesk.core.connection

/** 输入判定类型 —— 登录页右侧那个小标签就用这四个值（文案在 app 层映射）。 */
enum class TargetKind { IP, DOMAIN, FNID, UNKNOWN }

/**
 * 用户输入解析后的目标。
 *
 * [Host.scheme] 只记「用户自己写了的」scheme；没写就是 null，由
 * [ConnectionPlanner] 按「IP/域名 + 是否勾选 HTTPS」决定，⛔ 别在解析阶段替用户补。
 */
sealed interface Target {
    data class FnId(val id: String) : Target

    data class Host(
        val host: String,
        val port: Int?,
        val scheme: String?,
        val path: String?,
        val kind: TargetKind = TargetKind.DOMAIN,
    ) : Target

    /** 认不出来（空白、乱码、FNID 长度不合规……）；[reason] 直接给界面用。 */
    data class Invalid(val reason: String) : Target
}
