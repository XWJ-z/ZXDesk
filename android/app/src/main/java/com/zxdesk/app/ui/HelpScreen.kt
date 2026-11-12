/*
 * ZXDesk工作台 Android 客户端
 * 文件：HelpScreen.kt
 * 职责：帮助页 —— 各端与更新、交流群、问题反馈、官网与源码
 */

package com.zxdesk.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zxdesk.app.Prefs
import com.zxdesk.app.R
import com.zxdesk.app.log.AppLog
import com.zxdesk.core.update.AllVersionsResult
import com.zxdesk.core.update.PreviousRelease
import com.zxdesk.core.update.UpdateClient
import com.zxdesk.core.update.UpdateUrls
import com.zxdesk.core.update.UrlCheck
import com.zxdesk.core.update.VERSION_PLATFORMS
import com.zxdesk.core.update.VersionCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 帮助页（整屏，从抽屉底部「帮助」进）。
 *
 * 内容与飞牛端的 `core/about.js` 同源（官网 / 开源地址 / 群与问卷二维码 / 各端口径），
 * ⛔ 不在壳里另写一份 —— 那边改了这边要跟着改。
 *
 * ⭐ 「各端与更新」的版本号**只在用户点「检查」时**才出网（许可协议 §四.2/3：
 *    除版本检查外不发起任何对外连接，且必须由人触发）。成功之后 10 分钟内再点只回一句话、不再请求。
 */
