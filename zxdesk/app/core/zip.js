/**
 * zip.js —— 最小 ZIP 编解码（0.2.1）
 *
 * 功能：`buildZip(entries)` 把若干「名字 + 字节」打成一份 ZIP；`readZip(buf)` 按**中央目录**
 *      把 ZIP 读回成 `Map<名字, Buffer>`。整体备份压缩包（`ZXDesk-数据备份-*.zip`）用这一对。
 *
 * ⭐ 为什么自己写，而不是引库 / spawn `zip`：铁律 5 要求零运行时依赖，而且 `zip` 命令在 NAS 上
 *    未必存在、受限环境下 spawn 还会撞上命名管道限制 —— 与「自己解析 tar，不 spawn `tar.exe`」
 *    是同一个理由。压缩直接用内置 `node:zlib` 的 `deflateRawSync` / `inflateRawSync`
 *    （ZIP 的 method 8 就是**裸** deflate，没有 zlib 头），CRC32 自带一张 256 项查表。
 *
 * ⚠️ 读的时候**只信中央目录**里的尺寸与偏移，绝不信局部文件头 —— 被 Windows 资源管理器
 *    「解压再压缩」过的 ZIP 会写 data descriptor（局部头里的尺寸是 0），信局部头就会读出空文件。
 * ⚠️ 不支持 Zip64（>4GB 或成员数 ≥ 65535）：遇到就明确报错，不要静默读出半个文件。
 *    ⚠️ 反过来说：成员名一律写 ASCII（我们只放 `manifest.json` / `zxdesk.db` / `zxdesk.json` /
 *    `backup.json`）—— 非 ASCII 名字要不要带 UTF-8 标志位（bit 11）各家实现不一致，绕开这个坑。
 * ⚠️ `manifest.json` 由调用方以**不压缩**方式存入（`compress: false`）：前端的「恢复前预览」
 *    要在浏览器里直接读出它，而浏览器里没有解压手段（`DecompressionStream` 老内核没有），
 *    未压缩 = 切一段字节就能 `JSON.parse`。这是刻意的取舍，改动时别顺手把它压掉。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.7.2
 * 相关：docs/公共/架构文档/03-数据安全.md
 */
'use strict';

const zlib = require('node:zlib');

/** 三种结构块的签名（小端读出来的 4 字节值）：局部文件头 / 中央目录项 / 中央目录结尾 */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 压缩方式：0 = 原样存放，8 = 裸 deflate（ZIP 规范里的固定编号，不是我们定的） */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * ⭐ 单个成员**解压后**的尺寸上限（256MB）—— 009 报告 S8。
 *    `usize` 取自**中央目录**（声明值，可被伪造），这里只当「解压炸弹」的第一道闸：
 *    原实现是 `inflateRawSync` 之后才比对 `usize`，一个 64MB 的压缩包可以先膨胀出几 GB 再被拒（OOM 面）。
 *    ⚠️ 声明值不可信没关系 —— 真值仍由随后的「长度 === usize」+ CRC32 双重校验兜底，这里只是别先炸。
 */
const MAX_MEMBER_USIZE = 256 * 1024 * 1024;

/** CRC32 查表（多项式 0xEDB88320）—— 建一次，之后按字节查；`node:zlib.crc32` 要求较新的 Node，不依赖它 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/**
 * 功能：算一段字节的 CRC32（ZIP 用它做完整性校验）。
 * @param {Buffer} buf - 待计算的字节
 * @returns {number} 无符号 32 位校验值
 */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 功能：把当前时间转成 ZIP 用的 DOS 时间/日期（1980 起算、秒只有 2 秒精度，是格式本身的限制）。
 * @param {Date} d - 当前时间
 * @returns {{time: number, date: number}} 低 16 位时间与日期字段
 */
