/**
 * 打包前自检（`npm run doctor`）。
 *
 * 目的：把「打完才发现缺东西」变成「开跑前 3 秒说清楚」。检查项都是本机真实踩过的坑：
 * - 依赖没装 / 装了一半（`node_modules` 在、electron 的 dist 不在）；
 * - Electron 的 win32-x64 包没进缓存（本机构建走离线校验，缺了会去 GitHub 拉，时通时不通）；
 * - `python3` 不在（`make-zip.py` 用它）；
 * - 图标 ico 尺寸不全（打出来的 exe 图标会糊 / 变通用图标）；
 * - 磁盘不够（打一次要 ~1.2 GB 临时空间）。
 *
 * 只读检查，不改任何东西；有一项 ✗ 就退 1。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const results = [];
const ok = (label, detail = '') => results.push({ ok: true, label, detail });
const bad = (label, hint) => results.push({ ok: false, label, hint });

function has(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 1. Node

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok('Node 版本', `v${process.versions.node}`);
else bad('Node 版本', `需要 ≥ 20，当前 v${process.versions.node}`);

// ---------------------------------------------------------------- 2. 依赖

const DEPS = ['electron', '@electron/packager', 'resedit', '@electron/asar'];
const missing = DEPS.filter((name) => !has(path.join(root, 'node_modules', name, 'package.json')));
if (missing.length === 0) ok('构建依赖', DEPS.join(' / '));
else bad('构建依赖', `缺 ${missing.join(' / ')} ⇒ 在 Project/windows 里跑 npm install`);

// ---------------------------------------------------------------- 3. Electron 运行时（win32-x64）

const electronPkg = path.join(root, 'node_modules', 'electron', 'package.json');
if (has(electronPkg)) {
  const version = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
  const distExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (has(distExe)) ok('Electron 运行时（win32-x64）', `v${version} 已解到 node_modules/electron/dist`);
  else {
    // 缓存命中也能打：packager 会从 ~/.cache/electron 取
    const cacheRoot = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '', '.cache'), 'electron');
    const cached = has(cacheRoot)
      ? fs.readdirSync(cacheRoot).some((dir) => has(path.join(cacheRoot, dir, `electron-v${version}-win32-x64.zip`)))
      : false;
    if (cached) ok('Electron 运行时（win32-x64）', `v${version} 走 ~/.cache/electron 缓存`);
    else
      bad(
        'Electron 运行时（win32-x64）',
        `v${version} 既没解包也没缓存 ⇒ npm run doctor 提示的两种办法：① npm install；② 用 npmmirror 下 zip 并按 build/pack.js 里的 ELECTRON_CHECKSUMS 校验后放缓存`,
      );
  }
}

// ---------------------------------------------------------------- 4. python3（make-zip）

const py = spawnSync('python3', ['-V'], { encoding: 'utf8' });
if (py.status === 0) ok('python3（打 zip 用）', String(py.stdout).trim());
else bad('python3（打 zip 用）', '装 python3，或改用系统 zip 命令（build/make-zip.py 依赖标准库 zipfile）');

// ---------------------------------------------------------------- 5. 图标

const icoPath = path.join(root, 'src', 'shell', 'assets', 'icon.ico');
if (!has(icoPath)) bad('图标 ico', `缺 ${path.relative(root, icoPath)}`);
else {
  try {
    const ResEdit = await import('resedit');
    const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
    const sizes = ico.icons.map((i) => (i.width && i.height ? `${i.width}x${i.height}` : '256x256'));
    const need = ['16x16', '32x32', '48x48', '256x256'];
    const lacking = need.filter((n) => !sizes.includes(n));
    if (lacking.length === 0) ok('图标 ico', `${ico.icons.length} 个尺寸：${sizes.join(' ')}`);
    else bad('图标 ico', `缺尺寸 ${lacking.join(' / ')}（Windows 小图标会糊）`);
  } catch (e) {
    bad('图标 ico', `解析失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- 6. 磁盘空间

try {
  const stat = fs.statfsSync(root);
  const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
  if (freeGb >= 3) ok('磁盘空间', `可用 ${freeGb.toFixed(1)} GB（打一次约占 1.2 GB 临时）`);
  else bad('磁盘空间', `只剩 ${freeGb.toFixed(1)} GB，打包会失败（先清 build/tmp）`);
} catch {
  ok('磁盘空间', '本机不支持 statfs，跳过');
}

// ---------------------------------------------------------------- 输出

console.log(`\nZXDesk 打包环境自检（${pkg.name} ${pkg.version}）\n`);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.ok) console.log(`    → ${r.hint}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\n全部就绪，可以 npm run dist\n' : `\n${failed} 项没就绪，先按上面的提示处理\n`);
process.exit(failed === 0 ? 0 : 1);
