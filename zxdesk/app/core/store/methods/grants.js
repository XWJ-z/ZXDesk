'use strict';

/**
 * store/methods/grants.js —— **个人授权目录**的业务方法
 * 功能：把「我授权过哪些目录」这件事变成一份**可读、可查状态、可备注**的清单：
 * `dirGrantList()` 给出清单 ＋ 每一行当前的授权状态；
 * `dirGrantAuthorize()` 在校验过宿主授权列表之后登记 / 刷新一行；
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/2026-11-09-0.9.8-第11轮修改-回单.md
 */

const fs = require('node:fs');
const trimApi = require('../../trim-api.js');
const { nowStamp, badRequest } = require('../helpers.js');
const { normPath, isGranted } = require('../../grant-path.js');

/** 用途备注的长度上限（够写一句「加密信息的附件」；再长设置页那一行就换行了） */
const PURPOSE_MAX = 40;

/**
 * 功能：撤销失败时那句话 —— **去哪移除**只有一处（飞牛的应用访问权限）。
 *
 * 说明：⭐ 两套文案逐字进测试（`grants.test.js` ⑧）：
 *      管理员自己去移除；普通成员没有那个权限，只能找管理员。
 * @param {?Object} gwUser - 网关身份（`gatewayUser(req)`）
 * @returns {string} 一句话
 */
function revokeRefusedText(gwUser) {
  return gwUser && gwUser.isAdmin
    ? '请到 应用中心-ZXDesk工作台-应用设置-访问权限 中移除'
    : '请联系飞牛管理员到 应用中心-ZXDesk工作台-应用设置-访问权限 中移除处理';
}

/**
 * 功能：在授权列表里找出**把这个路径带进来的**那条（最长前缀的那一条）。
 * @param {string} abs - 目录
 * @param {Array.<string>} paths - 授权列表
 * @returns {string} 覆盖它的那条授权；找不到返回空串
 */
function coveringGrantOf(abs, paths) {
  const p = normPath(abs);
  let best = '';
  for (const g of Array.isArray(paths) ? paths : []) {
    const base = normPath(g);
    if (!base || base === p) continue;
    const covers = base === '/' || p.startsWith(`${base}/`);
    if (covers && base.length > best.length) best = base;
  }
  return best;
}

/**
 * 功能：页面上那一行的状态短名 —— 三个值，含义见文件头。
 * @type {{NORMAL: string, LOST: string, NONE: string, UNKNOWN: string}}
 */
const STATUS = {
  NORMAL: 'normal',
  /** 需重新授权：登记过、现在宿主列表里没有 */
  LOST: 'lost',
  /** 未授权：登记过、但从来没有成功授权过 */
  NONE: 'none',
  /** 读不到宿主授权列表（网关不可达 / 没有飞牛身份）：**不是**「没授权」，别混成一个说法 */
  UNKNOWN: 'unknown',
};

