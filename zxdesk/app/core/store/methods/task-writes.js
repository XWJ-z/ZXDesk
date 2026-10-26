'use strict';
/**
 * core/store/methods/task-writes.js —— **通用写原语**（`_insert` / `_update`）
 *
 * 功能：`_insert` / `_update` 是**存储层的通用写入口** —— 写一行 / 改一行，统一带写闸门
 *      `_assertWritable` 与列白名单 `_allowedCols` 约束。
 *
 * ⚠️ ⭐ **谁在用、谁不用（按实测改正，别照抄旧说法）**：
 *    · **在用的**：那些「一行就是一个平铺的实体」的业务方法 —— 任务 / 项目（`modules/tasks/lib/`）、
 *      收藏夹、硬件台账等，它们是**逐列**写的，通用原语正合适；
 *    · **刻意不用的**：**密码库**（`modules/vault/**` 里 `_insert` / `_update` **一处都没有**）。
 *      它的行**不是平铺实体**：条目内容整条是一个密文（`{title,username,password,url,note,tags}`），
 *      每一列都是密码学材料，改动必须**整条重新加密后整体重写**（`vault_items` 只有 `user_id` 做主键、
 *      **连 `id` 列都没有**，`vault_meta` 更是一条列都不进 `allowedCols`）。走逐列白名单那条路
 *      既表达不了这个语义、又会把「哪一列变了」这种东西变成可写面。
 *    ⇒ 一句话：**通用写原语服务的是「平铺式」业务方法；密码库刻意例外，只许由自己的专用方法整体重写。**
 *
 * ⭐ **0.5.0（任务板搬迁）为什么这两个原语留在核心**（施工单 §2 的硬约束）：
 *    它们原先与日常任务的方法同住在 `store/methods/tasks.js` 里，任务板搬进
 *    `modules/tasks/` 时**刻意只带走任务那一半**。理由：`_insert` / `_update`
 *    **不是任务板的业务**，而是**存储层的通用写入原语** —— 若跟着搬走，
 *    「删目录验收」会立刻变成一场事故：移走 `modules/tasks/` 之后，`_insert` / `_update`
 *    在 Store 原型上**不存在**，收藏夹新建书签、硬件新建台账、课表导入、对话发消息
 *    **全部**变成运行期 `this._insert is not a function`，
 *    而**启动、lint、契约自检一个都不报**（「业务方法住在哪个文件」与
 *    `_bk` 那条「op 住在哪个文件」是两件不同的事，后者由 `MERGED_OPS` 兜住）。
 *
 * ⚠️ 反过来，任务侧的 `_findTask` / `_maintainCompletedAt` / `_findDailyTask`
 *    **跟着模块走**（在 `modules/tasks/lib/tasks.js`）：它们只服务两类任务，
 *    属于任务板的业务，与 `_insert` / `_update` 的性质不同。
 *
 * ⚠️ 方法体是从改造前的 `db.js` / `store/methods/tasks.js` 按字节切出来的（分岔那段在 backend/*.js）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.5.3
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
   *      并总是顺带刷新 `updated_at`（若该表有这一列）。
   *
   * 说明：⚠️ `id` / `user_id` 绝不进 SET：否则一次 PUT 就能把记录「过户」给别人。
   *      `_allowedCols` 白名单已不含 `user_id`，这里是第二道保险
   *      （白名单将来被改宽时仍拦住）。
   *      ⚠️ **这是六个模块共用的通用原语，不许搬进任何模块目录**（见文件头说明）。
   *
   * @param {string} table - 表名
   * @param {number} uid - 账号 id（充当 WHERE 条件，只能改到自己的行）
   * @param {number} id - 行 id
   * @param {Object} input - 待更新的列与值
   * @returns {boolean} 是否真的更新到了（白名单里一列都没命中时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  _update(table, uid, id, input) {
    this._assertWritable();
    const allowed = this._allowedCols(table);
    const setKeys = [];
    const values = [];
    for (const k of Object.keys(input)) {
      if (k === 'id') continue;
      // ⚠️ `user_id` 绝不进 SET：否则一次 PUT 就能把记录「过户」给别人。
      //    `_allowedCols` 白名单已不含它，这里是第二道保险（白名单将来被改宽时仍拦住）。
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
