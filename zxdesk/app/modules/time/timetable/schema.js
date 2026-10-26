'use strict';
/**
 * modules/timetable/schema.js —— **课表模块**：学期 / 时段块 / 逐节时间 / 课程 / 课次。
 *
 * 功能：声明课表模块的 9 张表 —— `time_timetable_terms`（学期）、`time_timetable_blocks`（时段块）、
 *      `time_timetable_periods`（逐节时间）、`time_timetable_courses`（课程）、`time_timetable_sessions`（课次）、
 *      `time_timetable_adjustments`（单次调课 / 停课）、
 *      ⭐ `time_timetable_day_rules`（**按天**的假期调休 / 停课，0.6.2 新增），
 *      ⭐ 以及两张**随应用发布的内置模板表**：`time_timetable_school_schedules`（内置作息表）
 *      与 `time_timetable_school_grids`（内置课程表 / 课表版式），
 *      并给出 0.1.2 改名迁移的别名表、重建顺序、归一化规则、补列清单、`_update()` 列白名单、
 *      级联清空清单与索引语句。
 *
 * ⚠️ 表名一律带 `timetable_` 前缀（0.1.2 起）：课表是**后加进来的独立模块**，
 *    前缀让它在 `.tables` 里一眼分组，也为将来继续加模块立下规矩。
 *    ⚠️ **前缀用下划线，绝不用连字符**：`ClassSchedule-terms` 会被 SQL 解析成
 *    「`ClassSchedule` 减 `terms`」，每次引用都得写双引号，漏一个就是语法错误。
 *
 * ⭐ 0.3.5 起本模块有**两种性质完全不同**的表，别混：
 *    · 前 7 张是**用户数据**（都带 `user_id`，进 `userScoped` / 备份 / 个人导入）；
 *    · 后 2 张是**内置模板数据**（没有 `user_id`，随应用发布，启动时自动播种，见各自的说明）。
 *
 * ⚠️ 模块契约见 core.js 的说明。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/schema/timetable.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 表结构从此归这个目录所有。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.8.52
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
     *      改块时整份重写）。加 `ON DELETE SET NULL` 只会在重建时把「历史遗留的悬空指针」变成迁移失败，
     *      而悬空指针只影响一次分组渲染（`blockOf` 已经容错），代价与收益不成比例。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      （`weeks` 字段罩住 1-16 周），本身没有「某一周例外」的表达能力。于是
     *      「这周三的课挪到周五」只能另存一行 —— 就是本表。
     *      ⚠️ 与之相对，「**此后全部**改时间」**不走这张表**：那是把 `weeks` 劈成两半
     *      （`date-util.splitWeeks`），改完就是两条普通课次，渲染层不需要知道曾经调过课。
     *      ⚠️ **只存 `week_no`、绝不存日期**：存了日期，用户一改学期的「第 1 周星期一」，
     *      日期与周次立刻对不上 —— 那是自找的漂移。日期在渲染时按学期开始日现算。
     *      ⭐ `to_week_no`（跨周调课「调课应该要能选择调到那一周」）：**目标周**。
     *      为空 = 与 `week_no` 同周（老行为：换时间 / 换教室）；有值且不同 = **跨周调课** ——
     *      源周那一格变灰并写明去向，目标周多出这一次课。两处都不存日期，理由同上。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     * 功能：生成 `time_timetable_day_rules` 表的建表语句 —— ⭐ **按天的假期调休 / 停课**（0.6.2）。
     *
     * 说明：⭐ 要的「假期调休」：学校放假通知那种**按公历日期**的调法 ——
     *      例：9 月 20 日（周日）补 10 月 6 日（周二）整天的课；10 月 10 日（周六）补 10 月 7 日（周三）。
     *      **纯手动录入**（各校通知不一样，不自动识别）。两条规则：
     *      `swap` = 这一天按另一天的课表上课（`to_date` 指向被补的那天）；`off` = 这一天整体停课。
     *
     * ⚠️ 与 `time_timetable_adjustments` **正交、不许合并**：那张表是**按课次**的（某一次课挪走 / 停掉，
     *    身份是 `(session_id, week_no)`），是「老师临时调的某一节」；本表是**按天**的（身份是公历日期），
     *    是「学校通知的一整天怎么上」。同一天可以既有调休、某一节又有单独调整，两层各算各的。
     * ⚠️ 本表**存公历日期**（与 `time_timetable_adjustments` 刻意只存 `week_no` 相反）：调休通知写的就是
     *    「几月几号补几月几号」，日期就是它的身份；用户改学期开学日也不该让调休跟着漂。
     * ⚠️ `date` 唯一（一个学期里一天只许有一条规则）—— 用**唯一索引**而不是表级 UNIQUE：
     *    老库补表走的是这条路，两侧同一套。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     * 功能：生成 `time_timetable_day_notes` 表的建表语句 —— ⭐ **本节备注**（那一天那节课的备注，0.7.1）。
     *
     * 说明：⭐ **这是 的修订**。原先「课堂备注（这节课）」挂在**课次**上，
     *      而课次是**按周重复**的（周三第 3-4 节 · 1-16 周）⇒ 写一条，这 16 周**每周那天都显示**
     *      （当年是刻意选的，因为当局者把它理解为「这门课这一节每次都要做的事」）。
     *      现在改要「**只要那一天显示**」⇒ 身份必须是 `(课次, 公历日期)`；
     *      课次自己**没有**这个表达能力，所以另开这张表 —— 正是 原话里
     *      「真要做某一天那节课得另加一张按日期的表」那句话的落地。
     *
     * ⚠️ **存公历日期**（与 `time_timetable_day_rules` 同理；与 `time_timetable_adjustments` 刻意只存
     *    `week_no` 相反）：用户写它时想的就是「3 月 5 号那节课」，改学期开学日不该让备注漂走。
     * ⚠️ 唯一性 `(session_id, date)`：一节课一天只有一条备注。用**唯一索引**而不是表级 UNIQUE
     *    —— 老库补表走的就是索引那条路，两侧同一套（同 `idx_tt_dayrule_term`）。
     * ⚠️ 旧列 `time_timetable_sessions.remark` 与 `time_timetable_courses.remark` **都保留不动**
     *    （不迁移、不改写用户数据，铁律 18）；但**课堂备注那一个从此不再有界面入口** ——
     *    它的语义已被本表取代（旧值仍在库里，见 `06-课表.md`）。
     *
     * ⭐ **0.7.2：`task_id` —— 与「日常任务」的绑定**（
     *    「这个任务要和备注绑定，他们本质是同一个，做一个 id 绑定，修改要同步」）。
     *    写入由 `setDayNote()` 负责（建 / 改任务之后把 id 回填到这一列），**界面不直接填它**。
     *    ⚠️ 它**必须同时进 `ensureColumns`**：只改建表语句的话**老库永远拿不到这一列**，
     *    而错误形态是「绑定悄悄失效」（写进去的 task_id 被静默丢掉）——见 `06-课表.md` 那条通例。
     *    ⚠️ 它指向**日常任务**（`daily_tasks`）。任务被删掉后会留下一个悬空 id，
     *    读侧一律当成「没绑定」处理（`syncDayNoteFromTask()` 查不到就什么都不做），
     *    下次再改这条备注时按「无绑定」重建 —— 不做级联删除（两边的删除路径都要互相知道，太脆）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      「选一所高校模板建课表」时，这个学期的作息就是从这里读出来的。
     *
     * ⚠️ **没有 `user_id`，也不属于任何账号** —— 它是**随应用发布的内置数据**，
     *    描述的是「这所学校本来长什么样」，不是谁的课表；因此：
     *    · 不进 `userScoped`（删账号不该动它）；· 不进备份 / 个人导入（每台机器启动时自动播种）；
     *    · 不进 `allowedCols`（没有「改内置数据」这个需求，要改就改数据源文件重发版）。
     *    数据源是 `modules/timetable/lib/school-templates.js`，启动时由 `seedSchoolTemplates()` 同步进来
     *    （**可扩展**：加一所学校 = 在数据源里加一项，不动任何别的文件）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     *      **里面没有、也不许有任何课程数据** —— 它只说「这所学校的课表长什么样」：
     *      一天画几行（`row_labels`）、每行罩着哪几节（`row_periods`）、默认学期周数、
     *      以及节假日前一天下午是否提前。选模板建出来的学期，课表是**空的**。
     *
     * ⚠️ `row_labels` / `row_periods` 是 JSON 文本：它们是**有序的一整块**，
     *    拆列后顺序仍只能靠数组表达，再拆一张表只多一层 join、换不来任何东西。
     * ⚠️ 与 `time_timetable_school_schedules` 同样的三条：无 `user_id`、不进 `userScoped` /
     *    备份 / 个人导入、不进 `allowedCols`（见上一张表的说明）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
   * 功能：0.1.2 的改名迁移映射 —— 旧表名 → 现表名（`terms` → `time_timetable_terms` 等 5 条）。
   *
   * 说明：⚠️ 必须在**建表之前**执行 —— 否则 `CREATE TABLE IF NOT EXISTS` 会先造出 5 张空的新表，
   *      老数据就永远搬不过来了（而且表面上一切正常，只是「课表全没了」）。
   *
   * @type {Object}
   */
  aliases: {
    // ⭐ 0.8.13：**这 5 张各写两对** —— 「更早的名字 → 新名」＋「0.1.2 起的名字 → 新名」。
    //    ⚠️ 只写「当前名 → 新名」那一对是**不行的**：0.1.1 时代的老库里表还叫 `terms`，
    //    本轮启动会把 `terms` 先改成 `timetable_terms`，而同一条「`timetable_terms` → 新名」
    //    在动手之前就已经判过（当时目标名还不存在 ⇒ 被跳过）⇒ 这一轮停在 `timetable_terms`，
    //    而新代码查的是 `time_timetable_terms` ⇒ `CREATE TABLE IF NOT EXISTS` 会建出一张**空表**，
    //    用户看到「**课表全没了**」（数据仍在库里，只是读不到）。
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
    // 下面 5 张是 0.2.3 / 0.6.2 / 0.7.1 / 0.3.5 新增的，只有「当前名 → 新名」一对
    //（这批名字没有 0.1.2 那批的老名字）
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
    // ⭐ 0.7.1：按日期的备注表也带外键（→ terms / sessions）⇒ 必须排在它的父表之后
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
   * 说明：⭐ 0.2.3 起不再是空的 —— 逐节作息与两处备注带来了 4 个新列（**全部可空 /
   *      带 DEFAULT**，所以走 `ALTER TABLE ADD COLUMN` 就够，**刻意不升结构版本号**：
   *      升版本号会让已经最新的库也整份重建，风险远大于收益，理由同 `tasks.js` 那几条）。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['time_timetable_terms', 'holiday_advance_minutes', 'INTEGER DEFAULT 0'],
    ['time_timetable_terms', 'holiday_pm_from', 'TEXT'],
    ['time_timetable_courses', 'remark', 'TEXT'],
    ['time_timetable_sessions', 'remark', 'TEXT'],
    // ⭐ 0.7.2：本节备注 →「日常任务」的绑定 id。**可空**（老数据、以及没建任务的那种备注）。
    //    ⚠️ 建表语句里也加了同一列 —— 新库走 DDL、老库走这里，**两处必须同时有**，
    //    只改一处的话老库拿不到它，「绑定」会静默失效。
    ['time_timetable_day_notes', 'task_id', 'INTEGER'],
    // ⭐ 跨周调课：目标周。**可空**（老数据与「同周换时间」都是 NULL）⇒ `ALTER TABLE ADD COLUMN`
    //    就够；⚠️ 建表语句里也加了同一列 —— 新库走 DDL、老库走这里，**两处必须同时有**。
    ['time_timetable_adjustments', 'to_week_no', 'INTEGER'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— **从 0.1.3 起由本模块自报**（理由见 tasks.js 同名字段）。
   *
   * 说明：⚠️ **六张表一个都不能少**（这是当年真实踩过的坑）：`db.js` 的 `_update` 拿不到白名单时
   *      `setKeys` 为空 → 直接 `return false` → 路由层当成「资源不存在」回 404，
   *      表现为「教室改不了、课次删不动，界面还一声不吭」。`ttt/test/timetable.test.js`
   *      对每张表各做一次真实 `_update` 钉住这件事。
   *      ⚠️ 排除 `id` / `user_id` / `term_id` / `course_id` / `session_id` / `created_at`：
   *      归属与父子关系**不许靠 PUT 改**（「此后全部」改课次要搬调整行时走专门的
   *      `repointAdjustments` 原语，而不是放宽这里的白名单）。
   *      ⚠️ `time_timetable_blocks` / `time_timetable_periods` 这两张表**没有 `updated_at` 列**（它们的写入是整份替换），
   *      所以白名单里也没有它 —— 有它会让 `_update` 拼出引用不存在列的 SQL。
   *
   * @type {Object}
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
    // ⭐ 0.6.2 假期调休：白名单给的是**状态列**；`term_id` 不在里面 —— 学期归属不许靠 PUT 改
    //    （同上一条的理由）。录入 / 改规则走模块自己的 `setDayRule()`，不经过通用 `_update()`。
    time_timetable_day_rules: ['date', 'kind', 'to_date', 'note', 'updated_at'],
    // ⭐ 0.7.1 按日期的备注：同样只放**内容列**。`session_id` / `date` 是这条记录的**身份**
    //    （唯一键 `(session_id, date)`），靠 PUT 改身份等于把一条备注搬到另一节课 / 另一天，
    //    所以它们不进白名单 —— 写入只走模块自己的 `setDayNote()`（内部就是 upsert）。
    // ⭐ 0.7.2：`task_id`（绑定哪条日常任务）**要进白名单** —— `setDayNote()` 就是靠通用
    //    `_update()` 把建/改任务之后拿到的 id 回填到这一列；不给它，回填会被静默丢掉
    //    （`_update` 的白名单外字段直接不写），表现成「任务建了、但下次改备注又建一条」。
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
    // ⭐ 0.6.2 假期调休：查询口只有一个 —— 「这个学期有哪些按天的规则」；`date` 唯一
    //    （一天只许一条规则）。放索引不放进建表语句：老库补表只有索引这条路两侧都走。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tt_dayrule_term ON time_timetable_day_rules(user_id, term_id, date)',
    // ⭐ 0.7.1 按日期的备注：两个查询口 —— ① 「某一天某节课的备注」（upsert 靠它做唯一键）；
    //    ② 「这个学期有哪些备注」（一次把要显示的那些取出来）。唯一的是 ①。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tt_daynote_session ON time_timetable_day_notes(session_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_tt_daynote_term ON time_timetable_day_notes(user_id, term_id, date)',
    // ⭐ 内置高校模板（随应用发布的只读数据，没有 user_id）—— 查询口只有一个：
    //    「按学校取这一所的作息 / 版式」，所以索引就打头 school_code。
    'CREATE INDEX IF NOT EXISTS idx_tt_sch_sched ON time_timetable_school_schedules(school_code, campus, period_index)',
    'CREATE INDEX IF NOT EXISTS idx_tt_sch_grid  ON time_timetable_school_grids(school_code, campus)',
  ],
};
