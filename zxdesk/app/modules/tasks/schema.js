'use strict';
/**
 * modules/tasks/schema.js —— **任务板模块**：项目 / 项目任务 / 日常任务。
 * 功能：声明任务板模块的四张表 —— `projects`（项目）、`project_tasks`（项目任务）、
 * `daily_tasks`（日常任务）、`task_occurrences`（起：周期任务的打卡记录），
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/17-对话.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'tasks',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '任务板',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `projects` 表的建表语句 —— 项目（任务板左侧的容器，任务挂在它下面）。
     *
     * 说明：⚠️ `user_id` **故意不加外键**（父子关系都加了，见下）—— 它是「归属标签」，
     * 不是结构父节点；而老库完全可能 user_id=1 却还没有 users 行（内置 admin 由 server.js 的
     * `ensureBuiltinAdmin` 在 Store 构造**之后**才创建），加外键会把「首次启动」这条路径直接判死。
     */
    projects: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT,
        icon TEXT,
        status TEXT DEFAULT 'doing',
        sort_order INTEGER DEFAULT 0,
        -- ⭐⭐ 0.8.10 追加批（方案 31）：**这个项目是不是共享给成员**。
        --    ⚠️ 判权的**唯一依据**是成员关系（project_members 表），这一列只是「开没开共享」的闸门；
        --    ⛔ 任何地方都不许拿 user_id 或「是不是管理员」来判可见性（决策 31 / 63）。
        shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `project_tasks` 表的建表语句 —— 项目下的任务（含四象限标志、起止日期、完成时间）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    project_tasks: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'todo',
        completed_at TEXT,
        start_date TEXT,
        due_date TEXT,
        assignee TEXT,
        tag TEXT,
        important INTEGER DEFAULT 0 CHECK (important IS NULL OR important IN (0, 1)),
        urgent INTEGER DEFAULT 0 CHECK (urgent IS NULL OR urgent IN (0, 1)),
        from_message_id INTEGER,              -- ⭐ 0.4.4 从对话里的哪条消息建的（只写一次，见文件头）
        bookmark_id INTEGER,                  -- ⭐ 0.5.2 这条任务绑的网址（可改，见 allowedCols）
        -- ⭐⭐ 0.8.14（方案 34 §1.3）：任务类型这一维度的四列 —— 与日常任务**同一套**。
        --    ⚠️ 时刻**绝不并进 start_date / due_date**（服务端两处按字符串字典序比日期，
        --    合并会让「今天到期」被判成「还没到」而静默漏掉，见方案 §1.2）。
        task_kind TEXT DEFAULT 'plain',       -- plain（普通）/ window（窗口）/ cycle（周期）；老数据 = plain
        start_time TEXT,                      -- HH:MM；空 = 当天
        due_time TEXT,                        -- HH:MM；空 = 当天
        recur_rule TEXT,                      -- 周期的规范化 JSON（形状见方案 §1.3.1）
        sort_order INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `daily_tasks` 表的建表语句 —— 日常任务（不属于任何项目，直接归属账号）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    daily_tasks: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        important INTEGER DEFAULT 0 CHECK (important IS NULL OR important IN (0, 1)),
        urgent INTEGER DEFAULT 0 CHECK (urgent IS NULL OR urgent IN (0, 1)),
        from_message_id INTEGER,              -- ⭐ 0.4.4 同上（对话里那条消息的 id）
        bookmark_id INTEGER,                  -- ⭐ 0.5.2 同上（这条任务绑的网址）
        start_date TEXT,
        due_date TEXT,
        status TEXT DEFAULT 'todo',
        completed_at TEXT,
        -- ⭐⭐ 0.8.14（方案 34 §1.3）：任务类型这一维度的四列 —— 与项目任务**同一套**。
        --    ⚠️ 时刻**绝不并进 start_date / due_date**（理由见 project_tasks 那一段）。
        task_kind TEXT DEFAULT 'plain',       -- plain（普通）/ window（窗口）/ cycle（周期）；老数据 = plain
        start_time TEXT,                      -- HH:MM；空 = 当天
        due_time TEXT,                        -- HH:MM；空 = 当天
        recur_rule TEXT,                      -- 周期的规范化 JSON（形状见方案 §1.3.1）
        sort_order INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     *
     * 说明：⭐ 一行 = 「某个账号的某条任务的**某一期**已经完成」。
     */
    task_occurrences: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_source TEXT NOT NULL CHECK (task_source IN ('daily','project')),
        task_id INTEGER NOT NULL,
        period_key TEXT NOT NULL,
        done_at TEXT,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(user_id, task_source, task_id, period_key)
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射，供迁移在建表之前改名；本模块没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」，
   * 与「字段缺失」是两回事（后者会被 `assertModules` 判为契约不合格）。
   *
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   * @type {Array.<string>}
   */
  // 与另外三张表没有父子次序问题；放进来的唯一目的是「重建时它也在搬运算子里」。
  rebuildOrder: ['projects', 'project_tasks', 'daily_tasks', 'task_occurrences'],

  /**
   * 功能：重建搬数据时，对「NULL 与默认值语义完全相同」的列做归一化（并记进启动日志）。
   * @type {Object}
   */
  normalize: {
    projects: { user_id: '1' },
    project_tasks: { user_id: '1', important: '0', urgent: '0' },
    daily_tasks: { user_id: '1', important: '0', urgent: '0' },
  },

  /**
   * 功能：幂等补列清单（老库升级用），格式 `[表名, 列名, 类型]`。
   *
   * 说明：⚠️ `completed_at` 只靠这一条补列就够，**故意不推进 `SCHEMA_VERSION`** ——
   * `user_version` 的作用是「判断这次启动要不要重建表」，v5 的重建判据是
   * `schemaVersion < SCHEMA_VERSION`，所以一升版本号，**已经是最新的 v5 库也会被整份重建一遍**
   */
  ensureColumns: [
    ['project_tasks', 'completed_at', 'TEXT'],
    ['project_tasks', 'important', 'INTEGER DEFAULT 0'],
    ['project_tasks', 'urgent', 'INTEGER DEFAULT 0'],
    ['project_tasks', 'start_date', 'TEXT'],
    // 对话「消息 → 任务」的来源列（可空、只写一次）—— 老库靠这两行补上，
    // 新库由上面的 DDL 一步到位；两边都不动 SCHEMA_VERSION。
    ['project_tasks', 'from_message_id', 'INTEGER'],
    ['daily_tasks', 'start_date', 'TEXT'],
    ['daily_tasks', 'from_message_id', 'INTEGER'],
    // 「任务可绑定网址」：可空、随时可改，与上面的来源列同一手法 ——
    // 老库靠这两行补上，新库由 DDL 一步到位，两边都不动 SCHEMA_VERSION。
    ['project_tasks', 'bookmark_id', 'INTEGER'],
    ['daily_tasks', 'bookmark_id', 'INTEGER'],
    // 追加批：共享开关 —— **老库上唯一生效的路径**（DDL 里的新列对已存在的
    // `projects` 表一个字节都不动）。⚠️ 带 `NOT NULL DEFAULT 0`：老项目升级上来一律「不共享」——
    ['projects', 'shared', 'INTEGER NOT NULL DEFAULT 0'],
    // 共享看板的两个新列 —— 可空 INTEGER，**不动 SCHEMA_VERSION**。
    // `assignee_id`：**负责人账号 id**（旧的 `assignee` TEXT 列**一个字不动**、继续留着）——
    // 「负责人」必须从「名字」改成「账号 id」（名字可改、可手输，用来判权会断）；
    ['project_tasks', 'assignee_id', 'INTEGER'],
    ['project_tasks', 'creator_id', 'INTEGER'],
    // 任务类型四列 × 两张表 = 八条 —— **老库上唯一生效的路径**
    // （DDL 里的新列对已存在的表一个字节都不动）。⛔ 同样**不动 `SCHEMA_VERSION`**（仍 v5）——
    // 与 `important` / `urgent` / `start_date` / `bookmark_id` 的加法完全同类。
    ['project_tasks', 'task_kind', "TEXT DEFAULT 'plain'"],
    ['project_tasks', 'start_time', 'TEXT'],
    ['project_tasks', 'due_time', 'TEXT'],
    ['project_tasks', 'recur_rule', 'TEXT'],
    ['daily_tasks', 'task_kind', "TEXT DEFAULT 'plain'"],
    ['daily_tasks', 'start_time', 'TEXT'],
    ['daily_tasks', 'due_time', 'TEXT'],
    ['daily_tasks', 'recur_rule', 'TEXT'],
  ],

  /**
   *
   * 说明：以前这份白名单是 `db.js` 里一个 `switch (table)` 大表：加一张表要**跨文件**回去补 case，
   */
  allowedCols: {
    projects: ['name', 'description', 'color', 'icon', 'status', 'sort_order', 'shared', 'updated_at'],
    project_tasks: [
      'title',
      'description',
      'status',
      'completed_at',
      'start_date',
      'due_date',
      'assignee',
      // 负责人账号 id —— 成员可以改负责人（§丙-2-5），
      // 所以要进通用白名单。⚠️ `creator_id` **刻意不在这里**（谁建的这条任务只写一次，
      // 与 `from_message_id` 同一性质，见 schema.test.js 的 EXEMPT）。
      'assignee_id',
      'tag',
      'important',
      'urgent',
      // 任务绑的网址 —— ⚠️ `from_message_id` **不在这里**（「这条任务从哪条消息来的」
      // 只写一次，不该被一次 PUT 改掉）；而 `bookmark_id` 是用户随时可以改、也可以清掉的偏好，
      // 所以它在白名单里（「取消绑定」传 0）。
      'bookmark_id',
      // 任务类型的四个字段都**可以由一次 PUT 改**
      // （改类型 / 改时刻 / 换循环规则都是正常编辑）⇒ 两张表都进白名单。
      'task_kind',
      'start_time',
      'due_time',
      'recur_rule',
      'sort_order',
      'updated_at',
    ],
    daily_tasks: [
      'title',
      'content',
      'important',
      'urgent',
      'bookmark_id',
      'start_date',
      'due_date',
      'status',
      'completed_at',
      // 同 project_tasks —— 四个字段都可由一次 PUT 改。
      'task_kind',
      'start_time',
      'due_time',
      'recur_rule',
      'sort_order',
      'updated_at',
    ],
    // `task_occurrences` **刻意留空 `allowedCols`** ——
    // 打卡记录只有「打上 / 取消」两种动作（走 `occurrences.js` 的专用原语），
    // 没有「通用改一行」这个业务；放开它等于让一次 PUT 就能改掉「哪一期、谁、什么时候打的」。
    task_occurrences: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**（本模块三张表都带）。
   *
   * （`project_members` / `task_reports` / `project_comments` / `project_files`）
   * 与它们的 `userScoped` 登记**一并搬进 `modules/teamwork`**（判据与表同处一个模块）。
   * 本模块只管自己这三张表 —— 删账号时它们随 `user_id` 清空。
   */
  userScoped: [
    'projects',
    'project_tasks',
    'daily_tasks',
    // 打卡记录也带 `user_id` ⇒ **必须**登记。
    'task_occurrences',
  ],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`（v5 索引体检删掉的那几个）。
   * @type {Array.<string>}
   */
  legacyIndexes: ['idx_ptasks_date_range', 'idx_dtasks_date_range', 'idx_dtasks_user_status'],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明：⭐ v5 索引体检结论（用真数据量跑 `EXPLAIN QUERY PLAN` 实测，不是推测）——
   * 删 `idx_ptasks_date_range` / `idx_dtasks_date_range`：**没有任何查询选中过它们**。
   * 待办查询是 `user_id=? AND status!='done' AND due_date>=? AND COALESCE(start_date,due_date)<=?`，
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_projects_user_sort ON projects(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ptasks_project     ON project_tasks(project_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ptasks_user_status ON project_tasks(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_dtasks_user_sort   ON daily_tasks(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ptasks_from_msg    ON project_tasks(user_id, from_message_id)',
    'CREATE INDEX IF NOT EXISTS idx_dtasks_from_msg    ON daily_tasks(user_id, from_message_id)',
    // 打卡记录的两条索引 ——
    // `(user_id, task_source, task_id)`：看板渲染「这条任务的每一期打卡了没有」，
    // `(user_id, period_key)`：按「哪一期」回查（本期是否已打卡、删任务时按 id 清）。
    'CREATE INDEX IF NOT EXISTS idx_occ_user_task      ON task_occurrences(user_id, task_source, task_id)',
    'CREATE INDEX IF NOT EXISTS idx_occ_user_period    ON task_occurrences(user_id, period_key)',
  ],
};
