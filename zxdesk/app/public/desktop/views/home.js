/**
 * desktop/views/home.js —— 首页看板
 *
 * 功能：首页「看板」的取数与渲染。`dashRange()` 把四档预设（今日 / 单日 / 本周 / 本月）折成日期区间；
 * `openHome()` 切到首页视图并触发加载；`loadHome()` 请求 `GET /api/dashboard` 后重画看板，
 * 并顺手刷新侧栏的今日待办数；`renderHome()` 画出**当前视图**：
 * 看板自己的**列表视图**（默认）：任务概览、这段时间要做的事、网址收藏夹与消息概况…
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
import {
  DASH_FILTERS,
  DASH_PRESETS,
  dashBrief,
  dashDefaultViewName,
  dashEntries,
  dashFilter,
  dashGroups,
  dashRange,
  dashRangeLabel,
  dashSearch,
  dashStats,
  dashTaskTiers,
  dashViewDefs,
  dashWeekCells,
} from '../../core/dashboard.js';
import { addDays, fmtDate, mondayOf, todayStr, weekName } from '../../core/date.js';
import { $, esc, fitTabs, skeletonHtml } from '../../core/dom.js';
// 薄入动画的判据只此一份 —— `swapAnimOnce()` 只负责判「是不是真的换了视图」。
import { swapIn } from '../../core/transition.js';
import { moduleItems } from '../../core/modules.js';
// 看板的第二个视图（日历）走**动态挂载**——
import { mountModuleSlot } from '../../core/slots.js';
import { ttDoneIdsOn, ttNowHM, ttSyncServerNow, ttTodayNow, ttTicker } from '../../core/timetable.js';
import { uiOf } from '../modules.js';
import { loadTodayCounts, renderSidebar, showView } from '../shell.js';
import { state } from '../state.js';
import { toast } from '../ui.js';
import { openBoard } from '../../modules/tasks/desktop-board.js';
import { openDailyModal, openProjectModal } from '../../modules/tasks/desktop-forms.js';
import { openTaskDetail } from '../../modules/tasks/desktop-items.js';

// 「日历视图的这个任务截止 …… 点击任务要弹出详情」——
// 日历模块只把「点了哪条任务」**派成留白事件**（`zx:open-task`，联动宪法 ② / ⑥），
// 动作（开哪个弹窗）由**宿主**在这里接。⚠️ 只挂一次（本文件是模块级单例）。
document.addEventListener('zx:open-task', (e) => {
  const d = (e && e.detail) || {};
  if (d.task) openTaskDetail(d.scope, d.task);
});

// ---------- 区间档位 ----------
// 四档预设与「哪条算落在区间里」都在 `core/dashboard.js`（两端唯一一份，见那个文件的说明）——
// 这里只负责画，⛔ 不要在本文件里再写一遍 `dashRange()` / `visEnd()` 那套判据。
export { DASH_PRESETS, dashRange };

// ---------- 取数与渲染 ----------

/**
 * 功能：把一条事项折成它那一行的键 —— `rowHtml()` 写进 `data-row`、`renderHome()` 反查时**共用这一份**。
 *
 * 行是拼字符串画出来的，只能从 DOM 反查回来。⚠️ 反查的键**必须只有一处拼法** ——
 * 两处各拼一遍，改一处漏一处就成了「点这一行没反应」，而且不报任何错
 * （与任务板的 `itemKey()` 是同一条教训）。
 */
const rowKey = (x) =>
  `${x.kind}:${x.source === undefined ? '' : x.source}:${x.id === undefined ? '' : x.id}`;

/**
 * 功能：切换到首页视图 —— 记录当前视图、重画侧栏、显示首页容器，然后加载并渲染看板。
 *
 * （`loadHome({ snapView: true })`）—— 「屏内切走之后，下次进屏仍按偏好决定」就是这么落地的。
 * @returns {Promise.<void>}
 */
export async function openHome() {
  state.view = 'home';
  renderSidebar();
  // ：
  // 进屏时先把 `#home-body` 清成骨架、**再** `showView()` —— 从前这里直接显示上一次留在
  // 容器里的那块 DOM（上次停在列表视图时就是列表），等 `/api/dashboard` 回来
  const body = $('#home-body');
  if (body) body.innerHTML = skeletonHtml(3);
  // 概览住在固定段（`#home-stats`）⇒ 清骨架时**一并清掉**。
  // 不清的话那一瞬是「旧的五个数 ＋ 空骨架列表」，看着像数据只掉了一半。
  renderStats('');
  showView('home');
  await loadHome({ snapView: true });
}

/**
 * 功能：按当前区间拉取看板数据（`GET /api/dashboard`）后重画，并刷新侧栏的今日待办数；
 * 失败时以 toast 提示错误。
 *
 * @param {Object} [opts] - `{ snapView: true }` 表示**这一次是「进屏」**⇒ 按服务端偏好重落默认视图
 * @returns {Promise.<void>}
 */
