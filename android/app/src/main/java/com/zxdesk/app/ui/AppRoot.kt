package com.zxdesk.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zxdesk.app.AppScreen
import com.zxdesk.app.AppViewModel

/**
 * 全 App 的壳：启动恢复 → 引导流程 / WebView 之间切换。
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
    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(lifecycleOwner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.ensureAlive()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

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
                    )
                }
            }
        }
    }
}
