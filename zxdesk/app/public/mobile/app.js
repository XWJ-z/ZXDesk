/**
 * mobile/app.js —— 手机版**入口**（浏览器原生 ESM，零构建）
 *
 * 功能：装配手机版的全部交互 —— `bindEvents()` 把点击 / 键盘 / 软键盘事件挂到统一处理函数上；
 * `onAction()` 是 `data-act` 指令表，课表、任务板、项目、任务详情、账号与成员管理等分支
 * 都从它派发；`switchTab()` / `render()` / `updateChrome()` 负责各标签页的切换、重绘与顶栏文案；
 * 起底部那几颗**模块标签**由清单生成（`renderModuleTabs()`）…
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { api, setNotifier } from '../core/api.js';
import { mountOfflineBanner } from '../core/cache.js';
// 「关于我们 / 联系与反馈」两份抽屉内容 —— 与电脑版弹窗共用同一份（`core/about.js`）
import { aboutBodyHtml, contactBodyHtml } from '../core/about.js';
import { addDays, fmtLong, mondayOf, todayStr, weekName } from '../core/date.js';
import { $, copyText, esc } from '../core/dom.js';
// 数据位置的横幅文案与「三行库」共用一份（`core/data-location.js`）
// 「没有对应的目录 → 跳转授权」的钩子（模块不能反向 import 本文件，所以由这里注册）
import { setGotoAuthHandler } from '../core/grants.js';
import { entryOn, moduleItems, navTabItems } from '../core/modules.js';
// 番茄钟：`clock` 只在 `switchTab()` 里用一次 —— 见那里的一段说明。
// 它进本文件的**唯一**理由就是「所有标签切换的唯一出口在这里」：番茄钟的 1 秒心跳
// 必须在这一个地方收掉，在各个模块自己的渲染函数里记「我走了」一定会漏。
import { clock } from '../core/clock.js';
// 自动草稿：宿主只负责三件事 —— 保存动作打标记、启动后把重载前的表单重开、离开前收尾
import {
  endSaving,
  flushDraft,
  markSaving,
  resumeInfo,
  runResume,
  setDraftNotice,
  setDraftOwner,
} from '../core/draft.js';
import { ttTicker } from '../core/timetable.js';
// 换标签改走**交叉淡入**（旧屏留到新屏就绪、两层一起淡），
// 并新增「进任务板 / 网址密码夹就把视图片段**预热**起来」。
// `core/slots.js` / `core/transition.js` 两条 import **不构成环**：前者只 import
import { openModuleSettings, warmSlots } from '../core/slots.js';
import { crossFade } from '../core/transition.js';
import { coerceScope, refresh, scopeMetaOf } from './data.js';
// **网址收藏夹与密码库不再有静态 import** —— 它们不再有自己的屏，
// 界面挂进新那一屏「网址/密码夹」（纯屏模块 `webpass`）的视图片段里。
// ⇒ 开屏走下面 `openWebpassView()` 的**动态** `import()`；两个模块的动作表与直连监听
import { HUB_VIEWS, uiOf } from './modules.js';
import { state } from './state.js';
import {
  askConfirm,
  closeSheet,
  consumeSheetPop,
  isSheetLocked,
  isSheetOpen,
  openSheet,
  runBackHandler,
  setChromePainter,
  toast,
} from './ui.js';
import { renderBoard } from '../modules/tasks/mobile-board.js';
// **随手记不再有静态 import** —— 它不再有自己的屏（并进「任务板」那一屏，
// 第一行药丸「任务 ｜ 随手记」），界面挂进那一屏的视图片段
// （`modules/idea/mobile-board-pane.js`，槽名 `board-pane`）。
import {
  pomoBindGo,
  pomoBindSheet,
  pomoBreak,
  pomoCustomGo,
  pomoCustomSave,
  pomoCustomSheet,
  pomoFinish,
  pomoImmersive,
  pomoPause,
  pomoSound,
  pomoStart,
} from '../modules/time/pomodoro-mobile.js';
// 日历：日历**不再有自己的屏**，它现在是「今天」里的第二个视图 ——
// 连累整页起不来，也违背「宿主不认识模块实现」），界面概览由 `views/today.js` 动态挂载。
// 记账：视图渲染 + 动作（加一个账户的两步弹层 / 改 / 删）。
import {
  lgBalance,
  lgBalanceSave,
  lgBack,
  lgBackLayer,
  lgBillTab,
  // 账单周档那颗「‹ 月份 ›」（周档的期间 = 某个月的各周）—— 换月 = 换期 ⇒ 重取。
  lgBillShift,
  // ：屏内药丸（列表 ｜ 图表）与图表那一族的动作。
  // 手机端动作表是**显式登记**的：漏一个键 = 那颗按钮「点了没反应」且**不报错**。
  lgBillTab2,
  lgBudgetAdd,
  lgBudgetClear,
  lgBudgetClearok,
  lgBudgetEdit,
  lgBudgetSet,
  lgBudgetTab,
  lgCatArc,
  lgCatArcGo,
  lgCatDel,
  lgCatDelGo,
  lgCatNew,
  // 收支分类里那颗 `▸ N` / `▾ N`（展开 / 折叠一个一级的子级）
  lgCatToggle,
  lgCatRen,
  lgCatRestore,
  lgCatRestoreGo,
  lgCatSave,
  lgCatSub,
  lgCatUnArc,
  lgChgAgain,
  lgChgMore,
  lgDel,
  // 【收支账户】那一页改成**按需新增 ＋ 全部当场生效**⇒
  // 新增这三颗：那一行的「✕」清掉某个类别的默认（`lg-defdel`）、底部「＋ 新增」开弹层
  // （`lg-defnew`）、弹层里那颗「保存」（`lg-defnewgo`）。
  lgDefDel,
  lgDefNew,
  lgDefNewGo,
  lgEdit,
  lgEntryAdd,
  lgEntryBack,
  lgEntryCancel,
  lgEntryCat,
  lgEntryClose,
  lgEntryDel,
  lgEntryEdit,
  lgEntryIe,
  lgEntryMore,
  lgEntryNote,
  lgEntryOpen,
  lgEntryRetry,
  lgEntrySave,
  lgAiHelp,
  lgEye,
  // 三方导入：设置屏那一块（导入 / 概况重试 / 整批清除）＋ 导入向导
  // （选文件 / 确认导入 / 取消）＋ 明细屏里点导入行的**只读**详情。
  lgGoCal,
  lgImpCancel,
  lgImpClear,
  lgImpClearok,
  lgImpGo,
  lgImpGoDetail,
  lgImpItem,
  lgImpOpen,
  lgImpRetry,
  lgMdBack,
  lgMdOpen,
  lgMonthOk,
  lgMonthPick,
  lgSortDone,
  lgMonthSel,
  lgNew,
  lgOpen,
  lgPick,
  lgRefund,
  lgRefundSave,
  lgChartDirPick,
  lgChartRetry,
  // ：设置第四页【导出数据】—— `lg-exp-what` 勾 / 取消勾一样
  // 「导什么」（只改 state 再重画）、`lg-exp-dl` 那颗导出按钮（先确认再逐个导航）。
  // 两颗**都要登记**；那两颗日期框（`lg-exp-from` / `lg-exp-to`）是原生 `<input type="date">`，
  lgExpDateOpen,
  lgExpDatePick,
  lgExpDownload,
  lgExpWhat,
  lgRetype,
  lgSave,
  lgSearch,
  lgSegPick,
  // 记账设置**二级菜单**（首页 → 子页）—— `lg-setgo` 进某一页、`lg-setback` 回首页。
  // 设置升成第三格之后就没了）；这两个是**设置那一格内部**的第二层。
  lgSetBack,
  lgSetGo,
  lgTransfer,
  lgTransferSave,
  loadLedger,
  // `openLedger` / `renderLedger` 两条静态 import **撤了** —— 记账不再有
  // 自己的一屏（它借「个人资产管理」那一屏的 `assets-pane` 槽），取数与重画都由视图片段
  // 在挂载时调 `mountLedger()`。⚠️ `loadLedger` **留着**：它还被首页那颗 ＋
  lgViewChip,
  lgViewDel,
  lgViewManage,
  lgViewName,
  lgViewSave,
  lgUsageDel,
  lgUsageName,
  lgUsageSave,
  lgRangePick,
  lgTabPick,
  lgTrendDot,
  bindAiProposalEdit as bindLedgerAiEdit,
} from '../modules/ledger/mobile.js';
// 行程：静态 import（同样是「更多」页的一档 = 主功能入口，不是低频弹层）
// 屏内交互（新建行程 / 加票 / 打卡 / 记录轨迹）、起登记进下面的 `ACTIONS` 表。
import { tripAction } from '../modules/time/trip-mobile.js';
// 数码管理：视图渲染 + 增删改与筛选。
// 目录随模块一起改成 `modules/digital/`（`git mv`）—— 表名 / 接口前缀仍是 `hardware`，
// 所以下面这些函数名（`loadHardware` / `hw-*` 动作键 / `#hw-*` 节点 id）**一个字不改**
import {
  hwBuySave,
  // ：三颗管理入口
  // （`hwManageSections` / `hwManageCats` / `hwManageTemplates`）并成**一颗** ⇒
  // 这里只留 `openHwManageSheet` 一个（动作键 hw-manage，标签页由 `data-id` 带）。
  openHwManageSheet,
  // 任务三（「分类和类别合并」＋「点击【改名】过后才能编辑」）：
  // 类别管理那一页里的那些动作 —— 展开 / 底部新建类别 / 行内「＋ 子分类」/ 行内改名。
  // 老的 `hwGroupCreate` / `hwGroupRename`（常驻输入框那套）**已撤**：底部现在只建类别、
  hwCatAdd,
  hwGroupDel,
  hwManageToggle,
  hwRenameDismiss,
  hwRenameEnd,
  hwRenameStart,
  hwSubAdd,
  hwSubSave,
  // 硬件模板那一套（「先选模板」＋ 管理弹层里那几条）
  hwNewHardware,
  // ：选项的加 / 删 ＋ 类型切换
  hwFieldKindSwitch,
  hwOptAdd,
  hwOptDel,
  // 任务五：内置那一行的「改选项」（展开 / 收起它下面那段选项编辑区）
  hwPresetEdit,
  hwTplCreate,
  hwTplDel,
  hwTplFieldAdd,
  hwTplFieldDel,
  hwTplFieldsOpen,
  hwTplFieldsSave,
  hwTplPick,
  // 任务六：`hwTplRename` 撤了 —— 模板那一行的改名并进了通用的 `hw-rename`
  // （行内编辑，收尾在 `mobile.js` 的 `hwRenameEnd()` 里按上下文分派）。
  hwBuySheet,
  hwCopyItem,
  hwDel,
  hwDetail,
  hwEditItem,
  hwForm,
  hwMergeInto,
  hwMergePick,
  hwMergeToggle,
  hwSave,
  hwSetCategory,
  hwSetSection,
  hwSetSort,
  hwSetStat,
  hwToggleSortDir,
  loadHardware,
  // `renderHardware` 这一条静态 import **撤了** —— 数码管理不再有自己的一屏
  // （它借「个人资产管理」那一屏的 `assets-pane` 槽），重画由视图片段挂载时调的
  // `mountHardware()` 走。⚠️ `loadHardware` **留着**：搜索框（`#hw-q`）的 input 委托还要它。
} from '../modules/digital/mobile.js';
// 对话：视图渲染 + 好友关系 + 实时通道开关。
// 它只做「画」与「取数」，**动作转派不在这里**：对话的动作较多（打开 / 返回 / 发消息 /
// 加好友 / 同意 / 拒绝 / 删除 / 拉黑 / 翻历史），照 `handleTtEditAct()` 的做法收在
import {
  TEAMWORK_EDGE_PX,
  bindTeamworkPlus,
  bindChatPickTask,
  bindTeamworkMessageHold,
  teamworkAddFriend,
  teamworkBackLayer,
  teamworkBoot,
  teamworkEnter,
  teamworkMore,
  teamworkSend,
  teamworkStatusText,
  closeSlotConv,
  handleTeamworkAct,
  renderTeamwork,
  stopTeamworkStream,
  updateTeamworkUnread,
} from '../modules/teamwork/mobile.js';

import {
  changeNameForm,
  changePwForm,
  doLogout,
  exportMine,
  exportOrgConfirmed,
  importCommit,
  importFlow,
  memberAddForm,
  memberRenameForm,
  memberResetForm,
  migrateGo,
  migrateLedgerFlow,
  navTabToggle,
  orgRestoreFlow,
  renderMore,
  renderSettings,
  restoreCommit,
  revealGrantSection,
  setNavChangedHandler,
  toggleSec,
} from './views/more.js';
// 项目屏删掉后，本文件只收着项目的**两个写入口**（新建 / 编辑 / 删除）——
// 它们的家在任务板顶部（`renderBoard()` 的下拉与 ✎ / 🗑 按钮），渲染函数已不存在。
import { delProject, projectForm } from '../modules/tasks/mobile-projects.js';
import {
  bindTaskCardActions,
  dailyForm,
  delTask,
  openTask,
  projectTaskForm,
  tickTask,
  toggleTask,
} from '../modules/tasks/mobile-tasks.js';
import {
  ttBlockRow,
  ttCommit,
  ttDayRuleDel,
  ttDayRuleSave,
  ttDayRuleSheet,
  ttGridSheet,
  ttImportSheet,
  ttNewSheet,
  ttPreviewAndShow,
  ttReadBlocks,
  ttReadPeriods,
  ttSessionSheet,
  ttSetSheet,
  ttSettingsSheet,
  ttTermSettingsSheet,
  ttTermSheet,
} from '../modules/time/timetable-mobile.js';
// 课表**编辑**（课程管理 / 课次表单 / 调课）单独一个模块，本文件只把动作转过去 ——
// 十几个分支摊在这个全局指令表里会把它撑爆（见该模块的文件头）
import { handleTtEditAct } from '../modules/time/timetable-mobile-edit.js';
// **课表 / 番茄钟 / 行程三块并成一个模块** `time`「番茄钟与日程表」——
// 这一屏的调度（四个 pane 的显隐 / 首页三颗按钮 / 三个子屏的「‹ 日程表」）全在 `home-mobile.js`。
// 三个接口前缀一个字没改（`/api/{timetable,pomodoro,trip}`），AI 的授权键也没动。
import { bindTimeEvents, renderTime, timePick } from '../modules/time/home-mobile.js';
import { startVaultWatch } from '../core/vault-watch.js';
import {
  applyDashViewDefault,
  dashGoToday,
  dashPickView,
  dashSetDay,
  dashSetFilter,
  dashSetPreset,
  dashTogglePanel,
  dashSetRange,
  dashShiftWeek,
  renderToday,
  setDashView,
  snapDashView,
} from './views/today.js';

/**
 * 功能：给页面上带 `data-autofill-guard` 的输入框解锁 —— 它们在 HTML 里是 `readonly`，
 * 用户要打字时才就地摘掉这个属性。
 *
 * 说明：⭐ 起因是「搜索框老是自动填入密码」（其实是 ZXDesk 的登录用户名），
 * 又报了一次「Edge 的『保存的密码』浮层照样弹」。
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
  document.addEventListener('keydown', unlock, true);
  document.addEventListener('touchstart', unlock, true);
  document.addEventListener('focusout', rearm, true);
}

/**
 * 功能：首页（「今天」）那颗悬浮 ＋ 弹出来的**三选一** —— 新建任务 / 记一笔 / 随手记一条。
 *
 * 新建任务、记账、随手记」。这三件事在首页是同一层的需求（都是「顺手记点什么」），
 * 而从前那颗 ＋ 只会开任务表单。
 * 用底部弹层而不是小气泡菜单：本端的「选一个」一律走 `openSheet()`（与选分类 / 选账户
 */
function openNewSheet() {
  openSheet(
    '新建',
    `<div class="nsheet">
       <button class="btn primary" type="button" data-act="new-task">🗂 新建任务</button>
       <button class="btn" type="button" data-act="new-ledger">💰 记一笔</button>
       <button class="btn" type="button" data-act="new-idea">💡 随手记一条</button>
     </div>`,
    '<button class="btn ghost" type="button" data-act="sheet-close">取消</button>',
  );
}

/**
 * 功能：从**别的屏**（首页那颗 ＋）直接开「记一笔」—— 记账数据没取过就先补一次。
 *
 * 说明：⚠️ 记账屏可能从来没打开过，这时 `state.lg` 还是 null，而 `lgEntryAdd()` 要拿
 * `state.lg.today` 预置「时间」那一格 ⇒ 少了这一步，弹层里那一格是**空的**
 * （不报错，只是用户得自己填日期 —— 而记账表单上「时间」是必填的）。
 */
async function openLedgerEntry() {
  if (!state.lg) await loadLedger();
  lgEntryAdd();
}

/**
 * 功能：从**别的屏**（首页那颗 ＋）直接开「记一条随手记」的底部弹层。
 *
 * 宿主不再静态认识它的实现（撤掉静态 import 才守得住「删掉 `modules/idea/` 时宿主页照旧」，
 * 动态 import 的路径必须是**字面量**：`ttt/test/frontend-modules.test.js` 的孤岛检查
 * 用正则扫 `import('…')`，写成变量它看不见 ⇒ 那个文件会被误判成「生了但从不执行」。
 */
async function newIdeaSheet() {
  try {
    const m = await import('../modules/idea/mobile.js');
    m.ideaNew();
  } catch (e) {
    toast('随手记打不开：' + e.message, true);
  }
}

/**
 * 功能：把手机版页面上的事件一次性挂到对应处理函数上 —— 应用区与底部弹层的点击、
 * 标签栏切换、刷新按钮、遮罩关闭弹层，以及悬浮按钮（按当前标签页决定新建什么）。
 * 另外监听键盘 Esc 关闭弹层，并在软键盘弹出时把聚焦的输入框滚回可见区域
 * （底部弹层里这一点尤其重要；开了「减弱动态效果」时改用瞬时定位）。
 * @returns {void}
 */
