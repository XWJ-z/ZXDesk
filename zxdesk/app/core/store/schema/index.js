'use strict';
/**
 * core/store/schema/index.js —— **表结构的总装配**（唯一的 schema 版本号出处）。
 * 功能：把各功能模块的表结构装配成一份完整 schema，供存储层建库与迁移使用。
 * `SCHEMA_VERSION` 是结构版本，`MODULES` 是模块清单，`assertModules()` 是加载时的契约自检；
 * `createAll()` / `tableNames()` / `rebuildOrder()` / `normalizeOf()` / `ensureColumns()` /
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/21-记账2期-记账.md（决策 3）
 */

const core = require('./core.js');
const {
  registry,
  schemaModules,
  DATABASES,
  DEFAULT_DATABASE,
} = require('../../../modules/registry.js');

/**
 * 尚未搬进 `app/modules/` 的模块 → 它旧的表结构声明。
 * @type {Object.<string, Function>}
 */
const LEGACY_SCHEMA = {};

/**
 * ⚠️ 顺序有意义：**`core` 必须第一**（`modules/registry.js` 的 `schemaModules()` 保证）。
 *    `users` 是任务与课表的父表，重建（DROP + RENAME）时父表必须先存在。
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
 * 说明：array 与 object 必须分开判 —— `typeof [] === 'object'`，只比 `typeof` 会把数组当对象放过。
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
 * 说明：⭐ 模块契约的**运行时自检**——契约此前只写在注释里，靠 `ttt/test/schema.test.js`
 *      在跑测试时兜底，而「忘了声明 `userScoped`」这类漏字段的危害是**数据残留**（删了账号，
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
    // `columnAliases` 是**可选**字段（只有真改过列名的模块才声明）——
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
// 「表 → 库」的映射（**全仓唯一出处**）
// ============================================================================

/** 主库（`zxdesk.db` / `zxdesk.json`）：除记账模块之外的一切 */
const MAIN_DB = DATABASES.MAIN;

/**
 * 记账独立库（`zxdesk-ledger.db` / `zxdesk-ledger.json`）。
 * ⚠️ 这个字符串是**契约值**：模块在 `module.json` 里写的就是它（`"database": "ledger"`），
 */
const LEDGER_DB = DATABASES.LEDGER;

/**
 * ⭐ 实验室独立库（`zxdesk-lab.db` / `zxdesk-lab.json`）—— 「一个应用一个库」的**第二个例外**。
 * 说明：装所有 `database: "lab"` 的模块的表。`` 里声明它的是**加密信息**
 */
const LAB_DB = DATABASES.LAB;

/**
 * 表名 → 库名（`'main'` / `'ledger'`）。
 * @type {Map.<string, string>}
 */
function buildDbOfTable(list) {
  const map = new Map();
  for (const meta of list || []) {
    // ⚠️ 值合法性**不在这里判**：`modules/registry.js` 的 `loadModules()` 已经对白名单校验过
    //    （非法值加载即抛，根本走不到这里）。这里只做「缺省 = 主库」的归一。
    const db = meta.database || DEFAULT_DATABASE;
    for (const t of meta.tables || []) map.set(t, db);
  }
  return map;
}

const DB_OF_TABLE = buildDbOfTable(registry.list);

/**
 * 功能：查一张表住在哪个库 —— **「表 → 库」映射的唯一入口**。
 * 说明：⭐ 所有「这个操作该走哪个连接」的判断都必须经过它（`store._dbFor()` / `_dataFor()` /
 *      两个后端原语的表名参数 / 迁移工具的表清单）。⛔ 不许在别处再写一份「哪些表在哪个库」的
 *      清单：那种副本的失效方式是**静默的** —— 加了新表而副本没跟上，表现是「新表的数据
 * @param {string} table - 表名
 * @returns {string} `'main'` / `'ledger'` / `'lab'`；**未登记的表回 `'main'`**（失败方向安全）
 */
function dbOf(table) {
  return DB_OF_TABLE.get(String(table)) || MAIN_DB;
}

/**
 * 功能：列出住在某个库里的全部表（顺序 = `tableNames()` 的顺序）。
 * @param {string} db - `'main'` / `'ledger'` / `'lab'`
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
 * 功能：实验室独立库里的全部表 —— 转正工具、实验室库建表与实验室库备份都认它。
 *
 * 说明：里它是 `['secrets_items']`（加密信息那个实验功能）。⚠️ 调用方仍然必须能安全地吃
 *      **空数组** —— 实验室一旦没有任何实验功能（实验被撤光 / 模块目录被删），这里就是空的；
 *      而「0 张表的库」不是错误状态（`createAllIn()` 得到一条空语句，备份那一段整段跳过）。
 * @returns {Array.<string>} 实验室库的表名数组
 */
function labTables() {
  return tablesByDb(LAB_DB);
}

/**
 * schema 版本（写在 SQLite 的 `PRAGMA user_version` 里）。
 * 用途只有一个：**判断「这次启动会不会动结构」，从而决定迁移前要不要自动备份、要不要重建表**。
 */
const SCHEMA_VERSION = 7;

