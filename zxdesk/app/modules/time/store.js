'use strict';
/**
 * modules/time/store.js —— **番茄钟与日程表**（`0.8.13` 三块并一个模块）：业务方法的**拼装层**
 *
 * 功能：把三个同级子模块的业务方法拼成**一份**导出对象 —— `core/store/index.js` 会把它
 *      `Object.assign` 到**同一个 Store 原型**上，所以这里必须保证「三份的方法名两两不重」。
 *
 * ⚠️⭐ **重名在这里当场抛**，不靠人眼：`Object.assign` / 展开符遇到同名方法**不报错**，
 *    后写的静默盖掉先写的，而表现是「某一屏打不开了」、代码看着毫无问题
 *    （0.3.1 真踩过：硬件的 `list` 盖掉了收藏夹的 `list`）。
 *    原先这道护栏由 `core/store/index.js` 的 `assertNoMethodClash()` 按**来源文件**逐份比对；
 *    三块并成一个模块之后，它们成了**同一个来源**⇒ 那道护栏够不着模块内部，
 *    所以在拼装的这一刻把同一件事补上（口径照旧：加载时兑现、一律启动即抛）。
 *
 * ⚠️ 相对 require 的深度：本文件在 `modules/time/` 下，子模块在 `modules/time/<子>/` 下
 *    —— 子模块自己那一份的深度已经各自调好（见各自的文件头），这里只 require 它们。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.32
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、02-存储层与数据模型.md
 */

const timetable = require('./timetable/store.js');
const pomodoro = require('./pomodoro/store.js');
const trip = require('./trip/store.js');

/** 三个子模块（顺序 = 注册表里的表顺序，与 `schema.js` 的 `PARTS` 一致） */
const PARTS = [
  ['timetable', timetable],
  ['pomodoro', pomodoro],
  ['trip', trip],
];

const out = {};
/** 业务方法名 → 它来自哪个子模块 */
const owner = new Map();
for (const [who, mod] of PARTS) {
  for (const k of Object.keys(mod)) {
    if (owner.has(k)) {
      throw new Error(
        `[modules/time] 业务方法「${k}」在子模块 ${owner.get(k)} 与 ${who} 里各有一份 —— ` +
          '平铺到同一个 Store 原型上会静默覆盖，必须先改掉其中一个的名字',
      );
    }
    owner.set(k, who);
    out[k] = mod[k];
  }
}

/**
 * ⭐⭐ 0.8.13：首页「日程表」那**一个**请求的数据 —— 与子模块的方法平铺在同一张表上（`this` 是 Store）。
 *
 * 说明：⭐⭐ **只取一次数、只开一个出口**（方案 §四）：
 *      · 课表 → `dashboard()` 的 `courses`；
 *      · 行程 → `tripState()`（与 `GET /api/trip` 同一个方法）；
 *      · 番茄 → `listPomodoroSessions()` 按 `date` 落区间，**只算 `completed`**
 *        （与 `pomodoroStats()` 同一套读法 —— 口径只住一处，⛔ 不另开一份 op）；
 *        ⭐ 0.8.32：带着 `kind` 一起给（专注 / 短休 / 长休）—— 首页据此画两种块。
 *      ⚠️ 它**不掺任何「现在」**：只把事实给出去，「现在」的判定仍只住 `public/core/timetable.js`。
 *      ⚠️ `timetable_on` 给的是「**课表这一层**能不能用」——前端⛔ 不能只看 `course_reason`
 *      （课表被关 / 目录被删时 `reason` 也是空串，与「正常但这一周没课」同形）。
 *
 * @param {number} uid - 账号 id
 * @param {string} from - 区间起点（含）`YYYY-MM-DD`
 * @param {string} to - 区间终点（含）`YYYY-MM-DD`
 * @param {number} nowMs - 现在（epoch 毫秒）—— 只用于行程那一侧算倒计时/出发状态
 * @returns {Object} 首页要的那一份（课程 / 行程 / 车票 / 已完成番茄 ＋ 两个可用性线索）
 */
out.timeHome = function timeHome(uid, from, to, nowMs) {
  const me = Number(uid);
  const f = String(from);
  const t = String(to);

  const d = this.dashboard(me, { from: f, to: t });
  const trip = this.tripState(me, f, t, nowMs);

  // 番茄：`date` 是**归属日**（开始那一刻），跨零点只算开始那天 —— 与统计口径逐字一致
  // ⭐ 0.8.32：休息（`kind !== 'focus'`）也一起给出去 —— 首页要把它画成**另一种块**，
  //    ⛔ 不是把它从时间轴上抹掉（「休息阶段要落库，进统计与日程表」）。
  const pomodoros = (this._bk.listPomodoroSessions(me) || [])
    .filter((r) => r.status === 'completed')
    .filter((r) => {
      const day = String(r.date || '');
      return day >= f && day <= t;
    })
    .map((r) => ({
      id: Number(r.id),
      date: String(r.date || ''),
      kind: String(r.kind) === 'short_break' || String(r.kind) === 'long_break' ? String(r.kind) : 'focus',
      started_at: Number(r.started_at) || 0,
      ended_at: r.ended_at == null ? null : Number(r.ended_at),
      planned_seconds: Number(r.planned_seconds) || 0,
    }));

  // ⭐ **搭车给「服务端的现在」**（形状与课表接口的 `now` 一致：`{ date, hm }`）：
  //    首页要画「现在」那条横线，而「现在」的判定**只住 `public/core/timetable.js`** ——
  //    前端先 `ttSyncServerNow(data.now)` 再 `ttNowHM()`，⛔ 页面自己一次都不许读本机时钟。
  const nd = new Date(Math.round(Number(nowMs)));
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    from: f,
    to: t,
    today: d.today,
    now: {
      date: `${nd.getFullYear()}-${p2(nd.getMonth() + 1)}-${p2(nd.getDate())}`,
      hm: `${p2(nd.getHours())}:${p2(nd.getMinutes())}`,
    },
    courses: d.courses,
    course_term: d.course_term,
    course_reason: d.course_reason,
    timetable_on: !!(d.modules && d.modules.timetable),
    trips: trip.trips,
    tickets: trip.tickets,
    pomodoros,
  };
};

module.exports = out;
