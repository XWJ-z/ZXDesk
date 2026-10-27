package com.zxdesk.app.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.AppViewModel
import com.zxdesk.app.LoginFailure
import com.zxdesk.app.OnboardingState
import com.zxdesk.app.OnboardingStep
import com.zxdesk.app.TwoFactorUi
import com.zxdesk.core.connection.ConnectionPlanner
import com.zxdesk.core.connection.InputParser
import com.zxdesk.core.connection.Target
import com.zxdesk.core.connection.TargetKind
import com.zxdesk.core.datasource.DataSourceKind

/**
 * 引导流程：① 选模式 → ② 填连接信息 → ③ 两步验证 → ④ 访问码 → ⑤ 应用。
 *
 * 排版规则全在 [Ui] / [StepPage] 里，四步共用：一个 420dp 居中容器、28/16/14sp 三级字号、48dp 主按钮。
 * 状态全在 [AppViewModel]，切后台/旋转不丢。
 */
@Composable
fun OnboardingScreen(state: OnboardingState, vm: AppViewModel) {
    // 返回键逐级回退；第 ① 步没有上一级，交给系统退出
    BackHandler(enabled = state.step != OnboardingStep.MODE) { vm.back() }

    when (state.step) {
        OnboardingStep.MODE -> ModeStep(state, vm)
        OnboardingStep.CONNECT -> ConnectStep(state, vm)
        OnboardingStep.TWO_FACTOR -> TwoFactorStep(state, vm)
        OnboardingStep.ACCESS_CODE -> {
            val entry = state.accessEntry
            if (entry == null) {
                ConnectStep(state, vm)
            } else {
                AccessCodeScreen(
                    entry = entry,
                    onBack = { vm.back() },
                    onEntered = { vm.onAccessCodeDone() },
                )
            }
        }
    }
}

// ---------------------------------------------------------------- 第 ① 步：选模式

@Composable
private fun ModeStep(state: OnboardingState, vm: AppViewModel) {
    StepPage(
        title = "ZXDesk",
        subtitle = "先选一个使用模式。现在可以连你自己的 NAS。",
    ) {
        ModeCard(
            title = "仅连接 NAS",
            desc = "数据都在你的 NAS 上，手机只是窗口",
            selected = state.mode == DataSourceKind.NAS,
            planned = false,
        ) { vm.selectMode(DataSourceKind.NAS) }
        ModeCard(
            title = "仅本机",
            desc = "不连 NAS，数据只留在手机上",
            selected = false,
            planned = true,
        ) { vm.selectMode(DataSourceKind.LOCAL) }
        ModeCard(
            title = "混合",
            desc = "NAS 与本机一起用，随时切换",
            selected = false,
            planned = true,
        ) { vm.selectMode(DataSourceKind.HYBRID) }

        HintLine(state.notice)
        PrimaryButton(text = "下一步", onClick = vm::next)
    }
}

// ---------------------------------------------------------------- 第 ② 步：连接

