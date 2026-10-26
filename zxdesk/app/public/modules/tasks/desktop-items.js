/**
 * modules/tasks/desktop-items.js —— 任务条目（四象限卡片 / 就地改标题 / 详情弹窗）
 *
 * 功能：任务条目的渲染与交互。
 *      `taskItemHtml()` 生成一条任务的 HTML；`bindTaskItems()` 给它绑上勾选 / 编辑 / 删除 / 打开详情；
 *      `itemKey()` / `taskMapOf()` / `taskOfItem()` / `findTask()` 维护「DOM 条目 → 任务数据」的映射；
 *      `renderQuadrant()` 画四象限（⭐ 0.5.2 起逾期未完成的并入并标红，不再有顶部逾期条）；
 *      `openTaskDetail()` / `closeDetail()` 开关任务详情弹窗。
 *
 * ⭐ 0.5.0：本文件从 `public/desktop/views/items.js` **原样搬进任务板模块目录**。
 *    一个模块一个文件夹 —— 这一屏只服务任务板这一个模块，所以它的家是 `modules/tasks/`，
 *    不该留在跨端共用的 `views/` 里。⚠️ 只改了 import 路径与本节注释，渲染逻辑一个字没动。
 *    命名约定（一个模块不止一屏时用 `<端>-<屏名>.js`）见 `modules/tasks/README.md` 与 `07-前端`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.15
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { QUADS, STATUS } from '../../core/constants.js';
import { dashEntries } from '../../core/dashboard.js';
import { fmtDate, fmtShort, todayStr } from '../../core/date.js';
import { $, clipWidth, el, esc } from '../../core/dom.js';
import { clock } from '../../core/clock.js';
import { missedPeriods, periodOf, periodsBetween, ruleText, tickProgress } from '../../core/recur.js';
import { boardVisibleOn, doneInfo, overdueDays, windowState } from '../../core/task.js';
import { assertWritable } from '../../desktop/shell.js';
import { scopeKey, state } from '../../desktop/state.js';
import { doneLabel, toast } from '../../desktop/ui.js';
import { quadOf } from './desktop-board.js';
import { tickOccurrence } from './shared.js';
import { delTask, editTask, refreshAfterWrite, toggleTask } from './desktop-tasks.js';

/**
 * 功能：给周期任务**打卡「本期」**（0.8.14）。
 *
 * 说明：⭐ 与 `toggleTask()` 的区别是本质性的：周期任务的勾选是「**这一期**做完了」，
 *      任务本身**不进「已完成」**（它要到整个周期的结束日才自动算完成）⇒ 走打卡接口。
 *      ⚠️ 失败要把勾**还原**（否则界面上显示打上了、库里没有，用户第二天才发现）并弹提示。
 *      ⚠️ 成功后按当前作用域刷新（打卡会影响「已打卡几期」与逾期标记）。
 *
 * @param {(string|number)} scope - 作用域，`'daily'` 或项目 id
 * @param {(number|string)} id - 任务 id
 * @param {string} periodKey - 本期的周期起点日期（`periodOf().key`）
 * @param {boolean} on - true 打卡、false 取消
 * @param {HTMLInputElement} chk - 那个勾选框（失败时还原它）
 * @returns {Promise.<void>}
 */
async function tickItem(scope, id, periodKey, on, chk) {
  if (!assertWritable()) {
    chk.checked = !on;
    return;
  }
  try {
    await tickOccurrence(scope === 'daily' ? 'daily' : 'project', id, periodKey, on);
  } catch (e) {
    chk.checked = !on;
    return toast(e.message, true);
  }
  await refreshAfterWrite(scope);
}

/**
 * 功能：取一条任务**真正所属**的作用域 —— ⭐ 0.5.2 汇总视图（`state.scope === 'all'`）里
 *      列表是**所有项目的任务混在一起**的，这时当前作用域是「汇总」、不是任何具体项目，
 *      而勾选 / 编辑 / 删除 / 详情都**必须**打到它原来那个项目上。
 *
 * 说明：⚠️ 判据是任务行上的 `_scope`（汇总取数时就地写上去的，见 `desktop-board.js` 的 `loadBoard()`）；
 *      普通视图下行上没有这个键，一律回落到当前作用域 —— 一条判据两处通用，
 *      不要在调用点写 `state.scope === 'all' ? …: …`（那种写法漏一处就是「编辑存到别的项目去了」，
 *      而且**不报任何错**）。
 *
 * @param {Object} t - 任务对象
 * @param {(string|number)} fallback - 任务上没有 `_scope` 时用哪个作用域（一般是 `state.scope`）
 * @returns {(string|number)} `'daily'` 或项目 id
 */
