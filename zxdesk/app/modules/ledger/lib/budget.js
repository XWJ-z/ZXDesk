'use strict';
/**
 * modules/ledger/lib/budget.js —— 记账的**预算执行度**（纯函数）
 *
 * 功能：把「额度 ＋ 该期的流水」算成界面要的那几个数 —— 本模块（记账）**所有「按区间算钱」的
 *      唯一出处**。导出七个纯函数：
 *      `periodRange` / `usedFen` / `incomeFen` / `remainFen` / `remainPct` / `dailyAvgFen` / `periodLabel`。
 *      ⭐ 另外导出常量 `PERIOD_TYPES`（三档白名单）—— 接口层的入参枚举**必须**用它，
 *      ⛔ 不在 `routes.js` 里再抄一份字面量数组（那就成了第二份真相源，改一处漏一处）。
 *
 * ⚠️  只列了「预算执行度」那五个 —— 第 6 个 `incomeFen()` 是**落地时补的**：
 *    3 期的账单（`ledgerBillView` / `ledgerMonthBill`）同样要按区间算收入，
 *    而「收入不含退款」这条判据必须与 `usedFen()` 的「支出已抵掉退款」**成对**才对得上
 *    （见 `incomeFen()` 的说明）⇒ 放进同一个文件、共用四条口径，⛔ 不在业务层另写一份 sum。
 *
 * ⭐⭐ **为什么要有这个文件**：3 期落库的**只有「额度」一件事**
 *    （`ledger_budgets.amount_fen`，一行 = 一期 × 一个维度 = 该期的 `category_id`）；
 *    「已用 / 剩余 / 剩余 % / 日均」全是**派生量**，⛔ 一个都不建列、⛔ 一个都不缓存
 *    （照 2 期「余额实时算」的先例、项目 的精神）。
 *    算法**只有这一份**（照 2 期 `lib/balance.js` 的先例）：⛔ 前端不算钱、⛔ 两个后端不各写一份。
 *
 * ⭐⭐ **四条口径写死**：
 *    1. **只认记账条目**：`ledger_entries` 一张表说了算 ——
 *       ⛔ 转账（`ledger_transfers`）、⛔ 手动调整余额（`ledger_adjustments`）**都不进分子**
 *       （它们不是收支）。
 *    2. ⭐ **空账户的条目照样计入**：没选账户 ⇒ 落空账户（`special = 1`），
 *       但钱确实花了 ⇒ 判据是**条目本身**，⛔ 不按 `account_id` 过滤。
 *    3. ⭐⭐ **不再有「未来条目跳过」这一条**（0.8.9 修订
 *       「记账时间是设置到 10 月 1 号的，但是收入支出却是实际创建的时间，不对哦，
 *        这个应该按照设置的时间来」——他选的是**全部按设置日期算**）。
 *       ⇒ 从前那句 `at > now` 的排除（2 期/ 最初的「不要立刻少，到呢那天再少」）
 *       **整个撤掉**：一笔日期设在未来的账，**当场**就进它自己那一天的收入 / 支出 / 余额
 *       （余额那条同改，见 `lib/balance.js`）。
 *       ⚠️ 因此本文件的四个纯函数**收到的 `now` 已不再参与判定**（参数暂时留着，
 *       免得改一圈调用方）；`lib/balance.js` 里那个 `now` 同理。
 *    4. ⭐ **不结转**：每期各算各的，上期剩余不滚进来
 *       ⇒ ⛔ 代码里**不要**预留「结转」开关。
 *
 * ⚠️ **期间归属一律按条目的 `at`**（`'YYYY-MM-DD HH:MM:SS'` 定长串，字典序 = 时间序）：
 *    区间判定是**字符串比较**的**左闭右开** `[from, to)`（`at >= from && at < to`）——
 *    照现有先例（`ledger_entries` 刻意没有 `date` 列，2 期 第 1 条）。
 *    ⇒ `to` 是**下一期的第一天**（周 = 下周一、月 = 下月 1 号、年 = 次年 1 月 1 日），
 *    ⛔ 不是「本期的最后一天」—— 后者会把那一天**整天**漏掉（`'2026-09-30' < '2026-09-30 10:00:00'`）。
 *
 * ⚠️⭐ `period_key` **只认「该期的起始日」**（方案 §4.3 说明 2）：周 = 周一、月 = 1 号、
 *    年 = 1 月 1 日，一律 `YYYY-MM-DD`。本文件**不做归一化**（「传进来的必须是起始日」
 *    那条判据住接口层， 不替用户四舍五入到起点）。
 *
 * ⭐ **它是纯函数**：⛔ 不 require `store`、⛔ 不碰数据库、⛔ 不读时钟（「现在」由调用方传 ——
 *    ）、⛔ 不打日志。
 *
 * @author zx
 * @date   2026-09-23
 * @since 0.8.10
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
 * 功能：把 `YYYY-MM-DD` 往后推 `n` 天（`n` 可为负），回新的 `YYYY-MM-DD`。
 *
 * 说明：⭐⭐ 一律走 **UTC** 的整数毫秒运算：`Date.UTC` 没有夏令时、没有本地时区偏移
 *      ⇒ 同一个日期串在任何机器上都得到同一个结果（本项目的日期比较全靠「定长串的字典序」，
 *      这里如果掺进本地时区，跨零点那几天会**静默**差一天）。
 *      ⚠️ 只做「日期 ± 天」这一件事：⛔ 不解析时刻、⛔ 不返回 `Date` 对象（调用方只认定长串）。
 *
 * @param {string} date - `YYYY-MM-DD`
 * @param {number} n - 天数（正数往后、负数往前）
 * @returns {string} 新的 `YYYY-MM-DD`
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
 * 功能：把一个「期」折成**左闭右开**的字典序区间 `{from, to}`（方案 §5.4）。
 *
 * 说明：⭐ 三档的含义（`period_key` = 该期的**起始日**）：
 *      · `week`  ⇒ 该周**周一 00:00:00** ~ **下周一 00:00:00**（自然周，周一为起点 —— C-3 / T39）；
 *      · `month` ⇒ 该月 **1 号** ~ **下月 1 号**；
 *      · `year`  ⇒ 该年 **1 月 1 日** ~ **次年 1 月 1 日**。
 *      ⚠️ `to` 是**下一期的起点**（见文件头：本期的最后一天要整天含住）。
 *      ⚠️ `periodType` 不认识时回 `null`（⛔ 不兜成 `month`：白名单那条判据住接口层，
 *      本层只回答「这个档我认不认」——静默兜底会让一个拼错的档位悄悄按错的口径算账）。
 *
 * @param {string} periodType - `'week'` / `'month'` / `'year'`
 * @param {string} periodKey - 该期的起始日 `YYYY-MM-DD`
 * @returns {?{from: string, to: string}} 区间（左闭右开）；档位不认识时 `null`
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
 *      不再看它是不是「未来」—— 见文件头第 3 条）。
 *      ⭐⭐ 0.8.10（「支出要减去退款」）起，它**同时是两个地方的答案**：
 *      · 预算的「已用」（额度消耗了多少）—— 从 2 期起就是它；
 *      · 流水小计 / 账单卡片与表格 / 排行榜显示的「支出」—— 0.8.9 曾一度改用原额
 *        （`spentFen()`），0.8.10 又回到这里。
 *      ⇒ 「支出」这**同一个词**在界面上只有这一个口径，⛔ 别再让两边分家。
 *      · **退款**的判据是 `refund_of` 非空（⛔ 不按 `ie` 认：退款的 `ie` 由原语写死成收入，
 *        但「这一条是退款」这个身份住 `refund_of` —— 2 期 第 9 条的定义就是它）；
 *      · ⚠️ **空账户的条目照样计入**（口径 2）：本函数⛔ **不看 `account_id`**；
 *      · ⚠️⭐ **未来条目照样算**（0.8.9 起，见文件头第 3 条）：日期晚于「现在」的条目
 *        **照样进合计**（`now` 已不参与判定）；
 *      · ⚠️ 出入参都是**库里的原行**（`at` / `ie` / `amount_fen` / `refund_of` 四列就够）。
 *      ⚠️ 入参数组**可能乱序**（JSON 后端 / 补记都会）⇒ 本函数不假设有序，自己按 `at` 判。
 *
 * @param {Array.<Object>} rows - 记账条目行（`ledger_entries` 的全量或区间切片）
 * @param {string} now - 服务端当前时刻 `YYYY-MM-DD HH:MM:SS`（0.8.9 起已不参与判定）
 * @param {string} from - 区间起点（**含**）`YYYY-MM-DD`
 * @param {string} to - 区间终点（**不含**）`YYYY-MM-DD`
 * @returns {number} 已用（整数分；可以为负 —— 退得比花得多时照实给）
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
 * 说明：⭐⭐ 0.8.9（「记账的退款导致数额不对」＋「显示不应该计入支出，
 *      单独显示 退款 127.5（红色字体）」）：**流水上的「支出」是花出去的原额**，
 *      退款不再从它里面减掉、而是**另占一个数**（`refundFen()`，界面上单独一栏、红字）。
 *      ⚠️ 与 `usedFen()` 是**两个不同的量**，⛔ 别互相替换：
 *      · `usedFen()` = **净支出**（花掉的 − 退回来的）—— 「花 100 退 100 等于没花」的落点；
 *      · `spentFen()` = **原额**（只看花出去的，⛔ 不退减）。
 *      两条口径的分叉点是**唯一的**：退款算不算进支出。⛔ 别在别处再判一次。
 *      ⚠️⭐ **0.8.10（「支出要减去退款」）起，流水 / 账单 / 排行榜一律用净额**
 *      ⇒ 生产代码里 `spentFen()` **当前没有任何调用方**。保留它**是刻意的**：
 *      这条口径十天之内改过两回（0.8.9 换成原额、0.8.10 又换回净额），留着这一层，
 *      将来真要回退时不必重写、也不必再验一遍这条纯函数。
 *      ⚠️ 退款行本身是 `ie='收入'`（2 期原语写死）⇒ 这里天然不会把它加进来；
 *      但下面仍显式挡一次 `refund_of == null`（万一历史数据里 `ie` 被改坏了，方向也是安全的）。
 *      ⚠️ 四条口径与 `usedFen()` 完全一致：只认记账条目 / 空账户照样计 / 未来照样算 / 不结转。
 *
 * @param {Array.<Object>} rows - 记账条目行
 * @param {string} now - 服务端当前时刻 `YYYY-MM-DD HH:MM:SS`（0.8.9 起已不参与判定）
 * @param {string} from - 区间起点（**含**）；空串 = 不限
 * @param {string} to - 区间终点（**不含**）；空串 = 不限
 * @returns {number} 花掉的原额（整数分）
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
 * 说明：⭐⭐ 0.8.9：这是「支出的另一半」，界面上**单独一栏、红字**显示（见 `spentFen()` 的说明）。
 *      判据只有一条：`refund_of` 非空（⛔ 不按 `ie` 认 —— 退款的 `ie` 由原语写死成 `收入`，
 *      而「这一条是退款」这个身份住 `refund_of`，2 期 第 9 条的定义就是它）。
 *      ⚠️ 它**不是收入**：`incomeFen()` 已经把退款排除在外了 ——
 *      三个数一起摆出来看才是那天完整的账：花掉（原额）／退回来／真正赚到。
 *
 * @param {Array.<Object>} rows - 记账条目行
 * @param {string} now - 服务端当前时刻 `YYYY-MM-DD HH:MM:SS`（0.8.9 起已不参与判定）
 * @param {string} from - 区间起点（**含**）；空串 = 不限
 * @param {string} to - 区间终点（**不含**）；空串 = 不限
 * @returns {number} 退款合计（整数分）
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
 * 说明：⭐⭐ 为什么「收入不含退款」（这一条错了会让结余**静默翻倍**）：
 *      退款在这套模型里是**收入侧**的一条条目（`ie = '收入'`，2 期原语写死），
 *      而 `usedFen()` 已经把退款**从支出里减掉**了 —— 若这里再把退款算成收入，
 *      一笔「花了 100、退回来 100」的账会算成「收入 100 / 支出 0 / 结余 +100」，
 *      真相却是「结余 0」（钱又回去了）。⇒ 收入的判据是
 *      `ie = '收入'` **且** `refund_of` 为空（退款不是赚到的钱）。
 *      ⚠️ 它是 3 期**账单**那条线要的（`ledgerBillView` / `ledgerMonthBill` 的收入合计与
 *      收入构成），口径与 `usedFen()` 的四条**完全一致**（只认条目 / 空账户照样计 /
 *      未来照样算 / 不结转），所以两件事共用这一个文件（⛔ 不许在业务层再写一份 sum）。
 *
 * @param {Array.<Object>} rows - 记账条目行
 * @param {string} now - 服务端当前时刻 `YYYY-MM-DD HH:MM:SS`（0.8.9 起已不参与判定）
 * @param {string} from - 区间起点（**含**）`YYYY-MM-DD`；空串 = 不限
 * @param {string} to - 区间终点（**不含**）`YYYY-MM-DD`；空串 = 不限
 * @returns {number} 收入（整数分；不含退款）
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
 * 功能：剩余 ＝ 额度 − 已用（**可以为负** = 超支，方案 §4.5）。
 *
 * 说明：⚠️ 本函数**不认识额度 = 0** 这件事（那是 `remainPct()` 的分母判据）：
 *      「没设预算」与「设成 0 元」在库里是**两件事**（前者没有行、后者 `amount_fen = 0`），
 *      那条区分住业务层（`store.ledgerBudgetView` 的 `set`）。
 *
 * @param {number} amountFen - 额度（整数分）
 * @param {number} used - 已用（整数分，`usedFen()` 的返回值）
 * @returns {number} 剩余（整数分；负数 = 超支）
 */
