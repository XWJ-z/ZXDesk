/**
 * 打 Windows **安装包**（正式版）：`npm run dist:setup`。
 *
 * 正式版口径：**正式版一律给安装包**；绿色 zip 只用于测试版。
 * 所以这个脚本产出的是 `release/zxdesk-windows-<version>-x64-setup.exe`，不是绿色包。
 *
 * 前置：先有应用目录（`build/out/ZXDesk-win32-x64`）。脚本会自己检查，没有就提示先跑 `npm run dist`。
 * 编译：本机用 `ttt/tools/nsis/makensis`（免 root 便携版，见该目录 README）。
 *
 * 检查项（失败即退 1）：
 * - 应用目录存在、里面 `ZXDesk.exe` 带我们的图标（7 个尺寸，防「打了张没图标的包」）；
 * - makensis 编译成功，产物是 PE（`MZ` / `PE\0\0`）；
 * - 产物 > 80 MB（说明真把应用打进去了，不是空壳）；
 * - 写 `.sha256`（与 `sha256sum` 同格式）。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const srcDir = path.join(root, 'build', 'out', 'ZXDesk-win32-x64');
const nsi = path.join(root, 'build', 'installer.nsi');
const iconFile = path.join(root, 'src', 'shell', 'assets', 'icon.ico');
const makensis = path.join(root, '..', '..', 'ttt', 'tools', 'nsis', 'makensis');
const releaseDir = path.resolve(root, '..', '..', 'release');
const outFile = path.join(releaseDir, `zxdesk-windows-${version}-x64-setup.exe`);

const die = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- 前置检查

if (!fs.existsSync(path.join(srcDir, 'ZXDesk.exe'))) {
  die(`没有应用目录：${srcDir}\n  先跑 npm run dist（它负责打包 + 写图标 + 自检），再来 dist:setup。`);
}
if (!fs.existsSync(nsi)) die(`缺安装脚本：${nsi}`);
if (!fs.existsSync(iconFile)) die(`缺图标：${iconFile}`);
if (!fs.existsSync(makensis)) {
  die(
    `没有 makensis：${makensis}\n` +
      `  装法（免 root）：apt-get download nsis nsis-common && dpkg-deb -x *.deb ttt/tools/nsis\n` +
      `  见 ttt/tools/nsis/README.md`,
  );
}

// 应用目录里的 exe 必须带图标（0.1.6 的教训：发出去没图标）
const ResEdit = await import('resedit');
const exeRes = ResEdit.NtExecutableResource.from(
  ResEdit.NtExecutable.from(fs.readFileSync(path.join(srcDir, 'ZXDesk.exe')), { ignoreCert: true }),
);
const rtIcons = exeRes.entries.filter((e) => e.type === 3).length;
const groups = exeRes.entries.filter((e) => e.type === 14);
if (rtIcons < 7 || groups.length !== 1) {
  die(`应用目录里的 exe 图标不对（组 ${groups.length} 个 / RT_ICON ${rtIcons} 条）—— 先跑 npm run dist 重打包。`);
}
console.log(`✓ 应用目录就绪：${path.relative(root, srcDir)}（图标 ${rtIcons} 个尺寸）`);

// 许可协议：每次编译前由 `build/eula.txt` 重新生成 `build/eula.rtf`（安装向导里嵌的是 rtf）
const eula = spawnSync(process.execPath, [path.join(root, 'build', 'make-eula.js')], { stdio: 'inherit' });
if (eula.error) die(`许可协议生成脚本起不来：${eula.error.message}`);
if (eula.status !== 0) die('许可协议生成失败（先修 build/eula.txt）');
if (!fs.existsSync(path.join(root, 'build', 'eula.rtf'))) die('缺 build/eula.rtf');

// ---------------------------------------------------------------- 编译

fs.mkdirSync(releaseDir, { recursive: true });
console.log(`\n编译安装包：${version} → ${path.relative(root, outFile)}`);
const started = Date.now();
const child = spawnSync(
  makensis,
  [
    `-DAPP_VERSION=${version}`,
    `-DSRC_DIR=${srcDir}`,
    `-DOUT_FILE=${outFile}`,
    `-DICON_FILE=${iconFile}`,
    '-V2',
    nsi,
  ],
  { stdio: 'inherit' },
);
if (child.error) die(`makensis 起不来：${child.error.message}`);
if (child.status !== 0) die(`makensis 失败（exit ${child.status}）`);
if (!fs.existsSync(outFile)) die('makensis 报成功但没产物');

// ---------------------------------------------------------------- 核对

const buf = fs.readFileSync(outFile);
const peOff = buf.readUInt32LE(0x3c);
const isPe = buf[0] === 0x4d && buf[1] === 0x5a && buf.toString('latin1', peOff, peOff + 4) === 'PE\0\0';
if (!isPe) die('产物不是合法 PE');
const mb = buf.length / 1024 / 1024;
if (mb < 80) die(`产物只有 ${mb.toFixed(1)} MB，装不下应用（应在 90 MB 上下）`);

const hash = crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = `${outFile}.sha256`;
fs.writeFileSync(shaFile, `${hash}  ${path.basename(outFile)}\n`, 'utf8');

console.log(`
✓ 安装包完成（${((Date.now() - started) / 1000).toFixed(0)} 秒）
  文件   ${outFile}
  大小   ${buf.length.toLocaleString('en-US')} 字节（${mb.toFixed(1)} MiB）
  校验   ${shaFile}
  sha256 ${hash}
  版本   ${version}（许可协议 / 安装目录 / 数据目录三页齐全；卸载默认保留数据）
`);
