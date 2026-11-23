/**
 * modules/ai/mobile-settings-pane.js —— 手机版：设置页「AI 设置」那一栏
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由手机设置页通过
 * `mountModuleSlot(box, 'mobile', 'ai', 'settings-pane', ctx)` 动态挂载。
 * 内容 = `mobile.js` 的 `mountAiPane()`（常驻块 + 六行入口 + 每区一个底部弹层）。
 *
 * @author zx
 * @date   2026-09-30
 * @since 0.9.7
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { toast } from '../../mobile/ui.js';

/**
 * 功能：画出设置页「AI 设置」那一栏的内容（常驻块 + 六行入口）。
 *
 * @returns {HTMLElement} 这一栏的根节点（内容异步填进去）
 */
export function render() {
  const box = document.createElement('div');
  box.innerHTML = '<div class="es-text">正在读取…</div>';
  import('./mobile.js')
    .then((m) => {
      box.textContent = '';
      return m.mountAiPane(box);
    })
    .catch((e) => {
      console.error('[ai] 设置分栏加载失败:', e);
      toast('AI 界面加载失败 —— 请刷新页面重试', true);
      box.textContent = 'AI 界面加载失败 —— 请刷新页面重试；若一直如此，请到「设置 → 模块功能」先关掉再打开这个功能。';
    });
  return box;
}
