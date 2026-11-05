/**
 * 0.2.5 全量体检里修掉的**隐形缺陷**（登录 / 更新两条主链路）。
 *
 * 这些都不是「功能没做」，而是「功能看着在、实际从没生效 / 在某个时序下会卡住」：
 * 1. 会话快照里没写账号 ⇒ 记住的密码从来没被用来自动重连（`recoverWithPassword` 永远不匹配）；
 * 2. 冷启动撞上失效会话 ⇒ 停在只有一行 `invalid token` 的白页上，出口只在菜单里；
 * 3. 自动重连正在跑时点「退出登录」⇒ 重连完成后把人送回主界面，还把 signedOut 改回 false；
 * 4. 首次连接自签证书：页面与登录探测并发询问 ⇒ 确认屏卡住 / 第二个等待者永不落地；
 * 5. 更新包下好之后再「检查更新」⇒ `filePath` 被清空，150 MB 白下；
 * 6. 下载中打开更新窗口 ⇒ 会被一次检查打断（阶段与进度一起被冲掉）；
 * 7. 换连另一台 NAS ⇒ 沿用上一台的 secret / longToken。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Controller } from '../src/main/controller.js';
import { openEnvelope } from '../src/main/login/crypto.js';
import { NoticeService } from '../src/main/notice.js';
import { normalizePrefs } from '../src/main/store/prefs.js';
import { SavedSession } from '../src/main/store/session.js';
import { UpdateService } from '../src/main/update/service.js';
import { rawTransport, startRawServer } from './helpers/raw-http.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const LAN = 'https://10.1.2.3:64999';
const APP_HTML = '<!doctype html><html><body><div id="app">ZXDesk</div></body></html>';

/** 假 WS：够 FnLoginFlow 跑完 user.login（拿 token + ticket）。 */
function makeRpcFactory(state) {
  return () => ({
    isConnected: false,
    async connect() {
      this.isConnected = true;
    },
    async call(json, reqid) {
      const cut = json.indexOf('{');
      const body = cut > 0 ? json.slice(cut) : json;
      let parsed = JSON.parse(body);
      if (parsed.req === 'encrypted') parsed = JSON.parse(openEnvelope(body, privateKey).inner);
      state.calls.push(parsed.req);
      if (parsed.req === 'util.crypto.getRSAPub') {
        return { reqid, result: 'succ', pub: publicKey, si: '748918410105123456' };
      }
      if (parsed.req === 'user.login' || parsed.req === 'user.tokenLogin') {
        state.logins += 1;
        return { reqid, result: 'succ', token: `TOKEN-${state.logins}`, ticket: 'TCK' };
      }
      return { reqid, result: 'succ', data: {} };
    },
    close() {
      this.isConnected = false;
    },
  });
}

function makeController(options = {}) {
  const state = {
    saved: options.saved || null,
    credential: options.credential || null,
    loads: [],
    applied: [],
    logs: [],
    states: [],
    calls: [],
    partitionProbes: [],
    logins: 0,
    prefs: normalizePrefs({
      lastAddress: '10.1.2.3',
      lastUser: 'myaccount',
      ...(options.prefs || {}),
    }),
  };

  const view = {
    visible: false,
    context: null,
    setContext(context) {
      this.context = context;
    },
    setVisible(value) {
      this.visible = Boolean(value);
    },
    ensure: () => false,
    probePage: async () => 'APP',
    loadChecked: async (url) => {
      state.loads.push(url);
      return true;
    },
    load: async (url) => {
      state.loads.push(url);
    },
    reload() {},
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
      load: async () => state.credential,
      save: async () => true,
      clear() {
        state.credential = null;
      },
      has: () => Boolean(state.credential),
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
      get: async () => [],
      names: async () => ['fnos-token'],
      header: async () => '',
      setSpec: async () => {},
    },
    logger: (message) => state.logs.push(String(message)),
    notify: (snapshot) => state.states.push(snapshot),
    fetcher: async (url) => {
      if (String(url).endsWith('/app/ticket')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          headers: { getSetCookie: () => ['fnos-token=TICKET-TOKEN; Path=/; Secure'] },
        };
      }
      return { ok: true, status: 200, text: async () => APP_HTML, headers: { getSetCookie: () => [] } };
    },
    // 分区 fetch（生产是 `remoteView.session.fetch`）：afterAuth / 探活走这条
    probeFetcher: async (url, init) => {
      state.partitionProbes.push({ url: String(url), cookieHeader: String(init?.headers?.Cookie || '') });
      if (options.beforeProbeResponse) await options.beforeProbeResponse();
      return { ok: true, status: 200, text: async () => options.probeBody || APP_HTML, headers: { getSetCookie: () => [] } };
    },
    rpcFactory: makeRpcFactory(state),
    updater: options.updater || null,
  });
  controller.logPath = '/tmp/boot.log';
  return { controller, state, view };
}

