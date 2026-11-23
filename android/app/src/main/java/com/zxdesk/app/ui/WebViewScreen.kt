/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.app.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.util.Log
import android.view.ViewGroup
import android.widget.Toast
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.zxdesk.app.Eula
import com.zxdesk.app.NoticeUi
import com.zxdesk.app.Prefs
import com.zxdesk.app.R
import com.zxdesk.app.log.AppLog
import com.zxdesk.app.net.WebViewProxy
import com.zxdesk.app.store.Account
import com.zxdesk.app.store.SessionStore
import com.zxdesk.app.update.UpdatePhase
import com.zxdesk.app.update.UpdateState
import com.zxdesk.core.connection.FnPortal
import com.zxdesk.core.connection.GatewayPage
import com.zxdesk.core.connection.GatewaySessionProbe
import com.zxdesk.core.datasource.Entry
import com.zxdesk.core.datasource.EntryFlow
import com.zxdesk.core.update.Versions
import com.zxdesk.core.tls.TlsPolicy
import com.zxdesk.core.tls.TofuRecord
import com.zxdesk.core.tls.TrustDecision
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * WebView 壳。入口三条路，⛔ 别混：
 *
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewScreen(
    entry: Entry,
    onExit: () -> Unit,
    /** 带会话进来却仍被判 `invalid token`：交给上层用 longToken 换新会话（⛔ 别在这里自己重登）。 */
    onSessionExpired: () -> Unit = {},
    /**
     *
     * @return true = 上层已接手（别再加载登录页）；false = 放它跳
     */
    onLoginRedirect: () -> Boolean = { false },
    /** 页面其实是网关的「访问码」页：回第 ④ 步让用户输入（⛔ 别让人对着空白页猜）。 */
    onAccessCodeRequired: () -> Unit = {},
    /** 抽屉「退出登录」：丢掉当前会话回第 ② 步；记住的密码保留（切换账号要用）。 */
    onLogout: () -> Unit = {},
    /** 进应用时要提示一句（例如「已改用局域网直连」），一闪而过，不挡操作。 */
    notice: String? = null,
    /** 版本与更新的全部状态（检查 / 下载 / 已下载）。 */
    updateState: UpdateState,
    /** 公告状态：抽屉底部那条跑马灯与「公告」行的未读角标都读它。 */
    noticeState: NoticeUi,
    onRefreshNotices: () -> Unit,
    onReadAllNotices: () -> Unit,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    /** 保存过的账号（抽屉「切换账号」用）。 */
    accounts: List<Account> = emptyList(),
    /** 选中一个账号：交给上层换会话并回连接页。 */
    onPickAccount: (Account) -> Unit = {},
    /** 删除一个账号（连它记住的密码一起）。 */
    onRemoveAccount: (Account) -> Unit = {},
    /** 新增一个账号：丢弃当前会话，回连接页并从空表单开始。 */
    onAddAccount: () -> Unit = {},
    /**
     * 「可以把启动动画收掉了」。启动动画已上提到 `AppRoot`，由它据此收尾 ——
     * 这样「恢复会话 → WebView 首帧」是同一条动画，中途不重启、不跳帧。
     */
    onFirstPaint: () -> Unit = {},
) {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val portalMode = entry.portalUrl != null && entry.fnSession == null

    var webView by remember { mutableStateOf<WebView?>(null) }
    var stage by remember { mutableStateOf<Stage>(Stage.Loading) }
    // 首屏画出来过没有：启动动画只在「第一次」盖屏，页面内跳转不再全屏遮。
    var booted by remember { mutableStateOf(false) }
    // 已经有原生 WS 会话 ⇒ 直接进 ZXDesk，不走门户、不轮询
    var arrived by remember { mutableStateOf(entry.fnSession != null) }
    // 手里已有原生会话时不要挂「请先登录飞牛」那条横幅：网关模式下入口是 login.html，
    // 首帧会短暂闪一句「请先登录飞牛 / 登录后会自动进入」，而用户明明已经是登录状态
    // （`markArrived` 要等 onPageStarted 才把横幅收掉）。
    var waitingGateway by remember {
        mutableStateOf(entry.flow == EntryFlow.GATEWAY && !portalMode && entry.fnSession == null)
    }
    var slowFallback by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    val trustQueue = remember { mutableStateListOf<PendingTrust>() }

    // 页面里 `<input type="file">` 的选择结果往哪交（聊天发图、协作传附件）。
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

    // 两个整屏页面（⛔ 不是弹窗）：切换账号、日志。都从抽屉进，盖在网页之上。
    var showAccounts by remember { mutableStateOf(false) }
    var showLogs by remember { mutableStateOf(false) }
    /** 帮助页（整屏）：抽屉底部「帮助」进，内容与前端 `core/about.js` 同源。 */
    var showHelp by remember { mutableStateOf(false) }
    /** 设置页（整屏）：抽屉底部「设置」进，看连接信息、切账号、看模式。 */
    var showSettings by remember { mutableStateOf(false) }
    /** 打赏与支持（整屏）：抽屉「更多」进。 */
    var showDonate by remember { mutableStateOf(false) }
    /** 更新日志（整屏）：抽屉「更多」进。 */
    var showReleases by remember { mutableStateOf(false) }
    /** 公告（整屏）：抽屉「更多」进。 */
    var showNotices by remember { mutableStateOf(false) }
    /** 账号页是从设置页进来的：返回时回设置，⛔ 不要直接弹回网页。 */
    var accountsFromSettings by remember { mutableStateOf(false) }
    // 当前账号键（`地址\u0001账号`），切换列表里用来标「当前」
    val currentKey = remember(entry) {
        val saved = SessionStore(context).load()
        if (saved == null) null else saved.address.trim() + "\u0001" + saved.user.trim()
    }

    // 原生 WS 登录的收尾告警（ticket 换到几条 Cookie / entry-token 失败）。
    // 只进 logcat，不上界面：内容是 `(result=fail, errno=65534, reqid=13)` 这类内部错误码，
    // 对使用者没有意义，也不能据此做任何操作。
    LaunchedEffect(entry.fnSession?.note) {
        val note = entry.fnSession?.note ?: return@LaunchedEffect
        Log.i(TAG, note)
        AppLog.i("Web", note)
    }

    LaunchedEffect(notice) {
        if (!notice.isNullOrBlank()) Toast.makeText(context, notice, Toast.LENGTH_LONG).show()
    }

    // 静默启动（手里有原生会话）时，WebView 的第一页是 `login.html` —— 它只是跳板：
    // 先画一张「正在检查登录状态…」的卡片，等 JS 验完 cookie 再跳主界面。
    // 这块跳板的**首帧不是用户要看的界面**，启动动画必须继续盖着（见 buildClient 的 isSplashGate）。
    LaunchedEffect(entry.fnSession?.token) {
        if (entry.fnSession == null) return@LaunchedEffect
        delay(SPLASH_GATE_TIMEOUT_MS)
        AppLog.i(TAG, "静默启动 8 秒仍未进应用页，收起启动动画")
        onFirstPaint()
    }

    // 首次进浏览页用**气泡**提示一次（不再用 Toast）：Toast 一闪而过，看完还是不知道那条竖线能点。
    // 气泡挂 4 秒、点一下立即消失；之后永不再提示（drawerHintShown 落盘）。
    var showDrawerHint by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!prefs.drawerHintShown) {
            prefs.drawerHintShown = true
            showDrawerHint = true
            delay(4_000)
            showDrawerHint = false
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
        webView?.loadUrl(startUrlOf(context, entry.zxDeskLoginUrl))
    }

    /** 自动跳：已经进去过就不重复跳，免得把用户从主界面踢回登录页。 */
    val enterZxDesk: () -> Unit = { if (!arrived) goToZxDesk() }

    /**
     * 重新加载当前入口。
     *
     */
    val retryLoad: () -> Unit = {
        arrived = false
        stage = Stage.Loading
        slowFallback = false
        waitingGateway = entry.flow == EntryFlow.GATEWAY && !portalMode
        // 重试时把细进度条放出来：这条本该绑在「不再有启动动画」上，
        // 只绑「首屏画过」的话，「第一次就失败 → 点重试」这段会一个字都不动。
        booted = true
        attempt += 1
        webView?.loadUrl(startUrlOf(context, entry.startUrl))
    }

    // 回前台的页面级兜底：停在错误页就自己重试一次。
    // 为什么需要：切后台断网时 WebView 已经画出错误页；网络恢复了，页面却还停在那句话上，
    // 用户不知道要自己点「重试」。
    val lifecycleOwner = LocalLifecycleOwner.current
    val stageNow = rememberUpdatedState(stage)
    val retryNow = rememberUpdatedState(retryLoad)
    var lastAutoRetryAt by remember { mutableStateOf(0L) }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event != Lifecycle.Event.ON_RESUME) return@LifecycleEventObserver
            if (stageNow.value !is Stage.Failed) return@LifecycleEventObserver
            val now = System.currentTimeMillis()
            if (now - lastAutoRetryAt < AUTO_RETRY_INTERVAL_MS) return@LifecycleEventObserver
            lastAutoRetryAt = now
            AppLog.i(TAG, "回前台时页面停在错误页，自动重试一次")
            retryNow.value()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    /** 返回键优先级：抽屉开 → 关抽屉；网页可回退 → 网页后退；否则 → 退出应用。 */
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
                    onSwitchAccount = {
                        scope.launch { drawerState.close() }
                        accountsFromSettings = false
                        showAccounts = true
                    },
                    onOpenLogs = {
                        scope.launch { drawerState.close() }
                        showLogs = true
                    },
                    onOpenHelp = {
                        scope.launch { drawerState.close() }
                        showHelp = true
                    },
                    onOpenSettings = {
                        scope.launch { drawerState.close() }
                        showSettings = true
                    },
                    onOpenDonate = {
                        scope.launch { drawerState.close() }
                        showDonate = true
                    },
                    onOpenReleases = {
                        scope.launch { drawerState.close() }
                        showReleases = true
                    },
                    marquee = noticeState.marquee,
                    unreadNotices = noticeState.unreadCount,
                    onOpenNotices = {
                        scope.launch { drawerState.close() }
                        showNotices = true
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
            // 上一版把内容列限宽到 560dp、逼前端走手机版 —— 方向错了，平板本来就该用桌面版。
            // 这里恢复全宽（WebView 宽度 = 屏幕宽 − 安全区），前端按自己的 `innerWidth` 判据分流：
            // 平板 ≥ 1024 ⇒ 桌面版，手机 ⇒ 手机版。
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
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
                                 *
                                 * 为什么必须有：平板上登录页（原生）正常、抽屉（原生）正常，
                                 */
                                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                                    val text = msg.message().orEmpty()
                                    val where = (msg.sourceId() ?: "?").substringAfterLast('/') +
                                        ":" + msg.lineNumber()
                                    when (msg.messageLevel()) {
                                        ConsoleMessage.MessageLevel.ERROR ->
                                            AppLog.e("Web", "JS 错误：${text.take(300)} @ $where")
                                        ConsoleMessage.MessageLevel.WARNING ->
                                            AppLog.w("Web", "JS 警告：${text.take(200)} @ $where")
                                        else -> Unit
                                    }
                                    return false
                                }

                                /**
                                 * 让页面里的 `<input type="file">`（聊天发图、协作传附件）弹出系统选择器。
                                 *
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

                            val stageSink: (Stage) -> Unit = { s ->
                                stage = s
                                if (s is Stage.Failed) {
                                    AppLog.w("Web", "页面失败：" + s.title + " · " + s.detail.replace('\n', ' ').take(180))
                                }
                                // 首帧画出来 ⇒ 之后的页面内跳转不再全屏遮（由那条细进度条接管）
                                if (s == Stage.FirstPaint) booted = true
                                // 三种时机都要通知上层收动画，缺一个就卡住（见参数注释）
                                if (s == Stage.FirstPaint || s == Stage.Content || s is Stage.Failed) {
                                    onFirstPaint()
                                }
                            }
                            webViewClient = buildClient(
                                entry = entry,
                                prefs = prefs,
                                onSessionExpired = onSessionExpired,
                                onAccessCodeRequired = onAccessCodeRequired,
                                // 已经在应用里、而且手里还握着会话 ⇒ 登录页是 401 跳出来的，
                                // 先让上层试着续会话（首次进入时 arrived 还是 false，不拦）
                                onLoginRedirect = { arrived && onLoginRedirect() },
                                onStage = stageSink,
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
                                /**
                                 * 域名解析不了 ⇒ 起本机代理，起来后重新加载。
                                 *
                                 */
                                onDnsFailure = { host, cacheFallback ->
                                    scope.launch {
                                        if (WebViewProxy.enable(ctx, host)) {
                                            stageSink(Stage.Loading)
                                            webView?.reload()
                                        } else if (!cacheFallback()) {
                                            stageSink(
                                                Stage.Failed(
                                                    "打不开这个地址",
                                                    "这台手机解析不了这个域名。换一个地址，或切到移动数据再试。",
                                                ),
                                            )
                                        }
                                    }
                                },
                            )

                            entry.fnSession?.let { session ->
                                if (entry.relayHost != null) {
                                    CookieManager.getInstance().setCookie(entry.baseUrl, RELAY_COOKIE)
                                }
                                session.cookies(entry.relayHost).forEach { cookie ->
                                    CookieManager.getInstance().setCookie(entry.baseUrl, cookie)
                                }
                                CookieManager.getInstance().flush()
                            }

                            loadUrl(startUrlOf(ctx, entry.startUrl))
                        }
                    },
                    update = { webView = it },
                    /**
                     * WebView 必须自己销毁。
                     *
                     */
                    onRelease = { view ->
                        webView = null
                        // WebView 一拆，代理就没人用了：留着只是给下次进页面埋一个死端口
                        WebViewProxy.disable()
                        runCatching {
                            view.stopLoading()
                            view.webChromeClient = null
                            view.webViewClient = WebViewClient()
                            (view.parent as? ViewGroup)?.removeView(view)
                            view.destroy()
                        }
                    },
                )

                // 左边缘热区 + 可见把手：
                // 热区 40dp 宽、与 MainActivity 的系统手势排除区同宽；系统侧已把这条排除出返回手势，
                // 但部分 ROM（MIUI/HyperOS）不认 systemGestureExclusionRects ⇒ 再给一个看得见的把手兜底。
                val haptic = LocalHapticFeedback.current
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .fillMaxHeight()
                        .width(40.dp)
                        .pointerInput(Unit) {
                            var dragTotal = 0f
                            val openThreshold = 32.dp.toPx()
                            val releaseThreshold = 16.dp.toPx()
                            detectHorizontalDragGestures(
                                onDragStart = { dragTotal = 0f },
                                onDragEnd = {
                                    if (dragTotal > releaseThreshold) {
                                        dragTotal = 0f
                                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                        scope.launch { drawerState.open() }
                                    }
                                },
                            ) { change, dragAmount ->
                                change.consume()
                                dragTotal += dragAmount
                                when {
                                    dragTotal > openThreshold -> {
                                        dragTotal = 0f
                                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
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

                // 首次引导气泡：指着把手说清它能干什么。点一下即消，不挡后续操作。
                if (showDrawerHint && !drawerState.isOpen) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.inverseSurface,
                        contentColor = MaterialTheme.colorScheme.inverseOnSurface,
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .padding(start = 50.dp)
                            .widthIn(max = 210.dp)
                            .clickable { showDrawerHint = false },
                    ) {
                        Text(
                            "向右滑，或点这条把手，打开连接面板",
                            fontSize = 12.sp,
                            lineHeight = 17.sp,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }

                if (stage == Stage.Loading && booted) {
                    // 启动阶段由 StartupLoader 全屏接管；这一条管「页面内跳转」与「点重试之后」
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
                        onRetry = retryLoad,
                        onChangeAddress = onExit,
                    )
                }

                // 启动动画**不在这里**：已上提到 `AppRoot`（见那里的说明）——
                // 放这里的话「恢复会话」与「进浏览页」是两次组合，动画会重启一次、角度跳回 0。

                // 两个整屏页面盖在网页之上（抽屉已经在打开前关掉，不会盖住它们）
                if (showAccounts) {
                    AccountPickerScreen(
                        accounts = accounts,
                        currentKey = currentKey,
                        onPick = { account ->
                            accountsFromSettings = false
                            showAccounts = false
                            onPickAccount(account)
                        },
                        onDelete = onRemoveAccount,
                        onAdd = {
                            accountsFromSettings = false
                            showAccounts = false
                            onAddAccount()
                        },
                        onClose = {
                            showAccounts = false
                            // 从设置页进来的：返回时回设置，⛔ 不要直接落回网页
                            if (accountsFromSettings) {
                                accountsFromSettings = false
                                showSettings = true
                            }
                        },
                        // 抽屉底部只剩「账户 / 设置 / 帮助」三列 —— 退出登录跟着账户页走
                        onLogout = {
                            accountsFromSettings = false
                            showAccounts = false
                            onLogout()
                        },
                    )
                }
                if (showLogs) {
                    LogScreen(onClose = { showLogs = false })
                }
                if (showHelp) {
                    HelpScreen(version = versionLabel(context), onClose = { showHelp = false })
                }
                if (showSettings) {
                    SettingsScreen(
                        entry = entry,
                        version = versionLabel(context),
                        accounts = accounts,
                        currentKey = currentKey,
                        onSwitchAccount = {
                            showSettings = false
                            accountsFromSettings = true
                            showAccounts = true
                        },
                        onAddAccount = {
                            showSettings = false
                            onAddAccount()
                        },
                        onClose = { showSettings = false },
                    )
                }
                if (showDonate) {
                    DonateScreen(onClose = { showDonate = false })
                }
                if (showReleases) {
                    ReleasesScreen(
                        version = versionLabel(context),
                        latest = updateState.latest,
                        latestNotes = updateState.notes,
                        onClose = { showReleases = false },
                    )
                }
                if (showNotices) {
                    NoticeScreen(
                        state = noticeState,
                        onRefresh = onRefreshNotices,
                        onReadAll = onReadAllNotices,
                        onClose = { showNotices = false },
                    )
                }
            }
        }
    }

    // 登录阶段就判过「系统解析被绕过」：首屏直接把代理挂上，别等页面报错再补。
    // 只在真的新起代理时 reload —— 已经在生效还重载一次，等于白白多等一屏。
    LaunchedEffect(webView) {
        if (webView == null || WebViewProxy.isActive()) return@LaunchedEffect
        if (!WebViewProxy.recentlyBypassed()) return@LaunchedEffect
        if (WebViewProxy.enable(context)) webView?.reload()
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
            // Cookie 每 700ms 看一眼（纯本地，不花请求）；
            // 原生探测走**渐进退避** —— 网关侧也有频率限制，
            // 前 30 秒每 4 tick（≈2.8 秒）够快，之后就放到 12 tick（≈8.4 秒）：
            val probeEvery =
                if (System.currentTimeMillis() - startedAt < GATEWAY_PROBE_FAST_MS) 4 else 12
            val ready = cookie?.contains(SESSION_COOKIE) == true ||
                (tick % probeEvery == 0 && withContext(Dispatchers.IO) { probe.isReady(cookie) })
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

internal val DrawerWidth = 304.dp

/** 真实安装包的版本号（复命与抽屉底部小字都用它，⛔ 别写死）。 */
internal fun versionLabel(context: Context): String = runCatching {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName
}.getOrNull() ?: "?"

/**
 * 连接抽屉：设备与账号信息，下面按分区排「连接 / 模式 / 账号 / 版本与更新 / 更多」。
 * 未 `arrived`（门户 / 飞牛登录页阶段）同样可用 —— 换地址、切换账号、退出都要能走。
 */
@Composable
internal fun ConnectionDrawer(
    entry: Entry?,
    version: String,
    updateState: UpdateState,
    onRefresh: () -> Unit,
    onChangeAddress: () -> Unit,
    onSwitchAccount: () -> Unit,
    onOpenLogs: () -> Unit,
    onOpenHelp: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenDonate: () -> Unit,
    onOpenReleases: () -> Unit,
    /** 顶置公告（`app_notice_marquee`）的文案；空串 = 不显示那条横幅。 */
    marquee: String,
    /** 未读公告数：> 0 时「公告」行右侧挂角标。 */
    unreadNotices: Int,
    onOpenNotices: () -> Unit,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val connected = entry != null
    val account = remember(entry, context) {
        if (entry == null) "" else SessionStore(context).load()?.user.orEmpty()
    }
    val host = when {
        entry?.relayHost != null -> entry.relayHost
        entry != null -> runCatching { Uri.parse(entry.baseUrl).host }.getOrNull() ?: entry.baseUrl
        else -> "未连接"
    }
    val linkLabel = when {
        entry == null -> "登录"
        entry.relayHost != null -> "飞牛中继"
        entry.flow == EntryFlow.DIRECT -> "局域网直连"
        else -> "网关域名"
    }
    var showEula by remember { mutableStateOf(false) }

    // 顶部身份、中间分组（每行带图标）、底部「升级卡 ＋ 账户 / 设置 / 帮助」三列。
    // 判据：入口再多，顶部与底部不跟着滚；分割线只分这三块，组与组之间靠间距。
    Column(
        modifier = Modifier
            .fillMaxHeight()
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
    ) {
        // ── 顶部固定：品牌 ＋ 这是哪台设备（中间怎么滚，这块都不动）──
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 20.dp, bottom = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 品牌标＝桌面图标同一张图（drawable-<dpi>/ic_brand.png），⛔ 不再自绘「ZX」方块：
            // 两处各画一份的结果是应用商店换了图标、抽屉里还是旧的紫方块。
            Image(
                painter = painterResource(R.drawable.ic_brand),
                contentDescription = null,
                modifier = Modifier.size(40.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("ZXDesk", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(2.dp))
                Text(
                    if (connected) "$host · $linkLabel" else "未连接",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        DrawerDivider()

        // ── 中间滚动：日常对「这一屏 / 这条连接」做的事 ──
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 10.dp, vertical = 12.dp),
        ) {
            DrawerSection("连接")
            // 登录页还没有可刷新的页面 / 可换掉的地址：这两条灰着
            DrawerAction(R.drawable.ic_drawer_refresh, "刷新页面", onRefresh, enabled = connected)
            DrawerAction(R.drawable.ic_drawer_link, "换个地址", onChangeAddress, enabled = connected)

            Spacer(Modifier.height(DrawerGroupGap))

            // 模式：现在只有「仅连接 NAS」真正可用，另两种（仅本机 / 混合）还是登录页上的占位。
            // 可用那一种画成**选中块**（实心底 ＋ 白字）—— 其余行文字比它淡一档，一眼看出当前是哪条。
            DrawerSection("模式")
            DrawerCurrentRow(R.drawable.ic_drawer_mode, "仅连接 NAS")
            DrawerActionPlanned(R.drawable.ic_drawer_mode, "切换模式")

            Spacer(Modifier.height(DrawerGroupGap))

            DrawerSection("更多")
            // 公告：服务端 app_notice，未读时右侧挂数字角标（与弹窗共用同一个已读集合）
            DrawerAction(
                R.drawable.ic_drawer_notice,
                "公告",
                onOpenNotices,
                badge = if (unreadNotices > 0) unreadNotices.toString() else null,
            )
            DrawerAction(R.drawable.ic_drawer_log, "日志", onOpenLogs)
            DrawerAction(R.drawable.ic_drawer_shield, "许可协议", onClick = { showEula = true })
            // 这两条跟「日志 / 许可」同属「关于这个应用」，⛔ 不塞进底部三列
            DrawerAction(R.drawable.ic_drawer_donate, "打赏与支持", onOpenDonate)
            DrawerAction(R.drawable.ic_drawer_history, "更新日志", onOpenReleases)
        }

        DrawerDivider()

        // ── 底部固定：顶置公告 ＋ 升级卡 ＋ 账户 / 设置 / 帮助（三列，照参考图）──
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 10.dp, bottom = 8.dp)) {
            if (marquee.isNotBlank()) {
                MarqueeBar(marquee)
                Spacer(Modifier.height(6.dp))
            }
            UpgradeCard(
                state = updateState,
                version = version,
                onCheck = onCheckUpdate,
                onDownload = onDownloadUpdate,
                onInstall = onInstallUpdate,
            )
            Spacer(Modifier.height(6.dp))
            DrawerFooter(
                account = account,
                onAccount = onSwitchAccount,
                onSettings = onOpenSettings,
                onHelp = onOpenHelp,
                // 登录页：没有当前账号可切、连接信息就是那张表单
                accountEnabled = connected && account.isNotBlank(),
                settingsEnabled = connected,
            )
        }
    }

    if (showEula) {
        EulaViewer(text = Eula.text(context), onClose = { showEula = false })
    }
}

