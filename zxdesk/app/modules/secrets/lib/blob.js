'use strict';
/**
 * modules/secrets/lib/blob.js —— 附件密文文件的**格式与读写原语**
 * 功能：把「一条附件」定义成一种可分块、可随机访问的文件格式，并给出四件事：
 * `encodeHeader()` / `parseHeader()`（头）、`aadOf()`（每块的认证数据）、
 * `writeFrame()` / `writeFrames()`（写）、`readRange()`（**只解相交的块**地读）。
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/42-加密信息.md §2.7、13-决策记录.md（决策 144）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

/** 文件头魔数（4 字节 ASCII）—— 本应用写出的加密文件 @type {Buffer} */
const MAGIC = Buffer.from('ZXDS', 'latin1');

/** 老格式的魔数（**只用来认出来并给一句人话**，⛔ 不兼容读取） @type {Buffer} */
const LEGACY_MAGIC = Buffer.from('SDB1', 'latin1');

/** 格式版本（改格式要 +1，并在 `parseHeader()` 里决定还认不认老版本） @type {number} */
const VERSION = 2;

/** 老格式的版本号（见到它就说明是升级前上传的附件） @type {number} */
const LEGACY_VERSION = 1;

/** 每块的明文大小 —— **常量**，⛔ 别按文件大小调整 @type {number} */
const CHUNK = 1 << 20;

/** 固定头字节数（元信息紧跟在它后面，长度记在 `metaLen`） @type {number} */
const HEADER_BYTES = 24;

/** 每帧的固定开销：`plainLen u32` ＋ `iv 12` ＋ `tag 16` @type {number} */
const FRAME_OVERHEAD = 32;

/** 读侧允许的最大块（防手工改头的文件让一次分配吃掉内存） @type {number} */
const MAX_CHUNK = 8 << 20;

/** 元信息上限（字节）—— 超过直接拒：防手改头让读侧一次性大分配 @type {number} */
const MAX_META = 1024;

/**
 * 功能：从固定 24 B 头里读出元信息长度（顺带把魔数与版本校验完）。
 * 说明：⚠️ 先判魔数再判版本，最后才读 `metaLen` —— 顺序反了会让一个随机文件里
 *      碰巧存在的字节被当成长度去分配内存。
 * @param {Buffer} buf - 至少 24 字节
 * @returns {number} 元信息字节数（0 表示没有）
 * @throws {Error} 头不完整 / 不是本应用的文件 / 旧版格式 / 版本不认识 / 长度超限时抛出
 */
function metaLenOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) throw new Error('附件文件头不完整');
  if (buf.subarray(0, 4).equals(LEGACY_MAGIC)) {
    // ⭐ 老文件要**认得出来并说人话**：直接说「不是本应用的文件」会让人以为文件坏了 / 丢了。
    throw new Error('这是旧版格式的附件，请重新上传');
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('这不是本应用的附件文件（文件头不对）');
  const ver = buf.readUInt8(4);
  if (ver === LEGACY_VERSION) throw new Error('这是旧版格式的附件，请重新上传');
  if (ver !== VERSION) throw new Error(`附件格式版本不认识（读到 ${ver}，本版本只认 ${VERSION}）`);
  const metaLen = buf.readUInt32BE(8);
  if (metaLen > MAX_META) throw new Error('附件元信息长度不合法（文件头被改过？）');
  return metaLen;
}

/**
 * 功能：拼一个文件头（固定 24 B ＋ 元信息 JSON）。
 * @param {{chunkSize?: number, plainSize: number, meta?: Object}} opts - 块大小（缺省 1 MiB）、
 *      明文总字节数、元信息对象（缺省 = 不写元信息，`metaLen` 为 0）
 * @returns {Buffer} 头（长度 = 24 ＋ 元信息字节数）
 * @throws {Error} 块大小或明文大小不合法、元信息超长时抛出
 */
