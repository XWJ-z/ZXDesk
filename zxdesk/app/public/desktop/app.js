/**
 * desktop/app.js —— 电脑版**入口**
 *
 * 功能：
 *      `bindEvents()` 一次性给页面上所有静态控件挂事件监听（顶栏按钮、课表工具条、搜索框、
 *      快速添加、看板切换与日期轴、各类模态框，以及全局键盘与窗口 resize）；
 *      `init()` 走首屏流程 —— 渲染骨架屏、发一个聚合请求、画出首页看板。
 *      文件末尾还负责把本端的 `toast` 注册给 `core/api.js`，并给初始化挂一个可见的失败兜底。
 *
 * 职责只有两件：**绑定事件**（`bindEvents`）+ **启动**（`init`）。
 *
 * ⚠️ 0.2.0（审查报告 A1）把原来单文件 2876 行的 IIFE 拆成：
 *    `public/core/`    两端共用（常量 / 日期 / DOM / 任务语义 / REST）
 *    `public/desktop/` 电脑版自己的状态、外壳与各视图（本文件是入口）
 *    **没有构建步骤**：`<script type="module">` 是浏览器原生能力（铁律 1）。
 *
 * ⚠️ 启动流程 0.2.0 起**刻意留在本文件**（原先单独一个 `init.js`）：那两个文件互相 import
 *    （入口要 `init`，启动要 `bindEvents`）是**循环依赖**。ESM 能容忍它，但代价是
 *    「谁先求值」变成了需要推理的事，而这里没有任何理由付这个代价 —— 合并成一个入口即可。
 *
 * ⚠️ 首屏**只发一个请求**（`loadBootstrap` → `GET /api/bootstrap`），见 `init()` 里的说明。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.8.61
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { setNotifier } from '../core/api.js';
import { addDays, mondayOf, todayStr } from '../core/date.js';
import { $, skeletonHtml } from '../core/dom.js';
import {
  loadBootstrap,
  loadHealth,
  loadProjects,
  newTask,
  onKeydown,
  openProjects,
  renderSidebar,
  showView,
} from './shell.js';
import { state } from './state.js';
import { closeModal, toast } from './ui.js';
import { loadBoard, openBoard, renderDayStrip, renderTimeline, setBoardPane } from '../modules/tasks/desktop-board.js';
import { bindTaskCardActions, openDailyModal, openProjectModal } from '../modules/tasks/desktop-forms.js';
import {
  applyDashViewDefault,
  dashGoToday,
  dashSetDay,
  dashSetPreset,
  dashShiftWeek,
  loadHome,
  openDashView,
  openHome,
  renderHome,
  snapDashView,
} from './views/home.js';
import { closeDetail, renderQuadrant } from '../modules/tasks/desktop-items.js';
// ⭐⭐ 0.8.7：**网址收藏夹与密码库不再有静态 import** —— 它们不再有自己的屏，
//    界面挂进新那一屏「网址/密码夹」（纯屏模块 `webpass`）的视图片段里。
//    ⛔ 不许加回来：静态 import 会让「删掉 `modules/bookmarks/`（或 `vault/`）」
//    连累**整页起不来**，而那正是方案 §六 的删目录退化口径要守住的东西。
//    ⇒ 开屏走下面 `openWebpass()` 的**动态** `import()`；两边模块的事件委托挂在
//    各自视图片段的根节点上（`bindBmEvents(root)` / `bindVaultEvents(root)`）。
// ⭐⭐ 0.8.7：**随手记不再有静态 import** —— 它不再有自己的屏（并进任务板那一屏，
//    屏头药丸「任务 ｜ 随手记」），界面挂进那一屏的视图片段
//    （`modules/idea/desktop-board-pane.js`，槽名 `board-pane`）。
//    ⛔ 不许加回来：静态 import 会让「删掉 `modules/idea/`」连累**整页起不来**，
//    而那正是方案 §六 的删目录退化口径要守住的东西。
//    ⇒ 屏内那一块由视图片段自己挂；这里只剩「别处想记一条」那一处，
//    走下面 `newIdeaEntry()` 的**动态** `import()`。
// ⭐ 0.3.1 数码管理（原 0.3.1「NAS硬件管理」，0.8.10  改名）：静态 import 仍在
//    （`shell.js` 也要它的 `closeHwDetail`），但**它不再有自己的屏** ——
//    ⭐ 0.8.10：界面上半块挂进了「个人资产管理」那一屏的视图片段
//    （`modules/digital/desktop-assets-pane.js`，槽名 `assets-pane`），
//    ⛔ 所以下面**只剩 `bindHwEvents`**：它每次挂载时按**节点身份**重挂屏内委托，
//    弹窗那一半自己只挂一次（见该函数说明）。
import { bindHwEvents } from '../modules/digital/desktop.js';
// ⭐ 0.7.5 番茄钟：静态 import（它是侧栏的一屏 = 主功能入口，不是低频弹层）
//    ⚠️ 屏内交互（开始 / 暂停 / 继续 / 完成 / 放弃 / 换时长 / 存默认 / 绑任务）在
//       `bindPomodoroEvents()` 里用**一次事件委托**挂好 —— 这一屏整块重画，逐个绑必漏。
// ⭐ 0.8.13：番茄钟并进 `time` 模块 ⇒ 它的 import 与 `OPEN_MODULE` 里那条一起撤，
//    屏内委托改由 `home-desktop.js` 的 `bindTimeEvents()` 转手叫上（宿主不再认识实现）。
// ⭐ 0.8.7 日历：日历**不再有自己的屏**，它现在是首页看板里的第二个视图 ——
//    ⛔ 所以这里**没有**对 `modules/calendar/desktop.js` 的静态 import（那会让「删掉日历目录」
//    连累整页起不来，也违背「宿主不认识模块实现」）；界面由 `views/home.js` 动态挂载。
// ⭐ 0.8.0 记账：静态 import 仍在 —— 首页看板那颗悬浮「＋ → 记账」还要用它
//    （`openLedgerEntry()` 只弹表单、不需要先切屏）。
//    ⚠️⭐ 0.8.10：**它不再有自己的屏** —— 界面挂进了「个人资产管理」那一屏的视图片段
//    （`modules/ledger/desktop-assets-pane.js`，槽名 `assets-pane`）⇒ 这里没有 `openLedger`，
//    也没有 `state.view === 'ledger'` 那一支（屏名已从 `VIEW_NODES` 撤掉）。
import { bindAiProposalEdit as bindLedgerAiEdit, bindLedgerEvents, openLedgerEntry } from '../modules/ledger/desktop.js';
// ⭐ 0.8.6 行程：静态 import（同样是侧栏的一屏 = 主功能入口，不是低频弹层）
//    ⚠️ 屏内交互（新建行程 / 加票 / 打卡 / 记录轨迹）、起在 `bindTripEvents()` 里挂委托。
// ⭐ 0.8.13：行程同理 —— 它与番茄钟一样并进 `time` 模块。
// ⭐ 0.3.5 对话：同样是静态 import（主功能入口，不是低频弹层）
//    ⚠️ 左栏三区（好友 / 会话 / 申请）与右边的消息流每次取数都整块重画，
//       所以屏内交互（同意 / 拒绝 / 拉黑 / 删好友 / 开会话 / 发送）在 `bindTeamworkEvents()`
//       里用**一次事件委托**挂好；`#nav-teamwork` 是静态 DOM，在这里直接绑。
//    ⚠️ SSE 长连接由 `modules/teamwork/desktop.js` 自己管：进屏 start、**离开时由 shell.js 的 showView 关掉**
import { bindTeamworkEvents, openTeamwork } from '../modules/teamwork/desktop.js';
// ⭐ 0.8.9：AI 的静态 import **已撤** —— 它不再有自己的屏，配置并入
//    「设置 → AI 设置」那一栏（模块贡献分栏）⇒ `OPEN_MODULE` 里也没有它了。
//    ⚠️ `index.html` 的 `modulepreload` 那一行**必须跟着删**（两处是双向等式，见那里的注释）。
import { clearSearch, onSearchInput } from './views/search.js';
import { openSettings, renderSettings } from './views/settings.js';
import { bindQuickAddDefaults, deleteProject, quickAdd, saveQaPrefs } from '../modules/tasks/desktop-tasks.js';
import {
  closeTtModal,
  loadTtSchedule,
  openTimetable,
  openTtNew,
  openTtSet,
  renderTtGrid,
  ttBlockRowHtml,
} from '../modules/time/timetable-desktop.js';
// ⭐⭐ 0.8.13：**课表 / 番茄钟 / 行程三块并成一个模块** `time`「番茄钟与日程表」——
//    这一屏的入口、四个 pane 的显隐与屏内委托全在 `home-desktop.js`。
//    ⚠️ 三个接口前缀一个字没改（`/api/{timetable,pomodoro,trip}`），AI 的授权键也没动。
import { bindTimeEvents, openTime } from '../modules/time/home-desktop.js';

/** 课表页头的两个下拉：`[按钮 id, 菜单 id]` —— 派发只认菜单条目上的 `data-tt-new` / `data-tt-set` */
const TT_MENUS = [
  ['#tt-new', '#tt-new-menu'],
  ['#tt-set', '#tt-set-menu'],
];

