'use strict';

/**
 * modules/calendar/backend/json.js —— 日历的**JSON 版原语**
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

/**
 * 「一人一行」的图层开关表允许写入的列 —— ⚠️ 与 SQLite 侧、`store.js` 的 `PREF_KEYS` **逐字一致**。
 * ：`layer_ledger` 是第 4 个图层开关 ——
 */
const PREF_KEYS = ['layer_course', 'layer_task', 'layer_holiday', 'layer_ledger'];

/**
 * **逐字一致**。
 *
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 与 SQLite 侧、`store.js` 的 `VIEW_KEYS` **逐字一致**。
 *
 */
const VIEW_KEYS = ['default_view'];

/**
 * 改一条事件时**允许变的八列** —— ⚠️ 与 SQLite 侧逐字一致（`id` / `user_id` / `created_at` 不在里面）。
 * @type {Array.<string>}
 */
const EVENT_COLS = ['title', 'date', 'end_date', 'all_day', 'start_time', 'end_time', 'note'];

/**
 * 功能：把一行按「日期 → 起始时刻 → id」排序的键（两个后端必须同一口径）。
 * @param {Object} r - 事件行
 * @returns {Array.<(string|number)>} 排序键
 */
function sortKey(r) {
  return [String(r.date || ''), String(r.start_time || ''), Number(r.id) || 0];
}

const ops = {
  /**
   * 功能：取该账号**与 `[from, to]` 有交集**的事件，按日期、起始时刻、id 升序。
   *
   * 说明：⭐ 判据与 SQLite 侧逐字一致 —— 「开始日 ≤ 区间终点」**且**「结束日 ≥ 区间起点」，
   * `end_date` 为空 = 当天结束 ⇒ 用 `date` 顶上（与 SQL 的 `CASE WHEN` 同义）。
   * 排序键里空值一律当空串（与 SQL 的 `COALESCE(start_time, '')` 同义）——
   */
  listCalendarEvents(uid, from, to) {
    const u = Number(uid);
    const lo = String(from);
    const hi = String(to);
    return (this.data.calendar_events || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const d = String(r.date || '');
        const e = r.end_date === undefined || r.end_date === null || r.end_date === '' ? d : String(r.end_date);
        return d <= hi && e >= lo;
      })
      .slice()
      .sort((a, b) => {
        const ka = sortKey(a);
        const kb = sortKey(b);
        for (let i = 0; i < 2; i++) {
          const c = String(ka[i]).localeCompare(String(kb[i]));
          if (c) return c;
        }
        return Number(ka[2]) - Number(kb[2]);
      });
  },

  /**
   * 功能：按 id + 归属取一条事件；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层就靠这个 null 把「越权」与「不存在」合并成同一个 404。
   *
   * @param {(number|string)} uid - 用户 id
   */
  getCalendarEvent(uid, id) {
    return (this.data.calendar_events || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把一条事件的**八个可写列整行写一遍**（`updated_at` 一并刷新）。
   *
   * 说明：⚠️ 与 SQLite 侧同一条规矩：整行写、不是逐列 patch —— 跨列约束要拿到
   * 「改完之后整行长什么样」才判得干净（业务层先读现状、合并、校验、再整行交过来）。
   * `id` / `user_id` / `created_at` **一个都不动**：它们是身份与审计。
   */
  setCalendarEvent(uid, id, values, stamp) {
    const row = (this.data.calendar_events || []).find(
      (r) => r.id === Number(id) && uidOf(r) === Number(uid),
    );
    if (!row) return false;
    EVENT_COLS.forEach((c) => {
      row[c] = values[c];
    });
    row.updated_at = stamp;
    this._saveJson();
    return true;
  },

  /**
   * 功能：删掉一条事件。
   *
   * 说明：⚠️ 与 SQLite 侧同一条规矩：`user_id` 照旧要认 —— 它是防止「拿别人的 id 来删」
   * 的最后一道（上层虽然先取过一次，但这道门不该只靠调用方守规矩）。
   *
   */
  deleteCalendarEvent(uid, id) {
    const rows = this.data.calendar_events || [];
    const i = rows.findIndex((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (i < 0) return false;
    rows.splice(i, 1);
    this._saveJson();
    return true;
  },

  /**
   * 功能：取该账号的图层开关行；没有则为 null（**默认值由业务层给**，见 `store.js`）。
   *
   * 说明：⚠️ 这里**不兜默认值**：默认值只有一处（`modules/calendar/store.js` 的 `PREF_DEFAULT`）。
   *
   * @param {(number|string)} uid - 用户 id
   */
  getCalendarPrefs(uid) {
    return (this.data.calendar_prefs || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把该账号的图层开关**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 与 SQLite 那条 `ON CONFLICT(user_id) DO UPDATE` 逐字同一语义：**一人一行**。
   * JSON 这边没有唯一约束，所以「先找、找到就改、找不到就插」必须自己写全 ——
   * 表现是「开关点了没反应」且不报错。
   */
  upsertCalendarPrefs(uid, values, stamp) {
    const u = Number(uid);
    let row = (this.data.calendar_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.calendar_prefs.push(row);
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
   *
   * 说明：⭐ 与 SQLite 侧那条逐字同一语义（一人一行 + 只写 `LIFE_KEYS` 两列），
   * 于是「改图层开关」与「改人生设置」互不覆盖。
   * 新建行时**刻意不给那四个图层键**：默认值只有一处（`store.js` 的 `PREF_DEFAULT`），
   */
  upsertCalendarLife(uid, values, stamp) {
    const u = Number(uid);
    let row = (this.data.calendar_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.calendar_prefs.push(row);
    }
    LIFE_KEYS.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  /**
   * 功能：把该账号的「首页看板默认视图」**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 与 SQLite 侧那条逐字同一语义（一人一行 + 只写 `VIEW_KEYS` 那一列），
   * 于是三组设置互不覆盖。⚠️ 取值合法性在接口层判（`routes.js`），原语层不校验。
   *
   */
  upsertCalendarView(uid, values, stamp) {
    const u = Number(uid);
    let row = (this.data.calendar_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.calendar_prefs.push(row);
    }
    VIEW_KEYS.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据。
   *
   * 已经交出去的备份快照（与 `exportIdeas` / `exportPomodoro` 同一条理由）。
   * 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *
   */
  exportCalendar(uid) {
    const u = Number(uid);
    const calendar_events = JSON.parse(JSON.stringify(this.data.calendar_events || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const ka = sortKey(a);
        const kb = sortKey(b);
        for (let i = 0; i < 2; i++) {
          const c = String(ka[i]).localeCompare(String(kb[i]));
          if (c) return c;
        }
        return Number(ka[2]) - Number(kb[2]);
      });
    const calendar_prefs = JSON.parse(JSON.stringify(this.data.calendar_prefs || [])).filter(
      (r) => uidOf(r) === u,
    );
    return { calendar_events, calendar_prefs };
  },
};

module.exports = { ops };
