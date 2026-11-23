'use strict';
/**
 * core/store/methods/backup.js —— 备份与恢复
 * 功能：这里管四件事（个人导出 `exportAll(uid)` 在 `methods/stats.js`，不重复）——
 * `exportWholeBackup()` 整体备份：把**全库所有账号**的数据打成一份 JSON 快照；
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/03-数据安全.md
 */

const { nowStamp, badRequest } = require('../helpers.js');
const { SCHEMA } = require('../constants.js');

/**
 * 个人备份里「数组键名 → 真实表名」的映射。
 *
 */
const PERSONAL_SOURCES = [
  { table: 'projects', keys: ['projects'] },
  { table: 'project_tasks', keys: ['project_tasks'] },
  { table: 'daily_tasks', keys: ['daily_tasks'] },
  { table: 'time_timetable_terms', keys: ['time_timetable_terms', 'terms'] },
  { table: 'time_timetable_blocks', keys: ['time_timetable_blocks', 'period_blocks'] },
  { table: 'time_timetable_periods', keys: ['time_timetable_periods', 'periods'] },
  { table: 'time_timetable_courses', keys: ['time_timetable_courses', 'courses'] },
  { table: 'time_timetable_sessions', keys: ['time_timetable_sessions', 'course_sessions'] },
  // 新增：单次调课必须排在**课次之后** —— 它的 `session_id` 要指向刚建出来的课次
  { table: 'time_timetable_adjustments', keys: ['time_timetable_adjustments', 'adjustments'] },
  // 网址收藏夹：书签与分类**没有父子关系**（互相独立），关联表则要同时指向两者，
  // 所以必须排在最后。键名同样是真名（这批键没有历史包袱）。
  { table: 'bookmarks', keys: ['bookmarks'] },
  { table: 'bookmark_tags', keys: ['bookmark_tags'] },
  { table: 'bookmark_tag_links', keys: ['bookmark_tag_links'] },
  // NAS硬件管理：**单表无关联**（1 期只有一张表），插在哪一段都不影响父子顺序。
  // 键名 `hardware` 与 `exportAll()` 返回的键一致（这批键没有历史包袱）。
  { table: 'hardware_items', keys: ['hardware'] },
  // 密码库：`vault_meta` 是「一个账号一行」的开库材料，`vault_items` 是条目密文。
  // 它们**只在「替换」导入里生效**，合并模式会被跳过（见 `_planImport` 的说明）。
  { table: 'vault_meta', keys: ['vault_meta', 'vaultMeta'] },
  { table: 'vault_items', keys: ['vault_items', 'vaultItems'] },
  // 假期调休（`time_timetable_day_rules`）：父项只有**学期**（不挂课次），插在哪一段都不影响父子顺序。
  // 它**刻意留在数组末尾**：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种**硬编码下标**，
  // 放末尾则既有下标一个都不动，改动只落在「新增的最后一段」。键名是真名（这批键没有历史包袱）。
  { table: 'time_timetable_day_rules', keys: ['time_timetable_day_rules'] },
  // 2 期 AI辅助任务：只带**长期记忆**这一张表——
  // 配置里的 key 密文绑本实例的 KEK（换个实例解不开），会话是过程记录，两者都不进。
  // 同样**追加在末尾**：理由与上面那条一字不差（`_planImport()` 是硬编码下标）。
  { table: 'ai_memories', keys: ['ai_memories'] },
  // 按日期的课次备注：是**用户亲手写的内容** ⇒ 必须进个人备份。
  // 同样**追加在末尾**：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种硬编码下标，
  // 它**有两个父项**（学期 + 课次），导入时两个都要重新指向刚建出来的行。
  { table: 'time_timetable_day_notes', keys: ['time_timetable_day_notes'] },
  // 灵感库：单表、**无父子**（`task_id` 只是「它变成了哪个任务」的一枚记录，
  // 不是外键，导入时**不重新指向** —— 跨机器搬任务 id 没有意义，与 `from_message_id` 同一条理由）。
  // 同样**追加在末尾**：理由与上面几条一字不差（`_planImport()` 是硬编码下标）。
  { table: 'idea_items', keys: ['idea'] },
  // 番茄钟：两张表、**无父子**（`task_id` 只是「这个番茄在专注哪条任务」的一枚记录，
  // 不是外键，导入时**不重新指向** —— 跨机器搬任务 id 没有意义，与 `idea_items.task_id` 同一条理由）。
  // 同样**追加在末尾**：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种硬编码下标，
  { table: 'time_pomodoro_sessions', keys: ['time_pomodoro_sessions'] },
  { table: 'time_pomodoro_prefs', keys: ['time_pomodoro_prefs'] },
  // 日历：两张表、**无父子**（`calendar_events` 里没有指向别处的 id —— 三个图层是
  // 运行时向课表 / 任务 / 假期**读**出来的，⛔ 一个都不落库，所以没有外键要重新指向）。
  // 同样**追加在末尾**：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种硬编码下标，
  { table: 'calendar_events', keys: ['calendar_events'] },
  { table: 'calendar_prefs', keys: ['calendar_prefs'] },
  // 记账：两张表、**无父子**（账户之间没有指向关系 —— 同一组里的顺序
  // 用 `sort_order` 表达，不是外键；快照是自己的三个数，不指向任何账户）。
  // 同样**追加在末尾**：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种硬编码下标，
  { table: 'ledger_accounts', keys: ['ledger_accounts'] },
  { table: 'ledger_snapshots', keys: ['ledger_snapshots'] },
  // -视图：自定义分类（一套一行）与其用途归属（账户 × 分类 → 用途名）。
  // 必须同样**追加在末尾**（下面 _planImport() 里全是 PERSONAL_SOURCES[n] 这种硬编码下标）；
  // ledger_view_tags 有**两个外键**（view_id / account_id）⇒ 导入时两列都要重指到新 id。
  { table: 'ledger_views', keys: ['ledger_views'] },
  { table: 'ledger_view_tags', keys: ['ledger_view_tags'] },
  // 账户之间的转账明细。
  // 必须同样**追加在末尾**（下面 _planImport() 里全是 PERSONAL_SOURCES[n] 这种硬编码下标）；
  // 它有**两个外键**（from_id / to_id）⇒ 导入时两列都要重指到新建出来的那两个账户。
  { table: 'ledger_transfers', keys: ['ledger_transfers'] },
  // 分组字段（九类的显示顺序 ＋ 内置用途的**名字 / 顺序 / 锁定**）。
  // 必须**追加在末尾**（同上：下标是硬编码的）—— `PERSONAL_SOURCES[28]`。
  // 它**没有任何外键**：`gkey` 是本模块自己的稳定键，跨机器搬照样成立 ⇒ 不需要重指。
  { table: 'ledger_groups', keys: ['ledger_groups'] },
  // ：五张新表 —— 记账条目 / 收支分类 / 默认账户 / 账户删除记录 / 手动调整。
  // 五行必须**追加在末尾**（下标 29~33）：`_planImport()` 里全是 `PERSONAL_SOURCES[n]`
  // 全是**用户亲手记下的账**（记一笔 / 建分类 / 设默认 / 删账户留下的原名 / 调余额留痕）⇒
  { table: 'ledger_entries', keys: ['ledger_entries'] },
  { table: 'ledger_categories', keys: ['ledger_categories'] },
  { table: 'ledger_default_accounts', keys: ['ledger_default_accounts'] },
  { table: 'ledger_account_deletions', keys: ['ledger_account_deletions'] },
  { table: 'ledger_adjustments', keys: ['ledger_adjustments'] },
  // 记账 3 期：**预算额度** —— 用户亲手一期一期设的那份额度，
  // 换机 / 恢复之后不能丢（丢了 = 预算屏一片空态，而备份「看着成功」）。
  // 它**必须追加在末尾**（于是下标是 34）：`_planImport()` 里全是 `PERSONAL_SOURCES[n]`
  { table: 'ledger_budgets', keys: ['ledger_budgets'] },
  // ：记账的三方导入**原样数据**。
  // 这条**推翻了** 那句「换机之后重新导一次就行」—— 改主意了。
  // 一口来源一张表（表名来自模块的 `lib/import-sources.js`）⇒ **以后加一家来源，
  { table: 'shayu', keys: ['shayu'] },
  // 行程：**四张表全部进个人备份** ——
  // 轨迹与车票**无法重新产生**，换机后必须能恢复（与三方导入「可重导所以不进」正好相反）。
  // 四条都**追加在末尾**（下标 36~39）：`_planImport()` 里全是 `PERSONAL_SOURCES[n]`
  { table: 'time_trips', keys: ['time_trips'] },
  { table: 'time_trip_tickets', keys: ['time_trip_tickets'] },
  { table: 'time_trip_points', keys: ['time_trip_points'] },
  { table: 'time_trip_prefs', keys: ['time_trip_prefs'] },
  // 个人资产管理：**两张表都进个人备份**。
  // 两条都**追加在末尾**（下标 40 / 41）：`_planImport()` 里全是 `PERSONAL_SOURCES[n]`
  // 这种**硬编码下标**，往中间插一项会把后面每一段都推移一位 ⇒ 漏改一处就是「静默搬错表」。
  { table: 'asset_groups', keys: ['asset_groups'] },
  { table: 'asset_items', keys: ['asset_items'] },
  // 追加批（协作）：**上报进个人备份**（那是「我写的」），
  // **成员表与 `shared` 配置不进** —— 它们是**项目的公共财产**（换一台机器导进来，
  // 成员 id 指向的是另一台机器上的账号），由**整体备份**覆盖。
  { table: 'task_reports', keys: ['task_reports'] },
  // **评论进个人备份**（那是「我写的内容」）。
  // 必须**追加在末尾**（下标 43）：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种
  // 两级评论同一张表：项目级（`task_id` 为 NULL）＋ 任务级都在这里；`project_id` 由
  { table: 'project_comments', keys: ['project_comments'] },
  // 随手记的**两张标签真表** —— 两条都必须**追加在末尾**
  // （下标 44 = `idea_tags` / 45 = `idea_tag_links`）。
  // `_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种**硬编码下标**，往中间插一项会把
  { table: 'idea_tags', keys: ['idea_tags'] },
  { table: 'idea_tag_links', keys: ['idea_tag_links'] },
  // **硬件模板也进个人备份** —— 用户自己建的那些模板是他亲手搭的结构，换机 / 恢复
  // 之后不能丢（丢了的表现：那些硬件的模板归属全退回「通用」，专业参数的值还在 `attrs` 里，
  // 必须**追加在末尾**（下标 46）：`_planImport()` 里全是 `PERSONAL_SOURCES[n]` 这种
  { table: 'hardware_templates', keys: ['hardware_templates'] },
  // `ledger_meta` **刻意不在上面这一串里**：它**没有 `user_id`**（是记账库自己的**系统
  // 键值表**，与 `users` / `settings` 同属「全局数据」），而个人备份整条路都按 `user_id` 工作 ——
  // 它只走**整体备份**（`exportWhole` / `replaceWhole`），换机时随整库一起搬。
];

/**
 * 每张表允许从备份里搬过来的列。
 *
 */
