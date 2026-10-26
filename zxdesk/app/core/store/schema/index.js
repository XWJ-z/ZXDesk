'use strict';
/**
 * core/store/schema/index.js —— **表结构的总装配**（唯一的 schema 版本号出处）。
 *
 * 功能：把各功能模块的表结构装配成一份完整 schema，供存储层建库与迁移使用。
 *      `SCHEMA_VERSION` 是结构版本，`MODULES` 是模块清单，`assertModules()` 是加载时的契约自检；
 *      `createAll()` / `tableNames()` / `rebuildOrder()` / `normalizeOf()` / `ensureColumns()` /
 *      `allowedCols()` / `userScopedTables()` / `aliases()` / `legacyIndexes()` / `indexStatements()`
 *      则把分散在各模块里的表、列、索引与级联清单**扁平化**成 storage.js 直接可用的形态。
 *      ⭐ 0.8.1 起还多了一组**按库取子集**的口子：`dbOf()`（表 → 库，唯一出处）、`tablesByDb()`、
 *      `ledgerTables()`、`createAllIn()`、`ensureColumnsIn()`、`indexStatementsIn()`、
 *      `userScopedTablesIn()` —— 两个库各自建表 / 补列 / 建索引 / 删账号，见下方「表 → 库」一节。
 *
 * 设计目标（的方向）：**功能模块之间在存储层互不牵扯** ——
 * 加一个功能模块时，只需要
 *   ① 新建表结构声明（表 / 索引 / 迁移片段 / 级联清单一处写全）
 *   ② 建一张 `modules/<模块>/module.json`（模块身份证）
 * 不需要去翻 `storage.js`、不需要改任何别的模块的文件。
 *
 * ⭐ **0.5.0 模块化重构**：`MODULES` 不再手写，而是**扫 `app/modules/` 聚合**而来
 * （`modules/registry.js`；`core` 是地基、固定第一，其余按 `order`）。
 * 这是**渐进接管**：模块目录里还没有 `schema.js` 时，继续用旧的 `store/schema/<模块>.js`
 * ——搬走一个，就在 `LEGACY_SCHEMA` 里删掉一行。
 * ⚠️ **0.5.0（任务板搬完）之后 `LEGACY_SCHEMA` 已经空了** ——
 * 六个模块的表结构全部住在各自的 `modules/<name>/schema.js` 里，
 * 旧的 `store/schema/<模块>.js` 一个不剩。**「渐进接管」这条路径已经走完**。
 *
 * ⚠️ 但**事务、备份、账号、schema 版本号仍然是统一的**（单库、单连接、一次迁移、一次回滚）——
 *    这是刻意的：「删账号不能残留数据」这类跨模块正确性，靠的就是同一个事务，
 *    拆库或拆连接会立刻丢掉这个保证（见 AGENTS.md §六 的决策记录）。
 *
 * ⭐ **0.8.1（记账 2 期）：唯一的例外 —— 记账模块进独立库**。
 *    从此 core 会同时开**两个库**：主库 `zxdesk.db` ＋ 记账库 `zxdesk-ledger.db`
 *    （JSON 后端是两个文件 `zxdesk.json` / `zxdesk-ledger.json`）。
 *    ⚠️⭐ 「表 → 库」的映射**只住在本文件**（`dbOf()`）—— 映射来源是各模块
 *    `module.json` 的 `database` 字段（值是 `'ledger'` 就整个模块进记账库；缺省/别的值进主库）。
 *    模块只**声明**自己进哪个库，**不**负责路由；路由在 `store/` 与两个后端里。
 *    ⚠️ 上面那段「事务统一」的话**没有作废**、也**不再处处成立**：跨库的那几件事
 *    （删账号 / 整体备份 / 整体恢复 / 个人导入）已经改成**两段执行 ＋ 如实报告**，
 *    它们不再有一个事务兜底 —— 详见 `store/backend/{sqlite,json}.js` 里各自的说明。
 *
 * 模块契约（每个模块文件必须导出这些字段，⭐ **由下面的 `assertModules` 在加载时自检**）：
 *   name          string    模块名（错误信息与日志里用）
 *   label         string    中文名（日志里用）
 *   tables        {表名: (n, ine) => DDL}
 *   aliases       {旧表名: 现表名}          改名迁移用；无改名就给 {}
 *   columnAliases [[表, 旧列, 新列]]        ⭐ **可选**（0.8.12 新造）：列改名迁移用
 *   rebuildOrder  string[]  需要重建的表，**父表在前**
 *   normalize     {表: {列: SQL 默认值}}    重建搬数据时的等价归一化（NULL → 默认值）
 *   ensureColumns [[表, 列, 类型]]          老库幂等补列
 *   allowedCols   {表: string[]}            通用 `_update()` 的列白名单（0.1.3 起由模块自报）
 *   userScoped    string[]  带 user_id 的表（删账号要清空的**唯一清单**）
 *   legacyIndexes string[]  已废弃的索引名（幂等 DROP）
 *   indexes       string[]  本模块的索引语句
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.8.13
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/21-记账2期-记账.md（决策 3）
 */

