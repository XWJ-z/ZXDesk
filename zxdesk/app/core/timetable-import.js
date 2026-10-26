/**
timetable-import.js —— 课表语义层（**门面**：对外签名与拆分前逐字一致）
 *
 * 功能：课表语义层的对外门面。**拆分后本文件不再有实现**，只重导出
 *      `timetable/date-util.js` / `schedule-solve.js` / `parse.js` 里那批纯函数，
 *      导出面与拆分前**一个不差**（多一个少一个都算签名变化，生成器会当场报错）。
 *
 * ⚠️ 0.2.0（002 报告 §5.1 ②）拆自单文件 1108 行：按「日期与周次 / 作息求解 / 模板解析」三块分家。
 *    **门面刻意留在原路径**（报告原写 `timetable/index.js`）—— 这样任何外部 `require('./timetable-import.js')`
 *    都不用改，拆分与其它文件的拆分可以并行、零耦合。
 * ⚠️ 本文件是**纯函数**层（不碰 HTTP、不碰数据库），所以能在没有界面的情况下用真实样本反复调。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
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
