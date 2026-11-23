'use strict';
/**
 * modules/ai/schema.js —— **ai辅助任务模块**的表结构声明
 * 功能：声明本模块的**四张表** —— `ai_configs`（每账号一行的接口配置，key 密文三列）、
 * `ai_chats`（AI 会话，一期每账号一条默认会话）、`ai_messages`（AI 消息，2 期起带对话分段）、
 * @author zx
 * @date   2026-09-15
 * @since 0.9.7
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
   * ① `ai_configs` 是**每账号一行**（`UNIQUE(user_id)`）：配置是「一个人对 AI 的偏好」，
   * 不存在第二条；「keySet」由三列密文是否**齐全**推导，接口层永远不出现 key 的任何投影；
   */
  tables: {
    /**
     * 功能：生成 `ai_configs` 表的建表语句 —— 每账号一行的 AI 接口配置。
     *
     * 说明：⚠️ `base_url` 允许 `http://`（本地 ollama 是真实场景， 拍板项 7），
     * 风险提示在『AI 辅助任务』界面上做，不在数据层拦；`enabled` 默认 0 ——
     *
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
     * 为什么必须存下来（方案里没写到的一处，实施时才发现）：段号不能只靠
     * 「消息里最大的那个 segment」推出来 —— 用户点「开启新对话」之后、还没发第一条消息时，
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
     * -⑲：多两列 `kind` / `meta` —— AI 提议建任务的**确认卡**要落库
     * （不落库的话刷新就没了、卡上那两颗按钮也没了）。⛔ **不改 `role` 的 CHECK**：
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
     * 系统提示词（注入点在 `routes.js` 的 `chatSystemPrompt()`，零新链路）。
     * **内容是明文**（与任务 / 收藏夹同级）：它是**用户内容**，不是密钥 ——
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
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这三张表，**不需要重建**；
   * `createAll()` 会用 `CREATE TABLE IF NOT EXISTS` 建出来。
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
   * 说明：⭐ 1 期这里**刻意留空** —— 那三张表是新表，`CREATE TABLE IF NOT EXISTS`
   * 一步到位；往这里写它们的列反而会在「表还没建」时执行 `ALTER TABLE` 报错。
   * **2 期第一次往「已经存在于老库里的表」上加列**，正需要这条通道 ——
   */
  ensureColumns: [
    ['ai_configs', 'ctx_max_turns', 'INTEGER'],
    ['ai_configs', 'mem_enabled', 'INTEGER'],
    ['ai_configs', 'mem_max', 'INTEGER'],
    ['ai_messages', 'segment', 'INTEGER'],
    ['ai_chats', 'cur_segment', 'INTEGER'],
    // ：默认拦私网地址的显式开关（NULL = 不开）
    ['ai_configs', 'allow_private', 'INTEGER'],
    // 记忆条目的**名称**（如「称呼」）—— 可空列，老库补出来是 NULL（视为「没有名称」，
    // 界面回落成自由文本那一种呈现）
    ['ai_memories', 'label', 'TEXT'],
    // 3 期：AI 工具调用的**授权状态**四列 —— 同样是**可空列**（老库补出来是 NULL，
    // 默认值只写一处：`store.js` 的 `viewOf()`）。⛔ 不写 NOT NULL / DEFAULT / CHECK（老库 ALTER 会失败）。
    // 四个值的语义都**默认关**（与模块 `defaultEnabled:false` 同口径），只有审计默认开：
    ['ai_configs', 'tools_enabled', 'INTEGER'],
    ['ai_configs', 'tools_read', 'TEXT'],
    ['ai_configs', 'tools_write', 'TEXT'],
    ['ai_configs', 'tools_audit', 'INTEGER'],
    // -⑲：AI 任务确认卡要落库 ⇒ `ai_messages` 加两列（同样是**可空列**，老库补出来是 NULL）。
    // 这张表在装过 0.6.x 的库里**已经存在** ⇒ 必须登记在这里（`CREATE TABLE IF NOT EXISTS`
    // 加列**不升 `SCHEMA_VERSION`**；老库首次启动由 `ensureColumns` 补回来。
    ['ai_messages', 'kind', 'TEXT'],
    ['ai_messages', 'meta', 'TEXT'],
    // ：图片两列 —— ⚠️⭐ **最容易漏的就是这两条**
    // （两张表在老库里早就存在，上面的建表语句对它们一个字都不管用）。
    // 漏了的下场：`POST /api/ai/chat` 带图时**不报错**，只是图静默丢掉（`image` 列不存在），
    ['ai_messages', 'image', 'TEXT'],
    ['ai_configs', 'vision', 'INTEGER'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**故意留空**。
   *
   * 说明：⚠️ 不是漏写：`ai_configs` 的更新**不走通用 `_update()`**（配置的每一列都有专有语义，
   * key 三列更是必须**整体写入**、绝不出现「只更新了 iv 没更新 cipher」的中间态），
   * 由本模块自己的 `updateAiConfig` op 落库 —— 列的合法集在 `modules/ai/store.js` 里
   */
  allowedCols: {},

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：四张表全部登记 —— AI 配置 / 会话 / 消息 / 记忆都是「一人一份」的数据，删账号随行消失；
   * key 密文随行删除也是**多余的安全垫**（密钥材料本来就在账号外，但多清一次不亏）。
   * **`ai_memories` 是最容易漏的一处**（2 期新表）：漏了它的表现是「删账号后记忆残留」——
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
   * `idx_ai_msg_chat`：会话内翻页（`WHERE chat_id=? AND id<?`）是**必定**会用到的路径；
   * `idx_ai_msg_user`：判权兜底与「该账号的全部 AI 消息」（删账号清空走 userScoped，
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_ai_msg_chat ON ai_messages(chat_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_msg_user ON ai_messages(user_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_memories_user ON ai_memories(user_id, sort_no)',
  ],
};