export async function loadHome(opts) {
  const r = state.dash.range;
  try {
    state.dash.data = await api('GET', `/api/dashboard?from=${r.from}&to=${r.to}`);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  // **用刚取回来的那份快照**落默认视图 —— 读旧快照会把「刚在设置里
  // 翻过的药丸」吃掉，表现是「药丸开了、进去还是列表」而且**不报错**。
  if (opts && opts.snapView) snapDashView();
  // `fresh: true`：看板数据是**新取回来的** ⇒ 挂着的模块视图（日历）也要重取一次自己的数据
  // （服务端的「今天」与四个图层都会随时间变，与改造前「每次进屏都重取」同一条口径）。
  renderHome({ fresh: true });
  loadTodayCounts();
}


/**
 * 功能：本端画得出来的**看板视图**清单 —— 清单 ∩ 接线表里声明了 `dashView` 的模块。
 * @returns {Array.<Object>} `moduleItems()` 的条目（已经按清单顺序排好）
 */
const capsuleItems = () => moduleItems(state.modules, uiOf, state.me || {});

/**
 * 功能：按**服务端偏好**把看板的默认视图重落一次（进屏 / 首屏时调）。
 *
 * 说明：⭐ 判据在 `core/dashboard.js` 的 `dashDefaultViewName()`（两端唯一一份），
 * 它读的是**看板载荷**里的 `briefs.<模块名>.open_by_default` ——
 * 服务端已经把那两道门（模块真的在 ＋ 它的偏好）过完了，这里⛔ 不再判一遍。
 */
export function snapDashView() {
  state.dashView = dashDefaultViewName(capsuleItems(), state.dash.data);
}

/**
 * 功能：设置页那颗药丸刚被翻过 ⇒ 把宿主内存里的「当前视图」**立刻**拨过去并重画。
 *
 * **从列表视图闪现到日历视图**」）：那颗药丸改的是**服务端的偏好**，而宿主手里那份
 * 看板快照还是旧的 ⇒ 不补这一下的话，回首页时会先按旧值画一遍列表，
 * 等 `/api/dashboard` 回来 `snapDashView()` 才翻到日历 —— 那一次"翻"就是闪。
 */
export function applyDashViewDefault(name) {
  const v = typeof name === 'string' ? name : '';
  state.dashView = dashViewDefs(capsuleItems()).some((it) => it.name === v) ? v : '';
  renderHome();
}

/**
 * 功能：切到看板的某个视图（空串 = 列表视图）—— **只改 state 再重画，⛔ 不重新取数**。
 *
 * 说明：⭐ `state.dash.data`、日历那份在
 * `state.cal`），切来切去不该转圈。⚠️ 日历视图**第一次**挂上时会自己取一次数
 * （那是它自己的事，见 `modules/calendar/*-dash-view.js`），之后就不再取了。
 * 认不出来的模块名（模块被删了 / 没声明 `dashView`）一律当「列表视图」——
 */
export function setDashView(name) {
  const next = typeof name === 'string' ? name : '';
  if (state.dashView === next) return;
  state.dashView = next;
  // 两个视图是**两种完全不同的版式**（清单 / 月历），停在原来的滚动位置毫无意义 ——
  // 月历挂上之后会被顶到中间，用户看到的是「一屏不知道自己在哪的日历」。
  // 与手机端 `views/today.js` 的 `setDashView()` **同一条口径**，⛔ 别只改一端。
  scrollHomeTop();
  // 修订（「数据不自动刷新，比如我在列表视图点了完成，切换到日历视图
  // 依然显示没有完成，重新进入软件就好了」）：
  // 切视图**只重画不重取**—— 可列表视图里改过任务之后，`state.cal` 那份快照
  renderHome({ fresh: true });
}

/**
 *
 * 重落默认视图），**再**调这里强制切到目标视图 —— 合成一个函数的话，「先落默认、再覆盖」
 */
export function openDashView(name) {
  if (!capsuleItems().some((it) => it.dashView && it.name === name)) return;
  setDashView(name);
}

/**
 * 功能：切到某一档预设并重新取数（今日 / 单日 / 本周 / 本月）。
 * 说明：⭐ `day`（单日）那一档的区间是**用户挑的那天**—— `dashRange('day', 基准日)`；
 * 手改日期框时保持 `day` 这一档（见 `renderDashBar()` 对 `to` 输入框的处理）。
 * @param {string} preset - `today` / `day` / `week` / `month`
 * @param {string} [base] - 基准日；`day` 这一档用它，缺省为今天
 */
export async function dashSetPreset(preset, base) {
  state.dash.preset = preset;
  state.dash.range = dashRange(preset, base);
  await loadHome();
}

/**
 * 功能：把区间**整周前后挪**（周条上的 ‹ ›）—— 挪完落在「本周」这一档。
 *
 * 按一下也能落到**整齐的一周**上，不会出现「9/3 往后一周 = 9/3~9/9」这种半个星期。
 * @param {number} delta - 正数往后、负数往前（单位：周）
 * @returns {Promise.<void>}
 */
export async function dashShiftWeek(delta) {
  const mon = mondayOf(state.dash.range.from || todayStr());
  const from = addDays(mon, delta * 7);
  state.dash.preset = 'week';
  state.dash.range = { from, to: addDays(from, 6) };
  await loadHome();
}

/**
 * 功能：点周条里的某一格 —— 把区间收敛到那一天（就是原有的「单日」那一档）。
 * @param {string} date - 那一天 `YYYY-MM-DD`；空值时什么都不做（骨架还没填字就被点到的瞬间）
 * @returns {Promise.<void>}
 */
export async function dashSetDay(date) {
  if (!date) return;
  await dashSetPreset('day', date);
}

/**
 * 功能：周条上的「今天」—— 回到「今日」那一档（区间收敛成今天一天）。
 * @returns {Promise.<void>}
 */
export async function dashGoToday() {
  await dashSetPreset('today');
}

/**
 * 功能：点概览上某一个数 —— 把下面的列表筛成这一类；点已选中的那个则取消筛选。
 * 说明：⚠️ 只改 state 再重画 `#home-body`（**不重新取数**）：筛选是纯前端的事，
 * @param {string} key - `DASH_FILTERS` 里的某个 key
 * @returns {void}
 */
export function dashSetFilter(key) {
  state.dash.filter = state.dash.filter === key ? '' : key;
  // 结果集换了一批 ⇒ 回顶（停在原位置的话，列表变短后浏览器会把滚动位置
  // 夹到新的底部 —— 用户看到的是「筛出来的最后几条」，最容易误判成「筛错了」）。
  scrollHomeTop();
  renderHome();
}

/**
 * 下半是原有的档位按钮 / 两个日期框 / 说明行。
 *
 */
function renderDashBar() {
  // 首屏还没算过区间（`shell.js` 才现算一次）时，这里照当前档位兜一个 —— 条形不能是空的
  const range = state.dash.range.from ? state.dash.range : dashRange(state.dash.preset);
  const { preset } = state.dash;

  document.querySelectorAll('#dash-presets .seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.dash === preset);
    b.setAttribute('aria-selected', String(b.dataset.dash === preset));
  });
  const f = $('#dash-from');
  const to = $('#dash-to');
  if (f.value !== range.from) f.value = range.from;
  if (to.value !== range.to) to.value = range.to;
  const oneDay = preset === 'day';
  // 用 `hidden` 而不是重画节点：这个条是静态骨架（见文件头）
  to.hidden = oneDay;
  const sep = $('.dash-dash');
  if (sep) sep.hidden = oneDay;
  // 说明行的文案与周条顶部那行**共用 `dashRangeLabel()`**（两处各写一遍就会自相矛盾）
  $('#dash-range-note').textContent = dashRangeLabel(range);

  $('#dash-week-range').textContent = dashRangeLabel(range);
  const cells = dashWeekCells(range.from);
  document.querySelectorAll('#dash-week-days .dash-day').forEach((b, i) => {
    const c = cells[i];
    b.dataset.dashDay = c.date;
    b.querySelector('i').textContent = c.weekday;
    b.querySelector('b').textContent = c.day;
    // 选中 = 「这一格就是当前生效的那一天」：只有区间收敛成一天时才算
    const sel = range.from === range.to && range.from === c.date;
    b.classList.toggle('is-sel', sel);
    b.classList.toggle('is-today', c.today);
    b.setAttribute('aria-pressed', String(sel));
  });
}

