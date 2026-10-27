/**
 * 公告的静态一致性。
 *
 * 位置按 DSH 来：菜单栏里**「帮助」之后的那一项**（菜单项的最后一项），宽度跟着内容走、
 * 有上限，放不下用省略号 —— 不做滚动字幕。点开是独立的公告窗口。
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

test('壳里的公告动作都在主进程白名单里', () => {
  const used = new Set();
  for (const match of app.matchAll(/data-action="(notice\.[a-z]+)"/g)) used.add(match[1]);
  for (const match of html.matchAll(/data-action="(notice\.[a-z]+)"/g)) used.add(match[1]);
  assert.ok(used.has('notice.open'), `壳里缺 notice.open，实际 ${[...used].join(' / ')}`);
  for (const action of used) {
    assert.ok(ACTION_ALLOWLIST.includes(action), `白名单缺动作：${action}（点了不会有任何反应）`);
  }
});

test('公告条在菜单栏里紧跟「帮助」，是菜单项的最后一项', () => {
  const helpAt = html.indexOf('data-menu="help"');
  const barAt = html.indexOf('id="notice-bar"');
  const navEnd = html.indexOf('</nav>', helpAt);

  assert.ok(helpAt > 0 && barAt > 0, '缺「帮助」或公告条');
  assert.ok(barAt > helpAt, '公告条要在「帮助」右侧');
  assert.ok(barAt < navEnd, '公告条要留在菜单组里（跟菜单项排一起，不是浮在窗口右端）');
  assert.equal(html.indexOf('data-menu="', barAt), -1, '公告条之后不该再有别的菜单项');
  assert.match(html, /data-action="notice\.open"/, '公告条要能点开公告');
  assert.match(html, /id="notice-bar-text"/);
});

test('公告条显示的是**顶置公告**（marquee），不是公告列表第一条', () => {
  assert.match(app, /function renderNoticeBar\(/);
  assert.match(app, /const marquee = String\(notices\?\.marquee/, '读的是 marquee 字段');
  assert.match(app, /el\.noticeBarText\.textContent = marquee/);
  assert.ok(!/items\[0\]/.test(app.split('function renderNoticeBar')[1]?.split('function ')[0] || ''),
    '⛔ 不拿 items[0].title 当公告条（那是「最新一条公告」，不是顶置横幅）');
  assert.match(app, /el\.noticeBar\.title = marquee/, '悬停看全文');
  assert.match(app, /renderNoticeBar\(state\.notices\)/);
  assert.ok(!app.includes('scrolling'), '⛔ 不再有滚动字幕那套逻辑');
});

test('公告条样式：宽度随内容、有上限、单行省略', () => {
  assert.match(css, /\.notice-bar\s*\{[^}]*width:\s*auto/s, '宽度随内容');
  assert.match(css, /\.notice-bar\s*\{[^}]*max-width:\s*\d+px/s, '要有上限，长标题不能把菜单挤走');
  assert.match(css, /\.notice-bar-text\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.notice-bar-text\s*\{[^}]*white-space:\s*nowrap/s);
  assert.ok(!css.includes('@keyframes notice-marquee'), '⛔ 不再有滚动动画');
  assert.ok(!css.includes('.notice-bar-tag'), '⛔ 不再有「公告」标签占位，宽度让给标题');
  assert.match(css, /\.menu-group\s*\{[^}]*margin-right:\s*auto/s, '菜单组吃掉剩余空间，公告条跟着菜单走');
});

test('公告窗口：独立页面 ＋ CSP ＋ 列表渲染', () => {
  const noticeHtml = fs.readFileSync(path.join(shellDir, 'notice.html'), 'utf8');
  const noticeJs = fs.readFileSync(path.join(shellDir, 'notice.js'), 'utf8');

  assert.match(noticeHtml, /Content-Security-Policy/);
  assert.match(noticeHtml, /connect-src 'none'/, '公告窗口不发网络请求');
  assert.match(noticeHtml, /id="list"/);
  assert.match(noticeHtml, /src="notice\.js"/);
  assert.ok(fs.existsSync(path.join(shellDir, 'notice.css')), '缺 notice.css');

  // 全部公告都要画出来，不是只画前 5 条
  assert.match(noticeJs, /items\s*\.map|items\.map/, '要遍历全部条目');
  assert.match(noticeJs, /item\.content/, '正文要渲染');
  assert.match(noticeJs, /api\.action\('notice\.read'\)/);
  assert.ok(!/fetch\(/.test(noticeJs), '窗口里不发请求');
});

test('帮助按钮能显示未读小点', () => {
  assert.match(app, /function renderNoticeBadge\(/);
  assert.match(app, /querySelector\('\[data-menu="help"\]'\)/);
  assert.match(css, /\.menu-btn\.has-unread::after/);
});

test('公告正文只走 esc / textContent，不拼 HTML（⛔ 服务器下发的是纯文本）', () => {
  assert.ok(!/innerHTML\s*=\s*item\./.test(app), '不能把远端文本直接塞进 innerHTML');
  const noticeJs = fs.readFileSync(path.join(shellDir, 'notice.js'), 'utf8');
  assert.match(noticeJs, /esc\(item\.content\)/, '公告窗口里正文要转义');
});

test('公告不自动弹窗：拉完只更新公告条与未读标记', () => {
  const controller = fs.readFileSync(path.join(root, 'src', 'main', 'controller.js'), 'utf8');
  assert.match(controller, /scheduleNoticeCheck/);
  assert.ok(!/autoScreens/.test(controller), '⛔ 启动检查完不自动开窗打断用户');
  assert.ok(!/showNoticePopup/.test(controller), '原生摘要弹窗那一套已经删掉');
  assert.match(controller, /openNoticeWindow\?\.\(\)/, '入口只有「帮助 → 公告」与公告条');
});

test('公告接口有两处环境变量可覆盖（与更新同一条规矩）', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  assert.match(main, /ZXDESK_NOTICE_URL/);
  assert.match(main, /new NoticeService\(/);
  assert.match(main, /files\.notices/);
});
