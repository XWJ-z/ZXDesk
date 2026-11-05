/*
 * ZXDesk工作台 Android 客户端
 * 文件：NoticeScreen.kt
 * 职责：公告页，服务端 app_notice 的列表（整屏，从抽屉「更多」进）
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.NoticeUi
import com.zxdesk.core.update.Notice

/**
 * 公告（整屏，从抽屉「更多 → 公告」进）。
 *
 * 数据在服务端 `app_notice` 表（接口 `GET /api/notices/android`），本页只负责排版。
 *
 * ⭐ **进页面就算读过了**：用户已经看见列表，不必再点一次「朕已阅」——
 * 那个按钮是给「只想消掉弹窗、不想进页面」的人留的。
 *
 * 排版（0.2.18 第二版，老大 15:24 说「有点丑」）：
 * - 「上次更新」从卡片下面那行**孤零零的小字**并进顶栏副行（`N 条 · 上次更新 xx`）；
 * - 卡片去掉整圈红边（那看着像报错），重要公告改成标题前一个红点、日期行一个「重要」小字；
 * - 标题 16sp、正文 14sp/22sp，日期与正文之间加一条淡分割线，信息层次不再糊成一团。
 *
 * @param onRefresh 顶栏「刷新」：受 10 分钟窗口约束（见 `AppViewModel.refreshNotices`）
 * @param onReadAll 标记全部已读（进入本页时自动调一次）
 */
@Composable
internal fun NoticeScreen(
    state: NoticeUi,
    onRefresh: () -> Unit,
    onReadAll: () -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)

    // 看见列表 = 已读。key 用条数：接口刷新出新公告时再标一次
    LaunchedEffect(state.notices.size) {
        if (state.unreadCount > 0) onReadAll()
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("公告", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = onRefresh, enabled = !state.loading) {
                    Text(if (state.loading) "刷新中" else "刷新", fontSize = 14.sp)
                }
            }

            // 副行：条数 ＋ 上次更新时间。原来「上次更新」孤零零挂在卡片下面，
            // 一条公告时下半屏全空，看着像没做完 —— 并到顶栏下面就不空了。
            Text(
                buildString {
                    append(state.notices.size.toString()).append(" 条公告")
                    if (state.checkedAt > 0) {
                        append(" · 上次更新 ").append(noticeClock(state.checkedAt))
                    }
                },
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )

            state.error?.let { message ->
                Spacer(Modifier.height(6.dp))
                Text(
                    "刷新失败：$message",
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }

            Spacer(Modifier.height(10.dp))

            if (state.notices.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        if (state.loading) "正在获取公告…" else "暂无公告",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (!state.loading) {
                        Spacer(Modifier.height(4.dp))
                        TextButton(onClick = onRefresh) { Text("刷新", fontSize = 14.sp) }
                    }
                }
            } else {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    state.notices.forEach { notice -> NoticeCard(notice) }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        "公告由作者服务器下发，只推送消息，不收集你的数据",
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                        modifier = Modifier.padding(horizontal = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun NoticeCard(notice: Notice) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // 重要公告：标题前一个小红点。比整圈红边轻，不会看着像报错
                if (notice.important) {
                    Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.error, CircleShape))
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    notice.title,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
            }

            // 日期行：日期 ＋ 置顶 / 重要 两个小字（不再是色块，标题不会被挤窄）
            val date = noticeDate(notice.publishedAt)
            if (date != null || notice.pinned || notice.important) {
                Spacer(Modifier.height(5.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (date != null) {
                        Text(date, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (notice.pinned) {
                        Spacer(Modifier.width(8.dp))
                        Text("置顶", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
                    }
                    if (notice.important) {
                        Spacer(Modifier.width(8.dp))
                        Text("重要", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
            }

            if (notice.content.isNotBlank()) {
                Spacer(Modifier.height(10.dp))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Spacer(Modifier.height(10.dp))
                Text(
                    notice.content,
                    fontSize = 14.sp,
                    lineHeight = 22.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

/**
 * 只取日期部分（服务端给的是 ISO 时间串，如 `2026-10-28T12:00:00.000Z`）。
 *
 * 公告是「哪天发的」，精确到分没有意义，反而把标题挤窄。
 */
private fun noticeDate(raw: String?): String? {
    val text = raw?.trim().orEmpty()
    return if (text.length >= 10 && text[4] == '-' && text[7] == '-') text.take(10) else null
}

/** 上次更新时间，`MM-dd HH:mm`。 */
private fun noticeClock(at: Long): String =
    java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(at))
