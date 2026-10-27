/**
 * 下载：真实 socket 跑完整链路。
 *
 * 为什么不用假传输层：断点续传、重定向、流中断这些行为在「真实 socket + 真实字节流」上才成立，
 * 假实现只能验到分支有没有被走到，验不到最后落盘的字节对不对。
 *
 * ⚠️ 不用 `node:http`：本机 Node 22 一 import 它，测试进程收尾就抛 WASM OOM（与用例无关）。
 * 这里走 `tests/helpers/raw-http.js` 的裸 net 实现。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { downloadFile, safeFileName, sha256File } from '../src/main/update/download.js';
import { rawTransport, startRawServer } from './helpers/raw-http.js';

function workDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('正常下载：字节完整、进度累计到总长、.part 不残留', async (t) => {
  const body = Buffer.from('hello zxdesk update');
  const server = await startRawServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  t.after(() => server.close());

  const dir = workDir(t);
  const dest = path.join(dir, 'pkg.bin');
  const progress = [];
  await downloadFile({
    url: `${server.url}/pkg.bin`,
    dest,
    transport: rawTransport,
    expectedSize: body.length,
    onProgress: (item) => progress.push(item),
  });

  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello zxdesk update');
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.equal(progress.at(-1).received, body.length);
  assert.equal(progress.at(-1).total, body.length);
});

test('重定向：相对地址跟到最后一跳', async (t) => {
  const body = Buffer.from('redirected');
  const hits = [];
  const server = await startRawServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/old') {
      res.writeHead(302, { location: '/new' });
      res.end();
      return;
    }
    res.writeHead(200, {});
    res.end(body);
  });
  t.after(() => server.close());

  const dir = workDir(t);
  const dest = path.join(dir, 'pkg.bin');
  await downloadFile({ url: `${server.url}/old`, dest, transport: rawTransport });

  assert.equal(fs.readFileSync(dest, 'utf8'), 'redirected');
  assert.deepEqual(hits, ['/old', '/new']);
});

test('重定向到明文公网地址 → 拒绝（防 https 入口被换成 http 落点）', async (t) => {
  const server = await startRawServer((_req, res) => {
    res.writeHead(302, { location: 'http://example.com/pkg.exe' });
    res.end();
  });
  t.after(() => server.close());

  const dir = workDir(t);
  const dest = path.join(dir, 'pkg.bin');
  await assert.rejects(downloadFile({ url: `${server.url}/x`, dest, transport: rawTransport }), /重定向被拒绝/);
});

test('断点续传：已有 .part 时发 Range，206 追加后字节完整', async (t) => {
  const body = Buffer.from('0123456789');
  let rangeSeen = '';
  const server = await startRawServer((req, res) => {
    rangeSeen = String(req.headers.range || '');
    if (rangeSeen === 'bytes=4-') {
      res.writeHead(206, { 'content-range': `bytes 4-9/${body.length}` });
      res.end(body.subarray(4));
      return;
    }
    res.writeHead(200, {});
    res.end(body);
  });
  t.after(() => server.close());

  const dir = workDir(t);
  const dest = path.join(dir, 'pkg.bin');
  fs.writeFileSync(`${dest}.part`, body.subarray(0, 4));
  await downloadFile({ url: `${server.url}/pkg.bin`, dest, transport: rawTransport, expectedSize: body.length });

  assert.equal(rangeSeen, 'bytes=4-');
  assert.equal(fs.readFileSync(dest, 'utf8'), '0123456789');
});

test('416：.part 与源对不上时删掉重来，不会卡死', async (t) => {
  const body = Buffer.from('fresh-bytes');
  const server = await startRawServer((req, res) => {
    if (req.headers.range) {
      res.writeHead(416, { 'content-range': `bytes */${body.length}` });
      res.end();
      return;
    }
    res.writeHead(200, {});
    res.end(body);
  });
  t.after(() => server.close());

  const dir = workDir(t);
  const dest = path.join(dir, 'pkg.bin');
  fs.writeFileSync(`${dest}.part`, 'stale-part');
  await downloadFile({ url: `${server.url}/pkg.bin`, dest, transport: rawTransport });

  assert.equal(fs.readFileSync(dest, 'utf8'), 'fresh-bytes');
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('HTTP 404：报错且不留下 .part', async (t) => {
  const server = await startRawServer((_req, res) => {
    res.writeHead(404, {});
    res.end();
  });
  t.after(() => server.close());

  const dir = workDir(t);
  const dest = path.join(dir, 'pkg.bin');
  await assert.rejects(downloadFile({ url: `${server.url}/missing`, dest, transport: rawTransport }), /HTTP 404/);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.equal(fs.existsSync(dest), false);
});

test('文件名收敛：路径分隔符、上跳、怪字符都不会写出数据目录', () => {
  assert.equal(safeFileName('zxdesk-windows-0.2.2-x64.zip'), 'zxdesk-windows-0.2.2-x64.zip');
  assert.equal(safeFileName('..\\..\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a b:c?.exe'), 'a_b_c_.exe');
  assert.equal(safeFileName(''), 'zxdesk-update.bin');
  assert.equal(safeFileName('...'), 'zxdesk-update.bin');
});

test('sha256File 与已知值一致', async (t) => {
  const dir = workDir(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'abc');
  assert.equal(await sha256File(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
