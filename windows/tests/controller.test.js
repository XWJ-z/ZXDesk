import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { Controller } from '../src/main/controller.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 一整套假依赖：Controller 不 import electron，所以能在这里真跑状态机。 */
function makeController(overrides = {}) {
  const log = [];
  const state = {
    prefs: {
      value: { lastAddress: '', preferHttps: true, lastUser: '', rememberPassword: true, deviceId: 'did-test', window: {} },
      get() {
        return this.value;
      },
      patch(partial) {
        this.value = { ...this.value, ...partial };
        return this.value;
      },
      setWindow() {},
    },
    saved: overrides.saved || null,
    credentials: overrides.credential || null,
    tofu: new Map(),
  };

  const deps = {
    prefs: state.prefs,
    sessions: {
      async load() {
        return state.saved;
      },
      async save(saved) {
        state.saved = saved;
        log.push('session.save');
        return true;
      },
      clear() {
        state.saved = null;
        log.push('session.clear');
      },
      has() {
        return Boolean(state.saved);
      },
    },
    credentials: {
      async load() {
        return state.credentials;
      },
      async save() {
        log.push('credential.save');
        return true;
      },
      clear() {
        log.push('credential.clear');
      },
      has() {
        return Boolean(state.credentials);
      },
    },
    tofu: {
      get(host) {
        return state.tofu.get(host) || null;
      },
      put(host, record) {
        state.tofu.set(host, record);
      },
    },
    view: {
      loaded: [],
      visible: false,
      context: null,
      session: { cookies: { set: async () => {}, clear: async () => {} } },
      ensure() {
        return false;
      },
      setVisible(value) {
        this.visible = value;
      },
      setContext(context) {
        this.context = context;
      },
      async load(url) {
        this.loaded.push(url);
      },
      reload() {
        this.loaded.push('reload');
      },
      goBack() {},
      goForward() {},
      canGoBack() {
        return false;
      },
      canGoForward() {
        return false;
      },
    },
    cookies: {
      applied: [],
      async apply(session, target) {
        this.applied.push({ session, target });
      },
      async clear() {
        this.applied.push('clear');
      },
    },
    logger: () => {},
    notify: () => {},
    fetcher: async () => ({ ok: true, status: 200, text: async () => '<html>ok</html>', headers: { getSetCookie: () => [] } }),
  };
  const controller = new Controller({ ...deps, ...overrides.deps });
  controller.logPath = '/tmp/boot.log';
  return { controller, deps, state, log };
}

test('冷启动没有会话 ⇒ 停在选模式，并且表单有预填', async () => {
  const { controller } = makeController();
  await controller.boot();
  assert.equal(controller.getState().screen, 'mode');
  assert.equal(controller.getState().connect.https, true);
});

test('「仅本机」「混合」只轻提示，不切模式', async () => {
  const { controller } = makeController();
  await controller.boot();
  await controller.action('mode.select', { mode: 'local' });
  assert.equal(controller.getState().mode, 'nas');
  assert.match(controller.getState().notice, /规划中/);
});

test('下一步 → 连接页；返回 → 逐级回退到选模式', async () => {
  const { controller } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  assert.equal(controller.getState().screen, 'connect');
  await controller.action('flow.back');
  assert.equal(controller.getState().screen, 'mode');
});

test('局域网 IP 不填账号 ⇒ 表单直接拦住，不发请求、不进浏览（0.1.2 口径）', async () => {
  const { controller, deps } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: '', password: '' });
  const st = controller.getState();
  assert.equal(st.screen, 'connect');
  assert.match(st.connect.error, /局域网也要登录飞牛/);
  assert.equal(deps.view.loaded.length, 0, '被拦住时不该加载任何页面');
  assert.equal(deps.view.visible, false);
});

test('显式 IP:8990 ⇒ 不需要飞牛账号也能直连（唯一例外）', async () => {
  const { controller, deps } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3:8990', https: true, user: '', password: '' });
  const st = controller.getState();
  assert.equal(st.screen, 'browsing');
  assert.match(st.notice, /已直连 8990/);
  assert.equal(deps.view.loaded.at(-1), 'http://10.1.2.3:8990/app/zxdesk/login.html');
});

test('地址认不出 ⇒ 就地报错，不进浏览模式', async () => {
  const { controller } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '', https: true, user: '', password: '' });
  assert.equal(controller.getState().screen, 'connect');
  assert.match(controller.getState().connect.error, /请输入 NAS 地址/);
});