const COLS = {
  projects: ['name', 'description', 'color', 'icon', 'status', 'sort_order', 'created_at', 'updated_at'],
  project_tasks: [
    'title',
    'description',
    'status',
    'completed_at',
    'start_date',
    'due_date',
    'assignee',
    // 共享看板的两个新列**都要搬** —— `assignee_id`（负责人账号 id）
    // 与 `creator_id`（任务创建者账号 id）。⚠️ `user_id`（任务行归属）照旧**不在**白名单里、
    // 由导入逻辑一律写成导入者自己；`projects.shared` / 成员表则**整张不进**个人备份
    'assignee_id',
    'creator_id',
    'tag',
    'important',
    'urgent',
    // 任务类型这一维度的四列 —— 用户亲手设的属性
    // （类型 / 两个时刻 / 循环规则）⇒ **必须搬**，漏一列就是「换机之后这类任务全变普通任务」。
    // 与 `task_occurrences`（打卡**记录**）**成对区分**：那个是「这台机器上的任务 id」，
    'task_kind',
    'start_time',
    'due_time',
    'recur_rule',
    'sort_order',
    'created_at',
    'updated_at',
  ],
  daily_tasks: [
    'title',
    'content',
    'important',
    'urgent',
    'start_date',
    'due_date',
    'status',
    'completed_at',
    // 同 project_tasks 那四列（理由见那里）。
    'task_kind',
    'start_time',
    'due_time',
    'recur_rule',
    'sort_order',
    'created_at',
    'updated_at',
  ],
  time_timetable_terms: [
    'name',
    'start_monday',
    'total_weeks',
    'remark',
    'meta',
    'holiday_advance_minutes',
    'holiday_pm_from',
    'sort_order',
    'created_at',
    'updated_at',
  ],
  time_timetable_blocks: ['label', 'sort_order', 'start_time', 'end_time', 'period_count', 'class_minutes', 'break_minutes'],
  time_timetable_periods: ['index_no', 'start_time', 'end_time'],
  time_timetable_courses: ['name', 'short_name', 'teacher', 'color', 'remark', 'sort_order', 'created_at', 'updated_at'],
  time_timetable_sessions: [
    'weekday',
    'period_start',
    'period_end',
    'weeks',
    'room',
    'teacher',
    'remark',
    'created_at',
    'updated_at',
  ],
  // 不含 `session_id`：它由导入逻辑重新指向刚建出来的课次（同「排除全部父子外键」的规矩）
  time_timetable_adjustments: [
    'week_no',
    // 跨周调课的目标周（空 = 同周换时间）；它是**内容列**，不是外键 ⇒ 跟着备份走
    'to_week_no',
    'kind',
    'to_weekday',
    'to_period_start',
    'to_period_end',
    'to_room',
    'note',
    'created_at',
    'updated_at',
  ],
  // 假期调休：`term_id` 刻意**不在**列白名单里 —— 由导入逻辑重新指向刚建出来的学期
  // （同上一条的理由：照备份里的 id 搬会撞上现存的 id）
  time_timetable_day_rules: ['date', 'kind', 'to_date', 'note', 'created_at', 'updated_at'],
  // 按日期的课次备注：`session_id` / `term_id` 刻意**不在**列白名单里 ——
  // 由导入逻辑重新指向刚建出来的课次与学期（照备份里的 id 搬会撞上现存的 id）
  // `task_id`（绑定的日常任务）**同样刻意不搬** —— 与 `idea_items.task_id` 一模一样的
  time_timetable_day_notes: ['date', 'note', 'created_at', 'updated_at'],
  // 灵感库：除 id / user_id 外全部可搬。
  // `task_id` / `task_source` **刻意不搬**：它们是「**这台机器上**的任务 id」，
  // 换台机器极可能指向一条完全无关的任务（「这条灵感变成的任务」会挂错）。
  idea_items: ['content', 'title', 'tag', 'tags', 'archived_at', 'created_at', 'updated_at'],
  // 随手记的两张标签真表。
  idea_tags: ['name', 'sort_order', 'created_at'],
  // 不含 `idea_id` / `tag_id`：由导入逻辑重新指向刚建出来的随手记与标签
  // （照 `bookmark_tag_links` 那条注释 —— 照备份里的 id 搬会撞上现存的 id）。
  idea_tag_links: [],
  // 网址收藏夹
  bookmarks: ['url', 'title', 'source', 'pinned', 'sort_order', 'vault_entry_id', 'created_at', 'updated_at'],
  bookmark_tags: ['name', 'sort_order', 'created_at'],
  // 不含 `bookmark_id` / `tag_id`：由导入逻辑重新指向刚建出来的书签与分类
  bookmark_tag_links: [],
  // 没有子项，除 id / user_id 外的列全部可搬。
  // 漏一列的表现是「导入成功了，但那个字段全空」——很难发现，所以
  // `ttt/test/digital.test.js` 拿**真实的表结构**核对该清单。
  hardware_items: [
    'name',
    'category',
    'status',
    'purpose',
    'brand',
    'model',
    'serial',
    'capacity',
    'quantity',
    'location',
    'slot',
    'purchase_date',
    'purchase_price',
    'vendor',
    'warranty_until',
    'expected_life_months',
    'wish_priority',
    'wish_target_price',
    'wish_url',
    'wish_reason',
    'note',
    // 同一次加的 `template_id` **刻意不在这里**：它是**那台机器上的模板 id**
    // （与上面 `group_id` 同类）⇒ 导入侧留空、界面按「通用」显示；
    // 用户把模板重新选回去，`attrs` 里那些值**立刻就会显示出来**（字段的 key 是稳定的）。
    'attrs',
    'created_at',
    'updated_at',
  ],
  // 硬件模板 —— ⚠️ `builtin` **在**清单里（「是不是内置」跨机器照样成立；搬过去之后
  // 本机播种按「名字 + builtin」判缺，所以不会重复建一份）。⛔ `id` / `user_id` 照例不搬。
  hardware_templates: ['name', 'builtin', 'fields', 'sort_order', 'created_at', 'updated_at'],
  // 密码库：整行都是密码学材料，除 `user_id`（由导入逻辑重写）外全部可搬。
  // 这张表**没有 `id`**（主键就是 `user_id`），所以它天然只可能是「一行」。
  vault_meta: [
    'kdf',
    'kdf_params',
    'salt',
    'dek_iv',
    'dek_cipher',
    'dek_tag',
    'verifier_iv',
    'verifier_cipher',
    'verifier_tag',
    // 「建过但还没挂记录的空标签」全没了（条目里的标签一条不丢，只是池子空了）。
    // 这三列**可空** ⇒ ⛔ 不进 `REQUIRED`（老备份压根没有它们，那是正常状态）。
    // 是用**非贪婪**的方式从本块里抽引号串列名的 —— 一个方括号就会把抽取提前截断，
    'tags_iv',
    'tags_cipher',
    'tags_tag',
    'created_at',
    'updated_at',
  ],
  vault_items: ['iv', 'cipher', 'tag', 'sort_order', 'created_at', 'updated_at'],
  // 2 期 AI辅助任务：长期记忆是**用户内容**（明文），整行可搬 —— 只有两样不给：
  // `id`（导入时重新分配）与 `user_id`（一律写成导入者自己）。`source` 留着：
  // 它记的是「这条记忆从哪来」（2 期恒为 manual），丢掉将来就补不回来了。
  ai_memories: ['label', 'content', 'source', 'sort_no', 'created_at', 'updated_at'],
  // 番茄钟：两张表都**没有父子外键**，除 `id` / `user_id` 外几乎全部可搬 —— 只有两样不给。
  // `task_id` / `task_source` **刻意不搬**：与 `idea_items` 那两列**一字不差的理由** ——
  // 它们是「**这台机器上**的任务 id」，换台机器极可能指向一条完全无关的任务
  time_pomodoro_sessions: ['started_at', 'planned_seconds', 'ended_at', 'status', 'kind', 'paused_at', 'paused_total', 'date'],
  // 四个时长 + `updated_at`；`focus_min` 等列在 DDL 里都有 DEFAULT，
  // 所以老备份缺列也能落进默认值（`REQUIRED` 因此是空的）。
  // 五个时长 / 开关 + `updated_at`；`focus_min` 等列在 DDL 里都有 DEFAULT，
  time_pomodoro_prefs: ['focus_min', 'break_min', 'long_break_min', 'rounds_before_long', 'sound_on', 'updated_at'],
  // 日历：两张表都**没有父子外键**，除 `id` / `user_id` 外几乎全部可搬 —— 只有两样不给。
  // 日期与时刻是**字符串**（`YYYY-MM-DD` / `HH:MM`）：跨机器搬照样是同一个日期
  // （它们不依赖时区解析，与番茄钟那批 epoch 毫秒同一条好处）；`all_day` 是 0/1 整数。
  calendar_events: [
    'title',
    'date',
    'end_date',
    'all_day',
    'start_time',
    'end_time',
    'note',
    'created_at',
    'updated_at',
  ],
  // DDL 里都有 `DEFAULT 1`、后三列可空，所以老备份缺列也能落进默认值（`REQUIRED` 因此是空的）。
  // 把「人生日历」的 `birth_date` / `expect_years` 一并登记 ——
  // 这一条**不是可选的**：本表的**导出侧是整行**（`exportCalendar` 走 `SELECT *`），
  calendar_prefs: [
    'layer_course',
    'layer_task',
    'layer_holiday',
    'layer_ledger',
    'birth_date',
    'expect_years',
    // 首页看板的「默认视图」—— 同一条命门：导出侧是整行
    // 「备份里明明有、恢复之后却回到默认（列表）」——又一个只在换机那天发作的静默丢数据
    // （`ttt/test/calendar.test.js` 拿真实表结构核对这张清单，漏了当场红）。
    'default_view',
    'updated_at',
  ],
  // 记账：两张表都**没有父子外键**，除 `id` / `user_id` 外全部可搬。
  // 金额列是**整数分**（`opening_fen` / `asset_fen` / `debt_fen` / `net_fen`）：
  // 跨机器搬照样是同一个数（不像浮点那样依赖解析），与番茄钟那批 epoch 毫秒同一条好处。
  ledger_accounts: [
    'kind',
    'name',
    'tail',
    'note',
    'opening_fen',
    'sort_order',
    // ：`special` 是「这一行是不是那个**空账户**」的唯一标记。
    // （备份文件看上去完全正常）—— 所以「加一列」那三处（DDL / ensureColumns / 这里）一个都不能漏。
    'special',
    // ：分级与三个限额（只加列时**唯一**的登记点就是这里，⛔ 别漏）
    'tier',
    'limit_day_fen',
    'limit_month_fen',
    'limit_year_fen',
    'created_at',
    'updated_at',
  ],
  ledger_snapshots: ['date', 'asset_fen', 'debt_fen', 'net_fen', 'created_at'],
  // ledger_view_tags 的两个外键（view_id / account_id）**列在这里但不算数**：
  // 导入时 `_planImport()` 会用 `{ __ref: 父项行 }` 覆盖它们（重指到新建出来的那两行，
  // `builtin` **必须在白名单里** —— 它是「这条分类是不是内置」的唯一标记。
  ledger_views: ['name', 'sort_order', 'builtin', 'created_at', 'updated_at'],
  ledger_view_tags: ['view_id', 'account_id', 'tag', 'sort_order', 'created_at', 'updated_at'],
  // 转账明细：它的两个外键（`from_id` / `to_id`）同样**列在这里但不算数** ——
  // 导入时 `_planImport()` 会用 `{ __ref: 账户行 }` 覆盖它们（重指到新建出来的账户）。
  // `date` 是定长日期串、`amount_fen` 是整数分：跨机器搬照样是同一个值。
  ledger_transfers: ['date', 'from_id', 'to_id', 'amount_fen', 'note', 'created_at'],
  // 分组字段：全是普通列（没有外键、没有密文），照列一遍即可。
  // `locked` 必须带上：「其它」那一行的不可删属性靠它，丢了之后它变成可删的。
  ledger_groups: ['scope', 'gkey', 'name', 'sort_order', 'locked', 'created_at', 'updated_at'],
  // ：五张新表的列白名单。⚠️ 下面那几个**父子外键列在这里但不算数** ——
  // 导入时 `_planImport()` 会用 `{ __ref: 父项行 }` 覆盖它们（重指到新建出来的行，与
  // 金额 / 日期 / 时刻都是**整数分**与**字符串**：跨机器搬照样是同一个值（与番茄钟那批
  ledger_entries: [
    'at',
    'ie',
    'amount_fen',
    'category_id',
    'account_id',
    'refund_of',
    'note',
    'created_at',
    'updated_at',
  ],
  // `parent_id` 也是**自引用**（两级分类）—— 一级写 NULL，二级指向本表的一级行；
  // `ie` **只在一级上填**（二级 NULL、继承父），所以它只是普通列，原样搬。
  // `archived_at` 非空 = 已归档（行留着、历史流水照旧指着它）⇒ 必须带上，
  ledger_categories: ['parent_id', 'name', 'ie', 'sort_order', 'builtin', 'archived_at', 'created_at', 'updated_at'],
  // `category_id` 的 `0` 是**哨兵**（kind='income' / 'expense' 的「全局两层」两行写 `0`），
  // 它**不是**一个分类 id ⇒ 导入时**绝不重指**（照原值搬）；只有 `kind='category'` 那一层
  // 的 `category_id` 才是真分类 id、要重指。`account_id` 一律重指到新建出来的账户行。
  ledger_default_accounts: ['kind', 'category_id', 'account_id', 'created_at', 'updated_at'],
  // `account_id` 是「被删掉的那个账户的**原 id**」—— 那个账户在备份里**根本没有行**（硬删），
  // 没有任何东西可以指过去，所以导入时**保持原值、⛔ 不重指**（`name` 才是这张表存在的理由）。
  // 详见 `_planImport()` 里那一段的说明。
  ledger_account_deletions: ['account_id', 'name', 'deleted_at'],
  // `account_id` 指向账户行（导入时重指）；`at` 是这条留痕的**次序依据**（精确到秒），
  // `from_fen` / `to_fen` 是**绝对值**（不是增量）⇒ 三个都原样搬。
  ledger_adjustments: ['account_id', 'at', 'from_fen', 'to_fen', 'created_at'],
  // 记账 3 期：预算额度。
  // `category_id` **列在这里但不算数** —— 它由导入逻辑重指（`0` 哨兵保持 0、
  // `> 0` 的按旧分类 id 找到刚建出来的那一行），与 `ledger_default_accounts` 同款。
  ledger_budgets: ['period_type', 'period_key', 'category_id', 'amount_fen', 'created_at', 'updated_at'],
  // 三方导入的原样数据。⚠️ `batch_id` **列在这里**，但导入时会**重新编号**
  // （它是那台机器上的批次号，照搬会与本机某一批撞 `(user_id, batch_id, row_no)`）——
  // 见 `_planImport()` 那一段。`row_no` 原样搬（同一批内部的相对身份）。
  shayu: [
    'batch_id',
    'row_no',
    'date_raw',
    'ie_raw',
    'category',
    'account',
    'amount_raw',
    'note',
    'at',
    'fen',
    'created_at',
  ],
  // 行程：四张表除 `id` / `user_id` 外全部可搬。
  // 车票与点的 `trip_id` **列在这里**，但导入时由 `_planImport()` **重指**
  // （它是那台机器上的行程 id，照搬会挂到本机某个不相干的行程上）——
  time_trips: [
    'title',
    'vehicle',
    'from_place',
    'to_place',
    'start_date',
    'start_time',
    'end_date',
    // 结束时刻 —— ⚠️⭐ 这一处漏了 = 换机 / 恢复之后
    // 「结束时刻」整列**静默丢失**（备份看着成功），与 `start_time` 成对。
    'end_time',
    'note',
    'created_at',
    'updated_at',
  ],
  time_trip_tickets: [
    'trip_id',
    'kind',
    'code',
    'from_station',
    'to_station',
    'depart_at',
    'arrive_at',
    'seat',
    'gate',
    'terminal',
    'price_fen',
    'order_no',
    'note',
    'created_at',
    'updated_at',
  ],
  time_trip_points: [
    'trip_id',
    'kind',
    'at',
    'lat',
    'lng',
    'accuracy',
    'altitude',
    'speed',
    'heading',
    'label',
    'note',
    'created_at',
  ],
  time_trip_prefs: [
    'remind_d3',
    'remind_d1',
    'remind_h3',
    // 「人生日历」的两项设置搬进行程后住**这同一行** ——
    // 漏了这两列 = **导入之后生日与预期寿命全空**，而且不报任何错
    // （`ttt/test/backup.test.js` 拿真实表结构核对这张表，漏列当场红 —— 本轮就是它抓到的）。
    'birth_date',
    'expect_years',
    'updated_at',
  ],
  // 个人资产管理：分组树 ＋ 通用条目。
  // `parent_id`（自引用）与 `group_id` 都由 `_planImport()` 重指 ⇒ **刻意不在白名单里**
  // （照搬原 id 会挂到本机上毫不相干的行下面）。`module_key` **在**白名单里：
  asset_groups: ['parent_id', 'name', 'kind', 'module_key', 'builtin', 'icon', 'sort_order', 'created_at', 'updated_at'],
  asset_items: ['name', 'amount_fen', 'date', 'note', 'created_at', 'updated_at'],
  // 追加批（协作）：上报 —— ⚠️ `task_id` **在**白名单里（成对搬，见上面 PERSONAL_SOURCES
  // 那一段的说明：第一版不重指，宁可挂不上也不挂错）。
  // `task_reports` 改造成活动流水后新增的两列也**一起搬**（`from_status` 是状态键、
  task_reports: ['task_source', 'task_id', 'status', 'note', 'created_at', 'project_id', 'from_status'],
  // 评论进个人备份 —— 只带「我写过的」（`user_id` 一律写成导入者自己）。
  // `project_id`（父项目）**刻意不在白名单里**：由 `_planImport()` 重指到新建出来的项目
  // （照搬原 id 会挂到本机上毫不相干的项目下面）。`task_id` **在**白名单里但**不重指**
  project_comments: ['task_id', 'body', 'created_at'],
};

