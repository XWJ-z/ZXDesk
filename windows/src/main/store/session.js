/**
 * 会话快照（`data/session.bin`，加密）。
 *
 * 内容算凭据（token / longToken / secret / 会话 Cookie），所以整段 JSON 交给 `SecureStore`；
 * ⛔ 密码永不进这里（那是 `credential.bin`）。
 *
 * 用途：杀进程重开时直接回到 ZXDesk —— 多数情况连 WS 都不用建（Cookie 已经在手上）。
 */

import { FnSession } from '../login/flow.js';

export const SESSION_VERSION = 1;

/** 一次成功连接的可还原快照。 */
export class SavedSession {
  constructor(value) {
    this.version = SESSION_VERSION;
    this.address = value.address || '';
    this.https = value.https !== false;
    this.user = value.user || '';
    this.baseUrl = value.baseUrl || '';
    this.gatewayPath = value.gatewayPath || '/app/zxdesk';
    this.flow = value.flow === 'GATEWAY' ? 'GATEWAY' : 'DIRECT';
    this.relayHost = value.relayHost || null;
    this.portalUrl = value.portalUrl || null;
    // ⚠️ 旧快照里的 `lanBaseUrl`（0.1.5 那套「FNID 猜局域网地址」）**一律忽略**：
    // 那是自创机制，Android 的 FNID 路径只有中继。读到也不认、下次保存就没了。
    /**
     * ZXDesk **网页会话**（`zxdesk_sid`）。
     *
     * 服务端刻意把它做成会话级 Cookie（飞牛账号和 ZXDesk 账号是两套，持久化会把上一个
     * ZXDesk 账号带过来）。客户端为了「桌面免登录」，把这一条**加密**存进 session.bin，启动时按
     * 同一 host 回注 —— 不服务端语义、只本机保存；「设置 → 自动登录」可关。
     */
    this.webSession = normalizeWebSession(value.webSession);
    this.cleartext = value.cleartext === true;
    this.session = FnSession.fromJSON(value.session) || new FnSession({ token: '' });
    this.savedAt = typeof value.savedAt === 'number' ? value.savedAt : Date.now();
  }

  toJSON() {
    return {
      version: SESSION_VERSION,
      address: this.address,
      https: this.https,
      user: this.user,
      baseUrl: this.baseUrl,
      gatewayPath: this.gatewayPath,
      flow: this.flow,
      relayHost: this.relayHost,
      portalUrl: this.portalUrl,
      webSession: this.webSession,
      cleartext: this.cleartext,
      session: this.session.toJSON(),
      savedAt: this.savedAt,
    };
  }

  /** 从 JSON 文本还原；坏数据一律 `null`（当没有会话，⛔ 不半信半疑地用）。 */
  static fromJSON(text) {
    let raw;
    try {
      raw = typeof text === 'string' ? JSON.parse(text) : text;
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.baseUrl !== 'string' || !raw.baseUrl) return null;
    return new SavedSession(raw);
  }

  /** WebContentsView 该从哪一页开始（有原生会话就直奔 ZXDesk 登录页）。 */
  startUrl() {
    const base = this.baseUrl.replace(/\/+$/, '');
    // 有 ZXDesk 网页会话 ⇒ 直接进应用根（`/app/zxdesk/`），不再绕登录页；
    // ⚠️ 这一判断必须在 `flow === 'DIRECT'` **之前**：0.1.6 初版顺序反了，
    // 直连 8990 时永远落回 login.html，自动登录对直连模式等于没有。
    // 会话失效时前端自己会回登录页，不需要我们在 URL 上做判断。
    if (this.webSession && this.webSession.value) return `${base}${this.gatewayPath}/`;
    if (this.flow === 'DIRECT') return `${base}${this.gatewayPath}/login.html`;
    if (this.session?.token) return `${base}${this.gatewayPath}/login.html`;
    if (this.portalUrl) return this.portalUrl;
    return `${base}/`;
  }
}

export class SessionStore {
  constructor(secureStore, file, logger = () => {}) {
    this.secure = secureStore;
    this.file = file;
    this.logger = logger;
  }

  async load() {
    const text = await this.secure.get(this.file);
    if (!text) return null;
    const saved = SavedSession.fromJSON(text);
    if (!saved) this.logger('会话快照格式不认识，已忽略');
    return saved;
  }

  async save(saved) {
    try {
      await this.secure.put(this.file, JSON.stringify(saved.toJSON()));
      return true;
    } catch (e) {
      // 落不了盘不致命：本次照样能用，只是下次要重新登录
      this.logger(`会话保存失败：${e.message}`);
      return false;
    }
  }

  clear() {
    this.secure.remove(this.file);
  }

  has() {
    return this.secure.has(this.file);
  }
}

/**
 * 只认 `zxdesk_sid` 一条（⛔ 其它 Cookie 不落盘），且必须带 value + host。
 * 坏数据一律当没有 —— 宁可让用户再登一次，也不回注一个坏 Cookie。
 */
export function normalizeWebSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.name !== 'zxdesk_sid') return null;
  if (typeof raw.value !== 'string' || !raw.value) return null;
  if (typeof raw.host !== 'string' || !raw.host) return null;
  return {
    name: 'zxdesk_sid',
    value: raw.value,
    host: raw.host.toLowerCase(),
    domain: typeof raw.domain === 'string' ? raw.domain : raw.host.toLowerCase(),
    path: typeof raw.path === 'string' && raw.path ? raw.path : '/',
    secure: raw.secure !== false,
    httpOnly: raw.httpOnly === true,
    sameSite: typeof raw.sameSite === 'string' ? raw.sameSite : 'lax',
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
  };
}