function encodeHeader(opts) {
  const src = opts || {};
  const chunkSize = src.chunkSize === undefined ? CHUNK : Number(src.chunkSize);
  const plainSize = Number(src.plainSize);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK) throw new Error('附件块大小不合法');
  if (!Number.isSafeInteger(plainSize) || plainSize <= 0) throw new Error('附件大小不合法（必须是正整数）');
  const meta = src.meta && typeof src.meta === 'object' ? src.meta : null;
  const json = meta && Object.keys(meta).length ? Buffer.from(JSON.stringify(meta), 'utf8') : Buffer.alloc(0);
  if (json.length > MAX_META) throw new Error('附件元信息太长');
  const buf = Buffer.alloc(HEADER_BYTES + json.length);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(VERSION, 4);
  // flags 3 字节全 0：留给将来（压缩 / 分卷），现在不认任何位
  buf.writeUInt32BE(json.length, 8);
  buf.writeUInt32BE(chunkSize, 12);
  buf.writeBigUInt64BE(BigInt(plainSize), 16);
  if (json.length) json.copy(buf, HEADER_BYTES);
  return buf;
}

/**
 * 功能：解析并**严格校验**文件头（含元信息）。
 * 说明：⚠️ 这里的失败一律抛错（不是返回 null）：调用方要把「这个文件不是我们写的 / 被改过 /
 *      是升级前的老文件」明确告诉用户，而不是当成「没有附件」跳过。
 * @param {Buffer} buf - 至少 24 ＋ metaLen 字节
 * @returns {{chunkSize: number, plainSize: number, totalFrames: number, metaLen: number,
 * @throws {Error} 头不完整 / 魔数不符 / 旧版格式 / 版本不认识 / 块大小非法 / 大小为 0 /
 */
function parseHeader(buf) {
  const metaLen = metaLenOf(buf);
  if (buf.length < HEADER_BYTES + metaLen) throw new Error('附件文件头不完整');
  const chunkSize = buf.readUInt32BE(12);
  if (!(chunkSize > 0 && chunkSize <= MAX_CHUNK)) throw new Error('附件块大小不合法');
  const plainSize = Number(buf.readBigUInt64BE(16));
  if (!Number.isSafeInteger(plainSize) || plainSize <= 0) throw new Error('附件大小不合法（0 字节的文件不该存在这里）');
  const head = buf.subarray(0, HEADER_BYTES + metaLen);
  /** @type {Object} */
  let meta = {};
  if (metaLen) {
    try {
      const parsed = JSON.parse(head.subarray(HEADER_BYTES).toString('utf8'));
      meta = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      throw new Error('附件元信息不合法（文件头被改过？）', { cause: e });
    }
  }
  return { chunkSize, plainSize, totalFrames: Math.ceil(plainSize / chunkSize), metaLen, meta, buf: head };
}

/**
 * 功能：只读文件**头（固定 24 B ＋ 元信息）**并解析 —— 重新关联与下载都用它认文件。
 * 说明：⭐⭐ 与「读帧」分开，是为了让**认文件**这件事只花几十字节：重新关联要挨个候选
 *      `stat` ＋ 读头，绝不能顺手把 200 MB 读进来（否则就是一次 OOM）。
 * @param {number} fd - 已打开的文件描述符（`'r'`）
 * @returns {{chunkSize: number, plainSize: number, totalFrames: number, metaLen: number,
 * @throws {Error} 文件不足 24 字节、头不合法、或读盘失败时抛出
 */
function readHeaderOnly(fd) {
  const prefix = Buffer.alloc(HEADER_BYTES);
  if (fs.readSync(fd, prefix, 0, HEADER_BYTES, 0) !== HEADER_BYTES) throw new Error('附件文件头不完整');
  const metaLen = metaLenOf(prefix);
  const buf = Buffer.alloc(HEADER_BYTES + metaLen);
  prefix.copy(buf, 0);
  if (metaLen) {
    const n = fs.readSync(fd, buf, HEADER_BYTES, metaLen, HEADER_BYTES);
    if (n !== metaLen) throw new Error('附件文件头不完整（元信息读不全）');
  }
  return parseHeader(buf);
}

/**
 * 功能：算第 `index` 帧（0 基）在文件里的起始偏移。
 * @param {number} index - 帧序号
 * @param {number} [chunkSize] - 块大小（缺省 1 MiB）
 * @param {number} [metaLen] - 元信息字节数（缺省 0）
 * @returns {number} 字节偏移
 */
function frameOffset(index, chunkSize, metaLen) {
  const chunk = chunkSize === undefined ? CHUNK : Number(chunkSize);
  const meta = Number(metaLen) || 0;
  return HEADER_BYTES + meta + Number(index) * (FRAME_OVERHEAD + chunk);
}

