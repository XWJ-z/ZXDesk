/**
 * modules/calendar/mobile.js —— 手机版日历（0.7.5；⭐ 0.8.7 起是**看板里的一个视图**）
 *
 * 功能：日历视图（手机版）—— ⭐ 0.7.8起是**两个视图**：月网格（点某天看当天 +
 *      **四个**只读图层的开关 + 自己的事件增删改，表单走底部弹层）与**人生日历**（一句结论 +
 *      一格一周的格子图 + 设置弹层）。两个视图共用同一份 `state.cal`，切换不重新取数。
 *
 * ⭐⭐ **0.8.7：日历不再有自己的「一屏」** —— `#view-calendar` 那个 section 与
 *    手机端「更多」页那一行入口都已删，这一份界面由**「今天」（手机版的首页看板）**通过插槽
 *    动态挂载（`mountModuleSlot(host, 'mobile', 'calendar', 'dash-view', ctx)`
 *    → 片段 `./mobile-dash-view.js` → 本文件的 `mountCalendarView(root, ctx)`）。
 *    ⚠️ 因此本文件**不认识任何固定容器 id**：渲染与查看都挂在**宿主传进来的那个根节点**上
 *    （从前写死 `#view-calendar`）；`#cal-m-panel` / `.cal-m-chips` 这类**在根节点内部**的查询
 *    一律走 `q()`（限定在根节点里），⛔ 不许再用全局 `$()`。
 *
 * ⭐ **语义与电脑版逐条对齐**：同一批文案、同一批颜色分工、同一套「图层不可用时说清是哪一种」。
 *    日期算术（年月平移 / 42 天网格 / 跨天展开 / 按日分组）两端**共用** `./shared.js` ——
 *    各写一份的下场是「电脑上 9 月 1 号在周二那格、手机上是周一那格」而且**不报任何错**。
 *    ⚠️ 两端**各写一份**的只有**版式**（颜色 / 间距 / 结构），那是**刻意**的。
 *
 * ⭐ **数据全部来自服务端**：`GET /api/calendar` 的 `layers`（课表 / 任务经 `store.dashboard()`、
 *    假期经 `core/holidays.js`、**记账经记账自己的公开方法**，0.8.3）。⛔ 本文件里没有一条
 *    「某天有课吗 / 某天有账吗」的判定（方案 §四-2）。
 *
 * ⚠️ 动作不再借宿主的动作表（⭐ 0.8.7 改动）：模块里所有按钮的 `data-cal*` 由**本模块自己**
 *    在根节点上挂的一次委托处理（`bindCalendarEvents()`），与电脑端同款。
 *    ⛔ 0.7.5~0.8.6 那套「`data-act` 必须与 `mobile/app.js` 的 `ACTIONS` 键逐字一致」**已经作废** ——
 *    日历现在是动态挂载的视图，宿主**不再静态 import 它**，也就拿不到这些函数了。
 *    ⚠️ 唯一的例外是底部弹层里那颗「删掉这条事件」：弹层是宿主的 DOM，就地绑。
 *    ⚠️ 表单的保存仍然走本端的统一出口 `state.sheetSave`（按钮 `data-act="sheet-save"`，那是宿主的动作）。
 *
 * ⚠️⚠️ **本文件里 `state` 已被 import 占用**：解构时 ⛔ 绝不许写成 `const [state, ...] = await api(...)`
 *    —— 那会就地遮蔽 import，把响应写到响应对象自己身上，界面永远空着而且**不报任何错**
 *    （番茄钟那轮实测踩过）。所以下面一律写成 `const r = await api(...)`。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.9
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/18-日历-1期.md、docs/公共/开发方案/26-看板日历视图.md
 */

import { api } from '../../core/api.js';
import { addDays, isWeekend, todayStr } from '../../core/date.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, toast } from '../../mobile/ui.js';
import {
  DOW_CN,
  LAYERS,
  NOTE_MAX,
  TITLE_MAX,
  byQuadRank,
  calCourseKey,
  dayLabel,
  eventWhenText,
  expandEvents,
  gridRangeOf,
  groupByDate,
  holidayKindOf,
  layerAmountText,
  monthTitle,
  quadKeyOf,
  shiftYm,
  ymOf,
} from './shared.js';
// ⭐ 0.8.9：与电脑端**同一条** —— 课程条那句话与看板列表视图共用
//    `courseWhenText()` 一份（core 里），⛔ 本端不另拼一句。
import { courseWhenText } from '../../core/dashboard.js';
// ⭐ 0.7.6：农历节日（纯查表、零依赖）—— 手机端格子窄，只放**节日名**（不农历日）
import { festivalOf } from './lunar.js';
// ⭐ 0.8.9：「人生日历」已**整体搬进行程**（口径住 `modules/trip/life.js`，
//    界面是行程屏那颗按钮的弹层）⇒ 本文件**不再 import 它、也不再画它** —— 日历屏只剩月视图。
// ⭐ 0.8.9（「日历视图的课程条也要像列表的一样有倒计时、上完变灰色、点击进入课程视图」）：
//    倒计时与「上完」的**判定**只住 `core/timetable.js` 一份 —— 与看板、课表页同一批纯函数。
import { ttDoneIdsOn, ttNowHM, ttSyncServerNow, ttTicker, ttTodayNow } from '../../core/timetable.js';

/**
 * 这一次挂载的**根节点**（由宿主给；`null` = 还没挂）。
 *
 * 说明：⭐ 0.8.7：日历视图现在住在「今天」（手机版首页看板）里（动态挂载）⇒
 *      它没有固定的容器 id 了。本文件所有查询 / 重画都只对着这一个节点。
 * @type {?HTMLElement}
 */
let rootEl = null;

/**
 * 功能：在**本次挂载的根节点**里查一个元素（查不到回 null）。
 * @param {string} sel - CSS 选择器
 * @returns {?HTMLElement} 命中的元素
 */
