/**
 * 一次完整的飞牛登录（移植自 `Project/Android/core/connection/FnLoginClient.kt` 的 `FnLoginFlow`）。
 *
 * 同一条 WS 跨步骤复用：`getRSAPub` → 加密 `user.login` →（要 2FA 时）邮箱码 / **加密** `loginVerify`
 * → `POST /app/ticket` 换会话 Cookie。开了 2FA 时 `user.login` **不返回 token，只给 accessToken**。
 *
 * ⚠️ 服务端空闲会关 WS（输验证码那几十秒就可能断）：所以每条 2FA 请求都带恢复策略 ——
 * 断了重连 + 重新 `user.login`；报「凭证过期」(102570109) 重登换 accessToken 再发。
 *
 * 依赖全部注入（rpc 工厂、fetch、时钟）：这样本机（没有显示器 / 不能联网）也能用假 RPC 跑完整编排。
 */

import { envelope, randomAesKey, randomIv, sign as hmacSign } from './crypto.js';
import { ERRNO, LOGIN_STEP, LoginError, fnErrnoMessage, toLong } from './errno.js';
import {
  ReqIdSeq,
  exchangeEntryTokenExtra,
  heartbeatPayload,
  loginInner,
  payload,
  sendEmailCodeExtra,
  tokenLoginInner,
  verifyInner,
} from './messages.js';
import { WsClosedError } from './wsclient.js';

export const HEARTBEAT_MS = 20000;
export const LONG_TOKEN_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * 会话：一次成功登录的全部产物。
 * `cookies()` 里的名字照 fnOS 前端 bundle：会话 `fnos-token`、长期 `fnos-long-token`、入口 `entry-token`。
 */
export class FnSession {
  constructor({ token, secret = null, longToken = null, entryToken = null, setCookies = [], note = null }) {
    this.token = token;
    this.secret = secret;
    this.longToken = longToken;
    this.entryToken = entryToken;
    this.setCookies = setCookies;
    this.note = note;
  }

  /** 写给 Cookie 罐的完整串（每条一次 `cookies.set`）。 */
  cookies(relayHost = null) {
    const out = [];
    const fromServer = this.setCookies.map((c) => `${c}; Path=/; Secure`);
    const names = new Set(fromServer.map((c) => c.slice(0, c.indexOf('='))));
    if (!names.has('fnos-token')) out.push(`fnos-token=${this.token}; Path=/; Secure; SameSite=Strict`);
    out.push(...fromServer);
    // 长期令牌 30 天；会话 Cookie 不设过期时间（关掉就没了）
    if (this.longToken) out.push(`fnos-long-token=${this.longToken}; Path=/; Secure; SameSite=Strict; Max-Age=${LONG_TOKEN_MAX_AGE}`);
    if (this.entryToken) {
      out.push(
        relayHost
          ? `entry-token=${this.entryToken}; Path=/; Secure; Domain=.${relayHost}`
          : `entry-token=${this.entryToken}; Path=/; Secure`,
      );
    }
    return out;
  }

  /** 只含 `name=value` 的 Cookie 头（原生探测 / WS 用）。 */
  cookieHeader(relayHost = null) {
    return this.cookies(relayHost)
      .map((c) => c.split(';')[0].trim())
      .join('; ');
  }

  toJSON() {
    return {
      token: this.token,
      secret: this.secret,
      longToken: this.longToken,
      entryToken: this.entryToken,
      setCookies: this.setCookies,
      note: this.note,
    };
  }

  static fromJSON(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.token !== 'string') return null;
    return new FnSession({
      token: value.token,
      secret: value.secret || null,
      longToken: value.longToken || null,
      entryToken: value.entryToken || null,
      setCookies: Array.isArray(value.setCookies) ? value.setCookies.filter((c) => typeof c === 'string') : [],
      note: value.note || null,
    });
  }
}

