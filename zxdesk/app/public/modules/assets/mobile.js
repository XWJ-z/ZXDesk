/**
 * modules/assets/mobile.js —— 「个人资产管理」那一屏
 *
 * 功能：一条**第一层药丸**（项来自 `GET /api/assets/groups` 里 `depth === 0` 且
 * **`module_key` 非空**的行）＋ 一个内容区 `#assets-body`：
 * 选中一个模块格（`module_key` 非空）⇒ 只画一颗**挂载点**（`#assets-pane-host`），
 * 那一边自己的界面由 `core/slots.js` 的 `mountModuleSlot()` 挂进来（槽名 `assets-pane`）。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.9.7
 * 相关：docs/公共/架构文档/26-个人资产管理.md、docs/公共/开发方案/30-个人资产管理.md、core/slots.js
 */

import { api } from '../../core/api.js';
import { esc } from '../../core/dom.js';
import { moduleItems } from '../../core/modules.js';
import { mountModuleSlot } from '../../core/slots.js';
import { uiOf } from '../../mobile/modules.js';
import { state } from '../../mobile/state.js';
import { emptyHtml, paintChrome, setBackHandler, toast } from '../../mobile/ui.js';

/**
 * 模块界面的**插槽名**—— 生活记账 / 数码管理都借这一格住。
 * @type {string}
 */
const SLOT = 'assets-pane';

// ---------- 屏内状态（这一屏自己的，不进全局 state） ----------
/** 分组树（`GET /api/assets/groups` 的 `groups`：展平、父在前，每行带 `depth`） @type {Array.<Object>} */
let groups = [];
/** 当前选中的模块格 id（数字；0 = 还没定） @type {number} */
let cur = 0;
/** 取数失败的一句话（空串 = 没失败） @type {string} */
let loadErr = '';

/**
 * 功能：按 id 取一条分组行。
 * @param {number|string} id - 分组 id
 * @returns {?Object} 分组行；找不到时为 null
 */
function groupById(id) {
  return groups.find((g) => Number(g.id) === Number(id)) || null;
}

/** 功能：当前选中的分组行。 @returns {?Object} `groupById(cur)` */
function curGroup() {
  return groupById(cur);
}

/**
 * 功能：某个 `module_key` 对应的模块，本账号现在开着吗。
 *
 * 被关掉的模块那一格藏起来（设置页那一行仍在，能再打开）。
 * 清单还没到手（`state.modules === null`）时**什么都不判**（回 true）——
 * 那会儿把入口当成「关掉了」会把药丸清空（与宿主 `applyPrefsVisibility()` 同一条纪律）。
 */
function moduleOn(key) {
  if (!state.modules) return true;
  const it = moduleItems(state.modules, uiOf, state.me || {}).find((x) => x.name === key);
  return it ? !!it.on : true;
}

/**
 * 功能：算一遍药丸的项 —— 第一层（`depth === 0`）且 **`module_key` 非空**的分组，
 * 顺序照接口给的顺序，并滤掉「对应的模块被本账号关掉了」的那几格。
 *
 * （「只保留生活记账、数码管理」）。那些行仍在库里（⛔ 不改写用户数据），只是不画。
 *
 */
function pillItems() {
  return groups
    .filter((g) => g.depth === 0 && String(g.module_key || '').trim())
    .filter((g) => moduleOn(String(g.module_key)));
}

// ---------- 画 ----------
/**
 * 功能：画屏头那一行 —— 药丸（内容由 JS 写进静态槽 `#assets-tabs`）。
 *
 * 说明：⚠️ 药丸**只有 1 项**时整条不画（一条切换控件是纯噪音，与 `webpass` / 任务板同款）。
 * 从前药丸旁边还跟着一颗恒在的「＋ 新建分组」，随自建分组界面一起撤掉了
 */
function renderPill() {
  const el = document.getElementById('assets-tabs');
  if (!el) return;
  const list = pillItems();
  el.innerHTML =
    list.length < 2
      ? ''
      : '<div class="dash-tabs" role="tablist">' +
        list
          .map((g) => {
            const on = Number(g.id) === Number(cur);
            const ico = g.icon ? `<span class="tab-ico" aria-hidden="true">${esc(String(g.icon))}</span>` : '';
            return (
              `<button class="dash-tab${on ? ' on' : ''}" type="button" role="tab" aria-selected="${on}" ` +
              `data-act="as-pick" data-id="${g.id}">${ico}${esc(String(g.name))}</button>`
            );
          })
          .join('') +
        '</div>';
}

