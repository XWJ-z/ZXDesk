/**
 * modules/lab/mobile.js —— 「zx 实验室」那一屏（手机版，0.9.8）
 *
 * 功能：与电脑版**同形同义** —— 这一屏分两层：
 *      ① **卡片首页**：每个实验功能一张卡（图标 / 名字 / 一句说明 / 「实验中」角标），点卡片进入；
 *      ② **实验视图**：`#lab-body` 里只有一块 `#lab-host`，把**那个模块自己的片段**挂进去
 *         （`core/slots.js` 的 `mountModuleSlot()`）；「返回 ＋ 实验名 ＋ 设计说明」那一条
 *         住第一行的静态槽 `#lab-bar`，与三入口**二选一**（进实验藏三入口）。
 *
 * ⭐⭐ **为什么是卡片、不是一进来就直达**（老大 2026-11-07：「实验室不是只有一个功能，后面还有其他的。
 *    每个实验室模块都要有一个卡片进入」）：实验会越加越多，「只有一个时自动直达」在第二个实验落地那天
 *    就变成「用户不知道这里还有别的东西」。卡片是**可增长的入口形态**。
 *    ⚠️ 所以 `cur === ''` 是**首页**（不是「还没定」），⛔ 别再改回「只有一个就直达」。
 *
 * ⚠️⭐ **药丸只在实验视图里出现，且只在 ≥2 个实验时才画**。它住 `#lab-body` **外面**的静态槽
 *    （`#lab-tabs`，`mobile/index.html` 里的第一行）—— 手机端的标题在全局固定顶栏里，塞不进药丸。
 *    ⛔ 不许把它放进 `#lab-body`：后者每挂一次就被整块清掉，药丸会跟着一起没。
 *
 * ⚠️⭐ **项一个都不许写死**：名字 / 图标 / 顺序 / 说明 / 「关没关」全从
 *    `slotDefs(state.modules, uiOf, state.me)` 来（说明在接线表的 `lab.desc`）。
 *
 * ⚠️⭐ **0 个实验时必须给一句空状态**（「这里将来放实验功能」），⛔ 不许空白屏。
 *
 * ⚠️⭐ **本文件刻意不 import `mobile/app.js`**（那会绕成环）：宿主用**动态** `import()` 调
 *    `openLab()`（静态 import 会让「删掉本目录」把宿主页一起打挂，与「删目录验收」冲突）。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/28-实验室.md、docs/公共/开发方案/41-zx实验室.md、13-决策记录.md（决策 21 / 143）
 */

import { GROUP_NO, qrBlockHtml } from '../../core/about.js';
import { api } from '../../core/api.js';
import { esc } from '../../core/dom.js';
import { mountModuleSlot, slotDefs } from '../../core/slots.js';
import { uiOf } from '../../mobile/modules.js';
import { state } from '../../mobile/state.js';
import { closeSheet, openSheet, toast, unlockSheet } from '../../mobile/ui.js';
import { LAB_DOC_TITLE, agreementHtml } from './agreement.js';

/** 药丸 / 卡片要认清的槽名（与两端接线表里各实验功能声明的那个**逐字一致**） */
const SLOT = 'lab-pane';

/** 当前视图：`''` = **卡片首页**；否则 = 某个实验的模块名 */
let cur = '';

/** 上一次画出来的指纹（卡片集合 ＋ 文案）—— 只在**内容真的变了**时重挂 */
let painted = '';

/**
 * 功能：算一遍实验清单 —— 「清单 ∩ 本端接线表 ∩ 该模块没被关掉」，顺序跟清单走。
 * @returns {Array.<Object>} `moduleItems()` 条目
 */
function itemsOf() {
  return slotDefs(state.modules, uiOf, state.me).filter((it) => it.slots.includes(SLOT));
}

/**
 * 功能：一份能判断「卡片内容变没变」的指纹（名字 ＋ 标题 ＋ 说明 ＋ 图标）。
 * @returns {string} 指纹
 */
const fingerprintOf = () =>
  itemsOf()
    .map((it) => `${it.name}|${it.title}|${it.icon || ''}|${(it.lab && it.lab.desc) || ''}`)
    .join(',');

/**
 * 功能：画药丸（**只在实验视图里、且 ≥2 个实验时**）—— 屏内快速切换。
 * @param {Array.<Object>} items - `itemsOf()` 的产物
 * @param {string} on - 当前实验的模块名
 * @returns {string} 药丸的 HTML（只有一项时返回空串 —— 整条不画）
 */
