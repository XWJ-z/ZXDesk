/**
 * modules/calendar/desktop.js —— 电脑版日历（0.7.5；⭐ 0.8.7 起是**看板里的一个视图**）
 *
 * 功能：日历视图 —— 月视图（自己画，原生 DOM + CSS Grid，零依赖）+ 点某天看当天 +
 *      **四个**只读图层的开关 + 自己的事件增删改 ＋ 0.7.8 起的「人生日历」第二个视图。
 *
 * ⭐⭐ **0.8.7：日历不再有自己的「一屏」** —— `#calendar-view` 那个 section 已删，
 *    这一份界面由**首页看板**通过插槽动态挂载（`mountModuleSlot(host, 'desktop', 'calendar', 'dash-view', ctx)`
 *    → 片段 `./desktop-dash-view.js` → 本文件的 `mountCalendarView(root, ctx)`）。
 *    ⚠️ 因此本文件**不认识任何固定容器 id**：渲染与**一次事件委托**都挂在**宿主传进来的那个根节点**上
 *    （从前写死 `#calendar-view`）。挂错地方的表现是「点了没反应」而且**不报错** —— 这是本次改动
 *    最容易踩的一处，改这块时⛔ 别把 `root` 又换回 `document.querySelector('#…')`。
 *    ⚠️ 也正因为它不再是「一屏」，本文件**不再 import 宿主的 shell**（不切视图、不重画侧栏）。
 *
 * ⭐ **判据只有一句话：关掉课表，日历还能不能用**（方案 §〇-1）。所以本文件里
 *    「课表 / 任务 / 假期 / **记账**」四层的**数据**一律来自服务端算好的 `layers`
 *    （`GET /api/calendar`），前端只负责**画**与**加开关** —— ⛔ 这里不出现任何
 *    「某天有课吗 / 某天有账吗」的判定（那是第二份真值，抄错的后果是「课表页有这节、
 *    日历上没有」而且不报错）。
 *
 * ⭐ 日期算术（年月平移 / 42 天网格 / 跨天展开 / 按日分组）住 `./shared.js` ——
 *    两端**逐字共用一份**。各写一份的下场是「电脑上 9 月 1 号在周二那格、手机上是周一那格」，
 *    而且**不报任何错**。这里只留**版式**（`CELL_MAX` 这种格子里摆几条的排版参数）。
 *
 * ⭐ 状态住 `desktop/state.js`（`state.cal` / `calMonth` / `calDay` / `calTab`）而不是模块级 `let`：
 *    模块级单例在「多个视图之间来回切」时会被别处的 import 顺序影响，本项目已把它定为共用件。
 *    ⚠️ 根节点那个 `rootEl` 是**例外、且刻意**：它是「这一次挂载挂在哪」，不属于应用状态。
 *    ⚠️⚠️ **本文件里 `state` 已被 import 占用**：解构时 ⛔ 绝不许出现 `const [state, ...] = await api(...)`
 *    —— 那会就地遮蔽 import，把响应写到响应对象自己身上，界面永远空着而且**不报任何错**
 *    （番茄钟那轮实测踩过）。所以下面一律写成 `const r = await api(...)`。
 *
 * ⚠️ 一次性事件委托：视图整块重画，屏内的点击 / 切换一律在 `bindCalendarEvents(root)` 里
 *    挂**一次**委托（逐个绑必漏），与灵感库 / 番茄钟同款。
 *
 * ⚠️ 渲染一律 `esc()`；⛔ 不拼未转义的用户文本进 innerHTML。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.61
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/18-日历-1期.md、docs/公共/开发方案/26-看板日历视图.md
 */

import { api } from '../../core/api.js';
import { addDays, isWeekend, todayStr } from '../../core/date.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
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
// ⭐ 0.8.9（「这个时间和列表视图的不一样，要和列表视图一模一样」）：
//    课程条那一句话与看板列表视图**共用一份**（`courseWhenText()` 在 core 里）——
//    ⛔ 这里不许再拼一遍短句，两处各拼一份必然漂。
import { courseWhenText } from '../../core/dashboard.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
// ⭐ 0.7.6：农历 / 节日（纯查表、零依赖）—— 只在月视图的格子里用一句话
import { gridLunarText } from './lunar.js';
// ⭐ 0.8.9：「人生日历」已**整体搬进行程**（口径住 `modules/trip/life.js`，
//    界面是行程屏那颗按钮的弹层）⇒ 本文件**不再 import 它、也不再画它** —— 日历屏只剩月视图。
// ⭐ 0.8.9（「日历视图的课程条也要像列表的一样有倒计时、上完变灰色、点击进入课程视图」）：
//    倒计时与「上完」的**判定**只住 `core/timetable.js` 一份 —— 与看板、课表页同一批纯函数，
//    ⛔ 这里不许自己写一遍 `start < now < end`（第二份判据必然漂移，而且不报错）。
import { ttDoneIdsOn, ttNowHM, ttSyncServerNow, ttTicker, ttTodayNow } from '../../core/timetable.js';

/** 一个格子里最多摆几条自己的事件，超出折叠成「+N」（**版式**常量，两端各一份） */
const CELL_MAX = 3;

// ⭐ 0.8.9：「人生日历」整体搬进行程 ⇒ 它的 `LIFE_DEFAULT_YEARS` 也跟着搬去了
//    `modules/trip/desktop.js` / `modules/trip/mobile.js`（显示默认值住界面层，两端各一份）。

/**
 * 这一次挂载的**根节点**（由宿主给；`null` = 还没挂）。
 *
 * 说明：⭐ 0.8.7：日历视图现在住在**首页看板**里（动态挂载），所以它没有固定的容器 id 了。
 *      本文件所有查询 / 重画 / 事件委托都只对着这一个节点 —— ⛔ 不许在别处再 `$('#calendar-view')`。
 * @type {?HTMLElement}
 */
let rootEl = null;

/**
 * ⭐ 0.8.9：「其它」那块 —— 宿主（首页看板）把它**交给本视图摆放**。
 *
 * 说明：「这个其它显示在日历下方即可，左边显示长了会空很多不好看」——
 *      日历视图是两栏（日历 ｜ 当天任务），左列通常比右列短，而「其它」原本排在两栏**之下**
 *      ⇒ 左侧空出一大块。现在宿主把那一块（`#dash-other`）当 `ctx.belowEl` 交过来，
 *      本视图每次画完把它放进 `.cal-body` —— 那是个两列网格，于是它自动落在
 *      **第二行第一列**，也就是日历正下方。
 *      ⚠️ 是**同一个节点**（宿主建、宿主拥有），这里只搬位置：本视图挂载失败 / 模块不在时
 *      它留在宿主那儿，「其它」不会因为日历出问题而消失。
 *      ⚠️ 每次 `renderCalendar()` 都要重搬一次 —— 那一句 `innerHTML` 会把上一次搬进来的节点销毁。
 * @type {?HTMLElement}
 */
