/**
 * modules/bookmarks/routes.js —— 网址收藏夹路由（书签 / 分类）
 *
 * 功能：`handleBookmarks` 一处收全部收藏夹接口 —— 书签的列表（含检索与分类筛选）、
 * 新增、编辑、删除，以及分类的列表、新建、改名、删除。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
 * `GET    /api/bookmarks?q=&tag=`  列表（多词 AND 检索 + 分类筛选；`tags` 随响应带回）
 * `POST   /api/bookmarks`          新增 `{ url, title?, tags? }`
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

// 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/bookmarks` 上
module.exports = { bookmarks: handleBookmarks };
