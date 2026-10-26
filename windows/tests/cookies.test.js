import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cookieSpecs } from '../src/main/browser/cookies.js';
import { FnSession } from '../src/main/login/flow.js';

const session = new FnSession({
  token: 'T',
  longToken: 'LT',
  entryToken: 'ET',
  setCookies: ['fnos-token=SERVER', 'other=1'],
});

test('中继：先写 mode=relay', () => {
  const specs = cookieSpecs(session, { baseUrl: 'https://x.fnos.net/', relayHost: 'x.fnos.net' });
  const mode = specs.find((s) => s.name === 'mode');
  assert.deepEqual(mode, { url: 'https://x.fnos.net', name: 'mode', value: 'relay', path: '/', secure: true });
});

test('直连（无中继）：不写 mode', () => {
  const specs = cookieSpecs(session, { baseUrl: 'https://nas:64999', relayHost: null });
  assert.equal(specs.some((s) => s.name === 'mode'), false);
});

test('服务端 Set-Cookie 优先，不重复写 fnos-token', () => {
  const specs = cookieSpecs(session, { baseUrl: 'https://nas', relayHost: null });
  const tokens = specs.filter((s) => s.name === 'fnos-token');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].value, 'SERVER');
});

test('没有服务端 Set-Cookie 时才自己拼 fnos-token，且不设过期', () => {
  const fresh = new FnSession({ token: 'T' });
  const specs = cookieSpecs(fresh, { baseUrl: 'https://nas', relayHost: null });
  const token = specs.find((s) => s.name === 'fnos-token');
  assert.equal(token.value, 'T');
  assert.equal(token.expirationDate, undefined, '会话 Cookie 不能有过期时间');
  assert.equal(token.sameSite, 'strict');
  assert.equal(token.secure, true);
});

test('longToken 给 30 天过期', () => {
  const specs = cookieSpecs(session, { baseUrl: 'https://nas', relayHost: null });
  const long = specs.find((s) => s.name === 'fnos-long-token');
  const now = Math.floor(Date.now() / 1000);
  assert.ok(long.expirationDate - now > 29 * 24 * 3600);
  assert.ok(long.expirationDate - now <= 30 * 24 * 3600 + 5);
});

test('中继时 entry-token 同时给 url 与 domain', () => {
  const specs = cookieSpecs(session, { baseUrl: 'https://x.fnos.net', relayHost: 'x.fnos.net' });
  const entry = specs.find((s) => s.name === 'entry-token');
  assert.equal(entry.domain, '.x.fnos.net');
  assert.equal(entry.url, 'https://x.fnos.net');
  assert.equal(entry.path, '/');
});

test('baseUrl 尾部斜杠不会造成双斜杠', () => {
  const specs = cookieSpecs(session, { baseUrl: 'https://nas///', relayHost: null });
  assert.equal(specs[0].url, 'https://nas');
});

test('Cookie 头只含 name=value（原生探测用）', () => {
  const header = session.cookieHeader(null);
  assert.match(header, /^fnos-token=SERVER/);
  assert.match(header, /other=1/);
  assert.ok(!header.includes('Path='), '不该带属性');
});