function savedSession(overrides = {}) {
  return new SavedSession({
    address: '10.1.2.3',
    baseUrl: LAN,
    flow: 'GATEWAY',
    gatewayPath: '/app/zxdesk',
    session: { token: 'OLD' },
    ...overrides,
  });
}

// ---------------------------------------------------------------- 1. 快照里要带账号

test('登录成功后会话快照写进账号（否则「记住的密码」永远匹配不上）', async () => {
  const { controller, state } = makeController();
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(state.saved.user, 'myaccount', '快照必须记住这次登录用的账号');
});

test('旧快照没有账号（0.2.4 及以前）⇒ 按地址匹配也要能用记住的密码重连', async () => {
  const { controller, state } = makeController({
    saved: savedSession(), // 注意：没有 user
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();
  await controller.onProbe('APP');
  await controller.onSessionExpired();

  assert.notEqual(state.saved.session.token, 'OLD', '要用记住的密码换到新会话');
  assert.equal(state.saved.user, 'myaccount', '顺手把账号补进快照，下次就不用再猜');
  assert.equal(controller.getState().screen, 'browsing');
  assert.ok(state.logs.some((l) => l.includes('按地址匹配')));
});

// ---------------------------------------------------------------- 2. 冷启动白屏

test('冷启动撞上失效会话（本轮没进过应用）⇒ 回登录页并说明，⛔ 不把人钉在 invalid token 白页上', async () => {
  const { controller, state } = makeController({
    saved: savedSession({ user: 'myaccount' }),
    credential: null, // 没记住密码：无从静默恢复
  });
  await controller.boot();
  assert.equal(controller.getState().screen, 'browsing');

  // 页面一加载完就是纯文本 invalid token（探针判 LOGIN_REQUIRED）
  await controller.onProbe('LOGIN_REQUIRED');

  const st = controller.getState();
  assert.equal(st.screen, 'connect', '必须给出可点的出口');
  assert.match(st.connect.notice, /登录状态已失效/);
  assert.equal(st.connect.error, '登录失败');
  assert.equal(state.saved, null, '失效快照要清掉，别下次开机再撞一次');
});

test('进过应用之后再过期 ⇒ 仍走静默重连（不切屏）', async () => {
  const { controller } = makeController({
    saved: savedSession({ user: 'myaccount' }),
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();
  await controller.onProbe('APP'); // 这一轮真的进过应用
  await controller.onProbe('LOGIN_REQUIRED');

  assert.equal(controller.getState().screen, 'browsing', '用着用着过期不该被踢走');
});

// ---------------------------------------------------------------- 3. 退出登录 vs 在飞的恢复

test('自动重连在飞时点「退出登录」⇒ 重连结果作废，不被送回主界面', async () => {
  let logoutDone = false;
  const { controller, state } = makeController({
    saved: savedSession({ user: 'myaccount' }),
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
    // 恢复流程跑到「探一下新会话有没有生效」这一步时，模拟用户点了退出
    beforeProbeResponse: async () => {
      if (logoutDone) return;
      logoutDone = true;
      await controller.action('panel.logout');
    },
  });
  await controller.boot();
  await controller.onProbe('APP');
  await controller.onSessionExpired();

  const st = controller.getState();
  assert.equal(logoutDone, true, '用例前提：退出确实发生在恢复过程中');
  assert.equal(st.screen, 'connect', '退出之后⛔ 不能再被送回浏览模式');
  assert.equal(st.browsing, null);
  // prefs 每次 patch 都会换一个新对象（生产是同义实现），所以要从 controller 读
  assert.equal(controller.prefs.get().signedOut, true, '「主动退出」的标记⛔ 不能被恢复结果改回 false');
  assert.equal(state.saved, null, '会话快照要保持被清掉的状态');
  assert.ok(state.logs.some((l) => l.includes('登录结果已作废')), `日志：${state.logs.join(' | ')}`);
});

// ---------------------------------------------------------------- 4. 证书确认并发

test('同一台设备的证书被并发询问 ⇒ 只弹一次，两个等待者一起放行', async () => {
  const { controller } = makeController();
  await controller.boot();

  const first = controller.requestTrust('10.1.2.3', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'AA:BB' });
  const second = controller.requestTrust('10.1.2.3', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'AA:BB' });

  assert.equal(controller.getState().screen, 'cert');
  assert.equal(controller.certWaiters.length, 1, '同一份指纹只该有一个等待者');

  controller.decideCert(true);
  assert.equal(await first, true);
  assert.equal(await second, true, '第二个等待者不能永远挂着');
  assert.notEqual(controller.getState().screen, 'cert', '⛔ 不能停在空白的证书屏上');
  assert.equal(controller.certWaiters.length, 0);
});

test('两台设备同时等确认 ⇒ 确认完第一台接着弹第二台', async () => {
  const { controller } = makeController();
  await controller.boot();

  const a = controller.requestTrust('nas-a', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'AA:BB' });
  const b = controller.requestTrust('nas-b', { subjectText: 'CN=fnOS,O=fnOS', fingerprint256: 'CC:DD' });
  assert.equal(controller.getState().cert.host, 'nas-a');

  controller.decideCert(true);
  assert.equal(await a, true);
  assert.equal(controller.getState().screen, 'cert', '第二台还没确认，屏要留着');
  assert.equal(controller.getState().cert.host, 'nas-b');

  controller.decideCert(false);
  assert.equal(await b, false);
  assert.equal(controller.getState().screen, 'mode', '都处理完回到进入证书屏之前的屏');
  assert.equal(controller.getState().cert, null);
});

// ---------------------------------------------------------------- 5. 换 NAS 不继承凭据

test('换连另一台 NAS ⇒ 不沿用上一台的 secret / longToken', async () => {
  const previous = savedSession({
    baseUrl: 'https://10.1.2.9:64999',
    session: { token: 'OLD', secret: 'OLDSECRET', longToken: 'OLD-LONG' },
  });
  const { controller, state } = makeController({ saved: previous });
  await controller.boot();
  await controller.action('flow.next');
  await controller.action('connect.submit', { address: '10.1.2.3', https: true, user: 'myaccount', password: 'p@ss' });

  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(state.saved.session.secret, null, '上一台的 secret 不能跟过来');
  assert.equal(state.saved.session.longToken, null, '上一台的 longToken 不能跟过来');
});

test('同一台设备重登 ⇒ secret / longToken 仍要保住（tokenLogin 换来的会话不一定再给）', async () => {
  const previous = savedSession({ session: { token: 'OLD', secret: 'KEEPME', longToken: 'KEEP-LONG' } });
  const { controller, state } = makeController({
    saved: previous,
    credential: { address: '10.1.2.3', user: 'myaccount', password: 'p@ss' },
  });
  await controller.boot();
  await controller.onProbe('APP');
  await controller.onSessionExpired();

  assert.equal(state.saved.session.secret, 'KEEPME');
  assert.equal(state.saved.session.longToken, 'KEEP-LONG');
});

// ---------------------------------------------------------------- 6. 更新：已下好的包不能被一次检查弄丢

const CURRENT = '0.2.4';

function updatePayload(overrides = {}) {
  return {
    ok: true,
    data: {
      platform: 'windows',
      channel: 'stable',
      version: '0.2.5',
      hash: '',
      fileName: 'zxdesk-windows-0.2.5-x64-setup.exe',
      fileSize: 0,
      downloadUrls: [],
      releaseNotes: '修了几处',
      force: false,
      minVersion: '',
      ...overrides,
    },
  };
}

function makeService(t, { body, server }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-0.2.5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new UpdateService({
    currentVersion: CURRENT,
    apiUrl: 'http://127.0.0.1:9/api/version/windows',
    channel: 'stable',
    dir,
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => body() }),
    transport: rawTransport,
    probeTimeoutMs: 400,
    log: () => {},
  });
  return { service, dir, server };
}

