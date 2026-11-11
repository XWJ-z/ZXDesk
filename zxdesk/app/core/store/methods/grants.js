'use strict';

/**
 * store/methods/grants.js —— **个人授权目录**的业务方法
 *
 * 功能：把「我授权过哪些目录」这件事变成一份**可读、可查状态、可备注**的清单：
 *      `dirGrantList()` 给出清单 ＋ 每一行当前的授权状态；
 *      `dirGrantAuthorize()` 在校验过宿主授权列表之后登记 / 刷新一行；
 *      `dirGrantSetPurpose()` 改用途备注；`dirGrantRemove()` 撤销宿主授权并删掉登记（⛔ 不碰文件）。
 *
 * 两条限制（判据都在本文件，⛔ 别在页面里再写一份）：
 *   · **不能授权已有子目录授权的上级目录** —— 那等于把权限面一次放大到整棵子树，
 *     只能先移除子目录的授权再授权上级（`assertNoParentOfLiveGrant()`）；
 *   · **不能移除放着数据库的目录的授权** —— 撤掉之后应用自己就读不到库了，
 *     只能先把数据位置改到别处（`grantRemoveGuard()`）。
 *
 * ⭐⭐ 为什么需要这一层（卸载重装过后授权也会丢失，必须提醒用户重新授权）：
 *      飞牛的目录授权**只在宿主机上、只在当时可查**，而且**没有历史** —— 应用一重装，
 *      授权就没了，用户看到的只是「原本能用的功能突然说没有目录」。宿主给不了「你曾经授权过什么」，
 *      那就只能由我们自己记一笔（表 `user_dir_grants`），再拿宿主的**当前**列表跟它比对：
 *        · 记过、现在还在 ⇒ `normal`（正常）
 *        · 记过、现在没了 ⇒ `lost`（**需重新授权** —— 授权丢失 / 卸载重装都落在这里）
 *        · 没记过        ⇒ `none`（未授权）
 *      所以「需重新授权」不是一个额外状态，而是**这张表存在的原因**。
 *
 * ⚠️ 状态里的 `none` 本轮不会由界面产生（页面上的新增入口是「选目录授权」，
 *    选完就是 `normal`）。它留给两种真实情况：① 模块**先申请**目录、用户还没给（`pending:true` 的登记）；
 *    ② 历史脏数据（`granted_at` 为空的旧行）。两种都必须显示成「未授权 / 点击授权」而不是崩掉，
 *    所以这个分支要留着 —— 它不是死代码。
 *
 * ⚠️ 本文件自己**不发起**授权，但会**撤销**授权：`dirGrantRemove()` 会调
 *    `trim.file.delUserAccessibleFolder` 真的把宿主那条授权撤掉 —— 「移除」如果只删我们这一行，
 *    用户会看到「清单里没了、飞牛里还在」（2026-11-11 真机反馈），那等于骗人。
 *    ⛔ 撤销之后必须**复核**：宿主那边还在就报错并把登记行留着，⛔ 不许「本地删了、日志说成了」。
 *
 * ⚠️ 本表**不进个人备份**（`exportAll` 只带 users）：它是本机环境状态，不是用户内容。
 *    整体备份会带上（`exportWhole()` 按表名清单遍历，见 core.js 里那张表的说明）。
 *
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
   * 功能：列出该账号的授权目录清单，并给每一行算当前状态。
   *
   * 说明：⭐⭐ 「算状态」这件事每次**现算**、⛔ 不把结论落库 —— 落库的结论一定过期，
   *      而用户点开设置页的这一刻，正是他想知道「现在到底还能不能用」的那一刻。
   *      ⚠️ 两组授权列表（应用共享 ＋ 用户个人）都要查：目录可能是管理员在应用级给的，
   *      也可能用户自己在选择器里给的，只查一组会把另一组误判成 `lost`。
   *      ⚠️ 两组都查不到 ⇒ 整份清单标 `unknown` ＋ 一句原因：这时候说「需重新授权」是**假消息**
   *      （人会跑去飞牛里授权，而那里明明配好了）。
   * @param {number} uid - 账号 id
   * @param {?Object} gwUser - 网关身份（`gatewayUser(req)` 的结果，可能为 null）
   * @returns {Promise.<{items: Array.<Object>, reachable: boolean, code: string, message: string, counts: Object}>}
   *      清单与整体可达性
   */
  async dirGrantList(uid, gwUser) {
    const u = Number(uid);
    const rows = this._bk.listDirGrants(u);
    const granted = await this.grantedDirsOf(u, gwUser);
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
   * 功能：登记 / 刷新一个授权目录 —— **先向宿主确认这个路径真的被授权了**，再落库。
   *
   * 说明：⭐⭐ 判据永远是宿主的授权列表，⛔ 不是「前端说选过了」。所以这里先 `invalidate()`
   *      再查一次（选择器刚点的授权会落在 30 秒缓存之外，见 `authorizeRoot()` 里那段事故记录）。
   *      ⚠️ `granted_at` 只写第一次（业务层判断），`checked_at` 每次都刷新 ——
   *      前者是「曾经成功授权过」的凭据，后者是「最近一次确认它还有效」的时间。
   * @param {number} uid - 账号 id
   * @param {string} path - 目录绝对路径
   * @param {?Object} gwUser - 网关身份
   * @param {{purpose?: string, source?: string, pending?: boolean}} [opts] - 用途备注 / 申请方 /
   *      是否只是「先登记，稍后授权」（`pending` 为真时不校验授权列表）
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
   * 功能：改一条授权目录的**用途备注**（只动这一列，不动路径与授权时间）。
   *
   * 说明：⚠️ 备注是给人看的（「加密信息附件」/「相册备份」），⛔ 不参与任何判权。
   *      只对**已登记**的行生效 —— 路径不存在时抛 404，⛔ 不悄悄新建一行
   *      （那会让错别字变成一个挂在清单里的空目录）。
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
   * 功能：移除一条授权目录 —— **真的把飞牛里那条授权撤掉**，撤掉了才删登记。
   *
   * 说明：⭐⭐ 「移除」如果只删我们这张表的一行，用户会看到「清单里没了、飞牛里还在」，
   *      而任何绕过本清单直接问宿主的代码仍然读得到那个目录 —— 那就是 2026-11-11 报的缺陷。
   *      所以顺序是：**数据目录守卫 → 撤销宿主授权 → 复核 → 才删登记**。
   *      ⚠️ 撤销之后必须**复核**（重新问一次宿主）：平台回了 `suc` 也不等于真撤了；
   *      复核仍在 ⇒ 报错并把登记留着，⛔ 不许「本地删了、日志说成了」。
   *      ⚠️⭐ 「复核仍在」还要再分一层：这条登记可能是**靠上级目录**被带着的（它自己从来没被单独授权过）——
   *      那种情况撤掉的是「本来就没有的那条」，登记可以删，但要回一句 `note` 提醒「上级还授权着」。
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
      //    永远报成「撤不掉」：2026-11-11 真机 `/vol1/1000/ZXDesk` 就撞在这上面。
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
   *
   * 说明：⭐⭐ 撤销的是**访问权**：把数据目录（数据库所在处）的授权撤掉之后，
   *      应用自己下一次启动就读不到库了 —— 那看起来像「数据没了」，用户唯一的出路是重新授权。
   *      ⚠️ 判的是**覆盖关系**：目录本身、以及它的**上级**都要拦（撤上级等于连它一起撤）。
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
   * 功能：拦住「给已有子目录授权的上级目录授权」。
   *
   * 说明：⭐⭐ 飞牛的目录授权是**树级**的 —— 授权上级＝把那棵子树里所有目录一起放开。
   *      所以「先授权了子目录、回头再授权它的上级」等于把权限面一次放大到整棵树，
   *      而界面上的清单只会多一行，看不出这件事。⇒ 先移除子目录的授权，再授权上级。
   *      ⚠️ 三道「不拦」的口径（少一条就会误伤）：
   *      ① 这次选的目录**本来就在**宿主授权列表里 ⇒ 这是「重新授权」，⛔ 不拦、⛔ 更不能撤销它；
   *      ② 拿不到「点选择器之前」的快照（读不到 / 缓存空）⇒ 放行 —— 失败方向必须安全：
   *         宁可漏拦一次，也不许误撤一条本来就在的授权（那可能连带撤掉数据位置的访问权）；
   *      ③ 子目录那一行**宿主那边已经不在了**（`lost`）⇒ 不算「已授权」，不拦。
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
   *
   * 说明：⚠️ 两组**分别**返回 `ok`，由调用方决定怎么合并：只有两组都失败才算「问不到」。
   *      一组失败时按另一组判 —— 把「一组查不到」当成「全都没授权」会造成大批假 `lost`。
   * @param {number} uid - 账号 id（飞牛用户 id，来自网关 Header）
   * @param {?Object} gwUser - 网关身份；为空时用户那一组必然查不到
   * @param {boolean} [fresh] - 是否先作废 30 秒缓存（刚点完选择器时必须为真）
   * @returns {Promise.<{paths: Array.<string>, reachable: boolean, code: string, message: string}>} 合并后的授权目录
   */
  async grantedDirsOf(uid, gwUser, fresh) {
    const owner = gwUser && Number.isInteger(Number(gwUser.uid)) ? gwUser : null;
    if (fresh) trimApi.invalidate(owner ? Number(owner.uid) : null);
    const shared = await this.grantedSharedSafe();
    const user = owner ? await this.grantedUserSafe(Number(owner.uid)) : { paths: [], ok: false, code: '', message: '' };
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
   *
   * 说明：⭐⭐ 这张表是后加的，而附件目录早就存在 —— 不合成的话，
   *      升级上来的用户在设置里看到「一个授权目录都没有」，可加密信息照常能用，两处自相矛盾。
   *      ⚠️ 刻意**不落库**：读接口不该写库（只读模式下会 503）。用户在界面上对它做任何动作
   *      （改备注 / 重新授权）时自然落库。
   *      ⚠️ 用**后端原语**读（`this._bk.getSecretRootInfo`）而不是 `store.secretRootInfo()`：
   *      后者要求密码库已解锁，而设置页打开时通常是锁着的。
   *      ⚠️ 加密信息模块被整目录删掉时，这个 op 不存在 ⇒ 直接跳过（删模块验收要求这样）。
   *      ⭐ 返回的是**行**（`granted_at` / `legacy`），不是最终条目 —— 状态由 `grantItemOf()`
   *      按同一份宿主列表算，⛔ 不在这里另算一套（两处算法必然漂移）。
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
