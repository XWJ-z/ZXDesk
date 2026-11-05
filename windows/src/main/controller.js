/**
 * ZXDesk工作台 Windows 客户端
 * 文件：controller.js
 * 职责：壳的状态机（主进程侧）
 *
 * 一句话：**所有网络与凭据都在这里**，壳只负责显示与转发动作。
 *
 * 四步引导（F1）：mode → connect →（twofa）→（access）→ browsing。
 * 证书确认（F7）、连接面板（F10）、错误页（F16）都是「隐藏远程视图 → 壳整窗显示」，
 * ⛔ 不做浮层（`WebContentsView` 永远画在 DOM 之上，浮层盖不住它）。
 */

import { pickGatewayCookies, pickWebSession, webSessionSpec, mergeCookieHeader } from './browser/cookies.js';
import { ConnectGuard } from './connection/guard.js';
import { GATEWAY_PAGE, probeGateway } from './connection/gateway.js';
import { isPrivateAddress, planConnection, DIRECT_PORT, DEFAULT_GATEWAY_PATH } from './connection/planner.js';
import { portalUrlFor, resolveFnId } from './connection/fnid.js';
import { TARGET_KIND, parseInput } from './connection/input.js';
import { FnLoginFlow, FnSession } from './login/flow.js';
import { LOGIN_STEP, LoginError } from './login/errno.js';
import { AccessCodeRequiredError, WsClient } from './login/wsclient.js';
import { SavedSession } from './store/session.js';
import { TRUST, decideTrust } from './tls/tofu.js';

export const APP_VERSION = '0.2.6';

const LINK_RELAY = '飞牛中继';
const LINK_LAN = '局域网直连';
const LINK_GATEWAY = '网关域名';
const LINK_LAN_GATEWAY = '局域网网关';

/** 回前台探活的间隔：15 秒内重复回前台只探一次（⛔ 别每次切窗都打一次 NAS）。 */
const PROBE_INTERVAL_MS = 15_000;
/** 静默重连的间隔：30 秒内只试一次，避免自己撞风控（Android 同口径）。 */
const SILENT_RECOVER_MS = 30_000;
/** 「页面像访问码页」的切屏间隔：8 秒内只切一次，防判定抖动把界面来回跳（Android 同口径）。 */
const ACCESS_CODE_SWITCH_MS = 8_000;
/**
 * 访问码屏的轮询间隔：700ms（与 Android `AccessCodeScreen` 一致）。
 * 过了访问码后网关可能回纯文本 `invalid token` —— 那一页不会再有加载事件，只能轮询。
 */
const ACCESS_POLL_MS = 700;
/** 连续几次「不是访问码页」才算真的过了（滤掉网关的跳转中间页，Android 同为 2 次）。 */
const ACCESS_CONFIRM_TIMES = 2;
/**
 * 访问码最多来回几轮（照 Android `MAX_ACCESS_CODE_ROUNDS`）。
 * 访问码 → 重登 → 又被 401，最多两轮；第三轮停下、回连接页把原因写清 —— ⛔ 不让界面无限转。
 */
const MAX_ACCESS_CODE_ROUNDS = 2;
/** 冷却提示的开头（用来判断这条错误是不是我们自己写的倒计时）。 */
const COOLDOWN_HINT = '连接太频繁';

/**
 * @param {object} deps
 * @param {object} deps.prefs - `PrefsStore`
 * @param {object} deps.sessions - `SessionStore`
 * @param {object} deps.credentials - `CredentialStore`
 * @param {object} deps.tofu - `TofuStore`
 * @param {object} deps.view - `RemoteView`
 * @param {object} deps.cookies - `{apply(session, target), clear()}`
 * @param {object} deps.logger
 * @param {Function} deps.notify - `(state) => void`（推给壳）
 * @param {Function} [deps.fetcher]
 * @param {Function} [deps.rpcFactory]
 */
export class Controller {
  constructor(deps) {
    this.prefs = deps.prefs;
    this.sessions = deps.sessions;
    this.credentials = deps.credentials;
    /** 账号清单（明文，只存地址/账号）：撑起「文件 → 切换账号」。没注入时菜单不显示这一项。 */
    this.accounts = deps.accounts || null;
    /** 网关凭据（访问码 Cookie）的跨启动副本；没注入时「每次启动重输访问码」的老问题会回来。 */
    this.gatewayCookies = deps.gatewayCookies || null;
    this.tofu = deps.tofu;
    this.view = deps.view;
    this.cookies = deps.cookies;
    // ⚠️ logger 有两种传法：函数 `(msg) => void`，或 Logger 实例（有 .info/.warn/.error）。
    // 0.1.2 就是这里没归一：生产传的是 Logger 实例，而代码里写 `this.log('…')` ⇒
    // 点第一步就 TypeError: this.logger is not a function。现在统一收成两个函数，内部只用它们。
    const rawLogger = deps.logger;
    this.log =
      typeof rawLogger === 'function' ? rawLogger : (message) => rawLogger?.info?.(String(message));
    this.logError =
      typeof rawLogger === 'function'
        ? (message, error) => rawLogger(error ? `${message}：${error?.message || error}` : message)
        : (message, error) => rawLogger?.error?.(message, error);
    this.notify = deps.notify || (() => {});
    this.fetcher = deps.fetcher;
    /**
     * 探测网关专用的 fetch：绑定**远程视图那个分区**（`persist:zxdesk`），Cookie 由浏览器自己带。
     *
     * ⚠️ `net.fetch` 用的是**默认 session**：既拿不到分区里的访问码凭据，自签证书也不走 TOFU。
     * 0.2.4 第一版就是拿它探网关 —— 开了访问码的 NAS 上探测结果永远是「要访问码」，
     * 于是登录成功后又被送回第 ④ 步，来回几次才进得去。
     * 注入后用 `ses.fetch`：访问码凭据、新会话、证书判定都与页面完全一致（Android 用 CookieManager 同义）。
     */
    this.probeFetcher = deps.probeFetcher || null;
    this.rpcFactory = deps.rpcFactory;
    /** 更新服务（`UpdateService`）。没注入时界面不显示更新入口，其余功能不受影响。 */
    this.updater = deps.updater || null;
    /** 公告服务（`NoticeService`）。 */
    this.notices = deps.notices || null;
    /**
     * 打开「更新 / 公告」窗口（主进程实现）。
     * ⛔ 不用原生消息框：更新要展示进度与按钮切换，公告要能滚动看历史，都不是一次性问答能表达的。
     */
    this.openUpdateWindow = deps.openUpdateWindow || null;
    this.openNoticeWindow = deps.openNoticeWindow || null;
    /** 下载 / 打开安装包的失败文案：显示在更新窗口状态行。 */
    this.updateActionError = null;
    /** 用系统浏览器打开外链（网盘兜底）。注入后「前往网盘下载」按钮才有反应。 */
    this.openExternal = deps.openExternal || null;
    /** 任务栏进度（0~1，-1 清除，2 不确定）。 */
    this.setProgress = deps.setProgress || null;
    this.lastProgress = null;
    this.revealPackage = deps.revealPackage || null;

    this.state = this.baseState();
    this.flow = null;
    this.pendingEntry = null;
    this.pendingAddress = '';
    this.pendingCredential = null;
    this.pendingCert = null;
    this.certWaiters = [];
    this.triedLongToken = false;
    this.triedPasswordRelogin = false;
    this.resendTimer = null;
    this.session = null;
    this.entry = null;
    /** 最近一次登录失败（只给「复制诊断」用，⛔ 不上屏）。 */
    this.lastAttempt = null;

    /** 会话恢复是否正在进行（防重入：探针 / 页面拦截 / 回前台会同时触发）。 */
    this.recovering = false;
    /**
     * 「登录结果」的世代号：退出登录 / 换个地址时 +1。
     *
     * ⚠️ 静默重连是异步的（longToken → 密码重登 → 落盘 → 探网关，几百毫秒到几秒）。
     * 这期间用户完全可能点了「退出登录」：旧逻辑会在恢复成功后再 `enterBrowsing` 一次、
     * 并把 `signedOut` 改回 false —— 等于「退出」被撤销，人又被送回主界面。
     * 所以登录结果落地前必须核对世代号，不是同一代就整份丢弃。
     */
    this.authEpoch = 0;
    /**
     * 这一轮浏览有没有**真的进过应用**（探针判过一次 `APP`）。
     *
     * 用途只有一个：区分「用着用着会话过期了」（该静默续，别打断）与「一进来就是
     * `invalid token` 白屏」（静默失败会把用户钉在一张没有按钮的纯文本页上，必须回登录页）。
     * 0.2.4 的冷启动会话失效就是后者：静默重连失败后只剩菜单栏一行小字，用户找不到出口。
     */
    this.enteredApp = false;
    /** 回前台探活是否正在进行。 */
    this.probing = false;
    /** 上次探活 / 上次恢复的时刻（防抖，见 PROBE_INTERVAL_MS / SILENT_RECOVER_MS）。 */
    this.lastProbeAt = 0;
    this.lastRecoverAt = 0;
    /** 上次因为「页面像访问码页」切走的时刻（防判定抖动）。 */
    this.lastAccessCodeSwitchAt = 0;
    /** 访问码屏上「连续几次探针都不是访问码页」：两次才继续（滤掉网关的跳转中间页）。 */
    this.accessProbeHits = 0;
    /** 访问码屏的轮询定时器（700ms，与 Android 同节奏）。 */
    this.accessPollTimer = null;
    this.accessPollBusy = false;
    /** 连接节流：飞牛风控是**按来源 IP + 账号**记的，重启应用不会清零，所以计数落盘。 */
    this.guard = new ConnectGuard(this.prefs);
    /** 冷却提示的刷新定时器（每秒重算剩余秒数，走完自动抹掉）。 */
    this.cooldownTimer = null;
    /**
     * 访问码已经来回几轮 + 自动判定是否已经用过一次（照 Android `onAccessCodeDone` 的两道闸）。
     * ⚠️ 「访问码通过后自动重登」属于同一串磋商的继续，重登时**不清零** —— 清了上限就形同虚设。
     */
    this.accessCodeRounds = 0;
    this.accessCodeAutoPassed = false;
    /** 本次 connect 是不是「访问码通过后的重登」（决定要不要清零轮次）。 */
    this.reloginFromAccessCode = false;
  }

  baseState() {
    return {
      schema: 1,
      version: APP_VERSION,
      // 启动先是「正在启动…」：静默启动时不该先闪一屏登录表单（Android 的启动动画同口径）
      screen: 'starting',
      starting: { progress: '正在启动…', note: null },
      mode: 'nas',
      notice: null,
      connect: {
        address: '',
        https: true,
        user: '',
        password: '',
        showPassword: false,
        rememberPassword: true,
        hasSavedPassword: false,
        busy: false,
        progress: null,
        error: null,
      },
      twofa: null,
      cert: null,
      error: null,
      panel: null,
      /**
       * 「切换账号」弹窗（0.2.6）。非 null = 弹窗开着，内容见 `openAccounts()`。
       * ⚠️ 它在网页之上：打开时必须先把远程视图藏起来 —— `WebContentsView` 永远画在 DOM 之上。
       */
      accounts: null,
      browsing: null,
      diagnostics: '',
    };
  }

  // ---------------------------------------------------------------- 状态广播

  push() {
    this.syncProgress();
    try {
      this.notify(this.snapshot());
    } catch (e) {
      this.log(`状态推送失败：${e.message}`);
    }
  }

  /**
   * 任务栏进度：下载中显示百分比（拿不到总量时用不确定态），其余时候清掉。
   * 只在值变化时调用 —— 每次状态推送都写一遍任务栏没有意义。
   */
  syncProgress() {
    if (!this.setProgress) return;
    const state = this.updater?.snapshot();
    let value = -1;
    if (state?.phase === 'downloading') {
      const percent = Number(state.progress?.percent);
      value = Number.isFinite(percent) && percent > 0 ? percent / 100 : 2;
    }
    if (value === this.lastProgress) return;
    this.lastProgress = value;
    try {
      this.setProgress(value);
    } catch {
      /* 窗口不在时忽略 */
    }
  }

  snapshot() {
    const base = JSON.parse(JSON.stringify(this.state));
    base.update = this.updateUi();
    // ⚠️ 字段名必须是 notices（复数）：state.notice 是「一次性提示文案」，两者不能同名
    base.notices = this.noticeUi();
    return base;
  }

  getState() {
    return this.snapshot();
  }

  patch(partial) {
    this.state = { ...this.state, ...partial };
    this.push();
  }

  patchConnect(partial) {
    this.state = { ...this.state, connect: { ...this.state.connect, ...partial } };
    this.push();
  }

  patchTwofa(partial) {
    if (!this.state.twofa) return;
    this.state = { ...this.state, twofa: { ...this.state.twofa, ...partial } };
    this.push();
  }

  // ---------------------------------------------------------------- 启动

  /**
   * 冷启动，三条路（照 Android 0.2.17 的静默启动）：
   * ① 有加密快照 → 直接进 ZXDesk（Cookie 已随快照带进去，多数情况连 WS 都不用建）；
   * ② 没有快照、但本机记着这台设备的密码 → 在「正在启动…」里自己登一次；
   * ③ 都不行 → 第 ① 步（地址 / 账号预填）。
   */
  async boot() {
    this.scheduleUpdateCheck();
    this.scheduleNoticeCheck();
    const saved = await this.sessions.load();
    if (saved && saved.baseUrl) {
      // 上次是用户主动「退出登录」：退出时已经清了快照，这里再兜一次
      // （万一是「记了退出标记但没来得及清快照」——例如退出那一下进程被杀）
      if (this.prefs.get().signedOut) {
        this.log('上次是主动退出，清掉遗留的会话快照');
        this.sessions.clear();
        this.showConnect('已退出登录，请重新登录');
        return;
      }
      // 「设置 → 自动登录」关掉：快照留着，但不自动进（用户手动连一次会覆盖它）
      if (this.prefs.get().autoLogin === false) {
        this.log('自动登录已关闭，不恢复上次会话');
        this.showConnect('自动登录已关闭（可在「设置」里打开）');
        return;
      }
      // ⚠️ 0.1.5 曾在这里「从 FNID 结果里挑 ipv4 当局域网地址、优先连 64999」，那是自创机制：
      // Android 的 `NasDataSource.fromFnId` **只走中继**，`fn/con` 里的 `ipv4` 也未必是 NAS 的内网地址
      // （实测拼出 `10.1.2.4:64999` 根本连不上）。0.1.6 收尾整段回退，快照里存什么就连什么。
      this.log(`发现上次会话，直接进入浏览模式（${saved.baseUrl}）`);
      this.showStarting('正在恢复上次连接…');
      await this.enterBrowsing(saved, null);
      return;
    }
    if (await this.autoLoginOnBoot()) return;
    this.showMode();
  }

  /** 「正在启动…」：静默启动 / 自动登录时先给人一句人话，⛔ 不先闪登录表单。 */
  showStarting(progress, note = null) {
    this.stopAccessPoll();
    this.state = {
      ...this.baseState(),
      screen: 'starting',
      starting: { progress: progress || '正在启动…', note: note || null },
      connect: this.connectFormState(note || null),
    };
    this.push();
    this.view.setVisible(false);
  }

