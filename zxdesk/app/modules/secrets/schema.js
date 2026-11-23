'use strict';
/**
 * modules/secrets/schema.js —— **加密信息**
 * 功能：声明本模块**唯一一张表** `secrets_items`（一条记录一行，全部内容在密文里），
 * 并给出它的 DDL 生成器、列白名单、级联清空清单与索引语句。
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/42-加密信息.md、28-实验室.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'secrets',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '加密信息',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 `createAll()` / `createAllIn()` 一次建出全部表。
   *
   * 说明：⭐ 列设计上的三条硬约束 ——
   * ① 密文三列 `iv / cipher / tag` **都是 `NOT NULL`**：半行记录（有 iv 没 cipher）
   * 不是一个可恢复的状态，与其让它存在于库里、等到解密时报一句「已损坏」，
   */
  tables: {
    /**
     * 功能：生成 `secrets_items` 表的建表语句 —— 一条加密信息一行，**全部内容在密文里**。
     *
     * 说明：⚠️ `cipher` 里装的是 `JSON.stringify({title, body})` 的密文（用密码库的 DEK、
     * 每条独立随机 IV）。列名与 `vault_items` **逐字一致**，是为了让「两条密文大道」
     * 在代码里长得一样（读的人不必再记第二套词汇）。
     */
    secrets_items: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,   -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        iv           TEXT    NOT NULL,   -- 【老形状】{title,body} 一整块的 IV（新行留空串）
        cipher       TEXT    NOT NULL,   -- 【老形状】整块密文
        tag          TEXT    NOT NULL,   -- 【老形状】GCM tag
        title_iv     TEXT,               -- ⭐ 标题单独一组（列表只解这一组）
        title_cipher TEXT,
        title_tag    TEXT,
        body_iv      TEXT,               -- ⭐ 正文单独一组（点开才解）
        body_cipher  TEXT,
        body_tag     TEXT,
        created_at   TEXT,
        updated_at   TEXT
      );`,

    /**
     * 功能：生成 `secrets_files` 表的建表语句 —— **一条附件一行**，文件本体不在这里（它是磁盘上的密文文件）。
     *
     * `meta_*` 三列是 `{name, mime}` 的密文 —— **文件名本身也是秘密**
     * （「离婚协议.pdf」比正文更扎眼）；
     * `size` 是**明文**字节数，必须明文：`Content-Length` 与 Range 计算都在解密**之前**。
     */
    secrets_files: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,   -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        item_id     INTEGER NOT NULL,   -- 挂在哪条加密信息上（删条目时级联删这些行 ＋ 文件）
        meta_iv     TEXT    NOT NULL,   -- {name,mime} 的密文（文件名不落明文）
        meta_cipher TEXT    NOT NULL,
        meta_tag    TEXT    NOT NULL,
        size        INTEGER NOT NULL,   -- 明文字节数（Range / Content-Length 在解密前就要用）
        root        TEXT    NOT NULL,   -- 落盘时的根（改设置不影响这一行）
        rel         TEXT    NOT NULL,   -- 根下相对路径：<uid>/<两位分片>/<id>.zxdesk
        sha256      TEXT    NOT NULL DEFAULT '',  -- 整文件 SHA-256（防伪关联用；升级前的行为空）
        created_at  TEXT
      );`,

    /**
     * 功能：生成 `secrets_settings` 表的建表语句 —— **每账号一行**：自选的附件根目录。
     *
     * 没有行 ⇒ 用默认根（由 `module.json` 的 `database` 派生，见 `store.filesRoot()`）。
     * `user_id` 是主键（一个账号只能有一行），与 `vault_meta` 同款 —— 不需要额外索引。
     * 这张表**也不放明文路径以外的任何东西**：路径本身是用户的配置，不是秘密；
     */
    secrets_settings: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        user_id       INTEGER PRIMARY KEY,  -- 一个账号一行
        root          TEXT    NOT NULL,     -- 绝对路径（已由当前飞牛用户授权）
        root_uid      INTEGER,              -- ⭐ 授权人：飞牛用户 uid（只从网关 Header 来）
        root_username TEXT,                 -- 授权人的飞牛用户名（给人看的）
        authorized_at TEXT,                 -- 授权生效的时间
        updated_at    TEXT
      );`,
  },

  /**
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新表，老库上根本没有它，**不需要重建**；`createAllIn()` 会用
   * `CREATE TABLE IF NOT EXISTS` 把它建出来。
   *
   */
  rebuildOrder: [],

  /**
   * 功能：重建搬数据时对「NULL 与默认值语义完全相同」的列做归一化。
   *
   * 说明：本模块不参与重建（见 `rebuildOrder`），所以没有归一化规则。
   *
   * @type {Object}
   */
  normalize: {},

  /**
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   *
   * 开发期出过的包已经建了不带 `sha256` 的表，`CREATE TABLE IF NOT EXISTS` 不会补列，
   * 所以要把「整文件 SHA-256」这一列登记成幂等补列（老行补出来是 NULL，代码里当空串 ⇒
   * 那几行的附件在重新关联时判 `damaged`，提示重新上传 —— 开发期不写兼容分支）。
   */
  ensureColumns: [
    ['secrets_files', 'sha256', 'TEXT'],
    // 标题 / 正文拆成两组密文：列表只解标题、正文点开才解（老行这六列是 NULL ⇒ 兼容读）
    ['secrets_items', 'title_iv', 'TEXT'],
    ['secrets_items', 'title_cipher', 'TEXT'],
    ['secrets_items', 'title_tag', 'TEXT'],
    ['secrets_items', 'body_iv', 'TEXT'],
    ['secrets_items', 'body_cipher', 'TEXT'],
    ['secrets_items', 'body_tag', 'TEXT'],
    // 附件目录改成「用户授权」之后，设置行要记「谁授权的、什么时候」
    ['secrets_settings', 'root_uid', 'INTEGER'],
    ['secrets_settings', 'root_username', 'TEXT'],
    ['secrets_settings', 'authorized_at', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**一条都不登记**。
   *
   * 说明：⚠️ 这是刻意的、也是安全属性：`secrets_items` 的每一列要么是归属（`user_id`）、
   * 要么是**密文三列的一个整体**（单独改其中一个会把那条记录当场毁掉）。
   * 写入只走 `modules/secrets/store.js` 的专用方法（整条重新加密后成组改写），
   */
  allowedCols: {},

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：⚠️ 漏了它的表现是「删了账号，加密信息的密文还躺在实验室库里」——
   * 它在**实验室库**那一段被清（`SCHEMA.userScopedTablesIn('lab')`），
   * 与记账库 / 主库两段同一条次序（实验室 → 记账 → 主库，账号行最后删）。
   */
  userScoped: ['secrets_items', 'secrets_files', 'secrets_settings'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明：⭐ 只有一条，且**按列表的真实读取形状**建：`WHERE user_id=? ORDER BY updated_at DESC`
   * ⇒ `(user_id, updated_at DESC)` 让它走索引直接拿到有序结果，不必再排一次。
   * 为什么按 `updated_at` 而不是 `id`：界面上「最近改过的在最上面」比「最后建的在上」
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_secrets_items_user ON secrets_items(user_id, updated_at DESC)',
    // 附件：列表按「某条加密信息下的附件」取（`WHERE user_id=? AND item_id=?`），
    // 删条目时也按它找要删的文件行。
    'CREATE INDEX IF NOT EXISTS idx_secrets_files_item ON secrets_files(user_id, item_id)',
  ],
};
