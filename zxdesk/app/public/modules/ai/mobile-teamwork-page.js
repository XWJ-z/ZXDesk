'use strict';
/**
 * modules/ai/mobile-teamwork-page.js —— ai辅助任务在**手机版对话页**的插槽片段（0.6.0）
 *
 * 功能：`teamwork-page` 槽的手机版实现。⭐ 0.6.x 起它**不再画任何界面**：AI 已经是一条
 *      「会话对象」（登记进对话模块的会话列表，点开走 `teamwork-thread` 槽），本片段只剩两件
 *      必须在进对话列表屏时就办的事 ——
 *      ① 把「🤖 问 AI / 记成任务」接进消息长按菜单（`zx:teamwork-msg-menu` 留白事件；
 *      长按与 `contextmenu` 两条路的识别在 chat 模块，本片段只管被调起来之后的事）；
 *      ② 把 AI 登记进会话区（`zx:teamwork-conv-entries` 留白事件，`bindTeamworkConvEntries()`）。
 *
 * ⭐ 本文件只是**薄壳**：登记的数据、聊天视图、预览层与确认卡都在 `./shared.js`（两端同一份语义）；
 *    这里只负责把手机版的宿主接口（toast / 底部弹层 / 数据刷新）注入进去。
 *    ⚠️ 弹层折叠只就地改 class，不整屏重画。
 *
 * ⚠️ 由 `core/slots.js` 按约定路径动态 `import()`（接线表 `slots: ['teamwork-page', 'teamwork-thread']`），
 *    对话模块不认识本文件 —— 删掉 `app/public/modules/ai/` 后槽位为空、对话页照旧。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、core/slots.js
 */

import { $, esc } from '../../core/dom.js';
import { refresh } from '../../mobile/data.js';
import { closeSheet, openSheet, toast } from '../../mobile/ui.js';
import { bindTeamworkConvEntries, bindTeamworkMsgMenuHook } from './shared.js';

/**
 * 功能：渲染手机版对话列表屏的 AI 插槽片段（`core/slots.js` 的挂载入口）。
 * @param {Object} _ctx - 挂载上下文（`{ end, modules, uiOf, me }`；本片段直接用本端单例，用不到它）
 * @returns {Promise.<HTMLElement>} 空根节点（本片段没有可见界面；容器为空时宿主自然隐藏）
 */
export async function render(_ctx) {
  // ⭐ 两个留白事件都只挂一次（shared 里模块级去重）；重复调用无害
  bindTeamworkMsgMenuHook({
    toast,
    // 加完任务要刷一次数据（今天 / 任务板 / 项目那几屏都要看到新任务），与 chat 模块同一口径
    onCreated: () => {
      refresh();
    },
    openForm: ({ title, bodyHtml, saveLabel, onSave, onRendered }) => {
      openSheet(
        title,
        bodyHtml,
        `<button class="btn" type="button" data-ai-save style="flex:2">${esc(saveLabel)}</button>` +
          `<button class="btn ghost" type="button" data-act="sheet-close" style="flex:1">关闭</button>`,
      );
      // ⚠️ 片段贡献的按钮不走全局动作表（那是宿主自己那套），就地绑定
      const btn = document.querySelector('#sheet-foot [data-ai-save]');
      if (btn) btn.addEventListener('click', () => onSave(closeSheet));
      if (onRendered) onRendered($('#sheet-body'));
    },
  });
  bindTeamworkConvEntries();
  return document.createElement('div');
}
