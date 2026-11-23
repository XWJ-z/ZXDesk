'use strict';
/**
 * modules/time/export.js —— **番茄钟与日程表**：个人备份片段的**拼装层**
 * 功能：把三个同级子模块各自进个人备份的那一份拼成一份。`store/methods/stats.js` 通过
 * `modules/registry.js` 的 `exportFragments()` 合并各模块的片段 —— **搬走一个模块目录…
 * @author zx
 * @date   2026-10-05
 * @since 0.9.7
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