function pillHtml(items, on) {
  if (items.length < 2) return '';
  // ⚠️ 类名与网址/密码夹那颗**逐字一致**（`.dash-tabs` / `.dash-tab`，手机端与电脑端共用同一套版式）
  //    —— ⛔ 别用 `.pill`：那是任务卡的标签角标，语义与版式都不是这一档。
  return `<div class="dash-tabs" role="tablist">${items
    .map(
      (it) =>
        `<button class="dash-tab${it.name === on ? ' on' : ''}" type="button" role="tab" ` +
        `aria-selected="${it.name === on}" data-lab-view="${esc(it.name)}">` +
        `${esc(it.title)}</button>`,
    )
    .join('')}</div>`;
}

/**
 * 功能：**0 个实验**时的空状态文案（⛔ 不许空白屏）。
 * @returns {string} 空状态的 HTML
 */
function emptyHtml() {
  return `<div class="empty">
      <div class="empty-ico">🧪</div>
      <div class="empty-title">这里将来放实验功能</div>
      <div class="empty-text">新功能会先放进实验室试一段时间：可能变、也可能撤。它们的数据单独存放，不碰你平时用的数据；关掉这个模块，里面的内容也一条不删。</div>
    </div>`;
}

/**
 * 功能：**卡片首页** —— 每个实验功能一张卡，点进去就是那个实验。
 *
 * 说明：⭐ 说明文字来自接线表的 `lab.desc`（纯数据，两端逐字一致，`module-ui.test.js` 钉住）。
 * @param {Array.<Object>} items - `itemsOf()` 的产物
 * @returns {string} 卡片区的 HTML
 */
function cardsHtml(items) {
  return `<div class="lab-cards">${items
    .map(
      (it) =>
        `<button class="lab-card" type="button" data-lab-open="${esc(it.name)}">` +
        `<span class="lab-card-ico" aria-hidden="true">${esc(it.icon || '🧪')}</span>` +
        `<span class="lab-card-main"><b>${esc(it.title)}</b>` +
        `<small>${esc((it.lab && it.lab.desc) || '')}</small></span>` +
        `<span class="lab-card-badge">实验中</span></button>`,
    )
    .join('')}</div>`;
}

/**
 * 功能：**实验视图**的挂载容器 —— 只剩一块 `#lab-host`。
 *
 * 说明：⚠️⭐ 返回键 / 实验名 / 设计说明住第一行的 `#lab-bar`（见 `barHtml()`）：
 *      画在 `#lab-body` 里会跟着每次挂载整块重画，也没法与三入口共用同一条基线。
 * @returns {string} 容器 HTML
 */
function paneHtml() {
  return '<div id="lab-host" class="lab-host"></div>';
}

/**
 * 功能：**第一行那一条** —— `‹ 返回` ＋ 实验名 ＋ （可选）`设计说明`。
 *
 * 说明：⭐⭐ 老大提的是「进入每一个实验室模块过后顶部都固定显示：返回、【加密信息】设计说明」。
 *      手机端屏幕窄，这一条与三入口**不同时出现**（进实验只留这条，见 `paint()`）：
 *      四条控件挤两行，返回键会离拇指更远。
 *      ⚠️ 名字过长省略（`text-overflow`）而不换行：换行会把整条顶到第二行、按钮跑位。
 * @param {Object} it - 当前实验的 `moduleItems()` 条目
 * @returns {string} 条的 HTML
 */
function barHtml(it) {
  const name = it ? String(it.name) : '';
  const design =
    it && it.lab && it.lab.design === true
      ? `<button class="lab-doc-btn lab-cat-doc" type="button" data-lab-doc="${esc(name)}">设计说明</button>`
      : '';
  return (
    // ⭐ 0.9.8 第 7 轮：返回＝蓝（导航）。原来它是品牌色纯文字，与三入口那排灰药丸
    // 属于「两套实现碰巧不一样」，不是按类别分色 —— 换个屏颜色又变了，用户学不到含义。
    `<button class="lab-back lab-cat-nav" type="button" data-lab-back="1">‹ 返回</button>` +
    `<span class="lab-bar-title">${esc(it ? it.title : '')}</span>` +
    design
  );
}

/**
 * 功能：把 `#lab-bar` 画出来，并决定这一行归谁（`null` ＝ 清空、三入口回来）。
 *
 * 说明：⚠️ 三入口的显隐用 `hidden` **属性**切换（`[hidden]{display:none !important}` 在
 *      `app.css` 顶部兜着），⛔ 不清它的 `innerHTML` —— 那会连带丢掉挂在它上面的委托。
 * @param {?Object} it - 当前实验的条目；`null` 清空
 * @returns {void}
 */