export const taskScope = (t, fallback) => (t && t._scope !== undefined ? t._scope : fallback);

/**
 * 功能：把一批任务按「作用域:id」建索引，整体写进 `state.itemMap` 并返回这个 Map。
 *
 * 说明：⭐ 每条任务先过 `taskScope()`（0.5.2）：**汇总任务视图**（`scope === 'all'`）里
 *      `state.tasks` 是所有项目的任务混在一起的，条目 DOM 上的 `data-scope` 写的是
 *      各自的项目 id —— 索引键必须与之逐字一致，否则 `taskOfItem()` 全部查空，
 *      表现是「汇总视图里点任务没反应、勾不了、编辑不了」（0.5.2 首轮实测踩过）。
 *
 * @param {(string|number)} scope - 作用域：`'daily'` / 项目 id / `'all'`（汇总视图）
 * @param {Array.<Object>} tasks - 任务数组；传空值时按空数组处理
 * @returns {Map} 条目键 → 任务对象
 */
export function taskMapOf(scope, tasks) {
  const m = new Map();
  (tasks || []).forEach((t) => m.set(itemKey(taskScope(t, scope), t.id), t));
  state.itemMap = m;
  return m;
}

/**
 * 功能：把作用域与任务 id 拼成条目在 `state.itemMap` 里的键。
 *
 * 说明：条目 ↔ 任务数据的映射不能只靠 `state.tasks` —— 搜索结果可能跨项目，
 *      所以键里必须带上作用域（`scopeKey(scope) + ':' + Number(id)`）。
 *
 * @param {(string|number)} scope - 作用域：`'daily'` 或项目 id
 * @param {(string|number)} id - 任务 id
 * @returns {string} 条目键
 */
export const itemKey = (scope, id) => scopeKey(scope) + ':' + Number(id);

/**
 * 功能：从一个条目 DOM 节点上读 `data-scope` / `data-id`，到 `state.itemMap` 里取回对应任务。
 * @param {HTMLElement} node - 带 `data-scope` / `data-id` 的 `.task-item` 节点
 * @returns {?Object} 任务对象；映射里没有该条目时为 undefined
 */
export const taskOfItem = (node) => state.itemMap.get(itemKey(node.dataset.scope, node.dataset.id));

/**
 * 功能：生成一条任务条目的 HTML（日常 & 项目任务通用，搜索结果也用它）。
 *
 * 说明：`scope` 写进 `data-scope` —— 所有操作都从 DOM 上读，因此搜索结果里跨项目也能正确操作。
 *
 * @param {(string|number)} scope - 作用域：`'daily'` 或项目 id，原样写进 `data-scope`
 * @param {Object} t - 任务对象（读 id / title / status / assignee / tag / completed_at / due_date）
 * @param {Object} [opts] - 可选，条目选项；`opts.index` 存在时写成入场动画用的 `--i` 序号
 * @returns {string} 条目 HTML
 */
