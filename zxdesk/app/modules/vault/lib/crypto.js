'use strict';
/**
 * modules/vault/lib/crypto.js —— 密码库的**密码学原语层**（0.3.2）
 *
 * 功能：把密码库用到的全部密码学操作收在一个**纯函数模块**里 ——
 *      `deriveKek()`（scrypt 派生主密钥）、`newDek()`（生成数据密钥）、
 *      `sealDek()` / `openDek()`（用 KEK 信封加密 / 解开 DEK）、
 *      `makeVerifier()` / `checkVerifier()`（验证块：GCM 解密成功即主密码正确）、
 *      `encryptJson()` / `decryptJson()`（整条条目的加解密）、
 *      `generatePassword()`（密码生成器）、`normalizeKdfParams()` / `parseKdfParams()`（参数读写）。
 *      另导出 `KDF_DEFAULT` / `VERIFIER_PLAINTEXT` / `PASSWORD_CHARSETS` 等常量。
 *
 * ⭐ **为什么单独一个文件**：密码学代码必须是**可单独测试**的（方案 §五-7 要求「实现前独立安全评审」，
 *    评审要能只读这 300 行就下结论，不必穿过业务逻辑）。本模块**不认识数据库、不认识 HTTP、
 *    不认识 uid** —— 输入输出全是 Buffer / 普通对象，所以它同时被业务方法与测试直接调用。
 *
 * ⭐ **只用 `node:crypto`**（方案 §5.3 硬要求 1 + 铁律 5：零运行时依赖）：
 *    scrypt 是 Node 内置的、AES-256-GCM 也是。**不存在**任何「先 npm i 一个密码学库」的选项。
 *
 * ⚠️ 四条不能踩的红线（方案 §5.3）：
 *   ① **IV 绝不复用** —— 每次加密都 `randomBytes(12)` 新生成；更新条目时**重新生成**，不复用旧 IV；
 *   ② **GCM tag 必须校验** —— 解密时 `setAuthTag()`；校验失败必须**抛错**，不得返回任何数据；
 *   ③ **主密码 / DEK / 明文绝不落日志** —— 本模块**一次日志都不打**（连 debug 都没有），
 *      错误信息里也不带任何密钥材料（只说「解密失败」，不说差在哪一位）；
 *   ④ **明文绝不落库** —— 本模块只吐 Buffer / base64 字符串，落库由业务层负责，业务层只写密文列。
 *
 * ⚠️ **JS 无法可靠地清零内存里的 Buffer**（没有 `mlock`、GC 也不保证及时回收），所以
 *    本模块**不做**「用完清零 `buf.fill(0)`」这种看着安全实则无效的表演 —— 那只会让人以为
 *    密钥的生命周期被管住了。真实边界如实写进产品说明（见 `docs/公共/架构文档/16-密码库.md`）。
 *
 * ⚠️ 参数与格式一旦上线就不能随意改：`kdf_params` 是**存进库里的 JSON**（`{N,r,p,keylen}`），
 *    将来上调 N 时用**旧参数解出 DEK、再用新参数重新封装**即可（`kdf_params` 的存在就是为了这个）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/vault-crypto.js` **原样搬进模块目录的 `lib/`**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。之所以搬得动：
 *    **除了本模块的 `store.js` 与 `ttt/test/vault.test.js`，没有任何人 require 它**
 *    （核心 `server.js` / `store/**` 一次都没引用）—— 否则「删目录验收」第 1 条会当场失败。
 *    ⚠️ **一行密码学代码都没改**：上面那四条红线与全部参数原样不动，只改了文件头这两行。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md、docs/公共/调研报告/04-密码库-加密存储.md
 */

const crypto = require('node:crypto');