/**
 * 功能：这一帧的 AAD —— `整个头(24 + metaLen) ‖ 帧序号 u32BE ‖ 总帧数 u32BE`。
 * 说明：⚠️ 把 `totalFrames` 也绑进来，是为了让「把文件尾部砍掉几帧」也能被认出来
 * @param {Buffer} headerBuf - 完整头（24 ＋ metaLen）
 * @param {number} index - 帧序号（0 基）
 * @param {number} totalFrames - 总帧数
 * @returns {Buffer} `8 + headerBuf.length` 字节
 */
function aadOf(headerBuf, index, totalFrames) {
  const aad = Buffer.alloc(headerBuf.length + 8);
  headerBuf.copy(aad, 0);
  aad.writeUInt32BE(Number(index) >>> 0, headerBuf.length);
  aad.writeUInt32BE(Number(totalFrames) >>> 0, headerBuf.length + 4);
  return aad;
}

/**
 * 功能：这个文件**应该**有多大 —— `头(24 + metaLen) + 帧开销 × 帧数 + 明文总字节`。
 *
 * 说明：⚠️ 读之前拿它跟 `stat.size` 比一次：对不上就是损坏（截断 / 多写了东西），
 *      ⛔ 不「尽力读」—— 尽力读的产物是「播到一半黑屏」而不是一句能看懂的报错。
 * @param {{plainSize: number, totalFrames: number, metaLen?: number}} header - `parseHeader()` 的结果
 * @returns {number} 期望的字节数
 */
function fileSizeOf(header) {
  const metaLen = Number(header.metaLen) || 0;
  return HEADER_BYTES + metaLen + Number(header.totalFrames) * FRAME_OVERHEAD + Number(header.plainSize);
}

/**
 * @param {Object} p - 参数
 * @param {number} p.fd - 已打开的文件描述符（`'w'` 或 `'r+'`）
 * @param {Buffer} p.headerBuf - 完整头（24 ＋ metaLen）
 * @param {number} p.index - 帧序号（0 基）
 * @param {number} p.totalFrames - 总帧数
 * @param {number} p.chunkSize - 块大小
 * @param {Buffer} p.plain - 这一帧的明文（长度 ≤ chunkSize）
 * @param {Function} p.seal - `(buf, aad) => {iv, tag, cipher}`，由调用方绑定到某个账号
 * @returns {Buffer} 写进去的那一帧（上传侧要拿它接着算整文件 SHA-256，⛔ 不要为这件事再读一次盘）
 * @throws {Error} 明文超过块大小、或加密原语抛错时抛出
 */
function writeFrame(p) {
  const { fd, headerBuf, index, totalFrames, chunkSize, plain, seal } = p;
  if (!Buffer.isBuffer(plain)) throw new Error('待写入的块必须是 Buffer');
  if (plain.length > chunkSize) throw new Error('块超过约定大小');
  const sealed = seal(plain, aadOf(headerBuf, index, totalFrames));
  const frame = Buffer.alloc(FRAME_OVERHEAD + plain.length);
  frame.writeUInt32BE(plain.length, 0);
  sealed.iv.copy(frame, 4);
  sealed.tag.copy(frame, 16);
  sealed.cipher.copy(frame, 32);
  const at = frameOffset(index, chunkSize, headerBuf.length - HEADER_BYTES);
  fs.writeSync(fd, frame, 0, frame.length, at);
  return frame;
}

/**
 * @param {Object} p - 参数
 * @param {number} p.fd - 文件描述符
 * @param {Buffer} p.headerBuf - 完整头
 * @param {{chunkSize: number, plainSize: number, totalFrames: number}} p.header - `parseHeader()` 形状
 * @param {Array.<Buffer>|Iterable.<Buffer>} p.chunks - 明文块（每块 ≤ chunkSize）
 * @param {Function} p.seal - 同 `writeFrame()`
 * @returns {number} 写进去的帧数
 * @throws {Error} 块数 / 每块长度与头对不上时抛出（宁可在这里炸，也别写出一个自相矛盾的文件）
 */
function writeFrames(p) {
  const { fd, headerBuf, header, chunks, seal } = p;
  const list = Array.isArray(chunks) ? chunks : [...chunks];
  if (list.length !== header.totalFrames) throw new Error('块数与文件头不符');
  let expect = header.chunkSize;
  for (let i = 0; i < list.length; i += 1) {
    if (i === list.length - 1) expect = header.plainSize - (list.length - 1) * header.chunkSize;
    if (!Buffer.isBuffer(list[i]) || list[i].length !== expect) throw new Error(`第 ${i} 块长度与文件头不符`);
    writeFrame({ fd, headerBuf, index: i, totalFrames: header.totalFrames, chunkSize: header.chunkSize, plain: list[i], seal });
  }
  return list.length;
}

