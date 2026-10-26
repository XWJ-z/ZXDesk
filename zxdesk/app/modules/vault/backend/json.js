'use strict';

/**
 * modules/vault/backend/json.js —— 密码库（开库材料 vault_meta + 条目密文 vault_items）的**JSON 版原语**
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
 * @since 0.5.3
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/09-模块化重构.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 密码库（0.3.2）----
  /**
   * 功能：取某个账号的密码库「开库材料」那一行；没初始化过返回 null。
   *
   * 说明：⭐ 与 SQLite 后端同名同参、逐字同义 —— 包括**返回一份拷贝**这一条：
   *      调用方（`modules/vault/store.js`）会拿着它做解密，如果给的是内存里的活引用，
   *      后续任何一次写入都会让「正在解的那一行」跟着变（SQLite 那边天然返回新对象，
   *      两边行为必须一致，否则又是一个「换个后端就出怪事」的坑）。
   * ⚠️ 返回的是**原始行**（含 DEK 密文与验证块），**绝不许返回给前端、绝不许进日志**。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} `vault_meta` 行的副本；不曾初始化时为 null
   */
  getVaultMeta(uid) {
    const row = (this.data.vault_meta || []).find((m) => uidOf(m) === Number(uid));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  },

  /**
   * 功能：写入某个账号的密码库开库材料那一行（初始化时调用一次）。
   *
   * 说明：⚠️ 这里**不给 `id`、也不动 `_seq`** —— 这张表的主键是 `user_id`，
   *      跟 `_seq` 那套自增 id 无关（若顺手塞一个 `id`，整体备份恢复重算 `_seq` 时
   *      会把它算进最大值，两边的行形状就对不上了）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Object} row - 完整的 `vault_meta` 行（不含 `user_id`，由本函数补）
   * @returns {Object} 写入的行（已带 `user_id`）
   */
  insertVaultMeta(uid, row) {
    const full = Object.assign({}, row, { user_id: Number(uid) });
    this.data.vault_meta.push(full);
    this._saveJson();
    return full;
  },

  /**
   * 功能：整体改写某个账号的密码库开库材料（**改主密码时**用它重写 salt/DEK/验证块那一组）。
   * @param {(number|string)} uid - 用户 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateVaultMeta(uid, setKeys, values) {
    const i = (this.data.vault_meta || []).findIndex((m) => uidOf(m) === Number(uid));
    if (i < 0) return false;
    setKeys.forEach((k, n) => {
      this.data.vault_meta[i][k] = values[n];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：列出该账号的全部密码条目（**密文行**，按 `sort_order`、`id` 升序）。
   * 说明：⚠️ 只吐密文行、不做任何筛选与解密 —— 两个后端必须逐字一致（见 sqlite 那边同名 op）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 条目行数组（`iv` / `cipher` / `tag` 都是密文）
   */
  listVaultItems(uid) {
    return (this.data.vault_items || [])
      .filter((v) => uidOf(v) === Number(uid))
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id)
      .map((v) => JSON.parse(JSON.stringify(v)));
  },

  /**
   * 功能：按 id + 归属取一条密码条目（密文行）；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {?Object} 密文行的副本；未命中为 null
   */
  getVaultItem(uid, id) {
    const row = (this.data.vault_items || []).find((v) => v.id === Number(id) && uidOf(v) === Number(uid));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  },

  /**
   * 功能：判断某条密码条目是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsVaultItem(uid, id) {
    return (this.data.vault_items || []).some((v) => v.id === Number(id) && uidOf(v) === Number(uid));
  },

  /**
   * 功能：插入一条密码条目（密文行）；返回带回填 `id` 的那一行。
   * @param {(number|string)} uid - 用户 id
   * @param {Object} row - 密文行（`iv` / `cipher` / `tag` / `sort_order` / 时间戳）
   * @returns {Object} 写入的行（已带 `id`）
   */
  insertVaultItem(uid, row) {
    // ⚠️ 不能写 `this.insert(...)`：op 里的 `this` 是 Store 实例，通用 `insert` 挂在 `ops` 上
    //    （只能通过 `this._bk.insert(...)` 取到）。原语层内部一律自己写。
    const full = Object.assign({}, row, { user_id: Number(uid), id: this.data._seq++ });
    this.data.vault_items.push(full);
    this._saveJson();
    return full;
  },

  /**
   * 功能：改写一条密码条目的若干列（**更新条目时必须整组换掉 `iv` / `cipher` / `tag`**）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateVaultItem(uid, id, setKeys, values) {
    // ⚠️ 同 `insertVaultItem`：不能写 `this.update(...)`
    const i = (this.data.vault_items || []).findIndex((v) => v.id === Number(id) && uidOf(v) === Number(uid));
    if (i < 0) return false;
    setKeys.forEach((k, n) => {
      this.data.vault_items[i][k] = values[n];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：删除一条密码条目；返回是否真的删掉了一行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {boolean} 删到行则为 true
   */
  deleteVaultItem(uid, id) {
    const before = (this.data.vault_items || []).length;
    this.data.vault_items = (this.data.vault_items || []).filter(
      (v) => !(v.id === Number(id) && uidOf(v) === Number(uid)),
    );
    this._saveJson();
    return this.data.vault_items.length < before;
  },

  /**
   * 功能：数某个账号有几条密码条目（**只数个数量，不碰内容**）。
   * @param {(number|string)} uid - 用户 id
   * @returns {number} 条目条数
   */
  countVaultItems(uid) {
    return (this.data.vault_items || []).filter((v) => uidOf(v) === Number(uid)).length;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（开库材料 + 条目密文两张表）。
   *
   * 说明：⭐ 这是 0.5.0唯一新增的**新代码**：深拷贝 + 归属过滤 + 排序**逐字照抄**
   *      改造前 `exportAll()` 里那两行，一个字都没重写。
   *      ⚠️ 搬的是**密文**：这两张表里没有任何明文，所以进备份不会让备份文件多出一份敏感材料
   *      （真正敏感的是主密码，而它从来不落任何地方）。
   *      ⚠️ **两张表必须一起走**：只搬 `vault_items` 会让它们永远解不开（DEK 在 `vault_meta` 里）。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {{vaultMeta: Array.<Object>, vaultItems: Array.<Object>}} 备份里的那两个键
   */
  exportVault(uid) {
    const vaultMeta = JSON.parse(JSON.stringify(this.data.vault_meta || [])).filter((r) => uidOf(r) === Number(uid));
    const vaultItems = JSON.parse(JSON.stringify(this.data.vault_items || []))
      .filter((r) => uidOf(r) === Number(uid))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    return { vaultMeta, vaultItems };
  },
};

module.exports = { ops };
