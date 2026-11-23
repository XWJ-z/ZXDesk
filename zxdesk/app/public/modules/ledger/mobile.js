/**
 * modules/ledger/mobile.js —— 记账**手机版视图**
 *
 * 功能：手机版记账这一块的取数与渲染 —— `mountLedger()` 拉一次 `GET /api/ledger/overview`
 * 并把这一块画出来；`lgNew` / `lgRetype` / `lgPick` / `lgEdit` / `lgSave` / `lgDel` 是
 * 「加一个账户」与「改一个账户」的两步弹层（类型选择 → 表单）。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md、docs/公共/开发方案/21-记账2期-记账.md
 */

// 三方导入：上传的是**文件原始字节**（⛔ 不是 JSON）⇒ 那条路走不了
// `api()`（它只会 `JSON.stringify` 一个 body）—— 照课表导入那一套用裸 `fetch` ＋
// `octet-stream`。⚠️ 于是「401 回登录页」与「非 2xx 取服务端那句人话」这两件事得自己接
import { api, backToLogin, BASE } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
// 自动草稿：金额 / 备注这类「填到一半被电话打断」的输入要能回来（取消是明确放弃，另有清除）
import { clearDraft, markSaving, registerResume } from '../../core/draft.js';
// 原生日期 / 时间控件：点任意处都开系统选择器（判据与顺序在那一处，两端共用）
import { bindNativePickerOnce, openNativePicker } from '../../core/native-picker.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, paintChrome, toast } from '../../mobile/ui.js';
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
  // 与 `yTickLabels()`（刻度文字：**一次给一整组**，保证三个刻度互不相同）。
  // 本文件不自己拼「几月」、不自己截金额。
  AXIS_MONTHS,
  yTickLabels,
  // ：按天折线那两件**也收口到共用几何**（见 `dayLineHtml()`）——
  // 本文件不再自己算 `lo/hi/xOf/yOf`（那是同一段算术的第二份拷贝）。
  dayAxisOf,
  dayValuesOf,
  donutArcs,
  ratioPair,
  debtRatioPct,
  USAGE_MAX,
  // 记账屏内导航那几格（`key` ＋ 文案的**唯一出处**，—— 两端共用；
  // 撤掉「记账」那一格 ⇒ 现在是四格，见 `calc.js` 的 `SEGS`）
  SEGS,
  SEG_KEYS,
  // ：**图表**那一套 —— 药丸两档、期间的标签，
  // 以及与折线共用的横轴（`chartAxisOf()`）。⛔ 本文件不自己拼标签、不自己数格数。
  // 口径那颗 `<select>` 换成**两颗按键** ⇒ `CHART_DIRS` 这个 import 用不着了
  SUB_TABS,
  subTabOf,
  chartDirOf,
  chartAxisOf,
  // 记账设置**二级菜单**的条目清单与判据（同上：唯一出处，两端共用）
  SET_PAGES,
  setPageOf,
  // ：导出的「导什么」清单与范围文案（**唯一出处**在 `calc.js`，
  EXPORT_WHATS,
  EXPORT_WHAT_KEYS,
  exportDateOf,
  exportDateText,
  // 分类的**全称**与**重名判据**（二级分类本质上带着上级的名字
  // ⇒ 判断重复也得带上）—— 判据只住 `calc.js` 那一处，⛔ 本文件不自己拼名字、
  // 不自己 `===` 比名字（服务端另有一份同口径的，两层必须一致）。
  catFullName,
  catNameTaken,
  // 记账 3 期：预算 / 账单那一套**两端共用**的纯口径 ——
  // 三档的期间起点、卡片列名、占比读法全在 `calc.js` 里（判据只准一份）；
  // 本文件一个金额都不算（2 期 §5.4「前端不算钱」），这里只做「取值 → 文案」。
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
// 记账 2 期：流水那一套**两端共用的纯展示函数**。
// 金额格式化 / 「眼睛」的掩码 / 月份口径都**直接复用 `calc.js` 那一份**（它自己 import），
// 本文件⛔ 一个实现都不复制（双份判据必然漂移）。
import {
  ENTRY_PAGE_SIZE,
  buildCursor,
  parseCursor,
  groupByDay,
  monthOptions,
  CAT_UNCLASSIFIED,
  catName,
  // 补：分类的两级树与三条判据（一级 / 二级 / 有没有孩子）—— 分类管理那一栏要用，
  // 一律调它们，别在本文件再写 `filter((c) => !c.parent_id)`（判据只准一处）。
  catTree,
  childCats,
  hasKids,
  topCats,
  isRefund,
  refundNoteOf,
  entryTitle,
  signedFen,
  changeTone,
  toneStyle,
  matchNote,
  pickDefaultAccount,
  // —— 月恒 12 项（`MONTHS_ALL`）、年取连续区间（`pickerYears`）、账户详情每月铺满 12 项。
  MONTHS_ALL,
  pickerYears,
  monthOptionsAll,
} from './entry-calc.js';

/** 余额与名称的长度/形状上限由**服务端**判（`modules/ledger/routes.js`），这里只给输入框加 `maxlength` 提示 */
const NAME_MAX = 60;
const NOTE_MAX = 200;

/**
 * 收支分类名的长度上限 —— ⚠️ 与【账户名】那两个上限**各是一个常量**（值恰好都是 60，但它们是
 * 服务端两处不同的判据：`MAX_CATEGORY_NAME` 住 `lib/categories.js`）⇒ 别拿 `NAME_MAX` 顺手一起用
 */
const CAT_NAME_MAX = 60;

/**
 * 眼睛（睁眼 / 闭眼）—— 内联 SVG，**单色形状 + `currentColor` 上色**。
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
 * 分类图标回落用的色板（**零出网**：内置色块 ＋ 名字首字，照 1 期账户那套）。
 *
 */
const CAT_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899'];

/**
 * 功能：一个分类的**回落色**（`id % 色板长度` ⇒ 同一个分类每次都是同一个颜色）。
 *
 * 说明：⭐ 判据**只住这一处**：记一笔的分类网格与明细行里那颗小图标都要用它 ——
 * 两处各写一遍 `% CAT_COLORS.length`，迟早会漂成"同一个分类在两个地方两种颜色"。
 * @param {number} catId - 分类 id（`0` / 空 ⇒ 用色板第一个）
 */
function catColorOf(catId) {
  return CAT_COLORS[Math.abs(Number(catId) || 0) % CAT_COLORS.length];
}

/**
 * 「记一笔 / 记退款」那次流程里「点开那一刻」的**秒**（只活在那一次弹层里）。
 *
 */
let edSec = '00';

/** 正在给哪一笔记退款（`0` = 没开退款弹层）。 @type {number} */
let refundOf = 0;

/**
 * 正在改哪一条流水（`0` = 新建）—— ⭐ 编辑**复用「记一笔」那张弹层**（⛔ 不另画第二份表单：
 * @type {number}
 */
let editId = 0;

/**
 * 编辑时那一条流水的**原值**（`{at, ie, amount, category_id, account_id, note}`）—— 逐键提交要比它。
 *
 */
let editOrig = null;

/**
 * 正在改的这条流水**是不是退款条目**（是的话只让改金额与备注 —— 方向 / 分类 / 账户 / 时间都不动）。
 * @type {boolean}
 */
let editRefund = false;

/**
 * 正在问「新建 / 给某个收支分类改名」哪一个（`null` = 没在问）。
 *
 */
let catAsk = null;

/**
 * 上一次绑过事件的那颗 `#view-ledger` 节点（`null` = 还没绑过）。
 *
 */
let ledgerViewNode = null;

/**
 * 上一次绑过 scroll 委托的那颗**滚动容器**（= 记账借住那一屏的 `.view`）。
 *
 */
let ledgerScrollNode = null;

/**
 * 银行徽章**图标文件**的目录（⚠️ 两端不是同一个串）。
 *
 */
const BRAND_DIR = '../modules/ledger/brands/';

/**
 * 本次「加 / 改一个账户」流程里的**草稿**。
 *
 */
let draft = null;

/**
 * 本次「新建 / 给一套分类改名」的状态（只活在那一次弹窗里）。
 * @type {?{mode: string, id: number}}
 */
let pendingView = null;

/**
 * 本次「新建 / 给一个**用途字段**改名」的行 id（`0` = 新建）。
 *
 */
let pendingUsage = 0;

/**
 * 功能：把「生活记账」那一块画出来（取数 + 渲染）—— 由视图片段 `mobile-assets-pane.js` 调用。
 *
 * 那一屏（屏头药丸「生活记账 ｜ 数码管理 ｜ 自建分组」）。所以这里**不再切屏、不再画底栏**：
 * 骨架（那颗空的 `#view-ledger`）由片段自己造、片段自己插进宿主给的容器。
 * 别把 `switchTab()` / 底栏那一套加回来：屏名 `ledger` 已从 `mobile/app.js` 的
 */
export async function mountLedger() {
  const box = $('#view-ledger');
  if (box) box.innerHTML = '<div class="m-tip">正在读取…</div>';
  // （「隐藏要具有记忆功能：我隐藏了，下次进入还是隐藏状态。并且
  // 手机端和电脑端同步」）：那颗眼睛的**初值来自账号偏好**（`users.hide_ledger_amount`
  // 经 `/api/auth/me` 下来）—— 每次进屏按它复位，所以「上次藏起来了」下次进来还藏着。
  // 放在**取数之前**：下面每一次 `renderLedger()` 都按 `state.lgHide` 画金额，晚一步设
  // 就会先闪一帧"全都露着"的账（防肩窥那件事上，闪一帧就等于没藏）。
  state.lgHide = !!(state.me && state.me.hide_ledger_amount);
  // 进记账把**排序模式**清掉（它是当前这一屏的临时态，⛔ 不跨次会话留着）
  sortMode = false;
  // 同理把「明细」那一格的**搜索态**清掉（重进屏不该还停在搜索框上）
  searchOn = false;
  // 2 期：取名口与 overview **一起发**（两个都是 GET）—— 下面每一次渲染都要用它，
  // 晚一步画出来的就是"已删账户没有名字的那一版"（而它**不报错**，只是看起来像名字丢了）。
  await Promise.all([loadLedger(), ensureAcctNames()]);
  // 进记账就把「记账」那一侧要用的三份取好 —— 收支分类 / 默认账户 /
  // 这个月的流水。⚠️ 分类与默认账户**取不到也不拦**这一屏画出来（记一笔会再试一次并说清
  // 原因）：一个可选的请求把整屏按住，用户看到的是「记账打不开」。
  await Promise.all([ensureCats(), ensureDefaults()]);
  // 上次停在某个账户的**详情屏**上时，明细也重取一次 ——
  // `overview` 里没有明细，只重取它会把上一次那一份原样画回来（过期、且不报错）。
  // 那个账户如果已经不在了（另一台设备上删的），`renderLedger()` 已经回落列表并把
  if (Number(state.lgAcct)) {
    await openLedgerAccount(state.lgAcct);
  } else if (state.lgSeg === 'detail') {
    // 默认那一格是「明细」⇒ 进来直接把流水取回来
    // （每次进来都重取，与番茄钟同款）。⚠️ 流水那一套渲染**只归明细屏**
    // （流水列表按天分组的渲染从「记账」那一格**挪到**这里）
    await loadEntries(true);
  } else if (state.lgSeg === 'budget') {
    // 进「预算」那一格也把这一期取回来（进屏重取，与服务端口径同源）。
    await openBudget();
  } else {
    // 「资产」/「记账」/「设置」这三格：分类与默认账户刚到手，重画一次把它们填进去
    // （⭐ 「记账」那一格现在只画一颗「＋ 记一笔」；「设置」升成同级格之后走的也是这条）。
    renderLedger();
    // 进「设置」那一格顺手取一次**三方导入概况**（进屏取一次，三态）。
    // 只在这一格取（明细 / 预算那两格各自有自己的一份取数，⛔ 别顺手多拉一份）。
    if (segOf() === 'set') loadImportSummary();
  }
}

/**
 * 功能：拉一次 `GET /api/ledger/overview` 并重画；失败时把这一屏写成一句人话。
 * @returns {Promise.<void>}
 */
export async function loadLedger() {
  try {
    // ：带上看的是哪一年（初值 0 = 还没取过 ⇒ 让服务端回「今年」）
    const y = Number(state.lgYear) || 0;
    const d = await api('GET', '/api/ledger/overview' + (y ? '?year=' + y : ''));
    state.lg = d;
    if (!y) state.lgYear = Number(String((d && d.today) || '').slice(0, 4)) || 0;
    renderLedger();
  } catch (e) {
    const box = $('#view-ledger');
    // 这里**不用** `mobile/ui.js` 的 `errHtml()`：它那颗「重新加载」打的是**整页**的
    // `refresh`（重取 bootstrap / 任务 / 项目），**不会**重新取记账这一屏的数据 ⇒
    // 点了没反应。重试必须走记账自己的动作（`teamwork/mobile.js` 出于同一个理由也自写了一份）。
    if (box) {
      box.innerHTML = `<div class="err-box"><b>读取失败</b><p>${esc(e.message)}</p>
        <button class="chip on" type="button" data-act="lg-refresh" style="margin-top:14px">重新加载</button></div>`;
    }
    toast(e.message, true);
  }
}

// ============================================================================
// 记账 2 期：取数层 —— 分类 / 默认账户 / 流水 / 三类变动
// 这一层只做「取回来 + 折形状」，⛔ 一个展示判据都不写（它们全住 `entry-calc.js`）。

/**
 * 功能：本地时钟当前的 `HH:MM` 与 `SS` —— ⚠️ **只用于「时间」那一格的初值**。
 *
 * 说明：⭐⭐ 秒**必须由前端带上**（服务端只收 `YYYY-MM-DD HH:MM:SS`，它无从知道"用户点开
 * 这一格那一刻"的秒 ——  第 11 条）。日期用**服务端今天**（同源，
 * 不用本机日期），分钟用本机时钟 —— 服务端没给「现在几点」，这两件事在报告里写清。
 */
function nowPrefix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { hm: `${p(d.getHours())}:${p(d.getMinutes())}`, ss: p(d.getSeconds()) };
}

/**
 * 功能：取一次收支分类清单（`GET /api/ledger/categories`，两级一次性给全，含已归档）。
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
    // 取不到**不抛**：流水列表照样能画（分类名降级成「未分类」），
    // 记一笔会再试一次并说清原因（一个可选的请求不该把整屏按住）。
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
 * （类别 → 全局（按收 / 支）→ 空账户）。
 * 默认账户被删掉 ⇒ 服务端那一格回 `null` ⇒ `pickDefaultAccount()` 会跳过它继续往下兜。
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
 * 空账户在库里叫「空账户」，而界面上它代表**「不关联」**—— 这个转换住
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

/**
 * 功能：把月份记进「这次会话见过的月」清单 —— 下拉要把**访问过的月**留住。
 *
 * 说明：⚠️ 「有记录的月」服务端**没有**一条接口给（报告里的阻塞项）⇒ 下拉选项只能拿
 * `overview.snapshots` 里出现过的月（每次写操作都落当天快照 ⇒ 是"真实用过"的近似）
 * ∪ 今天那个月 ∪ 这一份。⛔ 绝不凭空铺一整年空月份给用户挑（挑到空白页他不知道那不是 bug）。
 */
function rememberMonth(m) {
  const v = String(m || '').trim();
  if (!/^\d{4}-\d{2}$/.test(v) || state.lgMonths.includes(v)) return;
  state.lgMonths.push(v);
}

/**
 * 功能：流水那一屏月份下拉的选项（`monthOptions` 只做归一与去重，⛔ 不另立第二种顺序）。
 * @returns {Array.<string>} 月份键（`YYYY-MM`，倒序）
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

/** 功能：详情屏月份下拉的选项（同上）。 @returns {Array.<string>} 月份键（倒序） @since */
function chgMonthOptions() {
  const todayMonth = monthOf((state.lg && state.lg.today) || '');
  // ：**主来源是服务端的
  // `/api/ledger/periods`**（`state.lgPeriods.months`：有数据的月，含**三方导入**的月）。
  // 光靠 `state.lgChg` 推不出来：它是**这一页明细**（接口一次只给一个月的 30 条）⇒
  const rows = [].concat(state.lgChg || [], (state.lgPeriods && state.lgPeriods.months) || [], state.lgMonths, [chgMonthKey()]);
  // **每一年铺满 12 个月**。与电脑端逐字同一条修法。
  return monthOptionsAll(rows, todayMonth);
}

/**
 * 功能：取一页流水（`GET /api/ledger/entries`）—— 按月 ＋ **游标**，一次 30 条。
 *
 * 说明：⭐⭐ 分页⛔ **不用 offset**（C-15 /  第 3 条）：游标是**不透明串**，先
 * `parseCursor()` 验一次形状再发 —— 认不出就当"没有游标"（＝从头取这一页），
 * 绝不把一个猜出来的值发上去（那会**静默翻错页**，界面上看不出任何异常）。
 */
