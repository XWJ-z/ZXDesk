'use strict';
/**
 * core/store/methods/stats.js —— 统计 / 搜索 / 导出 / 课表计数
 * 功能：存储层的统计与检索方法集合 —— `todayCounts` 算某一天的今日待办数，
 * `summary` 汇总原先那版首页看板所需的全部口径，`dashboard`按日期区间汇总
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const { today, nowStamp, addDays, numOr, sanitizeUser } = require('../helpers.js');
const { registry, exportFragments } = require('../../../modules/registry.js');
const ti = require('../../timetable/date-util.js');
const AU = require('../../timetable/adjust-util.js');
const DR = require('../../timetable/day-rules.js');
// 假日口径（休息日 / 假前一天 / 下午提前）—— 就是这一版从模块搬回 `core/` 的那个文件，
const hd = require('../../timetable/holiday-util.js');

/**
 * 功能：挑出「区间起点落在它的周次里」的那个学期 —— 首页看板要把课表展开成日期，必须先知道用哪个学期。
 *
 * 说明：⭐ 服务端此前**没有「当前学期」这个概念**（哪个学期是前端 `state.ttTermId` 挑的，且是「没选过
 * 就变了」。规则按优先级：
 * ① 开学日期最晚、且 `from` 落在它 `[第 1 周, 总周数]` 内的那个学期（一天跨两个学期的极少见，
 */
function pickTermFor(terms, from) {
  const dated = (terms || [])
    .filter((t) => t && t.start_monday)
    .sort((a, b) => String(a.start_monday).localeCompare(String(b.start_monday)));
  if (!dated.length) return null;
  /** 功能：判断 `from` 是否落在某学期的周次范围内。 @param {Object} t - 学期行 @returns {boolean} 落在范围内为 true */
  const covers = (t) => {
    const w = ti.weekNumberOf(t.start_monday, from);
    const max = numOr(t.total_weeks, 20);
    return w !== null && w >= 1 && w <= max;
  };
  const inner = dated.filter(covers);
  if (inner.length) return inner[inner.length - 1];
  const before = dated.filter((t) => String(t.start_monday) <= from);
  return before.length ? before[before.length - 1] : dated[0];
}

/**
 * 功能：给一批任务行补上它们绑定的网址（`bookmark_id` → `{ id, title, url }`）——
 * 跨模块功能「任务可绑定网址」。
 *
 * 说明：⚠️ 为什么解析放在**核心**而不是任务板模块里：网址收藏夹是一个**可以被整目录删掉**的模块，
 * ⇒ 这里用 `usable()` 那道门：模块不在（或账号关掉了它）时**一个都不补**，
 */
function attachBookmarks(store, uid, rows) {
  const on = usable(store, true, 'getBookmark');
  rows.forEach((r) => {
    const id = Number(r.bookmark_id);
    r.bookmark = on && id > 0 ? pickBookmark(store, uid, id) : null;
  });
}

/**
 * 功能：取一条书签的「对外最小信息」（id / 标题 / 网址）；取不到（删了 / 是别人的）时返回 null。
 * @param {Object} store - Store 实例
 * @param {number} uid - 账号 id
 * @param {number} id - 书签 id
 * @returns {?{id: number, title: string, url: string}} 书签摘要；不存在时 null
 */
function pickBookmark(store, uid, id) {
  const b = store.getBookmark(uid, id);
  if (!b) return null;
  return { id: Number(b.id), title: b.title || '', url: b.url || '' };
}

/**
 * 功能：判断某个模块**现在真的可用吗** —— 账号偏好没关 **且** 模块确实装着。
 *
 * 删掉之后 `hide_*` 列还在、值仍是 0 ⇒ 光看偏好会以为它可用，于是去调一个
 * **不存在的方法** ⇒ 看板与首屏双双 500。
 * 这是实测出来的：删掉 `timetable` 之后 `/api/dashboard` 与 `/api/bootstrap`
 */
function usable(store, on, ...methods) {
  return !!on && methods.every((m) => typeof store[m] === 'function');
}

/**
 * 功能：把某学期的课表展开成「区间内每一天实际上什么课」—— 首页看板的课程区就用这个列表。
 *
 * 说明：⭐ 课表本身是「按周重复」的（一条课次罩着 1-16 周），所以必须逐日展开：
 * 日期 → 周次（`weekNumberOf`）→ 该周的课次（`weeksInclude`）→ 单次调课合并（`applyAdjustments`）
 * 停课的课次由 `applyAdjustments` 直接剔除（与课表页同一个行为）。
 */