export function bindEvents() {
  // ：**「跳到另一个模块」的通用出口**。
  // 背景：要「明细顶部那三颗图标里，双圆环进 AI 助手、日历进日历模块」—— 而
  // ⇒ 定式：**模块只派事件、宿主负责真正切屏**（与 `core/slots.js` 那套留白事件同一精神）。
  document.addEventListener('zx:dash-default-view', (e) => {
    applyDashViewDefault(String((e && e.detail && e.detail.view) || ''));
  });

  // 「日历视图的这个任务截止 …… 点击任务要弹出详情」——
  // 日历模块只把「点了哪条任务」**派成留白事件**（`zx:open-task`，联动宪法 ② / ⑥），
  // 动作（开哪个弹层）由宿主在这里接。⚠️ 与首页看板那批任务行走**同一个出口**
  document.addEventListener('zx:open-task', (e) => {
    const d = (e && e.detail) || {};
    if (!d.task) return;
    // `w.scope` 必须跟着设：详情里的「编辑」按**当前作用域**拼接口地址 —— 少这一项会把
    // 任务存到别的项目里去，而且不报任何错（与 `dash-open` 那条注释同源）。
    state.scope = coerceScope(d.scope);
    // `name` / `icon` 取自历法图层带过来的那一条（手机端详情要画「<图标> <名字>」）。
    openTask({ t: d.task, scope: state.scope, name: d.name || '', icon: d.icon || '' });
  });

  document.addEventListener('zx:open-module', (e) => {
    const d = (e && e.detail) || {};
    const mod = String(d.mod || '');
    if (!mod) return;
    // `mod === 'home'` 是**首页看板自己的**一条 —— 打开「今天」并切到
    // 判据是「目标屏 = 看板」而**不是**某个模块名（看板不是模块）——
    // 别把它写成 `if (slot === 'calendar')`。
    if (mod === 'home') {
      snapDashView(); // 先按偏好落默认视图（与「进屏」同一条口径）
      switchTab('today');
      // 再按这一次的目标覆盖它 —— `setDashView()` 自己判「已经是它了」就什么都不做
      // （⛔ 这里不再抄一遍那段判据：两处各写一遍必然漂移，而表现是「白重画一次」）
      if (d.slot) setDashView(String(d.slot));
      return;
    }
    // `detail.slot` = 目标屏这一次要落到**哪个视图**（目前只有
    // 「网址/密码夹」用得上）—— 先记下来，`openWebpassView()` 那一趟会读它（用掉即清空）。
    if (d.slot) webpassWant = String(d.slot);
    // 落点改走 `gotoModule()` —— 生活记账 / 数码管理**不再有自己的屏**
    // （屏名已从视图清单里撤掉），直接 `switchTab(mod)` 会切到一个不存在的屏
    // （**整块内容不动、顶栏标题变 `undefined`**，且不报错）。`gotoModule()` 会把
    gotoModule(mod);
    if (d.slot) {
      document.dispatchEvent(new CustomEvent('zx:teamwork-slot-open', { detail: { key: String(d.slot) } }));
    }
  });
  unlockAutofillGuards();
  $('#app').addEventListener('click', onClick);
  $('#sheet').addEventListener('click', onClick);
  // 收藏夹搜索框（`#bm-q`）与分类下拉（`#bm-tags`）这两处监听**不在这里**了
  // —— 它们随收藏夹的骨架一起搬进了 `modules/bookmarks/mobile-webpass-pane.js`，
  // 挂在那张片段自己造的根节点上（宿主不再静态 import 收藏夹 ⇒ 这里拿不到它的函数）。
  let hwTimer = null;
  $('#app').addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'hw-q') return;
    state.hwQuery = e.target.value;
    clearTimeout(hwTimer);
    hwTimer = setTimeout(() => {
      loadHardware().catch((err) => toast(err.message, true));
    }, 250);
  });
  // 随手记的检索框（`#idea-q`）那处监听**不在这里**了 ——
  // 它随骨架搬进了 `modules/idea/mobile-board-pane.js`，挂在**片段自己造的根节点**上
  // （随手记借任务板那一屏的 `board-pane` 槽）。⛔ 别加回来：宿主这里是**全局委托**，
  $('#app').addEventListener('change', (e) => {
    if (!e.target) return;
    // 修订：任务板筛选条新增的「类别 / 状态」两个下拉 ——
    // 原生 `<select>` 只有 `change`、不冒泡 `click`，所以走这里（⛔ 别塞进动作表）。
    // 纯前端筛选：只改 state 再重画，**不重新取数**（与上面那三颗 chip 同一条口径）。
    if (e.target.id === 'tf-kind') {
      state.kindFilter = String(e.target.value || '');
      render();
      return;
    }
    if (e.target.id === 'tf-status') {
      state.statusFilter = String(e.target.value || '');
      render();
      return;
    }
    if (e.target.id === 'hw-cat') {
      hwSetCategory(e.target.value).catch((err) => toast(err.message, true));
      return;
    }
    // 任务八：「类别」从横滑药丸改成**一枚下拉**
    // （`#hw-sec-sel`）—— 原生 `<select>` 只有 `change`、不冒泡 `click`
    // （上面那张动作表接的是点击，够不到它）。语义与从前那颗药丸**同一件事**：
    if (e.target.id === 'hw-sec-sel') {
      hwSetSection(e.target.value).catch((err) => toast(err.message, true));
      return;
    }
    if (e.target.id === 'hw-sort') {
      hwSetSort(e.target.value).catch((err) => toast(err.message, true));
      return;
    }
    // ：「编辑专业参数」里那一行的**类型**下拉
    // （文本 / 下拉）—— 原生 `<select>` 只有 `change`、不冒泡 `click`，上面的动作委托接不到它。
    // 纯界面动作：只切这一张卡片里那两段的显隐，⛔ 不取数、⛔ 不重画（重画会清掉刚敲的字）。
    if (e.target.closest('[data-hw-field-kind]')) {
      hwFieldKindSwitch(e.target);
      return;
    }
    // 任务三（「点击【改名】过后才能编辑」）：**行内改名**那一格 —— 回车提交。
    // 提交只在这两处收口（`change` 与下面的 `blur` 捕获），实际动作在 `hwRenameEnd()` 里，
    // 它有 `done` 标记 ⇒ 回车之后紧跟的那次失焦不会重复提交。
    if (e.target.classList && e.target.classList.contains('hw-rename-input')) {
      hwRenameEnd(e.target, true);
      return;
    }
    // ：图表那颗**口径**下拉（支出 / 收入）—— 原生 `<select>` 走 `change`、
    // 不冒泡 `click`（上面那条动作委托接不到它）。⭐ 它**只重画、⛔ 不重取数**
    // （服务端 `/chart` 一次把两侧都给回来了）。
    if (e.target.id === 'lg-exp-from' || e.target.id === 'lg-exp-to') {
      lgExpDatePick(null, e.target);
      return;
    }
    // 首页看板（「今天」）的两个日期框 —— 与电脑版同一条规矩：半截输入不请求，
    // 顺序倒过来就自己换一下，不把 400 甩给用户
    if (e.target.id === 'dash-from' || e.target.id === 'dash-to') {
      dashSetRange($('#dash-from').value, $('#dash-to').value);
      return;
    }
    // 任务板顶部的【项目 ▾】（旧「项目」屏的 `pj-scope` 已随屏删除）——
    // 与电脑版 `#bd-scope` 同一套规矩：最后一项「＋ 新建项目…」是**动作**不是作用域，
    // 选中它先把下拉拨回当前项、再弹新建表单；其余选项就地换 `state.scope` 并重画。
    if (e.target.id === 'bd-scope') {
      const v = e.target.value;
      if (v === '__new__') {
        $('#bd-scope').value = String(state.scope);
        projectForm(null);
        return;
      }
      // `all`（汇总任务视图）**不是项目 id**，别交给 `coerceScope()` ——
      // 它会 `Number('all')` 得到 NaN，表现是「选了汇总、列表空了，且不报任何错」。
      state.scope = v === 'all' ? 'all' : coerceScope(v);
      render();
    }
  });
  // 对话：滚到消息区顶部附近就自动去拉更早的历史（`before` + `hasMore`）。
  // 这里用**事件委托**而不是给 `#teamwork-history` 单独绑：它虽然一直在静态骨架里，
  // 但整屏重画（`renderTeamwork()`）会换掉里面的行，委托写一次就够、也不怕将来换节点。
  $('#app').addEventListener(
    'scroll',
    (e) => {
      if (!e.target || e.target.id !== 'teamwork-history') return;
      if (e.target.scrollTop > TEAMWORK_EDGE_PX) return;
      if (state.tab !== 'teamwork') return;
      teamworkMore();
    },
    true, // 滚动事件不冒泡，必须在捕获阶段拿
  );
  // 对话：长按一条消息 → 「添加到任务 / 复制文本」（电脑版是右键，手机上是长按）。
  // 识别逻辑放在 `modules/teamwork/mobile.js` 的 `bindTeamworkMessageHold()` 里 —— 它要认 `[data-teamwork-msg]`
  // 并且按 id 回消息列表取正文，那些都是那一屏自己的事；这里只负责在启动时挂一次。
  bindTeamworkMessageHold();
  // 对话输入框左边那颗 ＋（文件框 / 任务列表点击 / 点图看大图）—— 同样只挂一次。
  // 任务列表在弹层里（`#sheet-body`），动作委托跟着挂在弹层自己身上，见那个函数说明。
  bindTeamworkPlus();
  // AI 确认卡上的「修改」—— 把那一笔预填进记账自己的「记一笔」弹层
  bindLedgerAiEdit();
  // 把「挑一条任务」借给 AI 会话（`zx:ai-pick-task` 留白事件）——
  // AI 那边要能像好友聊天一样从 ＋ 里挑任务发给它，但选择器只该有一份。
  bindChatPickTask();
  // 任务联动：对话里那张**任务卡片**上的「收进我的任务板」—— 同样只挂一次（留白事件）。
  // 它挂在 document 上、与对话模块无关：对话模块被删掉时这个监听器永远收不到事件，没有副作用。
  // 任务三（数码管理「行内改名」）：**失焦即提交** —— 用户「改完点别处」是常态。
  $('#app').addEventListener(
    'blur',
    (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('hw-rename-input')) {
        hwRenameEnd(e.target, true);
      }
    },
    true,
  );
  bindTaskCardActions();
  // 对话：两个回车各自直达 —— 消息框里回车是「发送」，加好友框里回车是「发申请」。
  // 手机软键盘的回车就是那个动作键，让它什么都不做会很像坏了（用户以为在等它反应）。
  // `Shift + Enter` 仍是换行（多行消息用得上，只对消息框有意义）。
  $('#app').addEventListener('keydown', (e) => {
    if (!e.target) return;
    // 任务三（数码管理「行内改名」）：那一格上的回车 = **提交**。
    // 不能只靠 `change` —— 它只在**值变了**时才来，原样回车也该退出编辑态（回到纯文本）。
    // `hwRenameEnd()` 有 `done` 标记 ⇒ 与随后那次失焦不会重复提交。
    if (e.target.classList && e.target.classList.contains('hw-rename-input')) {
      e.preventDefault();
      hwRenameEnd(e.target, true);
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.target.id === 'teamwork-input') {
      e.preventDefault();
      teamworkSend();
    } else if (e.target.id === 'teamwork-add-name') {
      e.preventDefault();
      teamworkAddFriend();
    }
  });
  // 密码库「设置主密码」那两个框的回车（`#vault-master` / `#vault-master2`）
  // 搬进了 `modules/vault/mobile-webpass-pane.js` —— 那两格住在**弹层**里（`#sheet` 是 `#app`
  // 的兄弟节点），所以搬过去那一边挂的是**全局**键盘监听（只挂一次）。
  $('#tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });
  // 返回口径：「返回是回到**上一级**页面，而不是**上一次**页面；
  // 今天为初始屏幕也就是顶级的，最后都返回到今天」。
  // ⇒ 这里**不再读地址栏 hash 落地**（那是"上一次访问的那一屏"），改成按**层级**依次问四层：
  window.addEventListener('popstate', () => {
    // ⓪ ⭐⭐ 第七轮：这一趟是不是**我们自己**为了关弹层而 `history.back()` 的？
    // （真浏览器实测：任务板上关掉弹层，人直接跳回了「今天」）。
    // 判断顺序必须在最前：这一趟到达时弹层已经被 `closeSheet()` 关掉了，
    if (consumeSheetPop()) return;
    // ① 弹层是浮层：吃掉这一次返回、界面停在原屏
    // 第七轮：弹层现在**自己占一条历史**（`openSheet()` 压、`closeSheet()` 退），
    // 所以这一趟 `popstate` 就是把那条记录弹掉的回执 —— 关的时候要带 `fromPop: true`，
    if (isSheetOpen()) {
      // 而是把刚被弹掉的那条记录补回去，弹层留在原地。不补的话栈里少一条，
      // 用户再按返回会直接退屏 → 协议还挂在那儿、底下已经换了屏。
      if (isSheetLocked()) {
        try {
          history.pushState({ zxSheet: 1 }, '', location.href);
        } catch (_e) {
          /* 宿主 webview 限制 history API 时忽略 —— 退化成「这一下没反应」，不会更糟 */
        }
        return;
      }
      closeSheet({ fromPop: true });
      return;
    }
    // ② 屏内二级屏：**只要还在子屏里就一直退**（行程表单 → 行程首页 → 日程表首页 这类）
    // 这里**不能**写成 `while(...)`：模块的「退一层」是异步重画的，同一个 tick 里连续问
    // 会读到还没更新的状态（同一个子屏退两次）。所以只退一层，剩下的交给下一次手势。
    if (backLayerOf(state.tab)) {
      refill();
      return;
    }
    // ③ 上一级
    const up = upOf(state.tab);
    if (up) {
      switchTab(up, { replace: true });
      return;
    }
    // ④ 顶级（今天）：栈里可能还留着几条（用户下沉过又跳回来）—— 一并退掉，
    // 退干净之后浏览器自己会离开应用，这里**不需要**（也不该）去调 `window.close()` 之类。
    try {
      history.back();
    } catch (_e) {
      /* 宿主 webview 限制 history API 时忽略 */
    }
  });
  $('#btn-refresh').addEventListener('click', () => refresh({ toast: '已刷新' }));
  $('#scrim').addEventListener('click', closeSheet);
  // 情境新建只剩任务一种（「项目」屏删了；项目的新建入口在任务板顶部下拉的
  // 「＋ 新建项目…」那一项，走下面的 `bd-scope` change 分支）。
  // 任务板的默认作用域是**汇总任务视图**（`state.scope` 初值 `'all'`），
  $('#fab').addEventListener('click', () => {
    // 「今天」那一屏的 ＋ 改成**三选一** ——
    // 「新建任务 / 记一笔 / 随手记一条」在首页是同一层的需求（都是「顺手记点什么」）。
    // 别的标签页**一个字不变**：任务板上那颗 ＋ 仍是「就地加一条任务」
    if (state.tab === 'today') return openNewSheet();
    // 真机修订（「手机端 切换到随手记 新建＋图标会往右侧闪跳一下」）：
    // 随手记那一档**不再自带一颗 ＋**。它原来长在视图片段里（`modules/idea/mobile-board-pane.js`），
    // 而片段根会播 `dash-swap-in`；**带 `transform` 的祖先会抢走绝对定位元素的包含块**
    if (state.tab === 'board' && state.boardTab) {
      import('../modules/idea/mobile.js').then((m) => m.ideaNew());
      return;
    }
    if (state.tab === 'board' && state.scope !== 'daily') projectTaskForm();
    else dailyForm();
  });
  // 软键盘弹出时把聚焦的输入框滚到可见区域（底部弹层里这一点尤其重要）
  // 原来的写法是「聚焦后 280ms 平滑滚到中间」，而用户改完字**紧接着**点「确定」时那一跳正好开始 ——
  // 手指落下的位置是按钮，事件却落在已经滚走的空白上（`.sheet-body` 里滚的是内容，
  let focusScrollTimer = null;
  const cancelFocusScroll = () => {
    if (focusScrollTimer) {
      clearTimeout(focusScrollTimer);
      focusScrollTimer = null;
    }
  };
  $('#sheet').addEventListener('pointerdown', cancelFocusScroll, true);
  $('#sheet').addEventListener('touchstart', cancelFocusScroll, true);
  $('#sheet').addEventListener('focusin', (e) => {
    if (!e.target.matches('input, textarea, select')) return;
    cancelFocusScroll();
    const target = e.target;
    focusScrollTimer = setTimeout(() => {
      focusScrollTimer = null;
      target.scrollIntoView({ block: 'center', behavior: RM ? 'auto' : 'smooth' });
    }, 280);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
}

/**
 * 功能：应用区与弹层的统一点击入口 —— 先看点到的是不是 `[data-chk]` 勾选框（是就地切换完成状态，
 * 两者都没命中就什么也不做。
 * @param {MouseEvent} e - 冒泡到容器上的点击事件，从它推出实际被点的节点
 * @returns {void}
 */
export function onClick(e) {
  // 任务三（数码管理「行内改名」）：点弹层里**别的地方** ⇒ 先把正在编辑的那一格收掉。
  // 必须排在**取动作之前** —— 同一批点击里，「先收掉编辑」是发生在「执行那个动作」之前的
  // （比如点同一行的「改名」：先提交上一次，再开新的一次）。
  hwRenameDismiss(e.target);
  const chk = e.target.closest('[data-chk]');
  if (chk) {
    e.preventDefault();
    e.stopPropagation();
    // 周期任务那一行的勾是**打卡「本期」**（`data-period` 就是本期的
    // 周期起点）⇒ 走打卡接口，⛔ 不是把整条任务标完成（它到周期结束日才自动算完成）。
    const period = chk.dataset.period || '';
    if (period) tickTask(coerceScope(chk.dataset.scope), Number(chk.dataset.chk), period);
    else toggleTask(coerceScope(chk.dataset.scope), Number(chk.dataset.chk));
    return;
  }
  const n = e.target.closest('[data-act]');
  if (!n) return;
  onAction(n.dataset.act, n);
}

/**
 *
 * 功能：键 = 触发节点的 `data-act`，值 = 处理函数。`onAction()` 只做「查表 + 调用」，
 * 找不到的键**什么都不做**（与改造前的 `default: break;` 逐字等价）。
 *
 * 为什么收成表：改造前它是一段 746 行 / 150 个 `case` 的 mega-switch —— 加一个模块要回到它里面
 */

/**
 * 功能：对话那 17 个动作整批转交（原 switch 的 fall-through 组）。
 */
const TEAMWORK_ACT = (act, n, _id) => {
  handleTeamworkAct(act, n);
};

/**
 * 功能：课表设置与时段块两个入口共用（原 switch 的 fall-through 组）。
 */
const TT_SETTINGS_SHEET = (_act, _n, _id) => {
  ttSettingsSheet();
};

/**
 * 功能：课表编辑那 12 个动作整批转交（原 switch 的 fall-through 组）。
 */
const TT_EDIT_ACT = (act, n, _id) => {
  handleTtEditAct(act, n);
};

/**
 * 功能：课表周次的「上一周 / 下一周」—— ⭐ **一个处理器管两个方向**（按 `act` 决定 ±1）。
 *
 * 说明：⚠️ 手机端的动作表是**显式登记**的，而且**值**也得对：`'tt-prev'` 曾经被写成
 * `() => {}`（空函数），于是点「‹」什么都不发生、**也不报错** —— 与漏登记
 * 全学期视图（`sch.week` 为空）时两颗按钮都**不该起作用**（此时没有「周」可翻）。
 */
const ttWeekStep = (act) => {
  const w = state.tt && state.tt.week;
  if (!w) return;
  state.ttWeek = Math.max(1, w + (act === 'tt-next' ? 1 : -1));
  state.ttLoaded = false;
  render();
};

/**
 * 功能：把「个人资产管理」那一屏的屏内动作**转交**给它自己（**动态 import**）。
 *
 * 「删掉 `public/modules/assets/`」连累**宿主页起不来**，而这一屏的动作函数
 * `data-act` 逐字一致，值都是它。
 * 手机端动作表是**显式登记**的：漏登记一个键 = 那颗按钮「点了没反应」且**不报错**
 */
const ASSETS_ACT = (act, n) => {
  import('../modules/assets/mobile.js')
    .then((m) => m.assetsAction(act, n))
    .catch((e) => toast(e.message, true));
};

/**
 * 功能：把**当前这一屏**滚到某个节点 —— 只写这一屏 `.view` 的 `scrollTop`。
 *
 * 底部露白」，加密信息与数据位置两处入口都能复现）。原来用的是
 * `el.scrollIntoView({ block: 'start' })`，两个问题都落在它身上：
 * ① `block: 'start'` 是把目标**顶到视口最上面**。授权卡本来就在这一屏靠下的位置，
 */
function scrollViewTo(el, pad) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const view = el.closest ? el.closest('.view') : null;
  if (!view || !view.clientHeight) return false; // 这一屏还没显示（量到的都是 0）—— 交给调用方重试
  const box = el.getBoundingClientRect();
  // 目标自己被收着 / 被筛掉时高度是 **0**，这时「滚过去」等于滚到它上面那个邻居
  if (!box.height) return false;
  const top = box.top - view.getBoundingClientRect().top + view.scrollTop - (pad === undefined ? 12 : pad);
  view.scrollTop = Math.max(0, top);
  return true;
}

/**
 * 功能：跳到「设置 → 账号设置 → 个人授权目录」并滚到那一块。
 *
 * 说明：⚠️ 手机端的设置是**一屏到底**（不分左右栏），所以只有切屏 ＋ 滚动两件事。
 * @returns {void}
 */
function gotoGrantPane() {
  switchTab('settings');
  /**
   * 功能：先让「账号设置」那一块**露出来**，再滚到它的开头。
   *
   * 说明：⭐⭐ 「跳转位置不对」的真因就在这里：手机端设置页的分块**默认收起**
   * （`isFolded('acct')` 缺省收起，见 `views/more.js`），收起时 `.sec.folded` 只留标题行
   * ⇒ 授权卡的高度是 **0**，滚过去就停在那一条线上，
   */
  const step = (retry) => {
    const el = revealGrantSection();
    if (!el) {
      if (retry > 0) setTimeout(() => step(retry - 1), 260);
      return;
    }
    // 看着像「整屏被顶起」；② 它本来就在这一屏靠下，滚到它顶对齐时 `.view` 已经到底，
    // 下面露出 `padding-bottom` 那片空白。滚到分块开头，授权目录就在下方一屏内，上下文也还在。
    // 静默放弃 ⇒ 界面停在屏首，用户看到的就是「跳到了数据存放」。
    if (scrollViewTo(el, 12)) return;
    if (retry > 0) setTimeout(() => step(retry - 1), 160);
  };
  setTimeout(() => step(8), 120);
}

// 加密信息面板里的「没有对应的目录」也走这里
setGotoAuthHandler(gotoGrantPane);

const ACTIONS = {
  // 键名与 `openNewSheet()` 里那三颗按钮的 `data-act` **逐字一致**（见那个函数的说明）。
  // 三条都**先关弹层再开下一层**：不关的话新表单会画在「新建」那个弹层底下（看着像没反应）。
  'new-task': () => {
    closeSheet();
    dailyForm();
  },
  'new-ledger': () => {
    closeSheet();
    openLedgerEntry();
  },
  'new-idea': () => {
    closeSheet();
    newIdeaSheet();
  },
  // `idea-*` 那 8 个动作键**整块撤了** —— 随手记不再是独立一屏，
  // 它的动作表随骨架搬进了视图片段 `modules/idea/mobile-board-pane.js`
  // （随手记借任务板那一屏的 `board-pane` 槽）。
  'trip-new': tripAction,
  'trip-back': tripAction,
  'trip-open': tripAction,
  'trip-add-ticket': tripAction,
  'trip-edit-ticket': tripAction,
  'trip-edit-trip': tripAction,
  'trip-pick-kind': tripAction,
  'trip-prefs': tripAction,
  // 主屏那颗「⋯ 更多」= 开一层底部弹层（提醒设置 / 人生日历都在里面）。
  'trip-more': tripAction,
  // 人生日历从日历屏整体搬来行程 —— 一颗按钮 → 弹层
  'trip-life': tripAction,
  'trip-life-save': tripAction,
  'trip-save-trip': tripAction,
  'trip-save-ticket': tripAction,
  'trip-save-prefs': tripAction,
  'trip-del-ticket': tripAction,
  'trip-del-trip': tripAction,
  // 漏登记任何一个 ⇒ 那颗按钮「点了没反应」且**不报错**（`ttt/test/trip.test.js` 有一条护栏逐个扫）。
  'trip-open-track': tripAction,
  'trip-checkin': tripAction,
  'trip-ci-gps': tripAction,
  'trip-ci-manual': tripAction,
  'trip-ci-save': tripAction,
  'trip-rec-start': tripAction,
  'trip-rec-stop': tripAction,
  'trip-rec-retry': tripAction,
  'trip-rename-point': tripAction,
  'trip-rename-save': tripAction,
  'trip-del-point': tripAction,
  'trip-clear-points': tripAction,
  // 键名与 `modules/pomodoro/mobile.js` 里各按钮的 `data-act` **逐字一致**：
  // 手机端动作表是**显式登记**的，键对不上就是「点了没反应」且**不报错**。
  // 「暂停 / 继续」与「完成 / 放弃」各共用一个处理函数（按 `act` 分辨方向）——
  'pomo-start': pomoStart,
  'pomo-pause': pomoPause,
  'pomo-resume': pomoPause,
  'pomo-finish': pomoFinish,
  'pomo-abandon': pomoFinish,
  'pomo-custom': pomoCustomSheet,
  'pomo-custom-go': pomoCustomGo,
  'pomo-custom-save': pomoCustomSave,
  'pomo-bind': pomoBindSheet,
  'pomo-bind-go': pomoBindGo,
  // 番茄工作法那三件 —— 开一次休息（读 `data-kind`）/ 切换提示音 / 沉浸视图开关。
  // 与 `modules/time/pomodoro-mobile.js` 的 `data-act` 逐字一致（漏了就是「点了没反应」）。
  'pomo-break': pomoBreak,
  'pomo-sound': pomoSound,
  'pomo-immersive': pomoImmersive,
  // 看板顶部那条「视图胶囊」（`列表视图 ｜ 日历视图`）——
  // 点一颗就切视图。⚠️ 判据与画法都在 `views/today.js`（那边只改 state 再重画，⛔ 不重新取数）。
  // 日历现在是**动态挂载**的视图，宿主不再静态 import 它，这张表也就拿不到它的函数了。
  'dash-view': dashPickView,
  // 键名与 `modules/ledger/mobile.js` 里各按钮的 `data-act` **逐字一致**：
  // 手机端动作表是**显式登记**的，键对不上就是「点了没反应」且**不报错**。
  // `lg-new` / `lg-retype` 都开「类型选择」弹层（前者从空开始、后者先把已填的值读回草稿）；
  'lg-new': lgNew,
  'lg-retype': lgRetype,
  'lg-pick': lgPick,
  'lg-open': lgOpen,
  'lg-back': lgBack,
  'lg-eye': lgEye,
  'lg-transfer': lgTransfer,
  'lg-xsave': lgTransferSave,
  'lg-balance': lgBalance,
  'lg-bsave': lgBalanceSave,
  'lg-chgagain': lgChgAgain,
  'lg-chgmore': lgChgMore,
  'lg-edit': lgEdit,
  'lg-save': lgSave,
  'lg-del': lgDel,
  // 分类视图（顶部胶囊 / 管理分类那一页）
  'lg-view': lgViewChip,
  'lg-viewmore': lgViewManage,
  'lg-viewnew': lgViewName,
  'lg-viewren': lgViewName,
  'lg-viewdel': lgViewDel,
  'lg-viewsave': lgViewSave,
  // 内置「按账户用途」那些**字段**的增删改名（入口在「管理分类」那一页）。
  // 与上面那四颗「分类」的动作分得干净：分类是「按什么看」，用途是那一列的取值。
  'lg-usagenew': lgUsageName,
  'lg-usageren': lgUsageName,
  'lg-usagedel': lgUsageDel,
  'lg-usagesave': lgUsageSave,
  // ：两颗**切换控件**（各自只改 state 再重画，⛔ 都不重新取数）。
  // 换年那颗不是按钮 —— 它是原生 `<select>`，走 `change`，住 `bindLedgerOnce()`。
  'lg-tab': lgTabPick,
  'lg-range': lgRangePick,
  // 点走势图上某一个点 ⇒ 显示那一格的钱（只改那一行文字，不重画整屏）。
  'lg-tdot': lgTrendDot,
  // 记账 2 期：**记账自己的底部导航** ——
  // 进记账这一屏宿主会把 `#tabbar` 收起来（见 `updateChrome()`），改用它：三段一段控件
  // `资产 ｜ 记账 ｜ 设置`（⛔ 没有「图表」，图表仍是资产那一段的第二视图 `lgTab`）。
  'lg-seg': lgSegPick,
  // ：流水那一屏 —— `lg-eadd` 记一笔、`lg-eretry` 没读到· 重试、`lg-emore` 游标往后一页。
  'lg-eadd': lgEntryAdd,
  'lg-eretry': lgEntryRetry,
  'lg-emore': lgEntryMore,
  // ：退款 —— `lg-refund` 从某一行的「记退款」进（预填还能退多少）、`lg-rfsave` 是提交。
  'lg-refund': lgRefund,
  'lg-rfsave': lgRefundSave,
  // 补：**条目详情 ＋ 改一笔 ＋ 删一笔** ——
  // `lg-erow` 是点流水**整行**（行本身挂的 `data-act`；⚠️ 行里那颗「记退款」离点击处更近，
  // 委托的 `closest()` 先命中它 ⇒ 点退款不会顺带进详情，⛔ 没有第二套 stopPropagation）；
  'lg-erow': lgEntryOpen,
  'lg-eclose': lgEntryClose,
  'lg-eedit': lgEntryEdit,
  'lg-edel': lgEntryDel,
  // 补：**【收支分类】**那一栏（长在「记账设置」那一屏里）——
  // 建一级 / 建二级 / 改名 / 归档，四件事各一个键；归档时"有子分类"那条路多一个二选一的键。
  // `lg-catsave` 是「新建一级 / 新建二级 / 改名」**共用**的保存（形状由 `catAsk.mode` 分三条路发）。
  'lg-catnew': lgCatNew,
  // ：展开 / 折叠一个一级分类的子级。
  // 手机端动作表是**显式登记**的：漏一条＝那颗按钮「点了没反应」且**不报错**。
  'lg-cattoggle': lgCatToggle,
  'lg-catsub': lgCatSub,
  'lg-catren': lgCatRen,
  'lg-catsave': lgCatSave,
  'lg-catarc': lgCatArc,
  'lg-catarcgo': lgCatArcGo,
  'lg-catrestore': lgCatRestore,
  'lg-catrestorego': lgCatRestoreGo,
  // 自定义分类的**真删除**（`lg-catdel` 开确认层、
  // `lg-catdelgo` 是确认层里那颗「永久删除」）与**取消归档**（`lg-catunarc` ＝「恢复」）。
  // 三个键都要登记，漏一个＝那颗按钮「点了没反应」且**不报错**。
  'lg-catdel': lgCatDel,
  'lg-catdelgo': lgCatDelGo,
  'lg-catunarc': lgCatUnArc,
  // ：记一笔那张上滑弹层 —— 支出｜收入、分类网格（一级 → 二级）、分候选（本地 `matchNote` 过滤）、
  // 返回上一级 / 取消 / 完成。⚠️ 备注候选的**来源只有一个**：`GET /api/ledger/notes?category=`（见 mobile.js）。
  'lg-edie': lgEntryIe,
  'lg-edcat': lgEntryCat,
  'lg-edback': lgEntryBack,
  'lg-edcancel': lgEntryCancel,
  'lg-ednote': lgEntryNote,
  'lg-edsave': lgEntrySave,
  // ：记账设置 —— 它现在是**记账底部导航的一格**（`lg-seg` + `data-seg="set"`），
  // 不再是「记账屏顶部那颗 `⋯`」进的二级屏 ⇒ 那两个键（`lg-setopen` / `lg-setback`）已撤。
  // 这一格内部又分了**二级菜单**（设置首页 → 子页）⇒ 多出 `lg-setgo`（进某一页）
  'lg-setgo': lgSetGo,
  'lg-setback': lgSetBack,
  // ：设置第四页【导出数据】的两颗键 —— `lg-exp-what` 是那三个
  // 复选框（勾 / 取消勾，⛔ 不发请求）、`lg-exp-dl` 是那颗「下载 CSV」（先弹确认 → 再导航）。
  // 手机端动作表是**显式登记**的 —— 漏登记一个键 = 那颗按钮「点了没反应」且**不报错**
  'lg-exp-what': lgExpWhat,
  'lg-exp-dl': lgExpDownload,
  // 点那颗日期行 ⇒ 主动开系统日期选择器（`showPicker()`）
  'lg-exp-date': lgExpDateOpen,
  // 设置子页【收支账户】改成**按需新增 ＋ 全部当场生效** ——
  // `lg-defnew` 是底部那颗「＋ 新增」（开「给类别设默认账户」弹层）、`lg-defnewgo` 是弹层里的
  // 「保存」、`lg-defdel` 是某一行尾那枚「✕」（清掉那个类别的默认 ⇒ 回落全局默认）。
  'lg-defnew': lgDefNew,
  'lg-defnewgo': lgDefNewGo,
  'lg-defdel': lgDefDel,
  // 记账 3 期：**明细屏 ＋ 账单屏 ＋ 月详情页 ＋ 预算屏** ——
  // `lg-soon` 是明细屏顶上那三颗占位图标（AI 圆环 / 放大镜 / 日历）共用的键：点击**只弹一句话、
  // 一个请求都不发**（记账是**零出网**模块）；`lg-month-pick` /
  'lg-ai-help': lgAiHelp,
  'lg-go-cal': lgGoCal,
  // **搜索**那颗 ⇒ 打开「搜索流水」的底部弹层（真搜索，合并流里找）
  'lg-search': lgSearch,
  'lg-month-pick': lgMonthPick,
  'lg-month-sel': lgMonthSel,
  'lg-month-ok': lgMonthOk,
  // 手机端资产「排序模式」的出口（长按进模式 → 拖柄排序 → 点这颗「完成」退出）。
  'lg-sortdone': lgSortDone,
  'lg-bill-tab': lgBillTab,
  // （那是换**档**，这是换**哪一期的月**）。⚠️ 漏登记 = 那颗按钮「点了没反应」且**不报错**。
  'lg-bill-shift': lgBillShift,
  // ：屏内那颗药丸（`列表 ｜ 图表`）—— ⭐ **只在「账单」那一屏有**
  // （明细那一屏那颗已撤，见 `detailScreenHtml()` 的说明）。
  // 与上面那颗「周 / 月 / 年」的 `lg-bill-tab` 不是一回事（那是期间档，这是视图档）。
  'lg-btab2': lgBillTab2,
  // 图表的期间档 / 期间选择 / 「读不到 ⇒ 重新加载」
  // ：口径从
  // 原生 `<select>`（走 `change`、**不在这张表里**）换成**两颗按键** ⇒ **必须登记到这张表**
  'lg-chart-dir': lgChartDirPick,
  'lg-chart-retry': lgChartRetry,
  'lg-md-open': lgMdOpen,
  'lg-md-back': lgMdBack,
  'lg-budget-tab': lgBudgetTab,
  'lg-budget-edit': lgBudgetEdit,
  'lg-budget-set': lgBudgetSet,
  'lg-budget-add': lgBudgetAdd,
  'lg-budget-clear': lgBudgetClear,
  'lg-budget-clearok': lgBudgetClearok,
  // 三方导入—— 设置屏那一块 ＋ 导入向导 ＋ 明细屏的只读详情。
  // 手机端动作表是**显式登记**的：漏登记一个键 = 那颗按钮「点了没反应」且**不报错**
  // （`ttt/test/ledger.test.js` 有一条护栏扫 `data-act`，漏了会红）。
  'lg-imp-open': lgImpOpen,
  'lg-imp-go': lgImpGo,
  'lg-imp-cancel': lgImpCancel,
  'lg-imp-item': lgImpItem,
  'lg-imp-clear': lgImpClear,
  'lg-imp-clearok': lgImpClearok,
  'lg-imp-retry': lgImpRetry,
  'lg-imp-godetail': lgImpGoDetail,
  // `lg-refresh` 是记账自己那条「读取失败」的出路（重取 `/api/ledger/overview`）。
  // 不能拿共用的 `refresh`（`data.js` 那个）：它重取的是 bootstrap / 任务 / 项目，
  // **不会**重新取记账这一屏 ⇒ 点了没反应。
  'lg-refresh': () => loadLedger(),
  // 动作名**不按模块分**（`bm-open` / `teamwork-tab` / `hw-open` / `vault-open` 四个已合并成这一个）：
  // 看板那两张卡是**同一份判据**（⛔ 两处各写一遍必然漂移，而失效方式是「点了没反应」）。
  'mod-open': (_act, n, _id) => {
    if (n.dataset.mod) gotoModule(n.dataset.mod);
  },
  // 这一屏是**动态 import**（与 `webpass` 同一条纪律）⇒ 每个键都转给 `ASSETS_ACT`，
  // 由它 import 回来再调 `assetsAction(act, n)`（见上面那个转发器的说明）。
  // 键名与 `modules/assets/mobile.js` 里各按钮的 `data-act` **逐字一致**：
  'as-pick': ASSETS_ACT,
  'as-retry': ASSETS_ACT,
  'hw-new': (_act, _n, _id) => {
    // ：改成**先选模板**
    // —— 与电脑端 `newHardware()` 同一套口径（手机端是底部弹层）。
    hwNewHardware();
  },
  'hw-edit': (_act, _n, id) => {
    const h = (state.hwItems || []).find((x) => x.id === id());
    if (h) hwForm(h);
  },
  'hw-del': (_act, _n, id) => {
    hwDel(id());
  },
  'hw-save': (_act, n, _id) => {
    hwSave(n.dataset.id || '');
  },
  'hw-status': (_act, n, _id) => {
    // 概览行的每一段共用这一个分支：`data-stat` 空串 = 全部，`alert` = 只看需关注
    hwSetStat(n.dataset.stat).catch((e) => toast(e.message, true));
  },
  'hw-sort-dir': (_act, _n, _id) => {
    // 升 / 降序（「按 … 字段升序和降序排列」）——
    // 排序键由 `#hw-sort` 那个下拉的 change 事件改，这里是它旁边的方向按钮
    hwToggleSortDir().catch((e) => toast(e.message, true));
  },

  // 键名与 `modules/digital/mobile.js` 里各按钮的 `data-act` **逐字一致**：
  // 对不上就是「点了没反应」且**不报错**（这张表是唯一入口）。
  'hw-sec': (_act, _n, id) => {
    hwSetSection(id()).catch((e) => toast(e.message, true));
  },
  // ：三颗管理入口收成**一颗**，
  // 弹层里那几颗标签页（`data-id` = catman / tpl）也走**同一个键** ——
  // 药丸行那颗没有 `data-id` ⇒ 不传 = 留在原来那一页（默认「类别管理」）。
  'hw-manage': (_act, n, _id) => {
    openHwManageSheet(n.dataset.id);
  },
  // 任务三（「分类和类别合并」＋「点击【改名】过后才能编辑」）：
  // 原先那三颗键（`hw-group-rename` / `hw-group-create` ＋ 底部的类别下拉）**全撤**，换成：
  // `hw-mtoggle`   类别行那颗箭头（开合它下面的分类，纯界面）
  'hw-mtoggle': (_act, _n, id) => {
    hwManageToggle(id());
  },
  'hw-cat-add': (_act, _n, _id) => {
    hwCatAdd().catch((e) => toast(e.message, true));
  },
  'hw-sub-add': (_act, _n, id) => {
    hwSubAdd(id());
  },
  'hw-sub-save': (_act, _n, id) => {
    hwSubSave(id()).catch((e) => toast(e.message, true));
  },
  'hw-rename': (_act, n, _id) => {
    hwRenameStart(n);
  },
  'hw-group-del': (_act, _n, id) => {
    hwGroupDel(id()).catch((e) => toast(e.message, true));
  },
  // 硬件模板 —— 「先选模板」那一屏 ＋ 管理弹层里那几条。
  // 键名与 `modules/digital/mobile.js` 里各按钮的动作属性**逐字一致**。
  'hw-tpl-pick': (_act, _n, id) => {
    hwTplPick(id());
  },
  'hw-tpl-create': (_act, _n, _id) => {
    hwTplCreate();
  },
  // 任务六：`hw-tpl-rename` 撤了（并进通用的 `hw-rename`）—— ⛔ 别再加回来：
  // 两套改名逻辑迟早漂移，而失效方式是「点了没反应」。
  'hw-tpl-del': (_act, _n, id) => {
    hwTplDel(id()).catch((e) => toast(e.message, true));
  },
  'hw-tpl-fields': (_act, _n, id) => {
    hwTplFieldsOpen(id());
  },
  'hw-tpl-field-add': (_act, _n, _id) => {
    hwTplFieldAdd();
  },
  'hw-tpl-field-del': (_act, n, _id) => {
    // **按元素往上找那一张卡片**（`closest`），⛔ 不再用 `data-id` ——
    // 未保存的新卡片 key 都是空串，按 key 找必然删错先建的那一张。
    hwTplFieldDel(n);
  },
  // 自定义属性那一张卡片里的「＋ 加选项」与选项药丸上的「×」——
  // 与上面同一条口径：按元素往上找卡片 / 找那一颗药丸。
  'hw-opt-add': (_act, n, _id) => {
    hwOptAdd(n);
  },
  'hw-opt-del': (_act, n, _id) => {
    hwOptDel(n);
  },
  // 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的」）：
  // 内置那一行的「改选项」—— 就地展开 / 收起它下面那段选项编辑区（纯界面动作）。
  'hw-preset-edit': (_act, n, _id) => {
    hwPresetEdit(n);
  },
  'hw-tpl-fields-save': (_act, _n, id) => {
    hwTplFieldsSave(id()).catch((e) => toast(e.message, true));
  },
  // 合并模式那三条（开关 / 勾选 / 并到这里）—— 与药丸上的 `data-act` 逐字一致
  'hw-merge': (_act, _n, _id) => {
    hwMergeToggle();
  },
  'hw-pick': (_act, _n, id) => {
    hwMergePick(id());
  },
  'hw-into': (_act, _n, id) => {
    hwMergeInto(id()).catch((e) => toast(e.message, true));
  },

  // 行的 `data-act` 是 `hw-detail`（整行可点），里面的按钮各带自己的 `data-act`；
  // `onAction` 派发的是**最里面那个**带 `data-act` 的祖先，所以两者不会互相吃掉。
  'hw-detail': (_act, _n, id) => {
    hwDetail(id());
  },
  'hw-detail-edit': (_act, _n, id) => {
    hwEditItem(id());
  },
  'hw-detail-del': (_act, _n, id) => {
    closeSheet();
    hwDel(id());
  },
  'hw-buy': (_act, _n, id) => {
    hwBuySheet(id());
  },
  'hw-buy-save': (_act, _n, id) => {
    hwBuySave(id());
  },
  'hw-copy': (_act, _n, id) => {
    hwCopyItem(id());
  },

  // 这一组照 `tt-c-*` / `tt-s-*` 的做法整批转给 `handleTeamworkAct()`：
  // 对话的动作有十几个（打开 / 返回 / 发送 / 加好友 / 同意 / 拒绝 / 删除 / 拉黑 / 翻历史），
  // 摊在这张表里会把它撑爆，而它们几乎只依赖 `modules/teamwork/mobile.js` 自己的状态。
  'teamwork-open': TEAMWORK_ACT,
  'teamwork-back': TEAMWORK_ACT,
  'teamwork-more': TEAMWORK_ACT,
  'teamwork-send': TEAMWORK_ACT,
  // 输入框左边那颗 ＋ 与它的三项（发图片 / 协作项目任务 / 普通任务）
  'teamwork-plus': TEAMWORK_ACT,
  // 起**没有** `teamwork-send-image`：发图片走 `<label for="teamwork-img-file">`
  // 的原生行为（JS `click()` 在真机 WebView 上不弹选择器），不是动作表。
  'teamwork-send-collab': TEAMWORK_ACT,
  'teamwork-send-daily': TEAMWORK_ACT,
  'teamwork-add-friend': TEAMWORK_ACT,
  'teamwork-accept': TEAMWORK_ACT,
  'teamwork-reject': TEAMWORK_ACT,
  'teamwork-del': TEAMWORK_ACT,
  'teamwork-del-go': TEAMWORK_ACT,
  'teamwork-block': TEAMWORK_ACT,
  'teamwork-unblock': TEAMWORK_ACT,
  'teamwork-peer-manage': TEAMWORK_ACT,
  'teamwork-retry': TEAMWORK_ACT,
  'teamwork-msg-task': TEAMWORK_ACT,
  'teamwork-msg-copy': TEAMWORK_ACT,
  'teamwork-remark': TEAMWORK_ACT,
  'teamwork-remark-save': TEAMWORK_ACT,
  // 0.6.x 对话 2 期：内置角色（提醒助手）与**对话自己的设置**
  // 这张表是**显式登记**的（不是按前缀匹配）：漏一个键的表现不是报错，而是
  // 三个新键的真实落点分别是 `openTeamworkConv()` / `openTeamworkSettingsPanel()` / `sendTestReminder()`，
  'teamwork-open-conv': TEAMWORK_ACT,
  'teamwork-settings': TEAMWORK_ACT,
  'teamwork-reminder-test': TEAMWORK_ACT,
  // 0.6.x：插槽会话条目（AI 助手这类「会话对象」）—— 处理在 handleTeamworkAct() 的 openSlotConv()
  'teamwork-slot-open': TEAMWORK_ACT,
  // 好友 / 申请从列表页的内联区改成**两颗按钮 + 底部弹层**，另加一颗「拉黑」。
  // 拉黑单独开键（`teamwork-block-go`）的理由：对话页「⋯」里那颗 `teamwork-block` 的语义要看
  // `state.teamworkBuddy.blocked`（同一颗按钮兼顾「拉黑 / 取消拉黑」），而好友弹层里这一颗**永远**
  'teamwork-friends-open': TEAMWORK_ACT,
  'teamwork-req-open': TEAMWORK_ACT,
  'teamwork-block-go': TEAMWORK_ACT,

  // ---- 课表----
  'tt-day': (_act, n, _id) => {
    state.ttDay = Number(n.dataset.wd);
    render();
  },
  // 上下周**共用同一个处理器**（它内部按 `act` 决定 ±1）。老代码把 'tt-prev' 登记成
  // `() => {}` 空函数 —— 于是点「‹」什么都不发生、**也不报错**（动作表是显式登记的，
  'tt-prev': ttWeekStep,
  'tt-next': ttWeekStep,
  'tt-all': (_act, _n, _id) => {
    state.ttWeek = null;
    state.ttLoaded = false;
    render();
  },
  'tt-this': (_act, _n, _id) => {
    const w = state.tt && state.tt.today && state.tt.today.week_no;
    if (!w) {
      toast('这个学期没设「第 1 周星期一」，定位不到本周', true);
      return;
    }
    state.ttWeek = w;
    state.ttDay = state.tt.today.weekday;
    state.ttLoaded = false;
    render();
  },
  'tt-grid': (_act, _n, _id) => {
    ttGridSheet();
  },
  'tt-session': (_act, n, _id) => {
    ttSessionSheet(n.dataset.id);
  },
  'tt-session-save': (_act, n, id) => {
    const courseRemark = ($('#tt-c-remark') || {}).value || '';
    const before = (state.tt.cells.find((x) => x.session_id === id()) || {}).course_remark || '';
    // 本节备注是**第三条资源**（身份 = `(课次, 日期)`）——
    // 与课程备注同理，只有真的改了才多打一次接口。
    // 别再把它塞回下面那个 PUT 的 `remark` 里（那是旧的「每周重复」语义）。
    const dnDate = String(n.dataset.date || '');
    const dnNote = ($('#tt-dn-note') || {}).value || '';
    const dnBefore =
      ((state.tt.day_notes || []).find((x) => Number(x.session_id) === id() && String(x.date) === dnDate) || {}).note ||
      '';
    api('PUT', `/api/timetable/courses/${n.dataset.course}/sessions/${id()}`, {
      room: ($('#tt-s-room') || {}).value || '',
      teacher: ($('#tt-s-teacher') || {}).value || '',
      weeks: ($('#tt-s-weeks') || {}).value || '',
    })
      .then(async () => {
        // 课程备注挂在**课程**上，是另一条资源 —— 只有真的改了才多打一次接口
        if (courseRemark !== before) {
          await api('PUT', `/api/timetable/courses/${n.dataset.course}`, { remark: courseRemark });
        }
        // 本节备注与「日常任务」是**同一个东西的两个视图**（绑定在 `store.setDayNote()` 里做）。
        // 有两处**先问一句**（的口径是「询问」，不替他决定）：
        // ① 备注被**清空**、而它原来绑着任务 ⇒ 那条任务一起删还是留着；
        let savedNote = null;
        // 顺序：
        // 手机端的**课次详情**与**任务表单**共用**同一个**底部弹层容器 `#sheet`
        // —— `mobile/ui.js` 的 `openSheet()` 写 `#sheet-title/body/foot` 并加 `.on`，
        closeSheet();
        state.ttLoaded = false;
        render();
        if (dnDate && dnNote.trim() !== dnBefore) {
          const bound = (state.tt.day_notes || []).find(
            (x) => Number(x.session_id) === id() && String(x.date) === dnDate && Number(x.task_id),
          );
          if (!dnNote.trim() && bound) {
            const yes = await askConfirm({
              title: '这条备注还绑着一条日常任务',
              text: '清空备注会把它一起删掉。想留着它的话点「取消」（这次不清空），先去任务板处理那条任务。',
              ok: '一起删掉',
              danger: true,
            });
            if (!yes) {
              closeSheet();
              return;
            }
            savedNote = await api('PUT', `/api/timetable/terms/${state.tt.term.id}/day-notes`, {
              session_id: id(),
              date: dnDate,
              note: '',
              drop_task: true,
            });
          } else {
            // 先把备注存下来（`with_task: false`，建不建任务由下面那句询问决定）
            savedNote = await api('PUT', `/api/timetable/terms/${state.tt.term.id}/day-notes`, {
              session_id: id(),
              date: dnDate,
              note: dnNote,
              with_task: false,
            });
            // 新填的备注、原来没有绑任务 → **开一张预填好的任务表单**（校准的口径：
            // 「弹任务设置、预填充好备注内容」；而且**表单点了保存才建任务**）。
            // 走**留白事件**：课表不认识任务板、任务板也不认识课表 ——
            if (dnNote.trim() && !bound) {
              const cell = state.tt.cells.find((x) => x.session_id === id()) || {};
              document.dispatchEvent(
                new CustomEvent('zx:task-draft', {
                  detail: {
                    title: dnNote.trim(),
                    description: `来自课表：${cell.name || ''} 第 ${cell.period_start}${
                      Number(cell.period_end) !== Number(cell.period_start) ? '–' + cell.period_end : ''
                    } 节（${dnDate}）`,
                    start_date: dnDate,
                    due_date: dnDate,
                    from_day_note: { term_id: state.tt.term.id, session_id: id(), date: dnDate },
                  },
                }),
              );
            }
          }
        }
        // `closeSheet()` / `state.ttLoaded = false` / `render()` 已**上移**到这段之前 ——
        // 顺序原因见上面那段说明（不先关掉课次详情，新开的任务表单会被这一句关掉）。
        // 响应里 `task_id` 有值 = 真绑上了任务（任务板模块不在 / 被关掉时它是 0）—— 提示照着它说
        toast(savedNote && savedNote.note && Number(savedNote.note.task_id) ? '已保存，并同步到日常任务' : '已保存');
      })
      .catch((e) => toast(e.message, true));
  },
  'tt-session-del': (_act, n, id) => {
    askConfirm({ title: '删除这条课次？', text: '删掉之后可以重新导入。', ok: '删除' }).then((yes) => {
      if (!yes) return;
      api('DELETE', `/api/timetable/courses/${n.dataset.course}/sessions/${id()}`)
        .then(() => {
          closeSheet();
          state.ttLoaded = false;
          render();
          toast('已删除这条课次');
        })
        .catch((e) => toast(e.message, true));
    });
  },
  'tt-settings': TT_SETTINGS_SHEET,
  'tt-set-blocks': TT_SETTINGS_SHEET,

  // 第二版：课表底部两颗按钮 → 两个底部菜单（手机上没有下拉，弹层就是菜单）
  'tt-new': (_act, _n, _id) => {
    ttNewSheet();
  },
  'tt-set': (_act, _n, _id) => {
    ttSetSheet();
  },
  'tt-set-term': (_act, _n, _id) => {
    ttTermSettingsSheet();
  },
  // 假期调休（按天）：入口 / 保存 / 撤销。
  // 手机端动作表是**显式登记**：模块里 `data-act` 写了什么，这里就必须有**同名键**；
  // 键对但值是空函数同样静默丢弃（见 AGENTS.md 的「错了不报错」清单）。
  'tt-dayrules': (_act, _n, _id) => {
    ttDayRuleSheet();
  },
  'tt-dr-save': (_act, _n, _id) => {
    ttDayRuleSave();
  },
  'tt-dr-del': (_act, n, _id) => {
    ttDayRuleDel(Number(n.dataset.id));
  },
  'tt-new-course': (_act, n, _id) => {
    handleTtEditAct('tt-c-add', n);
  },
  'tt-term-edit': (_act, n, _id) => {
    const t = (state.ttTerms || []).find((x) => Number(x.id) === Number(n.dataset.id));
    if (t) ttTermSheet(t);
  },
  'tt-term-del': (_act, n, _id) => {
    const tid = Number(n.dataset.id);
    const t = (state.ttTerms || []).find((x) => Number(x.id) === tid);
    if (!t) return;
    // 级联删除（课程 / 课次 / 时段块 / 逐节时间一起走）—— 先把这件事说清楚再动手
    askConfirm({
      title: '删除学期',
      text: `要删除「${t.name}」吗？这个学期的课程、课次、时段块与逐节时间会一起删掉，删了没法撤销。`,
      ok: '删除这个学期',
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      api('DELETE', `/api/timetable/terms/${tid}`)
        .then(async () => {
          closeSheet();
          state.ttTermId = null;
          state.ttWeek = null;
          state.ttWeekInit = false;
          state.ttDay = null;
          state.ttLoaded = false;
          await refresh();
          toast('学期已删除');
        })
        .catch((e) => toast(e.message, true));
    });
  },

  'tt-courses': TT_EDIT_ACT,
  'tt-c-add': TT_EDIT_ACT,
  'tt-c-edit': TT_EDIT_ACT,
  'tt-c-del': TT_EDIT_ACT,
  'tt-c-save': TT_EDIT_ACT,
  'tt-color': TT_EDIT_ACT,
  'tt-s-add': TT_EDIT_ACT,
  'tt-s-edit': TT_EDIT_ACT,
  'tt-sess-save': TT_EDIT_ACT,
  'tt-adj': TT_EDIT_ACT,
  'tt-adj-save': TT_EDIT_ACT,
  'tt-adj-undo': TT_EDIT_ACT,
  'tt-blk-del': (_act, n, _id) => {
    // 删掉这一行时段块；删到一行不剩也没关系（保存后 = 这个学期没有作息，与电脑版一致）
    const row = n.closest('.tt-brow');
    if (row) row.remove();
  },
  'tt-blk-add': (_act, _n, _id) => {
    const box = $('.tt-blk-rows');
    if (box) box.insertAdjacentHTML('beforeend', ttBlockRow(null));
  },
  'tt-blocks-apply': (_act, _n, _id) => {
    // 「按块重排」是**破坏性**操作（覆盖逐节微调），先弹一个确认弹层；确认后由下面那条执行
    openSheet(
      '按块重排逐节时间？',
      '<div class="m-tip warn">⚠️ 会按上面的时段块重排逐节时间，你手工改过的节次时间会被覆盖。课程与课次不受影响。</div>',
      '<button class="btn danger" data-act="tt-blocks-apply-yes">确认重排</button>' +
        '<button class="btn ghost" data-act="tt-settings">返回</button>',
    );
  },
  'tt-blocks-apply-yes': (_act, _n, _id) => {
    const blocks = ttReadBlocks($('#sheet-body'));
    api('PUT', `/api/timetable/terms/${state.ttTermId}/blocks`, { blocks })
      .then((r) => {
        state.ttLoaded = false;
        // 重开作息弹层：下半块必须拿到**服务端刚生成**的逐节时间
        ttSettingsSheet();
        render();
        toast(`已按块重排：${r.blocks.length} 个时段块 / ${r.periods.length} 个小节`);
      })
      .catch((e) => toast(e.message, true));
  },
  'tt-periods-save': (_act, _n, _id) => {
    const periods = ttReadPeriods($('#sheet-body'));
    const bad = periods.find((p) => p.start_time && p.end_time && p.end_time <= p.start_time);
    if (bad) {
      toast(`第 ${bad.index_no} 节的结束时间必须晚于开始时间`, true);
      return;
    }
    api('PUT', `/api/timetable/terms/${state.ttTermId}/periods`, { periods })
      .then((r) => {
        state.ttLoaded = false;
        render();
        toast(`已保存 ${r.periods.length} 个小节的时间`);
      })
      .catch((e) => toast(e.message, true));
  },
  'tt-import': (_act, _n, _id) => {
    ttImportSheet();
  },
  'tt-preview': (_act, _n, _id) => {
    ttPreviewAndShow();
  },
  'tt-commit': (_act, _n, _id) => {
    ttCommit();
  },
  'tt-terms': (_act, _n, _id) => {
    openSheet(
      '切换学期',
      state.ttTerms.length
        ? `<div class="tt-brows">${state.ttTerms
            .map(
              (t) =>
                `<button class="btn${t.id === state.ttTermId ? '' : ' ghost'}" data-act="tt-pick-term" data-id="${
                  t.id
                }" type="button" style="min-height:46px">${esc(t.name)}${
                  t.id === state.ttTermId ? '（当前）' : ''
                }</button>`,
            )
            .join('')}</div>`
        : '<div class="m-tip">还没有学期，先「＋ 新建学期」。</div>',
      '<button class="btn ghost" data-act="sheet-close">关闭</button>',
    );
  },
  'tt-pick-term': (_act, n, _id) => {
    state.ttTermId = Number(n.dataset.id);
    state.ttWeek = null;
    state.ttWeekInit = false;
    state.ttDay = null;
    state.ttLoaded = false;
    closeSheet();
    render();
  },
  'tt-new-term': (_act, _n, _id) => {
    ttTermSheet(null);
  },
  'tt-edit-term': (_act, _n, _id) => {
    ttTermSheet(state.tt && state.tt.term);
  },
  'tt-term-save': (_act, n, _id) => {
    const body = {
      name: ($('#tt-t-name') || {}).value || '未命名学期',
      start_monday: ($('#tt-t-start') || {}).value || '',
      total_weeks: Number(($('#tt-t-weeks') || {}).value) || 17,
    };
    // 第二版：「节假日前一天：下午提前」**搬去了作息设置**（同一个设置只放一处），
    // 所以这里只发这三个键（PUT 是带哪个写哪个，剩下的字段原样不动）。
    const tid = n.dataset.id ? Number(n.dataset.id) : null;
    (tid ? api('PUT', `/api/timetable/terms/${tid}`, body) : api('POST', '/api/timetable/terms', body))
      .then(async (r) => {
        if (!tid && r && r.id) state.ttTermId = r.id;
        closeSheet();
        state.ttLoaded = false;
        await refresh();
        toast(tid ? '已保存' : '学期已创建');
      })
      .catch((e) => toast(e.message, true));
  },
  'tt-hol-save': (_act, _n, _id) => {
    // 同上：只发这两个键，绝不顺手把名称 / 开学日期覆盖掉
    api('PUT', `/api/timetable/terms/${state.ttTermId}`, {
      holiday_advance_minutes: Number(($('#tt-hol-adv') || {}).value) || 0,
      holiday_pm_from: ($('#tt-hol-pm') || {}).value || '',
    })
      .then(async () => {
        state.ttLoaded = false;
        await refresh();
        toast('已保存');
      })
      .catch((e) => toast(e.message, true));
  },
  refresh: (_act, _n, _id) => {
    refresh({ toast: '已刷新' });
  },

  // 设置页的每一块分区都能折叠：标题行就是按钮，`data-sec` 是分区标识。
  'sec-toggle': (_act, n, _id) => {
    toggleSec(n.dataset.sec);
  },
  export: (_act, _n, _id) => {
    exportMine();
  },

  // **整体**备份与恢复（后两个只在管理员时才会被渲染出来；权限判定在服务端）。
  // 这两个导出动作在 `more.js` 里**先弹确认框再下载** —— 设置页上不再摆常驻提示。
  import: (_act, _n, _id) => {
    importFlow();
  },
  'imp-merge': (_act, _n, _id) => {
    importCommit('merge');
  },
  'imp-replace': (_act, _n, _id) => {
    importCommit('replace');
  },
  'org-export': (_act, _n, _id) => {
    exportOrgConfirmed();
  },
  'org-restore': (_act, _n, _id) => {
    orgRestoreFlow();
  },
  'rst-go': (_act, _n, _id) => {
    restoreCommit();
  },
  // **记账数据迁移** —— 与「恢复整体备份」同栏、同一种危险待遇
  // （危险红行 ＋ 说明 ＋ 手打「迁移」二字）。⚠️ 与电脑端 `set-org-migrate` 是同一件事的两端入口。
  'org-migrate': (_act, _n, _id) => {
    migrateLedgerFlow();
  },
  'mig-go': (_act, _n, _id) => {
    migrateGo();
  },
  task: (_act, n, id) => {
    const w = state.all.find((x) => x.t.id === id() && String(x.scope) === String(n.dataset.scope));
    if (w) openTask(w);
  },

  // 对话气泡下面那枚「已添加到任务」标记 → 跳到那条任务。
  // 换屏与打开详情是**导航的事**，所以放在入口这一层（与 `teamwork-tab` 同一个道理）：
  // `modules/teamwork/mobile.js` 刻意不 import 入口，它只负责把那枚标记画出来并带上 scope / id。
  'teamwork-task': (_act, n, id) => {
    const scope = coerceScope(n.dataset.scope);
    state.scope = scope;
    state.selDate = todayStr();
    state.weekStart = mondayOf(todayStr());
    switchTab('board');
    const w = state.all.find((x) => x.t.id === id() && String(x.scope) === String(scope));
    // 找不到（任务刚被删掉）时说一句人话：标记还在而点下去没反应，用户会以为应用坏了
    if (w) openTask(w);
    else toast('这条任务已经不在了（可能刚被删掉）', true);
  },
  due: (_act, n, _id) => {
    const src = n.dataset.source;
    state.scope = coerceScope(src);
    state.selDate = todayStr();
    state.weekStart = mondayOf(todayStr());
    switchTab('board');
  },

  // 首页看板（「今天」这一屏）：
  // `dash-preset` = 今日 / 单日 / 本周 / 本月（只改区间并重新取数，不动其它标签）
  // `dash-filter` = 点概览上某一个数 → 把下面筛成这一类（再点一次取消）
  'dash-preset': (_act, n, _id) => {
    dashSetPreset(n.dataset.dash);
  },
  // 周条（新区间条）—— 与上面那套旧控件**驱动同一个 state**，只是一组更顺手的入口：
  // `‹`/`›` 整周前后挪、「今天」回到今日、点某一格看那一天。
  // 都走 `views/today.js` 的导出，不在这里自己拼 `dashRange()` ——
  'dash-week': (_act, n, _id) => {
    dashShiftWeek(Number(n.dataset.delta) || 0);
  },
  'dash-today': () => {
    dashGoToday();
  },
  'dash-day': (_act, n, _id) => {
    dashSetDay(n.dataset.dashDay);
  },
  // 「这两个图标放到【今天】的旁边」（筛选 ＋ 放大镜）——
  // 点它们只改 `state.dash.panel` 再同步一次显隐，**不重新取数**
  'dash-panel': (_act, n, _id) => dashTogglePanel(n.dataset.panel),
  'dash-filter': (_act, n, _id) => {
    dashSetFilter(n.dataset.filter);
  },
  'dash-link': (_act, n, _id) => {
    // 它是嵌在 `.dash-row`（`dash-open`）里的：`onAction()` 取的是**最近**的那个 `data-act`，
    // 所以点网址不会顺带跳去任务板 —— 「点 🔗 就是想开链接」这件事不该有第二种解释。
    window.open(n.dataset.url, '_blank', 'noopener,noreferrer');
  },
  'dash-goto': (_act, n, _id) => {
    switchTab(n.dataset.tab);
  },
  'dash-goto-mod': (_act, n, _id) => {
    // 首页看板「其它」那一块 —— 点一张模块卡进那个模块。
    // 落点**从本端接线表查**（`hub.view` / `tab.view`），⛔ 不读 DOM 上的屏名：
    // 卡片上只带模块名，写死屏名就等于在模板里放第二份「模块 → 屏」的对应表。
    gotoModule(n.dataset.mod);
  },
  'dash-open': (_act, n, id) => {
    const kind = n.dataset.kind;
    if (kind === 'course') {
      // 三块并成一个模块 ⇒ 先记下要落哪一格，再切进 `time` 那一屏。
      state.timeTab = 'timetable';
      switchTab('time');
      return;
    }
    // `kind === 'hardware'` 是**服务端数据的种类键**（与表名 / 接口前缀同一套契约，
    // 「NAS硬件管理」→「数码管理」的结果，表名 / 接口一个字没动）。
    // 目标改成**走 `gotoModule()`** —— 数码管理不再有自己的一屏（它借
    if (kind === 'hardware') {
      gotoModule('digital');
      return;
    }
    const scope = coerceScope(n.dataset.src);
    state.scope = scope;
    state.selDate = todayStr();
    state.weekStart = mondayOf(todayStr());
    // 「可以直接修改任务而不是跳转」—— **不再先切到任务板**，
    // 就地弹出这条任务的详情（里头能编辑 / 完成 / 删除；改完详情里的写操作会 `refresh()`，
    // 看板与这一屏一起刷新）。
    const w = state.all.find((x) => String(x.t.id) === String(id()) && String(x.scope) === String(scope));
    if (w) {
      openTask(w);
      return;
    }
    // 兜底：状态里找不到（例如刚好被删掉）时照旧去任务板 —— 宁可多一步，也不要「点了没反应」
    switchTab('board');
    toast('这条任务已经不在了（可能刚被删掉）', true);
  },
  // `scope`（旧作用域滑轨的选项目动作）已随滑轨删除 —— 换项目走 `#bd-scope` 的 change 分支。
  day: (_act, n, _id) => {
    state.selDate = n.dataset.date;
    render();
  },
  'week-prev': (_act, _n, _id) => {
    state.weekStart = addDays(state.weekStart || mondayOf(todayStr()), -7);
    render();
  },
  'week-next': (_act, _n, _id) => {
    state.weekStart = addDays(state.weekStart || mondayOf(todayStr()), 7);
    render();
  },
  'week-today': (_act, _n, _id) => {
    state.weekStart = mondayOf(todayStr());
    state.selDate = todayStr();
    render();
  },
  // 筛选条：原来那六个按钮（全部 + 四象限五格 + 含已完成）已删，
  // 改成三个 —— 「全部」两个开关都清掉，「重要」/「紧急」各自独立开关。
  'tf-all': (_act, _n, _id) => {
    state.impOn = false;
    state.urgOn = false;
    // 修订：「全部」是**重置**钮 ⇒ 把新加的两个下拉也一起清掉
    state.kindFilter = '';
    state.statusFilter = '';
    render();
  },
  'tf-imp': (_act, _n, _id) => {
    state.impOn = !state.impOn;
    render();
  },
  'tf-urg': (_act, _n, _id) => {
    state.urgOn = !state.urgOn;
    render();
  },
  'proj-edit': (_act, _n, id) => {
    // 项目屏删掉后，这两个动作的入口是**任务板顶部**的 ✎ / 🗑（选中具体项目时出现）
    const p = state.projects.find((x) => x.id === id());
    if (p) projectForm(p);
  },
  'proj-del': (_act, _n, id) => {
    const p = state.projects.find((x) => x.id === id());
    if (p) delProject(p);
  },
  // `proj-open` / `proj-more` / `proj-top` / `scope`（旧作用域滑轨）已随「项目」屏整块删除，
  // 别加回来；项目排序在手机端没有落点（与电脑版同一条路，顺序仍在库里）。

  // 起只剩这**一个通用动作**（原先 `toggle-tt` / `toggle-bm` / `toggle-hw` /
  // `toggle-vault` / `toggle-teamwork` 五个已合并）：翻哪个模块看 `data-mod`。
  'mod-toggle': (_act, n, _id) => {
    const it = moduleItems(state.modules, uiOf, state.me || {}).find((x) => x.name === n.dataset.mod);
    if (it) toggleModule(it);
  },
  // 任务四（「管理改名为：设置，且这个设置要在全局设置中设置，
  // 全局设置和设置应该指向同一个设置，不能两边独立代码」）：「设置 → 模块功能」里那张卡上
  // 的「设置」—— 只有接线表声明了 `card.settings` 的模块才有这颗键。
  'mod-settings': (_act, n, _id) => {
    openModuleSettings('mobile', n.dataset.mod).then((ok) => {
      if (!ok) toast('这个功能的设置打不开 —— 请刷新页面重试');
    });
  },
  // **子开关**（一个模块里几个同级子模块各一颗，如 `time` 的
  // 课表 / 番茄钟 / 行程）—— 每行只提交**自己那一个键**（⛔ 绝不一次提交两个：
  // 那会把另一台设备刚改的值覆盖掉）。键与列名都从行上的 `data-*` 取（⛔ 不写死模块名）。
  'mod-sub': (_act, n, _id) => {
    toggleModuleSub(n.dataset.key, n.dataset.field);
  },
  // 导航排序：「更多 → 首页导航栏」里点某一行 = 把它摆上底栏 / 从底栏撤下来。
  // 与 `views/more.js` 里那一行的 `data-act` **逐字一致**（对不上 = 点了没反应且不报错）。
  // 切换本身（改偏好 + 重画底栏 + 重画这一页）全在那个函数里，这里只做转调。
  'navtab-toggle': (_act, n, _id) => {
    navTabToggle(n.dataset.mod);
  },
  tg: (_act, n, _id) => {
    n.classList.toggle('on');
  },
  'detail-edit': (_act, _n, _id) => {
    const w = state.sheetTask;
    closeSheet();
    if (!w) return;
    // 项目任务**必须把 `w.scope` 一起传进去**：任务板有了【汇总任务视图】之后
    // `state.scope` 可能是 `'all'`（那是视图不是项目 id），表单回落到它会 404
    if (w.scope === 'daily') dailyForm(w.t);
    else projectTaskForm(w.t, w.scope);
  },
  'detail-done': (_act, _n, _id) => {
    const w = state.sheetTask;
    closeSheet();
    // `tasksOf()` 的缓存里，光靠 id 会找不到 ⇒ 静默什么都不做。
    if (w) toggleTask(w.scope, w.t.id, w.t.status);
  },
  'detail-del': (_act, _n, _id) => {
    const w = state.sheetTask;
    closeSheet();
    if (w) delTask(w.scope, w.t.id);
  },
  'sheet-save': (_act, _n, _id) => {
    const fn = state.sheetSave;
    if (!fn) return;
    // 保存成功那一趟会自己 `closeSheet()`，草稿要跟着作废；校验没过 / 请求失败时弹层还开着，
    markSaving();
    Promise.resolve()
      .then(fn)
      .then(() => endSaving())
      .catch((e) => {
        endSaving();
        toast(e.message, true);
      });
  },
  'sheet-close': (_act, _n, _id) => {
    // 关底部弹层时顺手丢掉密码库详情里的那份明文 —— 「明文只在弹层打开期间存在」
    // 这句话必须在**每一条**关闭路径上都成立，而这里是所有关闭路径的汇合点。
    // 宿主不再静态 import 密码库 ⇒ 改走 `flushVaultSheetItem()`
    flushVaultSheetItem();
    closeSheet();
  },

  // 既有缺陷修复：`askConfirm` 的「取消」按钮过去是**点了没反应**的 —— `cf-no` 没有处理分支，
  // 只能靠点弹层外的遮罩关掉。而 `closeSheet()` 里本来就写着「把 confirmResolve 以 false 结束」，
  // 缺的就是这一句。新增「删除成员」这条不可恢复的路径后才必须修：
  'cf-no': (_act, _n, _id) => {
    closeSheet();
  },
  'change-name': (_act, _n, _id) => {
    changeNameForm();
  },
  'change-pw': (_act, _n, _id) => {
    changePwForm();
  },
  logout: (_act, _n, _id) => {
    doLogout();
  },
  'reg-toggle': (_act, _n, _id) => {
    const on = !!state.allowSelfRegister;
    askConfirm({
      title: on ? '关闭自主注册' : '打开自主注册',
      text: on
        ? '关闭后，只有你能在「成员管理」里添加账号；已经注册的账号不受影响。'
        : '打开后，知道本应用地址的人都能自己注册账号（各自只能看到自己的数据）。',
      ok: on ? '关闭' : '打开',
    }).then(async (yes) => {
      if (!yes) return;
      try {
        const r = await api('PUT', '/api/admin/settings', { allowSelfRegister: !on });
        state.allowSelfRegister = !!r.allowSelfRegister;
        render();
        toast(state.allowSelfRegister ? '已打开自主注册' : '已关闭自主注册');
      } catch (e) {
        toast(e.message, true);
      }
    });
  },
  'member-add': (_act, _n, _id) => {
    memberAddForm();
  },
  'copy-path': (_act, _n, _id) => {
    const p = (state.storage && state.storage.dataDir) || '';
    copyText(p).then((ok) =>
      ok ? toast('数据目录已复制') : toast('这个环境不允许自动复制，请长按路径手动复制', true),
    );
  },
  // 「关于我们 / 联系与反馈」—— 电脑版是侧栏底部两颗按钮，手机版是「更多」里两张卡。
  // 两边打开的是**同一份内容**（`core/about.js`），这里只管「怎么弹」。
  // 这两个抽屉**必须用自适应高度**（不传 `fixed`）：
  about: () => {
    openSheet('关于我们', aboutBodyHtml(), '');
  },
  contact: () => {
    openSheet('联系与反馈', contactBodyHtml(), '');
  },
  // 各端最新版本检测 —— **唯一会对外联网的那一颗按钮**（许可协议 §四：只有主动点
  // 「检查更新」才请求一次）。⚠️ `state.versionsBusy` 既是防连点闸门、也是按钮的禁用态；
  // 失败照旧把 `{ok:false,message}` 存下来，界面才说得出「为什么没有」。
  'check-updates': (_act, _n, _id) => {
    if (state.versionsBusy) return;
    state.versionsBusy = true;
    render();
    api('GET', '/api/versions')
      .then((r) => {
        state.versions = r;
      })
      .catch((e) => {
        state.versions = { ok: false, message: (e && e.message) || '连接失败' };
      })
      .finally(() => {
        state.versionsBusy = false;
        render();
      });
  },
  'member-rename': (_act, _n, id) => {
    memberRenameForm(id());
  },
  'member-reset': (_act, _n, id) => {
    memberResetForm(id());
  },
  'member-del': (_act, _n, id) => {
    const u = (state.members || []).find((x) => x.id === id());
    if (!u) return;
    askConfirm({
      title: '删除成员',
      text: `将删除「${u.username}」及其全部项目与任务，不可恢复。建议先让他在「我的账号 → 导出数据备份」里导出一份。确定删除吗？`,
      ok: '永久删除',
      danger: true,
    }).then(async (yes) => {
      if (!yes) return;
      try {
        await api('DELETE', '/api/admin/users/' + u.id);
        await refresh();
        toast('已删除成员「' + u.username + '」及其数据');
      } catch (e) {
        toast(e.message, true);
      }
    });
  },
  'cf-yes': (_act, _n, _id) => {
    const r = state.confirmResolve;
    state.confirmResolve = null;
    closeSheet();
    if (r) r(true);
  },
};

