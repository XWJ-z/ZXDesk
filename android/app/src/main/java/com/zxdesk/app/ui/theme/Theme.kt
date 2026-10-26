package com.zxdesk.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material3.LocalContentColor
import androidx.compose.ui.graphics.Color

/**
 * 壳只做浅色（任务单 AND-008 §四）。
 *
 * 为什么不跟系统深色：WebView 里的网页（`mobile/app.css`）**没有深色方案**，
 * 深色壳套浅色网页怎么调都是拼接感（0.2.10 的真机截图就是「深控件 + 浅底 + 黑标题」）。
 * 系统深色时也强制浅色；系统栏图标按浅色声明。真要深色得先让网页支持，二期再议。
 *
 * 色板与网页 `tokens.css` 同源（primary #4F46E5 靛蓝），**全键显式给值**，
 * ⛔ 不留 M3 默认紫、⛔ 不用动态取色、⛔ 不靠透明度凑层级（0.2.9 的教训）。
 */
private val LightScheme = lightColorScheme(
    primary = Color(0xFF4F46E5),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFE0E7FF),
    onPrimaryContainer = Color(0xFF312E81),
    secondary = Color(0xFF6366F1),
    onSecondary = Color(0xFFFFFFFF),
    background = Color(0xFFF5F7FB),
    onBackground = Color(0xFF1F2430),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1F2430),
    surfaceVariant = Color(0xFFEEF1F6),
    onSurfaceVariant = Color(0xFF5C6470),
    surfaceContainerLow = Color(0xFFF8FAFC),
    surfaceContainerHigh = Color(0xFFEAEFF6),
    outline = Color(0xFFC7CEDB),
    outlineVariant = Color(0xFFE4E9F1),
    error = Color(0xFFDC2626),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF991B1B),
    scrim = Color(0xFF000000),
)

@Composable
fun ZxDeskTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = LightScheme) {
        // M3 不自动给裸 Text 配色（会落成纯黑）；统一挂到 onBackground
        CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) {
            content()
        }
    }
}
