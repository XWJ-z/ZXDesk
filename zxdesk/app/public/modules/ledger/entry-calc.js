/**
 * modules/ledger/entry-calc.js —— 记账 2 期「流水」那一套**两端共用**的纯展示函数（0.8.1）
 *
 * 功能：· 取数：`ENTRY_PAGE_SIZE` / `CURSOR_SEP` / `buildCursor()` / `parseCursor()`（按月 ＋ **游标**，C-15 / C-16）；
 *      · 列表：`groupByDay()`（按天分组）、`monthOptions()`（月份下拉的选项）；
 *      · 文案：`CAT_UNCLASSIFIED` / `CAT_OTHER` / `catName()`（「未分类」与「其它」**必须分得开**，C-32）、
 *        `refundNoteOf()` / `isRefund()` / `entryTitle()`（原消费行上的「已退款」小字与行标题，C-24）；
 *      · 颜色：`changeTone()` / `TONE_VARS` / `TONE_COLORS` / `toneStyle()`（账户详情三类变动的**三档颜色**，C-21）；
 *      · 分类：`topCats()` / `childCats()` / `hasKids()` / `catTree()`（一级 / 二级的**过滤与两级树** ——
 *        分类选择器、二级屏、分类管理**共用唯一判据**，⛔ 两端不许再手写 `filter`）；
 *      · 其它：`signedFen()`（带符号的整数分，**只做展示符号**）、`matchNote()`（备注候选的**本地**过滤）。
 *
 * ⭐ **为什么单开一个文件**（C-39 /）：`calc.js` 已经有 1100+ 行（1 期六批攒的），
 *    2 期的流水展示函数再塞进去就破了「JS > 800 行该拆」那条线 ⇒ 流水那一套单独一份。
 *    ⚠️ 它与 `calc.js` **不是两个真相源**：金额格式化（`fmtFen`）与「眼睛」的掩码、月份口径
 *    （`monthOptionsOf`）都**直接 import 复用 calc.js 那一份**，本文件只做**入参归一化**，
 *    ⛔ 一个实现都不复制（双份判据必然漂移）。
 *
 * ⭐ **两端共用一份**：`desktop.js` / `mobile.js` 与测试都从这里 import，
 *    ⛔ 不许谁各写一份判据。⚠️ 但**版式与 CSS 仍然两端各一份**—— 共用的是口径，不是界面。
 *
 * ⛔ **本文件不产生任何「钱」的结论**：账户余额是**服务端**算的（第 2 条 /，
 *    算法住 `modules/ledger/lib/balance.js`）—— 前端再算一遍就是第二个真相源。
 *    ⚠️ `groupByDay()` 里那两个 `*_fen` 是**当页按天的小计**（给人看「这天花了多少」），
 *    ⛔ 不是余额、⛔ 不进快照、⛔ 不与服务端的合计比对。
 *
 * ⛔ **零依赖、零出网**（铁律 5 /）：色值是**内置常量**（见 `TONE_COLORS`），⛔ 不联网取任何东西。
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.8.9
 * 相关：docs/公共/开发方案/21-记账2期-记账.md、docs/公共/架构文档/23-记账.md、./calc.js
 */

import { IE_EXPENSE, IE_INCOME, fmtFen, monthOf, monthOptionsOf } from './calc.js';

/**
 * 一次加载多少条流水（C-16）。
 *
 * 说明：是「一次大概加载 20-30 条即可」，方案定 **30** ⇒ 它就是**这个数**。
 *      ⚠️ 它必须与**服务端**的 `limit` 上限同值（`routes.js` 的校验表：1~30，> 30 ⇒ 400 ——
 *       不静默截断」）。⛔ 别只改这一头：改了服务端不收就等于**每次翻页都 400**。
 * @type {number}
 */
export const ENTRY_PAGE_SIZE = 30;

/**
 * 游标串的分隔符 —— `'<at>|<id>'`（C-15）。
 *
 * 说明：⚠️ 游标是**不透明串**（服务端只按 `at < before` 取数），但两端要能拼能解 ⇒ 口径住这里。
 *      `|` 不会出现在 `at`（`'YYYY-MM-DD HH:MM:SS'`）里，所以整串按**第一个** `|` 切就是安全的。
 * @type {string}
 */
export const CURSOR_SEP = '|';

