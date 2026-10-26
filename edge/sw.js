/**
 * 功能：SW 入口 —— 消息路由 + 会话感知 + 收藏动作（任务单 §五/§六）。
 *
 * 分层纪律：
 * 1. 全插件**只有这里经 `lib/*` 发网络请求**；UI 一律 `chrome.runtime.sendMessage`；
 * 2. 只有 `lib/store.js` 碰 `chrome.storage`；
 * 3. 消息名与文案只在 `lib/messages.js`。
 *
 * 收藏动作（M3）三个入口共用 `quickSave()`：
 * - 右键菜单（连接后才建；`page` / `link`，有 `linkUrl` 收链接）；
 * - `Alt+Shift+S`（activeTab 随命令授予）；
 * - popup 表单走 `bm:create` 消息（inline 反馈，不用角标）。
 */
import { MSG, BM_TEXT } from './lib/messages.js';
import { connect, status, disconnect, onCookieChanged } from './lib/connect.js';
import { createBookmark, listBookmarks, removeBookmark, updateBookmark } from './lib/bookmarks.js';
import { vaultStatus, vaultEntry } from './lib/vault.js';
import { getConn, clearCache, getCache, setCache, getLastConn, setLastConn, takePending } from './lib/store.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  route(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ state: 'failed', error: 'network', detail: String((e && e.message) || e) }));
  return true; // 异步 sendResponse
});

async function route(msg) {
  const payload = msg && msg.payload;
  switch (msg && msg.type) {
    case MSG.detect:
      return detect();
    case MSG.start:
      return afterStart(await connect(payload || {}));
    case MSG.status:
      return status();
    case MSG.recheck:
      return status();
    case MSG.lastConn:
      return getLastConn(); // SW 自动续跑的结果（0.1.4 硬规则 3 的展示口）
    case MSG.disconnect:
      await removeMenus();
      return disconnect();
    case MSG.bmCreate:
      return bmCreate(payload);
    case MSG.bmList:
      return bmList(payload);
    case MSG.bmRemove:
      return bmRemove(payload);
    case MSG.bmUpdate:
      return bmUpdate(payload); // 0.1.5 E2
    case MSG.vaultStatus:
      return vaultStatusMsg(); // 0.1.5 E3
    case MSG.vaultEntry:
      return vaultEntryMsg(payload);
    case MSG.pageContext:
      return pageContext();
    case MSG.bmCacheGet:
      return getCache(); // 只有 store 碰 storage；UI 经消息取（分层纪律 2）
    case MSG.bmCacheSet:
      await setCache(payload);
      return { ok: true };
    default:
      return { ok: false, code: 'unknown_message', type: msg && msg.type };
  }
}

/** 功能：连接成功 ⇒ 建右键菜单并清列表缓存（下次进侧边栏拉新的）；其余状态不动菜单。 */
async function afterStart(st) {
  if (st && st.state === 'connected') {
    await Promise.all([ensureMenus(), clearCache()]);
  }
  return st;
}

/**
 * 功能：`conn:detect` —— 只读 activeTab 那一瞬的地址（方案 §4.1）。
 * ⛔ 不扫全部标签、不碰历史（红线 §十三.5）；`activeTab` 已授予这一瞬的 url 可见性。
 */
async function detect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab && tab.url ? tab.url : '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return { origin: u.origin, gatewayHint: /\/app\/zxdesk(\/|$)/.test(u.pathname) };
    }
  } catch (_e) {
    /* 非 http(s) 标签 / 拿不到 url ⇒ 让用户手输 */
  }
  return { origin: null };
}

/** 功能：`page:context` —— 当前页 url + 标题（popup 收藏表单预填用；同 detect 的 activeTab 口径）。 */
async function pageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab && tab.url ? tab.url : '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return { url: u.href, title: String(tab.title || '') };
    }
  } catch (_e) {
    /* 非 http(s) ⇒ 空 */
  }
  return { url: '', title: '' };
}

// ---- 收藏消息（M3/M4）----

/** 功能：从 `getConn()` 取可用 base；没连/没验过 ⇒ null（⛔ 不拿旧记录硬发）。 */
async function requireBase() {
  const conn = await getConn();
  return conn && conn.isValid && conn.base ? conn.base : null;
}

async function bmCreate(p) {
  const base = await requireBase();
  if (!base) return { ok: false, code: 'not_connected' };
  const url = p && String(p.url || '').trim();
  if (!url) return { ok: false, code: 'url_empty' };
  const r = await createBookmark(base, { url, title: p && p.title, tags: p && p.tags });
  if (r.ok) await clearCache(); // 新增成功 ⇒ 首屏缓存过期（侧边栏「添加网址」后列表要立即对上）
  return r;
}

async function bmList(f) {
  const base = await requireBase();
  if (!base) return { ok: false, code: 'not_connected' };
  try {
    const data = await listBookmarks(base, f || {});
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'network' };
  }
}

async function bmRemove(p) {
  const base = await requireBase();
  if (!base) return { ok: false, code: 'not_connected' };
  const r = await removeBookmark(base, p && p.id);
  if (r.ok) await clearCache(); // 删了就过期，下次列表拉新的
  return r;
}

/** 功能：0.1.5 E2 编辑 —— ⛔ 不透传 `url`（任务单 §七.2），只放行 title / tags。 */
async function bmUpdate(p) {
  const base = await requireBase();
  if (!base) return { ok: false, code: 'not_connected' };
  const id = p && p.id;
  if (id == null || id === '') return { ok: false, code: 'id_missing' };
  const patch = {};
  if (p.title !== undefined) patch.title = String(p.title);
  if (Array.isArray(p.tags)) patch.tags = p.tags;
  const r = await updateBookmark(base, id, patch);
  if (r.ok) await clearCache(); // 改了就过期（网页端/侧边栏下次读到的都是新的）
  return r;
}

