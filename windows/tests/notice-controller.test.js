/**
 * 公告（独立窗口）：入口、已读落盘、不自动打扰。
 *
 * 公告只有两种触达：**菜单栏公告条**与**「帮助 → 公告」**，都打开同一个窗口；
 * 拉取到新公告只更新未读标记，⛔ 不自动弹窗（不能打断用户正在做的事）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Controller } from '../src/main/controller.js';

function fakeNotices(overrides = {}) {
  const state = {
    phase: 'ready',
    items: [],
    total: 0,
    unread: 0,
    unreadIds: [],
    updated: '',
    error: null,
    checkedAt: null,
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
    markAllRead() {
      calls.push('markAllRead');
      state.unread = 0;
      state.unreadIds = [];
      return ['a'];
    },
    setReadIds() {},
  };
}

function makeController({ notices = fakeNotices(), prefsValue = {}, openNoticeWindow } = {}) {
  const prefs = {
    value: {
      lastAddress: '',
      preferHttps: true,
      lastUser: '',
      rememberPassword: true,
      noticeReadIds: [],
      ...prefsValue,
    },
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
  const windows = [];
  const controller = new Controller({
    prefs,
    sessions: { load: async () => null },
    credentials: { has: () => false },
    tofu: {},
    view,
    cookies: {},
    logger: () => {},
    notify: () => {},
    notices,
    openNoticeWindow: openNoticeWindow || (() => windows.push('notice')),
    revealPackage: async () => ({ ok: true }),
  });
  controller.showMode();
  return { controller, prefs, view, notices, windows };
}

test('没有公告服务时 state.notices 为 null', () => {
  const controller = new Controller({
    prefs: { get: () => ({}) },
    sessions: { load: async () => null },
    credentials: { has: () => false },
    tofu: {},
    view: { setVisible() {} },
    cookies: {},
    logger: () => {},
    notify: () => {},
  });
  assert.equal(controller.getState().notices, null);
});

test('「帮助 → 公告」打开公告窗口，不切屏、不弹原生框', async () => {
  const notices = fakeNotices({
    total: 2,
    unread: 1,
    unreadIds: ['a'],
    items: [
      { id: 'a', title: '新公告', content: '正文', level: 'info', pinned: true, publishedAt: '2026-10-27 15:00:00' },
      { id: 'b', title: '旧公告', content: '正文', level: 'info', pinned: false, publishedAt: '2026-10-20 10:00:00' },
    ],
  });
  const { controller, windows } = makeController({ notices });

  await controller.action('notice.open');

  assert.deepEqual(windows, ['notice'], '要打开公告窗口');
  assert.equal(controller.getState().screen, 'mode', '开窗不切屏');
});

test('没有任何公告时也打开窗口（窗口自己显示「暂时没有公告」）', async () => {
  const notices = fakeNotices({ total: 0, unread: 0, items: [] });
  const { controller, windows } = makeController({ notices });

  await controller.action('notice.open');
  assert.deepEqual(windows, ['notice'], '⛔ 不要因为列表为空就让入口点了没反应');
});

test('公告条点击与「帮助 → 公告」是同一条路（都开窗口）', async () => {
  const notices = fakeNotices({
    total: 1,
    unread: 1,
    unreadIds: ['a'],
    items: [{ id: 'a', title: '公告', content: '正文', level: 'info', pinned: true, publishedAt: '' }],
  });
  const { controller, windows } = makeController({ notices });

  await controller.openNotice(); // 公告条 data-action="notice.open"
  await controller.action('notice.open'); // 帮助菜单
  assert.deepEqual(windows, ['notice', 'notice']);
});

test('「全部标为已读」：未读清零并落盘', async () => {
  const notices = fakeNotices({
    total: 1,
    unread: 1,
    unreadIds: ['a'],
    items: [{ id: 'a', title: '公告', content: '', level: 'info', pinned: true, publishedAt: '' }],
  });
  const { controller, prefs } = makeController({ notices });

  await controller.action('notice.read');
  assert.deepEqual(prefs.value.noticeReadIds, ['a']);
  assert.equal(controller.getState().notices.unread, 0);
  assert.equal(controller.getState().notices.hasUnread, false, '未读标记要跟着灭');
});

test('启动拉取只更新未读标记，⛔ 不自动开窗', async () => {
  const notices = fakeNotices({
    total: 1,
    unread: 1,
    unreadIds: ['a'],
    items: [{ id: 'a', title: '公告', content: '正文', level: 'info', pinned: true, publishedAt: '' }],
  });
  const { controller, windows, prefs } = makeController({ notices });
  controller.state = { ...controller.state, screen: 'connect' };

  await controller.checkNotices({ silent: true });

  assert.equal(notices.calls.includes('check'), true, '要真的去拉');
  assert.deepEqual(windows, [], '⛔ 不自动弹窗');
  assert.equal(controller.getState().notices.hasUnread, true, '未读要留着，等用户点公告条');
  assert.deepEqual(prefs.value.noticeReadIds, [], '没看过就不能标已读');
});

test('已全部读过的公告：未读标记为假，公告条照常显示', async () => {
  const notices = fakeNotices({
    total: 1,
    unread: 0,
    unreadIds: [],
    items: [{ id: 'a', title: 't', content: '' }],
  });
  const { controller } = makeController({ notices });
  const { notices: view } = controller.getState();
  assert.equal(view.hasUnread, false);
  assert.equal(view.items.length, 1, '公告条显示最新一条，和已读无关');
});
