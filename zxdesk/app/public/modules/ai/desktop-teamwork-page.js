'use strict';
/**
 * modules/ai/desktop-teamwork-page.js —— ai辅助任务在**电脑版对话页**的插槽片段（0.6.0）
 *
 * 功能：`teamwork-page` 槽的电脑版实现。⭐ 0.6.x 起它**不再画任何界面**：AI 已经是一条
 *      「会话对象」（登记进对话模块的会话列表，点开走 `teamwork-thread` 槽），本片段只剩两件
 *      必须在进对话页时就办的事 ——
 *      ① 把「🤖 问 AI / 记成任务」接进消息右键菜单（`zx:teamwork-msg-menu` 留白事件）；
 *      ② 把 AI 登记进会话区（`zx:teamwork-conv-entries` 留白事件，`bindTeamworkConvEntries()`）。
 *
 * ⭐ 本文件只是**薄壳**：登记的数据、聊天视图、预览层与确认卡都在 `./shared.js`（两端同一份语义）；
 *    这里只负责把电脑版的宿主接口（toast / 通用模态框 / 侧栏刷新）注入进去。
 *
 * ⚠️ 由 `core/slots.js` 按约定路径动态 `import()`（接线表 `slots: ['teamwork-page', 'teamwork-thread']`），
 *    对话模块不认识本文件 —— 删掉 `app/public/modules/ai/` 后槽位为空、对话页照旧。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、core/slots.js
 */

import { $ } from '../../core/dom.js';
import { loadProjects } from '../../desktop/shell.js';
import { closeModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import { bindTeamworkConvEntries, bindTeamworkMsgMenuHook } from './shared.js';

/**
 * 功能：渲染电脑版对话页的 AI 插槽片段（`core/slots.js` 的挂载入口）。
 * @param {Object} _ctx - 挂载上下文（`{ end, modules, uiOf, me }`；本片段直接用本端单例，用不到它）
 * @returns {Promise.<HTMLElement>} 空根节点（本片段没有可见界面；容器为空时宿主自然隐藏）
 */
export async function render(_ctx) {
  // ⭐ 两个留白事件都只挂一次（shared 里模块级去重）；每次进对话页都会走到这里，重复调用无害
  bindTeamworkMsgMenuHook({
    toast,
    // 加完任务要刷一次项目侧栏（今日待办的数字与项目列表都在那），与 chat 模块同一口径
    onCreated: () => {
      loadProjects();
    },
    openForm: ({ title, bodyHtml, saveLabel, onSave, onRendered }) => {
      openModal(title, bodyHtml);
      setModalSave(saveLabel, false);
      $('#modal-save').onclick = () => onSave(closeModal);
      if (onRendered) onRendered($('#modal-body'));
    },
  });
  bindTeamworkConvEntries();
  return document.createElement('div');
}
