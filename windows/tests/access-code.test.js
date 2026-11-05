/**
 * 0.2.4：访问码登录修复 ＋ 静默启动 ＋ 静默重连（照 Android 0.2.17 / 0.2.18 口径）。
 *
 * 三条现场问题，各钉几条用例：
 * 1. 开了访问码的 NAS：原生 WS 握手被网关 401 ⇒ 以前报「登录失败」，用户怎么输都进不去；
 * 2. 冷启动没有会话快照、但本机记着密码 ⇒ 以前先甩一屏登录表单；
 * 3. 会话过期 ⇒ 以前要等用户点东西才发现，或者整页跳回登录页。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { mergeCookieHeader } from '../src/main/browser/cookies.js';
import { RemoteView } from '../src/main/browser/view.js';
import { GATEWAY_PAGE, PROBE_SCRIPT, classifyProbeResult } from '../src/main/connection/gateway.js';
import { Controller } from '../src/main/controller.js';
import { openEnvelope } from '../src/main/login/crypto.js';
import { AccessCodeRequiredError } from '../src/main/login/wsclient.js';
import { normalizePrefs } from '../src/main/store/prefs.js';
import { SavedSession } from '../src/main/store/session.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const LAN = 'https://10.1.2.3:64999';
const APP_HTML = '<!doctype html><html><body><div id="app">ZXDesk</div></body></html>';
const ACCESS_HTML = '<!doctype html><html><body><h1>请输入访问码</h1></body></html>';

/** 假 WS：`onConnect(n)` 返回 'access-code' 时这次握手被网关 401。 */
function makeRpcFactory(state, options) {
  return (url, cookie) => {
    state.handshakes.push({ url, cookie });
    const index = state.handshakes.length;
    return {
      isConnected: false,
      async connect() {
        if (options.onConnect?.(index, state) === 'access-code') {
          throw new AccessCodeRequiredError('网关要求先输入访问码（HTTP 401）', 401);
        }
        this.isConnected = true;
      },
      async send() {
        return true;
      },
      async call(json, reqid) {
        const cut = json.indexOf('{');
        const body = cut > 0 ? json.slice(cut) : json;
        let parsed = JSON.parse(body);
        if (parsed.req === 'encrypted') parsed = JSON.parse(openEnvelope(body, privateKey).inner);
        return options.handler(parsed, reqid, state);
      },
      close() {
        this.isConnected = false;
      },
    };
  };
}

/** 默认登录应答：第一次给 TOKEN，之后给 NEW（用来区分「有没有真的重登」）。 */
function loginHandler(json, reqid, state) {
  if (json.req === 'util.crypto.getRSAPub') {
    return { reqid, result: 'succ', pub: publicKey, si: '748918410105123456' };
  }
  if (json.req === 'user.login') {
    state.logins += 1;
    return { reqid, result: 'succ', token: state.logins === 1 ? 'TOKEN' : 'NEW', ticket: 'TCK' };
  }
  if (json.req === 'user.tokenLogin') {
    state.logins += 1;
    return { reqid, result: 'succ', token: 'NEW', ticket: 'TCK' };
  }
  return { reqid, result: 'succ' };
}

