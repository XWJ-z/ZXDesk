/**
 * modules/tasks/mobile-board.js —— 任务板（周日期条 + 当日列表，取代电脑端的甘特 + 四象限大卡）
 *
 * 功能：手机版任务板这一屏的渲染与写操作。
 *      `renderBoard()` 一次画出整屏：**顶部的【项目 ▾】下拉**（⭐ 0.5.2 起取代旧的作用域滑轨；
 *      最后一项是「＋ 新建项目…」，选中某个项目时旁边还有 ✎ 编辑 / 🗑 删除 ——
 *      「项目」屏已删，项目管理的家收进了这一屏）、周日期条、筛选条（全部 / 重要 / 紧急 / 类别 /
 *      状态），以及选中日期当天的任务列表。
 *
 * ⭐⭐ 0.8.14 修订（「移除逾期未完成这个分组，也就是不再分成逾期未完成和今天
 *      两部分显示了。因为现在有了筛选」）：原先列表分成「逾期未完成」＋「今天」两段，
 *      ⛔ 现在只剩**一段**（选中日期当天）。逾期未完成的任务**照样在列表里**（`visEnd()` 把
 *      它的可见终点顺延到今天，条目上带「逾期 N 天」药丸），要看「有哪些欠着」用筛选条的
 *      「状态 ▾」收窄即可 —— 固定分组是多余的。
 *
 * ⭐ 0.5.5两条改动：
 *    ① **最前面多一项「📊 汇总任务视图」**（值 `all`，与电脑版逐字同名）—— 这一项下列表
 *      改用 `state.all`（摊平后**每条自带它那个项目**），并且行上要显示所属项目药丸。
 *      ⚠️ 它同时是**任务板的默认**（`state.scope` 的初值就是 `'all'`，见 `mobile/state.js`）。
 *    ② **筛选条从「全部 + 四象限五格 + 含已完成」六个按钮改成三个**：全部 / 重要 / 紧急。
 *      其中重要与紧急是**两个独立开关**，同时选中 = 既重要又紧急（收窄）；
 *      「含已完成」开关删掉之后不再按完成状态过滤 —— 一条任务**完成当天照常显示**
 *      （灰色 + 「已完成」药丸），之后的日子靠 `core/task.js` 的 `visEnd()` 自然移出去。
 *      ⚠️ 这与电脑端四象限是同一口径（那边一直用 `activeOn()` 直接筛、没有开关），
 *      别再往这里加回一个「含已完成」。
 *
 * ⭐ 关键取舍：手机版任务板刻意做成「周日期条 + 当日列表」，不照搬电脑版的甘特图 + 四象限大卡 ——
 *    两端只共享 REST 契约与 `core/` 的语义，界面各写一套。
 *
 * ⭐ 0.8.7：这一屏的第一行多了**药丸** `任务 ｜ 随手记`（静态槽 `#board-tabs`），
 *    随手记（模块 `idea`）**不再有自己的屏**，界面挂进 `#board-pane`（槽名 `board-pane`）。
 *    屏**不认识任何模块的实现**：项由 `slotDefs()` 从两端接线表算出来、界面由 `mountModuleSlot()`
 *    动态 import 片段渲染。
 *    ⚠️⭐ **挂载只在 `renderBoard()` 这一个入口里做**：两处都挂 ⇒ 一次切屏挂两遍。
 *    ⚠️⚠️ 本函数从这一版起写的是 **`#board-main`**，⛔ 不再是 `#view-board` ——
 *    写它会连药丸与模块视图一起抹掉。
 *
 * ⭐ 0.5.0：本文件从 `public/mobile/views/board.js` **原样搬进任务板模块目录**。
 *    一个模块一个文件夹 —— 这一屏只服务任务板这一个模块，所以它的家是 `modules/tasks/`，
 *    不该留在跨端共用的 `views/` 里。⚠️ 只改了 import 路径与本节注释，渲染逻辑一个字没动。
 *    命名约定（一个模块不止一屏时用 `<端>-<屏名>.js`）见 `modules/tasks/README.md` 与 `07-前端`。
 *
 * ⚠️ **0.5.2 起本文件不再有拖动排序**（`bindProjectDrag()` / `saveOrder()` / `moveProjectTo()` 已删）：
 *    那套长按拖动手势住在被删掉的「项目」卡片屏上，项目排序在手机端随之没有落点
 *    （与电脑版同一条路：顺序仍在库里，只是没有拖动界面）。别按老样子加回来。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.51
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
 * ⚠️⭐ 0.8.15：从前那两个模块级的 `painting` / `again`（**合并式防重入**）**已收进
 * `core/slots.js`** —— 加了「旧层要留一会儿」之后，并发挂载的后果比从前更重（会留下两层旧节点），
 * 防重入必须与「保留旧层」住同一个文件。⛔ 别在这里再加回来。
 * ⚠️ 那两段注释里从前写着「`mountModuleSlot()` 先同步清空容器」—— 那句**0.8.9 起就过时了**
 * （现在是「先 `import`、再清空、再 `render`」，见 `core/slots.js` 的 `mountPlain()`）。
 * 那两段已随本次重构整段删除，这里留一句是防它被从 git 历史里抄回来。
 */

