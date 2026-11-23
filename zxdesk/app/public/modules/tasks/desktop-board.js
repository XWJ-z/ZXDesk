/**
 * modules/tasks/desktop-board.js —— 任务板（四象限 / 甘特时间轴，按钮切换 = 不同屏）
 *
 * 功能：任务板这一屏的取数、渲染与「四象限 / 甘特图」切换。
 * `openBoard()` / `loadBoard()` 打开任务板并取数（日常走 `/api/daily`，项目走 `/api/projects/<id>/tasks`）；
 * `renderBoard()` 渲染标题、状态角标与提示行，再把内容交给两个子视图；
 * `setBoardPane()` 在四象限与甘特时间轴之间切换（**两者是不同屏**）…
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
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
// 修订：甘特图里周期任务的**每一期**都能单独点（打卡 / 取消那一期）
// 修订：周期任务那几段不再**直接**打卡（见下面那段说明）⇒ `shared.js` 的
// `tickOccurrence` 与 `desktop-tasks.js` 的 `refreshAfterWrite` 在本文件已无调用点。
import { mountModuleSlot, slotDefs, warmSlots } from '../../core/slots.js';
import { crossFade, swapIn } from '../../core/transition.js';
import { uiOf } from '../../desktop/modules.js';

/** 药丸要认清的槽名（与两端接线表里 `idea` 声明的那个**逐字一致**） */
const BOARD_SLOT = 'board-pane';

/**
 * 这一次重画要不要给 `#board-main` 播一次淡入 —— **只有「已经在这一屏上、用户换了作用域」
 *
 */
let scopeSwap = false;

/** 药丸的点击委托**只挂一次**（`#board-tabs` 是静态节点，重挂会叠加） */
let pillBound = false;

/**
 * 功能：算一遍药丸里**模块贡献的那几项** —— 「清单 ∩ 本端接线表 ∩ 该模块没被关掉」，顺序跟清单走。
 *
 * 说明：⭐ 复用的是现成的 `slotDefs()`（判据只有一处）—— 它已经把三件事一次做完了：
 * **清单 ∩ 接线表**、**该模块没被本账号关掉**（`hide_idea`）、**顺序 / 名字 / 图标**。
 * 这一份为空（随手记被删掉 / 被关掉）⇒ 药丸只剩「任务」⇒ **整条不画**（见 `pillHtml`）。
 */
function paneItems() {
  return slotDefs(state.modules, uiOf, state.me).filter((it) => it.slots.includes(BOARD_SLOT));
}

/**
 * 功能：画药丸 —— 第一项恒为**任务板自己**（`data-board-view=""`，也就是 `state.boardTab` 的空串），
 * 后面依次是各模块借这一屏贡献的视图。
 * @param {Array.<Object>} items - `paneItems()` 的产物
 * @returns {string} 药丸的 HTML（**没有模块贡献视图时返回空串 —— 整条不画**）
 */
