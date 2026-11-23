/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.R

/**
 * 打赏与支持（整屏，从抽屉「更多」进）。
 *
 */
@Composable
internal fun DonateScreen(onClose: () -> Unit) {
    BackHandler(onBack = onClose)

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("打赏与支持", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
                DonateCard {
                    Text(
                        "ZXDesk 是业余时间做的，永久免费、没有广告。",
                        fontSize = 14.sp,
                        lineHeight = 21.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "觉得顺手可以随意打赏，不打赏也一样用，功能一点不少。",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                DonateCard {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        QrColumn(
                            resId = R.drawable.qr_alipay,
                            label = "支付宝",
                            description = "支付宝收款码",
                            modifier = Modifier.weight(1f),
                        )
                        QrColumn(
                            resId = R.drawable.qr_wechat,
                            label = "微信支付",
                            description = "微信支付收款码",
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "用支付宝或微信扫对应的码即可。",
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Text(
                    "谢谢每一位愿意支持的人",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun DonateCard(content: @Composable ColumnScope.() -> Unit) {
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

/**
 * 一张收款码：图在上、名字在下。
 * @param modifier 由外部给 `weight`，两张码才能等宽
 */
@Composable
private fun QrColumn(
    resId: Int,
    label: String,
    description: String,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Image(
            painter = painterResource(resId),
            contentDescription = description,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth().height(190.dp),
        )
        Spacer(Modifier.height(6.dp))
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}