/** `at` 的合法形状（服务端 `ledger_entries.at` 逐字同款：`'YYYY-MM-DD HH:MM:SS'`） */
const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 功能：把一条流水的 `(时刻, id)` 拼成游标串（`'<at>|<id>'`）。
 *
 * 说明：⭐ **分页只用游标、⛔ 不用 offset**（C-15 /  第 3 条）：中途有人插了一笔，
 *      offset 会漂 ⇒ 翻页**重复或漏行**，而这件事**不报错**（对话那条 `before` 游标就是这么定的）。
 *      ⚠️ 形状不对（`at` 不是 `'YYYY-MM-DD HH:MM:SS'` / `id` 不是非负整数）⇒ 回 `null`：
 *      ⛔ **不许拼一个"看着能用"的串** —— 拼错的游标会让下一页**静默翻错地方**。
 *
 * @param {string} at - 服务端给的时刻（`'YYYY-MM-DD HH:MM:SS'`）
 * @param {number} id - 这一行的 id
 * @returns {?string} 游标串；形状不对时 `null`
 */
export function buildCursor(at, id) {
  const a = String(at == null ? '' : at);
  const n = Number(id);
  if (!AT_RE.test(a)) return null;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return `${a}${CURSOR_SEP}${n}`;
}

/**
 * 功能：把游标串解回 `{ at, id }`；**非法串一律回 `null`**。
 *
 * 说明：⚠️⭐ 三种非法输入都必须回 `null`（⛔ 不许抛、⛔ 也不许"静默返回一个能用的默认值"）：
 *      · 非字符串 / 空串（`''` / `null` / `undefined`）；
 *      · 形状不对（`'abc'`、"只按 `|` 切两段"都不成立）；
 *      · `id` 那一段不是纯数字。
 *      ⇒ 调用方（`desktop.js` / `mobile.js`）看到 `null` 就**当成"没有游标"**（＝从头取这一页），
 *      而不是拿一个猜出来的值去请求 —— 那会**静默翻错页**（不报错，只是列表对不上）。
 *
 * @param {string} s - 游标串
 * @returns {?{at: string, id: number}} 解出来的 `{ at, id }`；非法串回 `null`
 */
export function parseCursor(s) {
  if (typeof s !== 'string' || !s) return null;
  const i = s.indexOf(CURSOR_SEP);
  if (i <= 0) return null;
  const at = s.slice(0, i);
  const tail = s.slice(i + CURSOR_SEP.length);
  if (!AT_RE.test(at) || !/^\d+$/.test(tail)) return null;
  const id = Number(tail);
  return Number.isSafeInteger(id) ? { at, id } : null;
}

/**
 * 功能：把一页流水**按天分组** —— 天按倒序、天内按 `(at, id)` 倒序（C-2）。
 *
 * 说明：⭐ 排序口径与取数口径**同一套**（`(时刻, id)` 倒序）——
 *      所以"服务端已经排好"这件事在分组之后**依然成立**，两端不需要各自再排一遍。
 *      ⚠️ 同一分钟内的两笔按 **`id` 倒序**兜底（C-2：顺序永远确定，⛔ 不出现"随机顺序"）。
 *      ⚠️⭐ **缺 `at` 的行一条都不许丢**（脏数据 / 服务端变更）：它们落到 `date: ''` 那一组，
 *      排在最后 —— ⛔ 不 `throw`（渲染路径上抛一下整屏就白，本项目一贯口径：坏数据只许降级）。
 *      ⚠️ 按天的小计取的是 `amount_fen` 的**绝对值**（`ie` 表达方向），
 *      且认不出的 `ie` **不计入任何一边**（既不进收入也不进支出 —— 记下"这笔我没看懂"，
 *      ⛔ 别把它悄悄算成支出）。
 *      ⛔ **它不是余额**：余额只住服务端（见文件头那句）。
 *
 * @param {Array.<Object>} rows - 一页流水（`{at, id, ie, amount_fen, …}`）
 * @param {string} [key] - 时刻字段名（默认 `'at'`；留个口子给将来别的行类型）
 * @returns {Array.<{date: string, items: Array.<Object>, income_fen: number, expense_fen: number}>}
 *      按天倒序的组；`date` 为空串的那一组是「时刻缺失」的兜底
 */
