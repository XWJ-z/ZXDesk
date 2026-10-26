'use strict';

/**
 * modules/timetable/export.js —— 课表**给个人备份带出去的那一份**（0.5.0 模块化重构）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」
 *      （方案 §四 第 6 行要消灭的正是这种手写登记）。
 *
 * ⚠️ 这六个键名是**历史契约，一个都不能改**（个人导入按它们读 `dump[k]`，见 `store/methods/backup.js`
 *    的 `PERSONAL_SOURCES`）：
 *      · 课表 5 张表在 0.1.2 改过表名（`terms` → `time_timetable_terms` …），而**导出键至今仍是老名字**
 *        （改它会让已发出去的备份文件失配）：`terms` / `period_blocks` / `periods` / `courses` /
 *        `course_sessions`；
 *      · 单次调课是 0.2.3 新增的、**没有历史包袱**，键名就是真实表名：`time_timetable_adjustments`。
 *    ⇒ 所以这里**必须**写老键名（`store/methods/backup.js` 的 `PERSONAL_SOURCES` 为每张表列了
 *    「新键 + 老键」两组，导入时两组都认）。⛔ 不许改成 `time_timetable_terms` 这种「看着更整齐」的写法：
 *    那样导出的备份仍然能读，但**用 0.1.1 导出的老备份会读不出来**（数据在文件里，就是读不到）。
 *
 * ⚠️ 数据从**本模块自己的原语**取（`exportTimetable`），所以删掉本模块目录时这一份自然消失，
 *    而备份里不会剩下一个「指向不存在模块」的键。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.13
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
    // ⭐ 0.6.2 假期调休：键名用**真名** —— 这批键没有 0.1.2 那批老名字的历史包袱
    //    （与 `time_timetable_adjustments` 同一个理由，见上面那段说明）
    time_timetable_day_rules: dayRules,
  };
};
