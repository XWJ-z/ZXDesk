/**
 * modules/trip/recorder.js —— 轨迹记录器
 *
 * 功能：`watchPosition` 采点 → 本地按 `at` 升序累积 → ⭐ **每 20 秒或每满 50 个点发一批**
 * （`POST /api/trip/points`）→ 记录期间申请**屏幕常亮** → 失败时**本地继续攒**…
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

import { api } from '../../core/api.js';

/** 每 20 秒刷一批（方案 §7.6-2）。 */
const FLUSH_MS = 20000;

/** 或每满 50 个点刷一批（同上：两个条件**谁先到算谁**）。 */
const FLUSH_MAX = 50;

/** 服务端一次最多收 200 个点 —— ⚠️ 与 `modules/trip/store.js` 的 `POINT_MAX_BATCH` 同值。 */
const BATCH_MAX = 200;

/** 采点的选项 —— ⚠️ 三个值都是方案 §7.6-2 点名的：高精度、不要缓存、15 秒超时。 */
const GEO_OPTS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

/** 现在是不是在记录 */
let recording = false;
/** 这一趟记到哪个行程里（`null` = 不归属任何行程） */
let tripId = null;
/** `watchPosition` 的句柄（停止时要用它 `clearWatch`） */
let watchId = null;
/** 20 秒那个定时器的句柄 */
let timer = null;
/** 屏幕常亮的 `WakeLockSentinel`（拿不到就是 null —— ⛔ 不阻断记录） */
let lock = null;
/** ⭐ **还没传上去的点**（失败时**不清空**，这是「离线可用」的落点） */
let queue = [];
/** 已经传上去的点数 */
let sent = 0;
/** 定位/上传最近一次出问题的原因（人话，空串 = 一切正常） */
let error = '';
/** 页面注册的变化回调（**只有一份** —— 两端各自在进屏时替换掉它） */
let onChange = null;

/**
 * 功能：把可选数字归一化（`null` / `undefined` / 非有限数一律 `null`）。
 *
 * 说明：⚠️ 手动填的点没有精度、室内没有海拔、静止时速度可能是 `null` —— 这些都是**正常值**，
 * 不要用 `0` 顶替（「精度 0 米」与「没有精度」是两件事，同 `price_fen` 的口径）。
 *
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 功能：通知页面「状态变了」（页面自己决定重画哪一块）。
 * @returns {void}
 */
function emit() {
  if (typeof onChange === 'function') {
    try {
      onChange(recorderInfo());
    } catch {
      /* 页面的重画出错不该把记录搞停（记录比画面重要） */
    }
  }
}

/**
 * @returns {void}
 */
function holdLock() {
  try {
    const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : null;
    if (!wl || typeof wl.request !== 'function') return;
    wl.request('screen').then(
      (l) => {
        lock = l;
      },
      () => {
        lock = null;
      },
    );
  } catch {
    lock = null;
  }
}

/**
 * @returns {void}
 */
function releaseLock() {
  try {
    if (lock && typeof lock.release === 'function') lock.release();
  } catch {
    /* 释放失败不影响任何事 */
  }
  lock = null;
}

/**
 * 功能：把 `queue` 里的一批点发上去 —— ⚠️ **成功才出队**。
 *
 * 说明：⭐⭐ 失败时**什么都不动**：点留在队列里、`error` 写一句人话、页面挂出「有 N 个点还没传上去」。
 *
 * @returns {Promise.<void>}
 */
export async function recorderFlush() {
  if (!queue.length) return;
  const batch = queue.slice(0, BATCH_MAX);
  try {
    const r = await api('POST', '/api/trip/points', { trip_id: tripId, points: batch });
    sent += Number(r && r.saved) || batch.length;
    queue = queue.slice(batch.length);
    if (!queue.length) error = '';
  } catch (e) {
    error = e && e.message ? e.message : '这批点没传上去';
  }
  emit();
}

/**
 * 功能：采到一个点。
 * @param {Object} pos - `GeolocationPosition`
 * @returns {void}
 */
function onPos(pos) {
  const c = (pos && pos.coords) || {};
  queue.push({
    kind: 'track',
    // 用设备给的测量时刻；`timestamp` 缺失时才退回本地现在
    at: Math.round(Number(pos && pos.timestamp) || Date.now()),
    lat: Number(c.latitude),
    lng: Number(c.longitude),
    accuracy: num(c.accuracy),
    altitude: num(c.altitude),
    speed: num(c.speed),
    heading: num(c.heading),
  });
  if (queue.length >= FLUSH_MAX) {
    recorderFlush();
    return;
  }
  emit();
}

/**
 * @param {Object} err - `GeolocationPositionError`
 * @returns {void}
 */
function onErr(err) {
  const code = Number(err && err.code);
  error =
    code === 1
      ? '定位被拒绝了 —— 检查一下浏览器给这个页面的定位权限'
      : code === 2
        ? '拿不到位置 —— 设备的定位服务可能没开'
        : code === 3
          ? '定位超时了 —— 换个开阔点的地方再试试'
          : '拿不到位置';
  emit();
}