/**
 *
 * 说明：⭐ 项**全是算出来的**：`views` 来自 `dashViewDefs()`（清单 ∩ 接线表里声明了 `dashView` 的模块），
 */
function capsuleHtml(views, active) {
  if (!views.length) return '';
  const cur = active || '';
  /**
   * 功能：画胶囊里的一颗。
   * @param {string} key - 视图键（空串 = 列表视图 | 模块名）
   * @param {string} label - 界面上的字
   * @returns {string} 一颗按钮的 HTML
   */
  const tab = (key, label) => `<button class="dash-tab${cur === key ? ' on' : ''}" type="button" role="tab"
      aria-selected="${cur === key}" data-dash-view="${esc(key)}">${esc(label)}</button>`;
  return `<div class="dash-tabs" id="dashview-tabs" role="tablist">${tab('', '列表视图')}${views
    .map((it) => tab(it.name, it.dashView.label))
    .join('')}</div>`;
}

/**
 * 功能：给胶囊挂点击 —— 点一颗就切视图（**只改 state 再重画，⛔ 不重新取数**）。
 *
 * 说明：⚠️ 直接绑而不是事件委托：胶囊只有两三颗、而且每次重画都重建（与 `.dash-stat` /
 * `.dash-row` 同一手法）。⚠️ 判据只认 `data-dash-view` 上的键，⛔ 不在按钮上再存一份
 * 「当前选中」——那是 `state.dashView` 的事。
 */
function bindCapsule(root) {
  root.querySelectorAll('[data-dash-view]').forEach((b) => {
    b.addEventListener('click', () => setDashView(b.getAttribute('data-dash-view') || ''));
  });
}

/**
 *
 * 说明：⚠️ 槽是静态节点、内容每次重画 ⇒ 点击必须在**重画之后**重新绑（`bindCapsule()`）；
 */
function renderCapsule(views, view) {
  const box = $('#home-tabs');
  if (!box) return;
  box.innerHTML = capsuleHtml(views, view);
  // 三处药丸**同一个行为** —— 各颗撑成等宽（量最宽那颗）。
  // 首页这条现在是「列表视图 / 日历视图」（各 4 字）本来就等宽，量一次也看不出差别；
  // 统一调它是为了「将来多一个视图」时不用再回来补这一行（三处口径只有一份）。
  fitTabs(box);
  bindCapsule(box);
}

/**
 * 功能：把「筛选」与「搜索」两块面板的显隐、以及两颗图标的展开态刷成当前状态。
 *
 * 单日、本周、本月、自定义区间；还增加一个搜索图标（放大镜），点击出现输入框。
 * 这两个图标放到【今天】的旁边」。
 * 显隐有**两个来源**，一律在这一处合成：
 */
function syncDashPanels(view) {
  const onList = !view;
  // 周条（‹ 区间 › 今天 ＋ 七天）—— 日历视图下整条收起来，两颗图标也在它里面
  const week = $('.dash-week');
  if (week) week.hidden = !onList;
  // 「单日 / 本周 / 本月 ＋ 两个日期框」那一块：点开筛选图标才显示
  const range = $('.dash-range');
  if (range) range.hidden = !onList || state.dash.panel !== 'filter';
  // 搜索行：点开放大镜才显示
  const search = $('#dash-search');
  if (search) search.hidden = !onList || state.dash.panel !== 'search';
  // 两颗图标的选中态**与面板的显隐同一处算** —— 分开写必然出现「亮着但没展开」
  const fb = $('#dash-filter-btn');
  if (fb) fb.setAttribute('aria-expanded', String(!!range && !range.hidden));
  const sb = $('#dash-search-btn');
  if (sb) sb.setAttribute('aria-expanded', String(!!search && !search.hidden));
  // 顺手把当前视图记下来：两个 toggle 动作只改 state、不重画看板（重画会把输入的焦点抹掉），
  // 所以它们需要知道「现在是不是日历视图」——`renderHome()` 是唯一知道这件事的地方。
  curDashView = view;
}

/**
 * 功能：点周条那颗「筛选」图标 —— 展开 / 收起「单日 / 本周 / 本月 ＋ 两个日期框」。
 *
 * 说明：⚠️ 只改 `state` 再同步一次显隐，**不重画看板**（面板的显隐与条目无关；
 * 重画会把 `.dash-range` 里那两个 `<input type="date">` 和搜索框的焦点一起抹掉）。
 * @returns {void}
 */
export function dashToggleFilter() {
  state.dash.panel = state.dash.panel === 'filter' ? '' : 'filter';
  syncDashPanels(curDashView);
}

/**
 * 功能：点周条那颗放大镜 —— 展开 / 收起搜索行。
 * @returns {void}
 */
export function dashToggleSearch() {
  state.dash.panel = state.dash.panel === 'search' ? '' : 'search';
  syncDashPanels(curDashView);
  if (state.dash.panel === 'search') {
    const q = $('#dash-q');
    if (q) q.focus();
  }
}

