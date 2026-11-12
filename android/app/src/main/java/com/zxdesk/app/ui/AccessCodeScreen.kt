/*
 * ZXDesk工作台 Android 客户端
 * 文件：AccessCodeScreen.kt
 * 职责：第 ④ 步，网关访问码页
 */

package com.zxdesk.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.zxdesk.app.log.AppLog
import com.zxdesk.app.net.WebViewProxy
import com.zxdesk.core.datasource.Entry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * 第 ④ 步：访问码。
 *
 * 「访问码」是**飞牛网关自己的页面**，本项目没有它的校验代码 ⇒
 * 底下直接把这个网关页原样显示出来，使用者按网关的提示输入；本端只在旁边判断「还在访问码页 → 已经过去了」。
 * ⛔ 不自己重造校验、⛔ 不去猜它的接口。
 *
 * 飞牛的闸门顺序是**先访问码、后密码**：网关先把整站拦住要访问码，通过之后才让到登录页。
 * 所以这一页可能看到三种东西：网关的访问码页 / 飞牛登录页 / 已经进了应用。
 *
 * ## 2026-11-03 修「输入访问码后一直循环加载」
 *
 * 三个原因叠在一起，缺一个都不会循环：
 * 1. **判定兜底错了**：`PageProbeJs` 原来最后一行是 `return 'APP'`，白屏 / 中继空壳 /
 *    Chrome 错误页全都算「应用页」⇒ 屏幕一白就算「访问码已通过」⇒ 自动跳走；
 * 2. **跳走之后必然被拒**：访问码并没真的过，[onEntered] 触发的重登又被网关 401 挡回来
 *    ⇒ 回到这一页 ⇒ 再白屏 ⇒ 再被判通过，转圈；
 * 3. **FNID 中继没种 `mode=relay`**：这段代码原来写在 `entry.fnSession?.let { }` 里，
 *    而「登录前被网关挡回来」这条路上 `fnSession` 是 null ⇒ 中继不认这次请求 ⇒ 白屏。
 *
 * 现在：白屏 / 认不出**一律不算通过**、中继无条件先种 `mode=relay`、加载失败要说出来、
 * 中继模式白屏 15 秒自动改加载站点根试一次，且自动通过**整轮只允许一次**（见 `AppViewModel.onAccessCodeDone`）。
 *
 * @param onEntered 回报「我认为已经过了访问码」。参数 true = 自动判定，false = 使用者点了按钮。
 *        **返回 false 表示上层没有接手**（例如自动判定这一轮已经用过），此时界面保持原样、等人工操作。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AccessCodeScreen(
    entry: Entry,
    onBack: () -> Unit,
    onEntered: (auto: Boolean) -> Boolean,
) {
    var webView by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }
    // ⚠️ 用 MutableState 而不是 `by remember`：轮询循环每轮都要读它，
    //    委托写法读到的是「本轮重组的快照」，状态一变就重启循环（永远攒不够两次确认）。
    val entered = remember { mutableStateOf(false) }

    /** 这一页**加载失败**（网络 / HTTP / 证书）：失败期间的任何正文都不算「过访问码」。 */
    var pageFailed by remember { mutableStateOf(false) }
    /** 给使用者看的一句诊断（null = 显示默认那句提示）。 */
    var hint by remember { mutableStateOf<String?>(null) }
    /** 本地只自动通过一次：上层即使没接手，也不要每 700ms 再问一遍。 */
    var autoTried by remember { mutableStateOf(false) }
    /** 解析不了时只给代理一次机会：起不来还重试就是「加载 → 失败 → 加载」的死循环。 */
    var proxyTried by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    /** 白屏起点（0 = 当前不是白屏）。 */
    var blankSince by remember { mutableStateOf(0L) }
    /** 中继白屏时改加载站点根，只试一次。 */
    var fallbackTried by remember { mutableStateOf(false) }
    /** 只放行一次（网关会跳好几跳，回调会来很多次）。上层的「过没过」由它决定。 */
    fun finishOnce(auto: Boolean) {
        if (entered.value) return
        CookieManager.getInstance().flush()
        val taken = onEntered(auto)
        AppLog.i(TAG, "访问码页判定：auto=$auto，上层接手=$taken，网关凭据=${gatewayCookieNames(entry)}")
        if (!taken) {
            hint = "这一轮已经自动判定过一次，请确认页面上显示已通过后点下面的按钮"
            return
        }
        entered.value = true
    }

    BackHandler { onBack() }

    // 登录阶段就判过「系统解析被绕过」：**这一屏也得把代理挂上**。
    // 访问码页是另一个 WebView（不是 `WebViewScreen` 那一个），只在那边接线的话，
    // 登录一过落到这一屏，网关页照样 ERR_NAME_NOT_RESOLVED —— 人卡在访问码上。
    LaunchedEffect(webView) {
        val view = webView ?: return@LaunchedEffect
        if (WebViewProxy.isActive() || !WebViewProxy.recentlyBypassed()) return@LaunchedEffect
        if (WebViewProxy.enable(context, hostOf(entry.zxDeskLoginUrl))) {
            AppLog.i(TAG, "访问码页改走本机代理")
            loadWithSession(view, entry, entry.zxDeskLoginUrl)
        }
    }

    // 判据不能只看一次 —— 网关从访问码页往下跳时会经过中间页，单次判定会把它当成
    // 「已经进去了」，于是自动重登又吃 401、又弹回这一页（0.2.17「反复加载」就是这么来的）。
    // 这里按标签分档：**只有真的看到应用页 / invalid token / 有正文的登录页**才攒计数，
    // 白屏（EMPTY）与认不出（UNKNOWN）一律清零。见 [PageProbeJs] 的表。
    LaunchedEffect(webView) {
        val view = webView ?: return@LaunchedEffect
        var quiet = 0
        while (isActive && !entered.value) {
            delay(PROBE_INTERVAL_MS)
            if (pageFailed) {
                quiet = 0
                continue
            }
            val label = view.probeLabel()
            // 白屏计时：中继不通时页面会一直是空白，得给一条出路，⛔ 不能让人对着白屏猜
            val blankNow = label == PageProbeJs.LABEL_EMPTY || label == PageProbeJs.LABEL_UNKNOWN
            if (blankNow) {
                if (blankSince == 0L) blankSince = System.currentTimeMillis()
                quiet = 0
            } else {
                blankSince = 0L
            }
            when (label) {
                PageProbeJs.LABEL_ACCESS_CODE -> {
                    quiet = 0
                    hint = null
                }
                // 真的进应用 / 网关明确回 invalid token：这是最硬的「已放行」证据
                PageProbeJs.LABEL_APP, PageProbeJs.LABEL_LOGIN_REQUIRED -> {
                    quiet += 1
                    if (!autoTried && quiet >= PROBE_CONFIRM_HARD) {
                        autoTried = true
                        finishOnce(auto = true)
                    }
                }
                // 有正文的登录页 / 门户页：多半是「访问码过了，网关跳到飞牛登录页」。
                // 但要更多次确认 —— 网关自己也有「正在校验…」这类过渡页，误判一次就是一轮循环。
                PageProbeJs.LABEL_OTHER -> {
                    quiet += 1
                    if (!autoTried && quiet >= PROBE_CONFIRM_SOFT) {
                        autoTried = true
                        finishOnce(auto = true)
                    }
                }
                else -> quiet = 0
            }

            // 中继白屏兜底：改加载站点根再试一次（网关会先把访问码页吐在那儿）
            val blankMs = if (blankSince == 0L) 0L else System.currentTimeMillis() - blankSince
            if (blankMs > BLANK_FALLBACK_MS && !fallbackTried && entry.relayHost != null) {
                fallbackTried = true
                blankSince = 0L
                AppLog.w(TAG, "访问码页白屏超过 ${BLANK_FALLBACK_MS}ms，改加载站点根重试：${entry.baseUrl}")
                hint = "网关页没加载出来，正在换个入口重试…"
                loadWithSession(view, entry, entry.baseUrl)
            } else if (blankMs > BLANK_FALLBACK_MS && fallbackTried) {
                // 换了入口还是白：把结论说出来，⛔ 别再让人对着白屏等
                hint = "网关页一直打不开。请返回连接页改用局域网地址，或换个网络再试"
            }
        }
    }

    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 2.dp),
        ) {
            TextButton(onClick = onBack) { Text("‹ 返回", fontSize = Ui.BodySize) }
            Spacer(Modifier.weight(1f))
            // 手动「继续」只在**出过问题**时出现（自动判定被拒 / 页面报过错）：
            // 平时只有「返回 / 刷新」两颗，⛔ 不再和网关页里的「确定」并排成两个大按钮
            // （老大 2026-11-03 22:31：「两个看着和怪」）。
            if ((autoTried || hint != null || pageFailed) && !entered.value) {
                TextButton(onClick = { finishOnce(auto = false) }) {
                    Text("继续", fontSize = Ui.BodySize)
                }
            }
            TextButton(onClick = { webView?.let { loadWithSession(it, entry, entry.zxDeskLoginUrl) } }) {
                Text("刷新", fontSize = Ui.BodySize)
            }
        }

        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Ui.Gutter),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("输入访问码", fontSize = Ui.TitleSize, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold)
            HintLine(hint ?: "输完点页面上的「确定」，会自动继续")
        }

        Box(
            modifier = Modifier.fillMaxWidth().weight(1f).padding(top = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            settings.setSupportMultipleWindows(false)
                            CookieManager.getInstance().setAcceptCookie(true)
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                            // 收窄高度后不要多一层 WebView 自己的白底，否则卡片外会套一圈白
                            setBackgroundColor(android.graphics.Color.TRANSPARENT)

                            webViewClient = object : WebViewClient() {
                                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                    loading = true
                                    // 换页就复位：上一页的失败不该永久堵住这一页
                                    pageFailed = false
                                    hint = null
                                }

                                // 这里只收进度条：正文判定统一交给上面那条轮询 ——
                                // onPageFinished 每跳一页都会来一次，拿它当判据正是旧版乱跳的原因。
                                override fun onPageFinished(view: WebView?, url: String?) {
                                    loading = false
                                    AppLog.i(TAG, "访问码页加载完：" + url.orEmpty().take(120))
                                    val v = view ?: return
                                    // ⭐ 加载完**立刻**判一次，不等 700ms 那轮轮询：
                                    //    访问码通过之后网关会先回一屏纯文本 `invalid token`，
                                    //    等到下一轮才判的话，这行字会明晃晃挂一秒多
                                    //    （老大 2026-11-03 22:47 的截图二就是这么来的）。
                                    //    在这里就切走，它基本来不及被看清。
                                    //    ⚠️ 只认 `APP` 与 `LOGIN_REQUIRED` —— 两者都是网关给出的确定答复；
                                    //    `OTHER`（登录页 / 过渡页）仍交给轮询攒够次数再判。
                                    quickCheck(v) { label ->
                                        if (!entered.value && !autoTried &&
                                            (label == PageProbeJs.LABEL_APP ||
                                                label == PageProbeJs.LABEL_LOGIN_REQUIRED)
                                        ) {
                                            autoTried = true
                                            finishOnce(auto = true)
                                        }
                                    }
                                    // 顶部是不是被裁：只检查、不居中（老大 23:07「就顶部显示全吧」）。
                                    // 两次：200ms 抓首帧后的布局，1.2s 补一次慢加载的样式。
                                    // 脚本自己带标记，重复调用不会重复加 padding。
                                    v.postDelayed({ fixTopClip(v) }, 200)
                                    v.postDelayed({ fixTopClip(v) }, 1_200)
                                }

                                override fun onReceivedError(
                                    view: WebView?,
                                    request: WebResourceRequest?,
                                    error: WebResourceError?,
                                ) {
                                    if (request?.isForMainFrame != true) return
                                    pageFailed = true
                                    val code = error?.errorCode ?: 0
                                    val desc = error?.description?.toString() ?: "网络错误"
                                    AppLog.w(TAG, "访问码页加载失败：$desc（错误码 $code）")
                                    // 解析类失败先给本机代理一次机会，⛔ 不直接把「换个地址」摆出来 ——
                                    // 域名解析不了换地址只是碰运气，代理才是对症的。
                                    if (code == WebViewClient.ERROR_HOST_LOOKUP && !proxyTried) {
                                        proxyTried = true
                                        val host = request.url.host.orEmpty()
                                        AppLog.w(TAG, "访问码页解析失败，尝试改走本机代理")
                                        scope.launch {
                                            if (WebViewProxy.enable(context, host)) {
                                                webView?.let { loadWithSession(it, entry, entry.zxDeskLoginUrl) }
                                            } else {
                                                hint = "网关页打不开：$desc。点「刷新」再试一次，或返回换个地址"
                                            }
                                        }
                                        return
                                    }
                                    hint = "网关页打不开：$desc。点「刷新」再试一次，或返回换个地址"
                                }

                                override fun onReceivedHttpError(
                                    view: WebView?,
                                    request: WebResourceRequest?,
                                    response: WebResourceResponse?,
                                ) {
                                    if (request?.isForMainFrame != true) return
                                    val status = response?.statusCode ?: 0
                                    if (status < 400) return
                                    pageFailed = true
                                    AppLog.w(TAG, "访问码页 HTTP $status：" + (request.url?.path ?: "?"))
                                    hint = "网关返回 HTTP $status，点「刷新」再试一次"
                                }

                                override fun onReceivedSslError(
                                    view: WebView?,
                                    handler: SslErrorHandler,
                                    error: SslError?,
                                ) {
                                    // 访问码页走的是中继 / 网关证书，不该在这里弹 TOFU ——
                                    // 浏览器级证书问题直接说清、让人换地址，⛔ 不静默 proceed
                                    handler.cancel()
                                    pageFailed = true
                                    val host = runCatching { Uri.parse(error?.url).host }.getOrNull().orEmpty()
                                    AppLog.w(TAG, "访问码页证书被拒：$host")
                                    hint = "证书校验没通过（$host），请从连接页换个地址"
                                }
                            }

                            // ⭐ 中继凭据**无条件**先种：这段原来在 `fnSession?.let { }` 里，
                            //    而「登录前被网关挡回来」这条路上 fnSession 是 null ⇒ 中继不认 ⇒ 白屏。
                            loadWithSession(this, entry, entry.zxDeskLoginUrl)
                        }
                    },
                    update = { webView = it },
                    /**
                     * ⭐ 0.3.1：与 `WebViewScreen` 同一处坑 —— `AndroidView` 不销毁 WebView。
                     * 访问码页是登录流程里**建得最勤**的一屏（每次要码都新开一个），
                     * 不拆掉就是每输一次访问码留一个还在跑 JS 的实例。
                     * 顺序：停加载 → 摘 client（切断回调）→ 摘出视图树 → destroy → 置空引用。
                     */
                    onRelease = { view ->
                        webView = null
                        runCatching {
                            view.stopLoading()
                            view.webViewClient = WebViewClient()
                            (view.parent as? ViewGroup)?.removeView(view)
                            view.destroy()
                        }
                    },
                )
                if (loading) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
                }
            }
        }
}


