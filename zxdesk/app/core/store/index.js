'use strict';
/**
 * core/store/index.js —— Store 的**装配点**
 * 功能：`makeStore(APP_VERSION)` 返回组装好的 `Store` 类；类内负责状态字段初始化、`_init()` 的后端选择
 * （SQLite 优先、失败降级 JSON、库文件本来就在却打不开时转只读）、写闸门 `_assertWritable()`、
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */

const sqlite = require('./backend/sqlite.js');
const json = require('./backend/json.js');
const { OPS, MERGED_OPS } = require('./backend/index.js');
const { SCHEMA } = require('./constants.js');
const { registry } = require('../../modules/registry.js');
const fs = require('node:fs');
const path = require('node:path');

/**
 * ：**第二个库**的文件名 —— 记账模块的全部表住它。
 *
 */
const LEDGER_DB_FILE = 'zxdesk-ledger.db';
const LEDGER_JSON_FILE = 'zxdesk-ledger.json';

/**
 * ：**第三个库**的文件名 —— `database: "lab"` 的模块的全部表住它。
 *
 */
const LAB_DB_FILE = 'zxdesk-lab.db';
const LAB_JSON_FILE = 'zxdesk-lab.json';

/**
 * 功能：装配期护栏 —— 各来源的业务方法名必须两两不重名，重名**当场抛错**并点名是哪两个来源。
 *
 * 说明：⚠️ 为什么必须是**硬失败**而不是「后者覆盖前者 + 打个日志」：`Object.assign` 的覆盖是
 * 这与 `store/backend/index.js` 的 `assertOpsContract()`、`modules/registry.js` 的
 *
 */
function assertNoMethodClash(sources) {
  /** @type {Map.<string, string>} 方法名 → 第一个声明它的来源 */
  const seen = new Map();
  const problems = [];
  for (const [label, mod] of sources) {
    for (const name of Object.keys(mod || {})) {
      if (seen.has(name)) problems.push(`「${name}」同时声明在 ${seen.get(name)} 与 ${label}`);
      else seen.set(name, label);
    }
  }
  if (problems.length) {
    throw new Error(
      `[store] 业务方法撞名（共 ${problems.length} 处）—— ` +
        `\`Object.assign\` 会让后来者**静默覆盖**前者，必须改名（业务方法一律带模块前缀）：\n  - ${problems.join('\n  - ')}`,
    );
  }
}

/**
 * 功能：算出「后端原语 → 它属于哪个库」——**按声明这条原语的那个模块**判（`module.json.database`）。
 *
 * 说明：⭐⭐ 多库分派就落在这里。为什么按**模块**而不是按「原语第几个参数是表名」判：
 * 模块原语的参数是业务形状（`listLedgerAccounts(uid)`、`insertLedgerAccount(uid, values, stamp)`），
 * **看不出表名**；而「哪个模块的 op 读写哪个库」是模块自己已经在 `module.json` 里声明过的事实
 */
function moduleOpsDb() {
  const map = new Map();
  for (const meta of registry.list) {
    const db = meta.database;
    if (!db || db === SCHEMA.MAIN_DB) continue;
    const pair = registry.backendFor(meta.name);
    if (!pair) continue;
    for (const mod of [pair.sqlite, pair.json]) {
      for (const k of Object.keys((mod && mod.ops) || {})) map.set(k, db);
    }
  }
  return map;
}

/**
 * 功能：按 `OPS` 逐个生成转发函数，组成后端原语门面 —— 每个转发函数在**调用时**才读
 * `store.backend`，再调用同名 op；⭐ 属于记账库的原语额外切到第二个连接/第二份数据上执行。
 *
 * 说明：这样 `_init()` 内部（例如 `_importJsonIfEmpty` 会用到 `_insert`）也能安全使用。
 * 取函数的表是 `MERGED_OPS`（**旧的大文件 + 已搬迁模块自己的一对**合起来）——
 */
function makeFacade(store) {
  const opsDb = moduleOpsDb();
  const facade = {};
  for (const k of OPS) {
    const db = opsDb.get(k) || null;
    facade[k] = (...args) => {
      const fn = (store.backend === 'sqlite' ? MERGED_OPS.sqlite : MERGED_OPS.json)[k];
      if (!db || db === SCHEMA.MAIN_DB) return fn.apply(store, args);
      return store._runOnDb(db, () => fn.apply(store, args));
    };
  }
  return facade;
}

