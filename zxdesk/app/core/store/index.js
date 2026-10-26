'use strict';
/**
 * core/store/index.js —— Store 的**装配点**（0.2.0，审查报告 B2）
 *
 * 功能：`makeStore(APP_VERSION)` 返回组装好的 `Store` 类；类内负责状态字段初始化、`_init()` 的后端选择
 *      （SQLite 优先、失败降级 JSON、库文件本来就在却打不开时转只读）、写闸门 `_assertWritable()`、
 *      列白名单 `_allowedCols()`，最后把两个后端与六个业务模块的方法挂到原型上。
 *      `makeFacade()` 生成 `_bk` 门面，按**调用时刻**的 `store.backend` 转发到对应后端原语。
 *
 * ⭐ **0.8.1（记账 2 期）：core 同时开两个库**——
 *    主库 `zxdesk.db`（`zxdesk.json`）＋ 记账库 `zxdesk-ledger.db`（`zxdesk-ledger.json`）。
 *    两个库**各自**开库 / WAL 探测 / 只读降级 / 结构体检 / 迁移前备份（见 `_init` 与 `_initLedgerDb`）。
 *    「表 → 库」的映射**只有一个出处**（`store/schema/index.js` 的 `dbOf()`，来源是各模块
 *    `module.json` 的 `database` 字段）；路由点是 `makeFacade()` 生成的 `_bk` 门面
 *    —— 属于记账模块的原语在 `_runOnLedger()` 里把 `this.db` / `this.data` 切到记账库那一侧，
 *    于是**模块自己的原语一个字都不用改**。
 *    ⚠️ 跨库的那几件事（删账号 / 整体备份 / 整体恢复 / 个人导入）**没有单一事务兜底**了：
 *    它们改成两段执行 ＋ 如实报告，理由与失败方向写在两个后端各自的 `deleteUser()` /
 *    `exportWhole()` / `replaceWhole()` / `insertMany()` 上。
 *
 * 改造前是 2376 行的单类 `db.js`。现在：
 *   backend/sqlite.js  SQLite 生命周期 + 50 个后端原语 op
 *   backend/json.js    JSON 回退生命周期 + 同名同参的 50 个 op
 *   methods/*.js       业务方法（**不再出现 `this.backend`**）
 *   本文件             构造函数 / _init / 写闸门 / 列白名单 / 装配
 *
 * ⭐ 业务方法一律写 `this._bk.<op>(...)`。
 *    `_bk` 是**门面**（facade），每次调用才决定转发到哪个后端 —— 而不是构造时绑定：
 *    `_init()` 会在初始化过程中把 `backend` 从 'json' 改成 'sqlite'，构造时绑死就会绑错。
 *
 * ⭐ 为什么 `APP_VERSION` 由外面传进来（`makeStore(APP_VERSION)`）：
 *    版本号必须是**仓库里唯一一个字面量**，而 `ttt/tools/sync-version.js` 与
 *    `ttt/tools/verify-package.js` 都盯在 `storage.js` 上（铁律 2）。所以字面量留在 storage.js，
 *    这里只接收并使用；代码里改读 `this.appVersion`。
 *
 * ⚠️ 构造函数 / `_init` / `_assertWritable` / `_allowedCols` / `_sessionSig` 的方法体
 *    是从改造前的 `db.js` **按字节切出来的**。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.15
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
 * ⭐ 0.8.1（记账 2 期）：**第二个库**的文件名 —— 记账模块的全部表住它。
 *
 * 说明：⭐ 库名在这里**各自写一次**（主库那两行在构造函数里）。它们与
 *      `SCHEMA.LEDGER_DB`（映射里用的「库名」）是两件事：这里是**文件名**，那里是**库标识**。
 *      ⚠️ 文件名一旦改，用户机器上已有的第二个库就会「消失」（表现为记账数据全没了）——
 *      与 `zxdesk.db` / `zxdesk.json` 同一条纪律：⛔ 不许改名。
 */
const LEDGER_DB_FILE = 'zxdesk-ledger.db';
const LEDGER_JSON_FILE = 'zxdesk-ledger.json';

