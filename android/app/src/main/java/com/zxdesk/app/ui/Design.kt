/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.R

/**
 * 统一设计语言（色板与 tokens.css 同源）。
 *
 */
internal object Ui {
    /** 内容最宽 420dp：再宽在平板上会散架。 */
    val MaxWidth = 420.dp

    /** 左右边距。 */
    val Gutter = 24.dp

    /** 元素间距（8dp 网格的 2 格）。 */
    val Gap = 16.dp

    /** 主按钮高度：手指按得准（52dp）。 */
    val ButtonHeight = 52.dp

    /** 主按钮圆角。 */
    val ButtonRadius = 16.dp

    /** 输入框圆角。 */
    val FieldRadius = 14.dp

    /** 卡片圆角。 */
    val Radius = 12.dp

    val TitleSize = 26.sp
    val BodySize = 14.sp
    val InputSize = 16.sp

    // ---- 组件级色常量（没进 colorScheme 的那几颗）----
    val FieldUnfocused = Color(0xFFF1F4F9)      // 输入框未聚焦底
    val ButtonDisabledContainer = Color(0xFFE8EAF6)
    val ButtonDisabledContent = Color(0xFF7C86A8)
    val SwitchUnselectedTrack = Color(0xFFDDE3EC)
    val BadgeContainer = Color(0xFFEEF2FF)      // 胶囊徽标底（FNID/IP/域名、选中卡片）
    val BadgeContent = Color(0xFF4338CA)        // 胶囊徽标字

    // ---- 抽屉（侧边栏）专用：见 R-212 ----
    /** 普通项文字：比 onSurface 浅一档，对白底仍在 9:1 以上 —— 降了层级但依然清晰。 */
    val DrawerItemText = Color(0xFF39414F)

    /**
     * 「上一版可用」的强调绿（帮助页那一行小字）。
     *
     */
    val PreviousOnline = Color(0xFF15803D)
}

/**
 * 四步共用的页面容器：
 * **固定顶栏 + 内容垂直居中**，内容比屏幕高时自动转为可滚动（不会被切）。
 */