let belowEl = null;

/**
 * 功能：在**本次挂载的根节点**里查一个元素（查不到回 null，与 `core/dom.js` 的 `$` 同语义）。
 * @param {string} sel - CSS 选择器
 * @returns {?HTMLElement} 命中的元素
 */
const q = (sel) => (rootEl ? rootEl.querySelector(sel) : null);

// ---------- 挂载 / 取数 / 重画 ----------

/**
 * 功能：把日历视图**挂进宿主给的那个根节点** —— 0.8.7 起它唯一的入口。
 *
 * 说明：⭐ 由看板插槽片段 `./desktop-dash-view.js` 调用（片段只负责造根节点与接上下文）。
 *      · 第一次挂（`state.cal` 还没有）⇒ 铺骨架 + 取数，并带 `snapToToday`（那条时区兜底只该在
 *        「第一次定位到哪个月」时生效，见 `loadCalendar()`）；
 *      · `ctx.fresh === true`（宿主说「看板这次是新取回来的数据」）⇒ **重取一次**：
 *        服务端的「今天」与四个图层都会随时间变，本视图摆的就是「某天有什么」；
 *      · 其余情况（屏内重画 / 切视图）⇒ **只重画、不取数**（两个视图共用一份 `state.cal`）。
 *
 * @param {HTMLElement} root - 宿主给的根节点（片段自己造的）
 * @param {Object} [ctx] - 宿主传的上下文（`mountModuleSlot()` 原样转交）
 * @param {boolean} [ctx.fresh] - 看板这次是不是**新取回来的数据**（见上）
 * @returns {void}
 */
export function mountCalendarView(root, ctx) {
  if (!root) return;
  rootEl = root;
  // ⭐ 0.8.9：记下宿主交来的那一块（见 `belowEl` 的说明）—— 每次重画都要重新搬一次
  belowEl = (ctx && ctx.belowEl) || null;
  bindCalendarEvents(root);
  // ⚠️ 用本机日期只是「先开哪一个月」的**提示** —— 权威的「今天」在响应里（`r.today`）。
  //    本机与服务端不在同一个时区时，下面那次校正会把月份拨回去。
  if (!state.calMonth) state.calMonth = ymOf(todayStr());
  const fresh = !!(ctx && ctx.fresh);
  // ⭐ 0.8.9 修订（「从其它卡片切换回首页看板，日历部分是瞬间弹出来的」）：
  //    手里**已经有数据**时（从别的屏切回来就是这种），**先同步画一遍**再后台重取。
  //    从前 `fresh` 也走「取数那条路」⇒ 容器里先空一块、等 `/api/calendar` 回来才「啪」地出现，
  //    那一下正是说的「瞬间弹出来」。现在旧数据先顶上，新数据回来再画一遍
  //    —— 观感是「内容更新」，不是「空白 → 出现」。
  if (!state.cal) {
    // 手里什么都没有才铺骨架 + 转圈（第一次进这一屏）
    root.innerHTML = skeletonHtml(5);
    // ⭐ `snapToToday` 只在**第一次**取数时带（见 `loadCalendar()` 的说明）
    loadCalendar({ snapToToday: true }).catch((e) => {
      root.innerHTML = `<div class="cal-hint">日历读取失败：${esc(e.message)}</div>`;
      toast(e.message, true);
    });
    return;
  }
  renderCalendar();
  // ⚠️ `fresh`（宿主说「看板这次是新取回来的数据」）⇒ 后台再取一次：服务端的「今天」与四个图层
  //    都会随时间变。⛔ 不是 `await` —— 上面那一遍已经把界面顶上去了，这里只负责补最新值。
  if (fresh) loadCalendar().catch((e) => toast(e.message, true));
}

/**
 * 功能：按当前显示的月份拉一次数据（**一次请求**：区间事件 + 四个图层 + 服务端今天），并重画。
 *
 * 说明：⚠️ 四个图层**一律全要**（哪怕账号把它们关掉了）：`layers` 响应里的 `available` / `note`
 *      是「这层现在还画得出来吗、为什么画不出来」的唯一出处，不请求就不知道该怎么把开关画成灰的。
 *      关掉的那些层，服务端会把条目清空（不会白给数据）。
 *
 * @param {{snapToToday?: boolean}} [opts] - 只在**第一次取数**时传 `{ snapToToday: true }`，见下
 * @returns {Promise.<void>}
 */
async function loadCalendar(opts) {
  const { from, to } = gridRangeOf(state.calMonth);
  const r = await api('GET', `/api/calendar?from=${from}&to=${to}`);
  state.cal = r;
  // ⭐ 服务端的「今天」是权威。若它不在这张网格里（本机时区与服务端差一天以上），
  //    把月份拨到它那一月并重取一次。
  //    ⚠️⭐ 0.7.6 修：这一步**只允许在第一次取数时做一次**（`opts.snapToToday`）。
  //    它原来对**每一次换月**都成立 —— 点 ‹ 切到 8 月，网格是 8 月、而服务端 today 是 9-19
  //    不在网格里 ⇒ 立刻被拨回 9 月重取，净效果就是「点 ‹ / › / 回到本月 都没反应」。
  //    ⛔ 别把这段删掉：那条时区兜底本身是有效的，只是不该在换月时触发。
  if (opts && opts.snapToToday && (r.today < r.from || r.today > r.to)) {
    state.calMonth = ymOf(r.today);
    const g = gridRangeOf(state.calMonth);
    state.cal = await api('GET', `/api/calendar?from=${g.from}&to=${g.to}`);
  }
  // ⚠️⭐ 0.7.6 配套修：选中日**越出网格**时不能一律拨成「今天」——
  //    换月时它必然成立（8 月的网格里没有 9-19），于是右侧「这一天」的列表一直显示今天的内容，
  //    看起来仍然像「换了月、什么都没变」。现在：今天还在这张网格里才拨过去，否则**清空**选中。
  if (!state.calDay || state.calDay < state.cal.from || state.calDay > state.cal.to) {
    const t = state.cal.today;
    state.calDay = t >= state.cal.from && t <= state.cal.to ? t : '';
  }
  renderCalendar();
}

/**
 * 右栏「锁高」的观察器 —— 每次 `renderCalendar()` 都会重建节点，旧的必须 disconnect。
 * @type {?ResizeObserver}
 */
let sideRo = null;

