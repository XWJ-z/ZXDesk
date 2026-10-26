/**
 * modules/idea/routes.js —— 灵感库路由（捕获 / 检索 / 归档 / 变成任务）
 *
 * 功能：`handleIdea` 一处收全部灵感库接口 —— 列表（含检索、未归档 / 归档筛选、标签筛选与汇总）、
 *      新增、详情、编辑（含归档与「已变成任务」的标记）、删除。
 *
 * 说明：⭐ **灵感只属于账号本人**（`userScoped`），所以每一条带 id 的写操作都先过归属校验，
 *      越权与「不存在」统一 404（403 等于告诉对方「这条记录存在，只是不归你」）。
 *
 * 说明：⭐ 接口设计与硬件台账（`modules/hardware/routes.js`）同构（统一 `ctx` 参数表），
 *      鉴权由 `server.js` 的 401 闸门保证 —— `/api/idea/*` 挂在闸门**之后**。
 *
 * ⚠️ **没有「统计」接口**：未归档 / 归档两个计数随列表一起返回 —— 少一次请求、少一处 401 分支，
 *    而且切换筛选时计数不会闪烁（与硬件汇总同一条理由）。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.15
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
 *      · `GET    /api/idea?q=&view=&tag=&sort=`  列表（检索 + 筛选 + 排序 + 汇总）
 *      · `POST   /api/idea`                新增 `{ content, title?, tags? }`（⚠️ 旧包传的 `tag` 照样收）
 *      · `GET    /api/idea/:id`            详情
 *      · `PUT    /api/idea/:id`            编辑（`content` / `title` / `tags` / `archived` / `task_id`+`task_source`）
 *      · `DELETE /api/idea/:id`            删除
 *      · `GET    /api/idea/tags`           标签列表（含每个标签下的条数 ＋ 未分类数）
 *      · `POST   /api/idea/tags`           新建标签 `{ name }`（同名直接返回已有的那个）
 *      · `PUT    /api/idea/tags/:id`       标签改名 `{ name }`
 *      · `DELETE /api/idea/tags/:id`       删除标签（**随手记保留**，只解除归类）
 *
 * ⚠️ `tags` 子路径必须**先于** `:id` 判断：否则 `GET /api/idea/tags` 会被 `idParam('tags')`
 *    判成非法 id 而落到 404（`bookmarks/routes.js:42-44` 记着这个「接口明明写了却打不通」的坑，
 *    **逐字照抄那里的次序**）。
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
function handleIdea({ req, res, parts, url, method, uid }) {
  const sub = parts[2];

  // ---- 标签（`/api/idea/tags`，0.8.15）----
  if (sub === 'tags') {
    if (method === 'GET' && parts.length === 3) return json(res, 200, store.listIdeaTags(uid));
    if (method === 'POST' && parts.length === 3) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // ⭐ 契约：新建回 201、同名复用回 200 —— `created` 由 store 给出
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
      //（列表接口把参数打回 400 只会让用户对着一个空白页，而不是「没筛出来」）
      const p = (url && url.searchParams) || null;
      return json(
        res,
        200,
        store.listIdeas(uid, {
          q: p ? p.get('q') || '' : '',
          view: p ? p.get('view') || '' : '',
          tag: p ? p.get('tag') || '' : '',
          // ⭐ 0.8.14：排序（时间 / 标签）—— 判据在 `store.listIdeas()` 里，这里只是把参数递进去
          sort: p ? p.get('sort') || '' : '',
        }),
      );
    }
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkIdea(b);
        // ⚠️ 正文是唯一必填项，且**在这里**查（校验层只管「带了就校验」，
        //    这样编辑时「只改标签」不会被要求重发正文）—— 与硬件的名称同一手法
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
  // ⚠️ 只有 `/api/idea/:id` 这一种形状（没有子资源）：别的形状一律 404，
  //    否则 `/api/idea/3/archive` 会被当成「id=3 的详情」而**静默返回一份列表**。
  if (parts.length !== 3) return notFound(res);
  if (method === 'GET') {
    const it = store.getIdea(uid, id);
    if (!it) return notFound(res);
    return json(res, 200, it);
  }
  if (method === 'PUT') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      // ⚠️ 正文**带了就不许清空**：一条什么都不说的灵感在列表里就是一行认不出的空白
      //    （与硬件的名称、任务的标题同口径）
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
