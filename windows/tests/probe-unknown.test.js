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
import { GATEWAY_PAGE, PROBE_SCRIPT } from '../src/main/connection/gateway.js';

/** 最小 RemoteView：假窗口 + 假 WebContentsView，`executeJavaScript` 返回给定正文。 */
function makeView(body) {
  const probes = [];
  const logs = [];
  const unauthorized = [];
  /** 收到 `zxdesk_sid` 下发时的回调记录。 */
  const webSessions = [];
  /** 收集 `webRequest.onHeadersReceived` 的监听器，用例里手动喂一次 401。 */
  const headerListeners = [];
  const webContents = {
    session: {
      cookies: { set: async () => {}, clear: async () => {}, get: async () => [] },
      webRequest: {
        onHeadersReceived(listener) {
          headerListeners.push(listener);
        },
      },
    },
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
    onUnauthorized: (url) => {
      unauthorized.push(url);
      return true;
    },
    onWebSession: (url) => webSessions.push(url),
  });
  view.ensure();
  /** 喂一个响应头事件：`{status, type, url, responseHeaders}`。 */
  const emitHeaders = ({
    status = 401,
    type = 'xhr',
    url = 'https://10.1.2.3:64999/api/tasks',
    responseHeaders = undefined,
  } = {}) => {
    for (const listener of headerListeners) {
      listener({ statusCode: status, resourceType: type, url, responseHeaders }, () => {});
    }
  };
  return { view, probes, logs, unauthorized, webSessions, emitHeaders, headerListeners };
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

/**
 * 0.2.6：**兜底标签不能是 `APP`**（照 Android `PageProbeJs` 的定论）。
 *
 * 旧脚本最后一行 `return 'APP'` ⇒ 任何「有正文但不认识」的页面都算应用页：
 * 中继空白壳、Chromium 错误页、网关的「正在校验」过渡页都会命中。
 * 而 `onProbe()` 把 `APP` 当成「这一轮真的进过应用」⇒ 随后的 `invalid token` 被当成
 * 「用着用着掉线」⇒ 走静默恢复、不切屏 ⇒ 用户停在一张没有任何按钮的白页上。
 */
test('「有正文但不是应用页」⇒ UNKNOWN，⛔ 不能判成 APP', async () => {
  const { view, probes } = makeView('OTHER');
  assert.equal(await view.runProbe(), GATEWAY_PAGE.UNKNOWN, 'OTHER 不是「已经进应用」的证据');
  assert.equal(probes[0].page, GATEWAY_PAGE.UNKNOWN);

  // 白页上有个输入框（网关的过渡页 / 加载中的登录页）也是 OTHER，同样不算进应用
  const blankForm = makeView('OTHER');
  assert.equal(await blankForm.view.runProbe(), GATEWAY_PAGE.UNKNOWN);

  // EMPTY（白屏）本来就不算，保持
  const empty = makeView('EMPTY');
  assert.equal(await empty.view.runProbe(), GATEWAY_PAGE.UNKNOWN);
});

test('探针脚本的兜底必须是 OTHER（不是 APP）', () => {
  // 脚本本身没法在 Node 里跑（没有 document），所以直接钉住那两行关键判据
  assert.match(
    String(PROBE_SCRIPT),
    /return 'OTHER';\s*\}\s*catch/,
    `脚本末尾必须兜底 OTHER；实际：${String(PROBE_SCRIPT).slice(-160)}`,
  );
  const appReturns = String(PROBE_SCRIPT).match(/return 'APP'/g) || [];
  assert.equal(appReturns.length, 1, 'APP 只该由「#app 存在」那一条给出');
});

