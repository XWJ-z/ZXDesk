/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：core/host-pick.js
 * 职责：飞牛宿主选择器（选目录 / 选文件）—— 两端与各模块共用的唯一一份
 *
 * 功能：`pickUserFile()` 打开宿主内嵌选择器并返回选中的路径；`pickAuthorizedDir()` 是「选目录」的包装；
 *      `primePicker()` 预热 SDK；`probePicker()` 打一行诊断；`buildAuthPageUrl()` 拼系统授权页地址。
 *
 * ⭐ 为什么单独一个文件：选择器不是「加密信息」的私产 —— 数据位置（设置 →「修改位置」）、
 *      恢复引导页、以后的任何「要目录」的功能都要用它。原来它住在 `modules/secrets/shared.js` 里，
 *      一旦那个模块被删（模块化验收要求每个模块都能单独删掉），别处就用不了了。
 *      搬家**只动位置不动逻辑**：握手、单例、有界等待、诊断快照逐字照搬。
 *
 * ⚠️ 只在宿主环境（飞牛桌面 / App 内嵌页）里能用：选完系统才完成授权。
 *      独立浏览器 / 局域网直连时走「系统授权页」或手工填路径这两条兜底（由调用方决定）。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */
import { BASE } from './api.js';

/** SDK 实例的**唯一** Promise：模块级只建一次，失败也记住 */
let sdkPromise = null;

/**
 * 先让用户看到的「慢」提示与硬上限（毫秒）。
 *
 * 说明：⭐⭐ 为什么要有这两个数：SDK 的握手**没有给调用方任何进度**，
 *      连不上时它的 `initPromise` 可能永远不结算（`vendor` 里那条兜底连接没有超时）。
 *      原实现直接 `await` 它 ⇒ 按钮永远停在「正在打开选择器…」，连 `catch` 都进不去。
 *      ⇒ 3 秒换个说法让用户知道还在连；10 秒就认定「宿主不应答」，把两条兜底路交出去。
 */
const READY_SLOW_MS = 3000;
const READY_HARD_MS = 10000;

/**
 * 选择器的诊断快照（`PICKER_PROBE` 用）。
 *
 * 说明：⚠️ 只记环境与耗时：**⛔ 不含路径、不含 token、不落库、不进日志文件**。
 *      验收时截一张控制台图，就能知道卡在哪一跳。
 * @type {{at: number, readyMs: ?number, route: string, isWeb: ?boolean, isStandaloneWeb: ?boolean, parentSame: ?boolean}}
 */
const pickerProbe = { at: 0, readyMs: null, route: '', isWeb: null, isStandaloneWeb: null, parentSame: null };

/**
 * 功能：装飞牛前端 SDK（`@trimjs/web-app` 的浏览器产物）—— **同一个页面只建一次实例**。
 *
 * 说明：⭐⭐ 这个包**入库在 `public/vendor/trimjs-web-app/`**（官方 0.5.0 的原样产物，
 *      固定版本、不走构建链；来源与许可情况见该目录的 `NOTICE.md`）。
 *      ⭐⭐ 必须是**单例**：每点一次「换一个目录」都 `new TrimApp()` 一次的话，
 *      而 SDK 的连接是模块级缓存的（`var xe = e => Ce || (Ce = …)`）—— 一旦第一次落到
 *      那条「没有超时的兜底连接」且它不结算，`Ce` 就把这个 pending Promise 缓存住，
 *      之后每次点击都秒进「正在打开选择器…」然后**永远等**（界面上的表现就是这个）。
 *      单例至少保证：这一页里**不会反复制造新的握手**，也就不会越点越糟。
 *      ⚠️ 失败（独立浏览器 / 目录被移除）也记住 `null` —— 同一页面里不必反复试。
 * @returns {Promise.<?Object>} SDK 实例；不可用时为 null
 */
export function loadTrimSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    try {
      const mod = await import(`${BASE}/vendor/trimjs-web-app/index.js`);
      const Ctor = mod.TrimApp || (mod.default && mod.default.TrimApp);
      if (typeof Ctor !== 'function') return null;
      const sdk = new Ctor();
      pickerProbe.isWeb = sdk.isWeb === true;
      pickerProbe.isStandaloneWeb = sdk.isStandaloneWeb === true;
      pickerProbe.parentSame = typeof window !== 'undefined' && window.parent === window;
      // 独立浏览器里没有内嵌选择器（要走授权页），本函数只负责「宿主内」这一条
      if (sdk.isStandaloneWeb) return null;
      return sdk;
    } catch (_e) {
      return null;
    }
  })();
  return sdkPromise;
}

