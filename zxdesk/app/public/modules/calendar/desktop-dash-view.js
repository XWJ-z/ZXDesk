/**
 * modules/calendar/desktop-dash-view.js —— 电脑版：日历借**首页看板**的槽位
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `dash-view`）—— 由首页看板通过
 * `mountModuleSlot(host, 'desktop', 'calendar', 'dash-view', ctx)` 动态 import 并挂载。
 * `render(ctx)` 只做一件事：**造一个根节点**，把日历视图挂进去，然后把它交回宿主。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/开发方案/26-看板日历视图.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { swapIn } from '../../core/transition.js';
import { mountCalendarView } from './desktop.js';

/**
 * 功能：造根节点 → 把日历视图挂进去 → 播一次淡入 → 交回宿主。
 *
 * @param {Object} ctx - 宿主传的上下文（`{ end, modules, uiOf, me, fresh }`）
 * @returns {HTMLElement} 挂好日历视图的根节点
 */
export function render(ctx) {
  const root = document.createElement('div');
  root.className = 'cal-dashview';
  // ⚠️ 先挂再放回：`mountCalendarView()` 内部会 `innerHTML` 重画这个节点，
  //    而此时它还没进文档 —— 对 `innerHTML` 与事件委托都没有影响（挂上之后自然生效）。
  mountCalendarView(root, ctx);
  // ⚠️ `swapIn()` 要在**挂好之后**调（见文件头）：类先挂上、节点随后进文档，
  //    动画在进文档那一刻起播 —— 与 那条无条件动画的时机一致。
  // `tier 2` —— 这是首页看板「列表 ↔ 日历」那一次**胶囊切换**（与 `views/home.js`
  //    的 `swapAnimOnce()` 同级、同一条观感），⛔ 别给成三级（那会让两个方向快慢不同）。
  swapIn(root, 2);
  return root;
}
