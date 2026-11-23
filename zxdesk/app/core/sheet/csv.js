/**
 * sheet/csv.js —— CSV / TSV 文本解析 ＋ 生成
 *
 * 功能：CSV / TSV 的分隔符猜测（`sniffDelimiter`，含引号感知的计数 `countOutsideQuotes`）
 * 与逐行切分（`parseCsvRows`）；补上**生成**那一半（`buildCsv`）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const { MAX_ROWS } = require('./common.js');

/**
 * 功能：数出一行文本里「不在双引号内」的分隔符个数。
 * @param {string} line - 单行文本
 * @param {string} delim - 分隔符字符
 * @returns {number} 引号外的分隔符个数
 */
function countOutsideQuotes(line, delim) {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === delim) n++;
  }
  return n;
}

/**
 * 功能：在候选分隔符里猜出这份文本用的是哪一个 —— 取「各行出现次数最一致、且次数最多」的那个。
 * @param {string} text - 已解码的文本内容
 * @returns {string} 选中的分隔符；一个都数不出时回退为 `,`
 */
function sniffDelimiter(text) {
  const lines = text
    .split(/\r?\n/)
    .slice(0, 30)
    .filter((l) => l.trim());
  if (!lines.length) return ',';
  let best = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const max = Math.max(...counts);
    if (max === 0) continue;
    const freq = new Map();
    counts.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1));
    const top = Math.max(...freq.values());
    const score = top * 1000 + max;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * 功能：按 RFC 4180 把整份文本切成二维字符串数组（行 × 列）。
 * 说明：⚠️ **引号内的换行不当作行分隔** —— 这条是硬要求：课表每个课程格子内部都有真换行，
 * 丢掉它整张表就散了。
 *
 * @param {string} text - 已解码的文本内容
 */
function parseCsvRows(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQ = true;
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length > MAX_ROWS) throw new Error('CSV 行数超过上限');
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  // 去掉尾部完全空白的行（Excel 另存常带一个尾行）
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  // 而**末行是在循环外 push 的** ⇒ 5001 行、**末行不带换行**的文本会溜过去（实测返回
  // `ok: true` + 5001 行）。循环里那一次**保留**：它能把病态文件尽早掐掉（2 MB 全是换行
  // ≈ 100 万行，等全部建完数组再查会白吃一大片内存）。
  if (rows.length > MAX_ROWS) throw new Error('CSV 行数超过上限');
  return rows.map((r) => r.map((c) => String(c)));
}

/**
 * 功能：按 RFC 4180 把一个单元格值**加引号转义**（内部的双引号翻倍）。
 *
 * 说明：⚠️ **每个**单元格都加引号，不区分「需不需要」—— 这样「含逗号 / 含引号 / 含换行」
 * 三种边界与「普通值」走的是同一条路，⛔ 不存在「判断要不要加引号」那一段会写错的逻辑。
 * 在 Excel 里变成一个看得见的词）。
 */
function csvCell(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

/**
 * 功能：把一张二维表序列化成 CSV 文本（RFC 4180）。
 *
 * 说明：⭐ 这就是全仓**唯一**的 CSV 生成器（见文件头的说明）—— 课表模板与记账导出都走它。
 * 行尾默认 **CRLF**（RFC 4180 如此，且 Excel 在 Windows 上对 CRLF 最省心）；
 * **末行也带行尾**（`a,b\r\n` 而不是 `a,b`）—— 少一个行尾在多数软件里没差别，
 */
function buildCsv(rows, opts) {
  const o = opts || {};
  const delim = o.delim == null ? ',' : String(o.delim);
  const eol = o.eol == null ? '\r\n' : String(o.eol);
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  const lines = list.map((r) => (Array.isArray(r) ? r : [r]).map(csvCell).join(delim));
  return lines.join(eol) + eol;
}

module.exports = {
  countOutsideQuotes,
  sniffDelimiter,
  parseCsvRows,
  buildCsv,
};
