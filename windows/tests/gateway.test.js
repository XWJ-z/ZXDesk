import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GATEWAY_PAGE,
  classifyGatewayBody,
  isAccessCode,
  isInvalidToken,
  isPage,
  probeGateway,
} from '../src/main/connection/gateway.js';

test('invalid token（纯文本）判为 LOGIN_REQUIRED', () => {
  assert.equal(classifyGatewayBody('invalid token'), GATEWAY_PAGE.LOGIN_REQUIRED);
  assert.equal(classifyGatewayBody('  Invalid Token  '), GATEWAY_PAGE.LOGIN_REQUIRED);
});

test('访问码页是 HTML：必须排在「应用页」之前', () => {
  const html = '<!doctype html><html><body><h1>请输入访问码</h1></body></html>';
  assert.equal(classifyGatewayBody(html), GATEWAY_PAGE.ACCESS_CODE);
});

test('英文访问码页也认（access code）', () => {
  assert.equal(classifyGatewayBody('<html><body>Please enter your access code</body></html>'), GATEWAY_PAGE.ACCESS_CODE);
});

test('普通 HTML 判为 APP', () => {
  assert.equal(classifyGatewayBody('<html><body>ZXDesk</body></html>'), GATEWAY_PAGE.APP);
});

test('空正文判 UNKNOWN（⛔ 别据此拦人）', () => {
  assert.equal(classifyGatewayBody(''), GATEWAY_PAGE.UNKNOWN);
  assert.equal(classifyGatewayBody('   '), GATEWAY_PAGE.UNKNOWN);
});

test('非 HTML 也非 invalid token 的正文判 UNKNOWN', () => {
  assert.equal(classifyGatewayBody('{"error":"boom"}'), GATEWAY_PAGE.UNKNOWN);
});

test('isInvalidToken 不会把 HTML 误判（正文以 < 开头就不算）', () => {
  assert.equal(isInvalidToken('<p>invalid token</p>'), false);
  assert.equal(isInvalidToken('invalid token'), true);
});

test('isPage 只认 HTML 开头', () => {
  assert.equal(isPage('<html>'), true);
  assert.equal(isPage('  <div>'), true);
  assert.equal(isPage('invalid token'), false);
});

test('isAccessCode 只看前 20 KB', () => {
  const long = 'x'.repeat(20001) + '访问码';
  assert.equal(isAccessCode(long), false);
  assert.equal(isAccessCode('访问码'), true);
  assert.equal(isAccessCode('访问口令'), true);
});

test('probeGateway：200 + invalid token ⇒ LOGIN_REQUIRED，并带上 Cookie 头', async () => {
  let headers = null;
  const page = await probeGateway({
    baseUrl: 'https://nas:64999',
    cookieHeader: 'fnos-token=t; mode=relay',
    fetchImpl: async (url, init) => {
      headers = { url, init };
      return { status: 200, text: async () => 'invalid token' };
    },
  });
  assert.equal(page, GATEWAY_PAGE.LOGIN_REQUIRED);
  assert.match(headers.url, /^https:\/\/nas:64999\/app\/zxdesk\/login\.html$/);
  assert.equal(headers.init.headers.Cookie, 'fnos-token=t; mode=relay');
  assert.equal(headers.init.method, 'GET');
});

test('probeGateway：非 200 或抛错一律 UNKNOWN（弱信号不拦人）', async () => {
  const notOk = await probeGateway({ baseUrl: 'https://x', fetchImpl: async () => ({ status: 500, text: async () => '' }) });
  assert.equal(notOk, GATEWAY_PAGE.UNKNOWN);
  const boom = await probeGateway({
    baseUrl: 'https://x',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(boom, GATEWAY_PAGE.UNKNOWN);
});
