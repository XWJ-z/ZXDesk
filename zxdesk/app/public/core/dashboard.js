/**
 * core/dashboard.js —— 首页看板的共用语义（两端唯一一份，0.5.2 大改）
 *
 * 功能：`DASH_PRESETS` 是区间档位（今日 / 单日 / 本周 / 本月），`dashRange()` 把一档折成闭区间，
 *      `dashEntries()` 把 `GET /api/dashboard` 的响应折成「一条一条具体事项」
 *      （任务 + 课程 + 硬件关注混在一列），`dashStats()` 再由它算出概览的五个数；
 *      ⭐ 0.5.2 另加三个：
 *      · `dashFilter()` —— 点概览上那五个数，把列表筛成其中一类（要的「点击筛选」）；
 *      · `dashGroups()` —— 本周按星期 x、本月按自然周把列表分段（区间筛选保持一整列，也是）；
 *      · `DASH_FILTERS` —— 概览那五个数的**顺序与口径**（顺序是专定的：
 *        待办 / 课程 / 硬件要关注 / 已逾期 / 已完成）。
 *      ⭐ 0.5.5 再加五个：
 *      · `dashRangeLabel()` —— 当前区间说成一句话（新区间条顶部那行与旧的说明行**共用一份**）；
 *      · `dashWeekCells()` —— 某天所在那一周的 7 个格子（区间条下面那条「一周」）；
 *      · ⭐ `dashTaskTiers()` —— **任务分级**（「任务再分级一下……
 *        从上到下显示：已逾期、今日截止、本周截止、本月截止，没有则不显示」），
 *        顺序与口径由 `DASH_TIERS` 一处说了算；空的分级不返回（所以「没有则不显示」是自动的）；
 *      · 任务条目多挂一份**完整任务对象** `x.task` —— 看板上要能就地改任务
 *        （点一条 → 弹详情 → 编辑 / 完成 / 删除），而详情弹窗与编辑表单都要整条任务；
 *      · `dashGroups()` 只留给**课程与硬件**（它俩没有「截止」这个概念，按日期分段就好），
 *        原来插在它前面的那个「已逾期」段**已挪进 `dashTaskTiers()`**。
 *      ⭐ 0.8.7 再加两个：
 *      · `dashViewDefs()` —— 看板顶部那条胶囊该列哪几项（接线表声明了 `dashView` 的模块）；
 *      · `dashDefaultViewName()` —— 这个账号进屏默认停在哪个模块视图（服务端 `briefs` 里的布尔）。
 *
 * ⭐ **为什么任务分级与课程/硬件分段是两件事**：分级说的是「这件事离我多近才该做」
 *   （逾期 / 今天 / 本周 / 本月），只有任务有这层紧迫度；一节课没有「逾期」，一件硬件也没有。
 *   把课程塞进同一套分级里，只会得到「本周截止的一节课」这种说不通的说法。
 *
 * ⭐ 为什么抽到 `core/`：**两端要一模一样的是「哪条算落在区间里」，不是长相**。
 *   而这条判据有个绕不过去的细节 —— 「已完成的任务止于完成日」（`core/task.js` 的 `visEnd()`），
 *   服务端只做宽口径预筛、判据在前端。两端各写一遍的结果是「手机上看得到、电脑上看不到」，
 *   而且**不报任何错** —— 与 `doneInfo` / `weekEnd` 当初被收进 `core/task.js` 是同一条理由。
 *
 * ⭐ 0.5.2 修的那个 bug：「今日的任务概览里『已逾期』始终是 0」。
 *   原因：逾期任务（截止日 < 今天）的可见止就是它的截止日，而截止日比「今日」区间的起点还早，
 *   于是被「区间与 [起始日, 可见止] 有交集」这条判据**整条滤掉** —— 概览里当然永远是 0。
 *   ⚠️ 正确的语义是「**欠的账在任何区间里都算数**」：未完成且已过期的任务**不受区间下界限制**，
 *   做完为止。所以这里的判据改成了 `逾期未完成 → 无条件纳入`（见 `dashEntries()` 里的注释）。
 *   ⚠️⭐ **0.5.5 补记：这个 bug 当时只修了一半。** 这里放开之后仍然看不到逾期任务 ——
 *   因为**服务端的宽口径预筛**（`core/store/methods/stats.js` 的 `dashboard()`）用的是
 *   同一条「与区间有交集」的判据，逾期行在**到达浏览器之前**就被滤掉了，前端这条判据是空转。
 *   ⇒ 两边必须同口径放行（服务端那侧见 `push()` 里的 `openOverdue`）。
 *   ⭐ 教训：动了「哪条算落在区间里」的语义，**预筛那一侧必须一起检查** ——
 *   否则「判据改对了、数据没到手」，而且不报任何错。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.54
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { addDays, dow, fmtLong, fmtShort, mondayOf, todayStr, weekName } from './date.js';
import { parseRule, periodsBetween } from './recur.js';
import { quadRank, visEnd } from './task.js';
// ⭐ 0.8.54：「周期结束了就算这一轮做完」这条判据只有 `recur.js` 一处（`cycleState()`）——
//    ⛔ 别在这里写 `task_kind === 'cycle' && due_date <= today` 的第二份（改一处忘另一处就会
//    「看板说未完成、任务板说已完成」）。⚠️ `parseRule` / `periodsBetween` 上面那行已经导入了，
//    这里只补 `cycleState`（重复导入同一个名字是**解析错误**，整页白屏）。
import { cycleState } from './recur.js';
import { ttShiftTimes } from './timetable.js';

/**
 * ⭐ 区间档位：按钮上的字与顺序就是这里的顺序，两端共用（改一处要改两处 → 所以只留一处）。
 *
 * 说明：0.5.2 加了 `day`（**单日**）—— 「除了目前的范围日期筛选，
 *      还应该有单日筛选功能，即查看任意一天的任务」。
 *      ⚠️ 它与 `today` 的区别：`today` 永远跟着「今天」走；`day` 是**用户挑的那一天**
 *      （区间同样是 from = to，但那是用户选的，不随跨天漂移）。
 */
