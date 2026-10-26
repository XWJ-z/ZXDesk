/**
 * 输入识别（移植自 `Project/Android/core/connection/InputParser.kt`，2026-10-25）。
 *
 * 判定顺序**不可改**（改了就会把域名当 FNID、把端口当主机）：
 * 完整 URL → `[v6]:port` → `host:port` → 裸 IPv6 → IPv4 → 含 `.` 的域名 → FNID → 认不出。
 *
 * ⚠️ 已知取舍（照抄 Android）：`localhost` / `nas` 这类不带点也不带端口的名字会命中 FNID 形状，
 *    ⇒ 按 FNID 处理；界面文案里提示「局域网请填 IP 或带端口」。
 *
 * 纯函数、不碰 Electron —— 主进程与测试共用这一份。
 */

/** FNID 形状：字母开头、总长 5~32、只含字母数字与 `-`、⛔ 不以 `-` 结尾。 */
export const FN_ID = /^[a-zA-Z][a-zA-Z0-9-]{4,31}$/;

export const TARGET_KIND = Object.freeze({ IP: 'IP', DOMAIN: 'DOMAIN', FNID: 'FNID', UNKNOWN: 'UNKNOWN' });

/** 用户的输入解析结果。host 的 `scheme` 只记「用户自己写了的」，没写就是 null。 */
export function parseInput(raw) {
  const text = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!text) return { kind: 'invalid', reason: '请输入 NAS 地址' };

  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { kind: 'invalid', reason: '地址格式不正确' };
    }
    if (!url.hostname) return { kind: 'invalid', reason: '地址里没有主机名' };
    const port = url.port ? Number(url.port) : null;
    return {
      kind: 'host',
      host: url.hostname,
      port: port && port > 0 ? port : null,
      scheme: url.protocol.replace(':', '').toLowerCase(),
      path: url.pathname && url.pathname !== '/' ? url.pathname : null,
      target: kindOf(url.hostname),
    };
  }

  // [fe80::1]:8990
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return { kind: 'invalid', reason: 'IPv6 地址缺少右方括号' };
    const host = text.slice(1, end);
    if (!isIpv6(host)) return { kind: 'invalid', reason: 'IPv6 地址格式不正确' };
    const rest = text.slice(end + 1);
    let port = null;
    if (rest) {
      if (!rest.startsWith(':')) return { kind: 'invalid', reason: '地址格式不正确' };
      const value = rest.slice(1);
      if (!/^\d+$/.test(value)) return { kind: 'invalid', reason: '端口不是数字' };
      port = Number(value);
    }
    return { kind: 'host', host, port, scheme: null, path: null, target: TARGET_KIND.IP };
  }

  const colons = (text.match(/:/g) || []).length;
  if (colons === 1) {
    const idx = text.indexOf(':');
    const host = text.slice(0, idx);
    const portText = text.slice(idx + 1);
    if (host && /^\d+$/.test(portText)) {
      return {
        kind: 'host',
        host,
        port: Number(portText),
        scheme: null,
        path: null,
        target: kindOf(host),
      };
    }
    // 端口不是数字：落到下面统一判（与 Android 一致，不在这里报「端口不是数字」）
  } else if (colons > 1 && isIpv6(text)) {
    return { kind: 'host', host: text, port: null, scheme: null, path: null, target: TARGET_KIND.IP };
  }

  if (isIpv4(text)) return { kind: 'host', host: text, port: null, scheme: null, path: null, target: TARGET_KIND.IP };
  if (text.includes('.')) {
    return { kind: 'host', host: text, port: null, scheme: null, path: null, target: TARGET_KIND.DOMAIN };
  }
  if (FN_ID.test(text) && !text.endsWith('-')) return { kind: 'fnid', id: text.toLowerCase() };
  return { kind: 'invalid', reason: '无法识别，请输入 IP、域名或 FNID' };
}

function kindOf(host) {
  return isIpv4(host) || isIpv6(host) ? TARGET_KIND.IP : TARGET_KIND.DOMAIN;
}

export function isIpv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => part !== '' && part.length <= 3 && /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function isIpv6(text) {
  const value = String(text);
  return (value.match(/:/g) || []).length >= 2 && /^[0-9a-fA-F:.]+$/.test(value);
}

/** FNID 形状（`Project/Edge/lib/fnid.js` 同款；集中一处，⛔ 别在多处重复写正则）。 */
export function isFnId(value) {
  const text = String(value ?? '').trim();
  return FN_ID.test(text) && !text.endsWith('-');
}