const q = (sel) => (rootEl ? rootEl.querySelector(sel) : null);

// ⭐ 0.8.9：「人生日历」整体搬进行程 ⇒ 它的 `LIFE_DEFAULT_YEARS` 也跟着搬去了
//    `modules/trip/mobile.js` / `modules/trip/desktop.js`（显示默认值住界面层，两端各一份）。

// ---------- 挂载 / 取数 / 重画 ----------

/**
 * 功能：把日历视图**挂进宿主给的那个根节点** —— 0.8.7 起它唯一的入口。
 *
 * 说明：⭐ 由「今天」的插槽片段 `./mobile-dash-view.js` 调用。三条分支与电脑端**逐条同构**
 *      （两端各一份实现是 的刻意取舍，⛔ 别把判据写出两种语义）：
 *      · 第一次挂 ⇒ 铺骨架 + 取数（带 `snapToToday`）；
 *      · `ctx.fresh === true` ⇒ **重取一次**（服务端的「今天」与四个图层都会随时间变）；
 *      · 其余（屏内切视图 / 重画）⇒ 只重画、不取数。
 *
 * @param {HTMLElement} root - 宿主给的根节点（片段自己造的）
 * @param {Object} [ctx] - 宿主传的上下文（`mountModuleSlot()` 原样转交）
 * @param {boolean} [ctx.fresh] - 看板这次是不是**新取回来的数据**（见上）
 * @returns {void}
 */
export function mountCalendarView(root, ctx) {
  if (!root) return;
  rootEl = root;
  // ⚠️⭐ 先自己挂一次委托（本模块的动作**不再走**宿主的 `ACTIONS` 表，见下面那一段的说明）：
  //    根节点每次挂载都是新的 ⇒ 每次挂载绑一次，幂等守卫在节点自己身上。
  bindCalendarEvents(root);
  // ⚠️ 用本机日期只是「先开哪一个月」的**提示** —— 权威的「今天」在响应里（`r.today`）。
  if (!state.calMonth) state.calMonth = ymOf(todayStr());
  const fresh = !!(ctx && ctx.fresh);
  // ⭐ 0.8.9 修订：与**电脑端逐字同构** —— 手里已经有数据时，
  //    `fresh` 也要**先把旧数据同步画上去**，再在后台重取一次。
  //    ⚠️ 从前 `fresh` 走「取数那条路」⇒ 每次切视图容器里先空一块、等接口回来才「啪」地出现
  //    （报过同款的「瞬间弹出来」）。现在切视图会带 `fresh`（见 `views/today.js` 的
  //    `setDashView()`），这条路每切一次都走，所以这一处必须与电脑端对齐。
  if (!state.cal) {
    // 手里什么都没有才铺骨架 + 转圈（第一次进这一屏）
    root.innerHTML = skeletonHtml(5);
    // ⭐ `snapToToday` 只在**第一次**取数时带（见 `loadCalendar()` 的说明）
    loadCalendar({ snapToToday: true }).catch((e) => {
      root.innerHTML = `<div class="cal-m-hint">日历读取失败：${esc(e.message)}</div>`;
      toast(e.message, true);
    });
    return;
  }
  renderCalendar();
  // ⚠️ 不是 `await`：上面那一遍已经把界面顶上去了，这里只负责补最新值。
  if (fresh) loadCalendar().catch((e) => toast(e.message, true));
}

/**
 * 功能：按当前月份取一次数（**一次请求**：区间事件 + 四个图层 + 服务端今天），并重画。
 *
 * @param {{snapToToday?: boolean}} [opts] - 只在**第一次取数**时传 `{ snapToToday: true }`，见下
 * @returns {Promise.<void>}
 */
async function loadCalendar(opts) {
  const { from, to } = gridRangeOf(state.calMonth);
  const r = await api('GET', `/api/calendar?from=${from}&to=${to}`);
  state.cal = r;
  // ⭐ 服务端的「今天」是权威；它不在网格里时把月份拨过去再取一次。
  //    ⚠️⭐ 0.7.6 修：这一步**只允许在第一次取数时**做（`opts.snapToToday`）—— 它原来对**每次换月**都成立
  //    （点 ‹ 翻到 8 月，而服务端 today 9-19 不在 8 月的网格里 ⇒ 立刻被拨回 9 月重取），
  //    表现就是「点 ‹ / › / 回到本月 都没反应」。⛔ 别删这段：时区兜底本身有效，只是不该在换月时触发。
  if (opts && opts.snapToToday && (r.today < r.from || r.today > r.to)) {
    state.calMonth = ymOf(r.today);
    const g = gridRangeOf(state.calMonth);
    state.cal = await api('GET', `/api/calendar?from=${g.from}&to=${g.to}`);
  }
  // ⚠️⭐ 0.7.6 配套修：选中日**越出网格**时不能一律拨成「今天」——
  //    换月时它必然成立，于是下面的面板一直显示「今天」的内容，看起来仍然像「换了月、什么都没变」。
  if (!state.calDay || state.calDay < state.cal.from || state.calDay > state.cal.to) {
    const t = state.cal.today;
    state.calDay = t >= state.cal.from && t <= state.cal.to ? t : '';
  }
  renderCalendar();
}

/**
 * 功能：画这一屏的页头 —— 月份导航四件 ＋ 四颗图层胶囊。
 *
 * 说明：⭐ 0.8.9：「人生日历」整体搬进行程 ⇒ 页头那两颗切换按钮
 *      （`日历 ｜ 人生日历`）**一并撤掉** —— 只剩一个形态时，一条切换控件是纯噪音
 *      （与看板那条胶囊「只有一种视图就整条不画」同一条口径）。
 *      ⚠️ 手机端把分段控件放在**单独一行**：375px 一行塞不下五件，而 `.cal-m-month` 是 `flex: 1`
 *      ⇒ 挤在一起会把月份压没。版式两端各一份。
 *
 * @param {Object} cal - `GET /api/calendar` 的响应
 * @returns {string} 页头的 HTML
 */
