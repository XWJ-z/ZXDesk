/**
 * ZXDesk 工作台 · Windows 壳（Electron 主进程入口）。
 *
 * 启动顺序（每一步都写 `data/logs/boot.log`，首跑翻车时这就是验尸包）：
 * ① 参数判定（`--diagnose` / `--smoke`）→ ② 绿色路径（`app.setPath`，必须在 ready 之前）
 * → ③ 单实例 → ④ 壳窗口 → ⑤ 远程视图 → ⑥ 导航。
 *
 * 三条不可退让的边界：
 * - 远程视图：独立 partition、无 preload、无 node、`sandbox:true`；
 * - 壳：`sandbox:true` + preload，IPC 只走白名单 + 来源校验；
 * - 凭据只在主进程，日志一律脱敏。
 */

import {
  BrowserWindow,
  Menu,
  Tray,
  WebContentsView,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { applyCookies, clearCookies } from './browser/cookies.js';
import { RemoteView } from './browser/view.js';
import { Controller } from './controller.js';
import { runDiagnose } from './diagnose.js';
import { registerIpc } from './ipc.js';
import { createBootSequence } from './boot.js';
import { Logger } from './log.js';
import { DEFAULT_NOTICE_URL, NoticeService } from './notice.js';
import { CredentialStore } from './store/credentials.js';
import { dataFiles, resolveDataDir } from './store/paths.js';
import { PrefsStore } from './store/prefs.js';
import { SecureStore } from './store/secure.js';
import { SessionStore } from './store/session.js';
import { shortcutNeedsRepair, shortcutOperation, shortcutOptions, shortcutPaths } from './store/shortcuts.js';
import { TofuStore } from './store/tofuStore.js';
import { describeCertificate } from './tls/cert.js';
import { DEFAULT_API_URL } from './update/client.js';
import { createNetTransport } from './update/net-transport.js';
import { UpdateService, packageTypeOf } from './update/service.js';

const REMOTE_PARTITION = 'persist:zxdesk';
const SMOKE_TIMEOUT_MS = 15_000;

/**
 * 版本检测接口。默认线上正式地址；`ZXDESK_UPDATE_URL` 只用于联调与自检，
 * 指向本地假接口时不必重新打包（指向 http 也只放行 127.0.0.1）。
 */
const UPDATE_API_URL = String(process.env.ZXDESK_UPDATE_URL || DEFAULT_API_URL).trim();
const UPDATE_CHANNEL = process.env.ZXDESK_UPDATE_CHANNEL === 'beta' ? 'beta' : 'stable';

/** 公告接口（Windows 专属）。同样可用环境变量指向本地假接口做联调。 */
const NOTICE_API_URL = String(process.env.ZXDESK_NOTICE_URL || DEFAULT_NOTICE_URL).trim();

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.join(here, '..', 'shell');
const shellIndex = path.join(shellDir, 'index.html');
const shellBase = new URL(`file://${shellDir.replace(/\\/g, '/')}/`).href;
const iconPath = path.join(shellDir, 'assets', 'icon.ico');

const argv = process.argv.slice(1);
const isDiagnose = argv.includes('--diagnose');
const isSmoke = argv.includes('--smoke');

app.setName('ZXDesk');

// ---------------------------------------------------------------- ② 绿色路径

const isPackaged = app.isPackaged;
const exeDir = path.dirname(app.getPath('exe'));
const devDir = path.join(app.getAppPath(), '.dev-data');
const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');

const dataPaths = resolveDataDir({ isPackaged, exeDir, devDir, localAppData, env: process.env });
const files = dataFiles(dataPaths.dir);
const logger = new Logger(files.bootLog);

logger.info(`启动：${app.getName()} ${app.getVersion()}（Electron ${process.versions.electron}）`);
logger.info(
  `数据目录：${dataPaths.dir}（${dataPaths.mode}${dataPaths.install ? `，安装版 ${dataPaths.install.version || ''}` : ''}）`,
);
if (dataPaths.warning) logger.warn(dataPaths.warning);

// `app.setPath` 必须在 ready 之前；任一失败只影响该子路径，不阻断启动
for (const [key, value] of [
  ['userData', path.join(dataPaths.dir, 'profile')],
  ['sessionData', path.join(dataPaths.dir, 'profile')],
  ['crashDumps', path.join(dataPaths.dir, 'crashes')],
  ['logs', path.join(dataPaths.dir, 'logs')],
]) {
  try {
    fs.mkdirSync(value, { recursive: true });
    app.setPath(key, value);
  } catch (e) {
    logger.warn(`setPath(${key}) 失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- ③ 单实例

const singleInstanceOk = app.requestSingleInstanceLock();
if (!singleInstanceOk && !isDiagnose) {
  logger.warn('已有实例在运行，本次启动退出并把已有窗口拉到前台');
  app.quit();
}

// ---------------------------------------------------------------- 全局兜底

let fatalShown = false;
function fatal(where, error) {
  logger.error(`${where} 出错`, error);
  if (fatalShown || isDiagnose) return;
  fatalShown = true;
  try {
    dialog.showErrorBox(
      'ZXDesk 出错了',
      `${where}：${error?.message || error}\n\n日志：${files.bootLog}\n请把日志与这张截图一起发回。`,
    );
  } catch {
    // 对话框弹不出来（无 GUI 环境）就只留日志 —— 但不静默退出
  }
  app.exit(1);
}

/**
 * 调一个「可能是异步、也可能同步」的主进程动作，并把异常收进日志。
 *
 * ⛔ 不要在这种地方对动作的返回值直接接 `.catch(`：
 * `openNotice()` 是同步方法，返回 null ⇒ `null.catch` 抛 TypeError，
 * 用户看到的是点一下菜单就弹「ZXDesk 出错了」（0.2.2 真机第一次跑就踩到了）。
 */
function fire(action, label) {
  try {
    const result = action();
    if (result && typeof result.then === 'function') {
      result.catch((error) => logger.error(label, error));
    }
  } catch (error) {
    logger.error(label, error);
  }
}

process.on('uncaughtException', (error) => fatal('未捕获异常', error));
process.on('unhandledRejection', (reason) =>
  fatal('未处理的 Promise 拒绝', reason instanceof Error ? reason : new Error(String(reason))),
);

// ---------------------------------------------------------------- 运行时句柄

let mainWindow = null;
let controller = null;
let remoteView = null;
let prefs = null;
let tray = null;
/** 「关闭到托盘」时点 X 只隐藏；真退出前必须把它置 true，否则 app.quit() 会被 close 拦住。 */
let isQuitting = false;

/**
 * 读偏好（窗口尺寸 / 上次地址 / 设备 id）。
 * ⚠️ **必须在 createWindow() 之前**：`createWindow()` 第一行就是 `prefs.get().window`。
 * 0.1.0 把它藏在 buildController 里、又让 createWindow 先跑 ⇒ 首跑直接
 * `Cannot read properties of null (reading 'get')`。
 */
function initPrefs() {
  prefs = new PrefsStore(files.prefs, (m) => logger.warn(m));
  logger.info(`偏好已加载（设备 id 已就绪，窗口 ${prefs.get().window.width}x${prefs.get().window.height}）`);
  return prefs;
}

/**
 * 公告历史窗口（单例）。
 *
 * 为什么单独开窗而不是在壳里画：公告要能滚动看全部历史，壳的 `WebContentsView` 会盖住 DOM，
 * 自绘列表要么藏视图（背后空白），要么被网页盖住。独立窗口没有这个矛盾，也和 Windows 程序的习惯一致。
 */
let noticeWin = null;

function openNoticeWindow() {
  if (noticeWin && !noticeWin.isDestroyed()) {
    if (noticeWin.isMinimized()) noticeWin.restore();
    noticeWin.show();
    noticeWin.focus();
    return;
  }
  noticeWin = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 420,
    minHeight: 420,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    show: false,
    title: '公告',
    backgroundColor: '#F5F7FB',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(shellDir, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  const wc = noticeWin.webContents;
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(shellBase)) {
      event.preventDefault();
      logger.warn(`公告窗口尝试导航到 ${url}，已阻止`);
    }
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());

  noticeWin.once('ready-to-show', () => noticeWin.show());
  noticeWin.on('closed', () => {
    noticeWin = null;
    // 看过就标已读：窗口只有「关闭」与「全部标为已读」两个出口
    controller?.markNoticesRead();
    logger.info('公告窗口已关闭，公告标为已读');
  });

  noticeWin.loadFile(path.join(shellDir, 'notice.html'));
  logger.info('公告窗口已打开');
}

/**
 * 检查更新窗口（单例）。
 *
 * 为什么是独立窗口而不是 `dialog.showMessageBox`：更新要展示版本号、更新说明、**下载进度**，
 * 还要在下载完之后把按钮换成「立即安装」—— 原生消息框是一次性问答，撑不住这个过程。
 * 也不能画在壳里：`WebContentsView` 永远盖在 DOM 之上，自绘弹层要么藏视图（背后白屏）、
 * 要么被网页盖住。独立窗口两头都不占。
 */
let updateWin = null;

function openUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    if (updateWin.isMinimized()) updateWin.restore();
    updateWin.show();
    updateWin.focus();
    return;
  }
  updateWin = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: true,
    show: false,
    title: '检查更新',
    backgroundColor: '#F5F7FB',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(shellDir, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  const wc = updateWin.webContents;
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(shellBase)) {
      event.preventDefault();
      logger.warn(`更新窗口尝试导航到 ${url}，已阻止`);
    }
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());

  updateWin.once('ready-to-show', () => updateWin.show());
  updateWin.on('closed', () => {
    updateWin = null;
    // 关窗不等于放弃更新：下载在主进程继续，下次打开窗口能看到最新进度
    logger.info('更新窗口已关闭');
  });

  updateWin.loadFile(path.join(shellDir, 'update.html'));
  logger.info('更新窗口已打开');
}

/**
 * 打开已校验的更新包。
 * - 安装包（.exe）：交给系统运行安装向导（由用户自己点「下一步」，⛔ 不静默安装）；
 * - 绿色包（.zip）：只定位到文件夹 —— 覆盖解压会替换程序目录，必须由用户自己决定。
 */
async function openDownloadedPackage(filePath) {
  try {
    if (packageTypeOf(path.basename(filePath)) === 'installer') {
      // 安装向导会先把本程序关掉（安装包里调的 taskkill，见 build/installer.nsi 的
      // CloseRunningApp）—— 关之前先把窗口最小化，别让向导被我们挡在后面、
      // 用户以为「点了立即安装没反应」。
      try {
        mainWindow?.minimize?.();
      } catch {
        /* 窗口可能已经销毁，忽略 */
      }
      const message = await shell.openPath(filePath);
      return { ok: !message, message: message || '' };
    }
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) {
    logger.error('打开更新包失败', e);
    return { ok: false, message: e.message || String(e) };
  }
}

function buildController() {
  const secure = new SecureStore({ safeStorage, logger: (m) => logger.warn(m) });
  const sessions = new SessionStore(secure, files.session, (m) => logger.warn(m));
  const credentials = new CredentialStore(secure, files.credential, (m) => logger.warn(m));
  const tofu = new TofuStore(files.tofu, (m) => logger.warn(m));

  // 更新服务：网络走 `net.fetch` / `net.request`（Chromium 网络栈，系统 CA 与代理都生效）
  const updater = new UpdateService({
    currentVersion: app.getVersion(),
    apiUrl: UPDATE_API_URL,
    channel: UPDATE_CHANNEL,
    dir: path.join(dataPaths.dir, 'updates'),
    fetchImpl: (input, init) => net.fetch(input, init),
    transport: createNetTransport(net),
    log: (level, message) => (level === 'warn' ? logger.warn(message) : logger.info(message)),
    // 检查/下载是异步的：此刻 controller 一定已经建好（构造期间不会触发回调）
    onState: () => controller?.push(),
  });

  // 公告：启动先读缓存（菜单立刻有内容），网络回来再刷新
  const notices = new NoticeService({
    apiUrl: NOTICE_API_URL,
    fetchImpl: (input, init) => net.fetch(input, init),
    file: files.notices,
    readIds: prefs.get().noticeReadIds,
    log: (level, message) => (level === 'warn' ? logger.warn(message) : logger.info(message)),
    onState: () => controller?.push(),
  });
  const cachedNotices = notices.loadCache();
  if (cachedNotices) logger.info(`公告缓存已载入：${cachedNotices} 条`);

  remoteView = new RemoteView({
    // session 一定要一起注入：RemoteView.session 在视图未建时要靠它拿 `persist:zxdesk` 分区
    electron: { WebContentsView, shell, session },
    win: mainWindow,
    partition: REMOTE_PARTITION,
    logger,
    onProbe: (page) => {
      fire(() => controller?.onProbe(page), '探针处理失败');
    },
    onLoadFail: ({ code, description, url }) => {
      // 界面只给一句人话；错误码与地址进 detail（只出现在「复制诊断」里）
      controller?.notifyError('打不开页面', '页面没有加载出来，检查网络后点「重试」。', { code, description, url });
    },
    onTitleChange: (title) => {
      if (title) mainWindow?.setTitle('ZXDesk 工作台');
    },
    // 远程视图有焦点时壳收不到 keydown ⇒ 快捷键在主进程截完再转成动作
    onShortcut: (name) => {
      const map = { reload: 'toolbar.reload', back: 'toolbar.back', forward: 'toolbar.forward' };
      fire(() => controller?.action(map[name]), '快捷键动作失败');
    },
  });

  controller = new Controller({
    prefs,
    sessions,
    credentials,
    tofu,
    view: remoteView,
    logger,
    updater,
    notices,
    openUpdateWindow,
    openNoticeWindow,
    setProgress: (value) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(value);
      } catch {
        /* 窗口不在时忽略 */
      }
    },
    revealPackage: openDownloadedPackage,
    // 网盘兜底：地址只来自版本清单（client.js 已校验 http/https），这里只负责交给系统浏览器
    openExternal: async (url) => {
      try {
        await shell.openExternal(String(url));
        return { ok: true };
      } catch (error) {
        logger.warn(`打开网盘地址失败：${error.message}`);
        return { ok: false, message: '打不开浏览器，请手动复制地址访问。' };
      }
    },
    // `/app/ticket` 与 FNID 解析都走 `net.fetch`：它走 **Chromium 网络栈**，
    // 于是自签证书确认（setCertificateVerifyProc）对原生请求同样生效（任务书 §7.5「两条路共用一份判定」）。
    fetcher: (input, init) => net.fetch(input, init),
    cookies: {
      partition: REMOTE_PARTITION,
      apply: (fnSession, target) => applyCookies(fnSession, target, remoteView.session.cookies, (m) => logger.warn(m)),
      // 传 **Session**（不是 session.cookies）：Electron 的 Cookies 没有 clear()
      clear: () => clearCookies(remoteView.session, (m) => logger.warn(m)),
      // 捕获 ZXDesk 网页会话（zxdesk_sid）用；只取名字匹配的那条由 controller 过滤
      get: async (url) => {
        try {
          return await remoteView.session.cookies.get({ url });
        } catch {
          return [];
        }
      },
      // 回注网页会话（参数由 cookies.webSessionSpec 校验 host 后给出）
      setSpec: async (spec) => remoteView.session.cookies.set(spec),
      // 写完数一下分区里到底有几条（只回名字，⛔ 不回值）
      names: async (url) => {
        try {
          const list = await remoteView.session.cookies.get({ url });
          return list.map((c) => c.name);
        } catch {
          return [];
        }
      },
    },
    notify: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zxdesk:state', state);
      // 公告 / 更新窗口订阅同一份状态：已读、下载进度都要立刻反映到它们自己的界面上
      if (noticeWin && !noticeWin.isDestroyed()) noticeWin.webContents.send('zxdesk:state', state);
      if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('zxdesk:state', state);
    },
  });
  controller.logPath = files.bootLog;
  return controller;
}

// ---------------------------------------------------------------- ④ 壳窗口

function createWindow({ smoke = false } = {}) {
  // 护栏：以后谁再把顺序调乱，日志里会是一句人话，而不是 null.get
  if (!prefs) throw new Error('启动顺序错误：prefs 未初始化（应在 createWindow 之前调 initPrefs）');
  const remembered = prefs.get().window;
  mainWindow = new BrowserWindow({
    width: remembered.width,
    height: remembered.height,
    x: remembered.x ?? undefined,
    y: remembered.y ?? undefined,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    center: true,
    title: 'ZXDesk 工作台',
    backgroundColor: '#F5F7FB',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(shellDir, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  logger.info(`壳窗口创建：${remembered.width}x${remembered.height}`);

  const wc = mainWindow.webContents;
  // 壳不允许离开本地页面
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(shellBase)) {
      event.preventDefault();
      logger.warn(`壳尝试导航到 ${url}，已阻止`);
    }
  });
  wc.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('阻止了 webview 挂载');
  });

  mainWindow.once('ready-to-show', () => {
    if (smoke) {
      logger.info('冒烟模式：窗口保持隐藏');
      return;
    }
    if (remembered.maximized) mainWindow.maximize();
    mainWindow.show();
    logger.info('壳窗口已显示');
  });

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds?.() || mainWindow.getBounds();
    prefs?.setWindow({ ...bounds, maximized });
  };

  // 冒烟模式不记窗口尺寸（别把用户的窗口记忆改成一个隐藏窗口的尺寸）
  if (!smoke) {
    mainWindow.on('resize', debounce(saveBounds, 400));
    mainWindow.on('move', debounce(saveBounds, 400));
  }
  // ⚠️ `WebContentsView` **不会**跟着窗口缩放，必须手动 layout（否则最大化后页面还是小的一块）
  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, () => remoteView?.layout?.());
  }
  mainWindow.on('close', saveBounds);
  // 「关闭到托盘」：点 X 只隐藏（真退出要先把 isQuitting 置 true）
  mainWindow.on('close', (event) => {
    if (isQuitting || !prefs?.get().closeToTray) return;
    event.preventDefault();
    mainWindow.hide();
    // 主窗口收进托盘时，公告窗口也一起收起来，别留一个孤零零的窗口
    if (noticeWin && !noticeWin.isDestroyed()) noticeWin.hide();
    ensureTray();
    logger.info('已隐藏到托盘（「关闭到托盘」开着；托盘菜单可退出）');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ⚠️ 页面**不在这里**加载：必须先 buildController（RemoteView 要拿到窗口）再 load，
  // 否则 `did-finish-load` 可能早于装配完成 ⇒ 状态机永远不启动（白屏）。
  return mainWindow;
}

function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// ---------------------------------------------------------------- 远程视图的会话策略

function configureRemoteSession() {
  const remoteSession = session.fromPartition(REMOTE_PARTITION);

  // 自签证书 TOFU：判定与展示都在 Controller（与原生 WS 共用一份规则）
  remoteSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (request.verificationResult === 'net::OK') return callback(-3); // 交给 Chromium 的结论
      const info = describeCertificate(request.certificate?.data || '');
      logger.info(`证书校验：${request.hostname} ${info.subject}（errorCode=${request.errorCode}）`);
      controller
        .requestTrust(request.hostname, {
          subject: info.subject,
          subjectText: info.subject,
          fingerprint256: info.fingerprint256,
        })
        .then((trusted) => callback(trusted ? 0 : -2))
        .catch((e) => {
          logger.error('证书判定失败', e);
          callback(-2);
        });
    } catch (e) {
      logger.error('证书校验异常', e);
      callback(-2);
    }
  });

  // 权限：剪贴板写入 / 定位放行（仅当前 NAS 源），通知 / 麦克风 / 摄像头拒绝
  const allowed = new Set(['clipboard-sanitized-write', 'clipboard-write', 'geolocation']);
  const isCurrentOrigin = (url) => {
    try {
      const base = controller?.entry?.baseUrl;
      if (!base || !url) return false;
      return new URL(url).hostname === new URL(base).hostname;
    } catch {
      return false;
    }
  };

  remoteSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!allowed.has(permission)) return false;
    return isCurrentOrigin(requestingOrigin);
  });

  remoteSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!allowed.has(permission)) return callback(false);
    return callback(isCurrentOrigin(details?.requestingUrl || ''));
  });

  // 下载：交给系统「另存为」（不自己选路径，也不静默存到某个目录）
  remoteSession.on('will-download', (_event, item) => {
    // 不 setSavePath ⇒ Chromium 会弹「另存为」；这里只补个标题，⛔ 不静默存到某个目录
    try {
      item.setSaveDialogOptions?.({ title: '保存文件' });
    } catch {
      /* 旧版本没有这个方法就算了 */
    }
    logger.info(`开始下载：${item.getFilename()}（${item.getTotalBytes()} 字节）`);
    item.once('done', (_e, state) => logger.info(`下载结束：${state}`));
  });

  return remoteSession;
}

// ---------------------------------------------------------------- ⑤ 生命周期

app.whenReady().then(async () => {
  logger.info('app ready');
  try {
    if (isDiagnose) {
      const code = runDiagnose({
        app,
        paths: dataPaths,
        logger,
        singleInstanceOk,
        safeStorageOk: await isSafeStorageAvailable(),
      });
      app.exit(code);
      return;
    }

    if (!singleInstanceOk) return;

    await bootUi({ smoke: isSmoke });
  } catch (e) {
    fatal('启动阶段', e);
  }
});

/**
 * 真实启动路径（正常启动与 `--smoke` **走同一条**，只是冒烟不显示窗口、不连 NAS、跑完退出）。
 *
 * ⚠️ 0.1.0 的 `--smoke` 自己 new 了一个 BrowserWindow 只加载壳页面 ⇒ **绕过了 createWindow/buildController**，
 * 于是「prefs 还没建就 createWindow」这个必崩的错它一点都测不出来（假绿）。现在两条路合一。
 *
 * 顺序由 `boot.js` 固定（可单测）：configureSession → initPrefs → createWindow → buildController
 * → registerIpc → attachHandlers → loadShell。
 */
async function bootUi({ smoke = false } = {}) {
  logger.info(smoke ? '启动（冒烟模式，不联网）' : '启动（正常模式）');
  const sequence = createBootSequence({
    configureSession: configureRemoteSession,
    initPrefs,
    createWindow: () => createWindow({ smoke }),
    buildController,
    registerIpc: () =>
      registerIpc(ipcMain, {
        controller,
        get window() {
          return mainWindow;
        },
        logger,
        isTrustedSender: (event) => String(event.senderFrame?.url || '').startsWith(shellBase),
        copyText: async (text) => {
          clipboard.writeText(text);
          return true;
        },
        onMenu: (which) => showMenu(which),
      }),
    attachHandlers: () => attachShellHandlers({ smoke }),
    loadShell: async () => {
      logger.info(`加载壳页面（${smoke ? '冒烟' : '正常'}）`);
      await mainWindow.loadFile(shellIndex);
    },
  });
  await sequence();

  // 绿色包经常被「解压到下载目录 → 再挪到常用位置」，快捷方式里的绝对路径就过期了。
  // 放在界面起来之后做：失败也不影响使用。
  repairShortcutsIfMoved();
}

/** 壳页面事件：正常模式等加载完再启动状态机；冒烟模式加载完就打印 SMOKE OK 并退出。 */
function attachShellHandlers({ smoke = false } = {}) {
  const wc = mainWindow.webContents;

  if (smoke) {
    const timer = setTimeout(() => {
      console.error(`SMOKE FAIL: ${SMOKE_TIMEOUT_MS / 1000} 秒内没有加载完成`);
      logger.error('冒烟测试超时');
      app.exit(1);
    }, SMOKE_TIMEOUT_MS);

    wc.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      console.error(`SMOKE FAIL: ${code} ${description}`);
      logger.error(`冒烟测试失败：${code} ${description}`);
      app.exit(1);
    });

    wc.once('did-finish-load', () => {
      clearTimeout(timer);
      console.log('SMOKE OK');
      logger.info('冒烟测试通过：壳已加载，进程即将退出');
      app.exit(0);
    });
    return;
  }

  wc.once('did-finish-load', async () => {
    logger.info('壳加载完成');
    try {
      await controller.boot();
      logger.info('状态机就绪');
    } catch (e) {
      logger.error('初始化失败', e);
      controller.notifyError('初始化失败', e.message || String(e));
    }
  });
  wc.once('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    logger.error(`壳加载失败：${code} ${description} ${url}`);
    // 壳本身没加载起来 ⇒ 没有界面可以显示提示，只能交给系统错误框
    try {
      dialog.showErrorBox(
        'ZXDesk 界面没加载起来',
        `请重启应用；一直这样请把日志发回：${files.bootLog}\n（${code} ${description}）`,
      );
    } catch {
      /* 无 GUI 环境：日志里已经有了 */
    }
  });
}

// ---------------------------------------------------------------- 托盘 / 快捷方式 / 开机自启

function shortcutDirs() {
  return shortcutPaths({ desktopDir: app.getPath('desktop'), appDataDir: app.getPath('appData') });
}

function shortcutArgs() {
  // ⚠️ 图标必须指 **exe 自己**（`iconIndex: 0`）：`iconPath` 是
  // `…\\resources\\app.asar\\src\\shell\\assets\\icon.ico` —— asar 里的**虚拟路径**，
  // Windows 外壳读不到，快捷方式就显示成白纸。exe 的图标是 build/apply-icon.js 用 resedit 写进去的。
  return shortcutOptions({ exePath: process.execPath, cwd: exeDir, iconPath: process.execPath, iconIndex: 0 });
}

/** 启动文件夹里有没有我们的 .lnk（勾选态**实时读**，不缓存）。 */
function isAutoStartEnabled() {
  try {
    return fs.existsSync(shortcutDirs().startup);
  } catch {
    return false;
  }
}

/**
 * 移动目录后的快捷方式自愈。
 *
 * `.lnk` 里存的是绝对路径（target 与 icon 都是 `process.execPath`）。绿色包被整个挪走后，
 * 旧快捷方式仍指着老位置 ⇒ 桌面图标变成 Windows 通用白纸、双击也打不开。
 * 这里只碰**我们自己的两个 .lnk**（桌面 + 启动文件夹），指向不对就按当前位置重建；
 * ⛔ 不动用户别的快捷方式，出错只记日志、不阻塞启动。
 */
function repairShortcutsIfMoved() {
  if (!app.isPackaged) return; // 开发态的 exe 是 electron 二进制，别写坏
  const dirs = shortcutDirs();
  const expected = shortcutArgs();
  const targets = [
    ['桌面', dirs.desktop],
    ['开机自启', dirs.startup],
  ];
  for (const [label, file] of targets) {
    try {
      if (!fs.existsSync(file)) continue;
      let existing = null;
      try {
        existing = shell.readShortcutLink(file);
      } catch (e) {
        logger.warn(`读不出${label}快捷方式（当作需要重建）：${e.message}`);
      }
      if (!shortcutNeedsRepair(existing, expected)) continue;
      const ok = shell.writeShortcutLink(file, 'update', expected);
      if (ok) logger.info(`快捷方式自愈：${label} .lnk 指向旧路径，已更新到 ${process.execPath}`);
      else logger.warn(`快捷方式自愈失败：${label}（writeShortcutLink 返回 false）`);
    } catch (e) {
      logger.error(`快捷方式自愈异常：${label}`, e);
    }
  }
}

/** 托盘：图标用现成的 icon.ico，菜单只有「显示主窗口 / 退出」。 */
function ensureTray() {
  if (tray && !tray.isDestroyed?.()) return tray;
  try {
    const image = nativeImage.createFromPath(iconPath);
    tray = new Tray(image.isEmpty?.() ? nativeImage.createEmpty() : image);
    tray.setToolTip('ZXDesk 工作台');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showMainWindow() },
        { type: 'separator' },
        { label: '退出 ZXDesk', click: () => quitApp() },
      ]),
    );
    tray.on('double-click', () => showMainWindow());
    logger.info('托盘图标已创建');
  } catch (e) {
    logger.error('创建托盘图标失败（不影响主窗口使用）', e);
    tray = null;
  }
  return tray;
}

function destroyTray() {
  try {
    tray?.destroy?.();
  } catch {
    /* 已销毁 */
  }
  tray = null;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 真退出（托盘菜单 / 设置菜单都走这里）。 */
function quitApp() {
  isQuitting = true;
  destroyTray();
  app.quit();
}

/** 设置里的三项系统集成：开关状态实时读。 */
function settingsMenuTemplate() {
  const packaged = app.isPackaged;
  const dirs = shortcutDirs();
  return [
    {
      label: '创建桌面快捷方式',
      enabled: packaged,
      click: () => createDesktopShortcut(),
    },
    {
      label: packaged ? '开机自启' : '开机自启（开发态不可用）',
      type: 'checkbox',
      checked: packaged && isAutoStartEnabled(),
      enabled: packaged,
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    {
      label: '自动登录',
      type: 'checkbox',
      checked: prefs?.get().autoLogin !== false,
      click: (item) => {
        prefs.patch({ autoLogin: Boolean(item.checked) });
        logger.info(`自动登录：${item.checked ? '开' : '关'}`);
      },
    },
    {
      label: '关闭到托盘',
      type: 'checkbox',
      checked: prefs?.get().closeToTray === true,
      click: (item) => {
        prefs.patch({ closeToTray: Boolean(item.checked) });
        logger.info(`关闭到托盘：${item.checked ? '开' : '关'}`);
        if (item.checked) ensureTray();
        else {
          // 关掉时如果窗口是隐藏的，先拉出来再销毁托盘，别让用户找不回来
          if (mainWindow && !mainWindow.isVisible()) showMainWindow();
          destroyTray();
        }
      },
    },
    {
      label: '启动时检查更新',
      type: 'checkbox',
      checked: prefs?.get().updateAutoCheck !== false,
      click: (item) => {
        prefs.patch({ updateAutoCheck: Boolean(item.checked) });
        logger.info(`启动时检查更新：${item.checked ? '开' : '关'}`);
      },
    },
    { type: 'separator' },
    { label: '打开启动文件夹', click: () => openStartupFolder(dirs.startupDir) },
    { label: '退出 ZXDesk', click: () => quitApp() },
  ];
}

/**
 * 打开启动文件夹（设置菜单里那一项）。
 *
 * 不在菜单里直接写 `C:\Users\…\Startup` 长路径；打不开/不存在时
 * 才用弹窗把路径与原因显示出来 —— 该给的信息不藏，但别占着菜单。
 */
function openStartupFolder(startupDir) {
  try {
    if (!fs.existsSync(startupDir)) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '启动文件夹不存在',
        message: '还没创建过开机自启的快捷方式，所以启动文件夹里没有东西',
        detail: startupDir,
        buttons: ['好'],
      });
      return;
    }
    const err = shell.openPath(startupDir);
    Promise.resolve(err).then((message) => {
      if (!message) return; // 空字符串 = 成功
      logger.warn(`打开启动文件夹失败：${message}`);
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '打不开启动文件夹',
        message: message,
        detail: startupDir,
        buttons: ['好'],
      });
    });
  } catch (e) {
    logger.error('打开启动文件夹异常', e);
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '打不开启动文件夹',
      message: e.message,
      detail: startupDir,
      buttons: ['好'],
    });
  }
}

function createDesktopShortcut() {
  if (!app.isPackaged) {
    logger.warn('开发态不创建快捷方式（target 会指向 electron 二进制）');
    return;
  }
  const file = shortcutDirs().desktop;
  try {
    const ok = shell.writeShortcutLink(file, shortcutOperation(fs.existsSync(file)), shortcutArgs());
    if (ok) {
      logger.info(`桌面快捷方式已创建：${file}`);
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '已创建',
        message: '已在桌面创建快捷方式',
        detail: file,
        buttons: ['好'],
      });
    } else {
      logger.error(`创建快捷方式失败：${file}`);
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '创建失败',
        message: '创建快捷方式失败（返回 false）',
        detail: `路径：${file}\n如果被安全软件拦了，请允许后再试一次。`,
        buttons: ['好'],
      });
    }
  } catch (e) {
    logger.error('创建快捷方式异常', e);
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '创建失败',
      message: '创建快捷方式时出错',
      detail: `${e.message}\n\n路径：${file}`,
      buttons: ['好'],
    });
  }
}

/** 开机自启 = 启动文件夹里放/删 .lnk（⛔ 不写注册表）。 */
function setAutoStart(enabled) {
  if (!app.isPackaged) {
    logger.warn('开发态不改开机自启');
    return;
  }
  const file = shortcutDirs().startup;
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const ok = shell.writeShortcutLink(file, shortcutOperation(fs.existsSync(file)), shortcutArgs());
      logger.info(`开机自启：${ok ? '已开' : '开失败'}（${file}）`);
      if (!ok) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '开机自启设置失败',
          message: '写入启动文件夹失败（返回 false）',
          detail: file,
          buttons: ['好'],
        });
      }
    } else {
      fs.rmSync(file, { force: true });
      logger.info(`开机自启：已关（${file}）`);
    }
  } catch (e) {
    logger.error('设置开机自启失败', e);
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '开机自启设置失败',
      message: e.message,
      detail: file,
      buttons: ['好'],
    });
  }
}

/** 帮助菜单里的公告条目：有未读就把条数写进菜单文字。 */
function noticeMenuLabel() {
  const unread = controller?.getState()?.notices?.unread || 0;
  return unread > 0 ? `公告（${unread} 条未读）` : '公告';
}

/** 「帮助 → 检查更新」是否要标「有新版本」：菜单是点开时现构建的，读的是最新状态。 */
function hasUpdate() {
  const updater = controller?.getState()?.update;
  return Boolean(updater && updater.available && !updater.skipped);
}

/**
 * 顶栏文字菜单（连接 / 视图 / 帮助）。
 *
 * 用原生 `Menu.popup`：壳只发一个 `openMenu(which)`，菜单项与动作都在主进程 —— 壳里没有菜单逻辑，
 * 也就没有「自绘下拉层被 WebContentsView 盖住」的问题。
 */
function showMenu(which) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const act = (type) => () => fire(() => controller?.action(type), `菜单动作失败：${type}`);
  const zoom = (delta) => {
    try {
      const wc = remoteView?.webContents;
      if (!wc) return;
      if (delta === 0) wc.setZoomLevel(0);
      else wc.setZoomLevel(Math.max(-3, Math.min(3, (wc.getZoomLevel?.() || 0) + delta)));
    } catch (e) {
      logger.error('缩放失败', e);
    }
  };

  const templates = {
    settings: () => settingsMenuTemplate(),
    connect: [
      { label: '连接信息…', click: act('panel.open') },
      { label: '刷新页面', click: act('toolbar.reload') },
      { type: 'separator' },
      { label: '换个地址', click: act('panel.changeAddress') },
      { label: '退出登录', click: act('panel.logout') },
    ],
    view: [
      { label: '后退 (Alt+←)', enabled: Boolean(remoteView?.canGoBack?.()), click: act('toolbar.back') },
      { label: '前进 (Alt+→)', enabled: Boolean(remoteView?.canGoForward?.()), click: act('toolbar.forward') },
      { label: '刷新 (F5 / Ctrl+R)', click: act('toolbar.reload') },
      { type: 'separator' },
      { label: '放大', click: () => zoom(0.5) },
      { label: '缩小', click: () => zoom(-0.5) },
      { label: '重置缩放', click: () => zoom(0) },
    ],
    help: [
      {
        // 菜单是点开时现构建的，所以未读条数能实时读到
        label: noticeMenuLabel(),
        // openNotice 是同步方法（只负责开窗），走 fire 兜住，别在这写 .catch
        click: () => fire(() => controller?.openNotice(), '打开公告失败'),
      },
      {
        // DSH 同款：有新版本就在菜单项上标出来（浏览网页时没有提示条，这里是唯一信号）
        label: `检查更新${hasUpdate() ? '（有新版本）' : ''}…`,
        click: () => fire(() => controller?.openUpdate(), '检查更新失败'),
      },
      {
        label: `关于 ZXDesk（${app.getVersion()}）`,
        click: () =>
          dialog.showMessageBox(win, {
            type: 'info',
            title: '关于 ZXDesk',
            message: `ZXDesk 工作台 ${app.getVersion()}`,
            detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}\n\n数据目录：${dataPaths.dir}`,
            buttons: ['好'],
          }),
      },
      {
        label: '复制诊断',
        click: () => {
          clipboard.writeText(controller?.diagnosticsText() || '');
          logger.info('诊断信息已复制');
        },
      },
      {
        label: '打开日志目录',
        click: () => shell.openPath(path.dirname(files.bootLog)).catch((e) => logger.error('打开日志目录失败', e)),
      },
    ],
  };

  const raw = templates[which];
  if (!raw) return;
  const template = typeof raw === 'function' ? raw() : raw;
  Menu.buildFromTemplate(template).popup({ window: win });
}

app.on('second-instance', () => {
  logger.info('第二个实例启动，聚焦已有窗口');
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (!isQuitting && prefs?.get().closeToTray) {
    logger.info('窗口都关了，但「关闭到托盘」开着 —— 进程留在托盘');
    return;
  }
  logger.info('所有窗口已关闭，退出');
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    controller?.flow?.close?.();
  } catch {
    /* 退出时失败无需处理 */
  }
});

async function isSafeStorageAvailable() {
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') return await safeStorage.isAsyncEncryptionAvailable();
    return Boolean(safeStorage.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}
