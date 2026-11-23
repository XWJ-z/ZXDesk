'use strict';
/**
 * modules/ledger/lib/budget.js —— 记账的**预算执行度**（纯函数）
 * 功能：把「额度 ＋ 该期的流水」算成界面要的那几个数 —— 本模块（记账）**所有「按区间算钱」的
 * 唯一出处**。导出七个纯函数：
 * @author zx
 * @date   2026-09-23
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/22-记账3期-预算与明细与账单.md §5.4
 */

/** 三档周期 —— ⭐ **唯一出处**：`routes.js` 的入参白名单、`schema.js` 的 `period_type` 注释、
 *  `store.js` 的 `budgetRangeOf()` 都指向这里（⛔ 谁也不许再抄一份字面量数组）。 */
const PERIOD_TYPES = ['week', 'month', 'year'];

/** 一天的毫秒数（本文件只用它做「定长日期串 ± 若干天」的整数运算） */
const DAY_MS = 86400000;

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
 * 功能：把 `YYYY-MM-DD` 往后推 `n` 天（`n` 可为负），回新的 `YYYY-MM-DD`。
 *
 * 说明：⭐⭐ 一律走 **UTC** 的整数毫秒运算：`Date.UTC` 没有夏令时、没有本地时区偏移
 * ⇒ 同一个日期串在任何机器上都得到同一个结果（本项目的日期比较全靠「定长串的字典序」，
 * 这里如果掺进本地时区，跨零点那几天会**静默**差一天）。
 */
function shiftDays(date, n) {
  const p = (x) => String(x).padStart(2, '0');
  const d = String(date || '');
  const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + n * DAY_MS;
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/**
 * 功能：`YYYY-MM-DD` → 它下一个月的 1 号（跨年自动进位）。
 * @param {string} date - `YYYY-MM-DD`（用它的**年与月**，日忽略）
 * @returns {string} 下个月 1 号 `YYYY-MM-DD`
 */
function nextMonthFirst(date) {
  const p = (x) => String(x).padStart(2, '0');
  const d = String(date || '');
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(5, 7));
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return `${ny}-${p(nm)}-01`;
}

/**
 *
 * 说明：⭐ 三档的含义（`period_key` = 该期的**起始日**）：
 */
function periodRange(periodType, periodKey) {
  const t = String(periodType || '');
  const key = String(periodKey || '');
  if (!PERIOD_TYPES.includes(t)) return null;
  if (t === 'week') return { from: key, to: shiftDays(key, 7) };
  if (t === 'month') return { from: key, to: nextMonthFirst(key) };
  return { from: key, to: `${Number(key.slice(0, 4)) + 1}-01-01` };
}

/**
 * 功能：算一个区间的**净支出 / 已用**（整数分）—— 分子只认记账条目，退款要抵掉。
 *
 * 说明：⭐⭐ `净支出 = Σ(区间内 ie='支出' 的金额) − Σ(区间内的退款金额)`（区间内**全部**条目，
 * 不再看它是不是「未来」—— 见文件头第 3 条）。
 * 起，它**同时是两个地方的答案**：
 */
function usedFen(rows, now, from, to) {
  const lo = String(from || '');
  const hi = String(to || '');
  let sum = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at) continue;
    if (lo && at < lo) continue;
    if (hi && at >= hi) continue;
    const fen = fenOf(r && r.amount_fen);
    if (r && r.refund_of != null) sum -= fen;
    else if (String(r && r.ie) === '支出') sum += fen;
  }
  return sum;
}

/**
 * 功能：算一个区间的**花掉的原额**（整数分）—— 只加 `ie='支出'` 的条目，⛔ **不退减退款**。
 *
 * 单独显示 退款 127.5（红色字体）」）：**流水上的「支出」是花出去的原额**，
 * 退款不再从它里面减掉、而是**另占一个数**（`refundFen()`，界面上单独一栏、红字）。
 * 与 `usedFen()` 是**两个不同的量**，⛔ 别互相替换：
 */
function spentFen(rows, now, from, to) {
  const lo = String(from || '');
  const hi = String(to || '');
  let sum = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at) continue;
    if (lo && at < lo) continue;
    if (hi && at >= hi) continue;
    if (r && r.refund_of != null) continue;
    if (String(r && r.ie) === '支出') sum += fenOf(r && r.amount_fen);
  }
  return sum;
}

