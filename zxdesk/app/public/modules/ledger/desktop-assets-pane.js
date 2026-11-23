/**
 * modules/ledger/desktop-assets-pane.js —— 生活记账借「个人资产管理」那一屏的**视图片段**
 *
 * 功能：把记账的界面挂进 `assets` 那一屏的 `#assets-body`（槽名 `assets-pane`）——
 * 骨架**由本片段自己造**（原来是 `index.html` 里那一颗空的 `<section id="ledger-view">`），
 * 屏内事件委托随骨架一起搬进来（`bindLedgerEvents()`），最后调 `mountLedger()` 取数并渲染。
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.9.7
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/26-个人资产管理.md、core/slots.js
 */

import { bindLedgerEvents, mountLedger } from './desktop.js';

/**
 * 记账的骨架 —— **从原 `index.html` 的 `#ledger-view` 逐字搬来**。
 *
 */
const SKELETON = '<div id="ledger-view" class="assets-pane-body"></div>';

/**
 * 功能：把记账挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托 → 取数并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'assets-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  bindLedgerEvents();
  await mountLedger();
  return root;
}
