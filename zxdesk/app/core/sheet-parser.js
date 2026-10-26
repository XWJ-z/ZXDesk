/**
sheet-parser.js —— 通用表格解析（**门面**：对外入口与拆分前逐字一致）
 *
 * 功能：**零运行时依赖**的通用表格解析入口 —— `parseSheet` 是唯一公开入口
 *      （按内容判形态 → 分派到 OLE2/BIFF8 或 CSV/TSV → 返回统一的网格 IR），
 *      另有 `sniffFormat`（按内容判形态）与 `decodeText`（UTF-8 / GBK 编码探测）。
 *
 * ⚠️ 0.2.0（002 报告 §5.1 ④）按**文件格式**拆成 `sheet/{common,ole2,biff8,csv}.js`，
 *    **门面保留在原路径** —— 外部 `require('./sheet-parser.js')` 一行都不用改，对外入口不变。
 * ⚠️ 本文件只负责**把任意表格变成二维字符串数组**，不含任何「课表」语义
 *    （星期 / 节次 / 周次都在 `timetable/`）。将来加 `.xlsx` 只动这一层。
 * ⚠️ 产出统一为网格 IR：`{ source, sheetName, sheetNames, rows, merges, warnings }`。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.7.9
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const sheet_biff8_js = require('./sheet/biff8.js');
const { readBiff8 } = sheet_biff8_js;
const sheet_common_js = require('./sheet/common.js');
const { MAX_BYTES, fail } = sheet_common_js;
const sheet_csv_js = require('./sheet/csv.js');
const { parseCsvRows, sniffDelimiter } = sheet_csv_js;
const sheet_ole2_js = require('./sheet/ole2.js');
const { readOle2 } = sheet_ole2_js;

/**
 * 功能：只看文件前 8 字节的魔数，并对开头文本做嗅探，判断这是哪一种表格文件。
 * 说明：**不信任扩展名** —— 扩展名在真实世界里对不上，按内容识别才靠得住。
 *
 * @param {Buffer} buf - 上传文件的原始字节
 * @returns {string} 形态标识：'empty' / 'ole2' / 'zip' / 'excel-html' / 'html' / 'text'
 */
function sniffFormat(buf) {
  if (!buf || buf.length === 0) return 'empty';
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0) return 'ole2';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  // 文本类：先按 UTF-8 解，失败再 GBK（编码判定见 decodeText）
  const dec = decodeText(buf.subarray(0, Math.min(buf.length, 65536)));
  const head = dec ? dec.text : '';
  if (/<\?xml/i.test(head) && /urn:schemas-microsoft-com:office:/i.test(head)) return 'excel-html';
  if (/<\s*(!doctype\s+html|html|table)/i.test(head)) return 'html';
  return 'text';
}

/**
 * 功能：把文本类字节解码成字符串，返回 `{ text, encoding }`；几种编码都解不出时返回 `null`。
 *
 * 说明：顺序有实测依据：
 *   1. `EF BB BF` → UTF-8，**必须去掉 BOM**，否则第一格列名带上不可见字符、列识别失败；
 *   2. ⭐ 0.7.9：`FF FE` / `FE FF` → UTF-16（LE / BE），同样**必须去掉 BOM**。
 *      ⚠️ 从前没有这一支 ⇒ 带 BOM 的 UTF-16LE 在严格 UTF-8 解码失败后**落到永不抛错的 GBK 兜底**，
 *      于是返回 `ok: true` + 一张乱码表 —— 用户看到的是「模板签名不匹配」，根本联想不到是编码。
 *      没有 BOM 的 UTF-16 **刻意不猜**（无法可靠判定，宁可报 `ENCODING` 让他另存一份）。
 *   3. 严格 UTF-8（`fatal:true`）—— Excel 的「CSV UTF-8」是**无 BOM 的 UTF-8**，只能靠严格解码判定；
 *   4. GBK —— Excel 的「CSV（逗号分隔）」按系统默认编码存，就是 GBK；
 *   5. 都失败 → null（由调用方给「请另存为 CSV UTF-8」）。
 *
 * ⚠️ `new TextDecoder('gbk')` 在 **small-icu** 构建上会抛（飞牛的 nodejs_v22 有可能就是），
 *    所以必须包在 try/catch 里 —— 抛了就当「解不出」，给可操作提示，而不是 500。
 *
 * @param {Buffer} buf - 待解码的原始字节
 * @returns {?{ text: string, encoding: string }} 解码后的文本与所用编码；解不出时为 null
 */
function decodeText(buf) {
  if (!buf || !buf.length) return null;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // ⚠️ Node 只认 `utf16le` ⇒ 大端先两两换字节再解（BOM 已去掉）。
    //    字节数为奇数 ⇒ 不是合法的 UTF-16，直接当「解不出」（`swap16()` 会抛，不能让它抛出去）。
    const body = Buffer.from(buf.subarray(2));
    if (body.length % 2) return null;
    body.swap16();
    return { text: body.toString('utf16le'), encoding: 'utf-16be' };
  }
  if (typeof TextDecoder === 'function') {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
    } catch (_e) {
      /* 不是合法 UTF-8，继续试 GBK */
    }
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' };
    } catch (_e) {
      /* 无 GBK 解码器（small-icu）或解码失败 */
    }
    return null;
  }
  // 极老的 Node（没有 TextDecoder）：退回 Buffer 的 utf8（不严格，但总比没有强）
  return { text: buf.toString('utf8'), encoding: 'utf-8-loose' };
}

