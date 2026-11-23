/**
 * modules/assets/routes.js —— 个人资产管理路由（分组树 / 通用条目）
 *
 * 功能：`handleAssets` 一处收全部接口 —— 分组树的列表 / 新增 / 详情 / 编辑 / 删除，
 * 以及通用条目的列表 / 新增 / 详情 / 编辑 / 删除。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.9.7
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
          // 名称是唯一的必填项，且**在这里**查（校验层只管「带了就校验」，
          // 这样编辑时「只改图标」不会被要求重发名称）
          if (!fields.name) throw httpError(400, '名称不能为空');
          json(res, 201, store.createAssetGroup(uid, fields));
        });
      }
      return notFound(res);
    }
    // 「把几个子类别合并到其中一个子类别中」——
    // 这条**必须排在下面那句 `idParam(parts[3])` 之前**：`merge` 不是数字，
    // `idParam('merge')` 回 `null` ⇒ 会被当成「这个分组不存在」直接 404（而且看着像产品坏了）。
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

// 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/assets` 上
module.exports = { assets: handleAssets };