/**
 * 修「内容顶部被裁」——**只做这一件事，不居中**。
 *
 * 老大 2026-11-03 23:07：「也别显示居中了，就顶部显示全吧」。
 * 居中那套是我想多了：网关页本来就是一张贴顶的卡片，硬把它挪到中间反而引出裁切问题。
 *
 * 现在只量一件事：`body` 所有直接子元素的**最上沿**如果小于 0，说明内容真的被推到视口之上
 * （页面自己用了负 margin / translate 之类），此时补一段 `padding-top` 把它推回来；
 * 如果最上沿 ≥ 0，说明**没被裁**，一个字节都不动 —— 这种情况下卡片顶部没有圆角是页面原本的设计，
 * 不是我们切掉的（日志会打 `ok`，下次再怀疑就能直接看这一行）。
 *
 * ⚠️ 只写入一次（`data-zx-top` 标记），避免反复累加 padding 把内容越推越下。
 */
private fun fixTopClip(view: WebView) {
    view.evaluateJavascript(CLIP_JS) { result ->
        val state = result?.trim()?.trim('"').orEmpty()
        AppLog.i(TAG, "访问码页顶部检查：$state")
    }
}

/**
 * 顶部检查脚本：**只保证内容不被裁、不贴边，不居中**。
 *
 * 三种情况：
 * - `minTop < 0` ⇒ 内容被推到视口之上（页面用了负 margin / translate），补 `padding-top` 推回来 → `fixed:-N`
 * - `0 ≤ minTop < 8` ⇒ 没被裁，但紧贴着顶边，看着像被切；补 12px 让它离开边缘 → `pad`
 * - `minTop ≥ 8` ⇒ 页面自己留了边距，一个字节都不动 → `ok`
 *
 * ⚠️ 只写入一次（`data-zx-top` 标记）：反复调不能反复加 padding，否则内容会一次次往下掉。
 * ⚠️ **不碰圆角、不碰颜色**：如果补完还是直角，那就是网关页原本的设计（底部圆角、顶部直角），
 *    不是我们切掉的 —— 要不要改飞牛页面的外观，由老大定，⛔ 我不擅自改。
 */
