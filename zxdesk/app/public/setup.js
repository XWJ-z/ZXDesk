'use strict';
/**
 * setup.js —— 首次登录的强制设置页（新用户名 + 新密码）
 *
 * 功能：查 `/api/auth/state` 确认「当前账号仍在使用公开初始凭据」，收新用户名与新密码，
 *      先调 `POST /api/auth/password` 再调 `PUT /api/auth/username`，两者都成功后回 `/`。
 *
 * 为什么是这个顺序：改完密码，账号就不再是「仍在使用初始凭据」，服务端那条例外（可以不填当前密码）
 * 随之失效；改用户名本身不需要口令。反过来先改名再改密，就会在中间状态卡住。
 *
 * ⚠️ 本页只在 `mustSetup` 为真时有意义：已设置过的账号进来会被送回 `/`；
 *    未登录会被送回登录页（`/setup.html` 不在免登录白名单里，静态闸门也会先拦一道）。
 * ⚠️ `BASE` 的算法与 `login.js` 逐字一致（按当前页面所在目录算），两个挂载点下都要成立。
 *
 * @author zx
 * @date   2026-10-27
 * @since 0.9.2
 * 相关：docs/公共/架构文档/04-多用户与账号.md
 */

(function () {
  /** 应用挂载前缀（无前缀时为空串）—— 与 `login.js` 同一算法 */
  const BASE = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');

  /**
   * 功能：把地址上的查询串带走（去掉 `view`）—— 回 `/` 时用，规则与 `login.js` 逐字一致。
   * @returns {string} 要拼在地址后面的查询串（含 `?`）；没有时为空串
   */
  function carrySearch() {
    const s = String(location.search || '');
    if (!s) return '';
    try {
      const usp = new URLSearchParams(s);
      usp.delete('view');
      const out = usp.toString();
      return out ? '?' + out : '';
    } catch (_e) {
      return s;
    }
  }

  /** 服务端给的口令下限；`state` 取不到时按 8 位兜底 */
  let minLen = 8;

  /**
   * 功能：在表单下方显示一行错误提示。
   * @param {string} msg - 要展示的中文文案
   * @returns {void}
   */
  function showError(msg) {
    const el = document.getElementById('err');
    el.textContent = msg;
    el.hidden = false;
  }

  /**
   * 功能：调一个 JSON 接口并归一化结果。
   * @param {string} method - HTTP 方法
   * @param {string} path - 以 `/api/` 开头的路径（不含挂载前缀）
   * @param {?Object} body - 请求体，null 表示不带体
   * @returns {Promise.<{ ok: boolean, status: number, data: ?Object }>} 归一化后的响应
   */
  async function api(method, path, body) {
    const opt = { method, headers: { Accept: 'application/json' } };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opt);
    let data = null;
    try {
      data = await res.json();
    } catch (_e) {
      /* 非 JSON 响应：下面按状态码兜底 */
    }
    return { ok: res.ok, status: res.status, data };
  }

  /**
   * 功能：进页先确认状态 —— 未登录去登录页，已设置过直接回首页，否则显示本表单。
   * @returns {Promise.<void>} 无返回值
   */
  async function boot() {
    try {
      const r = await api('GET', '/api/auth/state');
      const s = r.data || {};
      if (!s.authenticated) {
        location.replace(BASE + '/login.html' + carrySearch());
        return;
      }
      if (!s.mustSetup) {
        location.replace(BASE + '/' + carrySearch());
        return;
      }
      minLen = Number(s.minPasswordLength) || 8;
      document.getElementById('pwHint').textContent =
        `密码至少 ${minLen} 位；用户名可用中文、字母、数字、下划线、点、@ 或减号`;
      document.getElementById('username').focus();
    } catch (_e) {
      showError('网络异常，请刷新重试');
    }
  }

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('submit');
    const username = String(document.getElementById('username').value || '').trim();
    const p1 = String(document.getElementById('password').value || '');
    const p2 = String(document.getElementById('confirm').value || '');

    if (!username) return showError('请输入新用户名');
    if (username === 'admin') return showError('新用户名不能还是 admin');
    if (p1.length < minLen) return showError(`新密码至少 ${minLen} 位`);
    if (p1 !== p2) return showError('两次输入的密码不一致');

    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      // ① 先改密码：此时账号仍在用初始口令，服务端允许不填「当前密码」
      const r1 = await api('POST', '/api/auth/password', { next: p1 });
      if (!r1.ok) {
        showError((r1.data && r1.data.error) || `修改密码失败（${r1.status}）`);
        return;
      }
      // ② 再改用户名（服务端不要求口令）
      const r2 = await api('PUT', '/api/auth/username', { username });
      if (!r2.ok) {
        showError(
          ((r2.data && r2.data.error) || `修改用户名失败（${r2.status}）`) +
            ' —— 密码已经改好了，可以在「设置 → 账号设置」里再改用户名',
        );
        return;
      }
      location.replace(BASE + '/' + carrySearch());
    } catch (_e) {
      showError('网络异常，请重试');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存并进入';
    }
  });

  boot();
})();
