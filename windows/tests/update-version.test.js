/**
 * 版本号比较。
 *
 * 重点守两条：字典序不能用来判新版（0.8.9 vs 0.8.72），
 * 以及「无法解析」必须显式返回 null，⛔ 不能被当成相等。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareVersion, isNewer, isValidVersion, parseVersion } from '../src/main/update/version.js';

test('逐段按数字比较，不是字符串比较', () => {
  assert.equal(compareVersion('0.8.72', '0.8.9'), 1);
  assert.equal(compareVersion('0.8.9', '0.8.72'), -1);
  assert.equal(compareVersion('0.2.2', '0.2.1'), 1);
  assert.equal(compareVersion('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersion('0.2.1', '0.2.1'), 0);
});

test('v 前缀与缺位补 0', () => {
  assert.equal(compareVersion('v0.2.2', '0.2.1'), 1);
  assert.equal(compareVersion('1.2', '1.2.0'), 0);
  assert.equal(compareVersion('1', '1.0.0'), 0);
});

test('预发布低于同号正式版', () => {
  assert.equal(compareVersion('0.2.2-beta.1', '0.2.2'), -1);
  assert.equal(compareVersion('0.2.2', '0.2.2-rc.1'), 1);
  assert.equal(compareVersion('0.2.2-beta.2', '0.2.2-beta.1'), 1);
  // 数字标识小于字母标识（semver）
  assert.equal(compareVersion('1.0.0-1', '1.0.0-alpha'), -1);
});

test('无法解析返回 null（⛔ 不返回 0）', () => {
  for (const bad of ['', 'latest', '1.2.3.4', '1.2.3-', 'x.y.z', '1..3', null, undefined]) {
    assert.equal(parseVersion(bad), null, `应拒收：${bad}`);
    assert.equal(compareVersion(bad, '0.2.1'), null);
  }
  assert.equal(compareVersion('0.2.1', 'oops'), null);
});

test('isNewer 只认「严格更新」；不可比时 false', () => {
  assert.equal(isNewer('0.2.2', '0.2.1'), true);
  assert.equal(isNewer('0.2.1', '0.2.1'), false);
  assert.equal(isNewer('0.2.0', '0.2.1'), false);
  assert.equal(isNewer('oops', '0.2.1'), false);
});

test('isValidVersion', () => {
  assert.equal(isValidVersion('0.2.2'), true);
  assert.equal(isValidVersion('v0.2.2-beta.1'), true);
  assert.equal(isValidVersion('0.2'), true);
  assert.equal(isValidVersion('0.2.2.2'), false);
  assert.equal(isValidVersion(undefined), false);
});