/**
 * 模块名 → 「点侧栏那颗入口要做什么」。
 *
 * 说明：⭐ 0.5.0 模块化重构：侧栏入口由清单生成（见 `shell.js` 的 `renderNavModules()`），
 *      按钮上带 `data-mod`，点击在 `bindEvents()` 里做一次事件委托，然后查这张表。
 *      ⚠️ 「有哪些模块、什么顺序」在 `module.json` 里；「这一端画成什么样」在 `desktop/modules.js` 里；
 *      「点它开哪一屏」只能在这里 —— 因为**只有本文件 import 了全部视图**
 *      （把打开动作塞进 `desktop/modules.js` 会绕成 `shell.js → modules.js → views/*.js → shell.js` 的环）。
 *      ⚠️ 清单里有、这张表里没有的模块：界面画不出入口（`desktop/modules.js` 里也就没有 `nav`），
 *      所以这张表**不会**出现「按钮在、点了没反应」的情况；两者的一致性由
 *      `ttt/test/module-ui.test.js` 钉住。
 *
 * @type {Object.<string, Function>}
 */
const OPEN_MODULE = {
  // ⭐ 0.8.13：三块并成一个模块 ⇒ 这里只留一条 `time`（它默认落首页「日程表」，
  //    也可以带 `{ tab }` 直接落到某个子屏，见 `home-desktop.js` 的 `openTime()`）。
  time: (opts) => openTime(opts),
  // ⭐ 0.8.7：网址/密码夹 —— 收藏夹与密码库**并成这一屏**（两个模块各自独立，
  //    只是不再有自己的屏）。⚠️ 它的值**必须走动态 import**（见下面 `openWebpass()`）。
  webpass: (opts) => openWebpass(opts),
  // ⭐ 0.8.10：个人资产管理 —— 它有自己的屏，但**必须走动态 import**
  //    （见下面 `openAssets()`：删掉 `public/modules/assets/` 时宿主页要照常起来）。
  //    ⚠️⭐ 它也是「生活记账 / 数码管理 / 用户自建分组」那一屏 —— 三格都在它的药丸里，
  //    所以 `ledger` / `digital` **不在这张表里**（它们没有侧栏入口）。
  assets: () => openAssets(),
  teamwork: openTeamwork,
  // ⭐ 0.8.9：`ai` **从这里撤掉了** —— 撤了 `nav` 之后它没有独立屏可开。
  //    ⚠️ `module-ui.test.js` 有一条断言钉着「`OPEN_MODULE` 的键 == 接线表里带 `nav` 的模块」，
  //    所以这两处**必须同进同出**（只改一处 = 那一条当场红）。
};

/**
 * 功能：打开「网址/密码夹」那一屏 —— ⛔ **必须动态 import**（与 `modules/calendar/*` 同一条纪律）。
 *
 * 说明：⚠️⭐ 静改 `import { openWebpass } from '../modules/webpass/desktop.js'` 的后果是
 *      「删掉 `public/modules/webpass/`」连累**宿主页起不来**（模块求值即抛），
 *      而方案 §六·3 要的正是「删掉它，宿主页照旧、两个真模块的接口与数据照常」。
 *      `opts.slot` = 这次要落到哪个视图（模块名）—— 由 `zx:open-module` 的 `detail.slot` 传进来。
 *      ⚠️ 动态 import 的路径必须是**字面量**：`ttt/test/frontend-modules.test.js` 的孤岛检查
 *      用正则扫 `import('…')`，写成变量它看不见 ⇒ 那个文件会被误判成「生了但从不执行」。
 *
 * @param {{slot?: string}} [opts] - 见上
 * @returns {Promise.<void>}
 */
