/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：routes/data-location.js
 * 职责：数据位置的 HTTP 入口（管理员四个动作 ＋ 未登录恢复引导六个动作）
 *
 * 功能：管理员侧 `check` / `apply` / `status` / `cancel`；未登录侧 `state` / `retry` / `adopt` /
 *      `restore` / `reset` / `reset-empty`。判据全在 `core/data-location.js`，本文件只做参数整形、鉴权与状态码。
 *
 * ⚠️⚠️ 未登录那六个动作能**直接改索引**（也就是改「应用下次从哪开库」），所以身份只认两件事：
 *      ① 请求从**统一网关的 Unix Socket** 进来；② 带网关注入的用户 Header（`X-Trim-Userid`）。
 *      局域网 TCP 直连一律只读展示 ＋ 提示「请到飞牛桌面或 App 里打开」——
 *      ⛔ 不能让 LAN 上任何人都能改数据位置。
 * ⚠️ 这些路由必须分派在 401 闸门**之前**（否则恢复页根本没法用），补偿手段就是上面那条来源检查。
 * ⚠️ 页面与接口一律**不返回完整路径**：路径里可能带用户名。展示只给末段，完整值只进启动日志。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
'use strict';

const path = require('node:path');
const dl = require('../data-location.js');
const { gatewayUser } = require('../gateway.js');
const { json, readBody } = require('../http-util.js');
const { getSharedAccessibleFolders, getUserAccessibleFolders } = require('../trim-api.js');
const { normPath } = require('../grant-path.js');
// ⭐ 授权树逐层浏览（与加密信息附件位置共用一份判据）
const { browseDirs, makeDir } = require('../grant-tree.js');
const { DEFAULT_DIR, PKGVAR, dataDir, locationState, logLine, repair, store } = require('../context.js');

/** 恢复引导页的静态资源（未登录可访问） */
const LOCATION_PAGE = '/location.html';

/**
 * 功能：判断这次请求是不是**从统一网关的 Unix Socket** 进来的。
 *
 * 说明：⭐ Unix 域套接字连接没有 `remoteAddress`（TCP 一定有），这是唯一可靠的区分方式；
 *      再叠加「网关身份 Header 存在」这一条，两个条件都成立才算数。
 * @param {Object} req - HTTP 请求
 * @returns {boolean} 是网关请求为 true
 */
function isGatewayRequest(req) {
  const sock = req && req.socket;
  if (!sock) return false;
  // Unix 域套接字：没有对端地址；TCP 一定有（"::ffff:127.0.0.1" 之类）
  if (sock.remoteAddress !== undefined && sock.remoteAddress !== '') return false;
  return !!gatewayUser(req);
}

/**
 * 功能：回一个「不是从网关进来」的拒绝（409，机器可读码 `NO_GATEWAY`）。
 * @param {Object} res - HTTP 响应
 * @returns {void}
 */
function rejectNoGateway(res) {
  return json(res, 409, {
    error: '请到飞牛桌面或 App 里打开本应用后再操作（局域网直连只能查看，不能改数据位置）',
    code: 'NO_GATEWAY',
  });
}

/**
 * 功能：把一条路径折成「只给末段」的展示值（⛔ 完整路径不出页面）。
 * @param {string} p - 绝对路径
 * @returns {string} 末段（空输入回空串）
 */
function tailOf(p) {
  const s = String(p || '');
  if (!s) return '';
  return path.basename(s) || s;
}

/**
 * 功能：把恢复态数据裁成「可以给未登录页面看」的形状。
 * @returns {Object} 不含完整路径的状态
 */
function publicState(req) {
  const st = locationState();
  const gw = req ? gatewayUser(req) : null;
  const viaGateway = req ? isGatewayRequest(req) : false;
  return {
    ok: true,
    // ⚠️ 恢复动作只有**管理员**能做：普通成员没有「授权目录」的权限，给了按钮只会点了被拒。
    //    `viaGateway` 用来区分「不在网关里」与「在网关里但不是管理员」——两种要说不同的话。
    viaGateway,
    isAdmin: !!(gw && gw.isAdmin),
    canAct: viaGateway && !!(gw && gw.isAdmin),
    mode: st.mode,
    reason: st.reason,
    reasonText: st.reasonText,
    currentTail: tailOf(st.current),
    hasCurrent: !!st.current,
    defaultHasDb: st.defaultHasDb,
    // ⭐ 「数据已删除，从空库重新开始」只在**确认数据真的不在了**时才出按钮：
    //    判据由 core 现查（默认位置无主库 / 无归档 / 无数据标识），⛔ 前端不自己拼条件。
    emptyReset: st.mode === 'repair' && dl.resetEmptyCheck({ defaultDir: DEFAULT_DIR }).ok,
    dataId: st.dataId,
    lastMove: st.lastMove
      ? { at: st.lastMove.at, fromTail: tailOf(st.lastMove.from), toTail: tailOf(st.lastMove.to) }
      : null,
    archives: (st.archives || []).map((a) => ({ name: a.name, bytes: a.bytes, at: a.at })),
  };
}