function paintBar(it) {
  const bar = document.getElementById('lab-bar');
  const tools = document.getElementById('lab-tools');
  if (bar) bar.innerHTML = it ? barHtml(it) : '';
  if (tools) tools.hidden = !!it;
}

/**
 * 功能：**首次进入**实验室的那道门 —— 弹出知情协议，勾选之后「同意」才可点。
 *
 * 说明：⭐⭐ 老大 2026-11-08：「首次进入实验室应该弹出知情协议，勾选过后才能点同意」
 *      ＋ 两条拍板：**不可关**（点遮罩 / 关闭键 / 安卓返回键都不生效）与
 *      **按账号记在服务端**（`users.lab_agreed`，换设备不再问）。
 *      ⇒ `openSheet(..., { locked: true })`：那三条关闭通路在 `ui.js` 里被挡住
 *      （`closeSheet()` 直接返回；`app.js` 的返回键那一段见到锁会补回历史），
 *      唯一出口是「同意」那一支（先 `unlockSheet()` 再关）。
 *
 * ⚠️ 与顶部那颗「知情协议」按钮**不是一回事**：那一颗是随时重看（「我已知晓」、可关），
 *    这一道是首次准入（锁着、必须勾选）。两份正文同一个源（`./agreement.js`）。
 * @returns {void}
 */
function openAgreementGate() {
  openSheet(
    LAB_DOC_TITLE,
    agreementHtml() +
      `<label class="vault-confirm lab-agree-ack">
         <input id="lab-agree-ack" type="checkbox" />我已阅读并理解上述内容
       </label>`,
    '<button class="btn primary" type="button" id="lab-agree-go" disabled>同意</button>',
    { locked: true },
  );
  const box = document.getElementById('lab-agree-ack');
  const go = document.getElementById('lab-agree-go');
  // ⚠️ 没勾之前「同意」不可点（`disabled`）—— 这就是老大要的那条判据，不是装饰。
  if (box && go)
    box.addEventListener('change', () => {
      go.disabled = !box.checked;
    });
  // ⚠️ 脚下那颗按钮每次开弹层都重建 ⇒ 委托挂在 `#sheet-foot` 上，且只挂一次
  if (!footBound) {
    footBound = true;
    const foot = document.getElementById('sheet-foot');
    if (foot)
      foot.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('#lab-agree-go') : null;
        if (b) void agreeLab();
      });
  }
}

/** 底部按钮区的委托只挂一次（那几个节点每次开弹层都重建，挂节点上等于白挂） */
let footBound = false;

/**
 * 功能：「同意」—— 写服务端（`PUT /api/auth/prefs {labAgreed:true}`）→ 解锁弹层 → 关掉。
 * @returns {Promise.<void>}
 */
