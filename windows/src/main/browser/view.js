/**
 * ZXDesk工作台 Windows 客户端
 */

import { PROBE_SCRIPT, classifyProbeResult } from '../connection/gateway.js';
import { WEB_SESSION_COOKIE } from './cookies.js';
import { canOpenExternal, isAllowedNavigation } from './nav.js';

export const TOOLBAR_HEIGHT = 44;

/** 子资源 401 的去重窗口：一屏十几个接口同时 401 只报一次（Android 同口径）。 */
const UNAUTHORIZED_DEDUPE_MS = 2000;
/**
 * `zxdesk_sid` 下发的去重窗口。
 * 一次网页登录可能连着下发好几条（登录接口 + 续期接口），但抓一次就够了。
 */
const WEB_SESSION_DEDUPE_MS = 1000;

const DEFAULT_GATEWAY_PATH = '/app/zxdesk';

/** 日志里只留路径：完整 URL 的查询串可能带凭据（token / ticket）。 */
function shortUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.pathname}${parsed.search ? '?…' : ''}`;
  } catch {
    return String(url || '').slice(0, 120);
  }
}

/**
 * 响应头里有没有下发指定的 Cookie（`Set-Cookie` 的键名大小写不统一，两种都认）。
 * @param {Record<string, string[]>|undefined} headers - `webRequest` 的 `responseHeaders`
 */
function hasSetCookie(headers, name) {
  if (!headers || typeof headers !== 'object') return false;
  const needle = String(name || '').toLowerCase();
  if (!needle) return false;
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== 'set-cookie') continue;
    const lines = Array.isArray(value) ? value : [value];
    if (lines.some((line) => String(line ?? '').toLowerCase().includes(needle))) return true;
  }
  return false;
}

export class RemoteView {
  /**
   * @param {object} options
   * @param {object} options.electron - `require('electron')` 的结果
   * @param {object} options.win - 壳窗口（BrowserWindow）
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
    /**
     * 页面要跳 `/login.html` 时的拦截：返回 true = 上层已接手（先静默续会话），本次导航取消。
     * 与 Android `onLoginPageBlocked` 同口径 —— 会话过期就让页面直接跳登录页，用户会白丢一次登录。
     */
    this.onLoginRedirect = options.onLoginRedirect || (() => false);
    /**
     * 返回 true = 上层已接手（正在静默续会话）；这里只负责上报，不做去重以外的判断。
     */
    this.onUnauthorized = options.onUnauthorized || (() => false);
    /**
     * 网页会话（`zxdesk_sid`）被下发时回调：请上层立刻抓一次并落盘。
     *
     */
    this.onWebSession = options.onWebSession || (() => {});
    // 一屏十几个接口会一起 401：2 秒内只报一次（真正的「只跑一次」由 controller 的 recovering 闸门保证）
    this.unauthorizedAt = 0;
    /** `zxdesk_sid` 下发的去抖时间戳。 */
    this.webSessionAt = 0;
    this.unauthorizedWatched = false;
    // 快捷键（F5 / Ctrl+R / Alt+←→）：远程视图有焦点时**壳收不到 keydown**，
    this.onShortcut = options.onShortcut || (() => {});
    this.view = null;
    this.degraded = false;
    this.visible = false;
    this.context = { baseUrl: '', relayHost: null, gatewayPath: DEFAULT_GATEWAY_PATH };
  }

  get webContents() {
    return this.view ? this.view.webContents : this.win.webContents;
  }

  /**
   * 远程视图用的 session（Cookie / 权限 / 证书都挂它上面）。
   *
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
    this.watchUnauthorized(wc.session);
  }

  /**
   * 盯住**子资源**的 401 与 **`zxdesk_sid` 的下发**（同一个 session 级监听，只能挂一次）。
   *
   */
  watchUnauthorized(session) {
    if (this.unauthorizedWatched) return;
    const webRequest = session?.webRequest;
    if (!webRequest || typeof webRequest.onHeadersReceived !== 'function') return;
    this.unauthorizedWatched = true;
    webRequest.onHeadersReceived((details, callback) => {
      callback({ cancel: false });
      try {
        // ① 网页会话被下发：立刻请上层去抓（去抖，一次登录可能连着几条）
        if (hasSetCookie(details.responseHeaders, WEB_SESSION_COOKIE)) {
          const now = Date.now();
          if (now - this.webSessionAt >= WEB_SESSION_DEDUPE_MS) {
            this.webSessionAt = now;
            this.log(`收到 ${WEB_SESSION_COOKIE}（${shortUrl(details.url)}），去保存网页会话`);
            this.onWebSession(details.url);
          }
        }
        // ② 子资源 401
        if (details.statusCode !== 401) return;
        // 主框架的 401 由 will-navigate / will-redirect 那两条拦，这里只管子资源
        if (details.resourceType === 'mainFrame') return;
        const now = Date.now();
        if (now - this.unauthorizedAt < UNAUTHORIZED_DEDUPE_MS) return;
        this.unauthorizedAt = now;
        this.log(`子资源 401：${shortUrl(details.url)}`);
        this.onUnauthorized(details.url);
      } catch (e) {
        this.logError('子资源 401 处理失败', e);
      }
    });
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
      if (this.blockLoginRedirect(event, url)) return;
      if (isAllowedNavigation(url, this.context)) return;
      event.preventDefault();
      if (canOpenExternal(url)) {
        this.electron.shell.openExternal(url).catch((e) => this.log(`外链打开失败：${e.message}`));
      }
    });

    // 服务端 302 到登录页也要拦（`will-navigate` 不覆盖重定向）；子框架不管
    wc.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      this.blockLoginRedirect(event, url);
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
   * **`UNKNOWN` 也必须回调**：ZXDesk 应用根 `/app/zxdesk/` 是 SPA，`did-finish-load` 时
   */
  /**
   */
  async probePage() {
    const raw = await this.webContents.executeJavaScript(PROBE_SCRIPT, true);
    return classifyProbeResult(raw);
  }

  async runProbe() {
    const page = await this.probePage();
    this.log(`探针结果：${page}`);
    this.onProbe(page, this.webContents.getURL());
    return page;
  }

  setContext(context) {
    this.context = {
      baseUrl: context.baseUrl || '',
      relayHost: context.relayHost || null,
      gatewayPath: context.gatewayPath || DEFAULT_GATEWAY_PATH,
    };
  }

  /** 是不是本应用的登录页（`<base><gatewayPath>/login.html`）。 */
  isGatewayLoginPage(url) {
    const base = String(this.context.baseUrl || '').trim();
    if (!base || !url) return false;
    try {
      const target = new URL(url);
      const origin = new URL(base);
      if (target.origin !== origin.origin) return false;
      const gateway = String(this.context.gatewayPath || DEFAULT_GATEWAY_PATH).replace(/\/+$/, '');
      return target.pathname.replace(/\/+$/, '') === `${gateway}/login.html`;
    } catch {
      return false;
    }
  }

  /**
   * 页面要跳登录页：先问上层能不能静默续会话。
   * @returns {boolean} true = 已拦下（本次导航不要继续）
   */
  blockLoginRedirect(event, url) {
    if (!this.isGatewayLoginPage(url)) return false;
    try {
      if (this.onLoginRedirect(url) !== true) return false;
    } catch (e) {
      this.logError('登录页拦截失败', e);
      return false;
    }
    event.preventDefault();
    this.log(`已拦下跳转登录页（先静默续会话）：${url}`);
    return true;
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
