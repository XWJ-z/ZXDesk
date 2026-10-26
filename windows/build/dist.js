/**
 * 一条命令出包：`npm run dist`。
 *
 * 顺序（每一步失败就停，绝不"带病出包"）：
 *   1. `build/doctor.js`   —— 环境自检（Node / 依赖 / Electron 运行时 / python3 / 图标 / 磁盘）
 *   2. `build/pack.js`     —— 打包（内含：先 rename 旧输出、兼容本机沙箱、打完写图标并复核）
 *   3. `build/make-zip.py` —— 压成绿色 zip（顶层目录 `ZXDesk-win32-x64/`）
 *   4. 写 `.sha256`        —— `sha256sum` 同格式：`<hash>  <文件名>`
 *   5. `build/verify-zip.py` + asar/exe 复核 —— CRC、顶层目录、无 node_modules/data、
 *      exe 大小、asar 里的版本号、exe 图标数 = ico 尺寸数
 *
 * 参数：
 *   --skip-doctor   跳过第 1 步（CI 里已经装好时用，本机别跳）
 *   --out <path>    指定输出 zip（默认 `release/zxdesk-windows-<version>-x64.zip`）
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.resolve(root, '..', '..', 'release');

const argv = process.argv.slice(2);
const skipDoctor = argv.includes('--skip-doctor');
const outIndex = argv.indexOf('--out');
const outZip = outIndex >= 0 && argv[outIndex + 1]
  ? path.resolve(process.cwd(), argv[outIndex + 1])
  : path.join(releaseDir, `zxdesk-windows-${pkg.version}-x64.zip`);

const step = (n, label) => console.log(`\n=== [${n}/5] ${label} ===`);
const die = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};

function run(cmd, args, label) {
  const child = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (child.error) die(`${label} 起不来：${child.error.message}`);
  if (child.status !== 0) die(`${label} 失败（exit ${child.status}）`);
}

const started = Date.now();

// ---------------------------------------------------------------- 1. 自检

if (skipDoctor) {
  console.log('=== [1/5] 环境自检：已按 --skip-doctor 跳过 ===');
} else {
  step(1, '环境自检');
  run(process.execPath, [path.join(root, 'build', 'doctor.js')], '环境自检');
}

// ---------------------------------------------------------------- 2. 打包（含图标）

step(2, '打包（含 exe 图标写入与复核）');
run(process.execPath, [path.join(root, 'build', 'pack.js')], '打包');

const appDir = path.join(root, 'build', 'out', 'ZXDesk-win32-x64');
const exePath = path.join(appDir, 'ZXDesk.exe');
if (!fs.existsSync(exePath)) die(`打包完成但没找到 exe：${exePath}`);

// ---------------------------------------------------------------- 3. 压 zip

step(3, '压成绿色 zip');
fs.mkdirSync(path.dirname(outZip), { recursive: true });
run('python3', [path.join(root, 'build', 'make-zip.py'), appDir, outZip], '压 zip');

// ---------------------------------------------------------------- 4. sha256

step(4, '写 .sha256');
const zipBuf = fs.readFileSync(outZip);
const hash = crypto.createHash('sha256').update(zipBuf).digest('hex');
const shaFile = `${outZip}.sha256`;
fs.writeFileSync(shaFile, `${hash}  ${path.basename(outZip)}\n`, 'utf8');
console.log(`✓ ${path.relative(root, shaFile)}`);
console.log(`  ${hash}`);

// ---------------------------------------------------------------- 5. 复核

step(5, '复核包内容');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-verify-'));
const dumpedAsar = path.join(tmpDir, 'app.asar');
const dumpedExe = path.join(tmpDir, 'ZXDesk.exe');
run(
  'python3',
  [
    path.join(root, 'build', 'verify-zip.py'),
    outZip,
    '--expect-version',
    pkg.version,
    '--dump-asar',
    dumpedAsar,
    '--dump-exe',
    dumpedExe,
  ],
  '包结构复核',
);

const ResEdit = await import('resedit');
const asar = (await import('@electron/asar')).default ?? (await import('@electron/asar'));

// 5a. asar 里的版本号，以及「仓库里的每个源码文件都在包里」
const packedPkg = JSON.parse(asar.extractFile(dumpedAsar, 'package.json').toString('utf8'));
if (packedPkg.version !== pkg.version) die(`包内 package.json 版本是 ${packedPkg.version}，期望 ${pkg.version}`);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
const srcFiles = walk(path.join(root, 'src')).map((f) => path.relative(root, f).split(path.sep).join('/'));
const missing = srcFiles.filter((rel) => {
  try {
    asar.extractFile(dumpedAsar, rel);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) die(`asar 里缺 ${missing.length} 个源码文件：${missing.slice(0, 5).join(', ')}`);
console.log(`✓ asar：${srcFiles.length} 个源码文件 + package.json，版本 ${packedPkg.version}`);

// 5b. exe 图标数 = ico 尺寸数（0.1.6 丢图标的教训）
// ⚠️ 直接从 ico 的**文件字节**取每张图（resedit 对 BMP 条目给的是 IconItem，不一定有 `.bin`）
const icoBuf = fs.readFileSync(path.join(root, 'src', 'shell', 'assets', 'icon.ico'));
const icoCount = icoBuf.readUInt16LE(4);
const icoBlobs = [];
for (let i = 0; i < icoCount; i += 1) {
  const at = 6 + i * 16;
  const size = icoBuf.readUInt32LE(at + 8);
  const offset = icoBuf.readUInt32LE(at + 12);
  icoBlobs.push(icoBuf.subarray(offset, offset + size));
}
const exeRes = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(fs.readFileSync(dumpedExe), { ignoreCert: true }));
const iconEntries = exeRes.entries.filter((e) => e.type === 3);
if (iconEntries.length !== icoCount) {
  die(`包内 exe 图标 ${iconEntries.length} 个，ico 有 ${icoCount} 个 —— 图标没写全`);
}
const hashOf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const icoHashes = icoBlobs.map(hashOf);
const exeHashes = iconEntries.map((e) => hashOf(Buffer.from(e.bin)));
if (JSON.stringify(icoHashes) !== JSON.stringify(exeHashes)) die('包内 exe 的图标与 icon.ico 不是同一份字节');
console.log(`✓ exe 图标：${iconEntries.length} 个，与 icon.ico 逐字节一致`);

fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------- 总结

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
console.log(`
✓ 出包完成（${((Date.now() - started) / 1000).toFixed(0)} 秒）
  包     ${outZip}
  大小   ${zipBuf.length.toLocaleString('en-US')} 字节（${mb(zipBuf.length)}）
  校验   ${shaFile}
  sha256 ${hash}
  版本   ${pkg.version}（包内一致）
`);