/** 区间工具栏那几件的监听**只挂一次**（它们是静态骨架，重挂会叠加） @type {boolean} */
let dashBarBound = false;

/**
 * 功能：给区间工具栏挂监听 —— 两颗图标 ＋ 搜索框的 `input`（只挂一次）。
 *
 * 说明：⚠️ 搜索是**纯前端**筛（`core/dashboard.js` 的 `dashSearch()`）：敲一个字就重画一次
 * `#home-body`（`renderHome()` 本来就只换那一块）—— 输入框在**静态骨架**里，不受影响，
 * 所以光标与已输入的内容都稳稳留着。
 */
function bindDashBar() {
  if (dashBarBound) return;
  dashBarBound = true;
  const fb = $('#dash-filter-btn');
  if (fb) fb.addEventListener('click', dashToggleFilter);
  const sb = $('#dash-search-btn');
  if (sb) sb.addEventListener('click', dashToggleSearch);
  const q = $('#dash-q');
  if (q) {
    q.addEventListener('input', () => {
      state.dash.q = q.value;
      // 与 `dashSetFilter()` 同一条理由 —— 结果集换了就回顶（见 `scrollHomeTop()`）。
      scrollHomeTop();
      renderHome();
    });
  }
}

/** 上一次画的是哪个视图（空串 = 列表视图）；`null` = 还没画过。见 `swapAnimOnce()` */
let lastView = null;

/**
 *
 * 说明：`state.dash.data` 每次取数都是**新对象**（`loadHome()` 直接赋值）⇒「不是同一份」
 */
let lastHomeData = null;

/**
 * 当前视图（空串 = 列表视图）。
 *
 */
let curDashView = '';

/**
 * 功能：两个视图之间切换时，给内容容器播一次淡入。
 */
function swapAnimOnce(box, view) {
  // 修订：`null` = **这一次是首屏**，不是「切换」—— 首屏那一下由 `showView()` 的
  // 整屏动画负责（`shell.js` 的 `.view.is-swap`）。两处一起播 = 同一块内容连淡两次
  // （外层 0ms 起、内层同一帧再起）⇒ 看着是「闪两下」，比不加还差。
  if (lastView === null) {
    lastView = view;
    return;
  }
  if (lastView === view) return;
  lastView = view;
  // `tier 2` —— 「列表视图 ↔ 日历视图」是**模块内胶囊切换**（二级）。
  // 手机端 `views/today.js` 的 `swapAnimOnce()` 必须给**同一个级**，⛔ 别只改一端。
  swapIn(box, 2);
}

/**
 *
 * 说明：⚠️ 三处调它：**换视图**（`setDashView()`）、**看板数据换成了新的一份**（`renderHome()` 里
 */
function scrollHomeTop() {
  const el = $('#home-body');
  if (el) el.scrollTop = 0;
}

/**
 *
 * 说明：⚠️ 槽是静态节点（`index.html`），内容每次重画 ⇒ 与 `renderCapsule()` 同一手法。
 */
function renderStats(html) {
  const box = $('#home-stats');
  if (box) box.innerHTML = html || '';
}

/**
 * 功能：画「📌 任务概览」那一块（标题 + 五个数 + 进度条 + 完成度说明）—— ⭐ **两个视图共用**。
 *
 * 它原来内联在列表视图那段里 —— 日历视图**也要有它**，
 * 所以抽成一份：抄第二份的下场是「换个视图同一个数就变了」，而且**不报错**。
 * @param {Object} st - `dashStats()` 的产物
 */
function statsBlockHtml(st, filter) {
  const { progress } = st;
  const statsHtml = DASH_FILTERS.map((f) => {
    const n = st[f.key];
    // 只有「出事了」的两个数标红（已逾期 / 硬件要关注）—— 「0 件事要处理」写红字会被读成有事故
    const warn = (f.key === 'overdue' || f.key === 'hardware') && n > 0;
    return `<button class="dash-stat${filter === f.key ? ' on' : ''}" type="button"
      data-dash-filter="${esc(f.key)}" aria-pressed="${filter === f.key}">
        <b class="dash-num${warn ? ' warn' : ''}">${n}</b><span class="dash-lbl">${esc(f.label)}</span>
      </button>`;
  }).join('');
  return `<div class="dash-h">📌 任务概览<span>日常 ${st.daily} · 项目 ${st.project}${
    filter ? ' · 已筛选：' + esc((DASH_FILTERS.find((f) => f.key === filter) || {}).label || '') : ''
  }</span></div>
  <div class="dash-stats">${statsHtml}</div>
  <div class="dash-progress"><i style="width:${progress}%"></i></div>
  <div class="dash-progress-cap">区间内任务完成度 <b>${progress}%</b>（${st.done} / ${st.total}）</div>`;
}

/**
 * 功能：画「🧩 各模块」那一块（标题 + 各模块一张卡）—— ⭐ **两个视图共用**（同 `statsBlockHtml()`）。
 *
 * 现在叫「各模块」、排在**清单之前**（列表视图）或**日历之后**（日历视图）。
 * 名字跟着位置改 —— 把它摆在第一屏还叫「其它」，读着不通（手机端同一步、同一个理由）。
 * @param {Array.<Object>} briefRows - `briefRowsOf()` 的产物
 */
function briefsBlockHtml(briefRows) {
  return `<div class="dash-h">🧩 各模块</div>
    ${briefsHtml(briefRows)}`;
}

/**
 * 功能：画「🗓 这段时间要做的事」那一块（清单主体），两个视图共用。
 *
 * 它同时是筛选数字的落点：上面「任务概览」点一个数就把这块筛成这一类。
 */
function itemsBlockHtml(entries, all, d) {
  return `<div class="dash-h">🗓 这段时间要做的事<span>${entries.length} 条</span></div>
    ${entries.length ? entrySections(entries) : courseNoteOrEmpty(all)}
    ${courseNote(d)}`;
}

/**
 * 功能：给事项行挂点击 —— ⭐ **两个视图共用**（两块清单都画得出来）。
 *
 * 说明：⭐ 任务**就地弹详情**；课程 / 数码管理仍走**侧栏那扇门**
 * 课程与数码管理刻意点侧栏按钮而不是 import 对应模块：① 那几个模块本来就是主功能入口、
 * 由 `app.js` 静态加载，首页再静态 import 一遍只会多出一圈 `shell ↔ home ↔ digital`
 */
