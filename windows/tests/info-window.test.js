/**
 * 信息窗口（许可协议 / 打赏与支持 / 更新日志）。
 *
 * 这三份内容都是**随包只读**的：不联网、不落用户数据。
 * 测试守四件事：页面与素材真的在包里、许可协议与安装器那份同源、更新日志落在当前版本、
 * 读取通道只认白名单（`eula` / `releases`）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CHANNEL, DOC_ALLOWLIST } from '../src/main/ipc.js';

const root = path.resolve(import.meta.dirname, '..');
const shell = path.join(root, 'src', 'shell');
const assets = path.join(shell, 'assets');

const read = (name) => fs.readFileSync(path.join(shell, name), 'utf8');

test('info.html：CSP 与外链纪律（无 CDN、不联网）', () => {
  const html = read('info.html');
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/, '⛔ 信息页不发任何网络请求');
  assert.match(html, /img-src 'self' data:/);
  assert.match(html, /href="info\.css"/);
  assert.match(html, /src="info\.js"/);
  assert.ok(!/https?:\/\//.test(html), '⛔ 不引外部资源');
});

test('info.js：三种内容都认，正文走 getDoc，图片只用随包素材', () => {
  const js = read('info.js');
  for (const doc of ['eula', 'donate', 'releases']) {
    assert.match(js, new RegExp(`${doc}:\\s*\\{`), `缺 ${doc} 的文档定义`);
  }
  assert.match(js, /api\.getDoc\(doc\)/, '许可协议 / 更新日志要由主进程读');
  assert.match(js, /assets\/qr_alipay\.png/);
  assert.match(js, /assets\/qr_wechat\.png/);
  assert.match(js, /window\.close\(\)/, '关闭只关当前窗口');
  assert.ok(!/fetch\(|XMLHttpRequest/.test(js), '⛔ 渲染层不自己发请求');
});

test('许可协议：壳里的副本与安装器那份逐字节一致（⛔ 两份各改各的）', () => {
  const fromBuild = fs.readFileSync(path.join(root, 'build', 'eula.txt'));
  const fromShell = fs.readFileSync(path.join(assets, 'eula.txt'));
  assert.ok(
    fromBuild.equals(fromShell),
    'src/shell/assets/eula.txt 与 build/eula.txt 不一致：改了协议正文要同步这两份（安装器用前者的 txt → rtf）',
  );
});

test('更新日志：可解析、第一条就是当前版本（升版本要同步它）', () => {
  const raw = fs.readFileSync(path.join(assets, 'releases.json'), 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.releases) && data.releases.length > 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(data.releases[0].version, pkg.version, '当前版本必须出现在更新日志第一条');
  for (const item of data.releases) {
    assert.match(item.version, /^\d+\.\d+\.\d+$/);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(item.items) && item.items.length > 0, `${item.version} 没有条目`);
  }
});

test('打赏收款码：随包存在且是真 PNG', () => {
  for (const file of ['qr_alipay.png', 'qr_wechat.png']) {
    const buffer = fs.readFileSync(path.join(assets, file));
    assert.deepEqual(
      [...buffer.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${file} 不是 PNG`,
    );
    assert.ok(buffer.length > 10_000, `${file} 太小，多半不是真图`);
  }
});

test('读取通道：只登记 eula / releases；preload 的通道名与主进程一致', () => {
  assert.deepEqual([...DOC_ALLOWLIST], ['eula', 'releases']);
  const preload = read('preload.cjs');
  assert.match(preload, new RegExp(`docGet: '${CHANNEL.DOC_GET}'`));
  assert.match(preload, /getDoc: \(kind\) => ipcRenderer\.invoke\(CHANNELS\.docGet, kind\)/);
});