function makeController(options = {}) {
  const state = {
    saved: options.saved || null,
    credentials: options.credential || null,
    /** 多账号：一组凭据（切换账号用例用；不传就退回单条 `credential`）。 */
    credentialList: options.credentialList || null,
    applied: [],
    loads: [],
    logs: [],
    states: [],
    handshakes: [],
    probes: [],
    /** 走分区 fetch 的探测记录（`probeFetcher` 注入时才有）。 */
    partitionProbes: [],
    logins: 0,
    reloads: 0,
    /** 访问码屏轮询读到的页面类型（用例里改这个模拟网关换页）。 */
    viewPage: options.viewPage || GATEWAY_PAGE.ACCESS_CODE,
    prefs: normalizePrefs({
      lastAddress: '10.1.2.3',
      lastUser: 'myaccount',
      ...(options.prefs || {}),
    }),
    // pref 上的 lastAddress 是给静默启动用的；表单预填读的是同一个对象
    ...options.state,
  };

  /** 每次探测返回的正文：可以给函数（按调用次数模拟网关换页）。 */
  const probeBody = () =>
    typeof options.probeBody === 'function' ? options.probeBody() : options.probeBody || APP_HTML;

  const view = {
    visible: false,
    context: null,
    setContext(context) {
      this.context = context;
    },    setVisible(value) {
      this.visible = value;
    },
    ensure: () => false,
    // 访问码屏轮询用：与真实 RemoteView 同签名，只读页面类型
    probePage: async () => state.viewPage,
    loadChecked: async (url) => {
      state.loads.push(url);
      return true;
    },
    load: async (url) => {
      state.loads.push(url);
    },
    reload() {
      state.reloads += 1;
    },
    goBack() {},
    goForward() {},
    canGoBack: () => false,
    canGoForward: () => false,
  };

  const controller = new Controller({
    prefs: {
      value: state.prefs,
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
      // 多账号：与生产 `CredentialStore.loadFor` 同签名（按地址 + 账号精确取）
      loadFor: async (address, user) => {
        const list = state.credentialList || (state.credentials ? [state.credentials] : []);
        const norm = (v) => String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
        return list.find((c) => norm(c.address) === norm(address) && String(c.user) === String(user)) || null;
      },
      save: async () => true,
      clear() {
        state.credentials = null;
        state.credentialList = null;
      },
      has: () => Boolean(state.credentials || state.credentialList),
    },
    tofu: { get: () => null, put() {} },
    view,
    cookies: {
      partition: 'persist:zxdesk',
      apply: async (session, target) => {
        state.applied.push({ token: session?.token || '', target });
        return { total: 1, ok: 1 };
      },
      clear: async () => {},
      get: async () => options.cookieList || [],
      names: async () => ['fnos-token'],
      header: async () => options.gatewayCookie ?? 'nasac=ok',
      setSpec: async (spec) => state.applied.push(spec),
    },
    logger: (message) => state.logs.push(String(message)),
    notify: (snapshot) => state.states.push(snapshot),
    fetcher: async (url, init) => {
      if (String(url).endsWith('/app/ticket')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          headers: { getSetCookie: () => ['fnos-token=TICKET-TOKEN; Path=/; Secure'] },
        };
      }
      state.probes.push({ url: String(url), cookie: String(init?.headers?.Cookie || '') });
      return {
        ok: true,
        status: 200,
        text: async () => probeBody(),
        headers: { getSetCookie: () => [] },
      };
    },
    // 模拟 `remoteView.session.fetch`：Cookie 由「分区」自己带，不接受手写 Cookie 头
    probeFetcher: options.withProbeFetcher
      ? async (url, init) => {
          state.partitionProbes.push({
            url: String(url),
            cookieHeader: String(init?.headers?.Cookie || ''),
            appliedBefore: state.applied.length,
          });
          return {
            ok: true,
            status: 200,
            text: async () => probeBody(),
            headers: { getSetCookie: () => [] },
          };
        }
      : undefined,
    rpcFactory: makeRpcFactory(state, {
      onConnect: options.onConnect,
      handler: options.handler || loginHandler,
    }),
    // 多账号：没注入时 controller 会跳过「记账号」（见 accounts 的可选注入）
    accounts: options.accounts || null,
  });
  controller.logPath = '/tmp/boot.log';
  return { controller, state, view };
}

// ---------------------------------------------------------------- 纯函数

test('mergeCookieHeader：同名以后给的为准（浏览器里的续期值覆盖登录快照）', () => {
  assert.equal(mergeCookieHeader('a=1; b=2', 'b=3; c=4'), 'a=1; b=3; c=4');
  assert.equal(mergeCookieHeader('', 'nasac=ok'), 'nasac=ok');
  assert.equal(mergeCookieHeader(null, '', undefined), '');
  assert.equal(mergeCookieHeader('mode=relay', 'mode=relay'), 'mode=relay', '⛔ 不要出现两条同名');
});

test('探针先看 #app：应用页里出现「访问码」三个字也不会被判成访问码页', () => {
  assert.match(PROBE_SCRIPT, /getElementById\('app'\)/, '判据必须先看应用外壳');
  assert.ok(
    PROBE_SCRIPT.indexOf("getElementById('app')") < PROBE_SCRIPT.indexOf('访问码'),
    '顺序反了就会「点一下页面刷新 / 回到登录」（Android 2026-11-02 真机踩到）',
  );
  assert.equal(classifyProbeResult('APP'), GATEWAY_PAGE.APP);
  assert.equal(classifyProbeResult('"ACCESS_CODE"'), GATEWAY_PAGE.ACCESS_CODE);
  assert.equal(classifyProbeResult('LOGIN_REQUIRED'), GATEWAY_PAGE.LOGIN_REQUIRED);
  assert.equal(classifyProbeResult('EMPTY'), GATEWAY_PAGE.UNKNOWN);
  // 旧契约（直接给正文）仍认：测试与老调用不必改
  assert.equal(classifyProbeResult('<html><body>ZXDesk</body></html>'), GATEWAY_PAGE.APP);
  assert.equal(classifyProbeResult('invalid token'), GATEWAY_PAGE.LOGIN_REQUIRED);
});

