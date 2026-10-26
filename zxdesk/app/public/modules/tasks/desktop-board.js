/**
 * modules/tasks/desktop-board.js —— 任务板（四象限 / 甘特时间轴，按钮切换 = 不同屏）
 *
 * 功能：任务板这一屏的取数、渲染与「四象限 / 甘特图」切换。
 *      `openBoard()` / `loadBoard()` 打开任务板并取数（日常走 `/api/daily`，项目走 `/api/projects/<id>/tasks`）；
 *      `renderBoard()` 渲染标题、状态角标与提示行，再把内容交给两个子视图；
 *      `setBoardPane()` 在四象限与甘特时间轴之间切换（**两者是不同屏**）；
 *      `renderDayStrip()` 画四象限上方的日期轴，`computeColW()` / `renderTimeline()` 画按周的甘特时间轴；
 *      `quadOf()` 把一条任务的 important / urgent 翻成四象限文案。
 *
 * ⭐ 0.8.7：这一屏屏头多了**第二层切换器** —— 药丸 `任务 ｜ 随手记`。
 *    随手记（模块 `idea`）**不再有自己的屏**，它的界面挂进本屏的 `#board-pane`（槽名 `board-pane`）；
 *    屏**不认识任何模块的实现**：项由 `slotDefs()` 从两端接线表算出来、界面由 `mountModuleSlot()`
 *    动态 import 片段渲染。
 *    ⚠️⭐ **挂载只在 `renderBoard()` 这一个入口里做**：改造前「取数」与「重画」是两处分工，
 *    若两处都变成「挂载整个视图」⇒ 一次切屏挂两遍、容器里两个根节点。
 *    ⚠️⭐ 药丸住**屏头静态槽** `#board-tabs`，⛔ 不许放进 `#board-main` —— 后者每画一次就被整块换掉。
 *    ⚠️ 切到模块视图时，任务板自己的屏头与提示行**整块不画**（`.board-head` / `#bd-meta` 加 `hidden`），
 *    与 处理「人生日历」同一条口径（不是置灰）。
 *
 * 说明：⭐ **四象限与甘特图是按钮切换的不同屏**，不是同一屏的上下两块 ——
 *      所以点甘特图的某一天**不换屏**，只是把「选中的日期」落到那天（列头高亮），
 *      要看那天的安排得自己点「四象限」按钮（两边共用 `state.selectedDate`，切过去就是同一天）。
 *      ⚠️ 0.2.0 之前这里是「点日期 ⇒ 强制切到四象限」，那是两个视图刚分开时四象限还没有日期轴的补救；
 *      后来四象限补上了自己的日期轴（`renderDayStrip()`），这条跳转就只剩下「打断正在看的甘特图」了
 *      别再改回强制切屏。
 *
 * ⭐ 0.5.0：本文件从 `public/desktop/views/board.js` **原样搬进任务板模块目录**。
 *    一个模块一个文件夹 —— 这一屏只服务任务板这一个模块，所以它的家是 `modules/tasks/`，
 *    不该留在跨端共用的 `views/` 里。⚠️ 只改了 import 路径与本节注释，渲染逻辑一个字没动。
 *    命名约定（一个模块不止一屏时用 `<端>-<屏名>.js`）见 `modules/tasks/README.md` 与 `07-前端`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.52
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
import { COLORS, CYCLE_COLORS, QUADS } from '../../core/constants.js';
import { addDays, fmtDate, fmtShort, isWeekend, mondayOf, todayStr, weekdayChar } from '../../core/date.js';
import { $, clipWidth, el, esc, fitTabs } from '../../core/dom.js';
import { periodsBetween, missedPeriods, tickProgress } from '../../core/recur.js';
import { doneInfo, overdueDays, visEnd } from '../../core/task.js';
import { loadTodayCounts, renderSidebar, showView } from '../../desktop/shell.js';
import { scopeKey, state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';
import { openTaskDetail, renderQuadrant, taskScope } from './desktop-items.js';
import { clearSearch } from '../../desktop/views/search.js';
import { bindQuickAddDefaults } from './desktop-tasks.js';
// ⭐ 0.8.14 修订：甘特图里周期任务的**每一期**都能单独点（打卡 / 取消那一期）
// ⚠️ 0.8.14 修订：周期任务那几段不再**直接**打卡（见下面那段说明）⇒ `shared.js` 的
//    `tickOccurrence` 与 `desktop-tasks.js` 的 `refreshAfterWrite` 在本文件已无调用点。
// ⭐ 0.8.7：屏头的药丸与 `#board-pane` 那一块 ——
//    ⚠️ 这两条 import **不构成环**：`desktop/modules.js` 是纯数据（谁也不 import），
//    `core/slots.js` 只 import `core/modules.js`。
import { mountModuleSlot, slotDefs, warmSlots } from '../../core/slots.js';
import { crossFade, swapIn } from '../../core/transition.js';
import { uiOf } from '../../desktop/modules.js';

/** 药丸要认清的槽名（与两端接线表里 `idea` 声明的那个**逐字一致**） */
const BOARD_SLOT = 'board-pane';

/**
 * 这一次重画要不要给 `#board-main` 播一次淡入 —— **只有「已经在这一屏上、用户换了作用域」
 * 那一趟要**（0.8.15  落点 D2）。
 *
 * ⚠️⭐ 为什么进屏那一下不播（0.8.9）：进屏时 `showView()` 已经在**整屏**上
 * 播过同一枚动画，两处叠加 = 同一块内容连淡两次 ⇒ 观感是「闪两下」，比不加还差。
 * 判据在 `openBoard()` 里：**进这一屏之前 `state.view` 就已经是 `'board'`** 才算「屏内换作用域」。
 *
 * ⚠️⭐ 从前那两个模块级的 `painting` / `again`（合并式防重入）**已收进 `core/slots.js`** ——
 * 加了「旧层要留一会儿」之后，并发挂载的后果比从前更重（会留下两层旧节点），
 * 防重入必须与「保留旧层」住同一个文件。⛔ 别在这里再加回来。
 * @type {boolean}
 */
let scopeSwap = false;

/** 药丸的点击委托**只挂一次**（`#board-tabs` 是静态节点，重挂会叠加） */
let pillBound = false;

/**
 * 功能：算一遍药丸里**模块贡献的那几项** —— 「清单 ∩ 本端接线表 ∩ 该模块没被关掉」，顺序跟清单走。
 *
 * 说明：⭐ 复用的是现成的 `slotDefs()`（判据只有一处）—— 它已经把三件事一次做完了：
 *      **清单 ∩ 接线表**、**该模块没被本账号关掉**（`hide_idea`）、**顺序 / 名字 / 图标**。
 *      ⚠️ 这一份为空（随手记被删掉 / 被关掉）⇒ 药丸只剩「任务」⇒ **整条不画**（见 `pillHtml`）。
 * @returns {Array.<Object>} `moduleItems()` 条目（带 `slots` / `title` / `icon` / `on`）
 */