function headHtml(cal) {
  return `
      <div class="cal-m-head">
        <button class="cal-m-nav" type="button" data-cal="prev" aria-label="上一个月">‹</button>
        <strong class="cal-m-month">${esc(monthTitle(state.calMonth))}</strong>
        <button class="cal-m-nav" type="button" data-cal="next" aria-label="下一个月">›</button>
        <button class="chip sm" type="button" data-cal="today">本月</button>
      </div>
      <div class="cal-m-chips">${layersHtml(cal)}</div>`;
}

/**
 * 功能：把这一屏整个画出来 —— ⭐ 0.7.8 起按 `state.calTab` 分**两个视图**：
 *      月视图（页头 + 图层胶囊 + 月网格 + 当天面板）或人生日历（页头 + 一句结论 + 一格一周的格子图）。
 *
 * 说明：⚠️⭐ **两个视图共用同一份 `state.cal`，谁也不重新取数**（方案 §7）：切来切去不该转圈。
 *      ⚠️ 只在「换月 / 换图层 / 事件有增删改 / 切视图 / 存了人生日历的设置」之后调它；
 *      **点某天不调它** —— 那是「只选中、不换屏」，走 `paintSelection()`。
 *
 * @returns {void}
 */
export function renderCalendar() {
  const box = rootEl;
  const cal = state.cal;
  if (!box || !cal) return;

  // ⭐ 0.8.9：「人生日历」已整体搬进行程 ⇒ 这里**只剩月视图**一个形态
  //    （从前那一支 `state.calTab === 'life'` 连同页头那两颗切换按钮一起撤了）。

  const evMap = expandEvents(cal.events, cal.from, cal.to);
  const courseMap = groupByDate(cal.layers.course.items, 'date');
  const taskMap = groupByDate(cal.layers.task.items, 'date');
  const holMap = groupByDate(cal.layers.holiday.items, 'date');
  // ⭐ 0.8.3 记账图层：服务端只给**有记账条目**的那几天 ⇒ 这一格按「有没有键」判标记
  const ledgerMap = groupByDate(cal.layers.ledger.items, 'date');

  const cells = [];
  for (let d = cal.from; d <= cal.to; d = addDays(d, 1)) {
    cells.push(
      cellHtml(
        d,
        cal,
        (evMap.get(d) || []).length,
        courseMap.has(d),
        taskMap.has(d),
        holMap,
        ledgerMap.get(d),
      ),
    );
  }

  box.innerHTML = `
    <div class="cal-m-wrap">
      ${headHtml(cal)}
      <div class="cal-m-dow">${DOW_CN.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-m-grid" id="cal-m-grid">${cells.join('')}</div>
      <p class="cal-m-hint cal-m-legend">${esc(legendText(cal))}</p>
      <div class="cal-m-panel" id="cal-m-panel"></div>
    </div>`;
  paintSelection();
  applyLayerVis();
  // ⭐ 0.8.9：当天列表里的课程条 —— 先跑一拍（首屏就带倒计时 / 灰态），再挂上每分钟一拍。
  //    与电脑端逐字同款（见 `desktop.js` 同一处）。
  calLiveTick();
  ttTicker(true, calLiveTick);
}

// ⭐ 0.8.9：`lifeScreenHtml()` / `saidText()` / `openLifeForm()` **已随
//    「人生日历」搬进行程** —— 它们现在住 `modules/trip/mobile.js`（形态从「日历屏的第二个视图」
//    改成「行程屏那颗按钮的弹层」），落库也改成 `PUT /api/trip/life`。⛔ 别在这里留旧版备份。

/**
 * 功能：读「这个图层现在开着吗」—— ⭐ **唯一判据是 `state.cal.prefs`**（不是 `layers[k].on`）。
 *
 * 说明：⚠️ 两个字段看着一样，其实不同：`layers[k].on` 是**服务端那一刻的想法**，
 *      而 `prefs` 是本地可以**先改一步**的那份（关掉一个图层时先就地隐藏、再异步存下去）。
 *
 * @param {string} kind - `course` / `task` / `holiday` / `ledger`
 * @returns {boolean} 开着为 true
 */
function layerOn(kind) {
  const L = LAYERS.find((x) => x.kind === kind);
  const prefs = (state.cal && state.cal.prefs) || {};
  return L ? !!Number(prefs[L.key]) : false;
}

/**
 * 功能：按当前开关**就地**给整块加 / 撤 `lay-on-<kind>` 四个 class，并把四颗胶囊的选中态刷新。
 *
 * 说明：⭐ 关掉一个图层**不需要重新取数**：服务端下一次响应里才会不带它（方案 §九 用例 11），
 *      而「现在这一刻让它在界面上消失」纯粹是加一个 class 的事。
 *      ⛔ 反过来，**打开**一个图层必须重取 —— 它的数据当前手里没有（这正是用例 11 要的形状）。
 *
 * @returns {void}
 */
function applyLayerVis() {
  const wrap = q('.cal-m-wrap');
  if (!wrap) return;
  for (const L of LAYERS) wrap.classList.toggle('lay-on-' + L.kind, layerOn(L.kind));
  // 胶囊的选中态：就地重画那一小行（不是整屏）
  const chips = q('.cal-m-chips');
  if (chips && state.cal) chips.innerHTML = layersHtml(state.cal);
}

/**
 * 功能：四个图层开关（手机端用胶囊；不可用的那颗置灰并禁掉）。
 * @param {Object} cal - 响应
 * @returns {string} chips 的 HTML
 */
function layersHtml(cal) {
  return LAYERS.map((L) => {
    const l = cal.layers[L.kind] || { available: false };
    const dis = !l.available;
    return `<button class="chip sm${layerOn(L.kind) ? ' on' : ''}" type="button" data-cal="layer" data-layer="${
      L.key
    }"${dis ? ' disabled' : ''}>${esc(L.label)}</button>`;
  }).join('');
}

