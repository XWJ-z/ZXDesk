/**
 * modules/lab/desktop.js —— 「zx 实验室」那一屏（电脑版，0.9.8）
 *
 * 功能：这一屏自己**一条功能都没有** —— 它只是**实验功能**的宿主，分两层：
 *      ① **卡片首页**：每个实验功能一张卡（图标 / 名字 / 一句说明 / 「实验中」角标），点卡片进入；
 *      ② **实验视图**：`#lab-body` 里只有一块 `#lab-host`，把**那个模块自己的片段**挂进去
 *         （`core/slots.js` 的 `mountModuleSlot()`）；「返回 ＋ 实验名 ＋ 设计说明」那一条
 *         住**屏头静态槽 `#lab-bar`**（⊂ `.home-title`），与右侧三入口同一条基线。
 *
 * ⭐⭐ **为什么是卡片、不是一进来就直达**（老大 2026-11-07：「实验室不是只有一个功能，后面还有其他的。
 *    每个实验室模块都要有一个卡片进入」）：实验功能会越加越多，而「只有一个实验时自动直达」
 *    在第二个实验落地的那一天就会变成「用户不知道这里还有别的东西」。
 *    卡片是**可增长的入口形态**：加一个实验就多一张卡，顺序仍由 `module.json` 的 `order` 说了算。
 *    ⚠️ 所以 `cur === ''` 是**首页**（不是「还没定」），⛔ 别再改回「只有一个就直达」。
 *
 * ⚠️⭐ **药丸只在实验视图里出现，且只在 ≥2 个实验时才画**（`#lab-tabs` ⊂ `.home-head`，
 *    在 `#lab-body` **外面** ⇒ 切视图不会把它清掉）。首页不需要它：卡片本身就是入口。
 *    ⛔ 不许把药丸放进 `#lab-body` —— 那里每挂一次就被整块清掉（`webpass` 踩过同一条）。
 *
 * ⚠️⭐ **项一个都不许写死**：名字 / 图标 / 顺序 / 说明 / 「关没关」全从
 *    `slotDefs(state.modules, uiOf, state.me)` 来（说明在接线表的 `lab.desc`）。
 *    ⇒ 实验功能从接线表里撤掉一行，这里自动少一张卡。
 *
 * ⚠️⭐ **0 个实验时必须给一句空状态**（「这里将来放实验功能」），⛔ 不许空白屏。
 *
 * ⚠️ **宿主不 import 任何实验功能**（全部走 `mountModuleSlot()` 的约定式动态 import）：
 *    删掉某个实验模块目录 ⇒ 这一屏照常起、少一张卡（与「删目录验收」同一条纪律）。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/28-实验室.md、docs/公共/开发方案/41-zx实验室.md、13-决策记录.md（决策 21 / 143）
 */

import { GROUP_NO, qrBlockHtml } from '../../core/about.js';
import { api } from '../../core/api.js';
import { esc, fitTabs } from '../../core/dom.js';
import { mountModuleSlot, slotDefs, warmSlots } from '../../core/slots.js';
import { uiOf } from '../../desktop/modules.js';
import { renderSidebar, showView } from '../../desktop/shell.js';
import { state } from '../../desktop/state.js';
import { closeModal, openModal, setModalSave, toast, unlockModal } from '../../desktop/ui.js';
import { LAB_DOC_TITLE, agreementHtml } from './agreement.js';

/** 药丸 / 卡片要认清的槽名（与两端接线表里各实验功能声明的那个**逐字一致**） */
const SLOT = 'lab-pane';

/** 当前视图：`''` = **卡片首页**；否则 = 某个实验的模块名 */
let cur = '';

/** 上一次画出来的指纹（卡片集合 ＋ 文案）—— 只在**内容真的变了**时重挂 */
let painted = '';

/**
 * 功能：算一遍实验清单 —— 「清单 ∩ 本端接线表 ∩ 该模块没被关掉」，顺序跟清单走。
 * @returns {Array.<Object>} `moduleItems()` 条目（带 `slots` / `title` / `icon` / `lab`）
 */
function itemsOf() {
  return slotDefs(state.modules, uiOf, state.me).filter((it) => it.slots.includes(SLOT));
}

