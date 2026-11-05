/**
 * 菜单栏结构（**Windows 规范四组**：文件 / 查看 / 工具 / 帮助）。
 *
 * 0.2.6 起按 **Windows 规范**重排 —— 推翻了照 Android 抽屉分组的旧口径
 * （连接 / 模式 / 账户 / 设置 / 帮助）。
 * 本文件守两件事：**四组齐全**、**每组里的入口不被人手滑拆散**。
 * 读的是主进程源码（与 shell-static 同套路）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'shell', 'index.html'), 'utf8');

/** 取 `showMenu` 函数体（到下一个顶层 `app.on(` 之前）。 */
function showMenuSource() {
  const start = main.indexOf('function showMenu(which)');
  assert.ok(start > 0, '找不到 showMenu');
  const end = main.indexOf('app.on(', start);
  return main.slice(start, end);
}

test('顶栏是 Windows 规范四组：文件 / 查看 / 工具 / 帮助', () => {
  for (const which of ['file', 'view', 'tools', 'help']) {
    assert.match(html, new RegExp(`data-menu="${which}"`), `壳里缺菜单按钮：${which}`);
  }
  // 旧的分组（照 Android 抽屉）⛔ 不能还挂在壳上
  for (const legacy of ['connect', 'settings']) {
    assert.ok(!html.includes(`data-menu="${legacy}"`), `旧的菜单按钮还在：${legacy}`);
  }
  const src = showMenuSource();
  for (const key of ['file:', 'view:', 'tools:', 'help:']) {
    assert.ok(src.includes(key), `showMenu 里缺模板：${key}`);
  }
});

test('文件菜单：连接信息 → 换个地址 → 切换账号 → 退出登录 → 退出', () => {
  const src = showMenuSource();
  const fileBlock = src.slice(src.indexOf('file: ['), src.indexOf('view: ['));
  const need = ['连接信息…', '换个地址…', '切换账号', '退出登录…', "role: 'quit'"];
  let last = -1;
  for (const token of need) {
    const at = fileBlock.indexOf(token);
    assert.ok(at > 0, `文件菜单里缺：${token}`);
    assert.ok(at > last, `顺序不对：${token} 应排在上一项之后`);
    last = at;
  }
});

test('连接身份不在菜单里（那是标题栏的活）', () => {
  const src = showMenuSource();
  assert.ok(!/ZXDesk · \$\{identity\}/.test(src), '身份行⛔ 不能留在菜单里');
  assert.match(main, /function updateWindowTitle\(state\)/, '身份要由窗口标题承载');
  assert.match(main, /ZXDesk 工作台 — \$\{identity\}/);
});

test('不做假入口：菜单里不再有「模式」占位项', () => {
  const src = showMenuSource();
  assert.ok(!/label: '模式'/.test(src), '「模式」三项本来就是占位，菜单里留着只会让人以为坏了');
  assert.ok(!/规划中/.test(src), '菜单里⛔ 不出现「规划中」');
});

test('查看菜单：刷新 / 后退 / 前进 / 缩放', () => {
  const src = showMenuSource();
  const block = src.slice(src.indexOf('view: ['), src.indexOf('tools: ['));
  for (const token of ['刷新 (F5 / Ctrl+R)', '后退 (Alt+←)', '前进 (Alt+→)', '放大', '缩小', '重置缩放']) {
    assert.ok(block.includes(token), `查看菜单里缺：${token}`);
  }
});

test('工具菜单：设置 / 日志目录 / 检查更新', () => {
  const src = showMenuSource();
  const block = src.slice(src.indexOf('tools: ['), src.indexOf('help: helpItems'));
  assert.ok(block.includes("label: '设置'"), '设置要在工具菜单里');
  assert.ok(block.includes('打开日志目录'));
  assert.ok(block.includes('检查更新'));
  assert.match(block, /settingsMenuTemplate\(\)/, '设置子菜单沿用同一份，⛔ 手写第二份');
});