@Composable
internal fun StepPage(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        if (onBack != null) {
            Box(Modifier.fillMaxWidth().height(48.dp)) {
                TextButton(
                    onClick = onBack,
                    modifier = Modifier
                        .align(Alignment.CenterStart)
                        .padding(start = 8.dp)
                        .height(48.dp),
                ) { Text("‹ 返回", fontSize = Ui.BodySize) }
            }
        }
        BoxWithConstraints(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentAlignment = Alignment.TopCenter,
        ) {
            val viewport = maxHeight
            Column(
                modifier = Modifier
                    .widthIn(max = Ui.MaxWidth)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport) // 撑到至少一屏 ⇒ 短内容才居得起来；超屏自然滚
                    .padding(horizontal = Ui.Gutter)
                    .padding(vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(Ui.Gap, Alignment.CenterVertically),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // 品牌行：图标 ＋ 标题同一排（所有走 StepPage 的屏统一）
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        BrandMark()
                        Text(
                            title,
                            fontSize = Ui.TitleSize,
                            lineHeight = 32.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    subtitle?.let {
                        Text(
                            it,
                            fontSize = Ui.BodySize,
                            lineHeight = 20.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                content()
            }
        }
    }
}

/** 品牌头：44dp，直接用桌面图标那张图（`drawable-<dpi>/ic_brand.png`），⛔ 不自绘「ZX」方块。 */
@Composable
private fun BrandMark() {
    Image(
        painter = painterResource(R.drawable.ic_brand),
        contentDescription = null,
        modifier = Modifier.size(44.dp),
    )
}

/** 主按钮：整宽、52dp、16dp 圆角、primary 实心白字；禁用灰底灰字；[busy] 时转圈。 */
@Composable
internal fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = RoundedCornerShape(Ui.ButtonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
            disabledContainerColor = Ui.ButtonDisabledContainer,
            disabledContentColor = Ui.ButtonDisabledContent,
        ),
        modifier = Modifier.fillMaxWidth().height(Ui.ButtonHeight),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = LocalContentColor.current,
            )
            Spacer(Modifier.size(8.dp))
        }
        Text(text, fontSize = Ui.InputSize, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * 填充式输入框：标签 13sp/600 放框**上方**；未聚焦底 #F1F4F9、
 * 聚焦白底 + 1.5dp primary 边、圆角 14dp；占位 16sp 同色 60%。
 */
@Composable
internal fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    placeholder: String? = null,
    trailing: @Composable (() -> Unit)? = null,
    supporting: String? = null,
    isError: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    textStyle: TextStyle = TextStyle(fontSize = Ui.InputSize),
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(Ui.FieldRadius)
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = placeholder?.let {
                {
                    // 占位符是**示例**，不是内容：比输入文字（16sp）小两档，且强制单行。
                    // 旧版按 16sp 铺开，地址框那条示例会折成两行
                    // 输入框里出现两行示例很难看。宽度不够时尾部省略，⛔ 不换行。
                    Text(
                        it,
                        fontSize = 12.sp,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                }
            },
            singleLine = true,
            enabled = enabled,
            isError = isError,
            textStyle = textStyle,
            visualTransformation = visualTransformation,
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
            trailingIcon = trailing,
            interactionSource = interaction,
            shape = shape,
            colors = TextFieldDefaults.colors(
                focusedContainerColor = MaterialTheme.colorScheme.surface,
                unfocusedContainerColor = Ui.FieldUnfocused,
                disabledContainerColor = Ui.FieldUnfocused,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
                errorIndicatorColor = Color.Transparent,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (focused) {
                        Modifier.border(1.5.dp, MaterialTheme.colorScheme.primary, shape)
                    } else {
                        Modifier
                    },
                ),
        )
        supporting?.let { Text(it, fontSize = Ui.BodySize, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/**
 * 一行小字 + 右侧开关：选中轨道 primary、未选 #DDE3EC、thumb 白。
 *
 */
@Composable
internal fun InlineSwitchRow(
    text: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
    supporting: String? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(vertical = 4.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text,
                fontSize = Ui.BodySize,
                color = if (enabled) LocalContentColor.current else Ui.ButtonDisabledContent,
            )
            supporting?.let {
                Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = null,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedTrackColor = MaterialTheme.colorScheme.primary,
                uncheckedTrackColor = Ui.SwitchUnselectedTrack,
                checkedThumbColor = Color.White,
                uncheckedThumbColor = Color.White,
                uncheckedBorderColor = MaterialTheme.colorScheme.outline,
                disabledCheckedTrackColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.35f),
                disabledUncheckedTrackColor = Ui.SwitchUnselectedTrack,
                disabledCheckedThumbColor = Color.White,
                disabledUncheckedThumbColor = Color.White,
            ),
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/**
 * 模式卡片（第 ① 步用）。
 * 选中 = `primary` 描边 1.5dp + #EEF2FF 底；未选 = 白底 + outlineVariant 描边 1dp。
 */
@Composable
internal fun ModeCard(
    title: String,
    desc: String,
    selected: Boolean,
    planned: Boolean,
    onClick: () -> Unit,
) {
    val border = when {
        selected -> BorderStroke(1.5.dp, MaterialTheme.colorScheme.primary)
        else -> BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
    }
    val container = if (selected) Ui.BadgeContainer else MaterialTheme.colorScheme.surface
    val content = when {
        selected -> Ui.BadgeContent
        planned -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurface
    }
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Ui.Radius),
        color = container,
        contentColor = content,
        border = border,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, fontSize = Ui.InputSize, fontWeight = FontWeight.Medium)
                Text(desc, fontSize = 12.sp, color = content.copy(alpha = 0.75f))
            }
            if (planned) PlannedBadge()
            else if (selected) SelectedDot()
        }
    }
}

/** 右上角「规划中」小标签（中性色，不抢强调色）。 */
@Composable
private fun PlannedBadge() {
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Text(
            "规划中",
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/** 选中标记：一个实心小圆点，比打勾更安静。 */
@Composable
private fun SelectedDot() {
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.size(10.dp),
    ) {}
}

/** 就地错误（红色一行，紧跟出错的控件）。 */
@Composable
internal fun ErrorLine(text: String?) {
    if (text.isNullOrBlank()) return
    Text(text, fontSize = Ui.BodySize, color = MaterialTheme.colorScheme.error)
}

/** 中性提示（一行小字）。 */
@Composable
internal fun HintLine(text: String?, color: Color = Color.Unspecified) {
    if (text.isNullOrBlank()) return
    Text(
        text,
        fontSize = Ui.BodySize,
        lineHeight = 20.sp,
        color = if (color == Color.Unspecified) MaterialTheme.colorScheme.onSurfaceVariant else color,
    )
}
