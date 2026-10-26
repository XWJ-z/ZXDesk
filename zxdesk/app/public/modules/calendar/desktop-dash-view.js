/**
 * modules/calendar/desktop-dash-view.js —— 电脑版：日历借**首页看板**的槽位（0.8.7）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `dash-view`）—— 由首页看板通过
 *      `mountModuleSlot(host, 'desktop', 'calendar', 'dash-view', ctx)` 动态 import 并挂载。
 *      `render(ctx)` 只做一件事：**造一个根节点**，把日历视图挂进去，然后把它交回宿主。
 *
 * ⭐ 为什么片段要自己造根节点（而不是直接往宿主的容器里画）：
 *    `mountModuleSlot()` 的 `render()` 是「一次性返回 Node / 字符串」的形状，而日历视图有
 *    月份导航 / 图层开关 / 事件增删改 / 人生日历 —— 它自己需要**一个稳定的根**来挂
 *    「一次事件委托」与「就地重画」（`paintSelection()` / `applyLayerVis()` 都只改那个根里面的东西）。
 *    ⇒ 根节点由片段造、交给 `mountCalendarView()` 托管。宿主只负责「什么时候挂、挂进哪个容器」。
 *
 * ⚠️ 渲染与委托全在 `./desktop.js` 的 `mountCalendarView()` 里（本文件刻意只有几行）：
 *    片段是「宿主与模块之间唯一的缝」，它不该长出第二份渲染逻辑。
 *    ⚠️ 这里**不返回字符串**：字符串会由宿主 `insertAdjacentHTML()` 进去，那时
 *    「根节点」就不存在了 —— 事件委托没有地方挂（表现：点了没反应、且不报错）。
 *
 * ⭐ 0.8.15：日历从前靠 `desktop/app.css` 里一条**无条件动画**
 *    （`.cal-dashview { animation: dash-swap-in … }`，连类都不用加）—— 那是全仓**第七条**
 *    各自为政的动画判据，本轮撤掉。改成**挂载那一次自己播**：`swapIn(root)`。
 *    ⚠️ 效果与从前**逐字相同**（同一枚 keyframes、同一个 0.2s），只是判据回到了
 *    `core/transition.js` 那一份（⛔ 别在 CSS 里加回一条无条件动画）。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.51
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
  //    动画在进文档那一刻起播 —— 与 0.8.14 那条无条件动画的时机一致。
  // ⭐ 0.8.51：`tier 2` —— 这是首页看板「列表 ↔ 日历」那一次**胶囊切换**（与 `views/home.js`
  //    的 `swapAnimOnce()` 同级、同一条观感），⛔ 别给成三级（那会让两个方向快慢不同）。
  swapIn(root, 2);
  return root;
}
