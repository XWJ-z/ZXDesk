/**
 * open.js —— ZXDesk 加密文件阅读器（0.9.8 第 6 轮 · 方案 §十）
 *
 * 功能：文件管理器里双击 `.zxdesk`（或 `.zxkey`）打开的那一页 ——
 *      确认文件 → 输主密码（或选一把已导入的钥匙）→ 预览 / 下载明文；`.zxkey` 走导入流程。
 *
 * 【三条硬口径，改代码前先读】
 *   ① ⛔ **不用 `core/api.js` 的 `api()`**：那个封装会给成功的 GET 写离线快照
 *      （`localStorage`）。这里拿到的是「加密文件的文件名 / 大小 / 钥匙清单」——
 *      它们不该出现在浏览器的本地缓存里被下一个人看到。所以本页用裸 `fetch`。
 *   ② ⛔ **预类型只信服务端**：`Content-Type` 由服务端**解密首帧嗅探**决定，
 *      这里只按它决定用哪个标签渲染（`<img>` / `<video>` / `<audio>` / `<iframe>`），
 *      绝不自己猜、也绝不把未知类型内联显示。
 *   ③ ⛔ **离开页面就断开媒体**：`video.pause()` ＋ 清 `src`
 *      （第 5 轮的 `closeModal()` 同一条教训 —— 不 pause 的 `<video>` 会一直连着解密流）。
 *
 * @author zx
 * @date   2026-11-08
 * @since 0.9.7
 * 相关：docs/公共/开发方案/2026-11-08-0.9.8-第6轮修改.md §六~§十一、docs/公共/架构文档/29-加密信息.md
 */
import { BASE } from '../core/api.js';

const qs = new URLSearchParams(location.search);
/**
 * 文件管理器（以及「加密信息 → 阅读器」）追加的 `?path=`（飞牛官方口径：入口 URL 后追加 `path`）。
 * ⚠️ 没路径时**不改这个值**，而是让用户贴一条后整页重来（见 `renderPickPath()`）——
 *    这样「文件名 / 元信息 / 解锁 / 预览」都只走一条初始化路。
 */
const filePath = String(qs.get('path') || '');

/** 按 id 取元素 @param {string} id @returns {?HTMLElement} */
const $ = (id) => document.getElementById(id);

/**
 * 功能：HTML 转义（本页唯一一处把外部字符串拼进 `innerHTML` 的地方都要过它）。
 * @param {*} s - 任意值
 * @returns {string} 转义后的文本
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * 功能：把字节数写成「12.3 MB」这种给人看的形状。
 * @param {number} n - 字节数
 * @returns {string} 展示串
 */
function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 功能：发一次请求（**裸 `fetch`**，原因见文件头第 ① 条）。
 * @param {string} method - HTTP 方法
 * @param {string} path - 应用内绝对路径（本函数补 `BASE`）
 * @param {*} [body] - 请求体（有则按 JSON 发）
 * @returns {Promise.<?Object>} 响应 JSON
 * @throws {Error} 非 2xx 时抛出（带 `status` / `code`）
 */
async function req(method, path, body) {
  /** @type {Object} */
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opt);
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((j && j.error) || `HTTP ${r.status}`);
    e.status = r.status;
    e.code = (j && j.code) || '';
    throw e;
  }
  return j;
}

/** `/api/secrets/open` 的结果（打开成功前只有它） @type {?Object} */
let info = null;

/** 当前用来解密的钥匙编号（`''` = 还没打开；等于 `info.session.kid` 表示用本账号主密码） */
let heldKid = '';

/** 已经播过的媒体元素（离开页面时要 pause ＋ 清 src） @type {?HTMLMediaElement} */
let liveMedia = null;

/**
 * 功能：把顶栏的状态徽标改成某个样子。
 * @param {string} text - 文案
 * @param {string} [tone] - `''` / `'ok'` / `'bad'`
 * @returns {void}
 */
function setState(text, tone) {
  const el = $('state');
  if (!el) return;
  el.textContent = text;
  el.className = `op-state${tone ? ' ' + tone : ''}`;
}

