/**
 * server.js —— ZXDesk工作台 飞牛原生应用 HTTP 服务（入口装配 + 路由派发）
 *
 * 功能：本文件是**入口与派发点**，只做五件事 ——
 *      1. 按顺序 require 运行期单例（`context.js`，它负责数据层初始化）与各路由模块；
 *      2. 端口与静态资源相关的常量化（`BASE_PORT`）；
 *      3. `API_ROUTES` 路由派发表：`/api/<第一段>` → 处理函数的唯一映射
 *         （0.5.0 起 = `LEGACY_API_ROUTES` 手写的那部分 + 已搬迁模块由 `modules/registry.js` 自动挂上的）；
 *      4. `handleApi`：解析 URL → 过鉴权闸门 → 交给路由表；
 *      5. `http.createServer` 与 `listen`（端口占用顺延 +1…+20）＋ ⭐ **统一网关通道**（见下）。
 *      ⭐ 另有**一处例外**：对话的 SSE 长连接（`GET /api/teamwork/stream`）不走路由表，
 *      而由 `moduleHook()` 从模块目录里取一个**可选钩子** —— 模块被删掉就回 404（见该函数的说明）。
 *
 * ⭐ **两个监听入口，一个处理函数**（0.3.5，/ 开发）：
 *    ① TCP 端口（默认 8990）—— 局域网直连、Windows 版、全部测试；
 *    ② 飞牛统一网关的 Unix Socket（`SOCKET_PATH`，`/app/zxdesk` 前缀挂在系统域名下）。
 *    飞牛一开强制 HTTPS，端口服务那条 iframe 会被浏览器按混合内容整块拦掉（打开空白），
 *    所以桌面入口改走网关；前缀的剥离与回填统一在 `gateway.js`，本文件只负责在**派发前剥一次**。
 *    ⚠️ 两条通道共用同一个进程与同一个 `handleRequest`，`GATEWAY_PREFIX` / `SOCKET_PATH` 未设置时
 *    第 ② 条整体不存在（行为与加网关前逐字一致）。
 *
 * ⚠️ 0.2.0 后本文件是**拆分的结果**（002 报告 §5.1 ①）：原来的 6 大职责已分家 ——
 *    HTTP 基建 → `http-util.js`、静态托管 → `static.js`、入参校验 → `validate.js`、
 *    时间口径 → `time-util.js`、运行期单例 → `context.js`、业务 handler → `routes/*`。
 *    **`API_ROUTES` 必须留在本文件** —— 它是唯一派发点，也是错误出口四条规则的落点。
 * ⚠️ **鉴权顺序是本文件最不能动的东西**：`GET /api/health` 与 `/api/auth/*` 必须在 401 闸门**之前**
 *    显式分派（否则未登录时连登录页与健康检查都拿不到）；**其余任何** `/api/*` 都必须在闸门**之后**
 *    （放前面就是漏鉴权）。`health` 因此故意**不在** `API_ROUTES` 表里。
 * ⚠️ ⭐ **不许硬 `require` 模块目录里的东西**（0.5.0/4）：唯一合法入口是
 *    `modules/registry.js` 的几组可选聚合，或 `moduleHook()` 那种「注册表 + `fs.existsSync`」的写法。
 *    硬 require 的后果是**「删目录验收」第 1 条直接失败**（`MODULE_NOT_FOUND`，应用起不来）。
 * ⚠️ 环境变量（由 `cmd/main` 传入，实际读取点在 `context.js`）：
 *    `ZXDESK_PORT` 基础端口（默认 8990，占用则顺延）、`DATA_DIR` 数据目录（data-share 第一个路径）、
 *    `TRIM_PKGVAR` 应用 data 目录（日志/兜底）、`TRIM_PKGETC` 应用配置目录、`ZXDESK_HOME` 应用 home、
 *    `GATEWAY_PREFIX` 统一网关挂载前缀（如 `/app/zxdesk`）、`SOCKET_PATH` 网关 Unix Socket 路径。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.1
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
const { logLine, runtime, store } = require('./context.js');
const { registry, routeTable } = require('../modules/registry.js');
const { serveStatic } = require('./static.js');

// ---- 环境 ----
const BASE_PORT = Number(process.env.ZXDESK_PORT || 8990);

/**
 * 功能：从模块目录里取一个**可选钩子文件** —— 模块被删掉（或还没搬完）时回 `null`。
 *
 * 说明：⭐ 0.5.0补的硬规矩：**核心（`server.js` / `store/**`）一律不许硬 `require`
 *      模块目录里的东西** —— 硬 require 的后果不是报错，而是**「删目录验收」第 1 条直接失败**：
 *      目录一移走，`require` 抛 `MODULE_NOT_FOUND`，应用**根本起不来**，
 *      后面那几条（少一个入口、接口 404）压根轮不到验。
 *      所以这里走「**注册表给目录**（模块不在清单里就回 null）+ `fs.existsSync`」两步，
 *      拿不到就回 `null`，由调用方把它变成一个**正常的 404**。
 *
 * ⚠️ 它只用于「不走 `API_ROUTES` 表」的那几个钩子（长连接）；普通接口一律由
 *    `routeTable()` 按 `module.json` 的 `apiPrefix` 自动挂上，不经过这里。
 *
 * @param {string} name - 模块名（`app/modules/` 下的目录名）
 * @param {string} rel - 相对模块目录的文件名（如 `stream.js`）
 * @returns {?Object} `require` 的结果；模块不在清单里、或文件不存在时为 null
 */
