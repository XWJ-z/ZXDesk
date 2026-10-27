/**
 * routes/system.js —— 系统级路由（健康检查 / 后端能力协商 / 首屏聚合）
 *
 * 功能：`handleHealth` 与 `healthPayload` 给出「装的是哪个包、数据层什么状态」；
 *      `handleBootstrap` 是 0.2.0 的首屏聚合接口（health + me + projects + summary + todayCounts），
 *      把电脑版首屏 6 个请求合成 1 个；`handleDashboard`（0.4.5）是按日期区间取首页看板的独立入口；
 *      ⭐ `handleVersions`（0.9.1）是设置页「版本数据」各端最新版本检测（唯一对外联网点）。
 *
 * ⚠️ 拆自 `server.js`（002 报告 §5.1 ①），**只搬家不改逻辑**；运行期单例从 `../context.js` 取。
 * ⚠️ **`/api/health` 的鉴权位置是安全关键**：它必须在 401 闸门**之前**显式分派（登录页要能探活），
 *    且**故意不在** `API_ROUTES` 表里 —— 所以它虽然在主题上属本文件，派发点仍在 `server.js` 的 `handleApi`。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.1
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const { APP_VERSION } = require('../storage.js');
const { registry } = require('../../modules/registry.js');
const { httpError, json, notFound } = require('../http-util.js');
const { runtime, store } = require('../context.js');
const { nowInfo, todayStr } = require('../time-util.js');
const { isRealDate } = require('../validate.js');
// ⭐ 0.9.1：各端最新版本检测（唯一对外联网点，纯 lib，可注入网络实现）
const { loadVersions } = require('../version-check.js');

/**
 * 功能：从查询串里读出一个日期参数 —— 空值回落默认值，格式或日期不合法一律 400（**不静默截断**）。
 *
 * 说明：⚠️ 与任务表单的 `badDateRange()` 不是一回事：那个判的是**请求体**里两个日期的先后，
 *      这里判的是 **URL 参数**本身是不是一个真实存在的日期（`2026-13-99` 会被 `isRealDate` 挡下）。
 *
 * @param {URLSearchParams} sp - 查询参数
 * @param {string} key - 参数名
 * @param {string} dflt - 缺省值
 * @param {string} label - 出错时的中文名
 * @returns {string} 合法的日期串
 */
function dateParam(sp, key, dflt, label) {
  const raw = String(sp.get(key) || '').trim();
  if (!raw) return dflt;
  if (!isRealDate(raw)) throw httpError(400, `${label}不是有效日期（应形如 2026-09-01）`);
  return raw;
}

/**
 * 功能：`GET /api/dashboard?from=&to=` —— 首页看板（0.4.5）：按日期区间取
 *      「任务 + 课程 + 需关注的硬件 + 收藏夹与消息概况」。
 *
 * 说明：区间两端都缺省为**今天**（＝「今日」那一档）；只给一端时另一端也按今天算，
 *      于是 `from=2026-09-01&to=` 这种半截参数不会得到一个荒唐的区间。
 *
 * ⚠️ `from > to` 一律 **400**：空区间只会让用户对着一块空看板猜「是不是没数据」，
 *    而他真正需要知道的是「起始日填到了截止日后面」。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {number} ctx.uid - 当前账号 id
 * @param {URL} ctx.url - 请求的 URL 对象（取 `from` / `to`）
 * @returns {void}
 */
function handleDashboard({ res, method, uid, url }) {
  if (method !== 'GET') return notFound(res);
  const t = todayStr();
  const sp = url.searchParams;
  const from = dateParam(sp, 'from', t, '起始日期');
  const to = dateParam(sp, 'to', t, '截止日期');
  if (from > to) throw httpError(400, '起始日期不能晚于截止日期');
  // ⭐ 课表 2 期：看板响应里搭车带回服务端「现在」——
  //    看板两端的倒计时以它为基准（判定在前端 `public/core/timetable.js` 一份），不新开接口。
  const payload = store.dashboard(uid, { from, to });
  payload.now = nowInfo();
  return json(res, 200, payload);
}