/**
 * 功能：在主区上方显示一块说明（可带按钮）。
 * @param {string} html - 说明正文（**可含 HTML**，调用方保证已转义）
 * @param {Array.<{label: string, onclick: Function, danger?: boolean}>} [acts] - 按钮
 * @returns {void}
 */
function showNote(html, acts) {
  const box = $('note');
  const txt = $('noteText');
  const bar = $('noteActs');
  if (!box || !txt || !bar) return;
  txt.innerHTML = html;
  bar.innerHTML = '';
  (acts || []).forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `op-btn${a.danger ? ' danger' : ''}`;
    b.textContent = a.label;
    b.onclick = a.onclick;
    bar.appendChild(b);
  });
  bar.hidden = !(acts || []).length;
  box.hidden = false;
}

/**
 * 功能：藏起所有卡片，只留一块（`null` = 全藏）。
 * @param {?string} id - `'note'` / `'lock'` / `'view'`
 * @returns {void}
 */
function only(id) {
  ['note', 'lock', 'view'].forEach((k) => {
    const el = $(k);
    if (el) el.hidden = k !== id;
  });
}

/**
 * 功能：渲染顶栏的文件名与元信息（大小 / 来源账号）。
 * @returns {void}
 */
function renderHead() {
  const name = (info && info.name) || '加密附件';
  const bits = [];
  if (info && info.size) bits.push(fmtSize(info.size));
  if (info && info.owner_uid) {
    bits.push(`来自账号「${info.same_account ? '本账号' : String(info.owner_uid)}」`);
  }
  const at = info && info.at ? String(info.at) : '';
  if (at) bits.push(at);
  const n = $('fname');
  const m = $('fmeta');
  if (n) n.textContent = name;
  if (m) m.textContent = bits.join(' · ');
  document.title = `${name} · ZXDesk 加密文件`;
}

/**
 * 功能：解出预览地址（同一把钥匙的那一条）。
 * @returns {string} 绝对 URL
 */
function fileUrl() {
  const p = `path=${encodeURIComponent(filePath)}`;
  const k = heldKid ? `&kid=${encodeURIComponent(heldKid)}` : '';
  return `${BASE}/api/secrets/open/file?${p}${k}`;
}

/**
 * 功能：工作台的地址（本页所在的同一应用根）。
 * @returns {string} 绝对 URL
 */
function workbenchUrl() {
  return `${BASE}/`;
}

/**
 * 功能：新窗口打开工作台；被浏览器拦截就退化成同窗跳转。
 *
 * 说明：⭐ 0.9.8 第 7 轮（方案 §14.6.1.1）：阅读器打开一个「本机没有钥匙」的文件时，
 *      最省事的解法是**让文件所属账号自己去工作台解锁** —— 但原页面连个入口都没有，
 *      用户只能自己猜「是不是要先登录一下」。⛔ 别把「去解锁」写成一句说明就完事。
 * @returns {void}
 */
function goWorkbench() {
  try {
    const w = window.open(workbenchUrl(), '_blank', 'noopener');
    if (w) return;
  } catch (_e) {
    /* 被拦截：下面同窗跳 */
  }
  location.replace(workbenchUrl());
}

/**
 * 功能：底栏显不显示（`下载明文` 只在预览态出现）。
 *
 * 说明：⭐ 方案 §14.6.1.4：只要文件读出来了，底栏就留着 —— 否则锁屏态下
 *      「使用密钥解锁」根本点不到（那颗按钮就在底栏上）。
 * @param {boolean} withDownload - 是否连「下载明文」一起显示
 * @returns {void}
 */
function showFoot(withDownload) {
  const foot = $('foot');
  const dl = $('dl');
  if (foot) foot.hidden = false;
  if (dl) dl.hidden = !withDownload;
}

/**
 * 功能：渲染解锁卡（选钥匙 ＋ 输主密码）。
 *
 * 说明：⭐ 候选顺序由**服务端**给（`session` 本账号 ＋ 已导入的钥匙），这里只照做：
 *      · 只有一把 → 默认选它，不显示下拉；
 *      · 一把都没有 → 直接给「使用密钥解锁 / 去工作台」两条路，⛔ 不画一个点了必错的输入框。
 * @returns {void}
 */