const core = require('./core.js');
const { registry, schemaModules } = require('../../../modules/registry.js');

/**
 * 尚未搬进 `app/modules/` 的模块 → 它旧的表结构声明。
 * ⚠️ 用**惰性函数**而不是直接 `require`：一个模块只允许有一处声明，
 *    已经搬走的模块若还留在这里，两边会同时声明同一批表（`assertModules` 的「抢表名」检查会当场炸）。
 * ⚠️ 0.5.0（任务板搬进 `modules/tasks/`）之后**这里是空的** ——
 *    六个模块的表结构全部由各自的 `modules/<name>/schema.js` 声明。
 *    ⚠️ **空对象是契约的一部分、不是漏写**：`LEGACY_SCHEMA` 一旦再被填上一个名字，
 *    说明有个模块「搬了一半」（模块目录里已有 `schema.js`，旧文件却还在）——
 *    那种状态会在 `assertModules()` 的抢表名检查里当场抛。
 * @type {Object.<string, Function>}
 */
const LEGACY_SCHEMA = {};

/**
 * ⚠️ 顺序有意义：**`core` 必须第一**（`modules/registry.js` 的 `schemaModules()` 保证）。
 *    `users` 是任务与课表的父表，重建（DROP + RENAME）时父表必须先存在。
 * ⚠️ 其余模块的顺序由各自 `module.json` 的 `order` 决定（tasks 10 → timetable 20 → bookmarks 30
 *    → hardware 40 → vault 50 → teamwork 60，与改造前逐字一致）：它们之间没有表名或外键交集
 *    （收藏夹的两个外键都指向它自己的表；硬件台账、密码库与对话的表压根没有跨模块外键），
 *    顺序上只需保证「不抢表名」。
 *    ⚠️ `teamwork` 是**跨账号**数据（判权靠 `teamwork_members` 而不是 `user_id`），但「删账号要清空哪些表」
 *    仍按 `user_id` 列工作，所以它照样是一个普通的 schema 模块
 *    （0.5.0起它的四张表归 `modules/teamwork/schema.js` 声明）。
 */
const MODULES = schemaModules(registry, core, (name) => {
  const legacy = LEGACY_SCHEMA[name];
  if (!legacy) {
    throw new Error(
      `[schema] 模块「${name}」既没有 modules/${name}/schema.js，也不在 LEGACY_SCHEMA 里 —— ` +
        '搬迁时两边必须正好有一份声明（多一份会抢表名，少一份会丢表）。',
    );
  }
  return legacy();
});

/**
 * 功能：模块契约的字段与类型清单 —— `[字段名, 期望类型]` 两元组数组，由 `assertModules` 逐条核对。
 * @type {Array.<Array.<string>>}
 */
const CONTRACT = [
  ['name', 'string'],
  ['label', 'string'],
  ['tables', 'object'],
  ['aliases', 'object'],
  ['rebuildOrder', 'array'],
  ['normalize', 'object'],
  ['ensureColumns', 'array'],
  ['allowedCols', 'object'],
  ['userScoped', 'array'],
  ['legacyIndexes', 'array'],
  ['indexes', 'array'],
];

