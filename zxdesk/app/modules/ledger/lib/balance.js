'use strict';
/**
 * modules/ledger/lib/balance.js —— 记账的**余额派生**（本模块**唯一的算法**，纯函数）
 * 功能：把「账户基准 ＋ 之后发生的变动」算成**当前余额**（整数分）。导出五个纯函数：
 * `signOfKind` / `entryDelta` / `transferDelta` / `balanceOf` / `balancesOf`。
 * @author zx
 * @date   2026-09-22
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/21-记账2期-记账.md §5.4
 */

const { sideOf } = require('./kinds.js');

/**
 * 功能：把一个值压成**整数分**（坏值当 0）。
 *
 * 说明：⚠️ 老库 / 手改过的 JSON 里金额可能是字符串（`'300'`），也可能是 `undefined` ——
 * `Number('abc')` 是 `NaN`、`Math.trunc(NaN)` 还是 `NaN` ⇒ 用 `Number.isFinite` 兜。
 *
 */
function fenOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 功能：取一行变动记录的**时刻**（比较用的字符串键）。
 *
 * 说明：⚠️⭐ 这是本文件**唯一**需要解释的一处：2 期新表（条目 / 手动调整）的时刻列叫 `at`
 * （精确到秒），而 1 期的 `ledger_transfers` 只有一列 `date`（`YYYY-MM-DD`，**结构一字不改**，
 * 有 `at` 就用它（秒级， 第 3 条要的精度）；
 */
function momentOf(row) {
  if (!row) return '';
  if (row.at != null) return String(row.at);
  if (row.date != null) return String(row.date);
  return '';
}

/**
 * 功能：查一个账户类型的**符号**（`+1` 资产侧 / `-1` 负债侧）。
 *
 * 说明：⭐⭐ 这是「余额这个数是什么意思」的**唯一判据**，且**复用** `lib/kinds.js` 的 `sideOf()`
 * —— ⛔ 本文件不自己写「哪几类是负债」（双份判据必然漂移）。
 * **认不出的 `kind` 回 `+1`**（不是回 0、也不抛错）：这样**余额照样算得出来**，
 */
function signOfKind(kind) {
  return sideOf(kind) === 'debt' ? -1 : 1;
}

/**
 * 功能：算**一条记账条目**对某个账户余额的增量（整数分）。
 *
 * 说明：⭐ 公式 = `signOfKind(kind) × (ie === '收入' ? +1: -1) × amountFen`。
 * 验算三例（每一例都是「写反了也不报错」的那一类）：
 * 储蓄卡（资产侧）「支出 1000」⇒ `-1 × ... → −1000`（钱变少 ✓）；
 */
function entryDelta(input) {
  const src = input && typeof input === 'object' ? input : {};
  const dir = src.ie === '收入' ? 1 : -1;
  return signOfKind(src.kind) * dir * fenOf(src.amountFen);
}

/**
 * 功能：算**一笔转账**对**某一端**账户余额的增量（整数分）。
 *
 * 说明：⭐ 公式 = `(role === 'from' ? -1: +1) × signOfKind(kind) × amountFen`，
 * 与 1 期 `store.js` 的 `ledgerTransfer` **逐字一致**（那里 `sign(row) = sideOf(debt) ? -1: +1`、
 * `fromDelta = -amt × sign(from)`、`toDelta = amt × sign(to)`）—— 派生的余额必须与
 */
function transferDelta(input) {
  const src = input && typeof input === 'object' ? input : {};
  const dir = src.role === 'from' ? -1 : 1;
  return dir * signOfKind(src.kind) * fenOf(src.amountFen);
}

/**
 * 功能：算**一个账户**的当前余额（内部实现，假定三个数组**已经属于这个账户**）。
 *
 * 说明：⚠️ 这个函数不住导出表上：它不做分桶、也不做归属过滤（那是两个导出入口的活），
 * 于是 `balancesOf()` 可以「先分桶、逐账户调用」而不必为每个账户重扫全量数组。
 * 基准的取法是 `(at, id)` **取最大**（同一分钟内两笔按落库次序兜底）
 */
