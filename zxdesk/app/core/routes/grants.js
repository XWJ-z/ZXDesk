'use strict';

/**
 * routes/grants.js —— **个人授权目录**的 HTTP 入口
 *
 * 功能：`GET /api/grants` 取清单（含每行的授权状态）、`POST /api/grants` 登记 / 刷新一条、
 *      `PUT /api/grants` 改用途备注、`DELETE /api/grants?path=…` 从清单里移除。
 *
 * ⭐⭐ 为什么这条前缀挂在**核心**（`LEGACY_API_ROUTES`）而不是某个模块：
 *      它是「我这台机器上授权过哪些目录」的**汇总**，服务的是**所有**要目录的功能
 *      （本轮是加密信息附件，将来还有别的）。挂进 `modules/secrets/` 的话，
 *      加密信息一关，设置里那份清单就没来源了。
 *
 * ⚠️⚠️ 身份只从网关 Header 来（`gatewayUser(req)`）：⛔ 不接受请求体里的任何 uid/fuid。
 *      这条与 `modules/secrets/routes.js` 那段**逐字同一口径** —— 授权是「飞牛用户对应用」
 *      的许可，用哪个飞牛身份去问，只由宿主自己注入的 Header 决定。
 * ⚠️ 本文件**只做参数整形与状态码**：判据（什么算授权、怎么算状态）全在
 *    `store/methods/grants.js`，这儿再写一遍必然漂移。
 *
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/2026-11-09-0.9.8-第11轮修改-回单.md
 */

const { json, notFound, readBody } = require('../http-util.js');
const { gatewayUser } = require('../gateway.js');
const { store, dataDir, DEFAULT_DIR } = require('../context.js');

/**
 * 功能：把业务层抛出来的错误统一转成 JSON 响应（`status` 缺省 500，`code` 原样带回）。
 * @param {Object} res - HTTP 响应
 * @param {Error} e - 业务层抛出的错误
 * @returns {void}
 */
function fail(res, e) {
  return json(res, (e && e.status) || 500, {
    error: (e && e.message) || '授权目录操作失败',
    code: (e && e.code) || '',
  });
}

/**
 * 功能：`/api/grants` 的唯一入口 —— 按方法分派四个动作。
 *
 * 说明：⚠️ `parts[2]` 目前**不允许**任何子路径（多一个片段就是 404）：
 *      路径本身走请求体 / 查询串里的 `path`，⛔ 不塞进 URL 路径段 ——
 *      目录名里可能有斜杠、空格与中文，编码一次就多一个坑。
 * @param {Object} ctx - 分派上下文 `{ req, res, parts, url, method, uid }`
 * @returns {void}
 */
function handleGrants(ctx) {
  const { req, res, parts, url, method, uid } = ctx;
  if (parts.length > 2) return notFound(res);
  const gw = gatewayUser(req);

  if (method === 'GET') {
    return store
      .dirGrantList(uid, gw)
      .then((r) => json(res, 200, Object.assign({ ok: true, gatewayUser: gw }, r)))
      .catch((e) => fail(res, e));
  }

  if (method === 'POST') {
    return readBody(req, res, (b) => {
      if (!b || !b.path) return json(res, 400, { error: '没有拿到目录路径', code: 'NO_PATH' });
      return store
        .dirGrantAuthorize(uid, b.path, gw, {
          purpose: b.purpose,
          source: b.source,
          pending: b.pending === true,
        })
        .then((r) => json(res, 200, Object.assign({ ok: true, gatewayUser: gw }, r)))
        .catch((e) => fail(res, e));
    });
  }

  if (method === 'PUT') {
    return readBody(req, res, (b) => {
      if (!b || !b.path) return json(res, 400, { error: '没有拿到目录路径', code: 'NO_PATH' });
      return store
        .dirGrantSetPurpose(uid, b.path, b.purpose, gw)
        .then((r) => json(res, 200, Object.assign({ ok: true, gatewayUser: gw }, r)))
        .catch((e) => fail(res, e));
    });
  }

  if (method === 'DELETE') {
    const p = String(url.searchParams.get('path') || '');
    if (!p) return json(res, 400, { error: '没有拿到目录路径', code: 'NO_PATH' });
    // ⭐ 「移除」会真的撤销飞牛里的授权 ⇒ 必须把**应用自己的数据目录**告诉业务层：
    //    撤掉它们的访问权，应用下一次启动就读不到库了（判据在 `store/methods/grants.js`）。
    return store
      .dirGrantRemove(uid, p, gw, { dataDirs: [dataDir, DEFAULT_DIR] })
      .then((r) => json(res, 200, Object.assign({ ok: true, gatewayUser: gw }, r)))
      .catch((e) => fail(res, e));
  }

  return notFound(res);
}

module.exports = { handleGrants };
