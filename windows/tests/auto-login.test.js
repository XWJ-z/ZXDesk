/**
 * 0.1.6：ZXDesk 网页会话（`zxdesk_sid`）的加密保存 / 回注 / 开关。
 *
 * 服务端把它做成会话级 Cookie（飞牛账号与 ZXDesk 账号是两套，持久化会把上一个 ZXDesk 账号
 * 带过来）。客户端只为「桌面免登录」在本机加密保存这一条，并在**同一 host** 回注。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { pickWebSession, webSessionSpec } from '../src/main/browser/cookies.js';
import { Controller } from '../src/main/controller.js';
import { normalizePrefs } from '../src/main/store/prefs.js';
import { SavedSession } from '../src/main/store/session.js';
import { shortcutNeedsRepair, shortcutOperation, shortcutOptions, shortcutPaths } from '../src/main/store/shortcuts.js';

const SID = {
  name: 'zxdesk_sid',
  value: 'SID-VALUE',
  host: 'my-nas.fnos.net',
  domain: 'my-nas.fnos.net',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  savedAt: 1,
};

// ---------------------------------------------------------------- 快照

test('webSession 能往返（只认 zxdesk_sid）', () => {
  const saved = new SavedSession({ baseUrl: 'https://my-nas.fnos.net', webSession: SID });
  const back = SavedSession.fromJSON(JSON.stringify(saved.toJSON()));
  assert.equal(back.webSession.value, 'SID-VALUE');
  assert.equal(back.webSession.host, 'my-nas.fnos.net');
});

test('webSession 坏值一律当没有（别的 Cookie 名 / 没 host / 空值）', () => {
  assert.equal(new SavedSession({ baseUrl: 'https://a', webSession: { ...SID, name: 'fnos-token' } }).webSession, null);
  assert.equal(new SavedSession({ baseUrl: 'https://a', webSession: { ...SID, host: '' } }).webSession, null);
  assert.equal(new SavedSession({ baseUrl: 'https://a', webSession: { ...SID, value: '' } }).webSession, null);
});

test('startUrl：有网页会话就直奔应用根，不再进 login.html', () => {
  const saved = new SavedSession({ baseUrl: 'https://my-nas.fnos.net', flow: 'GATEWAY', webSession: SID, session: { token: 'T' } });
  assert.equal(saved.startUrl(), 'https://my-nas.fnos.net/app/zxdesk/');
});

test('startUrl：没有网页会话仍走 login.html', () => {
  const saved = new SavedSession({ baseUrl: 'https://my-nas.fnos.net', flow: 'GATEWAY', session: { token: 'T' } });
  assert.equal(saved.startUrl(), 'https://my-nas.fnos.net/app/zxdesk/login.html');
});

// ---------------------------------------------------------------- Cookie 拾取 / 回注

test('pickWebSession：只挑 zxdesk_sid，带齐 host 与属性', () => {
  const list = [
    { name: 'fnos-token', value: 'T', domain: 'my-nas.fnos.net' },
    { name: 'zxdesk_sid', value: 'V', domain: 'my-nas.fnos.net', path: '/', secure: true, httpOnly: true, sameSite: 'strict' },
  ];
  const picked = pickWebSession(list, 'https://my-nas.fnos.net/app/zxdesk/');
  assert.equal(picked.name, 'zxdesk_sid');
  assert.equal(picked.host, 'my-nas.fnos.net');
  assert.equal(picked.sameSite, 'strict');
  assert.equal(picked.httpOnly, true);
});

test('pickWebSession：没有 sid 就 null（⛔ 不拿别的 Cookie 凑数）', () => {
  assert.equal(pickWebSession([{ name: 'fnos-token', value: 'T' }], 'https://a.example.com'), null);
  assert.equal(pickWebSession([], 'https://a.example.com'), null);
});

test('webSessionSpec：host 一致才回注，且是会话级（不给过期时间）', () => {
  const spec = webSessionSpec(SID, { baseUrl: 'https://my-nas.fnos.net/app/zxdesk/' });
  assert.equal(spec.name, 'zxdesk_sid');
  assert.equal(spec.value, 'SID-VALUE');
  assert.equal(spec.expirationDate, undefined, '会话级：不能给过期时间');
  assert.equal(spec.httpOnly, true);
  assert.equal(spec.sameSite, 'lax');
});

test('webSessionSpec：host 不一致就不回注（LAN 与中继是两个 host）', () => {
  assert.equal(webSessionSpec(SID, { baseUrl: 'https://10.1.2.3:64999/app/zxdesk/' }), null);
  assert.equal(webSessionSpec(SID, { baseUrl: 'https://other.example.com/app/zxdesk/' }), null);
  // 同一个 host、只是端口/协议不同 ⇒ 仍然回注（服务端按 host 认会话）
  assert.ok(webSessionSpec(SID, { baseUrl: 'http://my-nas.fnos.net:8990' }));
});

test('webSessionSpec：大小写不影响 host 比较', () => {
  const spec = webSessionSpec({ ...SID, host: 'MY-NAS.FNOS.NET' }, { baseUrl: 'https://my-nas.fnos.net' });
  assert.ok(spec);
});

// ---------------------------------------------------------------- 控制器：回注 / 捕获 / 开关

function makeController(options = {}) {
  const state = { saved: options.saved || null, loads: [], saves: 0, logs: [], applied: [] };
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
      return true;
    },
    reload() {},
    goBack() {},
    goForward() {},
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const controller = new Controller({
    prefs: {
      value: { ...normalizePrefs({}), ...(options.prefs || {}) },
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
        state.saves += 1;
        return true;
      },
      clear() {
        state.saved = null;
      },
      has: () => Boolean(state.saved),
    },
    credentials: { load: async () => null, save: async () => true, clear() {}, has: () => false },
    tofu: { get: () => null, put() {} },
    view,
    cookies: {
      partition: 'persist:zxdesk',
      apply: async () => ({ total: 2, ok: 2 }),
      names: async () => ['fnos-token'],
      clear: async () => {},
      get: options.cookieList ? async () => options.cookieList : undefined,
      setSpec: async (spec) => state.applied.push(spec),
    },
    logger: (m) => state.logs.push(m),
    notify: () => {},
    fetcher: async () => ({ ok: true, status: 200, text: async () => '<html>ok</html>', headers: { getSetCookie: () => [] } }),
  });
  return { controller, state };
}

test('boot：autoLogin 开着且有网页会话 ⇒ 直接加载应用根', async () => {
  const saved = new SavedSession({
    baseUrl: 'https://my-nas.fnos.net',
    flow: 'GATEWAY',
    relayHost: 'my-nas.fnos.net',
    session: { token: 'T' },
    webSession: SID,
  });
  const { controller, state } = makeController({ saved });
  await controller.boot();
  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(state.loads[0], 'https://my-nas.fnos.net/app/zxdesk/');
  assert.ok(state.applied.some((spec) => spec && spec.name === 'zxdesk_sid'), '应该回注 zxdesk_sid');
});

test('boot：autoLogin 关掉 ⇒ 进连接页并说明，快照不删', async () => {
  const saved = new SavedSession({ baseUrl: 'https://my-nas.fnos.net', flow: 'GATEWAY', session: { token: 'T' }, webSession: SID });
  const { controller, state } = makeController({ saved, prefs: { autoLogin: false } });
  await controller.boot();
  assert.equal(controller.getState().screen, 'connect');
  assert.match(controller.getState().connect.notice, /自动登录已关闭/);
  assert.equal(state.loads.length, 0, '不该加载任何页面');
  assert.ok(state.saved, '快照要留着');
});

test('捕获：页面里有 zxdesk_sid 就存进快照；没有就不写', async () => {
  const makeSaved = () =>
    new SavedSession({ baseUrl: 'https://my-nas.fnos.net', flow: 'GATEWAY', session: { token: 'T' } });
  const withSid = makeController({
    saved: makeSaved(),
    cookieList: [{ name: 'zxdesk_sid', value: 'NEW', domain: 'my-nas.fnos.net', secure: true }],
  });
  await withSid.controller.boot();
  await withSid.controller.captureWebSession();
  assert.equal(withSid.state.saved.webSession.value, 'NEW');

  const noSid = makeController({ saved: makeSaved(), cookieList: [{ name: 'fnos-token', value: 'T' }] });
  await noSid.controller.boot();
  const before = noSid.state.saves;
  await noSid.controller.captureWebSession();
  assert.equal(noSid.state.saves, before, '没有 sid 不该写盘');
  assert.equal(noSid.state.saved.webSession, null);
});

test('退出登录：快照（含网页会话）一起清掉', async () => {
  const saved = new SavedSession({ baseUrl: 'https://my-nas.fnos.net', flow: 'GATEWAY', session: { token: 'T' }, webSession: SID });
  const { controller, state } = makeController({ saved });
  await controller.boot();
  await controller.action('panel.logout');
  assert.equal(state.saved, null, '退出后不该还留着带 zxdesk_sid 的快照');
});

// ---------------------------------------------------------------- 偏好与快捷方式

test('prefs：autoLogin 默认开、closeToTray 默认关，坏值归一', () => {
  const prefs = normalizePrefs({});
  assert.equal(prefs.autoLogin, true);
  assert.equal(prefs.closeToTray, false);
  assert.equal(normalizePrefs({ autoLogin: false, closeToTray: true }).autoLogin, false);
  assert.equal(normalizePrefs({ autoLogin: false, closeToTray: true }).closeToTray, true);
});

test('快捷方式路径：桌面与启动文件夹，用同一个 .lnk 名字', () => {
  const paths = shortcutPaths({ desktopDir: 'C:\\Users\\x\\Desktop', appDataDir: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.ok(paths.desktop.endsWith('ZXDesk 工作台.lnk'));
  assert.ok(paths.startup.endsWith('ZXDesk 工作台.lnk'));
  assert.ok(paths.startup.includes('Startup'), `启动文件夹路径不对：${paths.startup}`);
  assert.ok(paths.startupDir.includes('Microsoft'));
});

test('快捷方式参数：目标 = 当前 exe、cwd = exe 目录、带图标；有则 update 否则 create', () => {
  const options = shortcutOptions({ exePath: 'D:\\Apps\\ZXDesk\\ZXDesk.exe', cwd: 'D:\\Apps\\ZXDesk', iconPath: 'D:\\Apps\\ZXDesk\\icon.ico' });
  assert.equal(options.target, 'D:\\Apps\\ZXDesk\\ZXDesk.exe');
  assert.equal(options.cwd, 'D:\\Apps\\ZXDesk');
  assert.equal(options.icon, 'D:\\Apps\\ZXDesk\\icon.ico');
  assert.equal(shortcutOperation(false), 'create');
  assert.equal(shortcutOperation(true), 'update');
});

// ---------------------------------------------------------------- 0.1.6 收尾修复（不升号）

test('startUrl：直连 8990 + 有网页会话 ⇒ 也直奔应用根（顺序不能反）', () => {
  const saved = new SavedSession({
    baseUrl: 'http://10.1.2.3:8990',
    flow: 'DIRECT',
    gatewayPath: '/app/zxdesk',
    webSession: { ...SID, host: '10.1.2.3' },
  });
  assert.equal(saved.startUrl(), 'http://10.1.2.3:8990/app/zxdesk/');
  // 没有会话时直连仍走登录页（这条没被改坏）
  const plain = new SavedSession({ baseUrl: 'http://10.1.2.3:8990', flow: 'DIRECT', gatewayPath: '/app/zxdesk' });
  assert.equal(plain.startUrl(), 'http://10.1.2.3:8990/app/zxdesk/login.html');
});

test('onProbe(UNKNOWN) 也会捕获网页会话（0.1.6 自动登录从没生效的根因）', async () => {
  const makeSaved = () =>
    new SavedSession({ baseUrl: 'https://my-nas.fnos.net', flow: 'GATEWAY', session: { token: 'T' } });
  const { controller, state } = makeController({
    saved: makeSaved(),
    cookieList: [{ name: 'zxdesk_sid', value: 'FROM-SPA', domain: 'my-nas.fnos.net', secure: true }],
  });
  await controller.boot();
  // boot 里的加载成功也会捕获一次；这里清掉，专门验「探针 UNKNOWN 这条路」
  controller.entry = state.saved; // 正常由 enterBrowsing 赋值
  controller.entry.webSession = null;
  state.saved.webSession = null;
  state.logs.length = 0;
  const savesBefore = state.saves;
  await controller.onProbe('UNKNOWN');
  await new Promise((resolve) => setTimeout(resolve, 10)); // captureWebSession 是 void 调用
  assert.equal(state.saved.webSession?.value, 'FROM-SPA', `UNKNOWN 时也要捕获：${state.logs.join(' / ')}`);
  assert.ok(state.saves > savesBefore, '捕获后要落盘');
  assert.ok(state.logs.some((l) => l.includes('Web 会话捕获：有')), state.logs.join(' / '));
});

test('boot：快照里存什么就连什么（FNID 不再猜局域网地址）', async () => {
  const saved = new SavedSession({
    baseUrl: 'https://my-nas.fnos.net',
    flow: 'GATEWAY',
    relayHost: 'my-nas.fnos.net',
    session: { token: 'T' },
    webSession: SID,
  });
  const { controller, state } = makeController({ saved });
  await controller.boot();
  assert.equal(state.loads[0], 'https://my-nas.fnos.net/app/zxdesk/');
  assert.ok(
    !state.logs.some((l) => l.includes('优先走会话所在的')),
    `0.1.5 的「按 host 挑基址」已随 FNID 回退删掉：${state.logs.join(' / ')}`,
  );
});

test('快捷方式图标：默认指 exe 自己（asar 里的 icon.ico Windows 读不到 = 白纸）', () => {
  const options = shortcutOptions({ exePath: 'D:\\Apps\\ZXDesk\\ZXDesk.exe', cwd: 'D:\\Apps\\ZXDesk' });
  assert.equal(options.icon, 'D:\\Apps\\ZXDesk\\ZXDesk.exe');
  assert.equal(options.iconIndex, 0);
  assert.ok(!String(options.icon).includes('app.asar'), '⛔ 不能指 asar 里的虚拟路径');
});

// ---------------------------------------------------------------- WIN-011b：绿色包挪目录后快捷方式自愈

test('shortcutNeedsRepair：只有指向当前 exe 才不用修', () => {
  const expected = shortcutOptions({ exePath: 'D:\\Apps\\ZXDesk\\ZXDesk.exe', cwd: 'D:\\Apps\\ZXDesk' });
  // 同一个文件、大小写不同 ⇒ 不用修
  assert.equal(shortcutNeedsRepair({ target: 'd:\\apps\\zxdesk\\zxdesk.exe', icon: 'd:\\apps\\zxdesk\\zxdesk.exe' }, expected), false);
  // 挪过目录（旧路径）⇒ 要修
  assert.equal(shortcutNeedsRepair({ target: 'C:\\Users\\x\\Downloads\\ZXDesk-0.1.6\\ZXDesk.exe' }, expected), true);
  // 读不出来 / 空壳 ⇒ 要修
  assert.equal(shortcutNeedsRepair(null, expected), true);
  assert.equal(shortcutNeedsRepair({}, expected), true);
  // target 对、icon 还指着旧 exe ⇒ 也要修（否则图标还是白纸）
  assert.equal(shortcutNeedsRepair({ target: expected.target, icon: 'C:\\old\\ZXDesk.exe' }, expected), true);
});

test('主进程：启动后会自愈自己的两个 .lnk，且只碰这两个', () => {
  const main = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  assert.match(main, /function repairShortcutsIfMoved\(/, '要有自愈函数');
  assert.match(main, /app\.isPackaged\) return/, '开发态不碰（exe 是 electron 二进制）');
  // 只处理桌面与启动文件夹
  assert.match(main, /\['桌面', dirs\.desktop\]/);
  assert.match(main, /\['开机自启', dirs\.startup\]/);
  assert.match(main, /readShortcutLink\(file\)/, '要先读出来才能判断');
  assert.match(main, /writeShortcutLink\(file, 'update', expected\)/, 'update 而不是 create');
  const seqAt = main.indexOf('await sequence();');
  const repairAt = main.indexOf('repairShortcutsIfMoved();');
  assert.ok(seqAt > 0 && repairAt > seqAt, '自愈要在界面起来之后（失败也不影响使用）');
});
