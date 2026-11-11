'use strict';
/**
 * modules/secrets/lib/receive.js —— **把上传的字节流边收边加密落盘**（0.9.8 / 方案 42 §2.7·4）
 *
 * 功能：从 `IncomingMessage` 读原始字节，按 1 MiB 一块 `seal()` 后写进 `.part` 文件，
 *      写完 `fsync`，把「落在哪、多大、几块」交回调用方（由它 `rename` 成 `<id>.zxdesk`）。
 *
 * ⭐⭐ **三条硬规矩（照抄 `core/http-util.js` 的 `readBodyToFile()`，但它写的是明文）**：
 *   ① **超限先回 413、再把请求体自然读掉**（⛔ 不能 `req.destroy()` —— 客户端看到的是「连接被重置」
 *      而不是那句 413）；
 *   ② 临时名 `.part`，**任何失败都不留半个文件**；
 *   ③ 不把整个文件读进内存 —— 峰值 ≈ 1 块明文 ＋ 1 块密文。
 * ⚠️⛔ **绝不复用 `readBodyToFile()` / `readRawBody()`**：前者把**明文**写进临时文件
 *   （那就等于"明文落盘"，本模块存在的意义直接没了）；后者把整个文件压进内存（200 MB 立刻 OOM）。
 *
 * ⭐ **为什么块大小是常量**：`frameOffset(i)` 是算出来的（见 `blob.js`），只有每块一样大才成立；
 *   而且内存峰值也由它兜住。⛔ 别按文件大小动态调整。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/42-加密信息.md §2.7·4、13-决策记录.md（决策 144）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const blob = require('./blob.js');

/** 单文件上限：200 MB（老大 2026-11-07 拍板；**账号不设总量上限**） @type {number} */
const MAX_FILE = 200 * 1024 * 1024;

/** 磁盘余量下限：低于它就 507（按**目标目录所在文件系统**算，不按数据目录那个盘） @type {number} */
const MIN_FREE = 1024 * 1024 * 1024;

/**
 * 功能：确保目录存在（逐级 `mkdir`），返回该目录。
 * @param {string} dir - 目标目录
 * @returns {string} 同一个目录
 * @throws {Error} 建不出来时抛出（由调用方收口成 507）
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 功能：查某个目录所在文件系统的剩余字节数。
 * @param {string} dir - 目录（必须已存在）
 * @returns {number} 剩余字节；查不到时返回 `Infinity`（⛔ 不因为查不到就拒收）
 */
function freeOf(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (_e) {
    return Infinity;
  }
}

/**
 * 功能：为一个待上传的附件准备临时文件（`<root>/<uid>/.tmp/<rand>.part`）。
 *
 * 说明：⚠️ 临时目录放在 `<uid>/` 下面（而不是系统 /tmp）：同盘 `rename` 才是原子的 ——
 *      跨盘 rename 会退化成「复制 ＋ 删除」，200 MB 就是两次全量 IO，还会在中间暴露一份半成品。
 * @param {string} root - 附件根（已校验过）
 * @param {number} uid - 账号 id
 * @returns {{dir: string, tmpPath: string}} 目录与临时文件路径（文件尚未创建）
 */
function tempOf(root, uid) {
  const dir = ensureDir(path.join(String(root), String(Number(uid)), '.tmp'));
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return { dir, tmpPath: path.join(dir, `${rand}.part`) };
}

/**
 * 功能：把请求体**边收边加密**写进临时文件。
 *
 * 说明：⭐⭐ `plainSize` 必须**收之前**就知道（它进文件头，而文件头进每块的 AAD）——
 *      所以 `Content-Length` 是硬要求，缺了直接 400（分块上传不在本版）。
 *      ⚠️ 客户端少发了字节（断连 / 撒谎）⇒ 收完时对不上，按失败处理并清掉 `.part`；
 *      多发则超限 413。
 *      ⚠️ 本函数**同步写盘**（`fs.writeSync`）：块是 1 MiB，写入次数少；换来的是
 *      「不会在 await 之间丢事件」这种确定行为。单用户 NAS 上这个取舍是划算的。
 *
 * @param {Object} p - 参数
 * @param {import('node:http').IncomingMessage} p.req - 请求
 * @param {string} p.tmpPath - 临时文件路径
 * @param {number} p.plainSize - 期望的明文字节数（= `Content-Length`）
 * @param {Object} p.meta - 写进文件头的元信息（身份：应用 / 种类 / 模块 / 账号 / 条目 / 时间）
 * @param {Function} p.seal - `(buf, aad) => {iv, tag, cipher}`，由调用方绑定到某个账号
 * @returns {Promise<{size: number, frameCount: number, headerBuf: Buffer, sha256: string}>} 落盘结果
 *      （`sha256` = **落盘后整文件**的指纹，与 `blob.digestOf()` 重算的结果必须一致）
 * @throws {Error} 断连 / 字节数与 `Content-Length` 不符 / 写盘失败（`ENOSPC`）时抛出
 */
