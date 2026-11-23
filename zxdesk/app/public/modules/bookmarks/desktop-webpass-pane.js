/**
 * modules/bookmarks/desktop-webpass-pane.js —— 收藏夹借「网址/密码夹」那一屏的**视图片段**
 *
 * 功能：把收藏夹的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 * 骨架（计数、左侧标签栏、搜索框、列表 ＋ **右下角那颗悬浮 ＋**）**由本片段自己造**，
 * 事件委托挂在**自己造的那个根节点**上（`bindBmEvents(root)`）。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/开发方案/27-网址与密码合并屏.md、core/slots.js
 */

import { bindBmEvents, mountBookmarks } from './desktop.js';
import { state } from '../../desktop/state.js';

/**
 * 收藏夹的骨架（**从原 `index.html` 的 `#bookmarks-view` 逐字搬来**，只去掉了那一屏的大标题 ——
 * 屏头已经有「网址/密码夹」与药丸了）。
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
  // 「搜索筛选过后切换到别的界面，再切回来还是搜索筛选状态，
  // **无法退出**」⇒ **进入这一屏 = 搜索与筛选退回默认档**。
  // 病根：搜索框住在**这段骨架**里（每次挂载都是全新的空框），而 `state.bmQuery` /
  state.bmQuery = '';
  state.bmTagId = null;
  bindBmEvents(root);
  await mountBookmarks();
  return root;
}
