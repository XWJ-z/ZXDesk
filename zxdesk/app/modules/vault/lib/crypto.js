'use strict';
/**
 * modules/vault/lib/crypto.js —— 密码库的**密码学原语层**
 * 功能：把密码库用到的全部密码学操作收在一个**纯函数模块**里 ——
 * `deriveKek()`（scrypt 派生主密钥）、`newDek()`（生成数据密钥）、
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md、docs/公共/调研报告/04-密码库-加密存储.md
 */

const crypto = require('node:crypto');

/**
 * scrypt 的**默认**成本参数（方案/ 决策十三-4：`N=2^17, r=8, p=1`）。
 *
 */
const KDF_DEFAULT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

/** 盐长度（字节）：16 B 随机，随库存 base64 @type {number} */
const SALT_BYTES = 16;

/** GCM 的 IV 长度（字节）：12 B 是 GCM 的推荐长度（方案 §5.3 硬要求 2） @type {number} */
const IV_BYTES = 12;

/** GCM 认证标签长度（字节） @type {number} */
const TAG_BYTES = 16;

/** 数据密钥（DEK）与主密钥（KEK）的长度：32 B = AES-256 @type {number} */
const KEY_BYTES = 32;

/**
 * 验证块的固定明文。
 *
 */
const VERIFIER_PLAINTEXT = 'zxdesk-vault-v1';

/** GCM 的算法名（AES-256 由 keylen 决定，密钥必须是 32 B） @type {string} */
const CIPHER = 'aes-256-gcm';

/**
 * 密码生成器的字符集。
 *
 */
const PASSWORD_CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!#%&*+-=?@^_~',
};

/**
 * 生成器允许的字符集档位 —— `'letters'` / `'alnum'` / `'all'` 三档（白名单，不认识的一律拒）。
 *
 */
const PASSWORD_PRESETS = {
  letters: ['upper', 'lower'],
  alnum: ['upper', 'lower', 'digits'],
  all: ['upper', 'lower', 'digits', 'symbols'],
};

/**
 * 功能：构造一个「密码学操作失败」的错误。
 *
 * 说明：⚠️ 错误信息**刻意只有一句话、不带任何细节**（不说差在哪一位、不说长度）——
 * 解密失败的细节本身就是一条侧信道，而调用方（业务层）只会把它转成「主密码不正确」或
 * 「这条记录已被损坏」，多说的每一个字都是白送的信息。
 */
function cryptoError(message) {
  return new Error(message);
}

/**
 * 功能：校验一组 scrypt 参数是否「能被 `scryptSync` 跑通」—— 不合格直接抛错。
 *
 * 说明：⭐ 这道闸门的存在理由是**防御性**：`kdf_params` 是从库里读出来的 JSON，
 * 理论上可能被手工改过（或来自将来的版本）。把一组 `N = 0` 直接喂给 `scryptSync`
 * 的表现是抛一个底层错误、或者（更糟）`N = 1` 时几乎不花时间就派生出「密钥」，
 */
function normalizeKdfParams(p) {
  const src = p && typeof p === 'object' ? p : {};
  const N = Number(src.N);
  const r = Number(src.r);
  const par = Number(src.p);
  const keylen = Number(src.keylen == null ? KEY_BYTES : src.keylen);
  const maxmem = Number(src.maxmem == null ? KDF_DEFAULT.maxmem : src.maxmem);
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) {
    throw cryptoError('KDF 参数 N 必须是大于 1 的 2 的幂');
  }
  if (!Number.isInteger(r) || r < 1) throw cryptoError('KDF 参数 r 必须是正整数');
  if (!Number.isInteger(par) || par < 1) throw cryptoError('KDF 参数 p 必须是正整数');
  if (!Number.isInteger(keylen) || keylen < 16 || keylen > 64) throw cryptoError('KDF 参数 keylen 不合法');
  if (128 * N * r > maxmem) throw cryptoError('KDF 参数超出内存上限');
  return { N, r, p: par, keylen, maxmem };
}

/**
 * 功能：把库里存的 `kdf_params`（JSON 文本或对象）解析成一组可用参数；坏了就抛错。
 *
 * 说明：⚠️ 解析失败**必须抛**、绝不能「兜底用默认参数」：那样会用一套与原库不同的参数去派生 KEK，
 * 结果是「主密码明明是对的，却永远解不开」，而用户得到的提示是「主密码不正确」——
 * 一个无法自证的死循环。宁可明确报「这个密码库的参数已损坏」。
 */
function parseKdfParams(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      throw cryptoError('密码库的 KDF 参数已损坏');
    }
  }
  return normalizeKdfParams(obj);
}

/**
 * 功能：生成一个随机盐（16 B）。
 * @returns {Buffer} 随机盐字节
 */
function newSalt() {
  return crypto.randomBytes(SALT_BYTES);
}

/**
 * 功能：生成一个数据密钥（DEK，32 B 随机）。
 *
 * 改主密码只需用新 KEK 重新封装这 32 字节，**不必重加密整库条目**（方案）。
 *
 * @returns {Buffer} 32 字节随机密钥
 */
