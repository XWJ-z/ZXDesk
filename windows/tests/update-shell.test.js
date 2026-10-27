/**
 * 更新界面的静态一致性。
 *
 * 检查更新是**独立窗口**（`src/shell/update.html`）—— 不是原生消息框，也不是壳里的自绘弹层：
 * 原生框撑不住「下载进度 + 按钮从下载变安装」这个过程；壳里画不了（`WebContentsView`
 * 永远盖在 DOM 之上，一藏视图就白屏）。壳里只留连接页顶部那条非模态提示。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { ACTION_ALLOWLIST } from '../src/main/ipc.js';

const root = path.resolve(import.meta.dirname, '..');
const shellDir = path.join(root, 'src', 'shell');
const html = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(shellDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(shellDir, 'app.css'), 'utf8');
const updateHtml = fs.readFileSync(path.join(shellDir, 'update.html'), 'utf8');
const updateJs = fs.readFileSync(path.join(shellDir, 'update.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');

test('壳与更新窗口里的每个 update.* 动作都在主进程白名单里', () => {
  const used = new Set();
  for (const source of [app, html, updateJs, updateHtml]) {
    for (const match of source.matchAll(/(?:data-action="|(?:action|act)\(')(update\.[a-z]+)/g)) used.add(match[1]);
  }
  assert.ok(used.has('update.download'), `更新窗口一定有「下载更新」，实际 ${[...used].join(' / ')}`);
  for (const action of used) {
    assert.ok(ACTION_ALLOWLIST.includes(action), `白名单缺动作：${action}（点了不会有任何反应）`);
  }
});

test('壳只保留连接页提示条，⛔ 不再有菜单栏更新按钮', () => {
  assert.match(html, /id="update-banner"/);
  assert.match(html, /id="update-banner-text"/);
  assert.match(html, /data-action="update\.open"[^>]*>查看</);
  assert.match(html, /data-action="update\.skip"[^>]*>以后再说</);
  assert.ok(!html.includes('id="update-badge"'), '浏览模式的信号改到「帮助 → 检查更新（有新版本）…」，不占菜单栏');
  assert.match(app, /function renderUpdateBanner\(/);
});

test('⛔ 壳里没有自绘弹窗（更新走独立窗口）', () => {
  assert.ok(!app.includes('modal-mask'), '壳不该有自绘遮罩');
  assert.ok(!app.includes('modal-card'), '壳不该有自绘卡片');
  assert.ok(!/function viewUpdate\(/.test(app), '壳里不该有更新视图');
  assert.ok(!/function viewNotice\(/.test(app), '壳里不该有公告视图');
  assert.ok(!css.includes('.modal-mask'), 'CSS 里不该残留弹层样式');
});

test('隐藏态由 CSS 兜住（⛔ display 会顶掉 HTML 的 hidden 属性）', () => {
  assert.match(css, /\.update-banner\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.notice-bar\[hidden\]\s*\{[^}]*display:\s*none/s);
});

test('壳不发网络请求：更新全在主进程（CSP 仍然 connect-src none）', () => {
  assert.match(html, /connect-src 'none'/);
  assert.ok(!/\bfetch\(/.test(app), '壳里不该直接发请求');
  assert.ok(!/ipcRenderer/.test(app), '壳不该碰 ipcRenderer');
});

test('主进程用独立 BrowserWindow，⛔ 不用 dialog.showMessageBox 装更新流程', () => {
  assert.match(main, /function openUpdateWindow\(/);
  assert.match(main, /update\.html/);
  assert.match(main, /modal:\s*true/, '更新窗口是主窗口的模态子窗（同 DSH）');
  assert.match(main, /resizable:\s*false/, '尺寸固定：560×640 的卡片放不下拉伸后的排版');
  assert.ok(!/createDialogs/.test(main), '原生消息框那套已经删掉');

  // 只看 openUpdateWindow 的函数体：别处的「关于」框用的是 dialog，不算更新流程
  const body = main.slice(main.indexOf('function openUpdateWindow('), main.indexOf('async function openDownloadedPackage'));
  assert.ok(body.length > 0, '拦不到 openUpdateWindow 的函数体');
  assert.ok(!/showMessageBox/.test(body), '更新不再走原生消息框');

  assert.match(main, /setProgressBar\(/, '下载时仍要有任务栏进度');
  assert.match(main, /openUpdateWindow,/, '要注入给 controller');
});

test('更新窗口结构：版本行 ＋ 徽章 ＋ 说明 ＋ 进度 ＋ 三个动作', () => {
  assert.match(updateHtml, /Content-Security-Policy/);
  assert.match(updateHtml, /connect-src 'none'/, '窗口不发网络请求');
  assert.match(updateHtml, /id="current"/);
  assert.match(updateHtml, /id="latest"/);
  assert.match(updateHtml, /id="badge"/);
  assert.match(updateHtml, /id="notes"/);
  assert.match(updateHtml, /id="progress"/);
  assert.match(updateHtml, /id="download"/);
  assert.match(updateHtml, /id="install"/);
  assert.match(updateHtml, /src="update\.js"/);
  assert.ok(fs.existsSync(path.join(shellDir, 'update.css')), '缺 update.css');
  assert.ok(!/fetch\(/.test(updateJs), '窗口里不发请求，全走 action');
});

test('连续失败：窗口给网盘出口，文案是定好的那句', () => {
  assert.match(updateHtml, /id="fallback"/, '要有网盘出口那一块');
  assert.match(updateHtml, /id="pan"[^>]*>前往百度网盘下载</);
  assert.match(
    updateHtml,
    /由于网络问题下载失败，请稍后再试或者前往百度网盘下载最新版本，手动更新。/,
    '这句是定稿文案，别改写',
  );
  assert.match(updateJs, /error\.kind === 'give-up'/, '只有「停手」态才给网盘');
  assert.match(updateJs, /el\.pan\.hidden = !fallbackUrl/, '服务器没配地址就不显示按钮');
  assert.match(updateJs, /act\('update\.pan'\)/);
  assert.match(updateJs, /act\('update\.download'\)/, '「再试一次」重走下载');
  assert.ok(ACTION_ALLOWLIST.includes('update.pan'), '白名单要放行 update.pan');
});

test('更新窗口的渲染规则：每个阶段都有话说，按钮只给一个下一步', () => {
  for (const phase of ['idle', 'checking', 'latest', 'available', 'downloading', 'ready', 'error']) {
    assert.match(updateJs, new RegExp(`\\b${phase}:`), `缺 ${phase} 阶段`);
  }
  assert.match(updateJs, /el\.download\.hidden = !\(update\.phase === 'available'\)/, '只有「有新版本」才给下载');
  assert.match(updateJs, /el\.install\.hidden = !\(update\.phase === 'ready'\)/, '只有校验通过才给安装');
  assert.match(updateJs, /mustUpdate/, '强制更新时不给「以后再说」');
  assert.match(updateJs, /actionError/, '下载 / 安装失败要落在状态行');
  assert.match(updateJs, /act\('update\.download'\)/);
  assert.match(updateJs, /act\('update\.run'\)/);
});
