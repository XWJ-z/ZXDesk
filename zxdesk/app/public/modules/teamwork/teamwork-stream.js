/**
 * modules/teamwork/teamwork-stream.js —— 对话的实时通道客户端
 *
 * 功能：`createTeamworkStream()` 建一条 `EventSource(BASE + '/api/teamwork/stream')` 长连接并把事件回调给调用方；
 * 连接失败（或 超时还连不上 / 网关挂住不回）时**自动降级为轮询**（3 秒一次，只拉增量），
 * 并每隔一段时间再试一次长连接；起长连接「在线」期间还留一条**对账轮询**
 * （从 10 秒收紧到 3 秒），专治「网关把响应头放行、把正文缓冲住」的假在线。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */

// 地址必须带挂载前缀（飞牛统一网关下应用在 `/app/zxdesk`）—— 唯一的出处是 `core/api.js` 的 BASE
// 本文件从 `public/core/` 搬进模块目录，相对路径跟着上跳两层。
import { BASE } from '../../core/api.js';

/** 降级轮询的间隔（毫秒）—— 与方案 §5.1-8 的 3 秒一致 */
const POLL_MS = 3000;

/** 连续失败几次就认定「SSE 在这台设备/这个网关上不可用」并降级为轮询 */
const FAIL_BEFORE_POLL = 3;

/** 降级之后每隔几个轮询周期再试一次长连接（`POLL_MS × 10` = 30 秒一次） */
const POLL_TICKS_BEFORE_RETRY = 10;

/**
 * 建连看门狗：`openSse()` 之后这么多毫秒还没 `onopen` 就认定「这条路不通」，直接转轮询。
 *
 */
const CONNECT_WATCHDOG_MS = 6000;

/**
 * 在线对账轮询：长连接「在线」期间，每隔这么多毫秒仍调一次 `onPoll()` 补齐增量。
 *
 */
const RECONCILE_MS = 3000;

/**
 * 功能：按消息 `id` 把新到的消息并入现有列表 —— **幂等**（重复投递不会出现重复气泡）。
 *
 * 说明：⭐ 这是「游标用自增 id」的直接好处（方案）：重连补齐与实时推送**必然会重叠**，
 * 按 id 去重之后，同一条消息来几次都只显示一次。
 * 入参**不被修改**（返回新数组）：调用方往往把结果直接赋给状态字段，
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
 * `'connecting'` 正在建连 / 正在重连；
 * `'online'`     长连接活着（此时界面应显示「在线」）；
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
   * 轮询期间的定时重试（`openSse()`）失败后还会走到这里，那时轮询本来就在跑，
   * 若先早退，状态就会永远停在「重连中」（实测过）。
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
    // 降级轮询期间的定时重试不改状态：界面继续如实显示「已降级为轮询」，
    if (state !== 'polling') setStatus('connecting');
    try {
      es = new EventSource(BASE + '/api/teamwork/stream');
    } catch (_e) {
      es = null;
      startPolling();
      return;
    }
    // 把这一条连接单独抓一份：下面 `onerror` 要读**它自己**的 `readyState`。
    // 直接读外层的 `es` 会读到「更新的一条」（旧的 error 事件在新建连接之后才到，
    // 那时外层 `es` 已经指向新连接了），判断就落在错的那条上。
    const conn = es;
    // 建连看门狗：网关把请求挂住不回时，`error` 不会来，只能靠超时自救
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
      // 在线对账轮询：防「响应头到了、正文被网关缓冲住」的假在线（见 RECONCILE_MS 的说明）
      stopReconcile();
      reconcile = setInterval(() => {
        try {
          onPoll();
        } catch (_e) {
          /* 同降级轮询：一拍失败不拖垮连接 */
        }
      }, RECONCILE_MS);
      if (wasOffline) {
        try {
          onPoll();
        } catch (_e) {
          /* 同上：补齐失败不影响连接本身 */
        }
      }
    };
    es.onmessage = (ev) => {
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
      // 浏览器已经**永久放弃**这条连接、不会再重连。触发它的不是「连不上」，而是
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
     * 不再跟随「进出对话页」开关，见调用方的说明）。
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