export function taskItemHtml(scope, t, opts) {
  const o = opts || {};
  const done = t.status === 'done';
  const today = todayStr();
  // ⭐ 0.5.2 第二轮：逾期未完成的条目**标红** ——
  //    逾期条撤掉之后（见 `renderQuadrant()`），红色就是逾期任务唯一的特殊标记。
  //    ⚠️ 与甘特条同一口径：只按真实今天算（`t.due_date < today`），不拿选中日充数。
  //    ⚠️⭐ 0.8.14：⛔ **不许**用 `visEnd()` 的顺延结果判逾期 —— 它顺延之后正好等于 `today`，
  //    那样这条标记会**静默消失**（甘特条那边有同一条注释，两处同一个坑）。
  //    ⚠️ 周期任务也不在此列（它的账按「每一期」各算，见下面那枚本期药丸）。
  // ⭐⭐ 0.8.14：「周期任务的逾期没有实现」⇒ 它的账**按欠了几期**算
  //    —— 「已过完、却还没打卡」的期数（判据只住 `core/recur.js` 的 `missedPeriods()`）。
  const cycMissed = t.task_kind === 'cycle' ? missedPeriods(t, t.ticks, today, clock.now()).length : 0;
  const overdue = cycMissed > 0 || (t.task_kind !== 'cycle' && !done && !!t.due_date && t.due_date < today);
  // ⭐⭐ 0.8.14：周期任务在四象限里**只显示「该日那一期」** ——
  //    这一期的起止与「打过卡没有」都由 `core/recur.js` 一处算（判据只有一处）。
  const per = t.task_kind === 'cycle' ? periodOf(t, o.date || today) : null;
  const ticked = per ? (t.ticks || []).map(String).includes(String(per.key)) : false;
  // ⚠️ 任务条目不显示日期—— 日期交给上方的甘特时间轴与详情弹窗，
  // 条目这行只留标题 + 负责人/标签/状态，一行的宽度要尽量给标题。
  const assignee = t.assignee ? `<span class="pill">👤 ${esc(t.assignee)}</span>` : '';
  const tag = t.tag ? `<span class="pill">🏷 ${esc(t.tag)}</span>` : '';
  const di = doneInfo(t);
  // 「已完成」带上完成日：任务从完成日之后就不再出现在计划日期里（见 visEnd），
  // 只写「已完成」的话，用户第二天发现它不见了会以为是丢了 —— 写清日期，规则自解释。
  // 老数据没有完成时间 ⇒ 写「已完成 截至 9/15」，**不假装那天完成的**（见 doneInfo 的 approx）。
  const donePill = done ? `<span class="pill done">已完成${di ? ' ' + esc(doneLabel(di)) : ''}</span>` : '';
  // ⭐⭐ 0.8.14（方案 §五②）：从前只写「已逾期」三个字，现在写**逾期几天**
  //    （「甘特图和四象限图都应该显示逾期 x 天」）。
  const overPill = overdue
    ? `<span class="pill over">${
        t.task_kind === 'cycle' ? `欠 ${cycMissed} 期` : `逾期 ${overdueDays(t, today)} 天`
      }</span>`
    : '';
  // ⭐ 0.8.14：周期任务那一行写「本期 起–止」（＝这一天该做的那一期）+ 打过卡没有
  const perPill = per
    ? `<span class="pill cycle${ticked ? ' done' : ''}">本期 ${esc(fmtShort(per.start))}${
        per.end !== per.start ? '–' + esc(fmtShort(per.end)) : ''
      }${ticked ? ' ✓' : ''}</span>`
    : '';
  // ⭐ 0.8.14：窗口任务把头两个时刻与**倒计时**写在条目上（方案 §1.5：四象限要显示窗口时间
  //    与截止倒计时）。⚠️ 「现在」只从 `core/clock.js` 来（服务端校准过的那个），
  //    判据只住 `core/task.js` 的 `windowState()` —— ⛔ 别在这里自己算一遍。
  const ws = windowState(t, clock.now());
  // ⭐⭐ 0.8.14：「已过窗口就要标红 醒目一点 和逾期有区分度」——
  //    过了窗口那一枚换成 `win-over`（琥珀实底 + 深琥珀加粗字），与逾期的「浅红底红字」分开。
  const winOver = !!(ws && ws.phase === 'after');
  // ⚠️⭐ 0.8.14 第二轮：「设置了窗口期的也要和窗口任务一样显示」——
  //    判据从 `task_kind === 'window'` 改成**按有没有填时刻**（周期任务勾了「设置时间窗」也走这条，
  //    与 `windowState()` 自己的判据同一条；详情里「时间窗」那一格一直是按值判的）。
  const winPill =
    t.start_time || t.due_time
      ? `<span class="pill win${winOver ? ' win-over' : ''}">⏱ ${esc(
          [t.start_time, t.due_time].filter(Boolean).join('~'),
        )}${ws ? ' · ' + esc(ws.text) : ''}</span>`
      : '';
  // ⭐ 0.5.2：汇总视图里每条都得看得出「属于哪个项目」（`_project` 只有汇总取数时才带上，见 loadBoard）
  const projPill = t._project
    ? `<span class="pill brand" title="${esc(t._project.name)}">${esc(t._project.icon || '📁')} ${esc(
        clipWidth(t._project.name, 12),
      )}</span>`
    : '';
  const meta = `${projPill}${winPill}${perPill}${assignee}${tag}${overPill}${donePill}`;
  // 列表里只显示标题：任务的描述/内容（t.description || t.content）只在详情弹窗里看，
  // 列表上再铺一段正文会把每一行撑成三行、一屏看不了几条（指令）。
  // ⭐ 0.5.2：「移除点击任务标题可直接输入的功能，点击直接弹窗任务详情即可」——
  //    以前点标题是**就地改标题**（会在原地换成输入框），点空白处才是详情。现在两者统一成「打开详情」：
  //    就地编辑靠 ✎ 按钮（以及键盘 E），而「想看看这条任务到底说了什么」是最常见的动作，
  //    它不该和「改标题」抢同一个点击位置。
  return `
    <div class="task-item${done ? ' done' : ''}${overdue ? ' over' : ''}${per ? ' cycle' : ''}" data-id="${
      t.id
    }" data-scope="${scope}"${per ? ` data-period="${esc(per.key)}"` : ''} tabindex="0"${
      o.index ? ` style="--i:${o.index}"` : ''
    }>
      <input type="checkbox" class="chk" ${
        per ? (ticked ? 'checked' : '') : done ? 'checked' : ''
      } aria-label="${per ? '打卡本期' : '标记完成'}">
      <div class="ti-body">
        <div class="ti-title" title="${esc(t.title)}（点开看详情，要改标题点 ✎）">${esc(t.title)}</div>
        ${meta ? `<div class="ti-meta">${meta}</div>` : ''}
      </div>
      <div class="ti-actions">
        <button class="icon-btn" title="编辑（E）">✎</button>
        <button class="icon-btn del" title="删除（Del，可撤销）">🗑</button>
      </div>
    </div>`;
}

