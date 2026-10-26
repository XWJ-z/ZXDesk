'use strict';

/**
 * modules/bookmarks/export.js —— 网址收藏夹**给个人备份带出去的那一份**（0.5.0 模块化重构）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」
 *      （方案 §四 第 6 行要消灭的正是这种手写登记）。
 *
 * ⚠️ 三个键名是**历史契约**（个人导入认它们，见 `store/methods/backup.js`）：`bookmarks` /
 *    `bookmark_tags` / `bookmark_tag_links` —— 必须与表名一致，不许改成 `bmTags` 之类的内部别名。
 * ⚠️ 数据从**本模块自己的原语**取（`exportBookmarks`），所以删掉本模块目录时这一份自然消失，
 *    而备份里不会剩下一个「指向不存在模块」的键。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.5.3
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/架构文档/03-数据安全.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ bookmarks, bookmark_tags, bookmark_tag_links }`
 */
module.exports = (store, uid) => {
  const { bookmarks, bmTags, bmLinks } = store._bk.exportBookmarks(Number(uid));
  return { bookmarks, bookmark_tags: bmTags, bookmark_tag_links: bmLinks };
};
