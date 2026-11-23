/**
 * ZXDesk工作台 Windows 客户端
 */

/** 最多记几个账号的密码（再多的账号不存密码，只记在账号清单里）。 */
export const MAX_CREDENTIALS = 10;

export class SavedCredential {
  constructor({ address, user, password, savedAt = 0 }) {
    this.address = address;
    this.user = user;
    this.password = password;
    this.savedAt = savedAt;
  }

  toJSON() {
    return { address: this.address, user: this.user, password: this.password, savedAt: this.savedAt };
  }
}

/** 地址比较用：trim / 去尾部斜杠 / 小写 / 去协议头（与 controller 的 normalizeAddress 同口径）。 */
export function normalizeAccountAddress(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function sameAccount(item, address, user) {
  return normalizeAccountAddress(item.address) === normalizeAccountAddress(address) && String(item.user) === String(user);
}

/** 从任意形状的 JSON 里取出条目数组（兼容 及以前的单条格式）。 */
export function credentialItems(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw.items) ? raw.items : [raw];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.address !== 'string' || !item.address) continue;
    if (typeof item.user !== 'string' || !item.user) continue;
    if (typeof item.password !== 'string' || !item.password) continue;
    out.push(
      new SavedCredential({
        address: item.address,
        user: item.user,
        password: item.password,
        savedAt: typeof item.savedAt === 'number' ? item.savedAt : 0,
      }),
    );
    if (out.length >= MAX_CREDENTIALS) break;
  }
  return out;
}

export class CredentialStore {
  constructor(secureStore, file, logger = () => {}) {
    this.secure = secureStore;
    this.file = file;
    this.logger = logger;
  }

  /** 读全部条目（坏数据当空，⛔ 不半信半疑地用）。 */
  async list() {
    const text = await this.secure.get(this.file);
    if (!text) return [];
    try {
      return credentialItems(JSON.parse(text));
    } catch {
      return [];
    }
  }

  async write(items) {
    try {
      await this.secure.put(this.file, JSON.stringify({ items: items.map((item) => item.toJSON()) }));
      return true;
    } catch (e) {
      // 失败只记「存不了」，⛔ 不把内容写进日志
      this.logger(`密码保存失败：${e.name === 'SecureUnavailableError' ? '本机不支持加密存储' : e.message}`);
      return false;
    }
  }

  /** 保存 / 更新一条（同地址同账号覆盖）。 */
  async save(address, user, password) {
    if (!address || !user || !password) return false;
    const items = await this.list();
    const index = items.findIndex((item) => sameAccount(item, address, user));
    const next = new SavedCredential({ address, user, password, savedAt: Date.now() });
    if (index >= 0) items[index] = next;
    else items.unshift(next);
    // 超出上限时丢**最旧**的一条（按 savedAt）
    if (items.length > MAX_CREDENTIALS) {
      items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      items.length = MAX_CREDENTIALS;
    }
    return this.write(items);
  }

  /** 最近保存的那一条（兼容只关心「有没有记住密码」的旧调用）。 */
  async load() {
    const items = await this.list();
    if (!items.length) return null;
    return items.reduce((newest, item) => ((item.savedAt || 0) > (newest.savedAt || 0) ? item : newest), items[0]);
  }

  /** 精确取「这台设备 + 这个账号」的密码；没有就 null。 */
  async loadFor(address, user) {
    const items = await this.list();
    const hit = items.find((item) => sameAccount(item, address, user));
    return hit || null;
  }

  /**
   * 清除。
   * - 不传参数 ⇒ 全清（「取消记住密码」/ 退出登录）
   */
  async clear(address, user) {
    if (!address || !user) {
      this.secure.remove(this.file);
      return;
    }
    const items = await this.list();
    const next = items.filter((item) => !sameAccount(item, address, user));
    if (!next.length) {
      this.secure.remove(this.file);
      return;
    }
    await this.write(next);
  }

  /**
   * 本机有没有记过密码。
   *
   */
  has() {
    return this.secure.has(this.file);
  }

  /** 这台设备 + 这个账号有没有记住密码。 */
  async hasFor(address, user) {
    return Boolean(await this.loadFor(address, user));
  }
}
