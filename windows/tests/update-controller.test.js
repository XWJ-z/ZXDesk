/**
 * 更新流程（独立窗口）：开窗 → 后台检查 → 下载 → 立即安装。
 *
 * 界面不在壳里画，也不走原生消息框 —— 这里只验**控制器把状态与动作串对了**：
 * 什么时候开窗、检查结果落在哪个字段、下载失败的文案放哪、安装包什么时候才允许运行。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Controller } from '../src/main/controller.js';

/** 让「开窗后在后台跑」的那次检查落地（openUpdate 不 await 检查）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeUpdater(overrides = {}) {
  const state = {
    phase: 'latest',
    current: '0.2.2',
    latest: '0.2.2',
    available: false,
    mustUpdate: false,
    notes: '',
    fileName: '',
    fileSize: 0,
    hash: '',
    progress: null,
    filePath: '',
    packageType: '',
    error: null,
    ...overrides,
  };
  const calls = [];
  return {
    state,
    calls,
    snapshot: () => JSON.parse(JSON.stringify(state)),
    async check() {
      calls.push('check');
    },
    async download() {
      calls.push('download');
    },
    downloadedFile: () => state.filePath,
    set(next) {
      Object.assign(state, next);
    },
  };
}

function makeController({ updater = fakeUpdater(), prefsValue = {} } = {}) {
  const prefs = {
    value: { lastAddress: '', preferHttps: true, lastUser: '', rememberPassword: true, ...prefsValue },
    get() {
      return this.value;
    },
    patch(partial) {
      this.value = { ...this.value, ...partial };
      return this.value;
    },
  };
  const view = {
    visible: false,
    setVisible(value) {
      this.visible = Boolean(value);
    },
  };
  const revealed = [];
  const progress = [];
  const windows = [];
  const opened = [];
  const controller = new Controller({
    prefs,
    sessions: { load: async () => null },
    credentials: { has: () => false },
    tofu: {},
    view,
    cookies: {},
    logger: () => {},
    notify: () => {},
    updater,
    openUpdateWindow: () => windows.push('update'),
    openNoticeWindow: () => windows.push('notice'),
    setProgress: (value) => progress.push(value),
    revealPackage: async (file) => {
      revealed.push(file);
      return { ok: true };
    },
    openExternal: async (url) => {
      opened.push(url);
      return { ok: true };
    },
  });
  controller.showMode();
  return { controller, prefs, view, revealed, updater, progress, windows, opened };
}

test('没有更新服务时连窗口都不开（免得给一个永远「待检查」的空窗）', async () => {
  const { controller, windows } = makeController({ updater: null });
  await controller.action('update.open');
  assert.deepEqual(windows, []);
  assert.equal(controller.getState().update, null);
});

test('已是最新：开窗 + 查一次，状态落在 phase=latest，不下载', async () => {
  const updater = fakeUpdater({ phase: 'latest', latest: '0.2.2' });
  const { controller, windows } = makeController({ updater });
  await controller.action('update.open');
  await tick();

  assert.deepEqual(windows, ['update'], '要开更新窗口');
  assert.deepEqual(updater.calls, ['check']);
  const state = controller.getState();
  assert.equal(state.update.phase, 'latest');
  assert.equal(state.update.banner, false);
});

test('有新版：窗口里的按钮走 update.download / update.run，校验通过才运行安装包', async () => {
  const updater = fakeUpdater({
    phase: 'available',
    latest: '0.2.3',
    available: true,
    fileName: 'zxdesk-windows-0.2.3-x64-setup.exe',
    packageType: 'installer',
  });
  const { controller, revealed, progress } = makeController({ updater });

  // 真实实现里 service 每变一次状态就 onState → controller.push；这里手动模拟
  updater.download = async () => {
    updater.calls.push('download');
    updater.set({ phase: 'downloading', progress: { received: 0, total: 100, percent: 0 } });
    controller.push();
    updater.set({ phase: 'ready', filePath: '/tmp/zxdesk-setup.exe', progress: { received: 100, total: 100, percent: 100 } });
    controller.push();
  };

  await controller.action('update.download');
  assert.ok(updater.calls.includes('download'));
  assert.equal(controller.getState().update.phase, 'ready');
  assert.equal(controller.getState().update.actionError, '', '成功时不能留失败文案');
  assert.equal(progress.at(-1), -1, '下载结束要清掉任务栏进度');

  await controller.action('update.run');
  assert.deepEqual(revealed, ['/tmp/zxdesk-setup.exe'], '只有校验通过的包才会被交出去运行');
});

test('下载失败：文案进 update.actionError（窗口状态行），⛔ 不抛原始错误', async () => {
  const unreachable = fakeUpdater({ phase: 'available', latest: '0.2.3', available: true });
  const first = makeController({ updater: unreachable });
  unreachable.download = async () => {
    unreachable.set({ phase: 'error', error: { kind: 'unreachable', message: '所有下载源都连不上' } });
  };
  await first.controller.action('update.download');
  assert.match(first.controller.getState().update.actionError, /任何一个下载源/);

  const badHash = fakeUpdater({ phase: 'available', latest: '0.2.3', available: true });
  const second = makeController({ updater: badHash });
  badHash.download = async () => {
    badHash.set({ phase: 'error', error: { kind: 'download', message: 'SHA256 校验失败（期望 a，实际 b）' } });
  };
  await second.controller.action('update.download');
  assert.match(second.controller.getState().update.actionError, /校验没通过/);
  assert.ok(!second.controller.getState().update.actionError.includes('SHA256 校验失败（'));
});

test('检查失败：窗口拿到的是人话（error.kind → 文案），不是 ECONNREFUSED', async () => {
  const updater = fakeUpdater({
    phase: 'error',
    error: { kind: 'network', message: 'ECONNREFUSED https://api.example.com' },
  });
  const { controller } = makeController({ updater });
  await controller.action('update.check');

  const { error } = controller.getState().update;
  assert.equal(error.kind, 'network', 'kind 要留着，便于排查');
  assert.match(error.message, /连不上更新服务/);
  assert.ok(!error.message.includes('ECONNREFUSED'), '⛔ 不把原始错误抛给用户');
});

test('打开安装包：路径没了要说清楚，写进窗口状态行', async () => {
  const updater = fakeUpdater({ phase: 'ready', filePath: '' });
  const { controller, revealed } = makeController({ updater });
  await controller.action('update.run');
  assert.deepEqual(revealed, []);
  assert.match(controller.getState().update.actionError, /重新下载/);
});

test('「以后再说」只记这一版；强制更新时不允许忽略', async () => {
  const updater = fakeUpdater({ phase: 'available', latest: '0.2.3', available: true });
  const { controller, prefs } = makeController({ updater });
  await controller.action('update.skip');
  assert.equal(prefs.value.updateSkippedVersion, '0.2.3');

  const forced = fakeUpdater({ phase: 'available', latest: '0.2.4', available: true, mustUpdate: true });
  const second = makeController({ updater: forced });
  await second.controller.action('update.skip');
  assert.equal(second.prefs.value.updateSkippedVersion, undefined);
});

test('开窗不动壳：不切屏幕、不藏远程视图（窗口和 WebContentsView 互不相干）', async () => {
  const updater = fakeUpdater({ phase: 'available', latest: '0.2.3', available: true, fileName: 'a.exe' });
  const { controller, view } = makeController({ updater });
  controller.state = { ...controller.state, screen: 'browsing' };
  controller.entry = { baseUrl: 'https://example.com' };
  view.visible = true;

  await controller.action('update.open');
  await tick();
  assert.equal(controller.getState().screen, 'browsing');
  assert.equal(view.visible, true, '独立窗口不需要藏远程视图');
});

test('有新版时壳上的提示条仍然只由 banner 控制（浏览模式不出提示条）', async () => {
  const updater = fakeUpdater({ phase: 'available', latest: '0.2.3', available: true });
  const { controller } = makeController({ updater });
  controller.state = { ...controller.state, screen: 'connect' };
  assert.equal(controller.getState().update.banner, true);

  controller.state = { ...controller.state, screen: 'browsing' };
  assert.equal(controller.getState().update.banner, false, '浏览网页时靠「帮助」菜单里的标注，不叠提示条');
});

test('连续下载失败：状态是 give-up，界面据此给网盘出口', async () => {
  const updater = fakeUpdater({
    phase: 'available',
    latest: '0.2.3',
    available: true,
    fallbackUrl: 'https://pan.baidu.com/s/abc',
  });
  const { controller } = makeController({ updater });
  updater.download = async () => {
    updater.calls.push('download');
    updater.set({
      phase: 'error',
      attempts: 2,
      error: { kind: 'give-up', message: '两个源上的都不是这一版', attempts: 2 },
    });
  };

  await controller.action('update.download');
  const { update } = controller.getState();
  assert.equal(update.phase, 'error');
  assert.equal(update.error.kind, 'give-up');
  assert.equal(update.attempts, 2);
  assert.equal(update.fallbackUrl, 'https://pan.baidu.com/s/abc');
});

test('「前往百度网盘下载」：只打开清单里那个地址', async () => {
  const updater = fakeUpdater({
    phase: 'error',
    error: { kind: 'give-up', message: '下载失败', attempts: 2 },
    fallbackUrl: 'https://pan.baidu.com/s/abc',
  });
  const { controller, opened } = makeController({ updater });

  await controller.action('update.pan');
  assert.deepEqual(opened, ['https://pan.baidu.com/s/abc']);
  assert.equal(controller.getState().update.actionError, '');
});

test('没配网盘地址时不静默：给出说明，不打开任何链接', async () => {
  const updater = fakeUpdater({ phase: 'error', error: { kind: 'give-up', message: '下载失败' }, fallbackUrl: '' });
  const { controller, opened } = makeController({ updater });

  await controller.action('update.pan');
  assert.deepEqual(opened, []);
  assert.match(controller.getState().update.actionError, /网盘地址/);
});

test('give-up 的文案不被「检查失败」那张表盖掉（排查线索要留着）', () => {
  const updater = fakeUpdater({
    phase: 'error',
    error: { kind: 'give-up', message: '两个源上的都不是这一版（SHA256 对不上）', attempts: 2 },
    attempts: 2,
    available: true,
    fallbackUrl: 'https://pan.baidu.com/s/abc',
  });
  const { controller } = makeController({ updater });
  const { update } = controller.getState();
  assert.equal(update.error.kind, 'give-up');
  assert.match(update.error.message, /SHA256 对不上/, '下载停手的原因要原样透出，不能变成「检查更新失败」');
  assert.equal(update.attempts, 2);
  assert.equal(update.fallbackUrl, 'https://pan.baidu.com/s/abc');
});
