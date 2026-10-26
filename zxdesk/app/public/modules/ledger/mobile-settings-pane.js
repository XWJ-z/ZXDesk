/**
 * modules/ledger/mobile-settings-pane.js —— 手机版：设置页「💰 生活记账」分栏（0.8.21）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'mobile', 'ledger', 'settings-pane', ctx)` 动态挂载。
 *      内容 ＝ 记账设置那**四条**（收支账户 / 收支分类 / 导入三方数据 / 导出数据）；
 *      点一条**就地展开**成那一页的正文，⛔ 不切屏。
 *
 * ⭐⭐ 为什么它在这儿（「生活记账的【设置】在全局设置中也要有一份」）：
 *      记账设置原先只能从「生活记账 → 设置」那一格进去 —— 而它是**全局设置**该管的事。
 *      ⚠️ 用的是现成的**模块贡献分栏**机制——
 *      ⛔ 别另写一套「设置页里塞个特例」。
 *
 * ⚠️⭐ **正文与判据全部复用 `mobile.js` 那一支**（`ledgerSetHtml()` / `handleLedgerSetChange()`）——
 *      下面是这一栏唯一的那点"新东西"，三件：
 *      ① `change` 委托挂在**本栏自己的根**上：这一栏住在设置页里，账本屏那条委托够不着
 *         （「谁的表谁挂」，与弹层/插槽片段同一条纪律）。
 *         而 `data-act`（点条目 `lg-setgo` / 点 ‹ 返回 `lg-setback` / 子页里那些按钮）
 *         **照旧走宿主的 `ACTIONS` 表**（`#app` 全局委托）⇒ 那两下不需要本栏写一行代码。
 *      ② 展开状态**就是 `state.lgSetPage`**（与账本屏设置格共用）⇒ 宿主那两支动作改完它
 *         就会调 `renderLedger()`，而那一趟会回调本栏登记的重画钩子。
 *      ③ 挂载时**自己把设置要用的数据取回来**（`prepareLedgerSettings()`）——
 *         用户完全可能没进过账本屏就直接来设置页。
 *
 * @author zx
 * @date   2026-10-12
 * @since 0.8.21
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/13-决策记录.md（决策 77）、core/slots.js
 */

import { esc } from '../../core/dom.js';
import { SET_PAGES } from './calc.js';
import {
  handleLedgerSetChange,
  ledgerSetHtml,
  ledgerSetPageNow,
  prepareLedgerSettings,
  setSettingsPaneRepaint,
} from './mobile.js';

/**
 * 功能：画出设置页「生活记账」分栏 —— 四条设置条目；点一条就地展开成那一页的正文。
 *
 * ⚠️⚠️ **它必须是同步的**（⛔ 别改成 `async`）：设置页重画时 `mountModuleSlot()` 那两趟挂载
 *      会各自 `await` 片段 —— 片段自己也 `await` 的话两趟就**交错**（第 2 趟清空容器时第 1 趟
 *      还没挂上根，等它回来又 `appendChild` 一次）⇒ 容器里躺着**两份**「生活记账」
 *      （实测踩过：截图上是四条目下面又跟了一条子页头）。数据改成**后台取、回来再画**。
 *
 * @returns {HTMLElement} 这一个分栏的根节点
 * @since 0.8.21
 */
export function render() {
  const root = document.createElement('div');
  root.className = 'lg-setpane';

  /** 功能：按当前展开到哪一页把这一栏重画一遍（空串 = 四条条目那张列表）。 @returns {void} */
  const paint = () => {
    const page = ledgerSetPageNow();
    if (!page) {
      root.innerHTML = ledgerSetHtml('');
      return;
    }
    const meta = SET_PAGES.find((p) => p.key === page);
    // ⚠️ 顶上那条「‹ 返回」是**本栏自己**的（账本屏那一条长在 `.lg-setp` 里，够不着这儿）。
    //    它走 `data-act="lg-setback"` ⇒ 宿主那支动作清掉 `state.lgSetPage` 并重画 ⇒ 回到列表。
    root.innerHTML =
      '<div class="lg-setpane-head">' +
      '<button class="lg-setpane-back" type="button" data-act="lg-setback" aria-label="返回">‹</button>' +
      `<b>${esc((meta && meta.name) || '生活记账')}</b>` +
      '</div>' +
      `<div class="lg-setpane-body">${ledgerSetHtml(page)}</div>`;
  };

  // ① 本栏自己的 `change`（默认账户那三处）；② 登记重画钩子（账本屏每次重画都会回调它）
  root.addEventListener('change', (e) => handleLedgerSetChange(e.target));
  setSettingsPaneRepaint(paint);

  // 先把四条条目画出来（它不需要任何数据，⛔ 别让用户先看一段空白）；
  // 设置要用的数据**后台取**，回来了再画一遍（⛔ 不 await —— 理由见函数说明）。
  paint();
  prepareLedgerSettings()
    .then(paint)
    .catch(() => {
      /* 取不到就不补画：四条目照旧在，子页里该显示"读不到"的地方自己会说 */
    });
  return root;
}
