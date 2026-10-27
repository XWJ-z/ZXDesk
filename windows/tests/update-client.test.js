/**
 * 版本接口客户端：URL 规则、响应校验、失败分类。
 *
 * 用的都是假 fetch —— 这层不该联网；真实 HTTP 由下载测试那套本地服务覆盖。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApiUrl, fetchLatest, parseLatest } from '../src/main/update/client.js';

const HASH = 'a'.repeat(64);

function payload(overrides = {}) {
  return {
    ok: true,
    data: {
      platform: 'windows',
      channel: 'stable',
      version: '0.2.3',
      versionCode: null,
      hash: HASH,
      fileName: 'zxdesk-windows-0.2.3-x64-setup.exe',
      fileSize: 1024,
      downloadUrls: ['https://example.com/zxdesk-windows-0.2.3-x64-setup.exe'],
      releaseNotes: '修了几处',
      force: false,
      minVersion: '',
      publishedAt: '2026-10-26 20:00:00',
      ...overrides,
    },
  };
}

const jsonResponse = (body, status = 200) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test('接口地址：带上 channel，且只接受 https（本机回环例外）', () => {
  const stable = buildApiUrl('https://api.example.com/api/version/windows', 'stable');
  assert.equal(stable.ok, true);
  assert.equal(stable.url, 'https://api.example.com/api/version/windows?channel=stable');

  const beta = buildApiUrl('https://api.example.com/api/version/windows', 'beta');
  assert.equal(beta.url, 'https://api.example.com/api/version/windows?channel=beta');

  // 非法通道名回落到 stable，⛔ 不把用户的字符串原样拼进查询串
  const weird = buildApiUrl('https://api.example.com/api/version/windows', 'nightly');
  assert.equal(weird.url, 'https://api.example.com/api/version/windows?channel=stable');

  assert.equal(buildApiUrl('http://api.example.com/api/version/windows').ok, false);
  assert.equal(buildApiUrl('http://127.0.0.1:18992/api/version/windows').ok, true);
});

test('响应校验：合法的整份收下', () => {
  const result = parseLatest(payload());
  assert.equal(result.ok, true);
  assert.equal(result.info.version, '0.2.3');
  assert.equal(result.info.hash, HASH);
  assert.equal(result.info.fileSize, 1024);
  assert.deepEqual(result.info.downloadUrls, ['https://example.com/zxdesk-windows-0.2.3-x64-setup.exe']);
});

test('响应校验：平台不匹配就拒（服务端配错端时不能把别人的包当自己的）', () => {
  const result = parseLatest(payload({ platform: 'android' }));
  assert.equal(result.ok, false);
  assert.match(result.message, /平台不匹配/);
});

test('响应校验：缺 hash / hash 格式不对一律拒收', () => {
  for (const hash of ['', 'not-a-hash', 'a'.repeat(63), 'g'.repeat(64)]) {
    const result = parseLatest(payload({ hash }));
    assert.equal(result.ok, false, `hash=${hash}`);
    assert.match(result.message, /SHA256/);
  }
});

test('响应校验：版本号不可解析、文件名缺失、大小非法都拒', () => {
  assert.equal(parseLatest(payload({ version: 'latest' })).ok, false);
  assert.equal(parseLatest(payload({ fileName: '' })).ok, false);
  assert.equal(parseLatest(payload({ fileSize: -1 })).ok, false);
  assert.equal(parseLatest(payload({ fileSize: 'abc' })).ok, false);
});

test('响应校验：下载地址全被过滤掉就报「没有可用地址」', () => {
  const result = parseLatest(payload({ downloadUrls: ['http://example.com/x.exe'] }));
  assert.equal(result.ok, false);
  assert.match(result.message, /下载地址/);

  // 部分可用时只留可用的，顺序不变
  const mixed = parseLatest(payload({ downloadUrls: ['http://example.com/x.exe', 'https://example.com/y.exe'] }));
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.info.downloadUrls, ['https://example.com/y.exe']);
});

test('响应校验：ok 不为 true、缺 data、不是对象', () => {
  assert.equal(parseLatest({ ok: false, message: 'boom' }).ok, false);
  assert.equal(parseLatest({ ok: true }).ok, false);
  assert.equal(parseLatest(null).ok, false);
  assert.equal(parseLatest('{}').ok, false);
});

test('fetchLatest：404 归为「还没发布」，不算错误', async () => {
  const result = await fetchLatest({
    url: 'https://api.example.com/api/version/windows',
    fetchImpl: jsonResponse({}, 404),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not-published');
});

test('fetchLatest：其它非 2xx 记 HTTP 状态', async () => {
  const result = await fetchLatest({
    url: 'https://api.example.com/api/version/windows',
    fetchImpl: jsonResponse({}, 503),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'http');
  assert.equal(result.status, 503);
});

test('fetchLatest：响应不是 JSON', async () => {
  const result = await fetchLatest({
    url: 'https://api.example.com/api/version/windows',
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'invalid');
});

test('fetchLatest：网络异常与超时分开报', async () => {
  const network = await fetchLatest({
    url: 'https://api.example.com/api/version/windows',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(network.kind, 'network');

  const timeout = await fetchLatest({
    url: 'https://api.example.com/api/version/windows',
    timeoutMs: 20,
    fetchImpl: (input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  assert.equal(timeout.kind, 'timeout');
});

test('fetchLatest：明文 http 在请求前就被拒（不会真的发出去）', async () => {
  let called = false;
  const result = await fetchLatest({
    url: 'http://api.example.com/api/version/windows',
    fetchImpl: async () => {
      called = true;
      return { status: 200, ok: true, json: async () => payload() };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'insecure');
  assert.equal(called, false);
});