test('更新包下好之后再检查一次 ⇒ 仍是「已就绪」，不重下 150 MB', async (t) => {
  const bytes = Buffer.from('setup-bytes-0.2.5');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  /** 只数「真下载」的请求：探测会先发一个 `Range: bytes=0-0`，那不是下包。 */
  let downloads = 0;
  const server = await startRawServer((req, res) => {
    if (req.url === '/pkg.exe' && !req.headers.range) downloads += 1;
    res.writeHead(200, {});
    res.end(bytes);
  });
  t.after(() => server.close());

  const body = () =>
    updatePayload({ hash, fileSize: bytes.length, downloadUrls: [`${server.url}/pkg.exe`] });
  const { service } = makeService(t, { body, server });

  await service.check();
  await service.download();
  const ready = service.snapshot();
  assert.equal(ready.phase, 'ready');
  assert.equal(downloads, 1);

  // 用户关掉窗口，再从菜单点「检查更新」（openUpdate → check）
  await service.check();
  const again = service.snapshot();
  assert.equal(again.phase, 'ready', '已下好的包要认回来');
  assert.equal(again.filePath, ready.filePath);
  assert.equal(again.progress.percent, 100);
  assert.equal(service.downloadedFile(), ready.filePath);
  assert.equal(downloads, 1, '⛔ 不能因为一次检查就重下');
});

