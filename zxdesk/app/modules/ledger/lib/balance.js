'use strict';
/**
 * modules/ledger/lib/balance.js —— 记账的**余额派生**（本模块**唯一的算法**，纯函数）
 *
 * 功能：把「账户基准 ＋ 之后发生的变动」算成**当前余额**（整数分）。导出五个纯函数：
 *      `signOfKind` / `entryDelta` / `transferDelta` / `balanceOf` / `balancesOf`。
 *
 * ⭐⭐ **为什么要有这个文件**（方案 `21` §5.4 /  第 2 条）：
 *    1 期那个手填的数（`ledger_accounts.opening_fen`）是**当前余额本身**；2 期改成
 *    「它是**初始基准**，当前余额实时算」—— 于是「余额」不再是库里某一列的值，
 *    而是一个**派生量**：
 *
 *        基准 = 该账户「**时刻最晚**的那一次手动调整余额」（`ledger_adjustments`）的 `to_fen`
 *               从没调整过 ⇒ 基准 = `opening_fen`（等价于它的第一次调整）
 *        余额 = 基准 ＋ Σ(基准时刻**之后**、该账户发生的变动)
 *        变动 = 记账条目（`entryDelta`）＋ 转账（`transferDelta`）
 *
 *    ⚠️ 这条口径的价值是**第 2 期零迁移**：手填的数原样变成基准，老数据一行不用搬
 *    （另一条路「手填快照」会逼出一次「账实相符重算」或「两套数」）。
 *
 * ⭐⭐ **三条硬约束**（方案 §5.4，每条错了都**不报错**、只是数字悄悄不对）：
 *    1. ⭐⭐ 0.8.9 修订（「记账时间是设置到 10 月 1 号的，但是收入支出却是
 *       实际创建的时间，不对哦，这个应该按照设置的时间来」——他选的是**全部按设置日期算**）：
 *       原来那条「**未来条目不算**」（`at > now` 跳过，2 期 第 7 条）与「未来的手动调整
 *       同样不参与」**整个撤掉** —— 一笔日期设在未来的账，**当场**就进余额。
 *       ⚠️ 于是本文件收到的 `now` **不再参与任何判定**（参数暂时留着，免得改一圈调用方）。
 *    2. **`side` 只认 `lib/kinds.js` 一处**（资产侧 `+1`、负债侧 `−1`）—— 本文件⛔ **不自己写**
 *       「哪几类是负债」。退款也走它。
 *    3. **时刻一律按字符串字典序比**（格式固定 `'YYYY-MM-DD HH:MM:SS'` ⇒ 字典序 = 时间序）——
 *       ⛔ 不 `new Date()`、⛔ 不读系统时钟（「现在」由调用方传）。
 *       ⚠️ 传入的数组**可能乱序**（空库 / JSON 后端 / 补记都会）⇒ 本函数不许假设有序，自己按时刻判。
 *
 * ⭐ **它是纯函数**：⛔ 不 require `store`、⛔ 不碰数据库、⛔ 不读时间、⛔ 不打日志
 *    （所以「两个端点都指向同一账户」那种脏数据是**静默跳过**的 —— 本层没有日志可打，
 *    要留痕请在调用方做）。
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.8.9
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/21-记账2期-记账.md §5.4
 */

const { sideOf } = require('./kinds.js');

/**
 * 功能：把一个值压成**整数分**（坏值当 0）。
 *
 * 说明：⚠️ 老库 / 手改过的 JSON 里金额可能是字符串（`'300'`），也可能是 `undefined` ——
 *      不压成整数的话，`'5' + 1` 会**静默**变成 `'51'`（1 期踩过的那类坑）。
 *      ⚠️ `Number('abc')` 是 `NaN`、`Math.trunc(NaN)` 还是 `NaN` ⇒ 用 `Number.isFinite` 兜。
 *
 * @param {*} v - 待压的值
 * @returns {number} 整数分（非法一律 0）
 */
function fenOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 功能：取一行变动记录的**时刻**（比较用的字符串键）。
 *
 * 说明：⚠️⭐ 这是本文件**唯一**需要解释的一处：2 期新表（条目 / 手动调整）的时刻列叫 `at`
 *      （精确到秒），而 1 期的 `ledger_transfers` 只有一列 `date`（`YYYY-MM-DD`，**结构一字不改**，
 *      方案 §4.2）。⇒ 这里**先认 `at`、再退到 `date`**：
 *      · 有 `at` 就用它（秒级， 第 3 条要的精度）；
 *      · 只有 `date` 的转账行就按**那一天的开头**参与排序 —— 定长串的字典序天然给出这个语义
 *        （`'2026-09-20'` < `'2026-09-20 12:00:00'`），顺手也把「同一天里转账在前、
 *        当天下午的手动调整在后」这件事定死（⛔ 而不是随数组顺序飘）。
 *      ⚠️ 没有任何时刻的行回空串 ⇒ 调用方一律跳过（坏数据不许污染基准）。
 *
 * @param {Object} row - 一行变动记录（`at` 或 `date`）
 * @returns {string} 时刻串；都没有时返回 `''`
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
 *      —— ⛔ 本文件不自己写「哪几类是负债」（双份判据必然漂移）。
 *      依据（方案 §三）：用户永远只填非负数，负债侧在**显示**时加 `−`，
 *      否则「漏一个负号」会变成整体反向的静默错误。
 *      ⚠️⭐ **认不出的 `kind` 回 `+1`**（不是回 0、也不抛错）：这样**余额照样算得出来**，
 *      而 `lib/money.js` 的 `summarize()` 那边仍然**不计入合计**（1 期既有口径：
 *      认不出的行既不进资产也不进负债）。⇒ 坏数据两边的表现都是「看得见、不参与」。
 *
 * @param {string} kind - 九类账户键之一（`lib/kinds.js` 是唯一出处）
 * @returns {number} `+1`（资产侧 / 认不出）或 `-1`（负债侧）
 */
function signOfKind(kind) {
  return sideOf(kind) === 'debt' ? -1 : 1;
}

/**
 * 功能：算**一条记账条目**对某个账户余额的增量（整数分）。
 *
 * 说明：⭐ 公式 = `signOfKind(kind) × (ie === '收入' ? +1: -1) × amountFen`。
 *      验算三例（每一例都是「写反了也不报错」的那一类）：
 *      · 储蓄卡（资产侧）「支出 1000」⇒ `-1 × ... → −1000`（钱变少 ✓）；
 *      · 信用卡（负债侧）「支出 1000」⇒ `+1000`（**欠款增加** ✓）；
 *      · 信用卡「收入（退款）1000」⇒ `−1000`（**欠款减少** ✓）——
 *        这正是 第 9 条点名、1 期踩过的那个坑：按「退出去、加回来」写死会让净值错。
 *      ⚠️ 金额一律**非负**（用户永远只填非负数，方向由 `ie` 与 `signOfKind` 决定）——
 *      收下带符号的数等于让「负负得正」这种错静默反向。
 *      ⚠️ `ie` **只有** `'收入'` / `'支出'` 两个取值⇒ 非 `'收入'` 一律按支出算
 *      （接口层会把别的值挡成 400，这里只是兜底方向）。
 *
 * @param {Object} input - `{ kind, ie, amountFen }`（`kind` = **账户**的类型，不是条目的字段）
 * @returns {number} 增量（整数分；可为负）
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
 *      ⚠️ 与 1 期 `store.js` 的 `ledgerTransfer` **逐字一致**（那里 `sign(row) = sideOf(debt) ? -1: +1`、
 *      `fromDelta = -amt × sign(from)`、`toDelta = amt × sign(to)`）—— 派生的余额必须与
 *      「1 期直接改余额」那套算法**同一个答案**，否则同一条转账在两条路上方向相反。
 *      四种组合的答案（方案 §4.8 那张表）：
 *      · 储蓄卡 → 支付宝：转出 −、转入 +；
 *      · 储蓄卡 → 信用卡（**还款**）：转出 −、**转入 −**（欠款少了）；
 *      · 信用卡 → 储蓄卡（**套现**）：**转出 +**（欠得多了）、转入 +；
 *      · 信用卡 → 另一张信用卡：转出 +、转入 −。
 *      ⭐ **净值在四种组合下都一分不变**（`net = 资产 − 负债`）—— 这正是「转账」的定义：
 *      钱只是从一个账户挪到另一个账户，⛔ 不是收入也不是支出。
 *      ⚠️ `amountFen` 永远是非负数（方向由 `role` 表达）。
 *
 * @param {Object} input - `{ kind, role, amountFen }`（`role` ∈ `'from' | 'to'`）
 * @returns {number} 增量（整数分；可为负）
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
 *      于是 `balancesOf()` 可以「先分桶、逐账户调用」而不必为每个账户重扫全量数组。
 *      ⭐ 基准的取法是 `(at, id)` **取最大**（同一分钟内两笔按落库次序兜底）
 *      ⇒ 同一秒里调了两次，后落库（id 大）的那条赢，顺序永远确定。
 *      ⚠️ **未来的手动调整也不参与**（`at > now` 跳过）—— 与未来条目同一条口径，
 *      否则「未来调一次基」会让今天的余额立刻跳走。
 *
 * @param {Object} account - 账户行（至少要有 `id` / `kind` / `opening_fen`）
 * @param {Array.<Object>} adjusts - **本账户的**手动调整记录（乱序可以）
 * @param {Array.<Object>} transfers - **与本账户有关的**转账（乱序可以）
 * @param {Array.<Object>} entries - **本账户的**记账条目（乱序可以）
 * @param {string} _now - 服务端当前时刻 `'YYYY-MM-DD HH:MM:SS'` —— ⚠️ **0.8.9 起本函数已不读它**
 *      （「未来条目 / 未来调整照样生效」，见文件头第 1 条）。参数留着只为不改一圈调用方。
 * @returns {number} 当前余额（整数分）
 */
