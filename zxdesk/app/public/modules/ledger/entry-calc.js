/**
 * modules/ledger/entry-calc.js —— 记账 2 期「流水」那一套**两端共用**的纯展示函数
 *
 * 功能：· 取数：`ENTRY_PAGE_SIZE` / `CURSOR_SEP` / `buildCursor()` / `parseCursor()`（按月 ＋ **游标**，C-15 / C-16）；
 * 列表：`groupByDay()`（按天分组）、`monthOptions()` / `monthOptionsAll()`（月份下拉的选项）、
 * `MONTHS_ALL` / `pickerYears()`（「选择月份」那两列的候选：**月恒 12 项、年连续区间**）；
 * 文案：`CAT_UNCLASSIFIED` / `CAT_OTHER` / `catName()`（「未分类」与「其它」**必须分得开**，C-32）…
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.9.7
 * 相关：docs/公共/开发方案/21-记账2期-记账.md、docs/公共/架构文档/23-记账.md、./calc.js
 */

import { IE_EXPENSE, IE_INCOME, fmtFen, monthOf, monthOptionsOf } from './calc.js';

/**
 * 一次加载多少条流水（C-16）。
 *
 */
export const ENTRY_PAGE_SIZE = 30;

/**
 * 游标串的分隔符 —— `'<at>|<id>'`（C-15）。
 *
 */
export const CURSOR_SEP = '|';

/** `at` 的合法形状（服务端 `ledger_entries.at` 逐字同款：`'YYYY-MM-DD HH:MM:SS'`） */
const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 功能：把一条流水的 `(时刻, id)` 拼成游标串（`'<at>|<id>'`）。
 *
 * 说明：⭐ **分页只用游标、⛔ 不用 offset**（C-15 /  第 3 条）：中途有人插了一笔，
 * offset 会漂 ⇒ 翻页**重复或漏行**，而这件事**不报错**（对话那条 `before` 游标就是这么定的）。
 * 形状不对（`at` 不是 `'YYYY-MM-DD HH:MM:SS'` / `id` 不是非负整数）⇒ 回 `null`：
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
 * 非字符串 / 空串（`''` / `null` / `undefined`）；
 * 形状不对（`'abc'`、"只按 `|` 切两段"都不成立）；
 * `id` 那一段不是纯数字。
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
 * 所以"服务端已经排好"这件事在分组之后**依然成立**，两端不需要各自再排一遍。
 * 同一分钟内的两笔按 **`id` 倒序**兜底（C-2：顺序永远确定，⛔ 不出现"随机顺序"）。
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
 * 新的在前）—— ⛔ 这里**不另立第二种顺序**（同一个下拉在两端、两屏里必须长得一样）。
 * 本函数只多做一件事：把入参**归一化** —— 调用方可能给「月份键 `'2026-09'`」，
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
 * 月份选择器里**所有**的月（`1~12`）。
 *
 */
export const MONTHS_ALL = Object.freeze(Array.from({ length: 12 }, (_v, i) => i + 1));

/**
 * 功能：月份选择器里「年」那一列 —— 已知的年 ∪ 今天那一年，再**向前后各补若干年**，取**连续区间**。
 *
 * 说明：⭐⭐ 为什么不是「只列有记录的年」：同一个道理（见 `MONTHS_ALL`）—— 只列有数据的那几年，
 * 用户想翻到「去年这个时候」而去年一整年没记账，就翻不过去。
 * 为什么不是「今年 ±N 年」一刀切：从三方导入进来的老账（2023 / 2024 年）会落在区间外，
 */
export function pickerYears(knownYears, todayMonth, opts) {
  const o = opts || {};
  const back = Number.isFinite(Number(o.back)) ? Math.max(0, Math.trunc(Number(o.back))) : 5;
  const ahead = Number.isFinite(Number(o.ahead)) ? Math.max(0, Math.trunc(Number(o.ahead))) : 1;
  const set = new Set();
  for (const y of Array.isArray(knownYears) ? knownYears : []) {
    const n = Number(String(y).slice(0, 4));
    if (n >= 1900 && n <= 2999) set.add(n);
  }
  const t = Number(String(todayMonth || '').slice(0, 4));
  if (t >= 1900 && t <= 2999) set.add(t);
  if (!set.size) return [];
  const lo = Math.min(...set) - back;
  const hi = Math.max(...set) + ahead;
  const MAX_SPAN = 30;
  const from = hi - lo + 1 > MAX_SPAN ? hi - MAX_SPAN + 1 : lo;
  const out = [];
  for (let y = from; y <= hi; y += 1) out.push(y);
  return out;
}

