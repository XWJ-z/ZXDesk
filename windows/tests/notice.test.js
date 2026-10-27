/**
 * 公告：响应校验、拉取失败分类、已读与缓存。
 *
 * 公告是纯内容，坏一条不该让整屏消失 ⇒ 这里专门验「跳过坏条目、留下好条目」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NoticeService, fetchNotices, parseNotices } from '../src/main/notice.js';

const URL_OK = 'https://api.example.com/api/notices/windows';

function payload(data, extra = {}) {
  return { ok: true, platform: 'windows', updated: '2026-10-27 15:00:00', data, ...extra };
}

function jsonFetch(body, status = 200) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
}

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxdesk-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'notices-cache.json');
}

test('响应校验：合法条目全收，字段收敛', () => {
  const result = parseNotices(
    payload([
      { id: 'a1', title: '标题', content: '正文\n第二行', level: 'important', pinned: true, publishedAt: '2026-10-27 15:00:00' },
    ]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.items[0], {
    id: 'a1',
    title: '标题',
    content: '正文\n第二行',
    level: 'important',
    pinned: true,
    publishedAt: '2026-10-27 15:00:00',
  });
});

test('响应校验：缺 id / 缺标题的跳过，其余照收', () => {
  const result = parseNotices(
    payload([
      { id: '', title: '没有 id' },
      { id: 'no-title', title: '   ' },
      { id: 'ok', title: '正常' },
      null,
      'x',
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'ok');
  assert.equal(result.skipped, 4);
});

test('响应校验：level 只认 important，其它一律 info', () => {
  const result = parseNotices(payload([{ id: 'x', title: 't', level: 'warning' }]));
  assert.equal(result.items[0].level, 'info');
});

test('响应校验：最多 20 条（防异常响应把弹窗撑爆）', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `第 ${i} 条` }));
  const result = parseNotices(payload(rows));
  assert.equal(result.items.length, 20);
});

test('响应校验：ok 不为 true、缺 data、不是对象', () => {
  assert.equal(parseNotices({ ok: false, message: 'boom' }).ok, false);
  assert.equal(parseNotices({ ok: true }).ok, false);
  assert.equal(parseNotices(null).ok, false);
});

test('拉取：404 与空数组合义相同（这个端还没有公告）', async () => {
  const result = await fetchNotices({ url: URL_OK, fetchImpl: jsonFetch({}, 404) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, []);
});

test('拉取：5xx / 非 JSON / 超时分开报', async () => {
  assert.equal((await fetchNotices({ url: URL_OK, fetchImpl: jsonFetch({}, 503) })).kind, 'http');

  const badJson = await fetchNotices({
    url: URL_OK,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('bad');
      },
    }),
  });
  assert.equal(badJson.kind, 'invalid');

  const timeout = await fetchNotices({
    url: URL_OK,
    timeoutMs: 20,
    fetchImpl: (input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  assert.equal(timeout.kind, 'timeout');
});

test('拉取：明文公网地址在请求前就被拒', async () => {
  let called = false;
  const result = await fetchNotices({
    url: 'http://api.example.com/api/notices/windows',
    fetchImpl: async () => {
      called = true;
      return { status: 200, ok: true, json: async () => payload([]) };
    },
  });
  assert.equal(result.kind, 'insecure');
  assert.equal(called, false);
});

test('服务：拉到公告后按已读算未读，markAllRead 只留最近 100 条', async (t) => {
  const file = tmpFile(t);
  const service = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(payload([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])),
    file,
    readIds: ['a'],
    log: () => {},
  });
  await service.check();
  const state = service.snapshot();
  assert.equal(state.total, 2);
  assert.equal(state.unread, 1);
  assert.deepEqual(state.unreadIds, ['b']);

  const ids = service.markAllRead();
  assert.deepEqual(ids.sort(), ['a', 'b']);
  assert.equal(service.snapshot().unread, 0);
});

test('服务：拉取失败保留缓存内容（公告不闪没）', async (t) => {
  const file = tmpFile(t);
  const ok = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(payload([{ id: 'a', title: 'A' }])),
    file,
    log: () => {},
  });
  await ok.check();
  assert.equal(ok.snapshot().total, 1);

  // 新实例从缓存起步（模拟重启后网络还没回来）
  const offline = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    file,
    log: () => {},
  });
  assert.equal(offline.loadCache(), 1);
  assert.equal(offline.snapshot().unread, 1);
  await offline.check({ silent: true });
  const state = offline.snapshot();
  assert.equal(state.items.length, 1, '静默失败不该清空公告');
  assert.equal(state.error.kind, 'network');
});

test('服务：缓存文件被写坏时按空处理，不抛错', (t) => {
  const file = tmpFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json', 'utf8');
  const service = new NoticeService({ apiUrl: URL_OK, fetchImpl: async () => {}, file, log: () => {} });
  assert.equal(service.loadCache(), 0);
  assert.equal(service.snapshot().total, 0);
});

test('服务：已读 id 跟着 setReadIds 走（换人/换机会重算）', async (t) => {
  const service = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(payload([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])),
    file: tmpFile(t),
    readIds: [],
    log: () => {},
  });
  await service.check();
  assert.equal(service.snapshot().unread, 2);
  service.setReadIds(['a', 'b']);
  assert.equal(service.snapshot().unread, 0);
});

// ---------------------------------------------------------------- 0.2.2 增补：顶置公告（marquee）

test('顶置公告：解析成单行文本，与公告列表分开', () => {
  const result = parseNotices(
    payload([{ id: 'a1', title: '标题', content: '正文' }], { marquee: '  Windows 0.2.3 已发布\n去官网看详情  ' }),
  );
  assert.equal(result.marquee, 'Windows 0.2.3 已发布 去官网看详情', '换行折成空格、去首尾空白');
  assert.equal(result.items[0].title, '标题', '列表条目不受影响');
});

test('顶置公告：缺字段 / 非字符串 → 空串（界面据此不显示公告条）', () => {
  assert.equal(parseNotices(payload([])).marquee, '');
  assert.equal(parseNotices(payload([], { marquee: 123 })).marquee, '123');
  assert.equal(parseNotices(payload([], { marquee: null })).marquee, '');
});

test('顶置公告：超长截断（公告条只有一行，写太长一定是数据错了）', () => {
  const long = '广'.repeat(500);
  assert.equal(parseNotices(payload([], { marquee: long })).marquee.length, 200);
});

test('顶置公告：落缓存、重启读回来还在', async (t) => {
  const file = tmpFile(t);
  const body = payload([{ id: 'a1', title: '标题', content: '正文' }], { marquee: '顶置横幅' });
  const first = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(body),
    file,
    log: () => {},
    onState: () => {},
  });
  await first.check();
  assert.equal(first.snapshot().marquee, '顶置横幅');

  const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cached.marquee, '顶置横幅', '缓存文件里要带上，否则重启那段没有公告条');

  const second = new NoticeService({ apiUrl: URL_OK, fetchImpl: jsonFetch(body), file, log: () => {}, onState: () => {} });
  second.loadCache();
  assert.equal(second.snapshot().marquee, '顶置横幅');
  assert.equal(second.snapshot().items.length, 1);
});

test('顶置公告：拉取失败时保留上一次的文案（公告条不闪没）', async (t) => {
  const file = tmpFile(t);
  const ok = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(payload([], { marquee: '旧横幅' })),
    file,
    log: () => {},
    onState: () => {},
  });
  await ok.check();

  const failing = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
    file,
    log: () => {},
    onState: () => {},
  });
  failing.loadCache();
  await failing.check({ silent: true });
  assert.equal(failing.snapshot().marquee, '旧横幅', '静默失败不该把公告条清空');
});

// ---------------------------------------------------------------- 公告条文案来源（旧服务端降级）

test('公告条：新服务端有顶置公告 → 用 marquee（source=pinned）', async (t) => {
  const svc = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(payload([{ id: 'a1', title: '最新一条' }], { marquee: '顶置公告文案' })),
    file: tmpFile(t),
    log: () => {},
    onState: () => {},
  });
  await svc.check();
  assert.equal(svc.snapshot().marquee, '顶置公告文案');
  assert.equal(svc.snapshot().marqueeSource, 'pinned');
});

test('公告条：新服务端没配顶置公告 → 空（不显示公告条，也不拿列表第一条冒充）', async (t) => {
  const svc = new NoticeService({
    apiUrl: URL_OK,
    fetchImpl: jsonFetch(payload([{ id: 'a1', title: '最新一条' }], { marquee: '' })),
    file: tmpFile(t),
    log: () => {},
    onState: () => {},
  });
  await svc.check();
  assert.equal(svc.snapshot().marquee, '');
  assert.equal(svc.snapshot().marqueeSource, 'none');
});

test('公告条：旧服务端（响应里没有 marquee 字段）→ 暂用最新公告标题，并记日志说明', async (t) => {
  const logs = [];
  const svc = new NoticeService({
    apiUrl: URL_OK,
    // 0.2.1 及以前的接口就是这个形状：只有 data，没有 marquee
    fetchImpl: jsonFetch({ ok: true, platform: 'windows', updated: '2026-10-27 15:00:00', data: [{ id: 'a1', title: '公告系统已上线' }] }),
    file: tmpFile(t),
    log: (level, message) => logs.push(message),
    onState: () => {},
  });
  await svc.check();
  assert.equal(svc.snapshot().marquee, '公告系统已上线', '降级到最新公告标题，别让公告条空着');
  assert.equal(svc.snapshot().marqueeSource, 'latest');
  assert.ok(logs.some((l) => l.includes('服务端还没下发顶置公告')), '要在日志里说清楚这是降级');
});
