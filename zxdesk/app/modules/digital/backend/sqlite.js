'use strict';

/**
 * modules/hardware/backend/sqlite.js —— NAS硬件管理台账（台账与愿望单同一张表）的**SQLite 版原语**
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/09-模块化重构.md
 */

const ops = {
  /**
   * 功能：列出该账号的全部硬件台账 / 愿望单条目（新的在前）。
   *
   * 说明：⭐ **检索与筛选刻意不在这一层做** —— 它们和寿命推算一起放在
   * `modules/hardware/store.js`，这样两个后端（SQLite / JSON）的筛选语义**逐字一致**，
   * 不会出现「装的是哪个后端，搜出来的结果就不一样」这种最难查的漂移
   */
  listHardware(uid) {
    return this._listSql('SELECT * FROM hardware_items WHERE user_id=? ORDER BY created_at DESC, id DESC', [uid]);
  },

  /**
   * 功能：按 id + 归属取一条台账记录；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 台账 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getHardware(uid, id) {
    return this.db.prepare('SELECT * FROM hardware_items WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断某条台账记录是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 用户 id
   * @param {number} id - 台账 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsHardware(uid, id) {
    return !!this.db.prepare('SELECT id FROM hardware_items WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：删除一条台账记录；返回是否真的删掉了一行。
   *
   * 说明：⚠️ 本表**没有子表**（1 期只有一张表），所以不像 `deleteProject` / `deleteTag`
   * 那样要连带清理 —— 硬件没有事件表与读数表（那两张排在 2 期路线里）。
   *
   */
  deleteHardware(uid, id) {
    return this.db.prepare('DELETE FROM hardware_items WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（台账与愿望单同一张表）。
   *
   * `exportAll()` 里那一条（`ORDER BY created_at DESC, id DESC`），一个字都没重写。
   * 搬走之后由 `modules/hardware/export.js` 调它，`stats.js` 不再手写这一行。
   * 走的是**本模块自己的原语**，所以删掉本模块目录时这一份自然消失，
   */
  exportHardware(uid) {
    const hardware = this.db
      .prepare('SELECT * FROM hardware_items WHERE user_id=? ORDER BY created_at DESC, id DESC')
      .all(uid);
    return { hardware };
  },

  /**
   * 功能：列出该账号的全部模板（内置的在前、自建的在后）。
   *
   * 说明：⚠️ 排序按 `sort_order, id` —— 内置 11 个播种时拿的是 10/20/30…，自建的从 1000 起，
   * 所以「预制的排前面、自己加的排后面」是**数据**保证的，⛔ 不靠 `builtin` 在界面上再排一次。
   *
   */
  listHardwareTemplates(uid) {
    return this._listSql('SELECT * FROM hardware_templates WHERE user_id=? ORDER BY sort_order ASC, id ASC', [uid]);
  },

  /**
   * 功能：按 id + 归属取一个模板；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 模板 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getHardwareTemplate(uid, id) {
    return this.db.prepare('SELECT * FROM hardware_templates WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断某个模板是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 用户 id
   * @param {number} id - 模板 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsHardwareTemplate(uid, id) {
    return !!this.db.prepare('SELECT id FROM hardware_templates WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：删除一个模板；返回是否真的删掉了一行。
   *
   * 说明：⚠️ 用它的那些硬件**一条都不会丢** —— `hardware_items.template_id` 上⛔ 没有外键，
   * 删掉模板之后那些行看起来就是「模板为空」，界面上按「通用」显示（与删分类只解绑同一条口径）。
   *
   */
  deleteHardwareTemplate(uid, id) {
    return this.db.prepare('DELETE FROM hardware_templates WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份模板（与 `exportHardware` 同一条口径）。
   * @param {number} uid - 用户 id
   * @returns {{templates: Array.<Object>}} 备份里那一个键
   */
  exportHardwareTemplates(uid) {
    const templates = this.db
      .prepare('SELECT * FROM hardware_templates WHERE user_id=? ORDER BY sort_order ASC, id ASC')
      .all(uid);
    return { templates };
  },
};

module.exports = { ops };
