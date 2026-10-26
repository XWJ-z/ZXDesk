'use strict';
/**
 * modules/tasks/store.js —— 任务板业务方法（**由 `lib/` 两份合成**；注册表只认这个文件）
 *
 * 功能：把项目 / 项目任务（`lib/projects.js`）与日常任务（`lib/tasks.js`）两组业务方法
 *      合成**一张方法表**交给 `store/index.js` 装配到 Store 原型上。
 *
 * ⭐ 0.5.0 模块化重构：注册表（`modules/registry.js` 的 `storeFor()`）**只认
 *    `modules/<name>/store.js` 这一个文件**，所以两份 lib 必须在这里汇合。
 *    ⚠️ 为什么不像别的模块那样「一个 store.js 装全部方法」：这两份是从
 *    `store/methods/projects.js` 与 `store/methods/tasks.js` **原样搬过来的**，
 *    合并成一个大文件属于「搬家时顺手重排」——刻意不做（脚本搬、
 *    逐字节对账，不许顺手改结构）。
 *
 * ⚠️ `Object.assign` 的语义是**后来者静默覆盖前者**，所以这两份**决不允许有同名方法**：
 *    现已人工核过一遍（`projects.js`：listProjects / createProject / updateProject /
 *    deleteProject / ownsProject / _assertProjectOwned / listProjectTasks /
 *    createProjectTask / updateProjectTask / deleteProjectTask；
 *    `tasks.js`：listDailyTasks / createDailyTask / updateDailyTask / deleteDailyTask /
 *    _maintainCompletedAt / _findTask / _findDailyTask；
 *    `occurrences.js`（⭐ 0.8.14 起合成进来的第三份）：tickTask / untickTask / ticksOf
 *    —— **三份之间交集为空**），并且 `store/index.js` 的 `assertNoMethodClash()` 会在
 *    **装配期**机械复查一遍（撞名一律启动即抛）。
 *
 * ⚠️ 通用写原语 `_insert` / `_update` **不在**这里：它们是六个模块共用的，
 *    住在 `core/store/methods/task-writes.js`（见那个文件的说明）。
 *
 * ⭐ 0.8.12：原先在这里合成的**第三份** `lib/collab.js`（协作那一层）
 *    **整份搬去了 `modules/teamwork/`**（判据与接口与「团队协作」同处一个模块）—— 所以现在回到两份。
 *    ⚠️ 任务板仍然是「协作」的地基（`projects` / `project_tasks` 两张表与它们的业务方法留在这里），
 *    但**协作的业务方法一份都不在本模块了**。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.14
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/09-模块化重构.md
 */
const { today } = require('../../core/store/helpers.js');

module.exports = Object.assign(
  {
    /**
     * 功能：统计指定日期（缺省为今天）的今日待办数 —— 日常任务总数 + 每个项目的条数。
     * 说明：口径是「区间覆盖该日 且 未完成」，起始日靠 `COALESCE(start_date, due_date)` 推断
     *      （0.0.8 修正，别改回 `start_date<=?`）：0.0.5 之前建的任务 `start_date` 为 NULL，
     *      而 **NULL 参与比较恒为 NULL** → 条件永不成立 → 静默漏算。
     *      历史的错误修法是启动时把 `start_date` 回填成 `due_date`（**改写用户数据**）；
     *      现在的修法是**在查询里推断**，且推断规则与前端完全一致（前端 `activeOn` 用 `start_date || due_date`）：
     *      老任务因此只在「截止日当天」计入待办 —— 与界面上看到的完全一样，而库里一个字节都没被改。
     *      ⚠️ 不要为了走索引而改写成 `(start_date IS NULL OR start_date<=?)`：那会把老任务算进**截止日之前**的
     *      每一天，与前端显示不一致（前端按单日处理）。
     *
     * ⭐ 0.5.0：本方法从 `core/store/methods/stats.js` **原样搬进模块目录**
     *      （方法体一个字没改）—— 它读的是任务板自己的两张表，属于本模块的业务。
     *      核心那边的 `stats.js` 留了一个 `todayCountsOf()` 包装（模块不在时回一组 0），
     *      供 `summary()` 与 `/api/bootstrap` 在「任务板被删掉」时也能正常降级。
     *
     * @param {number} uid - 用户 id
     * @param {string} [date] - 目标日期 `YYYY-MM-DD`；缺省取今天
     * @returns {Object} `{ date, daily, projects }`；`daily` 是日常任务条数，
     *     `projects` 是「项目 id → 条数」的映射
     */
    todayCounts(uid, date) {
      const d = date || today();
      const { projects, daily } = this._bk.todayCounts(uid, d);
      return { date: d, daily, projects };
    },
  },
  require('./lib/projects.js'),
  require('./lib/tasks.js'),
  // ⭐ 0.8.14：周期任务的打卡原语（`task_occurrences` 这张新表只由它读写）。
  require('./lib/occurrences.js'),
);