/**
 * 功能：判断一个契约字段的值是否属于期望类型。
 *
 * 说明：array 与 object 必须分开判 —— `typeof [] === 'object'`，只比 `typeof` 会把数组当对象放过。
 *
 * @param {*} value - 模块上该字段的实际值
 * @param {string} want - 期望类型，取 `'array'` / `'object'` / 其余 `typeof` 结果
 * @returns {boolean} 类型相符为 true
 */
function typeOk(value, want) {
  if (want === 'array') return Array.isArray(value);
  if (want === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === want;
}

/**
 * 功能：按 `CONTRACT` 逐字段核对每个 schema 模块，并检查有没有两个模块抢同一张表名；不合格立即抛错。
 *
 * 说明：⭐ 模块契约的**运行时自检**（0.1.3 起）——契约此前只写在注释里，靠 `ttt/test/schema.test.js`
 *      在跑测试时兜底，而「忘了声明 `userScoped`」这类漏字段的危害是**数据残留**（删了账号，
 *      课表还躺在库里），等到跑测试才发现已经太晚；更糟的是新模块**只有测试环境**才会被验到，
 *      真机上不跑测试。这里在模块加载时（= `storage.js` 被 require 时 = 每次启动）先自查一遍。
 *      成本：几十次 `typeof`/`Array.isArray`，与建库相比可以忽略。
 *      ⚠️ 只查「机器能查的」：字段在不在、类型对不对、表名是不是本模块声明过的、有没有两个模块抢同一张表。
 *      「这份 DDL 写得对不对」「这张带 user_id 的表有没有登记进 userScoped」仍然只能靠测试与人工 ——
 *      后者由 `ttt/test/schema.test.js` 的结构断言钉住。
 *
 * @param {Array.<Object>} [modules] - 待自检的模块数组；省略时用内置的 `MODULES`
 * @returns {boolean} 全部合格返回 true
 * @throws {Error} 某模块字段缺失/类型不符/表名对不上，或两个模块抢同一张表时抛出
 */
function assertModules(modules) {
  const list = modules || MODULES;
  if (!Array.isArray(list) || list.length === 0) throw new Error('[schema] MODULES 必须是非空数组');

  const ownerOf = new Map(); // 表名 → 模块名（查跨模块撞名）
  const bad = [];

  for (const m of list) {
    const who = m && typeof m.name === 'string' && m.name ? `schema 模块「${m.name}」` : 'schema 模块（name 缺失）';

    let fieldsOk = true;
    for (const [field, want] of CONTRACT) {
      if (!typeOk(m && m[field], want)) {
        bad.push(`${who} 的 ${field} 必须是 ${want}`);
        fieldsOk = false;
      }
    }
    if (!fieldsOk) continue; // 字段本身都不全，后面的表名检查没有意义

    const tables = Object.keys(m.tables);
    for (const t of tables) {
      if (typeof m.tables[t] !== 'function') bad.push(`${who} 的表 ${t} 必须是 (n, ine) => DDL 函数`);
      const prev = ownerOf.get(t);
      if (prev) bad.push(`表 ${t} 被两个模块同时声明：「${prev}」与「${m.name}」（模块之间抢表名 = 迁移灾难）`);
      ownerOf.set(t, m.name);
    }
    const known = (t) => tables.includes(t);
    const check = (t, what) => {
      if (!known(t)) bad.push(`${who} 的 ${what} 指向了本模块没声明的表「${t}」（多半是拼错表名）`);
    };

    m.rebuildOrder.forEach((t) => check(t, 'rebuildOrder'));
    m.userScoped.forEach((t) => check(t, 'userScoped'));
    Object.keys(m.allowedCols).forEach((t) => check(t, 'allowedCols'));
    Object.keys(m.normalize).forEach((t) => check(t, 'normalize'));
    Object.entries(m.aliases).forEach(([, next]) => check(next, 'aliases 的目标表'));
    m.ensureColumns.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 3) {
        bad.push(`${who} 的 ensureColumns 每一项都必须是 [表名, 列名, 类型] 三元组`);
        return;
      }
      check(entry[0], 'ensureColumns');
    });
    // ⭐ 0.8.12：`columnAliases` 是**可选**字段（只有真改过列名的模块才声明）——
    //    刻意不放进上面的 CONTRACT：它一旦必填，全仓十几个模块都得凭空多一行空数组，
    //    而那与「契约字段必须显式」的初衷相反（空数组在这里不等于「我没想清楚」，只等于「我没改过列名」）。
    if (m.columnAliases !== undefined) {
      if (!Array.isArray(m.columnAliases)) bad.push(`${who} 的 columnAliases 必须是数组`);
      else
        m.columnAliases.forEach((entry) => {
          if (!Array.isArray(entry) || entry.length < 3) {
            bad.push(`${who} 的 columnAliases 每一项都必须是 [表名, 旧列名, 新列名] 三元组`);
            return;
          }
          check(entry[0], 'columnAliases');
        });
    }
  }

  if (bad.length) {
    throw new Error(`[schema] 模块契约自检失败（共 ${bad.length} 处）：\n  - ${bad.join('\n  - ')}`);
  }
  return true;
}