export class FnLoginFlow {
  /**
   * @param {object} options
   * @param {string} options.baseUrl - `https://host[:port]`
   * @param {boolean} options.relay - 是不是中继（决定 WS 要不要带 `mode=relay`）
   * @param {string} options.user
   * @param {string} options.password
   * @param {string} options.deviceId
   * @param {string} [options.deviceName]
   * @param {number} [options.timeoutMs]
   * @param {string|null} [options.savedSecret] - 上次的 secret，`tokenLogin` 签名要用
   * @param {Function} [options.rpcFactory] - `(url, cookie) => WsClient`；测试注入假实现
   * @param {Function} [options.fetcher] - `fetch` 语义；`/app/ticket` 用
   * @param {Function} [options.onStep] - `(label) => void`
   * @param {Function} [options.setTimer] - 心跳定时器（测试可关掉）
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.relay = Boolean(options.relay);
    this.user = options.user || '';
    this.password = options.password || '';
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName || 'Windows-ZXDesk';
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.rpcFactory = options.rpcFactory;
    this.fetcher = options.fetcher || globalThis.fetch;
    this.onStep = options.onStep || (() => {});
    this.setTimer = options.setTimer || setInterval;
    this.clearTimer = options.clearTimer || clearInterval;
    this.keepaliveMs = options.keepaliveMs ?? HEARTBEAT_MS;

    this.seq = new ReqIdSeq();
    this.si = null;
    this.publicKeyPem = null;
    this.accessToken = null;
    this.maskedEmail = null;
    this.secret = options.savedSecret || null;
    this.lastLogin = null;
    this.keepaliveTimer = null;
    this.recovered = false;
    this.rpc = null;
    this.host = this.baseUrl.replace(/^https?:\/\//, '');
  }

  wsUrl() {
    return `wss://${this.host}/websocket?type=main`;
  }

  ensureRpc() {
    if (!this.rpc) {
      if (!this.rpcFactory) throw new LoginError(LOGIN_STEP.WS_CONNECT, '内部错误：没有 WS 客户端工厂');
      this.rpc = this.rpcFactory(this.wsUrl(), this.relay ? 'mode=relay' : null);
    }
    return this.rpc;
  }

  get isConnected() {
    return Boolean(this.rpc?.isConnected);
  }

  /** 密码登录：WS → 公钥 → `user.login`。 */
  async start() {
    await this.authenticate();
    const result = await this.outcome();
    if (result.twoFactor) this.startKeepalive();
    return result;
  }

  /**
   * longToken 免密（`user.tokenLogin`，明文 + 顶层 si + HMAC 签名）。
   * ⚠️ 现状**未打通**（Android 侧同样）：失败就回落「记住的密码重登」，⛔ 不装作已登录。
   */
  async startWithLongToken(longToken) {
    this.step(LOGIN_STEP.WS_CONNECT);
    const rpc = this.ensureRpc();
    await rpc.connect().catch((e) => {
      throw e instanceof LoginError ? e : new LoginError(LOGIN_STEP.WS_CONNECT, e.message || '连不上飞牛服务');
    });
    this.step(LOGIN_STEP.RSA_KEY);
    await this.fetchPublicKey();
    this.step(LOGIN_STEP.LOGIN);
    const body = tokenLoginInner({
      token: longToken,
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      si: this.si,
    });
    const sent = await this.send(payload(body, null, this.seq));
    const response = await this.expect(sent, LOGIN_STEP.LOGIN);
    if (response.result !== 'succ') {
      throw new LoginError(LOGIN_STEP.LOGIN, fnErrnoMessage(response), safeDetail(response));
    }
    this.lastLogin = response;
    this.accessToken = response.accessToken || null;
    this.maskedEmail = response.secureEmail || null;
    if (response.secret) this.secret = response.secret;
    const result = await this.outcome();
    if (result.twoFactor) this.startKeepalive();
    return result;
  }

