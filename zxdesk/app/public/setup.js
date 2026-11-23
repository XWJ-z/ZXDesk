'use strict';
/**
 * setup.js —— 首次登录的强制设置页（改密码，用户名可选）
 * 功能：查 `/api/auth/state` 确认「当前账号仍在使用公开初始口令」，收到新密码（用户名可改可不改），
 * 先调 `POST /api/auth/password`，名字真的改了再调 `PUT /api/auth/username`，然后回 `/`。
 * @author zx
 * @date   2026-10-27
 * @since 0.9.7
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

  /** 当前登录名（默认填进输入框；提交时用它判断「名字到底改没改」） */
  let currentUsername = '';

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
      // 用户名框**默认填当前用户名**（出厂就是 admin）：不改就直接提交，改了才发改名请求。
      currentUsername = String((s.user && s.user.username) || '');
      const nameInp = document.getElementById('username');
      if (currentUsername) nameInp.value = currentUsername;
      document.getElementById('pwHint').textContent =
        `密码至少 ${minLen} 位；用户名可用中文、字母、数字、下划线、点、@ 或减号`;
      // 名字已经填好，光标落在密码上 —— 这一页真正要填的就是它
      document.getElementById('password').focus();
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

    if (!username) return showError('请输入用户名');
    if (p1.length < minLen) return showError(`新密码至少 ${minLen} 位`);
    if (p1 !== p2) return showError('两次输入的密码不一致');

    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      // ① 先改密码：此时账号仍在用初始口令，服务端允许不填「当前密码」
      const r1 = await api('POST', '/api/auth/password', { next: p1 });
      if (!r1.ok) {
        const msg = (r1.data && r1.data.error) || `修改密码失败（${r1.status}）`;
        // 走到这里通常说明「口令其实早就改过了」—— 本页只该拦住仍用初始口令的账号，
        // 但万一有残余状态，必须给一条出路；⛔ 不能只丢一句「当前密码不正确」让人在这里反复重试。
        const extra = /当前密码/.test(msg)
          ? ' 如果密码已经改过，请回登录页用新密码登录；也可以在「设置 → 账号设置」里改密码。'
          : '';
        showError(msg + extra);
        return;
      }
      // ② 再改用户名 —— **只有真的改了才发**：名字保持 admin 是允许的，闸门只看口令
      if (username !== currentUsername) {
        const r2 = await api('PUT', '/api/auth/username', { username });
        if (!r2.ok) {
          showError(
            ((r2.data && r2.data.error) || `修改用户名失败（${r2.status}）`) +
              ' —— 密码已经改好了，可以在「设置 → 账号设置」里再改用户名',
          );
          return;
        }
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