/**
 * 功能：给一批任务条目绑事件（四象限与搜索结果共用一套）—— 勾选框完成、✎ 编辑、🗑 删除，
 *      以及点条目（含标题）打开任务详情。
 *
 * 说明：传入的 `map` 会整体覆盖 `state.itemMap`（条目 → 任务数据），跨项目的搜索结果才取得到任务。
 *      ⚠️ 删除**不弹确认框**，删除后由 toast 里提供「撤销」按钮（撤销实现见 `./tasks.js` 的 `delTask()`）；
 *      这与「删除成员必须二次确认、不可撤销」是刻意相反的取舍。
 *
 * @param {HTMLElement} root - 承载条目的容器节点
 * @param {Map} [map] - 可选，条目键 → 任务数据；不传则沿用 `state.itemMap`
 * @returns {void}
 */
export function bindTaskItems(root, map) {
  if (map) state.itemMap = map;
  root.querySelectorAll('.task-item').forEach((itm) => {
    const id = Number(itm.dataset.id);
    const scope = scopeKey(itm.dataset.scope);
    /** 功能：取这个条目当前对应的任务数据（每次点击都重查映射，不缓存可能已过期的对象）。 */
    const task = () => taskOfItem(itm);
    const chk = itm.querySelector('.chk');
    if (chk) {
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        // ⭐⭐ 0.8.14：周期任务的勾选 ＝ **打卡「本期」**（走打卡接口），
        //    ⛔ 不是「把整条任务标完成」—— 任务本身还要继续（它到周期结束日才自动算完成）。
        const period = itm.dataset.period || '';
        if (period) return tickItem(scope, id, period, chk.checked, chk);
        toggleTask(scope, id);
      });
      chk.addEventListener('click', (e) => e.stopPropagation());
    }
    const editBtn = itm.querySelector('.ti-actions .icon-btn:not(.del)');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = task();
        if (t) editTask(scope, t);
      });
    }
    const delBtn = itm.querySelector('.ti-actions .del');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = task();
        if (t) delTask(scope, t);
      });
    }
    itm.addEventListener('click', (e) => {
      if (e.target.closest('.chk') || e.target.closest('.ti-actions') || e.target.closest('.ti-title-edit')) return;
      const t = task();
      if (t) openTaskDetail(scope, t);
    });
  });
}

/**
 * 功能：取任务对象 —— 依次查三处：当前渲染出的条目映射 `state.itemMap`（搜索结果跨项目也成立）、
 *      **首页看板那一份快照**、当前作用域的 `state.tasks`。
 *
 * 说明：⭐ 0.8.5 补上中间那一处（首页看板）。「首页看板点完成很大机率不行，
 *      得重新进入软件」—— 根因就在本函数的**第二、三处**：
 *      · 首页看板上的任务**不在** `state.itemMap` 里（那里面只有任务板 / 搜索结果渲染过的条目）；
 *      · 而 `state.scope` 在首页**根本对不上**（默认就是 `'all'`，与项目 id / `'daily'` 永不相等）
 *        ⇒ 第三处恒不命中 ⇒ 返回 null ⇒ `toggleTask()` 那句 `if (!t) return;` **静默收场**。
 *      表现：弹窗关了、任务没变、控制台干净 —— 只有「先去过一次任务板」才碰巧能用
 *      （那时 `itemMap` 里恰好有这条），所以是「很大机率不行」而不是必错。
 *      ⚠️ 拿 `state.dash.data` 当兜底要**同时比 id 与作用域**：看板是跨项目的，只比 id
 *      会把别的项目里同 id 的任务当成它（那正是 `rowKey()` / `taskScope()` 一直在防的事）。
 *
 * @param {(string|number)} scope - 作用域：`'daily'` 或项目 id
 * @param {(string|number)} id - 任务 id
 * @returns {?Object} 任务对象；三处都没找到时为 null
 */
