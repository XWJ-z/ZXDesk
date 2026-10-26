'use strict';
/**
 * modules/ai/schema.js —— **ai辅助任务模块**（0.6.0）的表结构声明
 *
 * 功能：声明本模块的**四张表** —— `ai_configs`（每账号一行的接口配置，key 密文三列）、
 *      `ai_chats`（AI 会话，一期每账号一条默认会话）、`ai_messages`（AI 消息，2 期起带对话分段）、
 *      ⭐ `ai_memories`（2 期新增：**手动维护**的长期记忆，每次调用按上限带上）；
 *      给出 DDL 生成器、列白名单、级联清空清单与索引语句。
 *
 * ⭐ **界面上叫「AI 辅助任务」，代码里叫 `ai`**（模块标识 / 表名 / 路由前缀）——
 *    界面名与代码标识本来就不必同名（先例：界面「大学课表」= `timetable`）。
 *
 * ⭐ **AI 的会话与消息绝不进 `chat_*` 表**：对话是「同一 NAS 内成员之间」
 *    的**跨账号**数据（成员表判权），而 AI 会话是**每账号自己**的数据 ——
 *    回到 `userScoped` 的经典「一人一份」模型，判权只看 `user_id`。两套判权模型不混用，
 *    这也是「删掉 ai 模块后对话页照旧」的另一半保证。
 *
 * ⭐ **key 密文三列**（`key_iv` / `key_cipher` / `key_tag`）：AES-256-GCM 的三个 base64 字段，
 *    与 `vault_meta` 的 verifier 三列同款形态；**不明文落库**是本模块不可妥协的底线（方案 §八）。
 *    未配 key 时三列**同时为 NULL**（「keySet」= 三列齐全，见 `store.js` 的 `aiGetConfigView`）。
 *
 * ⚠️ **错误帧不落库**（`ai_messages.role` 只认 `user` / `assistant`）：AI 报错是「这一次的失败」，
 *    不是会话内容；落库会让「删掉失败重试」变成删数据。失败的可见性由前端即时展示承担。
 *
 * ⚠️ **刻意不推进 `SCHEMA_VERSION`**（与 hardware / chat 同一手法）：四张表由 `createAll()` 的
 *    `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来，升版本号只会触发一次整库重建，代价与风险都白担。
 *
 * ⭐ **2 期是本模块第一次往「老库里已经存在的表」上加列**：`ai_configs` 加 3 个可空列
 *    （上下文条数 / 记忆开关 / 记忆条数上限）、`ai_messages` 加 1 个可空列（`segment` 对话分段）、
 *    `ai_chats` 加 1 个可空列（`cur_segment` 当前段号 —— ⚠️ 这一列是实施时**追加**的，
 *    方案 §四 的清单里没有它：没有它，「开启新对话」的新段号无处安放，详见 `ai_chats` 的说明）。
 *    补列只有 `ensureColumns` 一条通道（`_migrateSqlite()` 是**先 `createAll()` 再 `ensureColumns()`**，
 *    顺序保证「表一定先存在」）。⚠️ 新列**一律可空、不写 `NOT NULL` / `DEFAULT` / `CHECK`** ——
 *    区间与合法性校验放在**接口层**（加 `CHECK` 就得重建表，那正是本节第一段要避免的）。
 *
 * ⚠️ 模块契约见 `core/store/schema/index.js` 的说明，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、docs/公共/开发方案/14-AI辅助任务-2期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'ai',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: 'AI辅助任务',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计——
   *      ① `ai_configs` 是**每账号一行**（`UNIQUE(user_id)`）：配置是「一个人对 AI 的偏好」，
   *         不存在第二条；「keySet」由三列密文是否**齐全**推导，接口层永远不出现 key 的任何投影；
   *      ② `ai_chats` 一期**每账号一条默认会话**（同样 `UNIQUE(user_id)`，首用即建）；
   *         多会话是后期项 —— 表结构已兼容（去掉 UNIQUE 即可），列一个都不用改；
   *      ③ `user_id` **故意不加外键、不给 DEFAULT**（与 hardware / chat 完全同一条理由）：
   *         它是「归属标签」不是结构父节点，加外键会把「首次启动」判死，
   *         给 DEFAULT 则会让「忘了传 user_id」从报错变成静默归到 1 号账号名下。
   *
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `ai_configs` 表的建表语句 —— 每账号一行的 AI 接口配置。
     *
     * 说明：⚠️ `base_url` 允许 `http://`（本地 ollama 是真实场景， 拍板项 7），
     *      风险提示在『AI 辅助任务』界面上做，不在数据层拦；`enabled` 默认 0 ——
     *      **「开 AI 必须是用户亲手做的选择」**（这是本项目第一个把数据发出去的功能，方案 §八）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    ai_configs: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE,   -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        base_url   TEXT NOT NULL DEFAULT '',  -- 用户自填的 OpenAI 兼容接口地址（http/https 都认）
        model      TEXT NOT NULL DEFAULT '',  -- 模型名（如 deepseek-chat、qwen2.5:7b）
        enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        -- ⭐ 2 期（方案 14 §四）：三个**可空**列 —— NULL = 用代码里的默认值（默认值只写一处）。
        --    ⚠️ 刻意不设「字符上限」列：那是代码兜底常数（见 store.js 的 AI_CTX_MAX_CHARS），用户不配。
        --    ⚠️ 可空列是「老库能直接补列」的前提，区间校验放在接口层（见文件头的 2 期说明）。
        ctx_max_turns INTEGER,                -- 带多少条历史（NULL → 20；可配区间 20~200，0.7.7-⑰ 起）
        mem_enabled   INTEGER,                -- 是否把记忆带进上下文（NULL → 1）
        -- ⚠️ 0.7.6：界面**不再暴露**这一项（记忆改为**全量注入**，不再按它截断）——
        --    列与接口键**保留**只为向后兼容与老备份恢复路径；⛔ 别再让注入条数看它。
        mem_max       INTEGER,                -- 最多带几条记忆（NULL → 20；可配区间 5~50）
        -- ⭐ 0.7.0（009 报告 R1）：是否允许把请求发往**内网 / 本机**地址（NULL → 0 = 拦）。
        --    默认拦的理由：这个地址是**成员自己填的**，而错误文案能区分「连不上 / 不存在 / 超时」
        --    三态 ⇒ 等于给每个注册成员开了一个内网探测口；开关是给「本地 ollama」这类真实用法
        --    留的出口（⚠️ 打开后该账号可访问内网任意 http 地址，界面上已写明这条风险）。
        allow_private INTEGER,
        -- ⭐ 3 期（方案 16 §五）：AI 工具调用的**授权状态**四列。与上面几个可空列同款待遇 ——
        --    可空、无 DEFAULT / CHECK（区间与合法性校验放在接口层），老库靠 ensureColumns 补出来。
        --    ⚠️ 建表语句与 ensureColumns **两处都要写**：新库走这里、老库走那里（2 期同一手法）。
        tools_enabled INTEGER,                -- 工具总开关（NULL = 关；关掉 = 请求里零工具说明、零数据）
        tools_read    TEXT,                   -- 已授权的读模块清单（JSON 数组，如 ["tasks","timetable"]）
        tools_write   TEXT,                   -- 已授权的写模块清单（JSON 数组，V1 最多 ["tasks"]）
        tools_audit   INTEGER,                -- 是否记录审计（NULL = 开；只记工具名 / 参数摘要 / 成败）
        -- ⭐ 0.8.6（行程 1 期 · 方案 25 §9.3）：**能不能收图片**（NULL = 关）。
        --    ⚠️ 默认**关**：不是每个模型都收图（本地 ollama 常见的不收），开着会让上游 400；
        --    ⚠️ 与上面几列同款待遇 —— 可空、无 DEFAULT / CHECK（老库 ALTER 友好），
        --    默认值只写一处（store.js 的 viewOf()），建表语句与 ensureColumns 两处都要写。
        vision        INTEGER,
        key_iv     TEXT,                      -- API Key 密文三件套（AES-256-GCM）；未配 key 时三列同时为 NULL
        key_cipher TEXT,
        key_tag    TEXT,
        created_at TEXT,
        updated_at TEXT
      );`,

    /**
     * 功能：生成 `ai_chats` 表的建表语句 —— AI 会话（一期每账号一条默认会话）。
     *
     * 说明：⭐ 2 期多一列 `cur_segment` —— **当前对话段号**（NULL 视为 1）。
     *      ⚠️ 为什么必须存下来（方案里没写到的一处，实施时才发现）：段号不能只靠
     *      「消息里最大的那个 segment」推出来 —— 用户点「开启新对话」之后、还没发第一条消息时，
     *      新段**一条消息都没有**，只看消息表就会退回旧段，于是「开了新对话，AI 却还记得上段」。
     *      所以段号必须与「用户按过这个按钮」这件事一起落盘，落在**每账号唯一的那一行会话**上。
     *      ⚠️ 它是**可空列**（NULL → 1）：老库补出来是 NULL，语义正好是「还没有分段，全在第 1 段」。
     *      多会话（3 期）那一列照样能用（每会话一份）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    ai_chats: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE,
        title      TEXT NOT NULL DEFAULT 'AI 助手',
        cur_segment INTEGER,                  -- ⭐ 2 期：当前对话段号（NULL 视为 1；「开启新对话」= +1）
        created_at TEXT,
        updated_at TEXT
      );`,

    /**
     * 功能：生成 `ai_messages` 表的建表语句 —— AI 消息（外部内容 + 用户输入，渲染一律 textContent）。
     *
     * 说明：⚠️ `role` 只认 `user` / `assistant` 两值 —— **错误帧不落库**（见文件头）。
     *      ⭐ 0.7.7-⑲：多两列 `kind` / `meta` —— AI 提议建任务的**确认卡**要落库
     *      （不落库的话刷新就没了、卡上那两颗按钮也没了）。⛔ **不改 `role` 的 CHECK**：
     *      SQLite 改 CHECK 要重建表 ⇒ 推 `SCHEMA_VERSION` + 迁移体检，
     *      为一个枚举值付一次结构迁移不划算 —— 所以卡片仍旧是 `role='assistant'`，
     *      靠**可空的 `kind`** 区分（先例：`teamwork_conversations.kind` 就是这么处理的）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    ai_messages: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        chat_id    INTEGER NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content    TEXT NOT NULL,
        -- ⭐ 2 期（方案 14 §四）：**对话分段**；NULL 视为第 1 段（老数据零迁移）。
        --    「开启新对话」= 段号 +1，上下文只取当前段 —— 历史一条都不删。
        segment    INTEGER,
        -- ⭐ 0.7.7-⑲：消息**种类**。NULL = 普通消息；'task_proposal' = AI 的任务确认卡。
        --    ⚠️ 认不出来的一律按普通消息显示（content 是降级文本，与 chat 的 kind 同一规矩）。
        kind       TEXT,
        -- ⭐ 0.7.7-⑲：卡片的**快照**（JSON 文本）—— { items:[{title,due,important,urgent,note,scope}],
        --    state:'pending'|'agreed'|'rejected', added?, failed? }。
        --    ⚠️ 它是**快照**（照决策 87 的同一条理由：卡片记的是"当时提议了什么"，不是"现在库里有什么"）；
        --    ⚠️ **逐个字段白名单搬运**，绝不整包透传模型输出；⛔ 不含任何账号资料、不含密钥。
        --    ⚠️⭐ 注入模型时**必须降级成一句话**（见 store.js 的 aiContextWindow）——
        --    把这段 JSON 原样喂回去，模型会学着自己吐这种结构，与协议 V1「只输出一个纯 JSON」打架。
        meta       TEXT,
        -- ⭐ 0.8.6（行程 1 期 · 方案 25 §9.3）：**这条消息带的图片**（整串 data URL，
        --    如 data:image/jpeg;base64,…）；NULL = 没有图。
        --    ⚠️⭐ 只允许三种 mime（jpeg / png / webp）＋ 解码后 ≤ 1 MB，在**接口层**收口；
        --    ⚠️⭐⭐ **列表读侧永不选这一列**（listAiMessages() 只回 (image IS NOT NULL) AS has_image）
        --    —— 历史载荷里拖 base64 会让整个对话列表暴涨，那是这条设计最贵的坑。
        image      TEXT,
        created_at TEXT
      );`,

    /**
     * 功能：生成 `ai_memories` 表的建表语句 —— **手动维护的长期记忆**（2 期新增）。
     *
     * 说明：⭐ 它是「一份看得见、改得动的长期记忆」，每次调用 AI 时按 `sort_no` 取前 N 条拼进
     *      系统提示词（注入点在 `routes.js` 的 `chatSystemPrompt()`，零新链路）。
     *      ⚠️ **内容是明文**（与任务 / 收藏夹同级）：它是**用户内容**，不是密钥 ——
     *      本模块唯一走密文的仍然只有 `ai_configs` 的 key 三件套。界面上要把这点说清楚。
     *      ⚠️ `sort_no` 是**排序位**（注入与列表都按 `sort_no ASC, id ASC` 取），
     *      写入全走本模块自己的专用 op（`insertAiMemory` / `updateAiMemory`），
     *      不进通用 `_update()` 的列白名单（见下面 `allowedCols` 的说明）。
     *      ⚠️ **2 期不做「AI 自动记住」**：只有手动增删改 + 一个开关 ——
     *      自动 = 多一次出网 + 把用户不知道的内容写进记忆（幻觉落库最难补救），留到 3 期且必须先预览后写入。
     *      ⚠️ `user_id` 与 `ai_configs` 同款：**故意不加外键、不给 DEFAULT**（漏传 uid 直接报错）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    ai_memories: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,          -- ⚠️ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        label      TEXT,                      -- ⭐ 0.7.1：这一条的**名称**（如「称呼」）；NULL / 空 = 无名称的自由文本
        content    TEXT NOT NULL,             -- 记忆正文（**明文**：它是用户内容，不是密钥）
        source     TEXT NOT NULL DEFAULT 'manual', -- 来源；2 期恒为 manual（自动记忆是 3 期）
        sort_no    INTEGER NOT NULL DEFAULT 0,     -- 排序位（列表与注入都按它取前 N 条）
        created_at TEXT,
        updated_at TEXT
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.6.0 新增），没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这三张表，**不需要重建**；
   *      `createAll()` 会用 `CREATE TABLE IF NOT EXISTS` 建出来。
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
   * 说明：⭐ 1 期这里**刻意留空** —— 那三张表是新表，`CREATE TABLE IF NOT EXISTS`
   *      一步到位；往这里写它们的列反而会在「表还没建」时执行 `ALTER TABLE` 报错。
   *      ⭐ **2 期第一次往「已经存在于老库里的表」上加列**，正需要这条通道 ——
   *      `_migrateSqlite()` 是**先 `createAll()` 再 `ensureColumns()`**，顺序保证「表一定先存在」。
   *      五条全是**可空列**（无 `NOT NULL` / 无 `DEFAULT` / 无 `CHECK`）⇒ `ALTER TABLE ADD COLUMN`
   *      永远成功、一行数据都不会动；老行补出来就是 NULL，默认值由代码一处给出。
   *      ⭐ 0.7.0（R1）再加一条 `allow_private` —— 同样是可空列，老库补出来是 NULL（视为「不开」）。
   *      ⚠️⭐ **0.7.1 起 `ai_memories` 也要写在这里**（原来那句"⛔ 不要给它写这里"已经**过期**，
   *      别照它做）：那句说的是「**表**是新表 ⇒ 不必登记列」。而 0.7.1 是往这张表**加列**
   *      （`label`）—— 装过 0.6.8 的库里这张表**已经存在**、却没有 `label`，
   *      `CREATE TABLE IF NOT EXISTS` 永远补不上（同一天在课表的 `builtin_name` 上刚踩过同一个坑）。
   *      ⇒ 判据是「**表**在不在老库里」与「**列**新不新」**分开看**：新表不必登记，老表加列必须登记。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['ai_configs', 'ctx_max_turns', 'INTEGER'],
    ['ai_configs', 'mem_enabled', 'INTEGER'],
    ['ai_configs', 'mem_max', 'INTEGER'],
    ['ai_messages', 'segment', 'INTEGER'],
    // ⭐ 2 期：当前对话段号。⚠️ 这一列**不在方案 §四 的清单里**，是实施时发现必须加的 ——
    //    否则「开启新对话」的新段号无处安放（新段一条消息都没有，只看消息表会退回旧段）。
    ['ai_chats', 'cur_segment', 'INTEGER'],
    // ⭐ 0.7.0（009 报告 R1）：默认拦私网地址的显式开关（NULL = 不开）
    ['ai_configs', 'allow_private', 'INTEGER'],
    // ⭐ 0.7.1：记忆条目的**名称**（如「称呼」）—— 可空列，老库补出来是 NULL（视为「没有名称」，
    //    界面回落成自由文本那一种呈现）
    ['ai_memories', 'label', 'TEXT'],
    // ⭐ 3 期：AI 工具调用的**授权状态**四列 —— 同样是**可空列**（老库补出来是 NULL，
    //    默认值只写一处：`store.js` 的 `viewOf()`）。⛔ 不写 NOT NULL / DEFAULT / CHECK（老库 ALTER 会失败）。
    //    ⚠️ 四个值的语义都**默认关**（与模块 `defaultEnabled:false` 同口径），只有审计默认开：
    //      · `tools_enabled` 工具总开关（NULL = 关 ⇒ 请求里零工具说明、零数据）
    //      · `tools_read`    已授权的读模块清单（JSON 数组文本，如 `["tasks","timetable"]`）
    //      · `tools_write`   已授权的写模块清单（JSON 数组文本，V1 最多 `["tasks"]`）
    //      · `tools_audit`   是否记录审计（NULL = 开；只记工具名 / 参数摘要 / 成败，不记内容）
    //    ⚠️ 清单的合法值由 `lib/tools.js` 的 READ_MODULES / WRITE_MODULES 收口，
    //    解析失败一律**空清单（全关）**—— 绝不「解析失败就放行」。
    ['ai_configs', 'tools_enabled', 'INTEGER'],
    ['ai_configs', 'tools_read', 'TEXT'],
    ['ai_configs', 'tools_write', 'TEXT'],
    ['ai_configs', 'tools_audit', 'INTEGER'],
    // ⭐ 0.7.7-⑲：AI 任务确认卡要落库 ⇒ `ai_messages` 加两列（同样是**可空列**，老库补出来是 NULL）。
    //    ⚠️ 这张表在装过 0.6.x 的库里**已经存在** ⇒ 必须登记在这里（`CREATE TABLE IF NOT EXISTS`
    //    永远补不上已存在表的列 —— 同一天在课表 `builtin_name` 上刚踩过同一个坑）。
    //    ⚠️ 加列**不升 `SCHEMA_VERSION`**；老库首次启动由 `ensureColumns` 补回来。
    //      · `kind` NULL = 普通消息；'task_proposal' = 确认卡
    //      · `meta` 卡片快照 JSON（逐字段白名单搬运，见建表语句那一段的说明）
    ['ai_messages', 'kind', 'TEXT'],
    ['ai_messages', 'meta', 'TEXT'],
    // ⭐ 0.8.6（行程 1 期 ·）：图片两列 —— ⚠️⭐ **最容易漏的就是这两条**
    //    （两张表在老库里早就存在，上面的建表语句对它们一个字都不管用）。
    //    漏了的下场：`POST /api/ai/chat` 带图时**不报错**，只是图静默丢掉（`image` 列不存在），
    //    而 `vision` 那一列漏了则读回来永远是 NULL ⇒ 界面上的开关点了没反应。
    //    · `ai_messages.image`  整串 data URL；NULL = 没有图
    //    · `ai_configs.vision`  能不能收图；NULL = 关（默认关，见 store.js 的 `viewOf()`）
    ['ai_messages', 'image', 'TEXT'],
    ['ai_configs', 'vision', 'INTEGER'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**故意留空**。
   *
   * 说明：⚠️ 不是漏写：`ai_configs` 的更新**不走通用 `_update()`**（配置的每一列都有专有语义，
   *      key 三列更是必须**整体写入**、绝不出现「只更新了 iv 没更新 cipher」的中间态），
   *      由本模块自己的 `updateAiConfig` op 落库 —— 列的合法集在 `modules/ai/store.js` 里
   *      用**硬映射**收口（patch 的键 → 列名），动态拼 SET 前先过这张映射表。
   *
   * @type {Object}
   */
  allowedCols: {},

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：四张表全部登记 —— AI 配置 / 会话 / 消息 / 记忆都是「一人一份」的数据，删账号随行消失；
   *      key 密文随行删除也是**多余的安全垫**（密钥材料本来就在账号外，但多清一次不亏）。
   *      ⚠️⭐ **`ai_memories` 是最容易漏的一处**（2 期新表）：漏了它的表现是「删账号后记忆残留」——
   *      静默、无报错，只有 `ttt/test/ai.test.js` 的「删账号清空」用例会把它咬住。
   *
   * @type {Array.<string>}
   */
  userScoped: ['ai_configs', 'ai_chats', 'ai_messages', 'ai_memories'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_ai_msg_chat`：会话内翻页（`WHERE chat_id=? AND id<?`）是**必定**会用到的路径；
   *      · `idx_ai_msg_user`：判权兜底与「该账号的全部 AI 消息」（删账号清空走 userScoped，
   *        但读侧的每一条查询都带 `user_id`，与 teamwork_messages 同款双索引）；
   *      · `idx_ai_memories_user`（2 期）：记忆列表与「注入取前 N 条」都是
   *        `WHERE user_id=? ORDER BY sort_no`，一条查询正好走它 —— 没有它就得逐账号全表扫。
   *      ⚠️ `ai_configs` / `ai_chats` 是每账号一行（`UNIQUE(user_id)` 自带索引），**不加索引**。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_ai_msg_chat ON ai_messages(chat_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_msg_user ON ai_messages(user_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_memories_user ON ai_memories(user_id, sort_no)',
  ],
};
