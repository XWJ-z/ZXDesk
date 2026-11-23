/**
 * modules/teamwork/desktop-settings-pane.js —— 电脑版：设置页「团队协作」分栏
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 * `slotPaneDefs()` + `mountModuleSlot(box, 'desktop', 'teamwork', 'settings-pane', ctx)` 动态挂载。
 * 内容**只有一行**：一颗「打开团队协作设置」的入口。
 *
 * @author zx
 * @date   2026-10-19
 * @since 0.9.7
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
