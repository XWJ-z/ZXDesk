'use strict';

/**
 * modules/trip/backend/sqlite.js —— 行程的**SQLite 版原语**（0.8.6）
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *    ⚠️ 原语之间**不许互相调用**：op 挂在 `ops` 表上、只能通过 `this._bk.xxx` 取到，
 *    直接写 `this.getTrip(...)` 是 `is not a function`（teamwork 模块踩过，见那边的注释）。
 *    ⚠️ 模块 `backend/*.js` 里 **⛔ 不许写 `_` 开头的私有方法**（`_bk` 门面按名单转发，
 *    `_` 键不在名单里 ⇒ 真机 `TypeError`，而单测全绿）。⇒ 要复用就写**模块级函数**、
 *    调用点显式传参（本文件下面那几个就是）。
 *
 * ⚠️ 日期与时刻一律**字符串**：`YYYY-MM-DD`（行程 / 票的日期部分）与 `YYYY-MM-DD HH:MM`
 *    （票的完整时刻，定长两位）—— 全程**字典序即时间序**。
 *    ⛔ 不转 `Date` 比较（跨时区会静默错一天）。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.33
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

/** 改一条行程时**允许变的列** —— `id` / `user_id` / 两个审计列一个都不进 SET。 */
const TRIP_COLS = ['title', 'vehicle', 'from_place', 'to_place', 'start_date', 'start_time', 'end_date', 'end_time', 'note'];

/** 改一张车票时**允许变的列** —— `id` / `user_id` / 两个审计列一个都不进 SET。 */
const TICKET_COLS = [
  'trip_id',
  'kind',
  'code',
  'from_station',
  'to_station',
  'depart_at',
  'arrive_at',
  'seat',
  'gate',
  'terminal',
  'price_fen',
  'order_no',
  'note',
];

/**
 * 改一个轨迹点时**允许变的列** —— ⚠️ `at` / `lat` / `lng` / `accuracy` / `altitude` /
 * `speed` / `heading` **一个都不许改**：它们是「这次测量」本身。
 * ⚠️ 方案写的签名是 `setTripPoint(uid, id, cols, stamp)`，但 `time_trip_points` **没有 `updated_at` 列**
 *    （方案 §4.2 的 DDL 里就没有）⇒ 第四个形参无列可写，故省去（已记方案附录 D）。
 */
const POINT_EDIT_COLS = ['label', 'note', 'trip_id'];

/**
 * 「一人一行」的三档提醒开关表允许写入的列 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**
 * （两边各留一份是刻意的：原语层不许 require 业务层常量）。
 */
const PREF_KEYS = ['remind_d3', 'remind_d1', 'remind_h3'];

/**
 * 「人生日历」两项设置允许写入的列 —— ⭐ 0.8.9：从日历模块**整体搬来**
 * （原来住 `calendar_prefs`，现在与提醒开关共用 `time_trip_prefs` 这同一行）。
 *
 * 说明：⚠️ 与上面的 `PREF_KEYS` **刻意分成两份**、与 `store.js` 的 `LIFE_KEYS`
 *      **必须逐字一致**（先例：`modules/calendar/backend/sqlite.js` 那三份各留一份）——
 *      合并成一份的下场是「改提醒开关时把出生日期写成 `undefined`」= **静默清空**。
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 功能：把「按行程取点」的条件拼成一段 SQL 与它的参数。
 *
 * 说明：⭐ `tripId` 为 `null` = **不挂行程的那些点**（不建行程也能记轨迹）。
 *      ⚠️ 判据必须是 `trip_id IS NULL`，⛔ 不能写成 `trip_id = ?` 传 null ——
 *      SQL 里 `NULL = NULL` 恒为 NULL（永假），那样「未归属」这一段会**永远取不到**。
 *
 * @param {?(number|string)} tripId - 行程 id，或 null（不挂行程的那些）
 * @returns {{sql: string, args: Array}} 条件片段与参数
 */
function tripCond(tripId) {
  if (tripId === null || tripId === undefined || tripId === '') return { sql: 'trip_id IS NULL', args: [] };
  return { sql: 'trip_id = ?', args: [Number(tripId)] };
}

