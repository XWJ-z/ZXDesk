'use strict';
/**
 * modules/ledger/schema.js —— **记账模块**（0.8.0）
 *
 * 功能：声明本模块**十三张表**（1 期 6 张 ＋ 2 期 6 张 ＋ 3 期 1 张），并给出它们的 DDL 生成器、
 *      列白名单、归属表清单与索引语句。
 *
 *      1 期（`0.8.0`）—— 资产管家：`ledger_accounts`（一个账户一行：类型 + 名称 + 尾号 +
 *      备注 + 余额）、`ledger_snapshots`（每账号每天一行：那一刻的资产 / 负债 / 净值）、
 *      `ledger_transfers`（账户之间的一次转账）、`ledger_views` / `ledger_view_tags`
 *      （分类与用途归属）、`ledger_groups`（每套分类里的**字段**：类型顺序 ＋ 内置用途）。
 *      2 期（`0.8.1`）—— 记账：`ledger_entries`（一条流水）、`ledger_categories`
 *      （两级的收支分类）、`ledger_default_accounts`（默认账户：全局两层 ＋ 每类别一层）、
 *      `ledger_account_deletions`（删除记录，只为还能显示原名字）、`ledger_adjustments`
 *      （手动调整余额的留痕）、`ledger_meta`（记账库自己的系统键值表，无 `user_id`）。
 *      3 期（`0.8.2`）—— 预算：`ledger_budgets`（**一张表装两层**：总预算 ＋ 分类预算，
 *      一行 = 一期 × 一个维度；「已用 / 剩余 / 剩余 %」都是**派生量**，⛔ 一个都不建列）。
 *
 * ⭐⭐ **2 期给 1 期那六张表带来的变化只有三处**（方案 `21` §4.2）：
 *      ① `ledger_accounts` 加一列 `special`（`0` 普通 / `1` 空账户）＋ 一条**部分唯一索引**
 *         （每个账号**恰好一行**空账户）；
 *      ② `opening_fen` 的语义从「当前余额」变成「**初始基准**」（只改注释，⛔ 不改列）——
 *         当前余额改由 `lib/balance.js` **实时派生**；
 *      ③ 其余五张表**结构一字不改**（`ledger_transfers` 的"余额"含义随派生口径改，
 *         那是行为变化、不是结构变化）。
 *
 * ⭐ **记账整模块住独立库 `data/zxdesk-ledger.db`**（决策 3，`0.8.1`）：本文件只声明表，
 *    「表进哪个库」由 `module.json` 的 `database: 'ledger'` 声明、core 的 `dbOf()` 收口 ——
 *    ⛔ 本文件里不写任何库名（写第二份必然漂移）。
 *
 * ⭐⭐ **本模块是「单式」记账，不是复式**（方案 §三）：名字 `ledger` 在业界常指
 *    复式账本（借贷必平），而这里只是「一个账户一行、记它现在有多少钱」。
 *    ⭐ 0.8.0起多了**账户之间的转账**（`ledger_transfers`）——
 *    ⚠️ 它**仍然是单式**：一笔转账 = 一个账户减、另一个账户加（钱的总量不变），
 *    ⛔ 不是「借贷必平」的复式分录、⛔ 没有会计科目、⛔ 不做试算平衡。
 *
 * ⭐ **模型是「账户 + 余额」，不是「资产台账 + 估值」**（方案 §三）：房产 / 车 / 公积金
 *    一律进「自定义资产」当一个数，⛔ 不做估值日期、⛔ 不做折旧。
 *
 * ⭐⭐ **余额口径走「派生」**（方案 §三，调研称它是「五期里最贵的一个决定」）：
 *    1 期那个手填的数就叫 `opening_fen`（**期初余额**），2 期的流水往上加 ——
 *    于是第 2 期**零迁移**（另一条路「手填快照」会逼出一次「账实相符重算」或「两套数」）。
 *    ⚠️ 界面上它显示为「余额」（用户看到的数就是它），表单里给一句人话说明它会变成期初。
 *
 * ⚠️ **两张表刻意都不进通用 `_update()` 白名单**（两张表的 `allowedCols` 都是空数组，
 *    `ttt/test/schema.test.js` 的 `SKIP_TABLES` 整表豁免）—— 与 `pomodoro_prefs` /
 *    `calendar_events` 同一个道理：**能表达语义的专用原语，优于放宽容器的白名单**。
 *    · `ledger_accounts` 的写入只有两条路：插入走专用原语 `insertLedgerAccount`，
 *      改一行走 `updateLedgerAccount`（整行写、列名写死）—— `id` / `user_id` 一个都不许变。
 *    · `ledger_snapshots` 是**每账号每天一行**（`UNIQUE(user_id, date)`），写入语义是 upsert；
 *      开放给通用 `_update()` 等于让请求体里任意一个键都有机会流到列上。
 *
 * ⭐ **删除账户不删历史快照**（方案 §三）：快照是**汇总历史**（只存资产 / 负债 / 净值
 *    三个数、不存明细），删一个账户不该改写「我当时有多少钱」这件事。
 *
 * ⚠️ 模块契约见 `modules/README.md`，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.8.13
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md、
 *      docs/公共/开发方案/21-记账2期-记账.md
 */