  /**
   * 启动时的静默自动登录：用「上次的地址 ＋ 账号 ＋ 记住的密码」直接走一遍原生登录。
   *
   * 三条判据，缺一条都不登（⛔ 不能为了「看起来快」去撞风控，Android 同口径）：
   * ① 本机存着这一对地址 / 账号的密码；② 上次不是用户主动「退出登录」；③ 自动登录开关没关。
   *
   * @returns {Promise<boolean>} true = 已经接手（成功进应用 / 要 2FA、访问码就转对应屏 / 失败回登录页）
   */
  async autoLoginOnBoot() {
    const prefs = this.prefs.get();
    if (prefs.autoLogin === false) return false;
    // 上一次是用户自己点的「退出登录」：⛔ 不能重开应用又把人自动登回去
    if (prefs.signedOut) {
      this.log('静默启动：上次是主动退出，跳过自动登录');
      return false;
    }
    const address = String(prefs.lastAddress || '').trim();
    const user = String(prefs.lastUser || '').trim();
    if (!address || !user) return false;

    // 多账号：按「这台设备 + 这个账号」精确取，⛔ 不能用「最近保存的那一条」
    // （同时记着两台 NAS 的密码时，最近那条多半不是当前这台）
    const saved = await this.credentialFor(address, user);
    if (!saved) {
      this.log('静默启动：没有与上次地址 / 账号匹配的密码，回登录页');
      return false;
    }

    const parsed = parseInput(address);
    if (parsed.kind === 'invalid') {
      this.log(`静默启动：地址不认识（${parsed.reason}），回登录页`);
      this.showConnect(`自动登录失败：${parsed.reason}`);
      return true;
    }

    this.log(`静默启动：用记住的密码自动登录 ${user} @ ${address}`);
    this.showStarting('正在自动登录…');
    this.pendingAddress = address;
    this.lastForm = {
      address,
      https: prefs.preferHttps,
      user,
      password: saved.password,
      showPassword: false,
      rememberPassword: prefs.rememberPassword,
    };
    // remember: null = 本次不动已存凭据（自动登录不是用户这次的选择，Android 同口径）
    this.pendingCredential = { user, password: saved.password, remember: null, address };

    let entry = null;
    try {
      const plan = await this.resolvePlan(parsed, { https: prefs.preferHttps });
      if (plan.error) {
        this.log(`静默启动：${plan.error}`);
        this.showConnect(`自动登录失败：${plan.error}`);
        return true;
      }
      entry = plan.entry;
      await this.inheritDeviceState(entry);
      // 预检前回注访问码凭据（同 connect()）
      await this.applySessionCookies(entry);
      if (entry.flow === 'DIRECT') {
        await this.enterBrowsing(entry, null);
        return true;
      }
      // 与手动连接同一条顺序：先问访问码，再验证密码
      if (await this.gatewayNeedsAccessCode(entry)) {
        this.log('静默启动：网关要访问码，先过码再验证密码');
        await this.showAccessCode(entry, '先输入访问码，通过后再验证飞牛账号');
        return true;
      }
      await this.runLogin(entry);
    } catch (e) {
      if (e instanceof AccessCodeRequiredError) {
        // 访问码要人来输：这一屏必须露出来
        this.log(`静默启动：网关要求访问码（HTTP ${e.status || '401'})，进第 ④ 步`);
        await this.showAccessCode(entry, '网关要访问码，先在下面输入');
        return true;
      }
      this.log(`静默启动失败：${e?.message || e}`);
      this.failLogin(e, { auto: true });
      this.patchConnect({ error: '自动登录失败，请重新登录' });
    }
    return true;
  }

  connectFormState(notice = null) {
    const prefs = this.prefs.get();
    return {
      address: prefs.lastAddress,
      https: prefs.preferHttps,
      user: prefs.lastUser,
      password: '',
      showPassword: false,
      rememberPassword: prefs.rememberPassword,
      hasSavedPassword: this.credentials.has(),
      busy: false,
      progress: null,
      error: null,
      notice,
    };
  }

  showMode() {
    this.stopAccessPoll();
    this.state = { ...this.baseState(), screen: 'mode', connect: this.connectFormState() };
    this.push();
  }

  showConnect(notice = null) {
    this.stopAccessPoll();
    this.state = { ...this.state, screen: 'connect', connect: this.connectFormState(notice), twofa: null, cert: null, error: null, accounts: null };
    this.push();
    this.view.setVisible(false);
    // ⚠️ 0.1.3 只在 next() 里预填 ⇒ 「换个地址 / 退出登录 / 会话失效 / 错误页返回」全都拿到空密码。
    // 现在所有回连接页的路径都走这里，统一触发一次（不阻塞渲染）。
    void this.prefillPassword();
  }

  /**
   * 预填记住的密码（地址 + 账号都对得上才填，⛔ 别张冠李戴）。
   * 地址比较做归一化（trim / 去尾部斜杠 / 小写）；「记住密码」关掉时直接不填。
   */
  async prefillPassword() {
    const form = this.state.connect;
    if (!form.rememberPassword) {
      this.log('密码预填：跳过（「记住密码」没勾）');
      return;
    }
    if (!form.address || !form.user) {
      this.log(`密码预填：跳过（表单还没地址/账号：地址=${form.address || '空'}，账号=${form.user || '空'}）`);
      return;
    }
    // 多账号：只填「这台设备 + 这个账号」那一条，⛔ 别张冠李戴
    const saved = await this.credentialFor(form.address, form.user);
    // ⛔ 只记「有/无」和地址账号，绝不记密码值
    this.log(`密码预填：${saved ? '命中' : '未命中'}（地址=${form.address}，账号=${form.user}）`);
    if (saved) this.patchConnect({ password: saved.password, hasSavedPassword: true });
  }

  // ---------------------------------------------------------------- 动作入口

  async action(type, payload = {}) {
    // 入口先记一行：下次 boot.log 能直接看到「点了什么」——0.1.1 的 2FA 空操作就是因为一条动作日志都没有
    this.log(`动作：${type}`);
    try {
      switch (type) {
        case 'mode.select':
          return this.selectMode(payload.mode);
        case 'flow.next':
          return this.next();
        case 'flow.back':
          return this.back();
        case 'connect.input':
          return this.patchConnect({ ...payload, error: null });
        case 'connect.submit':
          return await this.connect(payload);
        case 'connect.togglePassword':
          return this.patchConnect({ showPassword: !this.state.connect.showPassword });
        case 'connect.remember':
          return this.setRemember(payload.value);
        case 'connect.clearSaved': {
          // 多账号：只清**当前表单这一对**地址 / 账号，⛔ 别把别的账号的密码一起清了
          const form = this.state.connect || {};
          await this.credentials.clear(form.address, form.user);
          return this.patchConnect({ hasSavedPassword: false, password: '' });
        }
        case 'account.switch':
          return await this.switchAccount(payload);
        // 「切换账号」弹窗（连接页的按钮与「文件 → 切换账号」共用这一套）
        case 'accounts.open':
          return this.openAccounts(payload || {});
        case 'accounts.close':
          return this.closeAccounts();
        case 'accounts.toggleAdd':
          return this.toggleAddAccount(payload?.value);
        case 'accounts.input':
          return this.patchAccountForm(payload || {});
        case 'accounts.submit':
          return await this.addAccount(payload || {});
        case 'twofa.trust':
          return this.patchTwofa({ trustDevice: Boolean(payload.value) });
        case 'twofa.showEmail':
          return this.patchTwofa({ emailView: true, error: null });
        case 'twofa.showTotp':
          return this.patchTwofa({ emailView: false, error: null });
        case 'twofa.totp':
          return this.patchTwofa({ totp: String(payload.value || '').replace(/\D/g, '').slice(0, 6), error: null });
        case 'twofa.email':
          return this.patchTwofa({ email: String(payload.value || ''), error: null });
        case 'twofa.code':
          return this.patchTwofa({ emailCode: String(payload.value || '').trim().slice(0, 16), error: null });
        case 'twofa.submitTotp':
          return await this.submitTotp(payload.code);
        case 'twofa.sendEmail':
          return await this.sendEmailCode();
        case 'twofa.submitEmail':
          return await this.submitEmailCode(payload.email, payload.code);
        case 'access.done':
          return this.onAccessCodeDone();
        case 'access.reload':
          return this.view.reload();
        case 'cert.decide':
          return this.decideCert(Boolean(payload.trust));
        case 'panel.open':
          return this.openPanel();
        case 'panel.close':
          return this.closePanel();
        case 'panel.refresh':
          this.closePanel();
          return this.view.reload();
        case 'panel.changeAddress':
          // 换地址只是换个目标，**记住的密码要留着**（0.1.4 把它一起清了，于是预填永远未命中）
          return this.logout({ keepSession: false, keepCredentials: true, note: '换个地址重连' });
        case 'panel.logout':
          // 只清会话 / Cookie / webSession；**记住的密码留着**（要彻底清走连接页的「清除」或取消勾选）
          return this.logout({ keepSession: false, keepCredentials: true, note: '已退出登录', signedOut: true });
        case 'toolbar.back':
          return this.view.goBack();
        case 'toolbar.forward':
          return this.view.goForward();
        case 'toolbar.reload':
          return this.view.reload();
        case 'update.open':
          return await this.openUpdate();
        case 'update.check':
          return await this.checkUpdate();
        case 'update.download':
          return await this.downloadUpdate();
        case 'update.run':
          return await this.openUpdateFile();
        case 'update.pan':
          return await this.openFallback();
        case 'update.skip':
          return this.skipUpdate();
        case 'notice.open':
          return await this.openNotice();
        case 'notice.read':
          return this.markNoticesRead();
        case 'error.retry':
          // 浏览中原页重载；连接阶段拿上次表单原样重跑（FNID 会重新解析，DNS 恢复后能直接连上）
          if (this.state.screen === 'browsing' || this.state.screen === 'access') return this.retryBrowsing();
          if (this.lastForm?.address) return await this.connect(this.lastForm);
          return this.showConnect(this.state.connect.notice);
        case 'error.changeAddress':
          return this.logout({ keepSession: true, note: null });
        default:
          this.log(`未知动作：${type}`);
          return null;
      }
    } catch (e) {
      this.logError(`动作 ${type} 失败`, e);
      this.notifyError('操作失败', e.message || '未知错误');
      return null;
    }
  }

  selectMode(mode) {
    if (mode !== 'nas') {
      this.patch({ notice: `「${mode === 'local' ? '仅本机' : '混合'}」还在规划中，先用「仅连接 NAS」吧。` });
      return;
    }
    this.patch({ mode: 'nas', notice: null });
  }

  next() {
    this.patch({ screen: 'connect', notice: null });
    this.prefillPassword();
  }

  /** 逐级回退（⛔ 不直接退出）。 */
  back() {
    const screen = this.state.screen;
    if (screen === 'connect') return this.showMode();
    if (screen === 'twofa') return this.cancelTwoFactor();
    if (screen === 'access') {
      this.stopAccessPoll();
      const entry = this.pendingEntry || this.entry;
      // 登录**后**被网关拦的访问码：返回 = 回应用（Android 同口径）；
      // 登录**前**被 401 挡回来的：没有两步验证可退，回连接页（⛔ 别把人丢到空屏）。
      if (entry?.session?.token) return this.enterBrowsing(entry, null);
      this.pendingEntry = null;
      return this.showConnect(null);
    }
    if (screen === 'cert') return this.decideCert(false);
    return null;
  }

  setRemember(value) {
    this.prefs.patch({ rememberPassword: Boolean(value) });
    this.patchConnect({ rememberPassword: Boolean(value), hasSavedPassword: value ? this.state.connect.hasSavedPassword : false });
    // 取消勾选 ⇒ 立刻清除已存密码（不等下次保存）。
    // ⚠️ 只清当前表单这一对：多账号下把别的账号的密码一起清掉是数据事故。
    if (!value) {
      const form = this.state.connect || {};
      void this.credentials.clear(form.address, form.user);
    }
  }

  // ---------------------------------------------------------------- 多账号

  /**
   * 取「这台设备 + 这个账号」的记住密码。
   *
   * 优先用凭据存储的 `loadFor`（多条存储的精确检索）；注入的是一个只实现了单条接口的旧装配时，
   * 退回 `load()` ＋ 比对 —— ⛔ 不让「少一个方法」变成登录链上的 TypeError。
   */
  async credentialFor(address, user) {
    if (typeof this.credentials.loadFor === 'function') return this.credentials.loadFor(address, user);
    const saved = await this.credentials.load?.();
    if (!saved) return null;
    if (normalizeAddress(saved.address) !== normalizeAddress(address)) return null;
    if (user && saved.user !== user) return null;
    return saved;
  }

  /** 菜单用：账号清单（最近用的在前）＋ 哪一个是当前账号。 */
  menuAccounts() {
    const list = this.accounts?.list?.() || [];
    const lastAddress = normalizeAddress(this.prefs.get().lastAddress);
    const lastUser = String(this.prefs.get().lastUser || '');
    return list.map((item) => ({
      address: item.address,
      user: item.user,
      https: item.https !== false,
      current: normalizeAddress(item.address) === lastAddress && String(item.user) === lastUser,
    }));
  }

  /** 「新增账号」表单的初值（地址不预填：新增的通常是另一台设备）。 */
  accountFormDefaults() {
    const prefs = this.prefs.get();
    return {
      address: '',
      https: prefs.preferHttps !== false,
      user: '',
      password: '',
      showPassword: false,
      rememberPassword: prefs.rememberPassword !== false,
    };
  }

  /**
   * 打开「切换账号」弹窗。
   *
   * 一个弹窗两个入口：
   * ① 连接页「飞牛账号」输入框右侧的切换按钮；② 菜单 文件 → 切换账号。
   * 里面既能**挑一个已有账号切过去**，也能**新增账号**（填完直接登录）。
   *
   * ⚠️ 打开时必须先把远程视图藏起来：`WebContentsView` 永远画在 DOM 之上，
   *    不藏的话弹窗会被网页整个盖住 —— 远程视图永远画在窗口 DOM 之上。
   */
  openAccounts({ adding = false } = {}) {
    const items = this.menuAccounts();
    this.state = {
      ...this.state,
      accounts: {
        items,
        // 清单是空的就直接展开「新增」表单，⛔ 不给一个空列表让人对着发呆
        adding: Boolean(adding) || items.length === 0,
        form: this.accountFormDefaults(),
        error: null,
      },
    };
    this.push();
    this.view.setVisible(false);
    this.log(`打开切换账号（已有 ${items.length} 个）`);
  }

  /** 关掉弹窗；回到网页时要把视图放回来。 */
  closeAccounts() {
    if (!this.state.accounts) return;
    this.state = { ...this.state, accounts: null };
    this.push();
    if (this.state.screen === 'browsing' || this.state.screen === 'access') this.view.setVisible(true);
  }

  patchAccounts(partial) {
    if (!this.state.accounts) return;
    this.state = { ...this.state, accounts: { ...this.state.accounts, ...partial } };
    this.push();
  }

  /** 改「新增账号」表单里的某个字段（壳每敲一个字发一次）。 */
  patchAccountForm(partial) {
    if (!this.state.accounts) return;
    this.state = {
      ...this.state,
      accounts: {
        ...this.state.accounts,
        form: { ...this.state.accounts.form, ...partial },
        // 一改输入就把上一条错误抹掉，否则「请把地址、账号、密码都填上」会一直挂着
        error: null,
      },
    };
    this.push();
  }