// ---- 0.1.5 E3：密码库只读（只透传，⛔ 这里不落任何存储、不打任何日志）----

async function vaultStatusMsg() {
  const base = await requireBase();
  if (!base) return { ok: false, code: 'not_connected' };
  return vaultStatus(base);
}

async function vaultEntryMsg(p) {
  const base = await requireBase();
  if (!base) return { ok: false, code: 'not_connected' };
  const id = p && p.id;
  if (id == null || id === '') return { ok: false, code: 'vault_gone' };
  return vaultEntry(base, id);
}

// ---- 右键菜单 + 快捷键（共用 quickSave，角标反馈）----

/** 功能：连接后才建菜单（任务单 §五.4）；重复 create 会报错，先 removeAll 再建。 */
async function ensureMenus() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: 'zxdesk-save', title: BM_TEXT.menuPage, contexts: ['page'] });
    chrome.contextMenus.create({ id: 'zxdesk-save-link', title: BM_TEXT.menuLink, contexts: ['link'] });
  } catch (_e) {
    /* SW 瞬态，下次连接再建 */
  }
}

async function removeMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch (_e) {
    /* 无菜单可删 */
  }
}

/** 功能：SW 启动时若存着有效连接就恢复菜单（MV3 SW 会被杀，事件监听必须常驻顶层）。 */
getConn()
  .then((c) => {
    if (c && c.isValid) ensureMenus();
  })
  .catch(() => {});

/** 角标：成功 `✓` 2 s 清空；失败 `!` 2 s 清空（任务单 §五.5）。 */
function badge(ok) {
  const t = ok ? '✓' : '!';
  chrome.action.setBadgeText({ text: t });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#cf222e' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

/** 功能：统一收藏入口 —— 发请求、判重复（重复也是「已收藏」，不报错）。 */
async function quickSave(url, title) {
  const base = await requireBase();
  if (!base || !url) return badge(false);
  const r = await createBookmark(base, { url, title });
  badge(r.ok || r.code === 'duplicate');
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.pageUrl;
  if (url) quickSave(url, tab && tab.title ? tab.title : '');
});

chrome.commands.onCommand.addListener(async (name) => {
  if (name !== 'quick-save') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab && tab.url ? tab.url : '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      await quickSave(u.href, String((tab && tab.title) || ''));
    } else {
      badge(false);
    }
  } catch (_e) {
    badge(false);
  }
});

/** 功能：会话感知（方案 §4.3）—— `zxdesk_sid` 变化 ⇒ 登录等待轮询插队（已连接态按需 status，不常驻）。 */
chrome.cookies.onChanged.addListener(({ cookie }) => {
  onCookieChanged(cookie.name);
});

// ================= 0.1.4：授权一次过（任务单 §2.3 硬规则 3） =================

/**
 * 功能：拿到新 host 权限 ⇒ 有 pendingConnect 就自动续跑连接——**与任何页面是否还活着无关**
 * （popup 被授权弹窗关掉也不影响，这正是根因 B 的根治点）。结果写 `edge:last-conn` 供 UI 收割。
 */
chrome.permissions.onAdded.addListener(async () => {
  try {
    const pc = await takePending(); // 取走即删（原子，防双跑）
    if (!pc) return;
    const st = await afterStart(await connect(pc));
    await setLastConn({ status: st });
  } catch (e) {
    // ⭐ 不静默：失败也要落一条结果，UI 收割时才有落点（真机「一直连接中」就死在这里无声无息）
    console.warn('[zxdesk] 授权后续跑失败', e);
    try {
      await setLastConn({ status: { state: 'failed', error: 'network', detail: String((e && e.message) || e) } });
    } catch (_e2) {
      /* 存储也没了 ⇒ 只能让用户在设置里重试 */
    }
  }
});

// ================= 0.1.4：工具栏打开方式（任务单 §五） =================

/**
 * 功能：按 `pref:openMode` 切换点图标的动作（弹窗 ↔ 侧边栏）。
 * ⚠️ `setPopup({popup:''})` 后点图标触发 `action.onClicked`，此时已被 sidePanel 拦截，二者不冲突；
 * ⚠️ Edge 版本不支持 `sidePanel.setPanelBehavior` 时降级为只开弹窗（不报错，§五）。
 */
async function applyOpenMode(mode) {
  try {
    if (mode === 'sidepanel' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.action.setPopup({ popup: '' });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
      await chrome.action.setPopup({ popup: 'ui/popup.html' });
    }
  } catch (_e) {
    /* setPanelBehavior 不可用 ⇒ 保持 default_popup，不报错 */
  }
}

async function bootOpenMode() {
  try {
    const bag = await chrome.storage.local.get('pref:openMode');
    await applyOpenMode(bag['pref:openMode']);
  } catch (_e) {
    /* storage 瞬态 ⇒ 用 manifest 默认弹窗 */
  }
}
// 四触发点（§五）：安装、启动、设置变更、（设置页保存经 storage.onChanged 已覆盖）
chrome.runtime.onInstalled.addListener(bootOpenMode);
chrome.runtime.onStartup.addListener(bootOpenMode);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['pref:openMode']) applyOpenMode(changes['pref:openMode'].newValue);
});
bootOpenMode(); // SW 冷启动兜底（onInstalled/onStartup 不保证每次都醒）
