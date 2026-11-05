/**
 * ZXDesk工作台 Windows 客户端
 * 文件：accounts.js
 * 职责：账号清单（`data/accounts.json`，**明文**）
 * 只存「这台设备上登录过谁」：`{ address, user, https, lastUsedAt }`。
 * ⛔ 不存密码（`credential.bin`）、⛔ 不存 token（`session.bin`）。
 * 所以它可以明文 —— 与 `prefs.json` 同级，撑起「切换账号」那个菜单。
 *
 * 为什么要单独一份、不从 `credential.bin` 派生：
 * 用户可以把「记住密码」关掉（凭据清空），但**账号还在** —— 切换账号时至少要能把地址与账号
 * 预填回去，让他重新输一次密码。派生写法会让「关掉记住密码」把账号也一起从菜单里抹掉。
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