const ops = {
  // ---- 行程（0.8.6）----
  /**
   * 功能：取该账号**与 `[from, to]` 有交集**的行程，按开始日、id 升序。
   *
   * 说明：⭐ 跨天行程的**两端都算命中**（照 `listCalendarEvents` 的判据）：一条
   *      `start_date=09-28, end_date=10-02` 的行程，在三个区间里都要被取到。
   *      `end_date` 为空 = 当天结束 ⇒ 比较前先用 `start_date` 顶上。
   *
   * @param {number} uid - 用户 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 命中的行程行数组
   */
  listTrips(uid, from, to) {
    return this._listSql(
      `SELECT * FROM time_trips
        WHERE user_id=?
          AND start_date <= ?
          AND (CASE WHEN end_date IS NULL OR end_date = '' THEN start_date ELSE end_date END) >= ?
        ORDER BY start_date ASC, id ASC`,
      [Number(uid), String(to), String(from)],
    );
  },

  /**
   * 功能：按 id + 归属取一条行程；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层靠这个 null 把「越权」与「不存在」合并成同一个 404。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 行程 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getTrip(uid, id) {
    return this.db.prepare('SELECT * FROM time_trips WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：把一条行程的四个可写列**整行写一遍**（`updated_at` 一并刷新）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 行程 id
   * @param {Object} values - 恰好八个键：`title` / `vehicle` / `from_place` / `to_place` /
   *      `start_date` / `start_time` / `end_date` / `note`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行
   */
  setTrip(uid, id, values, stamp) {
    const r = this.db
      .prepare(`UPDATE time_trips SET ${TRIP_COLS.map((c) => `${c}=?`).join(', ')}, updated_at=? WHERE id=? AND user_id=?`)
      .run(...TRIP_COLS.map((c) => values[c]), stamp, id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：删掉一条行程 —— ⭐ **同一个事务里「先解绑、再删」**。
   *
   * 说明：⭐⭐ **删行程 = 解绑，不级联删**：车票与轨迹是**已经发生过的事实凭证**，
   *      行程只是一层分组。⛔ 不许出现「行程删了、票还挂着 `trip_id`」（悬空指向 ——
   *      界面上会变成一张永远进不去的票）。
   *      ⚠️ 「一个事务」不是装饰：半截状态（解绑了票、行程没删掉）会让用户以为删失败了
   *      却已经丢掉了归属。`node:sqlite` 没有 `db.transaction()`（那是 better-sqlite3 的）
   *      ⇒ 照本项目既有写法 `BEGIN` / `COMMIT` / 出错 `ROLLBACK`。
   *      ⚠️ 这里**不调用** `unbindTripTickets` / `unbindTripPoints`：原语之间不许互相调用
   *      （它们挂在 `ops` 表上、只能经 `this._bk.xxx` 取到），所以三条 SQL 就地写完。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 行程 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteTrip(uid, id) {
    const u = Number(uid);
    const t = Number(id);
    const db = this.db;
    let hit;
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE time_trip_tickets SET trip_id=NULL WHERE user_id=? AND trip_id=?').run(u, t);
      db.prepare('UPDATE time_trip_points SET trip_id=NULL WHERE user_id=? AND trip_id=?').run(u, t);
      hit = db.prepare('DELETE FROM time_trips WHERE id=? AND user_id=?').run(t, u).changes;
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return hit > 0;
  },

  /**
   * 功能：⭐ 把挂在这条行程上的**车票**解绑（`trip_id` 置空），返回改动行数。
   *
   * 说明：⭐⭐ 这是  的落点：**删行程 = 解绑，不级联删** ——
   *      车票是已经发生过的事实凭证，行程只是一层分组。
   *      ⚠️ 与任务板刻意相反（那边删项目连任务一起删），理由是任务是可被重新安排的**待办**。
   *
   * @param {number} uid - 用户 id
   * @param {number} tripId - 行程 id
   * @returns {number} 被解绑的行数
   */
  unbindTripTickets(uid, tripId) {
    const r = this.db.prepare('UPDATE time_trip_tickets SET trip_id=NULL WHERE user_id=? AND trip_id=?').run(uid, tripId);
    return r.changes;
  },

  /**
   * 功能：⭐ 把挂在这条行程上的**轨迹点与打卡点**解绑（`trip_id` 置空），返回改动行数。
   * @param {number} uid - 用户 id
   * @param {number} tripId - 行程 id
   * @returns {number} 被解绑的行数
   */
  unbindTripPoints(uid, tripId) {
    const r = this.db.prepare('UPDATE time_trip_points SET trip_id=NULL WHERE user_id=? AND trip_id=?').run(uid, tripId);
    return r.changes;
  },

  // ---- 车票（§5.2-7~10）----
  /**
   * 功能：取该账号**与 `[from, to]`（日期）有交集**的车票，按出发时刻、id 升序。
   *
   * 说明：⭐ **跨天票两端都算命中**（照 `listCalendarEvents`）：出发日 ≤ 区间终点
   *      **且**（到达日 —— 为空时用出发日）≥ 区间起点。
   *      ⚠️ `from` / `to` 是 **`YYYY-MM-DD`**（10 字符），而 `depart_at` 是 16 字符的完整时刻 ⇒
   *      比较前用 `substr(…,1,10)` **只取日期那一段**（⛔ 不能直接拿 16 字符与 10 字符比大小 ——
   *      `'2026-09-30 08:00' <= '2026-09-30'` 是**假**，那天出发的票会**整天差不到**）。
   *
   * @param {number} uid - 用户 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 命中的车票行数组
   */
  listTripTickets(uid, from, to) {
    return this._listSql(
      `SELECT * FROM time_trip_tickets
        WHERE user_id=?
          AND substr(depart_at, 1, 10) <= ?
          AND (CASE WHEN arrive_at IS NULL OR arrive_at = '' THEN substr(depart_at, 1, 10)
                    ELSE substr(arrive_at, 1, 10) END) >= ?
        ORDER BY depart_at ASC, id ASC`,
      [Number(uid), String(to), String(from)],
    );
  },

  /**
   * 功能：按 id + 归属取一张车票；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 车票 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getTripTicket(uid, id) {
    return this.db.prepare('SELECT * FROM time_trip_tickets WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：把一张车票的可写列**整行写一遍**（`updated_at` 一并刷新）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 车票 id
   * @param {Object} values - 键名见 `TICKET_COLS`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行
   */
  setTripTicket(uid, id, values, stamp) {
    const r = this.db
      .prepare(
        `UPDATE time_trip_tickets SET ${TICKET_COLS.map((c) => `${c}=?`).join(', ')}, updated_at=?
          WHERE id=? AND user_id=?`,
      )
      .run(...TICKET_COLS.map((c) => values[c]), stamp, id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：删掉一张车票。
   * @param {number} uid - 用户 id
   * @param {number} id - 车票 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteTripTicket(uid, id) {
    const r = this.db.prepare('DELETE FROM time_trip_tickets WHERE id=? AND user_id=?').run(id, uid);
    return r.changes > 0;
  },

  // ---- 轨迹点与打卡点（§5.2-11~16）----
  /**
   * 功能：取一个行程（或「不挂行程」）的点，按 `at`、id 升序；可再按时刻区间筛。
   *
   * @param {number} uid - 用户 id
   * @param {?(number|string)} tripId - 行程 id；**null = 不挂行程的那些点**
   * @param {?number} fromMs - 最早时刻（epoch 毫秒，含）；null = 不限
   * @param {?number} toMs - 最晚时刻（epoch 毫秒，含）；null = 不限
   * @returns {Array.<Object>} 点行数组
   */
  listTripPoints(uid, tripId, fromMs, toMs) {
    const c = tripCond(tripId);
    let sql = `SELECT * FROM time_trip_points WHERE user_id=? AND ${c.sql}`;
    const args = [Number(uid), ...c.args];
    if (fromMs !== null && fromMs !== undefined && fromMs !== '') {
      sql += ' AND at >= ?';
      args.push(Math.round(Number(fromMs)));
    }
    if (toMs !== null && toMs !== undefined && toMs !== '') {
      sql += ' AND at <= ?';
      args.push(Math.round(Number(toMs)));
    }
    return this._listSql(`${sql} ORDER BY at ASC, id ASC`, args);
  },

  /**
   * 功能：按 id + 归属取一个点；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 点 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getTripPoint(uid, id) {
    return this.db.prepare('SELECT * FROM time_trip_points WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：改一个点的**归属 / 名字 / 备注**三列 —— ⚠️ 坐标与测量时刻**一个都不许改**。
   *
   * 说明：⚠️ 方案 §5.2-13 的签名带第四个形参 `stamp`，但 `time_trip_points` **没有 `updated_at` 列**
   *      （§4.2 的 DDL 里没有）⇒ 无列可写，故省去该形参（已记方案附录 D）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 点 id
   * @param {Object} values - 恰好三个键：`label` / `note` / `trip_id`
   * @returns {boolean} 是否真的改到了一行
   */
  setTripPoint(uid, id, values) {
    const r = this.db
      .prepare(
        `UPDATE time_trip_points SET ${POINT_EDIT_COLS.map((c) => `${c}=?`).join(', ')} WHERE id=? AND user_id=?`,
      )
      .run(...POINT_EDIT_COLS.map((c) => values[c]), id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：删掉一个点。
   * @param {number} uid - 用户 id
   * @param {number} id - 点 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteTripPoint(uid, id) {
    const r = this.db.prepare('DELETE FROM time_trip_points WHERE id=? AND user_id=?').run(id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：清空一个行程（或「不挂行程」）的全部点，返回删掉的条数。
   *
   * 说明：⚠️ `tripId` 为 `null` 时**只清「不挂行程的那些」**（⛔ 不是「清全部」）——
   *      与 `listTripPoints` 同一个 `tripCond()` 判据（一个函数，不是两处各写一遍）。
   *
   * @param {number} uid - 用户 id
   * @param {?(number|string)} tripId - 行程 id，或 null
   * @returns {number} 删掉的条数
   */
  clearTripPoints(uid, tripId) {
    const c = tripCond(tripId);
    const r = this.db.prepare(`DELETE FROM time_trip_points WHERE user_id=? AND ${c.sql}`).run(Number(uid), ...c.args);
    return r.changes;
  },

  /**
   * 功能：只数一个行程（或「不挂行程」）的**轨迹点**数 —— 首屏摘要用，⛔ 不把点全捞回来。
   *
   * 说明：⭐ `time_trip_points` 是本项目**第一张可能上万行的用户表**（一段两小时的车程 ≈ 数百到数千点），
   *      摘要要的是“几个点”而不是“哪些点”⇒ 只回一个数。
   *      ⭐ 0.8.33 起**只数轨迹点**（`kind='track'`）——「打卡」那一块前端暂时整块不显示，
   *      若还把它算进「轨迹点」就是一句假话。
   *
   * @param {number} uid - 用户 id
   * @param {?(number|string)} tripId - 行程 id，或 null
   * @returns {number} 轨迹点数（空为 0）
   */
  countTripPoints(uid, tripId) {
    const c = tripCond(tripId);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM time_trip_points WHERE user_id=? AND ${c.sql} AND kind='track'`)
      .get(Number(uid), ...c.args);
    return row ? Number(row.c) || 0 : 0;
  },

  /**
   * 功能：⭐ **批量插入**轨迹点 / 打卡点 —— 整批一个事务，返回插好的行数组。
   *
   * 说明：Ⓐ **为什么必须是原语**（方案 §5.6）：轨迹是**成批**上来的（每 20 秒或每 50 个点一批），
   *      若在业务层循环调通用 `_insert()`，SQLite 这边是 200 次独立 `INSERT`（没有事务 ⇒
   *      半截轨迹会留在库里），JSON 那边更糟 —— **每一条都重写整个文件**。
   *      ⭐ 而「一个事务」不是装饰：失败整批回滚，⛔ 不留半截轨迹（方案 §5.5）。
   *      Ⓑ **行由业务层拼全**（含 `user_id` / `trip_id` / `created_at`）：原语只负责「把这批写进去」，
   *      算业务口径**不是原语的活**（原语层不许替业务层做判断）。
   *      ⚠️ 空数组**直接回空数组**：⛔ 不开事务（SQLite 的空 `BEGIN`/`COMMIT` 无害但也无意义），
   *      更⛔ 不能报错 —— 空批是合法请求。
   *
   * @param {number} uid - 用户 id（行里已带，保留形参是为了两后端同名同参）
   * @param {?(number|string)} tripId - 行程 id（同上；行里已带）
   * @param {Array.<Object>} rows - 待写入的行（键名与表结构一致，且**每行的键相同**）
   * @returns {Array.<Object>} 插入后的行数组（自增 `id` 已回填）
   * @throws {Error} 任一行写入失败时整批回滚并抛出
   */
  insertTripPoints(uid, tripId, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    const db = this.db;
    const out = [];
    db.exec('BEGIN');
    try {
      for (const row of list) {
        const cols = Object.keys(row);
        const r = db
          .prepare(`INSERT INTO time_trip_points (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
          .run(...cols.map((c) => row[c]));
        row.id = Number(r.lastInsertRowid);
        out.push(row);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return out;
  },

  // ---- 提醒偏好（§5.2-17~18）----
  /**
   * 功能：取该账号的三档提醒开关行；没有则为 null（**默认值由业务层给**，见 `store.js`）。
   * @param {number} uid - 用户 id
   * @returns {?Object} 开关行；未命中为 null
   */
  getTripPrefs(uid) {
    return this.db.prepare('SELECT * FROM time_trip_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的三档提醒开关**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 「整份写入」而不是逐列 patch：默认值与合并都在业务层（`tripPrefs()` 给的是
   *      合并过默认值的完整对象），调用方先读合并再整份写回 ⇒ 默认值只有一处。
   *      ⚠️ 少了 `ON CONFLICT(user_id)`，改两次开关就会攒出两行，而读侧只认第一行
   *      ⇒ 表现是「开关点了没反应」且不报错。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好三个键：`remind_d3` / `remind_d1` / `remind_h3`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的开关行
   */
  upsertTripPrefs(uid, values, stamp) {
    const u = Number(uid);
    this.db
      .prepare(
        `INSERT INTO time_trip_prefs (user_id, ${PREF_KEYS.join(',')}, updated_at)
         VALUES (?, ${PREF_KEYS.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${PREF_KEYS.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...PREF_KEYS.map((k) => values[k]), stamp);
    return this.db.prepare('SELECT * FROM time_trip_prefs WHERE user_id=?').get(u) || null;
  },

  /**
   * 功能：把该账号的「人生日历」两项设置**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 0.8.9：与 `upsertTripPrefs()` 逐字同构（调用方先读合并再整份写回）。
   *      ⚠️ 它**只写 `LIFE_KEYS` 那两个列**：三个提醒开关一个字节都不会动
   *      （`DO UPDATE SET` 只更新 SET 里列出的列）。
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好两个键：`birth_date` / `expect_years`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  upsertTripLife(uid, values, stamp) {
    const u = Number(uid);
    this.db
      .prepare(
        `INSERT INTO time_trip_prefs (user_id, ${LIFE_KEYS.join(',')}, updated_at)
         VALUES (?, ${LIFE_KEYS.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${LIFE_KEYS.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...LIFE_KEYS.map((k) => values[k]), stamp);
    return this.db.prepare('SELECT * FROM time_trip_prefs WHERE user_id=?').get(u) || null;
  },

  // ---- 提醒专用（§5.2-19）----
  /**
   * 功能：⭐ 提醒专用取数 —— `depart_at` 落在 `[fromKey, toKey]`（**完整时刻串**）的票，
   *      且**只回提醒要的那几列**（`id` / `kind` / `code` / `from_station` / `to_station` /
   *      `depart_at` / `arrive_at` / `seat` / `gate`）。
   *
   * 说明：⚠️ 这里比较的是**完整时刻串**（16 字符），与 `listTripTickets` 的「按日期比较」不同 ——
   *      提醒要的是「哪一分钟」，而列表要的是「哪天」。两者各有各的原语，⛔ 别合并。
   *      ⚠️ **不在这里算「该不该发」**：判据在业务层 `tripReminderCandidates()`。
   *
   * @param {number} uid - 用户 id
   * @param {string} fromKey - 起点时刻 `YYYY-MM-DD HH:MM`（含）
   * @param {string} toKey - 终点时刻 `YYYY-MM-DD HH:MM`（含）
   * @returns {Array.<Object>} 候选票行数组（按出发时刻升序）
   */
  departingTripTickets(uid, fromKey, toKey) {
    return this._listSql(
      `SELECT id, kind, code, from_station, to_station, depart_at, arrive_at, seat, gate
         FROM time_trip_tickets
        WHERE user_id=? AND depart_at >= ? AND depart_at <= ?
        ORDER BY depart_at ASC, id ASC`,
      [Number(uid), String(fromKey), String(toKey)],
    );
  },

  /**
   * 功能：取本模块进**个人备份**的那四份数据。
   *
   * 说明：⭐ 四张表**全部进个人备份**：轨迹与车票**无法重新产生**，
   *      换机后必须能恢复（与三方导入「可重导所以不进」正好相反）。
   *      ⚠️ 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *
   * @param {number} uid - 用户 id
   * @returns {{trips: Array, time_trip_tickets: Array, time_trip_points: Array, time_trip_prefs: Array}} 四个键
   */
  exportTrip(uid) {
    const u = Number(uid);
    const time_trips = this.db.prepare('SELECT * FROM time_trips WHERE user_id=? ORDER BY start_date ASC, id ASC').all(u);
    const time_trip_tickets = this.db
      .prepare('SELECT * FROM time_trip_tickets WHERE user_id=? ORDER BY depart_at ASC, id ASC')
      .all(u);
    const time_trip_points = this.db.prepare('SELECT * FROM time_trip_points WHERE user_id=? ORDER BY at ASC, id ASC').all(u);
    const time_trip_prefs = this.db.prepare('SELECT * FROM time_trip_prefs WHERE user_id=?').all(u);
    return { time_trips, time_trip_tickets, time_trip_points, time_trip_prefs };
  },
};

module.exports = { ops };
