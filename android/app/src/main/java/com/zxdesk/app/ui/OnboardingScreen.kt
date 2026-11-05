/*
 * ZXDesk工作台 Android 客户端
 * 文件：OnboardingScreen.kt
 * 职责：引导流程，选模式、连接、两步验证、访问码
 */

package com.zxdesk.app.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.AppViewModel
import com.zxdesk.app.Eula
import com.zxdesk.app.LoginFailure
import com.zxdesk.app.NoticeUi
import com.zxdesk.app.OnboardingState
import com.zxdesk.app.OnboardingStep
import com.zxdesk.app.Prefs
import com.zxdesk.app.TwoFactorUi
import com.zxdesk.app.store.Account
import com.zxdesk.app.update.UpdateState
import com.zxdesk.core.connection.ConnectionPlanner
import com.zxdesk.core.connection.InputParser
import com.zxdesk.core.connection.Target
import com.zxdesk.core.connection.TargetKind
import com.zxdesk.core.datasource.DataSourceKind
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 引导流程：① 选模式 → ② 填连接信息 → ③ 两步验证 → ④ 访问码 → ⑤ 应用。
 *
 * 排版规则全在 [Ui] / [StepPage] 里，四步共用：一个 420dp 居中容器、28/16/14sp 三级字号、48dp 主按钮。
 * 状态全在 [AppViewModel]，切后台/旋转不丢。
 *
 * ⭐ 0.2.18：登录页也能划出侧边抽屉（老大 2026-11-03 14:51）。抽屉复用浏览页那一份
 * （[ConnectionDrawer]），只是 `entry = null` —— 「刷新页面 / 换个地址 / 账户 / 设置」
 * 四项没有对象，自动变灰不可点；升级卡、日志、许可、打赏、更新日志、帮助照常可用。
 */