test('公网 http ⇒ 拒绝（明文只允许私网）', async () => {
  const { controller } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: 'http://example.com', https: false, user: 'u', password: 'p' });
  assert.equal(controller.getState().screen, 'connect');
  assert.match(controller.getState().connect.error, /公网地址必须使用 HTTPS/);
});

test('证书确认：首次 ⇒ 进证书屏；信任后写 TOFU 并放行', async () => {
  const { controller, state } = makeController();
  await controller.boot();
  const promise = controller.requestTrust('10.1.2.3', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'AA:BB' });
  assert.equal(controller.getState().screen, 'cert');
  assert.equal(controller.getState().cert.sha256, 'AABB');
  controller.decideCert(true);
  assert.equal(await promise, true);
  assert.equal(state.tofu.get('10.1.2.3').sha256, 'AABB');
});

test('证书确认：已信任过 ⇒ 直接放行，不弹屏', async () => {
  const { controller, state } = makeController();
  await controller.boot();
  state.tofu.set('nas', { subject: 'CN=fnOS,O=fnOS', sha256: 'AABB' });
  const ok = await controller.requestTrust('nas', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'AA:BB' });
  assert.equal(ok, true);
  assert.notEqual(controller.getState().screen, 'cert');
});

test('证书确认：不是本设备证书 ⇒ 直接拒（不问用户）', async () => {
  const { controller } = makeController();
  await controller.boot();
  const ok = await controller.requestTrust('evil', { subjectText: 'CN=other,O=other', fingerprint256: 'XX' });
  assert.equal(ok, false);
});

test('证书轮换：指纹变了 ⇒ 弹「已更新」屏，并带旧指纹', async () => {
  const { controller, state } = makeController();
  await controller.boot();
  state.tofu.set('nas', { subject: 'CN=fnOS,O=fnOS', sha256: 'AA:BB' });
  controller.requestTrust('nas', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'CC:DD' });
  const cert = controller.getState().cert;
  assert.equal(cert.rotated, true);
  assert.equal(cert.previousSha256, 'AABB');
  controller.decideCert(false);
});

test('连接面板：打开即隐藏远程视图，关闭恢复', async () => {
  const { controller, deps } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3:8990', https: true, user: '', password: '' });
  await controller.action('panel.open');
  assert.equal(deps.view.visible, false);
  assert.ok(controller.getState().panel);
  assert.equal(controller.getState().panel.version, pkg.version);
  await controller.action('panel.close');
  assert.equal(deps.view.visible, true);
  assert.equal(controller.getState().panel, null);
});

test('退出登录：清会话与 Cookie，但**留住记住的密码**（0.1.6 WIN-009 口径）', async () => {
  const { controller, log, state } = makeController();
  state.credentials = { address: '10.1.2.3:8990', user: 'myaccount', password: 'p@ss' };
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: false, user: '', password: '' });
  await controller.action('panel.logout');
  assert.equal(controller.getState().screen, 'connect');
  assert.ok(log.includes('session.clear'));
  assert.ok(!log.includes('credential.clear'), '退出登录不该清掉记住的密码');
  assert.ok(state.credentials, 'credential.bin 要留着，重开才能回填');
  assert.match(String(controller.getState().connect.notice), /退出/);
  assert.equal(state.prefs.value.rememberPassword, true, '偏好不该被动');
});

test('记住密码取消勾选 ⇒ 立刻清除（不等下次保存）', async () => {
  const { controller, log } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.remember', { value: false });
  assert.ok(log.includes('credential.clear'));
  assert.equal(controller.getState().connect.rememberPassword, false);
});

test('两步验证等待时点返回 ⇒ 回连接页并清理（⛔ 不留半截界面）', async () => {
  const { controller } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  controller.state = { ...controller.state, screen: 'twofa', twofa: { totp: '', emailView: false } };
  await controller.action('flow.back');
  assert.equal(controller.getState().screen, 'connect');
  assert.equal(controller.getState().twofa, null);
});

test('诊断文本不含密码与 token', async () => {
  const { controller } = makeController();
  await controller.boot();
  controller.state = { ...controller.state, connect: { ...controller.state.connect, password: 'p@ss' } };
  const text = controller.diagnosticsText();
  assert.ok(!text.includes('p@ss'));
  assert.ok(text.includes(`ZXDesk ${pkg.version}`), `诊断里要有版本号：${text.split('\n')[0]}`);
});