/**
 * 功能：页脚那句「这一屏现在是什么状态」的人话（与电脑版**同一份文案**）。
 * @param {Object} cal - 响应
 * @returns {string} 人话
 */
function legendText(cal) {
  const said = [];
  for (const L of LAYERS) {
    const l = cal.layers[L.kind] || {};
    if (l.note) said.push(`${L.label}：${l.note}`);
  }
  said.push('假期数据来自内置表，只到已收录的年份');
  return said.join(' ｜ ');
}

/**
 * 功能：画一格（手机端不放事件条 —— 屏太窄，事件在下面那块「当天」面板里）。
 *
 * 说明：⭐ 格子是 `<button>`：手机上点它只有「选中这一天」一个动作，没有嵌套的可点元素，
 *      而且按钮天然有 ≥44px 的触控区与 `:active` 反馈（本端的触控规矩）。
 *
 * @param {string} d - 这一天
 * @param {Object} cal - 响应
 * @param {number} evCount - 这一天有几条自己的事件
 * @param {boolean} hasCourse - 有没有课
 * @param {boolean} hasTask - 有没有任务到期
 * @param {Map.<string, Array.<Object>>} holMap - 假期按日聚好的表
 * @param {?Array.<Object>} ledgerRows - 这一天的记账小计（服务端只给有记账条目的那些天；没有则 undefined）
 * @returns {string} 格子的 HTML
 */
function cellHtml(d, cal, evCount, hasCourse, hasTask, holMap, ledgerRows) {
  const hol = holidayKindOf(holMap, d);
  const cls = ['cal-m-cell'];
  const sameMonth = d.slice(0, 7) === state.calMonth;
  if (!sameMonth) cls.push('other');
  if (isWeekend(d)) cls.push('weekend');
  // ⭐ 0.8.5：本月**已经过去**的日子（「本月过去的天应该和未来有区分」）——
  //    ⚠️ 只标**本月内**的：其它月份的格子本来就整体变淡（`.other`），再叠一层就分不清谁是谁。
  if (sameMonth && d < cal.today) cls.push('past');
  if (d === cal.today) cls.push('today');
  if (d === state.calDay) cls.push('sel');
  if (hol) cls.push(hol);

  // ⭐ 四个图层的表达与电脑版**同款**：课表 = 小圆点、任务截止 = 小方块、假期 = 底色、
  //    **记账 = 小圆点 + 当天的支出合计**（0.8.3）。
  const marks = [];
  if (hasCourse) marks.push('<i class="cal-m-dot"></i>');
  if (hasTask) marks.push('<i class="cal-m-sq"></i>');
  if (ledgerRows && ledgerRows.length) {
    // ⚠️ 手机端格子窄（一行七个 ≈ 50px）⇒ 金额只放常规量级；长了由 CSS 自己省略
    //    （⛔ 不在这里截字符串 —— 服务端给的数是钱，截它等于显示一个错的数）。
    const spent = layerAmountText(ledgerRows[0].expense_fen);
    marks.push(`<span class="cal-m-lg" title="支出 ${esc(spent)}">${esc(spent)}</span>`);
  }
  // ⭐ 0.7.6：手机端格子窄（一行七个 ≈ 50px）—— **只显示节日名**（截到 2 字）与「休 / 班」角标，
  //    ⛔ 不在这里放农历日 / 月名：放了必然挤破格子，那些信息在下面那块「当天」面板里更有用。
  //    （桌面端格子宽，走 `gridLunarText()` 的完整优先级；这是两端**唯一**的一处刻意差异。）
  const festFull = festivalOf(d);
  const fest = festFull.slice(0, 2);
  const label =
    dayLabel(d) +
    (festFull ? ` · ${festFull}` : '') +
    (hol === 'rest' ? ' · 法定放假日' : hol === 'work' ? ' · 调休上班日' : '');

  return `<button class="${cls.join(' ')}" type="button" data-cal-day="${d}" aria-label="${esc(label)}">
    <span class="cal-m-num">${Number(d.slice(8))}</span>
    ${fest ? `<span class="cal-m-fest">${esc(fest)}</span>` : ''}
    <span class="cal-m-marks">${marks.join('')}</span>
    ${evCount ? `<span class="cal-m-cnt">${evCount}</span>` : ''}
    ${hol ? `<span class="cal-m-hol ${hol}">${hol === 'rest' ? '休' : '班'}</span>` : ''}
  </button>`;
}

/**
 * 功能：**只就地改选中态与当天面板**（不整屏重画、不重新取数）—— 点某天走的就是这里。
 *
 * 说明：⭐ 点日期只**选中**、**不换屏**（`state.tab` 一个字都不能变）。
 *
 * @returns {void}
 */
function paintSelection() {
  const box = rootEl;
  if (!box) return;
  for (const cell of box.querySelectorAll('.cal-m-cell')) {
    cell.classList.toggle('sel', cell.getAttribute('data-day') === state.calDay);
  }
  const panel = q('#cal-m-panel');
  if (panel) panel.innerHTML = panelHtml();
  // ⭐ 0.8.9：面板刚被整块换掉 ⇒ 倒计时立刻补一拍（否则要等下一次整分才显示）。
  calLiveTick();
}

/**
 * 功能：当天面板的一拍 —— 给课程行填倒计时（只给**今天**那批）、并按各条自己的日期打上
 *      `done` 类（上过的课变灰）；**绝不重画这一屏**。
 *
 * 说明：⭐ 0.8.9（「日历视图的课程条也要像列表的一样有倒计时、上完变灰色」）：
 *      判定与文案**全部**来自 `core/timetable.js`（唯一一份）—— 与电脑端逐字同款，
 *      也和看板的 `dashLiveTick()` 是同一套纯函数（⛔ 不在这里另写一遍比较）。
 *      ⚠️ 时间权威源是服务端：`state.cal.now`（`GET /api/calendar` 搭车带回）。
 * @returns {void}
 */
