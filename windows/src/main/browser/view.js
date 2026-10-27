/**
 * 远程内容视图（`WebContentsView`）。
 *
 * 为什么单独一个视图而不是塞进壳的 webContents：`WebContentsView` 永远画在窗口 DOM 之上，
 * 塞一起远程页面就会拿到壳的 preload / IPC。拆开后远程视图**没有 preload、没有 node**。
 *
 * ⚠️ 一期兜底（S1）：`WebContentsView` 创建或加载失败 → 退化为「单 BrowserWindow 直接加载远程页」
 * （没有工具栏，但能进），并写日志说明降级 —— ⛔ 不许白屏。
 */

import { PROBE_SCRIPT, classifyGatewayBody, GATEWAY_PAGE } from '../connection/gateway.js';
import { canOpenExternal, isAllowedNavigation } from './nav.js';

export const TOOLBAR_HEIGHT = 44;

export class RemoteView {
  /**
   * @param {object} options
   * @param {object} options.electron - `require('electron')` 的结果
   * @param {object} options.win - 壳窗口（BrowserWindow）
   * @param {string} options.partition
   * @param {object} options.logger
   * @param {Function} options.onProbe - `(page, url) => void`
   * @param {Function} options.onLoadFail - `({url, code, description}) => void`
   * @param {Function} options.onTitleChange - `(title) => void`
   */
  constructor(options) {
    this.electron = options.electron;
    this.win = options.win;
    this.partition = options.partition || 'persist:zxdesk';
    // 同 controller：logger 可能是函数，也可能是 Logger 实例 —— 统一收成两个函数，内部只用它们
    const rawLogger = options.logger;
    this.log = typeof rawLogger === 'function' ? rawLogger : (message) => rawLogger?.info?.(String(message));
    this.logError =
      typeof rawLogger === 'function'
        ? (message, error) => rawLogger(error ? `${message}：${error?.message || error}` : message)
        : (message, error) => rawLogger?.error?.(message, error);
    this.onProbe = options.onProbe || (() => {});
    this.onLoadFail = options.onLoadFail || (() => {});
    this.onTitleChange = options.onTitleChange || (() => {});
    // 快捷键（F5 / Ctrl+R / Alt+←→）：远程视图有焦点时**壳收不到 keydown**，
    // 所以必须在主进程用 before-input-event 截（否则「按 F5 没反应」）
    this.onShortcut = options.onShortcut || (() => {});
    this.view = null;
    this.degraded = false;
    this.visible = false;
    this.context = { baseUrl: '', relayHost: null };
  }

  get webContents() {
    return this.view ? this.view.webContents : this.win.webContents;
  }

  /**
   * 远程视图用的 session（Cookie / 权限 / 证书都挂它上面）。
   *
   * ⚠️ 视图还没建时**必须**返回 `persist:zxdesk` 分区，⛔ 不能回退到壳窗口的默认会话：
   * 0.1.3 就是回退成壳会话，导致第一次登录的 Cookie 写进了壳、远程视图分区里没有 ⇒ 页面当成未登录，
   * 用户要登第二次（第二次视图已建，才写对）。这是「每次登录两次」的真因。
   */
  get session() {
    if (this.view) return this.view.webContents.session;
    const fromPartition = this.electron?.session?.fromPartition;
    if (typeof fromPartition === 'function') {
      try {
        return fromPartition.call(this.electron.session, this.partition);
      } catch {
        /* 极端情况（session 模块不可用）才往下走 */
      }
    }
    return this.win.webContents.session;
  }

  /** 创建并挂上视图；失败则降级。返回是否走了降级。 */
  ensure() {
    if (this.view || this.degraded) return this.degraded;
    if (!this.win || this.win.isDestroyed?.()) {
      // 装配顺序错了（窗口还没建就建视图）：明确报，别让它变成「白屏无解释」
      throw new Error('远程视图拿不到窗口（壳窗口尚未创建）');
    }
    if (!this.win || this.win.isDestroyed?.()) {
      // 装配顺序错了（窗口还没建就建视图）：明确报，别让它变成「白屏无解释」
      throw new Error('远程视图拿不到窗口（壳窗口尚未创建）');
    }
    const { WebContentsView } = this.electron;
    try {
      if (typeof WebContentsView !== 'function') throw new Error('当前 Electron 没有 WebContentsView');
      this.view = new WebContentsView({
        webPreferences: {
          partition: this.partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          // 远程视图**没有 preload** —— 这一条是安全边界，⛔ 别为了方便加回来
        },
      });
      this.win.contentView.addChildView(this.view);
      this.harden();
      this.view.setVisible(false);
      this.layout();
      this.log('视图创建完成（WebContentsView）');
      return false;
    } catch (e) {
      this.logError('WebContentsView 创建失败，降级为单窗口直接加载远程页', e);
      this.degraded = true;
      this.view = null;
      this.hardenWindow();
      return true;
    }
  }

  /** 远程视图的安全边界 + 生命周期钩子。 */
  harden() {
    const wc = this.view.webContents;
    this.hardenWebContents(wc);
  }

  hardenWindow() {
    this.hardenWebContents(this.win.webContents);
  }

