/**
 * modules/ledger/desktop-assets-pane.js —— 生活记账借「个人资产管理」那一屏的**视图片段**（电脑版，0.8.10）
 *
 * 功能：把记账的界面挂进 `assets` 那一屏的 `#assets-body`（槽名 `assets-pane`）——
 *      骨架**由本片段自己造**（原来是 `index.html` 里那一颗空的 `<section id="ledger-view">`），
 *      屏内事件委托随骨架一起搬进来（`bindLedgerEvents()`），最后调 `mountLedger()` 取数并渲染。
 *
 * ⚠️⭐ **为什么骨架要搬进片段**：宿主页的 `<section id="ledger-view">` 这一版被删掉了
 *    （记账不再有自己的屏）。留一半在 HTML、一半在这里 ⇒ **同一批 id 出现两遍**，
 *    `document.getElementById` 只命中前一个 ⇒ 片段里那块界面**静默空白**，而且不报错。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`mountLedger()` / `bindLedgerEvents()` 都按**全局 id**
 *    找节点（`$('#ledger-view')`），所以 `ctx.container.appendChild(root)` 必须排在它们前面。
 *    反过来的表现同样是「界面空白但不报错」。
 *
 * ⚠️ 片段返回的 Node 会被 `mountModuleSlot()` 再 `appendChild()` 一次 —— 同一个节点移动位置，
 *    是无害的（它已经在正确的位置上了）。
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.8.10
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/26-个人资产管理.md、core/slots.js
 */

import { bindLedgerEvents, mountLedger } from './desktop.js';

/**
 * 记账的骨架 —— **从原 `index.html` 的 `#ledger-view` 逐字搬来**。
 *
 * 说明：⚠️ 原来那一屏里**从头到尾都是空的**（净值卡 / 分组 / 流水全由 `lgRender()` 写进
 *      `#ledger-view`），所以这里也只留一颗空的根节点。但 `id` 必须**原样保留** ——
 *      `modules/ledger/desktop.js` 的每一处都按 `$('#ledger-view')` 找它，改 id = 整屏空白且不报错。
 *      ⚠️ 类名从原来的 `view hidden` 换成 `assets-pane-body`：`view` 是「一屏」那一套
 *      （`showView()` 会来回切它的 `hidden`），而这一块现在住在别人的屏里。
 * @type {string}
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
