/*
 * ZXDesk工作台 Android 客户端
 * 文件：WebPageProbe.kt
 * 职责：在 WebView 里判定当前页面类型，应用页、访问码页、未登录
 */

package com.zxdesk.app.ui

import com.zxdesk.core.connection.GatewayPage

/**
 * 在 WebView 里判「当前这一页是什么」。
 *
 * ⚠️ 为什么不让 JS 直接把正文文字传出来：`evaluateJavascript` 的回调是 **JSON 编码**的字符串，
 * 中文会被写成 `\u8bbf\u95ee\u7801`，Kotlin 侧拿到的根本不是「访问码」三个字 —— 直接 `contains` 永远不中。
 * 所以判定放在 JS 里做，只回 ASCII 标签。
 *
 * ⭐ 2026-11-02（「点任务就回登录页」）：判据先看**应用外壳在不在**，再看正文关键词。
 * 只看关键词会误伤 —— 任务、收藏夹、设置页里都可能出现「访问码」三个字，
 * 一旦命中就被当成网关的访问码页，界面切走再自动切回，表现就是「点一下页面刷新 / 回到登录」。
 * 应用页的根节点是 `#app`（两端 index.html 都有），网关访问码页**没有**它。
 *
 * ⭐⭐ 2026-11-03（「FNID 登录输入访问码后一直循环加载」）：**兜底标签不能是 `APP`**。
 * 旧脚本最后一行是 `return 'APP'` —— 任何「有正文但不认识」的页面都算应用页，
 * 包括中继的空白壳、Chrome 自己的错误页、网关的过渡页。而 `AccessCodeScreen` 把 `APP`
 * 当成「访问码已通过」的信号 ⇒ 白屏一两秒后自动跳走 → 重走登录 → 又被 401 挡回来
 * → 再白屏 → 再跳走，就是使用者看到的**无限循环**。
 *
 * 现在分五档，语义各自独立：
 * | 标签 | 含义 | 能不能算「访问码已通过」 |
 * | --- | --- | --- |
 * | `APP` | 有 `#app`，真的进应用了 | ✅ |
 * | `LOGIN_REQUIRED` | 网关回 `invalid token`，放行了但没会话 | ✅ |
 * | `OTHER` | 有正文的真网页（飞牛登录页 / 门户页） | ✅ 但要多次确认 |
 * | `ACCESS_CODE` | 网关的访问码页 | ❌ |
 * | `EMPTY` | 什么都没渲染（白屏 / 还在加载） | ❌ |
 * | `UNKNOWN` | 认不出（脚本异常 / 回调串了） | ❌ |
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
        // ⚠️ `OTHER` / `EMPTY` 一律落到 UNKNOWN：两者都不是「已经进应用」的凭据。
        //    `WebViewScreen.probePage` 对 UNKNOWN 是「什么都不做」，正是这里要的保守行为。
        else -> GatewayPage.UNKNOWN
    }
}