/**
 * 功能：把右栏（`.cal-side`，选中那天的任务）的高度**锁到日历卡片**（`.cal-main`）的实际高度，
 *      超出部分在右栏**内部**滚；并盯住日历高度的变化（某天事件多 ⇒ 格子被撑高）。
 *
 * 说明：⭐ 0.8.61：「电脑端的日历视图…高度应该和日历高度一致，可以单独上下滑动」。
 *      改造前右栏跟着整块一起被撑长：任务一多，`.cal-body` 那一行就由它决定高度，
 *      整页跟着往下长，日历底下的「各模块」也被推得很远。
 *      ⚠️ 高度只能**量**、不能算：日历格子是 `.cal-cell { min-height: 96px }`（由内容撑），
 *      某天事件多就会更高 —— CSS 里没有可依赖的确定值，写死 `calc(100vh - N)` 必然漂。
 *      ⚠️ 写的是 `max-height` 而**不是** `height`：任务少的那天不该被硬撑成日历那么高。
 *      ⚠️ 窄窗（≤1080px）是**单列**布局（右栏落到日历下方）⇒ 那时**不锁**（撤掉内联值）。
 *      ⚠️ 观察的是 `.cal-main`、改的是 `.cal-side` —— 不是同一个元素，不会自己触发自己。
 * @returns {void}
 */
function syncSideHeight() {
  const main = q('.cal-main');
  const side = q('.cal-side');
  if (!main || !side) return;
  /** 功能：按**当前**节点量一次并写 `max-height`（回调里也用它 —— 节点会被重画换掉，⛔ 别闭包旧引用）。 */
  const apply = () => {
    const el = q('.cal-main');
    const sd = q('.cal-side');
    if (!el || !sd) return;
    // 单列布局：右栏本来就不该和日历挤在一起（见 app.css 那条 @media）
    if (window.matchMedia('(max-width: 1080px)').matches) {
      sd.style.removeProperty('max-height');
      return;
    }
    const h = Math.round(el.getBoundingClientRect().height);
    if (h > 0) sd.style.maxHeight = `${h}px`;
    else sd.style.removeProperty('max-height');
  };
  apply();
  if (sideRo) sideRo.disconnect();
  if (typeof ResizeObserver === 'function') {
    sideRo = new ResizeObserver(apply);
    sideRo.observe(main);
  }
}

/**
 * 功能：把这一屏整个画出来（页头 + 正文）—— ⭐ 0.7.8 起按 `state.calTab` 分**两个视图**。
 *
 * 说明：⚠️ 只在「换月 / 换图层 / 事件有增删改 / 切视图 / 存了人生日历的设置」之后调它。
 *      **点某天不调它** —— 那是「只选中、不换屏」，走 `paintSelection()` 就地改 class 与列表。
 *      ⚠️⭐ **两个视图共用同一份 `state.cal`，谁也不重新取数**（方案 §7）：切来切去不该转圈。
 *
 * @returns {void}
 */
function renderCalendar() {
  const box = rootEl;
  const cal = state.cal;
  if (!box || !cal) return;

  // ⭐ 0.8.9：「人生日历」已整体搬进行程 ⇒ 这里**只剩月视图**一个形态。
  //    从前那一支 `state.calTab === 'life'`（画人生日历那一屏）连同页头那两颗切换按钮一起撤了。

  // ---- 月视图（0.7.5 起）----
  const evMap = expandEvents(cal.events, cal.from, cal.to);
  const courseMap = groupByDate(cal.layers.course.items, 'date');
  const taskMap = groupByDate(cal.layers.task.items, 'date');
  const holMap = groupByDate(cal.layers.holiday.items, 'date');
  // ⭐ 0.8.3 记账图层：服务端只给**有记账条目**的那几天 ⇒ 这一格按「有没有键」判标记
  const ledgerMap = groupByDate(cal.layers.ledger.items, 'date');

  const cells = [];
  for (let d = cal.from; d <= cal.to; d = addDays(d, 1)) {
    cells.push(
      cellHtml(d, cal, evMap.get(d) || [], courseMap.has(d), taskMap.has(d), holMap, ledgerMap.get(d)),
    );
  }

  box.innerHTML = `
    <div class="cal-wrap">
      <header class="cal-head">${headHtml(cal)}</header>
      <div class="cal-body">
        <div class="cal-left">
          <div class="cal-main">
            <div class="cal-dow">${DOW_CN.map((w) => `<span>${w}</span>`).join('')}</div>
            <div class="cal-grid" id="cal-grid">${cells.join('')}</div>
            <p class="cal-legend">${esc(legendText(cal))}</p>
          </div>
        </div>
        <aside class="cal-side">
          <h3 class="cal-daytitle" id="cal-daytitle"></h3>
          <div class="cal-daylist" id="cal-daylist"></div>
        </aside>
      </div>
    </div>`;
  paintSelection();
  applyLayerVis();
  // ⭐ 0.8.9：当天列表里的课程条 —— 先跑一拍（首屏就带倒计时 / 灰态），再挂上每分钟一拍。
  //    ⚠️ 换屏由 `showView()` 收定时器（与看板同一条口径）；「月视图 ⇄ 人生日历」是**同一屏内**
  //    的切换 ⇒ 上面那一支直接 return，定时器由 `calLiveTick()` 自己按 `state.calTab` 短路。
  calLiveTick();
  ttTicker(true, calLiveTick);

  // ⭐ 0.8.9：「其它」搬到日历这一列的下方。
  //    ⚠️⭐ 搬进的是 `.cal-left`（左列**自己那一层**），**不是** `.cal-body`：
  //    `.cal-body` 是两列 grid，第一行的高度由**更高的那一格**决定 —— 右边那栏
  //    （`.cal-side`，当天任务）常常比日历长得多 ⇒ 左列日历下方会被撑出一大块空白，
  //    「其它」被推到很下面（「空的间隙怎么越来越大了」，就是这个）。
  //    `.cal-left` 是左列的 flex 竖排 ⇒ 它紧贴日历底部。
  //    ⚠️ 必须放在最后：上面那次 `box.innerHTML = ...` 会把上一次搬进来的节点销毁。
  if (belowEl) {
    const colBox = q('.cal-left');
    if (colBox) colBox.appendChild(belowEl);
  }
  // ⭐ 0.8.61：右栏锁到日历高度（必须在 `belowEl` 搬完之后量 —— 那一步会改左列高度，
  //    而右栏要对齐的是**日历卡片**、不是左列，所以顺序其实不影响结果，只是省一次重排）。
  syncSideHeight();
}

