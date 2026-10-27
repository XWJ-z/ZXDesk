/**
 * 下载镜像：候选生成与「哪个通用哪个」的探测。
 *
 * 探测用真实 socket（裸 net 助手）——「连不上」这件事只有真的连一次才算数。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeUrls } from '../src/main/update/download.js';
import { MIRROR_PREFIXES, expandDownloadUrls } from '../src/main/update/mirrors.js';
import { rawTransport, startRawServer } from './helpers/raw-http.js';

const OFFICIAL = 'https://github.com/XWJ-z/ZXDesk/releases/download/v0.8.72/zxdesk-windows-0.2.2-x64-setup.exe';

test('候选：官方地址在前，每个 GitHub 地址再生成镜像', () => {
  const list = expandDownloadUrls([OFFICIAL]);
  assert.equal(list[0], OFFICIAL, '官方永远排第一');
  assert.equal(list.length, 1 + MIRROR_PREFIXES.length);
  for (const prefix of MIRROR_PREFIXES) {
    assert.ok(list.includes(`${prefix}${OFFICIAL}`), `缺镜像：${prefix}`);
  }
});

test('候选：非 GitHub 地址不加镜像前缀', () => {
  const list = expandDownloadUrls(['https://example.com/pkg.exe']);
  assert.deepEqual(list, ['https://example.com/pkg.exe']);
});

test('候选：去重、去空值', () => {
  const list = expandDownloadUrls([OFFICIAL, OFFICIAL, '', null]);
  assert.equal(new Set(list).size, list.length);
  assert.equal(list.filter((url) => url === OFFICIAL).length, 1);
});

test('候选：空数组不炸', () => {
  assert.deepEqual(expandDownloadUrls([]), []);
  assert.deepEqual(expandDownloadUrls(null), []);
});

test('探测：只留能拿到响应的源', async (t) => {
  const body = Buffer.from('ok');
  const alive = await startRawServer((_req, res) => {
    res.writeHead(200, {});
    res.end(body);
  });
  const missing = await startRawServer((_req, res) => {
    res.writeHead(404, {});
    res.end();
  });
  const silent = await startRawServer(() => {
    /* 不响应：模拟被墙 */
  });
  t.after(() => Promise.all([alive.close(), missing.close(), silent.close()]));

  const list = await probeUrls([`${missing.url}/a`, `${silent.url}/a`, `${alive.url}/a`], rawTransport, { timeoutMs: 300 });
  assert.equal(list.length, 1, `只应留下可达的那个，实际 ${JSON.stringify(list)}`);
  assert.equal(list[0].url, `${alive.url}/a`);
  assert.ok(list[0].ms >= 0);
});

test('探测：多个可用时按响应快慢排序', async (t) => {
  const body = Buffer.from('ok');
  const fast = await startRawServer((_req, res) => {
    res.writeHead(200, {});
    res.end(body);
  });
  const slow = await startRawServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, {});
      res.end(body);
    }, 120);
  });
  t.after(() => Promise.all([fast.close(), slow.close()]));

  const list = await probeUrls([`${slow.url}/a`, `${fast.url}/a`], rawTransport, { timeoutMs: 1000 });
  assert.equal(list.length, 2);
  assert.equal(list[0].url, `${fast.url}/a`, '快的排前面');
});

test('探测：明文公网地址直接判不可用（不发请求）', async () => {
  const list = await probeUrls(['http://example.com/pkg.exe'], rawTransport, { timeoutMs: 200 });
  assert.deepEqual(list, []);
});

test('探测：全都不通时返回空数组（由上层报「所有源都连不上」）', async (t) => {
  const silent = await startRawServer(() => {});
  t.after(() => silent.close());
  const list = await probeUrls([`${silent.url}/a`], rawTransport, { timeoutMs: 150 });
  assert.deepEqual(list, []);
});
