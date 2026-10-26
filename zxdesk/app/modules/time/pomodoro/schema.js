'use strict';
/**
 * modules/pomodoro/schema.js —— **番茄钟模块**（0.7.5）
 *
 * 功能：声明本模块**两张表** —— `time_pomodoro_sessions`（一次专注一行：开始时刻 + 计划时长 +
 *      结束时刻 + 状态 + 累计暂停）与 `time_pomodoro_prefs`（每账号一行：三个时长与轮次），
 *      并给出它们的 DDL 生成器、列白名单、归属表清单与索引语句。
 *
 * ⭐ **本方案的命门是「落库只存事实」**（方案 §四 与）：
 *    `started_at` / `planned_seconds` / `ended_at` / `status` / `paused_at` / `paused_total` 全是
 *    **已经发生过的事**；⛔ **绝不存「剩余多少秒」** —— 那是派生量，落库就等于两份真相，
 *    而两份真相迟早不一致（本项目在时间口径上反复踩过这一条）。
 *    「现在还剩多少」永远由前端拿**服务端给的时刻**重算（`public/core/clock.js`）。
 *
 * ⭐ **两张表刻意都不进通用 `_update()` 白名单**（`allowedCols` 两张表都是空数组，
 *    `ttt/test/schema.test.js` 的 `SKIP_TABLES` 整表豁免）—— 与 `vault_meta` / `teamwork_reminder_prefs`
 *    同一个道理：**能表达语义的专用原语，优于放宽容器的白名单**。
 *    · `time_pomodoro_sessions` 的每一次变化都是**状态机**上的一个动作（开始 / 暂停 / 继续 / 结束），
 *      交给通用更新等于让请求体里任意一个键都有机会流到列上（其中包括 `started_at` / `planned_seconds`
 *      —— 那两列是「真相」，改了等于把用户已经专注过的时间抹掉）；
 *    · `time_pomodoro_prefs` 的每一列都要做**区间校验**（§5.2），而且它一人一行、写入语义是 upsert。
 *
 * ⚠️ **`paused_at` 是方案 §5.1 的列表里没有、但 §四-7 明确要求的一列**：
 *    那条规矩说「暂停 = 一个事实：`paused_at` / `paused_total` 落库；恢复时 `planned` 顺延」。
 *    没有 `paused_at` 就没法在「继续」那一刻算出**这次停了多久**（`paused_total += now - paused_at`），
 *    只剩「把剩余秒数存起来再倒着走」那条**已被 1.4 明令禁止**的路。
 *    它是一列**事实**（这一刻开始暂停），不是派生量，所以不违反上面那条纪律。
 *
 * ⚠️ 模块契约见 index.js 的说明，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.32
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'pomodoro',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '番茄钟',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计取舍 ——
   *      ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / idea 同一条理由）：
   *         它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   *      ② ⭐ `task_id` + `task_source` **成对出现**（照 `idea_items` 那套）：日常任务与项目任务
   *         是**两张表**、id 都从 1 开始 ⇒ 只记 id 会把「日常任务 3」与「某项目任务 3」判成同一件事。
   *         它是**单向溯源列**（写在番茄钟侧），任务表**一个字都不改**（方案 §三）。
   *      ③ ⚠️ `date`（归属日）**取开始那一刻**：跨零点的一次专注只算一天，⛔ 不拆两条
   *         （方案 §三）—— 统计口径必须唯一，否则「今日 / 本周」两处会各算各的。
   *
   * @param {string} n - 表名（重建时是临时名）
   * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
   * @returns {string} 该表的 `CREATE TABLE` 语句
   */
  tables: {
    /**
     * 功能：生成 `time_pomodoro_sessions` 表的建表语句 —— 一次专注 / 一次放弃。
     *
     * 说明：时间列一律 `INTEGER`（**epoch 毫秒**）而不是文本：本表要按秒算差，
     *      而项目里那些文本时间戳（`YYYY-MM-DD HH:MM:SS`）只到秒、且要先 `Date` 解析才能做减法。
     *      ⚠️ `date` 仍然是文本（`YYYY-MM-DD`）—— 它是**归属日**，字典序即时间序，
     *      与 `time_timetable_day_rules.date` 同一口径，直接字符串比较就能分今天 / 本周。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_pomodoro_sessions: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,          -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        started_at      INTEGER NOT NULL,          -- ⭐ 服务端毫秒时刻 —— 真相之一（前端一切重算都从它出发）
        planned_seconds INTEGER NOT NULL,          -- ⭐ 计划时长（秒）—— 真相之二
        ended_at        INTEGER,                   -- 结束时（或放弃时）的服务端毫秒时刻；进行中为空
        status          TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','paused','completed','abandoned')),
        kind            TEXT NOT NULL DEFAULT 'focus'
                        CHECK (kind IN ('focus','short_break','long_break')),  -- ⭐ 0.8.32：这一条是专注 / 短休 / 长休里的哪一种
        paused_at       INTEGER,                   -- 「本次暂停」从哪一刻开始（空 = 没在暂停）
        paused_total    INTEGER,                   -- 累计暂停秒数（空 = 0；继续时把本次暂停时长累加进来）
        date            TEXT NOT NULL,             -- 归属日 YYYY-MM-DD，**取开始那一刻**（跨零点不拆两条）
        task_id         INTEGER,                   -- 可空；绑的任务（⭐ 单向溯源，任务表不改）
        task_source     TEXT CHECK (task_source IS NULL OR task_source IN ('daily','project'))
      );`,

    /**
     * 功能：生成 `time_pomodoro_prefs` 表的建表语句 —— 每账号一行的**时长偏好**。
     *
     * 说明：⭐ 时长偏好**住模块自己的表**，⛔ 不加 `users` 列（方案 §三 / 铁律 11）：
     *      `users.hide_*` 只承担「这个功能显不显示」这一件事，而 25 / 5 / 15 / 4 是**这个功能自己的**
     *      运行参数，跨模块改表属越界。
     *      ⚠️ 区间校验（`focus_min` 5~120 / `break_min` 1~30 / `long_break_min` 5~60 /
     *      `rounds_before_long` 2~8）**不在 DDL 里**，而在 `routes.js` 的入参层 ——
     *      越界一律 400、⛔ 不静默截断（决策 36；照 `ai` 模块 `checkCtxTurns` 的做法）。
     *      这里给 DEFAULT 只是「新库建行时的形状」，读侧的默认值常量住在 `store.js`。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_pomodoro_prefs: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL,
        focus_min          INTEGER NOT NULL DEFAULT 25,  -- 一个番茄多长（分钟）
        break_min          INTEGER NOT NULL DEFAULT 5,   -- 短休多长（分钟）—— 0.8.32 起真的会用它开一次休息
        long_break_min     INTEGER NOT NULL DEFAULT 15,  -- 长休多长（分钟）—— 同上
        rounds_before_long INTEGER NOT NULL DEFAULT 4,   -- 几轮之后进长休 —— 同上
        sound_on           INTEGER NOT NULL DEFAULT 0
                           CHECK (sound_on IN (0, 1)),   -- ⭐ 0.8.32：到点提示音（默认关，界面上可开）
        updated_at         INTEGER,
        UNIQUE(user_id)                                  -- ⭐ 一人一行（upsert 的落点）
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.7.5 新增），没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   *
   * @type {Object}
   */
  aliases: {
    // ⭐ 0.8.13：两张表随模块并版改名成 `time_pomodoro_*`（只改名字、不搬数据）。
    pomodoro_sessions: 'time_pomodoro_sessions',
    pomodoro_prefs: 'time_pomodoro_prefs',
  },

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：两张都是新表，老库上根本没有它们，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`，
   *      先例：收藏夹 / 硬件 / 密码库 / 对话 / AI / 灵感库六批都没升）。
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
   * 说明：⚠️⭐ **0.8.32 起这一档不再是空的** —— 上面那句「两张表都是新表」只对**0.7.5 之后
   *      从没装过本模块**的库成立；真机上这两张表自 0.7.5 起就存在，`CREATE TABLE IF NOT EXISTS`
   *      永远补不上后来加的列（0.7.1 的 `teamwork_reminder_prefs.builtin_name` 就是这么丢的）。
   *      ⇒ 新加的 `kind` 与 `sound_on` **必须**登记在这里，否则真机上「休息怎么都开不了、
   *      提示音开关点了没反应」，而且**一声不吭**。
   *      ⚠️ 类型串会原样拼进 `ALTER TABLE … ADD COLUMN`：带 `CHECK` 是**实测可行**的
   *      （SQLite 只禁 PRIMARY KEY / UNIQUE / 非常量默认值），与建表语句保持同一份约束。
   *      ⚠️ 补列**不升 `SCHEMA_VERSION`**（加列不升结构版本）。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    [
      'time_pomodoro_sessions',
      'kind',
      "TEXT NOT NULL DEFAULT 'focus' CHECK (kind IN ('focus','short_break','long_break'))",
    ],
    ['time_pomodoro_prefs', 'sound_on', 'INTEGER NOT NULL DEFAULT 0 CHECK (sound_on IN (0, 1))'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**两张表都刻意留空**。
   *
   * 说明：⚠️ 空数组不是漏写，是**安全属性**（同 `vault_meta` / `teamwork_reminder_prefs`）：
   *      本模块的每一次变化都走自己的专用原语（`insert` 通用原语 + `setPomodoroSession`），
   *      能表达「暂停必须带上暂停时刻」这类语义。放开通用更新等于把 `started_at` /
   *      `planned_seconds` 也变成可写面 —— 而它们是这条记录的真相。
   *      ⇒ `ttt/test/schema.test.js` 的 `SKIP_TABLES` 里两张表都整表豁免「逐列对齐」。
   *
   * @type {Object}
   */
  allowedCols: {
    time_pomodoro_sessions: [],
    time_pomodoro_prefs: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：两张都是「这个人自己的东西」（记录与设置），没有第二方 ⇒ 标准的
   *      「账号一走、数据全走」（用例 14）。
   *
   * @type {Array.<string>}
   */
  userScoped: ['time_pomodoro_sessions', 'time_pomodoro_prefs'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_pomodoro_user_started`：取「当前那一个还在跑的番茄」与「最近几条明细」都按它；
   *      · `idx_pomodoro_user_date`：今日 / 本周统计按**归属日**筛（`WHERE user_id=? AND date BETWEEN …`）。
   *      `time_pomodoro_prefs` 不建索引：它靠 `UNIQUE(user_id)` 自带的那一个，一人一行。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_pomodoro_user_started ON time_pomodoro_sessions(user_id, started_at)',
    'CREATE INDEX IF NOT EXISTS idx_pomodoro_user_date    ON time_pomodoro_sessions(user_id, date)',
  ],
};
