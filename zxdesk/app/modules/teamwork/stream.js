/**
 * modules/teamwork/stream.js —— 对话的**实时通道**（SSE，零依赖，0.3.5）
 *
 * 功能：进程内的 SSE 连接登记表与推送口 ——
 *      `canConnect()` / `addClient()` / `removeClient()` 维护「哪个账号开着几条长连接」，
 *      `pushToUsers()` 把一条增量事件写给指定账号的全部连接，
 *      `sseHead()` / `frame()` 负责 SSE 的响应头与帧格式，`_reset()` 是给测试用的清空口；
 *      `handleTeamworkStream()` 是 ⭐ **长连接的 HTTP 入口**（建连、429 闸门、心跳、断连清理）——
 *      0.5.0从 `routes/teamwork.js` 搬来：它用的全是本文件自己的东西，留在路由文件里
 *      就得反过来把路由 require 进本文件，那是白绕一圈。
 *
 * ⭐ **为什么单开一个文件**：
 *      ① 长连接**不能走**「处理完就 `res.end()`」的常规路径，`server.js` 里必须为它留一个
 *         独立分支（与 `/api/health` 同理）——那部分代码放在 `routes.js` 里会与
 *         REST 处理函数混在一起，很难看清「它是个长连接」；
 *      ② 它是**进程内**状态（`Map<uid, Set<res>>`），生命周期比任何一次请求都长，
 *         必须有一个明确的归属；
 *      ③ ⚠️ 它**绝不 require `context.js`**：若它 require 了（只为打一行日志），
 *         依赖链就会变成 `modules/teamwork/store.js → stream.js → context → storage → store` —— **成环**。
 *         所以这里刻意不打日志：一个进程内的推送口不值得为它引一条环。
 *      ⚠️ 它只 require 一样东西：`core/http-util.js` 的 `json`（429 那条响应用）。
 *         这条链（`http-util → context → storage → store`）**不会绕回本文件** ——
 *         `store.js` 不 require 它，`server.js` 也先 require `context.js` 再 require 注册表，
 *         所以不成环。
 *
 * ⚠️ **推送只走增量**（方案 §5.1-7）：历史消息**永远不通过 SSE 传**（那走 REST 分页）。
 *    SSE 只负责「刚发生的事」，因此断线也不需要「补发」，由前端按游标拉增量补齐。
 * ⚠️ **推送范围必须按 `teamwork_members` 过滤**（方案 §八-3）：`pushToUsers` 的入参由
 *    `routes.js` 用 `store.teamworkMemberIds(cid)` 算出来 —— 这一层**不认识会话**，
 *    也**绝不广播给所有人**。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/chat-stream.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七）；`handleTeamworkStream` 从 `core/routes/teamwork.js` 原样搬来，
 *    只把 `stream.xxx(...)` 改成 `xxx(...)`（在同一个文件里不必再自我引用）。
 *    ⚠️ 核心（`server.js`）取它走的是**可选钩子**（注册表给目录 + `fs.existsSync`）：
 *    模块被删掉时回 `null`，那条长连接请求退化成 **404**（不是 500、也不是挂住不返回）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.13
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */
'use strict';

const { json } = require('../../core/http-util.js');

/**
 * 单个账号允许同时开着的 SSE 连接数上限。
 * ⚠️ 存在的意义是「防止一个坏掉的客户端把连接数刷爆」，不是产品限制 ——
 * 一个人手上（电脑 + 手机 + 平板 + 若干浏览器标签）到不了 5 条。
 */
const MAX_PER_USER = 5;

/**
 * 心跳间隔（毫秒）。⚠️ 这个数字**不是拍的**，而是「比任何一个已知中间层的空闲超时都短」：
 * 飞牛网关 / 反代 / 浏览器对空闲长连接的超时值本机测不出来，只能真机验（方案 §十二），
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
 * 说明：⭐ 009 报告 S3：改密码 / 被管理员重置密码 / 换实例恢复备份，都会让这一列 +1 ——
 *      于是「建连那一刻的世代」与「现在」对不上，就说明这条长连接的主人**已经不是当前会话**了。
 *      判定本身住在 `core`（`store.sessionEpoch()`，登录令牌用的是同一个值），这里只读不写。
 *
 * @param {Object} store - 存储层实例（可能为 null —— 老调用方不传时整条守卫自动降级为空操作）
 * @param {number} uid - 账号 id
 * @returns {number} 会话世代
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
 * 说明：⭐ 登出时调用。Cookie 是浏览器共享的，而**已经建好的长连接**不会因为 Cookie 被清掉而断开 ——
 *      「我在这台机器上登出了，另一个标签页还开着，对面又发消息」正是这条要盖的场景。
 *      ⚠️ 调用方是 `core/server.js` 的登出分支（走 `teamworkStream` **可选钩子**：模块被删掉时它压根不存在，
 *      登出照常成功）。⚠️ 只断这个账号自己的连接，别动别人的。
 *
 * @param {number} uid - 账号 id
 * @returns {number} 实际断开的连接条数（测试断言用得上）
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
 *      而 `id:` 会触发浏览器的 `Last-Event-ID` 重连语义 —— 我们的补齐靠**自己记录每个会话的
 *      最大消息 id**（方案 §5.3），多一套浏览器侧的游标只会让「到底以谁为准」变模糊。
 *      ⚠️ JSON 里**不许出现换行**（`JSON.stringify` 天然保证），否则一帧会被拆成两帧。
 *
 * @param {Object} payload - 事件体（形如 `{type:'message', …}`）
 * @returns {string} 可直接 `res.write()` 的帧文本
 */