/**
 * 功能：把一次界面动作派发到对应的处理函数 —— **只查 `ACTIONS` 表**（见上），
 * 表里没有的动作什么都不做（与改造前的 `default: break;` 等价）。
 *
 * 说明：只有「查表 + 调用」—— 加模块时改的是上面那张表、不动派发本身。
 */
export function onAction(act, n) {
  const h = ACTIONS[act];
  const id = () => Number(n.dataset.id);
  if (h) h(act, n, id);
}

/**
 * 功能：翻某个模块的显示开关 —— **一个函数管全部模块**（模块名与接口键都从清单与接线表来的）。
 *
 * 说明：⭐ **点了就生效**：不弹确认层、也不弹轻提示（指令）。反馈只有那一行开关
 * 自己的状态变化 —— 再拦一句「你确定吗」、事后再飘一句「已关掉课表」都是多余的。
 * 与电脑版逐字对应：那边撤掉的也是这一套，别只改一端。
 */
export async function toggleModule(it) {
  if (!state.me) return toast('还没读到你的账号，点右上角刷新再试一次', true);
  if (!it || !it.prefsKey) return;
  await putPref(it.prefsKey, !state.me[it.switchField]);
}

/**
 * 功能：翻**一个子开关**（一个模块里几个同级子模块各一颗，如 `time` 的课表 / 番茄钟 / 行程）。
 *
 * 绝不一次提交两个（提交两个等于拿本地那份可能已过期的 `state.me` 去覆盖另一个开关）。
 * 与 `toggleModule()` 分开写是刻意的：那条单键通道只服务「一个模块一颗开关」的模块
 * （`prefsKeyOf()` 对数组回空串，正好把两者分开）。
 */
