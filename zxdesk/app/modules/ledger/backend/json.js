'use strict';

/**
 * modules/ledger/backend/json.js —— 记账的**JSON 版原语**
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { uidOf, badRequest } = require('../../../core/store/helpers.js');
const { SCHEMA } = require('../../../core/store/constants.js');
// 预置的 22 行收支分类（唯一出处住 lib/，本文件只负责把它们灌进库）
// `LEGACY_PRESET_NAMES` 只给「恢复内置分类」当识别旧名字的名单；`isOther` 是
// 「同侧『其它』」的唯一判据（⛔ 别在这里自己写 `name === '其它'` —— 双份判据必然漂移）。
const { CATEGORY_PRESETS, LEGACY_PRESET_NAMES, isOther } = require('../lib/categories.js');
// 三方导入：导入表的表名**只从注册表来**（⛔ 永不来自请求 / 文件名）。
// 拿到表名还不够 —— 碰任何数据之前一律再过一道 `assertIdent()`（第二道保险，见那个文件的说明）。
const { assertIdent } = require('../lib/import-sources.js');

/**
 * 改一个账户时**允许变的六列** —— ⚠️ 与 SQLite 侧**逐字一致**
 * @type {Array.<string>}
 */
const ACCOUNT_COLS = ['kind', 'name', 'tail', 'note', 'opening_fen', 'sort_order', 'tier', 'limit_day_fen', 'limit_month_fen', 'limit_year_fen'];

/**
 * 功能：账户行的排序键 —— 「`sort_order`（空值当 0）→ id」（与 SQL 的
 * `ORDER BY COALESCE(sort_order, 0) ASC, id ASC` 同义）。
 * @param {Object} r - 账户行
 * @returns {Array.<number>} 排序键
 */
function accountSortKey(r) {
  const so = Number(r && r.sort_order);
  return [Number.isFinite(so) ? so : 0, Number(r && r.id) || 0];
}

/**
 * 功能：快照行的排序键 —— 「date → id」（与 SQL 的 `ORDER BY date ASC, id ASC` 同义）。
 * @param {Object} r - 快照行
 * @returns {Array.<(string|number)>} 排序键
 */
function snapshotSortKey(r) {
  return [String((r && r.date) || ''), Number((r && r.id) || 0)];
}

/**
 * 功能：按给定顺序**整组重写** `sort_order`（0,1,2…）（JSON 后端）。
 *
 * 说明：⭐⭐ 三处排序（账户 / 分类胶囊 / 分组字段）共用这一个实现 —— 数组键由**本文件的调用点写死**，
 * 不从接口层传（同 SQLite 侧的安全属性）。
 * 只改「这个账号、且 id 在这个列表里」的行，列表外的保持原样。
 */
function reorderRows(store, key, uid, ids, stamp) {
  const u = Number(uid);
  const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!list.length) return 0;
  const want = new Map(list.map((id, i) => [id, i]));
  let hit = 0;
  const d = store._dataFor(key);
  (d[key] || []).forEach((r) => {
    if (uidOf(r) !== u) return;
    const wantIdx = want.get(Number(r.id));
    if (wantIdx === undefined) return;
    r.sort_order = wantIdx;
    r.updated_at = stamp;
    hit += 1;
  });
  if (hit) store._saveJson(SCHEMA.LEDGER_DB);
  return hit;
}

