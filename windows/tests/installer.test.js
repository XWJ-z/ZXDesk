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
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { decideDataDir, hasExistingData, parseIni, readInstallConfig } from '../src/main/store/paths.js';

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
  assert.equal(d.dir, path.join('C:\\LA', 'ZXDesk', 'data'), '兜底口径与安装程序默认值一致（…\\ZXDesk\\data）');
  assert.equal(d.mode, 'fallback');
  assert.match(d.warning, /安装时选的数据目录不可写/);
});

test('decideDataDir：兜底时旧位置（…\\ZXDesk）里有数据就用旧的，别让用户像换了台机器', () => {
  const base = { isPackaged: true, exeDir: 'C:\\Apps', devDir: 'dev', localAppData: 'C:\\LA', canWrite: () => false };
  const oldWithData = path.join('C:\\LA', 'ZXDesk');
  const d = decideDataDir({ ...base, hasData: (dir) => dir === oldWithData });
  assert.equal(d.dir, oldWithData, '0.2.1 及以前的数据在上一级，必须接着用');
  assert.equal(d.mode, 'fallback');

  const newWithData = path.join('C:\\LA', 'ZXDesk', 'data');
  const d2 = decideDataDir({ ...base, hasData: (dir) => dir === newWithData });
  assert.equal(d2.dir, newWithData, '新口径位置有数据就用新口径');
});