/**
 * 功能：一份能判断「卡片内容变没变」的指纹（名字 ＋ 标题 ＋ 说明 ＋ 图标）。
 *
 * 说明：⚠️ 只比名字是不够的：改了说明或换了图标时卡片要跟着重画，
 *      而只比名字会让那次改动「下次进来才生效」（更糟的是永远不生效 —— 用户不会重进）。
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
  // ⭐ 与任务板 / 网址密码夹那两颗**同一个口径**：去掉图标、只画名字；各颗等宽由 `fitTabs()` 撑。
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
 *
 * 说明：⚠️ 三句话与设置卡**同一套口径**（这里是实验区 / 功能可能变、可能撤 / 数据都保留），
 *      因为用户在这里看到的与在设置里看到的必须是同一种承诺。
 * @returns {string} 空状态的 HTML
 */
function emptyHtml() {
  return `<div class="empty-state">
      <div class="es-ico">🧪</div>
      <div class="es-title">这里将来放实验功能</div>
      <div class="es-text">新功能会先放进实验室试一段时间：可能变、也可能撤。它们的数据单独存放，不碰你平时用的数据；关掉这个模块，里面的内容也一条不删。</div>
    </div>`;
}

/**
 * 功能：**卡片首页** —— 每个实验功能一张卡，点进去就是那个实验。
 *
 * 说明：⭐ 说明文字来自接线表的 `lab.desc`（**纯数据**，与 `card.desc` 一样两端逐字一致，
 *      由 `module-ui.test.js` 钉住）。⚠️ 缺了说明只画名字，⛔ 不编默认文案：
 *      编出来的「新功能」三个字对用户没有任何信息量。
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
 * 说明：⚠️⭐ 这里**刻意只有容器**：返回键 / 实验名 / 设计说明都住屏头的 `#lab-bar`（见 `barHtml()`）。
 *      以前那条面包屑画在 `#lab-body` 里，于是它天生比右侧三入口低一整行、还跟着每次切实验重画。
 *      ⛔ 别把那条搬回来 —— 屏头那一行才是「与三入口对齐」的唯一位置。
 * @returns {string} 容器 HTML
 */
function paneHtml() {
  return '<div id="lab-host" class="lab-host"></div>';
}

/**
 * 功能：**屏头那一条** —— `‹ 返回` ＋ 实验名 ＋ （可选）`设计说明`。
 *
 * 说明：⭐⭐ 老大提的是「进入每一个实验室模块过后顶部都固定显示：返回、【加密信息】设计说明」。
 *      ⇒ 三个要件固定在屏头、与右侧三入口同一条基线（`.home-head` 是 `align-items:center`）。
 *      ⚠️ 四颗按钮**同一档高度**（`btn btn-sm` ＋ 一个类别色）：高度一致才有「同一行」的观感，
 *      混一档就会出现「有一颗矮一点」。
 *      ⭐ 0.9.8 第 7 轮：类别色取代了原来的统一灰（`btn-subtle`）—— 返回＝蓝（导航）、
 *      设计说明＝绿（说明）。老大原话「颜色背景区分啊，不同类别一个颜色」；
 *      原来的四颗灰药丸「一模一样」，正是被打回的那一版。
 *      ⚠️ `设计说明` 只在接线表声明了 `lab.design === true` 时才画 —— 没写说明书的实验
 *      ⛔ 不许长出一颗点了没反应的按钮（点了只 toast 也算没反应）。
 * @param {Object} it - 当前实验的 `moduleItems()` 条目
 * @returns {string} 条的 HTML
 */
function barHtml(it) {
  const name = it ? String(it.name) : '';
  const design =
    it && it.lab && it.lab.design === true
      ? `<button class="btn btn-sm lab-cat-doc" type="button" data-lab-doc="${esc(name)}">设计说明</button>`
      : '';
  return (
    `<button class="btn btn-sm lab-cat-nav" type="button" data-lab-back="1">‹ 返回</button>` +
    `<span class="lab-bar-title">${esc(it ? it.title : '')}</span>` +
    design
  );
}

/**
 * 功能：把 `#lab-bar` 画出来（`null` ＝ 清空 —— 首页与「0 个实验」都不留返回条）。
 * @param {?Object} it - 当前实验的条目；`null` 清空
 * @returns {void}
 */