test('快捷键只在主进程截一次（同段代码写两遍会让 F5 触发两次刷新）', () => {
  const src = fs.readFileSync(new URL('../src/main/browser/view.js', import.meta.url), 'utf8');
  const handlers = src.match(/wc\.on\('before-input-event'/g) || [];
  assert.equal(handlers.length, 1, `before-input-event 只该挂一次，实际 ${handlers.length} 次`);
  const assigns = src.match(/this\.onShortcut = options\.onShortcut/g) || [];
  assert.equal(assigns.length, 1, '构造函数里 onShortcut 赋一次就够');
});

// ---------------------------------------------------------------- 子资源 401（0.2.6）

/**
 * 网页收到 401 时先弹红气泡「登录已过期」，**700ms 后**才跳登录页。
 * 在那之前这批 `fetch` 的 401 只发生在网络层、不产生导航 —— 只拦 `will-navigate` 的话无人处理。
 * 照 Android 0.3.1 第十二条：子资源 401 就地发起静默重连，2 秒去重。
 */
test('子资源 401 ⇒ 立刻上报（不等页面跳登录页）', () => {
  const { unauthorized, emitHeaders } = makeView('');
  assert.equal(unauthorized.length, 0);

  emitHeaders({ status: 401, type: 'xhr' });
  assert.equal(unauthorized.length, 1, '子资源 401 必须上报给上层');
  assert.match(unauthorized[0], /\/api\/tasks/);
});

test('子资源 401 在 2 秒内只报一次（一屏十几个接口会一起 401）', () => {
  const { unauthorized, emitHeaders } = makeView('');
  // 同一次渲染里连续多个请求失败：真实场景是十几个，这里给三个
  emitHeaders({ status: 401, type: 'xhr', url: 'https://10.1.2.3:64999/api/a' });
  emitHeaders({ status: 401, type: 'xhr', url: 'https://10.1.2.3:64999/api/b' });
  emitHeaders({ status: 401, type: 'fetch', url: 'https://10.1.2.3:64999/api/c' });
  assert.equal(unauthorized.length, 1, '去重窗口内只报一次');
});

test('主框架 401 不在这里报（交给 will-navigate / will-redirect 拦）', () => {
  const { unauthorized, emitHeaders } = makeView('');
  emitHeaders({ status: 401, type: 'mainFrame', url: 'https://10.1.2.3:64999/app/zxdesk/login.html' });
  assert.equal(unauthorized.length, 0);
});

test('非 401 不打扰上层', () => {
  const { unauthorized, emitHeaders } = makeView('');
  emitHeaders({ status: 500, type: 'xhr' });
  emitHeaders({ status: 200, type: 'xhr' });
  assert.equal(unauthorized.length, 0);
});

test('webRequest 监听只挂一次（Electron 一个 session 只有一个 listener，重复挂会覆盖）', () => {
  const { view, headerListeners } = makeView('');
  // ensure() 已经挂过一次；再 harden 一次不应该再加
  view.harden();
  assert.equal(headerListeners.length, 1, `监听器只该有一个，实际 ${headerListeners.length} 个`);
});

/**
 * 0.2.6：「ZXDesk 工作台的登录没有记住，每次都要重新登录」。
 *
 * 真因：ZXDesk 账号的登录是页面里的一个 XHR，成功后前端只切屏、**不做整页导航**
 * ⇒ 没有 `did-finish-load` ⇒ `onProbe` 不跑 ⇒ `captureWebSession` 永远等不到第二次机会
 * ⇒ `session.bin` 里没有 `zxdesk_sid`。所以必须在响应头出现 `Set-Cookie: zxdesk_sid=…`
 * 的**当场**触发一次抓取。
 */
test('响应头下发 zxdesk_sid ⇒ 立刻通知上层保存网页会话', () => {
  const { webSessions, emitHeaders } = makeView('');
  emitHeaders({
    status: 200,
    type: 'xhr',
    url: 'https://10.1.2.3:64999/api/login',
    responseHeaders: { 'Set-Cookie': ['zxdesk_sid=abc123; Path=/; HttpOnly'] },
  });
  assert.equal(webSessions.length, 1, '要请上层抓一次（否则重启就得重登 ZXDesk 账号）');
  assert.match(webSessions[0], /\/api\/login/);
});

test('Set-Cookie 键名大小写都认（不同版本 / 平台给的不一样）', () => {
  const { webSessions, emitHeaders } = makeView('');
  emitHeaders({ status: 200, responseHeaders: { 'set-cookie': ['zxdesk_sid=xyz; Path=/'] } });
  assert.equal(webSessions.length, 1);
});

test('1 秒内多次下发只通知一次（一次登录可能连着几条）', () => {
  const { webSessions, emitHeaders } = makeView('');
  const headers = { 'Set-Cookie': ['zxdesk_sid=a; Path=/'] };
  emitHeaders({ status: 200, responseHeaders: headers });
  emitHeaders({ status: 200, responseHeaders: headers });
  emitHeaders({ status: 200, responseHeaders: headers });
  assert.equal(webSessions.length, 1, '去抖：只抓一次就够');
});

test('别的 Cookie 下发不触发（⛔ 不要把每个 Set-Cookie 都当成网页会话）', () => {
  const { webSessions, emitHeaders } = makeView('');
  emitHeaders({ status: 200, responseHeaders: { 'Set-Cookie': ['fnos-token=T; Path=/'] } });
  emitHeaders({ status: 200, responseHeaders: { 'Set-Cookie': ['theme=dark; Path=/'] } });
  assert.equal(webSessions.length, 0);
});

test('没有响应头 / 空 headers 不炸', () => {
  const { webSessions, emitHeaders } = makeView('');
  emitHeaders({ status: 200 });
  emitHeaders({ status: 200, responseHeaders: null });
  assert.equal(webSessions.length, 0);
});
