/**
 * 「记住密码」（`data/credential.bin`，加密）。
 *
 * ⛔ 明文不落盘、⛔ 进日志、⛔ 进诊断文本 —— 本模块对外只给 `load()/save()/clear()/has()`，不打印任何内容。
 * 取消勾选「记住密码」要**立刻清空**（任务单 §四 与 Android §三.3 一致），不等下次保存。
 */

export class SavedCredential {
  constructor({ address, user, password }) {
    this.address = address;
    this.user = user;
    this.password = password;
  }

  toJSON() {
    return { address: this.address, user: this.user, password: this.password };
  }
}

export class CredentialStore {
  constructor(secureStore, file, logger = () => {}) {
    this.secure = secureStore;
    this.file = file;
    this.logger = logger;
  }

  async save(address, user, password) {
    if (!address || !user || !password) return false;
    try {
      await this.secure.put(this.file, JSON.stringify({ address, user, password }));
      return true;
    } catch (e) {
      // 失败只记「存不了」，⛔ 不把内容写进日志
      this.logger(`密码保存失败：${e.name === 'SecureUnavailableError' ? '本机不支持加密存储' : e.message}`);
      return false;
    }
  }

  async load() {
    const text = await this.secure.get(this.file);
    if (!text) return null;
    try {
      const raw = JSON.parse(text);
      if (!raw || typeof raw.address !== 'string' || typeof raw.user !== 'string' || typeof raw.password !== 'string') {
        return null;
      }
      return new SavedCredential({ address: raw.address, user: raw.user, password: raw.password });
    } catch {
      return null;
    }
  }

  clear() {
    this.secure.remove(this.file);
  }

  has() {
    return this.secure.has(this.file);
  }
}
