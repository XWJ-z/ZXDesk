/**
 * core/dashboard.js —— 首页看板的共用语义
 *
 * 功能：`DASH_PRESETS` 是区间档位（今日 / 单日 / 本周 / 本月），`dashRange()` 把一档折成闭区间，
 * `dashEntries()` 把 `GET /api/dashboard` 的响应折成「一条一条具体事项」
 * （任务 + 课程 + 硬件关注混在一列），`dashStats()` 再由它算出概览的五个数；
 * 另加三个：
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { addDays, dow, fmtLong, fmtShort, mondayOf, todayStr, weekName } from './date.js';
import { parseRule, periodsBetween } from './recur.js';
import { quadRank, visEnd } from './task.js';
// 「周期结束了就算这一轮做完」这条判据只有 `recur.js` 一处（`cycleState()`）——
// 别在这里写 `task_kind === 'cycle' && due_date <= today` 的第二份（改一处忘另一处就会
// 「看板说未完成、任务板说已完成」）。⚠️ `parseRule` / `periodsBetween` 上面那行已经导入了，
import { cycleState } from './recur.js';
import { ttShiftTimes } from './timetable.js';

/**
 * 区间档位：按钮上的字与顺序就是这里的顺序，两端共用（改一处要改两处 → 所以只留一处）。
 *
 */
