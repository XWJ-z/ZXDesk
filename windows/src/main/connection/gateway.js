/**
 * 网关正文分类（移植自 `Project/Android/core/connection/GatewayProbe.kt` 的 `GatewayBody`）。
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
  try {
    const response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}${gatewayPath}/login.html`, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status !== 200) return GATEWAY_PAGE.UNKNOWN;
    return classifyGatewayBody(await response.text());
  } catch {
    return GATEWAY_PAGE.UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}

/** 网页侧探针脚本（`executeJavaScript` 用）：取正文前 20 KB，交给主进程分类。 */
export const PROBE_SCRIPT = `(function(){
  try {
    var t = document.body ? document.body.innerText : '';
    return String(t || '').slice(0, 20480);
  } catch (e) { return ''; }
})()`;
