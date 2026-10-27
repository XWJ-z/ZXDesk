/**
 * 收尾体检发现的两条真问题（2026-10-27，真机跑之前先在真 socket 上钉住）。
 *
 * 1. 服务端「正常收尾」但字节不够（断流 / 被杀）：以前流 end 得像正常结束，后面的
 *    「大小不符」又被当成确定性问题直接放弃 ⇒ 断一次网就得整包重下，断两次就 give-up。
 *    现在：收的字节少于声明的 ⇒ 传输不完整，保留 .part 续传。
 * 2. 停手（give-up）时 .part 会留在数据目录里，可能有 150 MB。现在停手一律清干净。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { UpdateService } from '../src/main/update/service.js';
import { rawTransport, startRawServer } from './helpers/raw-http.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function payload(over = {}) {
  return {
    ok: true,
    data: {
      platform: 'windows',
      channel: 'stable',
      version: '0.2.3',
      hash: 'a'.repeat(64),
      fileName: 'zxdesk-windows-0.2.3-x64.zip',
      fileSize: 10,
      downloadUrls: ['https://example.com/pkg.zip'],
      releaseNotes: '',
      force: false,
      minVersion: '',
      fallbackUrl: '',
      publishedAt: '2026-10-27 20:00:00',
      ...over,
    },
  };
}

function makeService(t, { dir, body }) {
  const workDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-resume-'));
  if (!dir) t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  return new UpdateService({
    currentVersion: '0.2.2',
    apiUrl: 'http://127.0.0.1:9/api/version/windows',
    channel: 'stable',
    dir: workDir,
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => body }),
    transport: rawTransport,
    probeTimeoutMs: 120,
    log: () => {},
    onState: () => {},
  });
}

test('下载中途断流（响应头说满、实际只给一半）：保留 .part 续传，补齐即成功', async (t) => {
  const bytes = Buffer.from('0123456789ABCDEFGHIJ'); // 20 字节
  let hits = 0;
  const server = await startRawServer((req, res) => {
    hits += 1;
    const range = req.headers.range;
    // ⚠️ 这个桩必须「只有带 Range 才给剩下的」——否则「不带续传、从头重下」也能歪打正着成功，
    //    测试就验不出「短读被当成致命错误」这个 bug 了。
    if (!range) {
      res.writeHead(200, { 'content-length': String(bytes.length) });
      res.end(bytes.subarray(0, 7));
      return;
    }
    const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const rest = bytes.subarray(start);
    res.writeHead(206, { 'content-length': String(rest.length) });
    res.end(rest);
  });
  t.after(() => server.close());

  const service = makeService(t, {
    body: payload({ fileSize: bytes.length, hash: sha256(bytes), downloadUrls: [`${server.url}/p.zip`] }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'ready', `断流应当续传重试，实际 ${state.phase}：${JSON.stringify(state.error)}`);
  assert.equal(fs.readFileSync(state.filePath, 'utf8'), bytes.toString());
  assert.ok(hits >= 2, '应当发生了续传请求');
  assert.deepEqual(
    fs.readdirSync(path.dirname(state.filePath)).filter((name) => name.endsWith('.part')),
    [],
    '.part 应当已合并掉',
  );
});

test('两次都断流：停手后目录里不留半截包（.part 也要清）', async (t) => {
  const server = await startRawServer((_req, res) => {
    res.writeHead(200, { 'content-length': '9999' });
    res.end('x'); // 每次只给 1 字节
  });
  t.after(() => server.close());

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-leak-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const service = makeService(t, {
    dir: workDir,
    body: payload({ fileSize: 9999, hash: 'd'.repeat(64), downloadUrls: [`${server.url}/p.zip`] }),
  });
  await service.check();
  await service.download();

  const state = service.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.kind, 'give-up');
  assert.deepEqual(fs.readdirSync(workDir), [], '失败后数据目录应干净（含 .part）');
});
