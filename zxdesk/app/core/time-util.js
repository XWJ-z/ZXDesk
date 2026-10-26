/**
 * time-util.js —— HTTP 层的时间口径（真实今天 / 今天是第几周 / 时段块换算）
 *
 * 功能：`todayStr` 取**本地**今天（`YYYY-MM-DD`）、`todayInfo` 算出今天落在学期的第几周与星期几、
 *      `nowInfo` 取服务端「现在」的日期与时刻（课表 2 期倒计时的时间权威源）、
 *      `periodsFromBlocks` 把「时段块」摊平成逐节时间、`breaksFromBlocks` 算出块之间的休息分界行。
 *
 * ⚠️ 为什么单独一个文件而不是塞进某个 `routes/*`：`todayStr` 被 `routes/system.js`（首屏聚合）
 *    与课表路由**同时**使用；放进任一侧都会让两个 route 文件互相 require。这里与 `http-util` 同级，
 *    依赖图保持无环。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.8
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const ti = require('./timetable-import.js');
const { today } = require('./storage.js');

/**
 * 块与块之间的空档 ≥ 这个分钟数才画「休息」分界行 ——
 * 30 分钟是「够吃一顿饭 / 睡一觉」的量级；块内部 10 分钟左右的普通课间一律不画。
 */
const BREAK_MIN_MINUTES = 30;

/**
 * 功能：取「今天」的本地日期串（`YYYY-MM-DD`），本文件内所有日期口径的统一入口。
 *
 * 说明：今天的日期串（本地时间）。
 *
 * ⚠️ 本体在 `db.js` 的 `today()` —— **只有一份实现**（0.1.3 起从这里 import）。
 *    这里保留一个同名薄封装，只为让本文件里的调用点读起来仍是「服务端的今天」，
 *    且将来若要给服务端换时间源，只改这一处。
 *
 * @returns {string} 本地日期串，形如 `2026-09-10`
 */
function todayStr() {
  return today();
}

/**
 * 功能：算出「今天」在某学期里是星期几、第几周，供课表接口返回。
 *
 * 说明：「今天」在本学期是第几周 / 星期几。
 * ⚠️ `start_monday` 没设时 `week_no` 为 **null** —— 前端据此不标本周、不做周次筛选（**不猜**）。
 *
 * @param {?Object} term - 学期行（含 `start_monday`），可为 null
 * @returns {{ date: string, weekday: number, week_no: ?number }} 今天的日期、星期几与周次（无开学日期时为 null）
 */
function todayInfo(term) {
  const t = todayStr();
  return {
    date: t,
    weekday: ti.weekdayOfDate(t),
    week_no: term && term.start_monday ? ti.weekNumberOf(term.start_monday, t) : null,
  };
}

/**
 * 功能：取服务端「现在」的日期与时刻（`{ date, hm }`）—— 课表 2 期倒计时的**时间权威源**。
 *
 * 说明：⭐ 手机 / 别的设备的时钟可能不准（时区、手动改过），直接拿设备时间算
 *      「还有几分钟下课」会静默算错 = 误课。所以判定放前端、时间放服务端：
 *      课表接口与 `/api/dashboard` / `/api/bootstrap` 在**既有响应里搭车**带回这个 `now`
 *      （⛔ 不新开接口），前端记下偏移后自己换算（见 `public/core/timetable.js` 的
 *      `ttSyncServerNow()`）。
 *
 * @returns {{date: string, hm: string}} 服务端本地日期 `YYYY-MM-DD` 与时刻 `HH:MM`（分钟粒度）
 */
function nowInfo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { date: todayStr(), hm: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/**
 * 功能：由时段块生成逐节时间，并把每节的 `block_index` 换成真实的 `block_id`。
 * @param {Array.<Object>} blocks - 已落库的时段块数组（元素带 `id`）
 * @returns {Array.<Object>} 逐节时间数组，元素含 `index_no` / `block_id` / `start_time` / `end_time`
 */
function periodsFromBlocks(blocks) {
  return ti.generatePeriods(blocks).map((p) => ({
    index_no: p.index_no,
    block_id: p.block_index === undefined || p.block_index === null ? null : (blocks[p.block_index] || {}).id,
    start_time: p.start_time,
    end_time: p.end_time,
  }));
}

/**
 * 功能：由时段块算出「块与块之间的休息分界行」（午休 / 晚休），供整周视图插一行。
 *
 * 说明：⭐ **判断只在服务端做一份** —— 两端（电脑版与手机版）拿到的是同一个数组，
 *      各自只负责把它插到对应的行前面（前端不许自己再算一遍间隔，否则两端迟早不一致）。
 *
 * 规则（0.2.3 需求 ②）：
 *   1. 只看**相邻两块之间**的空档 —— 块内部的普通课间（10 分钟那种）不画；
 *   2. 空档 ≥ {@link BREAK_MIN_MINUTES} 分钟才算「休息」；
 *   3. 名字按空档**中点**落在哪个区间自动取：12:00 前「休息」、12:00~17:00「午休」、17:00 后「晚休」。
 *      （名字只是提示，不参与任何计算；`label` 由时段块的段名另有一份。）
 *
 * @param {Array.<Object>} blocks - 时段块数组（元素含 `sort_order` / `start_time` / `end_time` / `period_count`）
 * @returns {Array.<Object>} 分界行数组，每项 `{ before_index_no, label, start_time, end_time, minutes }`；
 *     `before_index_no` = 下一块**第一节课**的节次号（前端把它插在这一行之前）
 */
function breaksFromBlocks(blocks) {
  const list = (blocks || [])
    .slice()
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id || 0) - Number(b.id || 0));
  const out = [];
  let index = 1; // 节次号是**全天连续**的（与 generatePeriods 同一套编号）
  for (let i = 0; i + 1 < list.length; i++) {
    index += Math.max(0, Math.floor(Number(list[i].period_count) || 0));
    const curEnd = ti.toMin(list[i].end_time);
    const nextStart = ti.toMin(list[i + 1].start_time);
    if (curEnd === null || nextStart === null) continue;
    const gap = nextStart - curEnd;
    if (gap < BREAK_MIN_MINUTES) continue;
    const mid = curEnd + gap / 2;
    out.push({
      before_index_no: index,
      label: mid < 12 * 60 ? '休息' : mid < 17 * 60 ? '午休' : '晚休',
      start_time: list[i].end_time,
      end_time: list[i + 1].start_time,
      minutes: gap,
    });
  }
  return out;
}

module.exports = {
  todayStr,
  todayInfo,
  nowInfo,
  periodsFromBlocks,
  breaksFromBlocks,
};
