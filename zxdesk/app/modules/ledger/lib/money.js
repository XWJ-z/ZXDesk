'use strict';
/**
 * modules/ledger/lib/money.js —— 记账的**金额口径**（全项目**唯一出处**）
 * 功能：`parseFen(str)`（「用户输入的字符串 → 整数分」，非法回 null）与
 * `summarize(accounts)`（资产 / 负债 / 净值 ＋ 每组小计）与
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

const { KINDS, sideOf } = require('./kinds.js');

/**
 * 合法金额串的形状 —— `0` ~ `99999999.99`（＝ 9_999_999_999 分）。
 *
 */
const MONEY_RE = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * 功能：把用户输入的金额串解析成**整数分**；非法一律回 `null`（由路由层转成 400）。
 *
 * 说明：⭐ 实现刻意**只做字符串拆分 ＋ 整数加法**，不经过任何浮点乘法：
 * 整数部分 ≤ 8 位、小数部分补齐到 2 位 ⇒ `Number(int) * 100 + Number(frac)` 全程是精确整数。
 * 入参**必须是字符串**：数字类型的 `8.7` 已经在解析成 double 的那一刻丢过精度了，
 */
function parseFen(v) {
  if (typeof v !== 'string' || !MONEY_RE.test(v)) return null;
  const [intPart, fracPart = ''] = v.split('.');
  // 补齐到两位再取前两位：`'8.7'` → `'70'`（＝ 870 分），不是 `'07'`
  const frac = (fracPart + '00').slice(0, 2);
  return Number(intPart) * 100 + Number(frac);
}

/**
 * 功能：把一组账户汇总成**资产 / 负债 / 净值 ＋ 每组小计**。
 *
 * 资产合计 = Σ `opening_fen`（`side = asset`）；
 * 负债合计 = Σ `opening_fen`（`side = debt`，正数表示欠多少）；
 * 净值 = 资产合计 − 负债合计；
 */
function summarize(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  let asset = 0;
  let debt = 0;
  const byKind = new Map();

  for (const r of rows) {
    const side = sideOf(r && r.kind);
    if (!side) continue;
    // 老库 / 手改过的 JSON 里可能是字符串，也会是 undefined ⇒ 统一压成整数（坏值当 0）
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
    // 顺序照 KINDS（`byKind` 是 Map，插入顺序取决于数据 —— 不能拿它当顺序）
    groups: KINDS.filter((k) => byKind.has(k.key)).map((k) => byKind.get(k.key)),
  };
}

/**
 * 功能：按**自定义分类的用途**分组求和 —— 分类视图（「按用途分」）的组小计。
 *
 * 说明：⭐⭐ 组小计给的是**代数和**（该组内 `资产 − 负债`）：
 * 一套用途分组里完全可能同时躺着储蓄卡（资产）和信用卡（负债），
 * 而用户看这一组时问的是「这块事业我净剩多少」—— 所以负债记负号。
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
    // 负债在这一组里是负的（代数和），与「负债合计」那个正数口径刻意不同
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

