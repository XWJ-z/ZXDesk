/**
 * ZXDesk工作台 飞牛原生应用
 *
 * 功能：`init()` 记住当前的数据库目录；`checkAtStartup()` 在每次启动时问一次飞牛
 * 「应用共享授权里还有没有这个目录」；`ensure(req)` 在有网关身份时补一次
 * 「共享 ∪ 该用户的个人授权」的复核；`snapshot()` 给 `/api/health` 读。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、https://developer.fnnas.com/api/authorization/overview/
 */
'use strict';

const fs = require('node:fs');
const { isGranted, normPath } = require('./grant-path.js');
const trimApi = require('./trim-api.js');

/** 结论缓存时长：首次定论后 5 分钟内不再问网关（每次 health 都问会把网关打满） */
const CACHE_MS = 5 * 60 * 1000;

/**
 * 当前结论。
 * @type {{state: string, scope: string, code: string, message: string, checkedAt: number}}
 */
let cur = { state: 'pending', scope: '', code: '', message: '', checkedAt: 0 };

/** 正在进行的复核（并发请求共用一次，别把网关打成串行队列） @type {?Promise} */
let inflight = null;

/** 被检查的目录与日志函数（由 `init()` 注入，⛔ 不 require context —— 那会成环） */
let target = '';
let logFn = () => {};

/**
 * 是否**强制**校验（只有「自定义位置」才强制）。
 *
 */
let enforce = false;

/**
 * 功能：注入「要检查哪个目录」与日志函数（启动时由 `server.js` 调一次）。
 * @param {{dataDir: string, log?: Function}} o - 目录与日志
 * @returns {void}
 */
function init(o) {
  const t = o || {};
  target = normPath(t.dataDir || '');
  enforce = t.enforce === true;
  if (typeof t.log === 'function') logFn = t.log;
  // 默认位置：不查、也不算「未授权」——直接给一个说得清的正常结论
  if (!enforce) cur = { state: 'ok', scope: 'install', code: '', message: '', checkedAt: Date.now() };
  // 授权清单一变（新授权 / 撤销 / 面板刷新都会走 `trimApi.invalidate()`），本模块的结论
  trimApi.onInvalidate(invalidate);
}

/**
 * 功能：作废当前结论（下一次 `ensure()` 会真的去问一次网关）。
 *
 * 的那一瞬间以为授权没问题（反而更糟）。等真的问回来再改。
 * @returns {void}
 */
function invalidate() {
  cur = { ...cur, checkedAt: 0 };
  inflight = null;
}

/**
 * 功能：只读快照（给 `/api/health` 与启动日志用）。
 * @returns {{state: string, scope: string, code: string, message: string, checkedAt: number}} 副本
 */
function snapshot() {
  return { ...cur, enforce };
}

/**
 * 功能：写入结论（时间戳一起更新）。
 * @param {Object} next - 要覆盖的字段
 * @returns {Object} 新快照
 */
function set(next) {
  cur = { ...cur, ...next, checkedAt: Date.now() };
  return snapshot();
}

/**
 * 功能：把一条结论写进启动日志（只写一次，同一条不刷屏）。
 * @param {Object} st - 结论
 * @returns {void}
 */
function logOnce(st) {
  if (st.state === 'ok') {
    const from = st.scope === 'user' ? '个人授权' : st.scope === 'fs' ? '目录实测可读' : '应用共享授权';
    logFn('info', `数据位置授权有效（来源：${from}）：${target}`);
  } else if (st.state === 'lost') {
    logFn(
      'error',
      `⚠️ 数据位置已不在授权列表里，且目录读不到（${target}）—— 数据库文件不可用。` +
        '请到「设置 → 账号设置 → 个人授权目录」重新授权；若那个目录已经不可用，请把数据拷回安装位置再重启应用。',
    );
  } else if (st.state === 'pending') {
    logFn('warn', `数据位置不在应用共享授权里（${target}）—— 等当前登录用户确认是否走个人授权`);
  } else {
    logFn('warn', `无法核实数据位置的授权（${st.message || st.code || '原因未知'}）—— 不影响本次使用，稍后可在界面上重试`);
  }
}

/**
 * 功能：只查**应用共享授权**（不带 uid，启动时唯一能问的那一份）。
 * @returns {Promise.<Array.<string>>} 授权目录列表
 * @throws {Error} 网关不可达 / 无 token 时抛出
 */
async function sharedPaths() {
  const paths = await trimApi.getSharedAccessibleFolders();
  return Array.isArray(paths) ? paths : [];
}

