/**
 * modules/ai/mobile-settings-pane.js —— 手机版：设置页「AI 设置」那一栏（0.8.9）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由手机设置页通过
 *      `mountModuleSlot(box, 'mobile', 'ai', 'settings-pane', ctx)` 动态挂载。
 *      内容 = `mobile.js` 的 `mountAiPane()`（常驻块 + 六行入口 + 每区一个底部弹层）。
 *
 * ⭐ 为什么 AI 从「自己的一屏」变回「设置页的一栏」（
 *    「撤销独立显示卡，因为全是设置，现在并入全局设置中的 AI 设置里」）：
 *    它那一屏里**一件操作都没有**，全是配置。它借的正是「模块贡献分栏」这条现成机制
 *    —— ⛔ 不要另写一套「设置页里塞个特例」。
 *    ⚠️ 与电脑端**同一步**（`modules/ai/desktop-settings-pane.js`）：`module-ui.test.js`
 *    钉着「`settingsPane` 只在一端声明就红」。
 *
 * ⚠️ `mobile.js` 用**动态 `import()`**：它与 `shared.js` 是本模块的界面引擎，
 *    静态 import 会把它算进这一端入口的静态可达图（前者 8.7 KB、后者 163 KB）。
 * ⚠️ 片段**先返回容器、内容异步填**（与手机端一贯的「正在读取…」同一手法）。
 * ⚠️ 失败绝不静默：片段加载不出来时，栏里给一句人话、控制台留全错。
 *
 * @author zx
 * @date   2026-09-30
 * @since 0.8.9
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