/**
 * 功能：给一个可能永不结算的 Promise 加「慢提示 ＋ 硬上限」。
 *
 * 说明：⚠️ 到硬上限**只是我们不再等**，底层那个 Promise 仍然挂着（SDK 没有取消能力）——
 *      所以调用方必须在 `finally` 里复原按钮，⛔ 不能把「按钮永久置灰」交给竞态结果。
 * @param {Promise} p - 被等的 Promise
 * @param {number} slowMs - 多少毫秒后调一次 `onSlow`
 * @param {number} hardMs - 多少毫秒后放弃
 * @param {Function} [onSlow] - 慢提示回调
 * @returns {Promise.<{ok: boolean, value?: *, error?: *, timeout?: boolean}>} 结果信封
 */
function waitWithHint(p, slowMs, hardMs, onSlow) {
  return new Promise((resolve) => {
    let done = false;
    const slow = setTimeout(() => {
      if (!done && typeof onSlow === 'function') onSlow();
    }, slowMs);
    const hard = setTimeout(() => {
      if (done) return;
      done = true;
      clearTimeout(slow);
      resolve({ ok: false, timeout: true });
    }, hardMs);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(slow);
        clearTimeout(hard);
        resolve({ ok: true, value: v });
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(slow);
        clearTimeout(hard);
        resolve({ ok: false, error: e });
      },
    );
  });
}

/**
 * 功能：在后台预热 SDK（面板一打开就调，**不阻塞、失败静默**）。
 *
 * 说明：⭐⭐ 预热的意义：用户点「换一个目录」时握手早就完成了，
 *      选择器**秒开**，不再落在「1.5 秒 / 6.5 秒」那个窗口里。
 *      ⚠️ 但预热**必须有闸门**（方案原来写的是无条件 await ready）：
 *      连接一旦落到那条不结算的兜底路径，`Ce` 会把它缓存住 —— 无条件预热等于把
 *      「点击才卡」提前成「打开面板就卡」。所以这里到点就放弃，只把结论记进诊断。
 *      ⚠️ 失败不上界面（用户没点任何东西，弹错是骚扰）。
 * @returns {void}
 */
export function primePicker() {
  if (pickerProbe.at) return;
  pickerProbe.at = Date.now();
  const t0 = pickerProbe.at;
  waitWithHint(
    (async () => {
      const sdk = await loadTrimSdk();
      if (!sdk) return null;
      await sdk.ready();
      return sdk;
    })(),
    READY_SLOW_MS,
    READY_HARD_MS,
    null,
  ).then((r) => {
    pickerProbe.readyMs = r.ok ? Date.now() - t0 : null;
  });
}

/**
 * 功能：调一次飞牛内嵌选择器（**选目录与选文件是同一条路**，只差 `directory`）。
 *
 * 说明：⭐⭐ 这条路必须在宿主环境里（飞牛桌面 / App 内嵌页）：选完系统自动完成授权。
 *      ⭐ 这里的等待必须是**有界**的：
 *      · `isStandaloneWeb` ⇒ 立刻 `standalone`（⛔ 不再去 await 一个注定失败的握手）；
 *      · 等 `ready()` 时 3 秒换文案、10 秒判 `no-host`（把兜底路交出去）；
 *      · 连上之后的 `pickUserFile()` **不加短超时**（用户会翻很久目录），
 *        但调用方必须在 `finally` 里复原按钮。
 *      ⭐ 2026-11-09：阅读器也要用它选**文件**，所以抽成一条内部路；两个导出的包装各管一种。
 * @param {{directory: boolean, title: string, okText: string, accept?: Array.<string>, onSlow?: ?Function}} opts - 选择参数
 * @returns {Promise.<{ok: boolean, path?: string, reason?: string, message?: string}>} 结果
 *      `reason`：`standalone`（独立浏览器）、`no-sdk`（没装 SDK）、`no-host`（宿主不应答）、
 *      `cancel`（用户取消）、`error`
 */