/**
 * 功能：模块格那一段 —— 只画一颗**挂载点**，那一边自己的界面由 `mountPane()` 挂进来。
 *
 * 生活记账 / 数码管理不再有自己的一屏，它们的界面**直接挂在这一格下面**
 * （`core/slots.js` 的 `mountModuleSlot()`，槽名 `assets-pane`）。
 * 本文件因此**一个模块名都不写**：挂谁由数据里的 `module_key` 说、
 */
function moduleCardHtml(g) {
  const key = String(g.module_key);
  const ui = uiOf(key);
  if (!ui || !Array.isArray(ui.slots) || !ui.slots.includes(SLOT)) {
    return `<div class="as-note">「${esc(String(g.name))}」对应的功能当前不可用（模块可能已经被删掉）。</div>`;
  }
  return '<div id="assets-pane-host" class="as-pane-host"></div>';
}

/**
 * 功能：画内容区（`#assets-body`），并把**有实现的那一格**的界面挂上去。
 *
 * 说明：⚠️⭐ 次序是「**先写 `innerHTML`（挂载点已经进文档）、再 `mountPane()`**」—— 片段要
 * 先进文档再渲染，反过来的表现是「界面空白但不报错」（与电脑版 `desktop.js` 的 `paint()`
 * 同款）。所以这个函数是**异步**的。
 */
async function paintBody() {
  const el = document.getElementById('assets-body');
  if (!el) return;
  const g = curGroup();
  // `state.assetsPane` = **这一格上的模块名**（空串 = 读失败）。
  // 借住的那几块界面里有「整屏接管」的规矩（生活记账要收起宿主顶栏 / 底栏、还要管系统返回键），
  // 而它们不再有自己的屏名（`state.tab` 恒为 `'assets'`）⇒ 那三处判据读的就是这个字段。
  state.assetsPane = g && g.module_key ? String(g.module_key) : '';
  // 写完**立刻请宿主重画一次顶栏**（`paintChrome()` 幂等、只写文字与 class）—— 宿主的
  // `updateChrome()` 只在 `render()`（切标签页）里跑，而「切到记账那一格」是**这一屏内部**
  // 换的骨头：不喊这一声，切过去之后宿主顶栏 / 底栏仍停在上一格的样子（`.lg-nav` 与 `.tabbar`
  paintChrome();
  if (loadErr) {
    el.innerHTML =
      `<div class="err-box"><b>读取失败</b><p>${esc(loadErr)}</p>` +
      '<button class="chip on" type="button" data-act="as-retry" style="margin-top:14px">重新加载</button></div>';
    return;
  }
  let html;
  if (!pillItems().length) {
    html = emptyHtml('💼', '这一屏暂时没有可用的功能', '在「设置」里把「生活记账」或「数码管理」打开。');
  } else if (!g) {
    html = emptyHtml('💼', '选一格', '在上面那颗药丸里挑一个。');
  } else {
    html = moduleCardHtml(g);
  }
  el.innerHTML = html;
  // 先 `innerHTML`、再挂：视图片段按**全局 id** 找节点（`$('#view-ledger')` 这种），
  // 节点不在文档里就静默空白（而它**不报错**）。
  if (state.assetsPane) await mountPane(state.assetsPane);
}

/** 功能：药丸与内容区一起重画（内容区还要挂模块界面 ⇒ 异步）。 @returns {Promise.<void>} */
async function paint() {
  renderPill();
  await paintBody();
}

/**
 * 功能：取分组树并重画。
 *
 * 说明：⚠️ 当前选中格**不在了**（被关掉 / 读失败）时**回落到第一个可见的模块格**——
 *
 * `opts.slot` = **这次要落到哪一格**（模块名）—— 首页看板那张模块卡与
 */
async function load(opts) {
  try {
    const r = await api('GET', '/api/assets/groups');
    groups = (r && r.groups) || [];
    loadErr = '';
  } catch (e) {
    groups = [];
    cur = 0;
    loadErr = e.message || '读取失败';
    await paint();
    return;
  }
  const visible = pillItems();
  if (!visible.length) cur = 0;
  else if (!visible.some((v) => Number(v.id) === Number(cur))) cur = Number(visible[0].id);
  const want = opts && opts.slot ? String(opts.slot) : '';
  if (want) {
    const hit = visible.find((v) => String(v.module_key || '') === want);
    if (hit) cur = Number(hit.id);
  }
  await paint();
}

