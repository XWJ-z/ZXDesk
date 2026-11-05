/*
 * ZXDesk工作台 Android 客户端
 * 文件：SettingsScreen.kt
 * 职责：设置页 —— 连接信息、账号切换、模式切换
 */

package com.zxdesk.app.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.store.Account
import com.zxdesk.app.store.SessionStore
import com.zxdesk.core.datasource.Entry
import com.zxdesk.core.datasource.EntryFlow

/**
 * 设置页（整屏，从抽屉底部「设置」进）。
 *
 * 三块，顺序即使用频率：
 * ① **连接信息** —— 现在连的是哪台设备、用哪个账号、走的哪条路（排障第一眼要看的都在这里）；
 * ② **账号** —— 切换 / 新增，复用既有的账号页，⛔ 不在这里另造一套列表；
 * ③ **模式** —— 当前只有「仅连接 NAS」可用，另两种照登录页的口径标「规划中」。
 *
 * @param entry 当前正在浏览的入口（地址、连接方式都从它读，⛔ 不另存一份）
 * @param currentKey 当前账号的键（地址 ＋ 账号），与账号页一致
 */
@Composable
internal fun SettingsScreen(
    entry: Entry,
    version: String,
    accounts: List<Account>,
    currentKey: String?,
    onSwitchAccount: () -> Unit,
    onAddAccount: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    // 账号名从本机会话快照读：`entry.fnSession` 不一定带用户名，而抽屉与账号页都读这份
    val account = remember(entry, context) { SessionStore(context).load()?.user.orEmpty() }
    val host = entry.relayHost
        ?: runCatching { Uri.parse(entry.baseUrl).host }.getOrNull()
        ?: entry.baseUrl
    val linkLabel = when {
        entry.relayHost != null -> "飞牛中继"
        entry.flow == EntryFlow.DIRECT -> "局域网直连"
        else -> "网关域名"
    }
    val transport = if (entry.cleartext) "HTTP" else "HTTPS"
    val currentAccount = accounts.firstOrNull { it.key == currentKey }

    BackHandler(onBack = onClose)

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("设置", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                SettingCard {
                    SettingTitle("连接信息")
                    InfoRow("地址", host)
                    SettingDivider()
                    InfoRow("连接方式", linkLabel)
                    SettingDivider()
                    InfoRow("账号", account.ifBlank { "未登录" })
                    SettingDivider()
                    InfoRow("传输", transport)
                    SettingDivider()
                    InfoRow("应用版本", version)
                }

                SettingCard {
                    SettingTitle("账号")
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                currentAccount?.user?.takeIf { it.isNotBlank() } ?: account.ifBlank { "当前账号" },
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Spacer(Modifier.height(2.dp))
                            Text(
                                currentAccount?.address ?: entry.baseUrl,
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Spacer(Modifier.width(10.dp))
                        Text(
                            "共 ${accounts.size} 个",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    PrimaryButton("切换账号", onSwitchAccount)
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = onAddAccount,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                    ) {
                        Text("新增账号", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    }
                }

                SettingCard {
                    SettingTitle("模式")
                    ModeRow("仅连接 NAS", state = ModeState.CURRENT)
                    SettingDivider()
                    ModeRow("仅本机", state = ModeState.PLANNED)
                    SettingDivider()
                    ModeRow("混合", state = ModeState.PLANNED)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "另两种模式还在规划中",
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** 白底圆角卡片：与帮助页同一套尺寸，间距 12dp。 */
@Composable
private fun SettingCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
            content = content,
        )
    }
}

@Composable
private fun SettingTitle(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

@Composable
private fun SettingDivider() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

/**
 * 「标签 —— 值」一行：标签固定宽度，值右对齐并允许省略。
 *
 * 固定标签列宽的理由：五行信息的值必须竖向对齐，否则地址一变长整列就歪。
 */
@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(76.dp),
        )
        Text(
            value,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private enum class ModeState { CURRENT, PLANNED }

/** 模式一行：当前项带实心圆点，规划项整行降一档并挂「规划中」。 */
@Composable
private fun ModeRow(text: String, state: ModeState) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(
                    color = if (state == ModeState.CURRENT) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.outlineVariant
                    },
                    shape = CircleShape,
                ),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text,
            fontSize = 14.sp,
            fontWeight = if (state == ModeState.CURRENT) FontWeight.Medium else FontWeight.Normal,
            color = if (state == ModeState.CURRENT) {
                MaterialTheme.colorScheme.onSurface
            } else {
                Ui.ButtonDisabledContent
            },
            modifier = Modifier.weight(1f),
        )
        when (state) {
            ModeState.CURRENT -> Text(
                "当前",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.primary,
            )
            ModeState.PLANNED -> Surface(
                shape = RoundedCornerShape(6.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Text(
                    "规划中",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
}
