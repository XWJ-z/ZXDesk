/**
 * gateway.js —— 飞牛「统一网关」入口的挂载前缀
 *
 * 功能：把「应用被挂在 `/app/zxdesk` 这样的前缀下」这件事**收敛到一个地方** ——
 *      `GATEWAY_PREFIX`（来自 `cmd/main` 传进来的环境变量，未部署在网关下时为空串）、
 *      `stripGatewayPrefix()`（请求进来时剥掉前缀）、`localUrl()`（我们自己发出去的 URL 再补回前缀）、
 *      `gatewaySlashRedirect()`（把不带结尾斜杠的挂载点补成带斜杠的地址）。
 *
 * ⚠️ **为什么需要它**（内测反馈）：飞牛的端口服务入口是「拿应用端口拼一个 http 地址塞进 iframe」，
 *    飞牛一开强制 HTTPS，桌面是 https 而 iframe 仍是 http ⇒ 浏览器按**混合内容**把整个子框架拦掉，
 *    打开就是一片空白（复现见 `ttt/tools/mixed-content-probe.js`）。统一网关让应用跑在系统访问域名下，
 *    https 天然成立 —— 代价是**请求路径多了一层前缀**，而这个前缀**飞牛不会替我们剥掉**
 *    （飞牛官方《统一网关》的转发示例就是 `GET /app/myapp/list`；官方 Native 示例因此把路由同时挂在
 *    `/` 与 `/app/notepad` 上）。
 *
 * ⚠️ **前缀只在这里读一次**：环境变量是进程级不变的，`cmd/main` 传什么就是什么。
 *    **没设 `GATEWAY_PREFIX` 时本模块全部退化成空操作** —— 局域网直连（`http://<IP>:8990`）、
 *    Windows 版与全部测试走的就是这条路，行为与加这个文件之前**逐字一致**。
 *
 * ⚠️ ⚠️ **这里剥前缀，前端补前缀，两件事必须成对**：光剥不补的话，页面里写 `/core/api.js`
 *    会打到**飞牛系统根目录**而不是应用（404）。前端的处理在 `public/core/api.js`（唯一 `BASE`）
 *    与各 HTML 的**相对路径**里，见开发。
 *
 * @author zx
 * @date   2026-09-13
 * @since 0.5.3
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
 *      否则 `/app/zxdeskfoo` 这种「前缀只是另一个路径的开头」会被误伤成 `/foo`。
 *
 * @param {string} url - 请求的 URL（含查询串，形如 `/app/zxdesk/api/health?x=1`）
 * @returns {{ path: string, prefixed: boolean }} 剥完之后的 URL；`prefixed` 表示这次请求确实走了网关前缀
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
 *      `/app/zxdesk/` 下都对），而相对路径要靠 URL 的**结尾斜杠**算基准目录。
 *      飞牛入口配的 `url` 就是 `/app/zxdesk`（不带斜杠），不重定向的话 `/core/tokens.css`
 *      会被算成 `/core/tokens.css`（丢了前缀）⇒ 整页白屏。
 *
 * @param {string} url - 原始的请求 URL
 * @returns {?string} 需要重定向时返回目标地址（含查询串），否则返回 `null`
 */
function gatewaySlashRedirect(url) {
  if (!GATEWAY_PREFIX) return null;
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (path !== GATEWAY_PREFIX) return null;
  return GATEWAY_PREFIX + '/' + (q < 0 ? '' : raw.slice(q));
}

module.exports = {
  GATEWAY_PREFIX,
  normalizeGatewayPrefix,
  stripGatewayPrefix,
  localUrl,
  gatewaySlashRedirect,
};