async function openWebpass(opts) {
  try {
    const m = await import('../modules/webpass/desktop.js');
    await m.openWebpass(opts);
  } catch (e) {
    toast('网址/密码夹打不开：' + e.message, true);
  }
}

/**
 * 功能：打开「个人资产管理」那一屏 —— ⛔ **必须动态 import**（与 `webpass` / `calendar` 同一条纪律）。
 *
 * 说明：⚠️⭐ 写成静态 import 的后果是「删掉 `public/modules/assets/`」连累**宿主页起不来**
 *      （模块求值即抛），而方案 §四·1 要的正是「删掉它，宿主页照旧、`ledger` / `digital`
 *      的接口与数据照常」。
 *      ⚠️ 动态 import 的路径必须是**字面量**：`ttt/test/frontend-modules.test.js` 的孤岛检查
 *      用正则扫 `import('…')`，写成变量它看不见 ⇒ 那个文件会被误判成「生了但从不执行」。
 *
 * @returns {Promise.<void>}
 */
async function openAssets() {
  try {
    const m = await import('../modules/assets/desktop.js');
    await m.openAssets();
  } catch (e) {
    toast('个人资产管理打不开：' + e.message, true);
  }
}

/**
 * 功能：从**别的屏**开「记一条灵感」的弹层（首页看板那颗悬浮 ＋ 菜单里的「💡 随手记一条」）。
 *
 * 说明：⚠️⭐ 0.8.7：**必须动态 import** —— 随手记并进任务板那一屏之后，宿主不再
 *      静态认识它的实现（撤掉静态 import 才守得住「删掉 `modules/idea/` 时宿主页照旧」，
 *      方案 §六 的退化口径）。它只是弹一个模态框，不需要先切屏。
 *      ⚠️ 动态 import 的路径必须是**字面量**：`ttt/test/frontend-modules.test.js` 的孤岛检查
 *      用正则扫 `import('…')`，写成变量它看不见 ⇒ 那个文件会被误判成「生了但从不执行」。
 *
 * @returns {Promise.<void>}
 */
async function newIdeaEntry() {
  try {
    const m = await import('../modules/idea/desktop.js');
    m.newIdea();
  } catch (e) {
    toast('随手记打不开：' + e.message, true);
  }
}

/**
 * 功能：收起课表页头的两个下拉菜单（同时把按钮的 `aria-expanded` 归位）。
 * @returns {void}
 */
export function closeTtMenus() {
  for (const [btnSel, menuSel] of TT_MENUS) {
    $(menuSel).classList.add('hidden');
    $(btnSel).setAttribute('aria-expanded', 'false');
  }
}

/**
 * 功能：开合课表页头的某个下拉菜单（开之前先把另一个收起来，两个菜单不会同时挂着）。
 *
 * 说明：⚠️ **只切 `.hidden`**，绝不重画工具栏 —— 工具栏是静态骨架，重画会连带换掉
 *      `#tt-term` 那个正在被操作的 `<select>`。
 *      ⚠️ 「点别处收起」挂在 `document` 的捕获阶段（见 `bindEvents()`），
 *      判据是 `closest('.tt-menu-wrap')` —— 点菜单自己不算「别处」。
 *
 * @param {string} btnSel - 菜单按钮的选择器
 * @param {string} menuSel - 菜单面板的选择器
 * @returns {void}
 */
export function toggleTtMenu(btnSel, menuSel) {
  const willOpen = $(menuSel).classList.contains('hidden');
  closeTtMenus();
  if (!willOpen) return;
  $(menuSel).classList.remove('hidden');
  $(btnSel).setAttribute('aria-expanded', 'true');
}

/**
 * 功能：给页面上带 `data-autofill-guard` 的输入框解锁 —— 它们在 HTML 里是 `readonly`，
 *      用户要打字时才就地摘掉这个属性。
 *
 * 说明：⭐ 起因是「搜索框老是自动填入密码」（其实是 ZXDesk 的登录用户名），
 *      0.4.5 又报了一次「Edge 的『保存的密码』浮层照样弹」。
 *
 *      ⚠️ **0.4.4 那版修法是错的，别改回去**：当时给这些框写了 `autocomplete="new-password"`，
 *      以为那是「别填这儿」的信号 —— 恰恰相反，Chromium 的密码管理器是**按名字**认
 *      `new-password` / `current-password` 这两个值的（它甚至用 `new-password` 去绕过 readonly 排除），
 *      写上去等于**亲手把搜索框标成密码框**。0.4.5 起改成 `autocomplete="off"`：
 *      Chromium 忽略 `off` 只发生在「密码表单 / 信用卡」上，普通文本框是认的。
 *
 *      ⚠️ **解锁时机也不能随便挑**：`readonly` 确实挡得住**页面加载时**的填充，但挂在
 *      `pointerdown` / `focusin` 上解锁等于「浏览器刚要弹浮层的那一刻，框正好变可写」。
 *      所以：**鼠标 / 键盘走 `keydown`**（焦点已经落下来、框还是只读的，第一个字符照样进得去）、
 *      **触摸走 `touchstart`**（手机不提前解锁就弹不出软键盘，那比自动填充更糟，而且这个浮层是
 *      Edge 桌面端的问题）；**失焦时把 `readonly` 装回去**，下次聚焦仍然是一个只读框。
 *
 * @returns {void}
 */
export function unlockAutofillGuards() {
  /**
   * 功能：摘掉这个框的 `readonly`（命中守卫节点时才动手）。
   * @param {Event} e - 事件对象
   * @returns {void}
   */
  const unlock = (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-autofill-guard]') : null;
    if (el) el.removeAttribute('readonly');
  };
  /** 功能：失焦时把守卫装回去，让每一次聚焦都从「只读」开始。 @param {Event} e - 事件对象 @returns {void} */
  const rearm = (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-autofill-guard]') : null;
    if (el) el.setAttribute('readonly', '');
  };
  // ⚠️ 必须用**事件委托 + 捕获阶段**挂一次，不要逐个 input 去绑：两端有些搜索框是每次重画
  //    插进 DOM 的，逐个绑会在重画后失效（症状就是「搜索框点不动、打不进字」）。
  document.addEventListener('keydown', unlock, true);
  document.addEventListener('touchstart', unlock, true);
  document.addEventListener('focusout', rearm, true);
}