/**
 * scrypt 的**默认**成本参数（方案/ 决策十三-4：`N=2^17, r=8, p=1`）。
 *
 * ⚠️ `maxmem` 必须显式给：Node 默认上限是 32 MiB，而 `128 * N * r = 128 * 131072 * 8 = 128 MiB`，
 *    不抬高上限 `scryptSync` 会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（表现为「第一次设主密码就报错」）。
 *    给 256 MiB 是留一倍余量，不是「用了 256 MiB」—— 实际占用 ≈ 128 MiB。
 *
 * ⚠️ 与 `auth.js` 的 `SCRYPT`（登录口令散列，N=2^15）**刻意不同、也不得复用同一份派生结果**：
 *    两者用途不同（一个是「验证你知道口令」，一个是「当加密密钥用」）、salt 不同、威胁模型不同。
 *    密码库要扛的是**拿到库文件后的离线爆破**，所以成本参数取更高的一档（方案）。
 *
 * ⚠️ 方案 §八-10 要求「开工前补真机 KDF 复测」：本机（x86 开发机）实测约 253 ms，
 *    飞牛 NAS 的 ARM 通常慢 3~8 倍。真机复测后若偏慢，**只改这里的 N**（库里已存的库仍能用旧参数解开，
 *    因为参数就存在 `kdf_params` 里）。
 *
 * @type {{N: number, r: number, p: number, keylen: number, maxmem: number}}
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
 * ⭐ 它**不是**「口令哈希」：库里没有「主密码的散列」这种可离线爆破的材料，
 *    只有一个用 KEK 加密的已知明文 —— 能解开它就说明 KEK 对、即主密码对（方案）。
 *    被篡改时 GCM 的 tag 校验会失败，所以这一块同时也是**完整性**检查（防有人手工把库改成别的样子）。
 *
 * ⚠️ 换它 = 已存的所有密码库全部打不开（解密不出这一串就判为「主密码错」）。**不要动。**
 *
 * @type {string}
 */
const VERIFIER_PLAINTEXT = 'zxdesk-vault-v1';

/** GCM 的算法名（AES-256 由 keylen 决定，密钥必须是 32 B） @type {string} */
const CIPHER = 'aes-256-gcm';

/**
 * 密码生成器的字符集。
 *
 * ⚠️ 刻意**不含**那些在不同系统里会被判非法或被转义的字符：空格、引号、反斜杠、反引号、`$`。
 *    生成的密码是要贴进各种登录框的，「更难的字符集」如果让用户登不进去，安全性等于零。
 *    这几个保留字符在实际口令规范里被禁的概率也最高。
 *
 * @type {{upper: string, lower: string, digits: string, symbols: string}}
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
 * ⚠️ 用白名单而不是「把用户传的字符串当字符集用」：后者等于让请求体决定生成出来的密码长什么样，
 *    传一串 `'a'` 就会「生成」一串 `aaaaaaaa`，而界面上看不出任何异常。
 *
 * @type {Object.<string, Array.<string>>}
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
 *      解密失败的细节本身就是一条侧信道，而调用方（业务层）只会把它转成「主密码不正确」或
 *      「这条记录已被损坏」，多说的每一个字都是白送的信息。
 *
 * @param {string} message - 给**开发者**看的一句话（会被 HTTP 层替换成用户文案）
 * @returns {Error} 错误对象
 */
function cryptoError(message) {
  return new Error(message);
}

/**
 * 功能：校验一组 scrypt 参数是否「能被 `scryptSync` 跑通」—— 不合格直接抛错。
 *
 * 说明：⭐ 这道闸门的存在理由是**防御性**：`kdf_params` 是从库里读出来的 JSON，
 *      理论上可能被手工改过（或来自将来的版本）。把一组 `N = 0` 直接喂给 `scryptSync`
 *      的表现是抛一个底层错误、或者（更糟）`N = 1` 时几乎不花时间就派生出「密钥」，
 *      于是密码库的强度被静默降到零。这里显式要求 N 是 2 的幂、r/p ≥ 1、
 *      且 `128*N*r` 不超过 maxmem（与 `auth.js` 的 `hashUsable` 同一条判据）。
 *
 * @param {Object} p - 参数对象，读 `N` / `r` / `p` / `keylen` / `maxmem`
 * @returns {{N: number, r: number, p: number, keylen: number, maxmem: number}} 归一化后的参数
 * @throws {Error} 任一参数非法时抛出（不返回任何东西）
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
 *      结果是「主密码明明是对的，却永远解不开」，而用户得到的提示是「主密码不正确」——
 *      一个无法自证的死循环。宁可明确报「这个密码库的参数已损坏」。
 *
 * @param {(string|Object)} raw - `vault_meta.kdf_params` 的原始值
 * @returns {{N: number, r: number, p: number, keylen: number, maxmem: number}} 归一化后的参数
 * @throws {Error} 不是合法 JSON / 参数非法时抛出
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
 * 说明：⭐ DEK 是**随机**的，不是从主密码派生的 —— 这正是「信封加密」的要害：
 *      改主密码只需用新 KEK 重新封装这 32 字节，**不必重加密整库条目**（方案）。
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
 *      解锁是低频操作、且密码库操作本来就串行，暂时可接受；若将来并发解锁变多，
 *      须换成异步 `crypto.scrypt`（与 `auth.js` 的待办一致，见 `AGENTS.md` §七-6）。
 * ⚠️ 主密码按 **UTF-8** 编码进 scrypt（`String(password)` 再交给 Node，默认 utf8）——
 *    「中文主密码」因此完全可用，且不同平台结果一致。
 *
 * @param {string} masterPassword - 主密码明文（UTF-8）
 * @param {Buffer} salt - 盐（16 B）
 * @param {Object} params - 已归一化的 KDF 参数（`normalizeKdfParams` 的产物）
 * @returns {Buffer} 32 字节 KEK
 * @throws {Error} 参数非法时抛出
 */
