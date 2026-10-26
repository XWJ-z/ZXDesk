'use strict';

/**
 * modules/trip/backend/json.js —— 行程的**JSON 版原语**（0.8.6）
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * 说明：⭐ 与 SQLite 那条**逐字同一语义**：区间查询跨天两端都算命中、排序口径一致
 *      （行程按开始日 / 票按出发时刻 / 点按测量时刻，末键都是 id）、偏好表**一人一行**。
 *
 * ⚠️ **不优化**（照 17 / 18 / 22 / 23 / 24 期的先例）：区间过滤与排序在这里走**内存**。
 *    但要点名一条：`time_trip_points` 是本项目**第一张可能上万行的用户表**（一段两小时的车程
 *    ≈ 数百到数千点），而 JSON 后端**每次写都会重写整个文件** ⇒ 数据量大时会明显变慢。
 *    ⇒ 处置：① 批量插入只 `_saveJson()` **一次**（⛔ 不许逐个点存）；
 *    ② 文档里写明「JSON 后端只服务降级 / 老备份 / 对拍，不建议长期承载大轨迹」。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**。⚠️ 原语之间**不许互相调用**。
 * ⚠️ 模块 `backend/*.js` 里 ⛔ 不许写 `_` 开头的私有方法（`_bk` 门面不转发）。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.33
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { uidOf } = require('../../../../core/store/helpers.js');

/** 改一条行程时**允许变的列** —— 与 SQLite 侧逐字一致。 */
const TRIP_COLS = ['title', 'vehicle', 'from_place', 'to_place', 'start_date', 'start_time', 'end_date', 'end_time', 'note'];

/** 改一张车票时**允许变的列** —— 与 SQLite 侧逐字一致。 */
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

/** 改一个轨迹点时**允许变的列**（坐标与时刻不可改）—— 与 SQLite 侧逐字一致。 */
const POINT_EDIT_COLS = ['label', 'note', 'trip_id'];

/** 三档提醒开关表允许写入的列 —— 与 SQLite 侧、`store.js` 的 `PREF_KEYS` **逐字一致**。 */
const PREF_KEYS = ['remind_d3', 'remind_d1', 'remind_h3'];

/**
 * 「人生日历」两项设置允许写入的键 —— ⭐ 0.8.9：从日历模块**整体搬来**。
 * ⚠️ 与 SQLite 侧、`store.js` 的 `LIFE_KEYS` **逐字一致**，且与上面的 `PREF_KEYS` 分成两份
 *（合并一份的下场是「改提醒开关把出生日期写成 `undefined`」= 静默清空）。
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 功能：取字符串的日期那一段（前 10 个字符）。
 * @param {*} s - `YYYY-MM-DD HH:MM` 或 `YYYY-MM-DD`
 * @returns {string} `YYYY-MM-DD`
 */
function datePart(s) {
  return String(s == null ? '' : s).slice(0, 10);
}

/**
 * 功能：按多个键升序排序的比较器（末键按数字比 id）。
 * @param {Array.<function(Object): (string|number)>} keys - 逐个取键的函数
 * @returns {function(Object, Object): number} 比较器
 */
function byKeys(keys) {
  return (a, b) => {
    for (const k of keys) {
      const va = k(a);
      const vb = k(b);
      const c = typeof va === 'number' || typeof vb === 'number' ? Number(va) - Number(vb) : String(va).localeCompare(String(vb));
      if (c) return c;
    }
    return 0;
  };
}

const byTrip = byKeys([(r) => String(r.start_date || ''), (r) => Number(r.id) || 0]);
const byTicket = byKeys([(r) => String(r.depart_at || ''), (r) => Number(r.id) || 0]);
const byPoint = byKeys([(r) => Number(r.at) || 0, (r) => Number(r.id) || 0]);

/**
 * 功能：判断一个点行是否落在某个行程归属下（`tripId` 为 null = 不挂行程的那些）。
 * @param {Object} r - 点行
 * @param {?(number|string)} tripId - 行程 id，或 null
 * @returns {boolean} 命中为 true
 */
function pointInTrip(r, tripId) {
  if (tripId === null || tripId === undefined || tripId === '') return r.trip_id === null || r.trip_id === undefined;
  return Number(r.trip_id) === Number(tripId);
}

