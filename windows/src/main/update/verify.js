/**
 * ZXDesk工作台 Windows 客户端
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/** 单条目解压上限：本项目的 app.asar 不到 1 MB，超过这个数就没必要读了（防内存被异常包打满）。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 在 zip 里找 `…/resources/app.asar` 并整份取出来（不解压到磁盘）。 */
function readZipEntry(file, suffix) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // 找 EOCD：从尾部往前扫，注释最长 65535
    const tailLen = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (cd.readUInt32LE(at) !== CD_SIG) return null;
      const method = cd.readUInt16LE(at + 10);
      const compressedSize = cd.readUInt32LE(at + 20);
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      const localOffset = cd.readUInt32LE(at + 42);
      const name = cd.subarray(at + 46, at + 46 + nameLen).toString('utf8');

      if (name.endsWith(suffix)) {
        if (compressedSize > MAX_ENTRY_BYTES) return null;
        const local = Buffer.alloc(30);
        fs.readSync(fd, local, 0, 30, localOffset);
        if (local.readUInt32LE(0) !== LOCAL_SIG) return null;
        const localNameLen = local.readUInt16LE(26);
        const localExtraLen = local.readUInt16LE(28);
        const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
        const raw = Buffer.alloc(compressedSize);
        fs.readSync(fd, raw, 0, compressedSize, dataOffset);
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw);
        return null; // 其它压缩方式（bzip2 / zstd）本项目不会用
      }
      at += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 从 asar 字节里取完整文件系统的 JSON 头。
 *
 */
function readAsarHeader(buf) {
  if (!buf || buf.length < 16) return null;
  const headerSize = buf.readUInt32LE(4);
  if (headerSize <= 0 || 8 + headerSize > buf.length) return null;
  const header = buf.subarray(8, 8 + headerSize);
  const jsonLen = header.readUInt32LE(4);
  const start = 8;
  if (jsonLen <= 0 || start + jsonLen > header.length) return null;
  try {
    return { json: JSON.parse(header.subarray(start, start + jsonLen).toString('utf8')), base: 8 + headerSize };
  } catch {
    return null;
  }
}

/** 按 asar 头里的路径取一个文件的字节。 */
function readAsarFile(buf, header, parts) {
  let node = header.json;
  for (const part of parts) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  if (node.link) return null;
  // offset 在 asar 头里是**字符串**（"0"），不是数字 —— 直接比 typeof 会全部落空
  const offset = Number(node.offset);
  const size = Number(node.size);
  if (!Number.isFinite(offset) || !Number.isFinite(size)) return null;
  const start = header.base + offset;
  const end = start + size;
  if (end > buf.length) return null;
  return buf.subarray(start, end);
}

/**
 * 读包内真实版本号（只认绿色 zip；安装包 exe 返回 null）。
 * @param {string} file
 */
export function readPackageVersion(file) {
  try {
    const asar = readZipEntry(file, '/resources/app.asar');
    if (!asar) return null;
    const header = readAsarHeader(asar);
    if (!header) return null;
    const pkgJson = readAsarFile(asar, header, ['package.json']);
    if (!pkgJson) return null;
    const pkg = JSON.parse(pkgJson.toString('utf8'));
    const version = String(pkg?.version || '').trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}
