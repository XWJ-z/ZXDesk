'use strict';
/**
 * core/storage.js —— 存储层的**入口**（0.2.0 起，审查报告 B2）
 *
 * 功能：存储层对外的**唯一入口** —— 把「版本号字面量 / 组装 `Store` / 对外导出」这三件事收在一处，
 *      其余文件一律从这里取存储层（逐条清单见下方 ⚠️ 段，此处不重复）。
 *
 * 改造前这里是一个 **2376 行的单类**：连接管理 + 迁移 + 备份 + JSON 回退 + 项目/任务/课表/账号
 * CRUD + 统计 + 搜索 + 导出，全在一个 `class Store` 里，并散着 **40 处**
 * `if (this.backend === 'sqlite') { … } else { … }` 的双实现 —— 加一个业务要先在这 40 处里找位置。
 *
 * 现在按职责分家（**只搬家，不改逻辑**；由 `ttt/temp/split/verify-db.js` 逐块对账证明）：
 *
 *   store/helpers.js        与后端无关的纯函数（today / nowStamp / clampRange / uidOf / sanitizeUser…）
 *   store/constants.js      schema 门面 + USER_SCOPED_TABLES + BACKUP_KEEP
 *   store/backend/sqlite.js SQLite 生命周期 + **尚未搬进模块目录的那批后端原语 op**
 *   store/backend/json.js   JSON 回退生命周期 + 同名同参的同一批 op
 *   store/backend/index.js  ⭐ 两后端 op 契约的**加载时自检**，以及**全仓 op 数量的唯一权威**
 *                            （`OPS`；⚠️ **数量随模块搬迁变化，别在这里写死一个数** ——
 *                            0.5.0 期间每搬走一个模块它就会变，写死的数字必然过期）
 *   store/methods/*.js      业务方法：**一律不出现 `this.backend`**，只管调 `this._bk.<op>(...)`
 *   store/index.js          装配点：构造函数 / `_init` / 写闸门 / 列白名单
 *
 * ⭐ **0.8.1（记账 2 期）：数据层同时开着两个库**——主库 `zxdesk.db`（JSON 回退时
 *    `zxdesk.json`）＋ 记账库 `zxdesk-ledger.db`（`zxdesk-ledger.json`）。两个库各有自己的
 *    开库 / WAL 探测 / 只读降级 / 结构体检 / 迁移前备份；「表 → 库」的映射唯一出处是
 *    `store/schema/index.js` 的 `dbOf()`（来源是各模块 `module.json` 的 `database` 字段）。
 *    ⚠️ 两套体检结果必须**分开呈现**：只报主库正常会让「记账库打不开」这件事完全无声。
 *    对外读口是下面的 `dbStatusOf(store)`（非敏感信息，启动日志与排查用）。
 *
 * ⚠️ **本文件只剩三件事**，别再把逻辑加回来：
 *   1. 版本号唯一字面量（铁律 2：只改 `CHANGELOG.json`，再跑 `npm run sync-version`）
 *   2. 组装 `Store`（把版本号注入 `makeStore`）
 *   3. 对外导出 `{ Store, APP_VERSION, today }`（⭐ 0.8.1 追加只读状态读口 `dbStatusOf`）
 *
 * ⚠️ 为什么 `APP_VERSION` 的字面量**必须留在这里**、而不是搬去 `store/`：
 *    `ttt/tools/sync-version.js` 按「恰好命中一次」回写它，`ttt/tools/verify-package.js` 也在包里找它，
 *    `ttt/test/version.test.js` 还反向钉住「代码里只许有这一处」。搬走会让三处同时失准。
 *    所以做法是**把字面量留在这里、把值传给 store**（`makeStore(APP_VERSION)`），
 *    `store/` 内部改读 `this.appVersion`。这正是「0.1.3 收敛为唯一字面量」的延续。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.1
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const { makeStore } = require('./store/index.js');
const { today } = require('./store/helpers.js');

const APP_VERSION = '0.9.4';

/** ⭐ 存储层装配：两个后端 + 六个业务模块 + 加载时的后端契约自检 */
const Store = makeStore(APP_VERSION);

/**
 * 功能：取**两个库的只读体检结果**（可用 / 只读 / 日志模式 / 原因 …）—— 启动日志与排查的唯一读口。
 *
 * 说明：⭐ 0.8.1：两个库有两个失败点，「主库正常」**完全不代表**「记账库正常」——
 *      所以两套结果一起给出来，由调用方（`context.js` 的启动日志）分库呈现。
 *      ⚠️ 只放**非敏感**信息：哪个库、什么文件、哪个后端、可用/只读、日志模式、原因、
 *      建索引失败的原因、记账库自己的迁移前备份名。⛔ **不放任何账号、条数或业务内容** ——
 *      它会经启动日志与运维接口露出去。
 *      ⚠️ 字段取自 `store.dbStatus`（由 `store/index.js` 的 `_refreshDbStatus()` 在启动时算好），
 *      本函数**不在这里读数据库**：它可能在启动早期被调用，那时数据还没装载完。
 *      ⚠️ 为什么不放进 `store/methods/admin.js` 的 `info()`：那个文件不在本次批次的改动边界内
 *      （见任务书 §4），所以「记账库那一半」的读口落在这里 —— 它本来就是存储层的入口。
 *
 * @param {Object} store - `new Store(dataDir)` 得到的实例
 * @returns {{main: ?Object, ledger: ?Object, ledgerIndexErrors: Array.<string>, ledgerBackupFile: ?string}} 只读快照
 */
function dbStatusOf(store) {
  const s = (store && store.dbStatus) || {};
  return {
    main: s.main || null,
    ledger: s.ledger || null,
    // 建索引失败属于「只是查询变慢、不阻断启动」那一类，单独列出来是为了让启动日志能**分库**告警
    ledgerIndexErrors: (store && store.ledgerIndexErrors) || [],
    // 记账库自己的「迁移前自动备份」文件名（本次启动若无迁移则为 null）
    ledgerBackupFile: (store && store.ledgerBackupFile) || null,
  };
}

module.exports = {
  Store,
  /** ⭐ 版本号唯一字面量（`ttt/tools/sync-version.js` 回写；`server.js` import 用之，不再各写一份） */
  APP_VERSION,
  /**
   * ⭐ 「今天是哪天」也**只留一份实现**（0.1.3 起 `server.js` 直接 import 这个）：
   *    时间口径一旦有两份，跨 0 点就会出现「今日待办数」与界面列表对不上的幽灵问题。
   *    本体在 `store/helpers.js`，与前端 `core/date.js` 的 `todayStr()` 同一口径（本地时间）。
   */
  today,
  /** ⭐ 0.8.1：两个库的只读体检结果（主库那一半另有 `storeInfo`，见 `store/methods/admin.js`） */
  dbStatusOf,
};