const ops = {
  // ---- 行程 ----
  /**
   * 功能：取该账号**与 `[from, to]` 有交集**的行程，按开始日、id 升序。
   *
   * 说明：⭐ 判据与 SQLite 侧逐字一致 —— 「开始日 ≤ 区间终点」**且**「结束日 ≥ 区间起点」，
   *      跨天行程两端都被取到；`end_date` 为空 ⇒ 用 `start_date` 顶上。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 命中的行程行数组
   */
  listTrips(uid, from, to) {
    const u = Number(uid);
    const lo = String(from);
    const hi = String(to);
    return (this.data.time_trips || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const s = String(r.start_date || '');
        const e = r.end_date === undefined || r.end_date === null || r.end_date === '' ? s : String(r.end_date);
        return s <= hi && e >= lo;
      })
      .slice()
      .sort(byTrip);
  },

  /**
   * 功能：按 id + 归属取一条行程；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 行程 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getTrip(uid, id) {
    return (this.data.time_trips || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把一条行程的四个可写列整行写一遍（`updated_at` 一并刷新）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 行程 id
   * @param {Object} values - 恰好四个键
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行
   */
  setTrip(uid, id, values, stamp) {
    const row = (this.data.time_trips || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (!row) return false;
    TRIP_COLS.forEach((c) => {
      row[c] = values[c];
    });
    row.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：删掉一条行程 —— ⭐ **先解绑、再删**（与 SQLite 侧那个事务逐字同一语义）。
   *
   * 说明：⭐⭐，行程只是一层分组 ⇒ 解绑不连删。
   *      ⚠️ JSON 这边没有事务，但**顺序不变**、一次 `_saveJson()` 落盘（不会留下半截状态）。
   *      ⚠️ 这里**不调用** `unbindTripTickets`：原语之间不许互相调用（只能经 `this._bk.xxx`）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 行程 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteTrip(uid, id) {
    const u = Number(uid);
    const t = Number(id);
    (this.data.time_trip_tickets || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.trip_id) === t) r.trip_id = null;
    });
    (this.data.time_trip_points || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.trip_id) === t) r.trip_id = null;
    });
    const rows = this.data.time_trips || [];
    const i = rows.findIndex((r) => r.id === t && uidOf(r) === u);
    if (i >= 0) rows.splice(i, 1);
    this._saveJson();
    return i >= 0;
  },

  /**
   * 功能：⭐ 把挂在这条行程上的车票解绑（`trip_id` 置 null），返回改动行数。
   *
   * 说明：⭐  的落点（删行程 = 解绑，不级联删）—— 与 SQLite 侧逐字同一语义。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} tripId - 行程 id
   * @returns {number} 被解绑的行数
   */
  unbindTripTickets(uid, tripId) {
    const u = Number(uid);
    let n = 0;
    (this.data.time_trip_tickets || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.trip_id) === Number(tripId)) {
        r.trip_id = null;
        n += 1;
      }
    });
    if (n) this._saveJson();
    return n;
  },

  /**
   * 功能：⭐ 把挂在这条行程上的轨迹点与打卡点解绑，返回改动行数。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} tripId - 行程 id
   * @returns {number} 被解绑的行数
   */
  unbindTripPoints(uid, tripId) {
    const u = Number(uid);
    let n = 0;
    (this.data.time_trip_points || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.trip_id) === Number(tripId)) {
        r.trip_id = null;
        n += 1;
      }
    });
    if (n) this._saveJson();
    return n;
  },

  // ---- 车票 ----
  /**
   * 功能：取该账号**与 `[from, to]`（日期）有交集**的车票，按出发时刻、id 升序。
   *
   * 说明：⭐ 与 SQLite 侧同一判据（跨天票两端都算命中）；⚠️ 只比**日期那一段**
   *      （与 SQL 的 `substr(…,1,10)` 同义）—— 直接拿 16 字符与 10 字符比会整天差不到。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 命中的车票行数组
   */
  listTripTickets(uid, from, to) {
    const u = Number(uid);
    const lo = String(from);
    const hi = String(to);
    return (this.data.time_trip_tickets || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const d = datePart(r.depart_at);
        const e = r.arrive_at === undefined || r.arrive_at === null || r.arrive_at === '' ? d : datePart(r.arrive_at);
        return d <= hi && e >= lo;
      })
      .slice()
      .sort(byTicket);
  },

  /**
   * 功能：按 id + 归属取一张车票；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 车票 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getTripTicket(uid, id) {
    return (this.data.time_trip_tickets || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把一张车票的可写列整行写一遍（`updated_at` 一并刷新）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 车票 id
   * @param {Object} values - 键名见 `TICKET_COLS`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行
   */
  setTripTicket(uid, id, values, stamp) {
    const row = (this.data.time_trip_tickets || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (!row) return false;
    TICKET_COLS.forEach((c) => {
      row[c] = values[c];
    });
    row.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：删掉一张车票。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 车票 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteTripTicket(uid, id) {
    const rows = this.data.time_trip_tickets || [];
    const i = rows.findIndex((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (i < 0) return false;
    rows.splice(i, 1);
    this._saveJson();
    return true;
  },

  // ---- 轨迹点与打卡点 ----
  /**
   * 功能：取一个行程（或「不挂行程」）的点，按 `at`、id 升序；可再按时刻区间筛。
   * @param {(number|string)} uid - 用户 id
   * @param {?(number|string)} tripId - 行程 id；**null = 不挂行程的那些点**
   * @param {?number} fromMs - 最早时刻（含）；null = 不限
   * @param {?number} toMs - 最晚时刻（含）；null = 不限
   * @returns {Array.<Object>} 点行数组
   */
  listTripPoints(uid, tripId, fromMs, toMs) {
    const u = Number(uid);
    const hasFrom = fromMs !== null && fromMs !== undefined && fromMs !== '';
    const hasTo = toMs !== null && toMs !== undefined && toMs !== '';
    return (this.data.time_trip_points || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        if (!pointInTrip(r, tripId)) return false;
        const at = Number(r.at);
        if (hasFrom && !(at >= Number(fromMs))) return false;
        if (hasTo && !(at <= Number(toMs))) return false;
        return true;
      })
      .slice()
      .sort(byPoint);
  },

  /**
   * 功能：按 id + 归属取一个点；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 点 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getTripPoint(uid, id) {
    return (this.data.time_trip_points || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：改一个点的归属 / 名字 / 备注三列 —— ⚠️ 坐标与测量时刻一个都不许改。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 点 id
   * @param {Object} values - 恰好三个键：`label` / `note` / `trip_id`
   * @returns {boolean} 是否真的改到了一行
   */
  setTripPoint(uid, id, values) {
    const row = (this.data.time_trip_points || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (!row) return false;
    POINT_EDIT_COLS.forEach((c) => {
      row[c] = values[c];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：删掉一个点。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 点 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteTripPoint(uid, id) {
    const rows = this.data.time_trip_points || [];
    const i = rows.findIndex((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (i < 0) return false;
    rows.splice(i, 1);
    this._saveJson();
    return true;
  },

  /**
   * 功能：清空一个行程（或「不挂行程」）的全部点，返回删掉的条数。
   * @param {(number|string)} uid - 用户 id
   * @param {?(number|string)} tripId - 行程 id，或 null
   * @returns {number} 删掉的条数
   */
  clearTripPoints(uid, tripId) {
    const u = Number(uid);
    const rows = this.data.time_trip_points || [];
    const hit = (r) => uidOf(r) === u && pointInTrip(r, tripId);
    let n = 0;
    // ⚠️ **原地** `splice`（⛔ 不换数组引用）：与 `deleteTripPoint` 同款 —— 换引用会让
    //    「拿着旧引用的人」静默看不到删除，而本项目别处一律原地改（口径统一）。
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (hit(rows[i])) {
        rows.splice(i, 1);
        n += 1;
      }
    }
    if (n) this._saveJson();
    return n;
  },

  /**
   * 功能：只数一个行程（或「不挂行程」）的**轨迹点**数 —— 首屏摘要用。
   *
   * 说明：⭐ 0.8.33 起**只数轨迹点**（`kind='track'`）——「打卡」那一块前端暂时整块不显示，
   *      若还把它算进「轨迹点」就是一句假话。⚠️ 与 SQLite 侧 `kind='track'` 同一口径。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {?(number|string)} tripId - 行程 id，或 null
   * @returns {number} 轨迹点数（空为 0）
   */
  countTripPoints(uid, tripId) {
    const u = Number(uid);
    return (this.data.time_trip_points || []).filter(
      (r) => uidOf(r) === u && pointInTrip(r, tripId) && r.kind === 'track',
    ).length;
  },

  /**
   * 功能：⭐ **批量插入**轨迹点 / 打卡点 —— 整批**只落盘一次**，返回插好的行数组。
   *
   * 说明：⭐⭐ 与 SQLite 侧同名同参、同一语义（整批要么全进、要么不进）。
   *      ⚠️⭐ **`_saveJson()` 只能调一次**（方案 §5.6）：JSON 后端每次写都重写整个文件，
   *      逐条落盘在 200 点的批次上会变成 200 次全文件写 —— 「能跑，但慢到不像话」，
   *      而且**没有任何用例会红**。
   *      ⚠️ 行由业务层拼全（含 `user_id` / `trip_id` / `created_at`）；空数组直接回空数组。
   *
   * @param {(number|string)} uid - 用户 id（行里已带，保留形参是为了两后端同名同参）
   * @param {?(number|string)} tripId - 行程 id（同上）
   * @param {Array.<Object>} rows - 待写入的行
   * @returns {Array.<Object>} 插入后的行数组（`id` 已回填）
   */
  insertTripPoints(uid, tripId, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    const bucket = this.data.time_trip_points || (this.data.time_trip_points = []);
    for (const row of list) {
      row.id = this.data._seq++;
      bucket.push(row);
    }
    this._saveJson();
    return list;
  },

  // ---- 提醒偏好 ----
  /**
   * 功能：取该账号的三档提醒开关行；没有则为 null（**默认值由业务层给**）。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 开关行；未命中为 null
   */
  getTripPrefs(uid) {
    return (this.data.time_trip_prefs || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把该账号的三档提醒开关整份写入（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 与 SQLite 那条 `ON CONFLICT(user_id) DO UPDATE` 逐字同一语义：**一人一行**。
   *      ⚠️ JSON 这边没有唯一约束 ⇒ 「先找、找到就改、找不到就插」必须自己写全。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Object} values - 恰好三个键：`remind_d3` / `remind_d1` / `remind_h3`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的开关行
   */
  upsertTripPrefs(uid, values, stamp) {
    const u = Number(uid);
    let row = (this.data.time_trip_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.time_trip_prefs.push(row);
    }
    PREF_KEYS.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  /**
   * 功能：把该账号的「人生日历」两项设置**整份写入**（一人一行，不存在则建），返回写入后的行。
   * 说明：⭐ 0.8.9：与 `upsertTripPrefs()` 逐字同构 —— ⚠️ 它**只写 `LIFE_KEYS` 那两个键**，
   *      三个提醒开关一个字节都不会动（见 `LIFE_KEYS` 的说明）。
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好两个键：`birth_date` / `expect_years`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  upsertTripLife(uid, values, stamp) {
    const u = Number(uid);
    let row = (this.data.time_trip_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.time_trip_prefs.push(row);
    }
    LIFE_KEYS.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  // ---- 提醒专用 ----
  /**
   * 功能：⭐ 提醒专用取数 —— `depart_at` 落在 `[fromKey, toKey]`（**完整时刻串**）的票。
   *
   * 说明：⚠️ 与 `listTripTickets` 的「按日期比较」不同：提醒要的是「哪一分钟」。
   *      返回的字段也**只挑提醒要的那几个**（与 SQLite 侧的 `SELECT` 列清单逐字一致）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {string} fromKey - 起点时刻 `YYYY-MM-DD HH:MM`（含）
   * @param {string} toKey - 终点时刻 `YYYY-MM-DD HH:MM`（含）
   * @returns {Array.<Object>} 候选票行数组（按出发时刻升序）
   */
  departingTripTickets(uid, fromKey, toKey) {
    const u = Number(uid);
    const lo = String(fromKey);
    const hi = String(toKey);
    return (this.data.time_trip_tickets || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const d = String(r.depart_at || '');
        return d >= lo && d <= hi;
      })
      .slice()
      .sort(byTicket)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        code: r.code,
        from_station: r.from_station,
        to_station: r.to_station,
        depart_at: r.depart_at,
        arrive_at: r.arrive_at,
        seat: r.seat,
        gate: r.gate,
      }));
  },

  /**
   * 功能：取本模块进**个人备份**的那四份数据。
   *
   * 说明：⭐ 深拷贝：备份里的对象**不许**和内存里的行共享引用（与 `exportCalendar` 同一条理由）。
   *      ⚠️ 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {{trips: Array, time_trip_tickets: Array, time_trip_points: Array, time_trip_prefs: Array}} 四个键
   */
  exportTrip(uid) {
    const u = Number(uid);
    const cp = (arr) => JSON.parse(JSON.stringify(arr || [])).filter((r) => uidOf(r) === u);
    return {
      time_trips: cp(this.data.time_trips).sort(byTrip),
      time_trip_tickets: cp(this.data.time_trip_tickets).sort(byTicket),
      time_trip_points: cp(this.data.time_trip_points).sort(byPoint),
      time_trip_prefs: cp(this.data.time_trip_prefs),
    };
  },
};

module.exports = { ops };