/** 各表里「空了就没意义」的必填列 —— 校验时逐行检查，宁可拒绝导入也不写进去一行坏数据 */
const REQUIRED = {
  projects: ['name'],
  project_tasks: ['title'],
  daily_tasks: ['title'],
  time_timetable_terms: ['name'],
  time_timetable_blocks: [],
  time_timetable_periods: ['index_no'],
  time_timetable_courses: ['name'],
  time_timetable_sessions: ['weekday'],
  time_timetable_adjustments: ['week_no', 'kind'],
  // 假期调休：`date` 与 `kind` 是必填（其余列可空）。`kind='swap'` 时还必须带 `to_date`，
  // 那是**跨列**依赖，这里（逐列查空）管不了 —— 缺 `to_date` 的规则会被 `day-rules.resolveDay()`
  time_timetable_day_rules: ['date', 'kind'],
  // 按日期的课次备注：`date` 是它的身份（`(session_id, date)` 唯一）⇒ 必填；
  // 课次 id 在导入时才重新指向，不参与「逐列查空」
  time_timetable_day_notes: ['date'],
  bookmarks: ['url'],
  bookmark_tags: ['name'],
  bookmark_tag_links: [],
  // 硬件台账只有 `name` 是必填（其余列都可能为空 —— 愿望单尤其如此：
  // 没有购买日期、没有价格、没有品牌，照样是一条合法的记录）
  hardware_items: ['name'],
  // 模板只有 `name` 必填（`fields` 可以是空数组 —— 「通用」模板就是空的）
  hardware_templates: ['name'],
  // 2 期 AI辅助任务：长期记忆只有 `content` 必填（`source` / `sort_no` 都带默认值）。
  // 这一行**不是可选的**：`asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条
  // `TypeError`（导入当场崩、用户看到的是 500）—— 与下面密码库那一段同一种「宁可拒绝也不写坏数据」。
  ai_memories: ['content'],
  // 灵感库：只有 `content` 必填（标签可以没有，归档位本来就是空的）。
  // 这一行**不是可选的**：`asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条
  // `TypeError`（导入当场崩、用户看到的是 500）。
  idea_items: ['content'],
  // 标签名是这一行的**身份**（空了就不知道这个标签叫什么）⇒ 必填；
  // 关联行**没有自己的数据**（就两个外键）⇒ 空数组。
  // 这两行**不是可选的**：`asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条
  idea_tags: ['name'],
  idea_tag_links: [],
  // 番茄钟：`started_at` / `planned_seconds` / `date` 是这条记录的**身份与真相**
  // （少了任何一个就算不出「这个番茄多长、归哪一天」）⇒ 必填。
  // 这一行**不是可选的**：`asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条
  time_pomodoro_sessions: ['started_at', 'planned_seconds', 'date'],
  // 偏好那四个时长在 DDL 里都有 DEFAULT（25 / 5 / 15 / 4）⇒ **不设必填**：
  // 老备份里没有这几列时，落库交给表定义的默认值即可，不该因此拒绝整份导入。
  time_pomodoro_prefs: [],
  // 日历：`title` 与 `date` 是这条事件的**身份**（少了任一个都算不出「这是哪天的事」）⇒ 必填。
  // 这一行**不是可选的**：`asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条
  // `TypeError`（导入当场崩、用户看到的是 500）。
  calendar_events: ['title', 'date'],
  // 三个图层开关在 DDL 里都有 `DEFAULT 1`（全开）⇒ **不设必填**：
  // 老备份里没有这几列时，落库交给表定义的默认值即可，不该因此拒绝整份导入。
  calendar_prefs: [],
  // 记账：`kind`（八类之一）/ `name` / `opening_fen` 是这条账户记录的**身份与真相**
  // （少了任一个都算不出「这是什么账户、有多少钱」）⇒ 必填。
  // 这一行**不是可选的**：`asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条
  ledger_accounts: ['kind', 'name', 'opening_fen'],
  // 快照的 `date` 是这一行的身份（`UNIQUE(user_id, date)`）⇒ 必填；
  // 三个金额列在 DDL 里都有 `DEFAULT 0`，老备份缺列时落默认值即可，**不设必填**。
  ledger_snapshots: ['date'],
  // 分类名与用途名是这两张表的**身份**（空了就不知道这一套叫什么、这一组叫什么）⇒ 必填。
  // 两个外键不在这里判：它们由导入逻辑回填，缺父项时那一条**跳过并计数**。
  ledger_views: ['name'],
  ledger_view_tags: ['tag'],
  // `date`（这是哪一天转的）与 `amount_fen`（转了多少钱）是这条明细的**真相**
  // ⇒ 必填。⚠️ 写 `0` **不算缺列**（查空只认 `undefined/null/''`），而转账本来就不允许
  // 0 元（`routes.js` 的 `checkTransfer`）⇒ 不存在误伤。
  ledger_transfers: ['date', 'amount_fen'],
  // 分组字段：少了这三列这行就没意义（哪一套 / 什么键 / 叫什么）。
  // `sort_order` 与 `locked` **不在这里**：它们写 0 是合法值（0 不算缺列）。
  ledger_groups: ['scope', 'gkey', 'name'],
  // ：五张新表各一行。⚠️ 这几行**不是可选的**：`asRow()` 会拿
  // `REQUIRED[table]` 逐个查空，**键不在就是一条 `TypeError`**（导入当场崩、用户看到的是 500）。
  // 口径照上面那批：只留「空了这一行就没意义」的列 —— 本来就允许为空的列一律排除。
  ledger_entries: ['at', 'ie', 'amount_fen'],
  // `parent_id`（一级写 NULL）与 `ie`（只有一级填）都允许空 ⇒ 只有 `name` 必填；
  // `sort_order` / `archived_at` 写 0 / NULL 都是合法值。
  ledger_categories: ['name'],
  // `category_id` 写 `0` 是**合法值**（全局两层的哨兵，查空只看 `undefined/null/''`）
  // ⇒ 不进必填；`account_id` 是父项（由导入逻辑重指），同上一条不在这里判。
  ledger_default_accounts: ['kind'],
  // 这张表存在的理由就是 `name`（原账户名），而 `account_id` 是它记下的**原 id**
  // —— 两者都必填：少一个这条记录就什么都没说清。
  ledger_account_deletions: ['account_id', 'name'],
  // `account_id` 是父项（由导入逻辑重指）⇒ 不在这里判；`from_fen` / `to_fen` 写 `0`
  // 是合法值（余额本来就是 0 的账户也能调），`at` 是这条留痕的**次序依据** ⇒ 三个必填。
  ledger_adjustments: ['at', 'from_fen', 'to_fen'],
  // 记账 3 期：`period_type` / `period_key` 是这一行的**身份**（这是哪一期），
  // `category_id` / `amount_fen` 是它的**内容**（给哪一维、多少钱）—— 四个在 DDL 里都是
  // `category_id` 写 `0`（总预算哨兵）与 `amount_fen` 写 `0`（明确设成 0）都是**合法值**：
  ledger_budgets: ['period_type', 'period_key', 'category_id', 'amount_fen'],
  // 三方导入：**一列必填都没有**（原样几列本来就可能空）—— 但这一行**不能省**：
  // `asRow()` 会拿 `REQUIRED[table]` 逐个查空，键不在就是一条 `TypeError`（导入当场崩、用户看到 500）。
  shayu: [],
  // 行程：四张表**全部进个人备份**（轨迹与车票无法重新产生）。
  // `trips` 的 `title` / `start_date` 是**身份**（少了算不出「这是哪次出行」）⇒ 必填；
  // `time_trip_tickets` 的 `kind` / `from_station` / `to_station` / `depart_at` 是**票面事实** ⇒ 必填；
  time_trips: ['title', 'start_date'],
  time_trip_tickets: ['kind', 'from_station', 'to_station', 'depart_at'],
  time_trip_points: ['kind', 'at', 'lat', 'lng'],
  time_trip_prefs: [],
  // 个人资产管理：两张表都只有 `name` 必填（金额 / 日期 / 备注都可能为空 ——
  // 「这套房」不记金额、不记日期，照样是一条合法的条目）。⚠️ 这一行**不是可选的**：
  // `asRow()` 拿 `REQUIRED[table]` 逐个查空，键不在就是一条 TypeError（导入当场 500）。
  asset_groups: ['name'],
  asset_items: ['name'],
  // 上报的四列都是必填（`task_source` / `task_id` / `status` 在 DDL 里就是 NOT NULL）
  task_reports: ['task_source', 'task_id', 'status'],
  // 评论的 `body`（正文）与 `created_at` 在 DDL 里都是 NOT NULL —— 逐列查一遍，
  // 缺了给用户一句人话（400），而不是让 INSERT 撞约束变成 500。
  project_comments: ['body', 'created_at'],
  // 密码库这两张表的**每一个密文列都是必填**：它们在 DDL 里就是 NOT NULL，
  // 少一列直接插进去会撞约束、变成一句用户看不懂的 500。
  // 在这里逐列查一遍，用户拿到的是「备份文件第 N 条缺少必填内容（salt），已中止导入，未写入任何数据」。
  vault_meta: [
    'kdf',
    'kdf_params',
    'salt',
    'dek_iv',
    'dek_cipher',
    'dek_tag',
    'verifier_iv',
    'verifier_cipher',
    'verifier_tag',
  ],
  vault_items: ['iv', 'cipher', 'tag'],
};