  /** 展开 / 收起「新增账号」表单。 */
  toggleAddAccount(value) {
    if (!this.state.accounts) return;
    const adding = typeof value === 'boolean' ? value : !this.state.accounts.adding;
    this.patchAccounts({ adding, error: null, form: this.accountFormDefaults() });
  }

  /**
   * 新增账号并登录。
   *
   * ⚠️ 表单不完整时**留在弹窗里**报错 —— 这里不是登录失败，是把人送回连接页毫无意义。
   */
  async addAccount(form = {}) {
    const merged = { ...(this.state.accounts?.form || {}), ...form };
    const address = String(merged.address || '').trim();
    const user = String(merged.user || '').trim();
    const password = String(merged.password || '');
    if (!address || !user || !password) {
      this.log('新增账号被拒：地址 / 账号 / 密码没填全');
      return this.patchAccounts({ error: '请把地址、账号、密码都填上' });
    }
    this.log(`新增账号并登录 → ${user} @ ${address}`);
    return this.useAccount({
      address,
      user,
      https: merged.https !== false,
      password,
      // 「记住密码」这一次是用户明确勾选的 ⇒ 要让 afterAuth 真的落盘
      remember: merged.rememberPassword !== false,
    });
  }

  /**
   * 切换账号：清掉当前会话与 Cookie（**保留**记住的密码），用目标账号重新登一次。
   *
   * 为什么不是「同时开两个会话」：ZXDesk 的一个窗口对应一条飞牛会话（Cookie 只有一份），
   * 两个账号并存要两套分区、两个视图 —— 那是另一个产品形态。这里做的是「换人」：
   * 干净地退出 A，用 B 的凭据重新登进去。
   */
  async switchAccount({ address, user, https } = {}) {
    const target = { address: String(address || '').trim(), user: String(user || '').trim() };
    if (!target.address || !target.user) {
      this.log('切换账号被拒：地址或账号为空');
      return this.patchAccounts({ error: '地址或账号为空' });
    }
    const current = normalizeAddress(this.prefs.get().lastAddress) === normalizeAddress(target.address)
      && String(this.prefs.get().lastUser || '') === target.user;
    if (current && this.state.screen === 'browsing') {
      this.log(`切换账号：${target.user} 已经是当前账号`);
      return this.closeAccounts();
    }
    const credential = await this.credentialFor(target.address, target.user);
    return this.useAccount({
      address: target.address,
      user: target.user,
      https: https !== false,
      password: credential?.password || '',
      // 自动恢复不动已存凭据（remember=null）
      remember: null,
    });
  }

  /**
   * 「用这个账号登进去」的唯一出口（切换已有账号 / 新增账号都走它）。
   *
   * ⚠️ 不走 `logout({signedOut:true})`：那是「用户主动退出」，会把下次启动的静默登录关掉；
   * 切账号是「换个人继续用」，下次启动当然该自动登进 B。
   */
  async useAccount({ address, user, https = true, password = '', remember = null }) {
    const target = { address: String(address || '').trim(), user: String(user || '').trim() };
    if (!target.address || !target.user) return;
    this.log(`按账号登录 → ${target.user} @ ${target.address}（${password ? '有密码' : '无密码'}）`);
    this.stopCooldownNotice();
    // 先关弹窗：接下来要建视图 / 可能要弹证书确认，都不能压在模态下面
    this.state = { ...this.state, accounts: null };
    await this.logout({ keepSession: false, keepCredentials: true, signedOut: false });

    const useHttps = https !== false;
    this.prefs.patch({
      lastAddress: target.address,
      lastUser: target.user,
      preferHttps: useHttps,
      signedOut: false,
    });
    const form = {
      address: target.address,
      https: useHttps,
      user: target.user,
      password,
      showPassword: false,
      rememberPassword: this.prefs.get().rememberPassword,
    };
    this.lastForm = form;
    this.pendingCredential = {
      user: target.user,
      password,
      remember,
      address: target.address,
    };
    const note = password ? `正在登录 ${target.user}…` : `已切到 ${target.user}，请补充密码`;
    this.state = {
      ...this.state,
      screen: 'connect',
      notice: note,
      browsing: null,
      twofa: null,
      cert: null,
      error: null,
      connect: { ...this.connectFormState(note), ...form, hasSavedPassword: Boolean(password) },
    };
    this.push();
    this.view.setVisible(false);
    // 有密码才自动登：没密码就停在表单上让人补，⛔ 不要用一个空密码去撞风控
    if (password) {
      await this.connect(form);
    }
  }

  // ---------------------------------------------------------------- 连接节流

  /**
   * 把「连接太频繁，请 N 秒后再试」做成会自己走完的提示（照 Android `showCooldown`）。
   *
   * 静态文案不能这样用：它不会自己刷新 —— 用户盯着「请 15 秒后再试」等半分钟，
   * 屏幕上还是同一句，几秒之后就成了假话；冷却结束后那条错误也还留在界面上。
   */
  showCooldown() {
    this.stopCooldownNotice();
    const tick = () => {
      const leftMs = this.guard.remainingMs();
      if (leftMs <= 0) {
        // 只抹掉自己写的那条，⛔ 不覆盖别的错误
        if (String(this.state.connect?.error || '').startsWith(COOLDOWN_HINT)) this.patchConnect({ error: null });
        this.stopCooldownNotice();
        return;
      }
      const text = `${COOLDOWN_HINT}，请 ${Math.ceil(leftMs / 1000)} 秒后再试`;
      const current = String(this.state.connect?.error || '');
      // null 或仍是上一条倒计时 ⇒ 可以改写；已有别的错误 ⇒ 让位
      if (!current || current.startsWith(COOLDOWN_HINT)) this.patchConnect({ error: text });
    };
    tick();
    const timer = setInterval(tick, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    this.cooldownTimer = timer;
  }

  /** 不再需要倒计时提示（开始正常连接 / 已离开登录页）：停掉，别让它在别的屏写提示。 */
  stopCooldownNotice() {
    if (!this.cooldownTimer) return;
    clearInterval(this.cooldownTimer);
    this.cooldownTimer = null;
  }

  /**
   * 这次失败算不算「网络环境」造成的（DNS / 连不上 / 超时 / 证书没过）。
   *
   * ⚠️ 这类失败**不进冷却**：换个网就能好，按「密码错」罚冷却只会让用户白等 60 秒。
   * 判据与 Android `isNetworkFailure` 同口径 —— 看整条 cause 链，⛔ 只看最外层会漏。
   */
  isNetworkFailure(error) {
    let current = error;
    let depth = 0;
    while (current && depth < 6) {
      const code = String(current.code || current.errno || '').toUpperCase();
      if (
        ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code) ||
        current.name === 'AbortError' ||
        current.step === LOGIN_STEP.WS_CONNECT ||
        /证书|certificate|socket hang up|timeout|超时|连不上|DNS|解析/i.test(String(current.message || ''))
      ) {
        return true;
      }
      current = current.cause;
      depth += 1;
    }
    return false;
  }

  // ---------------------------------------------------------------- 连接

  async connect(form) {
    const merged = { ...this.state.connect, ...form };
    if (merged.busy) return;
    // 新一轮连接：访问码的轮次与「自动判定」重新计。
    // ⚠️ 例外：「访问码通过后自动重登」属于同一串磋商的继续，清了上限就形同虚设。
    if (!this.reloginFromAccessCode) {
      this.accessCodeRounds = 0;
      this.accessCodeAutoPassed = false;
    }
    this.reloginFromAccessCode = false;
    // 冷却期内一律不发起。飞牛对短时间内的反复连接有风控，
    // 连点「连接」看着是重试，在服务端就是一次次的失败取证 —— 触发后一段时间根本不让连。
    if (this.guard.remainingMs() > 0) {
      this.showCooldown();
      return;
    }
    this.stopCooldownNotice();
    const parsed = parseInput(merged.address);
    if (parsed.kind === 'invalid') {
      this.patchConnect({ error: parsed.reason });
      return;
    }
    this.patchConnect({
      ...merged,
      busy: true,
      error: null,
      progress: '正在解析地址…',
    });
    this.pendingAddress = String(merged.address || '').trim();
    // 「错误页 → 重试」要能原样再跑一遍（含 FNID 重新解析）
    this.lastForm = { ...merged };
    this.pendingCredential = {
      user: String(merged.user || '').trim(),
      password: String(merged.password || ''),
      remember: Boolean(merged.rememberPassword),
      address: this.pendingAddress,
    };

    let plan = null;
    try {
      plan = await this.resolvePlan(parsed, merged);
      this.prefs.patch({ lastAddress: this.pendingAddress, preferHttps: Boolean(merged.https) });
      if (merged.user) this.prefs.patch({ lastUser: String(merged.user).trim() });

      if (plan.error) {
        this.patchConnect({ busy: false, progress: null, error: plan.error });
        return;
      }
      // 同一台设备的「访问码凭据 / 网页会话」接回来（否则重启后又要重输一次码）
      await this.inheritDeviceState(plan.entry);
      // 先回注网关凭据，再问「要不要访问码」—— 否则刚过完码的设备会白进一屏访问码页
      await this.applySessionCookies(plan.entry);

      // 8990 直连：只有「显式填 IP:8990」或「关掉 HTTPS」才会走到这里（不需要飞牛账号）
      if (plan.entry.flow === 'DIRECT') {
        // ⚠️ 必须 await：enterBrowsing 里有建视图 / 写 Cookie / 加载页面三步 async。
        // 漏掉 await 时它抛的错会变成 unhandledRejection ⇒ 主进程的全局兜底会弹框并 exit(1)
        //（用户看到的是「点连接，程序直接退出」）。
        await this.enterBrowsing(plan.entry, `已直连 8990（不走飞牛网关）`);
        return;
      }

      // 0.1.2 起：局域网也要飞牛账号（网关会校验）。⛔ 不再「没填账号就自动走 8990」
      const hasCredentials = this.pendingCredential.user && this.pendingCredential.password;
      if (!hasCredentials) {
        this.log('连接被拒：没填飞牛账号（局域网也要登录飞牛）');
        this.patchConnect({
          busy: false,
          progress: null,
          error: '请填写飞牛账号和密码（局域网也要登录飞牛）',
        });
        return;
      }

      // ⭐ fnOS 的顺序：**先访问码、后密码**。
      // 开访问码的 NAS 上，原生 WS 登录不一定回 401 —— 也可能直接回登录错误，
      // 那会被界面说成「飞牛账号或密码不正确」，用户怎么输都进不去。
      // 所以先用页面问网关一句「要不要访问码」，要就先把码过掉，再验证密码。
      if (await this.gatewayNeedsAccessCode(plan.entry)) {
        this.log('网关要访问码：先过码，再验证密码（fnOS 顺序）');
        await this.showAccessCode(plan.entry, '先输入访问码，通过后再验证飞牛账号');
        return;
      }

      await this.runLogin(plan.entry);
    } catch (e) {
      // ⭐ 握手被网关 401/403：这台 NAS 开了「访问码」，不是账号密码错（Android 0.2.18 同口径）。
      // ⛔ 不能走 failLogin：那会把用户钉在「登录失败」上，怎么输都进不去。
      if (e instanceof AccessCodeRequiredError) {
        this.log(`登录前被网关拦下（HTTP ${e.status || '401/403'}），进第 ④ 步`);
        // 这不是账号问题：记进节流只会让人越试越久（Android 同口径，⛔ 不给访问码闸门加惩罚）
        this.guard.reset();
        await this.showAccessCode(plan?.entry || null, '登录前被网关拦下：先输入访问码');
        return;
      }
      this.failLogin(e);
    }
  }

  /** 把输入变成一条可加载的入口（含 FNID 解析 / 局域网优先网关）。 */
  async resolvePlan(parsed, form) {
    if (parsed.kind === 'fnid') {
      // 照 Android `NasDataSource.fromFnId` 逐行来：FNID → **只**中继 `https://<relay>`。
      // ⛔ 不读 `lanIpv4` / `publicIpv4`，⛔ 不拼 `https://<ip>:64999`，也不留回落项。
      const addresses = await resolveFnId(parsed.id, { fetchImpl: this.fetcher });
      const relayHost = addresses.relay[0];
      if (!relayHost) return { error: '这个 FNID 没有中继地址（设备可能离线）' };
      this.log(`FNID 解析：relay=${relayHost}`);
      this.log(`登录目标：中继 https://${relayHost}`);
      return {
        entry: new SavedSession({
          address: this.pendingAddress,
          https: true,
          baseUrl: `https://${relayHost}`,
          gatewayPath: DEFAULT_GATEWAY_PATH,
          flow: 'GATEWAY',
          relayHost,
          portalUrl: portalUrlFor(parsed.id),
        }),
        lanHost: null,
      };
    }

    const isLanIp = parsed.target === TARGET_KIND.IP && !parsed.port && isPrivateAddress(parsed.host);
    if (isLanIp) {
      // 局域网口径（0.1.2 起）：默认走网关 64999，**必须登录飞牛**；
      // 只有用户主动把「HTTPS 安全访问」关掉，才按 8990 直连（那是显式意图，⛔ 不再自动回落）。
      if (form.https === false) {
        return { entry: this.directEntry(parsed.host), lanHost: parsed.host };
      }
      const gateway = planConnection({ ...parsed, port: DEFAULT_HTTPS_PORT_FOR_GATEWAY }, true);
      if (!gateway.ok) return { error: gateway.reason, lanHost: parsed.host };
      return {
        entry: new SavedSession({
          address: this.pendingAddress,
          https: true,
          baseUrl: gateway.plan.baseUrl,
          gatewayPath: gateway.plan.gatewayPath,
          flow: 'GATEWAY',
          relayHost: null,
        }),
        lanHost: parsed.host,
      };
    }

    const planned = planConnection(parsed, form.https);
    if (!planned.ok) return { error: planned.reason };
    return {
      entry: new SavedSession({
        address: this.pendingAddress,
        https: Boolean(form.https),
        baseUrl: planned.plan.baseUrl,
        gatewayPath: planned.plan.gatewayPath,
        flow: planned.plan.direct ? 'DIRECT' : 'GATEWAY',
        cleartext: planned.plan.cleartext,
      }),
      lanHost: null,
    };
  }

  directEntry(host) {
    return new SavedSession({
      address: this.pendingAddress,
      https: false,
      baseUrl: `http://${host}:${DIRECT_PORT}`,
      gatewayPath: DEFAULT_GATEWAY_PATH,
      flow: 'DIRECT',
      cleartext: true,
    });
  }

  /**
   * 把上次快照里「跨会话有效」的东西接到这次新造出来的入口上。
   *
   * 为什么要接：`resolvePlan` 每次都造一个**全新的** `SavedSession`，里面只有地址与链路；
   * 而 `webSession`（`zxdesk_sid`）是「这台设备的状态」，不是「这次连接的参数」——
   * 不接回去，每次手动连接都要再走一次网页登录。
   *
   * ⚠️ 只在**同一台设备**（baseUrl 一致）时接：换了 NAS 还把上一台的凭据带过去，
   * 等于拿 A 的钥匙开 B 的门（0.2.5 修过一次同族问题，见 `afterAuth` 的 sameHost）。
   * ⚠️ 网关凭据（访问码 Cookie）**不走这里**：它按 baseUrl 存在 `gateway.bin`，
   *    由 `applySessionCookies()` 自己查 —— 那条路与是否登录无关（只过码没登录也要记住）。
   */
  async inheritDeviceState(entry) {
    if (!entry) return entry;
    try {
      const saved = await this.sessions.load();
      if (!saved) return entry;
      if (normalizeAddress(saved.baseUrl) !== normalizeAddress(entry.baseUrl)) return entry;
      if (!entry.webSession && saved.webSession) entry.webSession = saved.webSession;
    } catch (e) {
      this.log(`读取上次设备状态失败（忽略）：${e.message}`);
    }
    return entry;
  }

