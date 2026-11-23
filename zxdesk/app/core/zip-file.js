/**
 * ZXDesk工作台 飞牛原生应用
 *
 * 功能：`writeZipFile()` 把「内存字节 + 磁盘文件」混编成一个 ZIP 并**边读边写**；
 * `readCentral()` / `readManifest()` / `verifyZip()` / `extractZip()` 负责读回校验与还原。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, Writable } = require('node:stream');

/** 三种结构块的签名（小端 4 字节值）：局部文件头 / 中央目录项 / 中央目录结尾 / 数据描述符 */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESC = 0x08074b50;

/** 压缩方式：0 = 原样存放，8 = 裸 deflate */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 标志位：bit 3 = 数据描述符（CRC 与尺寸在数据之后），bit 11 = 成员名是 UTF-8 */
const FLAG_DESC = 0x0008;
const FLAG_UTF8 = 0x0800;

/** 不写 Zip64 ⇒ 这两个上限是硬边界，越界就报错 */
const MAX_U32 = 0xffffffff;
const MAX_MEMBERS = 0xffff;

/** 单次读写块大小：64KB 在 NAS 上既不过碎也不过贪 */
const CHUNK = 64 * 1024;

/** 中央目录读取时，尾部搜索区（EOCD 注释最长 65535） */
const TAIL = 65557;

/** CRC32 查表（多项式 0xEDB88320）—— 与 `zip.js` 同一条算法，只是这里按块增量算 */
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
 * 功能：算一段字节的 CRC32（一次性，供小成员用）。
 * @param {Buffer} buf - 待计算字节
 * @returns {number} 无符号 32 位校验值
 */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 功能：增量累积 CRC32 —— 流式读盘时不可能一次拿到整块字节。
 * @param {number} state - 上一次的中间值（首次传 `-1`）
 * @param {Buffer} buf - 本块字节
 * @returns {number} 新的中间值
 */
function crcUpdate(state, buf) {
  let c = state;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/**
 * 功能：把中间值收成最终 CRC32。
 * @param {number} state - `crcUpdate()` 的返回值
 * @returns {number} 无符号 32 位校验值
 */
function crcFinal(state) {
  return (state ^ -1) >>> 0;
}

/**
 * 功能：当前时间转 ZIP 的 DOS 时间 / 日期字段（1980 起算，秒只有 2 秒精度）。
 * @param {Date} d - 时间
 * @returns {{time: number, date: number}} 两个 16 位字段
 */
function dosDateTime(d) {
  const year = d.getFullYear() < 1980 ? 0 : d.getFullYear() - 1980;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 功能：拼一个 30 字节的局部文件头。
 * @param {Object} o - `{nameLen, method, flags, time, date, crc, csize, usize}`
 * @returns {Buffer} 头部字节
 */
function localHeader(o) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(o.flags, 6);
  h.writeUInt16LE(o.method, 8);
  h.writeUInt16LE(o.time, 10);
  h.writeUInt16LE(o.date, 12);
  h.writeUInt32LE(o.crc >>> 0, 14);
  h.writeUInt32LE(o.csize >>> 0, 18);
  h.writeUInt32LE(o.usize >>> 0, 22);
  h.writeUInt16LE(o.nameLen, 26);
  h.writeUInt16LE(0, 28);
  return h;
}

/**
 * 功能：拼一个 16 字节的数据描述符（bit 3 那一条的配套）。
 * @param {{crc: number, csize: number, usize: number}} o - 真实校验值与尺寸
 * @returns {Buffer} 描述符字节
 */
function dataDescriptor(o) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(SIG_DESC, 0);
  b.writeUInt32LE(o.crc >>> 0, 4);
  b.writeUInt32LE(o.csize >>> 0, 8);
  b.writeUInt32LE(o.usize >>> 0, 12);
  return b;
}

/**
 * 功能：把一段字节完整写进文件句柄（`write()` 允许短写，逐段推进）。
 * @param {Object} fh - `fs.promises` 文件句柄
 * @param {Buffer} buf - 字节
 * @returns {Promise.<void>} 写完后结算
 */
async function writeAll(fh, buf) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

/**
 * 功能：把一条「文件成员」以**流式 deflate** 写进输出句柄，返回它的校验与尺寸。
 *
 * 说明：⚠️ 必须逐成员串行等待：中央目录里的偏移是绝对位置，两个成员同时写会互相踩。
 * 流式三段用 `pipeline` 串起来（读盘 → 记账 → 压缩 → 写盘），任一段出错整条链结算为失败。
 *
 */
