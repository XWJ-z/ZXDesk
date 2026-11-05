/*
 * ZXDesk工作台 Android 客户端
 * 文件：ReleasesScreen.kt
 * 职责：更新日志页，按版本倒序列出本端每个版本做了什么
 */

package com.zxdesk.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 更新日志（整屏，从抽屉「更多」进）。
 *
 * 数据在 [ANDROID_RELEASES]，⛔ 页面里不写死条目 —— 每次发版只改那一份数据。
 *
 * ⭐ 0.2.18：服务端下发的**最新版说明**也显示在这一页顶部（原先是抽屉升级卡下面的
 * 「查看更新说明」小字，老大要求移出）。[latestNotes] 为空时这块不出现。
 *
 * @param version 本机装着的版本；与某条对上时挂「当前版本」，让人一眼知道自己停在哪
 * @param latest 服务端最新版号（`updateState.latest`），可与 [latestNotes] 一起为空
 * @param latestNotes 服务端清单里的 `notes`（本版更新说明原文）
 */
@Composable
internal fun ReleasesScreen(
    version: String,
    latest: String? = null,
    latestNotes: String = "",
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("更新日志", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            }
            Text(
                "当前版本 $version",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            if (latestNotes.isNotBlank()) {
                Spacer(Modifier.height(10.dp))
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                ) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                        Text(
                            buildString {
                                append("服务端最新版")
                                latest?.takeIf { it.isNotBlank() }?.let { append(" $it") }
                                append(" 的说明")
                            },
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            latestNotes,
                            fontSize = 13.sp,
                            lineHeight = 20.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
            Spacer(Modifier.height(12.dp))

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                ANDROID_RELEASES.forEach { release ->
                    ReleaseCard(release, current = release.version == version)
                }
            }
        }
    }
}

@Composable
private fun ReleaseCard(release: ReleaseNote, current: Boolean) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    release.version,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    release.date,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                if (current) {
                    Surface(shape = RoundedCornerShape(6.dp), color = Ui.BadgeContainer, contentColor = Ui.BadgeContent) {
                        Text(
                            "当前版本",
                            fontSize = 10.sp,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            release.items.forEach { item ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                    Box(
                        modifier = Modifier
                            .padding(top = 8.dp)
                            .size(4.dp)
                            .background(MaterialTheme.colorScheme.primary, CircleShape),
                    )
                    Spacer(Modifier.width(9.dp))
                    Text(
                        item,
                        fontSize = 13.sp,
                        lineHeight = 20.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}