async function loadEntries(reset) {
  if (reset) {
    state.lgEntries = [];
    state.lgCursor = null;
    state.lgDone = false;
    // 换月重取时把上一个月那两组合计也清掉：留着的话「流水还没回来」的那一瞬间，
    // 页首会拿**上个月**的合计去配**这个月**的标题（而它不报错，只是数对不上）。
    state.lgSum = null;
    state.lgDayTotals = null;
    // 换月时把上一个月那份**导入行**也清掉：它是**服务端按月一次性给全**的
    // （不分页），留着的话「新一个月还没回来」的那一瞬间，明细屏会拿上个月的导入行
    // 去配这个月的标题（与上面那两组合计同一条理由，而且**不报错**）。
    impRows = [];
  }
  state.lgLoad = 'loading';
  state.lgErr = '';
  renderLedger();
  const month = monthKey();
  const cur = parseCursor(state.lgCursor);
  let url = `/api/ledger/entries?month=${encodeURIComponent(month)}&limit=${ENTRY_PAGE_SIZE}`;
  if (cur) url += `&before=${encodeURIComponent(buildCursor(cur.at, cur.id))}`;
  try {
    const r = await api('GET', url);
    const rows = r && Array.isArray(r.entries) ? r.entries : [];
    state.lgEntries = reset ? rows : state.lgEntries.concat(rows);
    state.lgDone = rows.length < ENTRY_PAGE_SIZE;
    const last = rows[rows.length - 1];
    state.lgCursor = state.lgDone || !last ? null : buildCursor(last.at, last.id);
    // 明细屏那两组合计**搭车回来**
    // —— 一是当月收入 / 支出（`summary`）、二是**按天**两个小计（`dayTotals`）。
    // 两组数**一律由服务端给**（2 期 §5.4「前端不算钱」）：前端只按 `at` 的前 10 个
    if (r && r.summary) state.lgSum = r.summary;
    if (r && r.dayTotals) state.lgDayTotals = r.dayTotals;
    // 三方导入：导入行**搭同一个响应**回来（`imported`，
    // 该月**全部**行、不分页）⇒ ⛔ 绝不为它再发第二个请求。
    // 一律**整份替换**（`impRows = r.imported`），⛔ **绝不 `concat`** ——
    if (r && Array.isArray(r.imported)) impRows = r.imported;
    rememberMonth(month);
    state.lgLoad = 'done';
  } catch (e) {
    state.lgLoad = 'error';
    state.lgErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：取一页「三类变动」（`GET /api/ledger/accounts/:id/changes`）—— 账户详情那一屏。
 *
 * 说明：⭐⭐ 与流水同一套：**按月 ＋ 游标**（⛔ 不用 offset）、三态**不抛**；账户不存在 ⇒ 404
 * （服务端把越权与不存在统一成 404）。
 * 请求飞回来时要**再确认一次**还停在同一个账户上：用户可能在请求期间点了返回 /
 */
async function loadChanges(reset) {
  const aid = Number(state.lgAcct) || 0;
  if (!aid) return;
  if (reset) {
    state.lgChg = [];
    state.lgChgCursor = null;
    state.lgChgDone = false;
  }
  state.lgChgLoad = 'loading';
  state.lgChgErr = '';
  renderLedger();
  const month = chgMonthKey();
  const cur = parseCursor(state.lgChgCursor);
  let url = `/api/ledger/accounts/${aid}/changes?month=${encodeURIComponent(month)}&type=${encodeURIComponent(
    state.lgType,
  )}`;
  if (cur) url += `&before=${encodeURIComponent(buildCursor(cur.at, cur.id))}`;
  try {
    const r = await api('GET', url);
    if (Number(state.lgAcct) !== aid) return;
    const rows = r && Array.isArray(r.changes) ? r.changes : [];
    state.lgChg = reset ? rows : state.lgChg.concat(rows);
    state.lgChgDone = rows.length < ENTRY_PAGE_SIZE;
    const last = rows[rows.length - 1];
    state.lgChgCursor = state.lgChgDone || !last ? null : buildCursor(last.at, last.id);
    rememberMonth(month);
    state.lgChgLoad = 'done';
  } catch (e) {
    if (Number(state.lgAcct) !== aid) return;
    state.lgChgLoad = 'error';
    state.lgChgErr = e.message;
  }
  renderLedger();
}

/** 星期几的中文单字（`getDay()` 的下标：0 = 周日）。⚠️ 只住这一处，⛔ 别在别处再拼一份。 @type {Array.<string>} */
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 功能：把 `YYYY-MM-DD` 写成明细屏的**组标题**「09月19日 星期六」（认不出就把原串照显）。
 *
 * 说明：⭐ 版式权威是参考图 1 / 图 8（两处都是 `09月19日 星期六` / `09月22日 星期二`）——
 * **月、日补零**、后面跟一个「星期X」。
 * 星期用**本地时区**的 `getDay()`：与 `dateOf()` 的「今天」、`at` 的写法是同一条尺子
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
 * 功能：把「金额该带什么符号」这件事从**服务端的 `groups[].side`** 推出来。
 *
 * 说明：⭐⭐ ⛔ 前端**不自己写一份「哪一类是负债」的表** —— 两份判据必然漂移，而它管的是
 * 金额前面的负号（漂移 = 把「欠 5908」显示成「有 5908」，且不报错）。
 * 服务端没给侧的类型（理论上不该有）拿不到侧 ⇒ 显示不带符号，但**照样画出来**
 */
function sideMapOf(d) {
  const m = new Map();
  for (const g of (d && d.groups) || []) m.set(g.kind, g.side);
  return m;
}

/**
 * 功能：画那颗**眼睛** —— 点一下把所有金额糊成圆点（要的「防肩窥」）。
 *
 * 说明：⚠️ 两态各一个图形（睁眼 = 现在看得见、闭眼 = 已藏起来），⛔ 不靠颜色深浅区分
 * （「选中态靠 加粗+底色+描边」那条纪律同样适用）。
 * 它只是**显示层**的开关：金额本来就随 `overview` 下来了，⛔ 别把它当成权限或加密
 */
function eyeHtml() {
  return `<button class="lg-eye" type="button" data-act="lg-eye" aria-label="${
    state.lgHide ? '显示金额' : '隐藏金额'
  }">${state.lgHide ? EYE.off : EYE.on}</button>`;
}

/**
 * 功能：画「净值卡」—— 品牌色底、净资产大字，下面两栏资产 / 负债。
 *
 * 说明：⚠️ 卡里那一栏 `负债` **刻意不带负号**（参考图 A 就是 `负债 25908.01`）——
 * 负号出现在**分组列表**里（那里才是「这一组要减掉」的位置）。
 * 卡角上那颗眼睛是**全屏的金额开关**（列表 / 分组小计 / 账户行 / 详情全跟着它）。
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
 * 说明：⚠️ 列表行与详情屏的头部卡共用它（同一份判据、同一个形状）：⛔ 别在详情里再抄一遍
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
 * 功能：画一个账户行 —— 图标块 ＋ 名称（带后四位）＋ 副标题 ＋ 右侧金额；整行可点（进**详情**）。
 *
 * **浅中性底 + 原色标**（`.lg-ico.lg-bank`），认不出就回落类目那套「浅底 + emoji」
 * （⛔ 不是错误，用户手输「重庆银行」很常见）。
 * 整行点开的是**账户详情**（不再是编辑表单）——详情屏底部那颗
 */
function rowHtml(a, sides) {
  const title = a.tail ? `${a.name}(${a.tail})` : a.name;
  return `<button class="lg-row" type="button" data-act="lg-open" data-id="${Number(a.id)}" data-drag="acct" data-did="${Number(a.id)}">
    ${icoBlockHtml(a)}
    <span class="lg-main">
      <b class="lg-name">${esc(title)}</b>
      ${a.note ? `<i class="lg-sub">${esc(a.note)}</i>` : ''}
    </span>
    <b class="lg-amt">${esc(fmtSide(a.opening_fen, sides.get(a.kind), state.lgHide))}</b>${sortHandleHtml()}
  </button>`;
}

/**
 * 功能：画一个分组 —— 组名 + 组小计（`debt` 侧带 `−`）一行，下面各组内账户。
 *
 * 所以这里直接照它画就行，⛔ 不必自己判「这组有没有数据」。
 * 一个组内的行**必然同侧**（侧由 `kind` 决定），所以 `sides` 那张表对组内每一行都命中。
 *
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
    <div class="lg-ghead"${gid ? ` data-drag="group" data-gid="${gid}"` : ''}><span>${esc(m.name)}</span><b>${esc(fmtSide(g.total_fen, g.side, state.lgHide))}</b>${sortHandleHtml()}</div>
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
 * 功能：画顶部那排「视图」胶囊 —— 「按账户类型」（内置）＋ 各套自定义分类 ＋ 一颗「⋯」。
 *
 * 说明：⭐ 切视图只重画列表、**不重新取数**（`overview` 一次就给全了）。
 *
 * @param {Array.<Object>} views - `overview.views`
 */
function viewBarHtml(views, cur) {
  const chip = (id, name, on) =>
    `<button class="lg-vchip${on ? ' on' : ''}" type="button" data-act="lg-view" data-id="${Number(id)}" data-drag="chip" data-did="${Number(id)}">${esc(name)}${sortHandleHtml()}</button>`;
  // 内置的两颗（按账户类型 / 按账户用途）**也在 `views` 里**（`builtin` 1 / 2）
  // ⇒ 这一排直接按服务端给的顺序画。⛔ 别再手写一颗「按账户类型」——
  // 写死的话它的位置就永远在最前面，而「胶囊顺序也能拖」这条需求当场作废。
  return `<div class="lg-views">${views
    .map((v) => chip(v.id, v.name, !!cur && Number(cur.id) === Number(v.id)))
    .join('')}<button class="lg-vmore" type="button" data-act="lg-viewmore" title="管理分类">⋯</button></div>`;
}

/**
 * 功能：按**用途**把账户分组画出来（一套自定义分类下的列表）。
 *
 * 说明：⚠️ 组顺序与小计都是**服务端算好的**（`views[].groups`），前端只摆放。
 * 组小计是**代数和**（资产正 / 负债负）⇒ 这里直接用 `fmtFen`，⛔ 不像类型视图那样按侧补负号。
 * 「其它」＝ 这套分类下没分的账户；一个都没有时整段不画。
 */
function tagGroupsHtml(v, accounts, sides) {
  const tagOf = (a) => String((a.tags || {})[v.id] || '').trim();
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
    <div class="lg-ghead"${gid ? ` data-drag="group" data-gid="${Number(gid)}"` : ''}><span>${esc(name)}</span><b>${esc(fmtFen(total, state.lgHide))}</b>${sortHandleHtml()}</div>
    ${rows}
  </div>`;
  // 内置「按账户用途」与自建分类**有两种不同的组**——
  // 而归属那一列存的是**用途键**（`u3`）⇒ 必须用 `usageGroupsOf()` 把键翻成名字；
  // 自建（`builtin = 0`）：组就是服务端算出来的那几个（用途名当键，原有语义）。
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

/** 功能：画「管理分类」那一页（各套分类的改名 / 删除 ＋ 末尾「＋ 新建分类」）。 @returns {void} */
function viewManageSheet() {
  const views = viewList();
  const rows = views
    .map((v) => {
      // 内置那两颗（按账户类型 / 按账户用途）**不给改名 / 删除的按钮** ——
      // 它们的名字与存亡由产品定（接口层也会拒）。画了按钮才 400 是最差的一种，
      // 用户以为能改、点了才知道不行。
      const bi = Number(v.builtin) > 0;
      const acts = bi
        ? '<i class="lg-sub">内置</i>'
        : `<button class="btn ghost sm" type="button" data-act="lg-viewren" data-id="${Number(v.id)}">改名</button>` +
          `<button class="btn danger sm" type="button" data-act="lg-viewdel" data-id="${Number(v.id)}">删除</button>`;
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
    `<button class="lg-pick lg-newkind" type="button" data-act="lg-viewnew"${full ? ' disabled' : ''}>` +
    `${full ? `＋ 新建分类（已满 ${VIEW_MAX} 个）` : '＋ 新建分类'}</button>`;
  openSheet('管理分类', rows + newBtn + usageManageHtml());
}

/** 功能：「⋯」⇒ 管理分类那一页。 @returns {void} */
export function lgViewManage() {
  viewManageSheet();
}

/**
 * 功能：新建 / 给某套分类改名（同一张表单）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id` 有值 = 改名）
 * @returns {void}
 */
export function lgViewName(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const v = viewList().find((x) => Number(x.id) === id);
  if (id && !v) return;
  pendingView = { mode: id ? 'ren' : 'new', id };
  openSheet(
    id ? '给这个分类改名' : '新建分类',
    `<label class="fld"><span>分类名</span>
      <input id="lg-f-vname" type="text" maxlength="${VIEW_NAME_MAX}" value="${esc(id ? v.name : '')}" /></label>`,
    `<button class="btn primary" type="button" data-act="lg-viewsave" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：存下新建 / 改名，回「管理分类」那一页。
 * @returns {Promise.<void>}
 */
export async function lgViewSave() {
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
      // 新建之后直接切过去（用户建一套分类就是为了马上按它看）
      state.lgView = Number(made.id);
    }
    await loadLedger();
    viewManageSheet();
    toast(p.mode === 'ren' ? '改好了' : '分类建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 功能：删一套分类（危险确认）—— 文案说清「账户一个都不会变」。 @param {Object} _act - 动作名（未用） @param {Object} n - 触发按钮（`data-id`） @returns {void} */
export function lgViewDel(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const v = viewList().find((x) => Number(x.id) === id);
  if (!v) return;
  askConfirm({
    title: '删除这个分类？',
    text: `删了就找不回来了。⚠️ 账户一个都不会变 —— 只是以后不能按「${v.name}」分组看了。`,
    ok: '永久删除',
    danger: true,
  }).then((ok) => {
    if (ok) viewDelGo(id);
  });
}

/** 功能：真的删（确认之后走这里）。 @param {number} id - 分类 id @returns {Promise.<void>} */
async function viewDelGo(id) {
  try {
    await api('DELETE', `/api/ledger/views/${Number(id)}`);
    if (Number(state.lgView) === Number(id)) state.lgView = 0;
    await loadLedger();
    viewManageSheet();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}


/**
 * 功能：内置「按账户用途」的那些**字段**（服务端排好序的那一份）。
 *
 * 说明：⭐⭐ 它们与「分类」（`ledger_views`）是两样东西：分类是「按什么看」（视图），
 * 用途是**那个视图里一列的取值**（字段）。所以增删改名住这里，⛔ 不去动分类那一块。
 * **顺序不在这里管** —— 拖顺序就是「在列表屏长按拖动组标题」，复用同一套机制
 */
function usageList() {
  return ((state.lg && state.lg.usages) || []).filter((u) => u && u.id);
}

/**
 * 功能：画「管理分类」那页里那块**用途字段**区（一个用途定义都没有时整块不画）。
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
        : `<button class="btn ghost sm" type="button" data-act="lg-usageren" data-id="${Number(u.id)}">改名</button>` +
          `<button class="btn danger sm" type="button" data-act="lg-usagedel" data-id="${Number(u.id)}">删除</button>`;
      return `<div class="lg-krow"><span class="lg-kmain"><b>${esc(u.name)}</b></span>${acts}</div>`;
    })
    .join('');
  const full = list.length >= USAGE_MAX;
  const newBtn =
    `<button class="lg-pick lg-newkind" type="button" data-act="lg-usagenew"${full ? ' disabled' : ''}>` +
    `${full ? `＋ 新建用途（已满 ${USAGE_MAX} 个）` : '＋ 新建用途'}</button>`;
  return (
    '<div class="lg-subcap"><b>「按账户用途」的字段</b>' +
    '<i class="lg-sub">改名之后，归在这组下面的账户会跟着新名走；顺序在列表里长按拖动组标题调整</i></div>' +
    rows +
    newBtn
  );
}

/**
 * 功能：新建 / 给某个用途字段改名（同一张小表单）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id` 有值 = 改名）
 * @returns {void}
 */
export function lgUsageName(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const u = usageList().find((x) => Number(x.id) === id);
  if (id && !u) return;
  pendingUsage = id;
  openSheet(
    id ? '给这个用途改名' : '新建用途',
    `<label class="fld"><span>用途名</span>
      <input id="lg-f-uname" type="text" maxlength="${TAG_MAX}" value="${esc(id ? u.name : '')}" /></label>` +
      // 这句必须写出来：用户最怕的就是「改个名，原来的账户全掉了」
      (id ? '<p class="lg-tip">已经归在这个用途下的账户会<b>跟着新名走</b>，一笔都不会掉。</p>' : ''),
    '<button class="btn primary" type="button" data-act="lg-usagesave" style="flex:1.4">保存</button>',
  );
}

/**
 * 功能：存下新建 / 改名的结果，回「管理分类」那一页。
 * @returns {Promise.<void>}
 */
export async function lgUsageSave() {
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
    await loadLedger();
    viewManageSheet();
    toast(id ? '改好了' : '用途建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：删一个用途字段（危险确认）—— 文案说清「那些账户去哪了」。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id`）
 * @returns {void}
 */
export function lgUsageDel(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const u = usageList().find((x) => Number(x.id) === id);
  if (!u) return;
  askConfirm({
    title: '删除这个用途？',
    text: `删了就找不回来了。原本归在「${u.name}」下面的账户会挪到「其它」，账户本身一个都不会少。`,
    ok: '永久删除',
    danger: true,
  }).then((ok) => {
    if (ok) usageDelGo(id);
  });
}

/** 功能：真的删（确认之后走这里）。 @param {number} id - 用途字段的行 id @returns {Promise.<void>} */
async function usageDelGo(id) {
  try {
    await api('DELETE', `/api/ledger/usages/${Number(id)}`);
    await loadLedger();
    viewManageSheet();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
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
 * 功能：点顶部胶囊 ⇒ 换个视图看（⛔ 不重新取数：`overview` 一次就给全了）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id`：0 = 按账户类型）
 * @returns {void}
 */
export function lgViewChip(_act, n) {
  state.lgView = Number((n && n.dataset && n.dataset.id) || 0);
  renderLedger();
}

/**
 * 功能：画「某个分类下，这个账户算哪一类用途」那一格。
 *
 * 说明：⚠️ 用途**从这套分类已有的用途里选**（＋「＋ 新建用途…」与「不分类」）——⛔ 不做自由文本
 * 选了「＋ 新建用途…」只换盒子里的控件（⛔ 不重画整个弹层，免得抹掉别的字段）。
 *
 */
function tagFieldHtml(v, cur) {
  return `<label class="fld" id="lg-f-tag-${Number(v.id)}wrap"><span id="lg-f-taglabel-${Number(v.id)}">${esc(v.name)}</span>
      <span id="lg-f-tagbox-${Number(v.id)}">${tagSelectHtml(v, cur)}</span></label>`;
}

/**
 * 功能：画那一格里的下拉（不分类 / 已有的用途 / ＋ 新建用途…）。
 * @param {Object} v - 一套自定义分类
 * @param {string} cur - 当前用途
 * @returns {string} `<select>` 的 HTML
 */
function tagSelectHtml(v, cur) {
  const one = (val, text) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(text)}</option>`;
  // 内置「按账户用途」的选项来自 `overview.usages`：**值 = 用途键、文字 = 用途名**。
  // （改一次名，归在那组下面的账户会静默掉到「其它」）。
  // 也不给它「＋ 新建用途…」：内置那 7 个是**字段**，增删入口在「管理分类」那一页，
  const builtin = Number(v.builtin) || 0;
  const opts =
    builtin === 2
      ? ((state.lg && state.lg.usages) || []).map((u) => ({ val: String(u.gkey), text: String(u.name) }))
      : (Array.isArray(v.groups) ? v.groups : []).map((g) => ({ val: String(g.tag), text: String(g.tag) }));
  const newOpt = builtin === 2 ? '' : one('__new__', '＋ 新建用途…');
  return `<select id="lg-f-tag-${Number(v.id)}" data-tagview="${Number(v.id)}">${one('', '不分类')}${opts
    .map((o) => one(o.val, o.text))
    .join('')}${newOpt}</select>`;
}

/**
 * 功能：在下拉里选了「＋ 新建用途…」⇒ 把**那一格**换成输入框。
 * @param {Object} sel - 那个 `<select>` 元素
 * @returns {void}
 */
function askNewTag(sel) {
  const vid = Number(sel && sel.dataset && sel.dataset.tagview);
  const box = $(`#lg-f-tagbox-${vid}`);
  if (!box) return;
  box.innerHTML = `<input id="lg-f-tagnew-${vid}" type="text" maxlength="${TAG_MAX}" />`;
  const inp = $(`#lg-f-tagnew-${vid}`);
  if (inp) inp.focus();
}

// ---------- 账户详情（二级屏，照参考图 1）：转账 · 调整余额 · 明细 ----------

/**
 * 功能：按 id 从当前 `overview` 里找账户（找不到回 `null`）。
 * @param {number} id - 账户 id
 * @returns {?Object} 那个账户
 */
function accountOf(id) {
  const rid = Number(id) || 0;
  if (!rid) return null;
  return ((state.lg && state.lg.accounts) || []).find((x) => Number(x.id) === rid) || null;
}

/**
 * 功能：账户的显示名 —— 有后四位就带上（`工商银行(1904)`）。
 *
 * 说明：⚠️ 转账弹层、明细里的「对方账户」、详情卡的标题全用它 ⇒ 三处同一个写法
 * （⛔ 别各拼一份：同一家银行在两处一个带后四位一个不带，看着像两个账户）。
 * @param {Object} a - 账户
 */
function labelOf(a) {
  return a && a.tail ? `${a.name}(${a.tail})` : String((a && a.name) || '');
}

/**
 * 功能：画详情屏顶上那条 —— `‹ 返回` ＋ 「资产详情」 ＋ 眼睛。
 *
 * 说明：⭐ 顶栏（宿主那条 `ZX ｜ 记账`）在这一屏**收起来**（`.topbar-bare`，
 * 与对话的会话页同一手法）⇒ 标题与返回都在这里，⛔ 不会出现两个标题摞在一起。
 * @returns {string} 这一条的 HTML
 */
function detailHeadHtml() {
  return `<div class="lg-dhead">
    <button class="lg-back" type="button" data-act="lg-back" aria-label="返回">‹</button>
    <b>资产详情</b>
    ${eyeHtml()}
  </div>`;
}

/**
 * 功能：画详情屏顶上那张**账户卡** —— 图标 ＋ 名称 ＋ 类型 ＋ 备注 ＋ 余额 ＋「调整余额」。
 *
 * 说明：⚠️ 余额与列表行**同口径**（负债侧带 `-`）：同一个数在两处显示成两种样子是最容易
 * 让人怀疑「哪个才是真的」的那种不一致（侧由服务端 `groups[].side` 决定）。
 *
 */
function detailCardHtml(a, sides) {
  const m = metaOf(a.kind);
  return `<div class="lg-dcard">
    <div class="lg-dtop">${icoBlockHtml(a)}
      <span class="lg-dmain"><b>${esc(labelOf(a))}</b><i class="lg-dtag">${esc(m.name)}</i></span>
    </div>
    ${a.note ? `<div class="lg-dnote">${esc(a.note)}</div>` : ''}
    ${limitBlockHtml(a)}
    <div class="lg-dbal">
      <span><b>${esc(fmtSide(a.opening_fen, sides.get(a.kind), state.lgHide))}</b><i>余额</i></span>
      <button class="lg-dadj" type="button" data-act="lg-balance">调整余额</button>
    </div>
  </div>`;
}

/**
 * ：账户详情那一段「变动类型」过滤的四个档。
 *
 */
const CHG_TYPES = [
  { key: 'all', name: '全部' },
  { key: 'entry', name: '记账' },
  { key: 'transfer', name: '转账' },
  { key: 'adjust', name: '调整' },
];

/**
 * 功能：画详情屏顶上那条 —— `收支明细` ＋ 两颗下拉（**变动类型** ＋ **月份**，并排）。
 *
 * 说明：⚠️ 月份那颗的 `id` 是 `lg-c-month`（c = changes）：**两端各一份 DOM**，
 * 所以两边的 id 也可以不一样 —— ⛔ 别为了"同名"去借 1 期那颗 `lg-f-month` 的 id
 * （那是另一条屏上的控件，同一个框里出现两个同名节点是查起来最久的那种）。
 */
function chgHeadHtml() {
  const opts = chgMonthOptions()
    .map((k) => `<option value="${esc(k)}"${k === chgMonthKey() ? ' selected' : ''}>${esc(monthLabel(k))}</option>`)
    .join('');
  const tOpts = CHG_TYPES.map(
    (t) => `<option value="${esc(t.key)}"${t.key === state.lgType ? ' selected' : ''}>${esc(t.name)}</option>`,
  ).join('');
  return `<div class="lg-txhead"><b>收支明细</b>
    <span class="lg-txfilters">
      <select id="lg-c-type" aria-label="选择变动类型">${tOpts}</select>
      <select id="lg-c-month" aria-label="选择月份">${opts}</select>
    </span></div>`;
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
 * 功能：画明细那一块 —— **三态分得开**：读取中 / 读不到（一句人话 ＋ 重试） / 这个月没有。
 *
 * 说明：⭐⭐ 三态必须分开：「读取中」「一条都没有」「没读到」是**三件不同的事**——
 * 把失败画成空态＝把错误藏起来（用户会以为"我确实没转过账"）。
 * ：**按天分组**显示 ——
 */
function chgListHtml(a) {
  if (state.lgChgLoad === 'error') {
    return `<div class="err-box"><b>明细没读到</b><p>${esc(state.lgChgErr || '原因不明')}</p>
      <button class="chip on" type="button" data-act="lg-chgagain" style="margin-top:14px">重新加载</button></div>`;
  }
  if (state.lgChgLoad === 'loading' && !state.lgChg.length) return '<div class="lg-txwait">正在读取…</div>';
  if (!state.lgChg.length) {
    return `<div class="empty slim"><div class="e-ico">🧾</div><h3>这个月还没有记录</h3>
      <p>记账 / 转账 / 调整余额都会出现在这里。</p></div>`;
  }
  // 这一句「正在读取…」**只许画一处**：手上已经有行、还在取下一页时，指示条归
  // 出现两遍 —— 而且**不会报错**（换月 / 换类型时列表已被清空，走的是上面那条早返回）。
  // 2 期：明细里的转账行要取**对方账户**的名字（可能是已删账户）⇒ 与流水用同一份 map
  const names = acctNameMap();
  return groupByDay(state.lgChg, 'at').map((g) => chgDayHtml(g, a, names)).join('');
}

/**
 * 功能：明细里的**一天** —— 日期头（左边日期 ＋ 星期，右边这一天的收支小计）＋ 当天那几条变动。
 *
 * 说明：⚠️ 日期头的版式与流水屏 `.lg-eday` **同一套**（类名与 `dayHeadLabel()` 都复用），
 * 不另起一个"账户详情专用的日期头"。
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
 * 功能：详情屏底下那条「加载更多」（到底了 / 读不到时整条不画）。
 *
 * （「手机端-资产详情的【加载更多】应该是条目滑动到底才显示的，
 * 而不是一直显示」）：它现在**画在那条变动明细里面**（`detailHtml()` 把它放进 `.lg-txlist`）
 * —— 它是那一格的**滚动内容**，只有滚到列表底部才看得到。
 */
function chgMoreHtml() {
  if (state.lgChgLoad === 'loading' && state.lgChg.length) return '<div class="lg-txwait">正在读取…</div>';
  if (state.lgChgLoad !== 'done' || state.lgChgDone) return '';
  return '<button class="lg-more" type="button" data-act="lg-chgmore">加载更多</button>';
}

/**
 * 功能：画详情屏整块（头部 ＋ 账户卡 ＋ 收支明细头（两颗下拉）＋ 三类明细 ＋ 底部三颗动作）。
 * @param {Object} a - 账户
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 这一屏的 HTML
 */
function detailHtml(a, sides) {
  return `<div class="lg-detail">
    ${detailHeadHtml()}
    ${detailCardHtml(a, sides)}
    ${chgHeadHtml()}
    <div class="lg-txlist">${chgListHtml(a)}${chgMoreHtml()}</div>
    <div class="lg-dacts">
      <button class="lg-dact" type="button" data-act="lg-transfer">转账</button>
      <button class="lg-dact" type="button" data-act="lg-edit" data-id="${Number(a.id)}">设置</button>
      <button class="lg-dact danger" type="button" data-act="lg-del" data-id="${Number(a.id)}">删除资产</button>
    </div>
  </div>`;
}

/**
 * 功能：进**账户详情**（取三类变动 + 重画这一屏）。
 *
 * 说明：⭐ 明细是**单独一次请求**（`GET /api/ledger/accounts/:id/changes`）：一屏一次给全那条
 * 每次进列表都白拉一份可能很长的明细。
 * 进这一屏要把类型过滤复位成「全部」（与电脑端同款：上次筛的是转账，这次进来
 */
export async function openLedgerAccount(id) {
  const rid = Number(id) || 0;
  if (!rid) return;
  state.lgAcct = rid;
  state.lgChg = [];
  state.lgChgLoad = 'idle';
  state.lgChgErr = '';
  state.lgType = 'all';
  // 默认落在「服务端今天」那个月（⛔ 不用本机日期）
  state.lgChgMonth = monthOf((state.lg && state.lg.today) || '');
  await loadChanges(true);
  // ：月份下拉的主来源是
  // 服务端的期间清单（`/api/ledger/periods` 的 `months`，见 `chgMonthOptions()`）——
  // 第一次进详情时顺手取一次。⚠️⭐ 它**不 await**（明细那条请求已经先跑完了，不用拖住它）；
  if (!state.lgPeriods) loadPeriods();
}

/** 功能：列表屏点某一行 ⇒ 进它的详情。 @param {Object} _act - 动作名（未用） @param {Object} _n - 触发按钮（未用） @param {Function} id - 取 `data-id` 的函数 @returns {void} */
export function lgOpen(_act, _n, id) {
  openLedgerAccount(Number(id()));
}

/**
 * 功能：「‹ 返回」⇒ 回列表屏（并把这几个只属于详情屏的临时状态清掉）。
 *
 * 说明：⚠️ 必须清月份 / 明细 / 错误文案：不清的话，下次点开**另一个**账户会先带着上一个
 * 账户选过的月份与错误文案（错误文案尤其糟：一个已经取成功的账户顶上挂着"没读到"）。
 * 回到哪一段？——⭐ **回到它原来那一段**（`state.lgSeg` 不动）：从「资产」点进来的
 */
export function lgBack() {
  state.lgAcct = 0;
  state.lgChg = [];
  state.lgChgCursor = null;
  state.lgChgDone = false;
  state.lgChgLoad = 'idle';
  state.lgChgErr = '';
  state.lgChgMonth = '';
  renderLedger();
}

/**
 * 功能：**按手机的系统返回键时退一层** —— 这一屏有没有自己的二级屏，有就退掉一个。
 *
 * 这一屏的二级屏（账户详情 / 月详情页 / 设置子页）以前**不参与历史** ⇒ 按返回会
 * **直接离开记账**（退到上一个标签），而不是退回记账首页。宿主在 `popstate` 里问这里一句，
 * 由本函数按"由深到浅"依次退一层。
 */
export function lgBackLayer() {
  if (state.lgSetPage) {
    lgSetBack();
    return true;
  }
  if (state.lgMdMonth) {
    lgMdBack();
    return true;
  }
  if (state.lgAcct) {
    lgBack();
    return true;
  }
  return false;
}

/**
 * 功能：切账户详情那颗「变动类型」下拉（`all` / `entry` / `transfer` / `adjust`）。
 *
 * 说明：⭐⭐ 换类型**必须重新取数**：那一份是按 `type` 在服务端筛的，手上这一页只有 30 条
 * ⇒ 从手上这份里筛出来永远只有一小截，而界面**不报任何错**。
 * 它是**原生 `<select>` 的 `change`**（不是 `data-act` 的动作）—— 那颗下拉由
 */
async function pickChgType(value) {
  const k = String(value || '');
  if (!CHG_TYPES.some((t) => t.key === k) || state.lgType === k) return;
  state.lgType = k;
  await loadChanges(true);
}

/** 功能：「明细没读到」那颗重试（从第一页重取）。 @returns {Promise.<void>} */
export async function lgChgAgain() {
  await loadChanges(true);
}

/** 功能：详情屏底下那颗「加载更多」（游标往后取一页）。 @returns {Promise.<void>} */
export async function lgChgMore() {
  await loadChanges(false);
}

/**
 * 功能：点眼睛 ⇒ 把所有金额糊成圆点 / 还原，并把这次的选择**记进账号偏好**（两端同步）。
 *
 * （「隐藏要具有记忆功能：也就是我隐藏了，下次进入还是隐藏状态。
 * 并且手机端和电脑端同步」）：从前它只改内存（`state.lgHide`），刷新就回来 —— 于是
 * 「我明明藏起来了，下次进来又全露着」。现在落成 `users.hide_ledger_amount`
 */
export function lgEye() {
  state.lgHide = !state.lgHide;
  if (state.me) state.me.hide_ledger_amount = state.lgHide ? 1 : 0;
  api('PUT', '/api/auth/prefs', { hideLedgerAmount: !!state.lgHide }).catch(() => {});
  renderLedger();
}

/**
 * 功能：开「转账」弹层（从详情屏进，转出账户就是当前这个账户）。
 *
 * 说明：⚠️ 金额**不自己画数字键盘**（`inputmode="decimal"` 交给手机 OS —— 参考图 2 下半屏
 * 那个键盘是系统的，不是我们画的）。
 * 一个别的账户都没有时**不去开一个空下拉**：直接把话说明白（点了没反应是最差的形态）。
 */
export function lgTransfer() {
  const a = accountOf(state.lgAcct);
  if (!a) return;
  const others = ((state.lg && state.lg.accounts) || []).filter((x) => Number(x.id) !== Number(a.id));
  if (!others.length) {
    toast('还没有别的账户可以转 —— 先加一个', true);
    return;
  }
  const opts = others.map((x) => `<option value="${Number(x.id)}">${esc(labelOf(x))}</option>`).join('');
  openSheet(
    '转账',
    `<div class="lg-xfrom"><span>转出账户</span><b>${esc(labelOf(a))}</b>
       <i>余额 ${esc(fmtSide(a.opening_fen, sideMapOf(state.lg).get(a.kind), state.lgHide))}</i></div>
     <label class="fld"><span>转入账户</span><select id="lg-f-to">${opts}</select></label>
     <label class="fld"><span>转账金额</span><input id="lg-f-xamt" type="text" inputmode="decimal" /></label>
     <label class="fld"><span>备注（可以空着）</span><input id="lg-f-xnote" type="text" maxlength="${NOTE_MAX}" /></label>
     <div class="m-tip">转账只是把钱从一个账户挪到另一个账户，不是收入也不是支出 ——
       净资产一分都不会变。余额不够的话，先在详情页「调整余额」。</div>`,
    `<button class="btn primary" type="button" data-act="lg-xsave" style="flex:1.4">确认转账</button>`,
  );
  const el = $('#lg-f-xamt');
  if (el) el.focus();
}

/**
 * 功能：把转账提交上去 —— ⛔ **金额的校验交给服务端**（唯一一份判据）。
 *
 * 说明：⚠️ 本地只拦「没选转入账户」「金额空着」这两条**表单语义**检查；金额串原样发上去，
 * 服务端判不过就 400，那句文案原样弹给用户（「余额不够」「这张卡欠的没这么多」都在那边）。
 * 成功后**两次重取**：`loadLedger()`（余额 / 净值 / 分组全变了）＋ `openLedgerAccount()`
 */
export async function lgTransferSave() {
  const a = accountOf(state.lgAcct);
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
    closeSheet();
    toast('转好了');
    await loadLedger();
    await openLedgerAccount(a.id);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：开「调整余额」弹层（照参考图 1 卡上那颗按钮）。
 *
 * 说明：⚠️ 走的是**既有的逐键改**接口（`PUT /api/ledger/accounts/:id` 只带 `opening`）——
 * 不为它单开一个接口（那会造出第二份「金额怎么解析」的路径）。
 * @returns {void}
 */
export function lgBalance() {
  const a = accountOf(state.lgAcct);
  if (!a) return;
  openSheet(
    '调整余额',
    `<label class="fld"><span>余额</span>
       <input id="lg-f-bal" type="text" inputmode="decimal" value="${esc(fenToInput(a.opening_fen))}" /></label>
     <div class="m-tip">「调整余额」之前的记账将不会导致余额变化</div>`,
    `<button class="btn primary" type="button" data-act="lg-bsave" style="flex:1.4">保存</button>`,
  );
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
export async function lgBalanceSave() {
  const a = accountOf(state.lgAcct);
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
    closeSheet();
    toast('改好了');
    // 余额变了 ⇒ `overview` 与**明细**都要重取（调整余额本身也是三类变动里的一条）。
    await loadLedger();
    await loadChanges(true);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 拖动排序（手机端：长按进入拖动） ----------

/** 长按多久算「要拖东西」（毫秒）—— 太短会和滚动抢，太长用户以为没反应 */
const PRESS_MS = 380;

/**
 * 手指一动超过这么多像素就当成「想滚动」，放弃长按（⛔ 别和滚动抢）。
 *
 */
const PRESS_SLOP = 12;

/**
 * 长按中的那一次按下（`null` = 没在按）。
 * @type {?{el: HTMLElement, x: number, y: number, timer: number}}
 */
let press = null;

/**
 * 正在拖动的那一个（`null` = 没在拖）。
 * @type {?{el: HTMLElement, kind: string, siblings: Array.<HTMLElement>, over: ?HTMLElement}}
 */
let move = null;

/**
 * 刚拖完到这一刻之间到达的点击要**吞掉**。
 *
 */
let swallowUntil = 0;

/**
 * 「排序模式」开着没有（`true` = 用户刚长按过某个可拖元素、正等着拖）。
 *
 */
let sortMode = false;

/** 功能：排序模式下挂在可拖元素里的**拖拽柄**（⚠️ 它带**静态** `touch-action: none`，见 app.css）。 @returns {string} */
function sortHandleHtml() {
  return sortMode ? '<i class="lg-handle" data-handle="1" aria-hidden="true"></i>' : '';
}

/** 功能：资产那一格顶上的**排序条**（只在排序模式里画）—— 说清怎么拖 ＋ 一颗「完成」。 @returns {string} */
function sortBarHtml() {
  if (!sortMode) return '';
  return `<div class="lg-sortbar"><span>按住右侧把手上下拖动，排好后点「完成」。</span>
    <button type="button" data-act="lg-sortdone">完成</button></div>`;
}

/**
 * 功能：一次拖动里「可以互换位置」的那些兄弟元素 —— 三类各成一组，⛔ 不能混着数。
 *
 * 说明：⚠️ 账户**只在同一个 `.lg-group` 内**换位：跨组换位等于改它的用途，那是另一件事
 * 与桌面端那份（`desktop.js` 的 `dragSiblings()`）**逐字同语义**。
 *
 */
function pressSiblings(el) {
  const kind = String((el.dataset && el.dataset.drag) || '');
  if (kind === 'chip') return [...el.parentElement.querySelectorAll('[data-drag="chip"]')];
  if (kind === 'group') {
    const list = el.closest('.lg-list') || el.parentElement;
    return [...list.querySelectorAll('[data-drag="group"]')];
  }
  const box = el.closest('.lg-group');
  return box ? [...box.querySelectorAll('[data-drag="acct"]')] : [];
}

/** 功能：取消这次长按（手指动了 / 抬起来了）。 @returns {void} */
function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

/**
 * 功能：手指按在某个可拖元素上 —— 开始计时，长按到点就进拖动。
 * @param {PointerEvent} e - 按下事件
 * @param {HTMLElement} el - 被按住的元素
 * @returns {void}
 */
function startPress(e, el) {
  cancelPress();
  press = { el, x: e.clientX, y: e.clientY, timer: 0 };
  press.timer = setTimeout(() => {
    press = null;
    enterDrag(el);
  }, PRESS_MS);
}

/**
 * 功能：长按到点 ⇒ **进排序模式**（⛔ 不在这里抓东西，只把「拖拽柄」画出来）。
 *
 * 说明：⭐⭐ 见 `sortMode` 那段说明：`touch-action` 只在手势开始那一刻生效 ⇒ 必须在**手势
 * 之前**就把柄画在屏幕上，用户按住柄开始的那一趟才不会被浏览器判成滚动。
 * 这里的"进模式"**永远不是"什么都不发生"**：屏幕上立刻多出排序条与一排柄
 */
function enterDrag() {
  cancelPress();
  sortMode = true;
  swallowUntil = Date.now() + 600;
  renderLedger();
}

/**
 * 功能：真的抓起一个元素开始拖 —— 加样式与监听，⛔ 先不动任何数据。
 * @param {HTMLElement} el - 被拖的元素
 * @returns {void}
 */
function startDrag(el) {
  cancelPress();
  const kind = String((el.dataset && el.dataset.drag) || '');
  const siblings = pressSiblings(el);
  // 兄弟只有它自己时也**照样进拖动状态**（抓起来、但没有落点、松手回原位）。
  // 从前这里是 `return` —— 表现是「长按毫无反应」，用户只能判定**功能坏了**
  // （报的就是这个：他那份数据里同组往往只有一个账户）。
  move = { el, kind, siblings, over: null };
  el.classList.add('lg-dragging');
  document.body.classList.add('lg-sorting');
  // `passive: false` 是必需的：拖动时要 `preventDefault()` 把页面滚动按住
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
}

/** 功能：排序条那颗「完成」⇒ 退出排序模式并重画。 @returns {void} @since */
export function lgSortDone() {
  sortMode = false;
  renderLedger();
}

/**
 * 功能：手指移动 ⇒ 换落点提示（⚠️ 只改提示，**真的换位在松手时一次做完**）。
 * @param {PointerEvent} e - 移动事件
 * @returns {void}
 */
function onDragMove(e) {
  if (!move) return;
  e.preventDefault();
  // 判定轴跟着类型走：账户 / 组头是**竖排**（比 y），胶囊是**横排**（比 x）。
  // 从前一律比 y ⇒ 拖胶囊时那一排的 y 全在范围内，落点永远落在**第一个**胶囊上
  // （表现是「拖了没反应 / 位置乱跳」，而且不报错）。
  const horiz = move.kind === 'chip';
  const pos = horiz ? e.clientX : e.clientY;
  let over = null;
  for (const el of move.siblings) {
    if (el === move.el) continue;
    const r = el.getBoundingClientRect();
    const lo = horiz ? r.left : r.top;
    const hi = horiz ? r.right : r.bottom;
    if (pos >= lo && pos <= hi) {
      over = el;
      break;
    }
  }
  if (over !== move.over) {
    if (move.over) move.over.classList.remove('lg-drop');
    move.over = over;
    if (over) over.classList.add('lg-drop');
  }
}

/**
 * 功能：松手 —— 收尾、必要时提交顺序。
 * @returns {Promise.<void>}
 */
async function endDrag() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', endDrag);
  document.removeEventListener('pointercancel', endDrag);
  document.body.classList.remove('lg-sorting');
  const d = move;
  move = null;
  if (!d) return;
  d.el.classList.remove('lg-dragging');
  if (d.over) d.over.classList.remove('lg-drop');
  if (!d.over || d.over === d.el) return;
  const from = d.siblings.indexOf(d.el);
  const to = d.siblings.indexOf(d.over);
  if (from < 0 || to < 0 || from === to) return;
  // 紧接着到达的那一次 click 要吞掉（见 `swallowUntil` 的说明）
  swallowUntil = Date.now() + 500;
  await commitOrder(d.kind, d.siblings, from, to);
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
  await loadLedger();
}

/**
 * 功能：绑这一块的事件（change ＋ 长按拖动）—— ⚠️ **每颗节点只挂一次**。
 *
 * 「只挂一次」的判据是**节点身份**（`ledgerViewNode`）—— 换了一颗就重挂，同一颗重入不重挂。
 * 挂重了的表现是「一次点击跑两遍」（切视图切两次、保存两次）——
 * 而它**不报错**，只是偶尔看着像"卡了一下"。
 */
export function bindLedgerOnce() {
  const box = $('#view-ledger');
  // 日期 / 时间控件：点任意处都开系统选择器（只挂一次，见 `core/native-picker.js`）
  bindNativePickerOnce();
  if (!box || box === ledgerViewNode) return;
  ledgerViewNode = box;
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return undefined;
    // 账户详情那颗月份下拉 —— 换月**要重新取数**（那个月的变动根本不在手上），
    // 不是"从手上这份里筛"（手上只有当前这一页 30 条，筛出来永远只有一小截）。
    if (t.id === 'lg-c-month') {
      state.lgChgMonth = String(t.value || '');
      loadChanges(true);
    }
    // 与月份那颗同一条口径：换类型**要重新取数**（见 `pickChgType()` 的说明）。
    if (t.id === 'lg-c-type') {
      pickChgType(t.value);
    }
    // 账单屏「月账单」那颗年份下拉 —— 换年 = 换一期（`period_key` 变）⇒ 重新取数。
    // 流水那一颗 `#lg-e-month` 的 change 分支**已删**：明细屏的选月是**底部弹层**
    // （T45），它走 `lg-month-ok` 那条动作，⛔ 不再是原生 `<select>` 的 change
    if (t.id === 'lg-bill-year') {
      state.lgBillKey = `${Number(t.value) || 0}-01-01`;
      loadBill(true);
    }
    // 「用户主动动作」，允许转圈；⚠️ 与「切口径只重画」是两件事，⛔ 别混。
    if (t.id === 'lg-f-year') {
      state.lgYear = Number(t.value) || 0;
      loadLedger();
    }
    // 设置子页【收支账户】**全部当场生效**（这一页没有「保存」那颗按钮了）——
    // 全局两层认 `id`，每类别那一层认行上的 `data-defacct`。
    // 这两条就是「读回那一头」：改了上面 `setAcctHtml()` 里那几个钩子，
    handleLedgerSetChange(t);
    return undefined;
  });
  // ：在「资产」这一格上**左右滑** ⇒
  // 切「台账 / 图表」两个视图（原来那排占满宽的「资产｜图表」药丸撤了，见 `tabDotsHtml()`）。
  // 三条判据，缺一条都会误切：
  let swX = 0;
  let swY = 0;
  box.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      swX = t.clientX;
      swY = t.clientY;
    },
    { passive: true },
  );
  box.addEventListener(
    'touchend',
    (e) => {
      // 这一对监听现在管**两处**左右滑动 ——
      // 「资产 / 图表」（资产格）与「列表 / 图表」（账单格），判据是**当前在哪一格**。
      // 账单还挂着一个月详情**二级屏**（`state.lgMdMonth`）⇒ 在它里面不切
      const seg = segOf();
      if (seg === 'asset') {
        if (sortMode) return;
      } else if (seg === 'bill') {
        if (state.lgMdMonth) return;
      } else {
        return;
      }
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - swX;
      const dy = t.clientY - swY;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      // 左滑（dx<0）⇒ 看后一页；右滑 ⇒ 回前一页
      if (seg === 'bill') {
        pickBillTab2(dx < 0 ? 'chart' : 'list');
        return;
      }
      const next = dx < 0 ? 'chart' : 'asset';
      if (next === tabOf()) return;
      state.lgTab = next;
      renderLedger();
    },
    { passive: true },
  );
  // ：**滚到底自动取下一 30 条** —— 它与底下那颗「加载更多」是**同一条路的两个入口**。
  // 不是 `window`：挂在 window 上永远不触发，表现是"滚到底什么也不发生"，且**不报任何错**。
  // 这一屏改成两段式之后，`#view-assets` 那层 `.view` 已经 `overflow: hidden`
  const scroller = (box.closest && box.closest('.view')) || box;
  if (scroller !== ledgerScrollNode) {
    ledgerScrollNode = scroller;
    scroller.addEventListener('scroll', maybeLoadMore, { passive: true, capture: true });
  }
  // ---- 长按拖动 ----
  box.addEventListener('pointerdown', (e) => {
    if (move) return;
    // 排序模式里**只认那颗拖拽柄** —— 它带静态 `touch-action: none`（见 app.css），
    // 浏览器因此不会把手势判成滚动、也不会派发 `pointercancel` ⇒ 拖动才真的跟手。
    // 按在**行体**上时**什么都不做**（让位给滚动）：排序模式里行长按没有意义，
    const h = e.target.closest ? e.target.closest('[data-handle]') : null;
    if (h && sortMode) {
      const row = h.closest('[data-drag]');
      if (!row) return;
      // 指针捕获：手指滑出柄的范围后事件照样回它这儿（不捕获时中途会断）
      if (h.setPointerCapture) {
        try {
          h.setPointerCapture(e.pointerId);
        } catch (_e) {
          /* 个别环境不支持 pointerId 捕获：不影响（document 那层监听还在） */
        }
      }
      startDrag(row);
      return;
    }
    if (sortMode) return;
    const n = e.target.closest('[data-drag]');
    if (n) startPress(e, n);
  });
  box.addEventListener('pointermove', (e) => {
    // 手没抬起来就移动了 ⇒ 用户想滚动，立刻放弃长按（放过这次手势）
    if (press && (Math.abs(e.clientX - press.x) > PRESS_SLOP || Math.abs(e.clientY - press.y) > PRESS_SLOP)) {
      cancelPress();
    }
  });
  box.addEventListener('pointerup', cancelPress);
  box.addEventListener('pointercancel', cancelPress);
  // 捕获阶段拦「刚拖完那一下点击」：宿主的委托挂在 `#app` 上走**冒泡**，
  // 所以在这里（内层）`stopPropagation()` 正好能拦住它
  box.addEventListener(
    'click',
    (e) => {
      // 排序模式里**整屏的点击都不放行**（只放过排序条上那颗「完成」）：正在排版的时候
      // 顺手点开某个账户详情，是用户最不想要的那一下 —— 与「吞掉松手那一次 click」同一条道理。
      const inBar = e.target && e.target.closest ? e.target.closest('.lg-sortbar') : null;
      if (sortMode && !inBar) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (Date.now() < swallowUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

/**
 * 「明细」那一屏 / 「预算」那一屏 / 「资产」那一屏（1 期原样）/ 「设置」那一屏
 *
 */
export function renderLedger() {
  // 设置页那一栏（`settings-pane` 片段）如果开着，**顺手也重画一次** ——
  // 「记账设置」那几块的写操作最后都走这里（改默认账户 / 建改归档分类 / 导入 / 导出…），
  // 而它们改的是**同一份 state** ⇒ 两处必须一起刷；只刷一处就是"改了但界面上没变"（不报错）。
  repaintSetPane();
  const box = $('#view-ledger');
  if (!box) return;
  const d = state.lg;
  if (!d) return;
  bindLedgerOnce();
  const sides = sideMapOf(d);
  // 屏级那颗悬浮「＋」**默认收起** —— 下面哪一格要它，谁自己打开
  // （全部二级屏都不画它，判据与从前逐字一致，见 `paintAssetsFab()`）。
  // 「资产」那一格要它了（`'account'` 档 ＝ 添加账户，见下面 ⑤）。
  paintAssetsFab('off');

  // ---- ① 账户详情二级屏 ----
  const acct = accountOf(state.lgAcct);
  if (Number(state.lgAcct) && !acct) {
    state.lgAcct = 0;
    state.lgChg = [];
    state.lgChgLoad = 'idle';
    state.lgChgErr = '';
  }
  if (Number(state.lgAcct) && acct) {
    box.innerHTML = detailHtml(acct, sides);
    paintChrome();
    return;
  }

  // ---- ② 「设置」那一屏（⭐ 同级格之一，C-11 / C-34；与资产 / 预算完全并列）----
  // 它里面**分了二级**（「设置增加二级菜单，现在要滑动到底很不方便」）——
  // `state.lgSetPage` 空串 = 设置**首页**（四条目那张列表，画底部导航 ＋ FAB）；
  if (segOf() === 'set') {
    const page = setPageOf(state.lgSetPage);
    if (page) {
      const meta = SET_PAGES.find((p) => p.key === page);
      // 顶上那条「‹ 返回」头与正文**同住一个容器**（照账单屏 `.lg-bill` 那个结构）——
      // 容器负责子屏那一层内边距（`.lg-setp`），⛔ 三个子页函数自己不带容器。
      box.innerHTML = `<div class="lg-setp">${subHeadHtml(
        'lg-setback',
        (meta && meta.name) || '设置',
      )}${setPageBodyHtml(page)}</div>`;
      paintChrome();
      return;
    }
    box.innerHTML = `${setHomeHtml()}${segNavHtml()}`;
    paintAssetsFab();
    paintChrome();
    return;
  }

  // ---- ③ ⭐「明细」那一格（⭐ 默认格，T32：进记账即明细）----
  if (segOf() === 'detail') {
    box.innerHTML = `${detailScreenHtml()}${segNavHtml()}`;
    // 开着搜索就要**重接**那个输入框（它随这一屏现造，监听器不跟着走）
    if (searchOn) bindSearchInput();
    paintAssetsFab();
    paintChrome();
    return;
  }

  // 它**从「明细的子屏」升成一级格**（原来是从明细里那颗「账单」按钮进去的新屏）⇒
  // 现在有自己的格子、⛔ **不再自带「‹ 返回」头**（一级格没有"上一层"可回）。
  // 它下面那一层**月详情页**仍是二级屏（⭐ 只有「月」档有，T41）：自带「‹ 返回」头、
  if (segOf() === 'bill') {
    if (state.lgMdMonth) {
      box.innerHTML = monthDetailScreenHtml();
      paintChrome();
      return;
    }
    box.innerHTML = `${billScreenHtml()}${segNavHtml()}`;
    paintAssetsFab();
    paintChrome();
    return;
  }

  if (segOf() === 'budget') {
    box.innerHTML = `${budgetScreenHtml()}${segNavHtml()}`;
    // 这一格那颗「＋」＝ **添加分类预算**（通栏那条 `.lg-badd` 已撤，见 `paintAssetsFab()`）
    paintAssetsFab('budget');
    paintChrome();
    return;
  }

  // ---- ⑤ 「资产」那一屏（1 期原样 ＋ 底部那条记账导航）----
  // ：
  // 这一格原来自己有一条通栏「＋ 添加账户」（`.lg-add`），与屏级那颗悬浮「＋」是同一件事
  const t = d.totals || { asset_fen: 0, debt_fen: 0, net_fen: 0 };
  const accounts = Array.isArray(d.accounts) ? d.accounts : [];
  const groups = Array.isArray(d.groups) ? d.groups : [];
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

  const body = accounts.length
    ? kindView
      ? groups.map((g) => groupHtml(g, accounts, sides)).join('')
      : tagGroupsHtml(cur, accounts, sides)
    : `<div class="empty slim"><div class="e-ico">💰</div><h3>还没记过账户</h3>
       <p>先记一个最常见的：现金 / 储蓄卡。</p></div>`;

  // 它仍然是「资产」这一屏内部的事，⛔ **不是底部导航上的一项**。
  // 它是资产这一格的**第二个视图**（`tabOf()` 判的），同一条口径：**不画 FAB**。
  // 切换**改成左右滑动**（那一排占满宽的「资产｜图表」药丸撤了）⇒
  if (tabOf() === 'chart') {
    box.innerHTML = `${tabDotsHtml()}${chartHtml(d, sides)}${segNavHtml()}`;
    // 图表也是「资产」这一格的一部分 ⇒ 那颗「＋」同样是「添加账户」
    paintAssetsFab('account');
    paintChrome();
    return;
  }

  box.innerHTML = `${tabDotsHtml()}${sortBarHtml()}${heroHtml(t)}${viewBarHtml(views, cur)}<div class="lg-list">${body}</div>${segNavHtml()}`;
  // 「资产」这一格的主操作 ＝ 屏级那颗悬浮「＋」（通栏那条已撤）
  paintAssetsFab('account');
  // **进出详情屏都要请宿主重画一次顶栏**（`paintChrome()` 幂等、只写 class）。
  // 不调的下场是「顶栏还留着 `ZX ｜ 记账 ｜ N 个账户`，屏内又画了一条『‹ 资产详情』」
  // —— 两个标题摞着；返回时同理（`.topbar-bare` 摘不掉，顶栏一直收着）。
  paintChrome();
}

// ============================================================================
// 记账 2 期：「记账」那一屏 ＋ 记账自己的底部导航
// ============================================================================

/**
 * 功能：当前那一格（`'detail'` 明细 / `'budget'` 预算 / `'asset'` 资产 / `'set'` 设置）。
 *
 * 说明：⚠️ 认不出一律回落 `'detail'` —— ⭐ **它就是默认格**（打开即明细），
 * 别回落到 `'asset'` / `'set'`（那会把这个默认改掉，而且不报错）。
 * 起这一段从**三格升成五格**（「从左到右要有：
 */
function segOf() {
  const k = state.lgSeg;
  return SEG_KEYS.includes(k) ? k : 'detail';
}

/**
 * 功能：切「明细 / 预算 / 资产 / 设置」那四格（记账自己的底部导航）。
 *
 * 说明：⭐⭐ **只换格、不重新取数**（选中态住 `state.lgSeg`）—— 资产那一侧是
 * `overview` 一次给全；记账那一侧进来时 `mountLedger()` 已经取过流水。
 * 例外一：切到「明细」而流水**从没取过**（`lgLoad === 'idle'`）⇒ 这时去取一次，
 */
export function lgSegPick(_act, n) {
  const k = String((n && n.dataset && n.dataset.seg) || '');
  if (!SEG_KEYS.includes(k)) return undefined;
  if (segOf() === k) return undefined;
  // 账单升成**一级格**了 ⇒ 这里不再有 `lgBillOpen` 要清；
  // 但「月详情页」还挂在「账单」那一格之下 ⇒ 换格时必须清掉它
  // （不清的话：从月详情点底栏「预算」，再切回「账单」，画出来的还是月详情 —— ⛔ 而且不报错）。
  state.lgMdMonth = 0;
  // 换格也退出**排序模式**（它挂在「资产」那一格上，换走就不该再留着）
  sortMode = false;
  // 换格也把「明细」那一格的**搜索态**收掉 —— 不收的话从别格切回来，
  // 落到的还是开着搜索框的那一版（⛔ 而且不报错）。
  searchOn = false;
  // 换格也把「设置子页」清掉（它挂在「设置」那一格之下）——
  // 不清的话，从设置子页切走再切回来，落到的还是那个子页（⛔ 而且不报错）。
  state.lgSetPage = '';
  if (k === 'set' && (!state.lgCats.length || !state.lgDefaults)) {
    return Promise.all([ensureCats(false), ensureDefaults(false)]).then(([okC, okD]) => {
      if (!okC || !okD) {
        toast('记账设置没读到，稍后再试', true);
        return undefined;
      }
      state.lgSeg = k;
      renderLedger();
      // 切进「设置」那一格也取一次三方导入概况（与 `mountLedger()` 同一条路）
      loadImportSummary();
      return undefined;
    });
  }
  state.lgSeg = k;
  if (k === 'budget') {
    return openBudget();
  }
  // 「账单」那一格要把它自己的数据取回来（它原来是从明细那颗按钮进去时才取）——
  // 与预算那条同款：**取数是这一格自己的事**，换格那一下顺手发（⛔ 别指望别人替它取）。
  if (k === 'bill') {
    return openBill();
  }
  // 只有「明细」那一格需要流水（流水归明细）—— 切到它而流水**从没取过**
  if (k === 'detail' && state.lgLoad === 'idle') return loadEntries(true);
  renderLedger();
  // 切进「设置」那一格 ⇒ 取一次三方导入概况（见 `mountLedger()` 里那条说明）
  if (k === 'set') loadImportSummary();
  return undefined;
}

/** 明细那一格的图标（一份清单 —— 三行流水；线性 SVG，颜色由 CSS 的 `currentColor` 给 —— ⛔ 不自带配色） */
const NAV_ICO_DETAIL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.6h16"/><path d="M4 12h16"/>' +
  '<path d="M4 17.4h16"/></svg>';

/**
 * 账单那一格的图标（一张**带表头的表格**）—— ⭐ 与「明细」那三行流水**刻意不同形**：
 * 明细是"一条条流水"、账单是"汇总成表"（两个图标长得像，就等于没有图标）。
 */
const NAV_ICO_BILL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.6" y="5.4" width="14.8" height="13.2" rx="2.2"/>' +
  '<path d="M4.6 10.2h14.8"/></svg>';

/** 预算那一格的图标（一个环形进度 —— 与预算屏里那个环同源，⛔ 不是第二套图形语言） */
const NAV_ICO_BUDGET =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4"/>' +
  '<path d="M12 3.6A8.4 8.4 0 0 1 20.4 12H12z"/></svg>';

/** 资产那一段的图标（线性 SVG，颜色由 CSS 的 `currentColor` 给 —— ⛔ 不自带配色） */
const NAV_ICO_ASSET =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.6h13.4a2.6 2.6 0 0 1 2.6 2.6v6.4H6.6A2.6 2.6 0 0 1 4 15z"/>' +
  '<path d="M4 8.6V7.4A2.4 2.4 0 0 1 6.4 5h8.2M15.6 13.2h2.2"/></svg>';

/** 设置那一段的图标（齿轮 —— 与电脑端那颗「[齿轮] 设置」**逐字同一个形状**）。
 *
 * 说明：⭐ 把电脑端那颗 `⋯` 换成「[图标] 设置」，理由是那个 `⋯` 与资产列表屏的
 */
const NAV_ICO_SET =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3.1"/>' +
  '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 ' +
  '1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1' +
  '-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 ' +
  '1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 ' +
  '4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 ' +
  '9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>';

/**
 * 功能：四格各自的图标（`key` → SVG 字符串）。
 *
 * 说明：⚠️⚠️ **它必须声明在全部 `NAV_ICO_*` 之后** —— 这些是 `const`（暂时性死区）：
 * 声明顺序反了，模块求值到这里就会 `ReferenceError`，整屏空白而 lint / 单测**全看不出来**
 * （`11-踩坑与说明.md` 记过这条）。
 */
const NAV_ICONS = {
  detail: NAV_ICO_DETAIL,
  bill: NAV_ICO_BILL,
  budget: NAV_ICO_BUDGET,
  asset: NAV_ICO_ASSET,
  set: NAV_ICO_SET,
};

/**
 * 功能：画**记账自己的底部导航**（`明细 ｜ 预算 ｜ 资产 ｜ 设置`，四格，⛔ 没有「图表」）。
 *
 * 说明：⭐⭐  第 2 / 3 条 ＋，换成本端这条
 * **同样式**的导航。⚠️ 它**只在这几格之间切**，⛔ 不是第二层应用导航；
 * 回主导航不走这里（走手机端自己的返回，历史栈逐屏退回， 第 4 条）。
 */
function segNavHtml() {
  const cur = segOf();
  const btn = (k, name, ico) =>
    `<button type="button" class="lg-nav-btn" data-act="lg-seg" data-seg="${k}" aria-selected="${
      cur === k
    }"${cur === k ? ' aria-current="page"' : ''}>${ico}<i>${name}</i></button>`;
  const tabs = SEGS.map((s) => btn(s.key, s.name, NAV_ICONS[s.key])).join('');
  return `<nav class="lg-nav" aria-label="记账内部导航">${tabs}</nav>`;
}

/* （「手机端的新建图标不是加号」）：这一格**不再改那颗钮的图形** ——
 * 与电脑端同款，就用屏级 `#assets-new` 自带的那个「＋」（`mobile/index.html` 里那个 SVG，
 * 数码管理的「＋ 新增」也是它、电脑端也是它）。
   ⛔ 别再往这里加一条 `innerHTML =` 去换图形 —— 两颗悬浮钮（记账 / 数码管理）本来就该长同一个样。 */

/**
 * 功能：把「记一笔」挂到**屏级**那颗悬浮「＋」（`#assets-new`）上；`on === false` 时把它收起来。
 *
 * 改为悬浮 ＋ 标志进入记账，参考手机端的今天的 ＋ 创建任务」）。
 * ：
 * 从前这里是 `lgFabHtml()` —— 本片段自己造一颗 `.lg-fab`、输出在**片段根**里 ⇒
 */
function paintAssetsFab(mode = 'entry') {
  const f = document.getElementById('assets-new');
  if (!f) return;
  if (mode === 'off') {
    f.classList.add('hidden');
    return;
  }
  // ：多了「添加账户」
  // 这一档 —— 「资产」那一格原来自己有一条通栏「＋ 添加账户」，两颗都是"加一个东西"、
  // 叠在一起分不清点哪个（`11` 记过）；现在那一格只剩这一颗，它就干这件事。
  const acct = mode === 'account';
  const bud = mode === 'budget';
  f.classList.remove('hidden');
  // 图形**不改**（用屏级那颗自带的「＋」，见上面那段说明）
  f.title = acct ? '添加账户' : bud ? '添加分类预算' : '记一笔';
  f.setAttribute('aria-label', f.title);
  f.dataset.act = acct ? 'lg-new' : bud ? 'lg-budget-add' : 'lg-eadd';
}

/**
 * 功能：流水列表那一块（⭐ 明細屏的主体）—— **三态分得开**：读取中 / 读不到（一句人话 ＋ 重试） / 这个月没有。
 *
 * 说明：⭐⭐ 「读取中」「这个月一笔都没有」「没读到」是**三件不同的事** —— 把失败画成空态
 * ＝把错误藏起来（用户会以为"我确实没记过账"）。「读不到」那颗重试**只重取流水**
 * （⛔ 不是整页刷新：那个不会重新取记账这一屏的数据）。
 */
function entryGroupsHtml() {
  if (state.lgLoad === 'error') {
    return `<div class="err-box"><b>流水没读到</b><p>${esc(state.lgErr || '原因不明')}</p>
      <button class="chip on" type="button" data-act="lg-eretry" style="margin-top:14px">重新加载</button></div>`;
  }
  if (state.lgLoad === 'loading' && !state.lgEntries.length) return '<div class="lg-txwait">正在读取…</div>';
  // 「这个月还没有」的判据是**两边都空**：只有自有流水那一边空、
  // 而导入行还有几条时，那不是"没有"，是"有这个月的账、只是它们是导进来的"。
  if (!state.lgEntries.length && !impRows.length) {
    return `<div class="empty slim"><div class="e-ico">🧾</div><h3>这个月还没有记过账</h3>
      <p>点底部「记账」那一格记一笔，这里就会按天列出来。</p></div>`;
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
      // 小计一律来自服务端（`dayTotals`）—— 按 `YYYY-MM-DD` 取，取不到就两个 0（见上面那段说明）。
      // 加进这个小计一次（那会把同一天的钱**算两遍**，而且它不报错）。
      const t = totals[g.date] || { income_fen: 0, expense_fen: 0, refund_fen: 0 };
      // 眼睛要盖住这里：小计走 `fmtFen`（掩码只住它一处）；隐藏态下**连符号都不给**
      // （只留圆点），免得从"进还是出"上把信息漏出去。
      // 掩码那个实参**必须逐字写 `state.lgHide`** —— `ttt/test/ledger.test.js`
      const inc = Number(t.income_fen) || 0;
      const exp = Number(t.expense_fen) || 0;
      // 修订（「移除所有的退款红色字体」）—— 与电脑端逐字同款：
      // 每天小计旁边**不再有**那一栏「退款」，只剩收入与支出两个数。
      // 两个小计中间那个**全角空格**（图 8）走 `join()` 的**字符串字面量**参数，⛔ 不直接嵌进
      const sum = [`收入: ${fmtFen(inc, state.lgHide)}`, `支出: ${fmtFen(exp, state.lgHide)}`].join('　');
      const head = `<div class="lg-eday"><b>${esc(g.date ? dayHeadLabel(g.date) : '时刻缺失')}</b><span>${esc(
        sum,
      )}</span></div>`;
      return (
        head + g.items.map((e) => entryRowHtml(e, names)).join('') + g.imported.map(impRowHtml).join('')
      );
    })
    .join('');
}

/**
 * 功能：画一条流水 —— **分类小图标** ＋ 分类名（没选就「未分类」）＋ 备注 / 账户名 ＋ 金额，
 * 退款行带「退款」字样。
 *
 * 说明：⚠️ 那颗小图标是**零出网**的「色块 ＋ 首字」（照记一笔的分类网格那套，
 * 本期不取图标文件）—— 色值走 `catColorOf()`（判据只住一处，⛔ 别在这里再 `%` 一遍）。
 */
function entryRowHtml(e, names) {
  const parts = [];
  if (e.note) parts.push(String(e.note));
  const an = names.get(Number(e.account_id));
  if (an) parts.push(an);
  // 修订：原交易那一行上的小字改成**带日期**的写法
  // 「9月30日已退款 127.50」（同电脑端 `desktop.js`）。
  // 它**不进 `parts`**（那一串会被整体 `esc()` 掉）—— 它要**红字**，所以单独画一个
  const rf = refundNoteOf(e, state.lgEntries, state.lgHide);
  // 退款条目**自己也在列表里**（单独占一行，C-24）⇒ 那一行标题带「退款」字样；
  // 补：**整行**都能点进详情（`data-act="lg-erow"`）。⚠️ 行里那颗「记退款」也是
  // `data-act` ⇒ 宿主的委托 `closest('[data-act]')` 从按钮往上找，**先命中按钮自己**，
  const act = isRefund(e)
    ? ''
    : `<button class="lg-erowact" type="button" data-act="lg-refund" data-id="${Number(e.id)}">记退款</button>`;
  // 分类小图标：色块 ＋ 首字（零出网，照）—— 名字走 `catName()`（「未分类」是它给的词），
  // 不在这里再判一次 `category_id` 有没有值（那是 `catName()` / `entryTitle()` 的事）。
  const cname = catName(e.category_id, state.lgCats);
  const ch = String(cname || '').trim().slice(0, 1) || '·';
  const ico = `<span class="lg-eico" style="--lg-c:${catColorOf(e.category_id)}">${esc(ch)}</span>`;
  return `<div class="lg-erow${isRefund(e) ? ' refund' : ''}" data-act="lg-erow" data-id="${Number(e.id)}">
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
  return '<button class="lg-more" type="button" data-act="lg-emore">加载更多</button>';
}

/** 功能：滚到底自动取下一 30 条的节流闸门（同一次滚动只发一次）。 @type {boolean} */
let moreBusy = false;

/**
 * 功能：这一屏**当前真正的滚动容器**。
 *
 * 改成**两段式**（固定头 ＋ 内部滚动区，见 `app.css` 的 `#view-assets` 那一段）——
 * 工具条与月份卡不再滚，真正滚的是流水列表 `.lg-elist`。
 * ⇒ 判据不能再看死那层 `.view`（它现在 `overflow: hidden`、压根不滚）。
 */
function scrollHost(box) {
  return (
    document.querySelector('#view-ledger .lg-elist') || (box.closest && box.closest('.view')) || box
  );
}

/**
 * 功能：滚到列表底部时自动「加载更多」（§7.3）；不满足条件时什么都不做。
 *
 * 说明：⚠️ 滚动容器**不是 `window`** —— ⛔ 挂在 `window` 上永远不触发。
 * 它同时是「底下的按钮」那条路的孪生入口：两条路都走 `loadEntries(false)`。
 * 明细那一格改成两段式之后，真正在滚的是 `.lg-elist` ⇒ 容器由
 */
function maybeLoadMore(ev) {
  if (moreBusy) return;
  // 判据从 `state.tab === 'ledger'` 换成 `state.assetsPane === 'ledger'`
  // —— 记账不再是一屏，它借「个人资产管理」那一屏的 `assets-pane` 槽住着
  // （`state.assetsPane` 由 `modules/assets/mobile.js` 在挂载 / 切格时写）。
  if (state.assetsPane !== 'ledger' || segOf() !== 'detail') return;
  // `segOf()` 排除了）—— 它是「账单」那一格之下的子屏（自带返回头），
  // 滚动到底不该去取下一页流水（那时用户根本看不见列表）。
  if (state.lgMdMonth) return;
  if (state.lgLoad !== 'done' || state.lgDone || !state.lgCursor) return;
  // 弹层开着时不触发（记一笔 / 详情 / 恢复内置分类都在弹层里）——
  // 与电脑端的 `modalOpen()` 同款护栏（滚动事件可能来自别的容器）。
  if ($('#sheet') && $('#sheet').classList.contains('on')) return;
  // 「节点在不在文档里」这一层兜底必须留着：切走这一格之后 `#view-ledger` 被摘掉，
  // 而挂在常驻 `.view` 上的那条 scroll 监听还在（它收得到别的格子的滚动）。
  const box = $('#view-ledger');
  if (!box) return;
  const view = scrollHost(box);
  if (!view) return;
  // 捕获监听会收到所有后代的滚动 —— 只认真正那个滚动容器自己发的那一条
  if (ev && ev.target && ev.target !== view) return;
  if (view.scrollTop + view.clientHeight < view.scrollHeight - 240) return;
  moreBusy = true;
  loadEntries(false).finally(() => {
    moreBusy = false;
  });
}

/** 功能：「流水没读到」那颗重试（从第一页重取）。 @returns {Promise.<void>} */
export async function lgEntryRetry() {
  await loadEntries(true);
}

/** 功能：底下那颗「加载更多」（游标往后取一页）。 @returns {Promise.<void>} */
export async function lgEntryMore() {
  await loadEntries(false);
}

// ============================================================================
// 补：**条目详情 ＋ 改一笔 ＋ 删一笔**
// 服务端那两条（`PUT` / `DELETE /api/ledger/entries/:id`）**早就写好了**，前端一次都没调过

/**
 * 功能：点流水**整行** ⇒ 开「这笔账」详情弹层。
 *
 * 说明：⭐ 详情是**一张上滑弹层**（不是第二个屏）：这一屏（记账）本身没有二级屏的位置，
 * 而详情要摆的就是"一行信息 ＋ 三颗动作"。
 * 分类名走 `entryTitle()`（退款条目自带「退款」字样）、账户名走**唯一的取名口**
 */
export function lgEntryOpen(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const e = entryOf(id);
  // 找不到（这一页刚被换过 / 别处删了）⇒ 什么都不做：⛔ 别开一张空弹层
  if (!e) return;
  openSheet(
    isRefund(e) ? '这笔退款' : '这笔账',
    entryDetailHtml(e),
    `<button class="btn" type="button" data-act="lg-eclose">关闭</button>`,
  );
}

/** 功能：从**手上这一页**流水里按 id 找一条（找不到回 `null`）。 @param {number} id - 流水 id @returns {?Object} @since */
function entryOf(id) {
  const rid = Number(id) || 0;
  if (!rid) return null;
  return (state.lgEntries || []).find((x) => Number(x.id) === rid) || null;
}

/**
 * 功能：画详情弹层的正文 —— 退款说明（仅退款条目）＋ 五格信息 ＋ 正文里的动作 ＋ 删除。
 *
 * 说明：⚠️ 三颗动作**画在正文里**：底部那颗主按钮（`openSheet` 的 foot）在这张弹层上
 * 没地方放（"点开进入详情操作"）。
 * 「删除」住在**滚动区末尾**（`.del-row`，与课表「删除这条课次」同一手法，
 */
function entryDetailHtml(e) {
  const rf = isRefund(e);
  // 退款条目要能看见"它退的是哪一笔"：原交易一般就在这一页（同一屏刚退完款）；
  // 不在这一页时（翻过页 / 原交易在别的月）**如实说"不在这一页"**，⛔ 不编一个标题。
  const origin = (state.lgEntries || []).find((x) => Number(x.id) === Number(e.refund_of));
  const line = rf
    ? `<div class="lg-edcap2">${
        origin ? `这是「${esc(entryTitle(origin, state.lgCats))}」的退款。` : '这是退款记录（原交易不在这一页）。'
      }</div>`
    : '';
  const row = (k, v) => `<div class="lg-drow"><span>${k}</span><b>${esc(v)}</b></div>`;
  const refundBtn = rf
    ? ''
    : `<button class="lg-dact" type="button" data-act="lg-refund" data-id="${Number(e.id)}">记退款</button>`;
  return `<div class="lg-ed">
    ${line}
    <div class="lg-det">
      ${row('分类', entryTitle(e, state.lgCats))}
      ${row('金额', fmtSignedFen(signedFen(e.ie, e.amount_fen), state.lgHide))}
      ${row('账户', acctNameMap().get(Number(e.account_id)) || '（账户名没读到）')}
      ${row('时间', String(e.at || ''))}
      ${row('备注', String(e.note || '') || '（没填）')}
    </div>
    <div class="lg-dacts">
      <button class="lg-dact" type="button" data-act="lg-eedit" data-id="${Number(e.id)}">编辑</button>
      ${refundBtn}
    </div>
    <button class="del-row" type="button" data-act="lg-edel" data-id="${Number(e.id)}">${
      rf ? '删除这笔退款' : '删除这笔账'
    }</button>
  </div>`;
}

/** 功能：关掉详情弹层（foot 那颗「关闭」）。 @returns {void} @since */
export function lgEntryClose() {
  closeSheet();
}

/**
 * 功能：从详情进「改一笔」—— ⭐ **复用「记一笔」那张弹层**，只把原条目灌进草稿。
 *
 * 说明：⭐⭐ 两条硬口径：
 * **秒取原条目的秒**（⛔ 不是"现在"的秒）：`datetime-local` 只到分钟，秒是提交时由前端
 * 补上的—— 新建时补"点开那一刻"的秒，**改的时候必须补回原来那个秒**，
 */
export async function lgEntryEdit(_act, n) {
  const e = entryOf(Number((n && n.dataset && n.dataset.id) || 0));
  if (!e) return;
  // 分类网格是这张弹层的主体 ⇒ 分类没读到就**不开**（与「记一笔」同一条纪律）
  const ok = await ensureCats();
  if (!ok || !state.lgCats.length) {
    toast('收支分类没读到，点「重新加载」再试一次', true);
    return;
  }
  await ensureDefaults();
  editId = Number(e.id);
  editRefund = isRefund(e);
  editOrig = {
    at: String(e.at || ''),
    ie: String(e.ie || ''),
    // 原金额按**输入框的样子**回填（`fenToInput`）：逐键比较要比同一口径的串，
    // 拿 '30.00' 与用户打的 '30' 比会永远"看着变了"（每次都发一遍没必要的 PUT）。
    amount: fenToInput(e.amount_fen),
    category_id: e.category_id == null ? null : Number(e.category_id),
    account_id: Number(e.account_id) || null,
    note: String(e.note || ''),
  };
  // 秒：取原条目 `at` 的第 17~18 位（`YYYY-MM-DD HH:MM:SS`）；形状不对就回落 '00'
  const sec = editOrig.at.slice(17, 19);
  edSec = /^\d{2}$/.test(sec) ? sec : '00';
  // 二级分类：条目挂的是二级时，网格要**直接开在第二屏**（那一屏才会把二级高亮起来）
  const cat = state.lgCats.find((c) => Number(c.id) === Number(editOrig.category_id));
  const second = cat && cat.parent_id != null ? Number(cat.parent_id) : 0;
  state.lgDraft = {
    ie: editOrig.ie === '收入' ? '收入' : '支出',
    amount: editOrig.amount,
    catId: editOrig.category_id,
    acctId: Number(editOrig.account_id) || 0,
    note: editOrig.note,
    // `datetime-local` 的值形状是 `YYYY-MM-DDTHH:MM`（秒由 `edSec` 补）
    dt: editOrig.at ? editOrig.at.slice(0, 16).replace(' ', 'T') : '',
    second,
    // 退款条目：弹层只画金额与备注两格（判据就是这一个字段，`entrySheetHtml()` 读它）
    refund: editRefund,
  };
  state.lgNotesCat = null;
  state.lgNotes = [];
  paintEntrySheet();
  loadNotes(state.lgDraft.catId);
}

/**
 *
 * 说明：⚠️ 确认手法照本文件现成那一套（`askConfirm()`，删账户 / 删分类 / 删成员同款），
 */
export function lgEntryDel(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const e = entryOf(id);
  if (!e) return;
  const rf = isRefund(e);
  const text = rf
    ? '这是退款记录，删掉它不会影响原交易。'
    : `删除后不能恢复。${Number(e.refund_fen) > 0 ? '它名下已记的退款会一起删掉。' : ''}`;
  askConfirm({ title: rf ? '删掉这笔退款？' : '删掉这笔账？', text, ok: '永久删除', danger: true }).then((ok) => {
    if (ok) entryDeleteGo(id);
  });
}

/**
 * 功能：真的删（确认之后走这里）—— 删完刷新流水 / 账户卡 / 当天快照。
 *
 * 说明：⭐ **钱变了** ⇒ 账户余额与当天快照都变了（服务端算的）⇒ `loadLedger()` 必须重取；
 * 流水也从第一页重取（删掉的那条要从最上面消失）。⛔ 本地不自己减一遍。
 * @param {number} id - 流水 id
 */
async function entryDeleteGo(id) {
  try {
    await api('DELETE', `/api/ledger/entries/${Number(id)}`);
    // 「记一笔」会带着一个已经不存在的 editId 去 PUT（那条路径 404，而且不报错）
    resetEdit();
    await loadLedger();
    await loadEntries(true);
    toast('删掉了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 功能：把「正在编辑」这一整套临时态清干净（取消 / 存完 / 删完都要清）。 @returns {void} @since */
function resetEdit() {
  editId = 0;
  editOrig = null;
  editRefund = false;
}

// ============================================================================
// ：「记一笔」上滑弹层 ＋「记退款」
// ============================================================================

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
    // P2 收口：「谁是二级」的判据只住 `entry-calc.js` 一处—— 本文件从前在这里
    // 自己写了一遍同样三个条件的 filter，两处迟早会漂。
    const kids = childCats(state.lgCats, d.second);
    const rows = kids.length
      ? kids.map(catBtnHtml).join('')
      : '<div class="lg-txwait">这个分类没有下一级 —— 直接点「‹ 返回」就行。</div>';
    return `<div class="lg-edgridwrap">
      <div class="lg-edcap"><button class="lg-back" type="button" data-act="lg-edback" aria-label="返回">‹</button>
        <b>${esc(catName(parent || null, state.lgCats))}</b>
        <i>选二级（可以不选）</i></div>
      <div class="lg-edgrid">${rows}</div>
    </div>`;
  }
  const cats = topCats(state.lgCats, d.ie);
  const un =
    `<button class="lg-cat lg-cat-un${d.catId == null ? ' on' : ''}" type="button" data-act="lg-edcat" data-cid="0">` +
    `<span class="lg-cat-ico">—</span><span class="lg-cat-name">${CAT_UNCLASSIFIED}</span></button>`;
  return `<div class="lg-edgridwrap"><div class="lg-edgrid">${un}${cats.map(catBtnHtml).join('')}</div></div>`;
}

/**
 * 功能：画一颗分类按钮（**零出网**：内置色块 ＋ 名字首字，照 1 期回落那套）。
 *
 * 说明：⚠️ 2 期**没有**分类图标文件（C-37 的图标集在才落地，`cats/` 目录现在不存在）
 * ⇒ 一律「色块 ＋ 首字」。⚠️ 有下一级的画一个 `›`，让"点进去还有一层"看得见。
 * @param {Object} c - 一个分类（`{id, name, parent_id}`）
 */
function catBtnHtml(c) {
  const d = state.lgDraft || {};
  const on = Number(d.catId) === Number(c.id);
  // 局部变量别叫 `hasKids`：那会**盖住**从 `entry-calc.js` 引进来的同名函数，
  const more = hasKids(state.lgCats, c.id);
  const color = catColorOf(c.id);
  const ch =
    String(c.name || '')
      .trim()
      .slice(0, 1) || '·';
  return (
    `<button class="lg-cat${on ? ' on' : ''}" type="button" data-act="lg-edcat" data-cid="${Number(c.id)}">` +
    `<span class="lg-cat-ico" style="--lg-c:${color}">${esc(ch)}</span>` +
    `<span class="lg-cat-name">${esc(c.name)}</span>` +
    `${more ? '<i class="lg-cat-more">›</i>' : ''}</button>`
  );
}

/**
 * 功能：画账户选择器里的选项 —— 第一项是**「不关联」**（＝空账户，T3-g /  第 14 条）。
 *
 * 说明：⚠️⭐ 这里**仍然**用**空值**表达"不关联"，由服务端按 `account_id: null` **落到空账户**上
 * （`routes.js` 的校验表：`null` ⇒ 落空账户）—— 判据在服务端，前端不猜一个 id。
 * 2 期补上取名口（`account-names`）之后，空账户的 id 确实查得到了，但这条路径**不改成**
 */
function acctOptionsHtml(sel) {
  const one = (v, t, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(t)}</option>`;
  const cur = Number(sel) || 0;
  const out = [one('', '不关联', !cur)];
  let hit = false;
  for (const a of (state.lg && state.lg.accounts) || []) {
    if (Number(a.id) === cur) hit = true;
    out.push(one(String(Number(a.id)), labelOf(a), Number(sel) === Number(a.id)));
  }
  // ：原账户**不在活账户清单里**时，照样给它画一项 ——
  // 两种账户会落到这里：① 空账户（＝「不关联」，它按 第 3 条**不进 `accounts[]`**）；
  // ② 已经删掉的账户（流水一条不少地留着，C-8）。不画的话浏览器会**回落到第一项「不关联」**，
  if (cur && !hit) out.push(one(String(cur), acctNameMap().get(cur) || '原账户', true));
  return out.join('');
}

/** 功能：取备注输入框里当前的片段（弹层还没画出来时是空串）。 @returns {string} @since */
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
    .map(
      (n) => `<button class="lg-notechip" type="button" data-act="lg-ednote" data-note="${esc(n)}">${esc(n)}</button>`,
    )
    .join('');
}

/** 功能：只重画备注候选那一条（⛔ 不重画整张弹层 —— 会把别的格里打的字与光标一起抹掉）。 @returns {void} @since */
function paintNoteChips() {
  const box = $('#lg-ed-notewrap');
  if (box) box.innerHTML = noteChipsHtml();
}

/**
 *
 * 说明：⚠️ 顶部是 `支出 ｜ 收入` 两段 ＋「取消」；正文是分类网格 ＋ 账户/金额 ＋ 备注/时间；
 */
function entrySheetHtml() {
  const d = state.lgDraft || {};
  if (d.refund) {
    return `<div class="lg-ed">
      <div class="lg-edtop">
        <div class="lg-edcap2">这是退款记录 —— 只能改金额和备注。</div>
        <button class="btn sm" type="button" data-act="lg-edcancel">取消</button>
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-amt">金额</label>
        <input id="lg-ed-amt" type="text" inputmode="decimal" value="${esc(d.amount)}" />
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-note">备注</label>
        <input id="lg-ed-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" />
      </div>
      <div id="lg-ed-notewrap">${noteChipsHtml()}</div>
    </div>`;
  }
  const seg = (key, name) =>
    `<button class="lg-seg-btn${d.ie === key ? ' on' : ''}" type="button" role="tab" aria-selected="${
      d.ie === key
    }" data-act="lg-edie" data-ie="${key}">${name}</button>`;
  return `<div class="lg-ed">
    <div class="lg-edtop">
      <div class="lg-seg" role="tablist">${seg('支出', '支出')}${seg('收入', '收入')}</div>
      <button class="btn sm" type="button" data-act="lg-edcancel">取消</button>
    </div>
    ${edGridHtml()}
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-acct">账户</label>
      <select id="lg-ed-acct">${acctOptionsHtml(d.acctId)}</select>
    </div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-amt">金额</label>
      <input id="lg-ed-amt" type="text" inputmode="decimal" value="${esc(d.amount)}" />
    </div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-note">备注</label>
      <input id="lg-ed-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" />
    </div>
    <div id="lg-ed-notewrap">${noteChipsHtml()}</div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-time">时间</label>
      <input id="lg-ed-time" type="datetime-local" step="60" value="${esc(d.dt)}" title="时间可以改；秒按点开那一刻记" />
    </div>
  </div>`;
}

/** 功能：把「记一笔 / 改一笔」弹层按草稿重画一遍（换收支 / 点分类 / 返回都要走它）。 @returns {void} @since */
function paintEntrySheet() {
  bindPickChange();
  openSheet(
    // 标题说清这一次是"新记"还是"改一条"（`editId` 是这两条路唯一的分叉）
    editId ? '改一笔' : '记一笔',
    entrySheetHtml(),
    `<button class="btn primary" type="button" data-act="lg-edsave" style="flex:1.4">完成</button>`,
    {
      draft: editId ? `ledger-edit:${editId}` : 'ledger-entry',
      resume: editId
        ? { kind: 'ledger-edit', payload: { id: Number(editId) } }
        : { kind: 'ledger-entry', payload: null },
    },
  );
}

/**
 * 功能：把「记一笔」弹层上填的值读回草稿。
 *
 * 说明：⚠️ 选择器**必须带 `#`**：写成裸 id 会被 `$()` 当成标签名 ⇒ 恒回 `null` ⇒
 * @returns {void}
 */
function entryCapture() {
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

/**
 * 功能：开「记一笔」—— 建一份草稿、按默认账户预填、画弹层，并去拉一次备注候选。
 *
 * 说明：⭐ 账户**按类别 → 全局（按收 / 支）→ 空账户**预填，取值顺序只住 `entry-calc.js` 的
 * `pickDefaultAccount()`—— ⛔ 这里不写第二份 if/else。
 * 时间预置"点开那一刻"：日期＝**服务端今天**，时:分＝本机时钟，
 */
export async function lgEntryAdd(prefill) {
  // AI 确认卡点「修改」时带预填进来 —— 仍是这一张弹层、这一条创建路径
  const p = prefill && typeof prefill === 'object' ? prefill : null;
  const ok = await ensureCats();
  if (!ok || !state.lgCats.length) {
    toast('收支分类没读到，点「重新加载」再试一次', true);
    return;
  }
  await ensureDefaults();
  const today = (state.lg && state.lg.today) || '';
  const { hm, ss } = nowPrefix();
  edSec = ss;
  // 这是**新建**那条路 ⇒ 把"正在编辑"那一套清干净（不清的话会带着上一条的 editId 发 PUT）
  resetEdit();
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
  paintEntrySheet();
  loadNotes(null);
}

/**
 * 功能：换「支出 / 收入」—— 重取默认账户，并清掉另一侧的类别。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-ie` 取方向）
 * @returns {void}
 */
export function lgEntryIe(_act, n) {
  const d = state.lgDraft;
  const ie = String((n && n.dataset && n.dataset.ie) || '');
  if (!d || (ie !== '支出' && ie !== '收入')) return;
  entryCapture();
  if (d.ie !== ie) {
    d.ie = ie;
    // 分类是按收 / 支分的 ⇒ 换一边就清掉（⛔ 别把一个支出分类挂到收入那一笔上）
    d.catId = null;
    d.second = 0;
    // 改了**只影响这一次**，⛔ 不回写默认
    d.acctId = pickDefaultAccount({ defaults: defaultsRows(), categoryId: null, ie, emptyAccountId: 0 });
  }
  paintEntrySheet();
}

/**
 * 功能：点了一个分类（`0` = 「未分类」）—— 记进草稿、重取默认账户、必要时出第二屏。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-cid` 取分类 id）
 * @returns {void}
 */
export function lgEntryCat(_act, n) {
  const d = state.lgDraft;
  if (!d) return;
  entryCapture();
  const cid = Number((n && n.dataset && n.dataset.cid) || 0);
  if (!cid) {
    // 「未分类」是**正经选择**：显示成「未分类」，⛔ 不是「其它」（C-32）
    d.catId = null;
    d.second = 0;
  } else {
    d.catId = cid;
    // 「有没有孩子」（进不进第二屏）走 `hasKids()` —— 它就是 `childCats().length > 0`：
    // 两边若各写一套过滤，就会出现"进了第二屏、里面是空的"（用户点了个不确定的东西，还不报错）
    // ：
    if (!d.second) d.second = hasKids(state.lgCats, cid) ? cid : 0;
  }
  d.acctId = pickDefaultAccount({ defaults: defaultsRows(), categoryId: d.catId, ie: d.ie, emptyAccountId: 0 });
  paintEntrySheet();
  loadNotes(d.catId);
}

/**
 * 功能：分类网格第二屏的「‹ 返回」—— 停在那个一级分类上（二级**可以不选**， 第 8 条）。
 * @returns {void}
 */
export function lgEntryBack() {
  entryCapture();
  if (state.lgDraft) state.lgDraft.second = 0;
  paintEntrySheet();
}

/**
 * 功能：「取消」—— 连草稿一起清（不清的话下次「记一笔」会把上回没提交的那份填回来）。
 * @returns {void}
 */
export function lgEntryCancel() {
  // 「取消」是**明确放弃**：内存草稿与本地草稿要一起清，
  clearDraft(editId ? `ledger-edit:${editId}` : 'ledger-entry');
  state.lgDraft = null;
  state.lgNotes = [];
  state.lgNotesCat = null;
  // 取消「改一笔」时也要把编辑态清掉：留着 `editId` 的话，下一次「记一笔」会去改那一条
  // （而用户以为自己是在新记一笔 —— 表现是"记了一笔，结果旧的那条变了"）
  resetEdit();
  closeSheet();
}

/**
 * 功能：点了一颗备注候选 —— 填进备注框（⛔ 不关弹层、⛔ 不自动提交），并把候选重筛一遍。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗胶囊（从 `data-note` 取候选）
 * @returns {void}
 */
export function lgEntryNote(_act, n) {
  const el = $('#lg-ed-note');
  if (!el) return;
  el.value = String((n && n.dataset && n.dataset.note) || '');
  if (state.lgDraft) state.lgDraft.note = el.value;
  paintNoteChips();
  el.focus();
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
 * 说明：⭐⭐ 改一笔走的是 **逐键** 那条路（`PUT /api/ledger/entries/:id`）：`editOrig` 里存着原值，
 * 这里**只把真改过的键**放进请求体。理由与 `putDefaults()` / `lgSave()` 逐字相同 ——
 * 整份原样提交会把"我没动过的字段"也重写一遍，万一同一个字段刚在别处被改过，
 */
export async function lgEntrySave() {
  const d = state.lgDraft;
  if (!d) return;
  entryCapture();
  const at = edAt(d);
  if (!at) {
    toast('时间没填全', true);
    return;
  }
  if (!d.amount) {
    toast('填一下金额（可以是 0）', true);
    const el = $('#lg-ed-amt');
    if (el) el.focus();
    return;
  }
  const catId = d.catId == null ? null : Number(d.catId);
  // 空值 ⇒ 服务端落到**空账户**上（「不关联」就是它）
  const acctId = d.acctId ? Number(d.acctId) : null;
  const note = String(d.note == null ? '' : d.note);
  const body = {};
  if (editId) {
    const o = editOrig || {};
    // 逐键比较的两边必须**同一口径**：时间比"补完秒之后"的串（`at` 比 `o.at`），
    if (at !== String(o.at || '')) body.at = at;
    if (d.ie !== String(o.ie || '')) body.ie = d.ie;
    if (String(d.amount) !== String(o.amount == null ? '' : o.amount)) body.amount = String(d.amount);
    if (catId !== (o.category_id == null ? null : Number(o.category_id))) body.category_id = catId;
    if (acctId !== (o.account_id == null ? null : Number(o.account_id))) body.account_id = acctId;
    if (note !== String(o.note == null ? '' : o.note)) body.note = note;
    if (!Object.keys(body).length) {
      toast('没有改动');
      state.lgDraft = null;
      state.lgNotes = [];
      resetEdit();
      markSaving();
      closeSheet();
      return;
    }
  } else {
    body.at = at;
    body.ie = d.ie;
    body.amount = String(d.amount);
    body.category_id = catId;
    body.account_id = acctId;
    body.note = note;
  }
  try {
    if (editId) await api('PUT', `/api/ledger/entries/${Number(editId)}`, body);
    else await api('POST', '/api/ledger/entries', body);
    const editing = !!editId;
    // 保存成功 ⇒ 本地草稿作废（`closeSheet()` 只在打了这个标记时才清）
    markSaving();
    closeSheet();
    state.lgDraft = null;
    state.lgNotes = [];
    resetEdit();
    // 记完 / 改完都**重取**：余额 / 净值是服务端算的，在本地跟着改一遍就是第二套算术；
    // 流水也从第一页重取（新记的那笔要在最上面，改过的那条要显示新样子）。
    await loadLedger();
    await loadEntries(true);
    toast(editing ? '改好了' : '记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：开「记退款」弹层 —— 给这一笔原交易退一笔（`POST /api/ledger/entries/:id/refunds`）。
 *
 * 说明：⭐ 账户与类别**默认沿用原交易**（钱退回原卡、类别不变，C-25）⇒ 这里只问金额 / 时间 / 备注，
 * 「累计 ≤ 原额」由**服务端**在一个事务里判（C-13），前端不预判、不重复实现。
 * @param {string} _act - 动作名（未用）
 */
export function lgRefund(_act, n) {
  const rid = Number((n && n.dataset && n.dataset.id) || 0);
  const e = (state.lgEntries || []).find((x) => Number(x.id) === rid);
  if (!e) return;
  refundOf = rid;
  const today = (state.lg && state.lg.today) || '';
  const { hm, ss } = nowPrefix();
  edSec = ss;
  // 预填**还能退多少**（原额 − 已退），而不是原额：已经退过一部分时预填原额会直接撞上限
  const left = Math.max(0, Math.trunc(Number(e.amount_fen) || 0) - Math.trunc(Number(e.refund_fen) || 0));
  openSheet(
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
    `<button class="btn primary" type="button" data-act="lg-rfsave" style="flex:1.4">确认退款</button>`,
  );
}

/**
 * @returns {Promise.<void>}
 */
export async function lgRefundSave() {
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
    closeSheet();
    refundOf = 0;
    // 退款会作为一条记账出现在原账户的明细里 ⇒ `overview` 与流水都重取。
    await loadLedger();
    await loadEntries(true);
    toast('退款记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

// ============================================================================
// ：**记账设置**（手机端是底部导航第三格；电脑端那边是宽弹窗）
// ============================================================================

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
 * 设置页那一栏的**重画钩子** —— `mobile-settings-pane.js` 挂载时登记，⛔ 只登记一个。
 * @type {?function()}
 */
let setPaneRepaint = null;

/**
 * 功能：登记 / 注销设置页那一栏的重画钩子（片段挂载时传 `fn`，卸载时传 `null`）。
 * @param {?function()} fn - 重画函数；传非函数即注销
 * @returns {void}
 */
export function setSettingsPaneRepaint(fn) {
  setPaneRepaint = typeof fn === 'function' ? fn : null;
}

/** 功能：重画设置页那一栏（没挂就什么都不做）。 @returns {void} @since */
function repaintSetPane() {
  if (setPaneRepaint) setPaneRepaint();
}

/**
 * 功能：记账设置那几块的**正文**（设置页那一栏用；`page` 空串 = 首页四条目那张列表）。
 *
 * 说明：⚠️ 与账本屏里那一份是**同一支**（`setHomeHtml()` / `setPageBodyHtml()`）——
 * 别为设置页另写一套：那就是两份真相，迟早一处改了另一处不改（而且**不报错**）。
 * @param {string} page - `SET_PAGES` 里的 `key`（认不出一律回**首页**）
 */
export function ledgerSetHtml(page) {
  const k = setPageOf(page);
  return k ? setPageBodyHtml(k) : setHomeHtml(true);
}

/**
 * 功能：设置页那一栏**现在该展开哪一子页**（空串 = 只列那四条）。
 *
 * 说明：⚠️ 那一栏的展开状态**就是 `state.lgSetPage`**（与账本屏的设置格共用同一个值）——
 * 于是「点条目 / 点 ‹ 返回」那两下**不用另写一套**：`lgSetGo()` / `lgSetBack()` 改完它
 * 本来就会调 `renderLedger()`，而那一趟会回调本栏的重画钩子（见 `setSettingsPaneRepaint()`）。
 */
export function ledgerSetPageNow() {
  return setPageOf(state.lgSetPage);
}

/**
 * 功能：设置页那一栏的 `change` —— 那三处「默认账户」（与账本屏那条委托是**同一支**）。
 *
 * 说明：⚠️ 判据只写在这里一处；`bindLedgerOnce()` 那条 `change` 也调它（⛔ 别再抄一份）。
 * @param {HTMLElement} t - 触发 `change` 的元素
 * @returns {void}
 */
export function handleLedgerSetChange(t) {
  if (!t) return undefined;
  if (t.id === 'lg-def-income') globalDefChanged('income', t);
  else if (t.id === 'lg-def-expense') globalDefChanged('expense', t);
  else if (t.dataset && t.dataset.defacct) catDefChanged(t);
  return undefined;
}

/**
 * 功能：备好**记账设置**那几块要用的数据（设置页那一栏挂载时先调它）。
 *
 * 说明：⚠️⚠️ 那一栏完全可能**在账本屏从没挂过的时候**被打开（用户直接进设置页）⇒ 它得自己
 * 把这几份取回来，⛔ 不能指望 `mountLedger()` —— 那一个还会按当前那一格把流水 / 预算一起拉，
 * 在设置页里全是白拉的。
 */
export async function prepareLedgerSettings() {
  await Promise.all([loadLedger(), ensureAcctNames(), ensureCats(true), ensureDefaults(true)]);
  // 「导入三方数据」那一页要的是**概况**（三态）——与 `lgSegPick()` 进设置格时同一条路。
  loadImportSummary();
}

/**
 *
 * 说明：⭐⭐ 「设置增加二级菜单，现在要滑动到底很不方便」——
 */
function setHomeHtml(plain) {
  const items = SET_PAGES.map(
    (p) =>
      `<button class="lg-setitem" type="button" data-act="lg-setgo" data-page="${p.key}">` +
      `<span class="lg-setitem-main"><b>${esc(p.name)}</b><i>${esc(p.desc)}</i></span>` +
      '<span class="lg-setitem-go" aria-hidden="true">›</span></button>',
  ).join('');
  // `plain` = **设置页那一栏**要的那一份 —— 那一栏自己已经有标题（`settingsPane.label`）
  // ⇒ ⛔ 不再重复画「记账设置」那句小标题。账本屏里那一份照旧带标题。
  if (plain) return `<div class="lg-setlist">${items}</div>`;
  return `<div class="lg-set">
    <div class="lg-setcap"><b>记账设置</b><i>记账时按这里预填账户；分类改完当场生效。</i></div>
    <div class="lg-setlist">${items}</div>
  </div>`;
}

/**
 * 功能：按 `key` 画设置**子页**的正文（⛔ 不含顶上那条「‹ 返回」头 —— 那是调用方配的）。
 *
 * 说明：⚠️ `page` 必须是 `setPageOf()` 认得的值（调用方已经过它一道）⇒ 这里认不出就回空串，
 * @param {string} page - `'acct'`（收支账户）/ `'cat'`（收支分类）/ `'imp'`（导入三方数据）/
 * `'exp'`（导出数据）
 */
function setPageBodyHtml(page) {
  if (page === 'acct') return setAcctHtml();
  if (page === 'cat') return setCatHtml();
  if (page === 'imp') return setImpHtml();
  if (page === 'exp') return setExpHtml();
  return '';
}

/**
 * 功能：画设置子页【收支账户】—— 全局两行（默认收入 / 默认支出）＋「每种类别的默认账户」。
 *
 * 说明：⭐⭐ 两条口径（一起改）：
 * **全部当场生效**：这一页原来底部有一颗「保存」（`.lg-setsave`），现在**撤了** ——
 * 每一颗下拉 / 那枚 ✕ 一改就提交（**逐键** `PUT /api/ledger/defaults`），
 */
function setAcctHtml() {
  const d = state.lgDefaults || { income: null, expense: null, categories: [] };
  const cats = state.lgCats || [];
  // 只列**已经设过**的那些（`d.categories` 就是"显式设过的"清单）—— 分类本身取不到
  // （被硬删过：`restore-builtin` 那条路）就跳过：没有名字可显示，也清不掉它。
  const rows = (d.categories || [])
    .map((x) => {
      const c = catFind(x.category_id);
      if (!c) return '';
      const name = catFullName(cats, c);
      return (
        `<div class="lg-setrow"><span class="lg-setname">${esc(name)}</span>` +
        `<select data-defacct="${Number(c.id)}" aria-label="${esc(name)} 的默认账户">${
          defOptions(x.account_id, true)
        }</select>` +
        `<button class="lg-defx" type="button" data-act="lg-defdel" data-id="${Number(c.id)}" ` +
        `aria-label="取消「${esc(name)}」的默认账户">✕</button></div>`
      );
    })
    .join('');
  return `<div class="lg-setcap"><b>收支账户</b><i>记账时的默认账户，记账时自动选择，可以更改。</i></div>
    <div class="lg-setrow"><span class="lg-setname">默认收入账户</span><select id="lg-def-income" aria-label="默认收入账户">${defOptions(
      d.income,
      false,
    )}</select></div>
    <div class="lg-setrow"><span class="lg-setname">默认支出账户</span><select id="lg-def-expense" aria-label="默认支出账户">${defOptions(
      d.expense,
      false,
    )}</select></div>
    <div class="lg-setcap"><b>每种类别的默认账户</b><i>给单个类别设置独立的默认账户。</i></div>
    ${rows || '<div class="lg-txwait">还没给任何类别单设。</div>'}
    <button class="btn lg-defadd" type="button" data-act="lg-defnew">＋ 新增</button>`;
}

/**
 * 功能：画设置子页【收支分类】—— 支出 / 收入两棵树 ＋「＋ 新建一级分类」＋「恢复内置分类」。
 *
 * 预置的 34 行**全是零级**（照一手样本抄的，样本那一列就是 31 个扁平名字），
 * 所以补的不是数据、是**让用户自己建二级分类的界面**（分类可建、可改名、删除＝归档）。
 * 那一句「删除＝归档」**作废了** —— 归档与删除从此是**两件事**
 */
function setCatHtml() {
  // ：两颗底部动作包进 `.lg-capfoot`
  // —— 它是 `position: sticky; bottom: 0`（钉在**滚动容器** `#view-ledger` 的底边）。
  return `<div class="lg-setcap"><b>收支分类</b><i>建好之后，「记一笔」里就会多出这一层。归档＝先收起来，还能恢复；删除＝真的去掉，用它记过的账会移到「其它」。</i></div>
    ${catTreeHtml('支出')}
    ${catTreeHtml('收入')}
    <div class="lg-capfoot">
      <button class="btn lg-capnew" type="button" data-act="lg-catnew">＋ 新建一级分类</button>
      ${catRestoreHtml()}
    </div>`;
}

/**
 * 功能：画设置子页【导入三方数据】—— 那两块说明 ＋「鲨鱼记账」那一行 ＋ 概况。
 *
 * 说明：⚠️ 概况是三态（正在读取 / 读不到 / 有数）—— 它由 `impSummaryHtml()` 一处画，
 * 进屏与这一页的重画都走同一个函数（⛔ 不在这里另判一遍三态）。
 * @returns {string} 这一页的 HTML
 */
function setImpHtml() {
  return `<div class="lg-setcap"><b>导入三方数据</b><i>${IMP_HELP}</i></div>
    <div class="lg-setrow"><span class="lg-setname">${IMP_LABEL}</span>
      <button class="lg-impbtn" type="button" data-act="lg-imp-open">导入</button></div>
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
      `<label class="lg-expitem"><input type="checkbox" data-act="lg-exp-what" data-key="${esc(w.key)}"${
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
    <div class="lg-expgo"><button class="btn primary lg-expbtn" type="button" data-act="lg-exp-dl">导出</button></div>`;
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
 * @param {string} what - 导什么
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
 * @param {string} _act - 动作名（未用）
 */
export function lgExpWhat(_act, n) {
  const key = String((n && n.dataset && n.dataset.key) || '');
  if (!EXPORT_WHAT_KEYS.includes(key)) return;
  const cur = new Set(expWhatKeys());
  if (n.checked) cur.add(key);
  else cur.delete(key);
  state.lgExportWhat = EXPORT_WHAT_KEYS.filter((k) => cur.has(k));
  renderLedger();
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
  return `<label class="lg-expdate${enabled ? '' : ' lg-expoff'}" data-act="lg-exp-date">
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
export function lgExpDateOpen(_act, n, ev) {
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
 * @param {string} _act - 动作名（未用）
 */
export function lgExpDatePick(_act, n) {
  const id = String((n && n.id) || '');
  const v = String((n && n.value) || '');
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
  if (id === 'lg-exp-from') state.lgExportFrom = v;
  else if (id === 'lg-exp-to') state.lgExportTo = v;
  else return;
  renderLedger();
}

/**
 * 功能：点「下载 CSV」—— ⭐ **先弹确认框 → 再浏览器导航**（照设置页那两处的既有形态）。
 *
 * 说明：⭐⭐ 多选时**逐个下**（C-19：⛔ 不引 zip、⛔ 不引 Blob）：勾了三样就是**三次**
 * 「确认 → 导航」，每次一个 `.csv`；用户在任意一次点「取消」⇒ 剩下的**不再问**
 * （⛔ 不把后面的当成"都同意"）。
 */
export async function lgExpDownload(_act, _n) {
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
  for (const what of keys) {
    const ok = await askConfirm({ title: '导出', text: expConfirmText(what, from, to), ok: '开始下载' });
    if (!ok) return;
    window.location.href = expUrlOf(what, from, to);
    toast(`已开始下载：${expWhatName(what)}`);
  }
}

/**
 * 功能：从设置**首页**点进某一页（`data-page` 上带着 `SET_PAGES` 的 `key`）。
 *
 * 说明：⚠️ 判据走 `setPageOf()`（认不出＝留在首页，⛔ 不切）—— 认不出还切过去的话，
 * 用户会站在一个空白页上而**没有任何提示**。
 * 只换页、**不重新取数**：那一页要的数据（分类 / 默认账户 / 导入概况）进「设置」这一格
 */
export function lgSetGo(_act, n) {
  const k = setPageOf(n && n.dataset && n.dataset.page);
  if (!k) return;
  state.lgSetPage = k;
  renderLedger();
  // 【导出数据】那一页那两颗日期框的**起点**取自服务端（`/api/ledger/periods`
  // 的 `export.from` / `.to`，与图表那边**共用同一个 state 键** `lgPeriods`）——
  if (k === 'exp' && !state.lgPeriods) loadPeriods();
}

/**
 * 功能：设置子页的「‹ 返回」⇒ 回设置首页（⛔ 不是退出记账）。
 *
 * 说明：⚠️ 手机端的历史栈只认「底部标签」那一层（`syncHistory()` 只压 `#tab`）⇒ 这一层
 * 照账户详情 / 账单屏同款：屏内自带返回，⛔ 不去碰宿主的 hash 机制。
 * 回首页**不重画顶栏以外的东西**：首页那四条目是静态的，分类 / 默认账户那一份
 */
export function lgSetBack() {
  state.lgSetPage = '';
  renderLedger();
}

/**
 * 功能：提交一条默认账户的改动 —— ⭐ **逐键**（只带要改的那**一个**键），存完**从服务端回读**。
 *
 * 说明：⭐⭐ 口径是「这一页全部当场生效」⇒ 原来那颗「保存」（`lgSetSave`）
 * 连同它"一次提交好几键"的写法**整块删掉**了（⛔ 不留两条保存路径：一条当场生效、
 * 一条攒着提交，迟早出现"我明明改过它却没生效"）。
 */
async function putDefaults(body) {
  try {
    const r = await api('PUT', '/api/ledger/defaults', body);
    state.lgDefaults = (r && r.defaults) || state.lgDefaults;
    renderLedger();
    return true;
  } catch (e) {
    toast(e.message, true);
    renderLedger();
    return false;
  }
}

/**
 * 功能：全局两层（默认收入 / 默认支出）那颗下拉的 change —— 认 `#lg-def-income` / `#lg-def-expense`。
 *
 * 说明：⚠️ 它**不走宿主的 `ACTIONS` 表**（`<select>` 的 `change` 不是点击委托的那条路）——
 * 与账户详情那颗月份下拉（`#lg-c-month`）同一种手法，判据住 `bindLedgerOnce()`。
 * 值**没变就什么都不做**（不发那条注定白跑的请求、也不弹一句"没有改动"）：
 */
async function globalDefChanged(key, sel) {
  const d = state.lgDefaults || { income: null, expense: null };
  const v = Number(sel.value) || 0;
  if (!v) return;
  const old = Number(key === 'income' ? d.income : d.expense) || 0;
  if (v === old) return;
  await putDefaults(key === 'income' ? { income_id: v } : { expense_id: v });
}

/**
 * 功能：每类别那一颗下拉的 change —— 认那一行上的 `data-defacct`（= 分类 id）。
 *
 * 说明：⚠️ 选到「跟随全局默认」（值是空串）就是**清掉这一行**（提交 `null`）——
 * 与那枚 ✕ 是同一件事的两个入口，⛔ 别一个清、一个留在那儿。
 * @param {HTMLSelectElement} sel - 那一颗下拉（`data-defacct` 上带着分类 id）
 */
async function catDefChanged(sel) {
  const cid = Number(sel.dataset.defacct) || 0;
  if (!cid) return;
  const d = state.lgDefaults || { categories: [] };
  const old = (d.categories || []).find((x) => Number(x.category_id) === cid);
  const oldV = old && old.account_id ? Number(old.account_id) : 0;
  const v = Number(sel.value) || 0;
  if (v === oldV) return;
  await putDefaults({ categories: { [String(cid)]: v ? v : null } });
}

/**
 * 功能：某一行的「✕」—— 把那个类别的默认账户**清掉**（回落到全局默认），⛔ 不是删分类。
 *
 * 说明：⚠️ 它是**一个明确动作**（用户点了才发生）⇒ 不需要二次确认（不是破坏性的：
 * 清掉之后还能再设回来，分类本身与记过的账一个字节都不动）。
 * @param {string} _act - 动作名（未用）
 */
export async function lgDefDel(_act, n) {
  const cid = Number((n && n.dataset && n.dataset.id) || 0);
  if (!cid) return;
  const c = catFind(cid);
  const name = c ? catFullName(state.lgCats, c) : '';
  const ok = await putDefaults({ categories: { [String(cid)]: null } });
  if (ok) toast(name ? `「${name}」改回跟随全局默认了` : '改回跟随全局默认了');
}

/**
 * 功能：「＋ 新增」—— 开「给类别设默认账户」那张弹层（挑一个类别 ＋ 选一个账户）。
 *
 * 说明：⭐⭐ 这一页改成**按需新增**（「类别不要全部显示，默认就是
 * 【默认收入账户】，用户可以通过【新增】按钮来设置各个类别的默认」）⇒
 * 那一列只列**已经设过的**（`setAcctHtml()` 画），这一颗负责把新的设进来。
 */
export function lgDefNew() {
  const d = state.lgDefaults || { categories: [] };
  const cats = state.lgCats || [];
  const setIds = new Set((d.categories || []).map((x) => Number(x.category_id)));
  const opts = cats
    .filter((c) => !c.archived && !setIds.has(Number(c.id)))
    .map((c) => `<option value="${Number(c.id)}">${esc(catFullName(cats, c))}</option>`)
    .join('');
  if (!opts) {
    openSheet(
      '给类别设默认账户',
      '<div class="lg-tip">每个类别都设好了。</div>',
      '<button class="btn" type="button" data-act="sheet-close">知道了</button>',
    );
    return;
  }
  openSheet(
    '给类别设默认账户',
    `<label class="fld"><span>类别</span><select id="lg-f-defcat">${opts}</select></label>
     <label class="fld"><span>默认账户</span><select id="lg-f-defacct">${defOptions(0, true)}</select></label>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-defnewgo" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：存下「给类别设默认账户」那一张弹层 —— 提交 `{categories: {<分类 id>: <账户 id>|null}}`。
 *
 * 说明：⚠️ 存完**先 `closeSheet()` 再重画**（重画在 `putDefaults()` 里做过，但那时弹层还开着）——
 * 弹层是独立节点 `#sheet`，留在屏上会把刚重画好的列表整个盖住（看着像"点了没反应"）。
 * 校验不过时**不关弹层**（用户就在那一格里，让他接着选）。
 */
export async function lgDefNewGo() {
  const catEl = $('#lg-f-defcat');
  const cid = Number((catEl && catEl.value) || 0);
  if (!cid) {
    toast('先挑一个类别', true);
    return;
  }
  const acctEl = $('#lg-f-defacct');
  const v = Number((acctEl && acctEl.value) || 0);
  const c = catFind(cid);
  const name = c ? catFullName(state.lgCats, c) : '';
  const ok = await putDefaults({ categories: { [String(cid)]: v ? v : null } });
  if (!ok) return;
  closeSheet();
  toast(name ? `「${name}」的默认账户设好了` : '设好了');
}

//
// 这一栏**不新开屏、不新增入口按钮**：它就长在设置子页【收支分类】里（第 2 条要的是
// "能建二级分类的地方"，不是"再一个列表页"）。电脑端那边是同一个宽弹窗里的同一栏。

/**
 * 功能：画某一侧（支出 / 收入）的**两级树**：一级一行，它下面每个二级各一行（**含已归档的**）。
 *
 * 说明：⚠️ 侧别标题与「每种类别的默认账户」那几行用同一套小标题样式（`.lg-setcap2`）。
 * `includeArchived: true` ⇒ 归档的**一级与二级都要画**（分类管理这一页必须能看见
 * "这个分类去哪了"，也才有地方点「恢复」/「删除」）—— ⛔ 别在这里筛掉归档的。
 */
function catTreeHtml(ie) {
  const tops = catTree(state.lgCats, ie, { includeArchived: true });
  const rows = [];
  for (const t of tops) {
    const kids = t.kids || [];
    const open = !!state.lgCatOpen[Number(t.id)];
    rows.push(catRowHtml(t, false, kids.length, open));
    // ：子级**只在展开时才画**。
    // 展开态住 `state.lgCatOpen`（默认空对象 ＝ 全部折叠）。
    if (open) for (const k of kids) rows.push(catRowHtml(k, true, 0, false));
  }
  return `<div class="lg-setcap2">${esc(ie)}</div>${
    rows.length ? rows.join('') : '<div class="lg-txwait">这一侧还没有收支分类。</div>'
  }`;
}

/**
 * 功能：画收支分类的一行 —— 名字（自定义的带一枚小字标记）＋ 这一行允许的那些动作。
 *
 * 说明：⭐⭐ 三件事**按服务端已经判好的标记**决定画不画，⛔ 前端不再自己比名字：
 * `builtin === true`（**内置**分类，既定的 22 行：支出 15 ＋ 收入 7）：
 * **改名与归档都不给** —— 服务端这两条路一律 400（「内置分类不能改名」/「内置分类不能删除」），
 */
function catRowHtml(c, kid, kidCount, open) {
  const builtin = !!c.builtin;
  // ：一级行前那颗 `▸ N` / `▾ N` 开关。
  // 它**另起一格**（`.lg-caplead` 的第一个孩子），⛔ **不进 `.lg-capname`** ——
  // 那个元素的文本内容就是分类名，探针有一批拿它做**相等比较**的断言。
  const n = Number(kidCount) || 0;
  const toggle =
    !kid && n > 0
      ? `<button class="lg-captoggle" type="button" data-act="lg-cattoggle" data-id="${Number(c.id)}"` +
        ` aria-expanded="${!!open}" aria-label="${open ? '折叠' : '展开'}子分类">${open ? '▾' : '▸'}<i>${n}</i></button>`
      : '';
  const lead = `<span class="lg-caplead">${toggle}<span class="lg-capname">${esc(c.name)}</span>${
    builtin ? '' : '<i class="lg-captag">自定义</i>'
  }</span>`;
  const cls = `lg-caprow${kid ? ' kid' : ''}${c.archived ? ' arch' : ''}`;
  const custom = !builtin && !c.other;
  if (c.archived) {
    // 归档态：灰化（`.arch`）＋「已归档」标记**照留**，自定义行多两颗（见上面那段说明）。
    const acts = [];
    if (custom) {
      acts.push(
        `<button class="lg-capbtn" type="button" data-act="lg-catunarc" data-id="${Number(c.id)}">恢复</button>`,
      );
      acts.push(
        `<button class="lg-capbtn del" type="button" data-act="lg-catdel" data-id="${Number(c.id)}">删除</button>`,
      );
    }
    return `<div class="${cls}">${lead}<i class="lg-caparch">已归档</i>${
      acts.length ? `<span class="lg-capacts">${acts.join('')}</span>` : ''
    }</div>`;
  }
  const acts = [];
  // 改名：内置与兜底分类都不给（服务端一律 400）
  if (custom) {
    acts.push(`<button class="lg-capbtn" type="button" data-act="lg-catren" data-id="${Number(c.id)}">改名</button>`);
  }
  // 「＋ 子分类」只给一级（收支分类只有两级，服务端对二级当父会 400）；内置行也给
  if (!kid) {
    acts.push(
      `<button class="lg-capbtn" type="button" data-act="lg-catsub" data-id="${Number(c.id)}">＋子分类</button>`,
    );
  }
  // 归档：同上（内置 / 兜底都不给）
  if (custom) {
    acts.push(
      `<button class="lg-capbtn danger" type="button" data-act="lg-catarc" data-id="${Number(c.id)}">归档</button>`,
    );
    // 「删除」—— 真删（不可恢复）⇒ 危险色，而且确认层写全三件事（见 `lgCatDel()`）
    acts.push(
      `<button class="lg-capbtn del" type="button" data-act="lg-catdel" data-id="${Number(c.id)}">删除</button>`,
    );
  }
  return `<div class="${cls}">${lead}<span class="lg-capacts">${acts.join('')}</span></div>`;
}

/**
 * 功能：画【收支分类】栏最底下那颗「恢复内置分类」—— **危险行**，确认层见 `lgCatRestore()`。
 *
 * 用它们记过的账显示成「未分类」）⇒ 版式照手机端设置页「恢复整体备份」/「迁移记账数据」
 * 那两处（`mobile/views/more.js` 的 `.mrow` ＋ `.mico.danger` ＋ `.mval.danger`）的**危险待遇**，
 * 只是长在记账这一栏里、类名走 `.lg-caprestore-*`（⛔ 不复用 `.mrow`：一个类名别给两个组件用，
 */
function catRestoreHtml() {
  return `<button class="lg-caprestore" type="button" data-act="lg-catrestore">
    <span class="lg-caprestore-ico" aria-hidden="true">⚠️</span>
    <span class="lg-caprestore-main"><b>恢复内置分类</b><small>补齐缺失内置、清理旧版配置；自定义数据不受影响，操作不可恢复！！！</small></span>
    <span class="lg-caprestore-val">危险</span>
  </button>`;
}

/**
 * 功能：开「恢复内置分类」的确认层 —— ⚠️ 危险动作，必须**手打「恢复」二字**才放行。
 *
 * 说明：⭐⭐ 确认这一下照抄手机端设置页那两处（`mobile/views/more.js` 的 `orgRestoreFlow()` /
 * 在提交函数里校验那两个字（不够格就 `toast` 拦下）。⛔ 不自己发明第二套。
 * ① 内置分类会补齐；② **自定义数据不受影响**；③ 旧版配置（旧的内置分类）会被清理
 */
export function lgCatRestore() {
  openSheet(
    '⚠️ 恢复内置分类',
    '<div class="lg-tip">补齐缺失内置、清理旧版配置；自定义数据不受影响，<b>操作不可恢复</b>！</div>' +
      '<div class="lg-tip">用它们记过的账会显示成「未分类」。旧分类下面的子分类不会跟着消失，' +
      '会改挂到同一侧的「其它」下面。</div>' +
      '<div class="lg-tip"><b>操作不可恢复</b>：旧分类从列表里删除（记过的账目不会丢失）。</div>' +
      '<label class="fld lg-cfmlab"><span>确认请输入「恢复」二字：</span>' +
      '<input id="lg-rst-word" type="text" autocomplete="off" /></label>',
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="lg-catrestorego" style="flex:1.4">确认恢复（危险）</button>`,
  );
}

/**
 *
 * 说明：⭐⭐ 只翻 `state.lgCatOpen` 里的一个键，然后重画这一屏。
 */
export function lgCatToggle(_act, n) {
  const cid = Number((n && n.dataset && n.dataset.id) || 0);
  if (!cid) return;
  if (state.lgCatOpen[cid]) delete state.lgCatOpen[cid];
  else state.lgCatOpen[cid] = true;
  const host = document.querySelector('#view-ledger');
  const top = host ? host.scrollTop : 0;
  renderLedger();
  if (host) host.scrollTop = top;
}

/**
 * 功能：校验那两个字，然后真调一次「恢复内置分类」，把结果用**真实计数**说给用户听。
 *
 * 说明：⭐⭐ 返回里**已经带着最新的整份 `categories`** ⇒ 直接换掉手上的清单（`state.lgCats`）
 * ＋ 原地重画这一屏，⛔ **不再 GET 一次**（多取一次不只是白跑一趟：两份清单之间若有过期，
 * 表现就是"刚恢复完、看到的还是旧的那一份"，而且**不报错**）。
 */
export async function lgCatRestoreGo() {
  const w = $('#lg-rst-word');
  if (String((w && w.value) || '').trim() !== '恢复') {
    toast('请输入「恢复」两个字才能继续', true);
    return;
  }
  try {
    const r = (await api('POST', '/api/ledger/restore-builtin')) || {};
    if (Array.isArray(r.categories)) state.lgCats = r.categories;
    closeSheet();
    renderLedger();
    toast(restoreBuiltinText(r));
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把「恢复内置分类」那四个计数翻成一句人话（⚠️ 0 的项**不显示**）。
 *
 * 说明：⚠️ 计数全为 0（清单本来就对齐）时要有一句"什么都没动"，⛔ 不能给一个空串 ——
 * `toast('')` 是一条**空白提示条**，看起来像坏了。
 * ④）—— 那边是本文件的镜像实现，⛔ 没法共享（跨端各写一份是 的口径）。
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

/**
 * 功能：画「新建 / 改名」那张小表单的正文（两级分类共用一张，`catAsk` 记着这次是哪种）。
 * @returns {string} 正文 HTML
 */
function catNameFormHtml() {
  const p = catAsk || { mode: 'new', id: 0, parentId: 0, ie: '支出' };
  const parent = catFind(p.parentId);
  const label =
    p.mode === 'ren' ? '分类名' : p.mode === 'sub' ? `挂在「${esc(parent ? parent.name : '')}」下面` : '分类名';
  // 侧别那颗下拉只在**新建一级**时出现（二级继承父、改名改不了侧 —— 服务端对这两个键 400）
  const side =
    p.mode === 'new'
      ? `<label class="fld"><span>属于哪一侧</span>
          <select id="lg-f-catie">
            <option value="支出"${p.ie === '收入' ? '' : ' selected'}>支出</option>
            <option value="收入"${p.ie === '收入' ? ' selected' : ''}>收入</option>
          </select></label>`
      : '';
  return `<label class="fld"><span>${label}</span>
      <input id="lg-f-capname" type="text" maxlength="${CAT_NAME_MAX}" value="${
        p.mode === 'ren' ? esc((catFind(p.id) || {}).name || '') : ''
      }" /></label>${side}`;
}

/** 功能：从手上那份分类清单里按 id 找一个（找不到回 `null`）。 @param {number} id - 分类 id @returns {?Object} @since */
function catFind(id) {
  const cid = Number(id) || 0;
  if (!cid) return null;
  return (state.lgCats || []).find((c) => Number(c.id) === cid) || null;
}

/** 功能：「＋ 新建一级分类」——问名字与侧别。 @returns {void} @since */
export function lgCatNew() {
  catAsk = { mode: 'new', id: 0, parentId: 0, ie: '支出' };
  openSheet(
    '新建一级分类',
    catNameFormHtml(),
    `<button class="btn primary" type="button" data-act="lg-catsave" style="flex:1.4">保存</button>`,
  );
}

/** 功能：某个一级分类上的「＋子分类」——只问名字（上一级是这一行）。 @param {string} _act - 动作名（未用） @param {HTMLElement} n - 那颗按钮（`data-id` = 一级分类 id） @returns {void} @since */
export function lgCatSub(_act, n) {
  const p = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!p) return;
  catAsk = { mode: 'sub', id: 0, parentId: Number(p.id), ie: String(p.ie || '') };
  openSheet(
    '新建二级分类',
    catNameFormHtml(),
    `<button class="btn primary" type="button" data-act="lg-catsave" style="flex:1.4">保存</button>`,
  );
}

/** 功能：某一行的「改名」——名字回填好，改完就走逐键那条 PUT。 @param {string} _act - 动作名（未用） @param {HTMLElement} n - 那颗按钮（`data-id` = 分类 id） @returns {void} @since */
export function lgCatRen(_act, n) {
  const c = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!c) return;
  catAsk = { mode: 'ren', id: Number(c.id), parentId: 0, ie: String(c.ie || '') };
  openSheet(
    '给这个分类改名',
    catNameFormHtml(),
    `<button class="btn primary" type="button" data-act="lg-catsave" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：存下「新建一级 / 新建二级 / 改名」—— 三条路各发各的形状（服务端对形状是**严格**的）。
 *
 * 说明：⭐⭐ 三个形状各是什么，一个字都不能多：
 * 新建二级：`{name, parent_id}`（`ie` 由父继承，服务端不接受）；
 * 改名：**只** `{name}` —— 带上 `ie` 或 `parent_id` 一律 400（`checkCategory(b, true)`
 */
export async function lgCatSave() {
  const el = $('#lg-f-capname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个分类起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const p = catAsk || { mode: 'new', id: 0, parentId: 0, ie: '支出' };
  // 候选全称：合成一个小"分类"交给 `catFullName()`（它按 `parent_id` **现从清单里取父名**）
  // —— 二级的父名走这条路永远是**最新**的那一份，⛔ 不用打开弹层时缓存下来的名字。
  const self = p.mode === 'ren' ? catFind(p.id) : null;
  const full = catFullName(state.lgCats, {
    name,
    parent_id: p.mode === 'sub' ? Number(p.parentId) : self ? Number(self.parent_id) : 0,
  });
  if (catNameTaken(state.lgCats, full, p.mode === 'ren' ? Number(p.id) : 0)) {
    toast(`已经有叫「${full}」的分类了`, true);
    if (el) el.focus();
    return;
  }
  try {
    if (p.mode === 'ren') {
      await api('PUT', `/api/ledger/categories/${Number(p.id)}`, { name });
    } else if (p.mode === 'sub') {
      await api('POST', '/api/ledger/categories', { name, parent_id: Number(p.parentId) });
    } else {
      const ieEl = $('#lg-f-catie');
      const ie = ieEl && String(ieEl.value) === '收入' ? '收入' : '支出';
      await api('POST', '/api/ledger/categories', { name, ie });
    }
    closeSheet();
    catAsk = null;
    await ensureCats(true);
    renderLedger();
    toast(p.mode === 'ren' ? '改好了' : '分类建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 *
 * 说明：⭐⭐  第 7 条 / C-29：「归档一个父分类时，它的子分类怎么办」**必须问**：
 */
export function lgCatArc(_act, n) {
  const c = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!c) return;
  if (!hasKids(state.lgCats, c.id)) {
    askConfirm({
      title: `归档「${c.name}」？`,
      text: '归档后它不再出现在记账的分类里，但已经记过的账照旧显示这个名字。',
      ok: '归档',
    }).then((ok) => {
      if (ok) catArchiveGo(Number(c.id), 'archive');
    });
    return;
  }
  openSheet(
    `归档「${c.name}」？`,
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">它下面还有子分类，归档前得先决定它们怎么办。</p>
     <div class="lg-dacts">
       <button class="lg-dact" type="button" data-act="lg-catarcgo" data-id="${Number(c.id)}" data-mode="archive">子分类一起归档</button>
       <button class="lg-dact" type="button" data-act="lg-catarcgo" data-id="${Number(c.id)}" data-mode="move-children">子分类移到「其它」</button>
     </div>`,
    `<button class="btn" type="button" data-act="cf-no">取消</button>`,
  );
}

/** 功能：二选一之后真的归档（`mode` 从按钮的 `data-mode` 来）。 @param {string} _act - 动作名（未用） @param {HTMLElement} n - 二选一里那颗（带 `data-id` / `data-mode`） @returns {void} @since */
export function lgCatArcGo(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const mode = String((n && n.dataset && n.dataset.mode) || '');
  if (!id || (mode !== 'archive' && mode !== 'move-children')) return;
  closeSheet();
  catArchiveGo(id, mode);
}

/**
 * 功能：真的归档（`DELETE /api/ledger/categories/:id?mode=…`）—— 存完重取分类并**重画这一屏**。
 *
 * 说明：⚠️ `mode` **走查询参数**（不是请求体）；缺省是 `archive`，但这里两颗按钮都显式带上
 * —— 少带一次「移到其它」就变成「一起归档」，而且**不报错**。
 * 归档完不关这一屏（那一段是底部第三格，`state.lgSeg` 不动）：用户还要接着管别的分类
 */
async function catArchiveGo(id, mode) {
  try {
    await api('DELETE', `/api/ledger/categories/${Number(id)}?mode=${encodeURIComponent(mode)}`);
    // 归档「父分类 ＋ 子分类」之后，那份"每种类别的默认账户"里可能还留着一行指向**已归档**的
    // 分类 ⇒ 它也要重取（那份默认账户**不进 `overview`**，必须单独取一次）。
    await Promise.all([ensureCats(true), ensureDefaults(true)]);
    renderLedger();
    toast('已归档');
  } catch (e) {
    toast(e.message, true);
  }
}

//
// 「②自定义的要支持删除（已归档的也要可以恢复使用和删除），删除过后下的记账移动到其它」
// ⇒ 在这一栏上补两条路：

/**
 * 功能：某一行的「删除」—— 先出一道确认层（⚠️ 不可逆），再真的删。
 *
 * ① 「`<全称>`」会从分类里永远消失（不可恢复）；
 * ② 用这个分类记过的账会移到「其它」；
 * ③ **它下面有子分类时**再加一句：那些子分类会改挂到「其它」。
 */
export function lgCatDel(_act, n) {
  const c = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!c || c.builtin || c.other) return;
  const full = catFullName(state.lgCats, c);
  const kidTip = hasKids(state.lgCats, c.id)
    ? '<div class="lg-tip">它下面的子分类会改挂到「其它」。</div>'
    : '';
  openSheet(
    '⚠️ 删除分类',
    `<div class="lg-tip">「${esc(full)}」会从分类里永远消失（不可恢复）。</div>` +
      '<div class="lg-tip">用这个分类记过的账会移到「其它」。</div>' +
      kidTip,
    `<button class="btn" type="button" data-act="cf-no">取消</button>
     <button class="btn danger" type="button" data-act="lg-catdelgo" data-id="${Number(c.id)}" style="flex:1.4">永久删除</button>`,
  );
}

/**
 * 功能：真的删掉那个分类（`DELETE /api/ledger/categories/:id?mode=delete`），把结果说成人话。
 *
 * 说明：⭐⭐ 服务端一个动作里把三件事都办了（顺序见 `store.ledgerDeleteCategory`）：它名下的账改挂
 * 同侧「其它」、它的子分类改挂同侧「其它」、清掉它自己的"每类别默认账户"那一行、删行本身。
 * 返回的是**真改到的两个行数**（`movedEntries` / `movedChildren`）⇒ 提示里说真实数字，
 */
export async function lgCatDelGo(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  if (!id) return;
  try {
    const r = (await api('DELETE', `/api/ledger/categories/${id}?mode=delete`)) || {};
    closeSheet();
    await Promise.all([ensureCats(true), ensureDefaults(true)]);
    renderLedger();
    toast(catDelText(r));
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把「永久删除一个分类」那条接口的结果翻成一句人话（⛔ 数字全部来自返回体）。
 *
 * 说明：⭐ 形状照 `restoreBuiltinText()`：**0 的项不出现**，一件都没动时给一句干净的"已删除"，
 * 不给空串（`toast('')` 是一条**空白提示条**，看起来像坏了）。
 * 措辞与电脑端 `desktop.js` 的 `catDelText()` **逐字一致**（同一件事两端
 */
function catDelText(r) {
  const parts = [];
  if (Number((r || {}).movedEntries)) parts.push(`${r.movedEntries} 笔账`);
  if (Number((r || {}).movedChildren)) parts.push(`${r.movedChildren} 个子分类`);
  if (!parts.length) return '已删除。';
  return `已删除；${parts.join('和')}移到「其它」。`;
}

/**
 * 功能：已归档那一行的「恢复」—— 取消归档（`POST /api/ledger/categories/:id/restore`）。
 *
 * 说明：⚠️ **不做二次确认**：它不是破坏性的（这一步没有任何东西消失，只是那一行重新可选；
 * 要收回去再归档一次就行）——「恢复内置分类」那种要手打二字的待遇是给**不可逆**动作的，
 * 别把两者拉平（拉平之后用户对"真危险"那一个也会麻痹）。
 */
export async function lgCatUnArc(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  if (!id) return;
  const c = catFind(id);
  const name = c ? catFullName(state.lgCats, c) : '';
  try {
    await api('POST', `/api/ledger/categories/${id}/restore`);
    await ensureCats(true);
    renderLedger();
    toast(name ? `「${name}」能用了` : '能用了');
  } catch (e) {
    toast(e.message, true);
  }
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
 * 走势图的画布（**手机端版式**；⚠️ 电脑端自己一份 —— 那边一栏更宽）。
 * `svg` 用 `width:100%; height:auto` + 默认的等比缩放 ⇒ 圆心 / 折点不会被拉成椭圆
 */
const TREND_BOX = { w: 330, h: 150, padL: 10, padR: 10, padT: 14, padB: 26 };

/**
 * ：
 * **带纵轴**的那一份画布 —— 只多让出左边那一栏（`padL` 10 → 52），其余逐字同 `TREND_BOX`。
 */
const AXIS_BOX = { w: 330, h: 150, padL: 52, padR: 10, padT: 14, padB: 26 };

/**
 * 纵轴刻度文字的字号（**画布单位**，⛔ 不是屏幕像素）。
 * `svg` 是按容器宽度等比缩放的 ⇒ 它实际看着多大取决于卡片多宽；12.5 ≈ 缩到 10.5px，
 */
const AXIS_FONT = 12.5;
/** 环形图的半径与描边宽度（画法住 `calc.js` 的 `donutArcs()`） */
const DONUT_R = 52;
const DONUT_SW = 20;

/**
 * 功能：当前选中的图表口径。
 *
 * 说明：⚠️ 认不出（初值 / 别的设备上删过什么）一律回落 `'asset'` —— ⛔ 别停在一个不存在
 * 的档上，那样这一屏会一片空白且没有任何提示。
 *
 */
function rangeOf() {
  const k = String(state.lgRange || '');
  return RANGES.some((r) => r.key === k) ? k : 'asset';
}

/**
 * 功能：当前选中的视图（`'asset'` 资产台账 / `'chart'` 图表）。
 * @returns {string} `'asset'` | `'chart'`
 */
function tabOf() {
  return state.lgTab === 'chart' ? 'chart' : 'asset';
}

/**
 *
 * 屏幕位置」）：原来这里是一行占满宽的「资产｜图表」分段控件（`.lg-seg`）——
 */
function tabDotsHtml(items, cur, act) {
  const list =
    items && items.length
      ? items
      : [
          { key: 'asset', name: '资产' },
          { key: 'chart', name: '图表' },
        ];
  const now = cur || tabOf();
  const action = act || 'lg-tab';
  const dot = (k, label) =>
    `<button class="lg-dots-i${now === k ? ' on' : ''}" type="button" data-act="${esc(action)}" data-tab="${esc(k)}"` +
    ` aria-label="${esc(label)}" aria-selected="${now === k}"></button>`;
  return `<div class="lg-dots" role="tablist">${list.map((t) => dot(t.key, t.name)).join('')}</div>`;
}

/**
 * 功能：图表的三态切换（资产 / 负债 / 净资产）。
 *
 * 说明：⚠️ 与上面那颗**同族但更轻**（`.lg-seg-sub`）：上面那颗回答"看哪一屏"，
 * 这颗回答"按哪个口径看" —— 层级不同，视觉上就不该一样重。
 *
 */
function rangeBarHtml() {
  const cur = rangeOf();
  const btn = (r) =>
    `<button class="lg-seg-btn${cur === r.key ? ' on' : ''}" type="button" data-act="lg-range" data-range="${
      r.key
    }" role="tab" aria-selected="${cur === r.key}">${r.name}</button>`;
  return `<div class="lg-seg lg-seg-sub" role="tablist">${RANGES.map(btn).join('')}</div>`;
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
 * 说明：⚠️ `geo.empty`（这一年一个点都没有）时画**一句人话**，⛔ 不画一张空网格
 */
function trendCardHtml(geo, series, d) {
  // （「把【资产、负债、净资产】放到资产走势图位置（也就是移除手机端
  // 【资产走势图】这个文字，由三个切换按钮代替）」）：卡标题那句**撤了**，位置交给三态控件
  // （左三颗按钮 ＋ 右年份下拉，同住 `.lg-ccap` 那一行）。
  const cap = `<div class="lg-ccap">${rangeBarHtml()}${yearSelectHtml(d)}</div>`;
  if (geo.empty) {
    const y = String((d && d.today) || '').slice(0, 4);
    return `<div class="lg-card">${cap}
      <div class="lg-wait">${esc(y)} 年还没有记录 —— 你每次改余额，我都会记下当天那一刻。</div></div>`;
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
        `<text class="lg-tyt" x="${b.padL - 6}" y="${t.y}" dy="${(AXIS_FONT * 0.35).toFixed(1)}">${esc(
          yLabels[i],
        )}</text>`,
    )
    .join('');
  const segs = geo.segs.map((p) => `<polyline class="lg-tl" points="${p}" />`).join('');
  const dots = geo.dots
    .map((p) => `<circle class="lg-td${p.open ? ' open' : ''}" cx="${p.x}" cy="${p.y}" r="3.4" />`)
    .join('');
  // 命中圈**画在圆点之后**（它盖在最上面才点得中），而且是 `fill: transparent` 而不是
  // `none` —— `none` 不参与命中测试，那圈就等于不存在（而"点了没反应"不会报错）。
  const hits = geo.dots
    .map(
      (p) =>
        `<circle class="lg-thit" cx="${p.x}" cy="${p.y}" r="12" data-act="lg-tdot" data-lbl="${esc(
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
 * 功能：「当前资产 / 负债状况」—— 环形图 ＋ 右侧图例（名称 ＋ 百分比）。
 *
 * 说明：⭐⭐ 环里的项是**类目组**（`d.groups` 按侧筛），⛔ 不是逐个账户 —— 账户的粒度由
 * 下面那块排行榜负责（两块回答的是不同问题）。
 * 图例**含 0 的项**（那是文字，不是图形）；环里 0 的项不画（`donutArcs()` 已滤）。
 */
function donutCardHtml(meta, d, sides) {
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
  return `<div class="lg-card">
    <div class="lg-ccap"><b>${esc(meta.now)}</b></div>
    <div class="lg-donut">
      <div class="lg-ring">
        <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
          <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
          <g transform="rotate(-90 ${mid} ${mid})">${arcs}</g>
        </svg>
        <div class="lg-ring-mid"><i>${esc(meta.center)}</i><b>${esc(fmtFen(total, state.lgHide))}</b></div>
      </div>
      <div class="lg-legend">${legend}</div>
    </div>
  </div>`;
}

/**
 * 功能：「资产 / 负债排行榜」—— 逐个账户：图标 ＋ 名称 ＋ 占比 ＋ 金额 ＋ 条 ＋ 备注。
 *
 * 说明：⭐ 粒度是**账户**（参考图里就是「现金」「备用微信号」这种账户名），与上面环形的
 * 「类目」粒度刻意不同。
 * 条长按 `|值| / 该侧合计`；合计为 0 时 `sharePct()` 回 `null` ⇒ 条宽 0、文字显示 `—`
 */
function rankCardHtml(meta, d, sides) {
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
  return `<div class="lg-card"><div class="lg-ccap"><b>${esc(meta.rank)}</b></div>
    <div class="lg-ranks">${body}</div></div>`;
}

/**
 * 功能：「当前净资产状况」—— 一条「资产 vs 负债」比例对比条 ＋ 四个数。
 *
 * 能画的只有"资产与负债各占多少"这条对比条。
 * 两边都是 0 ⇒ 画一条**空的灰条**（⛔ 不是一条 50/50 的假条 —— 那是编数据）；
 * 一段为 0 是合法的（只有资产没负债 ⇒ 负债那段宽 0，那是真事实）。
 */
function netPanelHtml(meta, d) {
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0, net_fen: 0 };
  const pair = ratioPair(t.asset_fen, t.debt_fen);
  const bar = pair
    ? `<div class="lg-nbar">
        <span class="a" style="width:${pair.asset_pct.toFixed(2)}%">${pair.asset_pct >= 14 ? '资产' : ''}</span>
        <span class="d" style="width:${pair.debt_pct.toFixed(2)}%">${pair.debt_pct >= 14 ? '负债' : ''}</span>
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
 * 功能：图表视图整块（三态控件 ＋ 走势 ＋ 构成/对比 ＋ 排行）。
 *
 *
 * @param {Object} d - `state.lg`
 * @param {Map.<string, string>} sides - 类型 → 侧
 */
function chartHtml(d, sides) {
  const meta = RANGES.filter((r) => r.key === rangeOf())[0] || RANGES[0];
  const rows = Array.isArray(d && d.snapshots) ? d.snapshots : [];
  // 这一串值要**留一份**给走势卡（点某个点时显示那一格的钱）——
  // 从前它只是一个实参，算完几何就没了。⚠️ 画布同时换成带纵轴的 `AXIS_BOX`。
  const series = trendSeries(rows, meta.key);
  const geo = trendGeometry(series, AXIS_BOX);
  const body =
    meta.key === 'net'
      ? netPanelHtml(meta, d)
      : `<div class="lg-cgrid">${donutCardHtml(meta, d, sides)}${rankCardHtml(meta, d, sides)}</div>`;
  // ：
  // 口径那一段**不再占屏顶一行**，改由 `trendCardHtml()` 画进那张卡里（见它里面的 `cap`）。
  // 别在这里又画一条 —— 画了就是两处都在（而且不报错）。
  return `${trendCardHtml(geo, series, d)}${body}`;
}

/**
 * 功能：切「资产 / 图表」两个视图。
 *
 * 说明：⭐ **只改 state 再重画，⛔ 不重新取数**（两个视图共用一份 `state.lg`）。
 *
 * @param {string} _act - 动作名（未用）
 */
export function lgTabPick(_act, n) {
  const k = String((n && n.dataset && n.dataset.tab) || '');
  state.lgTab = k === 'chart' ? 'chart' : 'asset';
  renderLedger();
}

/**
 * 功能：切图表的三态（资产 / 负债 / 净资产）—— 同一份数据换个口径看，同样⛔ 不重新取数。
 *
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-range` 取口径）
 * @returns {void}
 */
export function lgRangePick(_act, n) {
  const k = String((n && n.dataset && n.dataset.range) || '');
  state.lgRange = RANGES.some((r) => r.key === k) ? k : 'asset';
  renderLedger();
}

/**
 * 功能：点走势图上某一个点 ⇒ 在横轴下面那一行写「几月 · 多少钱」。
 *
 * 说明：⚠️⭐ 那笔钱是从**命中圈自己带的 `data-v`** 读的（画的时候就写进去了）——
 * 而那种错法**不报错**，只是显示成另一个月的钱。
 * 这里用**完整**的 `fmtFen()`（不是纵轴那种短写法）—— 用户点一个点问的是
 */
export function lgTrendDot(_act, n) {
  const card = n && n.closest ? n.closest('.lg-card') : null;
  const box = card && card.querySelector('.lg-tpick');
  if (!box) return;
  const lbl = String((n.dataset && n.dataset.lbl) || '');
  const fen = Math.trunc(Number((n.dataset && n.dataset.v) || 0)) || 0;
  box.textContent = [lbl, fmtFen(fen, state.lgHide)].join(' · ');
}

// ---------- 两步弹层：先选类型，再填表单 ----------

/**
 * 功能：开「类型选择」弹层 —— 八行带副标题（照参考图 B），点一行进表单。
 *
 * 九类里包含「负债」，写「添加资产」就是错的。
 *
 * @param {string} title - 弹层标题（新建时「添加账户」、改类型时「换个类型」）
 */
function pickSheet(title) {
  const rows = KIND_ORDER.map((k) => {
    const m = metaOf(k);
    return `<button class="lg-pick" type="button" data-act="lg-pick" data-kind="${k}">
      <span class="lg-ico" style="--lg-c:${m.color}">${m.icon}</span>
      <span class="lg-pick-main"><b>${esc(m.name)}</b>${m.hint ? `<i>${esc(m.hint)}</i>` : ''}</span>
    </button>`;
  }).join('');
  openSheet(title, `<div class="lg-picks">${rows}</div>`);
}

/**
 * 功能：给输入框里的值做一次「读回草稿」—— 保存前与换类型前都要做。
 *
 * 说明：⚠️⭐ 类型换成不需要「后四位」的那几类时，那个输入框是**藏起来**的 ——
 * 而用户根本没机会看见它）。
 * 选了具体一家就是那家，选「其它」才是文本框里那个，**没选（空串）一律当空**
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
 * 功能：画「所在银行 / 银行 · 平台」那颗下拉 —— 按 `optionsFor(kind)` 分组渲染。
 *
 * 说明：⚠️ 用**原生 `<select>`**（⛔ 不自画下拉），`.fld select` 那份样式文件里已经有了。
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
 * 功能：下拉换了值 —— 只切「自己填」那一格的显隐，⛔ 不重画弹层（重画会把别的字段与光标一起抹掉）。
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

/** `#sheet-body` 的 change 委托只挂一次（弹层容器是**常驻节点**，每次开弹层都挂一遍会叠加） */
let bankBound = false;

/**
 * 功能：挂弹层内容容器上的**非 click** 委托（`change` ＋ `input`，**只挂一次**）。
 *
 * 说明：⭐ 手机端这几处**不走 `mobile/app.js` 的 `ACTIONS` 表**：那张表派发的是 **click**，
 * 而 `<select>` 换值只发 `change`、打字只发 `input` —— 宿主那层两个通道都没有，
 * 要加就得改 `mobile/app.js`，而那不属于本模块（铁律 11）。⇒ 本模块自己挂在弹层内容容器上，
 */
function bindPickChange() {
  if (bankBound) return;
  const body = $('#sheet-body');
  if (!body) return;
  bankBound = true;
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return undefined;
    if (t.id === 'lg-f-pick') return pickFollow(String(t.value || ''));
    if (t.dataset && t.dataset.tagview && String(t.value) === '__new__') return askNewTag(t);
    return undefined;
  });
  body.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || t.id !== 'lg-ed-note') return undefined;
    // 顺手把草稿里那一格也跟上（用户可能直接点「完成」，那时不会再有 change/click 帮我们读）
    if (state.lgDraft) state.lgDraft.note = String(t.value || '');
    paintNoteChips();
    return undefined;
  });
}

/**
 * 功能：把表单那一整块画出来（含「类型」那一行的入口）。
 *
 * 形态由 `pickShapeOf()` 一次算清 —— `#lg-f-name` 这个 id 与 `d.name` 的语义**都没变**
 * （`captureForm()` 还是从它读），⛔ 别改 id、⛔ 别改字段名。
 * 本端换类型是**整块重画**（`lgPick()` → `formSheet()`），所以形态与回填都在这里一次画对，
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
function formFieldsHtml(d) {
  const m = metaOf(d.kind);
  const shape = pickShapeOf(d.kind, d.name);
  return `<button class="lg-type-row" type="button" data-act="lg-retype">
      <span class="lg-ico" style="--lg-c:${m.color}">${m.icon}</span>
      <span class="lg-type-name">${esc(m.name)}</span><em>换个类型</em>
    </button>
    <label class="fld${shape.needPick ? '' : ' hidden'}" id="lg-f-pickwrap">
      <span>${esc(m.nameLabel)}</span>${pickSelectHtml(d.kind, shape.select)}</label>
    <label class="fld${shape.nameHidden ? ' hidden' : ''}" id="lg-f-namewrap">
      <span id="lg-f-namelabel">${esc(shape.needPick ? '自己填' : m.nameLabel)}</span>
      <input id="lg-f-name" type="text" maxlength="${NAME_MAX}" value="${esc(shape.value)}" /></label>
    <label class="fld${needTailOf(d.kind) ? '' : ' hidden'}" id="lg-f-tailwrap">
      <span>${esc(tailLabelOf(d.kind))}（可以空着）</span>
      <input id="lg-f-tail" type="text" maxlength="4" inputmode="numeric" value="${esc(d.tail)}" /></label>
    <label class="fld${needLimitOf(d.kind) ? '' : ' hidden'}" id="lg-f-limitwrap">
      <span>分级（可以空着）</span>
      ${tierSelectHtml(d.tier)}
      <div class="lg-limits-cap">限额不填就是不限</div>
      <div class="lg-limits">
        <div><span>日限额</span>
          <input id="lg-f-limd" type="text" inputmode="decimal" value="${esc(d.limitDay)}" /></div>
        <div><span>月限额</span>
          <input id="lg-f-limm" type="text" inputmode="decimal" value="${esc(d.limitMonth)}" /></div>
        <div><span>年限额</span>
          <input id="lg-f-limy" type="text" inputmode="decimal" value="${esc(d.limitYear)}" /></div>
      </div></label>
    <label class="fld"><span>备注（可以空着）</span>
      <input id="lg-f-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" /></label>
    ${tagFieldsHtml(d)}
    <label class="fld"><span>余额</span>
      <input id="lg-f-opening" type="text" inputmode="decimal" value="${esc(d.opening)}" /></label>
    <div class="m-tip">账户初始化余额</div>`;
}

/**
 * 功能：开「表单」弹层 —— 新建与编辑**共用同一个函数**（⛔ 别各写一份）。
 *
 * 说明：⚠️ 编辑时底部多一颗「删除」（危险确认在 `lgDel` 里）。
 *
 * @param {Object} d - 草稿
 */
function formSheet(d) {
  const editing = Number(d.id) > 0;
  // 银行下拉的 change 委托在这里保证「挂过一次」（它挂在常驻的 `#sheet-body` 上，见 `bindPickChange()`）
  bindPickChange();
  openSheet(
    editing ? '改这个账户' : '添加账户',
    formFieldsHtml(d),
    editing
      ? `<button class="btn danger" type="button" data-act="lg-del" data-id="${Number(d.id)}">删除</button>` +
          `<button class="btn primary" type="button" data-act="lg-save" data-id="${Number(d.id)}" style="flex:1.4">保存</button>`
      : `<button class="btn primary" type="button" data-act="lg-save" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：「＋ 添加账户」—— 从空的草稿开始走两步。
 * @returns {void}
 */
export function lgNew() {
  draft = null;
  pickSheet('添加账户');
}

/**
 *
 * 说明：⭐⭐ 与电脑端同一套（留白事件 `zx:ai-proposal-edit`）：AI 只把 `{kind, items}` 交出来，
 */
export function bindAiProposalEdit() {
  if (bindAiProposalEdit._bound) return;
  bindAiProposalEdit._bound = true;
  document.addEventListener('zx:ai-proposal-edit', (e) => {
    const d = e && e.detail;
    if (!d || String(d.kind || '') !== 'ledger_proposal') return;
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) return;
    d.handled = true;
    const it = items[0] || {};
    const at = String(it.at == null ? '' : it.at);
    void lgEntryAdd({
      ie: String(it.ie || '') === '收入' ? '收入' : '支出',
      amount: it.amount == null ? '' : String(it.amount),
      catId: Number(it.category_id) || 0,
      acctId: Number(it.account_id) || 0,
      note: it.note == null ? '' : String(it.note),
      // `datetime-local` 要的形状；形状不对就给空串（让用户自己填，⛔ 不拼一个"看着像"的时刻）
      dt: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(at) ? `${at.slice(0, 10)}T${at.slice(11, 16)}` : '',
    }).then(() => {
      if (items.length > 1) toast(`这张卡有 ${items.length} 笔，先给你开了第一笔`);
    });
  });
}

/**
 * @returns {void}
 */
export function lgRetype() {
  if (!draft) return;
  captureForm(draft);
  pickSheet('换个类型');
}

/**
 * 功能：在类型选择页选了某一类 ⇒ 建 / 更新草稿并进表单。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（读 `data-kind`）
 * @returns {void}
 */
export function lgPick(_act, n) {
  const kind = String((n && n.dataset && n.dataset.kind) || '');
  if (!KIND_ORDER.includes(kind)) return;
  // 空草稿必须写成**一行**：`ttt/test/ledger.test.js` 拿源码形状钉住它（对象字面量一行写完，
  // 且里面必须带 `tier` / `limitDay` / `limitMonth` / `limitYear` 四个键）—— 拆成多行
  // 别为了"排版好看"把它摊开：这里 pin 的是「新账户草稿里有哪几个键」，不是排版。
  const d = draft || { id: 0, kind, name: '', tail: '', note: '', opening: '', tier: '', limitDay: '', limitMonth: '', limitYear: '', tags: {} };
  d.kind = kind;
  draft = d;
  formSheet(d);
}

/**
 * @param {Object} _act - 动作名（未用）
 * @param {Object} _n - 触发按钮（未用）
 * @param {Function} id - 取 `data-id` 的函数
 */
export function lgEdit(_act, _n, id) {
  const rid = Number(id());
  const a = ((state.lg && state.lg.accounts) || []).find((x) => Number(x.id) === rid);
  if (!a) return;
  draft = {
    id: Number(a.id),
    kind: a.kind,
    name: a.name,
    tail: a.tail,
    note: a.note,
    opening: fenToInput(a.opening_fen),
    tier: String(a.tier || ''),
    limitDay: a.limit_day_fen == null ? '' : fenToInput(a.limit_day_fen),
    limitMonth: a.limit_month_fen == null ? '' : fenToInput(a.limit_month_fen),
    limitYear: a.limit_year_fen == null ? '' : fenToInput(a.limit_year_fen),
    tags: a.tags || {},
  };
  formSheet(draft);
}

/**
 * 功能：保存（新建或编辑）—— ⛔ 金额的**格式校验交给服务端**（那是唯一一份判据）。
 *
 * 说明：⚠️ 只做「名称不能空」这一条本地前置检查：它是**表单语义**（空的表单不该发出去），
 * 不是判据的复制。金额串原样发上去，服务端判不过就 400，那句文案原样弹给用户。
 *
 */
export async function lgSave() {
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
    closeSheet();
    draft = null;
    await loadLedger();
    toast(editing ? '改好了' : '记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 *
 * 说明：⚠️ 不写这句的危险：用户删完发现图表没变，会当成 bug 来报。
 */
export function lgDel(_act, _n, id) {
  const rid = Number(id());
  if (!rid) return;
  askConfirm({
    title: '删除这个账户？',
    // ：这条文案**变了事实** —— 1 期删账户会连带删掉转账明细，2 期
    // **一条都不删**（记账 / 转账 / 调整都留着，账户名按删除时的原名留档，
    // 见 `modules/ledger/store.js` 的 `ledgerDeleteAccount`）。
    text:
      '删了就找不回来了。⚠️ 历史净值不会被改写 —— 那些天记下的是「你当时有多少钱」，删一个账户不会把它改掉。' +
      '✅ 它名下的记账 / 转账 / 调整记录都会保留（记的是"那笔钱确实动过"这件事）；' +
      '只是从今往后这一屏不再列它，那些记录里的账户名也不再随它改名。',
    ok: '永久删除',
    danger: true,
  }).then((ok) => {
    if (ok) lgDeleteGo(rid);
  });
}

/**
 * 功能：真的删（确认之后走这里）。
 * @param {number} rid - 账户 id
 * @returns {Promise.<void>}
 */
async function lgDeleteGo(rid) {
  try {
    await api('DELETE', `/api/ledger/accounts/${Number(rid)}`);
    draft = null;
    // 删除是从**详情屏**发起的 ⇒ 那两屏的临时态（看哪个账户 / 明细）要一起清掉：
    // 不清的话手上那份明细还挂着「刚刚被删掉的那个账户」，而这一屏正停在它上面。
    state.lgAcct = 0;
    state.lgChg = [];
    state.lgChgCursor = null;
    state.lgChgDone = false;
    state.lgChgLoad = 'idle';
    state.lgChgErr = '';
    state.lgChgMonth = '';
    // 2 期：删完账户**先刷新取名口**（它刚进删除记录表 ⇒ 它的原名从这一刻起只能从这里取），
    // 再重取一屏。⚠️ 顺序反了的话，这一屏画出来的是"没有它名字的那一版"，而且**不报错**。
    await ensureAcctNames();
    await loadLedger();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

// ============================================================================
// 记账 3 期：明细屏 / 账单屏 / 月详情页 / 预算屏
// 手机端与电脑端**逐字同一条口径**：两端各画一份视图，

// ---------- 共用的两个小口子 ----------

/**
 * 功能：**服务端今天**（`YYYY-MM-DD`）—— 期间起点、周档的「当前自然周」都要用它。
 *
 * 说明：⭐⭐ 「今天」**只认服务端那一份**（`overview.today`，/ C-3）：手机日期不可信
 * 「本周」在两台设备上是两周，而它**不报错**。⛔ 别在本文件里另开一个日期来源。
 * 还没取到 overview 时是空串 ⇒ 各调用方按三态画错误块（⛔ 不猜一个日期出来）。
 */
function todayOf() {
  return String((state.lg && state.lg.today) || '');
}

/**
 * 功能：子屏（账单屏 / 月详情页）**自带的「‹ 返回」头**。
 *
 * 说明：⭐ 手机端的历史栈只认「底部标签」那一层（`syncHistory()` 只压 `#tab`）——
 * 账户详情屏也是**屏内自带返回**的同款做法 ⇒ 这两个子屏照它办，
 * 不去改宿主的 hash 机制。
 */
function subHeadHtml(act, title) {
  return `<div class="lg-xhead">
    <button class="lg-xback" type="button" data-act="${esc(act)}" aria-label="返回">‹</button>
    <b>${esc(title)}</b>
  </div>`;
}

/**
 * 功能：「读不到 ＋ 重试」那一块（三态里的 error）—— ⛔ 绝不画成空态。
 * @param {string} what - 读的是什么（「流水」/「账单」/「这个月的账单」/「预算」）
 * @param {string} msg - 失败原因（用户能看的那句话）
 * @param {string} act - 重试那颗按钮的动作名
 * 月详情 / 预算那两处**必须**带上（重试时动作要知道"重取哪一期"），
 */
function errBoxHtml(what, msg, act, attrs) {
  return `<div class="err-box"><b>${esc(what)}没读到</b><p>${esc(msg || '原因不明')}</p>
    <button class="chip on" type="button" data-act="${esc(act)}"${attrs || ''} style="margin-top:14px">重新加载</button></div>`;
}

// ---------- ① 明细屏（图 1 / 图 8） ----------

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
 * 搜索那一行里那颗「收起」—— 细线 ✕（把**就地展开**的搜索框收回去）。
 * @type {string}
 */
const ICO_CLOSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4"/></svg>';

/**
 * 明细屏那一行工具条**是不是正开在搜索上**（内存态，⛔ 不落库、⛔ 不挂 DOM class）。
 *
 */
let searchOn = false;

/**
 * 功能：明细屏工具行里**就地展开**的那个搜索框（`#lg-search-q`）。
 *
 * 说明：⚠️ 它顶掉的是原来那个「撑开左右两头的空格」（`.lg-dtools-sp`）—— 开着搜索时那一行是
 * `AI 圆环 ｜ 输入框 ｜ ✕`（⛔ 不再画日历那颗，把宽度让给输入框）。
 * 输入框的 id / 类名（`lg-search-q` / `lg-sinput`）**沿用弹层版那一套** ——
 */
function searchInlineHtml() {
  return (
    '<div class="lg-sinline">' +
    '<input class="lg-sinput" id="lg-search-q" type="text" autocomplete="off" aria-label="搜索关键字">' +
    '</div>'
  );
}

/**
 * 功能：明细屏顶部那一行工具条（AI 圆环 ＋ 搜索 / 收起 ＋ 日历）。
 *
 * 三颗图标仍是**零出网**的（AI 派事件切屏、日历派事件切屏、搜索只打记账自己的接口）。
 * @returns {string} 那一行的 HTML
 */
function dtoolsHtml() {
  const aiBtn =
    '<button class="lg-ai" type="button" data-act="lg-ai-help" aria-label="AI 助手">' + ICO_AI + '</button>';
  const searchBtn =
    '<button class="lg-dico" type="button" data-act="lg-search" aria-label="' +
    (searchOn ? '收起搜索' : '搜索') +
    '">' +
    (searchOn ? ICO_CLOSE : ICO_SEARCH) +
    '</button>';
  const calBtn = searchOn
    ? ''
    : '<button class="lg-dico" type="button" data-act="lg-go-cal" aria-label="日历">' + ICO_CAL + '</button>';
  const mid = searchOn ? searchInlineHtml() : '<span class="lg-dtools-sp"></span>';
  return '<div class="lg-dtools">' + aiBtn + mid + searchBtn + calBtn + '</div>';
}

/**
 * 功能：把就地展开的搜索框接上（防抖输入 / 回车立刻搜）——⚠️ **每次重画都要重接一次**。
 *
 * 说明：⚠️⭐ 那个输入框是随这一屏**现造**的（`renderLedger()` 每次 `innerHTML=` 换骨头）
 * ⇒ 监听器绑在上一份节点上就随它一起没了。所以每一趟画完明细屏、只要开着搜索就要重接
 * （⛔ 别绑在委托层上：`#lg-search-q` 是个动态节点，宿主那张动作表够不着它）。
 */
function bindSearchInput() {
  const inp = $('#lg-search-q');
  if (!inp) return;
  inp.addEventListener('input', () => searchInputChanged(inp.value));
  inp.addEventListener('keydown', (e) => {
    // 回车 ⇒ 立刻搜（不等防抖那 250ms）
    if (e.key === 'Enter') {
      e.preventDefault();
      searchInputChanged(inp.value, true);
    }
  });
}

/**
 * 功能：画「明细」那一屏（版式权威 = 参考图 1 / 图 8）。
 *
 * ① 顶部**工具行**：左侧 AI 圆环、右侧放大镜与日历 —— ⭐ **三颗都只弹一句
 * 「开发中，敬请期待~」、⛔ 一个请求都不发**（记账是**零出网**模块）；
 * ③ **当月合计**：收入 / 支出两个数（**不带符号**、两位小数，**由服务端 `summary` 给**）
 */
function detailScreenHtml() {
  const cur = monthKey();
  const s = state.lgSum || null;
  // 合计还没到手（首次读取中 / 读不到）⇒ 画 `—`：⛔ 不画 0.00（那是"这个月一分没有"，
  // 而真相是"还没读到"——三态必须分得开）。金额一律 `fmtFen`（掩码只住它一处）。
  const money = (fen) => (s ? esc(fmtFen(fen, state.lgHide)) : '—');
  // 容器类名是 `.lg-dpane`（**不是** `.lg-detail`）—— 那个名字已经被**账户详情屏**
  // 占了（`lgDetailHtml()` 那一屏用 `.lg-detail` / `.lg-dhead` / `.lg-dcard`）。
  // 两屏共用一个类名 ⇒ 给这边加的版式会顺手套到那边（而画面上只表现为"详情屏忽然变窄了"，
  const list = searchOn
    ? '<div class="lg-sres" id="lg-search-out"><div class="lg-txwait">输入关键字开始搜。</div></div>'
    : entryGroupsHtml() + entryMoreHtml();
  return `<div class="lg-dpane">
    ${dtoolsHtml()}
    <div class="lg-dsum">
      <button class="lg-dmonth" type="button" data-act="lg-month-pick">${esc(monthLabel(cur))} ▾</button>
      <div class="lg-dsum-cols">
        <div><span>收入</span><b>${money(s ? s.income_fen : 0)}</b></div>
        <div><span>支出</span><b>${money(s ? s.expense_fen : 0)}</b></div>
 <!-- ⭐ 0.8.9 修订（「移除所有的退款红色字体」）—— 与电脑端同款：
             这张卡上**不再有**「退款」那一栏；退款只在它退的那一笔原消费那一行露面。 -->
      </div>
      ${eyeHtml()}
    </div>
    <div class="lg-elist">${list}</div>
  </div>`;
}

/** ⭐ AI 那个「会话对象」在对话模块里的键（= `modules/ai/shared.js` 的 `AI_CONV_KEY`）。
 *  ⚠️ 跨模块契约：那边改了这里也要改（改错了的表现是「跳过去停在对话列表」且**不报错**）。 @type {string} */
const AI_CONV_SLOT = 'ai';

/**
 *
 * 说明：⭐⭐ 「第一个双圆环的：点击跳转到对话中的 AI 助手对话界面」。
 */
export function lgAiHelp() {
  document.dispatchEvent(new CustomEvent('zx:open-module', { detail: { mod: 'teamwork', slot: AI_CONV_SLOT } }));
}

/**
 *
 * ⇒ 这一颗从 `{ mod: 'calendar' }` 改成 `{ mod: 'home', slot: 'calendar' }`
 */
export function lgGoCal() {
  document.dispatchEvent(new CustomEvent('zx:open-module', { detail: { mod: 'home', slot: 'calendar' } }));
}

/**
 *
 * 从前它开的是**底部弹层**（`openSheet()`）；现在改成**就在工具行里展开**一个输入框，
 */
export function lgSearch() {
  searchOn = !searchOn;
  // 换了模式就把**在飞的那一次搜索**作废（序号一推，旧响应回来对不上号就自己丢掉）
  state.lgSearchSeq = Number(state.lgSearchSeq || 0) + 1;
  renderLedger();
  if (!searchOn) return;
  const inp = $('#lg-search-q');
  if (inp && typeof inp.focus === 'function') inp.focus();
}

/** 搜索输入的防抖定时器（`0` = 空闲）。 @type {number} */
let searchTimer = 0;

/**
 * 功能：搜索框内容变了 —— 防抖 250ms 再发请求（打字过程中**不发**）。
 *
 * 说明：⚠️ 每次请求都往 `state.lgSearchSeq` 上盖一个序号，回来时对不上就**丢掉** ——
 * 打字快的时候上一个请求可能后到，不丢的话会把**旧关键字**的结果画在新结果上，
 * 而界面看起来完全正常（一个不报错的错）。
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
 * 功能：把搜索结果画进 `#lg-search-out`（⭐ **就地重画那一块**，⛔ 不整屏重画）。
 * @param {?Object} d - `{ loading }` / 服务端的 `search` 对象 / `null`（空关键字）
 * @param {string} err - 失败原因（非空 ⇒ 画「读不到」）
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
 * 功能：搜索结果里的一行 —— `日期 ｜ 分类 · 备注 ｜ 金额`。
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

// ---------- 月份选择弹层（图 8） ----------

/** 选月弹层里正在选的**年**（`0` = 还没开过弹层）。 ⚠️ 只活在这一次弹层里，⛔ 不进 state。 @type {number} */
let mpYear = 0;

/** 选月弹层里正在选的**月**（`1~12`）。 ⚠️ 同上。 @type {number} */
let mpMonth = 0;

/**
 * 功能：选月弹层里「年」那一列有哪些年 —— **连续区间**（已知年 ∪ 今天，前后各补 5 / 1 年）。
 *
 * ⇒ 导入进来的 2024 / 2025 年才选得到。⛔ 光靠 `entryMonthOptions()` 不行：那份清单是从
 * 「手上这一页流水」推的，而流水一次只加载一个月。
 * 而去年没记账就翻不过去，所以改成与电脑端同一份 `pickerYears()`：区间**连续**、
 */
function mpYears() {
  const known = [];
  for (const y of (state.lgPeriods && state.lgPeriods.years) || []) known.push(String(y));
  // 再并上「手上这一页流水」推出来的年当兜底（期间清单取不到时不能只剩今天那一年）
  for (const k of entryMonthOptions()) known.push(String(k).slice(0, 4));
  // **连续区间**（已知年 ∪ 今天，前后各补 5 / 1 年）—— 与电脑端同一口径。
  return pickerYears(known, todayOf());
}

/**
 * 功能：选月弹层里「月」那一列 —— **恒为 12 项**（`MONTHS_ALL`）。
 *
 * 只记过一次账的人，滚轮里就只有一个 `11`，别的月根本点不到（而且不报错）。
 * 现在与「年」解耦：**月永远是 1~12**，挑到没记账的月看到的是明细屏的空态那句话。
 * @returns {Array.<number>} 月份（`1~12`，升序）
 */
function mpMonths() {
  return MONTHS_ALL;
}

/** 功能：选月弹层里那一列（年 / 月）的整体 HTML。 @param {string} kind - `'year'` | `'month'` @returns {string} @since */
function mpColHtml(kind) {
  const year = kind === 'year';
  const cur = year ? mpYear : mpMonth;
  const vals = year ? mpYears() : mpMonths();
  const body = vals
    .map((v) => {
      const label = year ? String(v) : String(v).padStart(2, '0');
      return `<button class="lg-mpick-i${Number(cur) === v ? ' on' : ''}" type="button" role="option"
        aria-selected="${Number(cur) === v}" data-act="lg-month-sel" data-kind="${kind}" data-v="${v}">${label}</button>`;
    })
    .join('');
  return `<div class="lg-mpick-col" id="lg-mp-${year ? 'years' : 'months'}" role="listbox"
    aria-label="${year ? '年' : '月'}">${body}</div>`;
}

/**
 * 功能：点明细屏那颗年月 ⇒ 开「选择月份」底部弹层（图 8：`取消` ｜ 标题 ｜ `确定` ＋ 年· 月两列滚轮）。
 *
 * 说明：⚠️ 两列是**可点的列**（不是原生 `<select>`）：版式要的是图 8 那种「两列并排、选中加粗」，
 * 而 `确定` 那一下才真的换月（`lg-month-ok`）—— 点中间任何一列**不换数据**。
 * 初值 = 当前正在看的那个月（`monthKey()`），不是"今天"（用户翻到 7 月再点开，
 */
export async function lgMonthPick() {
  // 修：**先把「有记录的期间」取到手再开弹层** —— 那两列的候选就住它里面
  // （`mpYears()` 的已知年）。不先取的话，弹层里只剩「今年」那一年，
  // 用户点了也切不动（而它**不报错**）。已经取过就是一次空跑（`loadPeriods()` 自己挡）。
  await loadPeriods();
  const cur = monthKey();
  mpYear = Number(cur.slice(0, 4)) || Number(todayOf().slice(0, 4)) || 0;
  mpMonth = Number(cur.slice(5, 7)) || Number(todayOf().slice(5, 7)) || 1;
  const months = mpMonths();
  if (!months.includes(mpMonth)) mpMonth = months[0] || mpMonth;
  openSheet(
    '选择月份',
    `<div class="lg-mpick">${mpColHtml('year')}${mpColHtml('month')}</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-month-ok" style="flex:1.4">确定</button>`,
  );
}

/**
 * 功能：选月弹层里点了某一列的一项（⚠️ 只改选择、**不换数据、不关弹层**）。
 *
 * 说明：⚠️⭐ 只做两件小事：① 记住选中的年 / 月；② 就地改那两列的 `.on`（⛔ 不重画整个弹层 ——
 * 换年不必重画月列，只校正选中态。
 * @param {string} _act - 动作名（未用）
 */
export function lgMonthSel(_act, n) {
  const kind = String((n && n.dataset && n.dataset.kind) || '') === 'year' ? 'year' : 'month';
  const v = Number((n && n.dataset && n.dataset.v) || 0);
  if (kind === 'year') {
    if (!v || v === mpYear) return;
    mpYear = v;
    // 月列恒 12 项 ⇒ 换年**不再重画月列**（重画会把月列的滚动位置弹回顶部，
    // 而候选根本没变）。下面统一那段 `.on` 校正会把选中态标对。
  } else if (v >= 1 && v <= 12) {
    mpMonth = v;
  }
  const root = $('#lg-mp-years');
  const scope = root ? root.parentNode : null;
  if (!scope) return;
  for (const b of scope.querySelectorAll('[data-act="lg-month-sel"]')) {
    const k = String(b.dataset.kind || '') === 'year' ? 'year' : 'month';
    const val = Number(b.dataset.v) || 0;
    b.classList.toggle('on', (k === 'year' ? mpYear : mpMonth) === val);
    b.setAttribute('aria-selected', String((k === 'year' ? mpYear : mpMonth) === val));
  }
}

/**
 * 功能：选月弹层那颗「确定」⇒ 换月并**重新取一次流水**。
 *
 * 说明：⭐⭐ 换月**必须重取**（`loadEntries(true)`）：那个月的数据根本不在手上
 * （⛔ 不是"从手上这份里筛"—— 手上只有当前这一页 30 条，筛出来永远只有一小截）。
 * 选中的还是同一个月 ⇒ **不重取**（关掉弹层就好，别白跑一趟、也别把列表滚回顶部）。
 */
export async function lgMonthOk() {
  const key = `${mpYear}-${String(mpMonth).padStart(2, '0')}`;
  closeSheet();
  if (!/^\d{4}-\d{2}$/.test(key) || key === monthKey()) return;
  state.lgMonth = key;
  await loadEntries(true);
}

// ---------- ② 账单屏（图 2） ----------

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
 * 功能：月账单那颗「年份」下拉里的年份 —— **服务端给过的年 ∪ 今天那一年**（降序）。
 *
 * 说明：⚠️⭐ 服务端**没有**一条「有记账的年」的接口给前端（`bill` 的 `year` 档表格里有，
 * 但那一档不在这里）⇒ 年份只能取手上**已有**的那一份：`overview.years`
 * （＝ 服务端算的「今年 ∪ 有过快照的年」，与资产图表那颗年份下拉**同一个来源**）。
 */
function billYears() {
  const known = [];
  // 主来源换成服务端的 `/api/ledger/periods`（`state.lgPeriods.years`）——
  // 它含**三方导入**的行 ⇒ 从鲨鱼记账导进来的 2024 / 2025 年在这儿才选得到
  // （`state.lg.years` 只从**快照**推，导入的年进不去 ——
  for (const y of (state.lgPeriods && state.lgPeriods.years) || []) known.push(String(y));
  for (const y of (state.lg && state.lg.years) || []) known.push(String(y));
  known.push(String(state.lgBillKey || '').slice(0, 4));
  // 与「选择月份」同一口径 —— **连续区间**（已知年 ∪ 今天，前后各补 5 / 1 年）。
  // 只列"有记账的年"时，一整年没记账的年份选不到（与电脑端同一条）。
  return pickerYears(known, todayOf()).sort((a, b) => b - a);
}

/**
 *
 * 说明：⭐ 行上没有 `label`（服务端刻意不下发文案，见 `sliceShape()`）：`key` 是该子期的
 */
function billRowLabel(periodType, key) {
  const s = String(key || '');
  if (periodType === 'year') return `${s.slice(0, 4)}年`;
  // 周档一行 = 某一周 ⇒ 写清这一周是哪几天到哪几天（「本周」只有一个）。
  if (periodType === 'week') return weekRangeLabel(s);
  return `${Number(s.slice(5, 7))}月`;
}

/**
 * 功能：账单这一档「当前该看哪一期」的键 —— ⚠️ **周档与月档是同一个形状**（该月 1 号）。
 *
 * 与月档**完全同形**（`YYYY-MM-01`），两者只是「表格怎么摊」不同（月 → 12 个月 /
 * 周 → 该月各周）。年档照旧 `YYYY-01-01`。
 * 这里**不能**直接用 `periodKeyOf('week', ...)` —— 那给的是**周一**（预算那一档的形状），
 */
function billKeyOf(type) {
  return periodKeyOf(type === 'week' ? 'month' : type, todayOf());
}

/**
 * 功能：账单屏当前这一期的 `period_key` —— 用户选过（`state.lgBillKey`）就用他选的。
 * @returns {string} 该期起始日 `YYYY-MM-DD`（取不到服务端今天时为空串 ⇒ 这一屏落进「读不到」）
 */
function billPeriodKey() {
  return String(state.lgBillKey || '') || billKeyOf(billTabOf());
}

/**
 *
 * 说明：⭐ 「要能看到本月内的所有周，并且通过 `‹ 月份 ›` 切换月」。
 */
function billMonthSwitchHtml() {
  const raw = String(state.lgBillKey || '');
  const cur = /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 7) : String(todayOf()).slice(0, 7);
  return `<div class="lg-bmon">
    <button class="lg-bmonbtn" type="button" data-act="lg-bill-shift" data-delta="-1" aria-label="上一个月">‹</button>
    <b>${esc(`${cur.slice(0, 4)}年${cur.slice(5, 7)}月`)}</b>
    <button class="lg-bmonbtn" type="button" data-act="lg-bill-shift" data-delta="1" aria-label="下一个月">›</button>
  </div>`;
}

/**
 *
 * 说明：⚠️ 换月 = 换**期** ⇒ 要重新取数（新那个月的周根本不在手上）。
 */
export async function lgBillShift(_act, n) {
  const delta = Number((n && n.dataset && n.dataset.delta) || 0);
  if (!delta) return undefined;
  const cur = String(billPeriodKey()).slice(0, 7) || String(todayOf()).slice(0, 7);
  const next = shiftMonth(cur, delta);
  if (!/^\d{4}-\d{2}$/.test(next) || next === cur) return undefined;
  // 夹的是**年份区间**（与「选择月份」同一口径），⛔ 不再是「有数据的月」区间 ——
  const yrs = pickerYears((state.lgPeriods && state.lgPeriods.years) || [], todayOf());
  if (yrs.length) {
    const lo = `${yrs[0]}-01`;
    const hi = `${yrs[yrs.length - 1]}-12`;
    if (next < lo || next > hi) return undefined;
  }
  state.lgBillKey = `${next}-01`;
  if (subTabOf(state.lgBillTab2) === 'chart') return loadChart();
  return loadBill();
}

/**
 * 功能：取一次账单屏一屏（`GET /api/ledger/bill`）并重画 —— **三档共用**（靠 `period_type` 分派）。
 *
 * 说明：⭐⭐ `period_key` 由前端按**服务端今天**折出来（`periodKeyOf()`）；用户换过年
 * （月档那颗下拉）时用他选的那一年 ⇒ `state.lgBillKey`。⚠️ `period_key` 是**必填**
 * （服务端 400 而不是替你猜），所以 `today` 为空时这一屏就是**读不到**（三态里的 error），
 */
async function loadBill() {
  // ：**进账单屏时顺手取一次
  // 期间清单**（`/api/ledger/periods`）—— 年份下拉的主来源就是它的 `years`
  // （它含**三方导入**的年；`state.lg.years` 只从快照推、导入的年进不去）。
  if (!state.lgPeriods) loadPeriods();
  state.lgBillLoad = 'loading';
  state.lgBillErr = '';
  renderLedger();
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
  renderLedger();
}

/**
 * 功能：进账单屏（明细屏那颗「账单」）—— ⭐ 是**新屏**（T34），回来走屏内自带的「‹ 返回」。
 *
 * 说明：⚠️⭐ 手机端的历史栈只认「底部标签」那一层 ⇒ 这里**不压历史栈**（账户详情屏同款：
 * 屏内自带返回头）。⚠️ 它同时是「读不到」那颗重试的落点（再点一次就是重取）。
 * @returns {Promise.<void>}
 */
/**
 */
async function openBill() {
  state.lgMdMonth = 0;
  await loadBill();
}

// ============================================================================
// ：**图表** —— 内嵌在「明细」与「账单」里的那个视图
//
// 功能：「明细和账单有自己的图表（图表功能不是独立的），通过**药丸开关**
// 切换」⇒ 两屏各自一颗药丸 `列表 ｜ 图表`（默认列表）；切到「图表」＝按**期间**（周 / 月 / 年）

/**
 * 功能：图表**当前该看哪一期** —— ⭐ 就是**账单自己的三档与年份**（`lgBillTab` / `lgBillKey`）。
 *
 * 「同一套图，**期间选择与账单的三档联动**」现在是**唯一**一条路：
 * 在账单上切到「周账单」，它的图表就是**这一周**的图。
 * @returns {{type: string, key: string}} 该期的档与键（`key` 空串 = 还没选，按服务端今天算）
 */
function chartCtxOf() {
  return { type: billTabOf(), key: String(state.lgBillKey || '') };
}

/**
 * 功能：取**期间清单**（第二行那些候选）—— ⭐ 只取一次（`state.lgPeriods` 有了就不重复取）。
 *
 * 说明：⭐⭐ 这份清单是**服务端**给的（`/api/ledger/periods`）：有数据的年 / 月 / 周
 * 失败**不打扰用户**（第二行少几颗候选而已，图本身照画）：拿不到就保持 `null`。
 * @returns {Promise.<void>}
 */
async function loadPeriods() {
  // 已经取过就**直接返回**（它现在有三处调用方：图表 / 导出页 / 选月弹层，
  // 每进一格都重拉一遍是白跑的请求）。⚠️ 失败时 `lgPeriods` 仍是 `null` ⇒ 下次还会再试。
  if (state.lgPeriods) return;
  try {
    const r = await api('GET', '/api/ledger/periods');
    state.lgPeriods = (r && r.periods) || null;
  } catch (_e) {
    state.lgPeriods = null;
  }
  renderLedger();
}

/**
 * 功能：取**图表一屏**（折线 ＋ 两个数 ＋ 排行榜）。
 *
 * 说明：⚠️ 顺手把期间清单也拉一次（不 `await`：它是第二行的事，图不等它）。
 * 三态与账单屏同款（读取中 / 读不到 ＋ 重试 / 这一期没有数据）。
 * @returns {Promise.<void>}
 */
async function loadChart() {
  if (!state.lgPeriods) loadPeriods();
  state.lgChartLoad = 'loading';
  state.lgChartErr = '';
  renderLedger();
  const ctx = chartCtxOf();
  const key = ctx.key || billPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/chart?dir=${encodeURIComponent(chartDirOf(state.lgChartDir))}` +
        `&period_type=${encodeURIComponent(ctx.type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgChart = (r && r.chart) || null;
    // 服务端回的 `period_key` 才是权威（它校验过、也归过一）⇒ 记回**当前屏那一份** state
    state.lgBillKey = String((state.lgChart && state.lgChart.period_key) || key);
    state.lgChartLoad = 'done';
  } catch (e) {
    state.lgChart = null;
    state.lgChartLoad = 'error';
    state.lgChartErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：画**折线**（期间走势）—— ⭐ 几何走共用的 `trendGeometry()`（⛔ 不自己算坐标）。
 *
 * 说明：⚠️ 缺口（还没到的日子 / 那一格没数据）是 `null` ⇒ 线在缺口处**断开**、不画点
 * （1 期那六条判据的第一条）；⭐ **最后一个点画空心圈**（参考图里就是它）。
 * 右上角那个**最大值**来自服务端（`max_fen`），横轴标签走 `chartAxisOf()`。
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
 * 功能：画**排行榜**（支出 / 收入各分类）—— 图标 ＋ 名称 ＋ 占比 ＋ 金额 ＋ 进度条。
 *
 * 说明：⭐ 占比走 **`sharePct()`**（共用比例函数）＋ **`fmtPct()`**（`<0.1%` 那条判据住它那里）；
 * **金额为 0 的桶不画条**（`sharePct` 对 0 给 0，条宽就是 0 —— 但服务端已经
 * 把 0 的桶滤掉了，见 `pctRowsOf()`）。
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
    `<button class="lg-cdbtn${cur === k ? ' on' : ''}" type="button" data-act="lg-chart-dir" data-dir="${esc(k)}"` +
    ` aria-pressed="${cur === k}">${name}</button>`;
  return `<div class="lg-cdbar" role="group" aria-label="选择口径">${one('out', '支出')}${one('in', '收入')}</div>`;
}

/**
 * 功能：画**图表视图**（账单那一屏的「图表」那一档）—— 口径 ＋ 两个数 ＋ 折线 ＋ 排行。
 *
 * ⇒ 期间由账单自己的三档（`周账单 / 月账单 / 年账单`）与年份下拉决定，
 * 这里**不再自带**「期间档药丸 ＋ 期间选择行」（那一套只给明细屏用过）。
 * 三态：读取中 / 读不到 ＋ 重试 / 这一期没有数据 —— ⛔ 绝不把「读不到」画成「没有」。
 */
function lgChartViewHtml() {
  const dir = chartDirOf(state.lgChartDir);
  const d = state.lgChart;
  if (state.lgChartLoad === 'error') {
    return `<div class="lg-chart">${errBoxHtml('图表', state.lgChartErr, 'lg-chart-retry')}</div>`;
  }
  // 服务端一次把**两侧**都给（`d.out` / `d.in`）⇒ 换口径只用换这里取哪一侧，
  const side = d ? d[dir] || null : null;
  if (state.lgChartLoad !== 'done' || !side) {
    return `<div class="lg-chart"><div class="lg-txwait">正在读取…</div></div>`;
  }
  // `avg_fen` 可能是 `null`（期还没开始 ⇒ 分母 0）⇒ 画 `—`，⛔ 不画 `0.00`
  const money = (fen) => (fen == null ? '—' : esc(fmtFen(fen, state.lgHide)));
  // 口径那两颗按键（支出 / 收入）排在「平均值」右侧（与电脑端同一处、同一套样式）
  const nums = `<div class="lg-cnums">
    <div><span>总${dir === 'in' ? '收入' : '支出'}</span><b>${money(side.total_fen)}</b></div>
    <div><span>平均值</span><b>${money(side.avg_fen)}</b></div>
    ${chartDirBarHtml(dir)}
  </div>`;
  // ：右栏（这里是一整屏）拆成**两张卡** ——
  // 上面那张（两颗按键 ＋ 两个数 ＋ 折线）**固定**，下面那张（排行）**自己滚**。
  return `<div class="lg-chart">
    <div class="lg-ccard">${nums}${chartLineHtml(side)}</div>
    <div class="lg-crankcard">${chartRanksHtml(side)}</div>
  </div>`;
}

/**
 * 功能：切**账单屏**那颗药丸（`列表 ｜ 图表`）—— 同上，⭐ 只重画不重取数。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一档（`data-tab`）
 * @returns {Promise.<void>|undefined}
 */
export function lgBillTab2(_act, n) {
  return pickBillTab2(n && n.dataset && n.dataset.tab);
}

/**
 * 功能：切账单那一格的**「列表 ⇄ 图表」两档** —— 点指示点与左右滑动**走同一条路**。
 *
 * 原来那颗药丸（`subTabsHtml('lg-btab2', …)`）撤了，换成与「资产」那一格同款的
 * 两颗**指示点**＋左右滑动 ⇒ 两条入口（点 / 滑）必须落到**同一个函数**上，
 * 别在 `touchend` 里再抄一遍这段（抄了就是"点能切、滑不能"或反之，而且不报错）。
 */
function pickBillTab2(raw) {
  const k = subTabOf(raw);
  if (k === subTabOf(state.lgBillTab2)) return undefined;
  state.lgBillTab2 = k;
  if (k === 'chart' && state.lgChartLoad === 'idle') return loadChart();
  renderLedger();
  return undefined;
}

/**
 *
 * （`state.lgChart` 里 `out` / `in` 各一份）⇒ 换口径只是「换取哪一侧」。
 */
export function lgChartDirPick(_act, n) {
  // 口径那颗 `<select>` 换成了**两颗按键** ⇒ 值的来源从 `n.value` 变成 `n.dataset.dir`
  // （`n` 现在是那颗按钮）。⚠️ 名字没改：`ACTIONS` 表里那一条（`'lg-chart-dir'`）继续有效，
  // 改的只是"谁触发、从哪取值"。
  const v = chartDirOf(n && n.dataset && n.dataset.dir);
  if (v === chartDirOf(state.lgChartDir)) return undefined;
  state.lgChartDir = v;
  renderLedger();
  return undefined;
}

/**
 * 功能：「读不到 ⇒ 重新加载」那颗（`errBoxHtml()` 给的动作名）—— 就是**再取一次图表**。
 * @returns {Promise.<void>}
 */
export function lgChartRetry() {
  return loadChart();
}

/**
 * 功能：切账单屏的三档（`周账单 ｜ 月账单 ｜ 年账单`）。
 *
 * 说明：⚠️ 换档 = 换**期** ⇒ `period_key` 一起复位（一律回到**服务端今天**那一期；
 * 切完之后想看别的期就用这一档自己的**换期控件**：周档那颗 `‹ 月份 ›` /
 * 月档那颗年份下拉）。
 */
export async function lgBillTab(_act, n) {
  const k = String((n && n.dataset && n.dataset.tab) || '');
  if (!PERIOD_TYPES.includes(k) || k === billTabOf()) return;
  state.lgBillTab = k;
  state.lgBillKey = '';
  // 「同一套图，**期间选择与账单的三档联动**」）—— ⛔ 别重取表格（那一屏根本没画）。
  if (subTabOf(state.lgBillTab2) === 'chart') return loadChart();
  await loadBill();
}

/**
 * 功能：画账单屏（版式权威 = 参考图 2）—— 返回头 ＋ 三档 ＋（月档）年份下拉 ＋ 红色大卡 ＋ 表格。
 *
 * ① **三档** `周账单 ｜ 月账单 ｜ 年账单`（默认月档，C-19）＋ 一颗**换期**控件
 * ② **红色大卡**：结余（大号）＋ 收入 / 支出（小字），**标签随档变**（`billCardLabels()`）；
 * ③ **表格**：表头 `billColLabels()`、行**照服务端给的顺序**（月档 12 行倒序、年档各年倒序、
 */
function billScreenHtml() {
  const type = billTabOf();
  const d = state.lgBill;
  // 同一份期间选择（三档 ＋ 月档的年份），列表画表格、图表画折线 ＋ 排行。
  const tab2 = subTabOf(state.lgBillTab2);
  // 它升成**一级格**了 ⇒ ⛔ **不再有「‹ 返回」那条自画头**
  // （一级格没有"上一层"可回；它现在就在底栏上，与明细 / 预算并排）。
  const tabs = PERIOD_TYPES.map((k) => {
    const label = k === 'week' ? '周账单' : k === 'year' ? '年账单' : '月账单';
    return `<button class="lg-btab${type === k ? ' on' : ''}" type="button" data-act="lg-bill-tab"
      data-tab="${k}" role="tab" aria-selected="${type === k}">${label}</button>`;
  }).join('');
  // ：三档行右侧补一颗**眼睛** ——
  // 账单屏（含它下面「图表」那一档）通篇都是金额，而从前只有明细屏藏得掉。
  // 复用 `eyeHtml()` 与 `state.lgHide`（⛔ 不新开第二个开关）；动作名 `data-act="lg-eye"`
  const bar = `<div class="lg-tabrow"><div class="lg-btabs" role="tablist">${tabs}</div>${eyeHtml()}</div>`;
  // 那颗药丸（`列表 ｜ 图表`）画在三档**上面**（它管的是"这一格用什么画"，
  // 三档管的是"看哪一期" —— 粗的那层在上面）
  // （「手机端的账单：去掉列表和图表两个按键，改为左右滑动切换（参考
  const sub = tabDotsHtml(SUB_TABS, tab2, 'lg-btab2');
  // 三档各自的「换期」控件 ——
  // 「要能看到本月内的所有周，并且通过 `‹ 月份 ›` 切换月」）；
  // **月档** ⇒ 年份下拉（照旧）；
  const pick =
    type === 'week'
      ? billMonthSwitchHtml()
      : type === 'month'
        ? (() => {
            const list = billYears();
            const cur =
              Number(String(state.lgBillKey || '').slice(0, 4)) || Number(todayOf().slice(0, 4)) || 0;
            const opts = list
              .map((y) => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}年</option>`)
              .join('');
            return `<div class="lg-byear"><select id="lg-bill-year" aria-label="选择年份">${opts}</select></div>`;
          })()
        : '';

  // 它**在下面那三条三态之前**分派：图表模式下要取的是 `/chart`（`state.lgChartLoad`），
  // 而 `lgBillLoad` 可能还停在别处 ⇒ 拿它判三态会把一块已经画好的图盖成「正在读取…」。
  if (tab2 === 'chart') {
    return `<div class="lg-bill">${sub}${bar}${pick}${lgChartViewHtml()}</div>`;
  }

  if (state.lgBillLoad === 'error') {
    return `<div class="lg-bill">${sub}${bar}${pick}${errBoxHtml('账单', state.lgBillErr, 'lg-bill')}</div>`;
  }
  if (state.lgBillLoad !== 'done' || !d) {
    return `<div class="lg-bill">${sub}${bar}${pick}<div class="lg-txwait">正在读取…</div></div>`;
  }

  const card = d.card || { income_fen: 0, expense_fen: 0, balance_fen: 0 };
  const lb = billCardLabels(type);
  const cols = billColLabels(type);
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const body = rows
    .map((r) => {
      const month = type === 'month';
      // 行尾那颗 `›` 只有**月档**有（T41：周 / 年没有详情页）—— 非月档的整行也不可点，
      // 别留一个点了没反应的 `data-act`。
      const tap = month ? ` data-act="lg-md-open" data-key="${esc(r.key)}"` : '';
      // 与电脑端**同一条口径**（两端各一份版式，判据必须一致）——
      // ① 加了「预算 / 超支」两列；② 还没到的期一律画「—」（⛔ 不是 `0.00`：
      // 图表那边那种期是**断点**，两边必须长得一样）。
      const live = r.started !== false;
      const bud = r.budget_fen === null || r.budget_fen === undefined ? null : Number(r.budget_fen);
      // ：这三格走 `fmtFen()` 的
      // **整元档**（第三参传 `true` ⇒ 四舍五入到元）。⚠️ 电脑端那一份**不传**（它有地方摆小数）。
      const cell = (v) => (live ? esc(fmtFen(Number(v) || 0, state.lgHide, true)) : '—');
      const budCell = live && bud !== null ? esc(fmtFen(bud, state.lgHide, true)) : '—';
      const ovCell = live && bud !== null ? esc(fmtFen(Number(r.overspent_fen) || 0, state.lgHide, true)) : '—';
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
  // （「手机端账单：【周账单】的日期切换和【月账单】的年份选择，
  // 和电脑端一样，放到卡片中」）：换期控件（`pick`）从屏顶搬进结余卡的右上角 ——
  // 与电脑端同一条口径（那里叫 `.lg-bctop`）。⚠️ 红底上的控件要白系覆盖，见 `app.css`。
  return `<div class="lg-bill">${sub}${bar}
    <div class="lg-bcard">
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
    </div>
  </div>`;
}

// ---------- ③ 月详情页（图 5；⭐ 只有「月」有这一页） ----------

/**
 * 功能：取一次月详情页一屏（`GET /api/ledger/month-bill`）并重画。
 *
 * 说明：⭐⭐ 服务端**一次给全**（占比表 / 排行 / 趋势 / 对比 / 收入构成 / 成就，§5.3 最后一段）
 * ⇒ 这一屏**一个请求**，⛔ 不是按块各取一次（不做 N+1）。
 * 失败**不抛**（画「读不到 ＋ 重试」），⛔ 绝不画成"这个月没有账单"。
 */
async function loadMonthBill() {
  const month = String(state.lgMdMonth || '');
  if (!month) return;
  state.lgMdLoad = 'loading';
  state.lgMdErr = '';
  renderLedger();
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
  renderLedger();
}

/**
 * 功能：点账单表格某一行尾的 `›` ⇒ 进**该月详情页**（⭐ 只有月档的行有这颗，T41）。
 *
 * 说明：⚠️ 行上传的是 **`period_key`**（`YYYY-MM-01`，服务端的口径），这一屏要的是
 * `month`（`YYYY-MM`）⇒ 只在这里**切掉最后三位**（⛔ 不另存一份月）。
 * @param {string} _act - 动作名（未用）
 */
export async function lgMdOpen(_act, n) {
  const key = String((n && n.dataset && n.dataset.key) || '');
  if (!/^\d{4}-\d{2}/.test(key)) return;
  state.lgMdMonth = key.slice(0, 7);
  state.lgMd = null;
  state.lgMdLoad = 'idle';
  await loadMonthBill();
}

/** 功能：月详情页那颗「‹ 返回」⇒ 回账单屏。 @returns {void} @since */
export function lgMdBack() {
  state.lgMdMonth = 0;
  state.lgMd = null;
  state.lgMdLoad = 'idle';
  renderLedger();
}

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
 * 功能：一行「类别 ｜ 占比 ｜ 金额」的占比该写什么。
 *
 * 说明：⚠️⭐ 占比**已经由服务端算好**（`pct`，一位小数，见 `pctOf()`）⇒ 这里只排版，
 * 不拿金额再除一遍（那是第二套算术）。
 * 三条口径：`null`（分母为 0）⇒ `—`；**非零但极小**（服务端已经舍成 0.0）⇒ `<0.1%`
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
 * 把「近 6 个月」按月份落进 `trendGeometry()` 的 **12 格**（月序即下标），
 * 于是横向位置、刻度、纵轴缩放**全是同一份几何**；柱子的高度直接从它给的点算
 * （`geo.dots` 的 y 到基线）。⚠️ 缺数据的月 `null` ⇒ 那一格没有点 ⇒ 不画柱
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
 * 说明：⚠️⭐ 这里**没法**复用 `trendGeometry()`：它的横轴被写死成**12 个月**
 * （刻度取自 `AXIS_MONTHS`），而这一条是**同一个月里的每一天**（最多 31 个点）
 * ⇒ 只在本函数里按「日」铺点（横轴 = 当月第几号，与图 5 的 `01 … 30` 对齐），
 */
function dayLineHtml(trend, month) {
  const days = (trend && Array.isArray(trend.days) ? trend.days : []).filter(
    (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x && x.day)),
  );
  if (!days.length) return '<div class="lg-wait">这个月还没有支出。</div>';
  const y = Number(String(month).slice(0, 4));
  const mo = Number(String(month).slice(5, 7));
  const dim = new Date(y, mo, 0).getDate() || 30;
  // ：几何**收口到共用层** —— 从前这里自己算了一遍
  // `lo/hi/span/xOf/yOf`（与 `calc.js` 的 `trendGeometry()` 是同一段算术的第二份拷贝，
  // 连 ±10% 余量与 nudge 都逐字相同）⇒ 现在只有一条路：把「每天一格」的值得出来，
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
 * ④ 支出排行（前三）；⑤ 支出趋势（单日最高 / 日均 / 本月支出 ＋ 折线）；
 * ⑥ 月支出对比（柱状 ＋「对比上月变化前三的类别」）；⑦ 收入（总收入 ＋ 各来源占比）；
 */
function monthDetailScreenHtml() {
  const month = String(state.lgMdMonth || '');
  const head = subHeadHtml('lg-md-back', monthTitle(month));
  if (state.lgMdLoad === 'error') {
    return `<div class="lg-md">${head}${errBoxHtml(
      '这个月的账单',
      state.lgMdErr,
      'lg-md-open',
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
// 记账 3 期：**预算屏**（周 / 月 / 年 · 总预算 ＋ 分类预算）
//

/**
 * 本次「设 / 清一行预算」流程里的**目标**（`{type, key, cat}`，`null` = 没开过那一层）。
 *
 */
let budTarget = null;

/**
 * 功能：预算屏当前那一档（`'week'` / `'month'` / `'year'`）。
 *
 * 说明：⚠️ 认不出一律回落 `'month'` —— ⭐ **它就是默认档**（方案附录 C 的 C-18：照图 4
 * 顶栏的选中态）。白名单走 `calc.js` 的 `PERIOD_TYPES`（⛔ 不在这里再抄一遍三档字面量）。
 * @returns {string} 三档之一
 */
function budgetTabOf() {
  const k = String(state.lgBudgetTab || '');
  return PERIOD_TYPES.includes(k) ? k : 'month';
}

/**
 * 功能：预算屏当前这一期的 `period_key`（**该期起始日** `YYYY-MM-DD`）。
 *
 * 折算是 `calc.js` 的 `periodKeyOf()`（判据只住那一处）。
 * 里面的 `today` 必须是**服务端今天**（`overview.today`）——
 * 绝不传本机 `new Date()`：手机日期不可信，跨零点会把用户写进错的那一期。
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
 * 说明：⚠️ 优先读服务端那一行给的名字（`state.lgBudget.categories[].name`）——
 * 分类被**硬删**过（`restore-builtin` 那条路）而预算行还在时名字是空串，
 * 那时回落到 `CAT_UNCLASSIFIED`（「未分类」这个词只住前端）。
 */
function budgetCatName(cat) {
  const list = (state.lgBudget && state.lgBudget.categories) || [];
  const row = list.find((c) => Number(c.category_id) === Number(cat));
  return String((row && row.name) || '') || CAT_UNCLASSIFIED;
}

/**
 * 功能：底部动作单上那两行写什么的主语（图 7 的 `编辑年度总预算` / `清除年度总预算`）。
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
 * 眼睛（`lgHide`）关掉时三串一起糊成圆点，⚡ 而且剩余**可以是负数**（超支照实显示，
 * 不取绝对值、⛔ 不夹到 0 —— 图 6 的 `-10045.00` 就是这么来的）。
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
    <button class="lg-bedit" type="button" data-act="lg-budget-edit" data-mode="menu"
      data-cat="${Number(cat) || 0}">编辑</button>
  </div>
  <div class="lg-brow">${budgetRingHtml(block)}${budgetLinesHtml(block, labels)}</div>`;
}

/**
 * 功能：取一次预算屏一屏（`GET /api/ledger/budget`）并重画 —— **三档共用**（靠 `period_type` 分派）。
 *
 * 说明：⭐⭐ `period_key` 由前端按**服务端今天**折出来（`budgetPeriodKey()`）；⚠️ 它是**必填**
 * （服务端 400 而不是替你猜），所以取不到服务端今天时这一屏就是**读不到**（三态里的 error），
 * 绝不拿本机日期兜一个上去。
 */
async function loadBudget() {
  state.lgBudgetLoad = 'loading';
  state.lgBudgetErr = '';
  renderLedger();
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
  renderLedger();
}

/**
 * 功能：进「预算」那一格 ⇒ 把这一期取回来（与进屏同一条路，`mountLedger()` / `lgSegPick()` 都走它）。
 *
 * 说明：⭐ 每次进这一格都重取（与服务端口径同源）：额度 / 已用都可能在别处被改过
 * （另一个标签页、另一台设备），而这一屏摆的就是「这一期还剩多少」。
 * @returns {Promise.<void>}
 */
async function openBudget() {
  await loadBudget();
}

/**
 * 功能：切预算屏那三档（`周预算 ｜ 月预算 ｜ 年预算`）。
 *
 * 说明：⚠️⭐ 换档 = 换**期** ⇒ `period_key` 一起复位（一律用**服务端今天**那一期，
 * C-18 /，这一屏只编辑"当前这一期"）。
 * 点**已经在的那一档**时：数据在手（`done`）就什么都不做（别白跑一趟）；
 */
export async function lgBudgetTab(_act, n) {
  const k = String((n && n.dataset && n.dataset.tab) || '');
  if (!PERIOD_TYPES.includes(k)) return;
  const same = k === budgetTabOf();
  if (same && state.lgBudgetLoad === 'done') return;
  if (!same) state.lgBudgetKey = '';
  state.lgBudgetTab = k;
  await loadBudget();
}

/**
 * 功能：画**预算屏**（版式权威 = 参考图 4 / 6；⭐ 默认落「月预算」，C-18）。
 *
 * 说明：⭐⭐ 三块（§7.2 逐条）：
 * ① **三档** `周预算 ｜ 月预算 ｜ 年预算`（默认月档）—— 顶部那一段控件；
 * ② **总预算块**：标题（`09月总预算`）＋「编辑」＋ 环形 ＋ `剩余预算 / 本月预算 / 本月支出`；
 */
function budgetScreenHtml() {
  const type = budgetTabOf();
  const tabs = PERIOD_TYPES.map((k) => {
    const label = k === 'week' ? '周预算' : k === 'year' ? '年预算' : '月预算';
    return `<button class="lg-btab${type === k ? ' on' : ''}" type="button" data-act="lg-budget-tab"
      data-tab="${k}" role="tab" aria-selected="${type === k}">${label}</button>`;
  }).join('');
  // 三档行右侧那颗眼睛 —— 与账单屏同一条口径（见 `billScreenHtml()` 里那段说明）
  const bar = `<div class="lg-tabrow"><div class="lg-btabs" role="tablist">${tabs}</div>${eyeHtml()}</div>`;

  // ---- 三态之一：读不到（⛔ 绝不画成「还没设预算」）----
  if (state.lgBudgetLoad === 'error') {
    return `<div class="lg-budget">${bar}${errBoxHtml(
      '预算',
      state.lgBudgetErr,
      'lg-budget-tab',
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
      <div class="empty slim"><div class="e-ico">🎯</div><h3>还没设预算</h3>
        <p>设一个总预算，或者先给几个分类各分一点。</p>
        <button class="btn primary" type="button" data-act="lg-budget-edit" data-mode="amount"
          data-cat="0" style="margin-top:12px">设置总预算</button></div></div>`;
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
 * 功能：底部**动作单**（图 7）—— `编辑XX预算` / `清除XX预算` / `取消`。
 *
 * 说明：⭐ 措辞里那句主语走 `budgetTargetName()`（总预算 = `本月总预算`、分类 = `<分类名>预算`）
 * —— 与块头上那块写的是**同一个来源**，⛔ 不在这里另拼一份（两处各拼一次必然漂移）。
 * 「清除」那一行是危险色（`.lg-bmi.danger`）：它删数据，样式上必须先声张。
 */
function openBudgetMenu(cat) {
  const name = budgetTargetName(cat, budgetTabOf());
  const cid = Number(cat) || 0;
  openSheet(
    '编辑预算',
    `<div class="lg-bmenu">
      <button class="lg-bmi" type="button" data-act="lg-budget-edit" data-mode="amount"
        data-cat="${cid}">编辑${esc(name)}</button>
      <button class="lg-bmi danger" type="button" data-act="lg-budget-clear" data-cat="${cid}">清除${esc(
        name,
      )}</button>
    </div>`,
    '<button class="btn" type="button" data-act="sheet-close">取消</button>',
  );
}

/**
 * 功能：底部那颗「编辑XX预算」开的那张**额度输入弹层**（设 / 改额度）。
 *
 * 说明：⚠️⭐ `amount_fen` 提交时**必须是字符串**（`routes.js` 的 `parseFen()` 只收字符串：
 * 数字类型的 `8.7` 在解析成 double 那一刻就已经丢过精度了）⇒ 输入框的**原样串**
 * 直接交上去，⛔ 不在前端 `Number()` 一下再 `String()` 回来。
 */
function openBudgetAmount(cat) {
  const type = budgetTabOf();
  const cid = Number(cat) || 0;
  budTarget = { type, key: budgetPeriodKey(), cat: cid };
  const row = cid
    ? ((state.lgBudget && state.lgBudget.categories) || []).find((c) => Number(c.category_id) === cid)
    : state.lgBudget && state.lgBudget.total;
  const cur = row && row.set ? fenToInput(row.amount_fen) : '';
  openSheet(
    `编辑${budgetTargetName(cid, type)}`,
    `<div class="lg-bset">
      <label class="fld"><span>额度</span>
        <input id="lg-bud-input" type="text" inputmode="decimal"
          value="${esc(cur)}" /></label>
      <div class="m-tip">填 0 就是这一期设成 0（与「没设过」是两回事）；改这一期只影响这一期，不回溯。</div>
    </div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-budget-set" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：点「编辑」那一颗（总预算 / 分类预算各一颗）—— ⚠️⭐ 它**不是**直接开输入框（图 7）。
 *
 * 说明：⭐ 两颗按钮两种下场，靠 `data-mode` 分（⛔ 不靠模块变量 —— 那会在重画 / 换档之后失同步）：
 * `menu`（块头上那颗「编辑」）⇒ 先弹**动作单**；`amount`（动作单里的「编辑XX预算」）
 * ⇒ 开**额度输入弹层**。
 */
export function lgBudgetEdit(_act, n) {
  const mode = String((n && n.dataset && n.dataset.mode) || 'menu');
  const cat = Number((n && n.dataset && n.dataset.cat) || 0);
  if (mode === 'amount') {
    openBudgetAmount(cat);
    return;
  }
  openBudgetMenu(cat);
}

/**
 * 功能：`＋ 添加分类预算` ⇒ 开那张「先挑分类、再填额度」的弹层。
 *
 * 说明：⭐ 挑分类用的是**原生 `<select>` ＋ `<optgroup>`**（两级分类靠全角空格缩进）——
 * 服务端不收名字、只认 id，而原生选择器在手机上自带滚轮，比自己画一套更稳
 * （⛔ 本期不为这一件事长第二套分类选择器）。
 */
export function lgBudgetAdd() {
  const groups = catTree(state.lgCats, '支出').length + catTree(state.lgCats, '收入').length;
  if (!groups) {
    toast('还没有收支分类，先去「设置」里建一个', true);
    return;
  }
  budTarget = { type: budgetTabOf(), key: budgetPeriodKey(), cat: 0 };
  openSheet(
    '添加分类预算',
    `<div class="lg-bset">
      <label class="fld"><span>分类</span>${budgetCatSelectHtml(0)}</label>
      <label class="fld"><span>额度</span>
        <input id="lg-bud-input" type="text" inputmode="decimal" value="" /></label>
      <div class="m-tip">给某一个分类单独设一份额度；它和总预算是各算各的，不互相扣。</div>
    </div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-budget-set" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：「添加分类预算」那张弹层里折一个两级分类的 `<select>`。
 *
 * 说明：⭐ 分类树只走 `entry-calc.js` 的 `catTree()`（⛔ 不在本文件再写一遍父子过滤）。
 * 支出 / 收入**两组都给**：服务端对预算行不按收支方向设限
 * 服务端没有的规矩。⚠️ `<option>` 的**取值一律是分类 id**，⛔ 别拿名字当值
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
 * 功能：额度弹层里那颗「保存」—— `PUT /api/ledger/budget`（设 / 改**一行**额度）。
 *
 * 说明：⭐⭐ 两条（都对得上服务端 `checkBudgetBody()` 的入参校验表）：
 * `amount_fen` 传**字符串原样**（`parseFen()` 只收字符串，见 `openBudgetAmount()` 的说明）；
 * `category_id` 也传字符串（`0` = 总预算哨兵；> 0 = 分类，服务端会验"存在且是我的"）。
 */
export async function lgBudgetSet() {
  const input = $('#lg-bud-input');
  if (!input) return;
  const value = String(input.value == null ? '' : input.value).trim();
  if (!value) {
    toast('填一下额度吧', true);
    input.focus();
    return;
  }
  const t = budTarget || { type: budgetTabOf(), key: budgetPeriodKey(), cat: 0 };
  const sel = $('#lg-bud-cat');
  const cat = sel ? Number(sel.value) || 0 : Number(t.cat) || 0;
  try {
    const r = await api('PUT', '/api/ledger/budget', {
      period_type: t.type,
      period_key: t.key,
      category_id: String(cat),
      amount_fen: value,
    });
    if (r && r.budget) state.lgBudget = r.budget;
    state.lgBudgetLoad = 'done';
    state.lgBudgetErr = '';
    closeSheet();
    budTarget = null;
    renderLedger();
    toast('额度已保存');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：真去清一行（`DELETE /api/ledger/budget`）—— 总预算 / 分类预算共用这一条。
 *
 * 说明：⭐⭐ `category_id = 0` 时**服务端连带清掉该期全部分类预算**（/ 图 9，
 * 一个事务：要么都成、要么一行都不删）⇒ 前端只要把 `category_id` 如实带上，
 * 别自己先删分类再删总预算（那是两笔请求、失败就留半截）。
 */
async function budgetClearGo(cat) {
  const t = budTarget || { type: budgetTabOf(), key: budgetPeriodKey(), cat: Number(cat) || 0 };
  const q =
    `period_type=${encodeURIComponent(t.type)}&period_key=${encodeURIComponent(t.key)}` +
    `&category_id=${encodeURIComponent(String(Number(cat) || 0))}`;
  try {
    const r = await api('DELETE', `/api/ledger/budget?${q}`);
    if (r && r.budget) state.lgBudget = r.budget;
    state.lgBudgetLoad = 'done';
    state.lgBudgetErr = '';
    closeSheet();
    budTarget = null;
    renderLedger();
    toast('清掉了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：动作单里那颗「清除XX预算」。
 *
 * 说明：⭐⭐ 两条口径（图 9 /）：
 * **清除总预算** ⇒ 先弹一道「**警告**」二次确认（正文逐字是
 * 「清除总预算将同时为您清除所有分类预算」）—— 它连带清掉那一期**全部**分类预算，
 */
export function lgBudgetClear(_act, n) {
  const cat = Number((n && n.dataset && n.dataset.cat) || 0);
  budTarget = { type: budgetTabOf(), key: budgetPeriodKey(), cat };
  if (cat) return budgetClearGo(cat);
  openSheet(
    '警告',
    '<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">清除总预算将同时为您清除所有分类预算</p>',
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="lg-budget-clearok" style="flex:1.4">确定</button>`,
  );
  return undefined;
}

/** 功能：「警告」里那颗「确定」⇒ 真去清总预算（连带该期全部分类预算）。 @returns {Promise.<void>} @since */
export async function lgBudgetClearok() {
  await budgetClearGo(0);
}

// ============================================================================
// 记账 · 三方导入（鲨鱼记账）——）
// 入口：**记账设置**那一屏里新加的一块「导入三方数据」（§6.1）；

/** 三方来源的 `source` 值（本期只适配鲨鱼）—— ⛔ 它不是文件名、也⛔ 不受理请求体带来的值。 @type {string} */
const IMP_SOURCE = 'shark';

/**
 * 设置屏那一行显示的名字（⚠️ 与 `lib/import-sources.js` 注册表里的 `label` 同一个词）。
 *
 */
const IMP_LABEL = '鲨鱼记账';

/**
 * 「导入三方数据」那块的正文明细（给的定稿文案）。
 *
 */
const IMP_HELP =
  '导入三方记账数据，不关联账户，数据独立存储，自动过滤重复数据。目前已经适配：鲨鱼记账。';

/**
 * 导入概况（`GET /api/ledger/import` 的 `summary`；`null` = 还没取到）。 @type {?Object}
 */
let impSummary = null;

/** 概况的四态：`idle`（还没取）| `loading` | `done` | `error`。⚠️ `error` ⛔ 绝不许画成「还没导入过」。 @type {string} */
let impLoad = 'idle';

/** 概况读不到时的原因（用户能看的那句话）。 @type {string} */
let impErr = '';

/** 用户选中的那个文件（`File`）—— 只活在这次向导里。 @type {?File} */
let impFile = null;

/** 预览草稿（`POST …/import/preview` 的 `draft`）。⚠️ 确认时**不用它**（那一下是把同一个文件再发一次）。 @type {?Object} */
let impDraft = null;

/** 正在上传预览 / 正在确认导入（防重复点、防重复发）。 @type {boolean} */
let impBusy = false;

/**
 * 明细屏当前那个月**全部**导入行（服务端一次给全，**不分页**）。
 *
 */
let impRows = [];

/** 向导弹层里那条 `change` 委托只挂一次（`#sheet-body` 是常驻节点，每次重挂会一次选择跑两遍）。 @type {boolean} */
let impSheetBound = false;

/**
 * 功能：往**自己的服务端**发一次「原始字节体」的 POST（⛔ 不是 JSON）。
 *
 * 说明：⭐⭐ `core/api.js` 的 `api()` 只会 `JSON.stringify` 一个 body ⇒ 上传文件那条路走不了它，
 * 只能自己 `fetch`（照课表导入 `desktop-import.js` / `timetable/mobile.js` 那一套）。
 * 于是那两件本来由 `api()` 兜住的事得在这里补回来，且**只写一次**：
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
 * 功能：取一次导入概况（`GET /api/ledger/import?source=shark`）并重画这一屏。
 *
 * 说明：⚠️ 三态**分得开**：`loading` / `error`（读不到 ＋ 重试）/ `done`。
 * （用户会以为"我确实没导过"，然后再导一次）。`count === 0` 才是「还没导入过」。
 * 失败**不抛**（由界面画错误块 ＋ 一颗重试）。
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
  renderLedger();
}

/** 功能：概况那块「读不到」时那颗重试（只重取概况，⛔ 不整页刷新）。 @returns {Promise.<void>} @since */
export async function lgImpRetry() {
  await loadImportSummary();
}

/**
 * 功能：画设置屏那一块「导入三方数据」的**下一行**（概况那三态）。
 *
 * 说明：⭐ 只有 `count > 0` 才画「已导入 N 笔（跨度）＋ [清除]」这一行；`count === 0` 画
 * 「还没导入过」（**不是**错误）；读不到画一句人话 ＋ 一颗重试（⛔ 与「还没导入过」分开）。
 * 跨度那一段只在**两端日期都拿到**时才画（缺一个就只报笔数，⛔ 不拼出「~ 空」那种）。
 */
function impSummaryHtml() {
  if (impLoad === 'idle' || impLoad === 'loading') {
    return '<div class="lg-imp-sum"><span class="lg-impnote">正在读取导入概况…</span></div>';
  }
  if (impLoad === 'error') {
    return `<div class="lg-imp-sum"><span class="lg-impnote err">导入概况没读到：${esc(
      impErr || '原因不明',
    )}</span>
      <button class="lg-impbtn" type="button" data-act="lg-imp-retry">重试</button></div>`;
  }
  const s = impSummary || {};
  const n = Number(s.count) || 0;
  if (!n) return '<div class="lg-imp-sum"><span class="lg-impnote">还没导入过</span></div>';
  const from = String(s.from || '');
  const to = String(s.to || '');
  const span = from && to ? `（${from} ~ ${to}）` : '';
  return `<div class="lg-imp-sum"><span class="lg-impnote">${esc(`已导入 ${n} 笔${span}`)}</span>
    <button class="lg-impbtn danger" type="button" data-act="lg-imp-clear">清除</button></div>`;
}

/**
 * 功能：画一条**导入行**（明细屏里那些三方数据）。
 *
 * 说明：⭐⭐ 三条口径：
 * **只读**：整行挂了 `data-act="lg-imp-item"` ⇒ 点开是**只读详情**，⛔ 没有编辑 / 删除；
 * **一眼分得出**（`.lg-erow.imp` ＋ 灰底的来源小徽标 ＋ 一颗 `source_label` 小标签）：
 */
function impRowHtml(r) {
  const src = String((r && r.source_label) || '').trim() || IMP_LABEL;
  const cat = String((r && r.category) || '').trim() || '未分类';
  const note = String((r && r.note) || '').trim();
  // 分类图标那一格（自有流水画的是"色块 ＋ 分类首字"）在这里放**来源小徽标**：
  const ico = `<span class="lg-imp-badge" aria-hidden="true">${esc(src.slice(0, 1) || '·')}</span>`;
  const parts = [`<span class="lg-imp-tag">${esc(src)}</span>`];
  if (note) parts.push(esc(note));
  return `<div class="lg-erow imp" data-act="lg-imp-item" data-id="${Number((r && r.id) || 0)}">
    ${ico}
    <span class="lg-emain"><b class="lg-etitle">${esc(cat)}</b>
      <i class="lg-sub">${parts.join(' · ')}</i></span>
    <b class="lg-eamt">${esc(fmtSignedFen(signedFen(r && r.ie, r && r.fen), state.lgHide))}</b>
  </div>`;
}

/**
 * 功能：点一条导入行 ⇒ 开**只读详情**弹层。
 *
 * 说明：⭐⭐ **只读**：六列原样 ＋ 来源 ＋ 一句「三方导入的数据不能改，要撤就整批清除」。
 * 从**手上这份** `impRows` 里找（与 `entryOf()` 同一条手法）：找不到（刚换过月 / 别处清过）
 * 就什么都不做，⛔ 别开一张空弹层。
 */
export function lgImpItem(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const r = impRows.find((x) => Number(x && x.id) === id);
  if (!r) return;
  const row = (k, v) => `<div class="lg-drow"><span>${k}</span><b>${esc(v)}</b></div>`;
  openSheet(
    '这笔账（只读）',
    `<div class="lg-ed">
      <div class="lg-edcap2">三方导入的数据不能改，要撤就整批清除。</div>
      <div class="lg-det">
        ${row('日期', String(r.date_raw || ''))}
        ${row('收支', String(r.ie || ''))}
        ${row('类别', String(r.category || '') || '未分类')}
        ${row('账户', String(r.account || '') || '（没填）')}
        ${row('金额', String(r.amount_raw || ''))}
        ${row('备注', String(r.note || '') || '（没填）')}
        ${row('计入日', String(r.at || ''))}
        ${row('来源', String(r.source_label || '') || IMP_LABEL)}
      </div>
    </div>`,
    '<button class="btn" type="button" data-act="sheet-close">关闭</button>',
  );
}

/**
 * 功能：进**导入向导**第 1 步 —— 选文件那张弹层。
 *
 * 说明：⭐ 文件选择走**原生 `<input type="file">`** 的 `change`（⛔ 不是 `data-act`）——
 * 原生控件被藏在 `.fld` 里（`app.css` 那条 `.fld input[type='file']`），用户点的是
 * 我们自己画的那块（`.lg-imp-pick`，`<label for>` 等同于点 input）。
 */
function openImportSheet() {
  openSheet(
    '导入三方数据',
    `<div class="lg-ed">
      <div class="lg-edcap2">选 ${esc(IMP_LABEL)}导出的 CSV（六列：日期 / 收支类型 / 类别 / 账户 / 金额 / 备注），原样存、只读。</div>
      <div class="fld"><span>文件</span>
        <label class="lg-imp-pick" for="lg-imp-file">
          <span class="lg-imp-pick-btn">选择文件</span>
          <span class="lg-imp-pick-name" id="lg-imp-name">未选择任何文件</span>
        </label>
        <input id="lg-imp-file" type="file" accept=".csv,text/csv" />
      </div>
      <div class="m-tip">文件最大 2MB；选完就上传预览（预览不写库，确认之后才真写入）。</div>
    </div>`,
    '<button class="btn" type="button" data-act="lg-imp-cancel">取消</button>',
  );
  bindImportSheetOnce();
}

/**
 * 功能：绑向导弹层里那条 `change`（选到文件 ⇒ 存下它、更新文件名、立刻上传预览）。
 *
 * 说明：⭐⭐ 挂的是 `#sheet-body`（常驻节点，弹层每次只换它的 `innerHTML`）——
 * 且**只挂一次**（`impSheetBound`）：挂重了的表现是"选一次文件、预览发两遍"
 * （与 `bindLedgerOnce()` 里那条一模一样的坑，而且它**不报错**）。
 */
function bindImportSheetOnce() {
  if (impSheetBound) return;
  const body = $('#sheet-body');
  if (!body) return;
  impSheetBound = true;
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.id !== 'lg-imp-file') return;
    const f = (t.files && t.files[0]) || null;
    if (!f) return;
    impFile = f;
    const nameEl = $('#lg-imp-name');
    if (nameEl) {
      nameEl.textContent = String(f.name || '');
      nameEl.classList.add('has-file');
    }
    impPreview();
  });
}

/**
 * 功能：设置屏那颗「[导入]」—— 开导入向导（并把这一次向导的临时态清干净）。
 * @returns {void}
 */
export function lgImpOpen() {
  impFile = null;
  impDraft = null;
  impBusy = false;
  openImportSheet();
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
    openImportSheet();
  } finally {
    impBusy = false;
  }
}

/**
 * 功能：画**预览层**—— 认得出 N 笔（跨度）/ 将写入 M / 跳过 K /
 * 认不出 J（仅当有）/ 按月小计一张小表 ＋ 两颗按钮。
 *
 * 说明：⭐⭐ 两颗按钮 `取消` ｜ `确认导入`，⚠️ **默认焦点不在「确认导入」那颗** ——
 * 这里刻意**什么都不 `focus()`**（谁也不自动抢焦点），也不给任何一颗 `autofocus`。
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
  openSheet(
    '预览 · 导入三方数据',
    `<div class="lg-ed">
      <div class="lg-impcap">认得出 <b>${parsed}</b> 笔${esc(span)}</div>
      <div class="lg-impkv">将写入 <b>${insert}</b> 笔</div>
      <div class="lg-impkv">跳过 <b>${skip}</b> 笔</div>
      ${failed ? `<div class="lg-impkv warn">认不出 <b>${failed}</b> 笔（已原样保存、不进统计）</div>` : ''}
      <div class="lg-edcap2">按月小计</div>
      <div class="lg-imp-months">${rows}</div>
      <div class="m-tip">确认之后才真写进库；同一个文件再导一次不会重复写。</div>
    </div>`,
    `<button class="btn" type="button" data-act="lg-imp-cancel">取消</button>
     <button class="btn primary" type="button" data-act="lg-imp-go" style="flex:1.4">确认导入</button>`,
  );
}

/**
 * 功能：预览层那颗「确认导入」⇒ **把同一个文件再发一次**（`POST …/import/commit`）。
 *
 * 说明：⭐⭐ 三条：
 * 成功之后把明细屏那份缓存**作废**（`impRows` 清空 ＋ `lgLoad` 回 `idle`）：
 * 导入行变了、合计也变了，切回「明细」必须**重取**（⛔ 别让它画上一次那一份）；
 */
export async function lgImpGo() {
  if (!impFile || impBusy) return;
  impBusy = true;
  try {
    const r = await postRaw(`/api/ledger/import/commit?source=${IMP_SOURCE}`, impFile);
    const g = (r && r.result) || {};
    const ins = Number(g.inserted) || 0;
    const skp = Number(g.skipped) || 0;
    impFile = null;
    impDraft = null;
    // 明细屏那份缓存作废：⛔ 不清的话切回「明细」还画着导入前那一份（而且它不报错）。
    impRows = [];
    state.lgLoad = 'idle';
    openSheet(
      '导入完成',
      `<div class="lg-ed">
        <div class="lg-impcap">写入 <b>${ins}</b> 笔，跳过 <b>${skp}</b> 笔。</div>
        <div class="m-tip">这些账是只读的，列在「明细」里按天与自有流水混排。</div>
      </div>`,
      `<button class="btn" type="button" data-act="sheet-close">关闭</button>
       <button class="btn primary" type="button" data-act="lg-imp-godetail" style="flex:1.4">去明细看看</button>`,
    );
    await loadImportSummary();
  } catch (e) {
    if (!(e && e.status === 401)) toast(e.message, true);
  } finally {
    impBusy = false;
  }
}

/**
 * 功能：结果页那颗「去明细看看」⇒ 切到「明细」那一格并**重取**。
 *
 * 说明：⚠️ 不能只改 `state.lgSeg` 就重画：流水 / 合计 / 导入行都变了（刚导进来的那些
 * 根本不在手上），必须 `loadEntries(true)` 从第一页重取 —— 与 `mountLedger()`
 * 进明细那一格走的是**同一条路**。
 */
export async function lgImpGoDetail() {
  closeSheet();
  state.lgSeg = 'detail';
  state.lgMdMonth = 0;
  await loadEntries(true);
}

/**
 * 功能：向导里那颗「取消」⇒ 关弹层并把这一次向导的临时态清干净。
 * @returns {void}
 */
export function lgImpCancel() {
  impFile = null;
  impDraft = null;
  impBusy = false;
  closeSheet();
}

/**
 * 功能：设置里那颗「[清除]」⇒ 先弹一道**「警告」二次确认**。
 *
 * 说明：⚠️ 正文逐字是「将删除全部 N 笔鲨鱼记账导入的数据，且不可恢复」，确认那颗是**红色**。
 * 确认层的「确定」挂的是 `lg-imp-clearok`（⛔ 不是共用的 `cf-yes`）—— 与预算那条
 * 「清除总预算」同一条理由：这一句文案只对这一件事成立，别拿通用确认层凑。
 */
export function lgImpClear() {
  const n = impSummary ? Number(impSummary.count) || 0 : 0;
  openSheet(
    '警告',
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">将删除全部 ${n} 笔${esc(
      IMP_LABEL,
    )}导入的数据，且不可恢复</p>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="lg-imp-clearok" style="flex:1.4">确定</button>`,
  );
}

/**
 * 功能：「警告」里那颗「确定」⇒ 真去整批清除（`DELETE /api/ledger/import?source=shark`）。
 *
 * 说明：⭐⭐ 成功后两件事：
 * 刷新设置屏那块概况（`loadImportSummary()`）—— 笔数归零、那行变回「还没导入过」；
 * 把明细屏那份缓存**作废**（`impRows` 清空 ＋ `lgLoad` 回 `idle`）＋ 清掉两组合计，
 */
export async function lgImpClearok() {
  try {
    const r = await api('DELETE', `/api/ledger/import?source=${IMP_SOURCE}`);
    const deleted = Number(r && r.deleted) || 0;
    closeSheet();
    impRows = [];
    state.lgSum = null;
    state.lgDayTotals = null;
    state.lgLoad = 'idle';
    await loadImportSummary();
    toast(`清掉了 ${deleted} 笔`);
  } catch (e) {
    toast(e.message, true);
  }
}

// 重载恢复：「记一笔」与「改一笔」各自登记再打开一次（草稿由 `paintEntrySheet()` 里的 `openSheet()` 自动回填）
registerResume('ledger-entry', () => lgEntryAdd());
registerResume('ledger-edit', (p) => lgEntryEdit(null, { dataset: { id: String((p && p.id) || 0) } }));