/**
 * 功能：画页头 —— 月份导航四件 ＋ 四颗图层开关 ＋ 「新建事件」。
 *
 * 说明：⭐ 0.8.9：「人生日历」整体搬进行程 ⇒ 页头那两颗切换按钮
 *      （`日历 ｜ 人生日历`）**一并撤掉** —— 只剩一个形态时，一条切换控件是纯噪音
 *      （与看板那条胶囊「只有一种视图就整条不画」同一条口径）。
 *      ⚠️ `state.calTab` 那个字段与 `paintSelection()` 里 `state.calTab !== 'month'` 那句
 *      **保留不动**（它恒为 `'month'`，判据照旧放行）—— 撤字段要动两端 state.js 与若干处判据，
 *      与本次目标无关，⛔ 不顺手做。
 *
 * @param {Object} cal - `GET /api/calendar` 的响应
 * @returns {string} 页头的 HTML
 */
function headHtml(cal) {
  return `
        <div class="cal-nav">
          <button type="button" class="btn-subtle" data-cal="prev" aria-label="上一个月">‹</button>
          <strong class="cal-month" id="cal-month">${esc(monthTitle(state.calMonth))}</strong>
          <button type="button" class="btn-subtle" data-cal="next" aria-label="下一个月">›</button>
          <button type="button" class="btn-subtle" data-cal="today">回到本月</button>
        </div>
        <div class="cal-layers" id="cal-layers">${layersHtml(cal)}</div>
        <button type="button" class="btn btn-primary" data-cal="new">新建事件</button>`;
}

// ⭐ 0.8.9：`lifeScreenHtml()` 与 `saidText()` **已随「人生日历」搬进行程** ——
//    它们现在住 `modules/trip/desktop.js`（形态从「日历屏的第二个视图」改成「行程屏里那颗按钮的弹层」）。
//    ⛔ 别在这里留一句「临时删掉」之类的注释再往后抄一遍：口径只有一份（`modules/trip/life.js`）。

/**
 * 功能：把四个图层开关画出来（不可用的那层置灰 + 把人话挂在 `title` 上）。
 * @param {Object} cal - `GET /api/calendar` 的响应
 * @returns {string} 开关的 HTML
 */
function layersHtml(cal) {
  return LAYERS.map((L) => {
    const l = cal.layers[L.kind] || { on: false, available: false, note: '' };
    const on = !!l.on;
    const dis = !l.available;
    const tip = dis ? l.note || '这一层现在用不了' : '';
    return `<label class="cal-sw${dis ? ' off' : ''}${on ? ' on' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>
      <input type="checkbox" data-cal-layer="${L.key}"${on ? ' checked' : ''}${dis ? ' disabled' : ''} />
      <span>${esc(L.label)}</span>
    </label>`;
  }).join('');
}

/**
 * 功能：页脚那句「这一屏现在是什么状态」的人话。
 *
 * 说明：⭐ 图层不可用时**必须说出来是哪一种**（模块不在 / 课表被关掉 / 没有学期 / 该年假期没收录）——
 *      ⛔ 不许用「空白」冒充「这段时间真的没课」，那两件事对用户完全不同。
 *
 * @param {Object} cal - `GET /api/calendar` 的响应
 * @returns {string} 人话（每段一行，用 ｜ 分隔）
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
 * 功能：画一个格子。
 *
 * 说明：⚠️ 格子是 `<div>` 而不是 `<button>`：格子里还要放可点的事件条，按钮里套按钮是非法 HTML。
 *      键盘可达性靠 `tabindex="0"` + `bindCalendarEvents()` 里的 Enter / Space 处理。
 *
 * @param {string} d - 这一天
 * @param {Object} cal - 响应
 * @param {Array.<Object>} evs - 这一天的自己的事件
 * @param {boolean} hasCourse - 这一天有没有课
 * @param {boolean} hasTask - 这一天有没有任务到期
 * @param {Map.<string, Array.<Object>>} holMap - 假期图层按日聚好的表
 * @param {?Array.<Object>} ledgerRows - 这一天的记账小计（服务端只给有记账条目的那些天；没有则 undefined）
 * @returns {string} 格子的 HTML
 */
function cellHtml(d, cal, evs, hasCourse, hasTask, holMap, ledgerRows) {
  const hol = holidayKindOf(holMap, d);
  const cls = ['cal-cell'];
  const sameMonth = d.slice(0, 7) === state.calMonth;
  if (!sameMonth) cls.push('other');
  if (isWeekend(d)) cls.push('weekend');
  // ⭐ 0.8.5：本月**已经过去**的日子 —— 与手机端**同一口径、同一判据**
  //    （「本月过去的天应该和未来有区分」；说明见 `mobile.js` 同款注释）。
  if (sameMonth && d < cal.today) cls.push('past');
  if (d === cal.today) cls.push('today');
  if (d === state.calDay) cls.push('sel');
  if (hol) cls.push(hol);

  // ⭐ 四个图层在格子里各是一种表达（方案 §4.3）：课表 = 小圆点、任务截止 = 小方块、
  //    假期 = **底色**、**记账 = 小圆点 + 当天的支出合计**（0.8.3）。
  //    ⛔ 假期不再多画一个点：同一天既是假期又有课的格子会糊成一团。
  const marks = [];
  if (hasCourse) marks.push('<i class="cal-dot" title="这天有课"></i>');
  if (hasTask) marks.push('<i class="cal-sq" title="这天有任务到期"></i>');
  if (ledgerRows && ledgerRows.length) {
    // ⚠️ 服务端**只给真有记账条目的那些天**（没记账的日子没有键）⇒ 走到这里就是「这天有账」。
    //    ⛔ 别把 `0.00` 当成「没记过账」：金额 0 也是一笔账（支出 0 元），两件事分得开。
    const spent = layerAmountText(ledgerRows[0].expense_fen);
    const lgTip = `这天有记账 · 支出合计 ${spent}`;
    marks.push(`<span class="cal-lg" title="${esc(lgTip)}">${esc(spent)}</span>`);
  }

  const shown = evs.slice(0, CELL_MAX);
  const chips = shown
    .map(
      (e) =>
        `<button type="button" class="cal-ev${e.all_day ? ' allday' : ''}" data-cal-ev="${Number(e.id)}" title="${esc(
          eventWhenText(e),
        )}">${esc(e.title)}</button>`,
    )
    .join('');
  const more = evs.length > CELL_MAX ? `<span class="cal-more">+${evs.length - CELL_MAX}</span>` : '';
  // ⭐ 0.7.6：格子里那一句农历 / 节日 —— 优先级在 `lunar.js` 的 `gridLunarText()` 里**只定一份**
  //    （节日名 > 初一显示月名 > 农历日）。⚠️ 表外年份它返回空串 ⇒ 那一行留空，⛔ 不显示假数据。
  const lunar = gridLunarText(d);
  const label =
    dayLabel(d) +
    (lunar ? ` · ${lunar}` : '') +
    (hol === 'rest' ? ' · 法定放假日' : hol === 'work' ? ' · 调休上班日' : '');

  // ⚠️「休 / 班」角标放在**行内**（`cal-num` 之后）而不是绝对定位到右上角：
  //    那一角已经被 `cal-marks`（课 / 任务的小点）占着了，叠上去会互相盖。
  const badge = hol ? `<span class="cal-holbadge ${hol}">${hol === 'rest' ? '休' : '班'}</span>` : '';
  // ⭐ 0.8.7 修订（「一个日期格子你给我搞出 4 种显示，能不能农历、节假日、
  //    休/班、圆点、记账给我固定位置显示，统一整齐一些」）：
  //    格子内部是**四行固定槽**（版式见 `app.css` 的 `.cal-top` 说明）——
  //    ① `cal-top`：日期 + 休/班角标 ② `cal-lunar`：农历 / 节日名 ③ `cal-marks`：图层标记
  //    ④ `cal-evs`：自己的事件。
  //    ⚠️⭐ 后三行**没有内容也照样输出空标签** —— 「固定位置」靠的就是这个占位；
  //    ⛔ 别在这里加 `lunar ? ...: ''` 这类条件（一加就退回「三种长相」）。
  return `<div class="${cls.join(' ')}" data-cal-day="${d}" tabindex="0" role="button" aria-label="${esc(label)}">
    <span class="cal-top"><span class="cal-num">${Number(d.slice(8))}</span>${badge}</span>
    <span class="cal-lunar">${esc(lunar)}</span>
    <span class="cal-marks">${marks.join('')}</span>
    <span class="cal-evs">${chips}${more}</span>
  </div>`;
}