function courseItems(store, uid, from, to) {
  const terms = store.listTerms(uid);
  if (!terms.length) return { term: null, reason: 'no_term', items: [] };
  const term = pickTermFor(terms, from);
  if (!term) return { term: null, reason: 'no_start_monday', items: [] };
  const sch = store.scheduleOf(uid, term.id);
  if (!sch) return { term: null, reason: 'no_start_monday', items: [] };
  const periods = new Map((sch.periods || []).map((p) => [Number(p.index_no), p]));
  const allAdj = store.listAdjustments(uid, term.id);
  // **本节备注**（`(课次, 日期)`）—— 看板列的是「某一天的课」，所以带上那一天那一条。
  // 键取**看板上的真实日期**（下面循环里的 `d`），不是调休的源日期 `src` ——
  // 用户写备注时看的就是「这一天」，看板也得按同一天取，两处口径才会一致。
  const dayNotes = new Map(
    (sch.day_notes || []).map((n) => [`${Number(n.session_id)}\u0000${String(n.date)}`, String(n.note || '')]),
  );
  // 先按周次把「这一周真正要画的课次」算好（同一个月里可能横跨好几周，同一周别算两遍）
  const byWeek = new Map();
  /** 周次 → 该周合并调课之后的课次数组 */
  const cellsOfWeek = (w) => {
    if (!byWeek.has(w)) {
      // 与 `modules/timetable/routes.js` 的 `?week=N` 逐字同一条路：先按周次筛，再合并单次调课
      // （第 4 参传全量课次 —— 跨周调课的目标周可能本来不覆盖这一周）
      const cells = sch.cells.filter((c) => ti.weeksInclude(c.weeks, w));
      byWeek.set(w, AU.applyAdjustments(cells, allAdj, w, sch.cells));
    }
    return byWeek.get(w);
  };
  // 假期调休（按天）：这一天该按**哪一天**的课表上 —— 停课日没有课，补课日借用源日期那一列。
  // 判定只有一份（`core/timetable/day-rules.js`），与课表页（`modules/timetable/routes.js`）共用；
  // 各写一份的话，迟早出现「课表页调休了、首页看板还按老课表显示」。
  const dayRuleRows = store.listDayRules(uid, term.id);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = DR.resolveDay(dayRuleRows, d);
    if (day.off) continue; // 停课日：一节课都没有
    // 两套日期别混：`src` 决定**取哪一天的课**，`d` 决定**这是看板上的哪一天**
    // （写进 item 的 `date` / `weekday` / `week_no` 一律用真实日期 —— 它们是「今天」的判定依据，
    const src = day.srcDate || d;
    const sw = ti.weekNumberOf(term.start_monday, src);
    const w = ti.weekNumberOf(term.start_monday, d);
    if (!(sw >= 1) || !(w >= 1)) continue;
    const swd = ti.weekdayOfDate(src);
    const wd = ti.weekdayOfDate(d);
    // 这一天的课**是不是已经被借到别的日子上了**（本日是某条补课规则的源日期）——
    // 它们照常列出来（不能凭空消失），但要带上 `rescheduled` 让界面画成「已调休」的灰行。
    const movedTo = DR.movedToOn(dayRuleRows, d);
    cellsOfWeek(sw)
      // 跨周调课的**源周灰条**不算「这天有课」（它已经调到别的周了）—— 课表页画灰条是为了
      // 让人看见「这节课去哪了」，首页看板是**今天要上什么**，列出来就是假的。
      .filter((c) => Number(c.weekday) === swd && !c.moved_out)
      .forEach((c) => {
        const a = periods.get(Number(c.period_start));
        const b = periods.get(Number(c.period_end)) || a;
        // 课表 2 期：格内**逐节**起止也一并解好带走 ——
        // 连堂内部的小课间（第 1 节下课 → 第 2 节上课）只藏在逐节时间里，
        // 看板前端的共享判定（`public/core/timetable.js` 的 `ttTodayNow`）靠它给出「课间 X 分钟」。
        const spans = [];
        for (let i = Number(c.period_start); i <= Number(c.period_end); i++) {
          const p = periods.get(i);
          if (p) spans.push({ start_time: p.start_time, end_time: p.end_time });
        }
        out.push({
          date: d,
          weekday: wd,
          week_no: w,
          session_id: Number(c.session_id),
          // 课名优先简称（与课表页一致：窄条里放得下）
          name: c.short_name || c.name || '',
          // `remark` 现在是**本节备注**（这一天这一节才有），取自 `time_timetable_day_notes`。
          // 原先它装的是课次备注（挂课次 = 按周重复）⇒ 看板上**这门课每天都顶同一句**，
          remark: dayNotes.get(`${Number(c.session_id)}\u0000${d}`) || '',
          course_remark: c.course_remark || '',
          room: c.room || '',
          period_start: Number(c.period_start),
          period_end: Number(c.period_end),
          start_time: a ? a.start_time : '',
          end_time: b ? b.end_time : '',
          spans,
          color: c.color || '#3b82f6',
          adjusted: !!c.adjusted,
          // 假期调休：这一天的课已被借走 ⇒ 界面画成「已调休」的灰行（**不是删掉**）
          rescheduled: !!movedTo,
          // **这一天是不是「假前一天」**（次日休息）—— 看板前端据此把下午的节次
          // 整体前移 `holiday_advance_minutes` 分钟（`shiftPeriods` 的前端那一份实现）。
          // 判定只有一份（`core/timetable/holiday-util.js`）：这里**只给布尔**，
          pre_holiday: hd.isPreHoliday(d),
        });
      });
  }
  out.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      x.period_start - y.period_start ||
      x.name.localeCompare(y.name) ||
      x.session_id - y.session_id,
  );
  return { term, reason: '', items: out };
}

