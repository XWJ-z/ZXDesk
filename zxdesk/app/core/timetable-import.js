/**
 * timetable-import.js —— 课表语义层（**门面**：对外签名与拆分前逐字一致）
 *
 * 功能：课表语义层的对外门面。**拆分后本文件不再有实现**，只重导出
 * `timetable/date-util.js` / `schedule-solve.js` / `parse.js` 里那批纯函数，
 * 导出面与拆分前**一个不差**（多一个少一个都算签名变化，生成器会当场报错）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const timetable_date_util_js = require('./timetable/date-util.js');
const timetable_parse_js = require('./timetable/parse.js');
const timetable_schedule_solve_js = require('./timetable/schedule-solve.js');

module.exports = {
  numOr: timetable_date_util_js.numOr,
  toMin: timetable_date_util_js.toMin,
  fmtMin: timetable_date_util_js.fmtMin,
  mondayOf: timetable_date_util_js.mondayOf,
  dateOrdinal: timetable_date_util_js.dateOrdinal,
  weekNumberOf: timetable_date_util_js.weekNumberOf,
  weekdayOfDate: timetable_date_util_js.weekdayOfDate,
  guessStartMonday: timetable_date_util_js.guessStartMonday,
  guessTermName: timetable_date_util_js.guessTermName,
  weekdayOf: timetable_date_util_js.weekdayOf,
  WEEKDAY_NAMES: timetable_date_util_js.WEEKDAY_NAMES,
  normalizeWeeks: timetable_date_util_js.normalizeWeeks,
  weeksInclude: timetable_date_util_js.weeksInclude,
  maxWeekOf: timetable_date_util_js.maxWeekOf,
  generatePeriods: timetable_schedule_solve_js.generatePeriods,
  blockDuration: timetable_schedule_solve_js.blockDuration,
  fitClassTimes: timetable_schedule_solve_js.fitClassTimes,
  bestSplits: timetable_schedule_solve_js.bestSplits,
  solveSchedule: timetable_schedule_solve_js.solveSchedule,
  parsePeriodNumbers: timetable_schedule_solve_js.parsePeriodNumbers,
  contiguousRuns: timetable_schedule_solve_js.contiguousRuns,
  parseCellEntries: timetable_parse_js.parseCellEntries,
  detectTemplate: timetable_parse_js.detectTemplate,
  parseMetaFields: timetable_parse_js.parseMetaFields,
  colorOfCourse: timetable_parse_js.colorOfCourse,
  parseTimetable: timetable_parse_js.parseTimetable,
  buildTemplateCsv: timetable_parse_js.buildTemplateCsv,
};