/**
 * 功能：装配期护栏 —— 各来源的业务方法名必须两两不重名，重名**当场抛错**并点名是哪两个来源。
 *
 * 说明：⚠️ 为什么必须是**硬失败**而不是「后者覆盖前者 + 打个日志」：`Object.assign` 的覆盖是
 *      **静默**的，而它的后果（某一屏点不开、某个接口 500）离原因非常远，排查代价极高。
 *      这与 `store/backend/index.js` 的 `assertOpsContract()`、`modules/registry.js` 的
 *      契约自检是同一个哲学：**契约在加载时兑现，一律启动即抛**（方案 §十一）。
 *
 * ⚠️ 只检查**业务方法来源**，调用方负责别把两个后端的对等方法表传进来（见调用处的说明）。
 *
 * @param {Array.<[string, Object]>} sources - `[来源标签, 方法表]` 数组（顺序即 `Object.assign` 的顺序）
 * @returns {void}
 * @throws {Error} 同一个方法名出现在两个来源里时抛出（错误信息里带两个来源标签）
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
 * 说明：⭐⭐ 0.8.1 的多库分派就落在这里。为什么按**模块**而不是按「原语第几个参数是表名」判：
 *      模块原语的参数是业务形状（`listLedgerAccounts(uid)`、`insertLedgerAccount(uid, values, stamp)`），
 *      **看不出表名**；而「哪个模块的 op 读写哪个库」是模块自己已经在 `module.json` 里声明过的事实
 *      （`database: 'ledger'`），拿它来分派**不需要模块改一个字**（方案 §5.1 第 3 行的口径）。
 *      ⚠️ 只收**声明了进记账库**的模块；主库是缺省（`SCHEMA.dbOf()` 的失败方向也是主库），
 *      所以这里是一个「记账库 op 的名单」，不是全量映射。
 *      ⚠️ 从两个后端各取一次键（它们必须同名同参，由 `assertOpsContract()` 在加载时钉住），
 *      所以这里取哪一份结果都一样 —— 取两份只是顺手，万一将来出现「只在一边挂着的 op」，
 *      它也会被点名进名单，而不是静默走主库。
 *
 * @returns {Map.<string, string>} op 名 → `'ledger'`
 */
function ledgerOpsOf() {
  const map = new Map();
  for (const meta of registry.list) {
    if (meta.database !== SCHEMA.LEDGER_DB) continue;
    const pair = registry.backendFor(meta.name);
    if (!pair) continue;
    for (const mod of [pair.sqlite, pair.json]) {
      for (const k of Object.keys((mod && mod.ops) || {})) map.set(k, SCHEMA.LEDGER_DB);
    }
  }
  return map;
}

/**
 * 功能：按 `OPS` 逐个生成转发函数，组成后端原语门面 —— 每个转发函数在**调用时**才读
 *      `store.backend`，再调用同名 op；⭐ 属于记账库的原语额外切到第二个连接/第二份数据上执行。
 *
 * 说明：这样 `_init()` 内部（例如 `_importJsonIfEmpty` 会用到 `_insert`）也能安全使用。
 *      ⚠️ 取函数的表是 `MERGED_OPS`（**旧的大文件 + 已搬迁模块自己的一对**合起来）——
 *      0.5.0之前这里写的是 `sqlite.ops` / `json.ops`，那**只认那两个大文件**，
 *      模块把 op 搬走之后就会 `Cannot read properties of undefined (reading 'apply')`。
 *
 * ⭐ 0.8.1 的多库分派：**门面是唯一的切换点** ——
 *    业务层（`modules/<模块>/store.js`）与模块自己的原语**一个字都不用改**：模块原语里照旧写
 *    `this.db` / `this.data` / `this._listSql()`，只是在「记账模块的 op 正在跑」这段时间里，
 *    `this.db` / `this.data` 已经指向记账库那一侧（由 `Store._runOnLedger()` 切换并在 finally 里还原）。
 *    ⚠️ 为什么不是「让每个 op 自己挑连接」：模块原语有几十处 `this.db`，改它们等于把
 *    「记账 2 期」的变成一次跨 10 个模块的大改；而**分派点只有这一个**，
 *    改错的爆炸半径也集中在一处（这正是方案 §5.1 第 3 行要的形态）。
 *
 * @param {Object} store - Store 实例；转发时以它作为 op 的 `this`
 * @returns {Object} 属性名与后端原语 op 一一对应的门面对象
 */
function makeFacade(store) {
  const ledgerOps = ledgerOpsOf();
  const facade = {};
  for (const k of OPS) {
    const onLedger = ledgerOps.get(k) === SCHEMA.LEDGER_DB;
    facade[k] = (...args) => {
      const fn = (store.backend === 'sqlite' ? MERGED_OPS.sqlite : MERGED_OPS.json)[k];
      if (!onLedger) return fn.apply(store, args);
      return store._runOnLedger(() => fn.apply(store, args));
    };
  }
  return facade;
}