private const val CLIP_JS: String = """(function(){try{
  var b=document.body; if(!b) return 'fail';
  if(b.getAttribute('data-zx-top')==='1') return 'ok';
  var minTop=Infinity,i,r;
  for(i=0;i<b.children.length;i++){
    r=b.children[i].getBoundingClientRect();
    if(r.height<=0) continue;
    if(r.top<minTop) minTop=r.top;
  }
  if(!isFinite(minTop)) return 'none';
  var cur=parseFloat(window.getComputedStyle(b).paddingTop)||0;
  if(minTop<0){
    b.style.setProperty('padding-top',(cur-minTop+12)+'px','important');
    b.setAttribute('data-zx-top','1');
    return 'fixed:'+Math.round(minTop);
  }
  if(minTop<8){
    b.style.setProperty('padding-top',(cur+12)+'px','important');
    b.setAttribute('data-zx-top','1');
    return 'pad';
  }
  return 'ok';
}catch(e){return 'fail';}})()"""

/** 从网址里取主机名；取不到返回空串（代理那边会跳过解析预检）。 */
private fun hostOf(url: String): String = runCatching { Uri.parse(url).host }.getOrNull().orEmpty()

private fun loadWithSession(view: WebView, entry: Entry, url: String) {
    if (entry.relayHost != null) {
        CookieManager.getInstance().setCookie(entry.baseUrl, RELAY_COOKIE)
    }
    entry.fnSession?.cookies(entry.relayHost)?.forEach { cookie ->
        CookieManager.getInstance().setCookie(entry.baseUrl, cookie)
    }
    CookieManager.getInstance().flush()
    view.loadUrl(url)
}

