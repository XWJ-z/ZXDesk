'use strict';
/**
 * modules/calendar/schema.js —— **日历模块**（0.7.5）
 *
 * 功能：声明本模块**两张表** —— `calendar_events`（一条事件一行：标题 + 起止日 + 是否全天 +
 *      起止时刻 + 备注）与 `calendar_prefs`（每账号一行：**四个**只读图层的开关 ＋ **0.7.8 起**
 *      还有「人生日历」的两项设置 —— 出生日期与预期寿命 ＋ **0.8.7 起**还有「首页看板默认视图」一列），
 *      并给出它们的 DDL 生成器、列白名单、归属表清单与索引语句。
 *
 * ⭐ **0.8.3（记账 4 期）加了第 4 个图层「记账」**：它只多**一列** +
 *    一行 `ensureColumns` —— ⛔ **不升 `SCHEMA_VERSION`**（加列不升结构版本），
 *    也**不动 `module.json`**（它只列**表**，加列与它无关）。
 *
 * ⭐ **本模块的命门是「日历是消费方，不是判定方」**（方案 §四-2 那条铁律）：
 *    日历**只画**、不判 —— 「某天有什么课」永远走看板那一份既有实现
 *    （`core/store/methods/stats.js` 的 `courseItems()`，经 `store.dashboard()` 取），
 *    「某天是不是假期」永远走 `core/holidays.js`。⛔ 日历里**不许出现第三份判定** ——
 *    第三份的下场是「课表页有这节课、日历上没有」，而且**不报任何错**。
 *
 * ⭐ **为什么是「自己的事件」而不是「课表的延伸」**（
 *    「**不是所有用户都是学生，日历得独立吧**」）：日历有自己的事件，课表只是它的
 *    **一个可选图层**（学生把课请进来，非学生压根不显示）——
 *    一句话判据：**关掉课表，日历还能不能用**。
 *
 * ⚠️ **两张表刻意都不进通用 `_update()` 白名单**（两张表的 `allowedCols` 都是空数组，
 *    `ttt/test/schema.test.js` 的 `SKIP_TABLES` 整表豁免）—— 与 `vault_meta` /
 *    `pomodoro_sessions` 同一个道理：**能表达语义的专用原语，优于放宽容器的白名单**。
 *    · `calendar_events` 的八个可写列之间有**跨列约束**（全天不许带时刻、`end_time >= start_time`、
 *      `end_date >= date`）。放开通用 `_update()` 等于允许只改其中一列 ——
 *      例如只把 `all_day` 改成 1，那一行就**静默**留着上一次的 `start_time`，
 *      而「全天却带着时刻」正是方案 §4.1 明令要 400 的形状。
 *      ⇒ 改一条事件走专用原语 `setCalendarEvent`（整行八列一起写，跨列约束在业务层校验）。
 *    · `calendar_prefs` 是**一人一行**（`UNIQUE(user_id)`），写入语义是 upsert；
 *      开放给通用 `_update()` 等于让请求体里任意一个键都有机会流到列上
 *      （与 `teamwork_reminder_prefs` / `pomodoro_prefs` 同一条理由）。
 *
 * ⚠️ **为什么有第二张表**（方案 §4.1 写的是「一张表」，那是只数了事件表）：
 *    方案 §六 要求 `PUT /api/calendar/layers` 把三个图层开关**存下来**
 *    （§九 用例 11 的判据是「逐键保存」），而 §4.1 又明写**不加 `users` 列**的纪律
 *    （番茄钟的时长偏好就是照这条走的，见 / 铁律 11）——
 *    于是只能住模块自己的表：一账号一行、三个 INTEGER 开关。形状与 `pomodoro_prefs` 同款。
 *    ⚠️ 这一处与方案文字的差异已记进 `AGENTS.md §七`，等定夺。
 *
 * ⚠️ 模块契约见 `modules/README.md`，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.13
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/18-日历-1期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'calendar',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '日历',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计取舍 ——
   *      ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / idea / pomodoro 同一条理由）：
   *         它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   *      ② ⭐ 日期与时刻**一律字符串**（方案 §三）：`date` / `end_date` = `YYYY-MM-DD`，
   *         `start_time` / `end_time` = `HH:MM`。全程**字典序即时间序**，⛔ 不引日期库（铁律 5 零依赖）、
   *         ⛔ 不存时间戳 —— 时间戳一旦落库就要谈时区，而这一屏只需要「哪天 / 几点」。
   *      ③ ⚠️ `end_date` / `all_day` **一期就先带上**（方案 §三）：
   *         哪怕 V1 的渲染只标注一句「至 X 月 X 日」，数据的形状先定死，
   *         免得日后要做跨天条时被迫做一次结构迁移。
   *
   * @param {string} n - 表名（重建时是临时名）
   * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
   * @returns {string} 该表的 `CREATE TABLE` 语句
   */
  tables: {
    /**
     * 功能：生成 `calendar_events` 表的建表语句 —— 用户自己的事件。
     *
     * 说明：⚠️ **不加 `CHECK` 约束来管跨列关系**（方案 §4.1 明写）：SQLite 改约束要重建整张表，
     *      而这三条（全天不带时刻 / 时刻有序 / 日期有序）在接口层一次就能判干净 ——
     *      照 `ai` 模块的做法，校验放**接口层**（超区间一律 400，⛔ 不静默清空、不静默截断）。
     *      只在两列上留了单列 `CHECK`（`all_day` 只能是 0/1），那是**没有跨列语义**的形式约束。
     *      ⚠️ `created_at` / `updated_at` 只做审计，⛔ 不参与任何判定（方案 §4.1 末行）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    calendar_events: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,          -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        title       TEXT NOT NULL,             -- 必填（空 / 超长一律 400，见 routes.js）
        date        TEXT NOT NULL,             -- 开始日 YYYY-MM-DD（字典序可比）
        end_date    TEXT,                      -- 可空；NULL = 当天结束（跨天事件一期只标注、不画跨格条）
        all_day     INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
        start_time  TEXT,                      -- 可空；HH:MM（all_day = 1 时必须为空，接口层校验）
        end_time    TEXT,                      -- 可空；HH:MM（必须 >= start_time，同日比较）
        note        TEXT,                      -- 可空
        created_at  INTEGER,                   -- 审计用，不参与判定
        updated_at  INTEGER                    -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `calendar_prefs` 表的建表语句 —— 每账号一行的**四个图层开关**，
     *      外加「人生日历」（0.7.8）的两项设置。
     *
     * 说明：⭐ 四个图层（课表 / 任务截止 / 法定假期 / **记账**）各有一个开关，住**日历页头**
     *      （方案 §三；记账那一层是 0.8.3 加的）。
     *      开关是「这个账号想不想看见这一层」，所以住模块自己的表、一人一行、走 upsert ——
     *      ⛔ 不加 `users` 列（那是 `hide_*` 的地盘，只承担「这个模块显不显示」一件事）。
     *      ⚠️ 四列都带 `DEFAULT 1`（新库建行时默认**全开**）：四个图层是日历的卖点，
     *      默认关掉等于把这个功能藏起来。读侧的默认值常量住在 `store.js`。
     *
     * ⭐ **0.7.8 加的两列**（`birth_date` / `expect_years`）与那三个开关
     *      **共用同一行**（也是「每账号一行」，语义正好）⇒ ⛔ 不开第三张表：
     *      · `birth_date` TEXT 可空 —— `YYYY-MM-DD`，**NULL = 还没填 ⇒ 人生日历走空态**（⛔ 不给默认生日）；
     *      · `expect_years` INTEGER 可空 —— 用户自己设的预期寿命（**年**）；
     *        NULL ⇒ 前端按默认 80 显示，但**不写回**（默认值是「显示口径」，不是「用户的设置」）。
     *      ⚠️ 两列**都不给 `CHECK`**：范围与格式的校验放接口层（`routes.js` 的 `checkCalendarLife`）——
     *      SQLite 改 CHECK 要重建整张表 ⇒ 推 `SCHEMA_VERSION` + 走迁移体检，为一个范围判断付一次
     *      结构迁移不划算（三条纪律之一，与 `calendar_events` 同款）。
     *      ⚠️ 也**不落「到期日 / 已过格数 / 总格数」**：那三个数全部是算出来的（生日 ＋ 预期寿命 ＋ 今天），
     *      落库就是第二个真相源 —— 与 `15-NAS硬件管理` §二-2「寿命预警不落库」同一条理由。
     *      ⚠️ 两列**必须同时登记进 `ensureColumns`**：真机上 `calendar_prefs` 自 0.7.5 起就已经存在，
     *      `CREATE TABLE IF NOT EXISTS` 永远补不上后加的列（0.7.1 的 `teamwork_reminder_prefs.builtin_name`
     *      就是这么丢的）。
     *
     * ⭐ **0.8.3 加的一列**（`layer_ledger`，记账 4 期 ·）：第 4 个只读图层的开关，
     *      形状与那三个**逐字同款**（`INTEGER NOT NULL DEFAULT 1 CHECK (… IN (0, 1))`，默认**开**）。
     *      ⚠️⭐ 与 `birth_date` 同一条命门：真机上的 `calendar_prefs` 早就存在 ⇒ **必须同时**
     *      登记进 `ensureColumns`，否则「新装能存、老库静默存不进去」而且**不报错**（方案 §7.4
     *      点名的那三处「漏了不报错」之首）。
     *
     * ⭐ **0.8.7 加的一列**（`default_view`）：首页看板默认看哪个视图
     *      （`'list'` 列表 / `'cal'` 日历；NULL 或未知值 ⇒ 读侧回落 `'list'`）。
     *      ⚠️ 它是**界面偏好**，不是「这个模块显不显示」—— 所以住模块自己的表，
     *      ⛔ 不加 `users` 列（铁律 11；那一列是 `hide_*` 的地盘，`hide_calendar` 本轮**语义退役但不删列**）。
     *      ⚠️ **可空、无默认值** ⇒ 老库那条 `ALTER TABLE ADD COLUMN` 照样成功、一行数据都不动。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    calendar_prefs: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL,
        layer_course  INTEGER NOT NULL DEFAULT 1 CHECK (layer_course IN (0, 1)),  -- 画不画「有课」标记
        layer_task    INTEGER NOT NULL DEFAULT 1 CHECK (layer_task IN (0, 1)),    -- 画不画「任务截止」
        layer_holiday INTEGER NOT NULL DEFAULT 1 CHECK (layer_holiday IN (0, 1)), -- 画不画「法定假期」
        layer_ledger  INTEGER NOT NULL DEFAULT 1 CHECK (layer_ledger IN (0, 1)),  -- 0.8.3：画不画「记账」
        updated_at    INTEGER,
        birth_date    TEXT,                                                      -- 0.7.8：出生日期 YYYY-MM-DD（NULL = 还没填）
        expect_years  INTEGER,                                                   -- 0.7.8：预期寿命（年，NULL = 未设 ⇒ 按 80 显示）
        default_view  TEXT,                                                      -- 0.8.7：首页看板默认看哪个视图（'list' / 'cal'；NULL = 按 'list'）
        UNIQUE(user_id)                                                          -- ⭐ 一人一行（upsert 的落点）
      );`,
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
   * 说明：两张都是新表，老库上根本没有它们，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`，
   *      先例：收藏夹 / 硬件 / 密码库 / 对话 / AI / 灵感库 / 番茄钟七批都没升）。
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
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   *
   * 说明：⚠️ 本模块原先**刻意留空**（两张表都是新表，`CREATE TABLE IF NOT EXISTS` 一步到位；
   *      往这里写它们的列反而会在「表还没建」时执行 `ALTER TABLE` 报错）。
   *      ⭐ **0.7.8第一次真的要用它** —— 给「人生日历」的两项设置补两列：
   *      前提条件「表还没在任何真机上存在过」自 0.7.5 发出去那天起就不成立了
   *      （那时 `calendar_prefs` 已经建在用户的库里，`CREATE TABLE IF NOT EXISTS` 永远补不上后加的列）。
   *      ⚠️ 两列都**可空、无默认值** ⇒ `ALTER TABLE ADD COLUMN` 永远成功、一行数据都不会动；
   *      而 `_migrateSqlite()` 是**先 `createAll()` 再 `ensureColumns()`**，顺序保证「表一定先存在」。
   *      ⚠️ **刻意不推进 `SCHEMA_VERSION`**：先例一大把（0.7.1 的 `teamwork_reminder_prefs.builtin_name`、
   *      0.4.4 的 `teamwork_friendships.remark`…）—— 升版本号只会触发一次整库重建（DROP + 搬数据 +
   *      RENAME），而这两列没有任何东西要搬，代价与风险都白担。
   *      ⚠️ 这两条与 `tables.calendar_prefs` 的 DDL **必须同时成立**：DDL 管新库一步到位，
   *      这里管老库补齐 —— 漏了任何一边，症状都是「一种装法下这两项存不进去」，而且不报错。
   *
   * ⭐ **0.8.3（记账 4 期）加的 `layer_ledger`**：它带 `NOT NULL DEFAULT 1`
   *      ⇒ `ALTER TABLE ADD COLUMN` 照样一条成功（SQLite 允许带常量默认值的非空列），
   *      老库上补出来的那一列取 `1` = **默认开**，与 DDL 给新库的默认值逐字一致。
   *      ⚠️⭐ 这一行是**方案 §7.4 点名的那处「漏了不报错」**：漏了的表现是「新装能存、
   *      老库静默存不进去」，而真机上的库全是升级上来的（`ttt/test/calendar.test.js` 里
   *      那条「老库补列」用例钉的就是它）。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    // ⭐ 0.7.8 人生日历：出生日期（NULL = 还没填 ⇒ 该视图走空态，⛔ 不给默认生日）
    //    与预期寿命（年；NULL ⇒ 前端按默认 80 显示，但**不写回**）。
    ['calendar_prefs', 'birth_date', 'TEXT'],
    ['calendar_prefs', 'expect_years', 'INTEGER'],
    // ⭐ 0.8.3 第 4 个图层「记账」—— 类型串与 DDL 逐字同款（带 `NOT NULL DEFAULT 1`），
    //    ⚠️ 老库补出来那一列因此直接取「默认开」，与 DDL 给新库的默认值一致（先例：core 的 `hide_*` 那批）。
    ['calendar_prefs', 'layer_ledger', 'INTEGER NOT NULL DEFAULT 1'],
    // ⭐ 0.8.7 首页看板的「默认视图」：'list' | 'cal'，**可空、无默认值**。
    //    ⚠️⭐ 与 `birth_date` 同一条命门：真机上的 `calendar_prefs` 自 0.7.5 起就存在
    //    ⇒ `CREATE TABLE IF NOT EXISTS` **永远补不上后加的列**，**必须**登记在这里，
    //    否则「新装能存、老库静默存不进去」而且**不报错**（`ttt/test/calendar.test.js` 有一条老库补列用例钉它）。
    //    ⚠️ 用 `TEXT` 而不是 0/1 整数：这一列的取值是**两个枚举名**（`list` / `cal`），
    //    与那四个「开关」（0/1）不是同一类东西 —— 写成整数会在读侧多一层没必要的换算。
    ['calendar_prefs', 'default_view', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**两张表都刻意留空**。
   *
   * 说明：⚠️ 空数组不是漏写，是**安全属性**（同 `vault_meta` / `pomodoro_sessions`）：
   *      两张表的变化都走自己的专用原语（插入用通用 `_insert`、改事件走 `setCalendarEvent`、
   *      图层开关走 `upsertCalendarPrefs`）。放开通用更新会有两种具体的坏结果：
   *      · `calendar_events`：单独改 `all_day` 会留下上一次的时刻 ⇒「全天却带着时刻」的坏数据；
   *      · `calendar_prefs`：让请求体里任意一个键都有机会流到列上。
   *      ⇒ `ttt/test/schema.test.js` 的 `SKIP_TABLES` 里两张表都整表豁免「逐列对齐」。
   *
   * @type {Object}
   */
  allowedCols: {
    calendar_events: [],
    calendar_prefs: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：两张都是「这个人自己的东西」（事件与开关），没有第二方 ⇒ 标准的
   *      「账号一走、数据全走」（用例 13）。⚠️ 与任务板同一口径：
   *      **管理员也看不到成员的事件**。
   *
   * @type {Array.<string>}
   */
  userScoped: ['calendar_events', 'calendar_prefs'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_calendar_user_date`：区间查询的**左列**（`WHERE user_id=? AND date<=?`）
   *        与「这个账号的事件按日期排」都靠它。
   *      ⚠️ **刻意不给 `end_date` 再建一条**：区间查询的另一半判据压在 `end_date` 上，
   *      但那是「跨天事件的两端都算命中」用的，一个月的数据量是**几十行**量级 ——
   *      多一条索引换不来可观测的收益，反而多一份要维护的 DDL。
   *      `calendar_prefs` 不建索引：它靠 `UNIQUE(user_id)` 自带的那一个，一人一行。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_calendar_user_date ON calendar_events(user_id, date)',
  ],
};
