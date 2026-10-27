'use strict';
/**
 * core/auth.js —— 账号鉴权与会话（多用户）
 *
 * 功能：对外提供这批原语 ——
 *      `hashPassword()` / `verifyPassword()` 负责 scrypt 口令散列与校验；
 *      `hashUsable()` / `needsRehash()` 判定一条散列能否登录、成本参数是否过时；
 *      `loadOrCreateSecret()` 读取或首次生成落盘的会话签名密钥；
 *      `issueSession()` / `readSession()` 签发与校验 HMAC-SHA256 无状态令牌；
 *      `parseCookies()` 切分 Cookie 头，`sessionCookie()` / `clearSessionCookie()` 序列化会话 Cookie。
 *      另导出 `MIN_PASSWORD_LENGTH` / `COOKIE_NAME` / `SESSION_MS` 三个常量。
 *
 * ⚠️ 会话 Cookie 是**会话级**的（**刻意不带 `Max-Age`**，见 `sessionCookie()`）：关掉浏览器 / 飞牛 App
 *    之后它就不复存在，下次打开必须重新登录。`SESSION_MS` 只是**令牌自身上限**，不是「免登录多久」。
 *
 * 职责边界：**只做密码学与会话令牌**，不碰数据库、不认识 HTTP。
 *   - 口令散列/校验（scrypt）
 *   - 会话令牌的签发/校验（HMAC-SHA256，无状态）
 *   - Cookie 头的序列化
 * 存储层（storage.js）负责存 `password_hash` 与 `session_epoch`；路由层（server.js）负责取 Cookie、
 * 查账号、决定放行或拒绝。
 *
 * ⭐ 为什么是**无状态签名 Cookie** 而不是服务端会话表：
 *   零依赖、零额外表、重启不掉线（密钥落盘）。代价是「改密无法立刻踢人」——
 *   所以配合 storage.js 的 `session_epoch`：令牌里带签发时的世代，校验时与库里比对，
 *   改密/重置密码即世代 +1，旧令牌立刻失效。
 *
 * ⚠️ 参数与格式一旦上线就不能随意改：`password_hash` 是 `scrypt$N$r$p$salt$hash` 字符串，
 *    **N/r/p 写在其中**，所以将来调高成本不会让老账号失效（见 `needsRehash`）。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.5
 * 相关：docs/公共/架构文档/04-多用户与账号.md
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * scrypt 成本参数。
 *
 * 实测（x86 开发机，见 docs/公共/开发方案/01 §14.3①）：N=2^14 → 32ms，2^15 → 60ms，2^16 → 121ms。
 * NAS 的 ARM 通常慢 3~8 倍，故取 2^15（NAS 上约 200~500ms）：既高于 OWASP 对交互式登录的
 * 下限 2^14，又不至于让登录等待感明显、也不至于每次登录瞬时占 64MB 内存。
 *
 * ⚠️ `scryptSync` 会**阻塞事件循环**（与 storage.js 的 DatabaseSync 同类问题）。
 *    登录是低频操作，暂时可接受；若将来并发登录变多，须换成异步 `crypto.scrypt`。
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** 口令最短长度（向导/注册/改密三处共用同一条规则，避免口径不一致） */
const MIN_PASSWORD_LENGTH = 8;

/** 会话 Cookie 名 */
const COOKIE_NAME = 'zxdesk_sid';

