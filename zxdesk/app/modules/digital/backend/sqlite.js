'use strict';

/**
 * modules/hardware/backend/sqlite.js —— NAS硬件管理台账（台账与愿望单同一张表）的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/sqlite.js` 按段落**逐字节切出来**的，一个字都没重写
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

const ops = {
  // ---- NAS硬件管理（0.3.1）----
  /**
   * 功能：列出该账号的全部硬件台账 / 愿望单条目（新的在前）。
   *
   * 说明：⭐ **检索与筛选刻意不在这一层做** —— 它们和寿命推算一起放在
   *      `modules/hardware/store.js`，这样两个后端（SQLite / JSON）的筛选语义**逐字一致**，
   *      不会出现「装的是哪个后端，搜出来的结果就不一样」这种最难查的漂移
   *      （与收藏夹的检索同一条理由，见 backend/sqlite.js 的 `listBookmarks`）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 台账行数组（按 created_at、id 倒序）
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
   *      那样要连带清理 —— 硬件没有事件表与读数表（那两张排在 2 期路线里）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 台账 id
   * @returns {boolean} 删到行则为 true
   */
  deleteHardware(uid, id) {
    return this.db.prepare('DELETE FROM hardware_items WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（台账与愿望单同一张表）。
   *
   * 说明：⭐ 这是 0.5.0唯一新增的**新代码**：SQL 与排序**逐字照抄**改造前
   *      `exportAll()` 里那一条（`ORDER BY created_at DESC, id DESC`），一个字都没重写。
   *      搬走之后由 `modules/hardware/export.js` 调它，`stats.js` 不再手写这一行。
   *      ⚠️ 走的是**本模块自己的原语**，所以删掉本模块目录时这一份自然消失，
   *      备份里不会剩下一个「指向不存在模块」的键。
   *
   * @param {number} uid - 用户 id
   * @returns {{hardware: Array.<Object>}} 备份里那一个键
   */
  exportHardware(uid) {
    const hardware = this.db
      .prepare('SELECT * FROM hardware_items WHERE user_id=? ORDER BY created_at DESC, id DESC')
      .all(uid);
    return { hardware };
  },

  // ---- 硬件模板（⭐ 0.8.23，「预制新建硬件的模板菜单」）----
  /**
   * 功能：列出该账号的全部模板（内置的在前、自建的在后）。
   *
   * 说明：⚠️ 排序按 `sort_order, id` —— 内置 11 个播种时拿的是 10/20/30…，自建的从 1000 起，
   *      所以「预制的排前面、自己加的排后面」是**数据**保证的，⛔ 不靠 `builtin` 在界面上再排一次。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 模板行数组（按 sort_order、id 升序）
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
   *      删掉模板之后那些行看起来就是「模板为空」，界面上按「通用」显示（与删分类只解绑同一条口径）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 模板 id
   * @returns {boolean} 删到行则为 true
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
