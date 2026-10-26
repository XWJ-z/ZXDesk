'use strict';

/**
 * modules/idea/export.js —— 灵感库**给个人备份带出去的那一份**（0.7.1）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那一个键。`stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」。
 *
 * ⚠️ 键名是**历史契约**（个人导入认它，见 `store/methods/backup.js` 的 `PERSONAL_SOURCES`）：
 *    `idea` —— 必须与**表名**一致，不许改成 `ideas` / `ideaItems` 之类的别名。
 * ⚠️ 数据从**本模块自己的原语**取（`exportIdeas`），所以删掉本模块目录时这一份自然消失，
 *    备份里不会剩下一个「指向不存在模块」的键。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 * ⭐ **灵感必须进个人备份**：它是用户自己写的内容（常含私人情绪与工作想法），
 *    漏一处就是「备份看着成功、恢复后灵感全没」（调研报告 07 §三 3.1 末行）。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.15
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ idea, idea_tags, idea_tag_links }`
 */
module.exports = (store, uid) => {
  const { idea, idea_tags, idea_tag_links } = store._bk.exportIdeas(Number(uid));
  // ⭐ 0.8.15：三张表一起带出去 —— 键名与 `PERSONAL_SOURCES` 里的 `table` 逐字一致
  //    （键撞车由 `exportFragments()` 抛错兜住）。
  return { idea, idea_tags, idea_tag_links };
};
