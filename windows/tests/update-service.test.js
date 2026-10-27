/**
 * 更新服务：状态流转、失败降级、下载校验。
 *
 * 接口用假 fetch（不联网），下载用本机真实 socket —— 校验通过与否要看落盘字节，
 * 这里不能全靠桩。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { UpdateService } from '../src/main/update/service.js';
import { rawTransport, startRawServer } from './helpers/raw-http.js';

const CURRENT = '0.2.2';
const API = 'http://127.0.0.1:9/api/version/windows';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function payload(overrides = {}) {
  return {
    ok: true,
    data: {
      platform: 'windows',
      channel: 'stable',
      version: '0.2.3',
      hash: 'a'.repeat(64),
      fileName: 'zxdesk-windows-0.2.3-x64-setup.exe',
      fileSize: 10,
      downloadUrls: ['http://127.0.0.1:9/pkg.exe'],
      releaseNotes: '修了几处',
      force: false,
      minVersion: '',
      publishedAt: '2026-10-26 20:00:00',
      ...overrides,
    },
  };
}

function jsonFetch(body, status = 200) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
}

function makeService(t, { body = payload(), fetchImpl, dir, probeTimeoutMs } = {}) {
  const workDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-update-'));
  if (!dir) t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const phases = [];
  const service = new UpdateService({
    currentVersion: CURRENT,
    apiUrl: API,
    channel: 'stable',
    dir: workDir,
    fetchImpl: fetchImpl || jsonFetch(body),
    transport: rawTransport,
    probeTimeoutMs,
    onState: (state) => phases.push(state.phase),
    log: () => {},
  });
  return { service, dir: workDir, phases };
}

test('有新版本：checking → available，带上版本号、说明与包大小', async (t) => {
  const { service, phases } = makeService(t, { body: payload({ version: '0.2.3', fileSize: 1024 }) });
  await service.check();
  const state = service.snapshot();
  assert.equal(state.phase, 'available');
  assert.equal(state.latest, '0.2.3');
  assert.equal(state.available, true);
  assert.equal(state.mustUpdate, false);
  assert.equal(state.notes, '修了几处');
  assert.equal(state.fileSize, 1024);
  assert.equal(state.packageType, 'installer');
  assert.ok(phases.includes('checking'));
});

test('同版本或更旧的版本：判定为已是最新（⛔ 不提示降级）', async (t) => {
  for (const version of ['0.2.2', '0.2.1']) {
    const { service } = makeService(t, { body: payload({ version }) });
    await service.check();
    const state = service.snapshot();
    assert.equal(state.phase, 'latest', version);
    assert.equal(state.available, false, version);
  }
});

test('404（还没发布记录）：安静降级成「已是最新」，不报错', async (t) => {
  const { service } = makeService(t, { fetchImpl: jsonFetch({}, 404) });
  await service.check();
  const state = service.snapshot();
  assert.equal(state.phase, 'latest');
  assert.equal(state.error, null);
});

test('网络失败：报错；静默检查不把已有结论冲掉', async (t) => {
  const { service } = makeService(t, { fetchImpl: jsonFetch(payload()) });
  await service.check();
  assert.equal(service.snapshot().phase, 'available');

  service.fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await service.check({ silent: true });
  const state = service.snapshot();
  assert.equal(state.phase, 'available', '静默失败不该改阶段');
  assert.equal(state.error.kind, 'network');
});

test('下载成功：SHA256 对上才进 ready，文件真的落在 updates 目录', async (t) => {
  const body = Buffer.from('installer-bytes');
  const server = await startRawServer((_req, res) => {
    res.writeHead(200, {});
    res.end(body);
  });
  t.after(() => server.close());

  const { service, dir } = makeService(t, {
    body: payload({ fileSize: body.length, hash: sha256(body), downloadUrls: [`${server.url}/pkg.exe`] }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'ready');
  assert.equal(state.progress.percent, 100);
  assert.equal(fs.readFileSync(state.filePath, 'utf8'), 'installer-bytes');
  assert.equal(path.dirname(state.filePath), dir);
  assert.equal(service.downloadedFile(), state.filePath);
});

test('SHA256 对不上：删包、拉黑这个源、不再重复下载（下到的字节不可信）', async (t) => {
  const body = Buffer.from('tampered-bytes');
  const server = await startRawServer((_req, res) => {
    res.writeHead(200, {});
    res.end(body);
  });
  t.after(() => server.close());

  const { service, dir } = makeService(t, {
    body: payload({ fileSize: body.length, hash: 'b'.repeat(64), downloadUrls: [`${server.url}/pkg.exe`] }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.kind, 'give-up', '内容不对就别再试了，交给网盘兜底');
  assert.match(state.error.message, /SHA256/);
  assert.equal(state.attempts, 1, '只有一个源且内容不对 ⇒ 只下一次，不循环');
  assert.deepEqual(fs.readdirSync(dir), [], '校验失败的包必须删干净');
});

test('第一个镜像 404：自动换下一个地址', async (t) => {
  const body = Buffer.from('mirror-two');
  const server = await startRawServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404, {});
      res.end();
      return;
    }
    res.writeHead(200, {});
    res.end(body);
  });
  t.after(() => server.close());

  const { service } = makeService(t, {
    body: payload({
      fileSize: body.length,
      hash: sha256(body),
      downloadUrls: [`${server.url}/missing`, `${server.url}/pkg.exe`],
    }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'ready');
  assert.equal(fs.readFileSync(state.filePath, 'utf8'), 'mirror-two');
});

test('force / 低于最低支持版本 → mustUpdate', async (t) => {
  const forced = makeService(t, { body: payload({ force: true }) });
  await forced.service.check();
  assert.equal(forced.service.snapshot().mustUpdate, true);

  const below = makeService(t, { body: payload({ minVersion: '0.2.3' }) });
  await below.service.check();
  assert.equal(below.service.snapshot().mustUpdate, true);

  const satisfied = makeService(t, { body: payload({ minVersion: '0.2.1' }) });
  await satisfied.service.check();
  assert.equal(satisfied.service.snapshot().mustUpdate, false);
});

test('包形态按扩展名判定：zip = 绿色包', async (t) => {
  const { service } = makeService(t, {
    body: payload({ fileName: 'zxdesk-windows-0.2.3-x64.zip' }),
  });
  await service.check();
  assert.equal(service.snapshot().packageType, 'portable');
});

test('已是最新时 download 不做任何事（⛔ 不凭空下载）', async (t) => {
  const { service, dir } = makeService(t, { body: payload({ version: '0.2.2' }) });
  await service.check();
  await service.download();
  assert.equal(service.snapshot().phase, 'latest');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('所有下载源都连不上：停手（give-up）并说明是连不上，而不是笼统的「下载失败」', async (t) => {
  const silent = await startRawServer(() => {
    /* 不响应：模拟 GitHub 与镜像都被墙 */
  });
  t.after(() => silent.close());

  const { service } = makeService(t, {
    body: payload({ downloadUrls: [`${silent.url}/pkg.exe`] }),
    probeTimeoutMs: 150,
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.kind, 'give-up');
  assert.match(state.error.message, /连不上/);
});

