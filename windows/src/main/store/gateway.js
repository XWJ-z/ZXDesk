/**
 * ZXDesk工作台 Windows 客户端
 * 文件：gateway.js
 * 职责：网关凭据（`data/gateway.bin`，**加密**）：访问码 Cookie 的跨启动副本
 *
 * ## 为什么需要这个文件
 *
 * Electron 的 `persist:` 分区只持久化**带有效期**的 Cookie，会话级 Cookie 应用一关就丢。
 * 而飞牛网关的访问码 Cookie 正是会话级 ⇒ 用户每次启动都要重新输一遍访问码。
 *
 * ## 为什么不塞进 `session.bin`
 *
 * 那是**登录会话**的快照，「退出登录」会整份清掉。但「退出登录」不等于「这台设备没通过访问码」——
 * 塞在一起会导致「退出一次，下次连访问码也要重输」。所以单独一份、按 baseUrl 存。
 *
 * ## 与 Android 的差异
 *
 * Android 的 `CookieManager.flush()` 会把整个 Cookie 库（含会话 Cookie）写到磁盘上，
 * 所以那边天然不用管。桌面端没有这个行为，只能自己补。
 *
 * ⛔ 只存「网关凭据」：`fnos-token` / `fnos-long-token` / `entry-token` / `zxdesk_sid` / `mode`
 * 都有自己的通道（`session.bin`），这里再存一份等于多一个泄漏面。
 */

import { normalizeGatewayCookies } from './session.js';

/** 最多记几台设备（换 NAS 频繁的人也不会超过这个数；超了丢最久没用的那台）。 */
export const MAX_GATEWAY_HOSTS = 6;

export class GatewayCookieStore {
  constructor(secureStore, file, logger = () => {}) {
    this.secure = secureStore;
    this.file = file;
    this.logger = logger;
  }

  /** @returns {Promise<Record<string, Array<object>>>} */
  async readAll() {
    const text = await this.secure.get(this.file);
    if (!text) return {};
    try {
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object') return {};
      const out = {};
      for (const [baseUrl, list] of Object.entries(raw)) {
        const items = normalizeGatewayCookies(list);
        if (items.length) out[baseUrl] = items;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** 某台设备的网关凭据（没有就空数组）。 */
  async load(baseUrl) {
    const key = keyOf(baseUrl);
    if (!key) return [];
    const all = await this.readAll();
    return all[key] || [];
  }

  /**
   * 存某台设备的网关凭据。
   *
   * @param {string} baseUrl
   * @param {Array<object>} list - `pickGatewayCookies()` 的结果
   */
  async save(baseUrl, list) {
    const key = keyOf(baseUrl);
    if (!key) return false;
    const items = normalizeGatewayCookies(list);
    try {
      const all = await this.readAll();
      if (!items.length) delete all[key];
      else all[key] = items;
      // 超出上限丢最久没用到的（对象 key 的插入顺序即写入顺序，最旧的排在最前）
      const keys = Object.keys(all);
      while (keys.length > MAX_GATEWAY_HOSTS) delete all[keys.shift()];
      if (!Object.keys(all).length) {
        this.secure.remove(this.file);
        return true;
      }
      await this.secure.put(this.file, JSON.stringify(all));
      return true;
    } catch (e) {
      // 失败不致命：下次再输一次访问码而已，⛔ 不要打断登录
      this.logger(`网关凭据保存失败：${e.name === 'SecureUnavailableError' ? '本机不支持加密存储' : e.message}`);
      return false;
    }
  }

  /** 清掉全部（换机器 / 用户点「清除」时用）。 */
  clear() {
    this.secure.remove(this.file);
  }
}

/** 按「去尾斜杠 + 小写」归一，⛔ 别让 `https://A/` 与 `https://a` 存成两份。 */
export function keyOf(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return value.toLowerCase();
  }
}
