package com.zxdesk.app

import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.doOnLayout
import com.zxdesk.app.ui.AppRoot
import com.zxdesk.app.ui.theme.ZxDeskTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 状态栏 / 导航栏全透明，页面底色透出来（登录页 #F5F7FB、浏览页 #EEF1F6）
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        // 壳强制浅色 ⇒ 系统栏图标永远用深色（isAppearanceLight = true），导航栏对比遮罩关掉
        // （不关的话 API 29+ 会在透明导航栏上叠一层 50% 黑 —— 0.2.10 底部那条 32dp 灰边就是它）
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            // 左边缘 32dp 排除系统返回手势（加宽到 32dp）：
            // 手势导航机型上屏幕左边缘那条是系统返回的地盘，不排除的话触摸被系统先吃掉，
            // WebViewScreen 的抽屉热区永远收不到事件。⚠️ 部分 ROM（MIUI/HyperOS）不认这个声明，
            // 所以抽屉另有可见手柄兜底（WebViewScreen.EdgeHandle），不能只押这一条。
            // 高度要等布局完成才知道 ⇒ doOnLayout 里设；旋转会重建 Activity，不用自己监听尺寸变化。
            // 排除区上限单边约 200dp，32dp 远低于上限；3 键导航机型无返回手势，这段不生效也不报错。
            window.decorView.doOnLayout { decor ->
                val w = (32 * decor.resources.displayMetrics.density).toInt()
                decor.systemGestureExclusionRects = listOf(Rect(0, 0, w, decor.height))
            }
        }
        setContent {
            ZxDeskTheme {
                AppRoot()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        // WebView 的 Cookie 是内存里攒着写的；进程被杀前不刷盘，飞牛登录态就丢了
        CookieManager.getInstance().flush()
    }
}
