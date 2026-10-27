package com.zxdesk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * 首次启动的许可协议弹窗：**不勾选就进不去**。
 *
 * 与安装向导里的许可页同一套口径：没有「稍后再说」，只有「同意并继续」或「不同意并退出」。
 * 返回键与点击外部都不关闭 —— 否则等于提供了一个不表态的出口。
 */
@Composable
internal fun EulaGate(text: String, onAccept: () -> Unit, onDecline: () -> Unit) {
    var agreed by remember { mutableStateOf(false) }
    Dialog(
        onDismissRequest = {},
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
        ),
    ) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
                Text("许可协议", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "ZXDesk 工作台 · Android 版",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                EulaBody(text, Modifier.weight(1f))

                Spacer(Modifier.height(12.dp))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Spacer(Modifier.height(8.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .toggleable(value = agreed, role = Role.Checkbox, onValueChange = { agreed = it }),
                ) {
                    // 整行可点：只让那个 20dp 的方框认点击，手指很难按准
                    Checkbox(checked = agreed, onCheckedChange = null)
                    Text("我已阅读并同意上述许可协议", fontSize = 14.sp, modifier = Modifier.padding(start = 8.dp))
                }

                Spacer(Modifier.height(8.dp))
                PrimaryButton(text = "同意并继续", enabled = agreed, onClick = onAccept)
                TextButton(onClick = onDecline, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "不同意并退出",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** 从抽屉里查看协议：只读，不勾选，随时可关。 */
@Composable
internal fun EulaViewer(text: String, onClose: () -> Unit) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text("许可协议", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "ZXDesk 工作台 · Android 版",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = onClose) { Text("关闭", fontSize = 14.sp) }
                }
                Spacer(Modifier.height(12.dp))
                EulaBody(text, Modifier.weight(1f))
            }
        }
    }
}

/**
 * 协议正文。正文是纯文本（唯一来源 `assets/eula.txt`）：
 * 首行是标题、第二行是版本与生效日期，其后按空行分段；
 * 「一、」「二、」这类章节行加粗，其余按正文排。
 */
@Composable
private fun EulaBody(text: String, modifier: Modifier = Modifier) {
    val lines = remember(text) { text.lines() }
    val title = lines.firstOrNull().orEmpty().trim()
    val meta = lines.getOrNull(1).orEmpty().trim()
    val paragraphs = remember(text) {
        lines.drop(2).joinToString("\n").split(Regex("\\n\\s*\\n"))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    }

    Column(
        modifier = modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (text.isBlank()) {
            HintLine("读不到协议正文。请重新安装应用，或到项目官网查看许可条款。")
            return@Column
        }
        Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
        if (meta.isNotEmpty()) {
            Text(meta, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, lineHeight = 16.sp)
        }
        paragraphs.forEach { paragraph ->
            Text(
                paragraph,
                fontSize = if (isSectionHeading(paragraph)) 14.sp else 13.sp,
                fontWeight = if (isSectionHeading(paragraph)) FontWeight.SemiBold else FontWeight.Normal,
                lineHeight = if (isSectionHeading(paragraph)) 22.sp else 21.sp,
                color = if (isSectionHeading(paragraph)) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

private val SECTION_RE = Regex("^[一二三四五六七八九十]+、")

private fun isSectionHeading(paragraph: String): Boolean = SECTION_RE.containsMatchIn(paragraph)
