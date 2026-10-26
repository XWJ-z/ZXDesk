import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { runDiagnose } from '../src/main/diagnose.js';

const fakeApp = { getVersion: () => '0.1.0' };

function makeDir(name) {
  const dir = path.join(process.cwd(), 'build', 'tmp', 'diagnose', name);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'crashes'), { recursive: true });
  return dir;
}

test('数据目录正常 ⇒ 退出码 0，且把关键项都打出来', () => {
  const dir = makeDir('ok');
  const lines = [];
  const code = runDiagnose({
    app: fakeApp,
    paths: { dir, mode: 'portable', warning: null },
    logger: () => {},
    singleInstanceOk: true,
    safeStorageOk: true,
    print: (line) => lines.push(line),
  });
  const text = lines.join('\n');
  assert.equal(code, 0);
  assert.match(text, /ZXDesk: 0\.1\.0/);
  assert.match(text, /Node: \d+/);
  assert.match(text, /数据目录可写: true/);
  assert.match(text, /全部正常/);
});

test('子目录缺失 ⇒ 报 FAIL 并返回 1（不假装正常）', () => {
  const dir = path.join(process.cwd(), 'build', 'tmp', 'diagnose', 'missing');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const code = runDiagnose({
    app: fakeApp,
    paths: { dir, mode: 'dev', warning: '测试用' },
    logger: () => {},
    singleInstanceOk: true,
    safeStorageOk: false,
    print: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /FAIL.*子目录 profile/);
});

test('safeStorage 不可用只提示、不算异常（不落盘是降级，不是故障）', () => {
  const dir = makeDir('nostore');
  const lines = [];
  const code = runDiagnose({
    app: fakeApp,
    paths: { dir, mode: 'portable', warning: null },
    logger: () => {},
    singleInstanceOk: false,
    safeStorageOk: false,
    print: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /safeStorage 加密: 不可用/);
});