/**
 * 功能：进「个人资产管理」这一屏 —— 取数并画药丸与当前格（**开屏那一步由宿主 `switchTab()` 做**）。
 * @param {{slot?: string}} [opts] - `slot` = 这次要落到哪一格（模块名），见 `load()`
 * @returns {Promise.<void>}
 */
export async function openAssets(opts) {
  // 第六轮（「各部分都应该是逐级返回到【今天】」）：
  // 把「屏内退一层」登记给宿主 —— 停在「我的设备」那一格时，返回先回药丸的第一格。
  // 记账那一格**另有它自己的二级屏**（`lgBackLayer()`，由宿主另一条判据先问）⇒
  setBackHandler('assets', assetsBack);
  await load(opts);
}

/**
 * 功能：**屏内退一层** —— 停在非第一格时，退回药丸的第一格。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 * 从前这一屏的药丸**不参与返回** ⇒ 人在「我的设备」按返回会直接跳回上一级屏。
 * 现在先退回第一格（与用户点药丸同一条 `pick()`），再按才往上走。
 */
function assetsBack() {
  const visible = pillItems();
  const first = visible.length ? Number(visible[0].id) : 0;
  if (!cur || !first || Number(cur) === first) return false;
  pick(first).catch((e) => toast(e.message, true));
  return true;
}

/**
 * 功能：切到某一格（屏内切换：只改 `cur` 再重画）。
 * @param {number} id - 分组 id
 * @returns {Promise.<void>}
 */
async function pick(id) {
  const n = Number(id);
  if (!n || n === cur) return;
  cur = n;
  await paint();
}

/**
 * 功能：把「这一格对应的模块」的界面挂进本屏（槽名 `assets-pane`）。
 *
 * 判据只用 `uiOf(module_key)` 与它的 `slots`：本文件**不认任何模块名**。
 * 失败不静默：`mountModuleSlot()` 自己会在那一格里写一句人话并 `console.error`。
 *
 */
async function mountPane(mod) {
  const host = document.getElementById('assets-pane-host');
  if (!host) return;
  const ui = uiOf(mod);
  if (!ui || !Array.isArray(ui.slots) || !ui.slots.includes(SLOT)) return;
  await mountModuleSlot(host, 'mobile', mod, SLOT, {
    // `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    // `render(ctx)`（它自己的第一个参数不会进 ctx）。视图片段要先把它造的根节点插进文档，
    // 再调模块的渲染函数 —— 那些函数按**全局 id** 找节点（`$('#view-ledger')` 这种），
    container: host,
    end: 'mobile',
    modules: state.modules,
    uiOf,
    me: state.me,
  });
}

/**
 * 功能：屏内动作的分发器 —— 由宿主 `ACTIONS` 表里的 `as-*` 键**动态 import** 进来调。
 *
 * 说明：⚠️⭐ 键名与屏内各按钮的 `data-act` **逐字一致**（宿主那一边是显式登记的转发器）。
 * 任何失败都弹一句人话（⛔ 不静默）。
 * 自建分组 / 分类 / 条目那几条动作（`as-newgroup` / `as-newcat` / `as-newitem` /
 */
export async function assetsAction(act, n) {
  const id = n && n.dataset ? Number(n.dataset.id) : 0;
  try {
    if (act === 'as-pick') return await pick(id);
    if (act === 'as-retry') return await load();
    return undefined;
  } catch (e) {
    toast(e.message || '操作失败', true);
    return undefined;
  }
}

// 设置页里翻动 `hide_digital` / `hide_ledger` 开关时，药丸要跟着少一格 / 多一格。
// 事件由宿主 `applyPrefsVisibility()` 派发；只在**正停在这一屏**时重画（别白画别的屏）。
document.addEventListener('zx:prefs-changed', () => {
  if (state.tab !== 'assets') return;
  const visible = pillItems();
  if (visible.length && !visible.some((v) => Number(v.id) === Number(cur))) cur = Number(visible[0].id);
  paint().catch((e) => toast(e.message, true));
});
