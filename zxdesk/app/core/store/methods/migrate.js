'use strict';
/**
 * core/store/methods/migrate.js —— **记账数据迁移**（0.8.1，/ T24）
 *
 * 功能：把 1 期（0.8.0）落在**主库** `zxdesk.db` 里的那几张 `ledger_*` 表**搬**进记账独立库
 *      `zxdesk-ledger.db`（0.8.1 起记账模块的全部表都住那里）。
 *      对外只有**一个**方法 `migrateLedgerDb()`，返回一份人看得懂的报告：
 *      `{ state, counts, snapshots, dir, note, mainCleaned }`。
 *
 * 三条口径（⛔ 不许改，出处是方案 §三）：
 *   ① **需要迁移的判据**：主库那几张表**非空** ＋ 记账库**没有完成标记**；
 *      有标记 ＋ 主库还有残留 ⇒ **只清残留**（⛔ 不重复复制）；
 *      有标记 ＋ 主库已空 ⇒ 什么都不做，提示「早已迁移完成」。
 *   ② **搬迁语义是「搬」不是「拷」**：复制成功后**把主库那几张表的数据删掉**，主库不留副本 ——
 *      留底靠迁移前那两份快照（`backup/` 目录下的 `zxdesk-zxdesk-<时间戳>.db` 与
 *      `zxdesk-zxdesk-ledger-<时间戳>.db`）。文件名照方案 C-5 的规则逐字来（`zxdesk-<库名>-<时间戳>`）。
 *   ③ **不做自动回滚、不自动修数据**：复制那一步失败 ⇒ 整段回滚、主库一行不动（重跑安全）；
 *      清主库那一步失败 ⇒ 如实报告「数据已在记账库、主库残留未清」，由人再点一次（走 ① 的第二态）。
 *
 * ⚠️⭐ **为什么必须绕过 `_bk` 门面来读主库**：`_bk.<op>()` 是按**表名**路由到对应库的，而
 *    `ledger_*` 这些表在新代码里已经属于**记账库** —— 走门面读到的会是记账库（空的），
 *    于是永远判成「主库没有数据、没什么要搬的」。所以：**读**必须走主库那一侧的原始 SQL
 *    （SQLite 用 `this.db` 的 `prepare().all()`，JSON 用 `this.data.<表名>`）；
 *    **写**则走记账库那一侧（SQLite 用 `this.ledgerDb`，JSON 用 `this.ledgerData`）。
 *
 * ⚠️ 迁移涉及的表**以 `SCHEMA.ledgerTables()` 为准**（⛔ 不许在本文件里手写表名清单）：
 *    记账模块以后加表，这个工具自动跟上；手写清单的表现是「新表静默没搬过去」。
 * ⚠️ 完成标记住**记账库**的 `ledger_meta`（键 `migrated_from_main`），⛔ 不许拿 `PRAGMA user_version`
 *    当标记 —— 那是记账库的**结构版本**（另一个用途），一个号表示两件事迟早出事。
 * ⚠️ 日志与响应里**只有条数与路径**，⛔ 一个金额 / 备注 / 分类名 / 账户名都不许出现（方案 §八）。
 *
 * ⚠️ 本文件**不许 require `../http-util.js`**（它 require `context.js`，会成环），
 *    503 与 400 的错误对象按 `_assertWritable()` 的同款写法就地构造。
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.8.1
 * 相关：docs/公共/开发方案/21-记账2期-记账.md（决策 3 / 决策 4）、docs/公共/架构文档/02-存储层与数据模型.md
 */

const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA } = require('../constants.js');
const { compactStamp, nowStamp, badRequest } = require('../helpers.js');

/** 迁移快照的落点：数据目录下的 `backup/` 子目录（**只放迁移快照**，⛔ 不碰既有自动备份那套） */
const BACKUP_SUBDIR = 'backup';

/** 两个库在快照文件名里的「库名」（`zxdesk-<库名>-<YYYYMMDD-HHMMSS>.db`） */
const MAIN_DB_NAME = 'zxdesk';
const LEDGER_DB_NAME = 'zxdesk-ledger';

