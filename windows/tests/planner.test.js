import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DIRECT_PORT, isPrivateAddress, planConnection } from '../src/main/connection/planner.js';
import { parseInput } from '../src/main/connection/input.js';

const plan = (input, https = true) => planConnection(parseInput(input), https);

test('8990 一律明文直连（写 https:// 也一样）', () => {
  for (const input of ['10.1.2.3:8990', 'https://10.1.2.3:8990', 'http://10.1.2.3:8990']) {
    const result = plan(input);
    assert.equal(result.ok, true, input);
    assert.equal(result.plan.baseUrl, 'http://10.1.2.3:8990');
    assert.equal(result.plan.cleartext, true);
    assert.equal(result.plan.direct, true);
  }
});

test('8990 只给内网 IP：域名填 8990 直接拒', () => {
  const result = plan('nas.example.com:8990');
  assert.equal(result.ok, false);
  assert.match(result.reason, /局域网直连端口/);
});

test('8990 拒公网 IP', () => {
  const result = plan('8.8.8.8:8990');
  assert.equal(result.ok, false);
  assert.match(result.reason, /只用于局域网/);
});

test('明文只允许私网：公网 http 拒', () => {
  const result = plan('http://example.com');
  assert.equal(result.ok, false);
  assert.match(result.reason, /公网地址必须使用 HTTPS/);
});

test('不写 scheme + 勾 HTTPS ⇒ https 无端口', () => {
  const result = plan('10.1.2.3', true);
  assert.equal(result.plan.baseUrl, 'https://10.1.2.3');
  assert.equal(result.plan.cleartext, false);
  assert.equal(result.plan.direct, false);
});

test('不写 scheme + 不勾 HTTPS ⇒ http:IP:8990 直连', () => {
  const result = plan('10.1.2.3', false);
  assert.equal(result.plan.baseUrl, `http://10.1.2.3:${DIRECT_PORT}`);
  assert.equal(result.plan.cleartext, true);
  assert.equal(result.plan.direct, true);
});

test('自定义路径带进 gatewayPath', () => {
  const result = plan('https://nas.example.com/custom');
  assert.equal(result.plan.gatewayPath, '/custom');
});

test('没给路径时用默认网关路径', () => {
  assert.equal(plan('https://nas.example.com').plan.gatewayPath, '/app/zxdesk');
});

test('FNID 在选路阶段必须失败（要先解析）', () => {
  const result = plan('my-nasabc');
  assert.equal(result.ok, false);
  assert.match(result.reason, /FNID 需要先解析/);
});

test('非法输入原样透出原因', () => {
  const result = plan('');
  assert.equal(result.ok, false);
  assert.match(result.reason, /请输入/);
});

test('私网判定：RFC1918 与回环', () => {
  for (const host of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '169.254.1.1', '127.0.0.1', 'localhost']) {
    assert.equal(isPrivateAddress(host), true, host);
  }
});

test('私网判定：公网与相邻网段', () => {
  for (const host of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', 'nas.example.com']) {
    assert.equal(isPrivateAddress(host), false, host);
  }
});

test('私网判定：IPv6 链路本地与 ULA', () => {
  for (const host of ['::1', 'fe80::1', 'fc00::1', 'fd12::3']) {
    assert.equal(isPrivateAddress(host), true, host);
  }
  assert.equal(isPrivateAddress('2001:4860::1'), false);
});

test('https + 自定义端口保留端口', () => {
  const result = plan('https://10.1.2.3:64999');
  assert.equal(result.plan.baseUrl, 'https://10.1.2.3:64999');
  assert.equal(result.plan.direct, false);
});
