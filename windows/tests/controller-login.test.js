/**
 * 登录链路的整体串联（Controller + 真 FnLoginFlow + 假 RPC + 假网关）：
 * 提交账号密码 → 2FA → ticket → 会话落盘 → Cookie 注入 → 探针 → 进浏览模式 / 进访问码页。
 *
 * 这是本机唯一能验「编排」的方式（没有显示器起不了 Electron，也不许联网打真 NAS）。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { Controller } from '../src/main/controller.js';
import { openEnvelope } from '../src/main/login/crypto.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** 假 WS 客户端：与服务端一问一答，够 FnLoginFlow 用。 */
function fakeRpcFactory(handler) {
  const created = [];
  const factory = () => {
    const client = {
      isConnected: false,
      sent: [],
      async connect() {
        this.isConnected = true;
      },
      async call(json, reqid) {
        this.sent.push(json);
        const cut = json.indexOf('{');
        const body = cut > 0 ? json.slice(cut) : json;
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }
        if (parsed.req === 'encrypted') {
          parsed = JSON.parse(openEnvelope(body, privateKey).inner);
        }
        return handler(parsed, reqid, this);
      },
      send(text) {
        this.sent.push(text);
        return true;
      },
      close() {
        this.isConnected = false;
      },
    };
    created.push(client);
    return client;
  };
  return { factory, created };
}