/**
 * 顶置公告条：一行，长文案横向连续滚动（跑马灯）。
 *
 */
@Composable
private fun MarqueeBar(text: String) {
    val density = LocalDensity.current
    val textStyle = remember { TextStyle(fontSize = 11.sp) }
    val textColor = MaterialTheme.colorScheme.primary
    // 单份文字的真实宽度（像素）：由下面的 Layout 在无约束下量回来
    var textWidthPx by remember(text) { mutableStateOf(0) }
    var viewportWidthPx by remember(text) { mutableStateOf(0) }
    val gapPx = with(density) { 40.dp.toPx() }
    val speedPxPerSec = with(density) { 30.dp.toPx() }
    val offset = remember(text) { Animatable(0f) }

    LaunchedEffect(text, textWidthPx, viewportWidthPx) {
        if (textWidthPx <= 0 || viewportWidthPx <= 0) return@LaunchedEffect
        // 放得下就完整显示：静止，不滚
        if (textWidthPx <= viewportWidthPx) {
            offset.snapTo(0f)
            return@LaunchedEffect
        }
        val total = textWidthPx + gapPx
        val duration = ((total / speedPxPerSec) * 1000f).toInt().coerceAtLeast(1_500)
        offset.snapTo(0f)
        // 连续滚，中间不插 delay：`snapTo(0)` 那一刻第二份正好在 0 位置、内容与终点一致，
        while (true) {
            offset.animateTo(-total, tween(duration, easing = LinearEasing))
            offset.snapTo(0f)
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_drawer_notice),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(6.dp))
        // 视口：超出部分裁掉，只留这一条里的文字在动
        Box(
            Modifier
                .weight(1f)
                .clipToBounds()
                .onSizeChanged { viewportWidthPx = it.width },
        ) {
            // 两份文字**各自定位**，不靠 Row 依次摆放 —— 用 Row 时第二份会被压到第一份的位置上，
            // 两行字叠成重影。
            // 位移走 `graphicsLayer`，⛔ 不用 `Modifier.offset { }`：后者是 layout modifier，
            val ready = textWidthPx > 0
            val shiftPx = (textWidthPx + gapPx)
            Layout(
                content = {
                    Text(
                        text,
                        style = textStyle,
                        color = textColor,
                        maxLines = 1,
                        softWrap = false,
                        modifier = Modifier.graphicsLayer {
                            alpha = if (ready) 1f else 0f
                            translationX = offset.value
                        },
                    )
                    // 第二份起步晚「一整条 ＋ 间隔」：第一份滚完时它正好补到起点，看不出接缝
                    Text(
                        text,
                        style = textStyle,
                        color = textColor,
                        maxLines = 1,
                        softWrap = false,
                        modifier = Modifier.graphicsLayer {
                            alpha = if (ready) 1f else 0f
                            translationX = offset.value + shiftPx
                        },
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) { measurables, constraints ->
                // 以**无约束**量：softWrap=false ＋ 宽度无限 ⇒ 量到的就是这一行的完整宽度
                val placeables = measurables.map { it.measure(Constraints()) }
                val width = placeables.first().width
                val height = placeables.maxOf { it.height }
                if (width > 0 && width != textWidthPx) textWidthPx = width
                layout(constraints.maxWidth, height) {
                    placeables.forEach { it.place(0, 0) }
                }
            }
        }
    }
}

/**
 * 底部「升级」卡（照参考图）：整卡就是主动作，副标题一行说清版本与状态。
 *
 */
@Composable
private fun UpgradeCard(
    state: UpdateState,
    version: String,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    val context = LocalContext.current
    val accent = state.phase == UpdatePhase.AVAILABLE || state.phase == UpdatePhase.READY

    Surface(
        onClick = when (state.phase) {
            UpdatePhase.READY -> onInstall
            // ERROR 有两种：检查失败（手里没有新版结论）与下载失败（有结论、包没下来）。
            // 前者必须重新「检查」，后者才「重新下载」—— 旧版一律走下载，
            // 而那时清单是空的 ⇒ 用户点「检查更新」四个字，界面一点反应都没有。
            UpdatePhase.AVAILABLE -> onDownload
            UpdatePhase.ERROR -> if (state.available) onDownload else onCheck
            else -> onCheck
        },
        enabled = state.actionEnabled,
        shape = RoundedCornerShape(14.dp),
        color = if (accent) Ui.BadgeContainer else MaterialTheme.colorScheme.surfaceVariant,
        contentColor = if (accent) Ui.BadgeContent else MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_drawer_upgrade),
                    contentDescription = null,
                    tint = if (accent) Ui.BadgeContent else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(22.dp),
                )
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(state.actionLabel, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                        if (isLocalAhead(state)) {
                            Spacer(Modifier.width(6.dp))
                            LocalAheadBadge()
                        }
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        upgradeSubtitle(state, version),
                        fontSize = 11.sp,
                        lineHeight = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    // 第三行：优先给「这次为什么没动」（被限频挡住 / 检查失败的具体原因），
                    // 没事时给「上次检查」的时间 —— 两者都不占主标题的位置。
                    val foot = state.error ?: state.checkedAt.takeIf { it > 0 }?.let { lastCheckedLabel(it) }
                    if (foot != null) {
                        Text(
                            foot,
                            fontSize = 10.sp,
                            lineHeight = 14.sp,
                            color = if (state.phase == UpdatePhase.ERROR) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                            },
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(Modifier.width(6.dp))
                Text("›", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (state.phase == UpdatePhase.DOWNLOADING) {
                val percent = state.progress
                if (percent == null) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }

    if (state.giveUp) {
        Spacer(Modifier.height(4.dp))
        Text(
            "下载连续失败，可稍后再试或去网盘下载",
            fontSize = 11.sp,
            lineHeight = 15.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(Modifier.fillMaxWidth()) {
            if (state.fallbackUrl.isNotBlank()) {
                TextButton(
                    onClick = { openExternally(context, state.fallbackUrl) },
                    modifier = Modifier.weight(1f),
                ) { Text("网盘下载", fontSize = 13.sp) }
            }
            TextButton(onClick = onDownload, modifier = Modifier.weight(1f)) {
                Text("再试一次", fontSize = 13.sp)
            }
        }
    }
}

/** 升级卡副标题：「当前版本 · 阶段结论」。一行装得下，长文案由界面截断。 */private fun upgradeSubtitle(state: UpdateState, version: String): String {
    val tail = when (state.phase) {
        // IDLE 也要读 error：冷启动的自动检查被 10 分钟窗口挡下时阶段仍是 IDLE，
        UpdatePhase.IDLE -> state.error ?: "未检查"
        UpdatePhase.CHECKING -> "检查中"
        // 本机比服务端新这件事交给标题旁的「内测版」徽章说，这里不再重复一句
        UpdatePhase.LATEST -> if (state.latest == null) "服务端没有发布记录" else "已是最新"
        UpdatePhase.AVAILABLE -> state.latest?.let { "有新版 $it" } ?: "有新版"
        UpdatePhase.DOWNLOADING -> state.progress?.let { "下载中 $it%" } ?: "下载中"
        UpdatePhase.READY -> "已下载，可安装"
        UpdatePhase.ERROR -> "检查失败"
    }
    return "当前 $version · $tail"
}

/**
 * 「上次检查 11-02 14:30」。
 *
 */
private fun lastCheckedLabel(checkedAt: Long): String =
    "上次检查 " + SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(checkedAt))

/**
 * 「内测版」徽章：本机这一份比服务端发布的更新（开发期自己装的测试包）。
 *
 */
@Composable
private fun LocalAheadBadge() {
    Surface(shape = RoundedCornerShape(6.dp), color = Ui.BadgeContainer, contentColor = Ui.BadgeContent) {
        Text(
            "内测版",
            fontSize = 10.sp,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/**
 * 本机版本是否比服务端发布的更新（开发期自行安装的测试包）。
 *
 */
private fun isLocalAhead(state: UpdateState): Boolean =
    Versions.compare(state.latest, state.current) == -1

// 抽屉的竖向节奏（R-212）：组间距必须**明显大于**行间距 —— 同行之间靠行内留白贴在一起，
// 组与组空开 20dp，分割线只出现在「顶部 / 中间 / 底部」三大块之间，颜色走 outlineVariant（很淡）。
private val DrawerGroupGap = 20.dp

@Composable
/**
 * 抽屉里的一行动作：整行可点（不是只有文字），左侧一枚 20dp 线稿图标。
 *
 */
private fun DrawerAction(
    @DrawableRes icon: Int,
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    /** 右侧小角标（未读数）；null = 不显示。 */
    badge: String? = null,
) {
    val tint = if (enabled) Ui.DrawerItemText else Ui.ButtonDisabledContent
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = text,
            fontSize = 15.sp,
            color = tint,
            modifier = Modifier.weight(1f),
        )
        if (badge != null) {
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.error) {
                Text(
                    badge,
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onError,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
    }
}

/**
 * 当前生效的那一项：**实心品牌底 ＋ 白字**（照参考图里的深色选中块）。
 *
 */
@Composable
private fun DrawerCurrentRow(@DrawableRes icon: Int, text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.primary)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onPrimary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = text,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onPrimary,
            modifier = Modifier.weight(1f),
        )
        Text("当前", fontSize = 11.sp, color = MaterialTheme.colorScheme.onPrimary)
    }
}

/** 占位动作：位置先占住、功能还没做 —— ⛔ 不做成可点，避免「看着能点却没反应」。 */
@Composable
private fun DrawerActionPlanned(@DrawableRes icon: Int, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            tint = Ui.ButtonDisabledContent,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = text,
            fontSize = 15.sp,
            color = Ui.ButtonDisabledContent,
            modifier = Modifier.weight(1f),
        )
        DrawerPlannedBadge()
    }
}

@Composable
private fun DrawerPlannedBadge() {
    Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Text(
            "规划中",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/**
 * 底部三列（照参考图）：左「账户」（头像 ＋ 名字），中「设置」，右「帮助」。
 *
 */
@Composable
private fun DrawerFooter(
    account: String,
    onAccount: () -> Unit,
    onSettings: () -> Unit,
    onHelp: () -> Unit,
    /** 登录页还没有当前账号：整列变灰、不可点。 */
    accountEnabled: Boolean = true,
    /** 登录页的连接信息就是表单本身：这一列同样变灰。 */
    settingsEnabled: Boolean = true,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(
            modifier = Modifier
                .weight(1f)
                .clip(RoundedCornerShape(12.dp))
                .clickable(enabled = accountEnabled, onClick = onAccount)
                .padding(horizontal = 6.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AccountAvatar(account, enabled = accountEnabled)
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    account.ifBlank { "账户" },
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (accountEnabled) LocalContentColor.current else Ui.ButtonDisabledContent,
                )
                Text(
                    "切换账号",
                    fontSize = 11.sp,
                    color = if (accountEnabled) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        Ui.ButtonDisabledContent
                    },
                )
            }
        }
        DrawerFooterItem(R.drawable.ic_drawer_settings, "设置", onSettings, enabled = settingsEnabled)
        DrawerFooterItem(R.drawable.ic_drawer_help, "帮助", onHelp)
    }
}