function renderLock() {
  only('lock');
  showFoot(false);
  const hint = $('lockHint');
  const row = $('keyRow');
  const pick = $('keypick');
  const err = $('err');
  const keyInfo = $('keyInfo');
  if (keyInfo) keyInfo.hidden = true;
  const cands = [];
  if (info && info.session && info.session.kid) {
    cands.push({ kid: info.session.kid, label: '本账号的主密码', held: info.session.held });
  }
  (info && info.keys ? info.keys : []).forEach((k) => {
    const who = k.owner_name || (k.owner_uid ? `账号 ${k.owner_uid}` : '未知账号');
    cands.push({
      kid: k.kid,
      label: `已导入的钥匙 · 来自「${who}」${k.held ? '（刚刚输过）' : ''}`,
      held: k.held,
    });
  });
  if (!cands.length) {
    only('note');
    showFoot(false);
    showNote(
      '本机没有能开这个文件的钥匙。<br />' +
        '如果你是<b>这个文件所属的账号</b>，可以先去 ZXDesk 工作台解锁；或者用钥匙文件解锁。',
      [
        { label: '前往 ZXDesk 工作台', onclick: () => goWorkbench() },
        { label: '使用密钥解锁', onclick: () => renderKeyFlow() },
        { label: '重试', onclick: () => load() },
      ],
    );
    setState('没有可用的钥匙', 'bad');
    return;
  }
  if (hint) {
    hint.innerHTML =
      (cands.length > 1
        ? '这个文件可以用下面的钥匙打开 —— 选一把，再输入它的 <b>主密码</b>。'
        : '输入<b>主密码</b>即可解密这个文件（密码只在本次请求里用，不会被保存）。') +
      // ⭐ 方案 §14.6.1.1：本账号的文件其实还有一条更省事的路，说一句就够，别喧宾夺主
      '<br /><span class="op-sub">如果是你本账号的文件，也可以先去 <b>ZXDesk 工作台</b>解锁，回来会自动刷新。</span>';
  }
  if (pick) {
    pick.innerHTML = cands
      .map((c) => `<option value="${esc(c.kid)}">${esc(c.label)}</option>`)
      .join('');
  }
  if (row) row.hidden = cands.length < 2;
  if (err) err.hidden = true;
  const btn = $('unlock');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '打开';
    // ⚠️ ⭐ 这里必须**每次重设**：`renderImport()` / `renderKeyFlow()` 会把 onclick 换成导入逻辑，
    //    回不到这里就会「点打开却在导入」（原实现靠导入后立刻关页避开了这个坑，现在不能关）
    btn.onclick = () => unlockWithPassword();
  }
  setState('🔒 需要主密码');
  const pw = $('pw');
  if (pw) {
    pw.value = '';
    setTimeout(() => pw.focus(), 30);
  }
}

/**
 * 功能：用当前选的钥匙 ＋ 输入的主密码打开这个文件（`#unlock` 的默认动作）。
 * @returns {Promise.<void>}
 */
async function unlockWithPassword() {
  const pick = $('keypick');
  const pw = $('pw');
  const err = $('err');
  const btn = $('unlock');
  const kid = pick && $('keyRow') && !$('keyRow').hidden ? String(pick.value || '') : '';
  if (!pw || !pw.value) {
    if (err) {
      err.textContent = '请先输入主密码';
      err.hidden = false;
    }
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在打开…';
  }
  try {
    const r = await req('POST', '/api/secrets/open/key', {
      path: filePath,
      password: pw.value,
      kid,
    });
    heldKid = String((r && r.kid) || kid || '');
    if (err) err.hidden = true;
    await renderPreview();
  } catch (e) {
    if (err) {
      err.textContent = e.message || '打不开这个文件';
      err.hidden = false;
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = '打开';
    }
  }
}

/**
 * 功能：按服务端给的 `Content-Type` 渲染预览。
 *
 * 说明：⭐ 先发一次 `Range: bytes=0-0` 问出真实的 `Content-Type`（服务端按**解密后的首帧**
 *      嗅探，唯一可信来源）；拿不到就退化成「只能下载」，⛔ 不猜类型。
 * @returns {Promise.<void>}
 */