/**
 * 会话令牌自身上限：30 天。
 *
 * ⚠️ 这**不是**「免登录 30 天」—— 会话 Cookie 是**会话级**的（`sessionCookie()` 刻意不带 `Max-Age`），
 *    关掉浏览器 / 飞牛 App 就没了。本常量只是「万一 Cookie 一直活着（页面常年不关）」的兜底上限，
 *    配合 `session_epoch` 可随时踢下线。
 *
 * ⚠️ 曾经这里是「登录状态保留 30 天」（持久 Cookie）。改成会话级的原因：
 *    飞牛 App 的 WebView 与飞牛账号是**两回事** —— 切换飞牛账号不会清掉本应用的 Cookie，
 *    于是持久 Cookie 会让人**直接进入上一个 ZXDesk 账号**。会话级至少做到「关掉再进来要重新登录」。
 *    真正的根治是接入飞牛统一网关用 `X-Trim-Userid` 绑定身份（见 docs/公共/开发方案/01 §二「将来若要加网关免密」）。
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
 *      登录接口不该因为一条坏数据变成 500，那会把「密码错」和「库坏了」混在一起。
 *      ⚠️ 必须用 `timingSafeEqual` 比对，不能用 `===`（避免计时侧信道）。
 *
 * @param {string} password - 待校验的明文口令
 * @param {?string} stored - 库里的 `password_hash`，可为 NULL / 空串
 * @returns {boolean} 匹配为 true；解析或计算异常一律 false
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
 *    `verifyPassword` 对「口令错」和「这个账号压根没有可用口令」**都返回 false**，登录接口也只回
 *    一句「用户名或密码不正确」——可这两件事的处置**完全相反**：
 *      · 口令错 → 必须拒绝，谁也不知道密码；
 *      · 没有可用口令（散列为 NULL / 空串 / 被写坏）→ **这个账号谁都进不去**，不是安全问题而是死锁，
 *        必须由 `ensureBuiltinAdmin()` 重写初始口令，否则内置 `admin` 会永久性进不去。
 *    早期库正是后者：他的 `users` 表来自单用户时代（只有 id/username/display_name/created_at），
 *    `_ensureColumn` 补出的 `password_hash` 是 NULL，而当时的规则是「名字被占就提升、绝不改密码」，
 *    于是一个**没有密码的管理员**被提升出来，敲什么都是「密码不正确」。
 *
 * ⚠️ 判据刻意与 `verifyPassword` 的实际能力**对齐**：`N` 必须是 2 的幂且 `128*N*r` 不超过 maxmem
 *    （否则 `scryptSync` 会抛错、被 catch 吞成 false）——「看起来像散列」不等于「能用它登录」。
 *
 * @param {?string} stored - 库里的 `password_hash`，可为 NULL / 空串
 * @returns {boolean} 能用来登录为 true
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
 * 说明：参数变了不会让老账号失效，只会让它们在下次登录时被悄悄升级。
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
 *      ⚠️ 落盘失败不阻断启动（宁可这次运行会话不持久，也别让应用起不来），但要回报 `error`
 *      让 server.js 显著告警 —— 静默降级是不可接受的。
 *
 * @param {string} dataDir - 数据目录，密钥文件落在这里随数据一起备份
 * @returns {{ secret: Buffer, error: ?string, file: string }} 密钥、失败原因（成功为 null）、密钥文件路径
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
 * @returns {string} 会话令牌串
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
 * 功能：校验会话令牌，签名正确且未过期时返回 `{ uid, epoch, exp }`，否则返回 null。
 *
 * 说明：⚠️ 这里**不查库**（拿不到 store）——「世代是否仍然有效」「账号是否还在」由调用方
 *      比对 `store.sessionEpoch(uid)` 完成。这样本模块保持零依赖、可单独测试。
 *
 * @param {Buffer} secret - 会话签名密钥
 * @param {?string} cookieHeader - 原始 Cookie 请求头
 * @param {number} nowMs - 当前时间戳（毫秒），用于过期判断
 * @returns {?Object} 解析出的 `{ uid, epoch, exp }`；签名不符或已过期时为 null
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
 *      那里加 `Secure` 浏览器直接不存这个 Cookie，等于登录失效。走统一网关（https）时加，
 *      端口通道行为不变。
 *      ⚠️ 加 `HttpOnly`（防 XSS 偷走）与 `SameSite=Lax`（防跨站带上；回调页跳转仍能带上）。
 *      ⭐ **刻意不加 `Max-Age` / `Expires`**：这样它就是**会话级 Cookie** ——
 *      浏览器 / 飞牛 App 一关就没了，下次打开必须重新登录。原因见上面 `SESSION_MS` 的说明：
 *      飞牛账号与本应用账号是两套，持久 Cookie 会让人「切换账号后仍然直接进入上一个账号」。
 *      ⚠️ 别「顺手」把 `Max-Age` 加回来换取免登录 —— 那是把数据隔离换成方便。
 *
 * @param {string} token - `issueSession()` 签发的会话令牌
 * @param {boolean} [secure] - 是否经 HTTPS 通道（`req.socket.encrypted` 或 `x-forwarded-proto: https`）
 * @returns {string} `Set-Cookie` 头值
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