test('hasExistingData：只认程序自己写的标志文件（与安装脚本的判据一致）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-data-'));
  try {
    assert.equal(hasExistingData(dir), false, '空目录不算有数据');
    fs.writeFileSync(path.join(dir, 'prefs.json'), '{}', 'utf8');
    assert.equal(hasExistingData(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-data2-'));
  try {
    fs.mkdirSync(path.join(dir2, 'profile'), { recursive: true });
    assert.equal(hasExistingData(dir2), true, 'profile 子目录也算（Electron 会话数据）');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 安装脚本

test('installer.nsi：数据路径页在目录页之后（页序不能反）', () => {
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

// ---------------------------------------------------------------- 0.2.2：自动识别旧数据目录
//
// 实际问题：装 0.2.2 时默认值写死成 %LOCALAPPDATA%\ZXDesk\data
// 明明机器上有在用的数据也不认，装完像「全新的一样」。锁死下面几条。

test('installer.nsi：默认值不再写死 —— .onInit 走 DetectDataDir', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  assert.match(nsi, /Function \.onInit\s+Call DetectDataDir/, '.onInit 必须调识别函数');
  assert.ok(
    !/Function \.onInit\s+StrCpy \$DataDir "\$LOCALAPPDATA\\ZXDesk\\data"\s+FunctionEnd/.test(nsi),
    '⛔ 不能只写死默认值（这是被指出的那个 bug）',
  );
  assert.match(nsi, /Function DetectDataDir/, '要有识别函数');
});

test('installer.nsi：识别顺序 = 注册表 → install.ini → 常见位置 → 默认值', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  const reg = nsi.indexOf('ReadRegStr $LastDataDir HKCU "${APP_KEY}" "DataDir"');
  const ini = nsi.indexOf('ReadINIStr $1 "$0\\install.ini" "install" "data"');
  const local = nsi.indexOf('TryDataCandidate "$LOCALAPPDATA\\ZXDesk\\data"');
  const def = nsi.indexOf('StrCpy $DataDir "$DefaultDir"');
  assert.ok(reg > 0, '要读上次安装写的数据目录');
  assert.ok(ini > reg, '注册表之后再看上一个版本的 install.ini');
  assert.ok(local > ini, '再看常见位置');
  assert.ok(def > local, '最后才回默认值');
});

test('installer.nsi：每个候选都要先验证「里面确实有数据」', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  for (const mark of ['prefs.json', 'session.bin', 'credential.bin', 'tofu.json', 'notices-cache.json']) {
    assert.ok(nsi.includes(`$ProbeDir\\${mark}`), `判据要有 ${mark}（与 paths.js 的 dataFiles 对齐）`);
  }
  assert.match(nsi, /Function ProbeDataDir/, '要有探测函数');
  assert.match(nsi, /!macro TryDataCandidate/, '候选要能复用（避免四份重复逻辑）');

  const probe = nsi.slice(nsi.indexOf('Function ProbeDataDir'), nsi.indexOf('Function .onInit'));
  assert.ok(!/zxdProbeSession:[\s\S]{0,400}zxdProbeSession:/.test(probe), '标签不能重复');
});

test('installer.nsi：页面要告诉用户默认值是怎么来的（认到 / 没认到）', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  assert.match(nsi, /\$DataDirHasData == 1/, '要按「有没有数据」区分文案');
  assert.match(nsi, /已自动填入：\$DataSource/, '要说清楚是从哪认出来的');
  assert.match(nsi, /安装后直接接着用/, '要让用户知道数据不会丢');
  assert.match(nsi, /没有找到已有数据，这是首次安装的默认位置/, '首次安装也要说明');
  // 绿色版的数据在解压目录，安装器按注册表 / 常见位置都找不到 ⇒ 必须给出指引
  assert.match(nsi, /数据在解压目录的 data 文件夹里/, '要告诉绿色版用户去哪找自己的数据');
});

test('installer.nsi：路径规范化与目录校验（尾斜杠 / 安装目录子目录）', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  assert.match(nsi, /StrCpy \$DataDir \$DataDir -1/, '要去掉结尾反斜杠，否则比较与 install.ini 都多一字符');
  assert.match(nsi, /StrLen \$3 \$DataDir/, '盘根（D:\\）不能砍成 D:');
  assert.match(nsi, /数据目录不能放在安装目录里/, '任何子目录都不许（不只是 …\\data）');
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

test('package.json：0.2.2 且注册 dist:setup', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.2');
  assert.equal(pkg.scripts['dist:setup'], 'node build/make-setup.js');
});

// ---------------------------------------------------------------- 更新安装：先关掉正在运行的 ZXDesk
//
// 0.2.2 真机第一次自动更新被打断：安装包覆盖 $INSTDIR\ZXDesk.exe 时进程还开着，
// File 失败 → 安装中止。真机报过一次。

test('installer.nsi：安装前关闭正在运行的 ZXDesk（否则覆盖 exe 失败、安装中止）', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  assert.match(nsi, /Function CloseRunningApp/, '要有「关闭正在运行的程序」');
  assert.match(nsi, /taskkill\.exe" \/IM "\$\{PRODUCT_EXE\}"/, '按进程名关');
  assert.match(nsi, /\/F \/IM/, '「关闭到托盘」会拦 WM_CLOSE，必须能强杀');
  assert.match(nsi, /MB_RETRYCANCEL/, '关不掉要给「重试」，不能默不作声地失败');

  const callAt = nsi.indexOf('Call CloseRunningApp');
  const fileAt = nsi.indexOf('File /r "${SRC_DIR}/*"');
  assert.ok(callAt > 0, '要真的调用');
  assert.ok(fileAt > callAt, '必须在复制文件之前调用（之后就没意义了）');

  // ⛔ 不能放在 .onInit：用户在向导里点「取消」时，不该把正在用的程序关掉
  const onInitStart = nsi.indexOf('Function .onInit');
  const onInitEnd = nsi.indexOf('Function DataPageCreate');
  assert.ok(!nsi.slice(onInitStart, onInitEnd).includes('CloseRunningApp'), '⛔ 别放进 .onInit');
});

test('更新：打开安装包前先把窗口最小化（安装向导别被我们挡在后面）', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  const start = main.indexOf('async function openDownloadedPackage');
  const end = main.indexOf('\nfunction ', start);
  const body = main.slice(start, end > 0 ? end : undefined);
  assert.match(body, /mainWindow\?\.minimize\?\.\(\)/, '要最小化主窗口');
  assert.ok(body.indexOf('minimize') < body.indexOf('shell.openPath'), '先最小化，再打开安装包');
});