function receiveInto(p) {
  const { req, tmpPath, plainSize, meta, seal } = p;
  const chunkSize = blob.CHUNK;
  const totalFrames = Math.ceil(plainSize / chunkSize);
  // ⭐ 头在第一帧之前就定稿落盘：元信息进头、头进每帧的 AAD ⇒ 写完再改头等于把整个文件毁掉。
  const headerBuf = blob.encodeHeader({ chunkSize, plainSize, meta });
  const fd = fs.openSync(tmpPath, 'w');
  fs.writeSync(fd, headerBuf, 0, headerBuf.length, 0);
  // ⭐⭐ 整文件指纹**边写边算**：写盘的同时 update，收尾 digest —— 不额外读一次盘。
  //    ⚠️ 顺序必须是「头 → 帧 0 → 帧 1 …」，与磁盘上的字节顺序一致，否则算出来的不是这个文件的哈希。
  const hash = crypto.createHash('sha256');
  hash.update(headerBuf);

  return new Promise((resolve, reject) => {
    /** 已收到的字节（全局） */
    let got = 0;
    /** 还没凑满一块的尾巴 */
    let acc = Buffer.alloc(0);
    /** 已经封了几帧 */
    let frames = 0;
    /** 只允许结算一次 */
    let done = false;

    /** 功能：收尾（成功或失败都走这里），保证 fd 一定关掉。 @param {?Error} err - 失败原因 */
    const finish = (err) => {
      if (done) return;
      done = true;
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* 已关闭 */
      }
      if (err) reject(err);
      else resolve({ size: plainSize, frameCount: totalFrames, headerBuf, sha256: hash.digest('hex') });
    };

    /** 功能：把攒满的一块封一帧写盘。 @param {Buffer} plain - 正好一块 @returns {void} */
    const flushFrame = (plain) => {
      const frame = blob.writeFrame({ fd, headerBuf, index: frames, totalFrames, chunkSize, plain, seal });
      hash.update(frame);
      frames += 1;
    };

    req.on('data', (c) => {
      if (done) return;
      try {
        got += c.length;
        if (got > plainSize) {
          // 客户端发的比声明多：按 413 处理（调用方已经回过 / 将要回）
          finish(Object.assign(new Error('上传的数据比声明的多'), { status: 413 }));
          return;
        }
        acc = acc.length ? Buffer.concat([acc, c]) : Buffer.from(c);
        while (acc.length >= chunkSize && frames < totalFrames) {
          flushFrame(acc.subarray(0, chunkSize));
          acc = acc.subarray(chunkSize);
        }
      } catch (e) {
        finish(e);
      }
    });

    req.on('aborted', () => finish(Object.assign(new Error('上传被中断'), { status: 400 })));

    req.on('error', (e) => finish(e));

    req.on('end', () => {
      if (done) return;
      try {
        if (got !== plainSize) {
          finish(Object.assign(new Error(`上传不完整（收到 ${got}，声明 ${plainSize}）`), { status: 400 }));
          return;
        }
        // 尾块：最后不足一块的那部分（正好整除时没有尾巴，最后一帧已在循环里写完）
        if (acc.length) flushFrame(acc);
        if (frames !== totalFrames) {
          finish(new Error(`帧数不对（写 ${frames}，应 ${totalFrames}）`));
          return;
        }
        fs.fsyncSync(fd);
        finish(null);
      } catch (e) {
        finish(e);
      }
    });
  });
}

/**
 * 功能：删掉一个临时文件（幂等；失败只忽略）。
 * @param {string} file - 路径
 * @returns {void}
 */
function dropQuietly(file) {
  try {
    if (file) fs.unlinkSync(file);
  } catch (_e) {
    /* 本来就没有 / 已经删掉 */
  }
}

module.exports = { MAX_FILE, MIN_FREE, ensureDir, freeOf, tempOf, receiveInto, dropQuietly };
