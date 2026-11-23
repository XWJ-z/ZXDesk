'use strict';
/**
 * core/auth.js —— 账号鉴权与会话（多用户）
 * 功能：对外提供这批原语 ——
 * `hashPassword()` / `verifyPassword()` 负责 scrypt 口令散列与校验；
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/04-多用户与账号.md
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * scrypt 成本参数。
 *
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** 口令最短长度（向导/注册/改密三处共用同一条规则，避免口径不一致） */
const MIN_PASSWORD_LENGTH = 8;

/** 会话 Cookie 名 */
const COOKIE_NAME = 'zxdesk_sid';

/**
 * 会话令牌自身上限：30 天。
 *
 */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** 密钥文件名（放在 data-share 里，随数据一起备份） */
const SECRET_FILE = 'auth.secret';

// ---------------- 口令 ----------------

/**
 * 功能：用当前 `SCRYPT` 参数与随机盐，为口令生成 `scrypt$N$r$p$salt(base64)$hash(base64)` 散列串。
 * @param {string} password - 明文口令（内部再 `String()` 归一）
 * @returns {string} 可入库的散列串，N/r/p 已编码在其中
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

/**
 * 功能：按散列串里记录的成本参数重算 scrypt，校验口令是否与之一致。
 *
 * 说明：⚠️ 任何异常（散列串损坏、参数非法、账号没有口令）一律**返回 false 而不是抛错** ——
 * 必须用 `timingSafeEqual` 比对，不能用 `===`（避免计时侧信道）。
 *
 */
function verifyPassword(password, stored) {
  try {
    const parts = String(stored == null ? '' : stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!salt.length || !expected.length) return false;
    const dk = crypto.scryptSync(String(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch (_e) {
    return false;
  }
}

/**
 * 功能：判定一条散列**能不能用来登录** —— 格式合法、参数在 `verifyPassword` 能跑通的范围内、盐与结果非空。
 *
 * 说明：⭐ 为什么必须单独有这么一个判据（第三次被挡在门外后补上）：
 * `verifyPassword` 对「口令错」和「这个账号压根没有可用口令」**都返回 false**，登录接口也只回
 * 一句「用户名或密码不正确」——可这两件事的处置**完全相反**：
 */
function hashUsable(stored) {
  const parts = String(stored == null ? '' : stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false;
  if (128 * N * r > SCRYPT.maxmem) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  return salt.length > 0 && expected.length > 0;
}

/**
 * 功能：判断一条散列是否用了**过时 / 非当前**的成本参数，登录成功后据此静默重算并回写。
 *
 *
 * @param {?string} stored - 库里的 `password_hash`
 * @returns {boolean} 格式不合法或 N/r/p 与当前 `SCRYPT` 不同为 true
 */
function needsRehash(stored) {
  const parts = String(stored == null ? '' : stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) !== SCRYPT.N || Number(parts[2]) !== SCRYPT.r || Number(parts[3]) !== SCRYPT.p;
}

// ---------------- 会话密钥 ----------------

/**
 * 功能：从数据目录读取会话签名密钥；不存在或不可用时生成一个新的 32 字节密钥并以 0600 权限写盘。
 *
 * 说明：⚠️ **必须落盘**：不落盘每次重启换密钥 → 所有人被登出。
 * 落盘失败不阻断启动（宁可这次运行会话不持久，也别让应用起不来），但要回报 `error`
 * 让 server.js 显著告警 —— 静默降级是不可接受的。
 */
function loadOrCreateSecret(dataDir) {
  const file = path.join(dataDir, SECRET_FILE);
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) {
      const buf = Buffer.from(s, 'base64');
      if (buf.length >= 32) return { secret: buf, error: null, file };
    }
  } catch (_e) {
    /* 不存在或读不了 → 下面生成 */
  }
  const buf = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, buf.toString('base64'), { mode: 0o600 });
    return { secret: buf, error: null, file };
  } catch (e) {
    return {
      secret: buf,
      error: (e && e.message) || String(e),
      file,
    };
  }
}

// ---------------- 会话令牌 ----------------

/**
 * 功能：签发出 `uid.epoch.expMs.hmac` 形式的会话令牌，HMAC（SHA256，base64url）覆盖前三段。
 * @param {Buffer} secret - 会话签名密钥
 * @param {number} uid - 账号 id
 * @param {number} epoch - 签发时的会话世代（`session_epoch`），改密后旧令牌即失效
 * @param {number} nowMs - 当前时间戳（毫秒），过期时刻由它加 `SESSION_MS` 得出
 */
function issueSession(secret, uid, epoch, nowMs) {
  const exp = Number(nowMs) + SESSION_MS;
  const payload = `${Number(uid)}.${Number(epoch)}.${exp}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/**
 * 功能：把 `a=1; b=2` 形式的 Cookie 头切成 `{ a: '1', b: '2' }`（最简切分，不处理引号与转义）。
 * @param {?string} header - 原始 Cookie 请求头，可为 NULL / 空串
 * @returns {Object} Cookie 名到值的映射；没有有效片段时为空对象
 */
function parseCookies(header) {
  const out = {};
  String(header == null ? '' : header)
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (k) out[k] = part.slice(i + 1).trim();
    });
  return out;
}

/**
 *
 * 说明：⚠️ 这里**不查库**（拿不到 store）——「世代是否仍然有效」「账号是否还在」由调用方
 */
function readSession(secret, cookieHeader, nowMs) {
  const raw = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;
  const parts = String(raw).split('.');
  if (parts.length !== 4) return null;
  const [uidStr, epochStr, expStr, mac] = parts;
  const uid = Number(uidStr);
  const epoch = Number(epochStr);
  const exp = Number(expStr);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(epoch) || !Number.isFinite(exp)) return null;

  const payload = `${uidStr}.${epochStr}.${expStr}`;
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  // 长度不等时 timingSafeEqual 会抛错，所以先比长度（长度本身不是秘密）
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (Number(nowMs) > exp) return null;
  return { uid, epoch, exp };
}

/**
 * 功能：生成会话 Cookie 的 `Set-Cookie` 头值（含 Path / HttpOnly / SameSite=Lax，HTTPS 时加 Secure）。
 *
 * 说明：⚠️ `Secure` **只在 HTTPS 通道加**：应用同时提供 `http://<NAS>:8990` 端口入口，
 * 那里加 `Secure` 浏览器直接不存这个 Cookie，等于登录失效。走统一网关（https）时加，
 * 端口通道行为不变。
 */
function sessionCookie(token, secure) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * 功能：生成把会话 Cookie 置空的 `Set-Cookie` 头值（Max-Age=0），用于退出登录。
 * @returns {string} `Set-Cookie` 头值
 */
function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  COOKIE_NAME,
  SESSION_MS,
  hashPassword,
  verifyPassword,
  hashUsable,
  needsRehash,
  loadOrCreateSecret,
  issueSession,
  readSession,
  sessionCookie,
  clearSessionCookie,
};