/** 账号头像：品牌底 ＋ 名字首字（没有账号时显示 Z）；[enabled] = false 时整体走灰。 */
@Composable
private fun AccountAvatar(account: String, enabled: Boolean = true) {
    val initial = account.trim().take(1).uppercase().ifBlank { "Z" }
    Surface(
        shape = CircleShape,
        color = if (enabled) MaterialTheme.colorScheme.primary else Ui.ButtonDisabledContent,
        modifier = Modifier.size(34.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                initial,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.surface,
            )
        }
    }
}

/** 底部那两列：图标在上、11sp 小字在下（与参考图的「设置 / 帮助」同构）。 */
@Composable
private fun DrawerFooterItem(
    @DrawableRes icon: Int,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    val tint = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else Ui.ButtonDisabledContent
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.height(2.dp))
        Text(label, fontSize = 11.sp, color = tint)
    }
}

/** 三大块之间的分割线：淡到只做分界、不参与视觉竞争。 */
@Composable
private fun DrawerDivider() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant, thickness = 1.dp)
}

/** 抽屉里的分区标题：字数少、颜色轻，用来分「连接 / 模式 / 更多」。 */
@Composable
private fun DrawerSection(text: String) {
    Text(
        text = text,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.6.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 10.dp, bottom = 2.dp),
    )
}