test('RemoteView：只认本网关的 /login.html，外站与别的路径不拦', () => {
  const webContents = {
    session: { cookies: { set: async () => {}, get: async () => [] } },
    setWindowOpenHandler() {},
    on() {},
    once() {},
    getURL: () => LAN,
    getTitle: () => '',
    executeJavaScript: async () => 'APP',
    loadURL: async () => {},
    reload() {},
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const view = new RemoteView({
    electron: {
      WebContentsView: function Fake() {
        return { webContents, setBounds() {}, setVisible() {} };
      },
      shell: { openExternal: async () => {} },
      session: { fromPartition: () => webContents.session },
    },
    win: { webContents, contentView: { addChildView() {} }, getContentSize: () => [1280, 820], isDestroyed: () => false },
    logger: () => {},
  });
  view.setContext({ baseUrl: LAN, gatewayPath: '/app/zxdesk' });
  assert.equal(view.isGatewayLoginPage(`${LAN}/app/zxdesk/login.html`), true);
  assert.equal(view.isGatewayLoginPage(`${LAN}/app/zxdesk/login.html?ticket=1`), true);
  assert.equal(view.isGatewayLoginPage(`${LAN}/app/zxdesk/`), false);
  assert.equal(view.isGatewayLoginPage('https://other.example.com/app/zxdesk/login.html'), false);
  assert.equal(view.isGatewayLoginPage(`${LAN}/login.html`), false, '飞牛自己的登录页不是本应用的');
});

// ---------------------------------------------------------------- 访问码：登录前被 401 挡下

test('WS 握手被网关 401 ⇒ 进第 ④ 步，⛔ 不是「登录失败」；过完码自动重走登录', async () => {
  const { controller, state } = makeController({
    // 第一次握手被 401（访问码闸门），之后正常
    onConnect: (index) => (index === 1 ? 'access-code' : null),
    gatewayCookie: 'nasac=ok',
  });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  const afterSubmit = controller.getState();
  assert.equal(afterSubmit.screen, 'access', `应该是访问码屏，实际 ${afterSubmit.screen}`);
  assert.notEqual(afterSubmit.connect.error, '登录失败', '⛔ 不能把访问码闸门说成账号密码错');
  assert.equal(afterSubmit.connect.busy, false, 'busy 必须复位，否则「已输入完成」点不动');
  assert.equal(state.saved, null, '还没有会话，访问码过了才谈得上登录');
  assert.match(state.loads.at(-1), /\/app\/zxdesk\/login\.html$/, '访问码页是应用登录页，不是飞牛门户');

  // 用户在视图里过完访问码 → 点「已输入完成」⇒ 重走登录
  await controller.action('access.done');
  assert.equal(controller.getState().screen, 'browsing', state.logs.join(' / '));
  assert.equal(state.handshakes.length, 2, '必须再握一次手（访问码前那次是 401）');
  assert.match(state.handshakes[1].cookie || '', /nasac=ok/, '第二次握手要带上过访问码时种下的凭据');
  assert.equal(state.saved.session.token, 'TOKEN', '会话要落盘');
});

test('访问码屏：探针要连续两次「已进入应用」才继续（滤掉网关的跳转中间页）', async () => {
  const { controller } = makeController({ onConnect: (index) => (index === 1 ? 'access-code' : null) });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  assert.equal(controller.getState().screen, 'access');

  await controller.onProbe('APP');
  assert.equal(controller.getState().screen, 'access', '一次就继续会被中间页骗走');
  await controller.onProbe('UNKNOWN');
  assert.equal(controller.getState().screen, 'access', '认不出就清零，重新数两次');

  await controller.onProbe('APP');
  assert.equal(controller.getState().screen, 'access');
  await controller.onProbe('APP');
  assert.equal(controller.getState().screen, 'browsing', '连续两次才算真的过了访问码');
});

test('过码后网关回 invalid token ⇒ 轮询两次自动重走登录（⛔ 不能停在 invalid token）', async () => {
  const { controller, state } = makeController({ onConnect: (index) => (index === 1 ? 'access-code' : null) });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  assert.equal(controller.getState().screen, 'access');

  // 还在访问码页：轮询多久都不该走（否则用户还没输就跑）
  state.viewPage = GATEWAY_PAGE.ACCESS_CODE;
  await controller.pollAccessPage();
  await controller.pollAccessPage();
  assert.equal(controller.getState().screen, 'access');

  // ⭐ 真机现场：访问码过了，但网关对「没有 fnOS 会话」的请求回纯文本 invalid token。
  // 这一页不会再有加载事件，只能靠轮询；两次确认后必须自己重走登录。
  state.viewPage = GATEWAY_PAGE.LOGIN_REQUIRED;
  await controller.pollAccessPage();
  assert.equal(controller.getState().screen, 'access', '一次只算「疑似」，要连续两次');
  await controller.pollAccessPage();

  assert.equal(controller.getState().screen, 'browsing', state.logs.join(' / '));
  assert.equal(state.handshakes.length, 2, '要重新握一次手（带上过访问码的凭据）');
});

test('访问码屏「返回」：登录前被挡的回连接页，登录后被拦的回应用（⛔ 不是空的两步验证屏）', async () => {
  const before = makeController({ onConnect: (index) => (index === 1 ? 'access-code' : null) });
  await before.controller.boot();
  await before.controller.action('flow.next');
  await before.controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  assert.equal(before.controller.getState().screen, 'access');
  await before.controller.action('flow.back');
  assert.equal(before.controller.getState().screen, 'connect', '登录前没有两步验证可退');

  let afterProbes = 0;
  const after = makeController({
    // 预检（登录前）说「不用访问码」，登录后才被判成访问码页 —— 题面是「登录后被拦」
    probeBody: () => (afterProbes++ === 0 ? APP_HTML : ACCESS_HTML),
  });
  await after.controller.boot();
  await after.controller.action('flow.next');
  await after.controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  assert.equal(after.controller.getState().screen, 'access');
  await after.controller.action('flow.back');
  assert.equal(after.controller.getState().screen, 'browsing', '已有会话就回应用');
});

test('探网关走分区 fetch：Cookie 先落盘、不手拼 Cookie 头（修「登录好几次才进」）', async () => {
  const { controller, state } = makeController({ withProbeFetcher: true });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  assert.equal(controller.getState().screen, 'browsing');

  // 0.2.6 起是三次：① 访问码预检 ② `/app/ticket` 认领 ③ 登录成功后探网关。
  // ② 之所以也必须走分区：`net.fetch` 跑在默认 session 上，**不走分区的 TOFU** ——
  // 局域网自签证书的 NAS 上认领必然失败，页面就只剩 WS 令牌、没有 `fnos-token`（白屏 / invalid token）。
  assert.equal(state.partitionProbes.length, 3, '预检一次 + ticket 认领一次 + 登录后探测一次');
  assert.equal(state.partitionProbes[0].cookieHeader, '', '分区 fetch 由浏览器带 Cookie，⛔ 不手写');
  assert.equal(state.partitionProbes[0].appliedBefore, 0, '预检发生在登录前，不该有会话 Cookie');
  assert.match(state.partitionProbes[1].url, /\/app\/ticket$/, '第二次是 ticket 认领');
  assert.match(state.partitionProbes[1].cookieHeader, /fnos-token=/, '认领要带刚拿到的会话令牌');
  assert.equal(state.partitionProbes[2].cookieHeader, '', '登录后的探测同样不手写 Cookie');
  assert.ok(
    state.partitionProbes[2].appliedBefore >= 1,
    '登录后的探测之前必须先把新会话 Cookie 落进分区，否则探到的是旧会话',
  );
  assert.equal(state.probes.length, 0, '⛔ 不能再用默认 session 的 net.fetch 探（它没有访问码凭据）');
});

test('登录成功后探网关：会话 Cookie 与视图里的网关 Cookie 一起带', async () => {
  const { controller, state } = makeController({ gatewayCookie: 'nasac=ok' });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  assert.equal(controller.getState().screen, 'browsing');
  const probe = state.probes.at(-1);
  assert.ok(probe, '登录后要探一次网关');
  assert.match(probe.cookie, /fnos-token=/, '会话 Cookie 要带（名字以 ticket 换到的那条为准）');
  assert.match(probe.cookie, /nasac=ok/, '网关 Cookie 也要带（否则刚输过访问码又被判成没输）');
});

test('登录后网关仍要访问码 ⇒ 进第 ④ 步；已有会话时「已输入完成」直接进应用', async () => {
  let probes = 0;
  const { controller, state } = makeController({
    // 预检放行 → 登录成功 → 登录后的探测才发现网关又要码（真实场景：码在这中间过期了）
    probeBody: () => (++probes === 2 ? ACCESS_HTML : APP_HTML),
  });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  assert.equal(controller.getState().screen, 'access');
  const handshakesBefore = state.handshakes.length;
  await controller.action('access.done');
  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(state.handshakes.length, handshakesBefore, '已有会话就不该再登一次');
});

// ---------------------------------------------------------------- 静默启动

test('静默启动：没有会话快照但有记住的密码 ⇒ 自动登录，不先给登录表单', async () => {
  const { controller, state } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();

  assert.equal(controller.getState().screen, 'browsing', state.logs.join(' / '));
  assert.ok(state.states.some((s) => s.screen === 'starting'), '要先经过「正在启动…」');
  assert.ok(
    state.logs.some((l) => l.includes('静默启动')),
    `日志要写明是静默自动登录：${state.logs.join(' / ')}`,
  );
  assert.equal(state.saved.session.token, 'TOKEN');
});

test('静默启动：上次是主动「退出登录」⇒ 不自动登回去', async () => {
  const { controller, state } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
    prefs: { signedOut: true },
  });
  await controller.boot();
  assert.equal(controller.getState().screen, 'mode');
  assert.equal(state.handshakes.length, 0, '不该发起任何登录');
  assert.ok(state.logs.some((l) => l.includes('主动退出')));
});

