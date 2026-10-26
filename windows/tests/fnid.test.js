import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  authxHeader,
  fnSignHeader,
  isPortalHost,
  md5Hex,
  parseFnIdResponse,
  portalUrlFor,
  resolveFnId,
  sha256Hex,
} from '../src/main/connection/fnid.js';

test('md5 固定向量：空串', async () => {
  assert.equal(await md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('md5 固定向量：abc', async () => {
  assert.equal(await md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
});

test('md5 固定向量：长文本（跨 64 字节块）', async () => {
  assert.equal(
    await md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    '57edf4a22be3c955ac49da2e2107b67a',
  );
});

test('sha256 固定向量：空串', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('fn-sign 是 64 位小写十六进制', async () => {
  const sign = await fnSignHeader('abcde', 1700000000000);
  assert.equal(sign.length, 64);
  assert.match(sign, /^[0-9a-f]{64}$/);
});

test('fn-sign 与 ts / fnId 都绑定（换一个就变）', async () => {
  const a = await fnSignHeader('abcde', 1700000000000);
  const b = await fnSignHeader('abcde', 1700000000001);
  const c = await fnSignHeader('abcdf', 1700000000000);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('authx 头形状固定', async () => {
  const header = await authxHeader(1700000000000, '123456', '{"fnId":"abcde"}');
  assert.match(header, /^nonce=123456&timestamp=1700000000000&sign=[0-9a-f]{32}$/);
});

test('authx 签名随 body 变化', async () => {
  const a = await authxHeader(1, '1', '{"fnId":"abcde"}');
  const b = await authxHeader(1, '1', '{"fnId":"abcdf"}');
  assert.notEqual(a, b);
});

const OK_BODY = JSON.stringify({
  msg: '',
  code: 0,
  data: {
    ipv4: ['10.1.2.4'],
    ipv6: [],
    publicIpv4: ['203.0.113.7'],
    publicIpv6: [],
    fn: ['my-nas.fnos.net:443'],
    port: { httpsPort: 64999, httpPort: 64888 },
  },
});

test('解析成功：地址与端口都取到，relay 去掉端口', () => {
  const parsed = parseFnIdResponse(OK_BODY);
  assert.equal(parsed.kind, 'ok');
  assert.deepEqual(parsed.addresses.lanIpv4, ['10.1.2.4']);
  assert.deepEqual(parsed.addresses.relay, ['my-nas.fnos.net']);
  assert.equal(parsed.addresses.httpsPort, 64999);
  assert.equal(parsed.addresses.httpPort, 64888);
});

test('code != 0 ⇒ notFound（带 code 与 msg）', () => {
  const parsed = parseFnIdResponse(JSON.stringify({ code: 1001, msg: 'fnId not exist', data: null }));
  assert.equal(parsed.kind, 'notFound');
  assert.equal(parsed.code, 1001);
  assert.equal(parsed.message, 'fnId not exist');
});

test('非 JSON ⇒ bad', () => {
  assert.equal(parseFnIdResponse('<html>502</html>').kind, 'bad');
});

test('缺 data ⇒ bad', () => {
  assert.equal(parseFnIdResponse(JSON.stringify({ code: 0 })).kind, 'bad');
});

test('没有任何地址 ⇒ bad（设备离线）', () => {
  const parsed = parseFnIdResponse(JSON.stringify({ code: 0, data: { ipv4: [], fn: [], port: {} } }));
  assert.equal(parsed.kind, 'bad');
  assert.match(parsed.reason, /没有可用地址/);
});

test('端口缺省时用实测默认值 64999 / 64888', () => {
  const parsed = parseFnIdResponse(JSON.stringify({ code: 0, data: { fn: ['a.fnos.net:443'] } }));
  assert.equal(parsed.addresses.httpsPort, DEFAULT_HTTPS_PORT);
  assert.equal(parsed.addresses.httpPort, DEFAULT_HTTP_PORT);
});

test('resolveFnId：code != 0 时不重试备用端点', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 7, msg: 'nope' }) };
  };
  await assert.rejects(() => resolveFnId('abcde', { fetchImpl }), (e) => e.code === 'fn_id_not_found');
  assert.equal(calls, 1, '只应该打一次');
});

test('resolveFnId：主端点 5xx ⇒ 才切备用', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (seen.length === 1) return { ok: false, status: 502, text: async () => '' };
    return { ok: true, status: 200, text: async () => OK_BODY };
  };
  const addresses = await resolveFnId('my-nasabc', { fetchImpl, nonce: '123456', now: () => 1700000000000 });
  assert.equal(addresses.relay[0], 'my-nas.fnos.net');
  assert.equal(seen.length, 2);
  assert.match(seen[0], /^https:\/\/5ddd\.com\/api\/v1\/fn\/con$/);
  assert.match(seen[1], /^https:\/\/fnos\.net\/api\/v1\/fn\/con$/);
});

test('resolveFnId：请求头带 authx / fn-sign / UA，body 是 {fnId}', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = init;
    return { ok: true, status: 200, text: async () => OK_BODY };
  };
  await resolveFnId('MY-NASabc', { fetchImpl, nonce: '654321', now: () => 1700000000000 });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body, '{"fnId":"my-nasabc"}', 'FNID 必须转小写');
  assert.match(captured.headers.authx, /^nonce=654321&timestamp=1700000000000&sign=/);
  assert.match(captured.headers['fn-sign'], /^[0-9a-f]{64}$/);
  assert.equal(captured.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.match(captured.headers['User-Agent'], /okhttp/);
});

test('resolveFnId：两个端点都不通 ⇒ fn_unreachable', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(() => resolveFnId('abcde', { fetchImpl }), (e) => e.code === 'fn_unreachable');
});

test('resolveFnId：非法 FNID 直接拒', async () => {
  await assert.rejects(() => resolveFnId('1bad', { fetchImpl: async () => ({}) }), (e) => e.code === 'fn_id_invalid');
});

test('门户地址与门户域名判定', () => {
  assert.equal(portalUrlFor('MY-NAS'), 'https://fnos.net/my-nas/');
  assert.equal(isPortalHost('fnos.net'), true);
  assert.equal(isPortalHost('my-nas.fnos.net'), true);
  assert.equal(isPortalHost('5ddd.com'), true);
  assert.equal(isPortalHost('evil.com'), false);
});
