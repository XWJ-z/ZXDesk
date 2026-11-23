/**
 * gateway.js —— 飞牛「统一网关」入口的挂载前缀
 *
 * 功能：把「应用被挂在 `/app/zxdesk` 这样的前缀下」这件事**收敛到一个地方** ——
 * `GATEWAY_PREFIX`（来自 `cmd/main` 传进来的环境变量，未部署在网关下时为空串）、
 * `stripGatewayPrefix()`（请求进来时剥掉前缀）、`localUrl()`（我们自己发出去的 URL 再补回前缀）、
 * `gatewaySlashRedirect()`（把不带结尾斜杠的挂载点补成带斜杠的地址）。
 *
 * @author zx
 * @date   2026-09-13
 * @since 0.9.7
 * 相关：docs/公共/开发方案/07-统一网关入口.md、docs/公共/架构文档/12-部署与安全清单.md
 */
'use strict';

/**
 * 功能：把环境变量里的挂载前缀规整成「`/` 开头、不带结尾斜杠」的形式，空 / 根路径一律返回空串。
 * 说明：容错是刻意的 —— 前缀写成 `/app/zxdesk/`、`app/zxdesk`、`/` 都不该让应用起不来。
 * @param {string} raw - 原始前缀（通常来自 `process.env.GATEWAY_PREFIX`）
 * @returns {string} 规整后的前缀；不需要剥前缀时为空串
 */
function normalizeGatewayPrefix(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '/') return '';
  const withSlash = s.startsWith('/') ? s : '/' + s;
  return withSlash.replace(/\/+$/, '');
}

/** 飞牛统一网关的挂载前缀（`/app/zxdesk`）；局域网直连 / 测试下为空串 */
const GATEWAY_PREFIX = normalizeGatewayPrefix(process.env.GATEWAY_PREFIX);

/**
 * 功能：剥掉请求路径开头的挂载前缀，并把查询串原样带上。
 *
 * 说明：**只在路径等于前缀、或前缀后面紧跟一个 `/` 时才剥** ——
 *
 * @param {string} url - 请求的 URL（含查询串，形如 `/app/zxdesk/api/health?x=1`）
 */
function stripGatewayPrefix(url) {
  const raw = String(url || '/');
  if (!GATEWAY_PREFIX) return { path: raw, prefixed: false };
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const search = q < 0 ? '' : raw.slice(q);
  if (path === GATEWAY_PREFIX) return { path: '/' + search, prefixed: true };
  if (path.startsWith(GATEWAY_PREFIX + '/')) {
    return { path: path.slice(GATEWAY_PREFIX.length) + search, prefixed: true };
  }
  return { path: raw, prefixed: false };
}

/**
 * 功能：给一个**应用内**的绝对路径补上挂载前缀，用于我们自己发出的 `Location` 与页面内地址。
 * @param {string} path - 应用内路径，必须以 `/` 开头（如 `/login.html`）
 * @returns {string} 可以直接放进 `Location` 的地址
 */
function localUrl(path) {
  return GATEWAY_PREFIX + path;
}

/**
 * 功能：网关挂载点本身**不带结尾斜杠**时，回一个补斜杠的重定向地址。
 *
 * 说明：⚠️ 这一步是必须的 —— HTML 里的静态资源链接是**相对路径**（这样同一份文件在 `/` 与
 * `/app/zxdesk/` 下都对），而相对路径要靠 URL 的**结尾斜杠**算基准目录。
 * 飞牛入口配的 `url` 就是 `/app/zxdesk`（不带斜杠），不重定向的话 `/core/tokens.css`
 */
function gatewaySlashRedirect(url) {
  if (!GATEWAY_PREFIX) return null;
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (path !== GATEWAY_PREFIX) return null;
  return GATEWAY_PREFIX + '/' + (q < 0 ? '' : raw.slice(q));
}

/**
 * 功能：从**网关注入的请求头**里读出当前飞牛用户（没走网关时返回 null）。
 *
 * 说明：⭐⭐ 官方红线：「不要信任客户端传入的用户 ID，请使用网关鉴权 Header」——
 * 所以 uid 只认 `X-Trim-Userid`，⛔ 不接受查询串 / 请求体里的任何 uid。
 * 局域网直连、Windows / 安卓独立客户端都不经过网关 ⇒ 这里恒为 null。
 */
function gatewayUser(req) {
  const h = (req && req.headers) || {};
  const raw = h['x-trim-userid'];
  if (raw === undefined || raw === null || raw === '') return null;
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid < 0) return null;
  const admin = String(h['x-trim-isadmin'] || '').toLowerCase();
  return {
    uid,
    username: String(h['x-trim-username'] || ''),
    isAdmin: admin === '1' || admin === 'true',
  };
}

module.exports = {
  GATEWAY_PREFIX,
  normalizeGatewayPrefix,
  stripGatewayPrefix,
  localUrl,
  gatewaySlashRedirect,
  gatewayUser,
};
