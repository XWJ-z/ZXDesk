/**
 * modules/assets/desktop.js —— 「个人资产管理」那一屏
 *
 * 功能：这一屏只有它自己 —— 屏头一颗药丸（第一层子模块：生活记账 ｜ 数码管理），
 * 以及药丸下面那一块正文 `#assets-body`。药丸的**项不来自接线表，而是数据**：
 * `GET /api/assets/groups` 那棵树里 `depth === 0` 且 **`module_key` 非空**的行
 * （某个账号**第一次**取数时，服务端会自动建出「生活记账」与「数码管理」两格）。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.9.7
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
 * 实现，判据必须一致）—— 本账号在设置页关掉 `digital` 之后，药丸里就**不该**再有「数码管理」
 * 两种「认不出」都回 `true`（照旧画那一颗）：
 * ① 清单还没到手（`state.modules` 首屏前是 `null`）—— 画不出来比画错更糟；
 */
function moduleOn(key) {
  if (!state.modules) return true;
  const it = moduleItems(state.modules, uiOf, state.me || {}).find((x) => x.name === key);
  return it ? !!it.on : true;
}

/**
 * 功能：第一层的**模块格** —— 药丸的项（顺序照接口给的）。
 *
 * 药丸里（「只保留生活记账、数码管理」）。那些行仍在库里（⛔ 不改写用户数据），只是不画。
 * 两道 `filter` 各管一件事，⛔ 别合并成一句（`moduleOn()` 只对模块格有意义）。
 *
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
 * （「移除新建，只保留生活记账、数码管理」）。
 *
 * @param {Array.<Object>} tops - 第一层模块格
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
 * 它把那一边的**界面直接挂在这一格下面**（`core/slots.js` 的 `mountModuleSlot()`，
 * 槽名 `assets-pane`）。⛔ 本文件因此**一个模块名都不写**：挂谁由
 * 数据里的 `module_key` 说、片段文件名由槽名约定推（`<端>-<槽名>.js`）。
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
 * 的显隐也读它：判定「这一格能挂片段」＝「片段会接管那颗 ＋」。
 * 两处各判一次会漂移（将来接线表字段一变，一处改了另一处不改，表现是「＋ 亮着但点了没反应」）。
 *
 */
function paneUsable(mod) {
  const ui = uiOf(mod);
  return !!(ui && Array.isArray(ui.slots) && ui.slots.includes(SLOT));
}

/**
 * 功能：把屏级那颗悬浮「＋」收起来（没有任何一格可用 / 那一格挂不出界面时）。
 *
 * 说明：⭐ 它在**正常切换**（一格 → 另一格）时**刻意不被调用** —— 那一刻新旧片段会先后
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
 * @param {boolean} [enter] - `true`（默认）= 进屏那一趟（见 `mountPane()`）
 * @returns {Promise.<void>}
 */
async function paint(enter = true) {
  const tabs = document.getElementById('assets-tabs');
  const body = document.getElementById('assets-body');
  if (!tabs || !body) return;
  const tops = topsOf();
  const ids = tops.map((g) => Number(g.id));
  // 从别处进来时可能**指定要落哪一格**（首页「具体事项」里点一条
  // 硬件类事项 ⇒ 直接落在「数码管理」那颗药丸上）。`state.assetsWant` 里放的是**模块名**，
  // 这里读走并**立刻清空**（⛔ 不清就会被下一次进屏继承）。
  const want = String(state.assetsWant || '');
  state.assetsWant = '';
  if (want) {
    const hit = tops.find((g) => String(g.module_key || '') === want);
    if (hit) cur = Number(hit.id);
  }
  // 当前那一格不在清单里了（被关掉 / 第一次进屏）⇒ 回落到第一项
  if (!ids.includes(curId())) cur = ids.length ? ids[0] : 0;
  tabs.innerHTML = pillHtml(tops, cur);
  // 各颗撑成等宽（量最宽那颗）—— 必须在写进 innerHTML 之后、同一帧内调
  fitTabs(tabs);
  const g = curId() ? groupOf(curId()) : null;
  if (!g) {
    state.assetsPane = '';
    body.innerHTML = '<div class="asset-empty">这一屏暂时没有可用的功能。</div>';
    fabOff();
    return;
  }
  // 把「现在这一格上是哪个模块」写进 state —— 借屏的模块（记账 / 数码管理）
  // 撤了自己的屏之后，`state.view` 恒为 `'assets'`，它们按屏名判「自己在不在场」会**永远判错**
  // （记账的翻页闸门 `maybeLoadMore()` 就是这么坏的：滚到底不翻页，且不报错）。
  state.assetsPane = String(g.module_key);
  body.innerHTML = moduleHtml(g);
  // 这一格挂不出界面（模块被删 / 没声明本屏的槽）⇒ 屏级那颗「＋」也收起来
  if (!paneUsable(String(g.module_key))) fabOff();
  // 把**那一边的界面**挂进 `#assets-pane-host`。
  // 次序是「先写 innerHTML（挂载点已经进文档）、再挂」—— 片段要先进文档再渲染，
  // 反过来的表现是「界面空白但不报错」。
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
 * 判据只用 `uiOf(module_key)` 与它的 `slots`：本文件**不认任何模块名**。
 * 失败不静默：`mountModuleSlot()` 自己会在那一格里写一句人话并 `console.error`。
 *
 */
async function mountPane(mod, enter) {
  const host = document.getElementById('assets-pane-host');
  if (!host) return;
  const ui = uiOf(mod);
  if (!ui || !Array.isArray(ui.slots) || !ui.slots.includes(SLOT)) return;
  await mountModuleSlot(host, 'desktop', mod, SLOT, {
    // `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    // `render(ctx)`（它自己的第一个参数不会进 ctx）。视图片段要先把它造的根节点插进文档，
    // 再调模块的渲染函数 —— 那些函数按**全局 id** 找节点（`$('#ledger-view')` 这种），
    container: host,
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    // 旧调用方跟着升级 —— 挂载改走**交叉淡入**那套机制。
    crossFade: true,
    // 进屏那一趟不播槽内淡入（见 `mountPane()` 的 `enter` 说明）。
    enterFade: enter !== true,
  });
}

// ---------- 事件 ----------

/**
 * 功能：屏头那一行的**一次**点击委托（容器是静态节点，重挂会叠加）。
 *
 * 但委托仍留在这里 —— 药丸由 `paint()` 整块重写，逐颗绑必然漏（漏了就是「点了没反应」）。
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
 * 而 `showView()` 已经在整屏上播过淡入，所以这里**不再**额外铺骨架或播动画。
 *
 */
export async function openAssets() {
  state.view = 'assets';
  renderSidebar();
  showView('assets');
  bindOnce();
  await reload();
}
