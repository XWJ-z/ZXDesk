'use strict';

/**
 * modules/calendar/backend/sqlite.js —— 日历的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ **图层的取数不在这一层**：原语只回答「把这个账号的事件取回来 / 把这一行改成什么样」。
 *    「某天有什么课」「某天的任务截止」走的是**看板那一条既有口径**
 *    （`store.dashboard()`，见 `modules/calendar/store.js` 的 `calendarLayer`）——
 *    原语层碰不到别的模块，也就不会出现「装的是哪个后端、图层就不一样」这种漂移。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *    ⚠️ 原语之间**不许互相调用**：op 挂在 `ops` 表上、只能通过 `this._bk.xxx` 取到，
 *    直接写 `this.getCalendarPrefs(...)` 是 `is not a function`（teamwork 模块踩过，见那边的注释）。
 *
 * ⚠️ 日期与时刻一律**字符串**（`YYYY-MM-DD` / `HH:MM`）：字典序即时间序。
 *    原语层**不做任何校验**（区间、先后、全天不带时刻都在接口层与业务层判）——
 *    两个后端各写一份校验迟早不一致。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.9.5
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

/**
 * 「一人一行」的图层开关表允许写入的列 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**
 * （两边各留一份是刻意的：原语层不许 require 业务层常量）。
 * 漏一列的表现是「那个开关在界面上能点、但存不进去」，而且不报错。
 * ⭐ 0.8.3（记账 4 期）：`layer_ledger` 是第 4 个图层开关 ——
 * ⚠️ 两个后端**成对**改，缺一个 = 启动即抛。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['layer_course', 'layer_task', 'layer_holiday', 'layer_ledger'];

/**
 * 「人生日历」（0.7.8）住**同一张表**的两列 —— ⚠️ 与 `store.js` 的 `LIFE_KEYS` 逐字一致。
 *
 * 说明：⭐ 刻意与 `PREF_KEYS` **分成两份清单**，而不是合并成一份五列的。理由是
 *      `upsertCalendarPrefs()` 与 `upsertCalendarLife()` 各自只写**自己列出来的列**
 *      （SQL 侧靠 `ON CONFLICT … DO UPDATE SET` 只更新 SET 里那几个；见下面两条原语），
 *      于是「改图层开关」与「改人生设置」互不覆盖。
 *      ⚠️ 合并成一份的下场是「改图层开关时把出生日期当成没传而清空」——
 *      而且**不报任何错**（同一类事故的既有记录见 `11-踩坑与说明.md` 第 28b 条）。
 * @type {Array.<string>}
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 「首页看板的默认视图」（0.8.7）住**同一张表**的那一列 ——
 * ⚠️ 与 `store.js` 的 `VIEW_KEYS` 逐字一致。
 *
 * 说明：⭐ 与上面两份清单**再分一份**是同一个理由（见 `LIFE_KEYS` 的说明）：
 *      `upsertCalendarView()` 只写自己列出来的那一列，于是「改默认视图」不会碰到
 *      四个图层开关、也不会碰到人生日历的两项设置（反过来也一样）。
 *      ⚠️ 合并进 `LIFE_KEYS` 的下场是「改默认视图时把出生日期写成 `undefined`」= 静默清空。
 * @type {Array.<string>}
 */
const VIEW_KEYS = ['default_view'];

/**
 * 改一条事件时**允许变的八列** —— ⚠️ `id` / `user_id` **一个都不许变**：
 * 前者是身份、后者是归属。列名写死在这里（本表 `allowedCols` 刻意留空，见 `schema.js`）。
 * @type {Array.<string>}
 */
const EVENT_COLS = ['title', 'date', 'end_date', 'all_day', 'start_time', 'end_time', 'note'];