// ⭐ 加载即自检：`storage.js` require 本文件时就会跑一遍，字段不全当场炸掉，而不是等测试或用到才发现
assertModules(MODULES);

// ============================================================================
// ⭐ 0.8.1：「表 → 库」的映射（**全仓唯一出处**）
// ============================================================================

/** 主库（`zxdesk.db` / `zxdesk.json`）：除记账模块之外的一切 */
const MAIN_DB = 'main';

/**
 * 记账独立库（`zxdesk-ledger.db` / `zxdesk-ledger.json`）。
 * ⚠️ 这个字符串是**契约值**：模块在 `module.json` 里写的就是它（`"database": "ledger"`），
 *    两边必须逐字一致 —— 写错了不会报错，只会「这个模块悄悄留在主库」。
 */
const LEDGER_DB = 'ledger';

/**
 * 表名 → 库名（`'main'` / `'ledger'`）。
 *
 * 说明：⭐⭐ 这是「表 → 库」的**唯一出处**。映射来源是各模块
 *      `module.json` 的 `database` 字段 —— **模块只声明「我进哪个库」，不负责路由**：
 *      路由在 `store/index.js`（门面）、两个后端原语、以及 `dbOf()` 的调用方。
 *      ⚠️ 声明进记账库的模块，它 `module.json.tables` 里**全部**表都进记账库
 *      （不按表逐个声明 —— 那样迟早出现「一半在主库一半在记账库」的静默分裂）。
 *      ⚠️ 表名不在这里 ⇒ 读成主库（失败方向安全：新表忘了登记时，它跟着主库走，
 *      而不是被塞进记账库那个「一般人不动」的文件里）。
 *
 * ⚠️ 只从 `module.json` 取（**不看 DDL**）：`assertModules()` 与
 *    `ttt/test/modules.test.js` 已经钉住「module.json.tables 与模块声明的表一一对应」，
 *    这里再解析一遍 DDL 只会多一处会漂移的副本。
 *
 * @type {Map.<string, string>}
 */
const DB_OF_TABLE = new Map();
for (const meta of registry.list) {
  const db = meta.database === LEDGER_DB ? LEDGER_DB : MAIN_DB;
  for (const t of meta.tables || []) DB_OF_TABLE.set(t, db);
}

/**
 * 功能：查一张表住在哪个库 —— **「表 → 库」映射的唯一入口**。
 *
 * 说明：⭐ 所有「这个操作该走哪个连接」的判断都必须经过它（`store._dbFor()` / `_dataFor()` /
 *      两个后端原语的表名参数 / 迁移工具的表清单）。⛔ 不许在别处再写一份「记账表有哪些」的
 *      清单：那种副本的失效方式是**静默的** —— 加了新表而副本没跟上，表现是「新表的数据
 *      写进了主库」（备份里少一份、删账号删不干净，且都不报错）。
 *
 * @param {string} table - 表名
 * @returns {string} `'main'` 或 `'ledger'`；**未登记的表回 `'main'`**（失败方向安全）
 */
