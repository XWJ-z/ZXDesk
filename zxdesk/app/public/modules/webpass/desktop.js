/**
 * modules/webpass/desktop.js —— 「网址/密码夹」那一屏（电脑版，0.8.7）
 *
 * 功能：这一屏自己**一条功能都没有** —— 它只有屏头一颗药丸 `网址收藏夹 ｜ 密码库`
 *      （项由 `slotDefs()` 从两端接线表算出来）与一个空的 `#webpass-body`；
 *      切到哪一边就点名挂**那一边模块自己的片段**（`core/slots.js` 的 `mountModuleSlot()`）。
 *
 * ⭐ **为什么要有这么一屏**：网址收藏夹与密码库是两个独立模块（铁律 11），
 *    要把它们「只并屏、不并功能」。屏必须长在一个**不属于这两者**的地方 ——
 *    长在 `bookmarks` 身上，删掉 `bookmarks/` 就会让 `vault` 变得不可达（方案 §三·1）。
 *    ⇒ 宿主（`desktop/app.js`）**动态** import 本文件，⛔ 不许改成静态：
 *    静态 import 会让「删掉 `public/modules/webpass/`」把宿主页一起打挂，
 *    与方案 §六·3 的退化口径直接冲突。
 *
 * ⚠️⭐ **药丸住屏头静态槽**（`#webpass-tabs` ⊂ `.home-head`），⛔ 不许放进 `#webpass-body` ——
 *    后者每挂一次就被 `mountModuleSlot()` 整块清掉，药丸会跟着一起没（0.8.7 的看板胶囊
 *    踩过同一条，见）。
 *
 * ⚠️⭐ **药丸的项一个都不许写死**：名字 / 图标 / 顺序 / 「关没关」全从
 *    `slotDefs(state.modules, uiOf, state.me)` 来（判据只有一处）。
 *    ⇒ 删掉任一模块目录 ⇒ 自动少一颗；只剩一颗 / 一颗都没有 ⇒ **整条不画**
 *    （只有一种视图时，一条切换控件是纯噪音）。`state.modules === null` 时什么都不判。
 *
 * ⚠️⭐ **切视图前要清一次「持有内存明文」那一侧**：
 *    原来是「离开密码库那一屏 ⇒ `vaultReset()`」，现在两个视图住在同一屏里 ⇒
 *    改派一个**留白事件** `zx:pane-flush`（谁持有明文谁自己听；模块从没加载过就没有明文可清）。
 *    ⛔ 不许「为了切换顺手」让切走后明文还留在内存里 —— 那是放宽现状。
 *
 * ⭐ 0.8.15：本屏的换视图改走 `core/slots.js` 的**交叉淡入**
 *    （`crossFade: true`，旧内容留到新内容就绪、两层同格重叠再一起淡出淡入）；
 *    ⚠️⭐ **`SECRET_MOD`（= 密码库）那一档是唯一的例外**：从它切走时「只淡入、不淡出」——
 *    旧根里可能含明文，不许在屏幕上多留一帧。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.17
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
 * 屏幕上正显示的那一版是不是**含明文的那一版**（写的是**模块名**）—— 0.8.15 交叉淡入的
 * **安全边界**判据。
 *
 * ⚠️⭐ 为什么这里可以（也必须）写死一个模块名：这是那条硬约定的执行点， 明写
 *    「**只要旧节点里可能含明文，它就不参与淡出**」—— 判据必须**一眼可审**，
 *    ⛔ 不许做成「从接线表里推断出来的」那种没人看得懂的形式。
 * ⚠️⭐ 它必须与 `modules/` 下的**目录名**逐字一致；
 *    对不上时**不会报错**，只会让密码库那一趟多淡出 200ms —— 安全边界上的静默失效。
 *    ⇒ 动 `modules/vault/` 的目录名时，务必一起搜这个常量。
 * @type {string}
 */
const SECRET_MOD = 'vault';

