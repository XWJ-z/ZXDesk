'use strict';

/**
 * modules/vault/backend/sqlite.js —— 密码库（开库材料 vault_meta + 条目密文 vault_items）的**SQLite 版原语**
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
 * @since 0.5.3
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/09-模块化重构.md
 */

const ops = {
  // ---- 密码库（0.3.2）----
  /**
   * 功能：取某个账号的密码库「开库材料」那一行（`vault_meta`）；没初始化过返回 null。
   *
   * 说明：⭐ 返回的是**原始行**（含 `dek_cipher` / `verifier_*` 这些密文列）。
   *      ⚠️ 它**绝不许被直接返回给前端、也绝不许进日志** —— 消费方只有
   *      `modules/vault/store.js`（在内存里解密用）。对外的状态一律走 `vaultStatus()`。
   *      ⚠️ 这张表的主键是 `user_id`、**没有 `id` 列**，所以不能走通用的 `findTask` / `_update`，
   *      只能有这一组专用 op。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} `vault_meta` 行；不曾初始化时为 null
   */
  getVaultMeta(uid) {
    return this.db.prepare('SELECT * FROM vault_meta WHERE user_id=?').get(uid) || null;
  },

  /**
   * 功能：写入某个账号的密码库「开库材料」那一行（初始化时调用一次）。
   *
   * 说明：⚠️ SQLite 这边由 `user_id PRIMARY KEY` 兜住「一个账号只有一行」；
   *      JSON 后端没有约束，所以「重复初始化」的判定一律由业务层显式查
   *      `getVaultMeta()` 完成（两边行为必须一致，与 `createUser` 的改名查重同一做法）。
   *
   * @param {number} uid - 用户 id（同时写进 `user_id` 列）
   * @param {Object} row - 完整的 `vault_meta` 行（不含 `user_id`，由本函数补）
   * @returns {Object} 写入的行（已带 `user_id`）
   */
  insertVaultMeta(uid, row) {
    const full = Object.assign({}, row, { user_id: Number(uid) });
    const cols = Object.keys(full);
    const sql = `INSERT INTO vault_meta (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    this.db.prepare(sql).run(...cols.map((c) => full[c]));
    return full;
  },

  /**
   * 功能：整体改写某个账号的密码库开库材料（**改主密码时**用它重写 salt/DEK/验证块那一组）。
   *
   * 说明：⚠️ 只按 `user_id` 限定（这张表没有 `id`），且**只允许改传进来的列**；
   *      未知列会因为 SQL 语法错而抛 —— 这是刻意的（宁可炸在写入那一刻，
   *      也不要把一列拼错的名字静默忽略掉，那会得到「改完主密码还是旧的能开」）。
   *
   * @param {number} uid - 用户 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateVaultMeta(uid, setKeys, values) {
    const sql = `UPDATE vault_meta SET ${setKeys.map((k) => k + '=?').join(',')} WHERE user_id=?`;
    return this.db.prepare(sql).run(...values, uid).changes > 0;
  },

  /**
   * 功能：列出该账号的全部密码条目（**密文行**，按 `sort_order`、`id` 升序）。
   *
   * 说明：⚠️ 这里**只吐密文行**：解密不在这一层做（两个后端必须逐字一致，与收藏夹 / 硬件同一条规矩），
   *      也不在这一层做任何筛选 —— 1 期没有检索（标题在密文里，服务端根本无从筛）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 条目行数组（`iv` / `cipher` / `tag` 都是密文）
   */
  listVaultItems(uid) {
    return this._listSql('SELECT * FROM vault_items WHERE user_id=? ORDER BY sort_order ASC, id ASC', [uid]);
  },

  /**
   * 功能：按 id + 归属取一条密码条目（密文行）；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {?Object} 密文行；未命中为 null
   */
  getVaultItem(uid, id) {
    return this.db.prepare('SELECT * FROM vault_items WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断某条密码条目是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsVaultItem(uid, id) {
    return !!this.db.prepare('SELECT id FROM vault_items WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：插入一条密码条目（密文行）；返回带回填 `id` 的那一行。
   * @param {number} uid - 用户 id（同时写进 `user_id` 列）
   * @param {Object} row - 密文行（`iv` / `cipher` / `tag` / `sort_order` / 时间戳）
   * @returns {Object} 写入的行（已带 `id`）
   */
  insertVaultItem(uid, row) {
    // ⚠️ 这里**不能**写 `this.insert(...)`：op 里的 `this` 是 Store 实例，而通用 `insert`
    //    挂在 `ops` 上、只能通过 `this._bk.insert(...)` 取到 —— 直接 `this.insert` 是
    //    `undefined is not a function`（第一次加这条 op 时就踩到了）。原语层内部一律内联 SQL。
    const full = Object.assign({}, row, { user_id: Number(uid) });
    const cols = Object.keys(full);
    const sql = `INSERT INTO vault_items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const r = this.db.prepare(sql).run(...cols.map((c) => full[c]));
    full.id = Number(r.lastInsertRowid);
    return full;
  },

  /**
   * 功能：改写一条密码条目的若干列（**更新条目时必须整组换掉 `iv` / `cipher` / `tag`**）。
   *
   * 说明：⚠️ 加 `user_id` 限定不是装饰：`_update()` 那条通用路径**不会**把 `id` / `user_id`
   *      写进 SET，这里同理 —— 否则一次 PUT 就能把记录「过户」给别人。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateVaultItem(uid, id, setKeys, values) {
    // ⚠️ 同 `insertVaultItem`：不能写 `this.update(...)`（那是 ops 上的通用原语，不在 Store 原型上）
    const sql = `UPDATE vault_items SET ${setKeys.map((k) => k + '=?').join(',')} WHERE id=? AND user_id=?`;
    return this.db.prepare(sql).run(...values, id, uid).changes > 0;
  },

  /**
   * 功能：删除一条密码条目；返回是否真的删掉了一行。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {boolean} 删到行则为 true
   */
  deleteVaultItem(uid, id) {
    return this.db.prepare('DELETE FROM vault_items WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：数某个账号有几条密码条目（**只数个数量，不碰内容**）。
   * @param {number} uid - 用户 id
   * @returns {number} 条目条数
   */
  countVaultItems(uid) {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM vault_items WHERE user_id=?').get(uid).n);
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（开库材料 + 条目密文两张表）。
   *
   * 说明：⭐ 这是 0.5.0唯一新增的**新代码**：两条 SQL 与排序**逐字照抄**改造前
   *      `exportAll()` 里那两行，一个字都没重写。
   *      ⚠️ 搬的是**密文**：这两张表里没有任何明文，所以进备份不会让备份文件多出一份敏感材料
   *      （真正敏感的是主密码，而它从来不落任何地方）。
   *      ⚠️ **两张表必须一起走**：只搬 `vault_items` 会让它们永远解不开（DEK 在 `vault_meta` 里）。
   *
   * @param {number} uid - 用户 id
   * @returns {{vaultMeta: Array.<Object>, vaultItems: Array.<Object>}} 备份里的那两个键
   */
  exportVault(uid) {
    const vaultMeta = this.db.prepare('SELECT * FROM vault_meta WHERE user_id=?').all(uid);
    const vaultItems = this.db
      .prepare('SELECT * FROM vault_items WHERE user_id=? ORDER BY sort_order ASC, id ASC')
      .all(uid);
    return { vaultMeta, vaultItems };
  },
};

module.exports = { ops };
