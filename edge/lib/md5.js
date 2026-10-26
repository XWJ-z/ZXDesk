/**
 * 功能：纯 JS MD5（`md5Hex(text)`，UTF-8）—— 浏览器 WebCrypto 没有 MD5，任务单 §一 明确**自己写、不引库**。
 *
 * ⛔ 纯函数，不碰 `chrome.*`（可在 Node 里单测）；输入先过 `TextEncoder` 转 UTF-8 字节。
 * 正确性以向量测试为准：`ttt/temp/md5-vectors/`（Node crypto 生成 10 组 + Android 单测的空串向量）。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
// K[i] = floor(|sin(i+1)| × 2^32)，标准常量；加载时算一次
const K = (() => {
  const t = new Int32Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return t;
})();

/** @param {string} text @returns {string} 32 位小写十六进制 */
export function md5Hex(text) {
  const msg = new TextEncoder().encode(String(text));
  const bitLenLo = (msg.length << 3) >>> 0; // length < 512MiB 时高位为 0，足够
  const bitLenHi = Math.floor(msg.length / 0x20000000) >>> 0;
  // 补位：原长 + 1 字节 0x80 + 0..n 个 0 + 8 字节小端长度，总长对齐 64
  const padded = (((msg.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(padded);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padded - 8, bitLenLo, true);
  dv.setUint32(padded - 4, bitLenHi, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true); odv.setInt32(4, b0, true); odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}
