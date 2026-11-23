/**
 * modules/idea/routes.js —— 灵感库路由（捕获 / 检索 / 归档 / 变成任务）
 *
 * 功能：`handleIdea` 一处收全部灵感库接口 —— 列表（含检索、未归档 / 归档筛选、标签筛选与汇总）、
 * 新增、详情、编辑（含归档与「已变成任务」的标记）、删除。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.9.7
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md
 */
'use strict';

const { checkIdea, checkTag } = require('../../core/validate.js');
const { httpError, idParam, json, notFound, readBody, writeResult } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');

/**
 * 功能：处理 `/api/idea` 及其子路径 —— 灵感库的增删改查 + 标签的增删改查。
 *
 * 说明：路由表（`parts = ['api','idea', …]`）——
 * `GET    /api/idea?q=&view=&tag=&sort=`  列表（检索 + 筛选 + 排序 + 汇总）
 * `POST   /api/idea`                新增 `{ content, title?, tags? }`（⚠️ 旧包传的 `tag` 照样收）
 */
function handleIdea({ req, res, parts, url, method, uid }) {
  const sub = parts[2];

  if (sub === 'tags') {
    if (method === 'GET' && parts.length === 3) return json(res, 200, store.listIdeaTags(uid));
    if (method === 'POST' && parts.length === 3) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // 契约：新建回 201、同名复用回 200 —— `created` 由 store 给出
        const r = store.createIdeaTag(uid, checkTag(b).name);
        json(res, r.created ? 201 : 200, r.tag);
      });
    }
    const tid = idParam(parts[3]);
    if (tid === null) return notFound(res);
    if (method === 'PUT' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // 越权 / 不存在统一 404：store 回 false ⇒ writeResult 走 notFound()
        writeResult(res, store.renameIdeaTag(uid, tid, checkTag(b).name));
      });
    }
    if (method === 'DELETE' && parts.length === 4) return writeResult(res, store.removeIdeaTag(uid, tid));
    return notFound(res);
  }

  // ---- 列表 / 新增 ----
  if (parts.length === 2) {
    if (method === 'GET') {
      // 筛选参数**不做校验式拦截**：`q` 是自由文本，`view` / `tag` 不认识就当「不筛」
      const p = (url && url.searchParams) || null;
      return json(
        res,
        200,
        store.listIdeas(uid, {
          q: p ? p.get('q') || '' : '',
          view: p ? p.get('view') || '' : '',
          tag: p ? p.get('tag') || '' : '',
          // 排序（时间 / 标签）—— 判据在 `store.listIdeas()` 里，这里只是把参数递进去
          sort: p ? p.get('sort') || '' : '',
        }),
      );
    }
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkIdea(b);
        // 正文是唯一必填项，且**在这里**查（校验层只管「带了就校验」，
        // 这样编辑时「只改标签」不会被要求重发正文）—— 与硬件的名称同一手法
        if (!fields.content) throw httpError(400, '写点什么再存吧');
        json(res, 201, store.createIdea(uid, fields));
      });
    }
    return notFound(res);
  }

  // ---- 单条 ----
  const id = idParam(parts[2]);
  if (id === null) return notFound(res);
  // 越权与不存在统一 404
  if (!store.ownsIdea(uid, id)) return notFound(res);
  // 只有 `/api/idea/:id` 这一种形状（没有子资源）：别的形状一律 404，
  if (parts.length !== 3) return notFound(res);
  if (method === 'GET') {
    const it = store.getIdea(uid, id);
    if (!it) return notFound(res);
    return json(res, 200, it);
  }
  if (method === 'PUT') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      // （与硬件的名称、任务的标题同口径）
      const fields = checkIdea(b);
      if (Object.prototype.hasOwnProperty.call(fields, 'content') && !fields.content) {
        throw httpError(400, '写点什么再存吧');
      }
      writeResult(res, store.updateIdea(uid, id, fields));
    });
  }
  if (method === 'DELETE') {
    return writeResult(res, store.removeIdea(uid, id));
  }
  return notFound(res);
}

module.exports = { idea: handleIdea };
