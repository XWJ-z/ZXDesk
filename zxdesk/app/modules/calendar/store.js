'use strict';
/**
 * modules/calendar/store.js —— 日历业务方法
 * 功能：日历的业务方法 —— `calendarState`（一屏所需的全部：事件 + 开关 + **四个**图层 + 服务端「今天」
 * ＋ 还有「人生日历」的两项设置）/
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/18-日历-1期.md、docs/公共/开发方案/24-记账4期-图表趋势与导出联动.md
 */
const { addDays, badRequest, notFoundErr } = require('../../core/store/helpers.js');
// 假期口径：**core 里的共用文件**（不是某个模块的实现）⇒ 直接 require 不算跨模块依赖
const hd = require('../../core/holidays.js');

/**
 * 四个图层开关的**缺省值** —— ⭐ 全项目**唯一一处**。
 *
 */
const PREF_DEFAULT = { layer_course: 1, layer_task: 1, layer_holiday: 1, layer_ledger: 1 };

/**
 * 图层开关里**允许被写**的四个键 —— 与 `upsertCalendarPrefs` 的几个列一一对应（多一个都没有去处）。
 *
 */
const PREF_KEYS = ['layer_course', 'layer_task', 'layer_holiday', 'layer_ledger'];

/**
 *
 * 说明：⚠️ 与 `PREF_KEYS` **分成两份**是刻意的：两个原语各自只写自己那几个列，
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 「首页看板默认视图」**允许被写**的那一个键 —— 与 `upsertCalendarView` 的那一列一一对应。
 *
 */
const VIEW_KEYS = ['default_view'];

/**
 * 「首页看板默认视图」的两个合法取值与兜底值 —— ⭐ 全项目**唯一一处**（与 `PREF_DEFAULT` 同一条纪律）。
 *
 */
const VIEWS = ['list', 'cal'];
/** 兜底值：库里空 / 认不出来时用它（见 `normView()`） @type {string} */
const VIEW_FALLBACK = 'list';

/**
 * 四个图层的名字 —— 也是 `GET /api/calendar?layers=` 认的取值，顺序固定（响应里照这个顺序组装）。
 * @type {Array.<string>}
 */
const LAYER_KINDS = ['course', 'task', 'holiday', 'ledger'];

/**
 * 「课表模块在不在」的探针方法名 —— ⚠️ **必须是课表模块独有的业务方法**，不能是 `list` / `get`
 * 这种通用名：`Object.assign` 把各模块平铺到**同一个原型**上，通用名迟早被别家占用，
 */
const COURSE_METHODS = ['listTerms', 'scheduleOf', 'listAdjustments'];

/**
 * 「任务板在不在」的探针方法名 —— 同上（`listDailyTasks` / `listProjectTasks` 只属于任务板）。
 * @type {Array.<string>}
 */
const TASK_METHODS = ['listDailyTasks', 'listProjectTasks'];

/**
 *
 * 说明：⭐ 探针用的也是**记账第一次对外开的那扇门**（`modules/ledger/store.js` 的
 */
const LEDGER_METHODS = ['ledgerDailyTotals'];

/**
 * 功能：把 epoch 毫秒转成**本地时区**的日期 `YYYY-MM-DD`。
 *
 * 说明：⭐ 与 `helpers.today()` 同一算法，但**入参是调用方给的时刻**（不是 `Date.now()`）——
 * 「今天高亮的是新的一天、图层取数还按昨天」这种半截状态。
 * 服务端日期是**权威**（手机日期 / 时区不可靠），前端只管画。
 */
function dateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：把一条事件整理成界面要的形状（同一份字段名，两端共用）。
 *
 * 说明：⚠️ 空值一律给出**稳定的空形状**（`''` 而不是 `null` / `undefined`）：
 * `all_day` 压成 0/1 整数：老库 / 手改过的 JSON 里可能是 `'1'`，
 * `all_day === 1` 这种判据会在字符串上**静默比错**。
 */
function shape(r) {
  return {
    id: Number(r.id),
    title: String(r.title || ''),
    date: String(r.date || ''),
    end_date: r.end_date == null ? '' : String(r.end_date),
    all_day: r.all_day ? 1 : 0,
    start_time: r.start_time == null ? '' : String(r.start_time),
    end_time: r.end_time == null ? '' : String(r.end_time),
    note: r.note == null ? '' : String(r.note),
  };
}

