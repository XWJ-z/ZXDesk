/**
 * modules/assets/desktop.js —— 「个人资产管理」那一屏（电脑版，0.8.10）
 *
 * 功能：这一屏只有它自己 —— 屏头一颗药丸（第一层子模块：生活记账 ｜ 数码管理），
 *      以及药丸下面那一块正文 `#assets-body`。药丸的**项不来自接线表，而是数据**：
 *      `GET /api/assets/groups` 那棵树里 `depth === 0` 且 **`module_key` 非空**的行
 *      （某个账号**第一次**取数时，服务端会自动建出「生活记账」与「数码管理」两格）。
 *
 * ⭐⭐ 0.8.20：「移除新建，只保留生活记账、数码管理」——
 *     **自建分组 / 分类 / 通用条目的界面整块撤掉**（连同屏头那颗「＋ 新建分组」），
 *     这一屏从「一棵可编辑的分组树」收成「两颗模块格」。
 *     ⚠️⭐ 后端的 `asset_groups` 接口 / 两张表 / 数据**一个字没动**：数码管理自己的
 *     「子类别 / 子分类」就住在那棵树上（`modules/digital/{desktop,mobile}.js` 直接打
 *     `POST /api/assets/groups`），撤不得 —— 界面只是**不再画**模块格以外的那些格。
 *
 * ⭐ 这一格画什么：`module_key` **非空** ⇒ 这一格背后有一个**真模块**（如 `ledger` / `digital`）——
 *    **把那一边自己的界面挂在这一格下面**（`core/slots.js` 的 `mountModuleSlot()`，
 *    槽名 `assets-pane`）：本文件因此一个模块名都不写，也不 import 任何模块。
 *
 * ⚠️⭐ **药丸住屏头静态槽**（`#assets-tabs` ⊂ `.home-title`），⛔ 不许放进 `#assets-body` ——
 *    后者每画一次就被整块重写，药丸会跟着一起没（与 `webpass` 同一条理由）。
 *
 * ⭐⭐ 0.8.20：屏级还有一颗悬浮「＋」（`#assets-new`，同样住 `#assets-body` **外面**）——
 *    记账的「记一笔」与数码管理的「＋ 新增」**共用**它，由挂进来的片段在 `render()` 里接管
 *    （`onclick =` 覆盖式）⇒ 药丸切换时它**不跟着消失**。
 *    本文件只负责「没有可用格 / 那一格挂不出界面」时把它收起来（`fabOff()`）。
 *
 * ⚠️⭐ 宿主（`desktop/app.js`）**动态** import 本文件，⛔ 不许改成静态：
 *    静态 import 会让「删掉 `public/modules/assets/`」把宿主页一起打挂（方案 §四·1）。
 *    ⇒ 本文件也**不 import 任何别的模块**：切屏一律走 `zx:open-module` 留白事件。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.20
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/26-个人资产管理.md、35-视图切换与过渡动画.md
 */

