/**
 * 选路（移植自 `Project/Android/core/connection/ConnectionPlanner.kt`）。
 *
 * 三条硬规则：
 * 1. **8990 永远明文**：用户写 `https://ip:8990` 也按 http 走（它是局域网救援端口）；
 * 2. **明文只允许私网**：公网地址给 `http://` 一律拒；
 * 3. **不写 scheme 时**：勾了 HTTPS 用 https，没勾用 `http://IP:8990`。
 */

import { isIpv4, isIpv6, TARGET_KIND } from './input.js';

export const DIRECT_PORT = 8990;
export const DEFAULT_GATEWAY_PATH = '/app/zxdesk';

/**
 * @returns {{ok:true, plan:{baseUrl:string, gatewayPath:string, cleartext:boolean, direct:boolean}}
 *          |{ok:false, reason:string}}
 */
export function planConnection(target, preferHttps = true) {
  if (!target || target.kind === 'invalid') return { ok: false, reason: target?.reason || '地址格式不正确' };
  if (target.kind === 'fnid') return { ok: false, reason: 'FNID 需要先解析，请检查网络后重试' };
  return planHost(target, preferHttps);
}

function planHost(t, preferHttps) {
  const host = t.host;
  if (!host) return { ok: false, reason: '地址不能为空' };
  const isIp = t.target === TARGET_KIND.IP;
  const gatewayPath = t.path && t.path.trim() ? t.path : DEFAULT_GATEWAY_PATH;

  // 规则 1：8990 一律明文直连
  if (t.port === DIRECT_PORT) {
    if (!isIp) return { ok: false, reason: '8990 是局域网直连端口，请填内网 IP' };
    if (!isPrivateAddress(host)) return { ok: false, reason: '8990 只用于局域网，公网请改用 HTTPS 或 FNID' };
    return {
      ok: true,
      plan: { baseUrl: `http://${host}:${DIRECT_PORT}`, gatewayPath, cleartext: true, direct: true },
    };
  }

  const scheme = t.scheme || (preferHttps ? 'https' : 'http');

  // 规则 2：明文只允许私网 IP
  if (scheme === 'http') {
    if (!isIp || !isPrivateAddress(host)) {
      return { ok: false, reason: '明文只允许局域网 IP，公网地址必须使用 HTTPS' };
    }
    const port = t.port || DIRECT_PORT;
    return {
      ok: true,
      plan: {
        baseUrl: `http://${host}:${port}`,
        gatewayPath,
        cleartext: true,
        direct: port === DIRECT_PORT,
      },
    };
  }

  const baseUrl = t.port ? `https://${host}:${t.port}` : `https://${host}`;
  return { ok: true, plan: { baseUrl, gatewayPath, cleartext: false, direct: false } };
}

/** 私网判定：10/8、172.16/12、192.168/16、169.254/16、127/8；IPv6 的 fc00::/7、fe80::/10、::1。 */
export function isPrivateAddress(host) {
  const text = String(host ?? '');
  if (text.toLowerCase() === 'localhost') return true;
  if (isIpv4(text)) {
    const [a, b] = text.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIpv6(text)) {
    const head = text.toLowerCase();
    return (
      head === '::1' ||
      head.startsWith('fc') ||
      head.startsWith('fd') ||
      head.startsWith('fe8') ||
      head.startsWith('fe9') ||
      head.startsWith('fea') ||
      head.startsWith('feb')
    );
  }
  return false;
}
