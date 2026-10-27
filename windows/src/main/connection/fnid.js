/**
 * FNID 解析（移植自 `Project/Android/core/connection/{FnIdSigner,FnIdResolver,FnIdResponse}.kt`，
 * JS 侧先例 `Project/Edge/lib/fnid.js`）。协议常量集中在这里 —— 接口一旦变更只改这个文件。
 *
 * `POST https://5ddd.com/api/v1/fn/con`（备 `https://fnos.net`），8 秒超时。
 * `code != 0` ⇒ 直接「找不到这个 FNID」，**不重试备用端点**（重试只会让用户多等 8 秒）。
 */

export const CONNECT_PATH = '/api/v1/fn/con';
export const AUTHX_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
export const AUTHX_API_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c';
const CONNECT_SECRET = 'anna';
export const PRIMARY_ENDPOINT = 'https://5ddd.com';
export const FALLBACK_ENDPOINT = 'https://fnos.net';
export const TIMEOUT_MS = 8000;

/** 实测：FNID 的 `port` 回 64999/64888；社区文档的 5666/5667 在本机不通。 */
export const DEFAULT_HTTPS_PORT = 64999;
export const DEFAULT_HTTP_PORT = 64888;

/** `fn-sign` 头 = sha256("trim_connect`fnId`ts`anna")（小写十六进制）。 */
export async function fnSignHeader(fnId, timestamp) {
  return sha256Hex('trim_connect`' + fnId + '`' + timestamp + '`' + CONNECT_SECRET);
}

/** `authx` 头 = nonce=…&timestamp=…&sign=md5(prefix_path_nonce_ts_md5(body)_apiKey)。 */
export async function authxHeader(timestamp, nonce, body, path = CONNECT_PATH) {
  const raw = [AUTHX_PREFIX, path, nonce, String(timestamp), await md5Hex(body), AUTHX_API_KEY].join('_');
  return 'nonce=' + nonce + '&timestamp=' + timestamp + '&sign=' + (await md5Hex(raw));
}

