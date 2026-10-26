/**
 * 功能：输入识别（二期方案 §三）—— FNID / 域名 / IP / 完整 URL，判定顺序照 Android `InputParser`，
 *      **顺序不可改**：完整 URL → `[v6]:port` → `host:port` → 裸 IPv6 → IPv4 → 含 `.` 的域名 → FNID → 认不出。
 *
 * ⚠️ 已知取舍（照抄 Android）：`localhost` / `nas` 这类不带点不带端口的名字会命中 FNID 形状 ⇒
 *    按 FNID 处理；文案里提示「局域网请填 IP 或带端口」。
 * ⚠️ 「中继域名」≠ FNID：`my-nas.fnos.net` 走 host 直连路径，`my-nas` 走 fn/con 解析，两条路并存、互相不猜。
 *
 * ⛔ 纯函数、不碰 `chrome.*` —— UI 与 SW 共用这一份。
 */
import { isFnId } from './fnid.js';

/**
 * @param {string} raw - 用户输入
 * @returns {{kind:'host', origin:string, gatewayHint:boolean}
 *          |{kind:'fnid', id:string}
 *          |{kind:'invalid', error:'fn_id_invalid'}
 *          |null} `null` ⇒ 一律按 `address_invalid` 报
 */
export function parseInput(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!text) return null;

  // 1. 完整 URL（http/https）
  if (/^https?:\/\//i.test(text)) return fromUrl(text);

  // 2. [v6]:port
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    const host = text.slice(1, end);
    if (!isIpv6(host)) return null;
    const rest = text.slice(end + 1);
    let port = '';
    if (rest.startsWith(':')) {
      if (!/^\d+$/.test(rest.slice(1))) return null;
      port = ':' + rest.slice(1);
    } else if (rest) return null;
    return { kind: 'host', origin: `http://[${host}]${port}`, gatewayHint: false };
  }

  const colons = (text.match(/:/g) || []).length;

  // 3. host:port
  if (colons === 1) {
    const idx = text.indexOf(':');
    const host = text.slice(0, idx);
    const port = text.slice(idx + 1);
    if (!host || !/^\d+$/.test(port)) return null; // 端口不是数字 ⇒ 认不出（Android 同口径）
    const scheme = isIpv4(host) ? 'http' : 'https';
    return { kind: 'host', origin: `${scheme}://${host}:${port}`, gatewayHint: false };
  }
  // 4. 裸 IPv6
  if (colons > 1) {
    if (!isIpv6(text)) return null;
    return { kind: 'host', origin: `http://[${text}]`, gatewayHint: false };
  }

  // 5. IPv4
  if (isIpv4(text)) return { kind: 'host', origin: `http://${text}`, gatewayHint: false };

  // 6. 含 `.` 的域名（允许带路径，如 `nas.xxx.com/app/zxdesk/`）
  if (text.includes('.')) return fromUrl('https://' + text);

  // 7. FNID（字母开头；形似但违规 ⇒ 专门的 fn_id_invalid 文案，别笼统报格式错）
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(text)) {
    if (isFnId(text)) return { kind: 'fnid', id: text.toLowerCase() };
    return { kind: 'invalid', error: 'fn_id_invalid' };
  }

  // 8. 认不出
  return null;
}

/** 功能：URL → host 目标；用户名密码 / 危险字符拒收（一期口径保留）。 */
function fromUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch (_e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (/[|*^]/.test(u.hostname)) return null;
  const gatewayHint = /\/app\/zxdesk(\/|$)/.test(u.pathname);
  return { kind: 'host', origin: u.origin, gatewayHint };
}

function isIpv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => p.length > 0 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255);
}

function isIpv6(text) {
  return (text.match(/:/g) || []).length >= 2 && [...text].every((c) => c === ':' || (('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F') || c === '.'));
}

/**
 * 功能：从 URL 推「链路类型」徽标（仅展示）。
 * @returns {'relay'|'lan'|'domain'} 飞牛中继域名 / 局域网直连（IP）/ 其它网关域名
 */
export function linkType(origin) {
  try {
    const { hostname } = new URL(origin);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) return 'lan';
    if (/\.(5ddd\.com|fnos\.net|fynas\.net)$/.test(hostname)) return 'relay';
  } catch (_e) {
    /* 解析不了按 domain 兜底 */
  }
  return 'domain';
}

export const LINK_LABEL = { relay: '飞牛中继', lan: '局域网', domain: '网关域名' };

/**
 * 0.1.4：FNID 分支的固定权限（apex 与子域各一条；中继 `<id>.fnos.net` 被 `*.fnos.net` 覆盖）。
 * 从 ui/conn-ui.js 搬来——设置页与两个壳都要按它判「已授权与否」，常量只此一份。
 */
export const FNID_ORIGINS = [
  'https://fnos.net/*',
  'https://*.fnos.net/*',
  'https://5ddd.com/*',
  'https://*.5ddd.com/*',
];

/**
 * 功能：输入 → 授权用 origins（host 一条 / FNID 四条；解析不了返回 null，invalid 原样带回）。
 * ⭐ 0.1.4 真机修：**必须把解析结果 `p` 一起带回去** —— 0.1.4 首版漏了它，`o.p.kind` 在连接第一行
 *    就 TypeError（UI 停在「连接中…」永不返回，真机表现＝连不上 NAS）。此后 `p` 是调用方
 *    唯一该用的解析结果，⛔ 不要再各解析一遍。
 * @returns {?{p:object, origins:string[]}|{invalid:string}}
 */
export function originsFor(parsed) {
  if (!parsed) return null;
  if (parsed.kind === 'invalid') return { invalid: parsed.error };
  return { p: parsed, origins: parsed.kind === 'fnid' ? FNID_ORIGINS : [parsed.origin + '/*'] };
}
