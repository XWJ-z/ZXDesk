/**
 * 壳的状态机（主进程侧）。
 *
 * 一句话：**所有网络与凭据都在这里**，壳只负责显示与转发动作（任务单 §5.1）。
 *
 * 四步引导（F1）：mode → connect →（twofa）→（access）→ browsing。
 * 证书确认（F7）、连接面板（F10）、错误页（F16）都是「隐藏远程视图 → 壳整窗显示」，
 * ⛔ 不做浮层（`WebContentsView` 永远画在 DOM 之上，浮层盖不住它）。
 */

import { pickWebSession, webSessionSpec } from './browser/cookies.js';
import { GATEWAY_PAGE, probeGateway } from './connection/gateway.js';
import { isPrivateAddress, planConnection, DIRECT_PORT, DEFAULT_GATEWAY_PATH } from './connection/planner.js';
import { portalUrlFor, resolveFnId } from './connection/fnid.js';
import { TARGET_KIND, parseInput } from './connection/input.js';
import { FnLoginFlow, FnSession } from './login/flow.js';
import { LOGIN_STEP, LoginError } from './login/errno.js';
import { WsClient } from './login/wsclient.js';
import { SavedSession } from './store/session.js';
import { TRUST, decideTrust } from './tls/tofu.js';

export const APP_VERSION = '0.2.1';

