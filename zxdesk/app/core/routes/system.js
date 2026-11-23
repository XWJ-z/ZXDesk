/**
 * routes/system.js —— 系统级路由（健康检查 / 后端能力协商 / 首屏聚合）
 *
 * 功能：`handleHealth` 与 `healthPayload` 给出「装的是哪个包、数据层什么状态」；
 * `handleBootstrap` 是 的首屏聚合接口（health + me + projects + summary + todayCounts），
 * 把电脑版首屏 6 个请求合成 1 个；`handleDashboard`是按日期区间取首页看板的独立入口；
 * `handleVersions`是设置页「版本数据」各端最新版本检测（唯一对外联网点）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const { APP_VERSION } = require('../storage.js');
const { registry } = require('../../modules/registry.js');
const { httpError, json, notFound } = require('../http-util.js');
const { dataDir, runtime, store } = require('../context.js');
// 数据位置的授权结论（启动时查过一次，之后按网关身份复核）
const locationAuth = require('../location-auth.js');
const { nowInfo, todayStr } = require('../time-util.js');
const { isRealDate } = require('../validate.js');
// 各端最新版本检测（唯一对外联网点，纯 lib，可注入网络实现）
const { loadVersions } = require('../version-check.js');

/**
 * 功能：从查询串里读出一个日期参数 —— 空值回落默认值，格式或日期不合法一律 400（**不静默截断**）。
 *
 * 说明：⚠️ 与任务表单的 `badDateRange()` 不是一回事：那个判的是**请求体**里两个日期的先后，
 *
 * @param {URLSearchParams} sp - 查询参数
 */
function dateParam(sp, key, dflt, label) {
  const raw = String(sp.get(key) || '').trim();
  if (!raw) return dflt;
  if (!isRealDate(raw)) throw httpError(400, `${label}不是有效日期（应形如 2026-09-01）`);
  return raw;
}

/**
 * 「任务 + 课程 + 需关注的硬件 + 收藏夹与消息概况」。
 *
 */
function handleDashboard({ res, method, uid, url }) {
  if (method !== 'GET') return notFound(res);
  const t = todayStr();
  const sp = url.searchParams;
  const from = dateParam(sp, 'from', t, '起始日期');
  const to = dateParam(sp, 'to', t, '截止日期');
  if (from > to) throw httpError(400, '起始日期不能晚于截止日期');
  // 课表 2 期：看板响应里搭车带回服务端「现在」——
  // 看板两端的倒计时以它为基准（判定在前端 `public/core/timetable.js` 一份），不新开接口。
  const payload = store.dashboard(uid, { from, to });
  payload.now = nowInfo();
  return json(res, 200, payload);
}

/**
 * 功能：拼装 `/api/health` 的响应体 —— 未登录只回存活/版本/后端/端口，已登录再补数据层细节。
 *
 * 说明：抽出来是为了让 `/api/bootstrap` 复用**同一份**口径。
 *
 * 未登录时只回「存活 + 版本 + 后端 + 端口」四件事：
 */
function healthPayload(i, user, auth) {
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
    // 这是**全库跨账号**的合计值（别人数据的痕迹），只给管理员看
    legacyNullStartDates: user.is_admin ? i.legacyNullStartDates : 0,
    // 三个库各自的健康结论（`{main, ledger, lab}`）—— 「哪个库坏了」必须在这里能看出来。
    // 只有 `label` / `ok` / `readOnly` / `journalMode` / `reason`，**不含文件路径**
    // （路径仍只经 `/api/admin/storage` 给管理员）。见 `store.info()` 的 `databases`。
    databases: i.databases || null,
    // 数据目录的**末段**（⛔ 不带完整路径：health 对全部已登录账号开放）。
    // 起没有「移动中 / 待重启」两态了（位置由安装决定、之后不改），所以只剩 tail 与 auth。
    dataLocation: {
      tail: String(dataDir || '').split('/').filter(Boolean).pop() || '',
      // 授权体检结论：`{state: 'ok'|'lost'|'unknown'|'pending', scope, code}`。
      // 局域网直连的机器一开机就红一片）。
      auth: auth || locationAuth.snapshot(),
    },
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
  const i = store.info();
  // 已登录才顺带复核一次授权：未登录时没有网关身份，问了也判不出来（`ensure` 会原样返回现状）
  if (!user) return json(res, 200, healthPayload(i, user));
  // `?auth=1` ⇒ 不看缓存、现在就问一次（「数据库授权未完成」那个弹窗里的「重新检查」走它）。
  // 默认仍走缓存：health 可能被轮询，每次都打网关会把网关打满。
  const force = !!(req && req.url && /[?&]auth=1(&|$)/.test(String(req.url)));
  locationAuth
    .ensure(req, { force })
    .then((auth) => json(res, 200, healthPayload(i, user, auth)))
    .catch(() => json(res, 200, healthPayload(i, user)));
}