function moduleHook(name, rel) {
  const dir = registry.dirOf(name);
  if (!dir) return null;
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? require(p) : null;
}

/**
 * ⭐ 对话的 **SSE 长连接钩子**（`modules/teamwork/stream.js`）。
 * ⚠️ 它是本文件**唯一**一处触碰模块目录的地方，且必须是**可选**的：
 *    `teamwork` 模块被删掉时它是 `null`，那条长连接请求退化成 **404**（不是 500、也不会挂住不返回）。
 */
const teamworkStream = moduleHook('teamwork', 'stream.js');

/**
 * ⭐ 对话的**后台提醒**（`modules/teamwork/ticker.js`，0.6.x）。
 * ⚠️ 与 `teamworkStream` **同款的可选钩子**：模块被删掉时它是 `null`，这里一行都不做 ——
 *    「删掉 teamwork 模块 ⇒ 提醒随之消失」由此成立（方案 §九-10 的验收）。
 * ⛔ **不许改成硬 require**（那会让应用直接起不来）。
 * ⚠️ 它是本项目**第一个常驻定时器**：内部自己保证 `setInterval(60_000).unref()` 与逐账号隔离。
 *    启动点刻意放在这里（与 SSE 钩子并列）—— 它同样只依赖「注册表 + 文件在不在」，
 *    而且 `start()` 幂等、失败不抛。
 */
const teamworkTicker = moduleHook('teamwork', 'ticker.js');
if (teamworkTicker) {
  try {
    teamworkTicker.start();
  } catch (e) {
    // ⚠️ 提醒起不来**绝不能拖垮启动**：它是锦上添花的功能，而启动失败等于整个应用打不开。
    //    但也不能静默 —— 照 `context.js` 的口径把它写进启动日志。
    logLine('error', `对话后台提醒未能启动（对话本身不受影响）: ${(e && e.message) || String(e)}`);
  }
}

/**
 * 飞牛统一网关的 Unix Socket 路径（`${TRIM_APPDEST}/app.sock`，由 `cmd/main` 传进来）。
 * ⚠️ 为空时**不监听 Socket** —— 局域网直连、Windows 版与全部测试走的就是这条分支（行为与加网关前一致）。
 */
const SOCKET_PATH = String(process.env.SOCKET_PATH || '').trim();

