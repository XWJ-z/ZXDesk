'use strict';

/**
 * modules/timetable/export.js —— 课表**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ terms, period_blocks, periods, courses, course_sessions, time_timetable_adjustments, time_timetable_day_rules }`
 */
module.exports = (store, uid) => {
  const { terms, pblocks, periods, courses, sessions, adjustments, day_rules: dayRules } =
    store._bk.exportTimetable(Number(uid));
  return {
    terms,
    period_blocks: pblocks,
    periods,
    courses,
    course_sessions: sessions,
    time_timetable_adjustments: adjustments,
    // （与 `time_timetable_adjustments` 同一个理由，见上面那段说明）
    time_timetable_day_rules: dayRules,
  };
};