test('「更多」三项各开一个信息窗口，文档名与 IPC 白名单对得上', () => {
  const src = showMenuSource();
  assert.match(src, /openInfo\('eula'\)/);
  assert.match(src, /openInfo\('donate'\)/);
  assert.match(src, /openInfo\('releases'\)/);
  assert.match(src, /INFO_DOCS\[doc\]/, '标题要从 INFO_DOCS 取，⛔ 手写第二份');
});

test('帮助子菜单只有一份：工具 / 帮助共用同一个 helpItems 数组', () => {
  const src = showMenuSource();
  assert.match(src, /const helpItems = \[/, '帮助项要抽成一份');
  assert.match(src, /help: helpItems/);
  assert.equal((src.match(/label: '复制诊断'/g) || []).length, 1, '⛔ 帮助项出现两份');
});

test('账户级动作跟「文件」走：退出登录只在文件菜单里出现一次', () => {
  const src = showMenuSource();
  assert.equal((src.match(/act\('panel\.logout'\)/g) || []).length, 1);
  const fileAt = src.indexOf('file: [');
  const viewAt = src.indexOf('view: [');
  const logoutAt = src.indexOf("act('panel.logout')");
  assert.ok(fileAt > 0 && logoutAt > fileAt && logoutAt < viewAt, '退出登录要在文件菜单段内');
});

test('切换账号从菜单**直接打开弹窗**（列表与「新增账号」都在弹窗里）', () => {
  const src = showMenuSource();
  assert.match(src, /label: '切换账号…'/, '菜单项文案');
  assert.match(src, /controller\?\.openAccounts\(\)/, '点了要打开同一个弹窗');
  assert.ok(!/submenu: accountItems/.test(src), '⛔ 不再是子菜单列表（0.2.6 改成弹窗）');
});

test('信息窗口：沙箱 + 上下文隔离 + 来源校验，⛔ 不开 node', () => {
  const start = main.indexOf('function openInfoWindow(doc)');
  const end = main.indexOf('/**', start);
  const fn = main.slice(start, end > 0 ? end : start + 4000);
  assert.match(fn, /preload: path\.join\(shellDir, 'preload\.cjs'\)/);
  assert.match(fn, /sandbox: true/);
  assert.match(fn, /contextIsolation: true/);
  assert.match(fn, /nodeIntegration: false/);
  assert.match(fn, /will-navigate/, '外部导航要拦');
  assert.match(fn, /will-attach-webview/, '⛔ 不许挂 webview');
  assert.match(fn, /loadFile\(path\.join\(shellDir, 'info\.html'\), \{ query: \{ doc \} \}\)/);
});

test('信息窗口标题：主进程 INFO_DOCS 与页面 DOCS 两份文案一致（防漂移）', () => {
  const page = fs.readFileSync(path.join(root, 'src', 'shell', 'info.js'), 'utf8');
  const titles = (src) => [...src.matchAll(/\btitle:\s*'([^']+)'/g)].map((m) => m[1]).sort();
  const start = main.indexOf('const INFO_DOCS');
  assert.ok(start > 0, '找不到 INFO_DOCS');
  const block = main.slice(start, main.indexOf('function openInfoWindow', start));
  assert.deepEqual(titles(block), titles(page), '窗口标题与页面标题必须是同一套文案');
});

test('readInfoDoc：只读 assets 下的两个固定文件（⛔ 不接受路径）', () => {
  const start = main.indexOf('async function readInfoDoc(kind)');
  assert.ok(start > 0);
  const fn = main.slice(start, start + 1200);
  assert.match(fn, /kind === 'eula'/);
  assert.match(fn, /kind === 'releases'/);
  assert.match(fn, /path\.join\(shellDir, 'assets', 'eula\.txt'\)/);
  assert.match(fn, /path\.join\(shellDir, 'assets', 'releases\.json'\)/);
  assert.ok(!/readFile\(kind|readFile\(filePath|readFile\(p\)/.test(fn), '⛔ 不把入参当路径');
});
