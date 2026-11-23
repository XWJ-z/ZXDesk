/**
 * modules/webpass/desktop.js —— 「网址/密码夹」那一屏
 *
 * 功能：这一屏自己**一条功能都没有** —— 它只有屏头一颗药丸 `网址收藏夹 ｜ 密码库`
 * （项由 `slotDefs()` 从两端接线表算出来）与一个空的 `#webpass-body`；
 * 切到哪一边就点名挂**那一边模块自己的片段**（`core/slots.js` 的 `mountModuleSlot()`）。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/架构文档/25-网址与密码.md、docs/公共/开发方案/27-网址与密码合并屏.md、35-视图切换与过渡动画.md
 */

import { esc, fitTabs } from '../../core/dom.js';
import { mountModuleSlot, slotDefs, warmSlots } from '../../core/slots.js';
import { uiOf } from '../../desktop/modules.js';
import { renderSidebar, showView } from '../../desktop/shell.js';
import { state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';

/** 药丸要认清的槽名（与两端接线表里 `bookmarks` / `vault` 声明的那个**逐字一致**） */
const SLOT = 'webpass-pane';

/** 当前视图 = **模块名**（空串 = 还没定 / 清单还没到手 / 一个模块都没有） */
let cur = '';

/** 上一次画出来的项（名字用逗号连起来）—— 只在**项的集合变了**时重挂，别每趟都重取数 */
let painted = '';

/**
 * **安全边界**判据。
 *
 */
const SECRET_MOD = 'vault';

/**
 * 这一次重挂要不要「**只淡入、不淡出**」—— 只有「**离开密码库**」那一趟要（见 `pick()` 的说明）。
 *
 */
let noFadeOut = false;

/**
 * 功能：算一遍药丸的项 —— 「清单 ∩ 本端接线表 ∩ 该模块没被关掉」，顺序跟清单走。
 * @returns {Array.<Object>} `moduleItems()` 条目（带 `slots` / `title` / `icon` / `on`）
 */
function itemsOf() {
  return slotDefs(state.modules, uiOf, state.me).filter((it) => it.slots.includes(SLOT));
}

/** 功能：当前项的名字清单（用于「集合变没变」的比较）。 @returns {string} */
const namesOf = () => itemsOf()
  .map((it) => it.name)
  .join(',');

/**
 * 功能：画药丸（**内容**由 JS 写进静态槽 `#webpass-tabs`）。
 * @param {Array.<Object>} items - `itemsOf()` 的产物
 * @param {string} on - 当前选中的模块名
 * @returns {string} 药丸的 HTML（只有一项时返回空串 —— 整条不画）
 */
function pillHtml(items, on) {
  if (items.length < 2) return '';
  // 与任务板那一颗**同一个口径** —— 去掉图标、只画名字；
  // 各颗等宽由 `fitTabs()` 在 `draw()` 里画完之后统一撑（见它的说明）。
  return `<div class="dash-tabs" role="tablist">${items
    .map(
      (it) =>
        `<button class="dash-tab${it.name === on ? ' on' : ''}" type="button" role="tab" ` +
        `aria-selected="${it.name === on}" data-webpass-view="${esc(it.name)}">` +
        `${esc(it.title)}</button>`,
    )
    .join('')}</div>`;
}

/** 药丸的点击委托**只挂一次**（`#webpass-tabs` 是静态节点，重挂会叠加） */
let pillBound = false;

/** 新建那颗 ＋ 的点击委托**只挂一次**（`#webpass-new` 同样是静态节点） */
let fabBound = false;

/**
 * 功能：按当前档位刷新**屏里那颗 ＋**（显隐 ＋ 无障碍文案）。
 *
 * 这个应该是固定在界面上的（参考任务与随手记），两端都要改」——
 * 它原先长在**两个视图片段**里（收藏夹一颗、密码库一颗，各带自己的绑定）
 * ⇒ 换视图时旧那颗跟着旧片段一起被清掉、新那颗再出现，看着就是「＋ 跟着界面变」。
 */
function paintFab() {
  const b = document.getElementById('webpass-new');
  if (!b) return;
  const isVault = cur === 'vault';
  b.classList.toggle('hidden', !cur);
  b.setAttribute('title', isVault ? '新增一条密码记录' : '新增一条网址收藏');
  b.setAttribute('aria-label', isVault ? '新增密码' : '新增网址');
}

/**
 * 功能：切到药丸里的某一项（屏内切换：只改 state 再重挂，⛔ 不换屏、⛔ 不重取别的数）。
 * @param {string} name - 模块名
 * @returns {void}
 */
function pick(name) {
  if (!name || name === cur) return;
  // 交叉淡入的**安全边界只看「离开的是谁」** ——
  // 从密码库切走那一趟，旧根里可能含明文 ⇒ 「只淡入、不淡出」（旧层在挂载一进门就被清掉）；
  // 反方向（书签 → 密码库）旧根是书签列表、无明文 ⇒ 正常交叉淡入。
  noFadeOut = cur === SECRET_MOD;
  // 「从密码夹切换回网址：加载过渡动画不好，现在是闪现和残影」——
  // （旧内容一直留到新内容就绪，两层同格重叠再一起淡出 / 淡入）。
  // 进这一屏（`openWebpass()`）那一下走的是**整屏**动画（`showView()`），
  cur = name;
  paint().catch((e) => toast(e.message, true));
}

/**
 * 功能：把药丸与当前视图画出来（**重挂**那一边的片段 —— 片段自己按需取数）。
 *
 * 说明：⚠️ 合并式防重入（同一时刻只挂一趟、期间来的请求只记「还要再画一次」）**已收进
 * `core/slots.js`**（见 `noFadeOut` 的说明）—— 本文件不再自己记 `painting` / `again`。
 * 它由 `mountModuleSlot(… { crossFade: true })` 接管，返回的 promise 在那**一批**（含
 */
function paint(enter) {
  // 「只淡入、不淡出」是**一次消费**的：在这里取走并清零，免得下一次重挂（比如
  // `zx:prefs-changed` 那一趟）误用上一趟留下的判据。
  const fadeOut = !noFadeOut;
  noFadeOut = false;
  const tabs = document.getElementById('webpass-tabs');
  const body = document.getElementById('webpass-body');
  if (!tabs || !body) return Promise.resolve();
  const items = itemsOf();
  const names = items.map((it) => it.name);
  painted = names.join(',');
  // 当前视图不在清单里了（模块被关掉 / 被删掉 / 上一次选的没了）⇒ 回落到第一项
  if (!names.includes(cur)) cur = names[0] || '';
  tabs.innerHTML = pillHtml(items, cur);
  // 各颗撑成等宽（量最宽那颗）—— 见 `fitTabs()` 的说明。
  fitTabs(tabs);
  // 那颗 ＋ 住在**屏骨架**里（不随片段进出）⇒ 每次重画都按档位刷一遍它的显隐与文案。
  paintFab();
  if (!cur) {
    body.innerHTML = '';
    return Promise.resolve();
  }
  // 先清一次内存里的明文（见文件头）—— 次序是「先清、后挂」，与今天「先 vaultReset()
  document.dispatchEvent(new CustomEvent('zx:pane-flush'));
  // 本屏的换视图走**交叉淡入**（`crossFade: true`）——
  // 旧内容一直留到新内容就绪、两层同格重叠再一起淡出淡入；`fadeOut: false` 那一档
  // 只给「从密码库切走」用（旧根可能含明文 ⇒ 立即清掉、新内容照常淡入）。
  return mountModuleSlot(body, 'desktop', cur, SLOT, {
    // `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    // `render(ctx)`（它自己的第一个参数不会进 ctx）。而视图片段**需要先把根节点插进文档**、
    // 再调模块的渲染函数 —— 那些函数按**全局 id** 找节点（`$('#bm-list')` 这种），
    container: body,
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    crossFade: true,
    fadeOut: fadeOut,
    // **进屏那一趟**（`openWebpass()` 调 `paint(true)`）不播槽内淡入 —— 整屏
    // `.view.is-swap` 那一条已经在给这一屏淡入，槽里再淡一次就是「同一块内容连淡两次」
    // （「模块与模块之间切换多次闪现」，探针判据 T27）。
    enterFade: enter !== true,
  });
}

/**
 * 功能：进「网址/密码夹」这一屏 —— 切视图、画侧栏、显示本屏，然后画药丸与第一个视图。
 *
 * 说明：`opts.slot` 是「这一次要落到哪个视图」（模块名）—— 它由**跨模块契约**带进来
 * （收藏夹里点开一条绑定的密码 ⇒ 派 `zx:open-module`，`detail = { mod:'webpass', slot:'<模块名>' }`，
 *
 */
export async function openWebpass(opts) {
  if (opts && opts.slot) cur = String(opts.slot);
  state.view = 'webpass';
  // 进这一屏就把「可能要挂的片段」**预热**起来 —— **不 await**，
  // 与下面 `paint()` 里的取数**并行**（从前是串行：片段到货 → 片段自己再取数，
  // 两趟网络叠在一起 = 白窗的主因）。⛔ 只预热片段 JS，**绝不预热数据**。
  warmSlots('desktop', SLOT, { modules: state.modules, uiOf, me: state.me });
  // 先把「要画的项」记下来：`renderSidebar()` 里那一趟 `applyPrefsVisibility()` 会派
  // `zx:prefs-changed`（见下面那个监听），不先对齐就会**多挂一次**（白取一趟数）。
  painted = namesOf();
  renderSidebar();
  showView('webpass');
  if (!pillBound) {
    pillBound = true;
    const tabs = document.getElementById('webpass-tabs');
    if (tabs)
      tabs.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-webpass-view]') : null;
        if (b) pick(b.getAttribute('data-webpass-view'));
      });
  }
  // 那颗 ＋ 现在住在**屏骨架**里 ⇒ 它的点击由这里按档位分发。
  // 两个目标模块都走**动态 import**：本文件刻意不在求值期拉起任何模块的实现
  // （删掉 `modules/bookmarks/` 或 `modules/vault/` 时这一屏仍要起得来）。
  if (!fabBound) {
    fabBound = true;
    const add = document.getElementById('webpass-new');
    if (add)
      add.addEventListener('click', () => {
        if (cur === 'vault') {
          if (!(state.vault && state.vault.unlocked)) {
            toast('先解锁密码库，再新增记录', true);
            return;
          }
          import('../vault/desktop.js')
            .then((m) => m.openVaultEntryForm(null))
            .catch((e) => toast(e.message, true));
          return;
        }
        import('../bookmarks/desktop.js')
          .then((m) => m.newBookmark())
          .catch((e) => toast(e.message, true));
      });
  }
  await paint(true); // 进屏那一趟 —— 槽内不播淡入（见 `paint()` 的说明）
}

// 设置页里翻动 `hide_bookmarks` / `hide_vault` 两开时，药丸要跟着变。
// 事件由两端宿主的 `applyPrefsVisibility()` 派发（`shell.js` / `mobile/app.js` 各一处）。
document.addEventListener('zx:prefs-changed', () => {
  if (state.view !== 'webpass') return;
  if (namesOf() === painted) return;
  paint().catch((e) => toast(e.message, true));
});