function bindDashRows(root, byRow) {
  root.querySelectorAll('.dash-row').forEach((n) => {
    /**
     * 功能：点这一行 —— 任务就地弹详情，课程 / 硬件仍走侧栏那扇门。
     * @returns {void}
     */
    const go = () => {
      const kind = n.dataset.kind;
      if (kind === 'course') return clickNav('#btn-timetable');
      // 模块 `hardware` 改名 `digital`，并且**撤了 `nav`** —— 它不再有
      // 自己的一屏，界面挂进「个人资产管理」那一屏的药丸（`slots: ['assets-pane']`）。
      // 所以**全仓没有 `#btn-digital` 这个 id**（侧栏那几颗是按各模块接线表的 `nav.id`
      if (kind === 'hardware') {
        state.assetsWant = 'digital';
        return clickNav('#nav-assets');
      }
      // 「可以直接修改任务而不是跳转」—— 不再切到任务板，就地打开这条任务的详情
      // （详情里已有 编辑 / 标记完成 / 删除，改完首页自己会重取，见 `refreshAfterWrite()`）。
      // 作用域用这一条自己的 `source`：看板上的任务来自**不同项目**，
      const x = byRow.get(n.dataset.row);
      if (x && x.task) return openTaskDetail(x.source, x.task);
      // 兜底：拿不到那一条时照旧去任务板 —— 宁可多一步，也不要「点了没反应」
      return openBoard(n.dataset.src === 'daily' ? 'daily' : Number(n.dataset.src));
    };
    n.addEventListener('click', go);
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
  // 任务上绑的网址：点标题**只开网址**、不跳任务板（它会冒泡到整行的跳转）
  root.querySelectorAll('.dash-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(a.dataset.url, '_blank', 'noopener,noreferrer');
    });
  });
}

/**
 * 功能：给「任务概览」与「其它」那两块挂点击 —— ⭐ **两个视图共用**（它们在哪个视图下都画得出来）。
 *
 * 说明：⚠️ 概览那颗数走 `dashSetFilter()`（只改 state 再重画）；模块卡走**侧栏那扇门**
 * （点它等于点侧栏那颗入口）——
 * 「按账号关掉的入口」的显隐判定**只有侧栏那一份**，这里不照抄一遍。
 */
function bindDashBlocks(root, briefIt) {
  // 概览那 5 颗按钮**搬去了固定槽** `#home-stats`（在 `#home-body` 外面）——
  // 而且**不报错**（按钮画得出来、点了没反应）。
  const statsBox = $('#home-stats');
  if (statsBox) {
    statsBox.querySelectorAll('.dash-stat').forEach((n) => {
      n.addEventListener('click', () => dashSetFilter(n.dataset.dashFilter));
    });
  }
  root.querySelectorAll('.dash-brief').forEach((n) => {
    n.addEventListener('click', () => {
      const it = briefIt.get(n.dataset.gotoMod);
      if (it && it.nav) clickNav('#' + it.nav.id);
    });
  });
}

/**
 * 功能：渲染整块首页看板 —— 视图胶囊、任务概览、具体事项列表、收藏夹与消息概况，并绑上交互。
 * 汇总数据尚未到位时先铺一层骨架屏；整个工作台一条数据都没有时改画「空工作台」引导态。
 *
 * 「现在看哪个」住 `state.dashView`（空串 = 列表），判据全部来自接线表的 `dashView` 声明 ——
 * 本文件不认识任何具体模块名。
 */
