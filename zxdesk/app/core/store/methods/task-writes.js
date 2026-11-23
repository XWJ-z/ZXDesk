'use strict';
/**
 * core/store/methods/task-writes.js —— **通用写原语**（`_insert` / `_update`）
 * 功能：`_insert` / `_update` 是**存储层的通用写入口** —— 写一行 / 改一行，统一带写闸门
 * `_assertWritable` 与列白名单 `_allowedCols` 约束。
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/09-模块化重构.md
 */
const { nowStamp } = require('../helpers.js');

module.exports = {
  /**
   * 功能：通用插入（分支后端）—— 所有新建类方法的统一写入口，先过写闸门。
   * @param {string} table - 表名
   * @param {Object} row - 待写入的列与值（键名须与表结构一致）
   * @returns {Object} 插入后的完整行（自增 `id` 已回填）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  _insert(table, row) {
    this._assertWritable();
    return this._bk.insert(table, row);
  },

  /**
   * 功能：通用更新（分支后端）—— 先过写闸门，再按 `_allowedCols` 白名单挑出可写列，
   * 并总是顺带刷新 `updated_at`（若该表有这一列）。
   *
   * `_allowedCols` 白名单已不含 `user_id`，这里是第二道保险
   * （白名单将来被改宽时仍拦住）。
   */
  _update(table, uid, id, input) {
    this._assertWritable();
    const allowed = this._allowedCols(table);
    const setKeys = [];
    const values = [];
    for (const k of Object.keys(input)) {
      if (k === 'id') continue;
      // `_allowedCols` 白名单已不含它，这里是第二道保险（白名单将来被改宽时仍拦住）。
      if (k === 'user_id') continue;
      if (allowed.includes(k)) {
        setKeys.push(k);
        values.push(input[k]);
      }
    }
    // 总是刷新 updated_at（若存在该列）
    if (allowed.includes('updated_at')) {
      setKeys.push('updated_at');
      values.push(nowStamp());
    }
    if (setKeys.length === 0) return false;
    return this._bk.update(table, uid, id, setKeys, values);
  },
};