function newDek() {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * 功能：用主密码与盐派生 KEK（32 B）—— scrypt。
 *
 * 说明：⚠️ `scryptSync` **阻塞事件循环**（与 `auth.js` 的 `hashPassword` 同一性质）。
 * 解锁是低频操作、且密码库操作本来就串行，暂时可接受；若将来并发解锁变多，
 * 须换成异步 `crypto.scrypt`（与 `auth.js` 的待办一致，见 `AGENTS.md` §七-6）。
 */
function deriveKek(masterPassword, salt, params) {
  const p = normalizeKdfParams(params);
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt == null ? '' : salt), 'base64');
  // 这里**刻意不设「盐不能太短」的下限**：scrypt 本身接受任意长度（含空）的盐，
  // 而「盐必须 ≥ 8 字节」是**已入库的密码库应当长什么样**这条业务约束，
  // 它属于 `modules/vault/store.js`（那边读 `vault_meta` 时校验），不属于原语层。
  return crypto.scryptSync(String(masterPassword == null ? '' : masterPassword), saltBuf, p.keylen, {
    N: p.N,
    r: p.r,
    p: p.p,
    maxmem: p.maxmem,
  });
}

/**
 * 功能：用一把 32 B 密钥加密一段字节 —— AES-256-GCM，**每次调用都新生成随机 IV**。
 *
 * 说明：⭐ 返回的是四个字段而不是一个拼接串：库里就是四列（`iv` / `cipher` / `tag`），
 * 拼接成 `iv:cipher:tag` 再在读出侧切开只会多一次可能切错的机会，换不来任何好处。
 * 所以这里没有「让我指定 IV」的入口 —— IV 只能由本函数生成。
 */
function seal(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw cryptoError('密钥长度必须是 32 字节');
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(CIPHER, key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const cipher = Buffer.concat([c.update(data), c.final()]);
  return {
    iv: iv.toString('base64'),
    cipher: cipher.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

/**
 * 功能：用一把 32 B 密钥解密 `{iv, cipher, tag}` —— **tag 校验失败一律抛错**，绝不返回任何数据。
 *
 * 它的价值全在 `setAuthTag()` + `final()` 会把「被改过一个字节的密文」判为失败。
 * 如果这里 catch 掉错误、返回空串或 null，那么「密文被篡改」就变成了「这条记录是空的」——
 * 用户看到的是一条空密码，而实际发生的是**有人动过这个库**。
 */
function open(key, parts) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw cryptoError('密钥长度必须是 32 字节');
  const src = parts || {};
  const iv = Buffer.from(String(src.iv == null ? '' : src.iv), 'base64');
  const tag = Buffer.from(String(src.tag == null ? '' : src.tag), 'base64');
  const cipher = Buffer.from(String(src.cipher == null ? '' : src.cipher), 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw cryptoError('密文格式不合法');
  const d = crypto.createDecipheriv(CIPHER, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]);
}

/**
 * 功能：用 KEK 封装 DEK（信封加密的外层）。
 * @param {Buffer} kek - 32 字节主密钥
 * @param {Buffer} dek - 32 字节数据密钥
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段（写进 `vault_meta`）
 */
function sealDek(kek, dek) {
  return seal(kek, dek);
}

/**
 * 功能：用 KEK 解开 DEK。
 * @param {Buffer} kek - 32 字节主密钥
 * @param {{iv: string, cipher: string, tag: string}} parts - `vault_meta` 里的 dek_iv / dek_cipher / dek_tag
 * @returns {Buffer} 32 字节 DEK
 * @throws {Error} 主密码不对（KEK 不匹配）或密文被篡改时抛出
 */
function openDek(kek, parts) {
  const dek = open(kek, parts);
  if (dek.length !== KEY_BYTES) throw cryptoError('数据密钥长度不对');
  return dek;
}

/**
 * 功能：用 KEK 生成验证块（加密固定明文）。
 * @param {Buffer} kek - 32 字节主密钥
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段（写进 `vault_meta`）
 */
function makeVerifier(kek) {
  return seal(kek, VERIFIER_PLAINTEXT);
}

/**
 * 功能：校验主密码 —— 用 KEK 解验证块，看是不是那一串固定明文。
 * @param {Buffer} kek - 由候选主密码派生出的 32 字节密钥
 * @param {{iv: string, cipher: string, tag: string}} parts - `vault_meta` 里的 verifier_* 三列
 * @returns {boolean} 主密码正确返回 true；**任何异常一律 false**（与「解密失败」不可区分）
 */
function checkVerifier(kek, parts) {
  try {
    return open(kek, parts).toString('utf8') === VERIFIER_PLAINTEXT;
  } catch (_e) {
    // 这里刻意吞掉异常并返回 false：调用方只需要「对 / 不对」，
    return false;
  }
}

/**
 * 功能：把一条明文条目加密成可落库的四元组（整条加密，**连标题也不明文落库** —— 方案）。
 * @param {Buffer} dek - 32 字节数据密钥
 * @param {Object} item - 明文条目对象（`{title, username, password, url, note}`）
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段
 */
function encryptJson(dek, item) {
  return seal(dek, JSON.stringify(item == null ? {} : item));
}

/**
 * 功能：解密一条条目；失败（主密码错 / 密文被篡改 / JSON 坏了）一律抛错，不返回半条数据。
 * @param {Buffer} dek - 32 字节数据密钥
 * @param {{iv: string, cipher: string, tag: string}} parts - `vault_items` 的三列
 * @returns {Object} 明文条目对象
 * @throws {Error} 解密或解析失败时抛出
 */
function decryptJson(dek, parts) {
  const text = open(dek, parts).toString('utf8');
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_e) {
    throw cryptoError('条目内容解密后不是合法 JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw cryptoError('条目内容结构不对');
  return obj;
}

/**
 *
 * 说明：⭐⭐ 与 `seal()` 的差别有两处，都是为附件准备的：
 */
function encryptBytes(dek, buf, aad) {
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw cryptoError('密钥长度必须是 32 字节');
  if (!Buffer.isBuffer(buf)) throw cryptoError('待加密内容必须是 Buffer');
  if (!Buffer.isBuffer(aad)) throw cryptoError('AAD 必须是 Buffer（没有就传 Buffer.alloc(0)）');
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(CIPHER, dek, iv);
  if (aad.length) c.setAAD(aad);
  const cipher = Buffer.concat([c.update(buf), c.final()]);
  return { iv, tag: c.getAuthTag(), cipher };
}

/**
 * 功能：用 DEK 解密**一段字节**（AAD 与加密时逐字节相同）—— `encryptBytes()` 的逆运算。
 *
 * 说明：⚠️ **tag 校验失败一律抛错，绝不返回半份/空 Buffer**：附件是「读出来就要发给浏览器」的东西，
 * 入参三件必须是 Buffer 且长度合法（12 / 16 / 任意）：`Buffer.from(string)` 会把
 * 一个拼错的字符串默默变成 0 长度，于是错误信息变成「密文格式不合法」，掩盖真正的原因。
 */
function decryptBytes(dek, iv, tag, cipher, aad) {
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw cryptoError('密钥长度必须是 32 字节');
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) throw cryptoError('密文格式不合法（iv）');
  if (!Buffer.isBuffer(tag) || tag.length !== TAG_BYTES) throw cryptoError('密文格式不合法（tag）');
  if (!Buffer.isBuffer(cipher)) throw cryptoError('密文格式不合法（cipher）');
  if (!Buffer.isBuffer(aad)) throw cryptoError('AAD 必须是 Buffer（没有就传 Buffer.alloc(0)）');
  const d = crypto.createDecipheriv(CIPHER, dek, iv);
  if (aad.length) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]);
}