/**
 * 功能：取当前索引（恢复动作要往它上面追加 history）。
 * @returns {?Object} 索引对象
 */
function currentIndex() {
  return dl.readIndex(DEFAULT_DIR, PKGVAR).index;
}

/**
 * 功能：把索引里的当前数据位置更新成某个目录，并回一个「需要重启」的结果。
 * @param {string} target - 新位置
 * @param {string} action - 动作名（写进 history）
 * @param {string} by - 操作者（网关用户名）
 * @param {Object} res - HTTP 响应
 * @returns {void}
 */
function relocateAndReply(target, action, by, res) {
  const next = dl.relocateIndex({
    defaultDir: DEFAULT_DIR,
    pkgvar: PKGVAR,
    index: currentIndex(),
    current: target,
    action,
    by,
    log: logLine,
  });
  logLine('warn', `数据位置已由恢复引导页改为 ${target}（动作 ${action}，操作者 ${by || '未知'}）`);
  return json(res, 200, { ok: true, needRestart: true, currentTail: tailOf(next.current) });
}

/**
 * 功能：`/api/location/*` 的入口 —— 未登录可用的六个动作。
 * @param {Object} ctx - 分派上下文 `{ req, res, parts, url, method }`
 * @returns {void}
 */
function handleLocation(ctx) {
  const { req, res, parts, method } = ctx;
  const action = parts[2] || '';
  if (method === 'GET' && action === 'state') {
    return json(res, 200, publicState(req));
  }
  const allowed = new Set(['retry', 'adopt', 'restore', 'reset', 'reset-empty']);
  if (method !== 'POST' || !allowed.has(action)) {
    return json(res, 404, { error: '没有这个动作' });
  }
  if (!isGatewayRequest(req)) return rejectNoGateway(res);
  const gw = gatewayUser(req);
  // ⚠️ 光「在飞牛里」不够：改数据位置是**管理员**的动作（普通成员连授权页都没有入口）
  if (!gw || !gw.isAdmin) {
    return json(res, 403, {
      error: '只有管理员能修改数据位置，请联系管理员处理',
      code: 'NOT_ADMIN',
    });
  }
  const idx = currentIndex();
  /* ⭐ 出口：卸载删了数据、连标记也跟着没了（换机重装 / 手工清过目录）⇒
     三条修复路全都无解，必须给一条「从空库重新开始」。
     ⚠️ 四条闸门全在 `dl.resetEmpty()` 里现查，且**不在这里建库** —— 建库仍由启动流程做。
     ⚠️ 这是**不可逆**的动作（管理员密码要重设），所以只用 409 把「为什么不行」说清楚。 */
  if (action === 'reset-empty') {
    const r = dl.resetEmpty({ defaultDir: DEFAULT_DIR, pkgvar: PKGVAR, log: logLine });
    if (!r.ok) return json(res, 409, { error: r.message, code: r.code });
    logLine('warn', `恢复引导页按「数据已删除」重置了数据位置（操作者 ${gw && gw.username}）`);
    return json(res, 200, { ok: true, needRestart: true });
  }
  if (action === 'reset') {
    if (!dl.hasMainDb(DEFAULT_DIR)) {
      return json(res, 409, { error: '安装位置里没有可用的数据库，不能回到默认位置', code: 'NO_DB' });
    }
    return relocateAndReply(DEFAULT_DIR, 'reset', gw && gw.username, res);
  }
  return readBody(req, res, (b) => {
    const body = b || {};
    if (action === 'restore') {
      const name = String(body.zip || '');
      const archives = dl.listArchives(DEFAULT_DIR);
      if (!archives.some((a) => a.name === name)) {
        return json(res, 404, { error: '安装位置里没有这份备份', code: 'NO_ARCHIVE' });
      }
      const file = path.join(DEFAULT_DIR, name);
      let manifest;
      try {
        manifest = dl.readManifestOf(file);
      } catch (e) {
        return json(res, 409, { error: (e && e.message) || '这份备份读不出来', code: 'BAD_ARCHIVE' });
      }
      if (idx && manifest.dataId && String(manifest.dataId) !== String(idx.dataId)) {
        return json(res, 409, { error: '这份备份不是本应用当前这一套数据', code: 'DATA_ID_MISMATCH' });
      }
      if (dl.hasMainDb(DEFAULT_DIR)) {
        return json(res, 409, { error: '安装位置里已经有数据库，不能直接解压覆盖', code: 'DEFAULT_HAS_DB' });
      }
      return dl
        .restoreArchive(file, DEFAULT_DIR, manifest)
        .then(() => {
          dl.writeMarker(DEFAULT_DIR, manifest.dataId, dl.stampOf());
          return relocateAndReply(DEFAULT_DIR, 'restore', gw && gw.username, res);
        })
        .catch((e) => json(res, 500, { error: (e && e.message) || '恢复失败', code: 'RESTORE_FAILED' }));
    }
    // retry / adopt：两者判据相同（目录在 ＋ 标记对 ＋ 主库在 ＋ 能读写），差别只在 history 里的动作名
    const target = String(body.path || '');
    if (!target) return json(res, 400, { error: '没有拿到目录路径', code: 'NO_PATH' });
    const c = dl.adoptDir(target, idx || { dataId: '' });
    if (!c.ok) {
      return json(res, 409, {
        error: dl.REASON_TEXT[c.reason] || '这个目录不能用',
        code: c.reason,
        detail: c.detail || '',
      });
    }
    return relocateAndReply(target, action === 'adopt' ? 'relocated' : 'retry', gw && gw.username, res);
  });
}

