'use strict';
/**
 * core/store/backend/json.js —— JSON 回退 后端的**实现**（0.2.0，审查报告 B2）
 *
 * 功能：提供 JSON 文件存储后端的全部能力 ——
 *      `ops` 是**尚未搬进模块目录的那批存储原语**，覆盖项目与项目任务、日常任务、账号与设置，
 *      与 SQLite 后端同名同参、可互换；
 *      ⚠️ 其余原语已经跟着各自的模块搬进 `app/modules/<模块>/backend/` 了
 *      （0.5.0起 bookmarks、起 hardware 与 vault、起 teamwork、起 timetable）；
 *      ⚠️ **不在这里写 op 的条数**：0.5.0 期间每搬走一个模块它就会变，写死的数字必然过期。
 *      全仓 op 数量的唯一权威是 `backend/index.js` 的 `OPS`（运行时算出来的）；
 *      `methods` 是 JSON 特有的生命周期与工具方法（读取与落盘、老键改名、空形状、
 *      空库种子、老数据一次性导入）。
 *
 * 两类东西：
 *   - `ops`：原来散在各业务方法里那段「按后端分岔」的代码。业务方法**不再问** `this.backend`，
 *     一律调 `this._bk.<name>(...)`；本文件与另一个后端必须**同名同参**（启动时自检，见 backend/index.js）。
 *   - `methods`：JSON 回退特有的生命周期/工具方法（6 个），混进 Store 原型。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * ⭐ **0.8.1（记账 2 期）：JSON 后端同样有两个库**——
 *    主库 `zxdesk.json` ＋ 记账库 `zxdesk-ledger.json`（多库**不是 SQLite 专属**）。
 *    与 SQLite 那一侧的差别只有「库」是什么：那边是两个连接，这边是**两份数据对象**
 *    （`this.data` / `this.ledgerData`），路由同样只靠 `_dbFor()` / `_dataFor()`（唯一出处
 *    在 store/schema/index.js，来源是各模块 `module.json.database`）。
 *    ⚠️⭐ 记账模块自己的原语（`modules/ledger/backend/json.js`）里写的是 `this.data.<表>` 与
 *    `this._saveJson()` —— 它们**一个字都不用改**：门面在 `Store._runOnLedger()` 里把
 *    `this.data` 临时换成 `ledgerData`、把 `activeDb` 置成 `'ledger'`，于是那些写法自动落到账本那份上。
 *    ⇒ 所以 `_saveJson()` 的**缺省目标**必须是「当前正在服务的那个库」（`this.activeDb`），
 *    而不是写死 `zxdesk.json`。
 *
 * ⚠️ 所有方法体都是从改造前的 `db.js` **按字节切出来的**，没有重打 ——「只搬家不改逻辑」
 *    由 `ttt/temp/split/verify-db.js` 的逐块对账证明。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.21
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA, IMPORT_KEEP_TABLES } = require('../constants.js');
const { compactStamp, deref, uidOf } = require('../helpers.js');

const ops = {
  /**
   * 功能：往指定表里插入一行，并回填自增 id。
   * @param {string} table - 表名（数据形状里的键名）
   * @param {Object} row - 待插入的行，键即列名
   * @returns {Object} 回填了 `id` 的同一行对象
   * 说明：id 取自 `data._seq` 这个 JSON 后端自己的全局自增序列，与 SQLite 的 rowid 无关；入参对象会被就地修改。
   * ⭐ 0.8.1：目标**数据对象**按表名解析（`_dataFor`，记账表落在 `ledgerData` 上）——
   *    ⛔ 不许写死 `this.data`，那会把记账行写进 `zxdesk.json`（表现是「记账数据在两个文件之间劈叉」）。
   */
  insert(table, row) {
    const d = this._dataFor(table);
    row.id = d._seq++;
    (d[table] = d[table] || []).push(row);
    this._saveJson(this._dbFor(table));
    return row;
  },

  /**
   * 功能：按 id + 归属定位一行，把 `setKeys` / `values` 指定的列改掉。
   * @param {string} table - 表名
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 记录 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 命中并更新了一行返回 true，未命中返回 false
   * 说明：只改 `setKeys` 列出的列，未列出的列原样保留。归属判断同时生效，避免一次更新把记录「过户」给别人。
   * ⭐ 0.8.1：与 `insert` 同一条 —— 数据对象按表名解析，落盘目标也跟着它是哪个库。
   */
  update(table, uid, id, setKeys, values) {
    const d = this._dataFor(table);
    const idx = (d[table] || []).findIndex((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (idx < 0) return false;
    setKeys.forEach((k, i) => {
      d[table][idx][k] = values[i];
    });
    this._saveJson(this._dbFor(table));
    return true;
  },

  /**
   * 功能：导出某个账号的**核心**数据 —— 项目、项目任务、日常任务、账号行。
   * @param {(number|string)} uid - 用户 id
   * @returns {Object} 含 `projects` / `ptasks` / `dtasks` / `users`
   *      ⚠️ 收藏夹三张表**不在这里**（0.5.0起归 `modules/bookmarks/` 自己导出）；
   *      硬件台账与密码库两张表**也不在这里**（0.5.0起归 `modules/hardware/` 与
   *      `modules/vault/` 各自的 `export.js` 导出，`store/methods/stats.js` 合并各模块片段）；
   *      ⚠️ **对话四张表同样不在这里**（0.5.0起归 `modules/teamwork/export.js` 导出）——
   *      「只带我这一侧」那条语义原样搬进了模块自己的 `exportTeamwork()` 原语，一个字没改。
   *      ⚠️ **课表八张表也不在这里**（0.5.0起归 `modules/timetable/backend/*.js` 的
   *      `exportTimetable()` 原语 + `modules/timetable/export.js`，读取语句逐字搬运）。
   * 说明：先 JSON 深拷贝再过滤排序，导出结果与内存里的数据完全脱钩，调用方后续改动不会回写存储；各表沿用列表接口的排序规则。
   */

  /**
   * 功能：统计账号总数（跨全部账号，不区分管理员）。
   * @returns {number} 账号行数
   */
  countUsers() {
    return (this.data.users || []).length;
  },

  /**
   * 功能：统计管理员账号的个数，供启动时判断「要不要补一个内置管理员」。
   * @returns {number} 管理员账号数
   */
  countAdmins() {
    return (this.data.users || []).filter((u) => Number(u.is_admin) === 1).length;
  },

  /**
   * 功能：统计某个账号名下的项目数、项目任务数与日常任务数。
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {{ projects: number, projectTasks: number, dailyTasks: number }} 三类数据的条数
   * 说明：⭐ 0.8.1：与 SQLite 那边同一条 —— 三张表**各问各的库**（`_dataFor`），
   *      返回的形状与三个键一个字没变，调用方不用改。今天这三张表都在主库，
   *      但写死 `this.data` 以后哪张表搬了库就会**静默少数**（表现为提示里的条数偏小）。
   */
  countUserData(u) {
    /** 功能：数出某个表里属于该账号的行数，入参为空时按 0 条算。 */
    const mine = (table) => (this._dataFor(table)[table] || []).filter((x) => uidOf(x) === u).length;
    return {
      projects: mine('projects'),
      projectTasks: mine('project_tasks'),
      dailyTasks: mine('daily_tasks'),
    };
  },

  /**
   * 功能：改写某个账号的管理员标记，并刷新 `updated_at`。
   * @param {(number|string)} uid - 用户 id
   * @param {*} isAdmin - 真值即管理员，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setAdminFlag(uid, isAdmin, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.is_admin = isAdmin ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号的「不显示课表」偏好，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对，少一个就启动即报错）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成 0，写侧一律落 1 / 0。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示课表，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideTimetable(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_timetable = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号的「不显示网址收藏夹」偏好，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对，少一个就启动即报错）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成 0，写侧一律落 1 / 0。
   *      ⚠️ 与 `setHideTimetable` 一样**不碰 `session_epoch`**，也**只改自己这一列**。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示收藏夹，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideBookmarks(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_bookmarks = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号的「不显示 NAS硬件管理」偏好，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成 0，写侧一律落 1 / 0。
   *      ⚠️ 同样**不碰 `session_epoch`**，也**只改自己这一列**。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示硬件管理，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideHardware(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_hardware = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号的「不显示密码库」偏好，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成 0，写侧一律落 1 / 0。
   *      ⚠️ 同样**不碰 `session_epoch`**，也**只改自己这一列**（四个显示开关互不影响）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示密码库，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideVault(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_vault = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号的「不显示对话」偏好，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成 0，写侧一律落 1 / 0。
   *      ⚠️ 同样**不碰 `session_epoch`**，也**只改自己这一列**（五个显示开关互不影响）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示对话，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideTeamwork(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_teamwork = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示 AI 辅助任务」开关并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHideTeamwork` 同一条规矩：只改这个账号自己的偏好、
   *      不碰 `session_epoch`、六个偏好互不影响；`ai_*` 三张表一行不动。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示 AI 辅助任务，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideAi(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_ai = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示灵感库」开关，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHideAi` 同一条规矩：只改这个账号自己的偏好、
   *      不碰 `session_epoch`、七个偏好互不影响；`idea_items` 一行不动。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示灵感库，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideIdea(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_idea = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示番茄钟」开关，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHideIdea` 同一条规矩：只改这个账号自己的偏好、
   *      不碰 `session_epoch`、八个偏好互不影响；`time_pomodoro_sessions` 一行不动。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示番茄钟，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHidePomodoro(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_pomodoro = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示日历」开关，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHidePomodoro` 同一条规矩：只改这个账号自己的偏好、
   *      不碰 `session_epoch`、九个偏好互不影响；`calendar_events` 一行不动。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示日历，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideCalendar(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_calendar = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示数码管理」开关，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHideCalendar` 同一条规矩：只改这个账号自己的偏好、不碰 `session_epoch`、
   *      各偏好互不影响；`hardware_items` 一行不动。
   *      ⭐ 0.8.10：本字段取代退役的 `hide_hardware`（老字段**保留、语义退役**）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示数码管理，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideDigital(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_digital = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示记账」开关，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHideCalendar` 同一条规矩：只改这个账号自己的偏好、
   *      不碰 `session_epoch`、十个偏好互不影响；`ledger_accounts` / `ledger_snapshots` 一行不动。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示记账，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideLedger(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_ledger = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号「不显示行程」开关，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 0（显示入口）。
   *      ⚠️ 与 `setHideLedger` 同一条规矩：只改这个账号自己的偏好、
   *      不碰 `session_epoch`、十一个偏好互不影响；`trips` / `time_trip_tickets` / `time_trip_points` 一行不动。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示该账号不显示行程，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setHideTrip(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_trip = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：写入某个账号的**记账眼睛初值**（1 = 进来就把金额糊成圆点），并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对，少一个就启动即报错）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成 0，写侧一律落 1 / 0。
   *      ⚠️ 与 `setHideTimetable` 一样**不碰 `session_epoch`**，也**只改自己这一列**。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {*} hide - 真值表示进记账就把金额糊成圆点，落盘成 1 / 0
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   * @since 0.8.21
   */
  setHideLedgerAmount(uid, hide, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.hide_ledger_amount = hide ? 1 : 0;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：写入某个账号的**电脑端侧栏模块顺序**，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对，少一个就启动即报错）。
   *      ⚠️⭐ 存 **`null` 而不是空串**：这两个值在本字段上语义不同（NULL = 没排过、走默认顺序），
   *      见 `schema/core.js` 建表语句里那一段 —— ⛔ 别写成 `value || ''`。
   *      老 JSON 数据里就没有这一字段（`undefined`），读侧由 `sanitizeUser` 一并兜成 `null`。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {?string} value - 逗号分隔的模块名，或 null（恢复默认顺序）
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setNavOrder(uid, value, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.nav_order = value == null ? null : String(value);
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：写入某个账号的**手机端底部标签模块**，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      ⚠️ `null` / 空串的区分与 `setNavOrder` 完全一样。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {?string} value - 逗号分隔的模块名（最多两个），或 null（恢复默认）
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setNavTabs(uid, value, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.nav_tabs = value == null ? null : String(value);
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：改写某个账号的密码库自动锁定分钟数，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对）。
   *      老 JSON 数据里没有这一字段，读侧由 `sanitizeUser` 兜成默认 10 分钟。
   *      ⚠️ 同样**不碰 `session_epoch`** —— 改「多久自动锁」不该把人踢下线。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {number} minutes - 自动锁定分钟数（区间由 `validate.js` 保证）
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setVaultLockMinutes(uid, minutes, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.vault_lock_minutes = Number(minutes);
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：导出该账号的**核心**数据（账号行）—— 各业务模块自己的表由模块自己的 `export.js` 导出。
   *
   * 说明：⭐ 0.5.0起，原先住在这里的**项目 / 项目任务 / 日常任务**三组读取与排序
   *      **原样搬进了 `modules/tasks/backend/json.js` 的 `exportTasks()` 原语**——
   *      任务板是一个模块，它的表就该由它自己导出。
   *      ⇒ 这里只剩核心自己拥有的那一张表（`users`），其余模块的键由
   *      `store/methods/stats.js` 的 `exportFragments()` 并进同一份备份。
   *      ⚠️「先深拷贝再过滤」这条语义一个字没改（`JSON.parse(JSON.stringify(...))`），
   *      它保证导出结果与内存数据完全脱钩。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {Object} `{ users }` —— 该账号自己的账号行
   */
  exportAll(uid) {
    const d = this.data || {};
    /** 功能：深拷贝一个数组（借 JSON 序列化实现），入参为空时给空数组。 */
    const cp = (arr) => JSON.parse(JSON.stringify(arr || []));
    const users = cp(d.users).filter((u) => u.id === Number(uid));
    return { users };
  },

  /**
   * 功能：改写某个账号的登录名，并刷新 `updated_at`。
   *
   * 说明：与 SQLite 后端保持同名同参（`backend/index.js` 在加载时逐个比对，少一个就启动即报错）。
   *      ⚠️ 刻意**不动 `session_epoch`** —— 登录名不参与会话校验，改名不该把人踢下线；
   *      唯一性由业务层 `store.setUsername()` 显式查重（两个后端都要一致，JSON 侧没有约束）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {string} username - 新的登录名（长度与字符集由业务层校验）
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   */
  setUsername(uid, username, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.username = username;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：按登录名查账号行。
   * @param {string} username - 占位形参，仅为与 SQLite 后端保持同名同参，本实现不使用
   * @param {string} name - 登录名
   * @returns {?Object} 含 `password_hash` 的完整账号行，未命中为 null
   */
  findUserByName(username, name) {
    return (this.data.users || []).find((u) => u.username === name) || null;
  },

  /**
   * 功能：返回全部账号行，供管理面板列成员使用。
   * @returns {Array.<Object>} 账号行数组（未排序，顺序即写入顺序）
   * 说明：返回的是原始行，**含 `password_hash`**；任何对外输出路径都必须先脱敏，不许直接回给客户端。
   */
  listUsersRows() {
    return this.data.users || [];
  },

  /**
   * 功能：按 id 取一个账号行。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 含 `password_hash` 的完整账号行，未命中为 undefined
   */
  getUserRows(uid) {
    return (this.data.users || []).find((x) => x.id === Number(uid));
  },

  /**
   * 功能：取账号的会话代次（`session_epoch`），用于判断无状态会话是否仍然有效。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 账号行（SQLite 后端只取 `session_epoch` 一列），未命中为 undefined
   */
  sessionEpochRows(uid) {
    return (this.data.users || []).find((x) => x.id === Number(uid));
  },

  /**
   * 功能：写入新的口令哈希，并把会话代次 +1，使该账号此前签发的会话立即失效。
   * @param {(number|string)} uid - 用户 id
   * @param {string} passwordHash - 已散列的口令（scrypt）
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   * 说明：改口令 = 踢掉所有在线会话；只是想重新散列而不想把人踢下线时用 `setPasswordHash`。
   */
  setPassword(uid, passwordHash, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.password_hash = passwordHash;
    u.session_epoch = Number(u.session_epoch || 0) + 1;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：只写入新的口令哈希并刷新 `updated_at`，**不动**会话代次。
   * @param {(number|string)} uid - 用户 id
   * @param {string} passwordHash - 已散列的口令（scrypt）
   * @param {string} stamp - 写入 `updated_at` 的时间戳
   * @returns {boolean} 账号存在并已改写返回 true，找不到该账号返回 false
   * 说明：与 `setPassword` 的唯一差别是不递增 `session_epoch` —— 登录成功时静默重算散列成本走这里，否则会把该账号其他设备一并踢下线。
   */
  setPasswordHash(uid, passwordHash, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (!u) return false;
    u.password_hash = passwordHash;
    u.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：记录本次登录时间，同时刷新 `updated_at`。
   * @param {(number|string)} uid - 用户 id
   * @param {string} stamp - 写入 `last_login_at` / `updated_at` 的时间戳
   * @returns {void}
   */
  touchLastLogin(uid, stamp) {
    const u = (this.data.users || []).find((x) => x.id === Number(uid));
    if (u) {
      u.last_login_at = stamp;
      u.updated_at = stamp;
      this._saveJson();
    }
  },

  /**
   * 功能：删除一个账号，并逐表清掉它名下的全部业务数据。
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {boolean} 账号行是否真的被删掉
   * 说明：要清的表清单来自 `SCHEMA.userScopedTablesIn(库名)`（唯一出处），不手写枚举 —— 加一张带 `user_id`
   *      的新表时漏改一处，就会留下「账号没了、数据还在」的残留。
   *
   * ⭐⭐ 0.8.1：记账表住第二个文件 ⇒ **跨库两段执行**（与 sqlite 那边逐条对应）：
   *      第一段清 `zxdesk-ledger.json`、第二段清 `zxdesk.json` 并最后删掉账号行。
   *      ⚠️⭐ 次序**故意**是「记账那个文件先、账号行最后」：反过来的话，第二步失败就留下
   *      「账号已经没了、记账数据还在」—— 那种残留**再也没人去清**。
   *      按现在的次序，第二步失败时账号还在，人**可以再点一次**，重跑是幂等的。
   *      ⚠️ 记账库不可用时**直接 503**（`_assertLedgerWritable()`）：宁可这次删不掉，
   *      也不能「账号删了、记账数据留下」。
   *      ⚠️ 第一段**只在真的删掉了行时才落盘**：账本文件本来就还不存在时，不因为一次「清了 0 行」
   *      凭空造出一个 `zxdesk-ledger.json`（那个文件要等第一次真正的写入才出现）。
   */
  deleteUser(u) {
    // ---- 第一段：记账那一份（它必须先成功，否则账号行不能删）----
    const ledgerTables = SCHEMA.userScopedTablesIn(SCHEMA.LEDGER_DB);
    if (ledgerTables.length) {
      this._assertLedgerWritable();
      let removed = 0;
      const mine = (x) => uidOf(x) === u;
      ledgerTables.forEach((t) => {
        const arr = this.ledgerData[t] || [];
        const kept = arr.filter((x) => !mine(x));
        removed += arr.length - kept.length;
        this.ledgerData[t] = kept;
      });
      if (removed) this._saveJson(SCHEMA.LEDGER_DB);
    }

    // ---- 第二段：主库那一份（过对话 → 通用清空 → 好友补刀 → 收拾孤儿 → 删账号行）----
    const before = (this.data.users || []).length;
    /** 功能：判断一行是否属于该账号。 */
    const mine = (x) => uidOf(x) === u;
    // ⭐ 0.8.12：这三段**对话专属**的处置已搬进 `modules/teamwork/`
    //    （业务方法 → 模块自己的两个 op），与 SQLite 侧逐字对齐的两个可选钩子。
    //    ⚠️ 顺序不能换、模块被删时静静地不做（细则见 `modules/teamwork/store.js` 那两条方法）。
    if (typeof this.teamworkTransferOnDelete === 'function') this.teamworkTransferOnDelete(u);
    SCHEMA.userScopedTablesIn(SCHEMA.MAIN_DB).forEach((t) => {
      this.data[t] = (this.data[t] || []).filter((x) => !mine(x));
    });
    if (typeof this.teamworkPurgeOnDelete === 'function') this.teamworkPurgeOnDelete(u);
    // ⚠️ users 用 `id` 判归属（账号行没有 user_id 列，用 uidOf 会一律得到 1）
    this.data.users = (this.data.users || []).filter((x) => x.id !== u);
    this._saveJson(SCHEMA.MAIN_DB);
    return this.data.users.length < before;
  },

  /**
   * 功能：读一个设置项的值。
   * @param {string} key - 设置项键名
   * @returns {?string} 设置值；键不存在时返回 null
   * 说明：用 `hasOwnProperty` 判断存在性而不是直接取值，这样「值为空字符串」也不会被当成缺失。
   */
  getSetting(key) {
    const s = this.data.settings || {};
    return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null;
  },

  /**
   * 功能：写一个设置项，值统一转成字符串后落盘。
   * @param {string} key - 设置项键名
   * @param {*} value - 设置值，写入前 `String()` 归一化
   * @returns {boolean} 恒为 true（JSON 后端的键值存储不存在写入冲突）
   */
  setSetting(key, value) {
    this.data.settings = this.data.settings || {};
    this.data.settings[key] = String(value);
    this._saveJson();
    return true;
  },

  // ---- 备份与恢复（0.2.1）----

  /**
   * 功能：把**全部表**导出成一个「表名 → 行数组」的对象（整体备份的底层读取口）。
   *
   * 说明：⭐ 表名清单来自 `SCHEMA.tableNames()`，**不手写枚举** —— 将来加一张新表，
   *      整体备份自动带上它；手写清单漏一张的表现是「备份看着成功、恢复后那张表空了」。
   * ⚠️ 返回的是**深拷贝**：调用方拿去序列化时，后台还可能继续改 `this.data`，
   *    直接引用会让「导出中」的文件内容跟着变。
   *
   * ⭐ 0.8.1：**跨两个文件**读（每张表走它自己那份数据对象，`_dataFor` 决定）——
   *    且**两边都要读得到**才算成功。少了记账那半边的备份，在用户看来与完整备份一模一样。
   *
   * @returns {Object} 表名 → 行数组（`settings` 为对象）的集合
   * @throws {Error} 记账那一份不可用时抛 503（见方法内注释）
   */
  exportWhole() {
    // ⚠️⭐ 与 SQLite 那边同一道闸门：少了两半中的任何一半，导出就该**明说失败**，
    //    而不是给出一份「看着成功、少了记账数据」的包（那在用户看来与完整备份一模一样）。
    if (SCHEMA.ledgerTables().length) this._assertLedgerWritable();
    const out = {};
    SCHEMA.tableNames().forEach((t) => {
      const d = this._dataFor(t);
      out[t] = t === 'settings' ? Object.assign({}, d.settings || {}) : JSON.parse(JSON.stringify(d[t] || []));
    });
    return out;
  },

  /**
   * 功能：用一份整体备份**全量替换**当前数据 —— 换成备份形状后整体落盘。
   *
   * 说明：⭐ 这是全项目**唯一会删用户数据**的操作，所以调用方（`methods/backup.js`）必须
   *      **先**把当前 `zxdesk.json` 另存一份再调这里。
   * ⚠️ 逐行保留原 `id`（父子关系按 id 写在备份里），并把 `_seq` 重算成「最大 id + 1」——
   *    不重算的话，新记录会从旧序列继续发号，与刚从备份里恢复的 id 撞车，
   *    表现为「新建的项目一保存就串到别的项目上」。
   *
   * ⭐ 0.8.1：**两份数据对象各换各的、各落各的文件**（一份备份里的表可能跨两个库）——
   *    `_seq` 也各算各的（两个文件各有自己的序列，跨文件撞 id 没有意义：
   *    只有同一份数据对象内部的父子关系才按 id 关联）。
   *    ⚠️ **失败方向（如实说）**：先写账本那一份、后写主库那一份；主库那一份写盘失败时
   *    账本那一份**已经落盘、不回滚**，错误信息里点名「哪一部分已经生效」——
   *    由调用方把这句话原样交给用户（再点一次即可，重跑是幂等的）。
   *    为什么先账本后主库：主库那一份会换掉 `users`（会话随之作废）。主库失败时账号还是原来那批
   *    ⇒ 人仍能登录、仍能再点一次；反过来先换账号再失败，就成了「人已被踢出去、数据还半新半旧」。
   *
   * @param {Object} tables - 「表名 → 行数组」的集合（`settings` 为对象），即 `exportWhole()` 的产物
   * @returns {boolean} 恒为 true
   * @throws {Error} 某一份写不出来时抛出（错误信息点名是哪一部分）
   */
  replaceWhole(tables) {
    const src = tables || {};
    /** 功能：把备份里属于某个库的那些表套进一份空形状，并算好该文件的 `_seq`。 */
    const build = (dbName) => {
      const next = this._emptyJson(dbName);
      let maxId = 0;
      SCHEMA.tablesByDb(dbName).forEach((t) => {
        if (t === 'settings') {
          next.settings = Object.assign({}, src.settings || {});
          return;
        }
        next[t] = Array.isArray(src[t]) ? JSON.parse(JSON.stringify(src[t])) : [];
        next[t].forEach((r) => {
          if (Number(r.id) > maxId) maxId = Number(r.id);
        });
      });
      next._seq = maxId + 1;
      return next;
    };
    const order = [SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB];
    for (const dbName of order) {
      // ⚠️ 记账那一份先过闸门（与 SQLite 那条一字不差：不该以一句内部错收场）
      if (dbName === SCHEMA.LEDGER_DB && SCHEMA.ledgerTables().length) this._assertLedgerWritable();
      const next = build(dbName);
      if (dbName === SCHEMA.LEDGER_DB) this.ledgerData = next;
      else this.data = next;
      try {
        this._saveJson(dbName);
      } catch (e) {
        const label = dbName === SCHEMA.LEDGER_DB ? '记账库' : '主库';
        const did =
          dbName === SCHEMA.LEDGER_DB
            ? '两半都还没落盘，数据仍是操作前的样子。'
            : '⚠️「记账库」那一份**已经落盘且不回滚**，当前处于「部分恢复」状态 —— 请重试一次（重跑就是照着同一份备份再写一遍）。';
        const err = new Error(`整体恢复的「${label}」那一段写盘失败：${(e && e.message) || e}。${did}`);
        err.status = 500;
        throw err;
      }
    }
    return true;
  },

  /**
   * 功能：清空**某一个账号**名下的全部业务数据（个人导入的「替换」模式用）。
   *
   * 说明：⚠️ **不动账号行** —— 账号本身、口令、管理员身份都不属于「业务数据」，
   *      个人导入绝不允许改掉自己的账号（否则导入别人的备份就可能把自己顶掉）。
   *      要清哪些表来自 `SCHEMA.userScopedTablesIn(库名)`（唯一出处）。
   *
   * ⭐ 0.8.1：**按库分两段**（与 sqlite 那边逐个文件对应）—— ⛔ 不许拿全量清单去过滤单个文件：
   *    不属于那个文件的表会被当成「本来就没有」而**静默放过**，于是「清空」变成一句空话，
   *    而下面紧接着就是「把备份写回去」，结果是两份数据叠在一起、**且不报错**。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 恒为 true
   */
  clearUserData(uid) {
    const u = Number(uid);
    const mine = (x) => uidOf(x) === u;
    // ⚠️ 对话四张表**刻意跳过**（`IMPORT_KEEP_TABLES`）：跨账号数据 + 个人导入不重建它，
    //    清掉等于白丢一段真实聊天记录（理由写在 store/constants.js 那张清单上）。
    const keep = (t) => !IMPORT_KEEP_TABLES.includes(t);
    [SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB].forEach((dbName) => {
      const mineTables = SCHEMA.userScopedTablesIn(dbName).filter(keep);
      if (!mineTables.length) return;
      // ⚠️ 记账那一份先过闸门（理由同 `replaceWhole`）
      if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const d = dbName === SCHEMA.LEDGER_DB ? this.ledgerData : this.data;
      mineTables.forEach((t) => {
        d[t] = (d[t] || []).filter((x) => !mine(x));
      });
      this._saveJson(dbName);
    });
    return true;
  },

  /**
   * 功能：按给定顺序**一次性**插入多行（每项自带表名），最后只落盘一次；返回插入后的行（`id` 已回填）。
   *
   * 说明：⭐ 个人导入（合并 / 替换）要走这里而不是逐行 `insert`：导入要插入的是一整棵
   *      「项目 → 项目任务」「学期 → 课次」的树；`insert` 每次都 `_saveJson()`（整份全量覆写），
   *      一千条就是一千次全量写盘，且中途出错只写进去一半，留下挂不上父项的孤儿行。
   *
   * ⭐ 0.8.1：一份备份里的行可能跨两个文件（例如任务 ＋ 记账账户）⇒ 按 `_dbFor` **分组**，
   *    每组写完各自落一次盘（记账那一组先、主库那一组后，与其余跨库操作同一次序）。
   *    ⚠️ `deref`（延迟引用）**只在同一组内部**才可能被解开 —— 这是成立的：
   *    本项目**没有跨库外键**（记账表的外键只指向记账表），父项与子项必然在同一组里。
   *    ⚠️ 失败方向（如实说）：后一组写盘失败时，前一组**已经落盘、不回滚**。
   *
   * @param {Array.<{table: string, row: Object}>} items - 待插入项，顺序即插入顺序（父项必须排在子项前）
   * @returns {Array.<Object>} 插入后的行对象数组（⚠️ 按库分组后的顺序，与入参不保证逐一对应）
   */
  insertMany(items) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    [SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB].forEach((dbName) => {
      const mine = list.filter((it) => this._dbFor(it.table) === dbName);
      if (!mine.length) return;
      // ⚠️ 记账那一份先过闸门（理由同 `replaceWhole`）
      if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const d = dbName === SCHEMA.LEDGER_DB ? this.ledgerData : this.data;
      mine.forEach((it) => {
        // `deref` 解开子项外键上的延迟引用（父项此刻已插好、`id` 已回填）—— 见 helpers.js。
        // ⚠️ 这一步不能省：漏了会把 `{__ref:…}` 这个对象直接写进数据文件里，
        //    外键随即变成一个对象，父子关系全断（SQLite 后端那边会当场撞外键报错，反而更早暴露）。
        Object.keys(it.row).forEach((k) => {
          it.row[k] = deref(it.row[k]);
        });
        it.row.id = d._seq++;
        (d[it.table] = d[it.table] || []).push(it.row);
        out.push(it.row);
      });
      this._saveJson(dbName);
    });
    return out;
  },

  /**
   * 功能：把当前数据文件**另存一份**成指定用途的快照文件（整体恢复前的「退路」），返回文件名；失败则抛错。
   *
   * 说明：JSON 后端没有事务、也没有 WAL，直接把 `zxdesk.json` 拷一份就是一份一致的快照。
   * ⚠️ **失败必须抛**，不能只记下来就放行：这是「马上就要全量替换、必须先有退路」的安全网，
   *    没有退路就不该继续（与迁移前备份的宽松处理刻意不同）。
   *
   * ⭐ 0.8.1：**两个文件各来一份**—— 少了记账那一份，就等于「记账数据的退路」
   *    只存在于上一份整体备份里，而这一步要救的恰恰是「刚刚被整体替换掉的数据」。
   *    ⚠️ 返回值仍是**主库那一份的文件名**（既有调用方与前端的那个字段）。
   *    ⚠️ 记账那一份**只有文件真的存在时才拷**：它可能从来还没落过盘（全新安装、没写过记账数据），
   *    那种情况下「没有记账数据」本身就是事实，凭空造一个空文件只会让数据目录多出一个假线索。
   *    这与 SQLite 那边「不做跳过」刻意不同 —— 那边 `ledgerDb` 一定是个真连接，`VACUUM INTO`
   *    产出的是一份有结构的库；这边「文件不存在」= 「从来没有过记账数据」，跳过是对的。
   *
   * @param {string} tag - 用途标记，进文件名（如 `restore`），非法字符会被剔掉
   * @returns {string} **主库**快照的文件名（不含目录）
   * @throws {Error} 主库数据文件不存在或拷不出来时抛出
   */
  snapshot(tag) {
    const safe = String(tag || 'manual').replace(/[^\w-]/g, '');
    const stamp = compactStamp();
    const name = `zxdesk.json.bak-${safe}-${stamp}`;
    fs.copyFileSync(this.jsonFile, path.join(this.dataDir, name));
    if (fs.existsSync(this.ledgerJsonFile)) {
      fs.copyFileSync(this.ledgerJsonFile, path.join(this.dataDir, `zxdesk-ledger.json.bak-${safe}-${stamp}`));
    }
    return name;
  },

  /**
   * 功能：导出**两个数据文件的原始字节**（整体备份压缩包里的那两个文件）。
   *
   * 说明：JSON 后端的「库文件」就是 `zxdesk.json` / `zxdesk-ledger.json` 本身，所以拷一份就是
   *      完整的原始数据（没有 WAL、没有 checkpoint，不需要 SQLite 那一套手法）。
   *      优先读**文件**而不是序列化内存：文件才是「应用没起来时手工放回去」要用的那一份，
   *      两者一旦不一致，应当以文件为准。文件不存在（极端情况：还没落过盘）才退回按内存数据现生成，
   *      保证这个 op 永远能给出东西，而不是把导出整个打挂。
   *
   * ⭐ 0.8.1：返回一个**数组** `[{entry, buf}, …]`，**主库在前、记账库在后** ——
   *    与 SQLite 后端**形状完全一致**（压缩包要能跨后端恢复，形状一旦按后端分岔，
   *    另一条路就会静默少带一个文件）。`entry` 就是压缩包里的成员名，也是「应用起不来时
   *    手工放回数据目录」要用的文件名 —— 所以它必须是**带上正确扩展名**的真文件名。
   *
   * @returns {Array.<{entry: string, buf: Buffer}>} 两个文件的成员名与字节（主库在前）
   * @throws {Error} 文件读不出来时抛出；记账那一份不可用时抛 503
   */
  rawDump() {
    // ⚠️ 与 SQLite 那边同一道闸门：少了账本那一份就**明说失败** ——
    //    本方法在那一侧不可用时会退回「按内存现生成」，而内存里是 null ⇒ 写出一份内容为 `null`
    //    的假文件（一个彻头彻尾的谎言，比失败糟得多）。
    if (SCHEMA.ledgerTables().length) this._assertLedgerWritable();
    /** 功能：读一个数据文件；文件不存在时用内存里的那份现生成（保证永远能给出东西）。 */
    const dumpOf = (file, data, entry) => {
      if (fs.existsSync(file)) return { entry, buf: fs.readFileSync(file) };
      return { entry, buf: Buffer.from(JSON.stringify(data, null, 2), 'utf8') };
    };
    return [
      dumpOf(this.jsonFile, this.data, 'zxdesk.json'),
      dumpOf(this.ledgerJsonFile, this.ledgerData, 'zxdesk-ledger.json'),
    ];
  },

  // ---- ⭐ 内置高校模板（0.3.5；**没有 user_id** 的只读内置数据）----

  /**
   * 功能：读出两张内置高校模板表的全部行 —— 内置作息表（逐节时间）与内置课程表（课表版式）。
   *
   * 说明：与 SQLite 后端同名同参（契约由 `backend/index.js` 在加载时比对）。
   *      没有 `uid` 参数：这是随应用发布的内置数据，与账号无关。
   *
   * @returns {{schedules: Array.<Object>, grids: Array.<Object>}} 两张表的全部行
   */
  listSchoolTemplates() {
    return {
      schedules: (this.data.time_timetable_school_schedules || []).slice().sort((a, b) => a.sort_order - b.sort_order),
      grids: (this.data.time_timetable_school_grids || []).slice().sort((a, b) => a.sort_order - b.sort_order),
    };
  },

  /**
   * 功能：用给定的行**整体替换**两张内置高校模板表，返回写入的行数。
   *
   * 说明：JSON 后端没有事务，`_saveJson()` 是整文件原子写 —— 与其余写路径同一套语义
   *      （最坏情况是内存状态部分更新，由启动时重新播种纠正）。
   *
   * @param {Array.<Object>} schedules - 内置作息表的行
   * @param {Array.<Object>} grids - 内置课程表的行
   * @returns {{schedules: number, grids: number}} 实际写入的行数
   */
  replaceSchoolTemplates(schedules, grids) {
    const sRows = Array.isArray(schedules) ? schedules : [];
    const gRows = Array.isArray(grids) ? grids : [];
    /** 功能：给一行补上自增 id（JSON 后端用数组下标 +1，与其它表一致）。 */
    const withId = (r, i) => Object.assign({}, r, { id: i + 1 });
    this.data.time_timetable_school_schedules = sRows.map(withId);
    this.data.time_timetable_school_grids = gRows.map(withId);
    this._saveJson();
    return { schedules: sRows.length, grids: gRows.length };
  },
};

const methods = {
  // ---------------- JSON ----------------
  /**
   * 功能：把一个 JSON 数据文件读进内存（主库 → `this.data`；记账库 → `this.ledgerData`），
   *      文件不存在或内容损坏时用空形状兜底；主库那一侧最后跑一次空库种子逻辑。
   * @param {string} [side] - 读哪个库，`'main'`（缺省）/ `'ledger'`
   * @returns {void}
   * 说明：新增表**必须**同时补进下面两处字面量（正常路径 + 损坏重建路径）：漏了 = JSON 后端下 `this.data[table].push` 直接抛错（整块功能在该后端不可用）。
   * ⭐ 0.8.1：**两份文件各自读一次**（`_init` 里先后调用）——
   *    ⚠️⭐ 账本文件**不存在时只在内存里给一个空壳、绝不落盘**：一落盘，用户的数据目录就
   *    凭空多出一个 `zxdesk-ledger.json`，而里面一个字节的真实数据都没有 ——
   *    排查时它会被当成「记账数据被清空了」的证据。它要等到第一次真正的写入才出现。
   */
  _loadJson(side) {
    const which = side === SCHEMA.LEDGER_DB ? SCHEMA.LEDGER_DB : SCHEMA.MAIN_DB;
    const file = which === SCHEMA.LEDGER_DB ? this.ledgerJsonFile : this.jsonFile;
    let data = this._emptyJson(which);
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw) data = this._renameJsonUserCols(Object.assign(data, this._renameJsonKeys(JSON.parse(raw))));
      } catch (_e) {
        // 损坏则重建
        data = this._emptyJson(which);
      }
    }
    if (which === SCHEMA.LEDGER_DB) this.ledgerData = data;
    else this.data = data;
    // ⚠️ 空库种子只在主库那一侧跑：它是主库初始化流程里的固定一步（当前为空实现），
    //    而且它的钩子名与主库文件绑在一起 —— 在账本那一侧再跑一次只会多出一次无意义的调用。
    if (which === SCHEMA.MAIN_DB) this._seedIfEmptyJson();
  },

  /**
   * 功能：把老 JSON 文件里的旧表名键改写成新表名，并记下改过哪些键。
   * @param {Object} parsed - 已解析的 JSON 对象，键为表名
   * @returns {Object} 改名后的新对象（入参不被修改）
   * 说明：**不能省** —— `zxdesk.json` 里存的是表名当键。不改名的话，用 JSON 回退后端的用户
   *      （以及 SQLite 不可用时的降级读取）打开就是**空的课表**：数据还在文件里，只是读不到，
   *      用户看到的是「课表全没了」，这是最典型的静默丢数据形态。
   * 说明：两边都有（老键 + 新键）时**合并**而不是覆盖 —— 宁可多显示几条，也不丢。
   */
  _renameJsonKeys(parsed) {
    const out = Object.assign({}, parsed);
    SCHEMA.aliases().forEach(([from, to]) => {
      if (!Object.prototype.hasOwnProperty.call(out, from)) return;
      const oldVal = out[from];
      if (Array.isArray(oldVal)) {
        const now = Array.isArray(out[to]) ? out[to] : [];
        out[to] = oldVal.concat(now);
      } else if (out[to] === undefined) {
        out[to] = oldVal;
      }
      delete out[from];
      this.renamedJsonKeys.push(from);
    });
    return out;
  },

  /**
   * 功能：把 JSON 数据里各表行上的**旧列名**改写成新列名（⭐ 0.8.12 新造的「列改名」一档，JSON 侧）。
   *
   * 说明：⚠️ **不能省** —— SQLite 的 `ALTER TABLE … RENAME COLUMN` 管不到 JSON 后端的键：
   *      JSON 里一行的列名就是对象的键，而这个后端**不落库、只落文件**。少了这一步，
   *      用 JSON 回退后端（或 SQLite 打不开而降级读取）的用户打开就是**开关状态全丢**：
   *      数据还在文件里（键叫 `hide_chat`），程序读的是 `hide_teamwork` —— 读到 undefined ⇒
   *      按「显示」处理。两后端成对是硬规矩。
   *
   * ⚠️ 幂等：新键已在就跳过；老键不在也跳过；**两键同时存在**时保留新键、丢掉老键
   *    （与 SQLite 侧「两列同时存在就什么都不做」略不同 —— 这里是内存里的对象，不存在
   *    「改坏磁盘」的风险，而留着老键只会让文件越来越大、两边永远并存）。
   *
   * @param {Object} data - 已解析（且表键名迁过）的数据对象
   * @returns {Object} 同一个对象（就地改写）
   */
  _renameJsonUserCols(data) {
    SCHEMA.columnAliases().forEach(([table, from, to]) => {
      const rows = data[table];
      if (!Array.isArray(rows) || !rows.length) return;
      let hit = 0;
      rows.forEach((r) => {
        if (!r || typeof r !== 'object') return;
        if (!Object.prototype.hasOwnProperty.call(r, from)) return;
        if (r[to] === undefined) r[to] = r[from];
        delete r[from];
        hit += 1;
      });
      if (hit) this.renamedColumns.push(`${table}.${from} → ${to}（${hit} 行）`);
    });
    return data;
  },

  /**
   * 功能：返回 JSON 后端的空数据形状（**唯一出处**）。
   *
   * 说明：⭐ 0.5.0起表名清单**由 schema 派生**（`SCHEMA.tableNames()`），不再手写枚举。
   *      原先这里是 23 张表逐个写死的字面量 —— 与 `exportWhole()` / `replaceWhole()` 那两处的
   *      「派生」写法**不一致**，成了一个**隐性登记点**：模块目录被移走（删目录验收）之后，
   *      移走的那几张表仍会在这份手写清单里留着一个空数组，**看起来一切正常**，
   *      直到有人去查「表都还在吗」。同一个病在已经踩过一次（`_bk` 门面只认两个大文件的
   *      `MERGED_OPS`，见 的 ⑤-3）—— 这次把最后一处手写清单也归到派生。
   *
   *      ⚠️ 形状只有两种，与 `exportWhole()` 保持同一口径：`settings` 是**对象**（键值设置），
   *      其余是**数组**；`_seq` 是 JSON 后端自己的全局自增序列（初值 1），不是表。
   *      等价性在 `ttt/test/store-json.test.js` 里钉住（键集合 + 每个键的形状 + `_seq`）。
   *
   * @param {string} [side] - 要哪一份空形状，`'main'`（缺省）/ `'ledger'`
   * @returns {Object} 各表对应空数组、`settings` 为空对象、`_seq` 为 1 的初始结构
   */
  _emptyJson(side) {
    const out = {};
    // ⚠️ 主库那一份**仍然是全量表名**（`SCHEMA.tableNames()`）—— 形状与 0.8.0 一字不差：
    //    账本那几张表在主库这份里恒为空数组、永远没人往里写（写入一律按 `_dataFor` 路由）。
    //    这样 `zxdesk.json` 的键集合没有变化 ⇒ 降级回 0.8.0 打开它照样读得动，
    //    而 `ttt/test/store-json.test.js` 里那份「手写清单等价性」基线也继续成立。
    // ⚠️ 账本那一份**只放它自己的表**（`tablesByDb`）：它是一个全新的文件，没有历史包袱，
    //    往里塞 38 个恒空的键只会让「这个文件里到底住着什么」变得难以一眼看清。
    const names = side === SCHEMA.LEDGER_DB ? SCHEMA.ledgerTables() : SCHEMA.tableNames();
    names.forEach((t) => {
      out[t] = t === 'settings' ? {} : [];
    });
    out._seq = 1;
    return out;
  },

  /**
   * 功能：把内存里的数据整体写回数据文件（缩进 2 空格、UTF-8）。
   *
   * @param {string} [which] - 写哪个文件，`'main'` / `'ledger'`；缺省 = **当前正在服务的那个库**
   *      （`this.activeDb`，由 `Store._runOnLedger()` 在跑记账模块原语期间置成 `'ledger'`）
   * @returns {void}
   * 说明：JSON 后端的写操作是「改内存 + 全量覆写文件」，没有事务；写盘失败会直接抛出（由上层决定是否降级）。
   *
   * ⭐ 0.8.1：缺省目标**必须**是 `this.activeDb`，⛔ 不许写死 `zxdesk.json` ——
   *    记账模块自己的原语里写的是 `this._saveJson()`（17 处），它们指望「我正在哪个库上跑、
   *    就落哪个文件」；写死主库的表现是「记账数据看着存进去了，重启之后全没了」
   *    （它们在内存里、在账本那份上，只是从来没落到 `zxdesk-ledger.json` 去）。
   *    ⚠️ `this.activeDb` 在构造函数里就是 `'main'`，所以 `_init()` 期间（那时还没有任何
   *    `_runOnLedger`）的落盘目标仍然是主库 —— 时序上也是对的。
   */
  _saveJson(which) {
    const target = which === SCHEMA.LEDGER_DB || which === SCHEMA.MAIN_DB ? which : this.activeDb;
    if (target === SCHEMA.LEDGER_DB) {
      fs.writeFileSync(this.ledgerJsonFile, JSON.stringify(this.ledgerData, null, 2), 'utf8');
      return;
    }
    fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2), 'utf8');
  },

  /**
   * 功能：空库种子钩子 —— 当前**不写入任何示例数据**，首次启动保持空白。
   * @returns {void}
   * 说明：0.0.1 起刻意不塞示例内容；这里保留这个钩子，作为 JSON 后端初始化流程里的固定一步。
   */
  _seedIfEmptyJson() {
    // 0.0.1：不写入示例数据，首次启动空白
    return;
  },

  /**
   * 功能：把老 JSON 数据一次性导入一个**业务数据为空**的 SQLite 库，成功后把 zxdesk.json 改名归档。
   * @returns {void}
   * 说明：背景 —— JSON 与 SQLite 是两套存储，此前**没有互导路径**：一旦运行环境从 JSON 切到
   *      SQLite（或反向），用户看到的就是另一个库，表现为「任务变了 / 少了」。
   * 说明：规则（安全第一）—— 只在库里一条数据都没有时导入，库里已有数据绝不碰；导入成功后把
   *      zxdesk.json 改名归档（`.imported-<时间戳>`）避免被导入第二次；全程事务，失败回滚并记
   *      `importError`；**原样搬运**（`start_date` 为空就仍为空），不做任何推断式改写。
   * 说明：但 `user_id` 是**唯一的例外** —— 一律强制写成 `1`（下面三处 `INSERT` 的第一个参数）。
   *      这不是漏改：老 JSON 来自单用户时代，没有可信的归属信息；写成 1 号账号，正好与
   *      「首个注册的账号继承既有数据」衔接（首个注册者 `id` 必然为 1）。
   *      **不要**改成搬运 `p.user_id`：那会让老数据落到一个并不存在的账号名下，表现为数据消失。
   */
  _importJsonIfEmpty() {
    if (!fs.existsSync(this.jsonFile)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
    } catch (_e) {
      return; // 坏 JSON 不动它，也不导入
    }
    if (!parsed) return;
    const cnt = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM projects) AS p,
                (SELECT COUNT(*) FROM project_tasks) AS t,
                (SELECT COUNT(*) FROM daily_tasks) AS d`,
      )
      .get();
    if (!cnt || cnt.p || cnt.t || cnt.d) return;

    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const ptasks = Array.isArray(parsed.project_tasks) ? parsed.project_tasks : [];
    const dtasks = Array.isArray(parsed.daily_tasks) ? parsed.daily_tasks : [];
    if (!projects.length && !ptasks.length && !dtasks.length) return;

    /** 功能：`undefined` / `null` 一律转成 SQL 的 NULL，其余原样返回。 */
    const keep = (v) => (v === undefined || v === null ? null : v);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      const idMap = new Map();
      const insProject = this.db.prepare(
        `INSERT INTO projects (user_id,name,description,color,icon,status,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      projects.forEach((p) => {
        const r = insProject.run(
          1,
          p.name || '未命名项目',
          keep(p.description),
          keep(p.color),
          keep(p.icon),
          keep(p.status),
          Number(p.sort_order) || 0,
          keep(p.created_at),
          keep(p.updated_at),
        );
        idMap.set(p.id, Number(r.lastInsertRowid));
        n++;
      });
      const insPTask = this.db.prepare(
        `INSERT INTO project_tasks (project_id,user_id,title,description,status,start_date,due_date,assignee,tag,important,urgent,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      ptasks.forEach((t) => {
        const pid = idMap.get(t.project_id);
        if (!pid) return; // 父项目没导进来就跳过，不制造孤儿任务
        insPTask.run(
          pid,
          1,
          t.title || '未命名任务',
          keep(t.description),
          keep(t.status),
          keep(t.start_date),
          keep(t.due_date),
          keep(t.assignee),
          keep(t.tag),
          t.important ? 1 : 0,
          t.urgent ? 1 : 0,
          Number(t.sort_order) || 0,
          keep(t.created_at),
          keep(t.updated_at),
        );
        n++;
      });
      const insDTask = this.db.prepare(
        `INSERT INTO daily_tasks (user_id,title,content,important,urgent,start_date,due_date,status,completed_at,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      dtasks.forEach((t) => {
        insDTask.run(
          1,
          t.title || '未命名',
          keep(t.content),
          t.important ? 1 : 0,
          t.urgent ? 1 : 0,
          keep(t.start_date),
          keep(t.due_date),
          keep(t.status),
          keep(t.completed_at),
          Number(t.sort_order) || 0,
          keep(t.created_at),
          keep(t.updated_at),
        );
        n++;
      });
      this.db.exec('COMMIT');
      this.importedFromJson = n;
      const dest = `${this.jsonFile}.imported-${compactStamp()}`;
      try {
        fs.renameSync(this.jsonFile, dest);
        this.importedJsonFile = dest;
      } catch (_e) {
        /* 改名失败不影响导入结果，下次启动因库非空也不会重复导入 */
      }
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略 */
      }
      this.importedFromJson = 0;
      this.importError = (e && e.message) || String(e);
    }
  },
};

module.exports = { ops, methods };
