import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canOpenExternal, hostOf, isAllowedNavigation } from '../src/main/browser/nav.js';
import { maskFnId, redact, stripQuery } from '../src/main/log.js';

const ctx = { baseUrl: 'https://10.1.2.3:64999', relayHost: 'my-nas.fnos.net' };

test('导航白名单：当前 NAS 主机放行', () => {
  assert.equal(isAllowedNavigation('https://10.1.2.3:64999/app/zxdesk/login.html', ctx), true);
});

test('导航白名单：中继主机放行', () => {
  assert.equal(isAllowedNavigation('https://my-nas.fnos.net/app/zxdesk', ctx), true);
});

test('导航白名单：飞牛门户域与 *.fnnas.com 放行', () => {
  assert.equal(isAllowedNavigation('https://fnos.net/my-nas/', ctx), true);
  assert.equal(isAllowedNavigation('https://5ddd.com/my-nas/', ctx), true);
  assert.equal(isAllowedNavigation('https://static2.fnnas.com/x.js', ctx), true);
});

test('导航白名单：外部站点不放行（要交给系统浏览器）', () => {
  assert.equal(isAllowedNavigation('https://example.com/', ctx), false);
  assert.equal(isAllowedNavigation('https://evil.com/?next=my-nas.fnos.net', ctx), false);
});

test('导航白名单：非 http(s) 一律不放行', () => {
  assert.equal(isAllowedNavigation('file:///etc/passwd', ctx), false);
  assert.equal(isAllowedNavigation('javascript:alert(1)', ctx), false);
  assert.equal(isAllowedNavigation('not-a-url', ctx), false);
});

test('canOpenExternal 只放行 http/https', () => {
  assert.equal(canOpenExternal('https://example.com'), true);
  assert.equal(canOpenExternal('http://example.com'), true);
  assert.equal(canOpenExternal('mailto:a@b.c'), false);
  assert.equal(canOpenExternal('file:///c:/windows'), false);
});

test('hostOf 容错', () => {
  assert.equal(hostOf('https://Nas.Example.com:8443/x'), 'nas.example.com');
  assert.equal(hostOf(''), null);
  assert.equal(hostOf('nope'), null);
});

test('脱敏：password / token / cookie 的值都被抹掉', () => {
  const text = 'login password="hunter2" token=abc123 Cookie: fnos-token=SECRET; x=1 accessToken: "acc-9"';
  const cleaned = redact(text);
  assert.ok(!cleaned.includes('hunter2'));
  assert.ok(!cleaned.includes('abc123'));
  assert.ok(!cleaned.includes('SECRET'));
  assert.ok(!cleaned.includes('acc-9'));
  assert.ok(cleaned.includes('***'));
});

test('脱敏不会把普通字段也吃掉（结果 / reqid 保留）', () => {
  const cleaned = redact('{"req":"user.login","reqid":"11","result":"succ"}');
  assert.match(cleaned, /"req":"user\.login"/);
  assert.match(cleaned, /"reqid":"11"/);
  assert.match(cleaned, /"result":"succ"/);
});

test('FNID 只留首尾', () => {
  assert.equal(maskFnId('my-nasabc'), 'my***bc');
  assert.equal(maskFnId('abc'), '***');
  assert.equal(maskFnId(''), '***');
});

test('URL 去查询串与 hash', () => {
  assert.equal(stripQuery('https://x/app?token=abc#frag'), 'https://x/app');
  assert.equal(stripQuery('https://x/app'), 'https://x/app');
});