/**
 * @param {Object} p - 参数
 * @param {number} p.fd - 文件描述符
 * @param {{chunkSize: number, plainSize: number, totalFrames: number}} p.header - 头
 * @param {Buffer} p.headerBuf - 完整头
 * @param {number} p.index - 帧序号
 * @param {Function} p.open - `(parts, aad) => Buffer`
 * @returns {Buffer} 该帧的明文
 * @throws {Error} 帧头不合法 / 解密失败 / 明文长度与帧头不符时抛出
 */
function readFramePlain(p) {
  const { fd, header, headerBuf, index, open } = p;
  const at = frameOffset(index, header.chunkSize, headerBuf.length - HEADER_BYTES);
  const head = Buffer.alloc(FRAME_OVERHEAD);
  const n = fs.readSync(fd, head, 0, FRAME_OVERHEAD, at);
  if (n !== FRAME_OVERHEAD) throw new Error('附件被截断（帧头读不全）');
  const plainLen = head.readUInt32BE(0);
  if (!(plainLen > 0 && plainLen <= header.chunkSize)) throw new Error('附件帧长度不合法');
  const cipher = Buffer.alloc(plainLen);
  const m = fs.readSync(fd, cipher, 0, plainLen, at + FRAME_OVERHEAD);
  if (m !== plainLen) throw new Error('附件被截断（帧内容读不全）');
  const plain = open(
    { iv: head.subarray(4, 16), tag: head.subarray(16, 32), cipher },
    aadOf(headerBuf, index, header.totalFrames),
  );
  if (!Buffer.isBuffer(plain) || plain.length !== plainLen) throw new Error('附件帧解密后长度不符');
  return plain;
}

/**
 * @param {Object} p - 参数
 * @param {number} p.fd - 文件描述符
 * @param {{chunkSize: number, plainSize: number, totalFrames: number}} p.header - 头
 * @param {Buffer} p.headerBuf - 完整头
 * @param {number} p.start - 起始字节（含）
 * @param {number} p.end - 结束字节（含）
 * @param {Function} p.open - `(parts, aad) => Buffer`
 * @returns {AsyncGenerator<Buffer>} 明文片段（长度之和 = `end - start + 1`）
 */
async function* readRange(p) {
  const { fd, header, headerBuf, start, end, open } = p;
  const first = Math.floor(start / header.chunkSize);
  const last = Math.floor(end / header.chunkSize);
  for (let i = first; i <= last; i += 1) {
    const plain = readFramePlain({ fd, header, headerBuf, index: i, open });
    const from = i === first ? start - i * header.chunkSize : 0;
    const to = i === last ? end - i * header.chunkSize : plain.length - 1;
    if (from > to || to >= plain.length) throw new Error('附件被截断（区间超出该帧）');
    yield plain.subarray(from, to + 1);
  }
}

/**
 * 功能：算**整个文件**的 SHA-256（小写 hex）—— 顺序读、1 MiB 缓冲。
 * 说明：⭐⭐ 这是「重新关联」第五道关，也是本模块**唯一与内容有关的判据**：
 *      前四道（路径形状 / 魔数版本 / `plainSize === size` / 长度自洽）全都只证明「形状对」，
 * @param {number} fd - 已打开的文件描述符（`'r'`）
 * @returns {string} 64 位小写 hex
 * @throws {Error} 读盘失败时抛出（由调用方归到 `damaged`）
 */
function digestOf(fd) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  let at = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, at);
    if (!n) break;
    hash.update(buf.subarray(0, n));
    at += n;
  }
  return hash.digest('hex');
}

module.exports = {
  MAGIC,
  LEGACY_MAGIC,
  VERSION,
  LEGACY_VERSION,
  CHUNK,
  HEADER_BYTES,
  FRAME_OVERHEAD,
  MAX_CHUNK,
  MAX_META,
  metaLenOf,
  encodeHeader,
  parseHeader,
  readHeaderOnly,
  frameOffset,
  aadOf,
  fileSizeOf,
  writeFrame,
  writeFrames,
  readRange,
  digestOf,
};
