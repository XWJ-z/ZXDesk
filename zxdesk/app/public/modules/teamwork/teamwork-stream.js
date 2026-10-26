/**
 * modules/teamwork/teamwork-stream.js —— 对话的实时通道客户端（两端共用，0.3.5）
 *
 * 功能：`createTeamworkStream()` 建一条 `EventSource(BASE + '/api/teamwork/stream')` 长连接并把事件回调给调用方；
 *      连接失败（或 ⭐ 0.5.2：超时还连不上 / 网关挂住不回）时**自动降级为轮询**（3 秒一次，只拉增量），
 *      并每隔一段时间再试一次长连接；⭐ 0.5.2 起长连接「在线」期间还留一条**对账轮询**
 *      （⭐ 0.5.5 从 10 秒收紧到 3 秒），专治「网关把响应头放行、把正文缓冲住」的假在线。
 *      对外汇报连接状态（在线 / 重连中 / 已降级为轮询），以及 `mergeById()` 这个
 *      「按消息 id 去重合并」的纯函数。
 *
 * ⭐ **两端共用同一份**（这是 `core/` 的判定标准：真正该一致的实现）——
 *    连接管理、降级策略、去重语义在一台设备上与另一台上必须完全一样，
 *    否则会出现「电脑上好好的、手机上丢消息」这种最难查的问题。
 *
 * ⚠️ **它只负责「连」与「报事件」，不负责「拉数据」**：
 *    页面在收到 `message` 事件后如果需要补齐，由调用方自己的 `onPoll()` 去走 REST 分页
 *    （历史消息**永远不走 SSE**，见服务端 `stream.js` 的说明）。
 *    这样这一层不需要认识会话、不需要认识 REST，也就没有第二处「未读数怎么算」的实现。
 *
 * ⚠️ **降级轮询是必须实现的一期功能**（方案 §5.1-8）：飞牛网关/反代对空闲长连接的行为
 *    只能真机验证，若网关会掐断 SSE，没有轮询这条路就是「消息永远不刷新」。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.13
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */

// ⚠️ 地址必须带挂载前缀（飞牛统一网关下应用在 `/app/zxdesk`）—— 唯一的出处是 `core/api.js` 的 BASE
//    ⭐ 0.8.12：本文件从 `public/core/` 搬进模块目录，相对路径跟着上跳两层。
import { BASE } from '../../core/api.js';

/** 降级轮询的间隔（毫秒）—— 与方案 §5.1-8 的 3 秒一致 */
const POLL_MS = 3000;

/** 连续失败几次就认定「SSE 在这台设备/这个网关上不可用」并降级为轮询 */
const FAIL_BEFORE_POLL = 3;

/** 降级之后每隔几个轮询周期再试一次长连接（`POLL_MS × 10` = 30 秒一次） */
const POLL_TICKS_BEFORE_RETRY = 10;

/**
 * ⭐ 0.5.2 建连看门狗：`openSse()` 之后这么多毫秒还没 `onopen` 就认定「这条路不通」，直接转轮询。
 *
 * 为什么必须有：`EventSource` 只有在**连不上**（握手失败 / 断开）时才发 `error`；
 * 若飞牛网关 / 反代把这条请求**挂住不回**（不回握手也不回错误），`error` 永远不来，
 * 界面就永远停在「重连中」—— 真机上这就是「完全没有实时刷新」的一种成因。
 * 6 秒取值：比正常建连（局域网 <100ms，跨网也 <1s）宽裕得多，又不用让用户等太久。
 */
const CONNECT_WATCHDOG_MS = 6000;

/**
 * ⭐ 在线对账轮询：长连接「在线」期间，每隔这么多毫秒仍调一次 `onPoll()` 补齐增量。
 *
 * 为什么在线了还要轮询：另一种真机故障形态是「网关把响应头放出去了、把**正文**缓冲住了」
 * —— `onopen` 正常触发、状态显示「在线」，但事件一帧都到不了，而且没有任何报错。
 * 心跳（服务端 `: ping`）是注释帧，浏览器不派事件，前端探测不到这种假死。
 * 唯一稳妥的办法是留一条慢轮询兜底：SSE 真的好用时，轮询拉回来的都是重复数据
 * （`mergeById()` 按 id 去重，等于白跑一趟）；SSE 假死时，它就是消息能到的唯一通路。
 *
 * ⭐ 0.5.5：**从 10 秒改成 3 秒**（「手机端收到消息有 5 秒延迟，
 *    电脑端没有」，而状态行显示的是「在线」—— 正是上面这种「假在线」形态）。
 *    10 秒的间隔意味着消息**平均要等 5 秒**才被这一拍捞回来，与实测现象完全吻合；
 *    改成 3 秒后上界与降级轮询同拍（`POLL_MS`），后台的省电节流不靠这个数，
 *    而是由两端的 `TEAMWORK_BG_POLL_MS = 30000` 负责（人不在对话屏时每拍直接早退）。
 *    ⚠️ 别再往回调大：这个数的唯一意义就是「假在线时最多等多久」。
 */
