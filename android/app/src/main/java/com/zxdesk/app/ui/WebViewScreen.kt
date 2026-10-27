package com.zxdesk.app.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.widget.Toast
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.zxdesk.app.Eula
import com.zxdesk.app.Prefs
import com.zxdesk.app.store.SessionStore
import com.zxdesk.app.update.UpdatePhase
import com.zxdesk.app.update.UpdateState
import com.zxdesk.core.connection.FnPortal
import com.zxdesk.core.connection.GatewayPage
import com.zxdesk.core.connection.GatewaySessionProbe
import com.zxdesk.core.datasource.Entry
import com.zxdesk.core.datasource.EntryFlow
import com.zxdesk.core.tls.TlsPolicy
import com.zxdesk.core.tls.TofuRecord
import com.zxdesk.core.tls.TrustDecision
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest
import java.util.Locale

/**
 * WebView 壳。入口三条路，⛔ 别混：
 *
 * - **直连 8990**（[EntryFlow.DIRECT]）：直接加载 `/app/zxdesk/login.html`，不需要飞牛登录；
 * - **FNID 中继**（[Entry.portalUrl] 非空）：**先进官方门户 `https://fnos.net/<fnid>/` 登录飞牛**，
 *   门户登录完会跳到 `<fnid>.fnos.net`，这时换成 ZXDesk 登录页。
 *   ⚠️ 0.2.0 直接加载中继根是错的 —— 那是 NAS 桌面 SPA 的空壳，未登录只有灰屏；
 * - **域名 / 网关**（[EntryFlow.GATEWAY] 且无门户）：站点根就是飞牛登录页，
 *   轮询「`/app/zxdesk/login.html` 是否已返回 HTML」判断登录完成。
 *
 * 顶栏已删（AND-008 §五）：连接操作住左滑抽屉 —— 左边缘 20dp 热区右滑打开，
 * `gesturesEnabled = false` 让手势只认我们自己的热区，⛔ 不吃网页里的横滑。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewScreen(
    entry: Entry,
    onExit: () -> Unit,
    /** 带会话进来却仍被判 `invalid token`：交给上层用 longToken 换新会话（⛔ 别在这里自己重登）。 */
    onSessionExpired: () -> Unit = {},
    /** 页面其实是网关的「访问码」页：回第 ④ 步让用户输入（⛔ 别让人对着空白页猜）。 */
    onAccessCodeRequired: () -> Unit = {},
    /** 抽屉「退出登录」：清 SavedSession ＋ 记住的密码，回第 ② 步。 */
    onLogout: () -> Unit = {},
    /** 进应用时要提示一句（例如「已改用局域网直连」），一闪而过，不挡操作。 */
    notice: String? = null,
    /** 版本与更新的全部状态（检查 / 下载 / 已下载）。 */
    updateState: UpdateState,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val portalMode = entry.portalUrl != null && entry.fnSession == null

    var webView by remember { mutableStateOf<WebView?>(null) }
    var stage by remember { mutableStateOf<Stage>(Stage.Loading) }
    // 已经有原生 WS 会话 ⇒ 直接进 ZXDesk，不走门户、不轮询
    var arrived by remember { mutableStateOf(entry.fnSession != null) }
    var waitingGateway by remember { mutableStateOf(entry.flow == EntryFlow.GATEWAY && !portalMode) }
    var slowFallback by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    val trustQueue = remember { mutableStateListOf<PendingTrust>() }

    // 页面里 `<input type="file">` 的选择结果往哪交（聊天发图、协作传附件）。
    // ⚠️ 用户取消 / 选空时必须回 null，⛔ 不能回空数组 —— 回空数组会让页面以为「选了个空文件」。
    val filePathCallback = remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        filePathCallback.value?.onReceiveValue(uri?.let { arrayOf(it) })
        filePathCallback.value = null
    }
    val filePickerMulti =
        rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
            filePathCallback.value?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            filePathCallback.value = null
        }

    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // 原生 WS 登录的收尾告警（ticket 换到几条 Cookie / entry-token 失败）—— 一闪而过的一行字，
    // 让用户在「还是 invalid token」时能截图给开发看，而不是只有一句「进不去」。
    LaunchedEffect(entry.fnSession?.note) {
        val note = entry.fnSession?.note ?: return@LaunchedEffect
        Toast.makeText(context, note, Toast.LENGTH_LONG).show()
    }

    LaunchedEffect(notice) {
        if (!notice.isNullOrBlank()) Toast.makeText(context, notice, Toast.LENGTH_LONG).show()
    }

    // 首次进浏览页提示一次左滑手势（§5.4），之后不再提示
    LaunchedEffect(Unit) {
        if (!prefs.drawerHintShown) {
            prefs.drawerHintShown = true
            Toast.makeText(context, "从左边缘右滑可打开连接面板", Toast.LENGTH_LONG).show()
        }
    }

    /** 已经到了 ZXDesk 的页面（不管是门户跳过来的还是用户自己点到的）⇒ 停掉轮询、收起横幅。 */
    val markArrived: () -> Unit = {
        arrived = true
        waitingGateway = false
        slowFallback = false
    }

    /** 无条件跳 ZXDesk 登录页（兜底按钮用：用户点了就得跳，不管状态）。 */
    val goToZxDesk: () -> Unit = {
        markArrived()
        // 门户正常会自己种 mode=relay；这里补一次作兜底（同 key 覆盖，无害）
        CookieManager.getInstance().setCookie(entry.baseUrl, RELAY_COOKIE)
        CookieManager.getInstance().flush()
        webView?.loadUrl(entry.zxDeskLoginUrl)
    }

    /** 自动跳：已经进去过就不重复跳，免得把用户从主界面踢回登录页。 */
    val enterZxDesk: () -> Unit = { if (!arrived) goToZxDesk() }

    /** 返回键优先级（§5.3）：抽屉开 → 关抽屉；网页可回退 → 网页后退；否则 → 退出应用。 */
    BackHandler {
        if (drawerState.isOpen) {
            scope.launch { drawerState.close() }
            return@BackHandler
        }
        val view = webView
        if (view != null && view.canGoBack()) {
            view.goBack()
        } else {
            (context as? Activity)?.finish()
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        // 手势只认左边缘那条 20dp 热区；默认手势会吃掉网页里的横滑操作
        gesturesEnabled = false,
        scrimColor = MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f),
        drawerContent = {
            ModalDrawerSheet(
                drawerShape = RoundedCornerShape(topEnd = 20.dp, bottomEnd = 20.dp),
                drawerContainerColor = MaterialTheme.colorScheme.surface,
                modifier = Modifier.width(DrawerWidth),
            ) {
                ConnectionDrawer(
                    entry = entry,
                    version = versionLabel(context),
                    updateState = updateState,
                    onRefresh = {
                        scope.launch { drawerState.close() }
                        webView?.reload()
                    },
                    onChangeAddress = {
                        scope.launch { drawerState.close() }
                        onExit()
                    },
                    onLogout = {
                        scope.launch { drawerState.close() }
                        onLogout()
                    },
                    onCheckUpdate = onCheckUpdate,
                    onDownloadUpdate = onDownloadUpdate,
                    onInstallUpdate = onInstallUpdate,
                    onClose = { scope.launch { drawerState.close() } },
                )
            }
        },
    ) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Box(Modifier.fillMaxWidth().weight(1f)) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            // false ⇒ 页面里 target=_blank 的链接在本 WebView 内打开（门户里有这种链接）
                            settings.setSupportMultipleWindows(false)
                            CookieManager.getInstance().setAcceptCookie(true)
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

                            webChromeClient = object : WebChromeClient() {
                                // supportMultipleWindows=false 时不会被调用；显式声明意图，别改成开新窗
                                override fun onCreateWindow(
                                    view: WebView,
                                    isDialog: Boolean,
                                    isUserGesture: Boolean,
                                    resultMsg: Message,
                                ): Boolean = false

                                /**
                                 * 功能：让页面里的 `<input type="file">`（聊天发图、协作传附件）弹出系统选择器。
                                 *
                                 * 说明：⛔ 不能省 —— 默认实现返回 false，等于告诉 WebView「我不处理」，
                                 *    页面点下去**不报错也无反应**。返回 true 才是「我接管了」。
                                 *    `params.mode == MODE_OPEN_MULTIPLE` 决定单选还是多选；`accept` 串会折成选择器认得的 MIME（见下）。
                                 */
                                override fun onShowFileChooser(
                                    view: WebView,
                                    callback: ValueCallback<Array<Uri>>,
                                    params: FileChooserParams?,
                                ): Boolean {
                                    // 上一次的 callback 先结算：不结算的话前一次的选择器一直挂着，这一次拿不到结果
                                    filePathCallback.value?.onReceiveValue(null)
                                    filePathCallback.value = callback
                                    return try {
                                        // accept 串折成选择器认得的 MIME：同一大类用 image/*，否则取第一个
                                        // （原样传 image/png,image/jpeg,… 会让图库大部分照片变灰选不了）
                                        val mime = params?.acceptTypes?.let { types ->
                                            val list = types.map { it.trim().lowercase(Locale.ROOT) }
                                                .filter { it.isNotEmpty() }
                                            val mimes = list.filter { it.contains('/') }
                                            val heads = mimes.map { it.substringBefore('/') }.distinct()
                                            when {
                                                list.isEmpty() || list.contains("*/*") -> "*/*"
                                                mimes.isEmpty() -> "*/*"
                                                heads.size == 1 -> heads[0] + "/*"
                                                else -> mimes.first()
                                            }
                                        } ?: "*/*"
                                        if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                                            filePickerMulti.launch(mime)
                                        } else {
                                            filePicker.launch(mime)
                                        }
                                        true
                                    } catch (e: Exception) {
                                        // 选择器拉不起来 ⇒ 把 callback 还回去，让页面知道「没选」
                                        filePathCallback.value = null
                                        false
                                    }
                                }
                            }

                            webViewClient = buildClient(
                                entry = entry,
                                prefs = prefs,
                                onSessionExpired = onSessionExpired,
                                onAccessCodeRequired = onAccessCodeRequired,
                                onStage = { stage = it },
                                onAskTrust = { trustQueue.add(it) },
                                onMainFrame = { url ->
                                    when {
                                        // 已经到 ZXDesk 的页面了（门户可能直接跳到 /app/zxdesk/）
                                        entry.flow == EntryFlow.GATEWAY &&
                                            url != null && url.contains(entry.gatewayPath) -> markArrived()
                                        // 门户登录完跳到中继主机，但落点不是 ZXDesk ⇒ 换成登录页
                                        portalMode -> handleMainFrame(entry, url, arrived) { enterZxDesk() }
                                    }
                                },
                                onExternal = { url -> openExternally(ctx, url) },
                            )

                            // 原生 WS 登录（0.2.2）：直接种会话，⛔ 不经门户、⛔ 不等 Trim-MC-token
                            entry.fnSession?.let { session ->
                                if (entry.relayHost != null) {
                                    CookieManager.getInstance().setCookie(entry.baseUrl, RELAY_COOKIE)
                                }
                                session.cookies(entry.relayHost).forEach { cookie ->
                                    CookieManager.getInstance().setCookie(entry.baseUrl, cookie)
                                }
                                CookieManager.getInstance().flush()
                            }

                            loadUrl(entry.startUrl)
                        }
                    },
                    update = { webView = it },
                )

                // 左边缘热区 + 可见手柄（AND-009 §2.2 → AND-010 §2.7）：
                // 热区 32dp 宽、与 MainActivity 的系统手势排除区同宽；系统侧已把这条排除出返回手势，
                // 但部分 ROM（MIUI/HyperOS）不认 systemGestureExclusionRects ⇒ 再给一个看得见的手柄兜底：
                // 点一下即开、向右拖也开，3 秒后淡到 15% 不挡网页；抽屉开着时隐藏。
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .fillMaxHeight()
                        .width(32.dp)
                        .pointerInput(Unit) {
                            var dragTotal = 0f
                            val openThreshold = 32.dp.toPx()
                            val releaseThreshold = 16.dp.toPx()
                            detectHorizontalDragGestures(
                                onDragStart = { dragTotal = 0f },
                                onDragEnd = {
                                    if (dragTotal > releaseThreshold) {
                                        dragTotal = 0f
                                        scope.launch { drawerState.open() }
                                    }
                                },
                            ) { change, dragAmount ->
                                change.consume()
                                dragTotal += dragAmount
                                when {
                                    dragTotal > openThreshold -> {
                                        dragTotal = 0f
                                        scope.launch { drawerState.open() }
                                    }
                                    dragTotal < 0f -> dragTotal = 0f // 向左滑不算（那是网页的事）
                                }
                            }
                        },
                ) {
                    if (!drawerState.isOpen) {
                        EdgeHandle(
                            modifier = Modifier.align(Alignment.CenterStart),
                            onClick = { scope.launch { drawerState.open() } },
                        )
                    }
                }

                if (stage == Stage.Loading) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
                }

                // 域名模式：一进来就提示「请先登录飞牛」；门户模式：全屏给门户，只有超时才出兜底按钮
                if (portalMode) {
                    if (slowFallback) {
                        LoginBanner(
                            slow = true,
                            portalMode = true,
                            onEnter = goToZxDesk,
                            onExit = onExit,
                        )
                    }
                } else if (waitingGateway) {
                    LoginBanner(
                        slow = slowFallback,
                        portalMode = false,
                        onEnter = goToZxDesk,
                        onExit = onExit,
                    )
                }

                (stage as? Stage.Failed)?.let { failed ->
                    ErrorOverlay(
                        failed = failed,
                        onRetry = {
                            arrived = false
                            stage = Stage.Loading
                            slowFallback = false
                            waitingGateway = entry.flow == EntryFlow.GATEWAY && !portalMode
                            attempt += 1
                            webView?.loadUrl(entry.startUrl)
                        },
                        onChangeAddress = onExit,
                    )
                }
            }
        }
    }

    // 等「飞牛登录完成」：Cookie 名只是其中一条线索，主判据是网关真的能吐 HTML
    LaunchedEffect(webView, attempt) {
        if (webView == null) return@LaunchedEffect
        if (entry.flow != EntryFlow.GATEWAY || arrived) return@LaunchedEffect
        val probe = GatewaySessionProbe(entry.baseUrl, entry.gatewayPath)
        val startedAt = System.currentTimeMillis()
        var tick = 0
        while (isActive && !arrived && System.currentTimeMillis() - startedAt < GATEWAY_TIMEOUT_MS) {
            delay(POLL_INTERVAL_MS)
            tick += 1
            val cookie = CookieManager.getInstance().getCookie(entry.baseUrl)
            // Cookie 每 700ms 看一眼（免费）；原生探测每 ~3s 一次，别把网关当压力测试
            val ready = cookie?.contains(SESSION_COOKIE) == true ||
                (tick % 4 == 0 && withContext(Dispatchers.IO) { probe.isReady(cookie) })
            if (ready) {
                enterZxDesk()
                return@LaunchedEffect
            }
            if (System.currentTimeMillis() - startedAt > GATEWAY_SLOW_MS) {
                slowFallback = true
                if (!portalMode) waitingGateway = true
            }
        }
        // 超时也没跳：门户模式给兜底按钮；域名模式的横幅本来就在
        if (!arrived) slowFallback = true
    }

    val pending = trustQueue.firstOrNull()
    if (pending != null) {
        TrustDialog(
            pending = pending,
            onConfirm = {
                val subject = subjectOf(pending.decision)
                val sha256 = fingerprintOf(pending.decision)
                if (subject != null && sha256 != null) {
                    prefs.saveTofu(TofuRecord(pending.host, subject, sha256, System.currentTimeMillis()))
                }
                resolveTrust(trustQueue, pending.host, accept = true)
            },
            onDismiss = { resolveTrust(trustQueue, pending.host, accept = false) },
        )
    }
}

