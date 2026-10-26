'use strict';
/**
 * modules/trip/schema.js —— **行程模块**（0.8.6）
 *
 * 功能：声明本模块**四张表** —— `time_trips`（一次出行一条）/ `time_trip_tickets`（车票）/
 *      `time_trip_points`（轨迹点与打卡点，靠 `kind` 区分）/ `time_trip_prefs`（每账号一行：三档出发提醒开关），
 *      并给出它们的 DDL 生成器、列白名单、归属表清单与索引语句。
 *
 * ⭐ **四张表全部住主库**：⛔ 不进记账那个独立库 ——
 *    `zxdesk-ledger.db` 是项目 的**唯一例外**，本模块不是第二个例外。
 *
 * ⭐ **为什么轨迹点与打卡点**合表：两者的物理量完全相同（一个时刻 ＋
 *    一个坐标 ＋ 精度），分开建表会让「画轨迹时把打卡点一起画上去」变成一次跨表 union，
 *    而渲染上它们本来就该在一起。靠 `kind ∈ {track, checkin}` 区分。
 *
 * ⭐ **归属是「可空的单向指向」**：`time_trip_tickets.trip_id` /
 *    `time_trip_points.trip_id` **可空**，且**刻意不加外键** —— 删除语义是「**解绑，不级联删**」
 *    （车票与轨迹是**已经发生过的事实凭证**，行程只是一层分组）。
 *    ⚠️ 这与任务板刻意相反（那边删项目连任务一起删）：任务是可以被重新安排的**待办**，
 *    车票与轨迹是**已发生的记录**。⛔ 别在后人「统一」掉这条。
 *
 * ⭐ **车票的时刻是「当地时刻字符串」`YYYY-MM-DD HH:MM`**，⛔ 不存 epoch：
 *    一张票的时间是出发地 / 目的地的当地时刻（**凭证上的事实**），不是「我这个设备的时区里的某一瞬间」。
 *    存 epoch 之后，用别的时区的设备打开就会把「09-30 08:00 从北京南出发」显示成别的钟点。
 *    ⚠️ 与番茄钟的差别**写清楚**：番茄钟用 epoch 毫秒是因为它按秒算差、且记的是「这台机器上发生过的事」。
 *    两者口径不同是**有意的**，⛔ 别顺手统一。
 *
 * ⚠️ **四张表刻意都不进通用 `_update()` 白名单**（`allowedCols` 四张全空）：
 *    它们的变化都走**专用原语**（整行写回 / upsert）。放开通用更新等于让请求体里任意一个键
 *    都有机会流到列上 —— `time_trip_points.at` / `lat` / `lng` 更是「这条记录本身」。
 *    ⇒ 同时要把四张表登记进 `ttt/test/schema.test.js` 的 `SKIP_TABLES`（否则逐列对齐断言会红）。
 *
 * ⚠️ 模块契约见 `modules/README.md`，由 `assertModules()` 在加载时自检。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.13
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'trip',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '行程',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：⚠️ 四张表的 `user_id` **故意不加外键、不给 DEFAULT**（与 tasks / calendar / pomodoro 同一条理由）：
   *      它是「归属标签」不是结构父节点，加外键会把「首次启动（users 行还没建）」判死。
   *
   * @param {string} n - 表名（重建时是临时名）
   * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
   * @returns {string} 该表的 `CREATE TABLE` 语句
   */
  tables: {
    /**
     * 功能：生成 `time_trips` 表的建表语句 —— 一次出行一条。
     *
     * 说明：⭐ **刻意不落「状态（计划中 / 进行中 / 已结束）」**：它是 `start_date` / `end_date`
     *      与**今天**算出来的派生量，落库就是第二个真相源（与硬件「寿命预警不落库」、
     *      番茄钟「绝不存剩余秒数」同一条纪律）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_trips: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,          -- ⭐ 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        title       TEXT NOT NULL,             -- 必填（空 / 超长一律 400，见 routes.js）
        vehicle     TEXT,                      -- ⭐ 交通工具（可空；值域 = 票型那套 key，见下）
        from_place  TEXT,                      -- ⭐ 起点（可空）
        to_place    TEXT,                      -- ⭐ 终点（可空）
        start_date  TEXT NOT NULL,             -- 开始日 YYYY-MM-DD（字典序可比）
        start_time  TEXT,                      -- ⭐ 起始时刻 HH:MM；⭐ 0.8.13 起**新建必填**（写入口校验，
                                               --   ⛔ 这里刻意**不加 NOT NULL**：老行是 NULL，加了会让老库存不进新记录）
        end_date    TEXT,                      -- 可空；NULL = 当天结束
        end_time    TEXT,                      -- ⭐ 0.8.13：结束时刻 HH:MM（可空）；
                                               --   首页「日程表」靠 start_time/end_time 画那一段的长度
        note        TEXT,                      -- 可空
        created_at  INTEGER,                   -- 审计用，不参与判定
        updated_at  INTEGER                    -- 审计用，不参与判定
      );`,

    /**
     * 功能：生成 `time_trip_tickets` 表的建表语句 —— 车票（手动创建 / AI 提议确认后创建）。
     *
     * 说明：⭐ `depart_at` / `arrive_at` 是**当地时刻字符串**，
     *      ⛔ 不存 epoch；`arrive_at` 允许**跨天与早于出发日**（红眼航班 / 跨零点）⇒
     *      ⛔ **不加「必须晚于出发」的跨列约束**（那是把正常情形判成错的）。
     *      ⚠️ `order_no` 落库（用户自己要存），但 ⛔ **不进 AI 工具面**（
     *      出网面收窄 —— 与硬件不给序列号同一条口径）。
     *      ⚠️ `price_fen` 是**整数分**（照记账的钱口径），⛔ 不用浮点元。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_trip_tickets: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        trip_id      INTEGER,                  -- ⭐ 可空：单向指向 time_trips.id（⛔ 不加外键，删除语义是「解绑」）
        kind         TEXT NOT NULL CHECK (kind IN ('train', 'highspeed', 'flight', 'bus', 'ship', 'other')),
        code         TEXT,                     -- 车次 / 航班号 / 班次（如 G1234 / CA1858）；可空（大巴常没有号）
        from_station TEXT NOT NULL,            -- 出发站 / 出发机场（必填）
        to_station   TEXT NOT NULL,            -- 到达站 / 到达机场（必填）
        depart_at    TEXT NOT NULL,            -- ⭐ 出发当地时刻 YYYY-MM-DD HH:MM（定长两位，字典序即时间序）
        arrive_at    TEXT,                     -- 可空；同格式；⭐ 允许跨天与早于出发日（⛔ 不加跨列约束）
        seat         TEXT,                     -- 座位号 / 席别（如「二等座 07车12F」）
        gate         TEXT,                     -- 检票口 / 登机口
        terminal     TEXT,                     -- 航站楼（火车不用）
        price_fen    INTEGER,                  -- 票价（整数分）
        order_no     TEXT,                     -- 订单号 / 票号；⚠️ 不进 AI 工具面
        note         TEXT,
        created_at   INTEGER,
        updated_at   INTEGER
      );`,

    /**
     * 功能：生成 `time_trip_points` 表的建表语句 —— 轨迹点与打卡点（同一张表，`kind` 区分）。
     *
     * 说明：⭐ `at` 是**设备给的测量时刻**（epoch 毫秒）——
     *      服务端**只校验合理性、⛔ 不覆盖**：轨迹是批量补传的（每 20 秒或每 50 个点发一批），
     *      服务端盖时刻会把「一路上采到的 50 个点」全压成同一毫秒 ⇒ 时间轴**当场失真**且不报错。
     *      ⚠️ `created_at` 另存**服务端**收到那一刻（只作审计，⛔ 不参与任何判定）。
     *      ⚠️ `label` 只对打卡点有意义（轨迹点一般为空）。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_trip_points: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        trip_id    INTEGER,                    -- ⭐ 可空（同上：不加外键，「解绑」不是「级联删」）
        kind       TEXT NOT NULL CHECK (kind IN ('track', 'checkin')),
        at         INTEGER NOT NULL,           -- ⭐ 设备给的测量时刻（epoch 毫秒；服务端只校验不覆盖）
        lat        REAL NOT NULL,              -- 纬度 [-90, 90]
        lng        REAL NOT NULL,              -- 经度 [-180, 180]
        accuracy   REAL,                       -- 水平精度（米）；可空（手动填的点没有）
        altitude   REAL,                       -- 海拔（米）；可空
        speed      REAL,                       -- 速度（米 / 秒，浏览器给的原值）；可空
        heading    REAL,                       -- 方向角（度）；可空
        label      TEXT,                       -- 打卡点的名字（如「杭州东站」）；轨迹点一般为空
        note       TEXT,
        created_at INTEGER                     -- ⭐ 服务端收下那一刻（审计）
      );`,

    /**
     * 功能：生成 `time_trip_prefs` 表的建表语句 —— 每账号一行：三档出发提醒开关。
     *
     * 说明：⭐ 三个开关默认**全开**（`DEFAULT 1`）：提醒是这一期的卖点，默认关掉等于把功能藏起来
     *      （与 `calendar_prefs` 的图层开关同款）。⚠️**读侧的默认值常量**住 `store.js` 一处
     *      （`TRIP_PREF_DEFAULT`），两个后端与 DDL 都**不兜默认值**（与 `PREF_DEFAULT` /
     *      `REMINDER_PREFS_DEFAULT` 同一条理由：分散在多处时，「换了后端行为就变了」且查起来毫无线索）。
     *      ⚠️ 三档**与 `users.hide_trip` 是两件事**：那一列承担「要不要在界面上看见行程」，
     *      这三档承担「这个账号想收哪几档提醒」。
     *      `UNIQUE(user_id)` 是 upsert 的落点。
     *
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    time_trip_prefs: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        remind_d3   INTEGER NOT NULL DEFAULT 1 CHECK (remind_d3 IN (0, 1)),   -- 出发前 3 天
        remind_d1   INTEGER NOT NULL DEFAULT 1 CHECK (remind_d1 IN (0, 1)),   -- 出发前 1 天
        remind_h3   INTEGER NOT NULL DEFAULT 1 CHECK (remind_h3 IN (0, 1)),   -- 出发前 3 小时
        birth_date  TEXT,                                                     -- 0.8.9：人生日历·出生日期（自日历模块迁来）
        expect_years INTEGER,                                                 -- 0.8.9：人生日历·预期寿命（年）
        updated_at  INTEGER,
        UNIQUE(user_id)                                                       -- ⭐ 一人一行（upsert 的落点）
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射；本模块是全新的，没有改过名。
   *
   * 说明：留空是**契约的一部分，不是漏写** —— 空对象表示「本模块没有改名迁移」。
   *
   * @type {Object}
   */
  aliases: {
    // ⭐ 0.8.13：四张表随模块并版改名成 `time_trip*`（只改名字、不搬数据）。
    trips: 'time_trips',
    trip_tickets: 'time_trip_tickets',
    trip_points: 'time_trip_points',
    trip_prefs: 'time_trip_prefs',
  },

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：四张都是新表，老库上根本没有它们，**不需要重建**；`createAll()` 会用
   *      `CREATE TABLE IF NOT EXISTS` 把它们建出来（⛔ 不升 `SCHEMA_VERSION`）。
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
   * 功能：老库缺的列（幂等补列）。
   *
   * 说明：⭐ **四张表本身不用在这里建**（`CREATE TABLE IF NOT EXISTS` 一步到位；往这里写它们的
   *      列反而会在「表还没建」时执行 `ALTER TABLE` 报错 —— 照 `modules/calendar/schema.js` 的同一条说明）。
   *      这里补的是**给已存在的 `time_trips` 表新加的四列**（0.8.6 开发期后加的字段，
   *      装过开发包的机器上 `time_trips` 早就存在 ⇒ 上面的 DDL 对它**一个字都不管用**）。
   *      ⇒ 本模块还要补的另一列（`users.hide_trip`）**在 core 的 `schema/core.js` 里**（铁律 11：
   *      只动自己模块 —— 但 `users` 是 core 的表，那是本期明确列出的共用登记点）。
   *
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    // ⭐⭐ 0.8.6：行程补四个字段 —— 交通工具 / 起点 / 终点 / 起始时刻。
    //    ⚠️⭐ 这四列**只有这一条路径对老库生效**：漏了 = 老库上那四列永远不存在，而且**不报错**
    //    （表现是「填了交通工具，刷新一下就没了」，`schema.test.js` 的逐列对齐又整表豁免了 `time_trips`）。
    //    ⚠️ 一律**可空、无 DEFAULT、无 CHECK**：老库 `ALTER TABLE ADD COLUMN` 带 CHECK 不可靠，
    //    而且将来给「交通工具」加一项（比如自驾）就要改 DDL。⇒ 值域只由接口层一处校验（见 routes.js）。
    ['time_trips', 'vehicle', 'TEXT'],
    ['time_trips', 'from_place', 'TEXT'],
    ['time_trips', 'to_place', 'TEXT'],
    ['time_trips', 'start_time', 'TEXT'],
    // ⭐⭐ 0.8.13：行程补 `end_time`（结束时刻）——
    //    首页「日程表」要按 `start_time` ~ `end_time` 画那一段的**长度**，所以它与 `start_time` 是一对。
    //    ⚠️⭐ 与上面四列同一条：**只有这一条路径对老库生效**（`CREATE TABLE IF NOT EXISTS` 永远补不上后加的列）
    //    ⇒ 漏了 = 老库上这一列永远不存在，而**不报错**（表现是「填了结束时刻，刷新一下就没了」）。
    //    ⚠️ 同样**可空、无 DEFAULT、无 CHECK**（`ALTER TABLE ADD COLUMN` 带 CHECK 不可靠）。
    ['time_trips', 'end_time', 'TEXT'],
    // ⭐⭐ 0.8.9：「人生日历」从日历模块**整体搬进行程** ——
    //    它的两项设置（出生日期 / 预期寿命）从此住 `time_trip_prefs`，与提醒开关同一行（一人一行）。
    //    ⚠️⭐ 与 `calendar_prefs` 那两列（0.7.8 加的）**同名同型**，迁移时逐字对拷；
    //    `time_trip_prefs` 自 0.8.6 起就已存在于真机上 ⇒ `CREATE TABLE IF NOT EXISTS`
    //    **永远补不上后加的列**，**必须**登记这两行，否则「新装能存、升级上来的静默存不进去」
    //    而且**不报错**（症状是「填了生日，刷新一下就没了」）。
    //    ⚠️ 两列都**可空、无默认值、无 CHECK**：`ALTER TABLE ADD COLUMN` 永远成功、一行数据不动；
    //    值域只由接口层一处校验（`routes.js` 的 `checkTripLife`）。
    ['time_trip_prefs', 'birth_date', 'TEXT'],
    ['time_trip_prefs', 'expect_years', 'INTEGER'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**四张表全部刻意留空**。
   *
   * 说明：⚠️ 空数组不是漏写，是**安全属性**：四张表的变化都走**专用原语**
   *      （插入用通用 `_insert`、改行程 / 票走整行写回、开关走 `upsertTripPrefs`）。
   *      放开通用更新后，`time_trip_points.at` / `lat` / `lng` 这三列 —— 也就是「这条记录本身」——
   *      就能被任意 PUT 改掉，而那正是「轨迹是不是真的」的依据。
   *      ⇒ `ttt/test/schema.test.js` 的 `SKIP_TABLES` 里四张表都要整表豁免「逐列对齐」。
   *
   * @type {Object}
   */
  allowedCols: {
    time_trips: [],
    time_trip_tickets: [],
    time_trip_points: [],
    time_trip_prefs: [],
  },

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：四张都是「这个人自己的东西」（行程 / 车票 / 轨迹 / 开关），没有第二方 ⇒
   *      标准的「账号一走、数据全走」。⚠️ 与任务板 / 日历同一口径：
   *      **管理员也看不到成员的行程与车票**。
   *
   * @type {Array.<string>}
   */
  userScoped: ['time_trips', 'time_trip_tickets', 'time_trip_points', 'time_trip_prefs'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`；本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句。
   *
   * 说明（逐条的理由，别当成凑数）——
   *      · `idx_trip_tickets_user_depart`：提醒扫「即将出发的票」与列表排序都靠它
   *        （`WHERE user_id=? AND depart_at BETWEEN ? AND ?`）。
   *      · `idx_trip_points_user_trip`：取一条轨迹的点按 `at` 升序 —— `time_trip_points` 是本项目
   *        **第一张可能上万行的用户表**（一段两小时的车程 ≈ 数百到数千点），这条索引是必须的。
   *      · `idx_trips_user_start`：行程列表按开始日排。
   *      ⚠️ `time_trip_prefs` 不建索引：它靠 `UNIQUE(user_id)` 自带的那一个，一人一行。
   *
   * @type {Array.<string>}
   */
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_trips_user_start ON time_trips(user_id, start_date)',
    'CREATE INDEX IF NOT EXISTS idx_trip_tickets_user_depart ON time_trip_tickets(user_id, depart_at)',
    'CREATE INDEX IF NOT EXISTS idx_trip_points_user_trip ON time_trip_points(user_id, trip_id, at)',
  ],
};
