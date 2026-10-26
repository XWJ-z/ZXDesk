/**
 * 安装包与数据目录（0.2.1 正式版）。
 *
 * 两条口径：
 * 1. **正式版一律给安装包**；绿色 zip 只用于测试版；
 * 2. 安装时必须让用户选「安装路径」和「数据路径」；数据目录独立于程序目录，卸载默认保留。
 *
 * 这里锁的是：数据目录解析优先级、install.ini 解析、以及安装脚本的关键结构。
 * ⛔ 不在这里真跑 makensis（那是 `npm run dist:setup` 的活）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { decideDataDir, parseIni, readInstallConfig } from '../src/main/store/paths.js';

const root = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- 数据目录

test('parseIni：只认 [install] 段，忽略注释/其它段/坏行', () => {
  const text = [
    '; 注释',
    '[other]',
    'data=不应该被读到',
    '[install]',
    'dir=C:\\Program Files\\ZXDesk',
    'data=D:\\ZXDeskData',
    'version=0.2.1',
    '坏行没有等号',
    '',
  ].join('\r\n');
  assert.deepEqual(parseIni(text), {
    dir: 'C:\\Program Files\\ZXDesk',
    data: 'D:\\ZXDeskData',
    version: '0.2.1',
  });
});

test('readInstallConfig：读不到 / 坏了都返回 null（不影响启动）', () => {
  const okFs = { readFileSync: () => '[install]\ndata=D:\\ZXDeskData\nversion=0.2.1\n' };
  const cfg = readInstallConfig('C:\\Apps\\ZXDesk', okFs);
  assert.equal(cfg.dataDir, 'D:\\ZXDeskData');
  assert.equal(cfg.version, '0.2.1');

  assert.equal(readInstallConfig('C:\\Apps', { readFileSync: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(readInstallConfig('C:\\Apps', { readFileSync: () => '不是 ini' }), null);
});

test('decideDataDir：安装版走 install.ini 的数据目录（不是程序目录）', () => {
  const d = decideDataDir({
    isPackaged: true,
    exeDir: 'C:\\Program Files\\ZXDesk',
    devDir: 'dev',
    localAppData: 'C:\\Users\\x\\AppData\\Local',
    installDataDir: 'D:\\ZXDeskData',
    canWrite: () => true,
  });
  assert.equal(d.dir, 'D:\\ZXDeskData');
  assert.equal(d.mode, 'installed');
});

test('decideDataDir：环境变量 > install.ini > 程序目录 data/ > LOCALAPPDATA', () => {
  const base = {
    isPackaged: true,
    exeDir: 'C:\\Apps\\ZXDesk',
    devDir: 'dev',
    localAppData: 'C:\\LA',
    canWrite: () => true,
  };
  assert.equal(decideDataDir({ ...base, installDataDir: 'D:\\D', envDataDir: 'E:\\E' }).dir, 'E:\\E');
  assert.equal(decideDataDir({ ...base, installDataDir: 'D:\\D' }).dir, 'D:\\D');
  assert.equal(decideDataDir({ ...base }).dir, path.join('C:\\Apps\\ZXDesk', 'data'));
  assert.equal(decideDataDir({ ...base }).mode, 'portable');
});

test('decideDataDir：安装指定的数据目录不可写 ⇒ 回落 LOCALAPPDATA 并说明', () => {
  const d = decideDataDir({
    isPackaged: true,
    exeDir: 'C:\\Apps',
    devDir: 'dev',
    localAppData: 'C:\\LA',
    installDataDir: 'Z:\\只读',
    canWrite: (dir) => dir !== 'Z:\\只读',
  });
  assert.equal(d.dir, path.join('C:\\LA', 'ZXDesk'));
  assert.equal(d.mode, 'fallback');
  assert.match(d.warning, /安装时选的数据目录不可写/);
});

// ---------------------------------------------------------------- 安装脚本

test('installer.nsi：两页都要有（安装路径 + 数据路径），且数据页在目录页之后', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  const dirPage = nsi.indexOf('MUI_PAGE_DIRECTORY');
  const dataPage = nsi.indexOf('Page custom DataPageCreate DataPageLeave');
  assert.ok(dirPage > 0, '要有 MUI_PAGE_DIRECTORY（安装路径）');
  assert.ok(dataPage > dirPage, `数据路径页必须在安装路径页之后（dir@${dirPage}, data@${dataPage}）`);
  assert.match(nsi, /NSD_CreateDirRequest/, '数据页要能填/选目录');
  assert.match(nsi, /nsDialogs::SelectFolderDialog/, '要有「浏览…」');
  assert.match(nsi, /MUI_LANGUAGE "SimpChinese"/, '中文界面');
  assert.match(nsi, /RequestExecutionLevel admin/, '写 Program Files 需要管理员');
});

test('installer.nsi：写 install.ini / 注册表 / 卸载默认保留数据', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  assert.match(nsi, /WriteINIStr "\$INSTDIR\\install\.ini" "install" "dir"/);
  assert.match(nsi, /WriteINIStr "\$INSTDIR\\install\.ini" "install" "data" "\$DataDir"/);
  assert.match(nsi, /WriteRegStr HKCU "\$\{APP_KEY\}" "DataDir"/);
  assert.ok(
    nsi.includes('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZXDesk'),
    '要有卸载项（HKCU 的 Uninstall 键）',
  );
  // 卸载时问「要不要删数据」，默认按钮是「否」
  assert.match(nsi, /MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2/, '默认不删数据');
  assert.match(nsi, /RMDir \/r "\$DataDir"/, '勾了才删数据目录');
  assert.match(nsi, /File \/r "\$\{SRC_DIR\}\/\*"/, '要整目录打进去');
});

test('make-setup：编译前先验应用目录与图标，产物核对 PE/体积，并写 sha256', () => {
  const src = fs.readFileSync(path.join(root, 'build', 'make-setup.js'), 'utf8');
  assert.match(src, /没有应用目录/, '缺应用目录要提示先跑 dist');
  assert.match(src, /rtIcons < 7 \|\| groups\.length !== 1/, '要验应用 exe 的图标');
  assert.match(src, /makensis/, '要调 makensis');
  assert.match(src, /PE\\0\\0|PE\\\\0\\\\0/, '产物要是 PE');
  assert.match(src, /mb < 80/, '体积过小视为空壳');
  assert.match(src, /writeFileSync\(shaFile, `\$\{hash\}  \$\{path\.basename\(outFile\)\}\\n`/, 'sha 两空格格式');
});

test('package.json：0.2.1 且注册 dist:setup', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.1');
  assert.equal(pkg.scripts['dist:setup'], 'node build/make-setup.js');
});
