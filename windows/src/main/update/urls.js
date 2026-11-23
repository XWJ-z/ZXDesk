/**
 * ZXDesk工作台 Windows 客户端
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
