'use strict';

/**
 * modules/teamwork/export.js —— 对话**给个人备份带出去的那一份**（0.5.0 模块化重构）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」
 *      （方案 §四 第 6 行要消灭的正是这种手写登记）。
 *
 * ⚠️ 五个键名是**历史契约，就是真实表名**（不许改成 `teamworkFriends` 之类的内部别名）：
 *    ① 机读的 `counts.teamwork_friendships` / `teamwork_conversations` / `teamwork_members` / `teamwork_messages` /
 *       `teamwork_cleared` 这一组口径来自它们（`stats.js` 按片段里的数组自动补计数）；
 *    ② 个人导入那条「跳过对话」的分支也按这些**表名**读 `dump[k]` 来数跳过条数
 *       （`store/methods/backup.js` 的 `_planImport`）—— 键名一变，界面上的「跳过 N 条」会静默变成 0。
 *
 * ⭐ **「只带我这一侧」是 的硬规矩，原样在这个模块的 `exportTeamwork()` 原语里**：
 *    我的好友关系行 / 我参与的会话 / 我的已读游标 / **我发出的消息** / **我清掉的那几段**（0.7.7）——
 *    **对方的消息一条都不进来**。个人备份是「我自己的数据」，把别人的聊天内容装进我的备份文件，
 *    既超出「一人一份」的边界，也会让「导出一下」变成泄露别人隐私的动作。
 *    ⚠️ 这条语义**不许在搬家的路上被顺手「优化」掉**（那正是搬家最该防的事）。
 *    ⭐ 0.7.7 第五个键 `teamwork_cleared` 与「已读游标」同类 —— 都是「我这一侧的读取状态」；
 *    不带它的备份语义说不通（带着我发出的消息，却不带「这些我已经清掉了」）。
 *    ⚠️ 两种导入模式**都跳过对话**，所以带与不带都不改变恢复行为 —— 它进备份是为了「将来真要
 *    做对话导入时数据齐全」，以及让备份文件如实反映「我这一侧长什么样」。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.13
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/架构文档/03-数据安全.md
 *
 * ⭐ 0.8.12：本片段**再添两个键** —— `task_reports` / `project_comments`，
 *    从 `modules/tasks/export.js` 搬来（那两张表搬进了本模块）。⚠️ 它们**不是**「只带我这一侧」的
 *    对话数据，但同样遵守「一人一份」：上报带的是我写的、评论只带**我写过的**。⛔ 键名与内容一个字没改。
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} 对话五键 ＋ 协作两键（`task_reports` / `project_comments`）
 */
module.exports = (store, uid) => {
  const { teamworkFriends, teamworkConvs, teamworkMembers, teamworkMsgs, teamworkCleared } = store._bk.exportTeamwork(Number(uid));
  // ⭐⭐ 0.8.12：协作的 `task_reports` / `project_comments` 两个备份键
  //    **从 `modules/tasks/export.js` 整份搬来**（表在哪个模块，它的备份片段就在哪个模块）——
  //    ⛔ 键名与内容一个字没改（历史契约，个人导入按它们读 `dump[k]`）。
  //    · 上报进备份的是「我写的」（⚠️ 任务 id 从 `tasks` 那两张地基表经 `exportTasks` 取）；
  //    · 评论只带**我写过的**（`user_id` ＝ 我）—— `project_id` 由导入侧重指到新建出来的项目，
  //      挂在**别人的项目**上的评论会因为「那个项目不在我的备份里」被**跳过并计数**（不报错，如实说）。
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
