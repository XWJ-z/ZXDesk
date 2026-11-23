/**
 * core/draft.js —— 未保存输入的自动草稿与重载恢复
 *
 * 功能：给弹层表单与屏内输入框挂一层**自动草稿** —— 输入时按稳定键把字段值写进 `sessionStorage`，
 * 再次打开同一张表单时回填并提示；页面被重载（切后台进程回收、网络抖动重试、跨天重载）后
 * 还能按登记表把原表单重新打开、把草稿填回去。
 *
 * @author zx
 * @date   2026-11-22
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

/** 键前缀：带版本号，将来改结构直接改这里，旧草稿自然失效（不用写迁移）。 */
const DRAFT_PREFIX = 'zxdesk.draft.v1:';

/** 重载恢复槽的逻辑键（不动 `#sheet` 的历史栈，只记「刚才开着哪张表单」）。 */
const RESUME_KEY = '__resume';

/** 条数上限：超过就淘汰最旧的那几条。 */
const DRAFT_MAX_ENTRIES = 30;

/** 单条上限：超过就不存（多半是粘贴了一整篇，存它只会把配额一次吃光）。 */
const DRAFT_MAX_BYTES = 128 * 1024;

/** 草稿寿命：超过一天的草稿不再回填（用户早就忘了那是哪一次）。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** 输入防抖：150ms 写一次，连打一串字只落一次盘（手机上被系统杀掉时不走 `pagehide`，窗口越短丢得越少）。 */
const DRAFT_DEBOUNCE_MS = 150;

/** 「恢复了上次未保存的内容」的提示函数，由宿主的 `setDraftNotice()` 注入。 @type {?function(string): void} */
let draftNotice = null;

/**
 * 本次关闭是不是「保存成功」引起的。
 *
 */
let savingFlag = false;

/** 保存标记的自动失效计时器（见 `markSaving()`）。 @type {number} */
let savingTimerHandle = 0;

/** 所有挂过草稿的容器状态（含屏内输入框）。 @type {Set<Object>} */
const draftHosts = new Set();

/** 「怎么把这张表单再打开一次」的登记表：`kind -> fn(payload, key)`。 @type {Map<string, function>} */
const draftReopeners = new Map();

/** 草稿归属（账号 id）：键按账号隔离 —— 同机换人登录不会看到上一个人打的半截字。 @type {string} */
let draftOwner = '';

/**
 * 功能：设置草稿归属（账号 id），宿主拿到 `me.id` 后调一次。
 * @param {(number|string)} id - 账号 id
 * @returns {void}
 */
export function setDraftOwner(id) {
  const next = id == null ? '' : String(id);
  if (next === draftOwner) return;
  draftOwner = next;
  // 归属变了 ⇒ 挂在旧归属上的宿主状态全作废（否则会把旧键写回去）
  draftHosts.clear();
}

/**
 * 功能：逻辑键 → 真实存储键。
 * @param {string} key - 逻辑键
 * @returns {string} 带前缀（与账号）的真实键
 */
function storeKey(key) {
  return DRAFT_PREFIX + (draftOwner ? draftOwner + ':' : '') + key;
}

/**
 * 功能：安全地取 `localStorage`（隐私模式 / 配额满 / 被策略禁掉时返回 null）。
 *
 * ⚠️ 必须用 `localStorage`：`sessionStorage` 的生命周期是「这个标签页/WebView 会话」，
 * 手机上把 App 划掉再进来就是全新会话 —— 草稿与恢复槽会一起消失，用户看到的就是
 * 「打了半截的字全没了」。跨会话只能靠 `localStorage`（另有 TTL 与条数上限兜底）。
 * @returns {?Storage} 可用时返回存储对象
 */
