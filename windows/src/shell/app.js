/**
 * 壳的界面逻辑（原生 ESM，无框架、无构建）。
 *
 * 分工：**这里只管显示与转发** —— 一旦要「做决定」（连接 / 登录 / 证书 / 会话）就发给主进程。
 * 密码不落 localStorage、不写 console；表单值只在内存里。
 */

const api = window.zxdesk;

const el = {
  menubar: document.getElementById('menubar'),
  menuGroup: document.querySelector('.menu-group'),
  content: document.getElementById('content'),
  toast: document.getElementById('toast'),
  accessActions: document.getElementById('access-actions'),
  banner: document.getElementById('update-banner'),
  bannerText: document.getElementById('update-banner-text'),
  noticeBar: document.getElementById('notice-bar'),
  noticeBarText: document.getElementById('notice-bar-text'),
  menuError: document.getElementById('menu-error'),
  menuErrorText: document.getElementById('menu-error-text'),
};

let state = null;
let lastScreen = null;
/** 连接表单的本地副本（避免每次状态推送把用户正在敲的字冲掉）。 */
let form = null;
/** 两步验证的本地副本（验证码同理）。 */
let twofa = null;

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2200);
}

async function send(type, payload) {
  try {
    const result = await api.action(type, payload);
    if (result && result.ok === false) toast(result.error || '操作失败');
  } catch (e) {
    toast(`操作失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- 渲染

function render(next) {
  state = next;
  const screen = state.screen;
  const screenChanged = screen !== lastScreen;
  lastScreen = screen;

  // 本地副本只保「用户正在敲的字」；busy / progress / error / emailSent 这些**主进程说了算**，
  // 每次渲染都要合并回来 —— 否则「验证中…」「红字报错」永远不会显示（0.1.1 就是这样：点了没反应也没提示）。
  if (state.connect) {
    if (screenChanged || !form) {
      form = { ...state.connect };
    } else {
      form = {
        ...form,
        busy: state.connect.busy,
        progress: state.connect.progress,
        error: state.connect.error,
        hasSavedPassword: state.connect.hasSavedPassword,
        // ⚠️ 0.1.4 漏了这两项：「显示」点了没反应（type 不变），勾选也可能被旧值盖回去
        showPassword: state.connect.showPassword,
        rememberPassword: state.connect.rememberPassword,
        // 预填（退出登录 / 重开）由主进程给值；用户正在敲的优先，⛔ 不覆盖
        password: form.password || state.connect.password || '',
      };
    }
  }
  if (state.twofa) {
    const server = state.twofa;
    if (screenChanged || !twofa) {
      twofa = { ...server };
    } else {
      twofa = {
        ...twofa,
        maskedEmail: server.maskedEmail ?? twofa.maskedEmail,
        totpEnabled: server.totpEnabled ?? twofa.totpEnabled,
        emailEnabled: server.emailEnabled ?? twofa.emailEnabled,
        emailSent: server.emailSent ?? twofa.emailSent,
        resendLeft: server.resendLeft ?? twofa.resendLeft,
        busy: server.busy ?? twofa.busy,
        error: server.error ?? twofa.error,
        trustDevice: server.trustDevice ?? twofa.trustDevice,
        emailView: server.emailView ?? twofa.emailView,
      };
    }
  }

  const browsingLike = screen === 'browsing' || screen === 'access';
  el.menubar.hidden = !browsingLike;
  document.body.classList.toggle('no-toolbar', !browsingLike);
  document.body.className = document.body.className
    .split(' ')
    .filter((c) => !c.startsWith('screen-'))
    .concat(`screen-${screen}`)
    .join(' ');

  renderUpdateBanner(state.update);
  renderMenuError(state.browsing);
  renderNoticeBadge(state.notices);
  renderNoticeBar(state.notices);

  if (browsingLike) {
    // 远程视图盖在内容区上；访问码屏把文字菜单换成「返回 / 刷新 / 已输入完成」
    if (el.menuGroup) el.menuGroup.hidden = screen === 'access';
    if (el.accessActions) el.accessActions.hidden = screen !== 'access';
    el.content.className = 'content empty';
    el.content.innerHTML = '';
    if (state.panel) renderPanel();
    return;
  }

  el.content.className = 'content';
  if (screen === 'mode') el.content.innerHTML = viewMode();
  else if (screen === 'connect') el.content.innerHTML = viewConnect();
  else if (screen === 'twofa') el.content.innerHTML = viewTwofa();
  else if (screen === 'cert') el.content.innerHTML = viewCert();
  else el.content.innerHTML = viewConnect();
}

function viewMode() {
  const selected = state.mode === 'nas';
  return `
    <div class="wrap">
      <h1>选择数据源</h1>
      <p class="subtitle">一期只做「仅连接 NAS」；另外两种还在规划中。</p>
      ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}
      <div class="card selectable ${selected ? 'selected' : ''}" data-action="mode.select" data-mode="nas">
        <div>
          <p class="card-title">仅连接 NAS <span class="badge">可用</span></p>
          <p class="card-desc">数据放在你自己的 NAS 上，客户端只负责连接与浏览。</p>
        </div>
      </div>
      <div class="card selectable disabled" data-action="mode.select" data-mode="local">
        <div>
          <p class="card-title">仅本机 <span class="badge">规划中</span></p>
          <p class="card-desc">数据只存在这台电脑上。</p>
        </div>
      </div>
      <div class="card selectable disabled" data-action="mode.select" data-mode="hybrid">
        <div>
          <p class="card-title">混合 <span class="badge">规划中</span></p>
          <p class="card-desc">本机与 NAS 同时使用。</p>
        </div>
      </div>
      <button class="primary-btn" type="button" data-action="flow.next">下一步</button>
    </div>`;
}

function viewConnect() {
  const f = form;
  return `
    <div class="wrap">
      <button class="back-link" type="button" data-action="flow.back">‹ 返回</button>
      <h1>连接你的 NAS</h1>
      <p class="subtitle">局域网也要登录飞牛账号（网关会校验）；IP、域名或 FNID 都行。</p>
      ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}
      <label class="field">
        <span class="field-label">地址 / FNID</span>
        <input id="f-address" type="text" spellcheck="false" autocomplete="off"
               placeholder="10.1.2.3 或 my-nas" value="${esc(f.address)}" ${f.busy ? 'disabled' : ''} />
      </label>
      <label class="switch">
        <input id="f-https" type="checkbox" ${f.https ? 'checked' : ''} ${f.busy ? 'disabled' : ''} />
        HTTPS 安全访问
      </label>
      <p class="hint">只有显式填 <span class="mono">IP:8990</span>（或关掉 HTTPS）才直连，不需要飞牛账号。</p>
      <div class="divider"></div>
      <label class="field">
        <span class="field-label">飞牛账号</span>
        <input id="f-user" type="text" spellcheck="false" autocomplete="off" value="${esc(f.user)}" ${f.busy ? 'disabled' : ''} />
      </label>
      <label class="field">
        <span class="field-label">密码</span>
        <div class="row">
          <input id="f-password" type="${f.showPassword ? 'text' : 'password'}" autocomplete="off"
                 value="${esc(f.password)}" ${f.busy ? 'disabled' : ''} />
          <button class="link-btn" type="button" data-action="connect.togglePassword">${f.showPassword ? '隐藏' : '显示'}</button>
        </div>
      </label>
      <div class="row-between">
        <label class="check">
          <input id="f-remember" type="checkbox" ${f.rememberPassword ? 'checked' : ''} ${f.busy ? 'disabled' : ''} />
          记住密码
        </label>
        ${f.hasSavedPassword ? '<button class="link-btn" type="button" data-action="connect.clearSaved">清除</button>' : ''}
      </div>
      <button class="primary-btn" type="button" data-action="connect.submit" ${f.busy ? 'disabled' : ''}>
        ${f.busy ? '连接中…' : '连接'}
      </button>
      <!-- 登录失败：按钮下方一行红字（⛔ 不再整页跳错误页，表单和密码都留着） -->
      ${f.error ? `<p class="error-line" role="alert">${esc(f.error)}</p>` : ''}
      ${f.busy && f.progress ? `<div class="progress"><span class="spinner"></span>${esc(f.progress)}</div>` : ''}
    </div>`;
}

function viewTwofa() {
  const t = twofa;
  const emailView = t.emailView;
  return `
    <div class="wrap">
      <button class="back-link" type="button" data-action="flow.back">‹ 返回</button>
      <h1>两步验证</h1>
      <p class="subtitle">这个账号开了两步验证，再确认一次就能进。</p>
      ${t.error ? `<div class="error-card">${esc(t.error)}</div>` : ''}
      <div class="tabs">
        <button class="tab ${emailView ? '' : 'active'}" type="button" data-action="twofa.showTotp">验证器</button>
        <button class="tab ${emailView ? 'active' : ''}" type="button" data-action="twofa.showEmail">安全邮箱</button>
      </div>
      ${
        emailView
          ? `<label class="field">
               <span class="field-label">安全邮箱</span>
               <input id="f-email" type="email" autocomplete="off" placeholder="${esc(t.maskedEmail || '邮箱地址')}"
                      value="${esc(t.email)}" />
             </label>
             <label class="field">
               <span class="field-label">邮箱验证码（字母 + 数字）</span>
               <div class="row">
                 <input id="f-email-code" type="text" autocomplete="off" value="${esc(t.emailCode)}" />
                 <button class="ghost-btn" type="button" data-action="twofa.sendEmail" ${t.resendLeft > 0 || t.busy ? 'disabled' : ''}>
                   ${t.resendLeft > 0 ? `${t.resendLeft}s` : '发送验证码'}
                 </button>
               </div>
               <p class="hint">${t.emailSent ? '验证码已发送，请查收邮箱。' : '没收到可以再发一次，60 秒冷却。'}</p>
             </label>`
          : `<label class="field">
               <span class="field-label">验证器 6 位数字</span>
               <input id="f-totp" type="text" inputmode="numeric" autocomplete="off" maxlength="6"
                      placeholder="000000" value="${esc(t.totp)}" />
               <p class="hint">打开手机上的验证器应用，输入当前 6 位数字。</p>
             </label>`
      }
      <label class="check">
        <input id="f-trust" type="checkbox" ${t.trustDevice ? 'checked' : ''} />
        信任此设备（30 天免验证）
      </label>
      <button class="primary-btn" type="button" data-action="${emailView ? 'twofa.submitEmail' : 'twofa.submitTotp'}" ${t.busy ? 'disabled' : ''}>
        ${t.busy ? '验证中…' : '提交'}
      </button>
    </div>`;
}

function viewCert() {
  const c = state.cert || {};
  const rotated = Boolean(c.rotated);
  return `
    <div class="wrap-wide">
      <h1>${rotated ? '这台设备的证书变了' : '首次连接这台设备'}</h1>
      <p class="subtitle">
        ${
          rotated
            ? '证书指纹和上次不一样。如果你刚给 NAS 换过证书，这才正常；否则请先取消，确认是不是连错了设备。'
            : '这是 NAS 自己的证书（不是权威机构签发的）。确认指纹无误后再信任，之后会自动记住。'
        }
      </p>
      <div class="card">
        <dl class="dl">
          <dt>主机</dt><dd>${esc(c.host)}</dd>
          <dt>签发者</dt><dd>${esc(c.subject)}</dd>
          ${rotated ? `<dt>上次指纹</dt><dd class="mono">${formatFingerprint(c.previousSha256)}</dd>` : ''}
          <dt>${rotated ? '本次指纹' : 'SHA-256'}</dt><dd class="mono">${formatFingerprint(c.sha256)}</dd>
        </dl>
      </div>
      <div class="row">
        <button class="ghost-btn" type="button" data-action="cert.decide" data-trust="0">取消</button>
        <button class="primary-btn" style="margin:0" type="button" data-action="cert.decide" data-trust="1">
          ${rotated ? '确认这是新证书' : '信任这台设备'}
        </button>
      </div>
    </div>`;
}

/**
 * 更新提示条（只在连接页这类常规屏幕出现）。
 * 浏览模式没有提示条：那一屏的「有新版本」信号在「帮助 → 检查更新（有新版本）…」上。
 */
function renderUpdateBanner(update) {
  const showBanner = Boolean(update && update.banner);

  el.banner.hidden = !showBanner;
  document.body.classList.toggle('has-update-banner', showBanner);
  if (!showBanner) return;
  el.bannerText.textContent = `有新版本 ${update.latest}（当前 ${update.current}）`;
  const skip = el.banner.querySelector('[data-action="update.skip"]');
  if (skip) skip.hidden = Boolean(update.mustUpdate);
}

/**
 * 菜单栏上的错误提示（浏览 / 访问码屏）。
 *
 * 原来这类错误会整屏跳成「打不开页面」—— 一次网络抖动就把整窗刷白，还把正在做的事打断。
 * 现在只在这里出一条红字，菜单照常可用，点「重试」原页重载。
 */
function renderMenuError(browsing) {
  const message = String((browsing && browsing.error) || '');
  el.menuError.hidden = !message;
  if (!message) return;
  el.menuErrorText.textContent = message;
  el.menuError.title = message;
}

/**
 * 菜单栏公告条：紧跟「帮助」之后，显示**顶置公告**（服务端 `app_notice_marquee` 那一行）。
 *
 * 它不是「最新一条公告」——顶置公告是长期挂着的横幅（「0.2.3 已发布」这类），
 * 和公告列表/已读无关；列表在公告窗口里看。
 * 宽度**随内容**、有上限（CSS `max-width`），放不下就省略号 —— ⛔ 不做滚动字幕：
 * 菜单栏是静态导航区，动的字会一直抢注意力。悬停看全文，点开窗口看全部公告。
 */
function renderNoticeBar(notices) {
  const marquee = String(notices?.marquee || '').trim();
  el.noticeBar.hidden = !marquee;
  if (!marquee) return;
  el.noticeBarText.textContent = marquee;
  el.noticeBar.title = marquee;
}

/** 顶栏「帮助」按钮上的未读小点：公告在原生菜单里，壳这边只能提示「有东西」。 */
function renderNoticeBadge(notice) {
  const help = el.menuGroup?.querySelector('[data-menu="help"]');
  if (!help) return;
  const hasUnread = Boolean(notice && notice.hasUnread);
  help.classList.toggle('has-unread', hasUnread);
  help.setAttribute('aria-label', hasUnread ? '帮助（有未读公告）' : '帮助');
}

function renderPanel() {
  const p = state.panel;
  const b = state.browsing || {};
  el.content.className = 'content';
  el.content.innerHTML = `
    <div class="wrap">
      <h1>连接</h1>
      <p class="subtitle">当前这台 NAS 的连接信息。</p>
      <div class="card">
        <dl class="dl">
          <dt>主机</dt><dd>${esc(p.host)}</dd>
          <dt>链路</dt><dd><span class="badge">${esc(p.linkLabel || '-')}</span></dd>
          <dt>账号</dt><dd>${esc(p.account || '未登录（局域网直连）')}</dd>
        </dl>
        <div class="divider"></div>
        <div class="panel-actions">
          <button type="button" data-action="panel.refresh">刷新页面</button>
          <button type="button" data-action="panel.changeAddress">换个地址</button>
          <button type="button" class="danger" data-action="panel.logout">退出登录</button>
          <button type="button" data-action="panel.close">关闭</button>
        </div>
      </div>
      <p class="footer-version">ZXDesk ${esc(p.version)}</p>
    </div>`;
  void b;
}

function formatFingerprint(value) {
  const text = String(value || '').replace(/:/g, '');
  if (!text) return '-';
  return (text.match(/.{1,2}/g) || []).join(':').toUpperCase();
}

// ---------------------------------------------------------------- 事件

el.content.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  // 「连接」要带上表单里的值，交给下面那个专门的处理函数
  if (action === 'connect.submit') return;
  // ⚠️ 0.1.1 的 2FA「点了没反应」：验证码只存在壳的内存里，主进程拿到空串后静默 return。
  // 现在提交**从 DOM 直接读值**带上去（本地副本只用来防状态推送冲掉正在敲的字）。
  if (action === 'twofa.submitTotp') {
    const code = document.getElementById('f-totp')?.value ?? twofa?.totp ?? '';
    return send('twofa.submitTotp', { code });
  }
  if (action === 'twofa.submitEmail') {
    return send('twofa.submitEmail', {
      email: document.getElementById('f-email')?.value ?? twofa?.email ?? '',
      code: document.getElementById('f-email-code')?.value ?? twofa?.emailCode ?? '',
    });
  }
  if (action === 'twofa.sendEmail') {
    // 发码也要把当前邮箱带上：用户可能在 ① 邮箱页里刚改过
    const email = document.getElementById('f-email')?.value ?? twofa?.email ?? '';
    return send('twofa.sendEmail', { email });
  }
  if (action === 'mode.select') return send(action, { mode: target.dataset.mode });
  if (action === 'cert.decide') return send(action, { trust: target.dataset.trust === '1' });
  if (action === 'diag.copy') {
    const ok = await api.copyDiagnostics();
    return toast(ok ? '诊断信息已复制' : '复制失败');
  }
  return send(action, {});
});

el.content.addEventListener('input', (event) => {
  const id = event.target.id;
  const value = event.target.value;
  if (!form) return;
  if (id === 'f-address') form.address = value;
  else if (id === 'f-user') form.user = value;
  else if (id === 'f-password') form.password = value;
  else if (id === 'f-https') form.https = event.target.checked;
  else if (id === 'f-remember') {
    // ⚠️ 先写回本地副本再上报：否则提交时 { ...form } 会把旧的 rememberPassword 盖回去（勾了等于没勾）
    form.rememberPassword = event.target.checked;
    return send('connect.remember', { value: event.target.checked });
  }

  if (twofa) {
    if (id === 'f-totp') twofa.totp = value.replace(/\D/g, '').slice(0, 6);
    else if (id === 'f-email') twofa.email = value;
    else if (id === 'f-email-code') twofa.emailCode = value.trim();
    else if (id === 'f-trust') return send('twofa.trust', { value: event.target.checked });
  }
});

el.content.addEventListener('change', (event) => {
  const id = event.target.id;
  if (id === 'f-https' && form) {
    form.https = event.target.checked;
  }
  if (id === 'f-remember') return send('connect.remember', { value: event.target.checked });
  if (id === 'f-trust' && twofa) return send('twofa.trust', { value: event.target.checked });
  return null;
});

// 连接按钮：把本地表单（含用户刚敲的字）一起交上去
el.content.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action="connect.submit"]');
  if (!target || !form) return;
  send('connect.submit', { ...form });
});

// 更新提示条：壳自己只有「查看 / 以后再说」两个动作，判定都在主进程
el.banner.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  send(target.dataset.action, {});
});

el.menubar.addEventListener('click', (event) => {
  const menu = event.target.closest('[data-menu]');
  if (menu) {
    // 交给主进程弹原生菜单（连接 / 视图 / 帮助），壳自己不实现菜单逻辑
    api.openMenu(menu.dataset.menu).catch((e) => toast(`菜单打不开：${e.message}`));
    return;
  }
  const action = event.target.closest('[data-action]');
  if (action) send(action.dataset.action, {});
});

// 快捷键：F5 / Ctrl+R 刷新、Alt+←/→ 后退前进 —— 只在浏览模式生效，且不让壳自己刷新
window.addEventListener('keydown', (event) => {
  const browsing = state && (state.screen === 'browsing' || state.screen === 'access');
  if (!browsing) return;
  if (event.key === 'F5' || (event.ctrlKey && event.key.toLowerCase() === 'r')) {
    event.preventDefault();
    send('toolbar.reload', {});
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    send('toolbar.back', {});
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    send('toolbar.forward', {});
  }
});

// ---------------------------------------------------------------- 启动

api.onState((next) => render(next));
api
  .getState()
  .then((initial) => {
    if (initial) render(initial);
  })
  .catch((e) => {
    el.content.innerHTML = `<div class="wrap"><div class="error-card">界面初始化失败：${esc(e.message)}</div></div>`;
  });