/**
 * 功能：把上传的字节解析成网格 IR —— 先按内容识别文件形态，再分派到 OLE2/BIFF8 或 CSV/TSV 两条路径。
 *
 * 说明：⚠️ 处理的是用户上传的任意字节，体积 / 行数 / 列数 / 记录数都有上限与校验；
 *    畸形文件一律返回带可操作提示的失败结果，绝不半途静默产出一张错表。
 *
 * @param {Buffer} buf - 上传文件的原始字节
 * @returns {{ok:true, source:string, sheetName:string, sheetNames:string[], rows:string[][], merges:Array, warnings:string[]}
 *          | {ok:false, code:string, message:string}}
 */
function parseSheet(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return fail('EMPTY', '文件是空的，请重新导出后再试。');
  if (buf.length > MAX_BYTES) {
    return fail('TOO_BIG', `文件太大（上限 ${Math.round(MAX_BYTES / 1024 / 1024)} MB），课表文件一般只有几十 KB。`);
  }

  const fmt = sniffFormat(buf);
  const warnings = [];

  if (fmt === 'zip') {
    return fail(
      'XLSX',
      '这是新版 Excel 工作簿（.xlsx），当前版本还读不了。' +
        '请用 WPS / Excel 打开它，另存为「Excel 97-2003 工作簿（.xls）」或「CSV UTF-8（逗号分隔）」，再上传。',
    );
  }
  if (fmt === 'excel-html' || fmt === 'html') {
    return fail(
      'HTML_TABLE',
      '这是网页表格（有些教务系统会把 .xls 导出成 HTML），当前版本还读不了。' +
        '请用 WPS / Excel 打开它另存为「Excel 97-2003 工作簿（.xls）」或「CSV UTF-8（逗号分隔）」，再上传。',
    );
  }
  if (fmt === 'ole2') {
    let ole;
    try {
      ole = readOle2(buf);
    } catch (e) {
      return fail('OLE2_BROKEN', `这个 .xls 文件结构不完整，读不出来（${e.message}）。请重新从教务系统导出。`);
    }
    const wbName = ole.streams.has('Workbook') ? 'Workbook' : ole.streams.has('Book') ? 'Book' : null;
    if (!wbName) {
      return fail(
        'NOT_EXCEL',
        '这是一个 Office 老式文档，但里面没有 Excel 工作表（像是 Word 文档）。' +
          '请把课表导出成表格文件（.xls / .csv）后再上传。',
      );
    }
    let grids;
    try {
      grids = readBiff8(ole.streams.get(wbName));
    } catch (e) {
      return fail('XLS_BROKEN', `这个 .xls 表格读不出来（${e.message}）。请重新从教务系统导出。`);
    }
    const first = grids.find((g) => g.rows.length);
    if (!first) return fail('EMPTY_SHEET', '这个 .xls 里没有找到任何有内容的单元格。');
    if (grids.length > 1) warnings.push(`文件里有 ${grids.length} 张工作表，已使用第一张「${first.name}」`);
    return {
      ok: true,
      source: 'xls',
      sheetName: first.name,
      sheetNames: grids.map((g) => g.name),
      rows: first.rows,
      merges: first.merges,
      warnings,
    };
  }

  // 文本：CSV / TSV
  const dec = decodeText(buf);
  if (!dec) {
    return fail('ENCODING', '这个文件的编码识别不出来。请用 WPS / Excel 另存为「CSV UTF-8（逗号分隔）」后重新上传。');
  }
  if (dec.encoding === 'gbk' || dec.encoding === 'utf-8-loose') {
    warnings.push(`文件按 ${dec.encoding === 'gbk' ? 'GBK' : '本机默认编码'} 解码（建议另存为 CSV UTF-8）`);
  }
  const delim = sniffDelimiter(dec.text);
  let rows;
  try {
    rows = parseCsvRows(dec.text, delim);
  } catch (e) {
    return fail('CSV_BROKEN', `表格读不出来（${e.message}）。`);
  }
  if (!rows.length) return fail('EMPTY_SHEET', '文件里没有找到任何有内容的行。');
  return {
    ok: true,
    source: delim === '\t' ? 'tsv' : 'csv',
    sheetName: 'CSV',
    sheetNames: ['CSV'],
    rows,
    merges: [],
    warnings,
  };
}

module.exports = {
  MAX_BYTES: sheet_common_js.MAX_BYTES,
  parseSheet,
  sniffFormat,
  decodeText,
  sniffDelimiter: sheet_csv_js.sniffDelimiter,
  parseCsvRows: sheet_csv_js.parseCsvRows,
  decodeRk: sheet_ole2_js.decodeRk,
  readOle2: sheet_ole2_js.readOle2,
  readBiff8: sheet_biff8_js.readBiff8,
};
