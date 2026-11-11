'use strict';

/**
 * modules/secrets/backend/json.js —— **加密信息**（`secrets_items` 密文行）的 JSON 版原语
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** —— 「同名同参」由
 *      `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.data` / `this._saveJson()`。⚠️ 而本模块 `database: "lab"` ⇒ 门面会在**调用这些 op
 *    之前**把 `this.data` 切到实验室库那一份、并在 finally 里还原（`Store._runOnDb()`）。
 *    所以下面每一句 `this.data` 读写的都是 `zxdesk-lab.json`，本文件**不需要知道**自己是分库的。
 *
 * ⭐ **返回的是副本，不是内存里的活引用** —— 与 SQLite 那边「每次查都是一份新对象」保持同义：
 *    业务层拿了它就去解密，若给的是活引用，后续任何一次写入都会让「正在解的那一行」跟着变
 *    （两边行为不一致就会变成「换个后端出怪事」的那类坑）。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、02-存储层与数据模型.md、docs/公共/开发方案/42-加密信息.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 加密信息（0.9.8 · 实验室第一格）----
  /**
   * 功能：列出该账号的全部加密信息（**密文行**，按 `updated_at` 倒序、`id` 倒序）。
   *
   * 说明：⚠️ 排序口径必须与 SQLite 那条**逐字一致**（含 NULL 的兜底）：
   *      SQLite 那边用 `COALESCE(updated_at,'')`，这里同理把 `null/undefined` 当空串比 ——
   *      否则同一份数据在两个后端下会给出**不同的顺序**，而那种差异只在回退后端才出现。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 条目行数组（`iv` / `cipher` / `tag` 都是密文）
   */
  listSecrets(uid) {
    const key = (r) => String(r && r.updated_at != null ? r.updated_at : '');
    return (this.data.secrets_items || [])
      .filter((v) => uidOf(v) === Number(uid))
      .sort((a, b) => {
        const d = key(b).localeCompare(key(a));
        return d || Number(b.id) - Number(a.id);
      })
      .map((v) => JSON.parse(JSON.stringify(v)));
  },

  /**
   * 功能：按页取该账号的加密信息（**密文行**），排序口径与 `listSecrets()` 逐字一致。
   *
   * 说明：⚠️ 与 SQLite 侧同形：排序必须与 `listSecrets()` 一致，否则翻页会重复 / 漏条。
   * @param {(number|string)} uid - 用户 id
   * @param {number} limit - 每页条数
   * @param {number} offset - 跳过多少条
   * @returns {Array.<Object>} 条目行数组
   */
  listSecretsPage(uid, limit, offset) {
    // ⚠️ 不能写 `this.listSecrets(...)`：op 里的 `this` 是 Store 实例，`listSecrets` 挂在 ops 上
    //    （与上面 `insert` / `addSecret` 同一条坑）⇒ 这里自己过滤＋排序，口径逐字照抄上面那条。
    const key = (r) => String(r && r.updated_at != null ? r.updated_at : '');
    const start = Math.max(0, Number(offset) || 0);
    const take = Math.max(1, Number(limit) || 50);
    return (this.data.secrets_items || [])
      .filter((v) => uidOf(v) === Number(uid))
      .sort((a, b) => {
        const d = key(b).localeCompare(key(a));
        return d || Number(b.id) - Number(a.id);
      })
      .slice(start, start + take)
      .map((v) => JSON.parse(JSON.stringify(v)));
  },

  /**
   * 功能：该账号的加密信息条数（不涉及密文）。
   * @param {(number|string)} uid - 用户 id
   * @returns {number} 条数
   */
  countSecrets(uid) {
    return (this.data.secrets_items || []).filter((v) => uidOf(v) === Number(uid)).length;
  },

  /**
   * 功能：插入一条加密信息（密文行）；返回带回填 `id` 的那一行。
   *
   * 说明：⚠️ 不能写 `this.insert(...)`：op 里的 `this` 是 Store 实例，通用 `insert` 挂在 `ops` 上
   *      （只能通过 `this._bk.insert(...)` 取到）。原语层内部一律自己写。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Object} row - 密文行（`iv` / `cipher` / `tag` / 时间戳）
   * @returns {Object} 写入的行（已带 `id`）
   */
  addSecret(uid, row) {
    if (!Array.isArray(this.data.secrets_items)) this.data.secrets_items = [];
    const full = Object.assign({}, row, { user_id: Number(uid), id: this.data._seq++ });
    this.data.secrets_items.push(full);
    this._saveJson();
    return full;
  },

  /**
   * 功能：按 id + 归属取一条加密信息（密文行）；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {?Object} 密文行的副本；未命中为 null
   */
  getSecretRow(uid, id) {
    const row = (this.data.secrets_items || []).find((v) => v.id === Number(id) && uidOf(v) === Number(uid));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  },

  /**
   * 功能：改写一条加密信息的若干列（**更新时必须整组换掉 `iv` / `cipher` / `tag`**）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateSecret(uid, id, setKeys, values) {
    const i = (this.data.secrets_items || []).findIndex(
      (v) => v.id === Number(id) && uidOf(v) === Number(uid),
    );
    if (i < 0) return false;
    setKeys.forEach((k, n) => {
      this.data.secrets_items[i][k] = values[n];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：删除一条加密信息；返回是否真的删掉了一行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {boolean} 删到行则为 true
   */
  removeSecret(uid, id) {
    const before = (this.data.secrets_items || []).length;
    this.data.secrets_items = (this.data.secrets_items || []).filter(
      (v) => !(v.id === Number(id) && uidOf(v) === Number(uid)),
    );
    this._saveJson();
    return this.data.secrets_items.length < before;
  },

  // ---- 附件（0.9.8 · 方案 42 §2.7）----
  /**
   * 功能：列出该账号的**全部**附件行（跨条目）—— 给用量统计与「附件位置」面板用。
   *
   * 说明：⚠️ 与 `listSecretFilesOfItem()` 分开的理由见 SQLite 侧同处的注释
   *      （合成一个带可选参数的 op，「忘了传 itemId ⇒ 悄悄返回全量」是个越权面）。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 行数组（按 id 升序）
   */
  listSecretFiles(uid) {
    return (this.data.secrets_files || [])
      .filter((v) => uidOf(v) === Number(uid))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((v) => JSON.parse(JSON.stringify(v)));
  },

  /**
   * 功能：列出挂在某条加密信息下的附件行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} itemId - 加密信息 id
   * @returns {Array.<Object>} 行数组（按 id 升序）
   */
  listSecretFilesOfItem(uid, itemId) {
    return (this.data.secrets_files || [])
      .filter((v) => uidOf(v) === Number(uid) && Number(v.item_id) === Number(itemId))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((v) => JSON.parse(JSON.stringify(v)));
  },

  /**
   * 功能：按 id ＋ 归属取一条附件行；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} fid - 附件 id
   * @returns {?Object} 行的副本；未命中为 null
   */
  getSecretFile(uid, fid) {
    const row = (this.data.secrets_files || []).find((v) => v.id === Number(fid) && uidOf(v) === Number(uid));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  },

  /**
   * 功能：插入一条附件行；返回带回填 `id` 的那一行。
   * @param {(number|string)} uid - 用户 id
   * @param {Object} row - 行
   * @returns {Object} 写入的行（已带 `id`）
   */
  insertSecretFile(uid, row) {
    if (!Array.isArray(this.data.secrets_files)) this.data.secrets_files = [];
    const full = Object.assign({}, row, { user_id: Number(uid), id: this.data._seq++ });
    this.data.secrets_files.push(full);
    this._saveJson();
    return full;
  },

  /**
   * 功能：删一条附件行；返回是否真的删到了。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} fid - 附件 id
   * @returns {boolean} 删到行则为 true
   */
  deleteSecretFile(uid, fid) {
    const before = (this.data.secrets_files || []).length;
    this.data.secrets_files = (this.data.secrets_files || []).filter(
      (v) => !(v.id === Number(fid) && uidOf(v) === Number(uid)),
    );
    this._saveJson();
    return this.data.secrets_files.length < before;
  },

  /**
   * 功能：改写一条附件行的 `rel`（**上传专用的收尾一步**）。
   *
   * 说明：⚠️ 为什么需要它：文件必须先落盘（`.part` ＋ fsync），而最终文件名是 `<id>.zxdesk` ——
   *      `id` 只有插行之后才有。⇒ 插行时 `rel` 先写空串，拿到 id 后 `rename` 成最终名，
   *      再用本 op 把真实的 `rel` 补上。失败方向：这中间崩掉只会留一条 `rel=''` 的行
   *      （点开回 400「文件不在原位置」），⛔ 不会指向别人的文件。
   * ⭐ 与 SQLite 侧同形：`rel` 与 `sha256` 一起写（两者都等文件落定才知道）。
   * @param {number} uid - 用户 id
   * @param {number} fid - 附件 id
   * @param {string} rel - 新的相对路径
   * @param {string} [sha256] - 整文件 SHA-256（小写 hex）
   * @returns {boolean} 改到行则为 true
   */
  updateSecretFileRel(uid, fid, rel, sha256) {
    const row = (this.data.secrets_files || []).find((v) => v.id === Number(fid) && uidOf(v) === Number(uid));
    if (!row) return false;
    row.rel = String(rel);
    row.sha256 = String(sha256 == null ? '' : sha256);
    this._saveJson();
    return true;
  },

  /**
   * 功能：把一条附件行的 `root` 改到新位置（重新关联专用；`rel` 不动）。
   *
   * 说明：与 SQLite 后端同名同参（`backend/index.js` 在加载时逐个比对）；
   *      ⚠️ 只改 `root`，理由见 SQLite 侧同处的注释。JSON 后端每改一行都整份落盘 ——
   *      重新关联的行数一般是个位数到几十，可接受；真到几千行要改成批量，那是另一单的事。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} fid - 附件 id
   * @param {string} root - 新的绝对根
   * @returns {boolean} 改到行则为 true
   */
  updateSecretFileRoot(uid, fid, root) {
    const row = (this.data.secrets_files || []).find((v) => v.id === Number(fid) && uidOf(v) === Number(uid));
    if (!row) return false;
    row.root = String(root);
    this._saveJson();
    return true;
  },

  /**
   * 功能：该账号的附件用量 —— 条数 ＋ 明文字节合计。
   * @param {(number|string)} uid - 用户 id
   * @returns {{count: number, bytes: number}} 用量
   */
  secretFilesUsage(uid) {
    const mine = (this.data.secrets_files || []).filter((v) => uidOf(v) === Number(uid));
    return { count: mine.length, bytes: mine.reduce((sum, v) => sum + (Number(v.size) || 0), 0) };
  },

  /**
   * 功能：该账号自选的附件根目录；没设过返回 null。
   * @param {(number|string)} uid - 用户 id
   * @returns {?string} 绝对路径；没设过为 null
   */
  getSecretRoot(uid) {
    const row = (this.data.secrets_settings || []).find((v) => uidOf(v) === Number(uid));
    return row && row.root ? String(row.root) : null;
  },

  /**
   * 功能：取该账号的附件根**整行信息**（目录 ＋ 授权人 ＋ 授权时间）；没设过返回 null。
   * @param {(number|string)} uid - 用户 id
   * @returns {?{root: string, root_uid: ?number, root_username: ?string, authorized_at: ?string}} 信息
   */
  getSecretRootInfo(uid) {
    const row = (this.data.secrets_settings || []).find((v) => uidOf(v) === Number(uid));
    if (!row || !row.root) return null;
    return {
      root: String(row.root),
      root_uid: row.root_uid == null ? null : Number(row.root_uid),
      root_username: row.root_username == null ? null : String(row.root_username),
      authorized_at: row.authorized_at == null ? null : String(row.authorized_at),
    };
  },

  /**
   * 功能：清掉该账号的附件根设置（撤销授权用；⛔ 不删任何文件）。
   * @param {(number|string)} uid - 用户 id
   * @returns {boolean} 删到行则为 true
   */
  clearSecretRoot(uid) {
    const before = (this.data.secrets_settings || []).length;
    this.data.secrets_settings = (this.data.secrets_settings || []).filter((v) => uidOf(v) !== Number(uid));
    this._saveJson();
    return this.data.secrets_settings.length < before;
  },

  /**
   * 功能：写入 / 覆盖该账号的附件根目录（一个账号一行）。
   *
   * 说明：⚠️ 先删后插（保持「一个账号只有一行」这条与 SQLite 主键同义的不变量）——
   *      JSON 后端没有主键约束，不这样做就会出现两行，而读的时候拿到哪一行是「先找到的那行」。
   * @param {(number|string)} uid - 用户 id
   * @param {string} root - 已校验过的绝对路径
   * @param {string} stamp - 时间戳
   * @returns {boolean} 恒为 true
   */
  setSecretRoot(uid, root, stamp, meta) {
    if (!Array.isArray(this.data.secrets_settings)) this.data.secrets_settings = [];
    const m = meta && typeof meta === 'object' ? meta : {};
    this.data.secrets_settings = this.data.secrets_settings.filter((v) => uidOf(v) !== Number(uid));
    this.data.secrets_settings.push({
      user_id: Number(uid),
      root: String(root),
      root_uid: m.root_uid == null ? null : Number(m.root_uid),
      root_username: m.root_username == null ? null : String(m.root_username),
      authorized_at: m.authorized_at == null ? null : String(m.authorized_at),
      updated_at: String(stamp || ''),
    });
    this._saveJson();
    return true;
  },
};

module.exports = { ops };
