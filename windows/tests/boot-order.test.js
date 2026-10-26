/**
 * 启动顺序的单测（0.1.0 首跑必崩的根因回归）。
 *
 * 关键：这条测试**在 0.1.0 的代码上必须失败**。0.1.0 的顺序是
 * `createWindow()` → `buildController()`，而 `prefs` 在 buildController 里才创建 ⇒ 窗口第一行 `prefs.get()` 就炸。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOOT_STEPS, createBootSequence } from '../src/main/boot.js';

function spyBox() {
  const calls = [];
  const spy = (name, result) => () => {
    calls.push(name);
    return result;
  };
  return { calls, spy };
}

test('启动顺序：configureSession → initPrefs → createWindow → buildController → registerIpc → attachHandlers → loadShell', async () => {
  const { calls, spy } = spyBox();
  const boot = createBootSequence({
    configureSession: spy('configureSession'),
    initPrefs: spy('initPrefs'),
    createWindow: spy('createWindow'),
    buildController: spy('buildController'),
    registerIpc: spy('registerIpc'),
    attachHandlers: spy('attachHandlers'),
    loadShell: spy('loadShell'),
  });
  await boot();
  assert.deepEqual(calls, ['configureSession', 'initPrefs', 'createWindow', 'buildController', 'registerIpc', 'attachHandlers', 'loadShell']);
});

test('顺序定位：initPrefs 必须在 createWindow 之前（0.1.0 崩就崩在这）', async () => {
  const { calls, spy } = spyBox();
  await createBootSequence({
    initPrefs: spy('initPrefs'),
    createWindow: spy('createWindow'),
    buildController: spy('buildController'),
    registerIpc: spy('registerIpc'),
    attachHandlers: spy('attachHandlers'),
    loadShell: spy('loadShell'),
  })();
  const index = (name) => calls.indexOf(name);
  assert.ok(index('initPrefs') < index('createWindow'), `实际顺序：${calls.join(' → ')}`);
  assert.ok(index('createWindow') < index('buildController'), 'RemoteView 需要窗口');
  assert.equal(calls.at(-1), 'loadShell', '加载页面必须最后');
});

test('缺步骤直接报错（不许悄悄跳过某一步）', () => {
  const { spy } = spyBox();
  assert.throws(
    () =>
      createBootSequence({
        initPrefs: spy('initPrefs'),
        createWindow: spy('createWindow'),
        // 少了 buildController
        registerIpc: spy('registerIpc'),
        attachHandlers: spy('attachHandlers'),
        loadShell: spy('loadShell'),
      }),
    /启动顺序缺少步骤：buildController/,
  );
});

test('loadShell 抛错会原样冒出去（交给 fatal 弹框，⛔ 不静默）', async () => {
  const { spy } = spyBox();
  const boot = createBootSequence({
    initPrefs: spy('initPrefs'),
    createWindow: spy('createWindow'),
    buildController: spy('buildController'),
    registerIpc: spy('registerIpc'),
    attachHandlers: spy('attachHandlers'),
    loadShell: async () => {
      throw new Error('壳页面打不开');
    },
  });
  await assert.rejects(() => boot(), /壳页面打不开/);
});

test('configureSession 可省略（测试 / 冒烟不需要证书策略）', async () => {
  const { calls, spy } = spyBox();
  await createBootSequence({
    initPrefs: spy('initPrefs'),
    createWindow: spy('createWindow'),
    buildController: spy('buildController'),
    registerIpc: spy('registerIpc'),
    attachHandlers: spy('attachHandlers'),
    loadShell: spy('loadShell'),
  })();
  assert.equal(calls[0], 'initPrefs');
});

test('BOOT_STEPS 与文档一致（顺序改了要一起改）', () => {
  assert.deepEqual(
    [...BOOT_STEPS],
    ['configureSession', 'initPrefs', 'createWindow', 'buildController', 'registerIpc', 'attachHandlers', 'loadShell'],
  );
});