test('主动退出后即便残留会话快照，也不自动进（兜「退出那一下进程被杀」）', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
  });
  const { controller, state } = makeController({ saved, prefs: { signedOut: true } });
  await controller.boot();
  assert.equal(controller.getState().screen, 'connect');
  assert.equal(state.saved, null, '遗留快照要清掉');
  assert.equal(state.loads.length, 0, '不该加载任何页面');
});

test('静默启动：凭据与上次地址 / 账号对不上 ⇒ 不瞎试（⛔ 别把 A 的密码往 B 上撞）', async () => {
  const { controller, state } = makeController({
    credential: { address: '10.1.2.9', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();
  assert.equal(controller.getState().screen, 'mode');
  assert.equal(state.handshakes.length, 0);
});

// ---------------------------------------------------------------- 静默重连

test('会话过期 ⇒ 静默重连：不切屏、换新会话后重载页面', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
  });
  const { controller, state } = makeController({
    saved,
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();
  assert.equal(controller.getState().screen, 'browsing');
  // 前提：这一轮**真的进过应用**（探针判过一次 APP）—— 只有这种「用着用着过期」才走静默口径；
  // 一进来就是 invalid token 的冷启动由 0.2.5 改成回登录页（见 regression-0.2.5.test.js）。
  await controller.onProbe('APP');

  const loadsBefore = state.loads.length;
  await controller.onSessionExpired();

  assert.equal(controller.getState().screen, 'browsing', '静默重连⛔ 不切屏');
  assert.notEqual(state.saved.session.token, 'OLD', '要换成新会话');
  assert.ok(state.loads.length > loadsBefore, 'Cookie 换新后页面要重载一次');
  assert.equal(controller.getState().browsing.error, undefined, '成功时不该留错误');
});

test('静默重连失败 ⇒ 留在浏览页，只在菜单栏提示（⛔ 不把整页甩回登录）', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
  });
  const { controller } = makeController({ saved, credential: null });
  await controller.boot();
  // 同上：进过一次应用 ⇒ 才按「静默重连」处理（不把整页甩回登录）
  await controller.onProbe('APP');
  await controller.onSessionExpired();

  const st = controller.getState();
  assert.equal(st.screen, 'browsing');
  assert.match(st.browsing.error || '', /自动重连失败/);
  assert.equal(controller.getState().connect.error, null, '连接页的红字不该被写上');
});

