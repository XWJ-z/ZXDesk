'use strict';

/**
 * modules/secrets/export.js —— **加密信息**给个人备份带出去的那一份（0.9.8）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那个键：`secrets`。
 *      `store/methods/stats.js` 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的
 *      片段合并成一份备份 —— **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要
 *      「每加一个模块都回来改 stats.js」（方案 §四 第 6 行要消灭的正是这种手写登记）。
 *
 * ⚠️ 键名 `secrets` 是**对外契约**（方案 42 §2.3 定死了「备份键 `secrets`」）：⛔ 别改成
 *    `secrets_items` 或 `secretItems` —— 备份文件是要能跨版本读的，键名一改等于旧备份里那份
 *    数据静默失联（备份看上去还完全正常）。
 * ⚠️ 这里搬的是**密文**：表里没有任何明文（连标题都是密文的一部分），所以进备份不会让备份文件
 *    多出一份敏感材料 —— 真正敏感的主密码从来不落任何地方。
 *    ⚠️⭐ 反过来：**只有配合密码库那份 `vault_meta` 才解得开**（DEK 在那边）。
 *    所以「整体备份 / 整体恢复」必须两个模块一起走 —— 它们本来就在同一份全量备份里
 *    （`exportWhole()` 按 `SCHEMA.tableNames()` 取，实验室库那一段自动带上本表）。
 * ⚠️ **本文件绝不记日志、绝不碰密钥**：它只把原语取回来的行原样交出去。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、03-数据安全与备份.md、docs/公共/开发方案/42-加密信息.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 *
 * 说明：⚠️ 用 `listSecrets()` 而不是另开一个 `exportSecrets` op：那个原语已经把
 *      「按账号过滤 + 排序 + 返回副本」做完了，而备份要的就是这几行密文。
 *      多开一个 op 只会多一处要维护的同义实现（两个后端各一份）。
 *
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {{secrets: Array.<Object>}} 备份里的那一个键
 */
module.exports = (store, uid) => {
  return { secrets: store._bk.listSecrets(Number(uid)) };
};