/** 「这批数据是从主库搬来的」这个事实的键名（住记账库的 `ledger_meta`） */
const MARK_KEY = 'migrated_from_main';

/**
 * `ledger_meta` 的**建表兜底** DDL。
 *
 * ⚠️⭐ 它必须与 `modules/ledger/schema.js` 里那张表的声明**逐字一致**（列名 / 类型 / 主键）——
 *    这张表归记账模块声明，本工具只是「用」它。之所以在这里再写一遍，是为了让迁移工具
 *    **不依赖声明的到达顺序**：即使 schema 那边的声明晚一步落地，工具也不会当场炸掉。
 *    ⛔ 改这里的列，等于改那张表的结构，必须两边一起改。
 */
const META_DDL = 'CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)';

/**
 * 功能：构造一个「当前做不了这件事」的 503 错误（数据层不可用 / 只读降级走它）。
 *
 * 说明：写法与 `_assertWritable()` 一致（就地造 `Error` 并挂 `status`），由 `fail()` 收口成 503。
 *
 * @param {string} message - 中文说明（直接展示给用户，必须说人话）
 * @returns {Error} 带 `status = 503` 的错误对象
 */
function unavailable(message) {
  const e = new Error(message);
  e.status = 503;
  return e;
}

/**
 * 功能：把一段字符串包成 SQLite 字符串字面量（单引号翻倍）——`VACUUM INTO` 的路径只能用字面量。
 * @param {string} s - 原始字符串
 * @returns {string} 可拼进 SQL 的字面量
 */
function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 功能：取**记账库那一侧**的句柄描述 —— SQLite 是第二个连接，JSON 是第二个数据对象。
 *
 * 说明：⚠️ 两个后端各有一份实现：只认 SQLite 的话，JSON 装法下这个工具会静默失效。
 *
 * @param {Object} store - Store 实例
 * @returns {?{mode: string, db: ?Object, data: ?Object, file: ?string}} 记账库那一侧；不可用时为 null
 */
function ledgerSideOf(store) {
  if (store.backend === 'sqlite') {
    return store.ledgerDb ? { mode: 'sqlite', db: store.ledgerDb, data: null, file: store.ledgerDbFile } : null;
  }
  return store.ledgerData ? { mode: 'json', db: null, data: store.ledgerData, file: store.ledgerJsonFile } : null;
}

/**
 * 功能：判断某张表在主库连接上到底存不存在。
 *
 * 说明：⚠️ 必须查 `sqlite_master` 而不是「直接 SELECT 一把、catch 掉异常」—— 后者会把
 *      「表不存在」和「表在读的时候真出错了」混成一件事，而这两件事的处理完全不同。
 *
 * @param {Object} db - SQLite 连接（主库）
 * @param {string} table - 表名
 * @returns {boolean} 存在返回 true
 */
