'use strict';
/**
 * modules/teamwork/schema.js —— **团队协作模块**（0.3.5；0.8.12 前叫 `chat`/「对话」）
 *
 * 功能：声明本模块的**十三张表** —— 对话（好友 · 一对一私聊）的
 *      `teamwork_friendships`（好友关系，**双向两行**）/ `teamwork_conversations`（会话）/
 *      `teamwork_members`（会话成员 = **判权的唯一依据** + 各自的已读位置）/ `teamwork_messages`（消息），
 *      以及 ⭐ 0.8.12 · 2b从 `modules/tasks` 搬来的**五张协作表** ——
 *      `project_members` / `task_reports` / `collab_states` / `project_comments` / `project_files`
 *      （判据 `taskShareGuard` 与接口 `/api/collab/*` 本就在本模块，表跟着搬，判权与表同处一个模块），
 *      并给出它们的 DDL 生成器、列白名单、级联清空清单与索引语句。
 *
 * ⚠️⭐ **两张地基表 `projects` / `project_tasks` 留在 `modules/tasks`**（搬了任务板就得依赖本模块
 *    才跑得起来）—— 那两张表的一切（DDL / `ensureColumns` / `allowedCols` / `userScoped` / 索引）
 *    ⛔ 一个字都没搬。本模块的业务层要用它们，只走 `tasks` 的**公开业务方法**（先例：
 *    `collabTasks()` 调 `this.listProjectTasks(…)`），⛔ 不 require 它的文件。
 *    ⚠️ **取数原语 `findProjectById()` 留在 `tasks`**（它绑的是 `projects`）
 *    —— 「取数在 tasks、判据在 teamwork」的分工见方案 §丙-2-9-④。
 *
 * ⭐ **界面上叫「团队协作」，代码里叫 `teamwork`**（模块标识 / 表名前缀 / 路由前缀 / 偏好列 `hide_teamwork`）——
 *    ⚠️ 0.8.12之前它们分别是「对话」与 `chat`：这一版**连根换掉了**，
 *    界面名与代码标识从此同名（表与列的改名迁移见下面的 `aliases` 与 `core/schema/core.js` 的 `columnAliases`）。
 *    界面名与代码标识本来就不必同名（先例：界面叫「大学课表」，模块是 `timetable`）。
 *
 * ⭐ **本模块是项目里第一个「跨账号数据」**（方案 §4.4，全文最需要评审的一节）：
 *    前六块能力的数据都是「一人一份」，一条消息**同时属于**发送者与接收者 ——
 *    所以「判权」不再是「这行的 `user_id` 是不是你」，而是
 *    「**你是不是这个会话的成员**」（`teamwork_members`，唯一判据，见本模块的 `store.js`）。
 *
 * ⚠️ **四张表都仍然带 `user_id`**（各表含义不同，语句里逐条注明），因为
 *    「删账号要清空哪些表」这条跨模块不变量是**按 `user_id` 列**工作的
 *    （`assertModules` 与 `ttt/test/schema.test.js` 都会核对：带 `user_id` 的表必须在
 *    `userScoped` 里）。⚠️ 但**删账号时四张表的处置并不一样** —— 详见各表说明与
 *    `backend/*.js` 的 `deleteUser`：会话行会**过户给还留在会话里的那个人**，
 *    否则「对方的历史会话会缺一段」会变成「对方整个会话消失」（比承诺的更糟）。
 *
 * ⚠️ **刻意不推进 `SCHEMA_VERSION`**（方案）：四张表由 `createAll()` 的
 *    `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来，升版本号只会触发一次**整库重建**
 *    （DROP + 搬数据 + RENAME），代价与风险都白担。与 0.2.3 加 `timetable_adjustments`、
 *    0.3.0 加收藏夹三张表、0.3.1 加硬件台账、0.3.2 加密码库两张表是同一手法。
 *
 * ⭐ **0.4.4 加的一列 `remark`（好友备注）同样不升结构版本号**：它走 `ensureColumns` 的
 *    幂等 `ALTER TABLE ADD COLUMN`（可空列，永远不会丢数据），与 0.2.3 加
 *    `timetable_sessions.note`、0.1.2 加 `users.hide_*` 是同一条路。
 *    ⚠️ **备注只属于「我这一行」**：好友关系存两行，`status` / `requested_by` 两行必须一致，
 *    但 `remark` 是**我单方面给对方起的名**，绝不镜像到对方那一行（见 `teamworkSetFriendRemark`）。
 *
 * ⭐⭐ 0.8.12：**AI 助手的聊天会话并进本模块的两张表**（`builtin_key = 'ai'`）
 *    —— 落库也从 ai 自己的 `ai_chats` / `ai_messages` 搬到这里（存量由一次性搬迁 op 搬）。
 *    为此本 schema 补三列，全部走 `ensureColumns`、⛔ **不动 `SCHEMA_VERSION`**：
 *    `teamwork_conversations.cur_segment`（当前段号）、`teamwork_messages.segment`（消息段号）、
 *    `teamwork_messages.image`（整串 data URL；列表只回 `has_image`，⛔ 永不拖 base64）。
 *    ⚠️ 老表 `ai_chats` / `ai_messages` **保留、不再写**（降级回旧包的退路）。
 *
 * ⚠️ 模块契约见 index.js 的说明，由 `assertModules()` 在加载时自检。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/schema/teamwork.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 四张表从此归这个目录所有。
 *    ⚠️ **跨账号结论一个字都没改**：四张表照样都带 `user_id`、`userScoped` 照样登记、
 *    「删账号时会话行过户给还留在会话里的那个人」照样由 `deleteUser` 做。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.1
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'teamwork',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '团队协作',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：四条刻意的设计取舍（方案 §4.1）——
   *      ① ⭐ **好友存两行**（我→他 / 他→我）而不是「一行代表一对」：「我的好友列表」于是变成
   *         一条最简单的单表查询，与项目现有的查询习惯一致；代价是**两行必须在同一个事务里改**
   *         （见 `setFriendshipPair` / `deleteFriendshipsBetween` 两条专用原语），
   *         否则会出现「A 认为我们是好友、B 不认为」的**裂脑**；
   *      ② ⭐ **判权只看 `teamwork_members`**（不看 `teamwork_conversations.user_id`）——
   *         会话归属于谁不重要，「谁是成员」才重要。`conversations.user_id` 只是**创建者记账**；
   *      ③ **`last_message_id` 冗余在会话表**：会话列表页一次查询就能排序，
   *         不必对 `teamwork_messages` 做 `MAX()` 聚合（方案 §4.1 明确要避开这类聚合）；
   *      ④ ⚠️ **消息表不加外键**（与现有其它表一致）：外键在这里帮不上忙，
   *         而 v5 那次「先体检、体检不过就整份放弃升级」的教训说明，结构约束的代价要在
   *         **老库**上付 —— 新模块没必要主动引入。
   *
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `teamwork_friendships` 表的建表语句 —— **双向两行**的好友关系。
     *
     * 说明：`status` 三值就是全部状态机（方案，照 XMPP RFC 6121 的 roster/subscription）：
     *      · `pending`  —— 我发出的申请，等对方同意（也可能是对方发来的，方向由行的**归属**表达：
     *        我这一行 `user_id=我, friend_id=他`，对方那一行 `user_id=他, friend_id=我`，
     *        **两行状态始终一致**）；
     *      · `accepted` —— 互为好友；
     *      · `blocked`  —— **我拉黑了他**（单向语义：我的行是 blocked，对方的行也是 blocked
     *        只是为了让两边行为一致 —— 拉黑后对方发来的申请会被明确拒绝）。
     *      ⚠️ 好友**不是单向关注**：必须对方同意（否则陌生人可以直接骚扰，方案）。
     *      `UNIQUE(user_id, friend_id)` 是「同一对只有一行」的兜底（SQLite 侧真正生效；
     *      JSON 后端没有约束，所以业务层一律显式查重 —— 两边行为必须一致）。
     *
     *      ⭐ **`requested_by` 是方案之外补的一列，不是漏项**：方案给的状态只有
     *      `pending` / `accepted` / `blocked`，而两行状态又要求一致 —— 于是就**无从知道
     *      「这条 pending 是对方发给我的、还是我发给对方的」**，而界面上「待我处理」与
     *      「我发出的」必须分开（方案 §六的接口清单里就写着 `incoming` / `outgoing` 两组）。
     *      所以补一列记「谁先发起的」：`requested_by = 发起人账号 id`。
     *      ⚠️ 同意 / 拉黑时**不改它**（改状态的 SQL 只动 `status` / `updated_at`），
     *      否则「同意之后方向就没了」，将来做「谁删掉了这段关系」这类功能会缺依据。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_friendships: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,        -- 本人（这一行属于谁）
        friend_id    INTEGER NOT NULL,        -- 对方
        status       TEXT NOT NULL CHECK (status IN ('pending','accepted','blocked')),
        requested_by INTEGER,                 -- ⭐ 谁先发起的（pending 时用来分「待我处理 / 我发出的」）
        remark       TEXT,                    -- ⭐ 0.4.4 我给对方起的名（**只写我这一行**；对方看不到）
        created_at   TEXT,
        updated_at   TEXT,
        UNIQUE(user_id, friend_id)
      );`,

    /**
     * 功能：生成 `teamwork_conversations` 表的建表语句 —— 一个会话（1 期只有一对一）。
     *
     * 说明：⭐ `user_id` 是**创建者记账**（审计用），**判权完全不看它** ——
     *      这也是为什么 `updateConversation` 这条原语按 `id` 更新、不带 `uid` 条件
     *      （会话的主人可能因为「创建者注销了」而**过户**给另一位成员，见 `deleteUser`）。
     *      `kind` 一期恒为 `'direct'`，给二期群聊预留（表结构不用改）。
     *      `last_message_id` 是**冗余列**：会话列表排序只看它，避免每次 `MAX()` 聚合。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_conversations: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,     -- 创建者（归属审计；⚠️ 判权**不看这一列**）
        kind            TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct')),
        title           TEXT,                 -- 群里才有；一期恒为 NULL
        -- ⭐ 0.6.x（方案 12，对话 2 期）：有值 = 这是一个**内置角色会话**（如 'reminder' 提醒助手）；
        --    NULL = 普通一对一。⚠️ 每个账号**各自一条**（它是「我」和助手，不是跨账号数据）。
        --    ⚠️ **刻意不改 kind 的 CHECK**：SQLite 改 CHECK 要重建表 ⇒ 推 SCHEMA_VERSION
        --    + 走迁移体检（决策 25），为一个枚举值付一次结构迁移不划算（见方案 12 §三-D2）。
        builtin_key     TEXT,
        -- ⭐ 0.8.12 · 2g（方案 32 §乙-6-1）：**当前对话段号**（AI 助手的「开启新对话」用）。
        --    ⚠️ 它原在 ai_chats.cur_segment 上（决策 89：段号住会话行）—— 会话并进本表后，
        --    那一列跟着落到这一行。NULL 视为第 1 段（老库补出来是 NULL，语义正好）。
        --    ⚠️ 与 builtin_key 同款：可空列，老库靠 ensureColumns 补、⛔ 不动 SCHEMA_VERSION。
        cur_segment     INTEGER,
        last_message_id INTEGER DEFAULT 0,    -- 会话列表排序用（避免每次 JOIN MAX）
        created_at      TEXT,
        updated_at      TEXT
      );`,

    /**
     * 功能：生成 `teamwork_members` 表的建表语句 —— **判权的唯一依据** + 各自的已读位置。
     *
     * 说明：`last_read_id` 是**每人一份**的已读游标：
     *      未读数 = 这个会话里 `id > last_read_id` 且**不是我自己发的**消息条数
     *      （自己发的不算未读 —— 见本模块 `store.js` 的 `teamworkUnreadOf`）。
     *      ⚠️ 游标是**自增 `id`** 而不是时间戳（方案）：`id` 天然幂等、同毫秒不乱序，
     *      所以「断线补齐时重复拉取同一段」不会产生重复气泡。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_members: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,     -- 成员（判权就查这一列）
        conversation_id INTEGER NOT NULL,
        last_read_id    INTEGER DEFAULT 0,    -- 已读游标（未读数 = COUNT(id > last_read_id)）
        joined_at       TEXT,
        UNIQUE(conversation_id, user_id)
      );`,

    /**
     * 功能：生成 `teamwork_messages` 表的建表语句 —— 消息本体。
     *
     * 说明：⚠️ `body` 是**纯文本**，而且它是本项目**第一次出现「A 写的内容给 B 看」**——
     *      渲染端**一律 `textContent` / 转义，禁止 `innerHTML` 拼接**（方案 与 §八）。
     *      长度上限 2000 字符由 `validate.js` 的 `checkTeamworkMessage` 把关（超长 400、不静默截断）。
     *      ⚠️ 消息**没有 `updated_at`**：1 期没有编辑与撤回（方案 §一「1 期不做」），
     *      写一次就定了 —— 留给二期的是「撤回」那张新表，而不是往这一行上加状态位。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_messages: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,     -- 发送者（⚠️ 内置角色发的消息，这里仍写**会话归属者**）
        conversation_id INTEGER NOT NULL,
        body            TEXT NOT NULL,        -- ⚠️ 纯文本；渲染必须转义（方案 §八）
        -- ⭐ 0.6.4（任务联动）：消息的**种类与结构化载荷** —— kind 为 NULL = 普通文本消息
        --    （历史上所有消息都是这一种）；'task_card' = 一条**任务卡片**，meta 里是
        --    发送那一刻的任务快照（JSON 文本，字段契约见 17-对话.md）。
        --    ⚠️⭐ **快照是刻意的**：收件人看不到发送者的任务数据（本项目多用户是数据隔离的，
        --    管理员也看不到成员的任务），所以卡片**不跟着任务状态变** —— 要「活的」就等于
        --    开了一条跨账号读任务的越权通道。
        --    ⚠️ body 照样必填：它是**降级文本**（渲染端不认这个 kind 时显示的东西），
        --    也让「卡片长什么样」永远有一个纯文本兜底。
        --    ⭐ 0.7.7：**四种系统提醒**也各占一个 kind —— remind_course（上课）/
        --    remind_task_today（今日到期）/ remind_overdue（逾期汇总）/ remind_care（问候）。
        --    ⚠️⭐ 它们**只能在服务端写**（由 teamworkSendBuiltinMessage() 一侧校验），
        --    ⛔ 绝不许进 core/validate.js 的 TEAMWORK_KINDS（那是「客户端可发」的白名单）——
        --    进了就等于任何登录用户都能伪造一条「系统提醒」。
        --    ⚠️ 老消息的 kind 是 NULL ⇒ 继续画普通气泡，这是**有意的**，⛔ 不写迁移、不回填。
        --    ⚠️ 本段注释里不许出现反引号（模板字符串会当场断掉、应用起不来，见 AGENTS §八）。
        kind            TEXT,
        meta            TEXT,
        -- ⭐ 0.6.x（方案 12）：有值 = 这条是**内置角色**发的（如 'reminder'），NULL = 人发的。
        --    ⚠️ user_id 照样写**会话归属者**（不是新建一个「机器人账号」）—— 这样未读 / 判权 /
        --    推送那三套机制**一行都不用改**（见方案 12 §三-D2）。
        sender_builtin  TEXT,
        -- ⭐ 0.8.12 · 2g（方案 32 §乙-6）：AI 助手会话并进本表后补的两列。
        --    · segment —— **对话分段**（AI「开启新对话」用；NULL 视为第 1 段，老数据零迁移）；
        --    · image   —— 这条消息带的**图片**（整串 data URL，如 data:image/jpeg;base64,...）；
        --      NULL = 没有图。⚠️ 只三种 mime（jpeg / png / webp）＋ 解码后 <= 1 MB，
        --      在 **AI 接口层**收口；⚠️ 列表读侧**只回 has_image、永不选这一列**
        --      （listMessages 的显式列清单里是 (image IS NOT NULL) AS has_image）。
        --    两列都是**可空列**：老库靠 ensureColumns 补、⛔ 不动 SCHEMA_VERSION。
        segment         INTEGER,
        image           TEXT,
        created_at      TEXT
      );`,

    /**
     * 功能：生成 `teamwork_reminders` 表的建表语句 —— **提醒流水**（「这件事这个时刻响过没有」的记账）。
     *
     * 说明：⭐ 它是「一切皆任务」在提醒这一侧的落地模型：
     *      `{属于谁, 是什么事, 什么时候该响, 响过没有}` —— 前两项就是 `user_id` + `kind`/`ref_key`，
     *      第三项是 **`fire_at`（分钟级 `YYYY-MM-DD HH:MM`）**，第四项是 `fired_at`。
     *      ⚠️⭐ **`UNIQUE(user_id, kind, ref_key, fire_at)` 是「重启不重发、崩溃不刷屏」的唯一保证**：
     *      ticker 一律**先插这一行、再发消息** —— 撞唯一键 = 已经发过，当场跳过（不用先查后插，
     *      那中间有一次竞态窗口）。⚠️ 唯一键里是**分钟级时刻**而不是「某一天」：任务将来会带
     *      截止时间，届时要精确到分钟（硬约束 C4）。
     *      ⚠️ `fire_at` 用**本地时间字符串**（与 `nowStamp()` 同一个时区口径），字典序即时间序。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_reminders: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,   -- 提醒发给谁（不是「谁创建」——提醒没有创建人）
        kind       TEXT NOT NULL,      -- 'course' 上课 | 'task_today' 今日截止 | 'overdue_daily' 每日逾期
        ref_key    TEXT NOT NULL,      -- 'course:<日期>:<课次id>' | 'task:<归属>:<id>' | 'overdue:<日期>'
        fire_at    TEXT NOT NULL,      -- 本地 'YYYY-MM-DD HH:MM'（**分钟级**，字典序可比）
        fired_at   TEXT,               -- 实际发出的时刻（nowStamp() 给的那个）
        created_at TEXT,
        UNIQUE(user_id, kind, ref_key, fire_at)
      );`,

    /**
     * 功能：生成 `teamwork_reminder_prefs` 表的建表语句 —— 每账号一行的**提醒偏好**。
     *
     * 说明：⭐ 「对话模块中要有一个设置……不放到全局设置里」⇒
     *      配置**住对话模块自己的表**、入口在对话页自己的 ⚙：
     *      · 它**不进 `users` 表**（铁律 11：只动本模块的表 + 本模块的目录）；
     *      · 删账号随行消失（`userScoped`）、删 teamwork 模块随配置一起消失（符合「可整块删」）。
     *      ⚠️ `task_at` / `overdue_at` 存 `HH:MM` 文本（**不带日期**，那是「每天几点」），
     *      校验在 `validate.checkReminderPrefs()` 一处（超范围一律 400，不静默纠正）。
     *      ⚠️ `due_lead_minutes` 是给**将来「任务带截止时间」**预留的提前量——
     *      V1 一个字节都不读它，但列先到位，届时不必再动表结构。
     *      ⭐ `builtin_name` = **我给内置角色起的称呼**。NULL / 空串都表示
     *      「没改过」，显示时回落 `store.js` 的 `BUILTIN_LABELS`；它与那几个时刻同属「对话自己的
     *      设置」，所以**同一张表、同一个接口写**（一次请求就存下整份设置，不会出现半个保存）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_reminder_prefs: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL,
        enabled            INTEGER DEFAULT 1,   -- 总开关（0 = 这个账号一条提醒都不发）
        course_lead_minutes INTEGER DEFAULT 20, -- 上课提醒：提前多少分钟（0 = 一打铃就发）
 task_at TEXT DEFAULT '20:00',-- 任务提醒：当天几点（默认，可自设）
        overdue_at         TEXT DEFAULT '07:00',-- 每日逾期汇总：早上几点
        due_lead_minutes   INTEGER DEFAULT 0,   -- ⭐ 预留：任务将来带截止时刻后用
 -- ⭐ 0.6.4（「增加人文关怀消息」）：当天**课上完了**发一句问候。
        --    默认 1（开）—— 它与四个时刻不是一回事：那四个是「什么时候提醒我做事」，
        --    这一条是「课都上完了，说句话」。判定在 ticker.js 的 dueJobs()（纯函数）。
        care_enabled       INTEGER DEFAULT 1,
        builtin_name       TEXT,               -- ⭐ 0.6.x：我给内置角色起的**称呼**（空 = 用默认名）
        updated_at         TEXT,
        UNIQUE(user_id)
      );`,

    /**
     * 功能：生成 `teamwork_friend_prefs` 表的建表语句 —— 每账号一行的**好友设置**（`0.7.7`）。
     *
     * 说明：⭐ **为什么不塞进 `teamwork_reminder_prefs`**：那张表的名字与语义都是「提醒」
     *      （总开关 / 三个时刻 / 角色称呼），把「自动通过好友申请」塞进去，
     *      就是下一个「看着像真的、其实是错的」字段 —— 它跟提醒毫无关系，
     *      将来「提醒设置」的任何一处改动都会误伤它（先例：`teamwork_reminder_prefs` 自己的
     *      列名清单在三个地方各写一份，`upsertReminderPrefs` 漏一列就是静默存不进去）。
     *      ⚠️ `auto_accept_friend` **只影响之后收到的申请**：打开开关**不**批量同意历史申请
     *      （一次误点会加进一堆人）—— 那是业务层的规矩（见 `store.js` 的 `teamworkRequestFriend()`），
     *      不是这一列能表达的事。
     *      ⚠️ 与提醒偏好同一手法：**不进个人备份**（它是「这台机器上的社交设置」，
     *      换台机器本来就该重新设；`export.js` 里没有它的键）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_friend_prefs: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL,
        -- ⭐ 0.7.7：开着 ⇒ 别人发来的好友申请**直接落成好友**（不再等我在「申请」里点同意）。
        --    0 = 关（默认）：维持「必须对方同意」这条一期规矩。
        auto_accept_friend INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT,
        updated_at         TEXT,
        UNIQUE(user_id)
      );`,

    /**
     * 功能：生成 `teamwork_cleared` 表的建表语句 —— **我这一侧**清掉的一段聊天记录（`0.7.7`）。
     *
     * 说明：⭐⭐ **「清理」不是删除 —— 一行消息都不删**（对话是跨账号数据，删行＝删掉对方的记录）。
     *      这里只记「**我**隐藏了哪个会话的哪一段消息」，读的时候把这一段滤掉 ——
     *      于是对方的设备上一条都不少（真机验收第 8 条就验这一件事）。
     *
     *      ⚠️⭐ 两个**必须写进代码**的静默陷阱（漏一个就是数据事故，而且不报错）：
     *      ① `expires_at` **绝不参与可见性判定** —— 它只决定「回收站里还显不显示、
     *         还能不能恢复」。一旦让它参与可见性，30 天后那些消息会**全部复活**。
     *      ② 这一行**永不删除**（除了「恢复」那一条显式路径）—— 删行 = 取消隐藏 = 消息复活。
     *         所以「30 天自动清理」= 回收站条目到期**不可恢复**，⛔ 不加定时器、
     *         ⛔ 不写后台任务（刻意不挂 ticker：那个定时器受「提醒总开关」约束，
     *         挂上去会出现「关掉提醒 ⇒ 回收站永不清理」这种说不通的耦合）。
     *
     *      ⚠️ 区间**含两端**（`BETWEEN`），且同会话的区间经业务层合并后**互不相交**
     *      （见 `store.js` 的 `teamworkClearMessages()`）—— 否则「恢复某一次」会有不止一种解释。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    teamwork_cleared: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL,   -- 谁清的（**我这一侧**，与对方无关）
        conversation_id  INTEGER NOT NULL,
        from_message_id  INTEGER NOT NULL,   -- 这段的第一条（**含**）
        to_message_id    INTEGER NOT NULL,   -- 这段的最后一条（**含**）
        msg_count        INTEGER NOT NULL,   -- 这次清了多少条（回收站显示用，按合并后的区间**重算**）
        hidden_at        TEXT NOT NULL,      -- 清理时刻（与 nowStamp() 同一口径，字典序可比）
        expires_at       TEXT NOT NULL,      -- hidden_at + 30 天（⛔ **不参与可见性判定**，见上）
        created_at       TEXT
      );`,

    /**
     * 功能：生成 `project_members` 表的建表语句 —— 一个共享项目里有哪些成员（0.8.10 追加批）。
     *
     * ⭐⭐ 0.8.12：这张表与它下面四张「协作表」
     *      （`task_reports` / `collab_states` / `project_comments` / `project_files`）
     *      **从 `modules/tasks` 搬进本模块** —— 判据（`taskShareGuard`）与接口（`/api/collab/*`）
     *      已经在本模块，表跟着搬过来，判权与表就同处一个模块了。⚠️ `projects` / `project_tasks`
     *      两张**地基表留在 `tasks`**（搬了任务板就得依赖团队协作才跑得起来）。
     *
     * 说明：⭐⭐ **这是整个「协作」功能的判权地基**：项目的共享任务与上报只对**这张表里的人**可见，
     *      行不在表里 ⇒ 一律 404（不给出「这条存在、只是不归你」的探测信号）。
     *      ⚠️ `UNIQUE(project_id, user_id)`：同一个人只能是一遍成员（重复插入会被约束挡下，
     *      而不是悄悄多出两行 —— 「同一个人算两次」会让「每人最新一条上报」拼出两行）。
     *      ⚠️ **刻意不加外键**：与 `project_tasks.project_id` 不同，删成员不该级联删任何东西；
     *      而删项目时的连带清理由 `deleteProject()` 逐表处理（项目是**组织**不是事实凭证 ——
     *      与「删行程只解绑」**刻意相反**，照任务板既有的「删项目连带删任务」口径）。
     *      ⚠️ `user_id` 上的外键会挡住「删账号」那条路（删账号是跨表两段执行），所以也不加。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    project_members: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TEXT,
        UNIQUE(project_id, user_id)
      );`,

    /**
     * 功能：生成 `task_reports` 表的建表语句 —— 成员就某条任务上报的状态（0.8.10 追加批）。
     *
     * 说明：⭐⭐ **「各报各的」**：一条任务可以有多条上报（一人一条时间线），
     *      ⛔ **不是「一条任务一个公共状态」** —— 那会互相覆盖，而且分不清是谁说的。
     *      界面取「每人最新一条」拼成「谁 · 什么状态 · 什么时候」。
     *      ⚠️⭐ `task_source` + `task_id` **必须成对**：日常任务与项目任务是**两张表、id 都从 1 开始**
     *      （这条坑在 `idea` / `pomodoro` 都踩过，见）—— 只存 id 会把「3 号」认成两张表里
     *      完全不同的两条任务。
     *      ⚠️ `status` 用**枚举**（`todo` / `doing` / `blocked` / `done`）：⛔ 不做百分比进度
     *      （伪精确）。
     *      ⚠️ **刻意不加外键**（同上：任务可能被删、账号可能被删，而「他当时报过什么」是**留痕**）。
     *
     * ⭐⭐ 0.8.12：这张表从「一人一条状态时间线」**改造成「任务的活动流水」**——
     *      `status` 存的仍是「改**后**的状态」，但它现在落的是**项目自定义状态键**
     *      （`backlog` / `done` / `cancelled` / 用户自建的 `s1` …，见 `collab_states`），
     *      而**不再是**当初那四值枚举。
     *      ⚠️⚠️ 所以这里**去掉了老的 `CHECK (status IN ('todo','doing','blocked','done'))`**：
     *      那条约束会挡住「改到 `backlog`」这类**正常**的状态变更（写流水当场撞 CHECK、变 500）。
     *      ⭐ 新库直接按下面这条 DDL 建（无 CHECK）；老库由 `lib/collab.js` 的懒迁移
     *      `ensureReportFlowSchema()`（后端 `backend/*.js`）**原地重建**这张表把 CHECK 去掉
     *      （同一张表、搬数据、行数守恒，⛔ 不是新建同义表；重建**不动 SCHEMA_VERSION**）。
     *      ⚠️ 老列语义（`user_id` / `task_source` / `task_id` / `note` / `created_at`）一个字没动，
     *      只新增了 `project_id` / `from_status` 两列（见 `ensureColumns`）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    task_reports: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_source TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT,
        project_id INTEGER,
        from_status TEXT
      );`,

    /**
     * 功能：生成 `collab_states` 表的建表语句 —— **项目级状态配置**（0.8.12）。
     *
     * 说明：⭐⭐ **「状态」与「组」两层**（照 Plane）：每个状态必属五组之一
     *      （`backlog` / `unstarted` / `started` / `completed` / `cancelled`），
     *      而**行为只看「组」不看状态名** —— 只有 `completed` 组算完成、进度按组归档。
     *      判据收在 `lib/state-groups.js` 一处纯函数里。
     *      ⚠️ 状态集**每个项目自己配**（项目所有者可增 / 删 / 改名 / 调色 / 改组）；
     *      内置五态在项目首次进看板时**播种**（`lib/collab.js` 的 `_seedCollabStates`，幂等）。
     *      ⭐ **零迁移**：`project_tasks.status` 本来就是**没有 CHECK 的自由 TEXT**
     *      （见 `tasks/schema.js` 那张表）⇒ 老任务的 `todo`/`doing`/`done` 继续有效，
     *      新状态只是同一个列里的新取值。
     *      ⚠️ `key` **落进 `project_tasks.status` 的就是它**（⛔ 不是 `name`：显示名可改，
     *      key 不许改）；`UNIQUE(project_id, key)` 保证同项目内不撞键。
     *      ⚠️⭐ **列名是 `group_key` 而不是 `group`**：`group` 是 SQLite 的保留关键字，
     *      未加引号时 `CREATE TABLE ... group ...` 当场语法错（实测），而通用 `_insert()`
     *      是按列名拼平铺 SQL 的 —— 保留字会让整条插入失败。对外（`/api/collab/*` 的响应）
     *      仍叫 `group`，由 `lib/collab.js` 的 `stateOut()` 在边界上改名，⛔ 界面看不到这层差异。
     *      ⚠️ **刻意不加外键**：项目是**组织**，删项目时的连带清理由 `deleteProject()` 处理
     *      （与 `project_members` 同一条口径）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    collab_states: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        group_key TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        UNIQUE(project_id, key)
      );`,

    /**
     * 功能：生成 `project_comments` 表的建表语句 —— 共享项目的评论（0.8.12）。
     *
     * 说明：⭐ **一张表装两级评论**：`task_id` 为 **NULL ＝ 项目级评论**（挂在项目上，看板页头那颗
     *      「评论」看的就是它）；有值 ＝ 这条**任务**的评论（点开卡片看的那一份）。
     *      ⚠️ 为什么两级合一张表而不是两张：判权、备份、删账号、删项目这四条连带处理**完全一样**，
     *      拆两张就多一份会漂移的清单；级差只体现在 `task_id` 这一个可空列上。
     *      ⚠️ **刻意不加外键**（与 `project_members` / `task_reports` 同族）：项目 / 任务是**组织**，
     *      删项目时的连带清理由 `deleteProject()` 处理（走模块自己的原语，不是数据库约束）。
     *      ⚠️ `body` 是**纯文本**（⛔ 不做 markdown 渲染），长度上限在业务层判（超 2000 字回 400）。
     *      ⚠️ **只有作者能删**—— 连项目所有者也不能删别人的，所以删除口必带 `user_id`。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    project_comments: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        task_id INTEGER,
        user_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,

    /**
     * 功能：生成 `project_files` 表的建表语句 —— 共享项目的**留言附件**（0.8.12， 戊）。
     *
     * 说明：⭐⭐ **两列把「所有者」与「上传者」分开**（方案 §戊-5，别合并）：
     *      · `user_id` ＝ **项目所有者**（租户列）—— 与 `userScoped` / 删账号 / 控制台统计对齐，
     *        「归属跟宿主」；⛔ **不记上传者**；
     *      · `uploader_id` ＝ **上传者**（可指向已注销账号）—— 「按用户统计与清理」只读这一列。
     *      ⚠️ 一个必须说清的连带：`project_files` 在 `userScoped` 里（删**所有者**账号会清掉他的行）；
     *      而删一个**成员**不会删掉他上传的附件（`user_id` 是所有者）—— 与 同款。
     *      ⚠️ `project_id` / `task_id`（空＝项目级）/ `report_id`（空＝不挂在某条流水上）是宿主。
     *      ⭐ 0.8.12：再加一列 `comment_id`（空＝不挂在某条评论上）——
     *      附件要**跟着评论走**（附件悬在评论之外看不出它是做什么的）。
     *      它与 `report_id` 同一性质（挂到一条记录上），可空、老库靠 `ensureColumns` 补、不动版本号。
     *      ⚠️ `name` 是**用户给的原名**（只用于显示与下载），⚠️ **磁盘文件名用 `id`**，
     *      ⛔ 绝不用用户给的名字（路径穿越 / 非法字符），落盘布局见 `lib/collab.js`。
     *      ⚠️ **刻意不加外键**（与 `project_members` / `task_reports` / `project_comments` 同族）：
     *      项目 / 任务是**组织**，删项目时的连带清理由 `deleteProject()` 处理（含磁盘目录）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    project_files: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        uploader_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        task_id INTEGER,
        report_id INTEGER,
        comment_id INTEGER,
        name TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at TEXT
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；⭐ 0.8.12（1a 那一批）本模块**八张表全部改名**：
   *      `chat_*` → `teamwork_*`（模块名 `chat` → `teamwork` 的连带改名）。
   *
   * 说明：⭐ 走的是**现成机制** —— `_applyTableAliases()` 的 `ALTER TABLE … RENAME TO`，
   *      与 `0.1.2` 给课表 5 张老表加 `timetable_` 前缀是同一手法：**只改名字、不搬数据**
   *      （SQLite 只改 `sqlite_master`，行 / 索引 / 自增序列全部原地保留）——
   *      项目自己的定调：「最不容易出事的一种结构变更」。
   *
   * ⚠️ 三条必须记住的性质（都写在 `core/store/backend/sqlite.js` 的 `_applyTableAliases` 里）：
   *      ① ⭐ **排在建表之前**（`_migrateSqlite()` 的第 0 步）：反过来的话新表名先被
   *         `CREATE TABLE IF NOT EXISTS` 占住，老表再想改名就撞名 —— 结果是一张空表加一份搬不过来的老数据；
   *      ② **全有或全无**：任何一处撞名就**一张都不改**，只记录冲突并显著告警（绝不半改）；
   *      ③ 老表名只对**老库**存在，新库里一句都不生效。
   *
   * ⚠️ JSON 回退后端读的是**按表名做的键**（`this.data.teamwork_*`）—— 同一份映射由
   *      `_renameJsonKeys()` 在加载时改写键名，两边自动一致（无需另写一份）。
   *
   * @type {Object}
   */
  aliases: {
    chat_friendships: 'teamwork_friendships',
    chat_conversations: 'teamwork_conversations',
    chat_members: 'teamwork_members',
    chat_messages: 'teamwork_messages',
    chat_reminders: 'teamwork_reminders',
    chat_reminder_prefs: 'teamwork_reminder_prefs',
    chat_friend_prefs: 'teamwork_friend_prefs',
    chat_cleared: 'teamwork_cleared',
  },

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这四张表，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来。留空即「本模块没有需要重建的历史表」。
   *
   * @type {Array.<string>}
   */
  rebuildOrder: [],

  /**
   * 功能：重建搬数据时对「NULL 与默认值语义完全相同」的列做归一化。
   *
   * 说明：本模块不参与重建（见 `rebuildOrder`），所以没有归一化规则。
   *
   * @type {Object}
   */
  normalize: {},

  /**
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   *
   * 说明：⚠️ 四张表本身都是新表（`CREATE TABLE IF NOT EXISTS` 一步到位），所以**表**不必写在这里；
   *      但 ⭐ **0.4.4 的 `remark` 是往「已经存在于老库里的表」上加列**，正需要这条通道 ——
   *      `_migrateSqlite()` 是先 `createAll()` 再 `ensureColumns()`，顺序保证了「表一定先存在」。
   *      列的类型可空、无默认值 ⇒ `ALTER TABLE ADD COLUMN` 永远成功、一行数据都不会动。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['teamwork_friendships', 'remark', 'TEXT'],
    // ⭐ 0.6.x：两列都是**可空列**，老库上补出来即可 —— 与 0.4.4 的 `remark` 同一条路
    //    （`_migrateSqlite()` 先 `createAll()` 再 `ensureColumns()`，表一定先存在）。
    ['teamwork_conversations', 'builtin_key', 'TEXT'],
    ['teamwork_messages', 'sender_builtin', 'TEXT'],
    // ⭐ 0.6.4（任务联动）：卡片消息的两列同样是**可空列** —— 老库上补出来即可，
    //    与 `remark` / `sender_builtin` 同一条路（不升 `SCHEMA_VERSION`，
    //    老库里那些普通消息补出来就是两列 NULL，渲染路径一个字不变）。
    ['teamwork_messages', 'kind', 'TEXT'],
    ['teamwork_messages', 'meta', 'TEXT'],
    // ⭐ 0.7.0 修复（真机报 `table teamwork_reminder_prefs has no column named builtin_name`）：
    //    ⚠️ 这一列 0.5.5 随建表语句一起进来时**漏登记了本清单** —— 于是新库正常（`CREATE TABLE`
    //    一步到位）、而「表已建、称呼这一列还没加」的那个中间态装过的库永远补不出它，
    //    表现为**在对话设置里改称呼一保存就撞 SQL 报错**（其余几项都能存，因为它没别的毛病）。
    //    教训：新表的列写进建表语句只解决了「新库」，**老库只看本清单** —— 两者不是一回事。
    ['teamwork_reminder_prefs', 'builtin_name', 'TEXT'],
    // ⭐ 0.6.4（人文关怀）：提醒偏好表加一个开关 —— 带 DEFAULT 1 的老库补列**安全**：
    //    `ALTER TABLE ADD COLUMN ... DEFAULT 1` 会给已有行填上默认值（不带 DEFAULT 的
    //    可空列才是 NULL）—— 这正是「默认开着」想要的语义。
    ['teamwork_reminder_prefs', 'care_enabled', 'INTEGER DEFAULT 1'],
    // ⭐⭐ 0.8.12：协作五表从 `modules/tasks` 搬进来时，
    //    它们在老库上「后补的列」也一起搬（与 DDL 成对，缺一段老库就补不出那一列）。
    //    · `task_reports` 改造成「活动流水」时新增的两列 —— `project_id`（老数据由懒迁移补，
    //      找不到对应任务的留 NULL）、`from_status`（改**之前**的状态，老数据补不出来 ⇒ 留 NULL）；
    //    · `project_files` 挂评论的 `comment_id`（空 ＝ 不挂评论）。
    //    ⚠️ 老列语义一个字不动、**不动 `SCHEMA_VERSION`**（`ALTER TABLE ADD COLUMN` 的强项）。
    ['task_reports', 'project_id', 'INTEGER'],
    ['task_reports', 'from_status', 'TEXT'],
    ['project_files', 'comment_id', 'INTEGER'],
    // ⭐⭐ 0.8.12：AI 助手会话并进对话两张表时补的三列 ——
    //    两张表在老库里**早就存在**（0.3.5 起），所以 `CREATE TABLE IF NOT EXISTS` 对它们
    //    一个字都不管用，**只能靠本清单**（漏一列的表现是「新库正常、老库那一列永远补不出来」，
    //    而且**不报错**）。三列都是可空列，`ALTER TABLE ADD COLUMN` 永远成功、一行数据都不动。
    //    · `teamwork_conversations.cur_segment` —— 当前对话段号（NULL 视为 1）；
    //    · `teamwork_messages.segment` —— 这条消息属于哪一段（NULL 视为 1）；
    //    · `teamwork_messages.image`   —— 这条消息带的整串 data URL（NULL = 没有图）。
    ['teamwork_conversations', 'cur_segment', 'INTEGER'],
    ['teamwork_messages', 'segment', 'INTEGER'],
    ['teamwork_messages', 'image', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这些表的模块自报。
   *
   * 说明：⚠️ 三处**必须排除**（`ttt/test/schema.test.js` 双向核对这张清单，漏一列的表现是
   *      「那个字段静默改不动」，而多一列的表现可能是**一次 PUT 就把会话过户**）：
   *      · `id` / `user_id` —— 不许改主键、不许「过户」；`user_id` 的过户只有
   *        `deleteUser` 那条**显式**路径（创建者注销 → 会话归剩下的成员）能发生；
   *      · `friend_id` / `conversation_id` —— 关系指针（与 `project_id` / `term_id` 同一类），
   *        改动它们等于把一条好友关系 / 一条消息搬到别人的会话里；
   *      · `created_at` —— 创建时间只写一次。
   *      ⭐ `teamwork_messages` 的白名单**是空的**：1 期没有编辑与撤回，
   *      消息一经发出不可改（空数组 = 该表不可通用更新，与 `default: return []` 同义）。
   *      ⚠️ 0.8.12 · 2g 起它列了 `segment` / `image` 两列 —— 那**不是**「消息可改」的许可，
   *      只是 `schema.test.js` 那条「真实列必须逐列对齐」的登记（见下面 `allowedCols` 的注释）。
   *      ⭐ 0.4.4 起 `teamwork_friendships` 多一个 `remark`：它是**纯粹的个人标注**
   *      （我给对方起的名），既有自己的语义（只写我这一行）又是普通文本，
   *      所以放进白名单、由 `teamworkSetFriendRemark()` 走通用 `_update()` 写 ——
   *      `_update()` 自带 `user_id=?` 限定，正好保证「改不到对方那一行」。
   *
   *      ⭐ 0.6.x 的两张新表（`teamwork_reminders` / `teamwork_reminder_prefs`）**刻意一个列都不放**
   *      （在 `ttt/test/schema.test.js` 里整体豁免）：前者是**只写一次的流水**，
   *      后者每一列都是要在业务层做硬映射的配置 —— 两者的写入全部走各自的专用原语
   *      （`insertReminder` / `upsertReminderPrefs`）。与 `vault_meta` / `ai_configs`
   *      同一个道理：**能表达语义的专用原语，优于放宽容器的白名单**。
   *
   * @type {Object}
   */
  allowedCols: {
    teamwork_friendships: ['status', 'updated_at', 'remark'],
    // ⭐ 0.8.12：`cur_segment`（当前对话段号）列进白名单 —— ⚠️ 它**不是**「让通用 PUT 改段号」
    //    的许可（本模块压根没有改会话的 PUT 路由），而是 `schema.test.js` 那条「真实列必须要么
    //    可写、要么在豁免清单里」的逐列对齐所需的登记（豁免清单在测试文件里、本轮不许动）。
    //    实际写入只有 `setBuiltinChatSegment()` 一条专用原语。
    teamwork_conversations: ['title', 'last_message_id', 'updated_at', 'cur_segment'],
    teamwork_members: ['last_read_id'],
    // ⚠️ 0.8.12：`segment` / `image` 两列同样只为「逐列对齐」登记 —— 它们由
    //    `insertBuiltinChatMessage()` 这条专用原语写，本表**没有**通用 `_update()` 的语义
    //    （消息一经发出不可改）。⚠️ 与上面 `cur_segment` 同一条理由，别把它读成「消息可改」。
    teamwork_messages: ['segment', 'image'],
    teamwork_reminders: [],
    teamwork_reminder_prefs: [],
    // ⭐ 0.7.7 的两张同样**整表豁免**（与上面两张提醒表同一条理由）：
    //    `teamwork_friend_prefs` 是「每账号一行的配置」，写入只走 `upsertFriendPrefs()`
    //    （patch 键 → 列名硬映射）；`teamwork_cleared` 的每一行都是一次**不可逆动作**的记录
    //    （`DELETE` 这一行 = 取消隐藏 = 消息复活），它压根不该有「改一行」的语义。
    //    ⛔ 放进白名单等于让请求体里任意一个键都有机会流到列上。
    teamwork_friend_prefs: [],
    teamwork_cleared: [],
    // ⭐⭐ 0.8.12：协作五表从 `modules/tasks` 搬进来，`allowedCols` 原样搬 ——
    //    ⚠️ `project_members` / `task_reports` / `project_comments` / `project_files` **整表留空**
    //    （成员的增删只有专有方法、上报是只增的、评论/附件没有「改一行」语义），
    //    这与 `schema.test.js` 的豁免清单逐字对齐（搬表时若漏登记，那条「逐列对齐」当场红）。
    project_members: [],
    task_reports: [],
    // ⭐ `collab_states` 只给「可由所有者调整」的四列：`id` / `project_id` / `key` / `is_default`
    //    是**刻意不许通用改**的列（`key` 是落进任务 status 的稳定键、`is_default` 由播种定死）。
    //    ⚠️ 这张表**没有 `user_id`**，通用 `_update(table, uid, id, …)` 根本用不了它
    //    （那条原语的 WHERE 带 `user_id`）—— 状态集的读写全走模块自己的专用原语。
    collab_states: ['name', 'color', 'group_key', 'sort_order'],
    project_comments: [],
    project_files: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：⚠️ 四张表都在这里，但**删除语义并不相同**（这是本项目唯一一处「清单是四张、
   *      处置却分两类」的地方，方案 §4.4 专门讨论过）：
   *      · `teamwork_friendships` / `teamwork_members` / `teamwork_messages`：标准的「账号一走、数据全走」；
   *      · `teamwork_conversations`：**先过户再删** —— 会话里还有别人时，把 `user_id` 改成
   *        还留下的那个成员（否则会话行被删掉，对方面对的是「整个会话没了」，
   *        而不是方案承诺的「历史会话缺一段」）。
   *      实现在 `backend/sqlite.js` 与 `backend/json.js` 的 `deleteUser` 里，两边逐字对齐。
   *      ⭐ 0.6.x 的两张提醒表也是标准的「账号一走、数据全走」：提醒流水与提醒偏好
   *      都是**这个人自己的**东西（内置角色会话也归他一个人，没有第二方）。
   *
   * @type {Array.<string>}
   */
  userScoped: [
    'teamwork_friendships',
    'teamwork_conversations',
    'teamwork_members',
    'teamwork_messages',
    'teamwork_reminders',
    'teamwork_reminder_prefs',
    // ⭐ 0.7.7 的两张：好友设置是「我这个人的偏好」、清理记录是「我这一侧的读取状态」
    //    —— 两者都只属于我一个人 ⇒ 账号一走就随行清空（删账号是唯一会真的删掉它们的路径）。
    'teamwork_friend_prefs',
    'teamwork_cleared',
    // ⭐⭐ 0.8.12：协作四张带 `user_id` 的表随表一起搬进来 ——
    //    `project_members` / `task_reports` 清的是「他在别人项目里的成员身份」与「他写过的上报」，
    //    **项目本身不会因为一个成员走了而被删**（项目归所有者）；
    //    `project_comments` 清「他写过的评论」；`project_files` 的 `user_id` 是**项目所有者**（租户列）
    //    ⇒ 删**所有者**账号会清掉他的附件行，删一个**成员**（上传者）**不会**删掉他传的附件
    //    。⚠️ 漏登记＝删账号后**永久残留且不报错**。
    'project_members',
    'task_reports',
    'project_comments',
    'project_files',
  ],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_teamwork_friend_user`：好友列表与待处理申请（`WHERE user_id=? AND status=?`）；
   *      · `idx_teamwork_member_user`：会话列表（先取「我参与的会话 id」，再取会话行）；
   *      · `idx_teamwork_member_conv`：判权 `isMember(uid, cid)` 与「这个会话有谁」（SSE 推送要用成员清单）；
   *      · `idx_teamwork_msg_conv`：**最要紧的一条** —— 历史分页（`conversation_id=? AND id<?`）
   *        与增量补齐（`id>?`）都走它，而它同时也是「按会话取消息」的顺序保证；
   *      · `idx_teamwork_reminder_user`（0.6.x）：提醒流水的窄查询
   *        （「这个账号这个时刻响过没有」与 90 天清理）—— 没有它就得逐账号全表扫。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_teamwork_friend_user ON teamwork_friendships(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_member_user ON teamwork_members(user_id, conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_member_conv ON teamwork_members(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_msg_conv    ON teamwork_messages(conversation_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_reminder_user ON teamwork_reminders(user_id, fire_at)',
    // ⭐ 0.7.7：清理记录的窄查询 —— 「这个会话我清过哪几段」是**每次读消息都要问一次**的事
    //    （可见性判据走 `NOT EXISTS` 子查询），没有它就是每读一页全表扫。
    'CREATE INDEX IF NOT EXISTS idx_teamwork_cleared_conv ON teamwork_cleared(user_id, conversation_id)',
    // ⭐⭐ 0.8.12：协作五表从 `modules/tasks` 搬进来，索引原样搬 ——
    //    · `idx_pmembers_project` / `idx_pmembers_user`：判权与「我加入的项目」；
    //    · `idx_treports_task` / `idx_treports_project`：按（来源 + 任务）成对取上报 / 项目级流水；
    //    · `idx_cstates_project`：状态集按项目取（`WHERE project_id=? ORDER BY sort_order, id`）；
    //    · `idx_pcomments_project` / `idx_pcomments_task`：项目级与任务级评论各一条；
    //    · `idx_pfiles_project` / `idx_pfiles_task`：项目级与任务级附件各一条。
    'CREATE INDEX IF NOT EXISTS idx_pmembers_project  ON project_members(project_id, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_pmembers_user     ON project_members(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_treports_task     ON task_reports(task_source, task_id)',
    'CREATE INDEX IF NOT EXISTS idx_treports_project   ON task_reports(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_cstates_project    ON collab_states(project_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_pcomments_project  ON project_comments(project_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_pcomments_task     ON project_comments(task_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_pfiles_project     ON project_files(project_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_pfiles_task        ON project_files(task_id)',
  ],
};
