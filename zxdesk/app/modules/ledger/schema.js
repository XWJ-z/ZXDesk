'use strict';
/**
 * modules/ledger/schema.js —— **记账模块**
 * 功能：声明本模块**十三张表**（1 期 6 张 ＋ 2 期 6 张 ＋ 3 期 1 张），并给出它们的 DDL 生成器、
 * 列白名单、归属表清单与索引语句。
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md、
 */

/**
 *
 * 说明：本模块的表清单里有几张是**派生**出来的（`...IMPORT.tablesFor()` 等四处）：
 */
const IMPORT = require('./lib/import-sources.js');

module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'ledger',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '记账',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计取舍 ——
   * ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / calendar 同一条理由）：
   * 它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   */
  tables: {
    /**
     * 功能：生成 `ledger_accounts` 表的建表语句 —— 一个账户一行。
     *
     * 说明：⚠️ `created_at` / `updated_at` 只做审计，⛔ 不参与任何判定。
     * `sort_order` = **同 `kind` 组内** `COALESCE(MAX(sort_order), -1) + 1`（新建时业务层算）；
     * 起**可以手动拖动排序**（两端都能拖，手机端长按）——
     */
    ledger_accounts: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,          -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        kind        TEXT NOT NULL,             -- 九类之一（lib/kinds.js 是唯一出处）；存英文键
        name        TEXT NOT NULL,             -- ⭐ 允许重名（参考图里两行都叫「现金」）⇒ ⛔ 不加唯一约束
        tail        TEXT,                      -- **尾号四位**（可空；⛔ 不存全号，方案 §三 决策 18）
                                               --   ⭐ 批 4 起一列两用：储蓄卡 / 信用卡 是「卡号后四位」，
                                               --   信用支付 / 虚拟账户 是「手机号/账号后4位」（label 按类型变）
        note        TEXT,                      -- 可空
        opening_fen INTEGER NOT NULL DEFAULT 0,-- ⭐ 整数分（界面叫「余额」，语义是**初始基准**）
                                               --   ⚠️⭐ 2 期起**不再是「当前余额」**（决策 1 第 12 条）：
                                               --   当前余额 ＝ 它 ＋ 之后发生的变动，由 lib/balance.js 实时算
        sort_order  INTEGER NOT NULL DEFAULT 0,-- 组内顺序（⭐⭐ 批 4 起可拖动改，见 store 的重排方法）
        special     INTEGER NOT NULL DEFAULT 0,-- ⭐⭐ 2 期：0 普通账户 / 1 **空账户**（决策 6）
                                               --   ⚠️ 空账户是一行**真账户**：有稳定 id、可被流水指着，
                                               --   但它**不显示、不可删、不参与净值**。每个账号**恰好一行**
                                               --   （靠下面那条部分唯一索引守）。
                                               --   ⚠️⭐ 老库**必须**靠 ensureColumns 补这一列 ——
                                               --   CREATE TABLE IF NOT EXISTS 补不上已存在表的新列。
        tier        TEXT,                      -- ⭐ 批 4：银行卡分级 Ⅰ / Ⅱ / Ⅲ（可空；只给储蓄卡 / 信用卡用）
        limit_day_fen   INTEGER,               -- ⭐ 批 4：日限额（整数分；⚠️ **可空 = 没设**，⛔ 0 是「设成 0」）
        limit_month_fen INTEGER,               -- 月限额（同上）
        limit_year_fen  INTEGER,               -- 年限额（同上）
        created_at  INTEGER,                   -- 审计用，不参与判定
        updated_at  INTEGER                    -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `ledger_snapshots` 表的建表语句 —— 每账号每天一行。
     *
     * 写入时机是「账户的 建 / 改 / 删 **成功之后**」，同一天改几次都只留下**一行**、
     * 值是最新那一次 —— 少了这个唯一约束，一天就会攒出多行，
     * `net_fen` 与 `asset_fen - debt_fen` **必须同源**（同一次 `summarize()` 算出来）。
     */
    ledger_snapshots: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        date       TEXT NOT NULL,               -- YYYY-MM-DD，**字典序**比较（决策 11 / 84）
        asset_fen  INTEGER NOT NULL DEFAULT 0,  -- 那一刻的资产合计（整数分）
        debt_fen   INTEGER NOT NULL DEFAULT 0,  -- 那一刻的负债合计（整数分）
        net_fen    INTEGER NOT NULL DEFAULT 0,  -- 那一刻的净值 = 资产 − 负债（与上面两个同源）
        created_at INTEGER,                     -- 审计用，不参与判定
        UNIQUE(user_id, date)                   -- ⭐ 一天最多一行（upsert 的落点）
      );`,
    /**
     * 功能：生成 `ledger_views` 表的建表语句 —— 一套**分类（视图）**一行（界面叫「分类」）。
     *
     * 说明：⭐⭐ 分类是**第二个轴**（的口径）：账户的 `kind` 说的是
     * 「这是什么账户」（类型），而一张 `ledger_views` 说的是「按什么把它们分组看」（视图）。
     * ⇒ 两者**互不影响**：加一套分类不改任何账户、不改金额、不改净值。
     */
    ledger_views: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        name       TEXT NOT NULL,              -- 分类名（用户起，≤12 字；⛔ 不唯一）
        sort_order INTEGER NOT NULL DEFAULT 0, -- 顶部胶囊的先后（⭐ 含内置两颗，单一来源）
        builtin    INTEGER NOT NULL DEFAULT 0, -- 0=自建 / 1=按账户类型 / 2=按账户用途（>0 不可改名、不可删）
        created_at INTEGER,                    -- 审计用，不参与判定
        updated_at INTEGER                     -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `ledger_view_tags` 表的建表语句 —— 「某个账户在某套分类里算哪一类用途」一行。
     *
     * 说明：⭐⭐ `UNIQUE(user_id, view_id, account_id)` 是这张表的**命门**：一个账户在
     * **同一套分类里只能有一个用途**（举例：支付宝2 归「创业」就不能再归「日常」）——
     * 所以「改用途」是 upsert、不是追加。少了它，同一个账户会在两个组里各出现一次，
     */
    ledger_view_tags: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        view_id    INTEGER NOT NULL,           -- → ledger_views.id
        account_id INTEGER NOT NULL,           -- → ledger_accounts.id（账户删了，这行也删）
        tag        TEXT NOT NULL,              -- 内置用途视图存 gkey；自建分类存用途名（见上方说明）
        sort_order INTEGER NOT NULL DEFAULT 0, -- 账户在这套分类里的先后（拖出来的；0 = 没拖过）
        created_at INTEGER,                    -- 审计用，不参与判定
        updated_at INTEGER,                    -- 审计用，不参与判定
        UNIQUE(user_id, view_id, account_id)   -- ⭐ 一个账户在一套分类里只有一个用途（upsert 的落点）
      );`,

    /**
     * 功能：生成 `ledger_groups` 表的建表语句 —— 「**一组可排序的字段**」一行，用 `scope` 分两用。
     *
     * （每加一张表的机械登记点是 8 处，能省一半）：
     * `scope = 'kind'`（9 行）：**按账户类型**那套分组，`gkey` 就是 `lib/kinds.js` 的九类键。
     * `name` 冗余存一份中文名只为「表里看得懂」——**显示一律以代码为准**
     */
    ledger_groups: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        scope      TEXT NOT NULL,              -- 'kind'（按账户类型）/ 'usage'（按账户用途）
        gkey       TEXT NOT NULL,              -- ⭐ 稳定键（kind 用九类键；usage 用 u1..uN），发布后不许改
        name       TEXT NOT NULL,              -- 显示名；usage 可被用户改，kind 只作兜底（显示以代码为准）
        sort_order INTEGER NOT NULL DEFAULT 0, -- 这一套里字段的先后（拖排序的落点）
        locked     INTEGER NOT NULL DEFAULT 0, -- 1 = 不可删（全部 kind 行 ＋ usage 里的「其它」）
        created_at INTEGER,                    -- 审计用，不参与判定
        updated_at INTEGER,                    -- 审计用，不参与判定
        UNIQUE(user_id, scope, gkey)           -- ⭐ seed 的幂等落点（同一套里不许有两个同键字段）
      );`,

    /**
     * 功能：生成 `ledger_transfers` 表的建表语句 —— **账户之间的一次转账**一行。
     *
     * 说明：⭐⭐ 这张表让「钱怎么从 A 挪到 B」留下痕迹：
     * 一笔转账就是「一个账户减、另一个账户加」，钱的总量不变。
     * **方向由 `from_id` / `to_id` 表达，`amount_fen` 永远是非负数**
     */
    ledger_transfers: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        date       TEXT NOT NULL,               -- YYYY-MM-DD（服务端「今天」；字典序即时间序）
        from_id    INTEGER NOT NULL,            -- → ledger_accounts.id（转出）
        to_id      INTEGER NOT NULL,            -- → ledger_accounts.id（转入）
        amount_fen INTEGER NOT NULL,            -- 整数分、恒为非负；方向由 from/to 表达
        note       TEXT,                        -- 可空
        created_at INTEGER                      -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `ledger_entries` 表的建表语句 —— **一条流水**（2 期的核心表）。
     *
     * 说明：⭐⭐ 一笔记账至少有这七样：**日期 / 时间 / 收支 /
     * 类别 / 账户 / 金额 / 备注** —— 它们全都落在这张表上。
     * **⛔ 不存 `date` 列**：日期就是 `at` 的**前 10 个字符**，按月取数用**字典序区间**
     */
    ledger_entries: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        at          TEXT NOT NULL,             -- 'YYYY-MM-DD HH:MM:SS'（服务端本地时区；字典序 = 时间序）
        ie          TEXT NOT NULL,             -- '支出' / '收入'（只有这两个取值；⛔ 不加第三个）
        amount_fen  INTEGER NOT NULL,          -- 整数分；0 允许（决策 8 第 6 条）
        category_id INTEGER,                   -- → ledger_categories.id；NULL = 未分类（决策 7 第 10 条）
        account_id  INTEGER NOT NULL,          -- → ledger_accounts.id；没选账户 ⇒ 写空账户的 id（决策 6）
        refund_of   INTEGER,                   -- 自引用：这条是「退款」，退的是哪一笔（决策 8 第 9 条）
        note        TEXT,                      -- 可空（界面显示时没选分类显示「未分类」，⛔ 不拿它兜）
        created_at  INTEGER,                   -- 审计用，不参与判定
        updated_at  INTEGER                    -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `ledger_categories` 表的建表语句 —— **收支分类**（两级 ＋ 归档）。
     *
     * 说明：⭐⭐ **另建一张表，⛔ 不与 1 期的「账户视图」共用**：
     * `ledger_view_tags` 的主键语义是「**账户**在某套视图里算哪组」，**装不下
     * 「流水 × 分类」**；而且「看账户的一种方式」与「这笔钱算什么」不是同一件事。
     */
    ledger_categories: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        parent_id   INTEGER,                   -- NULL = 一级；非空 = 二级（指向本表）
        name        TEXT NOT NULL,             -- ⛔ 不加唯一约束（允许重名，与账户名同一条纪律）
        ie          TEXT,                      -- 只有一级填：'支出' / '收入'；二级 NULL（继承父）
        sort_order  INTEGER NOT NULL DEFAULT 0,-- 同级内的先后（种子按预置表的顺序填）
        archived_at INTEGER,                   -- 非空 = 已归档（行留着、选择器里不再出现）
        builtin     INTEGER NOT NULL DEFAULT 0,-- ⭐⭐ 1 = **内置**（用户不能删 / 不能改名 / 不能归档）、0 = 用户自建
                                               --   ⚠️ 判据是**这一列**，⛔ 不是名字 —— 用户也能建一个叫「餐饮」的，
                                               --   那一行是自定义（可删 / 可改名），靠名字认必然认错。
                                               --   ⚠️ 老库**必须**靠 ensureColumns 补这一列（CREATE TABLE IF NOT EXISTS
                                               --   补不上已存在表的新列），否则内置全被当成自建。
                                               --   ⛔ 别给通用 _update() 开白名单：builtin 不该被普通路径改。
        created_at  INTEGER,                   -- 审计用，不参与判定
        updated_at  INTEGER                    -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `ledger_default_accounts` 表的建表语句 —— **默认账户**（全局两层 ＋ 每类别一层）。
     *
     * 说明：⭐⭐ 一张表同时装两层：
     * **全局两层**：收入一个 / 支出一个（`kind` = `'income'` / `'expense'`）；
     * **每类别一层**：`kind = 'category'`，`category_id` 是那个类别。
     */
    ledger_default_accounts: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        kind        TEXT NOT NULL,             -- 'income' | 'expense' | 'category'
        category_id INTEGER NOT NULL DEFAULT 0,-- kind='category' 时是分类 id；全局两层写 0 哨兵
        account_id  INTEGER NOT NULL,          -- → ledger_accounts.id（可以指向空账户）
        created_at  INTEGER,                   -- 审计用，不参与判定
        updated_at  INTEGER,                   -- 审计用，不参与判定
        UNIQUE(user_id, kind, category_id)     -- ⭐ upsert 的落点（0 哨兵让全局两行也受约束）
      );`,

    /**
     * 功能：生成 `ledger_account_deletions` 表的建表语句 —— **删除记录**。
     *
     * 说明：⭐⭐ 这张表存在的**唯一理由**是 `name` 那一列：账户被**硬删**之后
     * （不走软删），转账 / 流水 / 手动调整记录都还指着那个**原 id**，
     * 界面要显示「这笔是从哪个账户转出的」就只能来这里取名字。
     */
    ledger_account_deletions: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        account_id INTEGER NOT NULL,           -- 被删掉的那个账户 id（原 id，AUTOINCREMENT 不复用）
        name       TEXT NOT NULL,              -- ⭐ 原名字 —— 这个表存在的唯一理由
        deleted_at INTEGER,                    -- 删除时刻（审计用，不参与判定）
        UNIQUE(user_id, account_id)            -- 同一个账户只该删一次
      );`,

    /**
     * 功能：生成 `ledger_adjustments` 表的建表语句 —— **手动调整余额的记录**（留痕那张表）。
     *
     * 说明：⭐⭐⭐ 形态依据：** 第 4 / 5 条**明写「手动调整余额 = 重新定基、
     * **必须留一条记录**（照参考图：从 X 调整为 Y）」，** 第 4 条**又写明三类变动
     * 「**手动调整余额**与**记账**各新建一张表」—— 但 1 期是**直接改 `opening_fen`**、
     */
    ledger_adjustments: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        account_id INTEGER NOT NULL,           -- → ledger_accounts.id（账户删了也保留原 id）
        at         TEXT NOT NULL,              -- 'YYYY-MM-DD HH:MM:SS'（次序精确到秒 —— 决策 1 第 3 条）
        from_fen   INTEGER NOT NULL,           -- 调整**前**的余额绝对值（留痕：显示「从 X 调整为 Y」）
        to_fen     INTEGER NOT NULL,           -- 调整**后**的余额绝对值 = 新的基准
        created_at INTEGER                     -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `ledger_meta` 表的建表语句 —— **记账库自己的系统键值表**。
     *
     * 说明：⭐⭐ 形态依据：** 第 5 条**要求「记账库里写一行**完成标记**」
     * （迁移工具靠它做三态幂等），但方案没给那张表的形态 ⇒ 由落地时补齐。
     * **它没有 `user_id`** ⇒ ⛔ **不进 `userScoped`、⛔ 不进个人备份**
     */
    ledger_meta: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at INTEGER
      );`,

    /**
     * 功能：生成 `ledger_budgets` 表的建表语句 —— **一张表装两层**：总预算 ＋ 分类预算。
     *
     * 说明：⭐⭐ 形态依据： 逐字，那一段是权威版本）。一行 = **一期 × 一个维度**
     * （`period_type` ＋ `period_key` ＋ `category_id`）的额度；「已用 / 剩余 / 剩余 % / 日均」
     * 全是**派生量**（`lib/budget.js` 实时算）⇒ ⛔ 一个都不建列、⛔ 不缓存。
     */
    ledger_budgets: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,           -- ⚠️ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        period_type TEXT    NOT NULL,           -- 'week' | 'month' | 'year'（三档，写死的枚举）
        period_key  TEXT    NOT NULL,           -- ⭐ 该期**起始日** 'YYYY-MM-DD'（周=周一 / 月=1 号 / 年=1 月 1 日）
        category_id INTEGER NOT NULL,           -- ⭐ 0 = **总预算**（哨兵，⛔ 不用 NULL）；> 0 = 收支分类 id
        amount_fen  INTEGER NOT NULL,           -- 额度（整数分；⚠️ 0 允许 = 明确设成 0，「没设」= 没有这一行）
        created_at  INTEGER,                    -- 审计用，不参与判定
        updated_at  INTEGER,                    -- 审计用，不参与判定
        UNIQUE(user_id, period_type, period_key, category_id)   -- ⭐ upsert 的落点（照 ledger_default_accounts 同款）
      );`,

    // ：导入来源那几张表**由注册表派生**——
    // 不在这里手写第二份 SQL（写两份必然漂移，而且两张表会悄悄长得不一样）。
    ...IMPORT.tablesFor(),
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的，没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：十二张表在新库里都是新表、在老库里也不曾被重建过，**不需要重建**；`createAll()` 会用
   * `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`，
   * 加表不升，先例一大把 —— 收藏夹 / 硬件 / 密码库 / 对话 / AI / 灵感库 / 番茄钟 / 日历）。
   */
  rebuildOrder: [],

  /**
   * 功能：重建搬数据时对「NULL 与默认值语义完全相同」的列做归一化；本模块不参与重建。
   * @type {Object}
   */
  normalize: {},

  /**
   * 功能：老库缺的列（幂等补列）—— 格式 `[表名, 列名, 类型]`。
   *
   * 表**早就存在**，而 `CREATE TABLE IF NOT EXISTS` 永远补不上新列 ⇒
   * 老库上 `builtin` 读出来是 undefined ⇒ 两颗内置胶囊被当成用户自建（能改名、能删）。
   * 只写进建表语句、漏登记，结果「七个设置项里只有称呼存不进去」）。
   */
  ensureColumns: [
    ['ledger_views', 'builtin', 'INTEGER NOT NULL DEFAULT 0'],
    // ：一套分类里**组内的先后**（报「支付宝拖不到第一个」后加的）。
    // 加列的登记点仍是**三处**：本处 ＋ 上方 DDL ＋ backup.js 的 COLS，缺一处不报错。
    // 这一列**必须**走 ensureColumns：ledger_view_tags 在老库里早就存在，
    ['ledger_view_tags', 'sort_order', 'INTEGER NOT NULL DEFAULT 0'],
    // ：储蓄卡 / 信用卡的分级与三个限额。⚠️⭐ 只加列的登记点是**三处**：
    // 本处（老库补列）＋ 上面的 DDL（新库建表）＋ `backup.js` 的 `COLS`（个人备份）。
    // 缺一处 = 一种装法下那列存不进去 / 备份丢了它，而且**都不报错**。
    ['ledger_accounts', 'tier', 'TEXT'],
    ['ledger_accounts', 'limit_day_fen', 'INTEGER'],
    ['ledger_accounts', 'limit_month_fen', 'INTEGER'],
    ['ledger_accounts', 'limit_year_fen', 'INTEGER'],
    // 2 期（记账）：`special`（`0` 普通 / `1` 空账户）。⚠️⭐ 这一条**必须有**：
    // `ledger_accounts` 在**每一个**已装过 1 期的库上都早就存在，
    // 而 `CREATE TABLE IF NOT EXISTS` 永远补不上它的新列 ⇒
    ['ledger_accounts', 'special', 'INTEGER NOT NULL DEFAULT 0'],
    // `ledger_categories.builtin`（`1` = 内置，不可删 / 不可改名 / 不可归档）。
    // 这一条**必须有**：真机上装过本模块早期包的那个库里 `ledger_categories` 早就存在，
    // 而 `CREATE TABLE IF NOT EXISTS` 永远补不上它的新列 ⇒ 老库上 `builtin` 读出来是
    ['ledger_categories', 'builtin', 'INTEGER NOT NULL DEFAULT 0'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**十三张表都刻意留空**。
   *
   * 说明：⚠️ 空数组不是漏写，是**安全属性**（同 `calendar_events` / `pomodoro_sessions`）：
   * 两张表的变化都走自己的专用原语（插入用 `insertLedgerAccount`、改账户走
   * `updateLedgerAccount`、快照走 `upsertLedgerSnapshot`）。放开通用更新会有两种坏结果：
   */
  allowedCols: {
    ledger_accounts: [],
    ledger_snapshots: [],
    ledger_views: [],
    ledger_view_tags: [],
    ledger_groups: [],
    ledger_transfers: [],
    // `ledger_entries`：身份是 `at` / `ie` / `amount_fen` / `account_id` ——
    // 放开通用更新等于让一次 PUT 就能把一笔账「过户」到别人的账户上；
    // `ledger_categories`：`parent_id` / `ie` 是**结构字段**（改它们 = 搬家 / 跨侧，
    ledger_entries: [],
    ledger_categories: [],
    ledger_default_accounts: [],
    ledger_account_deletions: [],
    ledger_adjustments: [],
    ledger_meta: [],
    // 3 期（预算）：同样**刻意留空** —— 额度是「一期 × 一个维度」的一行，写入语义是
    // **upsert**（`UNIQUE(user_id, period_type, period_key, category_id)`）；
    // 开放给通用 `_update()` 等于让请求体里任意一个键（含 `period_type` / `period_key`）
    ledger_budgets: [],
    // ：导入表**一律留空** —— 它们是**只读**的
    // （没有「改一行」这个业务：要撤走「整批清除」那条路），写入只走专用原语。
    // 开放通用 `_update()` 等于让请求体里任意一个键都有机会流到列上。
    ...IMPORT.blankColsFor(),
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：十二张（1 期六张 ＋ 2 期五张 ＋ 3 期一张）都是「这个人自己的东西」（他自己的账户、净值历史、
   * 分类视图、转账、流水、收支分类、默认账户、删除记录、手动调整），没有第二方 ⇒
   * 标准的「账号一走、数据全走」。⚠️ 与任务板同一口径：**管理员也看不到成员的账**。
   */
  userScoped: [
    'ledger_accounts',
    'ledger_snapshots',
    'ledger_views',
    'ledger_view_tags',
    'ledger_groups',
    'ledger_transfers',
    // 2 期（记账）：五张带 user_id 的新表 —— 漏一张 = 删账号留下那个人的账（且不报错）
    'ledger_entries',
    'ledger_categories',
    'ledger_default_accounts',
    'ledger_account_deletions',
    'ledger_adjustments',
    // 3 期（预算）：额度同样只属于账号本人 —— 漏登记 = 删账号之后那个人的预算还留在库里
    // （而界面上「这个人已经没了」，那些行**再也没人访问得到**，且不报错）
    'ledger_budgets',
    // ：导入表**必须进这一份** —— 删账号时它才会被清掉。
    // 少了这一行**不会报错**，但那个人的导入数据会**永远留在库里**（界面上「人已经没了」）。
    // 删账号会在主库执行 `DELETE FROM shayu` ⇒ 当场 no such table、删账号卡在中途。
    ...IMPORT.scopedFor(),
  ],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（为什么是这些）—— 后两条是「自定义分类（视图）」那批加的，2 期又加了六条
   * （记账条目三条 ＋ 分类 / 调整各一条 ＋ 空账户的部分唯一索引一条）。
   * `idx_ledger_accounts_user_sort`：按 `user_id` 过滤 + 组内按 `sort_order` 排序，
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_ledger_accounts_user_sort ON ledger_accounts(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_views_user_sort ON ledger_views(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_view_tags_user_account ON ledger_view_tags(user_id, account_id)',
    // 分组字段的取数永远是「这个账号的这一套，按自己的顺序」⇒
    // 这条索引的左两列正好管过滤（user_id + scope），右列就是那个排序键。
    'CREATE INDEX IF NOT EXISTS idx_ledger_groups_user_scope_sort ON ledger_groups(user_id, scope, sort_order)',
    // 转账明细的取数是「这个账号的全部转账里，与这个账户有关的那几条，
    // 按日期倒序」⇒ 这条索引的左列管过滤、右列正好就是那个排序键。
    // **刻意不给 `from_id` / `to_id` 各建一条**：查询里那两个是 `OR` 条件，而
    'CREATE INDEX IF NOT EXISTS idx_ledger_transfers_user_date ON ledger_transfers(user_id, date)',
    // 2 期（记账）新增六条。前三条是 ① 定死的：
    // `(user_id, at)`：按月取数 ＋ 游标分页的主力（区间是**字典序**的 `at`，见 DDL 说明）；
    // `(user_id, account_id, at)`：账户详情那三类混排（先按账户过滤，再按时刻倒序）；
    'CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_at ON ledger_entries(user_id, at)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_acct_at ON ledger_entries(user_id, account_id, at)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_refund ON ledger_entries(user_id, refund_of)',
    // 2 期：两级分类的取数永远是「这个账号的这一级、按自己的顺序」⇒ 三列正好
    // 管过滤（user_id ＋ parent_id）与排序（sort_order）。
    'CREATE INDEX IF NOT EXISTS idx_ledger_categories_user_parent ON ledger_categories(user_id, parent_id, sort_order)',
    // 2 期：余额派生要按「这个账户的全部调整、取 `at` 最新的那条」⇒ 左两列管过滤、
    // 右列就是那个取最大值的键。
    'CREATE INDEX IF NOT EXISTS idx_ledger_adjustments_user_acct_at ON ledger_adjustments(user_id, account_id, at)',
    // 2 期：**空账户的部分唯一索引** —— 保证**每个账号恰好一行** `special = 1`。
    // 这是**唯一**能表达「恰好一行」的地方：`special = 0` 的普通账户可以有任意多行，
    // 所以不能用普通 `UNIQUE(user_id, special)`（那会把一个人锁死成一个普通账户）。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_special ON ledger_accounts(user_id) WHERE special = 1',
    // ：导入表的索引同样由注册表派生
    // （`(user_id, at)` —— 明细按天分组与统计按月取数都吃它）。
    ...IMPORT.indexesFor(),
  ],
};