@Composable
internal fun HelpScreen(version: String, onClose: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()

    // ⭐ 上一次的结果**从落盘的缓存读**：10 分钟窗口会挡住重复请求，
    //    只在内存里放一份的话，重进这一页就只剩一排「—」（真机反馈 2026-11-02 11:51）。
    var versions by remember { mutableStateOf(VersionCache.decode(prefs.versionsCache)) }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    var checkedAt by remember { mutableStateOf(prefs.versionsCheckedAt) }

    BackHandler(onBack = onClose)

    /** 点「检查」：10 分钟额度内只提示不出网；额度外才真请求一次。 */
    fun check() {
        if (busy) return
        val now = System.currentTimeMillis()
        val passed = now - prefs.versionsCheckedAt
        // ⚠️ 只有**手里真有上一次的结果**时才拦：否则会出现「刚查过 → 请 10 分钟后再试 → 页面却一排—」
        //    的死角（真机反馈 2026-11-02 12:19）。没有结果就放它去查，拦截毫无意义。
        if (versions.isNotEmpty() && prefs.versionsCheckedAt > 0 && passed in 0 until VERSIONS_INTERVAL_MS) {
            Toast.makeText(context, "检测成功，请10分钟后再试", Toast.LENGTH_SHORT).show()
            return
        }
        busy = true
        failed = null
        // ⚠️ 接口必须带 channel，不带会被服务端 400（`invalid channel`）；
        //    ⛔ 别手工拼 `?channel=` —— 走 UpdateUrls 那套，非 https 也一并挡住。
        val target = UpdateUrls.withChannel(VERSIONS_API, "stable")
        if (target !is UrlCheck.Ok) {
            busy = false
            failed = (target as UrlCheck.Failed).reason
            return
        }
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                UpdateClient().fetchAllVersions(target.uri.toString())
            }
            busy = false
            when (result) {
                is AllVersionsResult.Ok -> {
                    // 先落盘，再从盘上读回来渲染 —— 界面与缓存永远同一份，避免「写了但没显示」
                    prefs.versionsCache = VersionCache.encode(result.versions)
                    prefs.versionsCheckedAt = System.currentTimeMillis()
                    versions = VersionCache.decode(prefs.versionsCache)
                    checkedAt = prefs.versionsCheckedAt
                    AppLog.i(TAG, "各端版本：${prefs.versionsCache}")
                }
                is AllVersionsResult.Failed -> {
                    failed = result.message
                    AppLog.w(TAG, "各端版本检查失败：" + result.message)
                }
            }
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) { Text("返回", fontSize = 15.sp) }
                Spacer(Modifier.width(4.dp))
                Text("帮助", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
                // 链接放最前（老大 2026-11-03 18:44：「最后的两个链接放到最前面」）——
                // 官网与源码是最常被点的两个入口，压在两张二维码下面要滚一屏才看得到。
                HelpCard {
                    HelpSectionTitle("链接")
                    LinkRow("项目官网", "功能介绍、使用教程与更新记录") { openUrl(context, LINKS_SITE) }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    LinkRow("开源地址", "GitHub · 源码、提交记录与 issue") { openUrl(context, LINKS_GITHUB) }
                }

                HelpCard {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        HelpSectionTitle("各端与更新", Modifier.weight(1f))
                        Text(
                            if (busy) "检查中" else "检查",
                            fontSize = 13.sp,
                            color = if (busy) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                MaterialTheme.colorScheme.primary
                            },
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable(enabled = !busy) { check() }
                                .padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                    }

                    VERSION_PLATFORMS.forEachIndexed { index, platform ->
                        if (index > 0) {
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        }
                        val release = versions[platform.key]
                        PlatformRow(
                            name = platform.label,
                            note = platform.note,
                            version = release?.version,
                            status = release?.status.orEmpty(),
                            previous = release?.previous,
                        )
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    // 鸿蒙不在 `/api/version` 的四端白名单里，所以正常情况下拿不到它的版本与状态。
                    // ⭐ 一旦服务端把 `harmonyos` 加进白名单，这里**不用改代码**就会显示（见 OPTIONAL_PLATFORMS）；
                    //    拿不到时才退回「— / 规划中」，⛔ 不编版本号。
                    //    ⚠️ 拿得到时状态**照服务端给**：它没配 status 就不显示徽章，
                    //    ⛔ 不要回落到「规划中」—— 有版本号却写「规划中」自相矛盾。
                    val harmony = versions["harmonyos"]
                    PlatformRow(
                        name = "鸿蒙",
                        note = "开发中，请耐心等待",
                        version = harmony?.version,
                        status = if (harmony == null) "规划中" else harmony.status,
                        previous = harmony?.previous,
                    )

                    Spacer(Modifier.height(8.dp))
                    Text(
                        when {
                            failed != null -> "检查失败：$failed"
                            // ⚠️ 有检查时间就写出来（哪怕一行版本号都没有）——
                            //    「查过但没结果」与「从没查过」是两种故障，界面必须分得开
                            checkedAt > 0 ->
                                "上次检查 ${SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(checkedAt))}"
                            else -> "点「检查」获取各端最新版本"
                        },
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = if (failed != null) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }

                HelpCard {
                    HelpSectionTitle("域名解析")
                    Text(
                        "系统解析失败时，会用公共 DNS over HTTPS 再查一次 IP，" +
                            "只查目标域名，不上传其它内容。",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                HelpCard {
                    HelpSectionTitle("交流群")
                    Text(
                        "欢迎加入QQ群交流与反馈！有问题联系任意管理员咨询哦！",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    QrFigure(
                        resId = R.drawable.qr_community,
                        caption = "ZXDesk工作台交流群 · $GROUP_NO",
                        description = "ZXDesk工作台交流群二维码",
                    )
                }

                HelpCard {
                    HelpSectionTitle("问题反馈")
                    Text(
                        "使用遇到问题 或者 有想要的功能，可以扫码填写哦，留下你的联系方式方便我们与您联系！",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    QrFigure(
                        resId = R.drawable.qr_form,
                        caption = "问题收集表",
                        description = "问题收集表二维码",
                    )
                }

                Text(
                    "ZXDesk $version",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }
    }
}

/** 白底圆角卡片：帮助页的每一块都用它，间距统一 12dp。 */
@Composable
private fun HelpCard(content: @Composable ColumnScope.() -> Unit) {
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
private fun HelpSectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(bottom = 8.dp),
    )
}

/**
 * 一个端的一行：**三列对齐** —— 名称（左）｜版本号（固定 72dp、右对齐）｜状态徽章（固定 52dp、右对齐）。
 *
 * ⚠️ 说明文字住在名称那一列的第二行，⛔ 不另起一列 —— 它长短不一，一进列就会把三列顶歪。
 *
 * @param status 由服务端下发（`app_version.status`）。**空 = 服务端没配 ⇒ 不显示徽章**，
 *               ⛔ 不要在这里补一个默认值 —— 编出来的状态比空着更误导。
 * @param previous 上一个不同版本的摘要。**只在当前这版还拿不到时才显示**（见下）——
 *                 一个端可能同时在售两个版本：0.9.7 在审核、0.9.6 已上线，
 *                 只写「0.9.7 审核中」用户不知道现在能装什么。
 */
@Composable
private fun PlatformRow(
    name: String,
    note: String,
    version: String?,
    status: String,
    previous: PreviousRelease? = null,
) {
    // 当前版可用（已上线 / 可用 / 内测）⇒ 用户直接装最新版就行，再标上一版是噪音；
    // 当前版拿不到（审核中 / 规划中 / 状态未知）⇒ 补一行「上一版 0.9.6 · 已上线」，
    // 让人知道退而求其次能装哪个。
    val previousRelease = previous?.takeIf { !statusIsOnline(status) }
    val previousText = previousRelease?.let {
        "上一版 ${it.version}" + if (it.status.isNotBlank()) " · ${it.status}" else ""
    }
    // 上一版自己也拿不到（比如连着两版都在审）时不能染绿 —— 绿色在这里的意思是「能装」。
    val previousUsable = previousRelease != null && statusIsOnline(previousRelease.status)

    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp))
            Text(
                note,
                fontSize = 11.sp,
                lineHeight = 15.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (previousText != null) {
                Spacer(Modifier.height(2.dp))
                Text(
                    previousText,
                    fontSize = 11.sp,
                    lineHeight = 15.sp,
                    // 绿 = 现在能装这个（上一版已上线/可用）；它自己也在审就还是灰的
                    color = if (previousUsable) {
                        Ui.PreviousOnline
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f)
                    },
                )
            }
        }
        Text(
            version ?: "—",
            fontSize = 13.sp,
            fontWeight = if (version != null) FontWeight.Medium else FontWeight.Normal,
            color = if (version != null) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            textAlign = TextAlign.End,
            modifier = Modifier.width(72.dp),
        )
        Spacer(Modifier.width(10.dp))
        Box(Modifier.width(52.dp), contentAlignment = Alignment.CenterEnd) {
            if (status.isNotBlank()) StateBadge(status)
        }
    }
}

