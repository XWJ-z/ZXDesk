/**
 * modules/ledger/desktop.js —— 记账**电脑版视图**
 *
 * 功能：电脑版记账这一屏的取数与渲染 —— `openLedger()` 拉一次 `GET /api/ledger/overview`
 * 并把这一屏画出来（净值卡 + 分组列表 + 通栏按钮 / 空态）；
 * `bindLedgerEvents()` 绑这一屏与弹窗的事件委托（详情 / 加 / 改 / 换类型 / 删除 / 转账）。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

import { api, backToLogin, BASE } from '../../core/api.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
// 原生日期 / 时间控件：点任意处都开系统选择器（判据与顺序在那一处，两端共用）
import { bindNativePickerOnce, openNativePicker } from '../../core/native-picker.js';
import { state } from '../../desktop/state.js';
import { closeModal, modalOpen, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import {
  PICK_OTHER,
  KIND_ORDER,
  pickShapeOf,
  fenToInput,
  fmtFen,
  fmtSide,
  fmtSignedFen,
  fmtTx,
  iconOf,
  metaOf,
  monthLabel,
  monthOf,
  needTailOf,
  needLimitOf,
  tailLabelOf,
  limitLinesOf,
  TIERS,
  usageGroupsOf,
  groupIdOf,
  reorderPayload,
  optionsFor,
  txOf,
  TAG_MAX,
  VIEW_MAX,
  VIEW_NAME_MAX,
  // ：图表那一套（**只做画图** —— 占比 / 条长 / 排序 / 按月取点 / 扇段）
  sharePct,
  fmtPct,
  rankRows,
  trendSeries,
  trendGeometry,
  // 纵轴刻度那两件 —— `AXIS_MONTHS`（点一下要知道是第几个月）
  // 与 `yTickLabels()`（刻度文字：**一次给一整组**，保证三个刻度互不相同，见它自己的说明）。
  // 本文件不自己拼「几月」、不自己截金额。
  AXIS_MONTHS,
  yTickLabels,
  // ：按天折线那两件**也收口到共用几何**（见 `dayLineHtml()`）——
  // 本文件不再自己算 `lo/hi/xOf/yOf`（那是同一段算术的第二份拷贝）。
  dayAxisOf,
  dayValuesOf,
  // ：**图表**那一套 —— 口径两档、期间标签、
  // 以及折线那个横轴（`chartAxisOf()`）。⛔ 本文件不自己拼标签、不自己数格数。
  // 那颗「列表 ｜ 图表」副药丸**随「账单改两栏」撤了** ⇒ 它要的
  chartDirOf,
  chartAxisOf,
  donutArcs,
  ratioPair,
  debtRatioPct,
  USAGE_MAX,
  // 屏内顶部那四段 ＋ 五格白名单（**唯一出处**在 `calc.js`，—— 两端共用）
  SEG_TABS,
  SEG_KEYS,
  // 记账设置**二级菜单**的条目清单与判据（同上：唯一出处，两端共用）
  SET_PAGES,
  setPageOf,
  // ：导出的「导什么」清单与范围文案（**唯一出处**在 `calc.js`，
  EXPORT_WHATS,
  EXPORT_WHAT_KEYS,
  exportDateOf,
  exportDateText,
  // 收支分类的**全称**与**重名判据**（同上：唯一出处，两端共用 ＋ 服务端同口径一份）——
  // 新建 / 改名那一下拿它**提前拦**（撞了就不发那条注定 400 的请求）。
  catFullName,
  catNameTaken,
  // 记账 3 期：预算 / 账单那一套**两端共用**的纯口径 ——
  // 期间起点、期间文案、卡片标签、环里那句话、占比读法**全在 `calc.js`**（判据只住一处）。
  PERIOD_TYPES,
  periodKeyOf,
  periodLabelOf,
  budgetLineLabels,
  billCardLabels,
  billColLabels,
  pct1,
  ringText,
  budgetBlockText,
  shiftMonth,
  weekRangeLabel,
} from './calc.js';
// 记账 2 期：**流水那一套纯展示函数**单开了一份（`entry-calc.js`，C-39）——
// 金额的掩码 / 月份口径仍只住 `calc.js`（本文件 import 的那一份），这里加的只是**流水自己的形状**：
// 游标、按天分组、分类名、退款字样、三档颜色、默认账户的取值顺序。
import {
  ENTRY_PAGE_SIZE,
  buildCursor,
  parseCursor,
  groupByDay,
  monthOptions,
  catName,
  CAT_UNCLASSIFIED,
  isRefund,
  entryTitle,
  refundNoteOf,
  signedFen,
  changeTone,
  toneStyle,
  matchNote,
  pickDefaultAccount,
  // ：「哪几条是一级 / 哪几条是它的小分类 / 它有没有小分类 / 两级树」——
  // 「分类管理」那一栏（`catManageHtml`）与「记一笔」的分类网格读的是同一份 `state.lgCats`，
  // 两处各写一遍必然漂移成"管理页里有这条、记账时选不到"（而且不报错）。
  topCats,
  childCats,
  hasKids,
  catTree,
  // —— 月恒 12 项（`MONTHS_ALL`）、年取连续区间（`pickerYears`）；
  // 账户详情的月份下拉把出现过的每一年铺满 12 个月（`monthOptionsAll`）。
  MONTHS_ALL,
  pickerYears,
  monthOptionsAll,
} from './entry-calc.js';

/** 与手机端同值（真正的判据在服务端 `modules/ledger/routes.js`，这里只给输入框加 `maxlength`） */
const NAME_MAX = 60;
const NOTE_MAX = 200;
/** 分类名上限 —— ⚠️ 与 `modules/ledger/lib/categories.js` 的 `MAX_CATEGORY_NAME` 同值（60）：
 *  它只用来给输入框加一个 `maxlength`，真正的判据仍在服务端（超了就是 400，文案原样弹给用户）。 */
const CAT_NAME_MAX = 60;

/**
 * 眼睛（睁眼 / 闭眼）—— 与手机端**逐字同一份图形**（内联 SVG，单色形状 + `currentColor`）。
 *
 */
const EYE = {
  on:
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.2 12S5.8 5.8 12 5.8 21.8 12 21.8 12 18.2 18.2 12 18.2 2.2 12 2.2 12z"/>' +
    '<circle cx="12" cy="12" r="2.7"/></svg>',
  off:
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.2 12S5.8 5.8 12 5.8 21.8 12 21.8 12 18.2 18.2 12 18.2 2.2 12 2.2 12z"/>' +
    '<circle cx="12" cy="12" r="2.7"/><path d="M4.2 19.8 19.8 4.2"/></svg>',
};

/**
 * 齿轮 —— 记账屏顶部那颗「设置」按钮的图标（⭐ 那颗 `⋯` 换成「[图标] 设置」）。
 *
 */
const GEAR =
  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3.1"/>' +
  '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 ' +
  '1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1' +
  '-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 ' +
  '1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 ' +
  '4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 ' +
  '9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>';

/**
 * 银行徽章**图标文件**的目录（⚠️ 两端不是同一个串）。
 *
 */
const BRAND_DIR = 'modules/ledger/brands/';

/**
 * 本次「加 / 改一个账户」弹窗里的**草稿**（只活在一次弹窗流程里，⛔ 不进 `state`）。
 * @type {?{id: number, kind: string, name: string, tail: string, note: string, opening: string}}
 */
let draft = null;

/**
 * 本次「新建 / 给一套分类改名」的状态（只活在那一次弹窗里）。
 * @type {?{mode: string, id: number}}
 */
let pendingView = null;

/**
 * 上一次绑过事件的那颗 `#ledger-view` 节点（`null` = 还没绑过）。
 *
 */
let ledgerViewNode = null;

/** 弹窗那一侧的委托（`#modal-body` 是静态节点）挂过没有 @type {boolean} */
let ledgerModalBound = false;

/**
 * 本次「新建 / 给一个**用途字段**改名」的行 id（`0` = 新建；只活在那一次弹窗里）。
 * @type {number}
 */
let pendingUsage = 0;

/**
 * 功能：把「生活记账」那一块画出来（取数 + 渲染）—— 由视图片段 `desktop-assets-pane.js` 调用。
 *
 * 那一屏（屏头药丸「生活记账 ｜ 数码管理 ｜ 自建分组」）。所以这里**不再切屏、不再画侧栏**：
 * 骨架（那颗空的 `#ledger-view`）由片段自己造、片段自己插进宿主给的容器。
 * 别把 `showView()` / `renderSidebar()` 加回来：屏名 `ledger` 已从
 */
export async function mountLedger() {
  const box = $('#ledger-view');
  if (box) box.innerHTML = skeletonHtml(3);
  // （「隐藏要具有记忆功能：我隐藏了，下次进入还是隐藏状态。并且
  // 手机端和电脑端同步」）：那颗眼睛的**初值来自账号偏好**（`users.hide_ledger_amount`
  // 经 `/api/auth/me` 下来）—— 每次进屏按它复位，所以「上次藏起来了」下次进来还藏着。
  // 放在**取数之前**：下面每一次 `lgRender()` 都按 `state.lgHide` 画金额，晚一步设
  // 就会先闪一帧"全都露着"的账（防肩窥那件事上，闪一帧就等于没藏）。
  state.lgHide = !!(state.me && state.me.hide_ledger_amount);
  try {
    // 2 期：取名口与 overview **一起发**（两个都是 GET）—— 下面每一次渲染都要用它，
    // 晚一步画出来的就是"已删账户没有名字的那一版"（而它**不报错**，只是看起来像名字丢了）。
    await Promise.all([fetchOverview(), ensureAcctNames()]);
    // 记账 2 期：进来就把「记账」那一侧要用的三份取好 —— 收支分类 / 默认账户 / 这个月的流水。
    // 分类与默认账户**只取一次**（它们只在记账设置里改），而且取不到也**不拦**这一屏画出来
    // （记一笔会再试一次并说清原因）—— 一个可选请求把整屏按住，用户看到的是「记账打不开」。
    await Promise.all([ensureCats(), ensureDefaults()]);
    // 默认那一格是「明细」⇒ 流水与它只在**这一个段**下取。
    // 「进屏时重取」（任务书 §6.5）：各自那一格的数据都要重取，
    // 别只重取流水而让别的格停在上一回那一份（那会显示过期的数，且**不报错**）。
    if (state.lgSeg === 'budget') {
      await openBudget();
    } else if (state.lgSeg === 'bill') {
      // 月详情是「账单」那一格下面的子屏（先判它）
      if (state.lgMdMonth) await loadMonthBill();
      // 账单那一格现在是**两栏**（表格 ＋ 图表）⇒ 进屏两份一起取（见 `loadBillScreen()`）
      else await loadBillScreen();
    } else if (state.lgSeg === 'detail') {
      await loadEntries(true);
    }
    lgRender();
  } catch (e) {
    toast(e.message, true);
    if (box) box.innerHTML = '<div class="es-text">记账读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：`overview` 的地址 —— 带上「图表在看哪一年」（`lgYear` 为 0 = 还没取过 ⇒ 不带参数，
 * 由服务端回「今年」）。
 *
 * 说明：⚠️ 手机端逐字同款（那边叫 `loadLedger()` 里那两行）—— 换年之后每一次写操作的重取
 *
 */
function overviewUrl() {
  const y = Number(state.lgYear) || 0;
  return '/api/ledger/overview' + (y ? '?year=' + y : '');
}

/**
 * 功能：取一次 `overview` 并重画；⭐ 首次加载时顺手把「今年」记进 `state.lgYear`。
 *
 * @returns {Promise.<void>}
 */
async function fetchOverview() {
  const first = !Number(state.lgYear);
  const d = await api('GET', overviewUrl());
  state.lg = d;
  if (first) state.lgYear = Number(String((d && d.today) || '').slice(0, 4)) || 0;
}

/**
 * 功能：重取一次并重画（写操作成功之后走它）。
 *
 * 说明：⭐ **重取而不是就地改**：净值 / 分组小计 / 组内顺序**全是服务端算的** ——
 * @returns {Promise.<void>}
 */
async function lgRefresh() {
  await fetchOverview();
  lgRender();
}

/**
 * 功能：把「金额该带什么符号」从**服务端的 `groups[].side`** 推出来。
 *
 * 说明：⭐⭐ ⛔ 前端**不自己写一份「哪一类是负债」的表**：两份判据必然漂移，而它管的是金额
 * 前面的负号（漂移 = 把「欠 5908」显示成「有 5908」，且**不报错**）。
 * 服务端没给侧的类型（理论上不该有）拿不到侧 ⇒ 不带符号，但**照样画出来**
 */
function sideMapOf(d) {
  const m = new Map();
  for (const g of (d && d.groups) || []) m.set(g.kind, g.side);
  return m;
}

/**
 * 功能：画那颗**眼睛** —— 点一下把所有金额糊成圆点（要的「防肩窥」）。
 *
 * 说明：⚠️ 两态各一个图形（睁眼 = 现在看得见、闭眼 = 已藏起来），⛔ 不靠颜色深浅区分。
 * 它只是**显示层**的开关：金额本来就随 `overview` 下来了，⛔ 别把它当成权限或加密
 * @returns {string} 这一颗按钮的 HTML
 */
function eyeHtml() {
  return `<button class="lg-eye" type="button" data-lg="eye" aria-label="${
    state.lgHide ? '显示金额' : '隐藏金额'
  }" title="${state.lgHide ? '显示金额' : '隐藏金额'}">${state.lgHide ? EYE.off : EYE.on}</button>`;
}

/**
 * 功能：点一下眼睛 —— 翻转只读态、重画，并把这次的选择**记进账号偏好**（两端同步）。
 *
 * （「隐藏要具有记忆功能：也就是我隐藏了，下次进入还是隐藏状态。
 * 并且手机端和电脑端同步」）：从前它只改内存（`state.lgHide`），刷新就回来 —— 于是
 * 「我明明藏起来了，下次进来又全露着」。现在落成 `users.hide_ledger_amount`
 */
function pickEye() {
  state.lgHide = !state.lgHide;
  if (state.me) state.me.hide_ledger_amount = state.lgHide ? 1 : 0;
  api('PUT', '/api/auth/prefs', { hideLedgerAmount: !!state.lgHide }).catch(() => {});
}

/**
 * 功能：画「净值卡」—— 品牌色底、净资产大字，下面两栏资产 / 负债。
 *
 * 说明：⚠️ 卡里那一栏 `负债` **刻意不带负号**（参考图 A 就是 `负债 25908.01`）——
 * 负号出现在**分组列表**里（那里才是「这一组要减掉」的位置）。两端同一个口径。
 * 卡角上那颗眼睛是**全屏的金额开关**（列表 / 分组小计 / 账户行 / 详情 / 弹窗全跟着它）。
 */
function heroHtml(t) {
  return `<div class="lg-hero">
    ${eyeHtml()}
    <span class="lg-hero-cap">净资产</span>
    <b class="lg-hero-num">${esc(fmtFen(t.net_fen, state.lgHide))}</b>
    <div class="lg-hero-cols">
      <div><span>资产</span><b>${esc(fmtFen(t.asset_fen, state.lgHide))}</b></div>
      <div><span>负债</span><b>${esc(fmtFen(t.debt_fen, state.lgHide))}</b></div>
    </div>
  </div>`;
}

/**
 * 功能：画账户的**图标块** —— 认得出银行 / 平台就画文件里的真实标，认不出回落类目那套。
 *
 * 说明：⚠️ 列表行与详情弹窗的头部卡共用它（同一份判据、同一个形状）：⛔ 别在详情里再抄一遍
 * （两处一漂移，同一家银行在列表与详情里长得不一样，而且不报错）。
 *
 */
function icoBlockHtml(a) {
  const ic = iconOf(a.kind, a.name);
  // 有图标文件（真实品牌标）⇒ 浅中性底 + **原色标**（⛔ 不涂白：涂白会把实心圆标变成一块白饼）；
  // 认不出是哪家 ⇒ 回落类目那套「浅底 + emoji」。
  return ic.badge
    ? `<span class="lg-ico lg-bank"><img class="lg-logo" src="${BRAND_DIR}${ic.file}" alt="" /></span>`
    : `<span class="lg-ico" style="--lg-c:${ic.color}">${ic.icon}</span>`;
}

/**
 * 功能：画一个账户行 —— 图标块 ＋ 名称（带后四位）＋ 副标题 ＋ 右侧金额 ＋ 行尾一颗「详情」。
 *
 * 与手机端「整行可点」是**版式差异**，语义（打开同一张详情）完全一致。
 * 行尾那颗从「编辑」改成**「详情」** —— 两端口径统一成「点开账户 = 看详情」，
 * 详情里那颗「编辑」才是改（照参考图 1 的三颗动作）。
 */
function rowHtml(a, sides) {
  const title = a.tail ? `${a.name}(${a.tail})` : a.name;
  return `<div class="lg-row" draggable="true" data-drag="acct" data-did="${Number(a.id)}">
    ${icoBlockHtml(a)}
    <span class="lg-main">
      <b class="lg-name">${esc(title)}</b>
      ${a.note ? `<i class="lg-sub">${esc(a.note)}</i>` : ''}
    </span>
    <b class="lg-amt">${esc(fmtSide(a.opening_fen, sides.get(a.kind), state.lgHide))}</b>
    <button class="btn btn-subtle btn-sm" type="button" data-lg="detail" data-id="${Number(a.id)}">详情</button>
  </div>`;
}

/**
 * 功能：画一个分组 —— 组名 + 组小计（`debt` 侧带 `−`）一行，下面各组内账户。
 *
 *
 * @param {Object} g - `overview.groups` 里的一项（`{kind, side, total_fen, count}`）
 * @param {Array.<Object>} accounts - 全部账户（已按 KINDS 顺序 × 组内 sort_order 排好）
 */
function groupHtml(g, accounts, sides) {
  const m = metaOf(g.kind);
  const rows = accounts
    .filter((a) => a.kind === g.kind)
    .map((a) => rowHtml(a, sides))
    .join('');
  // 组标题可拖（改九类的显示顺序）—— 凭据是 `ledger_groups` 的**行 id**，
  // 由 `overview.kindGroups` 给出（⛔ 不用类目键：那是代码常量，不是能重排的东西）
  const gid = groupIdOf((state.lg && state.lg.kindGroups) || [], g.kind);
  return `<div class="lg-group">
    <div class="lg-ghead"${gid ? ` draggable="true" data-drag="group" data-gid="${gid}"` : ''}><span>${esc(m.name)}</span><b>${esc(fmtSide(g.total_fen, g.side, state.lgHide))}</b></div>
    ${rows}
  </div>`;
}

/**
// ---------- 分类视图（按用途）：顶部胶囊 ＋ 分组列表 ＋ 建 / 改名 / 删 ─────────-

/**
 * 功能：当前这一屏的分类清单（**服务端排好序**的那一份）。
 * @returns {Array.<Object>} `overview.views` 里可用的那几项
 */
function viewList() {
  return ((state.lg && state.lg.views) || []).filter((v) => v && v.id);
}

/**
 * 功能：**表单**里要问「用途」的那几套视图 —— `viewList()` 去掉「按账户类型」（`builtin === 1`）。
 *
 * 说明：⭐⭐ 渲染（`tagFieldsHtml`）与读回（`captureForm`）**必须共用这一份**，
 * 别各写一次 `filter((v) => Number(v.builtin) !== 1)`：**只做一头就出事** ——
 * 画面里没有那一格、读回时却送一个空串上去，而服务端 `store.applyTags()` 对
 */
function tagViewList() {
  return viewList().filter((v) => Number(v.builtin) !== 1);
}

/**
 * 功能：画顶部那排「视图」胶囊 —— 「按账户类型」（内置的那个视图）＋ 各套自定义分类 ＋ 一颗「⋯」。
 *
 * 说明：⭐⭐ 「按账户类型」是**内置视图**（不入库，由 `lib/kinds.js` 决定）；右边那些是用户自己
 * 建的**用途视图**（`ledger_views`）。切换只重画列表、**不重新取数**：
 * `overview` 一次就把所有视图的分组与小计都给了，切视图是纯本地动作。
 */
function viewBarHtml(views, cur) {
  const chip = (id, name, on) =>
    `<button class="lg-vchip${on ? ' on' : ''}" type="button" data-lg="view" data-id="${Number(id)}" draggable="true" data-drag="chip" data-did="${Number(id)}">${esc(name)}</button>`;
  // 内置的两颗（按账户类型 / 按账户用途）**也在 `views` 里**（`builtin` 1 / 2）
  // ⇒ 这一排直接按服务端给的顺序画。⛔ 别再手写一颗「按账户类型」——
  // 写死的话它的位置就永远在最前面，而「胶囊顺序也能拖」这条需求当场作废。
  return `<div class="lg-views">${views
    .map((v) => chip(v.id, v.name, !!cur && Number(cur.id) === Number(v.id)))
    .join('')}<button class="lg-vmore" type="button" data-lg="viewmore" title="管理分类">⋯</button></div>`;
}

/**
 * 功能：按**用途**把账户分组画出来（一套自定义分类下的列表）。
 *
 * 说明：⚠️ **组顺序与小计都是服务端排好、算好的**（`views[].groups`）—— 前端只做**摆放**
 * `fmtFen`（它自己带负号），⛔ 不像类型视图那样按侧补负号。
 * 「其它」＝ 这套分类下**没分**的账户，服务端给的是 `unassigned`；
 */
function tagGroupsHtml(v, accounts, sides) {
  const tagOf = (a) => String(((a.tags || {})[v.id] || '')).trim();
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));
  const rowOf = (a) => rowHtml(a, sides);
  // ：组内的先后**照服务端给的 `ids`** —— 那是这套分类自己的顺序
  // （`ledger_view_tags.sort_order`；服务端算好、前端只摆放，与「排序只有一份实现」一致）。
  // 兜底保留：`ids` 缺了（老响应 / 形状变了）就按「归属相符」过滤 ——
  const rowsOf = (key, ids) =>
    Array.isArray(ids) && ids.length
      ? ids
          .map((id) => byId.get(Number(id)))
          .filter(Boolean)
          .map(rowOf)
          .join('')
      : accounts
          .filter((a) => tagOf(a) === key)
          .map(rowOf)
          .join('');
  // `gid` 有值才可拖：内置「按账户用途」的组有 `ledger_groups` 的行 id（可拖），
  // 自建分类的组身份是**用途名文本**（没有行）⇒ 不给拖拽属性（拖了也没地方存顺序）
  const block = (name, total, rows, gid) => `<div class="lg-group">
    <div class="lg-ghead"${gid ? ` draggable="true" data-drag="group" data-gid="${Number(gid)}"` : ''}><span>${esc(name)}</span><b>${esc(fmtFen(total, state.lgHide))}</b></div>
    ${rows}
  </div>`;
  // 内置「按账户用途」与自建分类**有两种不同的组**——
  // 内置（`builtin = 2`）：组来自 `overview.usages`（**含空组**，那 7 个是「字段」），
  // 而归属那一列存的是**用途键**（`u3`）⇒ 必须用 `usageGroupsOf()` 把键翻成名字；
  const list =
    Number(v.builtin) === 2
      ? usageGroupsOf((state.lg && state.lg.usages) || [], v.groups)
      : (Array.isArray(v.groups) ? v.groups : []).map((g) => ({
          key: g.tag,
          // 自建分类的组身份就是用途名文本；组内顺序同样照服务端给的 ids
          name: g.tag,
          total_fen: g.total_fen,
          ids: g.ids,
        }));
  const out = list.map((g) => block(g.name, g.total_fen, rowsOf(g.key, g.ids), g.id));
  const un = v.unassigned || { total_fen: 0, count: 0 };
  if (Number(un.count) > 0) out.push(block('其它', un.total_fen, rowsOf('')));
  return out.join('');
}

/**
 * 功能：画「管理分类」那一页 —— 各套分类的**改名 / 删除** ＋ 末尾「＋ 新建分类」。
 *
 * 说明：⭐⭐ 分类是**视图**：删掉它**不动任何账户、不改一分钱**（界面文案要把这句说给用户听）。
 * 与「账户弹窗里选分类」分得干干净净：那一屏只负责**选**，建 / 改 / 删都住这一页
 * （退回了一版把两者混在一起的做法 —— 别再把它们塞回去）。
 */
function viewManageHtml() {
  const views = viewList();
  const rows = views
    .map((v) => {
      // 内置那两颗**不给改名 / 删除的按钮**（接口层也会拒）——
      // 画了按钮才 400 是最差的一种：用户以为能改、点了才知道不行。
      const bi = Number(v.builtin) > 0;
      const acts = bi
        ? '<i class="lg-sub">内置</i>'
        : `<button class="btn btn-subtle btn-sm" type="button" data-lg="viewren" data-id="${Number(v.id)}">改名</button>` +
          `<button class="btn btn-danger btn-sm" type="button" data-lg="viewdel" data-id="${Number(v.id)}">删除</button>`;
      return (
        `<div class="lg-krow"><span class="lg-kmain"><b>${esc(v.name)}</b><i class="lg-sub">${Number(
          (v.groups || []).length,
        )} 组 · ${Number((v.unassigned || {}).count) || 0} 个没分</i></span>` +
        acts +
        '</div>'
      );
    })
    .join('');
  // 上限只数**自建**的：内置两颗不占用户的额度
  const full = views.filter((v) => !Number(v.builtin)).length >= VIEW_MAX;
  const newBtn =
    `<button class="lg-kind lg-newkind" type="button" data-lg="viewnew"${full ? ' disabled' : ''}` +
    ` title="${full ? `最多只能建 ${VIEW_MAX} 套分类，先删掉一套` : '建一套新的分类'}">` +
    `${full ? `＋ 新建分类（已满 ${VIEW_MAX} 个）` : '＋ 新建分类'}</button>`;
  return rows + newBtn + usageManageHtml();
}

/** 功能：开「管理分类」弹窗（列表屏那颗「⋯」进来）。 @returns {void} */
function openViewManage() {
  openModal('管理分类', viewManageHtml(), {});
  // 这一页没有「保存」：每颗按钮自己就是一个动作 ⇒ 主按钮是「关闭」
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/** 功能：开「新建分类 / 给这个分类改名」的小弹窗。 @param {string} mode - `'new'` / `'ren'` @param {number} id - 分类 id（改名时用） @returns {void} */
function openViewName(mode, id) {
  const v = viewList().find((x) => Number(x.id) === Number(id));
  if (mode === 'ren' && !v) return;
  pendingView = { mode, id: Number(id) || 0 };
  const name = mode === 'ren' ? v.name : '';
  openModal(
    mode === 'ren' ? '给这个分类改名' : '新建分类',
    `<div class="lg-form"><div class="tt-field"><label for="lg-f-vname">分类名</label>` +
      `<input id="lg-f-vname" type="text" maxlength="${VIEW_NAME_MAX}" value="${esc(name)}" /></div></div>`,
    {},
  );
  setModalSave('保存（Enter）', false);
  $('#modal-save').onclick = saveViewName;
}

/** 功能：存下新建 / 改名的结果，回「管理分类」那一页。 @returns {Promise.<void>} */
async function saveViewName() {
  const el = $('#lg-f-vname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个分类起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const p = pendingView || { mode: 'new', id: 0 };
  try {
    if (p.mode === 'ren') {
      await api('PUT', `/api/ledger/views/${Number(p.id)}`, { name });
    } else {
      const made = await api('POST', '/api/ledger/views', { name });
      // 新建之后**直接切过去**：用户建一套分类就是为了马上按它看
      state.lgView = Number(made.id);
    }
    await lgRefresh();
    openViewManage();
    toast(p.mode === 'ren' ? '改好了' : '分类建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 功能：删一套分类（**危险确认**）—— 文案要说清「账户一个都不会变」。 @param {number} id - 分类 id @returns {void} */
function askRemoveView(id) {
  const v = viewList().find((x) => Number(x.id) === Number(id));
  if (!v) return;
  openConfirmModal(
    '删除这个分类',
    `<div class="lg-danger"><p>删了就找不回来了。⚠️ <b>账户一个都不会变</b> —— 只是以后不能按「${esc(
      v.name,
    )}」分组看了。</p></div>`,
    '永久删除',
    async () => {
      try {
        await api('DELETE', `/api/ledger/views/${Number(id)}`);
        if (Number(state.lgView) === Number(id)) state.lgView = 0;
        closeModal();
        await lgRefresh();
        openViewManage();
        toast('已删除');
      } catch (e) {
        toast(e.message, true);
      }
    },
  );
}


/**
 * 功能：内置「按账户用途」的那些**字段**（服务端排好序的那一份）。
 *
 * 说明：⭐⭐ 它们与「分类」（`ledger_views`）是两样东西：分类是「按什么看」（视图），
 * 用途是**那个视图里一列的取值**（字段）。所以增删改名住这里，⛔ 不去动分类那一块。
 * **顺序不在这里管** —— 拖顺序就是「在列表屏拖组标题」，复用同一套机制
 */
function usageList() {
  return ((state.lg && state.lg.usages) || []).filter((u) => u && u.id);
}

/**
 * 功能：画「管理分类」页里那块**用途字段**区（一个用途定义都没有时整块不画）。
 * @returns {string} 这一块的 HTML
 */
function usageManageHtml() {
  const list = usageList();
  if (!list.length) return '';
  const rows = list
    .map((u) => {
      // 「其它」是**兜底**（那些没分用途的账户唯一的去处）⇒ 不给删除按钮；
      // 接口层也会拒（`locked`），两头一致
      const locked = Number(u.locked) > 0;
      const acts = locked
        ? '<i class="lg-sub">兜底</i>'
        : `<button class="btn btn-subtle btn-sm" type="button" data-lg="usageren" data-id="${Number(u.id)}">改名</button>` +
          `<button class="btn btn-danger btn-sm" type="button" data-lg="usagedel" data-id="${Number(u.id)}">删除</button>`;
      return `<div class="lg-krow"><span class="lg-kmain"><b>${esc(u.name)}</b></span>${acts}</div>`;
    })
    .join('');
  const full = list.length >= USAGE_MAX;
  const newBtn =
    `<button class="btn btn-subtle btn-sm" type="button" data-lg="usagenew"${full ? ' disabled' : ''}>` +
    `${full ? `＋ 新建用途（已满 ${USAGE_MAX} 个）` : '＋ 新建用途'}</button>`;
  return (
    '<div class="lg-subcap"><b>「按账户用途」的字段</b>' +
    '<i class="lg-sub">改名之后，归在这组下面的账户会跟着新名走；顺序在列表里拖动组标题调整</i></div>' +
    rows +
    `<div class="lg-subadd">${newBtn}</div>`
  );
}

/**
 * 功能：新建 / 给某个用途字段改名（同一张小表单）。
 * @param {number} id - 用途字段的行 id（`0` = 新建）
 * @returns {void}
 */
function openUsageName(id) {
  const u = usageList().find((x) => Number(x.id) === Number(id));
  if (Number(id) && !u) return;
  pendingUsage = Number(id) || 0;
  const name = Number(id) ? u.name : '';
  openModal(
    Number(id) ? '给这个用途改名' : '新建用途',
    `<div class="lg-form"><div class="tt-field"><label for="lg-f-uname">用途名</label>` +
      `<input id="lg-f-uname" type="text" maxlength="${TAG_MAX}" value="${esc(name)}" /></div>` +
      // 这句必须写出来：用户最怕的就是「改个名，原来的账户全掉了」
      (Number(id)
        ? '<div class="lg-tip">已经归在这个用途下的账户会<b>跟着新名走</b>，一笔都不会掉。</div>'
        : '') +
      '</div>',
    {},
  );
  setModalSave('保存（Enter）', false);
  $('#modal-save').onclick = saveUsageName;
}

/** 功能：存下新建 / 改名的结果，回「管理分类」那一页。 @returns {Promise.<void>} */
async function saveUsageName() {
  const el = $('#lg-f-uname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个用途起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const id = Number(pendingUsage) || 0;
  try {
    if (id) await api('PUT', `/api/ledger/usages/${id}`, { name });
    else await api('POST', '/api/ledger/usages', { name });
    await lgRefresh();
    openViewManage();
    toast(id ? '改好了' : '用途建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：删一个用途字段（**危险确认**）—— 文案必须说清「那些账户去哪了」。
 * @param {number} id - 用途字段的行 id
 * @returns {void}
 */
function askRemoveUsage(id) {
  const u = usageList().find((x) => Number(x.id) === Number(id));
  if (!u) return;
  openConfirmModal(
    '删除这个用途',
    `<div class="lg-danger"><p>删了就找不回来了。原本归在「${esc(
      u.name,
    )}」下面的账户会<b>挪到「其它」</b>，账户本身一个都不会少。</p></div>`,
    '永久删除',
    async () => {
      try {
        await api('DELETE', `/api/ledger/usages/${Number(id)}`);
        closeModal();
        await lgRefresh();
        openViewManage();
        toast('已删除');
      } catch (e) {
        toast(e.message, true);
      }
    },
  );
}

/**
 * 功能：画账户表单里那几格「分类」（一套分类一格）—— 每套都问「这个账户算哪一类用途」。
 * @param {Object} d - 草稿（`d.tags` 是 `{ <viewId>: <用途> }`）
 * @returns {string} 这几格的 HTML（一套分类都没有时是空串）
 */
function tagFieldsHtml(d) {
  const tags = (d && d.tags) || {};
  // 「按账户类型」那一套**不画这一格**：
  // 账户的类型就是**左边选的那个**（组由 `kind` 决定），给它一格等于把同一个问题问第二遍；
  // 所以从前画了它，用户选「＋ 新建用途…」填完一提交**只会拿到一个报错**。
  return tagViewList()
    .map((v) => tagFieldHtml(v, String(tags[v.id] || '')))
    .join('');
}

/**
 * 功能：画「某个分类下，这个账户算哪一类用途」那一格（账户表单里每套分类一格）。
 *
 * 说明：⚠️ 用途是**从这套分类已有的用途里选**（＋「＋ 新建用途…」与「不分类」）——
 * 结构是「label ＋ 一个可替换的盒子（`#lg-f-tagbox-<id>`）」：选了「＋ 新建用途…」
 * 只换那个盒子里的控件（⛔ 不重画整个弹窗 —— 那会把别的字段与光标一起抹掉）。
 */
function tagFieldHtml(v, cur) {
  return `<div class="tt-field" id="lg-f-tag-${Number(v.id)}wrap">
    <label for="lg-f-tag-${Number(v.id)}" id="lg-f-taglabel-${Number(v.id)}">${esc(v.name)}</label>
    <div id="lg-f-tagbox-${Number(v.id)}">${tagSelectHtml(v, cur)}</div>
  </div>`;
}

/**
 * 功能：画那一格里的下拉（不分类 / 这套分类已有的用途 / ＋ 新建用途…）。
 * @param {Object} v - 一套自定义分类
 * @param {string} cur - 当前用途
 * @returns {string} `<select>` 的 HTML
 */
function tagSelectHtml(v, cur) {
  const one = (val, text) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(text)}</option>`;
  // 内置「按账户用途」的选项来自 `overview.usages`：**值 = 用途键、文字 = 用途名**。
  // （改一次名，归在那组下面的账户会静默掉到「其它」）。
  // 也不给它「＋ 新建用途…」：内置那 7 个是**字段**，增删入口在「管理分类」那一页。
  const builtin = Number(v.builtin) || 0;
  const opts =
    builtin === 2
      ? ((state.lg && state.lg.usages) || []).map((u) => ({ val: String(u.gkey), text: String(u.name) }))
      : (Array.isArray(v.groups) ? v.groups : []).map((g) => ({ val: String(g.tag), text: String(g.tag) }));
  const newOpt = builtin === 2 ? '' : one('__new__', '＋ 新建用途…');
  return `<select id="lg-f-tag-${Number(v.id)}" data-lg="tagsel" data-view="${Number(v.id)}">${one('', '不分类')}${opts
    .map((o) => one(o.val, o.text))
    .join('')}${newOpt}</select>`;
}

/**
 * 功能：在下拉里选了「＋ 新建用途…」⇒ 把**那一格**换成输入框（就地问一句新用途叫什么）。
 * @param {Object} sel - 那个 `<select>` 元素
 * @returns {void}
 */
function askNewTag(sel) {
  const vid = Number(sel && sel.dataset && sel.dataset.view);
  const box = $(`#lg-f-tagbox-${vid}`);
  if (!box) return;
  box.innerHTML = `<input id="lg-f-tagnew-${vid}" type="text" maxlength="${TAG_MAX}" />`;
  const inp = $(`#lg-f-tagnew-${vid}`);
  if (inp) inp.focus();
}

/**
 *
 * 说明：⭐⭐ `资产 | 记账` 是**屏内的两段控件**（C-38），默认落 `记账`（§7.7 /  第 5 条）。
 */
function lgRender() {
  const box = $('#ledger-view');
  if (!box) return;
  const d = state.lg;
  if (!d) return;
  // 左栏（五个入口）＋ 右正文；右下那颗悬浮「＋」（记一笔）住**屏级** —— 见 `paintAssetsFab()`。
  box.innerHTML = `<div class="lg-shell">
    ${segBarHtml()}
    <div class="lg-pane">${lgPaneHtml()}</div>
  </div>`;
  // 「资产」那一格里那颗「＋」＝ **添加账户**（那一格不再有自己的通栏按钮，见 `paintAssetsFab()`）。
  // 「预算」那一格同理 ＝ **添加分类预算**（它的通栏 `＋ 添加分类预算` 一并撤了）。
  paintAssetsFab(state.lgSeg === 'asset' ? 'account' : state.lgSeg === 'budget' ? 'budget' : 'entry');
}

/**
 *
 * 说明：⚠️ 认不出一律回落「明细」（⭐ 它**就是默认格**，T32）—— 与手机端 `segOf()` 逐字同一条口径，
 */
function lgPaneHtml() {
  const k = state.lgSeg;
  // 账单那一格 —— 月详情的判据是 `state.lgMdMonth` **这个值本身**
  // `Number('2026-12')` 是 `NaN`、`if (NaN)` 恒假 ⇒ 这一屏永远画不出来
  // （点了行尾 `›`，请求发了、服务端也回了，屏幕上毫无变化且**不报错**）。
  if (k === 'bill') {
    if (state.lgMdMonth) return monthDetailScreenHtml();
    return billScreenHtml();
  }
  if (k === 'budget') return budgetPaneHtml();
  if (k === 'asset') return assetPaneHtml();
  return detailPaneHtml();
}

/**
 * 功能：画屏内**左侧那一栏** —— 五个入口竖着排（`明细 / 账单 / 预算 / 资产 / 设置`）。
 *
 * 从前它是屏顶那一排横向分段（`.lg-seg2`）＋ 右上两颗按钮，现在整排**竖起来搬到左边**，
 * 形态与「数码管理」那条左栏同源（宽度 / 观感 / 圆角一套）。
 * 「设置」是**第五个入口**（从前是右上角那颗）—— ⛔ 它没有 `data-seg`：
 */
function segBarHtml() {
  const seg = (key, name) =>
    `<button class="lg-side-btn${state.lgSeg === key ? ' on' : ''}" type="button" role="tab" ` +
    `aria-selected="${state.lgSeg === key}" data-lg="seg" data-seg="${key}">${name}</button>`;
  const tabs = SEG_TABS.map((t) => seg(t.key, t.name)).join('');
  return `<div class="lg-side">
      <div class="lg-side-tabs" role="tablist">${tabs}</div>
      <button class="lg-side-btn lg-side-set" type="button" data-lg="ledgerset" title="记账设置">${GEAR}<span>设置</span></button>
    </div>`;
}

/**
 * 功能：把**屏级**那颗悬浮「＋」（`#assets-new`）按当前那一格接上对应的动作。
 *
 * ：它多了**模式** ——
 * `'entry'`（默认）＝ 记一笔；`'account'` ＝ 添加账户（「资产」那一格用它）；
 * `'off'` ＝ 收起（二级屏 / 没有接管者时）。
 */
function paintAssetsFab(mode = 'entry') {
  const f = document.getElementById('assets-new');
  if (!f) return;
  if (mode === 'off') {
    f.classList.add('hidden');
    return;
  }
  // ：
  // 「资产」那一格的主操作改成**这颗悬浮「＋」** —— 它左栏底下原来还压着一条通栏
  // 「＋ 添加账户」，两件事都是"加一个东西"、叠在一起分不清点哪个（`11` 记过）。
  const acct = mode === 'account';
  const bud = mode === 'budget';
  f.classList.remove('hidden');
  f.title = acct ? '添加账户' : bud ? '添加分类预算' : '记一笔';
  f.setAttribute('aria-label', f.title);
  f.onclick = () => (acct ? openForm(0) : bud ? openBudgetAdd() : openEntry());
}

/**
 * 功能：画「资产」那一侧 —— 1 期那个两栏（左台账 ＋ 右图表），**逐字照旧**。
 *
 * 说明：⚠️ 这个函数体就是从 1 期的 `lgRender()` 里原样搬出来的：视图胶囊 / 分组列表 /
 * 右栏图表 / 空态一个都没改 —— 2 期只把它套进「两段控件」里，⛔ 不动资产那半。
 *
 */
function assetPaneHtml() {
  const d = state.lg;
  const t = d.totals || { asset_fen: 0, debt_fen: 0, net_fen: 0 };
  const accounts = Array.isArray(d.accounts) ? d.accounts : [];
  const groups = Array.isArray(d.groups) ? d.groups : [];
  const sides = sideMapOf(d);
  const views = viewList();
  // ：内置「按账户类型」也在 `views` 里（`builtin = 1`）⇒ **统一按 id 找**；
  // 找不到（初值 0 / 刚被别的设备删掉）就回落到它 —— ⛔ 别停在一个不存在的视图上
  // 那个"回落到它"改成**回落到排在最前面的那一个**（「谁在前面，进入的时候
  let cur = views.find((v) => Number(v.id) === Number(state.lgView)) || null;
  if (!cur) {
    cur = views[0] || null;
    state.lgView = cur ? Number(cur.id) : 0;
  }
  const kindView = !cur || Number(cur.builtin) === 1;

  const list = accounts.length
    ? kindView
      ? groups.map((g) => groupHtml(g, accounts, sides)).join('')
      : tagGroupsHtml(cur, accounts, sides)
    : `<div class="es-text">还没有记过账户 —— 先记一个最常见的：现金 / 储蓄卡。</div>`;

  // 电脑端**没有**「资产 / 图表」那颗切换控件：两个视图同时在场，没有"切"这回事
  // （手机端才有 —— 那边一屏放不下两栏）。
  return `<div class="lg-wrap">
    <div class="lg-left">
      ${heroHtml(t)}
      ${viewBarHtml(views, cur)}
      <div class="lg-list">${list}</div>
    </div>
    <div class="lg-right">${chartHtml(d, sides)}</div>
  </div>`;
}


/**
 * 三种口径的文案与顺序（资产 / 负债 / 净资产）。
 *
 */
const RANGES = [
  { key: 'asset', name: '资产', now: '当前资产状况', rank: '资产排行榜', center: '总资产' },
  { key: 'debt', name: '负债', now: '当前负债状况', rank: '负债排行榜', center: '总负债' },
  { key: 'net', name: '净资产', now: '当前净资产状况', rank: '', center: '' },
];

/**
 * 走势图的画布（**电脑端版式**；⚠️ 手机端自己一份 —— 那边一屏窄得多）。
 * `svg` 用 `width:100%; height:auto` + 默认的等比缩放 ⇒ 圆点不会被拉成椭圆。
 */
const TREND_BOX = { w: 760, h: 200, padL: 14, padR: 14, padT: 18, padB: 30 };

/**
 * ：
 * **带纵轴**的那一份画布 —— 只多让出左边那一栏（`padL` 14 → 76），其余逐字同 `TREND_BOX`。
 */
const AXIS_BOX = { w: 760, h: 200, padL: 76, padR: 14, padT: 18, padB: 30 };

/**
 * 纵轴刻度文字的字号（**画布单位**，⛔ 不是屏幕像素）。
 * `svg` 是按容器宽度等比缩放的 ⇒ 它实际看着多大取决于卡片多宽；15 ≈ 缩到 10.5px，
 */
const AXIS_FONT = 15;
/** 环形图的半径与描边宽度（画法住 `calc.js` 的 `donutArcs()`） */
const DONUT_R = 58;
const DONUT_SW = 22;

/**
 * 功能：当前选中的图表口径（认不出回落 `'asset'` —— ⛔ 别停在一个不存在的档上）。
 * @returns {string} `'asset'` | `'debt'` | `'net'`
 */
function rangeOf() {
  const k = String(state.lgRange || '');
  return RANGES.some((r) => r.key === k) ? k : 'asset';
}

/**
 * 功能：图表的三态切换（资产 / 负债 / 净资产）。
 *
 * 说明：⭐ 电脑端**没有**「资产 / 图表」那颗切换控件 —— 这一屏是**两栏同屏**
 *
 * @returns {string} 这一行的 HTML
 */
function rangeBarHtml() {
  const cur = rangeOf();
  const btn = (r) =>
    `<button class="lg-seg-btn${cur === r.key ? ' on' : ''}" type="button" data-lg="range" data-range="${
      r.key
    }" role="tab" aria-selected="${cur === r.key}">${r.name}</button>`;
  return `<div class="lg-seg" role="tablist">${RANGES.map(btn).join('')}</div>`;
}

/**
 * 功能：年度下拉 —— **连续区间**（`pickerYears()`：已知年 ∪ 今天，前后各补 5 / 1 年），降序。
 *
 * 某一年一整年没记账，那一年就选不到；而同一条投诉里「选择月份」已经放开，两处口径必须一致。
 * 为什么不用「今年 ± N 年」一刀切：三方导入的老账（2023 / 2024）会落在区间外 ⇒
 * 那样"导入进来的反而选不到"。取「已知年 ∪ 今天」的 min / max 再各向外补，中间**不留缺口**。
 */
function yearSelectHtml(d) {
  const known = (Array.isArray(d && d.years) ? d.years : []).map((y) => String(y));
  if (state.lgYear) known.push(String(state.lgYear));
  const years = pickerYears(known, todayOf()).sort((a, b) => b - a);
  const want = Number(state.lgYear) || 0;
  const cur = years.indexOf(want) >= 0 ? want : years[0] || 0;
  const opts = years.map((y) => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}年</option>`).join('');
  return `<select id="lg-f-year" aria-label="选择年份">${opts}</select>`;
}

/**
 *
 * **纵坐标** —— 三条虚线 ＋ 左栏三个刻度字，值取**真实数据的顶 / 中 / 底**
 */
function trendCardHtml(geo, series, d) {
  // ：
  // 这一版的**第三变**：三态控件先在卡外（屏顶一排）→ 搬进卡里另起一行 → 最后**取代卡标题**
  // （左三颗按钮 ＋ 右年份下拉，同住 `.lg-ccap` 那一行），与手机端同一条口径。
  const cap = `<div class="lg-ccap">${rangeBarHtml()}${yearSelectHtml(d)}</div>`;
  if (geo.empty) {
    const y = String((d && d.today) || '').slice(0, 4);
    return `<div class="lg-card">${cap}
      <div class="lg-wait">${esc(y)} 年还没有记录 —— 每次改余额都会记下当天那一刻。</div></div>`;
  }
  const b = AXIS_BOX;
  const zero =
    geo.zeroY == null
      ? ''
      : `<line class="lg-tz" x1="${b.padL}" y1="${geo.zeroY}" x2="${b.w - b.padR}" y2="${geo.zeroY}" />`;
  // 纵轴刻度文字靠 `dy` 往下挪半行去**对中那三条线**（`dominant-baseline` 各家实现不一致）；
  // `text-anchor` 住 `app.css` 的 `.lg-tyt`（⛔ 不在模板串里写样式）。
  // ：刻度文字**一次算一整组** ——
  const yLabels = yTickLabels(
    geo.yTicks.map((t) => t.v),
    state.lgHide,
  );
  const yGrid = geo.yTicks
    .map((t) => `<line class="lg-tg" x1="${b.padL}" y1="${t.y}" x2="${b.w - b.padR}" y2="${t.y}" />`)
    .join('');
  const yText = geo.yTicks
    .map(
      (t, i) =>
        `<text class="lg-tyt" x="${b.padL - 8}" y="${t.y}" dy="${(AXIS_FONT * 0.35).toFixed(1)}">${esc(
          yLabels[i],
        )}</text>`,
    )
    .join('');
  const segs = geo.segs.map((p) => `<polyline class="lg-tl" points="${p}" />`).join('');
  const dots = geo.dots
    .map((p) => `<circle class="lg-td${p.open ? ' open' : ''}" cx="${p.x}" cy="${p.y}" r="3.6" />`)
    .join('');
  // 命中圈**画在圆点之后**（它盖在最上面才点得中），而且是 `fill: transparent` 而不是
  // `none` —— `none` 不参与命中测试，那圈就等于不存在（而"点了没反应"不会报错）。
  const hits = geo.dots
    .map(
      (p) =>
        `<circle class="lg-thit" cx="${p.x}" cy="${p.y}" r="12" data-lg="tdot" data-lbl="${esc(
          AXIS_MONTHS[p.i] || '',
        )}" data-v="${Math.trunc(Number(series && series[p.i]) || 0)}" />`,
    )
    .join('');
  const ticks = geo.ticks.map((t) => `<i style="left:${t.pct.toFixed(2)}%">${esc(t.text)}</i>`).join('');
  const only = geo.dots.length === 1 ? '<div class="lg-wait">才记了第一条 —— 再记几天就看得出走势了。</div>' : '';
  return `<div class="lg-card">${cap}
    <div class="lg-trend">
      <svg class="lg-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">${yGrid}${zero}${segs}${dots}${hits}${yText}</svg>
      <div class="lg-axis">${ticks}</div>
      <div class="lg-tpick"></div>
    </div>${only}</div>`;
}

/**
 * 功能：点走势图上某一个点 ⇒ 在横轴下面那一行写「几月 · 多少钱」。
 *
 * 说明：⚠️⭐ 那笔钱是从**命中圈自己带的 `data-v`** 读的（画的时候就写进去了），
 * 而那种错法**不报错**，只是显示成另一个月的钱。
 * 这里用**完整**的 `fmtFen()`（不是纵轴那种 `1.2万`）—— 用户点一个点问的是
 */
function pickTrendDot(n) {
  const card = n.closest('.lg-card');
  const box = card && card.querySelector('.lg-tpick');
  if (!box) return;
  const lbl = String((n.dataset && n.dataset.lbl) || '');
  const fen = Math.trunc(Number((n.dataset && n.dataset.v) || 0)) || 0;
  box.textContent = [lbl, fmtFen(fen, state.lgHide)].join(' · ');
}

/**
 * 功能：「当前资产 / 负债状况」那一块 —— 环形图 ＋ 右侧图例（名称 ＋ 百分比）。
 *
 * 说明：⭐⭐ 环里的项是**类目组**（`d.groups` 按侧筛），⛔ 不是逐个账户 —— 账户的粒度由
 * 排行榜那块负责（两块回答的是不同问题）。
 * 图例**含 0 的项**（那是文字，不是图形）；环里 0 的项不画（`donutArcs()` 已滤）。
 */
function donutBlockHtml(meta, d, sides) {
  const key = rangeOf();
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0 };
  const total = key === 'debt' ? t.debt_fen : t.asset_fen;
  const items = ((d && d.groups) || [])
    .filter((g) => sides.get(g.kind) === key)
    .map((g) => ({ key: g.kind, name: metaOf(g.kind).name, fen: g.total_fen, color: metaOf(g.kind).color }));
  const ring = donutArcs(items, DONUT_R);
  const box = (DONUT_R + DONUT_SW / 2) * 2;
  const mid = box / 2;
  const arcs = ring.arcs
    .map(
      (a) =>
        `<circle class="lg-arc" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke="${a.color}" stroke-width="${DONUT_SW}" stroke-dasharray="${a.len.toFixed(
          2,
        )} ${(ring.c - a.len).toFixed(2)}" stroke-dashoffset="${a.offset.toFixed(2)}" />`,
    )
    .join('');
  const legend = items
    .map(
      (it) =>
        `<div class="lg-lg-row"><i style="--lg-c:${it.color}"></i><span>${esc(it.name)}</span><b>${esc(
          fmtPct(sharePct(it.fen, total)),
        )}</b></div>`,
    )
    .join('');
  return `<div class="lg-donut">
      <div class="lg-ring">
        <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
          <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
          <g transform="rotate(-90 ${mid} ${mid})">${arcs}</g>
        </svg>
        <div class="lg-ring-mid"><i>${esc(meta.center)}</i><b>${esc(fmtFen(total, state.lgHide))}</b></div>
      </div>
      <div class="lg-legend">${legend}</div>
    </div>`;
}

/**
 * 功能：「资产 / 负债」那张**合并卡** —— 上半是环形图 ＋ 图例，下半是排行榜。
 *
 * 说明：⭐ 排行榜的粒度是**账户**，与环形图的「类目」粒度刻意不同（两块回答的是不同问题）。
 * ：
 * 从前这是**两张并排的卡**（`当前资产状况` ｜ `资产排行榜`，住 `.lg-cgrid` 的两列）；
 */
function mergedCardHtml(meta, d, sides) {
  const key = rangeOf();
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0 };
  const total = key === 'debt' ? t.debt_fen : t.asset_fen;
  const rows = rankRows((d && d.accounts) || [], key, sides);
  if (!rows.length) return '';
  const body = rows
    .map((a) => {
      const p = sharePct(a.opening_fen, total);
      // 占比 0 的项**不画填充**（占位 0% 的填充是一条看不见的线，等于给自己加了个假元素）；
      // 账户会画成 0 像素宽、**看着像"漏了它"**（探针里量 `offsetWidth` 才逮住）。
      // 轨道（`.lg-rkb`）照画：它保住行高，也表达"这一项是 0"。
      const fill = p == null || p <= 0 ? '' : `<span style="width:${p.toFixed(2)}%"></span>`;
      return `<div class="lg-rank">
        ${icoBlockHtml(a)}
        <div class="lg-rkm">
          <div class="lg-rkt"><b>${esc(a.name)}</b><i>${esc(fmtPct(p))}</i>
            <b class="lg-rka">${esc(fmtSide(a.opening_fen, key, state.lgHide))}</b></div>
          <div class="lg-rkb">${fill}</div>
          ${a.note ? `<i class="lg-rkn">${esc(a.note)}</i>` : ''}
        </div>
      </div>`;
    })
    .join('');
  // 环形那一块排在**上面**（「饼图显示在【资产排行榜】顶部」）——
  // 它自己不再带标题（原来那句「当前资产状况」随合并去掉），本卡只留一个标题。
  // ：这张卡多一个
  return `<div class="lg-card lg-rankcard"><div class="lg-ccap"><b>${esc(meta.rank)}</b></div>
    ${donutBlockHtml(meta, d, sides)}
    <div class="lg-ranks">${body}</div></div>`;
}

/**
 * 功能：「当前净资产状况」—— 一条「资产 vs 负债」比例对比条 ＋ 四个数。
 *
 * 说明：⭐⭐ 净资产态**不画环形 / 排行榜**：净资产没有"构成"可言，能画的只有"资产与负债
 * 各占多少"这条对比条。⚠️ 两边都是 0 ⇒ 画一条**空的灰条**（⛔ 不是一条 50/50 的假条）；
 *
 */
function netPanelHtml(meta, d) {
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0, net_fen: 0 };
  const pair = ratioPair(t.asset_fen, t.debt_fen);
  const bar = pair
    ? `<div class="lg-nbar">
        <span class="a" style="width:${pair.asset_pct.toFixed(2)}%">${pair.asset_pct >= 10 ? '资产' : ''}</span>
        <span class="d" style="width:${pair.debt_pct.toFixed(2)}%">${pair.debt_pct >= 10 ? '负债' : ''}</span>
      </div>`
    : '<div class="lg-nbar empty"></div>';
  return `<div class="lg-card">
    <div class="lg-ccap"><b>${esc(meta.now)}</b></div>
    <div class="lg-nnums"><b>${esc(fmtFen(t.asset_fen, state.lgHide))}</b><b>${esc(
      fmtFen(t.debt_fen, state.lgHide),
    )}</b></div>
    ${bar}
    <div class="lg-nrow"><span>净资产</span><b>${esc(fmtFen(t.net_fen, state.lgHide))}</b></div>
    <div class="lg-nrow"><span>资产负债率</span><b>${esc(fmtPct(debtRatioPct(t.asset_fen, t.debt_fen)))}</b></div>
  </div>`;
}

/**
 * 功能：右栏整套（三态控件 ＋ 走势 ＋ 构成/对比 ＋ 排行）。
 *
 * 说明：⚠️⭐ 三态共用**同一份 `state.lg`** ⇒ 切口径**只重画、不重新取数**；换**年**才重新取数。
 *
 * @param {Object} d - `state.lg`
 */
function chartHtml(d, sides) {
  const meta = RANGES.filter((r) => r.key === rangeOf())[0] || RANGES[0];
  const rows = Array.isArray(d && d.snapshots) ? d.snapshots : [];
  // 这一串值要**留一份**给走势卡（点某个点时显示那一格的钱）——
  // 从前它只是一个实参，算完几何就没了。⚠️ 画布同时换成带纵轴的 `AXIS_BOX`。
  const series = trendSeries(rows, meta.key);
  const geo = trendGeometry(series, AXIS_BOX);
  const body = meta.key === 'net' ? netPanelHtml(meta, d) : mergedCardHtml(meta, d, sides);
  // 三态控件（`rangeBarHtml()`）**不再排在卡外** —— 它现在由 `trendCardHtml()`
  // 画进那张卡里（紧跟标题行，见那里的说明）。
  return `${trendCardHtml(geo, series, d)}${body}`;
}

/**
 * 功能：切图表的三态（资产 / 负债 / 净资产）—— 同一份数据换个口径看，⛔ 不重新取数。
 * @param {string} k - `'asset'` | `'debt'` | `'net'`
 * @returns {void}
 */
function pickRange(k) {
  state.lgRange = RANGES.some((r) => r.key === k) ? k : 'asset';
  // ：
  // 这颗三态控件**只住在右栏**（`chartHtml()` 那一段）⇒ 切它只需重画右栏。
  // 从前这里走整屏 `lgRender()`：左栏 `.lg-list` 连同它的 DOM 一起被换掉，
  const right = $('#ledger-view .lg-right');
  if (right && state.lg) {
    right.innerHTML = chartHtml(state.lg, sideMapOf(state.lg));
    return;
  }
  lgRender();
}


/**
 *
 * 说明：⚠️ 分类名是**用户自己起的**，认不出是哪一类，所以没有「按名字配真实图标」这回事
 */
const CAT_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899'];

/** 退款/记一笔弹窗里「点开那一刻」的秒（只活在那一次弹窗流程里）。 @type {string} */
let edSec = '00';
/** 正在给哪一笔记退款（0 = 没开退款弹窗）。 @type {number} */
let refundOf = 0;

/**
 * 正在改哪一条流水（`0` = 新建）。
 *
 */
let editId = 0;

/**
 * 功能：本地时钟当前的 `HH:MM` 与 `SS` —— ⚠️ **只用于时间那一格的初值**。
 *
 * 说明：⭐⭐ 秒**必须由前端带上**（服务端只收 `YYYY-MM-DD HH:MM:SS`，它无从知道"用户点开
 * 这一格那一刻"的秒 ——  第 11 条）。日期用**服务端今天**，
 * 分钟用本机时钟（服务端没给"现在几点"）—— 这两件事在报告里写清。
 */
function nowPrefix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { hm: `${p(d.getHours())}:${p(d.getMinutes())}`, ss: p(d.getSeconds()) };
}

/**
 * 功能：取一次收支分类清单（`GET /api/ledger/categories`，两级一次性给全）。
 * @param {boolean} [force] - 为真时不管缓存、重新取一次
 * @returns {Promise.<boolean>} 手上有分类清单返回 true
 */
async function ensureCats(force) {
  if (!force && state.lgCats.length) return true;
  try {
    const r = await api('GET', '/api/ledger/categories');
    state.lgCats = r && Array.isArray(r.categories) ? r.categories : [];
    return true;
  } catch (_e) {
    // 取不到**不抛**：流水列表照样能画（名字降级成「未分类」），记一笔会再试一次并说清原因
    return false;
  }
}

/**
 * 功能：取一次默认账户（`GET /api/ledger/defaults`）—— 记一笔的预填与记账设置都读它。
 * @param {boolean} [force] - 为真时不管缓存、重新取一次
 * @returns {Promise.<boolean>} 手上有默认账户返回 true
 */
async function ensureDefaults(force) {
  if (!force && state.lgDefaults) return true;
  try {
    const r = await api('GET', '/api/ledger/defaults');
    state.lgDefaults = (r && r.defaults) || { income: null, expense: null, categories: [] };
    return true;
  } catch (_e) {
    state.lgDefaults = null;
    return false;
  }
}

/**
 * 功能：把服务端 `GET /defaults` 的响应折成 `pickDefaultAccount()` 要的行形状。
 *
 * 说明：⚠️ 这一步**只做形状转换**，⛔ 不重排取值顺序 —— 顺序只住 `entry-calc.js` 那一处
 * （类别 → 全局（按收/支）→ 空账户）。
 * @returns {Array.<{kind: string, category_id: number, account_id: ?number}>} 三级的行
 */
function defaultsRows() {
  const d = state.lgDefaults || {};
  const rows = [
    { kind: 'income', category_id: 0, account_id: d.income == null ? null : Number(d.income) },
    { kind: 'expense', category_id: 0, account_id: d.expense == null ? null : Number(d.expense) },
  ];
  for (const c of d.categories || []) {
    rows.push({
      kind: 'category',
      category_id: Number(c.category_id),
      account_id: c.account_id == null ? null : Number(c.account_id),
    });
  }
  return rows;
}

/**
 * 本次会话里 `GET /api/ledger/account-names` 的那一份结果（⭐ 2 期补上的取名口）。
 *
 */
let acctNameCache = null;

/**
 * 功能：取一次取名口（`GET /api/ledger/account-names`）并记进 `acctNameCache`。
 *
 * 说明：⭐⭐ 失败**绝不拦这一屏**：退回「只有活账户」那一份（与没有这条接口时的行为逐字一样），
 * 但**如实记一次**（`console.warn`）—— ⛔ 不静默吞掉（静默的表现是"已删账户的名字时有时无"，
 * 没人查得出来）；⚠️ 也 ⛔ **不弹红 toast** 打扰（这是"取名字"没取到，不是用户动作失败）。
 */
async function ensureAcctNames() {
  try {
    const r = await api('GET', '/api/ledger/account-names');
    acctNameCache = (r && r.names) || {};
    return true;
  } catch (e) {
    acctNameCache = null;
    console.warn('[ledger] 账户名没取到，退回「只有活账户」那一份：', e && e.message);
    return false;
  }
}

/**
 * 功能：账户 id → 显示名的映射 —— ⭐ **取值顺序只住这一处**：先活账户（`overview.accounts[]`），
 * 查不到再查那份合并视图（已删账户的原名 / 空账户的「不关联」）。
 *
 * 而漂移的表现是"同一个账户，在流水里显示得出名字、在转账明细里显示不出来"（C-8 的同一条理由）。
 * 空账户在库里叫「空账户」，而界面上它代表**「不关联」** —— 这个转换住**服务端那条接口**
 */
function acctNameMap() {
  const m = new Map();
  for (const a of (state.lg && state.lg.accounts) || []) m.set(Number(a.id), labelOf(a));
  for (const [k, v] of Object.entries(acctNameCache || {})) {
    const id = Number(k);
    if (!m.has(id)) m.set(id, String(v));
  }
  return m;
}

/** 功能：流水该看哪个月 —— 空串时取**服务端今天那个月**（⛔ 不用本机时钟）。 @returns {string} @since */
function monthKey() {
  return String(state.lgMonth || '').trim() || monthOf((state.lg && state.lg.today) || '');
}

/** 功能：账户详情那一屏该看哪个月（同上）。 @returns {string} @since */
function chgMonthKey() {
  return String(state.lgChgMonth || '').trim() || monthOf((state.lg && state.lg.today) || '');
}

/** 功能：把月份记进「这次会话见过的月」清单（下拉要把访问过的月留住）。 @param {string} m - 月份键 @returns {void} @since */
function rememberMonth(m) {
  const v = String(m || '').trim();
  if (!/^\d{4}-\d{2}$/.test(v) || state.lgMonths.includes(v)) return;
  state.lgMonths.push(v);
}

/**
 * 功能：这个月下拉的选项 —— **有记录的月 ∪ 服务端今天那个月**（§7.3）。
 *
 * 说明：⭐⭐ 「有记录的月」服务端**没有**一条接口给（报告里的阻塞项）⇒ 只能拿
 * `overview.snapshots` 里出现过的月（每次写操作都落当天快照 ⇒ 是"真实用过"的近似）
 * ∪ 今天那个月 ∪ **本次会话访问过的月**。⚠️ 清单一律来自**真实数据**（monthOptions
 */
function entryMonthOptions() {
  const todayMonth = monthOf((state.lg && state.lg.today) || '');
  const rows = (state.lgEntries || []).concat((state.lg && state.lg.snapshots) || []);
  const set = new Set(monthOptions(rows, todayMonth));
  for (const m of state.lgMonths) set.add(m);
  set.add(monthKey());
  return [...set]
    .filter((k) => /^\d{4}-\d{2}$/.test(k))
    .sort()
    .reverse();
}

/**
 * 功能：取一页流水（`GET /api/ledger/entries`）—— 按月 ＋ **游标**，一次 30 条。
 *
 * 说明：⭐⭐ 分页⛔ **不用 offset**（C-15 /  第 3 条）：游标是**不透明串**，先
 * `parseCursor()` 验一次形状再发 —— 认不出就当"没有游标"（＝从头取这一页），
 * 绝不把一个猜出来的值发上去（那会**静默翻错页**，而界面上看不出任何异常）。
 */
async function loadEntries(reset) {
  if (reset) {
    state.lgEntries = [];
    state.lgCursor = null;
    state.lgDone = false;
    // 换月 / 重试要把上一个月那两个合计**一起清掉**：不清的话明细屏顶行还挂着上月的数
    // （而列表已经是新的那一个月）—— 那是"数字看着没毛病、其实对的是另一个月"。
    state.lgSum = null;
    state.lgDayTotals = null;
    // 上一个月那份**导入行**也要一起清—— 它是**服务端按月一次性
    // 给全**的（不分页），留着的话「新一个月还没回来」的那一瞬间，明细屏会拿上个月的导入行
    // 去配这个月的标题（与上面那两组合计同一条理由，而且**不报错**）。
    impRows = [];
  }
  state.lgLoad = 'loading';
  state.lgErr = '';
  lgRender();
  const month = monthKey();
  const cur = parseCursor(state.lgCursor);
  let url = `/api/ledger/entries?month=${encodeURIComponent(month)}&limit=${ENTRY_PAGE_SIZE}`;
  if (cur) url += `&before=${encodeURIComponent(buildCursor(cur.at, cur.id))}`;
  try {
    const r = await api('GET', url);
    const rows = r && Array.isArray(r.entries) ? r.entries : [];
    state.lgEntries = reset ? rows : state.lgEntries.concat(rows);
    // 摘要覆盖**整月、与翻页无关**（服务端算的是 `at <= now` 的整月合计）⇒ 每一页的响应
    // 都带同一份，后到的覆盖先到的没有坏处（月没变，那份数就没变）。
    state.lgSum = (r && r.summary) || null;
    state.lgDayTotals = (r && r.dayTotals) || null;
    // 三方导入：导入行**搭同一个响应**回来（`imported`，该月
    // **全部**行、不分页）⇒ ⛔ 绝不为它再发第二个请求。
    // 一律**整份替换**（`impRows = r.imported`），⛔ **绝不 `concat`** —— 这一份与
    if (r && Array.isArray(r.imported)) impRows = r.imported;
    state.lgDone = rows.length < ENTRY_PAGE_SIZE;
    const last = rows[rows.length - 1];
    state.lgCursor = state.lgDone || !last ? null : buildCursor(last.at, last.id);
    rememberMonth(month);
    state.lgLoad = 'done';
  } catch (e) {
    state.lgLoad = 'error';
    state.lgErr = e.message;
    // 读不到 ⇒ 顶上那两个数画 `—`（⛔ 不拿上一个月 / 上一回那一份兜着 —— 三态必须分得开）
    state.lgSum = null;
    state.lgDayTotals = null;
  }
  lgRender();
}

/**
 * 星期几的中文单字（`getDay()` 的 0~6 ⇒ 日 ~ 六）。
 *
 */
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 功能：把 `YYYY-MM-DD` 写成明细屏的**组标题**「09月19日 星期六」（认不出就把原串照显）。
 *
 * 说明：⭐ 版式权威是参考图 1 / 图 8（两处都是 `09月19日 星期六` / `09月22日 星期二`）——
 * **月、日补零**、后面跟一个「星期X」。
 * 星期用**本地时区**的 `getDay()`：与 `at` 的写法是同一条尺子（`at` 本来就按本地
 */
function dayHeadLabel(date) {
  const s = String(date || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${m[2]}月${m[3]}日 星期${WEEK_CN[d.getDay()]}`;
}

/** 功能：把时刻串截成「09-22 14:30」（给明细行当副标题用）。 @param {string} at - 时刻 @returns {string} @since */
function shortAt(at) {
  const s = String(at || '');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.slice(5, 16) : s.slice(0, 10);
}

/**
 * 功能：流水列表那一块（⭐ **明细屏**的主体）—— 三态分得开：读取中 / 读不到 ＋ 重试 / 这个月没有。
 *
 * 说明：⭐⭐ 「读取中」「这个月一笔都没有」「没读到」是三件不同的事 —— 把失败画成空态
 * 等于把错误藏起来（用户会以为"我确实没记过账"）。
 * 按天分组走 `entry-calc.js` 的 `groupByDay()`（两端同一套：天倒序、天内 `(at, id)` 倒序）。
 */
function entryGroupsHtml() {
  if (state.lgLoad === 'error') {
    return (
      `<div class="lg-errbox"><div class="es-text">流水没读到 —— ${esc(
        state.lgErr || '原因不明',
      )}。这不等于「一笔都没有」。</div>` +
      '<button class="btn btn-subtle btn-sm" type="button" data-lg="entryretry">重试</button></div>'
    );
  }
  if (state.lgLoad === 'loading' && !state.lgEntries.length) return '<div class="lg-txwait">正在读取…</div>';
  // 「这个月还没有」的判据是**两边都空**：只有自有流水那一边空、
  // 而导入行还有几条时，那不是"没有"，是"有这个月的账、只是它们是导进来的"。
  if (!state.lgEntries.length && !impRows.length) {
    return '<div class="lg-txwait">这个月还没有记过账 —— 点顶部那颗「＋ 记一笔」记一笔。</div>';
  }
  const names = acctNameMap();
  const totals = state.lgDayTotals || {};
  // **按天混排** —— 天的集合 = 自有流水 ∪ 导入行（两边并集），倒序；
  // 同一天里**自有流水在前、导入行在后**（各自保持服务端给的次序）。
  // （「加载更多」是往它后面 `concat` 的）—— 把导入行塞进去、翻一页再重画一遍，
  const days = new Map();
  for (const g of groupByDay(state.lgEntries, 'at')) {
    days.set(g.date, { date: g.date, items: g.items, imported: [] });
  }
  for (const r of impRows) {
    const day = String((r && r.at) || '').slice(0, 10);
    const key = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
    let g = days.get(key);
    if (!g) {
      g = { date: key, items: [], imported: [] };
      days.set(key, g);
    }
    g.imported.push(r);
  }
  return [...days.values()]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
    .map((g) => {
      // 小计一律来自服务端（`dayTotals`）—— 按 `YYYY-MM-DD` 取，取不到就两个 0
      // 加进这个小计一次（那会把同一天的钱**算两遍**，而且它不报错）。
      const t = totals[g.date] || { income_fen: 0, expense_fen: 0 };
      const inc = Number(t.income_fen) || 0;
      const exp = Number(t.expense_fen) || 0;
      // 修订（「移除所有的退款红色字体 …… 退款不算入退款当天收支小计
      // 里面，是在原消费那一条里用红色字体写：某月某号已退款 金额」）：
      // ⇒ 每天小计旁边**不再有**那一栏「退款」，右上角只剩收入与支出两个数。
      const sum = [`收入: ${fmtFen(inc, state.lgHide)}`, `支出: ${fmtFen(exp, state.lgHide)}`].join('　');
      const head = `<div class="lg-eday"><b>${esc(g.date ? dayHeadLabel(g.date) : '时刻缺失')}</b><span>${esc(
        sum,
      )}</span></div>`;
      // ：**每一天那一组**
      // 包进一张白底圆角卡片（`.lg-ecard`，版式在 `desktop/app.css`）—— 从前这些行
      // 直接铺在页面的灰底上、全靠一条条细线分隔，一整屏看下来是一大片没有边界的灰。
      return `<div class="lg-ecard">${head}${g.items
        .map((e) => entryRowHtml(e, names))
        .join('')}${g.imported.map(impRowHtml).join('')}</div>`;
    })
    .join('');
}

/**
 * 功能：画一条流水 —— **分类小图标** ＋ 分类名（没选就「未分类」）＋ 备注 / 账户名 ＋ 金额，
 * 退款行带「退款」字样。
 *
 * 说明：⚠️ 那颗小图标是**零出网**的「色块 ＋ 首字」（照「记一笔」的分类网格那套，
 * 本期不取图标文件）—— 色值走 `catColorOf()`（判据只住一处，⛔ 别在这里再 `%` 一遍）。
 */
function entryRowHtml(e, names) {
  const parts = [];
  if (e.note) parts.push(String(e.note));
  const an = names.get(Number(e.account_id));
  if (an) parts.push(an);
  // 修订：原交易那一行上的小字改成**带日期**的
  // 「9月30日已退款 127.50」（原来只显示累计金额「退款 ¥127.50」）。
  // 它**不进 `parts`**（那一串会被整体 `esc()` 掉）—— 它要**红字**，所以单独画一个
  const rf = refundNoteOf(e, state.lgEntries, state.lgHide);
  // 退款条目**自己也在列表里**（单独占一行，C-24）⇒ 那一行标题带「退款」字样；
  const act = isRefund(e)
    ? ''
    : `<button class="btn btn-subtle btn-sm" type="button" data-lg="refund" data-id="${Number(e.id)}">记退款</button>`;
  // 分类小图标：色块 ＋ 首字（零出网，照）—— 名字走 `catName()`（「未分类」是它给的词），
  // 不在这里再判一次 `category_id` 有没有值（那是 `catName()` / `entryTitle()` 的事）。
  const cname = catName(e.category_id, state.lgCats);
  const ch = String(cname || '').trim().slice(0, 1) || '·';
  const ico = `<span class="lg-eico" style="--lg-c:${catColorOf(e.category_id)}">${esc(ch)}</span>`;
  // 行**本身**是一个动作（`erow` ⇒ 开条目详情）：挂在同一个 `[data-lg]` 委托上，
  // 由 `n.dataset.lg` 分派 ⇒ 点「记退款」时 `closest()` 先命中那颗按钮（`act === 'refund'`），
  // 点别处才命中这一行。⚠️ 刻意**不用** `stopPropagation`：委托里那样写不生效，
  return `<div class="lg-erow${isRefund(e) ? ' refund' : ''}" data-lg="erow" data-id="${Number(e.id)}">
    ${ico}
    <span class="lg-emain"><b class="lg-etitle">${esc(entryTitle(e, state.lgCats))}</b>${
      parts.length ? `<i class="lg-sub">${esc(parts.join(' · '))}</i>` : ''
    }${rf ? `<i class="lg-rfnote">${esc(rf)}</i>` : ''}</span>
    <b class="lg-eamt">${esc(fmtSignedFen(signedFen(e.ie, e.amount_fen), state.lgHide))}</b>
    ${act}
  </div>`;
}

/**
 * 功能：列表底下那条「加载更多」（到底了 / 读不到时整条不画）。
 * @returns {string} 这一段的 HTML
 */
function entryMoreHtml() {
  if (state.lgLoad === 'loading' && state.lgEntries.length) return '<div class="lg-txwait">正在读取…</div>';
  if (state.lgLoad !== 'done' || state.lgDone) return '';
  return '<div class="lg-emorewrap"><button class="btn btn-subtle btn-sm" type="button" data-lg="entrymore">加载更多</button></div>';
}

/** 功能：滚到底自动取下一 30 条的节流闸门（同一次滚动只发一次）。 @type {boolean} */
let moreBusy = false;

/**
 * 功能：这一屏**当前真正的滚动容器**。
 *
 * 改成**两段式**（固定头 ＋ 内部滚动区，见 `app.css` 的 `#assets-view` 那一段）——
 * 工具条与月份卡不再滚，真正滚的是流水列表 `.lg-elist`。
 * ⇒ 判据不能再看死 `.main`（它现在压根不滚）。
 */
function scrollHost() {
  return document.querySelector('#ledger-view .lg-elist') || document.querySelector('.main');
}

/**
 * 功能：滚到列表底部时自动「加载更多」（§7.3）；不满足条件时什么都不做。
 *
 * 说明：⚠️ 主区的滚动容器是 `index.html` 里的 `.main`（不是窗口）—— 挂在窗口上永远不触发。
 * 它同时是「底下的按钮」那条路的孪生入口：两条路都走 `loadEntries(false)`。
 * 明细那一格改成两段式之后，真正在滚的是 `.lg-elist` ⇒ 容器由
 */
function maybeLoadMore(ev) {
  if (moreBusy) return;
  // 流水列表**只住在「明细」那一格**（流水整块归它）⇒ 只有停在
  // 明细**且没进那两个子屏**（账单 / 月详情）时才自动翻页 —— 在别的屏上滚到底去取流水，
  // 用户看不到任何变化（那一页被追加进一份没人看的列表）。
  const onPane = state.view === 'assets' && state.assetsPane === 'ledger';
  if (!onPane || state.lgSeg !== 'detail') return;
  if (state.lgMdMonth) return;
  if (state.lgLoad !== 'done' || state.lgDone || !state.lgCursor || modalOpen()) return;
  const host = scrollHost();
  if (!host) return;
  // 捕获监听会收到所有后代的滚动 —— 只认真正那个滚动容器自己发的那一条
  if (ev && ev.target && ev.target !== host) return;
  if (host.scrollTop + host.clientHeight < host.scrollHeight - 240) return;
  moreBusy = true;
  loadEntries(false).finally(() => {
    moreBusy = false;
  });
}

/** 功能：账户详情那条「加载更多」的节流闸门（与 `moreBusy` 同一套：同一次滚动只发一次）。 @type {boolean} */
let chgBusy = false;

/**
 * 功能：`.main` 那条 `scroll` 挂了没有 —— ⚠️ 它**常驻**（不随这一屏重画换节点）⇒ 只准挂一次。
 *
 * 说明：`bindLedgerEvents()` 正常只被调一次（`desktop/app.js` 启动时），但万一将来有第二个调用点，
 * 没有这个闸门就是"滚一次触发两次取数"（多发的那些请求还会把同一页数据追加两遍）。
 * @type {boolean}
 */
let mainScrollBound = false;

/**
 * 功能：详情弹窗滚到底时自动取下一 30 条变动（按钮那条路的孪生入口，两条路都走 `loadChanges(false)`）。
 *
 * 说明：⚠️ 弹窗这一侧的滚动容器是 `#modal-body`（`.modal-card` 有 `max-height: 88vh`
 * 而 `.modal-body` 是 `overflow-y: auto`）—— ⛔ 别挂在 `window` 或 `.main` 上。
 * @returns {void}
 */
function maybeLoadChgMore() {
  if (chgBusy) return;
  if (!modalOpen() || !state.lgAcctId) return;
  if (state.lgChgLoad !== 'done' || state.lgChgDone || !state.lgChgCursor) return;
  const box = $('#modal-body');
  if (!box) return;
  if (box.scrollTop + box.clientHeight < box.scrollHeight - 240) return;
  chgBusy = true;
  loadChanges(false).finally(() => {
    chgBusy = false;
  });
}

/**
 * 功能：点了一颗备注候选 —— 填进备注框（⛔ 不关弹窗、⛔ 不自动提交），并把候选重筛一遍。
 * @param {string} note - 候选备注
 * @returns {void}
 */
function edPickNote(note) {
  const el = $('#lg-ed-note');
  if (!el) return;
  el.value = String(note || '');
  if (state.lgDraft) state.lgDraft.note = el.value;
  paintNoteChips();
  el.focus();
}

/** 功能：只重画备注候选那一条（⛔ 不重画整张弹窗 —— 会把别的格里打的字与光标一起抹掉）。 @returns {void} @since */
function paintNoteChips() {
  const box = $('#lg-ed-notewrap');
  if (box) box.innerHTML = noteChipsHtml();
}

/** 功能：取备注输入框里当前的片段（弹窗还没画出来时是空串）。 @returns {string} @since */
function noteText() {
  const el = $('#lg-ed-note');
  return el ? String(el.value || '') : '';
}

/**
 * 功能：画备注历史候选那几颗小胶囊（`matchNote` 做**本地即时过滤**）。
 *
 * 说明：⭐⭐ 候选**来源只住服务端**（`GET /api/ledger/notes?category=`， 第 1 条 / C-17）
 * `matchNote()` 只回答"服务端给回来的这 20 条里，哪几条还要显示"。
 * @returns {string} 候选那一段的 HTML
 */
function noteChipsHtml() {
  const text = noteText();
  const list = (state.lgNotes || []).filter((n) => matchNote(text, n));
  if (!list.length) return '';
  return list
    .map((n) => `<button class="lg-notechip" type="button" data-lg="ednote" data-note="${esc(n)}">${esc(n)}</button>`)
    .join('');
}

/**
 *
 * 一律写在 `<label>` 里：placeholder 是**写死的示例文字**，它不随收支 / 分类变，
 */
function edHtml() {
  const d = state.lgDraft || {};
  // 退款条目：**只能改金额与备注**（收/支方向由 `refund_of` 那笔原交易决定，分类与账户沿用原交易，
  // 时间是原交易那笔退款发生的时间）—— 服务端的 `PUT /entries/:id` 对退款条目也按这个方向走。
  if (d.refund) return edRefundHtml(d);
  const seg = (key, name) =>
    `<button class="lg-seg-btn${d.ie === key ? ' on' : ''}" type="button" role="tab" aria-selected="${
      d.ie === key
    }" data-lg="edie" data-ie="${key}">${name}</button>`;
  return `<div class="lg-ed">
    <div class="lg-edtop">
      <div class="lg-seg" role="tablist">${seg('支出', '支出')}${seg('收入', '收入')}</div>
      <button class="btn btn-subtle btn-sm" type="button" data-lg="edcancel">取消</button>
    </div>
    ${edGridHtml()}
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-acct">账户</label>
      <select id="lg-ed-acct">${acctOptionsHtml(d.acctId)}</select>
      <label class="lg-edlab" for="lg-ed-amt">金额</label>
      <input id="lg-ed-amt" type="text" inputmode="decimal" value="${esc(d.amount)}" />
    </div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-note">备注</label>
      <input id="lg-ed-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" />
      <label class="lg-edlab" for="lg-ed-time">时间</label>
      <input id="lg-ed-time" type="datetime-local" step="60" value="${esc(d.dt)}" title="时间可以改；秒按点开那一刻记" />
    </div>
    <div id="lg-ed-notewrap">${noteChipsHtml()}</div>
  </div>`;
}

/**
 * 功能：画「改一笔」在**退款条目**上的那一版表单（只有金额与备注两格）。
 *
 * 说明：⭐⭐ 为什么单独一版而不是把别的格藏起来：藏起来的格在 `edCapture()` 那里
 * 「读到 null ⇒ 当成没改」还算安全，但**看得见的那半**会误导 —— 用户会以为
 * 分类 / 账户 / 时间都能改，改完提交却一点用没有（服务端按 `refund_of` 的方向走）。
 */
function edRefundHtml(d) {
  return `<div class="lg-ed">
    <div class="lg-edtop">
      <b class="lg-edttl">退款记录</b>
      <button class="btn btn-subtle btn-sm" type="button" data-lg="edcancel">取消</button>
    </div>
    <div class="lg-edcap2">这是退款记录，只能改<b>金额</b>与<b>备注</b> —— 收支方向、分类与账户都跟着原交易走。</div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-amt">金额</label>
      <input id="lg-ed-amt" type="text" inputmode="decimal" value="${esc(d.amount)}" />
      <label class="lg-edlab" for="lg-ed-note">备注</label>
      <input id="lg-ed-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" />
    </div>
    <div id="lg-ed-notewrap">${noteChipsHtml()}</div>
  </div>`;
}

/**
 * 功能：画分类那一片（第一屏＝一级网格 / 第二屏＝某个一级下面的二级）。
 *
 * 说明：⭐⭐ **只铺一级**：点了某个一级才出第二屏 —— 于是快路径
 * 仍是「金额 → 选一级 → 完成」三步。⚠️ 二级**可不选**⇒ 第二屏里
 * 点「‹ 返回」就停在那个一级上（流水只挂一级是合法的）。
 */
function edGridHtml() {
  const d = state.lgDraft || {};
  if (d.second) {
    const parent = state.lgCats.find((c) => Number(c.id) === Number(d.second));
    // 「哪几条是它的小分类」这条判据**只准住 `childCats()` 一处**（与手机端 / 分类管理共用），
    // 别在这里再手写一遍 `filter(!archived && parent_id === …)`。
    const kids = childCats(state.lgCats, d.second);
    const rows = kids.length
      ? kids.map(catBtnHtml).join('')
      : '<div class="lg-txwait">这个分类没有下一级 —— 直接点「‹ 返回」就行。</div>';
    return `<div class="lg-edgrid-wrap">
      <div class="lg-edcap"><button class="btn btn-subtle btn-sm" type="button" data-lg="edback">‹ 返回</button>
        <b>${esc(catName(parent || null, state.lgCats))}</b>
        <i>选二级（可以不选）</i></div>
      <div class="lg-edgrid">${rows}</div>
    </div>`;
  }
  // 「哪几条是一级」同样只准住 `topCats()`（见上一条注释）
  const cats = topCats(state.lgCats, d.ie);
  const un =
    `<button class="lg-cat lg-cat-un${d.catId == null ? ' on' : ''}" type="button" data-lg="edcat" data-cid="0">` +
    `<span class="lg-cat-ico">—</span><span class="lg-cat-name">${CAT_UNCLASSIFIED}</span></button>`;
  return `<div class="lg-edgrid-wrap"><div class="lg-edgrid">${un}${cats.map(catBtnHtml).join('')}</div></div>`;
}

/**
 * 功能：画一颗分类按钮（**零出网**：内置色块 ＋ 名字首字，照 1 期回落那套）。
 * @param {Object} c - 一个分类（`{id, name, parent_id}`）
 * @returns {string} 这颗按钮的 HTML
 */
function catBtnHtml(c) {
  const d = state.lgDraft || {};
  const on = Number(d.catId) === Number(c.id);
  // 局部变量**改名成 `more`**：`hasKids` 是 `entry-calc.js` 那份唯一判据的名字，
  const more = hasKids(state.lgCats, c.id);
  const color = CAT_COLORS[Math.abs(Number(c.id) || 0) % CAT_COLORS.length];
  const ch =
    String(c.name || '')
      .trim()
      .slice(0, 1) || '·';
  return (
    `<button class="lg-cat${on ? ' on' : ''}" type="button" data-lg="edcat" data-cid="${Number(c.id)}">` +
    `<span class="lg-cat-ico" style="--lg-c:${color}">${esc(ch)}</span>` +
    `<span class="lg-cat-name">${esc(c.name)}</span>` +
    `${more ? '<i class="lg-cat-more">›</i>' : ''}</button>`
  );
}

/**
 * 功能：画账户选择器里的选项 —— 第一项是**「不关联」**（＝空账户，T3-g /  第 14 条）。
 *
 * 說明：⚠️⭐ 这里**仍然**用**空值**表达"不关联"，由服务端按 `account_id: null` **落到空账户**上
 * （routes.js 的校验表：`null` ⇒ 落空账户）—— 判据在服务端，前端不猜一个 id。
 * 2 期补上取名口（`account-names`）之后，空账户的 id 确实查得到了，但这条路径**不改成**
 */
function acctOptionsHtml(sel) {
  const one = (v, t, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(t)}</option>`;
  const out = [one('', '不关联', !Number(sel))];
  for (const a of (state.lg && state.lg.accounts) || []) {
    out.push(one(String(Number(a.id)), labelOf(a), Number(sel) === Number(a.id)));
  }
  return out.join('');
}

/**
 * 功能：把「记一笔」弹窗上填的值读回草稿。
 *
 * 说明：⚠️ 选择器**必须带 `#`**：写成裸 id 会被 `$()` 当成标签名 ⇒ 恒回 `null` ⇒
 * @returns {void}
 */
function edCapture() {
  const d = state.lgDraft;
  if (!d) return;
  const amt = $('#lg-ed-amt');
  if (amt) d.amount = String(amt.value || '').trim();
  const note = $('#lg-ed-note');
  if (note) d.note = String(note.value || '').trim();
  const acct = $('#lg-ed-acct');
  if (acct) d.acctId = Number(acct.value) || 0;
  const tm = $('#lg-ed-time');
  if (tm && tm.value) d.dt = String(tm.value);
}

/** 功能：把「记一笔」弹窗按草稿重画一遍（换收支 / 点分类 / 返回都要走它）。 @returns {void} @since */
function paintEd() {
  // 标题按"这次是新建还是改"来定（同一个弹层、同一份表单）：改一笔时写「改一笔」，
  // ：走**中等宽度**那一档
  // （`opts.mid` ⇒ 620px）。⚠️ 为什么不用现成的 `wide`（760px）：这一屏的主体是
  openModal(editId ? '改一笔' : '记一笔', edHtml(), { mid: true });
  setModalSave(editId ? '保存' : '完成', false);
  $('#modal-save').onclick = saveEntry;
}

/**
 * 功能：打开「记一笔」—— 建一份草稿、把默认账户取出来、画弹窗，并去拉一次备注候选。
 *
 * 说明：⭐ 账户**按类别 → 全局（按收/支）→ 空账户**预填，取值顺序只住 `entry-calc.js` 的
 * `pickDefaultAccount()`—— ⛔ 这里不写第二份 if/else。
 * 时间预置"点开那一刻"：日期＝**服务端今天**，时:分＝本机时钟，秒留着提交时补。
 */
async function openEntry(prefill) {
  // 这一趟是**新建**（⛔ 别让上一次「改一笔」留下的 id 跟过来 —— 那会把新账改到旧账上）
  editId = 0;
  // **AI 确认卡上点「修改」会带着预填进来**（走下面那个 p）。
  // 仍然是这一张表单、这一条创建路径 —— ⛔ 不为 AI 另画第二份「记一笔」。
  const p = prefill && typeof prefill === 'object' ? prefill : null;
  const ok = await ensureCats();
  if (!ok || !state.lgCats.length) {
    toast('收支分类没读到，点左下角「↻ 刷新」再试一次', true);
    return;
  }
  await ensureDefaults();
  const today = (state.lg && state.lg.today) || '';
  const { hm, ss } = nowPrefix();
  edSec = ss;
  state.lgDraft = {
    ie: p && (p.ie === '收入' || p.ie === '支出') ? p.ie : '支出',
    amount: p && p.amount != null ? String(p.amount) : '',
    catId: p && Number(p.catId) ? Number(p.catId) : null,
    acctId: 0,
    note: p && p.note != null ? String(p.note) : '',
    dt: p && p.dt ? String(p.dt) : today ? `${today}T${hm}` : '',
    second: 0,
  };
  state.lgDraft.acctId =
    p && p.acctId != null && Number(p.acctId) > 0
      ? Number(p.acctId)
      : pickDefaultAccount({
          defaults: defaultsRows(),
          categoryId: state.lgDraft.catId,
          ie: state.lgDraft.ie,
          emptyAccountId: 0,
        });
  state.lgNotesCat = null;
  state.lgNotes = [];
  paintEd();
  loadNotes(null);
}

/**
 * 功能：从**别的屏**（首页看板那颗悬浮 ＋）直接开「记一笔」—— 记账数据没取过就先补一次。
 *
 * 记账屏可能从来没打开过，这时 `state.lg` 还是 null，而 `openEntry()` 要拿
 * `state.lg.today` 预置弹层里「时间」那一格 ⇒ 少了这一步，那一格是**空的**
 * （不报错，只是用户得自己填 —— 而它是必填）。
 */
export async function openLedgerEntry(prefill) {
  if (!state.lg) {
    try {
      await fetchOverview();
    } catch (_e) {
      // 取不到就让 `openEntry()` 去说原因（它会 `ensureCats()` 并 toast 一句人话）
    }
  }
  await openEntry(prefill);
}

/**
 *
 * 而「记一笔」这张表单的字段、校验、落库全在记账自己手里 —— AI 那边只负责把
 */
export function bindAiProposalEdit() {
  if (bindAiProposalEdit._bound) return;
  bindAiProposalEdit._bound = true;
  document.addEventListener('zx:ai-proposal-edit', (e) => {
    const d2 = e && e.detail;
    if (!d2 || String(d2.kind || '') !== 'ledger_proposal') return;
    const items = Array.isArray(d2.items) ? d2.items : [];
    if (!items.length) return;
    d2.handled = true;
    const it = items[0] || {};
    const prefill = {
      ie: String(it.ie || '') === '收入' ? '收入' : '支出',
      amount: it.amount == null ? '' : String(it.amount),
      catId: Number(it.category_id) || 0,
      acctId: Number(it.account_id) || 0,
      note: it.note == null ? '' : String(it.note),
      dt: atInput(it.at),
    };
    void openLedgerEntry(prefill).then(() => {
      if (items.length > 1) toast(`这张卡有 ${items.length} 笔，先给你开了第一笔`);
    });
  });
}

/**
 * 功能：`datetime-local` 要的值（`YYYY-MM-DDTHH:MM`）—— 从服务端那条流水的 `at` 折过来。
 *
 * 说明：⚠️ 形状不对（脏数据 / 老库）一律回**空串**：宁可让那一格空着、提交时拦住
 * （「时间没填全」），⛔ 也别拼一个"看着像"的时刻 —— 那会把一条记录的日期悄悄改掉。
 * @param {string} at - `'YYYY-MM-DD HH:MM:SS'`
 */
function atInput(at) {
  const s = String(at == null ? '' : at);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.slice(0, 10)}T${s.slice(11, 16)}` : '';
}

/**
 * 功能：这一条流水当前的账户在下拉里对应哪一个值（`0` = 不关联）。
 *
 * 说明：⭐⭐ 下拉里只有**活账户** + 「不关联」（`acctOptionsHtml`）—— 而一条账的 `account_id`
 * 可能是**空账户**（「不关联」在库里的落点）或**已删账户**。那两种在下拉里
 * 用户只想改个备注，提交里却每次都多带一个 `account_id`（逐键提交当场失效，
 */
function liveAcctOf(e) {
  const id = Number(e && e.account_id) || 0;
  if (!id) return 0;
  const live = ((state.lg && state.lg.accounts) || []).some((a) => Number(a.id) === id);
  return live ? id : 0;
}

/**
 * 功能：开「改一笔」—— ⭐ **复用**「记一笔」那张表单（同一份 `state.lgDraft` / `edHtml()`）。
 *
 * 说明：⭐⭐  的纪律：⛔ 不另画第二份表单（两份必然漂移）。这里只做三件事：
 * ① 把原条目**灌进草稿**（分类 / 账户 / 金额 / 备注 / 时间 ＋ `ie`）＋ 记一份 `orig` 快照；
 * ② 把秒定成**原条目的秒**（⛔ 不用"现在"的秒 —— 用户只想改金额，不该顺手把时间戳改掉）；
 */
async function openEntryEdit(id) {
  const rid = Number(id) || 0;
  const e = state.lgEntries.find((x) => Number(x.id) === rid);
  if (!e) {
    toast('这条记录不在了，刷新一下再看', true);
    return;
  }
  const ok = await ensureCats();
  if (!ok || !state.lgCats.length) {
    toast('收支分类没读到，点左下角「↻ 刷新」再试一次', true);
    return;
  }
  await ensureDefaults();
  editId = rid;
  // 秒取**原条目的秒**（秒不可调）—— 用户没动时间 ⇒ `edAt()` 拼回来
  // 与原来逐字相同 ⇒ 逐键提交不会带上 `at`（时间戳纹丝不动）。
  edSec = String(e.at || '').slice(17, 19) || '00';
  const cid = e.category_id == null || Number(e.category_id) === 0 ? null : Number(e.category_id);
  const cat = cid == null ? null : state.lgCats.find((c) => Number(c.id) === cid) || null;
  const pid = cat && Number(cat.parent_id) > 0 ? Number(cat.parent_id) : 0;
  const amount = fenToInput(e.amount_fen);
  const acctId = liveAcctOf(e);
  const refund = isRefund(e);
  state.lgDraft = {
    ie: e.ie,
    amount,
    catId: cid,
    acctId,
    note: String(e.note || ''),
    dt: atInput(e.at),
    second: pid,
    // 退款条目：表单只留金额与备注两格（见 `edHtml()`）
    refund,
    // 逐键提交的对照物：**全部归一化过**（分类 null / 账户折成下拉值 / 金额折成输入框那个样子）
    orig: {
      at: String(e.at || ''),
      ie: e.ie,
      amount,
      cid,
      aid: acctId,
      note: String(e.note || ''),
    },
  };
  state.lgNotesCat = cid;
  state.lgNotes = [];
  paintEd();
  loadNotes(cid);
}

/**
 * 功能：换「支出 / 收入」—— 重取默认账户，并清掉另一侧的类别。
 * @param {string} ie - `'支出'` / `'收入'`
 * @returns {void}
 */
function edPickIe(ie) {
  const d = state.lgDraft;
  if (!d || (ie !== '支出' && ie !== '收入')) return;
  edCapture();
  if (d.ie !== ie) {
    d.ie = ie;
    // 分类是按收 / 支分的 ⇒ 换一边就清掉（⛔ 别把一个支出分类挂到收入那一笔上）
    d.catId = null;
    d.second = 0;
    // 改了**只影响这一次**，⛔ 不回写默认
    d.acctId = pickDefaultAccount({ defaults: defaultsRows(), categoryId: null, ie, emptyAccountId: 0 });
  }
  paintEd();
}

/**
 * 功能：点了一个分类（`0` = 「未分类」）—— 记进草稿、重取默认账户、必要时出第二屏。
 * @param {string} raw - 分类 id 的字符串（`'0'` = 未分类）
 * @returns {void}
 */
function edPickCat(raw) {
  const d = state.lgDraft;
  if (!d) return;
  edCapture();
  const cid = Number(raw) || 0;
  if (!cid) {
    // 「未分类」是**正经选择**：显示成「未分类」，⛔ 不是「其它」（C-32）
    d.catId = null;
    d.second = 0;
  } else {
    d.catId = cid;
    // 「它有没有下一级」走 `hasKids()`（唯一判据）—— 与 `childCats()` 同一份过滤，
    // 各写一份就会出现「进了第二屏、里面是空的」（用户点了个不确定的东西，界面还不报错）
    // ：
    if (!d.second) d.second = hasKids(state.lgCats, cid) ? cid : 0;
  }
  d.acctId = pickDefaultAccount({ defaults: defaultsRows(), categoryId: d.catId, ie: d.ie, emptyAccountId: 0 });
  paintEd();
  loadNotes(d.catId);
}

/**
 * 功能：拉一次备注历史候选（按当前类别过滤；没选类别就取全部）。
 *
 * 说明：⭐ 候选**只由服务端给**（⛔ 前端不 `distinct`）；读不到就**不给候选**，
 * 但⛔ 绝不因此拦着记账本身（那是一个可有可无的便利）。
 * @param {?number} catId - 当前类别（`null` = 全部类别）
 */
async function loadNotes(catId) {
  state.lgNotesCat = catId == null ? null : Number(catId);
  try {
    const q = state.lgNotesCat == null ? '' : `?category=${state.lgNotesCat}`;
    const r = await api('GET', `/api/ledger/notes${q}`);
    state.lgNotes = Array.isArray(r && r.notes) ? r.notes : [];
  } catch (_e) {
    state.lgNotes = [];
  }
  paintNoteChips();
}

/**
 * 功能：把 `datetime-local` 的值（`YYYY-MM-DDTHH:MM`）拼成服务端要的 `YYYY-MM-DD HH:MM:SS`。
 *
 * 说明：⭐ 秒**由前端补**（`edSec` ＝ 点开那一刻的真实秒）：控件只到分钟、秒不可调
 * —— 所以"秒"这件事只能在提交这一步补上，⛔ 不改用户改过的日期与时刻。
 * @param {Object} d - 草稿
 */
function edAt(d) {
  const v = String((d && d.dt) || '').replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return '';
  return `${v}:${String(edSec || '00').padStart(2, '0')}`;
}

/**
 * 功能：提交「记一笔 / 改一笔」—— ⛔ 金额 / 金额边界的校验交给服务端（唯一一份判据）。
 *
 * 说明：⭐ 新建与修改**共用这一张表单**，只有两处分叉（`editId`）：调 `POST` 还是 `PUT`、
 * 整份提交还是逐键提交。⛔ 别为「改一笔」另起一条渲染路径 —— 两份表单必然漂移。
 * @returns {Promise.<void>}
 */
async function saveEntry() {
  const d = state.lgDraft;
  if (!d) return;
  edCapture();
  if (!d.amount) {
    toast('填一下金额（可以是 0）', true);
    const el = $('#lg-ed-amt');
    if (el) el.focus();
    return;
  }
  // 改一笔：走下面那条**逐键**的路（见 `saveEntryEdit`）
  if (editId) return saveEntryEdit(d);
  const at = edAt(d);
  if (!at) {
    toast('时间没填全', true);
    return;
  }
  try {
    await api('POST', '/api/ledger/entries', {
      at,
      ie: d.ie,
      amount: d.amount,
      category_id: d.catId == null ? null : Number(d.catId),
      // 空值 ⇒ 服务端落到**空账户**上（「不关联」就是它）
      account_id: d.acctId ? Number(d.acctId) : null,
      note: d.note,
    });
    closeModal();
    state.lgDraft = null;
    // 记完**重取**：余额 / 净值是服务端算的，在本地跟着改一遍就是第二套算术；
    // 流水也从第一页重取（新记的那笔要在最上面）
    await fetchOverview();
    await loadEntries(true);
    toast('记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：提交「改一笔」—— ⭐⭐ **只带变化了的那些键**（照 `submitDefaults()` 那套纪律）。
 *
 * 说明：⭐⭐ `PUT /api/ledger/entries/:id` 是**逐键语义**（服务端只收请求里真带了的键）——
 * 把整份表单原样提交就等于每次都重写一遍时间与金额，而用户可能只是来改个备注：
 * 表现上"也对"，所以最难发现；
 */
async function saveEntryEdit(d) {
  // 拿 id 之前先确认那条还在手上（可能在另一台设备上被删了 / 翻页之后不在了）
  const e = state.lgEntries.find((x) => Number(x.id) === Number(editId));
  if (!e) {
    editId = 0;
    state.lgDraft = null;
    closeModal();
    toast('这条记录不在了，刷新一下再看', true);
    return;
  }
  const o = d.orig || { at: '', ie: '', amount: '', cid: null, aid: 0, note: '' };
  const body = {};
  if (!d.refund) {
    // 时间只有**真改了**才带上：秒是原条目的秒，所以没动过时它逐字相同
    const at = edAt(d);
    if (!at) {
      toast('时间没填全', true);
      return;
    }
    if (at !== o.at) body.at = at;
    if (d.ie !== o.ie) body.ie = d.ie;
  }
  if (String(d.amount || '') !== String(o.amount || '')) body.amount = String(d.amount || '');
  if (!d.refund) {
    const cid = d.catId == null ? null : Number(d.catId);
    if (cid !== (o.cid == null ? null : Number(o.cid))) body.category_id = cid;
    const aid = d.acctId ? Number(d.acctId) : 0;
    if (aid !== Number(o.aid)) body.account_id = aid ? aid : null;
  }
  if (String(d.note || '') !== String(o.note || '')) body.note = String(d.note || '');
  if (!Object.keys(body).length) {
    editId = 0;
    state.lgDraft = null;
    closeModal();
    toast('没有改动');
    return;
  }
  const rid = Number(editId);
  try {
    await api('PUT', `/api/ledger/entries/${rid}`, body);
    editId = 0;
    state.lgDraft = null;
    closeModal();
    // 与「记一笔」同款：余额 / 净值 / 当天快照都是服务端算的⇒ 重取，不在本地改
    await fetchOverview();
    await loadEntries(true);
    toast('改好了');
  } catch (e) {
    toast(e.message, true);
  }
}


/**
 * 功能：画「条目详情」的正文 —— 分类名 / 金额 / 账户名 / 时间 / 备注 ＋ 三颗动作。
 *
 * 分类名走 `entryTitle()`（退款条目自带「退款」字样 —— C-24 的单一行标题口径）；
 * 金额走 `fmtSignedFen(signedFen(…))` 并**把「眼睛」传下去**（漏一处的表现是
 * "屏上还剩一个数没糊"，而且不报错 —— 全屏的金额掩码必须覆盖这一屏）；
 */
function entryDetailHtml(e) {
  const cat = entryTitle(e, state.lgCats);
  const amount = fmtSignedFen(signedFen(e.ie, e.amount_fen), state.lgHide);
  const an = acctNameMap().get(Number(e.account_id)) || '—';
  const refund = isRefund(e);
  const row = (k, v) => `<div class="lg-edtl-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  let say = '';
  if (refund) {
    const o = state.lgEntries.find((x) => Number(x.id) === Number(e.refund_of));
    say = o
      ? `<div class="lg-edtl-say">这是「<b>${esc(entryTitle(o, state.lgCats))}</b>」的退款。</div>`
      : '<div class="lg-edtl-say">这是给一笔原交易记的退款（原交易不在当前这一页）。</div>';
  }
  const acts = [
    `<button class="btn btn-subtle" type="button" data-lg="ededit" data-id="${Number(e.id)}">编辑</button>`,
    `<button class="btn btn-danger" type="button" data-lg="edel" data-id="${Number(e.id)}">删除</button>`,
  ];
  // 画了按钮才报错是最差的一种：用户以为能退，点下去才知道不行。
  if (!refund) {
    acts.push(
      `<button class="btn btn-subtle" type="button" data-lg="refund" data-id="${Number(e.id)}">记退款</button>`,
    );
  }
  return `<div class="lg-edtl">
    <div class="lg-edtl-rows">
      ${row('分类', cat)}
      ${row('金额', amount)}
      ${row('账户', an)}
      ${row('时间', String(e.at || ''))}
      ${row('备注', String(e.note || '') || '（没填）')}
    </div>
    ${say}
    <div class="lg-dacts">${acts.join('')}</div>
  </div>`;
}

/**
 * 功能：点一行流水 ⇒ 开「条目详情」。
 *
 * 说明：⚠️ 数据取自**手上这一页**（`state.lgEntries`）—— 点得到的那一行必然在里面，
 * 所以不为它单发一次请求（与「点开账户详情才去取明细」不同：那条明细压根不在手上）。
 * 找不到（另一台设备刚删了 / 列表刚被重取）就明说，⛔ 别开一张空弹窗。
 */
function openEntryDetail(id) {
  const rid = Number(id) || 0;
  const e = state.lgEntries.find((x) => Number(x.id) === rid);
  if (!e) {
    toast('这条记录不在了，刷新一下再看', true);
    return;
  }
  openModal('条目详情', entryDetailHtml(e), {});
  // 三颗动作**都住正文里**（照本文件账户详情 `detailHtml()` 的先例）：`#modal-save`
  // 只有一个位置，而这里要的是「编辑 / 删除 / 记退款」三个各不相同的动作
  // ⇒ 主按钮退化成「关闭」（与「管理分类」那一页同款）。
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：删一条流水（**二次确认**）—— 照本文件删账户 / 归档分类那几处的确认手法（`openConfirmModal`）。
 *
 * 说明：⭐⭐ 文案逐字对应服务端的真实行为（`store.ledgerDeleteEntry`）：
 * 普通条目：`删除后不能恢复。`；⚠️ 若它名下**已经记过退款**（`refund_fen > 0`），
 * 再加一句 `它名下已记的退款会一起删掉。` —— 服务端在一个事务里连退款一起删，
 */
function askRemoveEntry(id) {
  const e = state.lgEntries.find((x) => Number(x.id) === Number(id));
  if (!e) return;
  const txt = isRefund(e)
    ? '这是退款记录，删掉它不会影响原交易。'
    : `删除后不能恢复。${Number(e.refund_fen) > 0 ? '它名下已记的退款会一起删掉。' : ''}`;
  openConfirmModal(
    '删除这条记录',
    `<div class="es-text">${esc(txt)}</div>`,
    '永久删除',
    async () => {
      await api('DELETE', `/api/ledger/entries/${Number(id)}`);
      closeModal();
      // 删完**重取**：余额 / 净值 / 当天快照全是服务端算的，流水也从第一页重取
      await fetchOverview();
      await loadEntries(true);
      toast('删掉了');
    },
  );
}

/**
 * 功能：开「记退款」弹窗 —— 给这一笔原交易退一笔（`POST /api/ledger/entries/:id/refunds`）。
 *
 * 说明：⭐ 账户与类别**默认沿用原交易**（钱退回原卡、类别不变，C-25）⇒ 这里只问金额 / 时间 / 备注，
 * 「累计 ≤ 原额」由**服务端**在一个事务里判（C-13），前端不预判、不重复实现。
 * @param {number} id - 原交易的 id
 */
function openRefund(id) {
  const rid = Number(id) || 0;
  const e = state.lgEntries.find((x) => Number(x.id) === rid);
  if (!e) return;
  refundOf = rid;
  const today = (state.lg && state.lg.today) || '';
  const { hm, ss } = nowPrefix();
  edSec = ss;
  // 预填**还能退多少**（原额 − 已退），而不是原额：已经退过一部分时预填原额会直接撞上限
  const left = Math.max(0, Math.trunc(Number(e.amount_fen) || 0) - Math.trunc(Number(e.refund_fen) || 0));
  openModal(
    '记退款',
    `<div class="lg-ed">
      <div class="lg-edcap2">给「${esc(entryTitle(e, state.lgCats))}」退款 —— 这笔会作为<b>收入</b>加回原账户。</div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-rfamt">退款金额</label>
        <input id="lg-ed-rfamt" type="text" inputmode="decimal" value="${esc(fenToInput(left))}" />
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-rftime">时间</label>
        <input id="lg-ed-rftime" type="datetime-local" step="60" value="${esc(today ? `${today}T${hm}` : '')}" />
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-rfnote">备注</label>
        <input id="lg-ed-rfnote" type="text" maxlength="${NOTE_MAX}" />
      </div>
    </div>`,
    {},
  );
  setModalSave('确认退款', false);
  $('#modal-save').onclick = saveRefund;
}

/**
 * @returns {Promise.<void>}
 */
async function saveRefund() {
  const aid = Number(refundOf) || 0;
  if (!aid) return;
  const amtEl = $('#lg-ed-rfamt');
  const tmEl = $('#lg-ed-rftime');
  const noteEl = $('#lg-ed-rfnote');
  const amount = String((amtEl && amtEl.value) || '').trim();
  const at = edAt({ dt: tmEl ? tmEl.value : '' });
  const note = String((noteEl && noteEl.value) || '').trim();
  if (!amount) {
    toast('填一下退款金额', true);
    if (amtEl) amtEl.focus();
    return;
  }
  if (!at) {
    toast('时间没填全', true);
    return;
  }
  try {
    await api('POST', `/api/ledger/entries/${aid}/refunds`, { at, amount, note });
    closeModal();
    // 顺带把详情弹窗也刷一遍（退款会作为一条记账出现在原账户的明细里）——
    // 若当前正开着某个账户详情，光标停在那一侧也能看到新的一行。
    await fetchOverview();
    await loadEntries(true);
    toast('退款记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 功能：画记账设置里某个下拉的选项。 @param {number} sel - 当前账户 id（0 = 没设） @param {boolean} allowEmpty - 允不允许「跟随全局默认」 @returns {string} @since */
function defOptions(sel, allowEmpty) {
  const one = (v, t, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(t)}</option>`;
  const out = [];
  if (allowEmpty) out.push(one('', '跟随全局默认', !Number(sel)));
  for (const a of (state.lg && state.lg.accounts) || []) {
    out.push(one(String(Number(a.id)), labelOf(a), Number(sel) === Number(a.id)));
  }
  return out.join('');
}

/**
 *
 * 说明：⭐⭐ 「设置增加二级菜单，现在要滑动到底很不方便」——
 */
function setHomeHtml(plain) {
  const items = SET_PAGES.map(
    (p) =>
      `<button class="lg-setitem" type="button" data-lg="setgo" data-page="${p.key}">` +
      `<span class="lg-setitem-main"><b>${esc(p.name)}</b><i>${esc(p.desc)}</i></span>` +
      '<span class="lg-setitem-go" aria-hidden="true">›</span></button>',
  ).join('');
  // `plain` = **设置页那一栏**要的那一份 —— 那一栏自己已经有标题（`settingsPane.label`）
  // ⇒ ⛔ 不重复画「记账设置」那句小标题。弹窗里那一份照旧带标题。
  if (plain) return `<div class="lg-setlist">${items}</div>`;
  return `<div class="lg-set">
    <div class="lg-setcap"><b>记账设置</b><i>记账时按这里预填账户；分类改完当场生效。</i></div>
    <div class="lg-setlist">${items}</div>
  </div>`;
}

/**
 * 功能：画设置**子页**的正文（含顶上那颗「‹ 设置」返回）。
 *
 * （【收支账户】那一页改成"换值即提交"之后也没有可保存的东西了）——
 * 返回**不占主按钮**：那是"上一层"，不是"确认"。
 * 认不出就回空串（调用方已过 `setPageOf()` 一道），⛔ 别回落某一页。
 */
function setPageBodyHtml(page) {
  let body = '';
  if (page === 'acct') body = setAcctHtml();
  else if (page === 'cat') body = setCatHtml();
  else if (page === 'imp') body = setImpHtml();
  else if (page === 'exp') body = setExpHtml();
  if (!body) return '';
  return `<div class="lg-set">
    <button class="lg-setback" type="button" data-lg="setback">‹ 设置</button>
    ${body}
  </div>`;
}

/**
 * 功能：画设置子页【收支账户】—— 默认收入 / 支出两行 ＋「每种类别的默认账户」的按需列表。
 *
 * 说明：⚠️ 全局两行（收入 / 支出）**只改不删**⇒ 界面上**不画删除按钮**
 * （画了才 400 是最差的一种：用户以为能删）；每类别那一层可以回到「跟随全局默认」＝清掉它。
 * 那两个 `<select>` 的 id（`lg-def-income` / `lg-def-expense`）与每类别那排的
 */
function setAcctHtml() {
  const d = state.lgDefaults || { income: null, expense: null, categories: [] };
  const rows = (d.categories || [])
    .map((x) => {
      const c = state.lgCats.find((y) => Number(y.id) === Number(x.category_id));
      // 认不出那一行（分类被硬删、而默认账户那一行还在）就**不画** —— 画一行没有名字的下拉
      // 比不画更糟；真正的清理在服务端（删分类会连带清掉它的默认账户行）。
      if (!c) return '';
      return (
        `<div class="lg-setrow"><span class="lg-setname">${esc(catFullName(state.lgCats, c))}</span>` +
        `<select data-lg="defacct" data-cid="${Number(c.id)}">${defOptions(x.account_id, true)}</select>` +
        `<button class="btn btn-subtle btn-sm lg-setx" type="button" data-lg="setdefclear" ` +
        `data-cid="${Number(c.id)}" title="清掉这个类别的默认账户">✕</button></div>`
      );
    })
    .join('');
  return `<div class="lg-setcap"><b>收支账户</b><i>记账时的默认账户，记账时自动选择，可以更改。</i></div>
    <div class="lg-setrow"><span class="lg-setname">默认收入账户</span><select id="lg-def-income">${defOptions(d.income, false)}</select></div>
    <div class="lg-setrow"><span class="lg-setname">默认支出账户</span><select id="lg-def-expense">${defOptions(d.expense, false)}</select></div>
    <div class="lg-setcap2">每种类别的默认账户</div>
    <div class="lg-setsub">给单个类别设置独立的默认账户。</div>
    ${rows || '<div class="lg-txwait">还没给任何类别单设。</div>'}
    <div class="lg-setadd"><button class="btn btn-subtle btn-sm" type="button" data-lg="setdefadd">＋ 新增</button></div>`;
}

/**
 * 功能：画设置子页【收支分类】—— 一级 / 二级分类的管理（建 / 改名 / 归档 / 恢复 / 删除 / 恢复内置）。
 *
 * 说明：⚠️ 这一页里每个动作都是**当场生效**的（建 / 改名 / 归档 / 恢复 / 删除 / 恢复内置）⇒ **没有**保存。
 * 标题用 `.lg-catman-cap`（桌面端这一块固有的那一套）—— ⛔ 别换成 `.lg-setcap`：
 * 两者字号 / 间距不同，换过去这一页的标题就与内容对不齐了。
 */
function setCatHtml() {
  // ：那两颗主操作搬到**最前面** ——
  // 紧跟在上面那条「‹ 设置」之后、正文标题之前（从前它们住在栏底，得滑到底才看得见）。
  return `${catTopActionsHtml()}<div class="lg-catman-cap"><b>收支分类</b><i>记账时从这些分类里挑：一级下面还能建二级（比如「餐饮 › 早餐」）。归档只是把它收起来 —— 已经记过的账、名字都照旧，只是以后选不到了。</i></div>
    ${catManageHtml()}`;
}

/**
 * 功能：画设置子页【导入三方数据】—— 那两块说明 ＋「鲨鱼记账」那一行 ＋ 概况。
 *
 * 说明：⚠️ 概况是三态（正在读取 / 读不到 / 有数）—— 由 `impSummaryHtml()` 一处画，
 * 进弹窗与这一页的重画都走同一个函数（⛔ 不在这里另判一遍三态）。
 * @returns {string} 这一页的 HTML
 */
function setImpHtml() {
  return `<div class="lg-imp-cap"><b>导入三方数据</b><i>${IMP_HELP}</i></div>
    <div class="lg-setrow"><span class="lg-setname">${IMP_LABEL}</span>
      <button class="lg-impbtn" type="button" data-lg="impopen">导入</button></div>
    ${impSummaryHtml()}`;
}

/**
 * 功能：画设置子页【导出数据】—— ① 导什么（多选）② 开始 / 结束时间 ③「导出」。
 *
 * 说明：⭐⭐ 三条硬口径：
 * **导什么**取自 `EXPORT_WHATS`（`calc.js` 的唯一出处）—— 勾几样就**下几个文件**
 * （⛔ 不引 zip、⛔ 不引 Blob），每次一个 `.csv`；
 */
function setExpHtml() {
  const keys = expWhatKeys();
  const applies = expRangeApplies(keys);
  const rows = EXPORT_WHATS.map(
    (w) =>
      `<label class="lg-expitem"><input type="checkbox" data-lg="expwhat" data-key="${esc(w.key)}"${
        keys.includes(w.key) ? ' checked' : ''
      }><span class="lg-expname">${esc(w.name)}</span><i class="lg-expdesc">${esc(w.desc)}</i></label>`,
  ).join('');
  return `<div class="lg-setcap"><b>导什么</b><i>勾选要导出的数据</i></div>
    ${rows}
    ${expDateRowHtml('lg-exp-from', '开始时间', expFromOf(), applies)}
    ${expDateRowHtml('lg-exp-to', '结束时间', expToOf(), applies)}
    ${
      applies
        ? ''
        : '<div class="lg-expnote">导出「账户余额」不看时间 —— 它导的是账户此刻的余额。</div>'
    }
    <div class="lg-expgo"><button class="btn lg-expbtn" type="button" data-lg="expdl">导出</button></div>`;
}

/**
 * 功能：导出页当前勾中的几样 —— ⭐ **按 `EXPORT_WHATS` 的顺序**并滤掉认不出的键（判据只住这一处）。
 * @returns {Array.<string>} 勾中的 `what` 键（顺序固定）
 */
function expWhatKeys() {
  const raw = Array.isArray(state.lgExportWhat) ? state.lgExportWhat : [];
  return EXPORT_WHAT_KEYS.filter((k) => raw.includes(k));
}

/**
 * 功能：这一份**时间范围**对勾中的内容**有没有意义** —— ⭐ 只要勾了「账户余额」以外的一样，就有。
 *
 * 说明：⚠️ 「账户余额」是**此刻**的余额，没有时间这一说 ⇒ 只勾它时那两颗日期框要禁用
 * （画成不可选 ＋ 一句人话，⛔ 不是静默忽略）。
 * @param {Array.<string>} keys - 勾中的几样
 */
function expRangeApplies(keys) {
  return keys.some((k) => k !== 'accounts');
}

/**
 * 功能：一样导出内容的**显示名**（确认文案与提示里要用）。
 * @param {string} what - `EXPORT_WHATS` 的 key
 * @returns {string} 显示名
 */
function expWhatName(what) {
  const w = EXPORT_WHATS.find((x) => x.key === what);
  return (w && w.name) || String(what || '');
}

/**
 * 功能：导出的接口地址（⭐ 下载走**浏览器导航**，⛔ 不用 fetch + Blob）。
 *
 * （它没有时间这一维）。
 * @param {string} what - 导什么
 * @param {string} from - 开始日期 `YYYY-MM-DD`（空串 = 不限）
 */
function expUrlOf(what, from, to) {
  let u = `${BASE}/api/ledger/export?what=${encodeURIComponent(what)}`;
  if (from) u += `&from=${encodeURIComponent(from)}`;
  if (to) u += `&to=${encodeURIComponent(to)}`;
  return u;
}

/**
 * 功能：下载前那句确认文案 —— ⭐ 必须能看出「这次导了什么、哪一段时间」。
 *
 * 说明：⚠️ **不编条数**：要让前端知道条数就得先取一次数据（多一趟请求，而且那一份与真正
 * 下载到的可能不是同一刻）⇒ 只说「导什么 + 哪一段」。空数据也照样导（只有表头）。
 * 与手机端**逐字同一句**。
 */
function expConfirmText(what, from, to) {
  const name = expWhatName(what);
  if (what === 'accounts') return `将下载一份 CSV：${name}。账户余额不看时间，导的是账户此刻的余额。`;
  return `将下载一份 CSV：${name}（${exportDateText(from)} ~ ${exportDateText(
    to,
  )}）。空数据也会导出，文件里只有表头。`;
}

/**
 * 功能：勾 / 取消勾一样「导什么」—— ⭐ 只改 state 再重画（⛔ 不取数、⛔ 不发请求）。
 *
 * 说明：⚠️ 勾选状态**必须住 state**（`state.lgExportWhat`）—— 重画会把写在 DOM 上的 checked
 * 抹掉；重画那一趟也把「范围要不要禁用」一起算对。
 * @param {HTMLElement} n - 那颗复选框
 */
function pickExportWhat(n) {
  const key = String((n && n.dataset && n.dataset.key) || '');
  if (!EXPORT_WHAT_KEYS.includes(key)) return;
  const cur = new Set(expWhatKeys());
  if (n.checked) cur.add(key);
  else cur.delete(key);
  state.lgExportWhat = EXPORT_WHAT_KEYS.filter((k) => cur.has(k));
  paintLedgerSet();
}

/**
 *
 * 说明：⭐⭐ **原生 `<input type="date">` 透明铺满整行**（`opacity: 0; inset: 0`）：点整行任意处
 */
function expDateRowHtml(id, label, value, enabled) {
  const v = String(value || '');
  // ：整行都去**主动开**
  // 系统那套选择器（`showPicker()`）。⚠️ 光靠原生行为不行：`input[type=date]` 只有点它**最右边
  // 那个日历图标**才弹，点中间的日期文字只是选中某一段 —— 表现就是「只有点 › 才有反应」。
  return `<label class="lg-expdate${enabled ? '' : ' lg-expoff'}" data-lg="expdate">
      <span class="lg-expdname">${esc(label)}</span>
      <b class="lg-expdval">${esc(exportDateText(v))}</b>
      <i class="lg-expdchev">›</i>
      <input class="lg-expdinput" type="date" id="${esc(id)}" value="${esc(v)}" aria-label="${esc(label)}"${
        enabled ? '' : ' disabled'
      }></label>`;
}

/** 功能：导出页「开始时间」当前该用哪个值（用户改过就用他的，否则用服务端给的默认）。 @returns {string} @since */
function expFromOf() {
  const d = state.lgPeriods && state.lgPeriods.export;
  return exportDateOf(state.lgExportFrom, d && d.from);
}

/** 功能：同上，「结束时间」。 @returns {string} @since */
function expToOf() {
  const d = state.lgPeriods && state.lgPeriods.export;
  return exportDateOf(state.lgExportTo, d && d.to);
}

/**
 * 功能：点导出页那颗**日期行** ⇒ 主动把系统那套日期选择器打开（⛔ 不发请求）。
 *
 * 说明：⭐⭐ 为什么必须"主动开"（「点击 > 才会出现，改为点击日期出现日期选择器」）：
 * `input[type=date]` 的原生行为是**只有点它最右边那个日历图标**才弹选择器，点中间的日期
 * 文字只是把某一段（年 / 月 / 日）选中 —— 而那一行右边那个 `›` 正好就压在图标的位子上，
 */
function openExportDate(n, ev) {
  const row = n && n.closest ? n.closest('.lg-expdate') : null;
  const inp = row ? row.querySelector('input[type="date"]') : null;
  // 判据与顺序全在 `core/native-picker.js` 那一处（两端共用）：
  // 「先开、成功才拦默认动作，开不了就原样交回原生」—— 这里 ⛔ 别再自己写一遍。
  openNativePicker(inp, ev);
}

/**
 * 功能：改「开始 / 结束时间」—— 只改 state 再重画（⛔ 不发请求）。
 *
 * 说明：⚠️ 值来自本页那颗原生 `<input type="date">`，但这里仍按**严格形态**再挡一次
 * （`YYYY-MM-DD`；空串 = 用户把它清空了）—— 脏值发出去只会换来一个 400，而且不报错。
 * @param {string} id - 哪一颗（`lg-exp-from` / `lg-exp-to`）
 */
function pickExportDate(id, v) {
  const s = String(v || '');
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
  if (id === 'lg-exp-from') state.lgExportFrom = s;
  else if (id === 'lg-exp-to') state.lgExportTo = s;
  else return;
  paintLedgerSet();
}

/**
 * 功能：点「下载 CSV」—— ⭐ **先弹确认框 → 再浏览器导航**（照本文件删流水那几处的既有形态）。
 *
 * 说明：⭐⭐ 多选时**逐个下**（C-19：⛔ 不引 zip、⛔ 不引 Blob）：勾了三样就是**三次**
 * 「确认 → 导航」，每次一个 `.csv`；用户在任意一次点「取消」（＝关掉弹窗）⇒ 剩下的
 * **不再问**（⛔ 不把后面的当成"都同意"）。
 */
function downloadExports() {
  const keys = expWhatKeys();
  if (!keys.length) {
    toast('先勾一样要导出的内容', true);
    return;
  }
  // 只勾了「账户余额」⇒ 时间那一对对它没意义：**不带日期**（接口按「不限」算）
  const dated = expRangeApplies(keys);
  const from = dated ? expFromOf() : '';
  const to = dated ? expToOf() : '';
  if (dated && !(from && to)) {
    toast('先选好开始时间和结束时间', true);
    return;
  }
  if (dated && from > to) {
    toast('开始时间不能晚于结束时间', true);
    return;
  }
  runExportStep(keys, 0, from, to);
}

/**
 * 功能：多选导出里的**一步** —— 问一样、下一样，用户确认后再问下一样（⛔ 不一次弹三个框）。
 * @param {Array.<string>} keys - 要导的几样（顺序固定）
 * @param {number} i - 现在问到第几样
 * @param {string} from - 开始日期（空串 = 不限）
 * @param {string} to - 结束日期（空串 = 不限）
 */
function runExportStep(keys, i, from, to) {
  if (i >= keys.length) return;
  const what = keys[i];
  openConfirmModal('导出', `<div class="es-text">${esc(expConfirmText(what, from, to))}</div>`, '开始下载', () => {
    closeModal();
    window.location.href = expUrlOf(what, from, to);
    toast(`已开始下载：${expWhatName(what)}`);
    // 这一份导航出去之后，再问下一样（附件响应不会离开当前页 ⇒ 弹窗还能接着开）
    runExportStep(keys, i + 1, from, to);
  });
}

/**
 * 功能：画【收支分类】那一栏 —— 支出 / 收入**各一棵两级树** ＋ 末尾「＋ 新建一级分类」。
 *
 * 说明：⭐⭐ 树的构造**只准用 `entry-calc.js` 的 `catTree()`**：它内部调的就是
 * 不知道一个分类是"被归档了"还是"从来没建过"，只会再建一个同名的。
 * 两栏的**顺序固定**为 支出 → 收入（与记账弹层里那两颗分段按钮同序），⛔ 不按数据排。
 */
function catManageHtml() {
  const side = (ie) => {
    const tree = catTree(state.lgCats, ie, { includeArchived: true });
    // ：子级**只在展开时才画**。
    // 展开态住 `state.lgCatOpen`（`{一级id: true}`）—— 默认空对象 ＝ **全部折叠**（要的默认态）。
    const rows = tree
      .map((t) => {
        const kids = t.kids || [];
        const open = !!state.lgCatOpen[Number(t.id)];
        return (
          catManRowHtml(t, false, kids.length, open) +
          (open ? kids.map((k) => catManRowHtml(k, true, 0, false)).join('') : '')
        );
      })
      .join('');
    return `<div class="lg-catman-sec">${esc(ie)}</div>${rows || '<div class="lg-txwait">还没有分类。</div>'}`;
  };
  // ：这两颗**从栏底搬到顶部**
  // （位置改在 `setCatHtml()` 里，紧跟在「‹ 设置」那条头下面、正文之前）——
  // 列表再长也不必"滑到底"才够得着。⚠️ 手机端**不搬**（它仍是吸底那条）。
  return `<div class="lg-catman">
    ${side('支出')}
    ${side('收入')}
  </div>`;
}

/**
 *
 * 说明：⚠️⭐ 版式一个字没改（原来那两块照原样搬），只是**位置**从栏底挪到「‹ 设置」那条头下面 ——
 */
function catTopActionsHtml() {
  return `<div class="lg-cattop">
    <div class="lg-catman-new"><button class="btn btn-subtle btn-sm" type="button" data-lg="catadd">＋ 新建一级分类</button></div>
    ${catRestoreHtml()}
  </div>`;
}

/**
 * 功能：画分类管理里的一行（一级 / 二级）。
 *
 * 「是不是**内置**分类」＝ 服务端给的 `builtin`（⭐ 既定的 22 行：支出 15 ＋ 收入 7）；
 * 「是不是兜底分类」＝ 服务端给的 `other`（⛔ 别去比名字 —— 兜底分类的名字由服务端认，
 * 比名字会在改过名 / 换过语言之后静默失效）；
 */
function catManRowHtml(c, kid, kidCount, open) {
  const arch = !!c.archived;
  const builtin = !!c.builtin;
  const id = Number(c.id);
  // 每颗按钮的 `data-lg="…"` **必须写字面量**，⛔ 别抽一个 `btn(act, …)` 之类的帮手把动作名
  // 在运行期拼出来：`ttt/test/ledger.test.js` 那条「每一个动作名都有人接」的护栏是**静态扫源码**
  // 的（`/data-lg="([a-z]+)"/`），拼出来的名字扫不到 ⇒ 这几颗按钮会**悄悄脱出护栏**
  const btns = [];
  if (builtin || c.other) {
    // 「＋ 子分类」**内置行也画**：给内置一级加子分类服务端是允许的（改名 / 归档 / 删除那几条路 400）
    if (!kid && !arch) {
      btns.push(`<button class="btn btn-subtle btn-sm" type="button" data-lg="catnew" data-id="${id}">＋ 子分类</button>`);
    }
  } else if (arch) {
    btns.push(
      `<button class="btn btn-subtle btn-sm" type="button" data-lg="catunarch" data-id="${id}">恢复</button>`,
      `<button class="btn btn-danger btn-sm" type="button" data-lg="catdel" data-id="${id}">删除</button>`,
    );
  } else {
    btns.push(
      `<button class="btn btn-subtle btn-sm" type="button" data-lg="catren" data-id="${id}">改名</button>`,
      `<button class="btn btn-subtle btn-sm" type="button" data-lg="catarch" data-id="${id}">归档</button>`,
      `<button class="btn btn-danger btn-sm" type="button" data-lg="catdel" data-id="${id}">删除</button>`,
    );
    if (!kid) {
      btns.push(`<button class="btn btn-subtle btn-sm" type="button" data-lg="catnew" data-id="${id}">＋ 子分类</button>`);
    }
  }
  const acts = (arch ? '<i class="lg-sub">已归档</i>' : '') + btns.join('');
  // ：有子级的一级行前面放一颗
  // **展开 / 折叠**开关（子级默认收着，点它才摊开）。
  // 它**另起一格**（`.lg-catman-lead` 的**第一个孩子**），⛔ **不塞进 `.lg-catman-name`** ——
  const n = Number(kidCount) || 0;
  const toggle =
    !kid && n > 0
      ? `<button class="lg-catman-toggle" type="button" data-lg="cattoggle" data-id="${id}"` +
        ` aria-expanded="${!!open}" aria-label="${open ? '折叠' : '展开'}子分类">${open ? '▾' : '▸'}<i>${n}</i></button>`
      : '';
  return `<div class="lg-catman-row${kid ? ' kid' : ''}${arch ? ' arch' : ''}">
    <span class="lg-catman-lead">${toggle}<span class="lg-catman-name">${esc(c.name)}</span>${
      builtin ? '' : '<i class="lg-catman-tag">自定义</i>'
    }</span>
    <span class="lg-catman-acts">${acts}</span>
  </div>`;
}

/**
 * 功能：画【收支分类】栏底部那颗「恢复内置分类」——**危险行**，确认页见 `openRestoreBuiltin()`。
 *
 * 用它们记过的账显示成「未分类」）⇒ 版式照设置页「恢复整体备份」/「迁移记账数据」那两处
 * 的**危险行**来（红底红字红描边 ＋ 右侧一个「危险」）—— ⚠️ 值是**抄**过来的，
 * 不复用 `.set-row` 那个类名（一个类名别给两个组件用：那边调间距时会把这一行也带走）。
 */
function catRestoreHtml() {
  return `<div class="lg-catman-danger">
    <button class="lg-dangerrow" type="button" data-lg="catrestore">
      <span class="lg-dangerrow-ico" aria-hidden="true">⚠️</span>
      <span class="lg-dangerrow-main"><b>恢复内置分类</b><small>补齐缺失内置、清理旧版配置；自定义数据不受影响，操作不可恢复！！！</small></span>
      <span class="lg-dangerrow-val">危险</span>
    </button>
  </div>`;
}

/**
 * 功能：开「恢复内置分类」的确认页 —— ⚠️ 危险动作，必须**手打「恢复」二字**才放行。
 *
 * 说明：⭐⭐ 确认这一下照抄设置页那两处（`desktop/views/settings.js` 的「恢复整体备份」/
 * 换成红色 ＋ 在主按钮里校验那两个字的**表单语义**（不够格就 `toast` 拦下）。
 * 不自己发明第二套：项目里已经有两处同款，第三处长得不一样就是第三种习惯。
 */
function openRestoreBuiltin() {
  openModal(
    '⚠️ 恢复内置分类',
    '<div class="lg-tip">补齐缺失内置、清理旧版配置；自定义数据不受影响，<b>操作不可恢复</b>！</div>' +
      '<div class="lg-tip">用它们记过的账会显示成「未分类」。旧分类下面的子分类不会跟着消失，' +
      '会改挂到同一侧的「其它」下面。</div>' +
      '<div class="lg-tip"><b>操作不可恢复</b>：旧分类从列表里删除（记过的账目不会丢失）。</div>' +
      '<label class="lg-cfmword">确认请输入「恢复」二字：<input id="lg-rst-word" type="text" autocomplete="off" /></label>',
    { wide: true },
  );
  setModalSave('确认恢复（危险）', true);
  $('#modal-save').onclick = async () => {
    const w = $('#lg-rst-word');
    if (String((w && w.value) || '').trim() !== '恢复') {
      toast('请输入「恢复」两个字才能继续', true);
      return;
    }
    await runRestoreBuiltin();
  };
}

/**
 * 功能：真正调一次「恢复内置分类」，把结果用**真实计数**说给用户听。
 *
 * 说明：⭐⭐ 返回里**已经带着最新的整份 `categories`** ⇒ 直接换掉手上的清单（`state.lgCats`）
 * ＋ 原地重画弹窗，⛔ **不再 GET 一次**（多取一次不只是白跑一趟：两份清单之间若有过期，
 * 表现就是"刚恢复完、看到的还是旧的那一份"，而且**不报错**）。
 */
async function runRestoreBuiltin() {
  const b = $('#modal-save');
  setModalSave('恢复中…', true);
  if (b) b.disabled = true;
  try {
    const r = (await api('POST', '/api/ledger/restore-builtin')) || {};
    if (Array.isArray(r.categories)) state.lgCats = r.categories;
    paintLedgerSet();
    const nb = $('#modal-save');
    if (nb) nb.disabled = false;
    toast(restoreBuiltinText(r));
  } catch (e) {
    const nb = $('#modal-save');
    if (nb) nb.disabled = false;
    setModalSave('确认恢复（危险）', true);
    toast(e.message, true);
  }
}

/**
 * 功能：把「恢复内置分类」那四个计数翻成一句人话（⚠️ 0 的项**不显示**）。
 *
 * 说明：⚠️ 计数全为 0（清单本来就对齐）时要有一句"什么都没动"，⛔ 不能给一个空串 ——
 * `toast('')` 是一条**空白提示条**，看起来像坏了。
 * @param {Object} r - `POST /api/ledger/restore-builtin` 的响应（`{removed, added, marked, moved}`）
 */
function restoreBuiltinText(r) {
  const parts = [];
  if (r.removed) parts.push(`已删 ${r.removed} 个旧分类`);
  if (r.added) parts.push(`补上 ${r.added} 个内置`);
  if (r.marked) parts.push(`把 ${r.marked} 个标成内置`);
  if (r.moved) parts.push(`${r.moved} 个子分类改挂到「其它」`);
  if (!parts.length) return '内置分类本来就整齐，这次什么都没动。';
  const head = `${parts.join('、')}。`;
  return r.removed ? `${head}用它们记过的账会显示成「未分类」。` : head;
}

/** 这一次「新建 / 改名一个收支分类」的上下文（只活在那一次弹窗里）。 @type {?{mode: string, id: number, ie: string}} */
let pendingCat = null;

/**
 * 功能：开「新建一级 / 新建子分类 / 给分类改名」那张小表单（三用一）。
 *
 * 说明：⚠️ 照本文件既有的「内联输入」先例（`openViewName()` / `openUsageName()`）：
 * 就是一个普通弹窗 ＋ 一个名字输入框，主按钮走 `saveCatName()`。
 * 只有**新建一级**要多问一格「支出还是收入」：`POST /categories` 对一级**必须**收 `ie`
 */
function openCatName(mode, id, ie) {
  const rid = Number(id) || 0;
  const c = rid ? state.lgCats.find((x) => Number(x.id) === rid) : null;
  if ((mode === 'sub' || mode === 'ren') && !c) return;
  pendingCat = { mode, id: rid, ie: ie === '收入' ? '收入' : '支出' };
  const title = mode === 'top' ? '新建一级分类' : mode === 'sub' ? '新建子分类' : '给这个分类改名';
  const cur = mode === 'ren' ? String(c.name || '') : '';
  const sideSel =
    mode === 'top'
      ? '<div class="tt-field"><label for="lg-f-catie">是支出还是收入</label>' +
        `<select id="lg-f-catie"><option value="支出"${pendingCat.ie === '支出' ? ' selected' : ''}>支出</option>` +
        `<option value="收入"${pendingCat.ie === '收入' ? ' selected' : ''}>收入</option></select></div>`
      : '';
  // 三条说明各说一件事：建二级要说清挂在谁下面；建一级要说清还能再建二级；改名不用说明
  const tip =
    mode === 'sub'
      ? `<div class="lg-tip">它会挂在「<b>${esc(c.name)}</b>」下面 —— 记一笔时先点这个一级，再选它。</div>`
      : mode === 'top'
        ? '<div class="lg-tip">一级分类下面还能再建二级（比如「餐饮 › 早餐」）。</div>'
        : '';
  openModal(
    title,
    `<div class="lg-form"><div class="tt-field"><label for="lg-f-catname">分类名</label>` +
      `<input id="lg-f-catname" type="text" maxlength="${CAT_NAME_MAX}" value="${esc(cur)}" /></div>` +
      sideSel +
      tip +
      '</div>',
    {},
  );
  setModalSave('保存（Enter）', false);
  $('#modal-save').onclick = saveCatName;
}

/**
 * 功能：存下新建 / 改名的结果，回到「记账设置」那一栏。
 *
 * 全称应该是 一级分类-二级分类 …… 判断重复也得带上一级名称」）：**发请求之前**先判一次重名 ——
 * 撞了就 `toast` 拦下、**一条请求都不发**（那条请求注定 400，让用户看服务端那句英文式的
 * 拒绝没有意义）。
 */
async function saveCatName() {
  const el = $('#lg-f-catname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个分类起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const p = pendingCat || { mode: 'top', id: 0, ie: '支出' };
  // 候选的**全称**：新建一级 = 输入的名字（`parent_id` 传 0）；新建二级 = 父名-输入的名字；
  // 改名 = 按它自己的 `parent_id` 拼（一级就是新名字）—— 三处都走 `catFullName()` 这一份判据。
  // 改名时父要现取（父刚被改过名 ⇒ 拼出来的是新名），且 `selfId` 传自己
  let parentId = 0;
  let selfId = 0;
  if (p.mode === 'sub') {
    parentId = Number(p.id) || 0;
  } else if (p.mode === 'ren') {
    selfId = Number(p.id) || 0;
    const self = state.lgCats.find((x) => Number(x.id) === selfId);
    parentId = self ? Number(self.parent_id) || 0 : 0;
  }
  const full = catFullName(state.lgCats, { name, parent_id: parentId });
  if (catNameTaken(state.lgCats, full, selfId)) {
    toast(`已经有叫「${full}」的分类了`, true);
    if (el) el.focus();
    return;
  }
  try {
    if (p.mode === 'ren') {
      // 改名**只带 name**（带 ie / parent_id 服务端 400）
      await api('PUT', `/api/ledger/categories/${Number(p.id)}`, { name });
    } else if (p.mode === 'sub') {
      // 二级只收 {name, parent_id}：ie 由父继承
      await api('POST', '/api/ledger/categories', { name, parent_id: Number(p.id) });
    } else {
      const ieSel = $('#lg-f-catie');
      const ie = String((ieSel && ieSel.value) || p.ie) === '收入' ? '收入' : '支出';
      await api('POST', '/api/ledger/categories', { name, ie });
    }
    await repaintLedgerSet();
    toast(p.mode === 'ren' ? '改好了' : '分类建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：问「怎么归档这个分类」并执行 —— ⭐ 无子分类直接归档；有子分类让用户**二选一**。
 *
 * 说明：⭐⭐ 为什么必须二选一（不能替用户决定）：服务端对『有子分类的一级』有两种截然不同的做法 ——
 * `archive`：子分类**一起归档**（子分类也跟着消失）；
 * `move-children`：子分类**改挂到同一侧的「其它」**下面（它们还留着、记账时还选得到）。
 */
function askArchiveCat(id, mode) {
  const rid = Number(id) || 0;
  const c = state.lgCats.find((x) => Number(x.id) === rid);
  if (!c) return;
  // 兜底分类「其它」不画归档按钮；万一还是走到了这里，也别把请求发出去（服务端一律 400）
  if (c.other) return;
  const run = async (m) => {
    try {
      await api('DELETE', `/api/ledger/categories/${rid}?mode=${encodeURIComponent(m)}`);
      await repaintLedgerSet();
      toast('归档好了');
    } catch (e) {
      toast(e.message, true);
    }
  };
  if (mode === 'archive' || mode === 'move-children') {
    run(mode);
    return;
  }
  if (!hasKids(state.lgCats, rid)) {
    run('archive');
    return;
  }
  // 二选一：两个按钮各自带 `data-lg="catgo"` ＋ 把 mode 写在 `data-mode` 上
  const opt = (m, t, why) =>
    `<div class="lg-archopt"><button class="btn btn-subtle" type="button" data-lg="catgo" data-id="${rid}" data-mode="${m}">${t}</button>` +
    `<i>${why}</i></div>`;
  openModal(
    '归档这个分类',
    `<div class="lg-form">
      <div class="lg-tip">「${esc(c.name)}」下面还有子分类，它们怎么办？</div>
      ${opt('archive', '子分类一起归档', '它们也跟着收起来，记账时都选不到了')}
      ${opt('move-children', '子分类移到「其它」', '它们还留着、记账时照样选得到，只是改挂在「其它」下面')}
    </div>`,
    {},
  );
  // 这一页没有「保存」：两个选项各自就是一个动作 ⇒ 主按钮退化成「关闭」
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：从服务端返回体里取一个计数（认不出回 `0`）。
 *
 * 说明：⚠️ 它存在的唯一理由是**不硬编码数字**（口径：用返回里的真实计数说人话），
 * 而删除接口的字段名在两端是同一批（`entries` / `children`，旧名 `moved_*` 也认）——
 * 两个候选名都要认：这不是"两份判据"，是同一个数的**别名**（服务端换名时不会 500、
 */
function catDelCount(r, keys) {
  for (const k of keys) {
    const v = Number((r || {})[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * 功能：把「永久删除一个分类」那条接口的结果翻成一句人话（⛔ 数字全部来自返回体）。
 *
 * 说明：⭐ 形状照 `restoreBuiltinText()`：**0 的项不出现**，一件都没动时给一句明确的"什么都没动"，
 * 不给空串（`toast('')` 是一条**空白提示条**，看起来像坏了）。
 * @param {Object} r - `DELETE /api/ledger/categories/<id>?mode=delete` 的响应
 */
function catDelText(r) {
  const nE = catDelCount(r, ['entries', 'moved_entries']);
  const nC = catDelCount(r, ['children', 'moved_children', 'moved']);
  const parts = [];
  if (nE) parts.push(`${nE} 笔账`);
  if (nC) parts.push(`${nC} 个子分类`);
  if (!parts.length) return '已删除。';
  return `已删除；${parts.join('和')}移到「其它」。`;
}

/**
 *
 * 说明：⭐⭐ 版式照本文件既有的两处危险动作（`openRestoreBuiltin()` 与
 */
function openCatDel(id) {
  const rid = Number(id) || 0;
  const c = state.lgCats.find((x) => Number(x.id) === rid);
  if (!c || c.builtin || c.other) return;
  // 正文里的名字用**全称**（二级要写「父名-本名」）—— 光写子分类名时，屏幕上那两行
  // 「早餐」看不出要删的到底是哪一个（与 `setAcctHtml()` 那一条同一条理由）。
  const full = catFullName(state.lgCats, c);
  const kidTip = hasKids(state.lgCats, rid)
    ? '<div class="lg-tip">它下面的子分类会改挂到「其它」。</div>'
    : '';
  openModal(
    '⚠️ 删除分类',
    `<div class="lg-tip">「<b>${esc(full)}</b>」会从分类里永远消失（不可恢复）。</div>` +
      '<div class="lg-tip">用这个分类记过的账会移到「其它」。</div>' +
      kidTip,
    { wide: true },
  );
  setModalSave('永久删除', true);
  $('#modal-save').onclick = () => runCatDel(rid);
}

/**
 * 功能：真正调一次「永久删除这个分类」，把结果用**真实计数**说给用户听。
 *
 * 说明：⭐⭐ 与 `runRestoreBuiltin()` 同一条纪律：`#modal-save` 是**常驻节点**（它住在
 * `#modal-body` 之外，`openModal` 换掉的只有正文）⇒ 上面按下时那个 `disabled`
 * **不会**自己还原，成功与失败两条路都得自己清掉（忘了清的表现是：重画回来那颗按钮
 */
async function runCatDel(rid) {
  const b = $('#modal-save');
  setModalSave('删除中…', true);
  if (b) b.disabled = true;
  try {
    const r = (await api('DELETE', `/api/ledger/categories/${Number(rid)}?mode=delete`)) || {};
    if (Array.isArray(r.categories)) state.lgCats = r.categories;
    else await ensureCats(true);
    // 回到【收支分类】那一页（`state.lgSetPage` 没动）—— 先解掉主按钮的禁用再重画，
    const nb = $('#modal-save');
    if (nb) nb.disabled = false;
    paintLedgerSet();
    toast(catDelText(r));
  } catch (e) {
    const nb = $('#modal-save');
    if (nb) nb.disabled = false;
    setModalSave('永久删除', true);
    toast(e.message, true);
  }
}

/**
 * 功能：把归档过的分类**恢复使用**（`POST /api/ledger/categories/<id>/restore`）。
 *
 * 说明：⭐ 恢复**不需要二次确认**（口径）：它只是把那一行重新放出来，
 * 既不删东西也不改账，多一层「确定吗」是白加的一手。
 * 成功之后重画 ＋ 说一句「『全称』能用了」—— 名字取**重画后**那份清单里的（服务端
 */
async function restoreCat(id) {
  const rid = Number(id) || 0;
  try {
    await api('POST', `/api/ledger/categories/${rid}/restore`);
    await repaintLedgerSet();
    const c = state.lgCats.find((x) => Number(x.id) === rid);
    toast(`「${catFullName(state.lgCats, c || {})}」能用了`);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：按**手上这份** `state.lgCats` 把「记账设置」弹窗画出来（⛔ 不取数）。
 *
 * （`openLedgerSet()`，先取一次数）；② 分类增 / 改 / 归档之后（`repaintLedgerSet()`，
 * 同样先取一次数）；③ 「恢复内置分类」之后 —— 那条路的响应里**自带最新清单**，
 * 三条路各写一份"画正文＋还原主按钮"就是三份判据，将来只改一处必然漂移。
 */
function paintLedgerSet() {
  const page = setPageOf(state.lgSetPage);
  const meta = SET_PAGES.find((p) => p.key === page);
  openModal((meta && meta.name) || '记账设置', page ? setPageBodyHtml(page) : setHomeHtml(), { wide: true });
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：进设置里的某一页（`data-page` 上带着 `SET_PAGES` 的 `key`）。
 *
 * 说明：⚠️ 判据走 `setPageOf()`（认不出＝留在首页，⛔ 不切）—— 认不出还切过去的话，
 * 用户会站在一个空白正文上而**没有任何提示**。
 * 只换页、**不重新取数**：那一页要的数据（分类 / 默认账户 / 导入概况）开弹窗时已经取过。
 */
function goLedgerSetPage(k) {
  const page = setPageOf(k);
  if (!page) return;
  state.lgSetPage = page;
  paintLedgerSet();
  // 【导出数据】那一页那两颗日期框的**起点**取自服务端（`/api/ledger/periods`
  // 的 `export.from` / `.to`，与图表那边**共用同一个 state 键** `lgPeriods`）——
  if (page === 'exp' && !state.lgPeriods) loadPeriods();
}

/**
 * 功能：设置子页那颗「‹ 设置」⇒ 回设置首页（⛔ 不是关掉弹窗）。
 *
 * 说明：⚠️ 回首页**不回滚任何输入**：四页的动作都是当场生效的（各自成功路径里已经重画过）
 * —— 这里⛔ 不弹"还没保存确定要走吗"（那是多出来的一手，而这一层丢不掉多少东西）。
 * @returns {void}
 */
function backLedgerSetPage() {
  state.lgSetPage = '';
  paintLedgerSet();
}

/**
 * 功能：把「记账设置」弹窗的**正文重画一遍**（分类增 / 改 / 归档成功之后走它）。
 *
 * 说明：⭐⭐ 为什么要重画而不是关掉重开：用户正站在这一页上做分类（可能连做几次），
 * 关掉重开会把他的位置与上下文一起丢掉。⇒ 只重取分类清单（`ensureCats(true)`）＋ 重画正文。
 * 四页一律把主按钮设成「关闭」（从前这一句写的是"还原回「保存（Enter）」"）。
 */
async function repaintLedgerSet() {
  await ensureCats(true);
  paintLedgerSet();
}

/**
 * 功能：开「记账设置」（记账屏顶部那颗 `⋯`）—— 电脑端是**宽弹窗**（C-11 /  第 9 条）。
 * @returns {Promise.<void>}
 */
async function openLedgerSet(page) {
  const [okC, okD] = await Promise.all([ensureCats(true), ensureDefaults(true)]);
  if (!okC || !okD) {
    toast('记账设置没读到，稍后再试', true);
    return;
  }
  // 重画这件事**只住 `paintLedgerSet()` 一处**（这里是从前那一份内联的拷贝 —— 留着它，
  // 将来改"主按钮怎么还原"就要改两个地方，而只改一处的表现是"某一个入口回来按钮不对"）
  // 那一块「导入三方数据」的概况**跟这一次打开一起取** —— 先把三态推回 `loading`
  impLoad = 'loading';
  impErr = '';
  // **每次打开设置都落首页**（二级菜单的第一层）—— 用户点的是那颗「设置」，
  // 不是"上一次在设置里翻到的那一页"；不清的话他一点开就站在某个子页上，而**没有提示**
  // （同一条纪律：手机端切到「设置」那一格也把这一页清掉，见 `lgSegPick()`）。
  state.lgSetPage = setPageOf(page);
  paintLedgerSet();
  loadImportSummary().then(repaintSetIfOpen);
}

/**
 * 功能：**从设置页那一栏**打开「记账设置」，并直接落在某一子页（空串 = 首页四条目）。
 *
 * 说明：⚠️ 电脑端的记账设置是**宽弹窗**（`paintLedgerSet()` 26 处重画全指着它）——
 * 设置页里点一条就开这张弹窗、落在对应那一页上，⛔ **不切屏**。
 * @param {string} page - `SET_PAGES` 的 `key`（认不出一律回首页）
 */
export async function openLedgerSetPage(page) {
  await openLedgerSet(page);
}

/**
 * 功能：记账设置**首页那四条条目**的 HTML（⭐ 设置页那一栏用；不带「记账设置」那句小标题）。
 *
 * 说明：⚠️ 与弹窗里那一份是**同一支**（`setHomeHtml(true)`）—— ⛔ 别为设置页另写一份条目清单：
 * 那就是两份真相，迟早一处改了另一处不改（而且**不报错**）。
 * @returns {string} 那四条条目的 HTML（`.lg-setlist`）
 */
export function ledgerSetRowsHtml() {
  return setHomeHtml(true);
}

/**
 * 功能：提交一次默认账户的改动 —— ⭐ **逐键提交**（带哪个键写哪个）＋ 用服务端回读的那份重画。
 *
 * 于是**只准有这一条保存路径**（⛔ 别留两套：两套的下场是"从某一个入口改的存不进去"，
 * 而且不报错）。
 * 也**只提交真的变了的那一个键**：全局两层是 upsert（每次提交都会写一次无谓的更新），
 */
async function submitDefaults(body, okText) {
  try {
    const r = await api('PUT', '/api/ledger/defaults', body);
    if (r && r.defaults) state.lgDefaults = r.defaults;
    // 只重画**还开着的**那层弹窗：这一趟往返里用户完全可能已经把它关掉了
    // （与 `repaintSetIfOpen()` 同一条纪律）。
    if (modalOpen()) paintLedgerSet();
    if (okText) toast(okText);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：设置【收支账户】里那两颗**全局**下拉换值 ⇒ 提交那一颗（`{income_id}` / `{expense_id}`）。
 *
 * 说明：⚠️ 判据是「**真的变了才发请求**」（口径）：值一样就什么都不做、也不弹提示 ——
 * 同一条纪律，⛔ 别让"点了没变"也走一趟网络。
 * 全局两层**只改不删**：下拉里没有空档，所以这里不会提交 `null`；
 */
async function commitGlobalDefault(key, value) {
  const d = state.lgDefaults || {};
  const cur = Number(key === 'income_id' ? d.income : d.expense) || 0;
  const next = Number(value) || 0;
  if (!next || next === cur) return;
  await submitDefaults({ [key]: next }, '改好了');
}

/**
 * 功能：设置【收支账户】里某一颗**类别**下拉换值 ⇒ 提交那一颗（`{categories: {<分类 id>: <账户 id>}}`）。
 *
 * 说明：⚠️ 与上面那颗同一条纪律：**真的变了才发请求**。
 * 值取到空 = 用户选了「跟随全局默认」⇒ 提交 `null`（**清掉**这一条，只可能是每类别那层；
 * 全局两层传 `null` 服务端一律 400）。
 */
async function commitCatDefault(cid, value) {
  const d = state.lgDefaults || {};
  const row = (d.categories || []).find((x) => Number(x.category_id) === Number(cid));
  const cur = row && row.account_id != null ? Number(row.account_id) : 0;
  const next = Number(value) || 0;
  if (next === cur) return;
  await submitDefaults({ categories: { [String(Number(cid))]: next || null } }, '改好了');
}

/**
 * 功能：开【收支账户】页底部那颗「＋ 新增」的表单 —— 给**一个还没设过的类别**单设默认账户。
 *
 * 说明：⭐ 这就是那条「用户可以通过【新增】按钮来设置各个类别的默认」的落点：
 * 这一页只列**已设过的**，新设走这张弹窗。
 * 「类别」那一格**排除已经设过的**（那几行已经在上面的列表里了，再来一遍是重复设置）；
 */
function openCatDefault() {
  const d = state.lgDefaults || { categories: [] };
  const setIds = new Set((d.categories || []).map((x) => Number(x.category_id)));
  const cands = state.lgCats.filter((c) => !setIds.has(Number(c.id)));
  const opts = cands
    .map((c) => `<option value="${Number(c.id)}">${esc(catFullName(state.lgCats, c))}</option>`)
    .join('');
  const body = cands.length
    ? '<div class="lg-form">' +
      '<div class="tt-field"><label for="lg-setdef-cat">类别</label>' +
      `<select id="lg-setdef-cat">${opts}</select></div>` +
      '<div class="tt-field"><label for="lg-setdef-acct">默认账户</label>' +
      `<select id="lg-setdef-acct">${defOptions(0, true)}</select></div>` +
      '</div>'
    : '<div class="lg-tip">每个类别都设好了。</div>';
  openModal('给类别设默认账户', body, {});
  setModalSave('保存（Enter）', false);
  $('#modal-save').onclick = saveCatDefault;
}

/**
 * 功能：存下「给类别设默认账户」那张表单（提交那一个键，然后回列表）。
 *
 * 说明：⚠️⭐ 「跟随全局默认」**不算一个选择**（它等于"不单设"），而这个弹窗列的又都是
 * **还没设过**的类别 ⇒ 提交它是个空动作。所以这里**把保存拦下**并说清原因，
 * 不静默发一条"什么都没变"的请求、也不弹一句"改好了"（那是最坏的一种：看着成功了）。
 */
async function saveCatDefault() {
  const catEl = $('#lg-setdef-cat');
  const acctEl = $('#lg-setdef-acct');
  if (!catEl || !acctEl) {
    // 没有可选类别那一态（正文换成了那句话）—— 保存摆着但什么都不做，只把原因说出来
    toast('每个类别都设好了。');
    return;
  }
  const cid = Number(catEl.value) || 0;
  const aid = Number(acctEl.value) || 0;
  if (!cid) {
    toast('先选一个类别吧', true);
    return;
  }
  if (!aid) {
    toast('先给它选一个账户吧', true);
    return;
  }
  await submitDefaults({ categories: { [String(cid)]: aid } }, '设好了');
}

// ============================================================================
// 三方导入（鲨鱼记账）：设置里那一块 ＋ 导入向导 ＋ 明细屏混排
//
// 功能：① 记账设置里多一块「导入三方数据」（下面一行是「鲨鱼记账」＋ 一颗 [导入]；
// `count > 0` 时再多一行「已导入 N 笔（跨度）」＋ 一颗 [清除]）；

/** 三方来源的 `source` 值（本期只适配鲨鱼）—— ⛔ 它不是文件名、也⛔ 不受理请求体带来的值。 @type {string} */
const IMP_SOURCE = 'shark';

/**
 * 设置里那一行显示的名字（⚠️ 与 `lib/import-sources.js` 注册表里的 `label` 同一个词）。
 *
 */
const IMP_LABEL = '鲨鱼记账';

/**
 * 「导入三方数据」那块的正文明细（给的定稿文案）。
 *
 */
const IMP_HELP =
  '导入三方记账数据，不关联账户，数据独立存储，自动过滤重复数据。目前已经适配：鲨鱼记账。';

/** 导入概况（`GET /api/ledger/import` 的 `summary`；`null` = 还没取到）。 @type {?Object} */
let impSummary = null;

/** 概况的四态：`idle`（还没取）| `loading` | `done` | `error`。⚠️ `error` ⛔ 绝不许画成「还没导入过」。 @type {string} */
let impLoad = 'idle';

/** 概况读不到时的原因（用户能看的那句话）。 @type {string} */
let impErr = '';

/** 用户选中的那个文件（`File`）—— 只活在这次向导里。 @type {?File} */
let impFile = null;

/** 预览草稿（`POST …/import/preview` 的 `draft`）。⚠️ 确认时**不用它**（那一下是把同一个文件再发一次）。 @type {?Object} */
let impDraft = null;

/** 确认导入的结果（`POST …/import/commit` 的 `result`）—— 只用来画结果那一页。 @type {?Object} */
let impResult = null;

/** 正在上传预览 / 正在确认导入（防重复点、防重复发）。 @type {boolean} */
let impBusy = false;

/**
 * 明细屏当前那个月**全部**导入行（服务端一次给全，**不分页**）。
 *
 */
let impRows = [];

/**
 * 功能：把「记账设置」弹窗原地重画一遍 —— **只在它真的还开着**的时候（读概况 / 重试之后）。
 *
 * 说明：⭐⭐ 为什么要判一下：概况是**异步**回来的，而这一趟往返里用户完全可能把弹窗关掉
 * （✕ / Esc / 点遮罩）—— 那时无条件 `paintLedgerSet()` 会**把弹窗又拉回来**
 * 判据用 `#lg-imp-sum`（概况那一行的 id，就住在设置正文里）：它还在 ⇒ 这一层仍然
 */
function repaintSetIfOpen() {
  if (modalOpen() && $('#lg-imp-sum')) paintLedgerSet();
}

/**
 * 功能：取一次导入概况（`GET /api/ledger/import?source=shark`）。
 *
 * 说明：⚠️ 三态**分得开**：`loading` / `error`（读不到 ＋ 重试）/ `done`。
 * （用户会以为"我确实没导过"，然后再导一次）。`count === 0` 才是「还没导入过」。
 * 失败**不抛**（由界面画错误块 ＋ 一颗重试）；⚠️ 本函数**自己不重画** —— 画不画、
 */
async function loadImportSummary() {
  impLoad = 'loading';
  impErr = '';
  try {
    const r = await api('GET', `/api/ledger/import?source=${IMP_SOURCE}`);
    impSummary = (r && r.summary) || null;
    impLoad = 'done';
  } catch (e) {
    impLoad = 'error';
    impErr = e.message;
  }
}

/**
 * 功能：往**自己的服务端**发一次「原始字节体」的 POST（⛔ 不是 JSON）。
 *
 * 说明：⭐⭐ `core/api.js` 的 `api()` 只会 `JSON.stringify` 一个 body ⇒ 上传文件那条路走不了它，
 * 只能自己 `fetch`（两个先例：课表导入 `modules/timetable/desktop-import.js`，以及手机端
 * 同名的那一份 `modules/ledger/mobile.js` 的 `postRaw()`）。于是那两件本来由 `api()` 兜住
 */
async function postRaw(path, file) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await res.json().catch(() => null);
  if (res.status === 401) {
    backToLogin();
    const e401 = new Error('登录已过期，正在回到登录页…');
    e401.status = 401;
    throw e401;
  }
  if (!res.ok) {
    const err = new Error((j && j.error) || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return j;
}

/**
 * 功能：画设置里那一块「导入三方数据」的**下一行**（概况那三态）。
 *
 * 说明：⭐ 只有 `count > 0` 才画「已导入 N 笔（跨度）＋ [清除]」这一行；`count === 0` 画
 * 「还没导入过」（**不是**错误）；读不到画一句人话 ＋ 一颗重试（⛔ 与「还没导入过」分开）。
 * 跨度那一段只在**两端日期都拿到**时才画（缺一个就只报笔数，⛔ 不拼出「~ 空」那种）。
 */
function impSummaryHtml() {
  if (impLoad === 'idle' || impLoad === 'loading') {
    return '<div class="lg-imp-sum" id="lg-imp-sum"><span class="lg-impnote">正在读取导入概况…</span></div>';
  }
  if (impLoad === 'error') {
    return `<div class="lg-imp-sum" id="lg-imp-sum"><span class="lg-impnote err">导入概况没读到：${esc(
      impErr || '原因不明',
    )}</span>
      <button class="lg-impbtn" type="button" data-lg="impretry">重试</button></div>`;
  }
  const s = impSummary || {};
  const n = Number(s.count) || 0;
  if (!n) return '<div class="lg-imp-sum" id="lg-imp-sum"><span class="lg-impnote">还没导入过</span></div>';
  const from = String(s.from || '');
  const to = String(s.to || '');
  const span = from && to ? `（${from} ~ ${to}）` : '';
  return `<div class="lg-imp-sum" id="lg-imp-sum"><span class="lg-impnote">${esc(`已导入 ${n} 笔${span}`)}</span>
    <button class="lg-impbtn danger" type="button" data-lg="impclear">清除</button></div>`;
}

/**
 * 功能：画一条**导入行**（明细屏里那些三方数据）。
 *
 * 说明：⭐⭐ 三条口径：
 * **只读**：整行挂了 `data-lg="impitem"` ⇒ 点开是**只读详情**，⛔ 没有编辑 / 删除；
 * **一眼分得出**（`.lg-erow.imp` ＋ 灰底的来源小徽标 ＋ 一颗 `source_label` 小标签）：
 */
function impRowHtml(r) {
  const src = String((r && r.source_label) || '').trim() || IMP_LABEL;
  const cat = String((r && r.category) || '').trim() || CAT_UNCLASSIFIED;
  const note = String((r && r.note) || '').trim();
  // 分类图标那一格（自有流水画的是"色块 ＋ 分类首字"）在这里放**来源小徽标**：
  const ico = `<span class="lg-imp-badge" aria-hidden="true">${esc(src.slice(0, 1) || '·')}</span>`;
  const parts = [`<span class="lg-imp-tag">${esc(src)}</span>`];
  if (note) parts.push(esc(note));
  return `<div class="lg-erow imp" data-lg="impitem" data-id="${Number((r && r.id) || 0)}">
    ${ico}
    <span class="lg-emain"><b class="lg-etitle">${esc(cat)}</b>
      <i class="lg-sub">${parts.join(' · ')}</i></span>
    <b class="lg-eamt">${esc(fmtSignedFen(signedFen(r && r.ie, r && r.fen), state.lgHide))}</b>
  </div>`;
}

/**
 * 功能：点一条导入行 ⇒ 开**只读详情**弹窗。
 *
 * 说明：⭐⭐ **只读**：六列原样 ＋ 来源 ＋ 一句「三方导入的数据不能改，要撤就整批清除」。
 * 从**手上这份** `impRows` 里找（与 `openEntryDetail()` 同一条手法）：找不到（刚换过月 /
 * 别处清过）就什么都不做，⛔ 别开一张空弹窗。
 */
function openImpDetail(id) {
  const rid = Number(id) || 0;
  const r = impRows.find((x) => Number(x && x.id) === rid);
  if (!r) return;
  const row = (k, v) => `<div class="lg-edtl-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  openModal(
    '这笔账（只读）',
    `<div class="lg-edtl">
      <div class="lg-edtl-say">三方导入的数据不能改，要撤就整批清除。</div>
      <div class="lg-edtl-rows">
        ${row('日期', String(r.date_raw || ''))}
        ${row('收支', String(r.ie || ''))}
        ${row('类别', String(r.category || '') || CAT_UNCLASSIFIED)}
        ${row('账户', String(r.account || '') || '（没填）')}
        ${row('金额', String(r.amount_raw || ''))}
        ${row('备注', String(r.note || '') || '（没填）')}
        ${row('计入日', String(r.at || ''))}
        ${row('来源', String(r.source_label || '') || IMP_LABEL)}
      </div>
    </div>`,
    {},
  );
  // 这一页**没有**改 / 删（只读）⇒ 主按钮退化成「关闭」（照 `openEntryDetail()` 的先例）。
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：设置里那颗「[导入]」—— 开导入向导第 1 步（并把这一次向导的临时态清干净）。
 *
 * 说明：⚠️ 进来就清临时态（照手机端 `lgImpOpen()`）：用户上一回可能选完文件没确认就关掉了，
 * 留着那份 `impFile` 的话，下一次向导会在"什么都没选"的样子下拿旧文件去提交。
 * @returns {void}
 */
function impOpen() {
  impFile = null;
  impDraft = null;
  impResult = null;
  impBusy = false;
  impPickStep();
}

/**
 * 功能：画向导**第 1 步**：选文件那张弹窗。
 *
 * 说明：⭐ 文件选择走**原生 `<input type="file">` 的 `change`**（⛔ 不是 `data-lg`）——
 * 电脑端就用原生控件（与课表导入 `ttImportStep1()` 同一套做法），⛔ 不引 `placeholder`、
 * 不用 `.fld`（那个类在电脑端**没有定义**，弹窗会「像没渲染」）。
 */
function impPickStep() {
  openModal(
    '导入三方数据',
    `<div class="lg-form">
      <div class="tt-field"><label for="lg-imp-file">文件</label>
        <input id="lg-imp-file" class="lg-imp-file" type="file" accept=".csv,text/csv" /></div>
      <div class="tt-tip">选 ${esc(IMP_LABEL)}导出的 CSV（六列：日期 / 收支类型 / 类别 / 账户 / 金额 / 备注），原样存、只读。</div>
      <div class="tt-tip">文件最大 2MB；选完就上传预览（预览不写库，确认之后才真写入）。</div>
      <div class="lg-impacts">
        <button class="btn btn-subtle" type="button" data-lg="impcancel">取消</button>
      </div>
    </div>`,
    {},
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
  // 直接挂在那颗 input 上（⛔ 不走 `#modal-body` 那条 `change` 委托）：弹窗正文每次重画都换
  // 新节点，旧监听跟着节点一起消失 ⇒ 不存在"挂重了、选一次文件预览发两遍"那种坑。
  const el = $('#lg-imp-file');
  if (el) el.addEventListener('change', impFilePicked);
}

/**
 * 功能：选到文件 ⇒ 存下它、**立刻上传预览**。
 * @param {Event} e - `change` 事件（`e.target.files[0]` 是那个文件）
 * @returns {void}
 */
function impFilePicked(e) {
  const t = e && e.target;
  const f = (t && t.files && t.files[0]) || null;
  if (!f) return;
  impFile = f;
  impPreview();
}

/**
 * 功能：把选好的文件发去**预览**（`POST …/import/preview`，⛔ 不写库）并弹预览层。
 *
 * 说明：⚠️ 失败**不关**这张选文件的弹层：重开一次（文件格清空），用户顺手再选一个
 * —— 报错只由 `toast` 说一句（服务端那句人话，解析失败时它点得出哪一列 / 哪一行）。
 * @returns {Promise.<void>}
 */
async function impPreview() {
  if (!impFile || impBusy) return;
  impBusy = true;
  try {
    const r = await postRaw(`/api/ledger/import/preview?source=${IMP_SOURCE}`, impFile);
    impDraft = (r && r.draft) || null;
    openImportPreview();
  } catch (e) {
    // 401 那条路已经由 `postRaw()` 带走了（回登录页），这里只对真正的失败说话
    if (!(e && e.status === 401)) toast(e.message, true);
    impFile = null;
    impDraft = null;
    impPickStep();
  } finally {
    impBusy = false;
  }
}

/**
 * 功能：画**预览层**—— 认得出 N 笔（跨度）/ 将写入 M / 跳过 K /
 * 认不出 J（仅当有）/ 按月小计一张小表 ＋ 两颗按钮。
 *
 * 说明：⭐⭐ 两颗按钮 `取消` ｜ `确认导入`，⚠️ **默认焦点不在「确认导入」那颗** ——
 * 这里刻意**什么都不 `focus()`**（谁也不自动抢焦点），也不给任何一颗 `autofocus`
 */
function openImportPreview() {
  const d = impDraft || {};
  const parsed = Number(d.parsed) || 0;
  const insert = Number(d.insert) || 0;
  const skip = Number(d.skip) || 0;
  const failed = Number(d.failed) || 0;
  const from = String(d.from || '');
  const to = String(d.to || '');
  const span = from && to ? `（跨度 ${from} ~ ${to}）` : '';
  const months = Array.isArray(d.months) ? d.months : [];
  const rows = months.length
    ? months
        .map((m) => {
          const inc = Number(m.income_fen) || 0;
          const exp = Number(m.expense_fen) || 0;
          return `<div class="lg-imp-mrow"><span class="lg-imp-mk">${esc(
            monthLabel(String((m && m.month) || '')),
          )}</span>
            <span class="lg-imp-mv">收入 ${esc(fmtFen(inc, state.lgHide))}</span>
            <span class="lg-imp-mv">支出 ${esc(fmtFen(exp, state.lgHide))}</span>
            <span class="lg-imp-mc">${Number((m && m.count) || 0)} 笔</span></div>`;
        })
        .join('')
    : '<div class="lg-txwait">这份文件里没有按月的小计。</div>';
  openModal(
    '预览 · 导入三方数据',
    `<div class="lg-form">
      <div class="lg-impcap">认得出 <b>${parsed}</b> 笔${esc(span)}</div>
      <div class="lg-impkv">将写入 <b>${insert}</b> 笔</div>
      <div class="lg-impkv">跳过 <b>${skip}</b> 笔</div>
      ${failed ? `<div class="lg-impkv warn">认不出 <b>${failed}</b> 笔（已原样保存、不进统计）</div>` : ''}
      <div class="lg-edcap2">按月小计</div>
      <div class="lg-imp-months">${rows}</div>
      <div class="tt-tip">确认之后才真写进库；同一个文件再导一次不会重复写。</div>
      <div class="lg-impacts">
        <button class="btn btn-subtle" type="button" data-lg="impcancel">取消</button>
        <button class="btn btn-primary" type="button" data-lg="impgo">确认导入</button>
      </div>
    </div>`,
    {},
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：预览层那颗「确认导入」⇒ **把同一个文件再发一次**（`POST …/import/commit`）。
 *
 * 说明：⭐⭐ 三条：
 * 成功之后把明细屏**重取一遍**（`loadEntries(true)`）：导入行与两组合计都变了，
 * 不重取的话关掉弹窗看到的还是导入前那一屏（而且**不报错**）；
 */
async function impGo() {
  if (!impFile || impBusy) return;
  impBusy = true;
  try {
    const r = await postRaw(`/api/ledger/import/commit?source=${IMP_SOURCE}`, impFile);
    const g = (r && r.result) || {};
    impResult = { inserted: Number(g.inserted) || 0, skipped: Number(g.skipped) || 0 };
    impFile = null;
    impDraft = null;
    await loadImportSummary();
    await loadEntries(true);
    openImportResult();
  } catch (e) {
    if (!(e && e.status === 401)) toast(e.message, true);
  } finally {
    impBusy = false;
  }
}

/**
 * 功能：画向导**第 4 步**（结果）—— 写入 M / 跳过 K ＋ 一句人话 ＋ 一颗「去明细看看」。
 * @returns {void}
 */
function openImportResult() {
  const g = impResult || {};
  const ins = Number(g.inserted) || 0;
  const skp = Number(g.skipped) || 0;
  openModal(
    '导入完成',
    `<div class="lg-form">
      <div class="lg-impcap">写入 <b>${ins}</b> 笔，跳过 <b>${skp}</b> 笔。</div>
      <div class="tt-tip">这些账是只读的，列在「明细」里按天与自有流水混排。</div>
      <div class="lg-impacts">
        <button class="btn btn-primary" type="button" data-lg="impgodetail">去明细看看</button>
      </div>
    </div>`,
    {},
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：结果页那颗「去明细看看」⇒ 切到「明细」那一格并**重取**。
 *
 * 说明：⚠️ 不能只改 `state.lgSeg` 就算了：流水 / 合计 / 导入行都变了（刚导进来的那些
 * 根本不在手上），必须 `loadEntries(true)` 从第一页重取 —— 与切到「明细」那一格
 * （`bindLedgerEvents()` 里 `seg === 'detail' && lgLoad === 'idle'` 那条）走的是**同一条路**。
 */
async function impGoDetail() {
  closeModal();
  state.lgSeg = 'detail';
  state.lgMdMonth = 0;
  await loadEntries(true);
}

/**
 * 功能：向导里那颗「取消」⇒ 把这一次向导的临时态清干净并**回到记账设置**。
 *
 * 说明：⚠️ 与手机端那两颗「取消」的**去处**不同、**判据**相同：手机端的向导是一层弹层，
 * 关掉它就自然回到底下那张设置屏；电脑端的向导是把设置**弹窗的正文换掉了**，
 * 还要再点一次齿轮才能接着改分类。
 */
function impCancel() {
  impFile = null;
  impDraft = null;
  impResult = null;
  impBusy = false;
  paintLedgerSet();
}

/**
 * 功能：概况那块「读不到」时那颗重试（只重取概况，⛔ 不整页刷新）。
 * @returns {void}
 */
function impRetry() {
  // 先把三态推回 `loading` 再重画一次：不这么做的话，用户点下去到响应回来之间
  // 界面还是那句红话（"点了没反应"的观感），而其实请求已经发出去了。
  impLoad = 'loading';
  repaintSetIfOpen();
  loadImportSummary().then(repaintSetIfOpen);
}

/**
 * 功能：设置里那颗「[清除]」⇒ 先弹一道**「警告」二次确认**。
 *
 * 说明：⚠️ 标题逐字是「警告」、正文逐字是「将删除全部 N 笔鲨鱼记账导入的数据，且不可恢复」，
 * 确认那颗是**红色**的 `确定` —— 与手机端那层底部分层同一条口径，只是电脑端套的是弹窗。
 * 确认那颗挂的是 `impclearok`（⛔ 不是共用的某个确认键）—— 与预算那条「清除总预算」
 */
function impClear() {
  const n = impSummary ? Number(impSummary.count) || 0 : 0;
  openModal(
    '警告',
    `<p class="lg-bwarn">将删除全部 ${n} 笔${esc(IMP_LABEL)}导入的数据，且不可恢复</p>
    <div class="lg-impacts">
      <button class="btn btn-subtle" type="button" data-lg="impcancel">取消</button>
      <button class="btn btn-danger" type="button" data-lg="impclearok">确定</button>
    </div>`,
    {},
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：「警告」里那颗「确定」⇒ 真去整批清除（`DELETE /api/ledger/import?source=shark`）。
 *
 * 说明：⭐⭐ 成功后三件事：
 * 刷新那块概况（`loadImportSummary()`）—— 笔数归零、那行变回「还没导入过」；
 * **明细屏重取一遍**（`loadEntries(true)`）：那批行与两组合计都不在了，
 */
async function impClearOk() {
  try {
    const r = await api('DELETE', `/api/ledger/import?source=${IMP_SOURCE}`);
    const deleted = Number(r && r.deleted) || 0;
    impFile = null;
    impDraft = null;
    impResult = null;
    impBusy = false;
    await loadImportSummary();
    await loadEntries(true);
    paintLedgerSet();
    toast(`清掉了 ${deleted} 笔`);
  } catch (e) {
    toast(e.message, true);
  }
}


/**
 * 账户详情那一段「变动类型」过滤的四个档（§7.4：`all` / `entry` / `transfer` / `adjust`）。
 *
 */
const CHG_TYPES = [
  { key: 'all', name: '全部' },
  { key: 'entry', name: '记账' },
  { key: 'transfer', name: '转账' },
  { key: 'adjust', name: '调整余额' },
];

/**
 * 功能：按 id 从当前 `overview` 里找账户（找不到回 `null`）。
 * @param {number} id - 账户 id
 * @returns {?Object} 那个账户
 */
function acctOf(id) {
  const rid = Number(id) || 0;
  if (!rid) return null;
  return ((state.lg && state.lg.accounts) || []).find((x) => Number(x.id) === rid) || null;
}

/**
 * 功能：账户的显示名 —— 有后四位就带上（`工商银行(1904)`）。
 *
 * 说明：⚠️ 转账弹层、明细里的「对方账户」、详情卡标题全用它 ⇒ 三处同一个写法
 * （⛔ 别各拼一份：同一家银行在两处一个带后四位一个不带，看着像两个账户）。
 * @param {Object} a - 账户
 */
function labelOf(a) {
  return a && a.tail ? `${a.name}(${a.tail})` : String((a && a.name) || '');
}

/**
 * 功能：画账户详情里的一条**变动** —— 三类（记账 / 转账 / 手动调整）各画各的，颜色走三档令牌。
 *
 * 说明：⭐⭐ **三档颜色只住 `entry-calc.js` 的 `TONE_COLORS`**（C-21 / §7.4）：这一行只把
 * `toneStyle(type)` 返回的那一句 CSS 声明贴到元素上，CSS 里写 `color: var(--lg-tone-*)`
 * 而那两份色值还都是"对的"，没人会报错）。类名也由 `changeTone()` 给，⛔ 不手拼 `tone-*`。
 */
function chgRowHtml(c, a, names) {
  const cls = `lg-chgrow ${changeTone(c.type)}`;
  const st = toneStyle(c.type);
  if (c.type === 'transfer') {
    const { dir, peerId } = txOf(c, a.id);
    // 对方账户可能是**已删账户**（删账户不删转账，C-8）⇒ 走**同一个** `acctNameMap()`：
    // 「先活账户、查不到再查合并视图」这条顺序只住它那一处，⛔ 不在这里再判一遍。
    const name = names.get(Number(peerId)) || '已删除的账户';
    const sub = [shortAt(c.at), String(c.note || '')].filter(Boolean).join(' · ');
    // 「转出 / 转入」这几个字与符号各说一遍是**刻意的**：负债侧账户（信用卡）看着「转入」
    // 而欠款减少时，只给符号会读不通（1 期那次明细就是这个口径，⛔ 别在这里改掉）。
    return `<div class="${cls}" style="${st}">
      <span class="lg-chgmain"><b class="lg-chgtag">转账</b>${dir === 'out' ? '转出 · 到 ' : '转入 · 来自 '}${esc(name)}${
        sub ? `<i class="lg-sub">${esc(sub)}</i>` : ''
      }</span>
      <b class="lg-chgamt">${esc(fmtTx(c, a.id, state.lgHide))}</b>
    </div>`;
  }
  if (c.type === 'adjust') {
    return `<div class="${cls}" style="${st}">
      <span class="lg-chgmain"><b class="lg-chgtag">调整余额</b>
        <i class="lg-sub">${esc(shortAt(c.at))} · 从 ${esc(fmtFen(c.from_fen, state.lgHide))} 改成 ${esc(
          fmtFen(c.to_fen, state.lgHide),
        )}</i></span>
      <b class="lg-chgamt"></b>
    </div>`;
  }
  // 账户变动流里那一条也换成带日期的写法（同 `entryRowHtml()`），同样单独画红字。
  const rf = refundNoteOf(c, state.lgChg, state.lgHide);
  const parts = [];
  if (c.note) parts.push(String(c.note));
  return `<div class="${cls}" style="${st}">
    <span class="lg-chgmain"><b class="lg-chgtag">记账</b>${esc(entryTitle(c, state.lgCats))}${
      parts.length ? `<i class="lg-sub">${esc(parts.join(' · '))}</i>` : ''
    }${rf ? `<i class="lg-rfnote">${esc(rf)}</i>` : ''}</span>
    <b class="lg-chgamt">${esc(fmtSignedFen(signedFen(c.ie, c.amount_fen), state.lgHide))}</b>
  </div>`;
}

/**
 * 功能：账户详情月份下拉的选项 —— 出现过的年 ∩ **每月铺满 12 项**（`monthOptionsAll()`）。
 *
 * 说明：⭐ 年份集合仍由数据决定（有记录的月 / 今天 / 本次会话访问过 / 正在看的那个月），
 * 但**每一年都是完整 12 个月** ⇒ 没有记录的那个月也点得到。
 * @returns {Array.<string>} 月份键（`YYYY-MM`，倒序）
 */
function chgMonthOptions() {
  const todayMonth = monthOf((state.lg && state.lg.today) || '');
  // ：**主来源是服务端的
  // `/api/ledger/periods`**（`state.lgPeriods.months`：有数据的月，含**三方导入**的月）。
  // 光靠 `state.lgChg` 推不出来：它是**这一页明细**（接口一次只给一个月的 30 条）⇒
  const rows = [].concat(state.lgChg || [], (state.lgPeriods && state.lgPeriods.months) || [], state.lgMonths, [chgMonthKey()]);
  // **每一年铺满 12 个月**。以前只给"有记录的月"，于是"上个月没转账"就查不到上个月
  // （下拉里根本没有那一项，而它不报错）。
  return monthOptionsAll(rows, todayMonth);
}

/**
 * 功能：画明细那一块 —— **三态分得开**：读取中 / 读不到（一句人话 ＋ 重试） / 这个月没有。
 *
 * 说明：⭐⭐ 三态必须分开：「读取中」「一条都没有」「没读到」是**三件不同的事**——
 * 把失败画成空态＝把错误藏起来（用户会以为"我确实没转过账"）。⛔ 那条差错绝不能省。
 * ：**按天分组**显示 ——
 */
function chgListHtml(a) {
  if (state.lgChgLoad === 'error') {
    return (
      `<div class="lg-errbox"><div class="es-text">明细没读到 —— ${esc(
        state.lgChgErr || '原因不明',
      )}。这不等于「一笔都没有」。</div>` +
      '<button class="btn btn-subtle btn-sm" type="button" data-lg="chgretry">重试</button></div>'
    );
  }
  if (state.lgChgLoad === 'loading' && !state.lgChg.length) return '<div class="lg-txwait">正在读取…</div>';
  if (!state.lgChg.length) return '<div class="lg-txwait">这个月还没有记录 —— 记账 / 转账 / 调整都会出现在这里。</div>';
  const head = state.lgChgLoad === 'loading' ? '<div class="lg-txwait">正在读取…</div>' : '';
  // 2 期：明细里的转账行要取**对方账户**的名字（可能是已删账户）⇒ 与流水用同一份 map
  const names = acctNameMap();
  return head + groupByDay(state.lgChg, 'at').map((g) => chgDayHtml(g, a, names)).join('');
}

/**
 * 功能：明细里的**一天** —— 日期头（左边日期 ＋ 星期，右边这一天的收支小计）＋ 当天那几条变动。
 *
 * 说明：⚠️ 日期头的版式与流水屏 `.lg-eday` **同一套**（类名 / 文案都复用 `dayHeadLabel()`），
 * 不另起一个"账户详情专用的日期头"—— 同一个日子在两个屏上是两种写法是最没必要的漂移。
 * 掩码那个实参**必须逐字写 `state.lgHide`** —— `ttt/test/ledger.test.js` 有一条护栏
 */
function chgDayHtml(g, a, names) {
  const inc = Number(g.income_fen) || 0;
  const exp = Number(g.expense_fen) || 0;
  // 两个小计中间那个**全角空格**走 `join()` 的**字符串字面量**参数（与流水屏同一句）：
  // 不直接嵌进模板串、也⛔ 不抄进注释 —— `no-irregular-whitespace` 不跳过模板串与注释。
  const sum =
    inc || exp
      ? `<span>${esc([`收入: ${fmtFen(inc, state.lgHide)}`, `支出: ${fmtFen(exp, state.lgHide)}`].join('　'))}</span>`
      : '';
  const head = `<div class="lg-eday"><b>${esc(g.date ? dayHeadLabel(g.date) : '时刻缺失')}</b>${sum}</div>`;
  return head + g.items.map((c) => chgRowHtml(c, a, names)).join('');
}

/**
 * 功能：详情弹窗里那条「加载更多」（到底了 / 读不到时整条不画）。
 * @returns {string} 这一段的 HTML
 */
function chgMoreHtml() {
  if (state.lgChgLoad === 'loading' && state.lgChg.length) return '<div class="lg-txwait">正在读取…</div>';
  if (state.lgChgLoad !== 'done' || state.lgChgDone) return '';
  return '<div class="lg-emorewrap"><button class="btn btn-subtle btn-sm" type="button" data-lg="chgmore">加载更多</button></div>';
}

/**
 * 功能：画详情弹窗的正文（账户卡 ＋ 收支明细 ＋ 底部四颗动作）。
 *
 * 说明：⚠️ 四颗动作**都住正文里**（不是 `#modal-save`）：主按钮只有一个位置，
 * 而这里要的是「转账 / 调整余额 / 编辑 / 删除」四个各不相同的动作 ——
 * 与「管理分类」那一页同一种做法（主按钮退化成「关闭」）。
 */
function detailHtml(a, sides) {
  const m = metaOf(a.kind);
  const cur = chgMonthKey();
  const opts = chgMonthOptions()
    .map((k) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(monthLabel(k))}</option>`)
    .join('');
  const tOpts = CHG_TYPES.map(
    (t) => `<option value="${esc(t.key)}"${t.key === state.lgType ? ' selected' : ''}>${esc(t.name)}</option>`,
  ).join('');
  return `<div class="lg-detail">
    <div class="lg-dcard">
      ${eyeHtml()}
      <div class="lg-dtop">${icoBlockHtml(a)}
        <span class="lg-dmain"><b>${esc(labelOf(a))}</b><i class="lg-dtag">${esc(m.name)}</i></span>
      </div>
      ${a.note ? `<div class="lg-dnote">${esc(a.note)}</div>` : ''}
      ${limitBlockHtml(a)}
      <div class="lg-dbal">
        <span><b>${esc(fmtSide(a.opening_fen, sides.get(a.kind), state.lgHide))}</b><i>余额</i></span>
        <button class="btn btn-subtle btn-sm" type="button" data-lg="balance">调整余额</button>
      </div>
      <div class="lg-dhint">「调整余额」之前的记账将不会导致余额变化</div>
    </div>
    <div class="lg-txhead"><b>变动明细</b>
      <span class="lg-txfilters">
        <select id="lg-f-type">${tOpts}</select>
        <select id="lg-f-month">${opts}</select>
      </span>
    </div>
    <div class="lg-txlist">${chgListHtml(a)}${chgMoreHtml()}</div>
    <div class="lg-dacts">
      <button class="btn btn-subtle" type="button" data-lg="transfer">转账</button>
      <button class="btn btn-subtle" type="button" data-lg="edit" data-id="${Number(a.id)}">编辑</button>
      <button class="btn btn-danger" type="button" data-lg="remove" data-id="${Number(a.id)}">删除资产</button>
    </div>
  </div>`;
}

/**
 * 功能：把详情弹窗（按 `state.lgAcctId` 当前那一份数据）画出来。
 *
 * 说明：⚠️ 账户不在了（另一台设备上删的）就把弹窗关掉并说一句 —— ⛔ 别把一张空弹窗留在屏幕上。
 * @returns {void}
 */
function paintDetail() {
  const a = acctOf(state.lgAcctId);
  if (!a) {
    closeModal();
    state.lgAcctId = 0;
    state.lgChg = [];
    state.lgChgLoad = 'idle';
    toast('这个账户已经不在了', true);
    return;
  }
  // 加 `tall` —— 这一屏自己分层滚（账户卡 / 段头 / 底部三颗固定、中间那条明细自己滚），
  // 不让 `.modal-body` 再长一条整体滚动条（「去掉左侧的整体滑条」）。
  openModal('资产详情', detailHtml(a, sideMapOf(state.lg)), { wide: true, tall: true });
  // 这一页没有「保存」：每颗按钮自己就是一个动作 ⇒ 主按钮是「关闭」（与「管理分类」同款）
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：点「详情」⇒ 取这个账户的**变动明细**（记账 ＋ 转账 ＋ 调整，三类混排），再把详情弹窗画出来。
 *
 * 说明：⭐ 明细是**单独一次请求**（`GET /api/ledger/accounts/:id/changes`，§6.2）：一屏一次给全
 * 那条纪律管的是**列表屏**，而明细会随年月变长，塞进 `overview` 等于每次进列表都白拉一份。
 * 先弹一张「正在读取…」的壳：等请求回来才弹的话，网络一慢就是「点了没反应」。
 */
async function openDetail(id) {
  const rid = Number(id) || 0;
  if (!rid) return;
  // **换账户**时月份与类型筛选要一起归零：不清的话，上一个账户选中的月份 / 类型会跟过来，
  // 而 `state.lgChg` 那份数据还是上一个账户的 —— 画出来的是「别人的账」，且**不报任何错**。
  // 而**同一个账户**（转账 / 调整余额 / 记完一笔之后回详情）要**保住筛选**：
  const same = Number(state.lgAcctId) === rid && modalOpen();
  state.lgAcctId = rid;
  if (!same) {
    state.lgChgMonth = '';
    state.lgType = 'all';
  }
  state.lgChg = [];
  state.lgChgCursor = null;
  state.lgChgDone = false;
  openModal('资产详情', '<div class="lg-txwait">正在读取…</div>', { wide: true, tall: true });
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
  // ：月份下拉的主来源是
  // 服务端的期间清单（`/api/ledger/periods` 的 `months`，见 `chgMonthOptions()`）——
  // 第一次打开详情时顺手取一次。⚠️⭐ 它**不 await**（与明细那次请求并行发）：这里已经弹了
  if (!state.lgPeriods) {
    loadPeriods().then(() => {
      if (modalOpen() && Number(state.lgAcctId) === rid) paintDetail();
    });
  }
  await loadChanges(true);
}

/**
 * 功能：取一页「变动明细」（`GET /api/ledger/accounts/:id/changes`）—— 按月 ＋ 类型 ＋ **游标**。
 *
 * 说明：⭐⭐ 三类混排（记账 ＋ 转账 ＋ 手动调整）**一次请求拿全**，分页口径与流水逐字一致
 * （游标是**不透明串**，先 `parseCursor()` 验形状；认不出就当"没有游标"＝从头取，
 * 绝不把一个猜出来的值发上去 —— 那会**静默翻错页**）。
 */
async function loadChanges(reset) {
  const rid = Number(state.lgAcctId) || 0;
  if (!rid) return;
  if (reset) {
    state.lgChg = [];
    state.lgChgCursor = null;
    state.lgChgDone = false;
  }
  state.lgChgLoad = 'loading';
  state.lgChgErr = '';
  paintDetail();
  const month = chgMonthKey();
  const cur = parseCursor(state.lgChgCursor);
  let url =
    `/api/ledger/accounts/${rid}/changes?month=${encodeURIComponent(month)}` +
    `&type=${encodeURIComponent(state.lgType)}`;
  if (cur) url += `&before=${encodeURIComponent(buildCursor(cur.at, cur.id))}`;
  try {
    const r = await api('GET', url);
    if (Number(state.lgAcctId) !== rid || !modalOpen()) return;
    const rows = r && Array.isArray(r.changes) ? r.changes : [];
    state.lgChg = reset ? rows : state.lgChg.concat(rows);
    state.lgChgDone = rows.length < ENTRY_PAGE_SIZE;
    const last = rows[rows.length - 1];
    state.lgChgCursor = state.lgChgDone || !last ? null : buildCursor(last.at, last.id);
    rememberMonth(month);
    state.lgChgLoad = 'done';
  } catch (e) {
    if (Number(state.lgAcctId) !== rid || !modalOpen()) return;
    state.lgChgLoad = 'error';
    state.lgChgErr = e.message;
  }
  paintDetail();
}

/**
 * 功能：开「转账」弹窗（从详情进来，转出账户就是当前这个账户）。
 *
 * 说明：⚠️ 金额**不自己画数字键盘**（桌面上就是一个普通输入框）；⚠️ 服务器那边的两条硬规则
 * （余额要够 / 卡上的欠款要够）原样把文案弹给用户，⛔ 前端不预判、不重复实现。
 * @returns {void}
 */
function openTransfer() {
  const a = acctOf(state.lgAcctId);
  if (!a) return;
  const others = ((state.lg && state.lg.accounts) || []).filter((x) => Number(x.id) !== Number(a.id));
  if (!others.length) {
    toast('还没有别的账户可以转 —— 先加一个', true);
    return;
  }
  const opts = others.map((x) => `<option value="${Number(x.id)}">${esc(labelOf(x))}</option>`).join('');
  openModal(
    '转账',
    `<div class="lg-form">
      <div class="lg-xfrom"><span>转出账户</span><b>${esc(labelOf(a))}</b>
        <i>余额 ${esc(fmtSide(a.opening_fen, sideMapOf(state.lg).get(a.kind), state.lgHide))}</i></div>
      <div class="tt-field"><label for="lg-f-to">转入账户</label><select id="lg-f-to">${opts}</select></div>
      <div class="tt-field"><label for="lg-f-xamt">转账金额</label>
        <input id="lg-f-xamt" type="text" inputmode="decimal" /></div>
      <div class="tt-field"><label for="lg-f-xnote">备注（可以空着）</label>
        <input id="lg-f-xnote" type="text" maxlength="${NOTE_MAX}" /></div>
      <div class="tt-tip">转账只是把钱从一个账户挪到另一个账户，不是收入也不是支出 —— 净资产一分都不会变。</div>
    </div>`,
    {},
  );
  setModalSave('确认转账（Enter）', false);
  $('#modal-save').onclick = saveTransfer;
  const el = $('#lg-f-xamt');
  if (el) el.focus();
}

/**
 * 功能：提交转账 —— ⛔ **金额的校验交给服务端**（唯一一份判据）。
 *
 * 说明：⚠️ 本地只拦「金额空着」这一条**表单语义**检查；串原样发上去，服务端判不过就 400。
 * 成功后**两次重取**：`lgRefresh()`（余额 / 净值 / 分组全变了）＋ `openDetail()`
 * （刚转的那笔要出现在明细最上面）—— 少哪一次都会「界面上还显示着转账前的样子」。
 */
async function saveTransfer() {
  const a = acctOf(state.lgAcctId);
  if (!a) return;
  const to = Number(($('#lg-f-to') || {}).value || 0);
  const amt = String(($('#lg-f-xamt') || {}).value || '').trim();
  const note = String(($('#lg-f-xnote') || {}).value || '').trim();
  if (!to) {
    toast('选一个转给谁', true);
    return;
  }
  if (!amt) {
    toast('填一下转多少', true);
    const el = $('#lg-f-xamt');
    if (el) el.focus();
    return;
  }
  try {
    await api('POST', '/api/ledger/transfers', { from_id: Number(a.id), to_id: to, amount: amt, note });
    toast('转好了');
    await lgRefresh();
    await openDetail(a.id);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：开「调整余额」弹窗（照参考图 1 卡上那颗按钮）。
 *
 * 说明：⚠️ 走**既有的逐键改**接口（`PUT /api/ledger/accounts/:id` 只带 `opening`）——
 * 不为它单开一个接口（那会造出第二条「金额怎么解析」的路径）。
 * @returns {void}
 */
function openBalance() {
  const a = acctOf(state.lgAcctId);
  if (!a) return;
  openModal(
    '调整余额',
    `<div class="lg-form"><div class="tt-field"><label for="lg-f-bal">余额</label>
       <input id="lg-f-bal" type="text" inputmode="decimal" value="${esc(fenToInput(a.opening_fen))}" /></div>
     <div class="tt-tip">改的是这个账户<b>现在有多少钱</b>；记账那一期上线后它作为期初余额，之后再往上加收支。</div>
     <div class="tt-tip">⚠️ 这次改动会在明细里留一条<b>调整记录</b>（琥珀色那条）—— 那条记录<b>不能删、也不能改</b>：
       它记的是"这个账户在那一天被手动改成了多少"，是余额的来路。</div></div>`,
    {},
  );
  setModalSave('保存（Enter）', false);
  $('#modal-save').onclick = saveBalance;
  const el = $('#lg-f-bal');
  if (el) {
    el.focus();
    el.select();
  }
}

/**
 * 功能：存下新的余额（⛔ 格式校验同样交给服务端）。
 * @returns {Promise.<void>}
 */
async function saveBalance() {
  const a = acctOf(state.lgAcctId);
  if (!a) return;
  const el = $('#lg-f-bal');
  const v = String((el && el.value) || '').trim();
  if (!v) {
    toast('填一下金额（没有就填 0）', true);
    if (el) el.focus();
    return;
  }
  try {
    await api('PUT', `/api/ledger/accounts/${Number(a.id)}`, { opening: v });
    toast('改好了');
    await lgRefresh();
    await openDetail(a.id);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 弹窗：添加 / 编辑（左九类竖排 + 右表单） ----------

/**
 * 功能：画「所在银行 / 银行 · 平台」那颗下拉 —— 按 `optionsFor(kind)` 分组渲染。
 *
 * 说明：⚠️ 用**原生 `<select>`**（⛔ 不自画下拉；课表那两颗自画下拉是它自己的组件）。
 * 选项**从 `BANKS` / `CREDIT_PLATFORMS` 生成**（⛔ 不在这里手抄名字）⇒ 加一家银行
 * 只改 `calc.js` 一处，两端同时生效。
 */
function pickSelectHtml(kind, value) {
  const o = optionsFor(kind);
  if (!o) return '';
  const one = (v, text) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(text)}</option>`;
  const groups = o.groups
    .map((g) => {
      const items = g.items.map((b) => one(b.name, b.name)).join('');
      return g.label ? `<optgroup label="${esc(g.label)}">${items}</optgroup>` : items;
    })
    .join('');
  return `<select id="lg-f-pick">${one('', '请选择')}${groups}${one(PICK_OTHER, '其它（自己输入）')}</select>`;
}

/**
 * 功能：把弹窗正文画出来 —— 左边九类竖排、右边表单。
 *
 * 说明：⚠️ 字段结构用 `.tt-field`（`.fld` 在**电脑端** `app.css` 里没有定义 ——
 * 「后四位」那一格**先按当前类型决定显不显示**，换类型时由 `paintKind()` 就地切
 * `hidden` class（⛔ 不重画整个弹窗 —— 重画会把已经填好的内容与光标一起抹掉）。
 */
/**
 */
function tierSelectHtml(cur) {
  const c = String(cur || '');
  const opts = [`<option value="">不填</option>`]
    .concat(TIERS.map((t) => `<option value="${t}"${t === c ? ' selected' : ''}>${t} 类</option>`))
    .join('');
  return `<select id="lg-f-tier">${opts}</select>`;
}

/**
 * 功能：详情卡上那段「分级 ＋ 已设的限额」—— 一条都没设时回空串（⛔ 不画一行空的）。
 * @param {Object} a - 一个账户
 * @returns {string} 那一段的 HTML（或空串）
 */
function limitBlockHtml(a) {
  const lines = limitLinesOf(a);
  if (!lines.length) return '';
  const body = lines.map((l) => `<span><i>${esc(l.label)}</i>${esc(l.value)}</span>`).join('');
  return `<div class="lg-dmeta">${body}</div>`;
}
function formHtml(d) {
  const kinds = KIND_ORDER.map((k) => {
    const m = metaOf(k);
    return `<button class="lg-kind${k === d.kind ? ' on' : ''}" type="button" data-lg="type" data-kind="${k}">
      <span class="lg-ico" style="--lg-c:${m.color}">${m.icon}</span><span>${esc(m.name)}</span>
    </button>`;
  }).join('');
  const m = metaOf(d.kind);
  const shape = pickShapeOf(d.kind, d.name);
  const editing = Number(d.id) > 0;
  return `<div class="lg-modal">
    <div class="lg-kinds">${kinds}</div>
    <div class="lg-form">
      <div class="tt-field${shape.needPick ? '' : ' hidden'}" id="lg-f-pickwrap">
        <label for="lg-f-pick" id="lg-f-picklabel">${esc(m.nameLabel)}</label>
        ${pickSelectHtml(d.kind, shape.select)}</div>
      <div class="tt-field${shape.nameHidden ? ' hidden' : ''}" id="lg-f-namewrap">
        <label for="lg-f-name" id="lg-f-namelabel">${esc(shape.needPick ? '自己填' : m.nameLabel)}</label>
        <input id="lg-f-name" type="text" maxlength="${NAME_MAX}" value="${esc(shape.value)}" /></div>
      <div class="tt-field${needTailOf(d.kind) ? '' : ' hidden'}" id="lg-f-tailwrap"><label for="lg-f-tail">${esc(tailLabelOf(d.kind))}（可以空着）</label>
        <input id="lg-f-tail" type="text" maxlength="4" inputmode="numeric" value="${esc(d.tail)}" /></div>
      <div class="tt-field${needLimitOf(d.kind) ? '' : ' hidden'}" id="lg-f-limitwrap">
        <label for="lg-f-tier">分级（可以空着）</label>
        ${tierSelectHtml(d.tier)}
        <div class="lg-limits-cap">限额不填就是不限</div>
        <div class="lg-limits">
          <div><label for="lg-f-limd">日限额</label>
            <input id="lg-f-limd" type="text" inputmode="decimal" value="${esc(d.limitDay)}" /></div>
          <div><label for="lg-f-limm">月限额</label>
            <input id="lg-f-limm" type="text" inputmode="decimal" value="${esc(d.limitMonth)}" /></div>
          <div><label for="lg-f-limy">年限额</label>
            <input id="lg-f-limy" type="text" inputmode="decimal" value="${esc(d.limitYear)}" /></div>
        </div></div>
      <div class="tt-field"><label for="lg-f-note">备注（可以空着）</label>
        <input id="lg-f-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" /></div>
      ${tagFieldsHtml(d)}
      <div class="tt-field"><label for="lg-f-opening">余额</label>
        <input id="lg-f-opening" type="text" inputmode="decimal" value="${esc(d.opening)}" /></div>
      <div class="tt-tip">账户初始化余额</div>
      ${
        editing
          ? `<div class="lg-danger"><button class="btn btn-danger btn-sm" type="button" data-lg="remove" data-id="${Number(d.id)}">删除这个账户</button></div>`
          : ''
      }
    </div>
  </div>`;
}

/**
 * 功能：给输入框里的值做一次「读回草稿」—— 保存前与换类型前都要做。
 *
 * 说明：⚠️⭐ 类型换成不需要「后四位」的那几类时，那一格是**藏起来**的 ⇒ 这时候必须把它当空
 * 选了具体一家就是那家，选「其它」才是文本框里那个，**没选（空串）一律当空**
 *
 */
function captureForm(d) {
  const bankWrap = $('#lg-f-pickwrap');
  const bankSel = $('#lg-f-pick');
  const name = $('#lg-f-name');
  if (bankWrap && bankSel && !bankWrap.classList.contains('hidden')) {
    const v = String(bankSel.value || '');
    d.name = v === PICK_OTHER ? (name ? String(name.value || '').trim() : '') : v;
  } else if (name) {
    d.name = String(name.value || '').trim();
  }
  const wrap = $('#lg-f-tailwrap');
  const tail = $('#lg-f-tail');
  d.tail = tail && wrap && !wrap.classList.contains('hidden') ? String(tail.value || '').trim() : '';
  const note = $('#lg-f-note');
  if (note) d.note = String(note.value || '').trim();
  const opening = $('#lg-f-opening');
  if (opening) d.opening = String(opening.value || '').trim();
  // 卡属性：分级 ＋ 三个限额。⚠️ 与「后四位」同一条纪律：类型不需要这几格时（现金 / 投资…）
  // 那一整块是 **hidden** 的 ⇒ 必须当成**清空**，⛔ 别把看不见的旧值一路带过去
  // （「储蓄卡改成现金」会留下一个谁也没机会看见的分级）。
  const needLimit = needLimitOf(d.kind);
  const tierSel = $('#lg-f-tier');
  d.tier = needLimit && tierSel ? String(tierSel.value || '') : '';
  // 选择器**必须带 #**：写成裸的 'lg-f-limd' 会被当成**标签名** ⇒ $() 永远回 null ⇒
  // 这三个值静默变成空串（服务端按「清空」写成 null），而分级那格照旧读得到 ——
  // 两个分支只差一个 #，单测与结构断言都看不出来（探针里「真填真存」才逮住）。
  for (const [key, sel] of [
    ['limitDay', '#lg-f-limd'],
    ['limitMonth', '#lg-f-limm'],
    ['limitYear', '#lg-f-limy'],
  ]) {
    const el = $(sel);
    d[key] = needLimit && el ? String(el.value || '').trim() : '';
  }
  // 分类（按用途）：每套一格 —— 选了具体用途就是它；「＋ 新建用途…」那时读的是那个输入框；
  // 空（含「不分类」）＝ 把这套的用途清掉（服务端那边就是把那一行删掉）
  const tags = {};
  // 必须用 `tagViewList()`（⛔ 不是 `viewList()`）：这里若把「按账户类型」也送上去，
  // 服务端 `applyTags()` 对 `builtin === 1` **一律 400**（不看值）⇒
  // **新建与修改全都保存不了**（报的「保存都不行」+ 红 toast 就是这个）。
  for (const v of tagViewList()) {
    const inp = $(`#lg-f-tagnew-${v.id}`);
    const sel = $(`#lg-f-tag-${v.id}`);
    const raw = inp ? String(inp.value || '') : String((sel && sel.value) || '');
    tags[v.id] = raw === '__new__' ? '' : raw.trim();
  }
  d.tags = tags;
}

/**
 * 功能：下拉换了值 —— 只切「自己填」那一格的显隐，⛔ 不重画弹窗（重画会把别的字段与光标一起抹掉）。
 *
 * 说明：⚠️ 选了具体一家时**刻意不清空**那个文本框：用户改主意又选回「其它」时，刚才打的字还在。
 * 而它**不会漏进保存**：银行形态下 `captureForm()` 取的是下拉的值（见上）。
 *
 */
function pickFollow(v) {
  const wrap = $('#lg-f-namewrap');
  if (wrap) wrap.classList.toggle('hidden', v !== PICK_OTHER);
  if (v === PICK_OTHER) {
    const input = $('#lg-f-name');
    if (input) input.focus();
  }
}

/**
 * 功能：把「当前类型」画到弹窗上 —— 左侧那一颗高亮、银行那一格**重画**、后四位那一格显隐、
 * 名字那一格按新形态回填。
 *
 * 说明：⚠️⭐⭐ **银行那一格必须「重画内容」，不能只切 `hidden`**（真机报的
 * 「怎么选不了银行」就是这个）：`formHtml()` 是按**弹窗打开那一刻的类型**画的 ——
 */
function paintKind(kind) {
  const m = metaOf(kind);
  const shape = pickShapeOf(kind, draft ? draft.name : '');
  const bankWrap = $('#lg-f-pickwrap');
  if (bankWrap) {
    bankWrap.classList.toggle('hidden', !shape.needPick);
    bankWrap.innerHTML = shape.needPick
      ? `<label for="lg-f-pick" id="lg-f-picklabel">${esc(m.nameLabel)}</label>` +
        `${pickSelectHtml(kind, shape.select)}`
      : '';
  }
  const nameLab = $('#lg-f-namelabel');
  if (nameLab) nameLab.textContent = shape.needPick ? '自己填' : m.nameLabel;
  const nameWrap = $('#lg-f-namewrap');
  if (nameWrap) nameWrap.classList.toggle('hidden', shape.nameHidden);
  const nameInput = $('#lg-f-name');
  if (nameInput) nameInput.value = shape.value;
  const tailWrap = $('#lg-f-tailwrap');
  if (tailWrap) tailWrap.classList.toggle('hidden', !needTailOf(kind));
  const limitWrap = $('#lg-f-limitwrap');
  if (limitWrap) limitWrap.classList.toggle('hidden', !needLimitOf(kind));
  document
    .querySelectorAll('#modal-body [data-lg="type"]')
    .forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
}

/**
 * 功能：开「添加 / 编辑」弹窗（`id` 为空 = 添加）。
 * @param {number} id - 要改的那个账户 id（0 / NaN = 新建）
 * @returns {void}
 */
function openForm(id) {
  const rid = Number(id) || 0;
  const row = rid ? ((state.lg && state.lg.accounts) || []).find((x) => Number(x.id) === rid) : null;
  if (rid && !row) return;
  draft = row
    ? {
        id: Number(row.id),
        kind: row.kind,
        name: row.name,
        tail: row.tail,
        note: row.note,
        opening: fenToInput(row.opening_fen),
        tier: String(row.tier || ''),
        limitDay: row.limit_day_fen == null ? '' : fenToInput(row.limit_day_fen),
        limitMonth: row.limit_month_fen == null ? '' : fenToInput(row.limit_month_fen),
        limitYear: row.limit_year_fen == null ? '' : fenToInput(row.limit_year_fen),
        tags: row.tags || {},
      }
    : { id: 0, kind: 'cash', name: '', tail: '', note: '', opening: '', tier: '', limitDay: '', limitMonth: '', limitYear: '', tags: {} };

  const editing = Number(draft.id) > 0;
  openModal(editing ? '改这个账户' : '添加账户', formHtml(draft), { wide: true });
  setModalSave(editing ? '保存（Enter）' : '记下来（Enter）', false);
  $('#modal-save').onclick = saveForm;
}

/**
 * 功能：在弹窗里换了类型 —— **先把填好的值读回草稿**，再只改受影响的那几处（⛔ 不重画弹窗）。
 * @param {string} kind - 类型键
 * @returns {void}
 */
function pickKind(kind) {
  if (!draft || !KIND_ORDER.includes(kind)) return;
  captureForm(draft);
  draft.kind = kind;
  paintKind(kind);
}

/**
 * 功能：保存（新建或编辑）—— ⛔ 金额的**格式校验交给服务端**（唯一一份判据）。
 *
 * 说明：⚠️ 本地只拦「名称不能空」这一条**表单语义**检查；金额串原样发上去，
 * 服务端判不过就 400，那句文案原样弹给用户。
 * @returns {Promise.<void>}
 */
async function saveForm() {
  if (!draft) return;
  captureForm(draft);
  if (!draft.name) {
    // 储蓄卡 / 信用卡的空名字有**两条**路：下拉选一家，或选「其它」自己填 ——
    // 文案要把两条路都说出来（只说「给它起个名字吧」等于没说：用户看不到该动哪儿），
    // 并把光标送到**该动的那一个**上。⚠️ 这条仍只是**表单语义**检查，⛔ 没碰服务端的判据。
    const sel = $('#lg-f-pick');
    const bankWrap = $('#lg-f-pickwrap');
    const inBank = !!(sel && bankWrap && !bankWrap.classList.contains('hidden'));
    toast(inBank ? '先选一家银行，或选「其它」自己填' : '给它起个名字吧', true);
    const target = inBank && String(sel.value || '') !== PICK_OTHER ? sel : $('#lg-f-name');
    if (target) target.focus();
    return;
  }
  const editing = Number(draft.id) > 0;
  const body = {
    kind: draft.kind,
    name: draft.name,
    tail: draft.tail,
    note: draft.note,
    opening: draft.opening,
    tier: draft.tier,
    limit_day: draft.limitDay,
    limit_month: draft.limitMonth,
    limit_year: draft.limitYear,
    tags: draft.tags || {},
  };
  try {
    if (editing) await api('PUT', `/api/ledger/accounts/${Number(draft.id)}`, body);
    else await api('POST', '/api/ledger/accounts', body);
    closeModal();
    draft = null;
    await lgRefresh();
    toast(editing ? '改好了' : '记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：删除这个账户（**危险确认**）—— 文案要说清两件事：「历史净值不会被改写」与
 * 「它名下的记录都会保留」（与服务端 `ledgerDeleteAccount` 的真实行为一致）。
 *
 * 说明：⭐⭐ 2 期起**文案必须改**：1 期那句「与它有关的转账记录会一起删掉」在新版本里
 * **已经是假的** —— 服务端一个原语里「先写删除记录（留档原名）、后硬删账户行」，
 */
function askRemove(id) {
  openConfirmModal(
    '删除这个账户',
    '<div class="es-text">删了就找不回来了。⚠️ 历史净值不会被改写 —— 那些天记下的是「你当时有多少钱」，删一个账户不会把它改掉。' +
      '✅ <b>它名下的记账 / 转账 / 调整记录都会保留</b>（记的是"那笔钱确实动过"这件事）；' +
      '只是从今往后这一屏不再列它，那些记录里的账户名也不再随它改名。</div>',
    '永久删除',
    async () => {
      await api('DELETE', `/api/ledger/accounts/${Number(id)}`);
      closeModal();
      draft = null;
      state.lgAcctId = 0;
      state.lgChg = [];
      state.lgChgLoad = 'idle';
      // 2 期：删完账户**先刷新取名口**（它刚进删除记录表 ⇒ 它的原名从这一刻起只能从这里取），
      // 再重取一屏。⚠️ 顺序反了的话，这一屏画出来的是"没有它名字的那一版"，而且**不报错**。
      await ensureAcctNames();
      await lgRefresh();
      toast('已删除');
    },
  );
}

/**
 * 功能：绑记账这一屏与它那个弹窗的事件委托（各挂一次）。
 *
 * 说明：⚠️ 两棵子树要**分别**挂：屏内的按钮在 `#ledger-view` 里（每次重画都换新节点），
 * 弹窗正文在 `#modal-body` 里（弹窗是另一个容器）—— 挂在同一个选择器上必然漏一边，
 * 而漏的那一边表现是「点了没反应」，且**不报错**。
 */

/**
 * 功能：一次拖动里「可以互换位置」的那些兄弟元素 —— 三类各成一组，⛔ 不能混着数。
 *
 * 说明：⚠️ 账户**只在同一个 `.lg-group` 内**换位：跨组换位等于改它的用途，那是另一件事
 * 组标题只看 `.lg-list` 里的：列表屏与弹窗里都可能有别的 `[data-drag]`。
 *
 */
function dragSiblings(el) {
  const kind = String((el.dataset && el.dataset.drag) || '');
  if (kind === 'chip') return [...el.parentElement.querySelectorAll('[data-drag="chip"]')];
  if (kind === 'group') {
    const list = el.closest('.lg-list') || el.parentElement;
    return [...list.querySelectorAll('[data-drag="group"]')];
  }
  const box = el.closest('.lg-group');
  return box ? [...box.querySelectorAll('[data-drag="acct"]')] : [];
}

/**
 * 功能：把一次拖动提交给服务端，然后重取这一屏。
 * @param {string} kind - 拖的类型（`data-drag` 的值）
 * @param {Array.<HTMLElement>} siblings - 兄弟元素（按拖动前的顺序）
 * @param {number} from - 原下标
 * @param {number} to - 目标下标
 */
/**
 */
function tagViewIdOf() {
  const views = (state.lg && state.lg.views) || [];
  const cur = views.find((v) => Number(v.id) === Number(state.lgView)) || null;
  if (!cur) return 0;
  return Number(cur.builtin) === 1 ? 0 : Number(cur.id) || 0;
}
async function commitOrder(kind, siblings, from, to) {
  const ids = siblings.map((el) => Number(kind === 'group' ? el.dataset.gid : el.dataset.did));
  const base = ((state.lg && state.lg.accounts) || []).map((a) => Number(a.id));
  const body = reorderPayload(kind, ids, from, to, base, tagViewIdOf());
  if (!body) return;
  try {
    await api('POST', '/api/ledger/reorder', body);
  } catch (e) {
    toast(e.message, true);
  }
  // 成功失败都重取：失败时这一下正好把顺序拉回真相
  // （⛔ 别让屏上停着一个没提交成功的顺序 —— 那比「没拖动」难查得多）
  await lgRefresh();
}

/** 正在拖的元素（`null` = 没在拖） */
let dragSrc = null;
/** 当前落点（拖过它身上那个元素） */
let dragOver = null;

/**
 * 功能：绑这一屏的拖动排序（桌面端走 HTML5 拖拽；手机端在 `mobile.js` 里走长按）。
 * @param {HTMLElement} box - 这一屏的常驻容器
 * @returns {void}
 */
function bindDragSort(box) {
  box.addEventListener('dragstart', (e) => {
    const n = e.target.closest('[data-drag]');
    if (!n) return;
    dragSrc = n;
    dragOver = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // 不给 data 的话 Firefox 根本不派发后续的 drag 事件（内容随便给个非空串）
      e.dataTransfer.setData('text/plain', 'lg');
    }
    n.classList.add('lg-dragsrc');
  });
  box.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    const n = e.target.closest(`[data-drag="${String(dragSrc.dataset.drag)}"]`);
    if (n && n !== dragSrc && dragSiblings(dragSrc).includes(n) && n !== dragOver) {
      if (dragOver) dragOver.classList.remove('lg-drop');
      dragOver = n;
      n.classList.add('lg-drop');
    }
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    const d = dragSrc;
    const o = dragOver;
    dragSrc = null;
    dragOver = null;
    if (!d || !o) return;
    const siblings = dragSiblings(d);
    const from = siblings.indexOf(d);
    const to = siblings.indexOf(o);
    d.classList.remove('lg-dragsrc');
    o.classList.remove('lg-drop');
    if (from < 0 || to < 0 || from === to) return;
    commitOrder(String(d.dataset.drag), siblings, from, to);
  });
  box.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('lg-dragsrc');
    if (dragOver) dragOver.classList.remove('lg-drop');
    dragSrc = null;
    dragOver = null;
  });
}

export function bindLedgerEvents() {
  const box = $('#ledger-view');
  // 日期 / 时间控件：点任意处都开系统选择器（只挂一次，见 `core/native-picker.js`）
  bindNativePickerOnce();
  // 挂载一次就是一颗**新的** `#ledger-view`（片段重建它）⇒
  // 判据是「**节点身份**」而不是一个布尔量（见 `ledgerViewNode` 的说明）。
  if (box && box !== ledgerViewNode) {
    ledgerViewNode = box;
    box.addEventListener('click', (e) => {
      const n = e.target.closest('[data-lg]');
      if (!n) return;
      const act = n.dataset.lg;
      if (act === 'add') return openForm(0);
      // 行尾那颗「详情」开的是**账户详情**（不再是编辑表单）
      if (act === 'detail') return openDetail(Number(n.dataset.id));
      // 眼睛：翻转只读态、重画列表，并把选择记进账号偏好（弹窗开着的话，弹窗里那几个数
      // 也跟着它 —— 但那要等下一次重画；详情弹窗本身那颗眼睛有它自己那条分支，见下面）。
      if (act === 'eye') {
        pickEye();
        lgRender();
        return undefined;
      }
      // 换个视图看：只重画列表、**不重新取数**（overview 一次就给全了）
      if (act === 'view') {
        state.lgView = Number(n.dataset.id) || 0;
        lgRender();
        return undefined;
      }
      // ：三态切换（资产 / 负债 / 净资产）—— 同一份数据换个口径看，
      // 不重新取数（换**年**才要取，那条走下面那个 `<select>` 的 `change`）。
      if (act === 'range') return pickRange(String(n.dataset.range || ''));
      // 点走势图上某一个点 ⇒ 在横轴下面那一行显示「几月 · 多少钱」。
      // 命中圈住在 `#ledger-view` 里（走势卡就是那一屏的一块）⇒ 这条分支接得到它。
      if (act === 'tdot') return pickTrendDot(n);
      if (act === 'viewmore') return openViewManage();
      // ---------- ⭐ 记账 2 期：屏内那排分段控件与「记一笔」那一侧的动作 ----------
      // （选中态住 `state.lgSeg`）：资产那一侧是 overview 一次给全，
      // 流水进来时 `openLedger()` 已经取过。
      if (act === 'seg') {
        const seg = String(n.dataset.seg || '');
        if (!SEG_KEYS.includes(seg)) return undefined;
        if (state.lgSeg !== seg) {
          state.lgSeg = seg;
          // 换格时把「月详情页」这个**子屏**清掉（它挂在「账单」那一格之下）——
          // 不清的话：从月详情点顶部「预算」，再切回「账单」，画出来的还是月详情（⛔ 而且不报错）。
          state.lgMdMonth = 0;
          if (seg === 'budget') {
            openBudget();
            return undefined;
          }
          // 「账单」升成一级格 ⇒ 换到它时也要把这一格的数据取回来
          // （与预算那条同款：**取数是这一格自己的事**）。
          // 两栏 ⇒ 表格与图表两份一起取（见 `loadBillScreen()`）。
          if (seg === 'bill') {
            loadBillScreen();
            return undefined;
          }
          if (seg === 'detail' && state.lgLoad === 'idle') {
            return loadEntries(true);
          }
          lgRender();
        }
        return undefined;
      }
      // 顶部那一行右侧那颗「＋ 记一笔」（**常驻**，三个段都点得到）——
      if (act === 'entryadd') return openEntry();
      // ：点流水行**整行**进详情（行上挂的是 `data-lg="erow"`）——
      // 行尾那颗「记退款」是同一棵子树里的**另一个** `[data-lg]`，`closest()` 先命中它
      // ⇒ 同一个委托按 `act` 分派就自然分开了，⛔ 不需要 `stopPropagation`（那样反而会丢动作）。
      if (act === 'erow') return openEntryDetail(Number(n.dataset.id));
      // 三方导入：点一条**导入行** ⇒ 开**只读**详情（⛔ 没有编辑 /
      // 删除 —— 只读，撤走走设置里那条「整批清除」）。⚠️ 与自有流水那一行同一条路：
      // 整行挂 `data-lg`，`closest()` 命中谁就分派给谁（⛔ 不用 `stopPropagation`）。
      if (act === 'impitem') return openImpDetail(Number(n.dataset.id));
      // 这三颗都是**取数**动作：重试＝从第一页重取（把三态从 error 拉回来）；加载更多＝游标往后取一页
      if (act === 'entryretry') return loadEntries(true);
      if (act === 'entrymore') return loadEntries(false);
      // 退款入口画在**条目行**上（§7.2 / C-24）：点开的是"给这一笔退多少"，⛔ 不是新开一笔记账
      if (act === 'refund') return openRefund(Number(n.dataset.id));
      // 记账设置（顶部那颗 `⋯`，C-11）—— 电脑端是**宽弹窗**，2 期暂时只有【收支账户】一栏
      if (act === 'ledgerset') return openLedgerSet();
      // 那三颗里**两颗接上了真跳转** ——
      // 双圆环 ⇒ 跳到**对话模块里的 AI 助手**（与手机端**同一套规矩**：先切到对话、
      // 再由对话模块兑现 `slot` —— 电脑端本来跳的是 AI 独立视图，「对话里的那个助手」）；
      if (act === 'aihelp') {
        document.dispatchEvent(
          new CustomEvent('zx:open-module', { detail: { mod: 'teamwork', slot: 'ai' } }),
        );
        return undefined;
      }
      if (act === 'gocal') {
        // 日历**不再有自己的屏**了 —— 它现在是**首页看板的第二个视图**。
        // ⇒ 这一颗改成「打开首页看板 + 进日历视图」：`mod: 'home'` 是看板（不是模块），
        // `slot` 是「要看哪个模块贡献的视图」。
        document.dispatchEvent(new CustomEvent('zx:open-module', { detail: { mod: 'home', slot: 'calendar' } }));
        return undefined;
      }
      // **搜索**那颗 ⇒ 打开「搜索流水」弹窗（「搜索功能完善」）。
      if (act === 'search') return openSearch();
      // 弹窗里点那两列**不换数据**，只有「确定」那一下才真的换月（`monthPickOk()`）。
      if (act === 'monthpick') {
        // 这里必须接住并说出来 —— 「点了没反应」等于没有报错，用户只能报「坏了」。
        openMonthPick().catch((e) => toast(`选月弹窗没打开：${(e && e.message) || e}`, true));
        return undefined;
      }
      // 「账单」升成**一级格**了（「明细中的账单独立出来，账单放到明细后面」）⇒
      // 明细里那颗「账单」按钮、以及账单屏自带的「‹ 返回」那颗**都已撤掉**：
      // 进它 / 出它都走顶部那一格（上面 `seg` 那条分支），⛔ 这里不再有 `bill` / `billback` 两个键。
      if (act === 'billshift') return lgBillShift(n);
      if (act === 'billtab') {
        const k = String(n.dataset.tab || '');
        if (!PERIOD_TYPES.includes(k) || k === billTabOf()) return undefined;
        state.lgBillTab = k;
        state.lgBillKey = '';
        // 两栏（表格 ＋ 图表）同时显示 ⇒ 换档时**两份一起重取**
        // （从前是按 `lgBillTab2` 只取当前那一档，见 `loadBillScreen()`）。
        return loadBillScreen();
      }
      // 「读不到 ⇒ 重新加载」那颗（`errBoxHtml()` 给的动作名）
      if (act === 'chartretry') return loadChart();
      // ：
      // 口径的两颗按键 —— ⭐ 仍是**只重画、⛔ 不重取数**（服务端 `/chart` 一次把两侧都给回来了，
      // ）；⚠️ 对应的 `<select>` 与它那条 `change` 分支**已撤**（见上面那段说明）。
      if (act === 'chartdir') {
        const v = chartDirOf(n.dataset.dir);
        if (v !== chartDirOf(state.lgChartDir)) {
          state.lgChartDir = v;
          lgRender();
        }
        return undefined;
      }
      // 账单表格行尾那颗 `›`（只有月档有）⇒ 进月详情（T41）。
      // 行上传的是 `period_key`（`YYYY-MM-01`），这一屏要的是 `month`（`YYYY-MM`）⇒
      // 只在这里切掉最后三位（⛔ 不另存一份月）。判据认不出就**什么都不做**（⛔ 别放过未知键）。
      if (act === 'mdopen') {
        const key = String(n.dataset.key || '');
        if (!/^\d{4}-\d{2}/.test(key)) return undefined;
        state.lgMdMonth = key.slice(0, 7);
        state.lgMd = null;
        state.lgMdLoad = 'idle';
        return loadMonthBill();
      }
      if (act === 'mdback') return lgMdBack();
      // 预算屏那三档 —— 与账单那条同款：换档 = 换期 ⇒ 复位 `period_key` 并重取。
      // 点**已经在的那一档**时：数据在手（done）就不白跑一趟；但**读不到时点了要能重来**
      // （它同时是「读不到」那颗重试的落点 —— 这一格没有第二个进屏动作）。
      if (act === 'budgettab') {
        const k = String(n.dataset.tab || '');
        if (!PERIOD_TYPES.includes(k)) return undefined;
        const same = k === budgetTabOf();
        if (same && state.lgBudgetLoad === 'done') return undefined;
        if (!same) state.lgBudgetKey = '';
        state.lgBudgetTab = k;
        return loadBudget();
      }
      // 「编辑」**不是**直接开输入框（图 7）：先弹动作单（`data-mode="menu"`）；
      // 动作单里那行「编辑XX预算」与空态那颗「设置总预算」才是 `amount`（开额度弹窗）。
      if (act === 'budgetedit') return pickBudgetEdit(n);
      // `budgetadd` 那条委托**随 `.lg-badd` 那颗通栏按钮一起撤了** ——
      // 添加分类预算现在走屏级那颗悬浮「＋」（`paintAssetsFab('budget')` 里**直接调**
      // `openBudgetAdd()`，⛔ 不经这条委托）。⚠️ 哪天把通栏按钮加回来，这一行也得跟着回来。
      return undefined;
    });
    // 拖动排序（账户行 / 组标题 / 分类胶囊 —— 桌面端走 HTML5 拖拽）
    bindDragSort(box);
    // ：年度下拉是原生 `<select>` —— 它换值走 `change`，**不冒泡 click**
    // （⛔ 上面那条委托接不到它）。⚠️ 换年**要重新取数**（那一年的快照不在手上）。
    box.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.id === 'lg-f-year') {
        state.lgYear = Number(t.value) || 0;
        lgRefresh().catch((err) => toast(err.message, true));
      }
      // ：图表那颗**口径**下拉（支出 / 收入）—— ⭐⭐ **只重画、⛔ 不重取数**
      // （服务端 `/chart` 一次把两侧都给回来了，见 `ledgerChart()`）。
      // **这一段已撤** —— 口径换成两颗按键（`data-lg="chartdir"`，走 `click` 那条委托）。
      if (t && t.id === 'lg-bill-year') {
        state.lgBillKey = `${Number(t.value) || 0}-01-01`;
        return loadBillScreen();
      }
      return undefined;
    });
  }
  // 滚到列表底部自动取下一 30 条（§7.3）—— 它与底下那颗「加载更多」是**同一条路的两入口**。
  // 滚动容器**不是 `window`**：挂在 window 上永远不触发，表现是"滚到底什么也不发生"，
  // 而且**不报任何错**。
  if (!mainScrollBound) {
    const main = document.querySelector('.main');
    if (main) {
      mainScrollBound = true;
      main.addEventListener('scroll', maybeLoadMore, { passive: true, capture: true });
    }
  }
  bindLedgerModalEvents();
}

/**
 * 功能：**弹窗那一侧**的事件委托 —— `#modal-body` 是 `index.html` 里的静态节点，只挂一次。
 *
 * 说明：⚠️⭐ 它与 `#ledger-view` 那条是**两棵子树**（弹窗挂在 `.main` 的兄弟上），必须各挂一处，
 * ⇒ 那一条改成「按节点身份重挂」，**这一条留在原地、仍只挂一次**（重挂 = 同一个动作触发两次）。
 *
 */
function bindLedgerModalEvents() {
  if (ledgerModalBound) return;
  ledgerModalBound = true;
  const mbody = $('#modal-body');
  if (mbody) {
    // 详情弹窗自己那个滚动容器（`.modal-card` 限高 88vh、`.modal-body` 才滚）——
    // 它的「加载更多」同样要能滚到就触发，⛔ 别指望 `.main` 那条能接到弹窗里的滚动。
    if (!mbody.dataset.lgChgScroll) {
      mbody.dataset.lgChgScroll = '1';
      mbody.addEventListener('scroll', maybeLoadChgMore, { passive: true });
    }
    // 备注框边打边筛候选（`matchNote` 做本地即时过滤，⛔ 不再发一次请求）。
    // 用 `input` 而不是 `change`：`change` 要等失焦才冒泡，看起来就是"候选不跟着变"。
    mbody.addEventListener('input', (e) => {
      const t = e.target;
      if (t && t.id === 'lg-ed-note') paintNoteChips();
      return undefined;
    });
    // 「选择月份」弹窗里「年」那一列 —— 换年之后把「月」那一列的选中态摆正。
    // 起月那一列**恒 12 项**、不再跟年变，所以这里不再"重画候选"，只校正 `selected`。
    // 弹窗里那颗 `<select>` 冒泡不到 `#ledger-view` 那条 `change`（两棵子树各挂一处）。
    mbody.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.id === 'lg-mp-year') paintMpMonths();
      return undefined;
    });
    mbody.addEventListener('click', (e) => {
      const n = e.target.closest('[data-lg]');
      if (!n) return;
      const act = n.dataset.lg;
      if (act === 'type') return pickKind(String(n.dataset.kind || ''));
      if (act === 'remove') return askRemove(Number(n.dataset.id));
      // 详情弹窗里的那几颗动作
      // 详情弹窗里的「编辑」**必须在这里接住**：行尾那颗按钮的 `data-lg` 已经从 `edit`
      // 改成了 `detail`，而 `.lg-dacts` 里那颗「编辑」用的是 `edit` ——
      if (act === 'edit') return openForm(Number(n.dataset.id));
      if (act === 'eye') {
        pickEye();
        paintDetail();
        return undefined;
      }
      if (act === 'transfer') return openTransfer();
      if (act === 'balance') return openBalance();
      if (act === 'viewnew') return openViewName('new', 0);
      if (act === 'viewren') return openViewName('ren', Number(n.dataset.id));
      if (act === 'viewdel') return askRemoveView(Number(n.dataset.id));
      // 内置「按账户用途」那些字段的改名 / 增删（入口在「管理分类」那一页）
      if (act === 'usagenew') return openUsageName(0);
      if (act === 'usageren') return openUsageName(Number(n.dataset.id));
      if (act === 'usagedel') return askRemoveUsage(Number(n.dataset.id));
      // 这些动作全住在 `#modal-body` 里，⛔ 上面 `#ledger-view` 那条委托接不到
      // （两棵子树各挂一处，漏一边的表现是"点了没反应"，且不报错 —— 见本函数说明）。
      if (act === 'edie') return edPickIe(String(n.dataset.ie || ''));
      if (act === 'edcat') return edPickCat(String(n.dataset.cid || '0'));
      // 二级屏的「‹ 返回」：停在那个一级分类上（二级**可以不选**， 第 8 条）
      if (act === 'edback') {
        edCapture();
        if (state.lgDraft) state.lgDraft.second = 0;
        return paintEd();
      }
      // 取消要**连草稿一起清**：不清的话下次「记一笔」会把上回没提交的那份填回来；
      // 而「改一笔」的取消是**回到刚看的那张详情**（不是弹回列表 —— 那是"点错了就回不去"）
      if (act === 'edcancel') {
        state.lgDraft = null;
        state.lgNotes = [];
        if (editId) {
          const back = editId;
          editId = 0;
          return openEntryDetail(back);
        }
        return closeModal();
      }
      if (act === 'ednote') return edPickNote(String(n.dataset.note || ''));
      if (act === 'chgretry') return loadChanges(true);
      if (act === 'chgmore') return loadChanges(false);
      // 这些动作全住在 `#modal-body` 里（与上面那段同一条纪律：两棵子树各挂一处）
      if (act === 'ededit') return openEntryEdit(Number(n.dataset.id));
      if (act === 'edel') return askRemoveEntry(Number(n.dataset.id));
      // 详情里的「记退款」与列表行上那颗是**同一个动作、同一个键** —— 那条分支在上面的
      // `#ledger-view` 委托里（接不到弹窗）；⛔ 漏了这一行的表现是「点了没反应」且不报错。
      if (act === 'refund') return openRefund(Number(n.dataset.id));
      // 收支分类：新建一级 / 新建二级 / 改名 / 归档 / 恢复 / 永久删除
      // （归档那两个 mode 见 `askArchiveCat`；删除那层确认见 `openCatDel`）
      if (act === 'catadd') return openCatName('top', 0, '');
      // ：一级行那颗 `▸ N` / `▾ N`
      // 开关 —— 只翻 `state.lgCatOpen` 里的一个键，然后**只重画这一栏**（⛔ 不重开弹窗：
      // 重开一次会把用户滚到的位置弹回顶部，那一栏还长）。
      if (act === 'cattoggle') {
        const cid = Number(n.dataset.id) || 0;
        if (!cid) return undefined;
        if (state.lgCatOpen[cid]) delete state.lgCatOpen[cid];
        else state.lgCatOpen[cid] = true;
        const box = $('#modal-body .lg-catman');
        if (box) box.innerHTML = catManageHtml();
        return undefined;
      }
      if (act === 'catnew') return openCatName('sub', Number(n.dataset.id));
      if (act === 'catren') return openCatName('ren', Number(n.dataset.id));
      if (act === 'catarch') return askArchiveCat(Number(n.dataset.id), String(n.dataset.mode || ''));
      if (act === 'catgo') return askArchiveCat(Number(n.dataset.id), String(n.dataset.mode || ''));
      // 已归档的自定义分类 —— 「恢复」当场生效（⛔ 不要二次确认）；「删除」先过确认层
      if (act === 'catunarch') return restoreCat(Number(n.dataset.id));
      if (act === 'catdel') return openCatDel(Number(n.dataset.id));
      // 设置【收支账户】—— 底部那颗「＋ 新增」（给一个还没设过的类别单设默认账户）
      // ＋ 已设行尾那颗 ✕（清掉这一条，回到"跟随全局默认"）。
      if (act === 'setdefadd') return openCatDefault();
      if (act === 'setdefclear')
        return submitDefaults({ categories: { [String(Number(n.dataset.cid))]: null } }, '改好了');
      // 「恢复内置分类」—— 危险动作，先开确认页（手打「恢复」二字），见 `openRestoreBuiltin()`
      if (act === 'catrestore') return openRestoreBuiltin();
      // 它们与上面那些一样只住在 `#modal-body`，⛔ `#ledger-view` 那条委托接不到
      // （两棵子树各挂一处，漏一边的表现是"点了没反应"，且不报错 —— 见本函数说明）。
      if (act === 'budgetedit') return pickBudgetEdit(n);
      if (act === 'budgetclear') return pickBudgetClear(n);
      // 这些动作全住在 `#modal-body` 里（设置弹窗与向导共用同一个弹窗正文）——
      // 与上面那几段同一条纪律：两棵子树各挂一处，漏一边的表现是"点了没反应"，且不报错。
      // 键名与手机端**同名**（去掉 `lg-` 前缀），⛔ 别自造第二套说法。
      if (act === 'impopen') return impOpen();
      if (act === 'impretry') return impRetry();
      if (act === 'impcancel') return impCancel();
      if (act === 'impgo') return impGo();
      if (act === 'impgodetail') return impGoDetail();
      if (act === 'impclear') return impClear();
      if (act === 'impclearok') return impClearOk();
      // 这两颗住在设置弹窗的正文里（`setHomeHtml()` / `setPageBodyHtml()`）——
      // 与上面那几段同一条纪律：`#ledger-view` 那条委托接不到弹窗里，漏一边的表现是
      // "点了没反应"，且**不报错**（`ttt/test/ledger.test.js` 有护栏逐个核这件事）。
      if (act === 'setgo') return goLedgerSetPage(String(n.dataset.page || ''));
      if (act === 'setback') return backLedgerSetPage();
      // 与上面那两颗同一条纪律：它们住在设置弹窗正文里（`setPageBodyHtml('exp')`），
      // 两棵子树各挂一处，漏一边的表现是"点了没反应"，且**不报错**。
      // 键名与手机端**同名**（去掉 `lg-` 前缀）：手机端是 `lg-exp-what` / `lg-exp-dl`。
      if (act === 'expwhat') return pickExportWhat(n);
      if (act === 'expdate') return openExportDate(n, e);
      if (act === 'expdl') return downloadExports();
      return undefined;
    });
    // 「所在银行」是一颗原生 `<select>` —— 它换值走 `change`，**不冒泡 click**
    // （⛔ 上面那条委托接不到它）。挂在同一个常驻容器上，同样只挂一次。
    mbody.addEventListener('change', (e) => {
      const t = e.target;
      if (!t) return undefined;
      if (t.id === 'lg-f-pick') return pickFollow(String(t.value || ''));
      if (t.dataset && t.dataset.lg === 'tagsel' && String(t.value) === '__new__') return askNewTag(t);
      // 设置【收支账户】那三处**换值即提交**（这一页从此没有「保存」了，
      // 见 `setAcctHtml()` 的说明）。⛔ 别把它们改回"攒着一起提交"——
      // 两套保存路径的下场是"从某一个入口改的存不进去"，而且不报错。
      if (t.id === 'lg-def-income') return commitGlobalDefault('income_id', String(t.value || ''));
      if (t.id === 'lg-def-expense') return commitGlobalDefault('expense_id', String(t.value || ''));
      // 设置【导出数据】那一页的**开始 / 结束时间**两颗原生日期框 —— 走 `change`
      // 不冒泡 `click`（上面那条动作委托接不到它们）；只改 state 再重画（⛔ 不发请求）。
      if (t.id === 'lg-exp-from' || t.id === 'lg-exp-to') return pickExportDate(t.id, String(t.value || ''));
      // 「每类别默认账户」那一排下拉：值是账户 id，空串 = 跟随全局默认 ⇒ 清掉那一条。
      // 它同时是 `ttt/test/ledger.test.js` 那条护栏（逐个核"挂出去的 `data-lg` 有没有处理分支"）
      // 要认的那一条 —— ⛔ 别为了省一行把它删了。
      if (t.dataset && t.dataset.lg === 'defacct') return commitCatDefault(Number(t.dataset.cid), String(t.value || ''));
      // 账户详情那两颗下拉（月份 / 变动类型）—— **都要重新取数**：
      // 换月的话那个月的变动根本不在手上；换类型的话服务端只回那一类（前端不回本地筛，
      if (t.id === 'lg-f-month') {
        state.lgChgMonth = String(t.value || '');
        return loadChanges(true);
      }
      if (t.id === 'lg-f-type') {
        state.lgType = String(t.value || 'all');
        return loadChanges(true);
      }
      return undefined;
    });
  }
}

// ============================================================================
// 记账 3 期：明细屏 / 账单屏 / 月详情页 / 预算屏
// 与手机端**逐字同一条口径**：两端各画一份视图，

/**
 * 功能：服务端的「今天」—— 这一节每一次取数都要用它（期间起点 / 月份默认值）。
 *
 * 说明：⭐⭐ `today` 一律取**服务端权威**那一份（`overview.today`，/ C-3）——
 * 绝不拿本机 `new Date()`：用户设备的日期不可信，跨零点会把账写进错的那一期。
 * 取不到时回空串 ⇒ 调用方据此落进「读不到」（⛔ 不猜一个日期兜上去）。
 */
function todayOf() {
  return String((state.lg && state.lg.today) || '');
}

/**
 * 功能：一个分类的**回落色**（`id % 色板长度` ⇒ 同一个分类每次都是同一个颜色）。
 *
 * 说明：⭐ 判据**只住这一处**：明细行那颗小图标、月详情的饼图与占比表、预算块的
 * 分类图标都要用它 —— 几处各写一遍 `% CAT_COLORS.length`，迟早会漂成"同一个分类在
 * 几个地方几种颜色"，而它**不报错**（与手机端 `catColorOf()` 同一条口径）。
 */
function catColorOf(catId) {
  return CAT_COLORS[Math.abs(Number(catId) || 0) % CAT_COLORS.length];
}

/**
 * 功能：子屏（账单 / 月详情）**自带的「‹ 返回」头**。
 *
 * 说明：⭐ 电脑端做一颗**返回按钮**（T34：「手机端用返回手势、电脑端更好搞了做一个返回按钮」）——
 * 这两个子屏都长在「明细」那一格之下，⛔ 不压宿主的历史栈、⛔ 不换屏。
 * @param {string} act - 返回那颗按钮的动作名（`billback` / `mdback`）
 */
function subHeadHtml(act, title) {
  return `<div class="lg-xhead">
    <button class="lg-xback" type="button" data-lg="${esc(act)}">‹ 返回</button>
    <b>${esc(title)}</b>
  </div>`;
}

/**
 * 功能：「读不到 ＋ 重试」那一块（三态里的 error）—— ⛔ 绝不画成空态 / 还没设。
 * @param {string} what - 读的是什么（「账单」/「这个月的账单」/「预算」）
 * @param {string} msg - 失败原因（用户能看的那句话）
 * @param {string} act - 重试那颗按钮的动作名（`bill` / `mdopen` / `budgettab`）
 * 月详情 / 预算那两处**必须**带上（重试时动作要知道"重取哪一期"）。
 */
function errBoxHtml(what, msg, act, attrs) {
  return `<div class="lg-errbox"><div class="es-text">${esc(what)}没读到 —— ${esc(
    msg || '原因不明',
  )}。这不等于「没有」。</div>
    <button class="btn btn-subtle btn-sm" type="button" data-lg="${esc(act)}"${attrs || ''}>重新加载</button></div>`;
}

/**
 * 功能：三档（周 / 月 / 年）在账单 / 预算两种页面上的档名 —— `周账单` / `月预算` 之类。
 *
 * 说明：⚠️ 段名的字序只有这一处：`周 / 月 / 年` × `账单 / 预算`。⛔ 不在两个渲染函数里各拼一遍
 * （各写一遍必然漂成"账单页写「周」、预算页写「本週」"这种没人报得出来的分歧）。
 * @param {string} kind - `'bill'` 账单 / `'budget'` 预算
 */
function periodTabLabel(kind, type) {
  const word = type === 'week' ? '周' : type === 'year' ? '年' : '月';
  return word + (kind === 'bill' ? '账单' : '预算');
}

// ============================================================================
// ① 明细屏（图 1 / 图 8）—— ⭐ 默认格（T32）
// ============================================================================

/** AI 助手那颗圆环（左上）—— 单色线性 SVG，颜色由 CSS 的 `currentColor` 给。 @type {string} */
const ICO_AI =
  '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/>' +
  '<circle cx="12" cy="12" r="3.1"/></svg>';

/** 放大镜（右上，搜索）—— ⚠️ 本期**只是图标**（点了弹一句「开发中，敬请期待~」）。 @type {string} */
const ICO_SEARCH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/>' +
  '<path d="M15.4 15.4 20 20"/></svg>';

/** 日历（右上）—— 同上，本期只是图标。 @type {string} */
const ICO_CAL =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3.6" y="5.4" width="16.8" height="15" rx="2.4"/><path d="M3.6 10h16.8"/>' +
  '<path d="M8 3.6v3.4M16 3.6v3.4"/></svg>';

/**
 * 功能：画「明细」那一格（版式权威 = 参考图 1 / 图 8）。
 *
 * ① 顶部**工具行**：左侧 AI 圆环、右侧放大镜与日历 —— ⭐ **三颗都只弹一句
 * 「开发中，敬请期待~」、⛔ 一个请求都不发**（记账是**零出网**模块）；
 * ② **年月选择**：一颗**按钮**（`data-lg="monthpick"`）⇒ 开「选择月份」弹窗（图 8：年 ｜ 月
 */
function detailPaneHtml() {
  const cur = monthKey();
  const s = state.lgSum || null;
  // 合计还没到手（首次读取中 / 读不到）⇒ 画 `—`：⛔ 不画 0.00（那是"这个月一分没有"，
  // 而真相是"还没读到"——三态必须分得开）。金额一律 `fmtFen`（掩码只住它一处）。
  const money = (fen) => (s ? esc(fmtFen(fen, state.lgHide)) : '—');
  return `<div class="lg-dpane">
    <div class="lg-dtools">
      <button class="lg-ai" type="button" data-lg="aihelp" aria-label="AI 助手">${ICO_AI}</button>
      <span class="lg-dtools-sp"></span>
      <button class="lg-dico" type="button" data-lg="search" aria-label="搜索">${ICO_SEARCH}</button>
      <button class="lg-dico" type="button" data-lg="gocal" aria-label="日历">${ICO_CAL}</button>
    </div>
    <div class="lg-dsum">
      <button class="lg-dmonth" type="button" data-lg="monthpick" aria-label="选择月份">${esc(
        monthLabel(cur),
      )}<i>▾</i></button>
      <div class="lg-dsum-cols">
        <div><span>收入</span><b>${money(s ? s.income_fen : 0)}</b></div>
        <div><span>支出</span><b>${money(s ? s.expense_fen : 0)}</b></div>
 <!-- ⭐ 0.8.9 修订（「移除所有的退款红色字体 …… 退款不算入退款当天
             收支小计里面，是在原消费那一条里用红色字体写：某月某号已退款 金额」）——
             ⇒ 这张卡上**不再有**「退款」那一栏，只剩收入与支出两个数。
             ⚠️ 退款**本来就没进这两个数**（支出是原额）—— 所以钱的算法一个字没动，
             只是不再在这里汇总显示；它现在只在**退的那一笔原消费**那一行露面。 -->
      </div>
      ${eyeHtml()}
    </div>
 <!-- ⭐⭐ 0.8.21（「这个【加载更多】不是一开始就显示，而是滑动到底后出现」）：
         「加载更多」画进流水列表里面（原来挂在它外面、是这一格的兄弟）
         —— 它是这一格的滚动内容，只有滚到列表底部才看得到。
         ⚠️ 从前那条路是「列表滚、按钮钉在列表下面」⇒ 刚进屏就顶在屏幕下沿，像一颗常驻按钮。 -->
    <div class="lg-elist">${entryGroupsHtml()}${entryMoreHtml()}</div>
  </div>`;
}


/**
 * 功能：「选择月份」弹层里「年」那一列有哪些年 —— **已知的年 ∪ 今天那一年**（升序）。
 *
 * 说明：⚠️⭐ 口径**与 `entryMonthOptions()` 同源**（有记录的月 ∪ 服务端今天那个月）——
 * bug）」⇒ 这里也不铺「今年 ±5 年」那种范围。
 * @returns {Array.<number>} 年份（升序）
 */
function mpYears() {
  const known = [];
  // 主来源是服务端的 `/api/ledger/periods`（含**三方导入**的行）⇒ 导入进来的老账才选得到。
  for (const y of (state.lgPeriods && state.lgPeriods.years) || []) known.push(String(y));
  // （期间清单取不到时不能只剩今天那一年）。
  for (const k of entryMonthOptions()) known.push(String(k).slice(0, 4));
  // **连续区间**（已知年 ∪ 今天，前后各补 5 / 1 年）—— 只列"有记录的年"时，
  return pickerYears(known, todayOf());
}

/**
 * 功能：「选择月份」弹层里「月」那一列 —— **恒为 12 项**（`MONTHS_ALL`）。
 *
 * 于是一个月只记过一次账的人，选择器里就只有一个 `11月`，别的月根本点不到（界面也不报错）。
 * 现在与「年」解耦：**月永远是 1~12**，挑到没记账的月看到的是明细屏的空态那句话。
 * @returns {Array.<number>} 月份（`1~12`，升序）
 */
function mpMonths() {
  return MONTHS_ALL;
}

/** 功能：那一列里某一个月写什么（`9` → `09月`，与明细屏那颗按钮上 `2026年09月` 同一口径）。 @param {number} m - 月份 @returns {string} @since */
function mpMonthLabel(m) {
  return `${String(Number(m)).padStart(2, '0')}月`;
}

/**
 * 功能：重画「月」那一列（保留当前选中的月）。
 *
 * 这个函数留着只为一件事：弹窗打开时/换年时把 `.selected` 摆正 —— 万一某个浏览器
 * 在 `insertAdjacentHTML` 之后没把 `selected` 认下来，值就对不上（而它**不报错**）。
 * 只重画这一列的 `<option>`（⛔ 不重开整个弹窗：重开会把年的选择一起弹回去）。
 */
function paintMpMonths() {
  const box = $('#lg-mp-month');
  if (!box) return;
  const months = mpMonths();
  const cur = months.includes(Number(box.value)) ? Number(box.value) : months[0] || 0;
  box.innerHTML = months
    .map((m) => `<option value="${m}"${m === cur ? ' selected' : ''}>${esc(mpMonthLabel(m))}</option>`)
    .join('');
}

/**
 * 功能：点明细屏那颗年月 ⇒ 开「选择月份」弹窗（图 8：年 ｜ 月 两列 ＋ 一颗 `确定`）。
 *
 * 说明：⚠️ 初值 = 当前**正在看的**那个月（`monthKey()`），⛔ 不是"今天"（用户翻到 7 月再点开，
 * 电脑端那两列是**原生 `<select>`**（照 1 期那颗年份下拉那条路：换值走 `change`、
 * 不冒泡 click）—— 动那两列**不换数据、不关弹窗**，点「确定」那一下才真的换月。
 */
async function openMonthPick() {
  await loadPeriods();
  const cur = monthKey();
  const cy = Number(cur.slice(0, 4)) || Number(todayOf().slice(0, 4)) || 0;
  const cm = Number(cur.slice(5, 7)) || Number(todayOf().slice(5, 7)) || 1;
  const years = [...mpYears()];
  if (cy && !years.includes(cy)) years.push(cy);
  // 必须先**拷一份**：`mpMonths()` 返回的是 `MONTHS_ALL`（`Object.freeze` 冻结的常量），
  // 在冻结数组上 `push` / `sort` 会就地写 ⇒ 抛 `TypeError: Cannot assign to read only property`
  // ⇒ 整个 `openMonthPick()` 直接 reject ⇒ **点了年月按钮毫无反应**（而且不报错）。
  const months = [...mpMonths()];
  if (cm && !months.includes(cm)) months.push(cm);
  const yo = years
    .sort((a, b) => a - b)
    .map((y) => `<option value="${y}"${y === cy ? ' selected' : ''}>${y}年</option>`)
    .join('');
  const mo = months
    .sort((a, b) => a - b)
    .map((m) => `<option value="${m}"${m === cm ? ' selected' : ''}>${esc(mpMonthLabel(m))}</option>`)
    .join('');
  openModal(
    '选择月份',
    `<div class="lg-mpick">
      <select class="lg-mpfld" id="lg-mp-year" aria-label="选择年">${yo}</select>
      <select class="lg-mpfld" id="lg-mp-month" aria-label="选择月">${mo}</select>
    </div>`,
    {},
  );
  setModalSave('确定', false);
  $('#modal-save').onclick = monthPickOk;
}

/**
 * 功能：「选择月份」那颗「确定」⇒ 换月并**重新取一次流水**（换的就是明细格看的那个月）。
 *
 * 说明：⭐⭐ 换月**必须重取**（`loadEntries(true)`）：那个月的数据根本不在手上
 * （⛔ 不是"从手上这份里筛"—— 手上只有当前这一页 30 条，筛出来永远只有一小截）。
 * 选中的还是同一个月（或认不出）⇒ **不重取**（关掉弹窗就好，别白跑一趟、也别把
 */
async function monthPickOk() {
  const yEl = $('#lg-mp-year');
  const mEl = $('#lg-mp-month');
  const y = Number(yEl ? yEl.value : 0) || 0;
  const m = Number(mEl ? mEl.value : 0) || 0;
  const key = `${y}-${String(m).padStart(2, '0')}`;
  closeModal();
  if (!/^\d{4}-\d{2}$/.test(key) || key === monthKey()) return;
  state.lgMonth = key;
  await loadEntries(true);
}

// ============================================================================
// ② 账单屏（图 2）—— ⭐ 明细那颗「账单」进的**新屏**（T34：电脑端一颗返回按钮）
// ============================================================================

/**
 * 功能：账单屏当前那一档（`'week'` / `'month'` / `'year'`）。
 *
 * 说明：⚠️ 认不出一律回落 `'month'` —— ⭐ **它就是默认档**（C-19：照图 2 的选中态）。
 * 白名单走 `calc.js` 的 `PERIOD_TYPES`（⛔ 不在这里再手写一遍 `['week','month','year']`）。
 * @returns {string} 三档之一
 */
function billTabOf() {
  const k = String(state.lgBillTab || '');
  return PERIOD_TYPES.includes(k) ? k : 'month';
}

/**
 * 功能：账单屏当前这一期的 `period_key`（**该期起始日** `YYYY-MM-DD`）。
 *
 * 说明：⭐ 服务端要的就是「该期起始日」，折算是 `calc.js` 的 `periodKeyOf()`（判据只住那一处）；
 * 用户换过期（`state.lgBillKey`）就用他换的那个。
 * **周档的键与月档同形**（都是该月 1 号）—— 把周账单从「本周」改成
 */
function billPeriodKey() {
  return String(state.lgBillKey || '') || billKeyOf(billTabOf());
}

/**
 * 功能：账单这一档「当前该看哪一期」的键 —— ⚠️ 周档与月档**同一个形状**（该月 1 号）。
 * @param {string} type - `week` / `month` / `year`
 * @returns {string} 该期起始日 `YYYY-MM-DD`
 */
function billKeyOf(type) {
  return periodKeyOf(type === 'week' ? 'month' : type, todayOf());
}

/** 功能：周档那颗「‹ 2026年09月 ›」（换看哪个月的周）—— 与手机端逐字同款。 @returns {string} @since */
function billMonthSwitchHtml() {
  const raw = String(state.lgBillKey || '');
  const cur = /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 7) : String(todayOf()).slice(0, 7);
  return `<div class="lg-bmon">
    <button class="lg-bmonbtn" type="button" data-lg="billshift" data-delta="-1" aria-label="上一个月">‹</button>
    <b>${esc(`${cur.slice(0, 4)}年${cur.slice(5, 7)}月`)}</b>
    <button class="lg-bmonbtn" type="button" data-lg="billshift" data-delta="1" aria-label="下一个月">›</button>
  </div>`;
}

/**
 *
 * @param {HTMLElement} n - 那颗按钮（`data-delta` = `-1` / `1`）
 */
async function lgBillShift(n) {
  const delta = Number((n && n.dataset && n.dataset.delta) || 0);
  if (!delta) return undefined;
  const cur = String(billPeriodKey()).slice(0, 7) || String(todayOf()).slice(0, 7);
  const next = shiftMonth(cur, delta);
  if (!/^\d{4}-\d{2}$/.test(next) || next === cur) return undefined;
  // 夹的是**年份区间**（与「选择月份」同一口径），⛔ 不再是「有数据的月」区间 ——
  const yrs = pickerYears(
    (state.lgPeriods && state.lgPeriods.years) || [],
    todayOf(),
  );
  if (yrs.length) {
    const lo = `${yrs[0]}-01`;
    const hi = `${yrs[yrs.length - 1]}-12`;
    if (next < lo || next > hi) return undefined;
  }
  state.lgBillKey = `${next}-01`;
  // 两栏同时显示 ⇒ 两份一起重取（见 `loadBillScreen()`）
  return loadBillScreen();
}

/**
 * 功能：月账单那颗「年份」下拉里的年份 —— **连续区间**（降序）。
 *
 * 说明：⚠️⭐ 主来源是 `state.lgPeriods.years` 与 `state.lg.years`（后者＝服务端算的
 * 「今年 ∪ 有过快照的年」），再并上「正在看的那一年」与**今天那一年**。
 * 区间**连续**（前后各补 5 / 1 年）—— 原先只给"有记账的年"，
 */
function billYears() {
  const known = [];
  // 主来源换成服务端的 `/api/ledger/periods`（`state.lgPeriods.years`）——
  // 它含**三方导入**的行 ⇒ 从鲨鱼记账导进来的 2024 / 2025 年在这儿才选得到
  // （`state.lg.years` 只从**快照**推，导入的年进不去）。
  for (const y of (state.lgPeriods && state.lgPeriods.years) || []) known.push(String(y));
  for (const y of (state.lg && state.lg.years) || []) known.push(String(y));
  known.push(String(state.lgBillKey || '').slice(0, 4));
  // 与「选择月份」同一口径 —— **连续区间**（已知年 ∪ 今天，前后各补 5 / 1 年）。
  // 只列"有记账的年"时，一整年没记账的年份选不到（同一条投诉的另一面）。
  return pickerYears(known, todayOf()).sort((a, b) => b - a);
}

/**
 *
 * 说明：⭐ 行上没有 `label`：`key` 是该子期的**起始日** ⇒ 月档 `YYYY-MM-01` → `9月`、
 */
function billRowLabel(periodType, key) {
  const s = String(key || '');
  if (periodType === 'year') return `${s.slice(0, 4)}年`;
  // 周档一行 = 某一周 ⇒ 写清这一周是哪几天到哪几天（「本周」只有一个）。
  if (periodType === 'week') return weekRangeLabel(s);
  return `${Number(s.slice(5, 7))}月`;
}

/**
 * 功能：取一次账单屏一屏（`GET /api/ledger/bill`）并重画 —— **三档共用**（靠 `period_type` 分派）。
 *
 * 说明：⚠️ 进入这一屏（点明细那颗「账单」）与换档 / 换年都走它；失败**不抛**（画「读不到 ＋ 重试」），
 * 绝不画成"这一档还没有数据"。
 * @returns {Promise.<void>}
 */
async function loadBill() {
  // 进账单屏时顺手取一次**期间清单**（年份下拉的主来源，它含三方导入的年）——
  // 电脑端现在是两栏同时显示、`loadChart()` 本来就会取，这一行是**兜底**
  // （⛔ 别删：哪天图表那一栏被撤掉，年份下拉会跟着只剩「今年」一项，而它**不报错**）。
  if (!state.lgPeriods) loadPeriods();
  state.lgBillLoad = 'loading';
  state.lgBillErr = '';
  lgRender();
  const type = billTabOf();
  const key = billPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/bill?period_type=${encodeURIComponent(type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgBill = (r && r.bill) || null;
    state.lgBillLoad = 'done';
  } catch (e) {
    state.lgBill = null;
    state.lgBillLoad = 'error';
    state.lgBillErr = e.message;
  }
  lgRender();
}

/**
 * 功能：取账单那一格**两栏都要的两份数** —— 表格（`/bill`）＋ 图表（`/chart`）。
 *
 * 这一格改成左右两栏**同时**显示 ⇒ 「换档 / 换年 / 周档换月」这三处**必须两份一起取**
 * （从前是"切到哪一档就只取哪一份"，靠 `lgBillTab2` 分派）。
 * 那份副档（`state.lgBillTab2`）与那颗「列表 ｜ 图表」药丸在电脑端**已经撤了**
 */
function loadBillScreen() {
  return Promise.all([loadBill(), loadChart()]);
}

/**
 *
 * 说明：⭐⭐ 在**合并流**（自有 ＋ 三方导入）里按 备注 / 分类 / 来源 / 金额 的子串找，最新在前。
 */
function openSearch() {
  openModal(
    '搜索流水',
    `<div class="lg-scap">按 备注 / 分类 / 来源 / 金额 找，三方导入的也在里面。</div>` +
      `<input class="lg-sinput" id="lg-search-q" type="text" autocomplete="off" aria-label="搜索关键字">` +
      `<div class="lg-sres" id="lg-search-out"><div class="lg-txwait">输入关键字开始搜。</div></div>`,
  );
  // 主按钮退化成「关闭」：这一屏**没有可保存的东西**（搜索是只读的）
  setModalSave('关闭', false);
  const btn = $('#modal-save');
  if (btn) btn.onclick = closeModal;
  const inp = $('#lg-search-q');
  if (!inp) return;
  inp.addEventListener('input', () => searchInputChanged(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchInputChanged(inp.value, true);
    }
  });
  inp.focus();
}

/** 搜索输入的防抖定时器（`0` = 空闲）。 @type {number} */
let searchTimer = 0;

/**
 * 功能：搜索框内容变了 —— 防抖 250ms（打字过程中**不发**请求）。
 * @param {string} v - 输入框当前的值
 * @param {boolean} [now] - true = 立刻搜（回车）
 * @returns {void}
 */
function searchInputChanged(v, now) {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = 0;
  }
  if (now) return void runSearch(v);
  searchTimer = setTimeout(() => {
    searchTimer = 0;
    runSearch(v);
  }, 250);
}

/**
 * 功能：真去搜一次并画结果（`GET /api/ledger/search`）。
 * @param {string} q - 关键字
 * @returns {Promise.<void>}
 */
async function runSearch(q) {
  const kw = String(q || '').trim();
  const seq = Number(state.lgSearchSeq || 0) + 1;
  state.lgSearchSeq = seq;
  if (!kw) {
    paintSearchOut(null, '');
    return;
  }
  paintSearchOut({ loading: true }, '');
  try {
    const r = await api('GET', `/api/ledger/search?q=${encodeURIComponent(kw)}`);
    if (Number(state.lgSearchSeq) !== seq) return; // 有更新的请求在飞 ⇒ 这一份不要了
    paintSearchOut((r && r.search) || null, '');
  } catch (e) {
    if (Number(state.lgSearchSeq) !== seq) return;
    paintSearchOut(null, e.message);
  }
}

/**
 * 功能：把搜索结果画进 `#lg-search-out`（就地重画那一块）。
 * @param {?Object} d - `{ loading }` / 服务端的 `search` 对象 / `null`
 * @param {string} err - 失败原因
 * @returns {void}
 */
function paintSearchOut(d, err) {
  const box = $('#lg-search-out');
  if (!box) return;
  if (err) {
    box.innerHTML = `<div class="lg-txwait">没搜成：${esc(err)}</div>`;
    return;
  }
  if (!d) {
    box.innerHTML = '<div class="lg-txwait">输入关键字开始搜。</div>';
    return;
  }
  if (d.loading) {
    box.innerHTML = '<div class="lg-txwait">正在搜…</div>';
    return;
  }
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) {
    box.innerHTML = '<div class="lg-txwait">没有匹配的流水。</div>';
    return;
  }
  const cap = d.count > rows.length ? `找到 ${d.count} 笔（下面是最近的 ${rows.length} 笔）` : `找到 ${d.count} 笔`;
  box.innerHTML = `<div class="lg-scap">${esc(cap)}</div>${rows.map(searchRowHtml).join('')}`;
}

/**
 * 功能：搜索结果里的一行 —— `日期 ｜ 分类 · 备注 ｜ 金额`（与手机端逐字同款）。
 * @param {Object} r - 服务端给的一行
 * @returns {string} 那一行的 HTML
 */
function searchRowHtml(r) {
  const at = String((r && r.at) == null ? '' : r.at);
  const note = String((r && r.note) == null ? '' : r.note);
  const name = String((r && r.name) == null ? '' : r.name) || '未分类';
  return `<div class="lg-sres-row">
    <span class="lg-sres-d">${esc(at.slice(5, 10))}</span>
    <span class="lg-sres-m">${esc(name)}${note ? `<span class="lg-sres-n"> · ${esc(note)}</span>` : ''}</span>
    <span class="lg-sres-a">${esc(fmtFen((r && r.amount_fen) || 0, state.lgHide))}</span>
  </div>`;
}

/**
 * 功能：画账单屏（版式权威 = 参考图 2）—— 返回头 ＋ 三档 ＋（月档）年份下拉 ＋ 红色大卡 ＋ 表格。
 *
 * **年份**切换；② **红色大卡**：结余（大号）＋ 收入 / 支出（小字），**标签随档变**
 * （`billCardLabels()`）；③ **表格**：表头 `billColLabels()`、行**照服务端给的顺序**
 * （月档 12 行倒序、年档各年倒序、周档只有当前自然周那一行）；④ 行尾那颗 `›` ⇒ 进**月详情页**
 */

/**
 * 功能：图表**当前该看哪一期** —— ⭐ 就是**账单自己的三档与年份**（`lgBillTab` / `lgBillKey`）。
 *
 * 「同一套图，**期间选择与账单的三档联动**」现在是**唯一**一条路
 * （与手机端 `chartCtxOf()` 同一条口径）。
 * @returns {{type: string, key: string}} 该期的档与键
 */
function chartCtxOf() {
  return { type: billTabOf(), key: String(state.lgBillKey || '') };
}

/**
 * 功能：取**期间清单**（第二行那些候选）—— ⭐ 只取一次；失败**不打扰用户**（少几颗候选而已）。
 * @returns {Promise.<void>}
 */
async function loadPeriods() {
  // 已经取过就**直接返回**（它现在有三处调用方：图表 / 导出页 / 选月弹窗，
  // 每进一格都重拉一遍是白跑的请求）。⚠️ 失败时 `lgPeriods` 仍是 `null` ⇒ 下次还会再试。
  if (state.lgPeriods) return;
  try {
    const r = await api('GET', '/api/ledger/periods');
    state.lgPeriods = (r && r.periods) || null;
  } catch (_e) {
    state.lgPeriods = null;
  }
  lgRender();
}

/**
 * 功能：取**图表一屏**（折线 ＋ 两个数 ＋ 排行榜）。
 * @returns {Promise.<void>}
 */
async function loadChart() {
  if (!state.lgPeriods) loadPeriods();
  state.lgChartLoad = 'loading';
  state.lgChartErr = '';
  lgRender();
  const ctx = chartCtxOf();
  const key = ctx.key || billPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/chart?dir=${encodeURIComponent(chartDirOf(state.lgChartDir))}` +
        `&period_type=${encodeURIComponent(ctx.type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgChart = (r && r.chart) || null;
    state.lgBillKey = String((state.lgChart && state.lgChart.period_key) || key);
    state.lgChartLoad = 'done';
  } catch (e) {
    state.lgChart = null;
    state.lgChartLoad = 'error';
    state.lgChartErr = e.message;
  }
  lgRender();
}

/**
 * 功能：画**折线** —— 几何走共用的 `trendGeometry()`（⛔ 不自己算坐标）；缺口是 `null`（线断开）。
 * @param {Object} side - 服务端给的那一侧（`chart.out` / `chart.in`）
 * @returns {string} 折线那一块的 HTML
 */
function chartLineHtml(side) {
  const series = side && Array.isArray(side.series) ? side.series : [];
  if (!series.length) return '';
  const vals = series.map((p) => (p && p.fen != null ? Number(p.fen) : null));
  const geo = trendGeometry(vals, TREND_BOX, chartAxisOf(chartCtxOf().type, series));
  if (geo.empty) return '<div class="lg-wait">这一期还没有数据。</div>';
  const lines = geo.segs.map((s) => `<polyline class="lg-tl" points="${s}" />`).join('');
  const dots = geo.dots
    .map((p) => `<circle class="lg-td${p.open ? ' open' : ''}" cx="${p.x}" cy="${p.y}" r="2.6" />`)
    .join('');
  const ticks = geo.ticks.map((t) => `<i style="left:${t.pct.toFixed(2)}%">${esc(t.text)}</i>`).join('');
  const mx = Number(side && side.max_fen) || 0;
  return `<div class="lg-trend lg-ctrend">
    <div class="lg-cmax">${mx ? esc(fmtFen(mx, state.lgHide)) : ''}</div>
    <svg class="lg-svg" viewBox="0 0 ${TREND_BOX.w} ${TREND_BOX.h}" aria-hidden="true">${lines}${dots}</svg>
    <div class="lg-axis">${ticks}</div>
  </div>`;
}

/**
 * 功能：画**排行榜** —— 图标 ＋ 名称 ＋ 占比 ＋ 金额 ＋ 进度条（占比走 `sharePct()` / `fmtPct()`）。
 * @param {Object} side - 服务端给的那一侧
 * @returns {string} 排行榜那一块的 HTML
 */
function chartRanksHtml(side) {
  const list = (side && Array.isArray(side.ranks) ? side.ranks : []).filter((r) => Number(r && r.amount_fen));
  if (!list.length) return '<div class="lg-wait">还没有分类数据。</div>';
  const total = Number((side && side.total_fen) || 0);
  return `<div class="lg-cranks">${list
    .map((r) => {
      const pct = sharePct(r.amount_fen, total);
      const w = pct == null ? 0 : Math.min(100, Math.abs(pct));
      return `<div class="lg-crow">
      <i class="lg-eico">${esc(String((r && r.name) || '?').slice(0, 1))}</i>
      <div class="lg-cmain">
        <div class="lg-ctop"><b>${esc((r && r.name) || '')}</b><span>${esc(fmtPct(pct))}</span></div>
        <div class="lg-cbar"><i style="width:${w.toFixed(1)}%"></i></div>
      </div>
      <b class="lg-camt">${esc(fmtFen(r && r.amount_fen, state.lgHide))}</b>
    </div>`;
    })
    .join('')}</div>`;
}

/**
 *
 * 说明：⭐⭐ 「图表中的下拉选项变为【支出、收入】两个按键，放到【平均值】右侧」
 */
function chartDirBarHtml(cur) {
  const one = (k, name) =>
    `<button class="lg-cdbtn${cur === k ? ' on' : ''}" type="button" data-lg="chartdir" data-dir="${esc(k)}"` +
    ` aria-pressed="${cur === k}">${name}</button>`;
  return `<div class="lg-cdbar" role="group" aria-label="选择口径">${one('out', '支出')}${one('in', '收入')}</div>`;
}

/**
 * 功能：画**图表视图**（账单那一屏右栏那一块）—— 口径 ＋ 两个数 ＋ 折线 ＋ 排行。
 *
 * 说明：⭐ 服务端一次把**两侧**都给（`out` / `in`）⇒ **换口径只重画、⛔ 不重取数**。
 * 它现在**只长在「账单」那一屏**（明细那一屏那颗药丸已撤）⇒ 期间由账单自己的
 * 三档与年份下拉决定，⛔ 这里不再自带「期间档药丸 ＋ 期间选择行」。
 */
function lgChartViewHtml() {
  const dir = chartDirOf(state.lgChartDir);
  const d = state.lgChart;
  if (state.lgChartLoad === 'error') {
    return `<div class="lg-chart">${errBoxHtml('图表', state.lgChartErr, 'chartretry')}</div>`;
  }
  const side = d ? d[dir] || null : null;
  if (state.lgChartLoad !== 'done' || !side) {
    return `<div class="lg-chart"><div class="lg-txwait">正在读取…</div></div>`;
  }
  const money = (fen) => (fen == null ? '—' : esc(fmtFen(fen, state.lgHide)));
  // 口径那两颗按键（支出 / 收入）排在「平均值」右侧（`margin-left: auto` 顶到最右）
  const nums = `<div class="lg-cnums">
    <div><span>总${dir === 'in' ? '收入' : '支出'}</span><b>${money(side.total_fen)}</b></div>
    <div><span>平均值</span><b>${money(side.avg_fen)}</b></div>
    ${chartDirBarHtml(dir)}
  </div>`;
  // ：
  // 右栏拆成**两张卡** —— 上面那张（两个数 ＋ 折线）**固定**，下面那张（排行）**自己滚**。
  return `<div class="lg-chart">
    <div class="lg-ccard">${nums}${chartLineHtml(side)}</div>
    <div class="lg-crankcard">${chartRanksHtml(side)}</div>
  </div>`;
}

function billScreenHtml() {
  const type = billTabOf();
  const d = state.lgBill;
  // 「账单」升成**一级格** ⇒ ⛔ 不再有「‹ 返回」那条自画头（一级格没有"上一层"可回）。
  // ：图表与账单的**三档联动**（同一份期间选择：表格与图表同看一期）。
  // 」）：
  const tabs = PERIOD_TYPES.map(
    (k) =>
      `<button class="lg-btab${type === k ? ' on' : ''}" type="button" data-lg="billtab" data-tab="${k}" ` +
      `role="tab" aria-selected="${type === k}">${esc(periodTabLabel('bill', k))}</button>`,
  ).join('');
  // ：三档行右侧补一颗**眼睛** ——
  // 账单屏（含它下面的「图表」那一档）通篇都是金额，而从前只有明细屏藏得掉。
  // 复用 `eyeHtml()` 与 `state.lgHide`（⛔ 不新开第二个开关）。
  const bar = `<div class="lg-tabrow"><div class="lg-btabs" role="tablist">${tabs}</div>${eyeHtml()}</div>`;
  // 三档各自的「换期」控件 —— 周档 `‹ 月份 ›`、月档年份下拉、年档不画（同手机端）。
  let pick = '';
  if (type === 'week') {
    pick = billMonthSwitchHtml();
  } else if (type === 'month') {
    const list = billYears();
    const cur = Number(String(state.lgBillKey || '').slice(0, 4)) || Number(todayOf().slice(0, 4)) || 0;
    const opts = list.map((y) => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}年</option>`).join('');
    pick = `<div class="lg-byear"><select id="lg-bill-year" aria-label="选择年份">${opts}</select></div>`;
  }

  // **两栏同时画** —— 右栏是图表（那是 `/chart`，有自己的 `lgChartLoad` 三态），
  // 左栏是结余卡 ＋ 表格。⚠️ 下面那两条三态**只管左栏**：把图表也一起判，会把一块已经画好的图
  // 盖成「正在读取…」，而那时 `lgBillLoad` 可能只是还停在别处（不是真的读不到）。
  const chartCol = `<div class="lg-billcol-r">${lgChartViewHtml()}</div>`;
  const wrapBill = (leftInner) =>
    `<div class="lg-bill">${bar}<div class="lg-billcols"><div class="lg-billcol-l">${leftInner}</div>${chartCol}</div></div>`;

  if (state.lgBillLoad === 'error') {
    return wrapBill(errBoxHtml('账单', state.lgBillErr, 'bill'));
  }
  if (state.lgBillLoad !== 'done' || !d) {
    return wrapBill('<div class="lg-txwait">正在读取…</div>');
  }

  const card = d.card || { income_fen: 0, expense_fen: 0, balance_fen: 0 };
  const lb = billCardLabels(type);
  const cols = billColLabels(type);
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const body = rows
    .map((r) => {
      const month = type === 'month';
      // 行尾那颗 `›` 只有**月档**有（T41）—— 非月档的整行也不可点，⛔ 别留一个点了没反应的 `data-lg`。
      const tap = month ? ` data-lg="mdopen" data-key="${esc(r.key)}"` : '';
      // 修订：「移除所有的退款红色字体」—— 表格里那一列「退款」撤掉。
      // 两处：
      // ① **加了「预算 / 超支」两列**（服务端 `ledgerBillView()` 每行多给了两个数）；
      const live = r.started !== false;
      const bud = r.budget_fen === null || r.budget_fen === undefined ? null : Number(r.budget_fen);
      const cell = (v) => (live ? esc(fmtFen(Number(v) || 0, state.lgHide)) : '—');
      const budCell = live && bud !== null ? esc(fmtFen(bud, state.lgHide)) : '—';
      const ovCell = live && bud !== null ? esc(fmtFen(Number(r.overspent_fen) || 0, state.lgHide)) : '—';
      return `<div class="lg-btr${month ? ' tap' : ''}"${tap}>
        <span class="lg-btr-c1">${esc(billRowLabel(type, r.key))}</span>
        <span>${cell(r.income_fen)}</span>
        <span>${cell(r.expense_fen)}</span>
        <span>${cell(r.balance_fen)}</span>
        <span>${budCell}</span>
        <span>${ovCell}</span>
        <span class="lg-bchev">${month ? '›' : ''}</span>
      </div>`;
    })
    .join('');
  // 左栏 = 结余卡 ＋ 表格（两栏的骨架由 `wrapBill()` 套上）
  // ：
  // 换期控件（`pick`）**从屏顶搬进这张红卡的右上角**（与「周结余 / 月结余」那行同一排）——
  return wrapBill(`<div class="lg-bcard">
      <div class="lg-bctop">
        <span class="lg-bcap">${esc(lb.balance)}</span>
        ${pick}
      </div>
      <b class="lg-bnum">${esc(fmtFen(card.balance_fen, state.lgHide))}</b>
      <div class="lg-bcols">
        <div><span>${esc(lb.income)}</span><b>${esc(fmtFen(card.income_fen, state.lgHide))}</b></div>
        <div><span>${esc(lb.expense)}</span><b>${esc(fmtFen(card.expense_fen, state.lgHide))}</b></div>
      </div>
    </div>
    <div class="lg-btb">
      <div class="lg-btr head"><span class="lg-btr-c1">${esc(cols.first)}</span>
        <span>${esc(cols.income)}</span><span>${esc(cols.expense)}</span><span>${esc(
          cols.balance,
        )}</span><span>${esc(cols.budget)}</span><span>${esc(cols.overspent)}</span>
        <span class="lg-bchev"></span></div>
      ${body || '<div class="lg-txwait">这一档还没有数据。</div>'}
    </div>`);
}

// ============================================================================
// ③ 月详情页（图 5；⭐ 只有「月」有这一页）—— 从账单表格行尾那颗 `›` 进
// ============================================================================

/**
 * 功能：月详情页的标题（`9月账单` —— 参考图 5）。
 *
 * 说明：⚠️ （T47）：图里那句「这是我与鲨鱼记账相识的第 N 天」**暂时不做**
 * ⇒ 标题区只留 `9月账单` 这一句，⛔ 不编一句运营文案。
 * @param {string} month - `YYYY-MM`
 */
function monthTitle(month) {
  return `${Number(String(month || '').slice(5, 7))}月账单`;
}

/**
 * 功能：取一次月详情页一屏（`GET /api/ledger/month-bill`）并重画。
 *
 * 说明：⭐⭐ 服务端**一次给全**（占比表 / 排行 / 趋势 / 对比 / 收入构成 / 成就）⇒ 这一屏
 * **一个请求**，⛔ 不是按块各取一次（不做 N+1）。⚠️ 失败**不抛**（画「读不到 ＋ 重试」），
 * 绝不画成"这个月没有账单"。
 */
async function loadMonthBill() {
  const month = String(state.lgMdMonth || '');
  if (!month) return;
  state.lgMdLoad = 'loading';
  state.lgMdErr = '';
  lgRender();
  try {
    const r = await api('GET', `/api/ledger/month-bill?month=${encodeURIComponent(month)}`);
    // 请求飞回来时再确认一次还停在这个月（用户可能在期间点了返回 / 换了另一行）——
    // 不判就会把上一个月的那一屏画在当前这一屏上（**不报错**）。与 `loadChanges()` 同款。
    if (String(state.lgMdMonth) !== month) return;
    state.lgMd = (r && r.month_bill) || null;
    state.lgMdLoad = 'done';
  } catch (e) {
    if (String(state.lgMdMonth) !== month) return;
    state.lgMd = null;
    state.lgMdLoad = 'error';
    state.lgMdErr = e.message;
  }
  lgRender();
}

/**
 * 功能：一行「类别 ｜ 占比 ｜ 金额」的占比该写什么。
 *
 * 说明：⚠️⭐ 占比**已经由服务端算好**（`pct`，一位小数）⇒ 这里只排版，⛔ 不拿金额再除一遍。
 * 三条口径：非有限数（分母为 0）⇒ `—`；**非零但极小**（服务端已经舍成 0.0）⇒ `<0.1%`
 * （⛔ 不写 `0.0%` —— 环里明明画着那么一小段，文字说"零"就是自相矛盾）；其余走 `pct1()`。
 */
function shareText(row) {
  const p = Number(row && row.pct);
  if (!Number.isFinite(p)) return pct1(null);
  if (p === 0 && Number(row && row.amount_fen) > 0) return '<0.1%';
  return pct1(p);
}

/**
 * 功能：月详情页里的**柱状图**（近 6 个月的支出 / 收入对比）。
 *
 * 按月份落进 `trendGeometry()` 的 **12 格**（月序即下标），于是横向位置、刻度、纵轴缩放
 * **全是同一份几何**；柱子的高度直接从它给的点算（`geo.dots` 的 y 到基线）。
 * 缺数据的月 `null` ⇒ 那一格没有点 ⇒ 不画柱（⛔ 不补 0：那会画出一根"这个月花了 0"的假柱子）。
 */
function barChartHtml(months, field) {
  const list = Array.isArray(months) ? months : [];
  const slots = new Array(12).fill(null);
  for (const m of list) {
    const i = Number(String(m && m.key).slice(5, 7));
    if (i >= 1 && i <= 12) slots[i - 1] = Number(m[field]) || 0;
  }
  const b = TREND_BOX;
  const geo = trendGeometry(slots, b);
  if (geo.empty) return '<div class="lg-wait">近半年还没有数据。</div>';
  const base = geo.zeroY == null ? b.h - b.padB : geo.zeroY;
  const span = b.w - b.padL - b.padR;
  // 由点的横坐标**反推**它是哪一个月（`trendGeometry` 只给 x / y，不给下标）——
  // 这样「第几根柱对应几月」与那份几何是同一个判据，⛔ 不另按 6 等分推一遍。
  const monthOfX = (x) => String(Math.round(((x - b.padL) / span) * 11) + 1);
  const bars = geo.dots
    .map((p) => {
      const top = Math.min(p.y, base);
      const hgt = Math.max(Math.abs(base - p.y), 1);
      return `<rect class="lg-bar" x="${(p.x - 5).toFixed(1)}" y="${top.toFixed(1)}" width="10"
        height="${hgt.toFixed(1)}" rx="3" />`;
    })
    .join('');
  const ticks = geo.dots
    .map((p) => `<i style="left:${((p.x / b.w) * 100).toFixed(2)}%">${monthOfX(p.x)}月</i>`)
    .join('');
  return `<div class="lg-trend"><svg class="lg-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">
    ${bars}</svg><div class="lg-axis">${ticks}</div></div>`;
}

/**
 * 功能：月详情页里的**折线图**（这个月每天的支出）。
 *
 * 说明：⚠️⭐ 这里没法复用 `trendGeometry()`：它的横轴被写死成**12 个月**（刻度取自 `AXIS_MONTHS`），
 * 而这一条是**同一个月里的每一天**（最多 31 个点）⇒ 只在本函数里按「日」铺点
 * （横轴 = 当月第几号，与图 5 的 `01 … 30` 对齐），但**描线 / 描点仍用同一套类名**
 */
function dayLineHtml(trend, month) {
  const days = (trend && Array.isArray(trend.days) ? trend.days : []).filter((x) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(x && x.day)),
  );
  if (!days.length) return '<div class="lg-wait">这个月还没有支出。</div>';
  const y = Number(String(month).slice(0, 4));
  const mo = Number(String(month).slice(5, 7));
  const dim = new Date(y, mo, 0).getDate() || 30;
  // ：几何**收口到共用层** —— 从前这里自己算了一遍
  // `lo/hi/span/xOf/yOf`（与 `calc.js` 的 `trendGeometry()` 是同一段算术的第二份拷贝）
  // ⇒ 现在只有一条路：把「每天一格」的值得出来，连横轴标签一起交给 `trendGeometry()`。
  const geo = trendGeometry(dayValuesOf(days, dim), TREND_BOX, dayAxisOf(dim));
  if (geo.empty) return '<div class="lg-wait">这个月还没有支出。</div>';
  const b = TREND_BOX;
  const lines = geo.segs.map((s) => `<polyline class="lg-tl" points="${s}" />`).join('');
  const dots = geo.dots.map((p) => `<circle class="lg-td" cx="${p.x}" cy="${p.y}" r="2.6" />`).join('');
  const ticks = geo.ticks.map((t) => `<i style="left:${t.pct.toFixed(2)}%">${t.text}</i>`).join('');
  return `<div class="lg-trend"><svg class="lg-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">
    ${lines}${dots}</svg><div class="lg-axis">${ticks}</div></div>`;
}

/**
 * 功能：画**月详情页**（版式权威 = 参考图 5；⭐ 只有「月」有这一页，T41）。
 *
 * 两条占比条）；③ 支出类别（饼图 ＋ `类别 ｜ 占比 ｜ 金额` 表，**一位小数**）；
 * ④ 支出排行（前三）；⑤ 支出趋势（单日最高 / 日均 / 本月支出 ＋ 折线）；⑥ 月支出对比
 * （柱状 ＋「对比上月变化前三的类别」）；⑦ 收入（总收入 ＋ 各来源占比）；⑧ 月收入对比（柱状）；
 */
function monthDetailScreenHtml() {
  const month = String(state.lgMdMonth || '');
  const head = subHeadHtml('mdback', monthTitle(month));
  if (state.lgMdLoad === 'error') {
    return `<div class="lg-md">${head}${errBoxHtml(
      '这个月的账单',
      state.lgMdErr,
      'mdopen',
      ` data-key="${esc(month)}-01"`,
    )}</div>`;
  }
  const d = state.lgMd;
  if (state.lgMdLoad !== 'done' || !d) {
    return `<div class="lg-md">${head}<div class="lg-txwait">正在读取…</div></div>`;
  }
  const card = d.card || {};
  const cats = Array.isArray(d.expense_categories) ? d.expense_categories : [];
  const top = Array.isArray(d.expense_top) ? d.expense_top : [];
  const trend = d.expense_trend || {};
  const movers = Array.isArray(d.expense_movers) ? d.expense_movers : [];
  const incs = Array.isArray(d.income_categories) ? d.income_categories : [];
  const months = Array.isArray(d.months) ? d.months : [];
  const ach = d.achievement || {};

  // ---- ② 卡：本月结余 ＋ 上月结余（灰字弱化，T42-①：⛔ 不是删除线）＋ 两条占比条 ----
  const ratioBar = (label, fen, pct) => {
    const w = Math.max(Number(pct) || 0, 0);
    return `<div class="lg-mdbar">
      <div class="lg-mdbar-t"><span>${esc(label)}</span><b>${esc(fmtFen(fen, state.lgHide))}</b></div>
      <div class="lg-mdbar-b"><span style="width:${w.toFixed(2)}%"></span></div>
      <i class="lg-mdbar-p">${esc(pct1(pct))}</i>
    </div>`;
  };
  const cardHtml = `<div class="lg-card">
    <div class="lg-mdnum"><span>本月结余</span><b>${esc(fmtFen(card.balance_fen, state.lgHide))}</b></div>
    <div class="lg-mdnum weak"><span>上月结余</span><b>${esc(fmtFen(card.prev_balance_fen, state.lgHide))}</b></div>
    ${ratioBar('支出', card.expense_fen, card.expense_pct)}
    ${ratioBar('收入', card.income_fen, card.income_pct)}
  </div>`;

  // ---- ③ 支出类别：饼图 ＋ 表（类别 ｜ 占比 ｜ 金额）----
  const items = cats.map((c) => ({
    key: String(c.category_id == null ? 0 : c.category_id),
    name: String(c.name || '') || CAT_UNCLASSIFIED,
    fen: Number(c.amount_fen) || 0,
    color: catColorOf(c.category_id),
  }));
  const ring = donutArcs(items, DONUT_R);
  const box = (DONUT_R + DONUT_SW / 2) * 2;
  const mid = box / 2;
  const arcs = ring.arcs
    .map(
      (a) =>
        `<circle class="lg-arc" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke="${a.color}" stroke-width="${DONUT_SW}" stroke-dasharray="${a.len.toFixed(
          2,
        )} ${(ring.c - a.len).toFixed(2)}" stroke-dashoffset="${a.offset.toFixed(2)}" />`,
    )
    .join('');
  const catTable = cats.length
    ? cats
        .map(
          (c) => `<div class="lg-mdtrow">
        <i style="--lg-c:${catColorOf(c.category_id)}"></i>
        <span>${esc(String(c.name || '') || CAT_UNCLASSIFIED)}</span>
        <b>${esc(shareText(c))}</b>
        <b>${esc(fmtFen(c.amount_fen, state.lgHide))}</b>
      </div>`,
        )
        .join('')
    : '<div class="lg-wait">这个月还没有支出。</div>';
  const catHtml = `<div class="lg-card"><div class="lg-ccap"><b>支出类别</b></div>
    <div class="lg-donut"><div class="lg-ring">
      <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
        <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
        <g transform="rotate(-90 ${mid} ${mid})">${arcs}</g>
      </svg>
      <div class="lg-ring-mid"><i>支出</i><b>${esc(fmtFen(card.expense_fen, state.lgHide))}</b></div>
    </div></div>
    <div class="lg-mdtab">${catTable}</div></div>`;

  // ---- ④ 支出排行（前三：就是上面那张表的前三条，服务端已按金额降序）----
  const rankHtml = top.length
    ? `<div class="lg-card"><div class="lg-ccap"><b>支出排行</b></div>${top
        .map(
          (c, i) => `<div class="lg-mdrk">
        <span class="lg-mdrk-n">${i + 1}</span>
        <span class="lg-mdrk-m"><b>${esc(String(c.name || '') || CAT_UNCLASSIFIED)}</b>
          <span class="lg-mdrk-b"><span style="width:${Math.max(Number(c.pct) || 0, 0).toFixed(2)}%"></span></span></span>
        <b class="lg-mdrk-a">${esc(fmtFen(c.amount_fen, state.lgHide))}</b>
      </div>`,
        )
        .join('')}</div>`
    : '';

  // ---- ⑤ 支出趋势：三个数 ＋ 一条折线 ----
  const trendHtml = `<div class="lg-card"><div class="lg-ccap"><b>支出趋势</b></div>
    <div class="lg-mdnums">
      <div><span>单日支出最高</span><b>${esc(fmtFen(trend.max_day_fen, state.lgHide))}</b>
        <i>${esc(trend.max_day ? dayHeadLabel(String(trend.max_day)) : '—')}</i></div>
      <div><span>日均支出</span><b>${esc(fmtFen(trend.daily_avg_fen, state.lgHide))}</b><i></i></div>
      <div><span>本月支出</span><b>${esc(fmtFen(trend.total_fen, state.lgHide))}</b><i></i></div>
    </div>
    ${dayLineHtml(trend, month)}</div>`;

  // ---- ⑥ 月支出对比：柱状 ＋「对比上月变化前三的类别」（方向靠 ↑ / ↓，金额取绝对值）----
  const prevLabel = `${Number(shiftMonth(month, -1).slice(5, 7))}月`;
  const moverHtml = movers.length
    ? `<div class="lg-mdmovers"><b class="lg-mdmovers-t">${esc(
        `${Number(month.slice(5, 7))}月对比${prevLabel}变化前三的类别`,
      )}</b>${movers
        .map(
          (m, i) => `<div class="lg-mdrk">
        <span class="lg-mdrk-n">${i + 1}</span>
        <span class="lg-mdrk-m"><b>${esc(String(m.name || '') || CAT_UNCLASSIFIED)}</b>
          <i class="lg-mdrk-d">${Number(m.diff_fen) >= 0 ? '↑上升' : '↓下降'}</i></span>
        <b class="lg-mdrk-a">${esc(fmtFen(Math.abs(Number(m.diff_fen) || 0), state.lgHide))}</b>
      </div>`,
        )
        .join('')}</div>`
    : '';
  const expBarHtml = `<div class="lg-card"><div class="lg-ccap"><b>月支出对比</b></div>
    ${barChartHtml(months, 'expense_fen')}${moverHtml}</div>`;

  // ---- ⑦ 收入：总收入 ＋ 各来源占比 ----
  const incRows = incs.length
    ? incs
        .map(
          (c) => `<div class="lg-mdtrow">
        <i style="--lg-c:${catColorOf(c.category_id)}"></i>
        <span>${esc(String(c.name || '') || CAT_UNCLASSIFIED)}</span>
        <b>${esc(shareText(c))}</b>
        <b>${esc(fmtFen(c.amount_fen, state.lgHide))}</b>
      </div>`,
        )
        .join('')
    : '<div class="lg-wait">这个月还没有收入。</div>';
  const incHtml = `<div class="lg-card"><div class="lg-ccap"><b>收入</b></div>
    <div class="lg-mdnum"><span>总收入</span><b>${esc(fmtFen(card.income_fen, state.lgHide))}</b></div>
    <div class="lg-mdtab">${incRows}</div></div>`;

  // ---- ⑧ 月收入对比（柱状）----
  const incBarHtml = `<div class="lg-card"><div class="lg-ccap"><b>月收入对比</b></div>
    ${barChartHtml(months, 'income_fen')}</div>`;

  // ---- ⑨ 记账成就（⭐ 量的是「记账以来」，⛔ 不是本月）----
  const achHtml = `<div class="lg-card"><div class="lg-ccap"><b>记账成就</b></div>
    <div class="lg-mdach">
      <div><b>${Number(ach.streak_days) || 0}</b><span>天</span><i>已连续打卡</i></div>
      <div><b>${Number(ach.total_days) || 0}</b><span>天</span><i>记账总天数</i></div>
      <div><b>${Number(ach.total_count) || 0}</b><span>笔</span><i>记账总笔数</i></div>
    </div></div>`;

  return `<div class="lg-md">${head}${cardHtml}${catHtml}${rankHtml}${trendHtml}${expBarHtml}${incHtml}${incBarHtml}${achHtml}</div>`;
}

// ============================================================================
// ④ 预算屏（图 4 / 6 / 7 / 9）：周 / 月 / 年 · 总预算 ＋ 分类预算
//

/**
 * 本次「设 / 清一行预算」流程里的**目标**（`{type, key, cid}`，`null` = 没开过那一层）。
 *
 */
let budTarget = null;

/**
 * 功能：预算屏当前那一档（`'week'` / `'month'` / `'year'`）。
 *
 * 说明：⚠️ 认不出一律回落 `'month'` —— ⭐ **它就是默认档**（C-18：照图 4 顶栏的选中态）。
 * 白名单走 `calc.js` 的 `PERIOD_TYPES`（⛔ 不在这里再抄一遍三档字面量）。
 * @returns {string} 三档之一
 */
function budgetTabOf() {
  const k = String(state.lgBudgetTab || '');
  return PERIOD_TYPES.includes(k) ? k : 'month';
}

/**
 * 功能：预算屏当前这一期的 `period_key`（**该期起始日** `YYYY-MM-DD`）。
 *
 * 说明：⭐ 折算是 `calc.js` 的 `periodKeyOf()`（判据只住那一处，C-3）。
 * 里面的 `today` 必须是**服务端今天**—— ⛔ 绝不传本机 `new Date()`。
 * 取不到服务端今天 ⇒ 回空串 ⇒ 这一屏落进「读不到」（⛔ 不猜一个日期兜上去）。
 */
function budgetPeriodKey() {
  return String(state.lgBudgetKey || '') || periodKeyOf(budgetTabOf(), todayOf());
}

/**
 * 功能：总预算块那个标题（图 4 的 `09月总预算`、图 6 的 `2026年总预算`）。
 * @param {string} type - 三档之一
 * @param {string} key - 该期起始日 `YYYY-MM-DD`
 * @returns {string} 标题
 */
function budgetTotalTitle(type, key) {
  const s = String(key || '');
  if (type === 'year') return `${s.slice(0, 4)}年总预算`;
  if (type === 'month') return `${s.slice(5, 7)}月总预算`;
  return `${periodLabelOf(type)}总预算`;
}

/**
 * 功能：某一个分类预算的名字（**与那一块行上写的是同一个来源**）。
 *
 * 说明：⚠️ 优先读服务端那一行给的名字（`state.lgBudget.categories[].name`）—— 分类被**硬删**过
 * 而预算行还在时名字是空串，那时回落到 `CAT_UNCLASSIFIED`（「未分类」这个词只住前端）。
 * @param {number} cat - 分类 id
 */
function budgetCatName(cat) {
  const list = (state.lgBudget && state.lgBudget.categories) || [];
  const row = list.find((c) => Number(c.category_id) === Number(cat));
  return String((row && row.name) || '') || CAT_UNCLASSIFIED;
}

/**
 * 功能：动作单上那两行写什么的主语（图 7 的 `编辑年度总预算` / `清除年度总预算`）。
 * @param {number} cat - `0` = 总预算；`> 0` = 分类预算
 * @param {string} type - 三档之一
 * @returns {string} 如 `本月总预算` / `餐饮预算`
 */
function budgetTargetName(cat, type) {
  if (!Number(cat)) return `${periodLabelOf(type)}总预算`;
  return `${budgetCatName(cat)}预算`;
}

/**
 * 功能：一个预算块那个**环形**（环里写 `剩余 52%` / `已超支` / `未设`）。
 *
 * 说明：⭐⭐ 几何**复用 1 期**那一份（`donutArcs()` ＋ `.lg-ring` / `.lg-arc` 那组类名，
 * 权重是**服务端给的两个数**（`used_fen` / `remain_fen`），本函数只把它们交给那份几何
 * 去按比值铺段 —— ⛔ 这里不做任何金额运算（2 期 §5.4）。
 */
function budgetRingHtml(block) {
  const b = block || {};
  const amount = Number(b.amount_fen) || 0;
  const draw = !!b.set && amount > 0;
  const used = draw ? Math.abs(Number(b.used_fen) || 0) : 0;
  const remain = draw ? Math.max(Number(b.remain_fen) || 0, 0) : 0;
  const ring = donutArcs(
    [
      { key: 'u', fen: used },
      { key: 'r', fen: remain },
    ],
    DONUT_R,
  );
  const arc = ring.arcs.find((a) => a.key === 'u');
  const box = (DONUT_R + DONUT_SW / 2) * 2;
  const mid = box / 2;
  const seg = arc
    ? `<circle class="lg-arc lg-barc" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}"
      stroke-dasharray="${arc.len.toFixed(2)} ${(ring.c - arc.len).toFixed(2)}"
      stroke-dashoffset="${arc.offset.toFixed(2)}" />`
    : '';
  return `<div class="lg-ring lg-bring">
    <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
      <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
      ${seg ? `<g transform="rotate(-90 ${mid} ${mid})">${seg}</g>` : ''}
    </svg>
    <div class="lg-ring-mid"><b class="lg-brt">${esc(ringText(b))}</b></div>
  </div>`;
}

/**
 * 功能：预算块右侧那三行（`剩余预算` ＋ `预算` ＋ `支出`）。
 *
 * 说明：⚠️⭐ 三行的**数值**一律走 `calc.js` 的 `budgetBlockText(block, state.lgHide)` ——
 * 眼睛关掉时三串一起糊成圆点，而且剩余**可以是负数**（超支照实显示，⛔ 不取绝对值、
 * 不夹到 0 —— 图 6 的 `-10045.00` 就是这么来的）。
 */
function budgetLinesHtml(block, labels) {
  const t = budgetBlockText(block, state.lgHide);
  return `<div class="lg-blines">
    <div class="lg-bline big"><span>剩余预算</span><b>${esc(t.remain)}</b></div>
    <div class="lg-bline"><span>${esc(labels.budget)}</span><b>${esc(t.amount)}</b></div>
    <div class="lg-bline"><span>${esc(labels.used)}</span><b>${esc(t.used)}</b></div>
  </div>`;
}

/**
 * 功能：一块预算的骨架 —— 头（左边是谁 ＋ 右边「编辑」）＋ 环形 ＋ 右侧三行。
 *
 * 说明：⚠️⭐ 图元与总预算 / 分类预算**共用这一份**（图 4 里两块除了标签完全同构）——
 * 别给分类那块另写一套（两套必然漂移，而画面上没人看得出来）。
 * @param {?Object} block - 服务端给的那一块
 */
function budgetBlockHtml(block, labels, cat, leftHtml) {
  return `<div class="lg-bhead">${leftHtml}
    <button class="lg-bedit" type="button" data-lg="budgetedit" data-mode="menu"
      data-cid="${Number(cat) || 0}">编辑</button>
  </div>
  <div class="lg-brow">${budgetRingHtml(block)}${budgetLinesHtml(block, labels)}</div>`;
}

/**
 * 功能：取一次预算屏一屏（`GET /api/ledger/budget`）并重画 —— **三档共用**（靠 `period_type` 分派）。
 *
 * 说明：⚠️ 进入这一格（`openBudget()`）与换档都走它；失败**不抛**（画「读不到 ＋ 重试」）——
 * 绝不画成「还没设预算」。
 * @returns {Promise.<void>}
 */
async function loadBudget() {
  state.lgBudgetLoad = 'loading';
  state.lgBudgetErr = '';
  lgRender();
  const type = budgetTabOf();
  const key = budgetPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/budget?period_type=${encodeURIComponent(type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgBudget = (r && r.budget) || null;
    state.lgBudgetLoad = 'done';
  } catch (e) {
    state.lgBudget = null;
    state.lgBudgetLoad = 'error';
    state.lgBudgetErr = e.message;
  }
  lgRender();
}

/**
 * 功能：进「预算」那一格 ⇒ 把这一期取回来（与进屏同一条路：`openLedger()` / 切格都走它）。
 *
 * 说明：⭐ 每次进这一格都重取（额度 / 已用都可能在别处被改过）—— 这一屏摆的就是「这一期还剩多少」。
 * @returns {Promise.<void>}
 */
async function openBudget() {
  await loadBudget();
}

/**
 * 功能：画「预算」那一格（版式权威 = 参考图 4 / 6；⭐ 默认落「月预算」，C-18）。
 *
 * 说明：⭐⭐ 三块（§7.2）：① **三档** `周预算 ｜ 月预算 ｜ 年预算`（默认月档）＋ 右侧一颗眼睛；
 * ② **总预算块**（标题 `09月总预算` ＋「编辑」＋ 环形 ＋ `剩余预算 / 本月预算 / 本月支出`）；
 * ③ **分类预算块**（小标题「分类预算」＋ 每类一块（图标 ＋ 名字 ＋「编辑」＋ 环形 ＋ 三行））。
 */
function budgetPaneHtml() {
  const type = budgetTabOf();
  const tabs = PERIOD_TYPES.map(
    (k) =>
      `<button class="lg-btab${type === k ? ' on' : ''}" type="button" data-lg="budgettab" data-tab="${k}" ` +
      `role="tab" aria-selected="${type === k}">${esc(periodTabLabel('budget', k))}</button>`,
  ).join('');
  // 三档行右侧那颗眼睛 —— 与账单屏同一条口径（见 `billScreenHtml()` 里那段说明）
  const bar = `<div class="lg-tabrow"><div class="lg-btabs" role="tablist">${tabs}</div>${eyeHtml()}</div>`;

  // ---- 三态之一：读不到（⛔ 绝不画成「还没设预算」）----
  if (state.lgBudgetLoad === 'error') {
    return `<div class="lg-budget">${bar}${errBoxHtml(
      '预算',
      state.lgBudgetErr,
      'budgettab',
      ` data-tab="${esc(type)}"`,
    )}</div>`;
  }
  // ---- 三态之二：读取中（与「还没设预算」是两件事）----
  if (state.lgBudgetLoad !== 'done' || !state.lgBudget) {
    return `<div class="lg-budget">${bar}<div class="lg-txwait">正在读取…</div></div>`;
  }

  const d = state.lgBudget;
  const total = d.total || {};
  const cats = Array.isArray(d.categories) ? d.categories : [];
  const key = String(d.period_key || '') || budgetPeriodKey();

  // ---- 三态之三：真的还没设过任何预算（两头都空）----
  if (!total.set && !cats.length) {
    return `<div class="lg-budget">${bar}
      <div class="lg-bempty">
        <div class="es-text">还没设预算 —— 设一个总预算，或者先给几个分类各分一点。</div>
        <button class="btn btn-primary" type="button" data-lg="budgetedit" data-mode="amount"
          data-cid="0">设置总预算</button>
      </div></div>`;
  }

  const lb = budgetLineLabels(type);
  const totalCard = `<div class="lg-card">${budgetBlockHtml(
    total,
    lb,
    0,
    `<b class="lg-bttl">${esc(budgetTotalTitle(type, key))}</b>`,
  )}</div>`;
  const catBody = cats.length
    ? cats
        .map((c) => {
          const name = String(c.name || '') || CAT_UNCLASSIFIED;
          const ch = String(name).trim().slice(0, 1) || '·';
          const ico = `<span class="lg-eico" style="--lg-c:${catColorOf(c.category_id)}">${esc(ch)}</span>`;
          // 分类块那三行的标签是**素**的（图 4 / 图 6 都写 `预算` / `支出`，⛔ 不带「本月 / 年度」）
          return `<div class="lg-bblk">${budgetBlockHtml(
            c,
            { budget: '预算', used: '支出' },
            c.category_id,
            `<b class="lg-bttl">${ico}${esc(name)}</b>`,
          )}</div>`;
        })
        .join('')
    : '<div class="lg-wait">还没给哪个分类单独设额度。</div>';
  const catCard = `<div class="lg-card"><div class="lg-ccap"><b>分类预算</b></div>${catBody}</div>`;

  // （「移除独立的【添加分类预算】按键，在预算页的【+新建】图标
  // 为添加分类预算」）：底部那条通栏按钮（`.lg-badd`）**撤了** —— 主操作交给屏级那颗
  // 悬浮钮旁边再压一条通栏按钮做同一件事，用户分不清该点哪个（`11` 记过）。
  return `<div class="lg-budget">${bar}${totalCard}${catCard}</div>`;
}

/**
 * 功能：**动作单**（图 7）—— `编辑XX预算` / `清除XX预算`（电脑端开一张窄弹窗，取消走弹窗那颗）。
 *
 * 说明：⭐ 措辞里那句主语走 `budgetTargetName()`（总预算 = `本月总预算`、分类 = `<分类名>预算`）
 * —— 与块头上那块写的是**同一个来源**，⛔ 不在这里另拼一份。
 * 「清除」那一行是危险色（`.lg-bmi.danger`）：它删数据，样式上必须先声张。
 */
function openBudgetMenu(cat) {
  const name = budgetTargetName(cat, budgetTabOf());
  const cid = Number(cat) || 0;
  openModal(
    '编辑预算',
    `<div class="lg-bmenu">
      <button class="lg-bmi" type="button" data-lg="budgetedit" data-mode="amount"
        data-cid="${cid}">编辑${esc(name)}</button>
      <button class="lg-bmi danger" type="button" data-lg="budgetclear" data-cid="${cid}">清除${esc(name)}</button>
    </div>`,
    {},
  );
  // 这一页没有「保存」：两行各自就是一个动作 ⇒ 主按钮退化成「关闭」（与 `askArchiveCat` 同款）。
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：那张**额度输入弹窗**（设 / 改额度）。
 *
 * 说明：⚠️⭐ `amount_fen` 提交时**必须是字符串**（服务端 `parseFen()` 只收字符串：数字类型的
 * `8.7` 在解析成 double 那一刻就已经丢过精度了）⇒ 输入框的**原样串**直接交上去，
 * 不在前端 `Number()` 一下再 `String()` 回来。
 */
function openBudgetAmount(cat) {
  const type = budgetTabOf();
  const cid = Number(cat) || 0;
  budTarget = { type, key: budgetPeriodKey(), cid };
  const row = cid
    ? ((state.lgBudget && state.lgBudget.categories) || []).find((c) => Number(c.category_id) === cid)
    : state.lgBudget && state.lgBudget.total;
  const cur = row && row.set ? fenToInput(row.amount_fen) : '';
  openModal(
    `编辑${budgetTargetName(cid, type)}`,
    `<div class="lg-bset">
      <label class="lg-bfld"><span>额度</span>
        <input id="lg-bud-input" type="text" inputmode="decimal"
          value="${esc(cur)}" /></label>
      <div class="lg-btip">填 0 就是这一期设成 0（与「没设过」是两回事）；改这一期只影响这一期，不回溯。</div>
    </div>`,
    {},
  );
  setModalSave('保存', false);
  $('#modal-save').onclick = saveBudgetAmount;
}

/**
 * 功能：`＋ 添加分类预算` ⇒ 开那张「先挑分类、再填额度」的弹窗。
 *
 * 说明：⭐ 挑分类用的是**原生 `<select>` ＋ `<optgroup>`**（两级分类靠全角空格缩进）——
 * 服务端不收名字、只认 id，原生选择器比自己画一套更稳（⛔ 本期不为这一件事长第二套选择器）。
 * 一个分类都没有（还没建过 / 分类没取到）时**不开这张弹窗**：开了也无从选，
 */
function openBudgetAdd() {
  const groups = catTree(state.lgCats, '支出').length + catTree(state.lgCats, '收入').length;
  if (!groups) {
    toast('还没有收支分类，先去「设置」里建一个', true);
    return;
  }
  budTarget = { type: budgetTabOf(), key: budgetPeriodKey(), cid: 0 };
  openModal(
    '添加分类预算',
    `<div class="lg-bset">
      <label class="lg-bfld"><span>分类</span>${budgetCatSelectHtml(0)}</label>
      <label class="lg-bfld"><span>额度</span>
        <input id="lg-bud-input" type="text" inputmode="decimal" value="" /></label>
      <div class="lg-btip">给某一个分类单独设一份额度；它和总预算是各算各的，不互相扣。</div>
    </div>`,
    {},
  );
  setModalSave('保存', false);
  $('#modal-save').onclick = saveBudgetAmount;
}

/**
 * 功能：「添加分类预算」那张弹窗里折一个两级分类的 `<select>`。
 *
 * 说明：⭐ 分类树只走 `entry-calc.js` 的 `catTree()`（⛔ 不在本文件再写一遍父子过滤）。
 * 服务端没有的规矩。⚠️ `<option>` 的**取值一律是分类 id**，⛔ 别拿名字当值
 * （同名不同级会被服务端判成"这个分类不存在"）。
 */
function budgetCatSelectHtml(selected) {
  const one = (c, indent) =>
    `<option value="${Number(c.id)}"${Number(selected) === Number(c.id) ? ' selected' : ''}>${
      indent ? '　' : ''
    }${esc(String(c.name == null ? '' : c.name))}</option>`;
  const groups = [
    { label: '支出', rows: catTree(state.lgCats, '支出') },
    { label: '收入', rows: catTree(state.lgCats, '收入') },
  ].filter((g) => g.rows.length);
  const body = groups
    .map((g) => {
      const opts = g.rows
        .map((c) => one(c, false) + (c.kids || []).map((k) => one(k, true)).join(''))
        .join('');
      return `<optgroup label="${g.label}">${opts}</optgroup>`;
    })
    .join('');
  return `<select id="lg-bud-cat" aria-label="选择分类">${body}</select>`;
}

/**
 * 功能：额度弹窗里那颗「保存」—— `PUT /api/ledger/budget`（设 / 改**一行**额度）。
 *
 * 说明：⭐⭐ 两条（都对得上服务端 `checkBudgetBody()` 的入参校验表）：`amount_fen` 传**字符串原样**
 * （`parseFen()` 只收字符串）；`category_id` 也传字符串（`0` = 总预算哨兵；> 0 = 分类）。
 * **成功用响应里那一份 `budget` 直接重画**（服务端写完就把最新一屏给回来）—— 界面上
 */
async function saveBudgetAmount() {
  const input = $('#lg-bud-input');
  if (!input) return;
  const value = String(input.value == null ? '' : input.value).trim();
  if (!value) {
    toast('填一下额度吧', true);
    input.focus();
    return;
  }
  const t = budTarget || { type: budgetTabOf(), key: budgetPeriodKey(), cid: 0 };
  const sel = $('#lg-bud-cat');
  const cid = sel ? Number(sel.value) || 0 : Number(t.cid) || 0;
  try {
    const r = await api('PUT', '/api/ledger/budget', {
      period_type: t.type,
      period_key: t.key,
      category_id: String(cid),
      amount_fen: value,
    });
    if (r && r.budget) state.lgBudget = r.budget;
    state.lgBudgetLoad = 'done';
    state.lgBudgetErr = '';
    closeModal();
    budTarget = null;
    lgRender();
    toast('额度已保存');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：真去清一行（`DELETE /api/ledger/budget`）—— 总预算 / 分类预算共用这一条。
 *
 * 说明：⭐⭐ `category_id = 0` 时**服务端连带清掉该期全部分类预算**（
 * 要么都成、要么一行都不删）⇒ 前端只要把 `category_id` 如实带上，⛔ 别自己先删分类再删总预算
 * （那是两笔请求、失败就留半截）。⚠️ 幂等：本来就没有那一行也照样成功。
 */
async function budgetClearGo(cat) {
  const t = budTarget || { type: budgetTabOf(), key: budgetPeriodKey(), cid: Number(cat) || 0 };
  const q =
    `period_type=${encodeURIComponent(t.type)}&period_key=${encodeURIComponent(t.key)}` +
    `&category_id=${encodeURIComponent(String(Number(cat) || 0))}`;
  try {
    const r = await api('DELETE', `/api/ledger/budget?${q}`);
    if (r && r.budget) state.lgBudget = r.budget;
    state.lgBudgetLoad = 'done';
    state.lgBudgetErr = '';
    closeModal();
    budTarget = null;
    lgRender();
    toast('清掉了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：点「编辑」那一颗（总预算 / 分类预算各一颗，`data-lg="budgetedit"`）—— ⚠️⭐ 它**不是**
 * 直接开输入框（图 7）：先弹**动作单**。
 *
 * 说明：⭐ 两种下场靠 `data-mode` 分（⛔ 不靠模块变量 —— 那会在重画 / 换档之后失同步）：
 * `menu`（块头上那颗「编辑」）⇒ 动作单；`amount`（动作单里的「编辑XX预算」/ 空态那颗
 */
function pickBudgetEdit(n) {
  const mode = String((n && n.dataset && n.dataset.mode) || 'menu');
  const cid = Number((n && n.dataset && n.dataset.cid) || 0);
  if (mode === 'amount') {
    openBudgetAmount(cid);
    return;
  }
  openBudgetMenu(cid);
}

/**
 * 功能：动作单里那颗「清除XX预算」（`data-lg="budgetclear"`）。
 *
 * 说明：⭐⭐ 两条口径（图 9 /）：**清除总预算** ⇒ 先弹一道「**警告**」二次确认
 * （正文逐字是「清除总预算将同时为您清除所有分类预算」，确认那颗是**红色**）——
 * 它连带清掉那一期**全部**分类预算，是不可逆的一步；清除**某个分类**预算 ⇒ 动作单本身
 */
function pickBudgetClear(n) {
  const cid = Number((n && n.dataset && n.dataset.cid) || 0);
  budTarget = { type: budgetTabOf(), key: budgetPeriodKey(), cid };
  if (cid) return budgetClearGo(cid);
  openConfirmModal(
    '警告',
    '<p class="lg-bwarn">清除总预算将同时为您清除所有分类预算</p>',
    '确定',
    () => budgetClearGo(0),
  );
  return undefined;
}

/**
 * 功能：月详情页那颗「‹ 返回」⇒ 回**账单那一格**（`state.lgMdMonth = 0`）。
 *
 * （账单自己不再自带返回头）。手机端那对应的一份在 `modules/ledger/mobile.js`。
 * @returns {void}
 */
function lgMdBack() {
  state.lgMdMonth = 0;
  state.lgMd = null;
  state.lgMdLoad = 'idle';
  lgRender();
}