// ---------------------------------------------------------------- 0.1.2：2FA 提交必须真的发出去

/** 进到两步验证屏，并塞一个假 flow（controller.flow 是普通字段，可直接替换）。 */
async function onTwoFactorScreen(controller) {
  await controller.boot();
  await controller.action('flow.next');
  controller.state = {
    ...controller.state,
    screen: 'twofa',
    twofa: {
      maskedEmail: 'me@example.com',
      totpEnabled: true,
      emailEnabled: true,
      trustDevice: true,
      emailView: false,
      totp: '',
      email: '',
      emailCode: '',
      emailSent: false,
      resendLeft: 0,
      busy: false,
      error: null,
    },
  };
}

function fakeFlow() {
  const calls = { totp: [], email: [], send: 0 };
  return {
    calls,
    submitTotp: async (code, trust) => {
      calls.totp.push([code, trust]);
      return { token: 'T' };
    },
    submitEmailCode: async (email, code, trust) => {
      calls.email.push([email, code, trust]);
      return { token: 'T' };
    },
    sendEmailCode: async () => {
      calls.send += 1;
      return true;
    },
    close: () => {},
  };
}

test('2FA：壳带上来的验证码会被真正交给 flow（0.1.1 的「点了没反应」回归）', async () => {
  const { controller } = makeController();
  await onTwoFactorScreen(controller);
  const flow = fakeFlow();
  controller.flow = flow;
  const authed = [];
  controller.afterAuth = async (session) => {
    authed.push(session);
    controller.patchTwofa({ busy: false }); // 真实 afterAuth 会离开这一屏；这里补上复位
  };

  await controller.action('twofa.submitTotp', { code: '991106' });

  assert.deepEqual(flow.calls.totp, [['991106', true]], '验证码必须真发出去，且带上「信任此设备」');
  assert.equal(authed.length, 1, '验证通过后要走 afterAuth');
  assert.equal(controller.getState().twofa.busy, false);
});

test('2FA：验证码不足 6 位 ⇒ 可见错误 + 不碰 flow（⛔ 不再静默 return）', async () => {
  const { controller } = makeController();
  await onTwoFactorScreen(controller);
  const flow = fakeFlow();
  controller.flow = flow;

  await controller.action('twofa.submitTotp', { code: '' });

  assert.equal(flow.calls.totp.length, 0);
  assert.match(controller.getState().twofa.error, /6 位验证码/);
  assert.equal(controller.getState().twofa.busy, false);
});

test('2FA：会话已失效（flow 为空）⇒ 明确提示，不是「什么都不发生」', async () => {
  const { controller } = makeController();
  await onTwoFactorScreen(controller);
  controller.flow = null;

  await controller.action('twofa.submitTotp', { code: '991106' });

  assert.match(controller.getState().twofa.error, /会话已失效/);
});

test('2FA：安全邮箱那路也能提交（邮箱 + 字母数字码都带上）', async () => {
  const { controller } = makeController();
  await onTwoFactorScreen(controller);
  const flow = fakeFlow();
  controller.flow = flow;
  controller.afterAuth = async () => {};

  await controller.action('twofa.submitEmail', { email: 'me@example.com', code: 'A1B2C3' });

  assert.deepEqual(flow.calls.email, [['me@example.com', 'A1B2C3', true]]);
});

test('2FA：邮箱格式不对 / 没填码 ⇒ 各自给提示，且不调 flow', async () => {
  const { controller } = makeController();
  await onTwoFactorScreen(controller);
  const flow = fakeFlow();
  controller.flow = flow;

  await controller.action('twofa.submitEmail', { email: 'not-an-email', code: 'A1B2C3' });
  assert.match(controller.getState().twofa.error, /邮箱地址/);

  await controller.action('twofa.submitEmail', { email: 'me@example.com', code: '' });
  assert.match(controller.getState().twofa.error, /邮箱验证码/);

  assert.equal(flow.calls.email.length, 0);
});

test('动作入口会写日志（下次 boot.log 能看到「点了什么」）', async () => {
  const lines = [];
  const { controller } = makeController({ deps: { logger: (m) => lines.push(m) } });
  await controller.boot();
  await controller.action('flow.next');
  assert.ok(
    lines.some((l) => l.includes('动作：flow.next')),
    '日志里应有动作记录：' + lines.join(' / '),
  );
});