test('下载进行中再检查 ⇒ 不动阶段与进度（窗口关掉重开就是这条路径）', async (t) => {
  const bytes = Buffer.from('setup-bytes');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const server = await startRawServer((_req, res) => {
    res.writeHead(200, {});
    res.end(bytes);
  });
  t.after(() => server.close());

  const { service } = makeService(t, {
    body: () => updatePayload({ hash, fileSize: bytes.length, downloadUrls: [`${server.url}/pkg.exe`] }),
    server,
  });
  await service.check();
  // 模拟「下载在飞」：pendingDownload 非空就是 service 眼里的下载中
  service.pendingDownload = new Promise(() => {});
  service.state = { ...service.state, phase: 'downloading', progress: { received: 4, total: bytes.length, percent: 10 } };

  await service.check();
  const state = service.snapshot();
  assert.equal(state.phase, 'downloading');
  assert.equal(state.progress.percent, 10, '进度不能被一次检查清掉');
});

test('包被删了 ⇒ 界面退回收「下载更新」，⛔ 停在「已就绪」骗人', async () => {
  const updater = {
    snapshot: () => ({
      phase: 'ready',
      current: CURRENT,
      latest: '0.2.5',
      available: true,
      mustUpdate: false,
      notes: '',
      progress: { received: 100, total: 100, percent: 100 },
      filePath: '/tmp/gone.exe',
      error: null,
    }),
    downloadedFile: () => '',
  };
  const { controller } = makeController({ updater });
  const update = controller.getState().update;
  assert.equal(update.phase, 'available');
  assert.equal(update.progress, null);
});

// ---------------------------------------------------------------- 7. 公告缓存的时间戳

test('公告缓存里的 updated 是这一批的，不是上一批的', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notices-cache.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, updated: 'OLD', marquee: '', items: [] }), 'utf8');

  const service = new NoticeService({
    apiUrl: 'https://api.example.com/api/notices/windows',
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, updated: 'NEW', marquee: '', data: [{ id: 'n1', title: '公告' }] }),
    }),
    file,
    log: () => {},
  });
  service.loadCache();
  await service.check();

  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cache.updated, 'NEW', '写缓存要用这一批的 updated');
  assert.equal(cache.items.length, 1);
});