/**
 * 功能：拼装 `/api/health` 的响应体 —— 未登录只回存活/版本/后端/端口，已登录再补数据层细节。
 *
 * 说明：抽出来是为了让 `/api/bootstrap` 复用**同一份**口径。
 *
 * ⚠️ 未登录时只回「存活 + 版本 + 后端 + 端口」四件事：
 *    单用户时代的 health 把后端类型、备份文件名、跨账号的历史任务条数都暴露出去，
 *    这些在未登录时既是白送的信息、也不是登录页需要的东西。
 *
 * ⚠️ 契约：`GET /api/health` 对所有人开放，**数据层细节只给已登录者**。
 *
 * @param {Object} i - `store.info()` 返回的数据层状态
 * @param {?Object} user - 当前登录账号，未登录为 null
 * @returns {Object} `/api/health` 的响应体
 */
function healthPayload(i, user) {
  const base = {
    ok: true,
    version: APP_VERSION,
    backend: i.backend,
    port: runtime.port,
  };
  if (!user) return base;
  return {
    ...base,
    authenticated: true,
    // 数据层状态：前端据此挂「当前读的不是数据库」横幅，并禁用写操作入口
    degraded: i.degraded,
    readOnly: i.readOnly,
    initError: i.initError,
    journalMode: i.journalMode,
    schemaVersion: i.schemaVersion,
    backupFile: i.backupFile,
    backupError: i.backupError,
    usersIndexError: i.usersIndexError,
    // ⚠️ 这是**全库跨账号**的合计值（别人数据的痕迹），只给管理员看
    legacyNullStartDates: user.is_admin ? i.legacyNullStartDates : 0,
  };
}

/**
 * 功能：处理 `GET /api/health` —— 回存活与数据层状态（对未登录者只回存活信息）。
 * @param {Object} req - HTTP 请求对象（本函数未使用，仅为统一分派签名保留）
 * @param {Object} res - HTTP 响应对象
 * @param {?Object} user - 当前登录账号，未登录为 null
 * @returns {void}
 */
function handleHealth(req, res, user) {
  return json(res, 200, healthPayload(store.info(), user));
}

/**
 * 功能：处理 `GET /api/versions` —— 各端最新版本检测（0.9.1），**只读展示**，不下载不升级。
 *
 * 说明：⭐ 设置页「版本数据」那一栏的数据源：飞牛 / Windows / 安卓 / 浏览器扩展四条最新版本，
 *      外加「本机这一份相对服务器」的结论（当前版本 > 服务器版本 ⇒ `state:'ahead'`，界面标「测试版」）。
 *      比较与联网都在 `core/version-check.js`（纯 lib，可注入网络实现），本函数只做分派与出口。
 *
 * ⚠️⭐ **一定会出网**：这是本软件唯一的对外联网点，许可协议里写明「只有用户主动点『检查更新』
 *      才请求一次」。⇒ 前端**只在点按钮时**调这里，⛔ 不许在进设置/进页面时预热调用；
 *      服务端另有 10 分钟缓存（同一台 NAS 上多个人点不会重复出网）。
 *      想改成自动检查 = 先改许可协议 §四，属产品口径。
 *
 * ⚠️ **失败也回 200**：载荷里 `ok:false` + 一句人话。它只是展示，读不到版本不该让设置页
 *      弹红条（前端 `api()` 对非 2xx 是抛错的）；`reason` 只用于区分「超时 / 连不上 / 没有记录」。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @returns {void}
 */
function handleVersions({ res, method }) {
  if (method !== 'GET') return notFound(res);
  return loadVersions({ current: APP_VERSION })
    .then((payload) => json(res, 200, payload))
    .catch(() => json(res, 200, { ok: false, current: APP_VERSION, reason: 'network', message: '连不上更新服务器' }));
}

