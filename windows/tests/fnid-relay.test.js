/**
 * 0.1.6 收尾（WIN-008）：**FNID 只走中继**，错误页只说人话。
 *
 * 0.1.5 曾在 FNID 分支里读 `fn/con` 的 `ipv4`、拼 `https://<ip>:64999` 先试局域网，
 * 失败再回中继 —— 那是自创机制：Android 的 `NasDataSource.fromFnId` 只有中继，
 * 而 `ipv4` 未必是 NAS 的内网地址（实测拼出 `10.1.2.4:64999` 根本连不上）。
 * 这一组用例把「只中继」「界面不露地址」钉死。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { clearCookies } from '../src/main/browser/cookies.js';
import { Controller } from '../src/main/controller.js';
import { LOGIN_STEP, LoginError } from '../src/main/login/errno.js';
import { WsClosedError } from '../src/main/login/wsclient.js';
import { SavedSession } from '../src/main/store/session.js';

const ok = (obj) => ({
  ok: true,
  status: 200,
  text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  headers: { getSetCookie: () => [] },
});

/** `fn/con` 的真实形状：既有内网 ipv4，也有公网 ipv4 与中继域名。 */
const FN_CON = {
  code: 0,
  msg: '',
  data: {
    ipv4: ['10.1.2.4'],
    ipv6: [],
    publicIpv4: ['203.0.113.7'],
    fn: ['my-nas.fnos.net:443'],
    port: { httpsPort: 64999, httpPort: 64888 },
  },
};

const fnidFetcher = (body = FN_CON) => async (url) => (String(url).includes('/fn/con') ? ok(body) : ok('{}'));

function makeController(options = {}) {
  const state = { saved: options.saved || null, credential: options.credential || null, logs: [], loads: [] };
  const view = {
    setContext() {},
    setVisible() {},
    ensure: () => false,
    load: async (url) => {
      state.loads.push(url);
      return true;
    },
    loadChecked: async (url) => {
      state.loads.push(url);
      return options.loadResult === undefined ? true : options.loadResult(url);
    },
    reload() {},
    goBack() {},
    goForward() {},
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const controller = new Controller({
    prefs: {
      value: { lastAddress: '', preferHttps: true, lastUser: '', rememberPassword: true, deviceId: 'did', window: {} },
      get() {
        return this.value;
      },
      patch(p) {
        this.value = { ...this.value, ...p };
        return this.value;
      },
      setWindow() {},
    },
    sessions: {
      load: async () => state.saved,
      save: async (s) => {
        state.saved = s;
        return true;
      },
      clear() {
        state.saved = null;
      },
      has: () => Boolean(state.saved),
    },
    credentials: {
      load: async () => state.credential,
      save: async (address, user, password) => {
        state.credential = { address, user, password };
        return true;
      },
      clear() {
        state.credential = null;
      },
      has: () => Boolean(state.credential),
    },
    tofu: { get: () => null, put() {} },
    view,
    cookies: {
      partition: 'persist:zxdesk',
      apply: async () => ({ total: 1, ok: 1 }),
      names: async () => ['fnos-token'],
      clear: async () => {},
    },
    logger: (m) => state.logs.push(m),
    notify: () => {},
    fetcher: options.fetcher,
    rpcFactory: options.rpcFactory,
  });
  controller.logPath = '/tmp/boot.log';
  return { controller, state };
}

/** 一个永远连不上的「客户端」：模拟中继 DNS 挂了 / 端口拒了。 */
const deadRpc = () => () => ({
  isConnected: false,
  async connect() {
    throw new WsClosedError('getaddrinfo ENOTFOUND my-nas.fnos.net');
  },
  async call() {
    throw new WsClosedError('不通');
  },
  send: () => true,
  close() {},
});

// ---------------------------------------------------------------- FNID：只中继

test('FNID 解析出私网 ipv4 ⇒ 仍然只走中继（这条在旧代码上必失败）', async () => {
  const { controller, state } = makeController({ fetcher: fnidFetcher() });
  const plan = await controller.resolvePlan({ kind: 'fnid', id: 'my-nas' }, { https: true });

  assert.equal(plan.entry.baseUrl, 'https://my-nas.fnos.net', 'FNID 只认中继，⛔ 不许拼 ipv4');
  assert.equal(plan.entry.relayHost, 'my-nas.fnos.net');
  assert.equal(plan.fallback, undefined, '不再有回落项');
  assert.equal(plan.lanBaseUrl, undefined);
  assert.ok(!('lanBaseUrl' in plan.entry), '快照里不该再出现 lanBaseUrl');
  assert.ok(!state.logs.some((l) => l.includes('10.1.2.4')), `日志里不该出现猜出来的 IP：${state.logs.join(' / ')}`);
  assert.ok(state.logs.some((l) => l.includes('FNID 解析：relay=my-nas.fnos.net')));
  assert.ok(!state.logs.some((l) => l.includes('lan=')), '日志不再记 lan=');
});

test('FNID 只有 ipv4、没有中继 ⇒ 明确报错，不拿 IP 凑数', async () => {
  const body = { ...FN_CON, data: { ...FN_CON.data, fn: [] } };
  const { controller } = makeController({ fetcher: fnidFetcher(body) });
  const plan = await controller.resolvePlan({ kind: 'fnid', id: 'my-nas' }, { https: true });
  assert.match(plan.error, /没有中继地址/, `实际：${JSON.stringify(plan)}`);
  assert.equal(plan.entry, undefined);
});

test('全链路：FNID → 中继 → 登录成功 → 进浏览（只连一次，不再试 LAN）', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let attempts = 0;
  const rpcFactory = () => {
    attempts += 1;
    return {
      isConnected: false,
      async connect() {
        this.isConnected = true;
      },
      async call(json, reqid) {
        const parsed = JSON.parse(json);
        if (parsed.req === 'encrypted') return { reqid, result: 'succ', token: 'TOKEN' };
        if (parsed.req === 'util.crypto.getRSAPub') return { reqid, pub: publicKey, si: '1' };
        return { reqid, result: 'succ' };
      },
      send: () => true,
      close() {},
    };
  };

  const { controller, state } = makeController({ fetcher: fnidFetcher(), rpcFactory });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', {
    address: 'my-nas',
    https: true,
    user: 'myaccount',
    password: 'p@ss',
    rememberPassword: true,
  });

  assert.equal(attempts, 1, '只该连一条路（中继）');
  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(state.saved.baseUrl, 'https://my-nas.fnos.net');
  assert.ok(!state.logs.some((l) => l.includes('改用中继')), '不该再有「改用中继」的回落日志');
  assert.equal(state.loads.at(-1), 'https://my-nas.fnos.net/app/zxdesk/login.html');
});