/** 本机 CookieManager 里给这台设备的凭据**名字**（⛔ 不打印值 —— 值等于会话）。 */
internal fun gatewayCookieNames(entry: Entry): String = runCatching {
    val raw = CookieManager.getInstance().getCookie(entry.baseUrl.trimEnd('/')).orEmpty()
    if (raw.isBlank()) {
        "（空）"
    } else {
        raw.split(';')
            .map { it.substringBefore('=').trim() }
            .filter { it.isNotEmpty() }
            .joinToString(",")
    }
}.getOrDefault("（读不到）")

private const val RELAY_COOKIE = "mode=relay; Path=/; Secure"

/** 读一次页面标签；WebView 只能在主线程调用，所以切到 Main 再等回调。 */
private suspend fun WebView.probeLabel(): String = withContext(Dispatchers.Main) {
    suspendCancellableCoroutine { cont ->
        evaluateJavascript(PageProbeJs.SCRIPT) { raw ->
            if (cont.isActive) cont.resume(PageProbeJs.labelOf(raw))
        }
    }
}

/** 轮询间隔：网关页「确定」之后通常 300~800ms 换页，这个节奏两跳内就能跟上。 */
private const val PROBE_INTERVAL_MS = 700L

/** 硬证据（应用页 / invalid token）连续多少次才算真的过了 —— 两次滤掉跳转中间页。 */
private const val PROBE_CONFIRM_HARD = 2

/**
 * 软证据（有正文的登录页 / 门户页）连续多少次才算过。
 *
 * 比硬证据多要几次：网关卡在访问码之后会先给一个「正在校验」过渡页，那也是「有正文的真网页」。
 * 误判一次的代价是整轮重登白跑一趟（还会被 401 送回来）。
 */
private const val PROBE_CONFIRM_SOFT = 5

/** 中继模式下页面白屏多久改加载站点根试一次。 */
private const val BLANK_FALLBACK_MS = 15_000L


/** 加载完立刻判一次页面标签（不等轮询），用于把 `invalid token` 那一屏尽快切走。 */
private fun quickCheck(view: WebView, onLabel: (String) -> Unit) {
    view.evaluateJavascript(PageProbeJs.SCRIPT) { raw -> onLabel(PageProbeJs.labelOf(raw)) }
}

/** logcat 标签（本文件的排障输出，⛔ 内容不上界面）。 */
private const val TAG = "AccessCode"
