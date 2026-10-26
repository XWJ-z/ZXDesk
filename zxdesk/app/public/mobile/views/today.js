/**
 * mobile/views/today.js —— 今天（0.4.5 起是**手机版的首页看板**；⭐ 0.8.7 起有两个视图）
 *
 * 功能：渲染「今天」这一屏 —— 顶部区间切换条（静态骨架，在 `index.html` 里）、任务概览，
 *      然后是具体事项列表（课程与任务**分开两块**），最后是各模块的入口卡；
 *      ⭐ 0.8.7起顶部还多一条**视图胶囊**（`列表视图 ｜ 日历视图`）——
 *      第二个视图就是**日历**，由 `mountModuleSlot()` **动态挂载**，本文件不认识那个模块。
 *
 * ⭐⭐ 0.8.61：「首页看板（手机端的今天）…该固定的固定，不应该随着页面
 *      滑动而滑动，参考其它模块的设计。这个模块的定位是看板，应该具备展示和进入各个模块的能力」。
 *      这一轮改了三件事（版式在 `app.css` 的 `#view-today` 那一段，静态骨架在 `index.html`）：
 *      ① **两段式**：胶囊 / 周条 / 筛选面板 / 搜索行 / 任务概览 = **固定段**，
 *         只有 `#today-body` 内部滚 —— 做法与 `#view-board`（任务板）逐字同构；
 *      ② **概览搬出 `#today-body`**：它那五个数是**筛选按钮**，跟着清单滚走等于筛选入口也没了；
 *         现在它住静态槽 `#today-stats`，由本文件的 `renderStats()` 写；
 *      ③ **各模块入口提到清单之前**（原来叫「其它」、排在整页最底下）：看板的另一半职责是
 *         「进各模块」，埋在一屏清单之后等于没有 —— 这句「应该具备…进入各个模块的能力」
 *         说的就是它。⚠️ 卡片形态一个字没改（两列网格的口径）；
 *         改的只是**位置**与那一行标题（「其它」→「各模块」：它现在排在清单前面，
 *         再叫「其它」读着不通）。
 *
 * ⭐ 0.8.7 的三条口径与电脑端**逐条同源**（改这块前先读 `desktop/views/home.js` 的文件头）：
 *    ① 胶囊的项与默认值都是算出来的（`core/dashboard.js` 的 `dashViewDefs()` /
 *       `dashDefaultViewName()`）—— ⛔ 不许写 `if (name === 'calendar')`；
 *    ② **进屏要按偏好重落默认视图**（`switchTab('today')` 调 `snapDashView()`）；
 *    ③ **屏内切视图不重新取数**—— 两份数据分别在 `state.dash.data` 与 `state.cal`。
 *
 * ⭐ 「首页看板这个得大改 / 目前内容全部不要」—— 电脑版与手机版**同一轮一起改**。
 *    老那套（待办总数 + 已逾期 / 7 天内截止 KPI + 今天要做 / 逾期 / 最近截止三块）整块撤掉。
 *
 * ⭐ 0.5.2 又按的反馈改了一遍（反馈单 `docs/fnos/用户反馈/01-2026-09-14-0.5.1-开发者反馈.md`）：
 *    · 概览顺序定死为 待办 / 课程 / 硬件要关注 / 已逾期 / 已完成，且**点一个数就筛出这一类**；
 *    · 「已逾期」以前永远是 0（逾期任务被区间判据滤掉了），判据已挪进 `core/dashboard.js`；
 *    · 多一档**单日**（看任意一天）；课程与任务分开两块；课程备注**加粗标红**；
 *    · 本周按星期 x 分段、本月按自然周分段。
 *
 * ⭐ 0.5.5：① 区间条上**并排两套控件**（选的是「新控件叠加在旧控件上方」，两套都留）——
 *    新周条 `‹ 区间 ›` ＋「今天」＋ 一周 7 格（`dashShiftWeek()` / `dashSetDay()` / `dashGoToday()`），
 *    旧的档位 chip ＋ 两个日期框 ＋ 说明行原样保留；两套**驱动同一个 `state.dash`**，
 *    所以 `renderDashBar()` 必须把它们刷成一致的。
 *    ② 补上电脑端那行「📌 任务概览」（含 日常/项目 与 **已筛选** 提示）—— 两端对齐以电脑端为准。
 *    ③ 列表顶部永远先摆一段「已逾期」，服务端那条预筛也一起放开了。
 *
 * ⭐ 0.5.5（下半场）两条要求：
 *    ④ **「可以直接修改任务而不是跳转」** —— 点一条任务**不再切到任务板**，就地弹详情。
 *      实现落在 `app.js` 的 `dash-open`（换屏是导航的事，见那个文件的说明）。
 *    ⑤ **「任务再分级一下……已逾期、今日截止、本周截止、本月截止，没有则不显示」** ——
 *      列表分成**三块**：📘 课程（按日期分段）/ ✅ 任务（按分级）/ 🧩 数码（按日期分段）。
 *
 * ⭐ 课表 2 期：课程条目上显示倒计时 / 课间文案、上完的加 `is-done` 半灰 ——
 *    判定在 `core/timetable.js` 一份（与电脑版看板、两端课表页逐字一致），刷新只改文本与 class。
 *
 * ⚠️ 与电脑版共用的是 `core/dashboard.js`（区间折算、筛选、分段与「哪条算落在区间里」
 *    都只有那一份），这里只负责摆版式 —— 两端各写一遍判据的后果是「手机上看得到、电脑上看不到」
 *    且不报错。
 * ⚠️ 区间切换条是**静态骨架**：只有 `#today-body` 由本模块重画。两个 `<input type="date">`
 *    若进重画范围，用户正在挑日期的那个原生选择器会被连根换掉。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.61
 * 相关：docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/35-视图切换与过渡动画.md
 */