export function findTask(scope, id) {
  const hit = state.itemMap.get(itemKey(scope, id));
  if (hit) return hit;
  const x = dashEntries(state.dash && state.dash.data).find(
    (e) => e.kind === 'task' && e.task && Number(e.task.id) === Number(id) && scopeKey(e.source) === scopeKey(scope),
  );
  if (x) return x.task;
  if (scopeKey(scope) === state.scope) return state.tasks.find((x) => x.id === Number(id)) || null;
  return null;
}

/**
 * 功能：渲染四象限 —— 选中日落入 [任务日, 截止日期] 的任务按 (important, urgent)
 *      分进四个区域，**逾期未完成的并入当天并标红**（0.5.2 起，不再单独置顶一条逾期条），
 *      最后统一给这些条目绑事件。
 *
 * 说明：画成一个坐标系：横轴「重要」（右为正）、纵轴「紧急」（上为正），
 *      任务按 (important, urgent) 落在四个区域 —— 右上 Q1 / 右下 Q2 / 左上 Q3 / 左下 Q4。
 *      落位写死在 CSS 的 `.qa-cell[data-q]` 上（顺序与 `QUADS` 无关），轴与轴标只是装饰。
 *      ⭐ 0.5.2 （第二轮）：「逾期任务不单独在顶部显示，而是自动移入当天的任务，并标红」
 *      —— 顶部的「⚠ 逾期未完成」条整块撤掉（`#bd-overdue` 骨架与 `.overdue-strip` 样式一并删）；
 *      逾期任务直接出现在选中日的象限里（`taskItemHtml()` 落 `.over` 红标题 +「已逾期」标）。
 *      ⚠️⭐ 口径（0.8.15 修过一次，见 `core/task.js` 的 `boardVisibleOn()`）：
 *      **逾期只按真实今天判**（分册 `05-任务板.md` 原文）—— 切到未来日期时，只有**今天已经逾期**
 *      的任务才并进来，**今天还没到期的不算**。⛔ 旧实现拿「选中日」当基准，于是「今天 8 号、
 *      任务 A 是 9 号的、看 10 号」会把 A 也塞进 10 号那一屏（而且它连红标都没有 —— 红标按真实今天算）。
 *
 * @returns {void}
 */
