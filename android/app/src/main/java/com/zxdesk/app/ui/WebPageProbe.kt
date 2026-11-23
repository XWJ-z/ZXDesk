/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.app.ui

import com.zxdesk.core.connection.GatewayPage

/**
 * 在 WebView 里判「当前这一页是什么」。
 *
 */
internal object PageProbeJs {
    const val SCRIPT: String = """(function(){try{
  if(document.getElementById('app')) return 'APP';
  var b=document.body;
  var t=(b?b.innerText:'').slice(0,4000);
  if(!t||!t.trim()){
    var hasForm=!!document.querySelector('input,form,button,textarea');
    return hasForm?'OTHER':'EMPTY';
  }
  if(/访问码|访问口令|access\s*code/i.test(t)) return 'ACCESS_CODE';
  if(/invalid\s*token/i.test(t)) return 'LOGIN_REQUIRED';
  return 'OTHER';
}catch(e){return 'EMPTY';}})()"""

    const val LABEL_APP = "APP"
    const val LABEL_ACCESS_CODE = "ACCESS_CODE"
    const val LABEL_LOGIN_REQUIRED = "LOGIN_REQUIRED"
    const val LABEL_OTHER = "OTHER"
    const val LABEL_EMPTY = "EMPTY"
    const val LABEL_UNKNOWN = "UNKNOWN"

    /** 原始标签（已去掉 JSON 引号、转大写）；空串 / 认不出时为 [LABEL_UNKNOWN]。 */
    fun labelOf(raw: String?): String {
        val text = raw?.trim()?.trim('"')?.uppercase().orEmpty()
        return if (text.isEmpty()) LABEL_UNKNOWN else text
    }

    /** 把 JS 回传的（JSON 带引号的）标签翻成 [GatewayPage]（给 `WebViewScreen` 用）。 */
    fun pageOf(raw: String?): GatewayPage = when (labelOf(raw)) {
        LABEL_APP -> GatewayPage.APP
        LABEL_ACCESS_CODE -> GatewayPage.ACCESS_CODE
        LABEL_LOGIN_REQUIRED -> GatewayPage.LOGIN_REQUIRED
        // `OTHER` / `EMPTY` 一律落到 UNKNOWN：两者都不是「已经进应用」的凭据。
        else -> GatewayPage.UNKNOWN
    }
}