const ops = {
  // ---- 日历（0.7.5）----
  /**
   * 功能：取该账号**与 `[from, to]` 有交集**的事件，按日期、起始时刻、id 升序。
   *
   * 说明：⭐ **跨天事件的两端都算命中**（方案 §九 用例 6）：一条 `date=09-18, end_date=09-20`
   *      的事件，在 09-18、09-19、09-20 三个区间里**都要被取到**。判据因此是
   *      「开始日 ≤ 区间终点」**且**「结束日 ≥ 区间起点」——
   *      用 `date <= from` 那种单边判据会让跨天事件在它结束的那一端**凭空消失**。
   *      ⚠️ `end_date` 为空 = 当天结束，所以比较前先用 `date` 顶上
   *      （`CASE WHEN` 那一段：老 JSON 数据里可能出现空串，两个都当「空」处理）。
   *      ⚠️ 排序里 `start_time` 用 `COALESCE(…, '')`：全天事件的时刻是 NULL，
   *      SQLite 默认让 NULL 排最前，而 JSON 那边空值会变成空串 ⇒ 不兜一下两边顺序会不一致。
   *
   * @param {number} uid - 用户 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 命中的事件行数组
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
   *      两种情况**必须逐字一致**，否则状态码本身就成了探测「别人有哪些 id」的通道。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 事件 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getCalendarEvent(uid, id) {
    return this.db.prepare('SELECT * FROM calendar_events WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：把一条事件的**八个可写列整行写一遍**（`updated_at` 一并刷新）。
   *
   * 说明：⚠️ **整行写、不是逐列 patch**：跨列约束（全天不带时刻 / 时刻有序 / 日期有序）
   *      只有拿到「改完之后整行长什么样」才判得干净。业务层先读现状、把 patch 合上去、
   *      校验通过之后再整行交到这里（`store.js` 的 `updateCalendarEvent`）——
   *      于是两个后端都不必各自拼一段 SET，语义天然一致。
   *      `id` / `user_id` / `created_at` **一个都不进 SET**：它们是身份与审计。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 事件 id
   * @param {Object} values - 恰好七个键：`title` / `date` / `end_date` / `all_day` /
   *      `start_time` / `end_time` / `note`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行（不属于本人 / 不存在时为 false）
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
   *      但 `user_id=?` 这个条件照样要带：它是防止「拿别人的 id 来删」的最后一道。
   *      ⭐ 通用存储层**没有删除原语**，删除只能长在各模块自己的 ops 上（本项目一贯如此）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 事件 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteCalendarEvent(uid, id) {
    const r = this.db.prepare('DELETE FROM calendar_events WHERE id=? AND user_id=?').run(id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：取该账号的图层开关行；没有则为 null（**默认值由业务层给**，见 `store.js`）。
   *
   * 说明：⚠️ 这里**不兜默认值**：默认值只有一处（`modules/calendar/store.js` 的 `PREF_DEFAULT`），
   *      两个后端各抄一份迟早会不一致，而表现是「换了后端图层就变了」而且不报错
   *      （与 `pomodoro_prefs` / `teamwork_reminder_prefs` 同一条理由）。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 开关行；未命中为 null
   */
  getCalendarPrefs(uid) {
    return this.db.prepare('SELECT * FROM calendar_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的图层开关**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 为什么是「整份写入」而不是逐列 patch：默认值与合并都在业务层
   *      （`calendarPrefs()` 给的是合并过默认值的完整对象），调用方先读合并再整份写回 ——
   *      于是「默认值」只有一处、两个后端也不必各自兜一套。
   *      ⚠️ `PUT /api/calendar/layers` 的「带哪个键写哪个键」是在**路由层**做的，
   *      不是靠这里放宽。`ON CONFLICT(user_id)` 保证**一人一行**：少了它，改两次开关就会攒出两行，
   *      而读侧只认第一行 ⇒ 表现是「开关点了没反应」且不报错。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好四个键：`layer_course` / `layer_task` / `layer_holiday` / `layer_ledger`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的开关行（含 `id` / `user_id`）
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
   *      但**只写 `LIFE_KEYS` 那两个列** —— 这是刻意的：`DO UPDATE SET` 只更新 SET 里列出的列，
   *      所以改人生设置**一个字节都不会碰**那四个图层开关；反过来也一样。
   *      ⚠️ 新账号上这一行还没建过时，这条 `INSERT` 不给那四个图层列 ⇒ 它们取 DDL 的 `DEFAULT 1`
   *      （与「图层开关默认全开」同一口径；`store.js` 的 `PREF_DEFAULT` 仍是那件事的唯一出处）。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好两个键：`birth_date` / `expect_years`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行（含 `id` / `user_id`）
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
   *      但**只写 `VIEW_KEYS` 那一列** —— 另外两组设置一个字节都不动（见 `VIEW_KEYS` 的说明）。
   *      ⚠️ 新账号上这一行还没建过时，这条 `INSERT` 不给那四个图层列 ⇒ 它们取 DDL 的 `DEFAULT 1`。
   *      ⚠️ 取值的合法性（只认 `'list'` / `'cal'`）在**接口层**判（`routes.js`），原语层不校验 ——
   *      两个后端各写一份校验迟早不一致。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好一个键：`default_view`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行（含 `id` / `user_id`）
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
   *      （方案 §三）。走的是**本模块自己的原语**，所以删掉本模块目录时
   *      这一份自然消失，备份里不会剩下一个「指向不存在模块」的键。
   *      ⚠️ 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *      ⚠️ **两张表都进**：只搬事件会让四个图层开关在换机后静默回到「全开」。
   *
   * @param {number} uid - 用户 id
   * @returns {{calendar_events: Array.<Object>, calendar_prefs: Array.<Object>}} 备份里那两个键
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