/**
 * 功能：**只就地改选中态与当天列表**（不整屏重画、不重新取数）—— 点某天走的就是这里。
 *
 * 说明：⭐ 点日期只**选中**、**不换屏**（`state.view` 一个字都不能变）。
 *      与 同源：能就地改 class 就别整块重画 —— 重画会把滚动位置和焦点一起丢掉。
 *
 * @returns {void}
 */
function paintSelection() {
  const box = rootEl;
  if (!box) return;
  for (const cell of box.querySelectorAll('.cal-cell')) {
    cell.classList.toggle('sel', cell.getAttribute('data-cal-day') === state.calDay);
  }
  const title = q('#cal-daytitle');
  if (title) title.textContent = state.calDay ? dayLabel(state.calDay) : '';
  const list = q('#cal-daylist');
  if (list) {
    list.innerHTML = sideHtml();
    // ⭐ 0.8.61：右栏现在是**自己滚的**（`syncSideHeight()` 锁高）⇒ 换一天要回到顶部 ——
    //    不然从「20 条任务的那天」切到「3 条的那天」，新列表会停在中段（看着像缺了前几条）。
    list.scrollTop = 0;
  }
  // ⭐ 0.8.9：当天列表刚被整块换掉 ⇒ 倒计时立刻补一拍（否则要等下一次整分才显示）。
  calLiveTick();
}

/**
 * 功能：读「这个图层现在开着吗」—— ⭐ **唯一判据是 `state.cal.prefs`**（不是 `layers[k].on`）。
 *
 * 说明：⚠️ 两个字段看着一样，其实不同：`layers[k].on` 是**服务端那一刻的想法**，
 *      而 `prefs` 是本地可以**先改一步**的那份（关掉一个图层时先就地隐藏、再异步存下去）。
 *      读两处迟早会出现「界面上关了、另一个地方还当它开着」。
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
 * 功能：按当前开关**就地**给整块加 / 撤 `lay-on-<kind>` 四个 class（不重画任何结构）。
 *
 * 说明：⭐ 关掉一个图层**不需要重新取数**：服务端下一次响应里才会不带它（方案 §九 用例 11），
 *      而「现在这一刻让它在界面上消失」纯粹是加一个 class 的事（能就地改 class 就别整屏重画）。
 *      ⛔ 反过来，**打开**一个图层必须重取 —— 它的数据当前手里没有（这正是用例 11 要的形状）。
 *
 * @returns {void}
 */
function applyLayerVis() {
  const wrap = q('.cal-wrap');
  if (!wrap) return;
  for (const L of LAYERS) wrap.classList.toggle('lay-on-' + L.kind, layerOn(L.kind));
}

/**
 * 功能：当天列表的一拍 —— 给课程行填倒计时（只给**今天**那批）、并按各条自己的日期打上
 *      `done` 类（上过的课变灰）；**绝不重画这一屏**。
 *
 * 说明：⭐ 0.8.9（「日历视图的课程条也要像列表的一样有倒计时、上完变灰色、
 *      点击进入课程视图」）：判定与文案**全部**来自 `core/timetable.js`（唯一一份），
 *      与看板的 `dashLiveTick()` 是同一套纯函数（⛔ 不在这里另写一遍比较）。
 *      ⚠️ 时间权威源是服务端：`state.cal.now`（`GET /api/calendar` 搭车带回）⇒ `ttSyncServerNow()`。
 *      服务端没给 `now`（老响应 / 降级）时它就是本机时钟 —— 降级方向是「照常显示」。
 *      ⚠️ 只翻**当前选中那天**的那些行（`#cal-daylist` 里只有那一天的内容）。
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
    // 形状就是 `ttLessonState()` / `ttTodayNow()` 要的那三样（`spans` 只有小课间文案用，这里不需要）
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
    const row = live.closest('.cal-row');
    if (row) row.classList.toggle('done', !!r && r.doneIds.has(key));
    live.textContent = (r && r.byId && r.byId.get(key)) || '';
  });
}

/**
 * 功能：画「当天列表」—— 自己的事件（可点开改）+ 四个图层那天的内容（只读）。
 * @returns {string} 列表的 HTML
 */
