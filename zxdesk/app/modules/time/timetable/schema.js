'use strict';
/**
 * modules/timetable/schema.js —— **课表模块**：学期 / 时段块 / 逐节时间 / 课程 / 课次。
 * 功能：声明课表模块的 9 张表 —— `time_timetable_terms`（学期）、`time_timetable_blocks`（时段块）、
 * `time_timetable_periods`（逐节时间）、`time_timetable_courses`（课程）、`time_timetable_sessions`（课次）、
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/06-课表.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'timetable',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '课表',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `time_timetable_terms` 表的建表语句 —— 学期（课表所有数据的顶层归属，其余 4 张表都挂在它下面）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_timetable_terms: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        start_monday TEXT,
        total_weeks INTEGER DEFAULT 17 CHECK (total_weeks IS NULL OR total_weeks >= 1),
        remark TEXT,
        meta TEXT,
        holiday_advance_minutes INTEGER DEFAULT 0 CHECK (holiday_advance_minutes IS NULL OR holiday_advance_minutes >= 0),
        holiday_pm_from TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `time_timetable_blocks` 表的建表语句 —— 时段块（第几节到第几节为一「块」，含上课/课间时长）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_timetable_blocks: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        label TEXT,
        sort_order INTEGER DEFAULT 0,
        start_time TEXT,
        end_time TEXT,
        period_count INTEGER DEFAULT 0 CHECK (period_count IS NULL OR period_count >= 0),
        class_minutes INTEGER DEFAULT 45 CHECK (class_minutes IS NULL OR class_minutes >= 1),
        break_minutes INTEGER DEFAULT 5 CHECK (break_minutes IS NULL OR break_minutes >= 0)
      );`,
    /**
     * 功能：生成 `time_timetable_periods` 表的建表语句 —— 逐节时间（由时段块生成、随后可逐节微调）。
     *
     * 说明：⚠️ `block_id` **故意不加外键** —— 它是纯派生缓存的指针（periods 由时段块生成、随后可逐节微调，
     * 改块时整份重写）。加 `ON DELETE SET NULL` 只会在重建时把「历史遗留的悬空指针」变成迁移失败，
     *
     */
    time_timetable_periods: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        index_no INTEGER NOT NULL,
        block_id INTEGER,
        start_time TEXT,
        end_time TEXT
      );`,
    /**
     * 功能：生成 `time_timetable_courses` 表的建表语句 —— 课程（名称 / 简称 / 教师 / 颜色）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_timetable_courses: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        short_name TEXT,
        teacher TEXT,
        color TEXT,
        remark TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `time_timetable_sessions` 表的建表语句 —— 课次（某门课在某天第几节、上哪些周、在哪间教室）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_timetable_sessions: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        course_id INTEGER NOT NULL REFERENCES time_timetable_courses(id) ON DELETE CASCADE,
        weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
        period_start INTEGER,
        period_end INTEGER,
        weeks TEXT,
        room TEXT,
        teacher TEXT,
        remark TEXT,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `time_timetable_adjustments` 表的建表语句 —— **单次调课 / 停课**（只影响某一周的那一次课）。
     *
     * 说明：⭐ 为什么需要这张表：课次（`time_timetable_sessions`）是**按周重复**的一条记录
     * （`weeks` 字段罩住 1-16 周），本身没有「某一周例外」的表达能力。于是
     * 「这周三的课挪到周五」只能另存一行 —— 就是本表。
     */
    time_timetable_adjustments: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES time_timetable_sessions(id) ON DELETE CASCADE,
        week_no INTEGER NOT NULL CHECK (week_no >= 1),
        to_week_no INTEGER CHECK (to_week_no IS NULL OR to_week_no >= 1),
        kind TEXT NOT NULL DEFAULT 'move' CHECK (kind IN ('move', 'cancel')),
        to_weekday INTEGER CHECK (to_weekday IS NULL OR (to_weekday BETWEEN 1 AND 7)),
        to_period_start INTEGER,
        to_period_end INTEGER,
        to_room TEXT,
        note TEXT,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     *
     * 说明：⭐ 要的「假期调休」：学校放假通知那种**按公历日期**的调法 ——
     */
    time_timetable_day_rules: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'off' CHECK (kind IN ('swap', 'off')),
        to_date TEXT,
        note TEXT,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     *
     * 说明：⭐ **这是 的修订**。原先「课堂备注（这节课）」挂在**课次**上，
     */
    time_timetable_day_notes: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        term_id INTEGER NOT NULL REFERENCES time_timetable_terms(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES time_timetable_sessions(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        note TEXT,
        task_id INTEGER,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `time_timetable_school_schedules` 表的建表语句 —— ⭐ **内置作息表**（高校作息模板的逐节时间）。
     *
     * 说明：⭐ 一行 = 一所学校的某一个变体里的**某一节**（第 1 节 08:30–09:15 一行、第 2 节一行……）。
     * 「选一所高校模板建课表」时，这个学期的作息就是从这里读出来的。
     *
     */
    time_timetable_school_schedules: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_code TEXT NOT NULL,
        school_name TEXT NOT NULL,
        campus TEXT NOT NULL DEFAULT '',
        campus_label TEXT,
        day_part TEXT,
        period_index INTEGER NOT NULL CHECK (period_index >= 1),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        class_minutes INTEGER DEFAULT 45 CHECK (class_minutes IS NULL OR class_minutes >= 1),
        break_minutes INTEGER DEFAULT 5 CHECK (break_minutes IS NULL OR break_minutes >= 0),
        source TEXT,
        note TEXT,
        sort_order INTEGER DEFAULT 0
      );`,
    /**
     * 功能：生成 `time_timetable_school_grids` 表的建表语句 —— ⭐ **内置课程表**（高校课表版式模板）。
     *
     * 说明：⭐ 一行 = 一所学校的一个变体（也就是界面上**一个可选模板**），
     * 一天画几行（`row_labels`）、每行罩着哪几节（`row_periods`）、默认学期周数、
     * 以及节假日前一天下午是否提前。选模板建出来的学期，课表是**空的**。
     */
    time_timetable_school_grids: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_code TEXT NOT NULL,
        school_name TEXT NOT NULL,
        campus TEXT NOT NULL DEFAULT '',
        campus_label TEXT,
        name TEXT NOT NULL,
        row_mode TEXT DEFAULT 'block' CHECK (row_mode IS NULL OR row_mode IN ('block', 'big')),
        row_labels TEXT,
        row_periods TEXT,
        total_weeks INTEGER DEFAULT 17 CHECK (total_weeks IS NULL OR total_weeks >= 1),
        weekdays TEXT DEFAULT '1,2,3,4,5,6,7',
        holiday_advance_minutes INTEGER DEFAULT 0 CHECK (holiday_advance_minutes IS NULL OR holiday_advance_minutes >= 0),
        holiday_pm_from TEXT,
        source TEXT,
        note TEXT,
        sort_order INTEGER DEFAULT 0
      );`,
  },

  /**
   *
   * 老数据就永远搬不过来了（而且表面上一切正常，只是「课表全没了」）。
   */
  aliases: {
    // 本轮启动会把 `terms` 先改成 `timetable_terms`，而同一条「`timetable_terms` → 新名」
    // 在动手之前就已经判过（当时目标名还不存在 ⇒ 被跳过）⇒ 这一轮停在 `timetable_terms`，
    // 而新代码查的是 `time_timetable_terms` ⇒ `CREATE TABLE IF NOT EXISTS` 会建出一张**空表**，
    terms: 'time_timetable_terms',
    timetable_terms: 'time_timetable_terms',
    period_blocks: 'time_timetable_blocks',
    timetable_blocks: 'time_timetable_blocks',
    periods: 'time_timetable_periods',
    timetable_periods: 'time_timetable_periods',
    courses: 'time_timetable_courses',
    timetable_courses: 'time_timetable_courses',
    course_sessions: 'time_timetable_sessions',
    timetable_sessions: 'time_timetable_sessions',
    timetable_adjustments: 'time_timetable_adjustments',
    timetable_day_rules: 'time_timetable_day_rules',
    timetable_day_notes: 'time_timetable_day_notes',
    timetable_school_schedules: 'time_timetable_school_schedules',
    timetable_school_grids: 'time_timetable_school_grids',
  },

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：重建用 DROP + RENAME，父表必须存在于子表改名的瞬间。
   *
   * @type {Array.<string>}
   */
  rebuildOrder: [
    'time_timetable_terms',
    'time_timetable_blocks',
    'time_timetable_periods',
    'time_timetable_courses',
    'time_timetable_sessions',
    'time_timetable_adjustments',
    'time_timetable_day_rules',
    // 按日期的备注表也带外键（→ terms / sessions）⇒ 必须排在它的父表之后
    'time_timetable_day_notes',
  ],

  /**
   * 功能：重建搬数据时，对「NULL 与默认值语义完全相同」的列做归一化（本模块只有 `user_id`）。
   * @type {Object}
   */
  normalize: {
    time_timetable_terms: { user_id: '1' },
    time_timetable_blocks: { user_id: '1' },
    time_timetable_periods: { user_id: '1' },
    time_timetable_courses: { user_id: '1' },
    time_timetable_sessions: { user_id: '1' },
    time_timetable_adjustments: { user_id: '1' },
    time_timetable_day_rules: { user_id: '1' },
    time_timetable_day_notes: { user_id: '1' },
  },

  /**
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   *
   * 带 DEFAULT**，所以走 `ALTER TABLE ADD COLUMN` 就够，**刻意不升结构版本号**：
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['time_timetable_terms', 'holiday_advance_minutes', 'INTEGER DEFAULT 0'],
    ['time_timetable_terms', 'holiday_pm_from', 'TEXT'],
    ['time_timetable_courses', 'remark', 'TEXT'],
    ['time_timetable_sessions', 'remark', 'TEXT'],
    // 本节备注 →「日常任务」的绑定 id。**可空**（老数据、以及没建任务的那种备注）。
    // 建表语句里也加了同一列 —— 新库走 DDL、老库走这里，**两处必须同时有**，
    // 只改一处的话老库拿不到它，「绑定」会静默失效。
    ['time_timetable_day_notes', 'task_id', 'INTEGER'],
    // 跨周调课：目标周。**可空**（老数据与「同周换时间」都是 NULL）⇒ `ALTER TABLE ADD COLUMN`
    // 就够；⚠️ 建表语句里也加了同一列 —— 新库走 DDL、老库走这里，**两处必须同时有**。
    ['time_timetable_adjustments', 'to_week_no', 'INTEGER'],
  ],

  /**
   *
   * `setKeys` 为空 → 直接 `return false` → 路由层当成「资源不存在」回 404，
   */
  allowedCols: {
    time_timetable_terms: [
      'name',
      'start_monday',
      'total_weeks',
      'remark',
      'meta',
      'holiday_advance_minutes',
      'holiday_pm_from',
      'sort_order',
      'updated_at',
    ],
    time_timetable_blocks: [
      'label',
      'sort_order',
      'start_time',
      'end_time',
      'period_count',
      'class_minutes',
      'break_minutes',
    ],
    time_timetable_periods: ['index_no', 'block_id', 'start_time', 'end_time'],
    time_timetable_courses: ['name', 'short_name', 'teacher', 'color', 'remark', 'sort_order', 'updated_at'],
    time_timetable_sessions: ['weekday', 'period_start', 'period_end', 'weeks', 'room', 'teacher', 'remark', 'updated_at'],
    time_timetable_adjustments: [
      'week_no',
      'to_week_no',
      'kind',
      'to_weekday',
      'to_period_start',
      'to_period_end',
      'to_room',
      'note',
      'updated_at',
    ],
    // （同上一条的理由）。录入 / 改规则走模块自己的 `setDayRule()`，不经过通用 `_update()`。
    time_timetable_day_rules: ['date', 'kind', 'to_date', 'note', 'updated_at'],
    // 按日期的备注：同样只放**内容列**。`session_id` / `date` 是这条记录的**身份**
    // （唯一键 `(session_id, date)`），靠 PUT 改身份等于把一条备注搬到另一节课 / 另一天，
    // 所以它们不进白名单 —— 写入只走模块自己的 `setDayNote()`（内部就是 upsert）。
    time_timetable_day_notes: ['note', 'task_id', 'updated_at'],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**（本模块七张表都带）。
   * @type {Array.<string>}
   */
  userScoped: [
    'time_timetable_terms',
    'time_timetable_blocks',
    'time_timetable_periods',
    'time_timetable_courses',
    'time_timetable_sessions',
    'time_timetable_adjustments',
    'time_timetable_day_rules',
    'time_timetable_day_notes',
  ],

  /**
   * 功能：改名前的索引名，启动时显式 `DROP`。
   *
   * 说明：表重建时本来也会跟着删，这里显式 DROP 是保险 —— 让「改名 + 不重建」的路径也干净。
   *
   * @type {Array.<string>}
   */
  legacyIndexes: [
    'idx_terms_user',
    'idx_blocks_user_term',
    'idx_periods_user_term',
    'idx_courses_user_term',
    'idx_sessions_user_term',
    'idx_sessions_course',
  ],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明：所有查询都带 `user_id` + `term_id`（或 `course_id`），索引一律以 `user_id` 打头。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_tt_terms_user     ON time_timetable_terms(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_tt_blocks_term    ON time_timetable_blocks(user_id, term_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_tt_periods_term   ON time_timetable_periods(user_id, term_id, index_no)',
    'CREATE INDEX IF NOT EXISTS idx_tt_courses_term   ON time_timetable_courses(user_id, term_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_tt_sessions_term  ON time_timetable_sessions(user_id, term_id, weekday, period_start)',
    'CREATE INDEX IF NOT EXISTS idx_tt_sessions_course ON time_timetable_sessions(user_id, course_id)',
    // 单次调课：两个查询口 —— 「这个学期这一周有哪些调整」与「这条课次被调过哪几周」
    'CREATE INDEX IF NOT EXISTS idx_tt_adjust_term    ON time_timetable_adjustments(user_id, term_id, week_no)',
    'CREATE INDEX IF NOT EXISTS idx_tt_adjust_session ON time_timetable_adjustments(user_id, session_id, week_no)',
    // 假期调休：查询口只有一个 —— 「这个学期有哪些按天的规则」；`date` 唯一
    // （一天只许一条规则）。放索引不放进建表语句：老库补表只有索引这条路两侧都走。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tt_dayrule_term ON time_timetable_day_rules(user_id, term_id, date)',
    // 按日期的备注：两个查询口 —— ① 「某一天某节课的备注」（upsert 靠它做唯一键）；
    // ② 「这个学期有哪些备注」（一次把要显示的那些取出来）。唯一的是 ①。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tt_daynote_session ON time_timetable_day_notes(session_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_tt_daynote_term ON time_timetable_day_notes(user_id, term_id, date)',
    // 内置高校模板（随应用发布的只读数据，没有 user_id）—— 查询口只有一个：
    // 「按学校取这一所的作息 / 版式」，所以索引就打头 school_code。
    'CREATE INDEX IF NOT EXISTS idx_tt_sch_sched ON time_timetable_school_schedules(school_code, campus, period_index)',
    'CREATE INDEX IF NOT EXISTS idx_tt_sch_grid  ON time_timetable_school_grids(school_code, campus)',
  ],
};
