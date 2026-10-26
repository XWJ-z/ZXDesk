/**
 * core/api.js —— REST 调用与会话失效处理（两端唯一一份）
 *
 * 功能：两端共用的 REST 访问层。`setNotifier()` 注册本端提示函数；`api()` 统一发请求、
 *      解析响应体、按状态码抛出带 `status` 的错误；`backToLogin()` 在会话失效时提示并跳回登录页。
 *
 * ⭐ 0.5.2：`api()` 自带**超时**（`AbortController`）—— 手机端
 *    「一直在【正在读取】状态，无法使用（几率不小）」就是它：请求发出去**既没成功也没失败**
 *    （弱网 / 网关挂起 / 服务端单线程被长任务堵住），`await` 就永远悬在那儿，
 *    界面停在初始骨架那一句「正在读取…」，而且**没有任何一条错误路径会被走到**。
 *    所以请求必须有上界：超时一律当成失败抛出去，让上层的错误块 / 重试按钮接住。
 *    ⚠️ 超时**不能**静默重试：一次「新建」重试成两次写，代价远大于让用户点一下。
 *
 * ⚠️ 唯一需要「注入」的地方是 `toast`：两端的提示是**两套 DOM**（电脑版有「撤销」按钮、
 *    手机版是纯文本），合并就等于把手机端改成电脑端。所以这里只留一个通知钩子，
 *    各端在自己的入口把本地的 `toast` 注册进来（见 `desktop/app.js` / `mobile/app.js` 的 `setNotifier`）。
 *
 * ⚠️ 401 一律回登录页：会话可能因为「改过密码 / 管理员重置了密码 / 账号被删 / Cookie 到期」
 *    在任何一次请求上失效。不处理的话界面只会弹一句「初始化失败：unauthorized」，
 *    看起来像**卡住了** —— 而用户唯一的出路（重新登录）恰恰是他看不到的那个页面。
 *
 * ⭐ **`BASE`：本应用被挂在哪个路径下**（0.3.5 统一网关改造）——
 *    飞牛统一网关把应用挂在系统域名的 `/app/zxdesk` 下，且**不会替我们剥掉这层前缀**
 *    （见 `core/gateway.js` 文件头）。所以前端发请求必须带上它。
 *
 *    ⚠️ **为什么不直接用相对路径**：手机版页面挂在 `/mobile/` 下，相对路径 `api/x` 会算成
 *      `/mobile/api/x`（404）—— 相对路径只在「目录深度恰好等于应用根」时才对。
 *    ⚠️ **为什么不写死 `/app/zxdesk`**：`BASE` 从**模块自身 URL** 反推
 *      （`/core/api.js` → `''`；`/app/zxdesk/core/api.js` → `/app/zxdesk`），
 *      换个挂载点（或以后 Windows 版换个路径）不用改一行代码。
 *    ⭐ **两端所有接口地址都必须走这里导出的 `BASE`**（`modules/teamwork/teamwork-stream.js` 的 EventSource、
 *      几处裸 `fetch('/api/…')`、`window.location.href = '/api/export'` 同理），
 *      否则网关下那条路会 404 而其余照常 —— 最难查的一类「只有某一处不对」。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.34
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、docs/公共/开发方案/07-统一网关入口.md
 */
let notify = () => {}; // 由各端入口注入本地 toast

/**
 * ⭐ 一次请求的**时间上界**（毫秒）：到点就 `abort()`，由 `api()` 当成一次失败抛出去。
 * 说明：15 秒对局域网里的 `node:sqlite` 查询绰绰有余（本机 RTT≈0.1ms，见架构文档 08），
 *      它的作用**不是**掐掉慢查询，而是把「永远悬着」变成「报错 → 能重试」。
 *      ⚠️ 需要更久的接口（导出 / 导入大文件）用 `opts.timeout` 单独放宽，**不要**调大这个默认值 ——
 *      默认值一松，「卡在读取中」那一屏就又回来了。
 */
export const API_TIMEOUT_MS = 15000;

