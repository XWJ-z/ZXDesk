/**
 * 连接节流（照 Android `ConnectGuard` 的阶梯口径）。
 *
 * 现场：Windows 端一直没有这层。用户在登录页连点「连接」，自己看着是「重试一下」，
 * 在飞牛那边就是一次又一次的失败取证 —— 触发风控后**怎么输都进不去**，
 * 而且重启应用也没用（风控按来源 IP + 账号记，不按进程记）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConnectGuard, IDLE_RESET_MS, cooldownFor } from '../src/main/connection/guard.js';

/** 最小 prefs：与 `PrefsStore` 同签名（get / patch），落盘换成内存对象。 */
function makePrefs(initial = {}) {
  const store = {
    value: { connectFailCount: 0, connectCooldownUntil: 0, connectLastAttemptAt: 0, ...initial },
    get() {
      return this.value;
    },
    patch(partial) {
      this.value = { ...this.value, ...partial };
      return this.value;
    },
  };
  return store;
}

test('阶梯：前 3 次不罚，第 4 次 5 秒、第 6 次 15 秒、第 7 次 30 秒、第 8 次起 60 秒封顶', () => {
  assert.equal(cooldownFor(1), 0);
  assert.equal(cooldownFor(2), 0);
  assert.equal(cooldownFor(3), 0);
  assert.equal(cooldownFor(4), 5_000);
  // 第 5 次返回 0 是故意的：口径是「罚 5 秒之后还能再试两次」，那两次的第二次不再罚
  assert.equal(cooldownFor(5), 0);
  assert.equal(cooldownFor(6), 15_000);
  assert.equal(cooldownFor(7), 30_000);
  assert.equal(cooldownFor(8), 60_000);
  assert.equal(cooldownFor(20), 60_000, '封顶不再涨：风控窗口本身也就几分钟');
});

test('连续失败按阶梯冷却，冷却期内 remainingMs > 0', () => {
  let now = 1_000_000;
  const prefs = makePrefs();
  const guard = new ConnectGuard(prefs, () => now);

  assert.equal(guard.remainingMs(), 0);
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(guard.registerFailure(), 0, `第 ${i} 次不该罚`);
    assert.equal(guard.remainingMs(), 0);
  }
  assert.equal(guard.registerFailure(), 5_000, '第 4 次罚 5 秒');
  assert.equal(guard.remainingMs(), 5_000);

  // 冷却走完 ⇒ 可以再试
  now += 5_001;
  assert.equal(guard.remainingMs(), 0);
});

test('计数落进 prefs（杀进程重开不清零 —— 风控不是按进程记的）', () => {
  const prefs = makePrefs();
  const guard = new ConnectGuard(prefs, () => 5_000);
  for (let i = 0; i < 4; i += 1) guard.registerFailure();

  assert.equal(prefs.get().connectFailCount, 4);
  assert.equal(prefs.get().connectCooldownUntil, 10_000);

  // 换一个新实例读同一份 prefs：冷却仍然有效
  const revived = new ConnectGuard(prefs, () => 6_000);
  assert.equal(revived.remainingMs(), 4_000, '重开应用不该把冷却清零');
});

test('5 分钟没有任何尝试 ⇒ 计数与冷却一起清零（吃个饭回来不该还背着账）', () => {
  let now = 1_000_000;
  const prefs = makePrefs();
  const guard = new ConnectGuard(prefs, () => now);
  for (let i = 0; i < 8; i += 1) guard.registerFailure();
  assert.equal(prefs.get().connectCooldownUntil > 0, true);

  now += IDLE_RESET_MS + 1;
  assert.equal(guard.remainingMs(), 0);
  assert.equal(prefs.get().connectFailCount, 0);
  assert.equal(prefs.get().connectLastAttemptAt, 0);
});

test('登录成功 ⇒ reset 清零（正常使用不该被历史失败拖住）', () => {
  const prefs = makePrefs();
  const guard = new ConnectGuard(prefs, () => 9_000);
  for (let i = 0; i < 6; i += 1) guard.registerFailure();
  assert.ok(prefs.get().connectFailCount > 0);

  guard.reset();
  assert.equal(prefs.get().connectFailCount, 0);
  assert.equal(prefs.get().connectCooldownUntil, 0);
  assert.equal(guard.remainingMs(), 0);
});