/**
 *
 * 说明：⭐ 三条刻意的做法：
 */
function generatePassword(opts) {
  const o = opts || {};
  const length = Number(o.length == null || o.length === '' ? 16 : o.length);
  if (!Number.isInteger(length) || length < 8 || length > 128) throw cryptoError('密码长度应在 8 到 128 之间');
  const names = PASSWORD_PRESETS[String(o.charset == null || o.charset === '' ? 'all' : o.charset)];
  if (!names) throw cryptoError('字符集只能是 letters / alnum / all');
  const strip = o.noAmbiguous ? /[0O1lI|]/g : null;

  const pools = names
    .map((n) => (strip ? PASSWORD_CHARSETS[n].replace(strip, '') : PASSWORD_CHARSETS[n]))
    .filter((s) => s.length > 0);
  const all = pools.join('');
  if (!all) throw cryptoError('字符集是空的');

  /** @type {Array.<string>} */
  const out = [];
  // ① 每个字符类保底一个（长度不够时按长度截断，例如 length=8 而选了 4 类也放得下）
  for (const pool of pools) {
    if (out.length >= length) break;
    out.push(pool[crypto.randomInt(pool.length)]);
  }
  // ② 其余位置从并集里均匀取
  while (out.length < length) out.push(all[crypto.randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out.join('');
}

module.exports = {
  KDF_DEFAULT,
  SALT_BYTES,
  IV_BYTES,
  TAG_BYTES,
  KEY_BYTES,
  CIPHER,
  VERIFIER_PLAINTEXT,
  PASSWORD_CHARSETS,
  PASSWORD_PRESETS,
  normalizeKdfParams,
  parseKdfParams,
  newSalt,
  newDek,
  deriveKek,
  seal,
  open,
  sealDek,
  openDek,
  makeVerifier,
  checkVerifier,
  encryptJson,
  decryptJson,
  // 附件分块加密用的**字节级**原语（与 JSON 那两个同源，只是不过 JSON）
  encryptBytes,
  decryptBytes,
  generatePassword,
};