function dbOf(table) {
  return DB_OF_TABLE.get(String(table)) || MAIN_DB;
}

/**
 * 功能：列出住在某个库里的全部表（顺序 = `tableNames()` 的顺序）。
 * @param {string} db - `'main'` / `'ledger'`
 * @returns {Array.<string>} 该库的表名数组；`db` 不认识时为空数组
 */
function tablesByDb(db) {
  return tableNames().filter((t) => dbOf(t) === db);
}

/**
 * 功能：记账独立库里的全部表 —— 迁移工具、记账库建表与记账库备份都认它。
 * @returns {Array.<string>} 记账库的表名数组
 */
function ledgerTables() {
  return tablesByDb(LEDGER_DB);
}

/**
 * schema 版本（写在 SQLite 的 `PRAGMA user_version` 里）。
 * 用途只有一个：**判断「这次启动会不会动结构」，从而决定迁移前要不要自动备份、要不要重建表**。
 *   v0：0.0.5~0.0.7 的老库（`user_version` 根本没写过）
 *   v3：多用户 —— users 增密码/管理员/会话世代列 + username 唯一索引 + settings 表
 *   v4：课表 —— 新增 terms / period_blocks / periods / courses / course_sessions 五张表
 *   v5：结构加固 + 课表改名
 *       · 加外键与 ON DELETE CASCADE（父子关系）
 *       · users.password_hash NOT NULL、各表 user_id NOT NULL
 *       · important/urgent、weekday、节数/课时/课间的 CHECK 取值范围
 *       · 索引体检：删掉从没被选中的区间索引、补 (user_id, sort_order)
 *       · 课表 5 张表改名加 `timetable_` 前缀（terms → timetable_terms …）
 *   v6（0.8.12）：**`chat` → `teamwork` 的改名迁移** ——
 *       · 8 张表改名 `chat_*` → `teamwork_*`（走 `aliases()` 的 `ALTER TABLE … RENAME TO`）
 *       · `users.hide_chat` 列改名 `hide_teamwork`（走 `columnAliases()` 的 `RENAME COLUMN`）
 *       ⚠️⭐ **推 v6 换来的是「迁移前自动 `VACUUM INTO` 留一份退路」**，不是「重建表」——
 *       v5 那套整库重建的守卫已经被**钉成常量 `5`**（`REBUILD_UP_TO`，见 `backend/sqlite.js`），
 *       所以 v6 只表示「改名迁移已记录」，**不会**再让所有老库重跑一遍整库重建（§4.7）。
 *
 *   v7（0.8.13）：**课表 / 番茄钟 / 行程三块并成一个模块 `time` 的改名迁移** ——
 *       · 16 张表改名（`timetable_*` → `time_timetable_*`、`pomodoro_*` → `time_pomodoro_*`、
 *         `trips`/`trip_*` → `time_trips`/`time_trip_*`），同样走 `aliases()` 的 `ALTER TABLE … RENAME TO`；
 *       · ⚠️⭐ 课表那 5 张**各写两对**别名（「0.1.1 的老名 → 新名」＋「0.1.2 的名字 → 新名」）——
 *         只写一对会让 0.1.1 的老库停在中间名上，表现是「课表全没了」（数据仍在库里）；
 *       · ⚠️ 与 v6 同一条：**推 `SCHEMA_VERSION` 不等于重跑整库重建**（`REBUILD_UP_TO` 仍是 `5`）。
 *
 * ⚠️ **0.3.0 的网址收藏夹三张表、0.3.1 的硬件台账一张表、0.3.2 的密码库两张表、0.3.5 的对话四张表
 *    刻意不升版本号**（那时结构版本还停在 v5）：
 *    它们由 `createAll()` 的 `CREATE TABLE IF NOT EXISTS` 在老库上自动补出来。升版本号
 *    只会触发一次整库重建（DROP + 搬数据 + RENAME），而收益是零 —— 与 0.2.3 加
 *    `timetable_adjustments`（现 `time_timetable_adjustments`）、给 `project_tasks` 补 `completed_at`
 *    是同一手法（见各 schema 模块的说明）。
 */