module.exports = {
  /**
   * 功能：本账号「**当初真的向飞牛核过授权**、现在也确实读得到」的目录 —— 直连端的授权根来源。
   * 说明：⭐⭐ 为什么需要它：飞牛的授权清单只能拿**网关注入的 uid** 去查（`trim.file.*`），
   *      而安卓客户端 / 局域网直连 / Windows 版都不经过网关 ⇒ 它们永远查不到清单 ⇒
   *      「选附件位置」在那些端上变成永远列不出任何目录（真机：飞牛 App 里能看到授权目录，
   * @param {number} uid - 本应用账号 id
   * @returns {Array.<string>} 目录绝对路径（已去重）
   */
  dirGrantRoots(uid) {
    let rows;
    try {
      rows = this._bk.listDirGrants(Number(uid));
    } catch (_e) {
      return []; // 表还没建 / 库不可用：不是「授权丢了」，这里静默给空
    }
    const out = [];
    for (const r of rows || []) {
      if (!r || !r.granted_at) continue;
      const p = normPath(String(r.path || ''));
      if (!p || out.includes(p)) continue;
      try {
        if (!fs.statSync(p).isDirectory()) continue;
        fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
      } catch (_e) {
        continue; // 目录不在了 / 读不了：自然从列表里消失，不需要额外的状态字段
      }
      out.push(p);
    }
    return out;
  },

  /**
   * 功能：列出该账号的授权目录清单，并给每一行算当前状态。
   * 说明：⭐⭐ 「算状态」这件事每次**现算**、⛔ 不把结论落库 —— 落库的结论一定过期，
   *      而用户点开设置页的这一刻，正是他想知道「现在到底还能不能用」的那一刻。
   * @param {number} uid - 账号 id
   * @param {?Object} gwUser - 网关身份（`gatewayUser(req)` 的结果，可能为 null）
   * @returns {Promise.<{items: Array.<Object>, reachable: boolean, code: string, message: string, counts: Object}>}
   */
  async dirGrantList(uid, gwUser) {
    const u = Number(uid);
    const rows = this._bk.listDirGrants(u);
    const granted = await this.grantedDirsOf(u, gwUser, false, rows);
    // ⭐ 旧数据的兜底：加密信息早就配好附件目录、但这张表是后加的 ——
    //    不合成这一条，升级上来的用户会看到「一个授权目录都没有」，而附件其实能用。
    const legacy = this.legacySecretsGrant(u, rows);
    const all = legacy ? rows.concat([legacy]) : rows;
    // 语义化路径：转不出来的原样显示（⛔ 不自己压 `…/末两段`）
    const dm = await trimApi.convertPaths(all.map((r) => String(r.path))).catch(() => new Map());
    const items = all.map((r) => this.grantItemOf(r, granted, dm));
    const counts = { normal: 0, lost: 0, none: 0, unknown: 0 };
    items.forEach((it) => {
      counts[it.status] = (counts[it.status] || 0) + 1;
    });
    return {
      items,
      reachable: granted.reachable,
      code: granted.reachable ? '' : granted.code,
      message: granted.reachable ? '' : granted.message,
      counts,
    };
  },

  /**
   * @param {number} uid - 账号 id
   * @param {string} path - 目录绝对路径
   * @param {?Object} gwUser - 网关身份
   * @param {{purpose?: string, source?: string, pending?: boolean}} [opts] - 用途备注 / 申请方 /
   * @returns {Promise.<Object>} `dirGrantList()` 的结果（省一次往返）
   * @throws {Error} 路径非法（400）、不在授权范围（400）、读不到授权信息（409）
   */
  async dirGrantAuthorize(uid, path, gwUser, opts) {
    this._assertWritable();
    const o = opts || {};
    const abs = normPath(path);
    if (!abs || abs[0] !== '/') throw badRequest('没有拿到目录路径 —— 请重新选一次');
    if (o.pending !== true) {
      // ⚠️ 先取「不清缓存」的那一份：它就是**点选择器之前**的快照，用来判断这次是「新授权」
      //    还是「本来就有」。没有它，「拒绝登记」之后我们不知道该不该撤销宿主那条 ——
      //    而误撤一条本来就在的授权，可能把数据位置的访问权一起撤掉。
      const before = await this.grantedDirsOf(Number(uid), gwUser, false);
      const granted = await this.grantedDirsOf(Number(uid), gwUser, true);
      if (!granted.reachable) {
        throw Object.assign(new Error(granted.message || '暂时读不到飞牛的授权信息，请稍后再试'), {
          code: 'TRIM_UNREACHABLE',
          status: 409,
        });
      }
      if (!isGranted(abs, granted.paths)) {
        throw badRequest(
          '这个目录不在已授权范围内 —— 请到 飞牛 设置 → 应用 → ZXDesk → 访问权限 里授权它（或它的上层目录）',
        );
      }
      await this.assertNoParentOfLiveGrant(Number(uid), abs, before, granted);
    }
    const now = nowStamp();
    const prev = this._bk.listDirGrants(Number(uid)).find((r) => normPath(r.path) === abs);
    this._bk.saveDirGrant(Number(uid), {
      path: abs,
      purpose: String(o.purpose == null ? (prev && prev.purpose) || '' : o.purpose).slice(0, PURPOSE_MAX),
      source: String(o.source || (prev && prev.source) || ''),
      granted_at: o.pending === true ? (prev && prev.granted_at) || null : now,
      checked_at: now,
      created_at: (prev && prev.created_at) || now,
      updated_at: now,
    });
    return this.dirGrantList(Number(uid), gwUser);
  },

  /**
   * @param {number} uid - 账号 id
   * @param {string} path - 目录绝对路径
   * @param {string} purpose - 新的用途备注（可为空串 ＝ 清掉）
   * @param {?Object} gwUser - 网关身份（只为返回整份清单时复用，不参与判定）
   * @returns {Promise.<Object>} `dirGrantList()` 的结果
   * @throws {Error} 没找到该路径（404）
   */
  async dirGrantSetPurpose(uid, path, purpose, gwUser) {
    this._assertWritable();
    const abs = normPath(path);
    const prev = this._bk.listDirGrants(Number(uid)).find((r) => normPath(r.path) === abs);
    if (!prev) throw Object.assign(new Error('没有这条授权目录记录（可能已经在另一处删掉了）'), { status: 404 });
    const now = nowStamp();
    this._bk.saveDirGrant(Number(uid), {
      // ⚠️ `granted_at` 原样带回去：后端那条 upsert 用的是「旧值优先」，这里再显式传一次
      //    是为了让「两个后端语义一致」这件事在调用点上就能读懂（JSON 后端没有 SQL 的 COALESCE）
      path: abs,
      purpose: String(purpose == null ? '' : purpose).slice(0, PURPOSE_MAX),
      source: String(prev.source || ''),
      granted_at: prev.granted_at || null,
      checked_at: prev.checked_at || null,
      created_at: prev.created_at || now,
      updated_at: now,
    });
    return this.dirGrantList(Number(uid), gwUser);
  },

  /**
   * @param {number} uid - 账号 id
   * @param {string} path - 目录绝对路径
   * @param {?Object} gwUser - 网关身份
   * @param {{dataDirs?: Array.<string>}} [opts] - 应用自己的数据目录（数据库所在处，不许被撤）
   * @returns {Promise.<Object>} `dirGrantList()` 的结果（可能多一个 `note`）
   * @throws {Error} 数据目录（409 `DATA_DIR_PROTECTED`）、撤销失败或没生效（409 `REVOKE_*`）
   */
  async dirGrantRemove(uid, path, gwUser, opts) {
    this._assertWritable();
    const abs = normPath(path);
    const guard = this.grantRemoveGuard(abs, (opts && opts.dataDirs) || []);
    if (!guard.ok) {
      throw Object.assign(new Error(guard.message), { code: guard.code, status: 409 });
    }
    try {
      await trimApi.delUserAccessibleFolder(Number(uid), abs);
    } catch (e) {
      throw Object.assign(new Error(`没能撤销飞牛里的授权：${(e && e.message) || e}`), {
        code: 'REVOKE_FAILED',
        status: (e && e.status) || 409,
      });
    }
    // ⭐ 复核：宿主那边真的不在了才算撤掉
    const after = await this.grantedDirsOf(Number(uid), gwUser, true);
    if (!after.reachable) {
      throw Object.assign(new Error('撤销请求已发出，但读不到飞牛的确认结果 —— 请稍后点【刷新】再看一眼'), {
        code: 'REVOKE_UNVERIFIED',
        status: 409,
      });
    }
    if (isGranted(abs, after.paths)) {
      // ⭐⭐ 「还在」要分成两种，否则会把一条**本来就没自己那条授权**的登记（它是靠上级目录被带着的）
      const exact = after.paths.some((p) => normPath(p) === abs);
      const shared = await this.grantedSharedSafe();
      const byShared = shared.ok && isGranted(abs, shared.paths);
      if (!exact && !byShared) {
        // 它自己那条已经撤掉了 ⇒ 可以删登记。仍然能访问是因为**上级目录**被授权（那是另一条授权，
        // 用户要去飞牛里撤它，⛔ 不是这条行负责的事）—— 必须**说出来**，否则他会以为权限已经收回。
        this._bk.deleteDirGrant(Number(uid), abs);
        const up = coveringGrantOf(abs, after.paths);
        const out = await this.dirGrantList(Number(uid), gwUser);
        out.note =
          `已从清单移除。注意：${up ? `「${up}」` : '上级目录'}仍然授权给本应用，` +
          '所以这个文件夹还能被访问 —— 要收回请到 应用中心-ZXDesk工作台-应用设置-访问权限 里移除那条上级授权。';
        return out;
      }
      throw Object.assign(new Error(revokeRefusedText(gwUser)), { code: 'REVOKE_REFUSED', status: 409 });
    }
    this._bk.deleteDirGrant(Number(uid), abs);
    return this.dirGrantList(Number(uid), gwUser);
  },

  /**
   * 功能：判「这个目录的授权能不能移除」—— 放着应用自己的数据目录时 ⛔ 不许撤。
   * 说明：⭐⭐ 撤销的是**访问权**：把数据目录（数据库所在处）的授权撤掉之后，
   *      应用自己下一次启动就读不到库了 —— 那看起来像「数据没了」，用户唯一的出路是重新授权。
   * @param {string} abs - 要撤的目录
   * @param {Array.<string>} dirs - 应用自己的数据目录（当前数据位置 ＋ 安装位置）
   * @returns {{ok: boolean, code: string, message: string}} 结论
   */
  grantRemoveGuard(abs, dirs) {
    const p = normPath(abs);
    for (const d of Array.isArray(dirs) ? dirs : []) {
      const dd = normPath(d);
      if (!dd) continue;
      const covers = p === '/' || dd === p || dd.startsWith(`${p}/`);
      if (!covers) continue;
      return {
        ok: false,
        code: 'DATA_DIR_PROTECTED',
        message:
          '这个目录里放着 ZXDesk 的数据库（数据位置），撤掉它的授权之后应用自己就读不到数据了 —— ' +
          '请先到 设置 → 数据存放 把数据位置改到别处，再回来移除这里的授权',
      };
    }
    return { ok: true, code: '', message: '' };
  },

  /**
   * @param {number} uid - 账号 id
   * @param {string} abs - 这次要授权的目录
   * @param {{paths: Array.<string>, reachable: boolean}} before - 点选择器之前的宿主授权列表
   * @param {{paths: Array.<string>}} after - 现在（已含这次选中）的宿主授权列表
   * @returns {Promise.<void>} 通过则什么都不做
   * @throws {Error} 有存活的子目录授权时抛 409 `HAS_CHILD_GRANT`（并撤销刚产生的那条授权）
   */
  async assertNoParentOfLiveGrant(uid, abs, before, after) {
    if (!before || !before.reachable) return;
    if (isGranted(abs, before.paths)) return;
    if (!isGranted(abs, after.paths)) return;
    const live = this._bk
      .listDirGrants(Number(uid))
      .map((r) => normPath(r.path))
      .filter((p) => p && p !== abs && isGranted(p, [abs]))
      .filter((p) => isGranted(p, after.paths));
    if (!live.length) return;
    // ⭐ 撤销刚产生的这次授权：不撤的话「拒绝登记」只是清单里看不见，权限面其实已经放大到整棵子树
    let revoked = true;
    try {
      await trimApi.delUserAccessibleFolder(Number(uid), abs);
    } catch (_e) {
      revoked = false;
    }
    const child = live[0].split('/').filter(Boolean).pop() || live[0];
    throw Object.assign(
      new Error(
        `这个位置不能授权：它下面已经授权过「${child}」，授权上级等于把整棵子树的权限一起放开。` +
          `请先在清单里移除「${child}」的授权，再回来授权这里。` +
          (revoked ? '（刚才这次授权已自动撤销）' : '（刚才那次授权没能自动撤销，请到飞牛里手动移除）'),
      ),
      { code: 'HAS_CHILD_GRANT', status: 409 },
    );
  },

  // ==========================================================================================
  // 内部工具（**不是** HTTP 接口，别在路由里直接调）
  // ==========================================================================================

  /**
   * 功能：问一次宿主的授权列表 —— 分成「应用共享」与「用户个人」两组，各自可能查不到。
   * 说明：⚠️ 两组**分别**返回 `ok`，由调用方决定怎么合并：只有两组都失败才算「问不到」。
   * @param {number} uid - 账号 id（飞牛用户 id，来自网关 Header）
   * @param {?Object} gwUser - 网关身份；为空时用户那一组必然查不到
   * @param {boolean} [fresh] - 是否先作废 30 秒缓存（刚点完选择器时必须为真）
   * @returns {Promise.<{paths: Array.<string>, reachable: boolean, code: string, message: string}>} 合并后的授权目录
   */
  async grantedDirsOf(uid, gwUser, fresh, localRows) {
    const owner = gwUser && Number.isInteger(Number(gwUser.uid)) ? gwUser : null;
    if (fresh) trimApi.invalidate(owner ? Number(owner.uid) : null);
    const shared = await this.grantedSharedSafe();
    const user = owner ? await this.grantedUserSafe(Number(owner.uid)) : { paths: [], ok: false, code: '', message: '' };
    // ⭐ 直连端（无网关身份）：飞牛的个人授权清单只认 `X-Trim-Userid`，这一路查不到
    //    ⇒ 用本机已登记的那些补上，否则「飞牛里授过、安卓 App 说失效」。
    //    ⚠️ 有网关身份时⛔ 不并：并在那里就等于「飞牛撤销了还能浏览」。
    if (!owner && Array.isArray(localRows)) {
      const local = localRows
        .filter((r) => r && r.granted_at)
        .map((r) => normPath(String(r.path || '')))
        .filter(Boolean);
      if (local.length) {
        return {
          paths: [...new Set([...(shared.ok ? shared.paths : []), ...local])],
          reachable: true,
          code: '',
          message: '',
          source: 'local',
        };
      }
    }
    if (!shared.ok && !user.ok) {
      const bad = !shared.ok ? shared : user;
      return {
        paths: [],
        reachable: false,
        code: bad.code || 'TRIM_UNREACHABLE',
        message: bad.message || '暂时读不到飞牛的授权信息（网关可能刚重启），请稍后点【刷新】再试',
      };
    }
    return {
      paths: [...(shared.ok ? shared.paths : []), ...(user.ok ? user.paths : [])],
      reachable: true,
      code: '',
      message: '',
    };
  },

  /**
   * 功能：查「应用共享授权」的目录列表，失败时只回原因、不抛。
   * @returns {Promise.<{paths: Array.<string>, ok: boolean, code: string, message: string}>} 结果
   */
  async grantedSharedSafe() {
    try {
      return { paths: await trimApi.getSharedAccessibleFolders(), ok: true, code: '', message: '' };
    } catch (e) {
      return { paths: [], ok: false, code: (e && e.code) || '', message: (e && e.message) || '' };
    }
  },

  /**
   * 功能：查「某个飞牛用户个人授权」的目录列表，失败时只回原因、不抛。
   * @param {number} fu - 飞牛用户 id
   * @returns {Promise.<{paths: Array.<string>, ok: boolean, code: string, message: string}>} 结果
   */
  async grantedUserSafe(fu) {
    try {
      return { paths: await trimApi.getUserAccessibleFolders(fu), ok: true, code: '', message: '' };
    } catch (e) {
      return { paths: [], ok: false, code: (e && e.code) || '', message: (e && e.message) || '' };
    }
  },

  /**
   * 功能：把一行登记算成界面要的形状（含状态与「目录还在不在」）。
   * @param {Object} row - 登记行
   * @param {{paths: Array.<string>, reachable: boolean}} granted - 宿主授权列表
   * @param {Map.<string, string>} dm - 语义化路径表
   * @returns {Object} 界面用的条目
   */
  grantItemOf(row, granted, dm) {
    const p = String(row.path || '');
    let status;
    if (!granted.reachable) status = STATUS.UNKNOWN;
    else if (!row.granted_at && !row.legacy) status = STATUS.NONE;
    else status = isGranted(p, granted.paths) ? STATUS.NORMAL : STATUS.LOST;
    /** 目录本身还在不在（⛔ 不改变授权状态：一个是授权问题，一个是文件问题） @type {boolean} */
    let exists;
    try {
      exists = !!p && fs.statSync(p).isDirectory();
    } catch (_e) {
      exists = false;
    }
    return {
      path: p,
      display: String(dm.get(p) || p),
      purpose: String(row.purpose || ''),
      source: String(row.source || ''),
      status,
      path_exists: exists,
      // ⚠️ 这两个时间只用于展示「什么时候给的 / 上次确认是什么时候」，⛔ 不参与判定
      granted_at: row.granted_at || '',
      checked_at: row.checked_at || '',
    };
  },

  /**
   * 功能：把「加密信息里早就配好的附件目录」合成成一条**登记行**（只在本轮还没登记过它时）。
   * 说明：⭐⭐ 这张表是后加的，而附件目录早就存在 —— 不合成的话，
   *      升级上来的用户在设置里看到「一个授权目录都没有」，可加密信息照常能用，两处自相矛盾。
   * @param {number} uid - 账号 id
   * @param {Array.<Object>} rows - 已登记的清单（用来判重）
   * @returns {?Object} 合成行；不需要合成时返回 null
   */
  legacySecretsGrant(uid, rows) {
    if (typeof this._bk.getSecretRootInfo !== 'function') return null;
    let info;
    try {
      info = this._bk.getSecretRootInfo(Number(uid));
    } catch (_e) {
      return null; // 表还没建 / 实验室库不可用：这不是「授权丢了」，静默跳过
    }
    const p = normPath(info && info.root);
    if (!p) return null;
    if ((rows || []).some((r) => normPath(r.path) === p)) return null;
    return {
      path: p,
      purpose: '加密信息的附件',
      source: 'secrets',
      // ⭐ 这一格只表示「它曾经被配过」：真正的状态由 `grantItemOf()` 按宿主列表算
      legacy: true,
      granted_at: (info && info.authorized_at) || 'legacy',
      checked_at: '',
      created_at: (info && info.authorized_at) || '',
      updated_at: '',
    };
  },
};