// ---------------------------------------------------------------- 失败：留在登录页，只说一句

test('中继连不上 ⇒ **留在登录页**，按钮下方只有「登录失败」，表单与密码都在', async () => {
  const { controller } = makeController({ fetcher: fnidFetcher(), rpcFactory: deadRpc() });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', {
    address: 'my-nas',
    https: true,
    user: 'myaccount',
    password: 'p@ss',
  });

  const st = controller.getState();
  assert.equal(st.screen, 'connect', '登录失败不该整页跳走');
  assert.equal(st.error, null, '不走整页错误页');
  assert.equal(st.connect.error, '登录失败', '就这一句，原因不上屏');
  assert.equal(st.connect.busy, false);
  // 表单值必须原样留着：用户改个密码就能再试
  assert.equal(st.connect.address, 'my-nas');
  assert.equal(st.connect.user, 'myaccount');
  assert.equal(st.connect.password, 'p@ss');

  const shown = `${st.connect.error || ''}`;
  for (const leak of ['my-nas.fnos.net', '192.168', '64999', 'ENOTFOUND', '已尝试', 'boot.log']) {
    assert.ok(!shown.includes(leak), `界面上不该出现「${leak}」：${shown}`);
  }
});

test('复制诊断仍保留完整细节（地址 / 步骤 / 原始错误 / 日志）', async () => {
  const { controller } = makeController({ fetcher: fnidFetcher(), rpcFactory: deadRpc() });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: 'my-nas', https: true, user: 'u', password: 'p' });

  const text = controller.diagnosticsText();
  assert.match(text, /my-nas\.fnos\.net/, '诊断里要有地址，供排查');
  assert.match(text, /最近一次尝试/, '诊断里要有「最近一次尝试」');
  assert.match(text, /ENOTFOUND|连接飞牛 WebSocket/, '诊断里要有原始错误或步骤');
  assert.match(text, /boot\.log|日志/, '诊断里要有日志位置');
});

test('账号密码错 ⇒ 也只能看到「登录失败」，具体原因在日志里（照抄 Android 的中文）', () => {
  const { controller, state } = makeController({ fetcher: fnidFetcher() });
  controller.lastForm = { address: 'my-nas', user: 'u', password: 'wrong', rememberPassword: true };
  controller.state = { ...controller.state, screen: 'connect', connect: { ...controller.state.connect, address: 'my-nas', user: 'u' } };
  controller.failLogin(new LoginError(LOGIN_STEP.LOGIN, '飞牛账号或密码不正确'));

  const st = controller.getState();
  assert.equal(st.screen, 'connect');
  assert.equal(st.connect.error, '登录失败');
  assert.ok(
    state.logs.some((l) => l.includes('登录失败（提交账号密码）：飞牛账号或密码不正确')),
    `日志里要有真实原因：${state.logs.join(' / ')}`,
  );
});