function hasTable(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/**
 * 功能：读**主库**某张表的全部行（⭐ 这正是「绕过 `_bk` 门面」的那一步，理由见文件头）。
 *
 * 说明：表不存在（老库没有这张表 / 全新库还没建）一律当**空表**处理 —— 迁移关心的是
 *      「主库里还有没有 1 期的数据」，没有这张表就是没有数据，不是错误。
 *
 * @param {Object} store - Store 实例
 * @param {string} table - 表名
 * @returns {Array.<Object>} 该表在主库里的行；表不存在时为空数组
 */
function mainRowsOf(store, table) {
  if (store.backend === 'sqlite') {
    if (!hasTable(store.db, table)) return [];
    return store.db.prepare(`SELECT * FROM ${table}`).all();
  }
  const rows = store.data ? store.data[table] : null;
  return Array.isArray(rows) ? rows : [];
}

/**
 * 功能：读记账库里的**完成标记**；没有（含表还不存在）返回 null。
 *
 * 说明：⚠️ SQLite 上「先 `CREATE TABLE IF NOT EXISTS` 再 SELECT」是方案定死的手法（§3.4）：
 *      不这么兜一下，第一次跑（表还没被 schema 建出来）会在读标记这一步直接抛错。
 *
 * @param {{mode: string, db: ?Object, data: ?Object}} side - 记账库那一侧
 * @returns {?string} 标记值（迁移完成的时间戳字符串）；没有标记时返回 null
 */
function readMark(side) {
  if (side.mode === 'sqlite') {
    side.db.exec(META_DDL);
    const row = side.db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(MARK_KEY);
    return row ? String(row.value || '') : null;
  }
  const rows = Array.isArray(side.data.ledger_meta) ? side.data.ledger_meta : [];
  const row = rows.find((r) => r && r.key === MARK_KEY);
  return row ? String(row.value || '') : null;
}

/**
 * 功能：把待插入的行摊平成「列名数组」——按**首次出现的顺序**取所有行的键的并集。
 *
 * 说明：⚠️ 不能只看第一行的键：JSON 后端的历史行是**参差**的（老版本加过的列、缺过的列都可能
 *      只出现在部分行上），只看首行会**静默丢掉**后面那些行的字段。
 *
 * @param {Array.<Object>} rows - 待插入的行
 * @returns {Array.<string>} 列名数组
 */
function colsOf(rows) {
  const seen = new Set();
  rows.forEach((r) => Object.keys(r || {}).forEach((k) => seen.add(k)));
  return [...seen];
}

/**
 * 功能：把值转成能交给 SQLite 绑定的形态（`undefined` → `NULL`）。
 * @param {*} v - 原始值
 * @returns {*} 可绑定的值
 */
function bindVal(v) {
  return v === undefined ? null : v;
}

/**
 * 功能：给**两个库各**做一份一致快照，落在 `backup/` 子目录下，返回两个文件名（不含目录）。
 *
 * 说明：⭐ SQLite 走 `VACUUM INTO`（与 `snapshot()` / `rawDump()` 同一个手法）——WAL 模式下
 *      直接拷 `.db` 会漏掉尚未 checkpoint 的事务，快照看着在、恢复回去却少一截。
 *      JSON 后端退化成「把两个 JSON 文件各拷一份」（扩展名 `.json`，文件名同规则）。
 * ⚠️ 源文件还没落盘时（新库第一次写之前）按**内存里的那一份**写出去 —— 两个快照必须都在，
 *    否则「回滚 = 把快照人工放回」这句话就落空了。
 * ⚠️ 快照失败**必须抛**：没有退路就不该往下动数据（与 `restoreWholeBackup` 同一条纪律）。
 * ⚠️⭐ 时间戳只到**秒**，所以「一秒之内点了第二次」会撞名 —— 而 `VACUUM INTO` 遇到目标已存在
 *    是**直接报错**的。⛔ 绝不能覆盖已有快照（那是别人上一轮的退路），所以撞名时加 `-2` / `-3` 后缀。
 *
 * @param {Object} store - Store 实例
 * @param {Object} side - 记账库那一侧
 * @param {string} dir - `backup/` 目录的绝对路径
 * @returns {Array.<string>} 两个快照的文件名（主库在前）
 * @throws {Error} 任一快照写不出来时抛出
 */
function snapshotBoth(store, side, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = compactStamp();
  const ext = side.mode === 'sqlite' ? '.db' : '.json';
  const mainName = freeName(dir, `zxdesk-${MAIN_DB_NAME}-${stamp}`, ext);
  const ledgerName = freeName(dir, `zxdesk-${LEDGER_DB_NAME}-${stamp}`, ext);
  if (side.mode === 'sqlite') {
    store.db.exec(`VACUUM INTO ${sqlStr(path.join(dir, mainName))}`);
    side.db.exec(`VACUUM INTO ${sqlStr(path.join(dir, ledgerName))}`);
    return [mainName, ledgerName];
  }
  copyJsonSnapshot(store.jsonFile, store.data, path.join(dir, mainName));
  copyJsonSnapshot(side.file, side.data, path.join(dir, ledgerName));
  return [mainName, ledgerName];
}

/**
 * 功能：在 `backup/` 目录里挑一个**还没被占用**的快照文件名 —— 撞名时依次试 `<名字>-2` / `-3` …
 *
 * 说明：⚠️ 只有「同一秒内跑第二次」才会走到这里（时间戳精确到秒），
 *      但那条路必须走得通：否则第二次迁移会得到一个 `SQL logic error: output file already exists`，
 *      而用户看到的是「迁移失败」，实际是「快照名撞了」。
 *
 * @param {string} dir - `backup/` 目录
 * @param {string} base - 不含扩展名的基名
 * @param {string} ext - 扩展名（含点）
 * @returns {string} 可用的文件名（不含目录）
 */
function freeName(dir, base, ext) {
  let name = `${base}${ext}`;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base}-${i}${ext}`;
    i += 1;
  }
  return name;
}

/**
 * 功能：给 JSON 后端的某个文件写一份快照（文件在就拷贝，文件还没落盘就按内存那份写出去）。
 * @param {?string} srcFile - 源文件路径（可能还不存在）
 * @param {?Object} data - 内存里的那一份数据（源文件不存在时用它）
 * @param {string} dest - 快照目标路径
 * @returns {void}
 */
function copyJsonSnapshot(srcFile, data, dest) {
  if (srcFile && fs.existsSync(srcFile)) fs.copyFileSync(srcFile, dest);
  else fs.writeFileSync(dest, JSON.stringify(data || {}, null, 2), 'utf8');
}

/**
 * 功能：把主库那几张表的数据**复制进记账库**，并在**同一个事务**里写下完成标记。
 *
 * 说明：⭐⭐ 「复制 ＋ 写标记」必须是一个事务：拆成两次写的话，中间失败会留下
 *      「数据在记账库、但没有标记」的状态 —— 下次重跑又会复制一遍（重复记账，且不报错）。
 * ⚠️ JSON 后端没有事务，用等价手法：**先记住那几段内存里的旧值 → 出错整段还原 →
 *    成功才落一次盘**（`_saveJson('ledger')` 就是这里的「提交点」）。
 * ⚠️ 主库那份数据**一行都不改**（清主库是下一步，单独一个事务）。
 *
 * @param {Object} store - Store 实例
 * @param {Object} side - 记账库那一侧
 * @param {Array.<string>} tables - 要搬的表名（来自 `SCHEMA.ledgerTables()`）
 * @param {Object} rowsByTable - `{ 表名: 主库里的行数组 }`
 * @returns {void}
 * @throws {Error} 插入或落盘失败时抛出（记账库那一侧已回滚）
 */
function copyIntoLedger(store, side, tables, rowsByTable) {
  const stamp = nowStamp();
  if (side.mode === 'sqlite') {
    const db = side.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      tables.forEach((t) => {
        const rows = rowsByTable[t] || [];
        if (!rows.length) return;
        const cols = colsOf(rows);
        const stmt = db.prepare(
          `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        rows.forEach((row) => stmt.run(...cols.map((c) => bindVal(row[c]))));
      });
      db.prepare('INSERT OR REPLACE INTO ledger_meta (key, value, updated_at) VALUES (?, ?, ?)').run(
        MARK_KEY,
        stamp,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚本身失败无可挽回，把原始错误抛出去 */
      }
      throw e;
    }
    return;
  }

  const oldTables = {};
  tables.forEach((t) => {
    oldTables[t] = side.data[t];
  });
  const oldMeta = side.data.ledger_meta;
  try {
    tables.forEach((t) => {
      const rows = rowsByTable[t] || [];
      if (!rows.length) return;
      const kept = Array.isArray(side.data[t]) ? side.data[t] : [];
      // ⚠️ 逐行浅拷贝：主库那份行对象还要留给下一步（清主库时按条数比对），不能共享引用
      side.data[t] = kept.concat(rows.map((r) => Object.assign({}, r)));
    });
    const meta = Array.isArray(side.data.ledger_meta) ? side.data.ledger_meta : [];
    side.data.ledger_meta = meta
      .filter((r) => !(r && r.key === MARK_KEY))
      .concat([{ key: MARK_KEY, value: stamp, updated_at: Date.now() }]);
    // ⚠️ 参数必须是 `SCHEMA.LEDGER_DB`（⛔ 不写 'ledger' 字面量）：`_saveJson()` 是拿它与常量比对的，
    //    常量一旦改名，硬编码的字符串会**静默**落到 `activeDb`（当前是主库）—— 表现是数据搬了却没落盘
    store._saveJson(SCHEMA.LEDGER_DB);
  } catch (e) {
    tables.forEach((t) => {
      side.data[t] = oldTables[t];
    });
    side.data.ledger_meta = oldMeta;
    throw e;
  }
}

