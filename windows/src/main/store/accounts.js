/**
 * ZXDesk工作台 Windows 客户端
 */

import fs from 'node:fs';

export const MAX_ACCOUNTS = 10;

/** 地址比较口径：与 `credentials.js` / controller 的 normalizeAddress 一致。 */
export function normalizeAccountAddress(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function same(address, user, item) {
  return normalizeAccountAddress(item.address) === normalizeAccountAddress(address) && String(item.user) === String(user);
}

/** 归一：只认「有地址 + 有账号」的条目，按最近使用排序。 */
export function normalizeAccounts(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.address !== 'string' || !item.address) continue;
    if (typeof item.user !== 'string' || !item.user) continue;
    const key = `${normalizeAccountAddress(item.address)}\u0000${item.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      address: item.address,
      user: item.user,
      https: item.https !== false,
      lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : 0,
    });
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return out.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}

export class AccountStore {
  constructor(file, logger = () => {}) {
    this.file = file;
    this.logger = logger;
    this.value = normalizeAccounts(readJson(file));
  }

  list() {
    return this.value;
  }

  /** 登录成功时记一条（同地址同账号只更新时间，不新增）。 */
  remember({ address, user, https }) {
    if (!address || !user) return this.value;
    const next = this.value.filter((item) => !same(address, user, item));
    next.unshift({ address, user, https: https !== false, lastUsedAt: Date.now() });
    this.value = normalizeAccounts(next);
    this.save();
    return this.value;
  }

  /** 从清单里删掉一个（「退出登录」不清账号 —— 见 removeAccount 的调用方）。 */
  remove(address, user) {
    const next = this.value.filter((item) => !same(address, user, item));
    if (next.length === this.value.length) return this.value;
    this.value = normalizeAccounts(next);
    this.save();
    return this.value;
  }

  save() {
    try {
      // 与 prefs 一样同步写：文件只有几百字节，且只在登录成功 / 切换账号时发生
      writeJson(this.file, { accounts: this.value });
    } catch (e) {
      this.logger(`账号清单保存失败：${e.message}`);
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
