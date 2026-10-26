import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { canWriteDir, dataFiles, decideDataDir } from '../src/main/store/paths.js';
import { makeDeviceId, normalizePrefs } from '../src/main/store/prefs.js';
import { SavedSession } from '../src/main/store/session.js';
import { FnSession } from '../src/main/login/flow.js';

const CAN = () => true;
const CANNOT = () => false;

test('打包态：程序目录可写 ⇒ portable，数据在 exe 同级 data/', () => {
  const result = decideDataDir({
    isPackaged: true,
    exeDir: 'D:\\Apps\\ZXDesk',
    devDir: 'C:\\dev\\.dev-data',
    localAppData: 'C:\\Users\\x\\AppData\\Local',
    canWrite: CAN,
  });
  assert.equal(result.mode, 'portable');
  assert.equal(result.dir, path.join('D:\\Apps\\ZXDesk', 'data'));
  assert.equal(result.warning, null);
});

test('打包态：不可写 ⇒ 回落 LOCALAPPDATA 并给提示（别放 Program Files）', () => {
  const result = decideDataDir({
    isPackaged: true,
    exeDir: 'C:\\Program Files\\ZXDesk',
    devDir: 'ignored',
    localAppData: 'C:\\Users\\x\\AppData\\Local',
    canWrite: CANNOT,
  });
  assert.equal(result.mode, 'fallback');
  assert.equal(result.dir, path.join('C:\\Users\\x\\AppData\\Local', 'ZXDesk'));
  assert.match(result.warning, /LOCALAPPDATA/);
});

test('开发态：写 .dev-data（⛔ 不写 node_modules）', () => {
  const result = decideDataDir({
    isPackaged: false,
    exeDir: 'ignored',
    devDir: '/repo/Project/windows/.dev-data',
    localAppData: '/home/x/.local/share',
    canWrite: CAN,
  });
  assert.equal(result.mode, 'dev');
  assert.match(result.dir, /\.dev-data$/);
  assert.ok(!result.dir.includes('node_modules'));
});

test('开发态不可写也回落', () => {
  const result = decideDataDir({
    isPackaged: false,
    exeDir: 'i',
    devDir: '/repo/.dev-data',
    localAppData: '/home/x/.local/share',
    canWrite: CANNOT,
  });
  assert.equal(result.mode, 'fallback');
});

test('canWriteDir：真实目录可写', () => {
  const dir = path.join(process.cwd(), 'build', 'tmp', 'writable-probe');
  assert.equal(canWriteDir(dir), true);
});

test('dataFiles：四个文件名固定', () => {
  const files = dataFiles('/data');
  assert.deepEqual(Object.keys(files).sort(), ['bootLog', 'credential', 'prefs', 'session', 'tofu']);
  assert.equal(files.bootLog, path.join('/data', 'logs', 'boot.log'));
});

test('prefs 归一：窗口最小 1100x720，其余给默认值', () => {
  const prefs = normalizePrefs({ window: { width: 800, height: 100 } });
  assert.equal(prefs.window.width, 1100);
  assert.equal(prefs.window.height, 720);
  assert.equal(prefs.preferHttps, true);
  assert.equal(prefs.rememberPassword, true);
});

test('prefs 归一：坏数据不炸', () => {
  const prefs = normalizePrefs(null);
  assert.equal(prefs.lastAddress, '');
  assert.equal(prefs.deviceId, '');
  assert.equal(prefs.window.maximized, false);
});

test('设备 id 格式：<36进制时间>-<13位>-<13位>，且稳定', () => {
  const fixed = makeDeviceId(1700000000000, (n) => Buffer.alloc(n, 0));
  assert.match(fixed, /^[0-9a-z]+-[0-9a-z]{13}-[0-9a-z]{13}$/);
  assert.equal(makeDeviceId(1700000000000, (n) => Buffer.alloc(n, 0)), fixed);
  assert.notEqual(makeDeviceId(1700000000000, (n) => Buffer.alloc(n, 7)), fixed);
});

test('会话快照往返：token / longToken / Cookie 都在', () => {
  const saved = new SavedSession({
    address: '10.1.2.3',
    https: true,
    user: 'myaccount',
    baseUrl: 'https://10.1.2.3:64999',
    gatewayPath: '/app/zxdesk',
    flow: 'GATEWAY',
    relayHost: 'my-nas.fnos.net',
    session: new FnSession({ token: 'T', longToken: 'LT', setCookies: ['a=1'], note: 'ok' }),
  });
  const back = SavedSession.fromJSON(JSON.stringify(saved.toJSON()));
  assert.equal(back.baseUrl, saved.baseUrl);
  assert.equal(back.session.token, 'T');
  assert.equal(back.session.longToken, 'LT');
  assert.deepEqual(back.session.setCookies, ['a=1']);
  assert.equal(back.relayHost, 'my-nas.fnos.net');
});

test('会话快照：坏 JSON / 缺 baseUrl 一律 null（⛔ 不半信半疑地用）', () => {
  assert.equal(SavedSession.fromJSON('{'), null);
  assert.equal(SavedSession.fromJSON('null'), null);
  assert.equal(SavedSession.fromJSON(JSON.stringify({ address: 'x' })), null);
});

test('startUrl：直连直奔 login.html', () => {
  const saved = new SavedSession({ baseUrl: 'http://10.1.2.3:8990', flow: 'DIRECT' });
  assert.equal(saved.startUrl(), 'http://10.1.2.3:8990/app/zxdesk/login.html');
});

test('startUrl：有原生会话就直奔 ZXDesk（不再走门户）', () => {
  const saved = new SavedSession({
    baseUrl: 'https://my-nas.fnos.net',
    flow: 'GATEWAY',
    relayHost: 'my-nas.fnos.net',
    portalUrl: 'https://fnos.net/my-nas/',
    session: new FnSession({ token: 'T' }),
  });
  assert.equal(saved.startUrl(), 'https://my-nas.fnos.net/app/zxdesk/login.html');
});

test('startUrl：没会话的网关先进门户（中继根不是登录页）', () => {
  const saved = new SavedSession({
    baseUrl: 'https://my-nas.fnos.net',
    flow: 'GATEWAY',
    portalUrl: 'https://fnos.net/my-nas/',
  });
  assert.equal(saved.startUrl(), 'https://fnos.net/my-nas/');
});
