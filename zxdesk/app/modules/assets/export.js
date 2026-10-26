'use strict';

/**
 * modules/assets/export.js —— 个人资产管理**给个人备份带出去的那一份**（0.8.10）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**。
 *
 * ⚠️ 键名是**历史契约**（个人导入认它，见 `store/methods/backup.js` 的 `PERSONAL_SOURCES`）：
 *    `asset_groups` / `asset_items` —— 与表名一致，不许改成 `groups` / `items` 之类的内部别名。
 * ⚠️ ⭐ **两张表必须都进**：只搬分组会让条目在换机后全变成「未分组」，
 *    只搬条目会让自建的分组结构消失 —— 两种都**不报错**，都是静默丢数据。
 * ⚠️ 数据从**本模块自己的原语**取（`exportAssets`），所以删掉本模块目录时这一份自然消失。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.10
 * 相关：docs/公共/架构文档/26-个人资产管理.md、03-数据安全.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ asset_groups, asset_items }`
 */
module.exports = (store, uid) => {
  const { asset_groups, asset_items } = store._bk.exportAssets(Number(uid));
  return { asset_groups, asset_items };
};