/**
 * 功能：业务路由分派表 —— 把 `/api/<第一段>` 映射到对应处理函数，`handleApi` 命中后调用它并传入统一上下文。
 *
 * 说明：⭐ 业务路由表（0.1.3，审查报告 B4）：`/api/<第一段>` → 处理函数。
 *
 * 以前这里是 `handleApi` 里一长串串行 `if (parts[1] === ...)`，加课表那次已经出现到
 * `parts[1]`~`parts[5]` 五层嵌套；每加一类业务都要回来改同一个函数（改错的代价是**漏鉴权**）。
 * 现在「加一条业务」= 写一个 `(ctx) => ...` 处理函数 + 在这里加一行。
 *
 * ⚠️ **鉴权顺序是本文件最不能动的东西之一**（见 `handleApi`）：
 *    免登录的 `health` / `auth` 必须在 401 闸门**之前**，其余一律**之后**。
 *    所以 `admin` / `timetable` 出现在这张表里，本身就意味着它们已经被闸门拦过一道。
 * ⚠️ 表里**没有** `health`：它必须支持未登录访问，因此在 `handleApi` 里显式分派（见那里的注释）。
 * ⚠️ 处理函数统一收一个 `ctx`：`{ req, res, parts, url, method, user, uid }`。
 *    个别老处理函数（auth / admin / timetable）保留原参数表，这里用箭头函数适配 —— 它们的内部逻辑
 *    有独立的测试与历史，不为「签名统一」去重写。
 *
 * ⭐ **0.5.0 模块化重构**：本表是「**尚未搬进 `app/modules/` 的手写登记**」，已搬迁的模块由
 *    `routeTable()` 按各自 `module.json` 的 `apiPrefix` **自动挂上**（模块自己的 `routes.js` 导出
 *    `{ <顶层键>: handler }`）。同一个顶层键被两处同时登记会**启动即抛** —— 搬家时旧的那一行必须删掉。
 */
const LEGACY_API_ROUTES = {
  // ⭐ 首屏聚合（0.2.0 性能）：把原先 5 个请求 + N+1 个项目任务请求收成 1~2 个
  bootstrap: handleBootstrap,
  // ⭐ 0.4.5 首页看板：按日期区间取「任务 + 课程 + 硬件关注 + 收藏夹 / 消息概况」。
  //    ⚠️ 它不是某个模块的接口，而是**跨模块汇总**（课表 / 硬件 / 收藏夹 / 对话都读），
  //    所以处理函数住在 `routes/system.js` 而不是某个业务路由里。
  dashboard: handleDashboard,
  // ⭐ 0.9.1 各端最新版本检测（设置页「版本数据」栏）。
  //    ⚠️ 它在 401 闸门**之后**（载荷里带本机版本与「是不是测试版」的结论，属登录后才该看的信息），
  //    且**只在用户点「检查更新」时才被调用** —— 本软件唯一的对外联网点，许可协议 §四 有承诺。
  //    处理函数住在 `routes/system.js`（跨端的系统信息，不属任何模块）。
  versions: handleVersions,
  // ⚠️ 0.5.0起任务板的**七个**顶层键（`tasks` / `export` / `search` / `today-count` /
  //    `summary` / `projects` / `daily`）**都不在这张表里了**：它们由
  //    `modules/tasks/routes.js` 的导出键自动挂上，两处同时登记会**启动即抛**
  //    （`routeTable()` 的撞车检查）—— 这也正是「删掉模块目录之后那七条接口 404」的成因。
  // ⭐ 备份与恢复（0.2.1）：`import` 是**个人**导入；`backup` / `restore` 是**整体**备份与恢复，
  //    后两个在 `routes/backup.js` 里各自做管理员判定（鉴权强度与 `/api/admin/*` 一致）
  import: handleImportUser,
  backup: handleExportOrg,
  restore: handleRestoreOrg,
  // ⭐ 0.8.1：**记账数据迁移**—— 与 backup / restore 同一族
  //    （整库级动作、仅管理员，在函数内自判 `is_admin`）。
  //    ⚠️ 为什么键是 `migrate-ledger` 而不是挂到 `/api/admin/migrate-ledger` 下面：本表是
  //    `/api/<第一段>` → **唯一**一个处理函数，而 `admin` 那一键已经是 `routes/auth.js` 的
  //    `handleAdmin`（成员管理 / 数据位置）—— 两处同时登记会**启动即抛**，塞进那条前缀则会让
  //    账号路由同时管两件毫不相干的事。口径与 `routes/backup.js` 头部写的那段逐字一致。
  'migrate-ledger': handleMigrateLedger,
  // ⚠️ 0.3.5 对话（好友 / 会话 / 消息）的两条「不一样」仍然成立，只是它现在**住在模块目录里**
  //    （`modules/teamwork/`，0.5.0）：① 它是**跨账号**数据 —— 判权看 `teamwork_members`
  //    （谁在这个会话里）而不是 `user_id`；② 它还有一个**长连接端点** `GET /api/teamwork/stream`，
  //    那个**不在本表里**，而由下面的**可选钩子**分派（见 `moduleHook` 的说明）。
  //    ⚠️ `/api/teamwork` 这一行**已经删掉**了：那个前缀由 `modules/teamwork/routes.js` 的导出键
  //    自动挂上，两处同时登记会**启动即抛**（`routeTable()` 的撞车检查）。
  /**
   * 功能：路由适配器 —— 把统一上下文 `ctx` 折成 `handleAdmin` 的旧参数表。
   * @param {Object} c - 统一分派上下文
   * @returns {void}
   */
  admin: (c) => handleAdmin(c.req, c.res, c.parts, c.user),
  // ⚠️ 0.5.0起 `/api/timetable` 那一行**已经删掉**了：那个前缀由
  //    `modules/timetable/routes.js` 的导出键自动挂上，两处同时登记会**启动即抛**。
};