async function writeFileMember(fh, file) {
  const hash = crypto.createHash('sha256');
  let crcState = -1;
  let usize = 0;
  let csize = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      crcState = crcUpdate(crcState, chunk);
      hash.update(chunk);
      usize += chunk.length;
      cb(null, chunk);
    },
  });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      csize += chunk.length;
      writeAll(fh, chunk).then(() => cb(), cb);
    },
  });
  await pipeline(fs.createReadStream(file, { highWaterMark: CHUNK }), tap, zlib.createDeflateRaw({ level: 6 }), sink);
  return { crc: crcFinal(crcState), csize, usize, sha256: hash.digest('hex') };
}

/**
 * 功能：把一个成员清单写成一份 ZIP（先 `.part`，`fsync` 后 `rename`）。
 *
 * 说明：成员两种形态 —— `{name, data}` 是内存字节（小文件、manifest、库快照）；
 * `{name, file}` 是磁盘文件（边读边压，不进内存）。
 * `compress: false` 只对内存成员有意义（`manifest.json` 要能被直接切出来读）。
 */
async function writeZipFile(outPath, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > MAX_MEMBERS) throw new Error(`文件太多（${list.length} 个），超过 ZIP 上限 ${MAX_MEMBERS}`);
  const part = `${outPath}.part`;
  const dt = dosDateTime(new Date());
  const central = [];
  const members = [];
  let offset = 0;
  const fh = await fsp.open(part, 'w');
  try {
    for (const e of list) {
      const name = String(e.name || '');
      if (!name || name.startsWith('/') || name.split('/').includes('..')) {
        throw new Error(`成员名不合法：${name || '(空)'}`);
      }
      const nameBuf = Buffer.from(name, 'utf8');
      const flags = (FLAG_DESC | (/[^\x00-\x7f]/.test(name) ? FLAG_UTF8 : 0)) >>> 0;
      if (Buffer.isBuffer(e.data)) {
        // ---- 内存成员：CRC 与尺寸都能提前算，于是走「无描述符」的普通写法 ----
        const raw = e.data;
        const store = e.compress === false;
        const body = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
        const method = store ? METHOD_STORE : METHOD_DEFLATE;
        const plainFlags = (/[^\x00-\x7f]/.test(name) ? FLAG_UTF8 : 0) >>> 0;
        const plainHead = localHeader({
          nameLen: nameBuf.length,
          method,
          flags: plainFlags,
          time: dt.time,
          date: dt.date,
          crc: crc32(raw),
          csize: body.length,
          usize: raw.length,
        });
        await writeAll(fh, plainHead);
        await writeAll(fh, nameBuf);
        await writeAll(fh, body);
        central.push({ nameBuf, method, flags: plainFlags, crc: crc32(raw), csize: body.length, usize: raw.length, offset });
        members.push({ path: name, size: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex') });
        offset += plainHead.length + nameBuf.length + body.length;
        continue;
      }
      // ---- 文件成员：流式 ----
      const file = String(e.file || '');
      const st = await fsp.stat(file);
      if (st.size >= MAX_U32) throw new Error(`文件过大（${name}）：不支持超过 4GB 的单个成员`);
      const head = localHeader({
        nameLen: nameBuf.length,
        method: METHOD_DEFLATE,
        flags,
        time: dt.time,
        date: dt.date,
        crc: 0,
        csize: 0,
        usize: 0,
      });
      await writeAll(fh, head);
      await writeAll(fh, nameBuf);
      // `offset` 本身就是这个成员局部头的落点（它一直在跟踪「已经写了多少字节」），
      // 再减一次头长度会把偏移指向数据中间，读回时表现为「成员位置无效」。
      const base = offset;
      const r = await writeFileMember(fh, file);
      const desc = dataDescriptor(r);
      await writeAll(fh, desc);
      central.push({ nameBuf, method: METHOD_DEFLATE, flags, crc: r.crc, csize: r.csize, usize: r.usize, offset: base });
      members.push({ path: name, size: r.usize, sha256: r.sha256 });
      offset = base + head.length + nameBuf.length + r.csize + desc.length;
    }
    if (offset >= MAX_U32) throw new Error('归档总量超过 4GB，不支持（需要 Zip64）');
    // ---- 中央目录 ----
    const cdParts = [];
    let cdSize = 0;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(c.flags, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(dt.time, 12);
      h.writeUInt16LE(dt.date, 14);
      h.writeUInt32LE(c.crc >>> 0, 16);
      h.writeUInt32LE(c.csize >>> 0, 20);
      h.writeUInt32LE(c.usize >>> 0, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt32LE(c.offset >>> 0, 42);
      cdParts.push(h, c.nameBuf);
      cdSize += h.length + c.nameBuf.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize >>> 0, 12);
    eocd.writeUInt32LE(offset >>> 0, 16);
    for (const p of cdParts) await writeAll(fh, p);
    await writeAll(fh, eocd);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();
  await fsp.rename(part, outPath);
  const totalBytes = members.reduce((n, m) => n + m.size, 0);
  return { members, totalBytes };
}

/**
 * 功能：读出一份 ZIP 的中央目录（⚠️ 只信中央目录，不信局部头）。
 * @param {string} filePath - ZIP 路径
 * @returns {{entries: Array.<{name: string, method: number, flags: number, crc: number, csize: number, usize: number, offset: number}>, cdOffset: number}} 目录与中央目录起始偏移
 * @throws {Error} 不是 ZIP / 被截断 / 用了 Zip64 时抛出
 */
function readCentral(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error('文件太小，不是一个压缩包');
    const tailLen = Math.min(size, TAIL);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('找不到压缩包的结尾标记，可能不是 ZIP 或已被截断');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (count === MAX_MEMBERS || cdOff === MAX_U32 || cdSize === MAX_U32) {
      throw new Error('不支持 Zip64 格式的压缩包');
    }
    const absCd = cdOff;
    if (absCd + cdSize > size) throw new Error('压缩包目录越界，文件可能已损坏');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, absCd);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('压缩包目录损坏');
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      entries.push({
        flags: cd.readUInt16LE(p + 8),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
        name: cd.toString('utf8', p + 46, p + 46 + nlen),
      });
      p += 46 + nlen + elen + clen;
    }
    return { entries, cdOffset: absCd };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 功能：流式读一个成员，边解压边算 CRC 与 sha256（用于校验，不进内存）。
 * @param {string} filePath - ZIP 路径
 * @param {Object} entry - `readCentral()` 给出的一项
 * @returns {Promise.<{crc: number, usize: number, sha256: string}>} 解压后的真实值
 * @throws {Error} 压缩方式不支持 / 数据越界时抛出
 */
async function scanMember(filePath, entry) {
  let crcState = -1;
  let usize = 0;
  const hash = crypto.createHash('sha256');
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      crcState = crcUpdate(crcState, chunk);
      hash.update(chunk);
      usize += chunk.length;
      cb(null, chunk);
    },
  });
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const start = entry.offset + 30 + readNameAndExtraLen(filePath, entry.offset);
  const src = fs.createReadStream(filePath, { start, end: start + entry.csize - 1, highWaterMark: CHUNK });
  if (entry.method === METHOD_STORE) await pipeline(src, tap, sink);
  else if (entry.method === METHOD_DEFLATE) await pipeline(src, zlib.createInflateRaw(), tap, sink);
  else throw new Error(`成员「${entry.name}」用了不支持的压缩方式（${entry.method}）`);
  return { crc: crcFinal(crcState), usize, sha256: hash.digest('hex') };
}

