/**
 * 安装许可协议（0.2.2 起）：文本、RTF 生成、向导里的页面。
 *
 * 三条口径：
 * 1. **Windows 版单独一份协议** —— ⛔ 不从飞牛版改几个字。两边的产品形态与联网行为都不同：
 *    飞牛版「只有点检查更新才联网」，Windows 版**启动后就会检查更新与拉公告**，
 *    照抄过去就是虚假陈述。
 * 2. 协议必须**能随时看到**：安装页可滚动阅读，装完还留一份 `EULA.txt` 在程序目录。
 * 3. 必须**勾选**才能继续（MUI 的单选/复选框模式），不是点一下「下一步」就过去。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
const eula = fs.readFileSync(path.join(root, 'build', 'eula.txt'), 'utf8');
const rtf = fs.readFileSync(path.join(root, 'build', 'eula.rtf'), 'utf8');

// ---------------------------------------------------------------- 协议正文

test('许可协议：九章齐全，且写明「勾选并继续＝同意」', () => {
  const chapters = [...eula.matchAll(/^# ([一二三四五六七八九]|十)、/gm)].map((m) => m[1]);
  assert.deepEqual(chapters, ['一', '二', '三', '四', '五', '六', '七', '八', '九'], '章节要齐（缺章＝条款断了）');
  assert.match(eula, /勾选「我已阅读并同意上述许可协议」/, '要说清怎么表示同意');
  assert.match(eula, /如果你不同意，请不要安装或使用本软件/);
  assert.match(eula, /中华人民共和国法律/, '适用法律');
});

test('许可协议：Windows 版是独立的一份，⛔ 不夹带飞牛专属条款', () => {
  assert.match(eula, /ZXDesk 工作台 Windows 版 最终用户许可协议/, '标题要写 Windows 版');
  // 下面这些是 fnOS 版的形态与承诺，搬到 Windows 版就是错的
  for (const wrong of [
    '运行在你自己拥有的飞牛 fnOS 设备上的私有化数据工作台',
    '飞牛 fnOS 版本完全开源',
    '主密码无法找回',
    'AI 辅助任务的 API Key',
    '番茄钟与日程表',
  ]) {
    assert.ok(!eula.includes(wrong), `⛔ 不该出现飞牛版的说法：${wrong}`);
  }
});

test('许可协议：写明 Windows 的账号现状与未来可能（不承诺、但要交代）', () => {
  assert.match(eula, /当前版本\*\*不需要注册任何在线账号\*\*/, '当前形态要说清');
  assert.match(eula, /可能在未来版本中引入自有账号体系/, '未来会有账号体系，要提前留条款');
  assert.match(eula, /不构成作者对任何未来功能的承诺/, '别把未来功能写成承诺');
});

