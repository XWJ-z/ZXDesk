'use strict';

/**
 * modules/secrets/backend/sqlite.js —— **加密信息**（`secrets_items` 密文行）的 SQLite 版原语
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** —— 「同名同参」由
 * `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、02-存储层与数据模型.md、docs/公共/开发方案/42-加密信息.md
 */

const ops = {
  /**
   * 功能：列出该账号的全部加密信息（**密文行**，按 `updated_at` 倒序、`id` 倒序）。
   *
   * 说明：⚠️ 只吐密文行、不解密、不筛选 —— 解密在业务层（两个后端必须逐字一致）。
   * 排序口径与索引 `idx_secrets_items_user(user_id, updated_at DESC)` 一致：
   * 「最近改过的在最上面」。
   */
  listSecrets(uid) {
    return this._listSql(
      "SELECT * FROM secrets_items WHERE user_id=? ORDER BY COALESCE(updated_at, '') DESC, id DESC",
      [uid],
    );
  },

  /**
   * 功能：按页取该账号的加密信息（**密文行**），排序口径与 `listSecrets()` 逐字一致。
   *
   * 说明：⭐⭐ 分页是为了「一次只解 50 条」：列表页对每条都要做一次 GCM 解密，
   * 几千条时那是几千次解密 ＋ 几千行 DOM。分页之后每页固定 50 条。
   * 排序必须与 `countSecrets()` 无关（它只数数），但**必须与 `listSecrets()` 一致**：
   */
  listSecretsPage(uid, limit, offset) {
    return this._listSql(
      "SELECT * FROM secrets_items WHERE user_id=? ORDER BY COALESCE(updated_at, '') DESC, id DESC LIMIT ? OFFSET ?",
      [uid, Number(limit) || 50, Number(offset) || 0],
    );
  },

  /**
   * 功能：该账号的加密信息条数（**不解密**，`COUNT(*)`）—— 列表的「共 N 条」与翻页判据。
   * @param {number} uid - 用户 id
   * @returns {number} 条数
   */
  countSecrets(uid) {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM secrets_items WHERE user_id=?').get(uid);
    return Number(r && r.n) || 0;
  },

  /**
   * 功能：插入一条加密信息（密文行）；返回带回填 `id` 的那一行。
   *
   * 说明：⚠️ 这里**不能**写 `this.insert(...)`：op 里的 `this` 是 Store 实例，而通用 `insert`
   * 挂在 `ops` 上（只能通过 `this._bk.insert(...)` 取到）—— 原语层内部一律内联 SQL。
   *
   */
  addSecret(uid, row) {
    const full = Object.assign({}, row, { user_id: Number(uid) });
    const cols = Object.keys(full);
    const sql = `INSERT INTO secrets_items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const r = this.db.prepare(sql).run(...cols.map((c) => full[c]));
    full.id = Number(r.lastInsertRowid);
    return full;
  },

  /**
   * 功能：按 id + 归属取一条加密信息（密文行）；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 它同时充当「归属校验」的唯一判据 —— 越权与不存在都得到 null，
   * 路由层据此回**同一个 404**（403 等于告诉对方「这条存在，只是不归你」）。
   *
   */
  getSecretRow(uid, id) {
    return this.db.prepare('SELECT * FROM secrets_items WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：改写一条加密信息的若干列（**更新时必须整组换掉 `iv` / `cipher` / `tag`**）。
   *
   * 说明：⚠️ `user_id` 限定不是装饰：它保证一次 PUT 不可能把记录「过户」给别人。
   * 密文三列**必须一起换**（单独换 `iv` 而不同时换 `cipher` 会把那条记录当场毁掉）——
   * 这一条由业务层保证，本层只照 `setKeys` 写。
   */
  updateSecret(uid, id, setKeys, values) {
    const sql = `UPDATE secrets_items SET ${setKeys.map((k) => k + '=?').join(',')} WHERE id=? AND user_id=?`;
    return this.db.prepare(sql).run(...values, id, uid).changes > 0;
  },

  /**
   * 功能：删除一条加密信息；返回是否真的删掉了一行。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {boolean} 删到行则为 true
   */
  removeSecret(uid, id) {
    return this.db.prepare('DELETE FROM secrets_items WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：列出该账号的**全部**附件行（跨条目）—— 给用量统计与「附件位置」面板用。
   *
   * 说明：⚠️ 与 `listSecretFilesOfItem()` 分开：那个是「某条加密信息下的附件」，
   * 而「忘了传 itemId ⇒ 悄悄返回全量」是个很难发现的越权面。
   *
   */
  listSecretFiles(uid) {
    return this._listSql('SELECT * FROM secrets_files WHERE user_id=? ORDER BY id ASC', [uid]);
  },

  /**
   * 功能：列出挂在某条加密信息下的附件行。
   * @param {number} uid - 用户 id
   * @param {number} itemId - 加密信息 id
   * @returns {Array.<Object>} 行数组（按 id 升序 = 上传先后）
   */
  listSecretFilesOfItem(uid, itemId) {
    return this._listSql('SELECT * FROM secrets_files WHERE user_id=? AND item_id=? ORDER BY id ASC', [uid, itemId]);
  },

  /**
   * 功能：按 id ＋ 归属取一条附件行；不存在或不属于该账号都返回 null（路由统一收口成 404）。
   * @param {number} uid - 用户 id
   * @param {number} fid - 附件 id
   * @returns {?Object} 行；未命中为 null
   */
  getSecretFile(uid, fid) {
    return this.db.prepare('SELECT * FROM secrets_files WHERE id=? AND user_id=?').get(fid, uid) || null;
  },

  /**
   * 功能：插入一条附件行；返回带回填 `id` 的那一行。
   * @param {number} uid - 用户 id
   * @param {Object} row - 行（`item_id` / `meta_*` / `size` / `root` / `rel` / `created_at`）
   * @returns {Object} 写入的行（已带 `id`）
   */
  insertSecretFile(uid, row) {
    const full = Object.assign({}, row, { user_id: Number(uid) });
    const cols = Object.keys(full);
    const sql = `INSERT INTO secrets_files (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const r = this.db.prepare(sql).run(...cols.map((c) => full[c]));
    full.id = Number(r.lastInsertRowid);
    return full;
  },

  /**
   * 功能：删一条附件行；返回是否真的删到了。
   * @param {number} uid - 用户 id
   * @param {number} fid - 附件 id
   * @returns {boolean} 删到行则为 true
   */
  deleteSecretFile(uid, fid) {
    return this.db.prepare('DELETE FROM secrets_files WHERE id=? AND user_id=?').run(fid, uid).changes > 0;
  },

  /**
   * 功能：改写一条附件行的 `rel`（**上传专用的收尾一步**）。
   *
   * 说明：⚠️ 为什么需要它：文件必须先落盘（`.part` ＋ fsync），而最终文件名是 `<id>.zxdesk` ——
   * `id` 只有插行之后才有。⇒ 插行时 `rel` 先写空串，拿到 id 后 `rename` 成最终名，
   * 再用本 op 把真实的 `rel` 补上。失败方向：这中间崩掉只会留一条 `rel=''` 的行
   */
  updateSecretFileRel(uid, fid, rel, sha256) {
    return (
      this.db
        .prepare('UPDATE secrets_files SET rel=?, sha256=? WHERE id=? AND user_id=?')
        .run(String(rel), String(sha256 == null ? '' : sha256), fid, uid).changes > 0
    );
  },

  /**
   * 功能：把一条附件行的 `root` 改到新位置（**重新关联**专用；`rel` 一个字不动）。
   *
   * 说明：⚠️ 只改 `root`：附件在磁盘上的相对位置 (`rel`) 在哪个根下都长一样，
   * 改它反而会把「认回来的那条」指向别处。
   * 与 `updateSecretFileRel()` 分开两个 op 而不是合成带可选参数的 ——
   */
  updateSecretFileRoot(uid, fid, root) {
    return this.db.prepare('UPDATE secrets_files SET root=? WHERE id=? AND user_id=?').run(String(root), fid, uid).changes > 0;
  },

  /**
   * 功能：该账号的附件用量 —— 条数 ＋ 明文字节合计。
   * @param {number} uid - 用户 id
   * @returns {{count: number, bytes: number}} 用量
   */
  secretFilesUsage(uid) {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM secrets_files WHERE user_id=?')
      .get(uid);
    return { count: Number(r.n) || 0, bytes: Number(r.bytes) || 0 };
  },

  /**
   * 功能：该账号自选的附件根目录；没设过返回 null（由业务层回落到默认根）。
   * @param {number} uid - 用户 id
   * @returns {?string} 绝对路径；没设过为 null
   */
  getSecretRoot(uid) {
    const r = this.db.prepare('SELECT root FROM secrets_settings WHERE user_id=?').get(uid);
    return r && r.root ? String(r.root) : null;
  },

  /**
   * 功能：取该账号的附件根**整行信息**（目录 ＋ 授权人 ＋ 授权时间）；没设过返回 null。
   * @param {number} uid - 用户 id
   * @returns {?{root: string, root_uid: ?number, root_username: ?string, authorized_at: ?string}} 信息
   */
  getSecretRootInfo(uid) {
    const r = this.db.prepare('SELECT * FROM secrets_settings WHERE user_id=?').get(uid);
    if (!r || !r.root) return null;
    return {
      root: String(r.root),
      root_uid: r.root_uid == null ? null : Number(r.root_uid),
      root_username: r.root_username == null ? null : String(r.root_username),
      authorized_at: r.authorized_at == null ? null : String(r.authorized_at),
    };
  },

  /**
   * 功能：清掉该账号的附件根设置（**撤销授权**用；⛔ 不删任何文件）。
   * @param {number} uid - 用户 id
   * @returns {boolean} 删到行则为 true
   */
  clearSecretRoot(uid) {
    return this.db.prepare('DELETE FROM secrets_settings WHERE user_id=?').run(Number(uid)).changes > 0;
  },

  /**
   * 功能：写入 / 覆盖该账号的附件根目录（一个账号一行）。
   *
   * 说明：⚠️ 用 `INSERT OR REPLACE`：`user_id` 是主键，这一行只有三个字段，
   * 「整行换掉」与「改 root」在语义上完全等价（没有别的东西会被误清）。
   * @param {number} uid - 用户 id
   */
  setSecretRoot(uid, root, stamp, meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    this.db
      .prepare(
        'INSERT OR REPLACE INTO secrets_settings (user_id, root, root_uid, root_username, authorized_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        Number(uid),
        String(root),
        m.root_uid == null ? null : Number(m.root_uid),
        m.root_username == null ? null : String(m.root_username),
        m.authorized_at == null ? null : String(m.authorized_at),
        String(stamp || ''),
      );
    return true;
  },
};

module.exports = { ops };