export function groupByDay(rows, key = 'at') {
  const list = Array.isArray(rows) ? rows : [];
  const k = String(key || 'at');
  const buckets = new Map();

  for (const r of list) {
    const at = String((r && r[k]) == null ? '' : r[k]);
    const day = at.slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
    let g = buckets.get(date);
    if (!g) {
      g = { date, items: [], income_fen: 0, expense_fen: 0 };
      buckets.set(date, g);
    }
    g.items.push(r);
    const raw = Number(r && r.amount_fen);
    const amt = Math.abs(Number.isFinite(raw) ? Math.trunc(raw) : 0);
    const ie = String((r && r.ie) == null ? '' : r.ie);
    if (ie === IE_EXPENSE) g.expense_fen += amt;
    else if (ie === IE_INCOME) g.income_fen += amt;
  }

  const out = [...buckets.values()].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const atOf = (row) => String((row && row[k]) == null ? '' : row[k]);
  for (const g of out) {
    g.items.sort((x, y) => {
      const ax = atOf(x);
      const ay = atOf(y);
      if (ax !== ay) return ax < ay ? 1 : -1;
      return (Number(y && y.id) || 0) - (Number(x && x.id) || 0);
    });
  }
  return out;
}

/**
 * 功能：月份下拉该有哪些选项 —— 有记录的月份 ∪ **服务端今天那个月**。
 *
 * 说明：⭐ 口径**逐字复用 1 期**（`calc.js` 的 `monthOptionsOf`：去重 ＋ `.sort().reverse()`，
 *      新的在前）—— ⛔ 这里**不另立第二种顺序**（同一个下拉在两端、两屏里必须长得一样）。
 *      本函数只多做一件事：把入参**归一化** —— 调用方可能给「月份键 `'2026-09'`」，
 *      也可能直接给流水行（`.at` / `.date`），甚至给 `overview` 里的月份串：
 *      一律折成 `{date: '<月>-01'}` 再交给那份唯一的实现。
 *      ⚠️ 「今天那个月」**永远在选项里**（哪怕一条记录都没有）—— 一进来看到的是
 *      「这个月 + 暂无数据」，而不是一颗空下拉。⚠️ 今天来自**服务端**。
 *
 * @param {Array.<(string|Object)>} months - 月份键 / 流水行 / 任何带 `date`|`at`|`month` 的对象
 * @param {string} todayMonth - 服务端今天（`'YYYY-MM-DD'` 或 `'YYYY-MM'`）
 * @returns {Array.<string>} 月份键数组（`YYYY-MM`，**倒序**）
 */
export function monthOptions(months, todayMonth) {
  const rows = [];
  for (const m of Array.isArray(months) ? months : []) {
    const raw = m && typeof m === 'object' ? m.date || m.at || m.month : m;
    const key = monthOf(raw);
    if (key) rows.push({ date: `${key}-01` });
  }
  return monthOptionsOf(rows, todayMonth);
}

/**
 * 「没选分类」的显示 —— 与 `CAT_OTHER` **是两个不同的字符串**（C-32 /  第 10 条）。
 *
 * 说明：⭐ 1 期在「用途」那一套就踩过"两个同名其它"的坑（分册 23 记着）：
 *      「没选分类」与「用户主动选了『其它』」在库里是两件事（`category_id` 为空 vs 指着「其它」那一行），
 *      显示成同一个词 ⇒ 用户永远分不清自己到底选没选。⛔ 别把两者合并。
 * @type {string}
 */
export const CAT_UNCLASSIFIED = '未分类';

/**
 * 预置的**兜底分类**「其它」—— 它是一条**真的分类**（有 id、能被选中），⛔ 不是"没选"（C-30 / C-32）。
 *
 * 说明：⭐ 它**不可归档 / 不可删除 / 永远留在选择器里**（否则「移动到其它」没有落点 —— C-29 / C-30）。
 *      ⚠️ 前端只是**认识这个名字**（认不出的键回落、文案对齐）；能不能归档由服务端说了算。
 * @type {string}
 */
export const CAT_OTHER = '其它';

/**
 * 功能：一条流水的分类该显示成什么 —— 有分类回它的名字，**没有分类回 `CAT_UNCLASSIFIED`**。
 *
 * 说明：⚠️ 第一个入参**两种都吃**：分类 id（`category_id`）、或一个分类行（带 `id` / `name`）——
 *      调用方手里有时是前者（流水行）、有时是后者（刚新建的那一条）。
 *      ⚠️ `category_id` 为空 / `0` / 认不出的值 ⇒ `CAT_UNCLASSIFIED`（⛔ **不回 `CAT_OTHER`** ——
 *      那会把"没选"说成"选了其它"，正是 C-32 要避免的）。⚠️ 认不出是**正常情况**
 *      （拉分类表的那一次请求失败、或分类被归档后没在列表里）⇒ 降级显示，⛔ 不许抛。
 *
 * @param {(number|string|Object|null)} category - 分类 id，或一个分类行
 * @param {Array.<Object>} categories - 分类清单（`{id, name, …}`）
 * @returns {string} 分类名；没有分类时 `CAT_UNCLASSIFIED`
 */
