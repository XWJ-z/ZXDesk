'use strict';

/**
 * modules/tasks/export.js —— 任务板**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ projects, project_tasks, daily_tasks }`
 */
module.exports = (store, uid) => {
  const { projects, ptasks, dtasks } = store._bk.exportTasks(Number(uid));
  // 原先在这里读并导出的 `task_reports` / `project_comments`
  // 两个键，**跟着它们的表搬去了 `modules/teamwork/export.js`**（表在哪个模块，它的备份片段就在哪个模块）。
  // 备份键名一个都没改（历史契约，个人导入按它们读 `dump[k]`）。
  return {
    projects,
    project_tasks: ptasks,
    daily_tasks: dtasks,
  };
};
