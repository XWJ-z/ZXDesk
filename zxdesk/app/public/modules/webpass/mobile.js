/**
 * modules/webpass/mobile.js —— 「网址/密码夹」那一屏（手机版，0.8.7）
 *
 * 功能：与电脑版**同形同义**：这一屏自己**一条功能都没有** —— 只有第一行一颗药丸
 *      `网址收藏夹 ｜ 密码库`（项由 `slotDefs()` 从两端接线表算出来）与一个空的 `#webpass-body`；
 *      切到哪一边就点名挂**那一边模块自己的片段**（`core/slots.js` 的 `mountModuleSlot()`）。
 *
 * ⚠️⭐ **药丸住第一行**（`#webpass-tabs`，在 `#webpass-body` **外面**、是 `mobile/index.html` 里
 *    的静态骨架）：手机端的「标题」在**全局固定顶栏**里（那行还要装标题 + 副标题 + 刷新键，
 *    390px 宽塞不进一颗药丸），所以它落在内容区第一行 —— 位置感与电脑端的「屏头」一致。
 *    ⛔ 不许把它放进 `#webpass-body`：后者每挂一次就被整块清掉，药丸会跟着一起没。
 *
 * ⚠️⭐ **项一个都不许写死**（与电脑版同一条纪律）：名字 / 图标 / 顺序 / 「关没关」全从
 *    `slotDefs(state.modules, uiOf, state.me)` 来。删掉任一模块目录 ⇒ 自动少一颗；
 *    只剩一颗 / 一颗都没有 ⇒ **整条不画**。`state.modules === null` 时什么都不判。
 *
 * ⚠️⭐ **本文件刻意不 import `mobile/app.js`**（它要 `switchTab` 才能开屏）：
 *    宿主那边用**动态** `import()` 调 `openWebpass()`（静态 import 会让「删掉本目录」
 *    把宿主页一起打挂，与方案 §六·3 的退化口径冲突；也让本文件免于「求值期拉起入口」）。
 *
 * ⭐ 0.8.15：本屏的换视图改走 `core/slots.js` 的**交叉淡入**
 *    （`crossFade: true`，与电脑端**同形同义**）；⚠️⭐ **`SECRET_MOD`（= 密码库）
 *    那一档是唯一的例外**：从它切走时「只淡入、不淡出」（旧根可能含明文，见那个常量的说明）。
 *    ⚠️ 本端从前**连 `swapIn` 都没调**—— 这一版起两端的过渡口径才真正对齐。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.34
 * 相关：docs/公共/架构文档/25-网址与密码.md、docs/公共/开发方案/27-网址与密码合并屏.md、35-视图切换与过渡动画.md
 */

import { esc } from '../../core/dom.js';
import { mountModuleSlot, slotDefs } from '../../core/slots.js';
import { uiOf } from '../../mobile/modules.js';
import { state } from '../../mobile/state.js';
import { setBackHandler, toast } from '../../mobile/ui.js';

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
  return slotDefs(state.modules, uiOf, state.me || {}).filter((it) => it.slots.includes(SLOT));
}

/** 功能：当前项的名字清单（用于「集合变没变」的比较）。 @returns {string} */
const namesOf = () =>
  itemsOf()
    .map((it) => it.name)
    .join(',');

/**
 * 功能：画药丸（**内容**由 JS 写进静态槽 `#webpass-tabs`）。
 * @param {Array.<Object>} items - `itemsOf()` 的产物
 * @param {string} on - 当前选中的模块名
 * @returns {string} 药丸的 HTML（只有一项时返回空串 —— 整条不画）
 */
function pillHtml(items, on) {
  // ⚠️ 手机版画**线性图标**：这里用模块名对应的 `svg`（接线表里有），⛔ 不用 `module.json` 的 emoji
  if (items.length < 2) return '';
  return `<div class="dash-tabs" role="tablist">${items
    .map((it) => {
      const ui = uiOf(it.name) || {};
      const ico = ui.svg ? `<span class="tab-ico" aria-hidden="true">${ui.svg}</span>` : '';
      return (
        `<button class="dash-tab${it.name === on ? ' on' : ''}" type="button" role="tab" ` +
        `aria-selected="${it.name === on}" data-act="webpass-view" data-view="${esc(it.name)}">` +
        `${ico}${esc(it.title)}</button>`
      );
    })
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
 *      它原先长在**两个视图片段**里（收藏夹一颗、密码库一颗，各带自己的 `data-act`）
 *      ⇒ 换视图时旧那颗跟着旧片段一起被清掉、新那颗再出现，看着就是「＋ 跟着界面变」。
 *      ⇒ 搬进 `mobile/index.html` 的 `#view-webpass`（**屏骨架**、`#webpass-body` 外面），
 *      与药丸同一条纪律；切视图时它原样不动，只换语义。
 *      ⚠️ 它在两个档位下**都常驻**（「固定在界面上」就是这么个意思 —— 不随视图、不随解锁状态
 *      忽隐忽现）。密码库那档若还没解锁，点它由 `openWebpass()` 里那处委托给一句人话提示，
 *      ⛔ 不去开表单（未解锁时服务端会 403）。
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
  cur = name;
  paint().catch((e) => toast(e.message, true));
}