test('回前台探活：15 秒内只探一次，且用的是视图里当前的 Cookie', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
  });
  const { controller, state } = makeController({ saved, gatewayCookie: 'fnos-token=RENEWED; nasac=ok' });
  await controller.boot();

  const before = state.probes.length;
  await controller.onForeground();
  await controller.onForeground();
  assert.equal(state.probes.length, before + 1, '15 秒内重复回前台只该探一次');
  assert.match(state.probes.at(-1).cookie, /fnos-token=RENEWED/, '必须用视图里续期后的 Cookie');
});

test('页面要跳登录页：有会话时先拦下续会话，没会话才放行', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
  });
  const { controller } = makeController({ saved, credential: null });
  await controller.boot();
  assert.equal(controller.onLoginPageBlocked(), true, '有会话时要拦下来先续');
  // 等这次（注定失败的）静默恢复跑完，避免影响后面的断言
  await new Promise((resolve) => setTimeout(resolve, 20));

  controller.state = { ...controller.state, screen: 'mode' };
  assert.equal(controller.onLoginPageBlocked(), false, '不在浏览页就不要拦');
});

// ---------------------------------------------------------------- 偏好

test('prefs：signedOut 默认 false，坏值归一成 false', () => {
  assert.equal(normalizePrefs({}).signedOut, false);
  assert.equal(normalizePrefs({ signedOut: true }).signedOut, true);
  assert.equal(normalizePrefs({ signedOut: 'yes' }).signedOut, false);
});

