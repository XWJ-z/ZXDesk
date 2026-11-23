/**
 * modules/calendar/mobile-dash-view.js —— 手机版：日历借「今天」（首页看板）的槽位
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `dash-view`）—— 由手机版「今天」通过
 * `mountModuleSlot(host, 'mobile', 'calendar', 'dash-view', ctx)` 动态 import 并挂载。
 * `render(ctx)` 只做一件事：**造一个根节点**，把日历视图挂进去，然后把它交回宿主。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/开发方案/26-看板日历视图.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { mountCalendarView } from './mobile.js';

/**
 * 功能：造根节点 → 把日历视图挂进去 → 交回宿主。
 *
 * @param {Object} ctx - 宿主传的上下文（`{ end, modules, uiOf, me, fresh }`）
 * @returns {HTMLElement} 挂好日历视图的根节点
 */
export function render(ctx) {
  const root = document.createElement('div');
  root.className = 'cal-m-dashview';
  // ⚠️ 与电脑端同款：此时节点还没进文档，但 `innerHTML` 与事件委托都不受影响。
  mountCalendarView(root, ctx);
  return root;
}