/**
 * 功能：**清空主库**那几张表的数据（一个事务），返回逐表清掉的条数。
 *
 * 说明：⚠️ 这是「搬」而不是「拷」的落点（方案 第 3 条）：主库不留副本，
 *      留底靠 `backup/` 里那两份快照。
 * ⚠️ 同样必须**一个事务**：删到一半失败会留下「一部分表清了、一部分没清」，
 *    而重跑只认「主库还有没有残留」，那种半清状态最难判。
 * ⚠️ 表不存在时跳过（不是错误，只是本来就没什么可清）。
 *
 * @param {Object} store - Store 实例
 * @param {Array.<string>} tables - 要清的表名
 * @returns {Object} `{ 表名: 清掉的条数 }`
 * @throws {Error} 删除失败时抛出（主库那一侧已回滚）
 */
function clearMain(store, tables) {
  const counts = {};
  if (store.backend === 'sqlite') {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      tables.forEach((t) => {
        if (!hasTable(store.db, t)) {
          counts[t] = 0;
          return;
        }
        const r = store.db.prepare(`DELETE FROM ${t}`).run();
        counts[t] = Number(r.changes || 0);
      });
      store.db.exec('COMMIT');
    } catch (e) {
      try {
        store.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚本身失败无可挽回，把原始错误抛出去 */
      }
      throw e;
    }
    return counts;
  }

  const old = {};
  tables.forEach((t) => {
    old[t] = store.data[t];
  });
  try {
    tables.forEach((t) => {
      const rows = Array.isArray(store.data[t]) ? store.data[t] : [];
      counts[t] = rows.length;
      store.data[t] = [];
    });
    store._saveJson(SCHEMA.MAIN_DB);
  } catch (e) {
    tables.forEach((t) => {
      store.data[t] = old[t];
    });
    throw e;
  }
  return counts;
}