function dosDateTime(d) {
  const year = d.getFullYear() < 1980 ? 0 : d.getFullYear() - 1980;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 功能：把若干「名字 + 字节」打成一整份 ZIP 字节流（局部头 + 中央目录 + 结尾标记）。
 *
 * 说明：默认逐个 deflate；**压完比原文还大就改存不压缩**（`manifest.json` 这种小文件几乎必然
 *      如此，硬压只会白白多一层壳）。写 `compress: false` 则强制不压 —— 前端要直接读它。
 *
 * @param {Array.<{name: string, data: Buffer|string, compress?: boolean}>} entries - 成员清单，顺序即写入顺序
 * @returns {Buffer} 完整的 ZIP 字节
 */
function buildZip(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const dt = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  list.forEach((e) => {
    const name = String(e.name);
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    let method = METHOD_STORE;
    let body = raw;
    if (e.compress !== false) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }
    const sum = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(SIG_LOCAL, 0);
    head.writeUInt16LE(20, 4); // version needed to extract = 2.0
    head.writeUInt16LE(0, 6); // 标志位：无（成员名是 ASCII）
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(dt.time, 10);
    head.writeUInt16LE(dt.date, 12);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28); // extra 长度
    parts.push(head, nameBuf, body);
    central.push({ name, nameBuf, method, sum, csize: body.length, usize: raw.length, offset });
    offset += head.length + nameBuf.length + body.length;
  });

  const cdParts = [];
  let cdSize = 0;
  central.forEach((c) => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE(20, 4); // version made by（低字节 20 = 2.0，高字节 0 = MS-DOS/FAT）
    h.writeUInt16LE(20, 6); // version needed
    h.writeUInt16LE(0, 8); // 标志位
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(dt.time, 12);
    h.writeUInt16LE(dt.date, 14);
    h.writeUInt32LE(c.sum, 16);
    h.writeUInt32LE(c.csize, 20);
    h.writeUInt32LE(c.usize, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    // 30 extra / 32 comment / 34 起始磁盘 / 36 内部属性 / 38 外部属性 全为 0
    h.writeUInt32LE(c.offset, 42);
    cdParts.push(h, c.nameBuf);
    cdSize += h.length + c.nameBuf.length;
  });

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  // 4 / 6 起始磁盘号与中央目录所在磁盘号，均为 0
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  // 20 注释长度 = 0
  return Buffer.concat([...parts, ...cdParts, eocd]);
}

/**
 * 功能：从尾部往前找中央目录结尾标记（EOCD）的位置。
 * 说明：注释最长 65535 字节，所以只需要在最后 65557 字节里找。
 * @param {Buffer} buf - 整个 ZIP 字节
 * @returns {number} EOCD 的起始偏移；找不到返回 -1
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 功能：把一份 ZIP 读成「成员名 → 字节」的 Map（只认原样存放与 deflate 两种方式）。
 *
 * 说明：⭐ 尺寸与数据位置**全部取自中央目录**（理由见文件头）；每一项都会核对解出来的长度
 *      与 CRC —— 文件被截断或改坏时**抛错**，而不是把半份数据交出去。
 *
 * @param {Buffer} buf - 整个 ZIP 字节
 * @returns {Map.<string, Buffer>} 成员名 → 该成员的原始字节
 * @throws {Error} 不是 ZIP、文件被截断 / 损坏、或用了 Zip64 / 不支持的压缩方式时抛出
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('文件太小，不是一个压缩包');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('找不到压缩包的结尾标记，可能不是 ZIP 文件或已被截断');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('不支持 Zip64 格式的压缩包（本应用导出的包不会是这个格式）');
  }
  if (cdOff + cdSize > buf.length) throw new Error('压缩包目录越界，文件可能已损坏');

  const files = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('压缩包目录损坏');
    const sum = buf.readUInt32LE(p + 16);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) {
      throw new Error(`压缩包成员「${name}」的位置无效，文件可能已损坏`);
    }
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (start + csize > buf.length) throw new Error(`压缩包成员「${name}」的数据越界，文件可能已损坏`);
    const body = buf.subarray(start, start + csize);
    let data;
    // ⭐ 009 报告 S8：**先校验、后膨胀** —— 按中央目录声明的解压尺寸拦一道（
    //    原来是 `inflateRawSync` 之后才比对 `usize`，解压炸弹能先吃满内存再被拒）
    if (method === METHOD_DEFLATE && usize > MAX_MEMBER_USIZE) {
      throw new Error(`压缩包成员「${name}」解压后过大，已拒绝（可能是异常文件）`);
    }
    if (method === METHOD_STORE) data = Buffer.from(body);
    else if (method === METHOD_DEFLATE) data = zlib.inflateRawSync(body);
    else throw new Error(`压缩包成员「${name}」用了不支持的压缩方式（${method}）`);
    if (data.length !== usize || crc32(data) !== sum) {
      throw new Error(`压缩包成员「${name}」的内容校验不通过，文件可能已损坏`);
    }
    files.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

module.exports = { METHOD_DEFLATE, METHOD_STORE, buildZip, crc32, readZip };
