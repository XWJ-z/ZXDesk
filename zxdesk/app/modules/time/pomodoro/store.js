'use strict';
/**
 * modules/pomodoro/store.js —— 番茄钟业务方法（0.7.5）
 *
 * 功能：番茄钟的业务方法 —— `pomodoroState`（一屏所需的全部：状态 + 偏好 + 统计）/
 *      `pomodoroStart` / `pomodoroBreak`（⭐ 0.8.32 休息） / `pomodoroPause` / `pomodoroResume` /
 *      `pomodoroFinish` / `pomodoroPrefs` / `pomodoroSavePrefs` / `pomodoroStats`。
 *
 * ⚠️ **方法名一律带模块前缀，绝不用 `state` / `start` 这种通用名**：`store/index.js` 是把全部
 *    业务模块平铺到**同一个原型**上的 —— 两个模块各写一个 `start()`，后来者会**静默覆盖**前者。
 *    0.5.0 起这条规矩另有装配期护栏（`assertNoMethodClash()`）兜住，撞名一律启动即抛。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走 `this._bk.<op>(...)`。
 *
 * ⭐⭐ **本模块最要紧的一条：时间是"算"出来的，不是"攒"出来的**（方案 §四-1）。
 *    落库的只有**事实**（`started_at` / `planned_seconds` / `ended_at` / `status` / `paused_*`），
 *    「还剩多少秒」永远是派生量 ⇒ ⛔ **本模块任何表都没有"剩余秒数"列**，
 *    前端也不许累加 —— 重算的落点在前端 `public/core/clock.js`。
 *
 * ⭐ **"现在"由调用方传进来**（`nowMs`，epoch 毫秒）：路由层取一次 `Date.now()` 传下来 ——
 *    这样本文件**不读 `Date.now()`**，测试可以喂假时间（「切走 3 分钟」「暂停 2 分钟」「超时」
 *    这些场景才能机器验），而且两个后端面对的是**同一个"现在"**。
 *
 * ⭐ **统计口径只在文件里一份**（`pomodoroStats`）：今日 / 本周「几个番茄、共多少分钟」
 *    全在这一处算，⛔ 前端不许另算一套（一条记录只归一天，`date` 取**开始那一刻**）。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.32
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md
 */
const { badRequest, notFoundErr } = require('../../../core/store/helpers.js');

/**
 * 四个时长偏好的**缺省值** —— ⭐ 全项目**唯一一处**。
 *
 * 说明：⚠️ 两个后端与建表语句都**不兜默认值**（`getPomodoroPrefs()` 取不到就回 null）：
 *      默认值分散在多处时，表现是「换了后端时长就变了」，而且查起来毫无线索
 *      （与 `teamwork` 的 `REMINDER_PREFS_DEFAULT` 同一条理由）。
 *      这里就是方案 §十二 待拍板第 3 项认可的推荐值（25 / 5 / 15，轮次 4）。
 * @type {Object.<string, number>}
 */
const PREF_DEFAULT = { focus_min: 25, break_min: 5, long_break_min: 15, rounds_before_long: 4, sound_on: 0 };

/**
 * 偏好里**允许被写**的五个键 —— 与 `upsertPomodoroPrefs` 的几个列一一对应（多一个都没有去处）。
 *
 * 说明：⚠️ 请求体里多出来的键一律丢弃，⛔ 绝不让它顺着 `Object.assign` 流到别的列上。
 *      ⚠️ 与两个后端里那份 `PREF_KEYS` **必须逐字一致**（原语层不许 require 业务层常量，故各留一份）。
 *      ⚠️ `sound_on` 是 0/1（不是分钟），它的校验在路由层是**另一个函数**（布尔档）。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['focus_min', 'break_min', 'long_break_min', 'rounds_before_long', 'sound_on'];

/**
 * 一条记录是「专注」还是「休息」—— 与 DDL 的 `CHECK (kind IN (…))` **逐字一致**。
 *
 * 说明：⭐ 一份清单两处用（写侧判合法、统计侧分类），⛔ 别在别处再写一遍字符串。
 * @type {Array.<string>}
 */
const SESSION_KINDS = ['focus', 'short_break', 'long_break'];

