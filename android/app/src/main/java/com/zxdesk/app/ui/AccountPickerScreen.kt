/*
 * ZXDesk工作台 Android 客户端
 * 文件：AccountPickerScreen.kt
 * 职责：切换账号的整屏界面，选择、删除、新增入口
 */

package com.zxdesk.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.store.Account

/**
 * 切换账号（整屏，不是弹窗）。
 *
 * 两个入口共用：登录页账号框右侧的切换图标、浏览页抽屉里的「切换账号」。
 * 点一行即选中；记住过密码的账号选完直接登录，不用再输（由调用方决定是否自动连）。
 *
 * @param accounts 已保存的账号（最近使用在前）
 * @param currentKey 当前正在用的账号键（`地址\u0001账号`），用于标「当前」
 * @param onPick 选中一个账号
 * @param onDelete 删除一个账号（含它记住的密码）
 * @param onAdd 去登录一个新账号（地址与账号留空）
 * @param onClose 返回
 */
@Composable
internal fun AccountPickerScreen(
    accounts: List<Account>,
    currentKey: String?,
    onPick: (Account) -> Unit,
    onDelete: (Account) -> Unit,
    onAdd: () -> Unit,
    onClose: () -> Unit,
    /**
     * 退出登录（0.2.17 起从抽屉搬到这里）。
     *
     * 为什么搬：抽屉底部只放「账户 / 设置 / 帮助」三列，账户那一列点开就是这一屏；
     * 退出是账户级动作，跟账号列表摆在一起比塞在抽屉里更不容易点错。
     */
    onLogout: (() -> Unit)? = null,
) {
    BackHandler(onBack = onClose)
    var pendingDelete by remember { mutableStateOf<Account?>(null) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("切换账号", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = onAdd) { Text("新增", fontSize = 15.sp) }
            }
            Text(
                "点一个账号直接登录，记住过密码的不用再输",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            if (accounts.isEmpty()) {
                EmptyAccounts(Modifier.weight(1f), onAdd = onAdd)
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(accounts, key = { it.key }) { account ->
                        AccountRow(
                            account = account,
                            current = account.key == currentKey,
                            onPick = { onPick(account) },
                            onDelete = { pendingDelete = account },
                        )
                    }
                }
            }

            // 「退出登录」：只给登录过的界面用（登录页的「切换」不带这个回调）
            onLogout?.let {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                TextButton(
                    onClick = it,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                ) {
                    Text("退出登录", fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }

    pendingDelete?.let { account ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除这个账号？", fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
            text = {
                Text(
                    "会同时删掉本机为它记住的密码，下次需要重新输入。",
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDelete(account)
                        pendingDelete = null
                    },
                ) { Text("删除", fontSize = 15.sp, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消", fontSize = 15.sp) }
            },
        )
    }
}

@Composable
private fun AccountRow(
    account: Account,
    current: Boolean,
    onPick: () -> Unit,
    onDelete: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onPick),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .height(30.dp)
                    .background(
                        color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                        shape = RoundedCornerShape(2.dp),
                    ),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        account.title,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (current) {
                        Spacer(Modifier.width(8.dp))
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = MaterialTheme.colorScheme.primaryContainer,
                            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        ) {
                            Text(
                                "当前",
                                fontSize = 11.sp,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    account.address,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onDelete) { Text("删除", fontSize = 13.sp) }
        }
    }
}

@Composable
private fun EmptyAccounts(modifier: Modifier = Modifier, onAdd: () -> Unit) {
    Box(modifier.fillMaxWidth().padding(horizontal = 32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
            Text("还没有保存的账号", fontSize = 15.sp)
            Spacer(Modifier.height(8.dp))
            Text(
                "在这台设备上登录成功一次，账号就会出现在这里",
                fontSize = 12.sp,
                lineHeight = 18.sp,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(20.dp))
            PrimaryButton(text = "新增账号", onClick = onAdd)
        }
    }
}
