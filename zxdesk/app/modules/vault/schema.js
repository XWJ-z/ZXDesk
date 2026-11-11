'use strict';
/**
 * modules/vault/schema.js —— **密码库模块**（0.3.2）
 *
 * 功能：声明密码库的**两张表** —— `vault_meta`（每个账号一行：KDF 参数 + 加密的 DEK + 验证块，
 *      同时充当「这个账号有没有初始化过密码库」的判据）与 `vault_items`（密码条目，
 *      全部内容都在密文里），并给出它们的 DDL 生成器、列白名单、级联清空清单与索引语句。
 *
 * ⭐ **本模块最容易误解的一点：库里没有一条明文。**
 *    `vault_items` **没有 `title` 列**、没有 `username` 列、没有 `url` 列 —— 连标题都是密文的一部分
 *    （方案）。所以「列表页」是在**已解锁**状态下把行取回来、在内存里解密后画出来的；
 *    未解锁时前端拿不到任何条目信息（接口直接 403，连条目数量都不给）。
 *    这样做的代价是「服务端无法按标题排序/检索」，收益是**库文件泄露不暴露任何条目名**。
 *
 * ⭐ **标签（0.4.4 起）同样睡在密文里** —— 密文载荷是
 *    `{title,username,password,url,note,tags:[…]}`，所以「给密码分类」**没有加表、没有加列、
 *    没有加索引**：分类名（「银行」「公司 VPN」）不会明文落库、不会进备份，
 *    老条目解出来没有 `tags` 键 → 天然空数组，**零迁移**。
 *    ⚠️ 代价是**服务端筛不了标签**（它看不见），筛选与搜索都在解锁后的前端内存里做。
 *    ⛔ **绝不要为了「服务端筛选方便」加一张 `vault_tags` 表或一个明文标签列** ——
 *    那会把本模块最核心的承诺（连标题都不明文）悄悄拆掉，而且界面上完全看不出来。
 *    对照：收藏夹的分类是**明文表**（`14-网址收藏夹.md`），因为它的数据本来就是明文；
 *    两个模块在这件事上刻意不同，不是谁没跟上谁。
 *
 * ⭐ **0.8.18 追加：`vault_meta` 上那三个 `tags_iv/cipher/tag`（「标签池」）—— 它不是上面那条禁令的例外。**
 *    背景：随手记 / 收藏夹的「⚙ 管理」弹层底部都能**先建一个空标签**（它们有明文标签表），
 *    而密码库的标签只住在各条记录的密文里 ⇒ 「建了却还没有记录用到」这件事**先前无处可存**，
 *    于是那一行只能给一句「新增记录时把标签写进去」的说明（截图批注要它对齐）。
 *    做法：把「建过的标签名」整体当成**一份密文**（`{"tags":[…]}`）存在 `vault_meta` 上，
 *    用**同一把 DEK** 加解密 ⇒ 库文件泄露时这份清单和条目一样是密文，**承诺一个字没变**。
 *    ⚠️ 所以它**不是** `vault_tags` 明文表：没有明文列、服务端依旧看不见任何标签名
 *    （读的那一步必须**已解锁**、要 DEK，与 `listVaultEntries` 同一个门槛）。
 *    ⚠️ 为什么搭在 `vault_meta` 上而不是新开一张表：它是**每账号一行**的密码库元数据，
 *    而且已经被 `schema.test.js` **整表豁免**、已经在个人备份里 ⇒ 不用再走「加一张表」
 *    那一整套登记（module.json / 两个后端的表清单 / 备份的 `PERSONAL_SOURCES` 下标位移）。
 *    ⚠️ 三列**可空**是刻意的：**NULL = 还没建过标签池**（绝大多数账号如此），
 *    与上面「半行 meta 不可恢复」那条约束不冲突 —— 池没了只是少几个名字，条目一条不丢。
 *
 * ⭐ **为什么要两张表而不是一张**：`vault_meta` 一个账号**只有一行**（`user_id` 就是主键），
 *    它存的是「解开这个库所需要的东西」；`vault_items` 是随时增删的条目。
 *    合成一张表会让「有没有初始化」变成「表里有没有行」这种会被误删的判据。
 *
 * ⚠️ **刻意不推进 `SCHEMA_VERSION`**（方案）：这两张表由 `createAll()` 的
 *    `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来，升版本号只会触发一次**整库重建**
 *    （DROP + 搬数据 + RENAME），代价与风险都白担。与 0.2.3 加 `timetable_adjustments`、
 *    0.3.0 加收藏夹三张表、0.3.1 加硬件台账是同一手法。
 *
 * ⚠️ 模块契约见 index.js 的说明，由 `assertModules()` 在加载时自检。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/schema/vault.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 表结构从此归这个目录所有。
 *    ⚠️ **安全结论一个字都没改**：只换了文件头路径与这段搬迁说明。
 *
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
   *      ① `vault_meta.user_id` 是 **PRIMARY KEY**（不是普通列）：一个账号只能有一行，
   *         用 `CREATE TABLE IF NOT EXISTS` 补表时就带上了「唯一」这个语义，不需要额外索引；
   *      ② 所有密文列都是 `NOT NULL` —— 半行 meta（有 salt 没 DEK）**不是一个可恢复的状态**，
   *         与其让它存在于库里、等到解锁时报一句「主密码不正确」，不如在写入那一刻就被约束拦住。
   *      ⚠️ `vault_items.user_id` 与 tasks / bookmarks / hardware 同一条规矩：**不加外键、不给 DEFAULT**
   *         （它是「归属标签」不是结构父节点，而老库完全可能 user_id=1 却还没有 users 行；
   *         给 DEFAULT 则会让「忘了传 user_id」从报错变成静默归到 1 号账号名下）。
   *
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `vault_meta` 表的建表语句 —— 一个账号一行的「开库材料」。
     *
     * 说明：各列都是**一次写入、之后只在改主密码时整体重写**，所以没有 `sort_order` 之类的可变列。
     *      `kdf` 单列出来（而不是把算法名塞进 `kdf_params`）是为了让「将来换算法」这件事
     *      在 SQL 里就能看出来：查一下 `SELECT DISTINCT kdf` 就知道库里有没有老格式的库。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      装的是 `JSON.stringify({title,username,password,url,note,tags})` 的密文。
     *      不给「标题明文列」是有意的取舍（方案）：数据库文件、备份文件落到别人手里时，
     *      连「你有哪些网站的账号」都不暴露。**不要为了「服务端排序 / 检索方便」加明文列** ——
     *      那会把本模块最核心的承诺悄悄拆掉，而且界面上完全看不出来。
     *      ⚠️ `tags` 是 `string[]`（0.4.4 起）—— 它**不是**一个新的列，只是密文 JSON 里多了一个键，
     *      所以本表的 DDL、索引、`allowedCols`、两个后端的原语**一个字都没动**。
     *      ⚠️ 密文是用户可以手工改的，所以读出方向一律经 `modules/vault/store.js` 的 `normTags()` 兜底
     *      （`tags` 可能是字符串、数字数组、或压根没有这一键）——别在别处直接 `.map()` 它。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     * 说明：⭐⭐ 0.9.8 第 6 轮（方案 2026-11-08-0.9.8-第6轮修改 §八~§九）：钥匙文件（`.zxkey`）
     *      的作用是「换机器 / 账号已删也打得开」，按老大拍板**导入后存进数据库**。
     *      ⚠️ **这一行里没有任何明文密钥**：全是「被主密码封装过的材料」（`dek_cipher` / `verifier_*`）
     *      ＋ 派生参数（`kdf` / `kdf_params` / `salt`）—— 与 `vault_meta` 同一种东西。
     *      用的时候仍要现输那把锁的主密码，所以「入库」只省掉「每次重新选文件」，
     *      门槛一点没降（方案 §8.5）。
     *      ⚠️ **列名是 `user_id`、语义是「谁导入的」**（方案里写的 `imported_by`）：这样它能自动进
     *      `userScoped` —— 删账号时由存储层的通用清空一并带走，⛔ 不需要在 `deleteUser()` 里
     *      再开一个特例（那种特例迟早会漏）。语义差别只体现在注释与业务方法名上。
     *      ⚠️ `owner_uid` 是**原件所属账号**，可能是本机早就删掉的账号 id —— 所以它**不是**外键，
     *      也不参与任何归属判断（归属永远看 `user_id`）。
     *      ⚠️ 这张表**不参与** `_vaultDek()` / `vaultIsUnlocked()`：它是「可以拿去试的钥匙」，
     *      不是「本账号已经解锁」。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.3.2 新增），没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这两张表，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来。留空即「本模块没有需要重建的历史表」。
   *
   * @type {Array.<string>}
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
   *      往这里写 —— 唯一的例外是 0.8.18 那三列：`vault_meta` 在**老库上早就存在**，
   *      新库走 DDL 一步到位，老库只能靠 `ensureColumns` 补出来（它是**老库唯一生效路径**）。
   *      ✅ 次序是安全的：`_migrateSqlite()` 第 1 步 `createAll()` 建表、第 2 步才补列
   *      （见 `core/store/backend/sqlite.js`），所以「表还没建就 ALTER」不会发生。
   *      ⚠️ 三列**都是 `TEXT` 且可空**（DDL 里也刻意不加 `NOT NULL`）：NULL 就是
   *      「这个账号还没建过标签池」这个正常状态，与别的密文列「半行 meta 不可恢复」不同。
   *
   * @type {Array.<Array.<string>>}
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
   *      它的每一列都是密码学材料，只许由 `modules/vault/store.js` 的专用方法整体重写，
   *      绝不能从请求体通用地写进去 —— 否则「随便 PUT 一下就把 dek_cipher 改成我自己知道的值」
   *      会变成一个提权通道。失败方向是安全的：改不动，而不是乱改。
   *      `vault_items` 只登记 `sort_order` / `updated_at`：密文三列（`iv` / `cipher` / `tag`）
   *      **刻意排除**，它们只能由 `updateVaultItem` 这个专用原语成组改写
   *      （单独改一个 `iv` 而不同时换 `cipher` 会直接把那条记录毁掉）。
   *
   * @type {Object}
   */
  allowedCols: {
    vault_items: ['sort_order', 'updated_at'],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：⚠️ 两张表都必须在这里：漏了 `vault_meta` 的表现是「删了账号，密码库的
   *      salt/DEK 密文还躺在库里」；漏了 `vault_items` 则是「密码条目残留」。
   *      后者尤其严重 —— 那是本模块存在的全部意义（数据随账号一起走）。
   *
   * @type {Array.<string>}
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
   *      · `idx_vault_items_user`：列表按 `(user_id, sort_order, id)` 取，这是**唯一**一个
   *        会被用到的索引（1 期没有检索：标题在密文里，服务端压根没法按它筛）。
   *      ⚠️ `vault_meta` 不需要索引 —— `user_id` 本身就是主键，SQLite 自带唯一索引。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_vault_items_user ON vault_items(user_id, sort_order, id)',
    // ⭐ 0.9.8 第 6 轮：同一把钥匙（同一个导入人）只能有一行 —— 重复导入是幂等的
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_imported_keys_owner ON vault_imported_keys(user_id, kid)',
  ],
};