export function renderHome(opts) {
  renderDashBar();
  // 区间工具栏那两颗图标 ＋ 搜索框的监听（**只挂一次**，
  // 它们是静态骨架 ⇒ 重挂会叠加）
  bindDashBar();
  const body = $('#home-body');
  if (!body) return;
  const fresh = !!(opts && opts.fresh);

  // `views` 为空（模块被删掉 / 接线表里没人声明 `dashView`）⇒ 整条胶囊不画，
  // 于是 `view` 也必然是空串 —— 看板只剩列表视图，**一颗死胶囊都不剩**。
  // 「把切换按钮放【首页看板】这个标题处」⇒ 它画进 `.home-head` 的
  const views = dashViewDefs(capsuleItems());
  const view = views.some((it) => it.name === state.dashView) ? state.dashView : '';
  renderCapsule(views, view);

  // 修订：「日历视图不要显示这玩意」—— 他圈掉的是**区间条**
  // （周条 + 档位 + 两个日期框 + 说明行）。它管的是「这段时间」，而日历有自己的月导航
  // ⇒ 日历视图下整块收起来，别让两套「范围」控件同屏打架。
  syncDashPanels(view);  // ⭐ 换了视图 ⇒ 播一次淡入（同视图内部的刷新不播，见 `swapAnimOnce()`）
  swapAnimOnce(body, view);

  const d = state.dash.data;
  if (!d) {
    // 概览住在**固定段**（`#home-stats`）⇒ 数据没到 / 取数失败时也要把它清空。
    // 不清的话，上一次那几个数会留在屏上，与下面的骨架屏**同屏**
    // —— 看着像「数据是好的，只是列表没出来」，比空着更误导。
    renderStats('');
    body.innerHTML = skeletonHtml(4);
    return;
  }
  // **刚取过数**（换区间 / 点右上角 ↻）= 内容整批换过了 ⇒ 回顶。
  // 与「离开再回来」分开判：那时数据仍是同一份，滚动位置要**留着**
  // （用户就是回来接着看的）。见 `scrollHomeTop()` 的说明。
  const dataChanged = d !== lastHomeData;
  lastHomeData = d;
  if (dataChanged) scrollHomeTop();
  const tot = d.totals || { projects: 0, project_tasks: 0, daily_tasks: 0 };
  // 日期一并提到视图分流之前 —— 它现在也是**常驻头部**的一块，两个视图下都该有值
  // （原来只在列表那一支赋值 ⇒ 直接进日历视图时它会空着）。
  $('#home-date').textContent = `${fmtDate(d.today)} ${weekName(d.today)} · 共 ${tot.projects} 个项目`;

  // 下面这几份**两个视图都要用**（概览那几个数、「其它」那几张卡），所以提到视图分流之前算。
  const all = dashEntries(d);
  const st = dashStats(all);
  // 先按「概览上点的那一类」筛，再按**搜索词**筛 ——
  // 两个都是**纯前端**的（⛔ 都不重新取数），判据各只有一份（`dashFilter()` / `dashSearch()`）。
  const entries = dashSearch(dashFilter(all, state.dash.filter), state.dash.q);
  // 行键 → 这一条事项。点一条任务要就地弹详情（需要整条事项，见 `rowKey()` 的说明），
  // 而画出来的行只有一个字符串，只能靠这个索引把「用户点的是哪一条」找回来。
  const byRow = new Map(entries.map((x) => [rowKey(x), x]));
  // 「其它」那一块 —— 模块卡，以及「点一张卡进哪一屏」的索引（见 `briefsHtml()`）
  const briefRows = briefRowsOf(d);
  const briefIt = new Map(briefRows.map((r) => [r.it.name, r.it]));

  // 修订：「日历视图要有任务概览和其它模块入口」——
  // 这两块**两个视图共用**：它们都不是「列表专属」的东西（概览给的是几个数，
  // 「各模块」给的是入口）。日历替换的只是**中间那块主体**（「这段时间要做的事」）。
  const statsBlock = statsBlockHtml(st, state.dash.filter);
  const itemsBlock = itemsBlockHtml(entries, all, d);
  // **筛选 / 搜索生效时，列表视图不画「各模块」** —— 那一刻清单是主角，
  // 用户点完一个数（或敲了搜索词）该**立刻看到结果**，而不是先看到一屏模块卡
  // （模块卡现在排在清单之前，不藏起来就成了「点了数字、界面只换了几张卡」）。
  const narrowing = !view && (!!state.dash.filter || !!state.dash.q);
  const briefsBlock = narrowing ? '' : briefsBlockHtml(briefRows);
  renderStats(statsBlock);

  if (view) {
    // ：这一支里只有
    // 概览 → 日历 → 其它，⛔ **不再放「这段时间要做的事」**。
    // 那版把它排在了日历下面（理由写的是「它也是上面那几个筛选数字的落点」）——
    body.innerHTML = `<div id="dashview-host"></div><div id="dash-other">${briefsBlock}</div>`;
    // 动态挂载：宿主只给容器与上下文，界面全在那个模块里。
    mountModuleSlot($('#dashview-host'), 'desktop', view, 'dash-view', {
      end: 'desktop',
      modules: state.modules,
      uiOf,
      me: state.me,
      // `fresh` 原样转交：日历据此决定「这一次要不要重取自己的数据」
      fresh,
      // ：
      // 把「其它」那块**交给模块摆放** —— 它会把它搬进日历那一列的下方
      // （`.cal-body` 是两列网格，搬进去之后自动落在第二行第一列 = 日历正下方）。
      belowEl: $('#dash-other'),
    });
    // 「其它」那几张卡 —— 两个视图下都能点 ⇒ 绑在同一处，⛔ 不各绑一份。
    bindDashBlocks(body, briefIt);
    // 课程行只在下方的清单里（列表视图）⇒ 这一支不挂倒计时。
    return;
  }

  // 空态：整个工作台什么都没有时给一条明确的起点，而不是几块空列表。
  // 它**只作用于列表视图** —— 日历视图的出路是「在日历上建一条事件」，不是「新建项目」，
  // 所以这一支必须放在 `if (view)` **之后**。
  if (!tot.projects && !tot.project_tasks && !tot.daily_tasks && !d.timetable.terms) {
    // 空工作台时概览那五个数**全是 0**，画出来只占屏幕
    // （改造前它整块被这块空态盖掉，现在概览在固定段、盖不掉 ⇒ 必须显式清空）。
    renderStats('');
    body.innerHTML = `
      <div class="empty-state">
        <div class="es-ico">🗂</div>
        <div class="es-title">工作台还是空的</div>
        <div class="es-text">数据存在 NAS 的数据库里（zxdesk.db），重启也会保留。先建一个项目，或者先记一条日常任务。</div>
        <div class="es-actions">
          <button class="btn btn-primary" id="es-new-project">＋ 新建项目</button>
          <button class="btn btn-subtle" id="es-new-daily">＋ 新建日常任务</button>
        </div>
      </div>`;
    $('#es-new-project').addEventListener('click', () => openProjectModal());
    $('#es-new-daily').addEventListener('click', () => openDailyModal());
    return;
  }

  // ---- 列表视图：① 各模块（入口） ② 这段时间要做的事（清单）----
  // 这两块**顺序对调**（改造前是 清单 → 其它），与手机端同一步、同一个理由 ——
  // 「这个模块的定位是看板，应该具备展示和进入各个模块的能力」。
  body.innerHTML = `${briefsBlock}
    ${itemsBlock}`;

  // 清单行、概览那几个数、「其它」那几张卡 —— 与日历视图**同一套绑定**
  // （`bindDashRows()` / `bindDashBlocks()` 里各写了为什么：两处各绑一份必然烂掉一处）。
  bindDashRows(body, byRow);
  bindDashBlocks(body, briefIt);
  // 课表 2 期：看板画完立刻挂上倒计时（挂＝替换；首拍就是挂上时立刻跑的那一下）
  ttTicker(true, dashLiveTick);
}

/**
 * 功能：外部（对话模块）推过来的**未读消息数** —— 把首页看板上那张「未读消息」卡就地改掉。
 *
 * 卡片改由 `briefs` 画），只在 `loadHome()` 时更新 —— 所以新消息来了它一动不动，
 * 用户只能手动刷新。对话模块拿到新总数后调这里，这条链就接上了（它那边有 SSE 与轮询两路）。
 * **必须同时改快照**：只改 DOM 的话，用户切一次区间就把整块重画了，数字又跳回旧值。
 */
