'use strict';
/**
 * modules/pomodoro/schema.js —— **番茄钟模块**
 * 功能：声明本模块**两张表** —— `time_pomodoro_sessions`（一次专注一行：开始时刻 + 计划时长 +
 * 结束时刻 + 状态 + 累计暂停）与 `time_pomodoro_prefs`（每账号一行：三个时长与轮次），
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
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
   * ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / idea 同一条理由）：
   * 它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   */
  tables: {
    /**
     * 功能：生成 `time_pomodoro_sessions` 表的建表语句 —— 一次专注 / 一次放弃。
     *
     * 说明：时间列一律 `INTEGER`（**epoch 毫秒**）而不是文本：本表要按秒算差，
     * 而项目里那些文本时间戳（`YYYY-MM-DD HH:MM:SS`）只到秒、且要先 `Date` 解析才能做减法。
     * `date` 仍然是文本（`YYYY-MM-DD`）—— 它是**归属日**，字典序即时间序，
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
     * `users.hide_*` 只承担「这个功能显不显示」这一件事，而 25 / 5 / 15 / 4 是**这个功能自己的**
     * 运行参数，跨模块改表属越界。
     * 区间校验（`focus_min` 5~120 / `break_min` 1~30 / `long_break_min` 5~60 /
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
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   */
  aliases: {
    // 两张表随模块并版改名成 `time_pomodoro_*`（只改名字、不搬数据）。
    pomodoro_sessions: 'time_pomodoro_sessions',
    pomodoro_prefs: 'time_pomodoro_prefs',
  },

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：两张都是新表，老库上根本没有它们，**不需要重建**；`createAll()` 会用
   * `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`，
   * 先例：收藏夹 / 硬件 / 密码库 / 对话 / AI / 灵感库六批都没升）。
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
   * 提示音开关点了没反应」，而且**一声不吭**。
   * 类型串会原样拼进 `ALTER TABLE … ADD COLUMN`：带 `CHECK` 是**实测可行**的
   * （SQLite 只禁 PRIMARY KEY / UNIQUE / 非常量默认值），与建表语句保持同一份约束。
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
   * 本模块的每一次变化都走自己的专用原语（`insert` 通用原语 + `setPomodoroSession`），
   * 能表达「暂停必须带上暂停时刻」这类语义。放开通用更新等于把 `started_at` /
   */
  allowedCols: {
    time_pomodoro_sessions: [],
    time_pomodoro_prefs: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：两张都是「这个人自己的东西」（记录与设置），没有第二方 ⇒ 标准的
   * 「账号一走、数据全走」（用例 14）。
   *
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
   * `idx_pomodoro_user_started`：取「当前那一个还在跑的番茄」与「最近几条明细」都按它；
   * `idx_pomodoro_user_date`：今日 / 本周统计按**归属日**筛（`WHERE user_id=? AND date BETWEEN …`）。
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_pomodoro_user_started ON time_pomodoro_sessions(user_id, started_at)',
    'CREATE INDEX IF NOT EXISTS idx_pomodoro_user_date    ON time_pomodoro_sessions(user_id, date)',
  ],
};