test('退出登录会记下 signedOut；重新登录后清掉', async () => {
  const { controller } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();
  assert.equal(controller.getState().screen, 'browsing');
  await controller.action('panel.logout');
  assert.equal(controller.prefs.get().signedOut, true);

  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });
  assert.equal(controller.prefs.get().signedOut, false, '登录成功要清掉「主动退出」标记');
});

// ---------------------------------------------------------------- 0.2.6：访问码的两道闸

/**
 * 访问码 → 重登 → 又被 401，是可以无限转的（照 Android `MAX_ACCESS_CODE_ROUNDS`）。
 * 第三轮停下、回连接页，把「下一步该干什么」写清楚 —— ⛔ 不让界面一直转圈。
 */
test('访问码最多来回两轮：第三轮停下回连接页并写明原因', async () => {
  const { controller } = makeController();
  await controller.boot();
  const entry = new SavedSession({
    address: '10.1.2.3',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
  });

  await controller.showAccessCode(entry);
  assert.equal(controller.getState().screen, 'access', '第 1 轮：正常进访问码页');
  await controller.showAccessCode(entry);
  assert.equal(controller.getState().screen, 'access', '第 2 轮：还能再试');

  await controller.showAccessCode(entry);
  const st = controller.getState();
  assert.equal(st.screen, 'connect', '第 3 轮必须停下，⛔ 不能无限跳');
  assert.match(String(st.connect.notice || ''), /已来回 2 轮/, '要写清已来回几轮');
});

/**
 * 自动判定看的是「页面长相」：中继空壳、网关的「正在校验」过渡页都可能让它攒够次数。
 * 每次都接手就是「跳走 → 401 → 回来 → 再跳走」的死循环，所以整轮只准用一次。
 */
test('访问码自动判定整轮只准用一次（第二次起只认人工点「已输入完成」）', async () => {
  const { controller, state } = makeController();
  await controller.boot();
  const entry = new SavedSession({
    address: '10.1.2.3',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
  });
  await controller.showAccessCode(entry);
  controller.stopAccessPoll();
  // 模拟「这一轮已经自动判过一次」：第二次攒够次数也不该接手
  controller.accessCodeAutoPassed = true;

  await controller.handleAccessProbe(GATEWAY_PAGE.APP);
  await controller.handleAccessProbe(GATEWAY_PAGE.APP);

  assert.equal(controller.getState().screen, 'access', '⛔ 第二次自动判定不能把界面跳走');
  assert.ok(
    state.logs.some((l) => l.includes('自动判定本轮已用过一次')),
    `日志要写明为什么不接手：${state.logs.join(' | ')}`,
  );
});

/**
 * 0.2.6：**没有会话也会拦下跳登录页**（照 Android 0.3.1 第十二条）。
 *
 * 旧代码 `if (!entry?.session?.token) return false` 把「手里没有会话、页面又被要求登录」
 * 这一次直接放过去了 —— 而那恰恰是最该拿本机凭据去换一份回来的时刻。
 */
test('没有会话时也要拦下跳登录页（交给恢复流程自己判）', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: '' },
  });
  const { controller } = makeController({ saved, credential: null });
  await controller.boot();

  assert.equal(controller.onLoginPageBlocked(), true, '没会话的那一次最该续，⛔ 不能放行');
  // 等这次（注定失败的）恢复跑完，避免影响后续用例
  await new Promise((resolve) => setTimeout(resolve, 20));
});

// ---------------------------------------------------------------- 0.2.6：多账号切换