const SCHEMA_VERSION = 7;

/**
 * ⭐ **记账独立库自己的结构版本**（写在记账库连接的 `PRAGMA user_version` 里）。
 *
 * 说明：⚠️⭐ 它**必须与主库的 `SCHEMA_VERSION` 分开**：一个号表示两件事
 *      迟早出事 —— 主库现在 v5（历经过好几次整库重建的版本号），而记账库是**新库**，
 *      它从 1 开始数自己的历史。混成一个号会有两种坏结果：
 *      ① 新建的记账库被当成「落后于 v5 的老库」⇒ 触发一次毫无意义的整库重建；
 *      ② 将来记账库真需要一次结构升级时，主库会被它连累着重建。
 *      ⇒ 两个库**各自**判自己的版本、各自决定要不要动结构（见 `store/index.js` 的 `_init`）。
 * ⚠️ 记账库**刻意没有 v5 那一整套整库重建迁移**：它是全新的库，没有历史结构要补 ——
 *    它的结构维护只有三件事：建表（`createAllIn`）＋ 补列（`ensureColumnsIn`）＋ 建索引（`indexStatementsIn`），
 *    跑完就把自己的 `user_version` 写成这个数。
 * ⚠️ 加表 / 加列 / 加索引都**不升**这个号（与主库「加表不升 SCHEMA_VERSION」同一条纪律）：
 *    那三件事本来就是幂等补齐的。
 */
const LEDGER_SCHEMA_VERSION = 1;

/**
 * 功能：汇总全部模块声明的表名。
 * @returns {Array.<string>} 表名数组，顺序 = `MODULES` 顺序 × 模块内声明顺序
 */
function tableNames() {
  return MODULES.flatMap((m) => Object.keys(m.tables));
}

/**
 * 功能：把全部模块的建表语句拼成一条 SQL 并在库上执行，一次性建出所有表。
 * @param {Object} db - SQLite 数据库句柄（提供 `exec()`）
 * @returns {void}
 */
function createAll(db) {
  db.exec(MODULES.flatMap((m) => Object.entries(m.tables).map(([name, ddl]) => ddl(name, true))).join('\n'));
}

/**
 * 功能：把**某一个库**的那些建表语句拼成一条 SQL 并在该库的连接上执行。
 *
 * 说明：⭐ 两个库各自建自己的表：记账库用 `createAllIn(ledgerDb, 'ledger')`，
 *      建出来的**只有**记账那几张 —— ⛔ 不许把全部表都建进记账库：那样「表在哪个库」
 *      就有了两个答案，一旦有路径按错的答案读写，用户看到的是「数据忽然少了一半」（且不报错）。
 *      ⚠️ `createAll()`（全部表）的语义**一个字没改** —— 主库那条路照旧用它，
 *      因为 **0.8.0 的老库里记账那几张表就住在主库**、`methods/migrate.js` 要从那里把数据搬到
 *      记账库去：主库不再建那几张表就会让「老库怎么都搬不成」（表都不在，谈不上迁移）。
 *      迁移跑完之后它们在主库恒为空，属于刻意的遗留（新写入一律按 `dbOf()` 路由到记账库）。
 *      分库是**新加的这一条**，不是把老的那条改掉。
 *
 * @param {Object} db - SQLite 数据库句柄（提供 `exec()`）
 * @param {string} dbName - 库名，`'main'` / `'ledger'`
 * @returns {void}
 */
function createAllIn(db, dbName) {
  db.exec(
    MODULES.flatMap((m) =>
      Object.entries(m.tables)
        .filter(([name]) => dbOf(name) === dbName)
        .map(([name, ddl]) => ddl(name, true)),
    ).join('\n'),
  );
}

/**
 * 功能：汇总需要重建的表，按「父表在前」排列。
 *
 * 说明：顺序 = 模块顺序 × 模块内 `rebuildOrder` 顺序，重建走 DROP + RENAME，父表必须先存在。
 *
 * @returns {Array.<string>} 表名数组，父表在前
 */
