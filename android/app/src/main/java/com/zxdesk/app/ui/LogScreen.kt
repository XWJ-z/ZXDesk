/*
 * ZXDesk工作台 Android 客户端
 * 文件：LogScreen.kt
 * 职责：日志页，查看、复制、清空本机日志
 */

package com.zxdesk.app.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.log.AppLog
import com.zxdesk.app.log.LogEntry
import com.zxdesk.app.log.LogLevel
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 日志（整屏，从抽屉进）。
 *
 * 数据源是 [AppLog]：内存里最多 600 条、磁盘留一份可滚动的文件。这里只做展示与两个动作
 * （复制 / 清空），⛔ 不做筛选与搜索 —— 手机上一屏能翻完的东西，加控件只会更难用。
 */
@Composable
internal fun LogScreen(onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    val entries by AppLog.entries.collectAsState()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var confirmClear by remember { mutableStateOf(false) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("日志", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(
                    onClick = {
                        val text = AppLog.asText()
                        if (text.isBlank()) {
                            Toast.makeText(context, "还没有日志", Toast.LENGTH_SHORT).show()
                        } else {
                            clipboard.setText(AnnotatedString(text))
                            Toast.makeText(context, "已复制全部日志", Toast.LENGTH_SHORT).show()
                        }
                    },
                ) { Text("复制", fontSize = 14.sp) }
                TextButton(onClick = { confirmClear = true }) { Text("清空", fontSize = 14.sp) }
            }
            Text(
                "最近 ${entries.size} 条 · 只存在本机",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            Spacer(Modifier.height(10.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            if (entries.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text("还没有日志", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    itemsIndexed(entries) { index, entry ->
                        // 跨天时插一条日期分隔：日志留着重开前的尾巴，不分组会看不出是哪天的
                        val previous = entries.getOrNull(index - 1)
                        if (previous == null || dayOf(previous.at) != dayOf(entry.at)) {
                            DayHeader(entry.at)
                        }
                        LogRow(entry)
                    }
                }
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清空日志？", fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
            text = { Text("会同时删掉本机保存的日志文件，清空后无法恢复。", fontSize = 14.sp, lineHeight = 20.sp) },
            confirmButton = {
                TextButton(
                    onClick = {
                        AppLog.clear()
                        confirmClear = false
                    },
                ) { Text("清空", fontSize = 15.sp, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text("取消", fontSize = 15.sp) }
            },
        )
    }
}

/**
 * 单条日志：`时间 级别 标签 正文`，一行起、正文可自然折行。
 *
 * ⚠️ 时间只到秒：带毫秒时 `HH:mm:ss.SSS` 在窄屏上会被挤成两行（毫秒单独掉下去），
 * 看起来像数据错位。标签压成浅色的前缀，正文才是主角。
 */
@Composable
private fun LogRow(entry: LogEntry) {
    val time = remember(entry.at) { timeFormat.format(Instant.ofEpochMilli(entry.at)) }
    val level = levelColor(entry.level)
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            time,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.width(54.dp),
        )
        Text(
            entry.level.name,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            color = level,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.width(12.dp),
        )
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp)) {
                    append(entry.tag)
                    append("  ")
                }
                withStyle(SpanStyle(color = level)) { append(entry.message) }
            },
            fontSize = 12.sp,
            lineHeight = 17.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.weight(1f),
        )
    }
}

/** 日期分隔：今天 / 昨天 / MM-dd。 */
@Composable
private fun DayHeader(at: Long) {
    val today = LocalDate.now()
    val day = dayOf(at)
    val text = when (day) {
        today -> "今天"
        today.minusDays(1) -> "昨天"
        else -> dayFormat.format(day)
    }
    Text(
        text,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
    )
}

/** 级别配色只用主题令牌：错误用 error、警告用 secondary、信息用正文色、调试用次要色。 */
@Composable
private fun levelColor(level: LogLevel): Color = when (level) {
    LogLevel.E -> MaterialTheme.colorScheme.error
    LogLevel.W -> MaterialTheme.colorScheme.secondary
    LogLevel.I -> MaterialTheme.colorScheme.onSurface
    LogLevel.D -> MaterialTheme.colorScheme.onSurfaceVariant
}

private val timeFormat: DateTimeFormatter =
    DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("MM-dd")

private fun dayOf(at: Long): LocalDate =
    Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).toLocalDate()
