'use strict';
/**
 * modules/time/routes.js —— **番茄钟与日程表**（`0.8.13`）：四个接口前缀
 *
 * 功能：把三个同级子模块各自的路由表拼成一份 `{ <顶层键>: handler }`，**外加本模块自己的
 *      一个聚合接口** `GET /api/time/home`（首页「日程表」那一个请求）。键就是 `/api/<键>` 的第一段，
 *      由 `modules/registry.js` 的 `routeTable()` 自动挂到总派发表上。
 *
 * ⚠️⭐ **三个老前缀一个字都没改**：`/api/timetable` · `/api/pomodoro` ·
 *    `/api/trip` 照旧，AI 的授权键与工具名也因此一个字不用动（`timetable.range` / `trips.query` …）。
 *    ⇒ 合并只发生在**模块边界之内**，对外契约面零变化；新加的 `/api/time` 是**唯一**的新面。
 *
 * ⚠️ 顶层键必须**逐个列全**在 `module.json` 的 `apiPrefix` 里 —— 少登记一个，`routesFor()`
 *    加载时就会抛（那是刻意的护栏：防手滑写错前缀）。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.13
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、01-架构总览.md
 */

const { httpError, json, notFound } = require('../../core/http-util.js');
const { todayStr } = require('../../core/time-util.js');
const { store } = require('../../core/context.js');

/** `YYYY-MM-DD` 的形状（与 `trip/routes.js` 的 `DATE_RE` 同口径 —— 那边不是导出件，故各留一份） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 功能：校验一个查询参数是不是 `YYYY-MM-DD`（顺带挡掉不存在的日期）。
 *
 * 说明：⚠️ 用 `Date.UTC` **反查**而不是 `new Date(s)` 直接信任 —— 后者对 `2026-02-30` 会
 *      **静默进位**成 3 月 2 日（那种「输入错、结果却对」的宽容正是本项目一贯要挡的）。
 *
 * @param {?string} v - 原始串
 * @param {string} what - 出错时写进消息里的字段名
 * @returns {string} 原样的日期串
 * @throws {Error} 形状不对 / 日期不存在时抛 400
 */
function checkDate(v, what) {
  const s = String(v == null ? '' : v).trim();
  if (!DATE_RE.test(s)) throw httpError(400, `${what}要写成 2026-10-05 这样的日期`);
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw httpError(400, `${what}不是一个真实存在的日期`);
  }
  return s;
}

/**
 * 功能：算某个日期所在**那一周**的周一与周日（本项目一律以周一为一周之首）。
 *
 * 说明：⚠️ 全程 `Date.UTC` 算术 + `toISOString().slice(0,10)`：**不碰本机时区**，
 *      与 `core/time-util.js` 那套「日期串只当日期用」的纪律一致。
 *
 * @param {string} day - `YYYY-MM-DD`
 * @returns {Array.<string>} `[周一, 周日]`
 */
function weekRangeOf(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay(); // 周一 = 1 … 周日 = 7
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const mon = dt.getTime() - (wd - 1) * 86400000;
  return [fmt(mon), fmt(mon + 6 * 86400000)];
}

/**
 * ⚠️⭐⭐ **本函数必须是同步函数（⛔ 不许写 `async`）** —— 这一条是踩出来的：
 * `core/server.js` 的 `handleApi()` 是**同步**的，它 `return route({...})` 把 handler 的返回值
 * 原样交回给 `handleRequest()` 那个**同步 `try/catch`**。handler 一旦是 `async`，
 * 它抛的 `httpError(400)` 就变成一个 **rejected promise**，同步 catch 接不住 ⇒
 * **`unhandledRejection` ⇒ 整个服务进程退出**（实测日志：`[error] unhandledRejection: 区间要同时给起点与终点`，
 * 客户端看到的是 `fetch failed`）。
 * 既有模块的 handler 全是同步的（`handleTrip` / `handleTimetable` …），**照它们写**。
 * ⚠️ 这里也确实不需要 async：`store.timeHome()` 与 `json/notFound/httpError` 全是同步的。
 *
 * @param {Object} ctx - 路由上下文（`{ res, parts, url, method, uid }`）
 * @returns {void} 已写完响应
 */
function handleTimeHome({ res, parts, url, method, uid }) {
  // ⚠️⭐ `parts` 是**含 `api` 的完整段**（`core/server.js`：`pathname.split('/').filter(Boolean)`）
  //    ⇒ `/api/time/home` === `['api','time','home']`，**长度 3**。
  //    ⛔ 别照抄 `trip/routes.js` 里那个 `parts.length === 2` —— 那一条对应的是 `/api/trip`
  //    本身（两段），段数口径不一样。写错的表现是**这条接口永远回 404**，而单测全绿
  //    （单测只核了 `routeTable()` 的键，没真打它）—— 本项目点名的「新加一条路由必须真打它一次」。
  if (parts.length !== 3 || method !== 'GET') return notFound(res);
  const p = (url && url.searchParams) || new URLSearchParams();
  const rawFrom = p.get('from');
  const rawTo = p.get('to');
  // ⚠️ 只给一头 = 400（不给「另一半兜底」：那会让「我明明选了区间」变成猜谜）
  if ((rawFrom && !rawTo) || (!rawFrom && rawTo)) throw httpError(400, '区间要同时给起点与终点');
  const range = rawFrom && rawTo ? [checkDate(rawFrom, '区间起点'), checkDate(rawTo, '区间终点')] : weekRangeOf(todayStr());
  const [from, to] = range;
  if (to < from) throw httpError(400, '区间的终点不能早于起点');
  return json(res, 200, store.timeHome(uid, from, to, Date.now()));
}

module.exports = {
  timetable: require('./timetable/routes.js').timetable,
  pomodoro: require('./pomodoro/routes.js').pomodoro,
  trip: require('./trip/routes.js').trip,
  // ⭐ 0.8.13：本模块自己的聚合接口（唯一的新接口面）
  time: handleTimeHome,
};