// ---------------------------------------------------------------- 连接抽屉

private val DrawerWidth = 304.dp

/** 真实安装包的版本号（复命与抽屉底部小字都用它，⛔ 别写死）。 */
private fun versionLabel(context: Context): String = runCatching {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName
}.getOrNull() ?: "?"

/**
 * 连接抽屉（§5.2）：连接信息 + 刷新 / 换地址 / 退出登录，下面接「版本与更新」与「许可协议」。
 * 未 `arrived`（门户 / 飞牛登录页阶段）同样可用 —— 换地址、退出都要能走。
 *
 * ⚠️ 内容比一屏长：整列可滚动，⛔ 别在可滚动列里用 `weight` 撑底（高度无界时分不到空间）。
 */
@Composable
private fun ConnectionDrawer(
    entry: Entry,
    version: String,
    updateState: UpdateState,
    onRefresh: () -> Unit,
    onChangeAddress: () -> Unit,
    onLogout: () -> Unit,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val account = remember(entry, context) { SessionStore(context).load()?.user.orEmpty() }
    val host = entry.relayHost ?: run { runCatching { Uri.parse(entry.baseUrl).host }.getOrNull() } ?: entry.baseUrl
    val linkLabel = when {
        entry.relayHost != null -> "飞牛中继"
        entry.flow == EntryFlow.DIRECT -> "局域网直连"
        else -> "网关域名"
    }
    var showEula by remember { mutableStateOf(false) }
    var showNotes by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxHeight()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp)
            // 抽屉内向左滑 >60dp 关闭（gesturesEnabled=false 把系统手势关了，自己补一条）
            .pointerInput(Unit) {
                var dragTotal = 0f
                val closeThreshold = -60.dp.toPx()
                detectHorizontalDragGestures(
                    onDragStart = { dragTotal = 0f },
                ) { change, dragAmount ->
                    change.consume()
                    dragTotal += dragAmount
                    if (dragTotal < closeThreshold) {
                        dragTotal = 0f
                        onClose()
                    } else if (dragTotal > 0f) {
                        dragTotal = 0f
                    }
                }
            },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("连接", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text(host, fontSize = 16.sp)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = Ui.BadgeContainer,
                contentColor = Ui.BadgeContent,
            ) {
                Text(linkLabel, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
            }
            if (account.isNotBlank()) {
                Text(account, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(8.dp))
        DrawerAction("刷新页面", onRefresh)
        DrawerAction("换个地址", onChangeAddress)
        DrawerAction("退出登录", onLogout)

        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Spacer(Modifier.height(12.dp))

        UpdateSection(
            state = updateState,
            onCheck = onCheckUpdate,
            onDownload = onDownloadUpdate,
            onInstall = onInstallUpdate,
            onShowNotes = { showNotes = true },
        )

        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Spacer(Modifier.height(4.dp))
        DrawerAction("许可协议", onClick = { showEula = true })
        Spacer(Modifier.height(4.dp))
        Text("ZXDesk $version", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }

    if (showEula) {
        EulaViewer(text = Eula.text(context), onClose = { showEula = false })
    }
    if (showNotes) {
        UpdateNotesDialog(notes = updateState.notes, onClose = { showNotes = false })
    }
}

/**
 * 抽屉里的「版本与更新」。
 *
 * 一个阶段只给一个主动作：检查 → 下载 → 安装。失败到上限时另给「网盘手动更新」出口，
 * ⛔ 不在抽屉里堆一排等价按钮。
 */
@Composable
private fun UpdateSection(
    state: UpdateState,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
    onShowNotes: () -> Unit,
) {
    val context = LocalContext.current

    Text("版本与更新", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    VersionRow("当前版本", state.current)
    VersionRow(
        label = "最新版本",
        value = state.latest ?: "—",
        badge = updateBadge(state),
        accent = state.phase == UpdatePhase.AVAILABLE || state.phase == UpdatePhase.READY,
    )

    Spacer(Modifier.height(4.dp))
    Text(
        updateStatusText(state),
        fontSize = 12.sp,
        lineHeight = 17.sp,
        color = if (state.phase == UpdatePhase.ERROR) {
            MaterialTheme.colorScheme.error
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    )

    if (state.notes.isNotBlank() && state.latest != null) {
        Spacer(Modifier.height(6.dp))
        Surface(
            onClick = onShowNotes,
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                state.notes,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
    }

    if (state.phase == UpdatePhase.DOWNLOADING) {
        Spacer(Modifier.height(8.dp))
        val percent = state.progress
        if (percent == null) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
        } else {
            LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
        }
    }

    Spacer(Modifier.height(10.dp))
    PrimaryButton(
        text = state.actionLabel,
        enabled = state.actionEnabled,
        onClick = when (state.phase) {
            UpdatePhase.READY -> onInstall
            UpdatePhase.AVAILABLE, UpdatePhase.ERROR -> onDownload
            else -> onCheck
        },
    )

    if (state.giveUp) {
        Spacer(Modifier.height(4.dp))
        Text(
            "自动下载连续失败，可以稍后再试，或到网盘手动下载安装包。",
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (state.fallbackUrl.isNotBlank()) {
            TextButton(
                onClick = { openExternally(context, state.fallbackUrl) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("前往百度网盘下载", fontSize = 14.sp) }
        }
        TextButton(onClick = onDownload, modifier = Modifier.fillMaxWidth()) {
            Text("再试一次", fontSize = 14.sp)
        }
    }
}

/** 「标签 ---------------- 值」一行；值右侧可挂一枚状态徽标。 */
@Composable
private fun VersionRow(label: String, value: String, badge: String? = null, accent: Boolean = false) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
    ) {
        Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        if (badge != null) {
            Spacer(Modifier.width(6.dp))
            Surface(
                shape = RoundedCornerShape(6.dp),
                color = if (accent) Ui.BadgeContainer else MaterialTheme.colorScheme.surfaceVariant,
                contentColor = if (accent) Ui.BadgeContent else MaterialTheme.colorScheme.onSurfaceVariant,
            ) {
                Text(badge, fontSize = 10.sp, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
            }
        }
    }
}

private fun updateBadge(state: UpdateState): String? = when (state.phase) {
    UpdatePhase.IDLE -> null
    UpdatePhase.CHECKING -> "检测中"
    UpdatePhase.LATEST -> if (state.latest == null) null else "已是最新"
    UpdatePhase.AVAILABLE -> "有新版"
    UpdatePhase.DOWNLOADING, UpdatePhase.READY -> "有新版"
    UpdatePhase.ERROR -> "检查失败"
}

private fun updateStatusText(state: UpdateState): String = when (state.phase) {
    UpdatePhase.IDLE -> "还没检查过"
    UpdatePhase.CHECKING -> "正在检查…"
    UpdatePhase.LATEST -> if (state.latest == null) "服务端还没有这一端的发布记录" else "已是最新版本"
    UpdatePhase.AVAILABLE ->
        (if (state.mustUpdate) "有新版本，建议尽快更新" else "有新版本可用") + sizeHint(state.fileSize)
    UpdatePhase.DOWNLOADING -> state.progress?.let { "正在下载 $it%" } ?: "正在下载…"
    UpdatePhase.READY -> "已下载并通过校验${sizeHint(state.fileSize)}，可以安装"
    UpdatePhase.ERROR -> state.error ?: "检查失败"
}

/** 「（9.3 MB）」这样的尾巴；服务端没给大小就什么都不加。 */
private fun sizeHint(bytes: Long): String {
    if (bytes <= 0) return ""
    val text = when {
        bytes >= 1024L * 1024L -> "%.1f MB".format(Locale.US, bytes / 1024.0 / 1024.0)
        bytes >= 1024L -> "${bytes / 1024} KB"
        else -> "$bytes B"
    }
    return "（$text）"
}

/** 更新说明全文（抽屉里只露三行，点开看完整的一段）。 */
@Composable
private fun UpdateNotesDialog(notes: String, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("更新说明") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(notes.ifBlank { "这次更新没有附带说明。" }, fontSize = 14.sp, lineHeight = 21.sp)
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("知道了") } },
    )
}

@Composable
private fun DrawerAction(text: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Text(text, fontSize = 16.sp, modifier = Modifier.fillMaxWidth())
    }
}

