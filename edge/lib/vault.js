/**
 * vault.js —— 密码库只读通路（状态查询 / 取一条明文）
 * 功能：`vaultStatus` 问「初始化没有、锁没锁」（不需要解锁）；`vaultEntry` 取一条的
 *      `title` / `username` / `password`（要求服务端已解锁）。⛔ 只有 SW 经这里发请求。
 *
 * 服务端口径（`app/modules/vault/routes.js` + `store.js` 实证）：
 * - `GET /api/vault/status` **不需要解锁** ⇒ `{initialized, unlocked, lockAfterSeconds, lockMinutes}`
 *   （⚠️ 它用 `peekUnlocked` 只读判断，**不续期**自动锁定 —— 所以可以放心轮询）…
 * @author zx
 * @since
 * 相关：Project/Edge/README.md
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
 * |{ok:false, code:'vault_locked'|'vault_gone'|'need_zxdesk_login'|string}>}
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
