/**
 * core/cache.js —— 离线缓存 ＋ 只读守卫（0.9.6）
 *
 * 功能：把 **GET 成功响应**按「方法＋路径」存进 `localStorage`，断网或请求失败时回放；
 *      设备无网络时拦住写请求（新建 / 修改 / 删除），并给两端各挂一条常驻横幅。
 *
 * 为什么收在 `api()` 这一层：手机版与电脑版的取数**全部**经 `core/api.js`，
 *   在那里加一层就能同时覆盖两端与所有模块；放到各视图里就是几十个调用点各写一遍，
 *   将来新加一屏很容易漏（漏掉的那一屏就是「断网时唯一白屏的地方」）。
 *
 * 为什么不用 Service Worker：入口常挂在飞牛网关的 `/app/zxdesk/` 下，自签证书走 TOFU ——
 *   SW 需要 secure context，注册可能直接失败；而且桌面版与 WebView 的行为要一致。
 *   本模块只用 `localStorage`，任何环境都能跑，失败就退化成「没有缓存」，不报错。
 *
 * ⚠️ 只缓存 GET 的**成功响应**：写请求的响应绝不能回放 —— 会让人以为写成功了。
 * ⚠️ 401 绝不回放：会话失效必须回登录页，拿旧数据顶着等于让人对着过期界面操作。
 * ⚠️ 缓存是**只读快照**，不是数据源：联网后第一次成功请求就整条覆盖（写穿），
 *   所以不存在「缓存比服务器新」的窗口。
 *
 * @author zx
 * @date   2026-10-29
 * @since 0.9.7
 */

/** 键前缀：带版本号，将来改结构直接改这里，旧缓存自然失效（不用写迁移）。 */
const PREFIX = 'zxdesk.cache.v1:';

/** 条数上限：超过就按「最久没被读过」淘汰。 */
const MAX_ENTRIES = 150;

/** 总字节上限：`localStorage` 一般 5 MB，留一半给别的键（偏好、会话标记）。 */
const MAX_BYTES = 2_500_000;

/** 单条上限：超过就不缓存（多半是导出类的巨型响应，缓存它会把配额一次吃光）。 */
const MAX_ENTRY_BYTES = 512_000;

/** 内存里的索引：`path -> { at, size }`，避免每次都遍历全部键。 */
let index = null;

/** 当前是否处于「离线」判断（设备无网络 **或** 最近一次请求是网络层失败）。 */
let offline = false;

/** 横幅与各处订阅者。 */
const listeners = new Set();

/**
 * 功能：安全地拿 `localStorage`（隐私模式 / 配额满 / 被策略禁掉时返回 null）。
 * @returns {?Storage} 可用时返回存储对象
 */
function store() {
  try {
    const s = window.localStorage;
    const probe = PREFIX + '__probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：把索引读进内存（首次调用时读一次；坏数据就当空）。
 * @returns {Object} `path -> { at, size }`
 */
function getIndex() {
  if (index) return index;
  index = {};
  const s = store();
  if (!s) return index;
  try {
    const raw = s.getItem(PREFIX + '__index');
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === 'object') index = obj;
  } catch (_e) {
    index = {};
  }
  return index;
}

/**
 * 功能：把索引写回存储（失败不管 —— 索引丢了只是淘汰顺序退化，缓存本身还在）。
 * @returns {void}
 */
function saveIndex() {
  const s = store();
  if (!s) return;
  try {
    s.setItem(PREFIX + '__index', JSON.stringify(getIndex()));
  } catch (_e) {
    /* 配额满：索引写不进去不影响读缓存 */
  }
}

/**
 * 功能：按「最久未读」淘汰，直到条数与字节都回到上限内。
 * @returns {void}
 */
function evict() {
  const s = store();
  if (!s) return;
  const idx = getIndex();
  const paths = Object.keys(idx);
  let total = paths.reduce((n, p) => n + (idx[p].size || 0), 0);
  if (paths.length <= MAX_ENTRIES && total <= MAX_BYTES) return;
  paths.sort((a, b) => (idx[a].at || 0) - (idx[b].at || 0));
  for (const p of paths) {
    if (Object.keys(idx).length <= MAX_ENTRIES && total <= MAX_BYTES) break;
    total -= idx[p].size || 0;
    delete idx[p];
    try {
      s.removeItem(PREFIX + p);
    } catch (_e) {
      /* 删不掉就算，下一轮再说 */
    }
  }
  saveIndex();
}

/**
 * 功能：读一条缓存。
 * @param {string} path - 与 `api()` 里同样的路径（含查询串）
 * @returns {?{data: *, at: number}} 命中时返回 `{data, at}`；没有或已损坏返回 null
 */
export function cacheGet(path) {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + path);
    if (!raw) return null;
    const hit = JSON.parse(raw);
    if (!hit || typeof hit !== 'object' || !('d' in hit)) return null;
    // 记一次「刚读过」，供淘汰排序用
    const idx = getIndex();
    idx[path] = { at: Date.now(), size: raw.length };
    saveIndex();
    return { data: hit.d, at: hit.t || 0 };
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：写一条缓存（写穿：成功响应来了就整条覆盖）。
 * @param {string} path - 与 `api()` 里同样的路径
 * @param {*} data - 响应 JSON（只读快照）
 * @returns {boolean} 是否写成功
 */
export function cachePut(path, data) {
  const s = store();
  if (!s) return false;
  let raw;
  try {
    raw = JSON.stringify({ t: Date.now(), d: data });
  } catch (_e) {
    return false; // 含循环引用之类，缓存不了就算了
  }
  if (raw.length > MAX_ENTRY_BYTES) return false;
  try {
    s.setItem(PREFIX + path, raw);
  } catch (_e) {
    // 配额满：先淘汰一批再试一次，仍失败就放弃（不影响本次请求）
    evict();
    try {
      s.setItem(PREFIX + path, raw);
    } catch (_e2) {
      return false;
    }
  }
  const idx = getIndex();
  idx[path] = { at: Date.now(), size: raw.length };
  saveIndex();
  evict();
  return true;
}

/**
 * 功能：清空全部缓存（退出登录时用 —— 换账号绝不能看到上一个账号的快照）。
 * @returns {void}
 */
export function cacheClear() {
  const s = store();
  index = {};
  if (!s) return;
  try {
    const drop = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX)) drop.push(k);
    }
    drop.forEach(k => s.removeItem(k));
  } catch (_e) {
    /* 清不掉就算了，调用方随后会整页跳转 */
  }
}