// ---------------------------------------------------------------- 0.2.2 增补：下载上限与版本核对

test('清单里带 fallbackUrl：check 之后状态里能看到（界面据此给网盘按钮）', async (t) => {
  const { service, dir } = makeService(t, {
    body: payload({
      version: '0.2.3',
      fileSize: 12,
      downloadUrls: ['https://example.com/pkg.zip'],
      fallbackUrl: 'https://pan.baidu.com/s/abc',
    }),
  });
  await service.check();
  assert.equal(service.snapshot().fallbackUrl, 'https://pan.baidu.com/s/abc');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('两个源都是旧包：最多下 2 次、两个都拉黑，然后停手', async (t) => {
  const body = Buffer.from('stale-package'); // 内容与清单的 hash 不符
  const server = await startRawServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  t.after(() => server.close());

  const { service, dir } = makeService(t, {
    body: payload({
      fileSize: body.length,
      hash: 'c'.repeat(64),
      downloadUrls: [`${server.url}/a.exe`, `${server.url}/b.exe`],
    }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.kind, 'give-up');
  assert.equal(state.attempts, 2, '上限两次：不能因为候选多就一直拖');
  assert.deepEqual(fs.readdirSync(dir), [], '坏包一律删掉，不留残骸');
});

test('响应头的大小就不对：一个字节都不下，直接换源/停手', async (t) => {
  const body = Buffer.from('tiny');
  const server = await startRawServer((_req, res) => {
    // 响应头写 999999（旧包），实际只回 4 字节
    res.writeHead(200, { 'content-length': '999999' });
    res.end(body);
  });
  t.after(() => server.close());

  const { service, dir } = makeService(t, {
    body: payload({
      fileSize: 4,
      hash: sha256(body),
      downloadUrls: [`${server.url}/pkg.exe`],
    }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.kind, 'give-up');
  assert.match(state.error.message, /大小不符/, '要被响应头挡下，而不是下完再比 hash');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('hash 对得上但包内版本不对：删包、停手（服务器记录写错了这一种）', async (t) => {
  const asar = await import('@electron/asar');
  const { makeZip } = await import('./helpers/make-zip.js');
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-pkg-src-'));
  fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'zxdesk', version: '0.1.6' }), 'utf8');
  const asarPath = path.join(srcDir, 'app.asar');
  await asar.createPackage(srcDir, asarPath);
  const zip = makeZip('ZXDesk-win32-x64/resources/app.asar', fs.readFileSync(asarPath));

  const server = await startRawServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(zip.length) });
    res.end(zip);
  });
  t.after(() => {
    server.close();
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  const { service, dir } = makeService(t, {
    body: payload({
      version: '0.2.3',
      fileName: 'zxdesk-windows-0.2.3-x64.zip',
      fileSize: zip.length,
      hash: sha256(zip),
      downloadUrls: [`${server.url}/pkg.zip`],
    }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.kind, 'give-up');
  assert.match(state.error.message, /包内版本是 0\.1\.6/);
  assert.deepEqual(fs.readdirSync(dir), [], '版本不对的包不能留着给用户运行');
});