function rebuildOrder() {
  return MODULES.flatMap((m) => m.rebuildOrder);
}

/**
 * 功能：取某个模块为某张表声明的归一化列（重建搬数据时把 NULL 等价写成默认值）。
 * @param {Object} module - schema 模块对象
 * @param {string} table - 表名
 * @returns {Object} `{ 列名: SQL 默认值 }`；该表没有归一化规则时返回 `{}`
 */
function normalizeOf(module, table) {
  return (module.normalize && module.normalize[table]) || {};
}

/**
 * 功能：汇总全部模块的幂等补列清单（老库升级时逐条 `ALTER TABLE ADD COLUMN`）。
 * @returns {Array.<Array.<string>>} `[[表名, 列名, 类型], …]`
 */
function ensureColumns() {
  return MODULES.flatMap((m) => m.ensureColumns);
}

/**
 * 功能：取**某一个库**的幂等补列清单 —— 只有这张表住在这个库里才该在这个库上 `ALTER TABLE`。
 *
 * 说明：⚠️ 在主库上对记账库的表补列会当场报错（表不存在）—— 而报错的后果是把
 *      `_migrateSqlite()` 判成「库打不开」，整个主库降级只读（代价远大于少一列）。
 *
 * @param {string} dbName - 库名，`'main'` / `'ledger'`
 * @returns {Array.<Array.<string>>} `[[表名, 列名, 类型], …]`
 */
function ensureColumnsIn(dbName) {
  return ensureColumns().filter(([table]) => dbOf(table) === dbName);
}

/**
 * 功能：从一条索引语句里取出它建在哪张表上（取 `ON` 后面那一段）。
 *
 * 说明：⚠️ 索引语句是**裸 SQL 字符串**（模块自己写），不像 DDL 那样带表名参数 ——
 *      所以只能从语句本身把表名抠出来。抠不出来时回 `'main'`（失败方向安全：
 *      索引只是加速手段，建在主库上顶多是记账库少一个索引，绝不会「建到错的库上毁数据」）。
 * ⚠️ 只认第一个 ` ON <表名>`：本项目的索引语句一律是
 *    `CREATE [UNIQUE] INDEX IF NOT EXISTS <索引名> ON <表名>(列…)` 这一种形状。
 *
 * @param {string} sql - 一条 `CREATE INDEX …` 语句
 * @returns {string} 该索引所属的库名
 */
function dbOfIndex(sql) {
  const m = /\bON\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(String(sql));
  return m ? dbOf(m[1]) : MAIN_DB;
}

/**
 * 功能：取**某一个库**的索引语句。
 *
 * 说明：⚠️ 逐条按语句解析表名（见 `dbOfIndex`），而不是按模块一刀切 ——
 *      函数本身对「某个模块的索引全在主库」与「全在记账库」都一样正确。
 *
 * @param {string} dbName - 库名，`'main'` / `'ledger'`
 * @returns {Array.<string>} `CREATE INDEX …` 语句数组
 */
function indexStatementsIn(dbName) {
  return indexStatements().filter((sql) => dbOfIndex(sql) === dbName);
}

/**
 * 功能：汇总「删账号要清空哪些表」—— 由各模块自报，不再手写第二份清单。
 * @returns {Array.<string>} 带 `user_id` 的表名数组
 */
function userScopedTables() {
  return MODULES.flatMap((m) => m.userScoped);
}

/**
 * 功能：取**某一个库**的「删账号要清空哪些表」。
 *
 * 说明：⭐ 删账号现在是**两段执行**（记账库先、主库后，见 `store/backend/*.js` 的 `deleteUser()`），
 *      每一段只清自己那个库里的表 —— 拿全量清单去 `DELETE` 一个不属于该库的表会当场
 *      「no such table」并把删账号**卡在中途**（那正是「账号还在、数据少了一半」的成因）。
 *      ⚠️ 两段合起来的并集必须**恰好等于** `userScopedTables()`：少了任何一张就是数据残留。
 *
 * @param {string} dbName - 库名，`'main'` / `'ledger'`
 * @returns {Array.<string>} 该库里带 `user_id` 的表名数组
 */