function computeOne(account, adjusts, transfers, entries, _now) {
  const me = Number(account && account.id);
  const kind = account && account.kind;
  // ⭐ 0.8.9：「全部按设置日期算」——「现在」不再参与判定：
  //    未来日期的条目 / 调整**当场生效**（`now` 参数暂时留着，见 `lib/budget.js` 文件头第 3 条）。

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
   *      ⚠️ 「不是未来」那一条 0.8.9 已撤（见上面的说明），所以这里只剩基准这一条。
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
    // ⚠️ 两个端点都指向同一账户 = 脏数据（一个账户自己转给自己）：**跳过**，
    //    ⛔ 不许两段都算（那会让余额凭空变两倍）。本层是纯函数、没有日志可打 ⇒ 静默跳过。
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
 * 说明：⭐ 传**全量**数组也行、传**已经分好桶**的数组也行（都是对的，因为挑一次是幂等的）——
 *      这样调用方既能「只为一个账户取数」（详情页），也能复用同一份数据。
 *      ⚠️ 复杂度是 O(数组长度)：先过滤再算，⛔ 不是对每条变动都去查一次账户。
 *
 * @param {Object} opts - `{ account, adjusts, transfers, entries, now }`
 * @param {Object} opts.account - 账户行（至少要有 `id` / `kind` / `opening_fen`）
 * @param {Array.<Object>} [opts.adjusts] - 手动调整记录（全量或只含本账户）
 * @param {Array.<Object>} [opts.transfers] - 转账（全量或只含与本账户有关的）
 * @param {Array.<Object>} [opts.entries] - 记账条目（全量或只含本账户）
 * @param {string} opts.now - 服务端当前时刻 `'YYYY-MM-DD HH:MM:SS'`
 * @returns {number} 当前余额（整数分）
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
 * 说明：⭐⭐ **先按账户分桶、再逐账户算**（⛔ 不许对每个账户重扫全量数组 ——
 *      账户数 × 流水条数 会把一屏的取数变成平方级）。
 *      转账行会进**两个**桶（`from_id` 与 `to_id` 各一个），于是每一端都能算出自己的方向。
 *      ⚠️ `from_id === to_id` 的脏行只进一个桶，且 `computeOne` 里会把它跳过（见那里的说明）。
 *      ⚠️ 返回值用**账户 id** 当键（JS 对象的键是字符串，取用时 `out[id]` 会自动转，照常用）。
 *
 * @param {Object} opts - `{ accounts, adjusts, transfers, entries, now }`（三个数组都传**全量**）
 * @param {Array.<Object>} opts.accounts - 全部账户行
 * @param {Array.<Object>} [opts.adjusts] - 全量手动调整记录
 * @param {Array.<Object>} [opts.transfers] - 全量转账
 * @param {Array.<Object>} [opts.entries] - 全量记账条目
 * @param {string} opts.now - 服务端当前时刻 `'YYYY-MM-DD HH:MM:SS'`
 * @returns {Object} `{ [accountId]: 余额（整数分） }`
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