/**
 * 功能：算一个区间的**退款合计**（整数分）—— 只认退款行。
 *
 * 判据只有一条：`refund_of` 非空（⛔ 不按 `ie` 认 —— 退款的 `ie` 由原语写死成 `收入`，
 * 而「这一条是退款」这个身份住 `refund_of`，2 期 第 9 条的定义就是它）。
 * 它**不是收入**：`incomeFen()` 已经把退款排除在外了 ——
 */
function refundFen(rows, now, from, to) {
  const lo = String(from || '');
  const hi = String(to || '');
  let sum = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at) continue;
    if (lo && at < lo) continue;
    if (hi && at >= hi) continue;
    if (r && r.refund_of != null) sum += fenOf(r && r.amount_fen);
  }
  return sum;
}

/**
 * 功能：算一个区间的**收入**（整数分）—— 与 `usedFen()` 逐字对称，**⛔ 不含退款**。
 *
 * 退款在这套模型里是**收入侧**的一条条目（`ie = '收入'`，2 期原语写死），
 * 而 `usedFen()` 已经把退款**从支出里减掉**了 —— 若这里再把退款算成收入，
 * 一笔「花了 100、退回来 100」的账会算成「收入 100 / 支出 0 / 结余 +100」，
 */
function incomeFen(rows, now, from, to) {
  const lo = String(from || '');
  const hi = String(to || '');
  let sum = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at) continue;
    if (lo && at < lo) continue;
    if (hi && at >= hi) continue;
    if (r && r.refund_of != null) continue;
    if (String(r && r.ie) === '收入') sum += fenOf(r && r.amount_fen);
  }
  return sum;
}

/**
 *
 * 说明：⚠️ 本函数**不认识额度 = 0** 这件事（那是 `remainPct()` 的分母判据）：
 */
function remainFen(amountFen, used) {
  return fenOf(amountFen) - fenOf(used);
}

/**
 * 功能：剩余 %（**四舍五入**取整 —— T43 定死）—— 额度为 0 时回 `null`。
 *
 * 说明：⭐⭐ 两条硬口径：
 * **四舍五入**（`Math.round`）：图 6 那三处只此一解（`31.68% → 32%`、`50.93% → 51%`、
 * **额度 = 0 ⇒ `null`**（⛔ 不除零、⛔ 不给 0）：界面上「剩余 %」那一处要改写成
 */
function remainPct(amountFen, remain) {
  const a = fenOf(amountFen);
  if (!a) return null;
  return Math.round((fenOf(remain) / a) * 100);
}

/**
 * 功能：日均支出 ＝ 该期支出 ÷ **有支出的天数**（T42 定死；⛔ 不是 ÷ 该期天数）。
 *
 * 说明：⭐⭐ 三条：
 * 分子是 `usedFen()`（＝该期已用，**退款已抵掉**）—— 与预算页 / 账单页的「支出」
 * 同一个数（§7.2 两图互证：账单页「年支出」＝ 预算页「年度支出」），
 */
function dailyAvgFen(rows, now, from, to) {
  const lo = String(from || '');
  const hi = String(to || '');
  const days = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at) continue;
    if (lo && at < lo) continue;
    if (hi && at >= hi) continue;
    // 退款不算「有支出的一天」（它的 `ie` 是收入、身份是 `refund_of`）
    if (r && r.refund_of != null) continue;
    if (String(r && r.ie) !== '支出') continue;
    days.add(at.slice(0, 10));
  }
  if (!days.size) return 0;
  return Math.round(usedFen(rows, now, from, to) / days.size);
}

/**
 * 功能：三档周期的**中文标签前缀**（周 = 「本周」/ 月 = 「本月」/ 年 = 「年度」）。
 *
 * 说明：⭐ 口径来自 T48-③（周档写「本周预算 / 本周支出」）与 §7.2 的「标签随档变」
 * （月档「本月…」、年档「年度…」）—— ⚠️ 年档是「**年度**」而**不是**「本年」，
 * 这是点过头的写法（照参考图 2 / 6）。
 */
function periodLabel(periodType) {
  if (periodType === 'week') return '本周';
  if (periodType === 'month') return '本月';
  if (periodType === 'year') return '年度';
  return '';
}

module.exports = {
  PERIOD_TYPES,
  periodRange,
  // `refundFen` = 退款合计（明细上那句红字用它）；`spentFen` = 原额（**当前无调用方**，
  // 留着备回退 —— 理由写在它自己的说明里）。
  usedFen,
  spentFen,
  refundFen,
  incomeFen,
  remainFen,
  remainPct,
  dailyAvgFen,
  periodLabel,
};
