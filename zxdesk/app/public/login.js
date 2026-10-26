'use strict';
/**
 * login.js —— 登录 / 首次注册页（电脑与触屏**共用同一页**）
 *
 * 功能：登录页的全部交互 —— 查 `/api/auth/state` 决定进登录还是注册形态、在两个形态间切换、
 *      提交表单（注册成功续上登录）并在成功后回 `/`，以及错误提示与提交期间的按钮禁用。
 *
 * ⚠️ 为什么这里**不做**手机版 / 电脑版分流（与 index.html 的引导脚本不同）：
 *   登录成功后必然跳 `/`，而 `/` 的引导脚本本来就会把手机送去 `/mobile/` ——
 *   所以本页不需要第二份设备判定，少一份副本就少一处漂移。
 *   窄屏可用性靠 login.css 解决（16px 输入框防 iOS 聚焦缩放、44px 触摸目标、安全区留白）。
 *
 * 页面形态由 `/api/auth/state` 决定：
 *   - 库里已有账号（**正常情况**：启动时已内置管理员 `admin`）→ 登录；管理员开着自主注册时额外给一个「注册一个」入口
 *   - 库里连一个账号都没有（极端情况：只读降级导致内置管理员没建成）→ 直接进注册形态，至少让人能进门
 *   - 已登录 → 直接回 `/`
 *
 * ⚠️ 自己注册出来的一律是**普通成员**；管理员是出厂内置的 `admin`（见 server.js 的 ensureBuiltinAdmin）。
 *
 * ⭐ **`BASE`：本页被挂在哪个路径下**（0.3.5 统一网关改造）——
 *    飞牛统一网关把应用挂在系统域名的 `/app/zxdesk` 下，接口地址必须带这层前缀，
 *    否则登录请求会打到飞牛自己的站点根（表现为「网络异常，请重试」）。
 *    ⚠️ 本页是**经典脚本**（刻意不用 ESM，见），拿不到 `core/api.js` 的 `BASE`，
 *      所以在这里就地按「当前页面所在目录」算：`/login.html` → `''`；`/app/zxdesk/login.html` → `/app/zxdesk`。
 *      **两个算法必须给出同一个值** —— 登录页永远在应用根，这一条成立。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.8.34
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、docs/公共/开发方案/07-统一网关入口.md
 */