// ---------------------------------------------------------------- 主框架导航

/**
 * 门户登录完会跳到 `<fnid>.fnos.net`，此时换成 ZXDesk 登录页。
 * ⚠️ 只认「主框架、非 /app/zxdesk 路径」—— 我们自己加载 login.html 时 host 也是中继主机，别自己跳自己。
 */
private fun handleMainFrame(
    entry: Entry,
    url: String?,
    arrived: Boolean,
    onEnterZxDesk: () -> Unit,
) {
    if (arrived || url == null) return
    val host = runCatching { Uri.parse(url).host }.getOrNull() ?: return
    // 中继主机上「不是 /app/zxdesk 的路径」= 门户刚跳过来的落地页（NAS 桌面 SPA），直接换登录页。
    // ⚠️ 我们自己加载 login.html 时 host 也是中继主机，所以必须排除 gatewayPath，否则会自己跳自己。
    if (host == entry.relayHost && !url.contains(entry.gatewayPath)) {
        onEnterZxDesk()
    }
}

/** 外链走系统浏览器；门户 / 中继 / 自家的地址一律留在 WebView 里。 */
private fun openExternally(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

private fun isInternalHost(entry: Entry, host: String): Boolean {
    val baseHost = runCatching { Uri.parse(entry.baseUrl).host }.getOrNull()
    if (host == baseHost || host == entry.relayHost) return true
    if (FnPortal.isPortalHost(host)) return true
    // 门户的静态资源与账号子站
    return host == "fnnas.com" || host.endsWith(".fnnas.com")
}

// ---------------------------------------------------------------- 状态与回调

private sealed interface Stage {
    data object Loading : Stage
    data object Content : Stage
    data class Failed(val title: String, val detail: String) : Stage
}

private data class PendingTrust(
    val host: String,
    val decision: TrustDecision,
    val handler: SslErrorHandler,
)

private const val POLL_INTERVAL_MS = 700L
private const val GATEWAY_TIMEOUT_MS = 180_000L
private const val GATEWAY_SLOW_MS = 60_000L
private const val RELAY_COOKIE = "mode=relay; Path=/; Secure"
private const val SESSION_COOKIE = "Trim-MC-token"

/** 同一 host 的 SSL 回调可能并发到达（每个失败资源一次）；一次决定要把它全放掉，否则请求会挂着。 */
private fun resolveTrust(
    queue: MutableList<PendingTrust>,
    host: String,
    accept: Boolean,
) {
    val batch = queue.filter { it.host == host }
    queue.removeAll(batch)
    batch.forEach { if (accept) it.handler.proceed() else it.handler.cancel() }
}

private fun subjectOf(decision: TrustDecision): String? = when (decision) {
    is TrustDecision.AskFirst -> decision.subject
    is TrustDecision.AskRotated -> decision.subject
    else -> null
}

private fun fingerprintOf(decision: TrustDecision): String? = when (decision) {
    is TrustDecision.AskFirst -> decision.sha256
    is TrustDecision.AskRotated -> decision.currentSha256
    else -> null
}

private fun buildClient(
    entry: Entry,
    prefs: Prefs,
    onSessionExpired: () -> Unit,
    onAccessCodeRequired: () -> Unit,
    onStage: (Stage) -> Unit,
    onAskTrust: (PendingTrust) -> Unit,
    onMainFrame: (String?) -> Unit,
    onExternal: (String) -> Unit,
): WebViewClient = object : WebViewClient() {

    private val isGateway = entry.flow == EntryFlow.GATEWAY

    /** 网关流程里「还在飞牛页/门户」的阶段不算 app 页，不盖进度条。 */
    private fun isAppPage(url: String?): Boolean = url != null && url.contains(entry.gatewayPath)

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        onMainFrame(url)
        if (isGateway && !isAppPage(url)) return
        onStage(Stage.Loading)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        if (isGateway && !isAppPage(url)) {
            // 门户 / 飞牛登录页加载完了：收起进度条，但不做 ZXDesk 正文判定
            onStage(Stage.Content)
            return
        }
        onStage(Stage.Content)
        // 网关对「未登录」返回 200 + 纯文本 invalid token、对「要访问码」返回它自己的网页 —— 都只能看正文
        view?.evaluateJavascript(PageProbeJs.SCRIPT) { raw ->
            when (PageProbeJs.pageOf(raw)) {
                GatewayPage.ACCESS_CODE -> onAccessCodeRequired()
                GatewayPage.LOGIN_REQUIRED -> {
                    if (entry.fnSession != null) {
                        // 我们带着会话来的 ⇒ 会话过期了。交给上层用 longToken 换新的，
                        // ⛔ 别在这层显示「请先登录飞牛」——那会让用户以为要重新输密码。
                        onSessionExpired()
                    } else {
                        onStage(
                            Stage.Failed(
                                "需要先登录飞牛",
                                "飞牛网关要求先登录飞牛账号，之后才能打开 ZXDesk。\n\n" +
                                    "点「重试」回到门户重新登录，或改用 8990 局域网直连。",
                            ),
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?,
    ) {
        if (request?.isForMainFrame != true) return
        onStage(
            Stage.Failed(
                "打不开这个地址",
                "${error?.description ?: "网络错误"}（错误码 ${error?.errorCode ?: -1}）\n${request.url}",
            ),
        )
    }

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        response: WebResourceResponse?,
    ) {
        if (request?.isForMainFrame != true) return
        val status = response?.statusCode ?: 0
        if (status >= 400) {
            onStage(Stage.Failed("服务器返回 HTTP $status", request.url.toString()))
        }
    }

    override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError) {
        val host = runCatching { Uri.parse(error.url).host }.getOrNull().orEmpty()
        val x509 = runCatching { error.certificate?.x509Certificate }.getOrNull()
        if (x509 == null) {
            handler.cancel()
            onStage(Stage.Failed("读不到证书", "系统没有给出证书详情，无法确认这台设备的身份。"))
            return
        }
        val subject = runCatching { x509.subjectX500Principal.name }.getOrNull()
            ?: error.certificate?.issuedTo?.toString().orEmpty()
        val fingerprint = sha256Of(x509.encoded)

        when (val decision = TlsPolicy.decide(host, subject, fingerprint, prefs.tofu(host))) {
            TrustDecision.Accept -> handler.proceed()
            is TrustDecision.AskFirst, is TrustDecision.AskRotated -> onAskTrust(
                PendingTrust(host, decision, handler),
            )
            is TrustDecision.Reject -> {
                handler.cancel()
                onStage(
                    Stage.Failed(
                        "证书不属于本设备",
                        "${decision.reason}\n\n如果你确认连的是自己的 NAS，" +
                            "请检查是不是同一网段有别的设备占了这个地址。",
                    ),
                )
            }
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val url = request?.url?.toString() ?: return false
        val host = request.url.host ?: return false
        if (isInternalHost(entry, host)) return false
        // 外链（说明文档、商店页等）交给系统浏览器，别把 WebView 卡在别人的站点上
        onExternal(url)
        return true
    }
}

private fun sha256Of(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString(":") { "%02X".format(it.toInt() and 0xff) }

// ---------------------------------------------------------------- 覆盖层

/**
 * 登录提示横幅。放在底部，不挡上面的登录表单 —— 用户得能输账号密码。
 * 门户模式只在 60s 后出现；域名模式一直有。
 */
@Composable
private fun LoginBanner(
    slow: Boolean,
    portalMode: Boolean,
    onEnter: () -> Unit,
    onExit: () -> Unit,
) {
    Box(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Card {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    when {
                        portalMode && slow -> "还没自动跳过去？"
                        slow -> "没检测到飞牛登录状态"
                        else -> "请先登录飞牛"
                    },
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    when {
                        portalMode && slow ->
                            "确认已经在门户登录飞牛后，点下面直接进 ZXDesk；没登录请先在页面上登录。"
                        slow -> "已经登录了就直接进 ZXDesk；没登录请在上面登录。"
                        else -> "登录完成后会自动进入 ZXDesk，不用手动操作。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onEnter) { Text("进入 ZXDesk") }
                    TextButton(onClick = onExit) { Text("返回") }
                }
            }
        }
    }
}

@Composable
private fun ErrorOverlay(failed: Stage.Failed, onRetry: () -> Unit, onChangeAddress: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Card {
            Column(
                modifier = Modifier
                    .padding(20.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(failed.title, style = MaterialTheme.typography.titleMedium)
                Text(failed.detail, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onRetry) { Text("重试") }
                    TextButton(onClick = onChangeAddress) { Text("换地址") }
                }
            }
        }
    }
}

@Composable
private fun TrustDialog(pending: PendingTrust, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val rotated = pending.decision as? TrustDecision.AskRotated
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (rotated != null) "设备证书已更新" else "确认这台设备") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(pending.host, style = MaterialTheme.typography.titleSmall)
                Text(
                    if (rotated != null) {
                        "证书指纹和上次记录的不一样。设备重装或恢复出厂都会这样，不一定是攻击。" +
                            "确认后不再询问。"
                    } else {
                        "这是第一次连接这台设备，请核对指纹。确认后会记住，之后不再询问。"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                subjectOf(pending.decision)?.let {
                    Text("证书主体：$it", style = MaterialTheme.typography.bodySmall)
                }
                if (rotated != null) {
                    Text(
                        "旧指纹：${rotated.previousSha256}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                fingerprintOf(pending.decision)?.let {
                    Text("新指纹 SHA-256：\n$it", style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("信任本设备") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/**
 * 左缘手柄（AND-010 §2.7）：视觉是一条 4dp × 56dp 的圆角条（primary 40%），
 * 摸得到的是 32dp × 72dp 的方块（手指够得着），点一下即开抽屉、向右拖走父级手势。
 * 3 秒后淡到 15%，尽量不挡网页内容；抽屉开着时调用方不渲染。
 */
@Composable
private fun EdgeHandle(modifier: Modifier = Modifier, onClick: () -> Unit) {
    var dimmed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        dimmed = false
        delay(3000)
        dimmed = true
    }
    val alpha by animateFloatAsState(targetValue = if (dimmed) 0.15f else 0.4f, label = "edgeHandle")
    Box(
        modifier = modifier
            .width(32.dp)
            .height(72.dp)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .width(4.dp)
                .height(56.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = alpha)),
        )
    }
}
