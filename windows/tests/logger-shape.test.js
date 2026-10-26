/**
 * logger 形态回归（0.1.2 首跑「第一步都点不了」的直接原因）。
 *
 * 生产里 `index.js` 传给 Controller / RemoteView 的是 **Logger 实例**（有 .info/.warn/.error），
 * 而代码里写的是 `this.logger('…')` ⇒ 点第一步就 `TypeError: this.logger is not a function`。
 * 之前测试全传的 `() => {}`（函数），跟生产不一样，所以一条都没咬住。
 *
 * 这里用**真实的 Logger 类**驱动一遍，并把「函数形态」也测一遍 —— 以后加日志不会再挑形态。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { RemoteView } from '../src/main/browser/view.js';
import { Controller } from '../src/main/controller.js';
import { Logger } from '../src/main/log.js';

const tmpDir = path.join(process.cwd(), 'build', 'tmp', 'logger-shape');

function realLogger(name) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `${name}.log`);
  fs.writeFileSync(file, '', 'utf8');
  const logger = new Logger(file);
  logger.ensure();
  return { logger, file, read: () => fs.readFileSync(file, 'utf8') };
}

/** 最小可用的 Controller 依赖（与 index.js 的装配形状一致：logger 是**实例**）。 */
function makeController(logger) {
  const noop = async () => {};
  return new Controller({
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
    sessions: { load: async () => null, save: noop, clear() {}, has: () => false },
    credentials: { load: async () => null, save: noop, clear() {}, has: () => false },
    tofu: { get: () => null, put() {} },
    view: {
      loaded: [],
      session: { cookies: { set: noop, clear: noop } },
      ensure: () => false,
      setVisible() {},
      setContext() {},
      load: async (url) => {
        this.loaded.push(url);
      },
      reload() {},
      goBack() {},
      goForward() {},
      canGoBack: () => false,
      canGoForward: () => false,
    },
    cookies: { apply: noop, clear: noop },
    logger, // ← 关键：Logger 实例，不是函数
    notify: () => {},
  });
}

test('Logger 实例当 logger：点「下一步」不再抛 TypeError，且日志里有动作记录', async () => {
  const { logger, read } = realLogger('instance');
  const controller = makeController(logger);
  await controller.boot();
  await controller.action('flow.next');

  assert.equal(controller.getState().screen, 'connect');
  const text = read();
  assert.match(text, /动作：flow\.next/, `日志应包含动作记录，实际：${text}`);
});

test('函数当 logger：同样能用（两种形态都收）', async () => {
  const lines = [];
  const controller = makeController((m) => lines.push(m));
  await controller.boot();
  await controller.action('flow.next');
  assert.equal(controller.getState().screen, 'connect');
  assert.ok(lines.some((l) => l.includes('动作：flow.next')));
});

test('Logger 实例的 error 通道也能用（不抛、写进日志）', async () => {
  const { logger, read } = realLogger('error');
  const controller = makeController(logger);
  await controller.boot();
  // 故意让 action 内部抛错（未知动作不会抛，这里用 loadSafely 的失败路径不合适）⇒ 直接调 logError
  controller.logError('加载页面失败', new Error('打不开'));
  assert.match(read(), /加载页面失败.*打不开/s);
});

test('RemoteView：logger 传实例时，降级路径不抛且写日志', () => {
  const { logger, read } = realLogger('view');
  const win = {
    webContents: {
      setWindowOpenHandler() {},
      on() {},
      getURL: () => 'file:///shell/index.html',
    },
    contentView: { addChildView() {} },
    getContentSize: () => [1280, 820],
    isDestroyed: () => false,
  };

  const view = new RemoteView({
    electron: {
      // 故意让 WebContentsView 构造抛错 ⇒ 走「降级为单窗口」分支（原先是 this.logger.error 炸在这里）
      WebContentsView: function Boom() {
        throw new Error('模拟：没有 WebContentsView');
      },
      shell: { openExternal: async () => {} },
    },
    win,
    logger, // ← 实例
  });

  const degraded = view.ensure();
  assert.equal(degraded, true, '应该走降级');
  assert.match(read(), /降级为单窗口直接加载远程页/);
});

test('RemoteView：logger 传函数时，降级路径同样不抛（旧代码会炸在 this.logger.error）', () => {
  const lines = [];
  const win = {
    webContents: { setWindowOpenHandler() {}, on() {}, getURL: () => '' },
    contentView: { addChildView() {} },
    getContentSize: () => [1280, 820],
    isDestroyed: () => false,
  };
  const view = new RemoteView({
    electron: {
      WebContentsView: function Boom() {
        throw new Error('模拟：没有 WebContentsView');
      },
      shell: { openExternal: async () => {} },
    },
    win,
    logger: (m) => lines.push(m),
  });
  assert.equal(view.ensure(), true);
  assert.ok(lines.some((l) => l.includes('降级为单窗口')), `日志应记下降级，实际：${lines.join(' / ')}`);
});