/**
 * 多账号切换：一个窗口只能有一条飞牛会话，所以切换是「换人」而不是「并存」。
 * 口径：一个窗口一条飞牛会话 ⇒ 切换是「换人」——干净地退出 A，用 B 记住的密码重新登进去。
 * ⛔ 不是 `signedOut` 那种「主动退出」：换个人继续用，下次启动当然该自动登进 B。
 */
test('切换账号：清掉当前会话，用目标账号记住的密码自动重登', async () => {
  const remembered = [];
  const accounts = {
    list: () => [{ address: '10.1.2.4', user: 'other', https: true, lastUsedAt: 1 }],
    remember: (item) => remembered.push(item),
  };
  const { controller, state } = makeController({
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
    // 第二台设备 / 另一个账号：切换后要用它自己那份密码重登
    credentialList: [
      { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
      { address: '10.1.2.4', user: 'other', password: 'p@ss-other' },
    ],
    accounts,
  });
  await controller.boot();
  assert.equal(controller.getState().screen, 'browsing', '用例前提：先登进一个账号');

  await controller.switchAccount({ address: '10.1.2.4', user: 'other', https: true });

  const st = controller.getState();
  assert.equal(st.screen, 'browsing', '有记住的密码就该直接登进去');
  assert.equal(controller.prefs.get().lastUser, 'other', '切换后「上次账号」要跟上');
  assert.equal(controller.prefs.get().signedOut, false, '⛔ 不能把切换记成「主动退出」');
  assert.ok(remembered.some((x) => x.user === 'other'), '登录成功要把账号记进清单');
  assert.ok(state.logins >= 2, '应该真的重登了一次');
});

test('切换账号：目标账号没记住密码 ⇒ 停在表单上让人补，⛔ 不拿空密码撞风控', async () => {
  const accounts = { list: () => [], remember() {} };
  const { controller } = makeController({
    credential: { address: '10.1.2.4', user: 'other', password: 'p@ss' },
    accounts,
  });
  await controller.boot();

  await controller.switchAccount({ address: '10.1.2.5', user: 'third', https: true });

  const st = controller.getState();
  assert.equal(st.screen, 'connect', '没密码就停在连接页');
  assert.match(String(st.connect.notice || ''), /请补充密码/);
  assert.equal(st.connect.user, 'third');
  assert.equal(st.connect.address, '10.1.2.5');
});

test('切换账号：地址或账号为空 ⇒ ⛔ 不发起登录，但日志要写明原因', async () => {
  const { controller, state } = makeController();
  await controller.boot();
  const before = state.logins;
  await controller.switchAccount({ address: '', user: 'x' });

  assert.equal(state.logins, before, '空地址不该发起登录');
  assert.ok(
    state.logs.some((l) => l.includes('切换账号被拒')),
    `静默返回不行，日志要能看出为什么没动：${state.logs.join(' | ')}`,
  );
});

// ---------------------------------------------------------------- 0.2.6：网页会话（zxdesk_sid）

/**
 * 「ZXDesk 工作台的登录没有记住，每次都要重新登录」：两处一起坏才会这样。
 *
 * ① 抓不到 —— ZXDesk 账号登录是页面里的 XHR，成功后不整页导航，`onProbe` 不会再跑；
 * ② 回注被早退挡住 —— `session.token` 为空时（8990 直连 / 只过码没登录）整段 `applySessionCookies` 直接 return。
 */
test('没有飞牛会话时也要回注 zxdesk_sid（8990 直连 / 只过码没登录）', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    user: 'myaccount',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: '' },
    webSession: {
      name: 'zxdesk_sid',
      value: 'SID-VALUE',
      host: '10.1.2.3',
      domain: '10.1.2.3',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      savedAt: 1,
    },
  });
  const { controller, state } = makeController({ saved });
  await controller.boot();

  const injected = state.applied.filter((item) => item && item.name === 'zxdesk_sid');
  assert.equal(injected.length, 1, '网页会话必须回注（否则每次启动都要重登 ZXDesk 账号）');
  assert.equal(injected[0].value, 'SID-VALUE');
});

test('网页会话 host 对不上就不回注（换 NAS ⛔ 不能把 A 的会话带过去）', async () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
    webSession: {
      name: 'zxdesk_sid',
      value: 'SID-A',
      host: '10.1.2.9', // 另一台设备
      domain: '10.1.2.9',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      savedAt: 1,
    },
  });
  const { controller, state } = makeController({ saved });
  await controller.boot();
  assert.equal(
    state.applied.filter((item) => item && item.name === 'zxdesk_sid').length,
    0,
    'host 不匹配⛔ 不该注入',
  );
});