export const DASH_PRESETS = [
  { key: 'today', label: '今日' },
  { key: 'day', label: '单日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

/**
 * ⭐ 概览那五个数 —— **顺序就是界面上从左到右的顺序**（
 * 「任务概览：从左往右依次为：待办、课程、硬件要关注、已逾期、已完成」）。
 *
 * 说明：`key` 同时是 `dashFilter()` 的筛选项 —— 「点一个数就筛出这一类」这条要求
 *      决定了它们必须是同一份清单，否则界面上会出现「第五个数点了没反应」这种事故。
 *      ⚠️ `match` 只判一条 entry 属不属于这一类，**不要**在里面写日期区间判据（那是 `dashEntries` 的事）。
 *
 * @type {Array.<{key: string, label: string, match: Function}>}
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
 *      结果立刻回写成 `YYYY-MM-DD` 字符串，不把 `Date` 带出本函数（本项目一贯的时区纪律）。
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
 *      本周＝周一~周日；本月＝1 号~月末。
 * 说明：`custom`（用户手改日期）不在这里，它的区间由调用方直接给出。
 * @param {string} preset - `today` / `day` / `week` / `month`
 * @param {string} [base] - 基准日（「单日」那一档就是用户挑的那天），缺省为今天
 * @returns {{from: string, to: string}} 闭区间两端
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
 * 说明：⭐ 0.5.5 收进 `core/`：区间条**顶部那一行**与旧的说明行都由它出。两处各写一遍的后果是
 *      「顶部写着 9/14 ~ 9/20、下面写着 9/15」这种自相矛盾，而且**不报任何错**。
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
 * 说明：⭐ 0.5.5 新增（「合并今日、单日、本周菜单，改为如图所示」）。
 *      两端共用这一份 —— 各写一遍的后果是「电脑版第一格是周一、手机版第一格是周日」，
 *      两边各自看着都对、凑一起才发现不是同一个产品。
 * @param {string} [base] - 这一周里的任意一天 `YYYY-MM-DD`；缺省今天
 * @returns {Array.<{date: string, weekday: string, day: string, today: boolean}>} 7 个格子；
 *     `weekday` 是单个汉字（一~日），`day` 是 `M/D` 短格式，`today` 表示这一格是不是今天
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
 *      （看板列表视图的课程行 `meta` ＋ 日历当天列表里的课程条）。
 *
 * 说明：⭐ 0.8.9（「这个时间和列表视图的不一样，要和列表视图一模一样」）：
 *      日历那一侧原来**自己拼**了一句短的（只有 `起–止 · 教室`），同一个应用里同一条课
 *      在两处写法不同 —— 典型的「两端/两处各写一份，迟早对不上」。
 *      ⇒ 收成一份，日历那边改成调这里（字段名不同，由调用方适配）。
 *
 * ⚠️ 形参是**规范化**后的形状（不是库里那一行、也不是图层的投影）——
 *    看板那边直接由 `d.courses` 的字段喂进来，日历那边由 `calendarLayer` 的投影喂进来。
 * ⚠️ 这段文案里有两个**非 ASCII 连接号**（`–` U+2013）—— 与列表视图逐字一致才叫「一模一样」，
 *    ⛔ 别顺手改成连字符，否则两边又开始漂。
 *
 * @param {Object} c - `{ date, start, end, periodStart, periodEnd, room, adjusted, rescheduled, preShifted }`
 * @returns {string} 一句话，形如 `9/30 周三 第 1–2 节 08:30–11:55 · 十教106室`
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
 *      看板回答的是「这段时间我要干什么」，而「今天上什么课」「哪块盘该换了」与任务是同一个层级的问题。
 *      ⚠️ 任务的可区间性走 `doneInfo()` / `visEnd()`（见文件头与函数内那一处），
 *      课程与硬件只按各自日期落在区间内判定。
 *      ⚠️ 没日期的（少数硬件连保修日都没填）排在最后，不给它们编一个日期。
 *
 *      ⭐ 0.5.2 两条改动：
 *      ① **逾期未完成的任务无条件纳入** —— 见文件头那条 bug：「欠的账在任何区间里都算数」。
 *        只放开这一条，其余区间判据一字未动（已完成的仍然止于完成日）。
 *      ② 课程条目带上 `remark`（课次备注优先、课程备注兜底）—— 要它「加粗标红」地显示在条目上。
 *
 *      ⭐ 0.5.5：`kind === 'task'` 的条目多带一个 `task` —— **整条任务对象**
 *      （字段名与库里一致 + `_scope`），供看板「就地改任务」时交给任务板模块
 *      （`openTaskDetail()` / `openTask()`）。见 `push` 处那段说明。
 *
 * @param {Object} d - `GET /api/dashboard` 的响应
 * @returns {Array.<Object>} 事项数组，按日期升序；同类同日按节次 / id 稳定排序
 */
export function dashEntries(d) {
  const out = [];
  if (!d) return out;
  const today = todayStr();
  (d.tasks && d.tasks.items ? d.tasks.items : []).forEach((t) => {
    const s = t.start_date || t.due_date;
    // ⭐ 0.8.9 修订（「逾期任务点了完成不知道去哪里了，应该放到已完成里」）：
    //    **已完成的任务，可见止取「完成日」**（`doneInfo()`）：提前完成 = 完成日；逾期补做 = 补做那一天。
    //    ⚠️ 从前一律走 `visEnd()`（它只在「完成日落在 [起始日, 截止日) 之内」才截断）⇒ 一条
    //    9/20 到期、10/2 才补做的任务可见止仍是 9/20，与「今天」这个区间没有交集 ⇒ 被下面
    //    `inRange` 丢掉：「已完成」那一级**永远收不到逾期补做的任务**（而它本该在那儿）。
    //    ⚠️ 服务端的宽口径预筛是同一口径（`core/store/methods/stats.js` 的 `push()`），
    //    两处必须一起改 —— 只改这里的话那一行**根本到不了浏览器**。
    // ⭐⭐ 0.8.14：可见止改由 `visEnd(t, s, today)` 一次算清（三段式）——
    //    它已涵盖 0.8.9 那条「已完成止于完成日」的口径，**并且**新增了「逾期未完成顺延到今天」。
    //    ⚠️ `today` 必须传进去，否则「顺延」这条在首页看板上不生效（而且不报错）。
    const e = visEnd(t, s, today);
    // ⭐⭐ 0.8.14：**周期任务按期算可见性** —— 「这一天该做的那一期」，而不是「整个周期里天天都有」。
    //    ⚠️ 它同时决定了这条 entry 的 `date`（本期截止日），界面据此排序与显示。
    const cyc = !!(t.task_kind === 'cycle' && parseRule(t.recur_rule));
    const periods = cyc ? periodsBetween(t, d.from, d.to) : [];
    const cur = periods.length ? periods[periods.length - 1] : null;
    // ⭐ 精确判据：区间与 [起始日, 可见止] 有交集 —— 已完成的任务可见止就是完成日
    const inRange = cyc ? !cur : !s || !e || s > d.to || e < d.from;
    // ⭐ 0.5.2：逾期未完成的**不受下界限制**（欠的账在任何区间里都算数，做完为止）
    // ⚠️ 0.8.14：周期任务**不进这条**（它的账按「每一期」各算，要打卡记录才算得准）——
    //    而且它的 `due_date` 一过就等于「这一轮做完了」，在这里判逾期会得出反的结论。
    const overdue = !cyc && t.status !== 'done' && !!t.due_date && t.due_date < today;
    if (inRange && !overdue) return;
    // ⭐⭐ 0.8.54（「周期任务的完成判定不对，当所有打卡都完成了还是逾期没有完成的状态」）：
    //    完成判定**不再只看 `status`** —— 周期任务到了整个周期的结束日就算这一轮做完了
    //    （0.8.14 定下的语义，判据在 `core/recur.js` 的 `cycleState()`）。
    //    ⚠️⭐ 从前这里写的是 `t.status === 'done'`，而周期任务**永远不会**被写成 `status='done'`
    //    （它的勾选是「打卡本期」，不碰任务行）⇒ 一条打完卡的周期任务在结束之后仍然是
    //    「未完成」，同时被上面那条 `overdue` 判成逾期 —— 看到的就是这个。
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
      // ⭐ 0.8.14：周期任务的日期取**本期**的截止日（见下面那处 `date` 的说明）。
      date: cur ? cur.end : t.due_date,
      overdue,
      done,
      // ⭐ 0.7.2：重要 / 紧急提到**条目顶层**（「看不到任务的紧急和重要」）——
      //    从前它们只住在下面 `task` 那个嵌套对象里（那是给「就地改任务」回填表单用的），
      //    而看板行读的是顶层 ⇒ 一枚标记都画不出来。
      //    ⚠️ 这两项同时喂给 `quadRank()`（`dashTaskTiers()` 的级内排序），别只当渲染字段用。
      important: t.important ? 1 : 0,
      urgent: t.urgent ? 1 : 0,
      // ⭐ 0.5.2 跨模块：任务上绑的网址（四象限详情与首页条目都靠它显示「网址标题」且可点）
      bookmark: t.bookmark || null,
      meta: cyc && cur
        ? `本期 ${fmtShort(cur.start)}${cur.end !== cur.start ? '–' + fmtShort(cur.end) : ''}`
        : `${done ? '已完成' : '截止'} ${fmtShort(t.due_date) || '未定'}`,
      // ⭐ 0.5.5：一条**完整的任务对象** —— 看板点一条任务要就地弹详情（里头能编辑 / 完成 / 删除），
      //    而详情弹窗与编辑表单读的都是整条任务（`openTaskDetail()` / `openTask()`）。
      //    ⚠️ 字段名必须与库里一致（那两处会拿它直接回填表单与拼 PUT 请求体）。
      //    ⚠️ `_scope` 是 `taskScope()` 认的那个键：项目任务**必须**带上它 ——
      //    否则编辑时会回落到「当前作用域」（`state.scope`），
      //    表现是「在看板上改一条项目任务，结果改到了另一个项目里」且不报错。
      //    ⚠️ `_scope` 与 `bookmark` 都不是库里的列，写库时会被白名单丢掉（见 `_update()`），
      //    所以放心挂着 —— 但**别指望它们能存下去**。
      task: {
        id: t.id,
        status: t.status,
        title: t.title,
        start_date: t.start_date || '',
        due_date: t.due_date || '',
        completed_at: t.completed_at || '',
        important: t.important ? 1 : 0,
        urgent: t.urgent ? 1 : 0,
        // ⚠️ 这三项就是服务端 0.5.5 补上的那几个：缺了它们，编辑表单会拿空值覆盖回库里
        assignee: t.assignee || '',
        tag: t.tag || '',
        description: t.description || '',
        content: t.content || '',
        bookmark_id: t.bookmark_id ? Number(t.bookmark_id) : 0,
        bookmark: t.bookmark || null,
        // ⭐⭐ 0.8.14：任务类型这一维度的四个字段**必须一起带上** ——
        //    看板的编辑表单会拿这个对象**直接回填并拼 PUT 请求体**，缺了它们就是
        //    「在首页改一下标题，这条窗口 / 周期任务当场变回普通任务」而且不报错。
        task_kind: t.task_kind || 'plain',
        start_time: t.start_time || '',
        due_time: t.due_time || '',
        recur_rule: t.recur_rule || '',
        _scope: t.source,
      },
    });
  });
  // ⭐ 0.7.2：「假前一天下午提前」—— 这一天下午的节次整体前移 N 分钟。
  //    ⚠️ 分工钉死：「这一天是不是假前一天」由**服务端**给（`c.pre_holiday`），提前量与
  //    「几点算下午」也由服务端下发（`d.holiday`）；这里**只做应用**，
  //    ⛔ 不许自己推假日口径（`routes.js` 那条「假日口径只在服务端算一份」的纪律）。
  //    ⚠️ 必须**逐条**判 `c.pre_holiday`，不能判「整个区间是不是假前一天」——
  //    看板可能列一整周，而一周里往往只有一天是（周五 / 长假前最后一个上课日）。
  const hp = d.holiday || {};
  (d.courses || []).forEach((c) => {
    const shifted =
      c.pre_holiday && hp.enabled ? ttShiftTimes(c, hp.advance_minutes, hp.pm_from) : null;
    // 偏移后的起止（没偏移就是原值）—— 下面 `meta` 的文字与三个时间字段**共用这两个**：
    // ⚠️ 各算一份就会「行里文字写着 13:30、倒计时按 13:00 走」，而且不报任何错。
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
      // ⭐ 0.7.1：两条备注口径分开，**都带**（后端 `courseItems()` 已按「看板上那一天」查好）——
      //    `remark` = **本节备注**（这一天这一节，`timetable_day_notes`）；`course_remark` = 课程备注。
      //    ⚠️ 从前 `remark` 装的是**课次备注**（挂课次 = 按周重复）⇒ 看板上这门课每天都顶同一句。
      //    配色区分见两端的 `.dash-remark` 那一段。
      remark: c.remark || '',
      course_remark: c.course_remark || '',
      // ⭐ 0.6.2 假期调休：这一天的课已经被借到别的日子上了 —— 看板行要变灰 + 标「已调休」
      rescheduled: !!c.rescheduled,
      // ⭐ 0.8.9：这段文案收进 `courseWhenText()`（与日历当天列表共用一份，见它的说明）——
      //    ⛔ 别在这里再拼一遍，两处各拼一份就是那条「两处时间不一样」。
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
      // ⭐ 课表 2 期：起止时刻与格内**逐节**明细原样带上 ——
      //    看板两端的倒计时 / 课间 / is-done 都喂给 `core/timetable.js` 的 `ttTodayNow()`（判定只有那一份）。
      //    ⚠️ `spans` 缺了（老响应 / 无作息）时判定会安静地退化为「不算小课间」，不会报错。
      start_time: st,
      end_time: et,
      spans: shifted ? shifted.spans : c.spans || [],
      // ⭐ 0.7.2：这一条的时间**确实被提前过** ⇒ 两端可据此标注「已提前」（与 `rescheduled`
      //    同款：给人留一个「看得出它和平时不一样」的钩子，而不是让时间默默变了）
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
 *      界面上的顺序、筛选结果、以及这里报的数必须是同一份判据，否则会出现
 *      「概览写着 3 条，点进去只剩 2 条」这种谁都不会报错的不一致。
 *
 * @param {Array.<Object>} entries - `dashEntries()` 的结果
 * @returns {{todo: number, done: number, overdue: number, course: number, hardware: number,
 *     total: number, progress: number, daily: number, project: number}} 概览数字
 *     ⭐ 五个概览键与 `DASH_FILTERS` 的 `key` **逐字同名**（`course` 不是 `courses`）——
 *     两端的概览卡都按 `st[f.key]` 渲染，键名对不上就画出「undefined」（0.5.2 真踩过一次）。
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
 *      （不筛选），因为「筛不出来」比「什么都显示」更容易被当成数据丢了。
 *
 * @param {Array.<Object>} entries - `dashEntries()` 的结果
 * @param {string} filter - `DASH_FILTERS` 里的某个 `key`；空串 / null 表示不筛选
 * @returns {Array.<Object>} 筛选后的条目数组（不改动入参）
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
 *      —— 筛选是同一份数据上的事，重新取一次只会让界面闪一下，
 *      网络不好的时候还会把已经拿到的数据又丢了（与 `dashFilter` 同一条口径）。
 *      匹配范围 = 「用户在屏幕上看得见的那几样」：标题 / 两条备注（本节与课程）/ 归属。
 *      ⚠️ 大小写不敏感（英文标题）；空串 / 全空格一律原样返回（= 不筛）。
 *      ⚠️ 判据**只写这一处**（两端共用）—— 两端各写一遍必然漂移成
 *      「电脑端搜得到、手机端搜不到」，而且**不报任何错**。
 *
 * @param {Array.<Object>} entries - `dashEntries()` 的结果
 * @param {string} q - 关键词；空串 / 全空格表示不筛
 * @returns {Array.<Object>} 筛选后的条目数组（不改动入参）
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
 * 说明：⭐ 0.8.5：「其它」原来只有网址收藏夹与未读消息，现在要把各个模块都列出来，
 *      一条一句简要、点一条进对应的模块。
 *      ⚠️⭐ 文案与判据**只写这一处**（两端共用）：电脑版与手机版各画各的版式
 *      ，但「课表那条写什么」只能有一份 —— 各写一遍必然漂移成
 *      「电脑版说 8 门课、手机版说 8 节课」。
 *      ⚠️ 服务端只给数字与布尔（`dashboard().briefs`），一句人话在这儿拼：
 *      放在服务端就等于把界面措辞搬进库，改一次要动三处。
 *      ⚠️ **图标 / 名字 / 顺序不在这儿**：它们来自两端的接线表（`modules.js`）——
 *      本函数只回答「说什么」，不回答「叫什么、长什么样、排第几」。
 *      ⚠️ `n`（卡片右边那个大数）**只在为正时才给**（否则 `null`）：0 已经在文案里说过了
 *      （「台账还是空的」），再挂一个 `0` 只是噪音；这条规矩写在**这里**，
 *      ⛔ 别让两端各判一次 `n > 0`。
 *
 * @param {string} name - 模块名（= `app/modules/` 下的目录名）
 * @param {?Object} v - `dashboard().briefs[name]`；这个键不在 = 模块关着 / 已删
 * @returns {?{n: ?number, text: string, warn: boolean}} 折好的卡（`n` 为卡片上的大数，
 *     `warn` 为「有事要处理」的强调态）；模块没数据时为 null（调用方据此**不画这张卡**）
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
      // ⭐ 0.8.13：课表 / 番茄钟 / 行程并成一个模块 ⇒「其它」里
      //    **一张卡**。⚠️ 各分项由服务端**按子开关**给：关掉课表就没有 `courses`（那句改说番茄），
      //    关掉番茄钟就没有 `today_count`；三块全关时服务端**不给 `briefs.time`**（`v` 为
      //    `undefined` ⇒ 上面那行 `!v` 早退 ⇒ 这张卡不画）。
      //    ⚠️ 卡片右边那个大数：有课表分项时报**课数**（与合并前那张课表卡一致），
      //    只有番茄分项时报今日番茄数 —— ⛔ 不把两个数相加（那两个「件」不是同一种东西）。
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
      // ⚠️ 0.8.14：「收件箱」改叫「未归档」之后，「N 条**在**未归档」读着别扭（那是原文案的介词留下的）
      //    ⇒ 去掉那个「在」。
      return card(c, c ? `${c} 条 · ${num(v.inbox)} 条未归档` : '还没有记过一条');
    }
    // ⚠️⭐ 0.8.10：这一格是**模块名** `digital`（原 `hardware`）—— 本 `switch` 的
    //      每个 `case` 都是「模块名」（与 `briefs` 的键、`app/modules/<目录名>` 同一套）。
    //      留 `case 'hardware'` 的后果是 `default: return null` ⇒ **两端「其它」里那张卡凭空
    //      消失**，而且不报错（改名时漏改这一处，0.8.10踩过）。
    //      ⚠️ 卡片右边那个大数仍然只报「台账里有几件」——与模块叫什么无关。
    case 'digital': {
      const c = num(v.total);
      const alert = num(v.alert);
      return card(c, c ? `${c} 件 · ${alert} 件需关注` : '台账还是空的', alert > 0);
    }
    case 'calendar': {
      // ⭐ 0.8.7：这张卡**建议保留**（它给的是「本月 N 个事件」这个一眼数字，不是入口），
      //    但口径要写死一句：**它现在不是门，门是胶囊** ——
      //    「日历视图」进不进得去由看板顶部那条胶囊说了算，与这张卡在不在**无关**。
      //    ⚠️ 两者的显隐判据必须一致（都用 `usable(…, true, 'listCalendarEvents')` 那一扇门），
      //    有配对账用例钉住。
      const c = num(v.month_count);
      return card(c, c ? `本月 ${c} 个事件` : '本月还没有事件');
    }
    case 'ledger': {
      const c = num(v.accounts);
      return card(c, c ? `${c} 个账户` : '还没有账户');
    }
    case 'vault': {
      // ⚠️ 这里**没有**「条目数量」—— 服务端刻意不给（那是「你存了几个账号」的侧信道）
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
 * 说明：⭐ 0.8.7：看板可以**再挂一个视图**（0.8.7 起是「日历视图」），
 *      但**能挂什么由接线表声明**，⛔ 宿主不许写 `if (name === 'calendar')`。
 *      ⚠️ 清单还没到手（`state.modules === null`）时 `items` 是空数组 ⇒ 回空数组 ⇒
 *      **整条胶囊不画**（什么都不判，而不是当成「都没有」）。
 *      ⭐ 用「胶囊项」而不是「`slots` 里有没有 `dash-view`」做判据：标签是**界面文案**，
 *      住在接线表的 `dashView.label`（与 `settingsPane.label` 同一条分工）。
 *
 * @param {?Array.<Object>} items - `moduleItems()` 的产物（已按清单顺序排好）
 * @returns {Array.<Object>} 声明了 `dashView` 的入口项；一个都没有时回空数组
 */
export function dashViewDefs(items) {
  return (items || []).filter((it) => it.dashView && it.dashView.label);
}

/**
 * 功能：这个账号**进首页看板时默认停在哪个模块视图** —— 空串表示「列表视图」。
 *
 * 说明：⭐ 0.8.7：列表是看板**自己的**视图，所以它不在这里出现；
 *      本函数只回答「要不要一进来就切到某个模块贡献的视图」。
 *      ⚠️ 判据是「哪个模块的简要里 `open_by_default` 为真」，⛔ **不写死模块名** ——
 *      日历模块被整目录删掉之后，它的简要键根本不出现 ⇒ 自然回空串（一并满足退化验收）。
 *      ⚠️ 服务端给的是**布尔**（不是库里那个枚举串）：`core/` 不许依赖模块，
 *      把 `'cal'` 写进 core 就是那个枚举的第二份（见 `stats.js` 里那段说明）。
 *      ⚠️ 两个及以上模块同时要求「默认」时取**清单里靠前**的那个（顺序由 `module.json` 的 `order` 定）
 *      —— 与其抛错，不如给一个确定的结果；真到那一天再说（本轮只有一个）。
 *
 * @param {?Array.<Object>} items - `moduleItems()` 的产物
 * @param {?Object} data - `GET /api/dashboard` 的响应（读它的 `briefs`）
 * @returns {string} 模块名；不切视图时回空串
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
 * ⭐ 任务分级：**顺序就是界面上从上到下的顺序**，而且「哪些分级存在」也由它说了算 ——
 * 某一级没有条目时 `dashTaskTiers()` 直接不返回它（「没有则不显示」）。
 *
 * 说明：前四级是点名的那四条；后两级是**兜底**（见 `dashTaskTiers()` 的说明）——
 *      它们不在里，但少一段就等于把那些任务从看板上抹掉：
 *      · `later` —— 比本月末还晚的，以及**压根没填截止日**的老数据；
 *      · `done`  —— 已完成的任务。它们既不是「逾期」也不是「截止」，
 *        混进那四条里去会让「今日截止」的含义变成「今天到期或今天做完的」。
 *
 * @type {Array.<{key: string, label: string}>}
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
 *      （选的「相对今天 + 区间仍起作用」）。
 *
 * 说明：① **逾期优先用 `x.overdue` 这个标志，不在这里重算一遍日期** ——
 *      概览那颗数（`DASH_FILTERS.overdue` / `dashStats()`）用的就是它，
 *      两处各算一遍迟早会出现「概览写着 3、分级里只有 2 条」而谁都不报错。
 *      ② 已完成的任务进 `done` 一级，**不参与那四条** —— 那四条说的是「还没做的事有多急」。
 *      ③ 没填截止日的进 `later`：不编一个日期给它（同 `dashGroups()` 对「没填日期」的口径）。
 *      ④ `week` / `month` 是**相对今天**的那一周 / 那一月，与区间控件选的档位无关 ——
 *      选「今日」时看板上自然只有「已逾期 + 今日截止」，那不是丢数据，是区间就没取那么多。
 *
 * @param {Object} x - `dashEntries()` 的一条
 * @param {string} [today] - 基准日 `YYYY-MM-DD`；缺省今天（只有测试会传）
 * @returns {string} `DASH_TIERS` 里某个 `key`
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
 *      返回时**只保留有条目的分级**。
 *
 * 说明：⭐ 「任务再分级一下，目前是已逾期、正常任务。现在从上到下显示：
 *      已逾期、今日截止、本周截止、本月截止，没有则不显示」。
 *      ⚠️ 入参**只该是任务**（`kind === 'task'`）—— 课程与硬件走 `dashGroups()`，
 *      它们没有「截止」这层语义（见文件头）。两端的列表都是「三块」，别再混回来。
 *      ⚠️ 段内顺序直接用入参的顺序：`dashEntries()` 已经按截止日升序排过，
 *      逾期那一级因此天然是「最久的欠账排最前」。
 *
 * @param {Array.<Object>} tasks - `dashEntries()` 结果里 `kind === 'task'` 的那些
 * @param {string} [today] - 基准日 `YYYY-MM-DD`；缺省今天（与 `dashRange()` / `dashWeekCells()`
 *     同一个约定：留一个显式的基准日，测试才不用「跑在几号就断几号」）
 * @returns {Array.<{key: string, label: string, items: Array.<Object>}>} 有条目的分级，顺序同 `DASH_TIERS`
 */
export function dashTaskTiers(tasks, today) {
  const t = today || todayStr();
  const buckets = new Map();
  (tasks || []).forEach((x) => {
    const k = dashTierOf(x, t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(x);
  });
  // ⭐ 0.7.2：**每一级内部**再按四象限排（「紧急且重要 → 紧急 → 重要 → 都不」）。
  //    分级说的是「这件事离我多近才该做」，四象限说的是「这件事多要紧」—— 两个维度不冲突，
  //    所以分级**原样保留**、只在级内重排（不是把分级换成四象限，别改错了）。
  //    ⚠️ 已完成那一级**不排**：给做完的事排急迫度没有意义，保持入参的日期序。
  //    ⚠️ 入参是 `dashEntries()` 排好的（截止日升序）；同权重靠 `Array#sort` 的**稳定性**
  //    保持这个顺序 —— 别再补一个次级比较键，那等于把日期序推翻一次。
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
 *      「本周：应该按星期 x 显示；本月：应该按自然周展示（区间日期筛选就保持现状）」。
 *
 * 说明：⚠️ 只有这两档分段，**其余档位（今日 / 单日 / 自定义区间）一律返回单段** ——
 *      单日只有一天、自定义区间的长度由用户自己定，硬分段只会把「一天的事」拆成七块。
 *      ⚠️ 没日期的条目（少数硬件连保修日都没填）统一进最后一段「其它」，
 *      **不给它们编一个日期** —— 编了就等于告诉用户「这天有事」。
 *      ⚠️ 段与段的先后按各自的第一条日期排，不依赖「周一在不在区间里」这种巧合。
 *
 *      ⭐ 0.5.5 归位：它现在只服务**课程与硬件**两类 —— 任务是 `dashTaskTiers()` 分级过的，
 *      不再走这里。原来插在本函数最前面的那个「已逾期」段（0.5.5 上半场加的）
 *      **已挪进 `dashTaskTiers()`**：那是「任务有多急」的一条判据，
 *      放在一个通用的日期分段函数里，任何非任务条目（课程 / 硬件）都会被顺带要求带 `overdue`。
 *
 * @param {Array.<Object>} entries - `dashEntries()` 的结果（**已按日期升序**）
 * @param {string} preset - 当前档位：`week` 按星期分段、`month` 按自然周分段，其余不分段
 * @returns {Array.<{key: string, label: string, items: Array.<Object>}>} 分段结果；入参为空时返回空数组
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
  // ⚠️ 「其它」永远在最后：它装的是没有日期的硬件，插在中间会被读成「那天该看它」
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