/**
 * 功能：接收版本号并装配出 `Store` 类 —— 定义状态字段与构造函数、`_init` / `_assertWritable` /
 *      `_allowedCols`，再把两个后端与六个业务模块的方法挂到原型上。
 *
 * 说明：⚠️ 构造函数 / `_init` / `_assertWritable` / `_allowedCols` / `_sessionSig` 的方法体
 *      是从改造前的 `db.js` **按字节切出来的**。
 *
 * @param {string} APP_VERSION - 由 `storage.js` 传入的版本号唯一字面量
 * @returns {Function} 组装完成的 `Store` 类
 */
function makeStore(APP_VERSION) {
  class Store {
    /**
     * 功能：初始化实例的全部状态字段（数据目录、库文件路径、后端标记、迁移与备份记录、各类错误原因），
     *      创建 `_bk` 后端门面，最后调用 `_init()` 完成连接与数据装载。
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
      // ⭐ 0.8.1：第二个库（记账模块的全部表）—— 四个格子里「文件路径」的两个
      this.ledgerDbFile = path.join(dataDir, LEDGER_DB_FILE);
      this.ledgerJsonFile = path.join(dataDir, LEDGER_JSON_FILE);
      this.backend = 'json';
      this.db = null;
      this.data = null;
      // ⭐ 0.8.1：记账库那一侧的两个句柄（SQLite 第二个连接 / JSON 第二个数据对象）
      this.ledgerDb = null;
      this.ledgerData = null;
      this.journalMode = null;
      // ⭐ 0.8.1：记账库自己的 WAL 探测结果 / 结构版本 / 建索引失败原因（与主库那三个同款、各数各的）
      this.ledgerJournalMode = null;
      this.ledgerSchemaVersion = 0;
      this.ledgerIndexErrors = [];
      // ⭐ 0.8.1：当前正在服务哪个库（`'main'` / `'ledger'`）—— 只有门面切换时才会变成 ledger，
      //    它决定 `_saveJson()` 不带参数时该落哪个文件（见 json.js 的 `_saveJson`）
      this.activeDb = SCHEMA.MAIN_DB;
      // ⭐ 0.8.1：记账库打不开的原因 / 只读降级（语义与主库那两个逐条对应）
      this.ledgerInitError = null;
      this.ledgerReadOnly = false;
      // 记账库文件在本次启动**之前**是否已存在：决定「打不开时是否降级只读」与「迁移前是否备份」
      this.ledgerExistedBefore = fs.existsSync(this.ledgerDbFile);
      // ⭐ 0.8.1：两个库的**只读状态快照**（启动日志与排查用，字段见 `_refreshDbStatus()`）
      this.dbStatus = { main: null, ledger: null };
      // v5：外键是否真的打开了（SQLite 默认关闭，必须每个连接显式开）
      this.foreignKeys = false;
      // 本次启动是否需要结构迁移（由 _backupBeforeMigrate 依 user_version 判定）
      this.needsMigrate = false;
      // v5 结构升级被跳过的原因（不为 null 时 user_version **不推进**，下次启动重试；由启动日志告警）
      this.schemaUpgradeSkipped = null;
      // v5 结构升级成功的记录：{ from, to, normalized }
      this.structuralUpgrade = null;
      // 0.1.2 改名迁移的结果（"旧 → 新"）与冲突（新名字已被占，跳过）
      this.renamedTables = [];
      this.tableAliasConflicts = [];
      // ⭐ 0.8.12 列改名迁移的结果（"表.旧列 → 新列"）—— 与 renamedTables 同一套机制的第二档
      this.renamedColumns = [];
      // JSON 文件里被改名的键（老 zxdesk.json 加载时）
      this.renamedJsonKeys = [];
      // 建索引失败的原因（索引只是加速手段，失败不上抛；由启动日志告警）
      this.indexErrors = [];
      this.initError = null;
      // 库文件在本次启动**之前**是否已存在：决定「打不开时是否降级只读」与「迁移前是否备份」
      this.dbExistedBefore = fs.existsSync(this.dbFile);
      // 只读降级：库文件存在却打不开时置 true —— 绝不在 JSON 上继续写，否则两套数据永久分裂
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
      // username 唯一索引建立失败的原因（历史脏数据导致；正常为 null）
      this.usersIndexError = null;
      // ⭐ 内置高校模板播种失败的原因（0.3.5；正常为 null）—— 与 indexErrors 同一个哲学：
      //    它是锦上添花的参考数据，失败绝不能让启动挂掉，但必须能被启动日志说出来
      this.schoolTemplateError = null;
      // ⭐ 后端原语门面：**调用时**才解析「当前是哪个后端」，
      //    所以 _init() 里把 backend 从 json 改成 sqlite 也不存在时序问题。
      this._bk = makeFacade(this);
      this._init();
    }

    /**
     * 功能：决定本次运行使用哪个后端 —— 优先 `node:sqlite`（打开库文件、调 PRAGMA、迁移前备份、
     *      结构迁移、导入遗留 JSON、统计历史空起始日）；SQLite 不可用或初始化抛错时回退 JSON。
     *      库文件**本来就在**却打不开时置 `readOnly`，停止写入而不是在 JSON 上继续跑。
     *
     * ⭐ 0.8.9：「SQLite 不可用」**包含** `require('node:sqlite')` 取不到
     *      （换运行时之后最可能的那一种）—— 它同样写 `initError`、同样（库文件本来就在时）
     *      只读降级。⛔ 这一条**不许再退回静默**：静默的形态是「应用照常好用、数据写进了
     *      JSON，与用户的 .db 分叉」，几周后才发现。
     *
     * ⭐ 0.8.1：主库起来之后**再开第二个库**（记账库）—— 两个库各自
     *      WAL 探测 / 只读降级 / 结构体检 / 迁移前备份（见 `_initLedgerDb`）。
     *      ⚠️⭐ **任一库打不开都只影响它自己**，但**主库打不开时不去开记账库**：
     *      那种情况下整个数据层已经退到 JSON 上跑（主库只读、界面显示的不是库里的内容），
     *      这时再单独把记账库按 SQLite 打开，就成了「一个在后端 A、一个在后端 B」的
     *      双重降级 —— 那种状态没有任何人验证过，宁可让它与主库一起退（两库语义一致）。
     *
     * @returns {void}
     */
    _init() {
      let SQLite = null;
      try {
        SQLite = require('node:sqlite');
      } catch (e) {
        // ⭐ 0.8.9：**「运行时没有 node:sqlite」也是一种「库用不了」** ——
        //    以前这里静默走 JSON 回退：应用照常起来、照常能用，只是那一轮数据写进了 JSON 文件，
        //    与用户库里的 .db 分叉，几周后才会被发现。
        //    把它记进 initError ⇒ 启动日志与界面都会照常报出来，与「库文件损坏」同一条出口。
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
          // ⭐ 内置高校模板（0.3.5）：建表之后、应用起来之前，把数据源同步进两张内置表。
          //    放最后是因为它是**唯一不碰用户数据**的一步 —— 前面任何一步失败都不该被它掩盖。
          this._seedModuleData();
          // ⭐ 0.8.15：模块自报的**幂等回填**（只往**新表**插行，⛔ 不动既有用户数据）——
          //    第一个用户是随手记：把老的 `idea_items.tags` 数组补进 `idea_tag_links`。
          this._backfillModuleData();
          // ⭐ 0.8.1：主库活了才开记账库（它的失败**不会**把主库一起拖下水，见方法内注释）
          this._initLedgerDb(SQLite);
          this._refreshDbStatus();
          return;
        } catch (e) {
          // SQLite 初始化失败则回退 JSON。
          // 必须记录原因：若 zxdesk.db 已存在却打不开（文件损坏 / 权限不足 / 磁盘满），
          // 静默回退到空 JSON 会让界面看起来「数据全没了」或「数据变回旧样」——启动日志与界面都要说清楚。
          this.initError = (e && e.message) || String(e);
          try {
            if (this.db) this.db.close();
          } catch {
            /* 关闭异常忽略 */
          }
          this.db = null;
          this.backend = 'json';
          // 关键：库文件本来就在却打不开 —— 只读，不写 JSON。
          // 否则用户看到的是 JSON 里的旧快照，此后新增/修改又都进了 JSON，
          // 等 SQLite 恢复后「数据又变回去」，这正是「卸载重装后任务变了」的成因之一。
          this.readOnly = this.dbExistedBefore;
        }
      } else {
        // ⭐ 0.8.9：与上面那条 catch **同一条判据** —— 库文件本来就在、却用不了，就只读，
        //    ⛔ 绝不把用户数据写进 JSON（那正是两套数据分裂的经典形态，见上面的注释）。
        //    文件本来就不存在（全新安装、运行时就是没有库能力）⇒ 没有可保护的内容，不算只读，
        //    但 `initError` 已经记下原因 ⇒ 界面与启动日志仍会照常把它说出来。
        this.readOnly = this.dbExistedBefore;
      }
      this._loadJson(SCHEMA.MAIN_DB);
      // ⭐ 0.8.1：记账库那一份（文件不在就只是内存里的空壳，**不落盘**，见 json.js 的 `_loadJson`）
      this._loadJson(SCHEMA.LEDGER_DB);
      // ⭐ 内置高校模板：JSON 回退路径同样要播种（两端行为一致，否则「装的是哪个后端、模板就不一样」）
      this._seedModuleData();
      this._backfillModuleData();
      this._refreshDbStatus();
    }

    /**
     * 功能：开**第二个库**（记账库）并在它上面把结构补齐 —— 建表 ＋ 补列 ＋ 建索引 ＋ 写它自己的
     *      `user_version = LEDGER_SCHEMA_VERSION`；迁移前先自动备份一份。
     *
     * 说明：⭐ 与主库**各自**做一遍：两个库各判自己的版本、各留自己的退路。
     *      ⚠️⭐ 记账库**刻意没有 v5 那一整套整库重建迁移**（`_upgradeStructureToV5` / `_v5Precheck` /
     *      `_applyTableAliases` 一个都不调用）：它是全新的库，没有历史结构要补、没有表要改名 ——
     *      照搬主库那套只会引入一次毫无意义的 DROP + RENAME（而它的收益是零）。
     *      将来记账库真要改结构，走的是「加表 / 加列 / 加索引」这三条幂等路径。
     *      ⚠️ 建索引**逐条 try/catch**（与主库 `_createIndexes()` 同一口径）：索引只是加速手段，
     *      建不上绝不能让整个记账库被判成「打不开」—— 那会把记账功能整个停掉，代价远大于少一个索引。
     *      ⚠️ **失败不抛**：本方法自己把原因记进 `ledgerInitError` 并把记账库标成不可用
     *      （`ledgerDb = null` ＋ 文件存在时 `ledgerReadOnly = true`），主库照常可用。
     *      这与「主库打不开就整体降级」刻意不同：两个库的可用性互不牵连，但**都要被说出来**
     *      （启动日志与 `dbStatus`，见 `_refreshDbStatus()`）。
     *
     * @param {Object} SQLite - `node:sqlite` 模块（提供 `DatabaseSync`）
     * @returns {void}
     */
    _initLedgerDb(SQLite) {
      try {
        this.ledgerDb = new SQLite.DatabaseSync(this.ledgerDbFile);
        this._tunePragmas(this.ledgerDb, SCHEMA.LEDGER_DB);
        this._backupBeforeMigrate(this.ledgerDb, SCHEMA.LEDGER_DB);
        this._migrateLedgerSqlite();
      } catch (e) {
        this.ledgerInitError = (e && e.message) || String(e);
        try {
          if (this.ledgerDb) this.ledgerDb.close();
        } catch {
          /* 关闭异常忽略 */
        }
        this.ledgerDb = null;
        // ⚠️ 与主库同一条判据：文件**本来就在**却打不开 ⇒ 只读（⛔ 不许改写成 zxdesk-ledger.json，
        //    否则等记账库修好后「数据又变回去」—— 那正是两套数据分裂的经典形态）。
        //    文件本来就不存在（全新安装、建不出来的极端情况）⇒ 没有可保护的内容，不算只读，
        //    但 `ledgerDb` 为 null 已经足够让 `_assertLedgerWritable()` 拒绝一切记账写读。
        this.ledgerReadOnly = this.ledgerExistedBefore;
      }
    }

    /**
     * 功能：在**记账库连接**上补结构：建表 → 补列 → 建索引 → 推进它自己的 `user_version`。
     * @returns {void}
     * @throws {Error} 建表或补列失败时抛出（由 `_initLedgerDb` 收口成「记账库不可用」）
     */
    _migrateLedgerSqlite() {
      SCHEMA.createAllIn(this.ledgerDb, SCHEMA.LEDGER_DB);
      SCHEMA.ensureColumnsIn(SCHEMA.LEDGER_DB).forEach(([table, column, type]) =>
        this._ensureColumn(table, column, type, this.ledgerDb),
      );
      this.ledgerIndexErrors = [];
      SCHEMA.indexStatementsIn(SCHEMA.LEDGER_DB).forEach((sql) => {
        try {
          this.ledgerDb.exec(sql);
        } catch (e) {
          this.ledgerIndexErrors.push((e && e.message) || String(e));
        }
      });
      // ⚠️ 只有上面全部跑完才写版本号（与主库「真正跑完才推进」同一条纪律）：
      //    提前写会得到一个「自认为最新、其实结构不全」的库，而下次启动不再重试。
      this.ledgerDb.exec(`PRAGMA user_version=${SCHEMA.LEDGER_SCHEMA_VERSION}`);
      this.ledgerSchemaVersion = SCHEMA.LEDGER_SCHEMA_VERSION;
    }

    /**
     * 功能：刷新**两个库的只读状态快照**（`this.dbStatus`）—— 启动日志与排查的唯一读口。
     *
     * 说明：⚠️ 只放**非敏感**信息（哪个库、什么文件、哪个后端、可用/只读、日志模式、原因），
     *      ⛔ 不放任何账号、条数或业务内容 —— 它会经启动日志与 `/api/health` 一类的出口露出去。
     *      ⚠️ `ok` 的判据是「这个库能不能正常读写」：SQLite 看连接在不在且没降级只读；
     *      JSON 看主库有没有因打不开而降级（JSON 后端没有「连接」这个概念）。
     *
     * @returns {void}
     */
    _refreshDbStatus() {
      const sid = this.backend === 'sqlite';
      /** 功能：拼一个库的状态项。 */
      const item = (dbName) => {
        const ledger = dbName === SCHEMA.LEDGER_DB;
        const conn = ledger ? this.ledgerDb : this.db;
        // JSON 后端那一侧没有「连接」，判据换成「内存里有没有那份数据对象」——
        // ⚠️ 只看 `readOnly` 是不够的：`ledgerData` 为 null 时读会撞一句内部错，
        // 而状态里却写着 ok，日志与排查会一起被带偏（「日志说没事、功能一直 503」）。
        const data = ledger ? this.ledgerData : this.data;
        const readOnly = ledger ? this.ledgerReadOnly : this.readOnly;
        const reason = ledger ? this.ledgerInitError : this.initError;
        const file = sid ? (ledger ? this.ledgerDbFile : this.dbFile) : ledger ? this.ledgerJsonFile : this.jsonFile;
        return {
          label: ledger ? '记账数据库' : '主数据库',
          file,
          backend: this.backend,
          // ⛔ 不要在这里**读**数据（不查表、不数条数）：它可能在启动早期被调用（那时还没装载完）
          ok: sid ? !!conn && !readOnly : !!data && !readOnly,
          readOnly,
          journalMode: sid ? (ledger ? this.ledgerJournalMode : this.journalMode) : null,
          reason: reason || null,
        };
      };
      this.dbStatus = { main: item(SCHEMA.MAIN_DB), ledger: item(SCHEMA.LEDGER_DB) };
    }

    /**
     * 功能：只读地取两个库的状态快照（`{ main, ledger }`）—— 供启动日志与排查用。
     * @returns {Object} 见 `_refreshDbStatus()`
     */
    _backendStatus() {
      return this.dbStatus;
    }

    /**
     * 功能：查一张表住在哪个库 —— 转给 schema 门面（**映射的唯一出处在那里**）。
     * @param {string} table - 表名
     * @returns {string} `'main'` / `'ledger'`
     */
    _dbFor(table) {
      return SCHEMA.dbOf(table);
    }

    /**
     * 功能：取某张表所在的**那份数据对象**（JSON 后端的路由口）。
     * @param {string} table - 表名
     * @returns {?Object} 主库那份 `this.data`，或记账库那份 `this.ledgerData`
     */
    _dataFor(table) {
      return this._dbFor(table) === SCHEMA.LEDGER_DB ? this.ledgerData : this.data;
    }

    /**
     * 功能：把一段动作**放到来记账库那一侧执行** —— 期间 `this.db` / `this.data` / `this.activeDb`
     *      都指向记账库，结束后一律还原（含抛错）。
     *
     * 说明：⭐⭐ 这是模块原语「一个字不用改」的全部秘密（见 `makeFacade` 的说明）：
     *      模块原语里那几十处 `this.db` / `this.data` / `this._listSql()` 因此自动落到记账库上。
     *      ⚠️ 进门前必须先过 `_assertLedgerWritable()`：记账库不可用时**读也不许装作能读**
     *      （读会撞 null 句柄、JSON 那边会读到一个空壳 ⇒ 界面显示「记账数据全没了」，
     *      而真相是「这个库打不开」—— 必须让 503 把它说出来）。
     *      ⚠️ 用 try/finally 还原，**不是**「成功了还原、失败了不管」：一旦失败后没还原，
     *      后面所有主库操作都会打到记账库上（那种串库是最难查的一类事故）。
     *
     * @param {Function} fn - 要在记账库那一侧执行的动作
     * @returns {*} `fn` 的返回值
     * @throws {Error} 记账库不可用时抛 503（由 HTTP 层收口）
     */
    _runOnLedger(fn) {
      this._assertLedgerWritable();
      const prevDb = this.db;
      const prevData = this.data;
      const prevActive = this.activeDb;
      this.db = this.ledgerDb;
      this.data = this.ledgerData;
      this.activeDb = SCHEMA.LEDGER_DB;
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
     * 说明：⭐ 0.5.0：那两张内置表与它们的播种方法（`seedSchoolTemplates`）**都属于
     *      `modules/timetable/`**，所以这里必须**可选**地调用 —— 模块被删掉时那个方法不存在。
     *      ⛔ **不许改成硬 require、也不许去掉 `typeof` 判断**：直接 `this.seedSchoolTemplates()`
     *      在「删目录验收」时是 `TypeError: this.seedSchoolTemplates is not a function`，
     *      应用**根本起不来** —— 验收第 ① 条（照常启动）当场失败，后面几条压根轮不到验。
     *      这是与 `server.js` 的 `moduleHook()` 同一条硬规矩：**核心对模块只能单向、可选地伸手**。
     *
     * @returns {void}
     */
    _seedModuleData() {
      if (typeof this.seedSchoolTemplates === 'function') this.seedSchoolTemplates();
    }

    /**
     * 功能：跑一遍各模块自报的**幂等回填** —— 把老结构里的数据补进本版新增的表里。
     *
     * 说明：⭐⭐ 0.8.15：这一档与 `ensureColumns` 那类**结构**迁移不是一回事 ——
     *      结构迁移在 `schema.js` 里声明、由 `_migrateSqlite()` 跑；而「老数据搬到新表」要按
     *      **业务语义**做（这里是「把 `idea_items.tags` 那个 JSON 数组拆成标签行 ＋ 关联行」），
     *      schema 声明表达不了 ⇒ 由模块提供一个**业务方法**，这里可选地伸手叫一次。
     *      ⚠️⭐ 与 `_seedModuleData()` **逐字同一条规矩**：只能 `typeof` 守卫着调，⛔ 不许硬 require
     *      模块文件、⛔ 不许去掉那个判断 —— 模块目录被删掉时（「删目录验收」）少了它应用会当场起不来。
     *      ⚠️ 回填的两条硬约束（由模块那份方法自己保证，见 `modules/idea/store.js`）：
     *      ① **只往新表插行**，⛔ 绝不改写既有用户数据；② **幂等**（重复启动不产生第二份）。
     *      ⚠️⚠️ 第三条同样硬：**那份方法绝不许抛** —— 它跑在 `_init()` 的 SQLite `try` 里，
     *      抛出去会被当成「库打不开」⇒ **整个数据层降级成只读**（一个回填小毛病换来「应用不能写」，
     *      代价完全不成比例）。失败就把原因记进一个字段（照 `timetable` 的 `schoolTemplateError`）
     *      然后**正常返回**。⛔ 别指望这里替你兜 —— 这里的 `typeof` 只管「模块在不在」。
     *      ⚠️ 它是**可选**的：模块没提供这个方法（或还没实现）时什么都不做，启动照常。
     *
     * @returns {void}
     */
    _backfillModuleData() {
      if (typeof this.backfillIdeaTagLinks === 'function') this.backfillIdeaTagLinks();
    }

    /**
     * 功能：写闸门 —— 数据层处于只读降级时抛出带 `status = 503` 的错误（由 HTTP 层收口成 503），
     *      否则直接返回，允许调用方继续写。
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
     *      的错误，错误信息里点名**是哪个库、什么原因**；否则直接返回。
     *
     * 说明：⭐⭐ 为什么必须是**独立的一道闸门**：两个库有两个失败点，
     *      「主库可写」**完全不代表**「记账库可写」—— 主库健康、记账库文件损坏时，
     *      如果只检查主库，记账的每一次写入都会撞一个 null 句柄（`Cannot read properties of null`），
     *      用户看到的是 500 与「内部错误」，而真正的原因（这个文件打不开）一个字都没说。
     *      ⇒ 记账这一侧的每个原语（门面在 `_runOnLedger()` 里先过它）都要能被它拦下。
     *      ⚠️ **读也走它**：库打不开时「读」不是「读到空」而是「根本读不了」——
     *      返回空列表会让界面显示「记账数据全没了」，那比一句 503 糟得多。
     *      ⚠️ 文案与 `_assertWritable()` 同一条口径：说清「哪个库、为什么、怎么办」，不抛内部英文。
     *
     * @returns {void}
     * @throws {Error} 记账库不可用时抛出，`err.status` 为 503
     */
    _assertLedgerWritable() {
      // SQLite：句柄都没拿到（打不开 / 主库失败时没去开）⇒ 不可用
      const missing = this.backend === 'sqlite' ? !this.ledgerDb : !this.ledgerData;
      if (missing || this.ledgerReadOnly) {
        const why = this.ledgerInitError || (this.ledgerReadOnly ? '数据库文件存在却打不开' : '第二个库没有打开');
        const err = new Error(
          `记账数据库当前不可用（${why}）—— 为避免出现两套数据，记账相关的读写都已停止。` +
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
     *      所以「新表忘了登记」的表现依旧是「改不动」而不是「什么都能改」——失败方向是安全的。
     *
     * @param {string} table - 表名
     * @returns {Array.<string>} 允许通用更新的列名；未登记的表为空数组
     */
    _allowedCols(table) {
      return SCHEMA.allowedCols(table);
    }
  }

  const legacyMethodModules = [
    // ⚠️ 这一串是**尚未搬进 `app/modules/` 的模块**的业务方法 —— 搬完一个就从这里删掉它那一行
    //    （方案 §四 第 4 行的「手写清单 → 扫目录」）。
    //    ⚠️ 标签写的是**真实文件名**（不是序号）：撞名抛错时要能一眼看出是哪两个来源。
    // ⚠️ 0.5.0：`projects.js` 与 `tasks.js` **已随任务板搬进 `modules/tasks/lib/`**，
    //    这两行删掉了。⚠️ 但同源的**通用写原语** `_insert` / `_update` **没有跟着搬** ——
    //    它们改住 `./methods/task-writes.js`（六个模块共用；搬走会让「删目录验收」变成
    //    收藏夹 / 硬件 / 密码库 / 课表 / 对话的写入全线 `is not a function`）。
    ['./methods/task-writes.js', require('./methods/task-writes.js')],
    ['./methods/stats.js', require('./methods/stats.js')],
    ['./methods/users.js', require('./methods/users.js')],
    ['./methods/admin.js', require('./methods/admin.js')],
    ['./methods/backup.js', require('./methods/backup.js')],
    ['./methods/migrate.js', require('./methods/migrate.js')],
    // ⭐ 0.3.5 对话（好友 / 会话 / 消息）的业务方法：**已随 0.5.0搬进
    //    `modules/teamwork/store.js`** —— 由上面的注册表聚合，这里那一行已删。
    // ⭐ 0.2.0 课表的业务方法：**已随 0.5.0搬进 `modules/timetable/store.js`** ——
    //    同样由注册表聚合，这里那一行已删。
  ];

  // ⭐ 0.5.0新增：**装配期撞名护栏** —— 各来源的业务方法名必须两两不重名。
  //
  // 为什么要它：`Object.assign` 把各来源**平铺到同一个原型**上，两个来源各写一个同名方法时
  // 后来者会**静默覆盖**前者（`Object.assign` 不报错），而表现是「某一屏打不开了」、
  // 代码看着毫无问题 —— 0.3.1 落地时真的踩到过一次（硬件模块的 `list` 盖掉了收藏夹的
  // `list`，由 `ttt/test/bookmarks.test.js` 当场抓住）。
  // 搬进模块目录之后，「谁先谁后」变成注册表顺序与手写 require 顺序的叠加，靠人眼更不可靠，
  // 所以在装配点机械兜住：口径照 `backend/index.js` 的 `assertOpsContract()`（**加载时兑现、一律启动即抛**）。
  // ⚠️ **只覆盖业务方法来源**（已搬迁模块的 `store.js` + 上面那一串手写 require）——
  //    刻意**不比对** `sqlite.methods` / `json.methods`：那两份是**各后端自己的生命周期方法**
  //    （`_tunePragmas` / `_migrateSqlite` … 与 `_loadJson` / `_saveJson` …），
  //    不属于「业务方法被平铺到同一个 Store 原型」这条规矩的范围。
  //    ⚠️ 实测到今天两份**恰好不相交**（sqlite.methods 里多一个 `_connFor`，json.methods 6 个，
  //    交集仍是 0），但**不能假设永远不相交** —— 真要比对它们，得另立一条规则、另写一处检查，
  //    而不是把它塞进这道的口径里（塞进来只会让「契约」和「撞车」两件事混在一起）。
  assertNoMethodClash([
    // ⭐ 0.5.0 模块化重构：**已搬迁模块的业务方法**由注册表聚合（`modules/<name>/store.js`）。
    //    搬走一个模块，它那一行就从上面那串手写 require 里删掉 —— **不用改这里**
    //    （方案 §四 第 4 行；没搬完的模块回 `null`，`filter(Boolean)` 挡掉）。
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
