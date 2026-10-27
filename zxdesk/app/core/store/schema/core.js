'use strict';
/**
 * core/store/schema/core.js —— **核心模块**：账号与全局设置。
 *
 * 功能：声明核心模块的两张表 —— `users`（账号：口令散列 / 管理员标志 / 会话世代 / 登录时间 /
 *      个人偏好 `hide_timetable` / `hide_bookmarks` / `hide_hardware` / `hide_ai`）与 `settings`（全局设置的 key-value），并给出它们的建表 DDL、重建顺序、归一化规则、
 *      补列清单与 `_update()` 列白名单等模块契约字段。
 *
 * 它不属于任何业务模块，却是所有模块的前置：任务与课表的数据都挂在 `users` 上。
 * 因此 `users` 必须**最先重建**（外键要求父表先存在）。
 *
 * ⚠️ 模块契约（四个文件都必须满足，见 index.js 的说明，由 `assertModules` 在加载时自检）：
 *   tables / aliases / columnAliases / rebuildOrder / normalize / ensureColumns / allowedCols /
 *   userScoped / legacyIndexes / indexes
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.1
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */

/** ⭐ 模块自述：加一个功能模块 = 新增这样一个文件 + 在 index.js 的 MODULES 里加一行 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'core',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '账号与全局设置',

  /**
   * 功能：本模块的表名 → DDL 生成器映射，供 index.js 的 `createAll()` 一次建出全部表。
   *
   * 说明：⭐ `users.password_hash` 是 `NOT NULL` 且**刻意不给 DEFAULT** —— 单用户时代的老库靠
   *      `_ensureColumn` 补出这一列、老行上是 NULL，于是造出「账号在、是管理员、却任何密码都登不进去」
   *      （连续把部署者挡在门外三次）；而给了默认值，「忘了传口令」就会从报错变成**静默写入一个空口令**
   *      （只是从 NULL 换成 ''），同样回到那条老路上。完整经过写在下面 DDL 的注释里。
   *
   * @type {Object}
   */
  tables: {
    /**
     * 功能：生成 `users` 表的建表语句 —— 账号行的唯一出处（口令散列 / 管理员标志 / 会话世代 / 登录时间）。
     *
     * 说明：⚠️ `password_hash` 为什么 `NOT NULL`、为什么没有 DEFAULT，见上面 `tables` 字段的说明
     *      与语句内注释（SQL 注释保留原样，是这段事故记录的一手出处）。
     *
     * @param {string} n - 表名（重建时是临时名，如 `users__v5`）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    users: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        display_name TEXT,
        -- ⚠️ NOT NULL 是**事故换来的**：单用户时代的老库用 _ensureColumn 补出这一列，
        --    老行上的值是 NULL，于是造出「账号在、是管理员、显示名是管理员、却任何密码都登不进去」
        --    （verifyPassword(任何口令, NULL) 恒为 false，而登录接口只回「用户名或密码不正确」，
 -- 与「口令打错」完全无法区分）—— 连续挡在门外三次。
        --    空串与 NULL 对本应用语义相同（hashUsable 对两者都为假），但**不能有两个「没有密码」的写法**。
        --    ⚠️ 刻意**不给 DEFAULT**：给了默认值，「忘了传口令」就从报错变成静默写入一个空口令，
        --       又回到「账号在、却谁都登不进去」那条老路上（只是从 NULL 换成了 ''）。
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
        session_epoch INTEGER NOT NULL DEFAULT 0,
        -- 个人偏好：不显示课表（0.2.1）。⭐ 放在 users 上而不是 settings 里，理由有两条：
        --   ① settings 是**全局**键值表，而这个偏好是**每个账号各关各的**（不是所有人都上学）；
        --   ② 放在 users 上，删账号时偏好随行一起消失；塞进 settings（例如键名 hide_tt:用户id）
        --      会在删账号后留下孤儿键 —— 那正是「删账号不能残留数据」要防的东西。
        --   带 DEFAULT 0，所以老库靠 ensureColumns 补列、重建搬数据时都自动取到「不关闭」。
        hide_timetable INTEGER NOT NULL DEFAULT 0 CHECK (hide_timetable IN (0, 1)),
        -- 个人偏好：不显示网址收藏夹（0.3.0）。与上面 hide_timetable **同一条规矩、同一个理由**
        --   （见 docs/公共/架构文档/13-决策记录.md 决策 50）：每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 刻意**一列一个偏好**，不做通用的「偏好键值表」：通用表要么塞 JSON、要么塞全局 settings
        --   （孤儿键问题），读出侧还要多一次解析与一次「键不存在」兜底 —— 两个偏好还不值得换那套复杂度。
        hide_bookmarks INTEGER NOT NULL DEFAULT 0 CHECK (hide_bookmarks IN (0, 1)),
        -- 个人偏好：不显示「NAS硬件管理」（0.3.1）。⭐ 与上面两项**同一条规矩、同一个理由**
        --   （决策 50）：每账号各关各的、删账号随行消失、加列不动结构版本号。
 -- ⚠️ 原话就是「也要像课表一样可以在设置中关闭这个功能」——
        --   所以它是**第三个实例**，不是新决策；三个偏好**各改各的列**，关一个不许连累另一个。
        hide_hardware INTEGER NOT NULL DEFAULT 0 CHECK (hide_hardware IN (0, 1)),
        -- ⚠️⭐ 上面那一列自 0.8.10 起**语义退役**（方案 30）：模块 hardware 改名 digital
        --   （界面叫「数码管理」），开关列换成下面这一列。**老列保留**（照 hide_calendar 的先例）——
        --   删列要碰用户数据，留着完全无害；它也仍会在 sanitizeUser() 里原样透出。
        --   个人偏好：不显示「数码管理」（0.8.10）。⭐ 与上面几项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 关掉的是**入口**：hardware_items 一条不动，重新打开立刻回来。
        hide_digital INTEGER NOT NULL DEFAULT 0 CHECK (hide_digital IN (0, 1)),
        -- 个人偏好：不显示「密码库」（0.3.2）。⭐ 与上面三项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
 -- ⚠️ 原话就是「也要像课表一样可以在设置中关闭这个功能」——
        --   所以它是**第四个实例**，不是新决策；四个偏好**各改各的列**，关一个不许连累另一个。
        --   ⚠️ 关掉的是**入口**：vault_meta / vault_items 一条不动，重新打开立刻回来。
        hide_vault INTEGER NOT NULL DEFAULT 0 CHECK (hide_vault IN (0, 1)),
        -- 个人偏好：不显示「团队协作」（0.3.5）。⭐ 与上面四项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
 -- ⚠️ 原话就是「也要像课表一样可以在设置中关闭这个功能」——
        --   所以它是**第五个实例**，不是新决策；五个偏好**各改各的列**，关一个不许连累另一个。
        --   ⚠️ 关掉的是**入口**：好友关系、会话与消息一条不动，重新打开立刻回来 ——
        --   这一点对团队协作尤其要紧（对面的人并不知道你关掉了这个功能，消息照样收得到、
        --   照样存在你的 NAS 上，只是界面上暂时不显示入口）。
        hide_teamwork INTEGER NOT NULL DEFAULT 0 CHECK (hide_teamwork IN (0, 1)),
        -- 个人偏好：不显示「AI 辅助任务」（0.6.0）。⭐ 与上面五项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 它是第六个实例，不是新决策；六个偏好**各改各的列**，关一个不许连累另一个。
        --   ⚠️ 对本模块还有一层含义（方案 11 §八）：AI 是项目第一个**出网**功能，
        --   模块清单里的 defaultEnabled: false（新账号默认关）+ 这里的 DEFAULT 0（老库补列默认显示入口）
        --   合起来才是「开 AI 必须是用户亲手做的选择」—— 两处默认值各有各的职责，别混为一谈。
        hide_ai INTEGER NOT NULL DEFAULT 0 CHECK (hide_ai IN (0, 1)),
        -- 个人偏好：不显示「灵感库」（0.7.1）。⭐ 与上面几项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 关掉的是**入口**：idea_items 一行不动，重新打开立刻回来。
        hide_idea INTEGER NOT NULL DEFAULT 0 CHECK (hide_idea IN (0, 1)),
        -- 个人偏好：不显示「番茄钟」（0.7.5）。⭐ 与上面几项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 关掉的是**入口**：time_pomodoro_sessions 一行不动，重新打开立刻回来
        --   （正在计时的那个番茄也不会因为关掉入口就消失，只是暂时看不见它）。
        --   ⚠️ 别把它与番茄钟**自己的时长偏好**混起来：那四个时长（专注/短休/长休/轮次）
        --   住模块自己的表 time_pomodoro_prefs（方案 17 §三 决策 8，铁律 11 只动自己模块）——
        --   这一列只承担「要不要在界面上看见它」这一件事。
        hide_pomodoro INTEGER NOT NULL DEFAULT 0 CHECK (hide_pomodoro IN (0, 1)),
        -- 个人偏好：不显示「日历」（0.7.5）。⭐ 与上面几项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 关掉的是**入口**：calendar_events 一行不动，重新打开立刻回来。
        --   ⚠️ 别把它与日历**自己的图层开关**混起来：那三个开关（课表 / 任务 / 假期）
        --   住模块自己的表 calendar_prefs（方案 18 §三 决策 2，铁律 11 只动自己模块）——
        --   这一列只承担「要不要在界面上看见日历」这一件事。
        hide_calendar INTEGER NOT NULL DEFAULT 0 CHECK (hide_calendar IN (0, 1)),
        -- 个人偏好：不显示「记账」（0.8.0，方案 20）。⭐ 与上面几项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 它是第十个实例，不是新决策；十个偏好**各改各的列**，关一个不许连累另一个。
        --   ⚠️ 关掉的是**入口**：ledger_accounts / ledger_snapshots 一行不动，重新打开立刻回来。
        --   ⚠️ 别把它与记账**自己的东西**混起来：账户与净值历史住模块自己的两张表
        --   （方案 20 §4.1，铁律 11 只动自己模块）—— 这一列只承担「要不要在界面上看见它」这一件事。
        hide_ledger INTEGER NOT NULL DEFAULT 0 CHECK (hide_ledger IN (0, 1)),
        -- 个人偏好：不显示「行程」（0.8.6，方案 25）。⭐ 与上面几项**同一条规矩、同一个理由**（决策 50）：
        --   每账号各关各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 它是第十一个实例，不是新决策；十一个偏好**各改各的列**，关一个不许连累另一个。
        --   ⚠️ 关掉的是**入口**：time_trips / time_trip_tickets / time_trip_points 一行不动，重新打开立刻回来。
        --   ⚠️⭐ 别把它与行程**自己的三档提醒开关**混起来：那三个开关（出发前 3 天 / 1 天 / 3 小时）
        --   住模块自己的表 time_trip_prefs（方案 25 §三 决策 12，铁律 11 只动自己模块）——
        --   这一列只承担「要不要在界面上看见它」这一件事。
        hide_trip INTEGER NOT NULL DEFAULT 0 CHECK (hide_trip IN (0, 1)),
 -- 个人偏好：**记账里记完就把金额糊成圆点**（0.8.21，「隐藏要具有记忆功能：
        --   也就是我隐藏了，下次进入还是隐藏状态。并且手机端和电脑端同步」）。
        --   ⭐ 它是**第十二个实例**，不是新决策（决策 50 同一条规矩）：每账号各记各的、删账号随行消失、
        --   加列不动结构版本号；**各改各的列**，它不许连累上面那十一个「关掉某个功能」的开关。
        --   ⚠️⭐ 它**不是「关掉某个功能」**（与上面那些不同）：这一列说的是记账里那颗眼睛的**初值** ——
        --   1 = 进记账就把金额糊成圆点，用户当场仍可点眼睛看回来（那是内存态，不落库）。
 -- ⚠️ 为什么必须落库而不是 localStorage：要求是「手机端和电脑端同步」——
        --   localStorage 只活在这一台设备的一个浏览器里，换端 / 换浏览器就丢了。
        --   ⚠️ 它默认 0（不隐藏）：老库靠 ensureColumns 补列、重建搬数据时都自动取到「不隐藏」。
        hide_ledger_amount INTEGER NOT NULL DEFAULT 0 CHECK (hide_ledger_amount IN (0, 1)),
 -- ⭐ 0.8.5 导航排序（「电脑端可以拖动排序 / 手机端在更多中设置首页导航栏
        --   显示的东西和排序」）。⭐ 与上面那十个 hide_* **同为「每账号各管各的界面偏好」**
        --   （决策 50 同一条规矩）：每账号各排各的、删账号随行消失、加列不动结构版本号。
        --   ⚠️ 它**不是**布尔开关，所以单开列而不是复用 hide_* 那种 INTEGER：
        --     · nav_order —— **电脑端侧栏**里模块入口的先后（逗号分隔的模块名，如 teamwork,timetable）；
        --     · nav_tabs  —— **手机端底部标签栏**放哪几个模块（逗号分隔、最多两个，顺序即标签顺序）。
        --   ⚠️⭐ 两列的「没设过」与「设成空」**必须能区分**，所以**给 NULL 不给 DEFAULT**：
        --     · NULL = 这个账号从来没排过 ⇒ 前端按清单的 order 走默认顺序（老库升级上来就是它）；
        --     · ''（空串）= 用户**明确地**把手机端底栏的模块位全清空了 ⇒ 前端不许再回落默认值，
        --       否则「我明明清空了，下次打开又冒出对话和课表」——那种「点了不管用」最难查。
        --   ⚠️ 存的是模块名（= app/modules/ 下的目录名），**不是下标**：删掉一个模块目录之后，
        --     存下标会让用户排在它后面的所有入口集体前移一位；存名字最坏只是「那个名字被忽略」。
        nav_order TEXT,
        nav_tabs TEXT,
        -- 密码库**自动锁定分钟数**（0.3.2）：每个人对「多久自动锁」的容忍度不一样，
        --   所以它跟显示开关一样存在 users 行上（**不是**全局 settings，理由见 hide_timetable 那一段）。
        --   ⚠️ 带 NOT NULL DEFAULT 10：老库靠 ensureColumns 补列时拿到的就是默认的 10 分钟 ——
        --   若允许 NULL，读侧兜底一旦写漏就会变成「永不自动锁定」，那是一个安全特性的静默失效。
        vault_lock_minutes INTEGER NOT NULL DEFAULT 10,
        last_login_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );`,
    /**
     * 功能：生成 `settings` 表的建表语句 —— 全局设置的 key-value 存储（两列，无额外约束）。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    settings: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        key TEXT PRIMARY KEY,
        value TEXT
      );`,
  },

  /**
   * 功能：旧表名 → 现表名的映射，供迁移在**建表之前**改名，避免老数据永远搬不过来。
   *
   * 说明：⚠️ 本模块没有改过名 —— 留空是**契约的一部分，不是漏写**：空对象表示「本模块没有改名迁移」，
   *      与「字段缺失」是两回事，后者会被 `assertModules` 当场判为契约不合格。
   *
   * @type {Object}
   */
  aliases: {},

  /**
   * 功能：旧列名 → 现列名的映射（⭐ 0.8.12 新造的「列改名」一档），供迁移在**补列之前**改名。
   *
   * 说明：⭐ `ALTER TABLE … RENAME COLUMN` 与表改名**同性质** —— 只改 `sqlite_master` 里的名字，
   *      **不动任何一行用户数据**。⚠️⭐ 它**必须**排在 `ensureColumns` 之前：反过来的话，
   *      补列会先按新 DDL 把 `hide_teamwork` 补出来（默认 0 = 显示），旧列还在 ⇒ 新列撞名，
   *      而撞名的表现是「开关全被重置成『显示』」且**不报错**（`_applyColumnAliases` 的说明）。
   *
   *      本行是 1a 那一批（`chat` → `teamwork`）留下的：`users.hide_teamwork` 是从
   *      `users.hide_chat` **原地改名**来的（的「路 3」）——
   *      不新增退役列、数据原地保留，代价是得新造这一档机制。
   *
   * @type {Array.<Array.<string>>}
   */
  columnAliases: [['users', 'hide_chat', 'hide_teamwork']],

  /**
   * 功能：需要「重建」（DROP + 搬数据 + RENAME）的表，**父表在前**。
   *
   * 说明：`settings` 只有两列、无任何约束变化，不必重建。
   *
   * @type {Array.<string>}
   */
  rebuildOrder: ['users'],

  /**
   * 功能：重建搬数据时，对「NULL 与默认值语义完全相同」的列做归一化（并记进启动日志）。
   * @type {Object}
   */
  normalize: {
    users: { password_hash: "''", is_admin: '0', session_epoch: '0' },
  },

  /**
   * 功能：老库缺的列（幂等补列），格式 `[表名, 列名, 类型]`。
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [
    ['users', 'password_hash', 'TEXT'],
    ['users', 'is_admin', 'INTEGER DEFAULT 0'],
    ['users', 'session_epoch', 'INTEGER DEFAULT 0'],
    ['users', 'hide_timetable', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'hide_bookmarks', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'hide_hardware', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.8.10：数码管理的开关列（模块 hardware 改名 digital 之后换的那一列）。
    //    ⚠️ 老库上**唯一生效的路径**就是这一行 —— DDL 里的新列对已存在的 users 表一个字节都不动。
    ['users', 'hide_digital', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'hide_vault', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'hide_teamwork', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'hide_ai', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.7.1 灵感库（可关模块的第七个实例）：⚠️ 这一行**必须有** ——
    //    真机上装过 0.6.x 的库里 `users` 早就存在，`CREATE TABLE IF NOT EXISTS` 永远补不上这一列
    //    （同类事故：0.7.1 的 `teamwork_reminder_prefs.builtin_name` 只写进建表语句、漏登记，
    //    结果「七个设置项里只有称呼存不进去」，见 11-踩坑与说明.md）。
    ['users', 'hide_idea', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.7.5 番茄钟（可关模块的第八个实例）：⚠️ 与上面那条**同一条理由** ——
    //    真机上装过 ≤0.7.2 的库里 `users` 早就存在，`CREATE TABLE IF NOT EXISTS` 永远补不上这一列
    //    （同类事故：0.7.1 的 `teamwork_reminder_prefs.builtin_name` 只写进建表语句、漏登记，
    //    结果「七个设置项里只有称呼存不进去」，见 11-踩坑与说明.md）。
    //    「拿不准就登记」：幂等补列零成本，漏了就是「真机上开关怎么点都不生效」。
    ['users', 'hide_pomodoro', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.7.5 日历（可关模块的第九个实例）：⚠️ 与上面那条**同一条理由** ——
    //    真机上装过 ≤0.7.4 的库里 `users` 早就存在，`CREATE TABLE IF NOT EXISTS` 永远补不上这一列
    //    （同类事故：0.7.1 的 `teamwork_reminder_prefs.builtin_name` 只写进建表语句、漏登记，
    //    结果「七个设置项里只有称呼存不进去」，见 11-踩坑与说明.md）。
    //    「拿不准就登记」：幂等补列零成本，漏了就是「真机上开关怎么点都不生效」。
    ['users', 'hide_calendar', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.8.0 记账（可关模块的第十个实例）：⚠️ 与上面那条**同一条理由** ——
    //    真机上装过 ≤0.7.9 的库里 `users` 早就存在，`CREATE TABLE IF NOT EXISTS` 永远补不上这一列
    //    （同类事故：0.7.1 的 `teamwork_reminder_prefs.builtin_name` 只写进建表语句、漏登记，
    //    结果「七个设置项里只有称呼存不进去」，见 11-踩坑与说明.md）。
    //    「拿不准就登记」：幂等补列零成本，漏了就是「真机上开关怎么点都不生效」。
    ['users', 'hide_ledger', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.8.6 行程（可关模块的第十一个实例）：⚠️ 与上面那条**同一条理由** ——
    //    真机上装过 ≤0.8.5 的库里 `users` 早就存在，`CREATE TABLE IF NOT EXISTS` 永远补不上这一列
    //    （同类事故：0.7.1 的 `teamwork_reminder_prefs.builtin_name` 只写进建表语句、漏登记，
    //    结果「七个设置项里只有称呼存不进去」，见 11-踩坑与说明.md）。
    //    「拿不准就登记」：幂等补列零成本，漏了就是「真机上开关怎么点都不生效」。
    ['users', 'hide_trip', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.8.21 记账的眼睛初值（「隐藏要具有记忆功能…并且手机端和电脑端同步」）：
    //    ⚠️ 与上面那条**同一条理由** —— 真机上装过 ≤0.8.20 的库里 `users` 早就存在，
    //    `CREATE TABLE IF NOT EXISTS` 永远补不上这一列（同类事故见 11-踩坑与说明.md）。
    //    「拿不准就登记」：幂等补列零成本，漏了就是「真机上眼睛怎么点都记不住」。
    ['users', 'hide_ledger_amount', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 0.8.5 导航排序（`nav_order` / `nav_tabs` 两列，语义见建表语句里那一段）：
    //    ⚠️ 与上面几条**同一条理由** —— 真机上装过 ≤0.8.4 的库里 `users` 早就存在，
    //    `CREATE TABLE IF NOT EXISTS` 永远补不上这两列
    //    （同类事故：0.7.1 的 `teamwork_reminder_prefs.builtin_name` 只写进建表语句、漏登记，
    //    结果「七个设置项里只有称呼存不进去」，见 11-踩坑与说明.md）。
    //    「拿不准就登记」：幂等补列零成本，漏了就是「真机上拖完顺序、刷新又回去了」。
    //    ⚠️ 刻意**不给 DEFAULT**：补出来的老行是 NULL = 「没排过」⇒ 前端走清单默认顺序
    //    ——这与 `hide_*` 那几条「补列默认 0 = 显示入口」是同一个思路，只是这里默认值的载体是 NULL。
    ['users', 'nav_order', 'TEXT'],
    ['users', 'nav_tabs', 'TEXT'],
    ['users', 'vault_lock_minutes', 'INTEGER NOT NULL DEFAULT 10'],
    ['users', 'last_login_at', 'TEXT'],
    ['users', 'updated_at', 'TEXT'],
  ],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**故意留空**。
   *
   * 说明：⚠️ `users` / `settings` 从不走通用 `_update()` ——
   *      账号有专用方法（`setPassword` 要递增 `session_epoch` 踢会话、`setPasswordHash` 不能踢、
   *      `setAdminFlag` 只改权限、`touchLastLogin` 只写时间），设置是整体 key-value。
   *      把这些列交给通用 `_update()` 等于绕过那几处语义（尤其「重置密码必须踢会话」）。
   *      留空是契约的一部分，不是漏写：**没有 case = 该表不可通用更新**，与 `default: return []` 同义。
   *
   * @type {Object}
   */
  allowedCols: {},

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的**唯一出处**。
   *
   * 说明：核心模块自己不带（账号行的归属就是它自己的 `id`）。
   *
   * @type {Array.<string>}
   */
  userScoped: [],

  /**
   * 功能：改过名的老索引名，启动时幂等 `DROP`（表被重建时本来也会跟着删，这里只是保险）。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块的索引语句；核心模块不外挂任何索引。
   *
   * 说明：⚠️ `idx_users_username` 是**唯一索引**，有独立的 try/catch 降级逻辑（见 storage.js 的 `_createIndexes`），
   *      所以不在这里声明 —— 声明了反而会绕过那层保护。
   *
   * @type {Array.<string>}
   */
  indexes: [],
};
