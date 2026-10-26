/**
 * modules/teamwork/desktop-settings-pane.js —— 电脑版：设置页「团队协作」分栏
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'desktop', 'teamwork', 'settings-pane', ctx)` 动态挂载。
 *      内容**只有一行**：一颗「打开团队协作设置」的入口。
 *
 * ⭐⭐ 为什么它在（「团队协作中的设置应该在全局设置中也要有一份，
 *    两个设置是同一个，不是两边独立设置」）：
 *    · 从前团队协作的设置**只在自己的屏里**（对话页头部那颗 ⚙ → `desktop-settings.js` 的弹窗），
 *      全局设置里没有入口 ⇒ 想改提醒时刻得先进那一屏；
 *    · 现在这一栏点下去调的就是**同一个** `openTeamworkSettings()` —— 同一个弹窗、同一份校验、
 *      同一批接口。⛔ 这里**没有第二份表单**：那正是「两边独立设置」的形状。
 *    ⚠️ 用的是现成的**模块贡献分栏**机制，与密码库 / 生活记账 / AI 同一套。
 *    ⚠️ 动态 `import()` 是刻意的：这个模块的界面引擎很重，而这一栏是「点进去才看」的低频内容。
 *    ⚠️ 失败绝不静默：加载不出来时给一句人话，控制台留全错。
 *
 * @author zx
 * @date   2026-10-19
 * @since 0.8.34
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/架构文档/13-决策记录.md（决策 77）、core/slots.js
 */

import { toast } from '../../desktop/ui.js';

/**
 * 功能：画出设置页「团队协作」分栏 —— 一行入口，点开模块自己的设置弹窗。
 *
 * @returns {HTMLElement} 这一个分栏的根节点
 */
export function render() {
  const box = document.createElement('div');
  box.innerHTML = `
    <button id="set-tw-settings" class="set-row" type="button">
      <span class="set-main"><b>提醒与好友设置</b><small>提醒时刻、称呼、自动通过好友申请、聊天记录与回收站</small></span>
      <span class="set-val">打开 ›</span>
    </button>`;
  box.querySelector('#set-tw-settings').addEventListener('click', async () => {
    try {
      const m = await import('./desktop-settings.js');
      await m.openTeamworkSettings();
    } catch (e) {
      console.error('[teamwork] 设置面板加载失败:', e);
      toast('团队协作的设置打不开 —— 请刷新页面重试', true);
    }
  });
  return box;
}
