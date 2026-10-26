/**
 * modules/calendar/mobile-dash-view.js —— 手机版：日历借「今天」（首页看板）的槽位（0.8.7）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `dash-view`）—— 由手机版「今天」通过
 *      `mountModuleSlot(host, 'mobile', 'calendar', 'dash-view', ctx)` 动态 import 并挂载。
 *      `render(ctx)` 只做一件事：**造一个根节点**，把日历视图挂进去，然后把它交回宿主。
 *
 * ⭐ 为什么片段要自己造根节点：与电脑端那张片段的说明**逐条同源**
 *    （`render()` 一次性返回 Node / 字符串，而日历视图需要一个稳定的根来挂事件委托与就地重画）。
 *    ⚠️ 两端各写一份这个薄壳是**刻意**的（片段文件按 `<端>-<槽名>.js` 命名，
 *    两端各自一个），但两条壳里的**逻辑一样**：造节点 → `mountCalendarView()` → 交回。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.7
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