export function paintTeamworkUnread(n) {
  const d = state.dash.data;
  if (!d) return;
  const num = Number(n) || 0;
  // **快照必须一起改**：只改 DOM 的话，用户切一次区间就把整块重画了，数字又跳回旧值。
  // 这张卡现在读的是 `briefs.teamwork`（见 `briefsOf()`），两个快照一起写 ——
  if (d.teamwork) d.teamwork.unread = num;
  if (d.briefs && d.briefs.teamwork) d.briefs.teamwork.unread = num;
  const card = $('[data-goto-mod="teamwork"]');
  if (!card) return;
  card.classList.toggle('warn', num > 0);
  // 角标**没有就现建、归零就摘掉**（与 `core/dashboard.js` 的 `dashBrief()` 同一条规矩：
  // 只在为正时才挂那个数，0 已经在文案里说过了）—— 别在这里改成永远显示一个 `0`。
  let b = card.querySelector('.db-num');
  if (num > 0) {
    if (!b) {
      b = document.createElement('span');
      b.className = 'db-num';
      card.appendChild(b);
    }
    b.textContent = String(num);
  } else if (b) {
    b.remove();
  }
}

/**
 * 功能：把「其它」那一块要画的模块挑出来 —— 本账号**开着、且还在**、并且服务端给了简要在的。
 *
 * 不写死：加一个模块、关一个模块，这一块自己就跟着变。
 * 判「画不画」只看 `dashboard().briefs` 里有没有这个键 —— 服务端已经把那两道门
 * （账号偏好 ＋ 模块真的在）过完了，这里再判一次就是第二个真值。
 */
function briefRowsOf(d) {
  // 修订（「其它里还有日历按钮卡片，应该删掉」）：
  // **已经作为看板视图存在**的模块（接线表里声明了 `dashView`）**不再出卡** ——
  // 它现在就长在这个屏里，门是**胶囊**，再给一张「去日历」的卡是重复入口。
  const asView = new Set(dashViewDefs(capsuleItems()).map((it) => it.name));
  const out = [];
  moduleItems(state.modules, uiOf, state.me || {}).forEach((it) => {
    if (asView.has(it.name)) return;
    // **没有独立屏入口的模块不出这张卡** —— 这张卡是「去那一屏」的门，
    // 两张卡还留在「其它」里，点了**毫无反应**且不报错（`bindDashBlocks()` 里那句
    // `if (it && it.nav)` 把它拦掉了）。⛔ 别把这一行删掉当「优化」。
    if (!it.nav) return;
    const b = dashBrief(it.name, (d.briefs || {})[it.name]);
    if (b) out.push({ it, b });
  });
  return out;
}

/**
 * 功能：把「其它」那一块画出来 —— 一个模块一张卡（图标 + 名字 + 一句简要 + 可选的大数）。
 * @param {Array.<{it: Object, b: Object}>} rows - `briefRowsOf()` 的产物
 * @returns {string} 这一块的 HTML
 */
function briefsHtml(rows) {
  if (!rows.length) return '<div class="empty-hint">所有模块都在「设置 → 模块功能」里关着。</div>';
  return (
    '<div class="dash-briefs">' +
    rows
      .map(
        ({ it, b }) => `
      <button class="dash-brief${b.warn ? ' warn' : ''}" type="button" data-goto-mod="${esc(it.name)}"
              title="${esc(it.title)}">
        <span class="db-ico" aria-hidden="true">${esc(it.icon)}</span>
        <span class="db-main"><b>${esc(it.title)}</b><span>${esc(b.text)}</span></span>
        ${b.n === null ? '' : `<span class="db-num">${b.n}</span>`}
      </button>`,
      )
      .join('') +
    '</div>'
  );
}

/**
 * 功能：把「这段时间要做的事」画出来 —— 分成**三块**：📘 课程 / ✅ 任务 / 🧩 数码管理。
 *
 * 没有则不显示」。
 * **任务**走 `dashTaskTiers()` 的分级（已逾期 → 今日截止 → 本周截止 → 本月截止
 * → 更晚 → 已完成），**空的分级根本不返回**，所以「没有则不显示」不用这里再判一次；
 */
function entrySections(entries) {
  const lessons = entries.filter((x) => x.kind === 'course');
  const tasks = entries.filter((x) => x.kind === 'task');
  const hws = entries.filter((x) => x.kind === 'hardware');
  let html = '';
  if (lessons.length) {
    html += `<div class="dash-sub">📘 课程<span>${lessons.length} 节</span></div>`;
    html += dashGroups(lessons, state.dash.preset).map(groupsHtml).join('');
  }
  if (tasks.length) {
    html += `<div class="dash-sub">✅ 任务<span>${tasks.length} 条</span></div>`;
    html += dashTaskTiers(tasks).map(groupsHtml).join('');
  }
  if (hws.length) {
    html += `<div class="dash-sub">🧩 数码管理<span>${hws.length} 件</span></div>`;
    html += dashGroups(hws, state.dash.preset).map(groupsHtml).join('');
  }
  return html || '<div class="empty-hint">这个区间里没有安排。换个区间看看，或者去任务板加一条。</div>';
}

/**
 * 功能：把一组（某一天 / 某一周）的条目画成一张表 —— 段标题 + 若干行。
 * @param {{key: string, label: string, items: Array.<Object>}} g - `dashGroups()` 或 `dashTaskTiers()` 的一段
 * @returns {string} 这一段的 HTML；段标题为空串时（今日 / 单日 / 自定义区间）不画标题
 */
function groupsHtml(g) {
  return `${g.label ? `<div class="dash-group">${esc(g.label)}</div>` : ''}
    <div class="dash-list">${g.items.map(rowHtml).join('')}</div>`;
}

/**
 * 功能：画出一条具体事项 —— 图标 / 标题 / 备注 / 归属，以及任务上绑的网址。
 *
 * 说明：⭐ 课程备注**加粗标红**—— 备注写的是「带教材」「在实训楼」这类
 * 不看会出事的话，跟标题一样淡就等于没写。
 * 任务上绑的网址显示**网址标题**且可点跳转（跨模块那条），点它**只开网址**、不跳任务板。
 */