function remainFen(amountFen, used) {
  return fenOf(amountFen) - fenOf(used);
}

/**
 * 功能：剩余 %（**四舍五入**取整 —— T43 定死）—— 额度为 0 时回 `null`。
 *
 * 说明：⭐⭐ 两条硬口径：
 *      · **四舍五入**（`Math.round`）：图 6 那三处只此一解（`31.68% → 32%`、`50.93% → 51%`、
 *        `4.368% → 4%`）—— ⛔ 别改成 `Math.floor`（那是方案 §9.3 第 6 条反向验证点）；
 *      · **额度 = 0 ⇒ `null`**（⛔ 不除零、⛔ 不给 0）：界面上「剩余 %」那一处要改写成
 *        「已超支」或「未设」，而 `0%` 是一个会被当成真事实的假数。
 *      ⚠️ 超支时回**负数**（照实给，⛔ 不夹到 0）—— 图 6 的 `剩余预算` 就显示负数。
 *
 * @param {number} amountFen - 额度（整数分）
 * @param {number} remain - 剩余（整数分，`remainFen()` 的返回值）
 * @returns {?number} 剩余百分比（整数，可为负）；额度为 0 时 `null`
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
 *      · 分子是 `usedFen()`（＝该期已用，**退款已抵掉**）—— 与预算页 / 账单页的「支出」
 *        同一个数（§7.2 两图互证：账单页「年支出」＝ 预算页「年度支出」），
 *        ⇒ ⛔ **不许在本函数里另加一遍**（那就是第二份分子）；
 *      · 分母是**有支出条目的那些天**（按 `at` 的前 10 个字符去重）—— ⛔ 不是「该期的自然天数」
 *        （那是方案 §9.3 第 8 条反向验证点：换了分母，`日均` 会静默变小）；
 *      · 一天里只有退款（没有支出）**不算**「有支出的天」（那条判据就是 `ie = '支出'`）。
 *      ⚠️ **一天都没有支出 ⇒ 回 0**（⛔ 不除零、⛔ 不回 `null`）：账单详情页那一格是数字位，
 *      `null` 会让它印出 `—`，而「这个月没花钱」与「算不出来」不是一回事。
 *      ⚠️ 取整用 `Math.round`（分是整数，日均照分给；⛔ 不保留小数 —— 全项目的金额都是整数分）。
 *
 * @param {Array.<Object>} rows - 记账条目行
 * @param {string} now - 服务端当前时刻 `YYYY-MM-DD HH:MM:SS`（0.8.9 起已不参与判定）
 * @param {string} from - 区间起点（**含**）`YYYY-MM-DD`
 * @param {string} to - 区间终点（**不含**）`YYYY-MM-DD`
 * @returns {number} 日均支出（整数分；该期没有支出条目时 0）
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
    // ⚠️ 退款不算「有支出的一天」（它的 `ie` 是收入、身份是 `refund_of`）
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
 *      （月档「本月…」、年档「年度…」）—— ⚠️ 年档是「**年度**」而**不是**「本年」，
 *      这是点过头的写法（照参考图 2 / 6）。
 *      ⚠️ 本函数只给**前缀**：「预算 / 支出 / 收入 / 结余」那些词由调用方拼
 *      （⛔ 这里不拼整句 —— 四句话拼法不同，拼错一处就是两端口径不一致）。
 *      ⚠️ 档位不认识 ⇒ 回空串（⛔ 不兜成「本月」：与 `periodRange` 同一条纪律）。
 *
 * @param {string} periodType - `'week'` / `'month'` / `'year'`
 * @returns {string} `本周` / `本月` / `年度`；不认识时 `''`
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
  // ⚠️ `usedFen` = **净支出**（0.8.10 起：预算与流水 / 账单**同一个口径**）；
  //    `refundFen` = 退款合计（明细上那句红字用它）；`spentFen` = 原额（**当前无调用方**，
  //    留着备回退 —— 理由写在它自己的说明里）。
  usedFen,
  spentFen,
  refundFen,
  incomeFen,
  remainFen,
  remainPct,
  dailyAvgFen,
  periodLabel,
};