function computeOne(account, adjusts, transfers, entries, _now) {
  const me = Number(account && account.id);
  const kind = account && account.kind;
  // 「全部按设置日期算」——「现在」不再参与判定：
  // 未来日期的条目 / 调整**当场生效**（`now` 参数暂时留着，见 `lib/budget.js` 文件头第 3 条）。

  // ① 基准：**时刻最晚**的那一条手动调整；没有就退回建账户时那个数
  let hasBase = false;
  let baseAt = '';
  let baseId = -Infinity;
  let base = fenOf(account && account.opening_fen);
  for (const a of adjusts) {
    const at = momentOf(a);
    if (!at) continue; // 没有时刻的调整不参与
    const id = fenOf(a && a.id);
    if (!hasBase || at > baseAt || (at === baseAt && id > baseId)) {
      hasBase = true;
      baseAt = at;
      baseId = id;
      base = fenOf(a && a.to_fen);
    }
  }

  /**
   * 功能：这一条变动**该不该计入**。
   * 说明：判据只有一条 —— 在基准**之后**（有基准时才判下界）。
   * @param {string} at - 变动时刻
   * @returns {boolean} 计入为 true
   */
  const counts = (at) => {
    if (!at) return false;
    if (hasBase && at <= baseAt) return false;
    return true;
  };

  let total = base;
  for (const e of entries) {
    if (!counts(momentOf(e))) continue;
    total += entryDelta({ kind, ie: e && e.ie, amountFen: e && e.amount_fen });
  }
  for (const t of transfers) {
    if (!counts(momentOf(t))) continue;
    const fromId = Number(t && t.from_id);
    const toId = Number(t && t.to_id);
    // 两个端点都指向同一账户 = 脏数据（一个账户自己转给自己）：**跳过**，
    if (fromId === toId) continue;
    const amountFen = fenOf(t && t.amount_fen);
    if (fromId === me) total += transferDelta({ kind, role: 'from', amountFen });
    else if (toId === me) total += transferDelta({ kind, role: 'to', amountFen });
  }
  return total;
}

/**
 * 功能：算**一个账户**的当前余额（导出入口 —— 会先把三个数组里属于它的行挑出来）。
 *
 * 这样调用方既能「只为一个账户取数」（详情页），也能复用同一份数据。
 * 复杂度是 O(数组长度)：先过滤再算，⛔ 不是对每条变动都去查一次账户。
 *
 */
function balanceOf(opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const account = src.account;
  const me = Number(account && account.id);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const adjusts = arr(src.adjusts).filter((r) => Number(r && r.account_id) === me);
  const entries = arr(src.entries).filter((r) => Number(r && r.account_id) === me);
  const transfers = arr(src.transfers).filter(
    (r) => Number(r && r.from_id) === me || Number(r && r.to_id) === me,
  );
  return computeOne(account, adjusts, transfers, entries, src.now);
}

/**
 * 功能：给**一组账户**各算一遍当前余额 → `{ [accountId]: fen }`。
 *
 * 账户数 × 流水条数 会把一屏的取数变成平方级）。
 * 转账行会进**两个**桶（`from_id` 与 `to_id` 各一个），于是每一端都能算出自己的方向。
 * `from_id === to_id` 的脏行只进一个桶，且 `computeOne` 里会把它跳过（见那里的说明）。
 */
function balancesOf(opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const accounts = Array.isArray(src.accounts) ? src.accounts : [];
  const arr = (v) => (Array.isArray(v) ? v : []);
  const adjBy = new Map();
  const entBy = new Map();
  const txBy = new Map();
  const push = (map, id, row) => {
    if (!Number.isFinite(id)) return;
    const list = map.get(id);
    if (list) list.push(row);
    else map.set(id, [row]);
  };

  for (const r of arr(src.adjusts)) push(adjBy, Number(r && r.account_id), r);
  for (const r of arr(src.entries)) push(entBy, Number(r && r.account_id), r);
  for (const r of arr(src.transfers)) {
    const fromId = Number(r && r.from_id);
    const toId = Number(r && r.to_id);
    push(txBy, fromId, r);
    if (toId !== fromId) push(txBy, toId, r);
  }

  const out = {};
  for (const a of accounts) {
    const id = Number(a && a.id);
    out[id] = computeOne(a, adjBy.get(id) || [], txBy.get(id) || [], entBy.get(id) || [], src.now);
  }
  return out;
}

module.exports = { signOfKind, entryDelta, transferDelta, balanceOf, balancesOf };
