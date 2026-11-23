'use strict';

/**
 * modules/calendar/backend/sqlite.js —— 日历的**SQLite 版原语**
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

/**
 * 「一人一行」的图层开关表允许写入的列 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**
 * 漏一列的表现是「那个开关在界面上能点、但存不进去」，而且不报错。
 */
const PREF_KEYS = ['layer_course', 'layer_task', 'layer_holiday', 'layer_ledger'];

/**
 *
 * 说明：⭐ 刻意与 `PREF_KEYS` **分成两份清单**，而不是合并成一份五列的。理由是
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 与 `store.js` 的 `VIEW_KEYS` 逐字一致。
 *
 */
const VIEW_KEYS = ['default_view'];

/**
 * 前者是身份、后者是归属。列名写死在这里（本表 `allowedCols` 刻意留空，见 `schema.js`）。
 * @type {Array.<string>}
 */
const EVENT_COLS = ['title', 'date', 'end_date', 'all_day', 'start_time', 'end_time', 'note'];

const ops = {
  /**
   * 功能：取该账号**与 `[from, to]` 有交集**的事件，按日期、起始时刻、id 升序。
   *
   * 的事件，在 09-18、09-19、09-20 三个区间里**都要被取到**。判据因此是
   * 「开始日 ≤ 区间终点」**且**「结束日 ≥ 区间起点」——
   * `end_date` 为空 = 当天结束，所以比较前先用 `date` 顶上
   */
  listCalendarEvents(uid, from, to) {
    return this._listSql(
      `SELECT * FROM calendar_events
        WHERE user_id=?
          AND date <= ?
          AND (CASE WHEN end_date IS NULL OR end_date = '' THEN date ELSE end_date END) >= ?
        ORDER BY date ASC, COALESCE(start_time, '') ASC, id ASC`,
      [Number(uid), String(to), String(from)],
    );
  },

  /**
   * 功能：按 id + 归属取一条事件；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层就靠这个 null 把「越权」与「不存在」合并成同一个 404——
   *
   * @param {number} uid - 用户 id
   */
  getCalendarEvent(uid, id) {
    return this.db.prepare('SELECT * FROM calendar_events WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：把一条事件的**八个可写列整行写一遍**（`updated_at` 一并刷新）。
   *
   * 说明：⚠️ **整行写、不是逐列 patch**：跨列约束（全天不带时刻 / 时刻有序 / 日期有序）
   * 只有拿到「改完之后整行长什么样」才判得干净。业务层先读现状、把 patch 合上去、
   * 校验通过之后再整行交到这里（`store.js` 的 `updateCalendarEvent`）——
   */
  setCalendarEvent(uid, id, values, stamp) {
    const r = this.db
      .prepare(
        `UPDATE calendar_events SET ${EVENT_COLS.map((c) => `${c}=?`).join(', ')}, updated_at=?
          WHERE id=? AND user_id=?`,
      )
      .run(...EVENT_COLS.map((c) => values[c]), stamp, id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：删掉一条事件。
   *
   * 说明：⚠️ 上层**先取一次再删**（`deleteCalendarEvent`），所以这里不用管「不存在」的区分 ——
   * 但 `user_id=?` 这个条件照样要带：它是防止「拿别人的 id 来删」的最后一道。
   * 通用存储层**没有删除原语**，删除只能长在各模块自己的 ops 上（本项目一贯如此）。
   */
  deleteCalendarEvent(uid, id) {
    const r = this.db.prepare('DELETE FROM calendar_events WHERE id=? AND user_id=?').run(id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：取该账号的图层开关行；没有则为 null（**默认值由业务层给**，见 `store.js`）。
   *
   * 说明：⚠️ 这里**不兜默认值**：默认值只有一处（`modules/calendar/store.js` 的 `PREF_DEFAULT`），
   * 两个后端各抄一份迟早会不一致，而表现是「换了后端图层就变了」而且不报错
   * （与 `pomodoro_prefs` / `teamwork_reminder_prefs` 同一条理由）。
   */
  getCalendarPrefs(uid) {
    return this.db.prepare('SELECT * FROM calendar_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的图层开关**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 为什么是「整份写入」而不是逐列 patch：默认值与合并都在业务层
   * （`calendarPrefs()` 给的是合并过默认值的完整对象），调用方先读合并再整份写回 ——
   * 于是「默认值」只有一处、两个后端也不必各自兜一套。
   */
  upsertCalendarPrefs(uid, values, stamp) {
    const u = Number(uid);
    this.db
      .prepare(
        `INSERT INTO calendar_prefs (user_id, ${PREF_KEYS.join(',')}, updated_at)
         VALUES (?, ${PREF_KEYS.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${PREF_KEYS.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...PREF_KEYS.map((k) => values[k]), stamp);
    return this.db.prepare('SELECT * FROM calendar_prefs WHERE user_id=?').get(u) || null;
  },

  /**
   * 功能：把该账号的「人生日历」两项设置**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 形状与 `upsertCalendarPrefs()` 逐字同构（`ON CONFLICT(user_id)` 保证一人一行），
   * 但**只写 `LIFE_KEYS` 那两个列** —— 这是刻意的：`DO UPDATE SET` 只更新 SET 里列出的列，
   * 所以改人生设置**一个字节都不会碰**那四个图层开关；反过来也一样。
   */
  upsertCalendarLife(uid, values, stamp) {
    const u = Number(uid);
    this.db
      .prepare(
        `INSERT INTO calendar_prefs (user_id, ${LIFE_KEYS.join(',')}, updated_at)
         VALUES (?, ${LIFE_KEYS.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${LIFE_KEYS.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...LIFE_KEYS.map((k) => values[k]), stamp);
    return this.db.prepare('SELECT * FROM calendar_prefs WHERE user_id=?').get(u) || null;
  },

  /**
   * 功能：把该账号的「首页看板默认视图」**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 形状与 `upsertCalendarLife()` 逐字同构（`ON CONFLICT(user_id)` 保证一人一行），
   * 但**只写 `VIEW_KEYS` 那一列** —— 另外两组设置一个字节都不动（见 `VIEW_KEYS` 的说明）。
   * 新账号上这一行还没建过时，这条 `INSERT` 不给那四个图层列 ⇒ 它们取 DDL 的 `DEFAULT 1`。
   */
  upsertCalendarView(uid, values, stamp) {
    const u = Number(uid);
    this.db
      .prepare(
        `INSERT INTO calendar_prefs (user_id, ${VIEW_KEYS.join(',')}, updated_at)
         VALUES (?, ${VIEW_KEYS.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${VIEW_KEYS.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...VIEW_KEYS.map((k) => values[k]), stamp);
    return this.db.prepare('SELECT * FROM calendar_prefs WHERE user_id=?').get(u) || null;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据。
   *
   * 说明：⭐ 事件是用户亲手写的内容（换机 / 恢复之后不能丢）⇒ **必须进个人备份**
   * 这一份自然消失，备份里不会剩下一个「指向不存在模块」的键。
   * 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   */
  exportCalendar(uid) {
    const u = Number(uid);
    const calendar_events = this.db
      .prepare(
        `SELECT * FROM calendar_events WHERE user_id=?
          ORDER BY date ASC, COALESCE(start_time, '') ASC, id ASC`,
      )
      .all(u);
    const calendar_prefs = this.db.prepare('SELECT * FROM calendar_prefs WHERE user_id=?').all(u);
    return { calendar_events, calendar_prefs };
  },
};

module.exports = { ops };