async function renderPreview() {
  const view = $('view');
  const foot = $('foot');
  if (!view) return;
  only('view');
  view.innerHTML = '<div class="op-plain">正在解密…</div>';
  setState('🔓 已解锁', 'ok');
  const url = fileUrl();
  let mime = '';
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin' });
    if (r.ok) mime = String(r.headers.get('content-type') || '').split(';')[0].trim();
  } catch (_e) {
    mime = '';
  }
  view.innerHTML = '';
  if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.alt = (info && info.name) || '加密图片';
    img.src = url;
    view.appendChild(img);
  } else if (mime.startsWith('video/')) {
    const v = document.createElement('video');
    v.controls = true;
    v.preload = 'metadata';
    v.src = url;
    liveMedia = v;
    view.appendChild(v);
  } else if (mime.startsWith('audio/')) {
    const a = document.createElement('audio');
    a.controls = true;
    a.preload = 'metadata';
    a.src = url;
    liveMedia = a;
    view.appendChild(a);
  } else if (mime === 'application/pdf') {
    const f = document.createElement('iframe');
    f.title = (info && info.name) || '加密 PDF';
    f.src = url;
    view.appendChild(f);
  } else {
    const p = document.createElement('div');
    p.className = 'op-plain';
    p.innerHTML = '这个格式不能直接在页面里预览。<br />点下面的「下载明文」把它存下来再打开。';
    view.appendChild(p);
  }
  if (foot) foot.hidden = false;
  showFoot(true);
  showTipOnce();
}

/**
 * 功能：一次性提示「怎么设为默认打开方式」（老大的截图动线）。
 *
 * 说明：⚠️ 只提示一次（`localStorage` 记住）：这是一句操作引导，反复出现就是骚扰。
 *      键名带 `zxdesk.` 前缀，与 `core/cache.js` 的离线快照区分开。
 * @returns {void}
 */
function showTipOnce() {
  const el = $('tip');
  if (!el) return;
  try {
    if (localStorage.getItem('zxdesk.reader.tip') === '1') return;
  } catch (_e) {
    return;
  }
  el.hidden = false;
  el.style.cursor = 'pointer';
  el.title = '点一下就不再提示';
  el.onclick = () => {
    el.hidden = true;
    try {
      localStorage.setItem('zxdesk.reader.tip', '1');
    } catch (_e) {
      /* 存储不可用：下次还会提示，不是缺陷 */
    }
  };
}

/**
 * 功能：读 `/api/secrets/open`，按结果决定「直接预览 / 要密码 / 要授权 / 报错」。
 * @returns {Promise.<void>}
 */
async function load() {
  only('note');
  showNote('正在读取这个文件…');
  setState('正在读取');
  try {
    info = await req('GET', `/api/secrets/open?path=${encodeURIComponent(filePath)}`);
  } catch (e) {
    info = null;
    if (e.status === 403) {
      setState('需要授权', 'bad');
      showNote(
        '这个文件所在的文件夹还没授权给 ZXDesk —— <b>选一次就行</b>。<br />' +
          '（局域网直连 / 独立客户端里弹不出选择器，请到飞牛网页端的 ZXDesk 里打开这个文件。）',
        [
          { label: '选择这个文件夹', onclick: () => pickFolder() },
          { label: '重试', onclick: () => load() },
        ],
      );
      return;
    }
    setState('打不开', 'bad');
    showNote(esc(e.message || '打不开这个文件'), [
      { label: '重试', onclick: () => load() },
      { label: '关闭', onclick: () => closePage() },
    ]);
    return;
  }
  renderHead();
  if (info.held) {
    heldKid = String(info.held);
    await renderPreview();
    return;
  }
  renderLock();
}

/**
 * 功能：请宿主弹一次目录选择器（选中即完成授权），然后**就地重试**。
 *
 * 说明：⭐⭐ 这是方案 §9.5 的那颗按钮：没有它，用户在「未授权」这一步只能自己去飞牛设置里
 *      翻半天。⛔ SDK 不可用（独立浏览器 / 目录被裁掉）时**不弹错、不画按不动的按钮** ——
 *      调用方给的是「去飞牛网页端打开」的引导，那条路本身是完整的。
 * @returns {Promise.<void>}
 */
