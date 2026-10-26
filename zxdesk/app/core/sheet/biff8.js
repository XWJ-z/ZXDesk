/**
sheet/biff8.js —— BIFF8 记录流解析（网格化）
 *
 * 功能：把 OLE2 里取出的 `Workbook` 流按 BIFF8 记录逐条解出来并网格化成字符串二维数组
 *      （`readBiff8`），含共享字符串表、合并单元格与行/列上限。
 *
 * ⚠️ 这是**用户上传字节**的主解析路径，所有记录长度与循环都必须有上限；
 *    畸形记录一律经 `fail()` 明确报错，不许静默产出半张表。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const { MAX_COLS, MAX_ROWS } = require('./common.js');
const { MAX_RECORDS, decodeRk, fmtNum } = require('./ole2.js');

/**
 * 功能：解析 BIFF8 Workbook 流，逐子流还原出每张工作表的网格与合并区。
 *
 * 说明：实现的记录见；`sheet-parser.js` 只认「格子」，不认语义。
 * ⚠️ 三条硬要求（真实样本上都踩到过）：
 *   ① 尾部有 `0x0000 len=0` 的填充记录，要能安全跳过；
 *   ② 每条记录校验 `off+4+len <= 流长`，越界**立即中止**（错位会静默解析出一张错课表）；
 *   ③ `SST` 可能跨 `CONTINUE`，**不能先拼接字节再解析**（新块首字节是新的 grbit）。
 *
 * @param {Buffer} stream - Workbook 工作簿流的字节
 * @returns {Array.<{ name: string, rows: Array.<Array.<string>>, merges: Array.<Object> }>} 每张工作表的网格
 * @throws {Error} 记录长度越界 / 记录数超上限 / SST 下标越界时抛出
 */
