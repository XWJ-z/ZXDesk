/**
 * modules/tasks/mobile-board.js —— 任务板（周日期条 + 当日列表，取代电脑端的甘特 + 四象限大卡）
 *
 * 功能：手机版任务板这一屏的渲染与写操作。
 * `renderBoard()` 一次画出整屏：**顶部的【项目 ▾】下拉**（起取代旧的作用域滑轨；
 * 最后一项是「＋ 新建项目…」，选中某个项目时旁边还有 ✎ 编辑 / 🗑 删除 ——
 * 「项目」屏已删，项目管理的家收进了这一屏）、周日期条、筛选条（全部 / 重要 / 紧急 / 类别 /
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { addDays, fmtLong, fmtShort, isWeekend, mondayOf, todayStr, weekName } from '../../core/date.js';
import { $, clipWidth, esc } from '../../core/dom.js';
import { mountModuleSlot, slotDefs } from '../../core/slots.js';
import { crossFade } from '../../core/transition.js';
import { activeOn, byDueAsc, quadRank } from '../../core/task.js';
import { scopeMetaOf, tasksOf } from '../../mobile/data.js';
import { uiOf } from '../../mobile/modules.js';
import { state } from '../../mobile/state.js';
import { emptyHtml, paintChrome, rowHtml, secHead, setBackHandler, toast } from '../../mobile/ui.js';

/** 药丸要认清的槽名（与两端接线表里 `idea` 声明的那个**逐字一致**） */
const BOARD_SLOT = 'board-pane';

/**
 * 从前那两个模块级的 `painting` / `again`（**合并式防重入**）**已收进
 * 防重入必须与「保留旧层」住同一个文件。⛔ 别在这里再加回来。
 */

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
  return slotDefs(state.modules, uiOf, state.me || {}).filter((it) => it.slots.includes(BOARD_SLOT));
}

/**
 * 功能：**屏内退一层**（系统返回键落到这一屏时宿主来问一句）—— 停在随手记那格就退回「任务」。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 * 从前任务板的药丸**不参与返回** ⇒ 人在「随手记」按返回会直接跳回上一级屏（今天），
 * 那个子屏整块丢掉。现在先退回「任务」那一格（同一屏内），再按才往上走。
 */
function boardBack() {
  if (!state.boardTab) return false;
  pick('');
  return true;
}

/**
 * 功能：画药丸 —— 第一项恒为**任务板自己**（`data-board-view=""`，也就是 `state.boardTab` 的空串），
 * 后面依次是各模块借这一屏贡献的视图（手机端画**线性图标**，用接线表里的 `svg`）。
 * @param {Array.<Object>} items - `paneItems()` 的产物
 * @returns {string} 药丸的 HTML（**没有模块贡献视图时返回空串 —— 整条不画**）
 */