function draftStore() {
  try {
    const s = window.localStorage;
    const probe = DRAFT_PREFIX + '__probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：读回一条记录（坏数据当没有）。
 * @param {string} key - 存储键
 * @returns {?Object} 记录对象；不存在或解析失败返回 null
 */
function readDraftItem(key) {
  const s = draftStore();
  if (!s) return null;
  try {
    const raw = s.getItem(storeKey(key));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：淘汰最旧的几条，给新记录腾位置。
 * @returns {void}
 */
function evictDrafts() {
  const s = draftStore();
  if (!s) return;
  const keys = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      // 这里是**真实键**（带前缀）：恢复槽也带前缀，别拿逻辑键去比
      if (k && k.startsWith(DRAFT_PREFIX) && k !== DRAFT_PREFIX + RESUME_KEY) keys.push(k);
    }
  } catch (_e) {
    return;
  }
  if (keys.length < DRAFT_MAX_ENTRIES) return;
  const aged = keys
    .map((k) => {
      let at;
      try {
        at = Number((JSON.parse(s.getItem(k) || 'null') || {}).at) || 0;
      } catch (_e) {
        at = 0;
      }
      return { k, at };
    })
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(1, keys.length - DRAFT_MAX_ENTRIES + 1));
  aged.forEach((x) => {
    try {
      s.removeItem(x.k);
    } catch (_e) {
      /* 配额 / 权限问题忽略 */
    }
  });
}

/**
 * 功能：写一条记录；超过单条上限就跳过（返回 false）。
 * @param {string} key - 存储键
 * @param {Object} obj - 要序列化的记录
 * @returns {boolean} 真的写进去了返回 true
 */
function writeDraftItem(key, obj) {
  const s = draftStore();
  if (!s) return false;
  let raw;
  try {
    raw = JSON.stringify(obj);
  } catch (_e) {
    return false;
  }
  if (raw.length > DRAFT_MAX_BYTES) return false;
  try {
    evictDrafts();
    // 真实存储键 = 前缀 ＋ 逻辑键 —— 只有带上前缀，登录页那句「清 zxdesk.draft.v1:」才清得到
    s.setItem(storeKey(key), raw);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 功能：删掉一条记录（键不存在也算成功）。
 * @param {string} key - 存储键
 * @returns {void}
 */
function removeDraftItem(key) {
  const s = draftStore();
  if (!s) return;
  try {
    s.removeItem(storeKey(key));
  } catch (_e) {
    /* 忽略 */
  }
}

/**
 * 功能：字符串 → 短哈希（给「没有显式 key 的表单」推一个稳定键）。
 * @param {string} str - 源串
 * @returns {string} 36 进制的无符号哈希
 */
function hashDraftKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 功能：判断一个表单字段该不该进草稿。
 *
 * 说明：⚠️ 采集与回填共用这一个判据（见文件头）。
 * @param {Element} el - 表单控件
 * @returns {boolean} 该采集返回 true
 */
function usableField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  const type = String(el.type || '').toLowerCase();
  if (type === 'password' || type === 'file' || type === 'hidden') return false;
  if (el.closest('[data-no-draft]')) return false;
  return true;
}

/**
 * 功能：列出容器里所有该采集的控件（顺序就是草稿里的索引）。
 * @param {Element} root - 弹层正文或屏内输入容器
 * @returns {Array<Element>} 控件数组
 */
function draftFields(root) {
  if (!root || !root.querySelectorAll) return [];
  return Array.prototype.filter.call(root.querySelectorAll('input, textarea, select'), usableField);
}

/**
 * 功能：把容器里的字段值读成数组。
 * @param {Element} root - 容器
 * @returns {Array<string|number>} 值数组（checkbox / radio 存 0 / 1）
 */
function collectValues(root) {
  return draftFields(root).map((el) => {
    const type = String(el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return el.checked ? 1 : 0;
    return String(el.value == null ? '' : el.value);
  });
}

/**
 * 功能：把一个控件标成「刚被程序改过」，让页面自己的监听（自增高、字数提示）跑一遍。
 * @param {Element} el - 控件
 * @returns {void}
 */
function fireField(el) {
  try {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_e) {
    /* 老内核上构造 Event 可能失败，忽略即可 */
  }
}

/**
 * 功能：把值数组按同样的顺序回填进容器。
 * @param {Element} root - 容器
 * @param {Array} values - 值数组
 * @returns {boolean} 真的改动了至少一个字段返回 true
 */
function applyValues(root, values) {
  let changed = false;
  draftFields(root).forEach((el, i) => {
    if (i >= values.length) return;
    const v = values[i];
    const type = String(el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const on = !!Number(v);
      if (el.checked !== on) {
        el.checked = on;
        changed = true;
        fireField(el);
      }
      return;
    }
    const next = v == null ? '' : String(v);
    if (el.value !== next) {
      el.value = next;
      changed = true;
      fireField(el);
    }
  });
  return changed;
}

/**
 * 功能：推一个「同一种表单总是算出同一个键」的草稿键。
 *
 * 说明：键 = 标题 ＋ 字段 id / name / type 的清单 —— 标题区分「新建任务 / 记一条灵感」，
 * 字段清单区分「同一个标题下的两套表单」。⚠️ 同一张表单服务多个实体时（编辑任务 A / B）
 * @param {string} title - 弹层标题
 */
export function draftKeyOf(title, root) {
  const marks = draftFields(root)
    .map((el) => el.id || el.getAttribute('name') || el.type || el.tagName)
    .join(',');
  return 'auto:' + hashDraftKey(String(title || '') + '|' + marks);
}

/**
 * 功能：把一张表单「上次没保存的内容」落盘（防抖后的真正写入）。
 * @param {Object} h - 宿主状态（见 `attachDraft()`）
 * @returns {void}
 */
function flushDraftHost(h) {
  if (!h) return;
  if (h.timer) {
    clearTimeout(h.timer);
    h.timer = 0;
  }
  const values = collectValues(h.root);
  const same =
    values.length === h.base.length && values.every((v, i) => String(v) === String(h.base[i]));
  // 内容与刚打开时一模一样 ⇒ 用户没动过它，不建草稿（并把旧草稿一起删掉：
  // 用户手动把字删回原样，等于放弃这次编辑）
  if (same) {
    removeDraftItem(h.key);
    h.dirty = false;
    return;
  }
  writeDraftItem(h.key, { at: Date.now(), values });
  h.dirty = false;
  // 重载恢复槽只记「输入过的表单」—— 没输入过就不该在重载后自己弹回来
  if (h.opts && h.opts.resume && h.opts.resume.kind) {
    writeDraftItem(RESUME_KEY, {
      at: Date.now(),
      kind: String(h.opts.resume.kind),
      payload: h.opts.resume.payload == null ? null : h.opts.resume.payload,
      tab: h.opts.tab || '',
      key: h.key,
    });
  }
}

/**
 * 功能：把一个容器的监听挂上（只挂一次）。
 * @param {Element} root - 容器
 * @returns {void}
 */
function bindDraftRoot(root) {
  if (root.__zxDraftBound) return;
  const onChange = () => {
    const h = root.__zxDraft;
    if (!h) return;
    h.dirty = true;
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => flushDraftHost(h), DRAFT_DEBOUNCE_MS);
  };
  root.addEventListener('input', onChange);
  root.addEventListener('change', onChange);
  root.__zxDraftBound = true;
}

/**
 * 功能：给一个容器挂上自动草稿 —— 之后里面的输入会按 `key` 自动落盘。
 *
 * 说明：⭐ 宿主在**每次打开弹层**时调一次；屏内输入框在建视图时调一次。
 * 打开前那张表单若还有没落盘的改动，先 `flushDraft()` 收掉（宿主负责）。
 *
 */
export function attachDraft(root, key, opts) {
  if (!root) return '';
  const o = opts || {};
  // 当成当前表单的键去清）。⚠️ 落盘由宿主的 `flushDraft()` 负责 —— 它在换 `innerHTML` **之前**跑；
  // 这里再 flush 一次的话，读到的已经是新表单的内容，会往旧键里写一份错的草稿。
  const prev = root.__zxDraft;
  const dropPrev = () => {
    if (!prev) return;
    if (prev.timer) clearTimeout(prev.timer);
    draftHosts.delete(prev);
    delete root.__zxDraft;
  };
  if (o.draft === false) {
    dropPrev();
    root.removeAttribute('data-draft-key');
    return '';
  }
  const k = String(key || draftKeyOf(o.title, root));
  if (prev && prev.key === k) {
    // 同一张表单被**重画**（换收支 / 点分类这类自绘刷新，走的还是 `openSheet()`）：
    // 关一次就攒出一条假草稿、下次打开还提示「恢复了上次未保存的内容」。
    prev.opts = o;
    prev.root = root;
    draftHosts.add(prev);
    bindDraftRoot(root);
    return k;
  }
  dropPrev();
  const h = { root, key: k, opts: o, base: collectValues(root), timer: 0, dirty: false };
  root.__zxDraft = h;
  root.setAttribute('data-draft-key', k);
  draftHosts.add(h);
  bindDraftRoot(root);
  return k;
}

/**
 * 功能：把草稿回填进容器，并在真的改动了字段时提示一句。
 * @param {Element} root - 容器
 * @param {string} [key] - 草稿键；缺省用 `attachDraft()` 记下的那个
 * @returns {boolean} 回填了内容返回 true
 */
export function restoreDraft(root, key) {
  const h = root && root.__zxDraft;
  const k = String(key || (h && h.key) || '');
  if (!k) return false;
  const rec = readDraftItem(k);
  if (!rec) return false;
  if (Date.now() - (Number(rec.at) || 0) > DRAFT_TTL_MS) {
    removeDraftItem(k);
    return false;
  }
  const values = Array.isArray(rec.values) ? rec.values : [];
  if (!values.length) return false;
  const changed = applyValues(root, values);
  // 回填后**不改** `base`：用户什么都没动就关掉时，草稿要原样留着（下次还能再恢复）
  if (changed && draftNotice) draftNotice('恢复了上次未保存的内容');
  return changed;
}

/**
 * 功能：立即把所有挂着的改动落盘（`pagehide` / 换弹层 / 跨天重载前）。
 * @returns {void}
 */
export function flushDraft() {
  // 不按 `dirty` 过滤：程序赋的值（草稿驱动的重画）不走 `input` 事件，
  draftHosts.forEach((h) => flushDraftHost(h));
}

/**
 * 功能：弹层关闭时收尾 —— 收掉最后一点改动，按「是不是保存关闭」决定清不清草稿。
 *
 * 说明：⚠️ 用户主动关（点遮罩 / 返回 / 取消）**保留草稿**，只清重载恢复槽 ——
 * 他是主动不看的，下次重载不该自己弹回来；但他手动重开同一表单时草稿要能回来。
 * @param {Element} root - 容器的根（`#sheet-body` / `#modal-body`）
 */
export function releaseDraft(root) {
  const h = root && root.__zxDraft;
  let cleared = false;
  if (h) {
    // 关闭这一趟一定要收最后一次输入 —— 不能只认 `dirty`（见 `flushDraft()` 的说明）
    flushDraftHost(h);
    if (savingFlag) {
      removeDraftItem(h.key);
      cleared = true;
    }
    if (h.timer) clearTimeout(h.timer);
    draftHosts.delete(h);
    delete root.__zxDraft;
    root.removeAttribute('data-draft-key');
  }
  savingFlag = false;
  if (savingTimerHandle) clearTimeout(savingTimerHandle);
  savingTimerHandle = 0;
  removeDraftItem(RESUME_KEY);
  return cleared;
}

/**
 * 功能：删掉某张表单的草稿（保存成功那一刻用，或用户明确放弃时用）。
 * @param {string} key - 草稿键
 * @returns {void}
 */
export function clearDraft(key) {
  if (key) removeDraftItem(String(key));
}

/**
 * 功能：标记「这一次关闭是保存引起的」—— 宿主的保存动作在提交前调一次。
 *
 * 说明：⚠️ 电脑端的保存回调是各表单自己挂的（`$('#modal-save').onclick = …`），拿不到 Promise，
 * 只能在**点主按钮**那一刻打标记。校验没过 / 请求失败时弹窗不会关，标记会一直挂着 ——
 * 给一个 `ttlMs` 让它自己失效，免得「点了保存失败，再点遮罩关闭」把草稿一起清掉。
 */
export function markSaving(ttlMs) {
  savingFlag = true;
  if (savingTimerHandle) clearTimeout(savingTimerHandle);
  savingTimerHandle = 0;
  const ttl = Number(ttlMs);
  if (ttl > 0) {
    savingTimerHandle = setTimeout(() => {
      savingFlag = false;
      savingTimerHandle = 0;
    }, ttl);
  }
}

/**
 * 功能：撤销上一次 `markSaving()`（保存失败 / 校验没过时调，草稿要留着）。
 * @returns {void}
 */
export function endSaving() {
  savingFlag = false;
  if (savingTimerHandle) clearTimeout(savingTimerHandle);
  savingTimerHandle = 0;
}

/**
 * 功能：登记「某个 kind 的表单怎么再打开一次」—— 页面重载后由 `runResume()` 调。
 * @param {string} kind - 表单标识（与 `attachDraft()` 的 `opts.resume.kind` 对齐）
 * @param {function(*, string): void} fn - 重开函数，收到存下来的 `payload` 与草稿键
 * @returns {void}
 */
export function registerResume(kind, fn) {
  if (!kind || typeof fn !== 'function') return;
  draftReopeners.set(String(kind), fn);
  // 模块是懒加载的：注册这一刻恢复槽里可能正等着它 —— 立刻补一次，别等宿主那轮轮询
  const rec = resumeInfo();
  if (rec && String(rec.kind) === String(kind)) runResume();
}

/**
 * 功能：读一眼重载恢复槽（宿主在重载后、切回原屏之前用）。
 * @returns {?Object} `{ kind, payload, tab, key, at }`；没有或过期返回 null
 */
export function resumeInfo() {
  const rec = readDraftItem(RESUME_KEY);
  if (!rec) return null;
  if (Date.now() - (Number(rec.at) || 0) > DRAFT_TTL_MS) {
    removeDraftItem(RESUME_KEY);
    return null;
  }
  return rec;
}

/**
 * 功能：清掉重载恢复槽（宿主主动关弹层时、以及恢复成功后调）。
 * @returns {void}
 */
export function clearResume() {
  removeDraftItem(RESUME_KEY);
}

/**
 * 功能：按恢复槽把原表单重新打开并把草稿填回去。
 *
 * 说明：⭐ 必须由**模块自己**提供重开函数（`registerResume()`）—— 光有正文 HTML 恢复不出来，
 * `state.sheetSave` 是闭包，照 HTML 造出来的表单点了保存什么也不会发生。
 * 模块是动态 import 的，可能比宿主启动更晚 ⇒ 找不到登记就短轮询重试，10 次（约 2 秒）后放弃，
 */
export function runResume(attempt) {
  const n = Number(attempt) || 0;
  const rec = resumeInfo();
  if (!rec) return false;
  const fn = draftReopeners.get(String(rec.kind || ''));
  if (!fn) {
    if (n < 10) setTimeout(() => runResume(n + 1), 200);
    return false;
  }
  // 先清槽：重开过程里用户再输入会重新写一条，不先清就会在下次重载时重复弹
  removeDraftItem(RESUME_KEY);
  try {
    fn(rec.payload == null ? null : rec.payload, rec.key || '');
    return true;
  } catch (e) {
    console.error('[draft] 重开表单失败：', e);
    return false;
  }
}

/**
 * 功能：注入「恢复了上次未保存的内容」的提示函数（两端各注入自己那套 toast）。
 * @param {?function(string): void} fn - 提示函数
 * @returns {void}
 */
export function setDraftNotice(fn) {
  draftNotice = typeof fn === 'function' ? fn : null;
}

// 页面要走了就把最后一点改动收掉（进程被直接杀掉时收不到，但输入时已经防抖落过盘了）
try {
  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft();
  });
} catch (_e) {
  /* 非浏览器环境（测试 / 预渲染）忽略 */
}
