/**
sheet/ole2.js —— OLE2 复合文档与 BIFF8 基础类型解码
 *
 * 功能：解 OLE2 复合文档取出目标流（`readOle2`），以及 BIFF8 记录里用到的数值解码
 *      （`decodeRk` 解 RK 数值、`fmtNum` 归一化数字文本）与扇区链表常量。
 *
 * ⚠️ 真 BIFF8 `.xls` 是 **OLE2 复合文档**，魔数 `D0 CF 11 E0 A1 B1 1A E1`；
 *    **按内容识别，不看扩展名** —— 扩展名在真实世界里对不上。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

/** BIFF 记录数上限（正常文件百来条） */
const MAX_RECORDS = 200000;

const END_OF_CHAIN = 0xfffffffe;

const FREE_SECTOR = 0xffffffff;

/**
 * 功能：解析 OLE2 复合文档，取出其中的普通流，返回 `Map<流名, Buffer>`（小流走迷你流也会正确拼回）。
 *
 * 说明：任何结构性异常都抛 `Error`（由 parseSheet 统一转成友好结果）。
 *
 * @param {Buffer} buf - 整个 .xls 文件的字节
 * @returns {{ streams: Map.<string, Buffer>, names: Array.<string> }} 流表与全部普通流的名字列表
 * @throws {Error} 头部不足 / 扇区大小非法 / FAT 链成环或越界 / 流长度不足时抛出
 */
function readOle2(buf) {
  if (buf.length < 512) throw new Error('OLE2 头部不足 512 字节');
  const sectorShift = buf.readUInt16LE(0x1e);
  const miniSectorShift = buf.readUInt16LE(0x20);
  const majorVersion = buf.readUInt16LE(0x1a);
  if (sectorShift < 7 || sectorShift > 20) throw new Error('OLE2 扇区大小非法');
  const ssz = 1 << sectorShift;
  const mssz = 1 << miniSectorShift;
  const dirStart = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  const miniFatCount = buf.readUInt32LE(0x40);
  const difatStart = buf.readUInt32LE(0x44);
  const difatCount = buf.readUInt32LE(0x48);

  /**
   * 功能：按扇区号取出一段扇区字节（512 字节头之后的第 n 个扇区）。
   * @param {number} n - 扇区号（0 起）
   * @returns {Buffer} 该扇区的字节视图
   * @throws {Error} 扇区号越界时抛出
   */
  const sector = (n) => {
    const off = 512 + n * ssz;
    if (n < 0 || off + ssz > buf.length) throw new Error(`OLE2 扇区 ${n} 越界`);
    return buf.subarray(off, off + ssz);
  };

  /**
   * 功能：沿分配表从起始扇区号一路收集扇区号，返回扇区号数组。
   * 说明：带环检测 —— 畸形文件的链可能成环，成环时立即报错，而不是死循环。
   *
   * @param {number} start - 链的起始扇区号
   * @param {Array.<number>} fat - 分配表（下标为扇区号，值为下一个扇区号）
   * @returns {Array.<number>} 该链上的扇区号数组
   * @throws {Error} 链成环或越界时抛出
   */
  const chain = (start, fat) => {
    const out = [];
    const seen = new Set();
    let s = start;
    while (s !== END_OF_CHAIN && s !== FREE_SECTOR && s !== undefined) {
      if (seen.has(s)) throw new Error('OLE2 FAT 链成环');
      seen.add(s);
      out.push(s);
      if (s >= fat.length) throw new Error('OLE2 FAT 链越界');
      s = fat[s];
    }
    return out;
  };

  // DIFAT → FAT 扇区列表
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(0x4c + i * 4);
    if (v !== FREE_SECTOR) difat.push(v);
  }
  let ds = difatStart;
  for (let guard = 0; ds !== END_OF_CHAIN && ds !== FREE_SECTOR && guard < difatCount + 64; guard++) {
    const sec = sector(ds);
    for (let i = 0; i < ssz / 4 - 1; i++) {
      const v = sec.readUInt32LE(i * 4);
      if (v !== FREE_SECTOR) difat.push(v);
    }
    ds = sec.readUInt32LE(ssz - 4);
  }

  const fat = [];
  for (const s of difat) {
    const sec = sector(s);
    for (let i = 0; i < ssz / 4; i++) fat.push(sec.readUInt32LE(i * 4));
  }

  // 目录
  const dir = Buffer.concat(chain(dirStart, fat).map(sector));
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 0x40);
    const type = dir[off + 0x42];
    if (!type) continue;
    const name = dir.subarray(off, off + Math.max(0, nameLen - 2)).toString('utf16le');
    const start = dir.readUInt32LE(off + 0x74);
    // v3 只用低 32 位；v4 才可能超过，超了直接当非法（课表文件不可能那么大）
    const size = majorVersion === 3 ? dir.readUInt32LE(off + 0x78) : Number(dir.readBigUInt64LE(off + 0x78));
    entries.push({ name, type, start, size });
  }

  // miniFAT + mini 流
  const miniFat = [];
  if (miniFatCount > 0) {
    for (const s of chain(miniFatStart, fat)) {
      const sec = sector(s);
      for (let i = 0; i < ssz / 4; i++) miniFat.push(sec.readUInt32LE(i * 4));
    }
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? Buffer.concat(chain(root.start, fat).map(sector)) : Buffer.alloc(0);

  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue; // 2 = 普通流
    if (e.size <= 0) {
      streams.set(e.name, Buffer.alloc(0));
      continue;
    }
    let data;
    if (e.size < miniCutoff) {
      // ⚠️ 小流走 miniFAT + mini 流：**必须实现**，否则小于 4KB 的 Workbook 直接读不出来
      data = Buffer.concat(chain(e.start, miniFat).map((n) => miniStream.subarray(n * mssz, (n + 1) * mssz)));
    } else {
      data = Buffer.concat(chain(e.start, fat).map(sector));
    }
    if (data.length < e.size) throw new Error(`OLE2 流 ${e.name} 长度不足`);
    streams.set(e.name, data.subarray(0, e.size));
  }
  return { streams, names: entries.filter((e) => e.type === 2).map((e) => e.name) };
}

/**
 * 功能：把 BIFF8 的 RK 压缩数值解码成 JavaScript 数字。
 * 说明：RK 有三种变体 —— 30 位整数 / IEEE754 高 30 位浮点 / 结果再 ÷100，按低位标志位分支。
 *
 * @param {number} rk - 记录里的 4 字节 RK 原始值
 * @returns {number} 解码后的数值
 */
function decodeRk(rk) {
  let v;
  if (rk & 0x02) {
    v = (rk | 0) >> 2;
  } else {
    const t = Buffer.alloc(8);
    t.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = t.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

/**
 * 功能：把数值格式化成单元格的显示字符串 —— 整数不带小数点，小数去掉浮点尾巴。
 * @param {number} v - 待格式化的数值
 * @returns {string} 显示字符串；非有限数（NaN / Infinity）返回空串
 */
function fmtNum(v) {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e6) / 1e6);
}

module.exports = {
  MAX_RECORDS,
  END_OF_CHAIN,
  FREE_SECTOR,
  readOle2,
  decodeRk,
  fmtNum,
};
