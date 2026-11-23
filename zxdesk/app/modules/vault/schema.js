'use strict';
/**
 * modules/vault/schema.js —— **密码库模块**
 * 功能：声明密码库的**两张表** —— `vault_meta`（每个账号一行：KDF 参数 + 加密的 DEK + 验证块，
 * 同时充当「这个账号有没有初始化过密码库」的判据）与 `vault_items`（密码条目，
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'vault',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '密码库',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：⭐ 两条列设计上的硬约束 ——
   * ① `vault_meta.user_id` 是 **PRIMARY KEY**（不是普通列）：一个账号只能有一行，
   * 用 `CREATE TABLE IF NOT EXISTS` 补表时就带上了「唯一」这个语义，不需要额外索引；
   */
  tables: {
    /**
     * 功能：生成 `vault_meta` 表的建表语句 —— 一个账号一行的「开库材料」。
     *
     * 说明：各列都是**一次写入、之后只在改主密码时整体重写**，所以没有 `sort_order` 之类的可变列。
     * `kdf` 单列出来（而不是把算法名塞进 `kdf_params`）是为了让「将来换算法」这件事
     * 在 SQL 里就能看出来：查一下 `SELECT DISTINCT kdf` 就知道库里有没有老格式的库。
     */
    vault_meta: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        user_id         INTEGER PRIMARY KEY,   -- ⭐ 一个账号一行，同时是「是否已初始化」的判据
        kdf             TEXT    NOT NULL,      -- 'scrypt'（留字段以便将来换算法）
        kdf_params      TEXT    NOT NULL,      -- JSON: {"N":131072,"r":8,"p":1,"keylen":32}
        salt            TEXT    NOT NULL,      -- base64，16 B 随机
        dek_iv          TEXT    NOT NULL,      -- 12 B，base64（每次封装都重新生成）
        dek_cipher      TEXT    NOT NULL,      -- 被 KEK 加密的 DEK（32 B 明文进、密文出）
        dek_tag         TEXT    NOT NULL,      -- GCM tag（16 B）
        verifier_iv     TEXT    NOT NULL,
        verifier_cipher TEXT    NOT NULL,      -- 验证块：加密的固定明文 'zxdesk-vault-v1'
        verifier_tag    TEXT    NOT NULL,
        ---------- ⭐ 0.8.18 标签池（唯一一组**可空**的密文列，见文件头那段） ----------
        tags_iv         TEXT,                  -- 三个一起为 NULL = 还没建过标签池
        tags_cipher     TEXT,                  -- 加密后的 JSON：{"tags":["银行","公司 VPN"]}
        tags_tag        TEXT,
        created_at      TEXT,
        updated_at      TEXT
      );`,

    /**
     * 功能：生成 `vault_items` 表的建表语句 —— 一条密码一行，**全部内容在密文里**。
     *
     * 说明：⚠️ 这张表**刻意只有三个非元数据列**（`iv` / `cipher` / `tag`），而 `cipher` 里
     * 装的是 `JSON.stringify({title,username,password,url,note,tags})` 的密文。
     * 不给「标题明文列」是有意的取舍（方案）：数据库文件、备份文件落到别人手里时，
     */
    vault_items: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,   -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        iv         TEXT    NOT NULL,   -- 每条独立随机 12 B（⚠️ GCM 的 IV 绝不复用）
        cipher     TEXT    NOT NULL,   -- 加密后的 JSON：{title,username,password,url,note}
        tag        TEXT    NOT NULL,   -- GCM tag（16 B）
        sort_order INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );`,

    /**
     * 功能：生成 `vault_imported_keys` 表的建表语句 —— **别人（或过去的自己）的钥匙文件**导入后落在这里。
     *
     * **这一行里没有任何明文密钥**：全是「被主密码封装过的材料」（`dek_cipher` / `verifier_*`）
     * ＋ 派生参数（`kdf` / `kdf_params` / `salt`）—— 与 `vault_meta` 同一种东西。
     * 用的时候仍要现输那把锁的主密码，所以「入库」只省掉「每次重新选文件」，
     */
    vault_imported_keys: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kid             TEXT    NOT NULL,   -- 钥匙编号 = sha256('zxdesk-key-v1'+DEK) 前 16 hex（指纹，不是密钥）
        user_id         INTEGER NOT NULL,   -- ⭐ 谁导入的（方案里的 imported_by）；删账号随行清空
        owner_uid       INTEGER,            -- 原件所属的 ZXDesk 账号 id（可能已被删，故不加外键）
        owner_name      TEXT,               -- 原件账号名（只用于显示）
        kdf             TEXT    NOT NULL,   -- 'scrypt'
        kdf_params      TEXT    NOT NULL,   -- JSON：{"N":…,"r":…,"p":…,"keylen":…}
        salt            TEXT    NOT NULL,   -- base64，16 B
        dek_iv          TEXT    NOT NULL,   -- 被 KEK 封装的 DEK（三个一组）
        dek_cipher      TEXT    NOT NULL,
        dek_tag         TEXT    NOT NULL,
        verifier_iv     TEXT    NOT NULL,   -- 验证块（三个一组）
        verifier_cipher TEXT    NOT NULL,
        verifier_tag    TEXT    NOT NULL,
        created_at      TEXT,               -- 导入时间
        last_used_at    TEXT                -- 最近一次用它打开文件的时间
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
   * 说明：本模块是新增的，老库上根本没有这两张表，**不需要重建**；`createAll()` 会用
   * `CREATE TABLE IF NOT EXISTS` 把它们建出来。留空即「本模块没有需要重建的历史表」。
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
   * 说明：⚠️ 本模块的表是新建的（`CREATE TABLE IF NOT EXISTS` 一步到位），所以**从来不需要**
   * 新库走 DDL 一步到位，老库只能靠 `ensureColumns` 补出来（它是**老库唯一生效路径**）。
   * 次序是安全的：`_migrateSqlite()` 第 1 步 `createAll()` 建表、第 2 步才补列
   */
  ensureColumns: [
    ['vault_meta', 'tags_iv', 'TEXT'],
    ['vault_meta', 'tags_cipher', 'TEXT'],
    ['vault_meta', 'tags_tag', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这张表的模块自报。
   *
   * 说明：⚠️ `vault_meta` **一条都不登记**（`_update` 拿不到列 → 直接返回 false → 路由层 404）：
   * 它的每一列都是密码学材料，只许由 `modules/vault/store.js` 的专用方法整体重写，
   * 会变成一个提权通道。失败方向是安全的：改不动，而不是乱改。
   */
  allowedCols: {
    vault_items: ['sort_order', 'updated_at'],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：⚠️ 两张表都必须在这里：漏了 `vault_meta` 的表现是「删了账号，密码库的
   * salt/DEK 密文还躺在库里」；漏了 `vault_items` 则是「密码条目残留」。
   * 后者尤其严重 —— 那是本模块存在的全部意义（数据随账号一起走）。
   */
  userScoped: ['vault_meta', 'vault_items', 'vault_imported_keys'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   * `idx_vault_items_user`：列表按 `(user_id, sort_order, id)` 取，这是**唯一**一个
   * 会被用到的索引（1 期没有检索：标题在密文里，服务端压根没法按它筛）。
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_vault_items_user ON vault_items(user_id, sort_order, id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_imported_keys_owner ON vault_imported_keys(user_id, kid)',
  ],
};