function paneItems() {
  return slotDefs(state.modules, uiOf, state.me).filter((it) => it.slots.includes(BOARD_SLOT));
}

/**
 * 功能：画药丸 —— 第一项恒为**任务板自己**（`data-board-view=""`，也就是 `state.boardTab` 的空串），
 *      后面依次是各模块借这一屏贡献的视图。
 * @param {Array.<Object>} items - `paneItems()` 的产物
 * @param {string} on - 当前选中的那一块（空串 = 任务板自己 / 否则是模块名）
 * @returns {string} 药丸的 HTML（**没有模块贡献视图时返回空串 —— 整条不画**）
 */
function pillHtml(items, on) {
  // ⚠️ 只有一项时整条不画：只有一种视图时，一条切换控件是纯噪音（与 `webpass` 同一条口径）。
  if (!items.length) return '';
  // ⭐ 0.8.9：「随手记去掉图标」—— 药丸里只画名字。
  //    ⚠️ 图标**不是从接线表里删掉**（`it.icon` 别处还有用），只是这颗药丸不画它。
  //    ⚠️ 各颗等宽由 `fitTabs()` 负责（`paintTabs()` 画完就调），⛔ 不是在这里给短文案补空格。
  const rows = [{ name: '', title: '任务' }].concat(
    items.map((it) => ({ name: it.name, title: it.title })),
  );
  return `<div class="dash-tabs" role="tablist">${rows
    .map(
      (r) =>
        `<button class="dash-tab${r.name === on ? ' on' : ''}" type="button" role="tab" ` +
        `aria-selected="${r.name === on}" data-board-view="${esc(r.name)}">` +
        `${esc(r.title)}</button>`,
    )
    .join('')}</div>`;
}

/**
 * 功能：切到药丸里的某一项 —— 只改 `state` 再重画，⛔ 不换屏、⛔ **不重新取数**。
 * @param {string} name - 模块名；空串 = 回任务板自己那一块
 * @returns {void}
 */
function pick(name) {
  if (name === state.boardTab) return;
  state.boardTab = name;
  // ⭐ 0.8.15：用户亲手点药丸这一下走 **交叉淡入** —— 旧的那一块（`#board-main`）
  //    一直留到新的那一块（`#board-pane`）挂好，两层同格重叠再一起淡出 / 淡入。
  //    ⛔ 不再「当场把旧视图 `hidden`」：那正是白窗的根源（旧视图同一帧消失、新内容还要等两趟网络）。
  //    ⚠️ 进屏那一下不播（交给 `showView()` 的整屏动画），见 `scopeSwap` 的说明。
  const done = renderBoard({ fade: true });
  if (!name || !done) return;
  // ⭐ 0.8.7：并屏的唯一代价是「入口深了一步」（原来侧栏整目录一屏直达）。
  //    补偿就是这一下：切过来之后把光标放进这一块**第一个输入框**，用户接着就能打字。
  //    ⚠️⭐ 必须等 `renderBoard()` 返回的**那一批挂载全跑完**再放 —— 等早了会放在一个
  //    马上被换掉的节点上，焦点当场丢（真浏览器探针抓到的就是这个）。
  //    ⚠️ 只挂在 `pick()`（**用户亲手切**那一下）里 —— ⛔ 别放进 `draw()`：那会在每次重画 /
  //    刷新时都抢一次焦点，用户正在别处打字时会被打断（一个**不报错**的坏体验）。
  done.then(
    () => {
      const box = $('#board-pane input, #board-pane textarea');
      if (box) box.focus();
    },
    () => {
      /* 挂载失败时槽里已经写了「界面加载失败」，这里不再重复提示 */
    },
  );
}

/**
 * 功能：把当前那一块挂进 `#board-pane` —— 走**交叉淡入**（旧内容一直留到新内容就绪）。
 *
 * 说明：⭐ 返回的 promise **在这一批挂载全部跑完之后**才 resolve —— `pick()` 要等它画完才能放光标
 *      （等早了会放在一个**马上被换掉**的节点上，焦点当场丢）。
 *      ⚠️ 合并式防重入（同一时刻只挂一趟、期间来的请求只记「还要再画一次」）**已收进
 *      `core/slots.js`**（见 `scopeSwap` 的说明）—— 本文件不再自己记 `painting` / `again`。
 *      ⚠️ `state.boardTab` 在调用那一刻读一次就好；并发时 `slots.js` 会用**最后一次**请求的参数重挂。
 *      ⚠️ 0.8.9 那句「⛔ 不再在这里铺骨架」**仍然成立**：铺了会被挂载流程当场抹掉
 *      （上一版正是那么写的，所以看到「没有任何变化」）。
 * @returns {Promise.<void>}
 */
function paint(enter) {
  const pane = $('#board-pane');
  const name = state.boardTab;
  if (!pane || !name) return Promise.resolve();
  return mountModuleSlot(pane, 'desktop', name, BOARD_SLOT, {
    // ⚠️⭐ `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    //    `render(ctx)`（它自己的第一个参数不会进 ctx）。而视图片段要「先把根节点插进文档、
    //    再调模块的渲染函数」（那些函数按**全局 id** 找节点）⇒ 漏了这一项，片段一进门
    //    就 TypeError，槽里只画一句「界面加载失败」。
    container: pane,
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    // ⭐ 0.8.15：**opt-in** 的交叉淡入 —— ⛔ 不传时 `mountModuleSlot()` 与今天逐字相同
    crossFade: true,
    // ⭐ 0.8.17：**进屏那一趟**（`enter === true`）不播槽内淡入 —— 整屏 `.view.is-swap`
    //    那一条已经在给这一屏淡入，槽里再淡一次 = 「同一块内容连淡两次」（
    //    「模块与模块之间切换多次闪现」）。⚠️ 与 `#board-main` 那条 `scopeSwap` 是**同一个
    //    道理的两处落点**：那一处管的是任务板自己那块，这一处管的是槽里的随手记。
    //    ⚠️ 屏内点药丸那一趟不传 ⇒ 交叉淡入照旧（那正是它要的）。
    enterFade: enter !== true,
  });
}

/**
 * 功能：把药丸画出来、把两块内容的显隐切过去（**同步**部分；挂视图由 `paint()` 负责）。
 * @param {Array.<Object>} items - `paneItems()` 的产物
 * @returns {void}
 */