const LINK_RELAY = '飞牛中继';
const LINK_LAN = '局域网直连';
const LINK_GATEWAY = '网关域名';
const LINK_LAN_GATEWAY = '局域网网关';

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
    this.rpcFactory = deps.rpcFactory;

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
  }

  baseState() {
    return {
      schema: 1,
      version: APP_VERSION,
      screen: 'mode',
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
      browsing: null,
      diagnostics: '',
    };
  }

  // ---------------------------------------------------------------- 状态广播

  push() {
    try {
      this.notify(this.snapshot());
    } catch (e) {
      this.log(`状态推送失败：${e.message}`);
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
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

  /** 冷启动：有会话快照就直接进 ZXDesk，否则回到第 ① 步（地址/账号预填）。 */
  async boot() {
    const saved = await this.sessions.load();
    if (!saved || !saved.baseUrl) {
      this.showMode();
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
    await this.enterBrowsing(saved, null);
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
    this.state = { ...this.baseState(), screen: 'mode', connect: this.connectFormState() };
    this.push();
  }

  showConnect(notice = null) {
    this.state = { ...this.state, screen: 'connect', connect: this.connectFormState(notice), twofa: null, cert: null, error: null };
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
    const saved = await this.credentials.load();
    const same = saved && normalizeAddress(saved.address) === normalizeAddress(form.address) && saved.user === form.user;
    // ⛔ 只记「有/无」和地址账号，绝不记密码值
    this.log(
      `密码预填：${same ? '命中' : '未命中'}（saved=${saved ? '有' : '无'}，地址=${saved?.address || '-'}→${form.address}，账号=${saved?.user || '-'}→${form.user}）`,
    );
    if (same) this.patchConnect({ password: saved.password, hasSavedPassword: true });
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
        case 'connect.clearSaved':
          this.credentials.clear();
          return this.patchConnect({ hasSavedPassword: false, password: '' });
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
          return this.logout({ keepSession: false, keepCredentials: true, note: '已退出登录' });
        case 'toolbar.back':
          return this.view.goBack();
        case 'toolbar.forward':
          return this.view.goForward();
        case 'toolbar.reload':
          return this.view.reload();
        case 'error.retry':
          // 0.1.5：不再是「回连接页让用户再点一次」，而是拿上次的表单**原样重跑**
          //（FNID 会重新解析，DNS 恢复后能直接连上）
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
      this.showError('操作失败', e.message || '未知错误');
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
      this.state = { ...this.state, screen: 'twofa' };
      this.push();
      return;
    }
    if (screen === 'cert') return this.decideCert(false);
    if (screen === 'error') return this.showConnect();
    return null;
  }

  setRemember(value) {
    this.prefs.patch({ rememberPassword: Boolean(value) });
    this.patchConnect({ rememberPassword: Boolean(value), hasSavedPassword: value ? this.state.connect.hasSavedPassword : false });
    // 取消勾选 ⇒ 立刻清除已存密码（不等下次保存）
    if (!value) this.credentials.clear();
  }

  // ---------------------------------------------------------------- 连接

  async connect(form) {
    const merged = { ...this.state.connect, ...form };
    if (merged.busy) return;
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

    try {
      const plan = await this.resolvePlan(parsed, merged);
      this.prefs.patch({ lastAddress: this.pendingAddress, preferHttps: Boolean(merged.https) });
      if (merged.user) this.prefs.patch({ lastUser: String(merged.user).trim() });

      if (plan.error) {
        this.patchConnect({ busy: false, progress: null, error: plan.error });
        return;
      }

      // 8990 直连：只有「显式填 IP:8990」或「关掉 HTTPS」才会走到这里（不需要飞牛账号）
      if (plan.entry.flow === 'DIRECT') {
        this.enterBrowsing(plan.entry, `已直连 8990（不走飞牛网关）`);
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

      await this.runLogin(plan.entry);
    } catch (e) {
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
   * 走原生 WS 登录（单入口，与 Android `FnLoginClient` 一致）。
   *
   * ⚠️ 走过的两条歪路都别回来：
   * - 0.1.1 的「网关连不上就自动回落 8990」—— 那是绕过飞牛登录；
   * - 0.1.5 的「FNID 先试局域网网关、失败再回中继」—— 地址是猜的，实测根本连不上。
   */
  async runLogin(entry) {
    this.pendingEntry = entry;
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
      rpcFactory: this.rpcFactory || ((url, cookie) => new WsClient({ url, cookie, onSelfSigned: (host, info) => this.requestTrust(host, info) })),
      fetcher: this.fetcher,
      onStep: (label) => this.patchConnect({ progress: label }),
    });
    return flow;
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
   * ⚠️ 0.1.6 初版把登录失败也走 `showError()` 整页跳走 —— 那是「页面打不开」的画法，
   * 结果表单、密码、用户刚敲的地址一起没了，用户会以为客户端崩了。
   * 现在：连不上 / 账号错 / 2FA 错 都留在屏上，具体原因只进日志与「复制诊断」。
   * 整页错误只留给**页面加载 / 导航失败 / 未知异常**（`loadSafely`、`index.js` 的 onLoadFail）。
   */
  failLogin(e) {
    const step = e instanceof LoginError ? e.step : LOGIN_STEP.WS_CONNECT;
    this.lastAttempt = {
      baseUrl: this.pendingEntry?.baseUrl || this.entry?.baseUrl || this.state.connect?.address || '',
      step,
      error: e?.message || String(e || ''),
      detail: e?.detail || null,
    };
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

  /** 拿到会话：落盘 → 探一次网关 → 决定去第 ④ 步（访问码）还是浏览模式。 */
  async afterAuth(session) {
    const entry = this.pendingEntry;
    if (!entry) {
      this.patchTwofa({ busy: false, error: '内部错误：连接信息丢了，请重新连接' });
      return;
    }

    // 「记住密码」落盘（勾了存、没勾清）
    const credential = this.pendingCredential;
    if (credential) {
      if (credential.remember && credential.user && credential.password) {
        const saved = await this.credentials.save(credential.address, credential.user, credential.password);
        this.log(`记住密码：${saved ? '已保存' : '未保存（本机不支持加密存储）'}`);
      } else if (!credential.remember) {
        this.credentials.clear();
        this.log('记住密码：未勾选，已清掉旧凭据');
      } else {
        this.log('记住密码：未保存（账号或密码为空）');
      }
    }

    // longToken / secret 一旦拿到就别丢：tokenLogin 换来的会话不一定再返回它们
    const previous = await this.sessions.load();
    const keep = new FnSession({
      token: session.token,
      secret: session.secret || previous?.session?.secret || null,
      longToken: session.longToken || previous?.session?.longToken || null,
      entryToken: session.entryToken || null,
      setCookies: session.setCookies || [],
      note: session.note || null,
    });

    entry.session = keep;
    await this.sessions.save(entry);
    // 3.5：把登录收尾的「票据 / 入口 token」情况单独记一行（只记有无与条数，⛔ 不记值）
    this.log(
      `登录收尾：ticket 换到 ${keep.setCookies.length} 条 Cookie；entry-token ${keep.entryToken ? '有' : '无'}${keep.note ? `（${keep.note}）` : ''}`,
    );

    this.flow?.close();
    this.flow = null;

    let page = GATEWAY_PAGE.APP;
    if (entry.flow === 'GATEWAY' && this.fetcher) {
      page = await probeGateway({
        baseUrl: entry.baseUrl,
        gatewayPath: entry.gatewayPath,
        cookieHeader: keep.cookieHeader(entry.relayHost),
        fetchImpl: this.fetcher,
      });
    }

    if (page === GATEWAY_PAGE.ACCESS_CODE) {
      this.state = { ...this.state, screen: 'access', twofa: { ...(this.state.twofa || {}), busy: false, error: null } };
      this.push();
      await this.showAccessCode(entry);
      return;
    }
    this.enterBrowsing(entry, null);
  }

  /** 第 ④ 步：远程视图直接显示网关自己的访问码页（⛔ 不自造校验）。 */
  async showAccessCode(entry) {
    this.pendingEntry = entry;
    this.state = {
      ...this.state,
      screen: 'access',
      browsing: this.browsingInfo(entry),
    };
    this.push();
    this.view.setContext({ baseUrl: entry.baseUrl, relayHost: entry.relayHost });
    // 同上：先建视图（拿到 persist:zxdesk 分区会话），再写 Cookie
    this.view.ensure();
    await this.applySessionCookies(entry);
    this.view.setVisible(true);
    await this.loadSafely(entry.startUrl());
  }

  onAccessCodeDone() {
    const entry = this.pendingEntry || this.entry;
    if (!entry) return this.showConnect();
    this.enterBrowsing(entry, null);
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
    this.entry = entry;
    this.pendingEntry = null;
    this.state = {
      ...this.state,
      screen: 'browsing',
      notice: notice || null,
      panel: null,
      twofa: null,
      cert: null,
      error: null,
      browsing: this.browsingInfo(entry),
      connect: { ...this.state.connect, busy: false, progress: null },
    };
    this.push();
    this.view.setContext({ baseUrl: entry.baseUrl, relayHost: entry.relayHost });
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
      this.showError('打不开页面', '页面没有加载出来，检查网络后点「重试」。', { url: entry.startUrl() });
    }
  }

  /**
   * 写 Cookie 到**远程视图的分区**，并把结果记进日志（⛔ 不打印 Cookie 值）。
   * N = 0 时给 WARN —— 0.1.3 的「登两次」如果复现，这行会直接指出「分区里没有会话 Cookie」。
   */
  async applySessionCookies(entry) {
    if (!entry?.session?.token && !entry?.session?.setCookies?.length) return;
    const target = { baseUrl: entry.baseUrl, relayHost: entry.relayHost };
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

    // ZXDesk 网页会话（服务端是会话级 Cookie，本机只加密保存并回注）
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
  }

  /**
   * 登录成功后把 `zxdesk_sid` 读出来存进快照（只这一条，⛔ 其它 Cookie 不落盘）。
   * 会话失效（`session_epoch` 变了）时服务端会让页面回登录页，用户登一次即可 —— 不是 bug。
   */
  async captureWebSession(entry = this.entry) {
    if (!entry || !this.cookies.get) return;
    try {
      const list = await this.cookies.get(entry.baseUrl);
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
      this.showError('打不开页面', '页面没有加载出来，检查网络后点「重试」。', { url, error: e.message || String(e) });
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
  async logout({ keepSession = false, keepCredentials = true, note = null } = {}) {
    this.flow?.close();
    this.flow = null;
    if (!keepSession) {
      this.sessions.clear();
      await this.cookies.clear();
      this.triedLongToken = false;
      this.triedPasswordRelogin = false;
    }
    if (!keepCredentials) {
      this.credentials.clear();
      this.log('已清掉记住的密码（用户主动清除 / 取消勾选）');
    } else {
      this.log('退出登录 / 换个地址：保留记住的密码（要彻底清请点「清除」）');
    }
    this.entry = null;
    this.pendingEntry = null;
    this.view.setVisible(false);
    this.state = { ...this.state, panel: null, browsing: null, twofa: null, screen: 'connect', connect: this.connectFormState(note) };
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
      // 离开访问码页（用户输入完成）⇒ 自动继续
      if (page === GATEWAY_PAGE.APP) this.enterBrowsing(this.pendingEntry || this.entry, null);
      return;
    }
    if (this.state.screen !== 'browsing') return;
    if (page === GATEWAY_PAGE.ACCESS_CODE) {
      const entry = this.entry;
      if (!entry) return;
      this.patch({ screen: 'access' });
      await this.showAccessCode(entry);
      return;
    }
    if (page === GATEWAY_PAGE.LOGIN_REQUIRED) await this.onSessionExpired();
  }

  /** 会话失效：① longToken → ② 记住的密码静默重登 → ③ 回连接页（每段每次冷启动最多一次）。 */
  async onSessionExpired() {
    const saved = await this.sessions.load();
    if (!saved) return this.backToLogin('登录状态已失效，请重新登录', true);

    if (!this.triedLongToken && saved.session?.longToken) {
      this.triedLongToken = true;
      try {
        const flow = new FnLoginFlow({
          baseUrl: saved.baseUrl,
          relay: Boolean(saved.relayHost),
          user: saved.user,
          password: '',
          deviceId: this.prefs.get().deviceId,
          savedSecret: saved.session.secret,
          rpcFactory: this.rpcFactory,
          fetcher: this.fetcher,
          onStep: (label) => this.log(`恢复登录：${label}`),
        });
        this.flow = flow;
        this.pendingEntry = saved;
        const result = await flow.startWithLongToken(saved.session.longToken);
        if (result.session) return this.afterAuth(result.session);
        return this.finishLogin(result);
      } catch (e) {
        this.log(`longToken 恢复失败：${e.message}`);
      } finally {
        this.flow?.close();
        this.flow = null;
      }
    }

    if (!this.triedPasswordRelogin) {
      const credential = await this.credentials.load();
      if (credential && credential.address === saved.address && credential.user === saved.user) {
        this.triedPasswordRelogin = true;
        try {
          const flow = new FnLoginFlow({
            baseUrl: saved.baseUrl,
            relay: Boolean(saved.relayHost),
            user: credential.user,
            password: credential.password,
            deviceId: this.prefs.get().deviceId,
            rpcFactory: this.rpcFactory,
            fetcher: this.fetcher,
            onStep: (label) => this.log(`密码重登：${label}`),
          });
          this.flow = flow;
          this.pendingEntry = saved;
          const result = await flow.start();
          if (result.session) return this.afterAuth(result.session);
          return this.finishLogin(result);
        } catch (e) {
          this.log(`密码重登失败：${e.message}`);
        } finally {
          this.flow?.close();
          this.flow = null;
        }
      }
    }

    return this.backToLogin('自动登录失败，请重新登录', true);
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
    return new Promise((resolve) => {
      this.certWaiters.push({ host, resolve, verdict });
      this.state = {
        ...this.state,
        cert: {
          host,
          subject: verdict.subject,
          sha256: verdict.sha256,
          previousSha256: verdict.previousSha256 || null,
          rotated: verdict.decision === TRUST.ROTATED,
        },
        screenBeforeCert: this.state.screen,
        screen: 'cert',
      };
      this.push();
      this.view.setVisible(false);
    });
  }

  decideCert(trust) {
    const cert = this.state.cert;
    if (!cert) return null;
    const waiter = this.certWaiters.shift();
    if (trust && waiter) {
      this.tofu.put(waiter.host, { subject: cert.subject, sha256: cert.sha256 });
    }
    const restore = this.state.screenBeforeCert || 'connect';
    this.state = { ...this.state, screen: restore, cert: null, screenBeforeCert: null };
    this.push();
    if (restore === 'browsing') this.view.setVisible(true);
    waiter?.resolve(Boolean(trust));
    return null;
  }

  // ---------------------------------------------------------------- 错误与诊断

  showError(title, message, detail = null) {
    this.state = {
      ...this.state,
      screen: 'error',
      // 界面只吃 title / message；detail（错误码、地址）留给「复制诊断」，⛔ 不上屏
      error: { title, message, detail },
      connect: { ...this.state.connect, busy: false, progress: null },
    };
    this.push();
    this.view.setVisible(false);
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
