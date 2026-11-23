'use strict';
/**
 * modules/tasks/store.js —— 任务板业务方法（**由 `lib/` 两份合成**；注册表只认这个文件）
 * 功能：把项目 / 项目任务（`lib/projects.js`）与日常任务（`lib/tasks.js`）两组业务方法
 * 合成**一张方法表**交给 `store/index.js` 装配到 Store 原型上。
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/09-模块化重构.md
 */
const { today } = require('../../core/store/helpers.js');

module.exports = Object.assign(
  {
    /**
     * 功能：统计指定日期（缺省为今天）的今日待办数 —— 日常任务总数 + 每个项目的条数。
     * 说明：口径是「区间覆盖该日 且 未完成」，起始日靠 `COALESCE(start_date, due_date)` 推断
     * 而 **NULL 参与比较恒为 NULL** → 条件永不成立 → 静默漏算。
     * 历史的错误修法是启动时把 `start_date` 回填成 `due_date`（**改写用户数据**）；
     * 现在的修法是**在查询里推断**，且推断规则与前端完全一致（前端 `activeOn` 用 `start_date || due_date`）：
     */
    todayCounts(uid, date) {
      const d = date || today();
      const { projects, daily } = this._bk.todayCounts(uid, d);
      return { date: d, daily, projects };
    },
  },
  require('./lib/projects.js'),
  require('./lib/tasks.js'),
  // 周期任务的打卡原语（`task_occurrences` 这张新表只由它读写）。
  require('./lib/occurrences.js'),
);
