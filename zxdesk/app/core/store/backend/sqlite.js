'use strict';
/**
 * core/store/backend/sqlite.js —— SQLite 后端的**实现**
 * 功能：提供 SQLite 后端的全部存储原语与生命周期方法，作为 Store 的一份后端实现。
 * `ops`：**尚未搬进模块目录的那批存储原语**（项目 / 任务 / 课表 / 账号 / 设置的增删改查），
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA, SCHEMA_VERSION, BACKUP_KEEP, IMPORT_KEEP_TABLES, dbLabelOf } = require('../constants.js');
const { compactStamp, deref } = require('../helpers.js');

/**
 * **v5 那次整库重建的「到此为止」界限** —— 它是一个**历史常量**，⛔ 不跟着 `SCHEMA_VERSION` 走。
 *
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
    // 按「这张表住在哪个库」选连接（`_dbFor` 的唯一出处是 store/schema/index.js）
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
   */
  update(table, uid, id, setKeys, values) {
    const sql = `UPDATE ${table} SET ${setKeys.map((k) => k + '=?').join(',')} WHERE id=? AND user_id=?`;
    // 同上 —— 通用写原语也要按表分派（记账表住第二个库）
    const r = this._connFor(table)
      .prepare(sql)
      .run(...values, id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：导出该账号的**核心**数据（项目、两类任务、账号行），供「完整备份」使用。
   * （`store/methods/stats.js` 的 `exportFragments()` 把各模块片段合并进同一份备份）；
   * 这里只剩核心自己拥有的那几张表。
   * @param {number} uid - 用户 id
   * @returns {Object} 各表行数组的集合（projects / ptasks / dtasks / users）
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
   * 形状与三个键一个字没变，调用方（管理面板的「删除成员」提示）不用改。
   * 这三张表今天都在主库，但**不能因此写死 `this.db`**：以后哪张表搬了库，
   *
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
   * 把正在用的人踢下线没有任何道理（被踢的表现是「改个开关突然要重新登录」）。
   *
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
   * 改个开关不该把人踢下线。⚠️ 只改自己勾的那一列：两个偏好必须能**互不影响**地开关
   * （关课表不该顺手把收藏夹也关掉）。
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
   * **不碰 `session_epoch`**，改个开关不该把人踢下线（
   * 「也要像课表一样可以在设置中关闭这个功能」）。
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
   * 只是显示偏好，**不碰 `session_epoch`**，改个开关不该把人踢下线
   * （「也要像课表一样可以在设置中关闭这个功能」）。
   */
  setHideVault(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_vault=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的「不显示对话」偏好并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与上面四个显示开关**同一条规矩、同一个理由**——
   * 只是显示偏好，**不碰 `session_epoch`**，改个开关不该把人踢下线
   * （「也要像课表一样可以在设置中关闭这个功能」）。
   */
  setHideTeamwork(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_teamwork=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示 AI 辅助任务」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideTeamwork` 同一条规矩：**只是这个账号自己的偏好**
   * （不是全局设置），**不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：六个偏好必须能**互不影响**地开关。
   */
  setHideAi(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_ai=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示灵感库」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideAi` 同一条规矩：**只是这个账号自己的偏好**，
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：七个偏好必须能**互不影响**地开关。
   */
  setHideIdea(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_idea=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示 zx 实验室」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideIdea` 同一条规矩：**只是这个账号自己的偏好**，
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：十三个偏好必须能**互不影响**地开关。
   */
  setHideLab(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_lab=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：记下「这个账号已同意 zx 实验室使用须知」，并刷新 `updated_at`。
   *
   * 说明：⭐ 首次进入实验室要弹知情协议、勾选过后才能点同意，
   * 且按账号记在服务端 —— 与 `setHideLab` **同一条规矩**：只改自己那一列、
   * 不碰 `session_epoch`、删账号随行消失。
   */
  setLabAgreed(uid, agreed, stamp) {
    const r = this.db
      .prepare('UPDATE users SET lab_agreed=?, updated_at=? WHERE id=?')
      .run(agreed ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示番茄钟」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideIdea` 同一条规矩：**只是这个账号自己的偏好**，
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：八个偏好必须能**互不影响**地开关。
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
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：九个偏好必须能**互不影响**地开关。
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
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：所有偏好必须能**互不影响**地开关。
   */
  setHideDigital(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_digital=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示记账」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideCalendar` 同一条规矩：**只是这个账号自己的偏好**，
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：十个偏好必须能**互不影响**地开关。
   */
  setHideLedger(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_ledger=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号「不显示行程」开关并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideLedger` 同一条规矩：**只是这个账号自己的偏好**，
   * **不碰 `session_epoch`**，改个开关不踢人下线。
   * 只改自己勾的那一列：十一个偏好必须能**互不影响**地开关。
   */
  setHideTrip(uid, hide, stamp) {
    const r = this.db.prepare('UPDATE users SET hide_trip=?, updated_at=? WHERE id=?').run(hide ? 1 : 0, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：写入某个账号的**记账眼睛初值**（1 = 进来就把金额糊成圆点）并刷新 `updated_at`。
   *
   * 说明：⭐ 与 `setHide*` 同一条规矩：**只是显示偏好，不碰 `session_epoch`** ——
   * 它与上面那些**语义不同**：那些是「关掉某个功能」，这一列是「金额默认糊不糊」——
   * 用户当场仍能点眼睛看回来（那一次只改内存，不落库）。
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
   * 与空串「排了个空的」是两回事，见 `schema/core.js` 建表语句）。
   * `node:sqlite` 的 `null` 绑定落库就是 SQL NULL ✅（⛔ 别在这里做
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
   */
  setNavTabs(uid, value, stamp) {
    const r = this.db.prepare('UPDATE users SET nav_tabs=?, updated_at=? WHERE id=?').run(value, stamp, uid);
    return r.changes > 0;
  },

  /**
   * 功能：改写某个账号的密码库**自动锁定分钟数**并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setHideVault` 同一条规矩：**只是这个账号自己的偏好**（不是全局设置），
   * **不碰 `session_epoch`**。放在 `users` 行上的理由与四个显示开关完全一致
   * ：`settings` 是全局键值表，而「多久自动锁」显然是每人一套；
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
   * **原样搬进了 `modules/tasks/backend/sqlite.js` 的 `exportTasks()` 原语**（含各自的 `ORDER BY`）——
   * 任务板是一个模块，它的表就该由它自己导出。
   * ⇒ 这里只剩核心自己拥有的那一张表（`users`），其余模块的键由
   */
  exportAll(uid) {
    const users = this.db.prepare('SELECT * FROM users WHERE id=?').all(uid);
    return { users };
  },

  /**
   * 功能：改写某个账号的登录名并刷新 `updated_at`，返回是否更新到了行。
   *
   * 说明：⭐ 与 `setAdminFlag` / `setHideTimetable` 一样**不碰 `session_epoch`** ——
   * 登录名不参与会话校验（Cookie 里是 `uid` + `session_epoch`），改个名字就把人在其他设备上
   * 踢下线没有任何道理。
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
   * DELETE、JSON 分支另有一个数组字面量，两处不对称：加一张带 user_id 的新表时只要漏改一处，
   * 就会留下「账号没了、数据还在库里」的残留；外键的 ON DELETE CASCADE 只覆盖父子关系
   * （user_id 故意没加外键），所以仍然逐表显式删。
   */
  deleteUser(u) {
    // 三库之后是**三段执行**（实验室 → 记账 → 主库）。为什么实验室排在记账前面：
    // 两段之间没有事务（跨连接做不到），任何一段失败都会留下「前一段已删」的中间态；
    // 次序的唯一硬约束仍然是「**账号行最后删**」：反过来的话，某一段失败就留下
    for (const dbName of [SCHEMA.LAB_DB, SCHEMA.LEDGER_DB]) {
      const tables = SCHEMA.userScopedTablesIn(dbName);
      if (!tables.length) continue;
      if (dbName === SCHEMA.LAB_DB) this._assertLabWritable();
      else this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LAB_DB ? this.labDb : this.ledgerDb;
      conn.exec('BEGIN IMMEDIATE');
      try {
        tables.forEach((t) => conn.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u));
        conn.exec('COMMIT');
      } catch (e) {
        try {
          conn.exec('ROLLBACK');
        } catch (_e) {
          /* 回滚本身失败无可挽回，把原始错误抛出去 */
        }
        const err = new Error(
          `删除账号时清空${dbLabelOf(dbName)}数据失败（账号与其余数据**一个字节都没动**，可以再点一次）：${(e && e.message) || e}`,
        );
        err.status = 500;
        throw err;
      }
    }

    // ---- 第三段：主库（过对话 → 通用清空 → 好友补刀 → 收拾孤儿 → 删账号行）----
    // 这三段**对话专属**的处置已搬进 `modules/teamwork/`
    // （业务方法 → 模块自己的两个 op），核心这里只剩**两个可选钩子**（先例：`_seedModuleData()`）。
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

  // ---- 个人授权目录（跨模块的「我授权过哪些目录」登记）----

  /**
   * 功能：列出某账号登记过的全部授权目录（按路径升序）。
   *
   * 说明：⚠️ 这里**只读登记表**，不问飞牛宿主 —— 「现在还有没有效」是业务层的事
   * （要调 `trim.file.getUserAccessibleFolders`，走 `store/methods/grants.js`）。
   * 排序用 `path` 升序而不是时间：界面上这几行是「一份清单」，位置稳定比「最近加的在上面」重要
   */
  listDirGrants(uid) {
    return this._listSql('SELECT * FROM user_dir_grants WHERE user_id=? ORDER BY path ASC', [uid]);
  },

  /**
   * 功能：登记 / 更新一个授权目录（按 `(user_id, path)` 唯一键 upsert）。
   *
   * 说明：⭐⭐ `granted_at` 用 `COALESCE(旧值, 新值)` —— **只写第一次**。
   * 它是「曾经成功授权过」的凭据（「需重新授权」与「未授权」的分界线），
   * 每次重新授权都覆盖成今天，就再也说不出「这个目录是当初什么时候给的」。
   */
  saveDirGrant(uid, row) {
    const r = row || {};
    const s = (v) => (v == null ? null : String(v));
    this.db
      .prepare(
        `INSERT INTO user_dir_grants (user_id, path, purpose, source, granted_at, checked_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, path) DO UPDATE SET
           purpose=excluded.purpose,
           source=excluded.source,
           granted_at=COALESCE(user_dir_grants.granted_at, excluded.granted_at),
           checked_at=excluded.checked_at,
           updated_at=excluded.updated_at`,
      )
      .run(
        Number(uid),
        String(r.path || ''),
        String(r.purpose || ''),
        String(r.source || ''),
        s(r.granted_at),
        s(r.checked_at),
        s(r.created_at),
        s(r.updated_at),
      );
    return true;
  },

  /**
   * 功能：删掉一条授权目录登记（**只删这一行，不碰任何文件、也不动宿主授权**）。
   * @param {number} uid - 账号 id
   * @param {string} path - 目录绝对路径（登记时的原样）
   * @returns {boolean} 真的删掉了一行为 true
   */
  deleteDirGrant(uid, path) {
    const r = this.db
      .prepare('DELETE FROM user_dir_grants WHERE user_id=? AND path=?')
      .run(Number(uid), String(path));
    return r.changes > 0;
  },


  /**
   * 功能：把**全库所有表**导出成一个「表名 → 行数组」的对象（整体备份的底层读取口）。
   *
   * 说明：⭐ 表名清单来自 `SCHEMA.tableNames()`，**不手写枚举** —— 将来加一张新表，
   * 整体备份自动带上它；手写清单漏一张的表现是「备份看着成功、恢复后那张表空了」。
   *
   */
  exportWhole() {
    // 先过一道闸门再逐表读：少了它，记账库打不开时这里会撞一个 **null 句柄**，
    // 用户拿到的是一句英文内部错（`Cannot read properties of null`），
    if (SCHEMA.ledgerTables().length) this._assertLedgerWritable();
    if (SCHEMA.labTables().length) this._assertLabWritable();
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
   * ① 每个库各自包在自己的 `BEGIN IMMEDIATE` 里，该库任何一步抛错都 `ROLLBACK`；
   * ② 调用方（`methods/backup.js`）必须**先**把当前库另存一份再调这里；
   */
  replaceWhole(tables) {
    const src = tables || {};
    const names = SCHEMA.tableNames();
    // 三段的次序：实验室 → 记账 → 主库（理由见方法说明；与 `deleteUser` 同一条次序）
    const segments = [SCHEMA.LAB_DB, SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB];
    const applied = [];
    const skipped = [];
    const has = (t) => Object.prototype.hasOwnProperty.call(src, t);
    for (const dbName of segments) {
      const mine = names.filter((t) => this._dbFor(t) === dbName);
      if (!mine.length) continue;
      // 备份里**一张实验室的表都没有** ⇒ 整段**跳过**，现有实验室库保持不动。
      // 这是全项目唯一的「失败方向必须是少删」的地方：恢复是唯一会删用户数据的操作，
      // 一份不含实验室的旧备份不该把用户的实验数据清空。
      if (dbName === SCHEMA.LAB_DB && !mine.some(has)) {
        skipped.push(dbName);
        continue;
      }
      // 分库那一段进门前先过闸门：库打不开时这里会撞 null 句柄，
      // 而「全量替换到一半撞内部错」是最不该出现的形态（宁可整次拒绝、什么都别动）。
      if (dbName === SCHEMA.LAB_DB) this._assertLabWritable();
      else if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LAB_DB ? this.labDb : dbName === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
      conn.exec('BEGIN IMMEDIATE');
      try {
        conn.exec('PRAGMA defer_foreign_keys=ON');
        // 删除按**倒序**（子表先走），插入按正序（父表先到）—— 与外键方向一致
        // 先按库过滤再倒序：倒序是「模块声明顺序」的倒序，过滤不改变同一个库内部的相对次序
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
          ? `⚠️「${applied.map(dbLabelOf).join('、')}」那一段**已经生效且不回滚**，` +
            `当前处于「部分恢复」状态 —— 请重试一次（重跑就是照着同一份备份再写一遍）。`
          : '所有段都还没生效，数据仍是操作前的样子。';
        const err = new Error(
          `整体恢复的「${dbLabelOf(dbName)}」那一段失败：${(e && e.message) || e}。${did}`,
        );
        err.status = 500;
        throw err;
      }
    }
    return { skipped };
  },

  /**
   * 功能：清空**某一个账号**名下的全部业务数据（个人导入的「替换」模式用）。
   *
   * 说明：⚠️ **不动 `users` 行** —— 账号本身、口令、管理员身份都不属于「业务数据」，
   * 要清哪些表同样来自 `USER_SCOPED_TABLES`（唯一出处）。
   *
   */
  clearUserData(uid) {
    const u = Number(uid);
    // 对话四张表**刻意跳过**（`IMPORT_KEEP_TABLES`）：它们是跨账号数据、而且个人导入不重建它们，
    // 清掉等于白丢一段真实聊天记录（详细理由写在 store/constants.js 那张清单上）。
    const keep = (t) => !IMPORT_KEEP_TABLES.includes(t);
    // 三库三段（实验室 → 记账 → 主库）—— 与 `deleteUser` / `replaceWhole` 同一条次序
    [SCHEMA.LAB_DB, SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB].forEach((dbName) => {
      const mine = SCHEMA.userScopedTablesIn(dbName).filter(keep);
      if (!mine.length) return;
      // 分库那一段先过闸门（理由与 `replaceWhole` 那条一字不差：null 句柄换不来任何有用信息）
      if (dbName === SCHEMA.LAB_DB) this._assertLabWritable();
      else if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LAB_DB ? this.labDb : dbName === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
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
        const err = new Error(`清空账号数据时「${dbLabelOf(dbName)}」那一段失败：${(e && e.message) || e}`);
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
   * 「项目 → 项目任务」「学期 → 课次」的树，中途失败而只写进去一半，
   * 留下的就是一堆挂不上父项的孤儿行。一个事务要么全成、要么全不写。
   */
  insertMany(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const out = [];
    const applied = [];
    // 三库三组（实验室 → 记账 → 主库）—— 与其余跨库操作同一次序
    [SCHEMA.LAB_DB, SCHEMA.LEDGER_DB, SCHEMA.MAIN_DB].forEach((dbName) => {
      const mine = list.filter((it) => this._dbFor(it.table) === dbName);
      if (!mine.length) return;
      // 分库那一组先过闸门（理由同上：null 句柄换不来任何有用信息）
      if (dbName === SCHEMA.LAB_DB) this._assertLabWritable();
      else if (dbName === SCHEMA.LEDGER_DB) this._assertLedgerWritable();
      const conn = dbName === SCHEMA.LAB_DB ? this.labDb : dbName === SCHEMA.LEDGER_DB ? this.ledgerDb : this.db;
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
          ? `⚠️「${applied.map(dbLabelOf).join('、')}」那一段**已经写入且不回滚**（个人导入是逐条追加，重来一次只会多出这一段的副本，请先清空或改用替换模式）。`
          : '所有段都还没写入。';
        const err = new Error(
          `导入写入时「${dbLabelOf(dbName)}」那一段失败：${(e && e.message) || e}。${did}`,
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
   * checkpoint 的事务，快照看着存在、恢复回去却少一截数据 —— 那是最坏的「安全网」。
   * 它与 `_backupBeforeMigrate` 用的是同一个手法。
   * **失败必须抛**，不能像迁移前备份那样只记 `backupError` 就放行：那个是「升级顺手做的好事」，
   */
  snapshot(tag) {
    const safe = String(tag || 'manual').replace(/[^\w-]/g, '');
    const stamp = compactStamp();
    const name = `zxdesk.db.bak-${safe}-${stamp}`;
    const dest = path.join(this.dataDir, name);
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    // 记账库那一侧：用同一套命名规则、只换前缀。**不做「记账库不在就跳过」** ——
    // 在需要退路的这条路上「静默少一份」比直接失败糟得多（调用方以为两库都有退路）。
    // 先过闸门：库打不开时这里会撞 null 句柄，而这一步的语义是「马上就要全量替换、
    this._assertLedgerWritable();
    const ledgerDest = path.join(this.dataDir, `zxdesk-ledger.db.bak-${safe}-${stamp}`);
    this.ledgerDb.exec(`VACUUM INTO '${ledgerDest.replace(/'/g, "''")}'`);
    // **第三个库**同款 —— 同一命名规则、只换前缀。
    // 与记账库同一条纪律：不做「这个库不在就跳过」—— 在需要退路的这条路上
    // 「静默少一份」比直接失败糟得多（调用方会以为三库都有退路）。
    this._assertLabWritable();
    const labDest = path.join(this.dataDir, `zxdesk-lab.db.bak-${safe}-${stamp}`);
    this.labDb.exec(`VACUUM INTO '${labDest.replace(/'/g, "''")}'`);
    return name;
  },

  /**
   * 功能：导出整库的**原始字节**（整体备份压缩包里的那个 `zxdesk.db`），随即删掉临时文件。
   *
   * 说明：⭐ 与 `snapshot()` 用的是同一个手法（`VACUUM INTO`）—— **绝不能改成 `fs.copyFileSync`**：
   * WAL 模式下最近提交的事务还在 `zxdesk.db-wal` 里，直接拷主文件会得到一份「看着在、
   * 临时文件写在数据目录里（`VACUUM INTO` 只能落盘），读完当场删掉 —— 它只是打包的中间产物，
   */
  rawDump() {
    // 先过闸门：库打不开时这里会撞 null 句柄（一句内部英文错），而它的语义是
    // 「导出**两个库**的原始字节」—— 少一个库的降级路径不该以内部错收场。
    this._assertLedgerWritable();
    // 实验室库同款闸门（少一份就不是「整体备份」了）
    this._assertLabWritable();
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
    return [
      dumpOf(this.db, 'zxdesk.db'),
      dumpOf(this.ledgerDb, 'zxdesk-ledger.db'),
      // 第三个成员（顺序与其余跨库操作一致：主库在前、分库随后）
      dumpOf(this.labDb, 'zxdesk-lab.db'),
    ];
  },


  /**
   * 功能：读出两张内置高校模板表的全部行 —— 内置作息表（逐节时间）与内置课程表（课表版式）。
   *
   * 说明：⭐ 这两张表**不属于任何账号**，所以本 op 没有 `uid` 参数：它们是随应用发布的内置数据，
   * 所有账号看到的是同一份。数据源是 `core/timetable/school-templates.js`，
   * 启动时由 `store.seedSchoolTemplates()` 同步进来（见该方法的说明）。
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
   * 删掉一所学校、或改掉某节的 5 分钟，都必须在库里如实反映出来。
   *
   * 只碰这两张内置表，**一行用户数据都不动**。
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
   * 结果记到 `journalMode` / `foreignKeys`（主库）或 `ledgerJournalMode`（记账库）上，
   * 供启动日志与自检读取。
   *
   * 说明（连接级调优，多用户并发基础）：
   */
  _tunePragmas(db, which) {
    const onLedger = which === SCHEMA.LEDGER_DB;
    const onLab = which === SCHEMA.LAB_DB;
    if (onLedger) this.ledgerJournalMode = 'unknown';
    else if (onLab) this.labJournalMode = 'unknown';
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
        else if (onLab) this.labJournalMode = String(v).toLowerCase();
        else this.journalMode = String(v).toLowerCase();
      }
    } catch (_e) {}
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const r = db.prepare('PRAGMA foreign_keys').get();
      if (!onLedger && !onLab) this.foreignKeys = !!(r && Number(Object.values(r)[0]));
    } catch (_e) {}
  },

  /**
   * 功能：在结构需要迁移前，用 `VACUUM INTO` 把**某个库**导出一份一致的快照文件，并轮转掉过旧的备份。
   *
   *
   * 触发条件：**库文件本来就存在，且 `user_version` 落后于该库自己的结构版本**。
   * 全新库没有可丢的东西，不备份；已是最新版本不重复备份（幂等）。
   */
  _backupBeforeMigrate(db, which) {
    const onLedger = which === SCHEMA.LEDGER_DB;
    const onLab = which === SCHEMA.LAB_DB;
    const want = onLedger
      ? SCHEMA.LEDGER_SCHEMA_VERSION
      : onLab
        ? SCHEMA.LAB_SCHEMA_VERSION
        : SCHEMA_VERSION;
    const existedBefore = onLedger ? this.ledgerExistedBefore : onLab ? this.labExistedBefore : this.dbExistedBefore;
    const row = db.prepare('PRAGMA user_version').get();
    const version = Number(row && row.user_version) || 0;
    if (onLedger) this.ledgerSchemaVersion = version;
    else if (onLab) this.labSchemaVersion = version;
    else this.schemaVersion = version;

    // 「要不要跑 v5 那次整库重建」是另一件事，判据是常量 `REBUILD_UP_TO`，见 `_upgradeStructureToV5()`）
    const needs = existedBefore && version < want;
    if (onLedger) this.ledgerNeedsMigrate = needs;
    else if (onLab) this.labNeedsMigrate = needs;
    else this.needsMigrate = needs;
    if (!needs) return;

    const prefix = onLedger ? 'zxdesk-ledger.db' : onLab ? 'zxdesk-lab.db' : 'zxdesk.db';
    const dest = path.join(this.dataDir, `${prefix}.bak-v${this.appVersion}-${compactStamp()}`);
    try {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      if (onLedger) this.ledgerBackupFile = dest;
      else if (onLab) this.labBackupFile = dest;
      else this.backupFile = dest;
      this._rotateBackups();
    } catch (e) {
      const why = (e && e.message) || String(e);
      this.backupError = onLedger ? `记账库：${why}` : onLab ? `实验室库：${why}` : why;
    }
    // 这里**不再**推进 `user_version`（v5 改动）：
    // 被跳过，版本号却已经写成 5 → 下次启动不再重试，库永远停在旧结构还自认为最新。
    // 现在只有迁移**真正跑完**才推进（主库见 `_migrateSqlite()`、记账库见 `_migrateLedgerSqlite()`）。
  },

  /**
   * 功能：只保留最近 BACKUP_KEEP 份自动备份，多出来的按时间顺序由旧到新删除；删不掉不影响启动。
   * 说明：备份文件名带时间戳，按名字排序即为时间顺序。
   * **两个前缀各转各的**（主库 `zxdesk.db.bak-v` / 记账库 `zxdesk-ledger.db.bak-v`）——
   * 而两个库的备份**不能互相替代**。⚠️ 主库那一条的过滤前缀与保留份数都没变。
   * @returns {void}
   */
  _rotateBackups() {
    ['zxdesk.db.bak-v', 'zxdesk-ledger.db.bak-v', 'zxdesk-lab.db.bak-v'].forEach((prefix) => {
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
   * 之后老表再想改名就撞名，结果是一张空的新表加一份搬不过去的老数据）；
   * 并且只有 `_upgradeStructureToV5()` 真正跑完且未被跳过，才允许推进 `user_version`。
   * @returns {void}
   */
  _migrateSqlite() {
    // 0) ⭐ 表改名迁移必须**排在建表之前**：
    // `CREATE TABLE IF NOT EXISTS` 会先把新表名占住，之后老表再想改名就撞名了 ——
    // 结果是一张空的新表和一份搬不过去的老数据（界面上表现为「课表全没了」）。
    this._applyTableAliases();

    // 0b) ⭐ 列改名迁移必须**排在补列（第 2 步 ensureColumns）之前**：
    // 反过来的话，补列会先按新 DDL 把新列补出来（默认值 = 旧语义），旧列却还在 ——
    // 两边撞车，而它的表现是「设置里的开关全被重置」且**一声不吭**（见 `_applyColumnAliases`）。
    this._applyColumnAliases();

    // 1) 建表 —— DDL 来自各 schema 模块（唯一出处）：
    // 全新库直接拿到最新结构；已有库这里是 no-op（走第 3 步重建）。
    SCHEMA.createAll(this.db);

    // 2) 迁移：旧数据库补列（幂等）。清单由各模块自报（见 store/schema/*.js）
    SCHEMA.ensureColumns().forEach(([table, column, type]) => this._ensureColumn(table, column, type));

    // 老版本曾用 `UPDATE ... SET start_date = due_date WHERE start_date IS NULL` 来修「今日待办数漏算」，
    // 那是**用改写用户数据换统计正确**：老任务的开始日期被永久改掉，
    // 而前端表单的兜底又用「今天」，两处猜测不一致 → 界面上表现为「任务日期变了」。

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
   *
   * 用 `ALTER TABLE ... RENAME TO`，**不搬数据**：SQLite 只改 sqlite_master 里的名字，
   * 行、索引、自增序列全部原地保留 —— 这是最不容易出事的一种结构变更。
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
   *
   * 说明：⭐ 与 `_applyTableAliases()`（表改名）**同性质**：SQLite 只改 `sqlite_master` 里的名字，
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
   * v6（`chat` → `teamwork` 的改名迁移）只推版本号、**不再让老库重跑整库重建**（见那个常量的说明）。
   */
  _upgradeStructureToV5() {
    // 全新库（文件本来不存在）建表时就已经是最新结构；**重建只针对「落后于 v5 的老库」**
    // 这里的判据是常量 `REBUILD_UP_TO`（＝5）而**不是** `SCHEMA_VERSION`：
    // 推了 `v6`（chat → teamwork 的改名迁移），若用 `SCHEMA_VERSION`，
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
      // 无论成败都要把外键打开：这是连接级开关，关着就等于没有外键
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
   */
  _v5Precheck() {
    const problems = [];
    const count = (sql) => {
      try {
        const r = this.db.prepare(sql).get();
        return r ? Number(Object.values(r)[0]) || 0 : 0;
      } catch (_e) {
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
     *
     * 说明：⚠️⭐ 这些查询 join 的都是**模块自己的表**，而模块可以被**整目录删掉**——
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
   * 而漂移的表现是「升级上来的库少了一列」。
   * @param {string} table - 要重建的表名
   * @param {Object} normalizedOut - 归一化计数累加器，键为 `表名.列名`、值为被归一化的行数
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
   * `users(username)` 唯一索引（建不上时降级为普通索引并记录原因）。
   *
   * 说明：索引（幂等，单一出处）。
   *
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
    // **逐条 try/catch**：索引只是加速手段，建不上（例如库处于「升级被跳过」的半新半旧状态时
    // 某张表还缺列）绝不能让 `_migrateSqlite` 抛错 —— 那会被 `_init` 判成「库打不开」，
    this.indexErrors = [];
    SCHEMA.indexStatements().forEach((sql) => {
      try {
        this.db.exec(sql);
      } catch (e) {
        this.indexErrors.push(`${(e && e.message) || String(e)}`);
      }
    });

    // username 唯一索引（登录名不可重复）—— 与上面的普通索引同属「索引」这一步。
    // 它**故意没有写进 core.js 的 indexes**：这里是唯一索引 + 降级逻辑，需要特殊处理。
    // 必须 try/catch 包住：若历史库里存在重复/空 username，建唯一索引会抛错，
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
   * 多用户提醒：这是**全库跨账号**的合计值，会经 `info().legacyNullStartDates` 出现在
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
   * 可选参数 `conn` —— 记账库补列时必须显式给它自己的连接
   * （补列清单是按库取出来的，`this.db` 此刻仍是主库；缺省值保持既有调用形态不变）。
   * @param {string} table - 表名
   * @param {string} column - 列名
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
   * 而它又是从各模块 `module.json.database` 推出来的）——本文件里**不写第二份映射**。
   *
   * 为什么通用写原语（`insert` / `update`）必须走这里，而不是一律用 `this.db`：
   */
  _connFor(table) {
    const db = this._dbFor(table);
    if (db === SCHEMA.LEDGER_DB) return this.ledgerDb;
    if (db === SCHEMA.LAB_DB) return this.labDb;
    return this.db;
  },

  /**
   * 功能：统一读取入口 —— 执行一条查询并把全部结果行作为数组返回。
   * 说明：统一读取（sqlite: 返回行数组；json: 返回对象），两个后端由此保持同一调用形态。
   *
   * 多出可选的第三个参数 `conn` —— 模块自己的原语（`modules/<模块>/backend/*.js`）
   * 照旧只传 `(sql, params)`，落到 `this.db` 上；而调用方在 `_runOnLedger()` 里
   * **临时把 `this.db` 换成记账库连接**，于是那些原语一个字不改就查到了记账库
   */
  _listSql(sql, params, conn) {
    const db = conn || this.db;
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    return rows;
  },

  /**
   * 功能：取某张表的真实列名清单（整体恢复时用来过滤备份行里的键）。
   * 可选参数 `conn` —— 整体恢复按库分段执行，列清单必须从**那一段的连接**读
   * （表就住在那一侧），缺省仍是 `this.db`（既有调用形态不变）。
   * @param {string} table - 表名，由调用方保证取自 `SCHEMA.tableNames()`
   * @param {Object} [conn] - 要用的连接，缺省 `this.db`
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
