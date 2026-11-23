'use strict';
/**
 * core/bookmark-create.js —— ⭐ **收藏一个网址的唯一入口**
 * 功能：把「新建一条收藏」收敛成一个对外函数 —— 任何需要新建收藏的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/bookmarks', …)`。
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：收藏一个网址，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.url - 网址（**必填**，要写全含 `https://` —— 服务端要求能被 `new URL()` 解析）
 * @param {string} [input.title] - 标题（留空时界面显示域名）
 */
export async function createBookmark(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  return api('POST', '/api/bookmarks', {
    url: text(src.url).trim(),
    title: text(src.title).trim(),
    tags: (Array.isArray(src.tags) ? src.tags : [])
      .map((t) => text(t).trim())
      .filter(Boolean),
  });
}
