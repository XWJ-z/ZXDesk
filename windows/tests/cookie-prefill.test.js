/**
 * 0.1.4 的两个 P0 回归：
 * ① 登录两次 —— Cookie 必须写进**远程视图的分区**（`persist:zxdesk`），且**视图先建、Cookie 后写**；
 * ② 密码不回填 —— 所有回连接页的路径都要触发预填。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RemoteView } from '../src/main/browser/view.js';
import { Controller } from '../src/main/controller.js';

// ---------------------------------------------------------------- ① Cookie 分区

test('RemoteView.session：视图没建时必须是 persist:zxdesk 分区，⛔ 不能是壳窗口的会话', () => {
  const partitionSession = { id: 'partition' };
  const shellSession = { id: 'shell' };
  const called = [];
  const view = new RemoteView({
    electron: {
      WebContentsView: function Boom() {
        throw new Error('这里不建视图');
      },
      shell: { openExternal: async () => {} },
      session: {
        fromPartition: (name) => {
          called.push(name);
          return partitionSession;
        },
      },
    },
    win: { webContents: { session: shellSession, setWindowOpenHandler() {}, on() {} }, contentView: { addChildView() {} } },
    partition: 'persist:zxdesk',
    logger: () => {},
  });

  assert.equal(view.session, partitionSession, '0.1.3 这里回退成了壳会话 ⇒ Cookie 写错地方');
  assert.deepEqual(called, ['persist:zxdesk']);
  assert.notEqual(view.session, shellSession);
});

test('进入浏览：顺序必须是 ensure → 写 Cookie → 显示 → load（先写 Cookie 就会写错分区）', async () => {
  const calls = [];
  const { controller } = makeController({
    view: {
      ensure: () => {
        calls.push('ensure');
        return false;
      },
      setContext: () => calls.push('setContext'),
      setVisible: () => calls.push('setVisible'),
      load: async () => calls.push('load'),
    },
    cookies: {
      apply: async () => {
        calls.push('apply');
        return { total: 2, ok: 2 };
      },
      names: async () => ['fnos-token', 'entry-token'],
      clear: async () => {},
    },
  });

  await controller.enterBrowsing(sampleEntry(), null);

  assert.deepEqual(calls, ['setContext', 'ensure', 'apply', 'setVisible', 'load'], `实际顺序：${calls.join(' → ')}`);
  assert.ok(calls.indexOf('ensure') < calls.indexOf('apply'), 'Cookie 必须在视图建好之后写');
});

test('访问码屏：同样 ensure → Cookie → load', async () => {
  const calls = [];
  const { controller } = makeController({
    view: {
      ensure: () => calls.push('ensure'),
      setContext: () => calls.push('setContext'),
      setVisible: () => calls.push('setVisible'),
      load: async () => calls.push('load'),
    },
    cookies: {
      apply: async () => {
        calls.push('apply');
        return { total: 1, ok: 1 };
      },
      names: async () => ['fnos-token'],
      clear: async () => {},
    },
  });

  await controller.showAccessCode(sampleEntry());
  assert.ok(calls.indexOf('ensure') < calls.indexOf('apply'), `实际顺序：${calls.join(' → ')}`);
  assert.equal(calls.at(-1), 'load');
});

test('Cookie 注入日志：分区里 0 条时给 WARN（下次「登两次」能直接看出来）', async () => {
  const lines = [];
  const { controller } = makeController({
    logger: (m) => lines.push(m),
    cookies: {
      apply: async () => ({ total: 2, ok: 0 }),
      names: async () => [],
      clear: async () => {},
    },
  });
  await controller.enterBrowsing(sampleEntry(), null);
  assert.ok(
    lines.some((l) => l.includes('WARN') && l.includes('现存 0 条')),
    `应有 WARN 说分区是空的：${lines.join(' / ')}`,
  );
});

// ---------------------------------------------------------------- ② 密码回填

test('showConnect 会触发预填：地址/账号对得上就填密码', async () => {
  const { controller } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
    prefs: { lastAddress: '10.1.2.3', lastUser: 'myaccount' },
  });
  controller.showConnect();
  await tick();
  const form = controller.getState().connect;
  assert.equal(form.password, 'p@ss');
  assert.equal(form.hasSavedPassword, true);
});

test('预填：地址带了尾部斜杠 / 大小写不同也算命中（归一化比较）', async () => {
  const { controller } = makeController({
    credential: { address: '10.1.2.3/', user: 'myaccount', password: 'p@ss' },
    prefs: { lastAddress: '10.1.2.3', lastUser: 'myaccount' },
  });
  controller.showConnect();
  await tick();
  assert.equal(controller.getState().connect.password, 'p@ss');
});

test('预填：账号对不上就不填（⛔ 别张冠李戴）', async () => {
  const { controller } = makeController({
    credential: { address: '10.1.2.3', user: 'someone-else', password: 'p@ss' },
    prefs: { lastAddress: '10.1.2.3', lastUser: 'myaccount' },
  });
  controller.showConnect();
  await tick();
  assert.equal(controller.getState().connect.password, '');
});

test('预填：取消「记住密码」后不再回填', async () => {
  const { controller } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
    prefs: { lastAddress: '10.1.2.3', lastUser: 'myaccount', rememberPassword: false },
  });
  controller.showConnect();
  await tick();
  assert.equal(controller.getState().connect.password, '');
  assert.equal(controller.getState().connect.rememberPassword, false);
});

test('退出登录 → 回连接页：密码仍回填（退出不再清 credential.bin）', async () => {
  const { controller } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
    prefs: { lastAddress: '10.1.2.3', lastUser: 'myaccount' },
  });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('panel.logout');
  await tick();
  const form = controller.getState().connect;
  assert.equal(form.address, '10.1.2.3');
  assert.equal(form.user, 'myaccount');
  assert.equal(form.password, 'p@ss', '退出登录后重开必须还能回填');
  assert.equal(form.hasSavedPassword, true);
});

// ---------------------------------------------------------------- ③ 记住密码落盘（afterAuth）

test('afterAuth：没勾「记住密码」⇒ 不保存，并清掉旧凭据', async () => {
  const { controller } = makeController({});
  const calls = { save: 0, clear: 0 };
  controller.credentials = {
    load: async () => null,
    save: async () => {
      calls.save += 1;
      return true;
    },
    clear: () => {
      calls.clear += 1;
    },
    has: () => false,
  };

  controller.pendingEntry = sampleEntry();
  controller.pendingCredential = { address: '10.1.2.3', user: 'myaccount', password: 'p@ss', remember: false };

  await controller.afterAuth({ token: 'T', setCookies: ['a=1'], longToken: null, entryToken: null, secret: null });

  assert.equal(calls.save, 0, '没勾就不该保存');
  assert.ok(calls.clear >= 1, '应该把旧凭据清掉');
});

test('afterAuth：勾了才保存（并用归一化前的原地址存）', async () => {
  const { controller } = makeController({});
  const saved = [];
  controller.credentials = {
    load: async () => null,
    save: async (address, user, password) => {
      saved.push([address, user, password]);
      return true;
    },
    clear: () => {},
    has: () => false,
  };

  controller.pendingEntry = sampleEntry();
  controller.pendingCredential = { address: '10.1.2.3', user: 'myaccount', password: 'p@ss', remember: true };

  await controller.afterAuth({ token: 'T', setCookies: [], longToken: null, entryToken: null, secret: null });

  assert.deepEqual(saved, [['10.1.2.3', 'myaccount', 'p@ss']]);
});

// ---------------------------------------------------------------- 工具

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function sampleEntry() {
  return {
    baseUrl: 'https://10.1.2.3:64999',
    gatewayPath: '/app/zxdesk',
    flow: 'GATEWAY',
    relayHost: null,
    cleartext: false,
    address: '10.1.2.3',
    user: 'myaccount',
    session: { token: 'T', setCookies: ['a=1'], cookieHeader: () => 'fnos-token=T' },
    startUrl: () => 'https://10.1.2.3:64999/app/zxdesk/login.html',
  };
}

function makeController(options = {}) {
  const prefsValue = {
    lastAddress: '',
    preferHttps: true,
    lastUser: '',
    rememberPassword: true,
    deviceId: 'did',
    window: {},
    ...(options.prefs || {}),
  };
  const view = {
    ensure: () => false,
    setContext() {},
    setVisible() {},
    load: async () => {},
    ...(options.view || {}),
  };
  const cookies = {
    apply: async () => ({ total: 1, ok: 1 }),
    names: async () => ['fnos-token'],
    clear: async () => {},
    ...(options.cookies || {}),
  };
  const controller = new Controller({
    prefs: {
      value: prefsValue,
      get() {
        return this.value;
      },
      patch(p) {
        this.value = { ...this.value, ...p };
        return this.value;
      },
      setWindow() {},
    },
    sessions: { load: async () => null, save: async () => true, clear() {}, has: () => false },
    credentials: {
      load: async () => options.credential || null,
      save: async () => true,
      clear() {},
      has: () => Boolean(options.credential),
    },
    tofu: { get: () => null, put() {} },
    view,
    cookies,
    logger: options.logger || (() => {}),
    notify: () => {},
  });
  return { controller };
}