test('证书步骤失败同样留在登录页（不跳错误页）', () => {
  const { controller, state } = makeController({ fetcher: fnidFetcher() });
  controller.lastForm = { address: 'my-nas', user: 'u', password: 'p', rememberPassword: true };
  controller.failLogin(new LoginError(LOGIN_STEP.RSA_KEY, 'certificate unknown'));

  assert.equal(controller.getState().screen, 'connect');
  assert.equal(controller.getState().connect.error, '登录失败');
  assert.ok(state.logs.some((l) => l.includes('certificate unknown')));
});

test('页面加载失败：留在浏览模式，错误只进菜单栏提示（不再整页跳走）', async () => {
  const saved = new SavedSession({
    baseUrl: 'https://my-nas.fnos.net',
    flow: 'GATEWAY',
    relayHost: 'my-nas.fnos.net',
    session: { token: 'T' },
  });
  const { controller } = makeController({ saved, loadResult: () => false });
  await controller.boot();
  const st = controller.getState();
  // 2026-10-27：整页错误屏已删除 —— 一次网络抖动不该把整窗刷白并打断浏览
  assert.equal(st.screen, 'browsing', '不换屏');
  assert.equal(st.browsing.error, '页面没有加载出来，检查网络后点「重试」。', '提示落在菜单栏');
  assert.equal(st.error.title, '打不开页面', '诊断里仍留着标题');
  assert.equal(st.error.message, '页面没有加载出来，检查网络后点「重试」。');
});

test('会话失效走到底 ⇒ 回连接页 + 下方「登录失败」，且密码没被清', async () => {
  const { controller, state } = makeController({ credential: { address: 'my-nas', user: 'myaccount', password: 'p@ss' } });
  await controller.boot();
  await controller.action('flow.next');
  await controller.onSessionExpired(); // 没有快照 ⇒ 直接走最后一段
  const st = controller.getState();
  assert.equal(st.screen, 'connect');
  assert.equal(st.connect.error, '登录失败');
  assert.ok(state.credential, 'credential.bin 不该被这条路径清掉');
});

// ---------------------------------------------------------------- 快照：旧 lanBaseUrl 一律不认

test('旧快照里的 lanBaseUrl 被忽略：仍按 baseUrl 进，且保存后不再出现', async () => {
  const saved = new SavedSession({
    address: 'my-nas',
    baseUrl: 'https://my-nas.fnos.net',
    flow: 'GATEWAY',
    relayHost: 'my-nas.fnos.net',
    session: { token: 'T' },
  });
  // 手工塞一个旧字段（模拟 0.1.5 存下来的快照）
  const legacy = SavedSession.fromJSON(JSON.stringify({ ...saved.toJSON(), lanBaseUrl: 'https://10.1.2.4:64999' }));
  assert.equal(legacy.lanBaseUrl, undefined, '读的时候就不该认这个字段');
  assert.ok(!('lanBaseUrl' in legacy.toJSON()), '写回时也不该带上');

  const { controller, state } = makeController({ saved: legacy });
  await controller.boot();
  assert.equal(state.loads.length, 1, `只加载一次，实际：${state.loads.join(' ')}`);
  assert.match(state.loads[0], /^https:\/\/my-nas\.fnos\.net/);
});

// ---------------------------------------------------------------- 与登录链路无关但别丢的回归

test('换地址 / 退出登录都留着记住的密码，只有「清除」或取消勾选才清', async () => {
  const { controller, state } = makeController({ credential: { address: 'my-nas', user: 'myaccount', password: 'p@ss' } });
  await controller.boot();
  await controller.action('panel.changeAddress');
  assert.ok(state.credential, '换地址不该清密码');
  await controller.action('panel.logout');
  assert.ok(state.credential, '退出登录也不该清（否则重开密码框就是空的）');

  // 用户真要清：连接页的「清除」
  await controller.action('connect.clearSaved');
  assert.equal(state.credential, null, '「清除」才清');
});

test('clearCookies：用 Session.clearStorageData（Cookies 没有 clear()）', async () => {
  const calls = [];
  const session = {
    clearStorageData: async (opts) => calls.push(opts),
    cookies: { get: async () => [], remove: async () => {} },
  };
  assert.equal(await clearCookies(session), true);
  assert.deepEqual(calls, [{ storages: ['cookies'] }]);
});

test('clearCookies：没有 clearStorageData 时逐条 remove', async () => {
  const removed = [];
  const session = {
    cookies: {
      get: async () => [
        { name: 'fnos-token', domain: '.my-nas.fnos.net', path: '/', secure: true },
        { name: 'mode', domain: 'my-nas.fnos.net', path: '/', secure: true },
      ],
      remove: async (url, name) => removed.push([url, name]),
    },
  };
  assert.equal(await clearCookies(session), true);
  assert.equal(removed.length, 2);
  assert.deepEqual(removed[0], ['https://my-nas.fnos.net/', 'fnos-token']);
});
