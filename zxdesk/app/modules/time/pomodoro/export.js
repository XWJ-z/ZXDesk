'use strict';

/**
 * modules/pomodoro/export.js —— 番茄钟**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那两个键。`stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ time_pomodoro_sessions, time_pomodoro_prefs }`
 */
module.exports = (store, uid) => {
  const { time_pomodoro_sessions, time_pomodoro_prefs } = store._bk.exportPomodoro(Number(uid));
  return { time_pomodoro_sessions, time_pomodoro_prefs };
};