/**
 * 功能：⭐ 开始记录轨迹。
 *
 * 说明：⚠️ 调用前**必须先弹过那句提示**（「页面切到后台或锁屏后，手机大概率会停止记录；
 *
 * @param {?(number|string)} id - 归属行程 id 或 null
 */
export function recorderStart(id) {
  if (recording) return;
  tripId = id === null || id === undefined || id === '' ? null : Number(id);
  queue = [];
  sent = 0;
  error = '';
  recording = true;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    error = '这个浏览器不给用定位 —— 记录不了轨迹';
    emit();
    return;
  }
  try {
    watchId = navigator.geolocation.watchPosition(onPos, onErr, GEO_OPTS);
  } catch {
    watchId = null;
    error = '定位启不来 —— 记录不了轨迹';
  }
  if (timer === null) {
    timer = setInterval(() => {
      recorderFlush();
    }, FLUSH_MS);
  }
  holdLock();
  emit();
}

/**
 * 功能：⭐ 结束记录 —— 把**最后一批**发完、释放唤醒锁。
 *
 * 说明：⚠️ 「最后一批」是最容易丢的（用户点「结束」就走人）⇒ 这里**必须** `await` 一次 flush。
 *
 * @returns {Promise.<void>}
 */
export async function recorderStop() {
  if (watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      navigator.geolocation.clearWatch(watchId);
    } catch {
      /* 已经失效了 */
    }
  }
  watchId = null;
  recording = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  releaseLock();
  await recorderFlush();
  emit();
}

/**
 * 功能：取当前状态快照（页面照着它画）。
 *
 * 说明：⚠️ `queued` 是「还没传上去的点数」—— **页面必须把它显示出来**（> 0 时挂一条 ＋ 一颗「重试」），
 *
 * @returns {{recording: boolean, tripId: ?number, sent: number, queued: number, error: string, pending: Array.<Object>}}
 */
export function recorderInfo() {
  return { recording, tripId, sent, queued: queue.length, error, pending: queue.slice() };
}

/**
 * 功能：注册「状态变了」的回调 —— ⚠️ **替换**（不是追加）：两端各自进屏时换掉自己那一份。
 * @param {?function(Object): void} fn - 回调（传 null 取消）
 * @returns {void}
 */
export function recorderOnChange(fn) {
  onChange = typeof fn === 'function' ? fn : null;
}

/**
 * 功能：⭐ 把「定位用不了」的原因翻成人话（**打卡弹层与记录提示共用**）。
 *
 * 页面不是 HTTPS（`isSecureContext` 为假）⇒ 这是部署方式的问题，用户改不了；
 * 浏览器 / 外层页面不给（`code === 1` 权限被拒）⇒ 这是权限问题，改权限就行；
 * 设备定位没开 / 信号差 ⇒ 换个地方、开一下定位就好。
 */
export function geoFailText(err) {
  // **先判环境、再判 `err.code`**：非安全上下文（http 打开的局域网地址）下浏览器压根不给定位，
  // 而它是**以 `code === 1`（权限被拒）的姿态**报回来的 ⇒ 先判 code 就会把
  // 「页面不是 HTTPS」这个**真正的原因**说成「权限被拒」，把人指错方向去翻权限。
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return '这个页面不是 HTTPS（也不是 localhost），浏览器不给定位 —— 可以手动填经纬度';
  }
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return '这个浏览器（或它所在的外层页面）不给用定位 —— 可以手动填经纬度';
  }
  const code = Number(err && err.code);
  if (code === 1) {
    return '定位权限被拒绝了（如果这个页面是嵌在别的应用里打开的，也可能是外层页面没放行）—— 可以手动填经纬度';
  }
  if (code === 2) return '拿不到位置 —— 设备的定位服务可能没开，或者信号不好。可以手动填经纬度';
  if (code === 3) return '定位超时了 —— 换个开阔点的地方再试试，也可以手动填经纬度';
  return '拿不到位置 —— 可以手动填经纬度';
}

/**
 * 功能：⭐ **取一次当前位置**（打卡用；⛔ 不是 `watch`）。
 *
 * 它**必须由真实点击触发**（调研 `11` §2：某些实现要求用户手势才给定位）——
 * **不主动取坐标**）。
 *
 */
export function locateOnce() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error(geoFailText()));
      return;
    }
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const c = (pos && pos.coords) || {};
          resolve({
            lat: Number(c.latitude),
            lng: Number(c.longitude),
            accuracy: num(c.accuracy),
            at: Math.round(Number(pos && pos.timestamp) || Date.now()),
          });
        },
        (err) => reject(new Error(geoFailText(err))),
        GEO_OPTS,
      );
    } catch {
      reject(new Error(geoFailText()));
    }
  });
}

// 页面要走了 ⇒ 立刻释放屏幕常亮（⛔ 不在这里 flush：`pagehide` 时网络可能已经断了，
// 点留在队列里、下次进来点「重试」补上 —— 那是「离线可用」的既有设计）
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', releaseLock);
}