function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 功能：写 SSE 的响应头并发出首帧（`retry` 与一行注释）。
 *
 * 说明：⭐ 首帧里带 `retry: 3000`，让浏览器知道断线后隔 3 秒重连（默认 3 秒，写出来是**明示**）；
 *      紧接着一行 `: connected` 注释帧，让客户端能在**读到的第一个字节**就确认「连接建起来了」，
 *      而不是等到第一条消息才知道（前端据此把状态从「重连中」翻成「在线」）。
 * ⚠️ `X-Accel-Buffering: no` 是给 Nginx 一类反代看的：不加它，反代会把 SSE 缓冲到整段结束才发，
 *    表现是「消息一条都不实时到达，但刷新页面都在」。
 * ⚠️ `res.setTimeout(0)` / `req.socket.setTimeout(0)`：长连接**必须**关掉这个 socket 的超时，
 *    否则某些 Node 版本 / 反代会在空闲若干秒后直接断掉它（而心跳是 25 秒一次，撞上就是断线循环）。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @returns {void}
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
 * 说明：⚠️ 入参由调用方按 `teamwork_members` 算好（方案 §八-3），这一层不做任何范围判断。
 *      ⚠️ 单条连接写失败（对端已断、socket 已销毁）只**把它踢出登记表**，
 *      绝不让一个坏连接打断其余账号的推送 —— 那会让「一个人关掉浏览器」变成所有人都收不到消息。
 *
 * @param {Array.<number>} uids - 目标账号 id 数组
 * @param {Object} payload - 事件体
 * @param {Object} [store] - 存储层实例（给了才做「会话世代」复核，见 009 报告 S3）
 * @returns {number} 实际写出去的连接条数（测试断言「不该收的人没收」时用得上）
 */
function pushToUsers(uids, payload, store) {
  const text = frame(payload);
  let sent = 0;
  const targets = [...new Set((Array.isArray(uids) ? uids : []).map(Number))].filter((n) => Number.isInteger(n));
  for (const uid of targets) {
    const set = clients.get(uid);
    if (!set || !set.size) continue;
    // ⭐ 009 报告 S3：会话已作废（改密 / 被管理员重置 / 换实例恢复）的连接**一条都不该再收到** ——
    //    与建连时记下的世代比一比，不符就直接断掉（心跳那一路也在比，这里只是让窗口更小）。
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
 *      从而不把这条空闲长连接掐掉。⚠️ 调用方（路由层）必须把定时器在 `close` 时清掉，
 *      否则连接断了定时器还在跑（内存泄漏 + 往已销毁的 socket 写）。
 *
 * @param {Object} res - HTTP 响应对象
 * @param {Function} [onTick] - 每拍**先**跑一次的回调；返回 `false` 表示这条连接已废（不再发心跳）。
 *      ⭐ 009 报告 S3 用它做「会话世代」复核 —— 回调里自己收尾（断开 + 注销登记），这里只负责别写坏 socket
 * @returns {number} 定时器句柄（供 `clearInterval`）
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
 *      生产代码里没有任何调用点；它**不会**去关那些 socket（那是调用方的事）。
 *
 * @returns {void}
 */
function _reset() {
  clients.clear();
}

/**
 * 功能：处理 **SSE 长连接** `GET /api/teamwork/stream` —— 建连、登记、心跳、断连清理。
 *
 * 说明：⭐ 它**不在** `API_ROUTES` 表里（与 `/api/health` 同理：长连接不能走「处理完就 `end`」
 *      的常规路径），而是由 `server.js` 的 `handleApi` 在查表**之前**显式分派；
 *      因此**登录闸门已经过了一道**（放在闸门之前就是匿名长连接，那等于任何人都能收消息）。
 *      ⚠️ 0.5.0起，核心取的是**可选钩子**（注册表给目录 + `fs.existsSync`）：
 *      模块被删掉时它回 `null`，`server.js` 那条分支直接回 404。
 *
 * ⚠️ 连接数上限（每个账号 5 条）：超了直接 429 —— 此时**还没写 SSE 响应头**，
 *    所以还能回一个正常的 JSON 错误（写过头之后再回就晚了）。
 * ⚠️ 清理必须挂在 `req.on('close')` / `res.on('close')` **两处**：Node 在不同断开方式下
 *    触发的事件不一样（客户端关页面走 req，服务端写失败走 res），只挂一处会漏连接 ——
 *    漏掉的表现是「连接数只增不减」，几十次刷新之后这个人就再也连不上了（一直 429）。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @param {Object} user - 当前登录账号（`{ id, username, … }`）
 * @param {Object} [store] - 存储层实例（给了才做「会话世代」复核，见 009 报告 S3）
 * @returns {void}
 */
function handleTeamworkStream(req, res, user, store) {
  if (!canConnect(user.id)) {
    return json(res, 429, { error: '实时连接数过多，请关掉一些页面后再试' });
  }
  // ⭐ 009 报告 S3：记下建连那一刻的会话世代 —— 之后每一拍心跳都比一次。
  //    改密 / 被管理员重置密码 / 换实例恢复备份都会让它 +1，那时这条连接已经不该再收消息了。
  //    （登出走的不是这条路：它不动 `session_epoch`，而是由 `dropUser()` 直接断开。）
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
