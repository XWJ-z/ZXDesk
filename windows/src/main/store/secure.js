/**
 * 加密落盘（`safeStorage`）。
 *
 * ⚠️ 只用**异步 API**（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）：
 * 同步那三个在 Electron 46 移除，且同步版在部分平台会阻塞主线程。
 * 解密失败一律当「没有会话」处理并清掉坏文件 —— ⛔ 不猜、不重试、不把密文当明文用。
 *
 * 平台现实：Windows 用 DPAPI（绑当前用户 + 机器）⇒ 整个绿色目录拷到另一台电脑解不开，需重新登录（预期）。
 */

import fs from 'node:fs';

const HEADER = 'zxdesk:v1:';

export class SecureUnavailableError extends Error {
  constructor(message = '本机无法加密存储（safeStorage 不可用）') {
    super(message);
    this.name = 'SecureUnavailableError';
  }
}

/**
 * @param {object} options
 * @param {object} options.safeStorage - Electron 的 `safeStorage`
 * @param {object} [options.fsImpl] - 测试注入
 */
export class SecureStore {
  constructor({ safeStorage, fsImpl = fs, logger = () => {} }) {
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.logger = logger;
  }

  async available() {
    const api = this.safeStorage;
    if (!api) return false;
    try {
      if (typeof api.isAsyncEncryptionAvailable === 'function') {
        return await api.isAsyncEncryptionAvailable();
      }
      if (typeof api.isEncryptionAvailable === 'function') return Boolean(api.isEncryptionAvailable());
      return false;
    } catch {
      return false;
    }
  }

  async encryptString(text) {
    const api = this.safeStorage;
    if (!api) throw new SecureUnavailableError();
    if (typeof api.encryptStringAsync === 'function') {
      const buf = await api.encryptStringAsync(String(text));
      return HEADER + Buffer.from(buf).toString('base64');
    }
    if (typeof api.encryptString === 'function') {
      const buf = api.encryptString(String(text));
      return HEADER + Buffer.from(buf).toString('base64');
    }
    throw new SecureUnavailableError();
  }

  async decryptString(payload) {
    const api = this.safeStorage;
    if (!api) throw new SecureUnavailableError();
    if (!String(payload).startsWith(HEADER)) throw new Error('存储格式不认识');
    const raw = Buffer.from(String(payload).slice(HEADER.length), 'base64');
    if (typeof api.decryptStringAsync === 'function') {
      // ⚠️ Electron 45 的 `decryptStringAsync` 解析成 `{ result, shouldReEncrypt }`，**不是字符串**。
      // 0.1.0～0.1.6 直接把它当字符串交给 JSON.parse ⇒ 每次启动都当「文件坏了」，
      // 于是「记住密码 / 自动登录」永远读不回来（prefs.json 是明文，所以地址账号又记得住）。
      // 这里两种返回都认；`shouldReEncrypt`（密钥轮换）不影响本次读取，下次保存自然会用新密钥。
      const out = await api.decryptStringAsync(raw);
      const text = typeof out === 'string' ? out : out?.result;
      if (typeof text !== 'string') throw new Error('解密结果格式不认识');
      return text;
    }
    if (typeof api.decryptString === 'function') return api.decryptString(raw);
    throw new SecureUnavailableError();
  }

  async put(file, text) {
    if (!(await this.available())) throw new SecureUnavailableError();
    const payload = await this.encryptString(text);
    this.fs.writeFileSync(file, payload, 'utf8');
  }

  /**
   * 读回明文；任何问题（文件不存在 / 格式不认识 / 解不开）都返回 `null`。
   * 坏文件会被删掉 —— 留着只会在每次启动时重复失败。
   */
  async get(file) {
    let payload;
    try {
      payload = this.fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return await this.decryptString(payload);
    } catch (e) {
      this.logger(`加密存储读取失败，已清除坏文件：${e.message}`);
      try {
        this.fs.rmSync(file, { force: true });
      } catch {
        /* 删不掉就算了 */
      }
      return null;
    }
  }

  remove(file) {
    try {
      this.fs.rmSync(file, { force: true });
    } catch {
      /* 不存在即达成目的 */
    }
  }

  has(file) {
    try {
      return this.fs.existsSync(file);
    } catch {
      return false;
    }
  }
}