/**
 * 功能：读某个局部文件头的「成员名 + extra」长度（数据的真实起点要靠它算）。
 * @param {string} filePath - ZIP 路径
 * @param {number} offset - 局部头偏移
 * @returns {number} `nameLen + extraLen`
 * @throws {Error} 局部头不合法时抛出
 */
function readNameAndExtraLen(filePath, offset) {
  const b = Buffer.alloc(30);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, b, 0, 30, offset);
  } finally {
    fs.closeSync(fd);
  }
  if (b.readUInt32LE(0) !== SIG_LOCAL) throw new Error('压缩包成员的位置无效，文件可能已损坏');
  return b.readUInt16LE(26) + b.readUInt16LE(28);
}

/**
 * 功能：读出一个成员的原始字节（**只用于小成员**：manifest、`.zxdesk-data.json` 一类）。
 * @param {string} filePath - ZIP 路径
 * @param {Object} entry - 中央目录项
 * @returns {Buffer} 解压后的字节
 * @throws {Error} 成员过大（> 8MB）/ 校验不符时抛出
 */
function readMemberBuffer(filePath, entry) {
  if (entry.usize > 8 * 1024 * 1024) throw new Error(`成员「${entry.name}」过大，不能整块读进内存`);
  const start = entry.offset + 30 + readNameAndExtraLen(filePath, entry.offset);
  const fd = fs.openSync(filePath, 'r');
  let body;
  try {
    body = Buffer.alloc(entry.csize);
    fs.readSync(fd, body, 0, entry.csize, start);
  } finally {
    fs.closeSync(fd);
  }
  const raw = entry.method === METHOD_STORE ? body : zlib.inflateRawSync(body);
  if (raw.length !== entry.usize || crc32(raw) !== entry.crc) throw new Error(`成员「${entry.name}」的校验不通过`);
  return raw;
}

/**
 * 功能：读出归档里的 `manifest.json`（约定是第一个成员且不压缩）。
 * @param {string} filePath - ZIP 路径
 * @returns {Object} manifest 对象
 * @throws {Error} 没有 manifest / 不是合法 JSON 时抛出
 */
