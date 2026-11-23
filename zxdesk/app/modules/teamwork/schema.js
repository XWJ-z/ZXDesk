'use strict';
/**
 * modules/teamwork/schema.js —— **团队协作模块**
 * 功能：声明本模块的**十三张表** —— 对话（好友 · 一对一私聊）的
 * `teamwork_friendships`（好友关系，**双向两行**）/ `teamwork_conversations`（会话）/
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
   * ① ⭐ **好友存两行**（我→他 / 他→我）而不是「一行代表一对」：「我的好友列表」于是变成
   * （见 `setFriendshipPair` / `deleteFriendshipsBetween` 两条专用原语），
   * ② ⭐ **判权只看 `teamwork_members`**（不看 `teamwork_conversations.user_id`）——
   */
  tables: {
    /**
     * 功能：生成 `teamwork_friendships` 表的建表语句 —— **双向两行**的好友关系。
     *
     * 说明：`status` 三值就是全部状态机（方案，照 XMPP RFC 6121 的 roster/subscription）：
     * `pending`  —— 我发出的申请，等对方同意（也可能是对方发来的，方向由行的**归属**表达：
     * 我这一行 `user_id=我, friend_id=他`，对方那一行 `user_id=他, friend_id=我`，
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
     * 这也是为什么 `updateConversation` 这条原语按 `id` 更新、不带 `uid` 条件
     * `kind` 一期恒为 `'direct'`，给二期群聊预留（表结构不用改）。
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
     * 未读数 = 这个会话里 `id > last_read_id` 且**不是我自己发的**消息条数
     * （自己发的不算未读 —— 见本模块 `store.js` 的 `teamworkUnreadOf`）。
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
     * 长度上限 2000 字符由 `validate.js` 的 `checkTeamworkMessage` 把关（超长 400、不静默截断）。
     * 写一次就定了 —— 留给二期的是「撤回」那张新表，而不是往这一行上加状态位。
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
     * `{属于谁, 是什么事, 什么时候该响, 响过没有}` —— 前两项就是 `user_id` + `kind`/`ref_key`，
     * 第三项是 **`fire_at`（分钟级 `YYYY-MM-DD HH:MM`）**，第四项是 `fired_at`。
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
     * 配置**住对话模块自己的表**、入口在对话页自己的 ⚙：
     * 它**不进 `users` 表**（铁律 11：只动本模块的表 + 本模块的目录）；
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
     *
     * 说明：⭐ **为什么不塞进 `teamwork_reminder_prefs`**：那张表的名字与语义都是「提醒」
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
     *
     * 说明：⭐⭐ **「清理」不是删除 —— 一行消息都不删**（对话是跨账号数据，删行＝删掉对方的记录）。
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
     *
     * 这张表与它下面四张「协作表」
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
     *
     * 说明：⭐⭐ **「各报各的」**：一条任务可以有多条上报（一人一条时间线），
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
     *
     * 说明：⭐⭐ **「状态」与「组」两层**（照 Plane）：每个状态必属五组之一
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
     *
     * 说明：⭐ **一张表装两级评论**：`task_id` 为 **NULL ＝ 项目级评论**（挂在项目上，看板页头那颗
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
     *
     * `user_id` ＝ **项目所有者**（租户列）—— 与 `userScoped` / 删账号 / 控制台统计对齐，
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
   * `chat_*` → `teamwork_*`（模块名 `chat` → `teamwork` 的连带改名）。
   *
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
   * `CREATE TABLE IF NOT EXISTS` 把它们建出来。留空即「本模块没有需要重建的历史表」。
   *
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
   * `_migrateSqlite()` 是先 `createAll()` 再 `ensureColumns()`，顺序保证了「表一定先存在」。
   * 列的类型可空、无默认值 ⇒ `ALTER TABLE ADD COLUMN` 永远成功、一行数据都不会动。
   */
  ensureColumns: [
    ['teamwork_friendships', 'remark', 'TEXT'],
    // （`_migrateSqlite()` 先 `createAll()` 再 `ensureColumns()`，表一定先存在）。
    ['teamwork_conversations', 'builtin_key', 'TEXT'],
    ['teamwork_messages', 'sender_builtin', 'TEXT'],
    // ：卡片消息的两列同样是**可空列** —— 老库上补出来即可，
    // 与 `remark` / `sender_builtin` 同一条路（不升 `SCHEMA_VERSION`，
    // 老库里那些普通消息补出来就是两列 NULL，渲染路径一个字不变）。
    ['teamwork_messages', 'kind', 'TEXT'],
    ['teamwork_messages', 'meta', 'TEXT'],
    // 修复：
    // 一步到位）、而「表已建、称呼这一列还没加」的那个中间态装过的库永远补不出它，
    // 教训：新表的列写进建表语句只解决了「新库」，**老库只看本清单** —— 两者不是一回事。
    ['teamwork_reminder_prefs', 'builtin_name', 'TEXT'],
    // ：提醒偏好表加一个开关 —— 带 DEFAULT 1 的老库补列**安全**：
    // `ALTER TABLE ADD COLUMN ... DEFAULT 1` 会给已有行填上默认值（不带 DEFAULT 的
    ['teamwork_reminder_prefs', 'care_enabled', 'INTEGER DEFAULT 1'],
    // 协作五表从 `modules/tasks` 搬进来时，
    // 它们在老库上「后补的列」也一起搬（与 DDL 成对，缺一段老库就补不出那一列）。
    // `task_reports` 改造成「活动流水」时新增的两列 —— `project_id`（老数据由懒迁移补，
    ['task_reports', 'project_id', 'INTEGER'],
    ['task_reports', 'from_status', 'TEXT'],
    ['project_files', 'comment_id', 'INTEGER'],
    // AI 助手会话并进对话两张表时补的三列 ——
    // 一个字都不管用，**只能靠本清单**（漏一列的表现是「新库正常、老库那一列永远补不出来」，
    // 而且**不报错**）。三列都是可空列，`ALTER TABLE ADD COLUMN` 永远成功、一行数据都不动。
    ['teamwork_conversations', 'cur_segment', 'INTEGER'],
    ['teamwork_messages', 'segment', 'INTEGER'],
    ['teamwork_messages', 'image', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这些表的模块自报。
   *
   * 说明：⚠️ 三处**必须排除**（`ttt/test/schema.test.js` 双向核对这张清单，漏一列的表现是
   * 「那个字段静默改不动」，而多一列的表现可能是**一次 PUT 就把会话过户**）：
   * `deleteUser` 那条**显式**路径（创建者注销 → 会话归剩下的成员）能发生；
   */
  allowedCols: {
    teamwork_friendships: ['status', 'updated_at', 'remark'],
    // `cur_segment`（当前对话段号）列进白名单 —— ⚠️ 它**不是**「让通用 PUT 改段号」
    // 的许可（本模块压根没有改会话的 PUT 路由），而是 `schema.test.js` 那条「真实列必须要么
    // 实际写入只有 `setBuiltinChatSegment()` 一条专用原语。
    teamwork_conversations: ['title', 'last_message_id', 'updated_at', 'cur_segment'],
    teamwork_members: ['last_read_id'],
    // `segment` / `image` 两列同样只为「逐列对齐」登记 —— 它们由
    // `insertBuiltinChatMessage()` 这条专用原语写，本表**没有**通用 `_update()` 的语义
    // （消息一经发出不可改）。⚠️ 与上面 `cur_segment` 同一条理由，别把它读成「消息可改」。
    teamwork_messages: ['segment', 'image'],
    teamwork_reminders: [],
    teamwork_reminder_prefs: [],
    // 的两张同样**整表豁免**（与上面两张提醒表同一条理由）：
    // `teamwork_friend_prefs` 是「每账号一行的配置」，写入只走 `upsertFriendPrefs()`
    // （patch 键 → 列名硬映射）；`teamwork_cleared` 的每一行都是一次**不可逆动作**的记录
    teamwork_friend_prefs: [],
    teamwork_cleared: [],
    // 协作五表从 `modules/tasks` 搬进来，`allowedCols` 原样搬 ——
    // `project_members` / `task_reports` / `project_comments` / `project_files` **整表留空**
    // （成员的增删只有专有方法、上报是只增的、评论/附件没有「改一行」语义），
    project_members: [],
    task_reports: [],
    // `collab_states` 只给「可由所有者调整」的四列：`id` / `project_id` / `key` / `is_default`
    // 这张表**没有 `user_id`**，通用 `_update(table, uid, id, …)` 根本用不了它
    // （那条原语的 WHERE 带 `user_id`）—— 状态集的读写全走模块自己的专用原语。
    collab_states: ['name', 'color', 'group_key', 'sort_order'],
    project_comments: [],
    project_files: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：⚠️ 四张表都在这里，但**删除语义并不相同**（这是本项目唯一一处「清单是四张、
   * `teamwork_friendships` / `teamwork_members` / `teamwork_messages`：标准的「账号一走、数据全走」；
   * `teamwork_conversations`：**先过户再删** —— 会话里还有别人时，把 `user_id` 改成
   */
  userScoped: [
    'teamwork_friendships',
    'teamwork_conversations',
    'teamwork_members',
    'teamwork_messages',
    'teamwork_reminders',
    'teamwork_reminder_prefs',
    // 的两张：好友设置是「我这个人的偏好」、清理记录是「我这一侧的读取状态」
    // —— 两者都只属于我一个人 ⇒ 账号一走就随行清空（删账号是唯一会真的删掉它们的路径）。
    'teamwork_friend_prefs',
    'teamwork_cleared',
    // 协作四张带 `user_id` 的表随表一起搬进来 ——
    // `project_members` / `task_reports` 清的是「他在别人项目里的成员身份」与「他写过的上报」，
    // `project_comments` 清「他写过的评论」；`project_files` 的 `user_id` 是**项目所有者**（租户列）
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
   * `idx_teamwork_friend_user`：好友列表与待处理申请（`WHERE user_id=? AND status=?`）；
   * `idx_teamwork_member_user`：会话列表（先取「我参与的会话 id」，再取会话行）；
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_teamwork_friend_user ON teamwork_friendships(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_member_user ON teamwork_members(user_id, conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_member_conv ON teamwork_members(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_msg_conv    ON teamwork_messages(conversation_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_teamwork_reminder_user ON teamwork_reminders(user_id, fire_at)',
    // 清理记录的窄查询 —— 「这个会话我清过哪几段」是**每次读消息都要问一次**的事
    // （可见性判据走 `NOT EXISTS` 子查询），没有它就是每读一页全表扫。
    'CREATE INDEX IF NOT EXISTS idx_teamwork_cleared_conv ON teamwork_cleared(user_id, conversation_id)',
    // 协作五表从 `modules/tasks` 搬进来，索引原样搬 ——
    // `idx_pmembers_project` / `idx_pmembers_user`：判权与「我加入的项目」；
    // `idx_treports_task` / `idx_treports_project`：按（来源 + 任务）成对取上报 / 项目级流水；
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
