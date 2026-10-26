'use strict';
/**
 * modules/ledger/lib/money.js —— 记账的**金额口径**（全项目**唯一出处**）
 *
 * 功能：`parseFen(str)`（「用户输入的字符串 → 整数分」，非法回 null）与
 *      `summarize(accounts)`（资产 / 负债 / 净值 ＋ 每组小计）与
 *      `summarizeTags(accounts, tagOf)`（按自定义分类的用途分组求和 —— 分类视图用）。
 *
 * ⭐⭐ **金额一律整数分**（方案 §三）：库里存分、算的是分，只有**显示**那一步才变成
 *    「1,234.56」这种串。理由是一条实测过的坑：
 *    · `8.7 * 100 === 869.9999999999999`
 *    · `Math.round(1.005 * 100) === 100`（用户填 1.005，静默变成 1.00）
 *    ⇒ ⛔ **绝不用 `Number(x) * 100`、⛔ 绝不用 `Math.round` 兜底** ——
 *    它们都会**静默给错**，而错的是钱。
 *
 * ⭐ **「串 → 分」只住服务端一份**（双份判据必然漂移）。前端只做**另一个方向**的
 *    「分 → 显示」（`public/modules/ledger/calc.js` 的 `fmtFen`），那不算第二份判据。
 *
 * ⭐ **算术也只住服务端一份**（方案 §三）：`summarize()` 是资产 / 负债 / 净值与
 *    每组小计的**唯一实现**，`overview` 直接把它算好的结果回给两端；快照那三个数也用它。
 *    ⛔ 前端**不许再 sum 一遍金额** —— 那会造出两个真相源。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.8.0
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

const { KINDS, sideOf } = require('./kinds.js');

/**
 * 合法金额串的形状 —— `0` ~ `99999999.99`（＝ 9_999_999_999 分）。
 *
 * 说明：⚠️ 整串匹配（`^…$`），所以负号 / `+` / 千分位 / 前后空白 / 三位小数一律**不匹配** ⇒ 400。
 *      整数部分最多 8 位，正好卡住上限 99,999,999.99（方案 §三）。
 * @type {RegExp}
 */
const MONEY_RE = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * 功能：把用户输入的金额串解析成**整数分**；非法一律回 `null`（由路由层转成 400）。
 *
 * 说明：⭐ 实现刻意**只做字符串拆分 ＋ 整数加法**，不经过任何浮点乘法：
 *      整数部分 ≤ 8 位、小数部分补齐到 2 位 ⇒ `Number(int) * 100 + Number(frac)` 全程是精确整数。
 *      ⛔ 超两位小数**直接回 null**（⛔ 不四舍五入、⛔ 不截断）—— 方案 §三  明令。
 *      ⚠️ 入参**必须是字符串**：数字类型的 `8.7` 已经在解析成 double 的那一刻丢过精度了，
 *      收下它就是收下一个可能已经错了的数（⛔ 不静默 `String()` 纠正）。
 *
 * @param {*} v - 用户输入（期望是字符串）
 * @returns {?number} 整数分；非法（负号 / `+` / 千分位 / 空 / 超两位小数 / 超上限 / 非字符串）回 null
 */
function parseFen(v) {
  if (typeof v !== 'string' || !MONEY_RE.test(v)) return null;
  const [intPart, fracPart = ''] = v.split('.');
  // ⚠️ 补齐到两位再取前两位：`'8.7'` → `'70'`（＝ 870 分），不是 `'07'`
  const frac = (fracPart + '00').slice(0, 2);
  return Number(intPart) * 100 + Number(frac);
}

/**
 * 功能：把一组账户汇总成**资产 / 负债 / 净值 ＋ 每组小计**。
 *
 * 说明：⭐⭐ 这是本模块唯一的算法（方案 §4.2）——
 *      · 资产合计 = Σ `opening_fen`（`side = asset`）；
 *      · 负债合计 = Σ `opening_fen`（`side = debt`，正数表示欠多少）；
 *      · 净值 = 资产合计 − 负债合计；
 *      · `groups` **只含有账户的组**（空组整段不画），顺序照 `KINDS`。
 *      ⚠️ 只映事实：⛔ 不算「负债率」、⛔ 不给「健康度」、⛔ 不预测。
 *      ⚠️ 认不出 `kind` 的行**一条都不计入**（既不进合计也不成组）—— 见 `sideOf` 的说明。
 *      ⚠️ 入参的每一行读的是 `opening_fen`（界面叫「余额」，方案 §三  的派生口径）。
 *
 * @param {Array.<Object>} accounts - 账户行数组（至少要有 `kind` 与 `opening_fen`）
 * @returns {{asset_fen: number, debt_fen: number, net_fen: number,
 *      groups: Array.<{kind: string, side: string, total_fen: number, count: number}>}}
 *      资产 / 负债 / 净值（整数分）与各组小计
 */
