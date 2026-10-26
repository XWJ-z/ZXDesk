package com.zxdesk.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.webkit.CookieManager
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.zxdesk.core.connection.GatewayPage
import com.zxdesk.core.datasource.Entry

/**
 * 第 ④ 步：访问码。
 *
 * 「访问码」是**飞牛网关自己的页面**，本项目没有它的校验代码（任务单 §一）⇒
 * 底下直接把这个网关页原样显示出来，用户按网关的提示输入；我们只在旁边判断「还在访问码页 → 已经进去了」。
 * ⛔ 不自己重造校验、⛔ 不去猜它的接口。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AccessCodeScreen(entry: Entry, onBack: () -> Unit, onEntered: () -> Unit) {
    var webView by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }
    var entered by remember { mutableStateOf(false) }

    /** 只放行一次（页面可能触发多次 onPageFinished）。 */
    fun finishOnce() {
        if (entered) return
        entered = true
        CookieManager.getInstance().flush()
        onEntered()
    }

    BackHandler { onBack() }

    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 2.dp),
        ) {
            TextButton(onClick = onBack) { Text("‹ 返回", fontSize = Ui.BodySize) }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { webView?.reload() }) { Text("刷新", fontSize = Ui.BodySize) }
        }

        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Ui.Gutter),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("输入访问码", fontSize = Ui.TitleSize, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold)
            HintLine("飞牛网关要求先输入访问码。下面是网关自己的页面，按提示输入，完成后会自动继续。")
        }

        Box(Modifier.fillMaxWidth().weight(1f).padding(top = 12.dp)) {
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

                        // 会话 Cookie 必须在 loadUrl 之前种进去，否则网关又把我们当未登录
                        entry.fnSession?.let { session ->
                            if (entry.relayHost != null) {
                                CookieManager.getInstance().setCookie(entry.baseUrl, RELAY_COOKIE)
                            }
                            session.cookies(entry.relayHost).forEach { c ->
                                CookieManager.getInstance().setCookie(entry.baseUrl, c)
                            }
                            CookieManager.getInstance().flush()
                        }

                        webViewClient = object : WebViewClient() {
                            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                loading = true
                            }

                            override fun onPageFinished(view: WebView?, url: String?) {
                                loading = false
                                view?.evaluateJavascript(PageProbeJs.SCRIPT) { raw ->
                                    when (PageProbeJs.pageOf(raw)) {
                                        // 还在访问码页 / 页面还没内容：什么都不做，等用户输
                                        GatewayPage.ACCESS_CODE, GatewayPage.UNKNOWN -> Unit
                                        // 已经不是访问码页 ⇒ 进去了（或者网关根本没要），自动继续
                                        else -> finishOnce()
                                    }
                                }
                            }
                        }

                        loadUrl(entry.zxDeskLoginUrl)
                    }
                },
                update = { webView = it },
            )
            if (loading) {
                LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }

        Column(Modifier.fillMaxWidth().padding(horizontal = Ui.Gutter, vertical = 16.dp)) {
            PrimaryButton(text = "已输入完成", onClick = { finishOnce() })
        }
    }
}

private const val RELAY_COOKIE = "mode=relay; Path=/; Secure"
