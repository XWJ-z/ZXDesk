/**
 * 版本接口客户端：拉取 `/api/version/windows` 并把响应校验成固定形状。
 *
 * 传输层由调用方注入（生产用 Electron 的 `net.fetch`，测试传假的）——
 * 本文件不 import electron，所以能在没有显示器的机器上用 `node --test` 直接验。
 *
 * 接口契约见 `Project/server/update-api/README.md`：
 * `{ ok:true, data:{ platform, channel, version, hash, fileName, fileSize, downloadUrls, releaseNotes, force, minVersion, publishedAt } }`
 */

import { checkUpdateUrl } from './urls.js';
import { isValidVersion } from './version.js';

/** 线上版本检测接口（正式环境）。换地址改这里，或用 ZXDESK_UPDATE_URL 临时覆盖。 */
export const DEFAULT_API_URL = 'https://api.zxdesk.xwjznh.cn/api/version/windows';

/** 本端平台标识。 */
export const PLATFORM = 'windows';

/** 支持的发版通道。 */
export const CHANNELS = Object.freeze(['stable', 'beta']);

/** 缺 SHA256 的清单一律拒收：没有 hash 的包无法证明「下下来的就是发布的那份」。 */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 拼出接口地址（含 channel 参数）。
 * @param {string} baseUrl
 * @param {string} [channel]
 */
export function buildApiUrl(baseUrl, channel = 'stable') {
  const checked = checkUpdateUrl(baseUrl);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const value = CHANNELS.includes(String(channel)) ? String(channel) : 'stable';
  const url = checked.url;
  url.searchParams.set('channel', value);
  return { ok: true, url: url.href };
}

/**
 * 校验接口响应。任何一项不合格都整份拒收 —— 半份数据比没有数据更危险
 * （例如缺 hash 时若"宽容地"继续下载，就等于关掉了完整性校验）。
 *
 * @param {unknown} payload
 * @param {{platform?:string}} [options]
 */
export function parseLatest(payload, options = {}) {
  const platform = options.platform || PLATFORM;
  const bad = (reason) => ({ ok: false, kind: 'invalid', message: reason });

  if (!payload || typeof payload !== 'object') return bad('响应不是对象');
  if (payload.ok !== true) return bad(`接口返回失败：${payload.message || '未说明原因'}`);
  const data = payload.data;
  if (!data || typeof data !== 'object') return bad('响应缺 data');

  if (data.platform !== platform) return bad(`平台不匹配（期望 ${platform}，收到 ${data.platform}）`);
  if (!isValidVersion(data.version)) return bad(`版本号无法解析：${data.version}`);

  const hash = String(data.hash ?? '').trim().toLowerCase();
  if (!HASH_RE.test(hash)) return bad('缺 SHA256 或格式不对');

  const fileName = String(data.fileName ?? '').trim();
  if (!fileName) return bad('缺安装包文件名');

  const rawSize = Number(data.fileSize ?? 0);
  if (!Number.isFinite(rawSize) || rawSize < 0) return bad(`文件大小不合法：${data.fileSize}`);
  const fileSize = Math.trunc(rawSize);

  // 网盘兜底：客户端连续下载失败后引导手动更新。⛔ 只放行 http(s)，其它一律当没配
  const fallbackRaw = String(data.fallbackUrl ?? '').trim();
  const fallbackUrl = /^https?:\/\//i.test(fallbackRaw) ? fallbackRaw : '';

  const rawUrls = Array.isArray(data.downloadUrls) ? data.downloadUrls : [];
  const downloadUrls = rawUrls.map((item) => String(item ?? '').trim()).filter((item) => checkUpdateUrl(item).ok);
  if (downloadUrls.length === 0) return bad('没有可用的 https 下载地址');

  return {
    ok: true,
    info: {
      platform,
      channel: String(data.channel ?? ''),
      version: String(data.version).trim(),
      hash,
      fileName,
      fileSize,
      downloadUrls,
      fallbackUrl,
      notes: String(data.releaseNotes ?? ''),
      force: data.force === true,
      minVersion: String(data.minVersion ?? '').trim(),
      publishedAt: data.publishedAt ? String(data.publishedAt) : '',
    },
  };
}

/**
 * 拉取最新版本。
 *
 * @param {object} input
 * @param {string} input.url
 * @param {Function} input.fetchImpl - 与 `fetch` 同形（生产是 `net.fetch`）
 * @param {number} [input.timeoutMs]
 * @returns {Promise<
 *   {ok:true, info:object} |
 *   {ok:false, kind:'insecure'|'not-published'|'http'|'network'|'timeout'|'invalid', status?:number, message:string}
 * >}
 */
export async function fetchLatest({ url, fetchImpl, timeoutMs = 8000 }) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, kind: 'network', message: '没有可用的网络实现' };
  }
  const checked = checkUpdateUrl(url);
  if (!checked.ok) return { ok: false, kind: 'insecure', message: checked.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(checked.url.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number') {
      return { ok: false, kind: 'network', message: '网络实现没有返回响应' };
    }
    // 404 = 该端还没有发布记录。它和「已是最新」在界面上是同一个结论，不算错误。
    if (response.status === 404) return { ok: false, kind: 'not-published', status: 404, message: '还没有发布记录' };
    if (!response.ok) return { ok: false, kind: 'http', status: response.status, message: `HTTP ${response.status}` };

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, kind: 'invalid', message: '响应不是合法 JSON' };
    }
    return parseLatest(payload);
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'network',
      message: aborted ? `请求超时（${timeoutMs} 毫秒）` : error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