/**
 * 这一次重挂要不要「**只淡入、不淡出**」—— 只有「**离开密码库**」那一趟要（见 `pick()` 的说明）。
 *
 * ⚠️⭐ 从前那两个模块级的 `painting` / `again`（合并式防重入）**已收进 `core/slots.js`**
 * （0.8.15）：加了「旧层要留一会儿」之后，并发挂载会留下**两层**旧节点，
 * 防重入必须与「保留旧层」住同一个文件。⛔ 别在这里再加回来。
 * @type {boolean}
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
  // ⭐ 0.8.9：与任务板那一颗**同一个口径** —— 去掉图标、只画名字；
  //    各颗等宽由 `fitTabs()` 在 `draw()` 里画完之后统一撑（见它的说明）。
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
 * 说明：⭐⭐ 0.8.17：「网址/密码库：新建的 + 图标，切换会跟随界面变化，
 *      这个应该是固定在界面上的（参考任务与随手记），两端都要改」——
 *      它原先长在**两个视图片段**里（收藏夹一颗、密码库一颗，各带自己的绑定）
 *      ⇒ 换视图时旧那颗跟着旧片段一起被清掉、新那颗再出现，看着就是「＋ 跟着界面变」。
 *      ⇒ 搬进 `index.html` 的 `#webpass-view`（**屏骨架**、`#webpass-body` 外面），
 *      与药丸同一条纪律；切视图时它原样不动，只换语义。
 *      ⚠️ 它在两个档位下**都常驻**（「固定在界面上」就是这么个意思 —— 不随视图、不随解锁状态
 *      忽隐忽现）。密码库那档若还没解锁，点它由下面那处委托给一句人话提示，⛔ 不去开表单
 *      （未解锁时服务端会 403）。
 *      ⚠️ 图标键没有可读文字 ⇒ 文案一律走 `title` / `aria-label`，⛔ 别写 `textContent`
 *      （那会把「＋」覆盖成一句话，且不报错）。
 * @returns {void}
 */
function paintFab() {
  const b = document.getElementById('webpass-new');
  if (!b) return;
  const isVault = cur === 'vault';
  // 一个视图都没有（药丸整条不画）时才把整颗藏起来 —— 否则它就该一直杵在那儿。
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
  // ⭐ 0.8.15：交叉淡入的**安全边界只看「离开的是谁」** ——
  //    从密码库切走那一趟，旧根里可能含明文 ⇒ 「只淡入、不淡出」（旧层在挂载一进门就被清掉）；
  //    反方向（书签 → 密码库）旧根是书签列表、无明文 ⇒ 正常交叉淡入。
  //    ⚠️ 判据读的是**切换前**的 `cur`（= 此刻屏幕上正显示的那一版）⇒ 这两行的次序不能动。
  noFadeOut = cur === SECRET_MOD;
  // ⭐ 0.8.9：「从密码夹切换回网址：加载过渡动画不好，现在是闪现和残影」——
  //    ⛔ **不再在这里铺骨架 / 藏旧内容**：0.8.15 起由 `slots.js` 的交叉淡入负责
  //    （旧内容一直留到新内容就绪，两层同格重叠再一起淡出 / 淡入）。
  //    ⚠️ 进这一屏（`openWebpass()`）那一下走的是**整屏**动画（`showView()`），
  //    与本屏内这一层不是同一次 —— 两处不会叠加成「闪两下」（0.8.9 的教训）。
  cur = name;
  paint().catch((e) => toast(e.message, true));
}

/**
 * 功能：把药丸与当前视图画出来（**重挂**那一边的片段 —— 片段自己按需取数）。
 *
 * 说明：⚠️ 合并式防重入（同一时刻只挂一趟、期间来的请求只记「还要再画一次」）**已收进
 *      `core/slots.js`**（见 `noFadeOut` 的说明）—— 本文件不再自己记 `painting` / `again`。
 *      它由 `mountModuleSlot(… { crossFade: true })` 接管，返回的 promise 在那**一批**（含
 *      并发时自己补的那趟）全部跑完后才 resolve。
 * @returns {Promise.<void>}
 */
