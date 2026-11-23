/**
 * server.js —— ZXDesk工作台 飞牛原生应用 HTTP 服务（入口装配 + 路由派发）
 *
 * 功能：本文件是**入口与派发点**，只做五件事 ——
 * 1. 按顺序 require 运行期单例（`context.js`，它负责数据层初始化）与各路由模块；
 * 2. 端口与静态资源相关的常量化（`BASE_PORT`）；
 * 3. `API_ROUTES` 路由派发表：`/api/<第一段>` → 处理函数的唯一映射
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { APP_VERSION } = require('./storage.js');
const { GATEWAY_PREFIX, gatewaySlashRedirect, stripGatewayPrefix } = require('./gateway.js');
const { currentUser, handleAdmin, handleAuth, mustSetupUser } = require('./routes/auth.js');
const { fail, json, notFound } = require('./http-util.js');
const { handleBootstrap, handleDashboard, handleHealth, handleVersions } = require('./routes/system.js');
const { handleExportOrg, handleImportUser, handleRestoreOrg } = require('./routes/backup.js');
const { handleMigrateLedger } = require('./routes/migrate.js');
// 个人授权目录（跨模块的「我授权过哪些目录」汇总，挂核心不挂模块）
const { handleGrants } = require('./routes/grants.js');
const { dataDir, logLine, runtime, store } = require('./context.js');
// 数据位置的**授权体检**：每次启动查一次（官方口径：重启后要重新同步授权状态）
const locationAuth = require('./location-auth.js');
// 起不再按「授权清单」判当前位置：位置由安装时定死（默认位置由 data-share 安排、
// 自定义目录由 `cmd/install_callback` 交属主），两者都不在共享授权清单里，拿清单判必误报。
// `enforce: false` ⇒ 结论恒为 ok。⚠️ 模块与 health 里的 `auth` 字段都保留（前端还在读），
locationAuth.init({ dataDir, enforce: false, log: logLine });
const { registry, routeTable } = require('../modules/registry.js');
const { serveStatic } = require('./static.js');

// ---- 环境 ----
const BASE_PORT = Number(process.env.ZXDESK_PORT || 8990);

/**
 * 功能：从模块目录里取一个**可选钩子文件** —— 模块被删掉（或还没搬完）时回 `null`。
 *
 * 目录一移走，`require` 抛 `MODULE_NOT_FOUND`，应用**根本起不来**，
 * 后面那几条（少一个入口、接口 404）压根轮不到验。
 * 所以这里走「**注册表给目录**（模块不在清单里就回 null）+ `fs.existsSync`」两步，
 */
function moduleHook(name, rel) {
  const dir = registry.dirOf(name);
  if (!dir) return null;
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? require(p) : null;
}

/**
 * 对话的 **SSE 长连接钩子**（`modules/teamwork/stream.js`）。
 * 它是本文件**唯一**一处触碰模块目录的地方，且必须是**可选**的：
 */
const teamworkStream = moduleHook('teamwork', 'stream.js');

/**
 * 对话的**后台提醒**（`modules/teamwork/ticker.js`，0.6.x）。
 * 与 `teamworkStream` **同款的可选钩子**：模块被删掉时它是 `null`，这里一行都不做 ——
 */
const teamworkTicker = moduleHook('teamwork', 'ticker.js');
if (teamworkTicker) {
  try {
    teamworkTicker.start();
  } catch (e) {
    // 提醒起不来**绝不能拖垮启动**：它是锦上添花的功能，而启动失败等于整个应用打不开。
    // 但也不能静默 —— 照 `context.js` 的口径把它写进启动日志。
    logLine('error', `对话后台提醒未能启动（对话本身不受影响）: ${(e && e.message) || String(e)}`);
  }
}

/**
 * 飞牛统一网关的 Unix Socket 路径（`${TRIM_APPDEST}/app.sock`，由 `cmd/main` 传进来）。
 * 为空时**不监听 Socket** —— 局域网直连、Windows 版与全部测试走的就是这条分支（行为与加网关前一致）。
 */
const SOCKET_PATH = String(process.env.SOCKET_PATH || '').trim();