/**
 * 功能：给一串表名造出「逐表 0 条」的条数表（`already` 那一态返回它，形状与另外两态一致）。
 * @param {Array.<string>} tables - 表名数组
 * @returns {Object} `{ 表名: 0 }`
 */
function zeroCounts(tables) {
  const counts = {};
  tables.forEach((t) => {
    counts[t] = 0;
  });
  return counts;
}

module.exports = {
  /**
   * 功能：把 1 期落在**主库**的记账数据搬进**记账独立库**（迁移工具的主体，三态幂等）。
   *
   * 说明：⭐ 由管理员**手工触发**（`POST /api/migrate-ledger`），⛔ 绝不放在启动流程里 ——
   *      启动时改用户数据撞铁律 18~20（「启动与迁移绝不改写用户数据」）。
   *      本方法**幂等**：第一次是「搬」，之后每次重跑只会清残留或什么都不做。
   *
   * 返回的 `state` 三态：
   *   · `migrated` —— 没标记 ＋ 主库有数据 ⇒ 正常迁移（复制 ＋ 写标记 ＋ 清主库）；
   *   · `cleaned`  —— 有标记 ＋ 主库还有残留 ⇒ **只清残留**（⛔ 不重复复制）；
   *   · `already`  —— 有标记 ＋ 主库已空（早已迁完），或**没标记 ＋ 主库本来就空**
   *                   （全新安装，压根没有 1 期的账要搬）⇒ 什么都不做。
   *
   * ⚠️ 快照只在**真要动数据**的那两态里做（`migrated` / `cleaned`）：什么都不做的态没有
   *    「回滚点」可言，凭空多两个文件只会让用户以为出过事。
   *
   * @returns {{state: string, counts: Object, snapshots: Array.<string>, dir: string, note: string,
   *      mainCleaned: boolean}} 迁移报告（`state` 见上；`counts` 逐表条数；`snapshots` 快照文件名；
   *      `dir` 是 `backup/` 目录；`note` 是一句人话；`mainCleaned` 只在 `migrated` 时有意义）
   * @throws {Error} 主库只读降级（503）、记账库不可用（503）、复制或清理失败（原样上抛）
   */
  migrateLedgerDb() {
    // ⚠️ 主库要**删数据**（搬迁语义），所以主库这一侧也必须可写
    this._assertWritable();

    const side = ledgerSideOf(this);
    if (!side) {
      throw unavailable(
        '记账独立库当前不可用（第二个库没打开），迁移已中止 —— 数据一行未动。请检查数据目录权限后重启应用再试。',
      );
    }
    // ⭐ 记账库只读闸门：两个库各有各的失败点，主库可写**不代表**记账库可写
    this._assertLedgerWritable();

    // ⚠️ 表清单只有一个出处（⛔ 不许手写）：记账模块以后加表，这里自动跟上
    const tables = SCHEMA.ledgerTables();
    if (!Array.isArray(tables) || !tables.length) {
      throw badRequest('记账库的表清单是空的 —— 这通常意味着记账模块没被加载，迁移已中止。');
    }

    const rowsByTable = {};
    let residual = 0;
    tables.forEach((t) => {
      const rows = mainRowsOf(this, t);
      rowsByTable[t] = rows;
      residual += rows.length;
    });

    const mark = readMark(side);
    const dir = path.join(this.dataDir, BACKUP_SUBDIR);

    // ---- ② 有标记：只清残留（⛔ 不重复复制） ----
    if (mark) {
      if (!residual) {
        return {
          state: 'already',
          counts: zeroCounts(tables),
          snapshots: [],
          dir,
          mainCleaned: true,
          note: '记账数据早已迁移完成，主库也没有残留 —— 本次什么都没做。',
        };
      }
      const snapshots = snapshotBoth(this, side, dir);
      const counts = clearMain(this, tables);
      return {
        state: 'cleaned',
        counts,
        snapshots,
        dir,
        mainCleaned: true,
        note: `已清理主库残留：共 ${residual} 条（记账库里的数据早已迁移完成，本次没有重复复制）。`,
      };
    }

    // ---- 没标记 ＋ 主库本来就空：全新安装，压根没有 1 期的账要搬（不是错误） ----
    if (!residual) {
      return {
        state: 'already',
        counts: zeroCounts(tables),
        snapshots: [],
        dir,
        mainCleaned: true,
        note: '主库里没有记账数据，不需要迁移 —— 本次什么都没做。',
      };
    }

    // ---- ① 没标记 ＋ 主库非空：正常迁移（复制 ＋ 写标记，然后清主库） ----
    const snapshots = snapshotBoth(this, side, dir);
    copyIntoLedger(this, side, tables, rowsByTable); // 失败 ⇒ 记账库回滚、主库一行不动

    let mainCleaned = true;
    let cleanError = null;
    try {
      clearMain(this, tables);
    } catch (e) {
      // ⚠️ 走到这里意味着**数据已经在记账库了**（上一句成功了），只是主库残留没清掉。
      //    按方案的口径：如实说出来，由人再点一次（下次会走「只清残留」那一态）。
      //    ⚠️ 这里**不抛**：抛了就成了「看起来整个迁移失败」，而事实是数据已经安全搬走了 ——
      //    那种误导会让人去用快照人工回滚一份本来完好的数据。
      mainCleaned = false;
      cleanError = (e && e.message) || String(e);
    }

    return {
      state: 'migrated',
      counts: Object.fromEntries(tables.map((t) => [t, (rowsByTable[t] || []).length])),
      snapshots,
      dir,
      mainCleaned,
      note: mainCleaned
        ? `已把 ${residual} 条记账数据从主库搬进记账库，并清空了主库那几张表；迁移前的两份快照在 backup 目录里，请妥善保管。`
        : `数据已全部搬进记账库（${residual} 条），但主库残留未清（${cleanError}）—— ` +
          '请再点一次「迁移记账数据」清理残留；在清理完成前，应用读的是记账库，功能不受影响。',
    };
  },
};
