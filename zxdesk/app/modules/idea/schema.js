'use strict';
/**
 * modules/idea/schema.js —— **灵感库（闪念捕获）模块**（0.7.1）
 *
 * 功能：声明本模块**唯一一张表** `idea_items` —— 一条灵感一行（纯文本正文 + 可选多个标签 +
 *      归档位 + 「变成任务」的追溯），并给出它的 DDL 生成器、列白名单、归属表清单与索引语句。
 *
 * ⭐ **定位是「捕获」，不是「存储」**（调研报告 07 §〇）：成败的标准是「起念之后几秒能落下来」，
 *    所以这张表**只有一列真内容**（`content`），分类靠可选的 `tags`、整理靠 `archived_at` ——
 *    ⛔ 捕获那一刻不要求用户做任何选择（inbox → 整理的通用习惯）。
 *
 * ⭐⭐ 0.8.14：「标签可以新建；这里可以选择已有标签，**一个随手记可以有多个标签**，
 *    参考网址收藏夹」⇒ `tags` 从「一个字符串」变成**一组标签**（当时落库是一列 JSON 数组文本）。
 * ⭐⭐ 0.8.15：标签**也从一列
 *    JSON 数组文本升级成两张真表**（`idea_tags` 标签本体 ＋ `idea_tag_links` 多对多）—— 与收藏夹
 *    **逐字同构**（只换前缀与父表），于是「新建空标签」「改名只 UPDATE 一行」两件事在随手记这一侧
 *    也成立，不再需要「扫全表算标签」。
 *    ⚠️ `tags` 列**保留但只读**（与更老的 `tag` 列当年一模一样）：老库里的值不丢 —— 读侧在
 *    `links` 为空时兜底用它（见 `store.js` 的 `parseTags()` 与文件头「读侧双认」那段）。
 *    新写入**一律只写 links**。
 *    ⚠️ `tag`（更老的单个标签列）同样**保留但只读**，两级兜底都还在。
 *
 * ⭐ **与任务板的边界**（报告 §一 第 2 条）：灵感是**未成形**的东西（没有日期、没有归属、没有优先级），
 *    所以**不进** `daily_tasks` / `project_tasks` —— 否则会污染今日待办与看板统计。
 *    两者之间只有**一条单向通道**：灵感 →（一键）→ 任务，走过之后把
 *    `task_id` / `task_source` 记回来（见下），任务那边**一个字都不改**（走既有建任务接口）。
 *
 * ⚠️ `archived_at` **归档而不是删除**（报告 §七 待）：成本极低、可撤销，
 *    而「闪念」这类东西误删的代价远高于留着。
 * ⚠️ 正文渲染一律 `textContent`：灵感常含私人情绪与工作想法，
 *    接口**原样保存**、不静默改写，界面**不解析任何标记**（V1 是纯文本，Markdown 是后期项）。
 *
 * ⚠️ 模块契约见 index.js 的说明，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.15
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md、
 *      docs/公共/调研报告/07-灵感库（闪念捕获）调研.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'idea',

  /**
   * 功能：模块中文名，仅用于日志展示。
   *      ⭐ 0.8.5：界面上它叫「随手记」——
   *      模块 id / 目录名 / 接口 / 表名**仍然是 `idea`**（只改显示名，不动结构）。
   * @type {string}
   */
  label: '随手记',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计取舍 ——
   *      ① ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / hardware 同一条理由）：
   *         它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死；
   *         给 DEFAULT 则会让「忘了传 user_id」从报错变成静默归到 1 号账号名下。
   *      ② ⭐ `task_id` + `task_source` **成对出现**：日常任务与项目任务是**两张表**，
   *         各自的 id 都从 1 开始自增 ⇒ 只记 id 会把「日常任务 3」与「某项目任务 3」判成同一件事。
   *         这条坑在对话模块的提醒记账键上**真的踩过**，这里提前避开。
   *      ③ ⚠️ `from_task_id` **1 期不建**：报告 §3.4 把它列为「预留」，而「任务反推灵感」
   *         目前没有任何入口 ⇒ 建了就是一行永远为空的死列（⛔ 宁可加列，不要加没人写的列）。
   *
   * @param {string} n - 表名（重建时是临时名）
   * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
   * @returns {string} 该表的 `CREATE TABLE` 语句
   */
  tables: {
    /**
     * 功能：生成 `idea_items` 表的建表语句 —— 一条灵感 / 闪念。
     *
     * 说明：日期列一律 `TEXT`（`YYYY-MM-DD HH:MM:SS`）—— 字典序即时间序，比较不用转 `Date`。
     *      ⚠️ `archived_at` **为空 = 还在未归档**，有值 = 已归档；两种状态共用一张表，
     *      与硬件模块「台账与愿望单同一张表」是同一手法（状态用一列表达，不另建表）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    idea_items: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,          -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        content      TEXT    NOT NULL,          -- 灵感正文（纯文本；⛔ 界面不解析、不改写）
        title        TEXT,                      -- ⭐ 0.8.15：标题（可空；空 = 界面用「正文前 10 字」兜底，⛔ 不落库）
        tag          TEXT,                      -- ⚠️ 0.8.14 起**只读**的历史列（老的单个标签）
        tags         TEXT,                      -- ⚠️ 0.8.15 起**只读**的历史列（0.8.14 的 JSON 数组文本；新写入走 idea_tag_links）
        archived_at  TEXT,                      -- 归档时间；**空 = 还在未归档**
        task_id      INTEGER,                   -- ⭐ 已变成哪个任务（配合 task_source 才有意义）
        task_source  TEXT CHECK (task_source IS NULL OR task_source IN ('daily','project')),
        created_at   TEXT,
        updated_at   TEXT
      );`,
    /**
     * 功能：生成 `idea_tags` 表的建表语句 —— 标签本体（界面上叫「标签」）。
     *
     * 说明：⭐ 0.8.15：**照 `bookmark_tags` 逐字同构**（只换前缀）——
     *      一人一行，于是「改名只是一次 `UPDATE`」「新建空标签有地方存」两件事都成立。
     *      `sort_order` 是**预留列**，本轮不写入（照收藏夹的 `pinned` / `sort_order` 手法）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    idea_tags: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        name       TEXT    NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT
      );`,
    /**
     * 功能：生成 `idea_tag_links` 表的建表语句 —— 随手记 × 标签的多对多关联。
     *
     * 说明：⚠️ **两个外键都不是可选的**（照 `bookmark_tag_links` 逐字同构，只换父表名）：
     *      删随手记 / 删标签时关联行必须自己消失（`ON DELETE CASCADE`），漏一个就会在列表里
     *      留下「指向不存在的标签」的孤儿关联行。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    idea_tag_links: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        idea_id INTEGER NOT NULL REFERENCES idea_items(id) ON DELETE CASCADE,
        tag_id  INTEGER NOT NULL REFERENCES idea_tags(id)  ON DELETE CASCADE
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.7.1 新增），没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这张表，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它建出来。
   *
   * @type {Array.<string>}
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
   * 说明：⚠️ 本模块原本**刻意留空**（表是新表，`CREATE TABLE IF NOT EXISTS` 一步到位）；
   *      「真机装过中间态」那条一旦成立，后加的列 `CREATE TABLE IF NOT EXISTS` 就**永远补不上** ——
   *      `tags` 正是这种情况（真机装过 0.7.1 起的 `idea_items`）⇒ 必须登记在这里。
   *      ⚠️ 顺序是安全的：`_migrateSqlite()` **先 `createAll()` 再 `ensureColumns()`**，
   *      所以空库上这两步都不会撞「表还没建」。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    // ⭐ 0.8.14：标签从「一个」变成「一组」（规范化 JSON 数组文本）。
    ['idea_items', 'tags', 'TEXT'],
    // ⭐ 0.8.15：标题列 —— ⚠️ 真机装过 0.7.1 起的 `idea_items`，
    //    `CREATE TABLE IF NOT EXISTS` **永远补不上新列** ⇒ 必须登记在这里（DDL 里也补了一份给新库）。
    ['idea_items', 'title', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这张表的模块自报。
   *
   * 说明：⚠️ 三个**必须排除**的列（与 tasks / hardware 完全一致的理由）：
   *      `id`（不许改主键）、`user_id`（不许「过户」给别人）、`created_at`（创建时间只写一次）。
   *      `updated_at` 在白名单里，但 `_update()` **总是自己刷新**它。
   *
   * @type {Object}
   */
  allowedCols: {
    // ⚠️⭐ `tag`（老的单个标签）**故意不在白名单里**（0.8.14）：它现在是**只读的历史列** ——
    //    放进来就等于「同一件事有两列可写」，两边一旦不一致，界面按 `tags` 显示、库里 `tag`
    //    却还留着旧值，而**谁都不会报错**。老值不丢，由 `store.js` 的 `shape()` 兜住。
    // ⚠️⭐ 0.8.15：`tags` 也从白名单里**去掉** —— 标签改住两张真表（`idea_tag_links`），
    //    把它留在白名单里就是「同一件事有两处可写」，而两处必然漂移（且不报错）。
    //    ⭐ `title` 加进来：它是**平铺实体上的一列**，逐列写正合适。
    idea_items: ['content', 'title', 'archived_at', 'task_id', 'task_source', 'updated_at'],
    // ⭐ 0.8.15：标签本体只开放 `name` / `sort_order`（改名走它；
    //    `id` / `user_id` / `created_at` 与收藏夹同理由排除）。
    idea_tags: ['name', 'sort_order'],
    // ⚠️ 关联行整表**刻意留空**（照 `bookmark_tag_links`）—— 增删走 `setIdeaTags` 专用原语
    //    （它保证「同一个 (随手记, 标签) 不重复插入」），开放给通用 `_update()` 等于绕开那层语义。
    idea_tag_links: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**（三张表都带）。
   * @type {Array.<string>}
   */
  userScoped: ['idea_items', 'idea_tags', 'idea_tag_links'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_idea_user_created`：列表默认「新的在前」，是两处里**必定**会被用到的；
   *      · `idx_idea_user_archived`：未归档（`archived_at IS NULL`）与归档两个视图的筛选。
   *      ⚠️ 搜索**不走索引**：V1 用 `LIKE '%kw%'`（前置通配符本来也用不上索引），
   *      数据量到几万条再评估 FTS5（报告 §七 待）。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_idea_user_created  ON idea_items(user_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_idea_user_archived ON idea_items(user_id, archived_at)',
    // ⭐ 0.8.15：三条新索引，**照 `bookmarks/schema.js` 那三条逐条同源**：
    //    · `idx_itags_user_name` **唯一**：标签名同账号内唯一 → 「智能新建」靠它查重、改名不撞名；
    //    · `idx_ilinks_pair`     **唯一**：同一个 (随手记, 标签) 只允许一行 —— 重复点选不造重复关联；
    //    · `idx_ilinks_user_tag`：按标签筛选与「每个标签下有几条」的计数都走它。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_itags_user_name ON idea_tags(user_id, name)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ilinks_pair     ON idea_tag_links(idea_id, tag_id)',
    'CREATE INDEX        IF NOT EXISTS idx_ilinks_user_tag ON idea_tag_links(user_id, tag_id)',
  ],
};
