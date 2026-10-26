/**
 * modules/hardware/routes.js —— NAS硬件管理路由（台账 / 愿望单 / 寿命预警）
 *
 * 功能：`handleHardware` 一处收全部硬件管理接口 —— 列表（含检索、状态与分类筛选、
 *      「只看需关注」与**汇总**）、新增、详情、编辑（含「买回来了」改状态）、删除。
 *
 * 说明：⭐ **硬件台账只属于账号本人**（设计要求），所以每一条带 id 的写操作都先过归属校验，
 *      越权与「不存在」统一 404（不给出「这条记录存在、只是不归你」这个探测信号）。
 *
 * 说明：⭐ 接口设计与收藏夹（`modules/bookmarks/routes.js`）同构（统一 `ctx` 参数表），
 *      鉴权由 `server.js` 的 401 闸门保证 —— `/api/hardware/*` 挂在闸门**之后**。
 *
 * ⚠️ **没有 `/api/hardware/summary` 这类接口**：汇总随列表一起返回（`store.list` 的
 *    `summary`）—— 少一次请求、少一处 401 分支，而且切换筛选时计数不会闪烁。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/routes/hardware.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了三处：① 相对路径；
 *    ② 导出键从 `handleHardware` 改成 **`hardware`**（= `module.json` 的 `apiPrefix`，
 *    `server.js` 据此自动挂到 `/api/hardware` 上）；③ 本段说明。处理函数体一个字没动。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.23
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/开发方案/04-NAS硬件管理-1期.md
 */
'use strict';

const { checkHardware, checkHardwareTemplate } = require('../../core/validate.js');
const { httpError, idParam, json, notFound, readBody, writeResult } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');

/**
 * 功能：处理 `/api/hardware` 及其子路径 —— 硬件台账的增删改查。
 *
 * 说明：路由表（`parts = ['api','hardware', …]`）——
 *      · `GET    /api/hardware?q=&status=&group=&focus=&sort=&desc=`  列表（检索 + 筛选 + 排序 + 汇总）
 *      · `POST   /api/hardware`                              新增 `{ name, … }`
 *      · `GET    /api/hardware/:id`                          详情（含 `life`）
 *      · `PUT    /api/hardware/:id`                          编辑（全部字段可选）
 *      · `DELETE /api/hardware/:id`                          删除
 *      · `POST   /api/hardware/templates`                    ⭐ 0.8.23：新建**自建模板** `{ name, fields }`
 *      · `PUT    /api/hardware/templates/:id`                改名 / 改字段（预制的只能追加属性）
 *      · `DELETE /api/hardware/templates/:id`                删除（预制的 ⇒ 400）
 *      ⚠️ 模板清单本身**没有单独的 GET** —— 它随 `GET /api/hardware` 的 `templates` 一起回。
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
function handleHardware({ req, res, parts, url, method, uid }) {
  // ---- 列表 / 新增 ----
  if (parts.length === 2) {
    if (method === 'GET') {
      // 筛选参数**不做校验式拦截**：`q` 是自由文本、`status` / `group` / `sort`
      // 不认识就当「不筛选 / 用默认排序」
      // （列表接口把参数打回 400 只会让用户对着一个空白页，而不是「没筛出来」）
      const p = (url && url.searchParams) || null;
      return json(
        res,
        200,
        store.listHardware(uid, {
          q: p ? p.get('q') || '' : '',
          status: p ? p.get('status') || '' : '',
          // ⭐ 0.8.10：分类筛选的入参由「自由文本 `category`」换成「分组 id `group`」——
          //    值来自 `GET /api/assets/groups` 里「数码管理」那一格下面的子树
          group: p ? p.get('group') || '' : '',
          focus: p ? p.get('focus') || '' : '',
          sort: p ? p.get('sort') || '' : '',
          // ⭐ 0.5.2：升 / 降序（「按 … 字段升序和降序排列」）。
          //    ⚠️ 查询串里是 `'0'` / `'1'` 字符串，`listHardware()` 按真值判 —— 这里原样传，
          //    ⛔ 不要 `Number()`：那会把没传（`null`）与 `'0'` 混成 0，方向判断就静默失效。
          desc: p ? p.get('desc') || '' : '',
        }),
      );
    }
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkHardware(b);
        // ⚠️ 名称是唯一的必填项，且**在这里**查（校验层只管「带了就校验」，
        //    这样编辑时「只改备注」不会被要求重发名称）—— 与收藏夹的 url 同一手法
        if (!fields.name) throw httpError(400, '名称不能为空');
        json(res, 201, store.createHardware(uid, fields));
      });
    }
    return notFound(res);
  }

  // ---- 模板（⭐⭐ 0.8.23，「预制新建硬件的模板菜单」）----
  // ⚠️⭐ 这一段**必须排在下面那句 `idParam(parts[2])` 之前**：`templates` 不是数字，
  //    `idParam('templates')` 回 `null` ⇒ 会被当成「这条记录不存在」直接 404，
  //    而且看着像产品坏了 —— 与 `assets` 那边 `groups/merge` 同一个坑、同一条处理。
  //    ⚠️ 「列表」不在这一组里：模板清单**随 `GET /api/hardware` 一起回**（`templates`），
  //    少一次请求、少一处 401 分支（与 `summary` / `sections` 同一条口径）。
  if (parts[2] === 'templates') {
    if (parts.length === 3) {
      if (method === 'POST') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const fields = checkHardwareTemplate(b);
          if (!fields.name) throw httpError(400, '模板名不能为空');
          json(res, 201, store.createHardwareTemplate(uid, fields));
        });
      }
      return notFound(res);
    }
    const tplId = idParam(parts[3]);
    if (tplId === null || parts.length !== 4) return notFound(res);
    // 越权与不存在统一 404（403 等于告诉对方「这个模板存在、只是不归你」）
    if (!store.ownsHardwareTemplate(uid, tplId)) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // ⚠️ 回**更新后的那一份**（不是 `writeResult` 的布尔）：界面要用手上这份就地重画，
        //    再打一次列表只为了拿它，纯属多一个来回
        json(res, 200, store.updateHardwareTemplate(uid, tplId, checkHardwareTemplate(b)));
      });
    }
    if (method === 'DELETE') return writeResult(res, store.removeHardwareTemplate(uid, tplId));
    return notFound(res);
  }

  // ---- 单条 ----
  const id = idParam(parts[2]);
  if (id === null) return notFound(res);
  // 越权与不存在统一 404（403 等于告诉对方「这条记录存在，只是不归你」）
  if (!store.ownsHardware(uid, id)) return notFound(res);
  if (method === 'GET' && parts.length === 3) {
    const h = store.getHardware(uid, id);
    if (!h) return notFound(res);
    return json(res, 200, h);
  }
  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      // ⚠️ 名称**带了就不许清空**：它是列表里唯一显示的东西，
      //    空名字的记录在界面上就是一行什么也认不出的空白（与任务的标题同口径）
      const fields = checkHardware(b);
      if (Object.prototype.hasOwnProperty.call(fields, 'name') && !fields.name) {
        throw httpError(400, '名称不能为空');
      }
      writeResult(res, store.updateHardware(uid, id, fields));
    });
  }
  if (method === 'DELETE' && parts.length === 3) return writeResult(res, store.removeHardware(uid, id));
  return notFound(res);
}

// ⭐ 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/hardware` 上
module.exports = { hardware: handleHardware };
