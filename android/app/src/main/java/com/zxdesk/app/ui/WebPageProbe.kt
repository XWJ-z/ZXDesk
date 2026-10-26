package com.zxdesk.app.ui

import com.zxdesk.core.connection.GatewayPage

/**
 * 在 WebView 里判「当前这一页是什么」。
 *
 * ⚠️ 为什么不让 JS 直接把正文文字传出来：`evaluateJavascript` 的回调是 **JSON 编码**的字符串，
 * 中文会被写成 `\u8bbf\u95ee\u7801`，Kotlin 侧拿到的根本不是「访问码」三个字 —— 直接 `contains` 永远不中。
 * 所以判定放在 JS 里做，只回四个 ASCII 标签。
 */
internal object PageProbeJs {
    const val SCRIPT: String = """(function(){try{
  var t=(document.body?document.body.innerText:'').slice(0,4000);
  if(!t) return 'EMPTY';
  if(/访问码|访问口令|access\s*code/i.test(t)) return 'ACCESS_CODE';
  if(/invalid\s+token/i.test(t)) return 'LOGIN_REQUIRED';
  return 'APP';
}catch(e){return 'EMPTY';}})()"""

    /** 把 JS 回传的（JSON 带引号的）标签翻成 [GatewayPage]。 */
    fun pageOf(raw: String?): GatewayPage = when (raw?.trim()?.trim('"')) {
        "APP" -> GatewayPage.APP
        "ACCESS_CODE" -> GatewayPage.ACCESS_CODE
        "LOGIN_REQUIRED" -> GatewayPage.LOGIN_REQUIRED
        else -> GatewayPage.UNKNOWN
    }
}