/**
 * 功能：一次性给页面上所有**静态**控件挂事件监听 —— 侧栏核心两颗入口（首页看板 / 项目任务）
 *      与**模块入口的事件委托**、项目任务屏的新建项目、编辑与删除项目 / 刷新 / 设置）、
 *      设置页与账号、成员页之间的往返按钮、课表工具条与课表弹窗、搜索框、快速添加、
 *      看板切换与日期轴（换周 / 回今天 / 点某一天）、甘特图的换周按钮、各类模态框的关闭动作、
 *      全局键盘（`onKeydown`）与窗口 resize。
 *
 * 说明：日期格子等**动态重画**的元素用事件委托，不逐个绑定；resize 只在时间轴正显示时重算 ——
 *      隐藏时容器宽度为 0，重算只会得到错误列宽（切过去时 `setBoardPane` 会重算），
 *      重算本身还经过 `resizeTimer` 做 120ms 的 debounce。
 *      ⭐ **模块入口只有一次委托**（0.5.0）：那些按钮由 `shell.js` 按清单生成、每次重画都是新节点，
 *      所以绝不要在这里写 `$('#btn-timetable').addEventListener(...)` 那种逐个别绑 ——
 *      节点没了会抛 null（`init()` 整个中止 ⇒ 整页空白），节点换了监听器又跟着丢。
 *
 * @returns {void}
 */
