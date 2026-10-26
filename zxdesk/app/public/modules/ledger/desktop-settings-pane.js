/**
 * modules/ledger/desktop-settings-pane.js —— 电脑版：设置页「💰 生活记账」分栏（0.8.21）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'desktop', 'ledger', 'settings-pane', ctx)` 动态挂载。
 *      内容 ＝ 记账设置那**四条**（收支账户 / 收支分类 / 导入三方数据 / 导出数据）；
 *      点一条**打开记账设置那张宽弹窗、直接落在那一页**上（⛔ 不切屏）。
 *
 * ⭐⭐ 为什么它在这儿（「生活记账的【设置】在全局设置中也要有一份」）：
 *      记账设置原先只能从「生活记账 → 左栏那颗设置」进去 —— 而它是**全局设置**该管的事。
 *      ⚠️ 用的是现成的**模块贡献分栏**机制——
 *      ⛔ 别另写一套「设置页里塞个特例」。
 *
 * ⚠️⭐ 电脑端**就地展开**这件事刻意**没做**：记账设置那几块的正文与重画全压在
 *      `paintLedgerSet()` 上（**26 处**写操作都调它，它做的是"重开那张弹窗"）⇒ 把正文搬进
 *      设置页就得把那 26 处与弹窗那两套委托一起改，而换来的只是「弹窗 vs 内联」这点观感差。
 *      ⇒ 这一端走**弹窗**（它同样不切屏），手机端那一栏才是就地展开的。
 *      ⚠️ 手机端与电脑端**条目清单共用** `SET_PAGES`（`./calc.js`）⇒ 两端那四条永远一致。
 *
 * @author zx
 * @date   2026-10-12
 * @since 0.8.21
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/13-决策记录.md（决策 77）、core/slots.js
 */

import { ledgerSetRowsHtml, openLedgerSetPage } from './desktop.js';

/**
 * 功能：画出设置页「生活记账」分栏 —— 记账设置那四条条目；点一条开记账设置并落在那一页。
 *
 * @returns {HTMLElement} 这一个分栏的根节点
 * @since 0.8.21
 */
export function render() {
  const root = document.createElement('div');
  root.className = 'lg-setpane';
  // ⚠️ 条目本体复用弹窗里那一份（`data-lg="setgo"` ＋ `data-page`）—— 它们**不是**给账本屏
  //    那条委托用的（设置页里够不着那两处委托），所以由下面这条本栏自己的 click 接住。
  root.innerHTML = ledgerSetRowsHtml();
  root.addEventListener('click', (e) => {
    const n = e.target.closest ? e.target.closest('[data-lg="setgo"]') : null;
    if (!n) return;
    openLedgerSetPage(String(n.dataset.page || ''));
  });
  return root;
}