async function agreeLab() {
  const go = document.getElementById('lab-agree-go');
  if (!go || go.disabled) return;
  try {
    const r = await api('PUT', '/api/auth/prefs', { labAgreed: true });
    // ⭐ 接口回的是脱敏后的自己 ⇒ 直接换上，别手搓一份
    if (r && r.user) state.me = r.user;
    unlockSheet();
    closeSheet();
    toast('已同意，可以开始用实验室了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 事件委托**只挂一次**（`#lab-body` 是静态节点，重挂会叠加） */
let bodyBound = false;

/** 第一行 `#lab-bar` 的委托也只挂一次（节点静态、内容每次换） */
let barBound = false;

/**
 * 顶部三入口 —— ⭐⭐ 0.9.8 第 3 轮（方案 §8.3，与电脑版**同形同义**，R-114 两端同改）。
 *
 * 说明：三颗**纯文字**按钮（⛔ 不加图标、⛔ 不加 emoji —— 老大 2026-11-08 拍板「只留文字」），
 *      各开一个宿主底部弹层。文案与电脑端**逐字一致**。
 *
 * ⚠️⭐ 工具条住 `#lab-tools`（`mobile/index.html` 里、`#lab-body` **外面**）—— 后者每挂一次
 *    就被整块清掉，放里面会跟着没。所以：内容由 `openLab()` 画**一次**（⛔ 别放进 `paint()`），
 *    委托也只挂一次。
 * ⚠️ 二维码与群号**不在这里写第二遍**：`core/about.js` 的 `qrBlockHtml()` / `GROUP_NO` 是唯一来源。
 */
const TOOLS = [
  // ⭐⭐ 0.9.8 第 7 轮：改名「实验室设计说明」＋ 按类别着色（与电脑端逐字一致 —— R-114）。
  //    绿＝说明与钥匙、黄＝反馈与联系；蓝（导航）用在屏头的返回键。
  { act: 'agreement', label: '实验室设计说明', cls: 'lab-cat-doc' },
  { act: 'form', label: '反馈调研', cls: 'lab-cat-help' },
  { act: 'group', label: '交流群', cls: 'lab-cat-help' },
];

/** 三颗按钮画过没有（`#lab-tools` 是静态节点，画一次就够） */
let toolsPainted = false;

/** 三颗按钮的委托只挂一次 */
let toolsBound = false;

/**
 * 功能：把三颗按钮画进 `#lab-tools`。
 * @returns {void}
 */
function paintTools() {
  const box = document.getElementById('lab-tools');
  if (!box || toolsPainted) return;
  toolsPainted = true;
  box.innerHTML = TOOLS.map(
    (t) =>
      `<button class="lab-tool ${t.cls}" type="button" data-lab-tool="${t.act}">${t.label}</button>`,
  ).join('');
}

/** 只读弹层脚下那颗「我已知晓」（协议 / 二维码 / 设计说明共用同一颗） */
const SHEET_CLOSE = '<button class="btn primary" type="button" data-act="sheet-close">我已知晓</button>';

/**
 * 功能：开一个入口的弹层（协议 / 反馈调研 / 交流群）。
 * @param {string} act - `agreement` / `form` / `group`
 * @returns {void}
 */
function openTool(act) {
  if (act === 'agreement') {
    openSheet(LAB_DOC_TITLE, agreementHtml(), SHEET_CLOSE);
    return;
  }
  const isGroup = act === 'group';
  const note = isGroup
    ? `扫这个码加入交流群（QQ 群 ${GROUP_NO}）`
    : '遇到问题或想提需求，扫这个码填一下';
  openSheet(
    isGroup ? '交流群' : '问题反馈与调研',
    `<div class="lab-qr">${qrBlockHtml(isGroup ? 'group' : 'form')}<p class="lab-qr-note">${esc(note)}</p></div>`,
    SHEET_CLOSE,
  );
}

/**
 * 功能：开「设计说明」弹层 —— 正文按约定从 `modules/<实验名>/design.js` **动态**取。
 *
 * 说明：⭐⭐ 宿主不认识任何具体实验（与卡片说明走 `lab.desc` 同一条路子）：正文住模块自己的
 *      `design.js`，路径是算出来的，所以静态扫描看不见 —— 由两条测试钉住（存在性 ＋ 导出）。
 *      ⚠️ 必须动态 import：静态 import 会让「删掉某个实验目录」把这一屏整个打挂。
 *      ⚠️ 取不到就**明说**（控制台 ＋ toast），⛔ 不静默空白。
 * @param {string} name - 实验的模块名
 * @returns {Promise.<void>}
 */
async function openDesign(name) {
  const mod = await import(`../${name}/design.js`).catch((e) => {
    console.error(`[lab] 设计说明打不开（modules/${name}/design.js）：`, e);
    return null;
  });
  if (!mod || typeof mod.designHtml !== 'function' || !mod.DESIGN_TITLE) {
    console.error(`[lab] modules/${name}/design.js 没有导出 DESIGN_TITLE ＋ designHtml()`);
    toast('这份设计说明暂时打不开', true);
    return;
  }
  openSheet(mod.DESIGN_TITLE, mod.designHtml(), SHEET_CLOSE);
}

/**
 * 功能：切到某个实验（`''` = 回卡片首页）。
 * @param {string} name - 模块名；空串表示回首页
 * @returns {void}
 */
function pick(name) {
  if (name === cur) return;
  cur = name;
  paint().catch((e) => toast(e.message, true));
}

/**
 * 功能：把药丸 / 卡片 / 当前实验画出来。
 * @param {boolean} [enter] - 是不是「进屏」那一趟（是则槽内不播淡入）
 * @returns {Promise.<void>}
 */
function paint(enter) {
  const tabs = document.getElementById('lab-tabs');
  const body = document.getElementById('lab-body');
  if (!tabs || !body) return Promise.resolve();
  const items = itemsOf();
  const names = items.map((it) => it.name);
  painted = fingerprintOf();
  // ⚠️ 当前实验不在清单里了 ⇒ 回首页（⛔ 不许停在一个不存在的实验上）
  if (cur && !names.includes(cur)) cur = '';
  tabs.innerHTML = cur ? pillHtml(items, cur) : '';
  // ⭐ 0 个实验：给一句空状态（⛔ 不许空白屏），第一行交回三入口
  if (!items.length) {
    paintBar(null);
    body.innerHTML = emptyHtml();
    return Promise.resolve();
  }
  // ⭐ 首页：卡片（第一行是三入口，⛔ 不留返回条）
  if (!cur) {
    paintBar(null);
    body.innerHTML = cardsHtml(items);
    return Promise.resolve();
  }
  // ⭐ 实验视图：第一行画「返回 ＋ 名字 ＋ 设计说明」，三入口让位；正文只挂那个模块自己的片段
  paintBar(items.find((x) => x.name === cur));
  body.innerHTML = paneHtml();
  return mountModuleSlot(body.querySelector('#lab-host'), 'mobile', cur, SLOT, {
    // ⚠️⭐ `container` 必须自己带上（见电脑版同处的说明：片段要靠它先把根节点插进文档）
    container: body.querySelector('#lab-host'),
    end: 'mobile',
    modules: state.modules,
    uiOf,
    me: state.me,
    crossFade: true,
    enterFade: enter !== true,
  });
}

/**
 * 功能：进「zx 实验室」这一屏 —— 画**卡片首页**（或 `opts.slot` 指定的那个实验）。
 *
 * 说明：⚠️ **不换屏**（`switchTab` 由宿主做，见 `mobile/app.js` 的 `render()` 那一支）——
 *      本文件不 import 入口文件，否则成环。
 *
 * @param {{slot?: string}} [opts] - `slot` = 这一次要直接进哪个实验（模块名）；不带就落卡片首页
 * @returns {Promise.<void>}
 */
export async function openLab(opts) {
  // ⚠️ 不带 `slot` 一律回**首页**（⛔ 不是「落第一项」：第二个实验一落地那口径就把人挡在卡片外面了）
  cur = opts && opts.slot ? String(opts.slot) : '';
  painted = fingerprintOf();
  if (!bodyBound) {
    bodyBound = true;
    // 卡片 / 药丸两种点击走**一个**委托，挂在静态的 `#lab-body` 上
    // （⭐ 返回与设计说明在 `#lab-bar` 里，委托也挂在那边 —— 见下面那一段）
    const body = document.getElementById('lab-body');
    if (body)
      body.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        const card = t.closest('[data-lab-open]');
        if (card) return pick(card.getAttribute('data-lab-open'));
        const pill = t.closest('[data-lab-view]');
        if (pill) return pick(pill.getAttribute('data-lab-view'));
      });
  }
  // ⭐⭐ 第一行那条的委托：`#lab-bar` 是**静态节点**（内容每次都换、节点不动）⇒ 挂一次就够
  if (!barBound) {
    barBound = true;
    const bar = document.getElementById('lab-bar');
    if (bar)
      bar.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        if (t.closest('[data-lab-back]')) return pick('');
        const doc = t.closest('[data-lab-doc]');
        if (doc) void openDesign(doc.getAttribute('data-lab-doc'));
      });
  }
  // ⭐⭐ 0.9.8 第 3 轮：顶部三入口（画一次 ＋ 委托只挂一次）—— 它们住 `#lab-body` 外面，
  //    所以**不跟着 `paint()` 走**（每次切实验都重画的话，用户正在看的弹层状态会被搅）。
  paintTools();
  if (!toolsBound) {
    toolsBound = true;
    const tools = document.getElementById('lab-tools');
    if (tools)
      tools.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-lab-tool]') : null;
        if (!b) return;
        openTool(b.getAttribute('data-lab-tool'));
      });
  }
  await paint(true);
  // ⭐⭐ 0.9.8 第 3 轮：**首次进入**先把知情协议摆出来（勾选才能点同意，关不掉）。
  //    判据是账号上的 `lab_agreed`（服务端记的）—— 同意过就再也不弹。
  //    ⚠️ 放在 `paint()` 之后：弹层盖住的是已经画好的实验室，而不是一块空白。
  if (!state.me || !state.me.lab_agreed) openAgreementGate();
}

// ⭐ 设置页里翻动 `hide_lab`（或某个实验功能被关掉）时，卡片与正文要跟着变。
//    ⚠️ 判据是「**指纹真的变了**」—— 没变就什么都不做。
document.addEventListener('zx:prefs-changed', () => {
  if (state.tab !== 'lab') return;
  if (fingerprintOf() === painted) return;
  paint().catch((e) => toast(e.message, true));
});
