'use strict';
/**
 * login.js —— 登录 / 首次注册页（电脑与触屏**共用同一页**）
 * 功能：登录页的全部交互 —— 查 `/api/auth/state` 决定进登录还是注册形态、在两个形态间切换、
 * 提交表单（注册成功续上登录）并在成功后回 `/`，以及错误提示与提交期间的按钮禁用。
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、docs/公共/开发方案/07-统一网关入口.md
 */

(function () {
  /** 应用挂载前缀（无前缀时为空串）—— 见文件头说明 */
  const BASE = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  /**
   * 功能：把地址上的查询串带走（去掉 `view`）—— 登录成功回 `/` 时用。
   *
   * 飞牛网关会在入口地址上带它自己的票据 / 标记（走 FN Connect 中继时尤其明显）。
   * 整页跳转时**把 `location.search` 丢掉** = 网关认为这一趟没带凭证 ⇒ 又弹出访问码页
   * （用户看到的就是「输入对了还回到输入界面」）。
   */
  function carrySearch() {
    const s = String(location.search || '');
    if (!s) return '';
    try {
      const usp = new URLSearchParams(s);
      // `view=desktop` 要带到下一屏（见 index.html 里同一处说明）；
      // `view=mobile` 仍是临时预览，丢掉。
      if (usp.get('view') !== 'desktop') usp.delete('view');
      const out = usp.toString();
      return out ? '?' + out : '';
    } catch (_e) {
      return s; // 解析失败时原样带过去 —— 宁可多带，不可丢票据
    }
  }
  /**
   * 功能：读登录闸门带过来的 `next`（登录成功后该回哪儿）—— **不合法一律当没有**。
   *
   * `/login.html?next=<应用内相对地址>`，这样「从文件管理器双击 `.zxdesk`」的人
   * 登录完能回到**同一个文件**，而不是掉在工作台首页。
   * 这里是一道**安全闸**（开放重定向）：只接受 `/` 开头、且**不能**是 `//`、
   */
  function nextTarget() {
    try {
      const n = String(new URLSearchParams(location.search).get('next') || '');
      if (!n || n.charAt(0) !== '/') return '';
      if (n.startsWith('//') || n.charAt(1) === '\\') return '';
      const only = n.split('?')[0];
      if (only === '/login.html' || only === '/setup.html') return '';
      return n;
    } catch (_e) {
      return '';
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
  const aux = $('aux');
  const altBtn = $('alt');
  const auxNote = $('auxNote');
  const forgot = $('forgot');
  const resetModal = $('resetModal');
  const resetClose = $('resetClose');
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
   * 功能：重设表单下方的两颗次级按钮与它们下面那行说明。
   *
   * 版式：一左一右并排（`login.css` 的 `.aux` 是两列网格）—— 左边那颗是「换形态」（新用户注册／返回登录），
   * 右边那颗固定是「忘记密码」。左按钮传空串时整颗不出现（管理员关了自主注册），
   * @param {string} altLabel - 左边按钮的文案；空串表示这颗不出现
   */
  function setAux(altLabel, note) {
    altBtn.textContent = altLabel || '';
    altBtn.hidden = !altLabel;
    aux.classList.toggle('one', !altLabel);
    auxNote.textContent = note || '';
    auxNote.hidden = !note;
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

    // 库里连一个账号都没有时（注册形态）谈不上「忘记密码」，整块不出现
    aux.hidden = !hasUsers;
    if (!hasUsers) {
      closeReset(true);
      return setAux('');
    }

    if (registering) {
      // 注册形态下左按钮反过来用于回登录页
      return setAux('返回登录');
    }
    if (allowSelfRegister) {
      return setAux('新用户注册');
    }
    return setAux('', '管理员已关闭自主注册，请向管理员申请账号');
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

  /**
   *
   * 弹窗里**只有说明文字**，没有任何在线重置通道 —— 忘记密码只能由人在 NAS 本机上
   */
  function openReset() {
    resetModal.hidden = false;
    document.body.style.overflow = 'hidden';
    resetClose.focus();
  }

  /**
   * 功能：关闭「重置密码」弹窗。
   * @param {boolean} [silent] - 为真时不把焦点还回触发按钮（整块被隐藏时还焦点会落到不可见元素上）
   * @returns {void}
   */
  function closeReset(silent) {
    if (resetModal.hidden) return;
    resetModal.hidden = true;
    document.body.style.overflow = '';
    if (!silent) forgot.focus();
  }

  forgot.addEventListener('click', openReset);

  // 左按钮：登录形态 →「新用户注册」；注册形态 →「返回登录」。文案由 applyMode 定，动作只认当前 mode
  altBtn.addEventListener('click', () => {
    mode = mode === 'register' ? 'login' : 'register';
    applyMode();
  });

  // 遮罩与「知道了」带 data-close，右上角那个 × 单独判 —— 三种关法都走同一个出口
  resetModal.addEventListener('click', (e) => {
    if (e.target === resetClose || e.target.hasAttribute('data-close')) closeReset();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeReset();
  });

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
      // 首登强制：内置管理员还在用公开初始口令 ⇒ 先去设置页，改完才能进主界面
      if (l.data && l.data.mustSetup) {
        window.location.replace(BASE + '/setup.html' + carrySearch());
        return;
      }
      // 登录成功就把离线快照清掉 —— 这台设备可能换了账号，上一个账号的
      // 只读缓存（任务 / 记账 / 密码库条目）不能在断网时被下一个人看到。
      // 键前缀与 `core/cache.js` 的 PREFIX 必须一致（登录页是经典脚本，没法 import）。
      try {
        const stale = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.indexOf('zxdesk.cache.v1:') === 0) stale.push(k);
        }
        stale.forEach(k => localStorage.removeItem(k));
        // ⚠️ 草稿（`zxdesk.draft.v1:`）**不在这里清**：`core/draft.js` 的键带了账号 id 前缀，
        //    换人登录本来就看不到上一个人的半截字；在这里无差别清掉，会把**本账号**刚打完的
        //    草稿也一起删了（会话过期重登时尤其致命）。过期与条数由那两处上限兜底。
      } catch (_e) {
        /* 存储不可用：本来也没有缓存 */
      }
      // 带上查询串（见 `carrySearch()`）—— 丢掉它会被飞牛网关重新弹访问码
      const next = nextTarget();
      window.location.replace(next ? BASE + next : BASE + '/' + carrySearch());
    } catch (_e) {
      showError('网络异常，请重试');
    } finally {
      submit.disabled = false;
    }
  });

  /**
   * @returns {Promise.<void>}
   */
  (async function init() {
    try {
      const res = await fetch(BASE + '/api/auth/state');
      const s = await res.json();
      if (s && s.authenticated) {
        // 首登强制：账号还在用公开初始口令 ⇒ 先去设置页
        const next = nextTarget();
        window.location.replace(
          s.mustSetup ? BASE + '/setup.html' + carrySearch() : next ? BASE + next : BASE + '/' + carrySearch(),
        );
        return;
      }
      hasUsers = !!(s && s.hasUsers);
      allowSelfRegister = !!(s && s.allowSelfRegister);
      minLen = Number(s && s.minPasswordLength) || 8;
      // 正常情况（库里已有内置管理员）就是登录形态；只在「连账号都没有」的极端情况下给注册形态
      mode = hasUsers ? 'login' : 'register';
      sub.textContent = hasUsers ? '登录后继续' : '先创建一个账号';
      form.hidden = false;
      applyMode();
      // 页脚三行（出厂账号 / 改密码提醒 / 多用户说明）恒显示，这里**不再有开关** ——
      // 它服务的对象就是第一次进来的人，「库里有没有账号」不该是它的显隐条件。
      usernameEl.focus();
    } catch (_e) {
      sub.textContent = '无法连接服务，请刷新重试';
    }
  })();
})();
