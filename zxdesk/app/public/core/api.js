/**
 * core/api.js —— REST 调用与会话失效处理（两端唯一一份）
 *
 * 功能：两端共用的 REST 访问层。`setNotifier()` 注册本端提示函数；`api()` 统一发请求、
 * 解析响应体、按状态码抛出带 `status` 的错误；`backToLogin()` 在会话失效时提示并跳回登录页。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、docs/公共/开发方案/07-统一网关入口.md
 */
import {
  cacheGet,
  cachePut,
  guardWrite,
  markNetworkFailure,
  markNetworkSuccess,
} from './cache.js';

let notify = () => {}; // 由各端入口注入本地 toast

/**
 * 一次请求的**时间上界**（毫秒）：到点就 `abort()`，由 `api()` 当成一次失败抛出去。
 * 说明：15 秒对局域网里的 `node:sqlite` 查询绰绰有余（本机 RTT≈0.1ms，见架构文档 08），
 */
export const API_TIMEOUT_MS = 15000;

/**
 * 应用挂载前缀（无前缀时为空串）。取值 = 本模块所在目录的上一级：
 * `/core/api.js` → `''`；`/app/zxdesk/core/api.js` → `/app/zxdesk`。
 */
export const BASE = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * 功能：注册本端的提示函数，供 `api()` 与 `backToLogin()` 在出错时调用。
 * 说明：`toast` 刻意不合并 —— 两端各是一套 DOM（电脑版带「撤销」按钮、手机版是纯文本），
 * 所以这里只留 `setNotifier` 这一个钩子，由各端入口把自己的实现注入进来。
 * @param {Function} fn - 接收 `(msg, isErr)` 的提示函数
 * @returns {void}
 */
export function setNotifier(fn) {
  notify = fn;
}

/**
 * 功能：把地址上的查询串带走（去掉我们自己的 `view`）—— 整页跳转时用。
 *
 * 飞牛统一网关会在入口地址上带它自己的票据 / 标记（**走 FN Connect 中继时尤其明显**）。
 * 我们任何一次**整页跳转**如果把 `location.search` 丢掉，网关就认为这一趟没带凭证，
 * **又弹出访问码页** —— 用户看到的就是「输入对了还回到输入界面」。
 */
export function carrySearch() {
  const s = String(location.search || '');
  if (!s) return '';
  try {
    const usp = new URLSearchParams(s);
    usp.delete('view');
    const out = usp.toString();
    return out ? '?' + out : '';
  } catch (_e) {
    return s; // 解析失败时原样带过去 —— 宁可多带，不可丢票据
  }
}

let redirectingToLogin = false;
/**
 * 功能：会话失效时统一回登录页 —— 先弹一句提示，再延迟跳转 `/login.html`。
 * 模块级 `redirectingToLogin` 做去重，避免并发请求同时 401 时重复提示、重复跳转。
 * @returns {void}
 */
export function backToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  notify('登录已过期，请重新登录', true);
  setTimeout(() => {
    location.replace(BASE + '/login.html' + carrySearch());
  }, 700);
}

/**
 * 功能：发一次 REST 请求：带上 JSON 请求体、解析响应，并按 HTTP 状态码抛出错误。
 * 看起来像卡住了；响应体不是 JSON 时 `j` 为 null，按状态码兜底。
 * 起**自带超时**：`AbortController` 到点掐断，并当成一次失败抛出 ——
 * `path` 仍以 `/` 开头书写（如 `/api/tasks`），**前缀由本函数统一补** —— 调用方不用知道挂载点。
 * @param {string} method - HTTP 方法，如 'GET' / 'POST' / 'PUT' / 'DELETE'
 */
export async function api(method, path, body, opts) {
  const o = opts || {};
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const ctrl = new AbortController();
  const ms = o.timeout === undefined ? API_TIMEOUT_MS : o.timeout;
  const timer = ms > 0 ? setTimeout(() => ctrl.abort(), ms) : null;
  opt.signal = ctrl.signal;
  // 离线时的写请求直接拦：等到 15 秒超时才报错，用户会以为「点了没反应」
  guardWrite(method);

  let r;
  try {
    r = await fetch(BASE + path, opt);
  } catch (e) {
    markNetworkFailure();
    // 只认自己设的那个 abort：用户主动取消（别的调用方传的 signal）不该被说成超时
    const timedOut = !!(e && e.name === 'AbortError' && timer);
    // GET 一律先试缓存回放（断网、超时、连接被拒都能出内容）；写请求绝不回放
    const back = replay(method, path);
    if (back !== null) return back;
    if (timedOut) {
      const et = new Error('请求超时了，请刷新重试');
      et.status = 0;
      throw et;
    }
    if (String(method).toUpperCase() !== 'GET') {
      const err = new Error('网络不通，这次修改没有保存');
      err.status = 0;
      err.offline = true;
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  // 能拿到响应头就说明网络是通的（哪怕业务上是 4xx/5xx）
  markNetworkSuccess();
  const j = await r.json().catch(() => null);
  if (r.status === 401) {
    backToLogin();
    const e401 = new Error('登录已过期，正在回到登录页…');
    e401.status = 401;
    throw e401;
  }
  if (!r.ok) {
    const err = new Error((j && j.error) || 'HTTP ' + r.status);
    err.status = r.status;
    throw err;
  }
  // 写穿：只有成功的 GET 才更新快照，且整条覆盖（不存在「缓存比服务器新」的窗口）
  if (String(method).toUpperCase() === 'GET' && j !== null) cachePut(path, j);
  return j;
}

/** 上次「用的是缓存」的提示时间：60 秒内只提示一次，别让每个请求都弹一条。 */
let replayNoticeAt = 0;

/**
 *
 * 说明：只服务 GET。命中时**顺带提示一次** —— 不提示的话用户会以为看到的是实时数据，
 */
function replay(method, path) {
  if (String(method).toUpperCase() !== 'GET') return null;
  const hit = cacheGet(path);
  if (!hit) return null;
  const now = Date.now();
  if (now - replayNoticeAt > 60000) {
    replayNoticeAt = now;
    notify('网络不通，显示的是上次缓存的内容（只读）', true);
  }
  return hit.data;
}
