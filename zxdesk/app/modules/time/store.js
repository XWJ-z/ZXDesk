'use strict';
/**
 * modules/time/store.js —— **番茄钟与日程表**：业务方法的**拼装层**
 * 功能：把三个同级子模块的业务方法拼成**一份**导出对象 —— `core/store/index.js` 会把它
 * `Object.assign` 到**同一个 Store 原型**上，所以这里必须保证「三份的方法名两两不重」。
 * @author zx
 * @date   2026-10-05
 * @since 0.9.7
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
 * 首页「日程表」那**一个**请求的数据 —— 与子模块的方法平铺在同一张表上（`this` 是 Store）。
 *
 */
out.timeHome = function timeHome(uid, from, to, nowMs) {
  const me = Number(uid);
  const f = String(from);
  const t = String(to);

  const d = this.dashboard(me, { from: f, to: t });
  const trip = this.tripState(me, f, t, nowMs);

  // 番茄：`date` 是**归属日**（开始那一刻），跨零点只算开始那天 —— 与统计口径逐字一致
  // 休息（`kind !== 'focus'`）也一起给出去 —— 首页要把它画成**另一种块**，
  // 不是把它从时间轴上抹掉（「休息阶段要落库，进统计与日程表」）。
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

  // **搭车给「服务端的现在」**（形状与课表接口的 `now` 一致：`{ date, hm }`）：
  // 首页要画「现在」那条横线，而「现在」的判定**只住 `public/core/timetable.js`** ——
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