function calLiveTick() {
  const cal = state.cal;
  if (!cal || !cal.layers || state.calTab !== 'month') return;
  ttSyncServerNow(cal.now);
  const t = ttNowHM();
  const today = String(cal.today || t.date);
  const byDate = new Map();
  for (const c of cal.layers.course.items || []) {
    const date = String((c && c.date) || '');
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ id: calCourseKey(c), start_time: c.start, end_time: c.end });
  }
  const resByDate = new Map();
  byDate.forEach((lessons, date) => {
    resByDate.set(date, {
      doneIds: ttDoneIdsOn(date, today, t.hm, lessons),
      byId: date === today ? ttTodayNow(t.hm, lessons).byId : null,
    });
  });
  const box = rootEl || document;
  box.querySelectorAll('[data-cal-live]').forEach((live) => {
    const key = live.getAttribute('data-cal-live') || '';
    const date = key.slice(0, key.indexOf('|'));
    const r = resByDate.get(date);
    const row = live.closest('.cal-m-row');
    if (row) row.classList.toggle('done', !!r && r.doneIds.has(key));
    live.textContent = (r && r.byId && r.byId.get(key)) || '';
  });
}

/**
 * 功能：画「当天」面板里的一条任务行 —— 那四个分组（已逾期 / 今日截止 / 今日可做 / 明日截止）
 *      **共用这一份**，⛔ 别在每组里各写一遍（改一处必然漏另一处）。
 *
 * 说明：⭐ 0.8.9 修订：与电脑端**同一条** —— **去掉两枚象限徽章**
 *      （「🔴 重要 / ⏰ 紧急」把标题挤没了），改成把象限写成 `data-q` 交给 CSS 上色，
 *      组内顺序由 `byQuadRank()` 定（两端同住 `shared.js`，⛔ 别各写一份）。
 *      行上的 `data-cal-task` / `data-cal-src` 是给宿主的 —— 点击由 `mobile/app.js` 接成 `zx:open-task`。
 *
 * @param {Object} t - 任务图层里的一条
 * @returns {string} 这一行的 HTML（文本一律经 `esc()`）
 */
function calTaskRow(t) {
  return `<div class="cal-m-row ro k-task${t.done ? ' done' : ''}" data-q="${quadKeyOf(
    t,
  )}" tabindex="0" data-cal-task="${Number(t.id)}" data-cal-src="${esc(t.source || '')}"><b>${esc(
    t.title,
  )}</b><em>${esc(t.project)}${t.done ? ' · 已完成' : ''}</em></div>`;
}

/**
 * 功能：画「当天」面板 —— 自己的事件（可点开改/删）+ 四个图层那天的内容（只读）。
 * @returns {string} 面板的 HTML
 */