export function bindEvents() {
  // ⭐⭐ 0.8.4：**「跳到另一个视图 / 模块」的通用出口**（与手机端逐字同款，见 mobile/app.js）。
  //    模块（记账）只派 `zx:open-module`，宿主查 `OPEN_MODULE` 表切屏 —— 模块之间零 import。
  //    ⭐ 0.8.4：`detail.slot` **两端同一套规矩**（以前电脑端忽略它，因为电脑端 AI 是独立视图）——
  //    现在记账那颗 AI 圆环要的是「对话里的 AI 助手」⇒ 与手机端一致：先切到对话，
  //    再派 `zx:teamwork-slot-open` 让对话模块去兑现（条目由 ai 片段异步登记，见 teamwork/desktop.js 的
  //    `tryOpenWantSlot()`；宿主不认识插槽、也不 import 任何模块）。
  // ⭐⭐ 0.8.7 修订：**设置页那颗「默认使用日历视图」药丸刚被翻过** ——
  //    宿主立刻把内存里的「当前视图」拨过去，别等下一次取数。
  //    ⚠️ 不补这一下的表现就是那条：「药丸开了，进首页看板**从列表视图闪现到日历视图**」
  //    （先按旧值画一遍列表，等 `/api/dashboard` 回来才翻）。
  //    ⚠️ 跨模块契约：派发方是日历模块里那两张 settings-pane 片段，
  //    `detail.view` = **模块名或空串**（空串 = 看板自己的列表视图）。改一处要三处同改。
  document.addEventListener('zx:dash-default-view', (e) => {
    applyDashViewDefault(String((e && e.detail && e.detail.view) || ''));
  });

  document.addEventListener('zx:open-module', (e) => {
    const d = (e && e.detail) || {};
    const mod = String(d.mod || '');
    // ⭐ 0.8.7：`mod === 'home'` 是**首页看板自己的**一条 —— 打开看板并切到
    //    `slot` 那个模块贡献的视图（0.8.7 起是记账那颗「日历」图标要的落地）。
    //    ⚠️ 判据是「目标屏 = 看板」而**不是**某个模块名（看板不是模块、也不在 `OPEN_MODULE` 里，
    //    那张表的键必须与接线表里带 `nav` 的模块完全一致 —— `module-ui.test.js` 钉着）。
    //    ⛔ 别把它写成 `if (slot === 'calendar')`。
    if (mod === 'home') {
      // ⚠️ 次序：先 `openHome()`（它会按偏好重落默认视图），**再**按这一次的目标覆盖它。
      //    合成一个函数的话，「先落默认、再覆盖」这件事就没有地方写了。
      openHome().then(() => {
        if (d.slot) openDashView(String(d.slot));
      });
      return;
    }
    const open = OPEN_MODULE[mod];
    // ⭐ 0.8.7：`detail.slot` 交给目标屏自己解释 —— 目前只有「一屏两视图」的
    //    `webpass` 用它（决定这次落哪个视图）。其余条目的函数是**零参**，多余参数天然被忽略。
    if (open) open({ slot: String(d.slot || '') });
    if (d.slot) {
      document.dispatchEvent(new CustomEvent('zx:teamwork-slot-open', { detail: { key: String(d.slot) } }));
    }
  });
  unlockAutofillGuards();
  // ⭐ 0.7.6：主导航折叠开关（全局偏好，纯界面 —— 见 `paintSideCollapsed` 的说明）
  $('#side-toggle').addEventListener('click', toggleSideCollapsed);
  $('#nav-home').addEventListener('click', () => openHome());
  // ⭐ 0.4.5 首页看板的区间切换（静态骨架，只改 state 再重画 `#home-body`）：
  //    ① 三档预设按钮；② 两个日期框（手改任一个 → 预设变成「自定义」）。
  //    ⚠️ 这两个输入框**没有** `data-autofill-guard`：它们是 `type="date"` 的原生日期框，
  //    不是文本框、浏览器不会往里面填凭据；给它加 `readonly` 反而会让原生选择器点不开。
  //    ⭐ 0.5.2 多了一档**单日**（`day`）：看任意一天。⚠️ 它与「今日」是两个档 ——
  //    「今日」永远跟着今天走，「单日」停在用户挑的那一天（跨天也不漂）。
  document.querySelectorAll('#dash-presets .seg-btn').forEach((b) => {
    b.addEventListener('click', () => dashSetPreset(b.dataset.dash));
  });
  // ⭐ 0.5.5 周条（新区间条）—— 与上面那套旧控件**驱动同一个 state**，只是一组更顺手的入口：
  //    `‹` / `›` 整周前后挪、「今天」回到今日、点某一格看那一天。
  //    ⚠️ 它们都走 `views/home.js` 的导出（`dashShiftWeek` / `dashGoToday` / `dashSetDay`），
  //    不在这里自己拼 `dashRange()` —— 那样就成了第二份「哪个档位对应哪段区间」的真值。
  $('#dash-prev').addEventListener('click', () => dashShiftWeek(-1));
  $('#dash-next').addEventListener('click', () => dashShiftWeek(1));
  $('#dash-go-today').addEventListener('click', () => dashGoToday());
  document.querySelectorAll('#dash-week-days .dash-day').forEach((b) => {
    b.addEventListener('click', () => dashSetDay(b.dataset.dashDay));
  });
  ['#dash-from', '#dash-to'].forEach((sel) => {
    $(sel).addEventListener('change', () => {
      const from = $('#dash-from').value;
      const to = $('#dash-to').value;
      // ⭐ 单日档位下 `to` 那个框是藏起来的（见 `renderDashBar()`）：改 `from` 就是「换一天看」，
      //    所以档位**保持 `day`**，不要掉进「自定义区间」（一掉进去两个框又都冒出来了）
      if (state.dash.preset === 'day' && from) {
        state.dash.range = { from, to: from };
        loadHome();
        return;
      }
      // 半截输入（只填了一头）时不请求：区间不完整只会得到一个荒唐的结果
      if (!from || !to) return;
      state.dash.preset = 'custom';
      // 只管顺序，不替用户改值：倒过来就换一下，别让服务端回一个 400 让他猜
      state.dash.range = from <= to ? { from, to } : { from: to, to: from };
      loadHome();
    });
  });
  $('#nav-projects').addEventListener('click', openProjects);
  // ⭐ 0.8.5：首页看板那颗悬浮 ＋（「电脑端的首页看板……的悬浮 +，
  //    点开出现 新建任务、记账、随手记」）。
  //    ⚠️ 菜单节点是**静态骨架**（`index.html` 里，挂在 `#home-view` 上、不在 `#home-body` 里），
  //    这里只切 `.hidden`，⛔ 不重画 —— `#home-body` 每画一次就被换掉，挂菜单在里面等于每次重绑。
  //    ⚠️ 三个动作放在本文件（**只有本文件 import 了全部视图**，见上面 `OPEN_MODULE` 的说明）。
  const fab = $('#home-fab');
  const fabMenu = $('#home-new-menu');
  /** 功能：收起首页看板那颗 ＋ 的菜单（同时把 `aria-expanded` 归位）。 @returns {void} */
  const closeFabMenu = () => {
    fabMenu.classList.add('hidden');
    fab.setAttribute('aria-expanded', 'false');
  };
  /** 功能：开合那颗 ＋ 的菜单（只切 `.hidden`，见上面的说明）。 @returns {void} */
  const toggleFabMenu = () => {
    const willOpen = fabMenu.classList.contains('hidden');
    fabMenu.classList.toggle('hidden', !willOpen);
    fab.setAttribute('aria-expanded', String(willOpen));
  };
  fab.addEventListener('click', toggleFabMenu);
  fabMenu.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-home-new]');
    if (!b) return;
    // 先收起菜单再开下一层：不收的话新表单会画在菜单底下（看着像「没反应」）
    closeFabMenu();
    if (b.dataset.homeNew === 'task') return openDailyModal();
    if (b.dataset.homeNew === 'ledger') return openLedgerEntry();
    return newIdeaEntry();
  });
  // 点别处 / 按 Esc 一律收起（判据是「不在 `#home-new` 里」—— 点菜单自己不算别处）
  document.addEventListener('click', (e) => {
    if (fabMenu.classList.contains('hidden')) return;
    if (!e.target.closest || !e.target.closest('#home-new')) closeFabMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fabMenu.classList.contains('hidden')) closeFabMenu();
  });
  // ⭐ 0.5.0 模块化重构：模块入口（课表 / 收藏夹 / 硬件 / 密码库 / 对话）**不在这里逐个绑**了 ——
  //    它们的按钮由 `shell.js` 的 `renderNavModules()` 按清单生成，每次重画都是新节点。
  //    ⇒ 这里只挂**一次事件委托**（读按钮上的 `data-mod`），「点它开哪一屏」查下面那张表。
  //    ⚠️ 逐个 `$('#btn-xxx').addEventListener` 的老写法有三个问题：加模块要动这里、
  //    删模块要让 `$()` 回 null（`bindEvents()` 一抛，`init()` 整个中止 ⇒ 整页空白）、
  //    重画之后监听器就丢了（表现是「点了没反应」）。
  //    ⚠️ 表里没有的模块名**什么都不做**：清单里可能有一个本端还没接线的模块。
  $('#project-list').addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-mod]');
    if (!b) return;
    const open = OPEN_MODULE[b.dataset.mod];
    if (open) open();
  });
  // ⭐ 0.4.5：任务板页头的【项目 ▾】—— 换作用域一律走 `openBoard()`（它负责取数 + 重画，
  //    并顺带把这一屏的标题 / 按钮 / 下拉都刷新）。⚠️ 最后那一项是「＋ 新建项目…」：
  //    它**不是**作用域，选中后先把下拉拨回当前项，再弹新建表单 —— 否则下拉会停在一个
  //    并不存在的「作用域」上，用户下次看见它就以为当前项目叫「新建项目」。
  $('#bd-scope').addEventListener('change', () => {
    const v = $('#bd-scope').value;
    if (v === '__new__') {
      $('#bd-scope').value = state.scope;
      return openProjectModal();
    }
    // ⭐ 0.5.2：`all` 是**汇总任务视图**（不是项目 id），别 `Number()` —— 它会变成 NaN
    openBoard(v === 'daily' || v === 'all' ? v : Number(v));
  });
  // ⚠️ 0.4.5：「＋ 新建项目」那颗按钮原来在**已撤掉的卡片屏**上，现在它只存在于任务板页头
  //    【项目 ▾】的最后一项 —— ⛔ 别在这里再绑一个 `#btn-new-project`（节点没了，
  //    绑它会在 `bindEvents()` 里抛 null，整个首屏挂掉，而错误只在一条 toast 里）。
  $('#btn-new-task').addEventListener('click', newTask);
  $('#btn-edit-project').addEventListener('click', () => {
    const p = state.projects.find((x) => x.id === state.scope);
    if (p) openProjectModal(p);
  });
  $('#btn-del-project').addEventListener('click', deleteProject);
  $('#btn-refresh').addEventListener('click', async () => {
    await loadHealth();
    await loadProjects();
    if (state.view === 'home') await loadHome();
    else if (state.view === 'board') await loadBoard();
    // ⭐ 0.8.13：三块并成一个模块 ⇒ 刷新这一屏走一条：
    //    `openTime()` 按 `state.timeTab` **重取当前那一格**（番茄钟重取一次状态、行程重取一次
    //    倒计时与列表、课表沿用当前选中的学期 —— 三家的口径原样保留）。
    else if (state.view === 'time') await openTime();
    // ⚠️ 网址/密码夹刷新 = **重开一次那一屏**（`webpass` 会重挂当前视图的片段，
    //    而那一边自己按需重取 —— 与改造前「收藏夹 / 密码库刷新都是重取一次」逐字一致）。
    else if (state.view === 'webpass') await openWebpass();
    // ⭐ 0.8.10：`hardware` 屏名改 `digital` —— `openHardware` 这个函数名没动。
    // ⚠️⭐ 0.8.10：`state.view === 'digital'` 那一支**已撤** —— 数码管理不再有自己的屏
    //    （界面挂在「个人资产管理」的药丸里）⇒ 刷新它走下面 `assets` 那一支（重挂当前那一格）。
    // ⚠️ 个人资产管理刷新 = **重取一次**：分组树与条目都可能在别处被改过
    //    （另一个标签页、另一台设备）⇒ 重取才对得上。⚠️ 若当前那一格是「生活记账 / 数码管理」，
    //    这一支会**重挂那一边的片段**，它自己按需重取 —— 与改造前「点左下角刷新」逐字一致。
    else if (state.view === 'assets') await openAssets();
    // ⚠️ 记账刷新 = **重取一次**（不是只重画）：资产 / 负债 / 净值与「今天」都是服务端算的，
    //    期间可能已经在别处被改过（另一个标签页、另一台设备）⇒ 重取才对得上。
    // ⚠️⭐ 0.8.10：`state.view === 'ledger'` 那一支**已撤** —— 记账不再有自己的屏
    //    （界面挂在「个人资产管理」的药丸里）⇒ 刷新它走上面 `assets` 那一支（重挂当前那一格）。
    // ⚠️ 对话刷新 = **重新读一遍好友总览**（不是只重画）：期间可能有人在别处改了关系；
    //    已经打开的那个会话会由 `openTeamwork()` 里的 `loadTeamworkOverview()` 校验还在不在
    //    （被删好友 / 拉黑之后它会自己关掉）。实时通道**不重连**（start() 对已开的通道是空操作）。
    else if (state.view === 'teamwork') await openTeamwork();
    // ⭐ 0.8.9：`state.view === 'ai'` 那一支**已撤**（AI 不再有自己的屏）。
    else if (state.view === 'settings') renderSettings();
    toast('已从数据库重新读取');
  });
  // ⭐ 设置（0.2.1）：账号 / 成员 / 导出备份 三个入口收进设置页，侧栏只留「⚙ 设置」一扇门
  //    （导出备份自己也搬进了设置页，见 views/settings.js 的 exportBackup）
  //    ⚠️ 0.4.1 第二轮起「成员管理」也并进了设置页（左菜单的一栏），所以这里不再有
  //       `#btn-admin-back` / `#btn-add-member` —— 「添加成员」的按钮由 views/admin.js 自己画自己绑。
  $('#btn-settings').addEventListener('click', openSettings);

  // 课表：独立视图，与任务板互不干扰
  //    ⚠️ 入口按钮（`#btn-timetable`）不在这里绑 —— 它由清单生成，点击走 `#project-list` 的事件委托
  $('#tt-term').addEventListener('change', async (e) => {
    state.ttTermId = Number(e.target.value);
    state.ttWeek = null;
    await openTimetable(state.ttTermId);
  });
  $('#tt-prev').addEventListener('click', async () => {
    if (!state.ttWeek) return;
    state.ttWeek = Math.max(1, state.ttWeek - 1);
    await loadTtSchedule();
  });
  $('#tt-next').addEventListener('click', async () => {
    if (!state.ttWeek) return;
    state.ttWeek += 1;
    await loadTtSchedule();
  });
  $('#tt-this').addEventListener('click', async () => {
    const w = state.tt && state.tt.today && state.tt.today.week_no;
    if (!w) return toast('这个学期没设「第 1 周星期一」，无法定位本周', true);
    state.ttWeek = w;
    await loadTtSchedule();
  });
  $('#tt-all').addEventListener('click', async () => {
    state.ttWeek = null;
    await loadTtSchedule();
  });
  $('#tt-weekend').addEventListener('change', (e) => {
    state.ttShowWeekend = e.target.checked;
    renderTtGrid();
  });
  // ⭐ 0.4.4 第二版：课表页头四颗平级按钮（导入课表 / ＋课程 /
  //    ⚙作息设置 / ＋学期）合并成**两个下拉**：【＋ 新建】与【⚙ 设置】。
  //    ⚠️ 开合**只切 `.hidden`**，工具栏一个字节都不重画 —— 重画会连带换掉 `#tt-term`
  //    那个正在被操作的 `<select>`；菜单条目只把 `data-tt-new` / `data-tt-set` 交给
  //    `modules/timetable/desktop.js` 的派发表（`openTtNew` / `openTtSet()`），这里不堆 if。
  for (const [btnSel, menuSel] of TT_MENUS) {
    $(btnSel).addEventListener('click', () => toggleTtMenu(btnSel, menuSel));
    $(menuSel).addEventListener('click', (e) => {
      const item = e.target.closest('[data-tt-new], [data-tt-set]');
      if (!item) return;
      closeTtMenus();
      if (item.dataset.ttNew) openTtNew(item.dataset.ttNew);
      else openTtSet(item.dataset.ttSet);
    });
  }
  // 点别处 / 按 Esc 一律收起（判据是「不在 `.tt-menu-wrap` 里」—— 点菜单自己不算别处）
  document.addEventListener('click', (e) => {
    if (!(e.target && e.target.closest && e.target.closest('.tt-menu-wrap'))) closeTtMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTtMenus();
  });

  // ⭐ 0.8.7：收藏夹那三处（`#btn-new-bookmark` 与 `bindBmEvents()`）**不在这里**了 ——
  //    那颗按钮与整屏的委托都随骨架搬进了 `modules/bookmarks/desktop-webpass-pane.js`
  //    （片段的根节点上挂一次）。⛔ 别加回来：`#btn-new-bookmark` 是**片段里才有的节点**，
  //    这里 `$()` 回 null ⇒ `.addEventListener` 当场 TypeError ⇒ 整页空白 ＋ 一条 toast。

  // ⭐ 0.8.7：随手记那两处绑定（`bindIdeaEvents()`）**不在这里**了 ——
  //    它随骨架搬进了 `modules/idea/desktop-board-pane.js`，挂在**片段自己造的根节点**上
  //    （`bindIdeaEvents(root)`）。⛔ 别加回来：那段代码要在片段自己的子树里找 `#idea-q` /
  //    `#btn-new-idea` / `#idea-body`，而这三个节点只在片段挂载之后才存在。

  // ⭐ 0.8.10：`$('#btn-new-hardware')` 那一颗**不在这里**了 —— 它随数码管理的骨架
  //    搬进了 `modules/digital/desktop-assets-pane.js`，由 `bindHwEvents()` 在**每次挂载**时
  //    就地绑一次。⛔ 别加回来：那一颗节点现在**只在片段挂载之后**才存在，
  //    这里 `$()` 回 null ⇒ `.addEventListener` 当场 TypeError ⇒ 整个首屏挂掉。
  // ⚠️ `bindHwEvents()` 仍留在这里：它负责**详情弹窗**那一半（静态骨架，只挂一次）；
  //    屏内那一半由片段挂载时调它时补上（按节点身份判据，见该函数说明）。
  bindHwEvents();


  // 记账（0.8.0）：屏内交互走 `#ledger-view` 上的委托，弹窗正文走 `#modal-body` 上的委托 ——
  // 两者是**两棵子树**，在 bindLedgerEvents() 里各挂一次（挂在同一处必然漏一边）
  bindLedgerEvents();
  // ⭐ 0.8.55：AI 确认卡上的「修改」—— 把那一笔预填进记账自己的「记一笔」弹窗
  bindLedgerAiEdit();

  // ⭐ 0.8.13：三块并成一个模块 ⇒ 屏内交互统一在 `home-desktop.js` 的
  //    `bindTimeEvents()` 里挂一次（它转手把番茄钟 / 行程两层委托叫上，并给三个子屏
  //    填「‹ 日程表」返回行）。⚠️ 委托都挂在**静态节点**上（`#time-view` / 各 pane 的 body）。
  bindTimeEvents();

  // ⭐ 0.8.7：密码库那三处（锁定 / 新增 / `bindVaultEvents()`）同理搬进了
  //    `modules/vault/desktop-webpass-pane.js`。搬走它们的收益不只是「省几行」：
  //    宿主**不再静态认识密码库的实现** ⇒ 删掉 `public/modules/vault/` 时宿主页照旧。

  // 对话（0.3.5）：屏内交互（左栏三区 + 发送 + 加好友）在 bindTeamworkEvents() 里用委托挂一次
  bindTeamworkEvents();

  // 任务联动（0.6.4）：对话里那张**任务卡片**上的「收进我的任务板」—— 同样挂一次（留白事件）。
  // ⚠️ 它挂在 document 上、与对话模块无关：对话模块被删掉时这个监听器就永远收不到事件，没有任何副作用。
  bindTaskCardActions();

  $('#tt-modal-close').addEventListener('click', closeTtModal);
  $('#tt-modal-cancel').addEventListener('click', closeTtModal);
  $('#tt-modal').addEventListener('click', (e) => {
    if (e.target === $('#tt-modal')) closeTtModal();
  });

  // 作息块编辑器：加一行 / 删一行。
  // ⚠️ 用**事件委托**挂一次就够 —— 这块 HTML 由 `ttDraftBlocksHtml()` 渲染，而它同时被
  //    「作息设置」与「导入向导」两个弹窗复用（都注入 `#tt-modal-body`）；逐个弹窗各绑一次必然漏一处，
  //    漏的那处表现是「✕ 点了没反应」（本项目最忌讳的一类缺陷）。
  $('#tt-modal-body').addEventListener('click', (e) => {
    const del = e.target.closest('[data-ttblk-del]');
    if (del) {
      del.closest('.tt-block-row').remove();
      return;
    }
    if (e.target.closest('#tt-blk-add')) {
      $('#tt-modal-body').querySelector('.tt-block-list').insertAdjacentHTML('beforeend', ttBlockRowHtml(null));
    }
  });

  // 搜索（E）
  $('#search-input').addEventListener('input', onSearchInput);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
      $('#search-input').blur();
    }
  });
  $('#search-clear').addEventListener('click', () => {
    clearSearch();
    $('#search-input').focus();
  });

  // 快速添加（B）
  $('#qa-btn').addEventListener('click', quickAdd);
  $('#qa-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      quickAdd();
    }
  });
  ['#qa-important', '#qa-urgent'].forEach((sel) => {
    $(sel).addEventListener('click', () => {
      $(sel).classList.toggle('on');
      saveQaPrefs();
    });
  });

  $('#bv-quad').addEventListener('click', () => setBoardPane('quad'));
  $('#bv-timeline').addEventListener('click', () => setBoardPane('timeline'));

  // 四象限上方的日期轴：换周 / 回今天 / 点某一天。与甘特图共用 weekStart 与 selectedDate，
  // 所以每次改动都要把日期轴自己也重画一遍（否则切到甘特图再切回来会是旧的）。
  $('#ds-prev').addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart || mondayOf(todayStr()), -7);
    renderDayStrip();
    renderQuadrant();
  });
  $('#ds-next').addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart || mondayOf(todayStr()), 7);
    renderDayStrip();
    renderQuadrant();
  });
  $('#ds-today').addEventListener('click', () => {
    state.weekStart = mondayOf(todayStr());
    state.selectedDate = todayStr();
    renderDayStrip();
    renderQuadrant();
  });
  // 日期格子是每次重画的，所以用事件委托，不逐个绑
  $('#day-strip').addEventListener('click', (e) => {
    const b = e.target.closest('.ds-day');
    if (!b) return;
    state.selectedDate = b.dataset.date;
    renderDayStrip();
    renderQuadrant();
  });

  $('#tl-prev').addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart || mondayOf(todayStr()), -7);
    renderTimeline();
    renderDayStrip();
  });
  $('#tl-next').addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart || mondayOf(todayStr()), 7);
    renderTimeline();
    renderDayStrip();
  });
  $('#tl-today').addEventListener('click', () => {
    state.weekStart = mondayOf(todayStr());
    state.selectedDate = todayStr();
    renderTimeline();
    renderDayStrip();
    renderQuadrant();
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => {
    if (e.target === $('#modal')) closeModal();
  });

  // 任务详情弹窗
  $('#md-close').addEventListener('click', closeDetail);
  $('#modal-detail').addEventListener('click', (e) => {
    if (e.target === $('#modal-detail')) closeDetail();
  });

  document.addEventListener('keydown', onKeydown);

  // 时间轴随窗口自适应（debounce）—— 只在时间轴正显示时重算，
  // 隐藏时容器宽度为 0，重算只会得到错误列宽（切过去时 setBoardPane 会重算）
  window.addEventListener('resize', () => {
    if (state.view === 'board' && state.boardPane === 'timeline') {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderTimeline(), 120);
    }
  });
}

