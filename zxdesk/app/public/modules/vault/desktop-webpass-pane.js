/**
 * modules/vault/desktop-webpass-pane.js —— 密码库借「网址/密码夹」那一屏的**视图片段**
 *
 * 功能：把密码库的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 * 骨架（计数 / 🔒 锁定 / 筛选条 / 正文 ＋ **右下角那颗悬浮 ＋**）**由本片段自己造**，
 * 事件委托挂在**自己造的那个根节点**上（`bindVaultEvents(root)`），
 * 两颗顶栏按钮就地绑。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/27-网址与密码合并屏.md、core/slots.js
 */

import { bindVaultEvents, lockVault, mountVault } from './desktop.js';

/**
 * 密码库的骨架（**从原 `index.html` 的 `#vault-view` 逐字搬来**，只去掉了那一屏的大标题）。
 *
 */
const SKELETON = `
  <div class="sf-layout">
    <aside id="vault-filter" class="sf-side hidden">
      <div class="sf-head">标签</div>
      <div id="vault-tags" class="sf-list"></div>
    </aside>
    <div class="sf-pane vault-pane">
      <div id="vault-bar" class="vault-toolbar hidden">
        <button
          id="vault-lock-btn"
          class="vault-hint vault-lockbtn"
          type="button"
          title="点一下立即锁定（把内存里的密钥清掉）"
        >🔓 已解锁</button>
        <div class="vault-search">
          <span class="s-ico" aria-hidden="true">🔍</span>
          <input
            role="searchbox"
            name="q"
            id="vault-q"
            class="vault-q"
            type="search"
            autocomplete="off"
            data-autofill-guard
            data-lpignore="true"
            data-1p-ignore
            data-bwignore="true"
            readonly
            placeholder="搜索标题 / 用户名 / 网址"
          />
        </div>
      </div>
      <div id="vault-body" class="vault-body"></div>
    </div>
  </div>`;

/**
 * 功能：把密码库挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托与那颗锁定键 → 取状态并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'webpass-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  // 这一颗原来是 `desktop/app.js` 的 `bindEvents()` 里绑的（那要求宿主静态 import 本模块，
  // 而本模块**必须能整目录删掉**）⇒ 随骨架一起搬进片段。⚠️ 少了它就是**点了锁定没反应**
  // （而且不报错）——`$()` 回 null ⇒ `.addEventListener` 当场 TypeError ⇒ `init()` 中止。
  const lock = root.querySelector('#vault-lock-btn');
  if (lock) lock.addEventListener('click', lockVault);
  bindVaultEvents(root);
  await mountVault();
  return root;
}
