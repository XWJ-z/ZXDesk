'use strict';
/**
 * modules/time/export.js —— **番茄钟与日程表**（`0.8.13`）：个人备份片段的**拼装层**
 *
 * 功能：把三个同级子模块各自进个人备份的那一份拼成一份。`store/methods/stats.js` 通过
 *      `modules/registry.js` 的 `exportFragments()` 合并各模块的片段 —— **搬走一个模块目录，
 *      它那几行就消失**（`time/` 整目录删掉 ⇒ 三块的备份键一起消失，正是删目录验收要看的事）。
 *
 * ⚠️⭐ **13 个键里，课表那 5 个仍是 0.1.2 时代的老名字**（`terms` / `period_blocks` / `periods` /
 *    `courses` / `course_sessions`）—— 它们跟**表名**走会造成「用 0.1.1 导出的老备份读不出来」，
 *    所以**一个字都不许动**（理由逐字见 `timetable/export.js` 的文件头）。
 *    其余 8 个键（调休 / 按日备注 / 番茄 2 / 行程 4）**跟着新表名走**。
 *
 * ⚠️ 键撞车由 `exportFragments()` 抛错兜住；三个子模块之间的键名实测两两不重
 *    （5 个老名 ＋ `time_` 前缀那 8 个），这里只做拼接。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.13
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、03-数据安全与备份.md
 */

const timetableExport = require('./timetable/export.js');
const pomodoroExport = require('./pomodoro/export.js');
const tripExport = require('./trip/export.js');

/**
 * 功能：取本模块进个人备份的那一份数据（13 个键）。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} 13 个备份键
 */
module.exports = (store, uid) => ({
  ...timetableExport(store, uid),
  ...pomodoroExport(store, uid),
  ...tripExport(store, uid),
});