async function pickViaSdk(opts) {
  const o = opts || {};
  const onSlow = typeof o.onSlow === 'function' ? o.onSlow : null;
  const sdk = await loadTrimSdk();
  if (!sdk) {
    pickerProbe.route = pickerProbe.isStandaloneWeb ? 'standalone' : 'no-sdk';
    return { ok: false, reason: pickerProbe.isStandaloneWeb ? 'standalone' : 'no-sdk' };
  }
  // ---- 等握手：3 秒提示、10 秒放弃（SDK 自己不给我们进度）----
  const ready = await waitWithHint(sdk.ready(), READY_SLOW_MS, READY_HARD_MS, onSlow);
  if (!ready.ok) {
    pickerProbe.route = 'no-host';
    return { ok: false, reason: 'no-host', message: ready.timeout ? 'timeout' : '' };
  }
  try {
    /** @type {Object} 选择器参数（`directory: false` ＝ 选文件） */
    const ask = {
      directory: o.directory !== false,
      title: o.title || '选择目录',
      okText: o.okText || '用这个目录',
      sidebarGroup: ['myFiles', 'otherShare', 'external', 'favorites'],
    };
    // ⚠️ `accept` 只在选文件时有意义（SDK 原样透传给系统选择器）——
    //    阅读器因此能把列表先过滤成 `.zxdesk`，少点一次「选错了、打不开」
    if (ask.directory === false && Array.isArray(o.accept) && o.accept.length) ask.accept = o.accept;
    const r = await sdk.pickUserFile(ask);
    if (r && Number(r.code) === 0 && Array.isArray(r.data) && r.data.length) {
      pickerProbe.route = 'sdk';
      return { ok: true, path: String(r.data[0]) };
    }
    return { ok: false, reason: 'cancel', message: (r && r.msg) || '' };
  } catch (e) {
    return { ok: false, reason: 'error', message: (e && e.message) || '' };
  }
}

/**
 * 功能：请当前用户在飞牛里选一个**目录**并授权（内嵌选择器）。
 *
 * 说明：⭐ 收口在 `pickViaSdk()`，这里只定「选目录」那组参数。
 * @param {{onSlow?: Function, title?: string}} [opts] - `onSlow`：3 秒没连上时调用（换个按钮文案）；
 *      `title`：选择器标题（缺省「选择加密信息附件目录」；「重新关联」传 `RELINK_TITLE`）
 * @returns {Promise.<{ok: boolean, path?: string, reason?: string, message?: string}>} 结果（同 `pickViaSdk()`）
 */
export function pickAuthorizedDir(opts) {
  const o = opts || {};
  return pickViaSdk({
    directory: true,
    title: o.title || '选择加密信息附件目录',
    okText: '用这个目录',
    onSlow: o.onSlow,
  });
}

/**
 * 功能：调一次宿主选择器（选目录与选文件是同一条路，只差 `directory`）。
 * @param {{directory?: boolean, title?: string, okText?: string, accept?: Array.<string>, onSlow?: ?Function}} opts - 选择参数
 * @returns {Promise.<{ok: boolean, path?: string, reason?: string, message?: string}>} 结果
 *      `reason`：`standalone`（独立浏览器）、`no-sdk`（没装 SDK）、`no-host`（宿主不应答）、`cancel`、`error`
 */
export function pickUserFile(opts) {
  return pickViaSdk(opts);
}

/**
 * 功能：拼「系统授权页」的地址（不依赖宿主握手的官方路）。
 *
 * 说明：⚠️ 路径与参数逐字照抄 SDK 的 `buildAppAuthUrl()`：路径是 `/app-auth/pick-user-file`；
 *      参数 `appName` / `redirectUri` / `state` / `directory=true` / `sidebarGroup`（逗号连接）。
 *      ⚠️ base 用**宿主 origin**（`document.referrer`）：`/app-auth/*` 是飞牛桌面自己的路由，
 *      ⛔ 不是我们应用的 `BASE`。`redirectUri` 走统一网关回本应用，回调页与原页面同源才能 `postMessage`。
 * @param {string} state - 一次性校验串（回调页要带回）
 * @returns {string} 绝对地址
 */
export function buildAuthPageUrl(state) {
  let origin = location.origin;
  try {
    if (document.referrer) origin = new URL(document.referrer).origin;
  } catch (_e) {
    /* referrer 不可解析：用本页 origin（局域网直连时也只能这样） */
  }
  const u = new URL('/app-auth/pick-user-file', origin);
  u.searchParams.set('appName', 'ZXDesk');
  u.searchParams.set('redirectUri', '/app/zxdesk/auth-callback.html');
  u.searchParams.set('state', String(state || ''));
  u.searchParams.set('directory', 'true');
  u.searchParams.set('sidebarGroup', 'myFiles,otherShare,external,favorites');
  return u.toString();
}

/**
 * 功能：把这次选择器的诊断情况打一行到控制台（验收用）。
 *
 * 说明：⚠️ 只打环境与耗时；⛔ 不含路径、不含 token、不写库、不进日志文件。
 * @param {string} route - 最终走了哪条路（`sdk` / `standalone` / `no-sdk` / `no-host` / `auth-page` / `manual`）
 * @returns {void}
 */
export function probePicker(route) {
  pickerProbe.route = String(route || pickerProbe.route || '');
  try {
    console.info('PICKER_PROBE', {
      route: pickerProbe.route,
      readyMs: pickerProbe.readyMs,
      isWeb: pickerProbe.isWeb,
      isStandaloneWeb: pickerProbe.isStandaloneWeb,
      parentSame: pickerProbe.parentSame,
    });
  } catch (_e) {
    /* 控制台不可用就算了 */
  }
}