import { api } from '../../core/api.js';
import { esc, fitTabs } from '../../core/dom.js';
import { moduleItems } from '../../core/modules.js';
import { mountModuleSlot } from '../../core/slots.js';
import { uiOf } from '../../desktop/modules.js';
import { renderSidebar, showView } from '../../desktop/shell.js';
import { state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';

/** 接口基址（同源、需要登录；401 由 `core/api.js` 的全局处理跳登录页） */
const BASE = '/api/assets';

/**
 * 药丸里「有实现的那几格」借的槽名 —— 那几格把界面挂在**本屏**里（与 `webpass` 同一条机制）。
 *
 * 说明：⭐ 它与两端接线表里 `ledger` / `digital` 声明的那个**逐字一致**
 *      （`ttt/test/module-ui.test.js` 钉着「声明的片段文件必须真实存在」）。
 * @type {string}
 */
const SLOT = 'assets-pane';

/** 分组树（服务端已按树展平：父在前、同级按 sort_order；`depth` 0 = 第一层） */
let groups = [];

/** 当前选中的**第一层**模块格 id（0 = 一格都没有 / 还没定） */
let cur = 0;

/** 药丸与正文的点击 / 提交委托**只挂一次**（容器是静态节点，重挂会叠加） @type {boolean} */
let bound = false;

// ---------- 取数与查找 ----------

/**
 * 功能：某个模块**当前开着吗**（`module_key` 非空的格子用来判「这一格该不该出现在药丸里」）。
 *
 * 说明：⭐⭐ 0.8.10：与手机端 `modules/assets/mobile.js` 的 `moduleOn()` **同口径**（两端各一套
 *      实现，判据必须一致）—— 本账号在设置页关掉 `digital` 之后，药丸里就**不该**再有「数码管理」
 *      那一颗（方案 §四·4 的退化验收写的就是「关掉 `hide_digital` ⇒ 药丸少一颗」）。
 *      ⚠️ 两种「认不出」都回 `true`（照旧画那一颗）：
 *      ① 清单还没到手（`state.modules` 首屏前是 `null`）—— 画不出来比画错更糟；
 *      ② `module_key` 指向的模块**不在清单 / 接线表里**（目录被删掉）—— 那一格该保留
 *         （它会显示「这个功能当前不可用」， 的先例），⛔ 不是「关掉了」。
 *
 * @param {string} key - 分组行上的 `module_key`
 * @returns {boolean} 真 = 这一格现在该画
 */
function moduleOn(key) {
  if (!state.modules) return true;
  const it = moduleItems(state.modules, uiOf, state.me || {}).find((x) => x.name === key);
  return it ? !!it.on : true;
}

/**
 * 功能：第一层的**模块格** —— 药丸的项（顺序照接口给的）。
 *
 * 说明：⭐ 0.8.20：**只收 `module_key` 非空的行** —— 自建分组（`module_key` 为空）不再出现在
 *      药丸里（「只保留生活记账、数码管理」）。那些行仍在库里（⛔ 不改写用户数据），只是不画。
 *      ⚠️ 两道 `filter` 各管一件事，⛔ 别合并成一句（`moduleOn()` 只对模块格有意义）。
 *
 * @returns {Array.<Object>} 分组行数组
 */
const topsOf = () =>
  groups
    .filter((g) => Number(g.depth) === 0 && String(g.module_key || '').trim())
    .filter((g) => moduleOn(String(g.module_key)));

/**
 * 功能：按 id 找一个分组。
 * @param {number} id - 分组 id
 * @returns {?Object} 分组行；找不到时 null
 */
const groupOf = (id) => groups.find((g) => Number(g.id) === Number(id)) || null;

/** 功能：当前正在看的模块格 id。 @returns {number} 分组 id（0 = 没有） */
const curId = () => Number(cur) || 0;

// ---------- 画 HTML ----------

/**
 * 功能：画屏头那一行 —— 药丸（**只有一项时整条不画**）。
 *
 * 说明：⚠️⭐ 0.8.20：从前这里还跟着一颗恒在的「＋ 新建分组」，随自建分组界面一起撤掉了
 *      （「移除新建，只保留生活记账、数码管理」）。
 *
 * @param {Array.<Object>} tops - 第一层模块格
 * @param {number} on - 当前选中的分组 id
 * @returns {string} 屏头那一行的 HTML
 */
function pillHtml(tops, on) {
  if (tops.length < 2) return '';
  return `<div class="dash-tabs" role="tablist">${tops
    .map(
      (g) =>
        `<button class="dash-tab${Number(g.id) === Number(on) ? ' on' : ''}" type="button" role="tab" ` +
        `aria-selected="${Number(g.id) === Number(on)}" data-asset-group="${esc(String(g.id))}">` +
        `${esc(g.name)}</button>`,
    )
    .join('')}</div>`;
}

/**
 * 功能：画「这一格有实现」—— 只留一颗**挂载点**，那一边的界面由它自己的视图片段挂进来。
 *
 * 说明：⭐⭐ 0.8.10：这一格**不再画「打开…」按钮、也不再派 `zx:open-module`** ——
 *      它把那一边的**界面直接挂在这一格下面**（`core/slots.js` 的 `mountModuleSlot()`，
 *      槽名 `assets-pane`）。⛔ 本文件因此**一个模块名都不写**：挂谁由
 *      数据里的 `module_key` 说、片段文件名由槽名约定推（`<端>-<槽名>.js`）。
 *      ⚠️ `module_key` 指向的模块**不在这端的接线表里 / 没声明这个槽**（目录被删掉、
 *      或将来某个不自带界面的模块）⇒ 画一句「这个功能当前不可用」，⛔ 不抛错、也不留一颗
 *      点了没反应的按钮。
 *
 * @param {Object} g - 分组行（`module_key` 非空）
 * @returns {string} 正文 HTML
 */
function moduleHtml(g) {
  if (!paneUsable(String(g.module_key || ''))) {
    return '<div class="asset-empty">这个功能当前不可用。</div>';
  }
  return '<div id="assets-pane-host" class="asset-pane-host"></div>';
}

/**
 * 功能：这一格背后那个模块**有没有能挂进来的界面**（接线表里声明了本屏的槽、且片段文件存在）。
 *
 * 说明：⭐⭐ 0.8.20：判据从 `moduleHtml()` 里提出来单独一份 —— 屏级那颗悬浮「＋」（`#assets-new`）
 *      的显隐也读它：判定「这一格能挂片段」＝「片段会接管那颗 ＋」。
 *      ⛔ 两处各判一次会漂移（将来接线表字段一变，一处改了另一处不改，表现是「＋ 亮着但点了没反应」）。
 *
 * @param {string} mod - 模块名（= 分组行上的 `module_key`）
 * @returns {boolean} 真 = 这一格能挂出界面
 */
function paneUsable(mod) {
  const ui = uiOf(mod);
  return !!(ui && Array.isArray(ui.slots) && ui.slots.includes(SLOT));
}

/**
 * 功能：把屏级那颗悬浮「＋」收起来（没有任何一格可用 / 那一格挂不出界面时）。
 *
 * 说明：⭐ 它在**正常切换**（一格 → 另一格）时**刻意不被调用** —— 那一刻新旧片段会先后
 *      接管它（`onclick =` 覆盖式），它一直在屏幕上，正是要的「切换时不消失」。
 *      ⚠️ 只有「没有接管者」时才由宿主收起，否则会留一颗**点了没反应**的按钮。
 *
 * @returns {void}
 */
function fabOff() {
  const f = document.getElementById('assets-new');
  if (f) f.classList.add('hidden');
}

// ---------- 画与切 ----------

/**
 * 功能：把药丸与正文画出来（**对外的入口**）。
 *
 * 说明：⚠️ 从前那一套合并式防重入（`painting` / `again`）**已收进 `core/slots.js`**
 *      （0.8.15）—— 见文件上部那段说明。本函数不再自己排队。
 * @param {boolean} [enter] - `true`（默认）= 进屏那一趟（见 `mountPane()`）
 * @returns {Promise.<void>}
 */
async function paint(enter = true) {
  const tabs = document.getElementById('assets-tabs');
  const body = document.getElementById('assets-body');
  if (!tabs || !body) return;
  const tops = topsOf();
  const ids = tops.map((g) => Number(g.id));
  // ⭐⭐ 0.8.10：从别处进来时可能**指定要落哪一格**（首页「具体事项」里点一条
  //    硬件类事项 ⇒ 直接落在「数码管理」那颗药丸上）。`state.assetsWant` 里放的是**模块名**，
  //    这里读走并**立刻清空**（⛔ 不清就会被下一次进屏继承）。
  //    ⚠️ 认不出来（模块被本账号关掉 / 目录被删 / 名字写错）就照旧回落第一项 —— 这一处刻意
  //    只认 `module_key` **精确相等**：界面上「停错一格」不报错，比「什么都没发生」更难查。
  const want = String(state.assetsWant || '');
  state.assetsWant = '';
  if (want) {
    const hit = tops.find((g) => String(g.module_key || '') === want);
    if (hit) cur = Number(hit.id);
  }
  // ⚠️ 当前那一格不在清单里了（被关掉 / 第一次进屏）⇒ 回落到第一项
  if (!ids.includes(curId())) cur = ids.length ? ids[0] : 0;
  tabs.innerHTML = pillHtml(tops, cur);
  // ⭐ 各颗撑成等宽（量最宽那颗）—— 必须在写进 innerHTML 之后、同一帧内调
  fitTabs(tabs);
  const g = curId() ? groupOf(curId()) : null;
  if (!g) {
    state.assetsPane = '';
    body.innerHTML = '<div class="asset-empty">这一屏暂时没有可用的功能。</div>';
    fabOff();
    return;
  }
  // ⭐⭐ 0.8.10：把「现在这一格上是哪个模块」写进 state —— 借屏的模块（记账 / 数码管理）
  //    撤了自己的屏之后，`state.view` 恒为 `'assets'`，它们按屏名判「自己在不在场」会**永远判错**
  //    （记账的翻页闸门 `maybeLoadMore()` 就是这么坏的：滚到底不翻页，且不报错）。
  //    ⚠️ 写在**挂载之前**：片段一进门就会用它（`mountPane()` 紧跟着这一行）。
  state.assetsPane = String(g.module_key);
  body.innerHTML = moduleHtml(g);
  // ⭐⭐ 0.8.20：这一格挂不出界面（模块被删 / 没声明本屏的槽）⇒ 屏级那颗「＋」也收起来
  //    （挂得出来时由**片段自己**接管它，宿主在这里 ⛔ 一个字都不许动 —— 动了就是
  //    「切换时那颗 ＋ 闪一下」，正是本版要修的那件事）。
  if (!paneUsable(String(g.module_key))) fabOff();
  // ⭐⭐ 0.8.10：把**那一边的界面**挂进 `#assets-pane-host`。
  //    ⚠️ 次序是「先写 innerHTML（挂载点已经进文档）、再挂」—— 片段要先进文档再渲染，
  //    反过来的表现是「界面空白但不报错」。
  await mountPane(String(g.module_key), enter);
}

/**
 * 功能：切到药丸里的某一格（屏内切换：只改 state 再重画，⛔ 不换屏、⛔ 不重取别的模块的数）。
 * @param {number} id - 目标分组 id
 * @returns {void}
 */
function pick(id) {
  if (!id || Number(id) === curId()) return;
  cur = Number(id);
  paint(false).catch((e) => toast(e.message, true));
}

/**
 * 功能：把「这一格对应的模块」的界面挂进本屏（槽名 `assets-pane`）。
 *
 * 说明：⭐⭐ 0.8.10：**挂载**而不是「跳过去」—— 药丸住屏头静态槽，切格只换下面那块正文，
 *      所以「生活记账 / 数码管理」看起来是同一屏里的两格（方案 §二·1/§二·8）。
 *      ⚠️ 判据只用 `uiOf(module_key)` 与它的 `slots`：本文件**不认任何模块名**。
 *      ⚠️ 失败不静默：`mountModuleSlot()` 自己会在那一格里写一句人话并 `console.error`。
 *
 * @param {string} mod - 模块名（= 分组行上的 `module_key`）
 * @param {boolean} [enter] - `true`（默认）= **进屏那一趟**：槽内不播自己的淡入（整屏那一条
 *      已经在淡入，两处叠加 =「同一块内容连淡两次」，「多次闪现」）。屏内**用户亲手
 *      切格**那一处传 `false`（它没有整屏动画，交叉淡入正是要的）。
 * @returns {Promise.<void>}
 */
async function mountPane(mod, enter) {
  const host = document.getElementById('assets-pane-host');
  if (!host) return;
  const ui = uiOf(mod);
  if (!ui || !Array.isArray(ui.slots) || !ui.slots.includes(SLOT)) return;
  await mountModuleSlot(host, 'desktop', mod, SLOT, {
    // ⚠️⭐ `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    //    `render(ctx)`（它自己的第一个参数不会进 ctx）。视图片段要先把它造的根节点插进文档，
    //    再调模块的渲染函数 —— 那些函数按**全局 id** 找节点（`$('#ledger-view')` 这种），
    //    节点不在文档里就静默空白。
    container: host,
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    // ⭐ 0.8.15：旧调用方跟着升级 —— 挂载改走**交叉淡入**那套机制。
    crossFade: true,
    // ⭐ 0.8.17：进屏那一趟不播槽内淡入（见 `mountPane()` 的 `enter` 说明）。
    enterFade: enter !== true,
  });
}

// ---------- 事件 ----------

/**
 * 功能：屏头那一行的**一次**点击委托（容器是静态节点，重挂会叠加）。
 *
 * 说明：⚠️ 0.8.20：药丸是这一行**唯一**的内容（那颗「＋ 新建分组」已随自建分组界面撤掉），
 *      但委托仍留在这里 —— 药丸由 `paint()` 整块重写，逐颗绑必然漏（漏了就是「点了没反应」）。
 *
 * @returns {void}
 */
function bindOnce() {
  if (bound) return;
  bound = true;
  const tabs = document.getElementById('assets-tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const b = t.closest('[data-asset-group]');
      if (b) pick(Number(b.getAttribute('data-asset-group')));
    });
  }
}

// ---------- 重取 ----------

/**
 * 功能：重取分组树并重画（「关掉某个模块」之后药丸会少一颗）。
 * @returns {Promise.<void>}
 */
async function reload() {
  try {
    const r = await api('GET', BASE + '/groups');
    groups = Array.isArray(r && r.groups) ? r.groups : [];
  } catch (e) {
    toast(e.message, true);
  }
  await paint();
}

// ---------- 进屏 ----------

/**
 * 功能：进「个人资产管理」这一屏 —— 切视图、画侧栏、显示本屏，再取一次分组树并画出来。
 *
 * 说明：⚠️ 次序是「先 `showView()`、再取数」—— 取数期间 `#assets-body` 是白的（几百毫秒），
 *      而 `showView()` 已经在整屏上播过淡入，所以这里**不再**额外铺骨架或播动画。
 *
 * @returns {Promise.<void>}
 */
export async function openAssets() {
  state.view = 'assets';
  renderSidebar();
  showView('assets');
  bindOnce();
  await reload();
}