(function () {
  /** 应用挂载前缀（无前缀时为空串）—— 见文件头说明 */
  const BASE = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  /**
   * 功能：把地址上的查询串带走（去掉 `view`）—— 登录成功回 `/` 时用。
   *
   * 说明：⭐⭐ 2026-10-19（「手机端访问要输入访问码…只有中转模式下会这样」）：
   *      飞牛网关会在入口地址上带它自己的票据 / 标记（走 FN Connect 中继时尤其明显）。
   *      整页跳转时**把 `location.search` 丢掉** = 网关认为这一趟没带凭证 ⇒ 又弹出访问码页
   *      （用户看到的就是「输入对了还回到输入界面」）。
   *      本页与两个 `index.html` 里的 `carrySearch()` 是**同一套规则**（只摘掉我们自己的 `view`），
   *      ⛔ 别只改一处：任何一处漏掉都会让那一跳把票据甩掉。
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
      return s; // 解析失败时原样带过去 —— 宁可多带，不可丢票据
    }
  }
  /**
   * 功能：按 id 取元素，是 `document.getElementById` 的简写。
   * @param {string} id - 元素 id
   * @returns {?HTMLElement} 命中的元素；没有则为 null
   */
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const sub = $('sub');
  const err = $('err');
  const pwHint = $('pwHint');
  const switchEl = $('switch');
  const submit = $('submit');
  const usernameEl = $('username');
  const passwordEl = $('password');

  let mode = 'login'; // 'login' | 'register'
  let minLen = 6;
  let allowSelfRegister = true;
  let hasUsers = true;

  /**
   * 功能：显示或清除表单下方的错误提示。
   * @param {string} msg - 错误文案；空值表示清除提示并隐藏该行
   * @returns {void}
   */
  function showError(msg) {
    err.textContent = msg || '';
    err.hidden = !msg;
  }

  /**
   * 功能：造一个「看起来像链接」的 `<a>`，点击时执行回调而不跳转。
   * @param {string} text - 链接文案
   * @param {Function} onclick - 点击回调；已在内部 `preventDefault()`
   * @returns {HTMLAnchorElement} 建好的链接元素
   */
  function makeLink(text, onclick) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onclick();
    });
    return a;
  }

  /**
   * 功能：重设辅助入口区 —— 把给定内容依次放进去；传空数组则整块隐藏。
   * @param {Array.<(string|HTMLElement)>} parts - 要展示的内容（纯字符串会被当成文本节点）
   * @returns {void}
   */
  function setSwitch(parts) {
    switchEl.textContent = '';
    if (!parts.length) {
      switchEl.hidden = true;
      return;
    }
    switchEl.hidden = false;
    parts.forEach((p) => switchEl.append(p));
  }

  /**
   * 功能：按当前 `mode` 刷新表单形态 —— 按钮文案、密码自动填充提示、密码长度提示与辅助入口。
   * 说明：库里一个账号都没有时（首个账号必须建出来）不给任何切换入口。
   * @returns {void}
   */
  function applyMode() {
    const registering = mode === 'register';
    submit.textContent = registering ? '创建账号' : '登录';
    passwordEl.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    pwHint.hidden = !registering;
    pwHint.textContent = `密码至少 ${minLen} 位`;

    if (registering) {
      // 首个账号必须建出来，没得切
      if (!hasUsers) return setSwitch([]);
      return setSwitch(['已有账号？', makeLink('去登录', () => ((mode = 'login'), applyMode()))]);
    }
    if (!hasUsers) return setSwitch([]);
    if (allowSelfRegister) {
      return setSwitch(['还没有账号？', makeLink('注册一个', () => ((mode = 'register'), applyMode()))]);
    }
    return setSwitch(['管理员已关闭自主注册，请向管理员申请账号']);
  }

  /**
   * 功能：向指定接口 POST 一段 JSON，并把响应归一化成 `{ ok, status, data }`。
   * 说明：响应体不是 JSON 时 `data` 保持 null，由调用方按状态码兜底。
   * @param {string} path - 接口路径，如 '/api/auth/login'
   * @param {Object} body - 请求体，会被 `JSON.stringify` 序列化
   * @returns {Promise.<{ ok: boolean, status: number, data: ?Object }>} 归一化后的响应
   */
  async function post(path, body) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_e) {
      /* 非 JSON 响应（理论上不该发生）→ data 保持 null，下面按状态码兜底 */
    }
    return { ok: res.ok, status: res.status, data };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    submit.disabled = true;
    try {
      const username = usernameEl.value.trim();
      const password = passwordEl.value;

      if (mode === 'register') {
        const r = await post('/api/auth/register', { username, password });
        if (!r.ok) {
          showError((r.data && r.data.error) || `注册失败（${r.status}）`);
          return;
        }
        // 注册成功直接续上登录，省掉再输一遍
      }

      const l = await post('/api/auth/login', { username, password });
      if (!l.ok) {
        showError((l.data && l.data.error) || `登录失败（${l.status}）`);
        return;
      }
      // ⚠️ 带上查询串（见 `carrySearch()`）—— 丢掉它会被飞牛网关重新弹访问码
      window.location.replace(BASE + '/' + carrySearch());
    } catch (_e) {
      showError('网络异常，请重试');
    } finally {
      submit.disabled = false;
    }
  });

  /**
   * 功能：页面初始化 —— 查会话状态；已登录直接回 `/`，否则按库里有无账号决定登录 / 注册形态并显示表单。
   * @returns {Promise.<void>}
   */
  (async function init() {
    try {
      const res = await fetch(BASE + '/api/auth/state');
      const s = await res.json();
      if (s && s.authenticated) {
        // ⚠️ 同上：带查询串
        window.location.replace(BASE + '/' + carrySearch());
        return;
      }
      hasUsers = !!(s && s.hasUsers);
      allowSelfRegister = !(s && s.allowSelfRegister === false);
      minLen = Number(s && s.minPasswordLength) || 6;
      // 正常情况（库里已有内置管理员）就是登录形态；只在「连账号都没有」的极端情况下给注册形态
      mode = hasUsers ? 'login' : 'register';
      sub.textContent = hasUsers ? '登录后继续' : '先创建一个账号';
      form.hidden = false;
      applyMode();
      usernameEl.focus();
    } catch (_e) {
      sub.textContent = '无法连接服务，请刷新重试';
    }
  })();
})();
