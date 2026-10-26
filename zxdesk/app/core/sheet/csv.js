/**
sheet/csv.js —— CSV / TSV 文本解析 ＋ 生成
 *
 * 功能：CSV / TSV 的分隔符猜测（`sniffDelimiter`，含引号感知的计数 `countOutsideQuotes`）
 *      与逐行切分（`parseCsvRows`）；⭐ 0.8.3 补上**生成**那一半（`buildCsv`）。
 *
 * ⚠️ 分隔符必须在**引号之外**计数 —— 否则一行里带逗号的引号字段会把整个猜测带偏。
 *
 * ⭐⭐ 0.8.3：**CSV 序列化全仓只留这一份**（项目）。
 *   · 记账 4 期的「导出 CSV」要用它；
 *   · ⭐ 顺手把**课表模板**（`core/timetable/parse.js` 的 `buildTemplateCsv()`）也改成调它 ——
 *     那处从前是**函数体内的局部量**（`q()` / `line()`），也就是同一段 RFC 4180 转义的
 *     **第二份拷贝**。两份并存时，「引号里再嵌引号」这种边界只要有一处写错，
 *     导出的表就是坏的、而且**不报错**。
 *   ⚠️ 生成函数**不加 BOM**：BOM 由**调用方**加（课表那条接口贴 `'\uFEFF'`、
 *   记账导出那条接口同理）—— 那是「响应怎么发」的事，不是「CSV 怎么写」的事。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.4
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
 *    丢掉它整张表就散了。
 *
 * @param {string} text - 已解码的文本内容
 * @param {string} delim - 分隔符字符
 * @returns {Array.<Array.<string>>} 全部行的字符串网格（已去掉尾部整行空白）
 * @throws {Error} 行数超过 MAX_ROWS 上限时抛出
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
  // ⚠️⭐ 行数闸门要**在这里再查一次**（0.7.9 修）：上面循环里那一次只在「遇到换行」的分支里生效，
  //    而**末行是在循环外 push 的** ⇒ 5001 行、**末行不带换行**的文本会溜过去（实测返回
  //    `ok: true` + 5001 行）。循环里那一次**保留**：它能把病态文件尽早掐掉（2 MB 全是换行
  //    ≈ 100 万行，等全部建完数组再查会白吃一大片内存）。
  //    ⚠️ 必须放在**去尾部空行之后** —— 本判据的口径是「**真有几行数据**」：
  //    「以换行结尾的 5000 行」在循环里会多 push 一个空行（5001），去掉之后仍是 5000，不该报错。
  if (rows.length > MAX_ROWS) throw new Error('CSV 行数超过上限');
  return rows.map((r) => r.map((c) => String(c)));
}

/**
 * 功能：按 RFC 4180 把一个单元格值**加引号转义**（内部的双引号翻倍）。
 *
 * 说明：⚠️ **每个**单元格都加引号，不区分「需不需要」—— 这样「含逗号 / 含引号 / 含换行」
 *      三种边界与「普通值」走的是同一条路，⛔ 不存在「判断要不要加引号」那一段会写错的逻辑。
 *      ⚠️ `null` / `undefined` 一律写成**空串**（⛔ 不写 `"null"` —— 那会让「没有备注」
 *      在 Excel 里变成一个看得见的词）。
 *
 * @param {*} v - 单元格值
 * @returns {string} 加引号后的单元格文本
 */
function csvCell(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

/**
 * 功能：把一张二维表序列化成 CSV 文本（RFC 4180）。
 *
 * 说明：⭐ 这就是全仓**唯一**的 CSV 生成器（见文件头的说明）—— 课表模板与记账导出都走它。
 *      ⚠️ 行尾默认 **CRLF**（RFC 4180 如此，且 Excel 在 Windows 上对 CRLF 最省心）；
 *      ⚠️ **末行也带行尾**（`a,b\r\n` 而不是 `a,b`）—— 少一个行尾在多数软件里没差别，
 *      但它会让「按行切分再数行」那种读法少一行。
 *      ⚠️ 空表（没有行）⇒ 回**空串**（⛔ 不回一个只有行尾的空白文件）。
 *      ⚠️ 表头由调用方放进 `rows[0]` —— 本函数不认识「表头」这个概念（它就是一行）。
 *
 * @param {Array.<Array.<*>>} rows - 每行是单元格数组
 * @param {Object} [opts] - `{ delim?: string, eol?: string }`（默认 `','` / `'\r\n'`）
 * @returns {string} CSV 文本（**不含 BOM** —— BOM 由调用方加）
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
