/**
 * IPC 白名单（0.1.4 新增文字菜单通道）。
 *
 * 菜单栏只允许 `connect / view / help` 三组；动作也必须是登记过的。
 * 这条测试同时守着「来源校验」——远程视图没有 preload，但校验不能省。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTION_ALLOWLIST, CHANNEL, MENU_ALLOWLIST, registerIpc } from '../src/main/ipc.js';

function setup({ trusted = true } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
  };
  const menus = [];
  const actions = [];
  const logs = [];
  registerIpc(ipcMain, {
    controller: {
      getState: () => ({ screen: 'browsing' }),
      action: async (type, payload) => actions.push([type, payload]),
      diagnosticsText: () => 'diag',
    },
    isTrustedSender: () => trusted,
    onMenu: (which) => menus.push(which),
    copyText: async () => true,
    logger: (m) => logs.push(m),
  });
  return { handlers, menus, actions, logs };
}

test('菜单白名单：connect / view / settings / help 放行', async () => {
  const { handlers, menus } = setup();
  for (const which of MENU_ALLOWLIST) {
    assert.equal(await handlers.get(CHANNEL.MENU)({}, which), true, which);
  }
  assert.deepEqual(menus, ['connect', 'view', 'settings', 'help']);
});

test('菜单白名单：未登记的名字一律拒（并留日志）', async () => {
  const { handlers, menus, logs } = setup();
  assert.equal(await handlers.get(CHANNEL.MENU)({}, 'evil'), false);
  assert.deepEqual(menus, []);
  assert.ok(logs.some((l) => l.includes('拒绝未登记的菜单')));
});

test('来源不可信时，菜单与动作都拒绝', async () => {
  const { handlers, menus, actions } = setup({ trusted: false });
  assert.equal(await handlers.get(CHANNEL.MENU)({}, 'view'), false);
  const result = await handlers.get(CHANNEL.ACTION)({}, 'flow.next', {});
  assert.deepEqual(result, { ok: false, error: '来源不可信' });
  assert.deepEqual(menus, []);
  assert.deepEqual(actions, []);
});

test('动作白名单：2FA 提交与菜单相关动作都在册', () => {
  for (const type of ['twofa.submitTotp', 'twofa.submitEmail', 'connect.submit', 'panel.open', 'toolbar.reload']) {
    assert.ok(ACTION_ALLOWLIST.includes(type), `缺动作：${type}`);
  }
});

test('动作白名单：没登记的字符串直接拒，不会打到 controller', async () => {
  const { handlers, actions } = setup();
  const result = await handlers.get(CHANNEL.ACTION)({}, 'os.exec', { cmd: 'rm' });
  assert.equal(result.ok, false);
  assert.deepEqual(actions, []);
});