/**
 * 功能：业务路由分派表 —— 把 `/api/<第一段>` 映射到对应处理函数，`handleApi` 命中后调用它并传入统一上下文。
 *
 *
 * 以前这里是 `handleApi` 里一长串串行 `if (parts[1] === ...)`，加课表那次已经出现到
 * 现在「加一条业务」= 写一个 `(ctx) => ...` 处理函数 + 在这里加一行。
 */
const LEGACY_API_ROUTES = {
  bootstrap: handleBootstrap,
  // 首页看板：按日期区间取「任务 + 课程 + 硬件关注 + 收藏夹 / 消息概况」。
  // 它不是某个模块的接口，而是**跨模块汇总**（课表 / 硬件 / 收藏夹 / 对话都读），
  // 所以处理函数住在 `routes/system.js` 而不是某个业务路由里。
  dashboard: handleDashboard,
  // 各端最新版本检测（设置页「版本数据」栏）。
  // 它在 401 闸门**之后**（载荷里带本机版本与「是不是测试版」的结论，属登录后才该看的信息），
  // 且**只在用户点「检查更新」时才被调用** —— 本软件唯一的对外联网点，许可协议 §四 有承诺。
  versions: handleVersions,
  // 起任务板的**七个**顶层键（`tasks` / `export` / `search` / `today-count` /
  // `summary` / `projects` / `daily`）**都不在这张表里了**：它们由
  // `modules/tasks/routes.js` 的导出键自动挂上，两处同时登记会**启动即抛**
  // 后两个在 `routes/backup.js` 里各自做管理员判定（鉴权强度与 `/api/admin/*` 一致）
  import: handleImportUser,
  backup: handleExportOrg,
  restore: handleRestoreOrg,
  // **记账数据迁移**—— 与 backup / restore 同一族
  // （整库级动作、仅管理员，在函数内自判 `is_admin`）。
  // 为什么键是 `migrate-ledger` 而不是挂到 `/api/admin/migrate-ledger` 下面：本表是
  'migrate-ledger': handleMigrateLedger,
  // **个人授权目录**（设置页汇总 ＋ 加密信息选目录）。
  // 界面上只有一张清单（见 `store/methods/grants.js` 的文件头）。
  grants: handleGrants,
  // 对话（好友 / 会话 / 消息）的两条「不一样」仍然成立，只是它现在**住在模块目录里**
  // （谁在这个会话里）而不是 `user_id`；② 它还有一个**长连接端点** `GET /api/teamwork/stream`，
  // 那个**不在本表里**，而由下面的**可选钩子**分派（见 `moduleHook` 的说明）。
  // `/api/teamwork` 这一行**已经删掉**了：那个前缀由 `modules/teamwork/routes.js` 的导出键
  admin: (c) => handleAdmin(c.req, c.res, c.parts, c.user),
  // 起 `/api/timetable` 那一行**已经删掉**了：那个前缀由
  // `modules/timetable/routes.js` 的导出键自动挂上，两处同时登记会**启动即抛**。
};

/** ⭐ 最终派发表 = 手写的那部分 + 已搬迁模块自动挂上来的部分（`/api/<第一段>` → 处理函数） */
const API_ROUTES = routeTable(registry, LEGACY_API_ROUTES);

/**
 * 功能：`/api/*` 的唯一入口 —— 解析 URL 与路径片段、取当前登录账号，先放行两个免登录入口，
 * 再过 401 闸门，最后按 `API_ROUTES` 表把请求分派给对应处理函数。
 *
 * 说明：处理顺序固定为三步：① 解析 URL / 路径片段 / 当前账号；② 鉴权分派；③ 查表路由。
 *
 * 鉴权顺序是这个文件最不能动的东西之一：`GET /api/health` 与 `/api/auth/*` 必须在这道
 */