/**
 *
 * 说明：⭐⭐ 这是本模块**唯一**一处判这三条的地方，而且判的是「改完之后整行长什么样」——
 */
function assertEventRow(row) {
  if (row.all_day) {
    if (row.start_time || row.end_time) {
      throw badRequest('设成全天就不能再填具体时刻了');
    }
  } else if (row.start_time && row.end_time && row.end_time < row.start_time) {
    throw badRequest('结束时刻不能早于开始时刻');
  }
  if (row.end_date && row.end_date < row.date) {
    throw badRequest('结束日期不能早于开始日期');
  }
}

/**
 * 功能：把「契约给的一组方法名」变成一个「这个模块现在真的在不在」的判据。
 *
 * 说明：⭐ 与 `core/store/methods/stats.js` 的 `usable()` 同一条思路（模块可以被**整目录删掉**，
 * 删掉之后 `hide_*` 列还在、值仍是 0 ⇒ 光看偏好会以为它可用，于是去调一个不存在的方法
 * 这里**不改共用文件**：`usable()` 没有对外导出，为了共用去动 `stats.js` 属于越界，
 */
function hasMethods(store, methodNames) {
  return methodNames.every((m) => typeof store[m] === 'function');
}

/**
 * 功能：把一个图层组装成界面要的形状（**开关 + 可用性 + 一句人话 + 条目**）。
 *
 * 说明：⭐ `on` 与 `available` 是**两件事**，必须分开（照 `dashboard()` 那两扇门的先例）：
 * `on` = 用户自己的开关（住 `calendar_prefs`）；
 * `available` = **现在还画得出来吗**（模块在不在 / 那个功能有没有被关掉）；
 */
function layer(kind, on, available, note, items) {
  const live = !!on && !!available;
  // **不再带**它的数据」）：留着数据只是界面不画，等于把「关掉」做成了一句谎话 ——
  // 响应里仍然看得到你关掉的那一层，而且它还会跟着响应一起走完整条链路。
  return { kind, on: live, available: !!available, note, items: live ? items : [] };
}

/**
 * 功能：把库里那一列归一成两个合法取值之一 —— 空 / 认不出来的一律回落 `VIEW_FALLBACK`。
 *
 * 说明：⚠️ 这一层是**必须**的：`default_view` 是可空的 `TEXT`，老库补出来的那一列是 `NULL`，
 * 手改过的 JSON 还可能是任意字符串。若不归一，前端会拿到一个第三值，
 * 「药丸开着、看板却按列表画」这类不一致就从这里开始（而且不报错）。
 */
function normView(v) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return VIEWS.includes(s) ? s : VIEW_FALLBACK;
}

