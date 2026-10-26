/**
 * 探针「UNKNOWN 也要回调」（0.1.6 收尾修复 P0）。
 *
 * 现场：ZXDesk 应用根 `/app/zxdesk/` 是 SPA，`did-finish-load` 时 `innerText` 还没渲染 ⇒
 * `classifyGatewayBody('')` 给 `UNKNOWN`。0.1.6 初版 `runProbe()` 写成「非 UNKNOWN 才回调」，
 * 于是 `Controller.onProbe()` 一次都没被调用 ⇒ `captureWebSession()` 从没跑过 ⇒
 * `session.bin` 里没有 `zxdesk_sid` ⇒ 完全退出重开仍要登录。**这条用例在旧代码上必须失败。**
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { RemoteView } from '../src/main/browser/view.js';
import { GATEWAY_PAGE } from '../src/main/connection/gateway.js';

/** 最小 RemoteView：假窗口 + 假 WebContentsView，`executeJavaScript` 返回给定正文。 */
function makeView(body) {
  const probes = [];
  const logs = [];
  const webContents = {
    session: { cookies: { set: async () => {}, clear: async () => {}, get: async () => [] } },
    setWindowOpenHandler() {},
    on() {},
    once() {},
    removeListener() {},
    getURL: () => 'https://10.1.2.3:64999/app/zxdesk/',
    getTitle: () => 'ZXDesk',
    executeJavaScript: async () => body,
    loadURL: async () => {},
    reload() {},
    canGoBack: () => false,
    canGoForward: () => false,
    setZoomLevel() {},
    getZoomLevel: () => 0,
  };
  const win = {
    webContents,
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1280, 820],
    isDestroyed: () => false,
    loadURL: async () => {},
  };
  const view = new RemoteView({
    electron: {
      WebContentsView: function FakeView() {
        return { webContents, setBounds() {}, setVisible() {} };
      },
      shell: { openExternal: async () => {} },
      session: { fromPartition: () => webContents.session },
    },
    win,
    logger: (m) => logs.push(m),
    onProbe: (page, url) => probes.push({ page, url }),
  });
  view.ensure();
  return { view, probes, logs };
}

test('探针正文为空（SPA 还没渲染）⇒ 结论 UNKNOWN，但 onProbe 仍被调用', async () => {
  const { view, probes, logs } = makeView('');
  const page = await view.runProbe();
  assert.equal(page, GATEWAY_PAGE.UNKNOWN);
  assert.equal(probes.length, 1, `UNKNOWN 也必须回调（否则网页会话永远捕获不到）：${logs.join(' / ')}`);
  assert.equal(probes[0].page, GATEWAY_PAGE.UNKNOWN);
  assert.match(probes[0].url, /\/app\/zxdesk\/$/);
});

test('探针认出登录页时同样回调（原来的行为没被改坏）', async () => {
  const { view, probes } = makeView('invalid token');
  const page = await view.runProbe();
  assert.equal(page, GATEWAY_PAGE.LOGIN_REQUIRED);
  assert.equal(probes.length, 1);
  // 应用页也一样（SPA 渲染出来才有正文，这时探针是 APP）
  const app = makeView('<html><body>ZXDesk 工作台</body></html>');
  assert.equal(await app.view.runProbe(), GATEWAY_PAGE.APP);
  assert.equal(app.probes.length, 1);
});

test('快捷键只在主进程截一次（同段代码写两遍会让 F5 触发两次刷新）', () => {
  const src = fs.readFileSync(new URL('../src/main/browser/view.js', import.meta.url), 'utf8');
  const handlers = src.match(/wc\.on\('before-input-event'/g) || [];
  assert.equal(handlers.length, 1, `before-input-event 只该挂一次，实际 ${handlers.length} 次`);
  const assigns = src.match(/this\.onShortcut = options\.onShortcut/g) || [];
  assert.equal(assigns.length, 1, '构造函数里 onShortcut 赋一次就够');
});
