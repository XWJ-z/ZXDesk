/**
 * modules/bookmarks/desktop-webpass-pane.js —— 收藏夹借「网址/密码夹」那一屏的**视图片段**（电脑版，0.8.7）
 *
 * 功能：把收藏夹的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 *      骨架（计数、左侧标签栏、搜索框、列表 ＋ **右下角那颗悬浮 ＋**）**由本片段自己造**，
 *      事件委托挂在**自己造的那个根节点**上（`bindBmEvents(root)`）。
 *
 * ⚠️⭐ **为什么骨架要搬到片段里**（而不是留在 `index.html`）：宿主页的 `<section id="bookmarks-view">`
 *    这一版被删掉了（收藏夹不再有自己的屏）。留一半在 HTML、一半在这里 ⇒ **同一批 id 出现两遍**，
 *    `document.getElementById` 只命中前一个 ⇒ 片段里那块界面**静默空白**，而且不报错。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：模块的渲染函数按**全局 id** 找节点（`$('#bm-list')` 这种），
 *    所以 `ctx.container.appendChild(root)` 必须排在 `mountBookmarks()` **前面**。
 *    反过来的表现同样是「界面空白但不报错」。
 *
 * ⚠️ 片段返回的 Node 会被 `mountModuleSlot()` 再 `appendChild()` 一次 —— 同一个节点移动位置，
 *    是无害的（它已经在正确的位置上了）。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.18
 * 相关：docs/公共/开发方案/27-网址与密码合并屏.md、core/slots.js
 */

import { bindBmEvents, mountBookmarks } from './desktop.js';
import { state } from '../../desktop/state.js';

/**
 * 收藏夹的骨架（**从原 `index.html` 的 `#bookmarks-view` 逐字搬来**，只去掉了那一屏的大标题 ——
 * 屏头已经有「网址/密码夹」与药丸了）。
 * ⚠️ 搜索框仍是**静态骨架**：它一旦进重画范围，每敲一个字符都会重建 input，
 * 表现就是「只能打进去一个字」。
 * ⭐ 0.8.15：左侧那一列（`.bm-side` / `.bm-side-list`）**收敛到 `.sf-*` 一族**
 * （与随手记 `#idea-side`、密码库 `#vault-filter` 共用一份尺寸）—— 表头「标签」也搬进骨架
 * （原先由 `bmTagsHtml()` 画，现在与另两屏同构）。
 * ⚠️ 外层 `.bm-layout` 与右栏 `.bm-pane` 沿用收藏夹自己的类：方案 §5.1 的清单只点名了左栏那 6 个。
 *     右栏里的 `.bm-toolbar` / `.bm-list` 同理 —— 它们与另两屏的右栏结构不同（有搜索条、卡片列表）。
 * @type {string}
 */
const SKELETON = `
  <div class="bm-layout">
    <aside id="bm-side" class="sf-side">
      <div class="sf-head">标签</div>
      <div id="bm-tags" class="sf-list"></div>
    </aside>
    <div class="bm-pane">
      <div class="bm-toolbar">
        <div class="bm-search">
          <span class="s-ico" aria-hidden="true">🔍</span>
          <input
            role="searchbox"
            name="q"
            id="bm-q"
            type="search"
            placeholder="搜索标题 / 网址 / 标签（多个词用空格隔开，都会匹配）"
            autocomplete="off"
            data-autofill-guard
            data-lpignore="true"
            data-1p-ignore
            data-bwignore="true"
            readonly
          />
        </div>
      </div>
      <div id="bm-list" class="bm-list"></div>
    </div>
  </div>`;

/**
 * 功能：把收藏夹挂进宿主给的容器 —— 造根节点 → 进文档 → 挂一次委托 → 取数并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'webpass-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  // ⭐⭐ 0.8.18：「搜索筛选过后切换到别的界面，再切回来还是搜索筛选状态，
  //    **无法退出**」⇒ **进入这一屏 = 搜索与筛选退回默认档**。
  //    ⚠️⭐ 病根：搜索框住在**这段骨架**里（每次挂载都是全新的空框），而 `state.bmQuery` /
  //    `state.bmTagId` 是**跨挂载留着**的 ⇒ 框空着、列表却还被一个看不见的条件筛着 ——
  //    用户找不到任何东西可点来取消（只能整页重载）。
  //    ⛔ 别改成「把输入框回填成旧值」：那等于把筛选偷偷留着，与的口径正好相反。
  //    ⚠️ 只重置**检索词 ＋ 标签筛选**；⛔ 别顺手清 `state.bmItems` / `bmTags`（那是数据）。
  //    电脑端这一屏每次进入本来就会重取（`mountBookmarks()` 无「已加载」捷径），不用另外清标记。
  state.bmQuery = '';
  state.bmTagId = null;
  bindBmEvents(root);
  await mountBookmarks();
  return root;
}
