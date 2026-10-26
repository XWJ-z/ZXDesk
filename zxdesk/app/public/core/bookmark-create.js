'use strict';
/**
 * core/bookmark-create.js —— ⭐ **收藏一个网址的唯一入口**（0.8.5）
 *
 * 功能：把「新建一条收藏」收敛成一个对外函数 —— 任何需要新建收藏的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/bookmarks', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`、`core/ledger-create.js`（0.8.4）**同一条规矩**：
 *      AI 的确认卡不许自己拼请求 —— 卡上的「同意」是**前端逐条落库**，那条路必须走这个函数。
 *      否则「收藏夹创建」这条语义就会开始在两处各自漂移（字段名、默认值、错误处理各写一份）。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/bookmarks/`**：调用方里有 `ai`（收藏确认卡）——
 *      它**不许 import 收藏夹模块的实现**（跨模块只走 REST 与留白事件）。既然「都调它」
 *      是硬要求，它就必须落在**共用层**，否则 ai 那条路径只能继续自己拼一份。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 一条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读）：
 *      · 字段名一律 **snake_case**，多送的键会被**静默丢掉**；
 *      · `tags` 是**分类名数组**（不是 id）：服务端 `ensureTag` 会把本机还没有的名字**顺手建出来** ——
 *        这正是用户在收藏表单里敲一个新分类名时走的那条路（同一条语义，⛔ 别另造一套）；
 *      · 同一账号内 **URL 重复 ⇒ 服务端明确报 400**（不静默覆盖）—— 调用方要如实把那句话显示出来。
 *
 * ⚠️ 本函数**只负责「创建」**：改 / 删与分类管理都各有自己的路，硬并进来只会把语义搅乱。
 *    也不管刷新与提示 —— 那些是调用方的副作用。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.5
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：收藏一个网址，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.url - 网址（**必填**，要写全含 `https://` —— 服务端要求能被 `new URL()` 解析）
 * @param {string} [input.title] - 标题（留空时界面显示域名）
 * @param {Array.<string>} [input.tags] - 分类名数组（本机没有的名字由服务端顺手建出来）
 * @returns {Promise.<Object>} 新建出来的收藏（含 `id`）
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
