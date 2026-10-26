'use strict';
/**
 * modules/tasks/schema.js —— **任务板模块**：项目 / 项目任务 / 日常任务。
 *
 * 功能：声明任务板模块的四张表 —— `projects`（项目）、`project_tasks`（项目任务）、
 *      `daily_tasks`（日常任务）、`task_occurrences`（⭐ 0.8.14 起：周期任务的打卡记录），
 *      并给出各自的 DDL 生成器、重建顺序、归一化规则、
 *      幂等补列清单、`_update()` 列白名单、级联清空清单与索引语句。
 *
 * 这是应用的主干（ZXDesk 本身就是任务板），所以表名不加前缀：
 * `projects` / `project_tasks` / `daily_tasks` 已经自解释。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/schema/tasks.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了本段说明、`@since`
 *    与下面两处**指向本模块内部**的相对说明；声明体一个字节没动。
 *    ⚠️ 至此 `store/schema/index.js` 的 `LEGACY_SCHEMA` 清空 —— 六个模块的表结构
 *    全部由各自的 `modules/<name>/schema.js` 声明（`schema.test.js` 与
 *    那份「抢表名」自检都在盯着）。
 *
 * ⭐ **0.4.4 加的 `from_message_id`（对话里那条消息 → 这条任务）** 是**单向溯源列**：
 *    它记「这条任务是从哪条消息建的」，只用来在**对话界面上**把「已添加到任务」那枚标记
 *    渲染回那条消息下面（`modules/teamwork/store.js` 的 `teamworkMessages()` 按当前页的消息 id 反查）。
 *    ⚠️ 为什么这个关联**必须存在任务这一侧、而不是消息那一侧**（两句话，别反过来改）：
 *    ① `teamwork_messages` 的一行是**两端共享**的 —— 把 task_id 写在那里，对方也会看到
 *       「已添加到任务」，甚至能点到我的任务（跨账号泄露，与「备注只写我这一行」同一类坑）；
 *       而任务表是**每个账号自己一份**的，存在这里对方在结构上就看不到。
 *    ② 任务被删掉时标记**自然消失**，不会留下指向空气的「已添加到任务」——
 *       挂在消息上就得处理悬空，并在删任务的每条路径上挂级联（本项目「最容易漏且漏了不报错」的一类）。
 *    ⚠️ 它是**写入时定死**的（不进 `allowedCols`，见 schema.test.js 的豁免清单）：
 *    任务是「从哪儿来的」这件事不该被一次 PUT 改掉，与 `bookmarks.source` 同一性质。
 *
 * ⚠️ 模块契约见 core.js 的说明。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.8.14
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
     *      不是结构父节点；而老库完全可能 user_id=1 却还没有 users 行（内置 admin 由 server.js 的
     *      `ensureBuiltinAdmin` 在 Store 构造**之后**才创建），加外键会把「首次启动」这条路径直接判死。
     *      账号删除的清空由 `userScoped` 保证（单一出处）。
     *      ⚠️ 也**故意不给 DEFAULT 1** —— 默认值会让「忘了传 user_id」从报错变成静默归到 1 号账号名下。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
     * 功能：生成 `task_occurrences` 表的建表语句 —— ⭐ 0.8.14**周期任务的打卡记录**。
     *
     * 说明：⭐ 一行 = 「某个账号的某条任务的**某一期**已经完成」。
     *      · ⚠️ `task_id` 必须与 `task_source` **成对**：日常任务与项目任务是**两张表**、
     *        id 各自从 1 开始，只记 id 认不出是哪张表（与 `idea_items.task_id + task_source`
     *        同一条理由， 在对话提醒的记账键上踩过）。
     *      · ⭐ `period_key` = 本期的**周期起点日期**（`YYYY-MM-DD`），它是「哪一期」的身份
     *        —— 与 `UNIQUE(user_id, task_source, task_id, period_key)` 一起保证**打卡幂等**
     *        （重复打卡不报错、也不写第二行）。
     *      · ⚠️ `task_id` **故意不加外键**：`daily_tasks` 与 `project_tasks` 是两张表，
     *        一列指不了两张；连带删除由两个后端的 `deleteDailyTask` / `deleteProjectTask` /
     *        `deleteProject` 各自补（照 teamwork 那批「协作数据连带清理」的形态）。
     *      · ⚠️ 本表**刻意不进个人备份**（方案 §1.4）：`task_id` 是「**这台机器上**的 id」，
     *        换台 NAS 导进来会指向另一条任务 —— 与 `idea_items.task_id` 刻意不搬同一条理由。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
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
   *      与「字段缺失」是两回事（后者会被 `assertModules` 判为契约不合格）。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   * @type {Array.<string>}
   */
  // ⚠️ `task_occurrences`（0.8.14 新表）**排在最后**：它没有外键（`task_id` 是普通 id），
  //    与另外三张表没有父子次序问题；放进来的唯一目的是「重建时它也在搬运算子里」。
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
   *      `user_version` 的作用是「判断这次启动要不要重建表」，v5 的重建判据是
   *      `schemaVersion < SCHEMA_VERSION`，所以一升版本号，**已经是最新的 v5 库也会被整份重建一遍**
   *      （DROP + 搬数据 + RENAME），只为加一个可空的列，风险远大于收益。
   *      加可空列本来就是 `ALTER TABLE ADD COLUMN` 的强项，永远不会丢数据 ——
   *      与当年 `important` / `urgent` / `start_date` 的加法完全同类。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['project_tasks', 'completed_at', 'TEXT'],
    ['project_tasks', 'important', 'INTEGER DEFAULT 0'],
    ['project_tasks', 'urgent', 'INTEGER DEFAULT 0'],
    ['project_tasks', 'start_date', 'TEXT'],
    // ⭐ 0.4.4 对话「消息 → 任务」的来源列（可空、只写一次）—— 老库靠这两行补上，
    //    新库由上面的 DDL 一步到位；两边都不动 SCHEMA_VERSION。
    ['project_tasks', 'from_message_id', 'INTEGER'],
    ['daily_tasks', 'start_date', 'TEXT'],
    ['daily_tasks', 'from_message_id', 'INTEGER'],
    // ⭐ 0.5.2「任务可绑定网址」：可空、随时可改，与上面的来源列同一手法 ——
    //    老库靠这两行补上，新库由 DDL 一步到位，两边都不动 SCHEMA_VERSION。
    ['project_tasks', 'bookmark_id', 'INTEGER'],
    ['daily_tasks', 'bookmark_id', 'INTEGER'],
    // ⭐⭐ 0.8.10 追加批：共享开关 —— **老库上唯一生效的路径**（DDL 里的新列对已存在的
    //    `projects` 表一个字节都不动）。⚠️ 带 `NOT NULL DEFAULT 0`：老项目升级上来一律「不共享」——
    //    那正是失败方向安全的一边（⛔ 绝不默认共享）。**不动 `SCHEMA_VERSION`**（仍是 v5）。
    ['projects', 'shared', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐⭐ 0.8.12：共享看板的两个新列 —— 可空 INTEGER，**不动 SCHEMA_VERSION**。
    //    · `assignee_id`：**负责人账号 id**（旧的 `assignee` TEXT 列**一个字不动**、继续留着）——
    //      「负责人」必须从「名字」改成「账号 id」（名字可改、可手输，用来判权会断）；
    //    · `creator_id`：**任务创建者账号 id**（`user_id` 仍是**项目所有者**，⛔ 语义不许改）。
    //    ⚠️ `assignee_id` 在 `allowedCols` 的 `project_tasks` 里（成员要能改负责人）；
    //      `creator_id` **刻意不在**（「这条任务谁建的」写入那一刻定死，与 `from_message_id` 同一性质）。
    ['project_tasks', 'assignee_id', 'INTEGER'],
    ['project_tasks', 'creator_id', 'INTEGER'],
    // ⭐⭐ 0.8.14：任务类型四列 × 两张表 = 八条 —— **老库上唯一生效的路径**
    //    （DDL 里的新列对已存在的表一个字节都不动）。⛔ 同样**不动 `SCHEMA_VERSION`**（仍 v5）——
    //    与 `important` / `urgent` / `start_date` / `bookmark_id` 的加法完全同类。
    //    ⚠️⭐ 漏一条 ＝ 那张表在老库上**永远没有这一列**，而 `_insert` / `_update` 写它时
    //    「列不存在」是**报错**、读它时是 `undefined`（旧列读不到、界面静默少一块）。
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
   * 功能：通用 `_update()` 允许写入的列（白名单）—— **从 0.1.3 起由本模块自报**。
   *
   * 说明：以前这份白名单是 `db.js` 里一个 `switch (table)` 大表：加一张表要**跨文件**回去补 case，
   *      漏一个 case 的后果是 `setKeys` 为空 → `_update` 直接 `return false` → 路由层当成「资源不存在」回 404，
   *      表现为「改不动、界面也不报错」（课表 5 张表就是这么踩过来的）。
   *      现在「定义这张表的人」顺手声明它，「漏一处」在结构上就很难发生。
   *      ⚠️ 三个**必须排除**的列，恶意或手滑传进来都不能生效：
   *      `id`（不许改主键）、`user_id`（不许「过户」给别人 —— `_update` 里还有第二道保险）、
   *      `created_at`（创建时间只写一次）。
   *      ⚠️ `updated_at` 在列表里：`_update` 会**总是**把它刷成当前时间，但前提是这张表真有这一列。
   *
   * @type {Object}
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
      // ⭐⭐ 0.8.12：负责人账号 id —— 成员可以改负责人（§丙-2-5），
      //    所以要进通用白名单。⚠️ `creator_id` **刻意不在这里**（谁建的这条任务只写一次，
      //    与 `from_message_id` 同一性质，见 schema.test.js 的 EXEMPT）。
      'assignee_id',
      'tag',
      'important',
      'urgent',
      // ⭐ 0.5.2：任务绑的网址 —— ⚠️ `from_message_id` **不在这里**（「这条任务从哪条消息来的」
      //    只写一次，不该被一次 PUT 改掉）；而 `bookmark_id` 是用户随时可以改、也可以清掉的偏好，
      //    所以它在白名单里（「取消绑定」传 0）。
      'bookmark_id',
      // ⭐⭐ 0.8.14：任务类型的四个字段都**可以由一次 PUT 改**
      //    （改类型 / 改时刻 / 换循环规则都是正常编辑）⇒ 两张表都进白名单。
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
      // ⭐⭐ 0.8.14：同 project_tasks —— 四个字段都可由一次 PUT 改。
      'task_kind',
      'start_time',
      'due_time',
      'recur_rule',
      'sort_order',
      'updated_at',
    ],
    // ⭐⭐ 0.8.14：`task_occurrences` **刻意留空 `allowedCols`** ——
    //    打卡记录只有「打上 / 取消」两种动作（走 `occurrences.js` 的专用原语），
    //    ⛔ 没有「通用改一行」这个业务；放开它等于让一次 PUT 就能改掉「哪一期、谁、什么时候打的」。
    //    ⚠️ 空白名单的表要**同时**登记进 `ttt/test/schema.test.js` 的整表豁免清单（SKIP_TABLES），
    //    否则会掉进「逐列对齐」那条反向断言。
    task_occurrences: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**（本模块三张表都带）。
   *
   * 说明：⭐ 0.8.12：协作那几张带 `user_id` 的表
   *      （`project_members` / `task_reports` / `project_comments` / `project_files`）
   *      与它们的 `userScoped` 登记**一并搬进 `modules/teamwork`**（判据与表同处一个模块）。
   *      本模块只管自己这三张表 —— 删账号时它们随 `user_id` 清空。
   * @type {Array.<string>}
   */
  userScoped: [
    'projects',
    'project_tasks',
    'daily_tasks',
    // ⭐⭐ 0.8.14：打卡记录也带 `user_id` ⇒ **必须**登记。
    //    ⚠️ 漏它的后果是**删账号后记录永久残留、而且不报错**。
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
   *      · 删 `idx_ptasks_date_range` / `idx_dtasks_date_range`：**没有任何查询选中过它们**。
   *        待办查询是 `user_id=? AND status!='done' AND due_date>=? AND COALESCE(start_date,due_date)<=?`，
   *        COALESCE 不可索引，而这两个索引的前缀又没有 user_id，全表扫都得靠后过滤。
   *      · 删 `idx_dtasks_user_status`、加 `idx_dtasks_user_sort`：日常任务列表按 sort_order 排序，
   *        原来只能借 (user_id,status) 走前缀，排序要现搭临时 B-Tree（`USE TEMP B-TREE FOR ORDER BY`）；
   *        换成 (user_id,sort_order) 后临时排序消失，而待办统计照样能借它的 user_id 前缀。
   *      · `idx_ptasks_user_status` 保留：待办统计**真的**选中了它（删了会退化成全表扫描）。
   *
   * ⭐ 0.4.4 再加两条 `(user_id, from_message_id)`：对话页渲染消息时，要按**这一页消息的 id**
   *    反查「哪些是我从它建的任务」（`tasksFromMessages()`），查询形状正是
   *    `WHERE user_id=? AND from_message_id IN (…)` —— 没有这两条索引就会在每次翻页
   *    （以及降级轮询的每一拍）全表扫一遍我的任务。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_projects_user_sort ON projects(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ptasks_project     ON project_tasks(project_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ptasks_user_status ON project_tasks(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_dtasks_user_sort   ON daily_tasks(user_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_ptasks_from_msg    ON project_tasks(user_id, from_message_id)',
    'CREATE INDEX IF NOT EXISTS idx_dtasks_from_msg    ON daily_tasks(user_id, from_message_id)',
    // ⭐⭐ 0.8.14：打卡记录的两条索引 ——
    //    · `(user_id, task_source, task_id)`：看板渲染「这条任务的每一期打卡了没有」，
    //      查询形状正是 `WHERE user_id=? AND task_source=? AND task_id=?`；
    //    · `(user_id, period_key)`：按「哪一期」回查（本期是否已打卡、删任务时按 id 清）。
    'CREATE INDEX IF NOT EXISTS idx_occ_user_task      ON task_occurrences(user_id, task_source, task_id)',
    'CREATE INDEX IF NOT EXISTS idx_occ_user_period    ON task_occurrences(user_id, period_key)',
  ],
};