@Composable
private fun ConnectStep(state: OnboardingState, vm: AppViewModel) {
    val target = remember(state.address) {
        if (state.address.isBlank()) null else InputParser.parse(state.address)
    }
    val kind = when (target) {
        is Target.FnId -> TargetKind.FNID
        is Target.Host -> target.kind
        is Target.Invalid -> TargetKind.UNKNOWN
        null -> null
    }
    val httpsForced = target is Target.FnId || (target as? Target.Host)?.kind == TargetKind.DOMAIN
    val httpsOff = (target as? Target.Host)?.port == ConnectionPlanner.DIRECT_PORT
    val httpsOn = when {
        httpsForced -> true
        httpsOff -> false
        else -> state.https
    }

    StepPage(
        title = "连接 NAS",
        subtitle = "填地址和飞牛账号。局域网 IP 可以不填账号，直接连。",
        onBack = { vm.back() },
    ) {
        // 示例进占位符、框下只在认不出地址时出一行红字（AND-010 §2.4：一个字段最多一行辅助文字）
        Field(
            value = state.address,
            onValueChange = vm::onAddressChange,
            label = "地址或 FNID",
            // ⛔ 占位符必须是「一眼假」的示例：IP 用 RFC 5737 文档保留段，FNID 用 my-nas，
            //    域名用 example.com。⛔ 不许写任何真实设备地址 / FNID / 公网 IP。
            placeholder = "192.0.2.10 / nas.example.com / my-nas",
            enabled = !state.busy,
            trailing = { kind?.let { KindBadge(it) } },
            isError = kind == TargetKind.UNKNOWN,
            supporting = if (kind == TargetKind.UNKNOWN) "认不出这个地址，检查一下格式" else null,
        )

        // 飞牛账号可能是 myaccount 这种，⛔ 不要邮箱键盘（§2.3）
        Field(
            value = state.user,
            onValueChange = vm::onUserChange,
            label = "飞牛账号",
            enabled = !state.busy,
            keyboardType = KeyboardType.Text,
        )
        Field(
            value = state.password,
            onValueChange = vm::onPasswordChange,
            label = "飞牛密码",
            enabled = !state.busy,
            visualTransformation = if (state.showPassword) {
                VisualTransformation.None
            } else {
                PasswordVisualTransformation()
            },
            keyboardType = KeyboardType.Password,
            imeAction = ImeAction.Done,
            trailing = {
                TextButton(onClick = vm::toggleShowPassword, enabled = !state.busy) {
                    Text(if (state.showPassword) "隐藏" else "显示", fontSize = Ui.BodySize)
                }
            },
        )

        // 记住密码（§三.3）：勾选行在密码框下方、HTTPS 开关上方；右侧「清除」只在本机存着密码时出现。
        // AND-010 §2.4：只留这一行，⛔ 不再有「密钥库加密」那段长说明。
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Checkbox(checked = state.rememberPassword, onCheckedChange = vm::onRememberPasswordChange, enabled = !state.busy)
            Text("记住密码", fontSize = 14.sp)
            Spacer(Modifier.weight(1f))
            if (state.hasSavedPassword) {
                val toast = LocalContext.current
                TextButton(
                    onClick = {
                        vm.clearSavedPassword()
                        Toast.makeText(toast, "已清除本机保存的密码", Toast.LENGTH_SHORT).show()
                    },
                    enabled = !state.busy,
                ) { Text("清除", fontSize = Ui.BodySize) }
            }
        }

        // AND-010 §2.6：被强制时给出可见的禁用态 + 原因（⛔ 不能「看着能点却没反应」）
        InlineSwitchRow(
            text = "HTTPS 安全访问",
            checked = httpsOn,
            onCheckedChange = vm::onHttpsChange,
            enabled = !httpsForced && !httpsOff && !state.busy,
            supporting = when {
                httpsForced -> "飞牛网关只走 HTTPS，这个地址改不了"
                httpsOff -> "8990 是直连救援端口，不走 HTTPS"
                else -> null
            },
        )

        // 错误/提示放在按钮之前：按钮不会被挤出屏幕（§2.5）
        ErrorLine(state.error)
        state.notice?.let { HintLine(it) }
        state.failure?.let { FailureCard(it, onDismiss = vm::dismissFailure) }

        PrimaryButton(
            text = if (state.busy) "连接中…" else "连接",
            onClick = vm::connect,
            enabled = state.address.isNotBlank(),
            busy = state.busy,
        )
        state.progress?.takeIf { state.busy }?.let { HintLine("· $it") }
    }
}

// ---------------------------------------------------------------- 第 ③ 步：两步验证

@Composable
private fun TwoFactorStep(state: OnboardingState, vm: AppViewModel) {
    val tf = state.twoFactor
    if (state.twoFactorDone) {
        // 从第 ④ 步退回来时显示（或者这个账号根本没开两步验证，只是一次普通登录）
        StepPage(
            title = "两步验证",
            subtitle = "已验证通过。网关如果需要访问码，下一页会让你输入。",
            onBack = { vm.back() },
        ) {
            PrimaryButton(
                text = if (state.busy) "正在继续…" else "继续",
                onClick = vm::continueAfterTwoFactor,
                busy = state.busy,
            )
            TextButton(onClick = vm::cancelTwoFactor, enabled = !state.busy) {
                Text("换个账号重新登录", fontSize = Ui.BodySize)
            }
        }
        return
    }
    if (tf == null) {
        // 极短过渡态（恢复登录时）：只占位，不显示半截表单
        StepPage(title = "两步验证", subtitle = "正在恢复登录…", onBack = { vm.back() }) {
            HintLine(state.progress)
        }
        return
    }

    StepPage(
        title = "两步验证",
        subtitle = if (tf.emailView) {
            "验证码会发到这个账号绑定的安全邮箱。"
        } else {
            "账号密码已经通过。去验证器取当前 6 位码，回来会继续。"
        },
        onBack = { vm.back() },
    ) {
        if (tf.emailView) EmailView(tf, vm) else TotpView(tf, vm)
        ErrorLine(tf.error)
    }
}

