'use strict';

/**
 * modules/vault/export.js —— 密码库**给个人备份带出去的那一份**（0.5.0 模块化重构）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」
 *      （方案 §四 第 6 行要消灭的正是这种手写登记）。
 *
 * ⚠️ 两个键名是**历史契约**（个人导入认它们，见 `store/methods/backup.js` 的 `PERSONAL_SOURCES`）：
 *    `vault_meta` / `vault_items` —— 必须与表名一致，不许改成 `vaultMeta` 之类的内部别名。
 *    ⚠️ **两张表必须一起走**：只搬条目会让它们永远解不开（DEK 在 `vault_meta` 里）。
 * ⚠️ 这里搬的是**密文**：两张表里没有任何明文（连标题都是密文的一部分），所以进备份
 *    不会让备份文件多出一份敏感材料 —— 真正敏感的主密码从来不落任何地方。
 * ⚠️ **本文件绝不记日志、绝不碰密钥**：它只把原语取回来的行原样交出去
 *    （与 `routes.js` 的「响应体里不出现密钥材料」是同一条底线）。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.5.3
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/架构文档/03-数据安全.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ vault_meta, vault_items }`
 */
module.exports = (store, uid) => {
  const { vaultMeta, vaultItems } = store._bk.exportVault(Number(uid));
  return { vault_meta: vaultMeta, vault_items: vaultItems };
};
