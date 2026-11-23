'use strict';
/**
 * modules/ai/mobile-teamwork-page.js —— ai辅助任务在**手机版对话页**的插槽片段
 * 功能：`teamwork-page` 槽的手机版实现。.x 起它**不再画任何界面**：AI 已经是一条
 * 「会话对象」（登记进对话模块的会话列表，点开走 `teamwork-thread` 槽），本片段只剩两件
 * @author zx
 * @date   2026-09-15
 * @since 0.9.7
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
  // 两个留白事件都只挂一次（shared 里模块级去重）；重复调用无害
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
      // 片段贡献的按钮不走全局动作表（那是宿主自己那套），就地绑定
      const btn = document.querySelector('#sheet-foot [data-ai-save]');
      if (btn) btn.addEventListener('click', () => onSave(closeSheet));
      if (onRendered) onRendered($('#sheet-body'));
    },
  });
  bindTeamworkConvEntries();
  return document.createElement('div');
}