@Composable
private fun TotpView(tf: TwoFactorUi, vm: AppViewModel) {
    val clipboard = LocalClipboardManager.current
    Field(
        value = tf.totp,
        onValueChange = vm::onTotpChange,
        label = "6 位验证码",
        enabled = !tf.busy,
        keyboardType = KeyboardType.Number,
        imeAction = ImeAction.Done,
        textStyle = MaterialTheme.typography.headlineSmall.copy(
            fontSize = 24.sp,
            textAlign = TextAlign.Center,
            letterSpacing = 8.sp,
        ),
        // 从验证器 App 复制过来的码常常带空格/换行，给一个「粘贴」省得手抠
        trailing = {
            TextButton(
                onClick = {
                    val digits = clipboard.getText()?.text.orEmpty().filter { it.isDigit() }.take(6)
                    if (digits.length == 6) vm.onTotpChange(digits)
                },
                enabled = !tf.busy,
            ) { Text("粘贴", fontSize = Ui.BodySize) }
        },
    )

    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = tf.trustDevice, onCheckedChange = vm::onTrustDeviceChange, enabled = !tf.busy)
        Text("信任此设备（30 天）", fontSize = Ui.BodySize)
    }

    PrimaryButton(
        text = if (tf.busy) "验证中…" else "验证",
        onClick = vm::submitTotp,
        enabled = tf.totp.length == 6,
        busy = tf.busy,
    )
    TextButton(onClick = vm::showEmailView, enabled = !tf.busy && tf.info.emailEnabled) {
        Text("无法使用验证器？改用邮箱", fontSize = Ui.BodySize)
    }
}

@Composable
private fun EmailView(tf: TwoFactorUi, vm: AppViewModel) {
    Text(
        tf.info.maskedEmail?.let { "已绑定：$it" } ?: "已绑定安全邮箱",
        fontSize = Ui.BodySize,
    )
    if (!tf.info.emailEnabled) {
        ErrorLine("这个账号没有绑定安全邮箱，只能用验证器。")
        TextButton(onClick = vm::showTotpView) { Text("返回验证器", fontSize = Ui.BodySize) }
        return
    }

    OutlinedButton(
        onClick = vm::sendEmailCode,
        enabled = !tf.busy && tf.resendLeft == 0,
        shape = RoundedCornerShape(Ui.Radius),
        modifier = Modifier.fillMaxWidth().height(Ui.ButtonHeight),
    ) {
        Text(
            when {
                tf.resendLeft > 0 -> "${tf.resendLeft} 秒后可重发"
                tf.emailSent -> "重新发送验证码"
                else -> "发送验证码"
            },
            fontSize = Ui.InputSize,
        )
    }

    Field(
        value = tf.email,
        onValueChange = vm::onEmailChange,
        label = "完整邮箱地址",
        placeholder = tf.info.maskedEmail ?: "你在飞牛绑定的邮箱",
        enabled = !tf.busy,
        keyboardType = KeyboardType.Email,
    )
    Field(
        value = tf.emailCode,
        onValueChange = vm::onEmailCodeChange,
        label = "邮箱验证码（字母 + 数字）",
        enabled = !tf.busy,
        keyboardType = KeyboardType.Ascii,
        imeAction = ImeAction.Done,
    )

    PrimaryButton(
        text = if (tf.busy) "验证中…" else "验证",
        onClick = vm::submitEmailCode,
        enabled = tf.emailCode.isNotBlank() && tf.email.isNotBlank(),
        busy = tf.busy,
    )
    TextButton(onClick = vm::showTotpView, enabled = !tf.busy) {
        Text("返回验证器", fontSize = Ui.BodySize)
    }
}

// ---------------------------------------------------------------- 失败卡片

/** 失败卡片：说清卡在哪一步，并给一个可复制的诊断（排查全靠它）。 */
@Composable
private fun FailureCard(failed: LoginFailure, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.errorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "卡在：${failed.step.label}",
                fontSize = Ui.InputSize,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                failed.message,
                fontSize = Ui.BodySize,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(diagnosticText(context, failed)))
                        copied = true
                    },
                ) { Text(if (copied) "已复制" else "复制诊断", fontSize = Ui.BodySize) }
                TextButton(onClick = onDismiss) { Text("知道了", fontSize = Ui.BodySize) }
            }
        }
    }
}

/** 供问题反馈用的诊断文本 —— 版本号取真实安装包，别写死。 */
private fun diagnosticText(context: android.content.Context, failed: LoginFailure): String {
    val version = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull() ?: "?"
    val time = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
        .format(java.util.Date())
    return buildString {
        appendLine("ZXDesk $version 原生登录失败")
        appendLine("地址：${failed.address}")
        appendLine("步骤：${failed.step.name}（${failed.step.label}）")
        appendLine("原因：${failed.message}")
        failed.detail?.let { appendLine("详情：$it") }
        appendLine("时间：$time")
    }
}

/** 地址类型小标签：胶囊（#EEF2FF 底 #4338CA 字，§4.3）；⛔ 深灰块。 */
@Composable
private fun KindBadge(kind: TargetKind) {
    val label = when (kind) {
        TargetKind.IP -> "IP"
        TargetKind.DOMAIN -> "域名"
        TargetKind.FNID -> "FNID"
        TargetKind.UNKNOWN -> "认不出"
    }
    val unknown = kind == TargetKind.UNKNOWN
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (unknown) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            Ui.BadgeContainer
        },
        contentColor = if (unknown) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            Ui.BadgeContent
        },
        modifier = Modifier.padding(end = 12.dp),
    ) {
        Text(
            label,
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}