/**
 * 功能：取「已授权目录」列表（个人授权 ＋ 应用共享授权，两个来源合起来）。
 * @param {number} uid - 飞牛用户 uid（只从网关 Header 来）
 * @returns {Promise.<Array.<string>>} 目录清单
 * @throws {Error} 网关不可达 / 无 token 时抛出（带 `code`）
 */
async function grantedDirs(uid) {
  const out = [];
  const push = (list) => {
    for (const p of list || []) if (p && !out.includes(p)) out.push(String(p));
  };
  push(await getSharedAccessibleFolders());
  push(await getUserAccessibleFolders(uid));
  return out;
}

/**
 * 功能：取 URL 的查询参数（`req.url` 自己解析，⛔ 不 `new URL` 造一个可能抛错的绝对地址）。
 * @param {Object} req - HTTP 请求
 * @returns {URLSearchParams} 查询参数
 */
function queryOf(req) {
  const u = String((req && req.url) || '');
  const i = u.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : u.slice(i + 1));
}

/**
 * 功能：列出**可以作为数据位置**的目录 —— 只含已授权的，并带上用户给它们写的备注。
 *
 * 说明：⭐ 备注来自授权登记表（`user_dir_grants`），列表来源来自宿主授权（`trim.file.*`）。
 *      两者按路径对齐：宿主授权里有、登记表里没有的（别人代授权 / 老数据）也要列出来，
 *      只是没有备注 —— ⛔ 不能因为「没备注」就把它藏起来。
 * @param {Object} gw - 网关身份
 * @returns {Promise.<Array.<{path: string, display: string, purpose: string}>>} 目录清单（含备注）
 * @throws {Error} 宿主授权查不到时抛出（带 `code`）
 */
async function listGrantDirs(gw) {
  const paths = await grantedDirs(gw.uid);
  let items;
  try {
    const list = await store.dirGrantList(gw.uid, gw);
    items = Array.isArray(list && list.items) ? list.items : [];
  } catch (_e) {
    // 备注是锦上添花：读不到就只显示路径，⛔ 不让整个列表变成错误
    items = [];
  }
  const byPath = new Map(items.map((it) => [normPath(it.path), it]));
  return paths.map((p) => {
    const it = byPath.get(normPath(p)) || {};
    return { path: p, display: String(it.display || p), purpose: String(it.purpose || '') };
  });
}

/**
 * 功能：`/api/admin/data-location/*` 的入口 —— 管理员四个动作（调用方已判定管理员）。
 * @param {Object} req - HTTP 请求
 * @param {Object} res - HTTP 响应
 * @param {Array.<string>} parts - URL 片段（`parts[3]` 是动作名）
 * @param {Object} user - 当前管理员账号
 * @returns {void} 无返回值（响应直接写出）
 */
