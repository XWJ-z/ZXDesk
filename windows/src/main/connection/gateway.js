/**
 * ZXDesk工作台 Windows 客户端
 * 文件：gateway.js
 * 职责：网关正文分类（移植自 `Project/Android/core/connection/GatewayProbe.kt` 的 `GatewayBody`）
 *
 * 顺序**不能反**：`invalid token` 是纯文本，最先判；「访问码」页也是 HTML，必须排在「应用页」之前 ——
 * 反了就会把访问码页当应用页直接进去，然后白屏。
 */

const INVALID_TOKEN = 'invalid token';
const ACCESS_CODE_MARKERS = ['访问码', '访问口令', 'access code', 'accesscode'];

export const GATEWAY_PAGE = Object.freeze({
  APP: 'APP',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  ACCESS_CODE: 'ACCESS_CODE',
  UNKNOWN: 'UNKNOWN',
});

/** 网关对未登录会话的 `/app/zxdesk` 下任意路径：200 + text/plain + 正文 `invalid token`。 */
export function isInvalidToken(body) {
  const head = String(body ?? '').trim().slice(0, 256);
  return head.toLowerCase().includes(INVALID_TOKEN) && !head.startsWith('<');
}

/** 真正的页面（HTML）才算通过。 */
export function isPage(body) {
  return String(body ?? '').trimStart().startsWith('<');
}

export function isAccessCode(body) {
  const head = String(body ?? '').slice(0, 20_000).toLowerCase();
  return ACCESS_CODE_MARKERS.some((marker) => head.includes(marker));
}

export function classifyGatewayBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) return GATEWAY_PAGE.UNKNOWN;
  if (isInvalidToken(text)) return GATEWAY_PAGE.LOGIN_REQUIRED;
  if (isAccessCode(text)) return GATEWAY_PAGE.ACCESS_CODE;
  if (isPage(text)) return GATEWAY_PAGE.APP;
  return GATEWAY_PAGE.UNKNOWN;
}

/**
 * 原生探测：GET `<base><gatewayPath>/login.html`，看正文属于哪一类。
 * 只是**弱信号**（没有 Cookie 可能被判成 UNKNOWN），真正判据在远程视图里的探针。
 *
 * @param {object} options
 * @param {Function} options.fetchImpl - 注入用（测试传假响应，不联网）
 */
export async function probeGateway({ baseUrl, gatewayPath = '/app/zxdesk', cookieHeader, fetchImpl, timeoutMs = 5000 }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /**
   * 兜底截止：`fetch` 实现万一对 `signal` 不敏感（或 DNS 卡死），这里也必须在有限时间内返回。
   * ⛔ 探测挂住会把登录卡在「登录中…」—— 0.2.4 真机就出现过这个观感。
   */
  let guard = null;
  const deadline = new Promise((resolve) => {
    guard = setTimeout(() => resolve(GATEWAY_PAGE.UNKNOWN), timeoutMs + 1000);
    if (typeof guard.unref === 'function') guard.unref();
  });
  try {
    const request = (async () => {
      const response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}${gatewayPath}/login.html`, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        // 用分区 `session.fetch` 时靠 Cookie 罐自动带凭据：显式 include，别落在默认的 same-origin 边界上
        credentials: 'include',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status !== 200) return GATEWAY_PAGE.UNKNOWN;
      return classifyGatewayBody(await response.text());
    })().catch(() => GATEWAY_PAGE.UNKNOWN);
    return await Promise.race([request, deadline]);
  } catch {
    return GATEWAY_PAGE.UNKNOWN;
  } finally {
    clearTimeout(timer);
    clearTimeout(guard);
  }
}

/**
 * 网页侧探针脚本（`executeJavaScript` 用）。
 *
 * ⭐ 判据先看**应用外壳在不在**，再看正文关键词（照 Android `PageProbeJs`）：
 * 只看关键词会误伤 —— 应用页里也可能出现「访问码」三个字，一旦命中就被当成网关的访问码页，
 * 界面切走再自动切回，表现就是「点一下页面刷新 / 回到登录页」。
 * 应用页的根节点是 `#app`（两端 index.html 都有），网关访问码页没有它。
 *
 * ⭐⭐ **兜底标签不能是 `APP`**（照 Android `PageProbeJs` 的同一处定论）：
 * 旧脚本最后一行是 `return 'APP'` —— 任何「有正文但不认识」的页面都算应用页，包括中继的空白壳、
 * Chromium 自己的错误页、网关的过渡页。而 `onProbe()` 把 `APP` 当成「这一轮真的进过应用」，
 * 于是随后的 `invalid token` 会被判成「用着用着掉线」⇒ 走静默恢复、不切屏 ⇒ 用户停在一张白页上。
 * 现在分五档，`OTHER` / `EMPTY` 一律落 `UNKNOWN`（＝什么都不做，等下一次判定）。
 *
 * 只回 ASCII 标签：中文经 `executeJavaScript` 回来是 `\uXXXX`，直接比字符串永远不中。
 */
export const PROBE_SCRIPT = `(function(){
  try {
    if (document.getElementById('app')) return 'APP';
    var b = document.body;
    var t = (b ? b.innerText : '');
    t = String(t || '').slice(0, 4000);
    if (!t || !t.trim()) {
      var hasForm = !!document.querySelector('input,form,button,textarea');
      return hasForm ? 'OTHER' : 'EMPTY';
    }
    if (/访问码|访问口令|access\\s*code/i.test(t)) return 'ACCESS_CODE';
    if (/invalid\\s*token/i.test(t)) return 'LOGIN_REQUIRED';
    return 'OTHER';
  } catch (e) { return 'EMPTY'; }
})()`;

/**
 * 探针回传值的分类。
 * 新脚本回五个标签；旧调用 / 测试若直接给正文，仍按正文分类（两套契约都认，⛔ 不二选一）。
 *
 * ⚠️ `OTHER` 与 `EMPTY` **都不是「已经进应用」的证据**，一律落 `UNKNOWN`：
 * `UNKNOWN` 在调用方是「保持现状」，而 `APP` 会把 `enteredApp` 置真、改变后续所有恢复路径的取舍。
 */
export function classifyProbeResult(raw) {
  const text = String(raw ?? '');
  const tag = text.trim().replace(/^"|"$/g, '').toUpperCase();
  if (tag === 'APP') return GATEWAY_PAGE.APP;
  if (tag === 'ACCESS_CODE') return GATEWAY_PAGE.ACCESS_CODE;
  if (tag === 'LOGIN_REQUIRED') return GATEWAY_PAGE.LOGIN_REQUIRED;
  if (tag === 'OTHER' || tag === 'EMPTY') return GATEWAY_PAGE.UNKNOWN;
  return classifyGatewayBody(text);
}
