'use strict';
/**
 * modules/ledger/lib/shark.js —— **鲨鱼记账**导出文件的解析口径（全模块唯一出处）
 *
 * 功能：把「鲨鱼记账」导出的那张表（`string[][]`，由 `core/sheet-parser.js` 的 `parseSheet()`
 *      解出来）折成**六列原样 ＋ 两个派生值**：
 *      `{ dateRaw, ieRaw, category, account, amountRaw, note, at, fen }`。
 *
 * ⭐⭐ **本文件是「三方导入」这一类里唯一认得外部格式的地方**（方案 `23`）：
 *    「哪个列叫什么、日期长什么样、收支两个值怎么写」这些**别人的规矩**只准住在这里，
 *    ⛔ 不许散进 `store.js` / 前端（双份判据必然漂移）。
 *    ⚠️ 以后加别家（喵喵记账 / 随手记 / MoneyWiz…）＝**再加一个同形状的 lib 文件**
 *    ＋ 在 `lib/import-sources.js` 的清单里加一项，⛔ 不是往这里塞 `if (source === 'xx')`。
 *
 * ⚠️⭐ **本文件是纯函数，⛔ 不碰数据库、⛔ 不 require `store.js`**（照 `lib/money.js` 那一族的规矩）。
 *
 * ⭐ **认列的规则是「按列名」、⛔ 不是「按列序」**（一手样本实测 6 列：
 *    `日期,收支类型,类别,账户,金额,备注`）—— 按序认的话，鲨鱼哪天把列调个位置，
 *    我们就会**静默地把备注当金额写进去**。
 *
 * ⭐⭐ **「原样」是什么意思**（「数据原样保存」）：
 *    · 六列**按文件里的字面**存下去（`微信` 那种账户名、`#短信费` 那种备注，一个字不改）；
 *    · ⛔ **不**映射到我们的分类、⛔ **不**关联我们的账户；
 *    · 唯一动过的是**去掉单元格首尾的空白**（那是表格噪声，不是数据 —— 样本里有 6 行备注
 *      首尾带空白）⇒ 这不叫「改写」，叫「拆包装」。
 *
 * ⭐ **两个派生值**（`at` / `fen`）：它们**不是**「改了原数据」，而是「入库那一刻顺手算好的钥匙」——
 *    `at` 让 SQL 层能排序、能按月取数；`fen` 让统计能求和。⚠️ 没有它们，原样那两列
 *    （`2025年12月22日` 与 `12.00`）在 SQL 层既排不了序也求不了和。
 *
 * ⭐⭐ **编码 / 表格形态**（CSV / TSV / 带不带 BOM / 是不是 UTF-16）**一律交给 `parseSheet()`**，
 *    本文件只管「表格解出来之后、这一格是什么意思」。⚠️ 这条是调研 `10` §3.4 点名的纪律：
 *    项目已知缺陷 #1 就是「UTF-16 的 CSV 被当 GBK 解 ⇒ 返回 `ok: true` 加一屏乱码」——
 *    ⇒ 解不出来就**拒绝**，⛔ 绝不给乱码。
 *
 * @author zx
 * @date   2026-09-24
 * @since 0.8.2
 * 相关：docs/公共/开发方案/23-记账-三方导入（鲨鱼记账）.md、docs/公共/架构文档/23-记账.md
 */

const { parseFen } = require('./money.js');

/**
 * 列名 —— ⭐ 认列的**唯一凭据**（⛔ 不认列序）。
 *
 * 说明：与 `lib/import-sources.js` 里 `shark` 那一项的 `required` / `optional` **逐字一致**
 *      （那份给接口层做「缺哪列」的文案，这一份给解析用）。⚠️ 两处必须一起改 ——
 *      改一处会让「文案说缺 A、解析却认 B」这种怪事出现。
 *      ⚠️⭐ 定义放在文件**上部**：`locateColumns()` 引用它，而 `const` 有暂时性死区
 *      （声明前引用 ⇒ 真机整屏空白，而 lint / 单测全绿 —— 项目踩过的那一类）。
 * @type {{date: string, ie: string, cat: string, account: string, amount: string, note: string}}
 */
const COLUMNS = { date: '日期', ie: '收支类型', cat: '类别', account: '账户', amount: '金额', note: '备注' };

/**
 * 只认这两个收支值 —— ⭐ 与 `ledger_entries.ie` 的取值**逐字一致**（2 期 第 9 条）。
 * 原样存的就是它们（⛔ 不另做一个「规范值」列：校验过之后两者本来就一样）。
 * @type {string}
 */