  /**
   * 走原生 WS 登录（单入口，与 Android `FnLoginClient` 一致）。
   *
   * ⚠️ 走过的两条歪路都别回来：
   * - 0.1.1 的「网关连不上就自动回落 8990」—— 那是绕过飞牛登录；
   * - 0.1.5 的「FNID 先试局域网网关、失败再回中继」—— 地址是猜的，实测根本连不上。
   */
  async runLogin(entry) {
    this.pendingEntry = entry;
    // 记下「这次登录是在哪一代发的」：握手是秒级的，期间用户完全可能点「退出登录」
    this.flowEpoch = this.authEpoch;
    this.flow = this.createFlow(entry);
    const result = await this.flow.start();
    await this.finishLogin(result);
  }

  /** 造一条登录流程（局域网 / 中继共用）。 */
  createFlow(entry) {
    const flow = new FnLoginFlow({
      baseUrl: entry.baseUrl,
      relay: Boolean(entry.relayHost),
      user: this.pendingCredential.user,
      password: this.pendingCredential.password,
      deviceId: this.prefs.get().deviceId,
      deviceName: 'Windows-ZXDesk',
      // ⭐ 每次 WS 握手现取远程视图分区里的 Cookie（访问码过了，网关凭据就在那儿）。
      // 不传这一项，开了访问码的 NAS 上原生登录永远 401 —— Android 0.2.18 修的就是这件事。
      gatewayCookie: () => this.handshakeCookie(entry, 'WS 握手 Cookie'),
      rpcFactory: this.rpcFactory || ((url, cookie) => new WsClient({ url, cookie, onSelfSigned: (host, info) => this.requestTrust(host, info) })),
      /**
       * ⭐ `POST /app/ticket` 必须走**分区**的 fetch（`persist:zxdesk`），⛔ 不能用 `net.fetch`。
       *
       * `net.fetch` 跑在默认 session 上：既没有访问码凭据，也**不走分区的 TOFU 判定** ——
       * 局域网自签证书的 NAS 上这一步会因为证书不受信直接失败。而它是「fnOS 新版 ticket-cookie
       * 模式」唯一能把会话种成 Cookie 的地方：认领失败就没有 `fnos-token`，页面拿到的只是
       * WS 的令牌（网关不认）⇒ 回纯文本 `invalid token` ⇒ 界面白屏。
       * Android 的 `claimTicket` 是独立 HTTP 客户端、走系统信任库，同一段逻辑在桌面端必须绑分区。
       */
      fetcher: this.probeFetcher || this.fetcher,
      onStep: (label) => this.patchConnect({ progress: label }),
    });
    return flow;
  }

  /**
   * 远程视图分区里的 Cookie 头（`name=value; …`）。
   *
   * 访问码是在视图里过的，凭据由网关种在 `persist:zxdesk`；原生 WS / 原生探测不在那个浏览器里，
   * 必须显式取一次（Android 用 `CookieManager.getCookie()`，这里用 `session.cookies.get`）。
   */
  async gatewayCookieHeader(entry) {
    if (!entry?.baseUrl || typeof this.cookies?.header !== 'function') return '';
    // 两处都取：访问码页那条 URL（含 gatewayPath，可能匹配到 Path 限定的 Cookie）
    // ＋ 主机根路径。合起来才是「浏览器此刻会发给这个站点的全部凭据」。
    const urls = [this.accessUrl(entry), String(entry.baseUrl).replace(/\/+$/, '')];
    const parts = [];
    for (const url of urls) {
      try {
        const part = String((await this.cookies.header(url)) || '').trim();
        if (part) parts.push(part);
      } catch (e) {
        this.logError(`读取网关 Cookie 失败：${e.message}`);
      }
    }
    return mergeCookieHeader(...parts);
  }

  /** 握手前取一次网关 Cookie，并把**名字**记进日志（⛔ 不记值）——真机排障就靠这一行。 */
  async handshakeCookie(entry, label) {
    const header = await this.gatewayCookieHeader(entry);
    const names = String(header || '')
      .split(';')
      .map((pair) => pair.split('=')[0].trim())
      .filter(Boolean);
    this.log(`${label}：${names.length ? `${names.length} 条（${names.join('、')}）` : '无'}`);
    return header;
  }

  /**
   * 手拼探测 Cookie（只在没有分区 fetch 的单测 / 旧装配里用）。
   *
   * 同名谁说了算，取决于场景：
   * - 刚登录完：**会话对象**是新的，分区里可能还是上一个会话的 token ⇒ `preferSession: true`；
   * - 回前台探活：视图里的 Cookie 可能被服务端续期过，比登录快照新 ⇒ 默认让视图那份赢。
   *
   * @param {object} entry
   * @param {object} session
   * @param {{preferSession?: boolean}} [options]
   */
  async probeCookieHeader(entry, session, { preferSession = false } = {}) {
    const fromSession = session?.cookieHeader ? session.cookieHeader(entry.relayHost) : '';
    const fromGateway = await this.gatewayCookieHeader(entry);
    return preferSession
      ? mergeCookieHeader(fromGateway, fromSession)
      : mergeCookieHeader(fromSession, fromGateway);
  }

  async finishLogin(result) {
    if (result.session) {
      await this.afterAuth(result.session);
      return;
    }
    const info = result.twoFactor;
    this.patch({
      screen: 'twofa',
      connect: { ...this.state.connect, busy: false, progress: null },
      twofa: {
        maskedEmail: info.maskedEmail || '',
        totpEnabled: Boolean(info.totpEnabled),
        emailEnabled: Boolean(info.emailEnabled),
        trustDevice: true,
        emailView: false,
        totp: '',
        email: '',
        emailCode: '',
        emailSent: false,
        resendLeft: 0,
        busy: false,
        error: null,
      },
    });
  }

  /**
   * 登录失败 → **留在登录页**，按钮下方一行红字「登录失败」。
   *
   * ⚠️ 0.1.6 初版把登录失败也走整页错误屏 —— 那是「页面打不开」的画法，
   * 结果表单、密码、用户刚敲的地址一起没了，用户会以为客户端崩了。
   * 现在：连不上 / 账号错 / 2FA 错 都留在屏上，具体原因只进日志与「复制诊断」。
   * 整页错误只留给**页面加载 / 导航失败 / 未知异常**（`loadSafely`、`index.js` 的 onLoadFail）。
   */
  failLogin(e, { auto = false } = {}) {
    const step = e instanceof LoginError ? e.step : LOGIN_STEP.WS_CONNECT;
    this.lastAttempt = {
      baseUrl: this.pendingEntry?.baseUrl || this.entry?.baseUrl || this.state.connect?.address || '',
      step,
      error: e?.message || String(e || ''),
      detail: e?.detail || null,
    };
    /**
     * 连接节流（照 Android `connectGuard.registerFailure()`）：
     * - **静默自动登录失败不记账** —— 那不是用户手动发起的，罚他没有意义，还会让人下次打不开应用；
     * - **网络类失败不记账** —— DNS / 连不上 / 超时换个网就能好（见 `isNetworkFailure`）；
     * - 账号密码错、2FA 错、票据错都要记：那才会真的把账号推进风控。
     */
    if (!auto && !this.isNetworkFailure(e)) {
      const cooldown = this.guard.registerFailure();
      if (cooldown > 0) {
        this.log(`连接节流：连续失败 ${this.prefs.get().connectFailCount} 次，冷却 ${Math.round(cooldown / 1000)} 秒`);
      }
    }
    this.flow?.close();
    this.flow = null;
    this.pendingEntry = null;

    // ⚠️ 表单值要「原样留住」：地址 / 账号 / 密码都在 `lastForm` 里（connect() 开头就存了）
    const form = this.lastForm || this.state.connect;
    this.state = {
      ...this.state,
      screen: 'connect',
      twofa: null,
      cert: null,
      error: null,
      accounts: null,
      connect: {
        ...this.state.connect,
        ...form,
        busy: false,
        progress: null,
        error: '登录失败',
        hasSavedPassword: this.credentials.has(),
      },
    };
    this.push();
    // 访问码屏 / 静默重连的视图这时可能还开着：回到连接页就必须藏起来，
    // 否则表单被 WebContentsView 盖住，用户看到的是「点了连接没反应」。
    this.view.setVisible(false);
    this.log(`登录失败（${step}）：${e?.message || e || ''}`);
    // 不清 pendingCredential、不动 credential.bin —— 用户改个密码就能再试
  }

  // ---------------------------------------------------------------- 两步验证

  /**
   * 提交验证器 6 位码。
   *
   * ⚠️ 0.1.1 的坑：壳只把验证码存在自己内存里，主进程拿到的永远是 `''` ⇒ `totp.length !== 6`
   * 直接**静默 return**（不置 busy、不报错、不写日志）⇒ 用户看到的就是「点了没反应」。
   * 现在：参数由壳带过来，任何人早退都必须**给出可见错误 + 写日志**。
   */
  async submitTotp(code) {
    const twofa = this.state.twofa;
    if (!twofa) {
      this.log('2FA 提交被拒：当前不在两步验证屏');
      return;
    }
    if (twofa.busy) {
      this.log('2FA 提交被忽略：上一次验证还没结束');
      return;
    }
    const value = String(code ?? twofa.totp ?? '').replace(/\D/g, '').slice(0, 6);
    if (value.length !== 6) {
      this.log('2FA 提交被拒：验证码不是 6 位');
      this.patchTwofa({ error: '请输入 6 位验证码' });
      return;
    }
    if (!this.flow) {
      this.log('2FA 提交被拒：登录会话已失效（flow 为空）');
      this.patchTwofa({ error: '登录会话已失效，请返回重新连接' });
      return;
    }
    this.log('2FA 提交（验证器）');
    this.patchTwofa({ totp: value, busy: true, error: null });
    try {
      const session = await this.flow.submitTotp(value, twofa.trustDevice);
      this.log('2FA 通过（验证器）');
      await this.afterAuth(session);
    } catch (e) {
      this.log(`2FA 失败（验证器）：${e.message || '未知原因'}`);
      this.patchTwofa({ busy: false, error: e.message || '验证失败' });
    }
  }

  async sendEmailCode() {
    const twofa = this.state.twofa;
    if (!twofa) {
      this.log('发送邮箱验证码被拒：当前不在两步验证屏');
      return;
    }
    if (!this.flow) {
      this.log('发送邮箱验证码被拒：登录会话已失效（flow 为空）');
      this.patchTwofa({ error: '登录会话已失效，请返回重新连接' });
      return;
    }
    if (twofa.busy || twofa.resendLeft > 0) {
      this.log('发送邮箱验证码被忽略：还在冷却或上一次没结束');
      return;
    }
    this.patchTwofa({ busy: true, error: null });
    try {
      await this.flow.sendEmailCode();
      this.patchTwofa({ busy: false, emailSent: true, resendLeft: 60 });
      this.startResendCountdown();
    } catch (e) {
      this.patchTwofa({ busy: false, error: e.message || '发送失败' });
    }
  }

