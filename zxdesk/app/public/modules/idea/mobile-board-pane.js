/**
 * modules/idea/mobile-board-pane.js —— 随手记借**任务板那一屏**的视图片段（手机版，0.8.7）
 *
 * 功能：把随手记的界面挂进任务板那一屏的 `#board-pane`（槽名 `board-pane`）——
 *      骨架（检索框 + 圆形 ＋ 新建键 + `#idea-body`）**由本片段自己造**，
 *      屏内动作（`idea-*`）与检索框的输入监听**也一并搬进来**，全挂在自己造的那个根节点上。
 *
 * ⚠️⭐ **为什么这些要整体搬进来**：宿主（`mobile/app.js`）的 `ACTIONS` 表与 `#app` 上的
 *    输入委托都是**静态 import** 驱动的 —— 留着它们就等于「删掉本目录 ⇒ 宿主页起不来」，
 *    与方案 §六 的删目录退化口径冲突。⛔ 搬完**必须把宿主里那些键 / 那处监听删干净**：
 *    宿主是全局委托，两边都处理就是同一个动作**触发两次**。
 *
 * ⚠️⭐ **弹层（`#sheet`）上的那批动作不在这里挂**（0.8.9报「记下来没反应」）：
 *    `#sheet` 与 `#app` 是**兄弟节点**，它浮在所有屏之上，本片段只在「用户进过这一屏」时才加载 ——
 *    把弹层委托挂在这里，从首页那颗 ＋ 直接开弹层时**根本没人挂过**。
 *    ⇒ 挪到 `modules/idea/mobile.js` 的 `ensureSheetBound()`（由 `ideaNew()` 等入口保证调用）。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`renderIdea()` 按全局 id 找 `#idea-body`，
 *    所以 `ctx.container.appendChild(root)` 要排在 `openIdea()` 前面。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.1
 * 相关：docs/公共/开发方案/28-任务与随手记合并屏.md、docs/公共/架构文档/19-灵感库.md、core/slots.js
 */

import { ideaDispatch, loadIdeas, openIdea } from './mobile.js';
import { state } from '../../mobile/state.js';
import { toast } from '../../mobile/ui.js';

/**
 * 随手记的骨架（**从原 `mobile/index.html` 的 `#view-idea` 逐字搬来**，一个字符都没改）。
 *
 * 说明：⚠️ 检索框是**静态骨架**（它是个「边打边筛」的框，进重画范围就会每敲一个字重建 input、
 *      焦点当场丢失）；`#idea-body` 是 `renderIdea()` 每次重画的**固定段**（三档胶囊 + 标签下拉），
 *      `#idea-scroll` 是**滚动段**（列表）—— 两段式见。
 *      ⭐ 0.8.15：顶部再加**第二行** `.idea-tagbar`（「＋ 新标签」/「⚙ 管理」两颗 chip）
 *      —— 它也是静态固定段；两个 `data-act` 键登记在 `modules/idea/mobile.js` 的 `IDEA_ACTS`。
 *      ⭐⭐ 0.8.17（「【新建标签】并入【管理】的弹窗底部，不再独立」）：
 *      「＋ 新标签」那颗撤了，只剩「⚙ 管理」—— 建标签的输入行搬进「管理标签」弹层的底部。
 * @type {string}
 */
const SKELETON = `
  <div class="bm-head">
 <!-- 0.8.15 真机修订四（「搜索框放到管理旁边，也就是新标签、管理、搜索三个一排，
         高度和样式统一」）：这两颗 chip 从**独立第二行**挪进搜索框那一行
         （顺序 = 新标签 / 管理 / 搜索）。空态时只藏这两颗、搜索框留着（判据在 mobile.js）。
         ⛔ 本条注释里不许出现反引号（骨架是模板串，一个反引号就会提前闭合它）。 -->
    <div class="idea-tagbtns" id="idea-tagbtns">
 <!-- ⭐⭐ 0.8.18 任务七：「这五个（两排）……自身的高度，应该与网址
           收藏夹一致」—— 这一颗原先写的是 chip（基类 38px，靠 .idea-pane .bm-head .chip
           那条就近覆盖去压），而收藏夹那颗是 chip sm（32px）。
           改用**同一份** .chip.sm（32px / padding 0 12px / 12.5px）：两屏从此同一个组件，
           ⛔ 不再靠两条互相覆盖的规则去凑同一个数。
           ⛔⛔ 本条注释里一个反引号都不许有：整个骨架是模板串，一个反引号就会提前闭合它。 -->
      <button class="chip sm" type="button" data-act="idea-tag-manage">⚙ 管理</button>
    </div>
    <div class="m-search">
      <span class="m-search-ico" aria-hidden="true">🔍</span>
      <input
        role="searchbox"
        name="q"
        id="idea-q"
        type="search"
        placeholder="搜正文或标签…"
        autocomplete="off"
        data-autofill-guard
        data-lpignore="true"
        data-1p-ignore
        data-bwignore="true"
        readonly
        autocapitalize="off"
      />
    </div>
 <!-- ⭐ 0.8.15：这一行原来有一颗**圆形 ＋**（写着「记一条」）。
         ⛔⛔ 它**已撤**（同日真机修订二）：它住在片段里，而片段根会播 dash-swap-in ——
         **带 transform 的祖先会抢走绝对定位元素的包含块** ⇒ 那颗 ＋ 的定位基准在
         「手机外壳」与「片段根」之间换来换去，切过来时**往右闪跳一下**（实测 x 从 817 → 833，
         差的 16px 正是 .view 的横向内边距）。
         ⇒ 随手记那一档现在用**全局那颗 ＋**（mobile/index.html 的 #fab，它在 main 之外、
         从不播动画），语义按档位换（见 mobile/app.js 里那颗按钮的 click 分支）。
         ⛔ 别把它加回来 —— 加回来那条闪跳就跟着回来（动效类名与几何都对，只有真机看得见）。
         ⛔⛔ 本条注释里一个反引号都不许有：整个骨架是模板串，注释里一个反引号就会提前闭合它。 -->
  </div>
  <div id="idea-body"><!-- JS 渲染三档胶囊与标签下拉（固定段） --></div>
  <div class="idea-scroll" id="idea-scroll"><!-- JS 渲染列表（**唯一**滚动区） --></div>`;