function handleApi(req, res, urlPath) {
  const url = new URL(urlPath, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const user = currentUser(req);
  // 给慢请求日志留个账号名（`res` 是这次请求独有的对象，不会串号）
  if (user) res.zxUser = user.username;

  // ---- 闸门之前：只允许「不看到任何人的数据」的几个入口 ----
  if (method === 'GET' && parts[1] === 'health') return handleHealth(req, res, user);
  // /api/auth/*（免登录入口，必须在闸门之前）
  if (parts[1] === 'auth') {
    // 009 报告 S3：**登出时把该账号已建立的 SSE 长连接一并断开** ——
    // 「我在这台机器上登出了、另一个标签页还开着」那条连接会继续收消息。
    // 走 `teamworkStream` **可选钩子**（与下面那条长连接分派同一个对象）：模块被删掉时它是 null，
    if (user && method === 'POST' && parts[2] === 'logout' && teamworkStream) teamworkStream.dropUser(user.id);
    return handleAuth(req, res, parts, user);
  }

  // 数据闸门：业务接口一律要求登录。
  // 只做业务鉴权，**不管登录态之外的事** —— 也不存在任何「以他人身份访问」的入口。
  if (!user) return json(res, 401, { error: 'unauthorized' });

  // 首登强制（服务端拦截 ① 的第二半）：内置管理员仍在使用公开初始凭据时，
  // 除 `/api/auth/*` 里那几个放行项之外**一律 403** —— 包括各模块接口、管理员接口与 SSE 长连接。
  // 前端拿到 `must_setup` 会跳 `/setup.html`；静态页那一侧还有一道 302（见 `static.js`），
  // 两道缺一都能被绕过（只拦接口 ⇒ 能看见界面壳子；只拦页面 ⇒ 能直接打接口）。
  if (mustSetupUser(user)) return json(res, 403, { error: 'must_setup' });

  // 对话的 **SSE 长连接** —— 必须在查 `API_ROUTES` 表**之前**分派。
  // 原因与 `/api/health` 同类：长连接不能走「处理完就 `res.end()`」的常规路径。
  // 它在闸门**之后**（不是之前）：长连接推送的是账号自己的消息，
  if (method === 'GET' && parts[1] === 'teamwork' && parts[2] === 'stream' && parts.length === 3) {
    if (!teamworkStream) return notFound(res);
    return teamworkStream.handleTeamworkStream(req, res, user, store);
  }

  const route = API_ROUTES[parts[1]];
  if (!route) return notFound(res);
  return route({ req, res, parts, url, method, user, uid: user.id });
}

// ---- HTTP 服务器 ----
/**
 * 功能：**唯一**的请求处理函数 —— 两个监听入口（TCP 端口 + 统一网关的 Unix Socket）共用它。
 *
 * 说明：处理顺序（顺序本身是正确性的一部分）：
 * ① 网关挂载点不带结尾斜杠 → 先 302 补斜杠（相对路径要靠它算基准目录，见 `gateway.js`）；
 * ③ 再按老规矩分派：`/api/*` 走 `handleApi`，其余走静态托管。
 */
const CSP_DIRECTIVES = [
  `default-src 'self'`,
  `script-src 'self' 'sha256-0FRBIaz8UV2R6hbM0QAnsVLsdJPZtug/O1RZ6yZG0dM=' 'sha256-XT/+gtBgh54oia9ob5nR7Kd0bDwwwPx1YTkiYwuaW40='`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self'`,
  `font-src 'self'`,
  `connect-src 'self'`,
  `form-action 'self'`,
  `base-uri 'none'`,
  `object-src 'none'`,
];

/** 慢请求阈值（毫秒）：超过就记一行 —— 「用户说卡」时先看日志里有没有它，比猜快得多 */
const SLOW_REQUEST_MS = 1000;

function handleRequest(req, res) {
  const startedAt = Date.now();
  const urlPath = req.url || '/';
  // 慢请求日志（可观测）：只记方法 / 路径 / 毫秒 / 账号名 ——
  // 不记查询串与请求体：正文与文件名都可能是秘密，日志是明文落盘的。
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    if (ms < SLOW_REQUEST_MS) return;
    const p = String(urlPath).split('?')[0];
    logLine('warn', `慢请求 ${req.method} ${p} ${ms}ms${res.zxUser ? `（账号「${res.zxUser}」）` : ''}`);
  });
  // 安全响应头加在**这一层**：`handleRequest` 是两个 server（TCP 8990 + 网关 Socket）唯一的共同
  // 入口，连 302 / 404 / SSE 都覆盖，且不用改任何前端文件、也不碰静态托管的那几个出口分支。
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES.join('; '));
  // 防「按内容嗅探 MIME」：静态托管的 MIME 表本来就齐全，加上它等于把类型钉死（零风险加固）
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const bare = gatewaySlashRedirect(urlPath);
    if (bare) {
      res.writeHead(302, { Location: bare });
      res.end();
      return;
    }
    const path = stripGatewayPrefix(urlPath).path;
    if (path.startsWith('/api/')) return handleApi(req, res, path);
    return serveStatic(req, res, path);
  } catch (e) {
    fail(res, e);
  }
}