function panelHtml() {
  const cal = state.cal;
  const d = state.calDay;
  if (!cal || !d) return '';
  const evs = (cal.events || []).filter((e) => {
    const s = String(e.date || '');
    const t = String(e.end_date || '') || s;
    return s && s <= d && t >= d;
  });
  const courses = (cal.layers.course.items || []).filter((c) => c.date === d);
  // ⭐ 0.8.9 修订（与电脑端**逐条同构**）：
  //    · 「显示为今天截止的任务和今天完成的任务」—— 没完成的看截止日、已完成的看完成日；
  //    · 行上带 `data-cal-task` / `data-cal-src`，点击派留白事件 `zx:open-task`（动作由宿主外接）。
  // ⭐ 0.8.9 修订：这一块**按下四组分**（已逾期 / 今日截止 / 今日可做 / 明日截止），
  //    所以这里先留**全量**，分组的判据只写在下面那一处（与电脑端同一套口径）。
  const taskRows = cal.layers.task.items || [];
  const hols = (cal.layers.holiday.items || []).filter((h) => h.date === d);
  // ⭐ 0.8.3 记账图层：这一天的小计（服务端只给有记账条目的那些天 ⇒ 空数组 = 这天没记过账）
  const ledger = (cal.layers.ledger.items || []).filter((x) => x.date === d);

  const out = [
    `<div class="cal-m-dayhead"><strong>${esc(dayLabel(d))}</strong>
       <button class="chip sm" type="button" data-cal="new" data-day="${d}">＋ 新建事件</button></div>`,
  ];

  out.push('<div class="cal-m-sec k-event">我的事件</div>');
  out.push(
    evs.length
      ? evs
          .map(
            (e) =>
              `<button class="cal-m-row on k-event" type="button" data-cal-ev="${Number(e.id)}">
                 <b>${esc(e.title)}</b><em>${esc(eventWhenText(e))}</em></button>`,
          )
          .join('')
      : '<p class="cal-m-hint">这一天还没有自己的事件。</p>',
  );

  if (layerOn('course')) {
    out.push('<div class="cal-m-sec k-course">课程</div>');
    out.push(
      courses.length
        ? courses
            .map((c) => {
              // ⭐ 0.8.9：这一条有个稳定的键（`data-cal-live` 与 `data-cal-course` 同一个值）——
              //    倒计时的定时器靠它把「DOM 上那一行」与「数据里那一节」对上。
              const key = calCourseKey(c);
              // ⭐ 0.8.9：这一句与电脑端、看板列表视图**逐字相同**（`courseWhenText()`）——
              //    ⛔ 别再在这里拼「起–止 · 教室」那种短句。
              return `<div class="cal-m-row ro k-course" data-cal-course="${esc(key)}"><b>${esc(
                c.title,
              )}</b><em>${esc(
                courseWhenText({
                  date: c.date,
                  start: c.start,
                  end: c.end,
                  periodStart: c.period_start,
                  periodEnd: c.period_end,
                  room: c.room,
                  adjusted: c.adjusted,
                  rescheduled: c.rescheduled,
                }),
              )}<span class="dash-live" data-cal-live="${esc(key)}"></span></em></div>`;
            })
            .join('')
        : '<p class="cal-m-hint">这天没有课。</p>',
    );
  }

  if (layerOn('task')) {
    // ⭐ 0.8.9 修订：与电脑端**同一套四组、同一口径、同一顺序** ——
    //    已逾期 → 今日截止 → 今日可做 → 明日截止（详见 `desktop.js` 同一处的说明）。
    //    ⚠️ 空组不画；四组全空时才回落原来那一句。
    const tomorrow = addDays(d, 1);
    // ⚠️ 组内顺序 = 四象限优先级（给定），与电脑端**同住** `shared.js` 的 `byQuadRank`。
    const taskGroups = [
      { key: '', label: '已逾期', list: taskRows.filter((t) => !t.done && t.date && t.date < d) },
      { key: '', label: '今日截止', list: taskRows.filter((t) => (t.done ? t.done_date === d : t.date === d)) },
      { key: 'doing', label: '今日可做', list: taskRows.filter((t) => !t.done && t.date && t.date > d) },
      { key: 'tomorrow', label: '明日截止', list: taskRows.filter((t) => t.date === tomorrow) },
    ];
    taskGroups.forEach((g) => g.list.sort(byQuadRank));
    const total = taskGroups.reduce((n, g) => n + g.list.length, 0);
    if (!total) {
      out.push('<div class="cal-m-sec k-task">任务</div>');
      out.push('<p class="cal-m-hint">这天没有任务到期。</p>');
    } else {
      taskGroups.forEach((g) => {
        if (!g.list.length) return;
        // ⭐ 0.8.9：「今日可做、明日截止默认折叠，点击可展开和收起」——
        //    手机端**收起时那些行干脆不输出**（点标题改 `state.calFold` 之后整块重画面板）；
        //    电脑端那边是就地切一个 class（它不想丢掉侧栏的滚动位置）—— 两端效果一致。
        const folded = !!g.key && !(state.calFold && state.calFold[g.key]);
        const attr = g.key ? ` data-cal-fold="${g.key}"` : '';
        const caret = g.key ? `<i class="cal-m-caret${folded ? ' up' : ''}"></i>` : '';
        out.push(`<div class="cal-m-sec k-task${folded ? ' folded' : ''}"${attr}>${g.label} · ${g.list.length}${caret}</div>`);
        if (!folded) out.push(g.list.map(calTaskRow).join(''));
      });
    }
  }

  if (layerOn('holiday') && hols.length) {
    out.push('<div class="cal-m-sec k-holiday">假期</div>');
    out.push(
      hols
        .map(
          (h) =>
            `<div class="cal-m-row ro k-holiday"><b>${h.kind === 'rest' ? '法定放假日' : '调休上班日'}</b><em>${
              h.kind === 'rest' ? '休息' : '要上班'
            }</em></div>`,
        )
        .join(''),
    );
  }

  // ⭐ 0.8.3 记账图层：这一天记了什么账 —— 收入 / 支出两个合计（只读、不可点）。
  //    ⚠️ 与假期那块同款：**没记过账就不出这一块**（⛔ 不写一句「这天没记账」）。
  if (layerOn('ledger') && ledger.length) {
    out.push('<div class="cal-m-sec k-ledger">记账</div>');
    out.push(
      `<div class="cal-m-row ro k-ledger"><b>支出合计</b><em>${esc(
        layerAmountText(ledger[0].expense_fen),
      )}</em></div>` +
        `<div class="cal-m-row ro k-ledger"><b>收入合计</b><em>${esc(layerAmountText(ledger[0].income_fen))}</em></div>`,
    );
  }

  return out.join('');
}

// ---------- 动作（⭐ 0.8.7：本模块**自己的**一次事件委托，⛔ 不再借宿主的 `ACTIONS` 表） ----------
//
// ⚠️⭐ 0.7.5~0.8.6 这些动作住在 `mobile/app.js` 的 `ACTIONS` 表里（键名与 `data-act` 逐字对应）。
//    0.8.7日历变成**看板里动态挂载的一个视图** ⇒ 宿主**不再静态 import 它**
//    （那正是「删掉日历目录不连累整页」的前提）⇒ 宿主的动作表也就再也拿不到这些函数了。
//    ⇒ 改成与**电脑端同款**：模块在**宿主给的那个根节点**上挂一次委托（`bindCalendarEvents()`）。
//    ⛔ 别再把它们挪回 `ACTIONS` —— 那等于让宿主重新认识这个模块的实现。
//
// ⚠️ 唯一的例外是**底部弹层里那颗「删掉这条事件」**：弹层是宿主的 DOM（`#sheet`），
//    不在本模块的根节点里 ⇒ 它在 `calEventSheet()` 里**就地绑**（与电脑端绑 `#modal-save` 同款）。

/**
 * 功能：给**这一次挂载的根节点**挂一次事件委托 —— 切视图 / 换月 / 回到本月 / 新建 / 点某天 /
 *      点事件 / 切图层胶囊。
 *
 * 说明：⚠️ 视图每次重画都会换掉里头的 DOM，所以只能在**不换的祖先**（宿主给的那个根节点）上委托；
 *      ⛔ 绝不在渲染函数里逐个 `addEventListener`（那必然漏，而且会重复叠加）。
 *      ⚠️ 根节点**每次挂载都是新的**（看板重画会重建它）⇒ 幂等守卫放在节点自己身上。
 *      ⚠️ 分段控件的动作名（`data-cal` 的取值）与下面这段 `if` 是**一对**：加了按钮不加分支
 *      ＝「点了没反应」且**不报错**。
 *
 * @param {HTMLElement} root - 宿主给的根节点（`mountCalendarView()` 转交给它）
 * @returns {void}
 */