function readBiff8(stream) {
  // ---- 先切成记录（带边界校验） ----
  const recs = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const type = stream.readUInt16LE(p);
    const len = stream.readUInt16LE(p + 2);
    if (p + 4 + len > stream.length) throw new Error('BIFF 记录长度越界（文件可能被截断或不是 .xls）');
    recs.push({ type, data: stream.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
    if (recs.length > MAX_RECORDS) throw new Error('BIFF 记录数超过上限');
  }

  // ---- SST（共享字符串），处理 CONTINUE ----
  /**
   * 功能：解析 SST（共享字符串表），按顺序还原出全部共享字符串。
   * 说明：字符串可能被 `CONTINUE` 切断，新块第 1 字节是新的 grbit（编码可能从压缩变 UTF-16），
   *      所以必须逐字符跨段读取，不能先把所有段拼成一整块字节。
   *
   * @returns {Array.<string>} 共享字符串数组，下标即 LABELSST 记录引用的索引
   * @throws {Error} 字符串数据或字符越界时抛出
   */
  const parseSst = () => {
    const idx = recs.findIndex((r) => r.type === 0x00fc);
    if (idx < 0) return [];
    const segs = [recs[idx].data];
    for (let j = idx + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(recs[j].data);
    let si = 0;
    let off = 8; // 跳过 cstTotal / cstUnique
    const total = segs[0].readUInt32LE(4);
    const out = [];
    /**
     * 功能：从 SST 的分段流里读 1 字节，段读完自动跨到下一个 CONTINUE 段。
     * @returns {number} 读到的字节值
     * @throws {Error} 所有分段读完仍不够时抛出
     */
    const u8 = () => {
      while (si < segs.length && off >= segs[si].length) {
        si++;
        off = 0;
      }
      if (si >= segs.length) throw new Error('SST 越界');
      return segs[si][off++];
    };
    /**
     * 功能：从 SST 的分段流里按小端顺序读 2 字节。
     * @returns {number} 读到的 16 位值
     */
    const u16 = () => {
      const a = u8();
      return a | (u8() << 8);
    };
    /**
     * 功能：从 SST 的分段流里按小端顺序读 4 字节，结果按无符号数返回。
     * @returns {number} 读到的 32 位无符号值
     */
    const u32 = () => {
      const a = u16();
      return (a | (u16() << 16)) >>> 0;
    };
    /**
     * 功能：从 SST 的分段流里跳过 n 字节（用于跳过扩展段等无需解析的内容）。
     * @param {number} n - 要跳过的字节数
     * @returns {void}
     */
    const skip = (n) => {
      for (let i = 0; i < n; i++) u8();
    };
    for (let s = 0; s < total; s++) {
      const cch = u16();
      const grbit = u8();
      let wide = !!(grbit & 0x01);
      let cRun = 0;
      let cbExt = 0;
      if (grbit & 0x08) cRun = u16();
      if (grbit & 0x04) cbExt = u32();
      let str = '';
      for (let i = 0; i < cch; i++) {
        // 字符串被 CONTINUE 切断：新块第 1 字节是新的 grbit（编码可能从压缩变 UTF-16）
        while (si < segs.length && off >= segs[si].length) {
          si++;
          off = 0;
          if (si < segs.length) wide = !!(segs[si][off++] & 0x01);
        }
        if (si >= segs.length) throw new Error('SST 字符越界');
        if (wide) {
          const lo = u8();
          const hi = u8();
          str += String.fromCharCode(lo | (hi << 8));
        } else {
          str += String.fromCharCode(u8());
        }
      }
      skip(cRun * 4);
      skip(cbExt);
      out.push(str);
    }
    return out;
  };
  const sst = parseSst();

  // ---- 逐子流解析 ----
  const sheets = [];
  let inGlobals = true;
  let cur = null;
  const pendingNames = [];
  for (let i = 0; i < recs.length; i++) {
    const { type, data } = recs[i];
    if (type === 0x0809) {
      // BOF
      const dt = data.length >= 4 ? data.readUInt16LE(2) : 0;
      if (dt === 0x0005) {
        inGlobals = true;
        cur = null;
      } else if (dt === 0x0010) {
        inGlobals = false;
        cur = { cells: new Map(), merges: [] };
        sheets.push(cur);
      }
      continue;
    }
    if (type === 0x000a) continue; // EOF
    if (inGlobals) {
      if (type === 0x0085 && data.length >= 8) {
        // BOUNDSHEET
        const cch = data[6];
        const grbit = data[7];
        pendingNames.push(
          grbit & 0x01
            ? data.subarray(8, 8 + cch * 2).toString('utf16le')
            : data.subarray(8, 8 + cch).toString('latin1'),
        );
      }
      continue;
    }
    if (!cur) continue;
    /**
     * 功能：把一个单元格值写进当前工作表的稀疏 Map，顺带做行列上限与空值过滤。
     * @param {number} r - 行号（0 起）
     * @param {number} c - 列号（0 起）
     * @param {*} v - 单元格的显示值
     * @returns {void}
     */
    const put = (r, c, v) => {
      if (r >= MAX_ROWS || c >= MAX_COLS) return;
      if (v === '' || v === null || v === undefined) return;
      cur.cells.set(`${r}:${c}`, v);
    };
    switch (type) {
      case 0x00fd: {
        // LABELSST
        const isst = data.readUInt32LE(6);
        if (isst >= sst.length) throw new Error('SST 下标越界');
        put(data.readUInt16LE(0), data.readUInt16LE(2), sst[isst]);
        break;
      }
      case 0x0203: // NUMBER
        put(data.readUInt16LE(0), data.readUInt16LE(2), fmtNum(data.readDoubleLE(6)));
        break;
      case 0x027e: // RK
        put(data.readUInt16LE(0), data.readUInt16LE(2), fmtNum(decodeRk(data.readInt32LE(6))));
        break;
      case 0x00bd: {
        // MULRK：row(2) colFirst(2) + N×(xf(2), rk(4)) + colLast(2)
        const row = data.readUInt16LE(0);
        const c1 = data.readUInt16LE(2);
        const n = Math.floor((data.length - 6) / 6);
        for (let k = 0; k < n; k++) put(row, c1 + k, fmtNum(decodeRk(data.readInt32LE(6 + k * 6))));
        break;
      }
      case 0x0205: // BOOLERR
        put(data.readUInt16LE(0), data.readUInt16LE(2), data[7] ? '' : data[6] ? 'TRUE' : 'FALSE');
        break;
      case 0x005e: {
        // LABEL（老式内联字符串）
        const cch = data.readUInt16LE(6);
        const g = data[8];
        put(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          g & 0x01 ? data.subarray(9, 9 + cch * 2).toString('utf16le') : data.subarray(9, 9 + cch).toString('latin1'),
        );
        break;
      }
      case 0x0006: {
        // FORMULA：结果 8 字节，末两字节 FFFF 表示特殊值
        const row = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        const b = data.subarray(6, 14);
        if (b[6] === 0xff && b[7] === 0xff) {
          const t = b[0];
          if (t === 0) {
            const nx = recs[i + 1];
            if (nx && nx.type === 0x0207 && nx.data.length >= 3) {
              const cch = nx.data.readUInt16LE(0);
              const g = nx.data[2];
              put(
                row,
                col,
                g & 0x01
                  ? nx.data.subarray(3, 3 + cch * 2).toString('utf16le')
                  : nx.data.subarray(3, 3 + cch).toString('latin1'),
              );
              i++;
            }
          } else if (t === 1) put(row, col, b[2] ? 'TRUE' : 'FALSE');
          else if (t === 2) put(row, col, '');
        } else {
          put(row, col, fmtNum(b.readDoubleLE(0)));
        }
        break;
      }
      case 0x00e5: {
        // MERGEDCELLS
        const n = data.readUInt16LE(0);
        for (let k = 0; k < n; k++) {
          const o = 2 + k * 8;
          if (o + 8 > data.length) break;
          cur.merges.push({
            r1: data.readUInt16LE(o),
            r2: data.readUInt16LE(o + 2),
            c1: data.readUInt16LE(o + 4),
            c2: data.readUInt16LE(o + 6),
          });
        }
        break;
      }
      default:
        break; // XF / FONT / STYLE / EXTSST / INDEX / DIMENSIONS / ROW / BLANK … 一律安静跳过
    }
  }

  // ---- 网格化（稀疏 Map → 二维数组，并展开合并区） ----
  return sheets.map((sh, i) => {
    let maxR = -1;
    let maxC = -1;
    for (const k of sh.cells.keys()) {
      const [r, c] = k.split(':').map(Number);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    for (const m of sh.merges) {
      if (m.r2 > maxR) maxR = m.r2;
      if (m.c2 > maxC) maxC = m.c2;
    }
    const rows = [];
    for (let r = 0; r <= maxR; r++) {
      const line = new Array(maxC + 1).fill('');
      for (let c = 0; c <= maxC; c++) line[c] = sh.cells.get(`${r}:${c}`) || '';
      rows.push(line);
    }
    // 合并单元格：把左上角的值填满整个矩形（换学校可能出现**纵向**合并，别只处理行内）
    for (const m of sh.merges) {
      const v = (rows[m.r1] || [])[m.c1] || '';
      if (!v) continue;
      for (let r = m.r1; r <= Math.min(m.r2, maxR); r++) {
        for (let c = m.c1; c <= Math.min(m.c2, maxC); c++) rows[r][c] = v;
      }
    }
    return { name: pendingNames[i] || `Sheet${i + 1}`, rows, merges: sh.merges };
  });
}

module.exports = {
  readBiff8,
};
