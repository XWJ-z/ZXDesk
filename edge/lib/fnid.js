/**
 * 功能：FNID 解析（二期方案 §二）—— 照自家 Android 实现移植（`Project/Android/core/connection`，
 *      2026-10-23 真机跑通），⛔ 不抄 Seek、⛔ 不「剥 `.fnos.net` 后缀」猜 FNID。
 *
 * 协议：`POST {端点}/api/v1/fn/con`，主 `https://5ddd.com`，备 `https://fnos.net`；8 s 超时。
 * 错误分类：`code!==0` ⇒ `fn_id_not_found`（⛔ 不再问备用端点）；`data` 无地址 ⇒
 * `fn_offline`；两条端点都失败 ⇒ `fn_unreachable`。
 *
 * ⛔ 纯逻辑 + 一个 fetch，不碰 `chrome.*`（Node 可单测）；请求通道与业务请求无关，
 *    解析服务不依赖 ZXDesk 会话，不需要 credentials。
 */
import { md5Hex } from './md5.js';

// ---- 常量（与 Android `FnIdSigner` 逐字一致，集中这里，⛔ 不要分散）----
export const CONNECT_PATH = '/api/v1/fn/con';
export const AUTHX_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
export const AUTHX_API_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c';
const CONNECT_SECRET = 'anna';
const PRIMARY_ENDPOINT = 'https://5ddd.com';
const FALLBACK_ENDPOINT = 'https://fnos.net';
const TIMEOUT_MS = 8000;
// 实测：本机 FNID 的 port 回 64999/64888，社区文档的 5666/5667 不通
export const DEFAULT_HTTPS_PORT = 64999;
export const DEFAULT_HTTP_PORT = 64888;

/** 功能：FNID 形状（Android 同款）：字母开头、总长 5~32、只含字母数字与 `-`、⛔ 不以 `-` 结尾。 */
export function isFnId(s) {
  const t = String(s ?? '').trim();
  return /^[a-zA-Z][a-zA-Z0-9-]{4,31}$/.test(t) && !t.endsWith('-');
}

async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 功能：`fn-sign` 头 = sha256("trim_connect`fnId`ts`anna")（小写十六进制）。 */
export async function fnSignHeader(fnId, timestamp) {
  return sha256Hex('trim_connect`' + fnId + '`' + timestamp + '`' + CONNECT_SECRET);
}

/** 功能：`authx` 头 = nonce=…&timestamp=…&sign=md5(prefix_path_nonce_ts_md5(body)_apiKey)。 */
export function authxHeader(timestamp, nonce, body, path = CONNECT_PATH) {
  const raw = [AUTHX_PREFIX, path, nonce, String(timestamp), md5Hex(body), AUTHX_API_KEY].join('_');
  return 'nonce=' + nonce + '&timestamp=' + timestamp + '&sign=' + md5Hex(raw);
}

/**
 * 功能：解析 FNID ⇒ 中继与端口。
 * @param {string} fnIdRaw - 调用方负责已识别为 FNID 的输入（这里兜底再转小写/校验）
 * @returns {Promise<{relay:string, httpsPort:number, httpPort:number}>} relay 已剥端口（如 `my-nas.fnos.net`）
 * @throws {{code:string}} `fn_id_invalid` / `fn_id_not_found` / `fn_offline` / `fn_unreachable`
 */
export async function resolveFnId(fnIdRaw) {
  const fnId = String(fnIdRaw ?? '').trim().toLowerCase();
  if (!isFnId(fnId)) throw { code: 'fn_id_invalid' };
  const body = JSON.stringify({ fnId });
  let lastErr = { code: 'fn_unreachable' };

  for (const endpoint of [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT]) {
    try {
      const ts = Date.now();
      const nonce = String(1_000_000 + Math.floor(Math.random() * 9_000_000)); // 6 位，Android 同款
      const res = await fetch(endpoint + CONNECT_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          authx: authxHeader(ts, nonce, body),
          'fn-sign': await fnSignHeader(fnId, ts),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = { code: 'fn_unreachable' };
        continue;
      }
      let root;
      try {
        root = JSON.parse(text);
      } catch (_e) {
        lastErr = { code: 'fn_unreachable' }; // 非 JSON（结构不对）⇒ 同 Android 的 Bad，换下一个端点
        continue;
      }
      const code = typeof root.code === 'number' ? root.code : Number(root.code) || 0;
      if (code !== 0) throw { code: 'fn_id_not_found' }; // FNID 错/已解绑：重试没有意义
      const data = root.data || {};
      const relay = (Array.isArray(data.fn) ? data.fn : [])
        .map((s) => String(s).split(':')[0]) // 形如 `my-nas.fnos.net:443`，先剥端口
        .filter(Boolean);
      const hasAnyAddr =
        relay.length > 0 ||
        ['ipv4', 'ipv6', 'publicIpv4', 'publicIpv6'].some((k) => Array.isArray(data[k]) && data[k].length > 0);
      if (!hasAnyAddr || !relay.length) throw { code: 'fn_offline' };
      const port = data.port || {};
      return {
        relay: relay[0],
        httpsPort: Number(port.httpsPort) || DEFAULT_HTTPS_PORT,
        httpPort: Number(port.httpPort) || DEFAULT_HTTP_PORT,
      };
    } catch (e) {
      if (e && (e.code === 'fn_id_not_found' || e.code === 'fn_offline' || e.code === 'fn_id_invalid')) throw e;
      lastErr = { code: 'fn_unreachable' }; // 超时 / DNS / TLS / 网络错 ⇒ 试下一个端点
    }
  }
  throw lastErr;
}

/** 功能：登录门户（未登录一律先开这里；中继根不是登录页，是灰屏的桌面壳）。 */
export function portalUrl(fnId) {
  return 'https://fnos.net/' + String(fnId).toLowerCase() + '/';
}