/**
 * ⭐ **记账独立库自己的结构版本**（写在记账库连接的 `PRAGMA user_version` 里）。
 * 说明：⚠️⭐ 它**必须与主库的 `SCHEMA_VERSION` 分开**：一个号表示两件事
 */
const LEDGER_SCHEMA_VERSION = 1;

/**
 * **实验室独立库自己的结构版本**（写在实验室库连接的 `PRAGMA user_version` 里）。
 * 说明：⚠️⭐ 理由与 `LEDGER_SCHEMA_VERSION` **逐字同构**（三个库各数各的历史）：
 */
const LAB_SCHEMA_VERSION = 1;

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
 * 说明：⭐ 两个库各自建自己的表：记账库用 `createAllIn(ledgerDb, 'ledger')`，
 *      建出来的**只有**记账那几张 —— ⛔ 不许把全部表都建进记账库：那样「表在哪个库」
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
 * 说明：⚠️ 在主库上对记账库的表补列会当场报错（表不存在）—— 而报错的后果是把
 *      `_migrateSqlite()` 判成「库打不开」，整个主库降级只读（代价远大于少一列）。
 * @param {string} dbName - 库名，`'main'` / `'ledger'`
 * @returns {Array.<Array.<string>>} `[[表名, 列名, 类型], …]`
 */
function ensureColumnsIn(dbName) {
  return ensureColumns().filter(([table]) => dbOf(table) === dbName);
}

/**
 * 功能：从一条索引语句里取出它建在哪张表上（取 `ON` 后面那一段）。
 * 说明：⚠️ 索引语句是**裸 SQL 字符串**（模块自己写），不像 DDL 那样带表名参数 ——
 *      所以只能从语句本身把表名抠出来。抠不出来时回 `'main'`（失败方向安全：
 *      索引只是加速手段，建在主库上顶多是记账库少一个索引，绝不会「建到错的库上毁数据」）。
 * @param {string} sql - 一条 `CREATE INDEX …` 语句
 * @returns {string} 该索引所属的库名
 */
function dbOfIndex(sql) {
  const m = /\bON\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(String(sql));
  return m ? dbOf(m[1]) : MAIN_DB;
}

/**
 * 功能：取**某一个库**的索引语句。
 * 说明：⚠️ 逐条按语句解析表名（见 `dbOfIndex`），而不是按模块一刀切 ——
 *      函数本身对「某个模块的索引全在主库」与「全在记账库」都一样正确。
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
 * 说明：⭐ 删账号现在是**两段执行**（记账库先、主库后，见 `store/backend/*.js` 的 `deleteUser()`），
 *      每一段只清自己那个库里的表 —— 拿全量清单去 `DELETE` 一个不属于该库的表会当场
 *      「no such table」并把删账号**卡在中途**（那正是「账号还在、数据少了一半」的成因）。
 * @param {string} dbName - 库名，`'main'` / `'ledger'`
 * @returns {Array.<string>} 该库里带 `user_id` 的表名数组
 */
function userScopedTablesIn(dbName) {
  return userScopedTables().filter((t) => dbOf(t) === dbName);
}

/**
 * 功能：查某张表允许被通用 `_update()` 写入的列，**由定义这张表的模块自报**。
 * 说明：⚠️ 查不到就返回 `[]` —— 与改造前 `switch` 的 `default: return []` 逐字同义：
 *      `_update` 拿到空数组时 `setKeys` 为空 → 直接 `return false` → 路由层回 404。
 *      也就是说**没登记的表改不动**，而不是「什么都能改」—— 宁可改不动，不可乱改。
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
 * 功能：把所有模块的**列改名**映射摊平，供迁移按「旧列名 → 新列名」改名（新造的一档）。
 * 说明：⭐ 它与 `aliases()`（表改名）**同性质** —— `ALTER TABLE … RENAME COLUMN` 只改
 *      `sqlite_master` 里的列名，**不动任何一行用户数据**，是本项目里最不容易出事的结构变更。
 *      ⚠️⭐ 迁移里它必须排在 `ensureColumns()` **之前**：否则补列会先按新 DDL 把新列补出来
 *      （默认 0），旧列还在 ⇒ 两边同名撞车，而撞名的表现是「设置开关全被重置」且**不报错**
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
  // 记账独立库自己的结构版本（与主库的 SCHEMA_VERSION **分开数**）
  LEDGER_SCHEMA_VERSION,
  // 实验室独立库自己的结构版本（同上，三个号互不相干）
  LAB_SCHEMA_VERSION,
  MAIN_DB,
  LEDGER_DB,
  // ⭐ 第三个库（「一个应用一个库」的第二个例外）
  LAB_DB,
  MODULES,
  assertModules,
  tableNames,
  createAll,
  // 「表 → 库」映射与分库原语（唯一出处都在本文件）
  dbOf,
  tablesByDb,
  ledgerTables,
  // 实验室库的表清单
  labTables,
  // 映射装配器（`dbOf()` 的唯一实现；测试用它注入含 `database: "lab"` 的夹具）
  buildDbOfTable,
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
  // 「列改名」迁移（与 aliases 同性质的第二档）
  columnAliases,
  legacyIndexes,
  indexStatements,
};