function rowHtml(x) {
  // 两条备注**口径已分开**，两条都画 ——
  // � `x.remark` = **本节备注**（这一天这一节，来自 `timetable_day_notes`；看板列的是
  // 「某一天的课」，所以带上那一天的那一条）；📌 `x.course_remark` = 课程备注（这门课的每一节）。
  const flags =
    (x.important ? '<span class="dash-flag imp">🔴 重要</span>' : '') +
    (x.urgent ? '<span class="dash-flag urg">⏰ 紧急</span>' : '');
  const remark =
    (x.remark ? `<span class="dash-remark">📝 ${esc(x.remark)}</span>` : '') +
    (x.course_remark ? `<span class="dash-remark course">📌 ${esc(x.course_remark)}</span>` : '');
  const link = x.bookmark
    ? `<a class="dash-link" href="#" data-url="${esc(x.bookmark.url)}" title="${esc(x.bookmark.url)}"
        >🔗 ${esc(x.bookmark.title || x.bookmark.url)}</a>`
    : '';
  // 课表 2 期：课程行多摆一枚**倒计时的专门文本节点**（渲染时空着，
  // 由 `dashLiveTick()` 填字）—— ⛔ 刷新只改这里的 textContent 与 `is-done` 类，绝不重画看板。
  const live = x.kind === 'course' ? `<span class="dash-live" data-live="${esc(x.key)}"></span>` : '';
  return `
      <div class="dash-row k-${x.kind}${x.overdue ? ' over' : ''}${x.done ? ' done' : ''}${
        x.rescheduled ? ' is-resched' : ''
      }" data-row="${esc(
        rowKey(x),
      )}" data-kind="${x.kind}" data-src="${esc(
        x.source === undefined ? '' : x.source,
      )}" data-id="${x.id === undefined ? '' : x.id}" tabindex="0">
        <span class="dash-ico" style="--c:${esc(x.color || '#4f46e5')}">${esc(x.icon)}</span>
        <div class="dash-main">
          <div class="dash-title"><span class="dash-tt">${esc(x.title)}</span>${flags}${remark}</div>
          <div class="dash-meta">${esc(x.meta)}${link}${live}</div>
        </div>
        <span class="dash-src">${esc(x.name)}</span>
      </div>`;
}

/**
 * 功能：首页看板的一拍 —— 改课程行的 `is-done` 类（**区间里的每一天都算**），并只给今天的
 * 那批行填倒计时 / 课间文案；**绝不重画看板**。
 *
 * 说明：⭐ 判定与文案来自 `core/timetable.js`（唯一一份），与课表页（两端）**同一份数据口径**
 * （`dashEntries()` 带着服务端解好的 `start_time` / `end_time` / `spans`），所以两处逐字一致。
 */
function dashLiveTick() {
  const d = state.dash.data;
  if (!d) return;
  ttSyncServerNow(d.now);
  const t = ttNowHM();
  // 快照是别的天拉的（跨了零点没刷新）→ 冻结，不画「看似在走、其实是昨天」的假倒计时
  if (d.today && d.today !== t.date) return;
  // 看板区间可能是本周 / 本月 —— **过去的日子也要灰**（不止今天那一列）。
  // 按日期分组各算各的：今天那份连文案（倒计时 / 课间）一起算，别的日子只判「上过没有」。
  const courses = dashEntries(d).filter((x) => x.kind === 'course');
  const courseByKey = new Map(courses.map((x) => [x.key, x]));
  const lessonsByDate = new Map();
  courses.forEach((x) => {
    const l = { id: x.key, start_time: x.start_time, end_time: x.end_time, spans: x.spans };
    if (!lessonsByDate.has(x.date)) lessonsByDate.set(x.date, []);
    lessonsByDate.get(x.date).push(l);
  });
  const resByDate = new Map();
  lessonsByDate.forEach((lessons, date) => {
    resByDate.set(date, {
      doneIds: ttDoneIdsOn(date, t.date, t.hm, lessons),
      byId: date === t.date ? ttTodayNow(t.hm, lessons).byId : null,
    });
  });
  document.querySelectorAll('#home-body .dash-live').forEach((live) => {
    const row = live.closest('.dash-row');
    if (!row) return;
    const key = live.dataset.live;
    const x = courseByKey.get(key);
    const r = x ? resByDate.get(x.date) : null;
    row.classList.toggle('is-done', !!r && r.doneIds.has(key));
    live.textContent = (r && r.byId && r.byId.get(key)) || '';
  });
}

/**
 * 功能：一个条目都没有时说一句人话 —— 可能是真的没安排，也可能是刚被筛掉了。
 * @param {Array.<Object>} all - 未筛选的全部条目
 * @returns {string} 提示块的 HTML
 */
function courseNoteOrEmpty(all) {
  if (!all.length) return '<div class="empty-hint">这个区间里没有安排。换个区间看看，或者去任务板加一条。</div>';
  return '<div class="empty-hint">这一类在这个区间里没有。再点一次上面那个数就取消筛选。</div>';
}

/**
 * 功能：触发侧栏上某个入口的点击 —— 首页跳去别的模块的唯一通道（见 `renderHome()` 里的说明）。
 * @param {string} sel - 侧栏入口选择器
 * @returns {void}
 */
function clickNav(sel) {
  const btn = $(sel);
  if (btn) btn.click();
}

/**
 * 功能：课程区为什么是空的，说一句人话 —— 一个学期都没有 / 有学期但没填开学日期。
 * 说明：⚠️ 这两种情况**都不是**「这段时间没课」，不能靠一个空列表让用户自己猜。
 * @param {Object} d - 看板数据
 * @returns {string} 提示行的 HTML；课表关着或一切正常时为空串
 */
function courseNote(d) {
  if (!d.modules.timetable) return '';
  if (d.course_reason === 'no_term') return '<div class="dash-note">课表里还没有学期，课程不会出现在看板上。</div>';
  if (d.course_reason === 'no_start_monday') {
    return '<div class="dash-note">学期的「第 1 周星期一」没填，算不出日期 —— 课程不会出现在看板上。</div>';
  }
  return '';
}