/** ⭐ 最终派发表 = 手写的那部分 + 已搬迁模块自动挂上来的部分（`/api/<第一段>` → 处理函数） */
const API_ROUTES = routeTable(registry, LEGACY_API_ROUTES);

/**
 * 功能：`/api/*` 的唯一入口 —— 解析 URL 与路径片段、取当前登录账号，先放行两个免登录入口，
 *      再过 401 闸门，最后按 `API_ROUTES` 表把请求分派给对应处理函数。
 *
 * 说明：处理顺序固定为三步：① 解析 URL / 路径片段 / 当前账号；② 鉴权分派；③ 查表路由。
 *
 * ⚠️ 鉴权顺序是这个文件最不能动的东西之一：`GET /api/health` 与 `/api/auth/*` 必须在这道
 *    401 闸门**之前**显式分派（否则未登录时连登录页与健康检查都拿不到），**其余任何** `parts[1]`
 *    都必须在闸门**之后**（放前面就是漏鉴权）。`health` 因此故意**不在** `API_ROUTES` 表里。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @param {string} urlPath - 请求的 URL（形如 `/api/projects/1/tasks?x=1`）
 * @returns {void}
 */
function handleApi(req, res, urlPath) {
  const url = new URL(urlPath, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const user = currentUser(req);

  // ---- 闸门之前：只允许「不看到任何人的数据」的两个入口 ----
  // ⚠️ 顺序是安全关键：这两条一旦挪到闸门之后，未登录就看不到登录页/健康检查；
  //    反过来说，**别的任何 `parts[1]` 都不许**在闸门之前分派（那就是漏鉴权）。
  if (method === 'GET' && parts[1] === 'health') return handleHealth(req, res, user);
  // /api/auth/*（免登录入口，必须在闸门之前）
  if (parts[1] === 'auth') {
    // ⭐ 009 报告 S3：**登出时把该账号已建立的 SSE 长连接一并断开** ——
    //    Cookie 是浏览器共享的，而**已经建好的长连接**不会因为 Cookie 被清掉就断开：
    //    「我在这台机器上登出了、另一个标签页还开着」那条连接会继续收消息。
    //    ⚠️ 走 `teamworkStream` **可选钩子**（与下面那条长连接分派同一个对象）：模块被删掉时它是 null，
    //    这里什么都不做、登出照常成功。改密 / 被重置走的是另一条路（`session_epoch` 复核，见 `stream.js`）。
    if (user && method === 'POST' && parts[2] === 'logout' && teamworkStream) teamworkStream.dropUser(user.id);
    return handleAuth(req, res, parts, user);
  }

  // ⭐ 数据闸门：业务接口一律要求登录。
  //    只做业务鉴权，**不管登录态之外的事** —— 也不存在任何「以他人身份访问」的入口。
  if (!user) return json(res, 401, { error: 'unauthorized' });

  // ⭐ 首登强制（服务端拦截 ① 的第二半）：内置管理员仍在使用公开初始凭据时，
  //    除 `/api/auth/*` 里那几个放行项之外**一律 403** —— 包括各模块接口、管理员接口与 SSE 长连接。
  //    ⚠️ 前端拿到 `must_setup` 会跳 `/setup.html`；静态页那一侧还有一道 302（见 `static.js`），
  //    两道缺一都能被绕过（只拦接口 ⇒ 能看见界面壳子；只拦页面 ⇒ 能直接打接口）。
  if (mustSetupUser(user)) return json(res, 403, { error: 'must_setup' });

  // ⭐ 0.3.5 对话的 **SSE 长连接** —— 必须在查 `API_ROUTES` 表**之前**分派。
  //    原因与 `/api/health` 同类：长连接不能走「处理完就 `res.end()`」的常规路径。
  //    ⚠️ 它在闸门**之后**（不是之前）：长连接推送的是账号自己的消息，
  //    放在闸门之前就是一条**匿名订阅**通道。⚠️ 上方 `!user` 的判断是它的安全前提，
  //    调整这两行的顺序前先把这句话读完。
  //    ⭐ 0.5.0：处理函数现在住在 `modules/teamwork/stream.js` 里，靠 `moduleHook` 取 ——
  //    模块被删掉时 `teamworkStream` 是 `null`，这里**回正常的 404**（不是 500、也不是挂住不返回）。
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
 *      ① 网关挂载点不带结尾斜杠 → 先 302 补斜杠（相对路径要靠它算基准目录，见 `gateway.js`）；
 *      ② ⭐ **剥掉统一网关的挂载前缀**（`/app/zxdesk/api/...` → `/api/...`）—— 只此一处，
 *         于是 `API_ROUTES` / `resolveStaticPath` / `PUBLIC_STATIC` 全都不用认识前缀；
 *      ③ 再按老规矩分派：`/api/*` 走 `handleApi`，其余走静态托管。
 *
 * ⚠️ 没设 `GATEWAY_PREFIX`（局域网直连 / Windows / 测试）时第 ①②步都是空操作，行为与加网关前逐字一致。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @returns {void}
 */
/**
 * ⭐ 全局安全响应头（009 报告 R3）：CSP 是**纵深防御** —— 本项目的 XSS 防线完全靠「每处 `innerHTML`
 *    都记得 `esc()`」的纪律（约 60 处），一处漏转义就是存储型 XSS（聊天还是跨账号内容）。
 *    有了它，即使漏了一处，脚本也执行不起来。
 *
 * ⚠️⭐ **刻意不写 `frame-ancestors`**（也不加 `X-Frame-Options`）：本应用是**被飞牛桌面 iframe 嵌入**的
 *    （`ui/config` 两个入口都是 `type: iframe`，见 `core/gateway.js`）—— 写成 `'none'` / `'self'`
 *    会让整个应用**打不开**（局域网直连那条路上同样被拦）。这一条是 CSP 定稿时最容易踩的坑。
 * ⚠️ `script-src` 里那两个 `sha256-…` 是**页面内两段内联入口脚本**的哈希（电脑版入口分流 / 手机版入口守卫）：
 *    它们没有 `src`，不放哈希就会被拦 —— 表现不是白屏，而是**功能退化**（`?view=mobile` 这类应急出口失效）。
 *    ⇒ **改了那两段脚本必须重算哈希**：`ttt/test/security-headers.test.js` 有断言钉住（漂移当场红）。
 *    ⚠️⭐ **0.9.1 补账**：0.8.74 改过 `index.html` 的入口脚本（加手机 UA 兜底）却没重算哈希，
 *    两个页面的哈希**都**已经对不上（手机版那份更早之前就漂了）—— 也就是说那两段内联脚本此前一直
 *    被 CSP 拦着不执行。本次按实测重算（`index.html` `N60SSqr…` / `mobile/index.html` `XT/+gt…`）。
 *    ⛔ 以后动内联脚本，跑一遍 `security-headers.test.js` 拿新哈希再贴回来。
 * ⚠️ `style-src` 的 `'unsafe-inline'` **必须留着**：全站约 140 处 `style="…"` 内联属性
 *    （看板的 `--c` 颜色、设置页说明段排版等），去掉不会报错但会**静默走形**。它只放开样式，不放开脚本。
 */
const CSP_DIRECTIVES = [
  `default-src 'self'`,
  `script-src 'self' 'sha256-N60SSqr9KHjFkHMqy+KYTjuYKc1g0MBGJKI+mAHLa80=' 'sha256-XT/+gtBgh54oia9ob5nR7Kd0bDwwwPx1YTkiYwuaW40='`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self'`,
  `font-src 'self'`,
  `connect-src 'self'`,
  `form-action 'self'`,
  `base-uri 'none'`,
  `object-src 'none'`,
];

function handleRequest(req, res) {
  const urlPath = req.url || '/';
  // ⭐ 安全响应头加在**这一层**：`handleRequest` 是两个 server（TCP 8990 + 网关 Socket）唯一的共同
  //    入口，连 302 / 404 / SSE 都覆盖，且不用改任何前端文件、也不碰静态托管的那几个出口分支。
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
 * 两个 server 共用 `handleRequest`，因而共用同一个进程里的数据库、SSE 连接登记表等全部状态。
 */
const gatewayServer = SOCKET_PATH ? http.createServer(handleRequest) : null;

/** Socket 是否已经就绪（只用于避免重复监听与重复打日志） */
let socketListening = false;

/**
 * 功能：监听统一网关的 Unix Socket（未设置 `SOCKET_PATH` 时什么都不做）。
 *
 * 说明：三件事都必须做 ——
 *      ① **先删掉可能残留的 socket 文件**（上一次没停干净时 `listen` 会 `EADDRINUSE`，官方示例同款做法）；
 *      ② 失败**只告警不退出**：局域网端口还好好的，飞牛桌面打不开时要能从日志看出是这条通道没起来；
 *      ③ 成功时把**前缀与 Socket 路径**一起写进日志 —— 真机排查「桌面打不开」时的第一眼依据。
 *
 * @returns {void}
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
 * ⚠️ **监听成功就立刻摘掉错误处理器**：错误处理器是 `once` 且**绑在 server 对象上**的，
 *    若留在那里，后面 Socket 监听失败时会被它当成「TCP 监听失败」再顺延一次端口（表现为
 *    莫名其妙地在 8991/8992 上又起一份监听），所以成功即摘、两条通道各管各的错误。
 *
 * @param {number} port - 本次尝试绑定的端口
 * @param {number} remaining - 还剩多少次顺延机会（初始为 20，每次重试减 1）
 * @returns {void}
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
    logLine('info', `ZXDesk 服务已启动: http://0.0.0.0:${port}（版本 ${APP_VERSION}）`);
    listenGatewaySocket(); // 端口起来了再挂网关通道（两条通道互不阻塞）
  });
}

listen(BASE_PORT, 20);
