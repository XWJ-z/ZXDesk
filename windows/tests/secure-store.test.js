/**
 * 0.1.6 回归：`safeStorage` 异步 API 的返回值形状。
 *
 * Electron 45 的 `decryptStringAsync()` 解析成 `{ result, shouldReEncrypt }`（**不是字符串**），
 * 而 0.1.0～0.1.6 直接拿它去 `JSON.parse` ⇒ `credential.bin` / `session.bin` 每次启动都当坏文件，
 * 用户看到的就是「地址账号记得、密码不记得、也不自动登录」。这里锁死两种返回都能读。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SecureStore, SecureUnavailableError } from '../src/main/store/secure.js';

/** 假 safeStorage：把明文 base64 存进内存，模拟 Electron 的两种异步返回形状。 */
function fakeSafeStorage({ shape = 'object' } = {}) {
  return {
    available: true,
    async isAsyncEncryptionAvailable() {
      return true;
    },
    async encryptStringAsync(text) {
      return Buffer.from(text, 'utf8');
    },
    async decryptStringAsync(buf) {
      const text = Buffer.from(buf).toString('utf8');
      // Electron 45 真实形状；shape='string' 兼容旧的假实现
      return shape === 'string' ? text : { result: text, shouldReEncrypt: false };
    },
  };
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-secure-'));
  return path.join(dir, 'x.bin');
}

test('Electron 45 异步解密返回 { result } 时能读回原文', async () => {
  const store = new SecureStore({ safeStorage: fakeSafeStorage({ shape: 'object' }) });
  const file = tempFile();
  await store.put(file, JSON.stringify({ user: '6', password: 'p@ss' }));
  assert.equal(await store.get(file), JSON.stringify({ user: '6', password: 'p@ss' }));
});

test('异步解密仍返回字符串的旧实现也认', async () => {
  const store = new SecureStore({ safeStorage: fakeSafeStorage({ shape: 'string' }) });
  const file = tempFile();
  await store.put(file, 'hello');
  assert.equal(await store.get(file), 'hello');
});

test('safeStorage 不可用时 put 抛 SecureUnavailableError', async () => {
  const store = new SecureStore({
    safeStorage: {
      async isAsyncEncryptionAvailable() {
        return false;
      },
    },
  });
  await assert.rejects(() => store.put(tempFile(), 'x'), SecureUnavailableError);
});

test('解密结果形状不认识时当坏文件并删掉（不把对象当明文用）', async () => {
  const store = new SecureStore({
    safeStorage: {
      async isAsyncEncryptionAvailable() {
        return true;
      },
      async encryptStringAsync() {
        return Buffer.from('x');
      },
      async decryptStringAsync() {
        return { nothing: true };
      },
    },
  });
  const file = tempFile();
  fs.writeFileSync(file, 'zxdesk:v1:AAAA', 'utf8');
  assert.equal(await store.get(file), null);
  assert.equal(fs.existsSync(file), false);
});