function summarize(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  let asset = 0;
  let debt = 0;
  const byKind = new Map();

  for (const r of rows) {
    const side = sideOf(r && r.kind);
    if (!side) continue;
    // ⚠️ 老库 / 手改过的 JSON 里可能是字符串，也会是 undefined ⇒ 统一压成整数（坏值当 0）
    const raw = Number(r.opening_fen);
    const fen = Number.isFinite(raw) ? Math.trunc(raw) : 0;
    if (side === 'asset') asset += fen;
    else debt += fen;
    const g = byKind.get(r.kind) || { kind: r.kind, side, total_fen: 0, count: 0 };
    g.total_fen += fen;
    g.count += 1;
    byKind.set(r.kind, g);
  }

  return {
    asset_fen: asset,
    debt_fen: debt,
    net_fen: asset - debt,
    // ⚠️ 顺序照 KINDS（`byKind` 是 Map，插入顺序取决于数据 —— 不能拿它当顺序）
    groups: KINDS.filter((k) => byKind.has(k.key)).map((k) => byKind.get(k.key)),
  };
}

/**
 * 功能：按**自定义分类的用途**分组求和 —— 分类视图（「按用途分」）的组小计。
 *
 * 说明：⭐⭐ 组小计给的是**代数和**（该组内 `资产 − 负债`）：
 *      一套用途分组里完全可能同时躺着储蓄卡（资产）和信用卡（负债），
 *      而用户看这一组时问的是「这块事业我净剩多少」—— 所以负债记负号。
 *      ⚠️ 与 `summarize()` 的「负债合计」**刻意不同**：那里要的是「我一共欠多少」（正数），
 *      这里要的是「这一组净剩多少」（带符号）。两个口径都有用，⛔ 别合并成一个。
 *      ⚠️ 认不出的 `kind` 一条都不计入（与 `summarize()` 同款）——
 *      否则一条脏数据会凭空撑起一个组。
 *      ⚠️ `groups` 的顺序 = **用途第一次出现的顺序**（照 `accounts` 的顺序扫）：
 *      稳定、不随金额跳动，而且与用户在「按账户类型」视图里看到的先后一致。
 *      ⛔ 不在这里排「哪个组金额大」—— 组顺序跳来跳去比金额对不上更让人困惑。
 *
 * @param {Array.<Object>} accounts - 账户行数组（至少要有 `kind` 与 `opening_fen`）
 * @param {Function} tagOf - `(account) => tag | ''`（空 = 这套分类下没分）
 * @returns {{groups: Array.<{tag: string, total_fen: number, count: number}>,
 *      unassigned: {total_fen: number, count: number}}} 各组代数和 ＋ 「其它」那一档
 */
function summarizeTags(accounts, tagOf) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const byTag = new Map();
  let unTotal = 0;
  let unCount = 0;

  for (const r of rows) {
    const side = sideOf(r && r.kind);
    if (!side) continue;
    const raw = Number(r.opening_fen);
    const fen = Number.isFinite(raw) ? Math.trunc(raw) : 0;
    // ⭐ 负债在这一组里是负的（代数和），与「负债合计」那个正数口径刻意不同
    const signed = side === 'debt' ? -fen : fen;
    const tag = String((tagOf && tagOf(r)) || '').trim();
    if (!tag) {
      unTotal += signed;
      unCount += 1;
      continue;
    }
    const g = byTag.get(tag) || { tag, total_fen: 0, count: 0 };
    g.total_fen += signed;
    g.count += 1;
    byTag.set(tag, g);
  }

  return { groups: [...byTag.values()], unassigned: { total_fen: unTotal, count: unCount } };
}

module.exports = { parseFen, summarize, summarizeTags };

