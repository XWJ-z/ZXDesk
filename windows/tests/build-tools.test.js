/**
 * 打包工具链本身的护栏（`npm run doctor` / `npm run dist`，WIN-013）。
 *
 * 这些断言防的是「工具退化」：顺序被改、失败不再中止、sha 格式变了、校验被删掉。
 * ⛔ 不测「跑一次 dist」（那要 40 秒 + 300 MB），只锁结构与关键判据；真跑由 `npm run dist` 负责。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('scripts：doctor / dist / verify:zip 都注册了，且指向真实存在的脚本', () => {
  assert.equal(pkg.scripts.doctor, 'node build/doctor.js');
  assert.equal(pkg.scripts.dist, 'node build/dist.js');
  assert.equal(pkg.scripts['verify:zip'], 'python3 build/verify-zip.py');
  for (const file of ['build/doctor.js', 'build/dist.js', 'build/verify-zip.py', 'build/pack.js', 'build/make-zip.py']) {
    assert.ok(fs.existsSync(path.join(root, file)), `缺 ${file}`);
  }
});

test('dist.js：五步顺序固定（自检 → 打包 → zip → sha → 复核），且任一步失败就退出', () => {
  const s = read('build/dist.js');
  const at = (needle) => s.indexOf(needle);
  const a = at('doctor.js');
  const b = at('pack.js');
  const c = at('make-zip.py');
  const d = at('sha256');
  const e = at('verify-zip.py');
  assert.ok(a > 0 && b > a, '自检要在打包之前');
  assert.ok(c > b, 'zip 在打包之后');
  assert.ok(d > c, 'sha 在 zip 之后');
  assert.ok(e > d, '复核在 sha 之后');
  assert.match(s, /const die = \(message\)[\s\S]{0,120}process\.exit\(1\)/, '失败必须非零退出');
  assert.match(s, /if \(child\.status !== 0\) die\(/, '子进程非零要中止');
});

test('dist.js：sha256 与 sha256sum 同格式（两个空格 + 文件名），且会核对包内版本与图标字节', () => {
  const s = read('build/dist.js');
  assert.match(s, /writeFileSync\(shaFile, `\$\{hash\}  \$\{path\.basename\(outZip\)\}\\n`/, 'sha 文件格式：<hash>␠␠<文件名>');
  assert.match(s, /packedPkg\.version !== pkg\.version/, '要核对 asar 里的版本号');
  assert.match(s, /iconEntries\.length !== icoCount/, '要核对包内 exe 图标个数');
  assert.match(s, /icoHashes[\s\S]{0,200}exeHashes/, '要逐字节比对图标');
  assert.match(s, /readUInt16LE\(4\)/, 'ico 的图直接从文件字节里取（BMP 条目没有 .bin）');
  assert.match(s, /--skip-doctor/, '要支持跳过自检');
  assert.match(s, /--out/, '要支持换输出位置');
});

test('doctor.js：六类检查都在（Node / 依赖 / Electron 运行时 / python3 / 图标 / 磁盘）', () => {
  const s = read('build/doctor.js');
  for (const needle of ['Node 版本', '构建依赖', 'Electron 运行时', 'python3', '图标 ico', '磁盘空间']) {
    assert.ok(s.includes(needle), `自检缺「${needle}」`);
  }
  assert.match(s, /process\.exit\(failed === 0 \? 0 : 1\)/, '有 ✗ 就退 1');
});

test('verify-zip.py：CRC / 顶层目录 / 禁 node_modules 与 data / exe 大小都要查', () => {
  const py = read('build/verify-zip.py');
  assert.match(py, /testzip\(\)/, '要查 CRC');
  assert.match(py, /TOP = 'ZXDesk-win32-x64'/, '顶层目录写死');
  assert.match(py, /node_modules\//, '要挡 node_modules');
  assert.match(py, /\/data\//, '要挡用户数据目录');
  assert.match(py, /MIN_EXE = 100 \* 1024 \* 1024/, 'exe 小于 100 MB 视为空壳');
});