function sideHtml() {
  const cal = state.cal;
  const d = state.calDay;
  if (!cal || !d) return '';
  const evs = (cal.events || []).filter((e) => {
    const s = String(e.date || '');
    const t = String(e.end_date || '') || s;
    return s && s <= d && t >= d;
  });
  const courses = (cal.layers.course.items || []).filter((c) => c.date === d);
  // ⭐ 0.8.9 修订：「显示为今天截止的任务和今天完成的任务 —— 那种长时间的
  //    任务截止日期是 30 号、但是在 28 完成的了就不要在 30 号显示了」。
  //    ⇒ 判据与看板列表视图**同一条**（`core/dashboard.js` 的 `visEnd()` / `doneInfo()`）：
  //    · 没完成的：看**截止日**是不是这一天；
  //    · 已完成的：看**完成日**是不是这一天（`done_date` 由服务端算好，老数据回落截止日）。
  //    ⚠️ 从前只判 `t.date === d` ⇒ 一条 9/28 就做完的、截止 9/30 的任务**在 9/30 还挂着**
  //    （正是这一条），而且不报错。
  // ⭐ 0.8.9 修订：这一块**按下面那四组分**（已逾期 / 今日截止 / 今日可做 /
  //    明日截止），所以这里先留**全量**，分组的判据只写在下面那一处。
  const taskRows = cal.layers.task.items || [];
  const hols = (cal.layers.holiday.items || []).filter((h) => h.date === d);
  // ⭐ 0.8.3 记账图层：这一天的小计（服务端只给有记账条目的那些天 ⇒ 空数组 = 这天没记过账）
  const ledger = (cal.layers.ledger.items || []).filter((x) => x.date === d);

  const blocks = [];

  blocks.push(
    `<section class="cal-blk k-event"><h4>我的事件 <span class="cal-n">${evs.length}</span></h4>${
      evs.length
        ? evs.map(evRowHtml).join('')
        : '<p class="cal-hint">这一天还没有自己的事件。</p>'
    }</section>`,
  );

  if (layerOn('course')) {
    blocks.push(
      `<section class="cal-blk ro k-course"><h4>课程 <span class="cal-n">${courses.length}</span></h4>${
        courses.length
          ? courses
              .map((c) => {
                // ⭐ 0.8.9：这一条有个稳定的键 —— 倒计时的定时器靠它把「DOM 上那一行」与
                //    「数据里那一节」对上（`data-cal-live` 与 `data-cal-course` 同一个值）。
                const key = calCourseKey(c);
                // ⭐ 0.8.9：这一句与看板列表视图**逐字相同**（`courseWhenText()`）——
                //    ⛔ 别再在这里拼「起–止 · 教室」，那正是「两处时间不一样」。
                return `<div class="cal-row ro cal-course" data-cal-course="${esc(key)}" tabindex="0"><b>${esc(
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
          : '<p class="cal-hint">这天没有课。</p>'
      }</section>`,
    );
  }

  if (layerOn('task')) {
    // ⭐ 0.8.9 修订：原来单块的「任务截止」**拆成四组**，顺序固定为
    //    已逾期 → 今日截止 → 今日可做 → 明日截止（就是这个顺序）。
    //    口径（当日拍定）：
    //    · **已逾期**：没做完，且截止日**早于**选中日；
    //    · **今日截止**：截止日正是选中日（已完成的也算；另含「完成日 = 选中日」的那些）；
    //    · **今日可做**：没做完，且截止日**晚于**选中日 —— ⚠️ 与「明日截止」**允许重复**
    //      （选了「没做完且截止日未到全算」这一条）；
    //    · **明日截止**：截止日 = 选中日 ＋ 1 天。
    //    ⚠️⭐ **空组不画**：四组各写一句「没有」，侧栏会变成一列空话（而且它本来就窄）；
    //    四组全空时才回落到原来那一句。
    const tomorrow = addDays(d, 1);
    // ⚠️ 每组的**组内顺序** = 四象限的优先级（给定，见 `QUAD_RANK`）：
    //    重要且紧急 → 紧急 → 重要 → 不重要不紧急。`filter()` 已经返回新数组 ⇒ 就地 sort 安全。
    const taskGroups = [
      { key: '', label: '已逾期', list: taskRows.filter((t) => !t.done && t.date && t.date < d) },
      { key: '', label: '今日截止', list: taskRows.filter((t) => (t.done ? t.done_date === d : t.date === d)) },
      { key: 'doing', label: '今日可做', list: taskRows.filter((t) => !t.done && t.date && t.date > d) },
      { key: 'tomorrow', label: '明日截止', list: taskRows.filter((t) => t.date === tomorrow) },
    ];
    taskGroups.forEach((g) => g.list.sort(byQuadRank));
    const total = taskGroups.reduce((n, g) => n + g.list.length, 0);
    if (!total) {
      blocks.push(
        '<section class="cal-blk ro k-task"><h4>任务 <span class="cal-n">0</span></h4>' +
          '<p class="cal-hint">这天没有任务到期。</p></section>',
      );
    } else {
      taskGroups.forEach((g) => {
        if (!g.list.length) return;
        // ⭐ 0.8.9：「今日可做、明日截止默认折叠，点击可展开和收起」——
        //    只有带 `key` 的那两组可折叠（`is-fold` 由 CSS 把下面的行藏起来）。
        //    ⚠️ 折叠状态住 `state.calFold`（点了别丢：切日期会整块重画侧栏）。
        const folded = !!g.key && !(state.calFold && state.calFold[g.key]);
        const head = g.key
          ? `<h4 class="cal-fold" data-cal-fold="${g.key}">`
          : '<h4>';
        blocks.push(
          `<section class="cal-blk ro k-task${folded ? ' is-fold' : ''}">` +
            `${head}${g.label} <span class="cal-n">${g.list.length}</span>` +
            `${g.key ? '<i class="cal-caret" aria-hidden="true"></i>' : ''}</h4>` +
            `${g.list.map(calTaskRow).join('')}</section>`,
        );
      });
    }
  }

  if (layerOn('holiday') && hols.length) {
    blocks.push(
      `<section class="cal-blk ro k-holiday"><h4>假期</h4>${hols
        .map(
          (h) =>
            `<div class="cal-row ro"><b>${h.kind === 'rest' ? '法定放假日' : '调休上班日'}</b><em>${
              h.kind === 'rest' ? '休息' : '要上班'
            }</em></div>`,
        )
        .join('')}</section>`,
    );
  }

  // ⭐ 0.8.3 记账图层：这一天记了什么账 —— 收入 / 支出两个合计（只读、不可点）。
  //    ⚠️ 与假期那块同款：**没记过账就不出这一块**（⛔ 不写一句「这天没记账」——
  //    四层里只有它是「没有就没有」的，画一句空话反而让人以为漏了数据）。
  if (layerOn('ledger') && ledger.length) {
    const s = ledger[0];
    blocks.push(
      `<section class="cal-blk ro k-ledger"><h4>记账</h4>
        <div class="cal-row ro"><b>支出合计</b><em>${esc(layerAmountText(s.expense_fen))}</em></div>
        <div class="cal-row ro"><b>收入合计</b><em>${esc(layerAmountText(s.income_fen))}</em></div>
      </section>`,
    );
  }

  return blocks.join('');
}

/**
 * 功能：画「我的事件」里的一行（整行可点 → 打开编辑表单）。
 * @param {Object} e - 事件
 * @returns {string} 行的 HTML
 */
function evRowHtml(e) {
  return `<button type="button" class="cal-row" data-cal-ev="${Number(e.id)}">
    <b>${esc(e.title)}</b><em>${esc(eventWhenText(e))}</em></button>`;
}

/**
 * 功能：画「当天列表」里的一条任务行 —— 上面那四个分组（已逾期 / 今日截止 / 今日可做 / 明日截止）
 *      **共用这一份**，⛔ 别在每组里各写一遍（改一处必然漏另一处）。
 *
 * 说明：⭐ 0.8.9 修订：**去掉两枚象限徽章**（见 `quadKeyOf`），
 *      行回到「标题 ＋ 右侧归属」两件式 —— 标题因此能占满整行（原来被徽章挤掉一半）。
 *      ⚠️ 行上的 `data-cal-task`（任务 id）与 `data-cal-src`（作用域）是**给宿主的**：
 *      点击由 `desktop/views/home.js` 外接成 `zx:open-task`（跨模块不许 import 任务模块的实现，
 *      见 `docs/公共/架构文档/20-模块联动.md` 的联动宪法 ②）。⛔ 删掉这两个属性 = 「点了没反应」。
 *
 * @param {Object} t - 任务图层里的一条（`id` / `title` / `date` / `done` / `done_date` / `project` / `source` / `important` / `urgent`）
 * @returns {string} 这一行的 HTML（文本一律经 `esc()`）
 */
function calTaskRow(t) {
  return `<div class="cal-row ro cal-task${t.done ? ' done' : ''}" data-q="${quadKeyOf(
    t,
  )}" tabindex="0" data-cal-task="${Number(t.id)}" data-cal-src="${esc(t.source || '')}"><b>${esc(
    t.title,
  )}</b><em>${esc(t.project)}${t.done ? ' · 已完成' : ''}</em></div>`;
}

// ---------- 新建 / 编辑 / 删除 ----------

/**
 * 功能：打开「新建事件」表单（默认落在当前选中的那一天）。
 * @returns {void}
 */
function newCalendarEvent() {
  openEventForm(null);
}

// ⭐ 0.8.9：`openLifeForm()` **已随「人生日历」搬进行程** ——
//    它现在住 `modules/trip/desktop.js` 的 `openLifePanel()`（形态改成行程屏那颗按钮的弹层），
//    落库也改成 `PUT /api/trip/life`。⛔ 别在这里留一份「旧版备份」。

/**
 * 功能：打开某个事件的新建 / 编辑表单（`ev = null` 时是新建）。
 *
 * 说明：⚠️ 设成「全天」时**必须同时把两个时刻清掉**再提交：后端会把「全天却带着时刻」
 *      直接打回 400（方案 §4.1 的第一条硬约束），不清就会变成一个填完保存不了的框。
 *
 * @param {?Object} ev - 要改的事件；新建传 null
 * @returns {void}
 */
function openEventForm(ev) {
  const isNew = !ev;
  const base = ev || {
    title: '',
    date: state.calDay || todayStr(),
    end_date: '',
    all_day: false,
    start_time: '',
    end_time: '',
    note: '',
  };
  openModal(
    isNew ? '新建事件' : '改这条事件',
    // ⚠️⭐ 0.7.6：这里原来用的是 `.fld` —— 而 `.fld` 在**电脑端** `app.css` 里根本没有定义
    //    （只有手机端那份有）⇒ 整个表单拿不到任何样式，看起来就是「一堆浏览器默认控件」。
    //    改用任务表单那套**有定义**的 `.tt-field`（`desktop/app.css` 的「任务表单」段）。
    //    字段按语义分组：标题 → 日期（+ 跨天的结束日期）→ 全天 → 时刻 → 备注 →（编辑时）删除。
    `<div class="tt-field"><label for="cal-f-title">标题</label>
       <input id="cal-f-title" type="text" maxlength="${TITLE_MAX}" placeholder="如：体检 / 交报告 / 出差" value="${esc(
         base.title,
       )}" /></div>
     <div class="cal-f2">
       <div class="tt-field"><label for="cal-f-date">日期</label><input id="cal-f-date" type="date" value="${esc(
         base.date,
       )}" /></div>
       <div class="tt-field"><label for="cal-f-end">结束日期（跨天时填）</label><input id="cal-f-end" type="date" value="${esc(
         base.end_date,
       )}" /></div>
     </div>
     <div class="cal-cbrow"><label class="cal-cb"><input id="cal-f-allday" type="checkbox"${
       base.all_day ? ' checked' : ''
     } /> <span>全天（不填具体时刻）</span></label></div>
     <div class="cal-f2" id="cal-f-time-wrap">
       <div class="tt-field"><label for="cal-f-start">开始时刻</label><input id="cal-f-start" type="time" value="${esc(
         base.start_time,
       )}" /></div>
       <div class="tt-field"><label for="cal-f-endt">结束时刻</label><input id="cal-f-endt" type="time" value="${esc(
         base.end_time,
       )}" /></div>
     </div>
     <div class="tt-field"><label for="cal-f-note">备注（可以空着）</label>
       <textarea id="cal-f-note" rows="3" maxlength="${NOTE_MAX}" placeholder="想记的细节">${esc(base.note)}</textarea></div>
     ${
       isNew ? '' : '<div class="cal-delrow"><button type="button" class="btn-subtle" id="cal-f-del">删掉这条事件</button></div>'
     }`,
  );
  setModalSave(isNew ? '记下来（Enter）' : '保存（Enter）', false);

  /**
   * 功能：全天勾上时把两个时刻框禁掉，并**把整组淡掉**让这条联动看得出来
   *      （清空动作留到保存时一起做）。
   * 说明：⭐ 0.7.6：原来只把两个输入框置灰 —— 现在连 label 一起淡（`.off`），
   *      「全天就不用填时刻」一眼就能看出来，不必去读说明文字。
   * @returns {void}
   */
  const syncAllDay = () => {
    const on = $('#cal-f-allday').checked;
    $('#cal-f-start').disabled = on;
    $('#cal-f-endt').disabled = on;
    const wrap = $('#cal-f-time-wrap');
    if (wrap) wrap.classList.toggle('off', on);
  };
  $('#cal-f-allday').onchange = syncAllDay;
  syncAllDay();

  if (!isNew) {
    $('#cal-f-del').onclick = () => {
      openConfirmModal(
        '删掉这条事件',
        `<p>「${esc(ev.title)}」会被删掉，删了就找不回来了。</p>`,
        '永久删除',
        async () => {
          await api('DELETE', `/api/calendar/${Number(ev.id)}`);
          closeModal();
          await loadCalendar();
          toast('删掉了');
        },
      );
    };
  }

  $('#modal-save').onclick = async () => {
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
      // ⚠️ 全天时**显式送空串**：后端认「空 = 清掉」，不送就会留下上一次的时刻而被 400 打回
      start_time: allDay ? '' : $('#cal-f-start').value,
      end_time: allDay ? '' : $('#cal-f-endt').value,
      note: $('#cal-f-note').value.trim(),
    };
    try {
      if (isNew) await api('POST', '/api/calendar', body);
      else await api('PUT', `/api/calendar/${Number(ev.id)}`, body);
      closeModal();
      // ⚠️ 保存之后要**重取**（不是只重画）：这条事件可能落在别的月份里，
      //    而「同一个月里它属不属于当前网格」只有服务端说了算。
      await loadCalendar();
      state.calDay = body.date;
      paintSelection();
      toast(isNew ? '记下了' : '改好了');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

// ---------- 事件委托（挂一次） ----------

/**
 * 功能：给**这一次挂载的根节点**挂一次事件委托 —— 换月 / 回到本月 / 新建 / 点某天 / 点事件 / 切图层。
 *
 * 说明：⚠️ 视图每次重画都会换掉里头的 DOM，所以只能在**不换的祖先**（宿主给的那个根节点）上委托；
 *      ⛔ 绝不在渲染函数里逐个 `addEventListener`（那必然漏，而且会重复叠加）。
 *      ⚠️⭐ 0.8.7：根节点**每次挂载都是新的**（看板重画会重建它），所以要**每次挂载绑一次**；
 *      幂等守卫放在节点自己身上（同一个节点被绑两次才会出问题，而那正是要防的）。
 *      ⛔ 别再把判据写成 `$('#calendar-view')` —— 日历已经没有固定的屏容器了。
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
    //    只切一个 class，⛔ **不整块重画**（重画会把侧栏的滚动位置打回顶上，而这里没必要）。
    //    ⚠️ 状态住 `state.calFold`：切日期会重画侧栏，状态丢了的话「展开」就白点了。
    const foldHead = e.target.closest('[data-cal-fold]');
    if (foldHead) {
      const key = foldHead.getAttribute('data-cal-fold') || '';
      state.calFold = state.calFold || {};
      state.calFold[key] = !state.calFold[key];
      const sec = foldHead.closest('.cal-blk');
      if (sec) sec.classList.toggle('is-fold', !state.calFold[key]);
      return;
    }
    // ⓪-0 ⭐ 0.8.9：「点击任务要弹出详情」—— 当天列表里的**任务行**
    //    带 `data-cal-task`（id）与 `data-cal-src`（作用域）。这里**只把数据派出去**
    //    （留白事件 `zx:open-task`），开哪个弹窗由宿主决定 —— 联动宪法 ② 明令
    //    ⛔ 跨模块 import 别人的实现（删/改任务板时会静默炸整屏）。
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
      return;
    }
    // ⓪ ⭐ 0.8.9：当天列表里的**课程条**点一下 → 去课表（与看板上那批课程行走的**同一扇门**：
    //    侧栏那颗入口。⛔ 不在这里直接 import 课表模块 —— 那是别的模块的实现，删目录验收会挂）。
    const courseRow = e.target.closest('[data-cal-course]');
    if (courseRow) {
      const btn = document.getElementById('btn-timetable');
      if (btn) btn.click();
      return;
    }
    // ① 事件条 / 当天列表里的行 → 打开编辑表单（⚠️ 必须排在最前：它们在格子里面）
    const evBtn = e.target.closest('[data-cal-ev]');
    if (evBtn) {
      const ev = (state.cal && state.cal.events ? state.cal.events : []).find(
        (x) => Number(x.id) === Number(evBtn.getAttribute('data-cal-ev')),
      );
      if (ev) openEventForm(ev);
      return;
    }
    // ② 页头那几颗
    const act = e.target.closest('[data-cal]');
    if (act) {
      const what = act.getAttribute('data-cal');
      if (what === 'new') return newCalendarEvent();
      // ⭐ 0.8.9：「`tab-month` / `tab-life` / `life-set`」这三条**已随
      //    「人生日历」搬走** —— 日历屏只剩月视图，页头那两颗切换按钮也撤了 ⇒ 不再有切视图那一支。
      if (what === 'prev') state.calMonth = shiftYm(state.calMonth, -1);
      else if (what === 'next') state.calMonth = shiftYm(state.calMonth, 1);
      else if (what === 'today') state.calMonth = ymOf((state.cal && state.cal.today) || todayStr());
      state.calDay = '';
      loadCalendar().catch((err) => toast(err.message, true));
      return;
    }
    // ③ 点某天 → **只选中、不换屏**
    const cell = e.target.closest('[data-cal-day]');
    if (cell) {
      state.calDay = cell.getAttribute('data-cal-day');
      paintSelection();
    }
  });

  // 键盘：格子是 div + tabindex，Enter / Space 等同于点它
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest && e.target.closest('[data-cal-day]');
    if (!cell) return;
    e.preventDefault();
    state.calDay = cell.getAttribute('data-cal-day');
    paintSelection();
  });

  // 四个图层开关 —— ⭐ **逐键**保存（带哪个键写哪个键），照 `PUT /api/auth/prefs` 的惯例。
  //    ⚠️ 两个方向**不是一回事**，这是刻意的（方案 §9.1 的探针就在测这一条）：
  //    · **关掉**：数据不用动（下一次响应里才不带它）⇒ 先就地撤 class 让它立刻消失，
  //      再异步把开关存下去。**不发第二次取数请求、不重画整表**。
  //    · **打开**：那一层的数据**当前手里没有**（服务端对关掉的层返回空条目，见用例 11）
  //      ⇒ 只能重取一次。
  box.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-cal-layer]');
    if (!cb) return;
    const key = cb.getAttribute('data-cal-layer');
    const on = !!cb.checked;
    const body = {};
    body[key] = on;
    // 乐观：先把本地开关改掉并就地生效（用户点下去的那一刻就该看到变化）
    const before = Number(((state.cal && state.cal.prefs) || {})[key]) ? 1 : 0;
    if (state.cal && state.cal.prefs) state.cal.prefs[key] = on ? 1 : 0;
    applyLayerVis();
    paintSelection();
    api('PUT', '/api/calendar/layers', body)
      .then(() => (on ? loadCalendar() : null))
      .catch((err) => {
        toast(err.message, true);
        // 存失败就把界面拨回真实状态，⛔ 别让勾选停在「看起来生效了」的样子
        if (state.cal && state.cal.prefs) state.cal.prefs[key] = before;
        applyLayerVis();
        paintSelection();
        return loadCalendar();
      });
  });
}