function paintTabs(items) {
  const tabs = $('#board-tabs');
  if (!tabs) return;
  tabs.innerHTML = pillHtml(items, state.boardTab);
  // ⭐ 0.8.9：各颗撑成等宽（量最宽那颗）—— 见 `fitTabs()` 的说明。
  //    ⚠️ 必须在 `innerHTML` **之后**调（那时才量得到宽）。
  fitTabs(tabs);
  if (!pillBound) {
    pillBound = true;
    tabs.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-board-view]') : null;
      if (b) pick(b.getAttribute('data-board-view'));
    });
  }
}

/**
 * 功能：打开任务板 —— 记下作用域、退出搜索态、把选中日期重置为今天，切到任务板视图后取数渲染。
 * @param {(string|number)} scope - 作用域：`'daily'` 或项目 id，经 `scopeKey()` 归一后写进 `state.scope`
 * @returns {Promise.<void>}
 */
export async function openBoard(scope) {
  const next = scopeKey(scope);
  // ⭐ 0.8.15：进这一屏就把「可能要挂的片段」**预热**起来 —— **不 await**，
  //    与下面 `loadBoard()` 的取数**并行**（从前是串行：片段到货 → 片段自己再取数）。
  //    ⛔ 只预热片段 JS，**绝不预热数据**（不许顺手多发一次 `GET /api/idea`）。
  warmSlots('desktop', BOARD_SLOT, { modules: state.modules, uiOf, me: state.me });
  // ⭐ 0.8.15：**已经在任务板这一屏上**再换作用域 ⇒ 内容整块重画，
  //    给 `#board-main` 播一次淡入；从别的屏点进来那一下**不播**（`showView()` 的整屏动画
  //    已经播过了，两处叠加 = 同一块内容连淡两次，「闪两下」比不加还差）。
  scopeSwap = state.view === 'board' && next !== state.scope;
  state.scope = next;
  if (state.view === 'search') clearSearch();
  state.view = 'board';
  state.selectedDate = todayStr();
  renderSidebar();
  showView('board');
  await loadBoard();
}

/**
 * 功能：按当前作用域取任务列表（日常 `/api/daily`，项目 `/api/projects/<id>/tasks`），
 *      同步快速添加的默认勾选，再渲染任务板并刷新侧栏的今日待办数。
 *
 * 说明：取数失败只弹 toast 提示，`state.tasks` 保持上一次的数据不动 —— 不至于整屏变空。
 *
 * @returns {Promise.<void>}
 */
