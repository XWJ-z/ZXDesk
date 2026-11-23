'use strict';
/**
 * modules/assets/schema.js —— **个人资产管理模块**
 * 功能：声明「个人资产管理」这一屏的**两张表** ——
 * `asset_groups`：**一棵树**（`parent_id` 分层）—— 第一层 = 子模块（生活记账 / 数码管理 /
 * @author zx
 * @date   2026-10-02
 * @since 0.9.7
 * 相关：docs/公共/架构文档/26-个人资产管理.md、docs/公共/开发方案/30-个人资产管理.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'assets',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '个人资产管理',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：两张表的两条设计取舍 ——
   * ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / bookmarks / hardware 同一条理由）：
   * 它是「归属标签」不是结构父节点，而老库完全可能 user_id=1 却还没有 users 行
   */
  tables: {
    /**
     * 功能：生成 `asset_groups` 表的建表语句 —— 一块分组（子模块 / 分类）。
     * @param {string} n - 表名
     * @param {boolean} ine - 是否加 `IF NOT EXISTS`
     * @returns {string} `CREATE TABLE` 语句
     */
    asset_groups: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,     -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        parent_id   INTEGER,              -- NULL = 第一层（子模块）；非空 = 挂在某个子模块下的分类
        name        TEXT    NOT NULL,     -- 叫得出名字，必填
        kind        TEXT DEFAULT 'group' CHECK (kind IS NULL OR kind IN ('module','group')),
        module_key  TEXT,                 -- 非空 = 这一格**有实现**（值 = 模块名，如 ledger / digital）
 -- ⭐⭐ 0.8.23（「预制的 NAS硬件管理、电子产品管理 不可以删除」）：
        --   1 = **系统预置**的格子（由有实现的模块自己播种），界面不给删、removeAssetGroup() 也拒绝。
        --   ⚠️ 判据是**这一列**，⛔ 不是名字 —— 用户能给它改名（见 digital/store.js 的
        --   _ensureDigitalSections()），靠名字认必然认错（与 ledger_groups.builtin 同一条纪律）。
        --   ⚠️ 老库**必须**靠 ensureColumns 补这一列：CREATE TABLE IF NOT EXISTS 补不上已存在表的
        --   新列，补不上的表现是「预制的格也删得掉」。
        --   ⛔ 别给通用 _update() 开白名单：它只由代码层（播种 / 补标记）写。
        builtin     INTEGER NOT NULL DEFAULT 0,
        icon        TEXT,                 -- 自由文本（一个 emoji 或一个字的缩写）
        sort_order  INTEGER DEFAULT 0,
        created_at  TEXT,
        updated_at  TEXT
      );`,

    /**
     * 功能：生成 `asset_items` 表的建表语句 —— 一条通用条目（用户自建的分组里装的东西）。
     * @param {string} n - 表名
     * @param {boolean} ine - 是否加 `IF NOT EXISTS`
     * @returns {string} `CREATE TABLE` 语句
     */
    asset_items: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        group_id    INTEGER,              -- 指向 asset_groups 的行；⚠️ 无外键（删分组只解绑）
        name        TEXT    NOT NULL,     -- 叫得出名字，必填
        amount_fen  INTEGER,              -- ⭐ 金额存**分**、整数（前端不算钱）
        date        TEXT,                 -- YYYY-MM-DD，自由填写（不做合理性校验）
        note        TEXT,                 -- 自由文本
        created_at  TEXT,
        updated_at  TEXT
      );`,
  },

  /**
   *
   * 说明：留空是**契约的一部分，不是漏写**。
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP ＋ 搬数据 ＋ RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这两张表，**不需要重建**；`createAll()` 会用
   * `CREATE TABLE IF NOT EXISTS` 把它们建出来。
   *
   */
  rebuildOrder: [],

  /**
   * 功能：重建搬数据时的 NULL ↔ 默认值归一化规则；本模块不参与重建，故为空。
   * @type {Object}
   */
  normalize: {},

  /**
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   *
   * `CREATE TABLE IF NOT EXISTS` 永远补不上它（与 ledger 那边 `ledger_views.builtin`
   * 是同一件事、同一条理由：补不上 ⇒ 预制的格子被当成用户自建，能改名、能删）。
   * 补列跑在 `createAll()` **之后**（`_migrateSqlite()` 的第 1 步建表、第 2 步补列）
   */
  ensureColumns: [['asset_groups', 'builtin', 'INTEGER NOT NULL DEFAULT 0']],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这张表的模块自报。
   *
   * 说明：⚠️ 三个**必须排除**的列（与 tasks / bookmarks / hardware 完全一致的理由）：
   * `parent_id` **刻意不在 `asset_groups` 的白名单里**（1 期不做「把分组挪到别处」）：
   * 放开它就要处理「挪到自己子孙下面」形成的环 —— 那是一条静默的数据事故，
   */
  allowedCols: {
    asset_groups: ['name', 'kind', 'icon', 'sort_order', 'updated_at'],
    asset_items: ['group_id', 'name', 'amount_fen', 'date', 'note', 'updated_at'],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   * @type {Array.<string>}
   */
  userScoped: ['asset_groups', 'asset_items'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（两条的理由）——
   * `idx_asset_groups_user_parent`：画药丸与分类树时按「父项」分组取子项，是唯一**必定**用到的；
   * `idx_asset_items_user_group`：按分组列条目、以及删分组时的解绑。
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_asset_groups_user_parent ON asset_groups(user_id, parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_asset_items_user_group   ON asset_items(user_id, group_id)',
  ],
};