/**
 * 功能：接收版本号并装配出 `Store` 类 —— 定义状态字段与构造函数、`_init` / `_assertWritable` /
 * `_allowedCols`，再把两个后端与六个业务模块的方法挂到原型上。
 *
 * 说明：⚠️ 构造函数 / `_init` / `_assertWritable` / `_allowedCols` / `_sessionSig` 的方法体
 * 是从改造前的 `db.js` **按字节切出来的**。
 */
function makeStore(APP_VERSION) {
  class Store {
    /**
     * 功能：初始化实例的全部状态字段（数据目录、库文件路径、后端标记、迁移与备份记录、各类错误原因），
     * 创建 `_bk` 后端门面，最后调用 `_init()` 完成连接与数据装载。
     * @param {string} dataDir - 数据目录，不存在时会被递归创建
     * @returns {void}
     */
    constructor(dataDir) {
      /** 版本号（由 makeStore 注入；字面量只许留在 storage.js，见本文件头部说明） */
      this.appVersion = APP_VERSION;
      this.dataDir = dataDir;
      fs.mkdirSync(dataDir, { recursive: true });
      this.dbFile = path.join(dataDir, 'zxdesk.db');
      this.jsonFile = path.join(dataDir, 'zxdesk.json');
      // 第二个库（记账模块的全部表）—— 四个格子里「文件路径」的两个
      this.ledgerDbFile = path.join(dataDir, LEDGER_DB_FILE);
      this.ledgerJsonFile = path.join(dataDir, LEDGER_JSON_FILE);
      // 第三个库（`database: "lab"` 的模块的全部表）—— 与上面一格逐项对应
      this.labDbFile = path.join(dataDir, LAB_DB_FILE);
      this.labJsonFile = path.join(dataDir, LAB_JSON_FILE);
      this.backend = 'json';
      this.db = null;
      this.data = null;
      // 记账库那一侧的两个句柄（SQLite 第二个连接 / JSON 第二个数据对象）
      this.ledgerDb = null;
      this.ledgerData = null;
      // 实验室库那一侧的两个句柄（第三个连接 / 第三份数据对象）
      this.labDb = null;
      this.labData = null;
      this.journalMode = null;
      // 记账库自己的 WAL 探测结果 / 结构版本 / 建索引失败原因（与主库那三个同款、各数各的）
      this.ledgerJournalMode = null;
      this.ledgerSchemaVersion = 0;
      this.ledgerIndexErrors = [];
      this.labJournalMode = null;
      this.labSchemaVersion = 0;
      this.labIndexErrors = [];
      // 当前正在服务哪个库（`'main'` / `'ledger'` / `'lab'`）—— 只有门面切换时才会变，
      // 它决定 `_saveJson()` 不带参数时该落哪个文件（见 json.js 的 `_saveJson`）
      this.activeDb = SCHEMA.MAIN_DB;
      // 记账库打不开的原因 / 只读降级（语义与主库那两个逐条对应）
      this.ledgerInitError = null;
      this.ledgerReadOnly = false;
      // 实验室库的同款两个（第三个独立的「库打不开」失败点）
      this.labInitError = null;
      this.labReadOnly = false;
      // 记账库文件在本次启动**之前**是否已存在：决定「打不开时是否降级只读」与「迁移前是否备份」
      this.ledgerExistedBefore = fs.existsSync(this.ledgerDbFile);
      // 实验室库同款
      this.labExistedBefore = fs.existsSync(this.labDbFile);
      // 各库的**只读状态快照**（启动日志与排查用，字段见 `_refreshDbStatus()`）
      this.dbStatus = { main: null, ledger: null, lab: null };
      // v5：外键是否真的打开了（SQLite 默认关闭，必须每个连接显式开）
      this.foreignKeys = false;
      // 本次启动是否需要结构迁移（由 _backupBeforeMigrate 依 user_version 判定）
      this.needsMigrate = false;
      // v5 结构升级被跳过的原因（不为 null 时 user_version **不推进**，下次启动重试；由启动日志告警）
      this.schemaUpgradeSkipped = null;
      // v5 结构升级成功的记录：{ from, to, normalized }
      this.structuralUpgrade = null;
      // 改名迁移的结果（"旧 → 新"）与冲突（新名字已被占，跳过）
      this.renamedTables = [];
      this.tableAliasConflicts = [];
      // 列改名迁移的结果（"表.旧列 → 新列"）—— 与 renamedTables 同一套机制的第二档
      this.renamedColumns = [];
      // JSON 文件里被改名的键（老 zxdesk.json 加载时）
      this.renamedJsonKeys = [];
      // 建索引失败的原因（索引只是加速手段，失败不上抛；由启动日志告警）
      this.indexErrors = [];
      this.initError = null;
      // 库文件在本次启动**之前**是否已存在：决定「打不开时是否降级只读」与「迁移前是否备份」
      this.dbExistedBefore = fs.existsSync(this.dbFile);
      this.readOnly = false;
      // 迁移前自动备份的文件名 / 备份失败原因
      this.backupFile = null;
      this.backupError = null;
      // 从 zxdesk.json 一次性导入的条数 / 归档后的 JSON 文件名 / 导入失败原因
      this.importedFromJson = 0;
      this.importedJsonFile = null;
      this.importError = null;
      // 历史任务里 start_date 为空的条数（**只报告，绝不修改数据**）
      this.legacyNullStartDates = 0;
      this.schemaVersion = 0;
      this.usersIndexError = null;
      // 它是锦上添花的参考数据，失败绝不能让启动挂掉，但必须能被启动日志说出来
      this.schoolTemplateError = null;
      // 后端原语门面：**调用时**才解析「当前是哪个后端」，
      // 所以 _init() 里把 backend 从 json 改成 sqlite 也不存在时序问题。
      this._bk = makeFacade(this);
      this._init();
    }

    /**
     * 功能：决定本次运行使用哪个后端 —— 优先 `node:sqlite`（打开库文件、调 PRAGMA、迁移前备份、
     * 结构迁移、导入遗留 JSON、统计历史空起始日）；SQLite 不可用或初始化抛错时回退 JSON。
     * 库文件**本来就在**却打不开时置 `readOnly`，停止写入而不是在 JSON 上继续跑。
     *
     * 「SQLite 不可用」**包含** `require('node:sqlite')` 取不到
     */
    _init() {
      let SQLite = null;
      try {
        SQLite = require('node:sqlite');
      } catch (e) {
        // **「运行时没有 node:sqlite」也是一种「库用不了」** ——
        // 以前这里静默走 JSON 回退：应用照常起来、照常能用，只是那一轮数据写进了 JSON 文件，
        // 与用户库里的 .db 分叉，几周后才会被发现。
        this.initError = `运行时没有可用的 node:sqlite（Node ${process.version}）：${(e && e.message) || e}`;
      }
      if (SQLite && typeof SQLite.DatabaseSync !== 'function') {
        // 同一个坑的另一半：模块在、API 不在（运行时裁掉了它 / 改了形状）—— 同样是「用不了库」
        this.initError = `node:sqlite 没有提供 DatabaseSync（Node ${process.version}）—— 这个运行时用不了库`;
      }
      if (SQLite && typeof SQLite.DatabaseSync === 'function') {
        try {
          this.db = new SQLite.DatabaseSync(this.dbFile);
          this.backend = 'sqlite';
          this._tunePragmas(this.db, SCHEMA.MAIN_DB);
          this._backupBeforeMigrate(this.db, SCHEMA.MAIN_DB);
          this._migrateSqlite();
          this._importJsonIfEmpty();
          this._countLegacyNullStartDates();
          this._seedModuleData();
          // 模块自报的**幂等回填**（只往**新表**插行，⛔ 不动既有用户数据）——
          // 第一个用户是随手记：把老的 `idea_items.tags` 数组补进 `idea_tag_links`。
          this._backfillModuleData();
          // 主库活了才开记账库（它的失败**不会**把主库一起拖下水，见方法内注释）
          this._initLedgerDb(SQLite);
          // 第三个库（实验室）同款 —— 它坏也只影响它自己
          this._initLabDb(SQLite);
          this._refreshDbStatus();
          return;
        } catch (e) {
          // SQLite 初始化失败则回退 JSON。
          // 必须记录原因：若 zxdesk.db 已存在却打不开（文件损坏 / 权限不足 / 磁盘满），
          this.initError = (e && e.message) || String(e);
          try {
            if (this.db) this.db.close();
          } catch {
            /* 关闭异常忽略 */
          }
          this.db = null;
          this.backend = 'json';
          // 关键：库文件本来就在却打不开 —— 只读，不写 JSON。
          this.readOnly = this.dbExistedBefore;
        }
      } else {
        // 与上面那条 catch **同一条判据** —— 库文件本来就在、却用不了，就只读，
        // 文件本来就不存在（全新安装、运行时就是没有库能力）⇒ 没有可保护的内容，不算只读，
        // 但 `initError` 已经记下原因 ⇒ 界面与启动日志仍会照常把它说出来。
        this.readOnly = this.dbExistedBefore;
      }
      this._loadJson(SCHEMA.MAIN_DB);
      // 记账库那一份（文件不在就只是内存里的空壳，**不落盘**，见 json.js 的 `_loadJson`）
      this._loadJson(SCHEMA.LEDGER_DB);
      // 实验室库那一份（同上：文件不在时只是空壳，不落盘）
      this._loadJson(SCHEMA.LAB_DB);
      this._seedModuleData();
      this._backfillModuleData();
      this._refreshDbStatus();
    }

    /**
     * 功能：开**第二个库**（记账库）—— 转发到 `_initSideDb()`（流程与实验室库共用一份实现）。
     *
     * 「开库 / 探测 / 只读降级 / 迁移前备份 / 失败不抛」的细则见 `_initSideDb()`。
     *
     * @param {Object} SQLite - `node:sqlite` 模块（提供 `DatabaseSync`）
     */
    _initLedgerDb(SQLite) {
      this._initSideDb(SQLite, SCHEMA.LEDGER_DB);
    }

    /**
     *
     * 说明：⭐⭐ 三个库各是一个**独立的失败点**：它打不开时**只影响它自己**（实验功能 503），
     */
    _initLabDb(SQLite) {
      this._initSideDb(SQLite, SCHEMA.LAB_DB);
    }

    /**
     * 功能：开一个**非主库**（记账 / 实验室）并在它上面把结构补齐 —— 建表 ＋ 补列 ＋ 建索引 ＋
     * 写它自己的 `user_version`；迁移前先自动备份一份。
     *
     * 说明：⭐ 两个分库的流程**逐字同构**，所以只写一份、用 `dbName` 分派字段
     * （⛔ 别复制成两份：那种副本的失效方式是「改了一个忘了另一个」，而症状是**静默的**）。
     */
    _initSideDb(SQLite, dbName) {
      const onLedger = dbName === SCHEMA.LEDGER_DB;
      const file = onLedger ? this.ledgerDbFile : this.labDbFile;
      const existedBefore = onLedger ? this.ledgerExistedBefore : this.labExistedBefore;
      const connKey = onLedger ? 'ledgerDb' : 'labDb';
      try {
        this[connKey] = new SQLite.DatabaseSync(file);
        this._tunePragmas(this[connKey], dbName);
        this._backupBeforeMigrate(this[connKey], dbName);
        this._migrateSideSqlite(dbName);
      } catch (e) {
        const why = (e && e.message) || String(e);
        try {
          if (this[connKey]) this[connKey].close();
        } catch {
          /* 关闭异常忽略 */
        }
        this[connKey] = null;
        if (onLedger) {
          this.ledgerInitError = why;
          this.ledgerReadOnly = existedBefore;
        } else {
          this.labInitError = why;
          this.labReadOnly = existedBefore;
        }
      }
    }

    /**
     * 功能：在**某个分库连接**上补结构：建表 → 补列 → 建索引 → 推进它自己的 `user_version`。
     * @param {string} dbName - 库名，`'ledger'` / `'lab'`
     * @returns {void}
     * @throws {Error} 建表或补列失败时抛出（由 `_initSideDb` 收口成「那个库不可用」）
     */
    _migrateSideSqlite(dbName) {
      const onLedger = dbName === SCHEMA.LEDGER_DB;
      const conn = onLedger ? this.ledgerDb : this.labDb;
      const want = onLedger ? SCHEMA.LEDGER_SCHEMA_VERSION : SCHEMA.LAB_SCHEMA_VERSION;
      SCHEMA.createAllIn(conn, dbName);
      SCHEMA.ensureColumnsIn(dbName).forEach(([table, column, type]) =>
        this._ensureColumn(table, column, type, conn),
      );
      const indexErrors = [];
      SCHEMA.indexStatementsIn(dbName).forEach((sql) => {
        try {
          conn.exec(sql);
        } catch (e) {
          indexErrors.push((e && e.message) || String(e));
        }
      });
      // 只有上面全部跑完才写版本号（与主库「真正跑完才推进」同一条纪律）：
      // 提前写会得到一个「自认为最新、其实结构不全」的库，而下次启动不再重试。
      conn.exec(`PRAGMA user_version=${want}`);
      if (onLedger) {
        this.ledgerIndexErrors = indexErrors;
        this.ledgerSchemaVersion = want;
      } else {
        this.labIndexErrors = indexErrors;
        this.labSchemaVersion = want;
      }
    }

    /**
     * 功能：刷新**两个库的只读状态快照**（`this.dbStatus`）—— 启动日志与排查的唯一读口。
     *
     * 说明：⚠️ 只放**非敏感**信息（哪个库、什么文件、哪个后端、可用/只读、日志模式、原因），
     * 不放任何账号、条数或业务内容 —— 它会经启动日志与 `/api/health` 一类的出口露出去。
     * `ok` 的判据是「这个库能不能正常读写」：SQLite 看连接在不在且没降级只读；
     */
    _refreshDbStatus() {
      const sid = this.backend === 'sqlite';
      /** 功能：拼一个库的状态项。 */
      const item = (dbName) => {
        const onLedger = dbName === SCHEMA.LEDGER_DB;
        const onLab = dbName === SCHEMA.LAB_DB;
        const conn = onLedger ? this.ledgerDb : onLab ? this.labDb : this.db;
        // JSON 后端那一侧没有「连接」，判据换成「内存里有没有那份数据对象」——
        // 只看 `readOnly` 是不够的：数据对象为 null 时读会撞一句内部错，
        // 而状态里却写着 ok，日志与排查会一起被带偏（「日志说没事、功能一直 503」）。
        const data = onLedger ? this.ledgerData : onLab ? this.labData : this.data;
        const readOnly = onLedger ? this.ledgerReadOnly : onLab ? this.labReadOnly : this.readOnly;
        const reason = onLedger ? this.ledgerInitError : onLab ? this.labInitError : this.initError;
        const file = sid
          ? onLedger
            ? this.ledgerDbFile
            : onLab
              ? this.labDbFile
              : this.dbFile
          : onLedger
            ? this.ledgerJsonFile
            : onLab
              ? this.labJsonFile
              : this.jsonFile;
        return {
          label: onLedger ? '记账数据库' : onLab ? '实验室数据库' : '主数据库',
          file,
          backend: this.backend,
          // 不要在这里**读**数据（不查表、不数条数）：它可能在启动早期被调用（那时还没装载完）
          ok: sid ? !!conn && !readOnly : !!data && !readOnly,
          readOnly,
          journalMode: sid ? (onLedger ? this.ledgerJournalMode : onLab ? this.labJournalMode : this.journalMode) : null,
          reason: reason || null,
        };
      };
      this.dbStatus = { main: item(SCHEMA.MAIN_DB), ledger: item(SCHEMA.LEDGER_DB), lab: item(SCHEMA.LAB_DB) };
    }

    /**
     * 功能：只读地取三个库的状态快照（`{ main, ledger, lab }`）—— 供启动日志与排查用。
     * @returns {Object} 见 `_refreshDbStatus()`
     */
    _backendStatus() {
      return this.dbStatus;
    }

    /**
     * 功能：查一张表住在哪个库 —— 转给 schema 门面（**映射的唯一出处在那里**）。
     * @param {string} table - 表名
     * @returns {string} `'main'` / `'ledger'` / `'lab'`
     */
    _dbFor(table) {
      return SCHEMA.dbOf(table);
    }

    /**
     * 功能：取某张表所在的**那份数据对象**（JSON 后端的路由口）。
     * @param {string} table - 表名
     * @returns {?Object} 主库那份 `this.data`、记账库那份 `this.ledgerData`、实验室库那份 `this.labData`
     */
    _dataFor(table) {
      const db = this._dbFor(table);
      if (db === SCHEMA.LEDGER_DB) return this.ledgerData;
      if (db === SCHEMA.LAB_DB) return this.labData;
      return this.data;
    }

    /**
     * 功能：把一段动作**放到某个分库那一侧执行** —— 期间 `this.db` / `this.data` / `this.activeDb`
     * 都指向那个库，结束后一律还原（含抛错）。
     *
     * 说明：⭐⭐ 这是模块原语「一个字不用改」的全部秘密（见 `makeFacade` 的说明）：
     * 模块原语里那几十处 `this.db` / `this.data` / `this._listSql()` 因此自动落到正确的库上。
     */
    _runOnDb(dbName, fn) {
      if (dbName === SCHEMA.LAB_DB) this._assertLabWritable();
      else this._assertLedgerWritable();
      const prevDb = this.db;
      const prevData = this.data;
      const prevActive = this.activeDb;
      this.db = dbName === SCHEMA.LAB_DB ? this.labDb : this.ledgerDb;
      this.data = dbName === SCHEMA.LAB_DB ? this.labData : this.ledgerData;
      this.activeDb = dbName;
      try {
        return fn();
      } finally {
        this.db = prevDb;
        this.data = prevData;
        this.activeDb = prevActive;
      }
    }

    /**
     * 功能：播种**模块自带的只读内置数据** —— 现在只有课表的「内置高校模板」两张表。
     *
     * `modules/timetable/`**，所以这里必须**可选**地调用 —— 模块被删掉时那个方法不存在。
     * 在「删目录验收」时是 `TypeError: this.seedSchoolTemplates is not a function`，
     * 应用**根本起不来** —— 验收第 ① 条（照常启动）当场失败，后面几条压根轮不到验。
     */
    _seedModuleData() {
      if (typeof this.seedSchoolTemplates === 'function') this.seedSchoolTemplates();
    }

    /**
     * 功能：跑一遍各模块自报的**幂等回填** —— 把老结构里的数据补进本版新增的表里。
     *
     * 结构迁移在 `schema.js` 里声明、由 `_migrateSqlite()` 跑；而「老数据搬到新表」要按
     * **业务语义**做（这里是「把 `idea_items.tags` 那个 JSON 数组拆成标签行 ＋ 关联行」），
     * schema 声明表达不了 ⇒ 由模块提供一个**业务方法**，这里可选地伸手叫一次。
     */
    _backfillModuleData() {
      if (typeof this.backfillIdeaTagLinks === 'function') this.backfillIdeaTagLinks();
    }

    /**
     * 功能：写闸门 —— 数据层处于只读降级时抛出带 `status = 503` 的错误（由 HTTP 层收口成 503），
     * @returns {void}
     * @throws {Error} 只读降级时抛出，`err.status` 为 503
     */
    _assertWritable() {
      if (this.readOnly) {
        const err = new Error(
          '数据层已降级为只读：SQLite 数据库打不开（原因见启动日志），为避免出现两套数据已停止写入。修好后重启应用即可恢复。',
        );
        err.status = 503;
        throw err;
      }
    }

    /**
     * 功能：**记账库**的写闸门 —— 第二个库不可用（打不开 / 已降级只读）时抛出带 `status = 503`
     *
     * `_assertLedgerWritable`）；实现与实验室库共用 `_assertSideWritable()`。
     *
     * @returns {void}
     */
    _assertLedgerWritable() {
      this._assertSideWritable(SCHEMA.LEDGER_DB);
    }

    /**
     *
     * 说明：⭐⭐ 这是「实验室可失败」这条硬指标的**执行点**：它坏的时候只有实验功能停摆，
     */
    _assertLabWritable() {
      this._assertSideWritable(SCHEMA.LAB_DB);
    }

    /**
     * 功能：**某个分库**的写闸门（记账 / 实验室共用一份实现）。
     *
     * 说明：⭐⭐ 为什么必须是**独立的一道闸门**（不是复用 `_assertWritable()`）：三个库有三个失败点，
     * 「主库可写」**完全不代表**分库可写 —— 主库健康、某个分库文件损坏时，
     * 如果只检查主库，那一路的每一次写入都会撞一个 null 句柄
     */
    _assertSideWritable(dbName) {
      const onLedger = dbName === SCHEMA.LEDGER_DB;
      const label = onLedger ? '记账数据库' : '实验室数据库';
      const handle = onLedger ? this.ledgerDb : this.labDb;
      const data = onLedger ? this.ledgerData : this.labData;
      const readOnly = onLedger ? this.ledgerReadOnly : this.labReadOnly;
      const initError = onLedger ? this.ledgerInitError : this.labInitError;
      // SQLite：句柄都没拿到（打不开 / 主库失败时没去开）⇒ 不可用
      const missing = this.backend === 'sqlite' ? !handle : !data;
      if (missing || readOnly) {
        const why = initError || (readOnly ? '数据库文件存在却打不开' : '第三个库没有打开');
        const err = new Error(
          `${label}当前不可用（${why}）—— 为避免出现两套数据，${onLedger ? '记账' : '实验室'}相关的读写都已停止。` +
            '其余功能不受影响；请检查数据目录权限/归属（zxdesk:zxdesk）与磁盘空间，修好后重启应用即可恢复。',
        );
        err.status = 503;
        throw err;
      }
    }

    /**
     * 功能：取通用 `_update()` 的列白名单 —— 由「定义这张表的人」在 schema 模块里自报，这里只转发查询。
     *
     * 说明：⚠️ 语义与改造前逐字一致：**查不到的表返回 `[]`**（= 不可通用更新），绝不返回「全部列」。
     * 所以「新表忘了登记」的表现依旧是「改不动」而不是「什么都能改」——失败方向是安全的。
     *
     */
    _allowedCols(table) {
      return SCHEMA.allowedCols(table);
    }
  }

  const legacyMethodModules = [
    // 这一串是**尚未搬进 `app/modules/` 的模块**的业务方法 —— 搬完一个就从这里删掉它那一行
    // 标签写的是**真实文件名**（不是序号）：撞名抛错时要能一眼看出是哪两个来源。
    // `projects.js` 与 `tasks.js` **已随任务板搬进 `modules/tasks/lib/`**，
    ['./methods/task-writes.js', require('./methods/task-writes.js')],
    ['./methods/stats.js', require('./methods/stats.js')],
    ['./methods/users.js', require('./methods/users.js')],
    ['./methods/admin.js', require('./methods/admin.js')],
    ['./methods/backup.js', require('./methods/backup.js')],
    ['./methods/migrate.js', require('./methods/migrate.js')],
    // 个人授权目录（跨模块：设置页汇总 ＋ 加密信息选目录）
    ['./methods/grants.js', require('./methods/grants.js')],
    // `modules/teamwork/store.js`** —— 由上面的注册表聚合，这里那一行已删。
    // 同样由注册表聚合，这里那一行已删。
  ];

  // 新增：**装配期撞名护栏** —— 各来源的业务方法名必须两两不重名。
  //
  // 为什么要它：`Object.assign` 把各来源**平铺到同一个原型**上，两个来源各写一个同名方法时
  assertNoMethodClash([
    // 模块化重构：**已搬迁模块的业务方法**由注册表聚合（`modules/<name>/store.js`）。
    // 搬走一个模块，它那一行就从上面那串手写 require 里删掉 —— **不用改这里**
    ...registry.list.map((m) => [`modules/${m.name}/store.js`, registry.storeFor(m.name)]).filter(([, mod]) => mod),
    ...legacyMethodModules,
  ]);

  Object.assign(
    Store.prototype,
    sqlite.methods,
    json.methods,
    ...registry.list.map((m) => registry.storeFor(m.name)).filter(Boolean),
    ...legacyMethodModules.map(([, mod]) => mod),
  );

  return Store;
}

module.exports = { makeStore };
