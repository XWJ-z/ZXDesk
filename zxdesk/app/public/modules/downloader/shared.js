/**
 * modules/downloader/shared.js —— **视频下载器**两端共用的一份（接口封装 ＋ 文案 ＋ 轮询节拍）
 *
 * 功能：把七条接口、状态文案、任务卡片的拼装规则、配置弹窗的文案与轮询的开关收在一个文件里，
 * 两端的视图片段只管画。
 *
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md
 */

import { api } from '../../core/api.js';

/** 快手作品下载器在飞牛里的页面地址（「去选保存目录」「打开下载器」都用它） */
export const OPEN_URL = '/app/ksdownloader/';

/** 两端逐字一致的几句文案（同一个功能不许说两种话） */
export const TEXT = {
  NOTE: '下载在快手作品下载器里进行，这里只显示进度与结果。',
  OPEN: '打开快手作品下载器',
  EMPTY_TASKS: '还没有任务。上面贴一个链接、点「解析并下载」，进度会出现在这里。',
  NO_LINK: '请先把快手作品的链接贴进来',
  SHARED_TIP: '同一台飞牛上的多个账号共用一份任务列表与保存目录（下载器按飞牛账号区分，不按这里的账号）。',
};

/**
 *
 * 说明：⭐⭐ 地址与令牌从正文里收进弹窗之后，这一屏平时只剩「贴链接 → 下载」两件事；
 */
export const CONFIG_TEXT = {
  TITLE: '快手作品下载器 · 配置',
  CONN: '连接',
  URL: '地址',
  URL_PH: 'http://127.0.0.1:5599',
  TOKEN: '令牌',
  TOKEN_PH: 'ksd_…（留空表示不改）',
  TOKEN_SAVED: '已保存（留空表示不改）',
  SAVE: '保存并测试',
  CLOSE: '关闭',
  KSD: '下载器自身的设置',
  KSD_LOCKED: '先在上面填好地址与令牌、点一次「保存并测试」；连上之后这里会显示下载器的能力与限流。',
  KSD_NOTE: 'Cookie、保存目录、API 令牌都在它自己的页面里改；改完回来点一次「保存并测试」刷新。',
  KSD_OPEN: '打开快手作品下载器',
  K_VER: '接口版本',
  K_WHO: '令牌归属',
  K_VER_UNKNOWN: '未知',
  K_WHO_UNKNOWN: '未核对',
  K_CAN: '能做什么',
  K_RATE: '限流',
  K_RATE_NONE: '下载器没有说明',
  K_SCOPE: '令牌权限',
  K_SCOPE_NONE: '没读到（换一把令牌再看）',
  K_CFG_HINT: '要改保存目录与 Cookie，得在它页面生成令牌时勾上「配置写入」—— 这一屏只读。',
};

/** 三档权限的中文说法（与 KSD 的 `read` / `task` / `config` 一一对应） */
const SCOPE_TEXT = {
  read: '读取',
  task: '任务操作',
  config: '配置写入',
};

/**
 * 功能：把下载器的 `capabilities` 翻成两句人话（⛔ 不认识的能力不外传）。
 * @param {?Object} caps - `/api/v1/version` 回的 `capabilities`
 * @returns {{can: string, rate: string}} 「能做什么」与「限流」两行
 */
export function capsText(caps) {
  const c = caps || {};
  const can = [];
  if (c.parse === true) can.push('解析作品');
  if (c.task === true) can.push('建下载任务');
  if (c.progress === true) can.push('看进度');
  if (c.cancel === true) can.push('取消任务');
  const rate = [];
  if (Number(c.createTaskPerMinute) > 0) rate.push(`每分钟最多 ${Number(c.createTaskPerMinute)} 条`);
  if (Number(c.maxActiveTasks) > 0) rate.push(`同时最多 ${Number(c.maxActiveTasks)} 条进行中`);
  return { can: can.join('、'), rate: rate.join('，') };
}

/**
 * 功能：把「这把令牌有哪几档权限」翻成一行中文。
 *
 * 说明：⭐ 三档累积（`config` ⊃ `task` ⊃ `read`），服务端已按白名单过滤过；
 * 这里不再自己判断「有 config 就等于有 task」—— 上游改口径时两处判据必然会分家。
 * @param {Array.<string>} scopes - `status.scopes`（`['read','task']` 这种）
 */
export function scopesText(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const words = list.map((s) => SCOPE_TEXT[String(s)]).filter(Boolean);
  return words.length ? words.join('、') : CONFIG_TEXT.K_SCOPE_NONE;
}

/** 任务状态 → 中文（KSD 只有这四个状态；⛔ 不自造第五个） */
const STATUS_TEXT = {
  queued: '排队中',
  running: '下载中',
  done: '已完成',
  failed: '失败',
};

/**
 * 功能：任务状态的中文说法。
 * @param {*} status - KSD 回的状态
 * @returns {string} 中文；不认识的值原样回（宁可露出原文，也不假装它完成了）
 */
export function statusLabel(status) {
  const s = String(status == null ? '' : status);
  return STATUS_TEXT[s] || s || '未知';
}

/**
 * 功能：任务是否还在跑（决定要不要继续轮询）。
 * @param {*} status - KSD 回的状态
 * @returns {boolean} 排队中或下载中则为 true
 */