function pillHtml(items, on) {
  // 只有一项时整条不画：只有一种视图时，一条切换控件是纯噪音（与 `webpass` 同一条口径）。
  if (!items.length) return '';
  // 「随手记去掉图标」—— 药丸里只画名字。
  // 图标**不是从接线表里删掉**（`it.icon` 别处还有用），只是这颗药丸不画它。
  // 各颗等宽由 `fitTabs()` 负责（`paintTabs()` 画完就调），⛔ 不是在这里给短文案补空格。
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
  // 用户亲手点药丸这一下走 **交叉淡入** —— 旧的那一块（`#board-main`）
  // 一直留到新的那一块（`#board-pane`）挂好，两层同格重叠再一起淡出 / 淡入。
  // 进屏那一下不播（交给 `showView()` 的整屏动画），见 `scopeSwap` 的说明。
  const done = renderBoard({ fade: true });
  if (!name || !done) return;
  // 补偿就是这一下：切过来之后把光标放进这一块**第一个输入框**，用户接着就能打字。
  // 必须等 `renderBoard()` 返回的**那一批挂载全跑完**再放 —— 等早了会放在一个
  // 马上被换掉的节点上，焦点当场丢（真浏览器探针抓到的就是这个）。
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
 * （等早了会放在一个**马上被换掉**的节点上，焦点当场丢）。
 * 合并式防重入（同一时刻只挂一趟、期间来的请求只记「还要再画一次」）**已收进
 */
function paint(enter) {
  const pane = $('#board-pane');
  const name = state.boardTab;
  if (!pane || !name) return Promise.resolve();
  return mountModuleSlot(pane, 'desktop', name, BOARD_SLOT, {
    // `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    // `render(ctx)`（它自己的第一个参数不会进 ctx）。而视图片段要「先把根节点插进文档、
    // 再调模块的渲染函数」（那些函数按**全局 id** 找节点）⇒ 漏了这一项，片段一进门
    container: pane,
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    // **opt-in** 的交叉淡入 —— ⛔ 不传时 `mountModuleSlot()` 与今天逐字相同
    crossFade: true,
    // **进屏那一趟**（`enter === true`）不播槽内淡入 —— 整屏 `.view.is-swap`
    // 那一条已经在给这一屏淡入，槽里再淡一次 = 「同一块内容连淡两次」（
    // 「模块与模块之间切换多次闪现」）。⚠️ 与 `#board-main` 那条 `scopeSwap` 是**同一个
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
  // 各颗撑成等宽（量最宽那颗）—— 见 `fitTabs()` 的说明。
  // 必须在 `innerHTML` **之后**调（那时才量得到宽）。
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
  // 进这一屏就把「可能要挂的片段」**预热**起来 —— **不 await**，
  // 与下面 `loadBoard()` 的取数**并行**（从前是串行：片段到货 → 片段自己再取数）。
  warmSlots('desktop', BOARD_SLOT, { modules: state.modules, uiOf, me: state.me });
  // **已经在任务板这一屏上**再换作用域 ⇒ 内容整块重画，
  // 给 `#board-main` 播一次淡入；从别的屏点进来那一下**不播**（`showView()` 的整屏动画
  // 已经播过了，两处叠加 = 同一块内容连淡两次，「闪两下」比不加还差）。
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
 * 同步快速添加的默认勾选，再渲染任务板并刷新侧栏的今日待办数。
 *
 * 说明：取数失败只弹 toast 提示，`state.tasks` 保持上一次的数据不动 —— 不至于整屏变空。
 *
 */
export async function loadBoard() {
  try {
    if (state.scope === 'daily') {
      state.tasks = await api('GET', '/api/daily');
    } else if (state.scope === 'all') {
      // 汇总任务视图：**一次请求**拿全部任务（`/api/tasks`）后摊平。
      // 为什么不逐个项目发一次：那是 N+1（10 个项目 10 个请求），而这里要的恰恰是「一起看」。
      // 必须给每条任务写下它自己那个项目（`_scope`）：汇总视图里「当前作用域」是 'all'，
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
 * 接着渲染四象限上方的日期轴与甘特时间轴，最后按 `state.boardPane` 切到当前那一屏。
 *
 * 说明：⚠️ 时间轴的列宽靠实测容器宽度算，容器隐藏时量到 0，所以**不在可见状态就不渲染**，
 * 交给 `setBoardPane()` 在切过去的时候再渲染。
 */
export function renderBoard(opts) {
  if (state.view === 'search') return undefined;
  const fade = !!(opts && opts.fade);
  // 这一次重画要不要给 `#board-main` 播淡入（**只消费一次**）——
  // 在开头就取走并清零，免得别的路径（比如切到随手记）把它留在那儿、下一次误播。
  const doScopeSwap = scopeSwap;
  scopeSwap = false;
  // 屏头药丸 ＋「任务板自己那一块 ⇄ 模块贡献的视图」的显隐。
  const items = paneItems();
  // 当前选的那一块不在清单里了（模块被关掉 / 被整目录删掉 / 上一次选的没了）⇒ 回落到任务板自己
  if (state.boardTab && !items.some((it) => it.name === state.boardTab)) state.boardTab = '';
  paintTabs(items);
  const onTask = !state.boardTab;
  // 药丸（`#board-tabs`）**住在 `.board-head` 里**（三屏药丸统一时搬进来的）
  // 只收任务板自己那几件：作用域下拉 / 三颗项目按钮 / 提示行 / 整块内容。
  // 药丸与它所在的那一行**留着** —— 它是这一屏唯一的切换控件，藏了就再也回不去任务板。
  const scopeSel = $('#bd-scope');
  if (scopeSel) scopeSel.classList.toggle('hidden', !onTask);
  const actions = $('#board-view .board-actions');
  if (actions) actions.classList.toggle('hidden', !onTask);
  const meta = $('#bd-meta');
  if (meta) meta.classList.toggle('hidden', !onTask);
  const main = $('#board-main');
  const pane = $('#board-pane');
  // 真机：随手记那颗悬浮 ＋ 现在住**静态层**（`index.html` 的 `#board-view` 里，
  // 见那里的说明）⇒ 它的显隐归这里判 —— 与 `#btn-new-task`（仍住 `.board-actions`、
  // 整块 `hidden` 带走）**互斥**：任务档显示任务那颗、随手记档显示这一颗。
  const fabIdea = $('#btn-new-idea');
  if (fabIdea) fabIdea.classList.toggle('hidden', onTask);
  if (fade && main && pane) {
    // **交叉淡入**那一趟 —— 两层都要在场上：新层先摆好、
    // 旧层继续显示（挂载期间屏幕上一直是旧内容）；挂完再让旧层淡出、新层淡入。
    main.classList.remove('hidden');
    pane.classList.remove('hidden');
    // 第八轮（「闪现问题依旧」）：**要进场的那一层先按住**。
    // 用 `opacity` 不是 `hidden` —— 布局必须留着（甘特图列宽靠 `clientWidth` 实测）。
    // 下面 `paint()` 是**异步挂载**（要点一次网络、再渲染），这段时间另一层还在屏幕上显示
    (onTask ? main : pane).style.opacity = '0';
  } else {
    if (main) main.classList.toggle('hidden', !onTask);
    if (pane) pane.classList.toggle('hidden', onTask);
  }
  if (!onTask) {
    // 挂载**只在这一个入口里**做（见文件头）：改造前「取数 / 重画」是两处分工，
    // 两处都变成「挂载整个视图」就会一次切屏挂两遍（容器里两个根节点）。
    // 返回这一批挂载的 promise（含并发时自己补的那趟）—— `pick()` 要等它画完再放光标。
    const done = paint(!fade);
    if (!fade || !main || !pane) return done.catch((e) => toast(e.message, true));
    // 挂完（新内容已就绪）⇒ 两层一起交叉淡入：`#board-pane` 淡入、`#board-main` 淡出。
    // `cleanup: 'hide'` —— 这两块是**静态节点**（⛔ 不能删，下次切换还要用）。
    // `tier 2` —— 屏头药丸「任务 ↔ 随手记」＝**二级**（与下面反向那一趟同源）。
    return done
      .then(() => crossFade([main], pane, { cleanup: 'hide', tier: 2 }))
      .catch((e) => {
        pane.style.opacity = '';
        toast(e.message, true);
      });
  }
  const isAll = state.scope === 'all';
  const isDaily = state.scope === 'daily';
  const p = isDaily || isAll ? null : state.projects.find((x) => x.id === state.scope);
  // 「📊 汇总任务视图 ＋ 全部项目 · N 个」那一组（`#bd-icon` /
  // `#bd-name` / `#bd-status`）**整块删掉**，与 `index.html` 那一行同步 ——
  // 「有切换列表显示当前项目就可以了」⇒ 当前在哪一屏只看 `#bd-scope` 那个下拉框。
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
  // 修订：汇总视图下的「＋ 新建任务」**恢复显示** —— 任务表单里
  // 多了一个「所属项目」下拉，所以「建到哪个项目」这个问题在表单里就有答案了
  $('#btn-edit-project').classList.toggle('hidden', isDaily || isAll);
  $('#btn-del-project').classList.toggle('hidden', isDaily || isAll);
  const newBtn = $('#btn-new-task');
  // 这颗按钮已改成**圆形 ＋ 图标**（`.btn-fab`）⇒ 随作用域变的
  // 那句话只能走 `title` / `aria-label`。⛔ 别改回 `textContent` —— 那会把图标本身覆盖成文字
  // （按钮当场变成一句话，而**不报错**）。
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
  // **屏内换作用域 / 换项目** ⇒ 内容整块重画完，给 `#board-main`
  // 播一次淡入（`scopeSwap` 由 `openBoard()` 设，见它的说明）。
  // 挂在 `#board-main` 上 —— ⛔ **不是** `#quad-grid` / `#day-strip`：那两个每次重画都被
  if (doScopeSwap && main) swapIn(main, 2);
  // 反向（随手记 → 任务板）—— `#board-main` 的内容是**同步**画好的、
  // 立刻就有 ⇒ 同样不藏旧的那一层，直接两层一起交叉淡入。
  // `tier 2` —— 屏头药丸「任务 ↔ 随手记」＝**二级**。
  if (fade && main && pane) crossFade([pane], main, { cleanup: 'hide', tier: 2 });
}

/**
 * 功能：填任务板页头那个【项目 ▾】下拉 —— 汇总任务视图 + 日常任务 + 全部项目 + 最后一项「＋ 新建项目…」。
 *
 * 以前换项目必须退回卡片屏再点进去，现在在任务板里一步到位。
 * 最上面多了一项「📊 汇总任务视图」（值 `all`）—— 「项目任务默认显示汇总任务视图，
 * 也就是在【汇总任务视图】下在四象限汇总显示所有项目的任务」。
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
  // 用 `value =` 回填选中项（而不是给 option 写 selected）：重画时这样最不容易漏
  sel.value = isAll ? 'all' : isDaily ? 'daily' : String(state.scope);
  // 作用域对应的项目已经被删掉时，`value` 会落回空串 ⇒ 兜到汇总视图，别让下拉显示成空白
  if (!sel.value) sel.value = 'all';
}

/**
 * 功能：在四象限与甘特时间轴之间切换 —— 归一 `pane`、切换两个按钮的选中态与两块的显隐、
 * 更新提示文案，并在切到时间轴时重新渲染一次。
 *
 * 说明：⚠️ `renderTimeline()` 的列宽是 `computeColW()` 读 `#timeline.clientWidth` 算出来的：
 * 容器 `display:none` 时量到 0，列宽会退化成最小值 44px。所以**每次切到时间轴都要重算一遍**，
 */
export function setBoardPane(pane) {
  const next = pane === 'timeline' ? 'timeline' : 'quad';
  // `changed` 见函数末尾 —— 只有**用户亲手点**那两颗按钮
  // 才算「换视图」，`renderBoard()` 每次重画都调本函数的那几趟不算。
  const changed = next !== state.boardPane;
  state.boardPane = next;
  const onTl = state.boardPane === 'timeline';
  $('#bv-quad').classList.toggle('on', !onTl);
  $('#bv-timeline').classList.toggle('on', onTl);
  $('#bv-quad').setAttribute('aria-selected', String(!onTl));
  $('#bv-timeline').setAttribute('aria-selected', String(onTl));
  $('#pane-quad').classList.toggle('hidden', onTl);
  $('#pane-timeline').classList.toggle('hidden', !onTl);
  // 修订：「上方选日期，下方按重要 / 紧急分组」—— 同上一条，
  // **用户视角的一句话**，不是复述界面结构（「上方/下方」是在描述 DOM）。
  // 真机修订：两句再收短成「下一步做什么」——
  $('#bv-hint').textContent = onTl
    ? '点击任务条，可查看详细信息'
    : '点击日期，可查看当天任务';
  if (onTl) renderTimeline();
  // **用户亲手点「四象限 / 甘特图」**⇒ 新显示的那一块播一次淡入。
  // 判据必须是「真的换了 pane」：`renderBoard()` 每次重画都会调本函数（进屏 / 换作用域 /
  // 写操作之后），那几趟**不是换视图**，跟着抖一下反而更像故障。
  if (changed) swapIn(onTl ? $('#pane-timeline') : $('#pane-quad'), 3);
}

/**
 * 功能：渲染四象限上方的日期轴 —— 自 `state.weekStart`（缺省取本周一）起算的 7 天，
 * 逐天画成可选按钮并标出今天、当前选中日与周末，同时写上这一周的区间文案。
 *
 * 说明：为什么必须有：四象限与甘特图分开成两个视图之后，切到四象限就**没地方选日期**了 ——
 * 甘特图的周表头在另一个视图里，看不到也点不到。
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
 * 不把 28px 减掉，7 列加起来会比内容区宽 20px —— 平白多一条横向滚动条（实测过）。
 *
 */
export function computeColW() {
  const c = $('#timeline');
  if (!c) return 56;
  // clientWidth 是**含左右内边距**的宽度，而 .timeline 左右各有 14px。
  // 不把 28px 减掉，7 列加起来会比内容区宽 20px —— 平白多一条横向滚动条（实测过）。
  // 第二轮（「甘特图移除底部的左右滑动条，左右自适应窗口变化」）：
  const avail = (c.clientWidth || 7 * 56) - 28 - 2;
  const w = Math.floor(Math.max(avail, 300) / 7);
  // 上限放到 160（.view 本身 max-width 1080，所以实际就是「铺满可用宽度」）：
  // 时间轴现在独占一块视图，还按 96 封顶的话右边会空掉一大片。
  return Math.max(44, Math.min(160, w));
}

/**
 * 功能：渲染按周的甘特时间轴 —— 周表头、竖网格、今天的标线，以及每一条任务条（含悬浮提示与点击打开详情）。
 *
 * 这里的 `e < today` 与四象限同一口径，切到别的日期不会把未到期任务误标成逾期。
 * 点某一列即把 `state.selectedDate` 落到那天（列头高亮），**不切屏**（两个视图不同屏，切换交给按钮）。
 *
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

  // 与四象限里「完成日之后就不显示」自相矛盾，用户会以为任务还没做完。
  // `visEnd()` 多带一个 `today` ⇒ 逾期未完成的条**顺延到今天**
  // （10/1–10/2 的任务，今天 3 号就画到 3 号；4 号再顺延一天）。⚠️ 漏传 `today` 不报错，
  const tasks = state.tasks.filter((t) => {
    const s = t.start_date || t.due_date,
      e = visEnd(t, s, today);
    return s && e && s <= end && e >= start;
  });
  tasks.sort((a, b) =>
    ((a.start_date || a.due_date) + '|' + a.due_date).localeCompare((b.start_date || b.due_date) + '|' + b.due_date),
  );
  // 必须分道（lane）：一条任务一行。以前所有条都写死在 top:6px，
  // 同一时段的任务会整坨叠在一起、字压字完全读不出来（甘特图效果很差）。
  // 贪心分道即可 —— tasks 已按开始时间排好序，逐条放进「上一段已经结束」的第一条道，
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
  // 打卡（周期）任务用**专属色**（`CYCLE_COLORS`），按**任务**分配而不是按画出来的先后 ——
  // 同一个打卡任务翻到哪一周、排到第几道，颜色都不变。
  // 用 `state.tasks`（全量）算：只按「本周可见的 tasks」算的话，翻一周颜色就换一套。
  const cycColorOf = new Map();
  state.tasks
    .filter((t) => t.task_kind === 'cycle')
    .forEach((t, k) => cycColorOf.set(Number(t.id), CYCLE_COLORS[k % CYCLE_COLORS.length]));
  laid.forEach(({ t, s, si, ei, lane }, i) => {
    const done = t.status === 'done';
    // 修订——
    // 「在甘特图中周期任务点击完成过后，全部就完成了」＋「按期分隔显示，每期都可以单独点击」
    // ⇒ 周期任务**不再画一条贯穿整个周期的主条**，改成**一期一段小条**；
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
        // 打卡任务的颜色**按任务**固定（不是按 i 轮流）—— 打过卡之后也还是这一色，只变暗（见 CSS）。
        seg.style.setProperty('--tlc', cycColorOf.get(Number(t.id)) || CYCLE_COLORS[0]);
        // 修订：
        // 第一轮：「周期任务要显示名称，且**不是**点击就打卡 / 取消了，要和其它一样进入详情，
        // 在详情中打卡」—— 打卡那颗入口搬进详情（见 `desktop-items.js` 的 `openTaskDetail()`）。
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
    // 那样这一条会**静默丢掉红色标记**（「改了顺延、逾期颜色不见了」）。
    // 周期任务不在此列：它的账按**每一期**各算，红不整条（见下面期标记那一段）。
    // 周期任务走不到这里 —— 它在函数开头就 `return` 了（每一期各画一段、各判各的红）。
    const overdue = !!t.due_date && t.due_date < today && !done;
    // 「甘特图没有有效区分三类任务」⇒ 按**形状 + 标记**区分
    // （⛔ 不靠颜色 —— 颜色已经用来区分**任务之间**了，再加一套色只会互相打架）：
    // 普通 = 现行样式；
    const kindCls =
      t.task_kind === 'window' ? ' tl-win' : t.task_kind === 'cycle' ? ' tl-cyc' : '';
    const bar = el('div', 'tl-taskbar' + (done ? ' done' : '') + (overdue ? ' due' : '') + kindCls);
    bar.style.left = si * COLW + 'px';
    bar.style.width = (ei - si + 1) * COLW - 4 + 'px';
    bar.style.top = TL_PAD + lane * (TL_BAR_H + TL_BAR_GAP) + 'px';
    // 「不同任务颜色区分一下，就是相邻的任务的颜色要有区分」——
    // 从前所有条都是同一个灰白底（只有「逾期」是红的）⇒ 一排看下去分不出谁是谁。
    // 按**画出来的先后**轮流取 `COLORS`：相邻两行的下标必然差 1 ⇒ 颜色必然不同。
    bar.style.setProperty('--tlc', COLORS[i % COLORS.length]);
    // 悬浮提示说**计划区间**（条画到哪是可见窗口的事，别把两件事混在一句话里）
    // 逾期改成写**天数**（「甘特图和四象限图都应该显示逾期 x 天」）——
    const di = doneInfo(t);
    const od = overdueDays(t, today);
    // 类型写进悬浮提示的**开头**：条上的图标只是「一眼看得出」，具体是哪一类还得有字
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
    // （窄条退化成悬浮提示，别把字挤成一条黑线）。周期任务写「已打卡 几 / 几 期」。
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
      // 汇总视图里必须按任务自己那个项目打开（见 `taskScope()`）
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
    // 只是「选中那天」，**不换屏**：要看那天的安排自己点「四象限」按钮。
    // 列头高亮**就地改**，不整块重画 —— `#timeline` 在窄窗口下会横向滚动，重画会把滚动位置打回最左边。
    head.querySelectorAll('.tl-col-head').forEach((c, i) => c.classList.toggle('sel', i === idx));
    // 四象限那一屏虽然是隐藏的，也照样同步重画：两边共用 selectedDate，
    renderQuadrant();
    renderDayStrip();
  });
  container.appendChild(inner);
}

/**
 * 功能：按任务的 important / urgent 在 `QUADS` 里找到对应象限，
 * 返回「标签 · 副标题」文案；找不到时返回 `—`。
 * @param {Object} t - 任务对象（读 `important` / `urgent` 两个字段）
 * @returns {string} 四象限文案
 */
export function quadOf(t) {
  const q = QUADS.find((x) => x.imp === Number(t.important) && x.urg === Number(t.urgent));
  return q ? q.label + ' · ' + q.sub : '—';
}

// ---------- 甘特图（按周：任务在[任务日,截止日期]区间显示，点击日期只选中那天、不换屏） ----------
export let COLW = 56; // 每列宽度(px)，随容器自适应

// 「每一个任务条你可以显示宽一些 现在看着好小 费眼睛」——
// 条高 22 → 28、道间距 4 → 6（字号也在 CSS 里 11 → 12）。
// **这两个数与 `desktop/app.css` 的 `.tl-taskbar { height / line-height }` 是**一对**——
export const TL_BAR_H = 28; // 甘特条高度

export const TL_BAR_GAP = 6; // 道与道之间的间距

export const TL_PAD = 6; // 时间轴上下留白