import { api } from '../../core/api.js';
import {
  DASH_FILTERS,
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
import { addDays, mondayOf, todayStr } from '../../core/date.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
// ⭐ 0.8.15：薄入动画的判据只此一份 —— 见 `swapAnimOnce()` 的说明。
import { swapIn } from '../../core/transition.js';
import { moduleItems } from '../../core/modules.js';
// ⭐ 0.8.7：看板的第二个视图（日历）走**动态挂载**——
//    ⛔ 宿主不许 import 那个模块的片段，也不许写 `if (name === 'calendar')`。
import { mountModuleSlot } from '../../core/slots.js';
import { ttDoneIdsOn, ttNowHM, ttSyncServerNow, ttTodayNow, ttTicker } from '../../core/timetable.js';
import { render } from '../app.js';
import { uiOf } from '../modules.js';
import { state } from '../state.js';
import { CHEV, emptyHtml, errHtml, secHead, toast } from '../ui.js';

// ---------- 取数 ----------

/**
 * 功能：按当前区间拉取看板数据（`GET /api/dashboard`）写进 `state.dash.data`。
 * 说明：⚠️ 失败时**把原因留在 `state.dash.error` 再抛出去** —— 首屏不会因为看板挂了就整页报错
 *      （`data.js` 的 `loadAll()` 只把 bootstrap / tasks 当必需），但这一屏得说清「这块为什么空着」。
 * @returns {Promise.<void>}
 */
async function dashLoad() {
  const r = state.dash.range;
  try {
    state.dash.data = await api('GET', `/api/dashboard?from=${r.from}&to=${r.to}`);
    state.dash.error = null;
  } catch (e) {
    state.dash.data = null;
    state.dash.error = e.message;
    throw e;
  }
}

/**
 * 功能：切到某一档预设（今日 / 单日 / 本周 / 本月）→ 重算区间 → 重新取数 → 重画这一屏。
 * @param {string} preset - `today` / `day` / `week` / `month`
 * @param {string} [base] - 基准日；`day`（单日）那一档用它，缺省为今天。
 *      ⭐ 0.5.5 补上：周条里点某一格 = 「看那一天」，与电脑版 `dashSetPreset(preset, base)` 同一个签名。
 * @returns {Promise.<void>}
 */
export async function dashSetPreset(preset, base) {
  try {
    state.dash.preset = preset;
    state.dash.range = dashRange(preset, base);
    await dashLoad();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把区间**整周前后挪**（周条上的 ‹ ›）—— 挪完落在「本周」这一档。
 * 说明：⭐ 0.5.5 新增，与电脑版同名同义。基准取当前区间的起点再求它所在周的周一，
 *      这样从「单日」或「本月」按一下也能落到**整齐的一周**上。
 * @param {number} delta - 正数往后、负数往前（单位：周）
 * @returns {Promise.<void>}
 */
export async function dashShiftWeek(delta) {
  const mon = mondayOf(state.dash.range.from || todayStr());
  const from = addDays(mon, delta * 7);
  try {
    state.dash.preset = 'week';
    state.dash.range = { from, to: addDays(from, 6) };
    await dashLoad();
    render();
  } catch (e) {
    toast(e.message, true);
  }
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
 * 功能：用户手改日期后重新取数并重画 —— 顺序只管好，不替用户改值（倒过来就换一下）。
 * 说明：⭐ 单日档位下 `to` 那个框是藏起来的，改 `from` 就是「换一天看」——
 *      所以此时 `to` 一律跟着 `from`（否则会拿一个看不见的旧值去查一段莫名的区间）。
 * @param {string} from - 起始日 `YYYY-MM-DD`
 * @param {string} to - 截止日 `YYYY-MM-DD`
 * @returns {Promise.<void>}
 */
export async function dashSetRange(from, to) {
  if (!from) return;
  try {
    const one = state.dash.preset === 'day';
    if (one) {
      state.dash.range = { from, to: from };
    } else {
      if (!to) return;
      state.dash.preset = 'custom';
      state.dash.range = from <= to ? { from, to } : { from: to, to: from };
    }
    await dashLoad();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：点概览上某一个数 —— 把下面的列表筛成这一类；点已选中的那个则取消筛选。
 * 说明：⚠️ 只重画这一屏、**不重新取数**：筛选是纯前端的事，重新取一次只会让界面闪一下。
 * @param {string} key - `DASH_FILTERS` 里的某个 key
 * @returns {void}
 */
export function dashSetFilter(key) {
  state.dash.filter = state.dash.filter === key ? '' : key;
  // ⭐ 0.8.61：结果集换了一批 ⇒ 回顶（停在原位置的话，列表变短后浏览器会把滚动位置
  //    夹到新的底部 —— 用户看到的是「筛出来的最后几条」，最容易误判成「筛错了」）。
  scrollTopToTop();
  renderToday();
}

// ---------- ⭐ 0.8.7：看板顶部的「视图胶囊」与它挂的模块视图 ----------

/**
 * 功能：本端画得出来的**看板视图**清单 —— 清单 ∩ 接线表里声明了 `dashView` 的模块。
 * @returns {Array.<Object>} `moduleItems()` 的条目（已经按清单顺序排好）
 */
const capsuleItems = () => moduleItems(state.modules, uiOf, state.me || {});

/**
 * 功能：按**服务端偏好**把看板的默认视图重落一次（进屏 / 首屏数据到达时调）。
 *
 * 说明：⭐ 判据在 `core/dashboard.js` 的 `dashDefaultViewName()`（两端唯一一份），与电脑端**逐字同源**：
 *      读的是看板载荷里的 `briefs.<模块名>.open_by_default`，⛔ 这里不判第二遍。
 * @returns {void}
 */
export function snapDashView() {
  state.dashView = dashDefaultViewName(capsuleItems(), state.dash.data);
}

/**
 * 功能：切到看板的某个视图（空串 = 列表视图）—— **只改 state 再重画，⛔ 不重新取数**。
 *
 * 说明：⚠️ 与电脑端 `views/home.js` 的 `setDashView()` **同一条口径**（两端各一份版式，
 *      但语义必须一致：认不出来的模块名一律当「列表视图」，见 `renderToday()` 里那句回落）。
 * @param {string} name - 模块名；空串 = 列表视图
 * @returns {void}
 */
export function setDashView(name) {
  const next = typeof name === 'string' ? name : '';
  if (state.dashView === next) return;
  state.dashView = next;
  // ⭐ 0.8.61：两个视图是**两种完全不同的版式**（清单 / 月历），停在原来的滚动位置毫无意义 ——
  //    月历挂上之后会被顶到中间，用户看到的是「一屏不知道自己在哪的日历」。
  //    ⚠️ 只在这一处与「看板数据换了新的一份」时归零；点概览筛选、敲搜索词**不归零**
  //    （那是同一屏内的收窄，位置该留着）。
  scrollTopToTop();
  // ⭐ 0.8.9 修订（「数据不自动刷新，比如我在列表视图点了完成，切换到日历视图
  //    依然显示没有完成，重新进入软件就好了」）—— 与电脑端 `desktop/views/home.js` 的
  //    `setDashView()` **同一处、同一条理由**：切视图只重画不重取，而列表里改过任务之后
  //    `state.cal` 还是旧快照。传 `fresh` 让日历先把旧数据顶上、再在后台重取一次。
  renderToday({ fresh: true });
}

/**
 * 功能：设置页那颗药丸刚被翻过 ⇒ 把宿主内存里的「当前视图」**立刻**拨过去并重画。
 *
 * 说明：⭐ 0.8.7 修订（「设置里把日历视图设成默认之后，进首页看板是
 *      **从列表视图闪现到日历视图**」）：那颗药丸改的是**服务端的偏好**，而宿主手里那份
 *      看板快照还是旧的 ⇒ 不补这一下的话，回「今天」时会先按旧值画一遍列表，
 *      等看板数据回来 `snapDashView()` 才翻到日历 —— 那一次"翻"就是闪。
 *      ⚠️ 认不出来的名字（模块被删 / 没声明 `dashView`）一律回落空串（列表视图），
 *      与 `setDashView()` / `renderToday()` 里那句同源，⛔ 别在这里另判一套。
 * @param {string} name - 模块名；空串 = 列表视图
 * @returns {void}
 * @since 0.8.6
 */
export function applyDashViewDefault(name) {
  const v = typeof name === 'string' ? name : '';
  state.dashView = dashViewDefs(capsuleItems()).some((it) => it.name === v) ? v : '';
  renderToday();
}

/**
 * 功能：画看板顶部那条**视图胶囊** —— `列表视图 ｜ <各模块贡献的视图>`（0.8.7）。
 *
 * 说明：⭐ 项**全是算出来的**（`dashViewDefs()`），⛔ 本文件不认识任何具体模块名。
 *      ⚠️ `views` 为空 ⇒ **整条胶囊不画**（只有一种视图时，一条切换控件是纯噪音；
 *      这也正是「删掉 `modules/calendar/` 之后一颗死胶囊都不剩」的落地处）。
 *
 * @param {Array.<Object>} views - `dashViewDefs()` 的产物
 * @param {string} active - 当前生效的视图（空串 = 列表视图）
 * @returns {string} 胶囊的 HTML；没视图可切时为空串
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
      aria-selected="${cur === key}" data-act="dash-view" data-view="${esc(key)}">${esc(label)}</button>`;
  return `<div class="dash-tabs" role="tablist">${tab('', '列表视图')}${views
    .map((it) => tab(it.name, it.dashView.label))
    .join('')}</div>`;
}

/**
 * 功能：把胶囊画进**页面最顶上**那个固定槽（`#today-tabs`）—— 0.8.7 起它住在 `#view-today`
 *      的第一行（区间条之上），与电脑端的「标题行」同一个位置感。
 *
 * 说明：⚠️ 槽是静态节点（`mobile/index.html` 里的空 div）、内容每次重画 ⇒ 本端**不需要**在这里
 *      绑点击：那颗按钮走 `data-act="dash-view"` + 宿主的动作表（`mobile/app.js` 的 `ACTIONS`），
 *      委托挂在 `document` 上 —— 重画多少遍都照样生效。
 *      ⚠️ 没有视图可切时写的是空串 ⇒ 槽空着，靠 `.dash-tabs-row:empty` 收掉占位。
 *
 * @param {Array.<Object>} views - `dashViewDefs()` 的产物
 * @param {string} view - 当前生效的视图（空串 = 列表视图）
 * @returns {void}
 */
function renderCapsule(views, view) {
  const box = $('#today-tabs');
  if (!box) return;
  box.innerHTML = capsuleHtml(views, view);
}

/** 上一次画的是哪个视图（空串 = 列表视图）；`null` = 还没画过。见 `swapAnimOnce()` */
let lastView = null;

/**
 * 功能：两个视图之间切换时，给内容容器播一次淡入 —— 「闪一下」的观感修正。
 *
 * 说明：⭐ 「列表视图和日历视图切换会闪一下，体验不好，建议加一个过渡动画」。
 *      闪的来源是 `#today-body` 被**整块换掉**（左边那套 DOM 瞬间消失、右边那套瞬间出现），
 *      而日历还要等自己的数据 ⇒ 中间有一段"什么都没有"。一条短淡入就把这段缝上。
 *      ⚠️ **只在视图真的换了时播**：改区间 / 点一个筛选数 / 后台刷新都会重画，
 *      那些是**同一屏内的刷新**，跟着抖一下反而更像故障。
 *      ⚠️ 动效在 `app.css` 的 `#today-body.is-swap` 里；`prefers-reduced-motion` 降级在那边。
 *      ⭐⭐ 0.8.15：本函数从前**手抄了一遍**「撤类 → 强制重排 → 加类」
 *      （那是全仓第二份实现）—— 现在改调 `core/transition.js` 的 `swapIn()`，
 *      本函数只负责**判「是不是真的换了视图」**（机制只一处，与电脑端 `home.js` 同形）。
 * @param {HTMLElement} box - 内容容器（`#today-body`）
 * @param {string} view - 这一次画的视图（空串 = 列表）
 * @returns {void}
 */
function swapAnimOnce(box, view) {
  // ⭐⭐ 0.8.15：`null` = **这一次是首屏**，不是「切换」—— 首屏那一下由 `switchTab()` 的
  //    **整屏**动画负责（`#view-today` 上的 `is-swap`， 新加的）。
  //    两处一起播 = 同一块内容连淡两次（外层与内层同一帧起）⇒ 看着是「闪两下」，
  //    比不加还差。⚠️ 判据与电脑端 `home.js` 的 `swapAnimOnce()` **逐字同源**，⛔ 别只改一端。
  if (lastView === null) {
    lastView = view;
    return;
  }
  if (lastView === view) return;
  lastView = view;
  // ⭐ 0.8.51：`tier 2` —— 与电脑端 `home.js` 的 `swapAnimOnce()` **同一个级**（胶囊切换）。
  swapIn(box, 2);
}

/**
 * 上一次画「今天」时用的那份看板数据 —— 用来判「这次要不要让挂在里面的模块视图重取数据」。
 *
 * 说明：⭐ `state.dash.data` 每次取数都是**新对象**（`dashLoad()` / `loadAll()` 直接赋值）⇒
 *      「不是同一份」就等于「看板刚取数回来」。与电脑端 `loadHome()` 传 `fresh: true` 同一条口径，
 *      只是这一端没有那条「取数与渲染分开」的路径，所以用对象身份来判。
 * @type {?Object}
 */
let lastDashData = null;

/**
 * 功能：点看板顶部那条胶囊里的一颗 —— 切视图（**只改 state 再重画，⛔ 不重新取数**）。
 *
 * 说明：⚠️ 动作名 `dash-view` 与 `data-view` 必须与 `mobile/app.js` 的 `ACTIONS` 表**逐字一致**
 *      （手机端动作表是显式登记的，对不上就是「点了没反应」且**不报错**）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 被点的那颗按钮（`dataset.view` 是视图键，空串 = 列表视图）
 * @returns {void}
 */
export function dashPickView(_act, n) {
  setDashView(String((n && n.dataset && n.dataset.view) || ''));
}

// ---------- 渲染 ----------

/**
 * 功能：把「今天」的**滚动区**拉回顶部。
 *
 * 说明：⭐ 0.8.61：这一屏改成两段式之后，滚动落在 `#today-body` 自己身上（不再是 `.view`）。
 *      ⚠️ 三处调它：**换视图**（`setDashView()`）、**看板数据换成了新的一份**（刚取过数 ——
 *      换区间 / 点右上角 ↻ 都走这条）、**筛选或搜索把结果集换了一批**（`dashSetFilter()` /
 *      搜索框的 `input`）。这三件事之后停在原来的位置都没有意义。
 *      ⛔ **切标签回来不调**：那时数据还是同一份，用户就是回来接着看的
 *      （`.view` 用 `display:none` 保留各屏滚动位置，这条语义在这一屏同样成立）。
 * @returns {void}
 */
function scrollTopToTop() {
  const el = $('#today-body');
  if (el) el.scrollTop = 0;
}

/**
 * 功能：把「任务概览」那块写进**固定槽** `#today-stats`（⭐ 0.8.61 起它不再住在 `#today-body` 里）。
 *
 * 说明：⚠️ 槽是静态节点（`mobile/index.html`），内容每次重画 ⇒ 与 `renderCapsule()` 同一手法。
 *      清空时传空串 —— 槽靠 `#today-stats:empty` 收掉占位，空 div 不留高度。
 *      ⚠️ 它与 `#today-body` 的两块内容（清单 / 日历）**同在** `renderToday()` 里画：
 *      概览那两个数（`dashStats()`）与清单读的是同一份 `state.dash.data`，
 *      分开画就会在「数据刚换、body 还没画」的那一帧出现「数变了、列表还是旧的」。
 * @param {string} html - `statsBlockHtml()` 的产物；空串 = 清空
 * @returns {void}
 */
function renderStats(html) {
  const box = $('#today-stats');
  if (!box) return;
  box.innerHTML = html || '';
}

/**
 * 功能：把区间切换条刷成当前状态 —— 上半是 0.5.5 新增的**周条**（区间行 + 一周 7 格），
 *      下半是原有的档位 chip / 两个日期框 / 说明行（只改静态节点的属性、类名与文字，绝不重建节点）。
 * 说明：⭐ 单日档位下**只留一个日期框**（两个框会让人以为要填一段区间，而这里只要「挑一天」）。
 *      ⭐ 0.5.5：两套控件**驱动同一个 state**，所以这一处就得把它们刷成一致的 ——
 *      周条的 7 格跟着当前区间所在的那一周走，选中的那一格 = 「区间收敛成的那一天」。
 * @returns {void}
 */
function renderDashBar() {
  // ⚠️ 首屏还没算过区间（`data.js` 才现算一次）时，这里照当前档位兜一个 —— 条形不能是空的
  const range = state.dash.range.from ? state.dash.range : dashRange(state.dash.preset);
  const { preset } = state.dash;
  document.querySelectorAll('#dash-presets .chip').forEach((b) => {
    b.classList.toggle('on', b.dataset.dash === preset);
  });
  const f = $('#dash-from');
  const to = $('#dash-to');
  if (f && f.value !== range.from) f.value = range.from;
  if (to && to.value !== range.to) to.value = range.to;
  const oneDay = preset === 'day';
  if (to) to.hidden = oneDay;
  const sep = $('.dash-dash');
  if (sep) sep.hidden = oneDay;
  // ⭐ 0.5.5：说明行的文案与周条顶部那行**共用 `dashRangeLabel()`**（两处各写一遍就会自相矛盾）
  const note = $('#dash-range-note');
  if (note) note.textContent = dashRangeLabel(range);

  // ---- 周条（0.5.5）：顶部那行 + 一周 7 格 ----
  const wr = $('#dash-week-range');
  if (wr) wr.textContent = dashRangeLabel(range);
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
 * 功能：把一组（某一天 / 某一周）的条目画成一张表 —— 段标题 + 若干行。
 * @param {{key: string, label: string, items: Array.<Object>}} g - `dashGroups()` 或 `dashTaskTiers()` 的一段
 * @returns {string} 这一段的 HTML；段标题为空串时（今日 / 单日 / 自定义区间）不画标题
 */
function groupsHtml(g) {
  return `${g.label ? `<div class="dash-group">${esc(g.label)}</div>` : ''}
    <div class="dash-list">${g.items.map(dashRowHtml).join('')}</div>`;
}

/**
 * 功能：画出一条具体事项 —— 图标 / 标题 / 备注 / 归属，以及任务上绑的网址。
 * 说明：⭐ 课程备注**加粗标红**；任务上绑的网址显示标题、点它开网址。
 * @param {Object} x - `dashEntries()` 的一条
 * @param {number} i - 下标，用于错峰入场动画
 * @returns {string} 这一行的 HTML
 */
function dashRowHtml(x, i) {
  // ⭐ 0.7.1：两条备注**口径已分开**，两条都画 ——
  //    📝 `x.remark` = **本节备注**（这一天这一节，来自 `timetable_day_notes`；看板列的是
  //    「某一天的课」，所以带上那一天的那一条）；📌 `x.course_remark` = 课程备注（这门课的每一节）。
  //    两者靠颜色区分（红 = 这一节，品牌色 = 这门课，见 `.dash-remark`）。
  // ⭐ 0.6.8（报「手机端显示不全」）：两条**各占一行、画在标题下方** ——
  //    从前它们跟在标题尾巴上（各自限宽 30% + 省略号），手机屏窄，两条稍长就互相吃掉、
  //    标题也被挤没。现在标题自己一行，📝 一行、📌 一行（排版在 `.dash-remark`）。
  //    ⚠️ 只管手机端：电脑版宽裕，仍是「标题后一行」，模板在 `desktop/views/home.js`（各写一份）。
  //    ⚠️ 任务 / 硬件那几类条目没有这两个字段，拼出来就是空串，不受影响。
  // ⭐ 0.7.2：任务的重要 / 紧急徽章（「看不到任务的紧急和重要」）——
  //    与电脑版**同一份数据、同一套文案**（模板各写一份，口径必须一致）。
  //    位置：**标题下面另起一行**（同日定的「手机端另起一行显示」）——
  //    电脑版宽裕，跟在标题同一行尾巴上；手机屏窄，挤在标题尾部会把标题压得只剩几个字。
  //    ⚠️ 所以这里**不动** `.dash-title`：它仍是整行的 nowrap + 末尾省略号（标题自己截断），
  //    徽章走下面独立的 `.dash-flags` 一行 —— 与电脑版那套 flex 改写无关，别照搬过去。
  const flags =
    (x.important ? '<span class="dash-flag imp">🔴 重要</span>' : '') +
    (x.urgent ? '<span class="dash-flag urg">⏰ 紧急</span>' : '');
  /** 功能：两枚徽章的整行容器；一枚都没有时**不产生节点**（空 div 会白占一条行高）。 */
  const flagsRow = flags ? `<div class="dash-flags">${flags}</div>` : '';
  const remark =
    (x.remark ? `<span class="dash-remark">📝 ${esc(x.remark)}</span>` : '') +
    (x.course_remark ? `<span class="dash-remark course">📌 ${esc(x.course_remark)}</span>` : '');
  const link = x.bookmark
    ? `<span class="dash-link" data-act="dash-link" data-url="${esc(x.bookmark.url)}">🔗 ${esc(
        x.bookmark.title || x.bookmark.url,
      )}</span>`
    : '';
  // ⭐ 课表 2 期：课程行多摆一枚**倒计时的专门文本节点**（渲染时空着，
  //    由 `dashLiveTick()` 填字）—— ⛔ 刷新只改这里的 textContent 与 `is-done` 类，绝不重画看板。
  const live = x.kind === 'course' ? `<span class="dash-live" data-live="${esc(x.key)}"></span>` : '';
  return `<div class="dash-row rise${x.overdue ? ' over' : ''}${x.done ? ' done' : ''}${
    x.rescheduled ? ' is-resched' : ''
  }" style="--i:${Math.min(i, 8)}"
      data-act="dash-open" data-kind="${esc(x.kind)}" data-src="${esc(x.source === undefined ? '' : x.source)}"
      data-id="${x.id === undefined ? '' : x.id}">
      <span class="dash-ico" style="--c:${esc(x.color || '#4f46e5')}">${esc(x.icon)}</span>
      <div class="dash-main">
        <div class="dash-title">${esc(x.title)}</div>
        ${flagsRow}
        ${remark}
        <div class="dash-meta">${esc(x.meta)}${link}${live}</div>
      </div>
      <span class="dash-src">${esc(x.name)}</span>
      <span class="row-chev">${CHEV}</span>
    </div>`;
}

/**
 * 功能：「今天」看板的一拍 —— 改课程行的 `is-done` 类（**区间里的每一天都算**），并只给今天
 *      那批行填倒计时 / 课间文案；**绝不重画看板**（重画会丢滚动位置， 同源）。
 *
 * 说明：⭐ 判定与文案来自 `core/timetable.js`（唯一一份），与电脑版看板、两端课表页
 *      **同一份数据口径**，文案逐字一致。
 *      ⭐ 0.6.2：变灰按每条自己的日期算 —— 看「本周」时周一、周二的课同样要灰；
 *      从前只认「今天」那一批，翻过零点就恢复原色。非今天的行只变灰、不给文案。
 * @returns {void}
 */
function dashLiveTick() {
  const d = state.dash.data;
  if (!d) return;
  ttSyncServerNow(d.now);
  const t = ttNowHM();
  // 快照是别的天拉的（跨了零点没刷新）→ 冻结，不画「看似在走、其实是昨天」的假倒计时
  if (d.today && d.today !== t.date) return;
  // ⭐ 0.6.2：看板区间可能是本周 / 本月 —— **过去的日子也要灰**（不止今天那一批）。
  //    按日期分组各算各的：今天那份连文案（倒计时 / 课间）一起算，别的日子只判「上过没有」。
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
  document.querySelectorAll('#today-body .dash-live').forEach((live) => {
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
 * 功能：渲染「今天」整屏 —— 视图胶囊、概览、具体事项、收藏夹 / 消息，并绑上跳转。
 *      数据还没到位时先出骨架屏；看板接口挂了给出错块（**不再永远停在骨架上**，见文件头）；
 *      整个工作台都是空的时候给引导入口。
 *
 * 说明：⭐ 0.8.7：这一屏自 0.8.7 起有**两个视图** —— 它自己的**列表视图**（下面这一整套）
 *      与**模块贡献的视图**（0.8.7 起是「日历视图」，由 `mountModuleSlot()` 动态挂载）。
 *      「现在看哪个」住 `state.dashView`，判据全部来自接线表的 `dashView` 声明 ——
 *      ⛔ 本文件不认识任何具体模块名。
 *
 * @param {Object} [opts] - `{ fresh: true }` = **进屏**这一次（或看板数据刚取回来）⇒
 *      挂着的模块视图也要重取一次自己的数据（见下面 `fresh` 的算法）
 * @returns {void}
 */
export function renderToday(opts) {
  renderDashBar();
  // ⭐⭐ 第六轮（「各部分都应该是**逐级返回到【今天】**，今天再返回就是退出」）：
  //    ⚠️ **这一屏不登记「退一层」** —— 它是那条原则里的**终点**：站在「今天」按返回
  //    就是退出应用（`popstate` 的第 ④ 层）。看板顶部那条胶囊（列表 ｜ 日历）是**同一层**的
  //    两个视图，不是「下一层」—— 把它也算一层的话，「今天」就永远不是终点，
  //    那句「今天再返回就是退出」当场失效。
  //    ⛔ 别给这一屏接 `setBackHandler('today', …)`。
  // ⭐ 0.8.9：搜索框的 `input`（**只挂一次**，它是静态骨架）
  bindDashSearch();
  const el = $('#today-body');
  if (!el) return;

  // ---- ⭐ 0.8.7：页面最顶上那条「视图胶囊」＋「现在看的是哪个视图」----
  // ⚠️⭐ 「把切换按钮放【首页看板】这个标题处」⇒ 它画进 `#today-tabs`
  //    （`#view-today` 的第一行、区间条**之上**），**不在 `#today-body` 里**：
  //    那个容器每画一次就被整个换掉，而这条胶囊**两个视图下都得在**（列表 / 日历）。
  //    ⚠️ 手机端的「标题」是顶栏那行 —— 它是**全局固定栏**、还得同时装标题与副标题，
  //    塞不进一颗胶囊 ⇒ 落在内容区第一行（与电脑端「标题行」同一个位置感）。
  //    ⚠️ 它在**取数之前**就画：项与选中态只来自模块清单与 `state.dashView`，与看板数据无关
  //    （数据还没回来时胶囊也该在，否则骨架那一下会闪一下空头）。
  const views = dashViewDefs(capsuleItems());
  const view = views.some((it) => it.name === state.dashView) ? state.dashView : '';
  renderCapsule(views, view);

  // ⭐ 0.8.7 修订：「日历视图不要显示这玩意」—— 他圈掉的是**区间条**
  //    （周条 + 档位 + 两个日期框 + 说明行）。它管的是「这段时间」，而日历有自己的月导航
  //    ⇒ 日历视图下整块收起来，别让两套「范围」控件同屏打架。
  //    ⚠️ 这几块是**静态骨架** ⇒ 只切 `hidden`、⛔ 不重建节点（两个 `<input type="date">`
  //    连根换掉就会丢掉用户正在挑的那个原生选择器）；两端 `app.css` 都有
  //    `[hidden] { display: none !important }` 兜底（UA 那条没有 `!important`，
  //    会被 `.dash-range` 自己的 display 静默盖掉 —— 这个坑本项目记过）。
  // ⭐ 0.8.9：「这三个变为一个：筛选图标…还增加一个搜索图标（放大镜）」——
  //    区间条与搜索行都**不再常驻**，显隐由「点了哪颗图标」＋「是不是列表视图」两个来源合成
  //    （与电脑端 `desktop/views/home.js` 的 `syncDashPanels()` **逐字同构**）。
  syncDashPanels(view);
  // ⭐ 换了视图 ⇒ 播一次淡入（同视图内部的刷新不播，见 `swapAnimOnce()`）
  swapAnimOnce(el, view);

  const d = state.dash.data;
  if (!d) {
    // ⭐ 0.8.61：概览住在**固定段**（`#today-stats`）⇒ 数据没到 / 取数失败时也要把它清空。
    //    不清的话，上一次那几个数会留在屏上，与下面的骨架屏或错误块**同屏**
    //    —— 看着像「数据是好的，只是列表没出来」，比空着更误导。
    renderStats('');
    // ⭐ 0.5.2：看板取数失败要说出来并给一条出路 —— 以前这里是骨架屏，
    //    一旦请求超时就永远停在「正在读取」，界面看着像死机（报的那个 bug）
    el.innerHTML = state.dash.error ? errHtml(state.dash.error) : skeletonHtml(4);
    return;
  }
  // ⭐ 0.8.7：「这一次要不要让挂着的模块视图重取数据」—— 三个来源任一为真：
  //    ① 进屏（`switchTab('today')` 传了 `fresh`）；② 看板数据换成了**新的一份**（刚取过数）；
  //    ⚠️ 屏内切视图 / 改筛选**不重取**，它们走的是同一个 `d`、也不传 `fresh`。
  const dataChanged = d !== lastDashData;
  const fresh = !!(opts && opts.fresh) || dataChanged;
  lastDashData = d;
  // ⭐ 0.8.61：**刚取过数**（换区间 / 点右上角 ↻）= 内容整批换过了 ⇒ 回顶。
  //    ⚠️ 与「进屏」分开判：切标签回来时数据仍是同一份，滚动位置要**留着**
  //    （`.view` 用 `display:none` 保留各屏滚动位置，这条语义在这一屏同样成立）。
  if (dataChanged) scrollTopToTop();

  // ⚠️ 下面这几份**两个视图都要用**（概览那几个数、「各模块」那几块卡），所以提到视图分流之前算。
  const tot = d.totals || { projects: 0, project_tasks: 0, daily_tasks: 0 };
  const all = dashEntries(d);
  const st = dashStats(all);
  // ⭐ 0.8.9：先按概览点的那一类筛，再按**搜索词**筛 —— 两个都是纯前端的
  const entries = dashSearch(dashFilter(all, state.dash.filter), state.dash.q);

  // ⭐ 0.8.7 修订：「日历视图要有任务概览和其它模块入口」——
  //    这两块**两个视图共用**（概览给的是几个数、「各模块」给的是入口，都不是列表专属）；
  //    日历替换的只是**中间那块主体**（「这段时间要做的事」）。
  // ⭐ 0.8.61：概览**不再拼进 `#today-body`**，它写进固定槽（见 `renderStats()` 的说明）。
  //    ⚠️ 必须写在 body 之前：body 那一支有三个出口（骨架 / 空态 / 两视图），
  //    在出口里各写一次就是三份，迟早分家。
  const statsBlock = statsBlockHtml(st, state.dash.filter);
  const itemsBlock = itemsBlockHtml(entries, all, d);
  // ⭐ 0.8.61：**筛选 / 搜索生效时，列表视图不画「各模块」** —— 那一刻清单是主角，
  //    用户点完一个数（或敲了搜索词）该**立刻看到结果**，而不是先看到一屏模块卡
  //    （模块卡现在排在清单之前，不藏起来就成了「点了数字、界面只换了几张卡」）。
  //    ⚠️ 只作用于**列表视图**：日历视图下清单本来就不画（0.8.9 定的），藏掉模块卡
  //    只会让那一屏只剩日历、连出口都没有 —— 那一支保持原样。
  const narrowing = !view && (!!state.dash.filter || !!state.dash.q);
  const briefsBlock = narrowing ? '' : briefsBlockHtml();
  renderStats(statsBlock);

  // ---- 模块贡献的视图（0.8.7：日历）----
  if (view) {
    // ⭐ 0.8.9（「首页看板的日历视图混入了列表」）：这一支里只有
    //    日历 → 各模块，⛔ **不放「这段时间要做的事」**（理由与电脑端逐字相同，
    //    见 `desktop/views/home.js` 同一处的注释）。清单只属于列表视图。
    //    ⭐ 0.8.61：概览搬去固定段之后，这里只剩日历与「各模块」两块。
    el.innerHTML = `<div id="dashview-host"></div>${briefsBlock}`;
    // ⭐ 动态挂载：宿主只给容器与上下文，界面全在那个模块里。
    mountModuleSlot($('#dashview-host'), 'mobile', view, 'dash-view', {
      end: 'mobile',
      modules: state.modules,
      uiOf,
      me: state.me,
      // ⚠️ `fresh` 原样转交：日历据此决定「这一次要不要重取自己的数据」
      fresh,
    });
    return;
  }

  // 空态：整个工作台什么都没有时给一条明确的起点。
  // ⚠️⭐ 它**只作用于列表视图** —— 日历视图的出路是「在日历上建一条事件」，不是「先记一条日常任务」，
  //    所以这一支必须放在 `if (view)` **之后**。
  //    ⚠️ 位置踩过一次：先判空态 ⇒ 空工作台时点「日历视图」只会看到这块空态、日历**压根不挂**
  //    （表现就是「切换按钮点了、内容没变」，而且不报错）——`calendar-life-probe` 抓到的正是它。
  if (!tot.projects && !tot.project_tasks && !tot.daily_tasks && !d.timetable.terms) {
    // ⭐ 0.8.61：空工作台时概览那五个数**全是 0**，画出来只占屏幕（改造前它整块被这块空态盖掉，
    //    现在概览在固定段、盖不掉 ⇒ 必须显式清空）。
    renderStats('');
    el.innerHTML = `<div class="sec">${emptyHtml(
      '🗂',
      '工作台还是空的',
      '点右下角 ＋ 先记一条日常任务，或者去「项目」建一个项目',
    )}</div>`;
    return;
  }

  // ---- 列表视图：① 各模块（入口） ② 这段时间要做的事（清单）----
  // ⭐⭐ 0.8.61：这两块**顺序对调**（改造前是 清单 → 其它）。
  //    这一轮的口径：「这个模块的定位是看板，应该具备展示和进入各个模块的能力」——
  //    「其它」埋在一屏清单之后，等于没有入口：看「本月」档位时清单几十条，得滚半天才摸到门。
  //    现在第一屏就是「概览的几个数 + 各模块的入口 + 清单开头」，往下滚才是清单的剩余部分。
  //    ⚠️ 卡片形态**一个字没改**（两列网格的口径）—— 动的只有位置。
  //    ⚠️ 电脑端仍是「概览 → 清单 → 其它」：宽屏一屏放得下，不必挪（版式各写一份）。
  let html = briefsBlock;
  html += itemsBlock;

  el.innerHTML = html;
  // ⭐ 课表 2 期：看板画完立刻挂上倒计时（挂＝替换；首拍就是挂上时立刻跑的那一下）
  ttTicker(true, dashLiveTick);
}

/**
 * 功能：把「筛选」与「搜索」两块面板的显隐、以及两颗图标的展开态刷成当前状态。
 *
 * 说明：⭐ 0.8.9：「这三个变为一个：筛选图标，点击筛选向下展开出
 *      单日、本周、本月、自定义区间；还增加一个搜索图标（放大镜），点击出现输入框。
 *      这两个图标放到【今天】的旁边」。
 *      ⚠️ 显隐有**两个来源**，一律在这一处合成（与电脑端**逐字同构**）：
 *      ① **用户点了哪颗图标**（`state.dash.panel`，两块互斥）；
 *      ② **当前是不是列表视图** —— 这套控件管的是「这段时间」，而日历视图有自己的月导航
 *         （0.8.7 既定的口径，一个字没变）。
 *      ⛔ 别让 CSS 或另一处 JS 各判一半。
 *      ⚠️ 两块都是**静态骨架** ⇒ 只切 `hidden`、⛔ 不重建节点：`#dash-q` 是个「边打边筛」
 *      的输入框，重建一次焦点就没了；两个 `<input type="date">` 同理。
 *      ⚠️ `hidden` 会被 `.dash-range` 自己的 display 静默盖掉（UA 那条没有 `!important`）——
 *      两端 `app.css` 各有一条 `[hidden] { display: none !important }` 兜底，⛔ 别删。
 *
 * @param {string} view - 当前视图（空串 = 看板自己的列表视图）
 * @returns {void}
 */
function syncDashPanels(view) {
  const onList = !view;
  const week = $('.dash-week');
  if (week) week.hidden = !onList;
  const range = $('.dash-range');
  if (range) range.hidden = !onList || state.dash.panel !== 'filter';
  const search = $('#dash-search');
  if (search) search.hidden = !onList || state.dash.panel !== 'search';
  for (const [sel, n] of [
    ['#dash-filter-btn', range],
    ['#dash-search-btn', search],
  ]) {
    const b = document.querySelector(sel);
    if (b) b.setAttribute('aria-expanded', String(!!n && !n.hidden));
  }
  // ⚠️ 记下当前视图：`dashTogglePanel()` 只改 state、不重画看板（重画会抹掉输入框的焦点），
  //    所以它需要一个「现在是不是日历视图」的判据 —— 只有 `renderToday()` 知道。
  curDashView = view;
}

/**
 * 当前视图（空串 = 列表视图）—— 见 `syncDashPanels()` 最后那段说明。 @type {string} */
let curDashView = '';

/**
 * 功能：点周条那颗「筛选」/「放大镜」图标 —— 展开 / 收起对应的那一块（两块互斥）。
 *
 * 说明：⚠️ 只改 `state` 再同步一次显隐，**不重画看板**（重画会把搜索框与两个日期框的焦点抹掉）。
 *      手机端的动作表是**显式登记**的 ⇒ 这个键还要在 `mobile/app.js` 的 `ACTIONS` 里加一行
 *      （漏登记 = 那颗按钮「点了没反应」且**不报错**）。
 * @param {string} panel - 要展开的那一块（`'filter'` | `'search'`）
 * @returns {void}
 */
export function dashTogglePanel(panel) {
  const want = panel === 'search' ? 'search' : 'filter';
  state.dash.panel = state.dash.panel === want ? '' : want;
  syncDashPanels(curDashView);
  if (state.dash.panel === 'search') {
    const q = $('#dash-q');
    if (q) q.focus();
  }
}

/** 搜索框的 `input` 监听**只挂一次**（它是静态骨架，重挂会叠加） @type {boolean} */
let dashSearchBound = false;

/**
 * 功能：给搜索框挂 `input`（只挂一次）—— 敲一个字就重画 `#today-body`。
 *
 * 说明：⚠️ 搜索是**纯前端**筛（`core/dashboard.js` 的 `dashSearch()`）；输入框在**静态骨架**里，
 *      重画的只是 `#today-body` ⇒ 光标与已输入的内容都稳稳留着。
 *      ⚠️ 不防抖是刻意的：筛的是内存里的数组，条目通常几十条。
 * @returns {void}
 */
function bindDashSearch() {
  if (dashSearchBound) return;
  dashSearchBound = true;
  const q = $('#dash-q');
  if (q) {
    q.addEventListener('input', () => {
      state.dash.q = q.value;
      // ⭐ 0.8.61：与 `dashSetFilter()` 同一条理由 —— 结果集换了就回顶（见 `scrollTopToTop()`）。
      //    ⚠️ 不防抖是刻意的（筛的是内存数组），回顶也跟着每次输入走：输入框在**固定段**、
      //    不随滚动移动，所以回顶不会打断打字。
      scrollTopToTop();
      renderToday();
    });
  }
}

/**
 * 功能：画「📌 任务概览」那一块（标题 + 五个数 + 进度条 + 完成度说明）—— ⭐ **两个视图共用**。
 *
 * 说明：顺序与口径都由 `DASH_FILTERS` 定（**点一个数就筛出这一类**）。
 *      ⭐ 0.5.5：补齐电脑端那行「📌 任务概览」—— 选的是「两端对齐以电脑端为准」。
 *      以前手机端把「日常 N / 项目 M」塞在完成度那行里，而「点了某个数筛过」在界面上
 *      **没有任何文字提示**（只有那颗数自己的高亮）—— 那是与电脑端的真实差异，不是版式差异。
 *      ⚠️⭐ 它原来内联在列表视图那段里 —— 日历视图**也要有它**，
 *      所以抽成一份：抄第二份的下场是「换个视图同一个数就变了」，而且**不报错**。
 * @param {Object} st - `dashStats()` 的产物
 * @param {string} filter - 当前生效的筛选键（空串 = 不筛）
 * @returns {string} 这一块的 HTML
 */
function statsBlockHtml(st, filter) {
  const statsHtml = DASH_FILTERS.map((f) => {
    const n = st[f.key];
    const warn = (f.key === 'overdue' || f.key === 'hardware') && n > 0;
    return `<button class="dash-stat${filter === f.key ? ' on' : ''}" type="button"
      data-act="dash-filter" data-filter="${esc(f.key)}" aria-pressed="${filter === f.key}">
      <b class="dash-num${warn ? ' warn' : ''}">${n}</b><span class="dash-lbl">${esc(f.label)}</span></button>`;
  }).join('');
  return `<div class="dash-h">📌 任务概览<span>日常 ${st.daily} · 项目 ${st.project}${
    filter ? ' · 已筛选：' + esc((DASH_FILTERS.find((f) => f.key === filter) || {}).label || '') : ''
  }</span></div>
  <div class="dash-stats">${statsHtml}</div>
  <div class="dash-progress"><i style="width:${st.progress}%"></i></div>
  <div class="dash-progress-cap">区间内任务完成度 <b>${st.progress}%</b>（${st.done} / ${st.total}）</div>`;
}

/**
 * 功能：画「各模块」那一块（段头 + 各模块一张卡）—— ⭐ **两个视图共用**（同 `statsBlockHtml()`）。
 *
 * 说明：⭐ 0.8.61：这一块从前叫「其它」、排在整页**最底下**；现在叫「各模块」、
 *      排在**清单之前**（列表视图）或**日历之后**（日历视图）。名字跟着位置改 ——
 *      把它摆在第一屏还叫「其它」，读着不通。
 *      ⚠️ 电脑端**同一步、同一个名字**（「两端同步」）—— 两端这一块都叫「各模块」、
 *      都排在清单之前；只有版式各写一份。
 * @returns {string} 这一块的 HTML
 */
function briefsBlockHtml() {
  return `<div class="sec">${secHead('各模块', '#64748b', '')}${briefsHtml()}</div>`;
}

/**
 * 功能：画「这段时间要做的事」那一块（清单主体）—— ⭐ **两个视图共用**。
 *
 * 说明：⭐ 「日历视图和列表视图是**完全平级**的，这两个都要能**展示任务**」。
 *      ⚠️ 它同时是**筛选数字的落点**：上面「任务概览」点一个数就是「把这块筛成这一类」——
 *      少了它，在日历视图下点那个数就变成「按钮亮了、但没有任何地方能看到结果」。
 *      ⚠️ 在日历视图里它排在**日历下面**：日历是那个视图的主体，清单是补充（别抢首屏）。
 *      ⭐ 0.5.5 分**三块**：📘 课程 / ✅ 任务 / 🧩 数码 —— 与电脑版逐块对齐（同一份判据见
 *      `core/dashboard.js` 的文件头）：
 *      · 任务走 `dashTaskTiers()` 的分级（已逾期 / 今日截止 / 本周截止 / 本月截止 / 更晚 / 已完成，
 *        **空的分级不返回**，所以「没有则不显示」是自动的）；
 *      · 课程与数码没有「截止」这层语义，仍按日期分段（本周按星期 x、本月按自然周）。
 *      ⚠️ 数码（台账）以前混在「✅ 任务」块里 —— 分级只认任务，留着它就会画出「本月截止的一件 NAS 硬盘」。
 *      ⚠️ 这一段读的是**服务端数据的种类键** `kind === 'hardware'`（表名 / 接口前缀那套契约，
 *      ⛔ 不随模块 0.8.10 的显示名改名）。
 * @param {Array.<Object>} entries - 当前筛选后的事项
 * @param {Array.<Object>} all - 未筛选的全部事项（判空文案用）
 * @param {Object} d - 看板载荷（课程「为什么没画出来」的说明用它）
 * @returns {string} 这一块的 HTML
 */
function itemsBlockHtml(entries, all, d) {
  let html = `<div class="sec">${secHead('这段时间要做的事', '#4f46e5', entries.length + ' 条')}`;
  if (entries.length) {
    const lessons = entries.filter((x) => x.kind === 'course');
    const tasks = entries.filter((x) => x.kind === 'task');
    const hws = entries.filter((x) => x.kind === 'hardware');
    if (lessons.length) {
      html += `<div class="dash-sub">📘 课程<span>${lessons.length} 节</span></div>`;
      html += dashGroups(lessons, state.dash.preset).map(groupsHtml).join('');
    }
    if (tasks.length) {
      html += `<div class="dash-sub">✅ 任务<span>${tasks.length} 条</span></div>`;
      html += dashTaskTiers(tasks).map(groupsHtml).join('');
    }
    if (hws.length) {
      html += `<div class="dash-sub">🧩 数码<span>${hws.length} 件</span></div>`;
      html += dashGroups(hws, state.dash.preset).map(groupsHtml).join('');
    }
  } else {
    html += all.length
      ? '<div class="empty"><div class="empty-text">这一类在这个区间里没有。再点一次上面那个数就取消筛选。</div></div>'
      : emptyHtml('🌤', '这个区间里没有安排', '换个区间看看，或者去任务板加一条');
  }
  if (d.modules.timetable && d.course_reason === 'no_term') {
    html += '<div class="dash-note">课表里还没有学期，课程不会出现在看板上。</div>';
  } else if (d.modules.timetable && d.course_reason === 'no_start_monday') {
    html += '<div class="dash-note">学期的「第 1 周星期一」没填，算不出日期 —— 课程不会出现在看板上。</div>';
  }
  html += '</div>';
  return html;
}

/**
 * 功能：把「其它」那一块画出来 —— 一个模块一张卡（图标 + 名字 + 一句简要 + 可选的大数）。
 *
 * 说明：⭐ 0.8.5。⚠️ 名单与顺序**取自清单 × 接线表**，⛔ 不写死；
 *      「画不画」只看 `dashboard().briefs` 里有没有这个键（服务端已经过完那两道门）。
 *      ⚠️ 卡片用 `data-act="dash-goto-mod"` + `data-mod`（动作用模块名去动作表里查），
 *      ⛔ 不把屏名写进 DOM：屏名可能与本端接线表的 `view` 不同，写死就是「点了进错屏」。
 * @returns {string} 这一块的 HTML
 */
function briefsHtml() {
  const d = state.dash.data || {};
  // ⭐ 0.8.7 修订（「其它里还有日历按钮卡片，应该删掉」）：
  //    **已经作为看板视图存在**的模块（接线表里声明了 `dashView`）**不再出卡** ——
  //    它现在就长在这个屏里，门是**胶囊**，再给一张「去日历」的卡是重复入口。
  //    ⚠️⭐ 服务端那份 `briefs.calendar` **照样要留着**：默认视图偏好（`open_by_default`）
  //      是搭它的车传下来的（零新请求）—— 删了它偏好就断了。所以**过滤在这一层做**。
  const asView = new Set(dashViewDefs(capsuleItems()).map((it) => it.name));
  const rows = [];
  moduleItems(state.modules, uiOf, state.me || {}).forEach((it) => {
    if (asView.has(it.name)) return;
    const b = dashBrief(it.name, (d.briefs || {})[it.name]);
    if (b) rows.push({ it, b });
  });
  if (!rows.length) return '<div class="empty"><div class="empty-text">所有模块都在「设置 → 模块功能」里关着。</div></div>';
  return (
    '<div class="dash-briefs">' +
    rows
      .map(
        ({ it, b }) => `
      <button class="dash-brief${b.warn ? ' warn' : ''}" type="button" data-act="dash-goto-mod"
              data-mod="${esc(it.name)}">
        <span class="db-ico" aria-hidden="true">${it.svg || esc(it.icon)}</span>
        <span class="db-main"><b>${esc(it.title)}</b><span>${esc(b.text)}</span></span>
        ${b.n === null ? '' : `<span class="db-num">${b.n}</span>`}
      </button>`,
      )
      .join('') +
    '</div>'
  );
}