// ---------- 主导航折叠（0.7.6，纯界面偏好） ----------
/**
 * 「主导航是否收起」偏好所在的 localStorage 键名（值 `'1'` / `'0'`，缺省＝**展开**）。
 *
 * 说明：⭐ 刻意**不做进 `users` 表**（不打后端接口、不加数据库列）：它是纯界面偏好，
 *      与「一次登录的窗口宽度」同级，不值得为它动账号数据。
 *      ⚠️ 缺省**必须是展开** —— 所有既有浏览器探针都假定侧栏是展开的。
 * @type {string}
 */
const SIDE_KEY = 'zxdesk.side-collapsed';

/**
 * 功能：把「收起 / 展开」这一状态画到 `#app` 与开关按钮上（**不读写存储**）。
 *
 * 说明：⭐ 只切 `#app` 上的一个 class —— 侧栏宽度由 CSS 变量 `--side-w` 驱动（见 `desktop/app.css`）；
 *      ⛔ 这里**不摘任何节点**：`.sidebar` / `#nav-home` / `#project-list` 必须一直在
 *      （`module-ui.test.js` 与 `gateway-probe` / `mixed-content-probe` / `browser-probe` 都按它们找节点）。
 *      ⚠️ `aria-expanded` 说的是「侧栏展开着吗」，所以收起时是 `'false'`；
 *      箭头指向「点下去会往哪边走」：展开时 `‹`（往左收）、收起时 `›`（往右放）。
 *
 * @param {boolean} collapsed - 是否收起
 * @returns {void}
 */
