'use strict';
/**
 * modules/vault/store.js —— 密码库业务方法
 * 功能：密码库的全部业务逻辑，一处收齐 ——
 * `vaultStatus()`（是否已初始化 / 是否已解锁 / 自动锁定秒数）、
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md
 */
const crypto = require('node:crypto');
const { nowStamp, notFoundErr, badRequest, isBlankPassword } = require('../../core/store/helpers.js');
const vc = require('./lib/crypto.js');

/** 自动锁定的默认分钟数（10 分钟，可设置） @type {number} */
const DEFAULT_LOCK_MINUTES = 10;

/** 自动锁定分钟数的允许区间 —— 与 `validate.js` 的口径一致（**不允许 0**：自动锁定是安全特性） */
const LOCK_MINUTES_MIN = 1;
const LOCK_MINUTES_MAX = 120;

/** 钥匙编号的前缀 —— 与 `.zxkey` 文件格式里的 `app` 同源，改它 = 旧钥匙的 `kid` 全部对不上 */
const KID_PREFIX = 'zxdesk-key-v1';

/** 钥匙文件的大小上限：64 KB —— 超过一定不是我们的文件 */
const KEY_FILE_MAX = 64 * 1024;

/** 导入钥匙时允许的 KDF 参数上限 —— 防止有人用「N=2^30」让服务端卡死 */
const IMPORT_KDF_MAX = { N: 1 << 17, r: 8, p: 4 };

/** 「已开钥匙」的空闲超时：10 分钟滑动（与密码库解锁态同一条体感） */
const READER_IDLE_MS = 10 * 60 * 1000;

/** 「已开钥匙」的数量上限（LRU 淘汰） */
const READER_MAX = 8;

/** 一个标签名的长度上限 —— 与 `validate.js` 的 `MAX_SHORT_TEXT` 同口径（收藏夹分类名也是 50） */
const MAX_TAG_LEN = 50;

/** 一条记录最多几个标签 —— 与 `validate.js` 的 `MAX_VAULT_TAGS` 同口径 */
const MAX_TAGS = 20;

/**
 * 功能：把「从密文里解出来的标签」或「请求里带上来的标签」归一化成 `string[]`。
 *
 * 说明：⭐ 它**同时**服务两个方向，这是刻意的：
 * 写入方向：请求里的 `tags` 已经过 `validate.js`，这里再兜一次（密文里存的东西
 * 不该依赖「上游一定校验过」）；
 */