function deriveKek(masterPassword, salt, params) {
  const p = normalizeKdfParams(params);
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt == null ? '' : salt), 'base64');
  // ⚠️ 这里**刻意不设「盐不能太短」的下限**：scrypt 本身接受任意长度（含空）的盐，
  //    RFC 7914 §12 的第一组测试向量用的就是空盐 —— 在本层加下限会让那组向量跑不通，
  //    而「盐必须 ≥ 8 字节」是**已入库的密码库应当长什么样**这条业务约束，
  //    它属于 `modules/vault/store.js`（那边读 `vault_meta` 时校验），不属于原语层。
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
 *      拼接成 `iv:cipher:tag` 再在读出侧切开只会多一次可能切错的机会，换不来任何好处。
 * ⚠️ **GCM 的 IV 复用是灾难性的**（同一密钥下复用 IV 会让攻击者能恢复明文异或、甚至伪造密文），
 *    所以这里没有「让我指定 IV」的入口 —— IV 只能由本函数生成。
 *
 * @param {Buffer} key - 32 字节密钥（KEK 或 DEK）
 * @param {(Buffer|string)} plaintext - 待加密内容（字符串按 UTF-8）
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段
 * @throws {Error} 密钥长度不对时抛出
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
 * 说明：⭐ 这是整个模块最不能放松的一处（方案 §5.3 硬要求 3）：GCM 是 AEAD，
 *      它的价值全在 `setAuthTag()` + `final()` 会把「被改过一个字节的密文」判为失败。
 *      如果这里 catch 掉错误、返回空串或 null，那么「密文被篡改」就变成了「这条记录是空的」——
 *      用户看到的是一条空密码，而实际发生的是**有人动过这个库**。
 *
 * @param {Buffer} key - 32 字节密钥
 * @param {{iv: string, cipher: string, tag: string}} parts - 三个 base64 字段
 * @returns {Buffer} 明文字节
 * @throws {Error} 密钥非法、字段缺失、tag 校验失败时抛出
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
    // ⚠️ 这里刻意吞掉异常并返回 false：调用方只需要「对 / 不对」，
    //    而把「tag 校验失败」与「明文对不上」分开告诉它，只会让上层多出一条没必要分支。
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
 * 功能：生成一个强随机密码 —— 长度与字符集可选（方案 §1.2 第 5 项）。
 *
 * 说明：⭐ 三条刻意的做法：
 *   ① **用 `crypto.randomInt`**（无偏采样）而不是 `Math.random()`：后者不是密码学随机源；
 *      也不用「`randomBytes` 取模」—— 取模会引入偏斜（尤其字符集长度不是 2 的幂时）。
 *   ② **每个选中的字符类各保底一个**：纯均匀采样可能出现「12 位里一个数字都没有」，
 *      而很多站点要求「必须含数字」—— 用户点了生成却被拒绝提交，是最没必要的摩擦。
 *      ⚠️ 保底之后**必须洗牌**：否则「第一位必是大写字母」这种结构会被看出来。
 *   ③ 长度上限 128、下限 8（与 `validate.js` 的口径一致）。
 *
 * @param {Object} [opts] - 生成选项
 * @param {number} [opts.length=16] - 长度（8~128）
 * @param {string} [opts.charset='all'] - `'letters'` / `'alnum'` / `'all'`（白名单）
 * @param {boolean} [opts.noAmbiguous=false] - 是否排除易混字符（`0O1lI` 这类）
 * @returns {string} 生成出来的密码
 * @throws {Error} 长度越界或字符集不认识时抛出
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
  // ③ 洗牌（Fisher–Yates，随机源同上）—— 否则保底的那几个永远排在最前面
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
  generatePassword,
};