/**
 * 随手记的动作表**不在这里** —— 它是 `modules/idea/mobile.js` 里的 `IDEA_ACTS`（唯一一份）。
 *
 * ⚠️⭐ 0.8.9 修订：「点击加号创建随手记，保存不了，点击记下来无反应」。
 *    原来这张表与「弹层那一处委托」都住在本文件里，靠本片段的 `render()` 去挂 ——
 *    而本片段**只在「用户进过任务与随手记那一屏」时才加载**。从首页那颗 ＋ 直接开弹层时，
 *    弹层上的委托压根没人挂过 ⇒「记下来」点了毫无反应、也不报错。
 *    ⇒ 表与分发搬回模块自己的文件；本片段只把**屏内**那处委托挂到自己的根节点上。
 */

/**
 * 功能：把随手记挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托与监听 → 取数并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'idea-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);

  // ⭐⭐ 0.8.18：「搜索筛选过后切换到别的界面，再切回来还是搜索筛选状态，
  //    **无法退出**」⇒ **进入这一屏 = 搜索与筛选退回默认档**（与收藏夹同一条口径，
  //    详细病根见 `bookmarks/mobile-webpass-pane.js` 里那段：骨架每次都是新的空框，
  //    而 `state.ideaQ` / `state.ideaTag` 跨挂载留着 ⇒ 框空着、列表还被看不见的条件筛着）。
  //    ⚠️ 恢复默认档**必须在这里**：`openIdea()` 里那条「`ideaLoaded` 就只重画」的捷径会拿
  //    **上一次筛过的**结果重画 ⇒ 所以一并把那个标记清掉，让它重新取数。
  //    ⛔ 只重置检索词与标签筛选；`state.ideaView`（三档）与 `state.ideaSort`（排序）不动 ——
  //    那两件在下拉里**看得见**（会被 `renderIdea()` 回填成选中项），不属于「看不见的筛选」。
  state.ideaQ = '';
  state.ideaTag = '';
  state.ideaLoaded = false;

  /** 功能：一条 `[data-act]` 走动作表（唯一那份在 `modules/idea/mobile.js`）。 @param {Event} e - 事件 @returns {void} */
  const dispatch = (e) => ideaDispatch(e);
  // 屏内动作：**一次委托**（列表每次重画，逐个绑必漏）
  root.addEventListener('click', dispatch);

  // 检索框：debounce 250ms（输入中文时每个拼音字母都会触发 input，不防抖就是一串请求）
  // ⚠️ 原来它挂在宿主 `#app` 的**全局委托**上，随骨架一起搬到这里 —— 宿主那处必须删掉。
  let timer = null;
  root.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'idea-q') return;
    state.ideaQ = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => {
      loadIdeas().catch((err) => toast(err.message, true));
    }, 250);
  });
  // ⭐ 0.8.9 修订：「手机端为下拉选项」—— 标签筛选从胶囊改成 `<select>`。
  //    ⚠️⭐ 它**不能**走下面那张 `data-act` 动作表：那张表是接**点击**的，而 `<select>` 只有 change
  //    ⇒ 漏了这一处就是「选了下拉没反应、而且不报错」。
  root.addEventListener('change', (e) => {
    if (!e.target) return;
    // ⭐ 0.8.14：下拉有两个 —— 标签筛选（0.8.9）与**排序**（0.8.14 新增），
    //    两个都是 `<select>` ⇒ 都只能走 `change`，漏一个就是「选了没反应、而且不报错」。
    // ⭐⭐ 0.8.14 第五轮：「三档」也变成一枚下拉（`#idea-view`，字段叫**状态**）⇒ 与另外两枚一样，
    //    只有 `change`，⛔ 不走 `data-act`（那张表接的是点击）。
    if (e.target.id === 'idea-view') state.ideaView = String(e.target.value || 'inbox');
    else if (e.target.id === 'idea-tag-sel') state.ideaTag = String(e.target.value || '');
    // ⚠️⭐ 0.8.14 第二轮：这里**不能**把空值兜成 `'time'` —— 下拉里第一项「排序」的 `value` 就是空串，
    //    兜成 `'time'` 会让「选了『排序』」当场跳成「时间 ↓」（下拉显示的值与刚选的不是一回事）。
    //    空值一路留着，取数时再由 `loadIdeas()` 兜成默认档。
    else if (e.target.id === 'idea-sort') state.ideaSort = String(e.target.value || '');
    else return;
    loadIdeas().catch((err) => toast(err.message, true));
  });

  await openIdea();
  return root;
}