export function renderQuadrant() {
  const date = state.selectedDate || todayStr();
  // 四象限：选中日落入 [任务日,截止日期] 的任务；⭐ 逾期未完成的并入（见上面的口径）。
  // 画成一个坐标系：横轴「重要」（右为正）、纵轴「紧急」（上为正），
  // 任务按 (important, urgent) 落在四个区域 —— 右上 Q1 / 右下 Q2 / 左上 Q3 / 左下 Q4。
  // 落位写死在 CSS 的 `.qa-cell[data-q]` 上（顺序与 QUADS 无关），轴与轴标只是装饰。
  // ⚠️ 0.8.14：判据要带**真实今天**（`todayStr()`），⛔ 不是选中日 —— 「顺延到今天」说的是真实那一天。
  // ⚠️⭐ 0.8.15：那一句「逾期未完成的并入」**不再写在这里** —— 它连同 `activeOn` 一起收进了
  //    `core/task.js` 的 `boardVisibleOn()`（0.8.15 就是这里取错了基准：旧写法拿**选中日**
  //    当基准去比截止日 ⇒ 看未来日期时把「还没到期」的任务也并了进来，而红标按真实今天算
  //    ⇒ 它就成了一条**没有任何标记**的、本不属于那一天的任务）。
  //    ⛔ 别再把那两个条件抄回本文件：基准改一处、抄本漏一处 = 同一个缺陷换个地方复发。
  const today = todayStr();
  const tasks = state.tasks.filter((t) => boardVisibleOn(t, date, today));
  const grid = $('#quad-grid');
  grid.innerHTML = '';
  const plot = el('div', 'qa-plot');
  plot.innerHTML =
    '<div class="qa-axis qa-axis-x" aria-hidden="true"></div>' +
    '<div class="qa-axis qa-axis-y" aria-hidden="true"></div>' +
    '<span class="qa-lab qa-lab-pos-x" aria-hidden="true">重要</span>' +
    '<span class="qa-lab qa-lab-neg-x" aria-hidden="true">不重要</span>' +
    '<span class="qa-lab qa-lab-pos-y" aria-hidden="true">紧急</span>' +
    '<span class="qa-lab qa-lab-neg-y" aria-hidden="true">不紧急</span>';
  QUADS.forEach((q) => {
    // ⭐ 0.8.14（方案 §1.1⑧）：**窗口任务在同一个象限组内排最前面**（它优先级最高）——
    //    只在这一组内提前，⛔ 不改变它落在哪个象限（象限仍按重要 / 紧急判）。
    //    ⚠️ `sort` 是稳定的 ⇒ 同类之间保持原有顺序。
    const list = tasks
      .filter((t) => Number(t.important) === q.imp && Number(t.urgent) === q.urg)
      .sort((a, b) => (b.task_kind === 'window' ? 1 : 0) - (a.task_kind === 'window' ? 1 : 0));
    const cell = el('div', 'qa-cell');
    cell.dataset.q = q.key;
    cell.style.setProperty('--qc', q.color);
    cell.innerHTML = `<div class="quad-head"><div class="qh-text"><div class="qh-label">${esc(q.label)}</div><div class="qh-sub">${esc(q.sub)}</div></div><span class="qh-count">${list.length}</span></div>`;
    const body = el('div', 'quad-body');
    // ⭐ 0.5.2：汇总视图（`scope === 'all'`）里这一列是**所有项目的任务**，
    //    每条都得按它自己那个项目去操作（见 `taskScope()` 的说明）
    body.innerHTML = list.length
      ? list.map((t, i) => taskItemHtml(taskScope(t, state.scope), t, { index: i + 1, date })).join('')
      : `<div class="empty-hint">${fmtDate(date)} 无此象限任务</div>`;
    cell.appendChild(body);
    plot.appendChild(cell);
  });
  grid.appendChild(plot);
  bindTaskItems(grid, taskMapOf(state.scope, state.tasks));
}

/**
 * 功能：打开任务详情弹窗 —— 填上标题、补充说明，以及日期 / 状态 / 四象限 / 负责人 / 标签 /
 *      完成时间 / 逾期提示这几格，并接好「编辑」「删除」「标记完成」三个按钮。
 *
 * 说明：补充说明兼容 `description` 与老的 `content`；已完成但库里没有 `completed_at` 的老数据，
 *      按截止日期显示并注明「按截止日期计」（见 `core/task.js` 的 `doneInfo()`）。
 *
 * @param {(string|number)} scope - 任务所属作用域：`'daily'` 或项目 id
 * @param {Object} t - 任务对象
 * @returns {void}
 */