function paint(enter) {
  // ⚠️ 「只淡入、不淡出」是**一次消费**的：在这里取走并清零，免得下一次重挂（比如
  //    `zx:prefs-changed` 那一趟）误用上一趟留下的判据。
  const fadeOut = !noFadeOut;
  noFadeOut = false;
  const tabs = document.getElementById('webpass-tabs');
  const body = document.getElementById('webpass-body');
  if (!tabs || !body) return Promise.resolve();
  const items = itemsOf();
  const names = items.map((it) => it.name);
  painted = names.join(',');
  // ⚠️ 当前视图不在清单里了（模块被关掉 / 被删掉 / 上一次选的没了）⇒ 回落到第一项
  if (!names.includes(cur)) cur = names[0] || '';
  tabs.innerHTML = pillHtml(items, cur);
  // ⭐ 0.8.9：各颗撑成等宽（量最宽那颗）—— 见 `fitTabs()` 的说明。
  fitTabs(tabs);
  // ⭐ 0.8.17：那颗 ＋ 住在**屏骨架**里（不随片段进出）⇒ 每次重画都按档位刷一遍它的显隐与文案。
  paintFab();
  if (!cur) {
    body.innerHTML = '';
    return Promise.resolve();
  }
  // ⚠️ 先清一次内存里的明文（见文件头）—— 次序是「先清、后挂」，与今天「先 vaultReset()
  //    再读状态」逐字一致（这一个字都不许动）。
  document.dispatchEvent(new CustomEvent('zx:pane-flush'));
  // ⭐ 0.8.15：本屏的换视图走**交叉淡入**（`crossFade: true`）——
  //    旧内容一直留到新内容就绪、两层同格重叠再一起淡出淡入；`fadeOut: false` 那一档
  //    只给「从密码库切走」用（旧根可能含明文 ⇒ 立即清掉、新内容照常淡入）。
  //    ⚠️ 从前那句「⛔ 不再在这里铺骨架」**仍然成立**：铺了会被挂载流程当场抹掉
  //    （上一版正是那么写的，所以看到「没有任何变化」）。
  return mountModuleSlot(body, 'desktop', cur, SLOT, {
    // ⚠️⭐ `container` **必须自己带上**：`mountModuleSlot()` 只把 `ctx` 原样透传给片段的
    //    `render(ctx)`（它自己的第一个参数不会进 ctx）。而视图片段**需要先把根节点插进文档**、
    //    再调模块的渲染函数 —— 那些函数按**全局 id** 找节点（`$('#bm-list')` 这种），
    //    节点不在文档里就静默空白。露了这一项的表现是：`ctx.container` 是 `undefined`
    //    ⇒ 片段一进门就 TypeError ⇒ 槽里画一句「界面加载失败」（真浏览器探针抓到的）。
    container: body,
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    crossFade: true,
    fadeOut: fadeOut,
    // ⭐ 0.8.17：**进屏那一趟**（`openWebpass()` 调 `paint(true)`）不播槽内淡入 —— 整屏
    //    `.view.is-swap` 那一条已经在给这一屏淡入，槽里再淡一次就是「同一块内容连淡两次」
    //    （「模块与模块之间切换多次闪现」，探针判据 T27）。
    //    ⚠️ 屏内**点药丸**那一趟（`pick()`）不传 ⇒ 交叉淡入照旧，那正是它要的。
    enterFade: enter !== true,
  });
}

/**
 * 功能：进「网址/密码夹」这一屏 —— 切视图、画侧栏、显示本屏，然后画药丸与第一个视图。
 *
 * 说明：`opts.slot` 是「这一次要落到哪个视图」（模块名）—— 它由**跨模块契约**带进来
 *      （收藏夹里点开一条绑定的密码 ⇒ 派 `zx:open-module`，`detail = { mod:'webpass', slot:'<模块名>' }`，
 *       形态⑥ / 119）。⛔ 没有 slot 时落**第一项**（方案 §二·8：第一轮不做「默认视图」偏好）。
 *
 * @param {{slot?: string}} [opts] - 见上
 * @returns {Promise.<void>}
 */
export async function openWebpass(opts) {
  if (opts && opts.slot) cur = String(opts.slot);
  state.view = 'webpass';
  // ⭐ 0.8.15：进这一屏就把「可能要挂的片段」**预热**起来 —— **不 await**，
  //    与下面 `paint()` 里的取数**并行**（从前是串行：片段到货 → 片段自己再取数，
  //    两趟网络叠在一起 = 白窗的主因）。⛔ 只预热片段 JS，**绝不预热数据**。
  warmSlots('desktop', SLOT, { modules: state.modules, uiOf, me: state.me });
  // ⚠️ 先把「要画的项」记下来：`renderSidebar()` 里那一趟 `applyPrefsVisibility()` 会派
  //    `zx:prefs-changed`（见下面那个监听），不先对齐就会**多挂一次**（白取一趟数）。
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
  // ⭐ 0.8.17：那颗 ＋ 现在住在**屏骨架**里 ⇒ 它的点击由这里按档位分发。
  //    ⚠️ 两个目标模块都走**动态 import**：本文件刻意不在求值期拉起任何模块的实现
  //    （删掉 `modules/bookmarks/` 或 `modules/vault/` 时这一屏仍要起得来）。
  //    ⚠️ 密码库那档未解锁时**只提示、不开表单**（未解锁开表单会被服务端 403）。
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
  await paint(true); // ⭐ 0.8.17：进屏那一趟 —— 槽内不播淡入（见 `paint()` 的说明）
}

// ⭐ 0.8.7：设置页里翻动 `hide_bookmarks` / `hide_vault` 两开时，药丸要跟着变。
//    ⚠️ 判据是「**项的集合真的变了**」—— 没变就什么都不做（否则每次 `renderSidebar()` 都会重取一趟数）。
//    ⚠️ 事件由两端宿主的 `applyPrefsVisibility()` 派发（`shell.js` / `mobile/app.js` 各一处）。
document.addEventListener('zx:prefs-changed', () => {
  if (state.view !== 'webpass') return;
  if (namesOf() === painted) return;
  paint().catch((e) => toast(e.message, true));
});
