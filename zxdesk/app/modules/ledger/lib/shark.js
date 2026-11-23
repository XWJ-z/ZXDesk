'use strict';
/**
 * modules/ledger/lib/shark.js —— **鲨鱼记账**导出文件的解析口径（全模块唯一出处）
 * 功能：把「鲨鱼记账」导出的那张表（`string[][]`，由 `core/sheet-parser.js` 的 `parseSheet()`
 * 解出来）折成**六列原样 ＋ 两个派生值**：
 * @author zx
 * @date   2026-09-24
 * @since 0.9.7
 * 相关：docs/公共/开发方案/23-记账-三方导入（鲨鱼记账）.md、docs/公共/架构文档/23-记账.md
 */

const { parseFen } = require('./money.js');

/**
 * 列名 —— ⭐ 认列的**唯一凭据**（⛔ 不认列序）。
 *
 */
const COLUMNS = { date: '日期', ie: '收支类型', cat: '类别', account: '账户', amount: '金额', note: '备注' };

/**
 * 只认这两个收支值 —— ⭐ 与 `ledger_entries.ie` 的取值**逐字一致**（2 期 第 9 条）。
 * @type {string}
 */
const IE_EXPENSE = '支出';

/** @type {string} */
const IE_INCOME = '收入';

/**
 * 表头最多往下找几行。
 *
 */
const HEADER_SCAN_ROWS = 5;

/**
 * @type {RegExp}
 */
const RE_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;

/**
 *
 * 那种串不但过得去，还会变成一条日期错了一个月的账，而且**不报错**。
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
 *
 * 说明：⭐⭐ **只给日期、不给时刻**（鲨鱼导出那一列本来就只有日期）。
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
 * 那会变成一条备注写着 `undefined` 的账 —— 而且**不报错**）。
 *
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
 * `账户` / `备注` 可有可无（没有就一律当空串）。
 * 找表头**只看前 `HEADER_SCAN_ROWS` 行**，并取**第一行同时含有四个必需列名**的那一行。
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
 * **一行不认就整份不认**（⛔ 不「跳过坏行」、⛔ 也不「存下来但标成坏」）——
 * 尤其是日期认不出的行：我们的取数一律**按月**（`at` 的区间）⇒ 那种行就算存进库
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

    // 六列原样（只去首尾空白）＋ 两个派生值
    out.push({
      dateRaw,
      ieRaw,
      category: cell(row, at.cat).trim(),
      account: cell(row, at.account).trim(),
      amountRaw,
      // 备注 `trim()` 之后原样（⛔ 不去掉开头的 `#`、⛔ 不做任何清洗）
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
