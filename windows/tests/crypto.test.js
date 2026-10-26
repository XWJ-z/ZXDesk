import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  aesDecrypt,
  aesEncrypt,
  b64,
  envelope,
  openEnvelope,
  randomAesKey,
  randomIv,
  rsaEncryptKey,
  sha256Hex,
  sign,
} from '../src/main/login/crypto.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

test('AES key 是 32 个字母数字（AES-256 的前提）', () => {
  for (let i = 0; i < 20; i += 1) {
    const key = randomAesKey();
    assert.equal(key.length, 32);
    assert.match(key, /^[0-9a-zA-Z]{32}$/);
    assert.equal(Buffer.from(key, 'utf8').length, 32);
  }
});

test('randomAesKey 会被 random 影响（可注入）', () => {
  assert.equal(randomAesKey(() => 0), '0'.repeat(32));
});

test('IV 是 16 字节', () => {
  assert.equal(randomIv().length, 16);
});

test('AES-256-CBC 往返 + 密文与明文不同', () => {
  const key = randomAesKey();
  const iv = randomIv();
 const plain = JSON.stringify({ req: 'user.login', user: '测试用户', password: 'p@ss' });
  const encrypted = aesEncrypt(plain, key, iv);
  assert.notEqual(encrypted.toString('utf8'), plain);
  assert.equal(aesDecrypt(encrypted, key, iv).toString('utf8'), plain);
});

test('16 字符的 key 直接报错（不会静默降级成 AES-128）', () => {
  // 这是本实现与「用 16 字符 key」的旧做法最本质的差别：显式 aes-256-cbc ⇒ key 长度不对就炸，
  // 而不是悄悄用 128 位（服务端会静默丢帧，只等超时）。
  assert.throws(() => aesEncrypt('x', 'a'.repeat(16), randomIv()), /Invalid key length/);
});

test('RSA 用 PKCS#1 v1.5（不是 OAEP）：能私钥解开', () => {
  const key = randomAesKey();
  const encrypted = rsaEncryptKey(key, publicKey);
  const decrypted = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    encrypted,
  );
  assert.equal(decrypted.toString('utf8'), key);
});

test('信封字段只有 req/iv/rsa/aes（⛔ 不带 v、⛔ 不带外层 reqid）', () => {
  const body = envelope('{"req":"user.login"}', publicKey, randomAesKey(), randomIv());
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed).sort(), ['aes', 'iv', 'req', 'rsa']);
  assert.equal(parsed.req, 'encrypted');
  assert.equal(parsed.v, undefined);
  assert.equal(parsed.reqid, undefined);
});

test('信封能被拆回原文（说明 AES/RSA 都没错）', () => {
  const inner = JSON.stringify({ req: 'user.2fa.loginVerify', reqid: '11', si: '748918410105' });
  const body = envelope(inner, publicKey, randomAesKey(), randomIv());
  const opened = openEnvelope(body, privateKey);
  assert.equal(opened.inner, inner);
  assert.equal(opened.key.length, 32);
});

test('HMAC 签名 = base64(hmac) + json', () => {
  const secret = crypto.randomBytes(32).toString('base64');
  const json = '{"req":"appcgi.sac.entry.v1.exchangeEntryToken"}';
  const signed = sign(json, secret);
  assert.ok(signed.endsWith(json));
  const head = signed.slice(0, signed.length - json.length);
  const expected = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(json).digest('base64');
  assert.equal(head, expected);
});

test('b64 与 Buffer 互逆', () => {
  const buf = Buffer.from('中文 and ascii');
  assert.equal(Buffer.from(b64(buf), 'base64').toString('utf8'), '中文 and ascii');
});

test('sha256Hex 与 Node 一致', () => {
  assert.equal(sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
});
