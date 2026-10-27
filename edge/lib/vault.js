/**
 * 功能：密码库**只读**通路（0.1.5 E3）—— ⛔ 只有 SW 经这里发请求，UI 一律走消息。
 *
 * 服务端口径（`app/modules/vault/routes.js` + `store.js` 实证）：
 * - `GET /api/vault/status` **不需要解锁** ⇒ `{initialized, unlocked, lockAfterSeconds, lockMinutes}`
 *   （⚠️ 它用 `peekUnlocked` 只读判断，**不续期**自动锁定 —— 所以可以放心轮询）；
 * - `GET /api/vault/:id` 需要解锁 + 归属校验 ⇒ 明文 `{id,title,username,password,url,note,tags,updated_at}`；
 *   未解锁 ⇒ **403**；不存在 / 越权 ⇒ **404**（同码）；
 * - **解锁态在服务端**（按账号，进程内存 + 自动锁定）⇒ 网页里解锁后，插件同源同会话立刻可读。
 *   这是本方案能"零新增风险面"的前提：一期插件**不收主密码**（任务单 §五 选项 C）。
 *
 * ⭐ 明文纪律：
 *   - 只挑 `title/username/password` 三样回给 UI，`note/url/tags` 一律不下发（用不上就不给）；
 *   - ⛔ 不进 `chrome.storage`、⛔ 不进 `console`、⛔ 不进任何日志与上报；
 *   - 错误分支**不带任何响应体内容**，只回错误码（403 的 body 里也可能有线索，不回传）。
 */
import { fetchJson } from './api.js';

const REQ_TIMEOUT = 8000;

/**
 * 功能：问一句「现在锁没锁」。
 * @returns {Promise<{ok:true, initialized:boolean, unlocked:boolean}|{ok:false, code:string}>}
 */
export async function vaultStatus(base) {
  try {
    const { data } = await fetchJson(base + '/api/vault/status', { timeout: REQ_TIMEOUT });
    return {
      ok: true,
      initialized: !!(data && data.initialized),
      unlocked: !!(data && data.unlocked),
    };
  } catch (e) {
    if (e && e.code === 'http_error' && e.status === 401) return { ok: false, code: 'need_zxdesk_login' };
    return { ok: false, code: (e && e.code) || 'network' };
  }
}

/**
 * 功能：取一条密码的明文（**只在内存里过**）。
 * @param {string|number} id - 收藏行上的 `vault_entry_id`
 * @returns {Promise<{ok:true, entry:{title:string, username:string, password:string}}
 *                  |{ok:false, code:'vault_locked'|'vault_gone'|'need_zxdesk_login'|string}>}
 */
export async function vaultEntry(base, id) {
  try {
    const { data } = await fetchJson(base + '/api/vault/' + encodeURIComponent(id), { timeout: REQ_TIMEOUT });
    return {
      ok: true,
      entry: {
        title: String((data && data.title) || ''),
        username: String((data && data.username) || ''),
        password: String((data && data.password) || ''),
      },
    };
  } catch (e) {
    if (e && e.code === 'http_error' && e.status === 403) return { ok: false, code: 'vault_locked' };
    if (e && e.code === 'http_error' && e.status === 404) return { ok: false, code: 'vault_gone' };
    if (e && e.code === 'http_error' && e.status === 401) return { ok: false, code: 'need_zxdesk_login' };
    return { ok: false, code: (e && e.code) || 'network' };
  }
}
