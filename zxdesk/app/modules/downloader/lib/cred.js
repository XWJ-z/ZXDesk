'use strict';
/**
 * modules/downloader/lib/cred.js —— 令牌的**信封加密原语**（纯函数）
 * 功能：`deriveKey()`（用实例密钥经 HKDF 派生本账号专用的一把 KEK）、`seal()` / `open()`
 * （AES-256-GCM 封 / 开，AAD 绑账号）、`isSealed()`（判断三列算不算「有令牌」）。
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、16-密码库.md、18-ai辅助任务.md
 */

const crypto = require('node:crypto');

/** IV 长度（字节）：12 B 是 GCM 的推荐长度 @type {number} */
const IV_BYTES = 12;

/** GCM 认证标签长度（字节） @type {number} */
const TAG_BYTES = 16;

/** 密钥长度：32 B = AES-256 @type {number} */
const KEY_BYTES = 32;

/** GCM 算法名（密钥长度由 keylen 决定） @type {string} */
const CIPHER = 'aes-256-gcm';

/**
 * HKDF 的 salt（域分离标签）。
 * @type {string}
 */
const SALT = 'zxdesk-downloader-v1';

/** HKDF 的 `info` 前缀，后面拼账号 id @type {string} */
const INFO_PREFIX = 'zxdesk:downloader:';

/**
 * 功能：由实例密钥 ＋ 账号 id 派生该账号的 KEK。
 * @param {Buffer} instanceKey - 实例密钥（`core/context.js` 的 `AUTH_SECRET`，≥ 32 字节）
 * @param {number} uid - 账号 id
 * @returns {Buffer} 32 字节密钥
 * @throws {Error} 实例密钥缺失 / 太短、或 uid 不是整数时抛出
 */
function deriveKey(instanceKey, uid) {
  if (!Buffer.isBuffer(instanceKey) || instanceKey.length < KEY_BYTES) {
    throw new Error('实例密钥缺失或长度不足（视频下载器的加密材料不可用）');
  }
  const id = Number(uid);
  if (!Number.isInteger(id) || id <= 0) throw new Error('账号 id 不合法，无法派生密钥');
  const dk = crypto.hkdfSync(
    'sha256',
    instanceKey,
    Buffer.from(SALT, 'utf8'),
    Buffer.from(INFO_PREFIX + String(id), 'utf8'),
    KEY_BYTES,
  );
  return Buffer.from(dk);
}

/**
 * 功能：加密一段文本 —— AES-256-GCM，AAD 绑账号 id，**每次调用都新生成随机 IV**。
 * @param {Buffer} key - 32 字节密钥（`deriveKey()` 的产物）
 * @param {number} uid - 账号 id（作为 AAD 参与完整性校验）
 * @param {string} plaintext - 待加密文本
 * @returns {{iv: string, cipher: string, tag: string}} 三个 base64 字段
 */
function seal(key, uid, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('密钥长度必须是 32 字节');
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(CIPHER, key, iv);
  c.setAAD(Buffer.from(INFO_PREFIX + String(Number(uid)), 'utf8'));
  const data = Buffer.from(String(plaintext == null ? '' : plaintext), 'utf8');
  const cipher = Buffer.concat([c.update(data), c.final()]);
  return { iv: iv.toString('base64'), cipher: cipher.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/**
 * 功能：解密 `{iv, cipher, tag}` —— **tag 校验失败一律抛错**，绝不返回任何数据。
 *
 * 说明：⚠️ 「令牌被换过账号」「库被换过实例」「密文被改过」都表现为这里抛错。
 * 调用方把它们统一转译成「保存的令牌已失效，请重新填一次」，
 * 不把 GCM 的技术错误抛给使用者。
 */
function open(key, uid, parts) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('密钥长度必须是 32 字节');
  const src = parts || {};
  const iv = Buffer.from(String(src.iv == null ? '' : src.iv), 'base64');
  const tag = Buffer.from(String(src.tag == null ? '' : src.tag), 'base64');
  const cipher = Buffer.from(String(src.cipher == null ? '' : src.cipher), 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('密文格式不合法');
  const d = crypto.createDecipheriv(CIPHER, key, iv);
  d.setAAD(Buffer.from(INFO_PREFIX + String(Number(uid)), 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]).toString('utf8');
}

/**
 * 功能：判断一行里的三列算不算「存过令牌」。
 * @param {?Object} row - 设置行
 * @returns {boolean} 三列都非空则为 true
 */
function isSealed(row) {
  const r = row || {};
  return !!(r.token_iv && r.token_cipher && r.token_tag);
}

module.exports = { IV_BYTES, TAG_BYTES, KEY_BYTES, CIPHER, SALT, INFO_PREFIX, deriveKey, seal, open, isSealed };
