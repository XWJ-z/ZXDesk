/**
 * modules/ai/desktop-settings-pane.js —— 电脑版：设置页「AI 设置」分栏（0.8.9）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPanes()` + `mountModuleSlot(box, 'desktop', 'ai', 'settings-pane', ctx)` 动态挂载。
 *      内容 = `shared.js` 的 `createAiPanel()`（连接 / 上下文 / 记忆 / 能力 四块）。
 *
 * ⭐ 为什么 AI 从「自己的一屏」变回「设置页的一栏」（
 *    「撤销独立显示卡，因为全是设置，现在并入全局设置中的 AI 设置里」）：
 *    它那一屏里**一件操作都没有**，全是配置 ⇒ 单独占一扇门、一张看板卡都是浪费。
 *    它借的正是「模块贡献分栏」这条现成机制—— ⛔ 不要另写一套「设置页里塞个特例」。
 *
 * ⚠️ `shared.js` 用**动态 `import()`**（与 2 期那一版同一条理由）：它是本模块两端共用的界面引擎，
 *    静态 import 会把它（163 KB）算进「设置页的静态可达图」，而这一栏是「点进去才看」的低频内容。
 * ⚠️ 片段**先返回容器、内容异步填**（与 `mobile/app.js` 的「正在读取…」同一手法）：
 *    `mountModuleSlot()` 的 `render()` 是同步取节点的形状，异步等在这里会把设置页卡住。
 * ⚠️ 失败绝不静默：片段加载不出来时，栏里给一句人话、控制台留全错。
 *
 * @author zx
 * @date   2026-09-30
 * @since 0.8.9
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { openConfirmModal, toast } from '../../desktop/ui.js';

/**
 * 功能：画出设置页「AI 设置」分栏的内容（连接 / 上下文 / 记忆 / 能力）。
 *
 * @returns {HTMLElement} 这一个分栏的根节点（内容异步填进去）
 */
export function render() {
  const box = document.createElement('div');
  box.innerHTML = '<div class="es-text">正在读取…</div>';
  import('./shared.js')
    .then(({ createAiPanel }) => {
      const panel = createAiPanel({
        toast,
        // ⚠️ 与 2 期那一版**逐字同一份调用**（`openAiPanel()` 里也是这一句）：
        //    弹窗接口只在宿主这一层，`shared.js` 不认识 `openConfirmModal`。
        ask: (opts, fn) => openConfirmModal(opts.title, opts.text, opts.ok, fn),
      });
      box.textContent = '';
      box.appendChild(panel.node);
    })
    .catch((e) => {
      console.error('[ai] 设置分栏加载失败:', e);
      box.textContent = 'AI 界面加载失败 —— 请刷新页面重试；若一直如此，请到「设置 → 模块功能」先关掉再打开这个功能。';
    });
  return box;
}