const RECONCILE_MS = 3000;

/**
 * 功能：按消息 `id` 把新到的消息并入现有列表 —— **幂等**（重复投递不会出现重复气泡）。
 *
 * 说明：⭐ 这是「游标用自增 id」的直接好处（方案）：重连补齐与实时推送**必然会重叠**，
 *      按 id 去重之后，同一条消息来几次都只显示一次。
 *      ⚠️ 入参**不被修改**（返回新数组）：调用方往往把结果直接赋给状态字段，
 *      就地改会让「有没有变」这件事不可判断（重画与否全靠它）。
 *
 * @param {Array.<Object>} list - 现有消息（按 id 升序）
 * @param {Array.<Object>} incoming - 新到的消息（可能为空、可能是乱序的一小批）
 * @returns {Array.<Object>} 按 id 升序、去重后的新数组
 */
export function mergeById(list, incoming) {
  const map = new Map();
  for (const m of Array.isArray(list) ? list : []) map.set(Number(m.id), m);
  for (const m of Array.isArray(incoming) ? incoming : []) {
    if (m && m.id !== undefined) map.set(Number(m.id), m);
  }
  return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * 功能：建一条对话实时通道（`EventSource` 长连接 + 自动重连 + 降级轮询）。
 *
 * 说明：`onStatus` 会被调用以下四种状态之一 ——
 *      · `'connecting'` 正在建连 / 正在重连；
 *      · `'online'`     长连接活着（此时界面应显示「在线」）；
 *      · `'polling'`    已降级为轮询（界面**必须**把这件事显示出来 ——
 *        否则用户会以为「对方没回」，其实是消息根本没推过来）；
 *      · `'off'`        已主动关闭（离开对话页时）。
 *      ⭐ 从任何非 online 状态切回 online 时，会**先调一次 `onPoll()`** 补齐断线期间漏掉的消息
 *      （方案 §5.3：重连成功后按游标拉增量），所以调用方的 `onPoll()` 必须是幂等的。
 *
 * @param {Object} hooks - 回调集合
 * @param {Function} hooks.onEvent - 收到一条 SSE 事件时调用，入参是解析后的对象
 * @param {Function} [hooks.onStatus] - 连接状态变化时调用，入参是状态字符串
 * @param {Function} [hooks.onPoll] - 需要补齐增量时调用（降级轮询的每一拍、重连成功时）
 * @returns {{ start: Function, stop: Function, status: Function }} 通道控制句柄
 */
export function createTeamworkStream(hooks) {
  const h = hooks || {};
  const onEvent = typeof h.onEvent === 'function' ? h.onEvent : () => {};
  const onStatus = typeof h.onStatus === 'function' ? h.onStatus : () => {};
  const onPoll = typeof h.onPoll === 'function' ? h.onPoll : () => {};

  /** @type {?EventSource} 当前的长连接；降级期间为 null */
  let es = null;
  /** @type {?number} 降级轮询的定时器 */
  let pollTimer = null;
  /** @type {?number} 建连看门狗的定时器（`onopen` 或转轮询时拆掉） */
  let watchdog = null;
  /** @type {?number} 在线对账轮询的定时器（转轮询 / 关闭时拆掉） */
  let reconcile = null;
  /** 连续失败次数（`onopen` 时清零） */
  let fails = 0;
  /** 降级轮询已经走了几拍（用来决定什么时候再试一次长连接） */
  let ticks = 0;
  /** 当前状态 */
  let state = 'off';
  /** 是否曾经连上过（用于「重连成功后补齐一次」） */
  let everOnline = false;

  /**
   * 功能：切换状态并通知调用方（状态没变时不重复通知，避免界面无谓重画）。
   * @param {string} next - 新状态
   * @returns {void}
   */
  function setStatus(next) {
    if (state === next) return;
    state = next;
    onStatus(next);
  }

  /**
   * 功能：拆掉建连看门狗（`onopen` / 转轮询 / 关闭时调用）。
   * @returns {void}
   */
  function stopWatchdog() {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  /**
   * 功能：拆掉在线对账轮询（转降级轮询 / 关闭通道时调用 —— 3 秒一轮的降级轮询已经覆盖它）。
   * @returns {void}
   */
  function stopReconcile() {
    if (reconcile) {
      clearInterval(reconcile);
      reconcile = null;
    }
  }

  /**
   * 功能：停掉降级轮询（切回长连接 / 关闭通道时调用）。
   * @returns {void}
   */
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * 功能：启动降级轮询 —— 每 `POLL_MS` 拉一次增量，并每隔若干拍再试一次长连接。
   *
   * 说明：⚠️ `setStatus('polling')` 与「拆看门狗 / 对账轮询」必须放在**定时器已存在就早退之前**：
   *        轮询期间的定时重试（`openSse()`）失败后还会走到这里，那时轮询本来就在跑，
   *        若先早退，状态就会永远停在「重连中」（实测过）。
   *
   * @returns {void}
   */
  function startPolling() {
    stopWatchdog();
    stopReconcile();
    setStatus('polling');
    if (pollTimer) return;
    ticks = 0;
    pollTimer = setInterval(() => {
      ticks += 1;
      try {
        onPoll();
      } catch (_e) {
        /* 拉取失败由调用方自己提示；这里只保证定时器不被一次异常打断 */
      }
      if (ticks % POLL_TICKS_BEFORE_RETRY === 0) openSse();
    }, POLL_MS);
  }

  /**
   * 功能：建（或重建）长连接 —— 先关掉旧的，再开一条新的。
   * @returns {void}
   */
  function openSse() {
    closeSse();
    // ⚠️ 降级轮询期间的定时重试不改状态：界面继续如实显示「已降级为轮询」，
    //    否则一次失败的重试会把状态挂在「重连中」直到下一拍（见 startPolling 的说明）。
    if (state !== 'polling') setStatus('connecting');
    try {
      es = new EventSource(BASE + '/api/teamwork/stream');
    } catch (_e) {
      es = null;
      startPolling();
      return;
    }
    // ⚠️ 把这一条连接单独抓一份：下面 `onerror` 要读**它自己**的 `readyState`。
    //    直接读外层的 `es` 会读到「更新的一条」（旧的 error 事件在新建连接之后才到，
    //    那时外层 `es` 已经指向新连接了），判断就落在错的那条上。
    const conn = es;
    // ⭐ 0.5.2 建连看门狗：网关把请求挂住不回时，`error` 不会来，只能靠超时自救
    stopWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      if (state !== 'online') startPolling();
    }, CONNECT_WATCHDOG_MS);
    es.onopen = () => {
      const wasOffline = !everOnline || fails > 0;
      fails = 0;
      everOnline = true;
      stopWatchdog();
      stopPolling();
      setStatus('online');
      // ⭐ 0.5.2 在线对账轮询：防「响应头到了、正文被网关缓冲住」的假在线（见 RECONCILE_MS 的说明）
      stopReconcile();
      reconcile = setInterval(() => {
        try {
          onPoll();
        } catch (_e) {
          /* 同降级轮询：一拍失败不拖垮连接 */
        }
      }, RECONCILE_MS);
      // ⭐ 断线期间漏掉的消息在这里补齐（幂等，重复拉不会有重复气泡）
      if (wasOffline) {
        try {
          onPoll();
        } catch (_e) {
          /* 同上：补齐失败不影响连接本身 */
        }
      }
    };
    es.onmessage = (ev) => {
      // 解析失败（半截帧 / 非 JSON）就当这一帧不存在 —— 长连接绝不能因为一帧坏数据整条断掉
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch (_e) {
        return;
      }
      if (payload && typeof payload === 'object') onEvent(payload);
    };
    es.onerror = () => {
      fails += 1;
      // EventSource 自己会按服务端给的 `retry` 重连，但连不上三次就说明这条路走不通 ——
      // 此时必须**换一条路**（轮询），而不是让界面一直停在「重连中」。
      // ⭐ 0.5.5：`readyState === 2`（CLOSED）是**另一种**走不通，而且以前会被漏掉 ——
      //    浏览器已经**永久放弃**这条连接、不会再重连。触发它的不是「连不上」，而是
      //    服务端直接回了非 200 / 非 `text/event-stream`（最典型的就是每账号 5 条连接上限
      //    的 **429**）：规范规定这种响应要 `fail the connection` **且不重试**，于是
      //    `error` 只来这一次、`fails` 永远到不了 `FAIL_BEFORE_POLL` ⇒ 既没有长连接、
      //    也没有轮询，界面永远停在「重连中」，**消息一条都不会到**（且全程不报错）。
      //    所以这一条单独判，直接落到轮询。
      if (fails >= FAIL_BEFORE_POLL || conn.readyState === 2) startPolling();
      else setStatus('connecting');
    };
  }

  /**
   * 功能：关掉当前长连接（不改变对外状态）。
   * @returns {void}
   */
  function closeSse() {
    stopWatchdog();
    if (!es) return;
    try {
      es.close();
    } catch (_e) {
      /* 已经关掉的连接再 close 会抛 —— 忽略 */
    }
    es = null;
  }

  return {
    /**
     * 功能：打开通道（进入对话页时调用）。
     * @returns {void}
     */
    start() {
      if (state !== 'off') return;
      everOnline = false;
      fails = 0;
      openSse();
    },
    /**
     * 功能：关闭通道（登出 / 模块被关掉时调用 —— 0.5.2 起通道是**常驻**的，
     *      不再跟随「进出对话页」开关，见调用方的说明）。
     * @returns {void}
     */
    stop() {
      closeSse();
      stopPolling();
      stopReconcile();
      everOnline = false;
      state = 'off';
      onStatus('off');
    },
    /**
     * 功能：读当前状态（'off' / 'connecting' / 'online' / 'polling'）。
     * @returns {string} 状态字符串
     */
    status() {
      return state;
    },
  };
}
