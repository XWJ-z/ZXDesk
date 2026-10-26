'use strict';
/**
 * modules/ai/lib/seal.js —— ai辅助任务模块的**信封加密原语**（0.6.0）
 *
 * 功能：把本模块用到的密码学操作收在一个**纯函数模块**里 ——
 *      `deriveKek()`（用实例密钥经 HKDF 派生 KEK）、`seal()` / `open()`（AES-256-GCM 封 / 开）、
 *      `sealKey()` / `openKey()`（API Key 的封装与解开）。
 *
 * ⭐ **为什么单独一个文件**：密码学代码必须是**可单独测试**的（vault `lib/crypto.js` 的同一先例）——
 *    本模块不认识数据库、不认识 HTTP、不认识 uid，输入输出全是 Buffer / base64 字符串。
 *    ⚠️ **不 require `core/context.js`**（哪怕惰性也不行）：模块的 `store.js` 会被 Store 装配链
 *    在加载期 require，而 context.js 自己也 require 这条链 —— 顶层引它就是循环加载；
 *    所以 **KEK 由调用方（routes 层，本来就拿着 `context.AUTH_SECRET`）派生后作参数传进来**。
 *
 * ⭐ **为什么 KEK 用 HKDF 而不是拿 `AUTH_SECRET` 直接当 AES 密钥**：域分离（domain separation）——
 *    同一把 32 字节实例密钥已经被会话令牌的 HMAC 用着；直接复用同一把密钥做两种原语
 *    （HMAC + AES-GCM）在密码学上是坏习惯（密钥分离原则）。HKDF 派生一次只要微秒级，
 *    `info` 里写死用途（`zxdesk-ai-key-v1`），将来任何别的用途都派生不出这一把。
 *
 * ⚠️ **换实例密钥 = 已存的 key 全部失效，而且必须显式失效**（fail-safe）：`auth.secret` 被删
 *    （或恢复到另一台实例）后，`open()` 的 GCM tag 校验必然失败 —— 调用方把这种情况报成
 *    「密钥材料已更换，请到『AI 辅助任务』重新填写 API Key」，**绝不静默用一把错的密钥解出乱码当配置用**
 *    （静默 = 把事故藏起来）。
 *
 * ⚠️ 四条红线（与 vault `lib/crypto.js` 同款，一条不让）：
 *   ① **IV 绝不复用** —— 每次加密都 `randomBytes(12)` 新生成；
 *   ② **GCM tag 必须校验** —— 校验失败必须**抛错**，不得返回任何数据；
 *   ③ **key / KEK / 明文绝不落日志** —— 本模块**一次日志都不打**，错误信息里也不带任何密钥材料；
 *   ④ **明文绝不落库** —— 本模块只吐 Buffer / base64 字符串，落库由业务层负责，业务层只写密文列。
 *
 * ⚠️ **JS 无法可靠地清零内存里的 Buffer**（vault 同款声明）：不做「用完清零」的表演；
 *    真实边界如实写进产品说明（`docs/公共/架构文档/18-ai辅助任务.md`）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.7.2
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、modules/vault/lib/crypto.js
 */

const crypto = require('node:crypto');

/** GCM 的 IV 长度（字节）：12 B 是 GCM 的推荐长度 @type {number} */
const IV_BYTES = 12;

/** GCM 认证标签长度（字节） @type {number} */
const TAG_BYTES = 16;

/** KEK 与派生密钥的长度：32 B = AES-256 @type {number} */
const KEY_BYTES = 32;

/** GCM 的算法名（AES-256 由 keylen 决定，密钥必须是 32 B） @type {string} */
const CIPHER = 'aes-256-gcm';

/**
 * HKDF 的 `info`（用途域分离标签）。
 *
 * ⚠️ **换它 = 所有已存的 API Key 打不开**（表现为「未配置」，用户重填一次即可）。不要动。
 *
 * @type {string}
 */
const KEK_INFO = 'zxdesk-ai-key-v1';