// ---------------------------------------------------------------- 0.2.6：切换账号弹窗

/**
 * 切换账号的界面是一个弹窗，两个入口：连接页账号框右侧的「切换」按钮与菜单「文件 → 切换账号」。
 * 弹窗里除了挑已有账号，还要能新增账号。两个入口共用同一个 `state.accounts`。
 */
test('切换账号弹窗：打开后带着账号清单，并先把远程视图藏起来', async () => {
  const accounts = {
    list: () => [
      { address: '10.1.2.3', user: 'myaccount', https: true, lastUsedAt: 2 },
      { address: '10.1.2.4', user: 'other', https: true, lastUsedAt: 1 },
    ],
    remember() {},
  };
  const { controller, view } = makeController({ accounts, credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' } });
  await controller.boot();
  assert.equal(controller.getState().screen, 'browsing', '用例前提：在浏览页');
  view.visible = true;

  controller.openAccounts();

  const acc = controller.getState().accounts;
  assert.ok(acc, '弹窗要打开');
  assert.equal(acc.items.length, 2);
  assert.equal(acc.items[0].user, 'myaccount');
  assert.equal(acc.adding, false, '已有账号时不自动展开新增表单');
  assert.equal(view.visible, false, '⛔ 不藏视图的话弹窗会被 WebContentsView 整个盖住');
});

test('切换账号弹窗：清单为空时直接展开「新增账号」表单（⛔ 不给空列表）', async () => {
  const { controller } = makeController({ accounts: { list: () => [], remember() {} } });
  await controller.boot();
  controller.openAccounts();
  assert.equal(controller.getState().accounts.adding, true);
  assert.equal(controller.getState().accounts.form.address, '', '新增的通常是另一台设备，地址不预填');
});

test('切换账号弹窗：关闭后回到网页要把视图放回来', async () => {
  const { controller, view } = makeController({ accounts: { list: () => [], remember() {} }, credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' } });
  await controller.boot();
  view.visible = true;
  controller.openAccounts();
  assert.equal(view.visible, false);
  controller.closeAccounts();
  assert.equal(controller.getState().accounts, null);
  assert.equal(view.visible, true, '关掉弹窗要能继续看网页');
});

test('切换账号弹窗：新增账号没填全会留在弹窗里报错（⛔ 不踢回连接页）', async () => {
  const accounts = { list: () => [], remember() {} };
  const { controller } = makeController({ accounts, credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' } });
  await controller.boot();
  controller.openAccounts();
  await controller.addAccount({ address: '10.1.2.9', user: 'someone', password: '' });

  const acc = controller.getState().accounts;
  assert.ok(acc, '弹窗不能被关掉');
  assert.match(String(acc.error || ''), /地址、账号、密码/);
  assert.equal(controller.getState().screen, 'browsing', '屏幕不该被切走');
});

test('切换账号弹窗：填全了就关窗并按这个账号登录', async () => {
  const remembered = [];
  const accounts = { list: () => [], remember: (x) => remembered.push(x) };
  const { controller, state } = makeController({ accounts, credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' } });
  await controller.boot();

  controller.openAccounts();
  await controller.addAccount({ address: '10.1.2.9', user: 'someone', password: 'p@ss', https: true });

  const st = controller.getState();
  assert.equal(st.accounts, null, '提交后弹窗要收起来（接下来要建视图 / 可能要弹证书）');
  assert.equal(st.screen, 'browsing', '有密码就该直接登进去');
  assert.equal(controller.prefs.get().lastUser, 'someone');
  assert.ok(state.logins >= 2, '应该真的登录了一次');
  assert.ok(remembered.some((x) => x.user === 'someone'), '登录成功要记进账号清单');
});

test('切换账号弹窗：切屏时自动收起（不许挂在别的屏上）', async () => {
  const { controller } = makeController({ accounts: { list: () => [], remember() {} } });
  await controller.boot();
  controller.openAccounts();
  assert.ok(controller.getState().accounts);

  controller.showConnect('测试');
  assert.equal(controller.getState().accounts, null, 'showConnect 要清掉弹窗');
});

test('账号清单为空时菜单给一条说明，不留空子菜单', () => {
  const { controller } = makeController();
  assert.deepEqual(controller.menuAccounts(), [], '没注入账号清单时给空数组');
});
