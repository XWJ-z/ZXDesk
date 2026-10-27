/**
 * 更新链路的 URL 安全规则（纯函数）。
 *
 * 只放行 https。明文 http 只给本机回环（本地联调 / 自检）——
 * 版本清单与安装包都建立在「传输层没有被替换」这个前提上：
 * 一旦允许公网 http，中间人既能改版本号也能改 hash，SHA256 校验会跟着一起失效。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * @param {unknown} value
 * @returns {{ok:true, url:URL, loopback?:boolean}|{ok:false, reason:string}}
 */
export function checkUpdateUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return { ok: false, reason: '不是合法 URL' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: true, url, loopback: true };
  }
  return { ok: false, reason: `只允许 https（收到 ${url.protocol}//${url.hostname}）` };
}
