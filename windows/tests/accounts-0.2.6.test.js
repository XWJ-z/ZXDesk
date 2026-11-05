/**
 * 0.2.6：访问码凭据落盘 ＋ 多账号。
 *
 * 1. 「每次启动软件都要重新输入访问码」—— 网关的访问码 Cookie 是**会话级**，
 *    Electron 的 persist 分区只落带有效期的 Cookie ⇒ 应用一关就没。这里把选择/回注两头都钉住。
 * 2. 「多账号切换没有实现」—— 凭据从单条扩成多条、账号清单单独一份，并保证旧格式还能读。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { GATEWAY_COOKIE_LIMIT, gatewayCookieSpecs, pickGatewayCookies } from '../src/main/browser/cookies.js';
import { AccountStore, normalizeAccounts } from '../src/main/store/accounts.js';
import { CredentialStore, credentialItems } from '../src/main/store/credentials.js';
import { GatewayCookieStore } from '../src/main/store/gateway.js';

/** 内存版 SecureStore：与生产同签名（get / put / remove / has）。 */
function makeSecure(initial = null) {
  const store = {
    value: initial,
    async get() {
      return this.value;
    },
    async put(_file, text) {
      this.value = text;
      return true;
    },
    remove() {
      this.value = null;
    },
    has() {
      return Boolean(this.value);
    },
  };
  return store;
}

function makeCredentialStore(initial = null) {
  const secure = makeSecure(initial);
  return { store: new CredentialStore(secure, '/tmp/credential.bin'), secure };
}

// ---------------------------------------------------------------- 网关凭据

test('网关凭据：排除飞牛会话 / 网页会话 / mode，只留访问码那几条', () => {
  const list = [
    { name: 'fnos-token', value: 'T' },
    { name: 'fnos-long-token', value: 'LT' },
    { name: 'entry-token', value: 'ET' },
    { name: 'zxdesk_sid', value: 'SID' },
    { name: 'mode', value: 'relay' },
    { name: 'nasac', value: 'ok', domain: '10.1.2.3', path: '/' },
    { name: 'access_code', value: 'AC', domain: '10.1.2.3', path: '/app' },
  ];
  const picked = pickGatewayCookies(list);
  assert.deepEqual(picked.map((c) => c.name), ['nasac', 'access_code']);
});

test('网关凭据：已过期的不存（回注一个死 Cookie 只是脏字段）', () => {
  const now = 2_000_000;
  const list = [
    { name: 'fresh', value: '1', expirationDate: now + 100 },
    { name: 'dead', value: '1', expirationDate: now - 1 },
    { name: 'session', value: '1' }, // 没有 expirationDate = 会话级，正是要存的
  ];
  assert.deepEqual(pickGatewayCookies(list, now).map((c) => c.name), ['fresh', 'session']);
});

test(`网关凭据最多 ${GATEWAY_COOKIE_LIMIT} 条（别让无关 Cookie 把快照撑大）`, () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, value: '1' }));
  assert.equal(pickGatewayCookies(list).length, GATEWAY_COOKIE_LIMIT);
});

test('回注：domain 与本机主机相同 ⇒ 不显式给 domain（给了 Electron 会抛错）', () => {
  const specs = gatewayCookieSpecs(
    [{ name: 'nasac', value: 'ok', domain: '10.1.2.3', path: '/' }],
    { baseUrl: 'https://10.1.2.3:64999' },
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0].url, 'https://10.1.2.3:64999');
  assert.equal('domain' in specs[0], false);
  assert.equal(specs[0].path, '/');
});

test('回注：父域 Cookie 保留 domain；无 baseUrl 时一条都不写', () => {
  const specs = gatewayCookieSpecs(
    [{ name: 'nasac', value: 'ok', domain: '.example.com', path: '/' }],
    { baseUrl: 'https://nas.example.com' },
  );
  assert.equal(specs[0].domain, '.example.com');
  assert.deepEqual(gatewayCookieSpecs([{ name: 'a', value: '1' }], {}), []);
});

test('网关凭据按 baseUrl 分开存：换 NAS ⛔ 不把上一台的凭据带过去', async () => {
  const secure = makeSecure();
  const store = new GatewayCookieStore(secure, '/tmp/gateway.bin');
  await store.save('https://10.1.2.3:64999', [{ name: 'nasac', value: 'A' }]);
  await store.save('https://10.1.2.4:64999', [{ name: 'nasac', value: 'B' }]);

  assert.deepEqual((await store.load('https://10.1.2.3:64999')).map((c) => c.value), ['A']);
  assert.deepEqual((await store.load('https://10.1.2.4:64999')).map((c) => c.value), ['B']);
  // 尾部斜杠 / 大小写不影响取用
  assert.deepEqual((await store.load('https://10.1.2.3:64999/')).map((c) => c.value), ['A']);
  assert.deepEqual(await store.load('https://unknown:64999'), []);
});

