/**
 * modules/teamwork/mobile-settings-pane.js —— 手机版：设置页「团队协作」分块
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'mobile', 'teamwork', 'settings-pane', ctx)` 动态挂载。
 *      内容**只有一行**：一颗「提醒与好友设置」的入口。
 *
 * ⭐⭐ 为什么它在（「团队协作中的设置应该在全局设置中也要有一份，
 *    两个设置是同一个，不是两边独立设置」）：与电脑端**同一条口径、同一份实现** ——
 *    点下去调的是模块自己的 `openTeamworkSettings()`（本端的底部弹层），
 *    ⛔ 这里没有第二份表单。
 *    ⚠️ 用的是现成的**模块贡献分块**机制，与密码库 / 生活记账 / AI 同一套。
 *
 * @author zx
 * @date   2026-10-19
 * @since 0.8.34
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/架构文档/13-决策记录.md（决策 77）、core/slots.js
 */

import { toast } from '../../mobile/ui.js';

/**
 * 功能：画出设置页「团队协作」分块 —— 一行入口，点开模块自己的设置弹层。
 *
 * @returns {HTMLElement} 这个分块的根节点
 */
export function render() {
  const box = document.createElement('div');
  box.innerHTML = `
    <button class="mrow" type="button" id="set-tw-settings" style="width:100%;font:inherit;text-align:left">
      <span class="mtxt">提醒与好友设置<small>提醒时刻、称呼、自动通过好友申请、聊天记录与回收站</small></span>
      <span class="mval">打开 ›</span>
    </button>`;
  box.querySelector('#set-tw-settings').addEventListener('click', async () => {
    try {
      const m = await import('./mobile-settings.js');
      await m.openTeamworkSettings();
    } catch (e) {
      console.error('[teamwork] 设置面板加载失败:', e);
      toast('团队协作的设置打不开 —— 请刷新页面重试', true);
    }
  });
  return box;
}