async function pickFolder() {
  let sdk = null;
  try {
    const mod = await import(`${BASE}/vendor/trimjs-web-app/index.js`);
    const Ctor = mod.TrimApp || (mod.default && mod.default.TrimApp);
    if (typeof Ctor === 'function') {
      sdk = new Ctor();
      if (sdk.isStandaloneWeb) sdk = null;
    }
  } catch (_e) {
    sdk = null;
  }
  if (!sdk || typeof sdk.pickUserFile !== 'function') {
    showNote(
      '这个环境里弹不出飞牛的文件选择器。<br />' +
        '请到<b>飞牛 App 或网页端的 ZXDesk 工作台</b>里打开这个文件，并在「加密信息 → ⚙ 附件位置」里给它所在的文件夹授权一次。',
      [{ label: '重试', onclick: () => load() }],
    );
    return;
  }
  try {
    const r = await sdk.pickUserFile({
      directory: true,
      title: '选择这个文件所在的文件夹',
      okText: '用这个文件夹',
    });
    if (!r || Number(r.code) !== 0 || !Array.isArray(r.data) || !r.data.length) return;
    // ⚠️ 选完**不在这里改附件根**（那是另一件事）：选择器本身已经完成授权，直接重试即可
    await load();
  } catch (_e) {
    showNote('选择文件夹失败，请再试一次，或到飞牛网页端的 ZXDesk 里打开这个文件。', [
      { label: '重试', onclick: () => load() },
    ]);
  }
}

/**
 * 功能：请用户选一份 `.zxkey`，识别它属于谁，再让他输主密码解锁 —— **一条路三步**。
 *
 * 说明：⭐⭐ 0.9.8 第 7 轮（方案 §14.6.1.2）：原来是两颗按钮两条路
 *      （「导入钥匙文件…」直接落库、「换一把钥匙」只是重画解锁卡），谁也开不了打不开的文件。
 *      现在合并成：① 选文件 → ② `POST /api/vault/key/inspect`（**不验密码**，只回
 *      账号 / 编号 / 导出日期 / 本机有没有）→ ③ 输主密码 → `import`（幂等、当场 hold）
 *      → **直接 `load()` 打开这个文件**（⛔ 不再弹「已导入，请关闭页面」那种没用的话）。
 *      ⚠️ `.zxkey` 的原文只在页面内存里，`import` 完即丢；`inspect` 不落库。
 * @returns {void}
 */
function renderKeyFlow() {
  const pick = $('keyfile-pick');
  if (!pick) return;
  pick.value = '';
  pick.onchange = async () => {
    const f = pick.files && pick.files[0];
    if (!f) return;
    let text;
    try {
      text = await f.text();
    } catch (_e) {
      showNote('这个文件读不出来，请重新选一次。', [{ label: '重试', onclick: () => renderKeyFlow() }]);
      return;
    }
    only('lock');
    showFoot(false);
    setState('正在识别钥匙');
    if ($('fname')) $('fname').textContent = '使用密钥解锁';
    if ($('fmeta')) $('fmeta').textContent = '钥匙文件（.zxkey）';
    if ($('lockHint')) $('lockHint').textContent = '正在识别这份钥匙…';
    let r = null;
    let bad = '';
    try {
      r = await req('POST', '/api/vault/key/inspect', { file: text });
    } catch (e) {
      bad = e.message || '这不是一个有效的钥匙文件';
    }
    showKeyUnlock(text, r, bad);
  };
  pick.click();
}

/**
 * 功能：把「识别结果 ＋ 主密码框」画出来（`renderKeyFlow()` 的第 2、3 步）。
 * @param {string} text - `.zxkey` 的原文（只在内存里，提交完即丢）
 * @param {?Object} r - `inspect` 的结果；`null` 表示识别失败
 * @param {string} bad - 识别失败时的原因（空串表示没问题）
 * @returns {void}
 */