function paintSideCollapsed(collapsed) {
  const app = $('#app');
  if (app) app.classList.toggle('collapsed', collapsed);
  const btn = $('#side-toggle');
  if (!btn) return;
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  btn.title = collapsed ? '展开主导航' : '收起主导航';
  btn.textContent = collapsed ? '›' : '‹';
}

/**
 * 功能：读一次「主导航收起」偏好并把它贴到 `#app` 上（缺省＝展开）。
 *
 * 说明：⚠️⭐ 必须在**任何渲染之前**调用（`init()` 的第一行）—— 晚一步就会先画一帧展开的侧栏
 *      再跳回收起，用户看到的是「闪一下」。它只切一个 class，不做别的。
 *      ⚠️ 读写 localStorage 在隐私模式下会抛，一律静默失败、回落到默认（展开）——
 *      与 `modules/tasks/desktop-tasks.js` 的 `QA_KEY` 同一套写法。
 *      ⚠️ 想做到「零闪动」得把这段逻辑塞进 `index.html` 那段内联入口脚本里，而它被 CSP 的
 *      `sha256-…` 钉着—— 本轮**刻意不动它**。
 *
 * @returns {void}
 */
function applySideCollapsed() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDE_KEY) === '1';
  } catch (_e) {
    /* 存储不可用：保持默认展开 */
  }
  paintSideCollapsed(collapsed);
}