export async function toggleModuleSub(key, field) {
  if (!state.me) return toast('还没读到你的账号，点右上角刷新再试一次', true);
  if (!key || !field) return;
  await putPref(key, !state.me[field]);
}

/**
 * 功能：把某一项个人偏好提交到服务端并就地应用 —— 更新 `state.me`、应用标签显隐、重画当前页。
 *
 * 说明：⚠️ 每次**只提交一个键**：接口允许一次带多个，但两个开关各自独立更安全 ——
 * 同时提交等于拿本地那份可能已过期的 `state.me` 去覆盖另一个开关。
 * **成功不说话，失败必须说话**：不再弹「已关掉 X」那种轻提示（点了就生效，开关自己会变），
 */
async function putPref(key, next) {
  try {
    const r = await api('PUT', '/api/auth/prefs', { [key]: next });
    if (r && r.user) {
      state.me = r.user;
      // 草稿按账号隔离（键带账号 id）：同机换人登录看不到上一个人打的半截字
      setDraftOwner(r.user.id);
    }
    applyPrefsVisibility();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

/** 上一轮画出来的模块标签签名（见 `renderModuleTabs()`） @type {string} */
let tabSig = '';

/**
 * 功能：把底部标签栏里的**模块标签**按本账号偏好重画（挑哪几颗、什么顺序都由偏好定）。
 *
 * 现在「有哪些模块」由 `module.json` 说了算，本端只提供「长什么样」
 * （`mobile/modules.js` 的 `tab` 那一段）。⇒ **删掉 `app/modules/<模块>/` 目录，底部就少一个标签**。
 * 导航排序（「手机端在更多中设置首页导航栏显示的东西和排序」）：
 */
function renderModuleTabs(items) {
  // 摆哪几颗、什么先后 —— 判据只在 `core/modules.js` 的 `navTabItems()` 一处
  // （⚠️ 需要 `state.me` 里的 `nav_tabs`；清单还没到手时 `items` 为空数组，安全）。
  const rows = navTabItems(items, state.me || {});
  // 显隐判据从 `it.on` 换成 `entryOn()`（与电脑端 `shell.js` 同一份判据）——
  // 纯屏模块（网址/密码夹、个人资产管理）自己不可关，但它那一屏的内容全靠别人借位置；
  const sig = rows.map((it) => `${it.name}${entryOn(it, items) ? '+' : '-'}`).join(',');
  if (sig === tabSig) return;
  tabSig = sig;

  const bar = $('#tabbar');
  // 锚点从 `#tab-more` 换成 `#tab-settings` —— 底栏那颗「更多」撤了
  // （「更多改名为导航栏设置，并移到设置中」），模块标签现在插在「设置」**前面**：
  // 今天 / 任务板 /〔模块标签…〕/ 设置（出厂那两颗是收藏夹 ＋ 资产）。
  const anchor = $('#tab-more');
  if (!bar || !anchor) return;
  bar.querySelectorAll('button[data-mod]').forEach((b) => b.remove());
  anchor.insertAdjacentHTML(
    'beforebegin',
    rows
      .map(
        (it) => `
        <button type="button" id="${it.tab.id}" data-tab="${esc(it.tab.view)}" data-mod="${esc(it.name)}"${
          entryOn(it, items) ? '' : ' class="hidden"'
        }>
          ${it.svg}
          <i>${esc(it.tab.name || it.title)}</i>
        </button>`,
      )
      .join(''),
  );
  // 对话的红点住在它**自己的**底部标签按钮里（`updateTeamworkUnread()` 负责建与写）——
  // 标签刚被重建，红点要跟着补一笔；不在对话标签的常态下它多半还是收起的，无妨。
  updateTeamworkUnread();
}

/**
 * 功能：按当前账号的个人偏好（`me.hide_*`）决定底部模块标签、以及「更多 / 设置」两页里那些入口行的显隐；
 * 若某个开关刚被关掉（或者那个模块的目录被整个删掉了）、而用户正停在对应的那一页，
 * 就把他送到别处（不能停在一个已经看不到的页面上）。
 *
 * 说明：⭐ 判断依据全部来自清单与接线表，本函数**不认识任何具体模块名**：
 */
export function applyPrefsVisibility() {
  // 把人从当前屏赶走，再在数据到达后赶回来。
  if (!state.modules) return;
  const items = moduleItems(state.modules, uiOf, state.me || {});
  renderModuleTabs(items);

  const byName = new Map(items.map((it) => [it.name, it]));
  /** 功能：某个模块**这次不该出现**（被本账号关掉了，或清单里已经没有了） @param {string} name - 模块名 */
  const off = (name) => {
    const it = byName.get(name);
    return !it || !it.on;
  };

  /**
   * 功能：某个**子开关**此刻是不是关着的 —— `field` 是 `users` 上的列名（`hide_timetable` 等），
   * 与 `module.json` 的 `switchField` 同一套词汇。
   *
   * 说明：⚠️⭐ 它与上面的 `off()` **不是一回事**：`off()` 吃的是**模块名**（查清单里有没有这个模块、
   * 以及它开着没有），这里吃的是**模块内的子开关列**。两套词汇混用会**恒真** ——
   */
  const subOff = (field) => !!(state.me && state.me[field]);

  // 密码库**不再有自己的屏** ⇒ 这里只剩「关掉它就清内存里的明文」那一半
  // ，而且改成派**留白事件** —— 宿主不再静态 import 密码库，谁持有明文谁自己听。
  // 「把人送走」那一半不需要了：`state.tab` 再也不会是 `'vault'`；药丸由 `webpass`
  if (off('vault')) document.dispatchEvent(new CustomEvent('zx:pane-flush'));
  // 对话的两条副作用的安放处：**清单一到手 / 一有变化就同时定夺开与关** ——
  // 对话开着 ⇒ `teamworkBoot()`（幂等）：把那条应用级常驻的 SSE 通道开起来，
  // 未读红点与好友申请提示从此在任何标签上都能实时亮（第二轮反馈第 1 条）；
  const teamworkOn = !off('teamwork');
  if (teamworkOn) teamworkBoot();
  else stopTeamworkStream();
  if (off('teamwork') && state.tab === 'teamwork') {
    switchTab('more');
    return;
  }
  // 三块并成一个模块 ⇒ 判据从「人在哪个屏」变成「人在哪一格」：
  // 人正停在**被关掉的那一格**上 ⇒ 送回**本模块首页（日程表）**（不是送回「今天」）；
  // 三格全关 ⇒ 那个入口整个消失，人若还停在这屏上 ⇒ 送回「今天」。
  if (state.tab === 'time') {
    if (subOff('hide_timetable') && subOff('hide_pomodoro') && subOff('hide_trip')) switchTab('today');
    else if (state.timeTab !== 'home' && subOff('hide_' + state.timeTab)) timePick('home');
  }
  // 收藏夹与密码库不再有自己的屏 ⇒ 那两支撤了
  // （那一屏归 `webpass`，它永远在；药丸按新的项重画）。
  // 数码管理 `digital` **不再有自己的一屏**（并进

  // 清单 / 开关变了 ⇒ 通知**借了位置**的屏按新的项重画自己那一块
  // （目前只有 `webpass`：它的药丸就是按 `slotDefs()` 算出来的）。
  // 判据（「项的集合真的变了才动手」）在**接收方**，这里只负责喊一声 ——
  document.dispatchEvent(new CustomEvent('zx:prefs-changed'));
}

/**
 * 功能：切换底部标签页 —— 记下当前标签、显隐对应的视图容器、点亮标签栏上的按钮，
 * 再触发一次 `render()`；最后把标签写进地址栏 hash，使刷新时停在原处。
 * 说明：宿主 webview 限制 history API 时直接忽略，不影响标签切换本身。
 * 要先 `renderModuleTabs()` 再点灯：模块标签是按清单插进 DOM 的，第一趟进来时它还不存在，
 * @param {string} tab - 目标标签：底部的 'today' / 'board' / 'more' / 'settings'
 */
export function switchTab(tab, opts) {
  const prev = state.tab; // 判「这次是往下一层，还是平级 / 往上跳」，见 syncHistory()
  state.tab = tab;
  // 课表 2 期：离开「倒计时屏」（课表 / 今天看板）时先摘掉定时器 ——
  // 全端唯一一个（`core/timetable.js` 的 `ttTicker`）；要倒计时的屏在自己的渲染函数里
  // 再重新挂上（挂＝替换，不叠加）。所有标签切换都经过这里，与桌面版 `showView` 同一收口思路。
  ttTicker(false);
  // 番茄钟：离开番茄屏时摘掉那 1 秒心跳 —— 与上面 `ttTicker(false)`
  // 完全同一个理由（「唯一出口」），而且**必须在切屏这一步收**：心跳留在别的标签上跑，
  // 表现是「切走之后还在偷偷改 DOM」且不报任何错。
  clock.stop();
  renderModuleTabs(moduleItems(state.modules, uiOf, state.me || {}));
  // 换标签改走**交叉淡入** —— 先把「这一趟谁进、谁走」算出来。
  // 旧屏**不当场 `hidden`**（那就是「闪现」的根源）：它先打 `is-leaving`
  // 继续显示，等新屏渲染完再两层一起淡，收工才真正 `hidden`（数组里的 `node` 是**静态节点**，
  const entering = $('#view-' + tab);
  const leaving = [];
  [
    'today',
    'board',
    // 三块并成一个模块 ⇒ 视图名（与 hash 名单）从三个并成一个 `time`。
    'time',
    // `bookmarks` 与 `vault` 两个屏名换成一个 `webpass`（收藏夹 / 密码库并屏）
    'webpass',
    // `idea` 从这份名单里**撤了** —— 随手记不再是独立一屏
    // （并进「任务板」那一屏）。⛔ 留着它 ⇒ `$('#view-idea')` 回 null ⇒ 切屏当场抛。
    // `hardware` → `digital`（模块改名，屏名跟着改）；
    'assets',
    // zx 实验室（纯屏宿主）也有一屏；⛔ 漏了它 ⇒ 切过去整块内容不动、顶栏标题变字面量
    // `undefined`，而且**不报错**。
    'lab',
    'teamwork',
    // `ai` **从这份名单里撤了** —— AI 不再有自己的屏
    // （配置并入设置页的「AI 设置」一栏，与电脑版同一步）。⛔ 留着它 ⇒ `$('#view-ai')` 回 null
    'more',
    'settings',
  ].forEach((k) => {
    const node = $('#view-' + k);
    if (!node) return;
    if (k === tab) return;
    if (!node.classList.contains('hidden')) leaving.push(node);
  });
  if (entering) {
    leaving.forEach((n) => n.classList.add('is-leaving'));
    entering.classList.remove('hidden');
    // 第八轮（「闪现问题依旧」）：新屏先按住（`opacity`，⛔ 不是 `hidden`
    // —— 布局要留着）。下面 `render()` 对网址/密码夹等屏是**异步**的（先动态 import 片段）
    // ⇒ 不按住的话，那段时间旧屏与新屏会在同一格（`#app > .view` 都是 `grid-area: 1/1`）里叠着看。
    entering.style.opacity = '0';
  }
  // 「更多」页里的那几屏**没有自己的底部标签**时才高亮「更多」（`HUB_VIEWS` 由本端接线表推出来）。
  // 导航排序：这几屏现在**可能被用户挑上了底栏**（收藏夹 / 记账 / AI…都能上），
  // 那时它们**有自己的标签**，再点亮「更多」就会出现两个高亮（或者点错了另一颗）。
  const onBar = isOnBar(tab);
  const lit = HUB_VIEWS.includes(tab) && !onBar ? 'more' : tab;
  $('#tabbar')
    .querySelectorAll('button[data-tab]')
    .forEach((b) => b.classList.toggle('on', b.dataset.tab === lit));
  // `{ fresh: true, snapView: true }` = **进屏**（切过来也算）——
  // `snapView` 让「今天」按服务端偏好重落一次「默认视图」（的口径：「是『默认』：
  // 屏内切走之后，下次进屏仍按偏好决定」）；`fresh` 让它里面的模块视图（日历）重取一次数据
  if (tab === 'board' || tab === 'webpass' || tab === 'lab') {
    warmSlots('mobile', tab === 'board' ? 'board-pane' : tab === 'lab' ? 'lab-pane' : 'webpass-pane', {
      modules: state.modules,
      uiOf,
      me: state.me,
    });
  }
  // **新屏就绪之后**两层一起交叉淡入（旧屏收工才真正 `hidden`）。
  // 多数屏的 `render()` 是同步的 ⇒ `painted` 是 `undefined`，`Promise.resolve` 兜住；
  // 网址/密码夹与个人资产管理两屏要先**动态 import** 片段再挂载 ⇒ `render()` 会把那条
  const painted = render({ fresh: true, snapView: true });
  if (entering) {
    // `tier: 1` —— 这是**一级**（底栏换一整屏），与电脑端 `showView()` 同级。
    const settle = () => crossFade(leaving, entering, { cleanup: 'hide', tier: 1 });
    Promise.resolve(painted).then(settle, settle);
  }
  // `if (tab === 'digital') loadHardware()` 那一支**撤了** —— 数码管理不再有
  // 自己的一屏（它借「个人资产管理」那一屏的 `assets-pane` 槽），取数由它自己的视图片段在
  // 挂载时做（`modules/digital/mobile-assets-pane.js` → `mountHardware()`）。
  if (tab === 'today') snapDashView();
  // `if (tab === 'ledger') openLedger()` 那一支**撤了** —— 记账同样不再有自己的一屏，
  // 取数由视图片段在挂载时做（`modules/ledger/mobile-assets-pane.js` → `mountLedger()`；
  // 它本来就是「每次进来都重取一次」的口径，那段逻辑一个字节都没改，只改了函数名）。
  if (tab !== 'webpass') document.dispatchEvent(new CustomEvent('zx:pane-flush'));
  // 对话：第一次进这一屏才拉好友总览；之后由各操作自己 `loadTeamwork()` 刷新。
  if (tab === 'teamwork') teamworkEnter();
  // 离开对话标签**不再停长连接** —— 通道改为应用级常驻（登录即开），
  // 这样「今天 / 更多」等标签上的未读红点与好友申请提示才能实时亮起来
  // （第二轮反馈第 1 条）。一台设备常驻一条，服务端每账号 5 条的名额毫无压力；
  if (tab !== 'teamwork') {
    state.teamworkView = 'list';
    closeSlotConv();
  }
  syncHistory(tab, !!(opts && opts.replace), prev);
}

/**
 * 每个屏的**父级屏**（`null` / 缺省 = 顶级）。
 *
 */
const NAV_PARENT = {
  board: 'today',
  teamwork: 'today',
  // 三块并成一个模块 ⇒ 上一级仍是「今天」（课表原来就在这一档）。
  time: 'today',
  more: 'today',
  settings: 'today',
  // `bookmarks` / `vault` 两屏并成 `webpass` 一屏（上一级仍是「更多」）
  webpass: 'more',
  // `idea` 从这张表里**撤了** —— 随手记不再是独立一屏（并进「任务板」）。
  // 留着它也不会崩，但那一屏的返回会被当成「已在顶级」⇒ 直接交给浏览器（＝离开应用）。
  // 新增 `assets`（「个人资产管理」也是从「更多」进去的，上一级同样是「更多」）。
  assets: 'more',
  ai: 'more',
  // zx 实验室同样从「更多」进去 ⇒ 上一级是「更多」。
  lab: 'more',
};

/**
 * 功能：算某一屏在层级树里的深度（今天 = 0）。
 *
 * 说明：⚠️ 由 `upOf()` **现算**，⛔ 不再写第二张"深度表"（两张表迟早会分家）。
 * 没登记的屏算 0（与顶级同待遇）—— 比抛错安全，它跑在渲染路径上。
 * @param {?string} tab - 屏名
 */
function depthOf(tab) {
  let d = 0;
  let t = upOf(tab);
  while (t) {
    d += 1;
    t = upOf(t);
  }
  return d;
}

/**
 * 功能：这一屏**此刻**在不在底部导航栏上（有它自己的标签、而且没被隐藏）。
 *
 * 说明：⭐⭐ 第六轮（「手机端各部分返回逻辑优化，原则：各部分都应该是
 * 逐级返回到【今天】，今天再返回就是退出」）：
 * 「收藏夹 / 资产」这类模块**既能**从「更多」页那一行进、**也能**（被用户摆上底栏之后）
 */
function isOnBar(tab) {
  const bar = $('#tabbar');
  if (!bar || !tab) return false;
  const b = bar.querySelector('button[data-tab="' + tab + '"]');
  return !!b && !b.classList.contains('hidden');
}

/**
 * 功能：这一屏的**上一级**是谁 —— 返回手势往上走一层就落到它。
 *
 * 说明：⭐⭐ 第六轮：`NAV_PARENT` 只写「它在树上的**默认**父级」，
 * 真正的上一级还要过一道「此刻从哪进来的」：
 * 底栏上的那几颗**都是一级入口**（今天 → 任一颗）⇒ 上一级是「今天」；
 */
function upOf(tab) {
  const base = NAV_PARENT[tab];
  if (!base) return null;
  // 只有「默认挂在『更多』下面」的那一族才需要按入口重算；其余（today）原样返回。
  if (base !== 'more') return base;
  return isOnBar(tab) ? 'today' : 'more';
}

/**
 * 功能：把刚被「返回」吃掉的那一条历史补回来（补的是**当前屏**的 hash）。
 *
 * 说明：⚠️ 补的是 `'#' + state.tab`，⛔ **不是** `location.hash` —— 触发 `popstate` 时浏览器
 * 已经把地址栏改成上一条记录了，照抄它等于把「界面与地址栏对不上」的状态钉死。
 * 目的就一句：**再按一次返回还能继续往上走**。不补的话，下钻两层之后按返回，
 */
function refill() {
  try {
    history.pushState(null, '', '#' + state.tab);
  } catch (_e) {
    /* 宿主 webview 限制 history API 时忽略 */
  }
}

/**
 * 功能：首屏进场时，按层级把**祖先链**补进历史栈（今天 → 更多 → 当前屏）。
 *
 * 按一次返回就**直接退出应用**（"逐级往上"的手感只在本次会话内成立），那是最容易被当成
 * "返回坏了"的一种。所以这里先把栈铺成祖先链，落点仍是当前屏。
 * 做法：先 `replaceState` 到链首（顶级 / 今天），再按层级一条条 `pushState` 上来 ——
 */
function syncHistoryChain(tab) {
  const chain = [];
  let t = tab;
  while (t) {
    chain.unshift(t);
    t = upOf(t);
  }
  try {
    history.replaceState(null, '', '#' + chain[0]);
    for (let i = 1; i < chain.length; i += 1) history.pushState(null, '', '#' + chain[i]);
  } catch (_e) {
    /* 宿主 webview 限制 history API 时忽略 */
  }
}

/**
 * 功能：问**当前这一屏**「有没有自己的二级屏要退」—— 有就退一层并回 `true`。
 *
 * 说明：⭐ 两个来源，**次序不能反**：
 * ① **宿主静态认识的几家**（记账 / 协作）—— 它们与宿主同生共死，直接调导出的函数；
 * ② **登记制**（`mobile/ui.js` 的 `setBackHandler()`）—— 给那几个**动态 import** 的屏用
 */
function backLayerOf(tab) {
  // 记账不再有自己的一屏 ⇒ 判据从 `tab === 'ledger'` **追加**成
  // `state.assetsPane === 'ledger'`（那一屏现在恒为 `'assets'`，真正的「现在看的是记账」
  // 由 `modules/assets/mobile.js` 写进 `state.assetsPane`）。
  if (tab === 'ledger' || (tab === 'assets' && state.assetsPane === 'ledger')) {
    if (lgBackLayer()) return true;
  }
  if (tab === 'teamwork' && teamworkBackLayer()) return true;
  // 第六轮（「各部分都应该是逐级返回到【今天】」）：其余几屏的屏内层级走
  // **登记制**（见 `mobile/ui.js` 的 `setBackHandler()`）——
  // 任务板停在「随手记」⇒ 先回「任务」；
  return runBackHandler(tab);
}

/**
 * 功能：把当前屏写进地址栏 hash —— **并且决定要不要留一条历史**。
 *
 * **每一屏都压一条历史**，退到最根那一屏再按才退出 —— 这一半是那一轮定下的，
 * 修订的是另一半（「回到上一级，而不是上一次」）：
 * **只有「往下一层」才压历史**（今天 → 更多 → 收藏夹），**平级 / 往上跳一律 `replaceState`** ——
 */
function syncHistory(tab, replace, prevTab) {
  try {
    const url = '#' + tab;
    const same = String(location.hash || '') === url;
    const deeper = depthOf(tab) > depthOf(prevTab);
    if (!replace && !same && deeper) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  } catch (_e) {
    /* 宿主 webview 限制 history API 时忽略 */
  }
}

// ---------- 初始化 ----------
/**
 * 功能：读出地址栏 hash 上的标签名，供首屏决定进入哪一个标签页。
 * @returns {?string} 合法标签名之一；hash 为空或不认识时返回 null
 */
export function hashTab() {
  const h = String(location.hash || '').replace('#', '');
  // 这张清单与 `switchTab()` 里那份**必须同一批名字**（少一个 ⇒ 刷新后掉回「今天」）
  return [
    'today',
    'board',
    // 三块并成一个模块 ⇒ 视图名（与 hash 名单）从三个并成一个 `time`。
    'time',
    // `bookmarks` / `vault` 换成一个 `webpass`（刷新后能回到这一屏）
    'webpass',
    // `idea` 从这份名单里**撤了** —— 刷新后不再有「随手记」那一屏
    // （并进「任务板」；旧的 `#idea` 深链会落回「今天」）。⚠️ 两份名单（`switchTab()` 的
    // 视图数组与本函数）**仍然必须同一批名字**。
    'assets',
    'teamwork',
    'more',
    'settings',
  ].includes(h)
    ? h
    : null;
}

/**
 * 「几 px 的视口抖动」阈值（px）—— ⛔ 别压到 2~3px：不同机型的**外壳工具栏动画**幅度不一样，
 * @type {number}
 */
const VIEWPORT_WOBBLE_PX = 24;

/**
 *
 * 说明：⭐⭐ 真机实测——「收藏夹 → 任务」那一下：
 */
function pinShellHeight() {
  /** 当前钉住的高度 / 宽度（用来判「这次变化要不要跟」） */
  let h = 0;
  let w = 0;
  /** 功能：把当前视口高度写进 `--app-vh`。 @returns {void} */
  const apply = () => {
    h = window.innerHeight;
    w = window.innerWidth;
    document.documentElement.style.setProperty('--app-vh', `${h}px`);
  };
  apply();
  window.addEventListener('resize', () => {
    const dw = Math.abs(window.innerWidth - w);
    const dh = Math.abs(window.innerHeight - h);
    if (dw < 2 && dh < VIEWPORT_WOBBLE_PX) return; // 几 px 的外壳抖动：刻意忽略
    apply();
  });
}

/**
 * 功能：手机版首屏初始化 —— 记下今天与本周起点、绑定全部事件，
 * 按地址栏 hash（缺省「今天」）进入标签页并拉取一次数据；
 * 随后起一个每分钟检查一次的定时器，跨天后自动重载，避免界面停在昨天。
 * @returns {void}
 */
export function init() {
  // 第三轮：**第一件事**就把外壳高度钉住（见 `pinShellHeight()` 的说明）——
  pinShellHeight();
  const today = todayStr();
  state.day = today;
  state.weekStart = mondayOf(today);
  state.selDate = today;
  // 导航排序：「更多 → 首页导航栏」改了偏好之后要重画**底部标签栏**，
  // 而重画它的函数（`applyPrefsVisibility`）住在**本文件**里 —— 那个视图不能反向 import 本文件
  // （会成静态环，见 `views/more.js` 里 `onNavChanged` 的说明），所以由这里注进去。
  setNavChangedHandler(applyPrefsVisibility);
  startVaultWatch();
  bindEvents();
  // `time` 那一屏的屏内委托与三个子屏的返回行挂一次
  // （挂在 `#view-time` 与各 pane 的 body 上 —— 都是静态节点）。
  bindTimeEvents();
  // 返回：先把**祖先链**补进历史栈（今天 → 更多 → 当前屏），再落到当前屏 ——
  // 不补的话，刷新 / 从深链进来时栈里只有这一条，按一次返回就**直接退出应用**。
  const start = hashTab() || 'today';
  // 首次进场用 `replace: true`：这一刻**本来就站在**这个位置，不该再压一条历史
  // （压了的话「更多」里那几屏一进来就多一层，返回手势要按两次才出得去）。
  switchTab(start, { replace: true }); // 刷新后回到原来那个标签
  // 第六轮：**次序反过来了**（原来是先补链再切屏）——
  // 现在「上一级」要读「这一屏在不在底栏上」（`isOnBar()`），而底栏上的模块标签是
  // `switchTab()` 里的 `renderModuleTabs()` 画出来的 ⇒ 先补链的话那一刻底栏还是空的，
  syncHistoryChain(start);
  refresh();
  // 从阅读器回来时带的那一跳（见 `applyGotoParam()`）
  applyGotoParam();
  // 重载恢复：上一趟被系统回收 / 网络重试 / 跨天重载打断时，把原表单连同草稿再打开一次
  restoreSheetAfterReload(start);
  // 跨天后自动重载，避免停在昨天
  setInterval(() => {
    if (todayStr() !== state.day) {
      flushDraft();
      location.reload();
    }
  }, 60000);
}

/**
 * 功能：页面重载后把上一趟开着的表单重新打开（草稿由 `openSheet()` 自动回填）。
 *
 * 说明：⭐ 只认 `resumeInfo()` 里记下的那一次 —— 用户主动关掉的弹层在 `closeSheet()` 里
 * 已经把恢复槽清了，不会自己弹回来。
 * 先切回那一屏再重开：表单里的候选值（项目清单、好友清单）依赖那一屏的上下文。
 */
function restoreSheetAfterReload(start) {
  const rec = resumeInfo();
  if (!rec) return;
  // 重载时 hash 已经把屏对上了；只有 hash 没写（弹层是从别的屏开的）才补切一次
  if (rec.tab && rec.tab !== start) switchTab(rec.tab, { replace: true });
  // ⚠️ 切屏与首屏渲染都是异步的（取数 + 重绘），立刻弹会撞上它们的收尾
  //   ⇒ 先同步试一次，再延后补一次（两次都幂等：`runResume()` 成功后会清槽）
  runResume();
  setTimeout(() => runResume(), 400);
}

// `loadAiView()` **已撤** —— 手机端 AI 也不再有自己的一屏
// （配置并入设置页的「AI 设置」一栏，与电脑版同一步）。它的界面现在由设置分栏片段
// `modules/ai/mobile-settings-pane.js` 动态挂载，那条路自己负责懒加载与失败提示。

/**
 * 功能：处理入口上的 `?goto=<模块>[:<slot>]` —— 打开后**直接落到那一屏**。
 *
 * 说明：⭐ 阅读器是整页跳转，关掉时只能回到「应用首页的 URL」；没有这一条，
 * 从阅读器回来的人会落在「今天」，而不是他刚才在看的加密信息。
 * 参数收完就用 `replaceState` 清掉，免得刷新一次又跳一次。
 */
function applyGotoParam() {
  let sp;
  try {
    sp = new URLSearchParams(location.search);
  } catch (_e) {
    return;
  }
  const goto = String(sp.get('goto') || '');
  if (!goto) return;
  const cut = goto.indexOf(':');
  const mod = cut < 0 ? goto : goto.slice(0, cut);
  const slot = cut < 0 ? '' : goto.slice(cut + 1);
  sp.delete('goto');
  const qs = sp.toString();
  try {
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  } catch (_e) {
    /* 不允许就算了，不影响下面那一跳 */
  }
  if (mod === 'lab') {
    pendingLabSlot = slot;
    switchTab('lab', { replace: true });
  }
}

/**
 * 功能：按当前标签页重绘对应视图（今天 / 任务板 / 课表 / 书签 / 灵感库 / 硬件 / 番茄钟 /
 * 记账 / 行程 / 密码库 / 对话 / AI / 更多 / 设置），最后统一刷新顶栏标题与副标题。
 *
 * 都各判一遍 `state.dashView`，那是五个会腐烂的分支）：
 * `{ fresh: true }`  —— **进屏**（或数据刚取回来）⇒ 挂在看板里的模块视图重取一次自己的数据；
 */
/** 这一次要落到哪个视图（模块名）—— 由 `zx:open-module` 的 `detail.slot` 带进来，用掉即清空 */
let webpassWant = '';

/**
 * 功能：把「网址/密码夹」那一屏画出来 —— ⛔ **必须动态 import**（与 `desktop/app.js` 同一条纪律）。
 *
 * `import('…')`，写成变量它看不见 ⇒ 那个文件会被误判成「生了但从不执行」。
 *
 * @returns {Promise.<void>} 这一屏画完（片段挂载完）之后 resolve —— `switchTab()` 要靠它
 */
function openWebpassView() {
  const want = webpassWant;
  webpassWant = '';
  return import('../modules/webpass/mobile.js')
    .then((m) => m.openWebpass({ slot: want }))
    .catch((e) => toast('网址/密码夹打不开：' + e.message, true));
}

/**
 * （与 `openWebpassView()` / `openAssetsView()` 同一条纪律）。
 * 与「删目录验收」的口径冲突。⚠️ 路径必须是**字面量**：孤岛检查用正则扫 `import('…')`，
 */
/** 这一次进实验室要直接落到哪个实验（模块名）；用掉即清空 —— 由 `?goto=lab:<slot>` 带进来 */
let pendingLabSlot = '';

/**
 * 功能：把「zx 实验室」那一屏画出来。
 * @param {string} [slot] - 要直接进的实验（模块名）；不传就落卡片首页
 * @returns {Promise.<void>} 这一屏画完（片段挂载完）之后 resolve
 */
function openLabView(slot) {
  return import('../modules/lab/mobile.js')
    .then((m) => m.openLab(slot ? { slot } : undefined))
    .catch((e) => toast('zx实验室打不开：' + e.message, true));
}

/**
 * （与 `openWebpassView()` 同一条纪律）。
 *
 */
function openAssetsView() {
  const want = assetsWant;
  assetsWant = '';
  const tabs = document.getElementById('assets-tabs');
  const body = document.getElementById('assets-body');
  if (tabs) tabs.innerHTML = '';
  if (body) body.innerHTML = '<div class="as-note">正在读取…</div>';
  return import('../modules/assets/mobile.js')
    .then((m) => m.openAssets({ slot: want }))
    .catch((e) => {
      if (body) body.innerHTML = '';
      toast('个人资产管理打不开：' + e.message, true);
    });
}

/** 这一次要落到「个人资产管理」那一屏的**哪一格**（模块名）—— 由 `gotoModule()` 写、用掉即清空 */
let assetsWant = '';

/**
 * 功能：把一个**模块名**落到正确的屏 —— 宿主里所有「去这个模块」的入口都走它。
 *
 * 所以「接线表里查不到屏名」不再等于「去不了」—— 它们现在**借别人的屏住**
 * （声明了 `assets-pane` 槽，界面挂在「个人资产管理」那一屏的药丸格里）。
 * 密码库（`webpass-pane`）/ AI（只有 `settingsPane`）三家的模块卡点了**没反应**，
 */
function gotoModule(name) {
  const mod = String(name || '');
  if (!mod) return;
  const ui = uiOf(mod);
  if (!ui) return;
  const view = (ui.hub && ui.hub.view) || (ui.tab && ui.tab.view) || '';
  if (view) {
    switchTab(view);
    return;
  }
  // 槽名与宿主那一屏的屏名是**约定成对**的（见 `core/slots.js` 的文件名约定与
  // 各宿主那一屏的骨架）—— 几个串写在这里是刻意的：一个模块可以声明多个槽，
  // 但「借哪一屏住」必须说得准，⛔ 别用「拿第一个槽凑」糊过去。
  const slots = Array.isArray(ui.slots) ? ui.slots : [];
  if (slots.includes('assets-pane')) {
    assetsWant = mod;
    switchTab('assets');
    return;
  }
  if (slots.includes('board-pane')) {
    state.boardTab = mod;
    switchTab('board');
    return;
  }
  if (slots.includes('webpass-pane')) {
    webpassWant = mod;
    switchTab('webpass');
    return;
  }
  // ③ 只借**设置页一栏**的模块（`settingsPane`，如 AI）—— 它没有自己的屏，也不借别人的视图槽，
  // 唯一那扇门就是设置页里的一个分块（`views/more.js` 的 `slotSectionHtmls()`）。
  // 分块里的内容是**异步**挂的（`mountSlotSections()` 动态 import 片段）：这里只等
  if (ui.settingsPane) {
    const paneId = String(ui.settingsPane.id || '');
    switchTab('settings');
    const box = paneId
      ? document.querySelector('#view-settings [data-slot-pane="' + paneId + '"]')
      : null;
    const sec = box && box.closest ? box.closest('.sec') : null;
    // 与「跳转授权」同一支（见 `scrollViewTo()` 的说明）：⛔ 不用 `scrollIntoView`，
    if (sec) scrollViewTo(sec, 0);
  }
}

/**
 * 功能：关底部弹层时请密码库丢掉详情里的那份明文（`sheet-close` 那条路，见它的说明）。
 *
 * 说明：⚠️ 走**动态** import —— 宿主不再静态认识密码库（撤了那条 import 才守得住
 * 它从没被加载过 ⇒ 本来就没有明文可清。
 *
 */
async function flushVaultSheetItem() {
  try {
    const m = await import('../modules/vault/mobile.js');
    m.vaultForgetSheetItem();
  } catch {
    /* 模块不在（整目录删掉了）：没有明文可清 */
  }
}

export function render(opts) {
  // 本函数把「这一屏画完」这件事**返给调用方**（`switchTab()` 要等它
  // 就绪才让旧屏淡出）—— 多数分支是同步的（`undefined`），只有下面三支真的要等：
  // 任务板（停在模块视图时要挂片段）、网址/密码夹与个人资产（先动态 import 再挂载）。
  let painted;
  if (state.tab === 'today') {
    if (opts && opts.snapView) snapDashView();
    renderToday(opts);
  }
  else if (state.tab === 'board') painted = renderBoard();
  // 三块并成一个模块 ⇒ 一条派发（按 `state.timeTab` 落具体那一格）。
  else if (state.tab === 'time') renderTime();
  // 网址/密码夹（收藏夹 / 密码库并成的那一屏）—— 动态 import，见上面
  else if (state.tab === 'webpass') painted = openWebpassView();
  // `state.tab === 'idea'` 那一支**撤了** —— 随手记不再是独立一屏，
  // 它的重画由药丸那一段自己走（`renderBoard()` → 重挂视图片段）。
  // `state.tab === 'digital'`（数码管理）与 `state.tab === 'ledger'`（记账）
  else if (state.tab === 'assets') painted = openAssetsView();
  // zx 实验室（纯屏宿主）—— 动态 import，见下面 `openLabView()`
  else if (state.tab === 'lab') {
    // 先取值再清空：`openLabView()` 是异步的，等它回来时这个变量已经被下一屏改掉了
    const want = pendingLabSlot;
    pendingLabSlot = '';
    painted = openLabView(want);
  }
  // 行程（取数在起的 `openTrip()` 里，这里只负责重画）
  else if (state.tab === 'teamwork') renderTeamwork();
  // `state.tab === 'ai'` 那一支**已撤**（AI 不再有自己的屏）。
  else if (state.tab === 'settings') renderSettings();
  else renderMore();
  updateChrome();
  return painted;
}

/**
 * 功能：刷新顶部栏 —— 写入标题，并按当前标签页拼出副标题（今天的待办项数、任务板的范围与日期、
 * 课表的学期与周次、设置页的后端与版本），
 * 同时决定悬浮按钮在哪些标签页收起，以及它的无障碍标签是「新建项目」还是「新建任务」。
 * @returns {void}
 */
export function updateChrome() {
  $('#tb-title').textContent = TITLES[state.tab];
  let sub;
  if (state.tab === 'today') {
    const s = state.summary;
    if (s) {
      const n =
        ((s.today && s.today.daily) || 0) +
        Object.values((s.today && s.today.projects) || {}).reduce((a, b) => a + b, 0);
      sub = `${fmtLong(todayStr())} ${weekName(todayStr())} · 待办 ${n} 项`;
    } else if (state.loadError) {
      // 取数失败要说清楚、并指一条出路 —— 以前这里写「正在读取…」，
      sub = '读取失败，点右上角 ↻ 重试';
    } else {
      sub = `${fmtLong(todayStr())} ${weekName(todayStr())} · 读取中…`;
    }
  } else if (state.tab === 'board') {
    // 这一屏现在有**两颗药丸视图**（任务 ｜ 随手记）。
    // 停在模块视图上时，副标题要说的是**那一边**的事，⛔ 别继续报作用域与日期
    // （两处说的不是一件事，看着像界面没对齐 —— 而且它**不报错**）。
    const tabMod = state.boardTab
      ? moduleItems(state.modules, uiOf, state.me || {}).find((it) => it.name === state.boardTab)
      : null;
    if (tabMod) {
      sub = `${tabMod.icon} ${tabMod.title}`;
    } else {
      const m = scopeMetaOf(state.scope);
      sub = `${m.icon} ${m.name} · ${fmtLong(state.selDate || todayStr())}`;
    }
  } else if (state.tab === 'time') {
    // 三块并成一个模块 ⇒ 顶栏那一句按**当前那一格**说
    // （课表那格沿用原来那句；番茄钟那格沿用原来那句；首页与行程各一句）。
    if (state.timeTab === 'timetable') {
      const t = state.tt && state.tt.term;
      sub = t
        ? `${t.name} · ${state.tt.week ? '第 ' + state.tt.week + ' 周' : '全学期'} · ${state.tt.cells.length} 节课`
        : '导入课表 / 查看本周';
    } else if (state.timeTab === 'pomodoro') {
      // 只说「今天 / 本周各几个番茄」—— 与屏内那两行同一个口径。
      // 不编「效率」「专注分」这类词（不做伪精确指标）。
      const st = (state.pomo && state.pomo.stats) || {};
      const t = (st.today && st.today.count) || 0;
      const w = (st.week && st.week.count) || 0;
      sub = t ? `今天 ${t} 个 · 本周 ${w} 个` : '专注计时 / 记番茄';
    } else {
      sub = '日程 · 番茄钟 · 行程';
    }
  } else if (state.tab === 'webpass') {
    // 只说「这一屏装的是哪两件事」，⛔ **不复述任何一条收藏 / 密码的内容**
    // （顶栏是给别人瞄一眼最先看到的地方 —— 与对话页同一条纪律）。
    sub = '网址收藏夹与密码库 · 一屏切换';
  } else if (state.tab === 'assets') {
    // 只说这一屏装的是哪几块，⛔ **不复述任何一条资产的内容**
    // （顶栏是给别人瞄一眼最先看到的地方 —— 与 `webpass` / 对话那两条注释同一条纪律）。
    // 这一句现在也覆盖**数码管理**那一格 —— 它不再有自己的一屏
    sub = '生活记账 / 数码管理 / 自建分组';
  }
  // `state.tab === 'ledger'` 那一条副标题**撤了**（连同它那一整段注释）——
  // 记账不再有自己的一屏（并进 `assets` 那一屏的药丸格），顶栏那一句由上面 `assets` 那条说。
  // 别按 `state.assetsPane === 'ledger'` 把它加回来：`state.lgSeg` 那几段是**格内**的状态，
  else if (state.tab === 'teamwork') {
    // 副标题里只说「有几个会话 / 几条未读」，**不复述任何人的名字或消息内容** ——
    // 顶栏是给别人瞄一眼最先看到的地方。
    // 对话页上：线路不正常时把原因写出来（与页内那条告警条同一份文案，见
    const peer = state.teamworkPeer || (state.teamworkBuddy && state.teamworkBuddy.user) || null;
    const warn = state.teamworkView === 'thread' ? teamworkStatusText(state.teamworkStreamStatus) : '';
    sub =
      state.teamworkView === 'thread'
        ? warn || (peer && peer.username ? '@' + peer.username : '私聊')
        : (state.teamworkConversations || []).length
          ? `${state.teamworkConversations.length} 个会话 · 未读 ${state.teamworkUnreadTotal || 0} 条`
          : '加好友 / 聊天';
  } else if (state.tab === 'settings') {
    // 起「设置」是独立标签页：副标题说清这里有哪几块（顺序与电脑版一致）
    const h = state.health;
    sub = h ? `数据来源 / 模块功能 / 账号 · v${h.version}` : '数据来源 / 模块功能 / 账号';
  } else {
    // 第五轮（「更多：模块进入 · 设置 · 导航栏」）：这一屏现在有**三块**，
    // 副标题就照这三块说 —— ⛔ 不再罗列模块名（那些名字由接线表与清单决定，
    // 写死一句「网址收藏夹 · 个人资产 · …」会在加模块 / 改显示名之后悄悄变成假话）。
    sub = '模块进入 · 设置 · 导航栏';
  }
  $('#tb-sub').textContent = sub;
  // -⑯：**进了会话就把顶栏里那几件收起来**（蓝图标 / 「对话」两个字 / 副标题 / 右侧 ↻）。
  // 理由：会话页里那一整条占着屏幕最上面，而且副标题写的是**列表页**的口径
  // （「N 个会话 · 未读 N 条」—— 已经点进某个人了，这句话既占地又误导）。
  const inConv = state.tab === 'teamwork' && (state.teamworkView === 'thread' || !!state.teamworkSlot || !!state.teamworkCollab);
  // 记账不再是一屏（并进「个人资产管理」那一屏的药丸格）⇒ `state.tab` 恒为
  // `'assets'`，原来那两条判据**永远命不中**。所以**追加**两条读 `state.assetsPane` 的并列判据
  // （它由 `modules/assets/mobile.js` 写：「现在这一格是不是记账」）。
  const bare =
    inConv ||
    (state.tab === 'ledger' && !!state.lgAcct) ||
    (state.tab === 'ledger' && !!state.lgSetPage) ||
    (state.tab === 'assets' && state.assetsPane === 'ledger' && !!state.lgAcct) ||
    (state.tab === 'assets' && state.assetsPane === 'ledger' && !!state.lgSetPage);
  const bar = $('.topbar');
  if (bar) bar.classList.toggle('topbar-bare', bare);
  // **记账这一屏全屏接管** ——
  // 进去就把宿主那套底部主导航（资产/任务/…）收起来，改画记账自己的「资产 ｜ 记账 ｜ 设置」
  // （那段 HTML 在 `modules/ledger/mobile.js` 的 `segNavHtml()`，三颗按钮都是 `data-act="lg-seg"`）。
  const tabbar = $('#tabbar');
  if (tabbar) tabbar.hidden = state.tab === 'ledger' || (state.tab === 'assets' && state.assetsPane === 'ledger');
  // ：
  // 「生活记账 / NAS· 数码管理」那一排药丸（静态槽 `#assets-tabs`）在**账户详情**那一屏也收起来 ——
  // 详情屏自带「‹ 资产详情 ＋ 眼睛」那条头，上面再压一排"你在哪一格"的切换控件既占地方又没法用
  const atabs = $('#assets-tabs');
  // ：
  // 判据从"进账户详情"扩成**记账这一屏里的所有二级屏** —— 账户详情（`lgAcct`）、
  // 设置子页（`lgSetPage`）、账单的月详情（`lgMdMonth`）都自带「‹ 返回」那条头，
  if (atabs) {
    const subPane = !!state.lgAcct || !!state.lgSetPage || !!state.lgMdMonth;
    atabs.hidden = state.tab === 'assets' && state.assetsPane === 'ledger' && subPane;
  }
  // 收藏夹与硬件管理都有自己的「＋」按钮（在页头），所以悬浮按钮在这两屏收起；
  // 密码库同样有自己的「＋ 新增密码」，而且它的悬浮按钮还会和「锁定」抢位置；
  // 对话同理：对话页底部是固定输入框，悬浮按钮会压住消息
  $('#fab').classList.toggle(
    'off',
    state.tab === 'more' ||
      state.tab === 'settings' ||
      // 三块并成一个模块 ⇒ **整屏**一条判据（与 `assets` 同一条口径）：
      // 三个子屏屏内都自带动作（课表的「＋ 新建」/ 番茄钟的开始暂停 / 行程的新建加票），
      // 悬浮按钮「＋ 新建任务」压上去没意义。⛔ 不必按格补登记 —— 那是「按下标找行」那类旧账。
      state.tab === 'time' ||
      // 网址/密码夹 —— 两边（收藏夹 / 密码库）屏内都自带动作
      // （＋ 收藏 / ＋ 新增密码），悬浮按钮会正好压住它们 ⇒ 整屏收起。
      state.tab === 'webpass' ||
      // 真机修订：「任务板停在随手记那一档时收起全局 ＋」这条判据
      // **撤了** —— 随手记原来屏内自带一颗（住在视图片段里），而片段根会播 `dash-swap-in`，
      // 带 `transform` 的祖先会抢走绝对定位元素的包含块 ⇒ 切过去时那颗往右闪跳一下（实测 x 817→833）。
      state.tab === 'assets' ||
      // 记账：它的动作（「＋ 添加账户」）在屏内、又是通栏按钮 —— 悬浮按钮会正好压住它。
      // 记账并进「个人资产管理」那一屏之后，这一条已由上面那句
      // `state.tab === 'assets'` 覆盖（同一屏）⇒ 原来那句 `state.tab === 'ledger'` 删掉。
      state.tab === 'teamwork' ||
      // 加密信息片段**自己带一颗圆形 ＋**（`#secrets-new`，`z-index: 5`），
      // 而全局这颗是 `z-index: 45` ⇒ 正好压在上面。用户点的是「右边那颗 ＋」，
      // 命中的却是全局 ＋（语义是「新建任务」），于是弹出了任务表单。
      state.tab === 'lab',
  );
  // 真机修订：随手记那一档这颗 ＋ 是「记一条」⇒ 无障碍标签也得跟着换
  $('#fab').setAttribute('aria-label', state.tab === 'board' && state.boardTab ? '记一条' : '新建任务');
}

/**
 * 功能：数据层降级时在顶部常驻横幅（只读 / 退化到备用存储 / 迁移前备份失败），与电脑版行为一致。
 * 没有横幅节点、或数据层健康时，把横幅隐藏并清空文字。
 *
 * `degraded`（本次不是 SQLite）也要挂出来 ——
 * 它是「数据写进了另一份文件」这一种更安静的降级，与电脑版读的是**同一个**服务端字段。
 */
/** 本次页面加载里「数据库授权未完成」的弹层是否已经弹过（每次进入应用都要弹一遍） */
let lostAuthShown = false;

/**
 * 功能：数据位置**授权未完成**时的提示（与电脑端同一套口径，R-114）。
 *
 * 说明：⭐ `enforce === true`（自定义位置）且 `state === 'lost'` 才提示；
 * 管理员弹一次抽屉（可跳到 设置 → 账号设置 → 个人授权目录），普通成员挂常驻红字。
 * @param {Object} h - `state.health`
 */
function renderLostAuth(h) {
  const auth = h && h.dataLocation && h.dataLocation.auth;
  if (!auth || auth.enforce !== true || auth.state !== 'lost') return false;
  const b = document.getElementById('m-banner');
  const isAdmin = !!(state.me && state.me.is_admin);
  const adminText = '数据库授权没有完成，无法提供使用！！！请前往 设置 - 账号设置 - 授权。';
  const userText = '数据库授权没有完成，无法提供使用！！！请联系管理员检查授权信息。';
  if (isAdmin && !lostAuthShown) {
    lostAuthShown = true;
    openSheet(
      '数据库授权未完成',
      `<div class="loc-red" style="margin:0 0 12px">${esc(adminText)}</div>
       <button id="loc-auth-recheck" class="btn" type="button" style="width:100%">已重新授权，重新检查</button>`,
      '<button class="btn" type="button" data-act="sheet-close">稍后处理</button>' +
        '<button class="btn primary" type="button" id="loc-auth-jump" style="flex:1.4">【点击跳转】</button>',
    );
    const jump = document.getElementById('loc-auth-jump');
    if (jump) {
      jump.onclick = () => {
        closeSheet();
        gotoGrantPane();
      };
    }
    const recheck = document.getElementById('loc-auth-recheck');
    if (recheck) {
      // 与电脑端同一条：授权是在飞牛那边做的，做完回来应用里可能还是旧结论 ——
      // 没有这一颗，用户只能退出去再进，看起来就是「重新授权没用，还在弹」。
      // `?auth=1` = 不看缓存、现在问一次。
      recheck.onclick = async () => {
        recheck.disabled = true;
        recheck.textContent = '正在检查…';
        try {
          const r = await api('GET', '/api/health?auth=1');
          const st = r && r.dataLocation && r.dataLocation.auth;
          if (st && st.state === 'ok') {
            // 把新结论写回 `state.health`：不写的话下一次 `renderBanner()` 还按旧的 `lost`
            // 把红字挂回来（用户会觉得「说好了，怎么又弹」）。
            if (state.health && state.health.dataLocation) state.health.dataLocation.auth = st;
            closeSheet();
            const bn = document.getElementById('m-banner');
            if (bn) {
              bn.classList.add('hidden');
              bn.textContent = '';
            }
            toast('授权已恢复，可以正常使用了');
            return;
          }
          toast('还是没查到这个目录的授权 —— 请确认授权的是「数据位置」那个文件夹（或它的上级目录）', true);
        } catch (e) {
          toast(e.message || '检查失败，稍后再试', true);
        }
        recheck.disabled = false;
        recheck.textContent = '已重新授权，重新检查';
      };
    }
    return true;
  }
  if (!b) return true;
  b.className = 'm-banner';
  b.textContent = isAdmin ? adminText : userText;
  return true;
}

/** 「请重新启动应用」那张常驻卡是否已经挂过（同一页只挂一张） */

export function renderBanner() {
  const h = state.health;
  const b = document.getElementById('m-banner');
  if (renderLostAuth(h)) return;
  if (!b) return;
  if (!h || !(h.readOnly || h.degraded || h.backupError)) {
    b.classList.add('hidden');
    b.textContent = '';
    return;
  }
  b.className = 'm-banner' + (h.readOnly ? '' : ' warn');
  if (h.readOnly) {
    b.textContent = '数据层只读：数据库打不开，界面显示的不是库里的内容，已停止写入 —— 请检查数据目录权限后重启应用';
  } else if (h.degraded) {
    b.textContent =
      '数据层已降级：这次用的不是数据库（' +
      (h.initError || '数据库不可用') +
      '），数据写进了备用文件 —— 界面照常可用，请尽早修好后重启应用';
  } else {
    b.textContent = '迁移前自动备份失败：' + (h.backupError || '未知原因');
  }
}

// 用户开了「减弱动态效果」时，进场动画一律不做（设置了还硬放动画是没礼貌的）
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

const TITLES = {
  today: '今天',
  // 界面名改成「任务与随手记」（「把项目任务和随手记合并为
  // 【任务与随手记】」）—— 与电脑版侧栏、手机端底栏那颗标签逐字一致。
  // 这一屏还能切到随手记视图，顶栏标题是**整屏**的名字，所以两边都用这一个。
  board: '任务与随手记',
  timetable: '课表',
  // 网址收藏夹与密码库并成「网址/密码夹」一屏（两个屏名换成一个）
  webpass: '网址/密码夹',
  // `idea` 从这张表里**撤了** —— 随手记不再是独立一屏（并进「任务板」）。
  // 留着它不会崩，但那是一条**永远命不中**的分支。
  // `assets`（「个人资产管理」那一屏）—— ⛔ 漏一行，顶栏标题就是字面量 `undefined`。
  assets: '个人资产管理',
  lab: 'zx实验室',
  // 番茄钟：⚠️ 这张表是**硬编码**的 —— 新加一屏忘了在这里补一行，
  // 顶栏标题就会显示字面量 `undefined`（不报错、不留痕）。
  pomodoro: '番茄钟',
  // 日历**不再有自己的一屏** ⇒ 这张表里也没有它那一行
  // （`state.tab` 再也不会是 `'calendar'`，留着就是一条永远命不中的分支）。
  // 行程：⚠️ 这张表是**硬编码**的 —— 新加一屏忘了在这里补一行，
  trip: '行程',
  // `ledger` 那一行**撤了** —— 记账不再有自己的一屏（并进
  // 「个人资产管理」的药丸格），`state.tab` 再也不会是 `'ledger'`，留着就是一条永远命不中的分支。
  // 追加批：这一屏的界面名从「对话」改成「协作」
  teamwork: '团队协作',
  // 2 期：AI 辅助任务。⚠️ 这张表是**硬编码**的 ——
  // 新加一屏忘了在这里补一行，顶栏标题就会显示字面量 `undefined`（不报错、不留痕）。
  ai: 'AI 辅助任务',
  more: '更多',
  settings: '设置',
};

setNotifier(toast); // ⭐ 把本端的 toast 注册给 core/api.js（两端的提示是两套 DOM，不能合并）
// 自动草稿：恢复成功那一句同样走本端 toast（core/draft.js 不认识任何一端的 DOM）
setDraftNotice(toast);
// 离线只读：挂一次常驻横幅（断网时出现），并接管浏览器的 online / offline 事件。
// 必须在 `init()` 之前 —— 首屏那几个请求就可能已经失败，横幅要能立刻出现。
mountOfflineBanner();
// -⑯：把本端的顶栏重画器注册给 ui.js —— 模块（对话）在自己屏内换骨头之后要能请宿主重画一次
setChromePainter(updateChrome);

init();
