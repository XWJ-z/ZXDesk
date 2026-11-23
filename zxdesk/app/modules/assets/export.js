'use strict';

/**
 * modules/assets/export.js —— 个人资产管理**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-10-02
 * @since 0.9.7
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
