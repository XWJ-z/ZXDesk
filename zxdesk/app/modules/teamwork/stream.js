/**
 * modules/teamwork/stream.js —— 对话的**实时通道**
 *
 * 功能：进程内的 SSE 连接登记表与推送口 ——
 * `canConnect()` / `addClient()` / `removeClient()` 维护「哪个账号开着几条长连接」，
 * `pushToUsers()` 把一条增量事件写给指定账号的全部连接，
 * `sseHead()` / `frame()` 负责 SSE 的响应头与帧格式，`_reset()` 是给测试用的清空口…
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */
'use strict';

const { json } = require('../../core/http-util.js');

/**
 * 单个账号允许同时开着的 SSE 连接数上限。
 * 存在的意义是「防止一个坏掉的客户端把连接数刷爆」，不是产品限制 ——
 */
const MAX_PER_USER = 5;

/**
 * 心跳间隔（毫秒）。⚠️ 这个数字**不是拍的**，而是「比任何一个已知中间层的空闲超时都短」：
 * 所以先取一个明显保守的 25 秒，并在真机验收里确认连接不再被掐断。
 */
const PING_MS = 25000;

/** 连接登记表：`账号 id → 该账号当前开着的响应对象集合` @type {Map<number, Set<Object>>} */
const clients = new Map();

/**
 * 功能：读某个账号当前开着的 SSE 连接数（测试与连接上限判定用）。
 * @param {number} uid - 账号 id
 * @returns {number} 连接条数
 */
function countClients(uid) {
  const set = clients.get(Number(uid));
  return set ? set.size : 0;
}

/**
 * 功能：判断某个账号还能不能再开一条 SSE 连接（超过上限时路由层直接回 429）。
 * @param {number} uid - 账号 id
 * @returns {boolean} 允许连接返回 true
 */
function canConnect(uid) {
  return countClients(uid) < MAX_PER_USER;
}

/**
 * 功能：登记一条 SSE 连接。
 * @param {number} uid - 账号 id
 * @param {Object} res - HTTP 响应对象（长连接）
 * @returns {void}
 */
function addClient(uid, res) {
  const key = Number(uid);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
}

/**
 * 功能：注销一条 SSE 连接（`req.on('close')` 与推送失败时都会走它）。
 * @param {number} uid - 账号 id
 * @param {Object} res - HTTP 响应对象
 * @returns {void}
 */
function removeClient(uid, res) {
  const key = Number(uid);
  const set = clients.get(key);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(key);
}

/**
 * 功能：读某个账号此刻的**会话世代**（`users.session_epoch`）—— 取不到（账号已删 / 没传 store）按 0 算。
 *
 * 于是「建连那一刻的世代」与「现在」对不上，就说明这条长连接的主人**已经不是当前会话**了。
 * 判定本身住在 `core`（`store.sessionEpoch()`，登录令牌用的是同一个值），这里只读不写。
 *
 */
function epochOf(store, uid) {
  try {
    return store && typeof store.sessionEpoch === 'function' ? Number(store.sessionEpoch(uid) || 0) : 0;
  } catch (_e) {
    return 0;
  }
}

/**
 * 功能：**断开某个账号的全部 SSE 长连接**（009 报告 S3）。
 *
 * 调用方是 `core/server.js` 的登出分支（走 `teamworkStream` **可选钩子**：模块被删掉时它压根不存在，
 * 登出照常成功）。⚠️ 只断这个账号自己的连接，别动别人的。
 *
 */
function dropUser(uid) {
  const key = Number(uid);
  const set = clients.get(key);
  if (!set) return 0;
  let n = 0;
  for (const res of [...set]) {
    removeClient(key, res);
    try {
      res.end();
    } catch (_e) {
      /* 连接本来就已经没了 */
    }
    n += 1;
  }
  return n;
}

/**
 * 功能：把一条事件写成 SSE 帧（`data: {...}\n\n`）。
 *
 * 说明：⭐ **不使用 `event:` / `id:` 字段**：一期只有一种事件类型（放在 JSON 的 `type` 里），
 * 而 `id:` 会触发浏览器的 `Last-Event-ID` 重连语义 —— 我们的补齐靠**自己记录每个会话的
 *
 */
function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 功能：写 SSE 的响应头并发出首帧（`retry` 与一行注释）。
 *
 * 说明：⭐ 首帧里带 `retry: 3000`，让浏览器知道断线后隔 3 秒重连（默认 3 秒，写出来是**明示**）；
 * 紧接着一行 `: connected` 注释帧，让客户端能在**读到的第一个字节**就确认「连接建起来了」，
 * 而不是等到第一条消息才知道（前端据此把状态从「重连中」翻成「在线」）。
 */