function pillHtml(items, on) {
  // 只有一项时整条不画：只有一种视图时，一条切换控件是纯噪音（与 `webpass` 同一条口径）。
  if (!items.length) return '';
  const rows = [{ name: '', title: '任务', svg: '' }].concat(
    items.map((it) => ({ name: it.name, title: it.title, svg: it.svg || '' })),
  );
  return `<div class="dash-tabs" role="tablist">${rows
    .map((r) => {
      const ico = r.svg ? `<span class="tab-ico" aria-hidden="true">${r.svg}</span>` : '';
      return (
        `<button class="dash-tab${r.name === on ? ' on' : ''}" type="button" role="tab" ` +
        `aria-selected="${r.name === on}" data-board-view="${esc(r.name)}">` +
        `${ico}${esc(r.title)}</button>`
      );
    })
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
  // 走 **交叉淡入** —— 旧的那一块（`#board-main`）一直留到新的
  // 那一块（`#board-pane`）挂好，两层同格重叠再一起淡出 / 淡入。
  const done = renderBoard({ fade: true });
  // 宿主的 `updateChrome()` 只在**切标签**时跑，而这一次是同一屏内换的骨头
  // ⇒ 顶栏副标题会停在「作用域 · 日期」那套旧文案上（两处说的不是一件事）。
  paintChrome();
  if (!name || !done) return;
  // 切过来之后把光标放进这一块**第一个输入框**，用户接着就能打字。
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
 * 合并式防重入**已收进 `core/slots.js`**（见文件头上那条说明）。
 */
function paint(enter) {
  const pane = $('#board-pane');
  const name = state.boardTab;
  if (!pane || !name) return Promise.resolve();
  return mountModuleSlot(pane, 'mobile', name, BOARD_SLOT, {
    // `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    // `render(ctx)`（它自己的第一个参数不会进 ctx）。而视图片段要「先把根节点插进文档、
    // 再调模块的渲染函数」（那些函数按**全局 id** 找节点）⇒ 漏了这一项，片段一进门
    container: pane,
    end: 'mobile',
    modules: state.modules,
    uiOf,
    me: state.me,
    // **opt-in** 的交叉淡入 —— ⛔ 不传时 `mountModuleSlot()` 与今天逐字相同
    crossFade: true,
    // **进屏那一趟**（宿主切到这一屏那一下）不播槽内淡入 —— 整屏那一条已经在
    // 给这一屏淡入了，槽里再淡一次 = 「同一块内容连淡两次」（「模块与模块之间
    // 切换多次闪现」）。⚠️ 屏内点药丸那一趟（`pick()`）不传 ⇒ 交叉淡入照旧。
    enterFade: enter !== true,
  });
}

// ---------- 渲染：任务板（周日期条 + 当日列表，取代电脑端的甘特 + 四象限大卡） ----------
/**
 * 功能：渲染手机版任务板整屏 —— 顶部【项目 ▾】下拉、周日期条、四象限筛选条，以及逾期段与当日任务列表。
 * 选中日期缺省为今天，周起点缺省为今天所在周的周一；当日列表按象限权重从高到低、同权重按截止日升序排。
 *
 * 「上面的滑动选择项目改为下拉选择」）—— 项目一多滑轨要横向滑半天，下拉一步到位；
 */
export function renderBoard(opts) {
  const fade = !!(opts && opts.fade);
  // 第六轮（「各部分都应该是逐级返回到【今天】」）：把「屏内退一层」
  // 登记给宿主（`mobile/ui.js` 的 `setBackHandler`）——
  // 任务板停在「随手记」那一格时，系统返回**先回「任务」**，再按才往上走一层。
  setBackHandler('board', boardBack);
  // 这一屏的第一行多了一块**药丸槽**（`任务 ｜ 随手记`），
  // 随手记的界面挂进 `#board-pane`（由 `mountModuleSlot()` 动态 import 片段）。
  const tabs = $('#board-tabs');
  const main = $('#board-main');
  const pane = $('#board-pane');
  if (!tabs || !main || !pane) return;
  const mods = paneItems();
  // 当前选的那一块不在清单里了（模块被关掉 / 被整目录删掉）⇒ 回落到任务板自己
  if (state.boardTab && !mods.some((it) => it.name === state.boardTab)) state.boardTab = '';
  tabs.innerHTML = pillHtml(mods, state.boardTab);
  if (!pillBound) {
    pillBound = true;
    tabs.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-board-view]') : null;
      if (b) pick(b.getAttribute('data-board-view'));
    });
  }
  const onTask = !state.boardTab;
  if (fade) {
    // **交叉淡入**那一趟 —— 两层都要在场上（新层先摆好、
    // 旧层继续显示；挂载期间屏幕上一直是旧内容）。
    main.classList.remove('hidden');
    pane.classList.remove('hidden');
    // 第八轮（电脑端同款）：**要进场的那一层先按住**（`opacity` 不是 `hidden`，布局要留着）。
    // 下面 `paint()` 是异步挂载 ⇒ 不按住就是「两层叠着看」。放开与淡入由 `crossFade()` 做。
    (onTask ? main : pane).style.opacity = '0';
  } else {
    main.classList.toggle('hidden', !onTask);
    pane.classList.toggle('hidden', onTask);
  }
  if (!onTask) {
    // 挂载**只在这一个入口里**做（见文件头）：改造前「取数 / 重画」是两处分工，
    // 两处都变成「挂载整个视图」就会一次切屏挂两遍（容器里两个根节点，列表行数翻倍）。
    // 返回这一批挂载的 promise（含并发时自己补的那趟）—— `pick()` 要等它画完再放光标。
    const done = paint(!fade);
    if (!fade) return done.catch((e) => toast(e.message, true));
    // 挂完（新内容已就绪）⇒ 两层一起交叉淡入（`cleanup: 'hide'` —— 静态节点，⛔ 不能删）
    // `tier 2` —— 屏头药丸「任务 ↔ 随手记」＝**二级**。
    return done
      .then(() => crossFade([main], pane, { cleanup: 'hide', tier: 2 }))
      .catch((e) => {
        pane.style.opacity = '';
        toast(e.message, true);
      });
  }
  const today = todayStr();
  const sel = state.selDate || today;
  const start = state.weekStart || mondayOf(today);
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(start, i));

  // 顶部的【项目 ▾】（取代旧的作用域滑轨）。⚠️ 选项顺序与电脑版 `renderScopeSelect()` 一致：
  // 汇总任务视图在最前，其次日常任务，项目名按**显示宽度**截到 12 格（同一把尺子 `clipWidth`）。
  // 最前面补上「📊 汇总任务视图」（值 `all`）—— 与电脑版逐字同名同项。
  const isAll = state.scope === 'all';
  const isDaily = state.scope === 'daily';
  const meta = scopeMetaOf(state.scope);
  const scopeOptions =
    `<option value="all"${isAll ? ' selected' : ''}>📊 汇总任务视图</option>` +
    `<option value="daily"${isDaily ? ' selected' : ''}>📅 日常任务</option>` +
    state.projects
      .map(
        (p) =>
          `<option value="${p.id}"${p.id === state.scope ? ' selected' : ''}>${esc(p.icon || '📁')} ${esc(
            clipWidth(p.name, 12),
          )}</option>`,
      )
      .join('') +
    '<option value="__new__">＋ 新建项目…</option>';
  // 当前作用域对应的项目（日常任务 / 汇总时为 null）—— 编辑 / 删除按钮只对具体项目显示
  const curProject = state.projects.find((p) => p.id === state.scope) || null;
  const scopePick =
    `<div class="proj-pick"><select id="bd-scope" class="m-select" aria-label="选择项目">${scopeOptions}</select>` +
    (curProject
      ? `<button class="chip sm" type="button" data-act="proj-edit" data-id="${curProject.id}" aria-label="编辑项目">✎</button>` +
        `<button class="chip sm" type="button" data-act="proj-del" data-id="${curProject.id}" aria-label="删除项目">🗑</button>`
      : '') +
    `</div>`;

  // **列表的唯一数据源** —— 统一包成 `{t, scope, name, icon, color}`：
  // 汇总视图（`all`）直接用 `state.all`（`rebuildFlat()` 摊平的结果，**每条自带它那个项目**）；
  // 其余作用域把 `tasksOf()` 包上当前作用域的展示信息。
  const items = isAll
    ? state.all
    : tasksOf(state.scope).map((t) => ({
        t,
        scope: state.scope,
        name: meta.name,
        icon: meta.icon,
        color: meta.color,
      }));

  // 「日期下去掉紫色小点」—— 每格下面那排 `.ddots` 整个撤掉
  // （连同算条数那一步：它只为那几个点而存在，留着就是一段永远不出现在屏幕上的计算）。
  // 顶部现在只留「周几 + 日号」两行，格子高度随之收一半（见 `app.css` 的 `.day`）。
  const days = dates
    .map((d) => {
      return `<button class="day${d === today ? ' today' : ''}${d === sel ? ' on' : ''}${
        isWeekend(d) ? ' wend' : ''
      }" type="button" data-act="day" data-date="${d}">
      <div class="dw">${weekName(d).slice(1)}</div><div class="dn">${Number(d.slice(8))}</div></button>`;
    })
    .join('');

  // 筛选条：「全部 + 四象限五格 + 含已完成」六个按钮全删，
  // 改成**三个** —— 全部 / 重要 / 紧急。
  // `全部` = 两个开关都清掉，**两个都没开时它自己亮着**；
  const noFilter = !state.impOn && !state.urgOn && !state.kindFilter && !state.statusFilter;
  /** 任务类别（`task_kind`）筛选项 @type {Array.<Array.<string>>} */
  const KIND_OPTS = [
    ['', '类别'],
    ['plain', '普通'],
    ['window', '窗口'],
    ['cycle', '周期'],
  ];
  /** 状态筛选项（`status` 取值与服务端一一对应） @type {Array.<Array.<string>>} */
  const STATUS_OPTS = [
    ['', '状态'],
    ['todo', '待办'],
    ['doing', '进行中'],
    ['done', '已完成'],
    ['paused', '已搁置'],
  ];
  /**
   * 功能：画一个筛选下拉（空值那一项就是它的「不筛」档）。
   * @param {string} id - 元素 id（宿主按它分发 `change`）
   * @param {Array.<Array.<string>>} opts - `[值, 文案]` 列表
   * @param {string} cur - 当前值（空串 = 不筛）
   * @returns {string} `<select>` 的 HTML
   */
  const selHtml = (id, opts, cur) =>
    `<select id="${id}" class="tf-sel${cur ? ' on' : ''}">` +
    opts.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`).join('') +
    `</select>`;
  const filterHtml =
    `<button class="chip q${noFilter ? ' on' : ''}" type="button" data-act="tf-all" style="--qc:var(--ink)">全部</button>` +
    `<button class="chip q${state.impOn ? ' on' : ''}" type="button" data-act="tf-imp" style="--qc:var(--danger)">重要</button>` +
    `<button class="chip q${state.urgOn ? ' on' : ''}" type="button" data-act="tf-urg" style="--qc:var(--warn)">紧急</button>` +
    selHtml('tf-kind', KIND_OPTS, String(state.kindFilter || '')) +
    selHtml('tf-status', STATUS_OPTS, String(state.statusFilter || ''));

  /**
   * 选中日期当天可见的任务。
   * 「含已完成」开关删掉之后，这里**不再按完成状态过滤** —— 一条任务完成当天仍在
   */
  let list = items.filter((w) => activeOn(w.t, sel, today));
  // 两个开关**各自独立**，同时开 = 既重要又紧急（标准筛选条的收窄行为选的口径）
  if (state.impOn) list = list.filter((w) => Number(w.t.important));
  if (state.urgOn) list = list.filter((w) => Number(w.t.urgent));
  // 修订：类别（任务类型）与状态两个下拉 —— 老数据没有 `task_kind` ⇒ 当「普通」
  if (state.kindFilter) list = list.filter((w) => (w.t.task_kind || 'plain') === state.kindFilter);
  if (state.statusFilter) list = list.filter((w) => (w.t.status || 'todo') === state.statusFilter);
  const winFirst = (t) => (t.task_kind === 'window' ? 0 : 1);
  list.sort((a, b) => winFirst(a.t) - winFirst(b.t) || quadRank(b.t) - quadRank(a.t) || byDueAsc(a.t, b.t));

  // 汇总视图里每一行都要看得出**属于哪个项目**（`hideScope: false`）；其余作用域不必重复当前项目名
  // `date` 必须传下去：周期任务那一行要按**选中日**算「这一期是哪一期」（见 `ui.js` 的 `rowHtml`）。
  const rowOpts = { hideScope: !isAll, date: sel };

  // 修订：只剩**一段**（选中日期当天）—— 原先那个「逾期未完成」段按的话撤掉
  // （见文件头说明）。逾期未完成的任务靠 `visEnd()` 顺延到今天，照样在这一段里、带「逾期 N 天」。
  const body = `<div class="sec">${secHead(fmtLong(sel) + ' ' + weekName(sel), meta.color, list.length + ' 项')}${
    list.length
      ? `<div class="list">${list.map((w) => rowHtml(w, rowOpts)).join('')}</div>`
      : emptyHtml('🗓', '这一天没有任务', '换个日期，或点右下角 ＋ 新建')
  }</div>`;

  // **固定头 + 内部滚动区**两段式 ——
  // 项目下拉 / 周条 / 日期条 / 筛选条写进 `.board-head`（`flex:none`，不随滑动移动），
  // 逾期段与当日列表写进 `.board-scroll`（**唯一**滚动的那一块）。
  main.innerHTML = `
    <div class="board-head">
      ${scopePick}
      <div class="weekbar">
        <button class="wbtn" type="button" data-act="week-prev" aria-label="上一周">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6l-6 6 6 6"/></svg></button>
        <span class="wlabel">${fmtShort(dates[0])} ~ ${fmtShort(dates[6])}</span>
        <button class="wbtn today" type="button" data-act="week-today">今天</button>
        <button class="wbtn" type="button" data-act="week-next" aria-label="下一周">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg></button>
      </div>
      <div class="daystrip">${days}</div>
      <div class="filterbar">${filterHtml}</div>
    </div>
    <div class="board-scroll">${body}</div>`;
  // 反向（随手记 → 任务板）—— `#board-main` 的内容是**同步**画好的、
  // 立刻就有 ⇒ 同样不藏旧的那一层，直接两层一起交叉淡入。
  // `tier 2` —— 同上（反向那一趟）。
  if (fade) crossFade([pane], main, { cleanup: 'hide', tier: 2 });
}