export const DASH_PRESETS = [
  { key: 'today', label: '今日' },
  { key: 'day', label: '单日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

/**
 * 概览那五个数 —— **顺序就是界面上从左到右的顺序**（
 * 「任务概览：从左往右依次为：待办、课程、硬件要关注、已逾期、已完成」）。
 */
export const DASH_FILTERS = [
  { key: 'todo', label: '待办', match: (x) => x.kind === 'task' && !x.done },
  { key: 'course', label: '课程', match: (x) => x.kind === 'course' },
  { key: 'hardware', label: '数码要关注', match: (x) => x.kind === 'hardware' },
  { key: 'overdue', label: '已逾期', match: (x) => !!x.overdue },
  { key: 'done', label: '已完成', match: (x) => x.kind === 'task' && x.done },
];

/**
 * 功能：求某个月的最后一天。
 * 说明：`new Date(y, m, 0)` 取的是「下个月的第 0 天」＝本月最后一天 —— 只借它做天数运算，
 * 结果立刻回写成 `YYYY-MM-DD` 字符串，不把 `Date` 带出本函数（本项目一贯的时区纪律）。
 * @param {string} dateStr - 该月里的任意一天，`YYYY-MM-DD`
 * @returns {string} 该月最后一天 `YYYY-MM-DD`
 */
export function monthEnd(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 功能：把一档预设折成日期区间 —— 今日＝当天当天；**单日**＝用户挑的那一天（缺省今天）；
 * 本周＝周一~周日；本月＝1 号~月末。
 * 说明：`custom`（用户手改日期）不在这里，它的区间由调用方直接给出。
 * @param {string} preset - `today` / `day` / `week` / `month`
 * @param {string} [base] - 基准日（「单日」那一档就是用户挑的那天），缺省为今天
 */
export function dashRange(preset, base) {
  const t = base || todayStr();
  if (preset === 'week') return { from: mondayOf(t), to: addDays(mondayOf(t), 6) };
  if (preset === 'month') return { from: t.slice(0, 8) + '01', to: monthEnd(t) };
  // `today` 与 `day` 都是「一天」：区别只在基准日（今天 / 用户挑的那天）
  return { from: t, to: t };
}

/**
 * 功能：数两个日期相差多少天（闭区间长度由调用方 +1），用于「共 N 天」这类说明。
 * @param {string} a - 起始日 `YYYY-MM-DD`
 * @param {string} b - 结束日 `YYYY-MM-DD`
 * @returns {number} 相差天数（负数按 0 处理）
 */
export function diffDays(a, b) {
  const day = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };
  return Math.max(0, day(b) - day(a));
}

/**
 * 功能：把当前区间说成一句话 —— 一天就是那一天，跨天就是「起 ~ 止 · 共 N 天」。
 *
 * 「顶部写着 9/14 ~ 9/20、下面写着 9/15」这种自相矛盾，而且**不报任何错**。
 * @param {{from: string, to: string}} range - 闭区间两端
 * @returns {string} 一句人话；`from` 为空时返回空串
 */
export function dashRangeLabel(range) {
  if (!range || !range.from) return '';
  if (range.from === range.to) {
    return `${fmtLong(range.from)} ${weekName(range.from)}${range.from === todayStr() ? ' · 今天' : ''}`;
  }
  return `${fmtShort(range.from)} – ${fmtShort(range.to)} · 共 ${diffDays(range.from, range.to) + 1} 天`;
}

/**
 * 功能：求某一天**所在那一周**的 7 个格子（周一 → 周日），供区间条下面那条「一周」用。
 *
 * 两边各自看着都对、凑一起才发现不是同一个产品。
 * @param {string} [base] - 这一周里的任意一天 `YYYY-MM-DD`；缺省今天
 * @returns {Array.<{date: string, weekday: string, day: string, today: boolean}>} 7 个格子；
 */
export function dashWeekCells(base) {
  const mon = mondayOf(base || todayStr());
  const t = todayStr();
  return ['一', '二', '三', '四', '五', '六', '日'].map((weekday, i) => {
    const date = addDays(mon, i);
    return { date, weekday, day: fmtShort(date), today: date === t };
  });
}

/**
 * 功能：把一节课程的「什么时候 · 在哪」说成一句话 —— ⭐ **两处共用这一份**
 * （看板列表视图的课程行 `meta` ＋ 日历当天列表里的课程条）。
 *
 * 日历那一侧原来**自己拼**了一句短的（只有 `起–止 · 教室`），同一个应用里同一条课
 * 在两处写法不同 —— 典型的「两端/两处各写一份，迟早对不上」。
 */
export function courseWhenText(c) {
  const ps = Number(c.periodStart) || 0;
  const pe = Number(c.periodEnd) || 0;
  return `${fmtShort(c.date)} ${weekName(c.date)} 第 ${ps}${
    pe !== ps ? '–' + pe : ''
  } 节 ${c.start ? c.start + '–' + c.end : ''}${c.room ? ' · ' + c.room : ''}${
    c.adjusted ? ' · 调课' : ''
  }${c.rescheduled ? ' · 已调休' : ''}${c.preShifted ? ' · 已提前' : ''}`;
}

/**
 * 功能：把看板数据折成「一条一条具体事项」—— 任务、课程、需关注的硬件混在同一个列表里。
 *
 * 说明：⭐ 三样东西同列是（「不止是项目任务才显示」）：
 * 看板回答的是「这段时间我要干什么」，而「今天上什么课」「哪块盘该换了」与任务是同一个层级的问题。
 * 任务的可区间性走 `doneInfo()` / `visEnd()`（见文件头与函数内那一处），
 */
export function dashEntries(d) {
  const out = [];
  if (!d) return out;
  const today = todayStr();
  (d.tasks && d.tasks.items ? d.tasks.items : []).forEach((t) => {
    const s = t.start_date || t.due_date;
    // 修订（「逾期任务点了完成不知道去哪里了，应该放到已完成里」）：
    // **已完成的任务，可见止取「完成日」**（`doneInfo()`）：提前完成 = 完成日；逾期补做 = 补做那一天。
    // 从前一律走 `visEnd()`（它只在「完成日落在 [起始日, 截止日) 之内」才截断）⇒ 一条
    const e = visEnd(t, s, today);
    // **周期任务按期算可见性** —— 「这一天该做的那一期」，而不是「整个周期里天天都有」。
    // 它同时决定了这条 entry 的 `date`（本期截止日），界面据此排序与显示。
    const cyc = !!(t.task_kind === 'cycle' && parseRule(t.recur_rule));
    const periods = cyc ? periodsBetween(t, d.from, d.to) : [];
    const cur = periods.length ? periods[periods.length - 1] : null;
    // 精确判据：区间与 [起始日, 可见止] 有交集 —— 已完成的任务可见止就是完成日
    const inRange = cyc ? !cur : !s || !e || s > d.to || e < d.from;
    // 逾期未完成的**不受下界限制**（欠的账在任何区间里都算数，做完为止）
    // 周期任务**不进这条**（它的账按「每一期」各算，要打卡记录才算得准）——
    // 而且它的 `due_date` 一过就等于「这一轮做完了」，在这里判逾期会得出反的结论。
    const overdue = !cyc && t.status !== 'done' && !!t.due_date && t.due_date < today;
    if (inRange && !overdue) return;
    // ：
    // 完成判定**不再只看 `status`** —— 周期任务到了整个周期的结束日就算这一轮做完了
    // 从前这里写的是 `t.status === 'done'`，而周期任务**永远不会**被写成 `status='done'`
    const done = t.status === 'done' || (cyc ? cycleState(t, today).done : false);
    out.push({
      kind: 'task',
      key: `t${t.source}-${t.id}`,
      source: t.source,
      id: t.id,
      title: t.title,
      name: t.name,
      color: t.color,
      icon: t.icon,
      // 周期任务的日期取**本期**的截止日（见下面那处 `date` 的说明）。
      date: cur ? cur.end : t.due_date,
      overdue,
      done,
      // 重要 / 紧急提到**条目顶层**（「看不到任务的紧急和重要」）——
      // 从前它们只住在下面 `task` 那个嵌套对象里（那是给「就地改任务」回填表单用的），
      // 而看板行读的是顶层 ⇒ 一枚标记都画不出来。
      important: t.important ? 1 : 0,
      urgent: t.urgent ? 1 : 0,
      // 跨模块：任务上绑的网址（四象限详情与首页条目都靠它显示「网址标题」且可点）
      bookmark: t.bookmark || null,
      meta: cyc && cur
        ? `本期 ${fmtShort(cur.start)}${cur.end !== cur.start ? '–' + fmtShort(cur.end) : ''}`
        : `${done ? '已完成' : '截止'} ${fmtShort(t.due_date) || '未定'}`,
      // 一条**完整的任务对象** —— 看板点一条任务要就地弹详情（里头能编辑 / 完成 / 删除），
      // 而详情弹窗与编辑表单读的都是整条任务（`openTaskDetail()` / `openTask()`）。
      // 字段名必须与库里一致（那两处会拿它直接回填表单与拼 PUT 请求体）。
      task: {
        id: t.id,
        status: t.status,
        title: t.title,
        start_date: t.start_date || '',
        due_date: t.due_date || '',
        completed_at: t.completed_at || '',
        important: t.important ? 1 : 0,
        urgent: t.urgent ? 1 : 0,
        assignee: t.assignee || '',
        tag: t.tag || '',
        description: t.description || '',
        content: t.content || '',
        bookmark_id: t.bookmark_id ? Number(t.bookmark_id) : 0,
        bookmark: t.bookmark || null,
        // 任务类型这一维度的四个字段**必须一起带上** ——
        // 看板的编辑表单会拿这个对象**直接回填并拼 PUT 请求体**，缺了它们就是
        // 「在首页改一下标题，这条窗口 / 周期任务当场变回普通任务」而且不报错。
        task_kind: t.task_kind || 'plain',
        start_time: t.start_time || '',
        due_time: t.due_time || '',
        recur_rule: t.recur_rule || '',
        _scope: t.source,
      },
    });
  });
  // 「假前一天下午提前」—— 这一天下午的节次整体前移 N 分钟。
  // 分工钉死：「这一天是不是假前一天」由**服务端**给（`c.pre_holiday`），提前量与
  // 「几点算下午」也由服务端下发（`d.holiday`）；这里**只做应用**，
  const hp = d.holiday || {};
  (d.courses || []).forEach((c) => {
    const shifted =
      c.pre_holiday && hp.enabled ? ttShiftTimes(c, hp.advance_minutes, hp.pm_from) : null;
    // 偏移后的起止（没偏移就是原值）—— 下面 `meta` 的文字与三个时间字段**共用这两个**：
    // 各算一份就会「行里文字写着 13:30、倒计时按 13:00 走」，而且不报任何错。
    const st = shifted ? shifted.start_time : c.start_time || '';
    const et = shifted ? shifted.end_time : c.end_time || '';
    out.push({
      kind: 'course',
      key: `c${c.session_id}-${c.date}`,
      title: c.name,
      name: '今日课程',
      color: c.color,
      icon: '📘',
      date: c.date,
      period: c.period_start,
      // 两条备注口径分开，**都带**（后端 `courseItems()` 已按「看板上那一天」查好）——
      // `remark` = **本节备注**（这一天这一节，`timetable_day_notes`）；`course_remark` = 课程备注。
      // 从前 `remark` 装的是**课次备注**（挂课次 = 按周重复）⇒ 看板上这门课每天都顶同一句。
      remark: c.remark || '',
      course_remark: c.course_remark || '',
      // 假期调休：这一天的课已经被借到别的日子上了 —— 看板行要变灰 + 标「已调休」
      rescheduled: !!c.rescheduled,
      // 这段文案收进 `courseWhenText()`（与日历当天列表共用一份，见它的说明）——
      // 别在这里再拼一遍，两处各拼一份就是那条「两处时间不一样」。
      meta: courseWhenText({
        date: c.date,
        start: st,
        end: et,
        periodStart: c.period_start,
        periodEnd: c.period_end,
        room: c.room,
        adjusted: c.adjusted,
        rescheduled: c.rescheduled,
        preShifted: !!(shifted && shifted.shifted),
      }),
      // 课表 2 期：起止时刻与格内**逐节**明细原样带上 ——
      // 看板两端的倒计时 / 课间 / is-done 都喂给 `core/timetable.js` 的 `ttTodayNow()`（判定只有那一份）。
      // `spans` 缺了（老响应 / 无作息）时判定会安静地退化为「不算小课间」，不会报错。
      start_time: st,
      end_time: et,
      spans: shifted ? shifted.spans : c.spans || [],
      // 这一条的时间**确实被提前过** ⇒ 两端可据此标注「已提前」（与 `rescheduled`
      // 同款：给人留一个「看得出它和平时不一样」的钩子，而不是让时间默默变了）
      pre_shifted: !!(shifted && shifted.shifted),
    });
  });
  (d.hardware && d.hardware.items ? d.hardware.items : []).forEach((h) => {
    const bits = [];
    if (h.warranty === 'over') bits.push('保修已过期');
    else if (h.warranty === 'soon') bits.push('保修临近');
    if (h.level === 'over') bits.push('已超期');
    else if (h.level === 'soon') bits.push('临近更换');
    out.push({
      kind: 'hardware',
      key: `h${h.id}`,
      title: h.name,
      name: '数码管理',
      color: '#f59e0b',
      icon: '🧩',
      date: h.due || '',
      meta: bits.join(' · ') || '该看一眼',
    });
  });
  out.sort(
    (a, b) =>
      // 没日期的排最后（空串在字典序里最小，所以单独判一次）
      (a.date ? 0 : 1) - (b.date ? 0 : 1) ||
      String(a.date).localeCompare(String(b.date)) ||
      (a.period || 0) - (b.period || 0) ||
      String(a.key).localeCompare(String(b.key)),
  );
  return out;
}

/**
 * 功能：由事项列表算出概览的五个数 —— 待办 / 课程 / 硬件要关注 / 已逾期 / 已完成，外加完成度。
 *
 * 说明：⭐ 五个数**由 `DASH_FILTERS` 的 `match` 逐条判出来**（不是一个一个手写的分支）——
 * 「概览写着 3 条，点进去只剩 2 条」这种谁都不会报错的不一致。
 *
 */
export function dashStats(entries) {
  const tasks = entries.filter((x) => x.kind === 'task');
  const done = tasks.filter((x) => x.done).length;
  const daily = tasks.filter((x) => x.source === 'daily').length;
  /** 功能：按 `DASH_FILTERS` 里某一项的判据数一数有几条。 @param {string} key - 筛选项 key @returns {number} 条数 */
  const count = (key) => {
    const f = DASH_FILTERS.find((x) => x.key === key);
    return f ? entries.filter(f.match).length : 0;
  };
  return {
    total: tasks.length,
    todo: count('todo'),
    done: count('done'),
    overdue: count('overdue'),
    course: count('course'),
    hardware: count('hardware'),
    progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    daily,
    project: tasks.length - daily,
  };
}

/**
 * 功能：按概览上被点中的那一类筛出条目 —— 「点击任务概览能筛选显示」。
 *
 * 说明：⚠️ 判据**只认 `DASH_FILTERS`**（见 `dashStats()` 的说明）；传空 / 未知值一律返回原样
 *
 * @param {Array.<Object>} entries - `dashEntries()` 的结果
 */
export function dashFilter(entries, filter) {
  if (!filter) return entries;
  const f = DASH_FILTERS.find((x) => x.key === filter);
  if (!f) return entries;
  return entries.filter(f.match);
}

/**
 * 功能：按关键词筛条目 —— 「增加一个搜索图标（放大镜），点击出现输入框，输入搜索」。
 *
 * 说明：⭐ **纯前端**：只在「这一份已经取回来的条目」上做字符串匹配，⛔ **不重新取数**
 * 网络不好的时候还会把已经拿到的数据又丢了（与 `dashFilter` 同一条口径）。
 * 匹配范围 = 「用户在屏幕上看得见的那几样」：标题 / 两条备注（本节与课程）/ 归属。
 */
export function dashSearch(entries, q) {
  const needle = String(q == null ? '' : q)
    .trim()
    .toLowerCase();
  if (!needle) return entries;
  return entries.filter((x) =>
    [x.title, x.remark, x.course_remark, x.name]
      .map((v) => String(v == null ? '' : v).toLowerCase())
      .some((v) => v.indexOf(needle) >= 0),
  );
}

/**
 * 功能：把服务端给的一串「模块简要」折成「其它」那一块上**一张卡要说的话**。
 *
 * 一条一句简要、点一条进对应的模块。
 * 文案与判据**只写这一处**（两端共用）：电脑版与手机版各画各的版式
 * ，但「课表那条写什么」只能有一份 —— 各写一遍必然漂移成
 */
export function dashBrief(name, v) {
  if (!v || typeof v !== 'object') return null;
  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const card = (n, text, warn) => ({ n: num(n) || null, text, warn: !!warn });
  switch (name) {
    case 'time': {
      // 课表 / 番茄钟 / 行程并成一个模块 ⇒「其它」里
      // **一张卡**。⚠️ 各分项由服务端**按子开关**给：关掉课表就没有 `courses`（那句改说番茄），
      // 关掉番茄钟就没有 `today_count`；三块全关时服务端**不给 `briefs.time`**（`v` 为
      const hasTt = v.courses !== undefined;
      const hasPomo = v.today_count !== undefined;
      const c = num(v.courses);
      const p = num(v.today_count);
      const bits = [];
      if (hasTt) bits.push(c ? `本学期 ${c} 门课` : '这学期还没有课程');
      if (hasPomo) bits.push(p ? `今天 ${p} 个番茄` : '今天还没开始');
      if (!bits.length) return null;
      return card(hasTt ? c : p, bits.join(' · '));
    }
    case 'bookmarks': {
      const c = num(v.total);
      return card(c, c ? `${c} 个收藏 · ${num(v.tags)} 个分类` : '还没有收藏');
    }
    case 'idea': {
      const c = num(v.total);
      // 「收件箱」改叫「未归档」之后，「N 条**在**未归档」读着别扭（那是原文案的介词留下的）
      // ⇒ 去掉那个「在」。
      return card(c, c ? `${c} 条 · ${num(v.inbox)} 条未归档` : '还没有记过一条');
    }
    // 这一格是**模块名** `digital`（原 `hardware`）—— 本 `switch` 的
    // 每个 `case` 都是「模块名」（与 `briefs` 的键、`app/modules/<目录名>` 同一套）。
    // 卡片右边那个大数仍然只报「台账里有几件」——与模块叫什么无关。
    case 'digital': {
      const c = num(v.total);
      const alert = num(v.alert);
      return card(c, c ? `${c} 件 · ${alert} 件需关注` : '台账还是空的', alert > 0);
    }
    case 'calendar': {
      // 这张卡**建议保留**（它给的是「本月 N 个事件」这个一眼数字，不是入口），
      // 但口径要写死一句：**它现在不是门，门是胶囊** ——
      // 「日历视图」进不进得去由看板顶部那条胶囊说了算，与这张卡在不在**无关**。
      const c = num(v.month_count);
      return card(c, c ? `本月 ${c} 个事件` : '本月还没有事件');
    }
    case 'ledger': {
      const c = num(v.accounts);
      return card(c, c ? `${c} 个账户` : '还没有账户');
    }
    case 'vault': {
      // 这里**没有**「条目数量」—— 服务端刻意不给（那是「你存了几个账号」的侧信道）
      if (!v.initialized) return card(0, '还没设置主密码');
      return card(0, v.unlocked ? '已解锁' : '已锁定');
    }
    case 'teamwork': {
      const unread = num(v.unread);
      const req = num(v.requests);
      const text = `${num(v.conversations)} 个会话${req ? ` · ${req} 条好友申请` : ''}`;
      return card(unread, text, unread > 0);
    }
    case 'ai': {
      if (!v.configured) return card(0, '还没配置模型');
      return card(0, v.enabled ? '已开启' : '模型已配置 · 未开启');
    }
    default:
      return null;
  }
}

/**
 * 功能：看板顶部那条胶囊里**该列哪几个模块视图** —— 「清单 ∩ 本端接线表」里声明了 `dashView` 的那些。
 *
 * 清单还没到手（`state.modules === null`）时 `items` 是空数组 ⇒ 回空数组 ⇒
 * **整条胶囊不画**（什么都不判，而不是当成「都没有」）。
 * 用「胶囊项」而不是「`slots` 里有没有 `dash-view`」做判据：标签是**界面文案**，
 */
export function dashViewDefs(items) {
  return (items || []).filter((it) => it.dashView && it.dashView.label);
}

/**
 * 功能：这个账号**进首页看板时默认停在哪个模块视图** —— 空串表示「列表视图」。
 *
 * 本函数只回答「要不要一进来就切到某个模块贡献的视图」。
 * 判据是「哪个模块的简要里 `open_by_default` 为真」，⛔ **不写死模块名** ——
 * 日历模块被整目录删掉之后，它的简要键根本不出现 ⇒ 自然回空串。
 */
export function dashDefaultViewName(items, data) {
  const briefs = (data && data.briefs) || {};
  for (const it of dashViewDefs(items)) {
    const b = briefs[it.name];
    if (b && b.open_by_default) return it.name;
  }
  return '';
}

/**
 * 任务分级：**顺序就是界面上从上到下的顺序**，而且「哪些分级存在」也由它说了算 ——
 * 某一级没有条目时 `dashTaskTiers()` 直接不返回它（「没有则不显示」）。
 */
export const DASH_TIERS = [
  { key: 'overdue', label: '已逾期' },
  { key: 'today', label: '今日截止' },
  { key: 'week', label: '本周截止' },
  { key: 'month', label: '本月截止' },
  { key: 'later', label: '更晚' },
  { key: 'done', label: '已完成' },
];

/**
 * 功能：判一条事项落在哪一级 —— 基准是**今天**，不是当前所选区间
 * （选的「相对今天 + 区间仍起作用」）。
 *
 * 说明：① **逾期优先用 `x.overdue` 这个标志，不在这里重算一遍日期** ——
 * 概览那颗数（`DASH_FILTERS.overdue` / `dashStats()`）用的就是它，
 */
export function dashTierOf(x, today) {
  if (x.overdue) return 'overdue';
  if (x.done) return 'done';
  const t = today || todayStr();
  const d = x.date;
  if (!d) return 'later';
  if (d === t) return 'today';
  if (d <= addDays(mondayOf(t), 6)) return 'week';
  if (d <= monthEnd(t)) return 'month';
  return 'later';
}

/**
 * 功能：把**任务**分级 —— 已逾期 / 今日截止 / 本周截止 / 本月截止（＋兜底两级），
 * 返回时**只保留有条目的分级**。
 *
 * 说明：⭐ 「任务再分级一下，目前是已逾期、正常任务。现在从上到下显示：
 * 已逾期、今日截止、本周截止、本月截止，没有则不显示」。
 */
export function dashTaskTiers(tasks, today) {
  const t = today || todayStr();
  const buckets = new Map();
  (tasks || []).forEach((x) => {
    const k = dashTierOf(x, t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(x);
  });
  // **每一级内部**再按四象限排（「紧急且重要 → 紧急 → 重要 → 都不」）。
  // 分级说的是「这件事离我多近才该做」，四象限说的是「这件事多要紧」—— 两个维度不冲突，
  // 所以分级**原样保留**、只在级内重排（不是把分级换成四象限，别改错了）。
  buckets.forEach((list, key) => {
    if (key === 'done') return;
    list.sort((a, b) => quadRank(b) - quadRank(a));
  });
  return DASH_TIERS.filter((g) => buckets.has(g.key)).map((g) => ({
    key: g.key,
    label: g.label,
    items: buckets.get(g.key),
  }));
}

/**
 * 功能：把条目按「星期 x」（本周）或「自然周」（本月）分段 ——
 * 「本周：应该按星期 x 显示；本月：应该按自然周展示（区间日期筛选就保持现状）」。
 *
 * 说明：⚠️ 只有这两档分段，**其余档位（今日 / 单日 / 自定义区间）一律返回单段** ——
 * 单日只有一天、自定义区间的长度由用户自己定，硬分段只会把「一天的事」拆成七块。
 */
export function dashGroups(entries, preset) {
  if (!entries.length) return [];
  if (preset !== 'week' && preset !== 'month') {
    return [{ key: 'all', label: '', items: entries }];
  }
  const out = [];
  const buckets = new Map();
  const other = [];
  entries.forEach((x) => {
    if (!x.date) {
      other.push(x);
      return;
    }
    // 本周 → 一天一段（标签就是「周一 9/14」）；本月 → 一周一段（周一起算的自然周）
    const mon = preset === 'week' ? x.date : mondayOf(x.date);
    if (!buckets.has(mon)) buckets.set(mon, []);
    buckets.get(mon).push(x);
  });
  const keys = [...buckets.keys()].sort();
  keys.forEach((k, i) => {
    out.push({
      key: k,
      label:
        preset === 'week'
          ? `${weekName(k)} ${fmtShort(k)}`
          : `第 ${i + 1} 周 · ${fmtShort(k)}–${fmtShort(addDays(k, 6))}`,
      items: buckets.get(k),
    });
  });
  // 「其它」永远在最后：它装的是没有日期的硬件，插在中间会被读成「那天该看它」
  if (other.length) out.push({ key: 'nodate', label: '没填日期', items: other });
  return out;
}

/**
 * 功能：某条事项落在星期几（1=周一 … 7=周日），供两端在窄栏位上画星期标记。
 * @param {Object} x - `dashEntries()` 的一条
 * @returns {number} 1~7；没有日期时为 0
 */
export function weekdayNo(x) {
  if (!x || !x.date) return 0;
  return (dow(x.date) + 6) % 7 + 1;
}
