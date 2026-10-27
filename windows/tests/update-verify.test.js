/**
 * 包内版本核对：绿色 zip 里 `resources/app.asar` → `package.json.version`。
 *
 * 用真的 asar（`@electron/asar` 生成）＋ 真的 zip（本文件现写，deflate）当夹具，
 * 而不是手搓假字节 —— 自己编格式再自己解析，等于两头一起错还测得过。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

import { readPackageVersion } from '../src/main/update/verify.js';

const root = path.resolve(import.meta.dirname, '..');

/** 拼一个最小可用的 zip（单条目、deflate、无 zip64）。 */
function makeZip(entryName, content) {
  const name = Buffer.from(entryName, 'utf8');
  const raw = Buffer.from(content);
  const deflated = zlib.deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10); // time+date
  local.writeUInt32LE(0, 14); // crc（读取方不校验）
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const localOffset = 0;
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
  cd.writeUInt32LE(localOffset, 42);

  const cdBuf = Buffer.concat([cd, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, cdBuf, eocd]);
}

/** 用官方打包器造一个真 asar，返回字节。 */
async function makeAsar(version) {
  const asar = await import('@electron/asar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-asar-src-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'zxdesk', version }), 'utf8');
  fs.writeFileSync(path.join(dir, 'main.js'), '// stub\n', 'utf8');
  const out = path.join(os.tmpdir(), `zxdesk-${version}-${Date.now()}.asar`);
  await asar.createPackage(dir, out);
  const buf = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { force: true });
  return buf;
}

test('从绿色 zip 里读出包内版本号', async (t) => {
  const asar = await makeAsar('0.2.2');
  const zip = makeZip('ZXDesk-win32-x64/resources/app.asar', asar);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-zip-')), 'pkg.zip');
  fs.writeFileSync(file, zip);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  assert.equal(readPackageVersion(file), '0.2.2');
});

test('包内版本是别的版本时，读出来的是真实版本（不是文件名里的）', async (t) => {
  const asar = await makeAsar('0.1.6');
  const zip = makeZip('ZXDesk-win32-x64/resources/app.asar', asar);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-zip-')), 'zxdesk-windows-0.2.2-x64.zip');
  fs.writeFileSync(file, zip);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  // 文件名写着 0.2.2，包里其实是 0.1.6 —— 这正是「服务器记录写错 / 镜像给了旧包」的样子
  assert.equal(readPackageVersion(file), '0.1.6');
});

test('读不出来时返回 null，不抛（安装包形态、坏文件、没有 asar 的 zip）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // exe 形态：根本不是 zip
  const exe = path.join(dir, 'setup.exe');
  fs.writeFileSync(exe, Buffer.from('MZ fake installer'));
  assert.equal(readPackageVersion(exe), null);

  // 合法 zip，但里面没有 resources/app.asar
  const other = path.join(dir, 'other.zip');
  fs.writeFileSync(other, makeZip('ZXDesk-win32-x64/resources/other.bin', Buffer.from('x')));
  assert.equal(readPackageVersion(other), null);

  // 截断的 zip
  const broken = path.join(dir, 'broken.zip');
  fs.writeFileSync(broken, makeZip('ZXDesk-win32-x64/resources/app.asar', Buffer.alloc(64)).subarray(0, 40));
  assert.equal(readPackageVersion(broken), null);

  // 不存在的文件
  assert.equal(readPackageVersion(path.join(dir, 'nope.zip')), null);
});

test('verify.js 不依赖 electron（能在本机 node 直接跑）', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'main', 'update', 'verify.js'), 'utf8');
  assert.ok(!/from 'electron'/.test(src), '不许 import electron');
});
