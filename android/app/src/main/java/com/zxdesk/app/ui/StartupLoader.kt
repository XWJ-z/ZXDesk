/*
 * ZXDesk工作台 Android 客户端
 * 文件：StartupLoader.kt
 * 职责：启动加载页，两段旋转弧与中心呼吸点，盖住 WebView 首帧前的白屏
 */

package com.zxdesk.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 启动动画的最短展示时长（毫秒）。
 *
 * 局域网直连时 WebView 常在 300~500ms 内画出首帧，动画刚出现就淡出，
 * 观感上像一次闪动而非加载过程。
 * 700ms 是「能看清这是一次有意的动画」与「不让人觉得被故意拖住」之间的一档；
 * 加载本来就慢时它不参与（首帧不到就一直显示）。
 */
internal const val SPLASH_MIN_MS = 700L

/**
 * 启动加载页。
 *
 * WebView 从 `loadUrl` 到「画出第一帧」之间只有一条顶部进度条，底下是**纯白**。
 * 这段通常 0.6~2 秒（冷启动 ＋ TLS 握手 ＋ 十几个 ES 模块串行下载），
 * 使用者看到的是「点图标 → 白屏 → 突然满屏内容」。这一层用壳的浅底把白屏盖住，
 * 并给一个**有节奏、可随时被打断**的动画 —— 加载再慢也不像卡死。
 *
 * 三条约束：
 * ① 动画只做「信号」不做「表演」，必须能被内容随时打断；
 * ② 慢而稳优于快而闪 —— 快速脉冲会让等待显得更长，故两段弧取 1150ms / 1700ms；
 * ③ 顶多三件东西：一个标记、一句话、一条可选的来源说明。
 *    ⛔ 不做进度百分比：真实进度拿不到，假百分比比没有更糟。
 *
 * ⚠️ 只用 `MaterialTheme` 令牌与网页 `theme-color` 同款的浅底 —— 壳强制浅色，
 *    这里**不判断系统深色**，否则会先闪一下深底再变浅。
 * ⚠️ 出现**不做淡入**、退出淡出 260ms：淡入等于把白屏又露出来半秒。
 */
@Composable
fun StartupLoader(
    visible: Boolean,
    /** 副标题：一般给「连的是哪台设备」，让用户在白屏期就能确认没连错。 */
    caption: String? = null,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = visible,
        enter = EnterTransition.None,
        exit = fadeOut(animationSpec = tween(durationMillis = 260)),
        modifier = modifier,
    ) {
        Box(
            modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(horizontal = 32.dp),
            ) {
                RingMark(diameter = 68.dp, stroke = 3.dp)
                Spacer(Modifier.height(22.dp))
                Text(
                    text = "正在打开工作台",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!caption.isNullOrBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = caption,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.66f),
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * 启动标记：两段反向旋转的弧 ＋ 中心呼吸点。
 *
 * 只用 `Canvas` 的 `drawArc` / `drawCircle`，**零第三方依赖**。
 * 两段弧长不等（110° / 96°）且转速不同（1150ms / 1700ms），
 * 否则看起来像「同一个圈转了两遍」。
 *
 * @param diameter 整体直径（dp）
 * @param stroke 描边宽度（dp）
 */
@Composable
private fun RingMark(diameter: Dp, stroke: Dp) {
    val t = rememberInfiniteTransition(label = "startup")
    val spin by t.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(1150, easing = LinearEasing)),
        label = "spin",
    )
    val counter by t.animateFloat(
        initialValue = 360f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(tween(1700, easing = LinearEasing)),
        label = "counter",
    )
    val breathe by t.animateFloat(
        initialValue = 0.66f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(880, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "breathe",
    )
    val primary = MaterialTheme.colorScheme.primary

    Canvas(Modifier.size(diameter)) {
        val w = stroke.toPx()
        val d = size.minDimension

        // 底环：给旋转弧一条「跑道」。没有它，两段弧像两只孤立的虫子在飘。
        drawCircle(color = primary.copy(alpha = 0.14f), radius = (d - w) / 2, style = Stroke(w))

        // 外弧
        rotate(spin) {
            drawArc(
                color = primary,
                startAngle = -90f,
                sweepAngle = 110f,
                useCenter = false,
                topLeft = Offset(w / 2, w / 2),
                size = Size(d - w, d - w),
                style = Stroke(width = w, cap = StrokeCap.Round),
            )
        }

        // 内弧：半径 0.58、透明度 0.55、反向 —— 两层不同速才有「在转」的感觉
        val inner = (d - w) * 0.58f
        val pad = (d - inner) / 2
        rotate(counter) {
            drawArc(
                color = primary.copy(alpha = 0.55f),
                startAngle = 0f,
                sweepAngle = 96f,
                useCenter = false,
                topLeft = Offset(pad, pad),
                size = Size(inner, inner),
                style = Stroke(width = w * 0.72f, cap = StrokeCap.Round),
            )
        }

        // 中心呼吸点：整个画面唯一的「心跳」，静止的话三层环会像一张静态图
        drawCircle(color = primary, radius = 3.4.dp.toPx() * breathe)
    }
}
