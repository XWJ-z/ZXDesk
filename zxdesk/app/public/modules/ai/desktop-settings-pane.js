/**
 * modules/ai/desktop-settings-pane.js —— 电脑版：设置页「AI 设置」分栏
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 * `slotPanes()` + `mountModuleSlot(box, 'desktop', 'ai', 'settings-pane', ctx)` 动态挂载。
 * 内容 = `shared.js` 的 `createAiPanel()`（连接 / 上下文 / 记忆 / 能力 四块）。
 *
 * @author zx
 * @date   2026-09-30
 * @since 0.9.7
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { openConfirmModal, openNoticeModal, toast } from '../../desktop/ui.js';

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
        // 只读提示（https 连不上那一类）—— 只有一颗「知道了」，点完就关；
        //    ⚠️ 与手机端 `mobile.js` 的 `notice` 是**同一个契约**（`host.notice(title, text)`）
        notice: (title, text) => openNoticeModal(title, text),
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
