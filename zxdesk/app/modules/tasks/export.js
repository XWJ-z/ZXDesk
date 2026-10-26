'use strict';

/**
 * modules/tasks/export.js —— 任务板**给个人备份带出去的那一份**（0.5.0 模块化重构）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」
 *      （方案 §四 第 6 行要消灭的正是这种手写登记）。
 *
 * ⚠️ 这三个键名是**历史契约，一个都不能改**（个人导入按它们读 `dump[k]`，见
 *    `store/methods/backup.js` 的 `PERSONAL_SOURCES`）：
 *      · `projects` / `project_tasks` / `daily_tasks` —— 就是真实表名（这三张表从没改过名），
 *        但**仍然必须逐字照旧**：改了会让已发出去的备份文件失配。
 *    ⚠️ **父子顺序**：`project_tasks.project_id` → `projects.id`，导入时按
 *    `PERSONAL_SOURCES` 的顺序重建（父项在前）。本文件只负责「读」，**不动顺序**。
 *
 * ⚠️ 数据从**本模块自己的原语**取（`exportTasks`），所以删掉本模块目录时这一份自然消失，
 *    而备份里不会剩下一个「指向不存在模块」的键。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * ⭐ 0.8.12：`task_reports` / `project_comments` 两个备份键
 *    **跟着它们的表搬去了 `modules/teamwork/export.js`**（`exportFragments()` 按键合并，
 *    键名与内容一个字没变 ⇒ 个人备份/导入的行为零变化）。本模块现在只导出**任务板自己的三张表**。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.13
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
  // ⭐ 0.8.12：原先在这里读并导出的 `task_reports` / `project_comments`
  //    两个键，**跟着它们的表搬去了 `modules/teamwork/export.js`**（表在哪个模块，它的备份片段就在哪个模块）。
  //    ⛔ 备份键名一个都没改（历史契约，个人导入按它们读 `dump[k]`）。
  return {
    projects,
    project_tasks: ptasks,
    daily_tasks: dtasks,
  };
};
