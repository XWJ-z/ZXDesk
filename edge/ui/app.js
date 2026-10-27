/**
 * 0.1.4 app.js —— ⭐ 弹窗与侧边栏的**唯一**内容视图（任务单 §四：同一份内容、两种外壳）。
 *
 * 两个壳（popup.js / sidepanel.js）只做三件事：设 data-host、调 mountApp(root, host)、定高度。
 * 本文件里 ⛔ 出现 `host === 'popup'` 以外的宿主分支；全部差异（§4.2 表）：
 *   表单默认展开+预填（popup）↔ 折叠（侧边栏）；列表 20 条+看全部（popup）↔ 全量（侧边栏）；
 *   收藏成功自动关（popup）↔ 不关（侧边栏）。
 *
 * 连接：`authorizeAndConnect`（conn-ui）在手势内授权并连接；手势丢失/用户拒绝回
 * `need_settings`，这里切到内嵌的设置视图（0.1.4 起：设置不再是整页标签）。
 */
import { LINK_LABEL } from '../lib/address.js';
import { MSG, BM_TEXT, UI_TEXT, VAULT_TEXT, UPDATE_TEXT, EULA_UI, errText, statusText } from '../lib/messages.js';
import { send, connectFlow, authorizeAndConnect, pollWhile } from './conn-ui.js';
import { createEulaPanel, isEulaAccepted } from './eula-view.js';

/** el helper */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch (_e) {
    return u || '';
  }
};

