'use strict';
/**
 * modules/ai/mobile-teamwork-thread.js —— ai辅助任务的**插槽会话屏**（手机版，0.6.x）
 *
 * 功能：`teamwork-thread` 槽的手机版实现 —— AI 作为一条「会话对象」被点开后，对话模块把
 *      第三块屏（`#teamwork-screen-slot`）的内容区让给本片段：顶栏（返回钮 / 名字 / 副标题）
 *      仍是**对话模块**画的，这里画聊天视图本体（消息区 + 输入行，`createAiThreadView()`）。
 *
 * ⭐ 本文件只是**薄壳**：SSE 读流、历史、错误兜底都在 `./shared.js`（两端同一份语义）；
 *    版式差异由两端的 CSS 承担（类名是共用约定，样式各写一份）。
 *
 * ⚠️ 由 `core/slots.js` 按约定路径动态 `import()`（接线表 `slots: ['teamwork-page', 'teamwork-thread']`）。
 *
 * @author zx
 * @date   2026-09-16
 * @since 0.8.13
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、core/slots.js
 */

import { createAiThreadView } from './shared.js';

/**
 * 功能：渲染手机版插槽会话屏的 AI 片段（`core/slots.js` 的挂载入口）。
 * @param {Object} _ctx - 挂载上下文（本片段直接用本端单例，用不到它）
 * @returns {Promise.<HTMLElement>} 聊天视图根节点
 */
export async function render(_ctx) {
  return createAiThreadView();
}
