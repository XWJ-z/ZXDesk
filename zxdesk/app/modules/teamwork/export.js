'use strict';

/**
 * modules/teamwork/export.js —— 对话**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/架构文档/03-数据安全.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} 对话五键 ＋ 协作两键（`task_reports` / `project_comments`）
 */
module.exports = (store, uid) => {
  const { teamworkFriends, teamworkConvs, teamworkMembers, teamworkMsgs, teamworkCleared } = store._bk.exportTeamwork(Number(uid));
  // 协作的 `task_reports` / `project_comments` 两个备份键
  // **从 `modules/tasks/export.js` 整份搬来**（表在哪个模块，它的备份片段就在哪个模块）——
  // 键名与内容一个字没改（历史契约，个人导入按它们读 `dump[k]`）。
  const { ptasks, dtasks } = store._bk.exportTasks(Number(uid));
  const project_reports = store._bk.listTaskReportsForTasks(
    'project_tasks',
    ptasks.map((t) => Number(t.id)),
  );
  const daily_reports = store._bk.listTaskReportsForTasks(
    'daily_tasks',
    dtasks.map((t) => Number(t.id)),
  );
  const project_comments = store._bk.listCommentsOfAuthor(Number(uid));
  return {
    teamwork_friendships: teamworkFriends,
    teamwork_conversations: teamworkConvs,
    teamwork_members: teamworkMembers,
    teamwork_messages: teamworkMsgs,
    teamwork_cleared: teamworkCleared,
    task_reports: project_reports.concat(daily_reports),
    project_comments,
  };
};
