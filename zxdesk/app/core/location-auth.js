/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：location-auth.js
 * 职责：数据位置的**授权体检**（启动时查一次，之后按网关身份复核）
 *
 * 功能：`init()` 记住当前的数据库目录；`checkAtStartup()` 在每次启动时问一次飞牛
 *      「应用共享授权里还有没有这个目录」；`ensure(req)` 在有网关身份时补一次
 *      「共享 ∪ 该用户的个人授权」的复核；`snapshot()` 给 `/api/health` 读。
 *
 * ⭐⭐ 为什么需要它：飞牛把目录的 ACL 授予**应用用户**，而这份授权在卸载重装 /
 *      手动撤销之后会丢（官方口径：后端查授权结果就是给「页面刷新 / 服务重启后
 *      重新同步授权状态」用的）。数据位置被用户搬到自定义目录之后，一旦授权丢了，
 *      表现是「数据库文件获取失败」，而用户完全不知道要去哪里修 —— 所以要主动检查并指路。
 *
 * ⚠️ 三档结论，⛔ 不许把「查不到」并进「失效」：
 *      · `ok`      —— 覆盖（来源 `shared` 或 `user`）
 *      · `lost`    —— 问到了、确实不在授权列表里
 *      · `unknown` —— 问不到（没有 TRIM_API_TOKEN / 不在网关里 / 网关超时）
 *      · `pending` —— 启动时只查了共享授权、没覆盖；等有网关身份的请求再判（可能走的是个人授权）
 *      「问不到」就报「失效」会让每一台用局域网直连的机器一启动就红一片。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、https://developer.fnnas.com/api/authorization/overview/
 */
'use strict';

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
 * ⭐ 为什么默认位置不查：安装位置的 data-share 是**飞牛在装应用时**就安排好的，
 *    它不一定出现在 `getSharedAccessibleFolders()` 那份「应用共享授权」清单里；
 *    拿那份清单去判默认位置，会在**每一台正常安装的机器**上判出「未授权」——
 *    那就不是提示，是误报灾难。⇒ 只在用户自己搬过位置（自定义目录）时才强制。
 * @type {boolean}
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
  // ⭐⭐ 授权清单一变（新授权 / 撤销 / 面板刷新都会走 `trimApi.invalidate()`），本模块的结论
  //    就必须作废 —— 否则用户刚在「个人授权目录」里授权完，这边还拿着 5 分钟前的 `lost`
  //    继续弹「数据库授权没有完成」（2026-11-10 真机反馈的正是它）。
  //    ⚠️ 注册在 `init()` 里是因为 `location-auth` 依赖 `trim-api`（反向注册会成环）。
  trimApi.onInvalidate(invalidate);
}

/**
 * 功能：作废当前结论（下一次 `ensure()` 会真的去问一次网关）。
 *
 * 说明：⚠️ **只清时间戳，不改 `state`** —— 立刻把结论写成 `pending` 会让界面在"还没问完"
 *      的那一瞬间以为授权没问题（反而更糟）。等真的问回来再改。
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
    logFn('info', `数据位置授权有效（来源：${st.scope === 'user' ? '个人授权' : '应用共享授权'}）：${target}`);
  } else if (st.state === 'lost') {
    logFn(
      'error',
      `⚠️ 数据位置已不在授权列表里（${target}）—— 数据库文件可能读不到。` +
        '请到「设置 → 账号设置 → 个人授权目录」重新授权，或用 cmd/data-location-reset 回到安装位置。',
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
 *      共享没覆盖时进 `pending`（**不是** `lost`）—— 个人授权场景下这是正常的。
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
 * 功能：按网关身份复核 —— 「应用共享 ∪ 该用户的个人授权」。
 * @param {number} uid - 飞牛用户 uid（**只从网关 Header 来**）
 * @returns {Promise.<Object>} 结论
 */
async function checkForUser(uid) {
  if (!target) return snapshot();
  if (!enforce) return set({ state: 'ok', scope: 'install', code: '', message: '' });
  try {
    if (isGranted(target, await sharedPaths())) {
      const before = cur.state;
      const st = set({ state: 'ok', scope: 'shared', code: '', message: '' });
      // ⚠️ 只在「结论变了」时写日志：每次 health 都报一行会把 app.log 刷满
      if (before !== 'ok') logOnce(st);
      return st;
    }
    const mine = await trimApi.getUserAccessibleFolders(uid);
    if (isGranted(target, Array.isArray(mine) ? mine : [])) {
      const st = set({ state: 'ok', scope: 'user', code: '', message: '' });
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
    // ⚠️ 问不到 ≠ 失效：保持上一次的结论（首次就是 unknown）
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
 * 功能：按需复核（`/api/health` 调用）—— 结论还新鲜就直接回，否则用网关身份问一次。
 *
 * 说明：⚠️ 没有网关身份（局域网直连 / 独立客户端）时**保持现状**：那些场景本来就不该弹
 *      「去授权」——它们没有授权能力（授权只在宿主里做）。
 * @param {Object} req - HTTP 请求（取网关身份）
 * @param {{force?: boolean}} [opts] - `force: true` = 不看缓存，现在就问一次（首屏 / 「重新检查」用）
 * @returns {Promise.<Object>} 结论
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
