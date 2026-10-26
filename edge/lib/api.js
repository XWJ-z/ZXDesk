/**
 * 功能：REST 封装 —— 超时、错误码归一（方案 §三）。⛔ 只有 SW（经 `sw.js` → `lib/*`）调这里，UI 一律走消息。
 *
 * ⭐ M0 真机裁决（2026-10-24，见任务单回单）：会话通道**只用 `credentials:'include'`**——
 * 扩展拿到 host 权限后浏览器自动带 Cookie；显式 `Cookie` 头是禁改头会被剥（L1 弃用）。
 * 探测还发现 `cookies.getAll({url})` 可能返回 0 条而 `cookies.get` 找得到 ⇒
 * 登录态判定**只认 health 的 `authenticated`**，不依赖自己拼头。
 */

const HEALTH_TIMEOUT = 3000;

/**
 * 功能：发一个 JSON 请求。
 * @param {string} url
 * @param {{method?:string, body?:object, timeout?:number}} [opt]
 * @returns {Promise<{status:number, data:object}>}
 * @throws {{code:'network'}} 超时 / DNS / TLS / 被拦
 * @throws {{code:'http_error', status:number, errorText?:string}} 4xx / 5xx（`errorText` = 服务端 error 字段，判「已经收藏过」用）
 * @throws {{code:'not_json'}} 200 但不是 JSON（被网关踢到登录页等）
 */
export async function fetchJson(url, opt = {}) {
  const { method = 'GET', body, timeout = HEALTH_TIMEOUT } = opt;
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'include', // ⭐ 唯一通道（M0 裁决）
      redirect: 'follow',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (_e) {
    throw { code: 'network' }; // TypeError（网络层）与 TimeoutError 都归 network
  }
  if (!res.ok) {
    let errorText = '';
    try {
      const t = await res.text();
      const d = JSON.parse(t);
      errorText = String((d && d.error) || '');
    } catch (_e) {
      /* 非 JSON 错误体就带空文案 */
    }
    throw { code: 'http_error', status: res.status, errorText };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    throw { code: 'not_json', status: res.status, contentType: res.headers.get('content-type') || '' };
  }
  return { status: res.status, data };
}

/**
 * 功能：`GET {base}/api/health` 的**唯一握手口**（免登录、能区分「不是 ZXDesk」、顺带回版本与登录态）。
 * @returns {Promise<{hit:boolean, authenticated?:boolean, html?:boolean, nasLogin?:boolean, accessCode?:boolean, version?:string, status?:number, error?:string}>}
 *   - `hit:true`          响应 JSON 且 `ok===true`（`authenticated` 随响应带出）
 *   - `nasLogin:true`     200 + `text/plain` 且正文含 `invalid token` —— **网关会话缺失**（D4：一期误判成 not_zxdesk）
 *   - `accessCode:true`   HTML 且含「访问码 / 访问口令 / access code」—— 网关访问码页
 *   - `html:true`         其它 HTML（被网关踢到飞牛页等）
 *   - 其余（404 / 非 JSON / 网络错）`hit:false`，尽力带 `status` / `error`
 */
export async function fetchHealth(base) {
  try {
    const res = await fetch(base + '/api/health', {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT),
    });
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      // 访问码页（先判，别笼统按「要登录」处理 —— 二期 D4）
      if (/访问码|访问口令|access\s*code/i.test(text)) return { hit: false, accessCode: true, status: res.status };
      return { hit: false, html: true, status: res.status };
    }
    if (contentType.includes('text/plain') && /invalid token/i.test(text)) {
      return { hit: false, nasLogin: true, status: res.status }; // D4：网关未登录的真实形态
    }
    try {
      const data = JSON.parse(text);
      if (data && data.ok === true) return { hit: true, authenticated: data.authenticated === true, version: data.version, status: res.status };
      return { hit: false, status: res.status };
    } catch (_e) {
      return { hit: false, status: res.status };
    }
  } catch (e) {
    return { hit: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
