'use strict';
/**
 * modules/bookmarks/schema.js —— **网址收藏夹模块**（0.3.0）
 *
 * 功能：声明网址收藏夹模块的三张表 —— `bookmarks`（书签）、`bookmark_tags`（分类）
 *      与 `bookmark_tag_links`（书签 × 分类的多对多关联），并给出各自的 DDL 生成器、
 *      重建顺序、归一化规则、`_update()` 列白名单、级联清空清单与索引语句。
 *
 * ⭐ 界面上叫「分类」，数据模型上是**标签**（多对多）—— 一条书签可以同时属于多个分类。
 *    理由：字符串标签只能 `LIKE` 匹配（「`.net` 命中 `aspnet`」）且重命名 = 全表改写；
 *    而标签是后期「导入时文件夹 → 分类」「按 URL 规则自动打标签」两个功能的既定落点。
 *
 * ⚠️ **刻意不推进 `SCHEMA_VERSION`**（方案 ③）：这三张表由 `createAll()` 的
 *    `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来，升版本号只会触发一次**整库重建**
 *    （DROP + 搬数据 + RENAME），代价与风险都白担。与 0.2.3 加 `timetable_adjustments` 同一手法。
 *
 * ⚠️ 模块契约见 core.js 的说明，由 `assertModules()` 在加载时自检。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/schema/bookmarks.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 表结构从此归这个目录所有。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.13
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/开发方案/03-网址收藏夹-1期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'bookmarks',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '网址收藏夹',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计取舍（方案 §4.1）——
   *      ① 删书签 / 删分类要连关联一起没：靠**数据库级外键 + `ON DELETE CASCADE`**，
   *         绝不再手写删除语句（0.1.2 「删父项留残留」的教训）；
   *      ② `bookmark_tags` 同账号内分类名唯一 —— 重命名与「智能新建」（输入不存在的分类名
   *         → 自动创建）都靠它；
   *      ③ `bookmarks` 同账号内 URL 唯一 —— 新增重复 URL 时**明确提示，不静默覆盖**。
   *      ⚠️ `user_id` **故意不加外键**（与 tasks 模块同一条理由）：它是「归属标签」不是结构父节点，
   *         而老库完全可能 user_id=1 却还没有 users 行（内置 admin 在 Store 构造**之后**才创建），
   *         加外键会把「首次启动」这条路径直接判死。也**不给 DEFAULT** —— 默认值会让
   *         「忘了传 user_id」从报错变成静默归到 1 号账号名下。账号删除的清空由 `userScoped` 保证。
   *
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `bookmarks` 表的建表语句 —— 一条网址收藏（URL + 标题）。
     *
     * 说明：`pinned` / `sort_order` 是**后期「导航视图」的预留列**，1 期不写入
     *      （方案 §4.1 明确「现在就建，成本≈0，后期不用动表」）。`source` 记录来源，
     *      1 期只有 `'manual'`，后期 Netscape HTML 导入写 `'import'`。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    bookmarks: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        source TEXT DEFAULT 'manual',
        pinned INTEGER DEFAULT 0 CHECK (pinned IS NULL OR pinned IN (0, 1)),
        sort_order INTEGER DEFAULT 0,
        vault_entry_id INTEGER,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `bookmark_tags` 表的建表语句 —— 分类（界面上叫「分类」，模型上是标签）。
     *
     * 说明：一人一行（不是「每条书签里存一串逗号分隔的标签」）—— 这样重命名是一次
     *      `UPDATE` 而不是全表改写，列表筛选与「每个分类有几条」也能直接用索引。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    bookmark_tags: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT
      );`,
    /**
     * 功能：生成 `bookmark_tag_links` 表的建表语句 —— 书签 × 分类的多对多关联。
     *
     * 说明：⚠️ **两个外键都不是可选的** —— 删书签 / 删分类时关联行必须自己消失，
     *      漏一个就会在列表里留下「指向不存在的分类」的孤儿关联行。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    bookmark_tag_links: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id)     ON DELETE CASCADE,
        tag_id      INTEGER NOT NULL REFERENCES bookmark_tags(id) ON DELETE CASCADE
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.3.0 新增），没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」，
   *      与「字段缺失」是两回事（后者会被 `assertModules` 判为契约不合格）。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这三张表，**不需要重建**；`createAll()` 会
   *      用 `CREATE TABLE IF NOT EXISTS` 把它们建出来。列在这里只会在别人将来真的
   *      改结构时被用到 —— 现在留空即「本模块没有需要重建的历史表」。
   *
   * @type {Array.<string>}
   */
  rebuildOrder: [],

  /**
   * 功能：重建搬数据时对「NULL 与默认值语义完全相同」的列做归一化。
   *
   * 说明：本模块不参与重建（见 `rebuildOrder`），所以没有归一化规则。
   *      留空是契约的一部分，不是漏写。
   *
   * @type {Object}
   */
  normalize: {},

  /**
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   *
   * 说明：⚠️ 三张表在 0.3.0 那批里是**新表**，靠 `CREATE TABLE IF NOT EXISTS` 一步到位；
   *      但从 0.8.5 起本模块**也有要补的列了**（见下）。
   *      ⚠️ 顺序是安全的：`_migrateSqlite()` **先 `createAll()` 再 `ensureColumns()`**
   *      （与 `teamwork/schema.js` 的 `remark` / `sender_builtin` 同一条路），
   *      所以空库上这两步都不会撞「表还没建」。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    // ⭐ 0.8.5：关联的**密码库条目 id**（NULL = 没关联）。
    //    ⚠️⭐ 这一列**必须**走 ensureColumns：bookmarks 表在老库里早就存在，上面的 DDL
    //    只在「表还没建」时管用 ⇒ 漏了这里 = 老用户那列永远不存在，而且**不报错**
    //    （表现是「关联好了密码库，刷新之后关联没了」）。
    //    ⚠️ **刻意不加外键**：密码库条目可能在那一侧被删掉 —— 加了外键，「删密码库条目」
    //    会在这边炸；悬空 id 改由**读取时兜住**（找不到那一条就当没关联，见 store.js）。
    ['bookmarks', 'vault_entry_id', 'INTEGER'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这张表的模块自报。
   *
   * 说明：⚠️ 三个**必须排除**的列（与 tasks 模块完全一致的理由）：
   *      `id`（不许改主键）、`user_id`（不许「过户」给别人）、`created_at`（创建时间只写一次）。
   *      ⚠️ `source` 也**故意不在白名单里**：它是「这条书签从哪来」的记账字段
   *      （1 期只有 `'manual'`，后期导入写 `'import'`），不该被一次 PUT 改掉。
   *      ⚠️ `bookmark_tag_links` 整表**刻意留空** —— 关联行的增删走
   *      `linkTag` / `unlinkTag` / `setBookmarkTags` 三条专用原语（它们要保证
   *      「同一个 (书签, 分类) 不重复插入」），把它开放给通用 `_update()` 等于绕开那层语义。
   *      留空 = 该表不可通用更新（`allowedCols` 为空 → `_update` 直接 `return false`），
   *      失败方向是安全的。
   *
   * @type {Object}
   */
  allowedCols: {
    bookmarks: ['url', 'title', 'pinned', 'sort_order', 'vault_entry_id', 'updated_at'],
    bookmark_tags: ['name', 'sort_order'],
    bookmark_tag_links: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**（三张表都带）。
   * @type {Array.<string>}
   */
  userScoped: ['bookmarks', 'bookmark_tags', 'bookmark_tag_links'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_bm_user_url` **唯一**：① 同账号内 URL 不得重复（新增重复时明确提示，
   *        不静默覆盖）；② 顺带成为列表查询 `WHERE user_id=?` 的索引。
   *      · `idx_bm_user_created`：列表默认按创建时间倒序（1 期唯一的排序口径）。
   *      · `idx_bmtags_user_name` **唯一**：分类名同账号内唯一，「智能新建」靠它查重。
   *      · `idx_bmlinks_pair` **唯一**：同一个 (书签, 分类) 只允许一行 —— 重复点选不会造出重复关联。
   *      · `idx_bmlinks_user_tag`：按分类筛选（`WHERE user_id=? AND tag_id=?`）与
   *        「每个分类下有几条书签」的计数都走它。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_user_url      ON bookmarks(user_id, url)',
    'CREATE INDEX        IF NOT EXISTS idx_bm_user_created  ON bookmarks(user_id, created_at)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_bmtags_user_name ON bookmark_tags(user_id, name)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_bmlinks_pair     ON bookmark_tag_links(bookmark_id, tag_id)',
    'CREATE INDEX        IF NOT EXISTS idx_bmlinks_user_tag ON bookmark_tag_links(user_id, tag_id)',
  ],
};