/**
 * 功能：启动体检 —— 每次启动跑一次。
 *
 * 说明：⚠️ 只查共享授权：此刻还没有任何网关身份，问不了「某个用户的个人授权」。
 * 共享没覆盖时进 `pending`（**不是** `lost`）—— 个人授权场景下这是正常的。
 * @returns {Promise.<Object>} 结论
 */
async function checkAtStartup() {
  if (!target) return snapshot();
  if (!enforce) return set({ state: 'ok', scope: 'install', code: '', message: '' });
  try {
    const paths = await sharedPaths();
    if (isGranted(target, paths)) {
      const st = set({ state: 'ok', scope: 'shared', code: '', message: '' });
      logOnce(st);
      return st;
    }
    const st = set({ state: 'pending', scope: 'shared', code: 'SHARED_MISSING', message: '' });
    logOnce(st);
    return st;
  } catch (e) {
    const st = set({
      state: 'unknown',
      scope: '',
      code: (e && e.code) || 'TRIM_FAILED',
      message: (e && e.message) || '',
    });
    logOnce(st);
    return st;
  }
}

/**
 * 功能：实测「这个目录现在读不读得到」—— 授权清单覆盖不到时的兜底判据。
 *
 * 说明：⭐⭐ 为什么需要它：**授权是一次性的事实，不是每次登录都要重新证明的事**。
 * 飞牛把目录的 ACL 给到「应用用户」（`zxdesk`）之后，那个目录对进程就是可读的，
 * **与当前是哪个飞牛用户登录无关**。而「个人授权清单」是按飞牛用户查的：
 */
function probeReadable(dir) {
  if (!dir) return false;
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 功能：按网关身份复核 —— 「应用共享 ∪ 该用户的个人授权 ∪ 目录实测」。
 * @param {number} uid - 飞牛用户 uid（**只从网关 Header 来**）
 * @returns {Promise.<Object>} 结论
 */
async function checkForUser(uid) {
  if (!target) return snapshot();
  if (!enforce) return set({ state: 'ok', scope: 'install', code: '', message: '' });
  try {
    const before = cur.state;
    if (isGranted(target, await sharedPaths())) {
      const st = set({ state: 'ok', scope: 'shared', code: '', message: '' });
      // 只在「结论变了」时写日志：每次 health 都报一行会把 app.log 刷满
      if (before !== 'ok') logOnce(st);
      return st;
    }
    const mine = await trimApi.getUserAccessibleFolders(uid);
    if (isGranted(target, Array.isArray(mine) ? mine : [])) {
      const st = set({ state: 'ok', scope: 'user', code: '', message: '' });
      if (before !== 'ok') logOnce(st);
      return st;
    }
    // 清单没覆盖 ≠ 不能用：实测一次目录（见 `probeReadable()` 的说明）
    if (probeReadable(target)) {
      const st = set({ state: 'ok', scope: 'fs', code: '', message: '' });
      if (before !== 'ok') logOnce(st);
      return st;
    }
    const st = set({
      state: 'lost',
      scope: '',
      code: 'LOCATION_NOT_AUTHORIZED',
      message: '授权失效或丢失',
    });
    logOnce(st);
    return st;
  } catch (e) {
    // 问不到 ≠ 失效：保持上一次的结论（首次就是 unknown）
    if (cur.state === 'ok' || cur.state === 'lost') return snapshot();
    const st = set({
      state: 'unknown',
      scope: '',
      code: (e && e.code) || 'TRIM_FAILED',
      message: (e && e.message) || '',
    });
    logOnce(st);
    return st;
  }
}

/**
 *
 * 说明：⚠️ 没有网关身份（局域网直连 / 独立客户端）时**保持现状**：那些场景本来就不该弹
 */
function ensure(req, opts) {
  const force = !!(opts && opts.force);
  const fresh = cur.checkedAt && Date.now() - cur.checkedAt < CACHE_MS;
  if (!force && fresh && (cur.state === 'ok' || cur.state === 'lost')) return Promise.resolve(snapshot());
  // 强制复核时也要把手上那一趟丢掉：它可能是"授权之前"发出去的（拿回来的是旧答案）
  if (force) inflight = null;
  if (inflight) return inflight;
  const gw = require('./gateway.js').gatewayUser(req);
  if (!gw) return Promise.resolve(snapshot());
  inflight = checkForUser(gw.uid).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * 功能：把结论复位成「待判」（只给测试用）。
 * @returns {void}
 */
function resetForTests() {
  cur = { state: 'pending', scope: '', code: '', message: '', checkedAt: 0 };
  inflight = null;
  target = '';
  enforce = false;
}

module.exports = { CACHE_MS, init, invalidate, snapshot, checkAtStartup, checkForUser, ensure, resetForTests };