test('网关凭据：存空数组 ⇒ 把这台设备那条删掉（而不是留个空壳）', async () => {
  const secure = makeSecure();
  const store = new GatewayCookieStore(secure, '/tmp/gateway.bin');
  await store.save('https://10.1.2.3:64999', [{ name: 'nasac', value: 'A' }]);
  await store.save('https://10.1.2.3:64999', []);
  assert.deepEqual(await store.load('https://10.1.2.3:64999'), []);
});

test('网关凭据：坏文件当空，不炸启动', async () => {
  const secure = makeSecure('{不是 JSON');
  const store = new GatewayCookieStore(secure, '/tmp/gateway.bin');
  assert.deepEqual(await store.load('https://10.1.2.3:64999'), []);
});

// ---------------------------------------------------------------- 凭据（多条）

test('凭据：旧格式（单条、没有 items）还能读', () => {
  const legacy = JSON.stringify({ address: '10.1.2.3', user: 'myaccount', password: 'p@ss' });
  const items = credentialItems(JSON.parse(legacy));
  assert.equal(items.length, 1);
  assert.equal(items[0].user, 'myaccount');
  assert.equal(items[0].password, 'p@ss');
});

test('凭据：多条并存，同地址同账号覆盖不新增', async () => {
  const { store } = makeCredentialStore();
  await store.save('10.1.2.3', 'a', 'p1');
  await store.save('10.1.2.4', 'b', 'p2');
  assert.equal((await store.list()).length, 2);

  await store.save('10.1.2.3', 'a', 'p1-new');
  const items = await store.list();
  assert.equal(items.length, 2, '同账号重存⛔ 不该多一条');
  assert.equal((await store.loadFor('10.1.2.3', 'a')).password, 'p1-new');
  assert.equal((await store.loadFor('10.1.2.4', 'b')).password, 'p2');
});

test('凭据：地址比较做归一（尾部斜杠 / 协议头 / 大小写都不影响）', async () => {
  const { store } = makeCredentialStore();
  await store.save('https://NAS.Example.com/', 'a', 'p');
  assert.equal((await store.loadFor('nas.example.com', 'a')).password, 'p');
});

test('凭据：clear(address, user) 只清一条；不传参数才全清', async () => {
  const { store } = makeCredentialStore();
  await store.save('10.1.2.3', 'a', 'p1');
  await store.save('10.1.2.4', 'b', 'p2');

  await store.clear('10.1.2.3', 'a');
  assert.equal((await store.loadFor('10.1.2.3', 'a')), null);
  assert.equal((await store.loadFor('10.1.2.4', 'b')).password, 'p2', '⛔ 别连坐');

  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test('凭据：load() 给最近保存的那条（兼容只关心「有没有」的旧调用）', async () => {
  const { store } = makeCredentialStore();
  await store.save('10.1.2.3', 'a', 'p1');
  await new Promise((r) => setTimeout(r, 5));
  await store.save('10.1.2.4', 'b', 'p2');
  assert.equal((await store.load()).address, '10.1.2.4');
});

test('凭据：has() 保持同步（界面渲染时同步取，⛔ 不能变成 Promise 真值）', () => {
  const { store } = makeCredentialStore();
  assert.equal(store.has(), false);
  assert.equal(typeof store.has(), 'boolean');
});

// ---------------------------------------------------------------- 账号清单

test('账号清单：登录成功记一条，同账号只更新时间', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-acc-'));
  const file = path.join(dir, 'accounts.json');
  const store = new AccountStore(file);
  store.remember({ address: '10.1.2.3', user: 'a', https: true });
  store.remember({ address: '10.1.2.4', user: 'b', https: true });
  store.remember({ address: '10.1.2.3', user: 'a', https: true });
  assert.equal(store.list().length, 2, '同账号⛔ 不该多一条');

  // 落盘再读回来：菜单要跨启动能看到这些账号
  const again = new AccountStore(file);
  assert.equal(again.list().length, 2);
  assert.equal(again.list()[0].user, 'a', '最近使用的排在最前');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('账号清单：坏数据不炸，且最多 10 条', () => {
  assert.deepEqual(normalizeAccounts(null), []);
  assert.deepEqual(normalizeAccounts([{ address: 'a' }, null, { user: 'b' }]), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ address: `h${i}`, user: 'u', lastUsedAt: i }));
  assert.equal(normalizeAccounts(many).length, 10);
});

test('账号清单：remove 只删指定那一对', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-acc-'));
  const store = new AccountStore(path.join(dir, 'accounts.json'));
  store.remember({ address: '10.1.2.3', user: 'a' });
  store.remember({ address: '10.1.2.4', user: 'b' });
  store.remove('10.1.2.3', 'a');
  assert.deepEqual(store.list().map((x) => x.user), ['b']);
  fs.rmSync(dir, { recursive: true, force: true });
});