/**
 * 功能：某个年份区间下的**全部月份键**（`YYYY-MM`，倒序）—— 账户详情的月份下拉用它。
 *
 * 说明：⭐ 与 `monthOptions()` 的区别只有一条：`monthOptions()` 只给**有记录**的月（＋今天那个月），
 * 本函数把出现的每一年都**铺满 12 个月**（年份集合仍由调用方的数据决定，⛔ 不凭空扩年 ——
 * 那里是一颗纯月份下拉，扩年就等于把「年」也塞进同一个控件里）。
 */
export function monthOptionsAll(months, todayMonth) {
  const keys = monthOptions(months, todayMonth);
  const years = new Set();
  for (const k of keys) {
    const y = Number(String(k).slice(0, 4));
    if (y >= 1900 && y <= 2999) years.add(y);
  }
  const out = [];
  for (const y of [...years].sort((a, b) => b - a)) {
    for (let m = 12; m >= 1; m -= 1) out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

/**
 * 「没选分类」的显示 —— 与 `CAT_OTHER` **是两个不同的字符串**（C-32 /  第 10 条）。
 *
 */
export const CAT_UNCLASSIFIED = '未分类';

/**
 * 预置的**兜底分类**「其它」—— 它是一条**真的分类**（有 id、能被选中），⛔ 不是"没选"（C-30 / C-32）。
 *
 */
export const CAT_OTHER = '其它';

/**
 * 功能：一条流水的分类该显示成什么 —— 有分类回它的名字，**没有分类回 `CAT_UNCLASSIFIED`**。
 *
 * 说明：⚠️ 第一个入参**两种都吃**：分类 id（`category_id`）、或一个分类行（带 `id` / `name`）——
 * 调用方手里有时是前者（流水行）、有时是后者（刚新建的那一条）。
 * `category_id` 为空 / `0` / 认不出的值 ⇒ `CAT_UNCLASSIFIED`（⛔ **不回 `CAT_OTHER`** ——
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
 * 不给退款条目再退款）—— 各写一份 `!!e.refund_of` 迟早会漂。
 * 空串 / `0` / `null` 都算「不是退款」（JSON 后端与手改过的库里什么都可能出现）。
 */
export function isRefund(entry) {
  const v = entry && entry.refund_of;
  if (v == null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 *
 * 说明：⭐⭐ 「移除所有的退款红色字体 …… 我的意思是：退款不算入退款
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
 * 所以那一行必须在标题上**看得出它是退款** —— 光看金额会以为是"今天赚了 30"。
 * 退款行也是普通行：分类名照旧显示（默认沿用原交易的分类，C-25）⇒ 标题是「餐饮 · 退款」。
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
 * 余额＝基准 ＋ 之后的变动，那个算法**只住服务端** `lib/balance.js`；
 * 前端把它当"另一条真相"算一遍，迟早与账户卡上的数对不上，而且**不报错**。
 */
export function signedFen(ie, amountFen) {
  const raw = Number(amountFen);
  const a = Math.abs(Number.isFinite(raw) ? Math.trunc(raw) : 0);
  return String(ie == null ? '' : ie) === IE_EXPENSE ? -a : a;
}

/**
 * 三档颜色在 CSS 里的**变量名**（C-21 /）。
 *
 */
export const TONE_VARS = {
  entry: '--lg-tone-entry',
  transfer: '--lg-tone-transfer',
  adjust: '--lg-tone-adjust',
};

/**
 * 三档颜色的**色值**（唯一出处）。
 *
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
  // `all`（不筛）与任何认不出的值都落「记账」那一档 —— 它是**默认色**：
  // 宁可一行画成默认墨色，⛔ 也别画成"转账"或"调整"（那是在说一件没发生的事）。
  return 'entry';
}

/**
 * 功能：变动类型 → **颜色令牌名**（`'tone-entry'` / `'tone-transfer'` / `'tone-adjust'`）。
 *
 * 说明：⭐ 三类**互不相同**（这是 C-21 的可执行定义）；两端拿它当 CSS 类名 / 令牌名用，
 *
 * @param {string} type - `'entry'` / `'transfer'` / `'adjust'`（`all` / 认不出 ⇒ `tone-entry`）
 */
export function changeTone(type) {
  return `tone-${toneKey(type)}`;
}

/**
 * 功能：变动类型 → 一行 CSS 声明（`--lg-tone-entry:#1f2430`），贴到行元素上即可用 `var()` 取色。
 *
 * 说明：⭐ 它是「色值只住一处」的**用法**：两端给每一行挂上这一句（`el.style.cssText += …`），
 * CSS 里只写 `color: var(--lg-tone-transfer)` ⇒ 换色只改 `TONE_COLORS` 一处，
 * 不会出现"电脑端是蓝的、手机端是紫的"。
 */
export function toneStyle(type) {
  const k = toneKey(type);
  return `${TONE_VARS[k]}:${TONE_COLORS[k]}`;
}

/**
 * 功能：备注历史候选的**本地**即时过滤 —— 用户输入的片段是不是命中某个候选。
 *
 * 候选**来源**是服务端那一条（`GET /api/ledger/notes?category=`， 第 1 条 / C-17：
 * `DISTINCT note` ＋ 最近优先 ＋ 上限 20 ＋ 按当前分类过滤）——
 * 两端各 distinct 一遍就会得到两份不一样的候选（反向验证 ⑧ 钉的就是这件事）。
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
 * 必然漂移成「电脑端预填微信、手机端预填空账户」这种没人报错、只有用户看得见的分歧。
 *
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
 * 还可能出现 `0` / 空串 ⇒ 一律折成 `0`，⛔ 别在两端各写一遍 `Number(c.parent_id) || 0`
 *
 */
function parentOf(c) {
  const v = Number(c && c.parent_id);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/**
 * 功能：分类的排序口径 —— `sort_order` 升序，**同值按 `id` 升序兜底**。
 *
 * 说明：⚠️ 服务端新建分类写的 `sort_order` 是"同组内最大值 + 1"，正常不会撞；但 JSON 后端、
 * 离线改过的库、以及并发新建都可能给出同值 ⇒ 必须有一个确定的兜底，
 *
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
 * `cats.filter((c) => !c.archived && !c.parent_id && c.ie === 天)` —— 同样的三条件散在
 * 而且不报错，只有用户看得见。⇒ 两端（选择器 / 二级屏 / 分类管理）一律调它。
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
 * 一级分类不存在 / 没子分类 ⇒ 回空数组（调用方据此决定"要不要进第二屏"，见 `hasKids`）。
 *
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
 * 用一套过滤、另一边列孩子用另一套（例如忘了排归档），就会出现「进了第二屏、里面是空的」
 * —— 用户点了一个不确定的东西，界面又不报错。⇒ 本函数**就是** `childCats().length > 0`。
 */
export function hasKids(cats, parentId) {
  return childCats(cats, parentId).length > 0;
}

/**
 * 功能：把某一侧的分类拼成**两级树**（`[{…一级, kids: […二级]}]`）—— 分类管理那一屏用。
 *
 * 说明：⭐ 与 `topCats` / `childCats` 共用同一套过滤与排序（本函数内部就调它们），
 * 不另写一份：分类管理要**显示已归档的**（带灰标记，用户才看得懂"这个分类去哪了"），
 * 所以多一个 `includeArchived` 开关 —— 但「谁是二级」的判据仍然是 `parentOf`。
 */
export function catTree(cats, ie, opts) {
  const list = Array.isArray(cats) ? cats : [];
  const all = !!(opts && opts.includeArchived);
  // `c &&` 这条守卫**两个分支都要有**：`includeArchived` 时直接返回 `list`，
  // 数组里混进一个 `null`（JSON 后端手改过的库、将来别的调用方）就会在下面取 `c.ie` 时抛
  // 而选择器那一屏照常，表现是"只有某一个入口炸"）。
  const alive = list.filter((c) => c && (all || !c.archived));
  const side = String(ie == null ? '' : ie);
  const tops = alive
    .filter((c) => !parentOf(c) && String(c.ie == null ? '' : c.ie) === side)
    .sort(bySortOrder);
  const kidsOf = (pid) => alive.filter((c) => parentOf(c) === Number(pid)).sort(bySortOrder);
  return tops.map((t) => Object.assign({}, t, { kids: kidsOf(Number(t.id)) }));
}