/**
 *
 * 说明：⭐ 设置页「版本数据」那一栏的数据源：飞牛 / Windows / 安卓 / 浏览器扩展四条最新版本，
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
 *
 * 为什么必须有：打开一次应用原先要发 5 个请求（health / auth/me / projects / summary / today-count），
 * 手机版还要再加「每个项目一次任务请求」（N+1）。而 HTTP/1.1 每源 6 并发 + **`node:sqlite` 全是同步查询**
 */
function handleBootstrap({ req, res, method, user, uid, url }) {
  if (method !== 'GET') return notFound(res);
  const sp = url.searchParams;
  const dash = ['1', 'true', 'yes'].includes(String(sp.get('dash') || '').toLowerCase());
  const t = todayStr();
  // `listProjects()` 是**任务板模块**的方法，而任务板可以被整目录删掉
  // 。删掉之后硬调就是 `is not a function` ⇒ `/api/bootstrap` **500**，
  // ⇒ 判据放在这一个出口：方法不在时回空数组（首屏因此少一块项目列表，不是少一整页）。
  const projects = typeof store.listProjects === 'function' ? store.listProjects(uid) : [];
  /**
   * 功能：把首屏载荷拼出来（`auth` 是授权体检的结论，可能来自缓存）。
   * @param {?Object} auth - `locationAuth` 的结论
   * @returns {Object} 响应体
   */
  const payload = (auth) => ({
    health: healthPayload(store.info(), user, auth),
    me: user,
    // 课表 2 期：首屏也带回服务端「现在」（倒计时的时间权威源，⛔ 不新开接口）
    now: nowInfo(),
    // 模块化重构：**模块清单**（前端据此画侧栏入口 / 底部标签 / 设置页开关）。
    // 为什么搭在这一趟上而不是单开 `GET /api/modules`：两端首屏本来就要发这个请求，
    // 单开会多一次往返，而「首屏能合并的请求必须合并」是既定决策（见 13-决策记录 的）。
    modules: registry.frontendList(),
    projects,
    // 二选一，见上面的说明
    ...(dash
      ? {
          // 与 `GET /api/dashboard`（`handleDashboard`）**逐字同口径** —— 那一条会把
          // `now` 写进看板载荷，而手机端首屏走的是 bootstrap ⇒ 从前拿不到，今日页的
          // 「服务端时间权威源」安静退化成**本机时钟**。
          dashboard: Object.assign(
            store.dashboard(uid, {
              from: dateParam(sp, 'from', t, '起始日期'),
              to: dateParam(sp, 'to', t, '截止日期'),
            }),
            { now: nowInfo() },
          ),
        }
      : { summary: store.summary(uid) }),
    // `todayCounts()` 也是任务板模块的方法 —— 判据同样只在这一处
    // （核心的包装 `todayCountsOf()`：模块不在时回 `{ daily: 0, projects: {} }`）。
    todayCounts: store.todayCountsOf(uid, t),
  });
  // 首屏就把「数据位置授权」查一遍（**进入应用即弹窗**靠的就是这个字段）：
  // 只在已登录时查（要有网关身份）；查不到就按现状回（`unknown` 不吓人）。
  if (!user) return json(res, 200, payload());
  // **强制**复核（`force: true`）：这是「进入应用」那一次，用户可能刚在设置里授权完就刷新了 ——
  // 只有这一处强制：`/api/health` 可能被轮询，那里仍走缓存（见 `ensure()`）。
  return locationAuth
    .ensure(req, { force: true })
    .then((auth) => json(res, 200, payload(auth)))
    .catch(() => json(res, 200, payload()));
}

module.exports = {
  healthPayload,
  handleHealth,
  handleDashboard,
  handleBootstrap,
  // `GET /api/versions`（设置页「版本数据」那一栏）
  handleVersions,
};
