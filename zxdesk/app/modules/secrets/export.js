'use strict';

/**
 * modules/secrets/export.js —— **加密信息**给个人备份带出去的那一份
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那个键：`secrets`。
 * `store/methods/stats.js` 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、03-数据安全与备份.md、docs/公共/开发方案/42-加密信息.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 *
 * 说明：⚠️ 用 `listSecrets()` 而不是另开一个 `exportSecrets` op：那个原语已经把
 * 「按账号过滤 + 排序 + 返回副本」做完了，而备份要的就是这几行密文。
 * 多开一个 op 只会多一处要维护的同义实现（两个后端各一份）。
 */
module.exports = (store, uid) => {
  return { secrets: store._bk.listSecrets(Number(uid)) };
};