export function catName(category, categories) {
  const list = Array.isArray(categories) ? categories : [];
  const row = category && typeof category === 'object' ? category : null;
  if (row) {
    const own = String(row.name == null ? '' : row.name).trim();
    if (own) return own;
  }
  const id = row ? row.id : category;
  if (id == null || id === '' || !Number.isFinite(Number(id)) || Number(id) === 0) return CAT_UNCLASSIFIED;
  const hit = list.find((c) => c && Number(c.id) === Number(id));
  const name = hit ? String(hit.name == null ? '' : hit.name).trim() : '';
  return name || CAT_UNCLASSIFIED;
}

/**
 * 功能：判断这是不是**退款条目**（`refund_of` 非空 ⇒ 它退的是哪一笔 ——  第 9 条）。
 *
 * 说明：⚠️ 判据**只准一处**：两端都要用它（画「退款」字样、决定要不要显示"再退一笔"、
 *      不给退款条目再退款）—— 各写一份 `!!e.refund_of` 迟早会漂。
 *      ⚠️ 空串 / `0` / `null` 都算「不是退款」（JSON 后端与手改过的库里什么都可能出现）。
 *
 * @param {Object} entry - 一条流水
 * @returns {boolean} 是退款条目为 true
 */
export function isRefund(entry) {
  const v = entry && entry.refund_of;
  if (v == null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * 功能：原交易那一行上的**退款小字** —— ⭐ 0.8.9 起带上**退款日期**（`9月30日已退款 127.50`）。
 *
 * 说明：⭐⭐ 「移除所有的退款红色字体 …… 我的意思是：退款不算入退款
 *      当天收支小计里面，是在原消费**目录**里用红色字体写：某月某号已退款 金额」。
 *      ⇒ 全站**不再有**「退款合计」那一栏（账单表的退款列、明细顶部卡的退款数、每天小计旁的
 *      退款字样都撤了）；退款的唯一露面处就是**它退的那一笔原消费**这一行。
 *      ⚠️ 日期从**当前页的流水**里找（退款项本身也是列表里的一行，`refund_of` 指着原交易）——
 *      所以列表外（翻了页 / 原交易与退款不在同一页）时取不到日期，那时回落成不带日期的
 *      `已退款 ¥X`（⛔ 不编一个日期：编了就是假事实）。
 *      ⚠️ 金额走 `calc.js` 的 `fmtFen()`（§7.3 的硬规矩：隐藏金额必须覆盖这一屏）——
 *      「藏」的判据**只住 `fmtFen` 一处**，⛔ 这里不许自己拼圆点。
 *      ⚠️ 一笔原交易**可能退过多次**（每次一行）⇒ 按时间升序全列出来，中间用 ` · ` 连。
 *
 * @param {Object} entry - 原交易（读 `id` 与兜底的累计 `refund_fen`）
 * @param {Array.<Object>} all - 当前页的流水（退款条目在里面才取得到日期）
 * @param {boolean} [hidden] - 「眼睛」是否处于隐藏态
 * @returns {string} 如 `9月30日已退款 127.50`；没退款时是空串
 */
export function refundNoteOf(entry, all, hidden) {
  const id = Number(entry && entry.id);
  const list = (Array.isArray(all) ? all : []).filter((x) => Number(x.refund_of) === id);
  if (!list.length) {
    // 当前页看不到那条退款 —— 只用累计金额说一句（⛔ 不编日期）
    const agg = Number(entry && entry.refund_fen) || 0;
    return agg > 0 ? `已退款 ¥${fmtFen(agg, hidden)}` : '';
  }
  return list
    .slice()
    .sort((a, b) => String((a && a.at) || '').localeCompare(String((b && b.at) || '')))
    .map((r) => `${mdLabelOf(r && r.at)}已退款 ¥${fmtFen(r && r.amount_fen, hidden)}`)
    .join(' · ');
}

/**
 * 功能：把 `YYYY-MM-DD HH:MM:SS` 写成「9月30日」（退款小字里那个日子）。
 * 说明：⚠️ 取不到月份 / 日期时回**空串**（⛔ 不拼出「月日」这种残缺词）。
 * @param {string} at - 时刻串
 * @returns {string} 如 `9月30日`
 */
export function mdLabelOf(at) {
  const s = String(at || '');
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(s);
  if (!m) return '';
  return `${Number(m[1])}月${Number(m[2])}日`;
}

/**
 * 功能：一条流水在列表里的**标题** —— 有分类回分类名，没分类回「未分类」；**退款条目带「退款」字样**。
 *
 * 说明：⭐ 退款在记账列表里**单独占一行**（C-24，刻意如此：钱回来了这件事必须能看见），
 *      所以那一行必须在标题上**看得出它是退款** —— 光看金额会以为是"今天赚了 30"。
 *      ⚠️ 退款行也是普通行：分类名照旧显示（默认沿用原交易的分类，C-25）⇒ 标题是「餐饮 · 退款」。
 *
 * @param {Object} entry - 一条流水
 * @param {Array.<Object>} categories - 分类清单
 * @returns {string} 标题
 */
export function entryTitle(entry, categories) {
  const e = entry || {};
  const base = catName(e.category_id, categories);
  return isRefund(e) ? `${base} · 退款` : base;
}

/**
 * 功能：一笔流水的**带符号金额**（支出为负、收入为正，整数分）—— 供展示用。
 *
 * 说明：⚠️⭐ **它只做展示符号，⛔ 不在这里派生余额**：
 *      余额＝基准 ＋ 之后的变动，那个算法**只住服务端** `lib/balance.js`；
 *      前端把它当"另一条真相"算一遍，迟早与账户卡上的数对不上，而且**不报错**。
 *      ⚠️ 认不出的 `ie` 按**正**（与库里只有两个取值的事实一致；真出现了是脏数据，
 *      显示成 `+` 至少不会把支出说成收入 —— 服务端那边另有校验拦它）。
 *      ⚠️ 返回的是**数**（不是串）：拼串走 `calc.js` 的 `fmtFen()`（那里才有千分位与掩码）。
 *
 * @param {string} ie - `'支出'` / `'收入'`
 * @param {number} amountFen - 整数分（库里恒为非负）
 * @returns {number} 带符号的整数分（支出为负）
 */
export function signedFen(ie, amountFen) {
  const raw = Number(amountFen);
  const a = Math.abs(Number.isFinite(raw) ? Math.trunc(raw) : 0);
  return String(ie == null ? '' : ie) === IE_EXPENSE ? -a : a;
}

/**
 * 三档颜色在 CSS 里的**变量名**（C-21 /）。
 *
 * 说明：⭐ 账户详情那一屏是「记账 ＋ 转账 ＋ 手动调整」**三类混排**，转账要跟流水区别开
 *      （要求），手动调整再用**第三档**（否则"调整"会与流水糊在一起）。
 *      ⚠️ 色值**只住本文件**（`TONE_COLORS`），⛔ 不许写进 `desktop.js` / `mobile.js` ——
 *      两端的 CSS 只写 `color: var(--lg-tone-*)`（版式各一份是，**色值**不是版式）。
 * @type {Object.<string, string>}
 */
export const TONE_VARS = {
  entry: '--lg-tone-entry',
  transfer: '--lg-tone-transfer',
  adjust: '--lg-tone-adjust',
};

/**
 * 三档颜色的**色值**（唯一出处）。
 *
 * 说明：⚠️ 三个值**必须互不相同**（反向验证 ⑫：只留两档 ⇒ 那条向量必须变红）。
 *      · `entry`（记账）＝ 与正文同一个墨色 —— 它是**默认那一档**，一屏里绝大多数行都是它；
 *      · `transfer`（转账）＝ 品牌靛蓝（与 `core/tokens.css` 的 `--zx-brand` 同值）；
 *      · `adjust`（手动调整）＝ 琥珀（与 `--zx-warn` 同值，"改过余额"这件事值得被看见）。
 *      ⚠️ 刻意**不**用红 / 绿：那两个色在本模块已被「支出 / 收入」占用
 *      （`fmtFen` 的负号那套口径），再拿它们表达"变动类型"就是同一个颜色说两件事。
 * @type {Object.<string, string>}
 */
export const TONE_COLORS = {
  entry: '#1f2430',
  transfer: '#4f46e5',
  adjust: '#f59e0b',
};

/**
 * 功能：把**变动类型**翻成它那一档的键（`'entry'` / `'transfer'` / `'adjust'`）。
 * @param {string} type - 服务端下发的 `type`（`all` / `entry` / `transfer` / `adjust`）
 * @returns {string} 三档之一的键
 */
function toneKey(type) {
  const t = String(type == null ? '' : type);
  if (t === 'transfer') return 'transfer';
  if (t === 'adjust') return 'adjust';
  // ⚠️ `all`（不筛）与任何认不出的值都落「记账」那一档 —— 它是**默认色**：
  //    宁可一行画成默认墨色，⛔ 也别画成"转账"或"调整"（那是在说一件没发生的事）。
  return 'entry';
}

/**
 * 功能：变动类型 → **颜色令牌名**（`'tone-entry'` / `'tone-transfer'` / `'tone-adjust'`）。
 *
 * 说明：⭐ 三类**互不相同**（这是 C-21 的可执行定义）；两端拿它当 CSS 类名 / 令牌名用，
 *      ⛔ 别在两端各写一份 `switch (type)`（那正是 说的双份判据）。
 *
 * @param {string} type - `'entry'` / `'transfer'` / `'adjust'`（`all` / 认不出 ⇒ `tone-entry`）
 * @returns {string} 颜色令牌名
 */
export function changeTone(type) {
  return `tone-${toneKey(type)}`;
}

/**
 * 功能：变动类型 → 一行 CSS 声明（`--lg-tone-entry:#1f2430`），贴到行元素上即可用 `var()` 取色。
 *
 * 说明：⭐ 它是「色值只住一处」的**用法**：两端给每一行挂上这一句（`el.style.cssText += …`），
 *      CSS 里只写 `color: var(--lg-tone-transfer)` ⇒ 换色只改 `TONE_COLORS` 一处，
 *      ⛔ 不会出现"电脑端是蓝的、手机端是紫的"。
 *
 * @param {string} type - 变动类型
 * @returns {string} `'--lg-tone-<档>:<色值>'`
 */
export function toneStyle(type) {
  const k = toneKey(type);
  return `${TONE_VARS[k]}:${TONE_COLORS[k]}`;
}

/**
 * 功能：备注历史候选的**本地**即时过滤 —— 用户输入的片段是不是命中某个候选。
 *
 * 说明：⭐⭐ ⛔ **这里不许 `distinct` 任何东西、也不许自己去库里翻流水**：
 *      候选**来源**是服务端那一条（`GET /api/ledger/notes?category=`， 第 1 条 / C-17：
 *      `DISTINCT note` ＋ 最近优先 ＋ 上限 20 ＋ 按当前分类过滤）——
 *      两端各 distinct 一遍就会得到两份不一样的候选（反向验证 ⑧ 钉的就是这件事）。
 *      本函数只回答一个问题：「服务端给回来的这 20 条里，哪几条还要显示」。
 *      ⚠️ 空 / 全空白的输入 ⇒ **全部命中**（一进输入框就该看到完整候选）。
 *      ⚠️ 匹配是**子串**（`includes`）且不分大小写；⛔ 不做拼音 / 模糊匹配（那要词典，属零依赖红线）。
 *
 * @param {string} text - 用户当前输入的片段
 * @param {string} note - 一个候选备注
 * @returns {boolean} 该候选要不要显示
 */
export function matchNote(text, note) {
  const q = String(text == null ? '' : text)
    .trim()
    .toLowerCase();
  if (!q) return true;
  return String(note == null ? '' : note)
    .toLowerCase()
    .includes(q);
}

/**
 * 功能：按「**类别默认 → 全局默认（按这一笔的收 / 支）→ 空账户**」取出这一笔该预填的账户 id。
 *
 * 说明：⭐⭐ **取值顺序只准住这一处**——
 *      两端（电脑端 / 手机端）都调它，⛔ 不许各自再写一遍 if / else：那是「一份判据两处实现」，
 *      必然漂移成「电脑端预填微信、手机端预填空账户」这种没人报错、只有用户看得见的分歧。
 *
 * 顺序（逐级兜底，命中即返回）：
 *   ① **类别默认**：`defaults` 里 `kind === 'category'` 且 `category_id` 等于本笔的类别；
 *   ② **全局默认**：`kind` = 这笔是「收入」⇒ `'income'`、否则 `'expense'`，且 `category_id === 0`（哨兵）；
 *   ③ **空账户**：调用方给的 `emptyAccountId`（服务端保证每账号恰好一行，见）。
 *
 * ⚠️ 每一级都要求 `account_id > 0`：**被删掉的默认账户在服务端回来的是 `null`**（
 *    「某个默认账户被删掉 ⇒ 落到全局默认上」）⇒ 这里**跳过它继续往下兜**，⛔ 不许把 `null` 当成一个答案。
 * ⚠️ 没选类别（`categoryId` 为空）⇒ 跳过第 ① 级，直接走全局默认。
 * ⚠️ 本函数**只回答「预填哪个账户」**： 第 12 条 —— 用户在记账界面改掉之后
 *    **只影响这一次**，⛔ 不回写任何默认。
 * ⚠️ 拿不准时返回 `emptyAccountId`（可能为 0）：⛔ **不抛** —— 渲染路径上抛一下整屏就白了。
 *
 * @param {Object} p - 取值上下文
 * @param {Array.<Object>} p.defaults - 服务端 `GET /api/ledger/defaults` 给的行（`{kind, category_id, account_id}`）
 * @param {number|null} [p.categoryId] - 这一笔选中的分类（未选传 null）
 * @param {string} [p.ie] - 这一笔的收支（`'支出'` / `'收入'`）
 * @param {number} [p.emptyAccountId] - 空账户的 id（最后一档兜底）
 * @returns {number} 该预填的账户 id；三级都没命中时为 `emptyAccountId`（或 0）
 */
export function pickDefaultAccount(p) {
  const o = p || {};
  const rows = Array.isArray(o.defaults) ? o.defaults : [];
  const ok = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
  const cid = o.categoryId == null || o.categoryId === '' ? null : Number(o.categoryId);

  if (cid != null && Number.isInteger(cid)) {
    for (const r of rows) {
      if (r && r.kind === 'category' && Number(r.category_id) === cid && ok(r.account_id)) return Number(r.account_id);
    }
  }
  const gk = o.ie === IE_INCOME ? 'income' : 'expense';
  for (const r of rows) {
    if (r && r.kind === gk && Number(r.category_id) === 0 && ok(r.account_id)) return Number(r.account_id);
  }
  return ok(o.emptyAccountId) ? Number(o.emptyAccountId) : 0;
}

/**
 * 功能：一个分类的**上一级 id**（`parent_id` 空 / `0` / 认不出 ⇒ `0`，表示「它是一级」）。
 *
 * 说明：⚠️ 服务端下发的 `parent_id` 可能是 `null`（一级）或一个正数（二级）；JSON 后端与手改过的库里
 *      还可能出现 `0` / 空串 ⇒ 一律折成 `0`，⛔ 别在两端各写一遍 `Number(c.parent_id) || 0`
 *      （`null` 与 `0` 在 `Number()` 下都是 `0`，但 `''` 也是 —— 这正是要靠一处收口的原因）。
 *
 * @param {Object} c - 一个分类行
 * @returns {number} 上一级 id；一级时是 `0`
 */
function parentOf(c) {
  const v = Number(c && c.parent_id);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/**
 * 功能：分类的排序口径 —— `sort_order` 升序，**同值按 `id` 升序兜底**。
 *
 * 说明：⚠️ 服务端新建分类写的 `sort_order` 是"同组内最大值 + 1"，正常不会撞；但 JSON 后端、
 *      离线改过的库、以及并发新建都可能给出同值 ⇒ 必须有一个确定的兜底，
 *      ⛔ 否则同一份数据两次渲染的顺序可能不同（用户看到"分类自己跳来跳去"）。
 *
 * @param {Object} a - 分类 A
 * @param {Object} b - 分类 B
 * @returns {number} 排序比较值
 */
function bySortOrder(a, b) {
  const sa = Number(a && a.sort_order);
  const sb = Number(b && b.sort_order);
  const va = Number.isFinite(sa) ? Math.trunc(sa) : 0;
  const vb = Number.isFinite(sb) ? Math.trunc(sb) : 0;
  if (va !== vb) return va - vb;
  return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
}

/**
 * 功能：取某一侧（`ie`）的**一级分类**清单（已归档的不算）。
 *
 * 说明：⭐⭐ **这条判据只准住这一处**：1 期到 2 期，两端各自写过
 *      `cats.filter((c) => !c.archived && !c.parent_id && c.ie === 天)` —— 同样的三条件散在
 *      4 个渲染点里；2 期加了「分类管理」之后只会更多。谁漏掉 `ie` 那一条，**收入侧就会混进支出分类**
 *      而且不报错，只有用户看得见。⇒ 两端（选择器 / 二级屏 / 分类管理）一律调它。
 *      ⚠️ 入参不是数组 ⇒ 回**空数组**（⛔ 不抛 —— 渲染路径上抛一下整屏就白）。
 *
 * @param {Array.<Object>} cats - 分类清单（`GET /api/ledger/categories`）
 * @param {string} ie - `'支出'` / `'收入'`
 * @returns {Array.<Object>} 一级分类（按 `bySortOrder` 排好）
 */
export function topCats(cats, ie) {
  const list = Array.isArray(cats) ? cats : [];
  const side = String(ie == null ? '' : ie);
  return list
    .filter((c) => c && !c.archived && !parentOf(c) && String(c.ie == null ? '' : c.ie) === side)
    .sort(bySortOrder);
}

/**
 * 功能：取某个一级分类下面的**二级分类**清单（已归档的不算）。
 *
 * 说明：⚠️ 同 `topCats`：**「二级」的判据也只准住这一处**（`parent_id` 相等于给定的那个 id）。
 *      两端「记一笔」的第二屏与「分类管理」都调它，⛔ 不许各自 `filter`。
 *      ⚠️ 一级分类不存在 / 没子分类 ⇒ 回空数组（调用方据此决定"要不要进第二屏"，见 `hasKids`）。
 *
 * @param {Array.<Object>} cats - 分类清单
 * @param {number} parentId - 一级分类的 id
 * @returns {Array.<Object>} 二级分类（按 `bySortOrder` 排好）
 */
export function childCats(cats, parentId) {
  const list = Array.isArray(cats) ? cats : [];
  const pid = Number(parentId);
  if (!Number.isFinite(pid) || pid <= 0) return [];
  return list.filter((c) => c && !c.archived && parentOf(c) === Math.trunc(pid)).sort(bySortOrder);
}

/**
 * 功能：这个一级分类**有没有子分类** —— 决定「记一笔」点它之后进不进第二屏。
 *
 * 说明：⚠️⭐ 「有没有孩子」与「孩子是什么」**必须是同一个判据**（`childCats`）：若一边算"有孩子"
 *      用一套过滤、另一边列孩子用另一套（例如忘了排归档），就会出现「进了第二屏、里面是空的」
 *      —— 用户点了一个不确定的东西，界面又不报错。⇒ 本函数**就是** `childCats().length > 0`。
 *
 * @param {Array.<Object>} cats - 分类清单
 * @param {number} parentId - 一级分类的 id
 * @returns {boolean} 有未归档子分类时为 true
 */
export function hasKids(cats, parentId) {
  return childCats(cats, parentId).length > 0;
}

/**
 * 功能：把某一侧的分类拼成**两级树**（`[{…一级, kids: […二级]}]`）—— 分类管理那一屏用。
 *
 * 说明：⭐ 与 `topCats` / `childCats` 共用同一套过滤与排序（本函数内部就调它们），
 *      ⛔ 不另写一份：分类管理要**显示已归档的**（带灰标记，用户才看得懂"这个分类去哪了"），
 *      所以多一个 `includeArchived` 开关 —— 但「谁是二级」的判据仍然是 `parentOf`。
 *      ⚠️ 归档的一级带着它归档的二级一起显示；归档的二级**不会**冒到一级去（它的 `parent_id` 还在）。
 *
 * @param {Array.<Object>} cats - 分类清单
 * @param {string} ie - `'支出'` / `'收入'`
 * @param {Object} [opts] - `{ includeArchived: boolean }`
 * @returns {Array.<Object>} 一级（含 `kids`），按 `bySortOrder` 排好
 */
export function catTree(cats, ie, opts) {
  const list = Array.isArray(cats) ? cats : [];
  const all = !!(opts && opts.includeArchived);
  // ⚠️ `c &&` 这条守卫**两个分支都要有**：`includeArchived` 时直接返回 `list`，
  //    数组里混进一个 `null`（JSON 后端手改过的库、将来别的调用方）就会在下面取 `c.ie` 时抛
  //    —— 与 `topCats` / `childCats` 的守卫**必须是同一个口径**（否则分类管理那一屏会白，
  //    而选择器那一屏照常，表现是"只有某一个入口炸"）。
  const alive = list.filter((c) => c && (all || !c.archived));
  const side = String(ie == null ? '' : ie);
  const tops = alive
    .filter((c) => !parentOf(c) && String(c.ie == null ? '' : c.ie) === side)
    .sort(bySortOrder);
  const kidsOf = (pid) => alive.filter((c) => parentOf(c) === Number(pid)).sort(bySortOrder);
  return tops.map((t) => Object.assign({}, t, { kids: kidsOf(Number(t.id)) }));
}