function normTags(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** @type {Array.<string>} */
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const name = String(item).trim();
    if (!name || name.length > MAX_TAG_LEN) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 进程内解锁表：`uid → { dek, at, minutes, timer }`。
 *
 */
const unlocked = new Map();

/**
 * 进程内「已开钥匙」表：`"<会话账号>:<kid>" → {dek, ownerUid, at, timer}`。
 *
 */
const readerKeys = new Map();

/**
 * 功能：校验一份 `.zxkey` 的**格式**（⛔ 不验密码、不解密、不碰数据库、不回任何密钥材料）。
 *
 * 抽出来的理由是**失效方式**——两处各写一遍，早晚一边放宽一边没放宽，
 * 症状是「识别说这是好钥匙，导入却说不是钥匙文件」，用户在两步之间被绕死。
 * 这里**不校验 `kid` 与材料是否对得上**：那要解密后才能算（`kidOf()`），
 */
function parseKeyFile(obj) {
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  if (!o || o.app !== 'zxdesk' || Number(o.v) !== 1 || o.kind !== 'vault-key') {
    throw badRequest('这不是一个有效的钥匙文件');
  }
  // 大小上限在**解析后**再兜一次：路由层已经按 `KEY_FILE_MAX` 限制读取长度，
  // 但那个口头约定不该是唯一防线（少一处就是「一个 50 MB 的 JSON 进内存」）。
  if (Buffer.byteLength(JSON.stringify(o), 'utf8') > KEY_FILE_MAX) {
    throw badRequest('这不是一个有效的钥匙文件');
  }
  const str = (v) => String(v == null ? '' : v);
  const need = ['kid', 'salt', 'dek_iv', 'dek_cipher', 'dek_tag', 'verifier_iv', 'verifier_cipher', 'verifier_tag'];
  if (need.some((f) => !str(o[f]))) throw badRequest('钥匙文件不完整（可能被截断）');
  if (String(o.kdf || 'scrypt') !== 'scrypt') throw badRequest('钥匙文件的参数不合法（可能被改过）');
  let params;
  try {
    params = vc.normalizeKdfParams(o.kdf_params);
  } catch (_e) {
    throw badRequest('钥匙文件的参数不合法（可能被改过）');
  }
  if (params.N > IMPORT_KDF_MAX.N || params.r > IMPORT_KDF_MAX.r || params.p > IMPORT_KDF_MAX.p) {
    throw badRequest('钥匙文件的参数不合法（可能被改过）');
  }
  const salt = Buffer.from(str(o.salt), 'base64');
  if (salt.length < 8) throw badRequest('钥匙文件不完整（可能被截断）');
  return {
    obj: o,
    params,
    salt,
    kid: str(o.kid),
    owner_uid: Number.isInteger(Number(o.owner_uid)) ? Number(o.owner_uid) : null,
    owner_name: str(o.owner_name).slice(0, 100),
    created_at: str(o.created_at),
  };
}

/**
 * 功能：算一把钥匙的编号（DEK 指纹前 16 位十六进制）。
 *
 * 说明：⭐ `kid` **不是密钥**，只是「这两把钥匙是不是同一把」的指纹 ——
 * 前缀 `zxdesk-key-v1` 刻意写死：换它就等于让所有已导出的钥匙「对不上号」。
 * @param {Buffer} dek - 32 字节数据密钥
 */
function kidOf(dek) {
  return crypto.createHash('sha256').update(KID_PREFIX).update(dek).digest('hex').slice(0, 16);
}

/**
 *
 * 说明：⚠️ 刻意不用 `toISOString()`：它是 UTC（`…T14:40:00.000Z`），而钥匙文件是**给人看**的，
 */
function isoLocal(d) {
  const t = d instanceof Date ? d : new Date();
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const body =
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  return `${body}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/**
 * 功能：算「已开钥匙」在内存表里的键（会话账号 ＋ 钥匙编号）。
 * @param {number} uid - 当前会话账号 id
 * @param {string} kid - 钥匙编号
 * @returns {string} 内存键
 */
function readerSlot(uid, kid) {
  return `${Number(uid)}:${String(kid)}`;
}

/**
 * 功能：把「已开钥匙」的内存键拆回 `[账号 id, 钥匙编号]`。
 * @param {string} slot - `readerSlot()` 生成的键
 * @returns {Array} `[uid, kid]`
 */
function splitSlot(slot) {
  const s = String(slot);
  const i = s.indexOf(':');
  if (i < 0) return [NaN, s];
  return [Number(s.slice(0, i)), s.slice(i + 1)];
}

/**
 * 功能：给一把「已开钥匙」挂一个「到期就从内存表删掉」的定时器。
 *
 * 说明：⚠️ 必须 `unref()`（与 `scheduleDrop()` 同一理由）。正确性由 `readerDek()` /
 * `readerHas()` 里的时间比对兜底 —— 定时器只负责「尽早释放引用」，它可能晚触发。
 * @param {string} slot - 内存键
 */
function scheduleReaderDrop(slot) {
  const t = setTimeout(() => {
    const e = readerKeys.get(slot);
    if (e && e.timer) clearTimeout(e.timer);
    readerKeys.delete(slot);
  }, READER_IDLE_MS);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

/**
 * 功能：把这个账号在阅读器里**已经打开的**钥匙全部清掉（锁库时调）。
 *
 * 而阅读器是另一个页面 —— 它自己那把钥匙（`readerKeys`，10 分钟滑动）如果留着，
 * 锁库之后那个窗口还能继续解密。⇒ 锁库这一下要**连它一起失效**，
 * 让它下一次请求拿 403，前端据此回到「需要主密码」。
 */
function purgeReaderKeys(uid) {
  const prefix = `${Number(uid)}:`;
  let n = 0;
  for (const k of [...readerKeys.keys()]) {
    if (!k.startsWith(prefix)) continue;
    const e = readerKeys.get(k);
    if (e && e.timer) clearTimeout(e.timer);
    readerKeys.delete(k);
    n += 1;
  }
  return n;
}

/**
 * 功能：构造一个「需要解锁 / 主密码不对」的 403 错误。
 *
 * 说明：⭐ **刻意不用 401**：前端的规则是「遇到 401 一律跳登录页」，
 * 而「主密码输错了」把人踢回登录页是彻底的误伤（他账号明明好好的）。
 * 403 属于「授权结果」这一桶，响应体逐字固定、不掺 `readOnly` 之类字段。
 */
function denied(message) {
  const e = new Error(message);
  e.status = 403;
  return e;
}

/**
 * 功能：把某个账号的解锁记录（连同它的定时器）从进程内存里彻底拿掉。
 * @param {number} uid - 账号 id
 * @returns {void}
 */
function dropUnlocked(uid) {
  const e = unlocked.get(Number(uid));
  if (e && e.timer) clearTimeout(e.timer);
  unlocked.delete(Number(uid));
}

/**
 * 功能：**只读**判断某个账号此刻在不在解锁态 —— 与 `vaultIsUnlocked()` 的唯一区别是**不续期**。
 *
 * 说明：⭐ 009 报告 S9：`GET /api/vault/status` 以前直接走 `vaultIsUnlocked()`，而那个方法每次访问
 * 都会把到期时间往后推 —— 于是**一个拿着 Cookie 的脚本低频轮询 status 就能让密码库永不自动锁定**
 * （前端倒计时是纯本地的，不是前端缺陷）。「继续操作就续期」是给**真正在用密码库**的动作
 */
function peekUnlocked(uid) {
  const key = Number(uid);
  const e = unlocked.get(key);
  if (!e) return false;
  if (Date.now() - e.at > e.minutes * 60000) {
    dropUnlocked(key);
    purgeReaderKeys(key);
    return false;
  }
  return true;
}

/**
 * 功能：读某个账号的自动锁定分钟数（账号行上的 `vault_lock_minutes`，兜底默认 10 分钟）。
 *
 * 说明：⚠️ 兜底是**双向夹取**（既兜「老库没这一列 → undefined」，也兜「库里被写了个荒唐值」）：
 * 老 JSON 数据、以及结构升级前建出来的账号行都可能没有这一列 ——
 * 缺列的表现必须是「用默认的 10 分钟」，**不能是「永不锁定」**（那是一个安全特性的静默失效）。
 */
function lockMinutesOf(self, uid) {
  const u = self.getUser(uid);
  const raw = u ? Number(u.vault_lock_minutes) : NaN;
  if (!Number.isInteger(raw) || raw < LOCK_MINUTES_MIN) return DEFAULT_LOCK_MINUTES;
  return Math.min(raw, LOCK_MINUTES_MAX);
}

module.exports = {
  DEFAULT_LOCK_MINUTES,
  LOCK_MINUTES_MIN,
  LOCK_MINUTES_MAX,

  /**
   * 功能：读某个账号的自动锁定分钟数（给路由层与前端用）。
   * @param {number} uid - 账号 id
   * @returns {number} 分钟数（1~120）
   */
  vaultLockMinutes(uid) {
    return lockMinutesOf(this, uid);
  },

  /**
   * 功能：改某个账号的自动锁定分钟数（**每个账号各管各的**，存在 `users` 行上）。
   *
   * 说明：⭐ 与四个显示开关同一条规矩：不进全局 `settings`、删账号随行消失、
   * **不动 `session_epoch`**（改「多久自动锁」不该把人踢下线）。
   * 改小之后**立刻生效**：已经在解锁态的那些会话，其到期时间按新值重算 ——
   */
  setVaultLockMinutes(uid, minutes) {
    this._assertWritable();
    const n = Number(minutes);
    if (!Number.isInteger(n) || n < LOCK_MINUTES_MIN || n > LOCK_MINUTES_MAX) {
      throw badRequest(`自动锁定时间应是 ${LOCK_MINUTES_MIN} 到 ${LOCK_MINUTES_MAX} 分钟之间的整数`);
    }
    if (!this._bk.setVaultLockMinutes(Number(uid), n, nowStamp())) {
      throw notFoundErr('这个账号');
    }
    const e = unlocked.get(Number(uid));
    if (e) {
      e.minutes = n;
      // 重设定时器：新值可以比原来更短，也可以更长，两种情况都得按新的来
      if (e.timer) clearTimeout(e.timer);
      e.timer = scheduleDrop(uid, n);
    }
    return n;
  },

  /**
   * 功能：密码库状态 —— **未解锁时也只回这三样**（`initialized` / `unlocked` / 锁定秒数），
   * 不含任何条目信息（连条数都不给）。
   *
   * 说明：⚠️ `initialized` 只说明「这个账号设过主密码」，它**不是**敏感信息 ——
   * 用户自己当然知道；而界面必须靠它决定「显示设置主密码页」还是「显示解锁页」。
   */
  vaultStatus(uid) {
    const minutes = lockMinutesOf(this, uid);
    const e = unlocked.get(Number(uid));
    const isOn = peekUnlocked(uid);
    // 原来是靠前端各自算倒计时（只有密码库那一屏在跑），加密信息屏根本没有计时器 ⇒
    // 到点也不会回到锁屏。现在由 `core/vault-watch.js` 统一按这个值排到期定时器。
    // 「轮询 status 让自动锁定永不触发」，⛔ 不能改成 `vaultIsUnlocked()`。
    const left = isOn && e ? Math.max(0, Math.round((e.at + e.minutes * 60000 - Date.now()) / 1000)) : 0;
    return {
      initialized: !!this._bk.getVaultMeta(Number(uid)),
      // 只读判断（`peekUnlocked`）：这个接口是给界面问「现在锁没锁」的，
      unlocked: isOn,
      lockAfterSeconds: minutes * 60,
      lockMinutes: minutes,
      remainingSeconds: left,
    };
  },

  /**
   * 功能：判断某个账号此刻是否处于解锁态 —— 顺带**滑动续期**（把到期时间往后推）。
   *
   * 说明：⭐ 超时口径是**空闲超时**（每次访问都续期），不是「从解锁那刻起 10 分钟一到就锁」：
   * 「避免用户写到一半被锁掉」（界面还有锁前 30 秒提示）。
   * 过期记录**当场删除**（连同定时器）—— 「过期了但还留着引用」等于把超时做成了摆设。
   */
  vaultIsUnlocked(uid) {
    const key = Number(uid);
    if (!peekUnlocked(key)) return false;
    // 只有走到这里才续期 —— 「问状态」走 `peekUnlocked()`，不推到期时间（009 报告 S9）
    const e = unlocked.get(key);
    e.at = Date.now();
    if (e.timer) clearTimeout(e.timer);
    e.timer = scheduleDrop(key, e.minutes);
    return true;
  },

  /**
   * 功能：初始化密码库 —— 第一次设置主密码（**每个账号一次**）。
   *
   * 说明：⭐ 一次性做三件事：生成随机盐 → 派生 KEK → 生成随机 DEK 并用 KEK 封装 →
   * 写一行 `vault_meta`（含用 KEK 加密的验证块）。**条目此时还是空的**。
   * （DEK 被换成新的，旧条目全部解不开），而用户以为只是「重新设了个密码」。
   */
  vaultInit(uid, masterPassword) {
    this._assertWritable();
    const key = Number(uid);
    if (this._bk.getVaultMeta(key)) {
      throw badRequest('这个账号已经设置过主密码了，不能重复初始化（重新初始化会让原来的条目全部打不开）');
    }
    const params = vc.KDF_DEFAULT;
    const salt = vc.newSalt();
    const kek = vc.deriveKek(masterPassword, salt, params);
    const dek = vc.newDek();
    const sealed = vc.sealDek(kek, dek);
    const verifier = vc.makeVerifier(kek);
    const stamp = nowStamp();
    this._bk.insertVaultMeta(key, {
      kdf: 'scrypt',
      kdf_params: JSON.stringify({ N: params.N, r: params.r, p: params.p, keylen: params.keylen }),
      salt: salt.toString('base64'),
      dek_iv: sealed.iv,
      dek_cipher: sealed.cipher,
      dek_tag: sealed.tag,
      verifier_iv: verifier.iv,
      verifier_cipher: verifier.cipher,
      verifier_tag: verifier.tag,
      created_at: stamp,
      updated_at: stamp,
    });
    // 初始化成功即视为已解锁：用户刚刚亲口设了主密码，再让他立刻输一遍是纯粹的添堵
    this._vaultHold(key, dek);
    return { ok: true };
  },

  /**
   * 功能：用主密码解锁密码库 —— 校验通过则把 DEK 放进**进程内**解锁表。
   *
   * 说明：⭐ 校验分两步、缺一不可：① 用主密码 + 库里那个盐派生 KEK；
   * ② 用它解开 `verifier_*` 并比对固定明文。**不需要**先解 DEK ——
   * 验证块对不上的时候连 DEK 密文都不碰（少一次可能出错的解密）。
   */
  vaultUnlock(uid, masterPassword) {
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) throw badRequest('这个账号还没有设置主密码，请先设置');
    if (String(meta.kdf) !== 'scrypt') throw badRequest('这个密码库用了本版本不认识的算法，请升级应用后再试');

    const params = vc.parseKdfParams(meta.kdf_params); // 参数损坏 → 抛「参数已损坏」，不是「密码错」
    const salt = Buffer.from(String(meta.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这个密码库的盐已损坏，无法解锁（请从备份恢复）');
    const kek = vc.deriveKek(masterPassword, salt, params);
    const ok = vc.checkVerifier(kek, {
      iv: meta.verifier_iv,
      cipher: meta.verifier_cipher,
      tag: meta.verifier_tag,
    });
    if (!ok) throw denied('主密码不正确');

    const dek = vc.openDek(kek, { iv: meta.dek_iv, cipher: meta.dek_cipher, tag: meta.dek_tag });
    const minutes = lockMinutesOf(this, key);
    this._vaultHold(key, dek, minutes);
    return { ok: true, lockAfterSeconds: minutes * 60 };
  },

  /**
   * 功能：把一个 DEK 放进进程内解锁表，并挂上到期自动清除的定时器。
   *
   * 表现为「关掉应用之后进程迟迟不退出」。
   * 真正的到期判定在 `vaultIsUnlocked()` 里也做了一遍（定时器只是让引用尽早释放，
   *
   */
  _vaultHold(uid, dek, minutes) {
    const key = Number(uid);
    const m = Number.isInteger(minutes) ? minutes : lockMinutesOf(this, key);
    dropUnlocked(key);
    unlocked.set(key, { dek, at: Date.now(), minutes: m, timer: scheduleDrop(key, m) });
  },

  /**
   * 功能：取当前账号的 DEK（**本模块唯一的取密钥出口**）；未解锁或已超时一律抛 403。
   *
   * 说明：⚠️ 所有条目方法都必须先过这里 —— 它是「未解锁不返回任何条目信息」这条规矩的
   * 单一执行点。**不要**在任何地方绕过它去读 `unlocked`。
   *
   */
  _vaultDek(uid) {
    if (!this.vaultIsUnlocked(uid)) throw denied('密码库已锁定，请先输入主密码解锁');
    return unlocked.get(Number(uid)).dek;
  },

  /**
   * 功能：手动锁定密码库（界面上的「🔒 锁定」按钮）。
   * @param {number} uid - 账号 id
   * @returns {{ok: true}} 固定返回体（**不回「锁没锁上」之外的任何东西**）
   */
  vaultLock(uid) {
    this.lockAndPurge(uid);
    return { ok: true };
  },

  /**
   * 功能：锁定一个账号并**连带清掉它在阅读器里已开的钥匙**（锁库的唯一推荐入口）。
   *
   * 三处调用：手动锁定（`vaultLock()`）、自动到期（`scheduleDrop()` 的定时器）、
   * `peekUnlocked()` 发现已过期。⛔ 别把清理塞进 `dropUnlocked()` ——
   * `_vaultHold()`（重新解锁）也调它，那样每次解锁都会误伤。
   */
  lockAndPurge(uid) {
    const key = Number(uid);
    dropUnlocked(key);
    return { ok: true, purged: purgeReaderKeys(key) };
  },

  /**
   * 功能：清空**全部**账号的解锁状态（测试与运维用；也可作为「全局上锁」的入口）。
   * @returns {number} 被清掉的解锁记录条数
   */
  vaultLockAll() {
    const n = unlocked.size;
    [...unlocked.keys()].forEach(dropUnlocked);
    // 运维「一键上锁」也不该留下还能解密的窗口）
    readerKeys.forEach((e) => {
      if (e && e.timer) clearTimeout(e.timer);
    });
    readerKeys.clear();
    return n;
  },

  /**
   * 功能：**仅供测试** —— 看某个账号当前的解锁记录（**只回时间信息，绝不回密钥**）。
   *
   * 可注入的时钟 / 短超时验证」）。它刻意**只返回 `{at, minutes}`、不返回 DEK** ——
   * 一个会吐密钥的测试钩子迟早会被用到请求路径上去。
   *
   */
  _vaultDebugLockState(uid) {
    const e = unlocked.get(Number(uid));
    return e ? { at: e.at, minutes: e.minutes } : null;
  },

  /**
   * 功能：**仅供测试** —— 把某个账号的解锁记录**标记为已过期**（把 `at` 往回拨到期限之外）。
   *
   * 它**不删记录**（那是 `vaultIsUnlocked()` 的职责）—— 这样测试才能验到
   *
   * @param {number} uid - 账号 id
   */
  _vaultDebugExpire(uid) {
    const e = unlocked.get(Number(uid));
    if (!e) return false;
    e.at = Date.now() - (e.minutes + 1) * 60000;
    return true;
  },

  /**
   * 功能：列出该账号的全部条目 —— **只回摘要，不回密码**（列表页用）。
   *
   * 说明：⭐ 为什么列表里也不给密码：界面上「列表 → 点进去 → 复制」是两步，
   * 把全部密码一次性吐给列表页，等于每打开一次密码库就把它整本摊在内存与网络里，
   * 而用户此刻可能只是在找「那个 GitHub 的账号叫什么」。
   */
  listVaultEntries(uid) {
    const dek = this._vaultDek(uid);
    /** @type {Array.<Object>} */
    const items = [];
    let broken = 0;
    for (const row of this._bk.listVaultItems(Number(uid))) {
      let obj;
      try {
        obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
      } catch (_e) {
        broken += 1;
        items.push({
          id: row.id,
          title: '',
          username: '',
          url: '',
          tags: [],
          // 解不开的那条**算不出**它有没有密码 ⇒ 一律 false。
          // 两句话指的其实是不同的毛病，混在一起用户只会更糊涂。
          blank_password: false,
          broken: true,
          updated_at: row.updated_at,
        });
        continue;
      }
      items.push({
        id: row.id,
        title: String(obj.title || ''),
        username: String(obj.username || ''),
        url: String(obj.url || ''),
        tags: normTags(obj.tags),
        has_note: !!obj.note,
        // 不自动删、不自动改（R-002），只在列表里标一句「这条没设密码」，由用户自己补或删。
        // 它**不进表、不加列**：库里多一列就多一份要维护的真相，
        // 而「空不空」完全由密文里的 `password` 当场算得出来。
        blank_password: isBlankPassword(obj.password),
        broken: false,
        updated_at: row.updated_at,
      });
    }
    return { items, broken, tagPool: this.vaultTagPool(uid) };
  },

  /**
   * 功能：判断某条密码条目是否属于该账号（路由层在「详情 / 编辑 / 删除」前统一用它回 404）。
   *
   * 说明：⭐ 它**不需要解锁**：只比对 `id` 与 `user_id`，不碰任何密文列 ——
   * 所以「未解锁时探某个 id 存不存在」也只会得到 404，不泄露任何条目内容。
   * 路由层把这一步放在「取 DEK」之前，是为了让**越权与不存在**在任何状态下都回同一个 404。
   */
  ownsVaultEntry(uid, id) {
    return this._bk.ownsVaultItem(Number(uid), id);
  },

  /**
   * 功能：要求当前账号处于解锁态（不满足直接抛 403），顺带把解锁态**滑动续期**一次。
   *
   * 「登录 + 已解锁」那一档）—— 它本身不产生任何数据，但把它挂在解锁之后，
   * 「谁能调生成器」就和「谁能看密码」是同一个门槛，不会多出一条独立的判定路径。
   *
   */
  vaultAssertUnlocked(uid) {
    this._vaultDek(uid);
    return true;
  },

  /**
   * 功能：取一条条目的**完整内容**（含密码），供详情页查看 / 复制。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {Object} `{ id, title, username, password, url, note, tags, updated_at }`
   * @throws {Error} 未解锁（403）、条目不存在或不属于本人（404）、密文损坏（500 之外另说，见下）
   */
  getVaultEntry(uid, id) {
    const dek = this._vaultDek(uid);
    const row = this._bk.getVaultItem(Number(uid), id);
    if (!row) throw notFoundErr('这条密码记录');
    let obj;
    try {
      obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
    } catch (_e) {
      // 而真相是「这条记录被改坏了，请从备份恢复」——两者的处置完全不同。
      throw badRequest('这条记录已损坏，解不出内容（可能是数据库被手工改动过，请从备份恢复）');
    }
    return {
      id: row.id,
      title: String(obj.title || ''),
      username: String(obj.username || ''),
      password: String(obj.password || ''),
      url: String(obj.url || ''),
      note: String(obj.note || ''),
      tags: normTags(obj.tags),
      updated_at: row.updated_at,
    };
  },

  /**
   * 功能：新建一条密码条目（整条加密后落库）。
   *
   * 说明：⚠️ 必填的 `password` 由路由层查（`validate.checkVaultItem` 只管「带了就校验」，
   * 与收藏夹的 `url`、硬件的 `name` 同一手法），这样编辑时「只改标题」不会被要求重发密码。
   * IV 由 `vc.encryptJson()` 内部 `randomBytes(12)` 生成，**本层无从指定**（GCM 的 IV 绝不复用）。
   */
  createVaultEntry(uid, item) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const sealed = vc.encryptJson(dek, {
      title: String((item && item.title) || ''),
      username: String((item && item.username) || ''),
      password: String((item && item.password) || ''),
      url: String((item && item.url) || ''),
      note: String((item && item.note) || ''),
      tags: normTags(item && item.tags),
    });
    const stamp = nowStamp();
    const row = this._bk.insertVaultItem(Number(uid), {
      iv: sealed.iv,
      cipher: sealed.cipher,
      tag: sealed.tag,
      sort_order: Number((item && item.sort_order) || 0) || 0,
      created_at: stamp,
      updated_at: stamp,
    });
    return { id: row.id };
  },

  /**
   * 功能：编辑一条条目 —— 只改请求里真的带了的字段，改完**整条重新加密**。
   *
   * 说明：⭐ 「整条重新加密」是刻意的（而不是只改密文里的某一段）：密文是**一整块**，
   * **每次写入都换新 IV**（`vc.encryptJson` 自己生成）—— 复用旧 IV 是 GCM 的致命错误
   * 一条记录都没改到（不属于本人）→ 返回 false，由路由层收口成 404。
   */
  updateVaultEntry(uid, id, patch) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const key = Number(uid);
    const row = this._bk.getVaultItem(key, id);
    if (!row) throw notFoundErr('这条密码记录');
    let cur;
    try {
      cur = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
    } catch (_e) {
      throw badRequest('这条记录已损坏，解不出内容，无法修改（请从备份恢复）');
    }
    const next = {
      title: String(cur.title || ''),
      username: String(cur.username || ''),
      password: String(cur.password || ''),
      url: String(cur.url || ''),
      note: String(cur.note || ''),
      tags: normTags(cur.tags),
    };
    const src = patch && typeof patch === 'object' ? patch : {};
    ['title', 'username', 'password', 'url', 'note'].forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) next[k] = String(src[k] || '');
    });
    // 标签单独处理（它是数组）：**不带 `tags` 键 = 原样保留**，这一条是「改备注别把标签弄丢」的
    // 唯一保障 —— 界面上「只改标题」的那次 PUT 不会带上 tags，落到这里就必须是旧值。
    if (Object.prototype.hasOwnProperty.call(src, 'tags') && src.tags !== undefined) next.tags = normTags(src.tags);
    const sealed = vc.encryptJson(dek, next);
    return this._bk.updateVaultItem(
      key,
      id,
      ['iv', 'cipher', 'tag', 'updated_at'],
      [sealed.iv, sealed.cipher, sealed.tag, nowStamp()],
    );
  },

  /**
   * 功能：删除一条条目（密文行整行删掉）。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  removeVaultEntry(uid, id) {
    this._assertWritable();
    this._vaultDek(uid); // 未解锁不许删（删也是写操作，但它同时需要「证明你在场」）
    return this._bk.deleteVaultItem(Number(uid), id);
  },

  /**
   *
   * 说明：⭐ 标签没有自己的表（它睡在每条记录的密文里），所以「改名」在物理上就是
   */
  vaultRenameTag(uid, from, to) {
    const r = this._vaultRewriteTags(uid, (tags) => tags.map((t) => (t === from ? to : t)));
    // 标签池跟着改名（池里那个名字若还在，不改就会出现「刚建的空标签改完名还在」）——
    // 重名由 `normTags` 去重，正好等于「合并」。
    this._vaultSyncPool(uid, (pool) => pool.map((t) => (t === from ? to : t)));
    return r;
  },

  /**
   *
   * 说明：⚠️ 删标签**不删记录**（与收藏夹「删分类不删书签」同一条语义），
   */
  vaultRemoveTag(uid, name) {
    const r = this._vaultRewriteTags(uid, (tags) => tags.filter((t) => t !== name));
    this._vaultSyncPool(uid, (pool) => pool.filter((t) => t !== name));
    return r;
  },

  /**
   *
   * 说明：⭐⭐ 池子**也是一份密文**（`vault_meta.tags_*`，用同一把 DEK 加解密），
   */
  vaultTagPool(uid) {
    const dek = this._vaultDek(uid);
    const meta = this._bk.getVaultMeta(Number(uid));
    if (!meta || !meta.tags_cipher) return [];
    try {
      const obj = vc.decryptJson(dek, { iv: meta.tags_iv, cipher: meta.tags_cipher, tag: meta.tags_tag });
      return normTags(obj && obj.tags);
    } catch (_e) {
      return [];
    }
  },

  /**
   *
   * 说明：⭐ 这是密码库唯一一处「建出来时还没有任何记录用到它」的标签 —— 与随手记 / 收藏夹
   */
  vaultAddTag(uid, name) {
    this._assertWritable();
    const key = Number(uid);
    if (!this._bk.getVaultMeta(key)) throw badRequest('这个账号还没有设置主密码，请先设置');
    const before = this.vaultTagPool(uid);
    if (before.includes(name)) return { ok: true, name, added: false };
    if (before.length >= MAX_TAGS) throw badRequest(`标签最多 ${MAX_TAGS} 个`);
    this._vaultSyncPool(uid, (pool) => pool.concat([name]));
    return { ok: true, name, added: true };
  },

  /**
   * 功能：把标签池整体改一遍并写回 —— 改名 / 删除 / 新建三条路径的**唯一写入点**。
   *
   * 说明：⚠️ 三列**一起写**（`iv` / `cipher` / `tag`）：单独换一个 `iv` 而不同时换密文
   * 会把这份清单直接毁掉（与 `vault_items` 那三列同一条纪律）。
   * 没变化就不写（省一次磁盘写，也少一次无谓的密文重排）。
   */
  _vaultSyncPool(uid, mutate) {
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) return;
    const dek = this._vaultDek(uid);
    const before = this.vaultTagPool(uid);
    const after = normTags(mutate(before));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const sealed = vc.encryptJson(dek, { tags: after });
    this._bk.updateVaultMeta(key, ['tags_iv', 'tags_cipher', 'tags_tag'], [sealed.iv, sealed.cipher, sealed.tag]);
  },

  /**
   * 功能：标签批量改写的**唯一实现** —— 「先全部解密成内存里的新值，全部成功之后再逐条写回」。
   *
   * 说明：⭐⭐ 这个两段式结构是刻意的，别把它改成「一边解密一边写」：
   * 第一段只读、只算，**任何一条解不开就整块抛 400**，一行都不写 ——
   * 他会以为「什么都没发生」；
   */
  _vaultRewriteTags(uid, mutate) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const key = Number(uid);

    // ---- 第一段：只读只算，全部成功才算数 ----
    /** @type {Array.<{id: number, payload: Object}>} */
    const plans = [];
    for (const row of this._bk.listVaultItems(key)) {
      let obj;
      try {
        obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
      } catch (_e) {
        // 明确说「一行都没改」：用户接下来该做的是恢复那条记录，而不是再点一次
        throw badRequest('有一条记录已损坏（内容解不开），标签暂时改不了 —— 请先从备份恢复那条记录，一行都没有改动');
      }
      const before = normTags(obj.tags);
      const after = normTags(mutate(before));
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      plans.push({
        id: row.id,
        payload: {
          title: String(obj.title || ''),
          username: String(obj.username || ''),
          password: String(obj.password || ''),
          url: String(obj.url || ''),
          note: String(obj.note || ''),
          tags: after,
        },
      });
    }

    // ---- 第二段：逐条写回（新密文已算好，每条一个新 IV）----
    let changed = 0;
    for (const p of plans) {
      const sealed = vc.encryptJson(dek, p.payload);
      const ok = this._bk.updateVaultItem(
        key,
        p.id,
        ['iv', 'cipher', 'tag', 'updated_at'],
        [sealed.iv, sealed.cipher, sealed.tag, nowStamp()],
      );
      if (ok) changed += 1;
    }
    return { changed };
  },

  /**
   * 功能：用一个账号的 DEK 把一份**明文对象**封装成密文三列 —— 给 `secrets` 模块（加密信息）用。
   *
   * 而不是另起一套主密码。理由是产品性的：两者在界面上是同一屏的两格
   * （网址 ｜ 密码 ｜ 加密信息），用户心里就是「一个保险箱」；再让他记一个主密码是纯负担，
   * 而且**必然有人忘**（忘了就是一个永久打不开的库）。
   */
  sealForUser(uid, obj) {
    const dek = this._vaultDek(uid);
    return vc.encryptJson(dek, obj && typeof obj === 'object' ? obj : {});
  },

  /**
   * 功能：用一个账号的 DEK 把**一行密文**解回明文对象 —— 给 `secrets` 模块（加密信息）用。
   *
   * 说明：与 `sealForUser()` 是同一对（理由见上）。⚠️ 解不开时**不冒充 404**：
   * 由调用方决定怎么说（`secrets` 那边照 `getVaultEntry()` 的口径回 400「已损坏，请从备份恢复」），
   * 这里只把原语层的错误原样抛出去 —— 本方法不替调用方编用户话术。
   */
  openForUser(uid, row) {
    const dek = this._vaultDek(uid);
    const src = row && typeof row === 'object' ? row : {};
    return vc.decryptJson(dek, { iv: src.iv, cipher: src.cipher, tag: src.tag });
  },

  /**
   * 功能：用该账号的 DEK 加密**一段字节**（带 AAD）—— 给 `secrets` 的附件分块加密用。
   *
   * AAD（头 ‖ 块序号 ‖ 总块数）。这一层只做「`_vaultDek(uid)` ＋ 转手」，**DEK 不出 vault** ——
   * `secrets` 拿到的永远只是三件字节。
   * 与 `sealForUser()` 是同一道闸门（`_vaultDek` 未解锁抛 403），所以「锁上密码库 =
   */
  sealBytes(uid, buf, aad) {
    const dek = this._vaultDek(uid);
    return vc.encryptBytes(dek, buf, aad);
  },

  /**
   * 功能：用该账号的 DEK 解密**一段字节**（AAD 必须与加密时逐字节相同）—— `sealBytes()` 的逆运算。
   *
   * 说明：⚠️ **只解调用方点名的那一块** —— 视频拖进度时不需要从头解下来，
   *
   * @param {number} uid - 账号 id
   */
  openBytes(uid, parts, aad) {
    const dek = this._vaultDek(uid);
    const src = parts && typeof parts === 'object' ? parts : {};
    return vc.decryptBytes(dek, src.iv, src.tag, src.cipher, aad);
  },

  // ==========================================================================================
  //
  // 这一组方法解决的是「换机器 / 账号被删之后还能打开 .zxdesk」：

  /**
   * 功能：导出钥匙文件的内容（**不落盘**，由路由层包成下载）。
   *
   * 返回的 JSON 里**没有明文密钥**：`dek_*` / `verifier_*` 都是用 KEK 封装过的材料，
   * `kid` 只是指纹。它等于「全套数据的总钥匙」—— 文案必须写清这一点（§8.6）。
   * `created_at` 用本地时区偏移（给人看），不是 `toISOString()` 的 UTC。
   */
  keyExport(uid, masterPassword) {
    this.vaultAssertUnlocked(uid);
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) throw badRequest('这个账号还没有设置主密码，没有钥匙可以导出');
    const params = vc.parseKdfParams(meta.kdf_params);
    const salt = Buffer.from(String(meta.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这个密码库的盐已损坏，无法导出钥匙（请从备份恢复）');
    const kek = vc.deriveKek(masterPassword, salt, params);
    if (!vc.checkVerifier(kek, { iv: meta.verifier_iv, cipher: meta.verifier_cipher, tag: meta.verifier_tag })) {
      throw denied('主密码不正确');
    }
    const dek = vc.openDek(kek, { iv: meta.dek_iv, cipher: meta.dek_cipher, tag: meta.dek_tag });
    const u = this.getUser(key) || {};
    return {
      app: 'zxdesk',
      v: 1,
      kind: 'vault-key',
      kid: kidOf(dek),
      owner_uid: key,
      owner_name: String(u.username || ''),
      kdf: 'scrypt',
      kdf_params: { N: params.N, r: params.r, p: params.p, keylen: params.keylen },
      salt: String(meta.salt),
      dek_iv: String(meta.dek_iv),
      dek_cipher: String(meta.dek_cipher),
      dek_tag: String(meta.dek_tag),
      verifier_iv: String(meta.verifier_iv),
      verifier_cipher: String(meta.verifier_cipher),
      verifier_tag: String(meta.verifier_tag),
      created_at: isoLocal(),
    };
  },

  /**
   * 功能：**看一眼**一份钥匙文件属于谁（⛔ 不验密码、不落库、不回任何密钥材料）。
   *
   * 「选文件 → 识别 → 输密码解锁」三步，第 2 步要能告诉用户
   * 并在「钥匙属于 A、文件属于 B」时先提醒一句「可能打不开」。
   * @param {number} uid - 当前会话账号 id（只用于判「本机是否已有这把」）
   */
  keyInspect(uid, obj) {
    const p = parseKeyFile(obj);
    return {
      kid: p.kid,
      owner_uid: p.owner_uid,
      owner_name: p.owner_name,
      created_at: p.created_at,
      already: !!this._bk.getImportedKey(Number(uid), p.kid),
    };
  },

  /**
   * 功能：导入一份钥匙文件（校验 6 条，通过后落库并**当场把这把钥匙打开**）。
   *
   * 格式不对 → 「不是一个有效的钥匙文件」；字段缺 → 「不完整」；参数越界 →
   * 「参数不合法」；验证块解不开 → 「主密码不对」；DEK 解不开 → 「已损坏」。
   * 分成五句不是为了好看：它们的处置完全不同（换文件 / 找回原文件 / 找对方重导 / 重输密码）。
   */
  keyImport(uid, obj, masterPassword) {
    this._assertWritable();
    const key = Number(uid);
    // （两处各写一遍的失效方式：一边放宽了一边没放宽 ⇒ 「识别通过但导入说不是钥匙文件」）
    const p = parseKeyFile(obj);
    const str = (v) => String(v == null ? '' : v);
    const o = p.obj;
    const salt = p.salt;
    const params = p.params;
    const kek = vc.deriveKek(masterPassword, salt, params);
    if (!vc.checkVerifier(kek, { iv: str(o.verifier_iv), cipher: str(o.verifier_cipher), tag: str(o.verifier_tag) })) {
      throw denied('这个钥匙文件的主密码不对');
    }
    let dek;
    try {
      dek = vc.openDek(kek, { iv: str(o.dek_iv), cipher: str(o.dek_cipher), tag: str(o.dek_tag) });
    } catch (_e) {
      throw badRequest('钥匙文件已损坏，无法使用');
    }
    const kid = kidOf(dek);
    // 文件里带的 `kid` 与现算不一致 ⇒ 有人在改这个文件（或拼错了另一把钥匙的材料）
    if (str(o.kid) !== kid) throw badRequest('钥匙文件已损坏，无法使用');

    const ownerUid = p.owner_uid;
    const ownerName = p.owner_name;
    const existed = !!this._bk.getImportedKey(key, kid);
    if (!existed) {
      const stamp = nowStamp();
      this._bk.insertImportedKey(key, {
        kid,
        owner_uid: ownerUid,
        owner_name: ownerName,
        kdf: 'scrypt',
        kdf_params: JSON.stringify({ N: params.N, r: params.r, p: params.p, keylen: params.keylen }),
        salt: str(o.salt),
        dek_iv: str(o.dek_iv),
        dek_cipher: str(o.dek_cipher),
        dek_tag: str(o.dek_tag),
        verifier_iv: str(o.verifier_iv),
        verifier_cipher: str(o.verifier_cipher),
        verifier_tag: str(o.verifier_tag),
        created_at: stamp,
        last_used_at: stamp,
      });
    }
    this.readerHold(key, kid, dek, ownerUid);
    return { kid, owner_uid: ownerUid, owner_name: ownerName, already: existed };
  },

  /**
   * @param {number} uid - 账号 id
   * @returns {Array.<{kid: string, owner_uid: ?number, owner_name: string, created_at: ?string, last_used_at: ?string}>}
   */
  listImportedKeys(uid) {
    return this._bk.listImportedKeys(Number(uid)).map((r) => ({
      kid: String(r.kid),
      owner_uid: r.owner_uid == null ? null : Number(r.owner_uid),
      owner_name: String(r.owner_name || ''),
      created_at: r.created_at || null,
      last_used_at: r.last_used_at || null,
    }));
  },

  /**
   * 功能：删掉一条导入记录（只删数据库那一行，⛔ 不碰任何文件、不影响别人）。
   * @param {number} uid - 账号 id
   * @param {string} kid - 钥匙编号
   * @returns {{ok: true, removed: boolean}} 结果
   * @throws {Error} 数据层只读（503）
   */
  removeImportedKey(uid, kid) {
    this._assertWritable();
    const key = Number(uid);
    const removed = this._bk.deleteImportedKey(key, String(kid));
    this.readerDrop(key, String(kid));
    return { ok: true, removed };
  },

  /**
   * 功能：列出「打开这个文件可以试哪些钥匙」（**只报编号与来源，不报材料**）。
   *
   * ① 文件属于本账号且密码库已解锁 ⇒ 用**会话 DEK**（不弹密码）；
   * ② 本账号亲手导入过的钥匙（`owner_uid` 与文件对得上的排前面）。
   * 这里**不判断「能不能开」**：`.zxdesk` 头里没有 `kid`（格式一个字不改），
   */
  readerCandidates(uid, fileUid) {
    const key = Number(uid);
    const own = Number(fileUid) === key;
    const unlockedNow = peekUnlocked(key);
    const sessionKid = own && unlockedNow ? kidOf(unlocked.get(key).dek) : '';
    /** @type {Array.<Object>} */
    const keys = [];
    for (const r of this.listImportedKeys(key)) {
      keys.push(
        Object.assign({}, r, {
          held: readerKeys.has(readerSlot(key, r.kid)),
          matches: r.owner_uid != null && Number(r.owner_uid) === Number(fileUid),
        }),
      );
    }
    // 「来源对得上」的排前面（只是建议，不是判断）；同组内保持「新的在前」
    keys.sort((a, b) => Number(b.matches) - Number(a.matches));
    return { sessionKid, sessionHeld: !!sessionKid, keys };
  },

  /**
   * 功能：用一把**导入的钥匙**的主密码打开它，把 DEK 放进 `readerKeys`（10 分钟滑动）。
   *
   * 不解锁任何账号的会话（不碰 `unlocked`）—— 于是「看了别人的文件」不等于
   * 「拿到了别人的密码库」。
   * 失败只有一句「主密码不正确」（不区分密码错与密文损坏）：那种区分等于白送一个探测口。
   */
  readerDerive(uid, kid, masterPassword) {
    const key = Number(uid);
    const row = this._bk.getImportedKey(key, String(kid));
    if (!row) throw badRequest('本机没有这把钥匙 —— 请先导入它的钥匙文件');
    let params;
    try {
      params = vc.parseKdfParams(row.kdf_params);
    } catch (_e) {
      throw badRequest('这把钥匙的参数已损坏，请重新导入钥匙文件');
    }
    const salt = Buffer.from(String(row.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这把钥匙的盐已损坏，请重新导入钥匙文件');
    const kek = vc.deriveKek(masterPassword, salt, params);
    if (!vc.checkVerifier(kek, { iv: row.verifier_iv, cipher: row.verifier_cipher, tag: row.verifier_tag })) {
      throw denied('主密码不正确');
    }
    const dek = vc.openDek(kek, { iv: row.dek_iv, cipher: row.dek_cipher, tag: row.dek_tag });
    this.readerHold(key, String(kid), dek, row.owner_uid == null ? null : Number(row.owner_uid));
    return {
      kid: String(kid),
      owner_uid: row.owner_uid == null ? null : Number(row.owner_uid),
      owner_name: String(row.owner_name || ''),
    };
  },

  /**
   * 功能：把一把已开的钥匙放进内存表并挂到期定时器（`keyImport()` / `readerDerive()` 共用）。
   *
   * 说明：⚠️ 定时器必须 `unref()`（与 `_vaultHold()` 同一条理由：不 unref 会拖住事件循环，
   * 真机上表现为「点了停止应用，进程却一直不退出」）。
   * 上限 8 把、超了淘汰**最久没动**的那把：内存里同时躺着十几把 DEK 没有任何好处。
   */
  readerHold(uid, kid, dek, ownerUid) {
    const key = readerSlot(uid, kid);
    const old = readerKeys.get(key);
    if (old && old.timer) clearTimeout(old.timer);
    readerKeys.set(key, {
      dek,
      ownerUid: ownerUid == null ? null : Number(ownerUid),
      at: Date.now(),
      timer: scheduleReaderDrop(key),
    });
    while (readerKeys.size > READER_MAX) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const [k, v] of readerKeys) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldest = k;
        }
      }
      if (!oldest) break;
      this.readerDrop(...splitSlot(oldest));
    }
  },

  /**
   * 功能：取一把已开钥匙的 DEK（**顺带滑动续期**）；没开或已超时一律 403。
   * @param {number} uid - 会话账号 id
   * @param {string} kid - 钥匙编号
   * @returns {Buffer} 32 字节 DEK
   * @throws {Error} 这把钥匙还没打开 / 已超时（403）
   */
  readerDek(uid, kid) {
    const key = readerSlot(uid, kid);
    const e = readerKeys.get(key);
    if (!e) throw denied('这把钥匙还没打开 —— 请输入它的主密码');
    if (Date.now() - e.at > READER_IDLE_MS) {
      this.readerDrop(Number(uid), String(kid));
      throw denied('这把钥匙已经自动锁上了 —— 请重新输入主密码');
    }
    e.at = Date.now();
    if (e.timer) clearTimeout(e.timer);
    e.timer = scheduleReaderDrop(key);
    return e.dek;
  },

  /**
   * 功能：判断某个会话账号手上**有没有**这把已开的钥匙（只判断，不续期）。
   * @param {number} uid - 会话账号 id
   * @param {string} kid - 钥匙编号
   * @returns {boolean} 在内存表里且没超时则为 true
   */
  readerHas(uid, kid) {
    const e = readerKeys.get(readerSlot(uid, kid));
    if (!e) return false;
    if (Date.now() - e.at > READER_IDLE_MS) {
      this.readerDrop(Number(uid), String(kid));
      return false;
    }
    return true;
  },

  /**
   * 功能：用**指定的那把钥匙**解一段附件字节 —— 阅读器的流式解密出口。
   *
   * 说明：⭐ 与 `openBytes()` 的唯一差别是「密钥从哪来」：那个用**会话 DEK**（本账号已解锁），
   * 这个用 `readerKeys` 里那把导入钥匙的 DEK。⛔ 两者都不把 DEK 交出去。
   * @param {number} uid - 会话账号 id
   */
  openBytesAs(uid, kid, parts, aad) {
    const dek = this.readerDek(uid, kid);
    const src = parts && typeof parts === 'object' ? parts : {};
    return vc.decryptBytes(dek, src.iv, src.tag, src.cipher, aad);
  },

  /**
   * 功能：把一把（或某账号的全部）已开钥匙从内存里拿掉。
   * @param {number} uid - 会话账号 id
   * @param {?string} kid - 钥匙编号；不传 = 该账号全部
   * @returns {void}
   */
  readerDrop(uid, kid) {
    if (kid === undefined || kid === null) {
      for (const k of [...readerKeys.keys()]) {
        const [u] = splitSlot(k);
        if (u === Number(uid)) {
          const e = readerKeys.get(k);
          if (e && e.timer) clearTimeout(e.timer);
          readerKeys.delete(k);
        }
      }
      return;
    }
    const k = readerSlot(uid, kid);
    const e = readerKeys.get(k);
    if (e && e.timer) clearTimeout(e.timer);
    readerKeys.delete(k);
  },

  /**
   * 功能：清空**全部**已开钥匙（退出登录 / 测试清场用）。
   * @returns {number} 清掉的把数
   */
  readerPurgeAll() {
    const n = readerKeys.size;
    for (const k of [...readerKeys.keys()]) {
      const e = readerKeys.get(k);
      if (e && e.timer) clearTimeout(e.timer);
    }
    readerKeys.clear();
    return n;
  },

  /**
   * 功能：**仅供测试** —— 看当前有几把已开钥匙（⛔ 不返回任何密钥）。
   * @returns {number} 把数
   */
  readerDebugCount() {
    return readerKeys.size;
  },

  /**
   * 功能：生成一个强随机密码（密码生成器）。
   *
   * 说明：⚠️ 参数校验在 `validate.js` 做过一遍（给得出人话的 400），这里再兜一次
   *
   * @param {Object} opts - `{ length?, charset?, noAmbiguous? }`
   */
  generateVaultPassword(opts) {
    try {
      return { password: vc.generatePassword(opts || {}) };
    } catch (e) {
      throw badRequest((e && e.message) || '生成参数不合法');
    }
  },
};

/**
 * 功能：给某个账号挂一个「到期就把解锁记录删掉」的定时器。
 *
 * 说明：⭐ 必须 `unref()`：不 unref 的定时器会拖住事件循环，真机上表现为
 * 「点了停止应用，进程却一直不退出」。⚠️ 它只是**尽早释放引用**的优化，
 * 正确性由 `vaultIsUnlocked()` 里的时间比对兜底（定时器可能晚触发）。
 */
function scheduleDrop(uid, minutes) {
  // 为什么不在 `dropUnlocked()` 里做：`_vaultHold()`（重新解锁）也调它 ——
  // 那样每次解锁都会把阅读器已开的钥匙一起清掉，用户会看到「刚输过密码又失效」。
  const t = setTimeout(() => {
    dropUnlocked(uid);
    purgeReaderKeys(uid);
  }, Math.max(1, minutes) * 60000);
  if (typeof t.unref === 'function') t.unref();
  return t;
}
