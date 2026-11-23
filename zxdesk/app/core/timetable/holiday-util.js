'use strict';
/**
 * core/timetable/holiday-util.js —— 假日口径：**休息日 / 假前一天 / 假前一天下午提前**
 * 功能：把「内置节假日表（`core/holidays.js`）+ 周末」合成一条判定规则，并算出某个学期某一周
 * 七天的日期与性质（是否休息、是否假前一天）；再据此把「逐节时间」按天偏移，供课表接口返回。
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md
 */

const { isRestDate, isWorkDate, isYearKnown, KNOWN_YEARS } = require('../holidays.js');
const { dateOrdinal, toMin, fmtMin } = require('./date-util.js');

/** 下午的默认起点：`12:00` 之后（含）算下午 —— 学校作息几乎都落在这个假设里，可被学期配置覆盖 */
const DEFAULT_PM_FROM = '12:00';

/** 提前分钟数的上限（与 `validate.js` 同一口径：0 = 关闭该功能） */
const MAX_ADVANCE_MINUTES = 180;

/** 内部小工具：两位补零 */
const p2 = (n) => String(n).padStart(2, '0');

/**
 * 功能：日期加减天数（纯字符串进出，内部只用 `Date.UTC` 做天数运算，**不碰本地时区**）。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @param {number} n - 要加的天数（可为负）
 * @returns {?string} 结果日期 `YYYY-MM-DD`；入参不是合法日期时为 null
 */
function addDays(dateStr, n) {
  const ord = dateOrdinal(dateStr);
  if (ord === null) return null;
  const dt = new Date((ord + Number(n || 0)) * 86400000);
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

/**
 * 功能：判断某天是不是**休息日**（法定放假日或周末，调休上班日除外）。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @returns {boolean} true = 这一天不上课
 */
function isRestDay(dateStr) {
  const ord = dateOrdinal(dateStr);
  if (ord === null) return false;
  // 调休上班日**优先于周末**：它本来就是「周末却要上课」的那几天
  if (isWorkDate(dateStr)) return false;
  if (isRestDate(dateStr)) return true;
  const dow = new Date(ord * 86400000).getUTCDay(); // 0=周日
  return dow === 0 || dow === 6;
}

/**
 * 功能：判断某天是不是**假前一天** —— 这一天上课、次日休息。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @returns {boolean} true = 这一天是某个休息日之前的最后一个上课日
 */
function isPreHoliday(dateStr) {
  if (isRestDay(dateStr)) return false;
  const next = addDays(dateStr, 1);
  return next !== null && isRestDay(next);
}

/**
 * 功能：从学期行读出「假前一天下午提前」的配置。
 *
 * 说明：`enabled` 需要两个条件同时成立 —— 提前分钟数 > 0 且学期填了开学日期
 * （没有开学日期就算不出「这一周是哪几天」，功能自然无从生效）。
 *
 */
function planOf(term) {
  const raw = Number((term && term.holiday_advance_minutes) || 0);
  const advance = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_ADVANCE_MINUTES, Math.floor(raw))) : 0;
  const pmFromRaw = String((term && term.holiday_pm_from) || '').trim();
  const pmFrom = toMin(pmFromRaw) === null ? DEFAULT_PM_FROM : pmFromRaw;
  const hasStart = !!(term && term.start_monday);
  const reasons = [];
  if (!advance) reasons.push('未设置提前分钟数');
  if (!hasStart) reasons.push('未设置开学日期');
  return {
    enabled: advance > 0 && hasStart,
    reason: reasons.join('；'),
    advance_minutes: advance,
    pm_from: pmFrom,
    years: KNOWN_YEARS,
    this_year_known: isYearKnown(new Date().getUTCFullYear()),
  };
}

/**
 * 功能：把「逐节时间」按某一天的调整量偏移 —— 只动下午（`start_time >= pm_from`）的节次。
 *
 * 说明：`advance = 0`（平时）时只加 `shifted: false` 标记，不改时间。
 *
 * @param {Array.<Object>} periods - 逐节时间数组（元素含 `index_no` / `start_time` / `end_time`）
 */
function shiftPeriods(periods, advance, pmFrom) {
  const list = periods || [];
  const n = Number(advance) || 0;
  const from = toMin(pmFrom);
  const unshifted = () => list.map((x) => Object.assign({}, x, { shifted: false }));
  if (n <= 0 || from === null) return unshifted();
  return list.map((x) => {
    const st = toMin(x.start_time);
    if (st === null || st < from) return Object.assign({}, x, { shifted: false });
    const et = toMin(x.end_time);
    return Object.assign({}, x, {
      start_time: fmtMin(st - n),
      end_time: et === null ? x.end_time : fmtMin(et - n),
      shifted: true,
    });
  });
}

/**
 * 功能：算出某学期第 N 周七天的日期与性质 —— 供课表接口把「这一周里哪天是假前一天」告诉前端。
 *
 * 说明：⚠️ 没设开学日期时返回**空数组**（不猜）；`weekNo` 非正数时同样返回空数组。
 * `statutory` 单独标出「**法定**放假日」（周末不算）—— 界面用它决定要不要画「休」字：
 * 周六周日是常识，每列都写个「休」只是噪音，而国庆调休那种日子必须写出来。
 */
function weekDaysOf(term, weekNo) {
  const start = term && term.start_monday;
  const w = Number(weekNo);
  if (!start || !Number.isFinite(w) || w < 1) return [];
  const monday = addDays(start, (Math.floor(w) - 1) * 7);
  if (monday === null) return [];
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const date = addDays(monday, weekday - 1);
    return {
      weekday,
      date,
      rest: isRestDay(date),
      statutory: isRestDate(date) && !isWorkDate(date),
      pre_holiday: isPreHoliday(date),
    };
  });
}

module.exports = {
  DEFAULT_PM_FROM,
  MAX_ADVANCE_MINUTES,
  addDays,
  isRestDay,
  isPreHoliday,
  planOf,
  shiftPeriods,
  weekDaysOf,
};
