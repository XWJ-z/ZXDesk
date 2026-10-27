/**
 * modules/idea/desktop-board-pane.js —— 随手记借**任务板那一屏**的视图片段（电脑版，0.8.7）
 *
 * 功能：把随手记的界面挂进任务板那一屏的 `#board-pane`（槽名 `board-pane`）——
 *      骨架（检索框 + 圆形 ＋ 新建键 + `#idea-body`）**本片段自己造**，
 *      三处事件绑定（检索框 debounce、那颗静态按钮、`#idea-body` 上的列表委托）也一并搬进来，
 *      全挂在自己造的那个根节点上（`bindIdeaEvents(root)`）。
 *
 * ⚠️⭐ **为什么这些要整体搬进来**：宿主（`desktop/app.js`）对随手记是**静态 import** 的
 *    （它在 `bindEvents()` 里调 `bindIdeaEvents()`）—— 留着它就等于「删掉本目录 ⇒ 宿主页起不来」，
 *    与方案 §六 的删目录退化口径直接冲突。⛔ 搬完**必须把宿主里那处调用删干净**。
 *
 * ⚠️⭐ **它为什么不是"一屏"而是一个片段**：要的是「把项目任务和随手记合并为
 *    【任务与随手记】」—— 两个模块**保持独立**（铁律 11），只是**视图上并成一块**。
 *    屏长在任务板身上（它就是主界面本身，见方案 §三），随手记只"借"这一屏的一个槽。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`modules/idea/desktop.js` 的渲染函数按**全局 id** 找
 *    `#idea-body`（`$('#idea-body')`），所以 `ctx.container.appendChild(root)` 要排在
 *    `mountIdea()` 前面。反过来的表现是「界面空白但不报错」。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.1
 * 相关：docs/公共/开发方案/28-任务与随手记合并屏.md、docs/公共/架构文档/19-灵感库.md、core/slots.js
 */

import { bindIdeaEvents, mountIdea } from './desktop.js';
import { state } from '../../desktop/state.js';

/**
 * 随手记的骨架（**从原 `index.html` 的 `#idea-view` 逐字搬来**，一个字符都没改）——
 * 屏头那颗大标题**留着**：切到这一块时任务板自己的屏头整块不画了，这一行就是唯一的标题。
 *
 * 说明：⚠️ 检索框是**静态骨架**（它是个「边打边筛」的框，进重画范围就会每敲一个字重建 input、
 *      焦点当场丢失）；`#idea-body`（三档胶囊，**固定段**）＋ 左侧标签栏 `#idea-tags` 才是
 *      `renderIdeas()` 每次重画的那两块；⭐⭐ 0.8.14：**列表单独一块**
 *      （`#idea-scroll`，这一块才是**唯一**滚动区）—— 「除了卡片列表，
 *      其余全部固定」。 ⭐ 0.8.9：「随手记的标签筛选做成
 *      和网址收藏夹一样的**左右结构**」（左栏与收藏夹的分类栏共用 `.sf-*` 那一份尺寸）。
 *      ⚠️ 整套**防自动填充标记**（中性 `name` + 三家密码管理器的 ignore 标记 + 初始 `readonly`）
 *      一个都不能少 —— 少了 Edge 会把它当密码框、在上面弹「保存的密码」浮层（0.7.6 的老坑）。
 * @type {string}
 */
const SKELETON = `
  <div class="home-head">
    <div class="home-title">
      <span class="home-logo">💡</span>
      <h2>随手记</h2>
    </div>
 <!-- ⛔ 0.8.16 真机（「那颗悬浮 ＋ **应该是固定的**，现在任务切随手记会随着界面
         消失再出现，反过来不会」）：那颗 ＋ **已搬走**（原来就写在这个位置）。
         病根：本片段每挂一次都是**新节点**（交叉淡入要的正是这个）⇒ 旧节点跟着旧根淡出、
         新节点再淡入 = 视觉上「消失 → 出现」；任务那颗不闪，正因为它住 .board-actions（静态）。
         ⇒ 它现在住在 index.html 的**静态层**（#board-view 里、.board-stage 外），
         由 renderBoard() 按档位判显隐、由 modules/idea/desktop.js **认领**（绑事件）。
         ⛔ 别把它加回来 —— 加回来那段「消失再出现」就跟着回来。 -->
  </div>
  <div class="sf-layout">
    <aside id="idea-side" class="sf-side hidden">
      <div class="sf-head">标签</div>
      <div id="idea-tags" class="sf-list"></div>
    </aside>
    <div class="sf-pane">
 <!-- ⭐⭐ 0.8.14 修订（「这些显示在一排」）：三档胶囊（#idea-body，
           每次重画）与搜索 🔍（静态骨架）**包进同一行**。
           ⚠️ 搜索框**必须**留在静态骨架里 —— 它进重画范围就会每敲一个字重建 input、焦点当场丢。 -->
      <div class="idea-topbar">
        <div id="idea-body"><!-- JS 渲染三档胶囊 + 筛选（固定段） --></div>
        <div class="idea-search">
          <button id="idea-q-btn" class="icon-btn" type="button" title="搜索" aria-label="搜索">🔍</button>
          <input
            id="idea-q"
            class="hidden"
            name="q"
            type="search"
            placeholder="搜正文或标签…"
            autocomplete="off"
            data-autofill-guard
            data-lpignore="true"
            data-1p-ignore
            data-bwignore="true"
            readonly
          />
        </div>
      </div>
      <div class="idea-scroll" id="idea-scroll"><!-- JS 渲染列表（**唯一**滚动区） --></div>
    </div>
  </div>`;

/**
 * 功能：把随手记挂进宿主给的容器 —— 造根节点 → 进文档 → 挂三处事件 → 取数并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'idea-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  // ⭐⭐ 0.8.18：「搜索筛选过后切换到别的界面，再切回来还是搜索筛选状态，
  //    **无法退出**」⇒ **进入这一屏 = 搜索与筛选退回默认档**（与收藏夹同一条口径）。
  //    ⚠️⭐ 电脑端这一屏尤其糟：那颗检索框平时是**收起的**（点 🔍 才展开，见 `bindIdeaEvents()`）
  //    ⇒ 挂着词回来时屏幕上一个能看的东西都没有，用户根本不知道列表为什么少了几条。
  //    ⛔ 只重置检索词与标签筛选；三档（`ideaView`）与排序（`ideaSort`）不动 ——
  //    那两件在胶囊 / 下拉里看得见、会被回填成选中项，不属于「看不见的筛选」。
  //    ⚠️ 电脑端每次进入本来就会重取（`mountIdea()` 无「已加载」捷径），不用另外清标记。
  state.ideaQ = '';
  state.ideaTag = '';
  // ⚠️ 屏内那一批动作只在**自己的根节点**上委托一次就够 ——
  //    弹窗（`#modal-body`）是宿主里常驻的**另一棵子树**，本模块的弹窗按钮走
  //    `#modal-save` 的 `onclick`（每次开窗时自己赋一次），所以这边没有第二处要挂。
  bindIdeaEvents(root);
  await mountIdea();
  return root;
}
