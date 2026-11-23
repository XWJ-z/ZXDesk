'use strict';
/**
 * modules/digital/schema.js —— **数码管理模块**
 * 功能：声明数码管理模块的**唯一一张表** `hardware_items` —— 一件数码件一行，
 * 台账（购买 / 价格 / 保修 / 品牌 / 型号 / 位置）与**愿望单**共处同一张表，
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
   * ① ⭐ `status` 三值就是全部状态机（`wishlist` 想买 → `owned` 在用 → `retired` 退役）；
   * 「买回来了」= 一次 `PUT`（改状态 + 补采购信息），**不是复制一条再删一条**；
   * ② ⚠️ `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / bookmarks 同一条理由）：
   */
  tables: {
    /**
     * 功能：生成 `hardware_items` 表的建表语句 —— 一件硬件 / 一条愿望。
     *
     * 说明：字段按「界面上的分组」排列，四组分别是 ——
     * **基本**：`name`（必填）/ `category` / `status` / `purpose` / `brand` / `model` /
     * `serial` / `capacity` / `quantity` / `location` / `slot`；
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
     *
     * 「这个的作用是预制新建硬件的模板菜单。现在的新建硬件完全是一个模样，
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
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   */
  aliases: {},

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：本模块是新增的，老库上根本没有这张表，**不需要重建**；`createAll()` 会用
   * `CREATE TABLE IF NOT EXISTS` 把它建出来。留空即「本模块没有需要重建的历史表」。
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
   * `hardware_items` 加的一列，而 `CREATE TABLE IF NOT EXISTS` 对已存在的表
   * **一个字节都不会动** ⇒ **老库上唯一生效的路径就是这里**（先 `PRAGMA table_info`
   * 看有没有，没有才 `ALTER TABLE ADD COLUMN`，幂等）。
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
   * `updated_at` 在白名单里，但 `_update()` **总是自己刷新**它，所以它等于只是个标记。
   * 白名单是**逐列列举**的：漏一列的表现是「那个字段怎么都保存不上」，
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
    // 模板表 —— ⛔ `builtin` 刻意**不在**白名单里：它是代码层的登记
    // （播种时由 `_ensureHardwareTemplates()` 直接 `_insert` 写 1），界面⛔ 写不到它。
    // `name` **在**白名单里（自建模板要能改名）—— 「内置不能改名」那条由
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
   * `idx_hw_user_status`：列表默认按状态分组（在用 / 愿望 / 退役）与计数，
   * 是四条索引里唯一**必定**会被用到的；
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_hw_user_status   ON hardware_items(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_category ON hardware_items(user_id, category)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_group    ON hardware_items(user_id, group_id)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_warranty ON hardware_items(user_id, warranty_until)',
    'CREATE INDEX IF NOT EXISTS idx_hw_user_created  ON hardware_items(user_id, created_at)',
    // 模板表按账号列（条数极少，一条就够 —— 建它只为与「所有查询都带 user_id」一致）
    'CREATE INDEX IF NOT EXISTS idx_hw_tpl_user      ON hardware_templates(user_id, sort_order)',
  ],
};