/**
 * 功能：首屏聚合接口 —— 在一次请求里返回健康状态、当前账号、**模块清单**、项目列表、汇总看板与今日待办数。
 *
 * 说明：⭐ `GET /api/bootstrap` —— **首屏聚合接口**（0.2.0 性能改造）。
 *
 * 为什么必须有：打开一次应用原先要发 5 个请求（health / auth/me / projects / summary / today-count），
 * 手机版还要再加「每个项目一次任务请求」（N+1）。而 HTTP/1.1 每源 6 并发 + **`node:sqlite` 全是同步查询**
 * ⇒ 这些请求在服务端是**排队**执行的，局域网里也能明显感觉到（实测：首屏 26~31 个请求）。
 * 合并之后，服务端在**一个**请求里跑完同样的几个查询 —— 同步查询本来就没有并行收益，
 * 少掉的 4 次会话校验、4 次 HTTP 往返、4 次 JSON 序列化才是净赚的。
 *
 * ⚠️ 这是**纯增量**：原接口一个都没删（老页面 / 外部脚本仍可用），测试两边都钉。
 * ⚠️ `todayCounts` 的日期口径与 `/api/today-count` 完全一致（都用服务端的 `todayStr()`）。
 * ⭐ 0.5.0 起多带一个 `modules`（模块清单，见下方请求体处的说明）：两端画入口与开关要用它，
 *    而它本来就不需要额外查询（读的是一张启动时就自检过的静态清单）。
 *
 * ⭐ 0.4.5：带 `?dash=1` 时，这里回的是 `dashboard`（按区间、跨模块的新看板）**而不是** `summary` ——
 *    两者都要把项目与任务整个扫一遍，一份响应里同时塞两个等于把同一批数据算两遍。
 *    桌面版首屏要的是新看板、手机版首屏要的还是 `summary`（「今天」页没改），各取所需：
 *    **两个键不会同时出现**（`dash=1` → 有 `dashboard`；否则 → 有 `summary`），
 *    客户端不许假设另一个也在。区间沿用 `/api/dashboard` 的同名参数与同一套 400 校验。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {?Object} ctx.user - 当前登录账号
 * @param {number} ctx.uid - 当前账号 id
 * @param {URL} ctx.url - 请求的 URL 对象（取 `dash` / `from` / `to`）
 * @returns {void}
 */
function handleBootstrap({ res, method, user, uid, url }) {
  if (method !== 'GET') return notFound(res);
  const sp = url.searchParams;
  const dash = ['1', 'true', 'yes'].includes(String(sp.get('dash') || '').toLowerCase());
  const t = todayStr();
  // ⚠️ ⭐ 0.5.0：`listProjects()` 是**任务板模块**的方法，而任务板可以被整目录删掉
  //    （「删目录验收」）。删掉之后硬调就是 `is not a function` ⇒ `/api/bootstrap` **500**，
  //    而验收第 ② 条要求的正是「**其它模块一切正常**」（数据可以少，但不许 500）。
  //    ⇒ 判据放在这一个出口：方法不在时回空数组（首屏因此少一块项目列表，不是少一整页）。
  const projects = typeof store.listProjects === 'function' ? store.listProjects(uid) : [];
  return json(res, 200, {
    health: healthPayload(store.info(), user),
    me: user,
    // ⭐ 课表 2 期：首屏也带回服务端「现在」（倒计时的时间权威源，⛔ 不新开接口）
    now: nowInfo(),
    // ⭐ 0.5.0 模块化重构：**模块清单**（前端据此画侧栏入口 / 底部标签 / 设置页开关）。
    //    为什么搭在这一趟上而不是单开 `GET /api/modules`：两端首屏本来就要发这个请求，
    //    单开会多一次往返，而「首屏能合并的请求必须合并」是既定决策（见 13-决策记录 的）。
    //    ⚠️ 发**全量**、不过滤 `hide_*`：关掉的模块若从清单里被剔掉，就再也没有地方把它打开了
    //    （设置页正是靠这份清单才画得出「已关闭」的开关）。开关状态由 `me.hide_*` 决定。
    modules: registry.frontendList(),
    projects,
    // ⚠️ 二选一，见上面的说明
    ...(dash
      ? {
          // ⭐ 0.7.9：与 `GET /api/dashboard`（`handleDashboard`）**逐字同口径** —— 那一条会把
          //    `now` 写进看板载荷，而手机端首屏走的是 bootstrap ⇒ 从前拿不到，今日页的
          //    「服务端时间权威源」安静退化成**本机时钟**。
          //    ⛔ 不动 `store.dashboard()` 本身 —— 「现在」是接口层的事，它不该知道。
          dashboard: Object.assign(
            store.dashboard(uid, {
              from: dateParam(sp, 'from', t, '起始日期'),
              to: dateParam(sp, 'to', t, '截止日期'),
            }),
            { now: nowInfo() },
          ),
        }
      : { summary: store.summary(uid) }),
    // ⚠️ 0.5.0：`todayCounts()` 也是任务板模块的方法 —— 判据同样只在这一处
    //    （核心的包装 `todayCountsOf()`：模块不在时回 `{ daily: 0, projects: {} }`）。
    todayCounts: store.todayCountsOf(uid, t),
  });
}

module.exports = {
  healthPayload,
  handleHealth,
  handleDashboard,
  handleBootstrap,
  // ⭐ 0.9.1：`GET /api/versions`（设置页「版本数据」那一栏）
  handleVersions,
};