const server = http.createServer(handleRequest);

/**
 * 统一网关用的第二个 server：⭐ **必须是另一个 `http.Server` 实例** ——
 * Node **不允许**同一个 server 调两次 `listen()`（`ERR_SERVER_ALREADY_LISTEN`，本机实测）。
 */
const gatewayServer = SOCKET_PATH ? http.createServer(handleRequest) : null;

/** Socket 是否已经就绪（只用于避免重复监听与重复打日志） */
let socketListening = false;

/**
 * 功能：监听统一网关的 Unix Socket（未设置 `SOCKET_PATH` 时什么都不做）。
 *
 * 说明：三件事都必须做 ——
 * ① **先删掉可能残留的 socket 文件**（上一次没停干净时 `listen` 会 `EADDRINUSE`，官方示例同款做法）；
 * ② 失败**只告警不退出**：局域网端口还好好的，飞牛桌面打不开时要能从日志看出是这条通道没起来；
 */
function listenGatewaySocket() {
  if (!gatewayServer || socketListening) return;
  socketListening = true;
  try {
    fs.rmSync(SOCKET_PATH, { force: true });
  } catch (_e) {
    /* 删不掉也无所谓：下面 listen 会给出真实原因 */
  }
  gatewayServer.once('error', (err) => {
    logLine(
      'error',
      `统一网关 Socket 监听失败: ${SOCKET_PATH}（${err.message}）—— 飞牛桌面里的入口会打不开，局域网端口不受影响`,
    );
  });
  gatewayServer.listen(SOCKET_PATH, () => {
    logLine('info', `统一网关 Socket 已就绪: ${SOCKET_PATH}（挂载前缀 ${GATEWAY_PREFIX || '（未设置，按根路径）'}）`);
  });
}

/**
 * 功能：监听端口 —— 基础端口被占用时自动顺延重试（最多 +20），全部失败则记日志并退出进程。
 *
 * **监听成功就立刻摘掉错误处理器**：错误处理器是 `once` 且**绑在 server 对象上**的，
 * 若留在那里，后面 Socket 监听失败时会被它当成「TCP 监听失败」再顺延一次端口（表现为
 * 莫名其妙地在 8991/8992 上又起一份监听），所以成功即摘、两条通道各管各的错误。
 */
function listen(port, remaining) {
  const onError = (err) => {
    server.removeListener('error', onError);
    if (err.code === 'EADDRINUSE' && remaining > 0) {
      logLine('warn', `端口 ${port} 被占用，尝试 ${port + 1}`);
      listen(port + 1, remaining - 1);
    } else {
      logLine('error', `监听失败: ${err.message}`);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, () => {
    server.removeListener('error', onError);
    runtime.port = port; // 回填真实端口，供 /api/health 上报（见 context.js 的 runtime 说明）
    // 启动即体检一次授权（异步、失败不影响服务起来）。⚠️ 必须在 `store` 打开之后：
    // 它要问的是「当前数据目录还在不在授权列表里」，而目录由索引决定。
    if (store) {
      locationAuth
        .checkAtStartup()
        .catch((e) => logLine('warn', `数据位置授权体检未完成: ${(e && e.message) || e}`));
    }
    logLine('info', `ZXDesk 服务已启动: http://0.0.0.0:${port}（版本 ${APP_VERSION}）`);
    listenGatewaySocket(); // 端口起来了再挂网关通道（两条通道互不阻塞）
  });
}

listen(BASE_PORT, 20);