function userScopedTablesIn(dbName) {
  return userScopedTables().filter((t) => dbOf(t) === dbName);
}

/**
 * 功能：查某张表允许被通用 `_update()` 写入的列，**由定义这张表的模块自报**。
 *
 * 说明：⚠️ 查不到就返回 `[]` —— 与改造前 `switch` 的 `default: return []` 逐字同义：
 *      `_update` 拿到空数组时 `setKeys` 为空 → 直接 `return false` → 路由层回 404。
 *      也就是说**没登记的表改不动**，而不是「什么都能改」—— 宁可改不动，不可乱改。
 *
 * @param {string} table - 表名
 * @returns {Array.<string>} 允许写入的列名数组；未登记的表返回 `[]`
 */
function allowedCols(table) {
  for (const m of MODULES) {
    if (Object.prototype.hasOwnProperty.call(m.allowedCols, table)) return m.allowedCols[table];
  }
  return [];
}

/**
 * 功能：把所有模块的改名映射摊平成一张表，供迁移按「旧表名 → 现表名」改名。
 * @returns {Array.<Array.<string>>} `[[旧表名, 现表名], …]`
 */
function aliases() {
  return MODULES.flatMap((m) => Object.entries(m.aliases));
}

/**
 * 功能：把所有模块的**列改名**映射摊平，供迁移按「旧列名 → 新列名」改名（⭐ 0.8.12 新造的一档）。
 *
 * 说明：⭐ 它与 `aliases()`（表改名）**同性质** —— `ALTER TABLE … RENAME COLUMN` 只改
 *      `sqlite_master` 里的列名，**不动任何一行用户数据**，是本项目里最不容易出事的结构变更。
 *      ⚠️⭐ 迁移里它必须排在 `ensureColumns()` **之前**：否则补列会先按新 DDL 把新列补出来
 *      （默认 0），旧列还在 ⇒ 两边同名撞车，而撞名的表现是「设置开关全被重置」且**不报错**
 *      （详见 `backend/sqlite.js` 的 `_applyColumnAliases`）。
 *      ⚠️ 字段是**可选**的：没声明过列改名的模块回空数组（`m.columnAliases || []`）。
 *
 * @returns {Array.<Array.<string>>} `[[表名, 旧列名, 新列名], …]`
 */
function columnAliases() {
  return MODULES.flatMap((m) => m.columnAliases || []);
}

/**
 * 功能：汇总各模块已废弃的索引名，供启动时幂等 `DROP`。
 * @returns {Array.<string>} 索引名数组
 */
function legacyIndexes() {
  return MODULES.flatMap((m) => m.legacyIndexes);
}

/**
 * 功能：汇总全部模块的索引语句，交给 storage.js 逐条执行。
 *
 * 说明：⚠️ 逐条执行且**单条失败不能拖垮整个库** —— 上抛会被判成「库打不开」而整体只读降级，
 *      代价远大于少一个索引。
 *
 * @returns {Array.<string>} `CREATE INDEX …` 语句数组
 */
function indexStatements() {
  return MODULES.flatMap((m) => m.indexes || []);
}

module.exports = {
  SCHEMA_VERSION,
  // ⭐ 0.8.1：记账独立库自己的结构版本（与主库的 SCHEMA_VERSION **分开数**）
  LEDGER_SCHEMA_VERSION,
  MAIN_DB,
  LEDGER_DB,
  MODULES,
  assertModules,
  tableNames,
  createAll,
  // ⭐ 0.8.1：「表 → 库」映射与分库原语（唯一出处都在本文件）
  dbOf,
  tablesByDb,
  ledgerTables,
  createAllIn,
  ensureColumnsIn,
  indexStatementsIn,
  userScopedTablesIn,
  rebuildOrder,
  normalizeOf,
  ensureColumns,
  allowedCols,
  userScopedTables,
  aliases,
  // ⭐ 0.8.12：「列改名」迁移（与 aliases 同性质的第二档）
  columnAliases,
  legacyIndexes,
  indexStatements,
};
