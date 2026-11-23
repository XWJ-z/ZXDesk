'use strict';
/**
 * modules/calendar/schema.js —— **日历模块**
 * 功能：声明本模块**两张表** —— `calendar_events`（一条事件一行：标题 + 起止日 + 是否全天 +
 * 起止时刻 + 备注）与 `calendar_prefs`（每账号一行：**四个**只读图层的开关 ＋ ****
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
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
   * ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / idea / pomodoro 同一条理由）：
   * 它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   */
  tables: {
    /**
     * 功能：生成 `calendar_events` 表的建表语句 —— 用户自己的事件。
     *
     * 而这三条（全天不带时刻 / 时刻有序 / 日期有序）在接口层一次就能判干净 ——
     * 照 `ai` 模块的做法，校验放**接口层**（超区间一律 400，⛔ 不静默清空、不静默截断）。
     * 只在两列上留了单列 `CHECK`（`all_day` 只能是 0/1），那是**没有跨列语义**的形式约束。
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
     *
     * 说明：⭐ 四个图层（课表 / 任务截止 / 法定假期 / **记账**）各有一个开关，住**日历页头**
     * 开关是「这个账号想不想看见这一层」，所以住模块自己的表、一人一行、走 upsert ——
     * 不加 `users` 列（那是 `hide_*` 的地盘，只承担「这个模块显不显示」一件事）。
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
   * `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`，
   * 先例：收藏夹 / 硬件 / 密码库 / 对话 / AI / 灵感库 / 番茄钟七批都没升）。
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
   * 往这里写它们的列反而会在「表还没建」时执行 `ALTER TABLE` 报错）。
   * （那时 `calendar_prefs` 已经建在用户的库里，`CREATE TABLE IF NOT EXISTS` 永远补不上后加的列）。
   */
  ensureColumns: [
    // 人生日历：出生日期（NULL = 还没填 ⇒ 该视图走空态，⛔ 不给默认生日）
    // 与预期寿命（年；NULL ⇒ 前端按默认 80 显示，但**不写回**）。
    ['calendar_prefs', 'birth_date', 'TEXT'],
    ['calendar_prefs', 'expect_years', 'INTEGER'],
    // 第 4 个图层「记账」—— 类型串与 DDL 逐字同款（带 `NOT NULL DEFAULT 1`），
    // 老库补出来那一列因此直接取「默认开」，与 DDL 给新库的默认值一致（先例：core 的 `hide_*` 那批）。
    ['calendar_prefs', 'layer_ledger', 'INTEGER NOT NULL DEFAULT 1'],
    // 首页看板的「默认视图」：'list' | 'cal'，**可空、无默认值**。
    // ⇒ `CREATE TABLE IF NOT EXISTS` **永远补不上后加的列**，**必须**登记在这里，
    // 用 `TEXT` 而不是 0/1 整数：这一列的取值是**两个枚举名**（`list` / `cal`），
    ['calendar_prefs', 'default_view', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**两张表都刻意留空**。
   *
   * 说明：⚠️ 空数组不是漏写，是**安全属性**（同 `vault_meta` / `pomodoro_sessions`）：
   * 两张表的变化都走自己的专用原语（插入用通用 `_insert`、改事件走 `setCalendarEvent`、
   * 图层开关走 `upsertCalendarPrefs`）。放开通用更新会有两种具体的坏结果：
   */
  allowedCols: {
    calendar_events: [],
    calendar_prefs: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：两张都是「这个人自己的东西」（事件与开关），没有第二方 ⇒ 标准的
   * 「账号一走、数据全走」（用例 13）。⚠️ 与任务板同一口径：
   * **管理员也看不到成员的事件**。
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
   * `idx_calendar_user_date`：区间查询的**左列**（`WHERE user_id=? AND date<=?`）
   * 与「这个账号的事件按日期排」都靠它。
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_calendar_user_date ON calendar_events(user_id, date)',
  ],
};
