'use strict';

/**
 * modules/hardware/backend/json.js —— NAS硬件管理台账（台账与愿望单同一张表）的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/json.js` 按段落**逐字节切出来**的，一个字都没重写
 *    （切块前后 sha256 见 0.5.0的提交说明）。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.23
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/09-模块化重构.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

const ops = {
  // ---- NAS硬件管理（0.3.1）----
  /**
   * 功能：列出该账号的全部硬件台账 / 愿望单条目（新的在前）。
   * 说明：⭐ 检索、筛选与寿命推算**不在这一层做**（见 `modules/hardware/store.js`）—— 两个后端
   *      必须给出逐字一致的结果，语义只能有一份实现。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 台账行数组（按 created_at、id 倒序）
   */
  listHardware(uid) {
    return (this.data.hardware_items || [])
      .filter((h) => uidOf(h) === Number(uid))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id);
  },

  /**
   * 功能：按 id + 归属取一条台账记录；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 台账 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getHardware(uid, id) {
    return (this.data.hardware_items || []).find((h) => h.id === Number(id) && uidOf(h) === Number(uid)) || null;
  },

  /**
   * 功能：判断某条台账记录是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 台账 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsHardware(uid, id) {
    return (this.data.hardware_items || []).some((h) => h.id === Number(id) && uidOf(h) === Number(uid));
  },

  /**
   * 功能：删除一条台账记录；返回是否真的删掉了一行。
   * 说明：⚠️ 本表没有子表（1 期只有一张表），所以不像 `deleteBookmark` / `deleteTag`
   *      那样要自己写级联 —— 硬件的事件表与读数表排在 2 期路线里。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 台账 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteHardware(uid, id) {
    const before = (this.data.hardware_items || []).length;
    this.data.hardware_items = (this.data.hardware_items || []).filter(
      (h) => !(h.id === Number(id) && uidOf(h) === Number(uid)),
    );
    this._saveJson();
    return this.data.hardware_items.length < before;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（台账与愿望单同一张表）。
   *
   * 说明：⭐ 这是 0.5.0唯一新增的**新代码**：深拷贝 + 归属过滤 + 排序**逐字照抄**
   *      改造前 `exportAll()` 里那三行，一个字都没重写。
   *      搬走之后由 `modules/hardware/export.js` 调它，`stats.js` 不再手写这一行。
   *      ⚠️ 走的是**本模块自己的原语**，所以删掉本模块目录时这一份自然消失，
   *      备份里不会剩下一个「指向不存在模块」的键。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {{hardware: Array.<Object>}} 备份里那一个键
   */
  exportHardware(uid) {
    const hardware = JSON.parse(JSON.stringify(this.data.hardware_items || []))
      .filter((r) => uidOf(r) === Number(uid))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id);
    return { hardware };
  },

  // ---- 硬件模板（⭐ 0.8.23，「预制新建硬件的模板菜单」）----
  /**
   * 功能：列出该账号的全部模板（内置的在前、自建的在后）。
   * 说明：⚠️ 排序按 `sort_order, id`（内置 10/20/30…、自建 1000 起）—— 与 SQLite 版逐字同口径。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 模板行数组（按 sort_order、id 升序）
   */
  listHardwareTemplates(uid) {
    return (this.data.hardware_templates || [])
      .filter((t) => uidOf(t) === Number(uid))
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id);
  },

  /**
   * 功能：按 id + 归属取一个模板；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 模板 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getHardwareTemplate(uid, id) {
    return (this.data.hardware_templates || []).find((t) => t.id === Number(id) && uidOf(t) === Number(uid)) || null;
  },

  /**
   * 功能：判断某个模板是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 模板 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsHardwareTemplate(uid, id) {
    return (this.data.hardware_templates || []).some((t) => t.id === Number(id) && uidOf(t) === Number(uid));
  },

  /**
   * 功能：删除一个模板；返回是否真的删掉了一行。
   * 说明：⚠️ 用它的硬件一条不丢（`template_id` 无外键，删完那些行按「通用」显示）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 模板 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteHardwareTemplate(uid, id) {
    const before = (this.data.hardware_templates || []).length;
    this.data.hardware_templates = (this.data.hardware_templates || []).filter(
      (t) => !(t.id === Number(id) && uidOf(t) === Number(uid)),
    );
    this._saveJson();
    return this.data.hardware_templates.length < before;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份模板。
   * @param {(number|string)} uid - 用户 id
   * @returns {{templates: Array.<Object>}} 备份里那一个键
   */
  exportHardwareTemplates(uid) {
    const templates = JSON.parse(JSON.stringify(this.data.hardware_templates || []))
      .filter((r) => uidOf(r) === Number(uid))
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id);
    return { templates };
  },
};

module.exports = { ops };