async function digest(algorithm, text) {
  const bytes = new TextEncoder().encode(String(text));
  const buf = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(text) {
  return digest('SHA-256', text);
}

export function md5Hex(text) {
  return md5(String(text));
}

/** `POST /api/v1/fn/con` 的响应分类（`data` 字段见 `FnIdResponse.kt` 的真样本）。 */
export function parseFnIdResponse(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return { kind: 'bad', reason: '返回的不是合法 JSON' };
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { kind: 'bad', reason: '返回结构不是对象' };

  const code = toLong(root.code) ?? 0;
  const message = typeof root.msg === 'string' ? root.msg : '';
  if (code !== 0) return { kind: 'notFound', code, message };

  const data = root.data;
  if (!data || typeof data !== 'object') return { kind: 'bad', reason: '返回缺少 data' };

  const ports = data.port && typeof data.port === 'object' ? data.port : {};
  const addresses = {
    lanIpv4: strings(data.ipv4),
    lanIpv6: strings(data.ipv6),
    publicIpv4: strings(data.publicIpv4),
    publicIpv6: strings(data.publicIpv6),
    // `data.fn` 形如 `my-nas.fnos.net:443`，取主机（端口对中继无意义，永远是 443）
    relay: strings(data.fn)
      .map((s) => s.split(':')[0])
      .filter(Boolean),
    httpPort: toLong(ports.httpPort) ?? DEFAULT_HTTP_PORT,
    httpsPort: toLong(ports.httpsPort) ?? DEFAULT_HTTPS_PORT,
  };
  const empty =
    !addresses.lanIpv4.length &&
    !addresses.lanIpv6.length &&
    !addresses.publicIpv4.length &&
    !addresses.publicIpv6.length &&
    !addresses.relay.length;
  if (empty) return { kind: 'bad', reason: '这个 FNID 没有可用地址（设备可能离线）' };
  return { kind: 'ok', addresses };
}

function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

function toLong(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return null;
}

/**
 * 解析 FNID ⇒ 中继与端口。
 *
 * @param {string} fnIdRaw
 * @param {{fetchImpl?:Function, now?:Function, nonce?:string, endpoints?:string[], timeoutMs?:number}} options
 * @returns {Promise<object>} `parseFnIdResponse` 的 `addresses`
 * @throws {{code:string, message:string}}
 */
export async function resolveFnId(fnIdRaw, options = {}) {
  const fnId = String(fnIdRaw ?? '').trim().toLowerCase();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const endpoints = options.endpoints || [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT];
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!fnId || !/^[a-zA-Z][a-zA-Z0-9-]{4,31}$/.test(fnId)) throw { code: 'fn_id_invalid', message: 'FNID 格式不正确' };

  const body = JSON.stringify({ fnId });
  let lastError = null;

  for (const endpoint of endpoints) {
    const timestamp = now();
    const nonce = options.nonce || String(1_000_000 + Math.floor(Math.random() * 9_000_000));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint + CONNECT_PATH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authx: await authxHeader(timestamp, nonce, body),
            'fn-sign': await fnSignHeader(fnId, timestamp),
            // 与 Android 保持同一 UA：接口是逆向来的，UA 变了服务端行为可能跟着变
            'User-Agent': 'okhttp/4.12.0',
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        lastError = new Error(`FNID 服务器返回 HTTP ${response.status}`);
        continue;
      }
      const parsed = parseFnIdResponse(await response.text());
      if (parsed.kind === 'ok') return parsed.addresses;
      if (parsed.kind === 'notFound') {
        // code != 0：FNID 错 / 已解绑 —— 再问备用端点没有意义
        throw {
          code: 'fn_id_not_found',
          message: `找不到这个 FNID（${parsed.message || 'code=' + parsed.code}）`,
        };
      }
      lastError = new Error(parsed.reason);
    } catch (e) {
      if (e && e.code === 'fn_id_not_found') throw e;
      lastError = e;
    }
  }
  throw {
    code: 'fn_unreachable',
    message: '连不上 FNID 服务器，请检查网络后重试' + (lastError?.message ? `（${lastError.message}）` : ''),
  };
}

/** 官方 FN Connect 门户（`https://fnos.net/<fnid>/`）—— FNID 的登录入口。⛔ 中继根不是登录页。 */
export const PORTAL_HOST = 'fnos.net';
const PORTAL_ALT_HOST = '5ddd.com';

export function portalUrlFor(fnId) {
  return `https://${PORTAL_HOST}/${String(fnId).toLowerCase()}/`;
}

export function isPortalHost(host) {
  const h = String(host ?? '').toLowerCase();
  return h === PORTAL_HOST || h.endsWith('.' + PORTAL_HOST) || h === PORTAL_ALT_HOST || h.endsWith('.' + PORTAL_ALT_HOST);
}

// ---------------------------------------------------------------- md5（RFC 1321，纯 JS）

/**
 * 自带的 md5 实现（照 `Project/Edge/lib/md5.js` 的写法重写）：Node 的 `crypto.createHash('md5')`
 * 在某些 FIPS 构建里被禁，而 `crypto.subtle` 不支持 md5 —— 与其赌环境，不如自己带一份。
 */
export function md5(input) {
  const bytes = new TextEncoder().encode(String(input));
  return md5Bytes(bytes);
}

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;

export function md5Bytes(bytes) {
  const len = bytes.length;
  const withPad = ((len + 8) >>> 6) * 64 + 64;
  const buffer = new Uint8Array(withPad);
  buffer.set(bytes);
  buffer[len] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLen = len * 8;
  view.setUint32(withPad - 8, bitLen >>> 0, true);
  view.setUint32(withPad - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let offset = 0; offset < withPad; offset += 64) {
    for (let i = 0; i < 16; i += 1) M[i] = view.getUint32(offset + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[(i >>> 4) * 4 + (i % 4)]) | (F >>> (32 - S[(i >>> 4) * 4 + (i % 4)])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return [a0, b0, c0, d0]
    .flatMap((word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff])
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