  /** 提交邮箱验证码（同上：参数由壳带过来，早退必须可见）。 */
  async submitEmailCode(email, code) {
    const twofa = this.state.twofa;
    if (!twofa) {
      this.log('邮箱验证被拒：当前不在两步验证屏');
      return;
    }
    if (twofa.busy) {
      this.log('邮箱验证被忽略：上一次验证还没结束');
      return;
    }
    const emailValue = String(email ?? twofa.email ?? '').trim();
    const codeValue = String(code ?? twofa.emailCode ?? '').trim();
    if (!emailValue) {
      this.log('邮箱验证被拒：没填邮箱');
      this.patchTwofa({ error: '请填写完整邮箱地址' });
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailValue)) {
      this.log('邮箱验证被拒：邮箱格式不对');
      this.patchTwofa({ error: '请填写完整邮箱地址' });
      return;
    }
    if (!codeValue) {
      this.log('邮箱验证被拒：没填验证码');
      this.patchTwofa({ error: '请输入邮箱验证码' });
      return;
    }
    if (!this.flow) {
      this.log('邮箱验证被拒：登录会话已失效（flow 为空）');
      this.patchTwofa({ error: '登录会话已失效，请返回重新连接' });
      return;
    }
    this.log('2FA 提交（安全邮箱）');
    this.patchTwofa({ email: emailValue, emailCode: codeValue, busy: true, error: null });
    try {
      const session = await this.flow.submitEmailCode(emailValue, codeValue, twofa.trustDevice);
      this.log('2FA 通过（安全邮箱）');
      await this.afterAuth(session);
    } catch (e) {
      this.log(`2FA 失败（安全邮箱）：${e.message || '未知原因'}`);
      this.patchTwofa({ busy: false, error: e.message || '验证失败' });
    }
  }

  startResendCountdown() {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = setInterval(() => {
      const twofa = this.state.twofa;
      if (!twofa) {
        clearInterval(this.resendTimer);
        this.resendTimer = null;
        return;
      }
      const left = Math.max(0, (twofa.resendLeft || 0) - 1);
      this.patchTwofa({ resendLeft: left });
      if (left === 0) {
        clearInterval(this.resendTimer);
        this.resendTimer = null;
      }
    }, 1000);
  }

  cancelTwoFactor() {
    this.flow?.close();
    this.flow = null;
    this.pendingEntry = null;
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
    this.showConnect();
  }

  // ---------------------------------------------------------------- 认证之后

  /**
   * 拿到会话：落盘 → 探一次网关 → 决定去第 ④ 步（访问码）还是浏览模式。
   *
   * @param {object} session
   * @param {object} [options]
   * @param {boolean} [options.silent] - 静默重连：**不切屏**，续上就直接重载页面
   */
  async afterAuth(session, { silent = false } = {}) {
    // 从这一刻起，任何「退出登录 / 换个地址」都会让本世代作废（见 authEpoch）。
    // ⚠️ 用**发起登录时**记下的世代，⛔ 不能在这里现取：握手（含 `/app/ticket` 认领）是秒级的，
    //    期间点了退出的话，现取到的已经是新世代，「作废」就永远判不出来 —— 人还是会被送回主界面。
    const epoch = this.flowEpoch ?? this.authEpoch;
    /**
     * ⚠️ 世代核对必须放在最前面，⛔ 不能先要 `pendingEntry`：
     * 退出登录会把 `pendingEntry` 置空（那是它的职责），先要 entry 的话这里会报
     * 「内部错误：连接信息丢了」，而真正发生的事是「这次登录已经被用户取消」——
     * 两者在日志里必须能分清，否则真机排查会往完全错误的方向走。
     */
    if (epoch !== this.authEpoch) {
      this.log('登录结果已作废（期间用户退出登录 / 换了地址），整份丢弃');
      return;
    }
    const entry = this.pendingEntry;
    if (!entry) {
      this.patchTwofa({ busy: false, error: '内部错误：连接信息丢了，请重新连接' });
      return;
    }

    // 「记住密码」落盘（勾了存、没勾清；自动恢复 / 自动登录 remember=null ⇒ 不动）
    const credential = this.pendingCredential;
    if (credential) {
      if (credential.remember === true && credential.user && credential.password) {
        const saved = await this.credentials.save(credential.address, credential.user, credential.password);
        this.log(`记住密码：${saved ? '已保存' : '未保存（本机不支持加密存储）'}`);
      } else if (credential.remember === false) {
        // 只清这一对地址 / 账号（多账号：别的账号的密码不该被这次选择连坐）
        await this.credentials.clear(credential.address, credential.user);
        this.log('记住密码：未勾选，已清掉这一对地址 / 账号的旧凭据');
      } else {
        this.log('记住密码：本次不改动（自动登录 / 自动恢复）');
      }
    }
    if (epoch !== this.authEpoch) {
      this.log('登录结果已作废（期间用户退出登录 / 换了地址），整份丢弃');
      return;
    }

    // longToken / secret 一旦拿到就别丢：tokenLogin 换来的会话不一定再返回它们
    const previous = await this.sessions.load();
    /**
     * ⚠️ 只继承**同一台设备**的长期凭据。
     * 换了地址（A 号 NAS → B 号 NAS）还把上一台的 `secret` / `longToken` 拼进新会话的话：
     * ① 签名与免密登录会拿 A 的凭据去打 B（必然失败，还会让 B 侧看到脏请求）；
     * ② 下次「静默重连」先试 longToken 就会白等一轮才走密码。
     */
    const sameHost = Boolean(previous) && normalizeAddress(previous.baseUrl) === normalizeAddress(entry.baseUrl);
    const keep = new FnSession({
      token: session.token,
      secret: session.secret || (sameHost ? previous?.session?.secret : null) || null,
      longToken: session.longToken || (sameHost ? previous?.session?.longToken : null) || null,
      entryToken: session.entryToken || null,
      setCookies: session.setCookies || [],
      note: session.note || null,
    });

    entry.session = keep;
    /**
     * ⭐ 把「这次登录用的是哪个账号」写进快照。
     *
     * ⚠️ 0.2.4 以前 `SavedSession.user` 一直是空串（`resolvePlan` 造快照时没带 user）：
     * 于是重启后 `recoverWithPassword()` 的「凭据账号 == 快照账号」永远不成立 ⇒
     * **记住的密码从来没被用来自动重连**（longToken 又本就没打通）⇒ 会话一过期就只能靠人重登。
     * 这里补上；加号前的旧快照由 `recoverWithPassword()` 兼容（快照没账号时按地址匹配）。
     */
    if (credential?.user) entry.user = String(credential.user).trim();
    await this.sessions.save(entry);
    // 落盘也是异步的：这期间退出登录的话，⛔ 不能把「主动退出」改写回 false（否则下次开机又自动登进去）
    if (epoch !== this.authEpoch) {
      this.log('登录结果已作废（落盘期间用户退出登录 / 换了地址），不改「主动退出」标记');
      return;
    }
    // 登录成功 ⇒ 「主动退出」这条明确表达到此结束，下次启动可以静默自动登录
    this.prefs.patch({ signedOut: false });
    /**
     * 登录成功 ⇒ 记进账号清单（「文件 → 切换账号」的数据来源）。
     *
     * ⚠️ 只记**成功**的登录：失败不记，列表里只留真正用过的账号。
     * 地址用 `entry.address`（用户输入的那份，FNID 就是 FNID），不是 baseUrl —— 中继域名
     * 换一次就变，拿它当账号标识会让同一台设备在列表里出现好几条。
     */
    if (this.accounts) {
      this.accounts.remember({ address: entry.address, user: entry.user || this.prefs.get().lastUser, https: entry.https !== false });
    }
    // 登录成功 ⇒ 连接节流的账一笔勾销（正常使用不该被历史失败拖住）
    this.guard.reset();
    // 登录成功 ⇒ 这一串「访问码 → 重登」的磋商结束，轮次与自动判定都归零
    this.accessCodeRounds = 0;
    this.accessCodeAutoPassed = false;
    // 3.5：把登录收尾的「票据 / 入口 token」情况单独记一行（只记有无与条数，⛔ 不记值）
    const settleLine = `登录收尾：ticket 换到 ${keep.setCookies.length} 条 Cookie；entry-token ${keep.entryToken ? '有' : '无'}${keep.note ? `（${keep.note}）` : ''}`;
    if (keep.setCookies.length === 0 && !keep.entryToken) {
      /**
       * ⚠️ 这一行是「登录成功但页面 invalid token」的唯一线索，所以用 WARN 而不是 info。
       * 两个都没换到的意思是：手里只有一个 WS 令牌，网关不认它 —— 进浏览模式后页面必然回
       * 纯文本 `invalid token`。根因通常是 `/app/ticket` 没走通（自签证书 / 网关拦了）。
       */
      this.logError(`WARN ${settleLine} —— 没有会话 Cookie，页面会回 invalid token`);
    } else {
      this.log(settleLine);
    }

    this.flow?.close();
    this.flow = null;

    let page = GATEWAY_PAGE.APP;
    if (entry.flow === 'GATEWAY' && (this.probeFetcher || this.fetcher)) {
      // ⭐ 先把 Cookie 落进分区，再用**分区自己的 fetch** 探：
      // 访问码凭据 + 刚换到的新会话都由浏览器带，和页面看到的完全一致。
      // 早先拿 `net.fetch`（默认 session）探，既没有访问码凭据也不走 TOFU ⇒
      // 每次都判成「还要访问码」，登录成功又被送回第 ④ 步（真机「好几次才进入」）。
      // 只有走分区 fetch 时才需要提前落 Cookie；手拼 Cookie 那条路仍由 enterBrowsing 统一注入。
      if (this.probeFetcher) await this.applySessionCookies(entry);
      page = await probeGateway({
        baseUrl: entry.baseUrl,
        gatewayPath: entry.gatewayPath,
        // 没有分区 fetch（单测 / 旧装配）时才手拼 Cookie：会话那份要**最后**合并，覆盖浏览器里的旧 token
        cookieHeader: this.probeFetcher
          ? undefined
          : await this.probeCookieHeader(entry, keep, { preferSession: true }),
        fetchImpl: this.probeFetcher || this.fetcher,
      });
    }

    if (page === GATEWAY_PAGE.ACCESS_CODE) {
      if (!silent) this.log('网关仍要访问码，进第 ④ 步');
      await this.showAccessCode(entry, silent ? '网关要访问码，先在下面输入' : null);
      return;
    }
    // 探网关最长 5 秒：这期间用户可能已经点了「退出登录」，进屏幕前再核一次世代
    if (epoch !== this.authEpoch) {
      this.log('登录结果已作废（探网关期间用户退出登录 / 换了地址），不进浏览模式');
      return;
    }
    // 静默恢复也走 enterBrowsing：Cookie 已经换新，页面要重载一次才拿到新会话
    await this.enterBrowsing(entry, null);
  }

  /**
   * 网关要不要先过访问码 —— **在验证密码之前**问一次。
   *
   * fnOS 的顺序是「访问码 → 密码」，而开码的 NAS 上原生 WS 不一定回 401：
   * 有的部署会直接回登录错误，界面就会误报「账号或密码不正确」，用户怎么输都进不去。
   * 页面探针是唯一能提前问清顺序的信号：是访问码页 → 先过码；其余（含 `invalid token`）→ 继续登录。
   *
   * ⚠️ 探测走分区 `session.fetch`（若可用），会自动带上已有的访问码凭据；
   *    已过过码的机器这一步会直接返回登录页 / invalid token，不会多弹一次访问码。
   */
  async gatewayNeedsAccessCode(entry) {
    if (!entry || entry.flow !== 'GATEWAY') return false;
    const fetchImpl = this.probeFetcher || this.fetcher;
    if (!fetchImpl) return false;
    try {
      const page = await probeGateway({
        baseUrl: entry.baseUrl,
        gatewayPath: entry.gatewayPath,
        // 还没登录：不带会话 Cookie（分区 fetch 自己带访问码凭据）
        cookieHeader: this.probeFetcher ? undefined : '',
        fetchImpl,
      });
      this.log(`访问码预检：${page}`);
      return page === GATEWAY_PAGE.ACCESS_CODE;
    } catch (e) {
      // 探测失败不能挡登录：按「不需要」处理，后面 WS 的 401 还有一次兜底
      this.log(`访问码预检失败（按不需要处理）：${e.message}`);
      return false;
    }
  }

  /**
   * 第 ④ 步：远程视图直接显示网关自己的访问码页（⛔ 不自造校验）。
   *
   * ⚠️ 地址用 `<base><gatewayPath>/login.html`（Android `zxDeskLoginUrl` 同口径）：
   * 还没有会话时 `startUrl()` 会退回 `baseUrl/`（飞牛桌面空壳），那不是我们要过的访问码页。
   *
   * @param {object|null} entry
   * @param {string|null} note - 屏上那句「为什么到这里」
   */
  async showAccessCode(entry, note = null) {
    if (!entry) return this.showConnect('登录信息丢了，请重新连接');
    /**
     * ⭐ 往返轮次上限（照 Android `MAX_ACCESS_CODE_ROUNDS`）。
     *
     * 「访问码 → 重登 → 又被 401 → 再回访问码」是可以无限转的：网关要么是码没真的过、
     * 要么对这条来源限制更严。再自动跳回去只会让界面一直转圈，人什么也做不了。
     * 第三轮停下、回连接页，把「下一步该干什么」写清楚。
     */
    this.accessCodeRounds += 1;
    if (this.accessCodeRounds > MAX_ACCESS_CODE_ROUNDS) {
      this.log(`访问码第 ${this.accessCodeRounds} 轮仍被拒，不再进第 ④ 步`);
      // 这一路的 401 是网关闸门、不是密码错：别让连接冷却挡住人重试
      this.guard.reset();
      return this.showConnect(
        `网关仍然要求访问码（已来回 ${this.accessCodeRounds - 1} 轮）。请在访问码页把码输完并点页面上的「确定」，` +
          '看到飞牛登录页后再点「连接」；如果一直过不去，试试「换个地址」用局域网地址连接。',
      );
    }
    this.pendingEntry = entry;
    this.accessProbeHits = 0;
    this.state = {
      ...this.state,
      screen: 'access',
      notice: note || null,
      twofa: null,
      cert: null,
      error: null,
      // 切到访问码屏时弹窗必须收起来（它的入口只在连接页与菜单里）
      accounts: null,
      browsing: this.browsingInfo(entry),
      connect: { ...this.state.connect, busy: false, progress: null, error: null },
    };
    this.push();
    this.view.setContext({ baseUrl: entry.baseUrl, relayHost: entry.relayHost, gatewayPath: entry.gatewayPath });
    // 同上：先建视图（拿到 persist:zxdesk 分区会话），再写 Cookie
    this.view.ensure();
    await this.applySessionCookies(entry);
    this.view.setVisible(true);
    await this.loadSafely(this.accessUrl(entry));
    this.startAccessPoll();
  }

  /** 访问码页的地址：应用登录页（网关会在这条路径上拦人）。 */
  accessUrl(entry) {
    const base = String(entry.baseUrl || '').replace(/\/+$/, '');
    const gateway = String(entry.gatewayPath || DEFAULT_GATEWAY_PATH).replace(/\/+$/, '');
    return `${base}${gateway}/login.html`;
  }

  /** 开始轮询访问码页（Android `AccessCodeScreen` 同节奏：700ms）。 */
  startAccessPoll() {
    this.stopAccessPoll();
    this.accessProbeHits = 0;
    this.accessPollErrorLogged = false;
    const timer = setInterval(() => {
      void this.pollAccessPage();
    }, ACCESS_POLL_MS);
    // ⛔ 不 unref 会把进程留在后台（测试进程也退不掉）
    if (typeof timer.unref === 'function') timer.unref();
    this.accessPollTimer = timer;
  }

  stopAccessPoll() {
    if (!this.accessPollTimer) return;
    clearInterval(this.accessPollTimer);
    this.accessPollTimer = null;
  }

  /**
   * 轮询一次访问码页。
   *
   * ⚠️ 这是 **Android 0.2.17 的关键一环**：过了访问码之后网关回纯文本 `invalid token`，
   * 那一页不会再有 `did-finish-load` —— 只靠加载事件永远等不到「已经不是访问码页」的第二次判断。
   */
  async pollAccessPage() {
    if (this.state.screen !== 'access') {
      this.stopAccessPoll();
      return;
    }
    if (this.accessPollBusy) return;
    if (typeof this.view.probePage !== 'function') {
      this.stopAccessPoll();
      return;
    }
    this.accessPollBusy = true;
    try {
      const page = await this.view.probePage();
      if (this.state.screen !== 'access') {
        this.stopAccessPoll();
        return;
      }
      await this.handleAccessProbe(page);
    } catch (e) {
      // 页面正在跳转时 eval 会失败，下一轮再看 —— ⛔ 不要因此切屏；日志只留第一条，别刷屏
      if (!this.accessPollErrorLogged) {
        this.accessPollErrorLogged = true;
        this.log(`访问码页轮询失败（后续同类不再记录）：${e.message}`);
      }
    } finally {
      this.accessPollBusy = false;
    }
  }

  /**
   * 访问码页的判定（加载事件与轮询共用）。
   *
   * 判据照 Android：`ACCESS_CODE` / `UNKNOWN` 不算离开，**其余**（含 `invalid token` 的
   * `LOGIN_REQUIRED`、应用页 `APP`）都算离开；连续 `ACCESS_CONFIRM_TIMES` 次才继续。
   */
  async handleAccessProbe(page) {
    if (page === GATEWAY_PAGE.ACCESS_CODE || page === GATEWAY_PAGE.UNKNOWN) {
      this.accessProbeHits = 0;
      return;
    }
    this.accessProbeHits += 1;
    if (this.accessProbeHits < ACCESS_CONFIRM_TIMES) {
      this.log(`访问码页：已离开判定 ${this.accessProbeHits}/${ACCESS_CONFIRM_TIMES}（${page}），再确认一次`);
      return;
    }
    this.accessProbeHits = 0;
    /**
     * ⭐ ⓐ 自动判定整轮只准用一次（照 Android `onAccessCodeDone` 的第一道闸）。
     *
     * 判据看的是页面长相：中继空壳、网关的「正在校验」过渡页都可能让它攒够次数。
     * 如果每次都接手，就是「跳走 → 401 → 回来 → 再跳走」的死循环 ——
     * 用户看到的是加载圈一直在转、访问码永远输不进去。第二次起只认人点「已输入完成」。
     */
    if (this.accessCodeAutoPassed) {
      this.log(`访问码页：自动判定本轮已用过一次（${page}），改为等人工确认`);
      return;
    }
    this.accessCodeAutoPassed = true;
    this.stopAccessPoll();
    this.log(`访问码页：连续 ${ACCESS_CONFIRM_TIMES} 次不是访问码页（${page}），自动继续`);
    // ⭐ 过完码先把凭据存下来：用户可能这就不登了（或接下来输错密码），下次启动不该再要一次码
    await this.captureGatewayCookies(this.pendingEntry || this.entry);
    await this.onAccessCodeDone({ auto: true });
  }

  /**
   * 「已输入完成」/ 探针发现已经进了应用。
   *
   * 分两种（Android `onAccessCodeDone` 同口径）：
   * - **已有会话**（登录后被网关再拦一次）⇒ 直接进应用；
   * - **还没有会话**（登录前就被 WS 401 挡回来）⇒ 网关凭据这时已种进分区，回连接页把登录重走一遍。
   *
   * @param {{auto?: boolean}} [options] - `auto: true` = 探针自动判定（只准用一次）；默认 = 人点的
   */
  async onAccessCodeDone({ auto = false } = {}) {
    this.stopAccessPoll();
    const entry = this.pendingEntry || this.entry;
    if (!entry) return this.showConnect();
    // 人工点「已输入完成」这条路也要存一次（自动判定那条已经在 handleAccessProbe 里存过）
    if (!auto) await this.captureGatewayCookies(entry);
    if (entry.session?.token) return this.enterBrowsing(entry, null);
    this.log(`访问码已通过（auto=${auto}，第 ${this.accessCodeRounds} 轮），重走登录`);
    const form = this.lastForm || this.state.connect;
    this.state = { ...this.state, screen: 'connect', notice: '访问码已通过，正在重新登录…' };
    this.push();
    /**
     * ⚠️ 这次重登**不能**把访问码轮次清零（那是同一串磋商的继续），否则上限形同虚设。
     * 见 `connect()` 开头对 `reloginFromAccessCode` 的判断。
     */
    this.reloginFromAccessCode = true;
    return this.connect({ ...form });
  }

  // ---------------------------------------------------------------- 浏览

  browsingInfo(entry) {
    const host = entry.baseUrl.replace(/^https?:\/\//, '');
    const isLanGateway = !entry.relayHost && !entry.cleartext && entry.flow !== 'DIRECT' && isPrivateAddress(host.split(':')[0]);
    return {
      host,
      linkLabel: entry.relayHost ? LINK_RELAY : entry.cleartext || entry.flow === 'DIRECT' ? LINK_LAN : isLanGateway ? LINK_LAN_GATEWAY : LINK_GATEWAY,
      account: entry.user || this.prefs.get().lastUser || '',
      title: 'ZXDesk 工作台',
    };
  }

  async enterBrowsing(entry, notice) {
    this.stopAccessPoll();
    this.entry = entry;
    this.pendingEntry = null;
    // 新一轮浏览：还没真进过应用（探针判出 APP 才算），见 enteredApp 的说明
    this.enteredApp = false;
    this.state = {
      ...this.state,
      screen: 'browsing',
      notice: notice || null,
      panel: null,
      accounts: null,
      twofa: null,
      cert: null,
      error: null,
      browsing: this.browsingInfo(entry),
      connect: { ...this.state.connect, busy: false, progress: null },
    };
    this.push();
    this.view.setContext({ baseUrl: entry.baseUrl, relayHost: entry.relayHost, gatewayPath: entry.gatewayPath });
    // ⚠️ 顺序不能变：**先建视图，再写 Cookie**。
    // 0.1.3 是先写 Cookie 后建视图 ⇒ 第一次写进了壳窗口的默认会话，而远程视图用的是 persist:zxdesk 分区，
    // 分区里一条都没有 ⇒ 页面按未登录处理，用户被迫再登一次（第二次视图已在，Cookie 才写对）。
    this.view.ensure();
    await this.applySessionCookies(entry);
    this.view.setVisible(true);
    const ok = await this.loadSafely(entry.startUrl());
    if (ok) await this.captureWebSession(entry);
    // 加载失败不再「换一条路再试」（0.1.5 的 LAN→中继双入口已随 FNID 回退删掉）；
    // 但**页面打不开是整页错误**（与登录失败区分：那个留在登录页），这里必须报出来，
    // 否则就是「进了浏览模式却一直白屏」。
    if (!ok) {
      this.notifyError('打不开页面', '页面没有加载出来，检查网络后点「重试」。', { url: entry.startUrl() });
    }
  }

  /**
   * 写 Cookie 到**远程视图的分区**，并把结果记进日志（⛔ 不打印 Cookie 值）。
   * N = 0 时给 WARN —— 0.1.3 的「登两次」如果复现，这行会直接指出「分区里没有会话 Cookie」。
   */
  async applySessionCookies(entry) {
    if (!entry?.baseUrl) return;
    const target = { baseUrl: entry.baseUrl, relayHost: entry.relayHost };

    /**
     * ⭐ 网关凭据（访问码 Cookie）**先写**，而且不跟登录会话绑在一起。
     *
     * 两件事决定了它必须排在最前、且不受 `session.token` 的早退影响：
     * ① Electron 的 persist 分区不落会话级 Cookie ⇒ 不回注就「每次启动重输访问码」；
     * ② 「过完码但没登录成功」的情况一样要回注 —— 那时 `session.token` 还是空的，
     *    排在早退之后等于这条路径直接失效。
     */
    if (this.gatewayCookies?.load && this.cookies.applyGateway) {
      try {
        const list = await this.gatewayCookies.load(entry.baseUrl);
        if (list.length) {
          const back = await this.cookies.applyGateway(list, target);
          this.log(`网关凭据回注 ${back?.ok ?? '?'}/${back?.total ?? '?'} 条（访问码不用重输）`);
        }
      } catch (e) {
        this.logError(`网关凭据回注失败：${e.message}`);
      }
    }

    /**
     * ⭐ ZXDesk 网页会话（`zxdesk_sid`）也要**排在早退之前**。
     *
     * 服务端刻意把它做成会话级 Cookie —— 飞牛账号与 ZXDesk 账号是两套，
     * 本机只加密保存并回注。但「没有飞牛会话」的那几种入口（8990 直连、只过码没登录）
     * `session.token` 是空的 —— 排在早退之后的话，直连模式下**每次启动都要重登 ZXDesk 账号**
     * （与「抓不到 `zxdesk_sid`」叠加，就是用户看到的「每次都要重新登录」）。
     */
    const spec = webSessionSpec(entry.webSession, { baseUrl: entry.baseUrl });
    if (spec) {
      try {
        await this.cookies.setSpec?.(spec);
        this.log(`注入 Web 会话：zxdesk_sid（host=${entry.webSession.host}）`);
      } catch (e) {
        this.logError(`注入 Web 会话失败：${e.message}`);
      }
    } else if (entry.webSession) {
      this.log(
        `Web 会话 host 不匹配，本次先登录：保存的是 ${entry.webSession.host}，当前是 ${hostOf(entry.baseUrl)}`,
      );
    }

    // 飞牛登录会话（没有就到此为止 —— 上面两类都已经写完了）
    if (!entry.session?.token && !entry.session?.setCookies?.length) return;
    try {
      const result = await this.cookies.apply(entry.session, target);
      let names = [];
      try {
        names = (await this.cookies.names?.(entry.baseUrl)) || [];
      } catch {
        names = [];
      }
      const ok = result?.ok ?? '?';
      const total = result?.total ?? '?';
      const list = names.length ? names.join(',') : '（空）';
      const line = `Cookie 注入 ${ok}/${total} → ${entry.baseUrl}（分区 ${this.cookies.partition || 'persist:zxdesk'}，现存 ${names.length} 条：${list}）`;
      if (names.length === 0) this.logError(`WARN ${line}`);
      else this.log(line);
    } catch (e) {
      this.logError(`Cookie 注入失败：${e.message}`);
    }
  }

  /**
   * 抓一次网关凭据（访问码 Cookie）并落盘。
   *
   * 时机有两个，缺一不可：
   * ① **刚过完访问码**（`handleAccessProbe` 判到已离开时）—— 用户可能过了码却没登录成功
   *    （密码打错、只是来试一下），下一次启动依然不该重输访问码；
   * ② 登录成功进入浏览模式后（`captureWebSession`）—— 网关可能在这时续期 / 补种。
   *
   * @param {object} entry
   * @param {Array<object>|null} [list] - 已经取到的 Cookie 列表（省一次读取）
   */
  async captureGatewayCookies(entry, list = null) {
    if (!entry?.baseUrl || !this.gatewayCookies?.save || !this.cookies?.get) return;
    try {
      const cookies = list || (await this.cookies.get(entry.baseUrl));
      const picked = pickGatewayCookies(cookies);
      if (!picked.length) return;
      const before = await this.gatewayCookies.load(entry.baseUrl);
      if (JSON.stringify(before) === JSON.stringify(picked)) return;
      const ok = await this.gatewayCookies.save(entry.baseUrl, picked);
      // ⛔ 只记条数与名字 —— 值等于「这台设备已经过码」的准入凭据
      if (ok) this.log(`网关凭据捕获：${picked.length} 条（${picked.map((c) => c.name).join('、')}），下次启动不用重输访问码`);
    } catch (e) {
      this.logError(`捕获网关凭据失败：${e.message}`);
    }
  }

  /**
   * 把 `zxdesk_sid` 读出来存进快照（只这一条，⛔ 其它 Cookie 不落盘）。
   * 会话失效（`session_epoch` 变了）时服务端会让页面回登录页，用户登一次即可 —— 不是 bug。
   *
   * ⚠️ 调用点有三个，缺一个都会「每次启动重新登录 ZXDesk 账号」：
   * ① 页面加载完的探针（`onProbe`）；② 进入浏览模式后；③ **响应头下发 `zxdesk_sid` 的当场**
   * （`RemoteView.onWebSession`）—— ZXDesk 的账号登录是页面里的 XHR，成功后不整页导航，
   * ①② 两条都等不到，只有 ③ 能接住。
   */
  async captureWebSession(entry = this.entry) {
    if (!entry || !this.cookies.get) return;
    try {
      const list = await this.cookies.get(entry.baseUrl);
      /**
       * ⭐ 顺手把**网关凭据**（访问码 Cookie）也抓下来。
       *
       * 它必须落盘：Electron 的 persist 分区只持久化带有效期的 Cookie，网关访问码那条是
       * 会话级 ⇒ 应用一关就没 ⇒ 用户每次启动都要重新输码。
       * 存的是独立文件（`gateway.bin`），不是 session.bin —— 退出登录不该把访问码也忘掉。
       */
      await this.captureGatewayCookies(entry, list);
      const picked = pickWebSession(list, entry.baseUrl);
      if (!picked) {
        this.log('Web 会话捕获：无（网页还没登录，或已被踢）');
        return;
      }
      if (entry.webSession && entry.webSession.value === picked.value) return;
      entry.webSession = picked;
      await this.sessions.save(entry);
      this.log(`Web 会话捕获：有（host=${picked.host}）`);
    } catch (e) {
      this.logError(`捕获 Web 会话失败：${e.message}`);
    }
  }

  /** 加载并返回是否成功（RemoteView.loadChecked 会等 did-finish-load / did-fail-load）。 */
  async loadSafely(url) {
    try {
      if (typeof this.view.loadChecked === 'function') return await this.view.loadChecked(url);
      await this.view.load(url);
      return true;
    } catch (e) {
      this.logError(`加载页面失败：${url}`, e);
      // ⚠️ `e.message` 里带 `ERR_… loading 'https://…'` ⇒ 会直接把内部地址露在界面上。
      // 界面上只留人话，地址与错误码进 detail（「复制诊断」里才有）。
      this.notifyError('打不开页面', '页面没有加载出来，检查网络后点「重试」。', { url, error: e.message || String(e) });
      return false;
    }
  }

  openPanel() {
    if (this.state.screen !== 'browsing') return;
    this.view.setVisible(false);
    this.state = {
      ...this.state,
      panel: {
        host: this.state.browsing?.host || '',
        linkLabel: this.state.browsing?.linkLabel || '',
        account: this.state.browsing?.account || '',
        version: APP_VERSION,
      },
      browsing: {
        ...(this.state.browsing || {}),
        canBack: this.view.canGoBack(),
        canForward: this.view.canGoForward(),
      },
    };
    this.push();
  }

  closePanel() {
    this.state = { ...this.state, panel: null };
    this.push();
    if (this.state.screen === 'browsing') this.view.setVisible(true);
  }

  /**
   * 退出登录 / 换个地址。
   *
   * `keepCredentials`：**换地址**时保留记住的密码（只清会话与 Cookie），
   * 只有真正的「退出登录」才连凭据一起清。TOFU 与偏好两者都不动（与 Android 一致）。
   */
  async logout({ keepSession = false, keepCredentials = true, note = null, signedOut = false } = {}) {
    this.stopAccessPoll();
    // 让所有在飞的登录 / 恢复结果作废（否则它们回来后会把人重新送回主界面，见 authEpoch）
    this.authEpoch += 1;
    this.enteredApp = false;
    this.flow?.close();
    this.flow = null;
    if (signedOut) {
      // 明确记下「是他自己退出的」：否则下次冷启动的静默登录会把他直接送回主界面
      this.prefs.patch({ signedOut: true });
      this.log('已记为「主动退出」，下次启动不再自动登录');
    }
    if (!keepSession) {
      this.sessions.clear();
      await this.cookies.clear();
      this.triedLongToken = false;
      this.triedPasswordRelogin = false;
    }
    if (!keepCredentials) {
      /**
       * 只清**当前这台设备 + 这个账号**的密码（多账号：退出 A 不该顺手把 B 的密码也删了）。
       * 拿不到地址 / 账号时才退回全清 —— 那说明本来就没有「当前账号」可言。
       */
      const address = this.entry?.address || this.pendingAddress || this.prefs.get().lastAddress;
      const user = this.entry?.user || this.prefs.get().lastUser;
      await this.credentials.clear(address, user);
      this.log('已清掉当前账号记住的密码');
    } else {
      this.log('退出登录 / 换个地址：保留记住的密码（要彻底清请点「清除」）');
    }
    this.entry = null;
    this.pendingEntry = null;
    this.view.setVisible(false);
    this.state = { ...this.state, panel: null, browsing: null, twofa: null, accounts: null, screen: 'connect', connect: this.connectFormState(note) };
    this.push();
    // ⚠️ 这条路自己拼了 state（没走 showConnect）⇒ 预填要显式触发，
    // 否则「退出登录 / 换个地址 → 回连接页」密码框是空的（0.1.6 出现过）
    void this.prefillPassword();
  }

  /**
   * 远程视图探针回调。
   *
   * ⚠️ **捕获放在最前面、且不看 `page`**：ZXDesk 应用根是 SPA，探针常给 `UNKNOWN`；
   * 0.1.6 初版写成 `page === APP 才捕获`，结果一次都没捕获过 ⇒ 自动登录形同不存在。
   * `captureWebSession()` 自己「没 Cookie 就返回」，登录前调用没有副作用。
   */
  async onProbe(page) {
    if (this.entry) void this.captureWebSession(this.entry);
    if (this.state.screen === 'access') {
      // 离开访问码页（用户输入完成 / 网关自己跳走）⇒ 自动继续。
      // ⚠️ 判据要**连续两次**「不是访问码页」：网关从访问码页往下跳会经过中间页，
      // 单次判定会把它当成「已经进去了」⇒ 重登又吃 401、又弹回这一页（Android 0.2.17 真机踩过）。
      // 另：过码后网关回的是纯文本 `invalid token`，所以 LOGIN_REQUIRED 也算「已经离开」。
      await this.handleAccessProbe(page);
      return;
    }
    if (this.state.screen !== 'browsing') return;
    // 真的看见应用页了：这一轮才算「进过应用」，后面会话过期可以静默续（见 enteredApp）
    if (page === GATEWAY_PAGE.APP) this.enteredApp = true;
    if (page === GATEWAY_PAGE.ACCESS_CODE) {
      const entry = this.entry;
      if (!entry) return;
      // ⚠️ 防抖：这句判据是「按正文猜的」，同一次加载里可能连触发几次；判定一抖界面就来回跳
      const now = Date.now();
      if (now - this.lastAccessCodeSwitchAt < ACCESS_CODE_SWITCH_MS) {
        this.log('访问码页判定重复出现，已忽略');
        return;
      }
      this.lastAccessCodeSwitchAt = now;
      this.log('页面被判成访问码页，进第 ④ 步');
      await this.showAccessCode(entry, '网关要访问码，先在下面输入');
      return;
    }
    if (page === GATEWAY_PAGE.LOGIN_REQUIRED) await this.onSessionExpired();
  }

  /**
   * 页面 401 要跳 `/login.html`：先静默把会话续上，别让人直接看见登录页
   * （Android `onLoginPageBlocked` 同口径）。
   *
   * @returns {boolean} true = 已接手（页面不要跳登录页）；false = 30 秒内试过了 / 没凭据，放行
   */
  onLoginPageBlocked() {
    if (this.state.screen !== 'browsing') return false;
    const entry = this.entry;
    if (!entry) return false;
    /**
     * ⭐ 这里**不再要求** `entry.session.token`（照 Android 0.3.1 第十二条）。
     *
     * 原来那句 `if (!entry?.session?.token) return false` 看着像「没会话就不用续」，
     * 实际把**最该续的一次**直接放过去了：手里没有会话、页面又被网关要求登录，
     * 恰恰是该拿本机凭据去换一份回来的时刻。放行之后页面自己跳 `/login.html`，
     * 用户看到的就是登录页（或者那一页白屏），只会以为「客户端没登录」。
     * 现在一律交给 `recoverSession` 自己判：有 longToken 走换新，没有就落「记住的密码」，
     * 两样都没有才 `failRelogin` 提示，⛔ 不会假装成功。
     */
    if (this.recovering) {
      this.log('页面要跳登录页：会话恢复已在进行');
      return true;
    }
    if (Date.now() - this.lastRecoverAt < SILENT_RECOVER_MS) {
      this.log('页面要跳登录页：30 秒内已试过，放行');
      return false;
    }
    this.log('页面要跳登录页，先静默续会话');
    void this.recoverSession({ silent: true });
    return true;
  }

  /** 会话失效：静默恢复（不切屏）；失败只写菜单栏那一条红字。 */
  async onSessionExpired() {
    /**
     * ⚠️ `silent` 不能只看「当前是不是浏览屏」：
     * 冷启动带的是过期快照时，页面一上来就是纯文本 `invalid token` —— 静默重连再失败，
     * 用户就停在一张没有按钮的白页上，唯一出口藏在菜单里（0.2.4 真机就是这个观感）。
     * 判据改成「这一轮真的进过应用」：进过 ⇒ 静默续，别打断；没进过 ⇒ 走正常恢复，
     * 失败就回连接页并写明「登录状态已失效」（Android 0.2.18 同口径）。
     */
    await this.recoverSession({ silent: this.state.screen === 'browsing' && this.enteredApp });
  }

  /**
   * 恢复会话，三段：① longToken 换新会话；② 记住的密码重登；③ 都不行回登录页。
   *
   * @param {object} [options]
   * @param {boolean} [options.silent] - true = 回前台 / 页面 401 的自动重连：**不切屏**，
   *   失败只在菜单栏提示一句（Android `failRelogin(silent)` 同口径）
   */
  async recoverSession({ silent = false } = {}) {
    if (this.recovering) {
      this.log('会话恢复已在进行，跳过');
      return;
    }
    if (Date.now() - this.lastRecoverAt < SILENT_RECOVER_MS) {
      this.log('自动重连：30 秒内已试过，跳过');
      return;
    }
    this.lastRecoverAt = Date.now();
    this.recovering = true;
    // 这是一次新的断线事件：允许 longToken 与密码各再试一次
    this.triedLongToken = false;
    this.triedPasswordRelogin = false;
    try {
      const saved = await this.sessions.load();
      if (!saved) {
        if (silent) return this.silentRecoverFailed('连接已断开，请重新登录');
        return this.backToLogin('登录状态已失效，请重新登录', true);
      }
      if (await this.recoverWithLongToken(saved, silent)) return;
      if (await this.recoverWithPassword(saved, silent)) return;
      if (silent) return this.silentRecoverFailed('自动重连失败，请重新登录');
      // 快照在、但两条路都走不通（没记住密码 / 密码也失效）⇒ 统一说「登录状态已失效」。
      // 从 0.2.5 起冷启动会话失效也会走到这里（以前是静默失败、人停在 invalid token 白页上），
      // 所以文案不能再叫「自动登录失败」—— 那会被理解成「客户端自己去登了，跟我没关系」。
      return this.backToLogin('登录状态已失效，请重新登录', true);
    } finally {
      this.recovering = false;
    }
  }

  /** 第 ① 段：longToken 免密换新会话。返回 true = 已接手（成功 / 要 2FA / 要访问码 / 已切屏）。 */
  async recoverWithLongToken(saved, silent) {
    const longToken = saved.session?.longToken;
    if (this.triedLongToken || !longToken) return false;
    this.triedLongToken = true;
    // 旧快照没有账号（见 afterAuth 的说明）：退回「上次登录的账号」，只用于请求里的标识
    const user = saved.user || this.prefs.get().lastUser || '';
    const flow = new FnLoginFlow({
      baseUrl: saved.baseUrl,
      relay: Boolean(saved.relayHost),
      user,
      password: '',
      deviceId: this.prefs.get().deviceId,
      savedSecret: saved.session.secret,
      gatewayCookie: () => this.handshakeCookie(saved, '恢复登录握手 Cookie'),
      rpcFactory: this.rpcFactory || ((url, cookie) => new WsClient({ url, cookie, onSelfSigned: (host, info) => this.requestTrust(host, info) })),
      fetcher: this.probeFetcher || this.fetcher,
      onStep: (label) => this.log(`恢复登录：${label}`),
    });
    /**
     * ⚠️ 赋新值前先关旧的（照 Android 0.3.1 第四条）：
     * 上一次没走完的 `FnLoginFlow` 带着一条 WS 和一个 20 秒心跳，不关就再没人关得掉 ——
     * 飞牛那边看到的是同一台设备反复建连，而本机每次恢复都多留一条连接。
     */
    this.flow?.close();
    this.flow = flow;
    this.pendingEntry = saved;
    this.flowEpoch = this.authEpoch;
    // 自动恢复不改动已存凭据（remember=null）
    this.pendingCredential = { user, password: '', remember: null, address: saved.address };
    try {
      const result = await flow.startWithLongToken(longToken);
      if (result.session) {
        await this.afterAuth(result.session, { silent });
        return true;
      }
      // 需要 2FA：flow 必须留着（验证码要用同一个 accessToken / WS），⛔ 不能在这里 close
      await this.finishLogin(result);
      return true;
    } catch (e) {
      this.flow?.close();
      this.flow = null;
      if (e instanceof AccessCodeRequiredError) {
        this.log(`恢复登录被网关拦下（HTTP ${e.status || '401/403'}），进第 ④ 步`);
        this.guard.reset();
        await this.showAccessCode(saved, '网关要访问码，先在下面输入');
        return true;
      }
      this.log(`longToken 恢复失败：${e.message}`);
      return false;
    }
  }

  /** 第 ② 段：用记住的密码静默重登。凭据与本次会话的地址、账号都对得上才用（⛔ 张冠李戴）。 */
  async recoverWithPassword(saved, silent) {
    if (this.triedPasswordRelogin) return false;
    /**
     * 多账号：按「这台设备 + 这个账号」精确取。
     *
     * ⚠️ 「账号一致」在 0.2.4 及以前的快照上是**永远不成立**的（`saved.user` 是空串，
     * 见 `afterAuth` 的说明）—— 于是这条恢复路径在这之前从没真正跑过。
     * 旧快照没有账号时退回「上次登录的账号」（`prefs.lastUser`），否则老用户升级上来依然自动重连不了。
     */
    const wantedUser = saved.user || this.prefs.get().lastUser || '';
    const credential = await this.credentialFor(saved.address, wantedUser);
    if (!credential) {
      // ⚠️ 这条以前是「没有日志的出口」，真机只能看到一句「自动重连失败」，看不出是没记住还是密码错了
      this.log(`密码重登：本机没记住 ${saved.address} / ${wantedUser || '（账号未知）'} 的密码`);
      return false;
    }
    if (!saved.user) this.log(`密码重登：会话快照里没有账号（旧版本存下的），按地址匹配到 ${credential.user}`);
    this.triedPasswordRelogin = true;
    const flow = new FnLoginFlow({
      baseUrl: saved.baseUrl,
      relay: Boolean(saved.relayHost),
      user: credential.user,
      password: credential.password,
      deviceId: this.prefs.get().deviceId,
      gatewayCookie: () => this.handshakeCookie(saved, '密码重登握手 Cookie'),
      rpcFactory: this.rpcFactory || ((url, cookie) => new WsClient({ url, cookie, onSelfSigned: (host, info) => this.requestTrust(host, info) })),
      fetcher: this.probeFetcher || this.fetcher,
      onStep: (label) => this.log(`密码重登：${label}`),
    });
    /**
     * ⚠️ 赋新值前先关旧的（照 Android 0.3.1 第四条）：
     * 上一次没走完的 `FnLoginFlow` 带着一条 WS 和一个 20 秒心跳，不关就再没人关得掉 ——
     * 飞牛那边看到的是同一台设备反复建连，而本机每次恢复都多留一条连接。
     */
    this.flow?.close();
    this.flow = flow;
    this.pendingEntry = saved;
    this.flowEpoch = this.authEpoch;
    // 用**凭据里的账号**（就是这次真正登录的账号），落盘时才会写进快照
    this.pendingCredential = { user: credential.user, password: '', remember: null, address: saved.address };
    try {
      const result = await flow.start();
      if (result.session) {
        await this.afterAuth(result.session, { silent });
        return true;
      }
      // 需要 2FA：flow 必须留着（同 longToken 那条）
      await this.finishLogin(result);
      return true;
    } catch (e) {
      this.flow?.close();
      this.flow = null;
      if (e instanceof AccessCodeRequiredError) {
        this.log(`密码重登被网关拦下（HTTP ${e.status || '401/403'}），进第 ④ 步`);
        this.guard.reset();
        await this.showAccessCode(saved, '网关要访问码，先在下面输入');
        return true;
      }
      this.log(`密码重登失败：${e.message}`);
      return false;
    }
  }

  /**
   * 静默重连失败：**只提示、不切屏**。
   *
   * 探活的判据只是「一次 GET 的正文」，也可能是误判（Cookie 过期、网关抖动）。
   * 因为一句话就把人踢回登录页，代价远大于让他留在原地再点一次 —— 真失效时页面自己会提示。
   */
  silentRecoverFailed(message) {
    this.log(message);
    this.state = { ...this.state, browsing: { ...(this.state.browsing || {}), error: message } };
    this.push();
  }

  /**
   * 回到前台（窗口获得焦点 / 系统唤醒）：对主界面做一次静默探活。
   *
   * ⚠️ 探活**只诊断、不重建页面**（Android 0.2.17 的结论：判据只是一次 GET 的正文，
   * 认错一次的代价是整页重载）。真正发起重连的是两个可靠信号：
   * ① 页面 401 要跳 `/login.html`（`RemoteView` 的登录页拦截 → `onLoginPageBlocked`）；
   * ② 页面加载完探针说 `invalid token`（`onProbe` → `onSessionExpired`）。
   */
  async onForeground() {
    if (this.state.screen !== 'browsing') return null;
    return this.probeBrowsingSession();
  }

  async probeBrowsingSession() {
    const entry = this.entry;
    if (!entry || entry.flow !== 'GATEWAY') return null;
    if (this.recovering || this.probing) return null;
    // 自动登录关掉 = 不在后台动网络（与启动时不恢复会话是同一个开关）
    if (this.prefs.get().autoLogin === false) return null;
    const now = Date.now();
    if (now - this.lastProbeAt < PROBE_INTERVAL_MS) return null;
    this.lastProbeAt = now;
    this.probing = true;
    try {
      // ⭐ 优先用分区自己的 fetch：服务端会 Set-Cookie 续期，`ses.fetch` 读的正是那份最新 Cookie；
      // 手拼会话快照会被旧值覆盖（Android 0.2.17 的「探活必须用 CookieManager 当前值」同一条）。
      const fetchImpl = this.probeFetcher || this.fetcher;
      if (!fetchImpl) return null;
      const page = await probeGateway({
        baseUrl: entry.baseUrl,
        gatewayPath: entry.gatewayPath,
        cookieHeader: this.probeFetcher ? undefined : await this.probeCookieHeader(entry, entry.session),
        fetchImpl,
      });
      if (page === GATEWAY_PAGE.APP) {
        this.enteredApp = true;
        this.log('回前台探活：会话仍有效');
      } else if (page === GATEWAY_PAGE.ACCESS_CODE) {
        this.log('回前台探活：网关要访问码，等页面自己弹');
      } else if (page === GATEWAY_PAGE.LOGIN_REQUIRED) {
        /**
         * ⚠️ 以前这里只写日志（「等页面 401 再兜」）—— 但 `invalid token` 那一页是**纯文本**，
         * 它根本不会再跳 401 / 登录页，等于在等一个永远不会来的信号。
         * 这一轮进过应用 ⇒ 页面自己会重载 / 用户还在操作，保持静默；
         * 没进过应用 ⇒ 说明开屏就是失效会话，直接走恢复（失败会回连接页，不把人钉在白屏上）。
         */
        this.log(`回前台探活：疑似 invalid token（本轮${this.enteredApp ? '进过' : '没进过'}应用）`);
        if (!this.enteredApp) await this.onSessionExpired();
      } else this.log('回前台探活：响应认不出，保持现状');
      return page;
    } catch (e) {
      this.log(`回前台探活失败：${e.message}`);
      return null;
    } finally {
      this.probing = false;
    }
  }

  async backToLogin(note, dropSaved) {
    // dropSaved 只清**会话快照**；credential.bin 留着，用户回连接页时密码还在
    if (dropSaved) this.sessions.clear();
    await this.logout({ keepSession: true, keepCredentials: true, note });
    // 与登录失败一致：留在连接页，按钮下方一行「登录失败」（原因在 notice 里说一句人话）
    this.patchConnect({ error: '登录失败' });
  }

  // ---------------------------------------------------------------- 证书

  /**
   * 证书确认（远程视图 `setCertificateVerifyProc` 与原生 WS 共用一条判定）。
   * @returns {Promise<boolean>} 用户/记录是否放行
   */
  requestTrust(host, info) {
    const saved = this.tofu.get(host);
    const verdict = decideTrust({ subject: info.subjectText || info.subject, sha256: info.fingerprint256 || info.sha256 }, saved);
    this.log(`证书判定 ${host}：${verdict.decision}`);
    if (verdict.decision === TRUST.ACCEPT) {
      this.tofu.put(host, { subject: verdict.subject, sha256: verdict.sha256 });
      return Promise.resolve(true);
    }
    if (verdict.decision === TRUST.REJECT) return Promise.resolve(false);
    /**
     * ⚠️ 同一台设备的第一次连接会**并发问两次**：页面加载走一遍 `setCertificateVerifyProc`，
     * 登录前的网关探测 / WS 握手又走一遍。每问一次就压一屏确认、多一个等待者 —— 而且第二次
     * 会把 `screenBeforeCert` 覆盖成 `'cert'`：用户确认完第一屏，界面停在**一张空的证书页**上
     * （`state.cert` 已被清空），第二个等待者永远不落地，页面就那么卡着。
     * ⇒ 同一个 host ＋ 同一份指纹只问一次，后来者复用同一个 Promise。
     */
    const pending = this.certWaiters.find((w) => w.host === host && w.sha256 === verdict.sha256);
    if (pending) {
      this.log(`证书确认已在等待（${host}），复用同一个确认`);
      return pending.promise;
    }
    const waiter = {
      host,
      sha256: verdict.sha256,
      subject: verdict.subject,
      previousSha256: verdict.previousSha256 || null,
      rotated: verdict.decision === TRUST.ROTATED,
      resolve: null,
      promise: null,
    };
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = resolve;
    });
    this.certWaiters.push(waiter);
    // 已经有一屏在问（另一台设备）⇒ 排队等着，⛔ 不要把正在看的那一屏换掉
    if (!this.state.cert) this.showCertPrompt(waiter);
    else this.log(`证书确认排队（${host}）：等当前这一屏处理完`);
    return waiter.promise;
  }

  /** 把一屏证书确认推到界面上（并收起远程视图 —— 浮层盖不住 `WebContentsView`）。 */
  showCertPrompt(waiter) {
    this.state = {
      ...this.state,
      cert: {
        host: waiter.host,
        subject: waiter.subject,
        sha256: waiter.sha256,
        previousSha256: waiter.previousSha256,
        rotated: waiter.rotated,
      },
      // 已经在证书屏时不要把「回到哪」记成 'cert'（否则确认完会停在一张空白证书页上）
      screenBeforeCert: this.state.screen === 'cert' ? this.state.screenBeforeCert || 'connect' : this.state.screen,
      screen: 'cert',
    };
    this.push();
    this.view.setVisible(false);
  }

  decideCert(trust) {
    const cert = this.state.cert;
    if (!cert) return null;
    // 同一份指纹的等待者一起放行（页面与探测是并发问的，不该只放一半）
    const decided = this.certWaiters.filter((w) => w.host === cert.host && w.sha256 === cert.sha256);
    this.certWaiters = this.certWaiters.filter((w) => !decided.includes(w));
    if (trust && decided.length) this.tofu.put(cert.host, { subject: cert.subject, sha256: cert.sha256 });
    const restore =
      this.state.screenBeforeCert && this.state.screenBeforeCert !== 'cert' ? this.state.screenBeforeCert : 'connect';
    if (this.certWaiters.length) {
      // 还有别的设备在等：接着问下一台（⛔ 别只弹一屏就再也不弹，让那一边永远等不到）
      this.state = { ...this.state, cert: null, screenBeforeCert: restore };
      this.showCertPrompt(this.certWaiters[0]);
    } else {
      this.state = { ...this.state, screen: restore, cert: null, screenBeforeCert: null };
      this.push();
      if (restore === 'browsing') this.view.setVisible(true);
    }
    for (const waiter of decided) waiter.resolve(Boolean(trust));
    return null;
  }

  // ---------------------------------------------------------------- 更新（独立窗口）

  /**
   * 给更新窗口与壳的更新状态。`banner` 只在「连接页 / 浏览页这类常规屏幕」为真 ——
   * 证书确认与两步验证是必须当场做完的事，⛔ 不在那两屏上叠更新提示。
   */
  updateUi() {
    if (!this.updater) return null;
    const state = this.updater.snapshot();
    // 包被删了 / 数据目录被清过：别让界面停在「已就绪」（点「立即安装」只会说路径没了），
    // 退回收「下载更新」，用户点一下就能重下。
    if (state.phase === 'ready' && typeof this.updater.downloadedFile === 'function' && !this.updater.downloadedFile()) {
      state.phase = 'available';
      state.progress = null;
      state.filePath = '';
    }
    const skipped = Boolean(state.latest) && this.prefs.get().updateSkippedVersion === state.latest;
    // 浏览模式不放提示条：远程视图盖住内容区，条子会被它挡住；那一屏的信号在「帮助」菜单上
    const bannerScreens = ['mode', 'connect'];
    return {
      ...state,
      skipped,
      /**
       * 错误翻成人话：窗口只负责画，⛔ 不让它自己认 error.kind。
       * ⚠️ 只有「检查」阶段的错误才走这张表；give-up 是下载停手，它的 message 是
       * 「哪个源、哪一步不对」，被盖成「检查更新失败」会把排查线索抹掉。
       */
      error: state.error
        ? {
            ...state.error,
            message: state.error.kind === 'give-up' ? state.error.message : updateFailureText(state.error),
          }
        : null,
      /** 下载 / 打开安装包时的失败文案：显示在更新窗口的状态行里，⛔ 不另开系统弹窗。 */
      actionError: this.updateActionError || '',
      banner: Boolean(state.available) && !skipped && bannerScreens.includes(this.state.screen),
    };
  }

  /**
   * 启动后延迟静默检查一次。
   * 用延迟而不是启动即查：先让页面/登录跑起来，别让一个可选功能占住启动时的网络。
   */
  scheduleUpdateCheck(delayMs = 10_000) {
    if (!this.updater) return;
    if (this.prefs.get().updateAutoCheck === false) return;
    const timer = setTimeout(() => {
      this.checkUpdate({ silent: true }).catch((e) => this.logError('自动检查更新失败', e));
    }, delayMs);
    timer.unref?.();
  }

  async checkUpdate({ silent = false } = {}) {
    if (!this.updater) return null;
    this.updateActionError = null;
    await this.updater.check({ silent });
    this.push();
    return null;
  }

  /**
   * 「帮助 → 检查更新…」与壳上的提示：打开**独立更新窗口**，检查在后台跑。
   *
   * 为什么不是 `dialog.showMessageBox`：更新要展示版本号、更新说明、下载进度，下载完按钮还要
   * 从「下载更新」换成「立即安装」—— 原生消息框是一次性问答，撑不住这个过程；
   * 画在壳里也不行（`WebContentsView` 永远盖在 DOM 之上，藏视图就白屏）。
   */
  async openUpdate() {
    if (!this.updater) return null;
    this.openUpdateWindow?.();
    // 不 await：窗口要先亮起来显示「正在检查…」，结果再推回来
    this.checkUpdate({ silent: false }).catch((e) => this.logError('检查更新失败', e));
    return null;
  }

  /** 下载并校验。进度经状态推送进更新窗口与任务栏，⛔ 不弹窗打断。 */
  async downloadUpdate() {
    if (!this.updater) return null;
    this.updateActionError = null;
    await this.updater.download();
    const state = this.updater.snapshot();
    if (state.phase !== 'ready') this.updateActionError = downloadFailureText(state.error);
    this.push();
    return null;
  }

  /** 打开已校验的包：安装版直接运行安装程序，绿色包只定位到文件夹（覆盖解压由用户决定）。 */
  async openUpdateFile() {
    const file = this.updater?.downloadedFile();
    if (!file) {
      this.updateActionError = '安装包不见了，请重新下载。';
      this.push();
      return null;
    }
    if (!this.revealPackage) {
      this.updateActionError = '这个版本不能自动打开安装包，请到数据目录的 updates 文件夹里找。';
      this.push();
      return null;
    }
    const result = await this.revealPackage(file);
    this.updateActionError = result?.ok === false ? result.message || '打不开安装包' : '';
    this.push();
    return null;
  }

  /**
   * 「前往百度网盘下载」：自动下载连续失败后的出口。
   * 只打开清单里带的那个地址（http/https 已在 client.js 校验过），⛔ 不接受界面传入的任意 URL。
   */
  async openFallback() {
    const url = this.updater?.snapshot()?.fallbackUrl || '';
    if (!url) {
      this.updateActionError = '服务器没有配网盘地址，请稍后再试或联系管理员。';
      this.push();
      return null;
    }
    if (!this.openExternal) {
      this.updateActionError = '这个版本打不开外部链接，请手动复制地址访问。';
      this.push();
      return null;
    }
    const result = await this.openExternal(url);
    this.updateActionError = result?.ok === false ? result.message || '打不开浏览器' : '';
    this.push();
    return null;
  }

  /** 「以后再说」：只忽略这一版，下次发新版会重新提示。 */
  skipUpdate() {
    const state = this.updater?.snapshot();
    if (!state || !state.latest) return null;
    if (state.mustUpdate) {
      this.log('强制更新：不允许忽略');
      return null;
    }
    this.prefs.patch({ updateSkippedVersion: state.latest });
    this.push();
    return null;
  }

  // ---------------------------------------------------------------- 公告（独立窗口）

  noticeUi() {
    if (!this.notices) return null;
    const state = this.notices.snapshot();
    return { ...state, hasUnread: state.unread > 0 };
  }

  /**
   * 启动后延迟拉一次公告。
   * 拉完只更新「公告条 + 帮助上的未读标记」，⛔ 不自动弹窗 —— 公告不该打断用户正在做的事。
   */
  scheduleNoticeCheck(delayMs = 12_000) {
    if (!this.notices) return;
    const timer = setTimeout(() => {
      this.checkNotices({ silent: true }).catch((e) => this.logError('自动检查公告失败', e));
    }, delayMs);
    timer.unref?.();
  }

  async checkNotices({ silent = false } = {}) {
    if (!this.notices) return null;
    await this.notices.check({ silent });
    this.push();
    return null;
  }

  /** 「帮助 → 公告」与点公告条：都打开**公告窗口**（历史列表在窗口里滚）。 */
  openNotice() {
    this.openNoticeWindow?.();
    return null;
  }

  /** 全部标为已读：公告窗口关闭、启动弹窗关闭、窗口里的「全部标为已读」都走这里。 */
  markNoticesRead() {
    if (!this.notices) return null;
    const ids = this.notices.markAllRead();
    this.prefs.patch({ noticeReadIds: ids });
    this.push();
    return null;
  }

  // ---------------------------------------------------------------- 错误与诊断

  /**
   * 出错时只**提示**，不换屏、不藏视图。
   *
   * 删掉「打不开页面」那个整页错误屏：一次网络抖动就把整窗刷成白底
   * ＋三个按钮，比错误本身更吓人，还把正在做的事（浏览 / 连接）全打断了。
   * 现在的落点：
   * - 浏览 / 访问码：视图还在，错误写到**菜单栏**右侧那一条（菜单栏在视图之上，看得见），带「重试」；
   * - 连接 / 模式等屏：写进该屏已有的内联提示（`state.notice`）。
   * 细节（错误码、地址、原始 message）只进 `state.error`，供「复制诊断」用，⛔ 不上屏。
   */
  notifyError(title, message, detail = null) {
    this.state = {
      ...this.state,
      // ⚠️ screen 不变：这就是「删掉整页错误」的全部意思
      error: { title, message, detail },
      connect: { ...this.state.connect, busy: false, progress: null },
    };
    this.log(`${title}：${message}`);
    if (this.state.screen === 'starting') {
      // 启动阶段就出错：⛔ 不能把人留在转圈的启动屏上
      this.state = {
        ...this.state,
        screen: 'connect',
        starting: null,
        connect: { ...this.connectFormState(message), error: message },
      };
    } else if (this.state.screen === 'browsing' || this.state.screen === 'access') {
      this.state = { ...this.state, browsing: { ...this.state.browsing, error: message } };
    } else {
      this.state = { ...this.state, notice: message };
    }
    this.push();
  }

  /** 菜单栏「重试」：页面还在就重载，不重新走一遍连接（省一次登录）。 */
  retryBrowsing() {
    if (this.state.screen !== 'browsing' && this.state.screen !== 'access') return null;
    this.state = { ...this.state, browsing: { ...this.state.browsing, error: null } };
    this.push();
    try {
      this.view.reload();
    } catch (e) {
      this.logError('重载页面失败', e);
    }
    return null;
  }

  /** 复制诊断（脱敏后的纯文本，⛔ 不含 token / 密码 / Cookie）。 */
  diagnosticsText() {
    const saved = this.entry || this.pendingEntry;
    const form = this.state.connect;
    const lines = [
      `ZXDesk ${APP_VERSION}`,
      `屏幕：${this.state.screen}`,
      `地址：${saved?.baseUrl || form.address || '-'}`,
      `链路：${this.state.browsing?.linkLabel || '-'}`,
      `错误：${this.state.error ? `${this.state.error.title} / ${this.state.error.message}` : '-'}`,
      this.lastAttempt
        ? `最近一次尝试：${this.lastAttempt.baseUrl || '-'}（步骤：${this.lastAttempt.step}）`
        : '最近一次尝试：-',
      this.lastAttempt?.error ? `原始错误：${this.lastAttempt.error}` : null,
      `日志：${this.logPath || '-'}`,
    ].filter(Boolean);
    return lines.join('\n');
  }
}