export async function mountApp(root, host) {
  const isPopup = host === 'popup';
  let stopPoll = null;
  let lastInput = '';

  // ================= 0.1.6：许可协议门槛（首次启动 / 协议改版后） =================
  // ⚠️ 先判后挂：未同意前既不建视图也不发任何请求（连接与版本检测都在后面）。
  if (!(await isEulaAccepted())) {
    createEulaPanel(root, { mode: 'gate', onAccept: () => location.reload() });
    return;
  }

  // ================= 0.1.6：新版本气泡（启动时检测，结果由 SW 读给了这里） =================
  const bubble = el('div', 'update-bubble');
  bubble.hidden = true;
  bubble.setAttribute('role', 'status');
  const ubText = el('div', 'ub-text');
  const ubTitle = el('p', 'ub-title');
  const ubSub = el('p', 'ub-sub');
  ubText.append(ubTitle, ubSub);
  const ubGo = el('button', 'ub-go', UPDATE_TEXT.go);
  ubGo.type = 'button';
  ubGo.title = UPDATE_TEXT.goTitle;
  const ubX = el('button', 'ub-x', '✕');
  ubX.type = 'button';
  ubX.title = UPDATE_TEXT.close;
  ubX.setAttribute('aria-label', UPDATE_TEXT.close);
  bubble.append(ubText, ubGo, ubX);
  root.appendChild(bubble);
  let updateShown = null; // 当前气泡对应的那条检测结果（点「去下载」用它）

  ubGo.addEventListener('click', () => {
    if (updateShown) chrome.tabs.create({ url: updateShown.url });
  });
  ubX.addEventListener('click', () => {
    bubble.hidden = true;
    if (updateShown) send(MSG.updateDismiss, { version: updateShown.latest }).catch(() => {});
  });

  /** 功能：取一次「要不要提示」的结论；没有新版/查不到就保持隐藏（⛔ 不占位、不报错）。 */
  async function loadUpdate() {
    let r;
    try {
      r = await send(MSG.updateInfo);
    } catch (_e) {
      return; // SW 不可达 ⇒ 不提示，下次启动再试
    }
    if (!r || !r.ok || !r.update) return;
    updateShown = r.update;
    ubTitle.textContent = UPDATE_TEXT.title(r.update.latest);
    ubSub.textContent = UPDATE_TEXT.sub(r.update.current, r.update.code);
    bubble.hidden = false;
    send(MSG.updateSeen).catch(() => {}); // 看到了 ⇒ 撤角标
  }

  // ================= 连接条（已连接才出现） =================
  const bar = el('header', 'bar');
  bar.hidden = true;
  const dot = el('span', 'dot');
  const barHost = el('span', 'bar-host', '—');
  const barLink = el('span', 'badge');
  barLink.hidden = true;
  const btnRefresh = el('button', 'icon-btn', '⟳');
  btnRefresh.type = 'button';
  btnRefresh.title = BM_TEXT.mRefresh;
  const menu = document.createElement('details');
  menu.className = 'pop-anchor';
  const menuSum = el('summary', 'more-btn', UI_TEXT.mMore); // 0.1.4：⋮ 改「更多」
  menuSum.title = '连接管理';
  const menuPop = el('div', 'menu-pop');
  const mReaddress = el('button', null, BM_TEXT.mReaddress);
  const mSettings = el('button', null, UI_TEXT.mSettings);
  const mDisconnect = el('button', 'danger', BM_TEXT.mDisconnect);
  menuPop.append(mReaddress, mSettings, el('div', 'menu-sep'), mDisconnect);
  menu.append(menuSum, menuPop);
  bar.append(dot, barHost, barLink, btnRefresh, menu);
  root.appendChild(bar);

  // ================= 连接卡 / 连接中 / 登录等待 =================
  const cardConnect = el('section', 'card connect-card');
  cardConnect.hidden = true;
  const h1c = el('h1', null, '连接你的 ZXDesk');
  const addr = el('input');
  addr.id = 'addr';
  addr.placeholder = 'FNID、IP、域名或完整地址';
  addr.autocomplete = 'off';
  addr.spellcheck = false;
  const btnConnect = el('button', 'primary', '连接');
  btnConnect.id = 'btn-connect';
  const connectErr = el('p', 'hint bad', '');
  connectErr.id = 'connect-err';
  connectErr.hidden = true;
  cardConnect.append(h1c, addr, btnConnect, connectErr);
  if (isPopup) {
    const tip = el('p', 'hint', '也可以在 ZXDesk 页面点一次图标自动识别地址');
    cardConnect.appendChild(tip);
  }

  const cardResolving = el('section', 'card connect-card');
  cardResolving.hidden = true;
  const resolvingTarget = el('p', 'hint', '');
  cardResolving.append(el('h1', null, '正在连接…'), resolvingTarget);

  const cardLogin = el('section', 'card connect-card');
  cardLogin.hidden = true;
  const btnReopen = el('button', null, '重新打开登录页');
  const btnCancelLogin = el('button', null, '取消');
  cardLogin.append(
    el('h1', null, '还差一步'),
    el('p', 'hint', '在打开的页面完成登录，这里会自动连上。'),
    (() => {
      const r = el('div', 'row');
      r.append(btnReopen, btnCancelLogin);
      return r;
    })()
  );

  // ================= 已连接主体 =================
  const cardMain = el('section', 'main-view');
  cardMain.hidden = true;

  // ---- 0.1.5 E3：密码库只读弹层 —— 明文的**唯一**去处；关闭即从 DOM 与内存里清掉 ----
  const vaultMask = el('div', 'vault-mask');
  vaultMask.hidden = true;
  const vaultCard = el('div', 'vault-card');
  vaultCard.setAttribute('role', 'dialog');
  vaultCard.setAttribute('aria-modal', 'true');
  vaultMask.appendChild(vaultCard);
  vaultMask.addEventListener('click', (e) => {
    if (e.target === vaultMask) closeVault(); // 点遮罩关闭
  });

  // ---- 收藏表单（popup 常开预填 / 侧边栏折叠） ----
  const formWrap = el('div', 'bm-form');
  let formOpen = isPopup; // 差异 1：popup 默认展开
  const btnFormToggle = el('button', 'add-toggle');
  btnFormToggle.type = 'button';
  const form = el('div', 'panel');
  const inTitle = el('input', 'f-title');
  inTitle.autocomplete = 'off';
  const inUrl = el('input', 'f-url');
  inUrl.autocomplete = 'off';
  inUrl.spellcheck = false;
  inUrl.tabIndex = -1; // 0.1.3 口径：Tab 跳过网址（鼠标可改），保证三次内到收藏
  const picks = el('div', 'picks');
  const tagSel = el('select');
  tagSel.setAttribute('aria-label', '从已有标签里选一个');
  const inNewTag = el('input');
  inNewTag.placeholder = '写一个新标签';
  inNewTag.autocomplete = 'off';
  const btnAddTag = el('button', 'btn-subtle', '＋ 新增');
  btnAddTag.type = 'button';
  const tagAdd = el('div', 'tag-add');
  tagAdd.append(tagSel, inNewTag, btnAddTag);
  const btnSave = el('button', 'primary grow', BM_TEXT.save);
  btnSave.type = 'button';
  const btnOpenPanel = el('button', 'ghost', '打开侧边栏');
  const saveRow = el('div', 'row');
  saveRow.append(btnSave, btnOpenPanel);
  const formMsg = el('p', 'hint');
  formMsg.hidden = true;
  let submitBtn = btnSave; // 提交钮：popup=收藏 / 侧边栏=添加（分支里重指）
  form.append(
    (() => {
      const f = el('div', 'field');
      f.append(el('span', 'flabel', '标题'), inTitle);
      return f;
    })(),
    (() => {
      const f = el('div', 'field');
      f.append(el('span', 'flabel', '网址'), inUrl);
      return f;
    })(),
    el('p', 'flabel-line', '标签'),
    picks,
    tagAdd
  );
  if (isPopup) {
    form.append(el('hr', 'sep'), saveRow); // 差异 2：popup 表单带主按钮
  } else {
    // 侧边栏折叠表单：添加 / 取消（§4.2——折叠入口展开后要有提交钮）
    const btnAdd = el('button', 'primary', BM_TEXT.addSave);
    const btnCancelForm = el('button', null, BM_TEXT.btnCancel);
    const addRow = el('div', 'row');
    addRow.append(btnAdd, btnCancelForm);
    form.append(addRow);
    btnAdd.addEventListener('click', () => submitBookmark());
    btnCancelForm.addEventListener('click', () => setFormOpen(false));
    submitBtn = btnAdd;
  }
  form.appendChild(formMsg);
  formWrap.append(btnFormToggle, form);
  cardMain.appendChild(formWrap);

  // ---- 列表区（共用；搜索栏只侧边栏） ----
  let listBar = null;
  let inQ = null;
  let selTag = null;
  if (!isPopup) {
    listBar = el('div', 'row list-bar');
    inQ = el('input');
    inQ.placeholder = BM_TEXT.searchPh;
    inQ.autocomplete = 'off';
    selTag = el('select');
    const o = el('option');
    o.value = '';
    o.textContent = BM_TEXT.allTags;
    selTag.appendChild(o);
    listBar.append(inQ, selTag);
    cardMain.appendChild(listBar);
  }
  const listHint = el('p', 'hint');
  listHint.hidden = true;
  const listTotal = el('p', 'total');
  listTotal.hidden = true;
  const skel = el('div');
  skel.hidden = true;
  for (let i = 0; i < 3; i++) skel.appendChild(el('div', 'skel-row'));
  const listNote = el('p', 'hint state');
  listNote.hidden = true;
  const btnRetry = el('button', 'primary', BM_TEXT.btnRetry);
  btnRetry.hidden = true;
  const ul = el('ul', 'list');
  const listCard = el('div', 'card');
  listCard.append(skel, listNote, btnRetry, ul);
  // 0.1.4（弹窗）：外框固定，只有条目区自己滚 —— 列表块整体包进 .list-scroll
  const listScroll = el('div', 'list-scroll');
  listScroll.append(listHint, listTotal, listCard);
  cardMain.appendChild(listScroll);

  let btnViewAll = null;
  if (isPopup) {
    btnViewAll = el('button', 'ghost view-all', UI_TEXT.viewAllInPanel);
    listScroll.appendChild(btnViewAll); // 差异 3：popup 列表尾「在侧边栏看全部」（随条目区滚）
  }

  // ================= 设置视图（0.1.4：嵌进 popup/侧边栏，不开整页） =================
  const cardSettings = el('section', 'settings');
  cardSettings.hidden = true;
  const sBack = el('button', 'icon-btn back-btn', '←');
  sBack.type = 'button';
  sBack.title = UI_TEXT.sBack;
  sBack.setAttribute('aria-label', UI_TEXT.sBack); // 0.1.5 E1：图标按钮必须有可读名
  const sHead = el('div', 's-head'); // ⭐ 0.1.5 E1：⛔ 不再借用 .row（那条 `flex:1` 会把箭头撑成整行长条）
  const sH1 = el('h1', null, UI_TEXT.setTitle);
  sHead.append(sBack, sH1, el('span', 's-head-pad')); // 右侧对称留白（32px 列）

  // -- 连接组 --
  const sAddr = el('input');
  sAddr.placeholder = 'FNID、IP、域名或完整地址';
  sAddr.autocomplete = 'off';
  sAddr.spellcheck = false;
  const sDot = el('span', 'dot');
  const sHost = el('span', 's-host', '—');
  const sLink = el('span', 'badge');
  sLink.hidden = true;
  const sState = el('p', 's-conn');
  sState.append(sDot, sHost, sLink);
  const sUser = el('p', 'hint');
  sUser.hidden = true;
  const sConnect = el('button', 'primary', UI_TEXT.authConnect);
  sConnect.type = 'button';
  const sDisconnect = el('button', 'danger-btn', BM_TEXT.mDisconnect);
  sDisconnect.type = 'button';
  sDisconnect.hidden = true;
  const sRow = el('div', 'row');
  sRow.append(sConnect, sDisconnect);
  const sErr = el('p', 'hint bad');
  sErr.hidden = true;
  const sGranted = el('p', 'hint');
  sGranted.hidden = true;
  const sConnPanel = el('div', 'panel');
  sConnPanel.append(sState, sUser, sAddr, sRow, sErr, sGranted);
  const gConn = el('section', 'group');
  gConn.append(el('h2', null, UI_TEXT.secConn), sConnPanel);

  // -- 外观组（CSS 预览卡，点即存即用） --
  const themeBox = el('div', 'cards3');
  themeBox.setAttribute('role', 'radiogroup');
  const gTheme = el('section', 'group');
  gTheme.append(el('h2', null, UI_TEXT.secLook), themeBox);

  // -- 打开方式组 --
  const modeBox = el('div', 'cards2');
  modeBox.setAttribute('role', 'radiogroup');
  const gMode = el('section', 'group');
  gMode.append(el('h2', null, UI_TEXT.secOpen), modeBox);

  // -- 关于组（版本取 manifest，不手写；0.1.6 起可手动检查更新） --
  const sAbout = el('p', 'hint', UI_TEXT.aboutLine(chrome.runtime.getManifest().version));
  const btnCheck = el('button', 'btn-subtle', UI_TEXT.check);
  btnCheck.type = 'button';
  const sAboutRow = el('div', 'about-line');
  sAboutRow.append(sAbout, btnCheck);
  const sCheckMsg = el('p', 'hint');
  sCheckMsg.hidden = true;
  const sEula = el('button', 'ghost', EULA_UI.link);
  sEula.type = 'button';
  sEula.addEventListener('click', () => createEulaPanel(root, { mode: 'read' }));
  const gAbout = el('section', 'group');
  gAbout.append(el('h2', null, UI_TEXT.secAbout), sAboutRow, sCheckMsg, sEula);

  /**
   * 功能：写清失败原因；拿得到接口地址时再给一条自测入口（点开就是那段 JSON，一眼分得清是网络还是扩展）。
   * @param {string} code - SW 回的失败码
   * @param {string} [api] - 版本接口地址
   */
  function showCheckFail(code, api) {
    sCheckMsg.className = 'hint bad';
    sCheckMsg.textContent = UI_TEXT.checkFail(code);
    if (!api) return;
    sCheckMsg.append(' · ');
    const a = el('a', null, UI_TEXT.checkSelfTest);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: api });
    });
    sCheckMsg.appendChild(a);
  }

  /**
   * 功能：手动检查更新 —— 结果就地写清楚（有新版本给网盘入口），⛔ 不依赖顶部那枚气泡。
   * ⚠️ 手动查必须如实：用户以前关掉过的那一版，这里也要报「有新版本」。
   */
  btnCheck.addEventListener('click', async () => {
    btnCheck.disabled = true;
    btnCheck.textContent = UI_TEXT.checking;
    sCheckMsg.className = 'hint';
    sCheckMsg.textContent = UI_TEXT.checking;
    sCheckMsg.hidden = false;
    let r = null;
    try {
      r = await send(MSG.updateCheck);
    } catch (_e) {
      r = null; // SW 不可达 ⇒ 与「查不到」同一种收场，但原因写清楚
    }
    btnCheck.disabled = false;
    btnCheck.textContent = UI_TEXT.check;
    if (!r || !r.ok) {
      showCheckFail((r && (r.code || r.error)) || 'exception', r && r.api);
      return;
    }
    if (!r.fresh) {
      showCheckFail(r.code, r.api);
      return;
    }
    if (!r.newer) {
      sCheckMsg.className = 'hint ok';
      sCheckMsg.textContent = UI_TEXT.checkNewest(chrome.runtime.getManifest().version);
      return;
    }
    sCheckMsg.className = 'hint';
    sCheckMsg.textContent = UI_TEXT.checkNewer(r.update.latest) + ' · ';
    const go = el('a', null, UI_TEXT.checkGo);
    go.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: r.update.url });
    });
    sCheckMsg.appendChild(go);
  });

  cardSettings.append(sHead, gConn, gTheme, gMode, gAbout);

  root.append(cardConnect, cardResolving, cardLogin, cardMain, cardSettings, vaultMask);

  // ================= 状态机（B1 口径：show 不碰 bar；resetBar 只在未连态） =================
  const cards = { connect: cardConnect, resolving: cardResolving, login: cardLogin, main: cardMain, settings: cardSettings };
  function show(name) {
    for (const k of Object.keys(cards)) cards[k].hidden = k !== name;
    menu.open = false;
    closeVault(); // 0.1.5：切视图 ⇒ 明文立刻离开 DOM（任务单 §4.3「切换视图即清」）
  }
  function resetBar() {
    bar.hidden = true;
    dot.className = 'dot';
    barHost.textContent = '—';
    barLink.hidden = true;
  }

  function render(st) {
    if (stopPoll) {
      stopPoll();
      stopPoll = null;
    }
    let h = '—';
    try {
      if (st.base) h = new URL(st.base).host;
    } catch (_e) {
      /* base 缺失保持 — */
    }
    switch (st.state) {
      case 'connected':
        curBase = st.base || st.origin || '';
        dot.className = 'dot on';
        barHost.textContent = h;
        barLink.textContent = LINK_LABEL[st.link] || '';
        barLink.hidden = !st.link;
        if (st.user && st.user.name) barHost.title = `${UI_TEXT.accountLabel} ${st.user.name}`;
        bar.hidden = false;
        show('main');
        if (isPopup) initForm();
        else fillTagOptions(); // 侧边栏：不预填当前页（允许手动贴地址），但标签下拉要备好
        loadList(!isPopup);
        return false;
      case 'resolving':
        resolvingTarget.textContent = st.origin || st.input || '';
        show('resolving');
        return false;
      case 'need_login':
        if (st.input) lastInput = st.input;
        resetBar();
        show('login');
        stopPoll = pollWhile(render); // SW 轮询登录态，这里收割结果
        return true;
      case 'failed':
        resetBar();
        connectErr.textContent = errText(st.error);
        connectErr.hidden = false;
        show('connect');
        return false;
      default:
        resetBar();
        show('connect');
        return false;
    }
  }

  // ================= 连接（授权并连接一步到位；手势丢了回设置视图兜底） =================
  function showSettings(input) {
    if (input && !sAddr.value) sAddr.value = input;
    show('settings');
    send(MSG.status)
      .catch(() => ({ state: 'idle' }))
      .then(renderSettings);
  }

  btnConnect.addEventListener('click', async () => {
    connectErr.hidden = true;
    const input = addr.value.trim();
    show('resolving');
    resolvingTarget.textContent = input;
    // ⭐ 0.1.4 真机修：这里原来没有护栏，一次 TypeError 就让视图停在「连接中…」永不落地
    let st;
    try {
      st = await authorizeAndConnect(input);
    } catch (_e) {
      st = { state: 'failed', error: 'network' };
    }
    if (st.state === 'need_settings') {
      connectErr.textContent = UI_TEXT.needAuth;
      connectErr.hidden = false;
      showSettings(input); // 手势丢失 / 用户拒绝 ⇒ 设置视图里再点一次
      return;
    }
    render(st);
  });
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnConnect.click();
  });

  btnReopen.addEventListener('click', async () => {
    show('resolving');
    resolvingTarget.textContent = lastInput;
    let st;
    try {
      st = await connectFlow(lastInput);
    } catch (_e) {
      st = { state: 'failed', error: 'network' };
    }
    render(st);
  });
  btnCancelLogin.addEventListener('click', async () => {
    await send(MSG.disconnect);
    resetBar();
    show('connect');
  });
  btnRefresh.addEventListener('click', async () => {
    render(await send(MSG.recheck));
  });
  mReaddress.addEventListener('click', () => {
    menu.open = false;
    resetBar();
    show('connect');
  });
  mSettings.addEventListener('click', () => {
    menu.open = false;
    showSettings('');
  });
  mDisconnect.addEventListener('click', async () => {
    menu.open = false;
    await send(MSG.disconnect);
    addr.value = '';
    if (inQ) inQ.value = '';
    if (selTag) selTag.value = '';
    resetBar();
    show('connect');
  });
  // 菜单点外部/Esc 收起
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  /**
   * 0.1.5：Esc 的统一口径（自内向外）—— 弹层 > 菜单 > 设置视图返主视图。
   * ⚠️ 焦点在输入框/下拉里时不接管（那时用户按 Esc 是想取消这次输入，不是想离开这一屏）。
   */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!vaultMask.hidden) {
      closeVault();
      return;
    }
    if (menu.open) {
      menu.open = false;
      return;
    }
    if (!cardSettings.hidden && !isTyping()) backToMain();
  });
  function isTyping() {
    const a = document.activeElement;
    if (!a || !a.tagName) return false;
    const t = String(a.tagName).toUpperCase();
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  // ================= 收藏表单（照网页端 openBmForm：下拉 + 新标签输入 → 药丸） =================
  const selected = new Set(); // ⛔ 只传名，服务端 ensureTag 自动建

  function formMsgShow(text, ok) {
    formMsg.textContent = text;
    formMsg.className = 'hint ' + (ok ? 'ok' : 'bad');
    formMsg.hidden = false;
  }

  function setFormOpen(open) {
    formOpen = open;
    form.hidden = !open;
    btnFormToggle.hidden = open;
  }
  btnFormToggle.textContent = BM_TEXT.addUrl; // 侧边栏折叠入口（popup 常开，toggle 不出现）
  if (!isPopup) {
    inUrl.placeholder = BM_TEXT.addUrlPh;
    inTitle.placeholder = BM_TEXT.addTitlePh;
  }
  btnFormToggle.addEventListener('click', () => {
    setFormOpen(true);
    // ⭐ 侧边栏没有 initForm（那是 popup 的预填路径）⇒ 这里必须自己拉一次标签，
    //   否则下拉里一个选项都没有（0.1.7 真机反馈「新建网址的标签下拉是空白的」）。
    // 每次展开都刷：别处新建的标签也能立刻选到。
    fillTagOptions();
    inUrl.focus();
  });
  setFormOpen(formOpen);

  /** 功能：预填当前页（popup）+ 拉已有标签进下拉。 */
  function initForm() {
    selected.clear();
    inTitle.value = '';
    inUrl.value = '';
    inUrl.title = '';
    formMsg.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = BM_TEXT.save;
    picks.textContent = '';
    inNewTag.value = '';
    send(MSG.pageContext).then((c) => {
      if (c && c.url) {
        inTitle.value = c.title || '';
        inUrl.value = c.url;
        inUrl.title = c.url;
        submitBtn.disabled = false;
      } else {
        formMsgShow(BM_TEXT.urlEmpty, false);
      }
    });
    fillTagOptions();
  }

  async function fillTagOptions() {
    const r = await send(MSG.bmList, {});
    // ⚠️ 拿不到列表（没连上 / 请求失败）时也要把下拉重置成一句可读的话，
    //    别留一个空白下拉让人以为功能坏了。
    const tags = r && r.ok && Array.isArray(r.tags) ? r.tags : [];
    // ⚠️「未分类」是服务端哨兵（id:'none'）不是真标签 ⇒ 不进下拉（照网页端）。
    tagSel.textContent = '';
    const first = el('option');
    first.value = '';
    first.textContent = tags.some((t) => t.id !== 'none') ? '选择' : '还没有用过标签';
    tagSel.appendChild(first);
    if (!(r && r.ok)) return;
    for (const t of tags) {
      if (t.id === 'none') continue;
      const o = el('option');
      o.value = t.name;
      o.textContent = t.name;
      tagSel.appendChild(o);
    }
  }

  function addPick(name) {
    name = String(name || '').trim();
    if (!name || selected.has(name)) return;
    selected.add(name);
    const b = el('button', 'pick');
    b.type = 'button';
    b.title = '点击移除';
    const x = el('span', 'x', '✕ ');
    b.append(x, document.createTextNode(name));
    b.addEventListener('click', () => {
      selected.delete(name);
      b.remove();
    });
    picks.appendChild(b);
  }

  // 下拉选已有：先重置再挂——不重置「再选同一枚」change 不触发（网页端踩过的坑）
  tagSel.addEventListener('change', () => {
    const v = tagSel.value;
    tagSel.value = '';
    if (v) addPick(v);
  });

  function commitNew() {
    String(inNewTag.value)
      .split(/[,，、]/)
      .forEach((x) => addPick(x));
    inNewTag.value = '';
  }
  btnAddTag.addEventListener('click', commitNew);
  inNewTag.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation(); // ⛔ 别让回车顺带触发表单提交（网页端同款注释）
    commitNew();
  });

  /** 功能：提交收藏（popup 表单与侧边栏折叠表单共用一条提交路径）。 */
  async function submitBookmark() {
    const url = inUrl.value.trim();
    if (!url) return formMsgShow(BM_TEXT.urlEmpty, false);
    submitBtn.disabled = true;
    submitBtn.textContent = BM_TEXT.saving;
    // 照网页端保存口径：已选药丸 + 新标签框里没提交的残留一起并入
    const tags = [...selected].concat(
      String(inNewTag.value)
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const r = await send(MSG.bmCreate, { url, title: inTitle.value.trim(), tags });
    if (r && r.ok) {
      if (isPopup) {
        submitBtn.textContent = BM_TEXT.saved; // 差异 4：新增成功才自动关（0.1.3 规则）
        setTimeout(() => window.close(), 1200);
      } else {
        selected.clear();
        picks.textContent = '';
        inTitle.value = '';
        inUrl.value = '';
        inNewTag.value = '';
        submitBtn.disabled = false;
        submitBtn.textContent = BM_TEXT.addSave;
        setFormOpen(false);
        loadList(false);
      }
      return;
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isPopup ? BM_TEXT.save : BM_TEXT.addSave;
    if (r && r.code === 'duplicate') {
      formMsgShow(`${BM_TEXT.savedDup} · `, true);
      const a = el('a', null, BM_TEXT.view);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openSidepanel(url);
      });
      formMsg.appendChild(a);
      return;
    }
    formMsgShow(errText(r && r.code === 'not_connected' ? 'cookie_missing' : r && r.code), false);
  }
  btnSave.addEventListener('click', submitBookmark);
  btnOpenPanel.addEventListener('click', () => openSidepanel());

  /** 功能：打开侧边栏；带 url 时通知滚动高亮那条（UI↔UI 消息，不经 SW）。 */
  async function openSidepanel(highlightUrl) {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    if (!highlightUrl) return;
    // 侧边栏可能还没加载完 listener，重试几发（无监听者时 sendMessage 会 reject，吞掉）
    for (let i = 0; i < 4; i++) {
      try {
        await chrome.runtime.sendMessage({ type: 'bm:highlight', url: highlightUrl });
        return;
      } catch (_e) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  if (btnViewAll) btnViewAll.addEventListener('click', () => openSidepanel());

  // ================= 列表（两形态共用；popup 截 20 条） =================
  let searchTimer = null;
  let curTag = '';
  let lastTags = []; // 0.1.5：最近一次列表带回的分类（编辑行的下拉选项）
  let curBase = ''; // 0.1.5 E3：「去网页解锁」要打开的地址（连接成功时落一次）
  let vaultFor = null; // 0.1.5 E3：当前弹层对应的那条收藏（重试用）

  function relTime(t) {
    if (typeof t !== 'string' || t.length < 10) return { short: '', full: t || '' };
    const full = t;
    const d = new Date(t.replace(' ', 'T'));
    const now = new Date();
    const day = (x) => Math.floor((x && x.getTime ? x.getTime() : 0) / 86400000);
    const diff = day(now) - day(d);
    let short = t.slice(5, 10);
    if (diff === 0) short = BM_TEXT.today;
    else if (diff === 1) short = BM_TEXT.yesterday;
    return { short, full };
  }

  function listState(mode, text) {
    skel.hidden = mode !== 'loading';
    if (mode === 'error' || mode === 'empty') {
      listNote.textContent = mode === 'error' ? BM_TEXT.listError : text;
      listNote.hidden = false;
      if (mode === 'empty') {
        listNote.append(el('br'), el('span', null, BM_TEXT.listEmptyHint));
      }
    } else {
      listNote.hidden = true;
    }
    btnRetry.hidden = mode !== 'error';
    listTotal.hidden = mode !== 'ready';
    if (mode !== 'ready') ul.textContent = '';
  }

  async function loadList(allowCache) {
    const q = inQ ? inQ.value.trim() : '';
    const tag = curTag;
    if (allowCache && !q && !tag) {
      const c = await send(MSG.bmCacheGet);
      if (c && c.items) {
        renderList(c);
        return;
      }
      listState('loading'); // 骨架
    }
    const r = await send(MSG.bmList, { q, tag });
    if (!(r && r.ok)) {
      listState('error');
      return;
    }
    renderList(r);
    if (!q && !tag && !isPopup) await send(MSG.bmCacheSet, { items: r.items, total: r.total, tags: r.tags });
  }

  function renderList({ items, total, tags }) {
    lastTags = Array.isArray(tags) ? tags : []; // 0.1.5：编辑行的「已有标签」下拉从这里取
    listTotal.textContent = BM_TEXT.totalOf(total ?? items.length);
    if (selTag) {
      const keep = curTag;
      selTag.textContent = '';
      const optAll = el('option');
      optAll.value = '';
      optAll.textContent = BM_TEXT.allTags;
      selTag.appendChild(optAll);
      for (const t of tags) {
        const o = el('option');
        o.value = String(t.id);
        o.textContent = t.name + (t.count != null ? ` (${t.count})` : '');
        o.title = t.name;
        selTag.appendChild(o);
      }
      selTag.value = keep;
      if (selTag.value !== keep) {
        curTag = '';
        selTag.value = '';
      }
    }
    const shown = isPopup ? items.slice(0, 20) : items; // 差异 5：popup 最近 20 条
    if (!shown.length) {
      listState('empty', BM_TEXT.listEmpty);
      return;
    }
    listState('ready');
    ul.textContent = '';
    for (const it of shown) {
      const li = el('li');
      li.dataset.url = it.url;
      const top = el('div', 'li-top');
      const a = el('a', 'li-title'); // 真链接：键盘/右键复制/中键新标签免费
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = it.title || it.url;
      a.title = it.url;
      const act = el('span', 'li-act');
      const open = el('button', 'act-btn', '↗');
      open.type = 'button';
      open.title = '打开';
      open.addEventListener('click', () => chrome.tabs.create({ url: it.url }));
      const edit = el('button', 'act-btn', '✎'); // 0.1.5 E2
      edit.type = 'button';
      edit.title = BM_TEXT.edit;
      edit.setAttribute('aria-label', BM_TEXT.edit);
      edit.addEventListener('click', () => openEditor(li, it));
      const del = el('button', 'act-btn act-del', '🗑');
      del.type = 'button';
      del.title = '删除';
      del.addEventListener('click', () => confirmDelete(li, it));
      act.append(open, edit, del);
      top.append(a);
      // 0.1.5 E3：绑定了密码的**常显**一颗 🔑（未绑定什么都不画、不占位）
      if (it.vault_entry_id != null && it.vault_entry_id !== '') {
        const k = el('button', 'key-btn', VAULT_TEXT.key);
        k.type = 'button';
        k.title = VAULT_TEXT.view;
        k.setAttribute('aria-label', VAULT_TEXT.view);
        k.addEventListener('click', () => openVault(it));
        top.append(k);
      }
      top.appendChild(act);
      const sub = el('div', 'li-sub');
      const h = el('span', 'li-host', hostOf(it.url));
      sub.appendChild(h);
      for (const name of it.tag_names || []) sub.appendChild(el('span', 'li-tag', name));
      const t = relTime(it.created_at);
      const d = el('span', null, t.short);
      d.title = t.full;
      sub.appendChild(d);
      li.append(top, sub);
      ul.appendChild(li);
    }
    maybeShowHint();
  }

  function confirmDelete(li, it) {
    const top = li.firstElementChild;
    const sub = li.lastElementChild;
    if (!top || top.classList.contains('confirm')) return;
    top.hidden = true;
    sub.hidden = true;
    const barEl = el('div', 'confirm');
    const q = el('span', 'q', BM_TEXT.confirmDel(it.title || it.url));
    const yes = el('button', 'yes', BM_TEXT.btnDel);
    yes.addEventListener('click', () => {
      cleanup();
      send(MSG.bmRemove, { id: it.id }).then((r) => {
        if (r && r.ok) loadList(false);
        else listState('error');
      });
    });
    const no = el('button', null, BM_TEXT.btnCancel);
    no.addEventListener('click', cleanup);
    const esc = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cleanup();
      }
    };
    const timer = setTimeout(cleanup, 3000); // 3 s 无操作自动复原
    barEl.append(q, yes, no);
    li.appendChild(barEl);
    document.addEventListener('keydown', esc, { once: true });
    function cleanup() {
      clearTimeout(timer);
      barEl.remove();
      document.removeEventListener('keydown', esc);
      top.hidden = false;
      sub.hidden = false;
    }
  }

  // ================= 0.1.5 E2：行内编辑（不弹全屏层 —— 侧边栏太窄） =================

  /** 功能：编辑行的已有标签下拉（选项来自最近一次列表带回的分类）。 */
  function fillPickerOptions(sel) {
    sel.textContent = '';
    const first = el('option');
    first.value = '';
    first.textContent = lastTags.some((t) => t.id !== 'none') ? '选择' : '还没有用过标签';
    sel.appendChild(first);
    for (const t of lastTags) {
      if (t.id === 'none') continue; // 「未分类」是服务端哨兵，不是真标签
      const o = el('option');
      o.value = t.name;
      o.textContent = t.name;
      sel.appendChild(o);
    }
  }

  /**
   * 功能：标签选择器（下拉选已有 + 新标签输入 → 药丸，点药丸移除），编辑行专用。
   * ⚠️ 与收藏表单那块**刻意不合并**：表单那条是 0.1.3 真机验过的路径，收尾单不顺手重构它
   *    （禁止清单 7）；两份都较短，重复成本低于回归风险。
   * @param {string[]} initial - 初始标签名
   * @returns {{node:HTMLElement, tags:()=>string[]}}
   */
  function makeTagPicker(initial) {
    const set = new Set((initial || []).map(String).filter(Boolean));
    const box = el('div', 'picks');
    const sel = el('select');
    sel.setAttribute('aria-label', '从已有标签里选一个');
    const inp = el('input');
    inp.placeholder = '写一个新标签';
    inp.autocomplete = 'off';
    const add = el('button', 'btn-subtle', '＋ 新增');
    add.type = 'button';
    const rowEl = el('div', 'tag-add');
    rowEl.append(sel, inp, add);
    const wrap = el('div', 'tag-edit');
    wrap.append(box, rowEl);

    function paint() {
      box.textContent = '';
      for (const name of set) {
        const b = el('button', 'pick');
        b.type = 'button';
        b.title = '点击移除';
        b.append(el('span', 'x', '✕ '), document.createTextNode(name));
        b.addEventListener('click', () => {
          set.delete(name);
          paint();
        });
        box.appendChild(b);
      }
    }
    function addName(n) {
      const v = String(n || '').trim();
      if (!v || set.has(v)) return;
      set.add(v);
      paint();
    }
    function commit() {
      String(inp.value)
        .split(/[,，、]/)
        .forEach(addName);
      inp.value = '';
    }
    // 下拉选已有：先重置再挂（不重置「再选同一枚」change 不触发 —— 网页端踩过的坑）
    sel.addEventListener('change', () => {
      const v = sel.value;
      sel.value = '';
      if (v) addName(v);
    });
    add.addEventListener('click', commit);
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation(); // ⛔ 别让回车顺带触发保存/其它快捷键
      commit();
    });
    paint();
    fillPickerOptions(sel);
    return {
      node: wrap,
      tags: () =>
        [...set].concat(
          String(inp.value)
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter(Boolean)
        ),
    };
  }

  /** 功能：保存成功后**只更新这一行**（不整表重拉，避免闪一下）。 */
  function applyRow(li, it, title, tagNames) {
    const top = li.children[0];
    const sub = li.children[1];
    if (!top || !sub) return;
    const a = top.children[0];
    if (a) {
      a.textContent = title || it.url;
      a.title = it.url;
    }
    sub.textContent = '';
    sub.appendChild(el('span', 'li-host', hostOf(it.url)));
    for (const name of tagNames || []) sub.appendChild(el('span', 'li-tag', name));
    const t = relTime(it.created_at);
    const d = el('span', null, t.short);
    d.title = t.full;
    sub.appendChild(d);
    li.dataset.url = it.url;
  }

  /**
   * 功能：展开行内编辑。
   * @param {HTMLElement} li - 列表项
   * @param {object} it - 收藏行（id/title/url/tag_names/created_at）
   */
  function openEditor(li, it) {
    if (li.querySelector('.li-edit')) return; // 已展开
    const top = li.children[0];
    const sub = li.children[1];
    if (!top || !sub) return;
    top.hidden = true;
    sub.hidden = true;

    const box = el('div', 'li-edit');
    const inT = el('input', 'e-title');
    inT.value = it.title || '';
    inT.placeholder = BM_TEXT.addTitlePh;
    inT.autocomplete = 'off';
    const fTitle = el('div', 'field');
    fTitle.append(el('span', 'flabel', '标题'), inT);

    const picker = makeTagPicker(it.tag_names || []);
    const err = el('p', 'hint bad');
    err.hidden = true;
    const btnOk = el('button', 'primary', BM_TEXT.editSave);
    btnOk.type = 'button';
    const btnNo = el('button', null, BM_TEXT.btnCancel);
    btnNo.type = 'button';
    const rowEl = el('div', 'row');
    rowEl.append(btnOk, btnNo);
    box.append(fTitle, el('p', 'flabel-line', '标签'), picker.node, err, rowEl);
    li.appendChild(box);
    inT.focus();

    function close() {
      box.remove();
      top.hidden = false;
      sub.hidden = false;
      document.removeEventListener('keydown', esc);
    }
    const esc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // ⛔ 别让全局 Esc 顺手把设置也关了
      close();
    };
    document.addEventListener('keydown', esc);
    btnNo.addEventListener('click', close);
    inT.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      btnOk.click();
    });

    btnOk.addEventListener('click', async () => {
      btnOk.disabled = true;
      btnOk.textContent = BM_TEXT.editSaving;
      err.hidden = true;
      const title = inT.value.trim();
      const tagNames = picker.tags();
      let r;
      try {
        // ⛔ 只发 id/title/tags —— url 一个字都不带
        r = await send(MSG.bmUpdate, { id: it.id, title, tags: tagNames });
      } catch (_e) {
        r = { ok: false, code: 'network' };
      }
      btnOk.disabled = false;
      btnOk.textContent = BM_TEXT.editSave;
      if (r && r.ok) {
        const saved = r.item && typeof r.item === 'object' ? r.item : null;
        it.title = title;
        it.tag_names = tagNames;
        if (saved) {
          if (saved.title != null) it.title = String(saved.title);
          if (Array.isArray(saved.tag_names)) it.tag_names = saved.tag_names;
          if (saved.created_at) it.created_at = saved.created_at;
        }
        close();
        applyRow(li, it, it.title, it.tag_names);
        return;
      }
      if (r && r.code === 'bookmark_gone') {
        err.textContent = BM_TEXT.editGone;
        err.hidden = false;
        setTimeout(() => loadList(false), 1200); // 这条没了 ⇒ 刷新列表对齐
        return;
      }
      err.textContent = BM_TEXT.editFail;
      err.hidden = false; // 失败保留输入，用户改一下再存
    });
  }

  // ================= 0.1.5 E3：密码库只读（明文只在内存/DOM 里过一遍） =================

  /** 功能：关弹层 —— ⭐ 明文必须立刻离开 DOM（⛔ 只藏起来留着 textContent 等被读）。 */
  function closeVault() {
    if (vaultMask.hidden) return;
    vaultMask.hidden = true;
    vaultCard.textContent = '';
    vaultFor = null;
  }

  function vaultHead(titleText) {
    const h = el('div', 'vault-head');
    const x = el('button', 'icon-btn', '✕');
    x.type = 'button';
    x.title = VAULT_TEXT.close;
    x.setAttribute('aria-label', VAULT_TEXT.close);
    x.addEventListener('click', closeVault);
    h.append(el('h2', null, titleText), x);
    return h;
  }

  function paintVaultMsg(text, bad) {
    vaultCard.textContent = '';
    vaultCard.append(vaultHead('密码库'), el('p', bad ? 'hint bad' : 'hint', text));
  }

  /** 功能：锁定态 —— 引导去网页解锁，回来自助重试。 */
  function paintVaultLocked(text) {
    vaultCard.textContent = '';
    const go = el('button', 'primary', VAULT_TEXT.goUnlock);
    go.type = 'button';
    go.addEventListener('click', () => {
      if (curBase) chrome.tabs.create({ url: curBase + '/' });
    });
    const retry = el('button', null, VAULT_TEXT.retry);
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (vaultFor) openVault(vaultFor);
    });
    const rowEl = el('div', 'row');
    rowEl.append(go, retry);
    vaultCard.append(vaultHead('密码库'), el('p', 'hint', text), rowEl);
  }

  /** 功能：复制（先 clipboard API，失败退 execCommand —— ⛔ 不为它加 clipboardWrite 权限，注册新权限会让已装扩展被停用）。 */
  async function copyText(text, btn) {
    let done = false;
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch (_e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        done = !!document.execCommand('copy');
        ta.remove();
      } catch (_e2) {
        done = false;
      }
    }
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = done ? VAULT_TEXT.copied : VAULT_TEXT.copyFail;
    setTimeout(() => {
      btn.textContent = old;
    }, 1200);
  }

  function vaultRow(label, value, { secret = false, copyable = false } = {}) {
    const r = el('div', 'vault-row');
    r.append(el('span', 'vlabel', label));
    const v = el('span', 'vvalue' + (secret ? ' secret' : ''), secret ? '••••••••' : value || '—');
    r.appendChild(v);
    if (secret) {
      const show = el('button', 'btn-mini', VAULT_TEXT.show);
      show.type = 'button';
      let shown = false;
      show.addEventListener('click', () => {
        shown = !shown;
        v.textContent = shown ? value : '••••••••';
        show.textContent = shown ? VAULT_TEXT.hide : VAULT_TEXT.show;
      });
      r.appendChild(show);
    }
    if (copyable) {
      const c = el('button', 'btn-mini', VAULT_TEXT.copy);
      c.type = 'button';
      c.addEventListener('click', () => copyText(value, c));
      r.appendChild(c);
    }
    return r;
  }

  /** 功能：详情态 —— 名称/用户名/密码（掩码可显示），用户名与密码各一颗复制。 */
  function paintVaultEntry(entry) {
    vaultCard.textContent = '';
    const rows = el('div', 'vault-rows');
    rows.append(
      vaultRow(VAULT_TEXT.name, entry.title),
      vaultRow(VAULT_TEXT.username, entry.username, { copyable: true }),
      vaultRow(VAULT_TEXT.password, entry.password, { secret: true, copyable: true })
    );
    const note = el('p', 'hint vault-note', VAULT_TEXT.note);
    vaultCard.append(vaultHead('密码库'), rows, note);
  }

  /**
   * 功能：点 🔑 ⇒ 先问 status（不需要解锁）⇒ 未解锁给引导 / 已解锁取详情。
   * ⚠️ 每次点开都重新问一次（解锁态是服务端的、会自动锁定，本地缓存只会骗自己）。
   * @param {object} it - 收藏行（要 vault_entry_id）
   */
  async function openVault(it) {
    const id = it && it.vault_entry_id;
    if (id == null || id === '') return;
    vaultFor = it;
    vaultMask.hidden = false;
    paintVaultMsg(VAULT_TEXT.loading, false);
    try {
      const st = await send(MSG.vaultStatus).catch(() => null);
      if (!st || !st.ok) return paintVaultMsg(VAULT_TEXT.fail, true);
      if (!st.initialized) return paintVaultLocked(VAULT_TEXT.uninit);
      if (!st.unlocked) return paintVaultLocked(VAULT_TEXT.locked);
      const r = await send(MSG.vaultEntry, { id }).catch(() => null);
      if (!r || !r.ok) {
        if (r && r.code === 'vault_locked') return paintVaultLocked(VAULT_TEXT.locked);
        if (r && r.code === 'vault_gone') return paintVaultMsg(VAULT_TEXT.gone, true);
        return paintVaultMsg(VAULT_TEXT.fail, true);
      }
      paintVaultEntry(r.entry);
    } catch (_e) {
      paintVaultMsg(VAULT_TEXT.fail, true); // ⛔ 任何异常都要有落点（0.1.4「一直连接中」的教训）
    }
  }

  if (inQ) {
    inQ.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadList(false), 300);
    });
    selTag.addEventListener('change', () => {
      curTag = selTag.value;
      loadList(false);
    });
  }
  btnRetry.addEventListener('click', () => loadList(false));

  // 一次性提示（localStorage：UI 展示状态，不属连接数据——分层纪律 2 管的是 chrome.storage）
  const HINT_KEY = 'zx_edge_list_hint';
  function maybeShowHint() {
    if (isPopup || localStorage.getItem(HINT_KEY)) return;
    listHint.textContent = BM_TEXT.listHint;
    listHint.hidden = false;
    ul.addEventListener(
      'click',
      () => {
        localStorage.setItem(HINT_KEY, '1');
        listHint.hidden = true;
      },
      { once: true }
    );
  }

  // popup「查看」跳转：滚动并高亮那条（UI↔UI 消息，不经 SW）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'bm:highlight' && msg.url) highlightUrl(msg.url);
  });
  async function highlightUrl(url) {
    show('main');
    if (inQ && (inQ.value || curTag)) {
      inQ.value = '';
      curTag = '';
      await loadList(false);
    }
    const li = [...ul.children].find((n) => n.dataset.url === url);
    if (!li) return;
    li.scrollIntoView({ block: 'center' });
    li.classList.add('hl');
    setTimeout(() => li.classList.remove('hl'), 2500);
  }

  // ---- 设置视图逻辑（从 settings.js 原样迁入；授权调用在 conn-ui.authorizeAndConnect） ----
  let grantedNow = false;
  async function renderGranted() {
    try {
      const all = await chrome.permissions.getAll();
      const origins = (all.origins || []).filter((o) => o.startsWith('http'));
      grantedNow = origins.length > 0;
      sGranted.hidden = false;
      sGranted.textContent = origins.length
        ? `${UI_TEXT.grantedLabel}：${origins.map((o) => o.replace(/^https?:\/\//, '').replace(/\/\*$/, '')).join(' · ')}`
        : UI_TEXT.nothingGranted;
    } catch (_e) {
      sGranted.hidden = true;
    }
  }

  /** 功能：设置视图按 Status 渲染连接组。 */
  function renderSettings(st) {
    sErr.hidden = true;
    const connected = st.state === 'connected';
    sState.hidden = !connected;
    sUser.hidden = !connected;
    sDisconnect.hidden = !connected;
    sAddr.hidden = connected;
    sConnect.hidden = connected;
    if (connected) {
      let h = st.origin || '';
      try {
        if (st.base) h = new URL(st.base).host;
      } catch (_e) {
        /* 保持 origin */
      }
      sDot.className = 'dot on';
      sHost.textContent = h;
      sLink.textContent = LINK_LABEL[st.link] || '';
      sLink.hidden = !st.link;
      sUser.textContent = st.user && st.user.name ? `${UI_TEXT.accountLabel}：${st.user.name}` : '';
      renderGranted();
      return;
    }
    sConnect.disabled = st.state === 'connecting';
    sConnect.textContent = st.state === 'connecting' ? UI_TEXT.connecting : grantedNow ? UI_TEXT.reconnect : UI_TEXT.authConnect;
    if (st.state === 'need_login') {
      sErr.className = 'hint';
      sErr.textContent = statusText(st);
      sErr.hidden = false;
      return;
    }
    sErr.className = 'hint bad';
    if (st.state === 'failed' && st.error) {
      sErr.textContent = errText(st.error);
      sErr.hidden = false;
    }
  }

  sConnect.addEventListener('click', async () => {
    sErr.hidden = true;
    sConnect.disabled = true;
    sConnect.textContent = UI_TEXT.connecting;
    let st;
    try {
      st = await authorizeAndConnect(sAddr.value.trim());
    } catch (_e) {
      st = { state: 'failed', error: 'network' };
    }
    renderSettings(st);
  });
  sAddr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sConnect.click();
  });
  sDisconnect.addEventListener('click', async () => {
    await send(MSG.disconnect);
    sAddr.value = '';
    sState.hidden = true;
    sUser.hidden = true;
    sDisconnect.hidden = true;
    sAddr.hidden = false;
    sConnect.hidden = false;
    renderGranted().then(() => {
      sConnect.disabled = false;
      sConnect.textContent = grantedNow ? UI_TEXT.reconnect : UI_TEXT.authConnect;
    });
  });
  /**
   * 功能：从设置视图回收藏主视图（0.1.5 E1 的语义口径）——设置是**内嵌视图**，不是标签页，
   *      所以 ⛔ 不碰 `window.close()`（那是 0.1.3 整页设置时代的做法）。
   */
  async function backToMain() {
    let st;
    try {
      st = await send(MSG.status);
    } catch (_e) {
      st = { state: 'idle' };
    }
    render(st);
  }
  sBack.addEventListener('click', backToMain);

  // -- 预览卡（外观 3 张 / 打开方式 2 张；全部 CSS 画） --
  const THEMES = [
    { v: 'light', label: UI_TEXT.themeLight, prev: 'prev prev-light' },
    { v: 'dark', label: UI_TEXT.themeDark, prev: 'prev prev-dark' },
    { v: 'auto', label: UI_TEXT.themeAuto, prev: 'prev prev-auto' },
  ];
  const MODES = [
    { v: 'popup', label: UI_TEXT.modePopup, inner: 'mini' },
    { v: 'sidepanel', label: UI_TEXT.modePanel, inner: 'side' },
  ];
  function buildCards(box, list, cur, onPick) {
    box.textContent = '';
    for (const t of list) {
      const b = el('button', 'pick-card' + (t.v === cur ? ' on' : ''));
      b.type = 'button';
      b.dataset.v = t.v;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', t.v === cur ? 'true' : 'false');
      if (t.prev) b.appendChild(el('div', t.prev));
      b.appendChild(el('span', 'cap', t.label));
      b.addEventListener('click', () => onPick(t.v));
      b.addEventListener('keydown', (e) => {
        // 卡片 ←/→ 可切（§九.8 口径保留）
        const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const cs = [...box.children];
        const i = cs.indexOf(document.activeElement);
        const next = cs[Math.min(cs.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
        if (next) next.focus();
      });
      box.appendChild(b);
    }
  }
  function markSel(box, v) {
    for (const b of box.children) {
      b.classList.toggle('on', b.dataset.v === v);
      b.setAttribute('aria-checked', b.dataset.v === v ? 'true' : 'false');
    }
  }
  async function initThemeCards() {
    const bag = await chrome.storage.local.get('pref:theme');
    const cur = bag['pref:theme'] || 'auto';
    buildCards(themeBox, THEMES, cur, async (v) => {
      await chrome.storage.local.set({ 'pref:theme': v }); // theme-boot 监听 onChanged 三屏热更新
      markSel(themeBox, v);
    });
  }
  async function initModeCards() {
    const bag = await chrome.storage.local.get('pref:openMode');
    const cur = bag['pref:openMode'] === 'sidepanel' ? 'sidepanel' : 'popup';
    buildCards(modeBox, MODES, cur, async (v) => {
      await chrome.storage.local.set({ 'pref:openMode': v }); // sw.js onChanged ⇒ applyOpenMode 即时生效
      markSel(modeBox, v);
    });
    for (const b of modeBox.children) {
      const m = MODES.find((x) => x.v === b.dataset.v);
      const pv = el('div', 'prev-mode');
      pv.appendChild(el('div', m.inner));
      b.insertBefore(pv, b.firstChild);
    }
  }
  initThemeCards();
  initModeCards();

  // ================= 启动 =================
  // R4 红线：SW 每次真握手，重启后不会假装已连接
  const st0 = await send(MSG.status);
  render(st0);
  loadUpdate(); // 0.1.6：新版本气泡，不 await —— 检测慢也不挡界面
  // 自动识别：只在 popup（activeTab 随图标点击授予；侧边栏没有手势，探了也白探）
  if (isPopup) {
    send(MSG.detect).then((d) => {
      if (d && d.origin && !addr.value) addr.value = d.origin;
    });
  }
}