export function openTaskDetail(scope, t) {
  state.detail = { scope, task: t };
  const done = t.status === 'done';
  const s = t.start_date || t.due_date,
    e = t.due_date;
  const desc = t.description || t.content;
  const di = doneInfo(t);
  const od = overdueDays(t, todayStr());
  // ⭐ 0.8.14：周期任务的「逾期」不是天数而是**欠了几期**（见 `missedPeriods()`）
  const cycMissed = t.task_kind === 'cycle' ? missedPeriods(t, t.ticks, todayStr(), clock.now()).length : 0;
  const overdue = t.task_kind === 'cycle' ? cycMissed > 0 : od > 0 && !done;
  // ⭐⭐ 0.8.14：「任务详情要显示这个任务的全部信息」——
  //    类型 / 时刻 / 循环规则 / 归属都是 0.8.14 新加的东西，详情里原本一格都没有
  //    （截图里那条窗口任务只显示「日期 / 状态 / 四象限」，看不出它是个窗口任务）。
  const kinds = { plain: '普通', window: '窗口（限时完成）', cycle: '周期（打卡任务）' };
  const kind = kinds[t.task_kind] || kinds.plain;
  // ⚠️ 0.8.14 第二轮：按**有没有填时刻**判（周期任务勾了「设置时间窗」也照窗口任务显示）
  const ws = windowState(t, clock.now());
  const rule = t.task_kind === 'cycle' ? ruleText(t.recur_rule) : '';
  // ⭐⭐ 0.8.14：「周期任务的详情要显示：打卡 x 天 / 共 x 天」——
  //    单位按频率自动（每天=天、每周/每月=期），判据只住 `core/recur.js` 的 `tickProgress()`。
  const prog = t.task_kind === 'cycle' ? tickProgress(t, t.ticks) : null;
  // ⭐⭐ 0.8.14 修订：「不是点击就打卡 / 取消了，要和其它一样进入详情，
  //    **在详情中打卡**」⇒ 打卡入口搬进这里：列出这个周期的**每一期**，点一下打 / 取消。
  //    ⚠️ `t.ticks` 是**期起点日期字符串数组**（见 `modules/tasks/routes.js` 的 `attachTicks()`），
  //    ⛔ 不是整行记录 —— 判「这一期打过没有」直接比字符串。
  const cycPeriods = t.task_kind === 'cycle' ? periodsBetween(t, s, e) : [];
  const tickSet = new Set((t.ticks || []).map(String));
  const sc = taskScope(t, state.scope);
  const proj = sc === 'daily' ? null : state.projects.find((p) => Number(p.id) === Number(sc));
  const scopeText = sc === 'daily' ? '📅 日常任务' : proj ? `${proj.icon || '📁'} ${proj.name}` : '';
  $('#md-title').textContent = '任务详情';
  $('#md-body').innerHTML = `
    <div class="detail-title">${esc(t.title)}</div>
    ${desc ? `<div class="detail-desc">${esc(desc)}</div>` : '<div class="detail-desc muted">（无补充说明）</div>'}
    <div class="detail-grid">
      <div class="detail-cell"><span class="dc-label">类型</span><span class="dc-val">${esc(kind)}</span></div>
      ${scopeText ? `<div class="detail-cell"><span class="dc-label">归属</span><span class="dc-val">${esc(scopeText)}</span></div>` : ''}
      <div class="detail-cell"><span class="dc-label">日期</span><span class="dc-val">${s && e ? `${fmtDate(s)} ~ ${fmtDate(e)}` : '—'}</span></div>
      ${
        // ⚠️ 0.8.14：周期任务也可能有时刻（勾了「设置时间窗」）⇒ 按**有没有值**判，不按类型
        t.start_time || t.due_time
          ? `<div class="detail-cell"><span class="dc-label">时间窗${
              t.task_kind === 'cycle' ? '（每一期）' : ''
            }</span><span class="dc-val">${t.start_time ? esc(t.start_time) : '不限'} ~ ${
              t.due_time ? esc(t.due_time) : '不限'
            }</span></div>`
          : ''
      }
      ${
        ws
          ? `<div class="detail-cell"><span class="dc-label">当前</span><span class="dc-val${
              ws.phase === 'after' ? ' win-over-text' : ''
            }">${esc(ws.text)}</span></div>`
          : ''
      }
      ${rule ? `<div class="detail-cell"><span class="dc-label">循环</span><span class="dc-val">${esc(rule)}</span></div>` : ''}
      ${
        prog && prog.total
          ? `<div class="detail-cell"><span class="dc-label">打卡</span><span class="dc-val" id="md-prog">${esc(
              prog.text,
            )}</span></div>`
          : ''
      }
      <div class="detail-cell"><span class="dc-label">状态</span><span class="dc-val">${esc(STATUS[t.status] || t.status)}</span></div>
      <div class="detail-cell"><span class="dc-label">四象限</span><span class="dc-val" style="color:${(QUADS.find((x) => x.imp === Number(t.important) && x.urg === Number(t.urgent)) || {}).color || 'inherit'}">${esc(quadOf(t))}</span></div>
      ${t.assignee ? `<div class="detail-cell"><span class="dc-label">负责人</span><span class="dc-val">${esc(t.assignee)}</span></div>` : ''}
      ${t.tag ? `<div class="detail-cell"><span class="dc-label">标签</span><span class="dc-val">${esc(t.tag)}</span></div>` : ''}
      ${t.created_at ? `<div class="detail-cell"><span class="dc-label">创建于</span><span class="dc-val">${esc(String(t.created_at).slice(0, 16))}</span></div>` : ''}
      ${
        // ⭐ 0.5.2 跨模块：任务上绑的网址（「任务可绑定网址 … 四象限在详细中显示」）。
        //    ⚠️ 在新标签页打开并带 `noopener` —— 跳的是**外部网站**，不能让它拿到本页的 window。
        t.bookmark
          ? `<div class="detail-cell"><span class="dc-label">网址</span><span class="dc-val"><a class="dc-link" href="${esc(
              t.bookmark.url,
            )}" target="_blank" rel="noopener noreferrer" title="${esc(t.bookmark.url)}">🔗 ${esc(
              t.bookmark.title || t.bookmark.url,
            )}</a></span></div>`
          : ''
      }
      ${
        di && di.approx
          ? `<div class="detail-cell"><span class="dc-label">完成于</span><span class="dc-val">${fmtDate(di.date)} <span class="muted">（老数据未记录完成时间，按截止日期计）</span></span></div>`
          : t.completed_at
            ? `<div class="detail-cell"><span class="dc-label">完成于</span><span class="dc-val">${esc(t.completed_at)}</span></div>`
            : ''
      }
      ${
        overdue
          ? `<div class="detail-cell"><span class="dc-label">提示</span><span class="dc-val warn">${
              t.task_kind === 'cycle'
                ? `⚠ 有 ${cycMissed} 期没打卡`
                : `⚠ 已于 ${fmtDate(e)} 逾期，已逾期 ${od} 天`
            }</span></div>`
          : ''
      }
    </div>
    ${
      // ⭐⭐ 0.8.14 修订：周期任务的打卡入口 —— 甘特图上那几段现在只负责
      //    「打开这条详情」，打 / 取消打都在这里（一期一枚小按钮，带 ✓ 的就是打过的）。
      cycPeriods.length
        ? `<div class="detail-ticks"><div class="dc-label">本期打卡 —— 点一下打 / 取消</div><div class="cyc-list">${cycPeriods
            .map(
              (p) =>
                `<button class="cyc-tick${tickSet.has(String(p.key)) ? ' ok' : ''}" type="button" data-key="${esc(
                  p.key,
                )}" title="${fmtDate(p.start)}${p.end !== p.start ? ' ~ ' + fmtDate(p.end) : ''}">${
                  p.start === p.end ? fmtShort(p.start) : `${fmtShort(p.start)}~${fmtShort(p.end)}`
                }</button>`,
            )
            .join('')}</div></div>`
        : ''
    }`;
  $('#md-done-btn').textContent = done ? '取消完成（空格）' : '标记完成（空格）';
  $('#modal-detail').classList.remove('hidden');
  $('#md-edit').onclick = () => {
    closeDetail();
    editTask(scope, t);
  };
  $('#md-delete').onclick = () => {
    closeDetail();
    delTask(scope, t);
  };
  // ⭐⭐ 0.8.14：周期任务的打卡按钮 —— **逐个绑**（本函数每次打开都把 `#md-body` 整块重写，
  //    节点都是新的 ⇒ 不会重复挂）。⛔ 别改成给 `#md-body` 挂 `addEventListener`：那是
  //    **静态节点**，每打开一次就多挂一个监听、越积越多（`onclick =` 那套只适合单个按钮）。
  $('#md-body')
    .querySelectorAll('.cyc-tick')
    .forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!assertWritable()) return;
        const key = btn.getAttribute('data-key');
        const on = !btn.classList.contains('ok');
        // 先就地切换（点哪期亮哪期），再把这一期并进本地那份 `ticks` —— 下面用它刷新
        // 顶部「打卡 x / 共 y」那一格（不重开弹窗，不刷它就会留一个旧数字）。
        btn.classList.toggle('ok', on);
        const idx = (t.ticks || []).indexOf(key);
        if (on && idx < 0) (t.ticks = t.ticks || []).push(key);
        if (!on && idx >= 0) t.ticks.splice(idx, 1);
        const cell = $('#md-prog');
        if (cell) cell.textContent = tickProgress(t, t.ticks).text;
        try {
          await tickOccurrence(sc === 'daily' ? 'daily' : 'project', t.id, key, on);
          await refreshAfterWrite(sc);
        } catch (e) {
          btn.classList.toggle('ok', !on);
          return toast(e.message, true);
        }
      });
    });
  // ⚠️⭐ 0.8.9 修订：「取消完成点击没效果」—— 这条链路原来有**两处**毛病：
  //    ① 这里写着 `if (done) { closeDetail(); return; }` —— 已完成时只关弹窗、**什么都不做**；
  //    ② `toggleTask()` 内部要先 `findTask()` 找到这条任务，而**从日历 / 看板卡片打开的详情**里
  //       它可能不在那三处缓存中 ⇒ 同样静默退出。
  //    ⇒ 现在：一律调 `toggleTask()`（它本来就是**切换**），并把**我们手上这份状态显式传下去**。
  $('#md-done-btn').onclick = async () => {
    const cur = t.status === 'done' ? 'done' : 'todo';
    closeDetail();
    await toggleTask(scope, t.id, cur);
  };
}

/**
 * 功能：关闭任务详情弹窗，并清空 `state.detail`。
 * @returns {void}
 */
export function closeDetail() {
  $('#modal-detail').classList.add('hidden');
  state.detail = null;
}