function paintBar(it) {
  const bar = document.getElementById('lab-bar');
  if (!bar) return;
  bar.innerHTML = it ? barHtml(it) : '';
}

/**
 * 功能：**首次进入**实验室的那道门 —— 弹出知情协议，勾选之后「同意」才可点。
 *
 * 说明：⭐⭐ 老大 2026-11-08：「首次进入实验室应该弹出知情协议，协议弹出应该要有勾选框，
 *      勾选过后才能点同意」＋ 两条拍板：**不可关**（✕ / 取消 / 点遮罩 / Esc 都不生效）
 *      与 **按账号记在服务端**（`users.lab_agreed`，换设备不再问）。
 *      ⇒ 用 `openModal(..., { locked: true })`：那四条关闭通路在 `ui.js` 的 `closeModal()` 里被挡住，
 *      唯一出口是「同意」那一支（先 `unlockModal()` 再关）。
 *
 * ⚠️ 与顶部那颗「知情协议」按钮**不是一回事**：那一颗是**随时重看**（「我已知晓」、可以关），
 *    这一道是**首次准入**（锁着、必须勾选）。两份正文同一个源（`./agreement.js`）。
 * @returns {void}
 */
function openAgreementGate() {
  openModal(
    LAB_DOC_TITLE,
    agreementHtml() +
      `<label class="vault-confirm lab-agree-ack">
         <input id="lab-agree-ack" type="checkbox" />我已阅读并理解上述内容
       </label>`,
    { mid: true, locked: true },
  );
  setModalSave('同意');
  const save = document.getElementById('modal-save');
  const box = document.getElementById('lab-agree-ack');
  // ⚠️ 没勾之前「同意」是不可点的（`disabled`）：这不是装饰 —— 它就是老大要的那条判据。
  if (save) save.disabled = true;
  if (box)
    box.addEventListener('change', () => {
      if (save) save.disabled = !box.checked;
    });
  if (save)
    save.onclick = async () => {
      try {
        const r = await api('PUT', '/api/auth/prefs', { labAgreed: true });
        // ⭐ 接口回的是**脱敏后的自己**（`sanitizeUser`）⇒ 直接换上，别手搓一份
        if (r && r.user) state.me = r.user;
        unlockModal();
        closeModal();
        toast('已同意，可以开始用实验室了');
      } catch (e) {
        toast(e.message, true);
      }
    };
}

/** 事件委托**只挂一次**（`#lab-body` 是静态节点，重挂会叠加） */
let bodyBound = false;

/** 屏头 `#lab-bar` 的委托也只挂一次（节点静态、内容每次换） */
let barBound = false;

/**
 * 顶部三入口 —— ⭐⭐ 0.9.8 第 3 轮（方案 §8.3）。
 *
 * 说明：老大 2026-11-08 原话：「实验室的顶部位置要显示三个控件：用户使用实验室功能知情协议、
 *      反馈调研二维码、QQ群二维码，这三个都是弹窗」。⇒ 三颗**纯文字**按钮（⛔ 不加图标、
 *      ⛔ 不加 emoji，他当场拍板「只留文字」），各开一个弹窗。
 *
 * ⚠️⭐ 工具条住 `#lab-tools`（`index.html` 的 `.home-head` 里），**在 `#lab-body` 外面** ——
 *    后者每次切实验都整块重画，放里面会跟着消失。所以：
 *      · 内容由 `openLab()` 画**一次**（⛔ 别放进 `paint()`，那里每次切换都会跑）；
 *      · 委托挂在 `#lab-tools` 自己身上，也只挂一次。
 * ⚠️ 二维码与群号**不在这里写第二遍**：`core/about.js` 的 `qrBlockHtml()` / `GROUP_NO`
 *    是唯一来源（换群号只改那一处）。
 */
const TOOLS = [
  // ⭐⭐ 0.9.8 第 7 轮：改名叫「实验室设计说明」（老大拍板三处统一），并按**类别**着色：
  //    绿＝说明与钥匙、黄＝反馈与联系（蓝＝导航与设置，见 `barHtml()` 的返回键）。
  //    ⚠️ `cls` 只放 `.lab-cat-*`（`desktop/app.css`），⛔ 别在这里写内联颜色。
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
      `<button class="btn btn-sm ${t.cls}" type="button" data-lab-tool="${t.act}">${t.label}</button>`,
  ).join('');
}