export function isActive(status) {
  const s = String(status == null ? '' : status);
  return s === 'queued' || s === 'running';
}

/**
 * 功能：一组任务里还有没有进行中的。
 * @param {Array.<Object>} tasks - 任务数组
 * @returns {boolean} 有则为 true
 */
export function hasActive(tasks) {
  return (tasks || []).some((t) => isActive(t && t.status));
}

/**
 * 功能：把 `files[]` 收成一句概要（作品卡片上用）。
 * @param {Array.<Object>} files - KSD 回的 `{name, size, type}`
 * @returns {string} 形如「2 个文件 · mp4 / jpg」；没有文件时为空串
 */
export function filesSummary(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const kinds = [...new Set(list.map((f) => String((f && f.type) || '')).filter(Boolean))];
  return `${list.length} 个文件${kinds.length ? ` · ${kinds.join(' / ')}` : ''}`;
}

/**
 * 功能：把服务端的时间戳写成「11-15 18:41」这种短样子。
 * @returns {string} 短时间；取不到时为空串
 */
export function shortTime(v) {
  const s = String(v == null ? '' : v);
  if (s.length < 16) return s;
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

/**
 * 功能：取连接状态。
 *
 * 说明：⭐ `scopes` / `tokenCapabilities` 是**这把令牌**能做什么（`/api/v1/me`），
 * `capabilities` 是下载器本身支持什么（`/api/v1/version`）—— 两份不是一回事，别混用。
 * `discoveredFrom` 非空表示端口变过、这次自动跟上来了（值是原来手填的那个地址）。
 */
export function fetchStatus() {
  return api('GET', '/api/downloader/status');
}

/**
 * 功能：取连接设置（⛔ 不含令牌明文，只有 `hasToken`）。
 * @returns {Promise.<Object>} `{serviceUrl, hasToken, ksdUid, updatedAt}`
 */
export function fetchSettings() {
  return api('GET', '/api/downloader/settings');
}

/**
 * 功能：保存连接设置（空串 ＝ 不改）。
 * @param {{serviceUrl?: string, token?: string}} body - 要保存的字段
 * @returns {Promise.<Object>} 保存后的设置（带回 `verified`：这次有没有核对过令牌归属）
 */
export function saveSettings(body) {
  return api('PUT', '/api/downloader/settings', body);
}

/**
 * 功能：解析一个作品（只解析，不下载）。
 * @param {string} url - 作品链接或含链接的分享文案
 * @returns {Promise.<Object>} `{work:{id,title,author,type,files}}`
 */
export function parseWork(url) {
  // 放宽到 45 秒：服务端给 KSD 的上限是 30 秒，中间还有本进程排队与网络往返，
  // 前端用默认 15 秒会先放弃，让用户看到「请求超时」而不是真正的原因。
  return api('POST', '/api/downloader/parse', { url }, { timeout: 45000 });
}

/**
 * 功能：建一条下载任务（真正下载的是 KSD）。
 * @param {string} url - 作品链接
 * @returns {Promise.<Object>} `{taskId, status, reused}`
 */
export function createTask(url) {
  return api('POST', '/api/downloader/tasks', { url });
}

/**
 * 功能：取任务列表。
 * @param {Object} [params] - 查询参数（`scope` / `page` / `size` 原样交给 KSD）
 * @returns {Promise.<Object>} `{tasks, historyTotal?, ephemeral?, scope?}`
 */
export function fetchTasks(params) {
  const p = params || {};
  const qs = Object.keys(p)
    .filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join('&');
  return api('GET', '/api/downloader/tasks' + (qs ? `?${qs}` : ''));
}

/** 轮询定时器（一个页面只应有一个） @type {?number} */
let timer = null;

/** 每一拍要做的事（`syncPolling()` 每次调用都会更新它） @type {?Function} */
let tickHook = null;

/** 轮询的节奏（毫秒）—— KSD 的 `phase` 更新就是这个量级，更快只是白耗请求 @type {number} */
const TICK_MS = 2000;

/**
 * 功能：跑一拍 —— 只在页面看得见时真的发请求。
 *
 * 说明：⚠️ 失败**不弹提示**：轮询不是用户点的，弹一串错误只会打扰他。
 * 真正的失败会在用户下一次手动操作、或切回前台那一拍露出来。
 * @returns {void}
 */
function tick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!tickHook) return;
  Promise.resolve()
    .then(tickHook)
    .catch(() => {});
}

/**
 * 功能：按「看得见 ＋ 有进行中的任务」决定开还是关轮询。
 *
 * 说明：⭐ 判据集中在这里：两端各写一份定时器时，总有一端忘了在任务结束后停掉，
 * 于是「任务早就下完了，页面还在每 2 秒问一次」—— 在 NAS 上跑一整天也没人发现。
 * 页面切回前台时 `visibilitychange` 会补一拍，用户看不到「停在旧状态」。
 */
export function syncPolling(need, onTick) {
  if (typeof onTick === 'function') tickHook = onTick;
  if (!need) {
    stopPolling();
    return;
  }
  if (timer !== null) return;
  timer = setInterval(tick, TICK_MS);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', tick);
}

/**
 * 功能：停掉轮询（离开这一屏、任务全结束、片段被替换时都要调）。
 * @returns {void}
 */
export function stopPolling() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', tick);
}