module.exports = {
  /**
   * 功能：汇总首页看板一次要的全部口径 —— 今日待办 / 逾期 / 进行中项目 / 分项目进度 / 最近截止。
   * 说明：逾期的判据是「截止日 < 真实今天 且 未完成」，最近截止取「今天 ~ 今天+7 未完成」，两者都按截止日升序。
   *
   * 这里读的全是**任务板模块**（`modules/tasks/lib/*.js`）的方法 ——
   * 任务板是一个**可以被整目录删掉**的模块。删掉之后 `listProjects` / `listDailyTasks` /
   * `listProjectTasks` 在原型上都不存在，硬调就是 `is not a function` ⇒
   */
  summary(uid) {
    const t = today();
    // 三个方法**一起判**：任务板要么整套在、要么整套不在（`listProjectTasks` 缺一个
    const tasksOn = usable(this, true, 'listProjects', 'listDailyTasks', 'listProjectTasks');
    const projects = tasksOn ? this.listProjects(uid) : [];
    const daily = tasksOn ? this.listDailyTasks(uid) : [];

    const projMeta = {};
    const projTasks = [];
    projects.forEach((p) => {
      projMeta[p.id] = p;
      this.listProjectTasks(uid, p.id).forEach((r) => {
        projTasks.push({
          project_id: p.id,
          title: r.title,
          due_date: r.due_date,
          start_date: r.start_date,
          status: r.status,
        });
      });
    });

    // 每项目进度
    const progress = {};
    projects.forEach((p) => {
      const rows = projTasks.filter((r) => r.project_id === p.id);
      const done = rows.filter((r) => r.status === 'done').length;
      progress[p.id] = { total: rows.length, done, progress: rows.length ? Math.round((done / rows.length) * 100) : 0 };
    });

    // 逾期（截止日 < 今天 且 未完成），按截止日升序
    const overdueItems = [];
    daily.forEach((r) => {
      if (r.status !== 'done' && r.due_date && r.due_date < t) {
        overdueItems.push({
          source: 'daily',
          title: r.title,
          due_date: r.due_date,
          name: '日常任务',
          color: '#4f46e5',
          icon: '📅',
        });
      }
    });
    projTasks.forEach((r) => {
      if (r.status !== 'done' && r.due_date && r.due_date < t) {
        const p = projMeta[r.project_id];
        overdueItems.push({
          source: String(r.project_id),
          title: r.title,
          due_date: r.due_date,
          name: p ? p.name : '',
          color: p ? p.color : '#3b82f6',
          icon: p ? p.icon : '📁',
        });
      }
    });
    overdueItems.sort((a, b) => a.due_date.localeCompare(b.due_date));

    // 最近截止：今天 ~ 今天+7，未完成
    const t7 = addDays(t, 7);
    const recentDue = [];
    daily.forEach((r) => {
      if (r.status !== 'done' && r.due_date && r.due_date >= t && r.due_date <= t7) {
        recentDue.push({
          source: 'daily',
          title: r.title,
          due_date: r.due_date,
          name: '日常任务',
          color: '#4f46e5',
          icon: '📅',
        });
      }
    });
    projTasks.forEach((r) => {
      if (r.status !== 'done' && r.due_date && r.due_date >= t && r.due_date <= t7) {
        const p = projMeta[r.project_id];
        recentDue.push({
          source: String(r.project_id),
          title: r.title,
          due_date: r.due_date,
          name: p ? p.name : '',
          color: p ? p.color : '#3b82f6',
          icon: p ? p.icon : '📁',
        });
      }
    });
    recentDue.sort((a, b) => a.due_date.localeCompare(b.due_date));

    const activeProjects = projects.filter((p) => p.status === 'doing').length;
    return {
      date: t,
      // `todayCounts()` 是**任务板模块**的方法（模块可整目录删掉）——
      // 原语不在时回一组 0，判据只在下面那个包装里一处（与 `countTimetable` 同一手法）。
      today: this.todayCountsOf(uid, t),
      overdueCount: overdueItems.length,
      overdueItems,
      activeProjects,
      totalProjects: projects.length,
      // 总条数：前端据此判断「工作台是不是空的」（没有它就只能靠猜，会把只有远期任务的库误判为空）
      // 这里**只统计任务**（课表不算进来）—— 首页看板说的是「任务」。
      // 课表是否存在另给 `timetable` 字段（前端据此决定「空工作台」引导要不要提课表）。
      totals: {
        projects: projects.length,
        project_tasks: projTasks.length,
        daily_tasks: daily.length,
      },
      // 这个**核心包装**自己会处理「课表模块不在」（回一组 0），
      // 所以这里照常直接调 —— 「模块在不在」的判据只有一处（见 `countTimetable` 的说明）。
      // 但**账号偏好**这一道门在 `dashboard()` 里另有出口（那里的 `modules.timetable`），
      timetable: this.countTimetable(uid),
      progress,
      recentDue,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        color: p.color,
        status: p.status,
        ...progress[p.id],
      })),
    };
  },

  /**
   * 需关注的硬件、以及收藏夹与消息的概况。
   *
   */
  dashboard(uid, opts) {
    const o = opts || {};
    const u = Number(uid);
    const t = today();
    const from = o.from || t;
    const to = o.to || t;
    const me = this.getUser(u) || {};
    // 缺列一律按「不关闭」处理（与 `sanitizeUser` 同一个方向）：缺列的表现必须是照常显示，
    // 不能是「整块内容凭空消失」。
    const modules = {
      timetable: !me.hide_timetable,
      bookmarks: !me.hide_bookmarks,
      // 这一格的**键仍叫 `hardware`** —— 它与响应里的 `hardware` 字段、
      // 表名（`hardware_items`）、接口前缀（`/api/hardware`）是**同一套「数据种类键」**：
      // 那是对外契约，模块改名时一个字不动（见 `mobile/app.js` 里 `kind === 'hardware'`
      hardware: !me.hide_digital,
      teamwork: !me.hide_teamwork,
    };

    // ---- ① 任务：宽口径预筛（判据见函数说明）+ 归属项目 ----
    // 任务板是可以被整目录删掉的模块 —— 判据与下面几个模块同一条
    // （`usable()`：模块真的在）。删掉之后这一段整体退化成「区间内一条任务都没有」，
    const tasksOn = usable(this, true, 'listProjects', 'listDailyTasks', 'listProjectTasks');
    const projects = tasksOn ? this.listProjects(u) : [];
    const items = [];
    /** 功能：把一行任务按「与区间有没有交集」预筛后收进列表。 @param {Object} row - 任务行 @param {string} source - `'daily'` 或项目 id @param {?Object} proj - 所属项目（日常任务为 null） @returns {void} */
    const push = (row, source, proj) => {
      const s = row.start_date || row.due_date;
      const e = row.due_date || row.start_date;
      // **未完成且已过期的任务不受区间限制** —— 与 `core/dashboard.js` 的
      // `dashEntries()` 里那条「欠的账在任何区间里都算数」是同一条语义（服务端 + 前端各一处，
      // 对齐关系写在 `dashboard()` 的说明里）。
      const openOverdue = row.status !== 'done' && !!row.due_date && row.due_date < t;
      // 修订（「逾期任务点了完成不知道去哪里了，应该放到已完成里」）：
      // **已完成的任务，可见止取「完成日」**（提前完成 = 完成日；逾期补做 = 补做那一天）。
      // 不改这一条，一条 9/20 到期、10/2 补做的任务会被下面 `e < from` 整行滤掉 ——
      const doneAt =
        row.status === 'done' && row.completed_at ? String(row.completed_at).slice(0, 10) : '';
      const effE = doneAt && e && doneAt > e ? doneAt : e;
      if (!openOverdue && (!s || !effE || s > to || effE < from)) return;
      items.push({
        id: Number(row.id),
        source,
        title: row.title || '',
        status: row.status || 'todo',
        start_date: row.start_date || '',
        due_date: row.due_date || '',
        completed_at: row.completed_at || '',
        // （「周期任务的完成判定不对，当所有打卡都完成了还是逾期没有完成的状态，
        // 这个在提醒助手和首页看板中一直存在」）：**把周期任务的身份证带上**。
        // 根因就在这两个字段缺席：首页看板（`public/core/dashboard.js`）靠
        task_kind: row.task_kind || 'once',
        recur_rule: row.recur_rule || null,
        important: row.important ? 1 : 0,
        urgent: row.urgent ? 1 : 0,
        // 看板上要能**就地改任务**（点一条 → 弹详情 → 编辑 / 完成 / 删除），
        // 而详情弹窗与编辑表单都要拿这几个字段**回填**。
        // 少了它们，表单会拿空值覆盖回去 ——「负责人 / 标签 / 描述」被清空，而且不报任何错。
        assignee: row.assignee || '',
        tag: row.tag || '',
        description: row.description || '',
        content: row.content || '',
        // 跨模块：这条任务绑的网址（`bookmark` 由下面的 `attachBookmarks()` 补上）
        bookmark_id: row.bookmark_id ? Number(row.bookmark_id) : 0,
        // 归属项目：看板上每一条都得看得出「这是哪个项目的」
        name: proj ? proj.name : '日常任务',
        color: proj ? proj.color || '#3b82f6' : '#4f46e5',
        icon: proj ? proj.icon || '📁' : '📅',
      });
    };
    const daily = tasksOn ? this.listDailyTasks(u) : [];
    daily.forEach((r) => push(r, 'daily', null));
    let projectTaskCount = 0;
    projects.forEach((p) => {
      const rows = this.listProjectTasks(u, p.id);
      projectTaskCount += rows.length;
      rows.forEach((r) => push(r, String(p.id), p));
    });
    items.sort(
      (a, b) =>
        String(a.due_date || '').localeCompare(String(b.due_date || '')) ||
        Number(a.status === 'done') - Number(b.status === 'done') ||
        a.id - b.id,
    );
    // 把 `bookmark_id` 翻译成界面能直接显示的「网址标题 + 网址」
    attachBookmarks(this, u, items);

    // ---- ② 课程：把按周重复的课表展开成日期 ----
    // 判据是 `usable()`（偏好开着 **且** 模块真的在）—— 只看偏好会在模块被删掉时 500
    const course = usable(this, modules.timetable, 'listTerms', 'scheduleOf', 'listAdjustments')
      ? courseItems(this, u, from, to)
      : { term: null, reason: '', items: [] };

    // ---- ③ 硬件：「需关注」复用台账模块自己的判据，这里不另写一套 ----
    let hardware = { alert: 0, items: [] };
    /** 硬件那张卡的简要（见下面 ⑤）；模块关掉 / 不在时为 null */
    let hwBrief = null;
    if (usable(this, modules.hardware, 'listHardware')) {
      const r = this.listHardware(u, { focus: 'alert', sort: 'alert' });
      hardware = {
        alert: r.summary.alert,
        // 看板只摆最该看的前几条，其余靠「需关注 N 件」这个数说清 ——
        // 截断是**看得见**的（条数与总数都在），不是静默丢数据
        items: r.items.slice(0, 20).map((h) => ({
          id: Number(h.id),
          name: h.name || '',
          category: h.category || '',
          status: h.status,
          level: (h.life && h.life.level) || '',
          warranty: (h.life && h.life.warranty) || '',
          // 字段名是 `life.dueDate` + `hardware_items.warranty_until`（不是 `warranty_end`）——
          // 与 `hwDueKey()` 同一对来源，别自己猜列名
          due: (h.life && h.life.dueDate) || h.warranty_until || '',
        })),
      };
      // 「其它」那张卡的简要**复用同一次取数**（`summary` 里本来就有这两个数）
      hwBrief = { total: r.summary.total, alert: r.summary.alert };
    }

    // ---- ④ 收藏夹与消息：只要概况，不要列表 ----
    // 审核缺陷 ②：探针方法名**必须是这个模块独有的业务方法** ——
    // 原先写的是通用名 `list`，将来别家也定义一个 `list`（`Object.assign` 平铺到同一个原型上），
    const bmOn = usable(this, modules.bookmarks, 'listTags');
    let bookmarks = { total: 0, tags: 0 };
    if (bmOn) {
      const r = this.listBookmarks(u, '', null);
      // `tags` 要数的是**真分类** —— `listBookmarks()` 的响应里
      // 从本版起多了一项「未分类」**哨兵**（`{ id:'none', name:'未分类', count }`，给筛选下拉用）。
      // ⇒ 计数改走 `listTags()`（那张真表 —— 它本来就是上面那道守卫探的方法），
      bookmarks = { total: r.total, tags: this.listTags(u).length };
    }
    const teamworkOn = usable(this, modules.teamwork, 'teamworkListConversations');
    let teamwork = { unread: 0, conversations: 0, requests: 0 };
    if (teamworkOn) {
      const convs = this.teamworkListConversations(u);
      const rows = this._bk.listFriendships(u);
      teamwork = {
        unread: convs.reduce((n, c) => n + (Number(c.unread) || 0), 0),
        conversations: convs.length,
        requests: rows.filter((f) => f.status === 'pending' && Number(f.requested_by) !== u).length,
      };
    }

    // 课表那三个数**只算一次**（下面那个 `timetable` 键与 ⑤ 的 brief 共用）——
    // 跟 ③④ 那两块同一个道理：不为一张卡再查一遍。
    // 两条门都要过（偏好没关 **且** 模块真的在），见返回处那段长说明。
    const timetable = modules.timetable ? this.countTimetable(u) : { terms: 0, courses: 0, sessions: 0 };

    //
    // 「其它」原来只有网址收藏夹与未读消息，现在要**把各个模块都列出来**，
    // 一条一句简要，点一条就进对应的模块。
    const briefs = {};
    // 课表 / 番茄钟 / 行程并成一个模块 `time` ⇒
    // 「其它」里**一张卡**（`briefs` 的键**按定义就是模块名**，前端一律 `briefs[it.name]` 取）。
    // 各分项**按自己的子开关给**：关掉课表就没有 `courses`（`dashBrief()` 于是只说番茄那半句），
    const timeBrief = {};
    if (modules.timetable) {
      timeBrief.terms = timetable.terms;
      timeBrief.courses = timetable.courses;
      timeBrief.sessions = timetable.sessions;
    }
    if (usable(this, !me.hide_pomodoro, 'pomodoroStats')) {
      const s = this.pomodoroStats(u, 'today', Date.now());
      timeBrief.today_count = s.count;
      timeBrief.today_minutes = s.minutes;
    }
    if (Object.keys(timeBrief).length) briefs.time = timeBrief;
    if (bmOn) briefs.bookmarks = bookmarks;
    // 这一份 `briefs` 的键是**模块名**（`digital`），⛔ 不是上面那个
    // 数据种类键 `hardware` —— 前端一律拿 `briefs[it.name]` 取（`core/dashboard.js` 的
    // `dashBrief()`，两端各调用一次）。写成 `hardware` 的表现是**手机端「今天 → 其它」
    if (hwBrief) briefs.digital = hwBrief;
    if (teamworkOn) briefs.teamwork = teamwork;
    if (usable(this, !me.hide_idea, 'listIdeas')) {
      // `view: 'all'`：这三个人数是**未筛选前**的总量（`listIdeas()` 的说明里写着），
      // 不传的话默认只算未归档那一档 ⇒ 「一共 12 条」会写成 8
      const r = this.listIdeas(u, { view: 'all' });
      briefs.idea = { total: r.total, inbox: r.inbox };
    }
    // 第一参从 `!me.hide_calendar` 改成**恒 `true`** ——
    // 日历的 `module.json` 的 `switchField` 已改成 `null`（＝不可关的模块），入口与胶囊那套
    // 判据（`public/core/modules.js` 的 `moduleItems()`）因此**恒为开着**；这里若继续认
    if (usable(this, true, 'listCalendarEvents')) {
      // 本月的起止：1 号 → 「下个月 1 号的前一天」。⚠️ 全程字符串加减（`addDays`），
      // 不把 `Date` 带到外面 —— 本项目一贯的时区纪律。
      const monFrom = `${t.slice(0, 7)}-01`;
      const monTo = addDays(`${addDays(monFrom, 32).slice(0, 7)}-01`, -1);
      briefs.calendar = {
        month_count: this.listCalendarEvents(u, monFrom, monTo).length,
        // 这个账号进首页看板**要不要默认停在日历视图**。
        // 它**必须搭在这一趟上**：看板要在「取日历数据之前」就知道偏好，才能同时做到
        // 「偏好关 ⇒ 一个请求都不发（懒加载）」与「偏好开 ⇒ 进屏即取」。
        open_by_default: this.calendarView(u).default_view === 'cal',
      };
    }
    if (usable(this, !me.hide_ledger, 'ledgerAccounts')) {
      // 只给**账户个数**，不给金额：净值要在前端格式化（`fmtFen()` 住在记账模块里），
      briefs.ledger = { accounts: this.ledgerAccounts(u).length };
    }
    if (usable(this, !me.hide_vault, 'vaultStatus')) {
      // 只回「设没设主密码 / 现在锁没锁」：**条目数量刻意不给** —— 那是「你存了几个账号」的
      // 侧信道，`vaultStatus()` 的说明里已经把这条定死了（未解锁时没有理由回答），这里照它办。
      const st = this.vaultStatus(u);
      briefs.vault = { initialized: !!st.initialized, unlocked: !!st.unlocked };
    }
    if (usable(this, !me.hide_ai, 'aiGetConfigView')) {
      const c = this.aiGetConfigView(u);
      // 只说「配没配」—— `aiGetConfigView()` 本身**永不含 key 的任何投影**，这里也不加。
      briefs.ai = { configured: !!c.configured, enabled: !!c.enabled };
    }

    return {
      from,
      to,
      today: t,
      modules,
      tasks: { items },
      // `courses` 是**数组**（不是 `{items:[...]}`）—— 这是**全项目共用的返回契约**，
      // 消费方有四处在按数组用（看板前端 `public/core/dashboard.js`、`modules/calendar/store.js`、
      // 对话的 ticker 等）。⛔ 不要为了谁方便把它改成对象：动它就会连带一串改坏。
      courses: course.items,
      // 课程区为什么空着，得说得出原因（见 courseItems 的说明）
      course_term: course.term ? { id: course.term.id, name: course.term.name } : null,
      course_reason: course.reason,
      // 假日口径随看板下发 —— 与课表接口的 `holiday: plan` 是**同一份 `planOf()`**。
      // 看板前端据此把「假前一天下午」的节次整体前移（配合每条课的 `pre_holiday`）。
      // 课表关着 / 一个学期都没有时 `course.term` 是 null，`planOf(null)` 会如实回 `enabled: false`。
      holiday: hd.planOf(course.term),
      hardware,
      bookmarks,
      teamwork,
      // 各模块的「简要」（键 = 模块名；**关掉 / 删掉的模块这个键就不在**）——
      // 首页看板与手机「今天」的「其它」那一块靠它画卡片。见 ⑤ 那一段的说明。
      briefs,
      // 与 `summary.totals` 同口径（只数任务）：前端据此判断「工作台是不是空的」
      totals: { projects: projects.length, project_tasks: projectTaskCount, daily_tasks: daily.length },
      // ：这里**必须过两道门** ——
      // 「账号偏好没关（`modules.timetable`）**且** 模块的方法真的在」。
      // 修「删掉课表后 500」时把这一行改成了「只看模块在不在」，
      timetable,
    };
  },

  /**
   * 功能：给一批任务行补上它们绑定的网址（`bookmark_id` → `bookmark`）——
   * 跨模块功能「任务可绑定网址」，与 `dashboard()` 里那一处**同一份实现**，
   * 供任务板的列表接口（`GET /api/tasks`、`GET /api/projects/<id>/tasks`、`GET /api/daily`）在返回前调用。
   *
   * 说明：⚠️ 为什么要单独开一个方法、而不是让任务模块自己 join `bookmarks` 表：
   */
  attachBookmarkLinks(uid, rows) {
    attachBookmarks(this, Number(uid), rows || []);
    return rows;
  },

  /**
   * 说明：命中范围是日常任务的标题/内容、项目任务的标题/描述/负责人/标签，以及**项目名本身**
   * （搜项目名时返回该项目下全部任务，等于「按项目过滤」）。
   */
  search(uid, q) {
    const raw = String(q == null ? '' : q).trim();
    const key = raw.toLowerCase();
    if (!key) return { q: raw, hits: [], total: 0 };
    if (!usable(this, true, 'listProjects', 'listDailyTasks', 'listProjectTasks')) {
      return { q: raw, hits: [], total: 0, truncated: false };
    }
    const projects = this.listProjects(uid);
    const hits = [];
    const hit = (...vals) =>
      vals.some((v) =>
        String(v == null ? '' : v)
          .toLowerCase()
          .includes(key),
      );

    this.listDailyTasks(uid).forEach((t) => {
      if (hit(t.title, t.content)) {
        hits.push(Object.assign({}, t, { source: 'daily', name: '日常任务', icon: '📅', color: '#4f46e5' }));
      }
    });
    projects.forEach((p) => {
      const byProject = hit(p.name, p.description);
      this.listProjectTasks(uid, p.id).forEach((t) => {
        if (byProject || hit(t.title, t.description, t.assignee, t.tag)) {
          hits.push(
            Object.assign({}, t, {
              source: String(p.id),
              name: p.name,
              icon: p.icon || '📁',
              color: p.color || '#3b82f6',
            }),
          );
        }
      });
    });
    return { q: raw, hits: hits.slice(0, 200), total: hits.length, truncated: hits.length > 200 };
  },

  /**
   * 功能：导出数据（两个后端统一结果）—— 给「导出备份」按钮用。
   * 说明：⭐ 多用户：**只导出当前账号自己的数据**。导出接口同样受「数据完全独立」约束 ——
   * 管理员导出时也看不到成员的任务。
   *
   * **原语 `exportAll` 现在只回 `{ users }`**（核心自己那一张表）——
   * `modules/tasks/backend/*.js` 的 `exportTasks()`**，最终备份键由
   */
  exportAll(uid) {
    const users = (this._bk.exportAll(uid) || {}).users || [];
    // 模块化重构：**已搬迁模块自己的导出片段**（模块目录里的 `export.js`）。
    // 搬走一个模块，它那几行就从这个函数里消失、改由模块自己声明 —— 备份不再需要
    // 也走这一档：`modules/tasks/export.js` 从 `exportTasks()` 原语取数。
    //    ⚠️ 重名键由 `exportFragments()` 抛错兜住，免得「两份数据写进同一个备份键」变成静默少一份。 */
    const fragments = exportFragments(registry, this, uid);
    return {
      app: 'ZXDesk',
      version: this.appVersion,
      backend: this.backend,
      exportedAt: nowStamp(),
      counts: {
        // 各模块的片段里**每个数组**逐个记进 counts（口径 = 备份里真有几条）。
        // 任务板三张表的 `projects` / `project_tasks` / `daily_tasks` 也在这一档里，
        // 所以这里**不用**再手写它们 —— 手写的那一份会与片段「各说各话」（而两边都叫同一个名字）。
        ...Object.fromEntries(
          Object.entries(fragments)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, v.length]),
        ),
      },
      users: users.map(sanitizeUser),
      // 各模块自己的导出片段（模块目录里的 `export.js`）—— 任务板三张表、收藏夹三张表、
      // 硬件台账、密码库两张表、对话四张表、课表六组都从这里进来。搬走一个模块，它那几行就
      // 对话那四个键（`teamwork_*`）**个人导入一律跳过**（跨账号数据：好友指向的账号 id 与会话 id
      ...fragments,
    };
  },

  /**
   * 功能：今日待办数的**核心包装** —— 转发给任务板模块的 `todayCounts()`，原语缺席时回一组 0。
   *
   * 而它的**业务方法**住在 `modules/tasks/lib/tasks.js`（任务板自己的业务）——
   * 模块可以被整目录删掉，那时两边都不存在。
   * 调用方（`summary` 与 `routes/system.js` 的 `/api/bootstrap`）**都在首屏的必经之路上**：
   */
  todayCountsOf(uid, date) {
    const d = date || today();
    if (typeof this.todayCounts !== 'function') return { date: d, daily: 0, projects: {} };
    return this.todayCounts(uid, d);
  },

  /**
   * 功能：课表条数（学期 / 课程 / 课次）—— 给「空工作台」引导用。
   * 说明：**不进 `summary.totals`**（那里只数任务）。
   *
   * 实现它的**原语**（`countTimetable`）住在 `modules/timetable/`，
   * 模块可以被整目录删掉—— 那时这个原语不存在，
   */
  countTimetable(uid) {
    const u = Number(uid);
    if (typeof this._bk.countTimetable !== 'function') return { terms: 0, courses: 0, sessions: 0 };
    return this._bk.countTimetable(u);
  },
};
