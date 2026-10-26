/**
 * modules/assets/routes.js —— 个人资产管理路由（分组树 / 通用条目）
 *
 * 功能：`handleAssets` 一处收全部接口 —— 分组树的列表 / 新增 / 详情 / 编辑 / 删除，
 *      以及通用条目的列表 / 新增 / 详情 / 编辑 / 删除。
 *
 * 说明：⭐ **分组与条目都只属于账号本人**（设计要求），所以每一条带 id 的写操作都先过归属校验，
 *      越权与「不存在」统一 404（403 等于告诉对方「这条记录存在、只是不归你」）。
 *
 * ⚠️ **没有 `/api/assets/summary` 这类接口**：分组计数随树的列表一起返回（`store.listAssetGroups`
 *    的 `counts`）—— 少一次请求、少一处 401 分支，而且切分组时数字不会闪烁。
 *
 * ⭐ 路由表（`parts = ['api','assets', …]`）——
 *      · `GET    /api/assets/groups?`               分组树（展平、父在前、带条目计数）
 *      · `POST   /api/assets/groups`                新增 `{ name, parent_id?, icon? }`
 *      · `POST   /api/assets/groups/merge`          ⭐ 0.8.10：合并 `{ ids: [...], into }`
 *      · `GET    /api/assets/groups/:id`            一个分组
 *      · `PUT    /api/assets/groups/:id`            改名 / 图标 / 顺序
 *      · `DELETE /api/assets/groups/:id`            删除（子树一起、条目只解绑）
 *      · `GET    /api/assets/items?group_id=`       条目列表（不带 `group_id` = 全部）
 *      · `POST   /api/assets/items`                 新增 `{ name, group_id?, amount_fen?, date?, note? }`
 *      · `GET    /api/assets/items/:id`             一条条目
 *      · `PUT    /api/assets/items/:id`             编辑（`group_id` 传空 = 解绑）
 *      · `DELETE /api/assets/items/:id`             删除
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.10
 * 相关：docs/公共/架构文档/26-个人资产管理.md、docs/公共/开发方案/30-个人资产管理.md
 */
'use strict';

const { checkAssetGroup, checkAssetGroupMerge, checkAssetItem } = require('../../core/validate.js');
const { httpError, idParam, json, notFound, readBody, writeResult } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');

/**
 * 功能：处理 `/api/assets` 及其子路径 —— 分组树与通用条目的增删改查。
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
function handleAssets({ req, res, parts, url, method, uid }) {
  const kind = parts[2];

  // ---- 分组树 ----
  if (kind === 'groups') {
    if (parts.length === 3) {
      if (method === 'GET') return json(res, 200, store.listAssetGroups(uid));
      if (method === 'POST') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const fields = checkAssetGroup(b);
          // ⚠️ 名称是唯一的必填项，且**在这里**查（校验层只管「带了就校验」，
          //    这样编辑时「只改图标」不会被要求重发名称）
          if (!fields.name) throw httpError(400, '名称不能为空');
          json(res, 201, store.createAssetGroup(uid, fields));
        });
      }
      return notFound(res);
    }
    // ⭐⭐ 0.8.10：「把几个子类别合并到其中一个子类别中」——
    //    ⚠️⭐ 这条**必须排在下面那句 `idParam(parts[3])` 之前**：`merge` 不是数字，
    //    `idParam('merge')` 回 `null` ⇒ 会被当成「这个分组不存在」直接 404（而且看着像产品坏了）。
    //    ⚠️ 写完把**最新那棵树**给回去（`{groups, counts}`，同 `GET` 的形状）——
    //    界面那一步本来就要重画左栏与下拉，一个来回就够。
    if (parts.length === 4 && parts[3] === 'merge' && method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const f = checkAssetGroupMerge(b);
        store.mergeAssetGroups(uid, f.ids, f.into);
        json(res, 200, store.listAssetGroups(uid));
      });
    }
    const id = idParam(parts[3]);
    if (id === null) return notFound(res);
    // 越权与不存在统一 404
    if (!store.ownsAssetGroup(uid, id)) return notFound(res);
    if (method === 'GET' && parts.length === 4) {
      const g = store.getAssetGroup(uid, id);
      if (!g) return notFound(res);
      return json(res, 200, g);
    }
    if (method === 'PUT' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // ⚠️ 名称**带了就不许清空**：它是界面上唯一显示的东西
        const fields = checkAssetGroup(b);
        if (Object.prototype.hasOwnProperty.call(fields, 'name') && !fields.name) {
          throw httpError(400, '名称不能为空');
        }
        writeResult(res, store.updateAssetGroup(uid, id, fields));
      });
    }
    if (method === 'DELETE' && parts.length === 4) return writeResult(res, store.removeAssetGroup(uid, id));
    return notFound(res);
  }

  // ---- 通用条目 ----
  if (kind === 'items') {
    if (parts.length === 3) {
      if (method === 'GET') {
        const p = (url && url.searchParams) || null;
        const g = p ? p.get('group_id') : '';
        return json(res, 200, store.listAssetItems(uid, g === null || g === '' ? null : g));
      }
      if (method === 'POST') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const fields = checkAssetItem(b);
          if (!fields.name) throw httpError(400, '名称不能为空');
          json(res, 201, store.createAssetItem(uid, fields));
        });
      }
      return notFound(res);
    }
    const id = idParam(parts[3]);
    if (id === null) return notFound(res);
    if (!store.ownsAssetItem(uid, id)) return notFound(res);
    if (method === 'GET' && parts.length === 4) {
      const it = store.getAssetItem(uid, id);
      if (!it) return notFound(res);
      return json(res, 200, it);
    }
    if (method === 'PUT' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkAssetItem(b);
        if (Object.prototype.hasOwnProperty.call(fields, 'name') && !fields.name) {
          throw httpError(400, '名称不能为空');
        }
        writeResult(res, store.updateAssetItem(uid, id, fields));
      });
    }
    if (method === 'DELETE' && parts.length === 4) return writeResult(res, store.removeAssetItem(uid, id));
    return notFound(res);
  }

  return notFound(res);
}

// ⭐ 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/assets` 上
module.exports = { assets: handleAssets };
