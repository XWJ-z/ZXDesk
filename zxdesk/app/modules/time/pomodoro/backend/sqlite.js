'use strict';

/**
 * modules/pomodoro/backend/sqlite.js —— 番茄钟的**SQLite 版原语**
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

/**
 * 「一人一行」的偏好表允许写入的列 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**
 * @type {Array.<string>}
 */
const PREF_KEYS = ['focus_min', 'break_min', 'long_break_min', 'rounds_before_long', 'sound_on'];

const ops = {
  /**
   * 功能：列出该账号的全部专注记录（新的在前）。
   *
   * 说明：⚠️ **一次全取回来** —— 今日 / 本周统计、当前那一个在跑的、明细都从这一份里筛。
   * 番茄记录的量级是「一个人一天几条」，一次取回比多开几个接口简单得多，
   * 而且两个后端的语义天然一致（与灵感库同一条理由）。
   */
  listPomodoroSessions(uid) {
    return this._listSql('SELECT * FROM time_pomodoro_sessions WHERE user_id=? ORDER BY started_at DESC, id DESC', [
      uid,
    ]);
  },

  /**
   * 功能：按 id + 归属取一条专注记录；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层就靠这个 null 把「越权」与「不存在」合并成同一个 404——
   *
   * @param {number} uid - 用户 id
   */
  getPomodoroSession(uid, id) {
    return this.db.prepare('SELECT * FROM time_pomodoro_sessions WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：取该账号**当前那一个还在跑的番茄**（`running` 或 `paused`），没有则为 null。
   *
   * 拿到就用 `started_at + planned_seconds + paused_total` 重算剩余，⛔ 不补记、不猜。
   * 这里仍按「最新的那一个」取（万一历史数据里出现了两个，行为也确定）。
   *
   */
  findRunningPomodoro(uid) {
    return (
      this.db
        .prepare(
          "SELECT * FROM time_pomodoro_sessions WHERE user_id=? AND status IN ('running','paused') ORDER BY started_at DESC, id DESC LIMIT 1",
        )
        .get(uid) || null
    );
  },

  /**
   * 功能：改写一条专注记录的**状态四件**（状态 / 结束时刻 / 累计暂停 / 本次暂停起点）。
   *
   * 说明：⚠️ 只改这四列，且**列名写死**：`started_at` / `planned_seconds` 是这条记录的真相，
   * 这也是本表 `allowedCols` 刻意留空、只走专用原语的原因。
   *
   */
  setPomodoroSession(uid, id, status, endedAt, pausedTotal, pausedAt) {
    const r = this.db
      .prepare(
        'UPDATE time_pomodoro_sessions SET status=?, ended_at=?, paused_total=?, paused_at=? WHERE id=? AND user_id=?',
      )
      .run(status, endedAt, pausedTotal, pausedAt, id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：取该账号的时长偏好行；没有则为 null（**默认值由业务层给**，见 `store.js`）。
   *
   * 说明：⚠️ 这里**不兜默认值**：默认值只有一处（`modules/pomodoro/store.js` 的 `PREF_DEFAULT`），
   * 两个后端各抄一份迟早会不一致，而表现是「换了后端时长就变了」而且不报错
   * （与 `teamwork_reminder_prefs` 同一条理由）。
   */
  getPomodoroPrefs(uid) {
    return this.db.prepare('SELECT * FROM time_pomodoro_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的时长偏好**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 为什么是「整份写入」而不是逐列 patch：默认值与合并都在业务层
   * （`pomodoroPrefs()` 给的是合并过默认值的完整对象），调用方先读合并再整份写回 ——
   * 于是「默认值」只有一处、两个后端也不必各自兜一套。
   */
  upsertPomodoroPrefs(uid, values, stamp) {
    const u = Number(uid);
    this.db
      .prepare(
        `INSERT INTO time_pomodoro_prefs (user_id, ${PREF_KEYS.join(',')}, updated_at)
         VALUES (?, ${PREF_KEYS.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${PREF_KEYS.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...PREF_KEYS.map((k) => values[k]), stamp);
    return this.db.prepare('SELECT * FROM time_pomodoro_prefs WHERE user_id=?').get(u) || null;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据。
   *
   * 说明：⭐ 番茄记录是用户自己攒下来的东西（换机 / 恢复之后统计不能丢）⇒ **必须进个人备份**
   * 所以删掉本模块目录时这一份自然消失，备份里不会剩下一个「指向不存在模块」的键。
   * 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   */
  exportPomodoro(uid) {
    const u = Number(uid);
    const time_pomodoro_sessions = this.db
      .prepare('SELECT * FROM time_pomodoro_sessions WHERE user_id=? ORDER BY started_at DESC, id DESC')
      .all(u);
    const time_pomodoro_prefs = this.db.prepare('SELECT * FROM time_pomodoro_prefs WHERE user_id=?').all(u);
    return { time_pomodoro_sessions, time_pomodoro_prefs };
  },
};

module.exports = { ops };
