'use strict';

/**
 * modules/hardware/export.js —— NAS硬件管理**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-NAS硬件管理.md、docs/公共/架构文档/03-数据安全.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ hardware }`
 */
module.exports = (store, uid) => {
  const { hardware } = store._bk.exportHardware(Number(uid));
  // **模板也进个人备份**（用户自己建的模板是他亲手搭的结构，换机 / 恢复之后不能丢；
  // 界面上全部退回「通用」—— 专业参数的值还在 `attrs` 里，但那一组框再也不显示了）。
  const { templates } = store._bk.exportHardwareTemplates(Number(uid));
  return { hardware, hardware_templates: templates };
};
