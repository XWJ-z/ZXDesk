'use strict';

/**
 * modules/pomodoro/backend/json.js —— 番茄钟的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * 说明：⭐ 与 SQLite 那条 `ON CONFLICT(user_id) DO UPDATE` 逐字同一语义：**一人一行**。
 *      「还剩多少秒」「今日几条」这类判定**不在这一层做** —— 两个后端必须给出逐字一致的结果，
 *      语义只能有一份实现（见 `modules/pomodoro/store.js`）。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用）。
 *    ⚠️ 原语之间**不许互相调用**（只能经由 `this._bk.xxx` 取到）。
 *
 * ⚠️ 时间列一律 **epoch 毫秒整数**（与 SQLite 侧逐字同一口径）。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.32
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { uidOf } = require('../../../../core/store/helpers.js');

/**
 * 「一人一行」的偏好表允许写入的列 —— ⚠️ 与 SQLite 侧、`store.js` 的 `PREF_KEYS` **逐字一致**。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['focus_min', 'break_min', 'long_break_min', 'rounds_before_long', 'sound_on'];

const ops = {
  // ---- 番茄钟（0.7.5）----
  /**
   * 功能：列出该账号的全部专注记录（新的在前）。
   *
   * 说明：⚠️ **一次全取回来** —— 今日 / 本周统计、当前那一个在跑的、明细都从这一份里筛
   *      （与 SQLite 同名 op 逐字同一口径）。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 记录行数组（按 started_at、id 倒序）
   */
  listPomodoroSessions(uid) {
    return (this.data.time_pomodoro_sessions || [])
      .filter((r) => uidOf(r) === Number(uid))
      .sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0) || b.id - a.id);
  },

  /**
   * 功能：按 id + 归属取一条专注记录；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层就靠这个 null 把「越权」与「不存在」合并成同一个 404。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 记录 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getPomodoroSession(uid, id) {
    return (
      (this.data.time_pomodoro_sessions || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null
    );
  },

  /**
   * 功能：取该账号**当前那一个还在跑的番茄**（`running` 或 `paused`），没有则为 null。
   *
   * 说明：⚠️ SQLite 侧用 `ORDER BY … LIMIT 1` 取「最新的那一个」；这里用同样的排序取首项，
   *      保证「万一历史数据里出现了两个活跃记录」时两个后端行为也一致。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 活跃记录行；没有则为 null
   */
  findRunningPomodoro(uid) {
    return (
      (this.data.time_pomodoro_sessions || [])
        .filter((r) => uidOf(r) === Number(uid) && (r.status === 'running' || r.status === 'paused'))
        .sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0) || b.id - a.id)[0] || null
    );
  },

  /**
   * 功能：改写一条专注记录的**状态四件**（状态 / 结束时刻 / 累计暂停 / 本次暂停起点）。
   *
   * 说明：⚠️ 只改这四列：`started_at` / `planned_seconds` 是这条记录的真相，
   *      `id` / `user_id` / `date` 是它的身份 —— 它们**一个都不许变**。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 记录 id
   * @param {string} status - `running` / `paused` / `completed` / `abandoned`
   * @param {?number} endedAt - 结束时刻（epoch 毫秒）；进行中 / 暂停中传 null
   * @param {number} pausedTotal - 累计暂停秒数
   * @param {?number} pausedAt - 本次暂停起点（epoch 毫秒）；没在暂停传 null
   * @returns {boolean} 是否真的改到了一行（不属于本人 / 不存在时为 false）
   */
  setPomodoroSession(uid, id, status, endedAt, pausedTotal, pausedAt) {
    const row = (this.data.time_pomodoro_sessions || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (!row) return false;
    row.status = status;
    row.ended_at = endedAt === undefined ? null : endedAt;
    row.paused_total = Number(pausedTotal) || 0;
    row.paused_at = pausedAt === undefined ? null : pausedAt;
    this._saveJson();
    return true;
  },

  /**
   * 功能：取该账号的时长偏好行；没有则为 null（**默认值由业务层给**，见 `store.js`）。
   *
   * 说明：⚠️ 这里**不兜默认值**：默认值只有一处（`modules/pomodoro/store.js` 的 `PREF_DEFAULT`），
   *      两个后端各抄一份迟早会不一致，而表现是「换了后端时长就变了」而且不报错
   *      （与 `teamwork_reminder_prefs` 同一条理由）。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 偏好行；未命中为 null
   */
  getPomodoroPrefs(uid) {
    return (this.data.time_pomodoro_prefs || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把该账号的时长偏好**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 与 SQLite 那条 `ON CONFLICT(user_id) DO UPDATE` 逐字同一语义：**一人一行**。
   *      JSON 这边没有唯一约束，所以「先找、找到就改、找不到就插」必须自己写全 ——
   *      少了「找到就改」会让同一个账号攒出多行，而 `getPomodoroPrefs()` 只认第一行，
   *      表现是「改了设置不生效」且不报错。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Object} values - 恰好五个键：`focus_min` / `break_min` / `long_break_min` / `rounds_before_long` / `sound_on`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的偏好行（含 `id` / `user_id`）
   */
  upsertPomodoroPrefs(uid, values, stamp) {
    const u = Number(uid);
    let row = (this.data.time_pomodoro_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.time_pomodoro_prefs.push(row);
    }
    PREF_KEYS.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据。
   *
   * 说明：⭐ 番茄记录是用户自己攒下来的东西（换机 / 恢复之后统计不能丢）⇒ **必须进个人备份**。
   *      ⚠️ 深拷贝：备份里的对象**不许**和内存里的行共享引用，否则后面改一行会连带改掉
   *      已经交出去的备份快照（与 `exportIdeas` 同一条理由）。
   *      ⚠️ 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {{time_pomodoro_sessions: Array.<Object>, time_pomodoro_prefs: Array.<Object>}} 备份里那两个键
   */
  exportPomodoro(uid) {
    const u = Number(uid);
    const time_pomodoro_sessions = JSON.parse(JSON.stringify(this.data.time_pomodoro_sessions || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0) || b.id - a.id);
    const time_pomodoro_prefs = JSON.parse(JSON.stringify(this.data.time_pomodoro_prefs || [])).filter((r) => uidOf(r) === u);
    return { time_pomodoro_sessions, time_pomodoro_prefs };
  },
};

module.exports = { ops };