test('许可协议：网络条款必须与代码实际行为一致（Windows 是自动检查，不是「点了才连」）', () => {
  const controller = fs.readFileSync(path.join(root, 'src', 'main', 'controller.js'), 'utf8');

  // 代码事实：启动后自动检查更新（可关）+ 自动拉公告
  assert.match(controller, /scheduleUpdateCheck\(delayMs = /, '代码里更新是启动后自动检查');
  assert.match(controller, /scheduleNoticeCheck\(delayMs = /, '代码里公告是启动后自动拉取');
  assert.match(controller, /updateAutoCheck === false/, '关闭开关要存在，协议才说得出「可在设置关闭」');

  // 协议事实：如实写这两件事，并给出关闭方式
  assert.match(eula, /启动后自动向更新服务器请求一次版本信息/, '要写自动检查');
  assert.match(eula, /设置 → 启动时检查更新/, '要写在哪关');
  assert.match(eula, /启动后请求一次公告内容/, '要写公告');
  assert.match(eula, /运行平台（windows）与更新通道（stable \/ beta）/, '请求内容要写准');
  assert.match(eula, /不携带账号、密码、文件内容或设备标识/, '不能含糊');

  // 其余联网点：下载（含镜像）、网盘、连自己的服务器
  assert.match(eula, /ghfast\.top、gh-proxy\.com、ghproxy\.net/, '镜像下载要披露');
  assert.match(eula, /前往百度网盘下载/, '网盘跳转要披露');
  assert.match(eula, /连接你的服务器/, '连自己的服务器要说明');
});

test('许可协议：数据与风险条款是 Windows 的口径（数据目录 / DPAPI / 卸载）', () => {
  assert.match(eula, /%LOCALAPPDATA%\\ZXDesk\\data/, '默认数据目录要写出来');
  assert.match(eula, /DPAPI/, '记住的口令用什么加密');
  assert.match(eula, /不以明文写入磁盘/);
  assert.match(eula, /卸载本软件时，你可以选择保留或删除数据目录，默认保留/);
  assert.match(eula, /绿色版（zip）通过覆盖解压升级会替换程序文件/, '绿色版升级风险要写');
});

// ---------------------------------------------------------------- RTF 生成

test('RTF：纯 ASCII（中文全部 \\u 转义），否则 NSIS 里会乱码', () => {
  for (const ch of rtf) {
    assert.ok(ch.charCodeAt(0) < 0x80, `出现非 ASCII 字符：${JSON.stringify(ch)}`);
  }
  assert.match(rtf, /^\{\\rtf1/, '要是合法 RTF 头');
  assert.match(rtf, /\\uc1/, '\\uNNNN 后要跟 1 个替代字符');
  assert.match(rtf, /\\f1\\b\\fs32/, '文档标题：黑体加粗 16pt');
  assert.match(rtf, /\\f1\\b\\fs22/, '章节标题：黑体加粗 11pt');
  assert.match(rtf, /\\f0\\fs20/, '正文：宋体 10pt');
});

test('RTF：与 eula.txt 同步（改了正文忘记重新生成会当场红）', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'build', 'make-eula.js'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

// ---------------------------------------------------------------- 向导里的页面

test('安装向导：许可协议页在欢迎页之后、选路径之前，且必须勾选', () => {
  const welcome = nsi.indexOf('MUI_PAGE_WELCOME');
  const license = nsi.indexOf('MUI_PAGE_LICENSE');
  const dirPage = nsi.indexOf('MUI_PAGE_DIRECTORY');
  const dataPage = nsi.indexOf('Page custom DataPageCreate DataPageLeave');
  assert.ok(license > 0, '要有许可协议页');
  assert.ok(license > welcome, '协议页在欢迎页之后');
  assert.ok(dirPage > license, '协议页要在「安装路径」之前 —— 先同意，再选装哪');
  assert.ok(dataPage > dirPage, '数据路径页在安装路径之后');

  assert.match(nsi, /!define MUI_LICENSEPAGE_CHECKBOX/, '用复选框模式（勾选），不是两个单选项');
  assert.match(nsi, /我已阅读并同意上述许可协议/, '勾选文案');
  assert.match(nsi, /!insertmacro MUI_PAGE_LICENSE "eula\.rtf"/, '读的是生成的 rtf（不是 txt）');
});

test('安装向导：协议全文随程序装进安装目录，装完也能查（UTF-16LE，记事本不乱码）', () => {
  const nsi = fs.readFileSync(path.join(root, 'build', 'installer.nsi'), 'utf8');
  assert.match(nsi, /File \/oname=EULA\.txt "eula-utf16\.txt"/, '装 UTF-16LE 那份，不是 UTF-8 源文件');
  assert.match(nsi, /协议全文也会安装到程序目录的 EULA\.txt/);

  const buf = fs.readFileSync(path.join(root, 'build', 'eula-utf16.txt'));
  assert.equal(buf[0], 0xff, 'UTF-16LE BOM 第一字节');
  assert.equal(buf[1], 0xfe, 'UTF-16LE BOM 第二字节');
  // 正文按 UTF-16LE 解出来要能搜到章节标题（证明确实是 UTF-16 而不是别的编码）
  assert.match(buf.toString('utf16le'), /一、本软件是什么/);
});

test('构建：dist:setup 编译前先重新生成 RTF', () => {
  const src = fs.readFileSync(path.join(root, 'build', 'make-setup.js'), 'utf8');
  assert.match(src, /make-eula\.js/, '要调用生成脚本');
  assert.ok(src.indexOf('make-eula.js') < src.indexOf('spawnSync(\n  makensis'), '生成必须在编译之前');
  assert.match(src, /许可协议 \/ 安装目录 \/ 数据目录三页齐全/, '产物摘要要写清页数');
});

test('协议：网址后面不能紧贴全角标点（聊天 / 邮件自动转链接时会把括号吃进去）', () => {
  const bad = [];
  for (const m of eula.matchAll(/https?:\/\/\S+/g)) {
    const tail = m[0].slice(-1);
    if ('）】》，。；：、'.includes(tail)) bad.push(m[0]);
  }
  assert.deepEqual(bad, [], `这些网址末尾粘了中文标点：${bad.join(' / ')}`);

  // 官网域名必须与官网 canonical 一致（改域名要一起改，别写错）
  assert.match(eula, /https:\/\/zxdesk\.xwjznh\.cn/, '要写官网域名');
  const site = fs.readFileSync(
    path.join(root, '..', 'server', '官网发布包', 'index.html'),
    'utf8',
  );
  const canonical = /rel="canonical"\s+href="https:\/\/([^/"]+)/.exec(site)?.[1];
  assert.ok(canonical, '官网首页要有 canonical');
  assert.ok(eula.includes(canonical), `协议里的域名要与官网 canonical（${canonical}）一致`);
});