/** 功能：按白名单挑列；值为 undefined 的列不写进去，交给表定义里的默认值 */
function pick(row, cols) {
  const out = {};
  cols.forEach((c) => {
    if (row[c] !== undefined) out[c] = row[c];
  });
  return out;
}

/** 功能：从备份对象里取某个表的数组（认新旧两种键名；缺失 / 类型不对一律当空表） */
function arrayOf(dump, spec) {
  for (const k of spec.keys) {
    if (Array.isArray(dump[k])) return dump[k];
  }
  return [];
}

/**
 *
 * 背景：整体备份的 `tables` 是**按表名做键**的（与 JSON 回退后端的数据文件同一个形状）。
 */
function withAliasedTableKeys(tables) {
  const out = Object.assign({}, tables);
  SCHEMA.aliases().forEach(([from, to]) => {
    if (!Array.isArray(out[from])) return; // 老键不在（或不是数组）→ 无事可做
    if (out[to] === undefined) out[to] = out[from];
    delete out[from];
  });
  return out;
}

/** 功能：数出某张表在整体备份里的条数（`settings` 是对象，按键数算） */
function countOf(tables, table) {
  return table === 'settings' ? Object.keys(tables[table] || {}).length : (tables[table] || []).length;
}

module.exports = {
  /**
   * 功能：导出一份**整体备份** —— 全库所有账号的数据与账号行，打成一份可直接下载的 JSON。
   *
   * 说明：⭐ `kind: 'org-backup'` 是**格式标记**，两个方向各用一次（009 报告 S6 把口径说准）：
   * ① 个人恢复（`importUserBackup`）**带 `kind: 'org-backup'` 一律拒**（拿整库备份当个人备份导是误操作）；
   * ② 整库恢复（`restoreWholeBackup`）**若带了 `kind` 就必须等于 `org-backup`**，主判据仍是
   */
  exportWholeBackup() {
    const tables = this._bk.exportWhole();
    const counts = {};
    Object.keys(tables).forEach((t) => {
      counts[t] = countOf(tables, t);
    });
    return {
      app: 'ZXDesk',
      kind: 'org-backup',
      version: this.appVersion,
      schemaVersion: this.schemaVersion,
      backend: this.backend,
      exportedAt: nowStamp(),
      counts,
      tables,
    };
  },

  /**
   * 功能：导出**整体备份压缩包**的全部材料 —— 全库 JSON 快照 + 一致的原始库文件 ＋ 一份摘要清单。
   *
   * `backup.json`（在线恢复真正读的那份：跨后端、跨版本、打开就能看懂）与**原始库文件**
   * （`zxdesk.db` / `zxdesk.json`，给「应用压根起不来」时手工放回数据目录用）。
   * 那时候唯一的路就是把库文件放回数据目录。只给 JSON 就救不了那种情况，
   */
  exportOrgBundle() {
    const dump = this.exportWholeBackup();
    const raw = this._bk.rawDump();
    // 附件条目（走任务板模块的公开方法，模块不在时为空）。
    const files = typeof this.collabFileBundle === 'function' ? this.collabFileBundle() : [];
    // 加密信息的附件**不进这份包** ——
    // 但必须在 manifest 里如实给出「未包含 N 个附件、共 X MB」，
    // 备份页与恢复预览才能把那句话显示出来（⛔ 只说「未包含」不说怎么办，等于把问题丢回去）。
    const secretRows = Array.isArray(dump.secrets_files) ? dump.secrets_files : [];
    const secretFiles = secretRows.length;
    const secretBytes = secretRows.reduce((sum, r) => sum + (Number(r && r.size) || 0), 0);
    return {
      manifest: {
        app: 'ZXDesk',
        kind: 'org-backup',
        formatVersion: 1,
        version: dump.version,
        schemaVersion: dump.schemaVersion,
        backend: dump.backend,
        exportedAt: dump.exportedAt,
        data: 'backup.json',
        // 老字段名（单数形式的 `raw`）**不改**：写进压缩包的 manifest 已经发出去很多份，
        // （读侧一律按数组处理，见 core/routes/backup.js）。
        raw: raw.map((r) => r.entry),
        // 附件条数（老包没有这个键 ⇒ 读侧按 0 / 未带附件处理）。
        files: files.length,
        // 加密信息的附件（**未包含**在包里的那一批：条数 ＋ 明文字节合计）。
        // 老包没有这两个键 ⇒ 读侧按 0 处理。
        secretFiles,
        secretBytes,
        counts: dump.counts,
      },
      raw,
      files,
      dump,
    };
  },

  /**
   * 功能：用一份整体备份**全量替换**当前库 —— 先给当前库另存一份快照，再整体写入。
   *
   * 说明：⚠️ 这是全项目**唯一会删用户数据**的操作，三重保护缺一不可：
   * ① 本方法内**先快照**（`snapshot` 原语；快照失败就中止 —— 没有退路的全量替换不做）；
   * ② 写库走 `replaceWhole`，它在**一个事务**里清空 + 写入，任何一步出错整库回滚；
   */
  restoreWholeBackup(dump) {
    this._assertWritable();
    if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw badRequest('备份文件不是有效的 JSON 对象');
    if (dump.app !== 'ZXDesk') throw badRequest('这不是 ZXDesk 的备份文件');
    // 009 报告 S6：上面 `exportWholeBackup` 的注释把 `kind` 说成「把误操作挡在门外」的格式标记，
    // 实现里却只靠 `tables` 的形状。这里补一道**宽松**校验：**带了 `kind` 就必须是 `org-backup`**
    // （「拿个人备份去恢复整库」是全项目最危险的一次误操作）；⚠️ **不带 `kind` 的老备份照旧放行** ——
    if (dump.kind !== undefined && dump.kind !== 'org-backup') {
      throw badRequest('这不是整体备份文件（格式标记对不上）。若你要恢复的是自己的任务数据，请用「导入我的数据」');
    }
    // **老 `.json` 备份必须继续能恢复** ——
    // 这份整体备份里的表名可能还是旧名（`chat_*` / `terms` …），先按改名映射归一成现表名。
    // 不做这一步的表现是「恢复完对话数据全没了」，而且**不报错**。
    const tables = withAliasedTableKeys(dump.tables);
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
      throw badRequest('这不是整体备份文件。若你要恢复的是自己的任务数据，请用「导入我的数据」');
    }
    if (!Array.isArray(tables.users) || !tables.users.length) {
      throw badRequest('这份整体备份里没有任何账号 —— 恢复它会得到一个谁都进不去的系统，已中止');
    }

    // 顺序不能反：先快照、后覆盖。快照失败必须中止（宁可恢复不了，也不能恢复完没法退回去）
    const backupFile = this._bk.snapshot('restore');
    // `replaceWhole()` 会回一份「哪些库被跳过」——
    // 一份**不含实验室**的旧备份不该把现有实验室库清空（失败方向 = 少删），
    const applied = this._bk.replaceWhole(tables) || {};
    const skippedDbs = Array.isArray(applied.skipped) ? applied.skipped : [];

    const counts = {};
    Object.keys(tables).forEach((t) => {
      counts[t] = countOf(tables, t);
    });
    return { backupFile, counts, skippedDbs };
  },

  /**
   * 功能：把一份**个人备份**导进指定账号 —— `merge` 只追加、`replace` 先清空该账号的业务数据。
   *
   * 说明：⭐ 两种语义的差别只有一处（要不要先清空），其余**共用同一条插入路径**：
   * 全部重新分配 id、外键重指到新建的父项、`user_id` 一律写成导入者自己。
   *
   */
  importUserBackup(uid, dump, mode) {
    this._assertWritable();
    if (mode !== 'merge' && mode !== 'replace') throw badRequest('导入方式只能是 merge（合并）或 replace（替换）');
    if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw badRequest('备份文件不是有效的 JSON 对象');
    if (dump.app !== 'ZXDesk') throw badRequest('这不是 ZXDesk 的备份文件');
    if (dump.kind === 'org-backup') throw badRequest('这是整体备份文件，请用「恢复整体备份」（需管理员权限）');

    const me = Number(uid);
    const plan = this._planImport(me, dump, mode);

    if (mode === 'replace') this._bk.clearUserData(me);
    this._bk.insertMany(plan.items);
    return { mode, counts: plan.counts };
  },

  /**
   * 功能：把一份个人备份**先完整翻译成待插入的行**（不写任何东西），顺带校验与计数。
   *
   * 说明：翻译分两步走 —— 先把行对象按「父项在前」的顺序造出来（子项的外键先写成
   * `{ __ref: 父项行 }` 这种延迟引用），再统一交给 `insertMany` 在一个事务里写。
   * 父项的行对象在插入时被就地回填 `id`，子项解析延迟引用时拿到的就是新 id。
   */
  _planImport(me, dump, mode) {
    const items = [];
    const counts = { _skipped: 0 };
    PERSONAL_SOURCES.forEach((s) => {
      counts[s.table] = 0;
    });

    /** 功能：登记一行（`user_id` 一律写成导入者自己），返回它供子项做延迟引用 */
    const add = (table, row) => {
      row.user_id = me;
      const item = { table, row };
      items.push(item);
      counts[table] += 1;
      return item;
    };

    /**
     * 功能：取源数组里第 index 行并校验 —— 不是对象、或必填列为空就抛 400（在写库之前）。
     * @returns {Object} 按白名单挑好列的行对象（尚未登记）
     */
    const asRow = (table, raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw badRequest(`备份文件里的「${table}」第 ${index + 1} 条不是一条有效记录`);
      }
      const row = pick(raw, COLS[table]);
      for (const col of REQUIRED[table]) {
        const v = row[col];
        if (v === undefined || v === null || String(v).trim() === '') {
          throw badRequest(
            `备份文件里的「${table}」第 ${index + 1} 条缺少必填内容（${col}），已中止导入，未写入任何数据`,
          );
        }
      }
      return row;
    };

    /**
     * 功能：按父项在源数组里的**位置**找到它已建出来的行。
     * 说明：父子关系在备份里是 `子.父_id === 父.id`，而我们把所有 id 都丢了 ——
     * 位置对应是唯一还留着的线索（`map` 保序，且我们逐行 push）。
     * @returns {?Object} 命中的父项包装；引用不到（孤儿）时为 null
     */
    const parentOf = (fkCol, srcRows, made, childRaw) => {
      const idx = srcRows.findIndex((r) => r && Number(r.id) === Number(childRaw[fkCol]));
      return idx >= 0 && made[idx] ? made[idx] : null;
    };

    /**
     * 功能：算合并模式的排序基准 —— 备份里的 `sort_order` 从 0 开始，直接用会与现有数据交错，
     * 所以整体后移到现有最大 `sort_order` 之后。
     * @returns {number} 需要后移的偏移量（现有数据为空时为 0）
     */
    const sortOffset = (rows) => (rows.length ? Math.max(...rows.map((r) => Number(r.sort_order) || 0)) + 1 : 0);

    // ---- 项目与项目任务 ----
    // `listProjects()` / `listDailyTasks()` 是**任务板模块**的方法，而任务板
    // 可以被整目录删掉。删掉之后硬调就是 `is not a function` ⇒
    const tasksOn = (f) => typeof this[f] === 'function';
    const srcProjects = arrayOf(dump, PERSONAL_SOURCES[0]);
    const projOffset = mode === 'merge' && tasksOn('listProjects') ? sortOffset(this.listProjects(me)) : 0;
    const madeProjects = srcProjects.map((raw, i) => {
      const row = asRow('projects', raw, i);
      if (projOffset) row.sort_order = (Number(row.sort_order) || 0) + projOffset;
      return add('projects', row);
    });
    arrayOf(dump, PERSONAL_SOURCES[1]).forEach((raw, i) => {
      const row = asRow('project_tasks', raw, i);
      const parent = parentOf('project_id', srcProjects, madeProjects, raw);
      if (!parent) {
        counts._skipped += 1;
        return;
      }
      row.project_id = { __ref: parent.row };
      add('project_tasks', row);
    });

    // ---- 日常任务 ----
    const dailyOffset = mode === 'merge' && tasksOn('listDailyTasks') ? sortOffset(this.listDailyTasks(me)) : 0;
    arrayOf(dump, PERSONAL_SOURCES[2]).forEach((raw, i) => {
      const row = asRow('daily_tasks', raw, i);
      if (dailyOffset) row.sort_order = (Number(row.sort_order) || 0) + dailyOffset;
      add('daily_tasks', row);
    });

    // ---- 课表：学期 → 时段块 / 逐节时间 / 课程 → 课次 ----
    const srcTerms = arrayOf(dump, PERSONAL_SOURCES[3]);
    const madeTerms = srcTerms.map((raw, i) => add('time_timetable_terms', asRow('time_timetable_terms', raw, i)));

    const srcBlocks = arrayOf(dump, PERSONAL_SOURCES[4]);
    const madeBlocks = srcBlocks.map((raw, i) => {
      const row = asRow('time_timetable_blocks', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      if (!parent) {
        counts._skipped += 1;
        return null;
      }
      row.term_id = { __ref: parent.row };
      return add('time_timetable_blocks', row);
    });

    arrayOf(dump, PERSONAL_SOURCES[5]).forEach((raw, i) => {
      const row = asRow('time_timetable_periods', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      if (!parent) {
        counts._skipped += 1;
        return;
      }
      row.term_id = { __ref: parent.row };
      // `block_id` 是纯派生缓存的指针（渲染层本来就容错）：源块被丢掉时留空，不据此丢弃整行
      const block = parentOf('block_id', srcBlocks, madeBlocks, raw);
      if (block) row.block_id = { __ref: block.row };
      add('time_timetable_periods', row);
    });

    const srcCourses = arrayOf(dump, PERSONAL_SOURCES[6]);
    const madeCourses = srcCourses.map((raw, i) => {
      const row = asRow('time_timetable_courses', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      if (!parent) {
        counts._skipped += 1;
        return null;
      }
      row.term_id = { __ref: parent.row };
      return add('time_timetable_courses', row);
    });

    const srcSessions = arrayOf(dump, PERSONAL_SOURCES[7]);
    const madeSessions = srcSessions.map((raw, i) => {
      const row = asRow('time_timetable_sessions', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      const course = parentOf('course_id', srcCourses, madeCourses, raw);
      if (!parent || !course) {
        counts._skipped += 1; // 课次缺学期或缺课程 → 插进去也是一条显示不出来的数据
        return null;
      }
      row.term_id = { __ref: parent.row };
      row.course_id = { __ref: course.row };
      return add('time_timetable_sessions', row);
    });

    arrayOf(dump, PERSONAL_SOURCES[8]).forEach((raw, i) => {
      const row = asRow('time_timetable_adjustments', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      const session = parentOf('session_id', srcSessions, madeSessions, raw);
      if (!parent || !session) {
        counts._skipped += 1; // 调课挂不上课次 → 插进去就是一条永远不生效的孤儿
        return;
      }
      row.term_id = { __ref: parent.row };
      row.session_id = { __ref: session.row };
      add('time_timetable_adjustments', row);
    });

    const srcBookmarks = arrayOf(dump, PERSONAL_SOURCES[9]);
    const madeBookmarks = srcBookmarks.map((raw, i) => add('bookmarks', asRow('bookmarks', raw, i)));

    const srcTags = arrayOf(dump, PERSONAL_SOURCES[10]);
    const madeTags = srcTags.map((raw, i) => add('bookmark_tags', asRow('bookmark_tags', raw, i)));

    // 关联行**没有自己的数据**（就两个外键），所以只保留能同时挂上两端的那些：
    // 一端挂不上就丢掉并计数 —— 硬插会撞外键（SQLite）或留下永远显示不出来的关联行（JSON）。
    arrayOf(dump, PERSONAL_SOURCES[11]).forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw badRequest(`备份文件里的「bookmark_tag_links」第 ${i + 1} 条不是一条有效记录`);
      }
      const bookmark = parentOf('bookmark_id', srcBookmarks, madeBookmarks, raw);
      const tag = parentOf('tag_id', srcTags, madeTags, raw);
      if (!bookmark || !tag) {
        counts._skipped += 1;
        return;
      }
      add('bookmark_tag_links', { bookmark_id: { __ref: bookmark.row }, tag_id: { __ref: tag.row } });
    });

    arrayOf(dump, PERSONAL_SOURCES[12]).forEach((raw, i) => {
      add('hardware_items', asRow('hardware_items', raw, i));
    });

    // 与上面那一段**谁先谁后都行**：`hardware_items.template_id` 刻意不在 `COLS` 里
    // （它是「那台机器上的模板 id」，与 `group_id` 同类）⇒ 导入后那些硬件按「通用」显示，
    // 一个外键都不需要重指。
    arrayOf(dump, PERSONAL_SOURCES[46]).forEach((raw, i) => {
      add('hardware_templates', asRow('hardware_templates', raw, i));
    });

    // 为什么不能合并：密码库是**一个不可拆的整体** —— 条目是用 `vault_meta` 里那把 DEK 加密的，
    // 两套密码库（各有一把 DEK、一个盐）合并到一起的物理结果不是「两个库」，
    // 而是「一些用 A 的密钥加密的条目 + 一些用 B 的密钥加密的条目 + 只能保存一行的 meta」
    const srcVaultMeta = arrayOf(dump, PERSONAL_SOURCES[13]);
    const srcVaultItems = arrayOf(dump, PERSONAL_SOURCES[14]);
    if (mode !== 'replace') {
      counts._skipped += srcVaultMeta.length + srcVaultItems.length;
    } else if (srcVaultMeta.length) {
      // 只认**第一行**：`vault_meta` 的主键就是 `user_id`，一个账号只能有一行。
      // 备份里出现多行只可能是被人手工改过 —— 与其猜哪行是对的，不如取第一行并让其余进跳过计数。
      add('vault_meta', asRow('vault_meta', srcVaultMeta[0], 0));
      counts._skipped += Math.max(0, srcVaultMeta.length - 1);
      srcVaultItems.forEach((raw, i) => add('vault_items', asRow('vault_items', raw, i)));
    } else if (srcVaultItems.length) {
      // 有条目却没有开库材料 → 搬过去也永远解不开，一律丢掉并计数（与孤儿行同一种处理）
      counts._skipped += srcVaultItems.length;
    }

    // 与单次调课不同：调休**不挂课次**，所以没有第二个父项要解析、也没有第二种「挂不上」的情形。
    // 它按天存公历日期，`date` / `kind` / `to_date` 原样搬，只有 `term_id` 改指刚建出来的学期。
    // 这里**不会**撞 `time_timetable_day_rules` 的 `(user_id, term_id, date)` 唯一索引：
    arrayOf(dump, PERSONAL_SOURCES[15]).forEach((raw, i) => {
      const row = asRow('time_timetable_day_rules', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      if (!parent) {
        counts._skipped += 1; // 挂不上学期 → 插进去就是一条永远不生效的孤儿
        return;
      }
      row.term_id = { __ref: parent.row };
      add('time_timetable_day_rules', row);
    });

    // 与假期调休不同、与单次调课相同：它同时挂学期与课次 ⇒ 两个父项都要解析，
    // 任一挂不上就丢掉并计数（硬插会撞外键，或者留下一条永远显示不出来的孤儿行）。
    // `date` / `note` 原样搬，只有两个外键改指刚建出来的行。
    arrayOf(dump, PERSONAL_SOURCES[17]).forEach((raw, i) => {
      const row = asRow('time_timetable_day_notes', raw, i);
      const parent = parentOf('term_id', srcTerms, madeTerms, raw);
      const session = parentOf('session_id', srcSessions, madeSessions, raw);
      if (!parent || !session) {
        counts._skipped += 1;
        return;
      }
      row.term_id = { __ref: parent.row };
      row.session_id = { __ref: session.row };
      add('time_timetable_day_notes', row);
    });

    // ---- AI 长期记忆（2 期， 步骤 4-3）：单表、无父子、无外键 —— 逐行搬即可 ----
    // 只搬**记忆**这一张：AI 配置（`key_*` 密文绑本实例的 KEK，换台机器永远解不开）与会话
    // （过程记录）都不进个人备份 —— 三条取舍写在 `modules/ai/export.js` 的文件头。
    arrayOf(dump, PERSONAL_SOURCES[16]).forEach((raw, i) => {
      add('ai_memories', asRow('ai_memories', raw, i));
    });

    // 与硬件那一批同款：`id` 不给（导入时重新分配）、`user_id` 不给（一律写成导入者自己），
    // 两者都会被 `COLS.idea_items` 挡在外面；`content` 不能为空由 `REQUIRED` 逐行查。
    // `task_id` / `task_source` 也被列白名单挡着（机器本地的 id 不能跨机器搬）。
    const srcIdeas = arrayOf(dump, PERSONAL_SOURCES[18]);
    const madeIdeas = srcIdeas.map((raw, i) => add('idea_items', asRow('idea_items', raw, i)));

    // 标签是**用户自己起的名字**、关联是「哪条随手记归了哪个标签」⇒ 换机 / 恢复之后都不能丢。
    // 只搬老列 `idea_items.tags` 而不搬这两张表，等于「恢复之后左栏标签全没、按标签筛选全空」。
    // **双认**（老 `.json` 备份必须继续能恢复）：
    // 备份里**有** `idea_tags`（新格式）⇒ 按它建标签、按 `idea_tag_links` 建关联；
    const legacyTagsOf = (raw) => {
      const out = [];
      const src = raw ? raw.tags : null;
      const push = (x) => {
        const v = String(x == null ? '' : x).trim();
        if (v && !out.includes(v)) out.push(v);
      };
      if (Array.isArray(src)) {
        src.forEach(push);
      } else if (typeof src === 'string' && src.trim()) {
        try {
          const arr = JSON.parse(src);
          if (Array.isArray(arr)) arr.forEach(push);
        } catch (_e) {
          // 坏 JSON = 没有标签（与 oldColTags 同一条口径）
        }
      }
      if (!out.length && raw && raw.tag) out.push(String(raw.tag));
      return out;
    };

    const srcIdeaTags = Array.isArray(dump['idea_tags']) ? dump['idea_tags'] : null;
    const madeIdeaTags = [];
    const tagByName = new Map();
    if (srcIdeaTags) {
      // 新格式：标签行照 `bookmark_tags` 那样逐行搬（`name` 不能为空由 `REQUIRED` 逐行查）。
      srcIdeaTags.forEach((raw, i) => {
        const item = add('idea_tags', asRow('idea_tags', raw, i));
        madeIdeaTags.push(item);
        tagByName.set(String(item.row.name), item);
      });
      // 关联行**没有自己的数据**（就两个外键）⇒ 只保留能同时挂上两端的那些（照 `bookmark_tag_links`）：
      // 一端挂不上就丢掉并计数 —— 硬插会撞外键（SQLite）或留下永远显示不出来的关联行（JSON）。
      arrayOf(dump, PERSONAL_SOURCES[45]).forEach((raw, i) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw badRequest(`备份文件里的「idea_tag_links」第 ${i + 1} 条不是一条有效记录`);
        }
        const idea = parentOf('idea_id', srcIdeas, madeIdeas, raw);
        const tag = parentOf('tag_id', srcIdeaTags, madeIdeaTags, raw);
        if (!idea || !tag) {
          counts._skipped += 1;
          return;
        }
        add('idea_tag_links', { idea_id: { __ref: idea.row }, tag_id: { __ref: tag.row } });
      });
    } else {
      // 更老的库里只有单值列 `tag`，两者都由 `legacyTagsOf()` 读出来（口径同 `oldColTags()`）。
      // 标签名**全局去重**（`tagByName`）：同一个名字在两条随手记上都出现，只建一行标签。
      srcIdeas.forEach((raw, i) => {
        const idea = madeIdeas[i];
        if (!idea) return;
        legacyTagsOf(raw).forEach((name) => {
          let tag = tagByName.get(name);
          if (!tag) {
            tag = add('idea_tags', { name });
            madeIdeaTags.push(tag);
            tagByName.set(name, tag);
          }
          add('idea_tag_links', { idea_id: { __ref: idea.row }, tag_id: { __ref: tag.row } });
        });
      });
    }

    // 与硬件那一批同款：`id` 不给（导入时重新分配）、`user_id` 不给（一律写成导入者自己），
    // 两者都会被 `COLS.time_pomodoro_sessions` 挡在外面；`started_at` / `planned_seconds` / `date`
    // 不能为空由 `REQUIRED` 逐行查。
    arrayOf(dump, PERSONAL_SOURCES[19]).forEach((raw, i) => {
      add('time_pomodoro_sessions', asRow('time_pomodoro_sessions', raw, i));
    });

    // ---- 番茄钟的时长偏好：**只在「替换」导入里搬，合并模式整块跳过**（与密码库同一条理由）----
    // `time_pomodoro_prefs` 是**每账号一行**（`UNIQUE(user_id)`），而本机多半已经有一行 ——
    // 合并模式下硬插会撞唯一约束（SQLite 直接抛、整份导入当场失败）。
    const srcPomodoroPrefs = arrayOf(dump, PERSONAL_SOURCES[20]);
    if (mode !== 'replace') {
      counts._skipped += srcPomodoroPrefs.length;
    } else if (srcPomodoroPrefs.length) {
      // 只认**第一行**：表上就是「一人一行」，备份里出现多行只可能是被人手工改过 ——
      // 与其猜哪行是对的，不如取第一行并让其余进跳过计数（与 `vault_meta` 同款处理）。
      add('time_pomodoro_prefs', asRow('time_pomodoro_prefs', srcPomodoroPrefs[0], 0));
      counts._skipped += Math.max(0, srcPomodoroPrefs.length - 1);
    }

    // 与灵感库 / 番茄钟那一批同款：`id` 不给（导入时重新分配）、`user_id` 不给
    // （一律写成导入者自己），两者都会被 `COLS.calendar_events` 挡在外面；
    // `title` / `date` 不能为空由 `REQUIRED` 逐行查。
    arrayOf(dump, PERSONAL_SOURCES[21]).forEach((raw, i) => {
      add('calendar_events', asRow('calendar_events', raw, i));
    });

    // ---- 日历的图层开关：**只在「替换」导入里搬，合并模式整块跳过**（与密码库 / 番茄钟同一条理由）----
    // `calendar_prefs` 是**每账号一行**（`UNIQUE(user_id)`），而本机多半已经有一行 ——
    // 合并模式下硬插会撞唯一约束（SQLite 直接抛、整份导入当场失败）。
    const srcCalendarPrefs = arrayOf(dump, PERSONAL_SOURCES[22]);
    if (mode !== 'replace') {
      counts._skipped += srcCalendarPrefs.length;
    } else if (srcCalendarPrefs.length) {
      // 只认**第一行**：表上就是「一人一行」，备份里出现多行只可能是被人手工改过 ——
      // 与其猜哪行是对的，不如取第一行并让其余进跳过计数（与 `vault_meta` 同款处理）。
      add('calendar_prefs', asRow('calendar_prefs', srcCalendarPrefs[0], 0));
      counts._skipped += Math.max(0, srcCalendarPrefs.length - 1);
    }

    // 与硬件 / 灵感库那一批同款：`id` 不给（导入时重新分配）、`user_id` 不给
    // （一律写成导入者自己），两者都会被 `COLS.ledger_accounts` 挡在外面；
    // `kind` / `name` / `opening_fen` 不能为空由 `REQUIRED` 逐行查。
    const acctByOldId = new Map();
    arrayOf(dump, PERSONAL_SOURCES[23]).forEach((raw, i) => {
      const row = asRow('ledger_accounts', raw, i);
      if (raw && raw.id !== undefined) acctByOldId.set(Number(raw.id), row);
      add('ledger_accounts', row);
    });

    // ---- 记账的净值快照（一人一天一行，多行）----
    // 与 `calendar_prefs` **刻意不同**：它**两种模式都搬** ——
    // `ledger_snapshots` 不是「一人一行的配置」（那种表合并时没有正确解），
    const srcSnapshots = arrayOf(dump, PERSONAL_SOURCES[24]);
    const takenDates =
      mode === 'replace' ? null : new Set(this._bk.exportLedger(me).ledger_snapshots.map((r) => String(r.date || '')));
    srcSnapshots.forEach((raw, i) => {
      const row = asRow('ledger_snapshots', raw, i);
      if (takenDates && takenDates.has(String(row.date))) {
        counts._skipped += 1; // 同一天已有一行：合并模式不许覆盖历史（「合并」= 只追加）
        return;
      }
      add('ledger_snapshots', row);
    });

    // ---- 记账的自定义分类（视图）：一套一行、无父项 ----
    // 与账户同款：`id` / `user_id` 由导入逻辑决定（`COLS.ledger_views` 挡在外面）。
    const viewByOldId = new Map();
    arrayOf(dump, PERSONAL_SOURCES[25]).forEach((raw, i) => {
      const row = asRow('ledger_views', raw, i);
      if (raw && raw.id !== undefined) viewByOldId.set(Number(raw.id), row);
      add('ledger_views', row);
    });

    // ---- 记账的用途归属（账户 × 分类 → 用途名）----
    // **两个外键都必须重指**（`view_id` / `account_id` 在两台机器上不是同一个数）：
    // 一条都看不见（组小计按账户算），而备份文件看上去完全正常。
    arrayOf(dump, PERSONAL_SOURCES[26]).forEach((raw, i) => {
      const row = asRow('ledger_view_tags', raw, i);
      const acc = acctByOldId.get(Number(raw && raw.account_id));
      const vw = viewByOldId.get(Number(raw && raw.view_id));
      if (!acc || !vw) {
        counts._skipped += 1;
        return;
      }
      row.account_id = { __ref: acc };
      row.view_id = { __ref: vw };
      add('ledger_view_tags', row);
    });

    // 「这笔转账指向别人的账户或不存在的账户」—— 界面上要么显示错的对象，
    // 要么整个账户的明细里凭空多出一笔不属于它的钱，而备份文件看上去完全正常。
    // 任一侧的父账户不在备份里 ⇒ **跳过并计数**（⛔ 不静默、⛔ 不插悬空行）——
    arrayOf(dump, PERSONAL_SOURCES[27]).forEach((raw, i) => {
      const row = asRow('ledger_transfers', raw, i);
      const from = acctByOldId.get(Number(raw && raw.from_id));
      const to = acctByOldId.get(Number(raw && raw.to_id));
      if (!from || !to) {
        counts._skipped += 1;
        return;
      }
      row.from_id = { __ref: from };
      row.to_id = { __ref: to };
      add('ledger_transfers', row);
    });

    // 它**没有任何外键**（`gkey` 是模块自己的稳定键，不是 id）⇒ 直接搬，不用重指；
    // 与快照 / 转账一样是**多行**（一人 9 + N 行）⇒ 两种模式都搬。
    arrayOf(dump, PERSONAL_SOURCES[28]).forEach((raw, i) => {
      const row = asRow('ledger_groups', raw, i);
      add('ledger_groups', row);
    });

    // 本段**排在条目那一段之前**（虽然 `ledger_categories` 在 `PERSONAL_SOURCES` 里是第 31 项）：
    // 条目的 `category_id` 要指向刚建出来的分类行，而 `{ __ref: 行 }` 的解析发生在
    // `insertMany()` **插入那一刻**（`deref()`）⇒ 被引用者必须先插好（「父项在前」这条总规矩）。
    const srcCats = arrayOf(dump, PERSONAL_SOURCES[30]);
    const catByOldId = new Map();
    /** 功能：取这条分类的**父分类原 id**；一级（NULL / 缺列 / 空串）回 null */
    const parentIdOf = (raw) => {
      const v = raw ? raw.parent_id : null;
      return v === undefined || v === null || v === '' ? null : Number(v);
    };
    /** 功能：登记一条分类，返回落进 items 的那一项；父分类指不到时为 null（孤儿） */
    const addCategory = (raw, index) => {
      const row = asRow('ledger_categories', raw, index);
      const pid = parentIdOf(raw);
      if (pid === null) {
        row.parent_id = null; // 一级：保持 NULL
      } else {
        const parent = catByOldId.get(pid);
        if (!parent) return null; // 插进去就是一条永远显示不出来的二级分类
        row.parent_id = { __ref: parent };
      }
      if (raw && raw.id !== undefined) catByOldId.set(Number(raw.id), row);
      return add('ledger_categories', row);
    };
    const srcCatRows = srcCats.map((raw, i) => ({ raw, index: i }));
    const topCatRows = srcCatRows.filter((e) => parentIdOf(e.raw) === null);
    const subCatRows = srcCatRows.filter((e) => parentIdOf(e.raw) !== null);
    // 一趟：一级（`parent_id` 为空）
    topCatRows.forEach((e) => {
      if (!addCategory(e.raw, e.index)) counts._skipped += 1;
    });
    // 二趟：二级（父此刻已建好）
    subCatRows.forEach((e) => {
      if (!addCategory(e.raw, e.index)) counts._skipped += 1;
    });

    // `refund_of` 只能靠**插入顺序**解决，不能靠「先全插、再回填」：`{ __ref: 行 }` 在
    // `insertMany()` 插入那一刻就被 `deref()` 解成 `行.id`，而**后端没有一条能改 `refund_of`
    // 的原语**（`updateLedgerEntry()` 的 SET 里没有它 ——  第 8 条「只增不改不删」）。
    const srcEntries = arrayOf(dump, PERSONAL_SOURCES[29]);
    const entryByOldId = new Map();
    /** 功能：登记一条条目（账户必填、分类可空，两列都重指）；`refund_of` 由调用方决定 */
    const addEntry = (raw, index) => {
      const row = asRow('ledger_entries', raw, index);
      // 账户是**父项**（DDL 里 NOT NULL）：备份里没有那一行（例如那个账户已被硬删）就没有能指的
      // 对象 ⇒ 跳过并计数（照 `ledger_transfers` 那条纪律，⛔ 不插指向不存在账户的 id）。
      const acc = acctByOldId.get(Number(raw && raw.account_id));
      if (!acc) return null;
      row.account_id = { __ref: acc };
      // `category_id` 可空：`NULL` = **未分类**（这与「其它」是一个真分类是两件事）—— 保持 NULL，
      // 不写 0。分类行不在备份里时也只把指针留空：这一行本身仍是一笔完整的账，
      // 不该为了一个分类丢掉一笔钱（与 `time_timetable_periods.block_id` 同一条取舍）。
      const cid =
        raw && raw.category_id !== undefined && raw.category_id !== null && raw.category_id !== ''
          ? Number(raw.category_id)
          : null;
      const cat = cid === null ? null : catByOldId.get(cid);
      row.category_id = cat ? { __ref: cat } : null;
      return add('ledger_entries', row);
    };
    const pendingRefunds = [];
    srcEntries.forEach((raw, i) => {
      const ref = raw && raw.refund_of !== undefined && raw.refund_of !== null && raw.refund_of !== '';
      if (ref) {
        pendingRefunds.push({ raw, index: i, ref: Number(raw.refund_of) });
        return;
      }
      const item = addEntry(raw, i); // 一趟：不是退款的条目
      if (!item) {
        counts._skipped += 1;
        return;
      }
      if (raw && raw.id !== undefined) entryByOldId.set(Number(raw.id), item.row);
    });
    // 二趟：退款条目 —— 每插一条就进 `entryByOldId`，所以「退款的退款」那种链会被逐轮解开
    for (let round = 0; pendingRefunds.length && round <= srcEntries.length; round += 1) {
      let moved = 0;
      for (let k = pendingRefunds.length - 1; k >= 0; k -= 1) {
        const e = pendingRefunds[k];
        const orig = entryByOldId.get(e.ref);
        if (!orig) continue; // 原交易还没插进去（或根本不在备份里）—— 留到下一轮
        const item = addEntry(e.raw, e.index);
        if (item) {
          item.row.refund_of = { __ref: orig };
          if (e.raw && e.raw.id !== undefined) entryByOldId.set(Number(e.raw.id), item.row);
        } else {
          counts._skipped += 1; // 账户不在备份里 ⇒ 这条退款进不来
        }
        pendingRefunds.splice(k, 1);
        moved += 1;
      }
      if (!moved) break; // 一轮都没插动 ⇒ 剩下的都是「原交易不在备份里 / 成环」，别再空转
    }
    // 留空它还在（与上面 `category_id` 同一条取舍），而且**绝不留悬空数字**
    pendingRefunds.forEach((e) => {
      const item = addEntry(e.raw, e.index);
      if (!item) {
        counts._skipped += 1;
        return;
      }
      item.row.refund_of = null;
      counts._skipped += 1; // ⛔ 不静默：界面上会如实说「跳过 N 条」
    });

    // `category_id = 0` 是「全局两层」的**哨兵**（SQLite 的 `UNIQUE` 把 NULL 当作互不相等，
    // `catByOldId` 查：真去查只会查不到，然后把全局两层错当成孤儿丢掉
    // （表现是「恢复后默认账户设置全没了」）。⇒ 哪一层**由 `kind` 决定**：全局两行恒写 `0`，
    const srcDefaults = arrayOf(dump, PERSONAL_SOURCES[31]);
    const takenDefaults =
      mode === 'replace'
        ? null
        : new Set(this._bk.listLedgerDefaults(me).map((r) => `${String(r.kind)}:${Number(r.category_id) || 0}`));
    srcDefaults.forEach((raw, i) => {
      const row = asRow('ledger_default_accounts', raw, i);
      const kind = String(row.kind);
      const isGlobal = kind === 'income' || kind === 'expense';
      if (isGlobal) {
        row.category_id = 0; // 全局两层：哨兵**保持 0**（⛔ 不重指）
        if (takenDefaults && takenDefaults.has(`${kind}:0`)) {
          counts._skipped += 1; // 本机已经有这一层（「合并」= 只追加，⛔ 不覆盖本机设置）
          return;
        }
      } else {
        const cat = catByOldId.get(Number(row.category_id));
        if (!cat) {
          counts._skipped += 1; // 类别行不在备份里 ⇒ 这一层没有落点
          return;
        }
        row.category_id = { __ref: cat };
      }
      const acc = acctByOldId.get(Number(raw && raw.account_id));
      if (!acc) {
        counts._skipped += 1; // 账户行不在备份里（已被硬删）⇒ 这一层没有落点
        return;
      }
      row.account_id = { __ref: acc };
      add('ledger_default_accounts', row);
    });

    // `account_id` **保持原值、⛔ 绝不重指** —— 这是本次登记里唯一「不重指」的一张表：
    // 它记的是「**被删掉的那个账户的原 id**」，而那个账户在备份里**根本没有行**（删账户是
    // 「那个原 id ⇒ 原名字」——转账 / 流水 / 手动调整**都还留着那个原 id**，界面靠它显示
    const srcDeletions = arrayOf(dump, PERSONAL_SOURCES[32]);
    const takenDeletions =
      mode === 'replace' ? null : new Set(this._bk.listLedgerAccountDeletions(me).map((r) => Number(r.account_id)));
    srcDeletions.forEach((raw, i) => {
      const row = asRow('ledger_account_deletions', raw, i);
      if (takenDeletions && takenDeletions.has(Number(row.account_id))) {
        counts._skipped += 1;
        return;
      }
      add('ledger_account_deletions', row);
    });

    // 混排少一档，而余额派生的**基准**也退化成「建账户时那个数」
    // ⇒ 界面上的余额与备份里的数对不上，而且**不报错**。
    // `account_id` → 新建出来的账户行；账户行不在备份里（已被硬删）⇒ 跳过并计数
    arrayOf(dump, PERSONAL_SOURCES[33]).forEach((raw, i) => {
      const row = asRow('ledger_adjustments', raw, i);
      const acc = acctByOldId.get(Number(raw && raw.account_id));
      if (!acc) {
        counts._skipped += 1;
        return;
      }
      row.account_id = { __ref: acc };
      add('ledger_adjustments', row);
    });

    // `category_id` 要按**旧分类 id → 刚建出来的那一行**重指（`ledger_categories` 的 id
    // 在导入时是重新分配的）—— 与流水 / 默认账户那两段同一条纪律：
    // `0` 是**总预算哨兵**，保持 `0`、⛔ 不重指（它本来就不指向任何分类行）；
    const srcBudgets = arrayOf(dump, PERSONAL_SOURCES[34]);
    const takenBudgets =
      mode === 'replace'
        ? null
        : new Set(
            this._bk
              .listLedgerBudgetsByUser(me)
              .map((r) => `${String(r.period_type)}:${String(r.period_key)}:${Number(r.category_id) || 0}`),
          );
    srcBudgets.forEach((raw, i) => {
      const row = asRow('ledger_budgets', raw, i);
      const cid = Number(row.category_id) || 0;
      if (cid > 0) {
        const cat = catByOldId.get(cid);
        if (!cat) {
          counts._skipped += 1; // 分类行不在备份里 ⇒ 这一维度额没有落点
          return;
        }
        row.category_id = { __ref: cat };
      } else {
        row.category_id = 0; // 总预算：哨兵**保持 0**（⛔ 不重指）
      }
      const key = `${String(row.period_type)}:${String(row.period_key)}:${cid}`;
      if (takenBudgets && takenBudgets.has(key)) {
        counts._skipped += 1; // 本机已经有这一期这一维（「合并」= 只追加，⛔ 不覆盖本机额度）
        return;
      }
      add('ledger_budgets', row);
    });

    // 「导入的三方数据要进入个人备份」—— 从前它刻意不进。
    // `batch_id` 是**那台机器上的**批次号（`MAX+1` 生成）⇒ ⛔ **不能照搬**：
    // 合并到一台已经有导入数据的机器上会撞 `UNIQUE(user_id, batch_id, row_no)`，
    const srcImported = arrayOf(dump, PERSONAL_SOURCES[35]);
    let nextImportedBatch = Number(this._bk.nextImportBatchId(me, 'shayu')) || 1;
    const importedBatchMap = new Map();
    srcImported.forEach((raw, i) => {
      const row = asRow('shayu', raw, i);
      const oldBatch = Number(row.batch_id) || 0;
      if (!importedBatchMap.has(oldBatch)) {
        importedBatchMap.set(oldBatch, nextImportedBatch);
        nextImportedBatch += 1;
      }
      row.batch_id = importedBatchMap.get(oldBatch);
      add('shayu', row);
    });

    // 四张表**都要搬**：车票与轨迹是**已经发生过的事实凭证**，无法重新产生
    // （与三方导入「可重导所以不进」正好相反）；漏一处就是「备份看着成功、恢复后行程全没」。
    // 车票与点的 `trip_id` 是**那台机器上的行程 id** ⇒ 建完行程后按旧 id 找新行、用 `{ __ref }`
    const tripByOldId = new Map();
    arrayOf(dump, PERSONAL_SOURCES[36]).forEach((raw, i) => {
      const item = add('time_trips', asRow('time_trips', raw, i));
      if (raw && raw.id !== undefined) tripByOldId.set(Number(raw.id), item.row);
    });
    /** 功能：把一行的 `trip_id` 重指到刚建出来的行程（找不到 / 本来就是空 ⇒ null） */
    const refTrip = (raw) => {
      const t =
        raw && raw.trip_id !== undefined && raw.trip_id !== null && raw.trip_id !== '' ? Number(raw.trip_id) : null;
      if (t === null) return null;
      const parent = tripByOldId.get(t);
      return parent ? { __ref: parent } : null;
    };
    arrayOf(dump, PERSONAL_SOURCES[37]).forEach((raw, i) => {
      const row = asRow('time_trip_tickets', raw, i);
      row.trip_id = refTrip(raw);
      add('time_trip_tickets', row);
    });
    arrayOf(dump, PERSONAL_SOURCES[38]).forEach((raw, i) => {
      const row = asRow('time_trip_points', raw, i);
      row.trip_id = refTrip(raw);
      add('time_trip_points', row);
    });
    // ---- 三档提醒开关：**只在「替换」导入里搬，合并模式整块跳过**（与日历 / 番茄钟同一条理由）----
    // `time_trip_prefs` 是**每账号一行**（`UNIQUE(user_id)`），而本机多半已经有一行 ——
    // 合并模式下硬插会撞唯一约束（SQLite 直接抛、整份导入当场失败），
    const srcTripPrefs = arrayOf(dump, PERSONAL_SOURCES[39]);
    if (mode !== 'replace') {
      counts._skipped += srcTripPrefs.length;
    } else if (srcTripPrefs.length) {
      // 只认**第一行**：表上就是「一人一行」，多行只可能是被手工改过（与 `calendar_prefs` 同款）
      add('time_trip_prefs', asRow('time_trip_prefs', srcTripPrefs[0], 0));
      counts._skipped += Math.max(0, srcTripPrefs.length - 1);
    }

    // 本段**排在条目那一段之前**（虽然 `asset_groups` 在 `PERSONAL_SOURCES` 里是第 41 项）：
    // 条目的 `group_id` 要指向刚建出来的分组行。⚠️ 但 `group_id` **整列不搬**
    // （见 `COLS` 上面那一段说明与 `backup.test.js` 的跳过表）⇒ 这里只处理分组树自己
    const srcAssetGroups = arrayOf(dump, PERSONAL_SOURCES[40]);
    const assetGroupByOldId = new Map();
    /** 功能：取这一条分组的**父分组原 id**；第一层（NULL / 缺列 / 空串）回 null */
    const assetParentIdOf = (raw) => {
      const v = raw ? raw.parent_id : null;
      return v === undefined || v === null || v === '' ? null : Number(v);
    };
    /** 功能：登记一个分组，返回落进 items 的那一项；父分组指不到时为 null（孤儿） */
    const addAssetGroup = (raw, index) => {
      const row = asRow('asset_groups', raw, index);
      const pid = assetParentIdOf(raw);
      if (pid === null) {
        row.parent_id = null;
      } else {
        const parent = assetGroupByOldId.get(pid);
        if (!parent) return null;
        row.parent_id = { __ref: parent };
      }
      if (raw && raw.id !== undefined) assetGroupByOldId.set(Number(raw.id), row);
      return add('asset_groups', row);
    };
    const srcAssetRows = srcAssetGroups.map((raw, i) => ({ raw, index: i }));
    srcAssetRows
      .filter((e) => assetParentIdOf(e.raw) === null)
      .forEach((e) => {
        if (!addAssetGroup(e.raw, e.index)) counts._skipped += 1;
      });
    srcAssetRows
      .filter((e) => assetParentIdOf(e.raw) !== null)
      .forEach((e) => {
        if (!addAssetGroup(e.raw, e.index)) counts._skipped += 1;
      });
    // 通用条目：`group_id` **不搬**（见上）⇒ 恢复之后它们是「未归类」，一条都不少。
    arrayOf(dump, PERSONAL_SOURCES[41]).forEach((raw, i) => {
      add('asset_items', asRow('asset_items', raw, i));
    });

    // `task_source` + `task_id` 原样搬（成对），**不重指** ——
    // 任务 id 在本机由导入重新分配，重指做不到「知道他当时说的是哪条」；
    // 而照搬一个数字更糟（会挂到别人的任务上）。⇒ 第一版的取舍：宁可那条上报挂不上、不显示，
    arrayOf(dump, PERSONAL_SOURCES[42]).forEach((raw, i) => {
      add('task_reports', asRow('task_reports', raw, i));
    });

    // `project_id` 是**那台机器上的项目 id** ⇒ 由这里重指到刚建出来的项目；
    // 找不到对应项目（评在别人的项目上 / 项目已删）⇒ **跳过并计数**（如实告诉用户，⛔ 不静默）。
    // `task_id` **不重指**（`C-8`）—— 跨机器搬任务 id 没有意义。
    arrayOf(dump, PERSONAL_SOURCES[43]).forEach((raw, i) => {
      const row = asRow('project_comments', raw, i);
      const parent = parentOf('project_id', srcProjects, madeProjects, raw);
      if (!parent) {
        counts._skipped += 1;
        return;
      }
      row.project_id = { __ref: parent.row };
      add('project_comments', row);
    });

    // 附件是**二进制**，个人备份是 JSON 快照装不下；它由**整体备份**的 zip `files/` 覆盖。
    // 照N 条」），
    // 绝不静默 —— 导一份带附件的备份时，用户要看得到「附件没进来」这件事。
    counts._skipped += arrayOf(dump, { table: 'project_files', keys: ['project_files'] }).length;

    // 理由：附件根本不在这份 JSON 里（导出侧只带 `secrets` 正文），
    // 而它的文件更不可能被塞进一个 JSON 快照。这里与 `project_files` 逐字同款：
    // 备份里若真有这些行（手工改过 / 将来版本带上了），**如实计数**，⛔ 不静默吞掉。
    counts._skipped += arrayOf(dump, { table: 'secrets_files', keys: ['secrets_files'] }).length;

    // 为什么连「替换」也不搬（与密码库刻意不同）：对话是**跨账号数据** ——
    // 一条消息同时属于两个人，而备份里的 `friend_id` / `conversation_id` 是**那台机器上的账号 id
    // 与会话 id**。换一台 NAS 导进来，重建出来的是「指向不存在的人」的好友关系与「只有我一个人的会话」，
    const oldKeyOf = new Map(SCHEMA.aliases().map(([from, to]) => [to, from]));
    ['teamwork_friendships', 'teamwork_conversations', 'teamwork_members', 'teamwork_messages', 'teamwork_cleared'].forEach(
      (k) => {
        const now = dump[k];
        const rows = Array.isArray(now) && now.length ? now : dump[oldKeyOf.get(k)];
        counts._skipped += Array.isArray(rows) ? rows.length : 0;
      },
    );

    return { items, counts };
  },
};
