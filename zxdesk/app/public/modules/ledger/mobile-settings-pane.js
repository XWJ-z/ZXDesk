/**
 * modules/ledger/mobile-settings-pane.js —— 手机版：设置页「💰 生活记账」分栏
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 * `slotPaneDefs()` + `mountModuleSlot(box, 'mobile', 'ledger', 'settings-pane', ctx)` 动态挂载。
 * 内容 ＝ 记账设置那**四条**（收支账户 / 收支分类 / 导入三方数据 / 导出数据）；
 * 点一条**就地展开**成那一页的正文，⛔ 不切屏。
 *
 * @author zx
 * @date   2026-10-12
 * @since 0.9.7
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
 * ⚠️⚠️ **它必须是同步的**（⛔ 别改成 `async`）：设置页重画时 `mountModuleSlot()` 那两趟挂载
 *      会各自 `await` 片段 —— 片段自己也 `await` 的话两趟就**交错**（第 2 趟清空容器时第 1 趟
 *      还没挂上根，等它回来又 `appendChild` 一次）⇒ 容器里躺着**两份**「生活记账」
 * @returns {HTMLElement} 这一个分栏的根节点
 * @since 0.9.7
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