// ---------------------------------------------------------------- 主框架导航

/**
 * 门户登录完会跳到 `<fnid>.fnos.net`，此时换成 ZXDesk 登录页。
 * 只认「主框架、非 /app/zxdesk 路径」—— 本端加载 login.html 时 host 也是中继主机，别自己跳自己。
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
    if (host == entry.relayHost && !url.contains(entry.gatewayPath)) {
        onEnterZxDesk()
    }
}

/** 外链走系统浏览器；门户 / 中继 / 自家的地址一律留在 WebView 里。 */
private fun openExternally(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

/**
 * 是不是本应用的登录页（`<base><gatewayPath>/login.html`）。
 *
 */
private fun isGatewayLoginPage(entry: Entry, url: String): Boolean {
    val path = runCatching { Uri.parse(url).path }.getOrNull() ?: return false
    return path.trimEnd('/') == entry.gatewayPath.trimEnd('/') + "/login.html"
}

private fun isInternalHost(entry: Entry, host: String): Boolean {    val baseHost = runCatching { Uri.parse(entry.baseUrl).host }.getOrNull()
    if (host == baseHost || host == entry.relayHost) return true
    if (FnPortal.isPortalHost(host)) return true
    // 门户的静态资源与账号子站
    return host == "fnnas.com" || host.endsWith(".fnnas.com")
}

// ---------------------------------------------------------------- 状态与回调

private sealed interface Stage {
    data object Loading : Stage

    /**
     * 首帧已经画到屏幕上（`onPageCommitVisible`）。
     *
     */
    data object FirstPaint : Stage

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

/** 回前台时「停在错误页就自动重试」的最小间隔：比这更近的连续 ON_RESUME 不重复加载。 */
private const val AUTO_RETRY_INTERVAL_MS = 3_000L

/**
 * 静默启动时「登录跳板页 → 应用页」的最长等待。
 *
 */
private const val SPLASH_GATE_TIMEOUT_MS = 8_000L

/**
 * 平板上强制桌面版：给 URL 补一个 `?view=desktop`。
 *
 */
private fun startUrlOf(context: Context, url: String): String {
    if (url.contains("view=")) return url
    val smallest = context.resources.configuration.smallestScreenWidthDp
    if (smallest < 600) return url
    val sep = if (url.contains('?')) '&' else '?'
    val out = url + sep + "view=desktop"
    AppLog.i(TAG, "平板：强制桌面版 " + out)
    return out
}

/** logcat 标签（本文件的排障输出，⛔ 内容不上界面）。 */
private const val TAG = "WebViewScreen"

/** 桌面版空壳检测的延迟：太早会把「正在拉数据」误判成空壳，2.5 秒够首屏数据回来。 */
private const val SHELL_CHECK_DELAY_MS = 1_500L

/**
 * 桌面版是不是渲染成了空壳；是就降级到手机版重载一次。
 *
 */
private fun checkShell(view: WebView) {
    view.evaluateJavascript(SHELL_CHECK_JS) { raw ->
        val state = raw?.trim()?.trim('"').orEmpty()
        AppLog.i("Web", "桌面版检查：$state")
    }
}

/**
 * 空壳检测 / 降级脚本。
 *
 */
private const val SHELL_CHECK_JS: String = """(function(){try{
  var app=document.getElementById('app');
  if(!app) return 'no-app';
  var n=app.querySelectorAll('*').length;
  var t=(app.innerText||'').replace(/\s+/g,'');
  var r=app.getBoundingClientRect();
  var collapsed=(r.height<40||r.width<40);
  var hollow=(n<6&&t.length<8);
  if(!collapsed&&!hollow) return 'ok:'+n+':'+t.length;
  if(window.innerWidth<=768) return 'mobile-empty:'+n;
  var done=false;
  try{ done=sessionStorage.getItem('zx-mobile-fallback')==='1'; }catch(e){}
  if(done) return 'empty-already:'+n;
  try{ sessionStorage.setItem('zx-mobile-fallback','1'); }catch(e){}
  location.replace(location.pathname+'?view=mobile'+location.hash);
  return 'fallback:'+n;
}catch(e){return 'fail';}})()"""

/**
 * 页面诊断：一次取齐「这一页到底是什么」的全部关键量。
 *
 */
private const val DIAG_JS: String = """(function(){try{
  var d=document,w=window;
  var t=((d.body&&d.body.innerText)||'').replace(/\s+/g,' ').slice(0,40);
  return 'w='+(w.innerWidth||0)+' h='+(w.innerHeight||0)+
         ' dpr='+(w.devicePixelRatio||0)+
         ' app='+(d.getElementById('app')?1:0)+
         ' path='+(location.pathname||'')+
         ' text='+t;
}catch(e){return 'diag-fail';}})()"""

/** 网关探测的「快速期」：这段时间内每 4 tick 探一次，之后退到 12 tick（0.2.15 限频）。 */
private const val GATEWAY_PROBE_FAST_MS = 30_000L

/**
 *
 * 一屏会并发十几个接口请求，会话一失效它们是**一起** 401 的。这里按 2 秒去重只是别把
 */
private const val AUTH_LOST_DEDUP_MS = 2_000L

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
    /**
     * 会话失效的接管：返回 true 表示上层已经去续会话，别再加载登录页。
     *
     */
    onLoginRedirect: () -> Boolean,
    onStage: (Stage) -> Unit,
    onAskTrust: (PendingTrust) -> Unit,
    onMainFrame: (String?) -> Unit,
    onExternal: (String) -> Unit,
    /**
     * 主框架因**解析失败**打不开时的接管：上层去起本机代理，起来后重新加载这一页。
     *
     */
    onDnsFailure: (host: String, cacheFallback: () -> Boolean) -> Unit,
): WebViewClient = object : WebViewClient() {

    private val isGateway = entry.flow == EntryFlow.GATEWAY

    /** 是否已经试过「从磁盘缓存加载」（0.2.15）：只试一次，避免错误页 ↔ 重试的死循环。 */
    private var cacheRetryUsed = false

    /**
     * 是否已经为「解析不了域名」起过一次本机代理。
     *
     */
    private var proxyRetryUsed = false

    /**
     * 本次导航已经失败过。
     *
     */
    private var loadFailed = false

    /**
     * 首屏是否已经加载完过。
     *
     */
    private var bootPageDone = false

    /**
     *
     * 只做去重、不做节流补充 —— 上层 `reconnectSilently()` 自己还有 30 秒窗口，
     */
    private var lastAuthLostAt = 0L

    /** 网关流程里「还在飞牛页/门户」的阶段不算 app 页，不盖进度条。 */
    private fun isAppPage(url: String?): Boolean = url != null && url.contains(entry.gatewayPath)

    /**
     * 静默启动的**跳板页**：`login.html` 只是「检查登录状态」的中转，不是给人看的界面。
     *
     */
    private fun isSplashGate(url: String?): Boolean =
        entry.fnSession != null && url != null && isGatewayLoginPage(entry, url.substringBefore('?').substringBefore('#'))

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        loadFailed = false
        onMainFrame(url)
        // 兜底：JS 发起的整页导航不一定走 `shouldOverrideUrlLoading`（部分 ROM 如此），
        // 这里再拦一次。⛔ 首屏不算 —— 入口本身就是登录页。
        // **不再要求 `isGateway`**。局域网「IP ＋ 端口」访问同样得先有飞牛凭证 ——
        if (bootPageDone && isGatewayLoginPage(entry, url ?: "") && onLoginRedirect()) {
            AppLog.w(TAG, "登录页导航被拦下，先续会话")
            view?.stopLoading()
            return
        }
        if (isGateway && !isAppPage(url)) return
        onStage(Stage.Loading)
    }

    /**
     * 首帧上屏（API 23+）：这是「用户真的看见了内容」的唯一可靠时机。
     *
     */
    override fun onPageCommitVisible(view: WebView?, url: String?) {
        if (loadFailed) return
        if (isGateway && !isAppPage(url)) return
        // 静默启动的跳板页不算「画出来了」：启动动画继续盖着，等应用页真出现
        if (isSplashGate(url)) return
        // 这一页确实画出来了 ⇒ 上一次的「缓存只能救一次」就此结束，下一次断网还能再救。
        // 别在这里把 cacheMode 换回来：此刻子资源（ES 模块 / CSS）还在按序加载，
        cacheRetryUsed = false
        onStage(Stage.FirstPaint)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        // 首屏这一次（哪怕是失败页）已经过去 ⇒ 之后的登录页导航都算「页面自己跳的」
        bootPageDone = true
        // 前端按 `innerWidth > 768` 决定留在电脑版还是去手机版，而平板一宽就落到电脑版 ——
        // 那套布局没为矮屏平板适配过。日志里 w / dpr / path / 正文前 40 字，
        // 一眼能看出走的是哪套、页面是不是空壳，⛔ 不必再靠猜。
        view?.evaluateJavascript(DIAG_JS) { raw ->
            AppLog.i("Web", "页面诊断：" + raw.orEmpty().trim('"'))
        }
        if (view?.settings?.cacheMode == WebSettings.LOAD_CACHE_ELSE_NETWORK) {
            view.settings.cacheMode = WebSettings.LOAD_DEFAULT
        }
        if (loadFailed) return
        // 静默启动的跳板页加载完 ≠ 进应用：别在这里报 Content（会提前收启动动画）
        if (isSplashGate(url)) {
            // 但**正文判定不能省**：会话失效时网关在这一页给的就是纯文本 `invalid token`，
            // 不判就等于把「自动恢复会话」的入口堵死 —— 用户会停在一张写着 invalid token 的白屏上，
            AppLog.i(TAG, "静默启动：跳板页已加载，先确认会话是否还有效")
            probePage(view)
            return
        }
        if (isGateway && !isAppPage(url)) {
            // 门户 / 飞牛登录页加载完了：收起进度条，但不做 ZXDesk 正文判定
            onStage(Stage.Content)
            return
        }
        onStage(Stage.Content)
        probePage(view)
        // 桌面版空壳检测：平板走的是桌面版（前端按 innerWidth ≥ 1024 分流），
        // 整屏白，只有中间一条细线）。这里 2.5 秒后看一眼 `#app` 到底有没有东西，
        // 塌陷（高度 < 40）或者空得只剩个位数的节点，就记日志并**降级到手机版重载一次**。
        view?.postDelayed({ checkShell(view) }, SHELL_CHECK_DELAY_MS)
    }

    /**
     * 正文判定：网关对「未登录」回 200 + 纯文本 `invalid token`、对「要访问码」回它自己的网页 ——
     * 都只能看正文，不能看状态码。
     */
    private fun probePage(view: WebView?) {
        view?.evaluateJavascript(PageProbeJs.SCRIPT) { raw ->
            when (PageProbeJs.pageOf(raw)) {
                GatewayPage.ACCESS_CODE -> onAccessCodeRequired()
                GatewayPage.LOGIN_REQUIRED -> {
                    if (entry.fnSession != null) {
                        // 本端带着会话来的 ⇒ 会话过期了。交给上层用 longToken 换新的，
                        onSessionExpired()
                } else {
                    onStage(
                        Stage.Failed(
                            "需要先登录飞牛",
                            "飞牛网关要求先登录飞牛账号，之后才能打开 ZXDesk。\n\n" +
                                "改用局域网「IP ＋ 端口」访问也一样要这份凭证 —— 拿不到时网关回的就是这一页。" +
                                "点「重试」重新加载；若还停在这里，请回连接页填好飞牛账号与密码再连。",
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
        val code = error?.errorCode ?: 0
        // 断网兜底：网络层错误改走「完全走磁盘缓存」——
        // 服务端的静态资源是 `no-cache` + ETag，断网时条件请求必然失败，
        // WebView 按规范不会拿过期缓存顶（于是一张系统错误页）。
        val retryFromCache: () -> Boolean = {
            if (cacheRetryUsed || view == null) {
                false
            } else {
                cacheRetryUsed = true
                AppLog.w("Web", "网络错误 " + code + "，改走磁盘缓存重试一次")
                view.settings.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
                onStage(Stage.Loading)
                view.loadUrl(request.url.toString())
                true
            }
        }
        // 解析类失败**先**走本机代理：Chromium 有自己的负缓存，
        // 登录阶段绕过一次系统解析之后，进页面仍可能复发，这条兜底是必须的。
        // 排在缓存之前 —— 解析没通的时候，缓存重载只是白 reload 一次。
        if (code == ERROR_HOST_LOOKUP && !proxyRetryUsed) {
            proxyRetryUsed = true
            AppLog.w("Web", "解析失败，尝试改走本机代理")
            onDnsFailure(request.url.host.orEmpty(), retryFromCache)
            return
        }
        if (isNetworkLayerError(code) && retryFromCache()) return
        loadFailed = true
        onStage(
            Stage.Failed(
                if (isNetworkLayerError(code)) "现在连不上这台设备" else "打不开这个地址",
                buildString {
                    append(error?.description ?: "网络错误")
                    append("\n错误码 ")
                    append(code)
                    append("\n")
                    append(request.url)
                    if (isNetworkLayerError(code)) {
                        append("\n\n检查手机与这台设备是否在同一个网络；")
                        append("也可以从左边滑出连接面板换个地址。")
                    }
                },
            ),
        )
    }

    /**
     * 判断错误码是否属于「网络层不通」（区别于 HTTP 4xx/5xx 与证书问题）。
     *
     */
    private fun isNetworkLayerError(code: Int): Boolean =
        code == ERROR_HOST_LOOKUP || code == ERROR_CONNECT ||
            code == ERROR_TIMEOUT || code == ERROR_IO

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        response: WebResourceResponse?,
    ) {
        val status = response?.statusCode ?: 0
        if (request?.isForMainFrame != true) {
            // 子资源被拒也留一条（前端 fetch 的 `/api/*` 401 就是这里）：
            // 「点一下就回登录页」只能靠它定位到底是哪个接口 —— 只记路径，不记 query，
            // 那条串里可能带网关票据，日志不该留它
            if (status == 401) {
                AppLog.w("Web", "子资源 401：" + (request?.url?.path ?: "?"))
                // **会话失效的第一现场就在这里**，别等页面跳转那一步。
                // 前端拿到 401 会先弹一条底部红气泡（「登录已过期，请重新登录」），
                // 700ms 后才 `location.replace` 去登录页 ——「出现红气泡时没有静默重连」说的
                val now = System.currentTimeMillis()
                if (now - lastAuthLostAt > AUTH_LOST_DEDUP_MS) {
                    lastAuthLostAt = now
                    onLoginRedirect()
                }
            }
            return
        }
        if (status >= 400) {
            // 同 onReceivedError：这一页已经算失败，别再让随后的 onPageFinished 把错误卡片冲掉
            loadFailed = true
            onStage(Stage.Failed("服务器返回 HTTP $status", request.url.toString()))
        }
    }

    override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError) {
        val host = runCatching { Uri.parse(error.url).host }.getOrNull().orEmpty()
        val x509 = runCatching { error.certificate?.x509Certificate }.getOrNull()
        if (x509 == null) {
            handler.cancel()
            loadFailed = true
            onStage(Stage.Failed("读不到证书", "读不到证书，无法确认设备身份"))
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
                loadFailed = true
                onStage(
                    Stage.Failed(
                        "证书不属于本设备",
                        "${decision.reason}\n\n如果你确认连的是自己的 NAS，" +
                            "同一网段可能有设备占用这个地址",
                    ),
                )
            }
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val url = request?.url?.toString() ?: return false
        val host = request.url.host ?: return false
        if (isInternalHost(entry, host)) {
            // 其实他在本机已经登录过 —— 典型的「明明还在用，怎么又要登录」。
            // 只在主框架、且已经进过应用时拦（首次进入本来就该加载登录页）。
            if (request.isForMainFrame && isGatewayLoginPage(entry, url) && onLoginRedirect()) {
                return true
            }
            return false
        }
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
                            "在页面上登录飞牛后点下面进入"
                        slow -> "登录后点下面进入"
                        else -> "登录后会自动进入"
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
                        "证书指纹变了，重装或恢复出厂也会这样" +
                            "确认后不再询问。"
                    } else {
                        "第一次连这台设备，请核对指纹"
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
 *
 * 视觉：22dp × 64dp 圆角页签，浅品牌底（primary 14%）＋ 品牌色 `›`；
 */
@Composable
internal fun EdgeHandle(modifier: Modifier = Modifier, onClick: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    var nudge by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        delay(2_600)
        nudge = false
    }
    val offset by animateDpAsState(targetValue = if (nudge) 5.dp else 0.dp, label = "edgeHandleOffset")
    Box(
        modifier = modifier
            .width(40.dp)
            .height(104.dp)
            .clickable {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Surface(
            shape = RoundedCornerShape(topEnd = 12.dp, bottomEnd = 12.dp),
            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
            modifier = Modifier
                .offset(x = offset)
                .width(22.dp)
                .height(64.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    "›",
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}
