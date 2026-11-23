'use strict';
/**
 * core/idea-create.js —— ⭐ **记一条随手记的唯一入口**
 * 功能：把「新建一条随手记」收敛成一个对外函数 —— 任何需要新建随手记的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/idea', …)`。
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/19-灵感库.md（界面上叫「随手记」）、docs/公共/架构文档/18-ai辅助任务.md
 */

import { api } from './api.js';

/**
 * 功能：记一条随手记，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.content - 正文（**必填**；多行纯文本，服务端上限 20000 字）
 * @param {string} [input.tag] - 标签（一个，可以空着）
 */
export async function createIdea(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  return api('POST', '/api/idea', {
    content: text(src.content).trim(),
    tag: text(src.tag).trim(),
  });
}