module.exports = {
  /**
   * 功能：读本账号的四个图层开关 —— ⭐ **缺省值在这里合并**（表里没有行时也给一份可用的）。
   *
   * 说明：⭐ 这是「默认值只有一处」的落点（`PREF_DEFAULT`）：两个后端都不兜默认值，
   * 所以「这台机器还从没改过图层」与「改了、但改成了默认值」对外表现完全一样。
   * 库里的值可能是字符串（老库 / 手改过的 JSON）—— 统一压成 0/1，
   */
  calendarPrefs(uid) {
    const row = this._bk.getCalendarPrefs(Number(uid)) || {};
    const out = {};
    for (const k of PREF_KEYS) {
      const v = row[k];
      out[k] = v === undefined || v === null || v === '' ? PREF_DEFAULT[k] : Number(v) ? 1 : 0;
    }
    return out;
  },

  /**
   * 功能：改本账号的图层开关 —— ⭐ **带哪个键写哪个键**，返回改完之后的完整值。
   *
   * 说明：⚠️ 写法是「先读合并、再整份写回」：`upsertCalendarPrefs` 收的是**整行**，
   * 于是「默认值」不必在两个后端里各写一份（见 `calendarPrefs()` 的说明）。
   * 关掉一个图层**只影响画不画它**：事件一条不动，课表 / 任务本身也一行不改
   */
  calendarSavePrefs(uid, patch, nowMs) {
    this._assertWritable();
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.calendarPrefs(uid);
    for (const k of PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    this._bk.upsertCalendarPrefs(Number(uid), next, Math.round(Number(nowMs)));
    return this.calendarPrefs(uid);
  },

  /**
   *
   * 说明：⭐ **只读、不兜默认值** —— 与那四个图层开关同一条纪律：「默认 80 岁」是**显示口径**，
   */
  calendarLife(uid) {
    const row = this._bk.getCalendarPrefs(Number(uid)) || {};
    const bd = row.birth_date;
    const ey = row.expect_years;
    return {
      birth_date: bd === undefined || bd === null || String(bd).trim() === '' ? null : String(bd),
      expect_years: ey === undefined || ey === null || String(ey).trim() === '' ? null : Number(ey),
    };
  },

  /**
   * 功能：改本账号的「人生日历」两项设置 —— ⭐ **带哪个键写哪个键**。
   *
   * 说明：⚠️ 写法与 `calendarSavePrefs()` 逐字同构：「先读合并、再整份写回」——
   * `upsertCalendarLife` 收的是**那一行里属于它的那两个列**，于是「没带的键保持原样」
   * 在合并这一步就实现了（调用方不必先 GET 一遍）。
   */
  calendarSaveLife(uid, patch, nowMs) {
    this._assertWritable();
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.calendarLife(uid);
    for (const k of LIFE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    this._bk.upsertCalendarLife(Number(uid), next, Math.round(Number(nowMs)));
    return this.calendarLife(uid);
  },

  /**
   *
   * 说明：⭐ 与 `calendarLife()` 同一条纪律：**归一但不写回** —— 空 / 认不出来时读侧回落 `'list'`，
   */
  calendarView(uid) {
    const row = this._bk.getCalendarPrefs(Number(uid)) || {};
    return { default_view: normView(row.default_view) };
  },

  /**
   * 功能：改本账号的「首页看板默认视图」（逐键写入，返回改完之后的完整值）。
   *
   * 说明：⚠️ 写法与 `calendarSavePrefs()` / `calendarSaveLife()` 逐字同构（「先读合并、再整份写回」），
   * 但底下的原语只写 `default_view` 一列 —— 四个图层开关与人生日历两项**一个字节都不动**。
   * 调用方（路由层）**已经**把取值校验成 `'list'` / `'cal'` 之一；这里再过一遍 `normView`，
   */
  calendarSaveView(uid, patch, nowMs) {
    this._assertWritable();
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.calendarView(uid);
    for (const k of VIEW_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = normView(src[k]);
    }
    this._bk.upsertCalendarView(Number(uid), next, Math.round(Number(nowMs)));
    return this.calendarView(uid);
  },

  /**
   * 功能：列出本账号在 `[from, to]` 区间里的事件（**跨天事件两端都算命中**）。
   *
   * @param {number} uid - 账号 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   */
  listCalendarEvents(uid, from, to) {
    return this._bk.listCalendarEvents(Number(uid), from, to).map(shape);
  },

  /**
   * 功能：按 id 取一条事件（界面形状）；不存在 / 不属于本人返回 null。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 事件 id
   * @returns {?Object} 界面形状的事件；未命中为 null
   */
  getCalendarEvent(uid, id) {
    const row = this._bk.getCalendarEvent(Number(uid), Number(id));
    return row ? shape(row) : null;
  },

  /**
   * 功能：这条事件是不是这个账号的。
   *
   * 说明：⚠️ 判权与「存在」**共用同一个原语**（`getCalendarEvent` 的 `user_id` 条件）——
   * 分开写两个判据的下场是「越权能取到、但删不掉」这类**不一致**，
   * 而 要求越权与不存在**逐字一致**（都是 404）。
   */
  ownsCalendarEvent(uid, id) {
    return !!this._bk.getCalendarEvent(Number(uid), Number(id));
  },

  /**
   * 功能：新建一条事件 —— 落 `user_id` + 八个可写列 + 两个审计时刻。
   *
   * 说明：⭐ 插入走**通用原语** `_insert`（与 `pomodoro_sessions` / `idea_items` 同款）：
   * 它只过写闸门、**不**受 `allowedCols` 约束，所以本表白名单留空也建得进去。
   * 跨列约束在**落库之前**由 `assertEventRow` 判（判的是最终那一行）。
   */
  createCalendarEvent(uid, input, nowMs) {
    this._assertWritable();
    const src = input && typeof input === 'object' ? input : {};
    const row = {
      user_id: Number(uid),
      title: src.title,
      date: src.date,
      end_date: src.end_date || null,
      all_day: src.all_day ? 1 : 0,
      start_time: src.start_time || null,
      end_time: src.end_time || null,
      note: src.note || null,
      created_at: Math.round(Number(nowMs)),
      updated_at: Math.round(Number(nowMs)),
    };
    assertEventRow(shape(row));
    return shape(this._insert('calendar_events', row));
  },

  /**
   * 功能：改一条事件 —— ⭐ **逐字段**：请求带哪个键改哪个键，没带的保持原样。
   *
   * 说明：⭐ 做法是「**先取现状 → 把 patch 合上去 → 校验合并结果 → 整行写回**」：
   * 逐字段的语义在**合并**这一步实现（没带的键从现状里来），调用方不必先 GET 一遍；
   * 跨列约束判的是**合并之后**的行（只改 `all_day` 也会被 `assertEventRow` 拦住）；
   */
  updateCalendarEvent(uid, id, patch, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getCalendarEvent(me, Number(id));
    if (!cur) throw notFoundErr('日历事件');
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = shape(cur);
    for (const k of ['title', 'date', 'end_date', 'all_day', 'start_time', 'end_time', 'note']) {
      if (Object.prototype.hasOwnProperty.call(src, k)) {
        if (k === 'all_day') next[k] = src[k] ? 1 : 0;
        else if (k === 'end_date' || k === 'start_time' || k === 'end_time' || k === 'note') {
          next[k] = src[k] == null ? '' : String(src[k]);
        } else next[k] = String(src[k]);
      }
    }
    assertEventRow(next);
    this._bk.setCalendarEvent(
      me,
      Number(id),
      {
        title: next.title,
        date: next.date,
        end_date: next.end_date || null,
        all_day: next.all_day ? 1 : 0,
        start_time: next.start_time || null,
        end_time: next.end_time || null,
        note: next.note || null,
      },
      Math.round(Number(nowMs)),
    );
    return this.getCalendarEvent(me, id);
  },

  /**
   * 功能：删一条事件。
   *
   * 说明：⚠️ **先取一次再删**：取不到就 404（越权与不存在逐字一致），
   *
   * @param {number} uid - 账号 id
   */
  deleteCalendarEvent(uid, id) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getCalendarEvent(me, Number(id));
    if (!cur) throw notFoundErr('日历事件');
    return this._bk.deleteCalendarEvent(me, Number(id));
  },

  /**
   * 功能：算 `[from, to]` 区间里的四个**只读图层**。
   *
   * 说明：⭐⭐ 本模块的**核心纪律**在这里兑现：日历只负责「画出来 + 加开关」，
   * 「某天有什么」的判定**一个都不在本文件里**——
   * 课表 / 任务：**一次** `this.dashboard(uid, {from, to})`
   */
  calendarLayer(uid, from, to, kinds, nowMs) {
    const me = Number(uid);
    const want = new Set((Array.isArray(kinds) ? kinds : []).filter((k) => LAYER_KINDS.includes(k)));
    const prefs = this.calendarPrefs(me);

    // ---- 课表：先判「这个图层现在还画得出来吗」 ----
    const meRow = this.getUser(me) || {};
    // 两扇门（与 `dashboard()` 里那条注释同款）：账号偏好没关 **且** 模块的方法真的在。
    // 只看偏好的下场是删掉课表模块之后 500；只看模块的下场是
    // 「按账号关掉的模块仍然返回数据」，两处都违反既有决策。
    const courseOn = hasMethods(this, COURSE_METHODS);
    const courseAllowed = courseOn && !meRow.hide_timetable;
    const taskOn = hasMethods(this, TASK_METHODS);
    // （记账那层的数据直接来自它的公开方法，不经 `dashboard()`）。
    const ledgerOn = hasMethods(this, LEDGER_METHODS);

    // ---- 一次取数：课表 + 任务共用同一个 `dashboard()`（少一次跨模块往返）----
    const needBoard = (want.has('course') && courseAllowed) || (want.has('task') && taskOn);
    const board = needBoard && typeof this.dashboard === 'function' ? this.dashboard(me, { from, to }) : null;

    // ---- ① 课表图层 ----
    let course;
    if (!want.has('course')) {
      course = layer('course', false, courseAllowed, '', []);
    } else if (!courseOn) {
      course = layer('course', false, false, '这个应用里没有课表模块', []);
    } else if (!courseAllowed) {
      course = layer('course', false, false, '课表已经在设置里关掉了，打开它才能看这一层', []);
    } else {
      course = layer(
        'course',
        prefs.layer_course,
        true,
        courseReasonText(board && board.course_reason),
        (board ? board.courses : []).map((c) => ({
          date: String(c.date || ''),
          title: String(c.name || ''),
          start: String(c.start_time || ''),
          end: String(c.end_time || ''),
          room: String(c.room || ''),
          // ：
          // 日历里的课程条要显示成与看板列表视图**逐字相同**的那一句
          // （`9/30 周三 第 1–2 节 08:30–11:55 · 十教106室`）⇒ 节次与那两个标记必须一起带上，
          period_start: Number(c.period_start) || 0,
          period_end: Number(c.period_end) || 0,
          adjusted: c.adjusted ? 1 : 0,
          rescheduled: c.rescheduled ? 1 : 0,
        })),
      );
    }

    // ---- ② 任务截止图层 ----
    let task;
    if (!want.has('task')) {
      task = layer('task', false, taskOn, '', []);
    } else if (!taskOn) {
      task = layer('task', false, false, '这个应用里没有任务板模块', []);
    } else {
      const items = ((board && board.tasks && board.tasks.items) || [])
        // 修（「周期任务已经完成却还是显示逾期」）：
        // 周期任务**没有「单一截止日」这个事实** —— 它们的 `due_date` 是**整个周期的结束日**，
        // 而这一层把它当成「这一天到期」画出来；前端那两处「已逾期」分组
        .filter((t) => t.task_kind !== 'cycle')
        .filter((t) => {
          const d = String(t.due_date || '');
          if (d && d >= from && d <= to) return true;
          // 修订：「完成的任务应该（在它原来的位置）变灰色且划掉」——
          // 从前只按**截止日**收行 ⇒ 一条 9/20 到期、今天才补做的任务（截止日在网格之外）
          // 会被整行滤掉，于是「今天完成的」那一条**在日历上根本看不见**（而它本该画在完成日）。
          const dd = String(t.status === 'done' && t.completed_at ? String(t.completed_at).slice(0, 10) : '');
          return !!dd && dd >= from && dd <= to;
        })
        .map((t) => {
          const done = t.status === 'done';
          // 修订：「显示为今天截止的任务和今天完成的任务 —— 那种
          // 长时间的任务截止日期是 30 号、但是在 28 完成的了就**不要**在 30 号显示」。
          // ⇒ 图层要多带一个「它算哪一天做完的」：`completed_at` 的日期，老数据没有
          const doneDate = done
            ? String(t.completed_at || '').slice(0, 10) || String(t.due_date || '')
            : '';
          return {
            date: String(t.due_date),
            id: Number(t.id),
            title: String(t.title || ''),
            done: done ? 1 : 0,
            project: String(t.name || ''),
            // 「日历视图这个任务截止，显示的内容要和列表视图一模一样」——
            // 列表那边每条带「🔴 重要 / ⏰ 紧急」两枚徽章，可这两枚徽章的数据**两个视图各有自己的取法**：
            // 列表走 `core/dashboard.js` 的 `dashEntries()`（它读 `t.important` / `t.urgent`），
            important: t.important ? 1 : 0,
            urgent: t.urgent ? 1 : 0,
            done_date: doneDate,
            // 修订：「点击任务要弹出详情」—— 详情弹窗
            // （`openTaskDetail(scope, task)`）读的是**整条任务**，所以这一层得把 `source`
            // 与那份子对象一起带上。
            source: String(t.source || ''),
            // 手机端的任务详情弹层会把「所属」画成「<图标> <名字>」（`openTask()`），
            // 所以要连图标一起带上 —— 与 `project` 是同一条来源的两个字段。
            icon: String(t.icon || ''),
            task: {
              id: Number(t.id),
              status: String(t.status || ''),
              title: String(t.title || ''),
              start_date: String(t.start_date || ''),
              due_date: String(t.due_date || ''),
              completed_at: String(t.completed_at || ''),
              important: t.important ? 1 : 0,
              urgent: t.urgent ? 1 : 0,
              assignee: String(t.assignee || ''),
              tag: String(t.tag || ''),
              description: String(t.description || ''),
              content: String(t.content || ''),
              bookmark: t.bookmark || null,
              _scope: String(t.source || ''),
            },
          };
        });
      task = layer('task', prefs.layer_task, true, '', items);
    }

    // ---- ③ 法定假期图层 ----
    // 未收录年份**不猜**：那一年一个标记都不画，另给一句人话。
    // 这里逐日问 `core/holidays.js`，不自己去翻它的内部表（那是它的实现细节）。
    let holiday;
    if (!want.has('holiday')) {
      holiday = layer('holiday', false, true, '', []);
    } else {
      const years = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const y = d.slice(0, 4);
        if (!years.includes(y)) years.push(y);
      }
      const unknown = years.filter((y) => !hd.isYearKnown(y));
      const items = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (!hd.isYearKnown(d.slice(0, 4))) continue; // ⛔ 没收录的年份一天都不标
        if (hd.isRestDate(d)) items.push({ date: d, kind: 'rest' });
        else if (hd.isWorkDate(d)) items.push({ date: d, kind: 'work' });
      }
      holiday = layer(
        'holiday',
        prefs.layer_holiday,
        true,
        unknown.length ? `${unknown.join('、')} 年的假期数据还没收录，那一年先不标` : '',
        items,
      );
    }

    // 数据来自记账**公开业务方法** `ledgerDailyTotals()`：
    // 不读它的表、⛔ 不 require 它的文件、⛔ 更不另写一份「按天把金额加起来」。
    // 它回的**只有真有记账条目的那些天才有键**（没记账的日子没有键）⇒ 这里据此决定
    let ledger;
    if (!want.has('ledger')) {
      ledger = layer('ledger', false, ledgerOn, '', []);
    } else if (!ledgerOn) {
      ledger = layer('ledger', false, false, '这个应用里没有记账模块', []);
    } else {
      const totals = this.ledgerDailyTotals(me, from, addDays(to, 1), Number(nowMs)) || {};
      const items = Object.keys(totals)
        .sort()
        .map((d) => {
          const t = totals[d] || {};
          return {
            date: String(d),
            income_fen: Number(t.income_fen) || 0,
            expense_fen: Number(t.expense_fen) || 0,
          };
        });
      ledger = layer('ledger', prefs.layer_ledger, true, '', items);
    }

    return { course, task, holiday, ledger };
  },

  /**
   * 功能：把「一屏所需的全部」一次给全 —— 服务端「今天」+ 区间事件 + 四个开关 + 四个图层
   *
   * 说明：⭐ 合并成**一个** `GET /api/calendar`：少一次请求、少一处 401 分支，
   * 而且进屏时「事件 / 开关 / 图层」三块不会各闪一次。
   * 的原话是「能合并的请求必须合并」，反正进屏那一次就已经把这一行读出来了，
   */
  calendarState(uid, from, to, kinds, nowMs) {
    return {
      today: dateOf(Number(nowMs)),
      from: String(from),
      to: String(to),
      events: this.listCalendarEvents(uid, from, to),
      prefs: this.calendarPrefs(uid),
      life: this.calendarLife(uid),
      // `nowMs` 必须**原样传给图层**：记账那层要用它判「未来条目不算」
      // （与这里算 `today` 用的是同一个"现在"，跨零点也不会出现半截状态）。
      layers: this.calendarLayer(uid, from, to, kinds, nowMs),
    };
  },
};

/**
 *
 * 说明：⚠️ 这三条字符串由 `core/store/methods/stats.js` 的 `courseItems()` 定义，
 */
function courseReasonText(reason) {
  if (reason === 'no_term') return '还没有建过学期，课表图层先空着';
  if (reason === 'no_start_monday') return '学期还没填上「开学第一周的星期一」，课表算不出日期';
  return '';
}
