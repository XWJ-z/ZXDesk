/**
 * 导航白名单（任务单 §9.2 第 4 条）。
 *
 * 留在远程视图里的：当前 NAS 基址主机、中继主机、飞牛门户域（`fnos.net` / `5ddd.com` / `*.fnnas.com`）。
 * 其它一律交给系统浏览器（**只放行 http/https**，`file:` / `javascript:` 之类直接丢）。
 */

const ALWAYS_ALLOWED_HOSTS = ['fnos.net', '5ddd.com'];
const ALWAYS_ALLOWED_SUFFIXES = ['.fnos.net', '.5ddd.com', '.fnnas.com'];

/**
 * @param {string} url
 * @param {{baseUrl?:string, relayHost?:string|null}} context
 * @returns {boolean}
 */
export function isAllowedNavigation(url, context = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();

  const baseHost = hostOf(context.baseUrl);
  if (baseHost && (host === baseHost || host.endsWith(`.${baseHost}`))) return true;
  if (context.relayHost && host === String(context.relayHost).toLowerCase()) return true;
  if (ALWAYS_ALLOWED_HOSTS.includes(host)) return true;
  if (ALWAYS_ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // 本机回环（本地 mock / 调试）—— 仅开发期用，出包不影响生产数据
  if (host === '127.0.0.1' || host === 'localhost') return true;
  return false;
}

/** 能不能交给系统浏览器（只 http/https）。 */
export function canOpenExternal(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
