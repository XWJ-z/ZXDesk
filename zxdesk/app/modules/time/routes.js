'use strict';
/**
 * modules/time/routes.js —— **番茄钟与日程表**：四个接口前缀
 * 功能：把三个同级子模块各自的路由表拼成一份 `{ <顶层键>: handler }`，**外加本模块自己的
 * 一个聚合接口** `GET /api/time/home`（首页「日程表」那一个请求）。键就是 `/api/<键>` 的第一段，
 * @author zx
 * @date   2026-10-05
 * @since 0.9.7
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
 *
 * @param {?string} v - 原始串
 * @param {string} what - 出错时写进消息里的字段名
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
 * 与 `core/time-util.js` 那套「日期串只当日期用」的纪律一致。
 *
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
 * `core/server.js` 的 `handleApi()` 是**同步**的，它 `return route({...})` 把 handler 的返回值
 * 它抛的 `httpError(400)` 就变成一个 **rejected promise**，同步 catch 接不住 ⇒
 */
function handleTimeHome({ res, parts, url, method, uid }) {
  // `parts` 是**含 `api` 的完整段**（`core/server.js`：`pathname.split('/').filter(Boolean)`）
  // ⇒ `/api/time/home` === `['api','time','home']`，**长度 3**。
  // 别照抄 `trip/routes.js` 里那个 `parts.length === 2` —— 那一条对应的是 `/api/trip`
  if (parts.length !== 3 || method !== 'GET') return notFound(res);
  const p = (url && url.searchParams) || new URLSearchParams();
  const rawFrom = p.get('from');
  const rawTo = p.get('to');
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
  // 本模块自己的聚合接口（唯一的新接口面）
  time: handleTimeHome,
};