function readManifest(filePath) {
  const { entries } = readCentral(filePath);
  const first = entries.find((e) => e.name === 'manifest.json');
  if (!first) throw new Error('归档里没有 manifest.json，不是本应用生成的备份');
  let obj;
  try {
    obj = JSON.parse(readMemberBuffer(filePath, first).toString('utf8'));
  } catch (e) {
    throw new Error(`归档的 manifest.json 读不出来：${(e && e.message) || e}`, { cause: e });
  }
  if (!obj || obj.app !== 'zxdesk') throw new Error('归档不是 ZXDesk 生成的（manifest.app 不符）');
  return obj;
}

/**
 * 功能：把一份归档读回校验 —— 成员数、逐成员尺寸 / CRC、manifest 里的 sha256 全部对上才算通过。
 * @param {string} filePath - ZIP 路径
 * @param {Object} manifest - `readManifest()` 的结果
 * @returns {Promise.<{ok: boolean, reason: string}>} 结论（不抛错：调用方要把它变成一句人话）
 */
async function verifyZip(filePath, manifest) {
  try {
    const { entries } = readCentral(filePath);
    const listed = Array.isArray(manifest && manifest.files) ? manifest.files : [];
    if (entries.length !== listed.length + 1) return { ok: false, reason: `成员数不符（${entries.length} ≠ ${listed.length + 1}）` };
    const want = new Map(listed.map((f) => [String(f.path), f]));
    for (const e of entries) {
      if (e.name === 'manifest.json') continue;
      const f = want.get(e.name);
      if (!f) return { ok: false, reason: `多出成员「${e.name}」` };
      if (Number(f.size) !== e.usize) return { ok: false, reason: `成员「${e.name}」尺寸不符` };
      const got = await scanMember(filePath, e);
      if (got.crc !== e.crc) return { ok: false, reason: `成员「${e.name}」CRC 不符` };
      if (got.sha256 !== String(f.sha256)) return { ok: false, reason: `成员「${e.name}」sha256 不符` };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/**
 * 功能：把一个成员名解析成目标目录内的安全路径。
 * @param {string} destDir - 目标目录
 * @param {string} name - 成员名
 * @returns {string} 绝对路径
 * @throws {Error} 绝对路径 / 含 `..` / 越界时抛出
 */
function safeJoin(destDir, name) {
  const rel = String(name);
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').includes('..')) {
    throw new Error(`归档里有不安全的成员名：${rel}`);
  }
  const abs = path.join(destDir, ...rel.split('/'));
  if (abs !== destDir && !abs.startsWith(destDir + path.sep)) throw new Error(`成员名越界：${rel}`);
  return abs;
}

/**
 * 功能：把归档解到某个目录（只写 manifest 里列出的相对路径）。
 *
 * 说明：⚠️ 解压前**先占位拒绝**：目标里若已存在同名文件，直接报错 ——
 * 恢复动作只能写进一个由调用方准备好的空位置，⛔ 不覆盖任何既有数据。
 * @param {string} filePath - ZIP 路径
 */
async function extractZip(filePath, destDir, manifest) {
  const listed = new Set((manifest.files || []).map((f) => String(f.path)));
  const { entries } = readCentral(filePath);
  let n = 0;
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    if (!listed.has(e.name)) throw new Error(`归档里有 manifest 之外的成员：${e.name}`);
    const abs = safeJoin(destDir, e.name);
    if (fs.existsSync(abs)) throw new Error(`目标位置已有同名文件：${e.name}（不会覆盖）`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const raw = readMemberBuffer(filePath, e);
    await fsp.writeFile(abs, raw);
    n += 1;
  }
  return n;
}

/**
 * 功能：一次最小自检 —— 写一个 1MB 的归档、读回校验、删掉。
 *
 * 说明：预检要回答「这台机器上这套实现到底能不能用」，靠猜不行。1MB 既能覆盖
 * 「流式写 + deflate + 中央目录 + 读回校验」四条链路，又不会在 NAS 上造成可感知的 IO。
 * @param {string} dir - 临时目录（调用方保证可写）
 */
async function selfTest(dir) {
  const file = path.join(dir, `.zxdesk-zip-selftest-${process.pid}.zip`);
  try {
    const blob = crypto.randomBytes(1024 * 1024);
    const w = await writeZipFile(file, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'zxdesk', files: [] }), 'utf8'), compress: false },
      { name: 'blob.bin', data: blob },
    ]);
    const m = readManifest(file);
    const v = await verifyZip(file, { ...m, files: w.members.filter((x) => x.path !== 'manifest.json') });
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* 删不掉不影响结论 */
    }
  }
}

module.exports = {
  METHOD_DEFLATE,
  METHOD_STORE,
  crc32,
  readCentral,
  readManifest,
  readMemberBuffer,
  scanMember,
  verifyZip,
  extractZip,
  writeZipFile,
  selfTest,
};