function showKeyUnlock(text, r, bad) {
  only('lock');
  showFoot(false);
  if ($('fname')) $('fname').textContent = '使用密钥解锁';
  if ($('fmeta')) $('fmeta').textContent = '钥匙文件（.zxkey）';
  if ($('keyRow')) $('keyRow').hidden = true;
  const infoEl = $('keyInfo');
  const hint = $('lockHint');
  const err = $('err');
  const btn = $('unlock');
  if (err) err.hidden = true;

  if (!r) {
    // ⚠️ 识别失败：**不画密码框**（输了也没用），只留一句原因与重选
    setState('不是有效的钥匙', 'bad');
    if (hint) hint.textContent = bad || '这不是一个有效的钥匙文件';
    if (infoEl) infoEl.hidden = true;
    if ($('pw') && $('pw').parentNode) $('pw').parentNode.hidden = true;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重新选择钥匙文件';
      btn.onclick = () => {
        if ($('pw') && $('pw').parentNode) $('pw').parentNode.hidden = false;
        renderKeyFlow();
      };
    }
    return;
  }

  const who = r.owner_name || (r.owner_uid ? `账号 ${r.owner_uid}` : '未知账号');
  const date = String(r.created_at || '').slice(0, 10);
  setState('已识别钥匙', 'ok');
  if (hint) hint.textContent = '输入这把钥匙的主密码，就能打开这个文件。';
  if (infoEl) {
    infoEl.hidden = false;
    // 归属提醒：钥匙属于 A、文件属于 B 时**先提醒**，别等输完密码再说「打不开」
    const mine = info && info.owner_uid != null && r.owner_uid != null && Number(r.owner_uid) === Number(info.owner_uid);
    const warn = info && info.owner_uid != null && r.owner_uid != null && !mine;
    infoEl.innerHTML =
      `已识别：来自账号「${esc(who)}」的钥匙 · 编号 ${esc(String(r.kid || ''))}` +
      (date ? ` · ${esc(date)} 导出` : '') +
      (r.already ? '<br />这把钥匙本机已有，输入主密码即可。' : '') +
      (warn
        ? `<br /><span class="op-warnline">这把钥匙属于账号「${esc(who)}」，这个文件属于账号「${esc(
            String(info.owner_uid),
          )}」，可能打不开。</span>`
        : '');
  }
  if ($('pw') && $('pw').parentNode) $('pw').parentNode.hidden = false;
  if ($('pw')) $('pw').value = '';
  if (btn) {
    btn.disabled = false;
    btn.textContent = '解锁';
    btn.onclick = async () => {
      const pw = $('pw');
      if (!pw || !pw.value) {
        if (err) {
          err.textContent = '请先输入主密码';
          err.hidden = false;
        }
        return;
      }
      btn.disabled = true;
      btn.textContent = '正在解锁…';
      try {
        await req('POST', '/api/vault/key/import', { file: text, password: pw.value });
        // ⭐ 导入成功**直接接着开这个文件**（不再弹「已导入，请关闭页面」）
        await load();
      } catch (e) {
        if (err) {
          err.textContent = e.message || '解锁失败';
          err.hidden = false;
        }
        btn.disabled = false;
        btn.textContent = '解锁';
      }
    };
  }
  if ($('pw')) setTimeout(() => $('pw').focus(), 30);
}

/**
 * 功能：渲染「导入钥匙文件」的路（`.zxkey` 双击进来时走它）。
 *
 * 说明：⭐ 页面**读不到**本机任意文件（那是浏览器的硬边界），所以这里让用户再选一次同一份
 *      `.zxkey` —— 选中后由浏览器把内容交给页面，页面只把它 POST 给服务端校验。
 *      ⛔ 不为了「省一次选文件」去开一个「服务端按路径读文件」的接口：那等于给阅读器
 *      开第二个读盘原语，收益一条、代价一整类。
 * @returns {void}
 */
