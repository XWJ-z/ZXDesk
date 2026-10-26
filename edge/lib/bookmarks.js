/**
 * 功能：收藏夹 REST（任务单 §五 M3 / §六 M4）—— ⛔ 只有 SW 经这里发请求，UI 一律走消息。
 *
 * 服务端口径（`Project/fnos` bookmarks/store.js 实证）：
 * - `POST /api/bookmarks {url, title?, tags:[分类名…]}` —— **只传分类名**（`ensureTag` 自动建），
 *   ⛔ 不传 id、⛔ 不先调 `/api/bookmarks/tags` 建分类（退回条件 6）；
 * - 同账号 URL 重复 ⇒ 400 + `error` 含「已经收藏过」（原样字符串比对，不归一化）；
 * - `GET /api/bookmarks?q=&tag=` ⇒ `{items, total, tags}`，`tags` 末尾有 `{id:'none',name:'未分类'}` 哨兵；
 * - `DELETE /api/bookmarks/:id` ⇒ 204；不存在/越权统一 404。
 */
import { fetchJson } from './api.js';

const REQ_TIMEOUT = 8000;

/**
 * 功能：新建收藏。`tags` 只收分类名（服务端自动建缺失分类）。
 * @returns {Promise<{ok:true, item:object}|{ok:false, code:string, serverText?:string}>}
 */
export async function createBookmark(base, { url, title, tags }) {
  try {
    const { data } = await fetchJson(base + '/api/bookmarks', {
      method: 'POST',
      body: { url, title: title || '', tags: Array.isArray(tags) ? tags : [] },
      timeout: REQ_TIMEOUT,
    });
    return { ok: true, item: data };
  } catch (e) {
    if (e && e.code === 'http_error' && e.status === 400 && /已经收藏过/.test(e.errorText || '')) {
      return { ok: false, code: 'duplicate', serverText: e.errorText };
    }
    if (e && e.code === 'http_error' && e.status === 401) return { ok: false, code: 'need_zxdesk_login' };
    return { ok: false, code: (e && e.code) || 'network', serverText: (e && e.errorText) || '' };
  }
}

/**
 * 功能：列表 / 搜索 / 分类筛选。
 * @param {{q?:string, tag?:string}} f - `tag` 传分类 id 字符串；未分类传 `'none'`（服务端哨兵）
 * @returns {Promise<{items:Array, total:number, tags:Array}>}
 */
export async function listBookmarks(base, f = {}) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.tag) p.set('tag', f.tag);
  const qs = p.toString();
  const { data } = await fetchJson(base + '/api/bookmarks' + (qs ? '?' + qs : ''), { timeout: REQ_TIMEOUT });
  return { items: Array.isArray(data.items) ? data.items : [], total: Number(data.total) || 0, tags: Array.isArray(data.tags) ? data.tags : [] };
}

/** 功能：删除一条。404（已删/越权）按「已不存在」处理，删后刷新自然对齐。 */
export async function removeBookmark(base, id) {
  try {
    await fetchJson(base + '/api/bookmarks/' + encodeURIComponent(id), { method: 'DELETE', timeout: REQ_TIMEOUT });
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'http_error' && e.status === 404) return { ok: true };
    if (e && e.code === 'http_error' && e.status === 401) return { ok: false, code: 'need_zxdesk_login' };
    return { ok: false, code: (e && e.code) || 'network' };
  }
}

/**
 * 功能：编辑一条（0.1.5 E2）—— 只带要改的字段，`tags` 是**整体替换**（服务端 `ensureTag` 自动建新分类）。
 * ⛔ **绝不带 `url`**（任务单 §三.1/§七.2）：带上会被当成「改网址」，撞到同账号下已有的同一网址就 400，
 *    而编辑标题这个动作跟网址毫无关系。
 * @param {{title?:string, tags?:string[]}} patch
 * @returns {Promise<{ok:true,item:object}|{ok:false, code:string}>} 404 ⇒ `bookmark_gone`（越权与不存在同码）
 */
export async function updateBookmark(base, id, patch) {
  const body = {};
  if (patch && patch.title !== undefined) body.title = String(patch.title);
  if (patch && Array.isArray(patch.tags)) body.tags = patch.tags;
  try {
    const { data } = await fetchJson(base + '/api/bookmarks/' + encodeURIComponent(id), {
      method: 'PUT',
      body,
      timeout: REQ_TIMEOUT,
    });
    return { ok: true, item: data };
  } catch (e) {
    if (e && e.code === 'http_error' && e.status === 404) return { ok: false, code: 'bookmark_gone' };
    if (e && e.code === 'http_error' && e.status === 401) return { ok: false, code: 'need_zxdesk_login' };
    return { ok: false, code: (e && e.code) || 'network' };
  }
}
