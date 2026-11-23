'use strict';

/**
 * modules/idea/export.js —— 灵感库**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那一个键。`stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-17
 * @since 0.9.7
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
  // 三张表一起带出去 —— 键名与 `PERSONAL_SOURCES` 里的 `table` 逐字一致
  // （键撞车由 `exportFragments()` 抛错兜住）。
  return { idea, idea_tags, idea_tag_links };
};
