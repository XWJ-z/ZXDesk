'use strict';

/**
 * modules/pomodoro/backend/sqlite.js —— 番茄钟的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ **统计与「还剩多少」都不在这一层做**：原语只回答「把该账号的行取回来 / 把这一行改成什么样」，
 *    判定（今日 / 本周怎么算、是不是超时）全在 `modules/pomodoro/store.js` 与前端 ——
 *    这样两个后端的结果**逐字一致**，不会出现「装的是哪个后端、统计就不一样」这种漂移。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *    ⚠️ 原语之间**不许互相调用**：op 挂在 `ops` 表上、只能通过 `this._bk.xxx` 取到，
 *    直接写 `this.getPomodoroPrefs(...)` 是 `is not a function`（teamwork 模块踩过，见那边的注释）。
 *
 * ⚠️ 时间列一律 **epoch 毫秒整数**：本表要按秒算差，文本时间戳只到秒、还要先解析才能相减。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.32
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

/**
 * 「一人一行」的偏好表允许写入的列 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**
 * （两边各留一份是刻意的：原语层不许 require 业务层常量）。
 * 漏一列的表现是「那个选项在界面上能改、但存不进去」，而且不报错。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['focus_min', 'break_min', 'long_break_min', 'rounds_before_long', 'sound_on'];

const ops = {
  // ---- 番茄钟（0.7.5）----
  /**
   * 功能：列出该账号的全部专注记录（新的在前）。
   *
   * 说明：⚠️ **一次全取回来** —— 今日 / 本周统计、当前那一个在跑的、明细都从这一份里筛。
   *      番茄记录的量级是「一个人一天几条」，一次取回比多开几个接口简单得多，
   *      而且两个后端的语义天然一致（与灵感库同一条理由）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 记录行数组（按 started_at、id 倒序）
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
   *      两种情况**必须逐字一致**，否则状态码本身就成了探测「别人有哪些 id」的通道。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 记录 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getPomodoroSession(uid, id) {
    return this.db.prepare('SELECT * FROM time_pomodoro_sessions WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：取该账号**当前那一个还在跑的番茄**（`running` 或 `paused`），没有则为 null。
   *
   * 说明：⭐ 这是「刷新 / 锁屏之后接着算」的落点（方案 §四-6）：界面重开时先问它，
   *      拿到就用 `started_at + planned_seconds + paused_total` 重算剩余，⛔ 不补记、不猜。
   *      ⚠️ 一次只可能有一个：`pomodoroStart()` 在有活跃记录时直接 400（方案 §三  只做一个番茄」）。
   *      这里仍按「最新的那一个」取（万一历史数据里出现了两个，行为也确定）。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 活跃记录行；没有则为 null
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
   *      `id` / `user_id` / `date` 是它的身份 —— 它们**一个都不许变**。
   *      这也是本表 `allowedCols` 刻意留空、只走专用原语的原因。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 记录 id
   * @param {string} status - `running` / `paused` / `completed` / `abandoned`
   * @param {?number} endedAt - 结束时刻（epoch 毫秒）；进行中 / 暂停中传 null
   * @param {number} pausedTotal - 累计暂停秒数
   * @param {?number} pausedAt - 本次暂停起点（epoch 毫秒）；没在暂停传 null
   * @returns {boolean} 是否真的改到了一行（不属于本人 / 不存在时为 false）
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
   *      两个后端各抄一份迟早会不一致，而表现是「换了后端时长就变了」而且不报错
   *      （与 `teamwork_reminder_prefs` 同一条理由）。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 偏好行；未命中为 null
   */
  getPomodoroPrefs(uid) {
    return this.db.prepare('SELECT * FROM time_pomodoro_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的时长偏好**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 为什么是「整份写入」而不是逐列 patch：默认值与合并都在业务层
   *      （`pomodoroPrefs()` 给的是合并过默认值的完整对象），调用方先读合并再整份写回 ——
   *      于是「默认值」只有一处、两个后端也不必各自兜一套。
   *      ⚠️ `PUT /api/pomodoro/prefs` 的「带哪个键写哪个键」是在**业务层/路由层**做的，
   *      不是靠这里放宽。`ON CONFLICT(user_id)` 保证**一人一行**：少了它，改两次设置就会攒出两行，
   *      而读侧只认第一行 ⇒ 表现是「改了设置不生效」且不报错。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好五个键：`focus_min` / `break_min` / `long_break_min` / `rounds_before_long` / `sound_on`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的偏好行（含 `id` / `user_id`）
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
   *      （方案 §十二 待拍板第 8 项，推荐值「进」）。走的是**本模块自己的原语**，
   *      所以删掉本模块目录时这一份自然消失，备份里不会剩下一个「指向不存在模块」的键。
   *      ⚠️ 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *
   * @param {number} uid - 用户 id
   * @returns {{time_pomodoro_sessions: Array.<Object>, time_pomodoro_prefs: Array.<Object>}} 备份里那两个键
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