export async function loadBoard() {
  try {
    if (state.scope === 'daily') {
      state.tasks = await api('GET', '/api/daily');
    } else if (state.scope === 'all') {
      // ⭐ 0.5.2 汇总任务视图：**一次请求**拿全部任务（`/api/tasks`）后摊平。
      //    ⚠️ 为什么不逐个项目发一次：那是 N+1（10 个项目 10 个请求），而这里要的恰恰是「一起看」。
      //    ⚠️ 必须给每条任务写下它自己那个项目（`_scope`）：汇总视图里「当前作用域」是 'all'，
      //       而勾选 / 编辑 / 删除都得打到原项目上（见 `desktop-items.js` 的 `taskScope()`）。
      //    ⭐ 0.6.2：**日常任务也算「汇总」的一部分**（报「汇总任务视图没有显示日常任务」）——
      //       与手机端同一口径：那边 `state.all` 由 `rebuildFlat()` 建，日常任务排在最前。
      //       ⚠️ 日常任务的 `_scope` 写**字符串** `'daily'`（不是项目 id），
      //       勾选 / 编辑 / 删除照 `taskScope()` → `taskPath()` 打回 `/api/daily/<id>`。
      const r = await api('GET', '/api/tasks');
      const projName = new Map(state.projects.map((p) => [Number(p.id), p]));
      const out = (r.daily || []).map((t) => Object.assign({}, t, { _scope: 'daily', _project: null }));
      state.projects.forEach((p) => {
        ((r.byProject || {})[p.id] || []).forEach((t) => {
          out.push(Object.assign({}, t, { _scope: Number(p.id), _project: projName.get(Number(p.id)) || null }));
        });
      });
      state.tasks = out;
    } else {
      state.tasks = await api('GET', `/api/projects/${state.scope}/tasks`);
    }
    bindQuickAddDefaults();
    renderBoard();
    loadTodayCounts();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：渲染任务板的头部（图标 / 名称 / 状态角标 / 提示行 / 按钮显隐与文案），
 *      接着渲染四象限上方的日期轴与甘特时间轴，最后按 `state.boardPane` 切到当前那一屏。
 *
 * 说明：⚠️ 时间轴的列宽靠实测容器宽度算，容器隐藏时量到 0，所以**不在可见状态就不渲染**，
 *      交给 `setBoardPane()` 在切过去的时候再渲染。
 *
 * @param {Object} [opts] - `{ fade: true }` = **用户亲手点药丸**那一趟 ⇒ 走交叉淡入（见 `pick()`）；
 *      其余调用（进屏 / 换作用域 / 写操作后的重画）不传，显隐**当场**切到位（与 0.8.14 逐字相同）。
 * @returns {?(Promise.<void>)} 需要挂模块视图时返回那一批挂载的 promise，否则 `undefined`
 */
export function renderBoard(opts) {
  if (state.view === 'search') return undefined;
  const fade = !!(opts && opts.fade);
  // ⭐ 0.8.15：这一次重画要不要给 `#board-main` 播淡入（**只消费一次**）——
  //    在开头就取走并清零，免得别的路径（比如切到随手记）把它留在那儿、下一次误播。
  const doScopeSwap = scopeSwap;
  scopeSwap = false;
  // ⭐ 0.8.7：屏头药丸 ＋「任务板自己那一块 ⇄ 模块贡献的视图」的显隐。
  const items = paneItems();
  // ⚠️ 当前选的那一块不在清单里了（模块被关掉 / 被整目录删掉 / 上一次选的没了）⇒ 回落到任务板自己
  if (state.boardTab && !items.some((it) => it.name === state.boardTab)) state.boardTab = '';
  paintTabs(items);
  const onTask = !state.boardTab;
  // ⚠️⭐ 0.8.9：药丸（`#board-tabs`）**住在 `.board-head` 里**（三屏药丸统一时搬进来的）
  //    ⇒ ⛔ 切到模块视图时**不许整块隐藏 `.board-head`** —— 那会把药丸一起藏掉，
  //    表现就是「切到随手记之后那颗切换按钮消失了」（正是这一条）。
  //    只收任务板自己那几件：作用域下拉 / 三颗项目按钮 / 提示行 / 整块内容。
  //    ⚠️ 药丸与它所在的那一行**留着** —— 它是这一屏唯一的切换控件，藏了就再也回不去任务板。
  const scopeSel = $('#bd-scope');
  if (scopeSel) scopeSel.classList.toggle('hidden', !onTask);
  const actions = $('#board-view .board-actions');
  if (actions) actions.classList.toggle('hidden', !onTask);
  const meta = $('#bd-meta');
  if (meta) meta.classList.toggle('hidden', !onTask);
  const main = $('#board-main');
  const pane = $('#board-pane');
  // ⭐⭐ 0.8.16 真机：随手记那颗悬浮 ＋ 现在住**静态层**（`index.html` 的 `#board-view` 里，
  //    见那里的说明）⇒ 它的显隐归这里判 —— 与 `#btn-new-task`（仍住 `.board-actions`、
  //    整块 `hidden` 带走）**互斥**：任务档显示任务那颗、随手记档显示这一颗。
  //    ⚠️ 判据与下面那两块容器**同源**（`onTask`），⛔ 别另写一套。
  const fabIdea = $('#btn-new-idea');
  if (fabIdea) fabIdea.classList.toggle('hidden', onTask);
  if (fade && main && pane) {
    // ⭐ 0.8.15：**交叉淡入**那一趟 —— 两层都要在场上：新层先摆好、
    //    旧层继续显示（挂载期间屏幕上一直是旧内容）；挂完再让旧层淡出、新层淡入。
    //    ⛔ 这里**不许**把旧的那一层 `hidden`（那就是白窗的根源）。
    main.classList.remove('hidden');
    pane.classList.remove('hidden');
    // ⚠️⭐ 0.8.15 第八轮（「闪现问题依旧」）：**要进场的那一层先按住**。
    //    ⛔ 用 `opacity` 不是 `hidden` —— 布局必须留着（甘特图列宽靠 `clientWidth` 实测）。
    //    下面 `paint()` 是**异步挂载**（要点一次网络、再渲染），这段时间另一层还在屏幕上显示
    //    ⇒ 不按住就是「两层叠着看」（截图那个重叠）。放开与淡入由 `crossFade()` 在
    //    「旧层淡完」那一刻做，屏幕上是 **淡出 → 清屏 → 淡入**。
    (onTask ? main : pane).style.opacity = '0';
  } else {
    if (main) main.classList.toggle('hidden', !onTask);
    if (pane) pane.classList.toggle('hidden', onTask);
  }
  if (!onTask) {
    // ⚠️⭐ 挂载**只在这一个入口里**做（见文件头）：改造前「取数 / 重画」是两处分工，
    //    两处都变成「挂载整个视图」就会一次切屏挂两遍（容器里两个根节点）。
    //    ⚠️ 返回这一批挂载的 promise（含并发时自己补的那趟）—— `pick()` 要等它画完再放光标。
    // ⭐ 0.8.17：**只有用户亲手点药丸那一趟**（`fade === true`）才播槽内的交叉淡入。
    //    其余几趟（进屏 / 偏好变化后的重挂）都传 `enter = true` ⇒ 槽内不做过渡 ——
    //    进屏那一下整屏 `.view.is-swap` 已经在淡入了，槽里再淡一次 =「同一块内容连淡两次」
    //    （报的「模块与模块之间切换多次闪现」）。
    //    ⚠️ 与 `#board-main` 那条 `scopeSwap` 是**同一个道理的两处落点**：那处管任务板
    //    自己那块，这处管槽里的随手记。
    const done = paint(!fade);
    if (!fade || !main || !pane) return done.catch((e) => toast(e.message, true));
    // ⭐ 挂完（新内容已就绪）⇒ 两层一起交叉淡入：`#board-pane` 淡入、`#board-main` 淡出。
    //    ⚠️ `cleanup: 'hide'` —— 这两块是**静态节点**（⛔ 不能删，下次切换还要用）。
    //    ⭐ 0.8.51：`tier 2` —— 屏头药丸「任务 ↔ 随手记」＝**二级**（与下面反向那一趟同源）。
    return done
      .then(() => crossFade([main], pane, { cleanup: 'hide', tier: 2 }))
      .catch((e) => {
        // ⚠️ 挂载失败 ⇒ 必须**松开**刚按住的新层，否则它永远停在 `opacity: 0`（界面整块不见、且不报错）
        pane.style.opacity = '';
        toast(e.message, true);
      });
  }
  const isAll = state.scope === 'all';
  const isDaily = state.scope === 'daily';
  const p = isDaily || isAll ? null : state.projects.find((x) => x.id === state.scope);
  // ⭐ 0.8.9：「📊 汇总任务视图 ＋ 全部项目 · N 个」那一组（`#bd-icon` /
  //    `#bd-name` / `#bd-status`）**整块删掉**，与 `index.html` 那一行同步 ——
  //    「有切换列表显示当前项目就可以了」⇒ 当前在哪一屏只看 `#bd-scope` 那个下拉框。
  //    ⛔ 别把「项目名 / 状态徽章」加回来：它俩与下拉框是同一件事的第二处真相。
  // meta
  // ⭐ 0.8.9 修订：「所有项目的任务按重要 / 紧急汇总在这四个象限里 ·
  //    每条右边写着它属于哪个项目 · 点一条可看详情」—— 「这两个语句你不觉得莫名其妙吗，
  //    要站在用户视角写提示语，必须简洁明了」。⇒ 只留**用户下一步要做什么**，
  //    ⛔ 不再复述界面结构（下方四格的标题已经把「重要且紧急」写清楚了）。
  // ⭐ 0.8.15 真机修订（截图：「移除这个文案」）：**汇总任务视图那一档整句撤掉**
  //    （原来写的是「所有项目的任务，点一条看详情」）。⚠️ 撤掉时**连 `.project-meta` 的 14px
  //    下边距一起收**（加 `hidden`）—— 只把 `innerHTML` 清成空串的话，那一行会留一道空档，
  //    看着像排版坏了。⛔ 别改成空串就完事。
  if (meta) {
    meta.classList.toggle('hidden', isAll);
    meta.innerHTML = isAll
      ? ''
      : isDaily
        ? '回车即可快速添加；四象限与甘特图用上面的按钮切换查看；逾期未完成的任务会以红色标在当天的列表里'
        : (p && p.icon ? esc(p.icon) + ' ' : '') +
          (p && p.description ? esc(p.description) : '') +
          ' · 回车快速添加 · 四象限 / 甘特图 可切换';
  }
  // 按钮显隐与文案：
  // ⭐ 0.5.5 修订：汇总视图下的「＋ 新建任务」**恢复显示** —— 任务表单里
  //    多了一个「所属项目」下拉，所以「建到哪个项目」这个问题在表单里就有答案了
  //    （原先这里是 `toggle('hidden', isAll)`，理由正是「没有落点」）。
  //    ⚠️ 而**快速添加条在汇总视图下仍然收起**：它是一个回车即提交的输入框，没有地方选项目。
  //    留着它就只剩「一个必然 404 的输入框」这一种结局（见 `desktop-tasks.js` 的 `quickAdd()`）。
  $('#btn-edit-project').classList.toggle('hidden', isDaily || isAll);
  $('#btn-del-project').classList.toggle('hidden', isDaily || isAll);
  const newBtn = $('#btn-new-task');
  // ⭐ 0.8.15：这颗按钮已改成**圆形 ＋ 图标**（`.btn-fab`）⇒ 随作用域变的
  //    那句话只能走 `title` / `aria-label`。⛔ 别改回 `textContent` —— 那会把图标本身覆盖成文字
  //    （按钮当场变成一句话，而**不报错**）。
  const newLabel = isDaily ? '新建日常任务' : '新建任务';
  newBtn.title = newLabel;
  newBtn.setAttribute('aria-label', newLabel);
  const qa = $('#quick-add');
  if (qa) qa.classList.toggle('hidden', isAll);
  renderScopeSelect(isDaily, isAll);
  // 内容：两个视图各渲染自己的。时间轴的列宽靠实测容器宽度算，容器隐藏时量到 0，
  // 所以**不在可见状态就不渲染**，交给 setBoardPane 在切过去的时候渲染。
  renderQuadrant();
  renderDayStrip();
  setBoardPane(state.boardPane);
  // ⭐ 0.8.15：**屏内换作用域 / 换项目** ⇒ 内容整块重画完，给 `#board-main`
  //    播一次淡入（`scopeSwap` 由 `openBoard()` 设，见它的说明）。
  //    ⚠️ 挂在 `#board-main` 上 —— ⛔ **不是** `#quad-grid` / `#day-strip`：那两个每次重画都被
  //    整块换掉，动画会跟着新节点反复触发（回顶一次抖一下）。
  //    ⭐ 0.8.51：`tier 2` —— 换作用域 / 换项目是**同一屏内换视图**（与药丸同级）。
  if (doScopeSwap && main) swapIn(main, 2);
  // ⭐ 0.8.15：反向（随手记 → 任务板）—— `#board-main` 的内容是**同步**画好的、
  //    立刻就有 ⇒ 同样不藏旧的那一层，直接两层一起交叉淡入。
  //    ⭐ 0.8.51：`tier 2` —— 屏头药丸「任务 ↔ 随手记」＝**二级**。
  if (fade && main && pane) crossFade([pane], main, { cleanup: 'hide', tier: 2 });
}

/**
 * 功能：填任务板页头那个【项目 ▾】下拉 —— 汇总任务视图 + 日常任务 + 全部项目 + 最后一项「＋ 新建项目…」。
 *
 * 说明：⭐ 0.4.5 加它是因为「要看其他项目还得再来一次，很麻烦」：
 *      以前换项目必须退回卡片屏再点进去，现在在任务板里一步到位。
 *      ⭐ 0.5.2：最上面多了一项「📊 汇总任务视图」（值 `all`）—— 「项目任务默认显示汇总任务视图，
 *      也就是在【汇总任务视图】下在四象限汇总显示所有项目的任务」。
 *      项目名一律按**显示宽度**截到 12 格、全名留在 `title` 上（同一条反馈）。
 *      ⚠️ 它**只负责画选项**：换作用域一律走 `openBoard()`（由 `app.js` 绑 change）——
 *      在这里自己改 `state.scope` 会漏掉取数与重画，表现是「下拉变了、列表没变」。
 *      ⚠️ 最后那一项是**动作**不是作用域：选中它由 `app.js` 弹新建表单并把下拉拨回来，
 *      ⛔ 这里不要给它 `selected`。
 *
 * @param {boolean} isDaily - 当前是不是日常任务作用域
 * @param {boolean} isAll - 当前是不是汇总任务视图
 * @returns {void}
 */
function renderScopeSelect(isDaily, isAll) {
  const sel = $('#bd-scope');
  if (!sel) return;
  sel.innerHTML =
    '<option value="all">📊 汇总任务视图</option>' +
    `<option value="daily">📅 日常任务</option>` +
    state.projects
      .map(
        (p) =>
          `<option value="${p.id}" title="${esc(p.name)}">${esc(p.icon || '📁')} ${esc(clipWidth(p.name, 12))}</option>`,
      )
      .join('') +
    '<option value="__new__">＋ 新建项目…</option>';
  // ⚠️ 用 `value =` 回填选中项（而不是给 option 写 selected）：重画时这样最不容易漏
  sel.value = isAll ? 'all' : isDaily ? 'daily' : String(state.scope);
  // 作用域对应的项目已经被删掉时，`value` 会落回空串 ⇒ 兜到汇总视图，别让下拉显示成空白
  if (!sel.value) sel.value = 'all';
}

/**
 * 功能：在四象限与甘特时间轴之间切换 —— 归一 `pane`、切换两个按钮的选中态与两块的显隐、
 *      更新提示文案，并在切到时间轴时重新渲染一次。
 *
 * 说明：⚠️ `renderTimeline()` 的列宽是 `computeColW()` 读 `#timeline.clientWidth` 算出来的：
 *      容器 `display:none` 时量到 0，列宽会退化成最小值 44px。所以**每次切到时间轴都要重算一遍**，
 *      否则切过去会得到一条挤在左边、很窄的时间轴。
 *
 * @param {string} pane - 目标分屏，`'timeline'` 为甘特时间轴；其余值（含 `'quad'`）一律按四象限处理
 * @returns {void}
 */
export function setBoardPane(pane) {
  const next = pane === 'timeline' ? 'timeline' : 'quad';
  // ⭐ 0.8.15：`changed` 见函数末尾 —— 只有**用户亲手点**那两颗按钮
  //    才算「换视图」，`renderBoard()` 每次重画都调本函数的那几趟不算。
  const changed = next !== state.boardPane;
  state.boardPane = next;
  const onTl = state.boardPane === 'timeline';
  $('#bv-quad').classList.toggle('on', !onTl);
  $('#bv-timeline').classList.toggle('on', onTl);
  $('#bv-quad').setAttribute('aria-selected', String(!onTl));
  $('#bv-timeline').setAttribute('aria-selected', String(onTl));
  $('#pane-quad').classList.toggle('hidden', onTl);
  $('#pane-timeline').classList.toggle('hidden', !onTl);
  // ⭐ 0.8.9 修订：「上方选日期，下方按重要 / 紧急分组」—— 同上一条，
  //    **用户视角的一句话**，不是复述界面结构（「上方/下方」是在描述 DOM）。
  // ⭐ 0.8.15 真机修订（截图批注）：两句再收短成「下一步做什么」——
  //    四象限那档 ⇒「点击日期，可查看当天任务」；甘特图那档 ⇒「点击任务条，可查看详细信息」。
  //    ⚠️ 原来是「先选一天，这里按重要 / 紧急分四格」与「点某一天即选中那天（列头高亮），切到
  //    四象限看当天的安排」—— 都在**描述界面结构**，连批了两轮。⛔ 别再写回结构描述。
  $('#bv-hint').textContent = onTl
    ? '点击任务条，可查看详细信息'
    : '点击日期，可查看当天任务';
  if (onTl) renderTimeline();
  // ⭐ 0.8.15：**用户亲手点「四象限 / 甘特图」**⇒ 新显示的那一块播一次淡入。
  //    ⚠️ 判据必须是「真的换了 pane」：`renderBoard()` 每次重画都会调本函数（进屏 / 换作用域 /
  //    写操作之后），那几趟**不是换视图**，跟着抖一下反而更像故障。
  //    ⭐ 0.8.51：`tier 3` —— 这一颗是**同一屏内的第二层结构**（四象限 ↔ 甘特图）＝三级。
  if (changed) swapIn(onTl ? $('#pane-timeline') : $('#pane-quad'), 3);
}

/**
 * 功能：渲染四象限上方的日期轴 —— 自 `state.weekStart`（缺省取本周一）起算的 7 天，
 *      逐天画成可选按钮并标出今天、当前选中日与周末，同时写上这一周的区间文案。
 *
 * 说明：为什么必须有：四象限与甘特图分开成两个视图之后，切到四象限就**没地方选日期**了 ——
 *      甘特图的周表头在另一个视图里，看不到也点不到。
 *      ⚠️ 与甘特图共用 `state.weekStart` / `state.selectedDate`，两边永远指同一周同一天。
 *
 * @returns {void}
 */
export function renderDayStrip() {
  const wrap = $('#day-strip');
  if (!wrap) return;
  const today = todayStr();
  const start = state.weekStart || mondayOf(today);
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(start, i));
  $('#ds-label').textContent = `${fmtShort(start)} ~ ${fmtShort(dates[6])}`;
  const sel = state.selectedDate || today;
  wrap.innerHTML = dates
    .map((d) => {
      const cls = 'ds-day' + (d === today ? ' today' : '') + (d === sel ? ' sel' : '') + (isWeekend(d) ? ' wend' : '');
      return `<button class="${cls}" type="button" data-date="${d}" aria-pressed="${
        d === sel
      }"><span class="ds-dow">${weekdayChar(d)}</span><span class="ds-date">${fmtShort(d)}</span></button>`;
    })
    .join('');
}

/**
 * 功能：按 `#timeline` 的实测宽度算出甘特图单列宽度（px），结果夹在 44 ~ 160 之间。
 *
 * 说明：⚠️ `clientWidth` 是**含左右内边距**的宽度，而 `.timeline` 左右各有 14px；
 *      不把 28px 减掉，7 列加起来会比内容区宽 20px —— 平白多一条横向滚动条（实测过）。
 *      上限放到 160 是因为时间轴现在独占一块视图，还按 96 封顶的话右边会空掉一大片。
 *
 * @returns {number} 单列宽度（px）；容器不存在时返回兜底值 56
 */
export function computeColW() {
  const c = $('#timeline');
  if (!c) return 56;
  // ⚠️ clientWidth 是**含左右内边距**的宽度，而 .timeline 左右各有 14px。
  // 不把 28px 减掉，7 列加起来会比内容区宽 20px —— 平白多一条横向滚动条（实测过）。
  // ⭐ 0.8.14 第二轮（「甘特图移除底部的左右滑动条，左右自适应窗口变化」）：
  //    再留 2px 余量 —— `avail` 能被 7 整除时 7 列刚好贴住可用宽，亚像素 / 边框那点误差
  //    就够撑出一条横向滚动条（`overflow-x` 已钉死 hidden，这里再消掉那 1px 的裁切）。
  const avail = (c.clientWidth || 7 * 56) - 28 - 2;
  const w = Math.floor(Math.max(avail, 300) / 7);
  // 上限放到 160（.view 本身 max-width 1080，所以实际就是「铺满可用宽度」）：
  // 时间轴现在独占一块视图，还按 96 封顶的话右边会空掉一大片。
  return Math.max(44, Math.min(160, w));
}

/**
 * 功能：渲染按周的甘特时间轴 —— 周表头、竖网格、今天的标线，以及每一条任务条（含悬浮提示与点击打开详情）。
 *
 * 说明：任务条在 [任务日, 截止日期] 区间内显示。⭐ 逾期只按**真实今天**算（0.0.7 修的坑，别改回去）——
 *      这里的 `e < today` 与四象限同一口径，切到别的日期不会把未到期任务误标成逾期。
 *      点某一列即把 `state.selectedDate` 落到那天（列头高亮），**不切屏**（两个视图不同屏，切换交给按钮）。
 *
 * @returns {void}
 */
export function renderTimeline() {
  const container = $('#timeline');
  container.innerHTML = '';
  COLW = computeColW();
  const today = todayStr();
  const start = state.weekStart || mondayOf(today);
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(start, i));
  const end = dates[6];
  const W = 7 * COLW;
  $('#tl-label').textContent = `${fmtShort(start)} ~ ${fmtShort(end)}`;

  const inner = el('div', 'tl-inner');
  inner.style.width = W + 'px';

  const head = el('div', 'tl-head');
  dates.forEach((d) => {
    const c = el(
      'div',
      'tl-col-head' +
        (d === today ? ' today' : '') +
        (d === state.selectedDate ? ' sel' : '') +
        (isWeekend(d) ? ' wend' : ''),
    );
    c.style.width = COLW + 'px';
    c.innerHTML = `<div class="tl-dow">${weekdayChar(d)}</div><div class="tl-date">${fmtShort(d)}</div>`;
    head.appendChild(c);
  });

  const body = el('div', 'tl-body');
  body.style.width = W + 'px';
  const grid = el('div', 'tl-grid');
  dates.forEach((d) => {
    const g = el('div', 'tl-gcol' + (d === today ? ' today' : '') + (isWeekend(d) ? ' wend' : ''));
    g.style.width = COLW + 'px';
    grid.appendChild(g);
  });
  body.appendChild(grid);

  const todayIdx = dates.indexOf(today);
  if (todayIdx >= 0) {
    const tm = el('div', 'tl-todaymark');
    tm.style.left = todayIdx * COLW + COLW / 2 + 'px';
    body.appendChild(tm);
  }

  // 已完成的任务只画到**完成日**为止（见 visEnd）：否则本周的条会一直铺到截止日期，
  // 与四象限里「完成日之后就不显示」自相矛盾，用户会以为任务还没做完。
  // ⭐⭐ 0.8.14：`visEnd()` 多带一个 `today` ⇒ 逾期未完成的条**顺延到今天**
  //    （10/1–10/2 的任务，今天 3 号就画到 3 号；4 号再顺延一天）。⚠️ 漏传 `today` 不报错，
  //    只是「顺延」这条静默失效 —— 所以这里必须传。
  const tasks = state.tasks.filter((t) => {
    const s = t.start_date || t.due_date,
      e = visEnd(t, s, today);
    return s && e && s <= end && e >= start;
  });
  tasks.sort((a, b) =>
    ((a.start_date || a.due_date) + '|' + a.due_date).localeCompare((b.start_date || b.due_date) + '|' + b.due_date),
  );
  // ⚠️ 必须分道（lane）：一条任务一行。以前所有条都写死在 top:6px，
  // 同一时段的任务会整坨叠在一起、字压字完全读不出来（甘特图效果很差）。
  // 贪心分道即可 —— tasks 已按开始时间排好序，逐条放进「上一段已经结束」的第一条道，
  // 都放不下才新开一条。同一道内不会重叠，所以道数就是同时进行的任务峰值。
  const laid = tasks.map((t) => {
    const s = t.start_date || t.due_date,
      e = visEnd(t, s, today);
    const cs = s < start ? start : s,
      ce = e > end ? end : e;
    const si = Math.max(0, dates.indexOf(cs));
    const eIdx = dates.indexOf(ce);
    return { t, s, e, si, ei: eIdx < 0 ? 6 : eIdx, lane: 0 };
  });
  const laneEnd = [];
  laid.forEach((row) => {
    let lane = laneEnd.findIndex((last) => row.si > last);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = row.ei;
    row.lane = lane;
  });

  const barwrap = el('div', 'tl-barwrap');
  barwrap.style.width = W + 'px';
  const lanes = Math.max(1, laneEnd.length);
  barwrap.style.height = TL_PAD * 2 + lanes * TL_BAR_H + (lanes - 1) * TL_BAR_GAP + 'px';
  // ⭐ 打卡（周期）任务用**专属色**（`CYCLE_COLORS`），按**任务**分配而不是按画出来的先后 ——
  //    同一个打卡任务翻到哪一周、排到第几道，颜色都不变。
  //    ⚠️ 用 `state.tasks`（全量）算：只按「本周可见的 tasks」算的话，翻一周颜色就换一套。
  //    ⚠️ `CYCLE_COLORS` 与 `COLORS` 无交集 ⇒ 普通 / 窗口任务永远取不到这几色。
  const cycColorOf = new Map();
  state.tasks
    .filter((t) => t.task_kind === 'cycle')
    .forEach((t, k) => cycColorOf.set(Number(t.id), CYCLE_COLORS[k % CYCLE_COLORS.length]));
  laid.forEach(({ t, s, si, ei, lane }, i) => {
    const done = t.status === 'done';
    // ⭐⭐ 0.8.14 修订——
    //    「在甘特图中周期任务点击完成过后，全部就完成了」＋「按期分隔显示，每期都可以单独点击」
    //    ⇒ 周期任务**不再画一条贯穿整个周期的主条**，改成**一期一段小条**；
    //      点某一段 = 打卡 / 取消**那一期**（⛔ 不再是「整条任务完成」）。
    //    ⚠️ 段的位置按**日期列**算（与别的任务同一条时间轴）；期的起止落在窗口外时向两侧夹住。
    //    ⚠️ 已打卡 ⇒ `.ok`（绿 ✓）；期过完了还没打 ⇒ `.due`（红边）—— 判据只住
    //      `core/recur.js` 的 `missedPeriods()`，⛔ 别在这儿自己算「过没过完」。
    if (t.task_kind === 'cycle') {
      const tickSet = new Set((t.ticks || []).map(String));
      const missed = new Set(missedPeriods(t, t.ticks, today).map((p) => String(p.key)));
      const prog = tickProgress(t, t.ticks);
      periodsBetween(t, start, end).forEach((p) => {
        const i0 = dates.indexOf(p.start);
        const i1 = dates.indexOf(p.end);
        const lo = i0 < 0 ? 0 : i0;
        const hi = i1 < 0 ? 6 : i1;
        if (hi < 0 || lo > 6) return;
        const ok = tickSet.has(String(p.key));
        const seg = el('div', 'tl-taskbar tl-cyc tl-seg' + (ok ? ' ok' : '') + (missed.has(String(p.key)) ? ' due' : ''));
        seg.style.left = lo * COLW + 'px';
        seg.style.width = (hi - lo + 1) * COLW - 4 + 'px';
        seg.style.top = TL_PAD + lane * (TL_BAR_H + TL_BAR_GAP) + 'px';
        // ⭐ 打卡任务的颜色**按任务**固定（不是按 i 轮流）—— 打过卡之后也还是这一色，只变暗（见 CSS）。
        seg.style.setProperty('--tlc', cycColorOf.get(Number(t.id)) || CYCLE_COLORS[0]);
        // ⭐⭐ 0.8.14 修订：
        //    第一轮：「周期任务要显示名称，且**不是**点击就打卡 / 取消了，要和其它一样进入详情，
        //    在详情中打卡」—— 打卡那颗入口搬进详情（见 `desktop-items.js` 的 `openTaskDetail()`）。
        //    第二轮：「**要显示任务名称，要不然别人怎么知道这个任务是什么**」——
        //    ⛔ 上一版按「够宽才写」分档（`(hi-lo+1) >= 2 列`），结果段稍窄就**一个字都不显示**
        //    （截图里那三段只有一枚 ✓）。现在**一律**把标题写在段上，窄到放不下时由 CSS 的
        //    `text-overflow: ellipsis` 收尾 —— 名字永远在，⛔ 别再按宽度分档。
        //    ⚠️ ✓ 那枚标记改由 CSS 的 `.tl-seg.ok::after` 出（与正文同一行，挤不下就一起省略）。
        seg.textContent = t.title;
        seg.title =
          `🔁 ${t.title}${prog.total ? `（${prog.text}）` : ''}\n` +
          `本期 ${fmtDate(p.start)}${p.end !== p.start ? ' ~ ' + fmtDate(p.end) : ''}：` +
          `${ok ? '已打卡' : '还没打卡'} —— 点开详情打卡`;
        seg.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openTaskDetail(taskScope(t, state.scope), t);
        });
        barwrap.appendChild(seg);
      });
      return;
    }
    // ⚠️⭐ 逾期判据**从理论截止日算**（`t.due_date < today`），⛔ **不许**拿 `e`（`visEnd` 顺延后
    //    的日期）判 —— 0.8.14 起 `e` 对逾期未完成的任务就等于 `today`，`e < today` 恒假，
    //    那样这一条会**静默丢掉红色标记**（「改了顺延、逾期颜色不见了」）。
    //    ⚠️ 周期任务不在此列：它的账按**每一期**各算，红不整条（见下面期标记那一段）。
    // ⚠️⭐ 逾期从**理论截止日**算（`t.due_date < today`），⛔ 不许拿顺延后的 `e` 判（见上）。
    //    ⚠️ 周期任务走不到这里 —— 它在函数开头就 `return` 了（每一期各画一段、各判各的红）。
    const overdue = !!t.due_date && t.due_date < today && !done;
    // ⭐⭐ 0.8.14：「甘特图没有有效区分三类任务」⇒ 按**形状 + 标记**区分
    //    （⛔ 不靠颜色 —— 颜色已经用来区分**任务之间**了，再加一套色只会互相打架）：
    //      · 普通 = 现行样式；
    //      · 窗口 = 条**两端各一道粗竖线**（时间窗的边界）+ 条首一枚 ⏱；
    //      · 周期 = 一条贯穿整周期的主条 + **每一期一枚小圆点**（见下面那段）。
    const kindCls =
      t.task_kind === 'window' ? ' tl-win' : t.task_kind === 'cycle' ? ' tl-cyc' : '';
    const bar = el('div', 'tl-taskbar' + (done ? ' done' : '') + (overdue ? ' due' : '') + kindCls);
    bar.style.left = si * COLW + 'px';
    bar.style.width = (ei - si + 1) * COLW - 4 + 'px';
    bar.style.top = TL_PAD + lane * (TL_BAR_H + TL_BAR_GAP) + 'px';
    // ⭐ 0.8.9：「不同任务颜色区分一下，就是相邻的任务的颜色要有区分」——
    //    从前所有条都是同一个灰白底（只有「逾期」是红的）⇒ 一排看下去分不出谁是谁。
    //    按**画出来的先后**轮流取 `COLORS`：相邻两行的下标必然差 1 ⇒ 颜色必然不同。
    //    ⚠️ 染的是**底色**那一层（`app.css` 里用 `color-mix` 压在面板色上），⛔ 不是把标题文字染色 ——
    //    那样可读性会掉，而且逾期那一条的红色语义会被盖掉。
    bar.style.setProperty('--tlc', COLORS[i % COLORS.length]);
    // 悬浮提示说**计划区间**（条画到哪是可见窗口的事，别把两件事混在一句话里）
    // ⭐ 0.8.14：逾期改成写**天数**（「甘特图和四象限图都应该显示逾期 x 天」）——
    //    未完成写「逾期 N 天」，逾期之后才补做的写「逾期 N 天后完成」（方案 §五②）。
    const di = doneInfo(t);
    const od = overdueDays(t, today);
    // ⚠️ 类型写进悬浮提示的**开头**：条上的图标只是「一眼看得出」，具体是哪一类还得有字
    const kindTag =
      t.task_kind === 'window'
        ? `【窗口 ${t.start_time || '不限'}~${t.due_time || '不限'}】`
        : t.task_kind === 'cycle'
          ? '【周期】'
          : '';
    bar.title =
      kindTag +
      t.title +
      `（${fmtDate(s)} ~ ${fmtDate(t.due_date)}` +
      (di
        ? `，完成于 ${fmtDate(di.date)}${di.approx ? '（老数据按截止日期计）' : ''}`
        : overdue
          ? `，逾期 ${od} 天`
          : '') +
      (di && od > 0 ? `，逾期 ${od} 天后完成` : '') +
      '）';
    // ⭐ 0.8.14（方案 §1.5）：窗口任务在**条上**写时刻；逾期天数与时刻只在条够宽时才写在条上
    //    （窄条退化成悬浮提示，别把字挤成一条黑线）。周期任务写「已打卡 几 / 几 期」。
    const wide = (ei - si + 1) * COLW - 4 >= COLW * 2;
    if (t.task_kind === 'window' && (t.start_time || t.due_time)) {
      const wt = [t.start_time, t.due_time].filter(Boolean).join('~');
      bar.textContent = wide ? `${t.title} · ${wt}` : t.title;
    } else if (overdue && wide) {
      bar.textContent = `${t.title} · 逾期 ${od} 天`;
    } else {
      bar.textContent = t.title;
    }
    bar.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // ⭐ 0.5.2：汇总视图里必须按任务自己那个项目打开（见 `taskScope()`）
      openTaskDetail(taskScope(t, state.scope), t);
    });
    barwrap.appendChild(bar);
  });
  body.appendChild(barwrap);

  inner.appendChild(head);
  inner.appendChild(body);
  inner.addEventListener('click', (ev) => {
    const rect = inner.getBoundingClientRect();
    const idx = Math.floor((ev.clientX - rect.left) / COLW);
    if (idx < 0 || idx >= 7) return;
    state.selectedDate = dates[idx];
    // ⚠️ 只是「选中那天」，**不换屏**：要看那天的安排自己点「四象限」按钮。
    // 列头高亮**就地改**，不整块重画 —— `#timeline` 在窄窗口下会横向滚动，重画会把滚动位置打回最左边。
    head.querySelectorAll('.tl-col-head').forEach((c, i) => c.classList.toggle('sel', i === idx));
    // 四象限那一屏虽然是隐藏的，也照样同步重画：两边共用 selectedDate，
    // 这样点「四象限」时看到的就是刚才选的那一天（否则会停在旧日期上）。
    renderQuadrant();
    renderDayStrip();
  });
  container.appendChild(inner);
}

