/**
 * modules/bookmarks/routes.js —— 网址收藏夹路由（书签 / 分类）
 *
 * 功能：`handleBookmarks` 一处收全部收藏夹接口 —— 书签的列表（含检索与分类筛选）、
 *      新增、编辑、删除，以及分类的列表、新建、改名、删除。
 *
 * 说明：⭐ **收藏夹的数据只属于账号本人**（设计要求），所以这里每一条写操作都先过
 *      归属校验，越权与「不存在」统一 404（不给出「这条记录存在、只是不归你」这个探测信号）。
 *
 * 说明：⭐ 接口设计与 `routes/tasks.js` 同构（统一 `ctx` 参数表），鉴权由 `server.js`
 *      的 401 闸门保证 —— `/api/bookmarks/*` 挂在闸门**之后**。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/routes/bookmarks.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了三处：① 相对路径；
 *    ② 导出键从 `handleBookmarks` 改成 **`bookmarks`**（= `module.json` 的 `apiPrefix`，
 *    `server.js` 据此自动挂到 `/api/bookmarks` 上）；③ 本段说明。处理函数体一个字没动。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/14-网址收藏夹.md
 */
'use strict';

const { checkBookmark, checkTag } = require('../../core/validate.js');
const { httpError, idParam, json, notFound, readBody, writeResult } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');

/**
 * 功能：处理 `/api/bookmarks` 及其子路径 —— 书签的增删改查 + 分类的增删改查。
 *
 * 说明：路由表（`parts = ['api','bookmarks', …]`）——
 *      · `GET    /api/bookmarks?q=&tag=`  列表（多词 AND 检索 + 分类筛选；`tags` 随响应带回）
 *      · `POST   /api/bookmarks`          新增 `{ url, title?, tags? }`
 *      · `PUT    /api/bookmarks/:id`      编辑（`url?` / `title?` / `tags?`；`tags` 是整体替换）
 *      · `DELETE /api/bookmarks/:id`      删除
 *      · `GET    /api/bookmarks/tags`     分类列表（含每个分类的书签数）
 *      · `POST   /api/bookmarks/tags`     新建分类 `{ name }`（同名直接返回已有的那个）
 *      · `PUT    /api/bookmarks/tags/:id` 分类改名 `{ name }`
 *      · `DELETE /api/bookmarks/tags/:id` 删除分类（**书签保留**，只解除归类）
 *
 * ⚠️ `tags` 子路径必须**先于** `:id` 判断：否则 `GET /api/bookmarks/tags` 会被
 *    `idParam('tags')` 判成非法 id 而落到 404（一个稳定复现的「接口明明写了却打不通」）。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {Object} ctx.url - 解析好的 URL 对象（取查询参数）
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleBookmarks({ req, res, parts, url, method, uid }) {
  const sub = parts[2];

  // ---- 分类（`/api/bookmarks/tags`）----
  if (sub === 'tags') {
    if (method === 'GET' && parts.length === 3) return json(res, 200, { items: store.listTags(uid) });
    if (method === 'POST' && parts.length === 3) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.createTag(uid, checkTag(b).name));
      });
    }
    const tid = idParam(parts[3]);
    if (tid === null) return notFound(res);
    // 越权与不存在统一 404（403 等于告诉对方「这条记录存在，只是不归你」）
    if (!store.ownsTag(uid, tid)) return notFound(res);
    if (method === 'PUT' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        writeResult(res, store.renameTag(uid, tid, checkTag(b).name));
      });
    }
    if (method === 'DELETE' && parts.length === 4) return writeResult(res, store.removeTag(uid, tid));
    return notFound(res);
  }

  // ---- 列表 / 新增 ----
  if (parts.length === 2) {
    if (method === 'GET') {
      // 检索与筛选的参数**不做校验式拦截**：`q` 是自由文本、`tag` 非法就当作「不筛选」
      // （列表接口把参数打回 400 只会让用户对着一个空白页，而不是「没搜到」）
      const q = url && url.searchParams ? url.searchParams.get('q') || '' : '';
      const tag = url && url.searchParams ? url.searchParams.get('tag') : null;
      return json(res, 200, store.listBookmarks(uid, q, tag));
    }
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkBookmark(b);
        if (!fields.url) throw httpError(400, '网址不能为空');
        json(res, 201, store.createBookmark(uid, fields));
      });
    }
    return notFound(res);
  }

  // ---- 单条书签 ----
  const id = idParam(parts[2]);
  if (id === null) return notFound(res);
  if (!store.ownsBookmark(uid, id)) return notFound(res);
  if (method === 'GET' && parts.length === 3) {
    const b = store.getBookmark(uid, id);
    if (!b) return notFound(res);
    return json(res, 200, b);
  }
  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      writeResult(res, store.updateBookmark(uid, id, checkBookmark(b)));
    });
  }
  if (method === 'DELETE' && parts.length === 3) return writeResult(res, store.removeBookmark(uid, id));
  return notFound(res);
}

// ⭐ 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/bookmarks` 上
module.exports = { bookmarks: handleBookmarks };
