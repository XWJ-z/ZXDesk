'use strict';

/**
 * modules/assets/backend/json.js —— 个人资产管理（分组树 ＋ 通用条目）的 **JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⚠️ 与 SQLite 版**逐字同形**：同样的返回、同样的排序、同样的「只删一行 / 只解绑」语义。
 *     ⛔ 本文件里不许出现 `_` 开头的私有方法（`_bk` 门面不转发 ⇒ 真机 TypeError）。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.10
 * 相关：docs/公共/架构文档/26-个人资产管理.md、02-存储层与数据模型.md
 */

const { uidOf, nowStamp } = require('../../../core/store/helpers.js');

/** 功能：按 sort_order、id 升序（与 SQL 侧 `ORDER BY sort_order ASC, id ASC` 逐字一致）。 */
const bySort = (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id);
/** 功能：按 created_at 倒序、id 倒序（与 SQL 侧 `ORDER BY created_at DESC, id DESC` 逐字一致）。 */
const byNew = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id);

/** 功能：取某个账号在某个键下的全部行（永远是数组，绝不回 undefined）。 @param {Object} s - Store 实例 @param {string} key - 数据键 @param {(number|string)} uid - 用户 id @returns {Array.<Object>} 行数组 */
const rowsOf = (s, key, uid) => (s.data[key] || []).filter((r) => uidOf(r) === Number(uid));

const ops = {
  // ---- 分组树（asset_groups）----
  /**
   * 功能：列出该账号的全部分组行（子模块与分类同表，按 sort_order、id 升序）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 分组行数组
   */
  listAssetGroups(uid) {
    return rowsOf(this, 'asset_groups', uid).sort(bySort);
  },

  /**
   * 功能：按 id + 归属取一个分组；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分组 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getAssetGroup(uid, id) {
    return rowsOf(this, 'asset_groups', uid).find((g) => g.id === Number(id)) || null;
  },

  /**
   * 功能：判断某个分组是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分组 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsAssetGroup(uid, id) {
    return rowsOf(this, 'asset_groups', uid).some((g) => g.id === Number(id));
  },

  /**
   * 功能：删除**一个**分组行；返回是否真的删掉了一行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分组 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteAssetGroup(uid, id) {
    const before = (this.data.asset_groups || []).length;
    this.data.asset_groups = (this.data.asset_groups || []).filter(
      (g) => !(g.id === Number(id) && uidOf(g) === Number(uid)),
    );
    this._saveJson();
    return this.data.asset_groups.length < before;
  },

  // ---- 通用条目（asset_items）----
  /**
   * 功能：列出该账号的通用条目（`group_id` 为 null 时不过滤）。
   * @param {(number|string)} uid - 用户 id
   * @param {?(number|string)} groupId - 只看某个分组；null / '' 表示全部
   * @returns {Array.<Object>} 条目行数组
   */
  listAssetItems(uid, groupId) {
    const all = rowsOf(this, 'asset_items', uid);
    const g = groupId === null || groupId === undefined || groupId === '' ? null : Number(groupId);
    return (g === null ? all : all.filter((it) => Number(it.group_id) === g)).sort(byNew);
  },

  /**
   * 功能：按 id + 归属取一条通用条目。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getAssetItem(uid, id) {
    return rowsOf(this, 'asset_items', uid).find((it) => it.id === Number(id)) || null;
  },

  /**
   * 功能：判断一条通用条目是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsAssetItem(uid, id) {
    return rowsOf(this, 'asset_items', uid).some((it) => it.id === Number(id));
  },

  /**
   * 功能：删除一条通用条目；返回是否真的删掉了一行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteAssetItem(uid, id) {
    const before = (this.data.asset_items || []).length;
    this.data.asset_items = (this.data.asset_items || []).filter(
      (it) => !(it.id === Number(id) && uidOf(it) === Number(uid)),
    );
    this._saveJson();
    return this.data.asset_items.length < before;
  },

  /**
   * 功能：把某个分组下的条目**解绑**（`group_id` 置空），返回改动的行数。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} groupId - 要解绑的分组 id
   * @returns {number} 受影响的行数
   */
  unbindAssetItems(uid, groupId) {
    let n = 0;
    for (const it of this.data.asset_items || []) {
      if (uidOf(it) === Number(uid) && Number(it.group_id) === Number(groupId)) {
        it.group_id = null;
        n += 1;
      }
    }
    if (n) this._saveJson();
    return n;
  },

  /**
   * 功能：把挂在某个分组上的条目**整批改挂到另一个分组**（合并分组用）。
   *
   * 说明：⚠️ 与 `unbindAssetItems()` 同形、只是写的是目标 id —— 合并要的是「一条都不丢」，
   *      ⛔ 不能写成「先解绑再挂」两步（中途失败会留下一批孤儿）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} fromGroupId - 源分组 id
   * @param {(number|string)} toGroupId - 目标分组 id
   * @returns {number} 改挂的条数
   */
  reassignAssetItems(uid, fromGroupId, toGroupId) {
    let n = 0;
    for (const it of this.data.asset_items || []) {
      if (uidOf(it) === Number(uid) && Number(it.group_id) === Number(fromGroupId)) {
        it.group_id = Number(toGroupId);
        n += 1;
      }
    }
    if (n) this._saveJson();
    return n;
  },

  /**
   * 功能：给一个分组**换父项**（合并分组用）。
   *
   * 说明：⚠️⭐ 它**刻意绕过** `_update()` 的列白名单（`schema.js` 明写 `parent_id` 不进白名单）——
   *      成环那件事在合并这条路里**结构上不可能**（源与目标必须是同一个父项下的兄弟），
   *      论证见 SQLite 版同一处与 `../store.js` 的 `mergeAssetGroups()`。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分组 id
   * @param {?(number|string)} parentId - 新父项 id（`null` / 空串 = 挪回第一层）
   * @returns {boolean} 改到一行则为 true
   */
  reparentAssetGroup(uid, id, parentId) {
    const row = (this.data.asset_groups || []).find((g) => uidOf(g) === Number(uid) && Number(g.id) === Number(id));
    if (!row) return false;
    row.parent_id = parentId === null || parentId === undefined || parentId === '' ? null : Number(parentId);
    row.updated_at = nowStamp();
    this._saveJson();
    return true;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（两张表）。
   * @param {(number|string)} uid - 用户 id
   * @returns {{asset_groups: Array.<Object>, asset_items: Array.<Object>}} 备份里那两个键
   */
  exportAssets(uid) {
    const asset_groups = rowsOf(this, 'asset_groups', uid)
      .map((g) => ({ ...g }))
      .sort(bySort);
    const asset_items = rowsOf(this, 'asset_items', uid)
      .map((it) => ({ ...it }))
      .sort(byNew);
    return { asset_groups, asset_items };
  },
};

module.exports = { ops };
