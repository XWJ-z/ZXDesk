/**
 * 飞牛 WS 登录的密码学（移植自 `Project/Android/core/connection/FnCrypto.kt`）。
 *
 * ⚠️ 与网上社区文档不一致的两处（以实测为准，⛔ 别改回去）：
 * 1. **AES-256，不是 128** —— key 是 32 个 `[0-9a-zA-Z]` 字符，按 UTF-8 字节当 key；
 *    16 字符的做法服务端会**静默丢掉那一帧**（不报错，只等超时）。
 * 2. **RSA 是 PKCS#1 v1.5，不是 OAEP** —— 信封里也就不带 `v` 字段。
 */

import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const KEY_LENGTH = 32;
export const IV_LENGTH = 16;

/** 32 个字母数字（照 fnOS 前端 bundle：62 字符表随机取 32 位）。 */
export function randomAesKey(random = Math.random) {
  let out = '';
  for (let i = 0; i < KEY_LENGTH; i += 1) out += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? '0';
  return out;
}

export function randomIv() {
  return crypto.randomBytes(IV_LENGTH);
}

/** AES-256-CBC/PKCS7。key 按 UTF-8 字节（32 字符 ⇒ 32 字节）。 */
export function aesEncrypt(plain, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
  return Buffer.concat([cipher.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')), cipher.final()]);
}

export function aesDecrypt(cipherText, key, iv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

/** RSA PKCS#1 v1.5 加密 AES 密钥（`-----BEGIN PUBLIC KEY-----` 的 SPKI PEM）。 */
export function rsaEncryptKey(key, publicKeyPem) {
  return crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(key, 'utf8'));
}

/**
 * 加密信封：`{"req":"encrypted","iv":b64,"rsa":b64,"aes":b64}`
 * ⛔ 不带 `v`、⛔ 不带外层 `reqid`（reqid 在 AES 里那份明文 JSON 上）。
 */
export function envelope(innerJson, publicKeyPem, key, iv) {
  return JSON.stringify({
    req: 'encrypted',
    iv: b64(iv),
    rsa: b64(rsaEncryptKey(key, publicKeyPem)),
    aes: b64(aesEncrypt(innerJson, key, iv)),
  });
}

/** 明文请求的签名：`base64(HMAC-SHA256(b64decode(secret), json)) + json`。 */
export function sign(json, secretBase64) {
  const mac = crypto.createHmac('sha256', Buffer.from(secretBase64, 'base64'));
  return mac.update(json, 'utf8').digest('base64') + json;
}

/**
 * 解开自己造的加密信封（**只给测试用**）：验证「发的确实是 AES-256 + RSA PKCS1 的信封」。
 * @returns {{inner:string, key:string}}
 */
export function openEnvelope(envelopeJson, privateKeyPem) {
  const parsed = JSON.parse(envelopeJson);
  const key = crypto
    .privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(parsed.rsa, 'base64'))
    .toString('utf8');
  const inner = aesDecrypt(Buffer.from(parsed.aes, 'base64'), key, Buffer.from(parsed.iv, 'base64')).toString('utf8');
  return { inner, key };
}

export function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** 对称「解」出一段 base64（测试用）。 */
export function fromB64(text) {
  return Buffer.from(String(text), 'base64');
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** PEM 里提取 RSA 公钥（校验用；Electron 里也可用 `crypto.createPublicKey`）。 */
export function parsePublicKey(pem) {
  return crypto.createPublicKey(pem);
}