  hardenWebContents(wc) {
    wc.setWindowOpenHandler(({ url }) => {
      // 目标 `_blank` 一律收在本视图里；外部站点交系统浏览器
      if (isAllowedNavigation(url, this.context)) {
        wc.loadURL(url).catch((e) => this.log(`收内链接失败：${e.message}`));
      } else if (canOpenExternal(url)) {
        this.electron.shell.openExternal(url).catch((e) => this.log(`外链打开失败：${e.message}`));
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      if (isAllowedNavigation(url, this.context)) return;
      event.preventDefault();
      if (canOpenExternal(url)) {
        this.electron.shell.openExternal(url).catch((e) => this.log(`外链打开失败：${e.message}`));
      }
    });

    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      const key = String(input.key || '');
      const lower = key.toLowerCase();
      if (key === 'F5' || (input.control && lower === 'r')) {
        event.preventDefault();
        this.onShortcut('reload');
      } else if (input.alt && key === 'ArrowLeft') {
        event.preventDefault();
        this.onShortcut('back');
      } else if (input.alt && key === 'ArrowRight') {
        event.preventDefault();
        this.onShortcut('forward');
      }
    });

    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      this.onTitleChange?.(wc.getTitle?.() || '');
      this.runProbe().catch((e) => this.log(`探针执行失败：${e.message}`));
      this.log(`页面加载完成：${url}`);
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED（用户中途取消 / 重定向），不是真失败
      if (!isMainFrame || errorCode === -3) return;
      this.log(`页面加载失败：${errorCode} ${errorDescription} ${validatedURL}`);
      this.onLoadFail?.({ url: validatedURL, code: errorCode, description: errorDescription });
    });
  }

  /**
   * 页面完成后判：`invalid token` / 访问码 / 正常（顺序不能反）。
   *
   * ⚠️ **`UNKNOWN` 也必须回调**：ZXDesk 应用根 `/app/zxdesk/` 是 SPA，`did-finish-load` 时
   * `innerText` 还没渲染 ⇒ 探针结论是 `UNKNOWN`。0.1.6 初版「非 UNKNOWN 才回调」，
   * 于是 `captureWebSession()` 一次都没跑过 ⇒ `session.bin` 里没有 `zxdesk_sid` ⇒ 自动登录从没生效。
   * 判页面类型是回调方的事，探针只负责如实上报。
   */
  async runProbe() {
    const text = await this.webContents.executeJavaScript(PROBE_SCRIPT, true);
    const page = classifyGatewayBody(text);
    this.log(`探针结果：${page}`);
    this.onProbe(page, this.webContents.getURL());
    return page;
  }

  setContext(context) {
    this.context = { baseUrl: context.baseUrl || '', relayHost: context.relayHost || null };
  }

  layout() {
    if (!this.view) return;
    const [width, height] = this.win.getContentSize();
    this.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.view) this.view.setVisible(this.visible);
  }

  load(url) {
    if (this.degraded) return this.win.loadURL(url);
    this.ensure();
    return this.webContents.loadURL(url);
  }

  /**
   * 加载并**等结果**：true = 页面真的加载完；false = 失败/超时。
   *
   * 为什么需要：`loadURL()` 的 Promise 在 `did-fail-load` 时也常常 resolve，
   * 于是「中继 DNS 挂了」跟「加载成功」在代码里长得一样 —— 0.1.4 的冷启动就死磕中继、没有回落。
   */
  loadChecked(url, timeoutMs = 8000) {
    if (this.degraded) {
      return this.win.loadURL(url).then(
        () => true,
        () => false,
      );
    }
    this.ensure();
    const wc = this.webContents;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener?.('did-finish-load', onFinish);
        wc.removeListener?.('did-fail-load', onFail);
        resolve(ok);
      };
      const onFinish = () => finish(true);
      const onFail = (_event, code) => {
        if (code === -3) return; // ERR_ABORTED：用户中途取消/重定向，不算失败
        finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      wc.once('did-finish-load', onFinish);
      wc.once('did-fail-load', onFail);
      try {
        wc.loadURL(url).catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  reload() {
    this.webContents.reload();
  }

  goBack() {
    const wc = this.webContents;
    if (wc.navigationHistory?.canGoBack?.()) wc.navigationHistory.goBack();
    else if (typeof wc.canGoBack === 'function' && wc.canGoBack()) wc.goBack();
  }

  goForward() {
    const wc = this.webContents;
    if (wc.navigationHistory?.canGoForward?.()) wc.navigationHistory.goForward();
    else if (typeof wc.canGoForward === 'function' && wc.canGoForward()) wc.goForward();
  }

  canGoBack() {
    const wc = this.webContents;
    if (wc.navigationHistory?.canGoBack) return wc.navigationHistory.canGoBack();
    return typeof wc.canGoBack === 'function' ? wc.canGoBack() : false;
  }

  canGoForward() {
    const wc = this.webContents;
    if (wc.navigationHistory?.canGoForward) return wc.navigationHistory.canGoForward();
    return typeof wc.canGoForward === 'function' ? wc.canGoForward() : false;
  }

  currentUrl() {
    try {
      return this.webContents.getURL();
    } catch {
      return '';
    }
  }
}