/**
 * 功能：把 epoch 毫秒转成**本地时区**的归属日 `YYYY-MM-DD`。
 *
 * 说明：⭐ 与 `helpers.today()` 同一算法，但**入参是调用方给的时刻**（不是 `Date.now()`）——
 *      番茄钟的「今天」必须与它算出的「现在」同源，否则跨零点前后会出现
 *      「剩余时间按今天算、统计按昨天算」这种半截状态。
 *
 * @param {number} ms - epoch 毫秒
 * @returns {string} 本地日期字符串 `YYYY-MM-DD`
 */
function dateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：取某个日期所在**周一的日期**（本周统计的左端点）。
 *
 * 说明：⚠️ 「本周 = 周一起」这条口径**只在本文件里一份**。不借课表的 `date-util`：
 *      那是课表模块的实现，跨模块 import 别人的实现属越界（铁律 11 /）——
 *      而这里只有三行，抄一份比建一条跨模块依赖便宜。
 *
 * @param {string} dateStr - 本地日期 `YYYY-MM-DD`
 * @returns {string} 同一周的周一 `YYYY-MM-DD`
 */
function mondayOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const wd = (new Date(y, m - 1, d).getDay() + 6) % 7; // 周一 = 0 … 周日 = 6
  const mon = new Date(y, m - 1, d - wd);
  const p = (n) => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${p(mon.getMonth() + 1)}-${p(mon.getDate())}`;
}

/**
 * 功能：把一条专注记录整理成界面要的形状（同一份字段名，两端共用）。
 *
 * 说明：⭐ **不给出"剩余秒数"**（本模块刻意不存它）—— 前端拿 `started_at` / `planned_seconds` /
 *      `paused_total` / `paused_at` 自己重算（纯函数 `clock.remaining`）。多给一个派生列，
 *      就是给"两份真相"开一道口子。
 *
 * @param {Object} r - 库里的行
 * @returns {Object} 界面用的对象
 */
function shape(r) {
  return {
    id: Number(r.id),
    started_at: Number(r.started_at) || 0,
    planned_seconds: Number(r.planned_seconds) || 0,
    ended_at: r.ended_at == null ? null : Number(r.ended_at),
    status: String(r.status || 'running'),
    // ⭐ 0.8.32：专注 / 短休 / 长休 —— 认不出来的值一律当「专注」（老数据没有这一列时就是这个值）
    kind: SESSION_KINDS.includes(String(r.kind)) ? String(r.kind) : 'focus',
    paused_at: r.paused_at == null ? null : Number(r.paused_at),
    paused_total: Number(r.paused_total) || 0,
    date: String(r.date || ''),
    task_id: r.task_id == null ? null : Number(r.task_id),
    task_source: r.task_source == null ? null : String(r.task_source),
  };
}

/**
 * 功能：算「从某个起点到现在」经过了多少**整秒**（负数一律按 0）。
 *
 * 说明：⚠️ 只用于**暂停时长的结算**（暂停起点 `paused_at` → 现在）。它算出来的数字
 *      **立刻落库**（进 `paused_total`），不是界面上的倒计时 —— 界面的倒计时仍在
 *      前端 `clock.remaining()` 里重算。别把这两件事混起来。
 *
 * @param {?number} fromMs - 起点（epoch 毫秒）；为空时返回 0
 * @param {number} nowMs - 现在（epoch 毫秒）
 * @returns {number} 经过的整秒数
 */
function secondsSince(fromMs, nowMs) {
  if (fromMs == null) return 0;
  return Math.max(0, Math.round((Number(nowMs) - Number(fromMs)) / 1000));
}

module.exports = {
  /**
   * 功能：读本账号的时长偏好 —— ⭐ **缺省值在这里合并**（表里没有行时也给一份可用的）。
   *
   * 说明：⭐ 这是「默认值只有一处」的落点（`PREF_DEFAULT`）：两个后端都不兜默认值，
   *      所以「这台机器还从没改过番茄钟设置」与「改了、但改成了默认值」对外表现完全一样。
   *      ⚠️ 库里的值可能是字符串（老库 / 手改过的 JSON）—— 统一压成整数，
   *      否则前端 `focus_min === 25` 这种判据会在 `'25'` 上静默比错。
   *
   * @param {number} uid - 账号 id
   * @returns {Object} `{ focus_min, break_min, long_break_min, rounds_before_long, sound_on }`
   */
  pomodoroPrefs(uid) {
    const row = this._bk.getPomodoroPrefs(Number(uid)) || {};
    const out = {};
    for (const k of PREF_KEYS) {
      const v = row[k];
      const n = Number(v);
      out[k] = v === undefined || v === null || v === '' || !Number.isFinite(n) ? PREF_DEFAULT[k] : Math.round(n);
    }
    return out;
  },

  /**
   * 功能：改本账号的时长偏好 —— ⭐ **带哪个键写哪个键**，返回改完之后的完整值。
   *
   * 说明：⚠️ **区间校验不在这一层**（超区间 / 非数字 / 负数一律由路由层的 `checkPomodoroPrefs`
   *      打回 400，⛔ 不静默截断）—— 这里只认 `PREF_KEYS` 里的键。
   *      ⚠️ 写法是「先读合并、再整份写回」：`upsertPomodoroPrefs` 收的是**整行**，
   *      于是「默认值」不必在两个后端里各写一份（见 `pomodoroPrefs()` 的说明）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} patch - 只含要改的那几个键（已由路由层校验）
   * @param {number} nowMs - 现在（epoch 毫秒，当 `updated_at` 用）
   * @returns {Object} 写入后的完整偏好
   * @throws {Error} 数据层只读时抛 503（由 HTTP 层收口）
   */
  pomodoroSavePrefs(uid, patch, nowMs) {
    this._assertWritable();
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.pomodoroPrefs(uid);
    for (const k of PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    this._bk.upsertPomodoroPrefs(Number(uid), next, Math.round(Number(nowMs)));
    return this.pomodoroPrefs(uid);
  },

  /**
   * 功能：开始一个番茄 —— 落 `started_at`（**服务端时刻**）+ `planned_seconds` + 归属日。
   *
   * 说明：⭐ 「V1 只做一个番茄」（方案 §三）：已经有活跃记录时直接 **400**，
   *      ⛔ 不悄悄放弃前一个 —— 那会把用户正在专注的那 20 分钟无声抹掉。
   *      ⚠️ `date` 取**开始那一刻**的日期：跨零点的那次专注只算**开始那天**，
   *      不拆成两条 —— 拆了「今日 / 本周」就有两份口径，两边必然对不上。
   *
   * @param {number} uid - 账号 id
   * @param {number} nowMs - 开始时刻（epoch 毫秒）
   * @param {Object} input - 已归一化：`{ minutes, task_id?, task_source? }`
   * @returns {Object} 新建的行（界面形状）
   * @throws {Error} 已有活跃番茄时抛 400；数据层只读时抛 503
   */
  pomodoroStart(uid, nowMs, input) {
    this._assertWritable();
    const me = Number(uid);
    const active = this._bk.findRunningPomodoro(me);
    if (active) throw badRequest('已经有一个番茄在计时了，先结束它再开下一个');
    const src = input || {};
    const row = {
      user_id: me,
      started_at: Math.round(Number(nowMs)),
      planned_seconds: Math.round(Number(src.minutes)) * 60,
      ended_at: null,
      status: 'running',
      // ⭐ 0.8.32：从这一条路口进的一律是**专注**；休息走 `pomodoroBreak()`
      kind: 'focus',
      paused_at: null,
      paused_total: 0,
      date: dateOf(Number(nowMs)),
      task_id: src.task_id == null ? null : Number(src.task_id),
      task_source: src.task_source == null ? null : String(src.task_source),
    };
    return shape(this._insert('time_pomodoro_sessions', row));
  },

  /**
   * 功能：开一次**休息** —— 短休 / 长休，时长取自偏好（`break_min` / `long_break_min`）。
   *
   * 说明：⭐⭐ 0.8.32（「休息阶段要落库，进统计与日程表」）——
   *      休息与专注**同一条状态机**（同一张表、同一个 `status`、同一套暂停/结束动作），
   *      只有 `kind` 不同。这样「一次只跑一个」这条护栏自动覆盖休息：⛔ 干活时不能休息、
   *      休息时不能开新番茄，不必再写第二条判据（两处判据迟早对不上）。
   *      ⚠️ **时长由服务端从偏好里取**（⛔ 不收前端传的分钟数）：界面上那两个数是同一份偏好，
   *      让前端再传一遍就是第二份真相 —— 而且多一条要校验的入参。
   *      ⚠️ 它是**短休还是长休由界面决定**（界面知道这是今天第几个番茄）——
   *      服务端只负责如实记下「用户开了一次哪种休息」，⛔ 不替界面推算轮次。
   *
   * @param {number} uid - 账号 id
   * @param {number} nowMs - 开始时刻（epoch 毫秒）
   * @param {string} kind - `short_break` 或 `long_break`
   * @returns {Object} 新建的行（界面形状）
   * @throws {Error} `kind` 不合法 / 已有活跃记录时抛 400；数据层只读时抛 503
   */
  pomodoroBreak(uid, nowMs, kind) {
    this._assertWritable();
    const me = Number(uid);
    if (kind !== 'short_break' && kind !== 'long_break') throw badRequest('休息只有短休与长休两种');
    const active = this._bk.findRunningPomodoro(me);
    if (active) throw badRequest('还有一条正在计时，先结束它再开始休息');
    const prefs = this.pomodoroPrefs(me);
    const min = kind === 'long_break' ? prefs.long_break_min : prefs.break_min;
    const row = {
      user_id: me,
      started_at: Math.round(Number(nowMs)),
      planned_seconds: Math.round(Number(min)) * 60,
      ended_at: null,
      status: 'running',
      kind,
      paused_at: null,
      paused_total: 0,
      date: dateOf(Number(nowMs)),
      task_id: null,
      task_source: null,
    };
    return shape(this._insert('time_pomodoro_sessions', row));
  },

  /**
   * 功能：暂停当前这个番茄 —— 落 `paused_at`（本次暂停起点）并把状态改成 `paused`。
   *
   * 说明：⭐ 「暂停 = 一个事实」（方案 §四-7）：暂停**必须落库**，⛔ 不许只在内存里记 ——
   *      否则刷新页面即丢，用户回来看到倒计时还在走。`paused_total` 的**累加在继续那一刻**
   *      （见 `pomodoroResume`），所以这里只记起点、不动累计值。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 记录 id
   * @param {number} nowMs - 暂停时刻（epoch 毫秒）
   * @returns {Object} 改写后的行（界面形状）
   * @throws {Error} 不属于本人 / 不存在时抛 404；状态不是 `running` 时抛 400
   */
  pomodoroPause(uid, id, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getPomodoroSession(me, id);
    if (!cur) throw notFoundErr('番茄记录');
    if (cur.status !== 'running') throw badRequest('这个番茄现在不是进行中，没法暂停');
    this._bk.setPomodoroSession(me, id, 'paused', null, Number(cur.paused_total) || 0, Math.round(Number(nowMs)));
    return shape(this._bk.getPomodoroSession(me, id));
  },

  /**
   * 功能：从暂停里继续 —— 把这次停了多久加进 `paused_total`，清掉 `paused_at`，状态回 `running`。
   *
   * 说明：⭐ 暂停期间**不消耗**计划时长：前端重算剩余时会减掉 `paused_total` 与
   *      「当前这段正在进行的暂停」，所以界面上看到的是「暂停 2 分钟 ⇒ 剩余顺延 2 分钟」。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 记录 id
   * @param {number} nowMs - 继续时刻（epoch 毫秒）
   * @returns {Object} 改写后的行（界面形状）
   * @throws {Error} 不属于本人 / 不存在时抛 404；状态不是 `paused` 时抛 400
   */
  pomodoroResume(uid, id, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getPomodoroSession(me, id);
    if (!cur) throw notFoundErr('番茄记录');
    if (cur.status !== 'paused') throw badRequest('这个番茄没有在暂停，没法继续');
    const total = (Number(cur.paused_total) || 0) + secondsSince(cur.paused_at, nowMs);
    this._bk.setPomodoroSession(me, id, 'running', null, total, null);
    return shape(this._bk.getPomodoroSession(me, id));
  },

  /**
   * 功能：结束这个番茄 —— 落 `ended_at` + 终态（`completed` 完成 / `abandoned` 放弃）。
   *
   * 说明：⭐ 到点之后**由用户点确认**才走到这里（方案 §四-6）：超时未确认时界面显示
   *      「已完成，待确认」，⛔ 服务端**绝不静默补记** —— 那等于替用户编了一份他没做的事。
   *      ⚠️ 结束时若还在暂停中，先把这段暂停结算进 `paused_total`（保住"停了多久"这个事实）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 记录 id
   * @param {number} nowMs - 结束时刻（epoch 毫秒）
   * @param {string} status - `completed` 或 `abandoned`
   * @returns {Object} 改写后的行（界面形状）
   * @throws {Error} 不属于本人 / 不存在时抛 404；已经结束时抛 400
   */
  pomodoroFinish(uid, id, nowMs, status) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getPomodoroSession(me, id);
    if (!cur) throw notFoundErr('番茄记录');
    if (cur.status === 'completed' || cur.status === 'abandoned') throw badRequest('这个番茄已经结束了');
    let total = Number(cur.paused_total) || 0;
    if (cur.status === 'paused') total += secondsSince(cur.paused_at, nowMs);
    this._bk.setPomodoroSession(me, id, status, Math.round(Number(nowMs)), total, null);
    return shape(this._bk.getPomodoroSession(me, id));
  },

  /**
   * 功能：统计某区间内**已完成**的番茄数与本该占用的分钟数，外加**休息**那一路的同款数字。
   *
   * 说明：⭐ 口径**只在这里一份**：按 `date`（= 开始那一刻的归属日）落在
   *      `[左端点, 今天]` 内、且 `status === 'completed'` 的记录；
   *      `abandoned`（放弃）**不计入**完成数 —— 但它仍在明细里看得到（那是另一条路）。
   *      ⭐⭐ 0.8.32：`kind === 'focus'` 的进 `count` / `seconds` 这几个老字段（**口径一字未改**），
   *      休息（`short_break` / `long_break`）单独进 `breaks` —— ⛔ **不与番茄相加**：
   *      「3 个番茄」与「2 次休息」是两种东西，加在一起得到的数谁也不知道是什么。
   *      ⚠️ `range` 只认 `'week'`，其余一律当 `'today'`（不认识的值当"今天"，
   *      比打回 400 更符合"列表接口不回 400"的既有口径）。
   *      ⛔ 不给"效率分 / 健康度 %"这类伪精确指标。
   *
   * @param {number} uid - 账号 id
   * @param {string} range - `'today'`（默认）或 `'week'`
   * @param {number} nowMs - 现在（epoch 毫秒，决定"今天"是哪天）
   * @returns {{count: number, seconds: number, minutes: number,
   *     breaks: {count: number, seconds: number, minutes: number}}}
   *     专注：完成数 / 总秒数 / 总分钟数（四舍五入）；休息：同三个字段
   */
  pomodoroStats(uid, range, nowMs) {
    const today = dateOf(Number(nowMs));
    const from = range === 'week' ? mondayOf(today) : today;
    let count = 0;
    let seconds = 0;
    let bc = 0;
    let bs = 0;
    for (const r of this._bk.listPomodoroSessions(Number(uid))) {
      if (r.status !== 'completed') continue;
      const d = String(r.date || '');
      if (d < from || d > today) continue;
      const secs = Number(r.planned_seconds) || 0;
      // ⚠️ 判据与 `shape()` 同一份：认不出来的 kind 一律当专注（老数据）
      if (SESSION_KINDS.includes(String(r.kind)) && String(r.kind) !== 'focus') {
        bc += 1;
        bs += secs;
        continue;
      }
      count += 1;
      seconds += secs;
    }
    return {
      count,
      seconds,
      minutes: Math.round(seconds / 60),
      breaks: { count: bc, seconds: bs, minutes: Math.round(bs / 60) },
    };
  },

  /**
   * 功能：把「一屏所需的全部」一次给全 —— 当前状态 + 偏好 + 今日 / 本周统计。
   *
   * 说明：⭐ 合并成**一个** `GET /api/pomodoro`：少一次请求、少一处 401 分支，
   *      而且进屏时"状态 / 时长 / 统计"三块不会各闪一次。
   *      ⭐⭐ **`nowMs` 是搭车给出去的**（方案 §4.5）：前端 `core/clock.js` 用它算一次
   *      常数偏移，此后所有倒计时都从"服务端的现在"重算 —— ⛔ 不为对时单开一个接口
   *      。
   *      ⭐ 0.8.32：`session.kind` 告诉界面当下这条是**专注还是休息**（界面据此换配色与文案）；
   *      `stats.today/week` 各带一份 `breaks`（见 `pomodoroStats`）。
   *
   * @param {number} uid - 账号 id
   * @param {number} nowMs - 服务端当前时刻（epoch 毫秒）
   * @returns {{nowMs: number, session: ?Object, prefs: Object, stats: Object}} 一屏所需的全部
   */
  pomodoroState(uid, nowMs) {
    const active = this._bk.findRunningPomodoro(Number(uid));
    return {
      nowMs: Math.round(Number(nowMs)),
      session: active ? shape(active) : null,
      prefs: this.pomodoroPrefs(uid),
      stats: {
        today: this.pomodoroStats(uid, 'today', nowMs),
        week: this.pomodoroStats(uid, 'week', nowMs),
      },
    };
  },
};