function sseHead(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try {
    req.socket.setTimeout(0);
    res.setTimeout(0);
  } catch (_e) {
    /* 某些实现下拿不到 socket —— 不影响 SSE 本身 */
  }
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');
}

/**
 * 功能：把一条事件推给**指定的一批账号**（每个账号的所有连接都收到一份）。
 *
 * 单条连接写失败（对端已断、socket 已销毁）只**把它踢出登记表**，
 *
 * @param {Array.<number>} uids - 目标账号 id 数组
 */
function pushToUsers(uids, payload, store) {
  const text = frame(payload);
  let sent = 0;
  const targets = [...new Set((Array.isArray(uids) ? uids : []).map(Number))].filter((n) => Number.isInteger(n));
  for (const uid of targets) {
    const set = clients.get(uid);
    if (!set || !set.size) continue;
    // 009 报告 S3：会话已作废（改密 / 被管理员重置 / 换实例恢复）的连接**一条都不该再收到** ——
    // 与建连时记下的世代比一比，不符就直接断掉（心跳那一路也在比，这里只是让窗口更小）。
    const e = epochOf(store, uid);
    for (const res of [...set]) {
      if (store && res.zxEpoch !== undefined && Number(res.zxEpoch) !== e) {
        removeClient(uid, res);
        try {
          res.end();
        } catch (_e) {
          /* 已经断了 */
        }
        continue;
      }
      try {
        res.write(text);
        sent += 1;
      } catch (_e) {
        removeClient(uid, res);
      }
    }
  }
  return sent;
}

/**
 * 功能：周期心跳 —— 给一条连接发一行 SSE 注释（`: ping`）。
 *
 * 说明：注释帧不会触发任何事件、也不会被前端解析，它唯一的用途是**让中间层看到有数据在流**，
 * 从而不把这条空闲长连接掐掉。⚠️ 调用方（路由层）必须把定时器在 `close` 时清掉，
 *
 */
function startPing(res, onTick) {
  return setInterval(() => {
    try {
      if (onTick && onTick() === false) return;
      res.write(': ping\n\n');
    } catch (_e) {
      /* 写不进去说明连接已经没了，close 事件会负责清理 */
    }
  }, PING_MS);
}

/**
 * 功能：清空全部连接登记（**测试缝**）。
 *
 * 说明：⚠️ 只给 `ttt/test/teamwork.test.js` 用（同一进程里反复起服务，上一条连接可能还没关干净）。
 * 生产代码里没有任何调用点；它**不会**去关那些 socket（那是调用方的事）。
 *
 */
function _reset() {
  clients.clear();
}

/**
 * 功能：处理 **SSE 长连接** `GET /api/teamwork/stream` —— 建连、登记、心跳、断连清理。
 *
 * 说明：⭐ 它**不在** `API_ROUTES` 表里（与 `/api/health` 同理：长连接不能走「处理完就 `end`」
 * 的常规路径），而是由 `server.js` 的 `handleApi` 在查表**之前**显式分派；
 * 因此**登录闸门已经过了一道**（放在闸门之前就是匿名长连接，那等于任何人都能收消息）。
 */
function handleTeamworkStream(req, res, user, store) {
  if (!canConnect(user.id)) {
    return json(res, 429, { error: '实时连接数过多，请关掉一些页面后再试' });
  }
  // 009 报告 S3：记下建连那一刻的会话世代 —— 之后每一拍心跳都比一次。
  // （登出走的不是这条路：它不动 `session_epoch`，而是由 `dropUser()` 直接断开。）
  res.zxEpoch = epochOf(store, user.id);
  const stale = () => !!store && Number(res.zxEpoch) !== epochOf(store, user.id);

  sseHead(req, res);
  addClient(user.id, res);

  let timer = null;
  let done = false;
  /** 功能：断连清理（幂等 —— 两个 close 事件可能都触发）。 */
  const cleanup = () => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    removeClient(user.id, res);
  };
  timer = startPing(res, () => {
    if (stale()) {
      cleanup();
      try {
        res.end();
      } catch (_e) {
        /* 已经断了 */
      }
      return false;
    }
    return true;
  });
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

module.exports = {
  MAX_PER_USER,
  PING_MS,
  canConnect,
  addClient,
  removeClient,
  dropUser,
  countClients,
  pushToUsers,
  sseHead,
  startPing,
  handleTeamworkStream,
  _reset,
};
