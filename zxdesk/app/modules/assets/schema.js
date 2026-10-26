'use strict';
/**
 * modules/assets/schema.js —— **个人资产管理模块**（0.8.10）
 *
 * 功能：声明「个人资产管理」这一屏的**两张表** ——
 *      · `asset_groups`：**一棵树**（`parent_id` 分层）—— 第一层 = 子模块（生活记账 / 数码管理 /
 *        用户自建的「房产管理」…），第二层及以下 = 分类（电脑 / 手机 / 相机…）；
 *        `module_key` 非空表示这一格**有实现**（值 = 模块名，如 `ledger` / `digital`），
 *        空 = 用户自建的空壳分组（里面只装 `asset_items` 的通用条目）。
 *      · `asset_items`：**通用条目**（名称 / 金额 / 日期 / 备注）—— 用户自建的分组靠它装东西。
 *
 * ⭐⭐ **本模块是整件事的枢纽，而它自己只做「宿主」**：
 *     `archive_groups` 里的行是**数据**（用户能新建 / 改名 / 删除），
 *     `ledger` / `digital` 是**代码模块**（表 / 接口 / 目录一个不动）。
 *     ⇒ 「可新建子模块」＝**往树里插一行**，⛔ **绝不**是「运行期造一个模块」
 *     （运行期的「动态」一律落成「静态登记 ＋ 数据驱动」）。
 *     ⚠️ 因此本模块**不许** import / require 任何别的模块的实现（铁律 11）：
 *     有实现的那两格由前端走 `core/slots.js` 的 `mountModuleSlot()` 借位挂载。
 *
 * ⭐ **一张表装两层**（照 的先例）：⛔ 不拆成 `asset_modules` ＋
 *     `asset_categories` 两张表 —— 它们的分层判据是同一条（`parent_id`），拆开就会出现
 *     「同一件事有两张表、两套 CRUD、两边顺序还得对齐」。
 *     ⚠️ `kind` 只是**界面**用的区分（画成「子模块」还是「分类」），
 *     **判据仍以 `parent_id` 为准**，⛔ 别让两个字段各说一套。
 *
 * ⚠️⭐ **存量 vs 流量**：`asset_items` 记的是**存量**
 *     （「这套房 300 万」「这台 NAS 花了 3200」），记账记的是**流量**（收支流水 / 账户余额 / 预算）。
 *     **两者互不并入统计** —— `asset_items` 的金额**不进**记账的净值 / 预算 / 图表。
 *     ⛔ 这不是缺陷，是定死的口径；界面上必须写明这件事。
 *
 * ⚠️ **刻意不推进 `SCHEMA_VERSION`**（仍是 v5，与 0.3.0 收藏夹 / 0.3.1 硬件台账同一手法）：
 *     两张表由 `createAll()` 的 `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来，
 *     升版本号只会触发一次**整库重建**（DROP ＋ 搬数据 ＋ RENAME），代价与风险都白担。
 *
 * ⚠️ **日期列全是 `TEXT`（`YYYY-MM-DD`）**：字典序即时间序，比较不用转 `Date`（本项目既有的时区坑）。
 *     ⚠️ **不做「合理性」校验** —— `1900-01-01` 照样收下（只保证「真实存在」，不猜「合不合理」）。
 *
 * ⚠️ **金额存分、整数**（`amount_fen`）—— 照记账的既有口径，**前端不算钱**。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.23
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
   *      ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / bookmarks / hardware 同一条理由）：
   *         它是「归属标签」不是结构父节点，而老库完全可能 user_id=1 却还没有 users 行
   *         （内置 admin 在 Store 构造**之后**才创建），加外键会把「首次启动」判死；
   *         给 DEFAULT 则会让「忘了传 user_id」从报错变成静默归到 1 号账号名下。
   *      ② ⚠️ `group_id` / `parent_id` **刻意不加外键**：
   *         删分组时 `asset_items` 走**解绑、不级联删**（附录 C-8：台账是已发生的事实，
   *         与行程那条「删行程只解绑」同一个先例）；悬空由界面说一句，不靠数据库报错。
   *         ⚠️ 与任务板刻意相反 —— 删项目会连任务一起删（那边任务属于项目），
   *         这边的条目**不属于**分组（分组只是一层归类）。
   *
   * @param {string} n - 表名（重建时是临时名）
   * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
   * @returns {string} 该表的 `CREATE TABLE` 语句
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
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.8.10 新增），没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写**。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP ＋ 搬数据 ＋ RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这两张表，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来。
   *
   * @type {Array.<string>}
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
   * 说明：⭐⭐ 0.8.23 起**不再留空** —— `asset_groups.builtin` 是给**已经存在**的表新加的列，
   *      `CREATE TABLE IF NOT EXISTS` 永远补不上它（与 ledger 那边 `ledger_views.builtin`
   *      是同一件事、同一条理由：补不上 ⇒ 预制的格子被当成用户自建，能改名、能删）。
   *      ⚠️ 补列跑在 `createAll()` **之后**（`_migrateSqlite()` 的第 1 步建表、第 2 步补列）
   *      ⇒ 这里列出的表此刻一定已经存在，`ALTER TABLE` 不会报错。
   *      ⚠️ 反过来说：**本批次新增的表**照样⛔ 不许写进这里（那条纪律没变）——
   *      只是 `asset_groups` 不属于那一类，它 0.8.10 就建出来了。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [['asset_groups', 'builtin', 'INTEGER NOT NULL DEFAULT 0']],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这张表的模块自报。
   *
   * 说明：⚠️ 三个**必须排除**的列（与 tasks / bookmarks / hardware 完全一致的理由）：
   *      `id`（不许改主键）、`user_id`（不许「过户」给别人）、`created_at`（创建时间只写一次）。
   *      ⚠️ `parent_id` **刻意不在 `asset_groups` 的白名单里**（1 期不做「把分组挪到别处」）：
   *      放开它就要处理「挪到自己子孙下面」形成的环 —— 那是一条静默的数据事故，
   *      而 1 期没有这个需求。将来要做，走单独的改动（带环检测）。
   *      ⚠️ `module_key` **不在白名单里**：它是「这一格对应哪个代码模块」的登记，
   *      ⛔ 不许由界面写（那等于「运行期造模块」， 明令禁止）。
   *      ⚠️ 白名单是**逐列列举**的：漏一列的表现是「那个字段怎么都保存不上」，
   *      失败方向是安全的（改不动，不是乱改）。
   *
   * @type {Object}
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
   *      · `idx_asset_groups_user_parent`：画药丸与分类树时按「父项」分组取子项，是唯一**必定**用到的；
   *      · `idx_asset_items_user_group`：按分组列条目、以及删分组时的解绑。
   *      ⚠️ 两条都以 `user_id` 打头 —— 本应用的所有查询都带账号，索引不带它等于白建。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_asset_groups_user_parent ON asset_groups(user_id, parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_asset_items_user_group   ON asset_items(user_id, group_id)',
  ],
};
