/*
 * ZXDesk工作台 Android 客户端
 */

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
import com.zxdesk.app.log.AppLog
import com.zxdesk.app.ui.AppRoot
import com.zxdesk.app.ui.theme.ZxDeskTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 日志先起：后面所有初始化与崩溃排查都要用到它（抽屉里的「日志」读的就是这份）
        if (AppLog.init(this)) {
            AppLog.i("App", "启动 ZXDesk " + versionName() + " · Android " + Build.VERSION.RELEASE + " / " + Build.MODEL)
        }
        // 状态栏 / 导航栏全透明，页面底色透出来（登录页 #F5F7FB、浏览页 #EEF1F6）
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        // 壳强制浅色 ⇒ 系统栏图标永远用深色（isAppearanceLight = true），导航栏对比遮罩关掉
        // （不关的话 API 29+ 会在透明导航栏上叠一层 50% 黑，底部会出现一条 32dp 灰边）
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            // 手势导航机型上屏幕左边缘那条是系统返回的地盘，不排除的话触摸被系统先吃掉，
            // WebViewScreen 的抽屉热区永远收不到事件。⚠️ 部分 ROM（MIUI/HyperOS）不认这个声明，
            // 所以抽屉另有常驻可见的页签把手兜底（WebViewScreen.EdgeHandle），不能只押这一条。
            window.decorView.doOnLayout { decor ->
                val w = (40 * decor.resources.displayMetrics.density).toInt()
                decor.systemGestureExclusionRects = listOf(Rect(0, 0, w, decor.height))
            }
        }
        setContent {
            ZxDeskTheme {
                AppRoot()
            }
        }
    }

    private fun versionName(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName
    }.getOrNull() ?: "?"

    override fun onPause() {
        super.onPause()
        // WebView 的 Cookie 是内存里攒着写的；进程被杀前不刷盘，飞牛登录态就丢了
        CookieManager.getInstance().flush()
    }
}