/**
 * 功能：按任务的 important / urgent 在 `QUADS` 里找到对应象限，
 *      返回「标签 · 副标题」文案；找不到时返回 `—`。
 * @param {Object} t - 任务对象（读 `important` / `urgent` 两个字段）
 * @returns {string} 四象限文案
 */
export function quadOf(t) {
  const q = QUADS.find((x) => x.imp === Number(t.important) && x.urg === Number(t.urgent));
  return q ? q.label + ' · ' + q.sub : '—';
}

// ---------- 甘特图（按周：任务在[任务日,截止日期]区间显示，点击日期只选中那天、不换屏） ----------
export let COLW = 56; // 每列宽度(px)，随容器自适应

// ⭐⭐ 0.8.14：「每一个任务条你可以显示宽一些 现在看着好小 费眼睛」——
// 条高 22 → 28、道间距 4 → 6（字号也在 CSS 里 11 → 12）。
// ⚠️⭐ **这两个数与 `desktop/app.css` 的 `.tl-taskbar { height / line-height }` 是**一对**——
// 改一处必须改另一处（护栏：`frontend-modules.test.js` 钉着「JS 常量 ⟷ CSS 数值」的耦合）。
export const TL_BAR_H = 28; // 甘特条高度

export const TL_BAR_GAP = 6; // 道与道之间的间距

export const TL_PAD = 6; // 时间轴上下留白
