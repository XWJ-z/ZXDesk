'use strict';
/**
 * core/store/backend/sqlite.js —— SQLite 后端的**实现**（0.2.0，审查报告 B2）
 *
 * 功能：提供 SQLite 后端的全部存储原语与生命周期方法，作为 Store 的一份后端实现。
 *      `ops`：**尚未搬进模块目录的那批存储原语**（项目 / 任务 / 课表 / 账号 / 设置的增删改查），
 *      与另一个后端同名同参；
 *      ⚠️ 其余原语已经跟着各自的模块搬进 `app/modules/<模块>/backend/` 了
 *      （0.5.0起 bookmarks、起 hardware 与 vault、起 teamwork、起 timetable）——
 *      `_bk` 门面按 `MERGED_OPS` 取函数，所以「op 住在哪个文件」对业务方法透明；
 *      ⚠️ **不在这里写 op 的条数**：0.5.0 期间每搬走一个模块它就会变，写死的数字必然过期。
 *      全仓 op 数量的唯一权威是 `backend/index.js` 的 `OPS`（运行时算出来的）。
 *      `methods`：SQLite 特有的生命周期与工具方法（PRAGMA 调优、迁移前备份、表改名与
 *      v5 结构重建、建索引、列补齐、统一读取）。
 *
 * 两类东西：
 *   - `ops`：原来散在各业务方法里那段「按后端分岔」的代码。业务方法**不再问** `this.backend`，
 *     一律调 `this._bk.<name>(...)`；本文件与另一个后端必须**同名同参**（启动时自检，见 backend/index.js）。
 *   - `methods`：SQLite特有的生命周期/工具方法（12 个），混进 Store 原型。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * ⚠️ 所有方法体都是从改造前的 `db.js` **按字节切出来的**，没有重打 ——「只搬家不改逻辑」
 *    由 `ttt/temp/split/verify-db.js` 的逐块对账证明。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.1
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA, SCHEMA_VERSION, BACKUP_KEEP, IMPORT_KEEP_TABLES } = require('../constants.js');
const { compactStamp, deref } = require('../helpers.js');

/**
 * ⭐ **v5 那次整库重建的「到此为止」界限** —— 它是一个**历史常量**，⛔ 不跟着 `SCHEMA_VERSION` 走。
 *
 * 说明：⚠️⭐ `SCHEMA_VERSION` 同时是**两件事**的判据：① 「结构是不是最新的」；
 *      ② 「要不要跑 v5 那次整库重建」（`_upgradeStructureToV5()` 的守卫）。
 *      0.8.12把版本号推到 `v6` 之后，如果守卫还写 `schemaVersion >= SCHEMA_VERSION`，
 *      **所有老库（`user_version = 5`）都会满足条件**，于是每次升级都要把
 *      「建新表 → 搬数据 → 删旧表 → 改名」的整库重建**再跑一遍** ——
 *      那不是 v6 想要的东西，而且会显著放大升级的风险面（全表数据搬迁 ＋ 体检不过就整份跳过、
 *      `user_version` 永远不推进 ⇒ 每次启动都重试并告警）。
 *
 *      ⇒ 把重建那一步的判据**钉成这个常量**，让 `v6` 只表示「改名迁移已记录」、
 *      **不再触发整库重建**。以后再有新的结构版本，同样只推 `SCHEMA_VERSION`、⛔ 不动这里
 *      —— 除非**真的**要再跑一次整库重建（那时另立一个新常量，别改这个）。
 *
 * @type {number}
 */
const REBUILD_UP_TO = 5;

