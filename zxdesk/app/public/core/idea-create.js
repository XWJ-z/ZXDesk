'use strict';
/**
 * core/idea-create.js —— ⭐ **记一条随手记的唯一入口**（0.8.5）
 *
 * 功能：把「新建一条随手记」收敛成一个对外函数 —— 任何需要新建随手记的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/idea', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`、`core/ledger-create.js`（0.8.4）**同一条规矩**：
 *      AI 的确认卡不许自己拼请求 —— 卡上的「同意」是**前端逐条落库**，那条路必须走这个函数。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/idea/`**：调用方里有 `ai`（随手记确认卡）——
 *      它**不许 import 随手记模块的实现**（跨模块只走 REST 与留白事件）。既然「都调它」
 *      是硬要求，它就必须落在**共用层**，否则 ai 那条路径只能继续自己拼一份。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 一条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 与后端一致的约定：`content` 是**多行纯文本**（界面上 `pre-wrap` 原样显示，⛔ 不解析 Markdown）；
 *    `tag` 是**单个**自由文本标签（不是数组 —— 这张表只有一列，见 `modules/idea/schema.js`）。
 *
 * ⚠️ 本函数**只负责「创建」**：改 / 归档 / 删 / 变成任务都各有自己的路。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.5
 * 相关：docs/公共/架构文档/19-灵感库.md（界面上叫「随手记」）、docs/公共/架构文档/18-ai辅助任务.md
 */

import { api } from './api.js';

/**
 * 功能：记一条随手记，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.content - 正文（**必填**；多行纯文本，服务端上限 20000 字）
 * @param {string} [input.tag] - 标签（一个，可以空着）
 * @returns {Promise.<Object>} 新建出来的那条（含 `id`）
 */
export async function createIdea(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  return api('POST', '/api/idea', {
    content: text(src.content).trim(),
    tag: text(src.tag).trim(),
  });
}
