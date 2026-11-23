'use strict';
/**
 * modules/ai/desktop-teamwork-thread.js —— ai辅助任务的**插槽会话屏**（电脑版，0.6.x）
 * 功能：`teamwork-thread` 槽的电脑版实现 —— AI 作为一条「会话对象」被点开后，对话模块把主区
 * 让位给本片段：头部（名字 / 副标题）仍是**对话模块**画的，这里画聊天视图本体
 * @author zx
 * @date   2026-09-16
 * @since 0.9.7
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、core/slots.js
 */

import { createAiThreadView } from './shared.js';

/**
 * 功能：渲染电脑版插槽会话屏的 AI 片段（`core/slots.js` 的挂载入口）。
 * @param {Object} _ctx - 挂载上下文（本片段直接用本端单例，用不到它）
 * @returns {Promise.<HTMLElement>} 聊天视图根节点
 */
export async function render(_ctx) {
  return createAiThreadView();
}