/** 药丸的点击委托**只挂一次**（`#board-tabs` 是静态节点，重挂会叠加） */
let pillBound = false;

/**
 * 功能：算一遍药丸里**模块贡献的那几项** —— 「清单 ∩ 本端接线表 ∩ 该模块没被关掉」，顺序跟清单走。
 *
 * 说明：⭐ 复用的是现成的 `slotDefs()`（判据只有一处）—— 它已经把三件事一次做完了：
 *      **清单 ∩ 接线表**、**该模块没被本账号关掉**（`hide_idea`）、**顺序 / 名字 / 图标**。
 *      ⚠️ 这一份为空（随手记被删掉 / 被关掉）⇒ 药丸只剩「任务」⇒ **整条不画**（见 `pillHtml`）。
 * @returns {Array.<Object>} `moduleItems()` 条目（带 `slots` / `title` / `svg` / `on`）
 */
function paneItems() {
  return slotDefs(state.modules, uiOf, state.me || {}).filter((it) => it.slots.includes(BOARD_SLOT));
}

/**
 * 功能：**屏内退一层**（系统返回键落到这一屏时宿主来问一句）—— 停在随手记那格就退回「任务」。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 *      从前任务板的药丸**不参与返回** ⇒ 人在「随手记」按返回会直接跳回上一级屏（今天），
 *      那个子屏整块丢掉。现在先退回「任务」那一格（同一屏内），再按才往上走。
 *      退的具体动作**复用 `pick('')`**（与用户亲手点「任务」那颗药丸同一条路）——
 *      ⛔ 别另写一份「清 state + 重画」，那样两条路的收尾迟早会不一样。
 * @returns {boolean} 真 = 退了一层；假 = 已经在「任务」这一格
 */
function boardBack() {
  if (!state.boardTab) return false;
  pick('');
  return true;
}

/**
 * 功能：画药丸 —— 第一项恒为**任务板自己**（`data-board-view=""`，也就是 `state.boardTab` 的空串），
 *      后面依次是各模块借这一屏贡献的视图（手机端画**线性图标**，用接线表里的 `svg`）。
 * @param {Array.<Object>} items - `paneItems()` 的产物
 * @param {string} on - 当前选中的那一块（空串 = 任务板自己 / 否则是模块名）
 * @returns {string} 药丸的 HTML（**没有模块贡献视图时返回空串 —— 整条不画**）
 */