export function bindCalendarEvents(root) {
  const box = root;
  if (!box || box.dataset.calBound === '1') return;
  box.dataset.calBound = '1';
  box.addEventListener('click', (e) => {
    // ⓪-0 ⭐ 0.8.9：「今日可做 / 明日截止默认折叠，点击可展开和收起」——
    //    与电脑端**同一份状态**（`state.calFold`）、同一套 `key`；手机端这里是改完状态后
    //    **重画当天面板**（`paintSelection()`），而电脑端就地切 class。
    const foldHead = e.target.closest('[data-cal-fold]');
    if (foldHead) {
      const key = foldHead.getAttribute('data-cal-fold') || '';
      state.calFold = state.calFold || {};
      state.calFold[key] = !state.calFold[key];
      paintSelection();
      return undefined;
    }
    // ⓪-0 ⭐ 0.8.9：「点击任务要弹出详情」—— 与电脑端**逐条同构**：
    //    这里只把数据派成留白事件（`zx:open-task`），开哪个弹层由宿主 `mobile/app.js` 决定
    //    （联动宪法 ②：⛔ 跨模块 import 别人的实现）。
    const taskRow = e.target.closest('[data-cal-task]');
    if (taskRow) {
      const id = Number(taskRow.getAttribute('data-cal-task'));
      const src = taskRow.getAttribute('data-cal-src') || '';
      const items =
        (state.cal && state.cal.layers && state.cal.layers.task && state.cal.layers.task.items) || [];
      const t = items.find((x) => Number(x.id) === id && String(x.source || '') === src);
      if (t && t.task) {
        document.dispatchEvent(
          new CustomEvent('zx:open-task', {
            detail: { scope: t.source || '', task: t.task, name: t.project || '', icon: t.icon || '' },
          }),
        );
      }
      return undefined;
    }
    // ⓪ ⭐ 0.8.9：当天面板里的**课程条**点一下 → 去课表（底下那颗标签。
    //    ⛔ 不 import 课表模块 —— 那是别的模块的实现，删目录验收会挂）。
    const courseRow = e.target.closest('[data-cal-course]');
    if (courseRow) {
      const tab = document.getElementById('tab-timetable');
      if (tab) tab.click();
      return undefined;
    }
    // ① 当天面板 / 事件行 → 打开表单（⚠️ 必须排在最前：它们在面板里面）
    const evBtn = e.target.closest('[data-cal-ev]');
    if (evBtn) return calEventSheet(evBtn.getAttribute('data-cal-ev'), '');
    // ② 页头那几颗 ＋ 图层胶囊 ＋「＋ 新建事件」
    const btn = e.target.closest('[data-cal]');
    if (btn) {
      const what = btn.getAttribute('data-cal');
      // ⭐ 0.8.9：「`tab-month` / `tab-life` / `life-set`」三条**已随
      //    「人生日历」搬走** —— 日历屏只剩月视图，页头那两颗切换按钮也撤了。
      if (what === 'layer') return calToggleLayer(btn.getAttribute('data-layer') || '');
      if (what === 'new') return calEventSheet('', btn.getAttribute('data-day') || '');
      if (what === 'prev') return calShift(-1);
      if (what === 'next') return calShift(1);
      if (what === 'today') return calToday();
      return undefined;
    }
    // ③ 点某天 → **只选中、不换屏**
    const cell = e.target.closest('[data-cal-day]');
    if (cell) calPickDay(cell.getAttribute('data-cal-day') || '');
    return undefined;
  });
}

// ⭐ 0.8.9：`calTabMonth()` / `calTabLife()` / `calLifeSet()` **三个导出已撤** ——
//    它们服务的那两颗切换按钮随「人生日历」一起搬去了行程（`modules/trip/mobile.js`）。
//    ⚠️ 撤导出前已 grep 过宿主的动作表：`mobile/app.js` 里一处都没引用它们。

/**
 * 功能：上一个 / 下一个月。
 * @param {number} delta - 负数往前、正数往后（单位：月）
 * @returns {void}
 */
export function calShift(delta) {
  state.calMonth = shiftYm(state.calMonth, Number(delta) < 0 ? -1 : 1);
  state.calDay = '';
  loadCalendar().catch((e) => toast(e.message, true));
}

/**
 * 功能：跳回「今天」所在的那个月。
 * @returns {void}
 */
export function calToday() {
  state.calMonth = ymOf((state.cal && state.cal.today) || todayStr());
  state.calDay = '';
  loadCalendar().catch((e) => toast(e.message, true));
}

/**
 * 功能：选中某一天（⭐ **只选中、不换屏**）。
 * @param {string} date - 那一天 `YYYY-MM-DD`（来自格子的 `data-cal-day`）
 * @returns {void}
 */
export function calPickDay(date) {
  state.calDay = String(date || '');
  paintSelection();
}

/**
 * 功能：翻某个图层的开关（⭐ 逐键保存，照 `PUT /api/auth/prefs` 的惯例）。
 *
 * 说明：⚠️ 两个方向**不是一回事**，这是刻意的（与电脑版逐条对齐）：
 *      · **关掉**：数据不用动（下一次响应里才不带它）⇒ 先就地撤 class 让它立刻消失，
 *        再异步把开关存下去。**不发第二次取数请求、不重画整屏**。
 *      · **打开**：那一层的数据**当前手里没有**（服务端对关掉的层返回空条目，见用例 11）
 *        ⇒ 只能重取一次。
 *
 * @param {string} key - 图层开关的列名（来自胶囊的 `data-layer`）
 * @returns {void}
 */
export function calToggleLayer(key) {
  if (!key || !state.cal || !state.cal.prefs) return;
  const before = Number(state.cal.prefs[key]) ? 1 : 0;
  const on = !before;
  state.cal.prefs[key] = on ? 1 : 0;
  applyLayerVis();
  paintSelection();
  const body = {};
  body[key] = on;
  api('PUT', '/api/calendar/layers', body)
    .then(() => (on ? loadCalendar() : null))
    .catch((e) => {
      toast(e.message, true);
      // 存失败就把界面拨回真实状态，⛔ 别让胶囊停在「看起来生效了」的样子
      state.cal.prefs[key] = before;
      applyLayerVis();
      paintSelection();
      return loadCalendar();
    });
}