/**
 * 应用挂载前缀（无前缀时为空串）。取值 = 本模块所在目录的上一级：
 * `/core/api.js` → `''`；`/app/zxdesk/core/api.js` → `/app/zxdesk`。
 *
 * ⚠️ 用 `import.meta.url` 而不是 `location.pathname`：前者是**模块**的位置（稳定），
 *    后者是**页面**的位置（`/mobile/` 下的页面会算错一层）。
 */
export const BASE = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * 功能：注册本端的提示函数，供 `api()` 与 `backToLogin()` 在出错时调用。
 * 说明：`toast` 刻意不合并 —— 两端各是一套 DOM（电脑版带「撤销」按钮、手机版是纯文本），
 *      所以这里只留 `setNotifier` 这一个钩子，由各端入口把自己的实现注入进来。
 * @param {Function} fn - 接收 `(msg, isErr)` 的提示函数
 * @returns {void}
 */
export function setNotifier(fn) {
  notify = fn;
}

/**
 * 功能：把地址上的查询串带走（去掉我们自己的 `view`）—— 整页跳转时用。
 *
 * 说明：⭐⭐ 2026-10-19（「手机端访问要输入访问码…只有中转模式下会这样，输对了也进不去」）：
 *      飞牛统一网关会在入口地址上带它自己的票据 / 标记（**走 FN Connect 中继时尤其明显**）。
 *      我们任何一次**整页跳转**如果把 `location.search` 丢掉，网关就认为这一趟没带凭证，
 *      **又弹出访问码页** —— 用户看到的就是「输入对了还回到输入界面」。
 *      ⇒ 本文件里那一处（`backToLogin()` 回登录页）与会话跳转都要带上它。
 *      ⚠️ 同一套规则还写在 `login.js` 与两个 `index.html` 里（它们拿不到本模块，必须是经典脚本），
 *      ⛔ 改一致点必须四处一起改；`ttt/test/gateway.test.js` 有一条静态断言钉着「四处的写法一致」。
 *
 * @returns {string} 要拼在地址后面的查询串（含 `?`）；没有时为空串
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
 * 说明：401 一律回登录页（否则用户唯一的出路恰恰是他看不到的那个页面）；
 *      模块级 `redirectingToLogin` 做去重，避免并发请求同时 401 时重复提示、重复跳转。
 *      ⚠️ 跳转要**带上地址上的查询串**（`carrySearch()`）—— 否则网关会把访问码页再弹一次。
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
 * 说明：401 交给 `backToLogin()` 处理（回登录页），否则界面只会弹一句「初始化失败」，
 *      看起来像卡住了；响应体不是 JSON 时 `j` 为 null，按状态码兜底。
 *      ⭐ 0.5.2 起**自带超时**：`AbortController` 到点掐断，并当成一次失败抛出 ——
 *      没有它，「请求既没成功也没失败」会让 `await` 永远悬着，界面停在「正在读取…」那一屏。
 *      ⚠️ `path` 仍以 `/` 开头书写（如 `/api/tasks`），**前缀由本函数统一补** —— 调用方不用知道挂载点。
 * @param {string} method - HTTP 方法，如 'GET' / 'POST' / 'PUT' / 'DELETE'
 * @param {string} path - 请求路径（应用内绝对路径），如 '/api/tasks'
 * @param {*} [body] - 可选请求体；传入时才设置 Content-Type 并序列化成 JSON
 * @param {{timeout?: number}} [opts] - 可选；`opts.timeout` 覆盖默认超时（毫秒），`0` 表示不设上界
 * @returns {Promise.<?Object>} 解析后的响应 JSON；响应体不是 JSON 时为 null
 * @throws {Error} 会话失效（401）、超时或响应非 2xx 时抛出，错误对象上带 `status`
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
  let r;
  try {
    r = await fetch(BASE + path, opt);
  } catch (e) {
    // ⚠️ 只认自己设的那个 abort：用户主动取消（别的调用方传的 signal）不该被说成超时
    if (e && e.name === 'AbortError' && timer) {
      const et = new Error('请求超时了，请刷新重试');
      et.status = 0;
      throw et;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  return j;
}