  /** 输验证码期间保活：每 20 秒一个最轻的业务请求（⛔ 不能用协议层 ping，中继不回 pong）。 */
  startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = this.setTimer(() => {
      try {
        if (this.rpc?.isConnected) {
          const beat = heartbeatPayload(this.seq);
          this.rpc.send(beat.json);
        }
      } catch {
        /* 心跳失败不致命：下一次 2FA 请求自带重连 */
      }
    }, this.keepaliveMs);
    if (typeof this.keepaliveTimer?.unref === 'function') this.keepaliveTimer.unref();
  }

  /** 验证器 6 位码 → 会话（一次 `loginVerify` 就够，⛔ 别先打 `login.totpVerify`）。 */
  async submitTotp(code, trustDevice = true) {
    return this.completeLogin({ totpCode: code, trustDevice });
  }

  async submitEmailCode(email, code, trustDevice = true) {
    return this.completeLogin({ email, emailCode: code, trustDevice });
  }

  /** 发一封登录验证码到安全邮箱（明文 + HMAC）。 */
  async sendEmailCode() {
    if (!this.maskedEmail) throw new LoginError(LOGIN_STEP.TWO_FACTOR, '这个账号没有安全邮箱，请用验证器');
    const extra = sendEmailCodeExtra({
      deviceId: this.deviceId,
      accessToken: this.currentAccess(),
      secureEmail: this.maskedEmail,
    });
    const response = await this.call2fa(true, () => payload('appcgi.tfa.security.v1.login.sendEmailCode', extra, this.seq));
    this.requireSuccess(response);
    return true;
  }

  /** 关掉 WS 与心跳（登录完成 / 用户返回 / 会话失效时都要调）。 */
  close() {
    if (this.keepaliveTimer) {
      this.clearTimer(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.rpc?.close?.();
    this.rpc = null;
  }

  // ------------------------------------------------------------ 内部

  step(label) {
    this.onStep(label);
  }

  currentAccess() {
    if (!this.accessToken) throw new LoginError(LOGIN_STEP.TWO_FACTOR, '登录会话已失效，请重新登录');
    return this.accessToken;
  }

  async authenticate() {
    this.step(LOGIN_STEP.WS_CONNECT);
    const rpc = this.ensureRpc();
    try {
      await rpc.connect();
    } catch (e) {
      throw e instanceof LoginError ? e : new LoginError(LOGIN_STEP.WS_CONNECT, e.message || '连不上飞牛服务');
    }
    this.step(LOGIN_STEP.RSA_KEY);
    await this.fetchPublicKey();

    this.step(LOGIN_STEP.LOGIN);
    const reqid = this.seq.take();
    const inner = loginInner({
      reqid,
      user: this.user,
      password: this.password,
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      si: this.si,
    });
    const body = envelope(inner, this.publicKeyPem, randomAesKey(), randomIv());
    // ⚠️ 信封**不签名**（照 Android：只有明文请求才加 HMAC 前缀）
    const login = await this.expect({ json: body, reqid, noSign: true }, LOGIN_STEP.LOGIN);
    if (login.result !== 'succ') throw new LoginError(LOGIN_STEP.LOGIN, fnErrnoMessage(login), safeDetail(login));
    this.lastLogin = login;
    this.accessToken = login.accessToken || null;
    this.maskedEmail = login.secureEmail || null;
    this.secret = login.secret || this.secret;
  }

  async fetchPublicKey() {
    const sent = payload('util.crypto.getRSAPub', null, this.seq);
    const response = await this.expect(sent, LOGIN_STEP.RSA_KEY);
    const pem = response.pub;
    if (!pem || typeof pem !== 'string') {
      throw new LoginError(LOGIN_STEP.RSA_KEY, '服务器没有返回 RSA 公钥', safeDetail(response));
    }
    this.publicKeyPem = pem;
    // si 是 18 位整数：**字符串原样保留**（Number() 会丢精度：…123456 变成 …123500），
    // 只有服务端真给数字时才转换（那种情况精度也已由服务端决定）。
    const si = typeof response.si === 'string' && response.si.trim() ? response.si.trim() : toLong(response.si);
    if (si === null) throw new LoginError(LOGIN_STEP.RSA_KEY, '服务器没有返回 si', safeDetail(response));
    this.si = String(si);
  }

  /** `user.login` 之后判：拿到 token 就收尾（要等 ticket 认领完），否则看是不是要 2FA。 */
  async outcome() {
    const login = this.lastLogin;
    if (!login) throw new LoginError(LOGIN_STEP.LOGIN, '登录没有返回结果');
    if (login.token) {
      return {
        session: await this.finishSession({
          token: login.token,
          ticket: login.ticket,
          longToken: login.longToken,
        }),
      };
    }
    if (!this.accessToken || login.isTwofaEnforced !== true) {
      throw new LoginError(
        LOGIN_STEP.LOGIN,
        '登录没完成：服务器既没给 token，也没要求两步验证',
        safeDetail(login),
      );
    }
    return {
      twoFactor: {
        accessToken: this.accessToken,
        maskedEmail: this.maskedEmail,
        totpEnabled: login.isBindTwofaSecret === true,
        emailEnabled: login.isBindSecureEmail === true,
      },
    };
  }

  /**
   * 2FA 请求的统一出口（带恢复）：
   * ① 连接断了 → 重连 + 重新 `user.login` 再发一次；
   * ② `reloginOnExpiry` 且服务端说「凭证过期」→ 重登换 accessToken 再发一次。
   */
  async call2fa(reloginOnExpiry, build) {
    let reconnected = false;
    let relogged = false;
    for (;;) {
      let response;
      try {
        response = await this.expect(build(), LOGIN_STEP.TWO_FACTOR);
      } catch (e) {
        if (!(e instanceof WsClosedError)) throw e;
        if (reconnected) throw new LoginError(LOGIN_STEP.TWO_FACTOR, e.message);
        reconnected = true;
        this.recovered = true;
        await this.reconnect();
        await this.authenticate();
        continue;
      }
      const expired = toLong(response.errno) === ERRNO.CREDENTIAL_EXPIRED;
      if (!expired || !reloginOnExpiry || relogged) return response;
      relogged = true;
      this.recovered = true;
      await this.authenticate();
    }
  }

  async reconnect() {
    this.rpc?.close?.();
    this.rpc = null;
    await this.ensureRpc().connect();
  }

  /** `user.2fa.loginVerify`：**必须走加密信封**。 */
  async completeLogin({ totpCode = null, email = null, emailCode = null, trustDevice = false }) {
    const pem = this.publicKeyPem;
    if (!pem) throw new LoginError(LOGIN_STEP.TWO_FACTOR, '缺少服务器公钥，请返回重新登录');
    const reqid = this.seq.take();
    const inner = verifyInner({
      reqid,
      accessToken: this.currentAccess(),
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      si: this.si || '',
      totpCode,
      email,
      emailCode,
      trusted: trustDevice,
    });
    // loginVerify 绑着「刚刚验证过」的会话状态，⛔ 不能靠重新登录来恢复
    const response = await this.call2fa(false, () => ({
      json: envelope(inner, pem, randomAesKey(), randomIv()),
      reqid,
      noSign: true,
    }));
    this.requireSuccess(response);
    if (!response.token) {
      throw new LoginError(LOGIN_STEP.TWO_FACTOR, '两步验证通过了，但服务器没给 token', safeDetail(response));
    }
    this.secret = response.secret || this.secret;
    return this.finishSession({ token: response.token, ticket: response.ticket, longToken: response.longToken });
  }

  requireSuccess(response) {
    if (response.result === 'succ') return;
    let message = fnErrnoMessage(response);
    // 本步重连过 ⇒ accessToken 换掉了，先前发的邮箱验证码可能已失效
    if (this.recovered && toLong(response.errno) === ERRNO.VERIFICATION_CODE_WRONG) {
      message = `${message}（连接中途断过，验证码可能已失效，请重新发送）`;
    }
    throw new LoginError(LOGIN_STEP.TWO_FACTOR, message, safeDetail(response));
  }

  /**
   * 收尾：把会话变成「浏览器视图能用的 Cookie」。
   * ① `POST /app/ticket {ticket}` —— 新版登录的真实会话靠这一步种下来（拿不到它的 Cookie 就是 `invalid token`）；
   * ② `appcgi.sac.entry.v1.exchangeEntryToken` —— 老的入口 token，只有 ① 没拿到才试，失败不致命。
   */
  async finishSession({ token, ticket = null, longToken = null }) {
    let entryToken = null;
    let setCookies = [];
    let note = null;

    if (ticket) {
      try {
        setCookies = await this.claimTicket(ticket, token);
      } catch (e) {
        note = `ticket 认领失败：${e.message}`;
      }
    }

    if (!setCookies.length) {
      try {
        const body = payload('appcgi.sac.entry.v1.exchangeEntryToken', exchangeEntryTokenExtra(), this.seq);
        const exchanged = await this.expect(this.withSignature(body), LOGIN_STEP.TICKET);
        entryToken = exchanged?.data?.token || null;
        if (!entryToken) {
          note = [note, `entry-token 没换到（${resultOf(exchanged)}）`].filter(Boolean).join('；');
        }
      } catch (e) {
        note = [note, `entry-token 换取失败：${e.message}`].filter(Boolean).join('；');
      }
    } else {
      note = [note, `已用 ticket 拿到 ${setCookies.length} 条会话 Cookie`].filter(Boolean).join('；');
    }

    return new FnSession({ token, secret: this.secret, longToken, entryToken, setCookies, note });
  }

  /** `POST {base}/app/ticket`，把 `Set-Cookie` 原样收下（只取 `name=value`）。 */
  async claimTicket(ticket, token) {
    if (!this.fetcher) throw new Error('没有可用的网络实现');
    const cookie = `fnos-token=${token}${this.relay ? '; mode=relay' : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}/app/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ ticket }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`认领登录票据失败（HTTP ${response.status}）`);
      const raw = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      const fallback = raw.length ? raw : [response.headers?.get?.('set-cookie')].filter(Boolean);
      return fallback.map((line) => String(line).split(';')[0].trim()).filter((line) => line.includes('='));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 只有**明文**请求带 HMAC 签名；加密信封原样发出（⛔ 套签名服务端会看不懂）。 */
  withSignature(body) {
    if (body.noSign) return body;
    return this.secret ? { json: hmacSign(body.json, this.secret), reqid: body.reqid } : body;
  }

  async send(body) {
    const rpc = this.ensureRpc();
    if (!rpc.isConnected) await rpc.connect();
    return body;
  }

  async expect(body, step) {
    const rpc = this.ensureRpc();
    try {
      if (!rpc.isConnected) await rpc.connect();
      return await rpc.call(this.withSignature(body).json, body.reqid);
    } catch (e) {
      if (e instanceof WsClosedError) throw e;
      throw new LoginError(step, e.message || '请求失败');
    }
  }
}

/** 诊断详情里只留结构，不留凭据（❌ 明文 token / password / Cookie）。 */
export function safeDetail(response) {
  if (!response || typeof response !== 'object') return null;
  const copy = { ...response };
  for (const key of ['token', 'longToken', 'accessToken', 'secret', 'password', 'ticket', 'setCookies', 'pub']) {
    if (key in copy) copy[key] = copy[key] ? '***' : copy[key];
  }
  return JSON.stringify(copy).slice(0, 400);
}

function resultOf(response) {
  return response?.result ?? '未知';
}
