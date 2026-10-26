import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFnId, isIpv4, isIpv6, parseInput } from '../src/main/connection/input.js';

test('空输入给可读提示', () => {
  assert.deepEqual(parseInput(''), { kind: 'invalid', reason: '请输入 NAS 地址' });
  assert.deepEqual(parseInput('   '), { kind: 'invalid', reason: '请输入 NAS 地址' });
});

test('完整 http URL 拆成 host/port/scheme/path', () => {
  const t = parseInput('http://10.1.2.3:8990/app/zxdesk');
  assert.equal(t.kind, 'host');
  assert.equal(t.host, '10.1.2.3');
  assert.equal(t.port, 8990);
  assert.equal(t.scheme, 'http');
  assert.equal(t.path, '/app/zxdesk');
  assert.equal(t.target, 'IP');
});

test('完整 https URL 无端口时 port 为 null', () => {
  const t = parseInput('https://nas.example.com');
  assert.equal(t.port, null);
  assert.equal(t.scheme, 'https');
  assert.equal(t.target, 'DOMAIN');
});

test('URL 只有根路径时 path 归 null（不给下游传 "/"）', () => {
  assert.equal(parseInput('https://nas.example.com/').path, null);
});

test('IPv4 裸地址按 IP 处理', () => {
  const t = parseInput('10.1.2.4');
  assert.equal(t.kind, 'host');
  assert.equal(t.port, null);
  assert.equal(t.target, 'IP');
  assert.equal(t.scheme, null);
});

test('host:port 形式（不带 scheme，schema 保持 null）', () => {
  const t = parseInput('nas:8990');
  assert.equal(t.kind, 'host');
  assert.equal(t.host, 'nas');
  assert.equal(t.port, 8990);
  assert.equal(t.scheme, null);
});

test('带点域名按 DOMAIN 处理', () => {
  const t = parseInput('my-nas.example.com');
  assert.equal(t.kind, 'host');
  assert.equal(t.target, 'DOMAIN');
  assert.equal(t.port, null);
});

test('端口不是数字时不瞎猜，落到统一判定的「认不出」', () => {
  assert.deepEqual(parseInput('nas:abc'), { kind: 'invalid', reason: '无法识别，请输入 IP、域名或 FNID' });
});

test('[v6]:port 正常解析', () => {
  const t = parseInput('[fe80::1]:8990');
  assert.equal(t.kind, 'host');
  assert.equal(t.host, 'fe80::1');
  assert.equal(t.port, 8990);
  assert.equal(t.target, 'IP');
});

test('IPv6 缺右括号报明确错误', () => {
  assert.equal(parseInput('[fe80::1').kind, 'invalid');
});

test('[v6]:端口非数字报「端口不是数字」', () => {
  assert.deepEqual(parseInput('[fe80::1]:abc'), { kind: 'invalid', reason: '端口不是数字' });
});

test('裸 IPv6 按 IP 处理', () => {
  const t = parseInput('fe80::1:2');
  assert.equal(t.kind, 'host');
  assert.equal(t.target, 'IP');
  assert.equal(t.port, null);
});

test('FNID 转小写并按 fnid 处理', () => {
  assert.deepEqual(parseInput('MY-NASabc'), { kind: 'fnid', id: 'my-nasabc' });
});

test('FNID 以 - 结尾不算 FNID', () => {
  const t = parseInput('abcde-');
  assert.equal(t.kind, 'invalid');
});

test('isFnId：长度与字符集边界', () => {
  assert.equal(isFnId('abcde'), true);
  assert.equal(isFnId('abcd'), false, '4 位不够');
  assert.equal(isFnId('1bcde'), false, '数字开头不行');
  assert.equal(isFnId('abcde-'), false, '结尾不能是 -');
  assert.equal(isFnId('a'.repeat(33)), false, '超过 32 位不行');
});

test('isIpv4 边界', () => {
  assert.equal(isIpv4('10.1.2.3'), true);
  assert.equal(isIpv4('256.1.1.1'), false);
  assert.equal(isIpv4('1.2.3'), false);
  assert.equal(isIpv4('1.2.3.4.5'), false);
});

test('isIpv6 至少两个冒号且字符集合法', () => {
  assert.equal(isIpv6('::1'), true);
  assert.equal(isIpv6('fe80::1'), true);
  assert.equal(isIpv6('1:2'), false);
  assert.equal(isIpv6('zz::1'), false);
});

test('末尾斜杠会被规整掉（不当作路径）', () => {
  assert.equal(parseInput('10.1.2.3///').kind, 'host');
});
