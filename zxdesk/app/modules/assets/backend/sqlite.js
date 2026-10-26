'use strict';

/**
 * modules/assets/backend/sqlite.js —— 个人资产管理（分组树 ＋ 通用条目）的 **SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 * ⚠️ ⛔ 本文件里**不许出现 `_` 开头的私有方法**：`_bk` 门面不转发它们，
 *    表现是「本机测试全绿、真机上 TypeError」（写模块级函数、调用点把 `this.db` 传进去）。
 *
 * ⭐ **筛选与树形组装刻意不在这一层做**（与硬件台账 / 收藏夹同一条理由）：
 *    两个后端必须给出**逐字一致**的结果，语义只能有一份实现（在 `../store.js`）。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.10
 * 相关：docs/公共/架构文档/26-个人资产管理.md、02-存储层与数据模型.md
 */

const { nowStamp } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 分组树（asset_groups）----
  /**
   * 功能：列出该账号的全部分组行（子模块与分类同表，按 sort_order、id 升序）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 分组行数组
   */
  listAssetGroups(uid) {
    return this._listSql('SELECT * FROM asset_groups WHERE user_id=? ORDER BY sort_order ASC, id ASC', [uid]);
  },

  /**
   * 功能：按 id + 归属取一个分组；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 分组 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getAssetGroup(uid, id) {
    return this.db.prepare('SELECT * FROM asset_groups WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断某个分组是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 用户 id
   * @param {number} id - 分组 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsAssetGroup(uid, id) {
    return !!this.db.prepare('SELECT id FROM asset_groups WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：删除**一个**分组行；返回是否真的删掉了一行。
   *
   * 说明：⚠️ 子树与条目的处理**不在这里** —— 那是业务层级的事（见 `../store.js` 的
   *      `removeAssetGroup`）：它先按树把子孙逐行删掉、再把条目的 `group_id` 解绑。
   *      本原语只负责「删一行」这一件事（两个后端因此逐字同形）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 分组 id
   * @returns {boolean} 删到行则为 true
   */
  deleteAssetGroup(uid, id) {
    return this.db.prepare('DELETE FROM asset_groups WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  // ---- 通用条目（asset_items）----
  /**
   * 功能：列出该账号的通用条目（`group_id` 为 null 时不过滤；按 created_at、id 倒序）。
   * @param {number} uid - 用户 id
   * @param {?(number|string)} groupId - 只看某个分组；null / '' 表示全部
   * @returns {Array.<Object>} 条目行数组
   */
  listAssetItems(uid, groupId) {
    if (groupId === null || groupId === undefined || groupId === '') {
      return this._listSql('SELECT * FROM asset_items WHERE user_id=? ORDER BY created_at DESC, id DESC', [uid]);
    }
    return this._listSql('SELECT * FROM asset_items WHERE user_id=? AND group_id=? ORDER BY created_at DESC, id DESC', [
      uid,
      groupId,
    ]);
  },

  /**
   * 功能：按 id + 归属取一条通用条目；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getAssetItem(uid, id) {
    return this.db.prepare('SELECT * FROM asset_items WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断一条通用条目是否属于该账号。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsAssetItem(uid, id) {
    return !!this.db.prepare('SELECT id FROM asset_items WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：删除一条通用条目；返回是否真的删掉了一行。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {boolean} 删到行则为 true
   */
  deleteAssetItem(uid, id) {
    return this.db.prepare('DELETE FROM asset_items WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：把某个分组下的条目**解绑**（`group_id` 置空），返回改动的行数。
   *
   * 说明：⭐ 删分组时条目**解绑、不级联删**：台账是已发生的事实，
   *      分组只是一层归类 —— 与行程那条「删行程只解绑」同一个先例，⛔ 与任务板刻意相反。
   *      ⚠️ 逐分组调用（而不是收一个 id 数组）：两个后端的实现因此逐字同形，
   *      也不必处理「空数组 ⇒ `IN ()` 语法错」这类边角。
   *
   * @param {number} uid - 用户 id
   * @param {number} groupId - 要解绑的分组 id
   * @returns {number} 受影响的行数
   */
  unbindAssetItems(uid, groupId) {
    return this.db.prepare('UPDATE asset_items SET group_id=NULL WHERE user_id=? AND group_id=?').run(uid, groupId)
      .changes;
  },

  /**
   * 功能：把挂在某个分组上的条目**整批改挂到另一个分组**（合并分组用）。
   *
   * 说明：⚠️ 与 `unbindAssetItems()` 是**同一条 SQL 的两个方向**（那边写 `NULL`、这边写目标 id）——
   *      合并要的是「一条都不丢」，所以⛔ 不能写成「先解绑再挂」两步（中途失败会留下一批孤儿）。
   *      ⚠️ 目标分组的存在性与归属由 `../store.js` 先查（本层只管这一条 SQL）。
   *
   * @param {number} uid - 用户 id
   * @param {number} fromGroupId - 源分组 id
   * @param {number} toGroupId - 目标分组 id
   * @returns {number} 改挂的条数
   */
  reassignAssetItems(uid, fromGroupId, toGroupId) {
    return this.db
      .prepare('UPDATE asset_items SET group_id=? WHERE user_id=? AND group_id=?')
      .run(toGroupId, uid, fromGroupId).changes;
  },

  /**
   * 功能：给一个分组**换父项**（合并分组用）。
   *
   * 说明：⚠️⭐ 它**刻意绕过** `_update()` 的列白名单 —— `schema.js` 明写 `parent_id` 不进白名单
   *      （放开它就要防「挪到自己子孙下面」成环）。合并这一条路走**单独的改动**，安全性由
   *      `../store.js` 的结构性约束保证：源与目标必须是**同一个父项下的兄弟** ⇒ 源的子树里
   *      不可能有目标，成环在结构上就不可能。⛔ 别把 `parent_id` 加进白名单来「顺手实现」这个。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 分组 id
   * @param {?(number|string)} parentId - 新父项 id（`null` / 空串 = 挪回第一层）
   * @returns {boolean} 改到一行则为 true
   */
  reparentAssetGroup(uid, id, parentId) {
    const pid = parentId === null || parentId === undefined || parentId === '' ? null : Number(parentId);
    return (
      this.db
        .prepare('UPDATE asset_groups SET parent_id=?, updated_at=? WHERE id=? AND user_id=?')
        .run(pid, nowStamp(), id, uid).changes > 0
    );
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（两张表）。
   * @param {number} uid - 用户 id
   * @returns {{asset_groups: Array.<Object>, asset_items: Array.<Object>}} 备份里那两个键
   */
  exportAssets(uid) {
    const asset_groups = this.db
      .prepare('SELECT * FROM asset_groups WHERE user_id=? ORDER BY sort_order ASC, id ASC')
      .all(uid);
    const asset_items = this.db
      .prepare('SELECT * FROM asset_items WHERE user_id=? ORDER BY created_at DESC, id DESC')
      .all(uid);
    return { asset_groups, asset_items };
  },
};

module.exports = { ops };
