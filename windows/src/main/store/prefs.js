/**
 * 本机偏好（`data/prefs.json`，明文 —— 里面没有凭据）。
 *
 * 存：上次地址 / HTTPS 开关 / 上次账号 / 记住密码开关 / 设备 id（did）/ 窗口大小与位置。
 * ⛔ 不存密码（那是 `credential.bin`）、⛔ 不存 token（那是 `session.bin`）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

export const DEFAULT_PREFS = Object.freeze({
  lastAddress: '',
  preferHttps: true,
  lastUser: '',
  rememberPassword: true,
  /** 自动登录：启动时直接恢复上次会话（含 ZXDesk 网页会话回注）。默认开。 */
  autoLogin: true,
  /** 关闭到托盘：点窗口 X 只隐藏，托盘常驻。默认关（保持「关掉就是关掉」的习惯）。 */
  closeToTray: false,
  /** 启动后静默检查一次更新（发现新版只提示，不打断）。 */
  updateAutoCheck: true,
  /** 用户点过「以后再说」的版本号：同一版不再提示，发新版重新提示。 */
  updateSkippedVersion: '',
  /** 已读公告的 id（只留最近 100 条）：换机/重装后不会再弹老公告。 */
  noticeReadIds: [],
  deviceId: '',
  window: { width: 1280, height: 820, x: null, y: null, maximized: false },
});

export function normalizePrefs(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const window = value.window && typeof value.window === 'object' ? value.window : {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    lastAddress: typeof value.lastAddress === 'string' ? value.lastAddress : '',
    preferHttps: value.preferHttps !== false,
    lastUser: typeof value.lastUser === 'string' ? value.lastUser : '',
    rememberPassword: value.rememberPassword !== false,
    autoLogin: value.autoLogin !== false,
    closeToTray: value.closeToTray === true,
    updateAutoCheck: value.updateAutoCheck !== false,
    updateSkippedVersion: typeof value.updateSkippedVersion === 'string' ? value.updateSkippedVersion : '',
    noticeReadIds: Array.isArray(value.noticeReadIds)
      ? value.noticeReadIds.filter((id) => typeof id === 'string').slice(-100)
      : [],
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : '',
    window: {
      width: Math.max(1100, num(window.width, 1280)),
      height: Math.max(720, num(window.height, 820)),
      x: typeof window.x === 'number' ? window.x : null,
      y: typeof window.y === 'number' ? window.y : null,
      maximized: window.maximized === true,
    },
  };
}

/**
 * 设备 id（登录时当 `did`）：`<时间36进制>-<13位随机>-<13位随机>`，一次生成长期不变。
 * 格式照 fnOS 前端的 `jX()`；换成 uuid 也能跑，但与 Android 两端的 did 风格会不一致。
 */
export function makeDeviceId(now = Date.now(), random = crypto.randomBytes) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const segment = () => {
    const bytes = random(13);
    let out = '';
    for (let i = 0; i < 13; i += 1) out += alphabet[bytes[i] % alphabet.length];
    return out;
  };
  return `${now.toString(36)}-${segment()}-${segment()}`;
}

export class PrefsStore {
  constructor(file, logger = () => {}) {
    this.file = file;
    this.logger = logger;
    this.value = normalizePrefs(readJson(file));
    if (!this.value.deviceId) {
      this.value.deviceId = makeDeviceId();
      this.save();
    }
  }

  get() {
    return this.value;
  }

  patch(partial) {
    this.value = normalizePrefs({ ...this.value, ...partial });
    this.save();
    return this.value;
  }

  setWindow(bounds) {
    return this.patch({ window: { ...this.value.window, ...bounds } });
  }

  save() {
    try {
      fs.mkdirSync(this.file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2), 'utf8');
    } catch (e) {
      this.logger(`偏好保存失败：${e.message}`);
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