function handleAdminLocation(req, res, parts, user) {
  const method = req.method;
  const action = parts[3] || '';
  // ⭐ 「修改位置」的候选目录：只列**已经授权给本应用**的目录（个人授权 ∪ 应用共享授权）。
  //    ⚠️ 与预检用的是**同一个来源**（`trim.file.*`）—— 从别处列出来的目录会通不过预检，
  //    表现就是「列表里能选、点了说没授权」。⛔ 别改成读 `/api/grants` 的清单。
  if (method === 'GET' && action === 'dirs') {
    if (!isGatewayRequest(req)) return rejectNoGateway(res);
    const gw = gatewayUser(req);
    const asked = queryOf(req).get('dir') || '';
    return browseDirs({ uid: gw.uid, dir: asked })
      .then(async (r) => {
        // 根层补备注：备注只登记在「授权根」上（子目录没有登记行，显示路径本身即可）
        let rows = r.dirs;
        if (!r.dir) {
          const meta = await listGrantDirs(gw).catch(() => []);
          const byPath = new Map(meta.map((it) => [normPath(it.path), it]));
          rows = rows.map((d) => {
            const it = byPath.get(normPath(d.path)) || {};
            return { path: d.path, name: d.name, display: String(it.display || d.path), purpose: String(it.purpose || '') };
          });
        }
        return json(res, 200, {
          ok: true,
          dir: r.dir,
          parent: r.parent,
          atRoot: r.atRoot,
          root: r.root,
          roots: r.roots,
          // ⭐ 「左右选择」左边那一列：从授权根逐级到当前目录
          trail: r.trail,
          dirs: rows,
          truncated: r.truncated,
        });
      })
      .catch((e) =>
        json(res, (e && e.status) || 409, {
          error: (e && e.message) || '查不到授权目录',
          code: (e && e.code) || 'TRIM_FAILED',
        }),
      );
  }
  if (method === 'GET' && action === 'status') {
    const st = dl.migrationStatus();
    return json(res, 200, {
      ok: true,
      freezing: dl.isFreezing(),
      phase: st ? st.phase : '',
      job: st,
      pendingRestart: !!st && st.phase === 'pendingRestart',
    });
  }
  if (method !== 'POST' || !['check', 'apply', 'cancel', 'mkdir'].includes(action)) {
    return json(res, 404, { error: '没有这个动作' });
  }
  if (action === 'cancel') {
    const ok = dl.cancelMigration();
    return json(res, ok ? 200 : 409, ok ? { ok: true } : { ok: false, error: '当前阶段不可取消' });
  }
  // 预检与搬迁都要求网关身份：授权列表只认网关注入的 uid
  if (!isGatewayRequest(req)) return rejectNoGateway(res);
  const gw = gatewayUser(req);
  return readBody(req, res, async (b) => {
    // ⭐ 在选目录的过程中直接建一个空文件夹：授权给你的目录往往都已经有东西了，
    //    而数据位置要求**空目录** —— 没有这一步，用户得先切到飞牛里建好再回来。
    if (action === 'mkdir') {
      try {
        const r = await makeDir({ uid: gw.uid, dir: String((b && b.parent) || ''), name: String((b && b.name) || '') });
        return json(res, 201, { ok: true, path: r.path, name: r.name });
      } catch (e) {
        return json(res, (e && e.status) || 409, {
          error: (e && e.message) || '新建文件夹失败',
          code: (e && e.code) || 'MKDIR_FAILED',
        });
      }
    }
    const target = String((b && b.path) || '');
    if (!target) return json(res, 400, { error: '没有拿到目录路径', code: 'NO_PATH' });
    let granted;
    try {
      granted = await grantedDirs(gw.uid);
    } catch (e) {
      return json(res, 409, { error: (e && e.message) || '查不到授权目录', code: (e && e.code) || 'TRIM_FAILED' });
    }
    const r = await dl.precheck({
      target,
      defaultDir: DEFAULT_DIR,
      dataDir,
      granted,
      store,
      skipZipTest: process.env.ZXDESK_SKIP_ZIP_TEST === '1',
    });
    if (!r.ok) return json(res, 409, { ok: false, error: r.message, code: r.code });
    if (action === 'check') return json(res, 200, { ok: true, info: r.info });
    let jobId;
    try {
      jobId = dl.startMigration({
        store,
        target: r.info.target,
        defaultDir: DEFAULT_DIR,
        pkgvar: PKGVAR,
        by: (gw && gw.username) || (user && user.username) || '',
        log: logLine,
      });
    } catch (e) {
      return json(res, 409, { error: (e && e.message) || '无法开始搬迁', code: (e && e.code) || 'BUSY' });
    }
    logLine('warn', `管理员「${(user && user.username) || ''}」开始把数据位置迁到 ${r.info.target}`);
    return json(res, 202, { ok: true, jobId });
  });
}

/**
 * 功能：恢复态下业务接口的统一拒绝体。
 * @param {Object} res - HTTP 响应
 * @param {string} [reason] - 原因码
 * @returns {void}
 */
function rejectUnavailable(res, reason) {
  return json(res, 503, { error: 'data_location_unavailable', reason: reason || (repair && repair.reason) || '' });
}

module.exports = {
  LOCATION_PAGE,
  isGatewayRequest,
  handleLocation,
  handleAdminLocation,
  publicState,
  rejectUnavailable,
};