const IE_EXPENSE = '支出';

/** @type {string} */
const IE_INCOME = '收入';

/**
 * 表头最多往下找几行。
 *
 * 说明：鲨鱼导出的第一行就是表头；留几行余量只为「前面可能有空行」这种导出差异，
 *      ⛔ 不为了「表头在第 50 行」这种臆想中的形态放宽。
 * @type {number}
 */
const HEADER_SCAN_ROWS = 5;

/**
 * 日期串的形状：`2025年12月22日`（一手样本里**唯一**的形态）。
 * @type {RegExp}
 */
const RE_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;

/**
 * 功能：判断 `年月日` 是不是**真实存在**的那一天（⛔ 不许 `2025-02-30` 这种）。
 *
 * 说明：⚠️⭐ 必须自己判，**不许信 `new Date()`** —— JS 的 `Date` 会把 `2025-02-30`
 *      **静默进位**成 `3 月 2 日`（同一个坑在 3 期 `period_key` 的校验上踩过一次）⇒
 *      那种串不但过得去，还会变成一条日期错了一个月的账，而且**不报错**。
 *
 * @param {number} y - 年
 * @param {number} m - 月（1~12）
 * @param {number} d - 日
 * @returns {boolean} 是真实存在的一天为 true
 */
function isRealDay(y, m, d) {
  if (!(y >= 1900 && y <= 2999)) return false;
  if (!(m >= 1 && m <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}

/**
 * 功能：把 `2025年12月22日` 折成 `2025-12-22`（派生列 `at`）。
 *
 * 说明：⭐⭐ **只给日期、不给时刻**（鲨鱼导出那一列本来就只有日期）。
 *      ⛔ **不许**按行序伪造 `00:00:01` / `00:00:02` 那种时间 —— 那会造出文件里根本没有的次序，
 *      让「同一天多笔」看起来像有依据。同一天里的先后交给 `(at, id)` 的 `id` 兜底（2 期既有口径）。
 *      ⇒ 本函数是全模块**唯一**把外部日期折成 `at` 的地方。
 *
 * @param {string} raw - 单元格原串（未去空白）
 * @returns {?string} `'YYYY-MM-DD'`；形状不对 / 那天不存在时返回 `null`
 */
function toAt(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = RE_DATE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isRealDay(y, mo, d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}`;
}

/**
 * 功能：取表格里的第 `i` 列（越界回空串）。
 *
 * 说明：⚠️ `parseSheet()` 可能给出**参差不齐**的行（尾部的空列会被吞掉）⇒ 越界必须当空串，
 *      ⛔ 不许让它变成 `undefined` 再流进后面的判断（`String(undefined)` 是 `'undefined'`，
 *      那会变成一条备注写着 `undefined` 的账 —— 而且**不报错**）。
 *
 * @param {Array.<string>} row - 一行
 * @param {number} i - 列下标（`-1` = 没有这一列）
 * @returns {string} 该格的原串
 */
function cell(row, i) {
  if (i < 0 || !Array.isArray(row)) return '';
  const v = row[i];
  return v == null ? '' : String(v);
}

/**
 * 功能：在表头里按**列名**找每一列的列号。
 *
 * 说明：⭐ 必需列 = `日期` / `收支类型` / `类别` / `金额`（缺任一 ⇒ 不认这份文件）；
 *      `账户` / `备注` 可有可无（没有就一律当空串）。
 *      ⚠️ 找表头**只看前 `HEADER_SCAN_ROWS` 行**，并取**第一行同时含有四个必需列名**的那一行。
 *
 * @param {Array.<Array.<string>>} rows - `parseSheet()` 给的网格
 * @returns {?{head: number, date: number, ie: number, cat: number,
 *             account: number, amount: number, note: number}} 列号表；认不出返回 `null`
 */
function locateColumns(rows) {
  const head = Array.isArray(rows) ? rows : [];
  const want = [COLUMNS.date, COLUMNS.ie, COLUMNS.cat, COLUMNS.amount];
  const limit = Math.min(head.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r += 1) {
    const row = Array.isArray(head[r]) ? head[r] : [];
    const at = {};
    for (let c = 0; c < row.length; c += 1) {
      const name = String(row[c] == null ? '' : row[c]).trim().replace(/^\uFEFF/, '');
      if (name && at[name] === undefined) at[name] = c;
    }
    if (want.every((n) => at[n] !== undefined)) {
      const pick = (name) => (at[name] === undefined ? -1 : at[name]);
      return {
        head: r,
        date: at[COLUMNS.date],
        ie: at[COLUMNS.ie],
        cat: at[COLUMNS.cat],
        account: pick(COLUMNS.account),
        amount: at[COLUMNS.amount],
        note: pick(COLUMNS.note),
      };
    }
  }
  return null;
}

/**
 * 功能：把 `parseSheet()` 解出来的那张表折成「六列原样 ＋ 两个派生值」。
 *
 * 说明：⭐⭐ 四条纪律（都是「错了不报错」那一类）：
 *      · **一行不认就整份不认**（⛔ 不「跳过坏行」、⛔ 也不「存下来但标成坏」）——
 *        ⚠️⭐ 尤其是日期认不出的行：我们的取数一律**按月**（`at` 的区间）⇒ 那种行就算存进库
 *        也**永远显示不出来**（每个月都取不到它），那是「存了等于没存」的静默。
 *        所以宁可当场失败、把行号报给用户，让他去文件里修。
 *      · **文案带行号**，行号是**表格里的行号**（表头算第 1 行）—— 用户照着在 Excel / WPS 里数得到；
 *      · 空行跳过（导出末尾常有空行），⛔ 不当错误；
 *      · 整份一行数据都没有 ⇒ 也**不认**（多半是拿错了文件）。
 *
 * @param {Array.<Array.<string>>} rows - `core/sheet-parser.js` 的 `parseSheet().rows`
 * @returns {{ok: true, rows: Array.<Object>}
 *          | {ok: false, code: string, message: string}} 行数组
 */
function parseSharkRows(rows) {
  const grid = Array.isArray(rows) ? rows : [];
  const at = locateColumns(grid);
  if (!at) {
    return {
      ok: false,
      code: 'shark-header',
      message:
        '这不是「鲨鱼记账」导出的明细文件 —— 表头里找不到「日期 / 收支类型 / 类别 / 金额」这几列。' +
        '请在鲨鱼记账里用「导出明细」（CSV）导一份，再拿那个文件来导。',
    };
  }

  const out = [];
  for (let r = at.head + 1; r < grid.length; r += 1) {
    const row = Array.isArray(grid[r]) ? grid[r] : [];
    // 整行都是空白 ⇒ 跳过（⛔ 不当错误）
    if (row.every((v) => String(v == null ? '' : v).trim() === '')) continue;
    const line = r + 1;

    const dateRaw = cell(row, at.date).trim();
    const when = toAt(dateRaw);
    if (!when) {
      return {
        ok: false,
        code: 'shark-date',
        message: `第 ${line} 行的日期认不出来：「${dateRaw}」。鲨鱼导出的日期长这样 —— 2025年12月22日。`,
      };
    }

    const ieRaw = cell(row, at.ie).trim();
    if (ieRaw !== IE_EXPENSE && ieRaw !== IE_INCOME) {
      return {
        ok: false,
        code: 'shark-ie',
        message: `第 ${line} 行的「收支类型」只认「支出」与「收入」，这一行写的是「${ieRaw}」。`,
      };
    }

    const amountRaw = cell(row, at.amount).trim();
    const fen = parseFen(amountRaw);
    if (fen === null) {
      return {
        ok: false,
        code: 'shark-amount',
        message: `第 ${line} 行的金额认不出来：「${amountRaw}」。要一个非负的数（最多两位小数），不带千分位。`,
      };
    }

    // ⭐ 六列原样（只去首尾空白）＋ 两个派生值
    out.push({
      dateRaw,
      ieRaw,
      category: cell(row, at.cat).trim(),
      account: cell(row, at.account).trim(),
      amountRaw,
      // ⚠️ 备注 `trim()` 之后原样（⛔ 不去掉开头的 `#`、⛔ 不做任何清洗）
      note: cell(row, at.note).trim(),
      at: when,
      fen,
    });
  }

  if (!out.length) {
    return {
      ok: false,
      code: 'shark-empty',
      message: '这个文件里一条明细都没有 —— 表头认出来了，但底下没有数据行。',
    };
  }
  return { ok: true, rows: out };
}

module.exports = {
  COLUMNS,
  IE_EXPENSE,
  IE_INCOME,
  toAt,
  isRealDay,
  locateColumns,
  parseSharkRows,
};