/**
 * 状态徽章：「已上线 / 可用 / 内测」走品牌浅底，其余（审核中 / 规划中 / 已下架…）走中性灰。
 *
 * ⚠️ 宽度固定 52dp、单行省略：状态文案由库里的 `app_version.status` 决定，
 *    建议写 2~4 个字（已上线 / 审核中 / 可用 / 规划中），太长会在这里被截。
 */
@Composable
private fun StateBadge(status: String) {
    val online = statusIsOnline(status)
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = if (online) Ui.BadgeContainer else MaterialTheme.colorScheme.surfaceVariant,
        contentColor = if (online) Ui.BadgeContent else MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Text(
            status,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/**
 * 徽章配色：只看文案里的关键词，**这不是业务判据**。
 *
 * 服务端以后加「内测中」「已下架」这类新状态时，最坏结果只是配色变灰，
 * 文案本身照常显示 —— ⛔ 不要为了配色在这里维护一张状态白名单，
 * 那张表一旦和服务端不同步，就会出现「审核中」被染成可用色的错。
 */
private fun statusIsOnline(status: String): Boolean =
    status.contains("上线") || status.contains("可用") ||
        status.contains("内测") || status.contains("测试")

/**
 * 二维码图 ＋ 图注。
 *
 * ⚠️ 群卡片是竖长的、问卷是方的（480×853 / 480×617），⛔ 不要并排 ——
 *    并排会把竖的那张压成一条缝，扫不出来（前端 `about.js` 记过同一条）。
 */
@Composable
private fun QrFigure(resId: Int, caption: String, description: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(resId),
            contentDescription = description,
            modifier = Modifier.width(172.dp).clip(RoundedCornerShape(10.dp)),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            caption,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

/** 一行外链：标题 ＋ 一句说明 ＋ 右侧 ↗。 */
@Composable
private fun LinkRow(title: String, note: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp))
            Text(note, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("↗", fontSize = 16.sp, color = MaterialTheme.colorScheme.primary)
    }
}

private fun openUrl(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

/** 交流群群号（与二维码是同一件事的两种入口，取自前端 `about.js`）。 */
private const val GROUP_NO = "793792797"

/** 日志标签（与其它屏同一套命名：类名）。 */
private const val TAG = "HelpScreen"

/** 各端版本接口：**不带平台**才一次给全四端。 */
private const val VERSIONS_API = "https://api.zxdesk.xwjznh.cn/api/version"

/** 成功之后的重复点击窗口：10 分钟内只提示、不再出网。 */
private const val VERSIONS_INTERVAL_MS = 10 * 60 * 1000L

// 公开地址：与 fnOS 前端 `core/about.js` 的 LINKS 同源，改地址要一起改
private const val LINKS_SITE = "https://zxdesk.xwjznh.cn/"
private const val LINKS_GITHUB = "https://github.com/XWJ-z/ZXDesk"