function renderImport() {
  only('lock');
  showFoot(false);
  if ($('fname')) $('fname').textContent = '导入钥匙文件';
  if ($('fmeta')) $('fmeta').textContent = '钥匙文件（.zxkey）＝ 你全部加密数据的总钥匙，请与附件分开保管';
  setState('导入钥匙');
  const hint = $('lockHint');
  if (hint) {
    hint.innerHTML =
      '选一份 <b>.zxkey</b>，再输入它对应的<b>主密码</b>。导入后本机就能打开这把钥匙加密的文件了。';
  }
  if ($('keyRow')) $('keyRow').hidden = true;
  if ($('keyInfo')) $('keyInfo').hidden = true;
  const pick = $('keypick');
  if (pick) pick.innerHTML = '';
  // ⭐ 0.9.8 第 7 轮：选择框已常驻在 `index.html`（`#keyfile-pick`），⛔ 不再动态插一个
  const fileBox = $('keyfile-pick');

  const btn = $('unlock');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '导入';
    btn.onclick = async () => {
      const pw = $('pw');
      const err = $('err');
      if (!fileBox || !fileBox.files || !fileBox.files.length) {
        if (err) {
          err.textContent = '请先选一份 .zxkey 文件';
          err.hidden = false;
        }
        return;
      }
      btn.disabled = true;
      btn.textContent = '正在导入…';
      try {
        const text = await fileBox.files[0].text();
        const r = await req('POST', '/api/vault/key/import', { file: text, password: pw ? pw.value : '' });
        only('note');
        setState('已导入', 'ok');
        showNote(
          `钥匙已导入${r && r.already ? '（本来就在本机）' : ''}。<br />` +
            '现在打开对应的 <b>.zxdesk</b> 文件时就能选它了。',
          [{ label: '了解', onclick: () => closePage() }],
        );
      } catch (e) {
        if (err) {
          err.textContent = e.message || '导入失败';
          err.hidden = false;
        }
        btn.disabled = false;
        btn.textContent = '导入';
      }
    };
  }
  // 选文件的入口：点标题旁边那块（`#fname` 已是纯文本，这里用整张卡的「钥匙文件」标签）
  if (fileBox && !$('importPickBtn')) {
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'op-btn';
    label.id = 'importPickBtn';
    label.textContent = '选择钥匙文件（.zxkey）';
    label.onclick = () => fileBox.click();
    const box = $('lock');
    if (box) box.insertBefore(label, btn || null);
  } else if ($('importPickBtn')) {
    $('importPickBtn').onclick = () => fileBox && fileBox.click();
  }
  const title = $('fname');
  if (title) title.textContent = '导入钥匙文件';
}

/**
 * 功能：关掉这一页（窗口内打开的窗口优先真关，否则回工作台）。
 * @returns {void}
 */
function closePage() {
  stopMedia();
  try {
    window.close();
  } catch (_e) {
    /* 不是脚本打开的窗口：下面兜底 */
  }
  setTimeout(() => {
    // ⚠️ `window.close()` 对「用户直接打开的标签」无效时，回到**打开它的那一屏**比停在这一页好。
    //    ⭐ `back` 是打开方带过来的相对路径（如 `/?goto=lab:secrets`）——
    //    只回 `${BASE}/` 的话，人会被丢回工作台首页，而他原来在看加密信息。
    let back;
    try {
      back = new URLSearchParams(location.search).get('back') || '';
    } catch (_e) {
      back = '';
    }
    back = String(back || '');
    // ⚠️ 只接受「本站相对路径」：`back` 走的是 URL，⛔ 不能变成开放跳转
    if (!back.startsWith('/') || back.startsWith('//')) back = '';
    location.replace(`${BASE}${back || '/'}`);
  }, 60);
}

/**
 * 功能：把正在播的媒体停下来并把 `src` 清掉（否则离开页面后它仍连着解密流）。
 * @returns {void}
 */
function stopMedia() {
  if (!liveMedia) return;
  try {
    liveMedia.pause();
    liveMedia.removeAttribute('src');
    liveMedia.load();
  } catch (_e) {
    /* 已经没了 */
  }
  liveMedia = null;
}

/**
 * 功能：没有 `?path=` 时的入口 —— 让用户直接把文件路径粘进来（**加密信息工具条那颗「阅读器」**的后半程）。
 *
 * 说明：⭐⭐ 2026-11-09（老大）：「在【加密信息】模块中显示按键【阅读器】，点击可以选择文件进行查看」。
 *      正常路径是「点阅读器 → 飞牛选择器 → 带 `?path=` 跳到这里」；但**选择器可能永远不回话**
 *      （宿主不应答 / 独立浏览器），那时用户手里明明有这个文件却打不开它。
 *      所以这一页在没有路径时给一个「粘贴路径」的入口 —— 它是这条链路上最后一根能抓的绳子。
 *      ⚠️ 提交后走 `location.replace()` **整页重来**，而不是就地改状态：`?path=` 是这一页唯一的输入，
 *      重来一遍能让「文件名 / 元信息 / 解锁 / 预览」都走同一条初始化路，⛔ 不必给「二次进入」补一堆分支。
 * @returns {void}
 */