/**
 * 功能：开一个入口的弹窗（协议 / 反馈调研 / 交流群）。
 *
 * 说明：⚠️ 三个弹窗的主按钮都改写成「我已知晓」，而 `setModalSave()` 是**全局**的
 *      （改的是 `#modal-save` 那颗常驻按钮）⇒ 关掉之后必须还原，否则下一个弹窗的主按钮
 *      会顶着「我已知晓」。本文件的 `closeModal` 由宿主的骨架负责还原
 *      （见 `ui.js` 的 `closeModal()`，它把文案恢复成「保存」）。
 * @param {string} act - `agreement` / `form` / `group`
 * @returns {void}
 */
function openTool(act) {
  if (act === 'agreement') {
    openReadonly(LAB_DOC_TITLE, agreementHtml());
    return;
  }
  const isGroup = act === 'group';
  const note = isGroup
    ? `扫这个码加入交流群（QQ 群 ${GROUP_NO}）`
    : '遇到问题或想提需求，扫这个码填一下';
  openReadonly(
    isGroup ? '交流群' : '问题反馈与调研',
    `<div class="lab-qr">${qrBlockHtml(isGroup ? 'group' : 'form')}<p class="lab-qr-note">${esc(note)}</p></div>`,
  );
}

/**
 * 功能：开一个**只读**弹窗（协议 / 二维码）—— 只有一颗「我已知晓」，点了就关。
 *
 * 说明：⚠️⚠️ 老大 2026-11-08 真机截图报的第一件事是「点了我已知晓没反应」，根因就在这儿：
 *      `openModal()` **不会**给 `#modal-save` 挂默认点击处理（它本来就没有保存语义），
 *      `setModalSave('我已知晓')` 只换文案 ⇒ 那颗按钮点了确实什么都不发生。
 *      （以前看着能关，是因为上一个弹窗残留的 `onclick = closeModal` 还在 —— 属撞运气。）
 *      ⇒ 这里**显式**把它接到 `closeModal`，并且用 `{ single: true }` 收掉「取消」
 *      （老大同一句里要求的「去掉取消按键」：这一屏除了关掉没有第二种选择）。
 * @param {string} title - 弹窗标题
 * @param {string} html - 正文 HTML
 * @returns {void}
 */
function openReadonly(title, html) {
  openModal(title, html, { mid: true, single: true });
  setModalSave('我已知晓');
  const save = document.getElementById('modal-save');
  if (save) save.onclick = closeModal;
}

/**
 * 功能：开「设计说明」弹窗 —— 正文按约定从 `modules/<实验名>/design.js` **动态**取。
 *
 * 说明：⭐⭐ 宿主不认识任何具体实验（与卡片说明走 `lab.desc` 同一条路子）：
 *      正文住模块自己的 `design.js`，这里是**算出来的** `import()` 路径，所以静态扫描看不见它 ——
 *      `frontend-modules.test.js` 的 `conventionFiles()` 与 `module-ui.test.js` 各钉一条。
 *      ⚠️ 必须动态 import：静态 import 会让「删掉某个实验目录」把这一屏整个打挂
 *      （与插槽片段同一条纪律）。
 *      ⚠️ 取不到就**明说**：控制台报错 ＋ toast。⛔ 不静默空白 —— 一颗点了什么都不发生的按钮，
 *      用户只会以为「这个功能坏了」。
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
  openReadonly(mod.DESIGN_TITLE, mod.designHtml());
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
 * @param {boolean} [enter] - 是不是「进屏」那一趟（是则槽内不播淡入，整屏动画已经在做）
 * @returns {Promise.<void>}
 */
