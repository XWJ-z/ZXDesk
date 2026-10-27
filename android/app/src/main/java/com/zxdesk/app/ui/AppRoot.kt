package com.zxdesk.app.ui

import android.app.Activity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zxdesk.app.AppScreen
import com.zxdesk.app.AppViewModel
import com.zxdesk.app.Eula
import com.zxdesk.app.Prefs

/**
 * 全 App 的壳：启动恢复 → 许可协议 → 引导流程 / WebView 之间切换。
 *
 * ⚠️ 所有会「跨后台活下来」的状态都在 [AppViewModel] 里；这里只做路由与生命周期接线。
 * 回到前台时补一次 [AppViewModel.ensureAlive]，让「切到验证器取码再回来」这一步不至于踩到已断的 WS。
 *
 * 根 [Surface] 铺满全屏（含系统栏区域，§六）：登录页底 = background（#F5F7FB），
 * 浏览页底 = surfaceVariant（#EEF1F6 = 网页 --zx-bg），上下两条与网页无缝。
 */
@Composable
fun AppRoot(vm: AppViewModel = viewModel()) {
    val screen by vm.screen.collectAsState()
    val updateState by vm.updateState.collectAsState()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val prefs = remember { Prefs(context) }
    val eulaText = remember { Eula.text(context) }
    val eulaVersion = remember(eulaText) { Eula.versionOf(eulaText) }
    var acceptedVersion by remember { mutableIntStateOf(prefs.eulaAcceptedVersion) }

    DisposableEffect(lifecycleOwner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.ensureAlive()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // 许可协议未同意时先把下面的界面挂起：否则 WebView 会在协议还盖着的时候就去连 NAS
    val eulaPending = eulaText.isNotBlank() && acceptedVersion < eulaVersion

    // 进应用后自动查一次版本：每次冷启动只查一次，失败也不打断用户（抽屉里可以手动再查）
    val browsing = screen is AppScreen.Browsing && !eulaPending
    LaunchedEffect(browsing) {
        if (browsing) vm.checkUpdateOnLaunch()
    }

    if (eulaPending) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {}
    } else {
        when (val current = screen) {
            AppScreen.Booting -> Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }

            is AppScreen.Flow -> Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                OnboardingScreen(state = current.state, vm = vm)
            }

            is AppScreen.Browsing -> {
                // 换了会话（新 token）就重建 WebView：否则 Web 内核会沿用旧的 Cookie 与历史栈
                key(current.entry.fnSession?.token ?: "direct") {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
                        WebViewScreen(
                            entry = current.entry,
                            onExit = { vm.backToLoginScreen() },
                            onSessionExpired = { vm.onSessionExpired() },
                            onAccessCodeRequired = { vm.onAccessCodeRequired() },
                            onLogout = { vm.logout() },
                            notice = current.notice,
                            updateState = updateState,
                            onCheckUpdate = vm::checkUpdate,
                            onDownloadUpdate = vm::downloadUpdate,
                            onInstallUpdate = vm::installUpdate,
                        )
                    }
                }
            }
        }
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