const ops = {
  /**
   * 功能：按行对象的键动态拼出 INSERT 插入一行，并把自增主键写回 `row.id` 后返回该行。
   * @param {string} table - 表名，由调用方保证取自固定白名单
   * @param {Object} row - 待插入的行对象（键即列名）；会被就地补上 `id`
   * @returns {Object} 传入的同一个行对象（已带 `id`）
   */
  insert(table, row) {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    // ⭐ 0.8.1：按「这张表住在哪个库」选连接（`_dbFor` 的唯一出处是 store/schema/index.js）
    const r = this._connFor(table)
      .prepare(sql)
      .run(...cols.map((c) => row[c]));
    row.id = Number(r.lastInsertRowid);
    return row;
  },

  /**
   * 功能：按 `setKeys` 拼出 SET 子句更新一行，并以 `id + user_id` 双重限定范围；返回是否更新到行。
   * @param {string} table - 表名，由调用方保证取自固定白名单
   * @param {number} uid - 用户 id
   * @param {number} id - 行 id
   * @param {Array.<string>} setKeys - 要更新的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的值
   * @returns {boolean} 更新到行则为 true
   */
  update(table, uid, id, setKeys, values) {
    const sql = `UPDATE ${table} SET ${setKeys.map((k) => k + '=?').join(',')} WHERE id=? AND user_id=?`;
    // ⭐ 0.8.1：同上 —— 通用写原语也要按表分派（记账表住第二个库）
    const r = this._connFor(table)
      .prepare(sql)
      .run(...values, id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：导出该账号的**核心**数据（项目、两类任务、账号行），供「完整备份」使用。
   * 说明：⭐ 0.5.0 模块化重构后，**各业务模块自己的表由模块自己的 `export.js` 导出**
   *      （`store/methods/stats.js` 的 `exportFragments()` 把各模块片段合并进同一份备份）；
   *      这里只剩核心自己拥有的那几张表。
   * @param {number} uid - 用户 id
   * @returns {Object} 各表行数组的集合（projects / ptasks / dtasks / users）
   *      ⚠️ 收藏夹三张表**不在这里**（0.5.0起归 `modules/bookmarks/` 自己导出）；
   *      硬件台账与密码库两张表**也不在这里**（0.5.0起归 `modules/hardware/` 与
   *      `modules/vault/` 各自的 `export.js` 导出，`store/methods/stats.js` 合并各模块片段）；
   *      ⚠️ **对话四张表同样不在这里**（0.5.0起归 `modules/teamwork/export.js` 导出）——
   *      「只带我这一侧」那条语义原样搬进了模块自己的 `exportTeamwork()` 原语，一个字没改。
   *      ⚠️ **课表八张表也不在这里**（0.5.0起归 `modules/timetable/backend/*.js` 的
   *      `exportTimetable()` 原语 + `modules/timetable/export.js`，读取语句逐字搬运）。
   */

  /**
   * 功能：统计全库的账号总数。
   * @returns {number} 账号数
   */
  countUsers() {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM users').get();
    return (r && r.c) || 0;
  },

  /**
   * 功能：统计全库的管理员账号数。
   * @returns {number} 管理员数
   */
  countAdmins() {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin=1').get();
    return (r && r.c) || 0;
  },

  /**
   * 功能：统计某个账号名下的数据量（项目数 / 项目任务数 / 日常任务数），供删除账号前的提示与自检使用。
   *
   * 说明：⭐ 0.8.1 起这三个数**跨库聚合**（`_dbFor` 决定每张表在哪个连接上）——
   *      形状与三个键一个字没变，调用方（管理面板的「删除成员」提示）不用改。
   *      这三张表今天都在主库，但**不能因此写死 `this.db`**：以后哪张表搬了库，
   *      写死的那一份会静默漏掉它（表现为提示里的条数偏小，而删除其实删掉了）。
   *
   * @param {number} u - 用户 id
   * @returns {{ projects: number, projectTasks: number, dailyTasks: number }} 三类计数
   */
  countUserData(u) {
    const one = (table) => {
      const r = this._connFor(table).prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id=?`).get(u);
      return (r && r.c) || 0;
    };
    return { projects: one('projects'), projectTasks: one('project_tasks'), dailyTasks: one('daily_tasks') };
  },

  /**
   * 功能：设置账号的管理员标记并更新时间戳，返回是否更新到了行。
   * @param {number} uid - 用户 id
   * @param {boolean} isAdmin - 是否设为管理员（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setAdminFlag(uid, isAdmin, stamp) {
    const r = this.db.prepare('UPDATE users SET is_admin=?, updated_at=? WHERE id=?').run(isAdmin ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的「不显示课表」偏好并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setAdminFlag` 一样**不碰 `session_epoch`** —— 这只是一个显示偏好，
   *      把正在用的人踢下线没有任何道理（被踢的表现是「改个开关突然要重新登录」）。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示课表（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideTimetable(uid, hide, stamp) {
    const r = this.db
      .prepare('UPDATE users SET hide_timetable=?, updated_at=? WHERE id=?')
      .run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的「不显示网址收藏夹」偏好并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideTimetable` 同一条规矩 —— 只是显示偏好，**不碰 `session_epoch`**，
   *      改个开关不该把人踢下线。⚠️ 只改自己勾的那一列：两个偏好必须能**互不影响**地开关
   *      （关课表不该顺手把收藏夹也关掉）。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示收藏夹（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideBookmarks(uid, hide, stamp) {
    const r = this.db
      .prepare('UPDATE users SET hide_bookmarks=?, updated_at=? WHERE id=?')
      .run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的「不显示 NAS硬件管理」偏好并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` 同一条规矩 —— 只是显示偏好，
   *      **不碰 `session_epoch`**，改个开关不该把人踢下线（
   *      「也要像课表一样可以在设置中关闭这个功能」）。
   *      ⚠️ 只改自己勾的那一列：三个偏好必须能**互不影响**地开关。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示硬件管理（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideHardware(uid, hide, stamp) {
    const r = this.db
      .prepare('UPDATE users SET hide_hardware=?, updated_at=? WHERE id=?')
      .run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的「不显示密码库」偏好并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` / `setHideHardware` 同一条规矩 ——
   *      只是显示偏好，**不碰 `session_epoch`**，改个开关不该把人踢下线
   *      （「也要像课表一样可以在设置中关闭这个功能」）。
   *      ⚠️ 只改自己勾的那一列：四个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**，不是密码库本身 —— 已经初始化的库、已经存进去的条目一条不动，
   *      重新打开立刻回来（`vault_meta` / `vault_items` 两行数据在这里完全不参与）。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示密码库（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideVault(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_vault=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的「不显示对话」偏好并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与上面四个显示开关**同一条规矩、同一个理由**——
   *      只是显示偏好，**不碰 `session_epoch`**，改个开关不该把人踢下线
   *      （「也要像课表一样可以在设置中关闭这个功能」）。
   *      ⚠️ 只改自己勾的那一列：五个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：好友关系、会话与消息一行不动，重新打开立刻回来 ——
   *      而且对面并不知道你关掉了它，消息照收照存（`teamwork_*` 四张表在这里完全不参与）。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示对话（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideTeamwork(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_teamwork=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示 AI 辅助任务」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideTeamwork` 同一条规矩：**只是这个账号自己的偏好**
   *      （不是全局设置），**不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：六个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口与插槽**：`ai_*` 三张表一行不动，重新打开立刻回来。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示 AI 辅助任务（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideAi(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_ai=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示灵感库」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideAi` 同一条规矩：**只是这个账号自己的偏好**，
   *      **不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：七个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：`idea_items` 一行不动，重新打开立刻回来。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示灵感库（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideIdea(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_idea=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示番茄钟」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideIdea` 同一条规矩：**只是这个账号自己的偏好**，
   *      **不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：八个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：`time_pomodoro_sessions` 一行不动，重新打开立刻回来。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示番茄钟（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHidePomodoro(uid, hide, stamp) {
    const r = this.db
      .prepare('UPDATE users SET hide_pomodoro=?, updated_at=? WHERE id=?')
      .run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示日历」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHidePomodoro` 同一条规矩：**只是这个账号自己的偏好**，
   *      **不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：九个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：`calendar_events` 一行不动，重新打开立刻回来。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示日历（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideCalendar(uid, hide, stamp) {
    const r = this.db
      .prepare('UPDATE users SET hide_calendar=?, updated_at=? WHERE id=?')
      .run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示数码管理」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideCalendar` 同一条规矩：**只是这个账号自己的偏好**，
   *      **不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：所有偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：`hardware_items` 一行不动，重新打开立刻回来。
   *      ⭐ 0.8.10：本列取代退役的 `hide_hardware`（老列**保留、语义退役**，
   *      照 `hide_calendar` 的先例）—— 老列仍然在库里、仍然可读，只是没有界面再写它。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示数码管理（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideDigital(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_digital=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示记账」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideCalendar` 同一条规矩：**只是这个账号自己的偏好**，
   *      **不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：十个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：`ledger_accounts` / `ledger_snapshots` 一行不动，重新打开立刻回来。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示记账（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideLedger(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_ledger=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示行程」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideLedger` 同一条规矩：**只是这个账号自己的偏好**，
   *      **不碰 `session_epoch`**，改个开关不踢人下线。
   *      ⚠️ 只改自己勾的那一列：十一个偏好必须能**互不影响**地开关。
   *      ⚠️ 关掉的是**入口**：`trips` / `time_trip_tickets` / `time_trip_points` 一行不动，重新打开立刻回来
   *      （车票与轨迹是**已经发生过的事实凭证**，行程只是一层分组 —— 关入口绝不删数据）。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示该账号不显示行程（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setHideTrip(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_trip=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：写入某个账号的**记账眼睛初值**（1 = 进来就把金额糊成圆点）并刷新 `updated_at`。
   *
   * 说明：⭐ 与 `setHide*` 同一条规矩：**只是显示偏好，不碰 `session_epoch`** ——
   *      点一下眼睛不该把人踢下线。⚠️ 只改自己这一列，不许连累上面那十一个开关。
   *      ⚠️⭐ 它与上面那些**语义不同**：那些是「关掉某个功能」，这一列是「金额默认糊不糊」——
   *      用户当场仍能点眼睛看回来（那一次只改内存，不落库）。
   *
   * @param {number} uid - 用户 id
   * @param {boolean} hide - 真值表示进记账就把金额糊成圆点（落库时转成 1 / 0）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   * @since 0.8.21
   */
  setHideLedgerAmount(uid, hide, stamp) {
    const r = this.db
      .prepare('UPDATE users SET hide_ledger_amount=?, updated_at=? WHERE id=?')
      .run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：写入某个账号的**电脑端侧栏模块顺序**并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHide*` 同一条规矩：**只是显示偏好，不碰 `session_epoch`**。
   *      ⚠️⭐ 绑进去的可能是 `null`，那正是本字段的语义之一（NULL = 「没排过，走默认顺序」，
   *      与空串「排了个空的」是两回事，见 `schema/core.js` 建表语句）。
   *      `node:sqlite` 的 `null` 绑定落库就是 SQL NULL ✅（⛔ 别在这里做
   *      `value || ''` 那种兜底 —— 那会把「没排过」悄悄变成「排了个空的」）。
   *
   * @param {number} uid - 用户 id
   * @param {?string} value - 逗号分隔的模块名，或 null（恢复默认顺序）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setNavOrder(uid, value, stamp) {
    const r = this.db.prepare('UPDATE users SET nav_order=?, updated_at=? WHERE id=?').run(value, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：写入某个账号的**手机端底部标签模块**并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setNavOrder` 同一条规矩（NULL / 空串的区分也一模一样）。
   *
   * @param {number} uid - 用户 id
   * @param {?string} value - 逗号分隔的模块名（最多两个），或 null（恢复默认）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setNavTabs(uid, value, stamp) {
    const r = this.db.prepare('UPDATE users SET nav_tabs=?, updated_at=? WHERE id=?').run(value, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的密码库**自动锁定分钟数**并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideVault` 同一条规矩：**只是这个账号自己的偏好**（不是全局设置），
   *      **不碰 `session_epoch`**。放在 `users` 行上的理由与四个显示开关完全一致
   *      ：`settings` 是全局键值表，而「多久自动锁」显然是每人一套；
   *      塞进 `settings`（键名带用户 id）还会在删账号后留下孤儿键。
   *      ⚠️ 区间校验在 `validate.js`，这里只负责落库。
   *
   * @param {number} uid - 用户 id
   * @param {number} minutes - 自动锁定分钟数
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setVaultLockMinutes(uid, minutes, stamp) {
    const r = this.db
      .prepare('UPDATE users SET vault_lock_minutes=?, updated_at=? WHERE id=?')
      .run(Number(minutes), stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：导出该账号的**核心**数据（账号行）—— 各业务模块自己的表由模块自己的 `export.js` 导出。
   *
   * 说明：⭐ 0.5.0起，原先住在这里的**项目 / 项目任务 / 日常任务**三组读取语句
   *      **原样搬进了 `modules/tasks/backend/sqlite.js` 的 `exportTasks()` 原语**（含各自的 `ORDER BY`）——
   *      任务板是一个模块，它的表就该由它自己导出。
   *      ⇒ 这里只剩核心自己拥有的那一张表（`users`），其余模块的键由
   *      `store/methods/stats.js` 的 `exportFragments()` 并进同一份备份。
   *      ⚠️ 收藏夹三张表**不在这里**（0.5.0起归 `modules/bookmarks/`）；
   *      硬件台账与密码库两张表**也不在这里**（起归 `modules/hardware/` 与 `modules/vault/`）；
   *      **对话四张表同样不在这里**（起归 `modules/teamwork/export.js`，且「只带我这一侧」）；
   *      **课表八张表也不在这里**（起归 `modules/timetable/` 的 `exportTimetable()`）。
   *
   * @param {number} uid - 用户 id
   * @returns {Object} `{ users }` —— 该账号自己的账号行
   */
  exportAll(uid) {
    const users = this.db.prepare('SELECT * FROM users WHERE id=?').all(uid);
    return { users };
  },

  /**
   * 功能：改写某个账号的登录名并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setAdminFlag` / `setHideTimetable` 一样**不碰 `session_epoch`** ——
   *      登录名不参与会话校验（Cookie 里是 `uid` + `session_epoch`），改个名字就把人在其他设备上
   *      踢下线没有任何道理。
   *      ⚠️ 唯一性**不在这里保证**：JSON 后端没有约束，两边行为必须一致，
   *      所以查重一律由业务层 `store.setUsername()` 显式比对（与 `createUser` 同一个做法）。
   *
   * @param {number} uid - 用户 id
   * @param {string} username - 新的登录名（长度与字符集由业务层校验）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setUsername(uid, username, stamp) {
    const r = this.db.prepare('UPDATE users SET username=?, updated_at=? WHERE id=?').run(username, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：按登录名取账号行（登录名唯一）。
   * @param {string} username - 调用方传入的原始登录名（本实现不参与查询；两个后端保持同名同参）
   * @param {string} name - 归一化（去首尾空白）后的登录名，实际用于查询
   * @returns {?Object} 账号行（含 `password_hash`）；不存在时返回 null
   */
  findUserByName(username, name) {
    return this.db.prepare('SELECT * FROM users WHERE username=?').get(name) || null;
  },

  /**
   * 功能：列出全部账号行（含管理员），按 id 升序；供管理面板与自检使用。
   * @returns {Array.<Object>} 账号行数组
   */
  listUsersRows() {
    return this.db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  },

  /**
   * 功能：按 id 取单个账号行。
   * @param {number} uid - 用户 id
   * @returns {?Object} 账号行；不存在时返回 undefined
   */
  getUserRows(uid) {
    return this.db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  },

  /**
   * 功能：只取该账号的 `session_epoch` 列，用于判断会话是否已被口令变更作废。
   * @param {number} uid - 用户 id
   * @returns {?Object} 只含 `session_epoch` 的行；不存在时返回 undefined
   */
  sessionEpochRows(uid) {
    return this.db.prepare('SELECT session_epoch FROM users WHERE id=?').get(uid);
  },

  /**
   * 功能：更新口令散列并把 `session_epoch` 递增 1（既有会话随即失效）；返回是否更新到了行。
   * @param {number} uid - 用户 id
   * @param {string} passwordHash - 新的口令散列（scrypt）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setPassword(uid, passwordHash, stamp) {
    const r = this.db
      .prepare('UPDATE users SET password_hash=?, session_epoch=COALESCE(session_epoch,0)+1, updated_at=? WHERE id=?')
      .run(passwordHash, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：只更新口令散列、**不动** `session_epoch`（用于不需要踢掉既有会话的场合）；返回是否更新到了行。
   * @param {number} uid - 用户 id
   * @param {string} passwordHash - 新的口令散列（scrypt）
   * @param {string} stamp - 更新时间戳
   * @returns {boolean} 更新到行则为 true
   */
  setPasswordHash(uid, passwordHash, stamp) {
    const r = this.db
      .prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?')
      .run(passwordHash, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：记录一次登录：把 `last_login_at` 与 `updated_at` 一起写成当前时间戳。
   * @param {number} uid - 用户 id
   * @param {string} stamp - 登录时间戳
   * @returns {void}
   */
  touchLastLogin(uid, stamp) {
    this.db.prepare('UPDATE users SET last_login_at=?, updated_at=? WHERE id=?').run(stamp, stamp, uid);
    return;
  },

  /**
   * 功能：删除账号，并按 `USER_SCOPED_TABLES` 逐表清掉它在各表里的数据；返回是否删到了账号行。
   * 说明：表清单来自 `USER_SCOPED_TABLES`（唯一出处）而不是手写枚举 —— 以前这里是一串手写
   *      DELETE、JSON 分支另有一个数组字面量，两处不对称：加一张带 user_id 的新表时只要漏改一处，
   *      就会留下「账号没了、数据还在库里」的残留；外键的 ON DELETE CASCADE 只覆盖父子关系
   *      （user_id 故意没加外键），所以仍然逐表显式删。
   *      ⭐ 0.3.5 对话：清单里的四张对话表**处置并不一样** —— 会话先**过户**给还留在会话里的那个人，
   *      再走通用清空，最后收拾悬空引用（⭐ 0.8.12 起这三段住在 `modules/teamwork/`，
   *      核心这里只留 `teamworkTransferOnDelete` / `teamworkPurgeOnDelete` 两个可选钩子）。
   *      否则「对方的历史会话缺一段」会变成「对方整个会话消失」。⚠️ 这三步的**顺序**不能换。
   *
   * ⭐⭐ 0.8.1：记账表住第二个库 ⇒ 这里是**跨库两段执行**（`deleteUser` 那一条）：
   *      第一段清**记账库**、第二段清**主库**并最后删掉 `users` 行。
   *      ⚠️⭐ 次序**故意**是「记账库先、账号行最后」：反过来的话，第二步失败就留下
   *      「账号已经没了、记账数据还在」—— 那种残留**再也没人去清**（没有账号可删、界面也看不到它），
   *      也就是这条决策最想避免的那个形态。按现在的次序，第二步失败时账号还在，
   *      人**可以再点一次**，重跑是幂等的（第一段再清一次空表而已）。
   *      ⚠️ 记账库不可用时**直接 503**（`_assertLedgerWritable()`）：宁可这次删不掉，
   *      也不能「账号删了、记账数据留下」。
   *
   * @param {number} u - 用户 id
   * @returns {boolean} 删到账号行则为 true
   * @throws {Error} 记账库不可用（503）或清记账库失败时抛出（记账库那一段已回滚）
   */
  deleteUser(u) {
    // ---- 第一段：记账库（它必须先成功，否则账号行不能删）----
    const ledgerTables = SCHEMA.userScopedTablesIn(SCHEMA.LEDGER_DB);
    if (ledgerTables.length) {
      this._assertLedgerWritable();
      const ldb = this.ledgerDb;
      ldb.exec('BEGIN IMMEDIATE');
      try {
        ledgerTables.forEach((t) => ldb.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u));
        ldb.exec('COMMIT');
      } catch (e) {
        try {
          ldb.exec('ROLLBACK');
        } catch (_e) {
          /* 回滚本身失败无可挽回，把原始错误抛出去 */
        }
        const err = new Error(
          `删除账号时清空记账数据失败（账号与其余数据**一个字节都没动**，可以再点一次）：${(e && e.message) || e}`,
        );
        err.status = 500;
        throw err;
      }
    }

    // ---- 第二段：主库（过对话 → 通用清空 → 好友补刀 → 收拾孤儿 → 删账号行）----
    // ⭐ 0.8.12：这三段**对话专属**的处置已搬进 `modules/teamwork/`
    //    （业务方法 → 模块自己的两个 op），核心这里只剩**两个可选钩子**（先例：`_seedModuleData()`）。
    //    ⚠️ 顺序一个字都不能换：过户必须在通用清空**之前**（成员行一清就无从知道「会话里还有谁」）、
    //    「好友补刀 + 清孤儿」必须在**之后**（细则见 `modules/teamwork/store.js` 那两条方法）。
    //    ⚠️ 模块被整目录删掉时这两句**静静地不做** —— 那正是本次搬家顺带修掉的那个缺陷
    //    （以前是无条件调用 ⇒ `no such table: teamwork_conversations` ⇒ 「删除成员」500）。
    if (typeof this.teamworkTransferOnDelete === 'function') this.teamworkTransferOnDelete(u);
    SCHEMA.userScopedTablesIn(SCHEMA.MAIN_DB).forEach((t) =>
      this.db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u),
    );
    if (typeof this.teamworkPurgeOnDelete === 'function') this.teamworkPurgeOnDelete(u);
    const r = this.db.prepare('DELETE FROM users WHERE id=?').run(u);
    return r.changes > 0;
  },

  /**
   * 功能：按键读一条设置值。
   * @param {string} key - 设置键
   * @returns {?string} 设置值；不存在时返回 null
   */
  getSetting(key) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r ? r.value : null;
  },

  /**
   * 功能：写入一条设置（同键覆盖），值统一按字符串落库。
   * @param {string} key - 设置键
   * @param {*} value - 设置值（经 `String()` 转换后落库）
   * @returns {boolean} 恒为 true
   */
  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
    return true;
  },

  // ---- 备份与恢复（0.2.1）----

  /**
   * 功能：把**全库所有表**导出成一个「表名 → 行数组」的对象（整体备份的底层读取口）。
   *
   * 说明：⭐ 表名清单来自 `SCHEMA.tableNames()`，**不手写枚举** —— 将来加一张新表，
   *      整体备份自动带上它；手写清单漏一张的表现是「备份看着成功、恢复后那张表空了」。
   *
   * ⚠️ `settings` 刻意转成**对象形态**（`{key: value}`），与 JSON 后端的原生形状一致 ——
   *    备份文件是**跨后端**的格式：SQLite 打不开而降级到 JSON 时，正是靠这一点把数据接回来。
   *
   * ⭐ 0.8.1：**跨两个库**读（每张表走它自己那个连接，`_dbFor` 决定）—— 且**两段都成功才算成功**：
   *    记账库读不出来时整次导出抛错（宁可导出失败，也不给一份少了记账数据却「看着成功」的包）。
   *    这是「备份必须完整」与「报告必须诚实」两条的交点：少了记账那半边的备份，
   *    在用户看来与完整备份一模一样。
   *
   * @returns {Object} 表名 → 行数组（`settings` 为对象）的集合
   * @throws {Error} 任一库读不出来时抛出（记账库不可用时是 503，不是一句读不到句柄的内部错）
   */
  exportWhole() {
    // ⚠️⭐ 先过一道闸门再逐表读：少了它，记账库打不开时这里会撞一个 **null 句柄**，
    //    用户拿到的是一句英文内部错（`Cannot read properties of null`），
    //    而真正的原因（那个库打不开）一个字都没说 —— 正是「库打不开必须被可见地报告」要挡的情况。
    if (SCHEMA.ledgerTables().length) this._assertLedgerWritable();
    const out = {};
    SCHEMA.tableNames().forEach((t) => {
      out[t] = this._connFor(t).prepare(`SELECT * FROM ${t}`).all();
    });
    const s = {};
    (out.settings || []).forEach((r) => {
      s[String(r.key)] = r.value;
    });
    out.settings = s;
    return out;
  },

  /**
   * 功能：用一份整体备份**全量替换**当前库的全部数据 —— 清空所有表再按备份逐行写回。
   *
   * 说明：⭐ 这是全项目**唯一会删用户数据**的操作，所以三条硬约束一个都不能省：
   *      ① 每个库各自包在自己的 `BEGIN IMMEDIATE` 里，该库任何一步抛错都 `ROLLBACK`；
   *      ② 调用方（`methods/backup.js`）必须**先**把当前库另存一份再调这里；
   *      ③ `PRAGMA defer_foreign_keys=ON` 让外键检查推迟到 COMMIT —— 否则「先删父表」这一瞬
   *         就会被外键拦下（级联能删掉子行，但顺序上仍有窗口），而它只在事务内有效。
   *
   * ⚠️⭐ 0.8.1：表分布在两个库里，而 SQLite 的事务**不能跨连接** —— 所以这里是
   *    **两段执行**（记账库先、主库后，与 `deleteUser()` 同一条次序），每段一个事务。
   *    **失败方向（如实说，不假装原子）**：后一段失败时，前一段**已经提交、不回滚**，
   *    错误信息里点名是哪一段失败、以及「哪一部分已经生效」—— 由调用方把这句话原样交给用户。
   *    为什么不偷偷把前一段也回滚掉：那需要把「已提交」当成「可撤销」，
   *    而中途再失败一次就留下一个**谁都不知道处于什么状态**的库；如实报告 + 再点一次
   *    （重跑是幂等的：整体替换本来就是「照着备份重写一遍」）才是可恢复的那条路。
   *    ⚠️ 顺序为什么是「记账库先、主库后」：主库那一段会换掉 `users`（会话随之作废）。
   *    主库那一段失败时，账号还是原来那一批 ⇒ 用户仍能登录、仍能再点一次；
   *    反过来先换账号再失败，就成了「人已被踢出去、数据还半新半旧」。
   *
   * ⚠️ **逐行保留原 `id`**：父子关系（`project_id` / `term_id` / `course_id`）在备份里就是按 id 写的，
   *    重新分配 id 会让整库的父子关系错位。自增序列由 SQLite 在插入显式 id 时自行抬高，不必手工重置。
   * ⚠️ 只写**目标表真实存在**的列：备份可能来自旧版本（少列 → 用表定义里的默认值）或
   *    将来版本（多列 → 直接忽略）。不认识的键若硬塞进 INSERT，整次恢复会以一句 SQL 语法错收场。
   *
   * @param {Object} tables - 「表名 → 行数组」的集合（`settings` 为对象），即 `exportWhole()` 的产物
   * @returns {boolean} 恒为 true（失败会抛错；⚠️ 但见上面「失败方向」那段：不是所有表都回到了操作前）
   * @throws {Error} 某一段失败时抛出（该段已回滚；错误信息点名是哪一段）
   */
  replaceWhole(tables) {
    const src = tables || {};
    const names = SCHEMA.tableNames();
    // ⚠️ 两段的次序：记账库在前、主库在后（理由见方法说明）
    const segments = [SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB];
    const applied = [];
    for (const dbName of segments) {
      const mine = names.filter((t) => this._dbFor(t) === dbName);
      if (!mine.length) continue;
      // ⚠️⭐ 记账那一段进门前先过闸门：库打不开时这里会撞 null 句柄，
      //    而「全量替换到一半撞内部错」是最不该出现的形态（宁可整次拒绝、什么都别动）。
      if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
      conn.exec('BEGIN IMMEDIATE');
      try {
        conn.exec('PRAGMA defer_foreign_keys=ON');
        // 删除按**倒序**（子表先走），插入按正序（父表先到）—— 与外键方向一致
        // ⚠️ 先按库过滤再倒序：倒序是「模块声明顺序」的倒序，过滤不改变同一个库内部的相对次序
        mine
          .slice()
          .reverse()
          .forEach((t) => conn.prepare(`DELETE FROM ${t}`).run());
        mine.forEach((t) => {
          if (t === 'settings') {
            const st = conn.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
            Object.keys(src.settings || {}).forEach((k) => st.run(String(k), src.settings[k]));
            return;
          }
          const rows = Array.isArray(src[t]) ? src[t] : [];
          if (!rows.length) return;
          const cols = this._tableCols(t, conn);
          const st = {};
          rows.forEach((row) => {
            const keys = cols.filter((c) => Object.prototype.hasOwnProperty.call(row, c));
            if (!keys.length) return;
            const sql = `INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
            if (!st[sql]) st[sql] = conn.prepare(sql);
            st[sql].run(...keys.map((c) => row[c]));
          });
        });
        conn.exec('COMMIT');
        applied.push(dbName);
      } catch (e) {
        try {
          conn.exec('ROLLBACK');
        } catch (_e) {
          /* 回滚本身失败无可挽回，把原始错误抛出去 */
        }
        const did = applied.length
          ? `⚠️「${applied.map((d) => (d === SCHEMA.LEDGER_DB ? '记账库' : '主库')).join('、')}」那一段**已经生效且不回滚**，` +
            `当前处于「部分恢复」状态 —— 请重试一次（重跑就是照着同一份备份再写一遍）。`
          : '两段都还没生效，数据仍是操作前的样子。';
        const err = new Error(
          `整体恢复的「${dbName === SCHEMA.LEDGER_DB ? '记账库' : '主库'}」那一段失败：${(e && e.message) || e}。${did}`,
        );
        err.status = 500;
        throw err;
      }
    }
    return true;
  },

  /**
   * 功能：清空**某一个账号**名下的全部业务数据（个人导入的「替换」模式用）。
   *
   * 说明：⚠️ **不动 `users` 行** —— 账号本身、口令、管理员身份都不属于「业务数据」，
   *      个人导入绝不允许改掉自己的账号（否则导入别人的备份就可能把自己顶掉）。
   *      要清哪些表同样来自 `USER_SCOPED_TABLES`（唯一出处）。
   *
   * ⭐ 0.8.1：**按库分两段**（`userScopedTablesIn`）—— ⛔ 不许拿全量清单在单个连接上删：
   *    不属于这个库的表会当场「no such table」，于是清空**卡在中途**（一半清了、一半没清），
   *    而那条路的下一句是「把备份写回去」，结果是两份数据叠在一起，**且不报错**。
   *    两段之间没有事务（跨库做不到），失败时点名是哪一段、由调用方如实上报。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 恒为 true
   * @throws {Error} 某一段失败时抛出（该段已回滚）
   */
  clearUserData(uid) {
    const u = Number(uid);
    // ⚠️ 对话四张表**刻意跳过**（`IMPORT_KEEP_TABLES`）：它们是跨账号数据、而且个人导入不重建它们，
    //    清掉等于白丢一段真实聊天记录（详细理由写在 store/constants.js 那张清单上）。
    const keep = (t) => !IMPORT_KEEP_TABLES.includes(t);
    [SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB].forEach((dbName) => {
      const mine = SCHEMA.userScopedTablesIn(dbName).filter(keep);
      if (!mine.length) return;
      // ⚠️ 记账那一段先过闸门（理由与 `replaceWhole` 那条一字不差：null 句柄换不来任何有用信息）
      if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
      conn.exec('BEGIN IMMEDIATE');
      try {
        mine.forEach((t) => conn.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u));
        conn.exec('COMMIT');
      } catch (e) {
        try {
          conn.exec('ROLLBACK');
        } catch (_e) {
          /* 回滚本身失败无可挽回，把原始错误抛出去 */
        }
        const err = new Error(
          `清空账号数据时「${dbName === SCHEMA.LEDGER_DB ? '记账库' : '主库'}」那一段失败：${(e && e.message) || e}`,
        );
        err.status = 500;
        throw err;
      }
    });
    return true;
  },

  /**
   * 功能：按给定顺序**一次性**插入多行（每项自带表名），全程一个事务；返回插入后的行（`id` 已回填）。
   *
   * 说明：⭐ 个人导入（合并 / 替换）要走这里而不是逐行 `insert`：导入要插入的是一整棵
   *      「项目 → 项目任务」「学期 → 课次」的树，中途失败而只写进去一半，
   *      留下的就是一堆挂不上父项的孤儿行。一个事务要么全成、要么全不写。
   *      逐行 `insert` 还会每次都 `_saveJson()`（JSON 后端），一千条就是一千次全量落盘。
   *
   * ⭐ 0.8.1：一份备份里的行可能跨两个库（例如任务 ＋ 记账账户），而**事务不能跨连接** ——
   *    所以按 `_dbFor` **分组**，每组一个事务（记账库那组先、主库那组后，与其余跨库操作同一次序）。
   *    ⚠️ **失败方向（如实说）**：后一组失败时，前一组的行**已经提交、不回滚**，
   *    错误信息里点名是哪一组失败。为什么不做「先全试一遍再提交」：那要缓存整棵树的 `id` 回填，
   *    复杂度与出错面远大于收益（个人导入是低频手工操作，失败时用户再点一次即可，
   *    而组的划分本身是确定的 —— 同一个库里的那一组一定是原子的）。
   *
   * @param {Array.<{table: string, row: Object}>} items - 待插入项，顺序即插入顺序（父项必须排在子项前）
   * @returns {Array.<Object>} 插入后的行对象数组，与入参一一对应（每一项的 `row.id` 已就地回填）
   * @throws {Error} 某一段失败时抛出（该段已回滚；错误信息点名是哪一段）
   */
  insertMany(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const out = [];
    const applied = [];
    [SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB].forEach((dbName) => {
      const mine = list.filter((it) => this._dbFor(it.table) === dbName);
      if (!mine.length) return;
      // ⚠️ 记账那一组先过闸门（理由同上：null 句柄换不来任何有用信息）
      if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
      conn.exec('BEGIN IMMEDIATE');
      try {
        mine.forEach((it) => {
          const cols = Object.keys(it.row);
          const sql = `INSERT INTO ${it.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
          // `deref` 解开子项外键上的延迟引用（父项此刻已插好、`id` 已回填）—— 见 helpers.js
          const r = conn.prepare(sql).run(...cols.map((c) => deref(it.row[c])));
          it.row.id = Number(r.lastInsertRowid);
          out.push(it.row);
        });
        conn.exec('COMMIT');
        applied.push(dbName);
      } catch (e) {
        try {
          conn.exec('ROLLBACK');
        } catch (_e) {
          /* 回滚本身失败无可挽回，把原始错误抛出去 */
        }
        const did = applied.length
          ? `⚠️「${applied
              .map((d) => (d === SCHEMA.LEDGER_DB ? '记账库' : '主库'))
              .join(
                '、',
              )}」那一段**已经写入且不回滚**（个人导入是逐条追加，重来一次只会多出这一段的副本，请先清空或改用替换模式）。`
          : '两段都还没写入。';
        const err = new Error(
          `导入写入时「${dbName === SCHEMA.LEDGER_DB ? '记账库' : '主库'}」那一段失败：${(e && e.message) || e}。${did}`,
        );
        err.status = 500;
        throw err;
      }
    });
    return out;
  },

  /**
   * 功能：把当前库**另存一份**成指定用途的快照文件（整体恢复前的「退路」），返回文件名；失败则抛错。
   *
   * 说明：⭐ 用 `VACUUM INTO` 而不是拷贝 `.db` 文件：WAL 模式下直接拷 `.db` 会漏掉尚未
   *      checkpoint 的事务，快照看着存在、恢复回去却少一截数据 —— 那是最坏的「安全网」。
   *      它与 `_backupBeforeMigrate` 用的是同一个手法。
   * ⚠️ **失败必须抛**，不能像迁移前备份那样只记 `backupError` 就放行：那个是「升级顺手做的好事」，
   *    这个是「马上就要全量替换、必须先有退路」，没有退路就不该继续。
   *
   * ⭐ 0.8.1：**两个库各来一份**—— 少了记账那一份，就等于「记账数据的退路」
   *    只存在于上一份「两库一起打包」的整体备份里，而这一步要救的恰恰是「刚刚被整体替换掉的库」。
   *    ⚠️ 返回值仍是**主库那一份的文件名**（字符串）：它是既有调用方与前端认的那个字段
   *    （「恢复前已另存 …」提示里的那个名字），改形状会波及界面；记账那一份的文件名可由
   *    `zxdesk-ledger.db.bak-<用途>-<时间戳>` 直接推出来（同一时刻、同一用途）。
   *
   * @param {string} tag - 用途标记，进文件名（如 `restore`），非法字符会被剔掉
   * @returns {string} **主库**快照的文件名（不含目录）；记账库那一份同时写好，命名规则见上
   * @throws {Error} 任一库的快照写不出来时抛出（记账库不可用时是 503，见方法内注释）
   */
  snapshot(tag) {
    const safe = String(tag || 'manual').replace(/[^\w-]/g, '');
    const stamp = compactStamp();
    const name = `zxdesk.db.bak-${safe}-${stamp}`;
    const dest = path.join(this.dataDir, name);
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    // ⚠️ 记账库那一侧：用同一套命名规则、只换前缀。**不做「记账库不在就跳过」** ——
    //    在需要退路的这条路上「静默少一份」比直接失败糟得多（调用方以为两库都有退路）。
    //    ⚠️⭐ 先过闸门：库打不开时这里会撞 null 句柄，而这一步的语义是「马上就要全量替换、
    //    必须先有退路」—— 没有退路就不该继续（调用方拿到的必须是一个说得清的原因）。
    this._assertLedgerWritable();
    const ledgerDest = path.join(this.dataDir, `zxdesk-ledger.db.bak-${safe}-${stamp}`);
    this.ledgerDb.exec(`VACUUM INTO '${ledgerDest.replace(/'/g, "''")}'`);
    return name;
  },

  /**
   * 功能：导出整库的**原始字节**（整体备份压缩包里的那个 `zxdesk.db`），随即删掉临时文件。
   *
   * 说明：⭐ 与 `snapshot()` 用的是同一个手法（`VACUUM INTO`）—— **绝不能改成 `fs.copyFileSync`**：
   *      WAL 模式下最近提交的事务还在 `zxdesk.db-wal` 里，直接拷主文件会得到一份「看着在、
   *      少一截」的库，而它正是交给用户长期保管的那一份（理由见 `snapshot()` 的注释）。
   *      临时文件写在数据目录里（`VACUUM INTO` 只能落盘），读完当场删掉 —— 它只是打包的中间产物，
   *      用户拿到的是压缩包里那一份；留在目录里只会让数据目录越堆越乱、还可能被误当成备份。
   * ⚠️ 失败必须抛（同 `snapshot()`）：导出不出来就要让用户看到失败，不能给一个空包。
   *
   * ⭐ 0.8.1：返回一个**数组** `[{entry, buf}, …]`，**主库在前、记账库在后**
   *    （两个后端**形状完全一致** —— 压缩包要能跨后端恢复，形状一旦按后端分岔，
   *    另一条路就会静默少带一个文件）。`entry` 就是压缩包里的成员名，也是「应用起不来时
   *    手工放回数据目录」要用的文件名 —— 所以它必须是**带上正确扩展名**的真文件名。
   *
   * @returns {Array.<{entry: string, buf: Buffer}>} 两个库的成员名与字节（主库在前）
   * @throws {Error} 任一库的快照写不出来或读不回来时抛出（记账库不可用时是 503）
   */
  rawDump() {
    // ⚠️⭐ 先过闸门：库打不开时这里会撞 null 句柄（一句内部英文错），而它的语义是
    //    「导出**两个库**的原始字节」—— 少一个库的降级路径不该以内部错收场。
    this._assertLedgerWritable();
    const dumpOf = (conn, entry) => {
      const tmp = path.join(this.dataDir, `${entry}.export-${compactStamp()}`);
      try {
        conn.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        return { entry, buf: fs.readFileSync(tmp) };
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 临时文件删不掉不影响已经读到的字节 —— 顶多在数据目录里留一个 .export- 文件 */
        }
      }
    };
    return [dumpOf(this.db, 'zxdesk.db'), dumpOf(this.ledgerDb, 'zxdesk-ledger.db')];
  },

  // ---- ⭐ 内置高校模板（0.3.5；**没有 user_id** 的只读内置数据）----

  /**
   * 功能：读出两张内置高校模板表的全部行 —— 内置作息表（逐节时间）与内置课程表（课表版式）。
   *
   * 说明：⭐ 这两张表**不属于任何账号**，所以本 op 没有 `uid` 参数：它们是随应用发布的内置数据，
   *      所有账号看到的是同一份。数据源是 `core/timetable/school-templates.js`，
   *      启动时由 `store.seedSchoolTemplates()` 同步进来（见该方法的说明）。
   *
   * @returns {{schedules: Array.<Object>, grids: Array.<Object>}} 两张表的全部行
   */
  listSchoolTemplates() {
    return {
      schedules: this._listSql('SELECT * FROM time_timetable_school_schedules ORDER BY sort_order ASC, id ASC', []),
      grids: this._listSql('SELECT * FROM time_timetable_school_grids ORDER BY sort_order ASC, id ASC', []),
    };
  },

  /**
   * 功能：用给定的行**整体替换**两张内置高校模板表（清空 + 逐行插入，同一事务），返回写入的行数。
   *
   * 说明：用「整体替换」而不是「逐条 upsert」，是因为数据源（`school-templates.js`）是**全量**的：
   *      删掉一所学校、或改掉某节的 5 分钟，都必须在库里如实反映出来。
   *      逐条 upsert 会让「被删掉的那所学校」永远留在库里 —— 那种半新半旧最难查。
   *
   * ⚠️ 只碰这两张内置表，**一行用户数据都不动**。
   *
   * @param {Array.<Object>} schedules - 内置作息表的行
   * @param {Array.<Object>} grids - 内置课程表的行
   * @returns {{schedules: number, grids: number}} 实际写入的行数
   */
  replaceSchoolTemplates(schedules, grids) {
    const sRows = Array.isArray(schedules) ? schedules : [];
    const gRows = Array.isArray(grids) ? grids : [];
    const sCols = [
      'school_code',
      'school_name',
      'campus',
      'campus_label',
      'day_part',
      'period_index',
      'start_time',
      'end_time',
      'class_minutes',
      'break_minutes',
      'source',
      'note',
      'sort_order',
    ];
    const gCols = [
      'school_code',
      'school_name',
      'campus',
      'campus_label',
      'name',
      'row_mode',
      'row_labels',
      'row_periods',
      'total_weeks',
      'weekdays',
      'holiday_advance_minutes',
      'holiday_pm_from',
      'source',
      'note',
      'sort_order',
    ];
    /** 功能：`undefined` / `null` 一律写成 SQL 的 NULL，其余原样返回。 */
    const keep = (v) => (v === undefined || v === null ? null : v);
    /** 功能：按列名清单拼一条 INSERT 语句（占位符数量与列数一致）。 */
    const insertSql = (table, cols) =>
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const run = () => {
      this.db.exec('DELETE FROM time_timetable_school_schedules');
      this.db.exec('DELETE FROM time_timetable_school_grids');
      const insS = this.db.prepare(insertSql('time_timetable_school_schedules', sCols));
      sRows.forEach((r) => insS.run(...sCols.map((c) => keep(r[c]))));
      const insG = this.db.prepare(insertSql('time_timetable_school_grids', gCols));
      gRows.forEach((r) => insG.run(...gCols.map((c) => keep(r[c]))));
      return { schedules: sRows.length, grids: gRows.length };
    };
    this.db.exec('BEGIN');
    try {
      const r = run();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略 */
      }
      throw e;
    }
  },
};

const methods = {
  /**
   * 功能：为某个连接设置连接级 PRAGMA 调优（WAL、busy_timeout、synchronous、外键），并把实际生效
   *      结果记到 `journalMode` / `foreignKeys`（主库）或 `ledgerJournalMode`（记账库）上，
   *      供启动日志与自检读取。
   *
   * 说明（连接级调优，多用户并发基础）：
   *  - journal_mode=WAL  读写不互斥：读不再被写阻塞，写也不阻塞读（持久化在库文件头，只需设一次）
   *                      副作用：数据目录会多出 zxdesk.db-wal / zxdesk.db-shm 两个伴生文件
   *  - busy_timeout=5000 拿不到写锁时最多等 5s 再报错（每次连接都要设；避免瞬时并发直接 SQLITE_BUSY）
   *  - synchronous=NORMAL  WAL 下仍保证「进程崩溃不丢已提交事务」，仅「整机掉电」可能丢最后若干条
   *                      换来显著的写入性能，对看板这类小事务是划算的取舍
   *  - foreign_keys=ON    ⭐ v5：**外键默认是关的**，必须每个连接显式打开（这是 SQLite 的设计，
   *                      不是配置疏漏）。不打开则表上写的 ON DELETE CASCADE 只是注释。
   *  注：若数据目录落在 NFS/SMB 等网络文件系统，WAL 会因无法建立共享内存而设置失败，
   *      journal_mode 将保持 delete —— server.js 启动日志会明确告警（兼作网络盘自检）。
   *
   * ⭐ 0.8.1：参数化到「任意一个连接」—— 两个库**各调一次**（WAL 探测各报一次）。
   *    ⚠️ 结果**分开记**（记账库记进 `ledgerJournalMode`）：结果合到一个字段里，界面上就再也说不清
   *    「是哪个库没启用 WAL」，而这条日志的用处正是「一眼看出数据目录是不是网络盘」。
   *    ⚠️ 外键结果（`foreignKeys`）仍是**一个布尔**：它只在主库语境下被 `info()` 报出去，
   *    记账库那一侧照旧打开（下面的 `PRAGMA foreign_keys=ON` 对两个连接都跑），只是不再单独记录。
   *
   * @param {Object} db - 要调优的连接（主库或记账库）
   * @param {string} which - 库名，`'main'` / `'ledger'`（决定结果记到哪个字段）
   * @returns {void}
   */
  _tunePragmas(db, which) {
    const onLedger = which === SCHEMA.LEDGER_DB;
    if (onLedger) this.ledgerJournalMode = 'unknown';
    else {
      this.journalMode = 'unknown';
      this.foreignKeys = false;
    }
    try {
      db.exec('PRAGMA busy_timeout=5000');
    } catch (_e) {}
    try {
      db.exec('PRAGMA synchronous=NORMAL');
    } catch (_e) {}
    try {
      const row = db.prepare('PRAGMA journal_mode=WAL').get();
      const v = row ? row.journal_mode || Object.values(row)[0] : '';
      if (v) {
        if (onLedger) this.ledgerJournalMode = String(v).toLowerCase();
        else this.journalMode = String(v).toLowerCase();
      }
    } catch (_e) {}
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const r = db.prepare('PRAGMA foreign_keys').get();
      if (!onLedger) this.foreignKeys = !!(r && Number(Object.values(r)[0]));
    } catch (_e) {}
  },

  /**
   * 功能：在结构需要迁移前，用 `VACUUM INTO` 把**某个库**导出一份一致的快照文件，并轮转掉过旧的备份。
   *
   * 说明：迁移前自动备份（0.0.8）。
   *
   * 触发条件：**库文件本来就存在，且 `user_version` 落后于该库自己的结构版本**。
   * 全新库没有可丢的东西，不备份；已是最新版本不重复备份（幂等）。
   *
   * 用 `VACUUM INTO` 而不是拷贝文件：WAL 模式下直接拷 .db 会漏掉尚未 checkpoint 的事务，
   * VACUUM INTO 生成的是一份**一致的**单文件快照。
   *
   * 备份失败**不阻断启动**（宁可启动起来也别把人挡在门外），但会记进 `backupError`，
   * 由 server.js 在日志里显著告警、界面横幅提示。
   *
   * ⭐ 0.8.1：两个库**各来一次**。
   *    ⚠️ 记账库用自己的**前缀**（`zxdesk-ledger.db.bak-v…`）与**自己的版本号**
   *    （它数的是 `LEDGER_SCHEMA_VERSION`）—— 前缀不同才能各转各的圈，不至于两个库的备份
   *    混在一个名单里被按顺序砍掉一半。⚠️ 主库那一条的文件名规则**一个字没改**。
   *    ⚠️ 记账库那一侧失败只记 `ledgerInitError` 之外的信息：这里沿用 `backupError`
   *    这一个字段（它已经会进启动日志），把「哪个库」写进正文。
   *
   * @param {Object} db - 要备份的连接
   * @param {string} which - 库名，`'main'` / `'ledger'`
   * @returns {void}
   */
  _backupBeforeMigrate(db, which) {
    const onLedger = which === SCHEMA.LEDGER_DB;
    const want = onLedger ? SCHEMA.LEDGER_SCHEMA_VERSION : SCHEMA_VERSION;
    const existedBefore = onLedger ? this.ledgerExistedBefore : this.dbExistedBefore;
    const row = db.prepare('PRAGMA user_version').get();
    const version = Number(row && row.user_version) || 0;
    if (onLedger) this.ledgerSchemaVersion = version;
    else this.schemaVersion = version;

    // 本次启动是否需要迁移结构（⚠️ 0.8.12 起**只**决定「要不要动结构 / 先留一份退路」——
    // 「要不要跑 v5 那次整库重建」是另一件事，判据是常量 `REBUILD_UP_TO`，见 `_upgradeStructureToV5()`）
    const needs = existedBefore && version < want;
    if (onLedger) this.ledgerNeedsMigrate = needs;
    else this.needsMigrate = needs;
    if (!needs) return;

    const prefix = onLedger ? 'zxdesk-ledger.db' : 'zxdesk.db';
    const dest = path.join(this.dataDir, `${prefix}.bak-v${this.appVersion}-${compactStamp()}`);
    try {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      if (onLedger) this.ledgerBackupFile = dest;
      else this.backupFile = dest;
      this._rotateBackups();
    } catch (e) {
      const why = (e && e.message) || String(e);
      this.backupError = onLedger ? `记账库：${why}` : why;
    }
    // ⚠️ 这里**不再**推进 `user_version`（v5 改动）：
    //    它是「结构已经是最新的」的**承诺**。以前在备份后立刻推进，一旦后面的结构迁移失败或
    //    被跳过，版本号却已经写成 5 → 下次启动不再重试，库永远停在旧结构还自认为最新。
    //    现在只有迁移**真正跑完**才推进（主库见 `_migrateSqlite()`、记账库见 `_migrateLedgerSqlite()`）。
  },

  /**
   * 功能：只保留最近 BACKUP_KEEP 份自动备份，多出来的按时间顺序由旧到新删除；删不掉不影响启动。
   * 说明：备份文件名带时间戳，按名字排序即为时间顺序。
   * ⭐ 0.8.1：**两个前缀各转各的**（主库 `zxdesk.db.bak-v` / 记账库 `zxdesk-ledger.db.bak-v`）——
   *      合成一个名单轮转会让「份数上限」在两个库之间互相挤占（备份次数多的那个把另一个挤没），
   *      而两个库的备份**不能互相替代**。⚠️ 主库那一条的过滤前缀与保留份数都没变。
   * @returns {void}
   */
  _rotateBackups() {
    ['zxdesk.db.bak-v', 'zxdesk-ledger.db.bak-v'].forEach((prefix) => {
      try {
        const files = fs
          .readdirSync(this.dataDir)
          .filter((f) => f.startsWith(prefix))
          .sort();
        files.slice(0, Math.max(0, files.length - BACKUP_KEEP)).forEach((f) => {
          try {
            fs.unlinkSync(path.join(this.dataDir, f));
          } catch (_e) {
            /* 删不掉就算了，不影响启动 */
          }
        });
      } catch (_e) {
        /* 目录读不了也不影响启动 */
      }
    });
  },

  /**
   * 功能：按固定顺序执行整套结构迁移：表改名 → 建表 → 补列 → v5 结构重建 → 建索引 → 推进结构版本号。
   * 说明：顺序不可调换 —— 表改名必须排在建表之前（`CREATE TABLE IF NOT EXISTS` 会先把新表名占住，
   *      之后老表再想改名就撞名，结果是一张空的新表加一份搬不过去的老数据）；
   *      并且只有 `_upgradeStructureToV5()` 真正跑完且未被跳过，才允许推进 `user_version`。
   * @returns {void}
   */
  _migrateSqlite() {
    // 0) ⭐ 表改名迁移必须**排在建表之前**：
    //     `CREATE TABLE IF NOT EXISTS` 会先把新表名占住，之后老表再想改名就撞名了 ——
    //     结果是一张空的新表和一份搬不过去的老数据（界面上表现为「课表全没了」）。
    this._applyTableAliases();

    // 0b) ⭐ 列改名迁移必须**排在补列（第 2 步 ensureColumns）之前**：
    //     反过来的话，补列会先按新 DDL 把新列补出来（默认值 = 旧语义），旧列却还在 ——
    //     两边撞车，而它的表现是「设置里的开关全被重置」且**一声不吭**（见 `_applyColumnAliases`）。
    this._applyColumnAliases();

    // 1) 建表 —— DDL 来自各 schema 模块（唯一出处）：
    //    全新库直接拿到最新结构；已有库这里是 no-op（走第 3 步重建）。
    SCHEMA.createAll(this.db);

    // 2) 迁移：旧数据库补列（幂等）。清单由各模块自报（见 store/schema/*.js）
    SCHEMA.ensureColumns().forEach(([table, column, type]) => this._ensureColumn(table, column, type));

    // ⚠️ 这里**不再回填 start_date**（0.0.8 修正，别改回去）。
    // 老版本曾用 `UPDATE ... SET start_date = due_date WHERE start_date IS NULL` 来修「今日待办数漏算」，
    // 那是**用改写用户数据换统计正确**：老任务的开始日期被永久改掉，
    // 而前端表单的兜底又用「今天」，两处猜测不一致 → 界面上表现为「任务日期变了」。
    // 正确姿势是**改查询**（见 todayCounts 的 COALESCE），一行用户数据都不动。
    // 老任务缺开始日期的条数只做**上报**（legacyNullStartDates），由启动日志说明，绝不落写。

    // 3) ⭐ v5 结构升级：老库重建带外键/约束的表（新库跳过；见方法内注释）
    this._upgradeStructureToV5();

    // 4) 索引（幂等；必须在补列与重建之后建）
    // 建索引的理由：多用户后所有查询都带 user_id / project_id / 日期区间，全表扫描会随数据量线性劣化
    this._createIndexes();

    // 5) ⭐ 只有**真正跑完**才推进 schema 版本（v5 改动，见 _backupBeforeMigrate 的注释）
    if (!this.schemaUpgradeSkipped) {
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      this.schemaVersion = SCHEMA_VERSION;
    }
  },

  /**
   * 功能：把老库里的旧表名用 `ALTER TABLE ... RENAME TO` 改成现表名，不搬数据。
   *
   * 说明：表改名迁移（0.1.2：课表 5 张表加 `timetable_` 前缀；0.8.13：三块并版，16 张加 `time_` 前缀）。
   *
   * 用 `ALTER TABLE ... RENAME TO`，**不搬数据**：SQLite 只改 sqlite_master 里的名字，
   * 行、索引、自增序列全部原地保留 —— 这是最不容易出事的一种结构变更。
   *
   * ⚠️ **全有或全无**：只要发现任何一处撞名（新表名已被占），就**一张都不改**。
   *    撞名意味着「有另一批同名数据存在」（最现实的情形是：装过 0.1.2 → 降级回 0.1.1
   *    写了一批新数据 → 再升上来）。此时**绝不能替用户猜哪一份是对的**：
   *    半改（改了一部分表）会让数据分散在两套名字下，比一个清清楚楚的冲突难查得多。
   *    这里只记录冲突、原样保留所有表，由启动日志与「数据位置」面板显著告警。
   *
   * ⚠️⭐ **同一轮里两条 pending 指向同一个目标名，同样算冲突**（0.8.13 补的判据）：
   *    课表那 5 张各写了两对别名（`terms → X` ＋ `timetable_terms → X`）。正常库里只可能有一对命中
   *    （老库没有 `timetable_terms`、新库没有 `terms`），但**两张源表同时存在**时两条都会 pending ⇒
   *    第二条 `ALTER TABLE … RENAME TO` 撞名抛错，而它跑在启动迁移里 ⇒ **应用起不来**。
   *    按与上面完全一致的「全有或全无」语义处理：记冲突、一张都不改。
   *    （`ttt/test/schema.test.js` 的「改名冲突」用例正守着这一类构造。）
   *
   * @returns {void}
   */
  _applyTableAliases() {
    const has = (t) => !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

    const pending = [];
    /** 目标表名 → 已经认领它的源表名（防「两条 pending 改到同一个名字」） */
    const targetOwner = new Map();
    SCHEMA.aliases().forEach(([from, to]) => {
      if (!has(from)) return; // 没有老表（新库 / 已改过名）→ 无事可做
      if (has(to) || targetOwner.has(to)) {
        this.tableAliasConflicts.push(`${from} → ${to}`);
        return;
      }
      targetOwner.set(to, from);
      pending.push([from, to]);
    });

    if (this.tableAliasConflicts.length) return; // 全有或全无：有冲突就一张都不动

    pending.forEach(([from, to]) => {
      this.db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
      this.renamedTables.push(`${from} → ${to}`);
    });
  },

  /**
   * 功能：把老库里的旧列名用 `ALTER TABLE … RENAME COLUMN` 改成新列名，不搬数据（⭐ 0.8.12 新造的一档）。
   *
   * 说明：⭐ 与 `_applyTableAliases()`（表改名）**同性质**：SQLite 只改 `sqlite_master` 里的名字，
   *      行数据、索引、约束全部原地保留 —— 本项目里最不容易出事的一类结构变更。
   *      映射由定义该表的模块自报（`SCHEMA.columnAliases()`，见 `store/schema/index.js`）。
   *
   * ⚠️⭐ **它必须排在 `ensureColumns()` 之前**（`_migrateSqlite()` 的第 0b 步）：
   *      补列是幂等的 `ALTER TABLE ADD COLUMN`，会**按新 DDL** 把新列补出来 —— 对 `hide_*` 就是
   *      `NOT NULL DEFAULT 0` ＝ 显示。于是老列还留着旧值、新列被补成 0，而界面读的是新列
   *      ⇒ **用户关掉的模块自己又冒出来了**，且**一行日志都没有**。
   *
   * ⚠️ **幂等**：只在「老列在、新列不在」时才动。四种情形都安全跳过：
   *      ① 表不存在（新库 / 本模块没建）；② 新列已在（已改过名，或新库直接建出了新列）；
   *      ③ 老列也没有（与本次无关）；④ ⚠️ 两列**同时存在** —— 那是「补列先跑过一轮」的坏状态，
   *      这时替用户猜哪一列是对的只会把数据搞坏 ⇒ **什么都不做**，原样留着。
   *
   * @returns {void}
   */
  _applyColumnAliases() {
    const colsOf = (t) => {
      try {
        return this.db
          .prepare(`PRAGMA table_info("${t}")`)
          .all()
          .map((c) => c.name);
      } catch (_e) {
        return null; // 表读不了 → 交给调用方跳过（失败方向安全）
      }
    };

    SCHEMA.columnAliases().forEach(([table, from, to]) => {
      const cols = colsOf(table);
      if (!cols || !cols.length) return; // 表不存在 → 无事可做
      if (cols.includes(to)) return; // 新列已在 → 幂等跳过（含「两列同时存在」的坏状态）
      if (!cols.includes(from)) return; // 老列也没有 → 与本次无关
      this.db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${from}" TO "${to}"`);
      this.renamedColumns.push(`${table}.${from} → ${to}`);
    });
  },

  /**
   * 功能：把老库的表按「建新表 → 搬数据 → 删旧表 → 改名」重建成带外键与约束的 v5 结构，全程事务保护。
   *
   * 说明：⭐ v5：把老库的表重建成带外键与约束的结构。
   *
   * ⚠️⭐ **0.8.12 起它的判据是常量 `REBUILD_UP_TO`（＝5），与 `SCHEMA_VERSION` 脱钩**：
   *      v6（`chat` → `teamwork` 的改名迁移）只推版本号、**不再让老库重跑整库重建**（见那个常量的说明）。
   *
   * 为什么必须重建：SQLite **不支持** `ALTER TABLE ADD CONSTRAINT` —— 想加外键/CHECK/NOT NULL，
   * 只有官方那套「建新表 → 搬数据 → 删旧表 → 改名」的办法，没有捷径。
   *
   * 三条安全设计（每一条都是「宁可这次不升级，也不能留下一个坏库」）：
   *  ① **先体检，后动手**：老库里若有外键挂不上的孤儿行、或违反新 CHECK 的值，
   *     直接**放弃本次结构升级并显著告警**，库原样保留、版本号不推进（下次启动会再试）。
   *     绝不在迁移里「顺手把不合规的数据改掉」。
   *  ② **父表先重建**（V5_REBUILD_ORDER）：重建用 DROP + RENAME，父表必须存在于子表重命名的瞬间。
   *  ③ **全程事务 + 自检**：任何一步抛错或 `foreign_key_check` 不通过 → 整份回滚，库回到 v4 原样。
   *
   * @returns {void}
   */
  _upgradeStructureToV5() {
    // 全新库（文件本来不存在）建表时就已经是最新结构；**重建只针对「落后于 v5 的老库」**
    // ⚠️⭐ 这里的判据是常量 `REBUILD_UP_TO`（＝5）而**不是** `SCHEMA_VERSION`：
    //    0.8.12 推了 `v6`（chat → teamwork 的改名迁移），若用 `SCHEMA_VERSION`，
    //    所有 `user_version = 5` 的老库都会被判定「需要重建」而白跑一次整库重建（见常量处的说明）。
    if (!this.needsMigrate || this.schemaVersion >= REBUILD_UP_TO) return;

    const problems = this._v5Precheck();
    if (problems.length) {
      this.schemaUpgradeSkipped = problems.join('；');
      return;
    }

    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.db.exec('BEGIN');
      const normalized = {};
      for (const table of SCHEMA.rebuildOrder()) this._rebuildTableV5(table, normalized);
      // 事务内自检：有孤儿就直接回滚，绝不让「结构升级了但关系是坏的」落盘
      const bad = this.db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error(`外键自检未通过（${bad.length} 处）`);
      this.db.exec('COMMIT');
      this.structuralUpgrade = { from: this.schemaVersion, to: REBUILD_UP_TO, normalized };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略 */
      }
      this.schemaUpgradeSkipped = `重建失败已回滚：${(e && e.message) || String(e)}`;
    } finally {
      // ⚠️ 无论成败都要把外键打开：这是连接级开关，关着就等于没有外键
      try {
        this.db.exec('PRAGMA foreign_keys=ON');
      } catch (_e) {
        /* 忽略 */
      }
    }
  },

  /**
   * 功能：v5 迁移前做**只读**体检，列出「不能安全重建」的原因；空数组表示可以安全重建。
   *
   * 说明：v5 迁移前体检（**只读**）：返回「不能安全重建」的原因列表，空数组＝可以重建。
   *
   * 只查两件事：①外键挂不上的孤儿行 ②违反新 CHECK 约束的值。
   * 归属列（user_id）为 NULL 不在此列 —— 它在搬数据时会按 V5_NORMALIZE 归一化并记进报告
   * （语义不变：uidOf() 本来就把缺失当成 1 号账号）。
   *
   * @returns {Array.<string>} 问题描述列表；空数组表示可以安全重建
   */
  _v5Precheck() {
    const problems = [];
    const count = (sql) => {
      try {
        const r = this.db.prepare(sql).get();
        return r ? Number(Object.values(r)[0]) || 0 : 0;
      } catch (_e) {
        // 老库可能连表都不全（比如 0.0.2 时代）—— 建表语句已经把表补齐了，这里出错只会是结构异常
        return -1;
      }
    };
    const check = (sql, label) => {
      const n = count(sql);
      // -1 = 这条查询本身跑不通（表缺列等结构异常）—— 与「数据不合规」是两回事，分开措辞
      if (n < 0) problems.push(`结构异常：${label} 无法检查`);
      else if (n > 0) problems.push(`${label} ${n} 条`);
    };

    /** 功能：这张表在不在。 @param {string} name - 表名 @returns {boolean} 存在为 true */
    const hasTable = (name) => {
      try {
        return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
      } catch (_e) {
        return false;
      }
    };
    /**
     * 功能：**只在这张表存在时**才查（⭐ 0.7.9 修）。
     *
     * 说明：⚠️⭐ 这些查询 join 的都是**模块自己的表**，而模块可以被**整目录删掉**（「删目录验收」）——
     *      那时这个模块的建表语句根本没跑过、表不在，`count()` 会把「查不动」判成
     *      「**结构异常**」⇒ 预检永远不通过 ⇒ v5 结构升级被**永久拒绝**（`0.5.0` 起记的缺口，
     *      见 `AGENTS.md §七` 第 6 条 ②）。
     *      表都不在，就根本不可能有「指向不存在的学期」这种行 ⇒ 跳过是**正确**的，不是放水。
     *
     * @param {string} table - 判定存在性的表名（取该查询的主表）
     * @param {string} sql - 要跑的计数查询
     * @param {string} label - 问题描述
     * @returns {void}
     */
    const checkIf = (table, sql, label) => {
      if (hasTable(table)) check(sql, label);
    };

    check(
      `SELECT COUNT(*) FROM project_tasks x LEFT JOIN projects p ON p.id = x.project_id WHERE p.id IS NULL`,
      '项目任务指向不存在的项目',
    );
    checkIf(
      'time_timetable_blocks',
      `SELECT COUNT(*) FROM time_timetable_blocks x LEFT JOIN time_timetable_terms t ON t.id = x.term_id WHERE t.id IS NULL`,
      '时段块指向不存在的学期',
    );
    checkIf(
      'time_timetable_periods',
      `SELECT COUNT(*) FROM time_timetable_periods x LEFT JOIN time_timetable_terms t ON t.id = x.term_id WHERE t.id IS NULL`,
      '逐节时间指向不存在的学期',
    );
    checkIf(
      'time_timetable_courses',
      `SELECT COUNT(*) FROM time_timetable_courses x LEFT JOIN time_timetable_terms t ON t.id = x.term_id WHERE t.id IS NULL`,
      '课程指向不存在的学期',
    );
    checkIf(
      'time_timetable_sessions',
      `SELECT COUNT(*) FROM time_timetable_sessions x LEFT JOIN time_timetable_courses c ON c.id = x.course_id WHERE c.id IS NULL`,
      '课次指向不存在的课程',
    );
    checkIf(
      'time_timetable_sessions',
      `SELECT COUNT(*) FROM time_timetable_sessions x LEFT JOIN time_timetable_terms t ON t.id = x.term_id WHERE t.id IS NULL`,
      '课次指向不存在的学期',
    );
    check(
      `SELECT COUNT(*) FROM project_tasks WHERE (important IS NOT NULL AND important NOT IN (0,1))
                                        OR (urgent IS NOT NULL AND urgent NOT IN (0,1))`,
      '项目任务的「重要/紧急」不是 0 或 1',
    );
    check(
      `SELECT COUNT(*) FROM daily_tasks WHERE (important IS NOT NULL AND important NOT IN (0,1))
                                      OR (urgent IS NOT NULL AND urgent NOT IN (0,1))`,
      '日常任务的「重要/紧急」不是 0 或 1',
    );
    checkIf(
      'time_timetable_sessions',
      `SELECT COUNT(*) FROM time_timetable_sessions WHERE weekday IS NULL OR weekday NOT BETWEEN 1 AND 7`,
      '课次的星期不在 1~7',
    );
    checkIf(
      'time_timetable_blocks',
      `SELECT COUNT(*) FROM time_timetable_blocks WHERE (period_count IS NOT NULL AND period_count < 0)
                                         OR (class_minutes IS NOT NULL AND class_minutes < 1)
                                         OR (break_minutes IS NOT NULL AND break_minutes < 0)`,
      '时段块的节数/课时/课间为非法值',
    );
    checkIf(
      'time_timetable_terms',
      `SELECT COUNT(*) FROM time_timetable_terms WHERE total_weeks IS NOT NULL AND total_weeks < 1`,
      '学期的总周数小于 1',
    );
    return problems;
  },

  /**
   * 功能：重建单张表（v5）：按新 DDL 建临时表、搬过两边共有的列、核对行数一致后删旧表并改名。
   * 说明：列清单从 `PRAGMA table_info` 读，**不手写** —— 手写的列清单一定会与 DDL 漂移，
   *      而漂移的表现是「升级上来的库少了一列」。
   * @param {string} table - 要重建的表名
   * @param {Object} normalizedOut - 归一化计数累加器，键为 `表名.列名`、值为被归一化的行数
   * @returns {void}
   * @throws {Error} 没有模块声明该表，或重建前后行数不一致时抛出（由调用方整份回滚）
   */
  _rebuildTableV5(table, normalizedOut) {
    const tmp = `${table}__v5`;
    const mod = SCHEMA.MODULES.find((m) => m.tables[table]);
    if (!mod) throw new Error(`没有模块声明表 ${table}`);
    this.db.exec(`DROP TABLE IF EXISTS ${tmp}`);
    this.db.exec(mod.tables[table](tmp, false));

    const oldCols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
    const newCols = new Set(
      this.db
        .prepare(`PRAGMA table_info(${tmp})`)
        .all()
        .map((c) => c.name),
    );
    const norm = SCHEMA.normalizeOf(mod, table);

    // 只搬两边都有的列（新表新增的列交给 DEFAULT）
    const cols = oldCols.filter((c) => newCols.has(c));
    // 极老库（0.0.1）可能连 user_id 都没有，而新表里它是 NOT NULL 且无默认值 —— 补一个 1
    if (!cols.includes('user_id') && newCols.has('user_id')) cols.unshift('user_id');

    // 归一化列先数一遍条数（>0 会在启动日志里报出来，不做无声改写）
    Object.keys(norm).forEach((c) => {
      if (!cols.includes(c)) return;
      const n = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c}" IS NULL`).get().n) || 0;
      if (n > 0) normalizedOut[`${table}.${c}`] = n;
    });

    const list = cols.map((c) => `"${c}"`).join(', ');
    const select = cols
      .map((c) => {
        if (c === 'user_id' && !oldCols.includes('user_id')) return `1 AS "user_id"`;
        return norm[c] ? `COALESCE("${c}", ${norm[c]}) AS "${c}"` : `"${c}"`;
      })
      .join(', ');

    this.db.exec(`INSERT INTO ${tmp} (${list}) SELECT ${select} FROM ${table}`);

    // 行数必须一致 —— 少一条都是数据事故，宁可不升级
    const before = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const after = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${tmp}`).get().n);
    if (before !== after) throw new Error(`${table} 重建前后行数不一致：${before} → ${after}`);

    this.db.exec(`DROP TABLE ${table}`);
    this.db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  },

  /**
   * 功能：建齐全部索引：先清掉已废弃的索引名，再逐条执行各模块自报的索引语句，最后单独处理
   *      `users(username)` 唯一索引（建不上时降级为普通索引并记录原因）。
   *
   * 说明：索引（幂等，单一出处）。
   *
   * v5 体检结论（用真数据量跑 `EXPLAIN QUERY PLAN` 实测，不是推测）：
   *  - 删 `idx_ptasks_date_range` / `idx_dtasks_date_range`：**没有任何查询选中过它们**。
   *    今天的待办查询是 `user_id=? AND status!='done' AND due_date>=? AND COALESCE(start_date,due_date)<=?` ——
   *    COALESCE 不可索引，而这两个索引的前缀又没有 user_id，全表扫都得靠后过滤。
   *  - 删 `idx_dtasks_user_status`、加 `idx_dtasks_user_sort`：日常任务列表按 sort_order 排序，
   *    原来只能借 (user_id,status) 走前缀，排序要现搭临时 B-Tree（`USE TEMP B-TREE FOR ORDER BY`）；
   *    换成 (user_id,sort_order) 后临时排序消失，而待办统计照样能借它的 user_id 前缀。
   *  - `idx_ptasks_user_status` 保留：待办统计**真的**选中了它（删了会退化成全表扫描）。
   *
   * @returns {void}
   */
  _createIndexes() {
    // 先清掉已废弃的索引名（幂等）。⚠️ `ALTER TABLE RENAME` **不会**顺带改索引名，
    // 所以改名迁移后老索引可能还挂在老名字上；表被重建时本来会一起删，这里显式 DROP 是保险。
    SCHEMA.legacyIndexes().forEach((name) => {
      try {
        this.db.exec(`DROP INDEX IF EXISTS ${name}`);
      } catch (_e) {
        /* 删不掉不影响启动 */
      }
    });

    // 各模块自己的索引（新增功能模块时只改自己那个 schema 文件）。
    // ⚠️ **逐条 try/catch**：索引只是加速手段，建不上（例如库处于「升级被跳过」的半新半旧状态时
    //    某张表还缺列）绝不能让 `_migrateSqlite` 抛错 —— 那会被 `_init` 判成「库打不开」，
    //    整体降级为只读并把界面数据换成 JSON，代价远大于「少一个索引」。
    this.indexErrors = [];
    SCHEMA.indexStatements().forEach((sql) => {
      try {
        this.db.exec(sql);
      } catch (e) {
        this.indexErrors.push(`${(e && e.message) || String(e)}`);
      }
    });

    // username 唯一索引（登录名不可重复）—— 与上面的普通索引同属「索引」这一步。
    // ⚠️ 它**故意没有写进 core.js 的 indexes**：这里是唯一索引 + 降级逻辑，需要特殊处理。
    // ⚠️ 必须 try/catch 包住：若历史库里存在重复/空 username，建唯一索引会抛错，
    //    而 `_migrateSqlite` 抛错会让整个 _init 回退到 JSON **只读降级** —— 一条脏数据把整个库判成打不开，
    //    这个代价远大于「唯一性由应用层兜底」。故失败时降级为普通索引并记录原因，由启动日志显著告警。
    try {
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    } catch (e) {
      this.usersIndexError = (e && e.message) || String(e);
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_users_username_plain ON users(username)');
      } catch (_e) {
        /* 连普通索引都建不上也不影响启动 */
      }
    }
  },

  /**
   * 功能：统计 `start_date` 为空而 `due_date` 不为空的遗留任务条数（项目任务 + 日常任务合计）。
   *
   * 说明：只报告，不修改任何数据 —— 统计历史遗留任务（start_date 为空）的条数。
   *
   * ⚠️ 多用户提醒：这是**全库跨账号**的合计值，会经 `info().legacyNullStartDates` 出现在
   *    `/api/health` 与启动日志里。它不含任何内容，但**数量本身也是别人数据的痕迹**。
   *    给 `/api/health` 划分「成员可见 / 仅管理员可见」时，必须把它归到后者（或按会话过滤）。
   *
   * @returns {void}
   */
  _countLegacyNullStartDates() {
    try {
      const a = this.db
        .prepare('SELECT COUNT(*) AS c FROM project_tasks WHERE start_date IS NULL AND due_date IS NOT NULL')
        .get();
      const b = this.db
        .prepare('SELECT COUNT(*) AS c FROM daily_tasks WHERE start_date IS NULL AND due_date IS NOT NULL')
        .get();
      this.legacyNullStartDates = ((a && a.c) || 0) + ((b && b.c) || 0);
    } catch (_e) {
      /* 统计失败不影响启动 */
    }
  },

  /**
   * 功能：幂等补列 —— 表里还没有该列时执行 `ALTER TABLE ... ADD COLUMN` 把它补上。
   * ⭐ 0.8.1：可选参数 `conn` —— 记账库补列时必须显式给它自己的连接
   *      （补列清单是按库取出来的，`this.db` 此刻仍是主库；缺省值保持既有调用形态不变）。
   * @param {string} table - 表名
   * @param {string} column - 列名
   * @param {string} type - 列类型（DDL 片段，由各 schema 模块自报）
   * @param {Object} [conn] - 要用的连接，缺省 `this.db`
   * @returns {void}
   */
  _ensureColumn(table, column, type, conn) {
    const db = conn || this.db;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = cols.some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  },

  /**
   * 功能：取**某一张表所在的那个连接** —— 多库路由的唯一落点。
   *
   * 说明：⭐ 0.8.1：库的归属**只看表名**（判断来自 `store/schema/index.js` 的 `_dbFor`，
   *      而它又是从各模块 `module.json.database` 推出来的）——本文件里**不写第二份映射**。
   *
   * ⚠️ 为什么通用写原语（`insert` / `update`）必须走这里，而不是一律用 `this.db`：
   *    记账表住在第二个库，写错连接的表现是 `no such table` 直接抛错；
   *    而「先按主库写、再发现表不在」这种半路失败会留下掩盖不了的不一致。
   *
   * ⚠️ 记账库连不上时（`_initLedgerDb` 打开失败）`this.ledgerDb` 是 `null` —— 这里**不抛错**：
   *    抛错由 `_assertLedgerWritable()`（503）负责，它的消息能说清「是谁不可用、为什么」。
   *    本函数解析到 null 后由 `node:sqlite` 自己报 TypeError；写路径上这一层已经被前面的
   *    503 守卫挡住（业务方法进来之前就断言过），所以这里不重复造消息。
   *
   * @param {string} table - 表名，由调用方保证取自固定白名单
   * @returns {Object} 主库连接或记账库连接
   */
  _connFor(table) {
    return this._dbFor(table) === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
  },

  /**
   * 功能：统一读取入口 —— 执行一条查询并把全部结果行作为数组返回。
   * 说明：统一读取（sqlite: 返回行数组；json: 返回对象），两个后端由此保持同一调用形态。
   *
   * ⭐ 0.8.1：多出可选的第三个参数 `conn` —— 模块自己的原语（`modules/<模块>/backend/*.js`）
   *      照旧只传 `(sql, params)`，落到 `this.db` 上；而调用方在 `_runOnLedger()` 里
   *      **临时把 `this.db` 换成记账库连接**，于是那些原语一个字不改就查到了记账库
   *      （模块原语接口不改）。显式传 `conn` 的调用方是「同一次操作里要读两个库」的场合
   *      （跨库导出 / 数量聚合），它们自己指定连接、不依赖当时的 `this.db` 是哪一个。
   *
   * @param {string} sql - 查询语句
   * @param {Array.<*>} params - 绑定参数
   * @param {Object} [conn] - 要用的连接，缺省 `this.db`
   * @returns {Array.<Object>} 结果行数组
   */
  _listSql(sql, params, conn) {
    const db = conn || this.db;
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    return rows;
  },

  /**
   * 功能：取某张表的真实列名清单（整体恢复时用来过滤备份行里的键）。
   * ⭐ 0.8.1：可选参数 `conn` —— 整体恢复按库分段执行，列清单必须从**那一段的连接**读
   *      （表就住在那一侧），缺省仍是 `this.db`（既有调用形态不变）。
   * @param {string} table - 表名，由调用方保证取自 `SCHEMA.tableNames()`
   * @param {Object} [conn] - 要用的连接，缺省 `this.db`
   * @returns {Array.<string>} 列名数组，顺序与建表语句一致
   */
  _tableCols(table, conn) {
    const db = conn || this.db;
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  },
};

module.exports = { ops, methods };