/**
 * 功能：切换主导航的收起状态，并把它记进 localStorage。
 *
 * 说明：⚠️ **先画再存** —— 存储失败（隐私模式）也让这一下当场生效，只是下次打开回到默认；
 *      把 `setItem` 放前面的话，那种环境下点开关会「点了没反应」。
 *
 * @returns {void}
 */
function toggleSideCollapsed() {
  const app = $('#app');
  const collapsed = !(app && app.classList.contains('collapsed'));
  paintSideCollapsed(collapsed);
  try {
    localStorage.setItem(SIDE_KEY, collapsed ? '1' : '0');
  } catch (_e) {
    /* 存储不可用：这一下仍然生效 */
  }
}

// ---------- 启动 ----------
/**
 * 功能：首屏流程 —— 绑定事件、设好初始视图与日期、先渲染骨架屏，再发**一个**聚合请求
 *      `GET /api/bootstrap`，直接用它返回的数据渲染侧栏与首页看板。
 *
 * 说明：这里**刻意不走 `openHome()`**：后者会再拉一次 `/api/summary`，
 *      而 `loadBootstrap()` 刚给过同一份数据 —— 首屏为此白白多一个往返。
 *
 * @returns {Promise.<void>}
 */
export async function init() {
  // ⭐ 0.7.6：先把侧栏折叠态贴上（在任何渲染之前 —— 否则会先画一帧展开的侧栏再跳回收起）
  applySideCollapsed();
  bindEvents();
  bindQuickAddDefaults();
  state.view = 'home'; // 落点就是首页看板：先别渲染任务板，避免闪一下空板子
  state.weekStart = mondayOf(todayStr());
  state.selectedDate = todayStr();
  $('#home-body').innerHTML = skeletonHtml(3); // 首次加载先给骨架屏，别让用户面对一片空白
  await loadBootstrap(); // 一次拿到 health / me / projects / summary / 今日待办数
  // ⭐ 0.8.7：首屏也要按偏好落「默认视图」—— 用的是**刚到手**的那份看板载荷
  //    （`loadBootstrap()` 带 `dash=1` ⇒ `state.dash.data` 已经是新的了），与 `openHome()` 同一条口径。
  snapDashView();
  renderSidebar();
  showView('home');
  // ⚠️ `fresh: true`：看板数据是刚取回来的 ⇒ 若默认视图是日历，它也要取一次自己的数据
  renderHome({ fresh: true });
}

// ---------- 事件绑定 ----------
/** `resize` 重算时间轴的 debounce 句柄（见 `bindEvents` 里的 resize 监听） */
export let resizeTimer;

setNotifier(toast); // ⭐ 把本端的 toast 注册给 core/api.js（两端的提示是两套 DOM，不能合并）

// 保留一个可控的失败兜底：初始化挂了也要让用户看到原因
init().catch((e) => toast('初始化失败：' + e.message, true));