const ops = {
  /**
   * 功能：取该账号的全部账户，按「组内 `sort_order` → id」升序。
   *
   * 说明：⚠️ 判据与 SQLite 侧逐字一致；组与组之间的顺序由业务层照 `KINDS` 拼装。
   *
   * @param {(number|string)} uid - 用户 id
   */
  listLedgerAccounts(uid) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    return (d.ledger_accounts || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => {
        const ka = accountSortKey(a);
        const kb = accountSortKey(b);
        return ka[0] - kb[0] || ka[1] - kb[1];
      });
  },

  /**
   * 功能：按 id + 归属取一个账户；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层就靠这个 null 把「越权」与「不存在」合并成同一个 404。
   *
   * @param {(number|string)} uid - 用户 id
   */
  getLedgerAccount(uid, id) {
    const d = this._dataFor('ledger_accounts');
    return (
      (d.ledger_accounts || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null
    );
  },

  /**
   * 功能：插入一个账户，返回新建的整行。
   *
   * 说明：⚠️ 与 SQLite 侧同一条规矩：id 由本层发号、`user_id` 一律写成入参那个账号、
   * 空值统一存 `null`（⛔ 不留空串）。
   *
   */
  insertLedgerAccount(uid, values) {
    const d = this._dataFor('ledger_accounts');
    // 这里的键**是手写的**（不像 `updateLedgerAccount` 那样用 `ACCOUNT_COLS` 遍历）
    const row = {
      id: d._seq,
      user_id: Number(uid),
      kind: values.kind,
      name: values.name,
      tail: values.tail || null,
      note: values.note || null,
      opening_fen: Number(values.opening_fen) || 0,
      sort_order: Number(values.sort_order) || 0,
      tier: values.tier || null,
      limit_day_fen: values.limit_day_fen == null ? null : Number(values.limit_day_fen),
      limit_month_fen: values.limit_month_fen == null ? null : Number(values.limit_month_fen),
      limit_year_fen: values.limit_year_fen == null ? null : Number(values.limit_year_fen),
      created_at: values.created_at,
      updated_at: values.updated_at,
    };
    d._seq += 1;
    (d.ledger_accounts = d.ledger_accounts || []).push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：把一个账户的**六个可写列整行写一遍**（`updated_at` 一并刷新）。
   *
   * 说明：⚠️ 与 SQLite 侧同一条规矩：整行写、不是逐列 patch（业务层先读现状、合并、再整行交过来）。
   * `id` / `user_id` / `created_at` **一个都不动**。
   *
   */
  updateLedgerAccount(uid, id, values, stamp) {
    const d = this._dataFor('ledger_accounts');
    const row = (d.ledger_accounts || []).find(
      (r) => r.id === Number(id) && uidOf(r) === Number(uid),
    );
    if (!row) return false;
    ACCOUNT_COLS.forEach((c) => {
      row[c] = c === 'tail' || c === 'note' ? values[c] || null : values[c];
    });
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：删掉一个账户（**硬删**）。
   *
   * 说明：⚠️ 与 SQLite 侧同一条规矩：`user_id` 照旧要认（它是防止「拿别人的 id 来删」的最后一道）。
   *
   * @param {(number|string)} uid - 用户 id
   */
  deleteLedgerAccount(uid, id) {
    const d = this._dataFor('ledger_accounts');
    const rows = d.ledger_accounts || [];
    const i = rows.findIndex((r) => r.id === Number(id) && uidOf(r) === Number(uid));
    if (i < 0) return false;
    rows.splice(i, 1);
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：取该账号在**某一年**里的快照行，按日期升序。
   *
   * 说明：⚠️ 与 SQLite 侧的字符串区间同义（`date` 是 `YYYY-MM-DD` 定长串，字典序即时间序）。
   *
   * @param {(number|string)} uid - 用户 id
   */
  listLedgerSnapshots(uid, year) {
    const d = this._dataFor('ledger_snapshots');
    const u = Number(uid);
    const y = String(year);
    const lo = `${y}-01-01`;
    const hi = `${y}-12-31`;
    return (d.ledger_snapshots || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const dv = String(r.date || '');
        return dv >= lo && dv <= hi;
      })
      .slice()
      .sort((a, b) => {
        const ka = snapshotSortKey(a);
        const kb = snapshotSortKey(b);
        if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
        return ka[1] - kb[1];
      });
  },

  /**
   * 功能：该账号**有过快照的年份**，降序 —— 与 SQLite 侧逐字同义（年度下拉的选项）。
   *
   * 说明：⚠️ `date` 是 `YYYY-MM-DD` 定长串 ⇒ 前四位就是年（⛔ 不引日期库）。
   *
   * @param {(number|string)} uid - 用户 id
   */
  snapshotYears(uid) {
    const d = this._dataFor('ledger_snapshots');
    const u = Number(uid);
    const set = new Set();
    for (const r of d.ledger_snapshots || []) {
      if (uidOf(r) !== u) continue;
      const y = Number(String((r && r.date) || '').slice(0, 4));
      if (Number.isFinite(y) && y > 0) set.add(y);
    }
    return [...set].sort((a, b) => b - a);
  },

  /**
   * 功能：把「某一天」的那一行快照**写上或改掉**（一人一天最多一行），返回写入后的行。
   *
   * 说明：⭐ 与 SQLite 的 `ON CONFLICT(user_id, date) DO UPDATE` 逐字同一语义。
   * JSON 这边没有唯一约束，所以「先找、找到就改、找不到就插」必须自己写全 ——
   *
   */
  upsertLedgerSnapshot(uid, date, totals, stamp) {
    const d = this._dataFor('ledger_snapshots');
    const u = Number(uid);
    const day = String(date);
    let row = (d.ledger_snapshots || []).find((r) => uidOf(r) === u && String(r.date || '') === day);
    if (!row) {
      row = { id: d._seq, user_id: u, date: day };
      d._seq += 1;
      d.ledger_snapshots.push(row);
    }
    row.asset_fen = Number(totals.asset_fen) || 0;
    row.debt_fen = Number(totals.debt_fen) || 0;
    row.net_fen = Number(totals.net_fen) || 0;
    if (row.created_at === undefined) row.created_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  // ---- 自定义分类（视图）与其用途归属 ----
  /**
   * 功能：取该账号的全部自定义分类，按 `sort_order` → id 升序（与 SQLite 侧同义）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 分类行数组
   */
  listLedgerViews(uid) {
    const d = this._dataFor('ledger_views');
    const u = Number(uid);
    return (d.ledger_views || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => {
        const ka = [Number(a && a.sort_order) || 0, Number((a && a.id) || 0)];
        const kb = [Number(b && b.sort_order) || 0, Number((b && b.id) || 0)];
        return ka[0] - kb[0] || ka[1] - kb[1];
      });
  },

  /**
   * 功能：按 id + 归属取一套分类；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} id - 分类 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerView(uid, id) {
    const d = this._dataFor('ledger_views');
    const u = Number(uid);
    const v = Number(id);
    return (d.ledger_views || []).find((r) => uidOf(r) === u && Number(r.id) === v) || null;
  },

  /**
   * 功能：插一套分类，返回落地后的那一行。
   * @param {(number|string)} uid - 用户 id
   * @param {{name: string, sort_order: number, created_at: number, updated_at: number}} values - 要写的列
   * @returns {Object} 写入后的行
   */
  insertLedgerView(uid, values) {
    const d = this._dataFor('ledger_views');
    const v = values || {};
    const row = {
      id: d._seq,
      user_id: Number(uid),
      name: String(v.name),
      sort_order: Number(v.sort_order) || 0,
      // 只被 seed 用（写 1/2）；用户新建分类时不传 ⇒ 落 0。
      // 与 SQLite 侧逐字同语义：它**不在** update 的可改列里。
      builtin: Number(v.builtin) || 0,
      created_at: v.created_at,
      updated_at: v.updated_at,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_views)) d.ledger_views = [];
    d.ledger_views.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：改一套分类（只允许改 `name` 与 `sort_order`）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} id - 分类 id
   * @param {{name: string, sort_order: number}} values - 要写的列
   * @param {number} stamp - 写入时间戳
   */
  updateLedgerView(uid, id, values, stamp) {
    const d = this._dataFor('ledger_views');
    // 别写 `this.getLedgerView(...)`：那是 `is not a function`（本文件头注释记过这个坑）
    const u = Number(uid);
    const vid = Number(id);
    const row = (d.ledger_views || []).find((r) => uidOf(r) === u && Number(r.id) === vid);
    if (!row) return false;
    const v = values || {};
    row.name = String(v.name);
    row.sort_order = Number(v.sort_order) || 0;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：删一套分类 —— ⭐ **连同它的用途归属一起删**（与 SQLite 侧同一语义）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} id - 分类 id
   * @returns {boolean} 删除前这套分类存在为 true
   */
  deleteLedgerView(uid, id) {
    const d = this._dataFor('ledger_views');
    const u = Number(uid);
    const v = Number(id);
    const before = (d.ledger_views || []).length;
    d.ledger_views = (d.ledger_views || []).filter((r) => !(uidOf(r) === u && Number(r.id) === v));
    const hit = d.ledger_views.length < before;
    d.ledger_view_tags = (d.ledger_view_tags || []).filter(
      (r) => !(uidOf(r) === u && Number(r.view_id) === v),
    );
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：取一套分类里的全部用途归属行。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} viewId - 分类 id
   * @returns {Array.<Object>} 归属行数组
   */
  listLedgerViewTags(uid, viewId) {
    const d = this._dataFor('ledger_view_tags');
    const u = Number(uid);
    const v = Number(viewId);
    return (d.ledger_view_tags || [])
      .filter((r) => uidOf(r) === u && Number(r.view_id) === v)
      .slice()
      .sort((a, b) => Number((a && a.id) || 0) - Number((b && b.id) || 0));
  },

  /**
   * 功能：给「某个账户在某套分类里」写上 / 改掉用途（一个账户一套分类最多一行）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} viewId - 分类 id
   * @param {number|string} accountId - 账户 id
   * @param {string} tag - 用途名（非空）
   */
  upsertLedgerViewTag(uid, viewId, accountId, tag, stamp) {
    const d = this._dataFor('ledger_view_tags');
    const u = Number(uid);
    const v = Number(viewId);
    const a = Number(accountId);
    if (!Array.isArray(d.ledger_view_tags)) d.ledger_view_tags = [];
    let row = d.ledger_view_tags.find(
      (r) => uidOf(r) === u && Number(r.view_id) === v && Number(r.account_id) === a,
    );
    if (!row) {
      row = { id: d._seq, user_id: u, view_id: v, account_id: a };
      d._seq += 1;
      d.ledger_view_tags.push(row);
    }
    row.tag = String(tag);
    if (row.created_at === undefined) row.created_at = stamp;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },
  /**
   * 功能：写一套分类里**组内的先后** —— 与 SQLite 侧逐字同语义（那边是一个事务，这边全改完再落一次盘）。
   *
   * 两侧的失败方向必须一致：认不出的账户一律跳过（不新建行）—— 它在这套分类里没有位置。
   *
   * @param {(number|string)} uid - 用户 id
   */
  reorderLedgerTags(uid, viewId, accountIds, stamp) {
    const d = this._dataFor('ledger_view_tags');
    const u = Number(uid);
    const v = Number(viewId);
    const list = Array.isArray(accountIds)
      ? accountIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (!list.length) return 0;
    const want = new Map(list.map((aid, i) => [aid, i]));
    let hit = 0;
    (d.ledger_view_tags || []).forEach((r) => {
      if (uidOf(r) !== u || Number(r.view_id) !== v) return;
      const idx = want.get(Number(r.account_id));
      if (idx === undefined) return;
      r.sort_order = idx;
      r.updated_at = stamp;
      hit += 1;
    });
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：把「某个账户在某套分类里」的用途拿掉（＝ 回到「其它」）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} viewId - 分类 id
   * @param {number|string} accountId - 账户 id
   * @returns {boolean} 有行被删为 true
   */
  deleteLedgerViewTag(uid, viewId, accountId) {
    const d = this._dataFor('ledger_view_tags');
    const u = Number(uid);
    const v = Number(viewId);
    const a = Number(accountId);
    const before = (d.ledger_view_tags || []).length;
    d.ledger_view_tags = (d.ledger_view_tags || []).filter(
      (r) => !(uidOf(r) === u && Number(r.view_id) === v && Number(r.account_id) === a),
    );
    const hit = d.ledger_view_tags.length < before;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：删掉某个账户在所有分类里的用途行（删账户时调）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} accountId - 账户 id
   * @returns {number} 删掉的行数
   */
  deleteLedgerTagsOfAccount(uid, accountId) {
    const d = this._dataFor('ledger_view_tags');
    const u = Number(uid);
    const a = Number(accountId);
    const before = (d.ledger_view_tags || []).length;
    d.ledger_view_tags = (d.ledger_view_tags || []).filter(
      (r) => !(uidOf(r) === u && Number(r.account_id) === a),
    );
    const hit = before - d.ledger_view_tags.length;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },


  /**
   * 功能：取分组字段，按 `sort_order` → id 升序；给了 `scope` 就只取那一套。
   *
   * 说明：⚠️ 与 SQLite 侧同语义（那边是 `WHERE user_id=? [AND scope=?] ORDER BY sort_order, id`）。
   * @param {(number|string)} uid - 用户 id
   * @param {?string} scope - `'kind'` / `'usage'`；给假值时两套都给
   */
  listLedgerGroups(uid, scope) {
    const d = this._dataFor('ledger_groups');
    const u = Number(uid);
    const s = scope ? String(scope) : '';
    return (d.ledger_groups || [])
      .filter((r) => uidOf(r) === u && (!s || String(r.scope) === s))
      .slice()
      .sort((a, b) => {
        const sa = String((a && a.scope) || '');
        const sb = String((b && b.scope) || '');
        if (sa !== sb) return sa < sb ? -1 : 1;
        const ka = [Number(a && a.sort_order) || 0, Number((a && a.id) || 0)];
        const kb = [Number(b && b.sort_order) || 0, Number((b && b.id) || 0)];
        return ka[0] - kb[0] || ka[1] - kb[1];
      });
  },

  /**
   * 功能：按 id + 归属取一个分组字段；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} id - 字段行 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerGroup(uid, id) {
    const d = this._dataFor('ledger_groups');
    const u = Number(uid);
    const g = Number(id);
    return (d.ledger_groups || []).find((r) => uidOf(r) === u && Number(r.id) === g) || null;
  },

  /**
   * 功能：插一个分组字段，返回落地后的那一行。
   *
   * 说明：⚠️ 与 SQLite 侧**行为必须一致**：那边同名同键会撞 `UNIQUE(user_id, scope, gkey)` 抛错，
   *
   * @param {(number|string)} uid - 用户 id
   */
  insertLedgerGroup(uid, values) {
    const d = this._dataFor('ledger_groups');
    const u = Number(uid);
    const v = values || {};
    const scope = String(v.scope);
    const gkey = String(v.gkey);
    const dup = (d.ledger_groups || []).some(
      (r) => uidOf(r) === u && String(r.scope) === scope && String(r.gkey) === gkey,
    );
    if (dup) throw new Error(`ledger_groups 已有同键字段: ${scope}/${gkey}`);
    const row = {
      id: d._seq,
      user_id: u,
      scope,
      gkey,
      name: String(v.name),
      sort_order: Number(v.sort_order) || 0,
      locked: v.locked ? 1 : 0,
      created_at: v.created_at,
      updated_at: v.updated_at,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_groups)) d.ledger_groups = [];
    d.ledger_groups.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：改一个分组字段（只允许改 `name` 与 `sort_order`）。
   *
   * 说明：⭐⭐ 改名**不影响任何账户归属** —— 归属存的是 `gkey`（见 `schema.js` 的说明）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} id - 字段行 id
   */
  updateLedgerGroup(uid, id, values, stamp) {
    const d = this._dataFor('ledger_groups');
    const u = Number(uid);
    const g = Number(id);
    const row = (d.ledger_groups || []).find((r) => uidOf(r) === u && Number(r.id) === g);
    if (!row) return false;
    const v = values || {};
    row.name = String(v.name);
    row.sort_order = Number(v.sort_order) || 0;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：删一个分组字段（只管这一行；「归在它下面的账户去哪」由业务层决定）。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} id - 字段行 id
   * @returns {boolean} 删除前这一行存在为 true
   */
  deleteLedgerGroup(uid, id) {
    const d = this._dataFor('ledger_groups');
    const u = Number(uid);
    const g = Number(id);
    const before = (d.ledger_groups || []).length;
    d.ledger_groups = (d.ledger_groups || []).filter(
      (r) => !(uidOf(r) === u && Number(r.id) === g),
    );
    const hit = d.ledger_groups.length < before;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：把某个分类下、归属为 `fromKey` 的那些行**整批改成 `toKey`**（删用途时的兜底动作）。
   *
   * 说明：⚠️ 与 SQLite 侧同一语义：只动 `tag` 一列，不碰账户、不碰别的分类。
   * @param {(number|string)} uid - 用户 id
   * @param {number|string} viewId - 分类 id
   */
  reassignLedgerViewTags(uid, viewId, fromKey, toKey, stamp) {
    const d = this._dataFor('ledger_view_tags');
    const u = Number(uid);
    const v = Number(viewId);
    const from = String(fromKey);
    const to = String(toKey);
    let hit = 0;
    (d.ledger_view_tags || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.view_id) === v && String(r.tag) === from) {
        r.tag = to;
        r.updated_at = stamp;
        hit += 1;
      }
    });
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：按给定顺序重排**账户**（列表里的先后）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ids - 期望顺序
   * @param {number} stamp - 写入时间戳
   * @returns {number} 实际改到的行数
   */
  reorderLedgerAccounts(uid, ids, stamp) {
    return reorderRows(this, 'ledger_accounts', uid, ids, stamp);
  },

  /**
   * 功能：按给定顺序重排**分类胶囊**（含内置那两颗）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ids - 期望顺序
   * @param {number} stamp - 写入时间戳
   * @returns {number} 实际改到的行数
   */
  reorderLedgerViews(uid, ids, stamp) {
    return reorderRows(this, 'ledger_views', uid, ids, stamp);
  },

  /**
   * 功能：按给定顺序重排**分组字段**（九类的显示顺序 / 用途的先后）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ids - 期望顺序
   * @param {number} stamp - 写入时间戳
   * @returns {number} 实际改到的行数
   */
  reorderLedgerGroups(uid, ids, stamp) {
    return reorderRows(this, 'ledger_groups', uid, ids, stamp);
  },

  /**
   * 功能：取「与某个账户有关」的全部转账（转出 + 转入），按 `date` 倒序、同日按 id 倒序。
   *
   * 说明：⚠️ 与 SQLite 侧逐字同一语义（`WHERE user_id=? AND (from_id=? OR to_id=?) ORDER BY date DESC, id DESC`）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} accountId - 账户 id
   */
  listLedgerTransfers(uid, accountId) {
    const d = this._dataFor('ledger_transfers');
    const u = Number(uid);
    const a = Number(accountId);
    return (d.ledger_transfers || [])
      .filter((r) => uidOf(r) === u && (Number(r.from_id) === a || Number(r.to_id) === a))
      .slice()
      .sort((x, y) => {
        const dx = String(x.date || '');
        const dy = String(y.date || '');
        if (dx !== dy) return dx < dy ? 1 : -1; // ⚠️ 倒序：新的在前
        return Number(y.id || 0) - Number(x.id || 0);
      });
  },

  /**
   * 功能：**原子地**记下一笔转账（确认两个账户都在 ＋ 插一行 `ledger_transfers`）。
   *
   * `ledger_accounts`**：转账只是「两个账户之间挪过钱」这条**事实**，
   * 它对余额的影响由 `lib/balance.js` 在需要时算出来。
   * 1 期那句「转出账户加增量、转入账户加增量」**整块删掉**了 ——
   */
  transferLedger(uid, values, stamp) {
    const d = this._dataFor('ledger_transfers');
    const u = Number(uid);
    const fromId = Number(values.from_id);
    const toId = Number(values.to_id);
    const amt = Math.trunc(Number(values.amount_fen)) || 0;
    const accounts = d.ledger_accounts || [];
    const has = (aid) => accounts.some((r) => uidOf(r) === u && Number(r.id) === aid);
    if (!has(fromId) || !has(toId)) return null;
    const row = {
      id: d._seq,
      user_id: u,
      date: String(values.date),
      from_id: fromId,
      to_id: toId,
      amount_fen: amt,
      note: values.note || null,
      created_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_transfers)) d.ledger_transfers = [];
    d.ledger_transfers.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：删掉**与某个账户有关**的全部转账（删账户时调）。
   *
   * 第 6 条把「删账户」改成了「写一行删除记录 ＋ 硬删账户行」，
   * 转账 / 流水 / 手动调整**一条都不删** —— 它们保留原 id，显示名字时去删除记录表取原名；
   * 之所以**留着**：两后端的 op 集合必须逐字一致（`assertOpsContract()` 在加载时比对），
   */
  deleteLedgerTransfersOfAccount(uid, accountId) {
    const d = this._dataFor('ledger_transfers');
    const u = Number(uid);
    const a = Number(accountId);
    const before = (d.ledger_transfers || []).length;
    d.ledger_transfers = (d.ledger_transfers || []).filter(
      (r) => !(uidOf(r) === u && (Number(r.from_id) === a || Number(r.to_id) === a)),
    );
    const hit = before - d.ledger_transfers.length;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：取本账号在**与某个账户有关**的全部转账里、按日期升序的那一批（派生余额要用全量）。
   *
   * 说明：⭐⭐ 它是「余额实时派生」这条口径的**取数口**：派生一个账户的余额时
   * 必须能拿到**它参与过的每一笔转账**，而 1 期只有「按账户查」那一个原语
   * ⇒ 拿它去查每一个账户就是一串 N+1。
   */
  listLedgerTransfersByUser(uid) {
    const d = this._dataFor('ledger_transfers');
    const u = Number(uid);
    return (d.ledger_transfers || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => {
        const da = String(a.date || '');
        const db = String(b.date || '');
        if (da !== db) return da < db ? -1 : 1; // ⚠️ 升序：与 SQLite 侧逐字一致
        return Number(a.id || 0) - Number(b.id || 0);
      });
  },

  // ---- 记账条目（2 期）----
  /**
   * 功能：取本账号的记账条目 —— 「按月区间 ＋ 游标 ＋ 条数上限」，按 `(at, id)` 倒序。
   *
   * 说明：⭐⭐ 三条形状上的取舍（都是「写错了不报错、只是静默不对」的那一类）：
   * **区间是字典序**（`at >= from AND at < to`）：`at` 是 `YYYY-MM-DD HH:MM:SS` 定长串
   */
  listLedgerEntries(uid, opts) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const o = opts && typeof opts === 'object' ? opts : {};
    const atOf = (r) => String((r && r.at) == null ? '' : r.at);
    const before = o.before && typeof o.before === 'object' ? o.before : null;
    const rows = (d.ledger_entries || []).filter((r) => {
      if (uidOf(r) !== u) return false;
      const a = atOf(r);
      if (o.from && !(a >= String(o.from))) return false;
      if (o.to && !(a < String(o.to))) return false;
      if (before && before.at != null) {
        const ba = String(before.at);
        const bid = Number(before.id) || 0;
        if (!(a < ba || (a === ba && Number(r.id) < bid))) return false;
      }
      return true;
    });
    const sorted = rows.slice().sort((x, y) => {
      const ax = atOf(x);
      const ay = atOf(y);
      if (ax !== ay) return ax < ay ? 1 : -1; // ⚠️ 倒序：新的在前
      return Number(y.id || 0) - Number(x.id || 0);
    });
    const lim = Math.trunc(Number(o.limit));
    return Number.isFinite(lim) && lim > 0 ? sorted.slice(0, lim) : sorted;
  },

  /**
   * 功能：按 id + 归属取一条记账条目；不存在或不属于该账号都返回 null（越权与不存在统一 404）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 条目 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerEntry(uid, id) {
    const d = this._dataFor('ledger_entries');
    return (d.ledger_entries || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id)) || null;
  },

  /**
   * 功能：插一条记账条目，返回落地后的那一行。
   *
   * 说明：⚠️ `user_id` 由本层强制写成入参那个账号（请求体里带来的任何 `user_id` 都流不进来）；
   * `note` 空串统一落 `null`（与账户那张表同一条口径：`''` 与 `NULL` 是同一件事）。
   * `category_id` 为 `null` = **未分类**，它是一个**合法值**，
   */
  insertLedgerEntry(uid, values, stamp) {
    const d = this._dataFor('ledger_entries');
    const v = values || {};
    const row = {
      id: d._seq,
      user_id: Number(uid),
      at: String(v.at),
      ie: String(v.ie),
      amount_fen: Math.trunc(Number(v.amount_fen)) || 0,
      category_id: v.category_id == null ? null : Number(v.category_id),
      account_id: Number(v.account_id),
      refund_of: v.refund_of == null ? null : Number(v.refund_of),
      note: v.note ? String(v.note) : null,
      created_at: stamp,
      updated_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_entries)) d.ledger_entries = [];
    d.ledger_entries.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  // 这五个原语一律收 `table`（表名走参数），且**碰任何数据之前**先过 `assertIdent()`：
  // 表名只可能来自 `lib/import-sources.js` 的注册表（⛔ 永不来自请求 / 文件名）。
  // 取数据一律 `this._dataFor(table)`（它对记账库的表返回**同一个对象**），

  /**
   * 功能：数该账号在**这张导入表**里有多少行（给界面上的「已导入 N 笔」）。
   *
   * 说明：⚠️ 与 `sqlite.js` 的同名原语**同一语义**：按 `user_id` 过滤，别人的行一米都不算。
   *
   * @param {(number|string)} uid - 用户 id
   */
  countImportedRows(uid, table) {
    const t = assertIdent(table);
    const d = this._dataFor(t);
    const u = Number(uid);
    return (d[t] || []).filter((r) => uidOf(r) === u).length;
  },

  /**
   * 功能：算该账号**下一个批次号**（账号范围内 `MAX(batch_id) + 1`，空表 ⇒ `1`）。
   *
   * 说明：⭐ 与 SQLite 侧的 `COALESCE(MAX(batch_id), 0) + 1` **同一语义**：批次号只增不减，
   * 只在这个账号范围内取最大值（别人的批次号不影响我）。
   *
   */
  nextImportBatchId(uid, table) {
    const t = assertIdent(table);
    const d = this._dataFor(t);
    const u = Number(uid);
    let max = 0;
    for (const r of d[t] || []) {
      if (uidOf(r) !== u) continue;
      const b = Math.trunc(Number(r && r.batch_id));
      if (Number.isFinite(b) && b > max) max = b;
    }
    return max + 1;
  },

  /**
   * 功能：**批量插导入行 —— 一次落盘**（要么全写、要么一行都不写）。
   *
   * 说明：⭐⭐ 「一个事务」在本后端的兑现方式与 SQLite 不同、**但语义相同**：
   * JSON 后端是「整份数据在内存里、`_saveJson()` 一次性写盘」⇒ 先把全部新行算完
   * （这一步可能抛），再改内存、最后落一次盘 ⇒ 中途抛错就自然「一行都没写」
   */
  insertImportedRows(uid, table, rows, batchId, stamp) {
    const t = assertIdent(table);
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { inserted: 0 };
    const d = this._dataFor(t);
    if (!Array.isArray(d[t])) d[t] = [];
    const u = Number(uid);
    const b = Number(batchId);
    const base = Number(d._seq) || 0;
    // 先把整批算完（这一步抛错 ⇒ 下面的内存改动与落盘都不会发生）
    const next = list.map((v, i) => {
      const r = v || {};
      return {
        id: base + i,
        user_id: u,
        batch_id: b,
        row_no: i + 1,
        date_raw: r.dateRaw == null ? null : String(r.dateRaw),
        ie_raw: r.ieRaw == null ? null : String(r.ieRaw),
        category: r.category == null ? null : String(r.category),
        account: r.account == null ? null : String(r.account),
        amount_raw: r.amountRaw == null ? null : String(r.amountRaw),
        note: r.note == null ? null : String(r.note),
        at: r.at == null ? null : String(r.at),
        fen: r.fen == null ? null : Math.trunc(Number(r.fen)),
        created_at: stamp,
      };
    });
    d._seq = base + next.length;
    for (const row of next) d[t].push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return { inserted: next.length };
  },

  /**
   * 功能：取**区间原料**（导入行）—— ⭐ 合并取数里导入那一半的唯一取数口。
   *
   * 说明：⭐⭐ **区间语义与 `selectLedgerEntriesBetween` 逐字相同**：左闭右开
   * （`at>=from AND at<?`）；`from` / `to` 给空串 ⇒ 那一端不设限。
   * **排除 `at` 为 `null` / 空串的行**（它们不属于任何区间）。
   */
  selectImportedBetween(uid, table, from, to) {
    const t = assertIdent(table);
    const d = this._dataFor(t);
    const u = Number(uid);
    const lo = from ? String(from) : '';
    const hi = to ? String(to) : '';
    return (d[t] || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const at = String((r && r.at) == null ? '' : r.at);
        if (!at) return false;
        if (lo && !(at >= lo)) return false;
        if (hi && !(at < hi)) return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        const aa = String(a.at || '');
        const ab = String(b.at || '');
        if (aa !== ab) return aa < ab ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      })
      .map((r) => ({
        id: Number(r.id) || 0,
        date_raw: r.date_raw == null ? null : String(r.date_raw),
        ie_raw: r.ie_raw == null ? null : String(r.ie_raw),
        category: r.category == null ? null : String(r.category),
        account: r.account == null ? null : String(r.account),
        amount_raw: r.amount_raw == null ? null : String(r.amount_raw),
        note: r.note == null ? null : String(r.note),
        at: String((r && r.at) == null ? '' : r.at),
        fen: r.fen == null ? null : Math.trunc(Number(r.fen)),
        batch_id: Math.trunc(Number(r.batch_id)) || 0,
      }));
  },

  /**
   * 功能：删该账号在**这张导入表**里的全部行（整批清除），回删掉的条数。
   *
   * 说明：⭐⭐ 导入的数据是**只读**的 ⇒ 撤走只有这条路：一次清空这个账号的
   * 全部导入行，⛔ 不按 `batch_id` 挑批。⚠️ 与 SQLite 侧同一语义：`user_id` 一起判，
   *
   */
  deleteImportedByUser(uid, table) {
    const t = assertIdent(table);
    const d = this._dataFor(t);
    const u = Number(uid);
    const before = (d[t] || []).length;
    d[t] = (d[t] || []).filter((r) => uidOf(r) !== u);
    const hit = before - d[t].length;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：改一条记账条目（**整行写**，`updated_at` 一并刷新）。
   *
   * 说明：⚠️ **`refund_of` 不在可改列里**，而且这不是漏写：它表达的是「这一条**是**退款」这个身份，
   * 这条校验被整个绕过。退款要改只能改它自己的金额 / 时刻 / 备注。
   * `id` / `user_id` / `created_at` 照旧不进 SET（身份与审计）。
   */
  updateLedgerEntry(uid, id, values, stamp) {
    const d = this._dataFor('ledger_entries');
    const row = (d.ledger_entries || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    if (!row) return false;
    const v = values || {};
    row.at = String(v.at);
    row.ie = String(v.ie);
    row.amount_fen = Math.trunc(Number(v.amount_fen)) || 0;
    row.category_id = v.category_id == null ? null : Number(v.category_id);
    row.account_id = Number(v.account_id);
    row.note = v.note ? String(v.note) : null;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：删一条记账条目 —— ⭐ **连带删掉「退的是它」的那些退款条目**（一次性落盘）。
   *
   * 说明：⭐⭐ 为什么必须连带（C-14）：退款与它的原交易是**同一件事的两半**，
   * 原交易一删，那些退款行就指向一个不存在的 id ⇒ 界面上显示不出「退的是哪一笔」，
   * 而它的金额**还在余额里**（静默的钱对不上）。两端的删除确认文案要说清这一点。
   */
  deleteLedgerEntry(uid, id) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const e = Number(id);
    const list = d.ledger_entries || [];
    const kept = list.filter((r) => !(uidOf(r) === u && Number(r.refund_of) === e));
    // 「退的是它」的那些行先摘掉，再从剩下的里摘掉它自己
    const hit = kept.some((r) => uidOf(r) === u && Number(r.id) === e);
    d.ledger_entries = kept.filter((r) => !(uidOf(r) === u && Number(r.id) === e));
    if (kept.length !== list.length || hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：一次取回**一批原条目**的退款条目（⛔ 不做 N+1）。
   *
   * 说明：⭐ 调用点的两种用法都在这一份结果上：①「原交易那一行显示已退多少」＝把它们按
   * `refund_of` 求和；②「这笔还能退多少」＝拿原额减这个和。
   * 返回的是**整行**（不是求和结果）：求和是业务层的口径。
   */
  listLedgerRefunds(uid, entryIds) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const ids = (Array.isArray(entryIds) ? entryIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return [];
    const want = new Set(ids);
    return (d.ledger_entries || [])
      .filter((r) => uidOf(r) === u && want.has(Number(r.refund_of)))
      .slice()
      .sort((a, b) => {
        const aa = String(a.at || '');
        const ab = String(b.at || '');
        if (aa !== ab) return aa < ab ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      });
  },

  /**
   * 功能：**一次性**记一笔退款 —— 「算原条目累计退款 ＋ 校验 ≤ 原额 ＋ 插入」要么全做要么全不做。
   *
   * 说明：⭐⭐ 这是本模块**唯一**能改「已退多少」的入口：
   * ⇒ 累计退款超过原额，而两边的响应都是 201（静默的错账）。
   * JSON 后端没有事务 ⇒ 校验全部通过之后**才开始**改内存，最后一次落盘。
   */
  insertLedgerRefund(uid, values, stamp) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const v = values || {};
    const list = d.ledger_entries || [];
    const orig = list.find((r) => uidOf(r) === u && Number(r.id) === Number(v.refund_of));
    if (!orig) return null;
    if (orig.refund_of != null) throw badRequest('这一笔本身就是退款，不能再给它退款');
    const amt = Math.trunc(Number(v.amount_fen)) || 0;
    const sum = list.reduce(
      (acc, r) =>
        uidOf(r) === u && Number(r.refund_of) === Number(orig.id) ? acc + (Math.trunc(Number(r.amount_fen)) || 0) : acc,
      0,
    );
    // 原额也压成整数再比：老库 / 手改过的行里可能是字符串
    if (sum + amt > (Math.trunc(Number(orig.amount_fen)) || 0)) throw badRequest('退款总额不能超过这一笔的金额');
    const row = {
      id: d._seq,
      user_id: u,
      at: String(v.at),
      ie: '收入', // ⭐ 退款一律是收入侧（它的方向靠 `refund_of` 指向的原交易决定）
      amount_fen: amt,
      category_id: v.category_id == null ? null : Number(v.category_id),
      account_id: Number(v.account_id),
      refund_of: Number(orig.id),
      note: v.note ? String(v.note) : null,
      created_at: stamp,
      updated_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_entries)) d.ledger_entries = [];
    d.ledger_entries.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：取**备注历史候选** —— 该账号（可限某一类别）用过的不重复备注，最近用过的在前。
   *
   * 说明：⭐⭐ 备注候选**不新开表**：直接来自已有的流水备注，
   * 由**服务端一处**给（⛔ 不让两端各自 `distinct` —— 各自实现必然漂移）。
   * 排序用 `MAX(at)`（这个词**最后一次用**是什么时候）而不是 `MIN`。
   */
  listLedgerNoteCandidates(uid, categoryId, limit) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const wantCat = Number(categoryId);
    const useCat = categoryId != null && wantCat > 0;
    // `MAX(at)` 与 `MAX(id)` 在 SQL 里是**各自独立**取最大（不保证来自同一行）⇒ 这里也分开累计
    const agg = new Map();
    (d.ledger_entries || []).forEach((r) => {
      if (uidOf(r) !== u) return;
      const note = r.note == null ? '' : String(r.note);
      if (!note) return;
      if (useCat && Number(r.category_id) !== wantCat) return;
      const at = String(r.at == null ? '' : r.at);
      const id = Number(r.id) || 0;
      const cur = agg.get(note) || { note, last_at: '', last_id: 0 };
      if (at > cur.last_at) cur.last_at = at;
      if (id > cur.last_id) cur.last_id = id;
      agg.set(note, cur);
    });
    const lim = Math.trunc(Number(limit)) || 20;
    return [...agg.values()]
      .sort((a, b) => {
        if (a.last_at !== b.last_at) return a.last_at < b.last_at ? 1 : -1; // ⚠️ 倒序：最近用过的在前
        return b.last_id - a.last_id;
      })
      .slice(0, lim)
      .map((r) => r.note);
  },

  // ---- 收支分类（2 期）----
  /**
   * 功能：取本账号的全部收支分类（**含已归档的**），一级在前、各自按 `sort_order`。
   *
   * 说明：⭐ 已归档的**也要取回来**：历史流水的 `category_id` 还指着它们，
   * 界面上要显示原名；「不出现在选择器里」是**前端按 `archived_at` 过滤**的事。
   */
  listLedgerCategories(uid) {
    const d = this._dataFor('ledger_categories');
    const u = Number(uid);
    const pid = (r) => Number((r && r.parent_id) || 0);
    const so = (r) => Number((r && r.sort_order) || 0);
    return (d.ledger_categories || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => pid(a) - pid(b) || so(a) - so(b) || Number(a.id || 0) - Number(b.id || 0));
  },

  /**
   * 功能：按 id + 归属取一个收支分类；不存在或不属于该账号都返回 null（越权与不存在统一 404）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分类 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerCategory(uid, id) {
    const d = this._dataFor('ledger_categories');
    return (d.ledger_categories || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id)) || null;
  },

  /**
   * 功能：插一个收支分类，返回落地后的那一行。
   *
   * 说明：⚠️ `ie` **只有一级填**（二级写 `null`、继承父 —— / §4.3 ②）：
   * 冗余存一遍必然与父漂移，而「这一笔算哪一侧」全靠它。
   * `name` **允许重名**（与账户名同一条纪律），故这里没有唯一约束可撞。
   */
  insertLedgerCategory(uid, values, stamp) {
    const d = this._dataFor('ledger_categories');
    const v = values || {};
    const row = {
      id: d._seq,
      user_id: Number(uid),
      parent_id: v.parent_id == null ? null : Number(v.parent_id),
      name: String(v.name),
      ie: v.ie == null ? null : String(v.ie),
      sort_order: Number(v.sort_order) || 0,
      archived_at: null,
      created_at: stamp,
      updated_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_categories)) d.ledger_categories = [];
    d.ledger_categories.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：改一个收支分类（**只允许改 `name` 与 `sort_order`**）。
   *
   * 说明：⭐⭐ `ie` 与 `parent_id` **一个都不进改列**，这是刻意的（§6.3 第 1 条）：
   * 改 `ie` ⇒ 历史流水整批跨到另一侧（「支出」变「收入」），而流水那条记录上**什么都没变**；
   * 改 `parent_id` ⇒ 那是「搬家」，是另一件事。
   */
  updateLedgerCategory(uid, id, values, stamp) {
    const d = this._dataFor('ledger_categories');
    const row = (d.ledger_categories || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    if (!row) return false;
    const v = values || {};
    row.name = String(v.name);
    row.sort_order = Number(v.sort_order) || 0;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：**归档**一个收支分类（`archived_at` 落一个时刻，行留着）。
   *
   * 说明：⭐⭐ 删除＝归档：⛔ 不做物理删、⛔ 不把历史流水挪到「其它」——
   * 流水照旧指着这个 id、名字照显，只是**不再出现在选择器里**。
   * **幂等**：已经归档过的再归档一次不算失败（保住第一次的时刻）——
   */
  archiveLedgerCategory(uid, id, stamp) {
    const d = this._dataFor('ledger_categories');
    const row = (d.ledger_categories || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    if (!row) return false;
    if (row.archived_at == null) row.archived_at = stamp; // ⚠️ 幂等：`COALESCE` 保住第一次的时刻
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：把 `fromId` 下面的**全部二级分类**整批改挂到 `toId` 名下（「移动到其它」，C-29）。
   *
   * 说明：⚠️ 只动 `parent_id` 一列：**名字不变**（「名字不变」）、`ie` 不变
   * （二级的 `ie` 本来就是 NULL、继承父）⇒ 于是「挪一下」这件事在历史流水上**看不出痕迹**。
   * 它**不负责**「`toId` 是不是同一侧的『其它』」—— 那是业务层的口径。
   */
  reassignLedgerCategoryChildren(uid, fromId, toId, stamp) {
    const d = this._dataFor('ledger_categories');
    const u = Number(uid);
    const from = Number(fromId);
    const to = Number(toId);
    let hit = 0;
    (d.ledger_categories || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.parent_id) === from) {
        r.parent_id = to;
        r.updated_at = stamp;
        hit += 1;
      }
    });
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：把**直接挂在** `fromId` 上的记账条目整批改挂到 `toId` 名下（真删除那个分类时用）。
   *
   * 说明：⚠️ ⭐ **只改「直接挂在这个分类上」的那些**（`category_id = fromId`）：挂在它
   * **子分类**名下的流水⛔ 不动 —— 子分类是被**改挂**，它们名下的账跟着子分类走。
   * 只动 `category_id` 一列：金额 / 时刻 / 账户一个字不改（⇒ 余额与快照都不受影响）。
   */
  reassignLedgerCategoryEntries(uid, fromId, toId, stamp) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const from = Number(fromId);
    const to = Number(toId);
    let hit = 0;
    (d.ledger_entries || []).forEach((r) => {
      if (uidOf(r) === u && Number(r.category_id) === from) {
        r.category_id = to;
        r.updated_at = stamp;
        hit += 1;
      }
    });
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：**取消归档**一个收支分类（把 `archived_at` 清成 `null`，其余一个字不动）。
   *
   * 说明：⭐ 它就是「删除＝归档」那条口径的**回程**：归档是行留着、只在
   * 选择器里消失；恢复就是让那一行**重新可选**。⚠️ **不判重**：它的全称本来就还占着。
   * 返回 `false` 只表示「不是这个账号的 / 压根不存在」——「本来就没归档」那条判据
   */
  restoreLedgerCategory(uid, id, stamp) {
    const d = this._dataFor('ledger_categories');
    const row = (d.ledger_categories || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    if (!row) return false;
    row.archived_at = null;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return true;
  },

  /**
   * 功能：**硬删**一个收支分类行（⛔ 与「归档」是两件事：这个删完那一行就没了）。
   *
   * 说明：⭐⭐ 它**只管删这一行**（⛔ 不碰流水、不碰子分类、不碰默认账户）：那三件事的顺序
   * 与落点**全住业务层**（`ledgerDeleteCategory`）——「一个原语一件事」。
   * 越权与不存在在这一层是同一件事（回 `false`）。
   */
  deleteLedgerCategory(uid, id) {
    const d = this._dataFor('ledger_categories');
    const u = Number(uid);
    const c = Number(id);
    const list = d.ledger_categories || [];
    const kept = list.filter((r) => !(uidOf(r) === u && Number(r.id) === c));
    const hit = kept.length !== list.length;
    if (hit) {
      d.ledger_categories = kept;
      this._saveJson(SCHEMA.LEDGER_DB);
    }
    return hit;
  },

  /**
   * 功能：**幂等地**把预置的 22 行收支分类灌进这个账号（⭐ 全部标 `builtin = 1`）。
   *
   * 说明：⭐⭐ 判据是「**这个账号一个分类都没有**」而不是「缺哪行补哪行」：按后者的话，
   * `sort_order` 直接取**数组下标**（0 起，跨两侧全局编号）。
   * 起这批预置就是**内置分类**（既定的 22 行）⇒ `builtin` 写 `1`。
   */
  seedLedgerCategories(uid, stamp) {
    const d = this._dataFor('ledger_categories');
    const u = Number(uid);
    if (!Array.isArray(d.ledger_categories)) d.ledger_categories = [];
    if (d.ledger_categories.some((r) => uidOf(r) === u)) return 0;
    CATEGORY_PRESETS.forEach((c, i) => {
      d.ledger_categories.push({
        id: d._seq,
        user_id: u,
        parent_id: null,
        name: String(c.name),
        ie: c.ie == null ? null : String(c.ie),
        sort_order: i,
        builtin: 1,
        archived_at: null,
        created_at: stamp,
        updated_at: stamp,
      });
      d._seq += 1;
    });
    this._saveJson(SCHEMA.LEDGER_DB);
    return CATEGORY_PRESETS.length;
  },

  /**
   * 功能：把本账号的收支分类**对齐到内置清单** —— 补全内置 ＋（硬）删掉旧预置。
   *
   * 说明：⭐⭐ 与 SQLite 侧**逐字同一语义**（那边是一个事务，这边全改完再落一次盘）。
   * 顺序**不能颠倒**（① 必须在 ② 之前）：② 要把旧预置的二级分类挪到「其它」下面，
   * 而「其它」得先由 ① 保证存在。
   */
  restoreBuiltinCategories(uid, stamp) {
    const d = this._dataFor('ledger_categories');
    const u = Number(uid);
    if (!Array.isArray(d.ledger_categories)) d.ledger_categories = [];
    const all = d.ledger_categories;
    const mine = () => all.filter((r) => uidOf(r) === u);
    const newNames = new Set(CATEGORY_PRESETS.map((p) => String(p.name)));
    const legacyNames = new Set(LEGACY_PRESET_NAMES.map((n) => String(n)));
    let removed = 0;
    let added = 0;
    let marked = 0;
    let moved = 0;

    // ① 补全内置（⛔ 必须在 ② 之前 —— ② 需要「其它」已经存在当落点）
    CATEGORY_PRESETS.forEach((p, i) => {
      const hit = mine()
        .filter((r) => r.parent_id == null && String(r.ie) === String(p.ie) && String(r.name) === String(p.name))
        .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))[0];
      if (hit) {
        // 已归档的也算「找到」——只标 `builtin`，**不动** `archived_at`；本来已是内置则不改（幂等）
        if (Number(hit.builtin) !== 1) {
          hit.builtin = 1;
          hit.updated_at = stamp;
          marked += 1;
        }
        return;
      }
      all.push({
        id: d._seq,
        user_id: u,
        parent_id: null,
        name: String(p.name),
        ie: String(p.ie),
        sort_order: i,
        builtin: 1,
        archived_at: null,
        created_at: stamp,
        updated_at: stamp,
      });
      d._seq += 1;
      added += 1;
    });

    // ② 清旧预置（只认一级、且名字在旧名单里又不在新清单里）
    const doomed = mine().filter(
      (r) => r.parent_id == null && Number(r.builtin) !== 1 && legacyNames.has(String(r.name)) && !newNames.has(String(r.name)),
    );
    for (const row of doomed) {
      // 落点必须是**同一侧**的「其它」（`row.ie`）——挪到另一侧就是把支出静默变成收入
      const other = mine().find((c) => c.parent_id == null && isOther(c, row.ie));
      if (other) {
        // 只挪**未归档**的二级分类（已归档的本来就该留在归档区里）
        mine().forEach((k) => {
          if (Number(k.parent_id) === Number(row.id) && k.archived_at == null) {
            k.parent_id = Number(other.id);
            k.updated_at = stamp;
            moved += 1;
          }
        });
      }
      const idx = all.indexOf(row);
      if (idx >= 0) {
        all.splice(idx, 1);
        removed += 1;
      }
    }

    // ③ 顺手清掉这些分类身上的「每种类别的默认账户」行 —— 分类已经没了，那一行就是**指向不存在分类的孤行**。
    // 它不会串到新分类上（json 后端的 id 取自全局 `_seq`、不复用），界面也看不见
    // （两端都拿 `state.lgCats` 回查，查不到就不画）—— 但留着它就是**永远读不到的垃圾**，
    if (doomed.length) {
      const gone = new Set(doomed.map((r) => Number(r.id)));
      const dd = this._dataFor('ledger_default_accounts');
      dd.ledger_default_accounts = (dd.ledger_default_accounts || []).filter(
        (r) => !(uidOf(r) === u && String(r.kind) === 'category' && gone.has(Number(r.category_id))),
      );
    }

    this._saveJson(SCHEMA.LEDGER_DB);
    return { removed, added, marked, moved };
  },

  // ---- 默认账户（2 期， 第 19 条）----
  /**
   * 功能：取本账号的全部默认账户行（全局两层 ＋ 每类别一层，一张表装两层）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 默认账户行数组
   */
  listLedgerDefaults(uid) {
    const d = this._dataFor('ledger_default_accounts');
    const u = Number(uid);
    return (d.ledger_default_accounts || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => {
        const ka = String((a && a.kind) || '');
        const kb = String((b && b.kind) || '');
        if (ka !== kb) return ka < kb ? -1 : 1;
        const ca = Number((a && a.category_id) || 0);
        const cb = Number((b && b.category_id) || 0);
        if (ca !== cb) return ca - cb;
        return Number(a.id || 0) - Number(b.id || 0);
      });
  },

  /**
   * 功能：写一行默认账户（**upsert**：`(user_id, kind, category_id)` 是唯一落点）。
   *
   * （界面上会出现两个「默认账户」，而且谁生效看的是查出来的先后，静默且难查）。
   * 全局两层传 `categoryId = 0`（**哨兵，不是 NULL**）：SQLite 的 `UNIQUE` 把 NULL 当互不相等，
   *
   */
  upsertLedgerDefault(uid, kind, categoryId, accountId, stamp) {
    const d = this._dataFor('ledger_default_accounts');
    const u = Number(uid);
    const k = String(kind);
    const c = Number(categoryId) || 0;
    if (!Array.isArray(d.ledger_default_accounts)) d.ledger_default_accounts = [];
    let row = d.ledger_default_accounts.find(
      (r) => uidOf(r) === u && String(r.kind) === k && Number(r.category_id) === c,
    );
    if (!row) {
      row = { id: d._seq, user_id: u, kind: k, category_id: c, account_id: Number(accountId), created_at: stamp };
      d._seq += 1;
      d.ledger_default_accounts.push(row);
    }
    row.account_id = Number(accountId);
    row.updated_at = stamp;
    if (row.created_at === undefined) row.created_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：删一行默认账户（**只该用于「每类别」那一层**）。
   *
   * 说明：⚠️ 全局两层（`kind` 为 `income` / `expense`）**不可以删** —— 那条判据住业务层
   * （全局默认是固定两层、只能改）。本层不管这件事，只是把行删掉。
   *
   */
  deleteLedgerDefault(uid, kind, categoryId) {
    const d = this._dataFor('ledger_default_accounts');
    const u = Number(uid);
    const k = String(kind);
    const c = Number(categoryId) || 0;
    const before = (d.ledger_default_accounts || []).length;
    d.ledger_default_accounts = (d.ledger_default_accounts || []).filter(
      (r) => !(uidOf(r) === u && String(r.kind) === k && Number(r.category_id) === c),
    );
    const hit = d.ledger_default_accounts.length < before;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  // ---- 删除记录（2 期）----
  /**
   * 功能：往「删除记录」表里记一行（同账号同账户重复写收敛成一行）。
   *
   * 说明：⭐ 这张表存在的**唯一理由**是 `name`：账户被硬删之后，
   * 转账 / 流水 / 手动调整还指着那个**原 id**，要显示「原账户名」全靠它。
   */
  insertLedgerAccountDeletion(uid, accountId, name, stamp) {
    const d = this._dataFor('ledger_account_deletions');
    const u = Number(uid);
    const a = Number(accountId);
    if (!Array.isArray(d.ledger_account_deletions)) d.ledger_account_deletions = [];
    let row = d.ledger_account_deletions.find((r) => uidOf(r) === u && Number(r.account_id) === a);
    if (!row) {
      row = { id: d._seq, user_id: u, account_id: a, name: String(name), deleted_at: stamp };
      d._seq += 1;
      d.ledger_account_deletions.push(row);
    }
    row.name = String(name);
    row.deleted_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：取本账号的全部删除记录（老的在前）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 删除记录行数组
   */
  listLedgerAccountDeletions(uid) {
    const d = this._dataFor('ledger_account_deletions');
    const u = Number(uid);
    return (d.ledger_account_deletions || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  },

  /**
   * 功能：**一次性**删一个账户 —— 「写一行删除记录 ＋ 硬删账户行」要么全做要么全不做。
   *
   * 说明：⭐⭐⭐ 这是 2 期改掉 1 期行为的那一处：1 期是「硬删账户 ＋ 连带删掉
   * 所有与它有关的转账明细」，现在是「**写删除记录 ＋ 硬删账户行**」——
   * 转账 / 流水 / 手动调整**一条都不动**（它们的 id 照旧指着那个已经没有行的账户）。
   */
  deleteLedgerAccountWithRecord(uid, id, name, stamp) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    const a = Number(id);
    const dels = (d.ledger_account_deletions = d.ledger_account_deletions || []);
    let rec = dels.find((r) => uidOf(r) === u && Number(r.account_id) === a);
    if (!rec) {
      rec = { id: d._seq, user_id: u, account_id: a, name: String(name), deleted_at: stamp };
      d._seq += 1;
      dels.push(rec);
    }
    rec.name = String(name);
    rec.deleted_at = stamp;
    const rows = d.ledger_accounts || [];
    const i = rows.findIndex((r) => uidOf(r) === u && Number(r.id) === a);
    if (i >= 0) rows.splice(i, 1);
    this._saveJson(SCHEMA.LEDGER_DB);
    return i >= 0;
  },

  /**
   * 功能：取「账户 id → 名字」的**合并视图** —— 账户表 ∪ 删除记录表（C-8 的唯一判据）。
   *
   * 说明：⭐⭐ 为什么必须合成一处：转账明细、流水列表、账户筛选**都要**
   * 显示账户名，而「先查账户表、查不到再查删除记录表」这条判据写两遍**必然漂移**
   * —— 漂移的表现是「同一个账户，在流水里显示得出名字、在转账明细里显示不出来」。
   */
  ledgerAccountNames(uid) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    const out = (d.ledger_accounts || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
      .map((r) => ({
        id: Number(r.id),
        name: String(r.name == null ? '' : r.name),
        deleted: false,
        special: Number(r.special) === 1 ? 1 : 0,
      }));
    const seen = new Set(out.map((r) => r.id));
    (d.ledger_account_deletions || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
      .forEach((r) => {
        const id = Number(r.account_id);
        if (seen.has(id)) return; // 账户行还在（正常不该发生）⇒ 以账户表为准
        out.push({ id, name: String(r.name == null ? '' : r.name), deleted: true, special: 0 });
      });
    return out;
  },

  // ---- 手动调整余额（2 期， 第 4 / 5 条）----
  /**
   * 功能：取本账号**全部**手动调整记录（按时刻升序）。
   *
   * 说明：⭐ 取数形态选的是**按账号**（而不是按账户）那一种（二选一里的一支），理由有二：
   * 按账户取就变成 N+1；② 账户详情那一屏要的三类混排也只是 JS 里一次 `filter`
   */
  listLedgerAdjustmentsByUser(uid) {
    const d = this._dataFor('ledger_adjustments');
    const u = Number(uid);
    return (d.ledger_adjustments || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => {
        const aa = String(a.at || '');
        const ab = String(b.at || '');
        if (aa !== ab) return aa < ab ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      });
  },

  /**
   * 功能：写一行手动调整记录（**只记数、不改账户**）。
   *
   * 说明：⚠️ 与 `applyLedgerAdjustment` 的分工：这一个只写留痕那一行；
   * 「用户改余额」那条正常路径走 `applyLedgerAdjustment`（它才是一次原子改两处）。
   * `from_fen` / `to_fen` 都是**绝对值**（不是增量）—— 界面要显示「从 X 调整为 Y」。
   */
  insertLedgerAdjustment(uid, values, stamp) {
    const d = this._dataFor('ledger_adjustments');
    const v = values || {};
    const row = {
      id: d._seq,
      user_id: Number(uid),
      account_id: Number(v.account_id),
      at: String(v.at),
      from_fen: Math.trunc(Number(v.from_fen)) || 0,
      to_fen: Math.trunc(Number(v.to_fen)) || 0,
      created_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_adjustments)) d.ledger_adjustments = [];
    d.ledger_adjustments.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：**一次性**把余额钉成一个新值 —— 「写一行调整记录 ＋ 把 `opening_fen` 改成新值」。
   *
   * 说明：⭐⭐ 为什么必须是**一个原语、一次原子写**：这两件事分开写会出现
   * 「留痕说从 2000 调到 5000、而账户的基准其实还是 3000」这种**账实不符**
   * —— 界面上一条漂亮的「从 X 调整为 Y」，余额却对不上它，而且两边都不报错。
   */
  applyLedgerAdjustment(uid, id, fromFen, toFen, at, stamp) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    const a = Number(id);
    const to = Math.trunc(Number(toFen)) || 0;
    const acc = (d.ledger_accounts || []).find((r) => uidOf(r) === u && Number(r.id) === a);
    if (!acc) return null; // ⚠️ 账户不存在 / 不属于本人 ⇒ 一行都不写（等价于 SQLite 那边回滚）
    const row = {
      id: d._seq,
      user_id: u,
      account_id: a,
      at: String(at),
      from_fen: Math.trunc(Number(fromFen)) || 0,
      to_fen: to,
      created_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_adjustments)) d.ledger_adjustments = [];
    d.ledger_adjustments.push(row);
    acc.opening_fen = to;
    acc.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  // ---- 空账户（2 期）----
  /**
   * 功能：取这个账号的**空账户**那一行；还没有时回 `null`（⛔ 不在这里顺手建）。
   *
   * 说明：⚠️ 取与建分成两个原语，为的是**读路径不写库**：`ledgerAccountNames()` / 派生余额
   * （GET 一律无副作用）。
   */
  getLedgerSpecialAccount(uid) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    return (
      (d.ledger_accounts || [])
        .filter((r) => uidOf(r) === u && Number(r.special) === 1)
        .slice()
        .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))[0] || null
    );
  },

  /**
   * 功能：**幂等地**保证这个账号有一行空账户，返回它（已经有了就原样返回）。
   *
   * 说明：⭐⭐ 空账户是一行**真账户**：它有稳定 id、能被流水指着，
   * 只是**不显示、不可删、不参与净值**。
   * 它的属性全部写死在这里（`kind='custom'` / `name='空账户'` / `opening_fen=0` /
   */
  ensureLedgerSpecialAccount(uid, stamp) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    const cur = (d.ledger_accounts || []).find((r) => uidOf(r) === u && Number(r.special) === 1);
    if (cur) return cur;
    const row = {
      id: d._seq,
      user_id: u,
      kind: 'custom',
      name: '空账户',
      tail: null,
      note: null,
      opening_fen: 0,
      sort_order: 0,
      tier: null,
      limit_day_fen: null,
      limit_month_fen: null,
      limit_year_fen: null,
      special: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    d._seq += 1;
    if (!Array.isArray(d.ledger_accounts)) d.ledger_accounts = [];
    d.ledger_accounts.push(row);
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  // ---- 预算（3 期）----
  /**
   * 功能：取**某一期**的全部预算行（总预算 ＋ 分类预算一次给全）。
   *
   * 说明：⭐ 语义与 SQLite 侧逐字一致（`WHERE user_id AND period_type AND period_key`，
   * 按 `category_id` 升序 —— 唯一约束保证它是全序，见 SQLite 侧的说明）。
   */
  selectLedgerBudgets(uid, periodType, periodKey) {
    const d = this._dataFor('ledger_budgets');
    const u = Number(uid);
    const t = String(periodType);
    const k = String(periodKey);
    return (d.ledger_budgets || [])
      .filter((r) => uidOf(r) === u && String(r.period_type) === t && String(r.period_key) === k)
      .slice()
      .sort((a, b) => (Number(a.category_id) || 0) - (Number(b.category_id) || 0));
  },

  /**
   * 功能：设 / 改**一行**额度（**upsert**：`(user_id, period_type, period_key, category_id)` 是唯一落点）。
   *
   * （界面上会出现两份同一期的预算，谁生效看的是查出来的先后，静默且难查）。
   * JSON 这边**没有**数据库级的唯一约束 ⇒ 这个「先找后写」是它唯一的不重复保证
   * （与 `upsertLedgerDefault` / `insertLedgerAccountDeletion` 同款）。
   */
  upsertLedgerBudget(uid, periodType, periodKey, categoryId, amountFen, stamp) {
    const d = this._dataFor('ledger_budgets');
    const u = Number(uid);
    const t = String(periodType);
    const k = String(periodKey);
    const c = Number(categoryId) || 0;
    if (!Array.isArray(d.ledger_budgets)) d.ledger_budgets = [];
    let row = d.ledger_budgets.find(
      (r) => uidOf(r) === u && String(r.period_type) === t && String(r.period_key) === k && (Number(r.category_id) || 0) === c,
    );
    if (!row) {
      row = {
        id: d._seq,
        user_id: u,
        period_type: t,
        period_key: k,
        category_id: c,
        amount_fen: Math.trunc(Number(amountFen)) || 0,
        created_at: stamp,
        updated_at: stamp,
      };
      d._seq += 1;
      d.ledger_budgets.push(row);
    }
    row.amount_fen = Math.trunc(Number(amountFen)) || 0;
    row.updated_at = stamp;
    this._saveJson(SCHEMA.LEDGER_DB);
    return row;
  },

  /**
   * 功能：删**一行**额度（清某一份预算）—— 没删到任何行时回 `false`。
   *
   * 说明：⚠️ 越权与不存在**在这一层是同一件事**（回 `false`）：`user_id` 一起在判据里，
   * 「别人的那一行」与「压根没有那一行」都删不到 ⇒ 上层据此回 404。
   * 「清总预算要连带清掉该期全部分类预算」**不住这里**（那是
   */
  deleteLedgerBudget(uid, periodType, periodKey, categoryId) {
    const d = this._dataFor('ledger_budgets');
    const u = Number(uid);
    const t = String(periodType);
    const k = String(periodKey);
    const c = Number(categoryId) || 0;
    const before = (d.ledger_budgets || []).length;
    d.ledger_budgets = (d.ledger_budgets || []).filter(
      (r) => !(uidOf(r) === u && String(r.period_type) === t && String(r.period_key) === k && (Number(r.category_id) || 0) === c),
    );
    const hit = d.ledger_budgets.length < before;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：⭐ **清掉这一期的全部行**（总预算 ＋ 它名下的所有分类预算）—— 回删掉的行数。
   *
   * 说明：⭐⭐ 「清除总预算」的落点：这一期的行**一次全删**、
   * SQLite 侧把这件事包在 `BEGIN` / `COMMIT` 里；JSON 这边的「一个事务」
   * 就是「**先全部算完、只落一次盘**」（与 `transferLedger` / `reorderRows` 同款）。
   */
  deleteLedgerBudgetsForPeriod(uid, periodType, periodKey) {
    const d = this._dataFor('ledger_budgets');
    const u = Number(uid);
    const t = String(periodType);
    const k = String(periodKey);
    const before = (d.ledger_budgets || []).length;
    d.ledger_budgets = (d.ledger_budgets || []).filter(
      (r) => !(uidOf(r) === u && String(r.period_type) === t && String(r.period_key) === k),
    );
    const hit = before - d.ledger_budgets.length;
    if (hit) this._saveJson(SCHEMA.LEDGER_DB);
    return hit;
  },

  /**
   * 功能：取**区间原料**（记账条目里统计要的那六列）—— ⭐ 区间统计**唯一**的取数口。
   *
   * 「对比上月」，这些全靠**多个区间**的切片 —— 而 2 期只有「按月 ＋ 游标分页」那一个原语
   * （它收 `limit`、只回一页）⇒ 拿它去取 6 个区间就是一串 N+1，而且**页数一满就静默漏数据**。
   * **只回六列**（`id` / `at` / `ie` / `amount_fen` / `category_id` / `refund_of`），
   */
  selectLedgerEntriesBetween(uid, from, to) {
    const d = this._dataFor('ledger_entries');
    const u = Number(uid);
    const lo = from ? String(from) : '';
    const hi = to ? String(to) : '';
    return (d.ledger_entries || [])
      .filter((r) => {
        if (uidOf(r) !== u) return false;
        const at = String((r && r.at) == null ? '' : r.at);
        if (!at) return false;
        if (lo && !(at >= lo)) return false;
        if (hi && !(at < hi)) return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        const aa = String(a.at || '');
        const ab = String(b.at || '');
        if (aa !== ab) return aa < ab ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      })
      .map((r) => ({
        id: Number(r.id),
        at: String(r.at || ''),
        ie: String(r.ie || ''),
        amount_fen: Math.trunc(Number(r.amount_fen)) || 0,
        category_id: r.category_id == null ? null : Number(r.category_id),
        refund_of: r.refund_of == null ? null : Number(r.refund_of),
      }));
  },

  /**
   * 功能：取本账号**全部**预算行（按 期类型 → 期起始日 → 维度 升序）。
   *
   * 说明：⭐⭐ 它的**唯一消费者是个人备份的导入侧**（`store/methods/backup.js` 的 `_planImport`）：
   * 导入时要拿「库里已有的这一期的行」做**去重集**（⛔ 不去重 = 导入两次就多出一份，
   * 而备份文件看上去完全正常）。⚠️ 它**不是**给界面用的（界面按「一期」取数）。
   */
  listLedgerBudgetsByUser(uid) {
    const d = this._dataFor('ledger_budgets');
    const u = Number(uid);
    return (d.ledger_budgets || [])
      .filter((r) => uidOf(r) === u)
      .slice()
      .sort((a, b) => {
        const ta = String(a.period_type || '');
        const tb = String(b.period_type || '');
        if (ta !== tb) return ta < tb ? -1 : 1;
        const ka = String(a.period_key || '');
        const kb = String(b.period_key || '');
        if (ka !== kb) return ka < kb ? -1 : 1;
        const ca = Number(a.category_id) || 0;
        const cb = Number(b.category_id) || 0;
        if (ca !== cb) return ca - cb;
        return Number(a.id || 0) - Number(b.id || 0);
      });
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据。
   *
   * 说明：⭐ 账户 / 快照 / 分类 / 转账都是用户亲手攒下来的东西（换机 / 恢复之后不能丢）
   * 已经交出去的备份快照（与 `exportCalendar` / `exportPomodoro` 同一条理由）。
   * 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   */
  exportLedger(uid) {
    const d = this._dataFor('ledger_accounts');
    const u = Number(uid);
    const copyOf = (k) =>
      JSON.parse(JSON.stringify(d[k] || []))
        .filter((r) => uidOf(r) === u)
        .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    const ledger_accounts = JSON.parse(JSON.stringify(d.ledger_accounts || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const ka = accountSortKey(a);
        const kb = accountSortKey(b);
        return ka[0] - kb[0] || ka[1] - kb[1];
      });
    const ledger_snapshots = JSON.parse(JSON.stringify(d.ledger_snapshots || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const ka = snapshotSortKey(a);
        const kb = snapshotSortKey(b);
        if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
        return ka[1] - kb[1];
      });
    const ledger_views = JSON.parse(JSON.stringify(d.ledger_views || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || Number(a.id) - Number(b.id));
    const ledger_view_tags = copyOf('ledger_view_tags');
    // 转账明细（与 SQLite 侧同序：date 升序 → id 升序）
    const ledger_transfers = JSON.parse(JSON.stringify(d.ledger_transfers || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const da = String(a.date || '');
        const db = String(b.date || '');
        if (da !== db) return da < db ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      });
    // 分组字段（九类的显示顺序 ＋ 内置用途的名字与顺序）也进备份，
    // 与 SQLite 侧同序（scope 升序 → sort_order 升序 → id 升序）
    const ledger_groups = JSON.parse(JSON.stringify(d.ledger_groups || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const sa = String((a && a.scope) || '');
        const sb = String((b && b.scope) || '');
        if (sa !== sb) return sa < sb ? -1 : 1;
        return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || Number(a.id) - Number(b.id);
      });
    // 2 期那四张表与 SQLite 侧同序；
    // 记账条目按 `at` 升序 → id 升序（与 `id` 升序不总是同一个顺序）
    const ledger_entries = JSON.parse(JSON.stringify(d.ledger_entries || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const aa = String(a.at || '');
        const ab = String(b.at || '');
        if (aa !== ab) return aa < ab ? -1 : 1;
        return Number(a.id || 0) - Number(b.id || 0);
      });
    const ledger_categories = JSON.parse(JSON.stringify(d.ledger_categories || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const pa = Number((a && a.parent_id) || 0);
        const pb = Number((b && b.parent_id) || 0);
        if (pa !== pb) return pa - pb;
        const sa = Number((a && a.sort_order) || 0);
        const sb = Number((b && b.sort_order) || 0);
        if (sa !== sb) return sa - sb;
        return Number(a.id || 0) - Number(b.id || 0);
      });
    const ledger_default_accounts = copyOf('ledger_default_accounts');
    const ledger_account_deletions = copyOf('ledger_account_deletions');
    // ：预算额度也进个人备份 —— 它是用户亲手设的额度，
    // 漏了它的表现是「备份看着成功、换机后预算全没了」，而且**不报错**。
    // 排序与 `listLedgerBudgetsByUser()` 逐字一致（期 → 起始日 → 维度 → id）：恢复按这份顺序逐行插。
    const ledger_budgets = JSON.parse(JSON.stringify(d.ledger_budgets || []))
      .filter((r) => uidOf(r) === u)
      .sort((a, b) => {
        const ta = String(a.period_type || '');
        const tb = String(b.period_type || '');
        if (ta !== tb) return ta < tb ? -1 : 1;
        const ka = String(a.period_key || '');
        const kb = String(b.period_key || '');
        if (ka !== kb) return ka < kb ? -1 : 1;
        const ca = Number(a.category_id) || 0;
        const cb = Number(b.category_id) || 0;
        if (ca !== cb) return ca - cb;
        return Number(a.id || 0) - Number(b.id || 0);
      });
    return {
      ledger_accounts,
      ledger_snapshots,
      ledger_views,
      ledger_view_tags,
      ledger_groups,
      ledger_transfers,
      ledger_entries,
      ledger_categories,
      ledger_default_accounts,
      ledger_account_deletions,
      ledger_budgets,
    };
  },
};

module.exports = { ops };
