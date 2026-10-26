/**
 * 壳的静态体检（本机没有显示器，跑不了 Electron，就把能静态验的都验掉）。
 *
 * 这些断言对应的都是「首跑直接白屏 / 按钮点了没反应」那类故障：
 * 引用了不存在的文件、CSP 把脚本挡了、内联事件被 CSP 拦、preload 路径写错。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const shellDir = path.join(root, 'src', 'shell');
const html = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');

test('index.html 引用的 css / js / preload 都真实存在', () => {
  for (const rel of ['app.css', 'app.js']) {
    assert.match(html, new RegExp(rel.replace('.', '\\.')));
    assert.ok(fs.existsSync(path.join(shellDir, rel)), `缺文件：${rel}`);
  }
  assert.ok(fs.existsSync(path.join(shellDir, 'preload.cjs')), '缺 preload.cjs');
  assert.ok(fs.existsSync(path.join(shellDir, 'assets', 'icon.ico')), '缺 icon.ico');
  assert.ok(fs.existsSync(path.join(shellDir, 'assets', 'icon.png')), '缺 icon.png');
});

test('CSP 存在，且脚本只允许 self（脚本不内联）', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.ok(!html.includes("script-src 'self' 'unsafe-inline'"), '脚本不许开 unsafe-inline（那等于放行内联脚本）');
});

test('没有内联 <script> 与内联事件（否则 CSP 会直接挡掉）', () => {
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
  assert.deepEqual(inlineScripts, [], '不允许内联脚本');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), '不允许内联事件处理器（onclick= 之类）');
});

test('壳页面固定浅色（系统深色时不跟着变）', () => {
  const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--primary:\s*#4f46e5/i);
  assert.match(css, /--background:\s*#f5f7fb/i);
});

test('preload 只暴露窄 API，不把 ipcRenderer 整个递出去', () => {
  const preload = fs.readFileSync(path.join(shellDir, 'preload.cjs'), 'utf8');
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /zxdesk:state:get/);
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preload), '不能直接暴露 ipcRenderer');
});

test('壳界面里没有硬编码的凭据 / 演示密码，也不往浏览器存储里写', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.ok(!/password\s*[:=]\s*['"][^'"]+['"]/.test(app), 'app.js 里不该有写死的密码');
  // 注释里可以提 localStorage（说明「不用它」），但不许真的调用它
  assert.ok(!/(localStorage|sessionStorage)\s*\.\s*(setItem|getItem|removeItem)/.test(app), '壳不往浏览器存储里写东西');
});

test('主进程与壳的每个相对 import 都指向真实文件（node --check 查不出这种错）', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'tests'));

  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} → ${match[1]}`);
    }
    for (const match of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} → ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `有引用指向不存在的文件：\n${missing.join('\n')}`);
});

test('package.json：type/mode/版本/依赖纪律', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.version, '0.2.1');
  assert.equal(pkg.productName, 'ZXDesk');
  assert.equal(pkg.main, 'src/main/index.js');
  assert.deepEqual(pkg.dependencies, {}, 'dependencies 必须为空（零运行时依赖）');
  for (const name of ['electron', '@electron/packager', 'resedit']) {
    assert.ok(pkg.devDependencies[name], `缺 devDependency：${name}`);
  }
  assert.equal(Object.keys(pkg.devDependencies).length, 3, '只允许这三个 devDependencies');
});

test('窗口标题与最小尺寸正确；默认 1280×820 来自偏好默认值', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  assert.match(main, /title: 'ZXDesk 工作台'/);
  assert.match(main, /minWidth: 1100/);
  assert.match(main, /minHeight: 720/);
  // 默认尺寸不再写死在窗口里（那是偏好的事），而是读 prefs
  assert.match(main, /width: remembered\.width/);
  const prefs = fs.readFileSync(path.join(root, 'src', 'main', 'store', 'prefs.js'), 'utf8');
  assert.match(prefs, /width: 1280/);
  assert.match(prefs, /height: 820/);
});

test('远程视图没有 preload（安全边界写在代码里，不靠自觉）', () => {
  const view = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'view.js'), 'utf8');
  const idx = view.indexOf('new WebContentsView');
  const block = view.slice(idx, idx + 700);
  assert.ok(block.includes('sandbox: true'));
  assert.ok(block.includes('contextIsolation: true'));
  assert.ok(block.includes('nodeIntegration: false'));
  assert.ok(!block.includes('preload:'), '远程视图不许有 preload');
});

test('日志相关代码里没有把密码写进日志的路径', () => {
  const files = ['src/main/controller.js', 'src/main/login/flow.js', 'src/main/browser/view.js'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const risky = /logger\.(info|warn|error)\([^)]*password/i.test(text);
    assert.equal(risky, false, `${rel} 里疑似把密码写进日志`);
  }
});

test('从 electron 导入的名字都真实存在（拼错一个名字 = 启动即崩，node --check 查不出）', () => {
  const dts = fs.readFileSync(path.join(root, 'node_modules', 'electron', 'electron.d.ts'), 'utf8');
  const files = ['src/main/index.js'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]electron['"]/g)) {
      const names = match[1]
        .split(',')
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      for (const name of names) {
        const exists = new RegExp(`^\\s+(class|const|function|interface|enum|namespace)\\s+${name}\\b|^\\s+${name}:\\s`, 'm').test(dts);
        assert.ok(exists, `electron 里没有导出 ${name}（导入它会直接在启动时崩）`);
      }
    }
  }
});

test('启动顺序：initPrefs 在 createWindow 之前，buildController 之后，loadShell 最后', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  // bootUi 里把真函数填进 boot 序列；顺序本身由 boot.js 固定（另有 boot-order.test.js 直接跑）
  const bootUiAt = main.indexOf('async function bootUi');
  assert.ok(bootUiAt > 0, '应该抽成 bootUi（--smoke 与正常启动走同一条路）');
  const bootUi = main.slice(bootUiAt, main.indexOf('function attachShellHandlers'));
  for (const name of ['configureSession', 'initPrefs', 'buildController', 'registerIpc', 'attachHandlers', 'loadShell']) {
    assert.match(bootUi, new RegExp(`\\b${name}\\b`), `bootUi 的依赖里缺 ${name}`);
  }
  // whenReady 只应该调 bootUi，不该自己按顺序摆步骤
  const whenReady = main.slice(main.indexOf('app.whenReady()'), bootUiAt);
  assert.match(whenReady, /await bootUi\(\{ smoke: isSmoke \}\)/);
  assert.ok(!whenReady.includes('createWindow();'), 'whenReady 里不该再直接 createWindow（顺序统一走 boot.js）');
  // 护栏：createWindow 自己也要挡住「prefs 还没建」
  assert.match(main, /启动顺序错误：prefs 未初始化/);
});

test('buildController 不再创建 prefs（那是 initPrefs 的活）', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  const buildAt = main.indexOf('function buildController()');
  const body = main.slice(buildAt, main.indexOf('// ---------------------------------------------------------------- ④ 壳窗口'));
  assert.ok(!body.includes('new PrefsStore('), '0.1.0 首跑崩就崩在这：prefs 在 buildController 里才建');
  assert.match(main.slice(main.indexOf('function initPrefs'), buildAt), /new PrefsStore\(/);
});

test('版本号三处一致：package.json / 壳标题常量 / 包名', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const controller = fs.readFileSync(path.join(root, 'src', 'main', 'controller.js'), 'utf8');
  const match = controller.match(/export const APP_VERSION = '([^']+)'/);
  assert.ok(match, 'controller.js 里应该有 APP_VERSION');
  assert.equal(match[1], pkg.version, `APP_VERSION(${match[1]}) 与 package.json(${pkg.version}) 不一致`);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号要是 semver');
});

test('壳脚本不用 type="module"（file:// 下 ES module 会被 CORS 拦掉＝白屏）', () => {
  const html = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');
  assert.ok(!/<script[^>]*type=["']module["']/.test(html), 'file:// 页面不能用 ES module，否则壳一片空白');
  assert.match(html, /<script src="app\.js" defer><\/script>/);
});

// ---------------------------------------------------------------- 0.1.2：壳必须把值带上 + 界面居中

test('壳把 2FA 的值随动作发出去（⛔ 别再只存本地）', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.match(app, /send\('twofa\.submitTotp',\s*\{\s*code/, '提交验证器必须带 code');
  assert.match(app, /send\('twofa\.submitEmail',\s*\{[\s\S]{0,120}?code:/, '提交邮箱验证必须带 email + code');
  assert.match(app, /document\.getElementById\('f-totp'\)/, '值要从输入框读（不能被状态推送冲掉）');
});

test('连接页文案：局域网也要账号；8990 只作显式兜底', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.match(app, /局域网也要登录飞牛账号/);
  assert.ok(!app.includes('局域网直连可不填'), '旧文案会鼓励用户走被拦的 8990');
  assert.match(app, /IP:8990/, '要告诉用户 8990 这个例外');
});

test('内容区上下左右居中：flex + 竖向 auto 边距', () => {
  const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
  const content = css.slice(css.indexOf('.content {'), css.indexOf('body.no-toolbar .content'));
  assert.match(content, /display:\s*flex/);
  assert.match(content, /flex-direction:\s*column/);
  assert.match(content, /align-items:\s*center/);
  const wrap = css.slice(css.indexOf('.wrap {'), css.indexOf('.wrap-wide {'));
  assert.match(wrap, /margin:\s*auto 0/, '高度够时垂直居中，超高时从顶部滚');
  assert.match(wrap, /width:\s*100%/);
  // 浏览模式的空内容区不参与居中
  assert.match(css, /\.content\.empty\s*\{[^}]*display:\s*block/);
});

test('壳把主进程的 busy / error 合并回来（否则「验证中…」和红字永远不显示）', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.match(app, /busy: state\.connect\.busy/, '连接页的忙闲态要跟主进程');
  assert.match(app, /busy: server\.busy/, '2FA 的忙闲态要跟主进程');
  assert.match(app, /error: server\.error/, '2FA 的报错要跟主进程');
});

// ---------------------------------------------------------------- ③ 菜单栏与「显示」按钮（静态）

test('顶栏是文字菜单栏：没有徽标、没有图标按钮、没有内联 SVG', () => {
  const html = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');
  assert.match(html, /id="menubar"/, '应该有菜单栏容器');
  for (const menu of ['connect', 'view', 'help']) {
    assert.match(html, new RegExp(`data-menu="${menu}"`), `缺菜单：${menu}`);
  }
  assert.ok(!html.includes('brand-mark'), '0.1.4 去掉 ZX 徽标');
  assert.ok(!html.includes('icon-btn'), '0.1.4 去掉图标按钮');
  assert.ok(!/<svg/i.test(html), '壳里不该再有内联 SVG 图标');
});

test('preload 暴露 openMenu，通道名与主进程一致', () => {
  const preload = fs.readFileSync(path.join(shellDir, 'preload.cjs'), 'utf8');
  assert.match(preload, /openMenu: \(which\) => ipcRenderer\.invoke\(CHANNELS\.menu, which\)/);
  assert.match(preload, /menu: 'zxdesk:menu'/);
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.match(app, /api\.openMenu\(menu\.dataset\.menu\)/);
});

test('菜单栏仍是 44px，远程视图的偏移不用改', () => {
  const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
  const menubar = css.slice(css.indexOf('.menubar {'), css.indexOf('.menubar[hidden]'));
  assert.match(menubar, /height: var\(--toolbar-height\)/);
  assert.match(css, /--toolbar-height:\s*44px/);
  const view = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'view.js'), 'utf8');
  assert.match(view, /TOOLBAR_HEIGHT = 44/);
});

test('「显示 / 隐藏」是独立按钮，不换行', () => {
  const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
  const block = css.slice(css.indexOf('.row .link-btn {'), css.indexOf('.row .link-btn:hover'));
  assert.match(block, /flex:\s*0 0 auto/);
  assert.match(block, /white-space:\s*nowrap/);
  assert.match(block, /height:\s*44px/);
});

test('「记住密码」勾选会先写回本地副本（否则提交时被旧值盖回去）', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.match(app, /form\.rememberPassword = event\.target\.checked/);
});

// ---------------------------------------------------------------- 0.1.5：显示密码要能被状态带回来

test('render 合并里包含 showPassword / rememberPassword（否则「显示」点了没反应）', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  const merge = app.slice(app.indexOf('form = {'), app.indexOf('if (state.twofa)'));
  assert.match(merge, /showPassword: state\.connect\.showPassword/);
  assert.match(merge, /rememberPassword: state\.connect\.rememberPassword/);
});

test('「显示 / 隐藏」按钮仍是独立小按钮（不换行）', () => {
  const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
  const block = css.slice(css.indexOf('.row .link-btn {'), css.indexOf('.row .link-btn:hover'));
  assert.match(block, /white-space:\s*nowrap/);
  assert.match(block, /flex:\s*0 0 auto/);
});

// ---------------------------------------------------------------- 0.1.6：设置菜单 / 托盘 / 自启

test('顶栏有「设置」菜单，且仍然没有图标', () => {
  const html = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');
  assert.match(html, /data-menu="settings"[^>]*>设置</, '顶栏要有「设置」');
  for (const menu of ['connect', 'view', 'settings', 'help']) {
    assert.match(html, new RegExp(`data-menu="${menu}"`), `缺菜单：${menu}`);
  }
  assert.ok(!/<svg/i.test(html), '仍然不许有内联 SVG 图标');
});

test('主进程：菜单白名单含 settings；托盘 / 快捷方式 / 自启的落点都在', () => {
  const ipc = fs.readFileSync(path.join(root, 'src', 'main', 'ipc.js'), 'utf8');
  assert.match(ipc, /MENU_ALLOWLIST = Object\.freeze\(\['connect', 'view', 'settings', 'help'\]\)/);

  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  assert.match(main, /new Tray\(/, '托盘');
  assert.match(main, /writeShortcutLink/, '快捷方式 / 自启都靠它');
  const shortcuts = fs.readFileSync(path.join(root, 'src', 'main', 'store', 'shortcuts.js'), 'utf8');
  assert.match(shortcuts, /'Startup'/, '开机自启必须用启动文件夹（逻辑在 store/shortcuts.js）');
  assert.match(main, /shortcutDirs\(\)/, 'index 用的是 shortcuts.js 给的路径');
  assert.ok(!main.includes('setLoginItemSettings'), '⛔ 不用 app.setLoginItemSettings（会写注册表）');
  assert.match(main, /closeToTray/, '关闭到托盘');
});

// ---------------------------------------------------------------- 0.1.6 收尾：设置菜单 / 快捷方式图标

test('设置菜单不再显示启动文件夹长路径，改成可点的「打开启动文件夹」', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  const start = main.indexOf('function settingsMenuTemplate');
  const body = main.slice(start, main.indexOf('function createDesktopShortcut'));
 assert.ok(!body.includes('启动文件夹：${'), '菜单里不许再拼长路径');
  assert.match(body, /label: '打开启动文件夹'/, '要有可点的「打开启动文件夹」');
  assert.match(body, /openStartupFolder\(dirs\.startupDir\)/, '点了要真打开');
  // 勾选态仍然按文件是否存在
  assert.match(body, /isAutoStartEnabled\(\)/);
});

test('快捷方式图标指 exe 自己（不再用 asar 里的 icon.ico）', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  const start = main.indexOf('function shortcutArgs');
  const body = main.slice(start, start + 600);
  assert.match(body, /iconPath: process\.execPath/, 'icon 必须是 exe 自己');
  assert.ok(!/iconPath: iconPath/.test(body), '不能再用壳目录里的 icon.ico（asar 虚拟路径，Windows 读不到）');
  const shortcuts = fs.readFileSync(path.join(root, 'src', 'main', 'store', 'shortcuts.js'), 'utf8');
  assert.match(shortcuts, /iconPath = exePath/, '默认值就要回落到 exe');
  assert.match(shortcuts, /iconIndex = 0/);
});

// ---------------------------------------------------------------- 0.1.6 收尾：错误页只说人话

test('错误页只给人话：不渲染日志路径 / 已尝试 / 具体地址', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  const start = app.indexOf('function viewError');
  const body = app.slice(start, app.indexOf('function renderPanel'));
  assert.ok(body.includes('data-action="error.retry"'), '要有「重试」');
  assert.ok(body.includes('data-action="error.changeAddress"'), '要有「换个地址」');
  assert.ok(body.includes('data-action="diag.copy"'), '要有「复制诊断」');
  for (const leak of ['logPath', '已尝试', 'boot.log', '192.168.']) {
    assert.ok(!body.includes(leak), `错误页不该出现「${leak}」（细节走复制诊断）`);
  }
  // 主进程也不再往界面状态里塞日志路径
  const controller = fs.readFileSync(path.join(root, 'src', 'main', 'controller.js'), 'utf8');
  assert.ok(!/error: \{[^}]*logPath/.test(controller), 'state.error 不该带 logPath');
  assert.ok(!controller.includes('已尝试'), '⛔ 不再拼「已尝试」列表');
  assert.ok(!controller.includes('withRouteHint'), '⛔ 路由提示已删');
});

// ---------------------------------------------------------------- 0.1.6 收尾 2：登录失败内联 / 密码回填

test('登录失败那一行在「连接」按钮**下方**（⛔ 不再表单上方大块错误卡）', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  const start = app.indexOf('function viewConnect');
  const body = app.slice(start, app.indexOf('function viewTwofa'));
  const btn = body.indexOf('data-action="connect.submit"');
  const line = body.indexOf('class="error-line"');
  assert.ok(btn > 0 && line > 0, '按钮与错误行都要在');
  assert.ok(line > btn, `错误行必须在按钮之后（btn@${btn}，line@${line}）`);
  assert.ok(!body.includes('error-card'), '连接页不再用大块错误卡');
  assert.match(body, /role="alert"/, '错误行要能被读屏念出来');
});

test('预填的密码能渲染出来（本地没敲过就用主进程那份）', () => {
  const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /password: form\.password \|\| state\.connect\.password/,
    '合并时要带上 password，否则预填的值永远不显示',
  );
  const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
  assert.match(css, /\.error-line\s*\{[^}]*color: var\(--error-text\)/s, '错误行是红字');
});