function pillHtml(items, on) {
  // ⚠️ 只有一项时整条不画：只有一种视图时，一条切换控件是纯噪音（与 `webpass` 同一条口径）。
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
  // ⭐ 0.8.15：走 **交叉淡入** —— 旧的那一块（`#board-main`）一直留到新的
  //    那一块（`#board-pane`）挂好，两层同格重叠再一起淡出 / 淡入。
  //    ⛔ 不再「当场把旧视图 `hidden`」：那正是白窗的根源。
  const done = renderBoard({ fade: true });
  // ⚠️ 宿主的 `updateChrome()` 只在**切标签**时跑，而这一次是同一屏内换的骨头
  //    ⇒ 顶栏副标题会停在「作用域 · 日期」那套旧文案上（两处说的不是一件事）。
  //    走 `mobile/ui.js` 注进来的那个重画器（与 `setNotifier` 同一套路，模块⛔ 不许 import 宿主）。
  paintChrome();
  if (!name || !done) return;
  // ⭐ 0.8.7：并屏的唯一代价是「入口深了一步」，补偿就是这一下 ——
  //    切过来之后把光标放进这一块**第一个输入框**，用户接着就能打字。
  //    ⚠️⭐ 必须等 `renderBoard()` 返回的**那一批挂载全跑完**再放 —— 等早了会放在一个
  //    马上被换掉的节点上，焦点当场丢（真浏览器探针抓到的就是这个）。
  //    ⚠️ 只挂在 `pick()`（**用户亲手切**那一下）里 —— ⛔ 别放进 `draw()`：那会在每次重画 /
  //    切回任务板时都抢一次焦点（手机上还会平白弹出软键盘）。
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
 *      ⚠️ 合并式防重入**已收进 `core/slots.js`**（见文件头上那条说明）。
 * @returns {Promise.<void>}
 */
function paint(enter) {
  const pane = $('#board-pane');
  const name = state.boardTab;
  if (!pane || !name) return Promise.resolve();
  return mountModuleSlot(pane, 'mobile', name, BOARD_SLOT, {
    // ⚠️⭐ `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    //    `render(ctx)`（它自己的第一个参数不会进 ctx）。而视图片段要「先把根节点插进文档、
    //    再调模块的渲染函数」（那些函数按**全局 id** 找节点）⇒ 漏了这一项，片段一进门
    //    就 TypeError，槽里只画一句「界面加载失败」。
    container: pane,
    end: 'mobile',
    modules: state.modules,
    uiOf,
    me: state.me,
    // ⭐ 0.8.15：**opt-in** 的交叉淡入 —— ⛔ 不传时 `mountModuleSlot()` 与今天逐字相同
    crossFade: true,
    // ⭐ 0.8.17：**进屏那一趟**（宿主切到这一屏那一下）不播槽内淡入 —— 整屏那一条已经在
    //    给这一屏淡入了，槽里再淡一次 = 「同一块内容连淡两次」（「模块与模块之间
    //    切换多次闪现」）。⚠️ 屏内点药丸那一趟（`pick()`）不传 ⇒ 交叉淡入照旧。
    enterFade: enter !== true,
  });
}

// ---------- 渲染：任务板（周日期条 + 当日列表，取代电脑端的甘特 + 四象限大卡） ----------
/**
 * 功能：渲染手机版任务板整屏 —— 顶部【项目 ▾】下拉、周日期条、四象限筛选条，以及逾期段与当日任务列表。
 *      选中日期缺省为今天，周起点缺省为今天所在周的周一；当日列表按象限权重从高到低、同权重按截止日升序排。
 *
 * 说明：⭐ 0.5.2 顶部从「日常任务 + 各项目」的横向滑轨改成了**下拉**（
 *      「上面的滑动选择项目改为下拉选择」）—— 项目一多滑轨要横向滑半天，下拉一步到位；
 *      与电脑版 `#bd-scope` 同一套形态（日常任务 + 各项目 + 「＋ 新建项目…」）。
 *      ⚠️ 换作用域**只改 `state.scope` 并重画，不动所选日期 / 周**：用户可能特意翻到了某一天，
 *      换个项目不该把他拽回今天（与旧滑轨的 `scope` 动作同一口径）。
 *      ⚠️ 选中某个项目时旁边多出 ✎ 编辑 / 🗑 删除（项目屏删了，项目管理的家在这里）；
 *      「＋ 新建项目…」是 `__new__` 那一项，由 `app.js` 的 change 分支弹表单并把下拉拨回来
 *      （与电脑版逐字同一条规矩：它不是作用域，不能让下拉停在它上面）。
 *
 * @returns {void}
 */
export function renderBoard(opts) {
  const fade = !!(opts && opts.fade);
  // ⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】」）：把「屏内退一层」
  //    登记给宿主（`mobile/ui.js` 的 `setBackHandler`）——
  //    任务板停在「随手记」那一格时，系统返回**先回「任务」**，再按才往上走一层。
  //    ⚠️ 登记是幂等的（同一屏重复登记只覆盖同一个键），所以放在这个唯一的渲染入口里最省心。
  setBackHandler('board', boardBack);
  // ⭐ 0.8.7：这一屏的第一行多了一块**药丸槽**（`任务 ｜ 随手记`），
  //    随手记的界面挂进 `#board-pane`（由 `mountModuleSlot()` 动态 import 片段）。
  const tabs = $('#board-tabs');
  const main = $('#board-main');
  const pane = $('#board-pane');
  if (!tabs || !main || !pane) return;
  const mods = paneItems();
  // ⚠️ 当前选的那一块不在清单里了（模块被关掉 / 被整目录删掉）⇒ 回落到任务板自己
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
    // ⭐ 0.8.15：**交叉淡入**那一趟 —— 两层都要在场上（新层先摆好、
    //    旧层继续显示；挂载期间屏幕上一直是旧内容）。
    //    ⛔ 这里**不许**把旧的那一层 `hidden`（那就是白窗的根源）。
    main.classList.remove('hidden');
    pane.classList.remove('hidden');
    // ⚠️⭐ 0.8.15 第八轮（电脑端同款）：**要进场的那一层先按住**（`opacity` 不是 `hidden`，布局要留着）。
    //    下面 `paint()` 是异步挂载 ⇒ 不按住就是「两层叠着看」。放开与淡入由 `crossFade()` 做。
    (onTask ? main : pane).style.opacity = '0';
  } else {
    main.classList.toggle('hidden', !onTask);
    pane.classList.toggle('hidden', onTask);
  }
  if (!onTask) {
    // ⚠️⭐ 挂载**只在这一个入口里**做（见文件头）：改造前「取数 / 重画」是两处分工，
    //    两处都变成「挂载整个视图」就会一次切屏挂两遍（容器里两个根节点，列表行数翻倍）。
    //    ⚠️ 返回这一批挂载的 promise（含并发时自己补的那趟）—— `pick()` 要等它画完再放光标。
    // ⭐ 0.8.17：**只有用户亲手点药丸那一趟**（`fade === true`）才播槽内的交叉淡入。
    //    其余几趟（进屏 / 偏好变化后的重挂）都传 `enter = true` ⇒ 槽内不做过渡 ——
    //    进屏那一下整屏 `.view` 已经在淡入了，槽里再淡一次 =「同一块内容连淡两次」。
    const done = paint(!fade);
    if (!fade) return done.catch((e) => toast(e.message, true));
    // ⭐ 挂完（新内容已就绪）⇒ 两层一起交叉淡入（`cleanup: 'hide'` —— 静态节点，⛔ 不能删）
    // ⭐ 0.8.51：`tier 2` —— 屏头药丸「任务 ↔ 随手记」＝**二级**。
    return done
      .then(() => crossFade([main], pane, { cleanup: 'hide', tier: 2 }))
      .catch((e) => {
        // ⚠️ 挂载失败 ⇒ 必须**松开**刚按住的新层，否则它永远停在 `opacity: 0`（界面整块不见、且不报错）
        pane.style.opacity = '';
        toast(e.message, true);
      });
  }
  const today = todayStr();
  const sel = state.selDate || today;
  const start = state.weekStart || mondayOf(today);
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(start, i));

  // ⭐ 0.5.2：顶部的【项目 ▾】（取代旧的作用域滑轨）。⚠️ 选项顺序与电脑版 `renderScopeSelect()` 一致：
  //    汇总任务视图在最前，其次日常任务，项目名按**显示宽度**截到 12 格（同一把尺子 `clipWidth`）。
  //    ⭐ 0.5.5：最前面补上「📊 汇总任务视图」（值 `all`）—— 与电脑版逐字同名同项。
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

  // ⭐ 0.5.5：**列表的唯一数据源** —— 统一包成 `{t, scope, name, icon, color}`：
  //    · 汇总视图（`all`）直接用 `state.all`（`rebuildFlat()` 摊平的结果，**每条自带它那个项目**）；
  //    · 其余作用域把 `tasksOf()` 包上当前作用域的展示信息。
  //    ⚠️ 包成一种形状之后，下面所有筛选 / 排序 / 画行都只认它 —— 否则「汇总里点勾选勾到了别的项目」
  //    这类错误会散落在每一个用到作用域的地方（`rowHtml()` 把 `w.scope` 写进 `data-scope`，
  //    勾选 / 详情 / 删除都从那儿读回来）。
  const items = isAll
    ? state.all
    : tasksOf(state.scope).map((t) => ({
        t,
        scope: state.scope,
        name: meta.name,
        icon: meta.icon,
        color: meta.color,
      }));

  // ⭐⭐ 0.8.14：「日期下去掉紫色小点」—— 每格下面那排 `.ddots` 整个撤掉
  //    （连同算条数那一步：它只为那几个点而存在，留着就是一段永远不出现在屏幕上的计算）。
  //    ⚠️ 顶部现在只留「周几 + 日号」两行，格子高度随之收一半（见 `app.css` 的 `.day`）。
  const days = dates
    .map((d) => {
      return `<button class="day${d === today ? ' today' : ''}${d === sel ? ' on' : ''}${
        isWeekend(d) ? ' wend' : ''
      }" type="button" data-act="day" data-date="${d}">
      <div class="dw">${weekName(d).slice(1)}</div><div class="dn">${Number(d.slice(8))}</div></button>`;
    })
    .join('');

  // ⭐ 0.5.5 筛选条：「全部 + 四象限五格 + 含已完成」六个按钮全删，
  //    改成**三个** —— 全部 / 重要 / 紧急。
  //    · `全部` = 两个开关都清掉，**两个都没开时它自己亮着**；
  //    · `重要` / `紧急` 各自独立开关，**两个都开 = 既重要又紧急**（收窄，见下面那段筛选）。
  //    配色沿用四象限的语义色：重要取红（Q1/Q2 那一侧）、紧急取琥珀（Q1/Q3 那一侧）。
  // ⭐⭐ 0.8.14 修订：「手机端任务可以按任务类别、状态 下拉列表选择筛选，
  //    顺序为 全部、重要、紧急、类别、状态」—— 后两个是**原生 `<select>`**（空串 = 不筛），
  //    走宿主的 `change` 委托（`mobile/app.js` 里 `#app` 那处），⛔ 不走 click 动作表。
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
   * ⭐ 0.5.5：「含已完成」开关删掉之后，这里**不再按完成状态过滤** —— 一条任务完成当天仍在
   * `visEnd()` 的区间里，于是照常出现在列表上（灰色 + 「已完成」药丸），之后的日子它自然移出去。
   * 这与电脑端四象限是同一口径（那边一直用 `activeOn()` 直接筛，没有开关）。
   */
  // ⚠️ 0.8.14：`activeOn` 多带一个 `today`（漏传不报错，只是「逾期顺延」在这条日期条上静默失效）。
  //    ⭐ 周期任务按期可见（`activeOn` 内含），所以这里同样不必特殊处理。
  let list = items.filter((w) => activeOn(w.t, sel, today));
  // ⭐ 两个开关**各自独立**，同时开 = 既重要又紧急（标准筛选条的收窄行为选的口径）
  if (state.impOn) list = list.filter((w) => Number(w.t.important));
  if (state.urgOn) list = list.filter((w) => Number(w.t.urgent));
  // ⭐ 0.8.14 修订：类别（任务类型）与状态两个下拉 —— 老数据没有 `task_kind` ⇒ 当「普通」
  if (state.kindFilter) list = list.filter((w) => (w.t.task_kind || 'plain') === state.kindFilter);
  if (state.statusFilter) list = list.filter((w) => (w.t.status || 'todo') === state.statusFilter);
  // ⭐ 0.8.14（方案 §1.1⑧）：**窗口任务排最前**（优先级最高），其余照旧按象限权重、再按截止日。
  const winFirst = (t) => (t.task_kind === 'window' ? 0 : 1);
  list.sort((a, b) => winFirst(a.t) - winFirst(b.t) || quadRank(b.t) - quadRank(a.t) || byDueAsc(a.t, b.t));

  // ⚠️ 汇总视图里每一行都要看得出**属于哪个项目**（`hideScope: false`）；其余作用域不必重复当前项目名
  // ⚠️ `date` 必须传下去：周期任务那一行要按**选中日**算「这一期是哪一期」（见 `ui.js` 的 `rowHtml`）。
  const rowOpts = { hideScope: !isAll, date: sel };

  // ⭐⭐ 0.8.14 修订：只剩**一段**（选中日期当天）—— 原先那个「逾期未完成」段按的话撤掉
  //    （见文件头说明）。逾期未完成的任务靠 `visEnd()` 顺延到今天，照样在这一段里、带「逾期 N 天」。
  const body = `<div class="sec">${secHead(fmtLong(sel) + ' ' + weekName(sel), meta.color, list.length + ' 项')}${
    list.length
      ? `<div class="list">${list.map((w) => rowHtml(w, rowOpts)).join('')}</div>`
      : emptyHtml('🗓', '这一天没有任务', '换个日期，或点右下角 ＋ 新建')
  }</div>`;

  // ⭐⭐ 0.8.14：**固定头 + 内部滚动区**两段式 ——
  //    项目下拉 / 周条 / 日期条 / 筛选条写进 `.board-head`（`flex:none`，不随滑动移动），
  //    逾期段与当日列表写进 `.board-scroll`（**唯一**滚动的那一块）。
  //    ⚠️⭐ 底部大留白靠 `.board-scroll` 自己的 `padding-bottom`（见 `app.css` 那一段）——
  //    外层 `#view-board` 已改成 `overflow:hidden`，`.view` 那条 padding 在本屏**等于没效果**。
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
  // ⭐ 0.8.15：反向（随手记 → 任务板）—— `#board-main` 的内容是**同步**画好的、
  //    立刻就有 ⇒ 同样不藏旧的那一层，直接两层一起交叉淡入。
  // ⭐ 0.8.51：`tier 2` —— 同上（反向那一趟）。
  if (fade) crossFade([pane], main, { cleanup: 'hide', tier: 2 });
}

