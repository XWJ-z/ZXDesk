'use strict';
/**
 * modules/ai/lib/seal.js —— ai辅助任务模块的**信封加密原语**
 * 功能：把本模块用到的密码学操作收在一个**纯函数模块**里 ——
 * `deriveKek()`（用实例密钥经 HKDF 派生 KEK）、`seal()` / `open()`（AES-256-GCM 封 / 开）、
 * @author zx
 * @date   2026-09-15
 * @since 0.9.7
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
 */
const KEK_INFO = 'zxdesk-ai-key-v1';

/**
 * 功能：用实例密钥（`core/context.js` 的 `AUTH_SECRET`，32 B）派生本模块专用的 KEK。
 *
 * 说明：⚠️ 入参必须是 **Buffer** 且 ≥ 32 字节 —— 这条不放松：拿到别的类型说明调用方拿错了材料
 * （比如把 base64 字符串直接塞进来），宁可当场抛也不派生出一把「看似能用」的弱密钥。
 * salt 用固定串而不是随机盐：实例密钥本身已经是高熵随机材料，HKDF 在这一场景里
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
 * 转译发生在业务层，本层只负责「宁可不返回，也不返回错的东西」。
 *
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
 * 配置的读接口（`GET /api/ai/config`）**永远不该碰这个函数** —— 那是「绝不回显」红线的实现边界。
 *
 */
function openKey(kek, parts) {
  const src = parts || {};
  if (!src.iv || !src.cipher || !src.tag) throw new Error('API Key 的密文材料不完整');
  return open(kek, src).toString('utf8');
}

module.exports = { IV_BYTES, TAG_BYTES, KEY_BYTES, CIPHER, KEK_INFO, deriveKek, seal, open, sealKey, openKey };