/**
 * 功能：缓存的规模（条数 ＋ 约多少 KB），只给诊断用。
 * @returns {{count: number, kb: number}} 统计结果
 */
export function cacheStats() {
  const idx = getIndex();
  const paths = Object.keys(idx);
  const bytes = paths.reduce((n, p) => n + (idx[p].size || 0), 0);
  return { count: paths.length, kb: Math.round(bytes / 1024) };
}

/**
 * 功能：当前是否按离线处理。
 * @returns {boolean} 离线为 true
 */
export function isOffline() {
  return offline;
}

/**
 * 功能：订阅离线状态变化（横幅与各端提示用）。
 * @param {Function} fn - 接收 `(offline: boolean)`
 * @returns {Function} 取消订阅
 */
export function onOfflineChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 功能：改离线状态并通知订阅者（值没变则不通知，避免横幅反复闪）。
 * @param {boolean} next - 新的状态
 * @returns {void}
 */
function setOffline(next) {
  if (next === offline) return;
  offline = next;
  listeners.forEach(fn => {
    try {
      fn(offline);
    } catch (_e) {
      /* 订阅者自己的错不该影响别的订阅者 */
    }
  });
}

/**
 * 功能：记一次「网络层失败」（断网、DNS 失败、连接被拒）。
 * @returns {void}
 */
export function markNetworkFailure() {
  setOffline(true);
}

/**
 * 功能：记一次「请求成功」—— 只要还能通，就退出离线态。
 * @returns {void}
 */
export function markNetworkSuccess() {
  setOffline(false);
}

/**
 * 功能：写请求的离线守卫 —— 明确告诉用户「现在只能看」。
 *
 * 说明：只在**设备真的没有网络**（`navigator.onLine === false`）时拦。
 *      不用「上次请求失败」的标记来拦：那个标记可能已经过期，
 *      拦掉一次本来能成功的保存，比让它失败更糟（用户会以为数据存上了）。
 * @param {string} method - HTTP 方法
 * @returns {void}
 * @throws {Error} 离线且是写请求时抛出，`status` 为 0
 */
export function guardWrite(method) {
  if (String(method).toUpperCase() === 'GET') return;
  let online;
  try {
    online = navigator.onLine !== false;
  } catch (_e) {
    // 读不到就按「有网」处理：拦掉一次本来能成功的写，比让它失败更糟
    online = true;
  }
  if (online) return;
  const err = new Error('现在没有网络，只能查看；连上网络后再修改或新建');
  err.status = 0;
  err.offline = true;
  throw err;
}

/**
 * 功能：挂一条常驻的「离线只读」横幅（两端入口各调一次，重复调用无副作用）。
 *
 * 说明：横幅自己用内联样式 ＋ 既有 CSS 变量，⛔ 不新建色值、⛔ 不引外部字体
 *      （前端规矩：只吃本地资源与既有令牌）。位置固定在顶部，避开两端的顶栏。
 * @returns {void}
 */
export function mountOfflineBanner() {
  if (typeof document === 'undefined') return;
  const ID = 'zx-offline-banner';
  const paint = () => {
    let el = document.getElementById(ID);
    if (!offline) {
      if (el) el.remove();
      return;
    }
    if (el) return;
    el = document.createElement('div');
    el.id = ID;
    el.setAttribute('role', 'status');
    el.textContent = '离线模式 · 只能查看，不能修改或新建';
    el.style.cssText = [
      'position:fixed',
      'left:0',
      'right:0',
      'bottom:0',
      'z-index:2147483000',
      'padding:8px 12px calc(8px + env(safe-area-inset-bottom, 0px))',
      'background:var(--warn-soft, #FEF3C7)',
      'color:var(--warn-text, #92400E)',
      'font-size:12px',
      'line-height:18px',
      'text-align:center',
      'border-top:1px solid var(--line, #E4E9F1)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  };
  onOfflineChange(paint);
  // 浏览器自己的在线/离线事件是**最可靠**的信号（WebView 也一样）
  window.addEventListener('online', () => {
    markNetworkSuccess();
    paint();
  });
  window.addEventListener('offline', () => {
    markNetworkFailure();
    paint();
  });
  paint();
}