@Composable
fun OnboardingScreen(
    state: OnboardingState,
    vm: AppViewModel,
    updateState: UpdateState,
    /** 公告状态：抽屉底部跑马灯与「公告」行的未读角标。 */
    noticeState: NoticeUi,
    onRefreshNotices: () -> Unit,
    onReadAllNotices: () -> Unit,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val context = LocalContext.current
    val accounts by vm.accounts.collectAsState()
    val prefs = remember { Prefs(context) }
    val version = remember(context) { versionLabel(context) }

    // 整屏子页（盖在引导流程之上，返回键先关它们 —— 它们自己注册的 BackHandler 后注册优先）
    var showAccounts by remember { mutableStateOf(false) }
    var showLogs by remember { mutableStateOf(false) }
    var showHelp by remember { mutableStateOf(false) }
    var showDonate by remember { mutableStateOf(false) }
    var showReleases by remember { mutableStateOf(false) }
    var showNotices by remember { mutableStateOf(false) }
    var showEula by remember { mutableStateOf(false) }

    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // 整个应用只教一次左缘把手（与浏览页共用同一个落盘开关）
    var showDrawerHint by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!prefs.drawerHintShown) {
            prefs.drawerHintShown = true
            showDrawerHint = true
            delay(4_000)
            showDrawerHint = false
        }
    }

    // 返回键：抽屉开 → 关抽屉；否则按原规则逐级回退；第 ① 步没有上一级，交给系统退出
    BackHandler(enabled = drawerState.isOpen || state.step != OnboardingStep.MODE) {
        if (drawerState.isOpen) scope.launch { drawerState.close() } else vm.back()
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        // 手势只认左缘把手那一窄条；默认手势会吃掉表单里的横向操作
        gesturesEnabled = false,
        scrimColor = MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f),
        drawerContent = {
            ModalDrawerSheet(
                drawerShape = RoundedCornerShape(topEnd = 20.dp, bottomEnd = 20.dp),
                drawerContainerColor = MaterialTheme.colorScheme.surface,
                modifier = Modifier.width(DrawerWidth),
            ) {
                // entry = null：还没连接 ⇒ 抽屉自己把「刷新 / 换地址 / 账户 / 设置」灰掉
                ConnectionDrawer(
                    entry = null,
                    version = version,
                    updateState = updateState,
                    onRefresh = {},
                    onChangeAddress = {},
                    onSwitchAccount = {},
                    onOpenLogs = {
                        scope.launch { drawerState.close() }
                        showLogs = true
                    },
                    onOpenHelp = {
                        scope.launch { drawerState.close() }
                        showHelp = true
                    },
                    onOpenSettings = {},
                    onOpenDonate = {
                        scope.launch { drawerState.close() }
                        showDonate = true
                    },
                    onOpenReleases = {
                        scope.launch { drawerState.close() }
                        showReleases = true
                    },
                    marquee = noticeState.marquee,
                    unreadNotices = noticeState.unreadCount,
                    onOpenNotices = {
                        scope.launch { drawerState.close() }
                        showNotices = true
                    },
                    onCheckUpdate = onCheckUpdate,
                    onDownloadUpdate = onDownloadUpdate,
                    onInstallUpdate = onInstallUpdate,
                    onClose = { scope.launch { drawerState.close() } },
                )
            }
        },
    ) {
        Box(Modifier.fillMaxSize()) {
            when (state.step) {
                OnboardingStep.MODE -> ModeStep(state, vm)
                OnboardingStep.CONNECT -> ConnectStep(
                    state = state,
                    vm = vm,
                    accounts = accounts,
                    onSwitchAccount = { showAccounts = true },
                )
                OnboardingStep.TWO_FACTOR -> TwoFactorStep(state, vm)
                OnboardingStep.ACCESS_CODE -> {
                    val entry = state.accessEntry
                    if (entry == null) {
                        ConnectStep(
                            state = state,
                            vm = vm,
                            accounts = accounts,
                            onSwitchAccount = { showAccounts = true },
                        )
                    } else {
                        AccessCodeScreen(
                            entry = entry,
                            onBack = { vm.back() },
                            // auto = true 是页面判定自动触发（整轮只准用一次），false 是人工点按钮
                            onEntered = { auto -> vm.onAccessCodeDone(auto) },
                        )
                    }
                }
            }

            // 左缘把手：与浏览页同一套交互（R-212 只写一份）。
            // 两处与浏览页不同，都是为了不抢表单：
            // ① 热区窄 4dp（36dp）：登录页左侧是输入框，别把左边那一条整个吃掉；
            // ② 高度只取中间 62%：登录页左上角有「‹ 返回」，全高热区会把它的左半边吃掉。
            val haptic = LocalHapticFeedback.current
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .fillMaxHeight(0.62f)
                    .width(36.dp)
                    .pointerInput(Unit) {
                        var dragTotal = 0f
                        val openThreshold = 32.dp.toPx()
                        val releaseThreshold = 16.dp.toPx()
                        detectHorizontalDragGestures(
                            onDragStart = { dragTotal = 0f },
                            onDragEnd = {
                                if (dragTotal > releaseThreshold) {
                                    dragTotal = 0f
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    scope.launch { drawerState.open() }
                                }
                            },
                        ) { change, dragAmount ->
                            change.consume()
                            dragTotal += dragAmount
                            when {
                                dragTotal > openThreshold -> {
                                    dragTotal = 0f
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    scope.launch { drawerState.open() }
                                }
                                dragTotal < 0f -> dragTotal = 0f // 向左滑不算
                            }
                        }
                    },
            ) {
                if (!drawerState.isOpen) {
                    EdgeHandle(
                        modifier = Modifier.align(Alignment.CenterStart),
                        onClick = { scope.launch { drawerState.open() } },
                    )
                }
            }

            if (showDrawerHint && !drawerState.isOpen) {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.inverseSurface,
                    contentColor = MaterialTheme.colorScheme.inverseOnSurface,
                    modifier = Modifier
                        .align(Alignment.CenterStart)
                        .padding(start = 46.dp)
                        .widthIn(max = 210.dp)
                        .clickable { showDrawerHint = false },
                ) {
                    Text(
                        "向右滑，或点这条把手，打开连接面板",
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }

            if (showAccounts) {
                AccountPickerScreen(
                    accounts = accounts,
                    currentKey = if (state.address.isBlank() || state.user.isBlank()) {
                        null
                    } else {
                        state.address.trim() + "\u0001" + state.user.trim()
                    },
                    onPick = { account ->
                        showAccounts = false
                        vm.useAccount(account)
                    },
                    onDelete = vm::removeAccount,
                    onAdd = {
                        showAccounts = false
                        vm.startNewAccount()
                    },
                    onClose = { showAccounts = false },
                )
            }
            if (showLogs) LogScreen(onClose = { showLogs = false })
            if (showHelp) HelpScreen(version = version, onClose = { showHelp = false })
            if (showDonate) DonateScreen(onClose = { showDonate = false })
            if (showReleases) {
                ReleasesScreen(
                    version = version,
                    latest = updateState.latest,
                    latestNotes = updateState.notes,
                    onClose = { showReleases = false },
                )
            }
            if (showNotices) {
                NoticeScreen(
                    state = noticeState,
                    onRefresh = onRefreshNotices,
                    onReadAll = onReadAllNotices,
                    onClose = { showNotices = false },
                )
            }
            if (showEula) EulaViewer(text = Eula.text(context), onClose = { showEula = false })
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
private fun ConnectStep(
    state: OnboardingState,
    vm: AppViewModel,
    accounts: List<Account>,
    onSwitchAccount: () -> Unit,
) {
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
        // 示例进占位符、框下只在认不出地址时出一行错误提示（一个字段最多一行辅助文字）
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

        // 飞牛账号可能是 myaccount 这种，⛔ 不要邮箱键盘
        // 右侧「切换」：保存过账号之后才出现（没有可切的目标时不摆一个空入口）。
        // ⚠️ 用文字不用图标：和下面密码框的「显示 / 隐藏」同一形态，一眼知道能点。
        Field(
            value = state.user,
            onValueChange = vm::onUserChange,
            label = "飞牛账号",
            enabled = !state.busy,
            keyboardType = KeyboardType.Text,
            trailing = {
                if (accounts.isNotEmpty()) {
                    TextButton(onClick = onSwitchAccount, enabled = !state.busy) {
                        Text("切换", fontSize = Ui.BodySize)
                    }
                }
            },
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

        // 记住密码：勾选行在密码框下方、HTTPS 开关上方；右侧「清除」只在本机存着密码时出现。
        // 只留这一行，⛔ 不再有「密钥库加密」那段长说明。
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

        // 被强制时给出可见的禁用态 + 原因（⛔ 不能「看着能点却没反应」）
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

        // 错误/提示放在按钮之前：按钮不会被挤出屏幕
        ErrorLine(state.error)
        state.notice?.let { HintLine(it) }
        state.failure?.let { FailureCard(it, onDismiss = vm::dismissFailure) }
        // 失败后的第二条路：同一账号保存过的其他地址（FNID 解析不了时还有 DDNS / 局域网）
        if (state.alternatives.isNotEmpty() && !state.busy) {
            AlternativeAddresses(addresses = state.alternatives, onPick = vm::useAddress)
        }

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
        Text("信任此设备 30 天", fontSize = Ui.BodySize)
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
        label = "邮箱地址",
        placeholder = tf.info.maskedEmail ?: "你在飞牛绑定的邮箱",
        enabled = !tf.busy,
        keyboardType = KeyboardType.Email,
    )
    Field(
        value = tf.emailCode,
        onValueChange = vm::onEmailCodeChange,
        label = "邮箱验证码",
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

/**
 * 失败后的第二条路：同一账号在账号清单里的其他地址。
 *
 * 为什么不做成自动切换：账号名相同不代表同一台设备（家里也可能有两台 NAS 用同一个账号）。
 * 一次误切就是连到另一台机器上，所以这里只给**建议**，点一下才切。
 *
 * 来源与筛选见 `AppViewModel.alternativesFor`：同账号、排除当前地址、最多 3 条。
 */
@Composable
private fun AlternativeAddresses(addresses: List<String>, onPick: (String) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            "也可以用这些地址：",
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        addresses.forEach { address ->
            TextButton(
                onClick = { onPick(address) },
                contentPadding = PaddingValues(horizontal = 0.dp, vertical = 2.dp),
            ) {
                Text(
                    "改用 $address 连接",
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

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
        appendLine("步骤：${failed.step.name} ${failed.step.label}")
        appendLine("原因：${failed.message}")
        failed.detail?.let { appendLine("详情：$it") }
        appendLine("时间：$time")
    }
}

/** 地址类型小标签：胶囊（#EEF2FF 底 #4338CA 字）；⛔ 深灰块。 */
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