function makeController({ handler, probeBody = '<html><body>ZXDesk</body></html>' }) {
  const state = { saved: null, credentials: null, tofu: new Map(), applied: [] };
  const { factory, created } = fakeRpcFactory(handler);
  const view = {
    loaded: [],
    visible: false,
    context: null,
    session: { cookies: { set: async () => {}, clear: async () => {} } },
    ensure: () => false,
    setVisible(value) {
      this.visible = value;
    },
    setContext(context) {
      this.context = context;
    },
    async load(url) {
      this.loaded.push(url);
    },
    reload() {},
    goBack() {},
    goForward() {},
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const controller = new Controller({
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
    sessions: {
      load: async () => state.saved,
      save: async (saved) => {
        state.saved = saved;
        return true;
      },
      clear() {
        state.saved = null;
      },
      has: () => Boolean(state.saved),
    },
    credentials: {
      load: async () => state.credentials,
      save: async () => true,
      clear() {
        state.credentials = null;
      },
      has: () => Boolean(state.credentials),
    },
    tofu: {
      get: (host) => state.tofu.get(host) || null,
      put: (host, record) => state.tofu.set(host, record),
    },
    view,
    cookies: {
      applied: state.applied,
      async apply(session, target) {
        this.applied.push({ token: session.token, target });
      },
      async clear() {},
    },
    logger: () => {},
    notify: () => {},
    fetcher: async (_url) => ({
      ok: true,
      status: 200,
      // 允许给函数：按调用次数模拟「预检要码 / 过码后放行」
      text: async () => (typeof probeBody === 'function' ? probeBody() : probeBody),
      headers: { getSetCookie: () => ['fnos-token=TICKET-TOKEN; Path=/; Secure'] },
    }),
    rpcFactory: factory,
  });
  controller.logPath = '/tmp/boot.log';
  return { controller, state, view, created };
}

const twoFactorHandler = (json, reqid) => {
  const req = json.req;
  if (req === 'util.crypto.getRSAPub') return { reqid, result: 'succ', pub: publicKey, si: '748918410105123456' };
  if (req === 'user.login') return { reqid, result: 'succ', accessToken: 'ACC', isTwofaEnforced: true, isBindTwofaSecret: true };
  if (req === 'user.2fa.loginVerify') return { reqid, result: 'succ', token: 'TOKEN', ticket: 'TCK', longToken: 'LT' };
  return { reqid, result: 'succ' };
};

test('局域网 IP + 账号 ⇒ 走网关登录 → 2FA → 进浏览模式，会话与 Cookie 都落地', async () => {
  const { controller, state, view } = makeController({ handler: twoFactorHandler });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  // 局域网优先网关：应该是 https://ip:64999
  const st = controller.getState();
  assert.equal(st.screen, 'twofa', `应该进两步验证屏，实际 ${st.screen}`);
  assert.equal(st.twofa.totpEnabled, true);
  assert.equal(st.twofa.trustDevice, true, '「信任此设备」默认勾上');

  await controller.action('twofa.totp', { value: '123456' });
  await controller.action('twofa.submitTotp');

  const after = controller.getState();
  assert.equal(after.screen, 'browsing');
  assert.equal(after.browsing.linkLabel, '局域网网关', '局域网 64999 走的是网关，不是公网域名');
  assert.equal(view.visible, true);
  assert.equal(view.loaded.at(-1), 'https://10.1.2.3:64999/app/zxdesk/login.html');
  assert.equal(state.saved.session.token, 'TOKEN');
  assert.equal(state.saved.session.longToken, 'LT');
  assert.deepEqual(state.saved.session.setCookies, ['fnos-token=TICKET-TOKEN']);
  assert.equal(state.applied.length, 1, 'Cookie 要写进远程视图');
});

test('网关要访问码 ⇒ 先过码、再验密码（fnOS 顺序），过码后自己接着登录', async () => {
  let probes = 0;
  const { controller, state, view } = makeController({
    handler: twoFactorHandler,
    // 第一次（登录前预检）是访问码页；过码之后的预检放行
    probeBody: () => (++probes === 1 ? '<!doctype html><html><body><h1>请输入访问码</h1></body></html>' : '<html><body>ZXDesk</body></html>'),
  });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  assert.equal(controller.getState().screen, 'access', '还没验证密码就该停在访问码页');
  assert.equal(view.visible, true, '访问码页要真的显示出来（远程视图）');
  assert.equal(state.saved, null, '访问码没过之前不该有会话');
  assert.equal(state.applied.length, 0, '访问码没过之前不该有会话 Cookie');

  // 过码 → 自动重走连接：这次预检放行，才轮到密码 / 两步验证
  await controller.action('access.done');
  assert.equal(controller.getState().screen, 'twofa', '过码后才验证密码（两步验证）');
  await controller.action('twofa.totp', { value: '123456' });
  await controller.action('twofa.submitTotp');

  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(state.saved.session.token, 'TOKEN', '会话已落盘');
});

test('网关探针说 invalid token ⇒ 仍按「进应用」处理（弱信号不拦人）', async () => {
  const { controller } = makeController({ handler: twoFactorHandler, probeBody: 'invalid token' });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  await controller.action('twofa.totp', { value: '123456' });
  await controller.action('twofa.submitTotp');
  assert.equal(controller.getState().screen, 'browsing');
});

test('验证码错（errno）⇒ 留在两步验证屏并给中文提示，不死循环', async () => {
  const handler = (json, reqid) => {
    const req = json.req;
    if (req === 'util.crypto.getRSAPub') return { reqid, result: 'succ', pub: publicKey, si: '1' };
    if (req === 'user.login') return { reqid, result: 'succ', accessToken: 'ACC', isTwofaEnforced: true };
    if (req === 'user.2fa.loginVerify') return { reqid, result: 'failed', errno: 102570104 };
    return { reqid, result: 'succ' };
  };
  const { controller } = makeController({ handler });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  await controller.action('twofa.totp', { value: '000000' });
  await controller.action('twofa.submitTotp');
  const st = controller.getState();
  assert.equal(st.screen, 'twofa');
  assert.match(st.twofa.error, /验证码不正确/);
  assert.equal(st.twofa.busy, false, 'busy 必须复位，否则界面卡在「验证中…」');
});

test('没填账号的局域网 IP：表单拦住（不再偷偷走 8990）', async () => {
  const { controller, view } = makeController({ handler: twoFactorHandler });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: '', password: '' });
  assert.equal(controller.getState().screen, 'connect');
  assert.match(controller.getState().connect.error, /局域网也要登录飞牛/);
  assert.equal(view.loaded.length, 0);

  // 把 HTTPS 关掉 = 显式要 8990 直连，这时才允许无账号进
  await controller.action('connect.submit', { address: '10.1.2.3', https: false, user: '', password: '' });
  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(view.loaded.at(-1), 'http://10.1.2.3:8990/app/zxdesk/login.html');
});
