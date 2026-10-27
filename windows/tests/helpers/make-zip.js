/**
 * 测试用的最小 zip 打包器（单条目、deflate、无 zip64）。
 *
 * 只是为了让「读包内版本」的用例有真 zip 可读 —— ⛔ 不是通用打包器，
 * 不做 CRC、不支持多文件；生产的包由 `build/make-zip.py` 生成。
 */

import zlib from 'node:zlib';

export function makeZip(entryName, content) {
  const name = Buffer.from(entryName, 'utf8');
  const raw = Buffer.from(content);
  const deflated = zlib.deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // 需要的版本
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(0, 10); // time + date
  local.writeUInt32LE(0, 14); // crc（读取方不校验）
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const body = Buffer.concat([local, name, deflated]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(0, 12);
  cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(deflated.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42); // 本地头偏移

  const cdBuf = Buffer.concat([cd, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, cdBuf, eocd]);
}
