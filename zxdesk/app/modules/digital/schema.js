'use strict';
/**
 * modules/digital/schema.js —— **数码管理模块**（原 `hardware`，0.8.10 改名扩写）
 *
 * 功能：声明数码管理模块的**唯一一张表** `hardware_items` —— 一件数码件一行，
 *      台账（购买 / 价格 / 保修 / 品牌 / 型号 / 位置）与**愿望单**共处同一张表，
 *      由 `status`（`wishlist` → `owned` → `retired`）区分；给出它的 DDL 生成器、
 *      列白名单、级联清空清单与索引语句。
 *
 * ⭐ **界面上叫「数码管理」，代码里叫 `digital`**（模块标识）；⚠️ **表名仍是 `hardware_items`**、
 *    **接口前缀仍是 `hardware`** —— 两者都是**对外契约**（备份键是表名；
 *    前缀被前端 URL / AI 工具名 / 探针 / 真机验收点引用），⛔ 一个字都不改。
 *    统一命名留作**单独一次改动**。
 *
 * ⭐⭐ **0.8.23 的增量**（「预制新建硬件的模板菜单」）：新增
 *    **`hardware_templates` 表**（新建硬件时先选的模板：11 个预置 + 用户自建）
 *    ＋ `hardware_items` 上两列（`template_id` = 用的哪个模板、`attrs` = 该模板专业参数的值）。
 *    三者都是**加表 / 加列**，⛔ 不动任何一列既有语义 —— 老记录没有模板（界面上按「通用」显示）。
 *
 * ⭐ **0.8.10 的增量**：新增 `group_id` 列 —— 指向 `asset_groups` 里
 *    这一件所属的**分类行**（数码管理那一格下的「电脑 / 手机 / NAS硬件 / 相机…」）。
 *    ⚠️ **不加外键**：删分类只解绑，悬空由界面说一句。
 *    ⚠️ 老列 `category`（自由文本的「建议值」）**保留、语义退役**：老数据一个人在，
 *    新界面按 `group_id` 筛。
 *
 * ⭐ **愿望单为什么不建第二张表**（方案）：一手样本（现在的 `目标：xxx.txt` 台账）
 *    本来就是把「想买」与「已买」写在同一条的名字前缀上 —— 它们是**同一件事的不同状态**，
 *    不是两类记录。
 *
 * ⭐ **寿命预警不落库**（方案 §4.1 取舍 3）：预警由 `purchase_date` + 用户填的
 *    `expected_life_months` **算**出来（本模块的 `lib/life.js` 纯函数），库里没有这一列。
 *
 * ⚠️ **刻意不推进 `SCHEMA_VERSION`**（方案）：这张表由 `createAll()` 的
 *    `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来，新列走 `ensureColumns` 幂等补列 ——
 *    升版本号只会触发一次**整库重建**（DROP + 搬数据 + RENAME），代价与风险都白担。
 *
 * ⚠️ 模块契约见 index.js 的说明，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.23
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/架构文档/26-个人资产管理.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'digital',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '数码管理',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：三条刻意的设计取舍（方案 §4.1）——
   *      ① ⭐ `status` 三值就是全部状态机（`wishlist` 想买 → `owned` 在用 → `retired` 退役）；
   *         「买回来了」= 一次 `PUT`（改状态 + 补采购信息），**不是复制一条再删一条**；
   *      ② ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / bookmarks 同一条理由）：
   *         它是「归属标签」不是结构父节点，而老库完全可能 user_id=1 却还没有 users 行
   *         （内置 admin 在 Store 构造**之后**才创建），加外键会把「首次启动」判死；
   *         给 DEFAULT 则会让「忘了传 user_id」从报错变成静默归到 1 号账号名下；
   *      ③ ⚠️ 金额一律**整数元**（`INTEGER`，方案）：家庭硬件价格几乎都是整数元，
   *         这样既避开浮点误差，也避开「精确到分还是角」的争论。要更细的口径 2 期再评估。
   *
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `hardware_items` 表的建表语句 —— 一件硬件 / 一条愿望。
     *
     * 说明：字段按「界面上的分组」排列，四组分别是 ——
     *      · **基本**：`name`（必填）/ `category` / `status` / `purpose` / `brand` / `model` /
     *        `serial` / `capacity` / `quantity` / `location` / `slot`；
     *      · **采购**：`purchase_date` / `purchase_price` / `vendor` / `warranty_until`；
     *      · **寿命**：`expected_life_months`（**用户自己填的经验值**，不是厂商承诺）；
     *      · **愿望**：`wish_priority` / `wish_target_price` / `wish_url` / `wish_reason`。
     *      `note` 是「详细内容」—— 现有 txt 记事本的正文**原样进这里，永不解析**
     *      （方案 §1.1 第 1 条硬约束）。
     *
     *      ⚠️ 日期列全是 `TEXT`（`YYYY-MM-DD`）：字典序即时间序，比较不用转 `Date`
     *      （本项目既有的时区坑，见 AGENTS.md §八）。**不做「合理性」校验** ——
     *      `1900-01-01` 照样收下（与课表同口径：只保证「真实存在」，不猜「合不合理」）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    hardware_items: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id              INTEGER NOT NULL,          -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        group_id             INTEGER,                   -- ⭐ 0.8.10：指向 asset_groups 的分类行；⚠️ 无外键（删分类只解绑）
        template_id          INTEGER,                   -- ⭐ 0.8.23：用的哪个模板（hardware_templates.id）；⚠️ 无外键，空 = 按「通用」算
        name                 TEXT    NOT NULL,          -- 叫得出名字，必填
        category             TEXT,                      -- ⚠️ 语义退役（0.8.10）：老数据保留，新界面按 group_id 筛
        status               TEXT DEFAULT 'owned' CHECK (status IS NULL OR status IN ('wishlist','owned','retired')),
        purpose              TEXT,                      -- ⭐ 用途：用户文件｜影音｜课程｜监控｜团队…（一手样本实证，见方案 §1.1）
        brand                TEXT,
        model                TEXT,
        serial               TEXT,                      -- 序列号（保修要用；样本里无处可放，正是本模块的增量）
        capacity             TEXT,                      -- 自由文本：「4TB」「32GB」；⚠️ 不做单位解析
        quantity             INTEGER DEFAULT 1 CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 999),
        location             TEXT,                      -- 装在哪台机器 / 哪个柜子（自由文本）
        slot                 TEXT,                      -- 盘位 / 槽位（自由文本）
        purchase_date        TEXT,                      -- YYYY-MM-DD，寿命推算的**唯一基准**
        purchase_price       INTEGER,                   -- ⭐ 整数元（方案决策 9）
        vendor               TEXT,                      -- 买自哪里
        warranty_until       TEXT,                      -- YYYY-MM-DD，保修到期提醒
        expected_life_months INTEGER,                   -- ⭐ 用户设定：寿命条的分母（没填＝不做寿命预警）
        wish_priority        INTEGER DEFAULT 0 CHECK (wish_priority IS NULL OR wish_priority BETWEEN 0 AND 3),
        wish_target_price    INTEGER,                   -- 同上，整数元
        wish_url             TEXT,
        wish_reason          TEXT,                      -- ⭐ 「为什么想买」（送礼类愿望单没有的字段）
        note                 TEXT,                      -- ⭐ 「详细内容」（现有 txt 正文的落点，不解析）
        attrs                TEXT,                      -- ⭐ 0.8.23：这一件在它那个模板下的专业参数值（JSON 对象文本）
        created_at           TEXT,
        updated_at           TEXT
      );`,

    /**
     * 功能：生成 `hardware_templates` 表的建表语句 —— **新建硬件时先选的那个模板**（0.8.23）。
     *
     * ⭐ 「这个的作用是预制新建硬件的模板菜单。现在的新建硬件完全是一个模样，
     *    可是硬盘、主机、内存这些的参数属性不完全一样，用一套不专业」。
     *    ⇒ 一件硬件 = 一个模板 + 那套专业参数的值（值存在 `hardware_items.attrs` 里）。
     *
     * ⚠️⭐ **`fields` 存 JSON 数组文本，⛔ 不建子表**（「字段定义表」）—— 三条理由：
     *    · 一份模板的字段**总是整体读写**（新建 / 编辑模板时整块替换），没有「只查某一个字段」的需求；
     *    · 建子表要多一套 CRUD ＋ 组内排序 ＋ 删模板时级联，买到的只有「能在 SQL 里按字段筛」——
     *      而本模块的列表筛选**本来就在内存里做**（`store.js` 的 `listHardware`，两个后端语义一致）；
     *    · 与 `hardware_items.attrs` 同一条口径（值也是一整块 JSON）。
     *    ⚠️ 代价说清楚：将来若要「按显存大小筛硬件」，得先把这一列解析出来（那时再评估加冗余列）。
     *
     * ⚠️ `builtin = 1` 的 11 个（见 `lib/templates.js`）**不能删、不能改名**，
     *    只允许往 `fields` 里**追加**自定义属性（`store.js` 的 `updateHardwareTemplate` 校验超集）。
     *    ⚠️ 判据是**这一列**，⛔ 不是名字（与 `asset_groups.builtin`／`ledger_groups.builtin` 同一条纪律）。
     *
     * ⚠️ `user_id` 同样**不加外键、不给 DEFAULT**（与 `hardware_items` 逐条同理由）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    hardware_templates: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,           -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        name        TEXT    NOT NULL,           -- 模板名（「硬盘」「内存」…）
        builtin     INTEGER NOT NULL DEFAULT 0, -- ⭐ 1 = 预制的 11 个：不能删、不能改名，只能追加属性
        fields      TEXT,                       -- ⭐ 专业参数定义（JSON 数组文本）：[{ key, label, ph }]
        sort_order  INTEGER DEFAULT 0,          -- 同级先后（内置按 10/20/30…，自建接在后面）
        created_at  TEXT,
        updated_at  TEXT
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的（0.3.1 新增），没有改过名。
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
   *      `CREATE TABLE IF NOT EXISTS` 把它建出来。留空即「本模块没有需要重建的历史表」。
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
   * 说明：⭐ **0.8.10 起这里不再为空**：`group_id` 是给**已有的**
   *      `hardware_items` 加的一列，而 `CREATE TABLE IF NOT EXISTS` 对已存在的表
   *      **一个字节都不会动** ⇒ **老库上唯一生效的路径就是这里**（先 `PRAGMA table_info`
   *      看有没有，没有才 `ALTER TABLE ADD COLUMN`，幂等）。
   *      ⚠️ 类型只写 `INTEGER`（不带 NOT NULL / DEFAULT）：`ALTER TABLE ADD COLUMN` 加
   *      带 NOT NULL 且无默认值的列会被 SQLite 拒绝；而且这一列本来就允许为空（未归类）。
   *      ⭐⭐ 0.8.23：`template_id` / `attrs` 走**同一条路**（那张表 0.3.1 就在了）——
   *      两列都允许为空：老记录没有模板（界面上按「通用」显示）、也没有专业参数。
   *      ⚠️ **不加结构版本号**（仍是 v5）：补列是幂等的，升版本号只会白担一次整库重建。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['hardware_items', 'group_id', 'INTEGER'],
    ['hardware_items', 'template_id', 'INTEGER'],
    ['hardware_items', 'attrs', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 由定义这张表的模块自报。
   *
   * 说明：⚠️ 三个**必须排除**的列（与 tasks / bookmarks 完全一致的理由）：
   *      `id`（不许改主键）、`user_id`（不许「过户」给别人）、`created_at`（创建时间只写一次）。
   *      `updated_at` 在白名单里，但 `_update()` **总是自己刷新**它，所以它等于只是个标记。
   *      ⚠️ 白名单是**逐列列举**的：漏一列的表现是「那个字段怎么都保存不上」，
   *      而失败方向是安全的（改不动，不是乱改）。`ttt/test/hardware.test.js` 拿**真实的表结构**
   *      核对这张表，防止它与 DDL 漂移。
   *
   * @type {Object}
   */
  allowedCols: {
    hardware_items: [
      'group_id',
      'template_id',
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
      'attrs',
      'updated_at',
    ],
    // ⭐ 0.8.23：模板表 —— ⛔ `builtin` 刻意**不在**白名单里：它是代码层的登记
    //    （播种时由 `_ensureHardwareTemplates()` 直接 `_insert` 写 1），界面⛔ 写不到它。
    //    ⚠️ `name` **在**白名单里（自建模板要能改名）—— 「内置不能改名」那条由
    //    `updateHardwareTemplate()` 按行上的 `builtin` 拦，⛔ 不是靠白名单。
    hardware_templates: ['name', 'fields', 'sort_order', 'updated_at'],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   * @type {Array.<string>}
   */
  userScoped: ['hardware_items', 'hardware_templates'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_hw_user_status`：列表默认按状态分组（在用 / 愿望 / 退役）与计数，
   *        是四条索引里唯一**必定**会被用到的；
   *      · `idx_hw_user_category`：分类筛选与「按分类看一共几件」；
   *      · `idx_hw_user_warranty`：保修到期提醒（`warranty_until` 非空时按它升序取最近到期的）；
   *      · `idx_hw_user_created`：同一状态内的稳定排序（新的在前）。
   *      ⚠️ **预警不从索引走** —— 它由 `purchase_date` + `expected_life_months` 算出来，
   *      库里没有这一列（见文件头）。将来真要按预警排序，再评估加冗余列，现在加＝过早优化。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_hw_user_status   ON hardware_items(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_category ON hardware_items(user_id, category)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_group    ON hardware_items(user_id, group_id)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_warranty ON hardware_items(user_id, warranty_until)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_created  ON hardware_items(user_id, created_at)',
    // ⭐ 0.8.23：模板表按账号列（条数极少，一条就够 —— 建它只为与「所有查询都带 user_id」一致）
    'CREATE INDEX IF NOT EXISTS idx_hw_tpl_user      ON hardware_templates(user_id, sort_order)',
  ],
};