/** 局域网网关默认用 64999（实测值；`ConnectionPlanner` 的默认 https 端口没用，因为这里要强制端口）。 */
const DEFAULT_HTTPS_PORT_FOR_GATEWAY = 64999;

/** 检查失败的一句话（弹窗用）：⛔ 不把接口地址与原始错误抛给用户。 */
function updateFailureText(error) {
  switch (error?.kind) {
    case 'not-published':
      return '服务器上还没有这个版本的发布记录。';
    case 'timeout':
      return '更新服务响应超时，检查网络后再试。';
    case 'network':
      return '连不上更新服务，检查网络后再试。';
    case 'http':
      return '更新服务暂时不可用，稍后再试。';
    case 'invalid':
      return '服务器返回的更新信息不完整，暂不能更新。';
    case 'config':
      return '更新地址配置有误，请联系管理员。';
    default:
      return '检查更新失败，稍后再试。';
  }
}

/** 下载失败的一句话；hash 不符单独说清楚（那是「包不可信」，不是网络问题）。 */
function downloadFailureText(error) {
  if (String(error?.message || '').includes('SHA256')) return '安装包校验没通过，已删除，请重新下载。';
  switch (error?.kind) {
    // give-up 是「自动下载已经停手」，文案要与更新窗口里那句一致：
    // 不写「下载失败，稍后再试」——那会让人以为再点一次就好，而这条路的出口是网盘。
    case 'give-up':
      return '自动下载没能完成，可以换网络再试一次，或用网盘地址手动更新。';
    case 'unreachable':
      return '连不上任何一个下载源（GitHub 与镜像都没响应），换个网络再试。';
    case 'disk':
      return '写不进下载目录，检查磁盘空间与权限。';
    case 'hash':
      return '安装包校验没通过，已删除，请重新下载。';
    case 'download':
      return '下载没有完成，检查网络后再试一次。';
    default:
      return '下载失败，稍后再试。';
  }
}

/** 地址归一：去空格、去尾部斜杠、转小写（只用于比较，不用于连接）。 */
function normalizeAddress(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 取 URL（或 `host:port`）里的主机名，小写；取不到返回 ''。 */
function hostOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  }
}
