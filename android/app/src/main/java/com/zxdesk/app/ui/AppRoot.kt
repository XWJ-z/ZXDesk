/*
 * ZXDesk工作台 Android 客户端
 * 文件：AppRoot.kt
 * 职责：全 App 的壳，启动恢复、许可协议闸门、引导流程与浏览页的切换
 */

package com.zxdesk.app.ui

import android.app.Activity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zxdesk.app.AppScreen
import com.zxdesk.app.AppViewModel
import com.zxdesk.app.Eula
import com.zxdesk.app.Prefs
import com.zxdesk.core.update.Notice
import kotlinx.coroutines.delay

/**
 * 全 App 的壳：启动恢复 → 许可协议 → 引导流程 / WebView 之间切换。
 *
 * ⚠️ 所有会「跨后台活下来」的状态都在 [AppViewModel] 里；这里只做路由与生命周期接线。
 * 回到前台时补一次 [AppViewModel.ensureAlive]，让「切到验证器取码再回来」这一步不至于踩到已断的 WS。
 *
 * 根 [Surface] 铺满全屏（含系统栏区域）：登录页底 = background（#F5F7FB），
 * 浏览页底 = surfaceVariant（#EEF1F6 = 网页 --zx-bg），上下两条与网页无缝。
 */
@Composable
fun AppRoot(vm: AppViewModel = viewModel()) {
    val screen by vm.screen.collectAsState()
    val updateState by vm.updateState.collectAsState()
    val accounts by vm.accounts.collectAsState()
    /** 公告：抽屉跑马灯、未读角标与那条「朕已阅」弹窗都读它。 */
    val notice by vm.notice.collectAsState()
    /** 「正在自动登录 / 自动恢复会话」：这期间只给看启动动画，⛔ 不要先露出登录表单。 */
    val autoRecovering by vm.autoRecovering.collectAsState()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val prefs = remember { Prefs(context) }
    val eulaText = remember { Eula.text(context) }
    val eulaVersion = remember(eulaText) { Eula.versionOf(eulaText) }
    var acceptedVersion by remember { mutableIntStateOf(prefs.eulaAcceptedVersion) }

    // 启动动画**统一在这一层**：
    //    `Booting` 与 `Browsing` 各画一套时，两段视觉不同、底色还差一档（#F5F7FB / #EEF1F6），
    //    表现为顶部闪一下。现在两个阶段共用同一条动画、同一个底色，
    //    从恢复会话一直盖到 WebView 首帧（`contentReady`）。
    var contentReady by remember { mutableStateOf(false) }
    var splashMinDone by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        // 最短展示：局域网下 WebView 常 300~500ms 就出首帧，动画一闪而过反而像故障
        delay(SPLASH_MIN_MS)
        splashMinDone = true
    }
    LaunchedEffect(screen) {
        // 回登录页 / 掉线就不再算「已就绪」，下次进浏览态重新盖一次
        if (screen !is AppScreen.Browsing) contentReady = false
    }

    DisposableEffect(lifecycleOwner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            // 回前台：续上登录流程的 WS，并对主界面做一次静默会话探活（断了就地重连）
            if (event == Lifecycle.Event.ON_RESUME) vm.onForeground()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // 许可协议未同意时先把下面的界面挂起：否则 WebView 会在协议还盖着的时候就去连 NAS
    val eulaPending = eulaText.isNotBlank() && acceptedVersion < eulaVersion

    // 公告：**启动 1.2 秒后就拉**，不等进浏览页 —— 登录失败页也要能弹（老大 2026-11-03 15:35）。
    // 1.2 秒是让首屏先画出来，别和登录流程抢带宽；失败不置「已查」，回前台还会重试。
    LaunchedEffect(Unit) {
        delay(1_200)
        vm.checkNoticeOnLaunch()
    }

    // 进应用后自动查一次版本：每次冷启动只查一次，失败也不打断用户（抽屉里可以手动再查）
    val browsing = screen is AppScreen.Browsing && !eulaPending
    LaunchedEffect(browsing) {
        if (browsing) {
            vm.checkUpdateOnLaunch()
            // 公告冷启动那次如果撞上断网会失败，进主界面再补一次（内部有 60 秒防抖 + 10 分钟窗口）
            vm.checkNoticeOnLaunch()
        }
    }

    Box(Modifier.fillMaxSize()) {
        if (eulaPending) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {}
        } else {
            when (val current = screen) {
                // 恢复会话阶段不再自己画转圈：与浏览页共用底下那层动画（见函数头）
                AppScreen.Booting ->
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {}

                is AppScreen.Flow -> Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    OnboardingScreen(
                        state = current.state,
                        vm = vm,
                        // 登录页的抽屉也要有升级卡：检查更新不依赖连上 NAS
                        updateState = updateState,
                        noticeState = notice,
                        onRefreshNotices = vm::refreshNotices,
                        onReadAllNotices = vm::markAllNoticesRead,
                        onCheckUpdate = vm::checkUpdate,
                        onDownloadUpdate = vm::downloadUpdate,
                        onInstallUpdate = vm::installUpdate,
                    )
                }

                is AppScreen.Browsing -> {
                    // 换了会话（新 token）就重建 WebView：否则 Web 内核会沿用旧的 Cookie 与历史栈
                    key(current.entry.fnSession?.token ?: "direct") {
                        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
                            WebViewScreen(
                                entry = current.entry,
                                onExit = { vm.backToLoginScreen() },
                                onSessionExpired = { vm.onSessionExpired() },
                                // 401 要跳登录页时先试静默续会话；接管不了才放它跳
                                onLoginRedirect = { vm.onLoginPageBlocked() },
                                onAccessCodeRequired = { vm.onAccessCodeRequired() },
                                onLogout = { vm.logout() },
                                notice = current.notice,
                                updateState = updateState,
                                noticeState = notice,
                                onRefreshNotices = vm::refreshNotices,
                                onReadAllNotices = vm::markAllNoticesRead,
                                onCheckUpdate = vm::checkUpdate,
                                onDownloadUpdate = vm::downloadUpdate,
                                onInstallUpdate = vm::installUpdate,
                                onFirstPaint = { contentReady = true },
                                accounts = accounts,
                                onPickAccount = vm::useAccount,
                                onRemoveAccount = vm::removeAccount,
                                onAddAccount = vm::startNewAccount,
                            )
                        }
                    }
                }
            }
        }

        // 启动动画：盖住「恢复会话 → WebView 首帧」这一段。
        // ⚠️ 首帧到了也至少显示 SPLASH_MIN_MS —— 局域网下首帧常常 300~500ms 就到，
        //    动画一闪而过反而像「屏幕上闪了一下」。
        // ⭐ 静默自动登录（登录过的用户）也归这一段管：整段只有动画，成功直接进主界面。
        val splashWanted =
            !eulaPending &&
                (
                    (screen is AppScreen.Booting || screen is AppScreen.Browsing) &&
                        (!contentReady || !splashMinDone) ||
                        autoRecovering
                    )
        StartupLoader(
            visible = splashWanted,
            caption = (screen as? AppScreen.Browsing)?.entry?.baseUrl
                ?: (screen as? AppScreen.Flow)?.state?.address?.takeIf { autoRecovering },
        )
    }

    // 什么时候可以弹公告：
    // ① 主界面；② 登录页**已经失败**（失败卡片或红字）且不在连接中。
    // ⛔ 登录过程中（选模式 / 填表 / 两步验证 / 访问码 / 正在连接）一律不弹 ——
    //    那几步要人盯着键盘，盖一层弹窗只会让人以为卡住了。
    val flowState = (screen as? AppScreen.Flow)?.state
    val loginFailed = flowState != null && !flowState.busy &&
        (flowState.failure != null || flowState.error != null)
    val noticeAllowed = browsing || loginFailed

    // 同一进程里同一条公告只弹一次：用户没点「朕已阅」就关掉时，别在每次失败重试时再糊他一脸。
    // ⚠️ 关闭**不等于已读** —— 不写 noticeReadIds，下次启动仍会提醒，新公告不会漏。
    var shownNoticeIds by remember { mutableStateOf(setOf<String>()) }
    var noticeDialog by remember { mutableStateOf<Notice?>(null) }
    LaunchedEffect(noticeAllowed, notice.popup?.id) {
        val target = if (noticeAllowed) notice.popup else null
        when {
            // 开始登录 / 离开可弹时机：立即收起，别挡着用户操作
            !noticeAllowed -> noticeDialog = null
            target != null && target.id !in shownNoticeIds -> {
                shownNoticeIds = shownNoticeIds + target.id
                noticeDialog = target
            }
        }
    }

    noticeDialog?.let { current ->
        AlertDialog(
            onDismissRequest = { noticeDialog = null },
            title = { Text(current.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    if (current.content.isNotBlank()) {
                        Text(current.content, fontSize = 14.sp, lineHeight = 21.sp)
                    }
                    if (notice.unreadCount > 1) {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "另有 ${notice.unreadCount - 1} 条未读公告，可在抽屉「公告」里查看",
                            fontSize = 12.sp,
                            lineHeight = 17.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.markAllNoticesRead()
                        noticeDialog = null
                    },
                ) { Text("朕已阅") }
            },
        )
    }

    // 首次启动（或协议版本变大）必须先同意许可协议；
    // 正文读不到时（assets 异常）不弹窗 —— ⛔ 不能因为少一份文件就把人锁在门外
    if (eulaPending) {
        EulaGate(
            text = eulaText,
            onAccept = {
                prefs.eulaAcceptedVersion = eulaVersion
                acceptedVersion = eulaVersion
            },
            onDecline = { (context as? Activity)?.finish() },
        )
    }
}
