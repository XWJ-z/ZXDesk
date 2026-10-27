/**
 * 主进程接线的静态回归（真机上踩过的坑，钉住别再犯）。
 *
 * 背景：0.2.2 第一次在真机跑，点「帮助」立刻弹「ZXDesk 出错了」：
 *   TypeError: Cannot read properties of null (reading 'catch')
 * 原因是 `controller.openNotice()` 改成同步返回 null 之后，菜单里还写着 `.catch(...)`。
 * ⇒ 这类「对可能是 null 的返回值直接 .catch」的写法，用测试挡住。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');

test('菜单 / 快捷键 / 探针都走 fire()，不对返回值直接 .catch', () => {
  assert.match(main, /function fire\(action, label\)/, '缺 fire 兜底函数');

  // 这几处的返回值可能是 null（同步方法）或 undefined（controller 还没建好）
  assert.ok(!/controller\?\.openNotice\(\)\.catch\(/.test(main), 'openNotice 是同步的，不能直接 .catch');
  assert.ok(!/controller\?\.openUpdate\(\)\.catch\(/.test(main), 'openUpdate 要经 fire 兜住');
  assert.ok(!/controller\?\.action\([^)]*\)\.catch\(/.test(main), 'action 要经 fire 兜住');
  assert.ok(!/controller\?\.onProbe\([^)]*\)\.catch\(/.test(main), 'onProbe 要经 fire 兜住');

  assert.match(main, /fire\(\(\) => controller\?\.openNotice\(\), '打开公告失败'\)/);
  assert.match(main, /fire\(\(\) => controller\?\.openUpdate\(\), '检查更新失败'\)/);
});

test('fire 本身：同步返回值不炸、Promise 异常进日志', () => {
  // 把 fire 抽出来单测（主进程文件不能 import，直接取函数源码跑一遍）
  const start = main.indexOf('function fire(action, label) {');
  const end = main.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, '取不到 fire 的源码');
  const body = main.slice(start, end);

  const logged = [];
  const logger = { error: (label, error) => logged.push([label, String(error)]) };
  // eslint-disable-next-line no-new-func
  const factory = new Function('logger', `${body}; return fire;`);
  const fire = factory(logger);

  assert.doesNotThrow(() => fire(() => null, '同步返回 null'), '同步返回 null 不能抛');
  assert.doesNotThrow(() => fire(() => undefined, '同步返回 undefined'));
  assert.doesNotThrow(() => fire(() => {
    throw new Error('boom');
  }, '同步抛错'), '同步抛错要被兜住');
  assert.deepEqual(logged.at(-1), ['同步抛错', 'Error: boom']);

  const pending = fire(() => Promise.reject(new Error('async-boom')), '异步抛错');
  assert.equal(pending, undefined, 'fire 自己不返回 Promise');
  return Promise.resolve().then(() => {
    assert.deepEqual(logged.at(-1), ['异步抛错', 'Error: async-boom'], '异步异常也要进日志');
  });
});