/**
 * 功能：打开事件表单 —— 传了 id 是改，传空是新建（默认落在指定那一天 / 当前选中那一天）。
 *
 * 说明：⚠️ 设成「全天」时提交前**必须把两个时刻清掉**：后端会把「全天却带着时刻」
 *      直接打回 400（方案 §4.1 第一条硬约束），不清就会变成一个填完保存不了的框。
 *      ⚠️ 表单里那颗「删掉这条事件」住在**宿主的底部弹层**里 ⇒ 这里**就地绑**（见下面那段）。
 *
 * @param {?string} id - 事件 id（新建传空）
 * @param {string} [day] - 新建时默认落在哪一天（缺省用当前选中日 / 今天）
 * @returns {void}
 */
export function calEventSheet(id, day) {
  const num = Number(id || 0);
  const cur = num ? ((state.cal && state.cal.events) || []).find((x) => Number(x.id) === num) : null;
  const isNew = !cur;
  const base = cur || {
    title: '',
    date: String(day || state.calDay || todayStr()),
    end_date: '',
    all_day: false,
    start_time: '',
    end_time: '',
    note: '',
  };

  openSheet(
    isNew ? '新建事件' : '改这条事件',
    `<label class="fld"><span>标题</span>
       <input id="cal-f-title" type="text" maxlength="${TITLE_MAX}" placeholder="如：体检 / 交报告 / 出差" value="${esc(
         base.title,
       )}" /></label>
     <label class="fld"><span>日期</span><input id="cal-f-date" type="date" value="${esc(base.date)}" /></label>
     <label class="fld"><span>结束日期（跨天时填）</span><input id="cal-f-end" type="date" value="${esc(
       base.end_date,
     )}" /></label>
     <label class="fld cal-m-cb"><input id="cal-f-allday" type="checkbox"${
       base.all_day ? ' checked' : ''
     } /> <span>全天（不填具体时刻）</span></label>
     <label class="fld"><span>开始时刻</span><input id="cal-f-start" type="time" value="${esc(
       base.start_time,
     )}" /></label>
     <label class="fld"><span>结束时刻</span><input id="cal-f-endt" type="time" value="${esc(
       base.end_time,
     )}" /></label>
     <label class="fld"><span>备注（可以空着）</span>
       <textarea id="cal-f-note" rows="3" maxlength="${NOTE_MAX}" placeholder="想记的细节">${esc(base.note)}</textarea></label>
     ${isNew ? '' : '<button class="btn ghost" type="button" data-cal-del="' + Number(cur.id) + '">删掉这条事件</button>'}`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save" style="flex:1.4">保存</button>`,
  );

  /** 功能：全天勾上时把两个时刻框禁掉（清空动作留到保存时一起做）。 @returns {void} */
  const syncAllDay = () => {
    const on = $('#cal-f-allday').checked;
    $('#cal-f-start').disabled = on;
    $('#cal-f-endt').disabled = on;
  };
  $('#cal-f-allday').onchange = syncAllDay;
  syncAllDay();

  // ⚠️⭐ 0.8.7：这颗「删掉这条事件」**在宿主的底部弹层里**（不在本模块的根节点里），
  //    所以上面那次委托够不着它 ⇒ **就地绑**（与电脑端绑 `#modal-save` / `#cal-f-del` 同款）。
  //    ⛔ 别改用 `data-act="..."` 走宿主的动作表 —— 那要求宿主认识本模块的函数。
  if (!isNew) {
    const delBtn = document.querySelector('[data-cal-del]');
    if (delBtn) delBtn.onclick = () => calDelete(delBtn.getAttribute('data-cal-del'));
  }

  state.sheetSave = async () => {
    const title = $('#cal-f-title').value.trim();
    if (!title) {
      toast('给这条事件写个标题吧', true);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test($('#cal-f-date').value)) {
      toast('选一个开始日期', true);
      return;
    }
    const allDay = $('#cal-f-allday').checked;
    const body = {
      title,
      date: $('#cal-f-date').value,
      end_date: $('#cal-f-end').value,
      all_day: allDay,
      start_time: allDay ? '' : $('#cal-f-start').value,
      end_time: allDay ? '' : $('#cal-f-endt').value,
      note: $('#cal-f-note').value.trim(),
    };
    if (isNew) await api('POST', '/api/calendar', body);
    else await api('PUT', `/api/calendar/${Number(cur.id)}`, body);
    closeSheet();
    await loadCalendar();
    state.calDay = body.date;
    paintSelection();
    toast(isNew ? '记下了' : '改好了');
  };
}

/**
 * 功能：删掉表单对着的那条事件（先问一次）。
 *
 * ⚠️ 确认层与表单**共用同一个 `#sheet`**：`askConfirm()` 会把表单内容换掉，所以确认之后
 *    要么成功关掉、要么取消后**重新把表单画回来** —— 少了「画回来」这一步，用户点一下
 *    「取消」就会看到表单凭空消失（这就是「单例容器被顺序覆盖」那类坑的另一种形态）。
 *
 * @param {(number|string)} id - 要删的事件 id（来自那颗按钮的 `data-cal-del`）
 * @returns {Promise.<void>}
 */
export async function calDelete(id) {
  const num = Number(id || 0);
  if (!num) return;
  const ev = ((state.cal && state.cal.events) || []).find((x) => Number(x.id) === num);
  const yes = await askConfirm({
    title: '删掉这条事件',
    text: `「${(ev && ev.title) || '这条事件'}」会被删掉，删了就找不回来了。`,
    ok: '永久删除',
    danger: true,
  });
  if (!yes) {
    // 取消 ⇒ 把表单画回来（确认层刚把它覆盖掉）
    calEventSheet(String(num), '');
    return;
  }
  try {
    await api('DELETE', `/api/calendar/${num}`);
    closeSheet();
    await loadCalendar();
    toast('删掉了');
  } catch (e) {
    toast(e.message, true);
  }
}