function renderPickPath() {
  only('note');
  setState('选择文件');
  showNote(
    '在「加密信息」里点 <b>阅读器</b> 选一个加密文件；也可以把它的完整路径粘在下面' +
      '（例如 <code>/vol1/1000/…/12.zxdesk</code>）。<br />' +
      '⚠️ 只能打开<b>授权目录</b>里的文件 —— 路径不对会明确告诉你差在哪一步。',
    [
      {
        label: '打开',
        onclick: () => {
          const el = $('op-path');
          const v = el ? String(el.value || '').trim() : '';
          if (!v) {
            setState('请先填文件路径', 'bad');
            if (el) el.focus();
            return;
          }
          location.replace(`${location.pathname}?path=${encodeURIComponent(v)}`);
        },
      },
      { label: '打开工作台', onclick: () => location.replace(`${BASE}/`) },
    ],
  );
  // ⚠️ 输入框要**在 `showNote()` 之后**插：它会把 `#noteText` 的 innerHTML 整个换掉
  const txt = $('noteText');
  if (txt) {
    const wrap = document.createElement('label');
    wrap.className = 'op-field';
    wrap.innerHTML = '<span>文件路径</span><input id="op-path" type="text" autocomplete="off" ' +
      'spellcheck="false" placeholder="/vol1/1000/…/12.zxdesk" />';
    txt.appendChild(wrap);
    const input = $('op-path');
    if (input) {
      // 回车即打开（与解锁卡同一个习惯：这里只有一件事可做）
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const btn = $('noteActs') ? $('noteActs').querySelector('.op-btn') : null;
          if (btn) btn.click();
        }
      });
      setTimeout(() => input.focus(), 30);
    }
  }
}

/**
 * 功能：页面初始化 —— 按路径后缀分两条路（`.zxkey` 导入 / 其它一律当加密文件）。
 * @returns {void}
 */
function init() {
  if (!filePath) {
    renderPickPath();
    return;
  }
  if (/\.zxkey$/i.test(filePath)) {
    renderImport();
    return;
  }
  const btn = $('unlock');
  if (btn) {
    // ⭐ 0.9.8 第 7 轮：抽成 `unlockWithPassword()`，`renderLock()` 每次都会重设同一份
    //    （`renderImport()` / `renderKeyFlow()` 会把 onclick 换成导入逻辑，必须能换回来）
    btn.onclick = () => unlockWithPassword();
    // 回车即提交（只输密码时要按一下按钮才动，是没必要的摩擦）
    const pw = $('pw');
    if (pw) {
      pw.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          btn.click();
        }
      });
    }
  }
  const dl = $('dl');
  if (dl) {
    dl.onclick = () => {
      const a = document.createElement('a');
      a.href = fileUrl();
      a.download = (info && info.name) || '加密附件';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  }
  const rekey = $('rekey');
  if (rekey) {
    // ⭐⭐ 0.9.8 第 7 轮（方案 §14.6.1.4）：文案与行为一起换。
    //    以前叫「换一把钥匙」，点一下只是把解锁卡重画一遍 —— 本机没有钥匙时它什么也解决不了。
    //    现在点它 = 「选一份 .zxkey → 识别 → 输密码 → 直接打开这个文件」。
    rekey.onclick = () => renderKeyFlow();
  }
  const closeBtn = $('close');
  if (closeBtn) closeBtn.onclick = () => closePage();
  window.addEventListener('pagehide', stopMedia);
  // ⭐⭐ 0.9.8 第 7 轮（方案 §14.6.1.1）：从工作台解锁完切回来要**自动刷新** ——
  //    否则用户得自己找「重试」，而那颗按钮在锁屏卡上、不一定看得见。
  //    ⚠️ 只在「还没进预览」时刷：正在看视频时切走再回来不该把它重载。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (liveMedia) return;
    const onPreview = $('view') && !$('view').hidden;
    if (onPreview) return;
    load();
  });
  load();
}

init();