/**
 * 功能：**屏内退一层**（系统返回键落到这一屏时宿主来问一句）—— 停在密码库就退回第一项（网址收藏夹）。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 *      从前这一屏的药丸**不参与返回** ⇒ 人在「密码库」按返回会直接跳回上一级屏，那一屏整块丢掉。
 *      现在先退回**第一项**（与用户点药丸同一条 `pick()`），再按才往上走。
 *      ⚠️ 判据是「当前不是第一项」，⛔ 不是「当前是密码库」：第一项是哪一个由清单说了算
 *      （收藏夹被关掉时第一项可能就是密码库）——写死模块名会在那种情况下**永远退不动**。
 * @returns {boolean} 真 = 退了一层；假 = 已经停在第一项
 */
function webpassBack() {
  const items = itemsOf();
  const first = items.length ? items[0].name : '';
  if (!cur || !first || cur === first) return false;
  pick(first);
  return true;
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
  // ⚠️ 「只淡入、不淡出」是**一次消费**的：在这里取走并清零，免得下一次重挂误用上一趟的判据。
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
  // ⭐ 0.8.17：那颗 ＋ 住在**屏骨架**里（不随片段进出）⇒ 每次重画都按档位刷一遍它的显隐与文案。
  paintFab();
  if (!cur) {
    body.innerHTML = '';
    return Promise.resolve();
  }
  // ⚠️ 先清一次内存里的明文—— 次序与今天「先 vaultReset() 再读状态」一致
  document.dispatchEvent(new CustomEvent('zx:pane-flush'));
  // ⭐ 0.8.15：本屏的换视图走**交叉淡入**（与电脑端同形同义）——
  //    `fadeOut: false` 那一档只给「从密码库切走」用（旧根可能含明文 ⇒ 立即清掉）。
  return mountModuleSlot(body, 'mobile', cur, SLOT, {
    // ⚠️⭐ `container` **必须自己带上**（与电脑端同一条：`mountModuleSlot()` 不会替你把容器
    //    放进 `ctx`）—— 视图片段要先把它造的根节点插进文档，再调模块的渲染函数，
    //    而后者按全局 id 找节点。露了这一项 ⇒ `ctx.container` 是 undefined ⇒ 片段 TypeError。
    container: body,
    end: 'mobile',
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
 * 功能：进「网址/密码夹」这一屏 —— 画药丸与当前视图（**开屏那一步由宿主 `switchTab()` 做**）。
 *
 * 说明：`opts.slot` 是「这一次要落到哪个视图」（模块名）—— 由**跨模块契约**带进来
 *      （收藏夹里点开一条绑定的密码 ⇒ 派 `zx:open-module`，`detail = { mod:'webpass', slot:'<模块名>' }`，
 *       形态⑥ / 119）。⛔ 没有 slot 时落**第一项**（方案 §二·8：第一轮不做「默认视图」偏好）。
 *
 * @param {{slot?: string}} [opts] - 见上
 * @returns {Promise.<void>}
 */
export async function openWebpass(opts) {
  // ⭐⭐ 第六轮：「屏内退一层」登记给宿主（见 `webpassBack()` 的说明）。幂等。
  setBackHandler('webpass', webpassBack);
  if (opts && opts.slot) cur = String(opts.slot);
  // ⚠️ 先把「要画的项」记下来：下面挂监听那一步之后宿主就会派 `zx:prefs-changed`，
  //    不先对齐就会**多挂一次**（白取一趟数）。
  painted = namesOf();
  if (!pillBound) {
    pillBound = true;
    const tabs = document.getElementById('webpass-tabs');
    if (tabs)
      tabs.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-act="webpass-view"]') : null;
        if (b) pick(b.getAttribute('data-view'));
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
          import('../vault/mobile.js')
            .then((m) => m.vaultForm(null))
            .catch((e) => toast(e.message, true));
          return;
        }
        import('../bookmarks/mobile.js')
          .then((m) => m.bmForm(null))
          .catch((e) => toast(e.message, true));
      });
  }
  await paint(true); // ⭐ 0.8.17：进屏那一趟 —— 槽内不播淡入（见 `paint()` 的说明）
}

// ⭐ 0.8.7：设置页里翻动 `hide_bookmarks` / `hide_vault` 两开时，药丸要跟着变。
//    ⚠️ 判据是「**项的集合真的变了**」—— 没变就什么都不做（否则每次刷新都会重取一趟数）。
//    ⚠️ 事件由两端宿主的 `applyPrefsVisibility()` 派发（`shell.js` / `mobile/app.js` 各一处）。
document.addEventListener('zx:prefs-changed', () => {
  if (state.tab !== 'webpass') return;
  if (namesOf() === painted) return;
  paint().catch((e) => toast(e.message, true));
});