/**
 * 功能：用实例密钥（`core/context.js` 的 `AUTH_SECRET`，32 B）派生本模块专用的 KEK。
 *
 * 说明：⚠️ 入参必须是 **Buffer** 且 ≥ 32 字节 —— 这条不放松：拿到别的类型说明调用方拿错了材料
 *      （比如把 base64 字符串直接塞进来），宁可当场抛也不派生出一把「看似能用」的弱密钥。
 *      ⚠️ salt 用固定串而不是随机盐：实例密钥本身已经是高熵随机材料，HKDF 在这一场景里
 *      只是「提取 + 扩展」的域分离，随机盐反而让「换盐 = 全部失效」多出一个隐蔽的失效模式。
 *
 * @param {Buffer} instanceKey - 实例密钥（`AUTH_SECRET`，≥ 32 字节）
 * @returns {Buffer} 32 字节 KEK
 * @throws {Error} 实例密钥缺失或太短时抛出
 */
function deriveKek(instanceKey) {
  if (!Buffer.isBuffer(instanceKey) || instanceKey.length < KEY_BYTES) {
    throw new Error('实例密钥缺失或长度不足（AI 配置的加密材料不可用）');
  }
  const dk = crypto.hkdfSync(
    'sha256',
    instanceKey,
    Buffer.from(KEK_INFO, 'utf8'),
    Buffer.from(KEK_INFO, 'utf8'),
    KEY_BYTES,
  );
  return Buffer.from(dk);
}

/**
 * 功能：用一把 32 B 密钥加密一段字节 —— AES-256-GCM，**每次调用都新生成随机 IV**。
 * @param {Buffer} key - 32 字节密钥（KEK）
 * @param {(Buffer|string)} plaintext - 待加密内容（字符串按 UTF-8）
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段
 * @throws {Error} 密钥长度不对时抛出
 */
function seal(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('密钥长度必须是 32 字节');
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(CIPHER, key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const cipher = Buffer.concat([c.update(data), c.final()]);
  return { iv: iv.toString('base64'), cipher: cipher.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/**
 * 功能：用一把 32 B 密钥解密 `{iv, cipher, tag}` —— **tag 校验失败一律抛错**，绝不返回任何数据。
 *
 * 说明：⚠️ 调用方（`store.js`）把这里的异常**转译**成「配置的密钥材料已失效，请重新填写」——
 *      转译发生在业务层，本层只负责「宁可不返回，也不返回错的东西」。
 *
 * @param {Buffer} key - 32 字节密钥
 * @param {{iv: string, cipher: string, tag: string}} parts - 三个 base64 字段
 * @returns {Buffer} 明文字节
 * @throws {Error} 密钥非法、字段缺失、tag 校验失败时抛出
 */
function open(key, parts) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('密钥长度必须是 32 字节');
  const src = parts || {};
  const iv = Buffer.from(String(src.iv == null ? '' : src.iv), 'base64');
  const tag = Buffer.from(String(src.tag == null ? '' : src.tag), 'base64');
  const cipher = Buffer.from(String(src.cipher == null ? '' : src.cipher), 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('密文格式不合法');
  const d = crypto.createDecipheriv(CIPHER, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]);
}

/**
 * 功能：把一条 API Key 明文封装成可落库的三元组。
 * @param {Buffer} kek - 32 字节 KEK（`deriveKek` 的产物）
 * @param {string} apiKey - API Key 明文
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段（写进 `ai_configs` 的 key_* 三列）
 */
function sealKey(kek, apiKey) {
  return seal(kek, String(apiKey == null ? '' : apiKey));
}

/**
 * 功能：解开 `ai_configs` 的 key_* 三列，返回 API Key 明文。
 *
 * 说明：⚠️ 只有**出网那一刻**（`lib/openai-client.js` 构造请求头）才允许调它；
 *      配置的读接口（`GET /api/ai/config`）**永远不该碰这个函数** —— 那是「绝不回显」红线的实现边界。
 *
 * @param {Buffer} kek - 32 字节 KEK
 * @param {{iv: string, cipher: string, tag: string}} parts - `ai_configs` 的 key_* 三列
 * @returns {string} API Key 明文
 * @throws {Error} 密钥材料失效（换实例 / 密文被篡改 / 三列不齐）时抛出
 */
function openKey(kek, parts) {
  const src = parts || {};
  if (!src.iv || !src.cipher || !src.tag) throw new Error('API Key 的密文材料不完整');
  return open(kek, src).toString('utf8');
}

module.exports = { IV_BYTES, TAG_BYTES, KEY_BYTES, CIPHER, KEK_INFO, deriveKek, seal, open, sealKey, openKey };