/**
 * ⭐⭐ 三方导入的来源注册表（0.8.2，方案 `23`）—— 「一来源一张表」的**唯一出处**。
 *
 * 说明：本模块的表清单里有几张是**派生**出来的（`...IMPORT.tablesFor()` 等四处）：
 *      · `tables`      —— 建表语句
 *      · `allowedCols` —— 列白名单（一律空：导入的数据是只读的）
 *      · `userScoped`  —— 删账号要清空（⭐ 少了它那个人的导入数据会永远留在库里）
 *      · `indexes`     —— `(user_id, at)`
 *      ⚠️ 加一个新来源＝改 `lib/import-sources.js` 的清单 ＋ `module.json` 的 `tables`，
 *      ⛔ **不**回来改本文件的任何一行。⚠️ 但**必须**同时改 `module.json`：表名不进那里，
 *      `dbOf()` 会回落到主库，删账号就会在主库 `DELETE` 一个不存在的表（详见那个文件的说明）。
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
   *      ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / calendar 同一条理由）：
   *         它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   *      ② ⚠️ **不给 `name` 加唯一约束**（方案 §4.1 明写）：参考图里**同名账户是允许的**
   *         （现金那一组两行都叫「现金」）—— 加了唯一约束等于把一条正常用法变成 500。
   *      ③ ⭐ `opening_fen` = **整数分**（方案 §三）：库里不存「元」。
   *         ⛔ 不加 `CHECK` 管它的范围 —— SQLite 改 CHECK 要重建整张表，
   *         为一个范围判断付一次结构迁移不划算；范围在接口层（`lib/money.js` 的 `parseFen`）。
   *
   * @param {string} n - 表名（重建时是临时名）
   * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
   * @returns {string} 该表的 `CREATE TABLE` 语句
   */
  tables: {
    /**
     * 功能：生成 `ledger_accounts` 表的建表语句 —— 一个账户一行。
     *
     * 说明：⚠️ `created_at` / `updated_at` 只做审计，⛔ 不参与任何判定。
     *      ⭐ `sort_order` = **同 `kind` 组内** `COALESCE(MAX(sort_order), -1) + 1`（新建时业务层算）；
     *      ⭐⭐ 0.8.0起**可以手动拖动排序**（两端都能拖，手机端长按）——
     *      拖完由 `store` 的重排方法整组重写这一列，它不再是「预留」而是唯一顺序来源。
     *      ⚠️ **组间**（九类之间）的顺序由 `ledger_groups` 的 `scope='kind'` 那 9 行决定
     *      （⛔ 不再是 `lib/kinds.js` 里写死的常量顺序 —— 那份常量现在只做 seed 与兜底）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     * 说明：⭐⭐ `UNIQUE(user_id, date)` 是这张表的**命门**（方案 §4.6）：
     *      写入时机是「账户的 建 / 改 / 删 **成功之后**」，同一天改几次都只留下**一行**、
     *      值是最新那一次 —— 少了这个唯一约束，一天就会攒出多行，
     *      而「一天最多一行」正是走势图（第 4 期）的取数前提。
     *      ⚠️ 三个数**冗余存**（快照是「那一刻的事实」）：⛔ 不许事后按当前数据重算 ——
     *      那会让「删了账户 ⇒ 图表的历史跟着变」这种怪现象出现（方案 §三）。
     *      ⚠️ `net_fen` 与 `asset_fen - debt_fen` **必须同源**（同一次 `summarize()` 算出来）。
     *      ⭐ **GET 一律不写这张表**（读路径无副作用 ——  整条线）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      「这是什么账户」（类型），而一张 `ledger_views` 说的是「按什么把它们分组看」（视图）。
     *      ⇒ 两者**互不影响**：加一套分类不改任何账户、不改金额、不改净值。
     *      ⭐⭐ 0.8.0：**两条内置分类也入库**，靠 `builtin` 区分 ——
     *      因为「胶囊的先后顺序也能拖（含内置那两颗）」，顺序必须有一个**单一的存储位**
     *      （原先「按账户类型」是纯代码常量、不入库，那样它就没有位置可存）。
     *      · `builtin = 0`：用户自建（可改名、可删；上限 `lib/views.js` 的 `VIEW_MAX`）
     *      · `builtin = 1`：**按账户类型** —— 组来自 `lib/kinds.js`，名字与存亡都由代码定
     *      · `builtin = 2`：**按账户用途** —— 组来自 `ledger_groups` 的 `scope='usage'`
     *      ⚠️ `builtin > 0` 的行**接口层拒绝改名与删除**（⛔ 不是靠前端不画按钮兜）。
     *      ⚠️ `name` **允许重名**（与账户名同一条纪律）⇒ ⛔ 不加唯一约束。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      **同一套分类里只能有一个用途**（举例：支付宝2 归「创业」就不能再归「日常」）——
     *      所以「改用途」是 upsert、不是追加。少了它，同一个账户会在两个组里各出现一次，
     *      而两边的组小计都会把它算进去（合起来比净值还多，且不报错）。
     *      ⭐ 0.8.0起这一列有**两种语义**，由 `ledger_views.builtin` 决定怎么解释：
     *      · 内置「按账户用途」视图（`builtin = 2`）⇒ 存 `ledger_groups.gkey`（**稳定键**，如 `u3`）。
     *        ⚠️ 这是「用途可以改名」的命门：存名字的话，改一次名，所有归在那组下面的账户
     *        会**静默掉到「其它」**（不报错、金额也照旧，只是分组全乱）。
     *      · 自建分类（`builtin = 0`）⇒ 仍存用户输入的**用途名文本**（候选值来自这套分类里已有的用途，
     *        界面上靠「从已有的里选」防打错）。
     *      ⚠️ **没有这一行 = 这个账户在这套分类下没分** ⇒ 界面落「其它」；
     *      ⛔ 别把「其它」这个哨兵值写进库（那会让「其它」变成一个可以撞名的真组）。
     *      ⚠️ `view_id` / `account_id` 都**不加外键约束**（与全项目口径一致：约束住接口层）——
     *      但删账户 / 删分类时都会把对应的行清掉（⛔ 不留孤儿行，见 lib/views.js 的说明）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     * 说明：⭐⭐ 这张表是 0.8.0为两件需求同时加的，**一张表管两件事**
     *      （每加一张表的机械登记点是 8 处，能省一半）：
     *      · `scope = 'kind'`（9 行）：**按账户类型**那套分组，`gkey` 就是 `lib/kinds.js` 的九类键。
     *        `name` 冗余存一份中文名只为「表里看得懂」——**显示一律以代码为准**
     *        （⛔ 类型名不许被改，那是全项目的口径）。这一行 `locked = 1`（不可删、不可改名）。
     *      · `scope = 'usage'`（7 行）：**内置「按账户用途」**那 7 个字段（日用 / 借入 / 中转站 /
     *        借出 / 创业 / 攒钱 / 其它）—— **可改名、可增删、可排序**。
     *        ⚠️ 「其它」那一行 `locked = 1`（**不可删**）：它是「没分组的账户」的落点，
     *        删掉它会让那些账户在界面上**无处可去**（静默消失，而金额还在总数里）。
     *      ⭐ `sort_order` 是**这一组字段自己的顺序**（与账户的 `sort_order` 无关）：
     *      类型顺序、用途顺序都靠它，于是「按账户类型」那 9 个也终于能拖了。
     *      ⚠️ `gkey` 一旦生成就**不许改**：账户归属记的正是它（见 `ledger_view_tags.tag`）——
     *      改键等于把归属全打断（这与「`kind` 键不许改名」是同一条纪律）。
     *      ⚠️ `UNIQUE(user_id, scope, gkey)`：同一套里不许出现两个同键的字段（seed 的幂等落点）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      在它之前，账户余额只会因为用户手改而变 —— 转过账之后余额变了却查不到原因，
     *      正是「静默」的一种。⚠️ 它**没有推翻**「本模块是单式」那条（见文件头）：
     *      一笔转账就是「一个账户减、另一个账户加」，钱的总量不变。
     *      ⭐ **方向由 `from_id` / `to_id` 表达，`amount_fen` 永远是非负数**
     *      （与「用户永远只填非负数」同一条纪律，方案 §三）——
     *      存带符号的数会让「负负得正」这种错静默反向。
     *      ⚠️ `date` 取**服务端「今天」**，⛔ 不由前端算。
     *      ⚠️ **刻意不给它加唯一约束**：同一天转两笔完全正常（一天一行的是快照，不是明细）。
     *      ⚠️ 两个账户 id **不加外键**（与全项目口径一致：约束住接口层）—— 但删账户时
     *      必须把指向它的转账行一起删掉（⛔ 不留孤儿行，见 `store.js` 的 `ledgerDeleteAccount`）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      类别 / 账户 / 金额 / 备注** —— 它们全都落在这张表上。
     *      ⚠️⭐ **⛔ 不存 `date` 列**：日期就是 `at` 的**前 10 个字符**，按月取数用**字典序区间**
     *      （`at >= '2026-09-01' AND at < '2026-10-01'`）—— 存第二列就是把同一个事实写两遍
     *      ，而且两列必然漂移。
     *      ⚠️⭐ `account_id` **非空**：没选账户 ⇒ 写**空账户**的 id⇒
     *      余额派生、筛选、统计**只有一条路**，⛔ 不出现「NULL ⇒ 特殊分支」。
     *      ⭐ `ie`（收支方向）**只有两个取值**：`支出` / `收入`——
     *      转账与手动调整各自住**另一张表**，⛔ 不进这张表。
     *      ⭐ `amount_fen` **允许 0**（一笔记账可以记 0 元）；整数分。
     *      ⭐ `refund_of` 是**自引用**：这条是「退款」，退的是哪一笔——
     *      ⛔ 不新开退款表（条目自带时刻 / 账户 / 类别 / 金额，退款需要的它全有）。
     *      ⚠️ `category_id` 可空 = **未分类**—— 它与「其它」是一个**真分类**
     *      是两件事，界面上必须显示成两个不同的东西。
     *      ⚠️ ⛔ **不加任何 `CHECK`**（SQLite 改 CHECK 要重建整张表）——
     *      取值范围一律在接口层判（`routes.js` + `lib/money.js`）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      `ledger_view_tags` 的主键语义是「**账户**在某套视图里算哪组」，**装不下
     *      「流水 × 分类」**；而且「看账户的一种方式」与「这笔钱算什么」不是同一件事。
     *      ⚠️ **`ie` 只在一级上填**（二级为 NULL、继承父）：冗余存一遍必然与父漂移。
     *      ⚠️ **`name` 允许重名**（与账户名同一条纪律）⇒ ⛔ 不加唯一约束。
     *      ⚠️ **⛔ 不加 `icon` 列**：分类图标走「色块 ＋ 首字」或按名字匹配（/ 15，
     *      没有消费者的列不进表）—— 映射住前端 `calc.js` 一处。
     *      ⭐ **删除 ＝ 归档**：`archived_at` 非空 ⇒ 行留着、历史流水照旧
     *      指着它、名字照显，只是**不再出现在选择器里**。
     *      ⚠️ 父分类归档时子分类怎么办由**业务层**问用户（移动到其它 / 一起归档）——
     *      结构上不加外键、不加级联（与全项目口径一致：约束住接口层）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      · **全局两层**：收入一个 / 支出一个（`kind` = `'income'` / `'expense'`）；
     *      · **每类别一层**：`kind = 'category'`，`category_id` 是那个类别。
     *      取值顺序是 **类别行 → 全局行（按这笔的收 / 支）→ 空账户**。
     *      ⚠️⭐ **`0` 哨兵是硬的**：SQLite 的 `UNIQUE` **把 NULL 当作互不相等**
     *      ⇒ 若用 `category_id = NULL` 表示「全局两层」，那两行**可以重复插入**
     *      （唯一约束形同虚设，而且不报错）。⇒ 全局两行也写 `0`，一起进同一个唯一约束。
     *      ⚠️ 全局两行**不可删、只能改**⇒ 业务层拒删（⛔ 不是靠界面不画按钮）。
     *      ⚠️ `account_id` **可以指向空账户**（「这类账默认不关联账户」是一个合法设置）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      （不走软删），转账 / 流水 / 手动调整记录都还指着那个**原 id**，
     *      界面要显示「这笔是从哪个账户转出的」就只能来这里取名字。
     *      ⭐ 取名字的判据**只准一处**（先查账户表、查不到再查它 ——  第 6 条 / C-8）：
     *      ⛔ 别在转账明细、流水列表、筛选里各写一遍（写两遍必然漂移）。
     *      ⚠️ `account_id` 存的是**原 id**：`AUTOINCREMENT` **不复用** id ⇒ 这条记录不会
     *      被后来新建的账户「顶掉」（这正是它敢用 `UNIQUE(user_id, account_id)` 的前提）。
     *      ⚠️⛔ **不提供「恢复已删除账户」**（C-27）⇒ 这张表只增、不删。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      **必须留一条记录**（照参考图：从 X 调整为 Y）」，** 第 4 条**又写明三类变动
     *      「**手动调整余额**与**记账**各新建一张表」—— 但 1 期是**直接改 `opening_fen`**、
     *      §4.3 的四张表清单里也漏列了它。⇒ 本表由落地时补齐（表名与列名见编排者的定稿）。
     *      ⭐ 它是**余额派生的基准来源**：
     *      某账户当前余额 = 它**最后一次**调整的 `to_fen` ＋ 那次调整**之后**的变动净额；
     *      从没调整过 ⇒ 基准就是建账户时那个数（`ledger_accounts.opening_fen`）。
     *      ⚠️ `from_fen` / `to_fen` 都是**绝对值**（不是增量）：界面要显示「从 X 调整为 Y」。
     *      ⚠️⭐ **这张表只增不改不删**（不能删 / 不能撤回 / 不能编辑）⇒
     *      `allowedCols` 留空、`updateLedgerAdjustment` 这类原语**根本不存在**；
     *      调错了由用户**再操作一次**。
     *      ⚠️ 账户被硬删后这一行**保留原 id**（与流水同一条口径）—— 显示时靠
     *      `ledger_account_deletions` 取原名字。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      （迁移工具靠它做三态幂等），但方案没给那张表的形态 ⇒ 由落地时补齐。
     *      ⚠️⭐ **它没有 `user_id`** ⇒ ⛔ **不进 `userScoped`、⛔ 不进个人备份**
     *      （个人备份按 `user_id` 工作，它没有那一列 —— 强行登记会被
     *      `ttt/test/schema.test.js` 的**双向**断言拦下）；其它一切照普通表：
     *      它会进 `exportWhole` / `replaceWhole`（整库级的两条路）。
     *      ⚠️⭐ **DDL 必须与迁移工具那句兜底逐字等价** ——
     *      `core/store/methods/migrate.js` 在写标记前会先跑
     *      `CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`
     *      （表还没建时兜底）。两处的列名 / 类型 / 主键**必须一致**，否则会出现
     *      「兜底建出来的表与正式 DDL 不是一张表」这种只在某一条路径上发作的怪事。
     *      ⚠️ 键名约定**只有一条**：`migrated_from_main`（值 = 迁移完成的时间戳字符串）。
     *      ⛔ **迁移逻辑不在这里**（住 core 的 `methods/migrate.js`）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      （`period_type` ＋ `period_key` ＋ `category_id`）的额度；「已用 / 剩余 / 剩余 % / 日均」
     *      全是**派生量**（`lib/budget.js` 实时算）⇒ ⛔ 一个都不建列、⛔ 不缓存。
     *      ⚠️⭐ **`category_id = 0` 表示「总预算」**（哨兵），⛔ **绝不用 NULL**：SQLite 的
     *      `UNIQUE` 把 NULL 当**互不相等** ⇒ 同一个「总预算」能被插进去无限多行
     *      （2 期 §4.3 ③ 踩过的那次，`ledger_default_accounts` 就是为此用 `0` 哨兵）。
     *      `> 0` 时它是 `ledger_categories.id`（**任意一级**都行 —— T48-④ 点过头）。
     *      ⚠️⭐ **`period_key` 存「该期的起始日」**（周 = 周一、月 = 1 号、年 = 1 月 1 日），
     *      一律 `YYYY-MM-DD`，⛔ **不用 ISO 周号**、⛔ 不存 `2026-09`。理由三条：
     *      ① 字典序即时间序（照 `ledger_entries.at` 的既有口径）；② 避开 ISO 周号的跨年坑
     *      （属于 2027-W01，按周号存会让「哪一年」算错）；③ 三档共用一列与一条排序规则。
     *      ⚠️ **`amount_fen` 允许 `0`**：`0` ＝ **明确设成 0**，「没设」＝ **这一行不存在**
     *      （两者必须分得开 —— 与 1 期 `limit_*_fen` 可空表示「没设」的坑同源，但这里用「行在不在」
     *      表达，更干净）⇒ 判据住业务层，⛔ 不靠 `0` 兜。
     *      ⚠️ **`user_id` 不给默认值**：漏传 uid 直接报错，不静默落到 1 号账号（照 `ledger_accounts`）。
     *      ⚠️ **⛔ 不加外键、⛔ 不加 `CHECK`**（与全项目口径一致：约束住接口层）；⛔ 不给
     *      通用 `_update()` 开白名单（`allowedCols` 留空，写入只走两个专用原语）。
     *      ⚠️⭐ **不另建索引**（方案 §4.3 说明 4）：下面那条 `UNIQUE` 自带索引，它的**前缀**
     *      `(user_id, period_type, period_key)` 正好覆盖本期的两种取数 —— ① 取某一期的**全部行**
     *      （含总预算）、② 取某一期的**总预算那一行** ⇒ 照 `ledger_snapshots` 的先例
     *      （「`UNIQUE` 已自带一个索引」），⛔ 不重复建进 `indexes[]`。
     *      （⚠️ 索引的 `try / catch` 在 **core**，⛔ 不要在 `schema.js` 里自己包 ——。）
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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

    // ⭐⭐ 0.8.2（三方导入）：导入来源那几张表**由注册表派生**——
    //    ⛔ 不在这里手写第二份 SQL（写两份必然漂移，而且两张表会悄悄长得不一样）。
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
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`，
   *      加表不升，先例一大把 —— 收藏夹 / 硬件 / 密码库 / 对话 / AI / 灵感库 / 番茄钟 / 日历）。
   *      ⚠️⭐ **2 期给 `ledger_accounts` 加的那一列 `special` 走 `ensureColumns`，不走重建** ——
   *      重建是「改列的类型 / 约束」才需要的重活，加一列不必付那个代价。
   *
   * @type {Array.<string>}
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
   * 说明：⚠️ 这一条**必须有**（0.8.0加）：真机上装过本批之前的包里 `ledger_views`
   *      表**早就存在**，而 `CREATE TABLE IF NOT EXISTS` 永远补不上新列 ⇒
   *      老库上 `builtin` 读出来是 undefined ⇒ 两颗内置胶囊被当成用户自建（能改名、能删）。
   *      ⭐ 这正是本项目记过的那类事故（0.7.1 的 `teamwork_reminder_prefs.builtin_name`
   *      只写进建表语句、漏登记，结果「七个设置项里只有称呼存不进去」）。
   *      ⚠️ 反过来，本模块的**新表**（`ledger_groups`）**不许**写进来 ——
   *      表还没建就 `ALTER TABLE` 会当场报错。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['ledger_views', 'builtin', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐：一套分类里**组内的先后**（报「支付宝拖不到第一个」后加的）。
    //    ⚠️ 加列的登记点仍是**三处**：本处 ＋ 上方 DDL ＋ backup.js 的 COLS，缺一处不报错。
    //    ⚠️⭐ 这一列**必须**走 ensureColumns：ledger_view_tags 在老库里早就存在，
    //    DDL 只在「表还没建」时管用 ⇒ 漏了这里 = 老用户那条列永远不存在，而且不报错。
    ['ledger_view_tags', 'sort_order', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐：储蓄卡 / 信用卡的分级与三个限额。⚠️⭐ 只加列的登记点是**三处**：
    //     本处（老库补列）＋ 上面的 DDL（新库建表）＋ `backup.js` 的 `COLS`（个人备份）。
    //     缺一处 = 一种装法下那列存不进去 / 备份丢了它，而且**都不报错**。
    ['ledger_accounts', 'tier', 'TEXT'],
    ['ledger_accounts', 'limit_day_fen', 'INTEGER'],
    ['ledger_accounts', 'limit_month_fen', 'INTEGER'],
    ['ledger_accounts', 'limit_year_fen', 'INTEGER'],
    // ⭐⭐ 2 期（记账）：`special`（`0` 普通 / `1` 空账户）。⚠️⭐ 这一条**必须有**：
    //      `ledger_accounts` 在**每一个**已装过 1 期的库上都早就存在，
    //      而 `CREATE TABLE IF NOT EXISTS` 永远补不上它的新列 ⇒
    //      漏了这一行 = 老库上 `special` 读出来是 undefined ⇒ **每个账号都找不到自己的空账户**，
    //      「没选账户的账」无处可落（而新装的库一切正常 —— 只在升级路径上发作，且不报错）。
    //    ⚠️ 加列的登记点仍是**三处**：本处（老库补列）＋ 上面的 DDL（新库建表）
    //      ＋ `core/store/methods/backup.js` 的 `COLS.ledger_accounts`（个人备份）。
    //      第三处属于**别人的文件**，已在交付报告里列为待办。
    //    ⚠️ 反过来，2 期的**新表**（`ledger_entries` … `ledger_meta`）⛔ 不许写进来 ——
    //      表还没建就 `ALTER TABLE` 会当场报错（与上面 `ledger_groups` 同一条）。
    ['ledger_accounts', 'special', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐⭐ 0.8.1：`ledger_categories.builtin`（`1` = 内置，不可删 / 不可改名 / 不可归档）。
    //      ⚠️⭐ 这一条**必须有**：真机上装过本模块早期包的那个库里 `ledger_categories` 早就存在，
    //      而 `CREATE TABLE IF NOT EXISTS` 永远补不上它的新列 ⇒ 老库上 `builtin` 读出来是
    //      undefined ⇒ **所有内置分类都被当成用户自建**（能删能改名，而且不报错）。
    //      这正是 `teamwork_reminder_prefs.builtin_name` 那次事故的形状。
    //    ⚠️ 加列的登记点共**五处**：本处（老库补列）＋ 上面的 DDL（新库建表）
    //      ＋ `core/store/methods/backup.js` 的 `COLS.ledger_categories`（个人备份）
    //      ＋ 两个后端的 `insertLedgerCategory`（INSERT 列手写）与 `seedLedgerCategories`（写 1）。
    ['ledger_categories', 'builtin', 'INTEGER NOT NULL DEFAULT 0'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**十三张表都刻意留空**。
   *
   * 说明：⚠️ 空数组不是漏写，是**安全属性**（同 `calendar_events` / `pomodoro_sessions`）：
   *      两张表的变化都走自己的专用原语（插入用 `insertLedgerAccount`、改账户走
   *      `updateLedgerAccount`、快照走 `upsertLedgerSnapshot`）。放开通用更新会有两种坏结果：
   *      · `ledger_accounts`：让请求体里任意一个键都有机会流到列上 ——
   *        包括把一条记录「过户」给别人（`user_id` 白名单外还有第二道保险，但不该靠它兜）；
   *      · `ledger_snapshots`：它是「那一刻的事实」，被一次通用 PUT 改掉就再也不是事实了。
   *      ⇒ `ttt/test/schema.test.js` 的 `SKIP_TABLES` 里这十三张表都整表豁免「逐列对齐」。
   *
   * @type {Object}
   */
  allowedCols: {
    ledger_accounts: [],
    ledger_snapshots: [],
    ledger_views: [],
    ledger_view_tags: [],
    ledger_groups: [],
    ledger_transfers: [],
    // ⭐⭐ 2 期的六张表**一律留空**（同一条纪律，⛔ 一张都不许开通用 `_update()` 白名单）：
    //    · `ledger_entries`：身份是 `at` / `ie` / `amount_fen` / `account_id` ——
    //      放开通用更新等于让一次 PUT 就能把一笔账「过户」到别人的账户上；
    //    · `ledger_categories`：`parent_id` / `ie` 是**结构字段**（改它们 = 搬家 / 跨侧，
    //       明令接口层不许改），写入只走专用原语；
    //      ⭐ 0.8.1 起 `builtin`（内置标记）也照这条纪律 —— 只有 seed 与「恢复内置分类」两条
    //      原语能写它，⛔ 不给通用 `_update()` 开白名单；
    //    · `ledger_default_accounts`：写入语义是 **upsert**（`UNIQUE(user_id, kind, category_id)`），
    //      开放给通用更新等于让请求体里任意一个键都有机会流到列上；
    //    · `ledger_account_deletions`：只增不删、**不可恢复**（C-27）—— 没有「改一行」这个业务；
    //    · `ledger_adjustments`：⭐⭐ **只增不改不删**（不能删 / 不能撤回 / 不能编辑）；
    //    · `ledger_meta`：系统键值表，写入只走迁移工具那条路（⛔ 不是业务接口）。
    ledger_entries: [],
    ledger_categories: [],
    ledger_default_accounts: [],
    ledger_account_deletions: [],
    ledger_adjustments: [],
    ledger_meta: [],
    // ⭐ 3 期（预算）：同样**刻意留空** —— 额度是「一期 × 一个维度」的一行，写入语义是
    //    **upsert**（`UNIQUE(user_id, period_type, period_key, category_id)`）；
    //    开放给通用 `_update()` 等于让请求体里任意一个键（含 `period_type` / `period_key`）
    //    都有机会流到列上，把一份预算**静默搬到另一期**（而界面上只是数字变了）。
    ledger_budgets: [],
    // ⭐⭐ 0.8.2（三方导入）：导入表**一律留空** —— 它们是**只读**的
    //    （没有「改一行」这个业务：要撤走「整批清除」那条路），写入只走专用原语。
    //    开放通用 `_update()` 等于让请求体里任意一个键都有机会流到列上。
    ...IMPORT.blankColsFor(),
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：十二张（1 期六张 ＋ 2 期五张 ＋ 3 期一张）都是「这个人自己的东西」（他自己的账户、净值历史、
   *      分类视图、转账、流水、收支分类、默认账户、删除记录、手动调整），没有第二方 ⇒
   *      标准的「账号一走、数据全走」。⚠️ 与任务板同一口径：**管理员也看不到成员的账**。
   *      ⚠️⭐ **`ledger_meta` 刻意不在这里** —— 它**没有 `user_id`**（它是记账库自己的系统
   *      键值表，与 `users` / `settings` 同属"全局数据"）。登记进来反而会红：
   *      `ttt/test/schema.test.js` 那条断言是**双向**的（带了就必须登记、没带就不许登记）。
   *      ⭐「删账号级联」**不需要**去 `deleteUser` 里加清单 —— 唯一出处就是这里
   *      （`ttt/test/schema.test.js:125` 会机械拦「带 user_id 却没登记」）。
   *
   * @type {Array.<string>}
   */
  userScoped: [
    'ledger_accounts',
    'ledger_snapshots',
    'ledger_views',
    'ledger_view_tags',
    'ledger_groups',
    'ledger_transfers',
    // ⭐ 2 期（记账）：五张带 user_id 的新表 —— 漏一张 = 删账号留下那个人的账（且不报错）
    'ledger_entries',
    'ledger_categories',
    'ledger_default_accounts',
    'ledger_account_deletions',
    'ledger_adjustments',
    // ⭐ 3 期（预算）：额度同样只属于账号本人 —— 漏登记 = 删账号之后那个人的预算还留在库里
    //    （而界面上「这个人已经没了」，那些行**再也没人访问得到**，且不报错）
    'ledger_budgets',
    // ⭐⭐ 0.8.2（三方导入）：导入表**必须进这一份** —— 删账号时它才会被清掉。
    //    ⚠️⚠️ 少了这一行**不会报错**，但那个人的导入数据会**永远留在库里**（界面上「人已经没了」）。
    //    ⚠️ 同时它还必须进 `module.json` 的 `tables`：否则 `dbOf()` 回落到主库，
    //      删账号会在主库执行 `DELETE FROM shayu` ⇒ 当场 no such table、删账号卡在中途。
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
   *      （记账条目三条 ＋ 分类 / 调整各一条 ＋ 空账户的部分唯一索引一条）。
   *      · `idx_ledger_accounts_user_sort`：按 `user_id` 过滤 + 组内按 `sort_order` 排序，
   *        这条索引的左列正好两样都覆盖；
   *      ⚠️ **刻意不给 `(user_id, date)` 再建一条**：`UNIQUE(user_id, date)` 已经自带一个索引，
   *      再声明一条同名同列的只是多一份要维护的 DDL、换不来任何可观测的收益
   *      （与日历那边「刻意不给 `end_date` 再建一条」同一条纪律）。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_ledger_accounts_user_sort ON ledger_accounts(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_views_user_sort ON ledger_views(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_view_tags_user_account ON ledger_view_tags(user_id, account_id)',
    // ⭐ 0.8.0：分组字段的取数永远是「这个账号的这一套，按自己的顺序」⇒
    //    这条索引的左两列正好管过滤（user_id + scope），右列就是那个排序键。
    'CREATE INDEX IF NOT EXISTS idx_ledger_groups_user_scope_sort ON ledger_groups(user_id, scope, sort_order)',
    // ⭐ 0.8.0：转账明细的取数是「这个账号的全部转账里，与这个账户有关的那几条，
    //    按日期倒序」⇒ 这条索引的左列管过滤、右列正好就是那个排序键。
    //    ⚠️ **刻意不给 `from_id` / `to_id` 各建一条**：查询里那两个是 `OR` 条件，而
    //    `user_id` 的选择性已经把扫描量压到「一个人自己的几十笔」——再多两条只是多两份
    //    要维护的 DDL（与上面「刻意不给 `(user_id, date)` 再建一条」同一条纪律）。
    'CREATE INDEX IF NOT EXISTS idx_ledger_transfers_user_date ON ledger_transfers(user_id, date)',
    // ⭐⭐ 2 期（记账）新增六条。前三条是 ① 定死的：
    //    · `(user_id, at)`：按月取数 ＋ 游标分页的主力（区间是**字典序**的 `at`，见 DDL 说明）；
    //    · `(user_id, account_id, at)`：账户详情那三类混排（先按账户过滤，再按时刻倒序）；
    //    · `(user_id, refund_of)`：原交易上「累计退了多少」（按原条目 id 一次取一批，⛔ 不做 N+1）。
    'CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_at ON ledger_entries(user_id, at)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_acct_at ON ledger_entries(user_id, account_id, at)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_refund ON ledger_entries(user_id, refund_of)',
    // ⭐ 2 期：两级分类的取数永远是「这个账号的这一级、按自己的顺序」⇒ 三列正好
    //    管过滤（user_id ＋ parent_id）与排序（sort_order）。
    'CREATE INDEX IF NOT EXISTS idx_ledger_categories_user_parent ON ledger_categories(user_id, parent_id, sort_order)',
    // ⭐ 2 期：余额派生要按「这个账户的全部调整、取 `at` 最新的那条」⇒ 左两列管过滤、
    //    右列就是那个取最大值的键。
    'CREATE INDEX IF NOT EXISTS idx_ledger_adjustments_user_acct_at ON ledger_adjustments(user_id, account_id, at)',
    // ⭐⭐ 2 期：**空账户的部分唯一索引** —— 保证**每个账号恰好一行** `special = 1`。
    //    ⚠️ 这是**唯一**能表达「恰好一行」的地方：`special = 0` 的普通账户可以有任意多行，
    //    所以不能用普通 `UNIQUE(user_id, special)`（那会把一个人锁死成一个普通账户）。
    //    ⚠️ SQLite 的部分索引（`WHERE`）自 3.8.0 起支持 —— 与全项目口径一致（不另设门槛）。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_special ON ledger_accounts(user_id) WHERE special = 1',
    // ⭐⭐ 0.8.2（三方导入）：导入表的索引同样由注册表派生
    //    （`(user_id, at)` —— 明细按天分组与统计按月取数都吃它）。
    ...IMPORT.indexesFor(),
  ],
};