function paint(enter) {
  const tabs = document.getElementById('lab-tabs');
  const body = document.getElementById('lab-body');
  if (!tabs || !body) return Promise.resolve();
  const items = itemsOf();
  const names = items.map((it) => it.name);
  painted = fingerprintOf();
  // ⚠️ 当前实验不在清单里了（实验被撤掉 / 模块被关掉）⇒ 回首页（⛔ 不许停在一个不存在的实验上）
  if (cur && !names.includes(cur)) cur = '';
  tabs.innerHTML = cur ? pillHtml(items, cur) : '';
  fitTabs(tabs);
  // ⭐ 0 个实验：给一句空状态（⛔ 不许空白屏）；屏头那一条也不留
  if (!items.length) {
    paintBar(null);
    body.innerHTML = emptyHtml();
    return Promise.resolve();
  }
  // ⭐ 首页：卡片（屏头只剩三入口，⛔ 不留返回条）
  if (!cur) {
    paintBar(null);
    body.innerHTML = cardsHtml(items);
    body.scrollTop = 0;
    return Promise.resolve();
  }
  // ⭐ 实验视图：屏头画「返回 ＋ 名字 ＋ 设计说明」，正文只挂那个模块自己的片段
  const it = items.find((x) => x.name === cur);
  paintBar(it);
  body.innerHTML = paneHtml();
  body.scrollTop = 0;
  return mountModuleSlot(body.querySelector('#lab-host'), 'desktop', cur, SLOT, {
    // ⚠️⭐ `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    //    `render(ctx)`，而视图片段需要先把根节点插进文档、再调模块自己的渲染函数
    //    （那些函数按**全局 id** 找节点，节点不在文档里就静默空白）。
    container: body.querySelector('#lab-host'),
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    crossFade: true,
    // ⭐ 进屏那一趟不播槽内淡入 —— 整屏动画（`showView()`）已经在给这一屏淡入，
    //    槽里再淡一次就是「同一块内容连淡两次」。
    enterFade: enter !== true,
  });
}

/**
 * 功能：进「zx 实验室」这一屏 —— 切视图、画侧栏、显示本屏，然后画**卡片首页**或指定实验。
 *
 * 说明：`opts.slot` 是「这一次要直接进哪个实验」（模块名）—— 由跨模块契约带进来
 *      （`zx:open-module` 的 `detail.slot`）。**不带就落卡片首页**（⛔ 不是「落第一项」：
 *      那是「只有一个实验」时代的旧口径，第二个实验一进来它就会把人挡在卡片外面）。
 *
 * @param {{slot?: string}} [opts] - 见上
 * @returns {Promise.<void>}
 */
export async function openLab(opts) {
  cur = opts && opts.slot ? String(opts.slot) : '';
  state.view = 'lab';
  // ⭐ 进这一屏就把「可能要挂的片段」**预热**起来 —— **不 await**（⛔ 只预热片段 JS，不预取数据）。
  warmSlots('desktop', SLOT, { modules: state.modules, uiOf, me: state.me });
  // ⚠️ 先把「要画的指纹」记下来：`renderSidebar()` 里那一趟 `applyPrefsVisibility()` 会派
  //    `zx:prefs-changed`（见下面那个监听），不先对齐就会**多画一趟**（白取一趟数）。
  painted = fingerprintOf();
  renderSidebar();
  showView('lab');
  if (!bodyBound) {
    bodyBound = true;
    // 卡片 / 药丸两种点击走**一个**委托，挂在静态的 `#lab-body` 上
    // （⭐ 返回与设计说明在屏头 `#lab-bar` 里，委托也挂在那边 —— 见下面那一段）
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
  // ⭐⭐ 屏头那一条的委托：`#lab-bar` 是**静态节点**（内容每次都换、节点不动）⇒ 挂一次就够
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
  //    所以 **不跟着 `paint()` 走**（每次切实验都重画的话，用户正在看的弹窗状态会被搅）。
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
  //    ⚠️ 放在 `paint()` 之后：弹窗盖住的是已经画好的实验室，而不是一块空白。
  if (!state.me || !state.me.lab_agreed) openAgreementGate();
}

// ⭐ 设置页里翻动 `hide_lab`（或某个实验功能被关掉）时，卡片与正文要跟着变。
//    ⚠️ 判据是「**指纹真的变了**」—— 没变就什么都不做（否则每次 `renderSidebar()` 都会重画一趟）。
//    ⚠️ 事件由两端宿主的 `applyPrefsVisibility()` 派发（`shell.js` / `mobile/app.js` 各一处）。
document.addEventListener('zx:prefs-changed', () => {
  if (state.view !== 'lab') return;
  if (fingerprintOf() === painted) return;
  paint().catch((e) => toast(e.message, true));
});
