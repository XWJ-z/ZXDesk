/**
 * ZXDesk工作台 Windows 客户端
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
 */
export async function probeGateway({ baseUrl, gatewayPath = '/app/zxdesk', cookieHeader, fetchImpl, timeoutMs = 5000 }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /**
   * 兜底截止：`fetch` 实现万一对 `signal` 不敏感（或 DNS 卡死），这里也必须在有限时间内返回。
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
