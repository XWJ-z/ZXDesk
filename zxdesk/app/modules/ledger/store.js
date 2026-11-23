'use strict';
/**
 * modules/ledger/store.js —— 记账业务方法
 * 功能：记账的业务方法 —— `ledgerAccounts`（本账号的账户，服务端**排好序**给两端）/
 * `ledgerAddAccount` / `ledgerUpdateAccount` / `ledgerDeleteAccount` /
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */
const { badRequest, notFoundErr } = require('../../core/store/helpers.js');
const { KINDS } = require('./lib/kinds.js');
const { summarize, summarizeTags } = require('./lib/money.js');
const { TAG_MAX, VIEW_MAX, BUILTIN_VIEWS } = require('./lib/views.js');
// 内置「按账户用途」那 7 个字段的种子与上限（唯一出处）
const { USAGE_SEED, USAGE_OTHER_KEY, USAGE_MAX } = require('./lib/usages.js');
// 余额派生（本模块**唯一的算法**）＋ 收支分类的口径（「其它」的判据只准一处）
// 全称与判重（`fullNameOf` / `nameTaken`）也住这儿 —— 与前端 `calc.js` 同口径，
// 新建 / 改名那一下的闸门就是它们（归档的也占着名字，见 `nameTaken()` 的说明）。
const { balanceOf, balancesOf, transferDelta } = require('./lib/balance.js');
const { OTHER_NAME, isOther, fullNameOf, nameTaken } = require('./lib/categories.js');
// **三方导入**里「鲨鱼记账」那一套格式口径（认哪些列、日期长什么样）——
// 别人的规矩只住那一个文件，⛔ 不散进本文件。
const shark = require('./lib/shark.js');
// ：三方导入的**来源注册表**（有哪些来源 / 各住哪张表 / 表里
// 该有哪些列）—— ⚠️ 合并取数一律**遍历它**（⛔ 绝不写死某一张表名），接口上的 `?source=`
// 也只认它里面的键：那是「加一个来源只改一处」这条口径的全部意义。
const { getSource, listSources } = require('./lib/import-sources.js');
// ：表格与编码的判定走**核心那一份**（`parseSheet()` 自己嗅格式、
// 「UTF-16 的 CSV 被当 GBK 解 ⇒ 回 `ok: true` 加一屏乱码」，纪律是宁可拒绝也不给乱码。
const sheet = require('../../core/sheet-parser.js');
// ：预算执行度与「按区间算钱」的纯函数层 ——
// 本文件**不自己 sum 金额**（见文件头），所有区间合计都从这一层出。
const {
  periodRange,
  usedFen,
  refundFen,
  incomeFen,
  remainFen,
  remainPct,
  dailyAvgFen,
} = require('./lib/budget.js');
// ：**CSV 序列化全仓只留一份**（`core/sheet/csv.js`）。
// 本文件不自己拼表（那与课表模板那份就是第二份 RFC 4180 转义）。
const { buildCsv } = require('../../core/sheet/csv.js');

/** 流水 / 账户详情一页的条数 —— ⭐ C-16：一次 30 条（⛔ 不用 offset，见 `before` 游标） */
const PAGE_SIZE = 30;
/** 备注历史候选的上限 —— ⭐ C-17：20 条（由**服务端一处**给，⛔ 不让两端各自 distinct） */
const NOTE_LIMIT = 20;

/**
 *
 * 说明：⚠️ 与 `routes.js` 的 `NOTE_MAX`（录入侧那道上限）**同值 200** —— 这不是巧合：
 */
const NOTE_READ_MAX = 200;

/** 搜索一次最多回几行（⛔ 不限的话一个「一」字能把整年的账全捞出来、手机端直接卡住）。 */
const SEARCH_LIMIT = 60;

/**
 * 功能：把一行账户整理成界面要的形状（同一份字段名，两端共用）。
 *
 * 说明：⚠️ 空值一律给出**稳定的空形状**（`''` 而不是 `null` / `undefined`）：
 * `opening_fen` / `sort_order` 压成整数：老库 / 手改过的 JSON 里可能是字符串，
 * 而前端拿它做算术会**静默**得到 `'5' + 1 = '51'` 这种结果。
 */
/**
 */
function fenOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function shape(r) {
  const fen = Number(r && r.opening_fen);
  const so = Number(r && r.sort_order);
  return {
    id: Number(r && r.id),
    kind: String((r && r.kind) || ''),
    name: String((r && r.name) || ''),
    tail: r && r.tail != null ? String(r.tail) : '',
    note: r && r.note != null ? String(r.note) : '',
    opening_fen: Number.isFinite(fen) ? Math.trunc(fen) : 0,
    sort_order: Number.isFinite(so) ? Math.trunc(so) : 0,
    // ：银行卡分级与三个限额（限额用 `null` 表示没设，见 `fenOrNull()`）
    tier: r && r.tier != null ? String(r.tier) : '',
    limit_day_fen: fenOrNull(r && r.limit_day_fen),
    limit_month_fen: fenOrNull(r && r.limit_month_fen),
    limit_year_fen: fenOrNull(r && r.limit_year_fen),
  };
}

/**
 * 功能：把一行快照整理成界面要的形状。
 *
 * 只保证是整数，免得字符串混进前端的图表算术里。
 *
 * @param {Object} r - 库里的行
 */
function snapShape(r) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
  };
  return {
    date: String((r && r.date) || ''),
    asset_fen: n(r && r.asset_fen),
    debt_fen: n(r && r.debt_fen),
    net_fen: n(r && r.net_fen),
  };
}

/**
 * 功能：算「这个类型在 `KINDS` 里的位置」—— 列表分组的顺序就是它。
 *
 * 说明：⚠️ 认不出的类型排在**最后**（回 `KINDS.length`）：它们本来就该是「绝不该出现」的行，
 * 界面上没有」这种最难查的形态）。
 *
 */
/**
 */
function viewShape(r) {
  const so = Number(r && r.sort_order);
  const bi = Number(r && r.builtin);
  return {
    id: Number(r && r.id),
    name: String((r && r.name) || ''),
    sort_order: Number.isFinite(so) ? Math.trunc(so) : 0,
    // 0=自建 / 1=按账户类型 / 2=按账户用途。⚠️ 前端要靠它决定两件事：
    // ① 这一颗胶囊能不能改名/删除；② 这一栏里该选的东西是**用途键**（2）还是**自由文本**（0）。
    builtin: Number.isFinite(bi) ? Math.trunc(bi) : 0,
  };
}

/**
 * 功能：把一行**分组字段**整理成界面要的形状（`ledger_groups` 的一行）。
 *
 * 说明：⚠️ `gkey` **必须下发**：前端要拿它去填内置「按账户用途」那一格的值
 * （归属存的是键，见 `schema.js`），⛔ 不是拿 `name` 去填 ——
 * 拿名字填等于把「改名不影响归属」这条设计从中间掐断。
 */
function groupShape(r) {
  const so = Number(r && r.sort_order);
  return {
    id: Number(r && r.id),
    scope: String((r && r.scope) || ''),
    gkey: String((r && r.gkey) || ''),
    name: String((r && r.name) || ''),
    sort_order: Number.isFinite(so) ? Math.trunc(so) : 0,
    locked: r && Number(r.locked) ? 1 : 0,
  };
}

/**
 * 功能：取「九类之间的先后」序号 —— 以 `ledger_groups` 的 `scope='kind'` 为准，缺项用常量兜底。
 *
 * 顺序住在 `ledger_groups` 那 9 行的 `sort_order` 上 ⇒ 这里把它折成 `kind 键 → 序号`。
 * 传了 `kindRank` 但里面没有这个键（老库脏数据、或那一行还没 seed）⇒ 回落到 `KINDS`
 * 的常量下标；两边都认不出 ⇒ **排最后**（`KINDS.length`）。
 */
function orderIndex(kind, kindRank) {
  const k = String(kind || '');
  if (kindRank && kindRank.has(k)) return kindRank.get(k);
  const i = KINDS.findIndex((x) => x.key === k);
  return i < 0 ? KINDS.length : i;
}

/**
 * 功能：把 `ledger_groups(scope='kind')` 的行折成 `kind 键 → 序号`（数组下标即顺序）。
 *
 * 说明：⚠️ 重复键取**第一次**出现的那个（`UNIQUE(user_id, scope, gkey)` 本该拦住重复，
 * 这里只是不让一份脏数据把顺序搅乱）。
 * @param {Array.<Object>} rows - 已排好序的 kind 分组行
 */
function kindRankOf(rows) {
  const rank = new Map();
  (Array.isArray(rows) ? rows : []).forEach((g, i) => {
    const k = String((g && g.gkey) || '');
    if (k && !rank.has(k)) rank.set(k, i);
  });
  return rank;
}

/**
 * 功能：把 `accounts` 排成「类型顺序 → 组内 `sort_order` → id」—— 这是**组与组之间**的顺序，
 * 组内顺序由原语给（两个后端逐字同序）。
 *
 * 排序只有这一份实现，两端因此不可能不一致。
 * 起「类型顺序」不再写死：来自 `ledger_groups` 的 `scope='kind'`（可由用户拖）。
 */
/**
 */
const NOSORT = 1e9;

function orderAccounts(rows, kindRank) {
  return rows
    .slice()
    .sort(
      (a, b) =>
        orderIndex(a.kind, kindRank) - orderIndex(b.kind, kindRank) || a.sort_order - b.sort_order || a.id - b.id,
    );
}

/**
 * 功能：把 epoch 毫秒转成**本地时区**的日期 `YYYY-MM-DD`。
 *
 * 说明：⭐ 与 `helpers.today()` 同一算法，但**入参是调用方给的时刻**（不是 `Date.now()`）——
 * 「今天」因此与这个请求里的其它时间同源，不会出现「跨零点前后半截状态」。
 * 服务端日期是**权威**（手机日期 / 时区不可靠），前端只管画。
 */
function dateOf(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：把 epoch 毫秒转成**本地时区**的记账时刻 `YYYY-MM-DD HH:MM:SS`（精确到秒）。
 *
 * 说明：⭐⭐ 二期的两张新表（条目 / 手动调整）的时刻列是 `at`，格式 `'YYYY-MM-DD HH:MM:SS'`
 * —— **定长 ⇒ 字典序就是时间序**（`lib/balance.js` 与按月区间取数都靠这一条）。
 * 与 `dateOf()` 同一条纪律：入参是**调用方给的时刻**（不是 `Date.now()`），
 */
function stampOf(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 功能：把一个 `YYYY-MM` 折成**左闭右开**的字典序区间 `{from, to}`。
 *
 * 本函数**不校验** `month` 的形状（那是接口层的事）—— 它只做算术。
 *
 * @param {string} month - `YYYY-MM`
 */
function monthRange(month) {
  const m = String(month || '');
  const y = Number(m.slice(0, 4)) || 0;
  const mo = Number(m.slice(5, 7)) || 1;
  const p = (n) => String(n).padStart(2, '0');
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return { from: `${m}-01`, to: `${ny}-${p(nm)}-01` };
}

/** 合法性只认 `YYYY-MM-DD` 这一种形状（⛔ 不做算术，算术是 `dayAfter()` 的事）。 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 功能：把 `YYYY-MM-DD` 平移 `n` 天（`n` 可负）—— 一天的算术**只准这一份**。
 *
 * 说明：⭐ 两个调用方：① 导出「结束时间是**含当天**的」要往后推一天（`dayAfter()`）；
 * ② 预算**继承**要找上一周的起点（`prevPeriodKeyOf()`）。走 `Date` 的本地历法
 * （与 `dateOf()` 同一套）⇒ 月末 / 年末 / 闰年都对。
 */
function shiftDaysOf(date, n) {
  const s = String(date || '');
  const y = Number(s.slice(0, 4)) || 0;
  const mo = Number(s.slice(5, 7)) || 1;
  const d = Number(s.slice(8, 10)) || 1;
  const t = new Date(y, mo - 1, d + Number(n || 0));
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/**
 * 功能：把 `YYYY-MM-DD` 往后推**一天** —— 导出那两颗日期框要用它（结束时间是**含当天**的）。
 *
 * 说明：⭐ 区间口径是**左闭右开**（`at >= 下界 AND at < 上界`，与 `monthRange()` / `periodRange()`
 * @param {string} date - `YYYY-MM-DD`
 * @returns {string} 第二天的 `YYYY-MM-DD`
 */
function dayAfter(date) {
  return shiftDaysOf(date, 1);
}

/**
 * 功能：某一期**上一期**的起点（周 = 上一周周一 / 月 = 上月一号 / 年 = 去年一号）。
 *
 * 说明：⭐ 预算**继承**要用它往回找（`ledgerBudgetView`）：这一期一行都没设 ⇒ 照上一期
 * （一直往上，直到找到设过的那一期为止）。
 * 三档的键都是**该期起始日** `YYYY-MM-DD`（与 `periodKey` 同一条口径）——
 */
function prevPeriodKeyOf(periodType, periodKey) {
  const type = String(periodType || '');
  const key = String(periodKey || '');
  if (type === 'week') return shiftDaysOf(key, -7);
  if (type === 'month') return `${prevMonthOf(key.slice(0, 7))}-01`;
  return `${Number(key.slice(0, 4)) - 1}-01-01`;
}

/**
 * 功能：往回找**最近一个设过预算的期** —— 这一期一行都没设时，预算就照它。
 *
 * 这周自动为 1200，用户可以通过编辑调整。月和年同理」）：先从**紧邻的上一期**找，
 * **有上限**（周 104 / 月 36 / 年 10）：⛔ 别无限往回找 —— 一个放了三年没动的号
 * 不该被十年前的一次设置复活。到顶还没找到 ⇒ 回 `null`（这一期就是"还没设"）。
 */
function inheritBudgetsOf(store, uid, periodType, periodKey) {
  const type = String(periodType || '');
  const maxBack = type === 'week' ? 104 : type === 'year' ? 10 : 36;
  let key = String(periodKey || '');
  for (let i = 0; i < maxBack; i += 1) {
    key = prevPeriodKeyOf(type, key);
    if (!key || key.length < 4) return null;
    const rows = store._bk.selectLedgerBudgets(Number(uid), type, key);
    if (rows && rows.length) return { rows, from: key };
  }
  return null;
}

/**
 * 功能：导出那一列**「来源」**写什么 —— 自有流水写 `ZXDesk`，三方导入写那家的**显示名**。
 *
 * 合并流（`statRowsOf()`）把两种行混在一张表里，光看导出的文件分不出哪笔是哪来的。
 * 显示名从**来源注册表**取（`getSource()`），⛔ 不在这里手写 `鲨鱼记账` 那几个字 ——
 * 以后加一家来源，这一列自动跟着对。
 */
function exportSourceLabel(source) {
  const src = String(source || '');
  if (src === LEDGER_SOURCE) return 'ZXDesk';
  const one = getSource(src);
  return one ? String(one.label || one.key || src) : src;
}

/**
 * 功能：这一行账户**该不该出现在界面里**（账户列表 / 合计 / 分组 / 图表 / 净值）。
 *
 * 说明：⭐⭐ **这条判据只准这一处**：空账户（`special = 1`）
 * 不显示、不进合计、不进分组、不进图表、不进净值 —— 但它的**余额照样算得出来**
 * （「其它账户怎么做就怎么做」，它只是一行多了两个属性的真账户）。
 */
function isListedAccount(r) {
  return Number(r && r.special) !== 1;
}

/**
 * 功能：**一次性**取全量数据并派生余额（`lib/balance.js` 的取数口）。
 *
 * 说明：⭐⭐ 四个数组都取**全量**（`listLedgerTransfersByUser` / `listLedgerEntries` 无 limit），
 * `now` 用**服务端时刻**（`stampOf`）：未来条目 / 未来调整因此不计入。
 * 返回的 `accounts` 是**库里的原行**（含空账户、含 `opening_fen` 原值）——
 */
function deriveLedger(store, uid, nowMs) {
  const me = Number(uid);
  const accounts = store._bk.listLedgerAccounts(me);
  const now = stampOf(nowMs);
  const balances = balancesOf({
    accounts,
    adjusts: store._bk.listLedgerAdjustmentsByUser(me),
    transfers: store._bk.listLedgerTransfersByUser(me),
    entries: store._bk.listLedgerEntries(me, {}),
    now,
  });
  return { accounts, balances, now };
}

/**
 * 功能：把派生余额**写进 `opening_fen`**，得到一份能喂给 `summarize()` / `summarizeTags()` 的行。
 *
 * 说明：⭐⭐ `lib/money.js` 读的就是 `opening_fen`（1 期那一列是「当前余额本身」）——
 * 二期的派生余额要顺着这条已有的口径走，就只能在**喂进去之前**把它填进去。
 * 改了它等于把用户的历史基准改掉，而且没有任何痕迹）。
 */
function withBalance(rows, balances) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const n = Number(balances[Number(r && r.id)]);
    return { ...r, opening_fen: Number.isFinite(n) ? Math.trunc(n) : 0 };
  });
}

/**
 * 功能：把「此刻的资产 / 负债 / 净值」写成**今天那一行**快照（一人一天最多一行）。
 *
 * 说明：⭐⭐ 这是本模块**唯一**会写 `ledger_snapshots` 的地方，且**只在写请求成功后**被调
 * （见文件头）。读一次全部账户与三类变动 → 派生余额 → `summarize()` → upsert。
 * 三个数**同源同一次**：`net_fen` 就是 `summarize()` 算出来的那个，⛔ 不在这里再减一遍。
 */
function snapshotToday(store, uid, nowMs) {
  const { accounts, balances } = deriveLedger(store, uid, nowMs);
  const s = summarize(withBalance(accounts.filter(isListedAccount), balances));
  store._bk.upsertLedgerSnapshot(
    Number(uid),
    dateOf(nowMs),
    { asset_fen: s.asset_fen, debt_fen: s.debt_fen, net_fen: s.net_fen },
    Math.round(Number(nowMs)),
  );
}

/**
 * 功能：把一行记账条目整理成界面要的形状（两端共用）。
 *
 * 说明：⚠️ `category_id` / `refund_of` **保留 `null`**（它们是「有没有」的事实：
 * `refund_fen` 是**派生量**（把 `refund_of` 指向它的退款金额加起来）——
 * `created_at` / `updated_at` 不下发（审计列，界面一个都用不上）。
 */
function entryShape(r, refundFen) {
  const fen = Number(r && r.amount_fen);
  const rf = Number(refundFen);
  const cid = Number(r && r.category_id);
  const rof = Number(r && r.refund_of);
  return {
    id: Number(r && r.id),
    at: String((r && r.at) || ''),
    ie: String((r && r.ie) || ''),
    amount_fen: Number.isFinite(fen) ? Math.trunc(fen) : 0,
    category_id: r && r.category_id != null && Number.isFinite(cid) ? cid : null,
    account_id: Number(r && r.account_id),
    refund_of: r && r.refund_of != null && Number.isFinite(rof) ? rof : null,
    note: r && r.note != null ? String(r.note) : '',
    refund_fen: Number.isFinite(rf) ? Math.trunc(rf) : 0,
  };
}

/**
 * 功能：把一行收支分类整理成界面要的形状（两端共用）。
 *
 * 说明：⚠️ `ie` 二级是空的（`''`，继承父）—— 界面靠它决定这颗胶囊出现在哪个 tab。
 * `archived` 是**布尔**（界面按它决定「选择器里出不出」）；`other` 是兜底分类标记
 * （「其它」不可归档 / 不可删，见 `isOther()`）—— 判据**只准一处**。
 */
function categoryShape(r) {
  const so = Number(r && r.sort_order);
  const pid = Number(r && r.parent_id);
  return {
    id: Number(r && r.id),
    parent_id: r && r.parent_id != null && Number.isFinite(pid) ? pid : null,
    name: String((r && r.name) || ''),
    ie: r && r.ie != null ? String(r.ie) : '',
    sort_order: Number.isFinite(so) ? Math.trunc(so) : 0,
    archived: !!(r && r.archived_at != null),
    other: isOther(r, null),
    builtin: !!(r && r.builtin),
  };
}

/**
 * 功能：把一行默认账户整理成界面要的形状。
 * @param {Object} r - 库里的行
 * @returns {Object} `{kind, category_id, account_id}`
 */
function defaultShape(r) {
  return {
    kind: String((r && r.kind) || ''),
    category_id: Number((r && r.category_id) || 0),
    account_id: Number(r && r.account_id),
  };
}

/**
 * 功能：把一行手动调整记录整理成界面要的形状（账户详情那第三类变动）。
 * @param {Object} r - 库里的行
 * @returns {Object} `{id, at, from_fen, to_fen}`
 */
function adjustShape(r) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
  };
  return {
    id: Number(r && r.id),
    at: String((r && r.at) || ''),
    from_fen: n(r && r.from_fen),
    to_fen: n(r && r.to_fen),
  };
}

/**
 * 功能：一次取回一批原条目的**累计已退金额**（`{ [原条目 id]: 分 }`）。
 *
 * 说明：⭐⭐ 一次列表要显示 N 行「已退多少」——一行查一次就是 N+1（`listLedgerRefunds` 的说明）。
 * 原语回的是**整行**（求和是业务口径）；空数组时它一次都不查库。
 *
 */
function refundSums(store, uid, entryIds) {
  const sums = new Map();
  for (const r of store._bk.listLedgerRefunds(Number(uid), entryIds)) {
    const k = Number(r && r.refund_of);
    sums.set(k, (sums.get(k) || 0) + (Math.trunc(Number(r && r.amount_fen)) || 0));
  }
  return sums;
}

/**
 * 功能：把入参里的 `account_id` 解析成一个**属于本人、且真实存在**的账户 id。
 *
 * 说明：⭐⭐ `null` / 不带 ⇒ 落**空账户**（一切「没有账户的账」的落点）——
 * 它由 `ensureLedgerSpecialAccount()` 幂等保证存在，所以这一步**不会写空**。
 * 给了却不是本人的 / 不存在 ⇒ **400**（这是请求体里引用的一个 id，不是被寻址的资源
 */
function resolveAccountId(store, uid, raw, stamp) {
  const me = Number(uid);
  if (raw == null) {
    const sp = store._bk.ensureLedgerSpecialAccount(me, stamp);
    if (!sp) throw badRequest('账户不存在');
    return Number(sp.id);
  }
  const acc = store._bk.getLedgerAccount(me, Number(raw));
  if (!acc) throw badRequest('账户不存在');
  return Number(acc.id);
}

/**
 * 功能：校验入参里的 `category_id`（不是本人的 / 不存在 / **已归档** ⇒ 400），返回它。
 *
 * 说明：⭐⭐ 「归档的分类不能被新条目选中」这条**只在写入新值的时候挡**
 * （§6.3 第 2 条）——历史条目照旧指着它，⛔ 本函数**不**用于读路径。
 * `null` = **未分类**，是合法值，直接放行。
 */
function resolveCategoryId(store, uid, raw) {
  if (raw == null) return null;
  const c = store._bk.getLedgerCategory(Number(uid), Number(raw));
  if (!c) throw badRequest('收支分类不存在');
  if (c.archived_at != null) throw badRequest('这个收支分类已经归档了，换一个');
  return Number(c.id);
}

/**
 * 功能：校验「把某条退款改成新金额」之后，**同一笔原交易的累计退款仍然 ≤ 原额**（C-13）。
 *
 * 说明：⭐⭐ 插入那条路（`insertLedgerRefund`）在**原语的一个事务里**判这条；
 * 「改一条已有退款」这条路上没有事务可用（原语只做整行写）⇒ 这里补一次同口径的判据。
 * 少了它，一次 `PUT` 就能把已退金额顶到原额以上（界面上显示「已退 130 / 原额 100」），
 */
function assertRefundFits(store, uid, origId, selfId, newFen) {
  const me = Number(uid);
  const orig = store._bk.getLedgerEntry(me, Number(origId));
  if (!orig) throw badRequest('这笔退款对应的原交易已经不在了');
  let sum = Math.trunc(Number(newFen)) || 0;
  for (const r of store._bk.listLedgerRefunds(me, [Number(origId)])) {
    if (Number(r && r.id) === Number(selfId)) continue;
    sum += Math.trunc(Number(r && r.amount_fen)) || 0;
  }
  if (sum > (Math.trunc(Number(orig.amount_fen)) || 0)) throw badRequest('退款总额不能超过这一笔的金额');
}

/**
 * 功能：把一行转账整理成界面要的形状（同一份字段名，两端共用）。
 *
 * 说明：⚠️ 与 `shape()` 同款口径：空值给稳定的空形状、整数列压成整数（老 JSON / 手改过的
 * 库里有可能是字符串，前端拿它做算术会**静默**算出 `'5' + 1 = '51'`）、
 * `created_at` 这个审计列不下发。
 */
function txShape(r) {
  const fen = Number(r && r.amount_fen);
  return {
    id: Number(r && r.id),
    date: String((r && r.date) || ''),
    from_id: Number(r && r.from_id),
    to_id: Number(r && r.to_id),
    amount_fen: Number.isFinite(fen) ? Math.trunc(fen) : 0,
    note: r && r.note != null ? String(r.note) : '',
  };
}

/**
 * 功能：年度下拉的选项 —— **今年** ∪ 有过快照的年（降序）。
 *
 * 说明：⭐⭐ `today` 必须是**服务端的「今天」那个年**（`dateOf(nowMs)`），⛔ **不是**「正在看的
 * **再也选不回 2026**（而界面上看不出少了什么，只当"今年没数据"）。
 * 只在**读路径**上用，不写库（GET 无副作用）。
 */
function snapshotYearsOf(store, uid, today) {
  const cur = Math.trunc(Number(String(today || '').slice(0, 4))) || 0;
  const set = new Set(store._bk.snapshotYears(uid).filter((y) => Number.isFinite(y) && y > 0));
  if (cur) set.add(cur);
  return [...set].sort((a, b) => b - a);
}

/**
 * 功能：**幂等地**补齐「内置的两颗分类 ＋ 九类顺序 ＋ 七个用途」——记账模块开箱可用的那副骨架。
 *
 * 说明：⭐⭐ 判据是「**那一组一行都没有**」而不是「缺哪行补哪行」——这是**防复活**：
 * 用户删掉「中转站」之后，若按「缺哪行补哪行」的思路，下次进这一屏它会**又冒出来**；
 * 而按「整组为空才灌」的判断：`usage` 有「其它」那一行（`locked`，删不掉）兜着，
 */
function seedLedger(store, uid, stamp) {
  const me = Number(uid);
  // ① 两颗内置分类（按账户类型 / 按账户用途）—— 它们**也入库**，胶囊顺序才有地方放
  if (!store._bk.listLedgerViews(me).some((v) => Number(v.builtin) > 0)) {
    for (const b of BUILTIN_VIEWS) {
      store._bk.insertLedgerView(me, {
        name: b.name,
        sort_order: b.sortOrder,
        builtin: b.builtin,
        created_at: stamp,
        updated_at: stamp,
      });
    }
  }
  // ② 九类的**显示顺序**（`name` 冗余存一份，显示仍以 lib/kinds.js 为准）
  if (!store._bk.listLedgerGroups(me, 'kind').length) {
    KINDS.forEach((k, i) => {
      store._bk.insertLedgerGroup(me, {
        scope: 'kind',
        gkey: k.key,
        name: k.name,
        sort_order: i,
        locked: 1,
        created_at: stamp,
        updated_at: stamp,
      });
    });
  }
  // ③ 内置「按账户用途」的七个字段（「其它」`locked`，其余可改名 / 可增删 / 可拖）
  if (!store._bk.listLedgerGroups(me, 'usage').length) {
    USAGE_SEED.forEach((u, i) => {
      store._bk.insertLedgerGroup(me, {
        scope: 'usage',
        gkey: u.gkey,
        name: u.name,
        sort_order: i,
        locked: u.locked ? 1 : 0,
        created_at: stamp,
        updated_at: stamp,
      });
    });
  }
  // （按后者的话，用户删掉的预置分类**下次进这一屏又冒出来**）——
  // 幂等住原语里，这里只负责「每次都喊一嗓子」。
  store._bk.seedLedgerCategories(me, stamp);
  const special = store._bk.ensureLedgerSpecialAccount(me, stamp);
  // 只在**缺**的时候补：用户改过之后就不动了（它不可删、只能改 ——  第 13 条）。
  const rows = store._bk.listLedgerDefaults(me);
  for (const kind of ['income', 'expense']) {
    const hit = rows.some((r) => String(r.kind) === kind && Number(r.category_id) === 0);
    if (!hit && special) store._bk.upsertLedgerDefault(me, kind, 0, Number(special.id), stamp);
  }
}

/**
 * 功能：把一组「分类 → 用途」写进去（建 / 改账户时调）。
 *
 * 说明：⭐ **归属校验住这里**（⛔ 不在 `routes.js`）：判据是「这套分类是不是你的」——
 * 那是**库里的数据**（形状校验仍住 `routes.js`）。
 * `tag` 空串 = **回到「其它」**（删掉那一行，⛔ 不写空串进库）：
 */
function applyTags(store, uid, accountId, tags, stamp) {
  const me = Number(uid);
  seedLedger(store, me, stamp);
  const mine = new Map(store._bk.listLedgerViews(me).map((v) => [Number(v.id), Number(v.builtin) || 0]));
  const usageKeys = new Set(store._bk.listLedgerGroups(me, 'usage').map((g) => String(g.gkey)));
  for (const [k, v] of Object.entries(tags || {})) {
    const vid = Number(k);
    if (!mine.has(vid)) throw badRequest('分类不存在');
    const builtin = mine.get(vid);
    if (builtin === 1) throw badRequest('「按账户类型」是按类型自动分组的，不用设用途');
    const tag = String(v == null ? '' : v).trim();
    if (tag.length > TAG_MAX) throw badRequest(`用途名不能超过 ${TAG_MAX} 个字`);
    if (tag && builtin === 2 && !usageKeys.has(tag)) throw badRequest('这个用途不存在（可能刚被删掉了）');
    if (tag) store._bk.upsertLedgerViewTag(me, vid, Number(accountId), tag, stamp);
    else store._bk.deleteLedgerViewTag(me, vid, Number(accountId));
  }
}

//
// 这一段的纪律（与文件头同款）：**算术只住 `lib/budget.js` 一份** ——
// 下面这些函数只做「取数 → 交给纯函数 → 拼形状」，⛔ 一个金额都不在这里加。

/**
 * 功能：`YYYY-MM` 的上一个月（跨年自动退位）。
 *
 * 说明：⚠️ 只做**月份串**的进位（⛔ 不碰 `Date`）：`'2026-01'` 的上一个月是 `'2025-12'` ——
 * 用 `new Date` 反而要多绕一圈时区（本模块的日期口径全靠定长串的字典序）。
 *
 */
function prevMonthOf(month) {
  const p = (n) => String(n).padStart(2, '0');
  const m = String(month || '');
  const y = Number(m.slice(0, 4)) || 0;
  const mo = Number(m.slice(5, 7)) || 1;
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12 : mo - 1;
  return `${py}-${p(pm)}`;
}

/**
 * 功能：以 `month` 为**终点**往前数 `n` 个月（含本月），升序给出每月的左闭右开区间。
 *
 * 说明：⭐ 月详情页的「近 N 个月对比」用它一次算出全部区间 —— 数据**一次取回**、
 *
 * @param {string} month - `YYYY-MM`
 */
function lastMonthsOf(month, n) {
  const out = [];
  let cur = String(month || '');
  for (let i = 0; i < n; i += 1) {
    out.unshift(cur);
    cur = prevMonthOf(cur);
  }
  return out.map((m) => ({ month: m, from: `${m}-01`, to: monthRange(m).to }));
}

/**
 * 功能：把「期」折成区间；档位不认识时抛 400（而不是让 `null` 变成 500）。
 *
 * 说明：⚠️ 三档白名单的**权威在接口层**（入参校验只住一处）—— 这里这一条**不是**
 * 第二份校验，而是「纯函数回了 `null`」时的兜底出口：不拦的话，一次拼错的档位会变成
 * `Cannot read properties of null`（500），那是一个**错误分类**（本来是 400）。
 */
function budgetRangeOf(periodType, periodKey) {
  const range = periodRange(periodType, periodKey);
  if (!range) throw badRequest('预算周期不认识');
  return range;
}

/**
 * 功能：一个预算块（**总预算** / **分类预算**）的界面形状。
 *
 * 说明：⭐⭐ 两种预算**共用这一个形状**（界面上图 4 的两块除了标签完全同构）：
 * `{amount_fen, used_fen, remain_fen, remain_pct, overspent, set}`。
 * 三条口径（都错了不报错）：
 */
function budgetBlockShape(row, used) {
  const set = !!row;
  const amount = set ? Math.trunc(Number(row.amount_fen)) || 0 : 0;
  const remain = remainFen(amount, used);
  return {
    amount_fen: amount,
    used_fen: Math.trunc(Number(used)) || 0,
    remain_fen: remain,
    remain_pct: remainPct(amount, remain),
    overspent: set && remain < 0,
    set,
  };
}

/**
 * 功能：一个区间的**收入 / 支出（净额）/ 退款**三个数（明细小计、账单的卡片与表格行都从它出）。
 *
 * 「支出」= 花掉的 − 退回来的（`usedFen()`）。
 * 这个数**前后改过两回**，别再翻来覆去，三次的来历写在这里：
 * 之前 = 净支出（`usedFen`）—— 那时「花 156.5、退 127.5」写成「支出 29.00」；
 */
function sumOf(rows, now, from, to) {
  return {
    income_fen: incomeFen(rows, now, from, to),
    expense_fen: usedFen(rows, now, from, to),
    refund_fen: refundFen(rows, now, from, to),
  };
}

/**
 * 功能：账单的**一行一卡**形状 —— `{key, income_fen, expense_fen, refund_fen, balance_fen}`。
 *
 * 说明：⭐ `key` = **该子期的起始日** `YYYY-MM-DD`（周 = 周一、月 = 1 号、年 = 1 月 1 日）——
 * 与 `period_key` / `ledger_budgets.period_key` **同一个口径**（同一个词只有一个意思）。
 * 界面上「1月 / 2026 / 本周」那类**文案**由前端排版（§7.5：期间标签住前端）——
 */
function sliceShape(rows, now, from, to, key) {
  const s = sumOf(rows, now, from, to);
  return {
    key: String(key || ''),
    income_fen: s.income_fen,
    expense_fen: s.expense_fen,
    refund_fen: s.refund_fen,
    // 「支出」已是净额 ⇒ 结余里**不再**加回退款（见本函数说明最后一段）
    balance_fen: s.income_fen - s.expense_fen,
  };
}

/**
 * 功能：`YYYY-MM-DD` 的**次日**（账单的「按天」切片的右端点）。
 *
 * 说明：⚠️ 与 `dateOf()` / `stampOf()` 同一条口径：走**本地时区**的日期算术 ——
 * `at` 本来就是按本地时刻写出来的（`stampOf`），所以切一天也必须用同一把尺子
 * （用 UTC 切会在有夏令时的时区差一天，而那是**静默**的）。
 */
function nextDayOf(date) {
  const [y, m, d] = String(date || '').split('-').map(Number);
  return dateOf(new Date(y, m - 1, d + 1).getTime());
}

/**
 * 功能：**按天小计**（`{'YYYY-MM-DD': {income_fen, expense_fen, refund_fen}}`）—— 明细屏组标题右侧那几个数。
 *
 * 说明：⭐⭐ 两条形状上的取舍：
 * **键 = 那一天有没有条目**（有就一定有这个键，哪怕那天只有未来条目 ⇒ 三个数都是 0）——
 * 见 `usedFen()`）—— 它**照样在 `entries` 列表里**，两件事是一致的、不是分开的。
 */
function dayTotalsOf(rows, now, from, to) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at || at < from || at >= to) continue;
    const day = at.slice(0, 10);
    if (out[day]) continue;
    const s = sumOf(rows, now, day, nextDayOf(day));
    out[day] = { income_fen: s.income_fen, expense_fen: s.expense_fen, refund_fen: s.refund_fen };
  }
  return out;
}

/**
 * 功能：一个区间的**卡片三个数**（账单屏 / 月详情页的「结余 / 收入 / 支出」）。
 *
 * 说明：⚠️ 与 `sliceShape()` 是同一份算术，只是卡片没有 `key`（它就是「这一屏的那一档」）——
 * 两处绝不各写一遍（那是两个真相源，而漂移的是钱）。
 *
 */
function cardOf(rows, now, from, to) {
  const s = sumOf(rows, now, from, to);
  return {
    income_fen: s.income_fen,
    expense_fen: s.expense_fen,
    refund_fen: s.refund_fen,
    balance_fen: s.income_fen - s.expense_fen,
  };
}

/**
 * 功能：百分比保留**一位小数**（`0.402` 那一档的「占比」—— §4.5 / §7.5 的显示口径）。
 *
 * 说明：⚠️ 分母为 0（或拿不到）⇒ 回 `null`：⛔ 不除零、⛔ 不显示 `0.0%`
 * （「算不出来」与「真的是 0」在界面上必须是两件事，前端 `fmtPct()` 把 `null` 画成 `—`）。
 * 服务端把它算好是**故意的**（§4.5：占比住服务端）—— 前端只做排版（一位小数）。
 */
function pctOf(fen, total) {
  const t = Math.trunc(Number(total)) || 0;
  if (!t) return null;
  // `×100` 先变成百分数，再 `×10` 取整 —— 一步写成 `/ t / 0.001` 那种花活容易少一位
  return Math.round(((Math.trunc(Number(fen)) || 0) / t) * 1000) / 10;
}

/**
 * 功能：把入参里的 `category_id` 解析成「总预算哨兵 `0`」或「一个属于本人、真实存在的分类 id」。
 *
 * 它**不是被寻址的资源、是入参字段** ⇒ 不存在 / 不是本人的一律 **400**（§6.2 明写
 * 与「访问别人的资源 ⇒ 404」区分开：那条是 URL 上那个 id，这条是请求体里的一个键）。
 * **已归档的分类允许设预算**（§6.2 只要求「存在且属于本账号」）：归档只挡「新条目选它」，
 */
function resolveBudgetCategoryIdOf(store, uid, raw) {
  const cid = Number(raw) || 0;
  if (!cid) return 0;
  if (!store._bk.getLedgerCategory(Number(uid), cid)) throw badRequest('收支分类不存在');
  return cid;
}

/**
 * 功能：**记账成就**（月详情页最后一块）：连续打卡 / 总天数 / 总笔数。
 *
 * 说明：⭐⭐ 三条口径（都写死，错了不报错）：
 * **只算 `at <= now`** 的条目（与全项目同一条：未来条目不进统计）；
 * `total_days` = 有记账的**天数**（按 `at` 前 10 个字符去重）；
 */
function achievementOf(rows, now, today) {
  const days = new Set();
  let count = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at) continue;
    if (now && at > now) continue;
    days.add(at.slice(0, 10));
    count += 1;
  }
  let streak = 0;
  let cur = String(today || '');
  while (cur && days.has(cur)) {
    streak += 1;
    cur = nextDayOf(cur);
  }
  return { streak_days: streak, total_days: days.size, total_count: count };
}

/**
 * 功能：把一个区间的流水按**显示名**分桶求和（支出侧：**花掉的原额**，退款不退减）。
 *
 * 说明：⭐⭐ 三条：
 * 分桶键是 `statRowsOf()` 给的 `name`（**显示名**，不是 `category_id`）——
 * 自有流水的「餐饮」与导入的「餐饮」因此**合到同一档**（「看得见的一致」）；
 */
function categoryBucketsOf(rows, now, from, to, refundSide) {
  const list = Array.isArray(rows) ? rows : [];
  const nameOf = (r) => String((r && r.name) == null ? '' : r.name);
  // 入桶判据：收入侧 = `ie='收入'` 且**不是退款**；支出侧 = `ie='支出'` **或**是退款
  // （退款要抵掉它自己那一类的支出 —— 判据与 `lib/budget.js` 的 `usedFen()` 同源）
  const inSide = (r) => {
    const at = String((r && r.at) == null ? '' : r.at);
    if (!at || at < from || at >= to) return false;
    const ie = String((r && r.ie) || '');
    if (refundSide) return ie === '收入' && !(r && r.refund_of != null);
    return ie === '支出' || !!(r && r.refund_of != null);
  };
  const names = new Set();
  for (const r of list) {
    if (inSide(r)) names.add(nameOf(r));
  }
  const out = [];
  for (const nm of names) {
    const sub = list.filter((r) => nameOf(r) === nm);
    // 自有那一档的 id：**第一个遇到的**自有行（`list` 是「自有在前、导入在后」）
    const own = list.find(
      (r) => nameOf(r) === nm && r && r.source === LEDGER_SOURCE && r.category_id != null,
    );
    out.push({
      category_id: own ? Number(own.category_id) : null,
      name: nm,
      ie: refundSide ? '收入' : '支出',
      amount_fen: refundSide ? incomeFen(sub, now, from, to) : usedFen(sub, now, from, to),
    });
  }
  // 平手的次序必须是判据：金额降序 → `category_id` 升序（**未分类 / 纯导入排最后**）
  const NIL = Number.MAX_SAFE_INTEGER;
  out.sort((a, b) => {
    if (a.amount_fen !== b.amount_fen) return b.amount_fen - a.amount_fen;
    return (a.category_id == null ? NIL : a.category_id) - (b.category_id == null ? NIL : b.category_id);
  });
  return out;
}

/**
 * 功能：把 `categoryBucketsOf()` 的分桶结果折成**占比表的一行行**（饼图 / 排行共用）。
 *
 * 说明：⭐⭐ 两条：
 * 「花 100 又退 100」那一档是 100、不再是 0 —— 见 `categoryBucketsOf()`），
 * 在占比表 / 饼图上都是一块**看不见的扇形 ＋ 一行 0.00**（纯噪声）；
 */
function pctRowsOf(buckets, total) {
  const out = [];
  for (const b of Array.isArray(buckets) ? buckets : []) {
    if (!Number(b && b.amount_fen)) continue;
    out.push({
      category_id: b.category_id == null ? null : Number(b.category_id),
      name: String((b && b.name) == null ? '' : b.name),
      ie: String((b && b.ie) == null ? '' : b.ie),
      amount_fen: Math.trunc(Number(b.amount_fen)) || 0,
      pct: pctOf(b.amount_fen, total),
    });
  }
  return out;
}

// ============================================================================
// ：图表与导出共用的那几个**纯**口径
//

/**
 * 功能：某个日期所在**自然周的周一**（`YYYY-MM-DD`）。
 *
 * 说明：⭐ 与前端 `calc.js` 的 `periodKeyOf('week', d)` **同口径**（本地时区 ＋ `(getDay()+6)%7`），
 * 两处写法必须一致 —— 不一致时「前端以为的周一」与「服务端给的周一」会差一天，
 * 而那种错**不报错**，只是某一周的数被劈成两半。
 */
function mondayOf(date) {
  const s = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dateOf(dt.getTime());
}

/**
 * 功能：某个 `YYYY-MM` 那个月有**多少天**。
 * @param {string} month - `YYYY-MM`（或任何 `YYYY-MM-…`）
 */
function daysInMonthOf(month) {
  const s = String(month || '');
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  if (!(y > 1900 && m >= 1 && m <= 12)) return 30;
  return new Date(y, m, 0).getDate();
}

/**
 *
 * 说明：⭐⭐ 「周账单只有本周，只能看到本周的叫周账单对吗？要能看到
 */
function weekMonthOf(monthKey) {
  const mr = monthRange(String(monthKey || '').slice(0, 7));
  const firstMon = mondayOf(mr.from);
  const mons = [];
  for (let mon = firstMon; mon && mon < mr.to; mon = shiftDaysOf(mon, 7)) mons.push(mon);
  // 兜底：认不出的键（不该走到，路由层先挡）⇒ 空清单，⛔ 别让 `mons[-1]` 抛出去
  if (!mons.length) return { from: mr.from, to: mr.to, month: mr, mons: [] };
  return { from: firstMon, to: shiftDaysOf(mons[mons.length - 1], 7), month: mr, mons };
}

/**
 * 功能：整数分 → **元**的两位小数串（CSV 导出给人看的那个数）。
 *
 * 说明：⚠️ 库里的钱一律是整数分；导出成 CSV 是给**人 / Excel** 看的 ⇒ 换成元。
 * 负数照实带 `-`（⛔ 不夹到 0 —— 「退得比花得多」是真事实）。
 * @param {number} fen - 整数分
 */
function yuanStr(fen) {
  const n = Math.trunc(Number(fen) || 0);
  return (n / 100).toFixed(2);
}

/**
 * 功能：一个期间**已过的细分单位数** —— 图表上「平均值」的**分母**。
 *
 * `69823.11 ÷ 7758.12 = 9`（年 → 已过月数）、`266.04 ÷ 38.01 = 7`（周 → 已过单位数）。
 * ⇒ 定成：**年 ÷ 已过月数｜月 ÷ 已过天数｜周 ÷ 已过周数**。
 * ⇒ 「周」这一档的计量单位从**天**变成了**周**，分母也就跟着从「恒 7（天）」改成
 */
function elapsedUnitsOf(periodType, range, today) {
  const from = String((range && range.from) || '');
  const to = String((range && range.to) || '');
  const t = String(today || '');
  if (!from || !t) return 0;
  if (t < from) return 0; // 期还没开始
  const ended = !!to && t >= to;
  if (periodType === 'year') return ended ? 12 : Number(t.slice(5, 7)) || 0;
  // 周档的分母从「恒 7」改成**已过的周数** —— 把周档改成「某个月的各周」
  // 之后，「7 天」不再是它的计量单位；现在它与「年 ÷ 已过月数 / 月 ÷ 已过天数」同构。
  if (periodType === 'week') {
    const mons = range && Array.isArray(range.mons) ? range.mons : [];
    if (!mons.length) return 7;
    return mons.filter((m) => !!t && m <= t).length;
  }
  const dim = daysInMonthOf(from);
  return ended ? dim : Number(t.slice(8, 10)) || 0;
}

/**
 * 功能：把一期摊成**折线的点**（年 → 12 个月 / 月 → 当月每一天 / 周 → 该月内每一周）。
 *
 * 说明：⭐⭐ 两条口径（都影响「图是不是在说谎」）：
 * **还没到的单位是 `null`**（月档这个月 30 天、今天 12 号 ⇒ 后 18 个是 `null`）——
 * 前端据此**不画点、线在缺口处断开**（1 期那六条判据之一：缺口 ⛔ 不断成 0）。
 */
function chartSeriesOf(periodType, rows, now, range, today, dir) {
  const inSide = dir === 'in';
  const pick = (s) => (inSide ? s.income_fen : s.expense_fen);
  const out = [];
  if (periodType === 'year') {
    const y = Number(String(range.from).slice(0, 4)) || 0;
    for (let m = 1; m <= 12; m += 1) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const r = monthRange(key);
      const started = !!today && r.from <= today;
      out.push({ key, fen: started ? pick(sumOf(rows, now, r.from, r.to)) : null });
    }
    return out;
  }
  if (periodType === 'week') {
    // 周档的点 = **该月内每一周**（`range.mons` 是各周的周一）——
    // 把周档从「本周」改成「某个月的各周」⇒ 点数从固定 7 变成 4~5。
    // 还没到的那一周给 `null`（与月 / 年档同一条判据：缺口 ⛔ 不画成 0）。
    const mons = range && Array.isArray(range.mons) ? range.mons : [];
    for (const mon of mons) {
      const started = !!today && mon <= today;
      out.push({ key: mon, fen: started ? pick(sumOf(rows, now, mon, shiftDaysOf(mon, 7))) : null });
    }
    return out;
  }
  const head = String(range.from).slice(0, 7);
  const dim = daysInMonthOf(range.from);
  for (let d = 1; d <= dim; d += 1) {
    const day = `${head}-${String(d).padStart(2, '0')}`;
    const started = !!today && day <= today;
    out.push({ key: day, fen: started ? pick(sumOf(rows, now, day, nextDayOf(day))) : null });
  }
  return out;
}

// ============================================================================
// 这一层的判据只有一条：`statRowsOf()` 是「自有流水 ＋ 各来源导入行」**唯一**的
// 「还要再加上导入行」（四份必然漂移，而且**都不报错**）。

/** 没有分类时那个**分组名**（「自有流水的未分类」与「导入行的空类别」合成同一档）。 @type {string} */
const NO_CATEGORY = '未分类';

/** 自有流水在合并流里的来源键（与各来源的 `key` 区分开）。 @type {string} */
const LEDGER_SOURCE = 'ledger';

/**
 * 功能：**合并流** —— 「自有流水 ＋ 各来源导入行」**唯一**的取数点。
 *
 * 说明：⭐⭐ 四条口径（每条错了都**不报错**，只是某一块数字悄悄不对）：
 * 自有那半来自 `ledger_entries`（`selectLedgerEntriesBetween`），并且**整行留下**
 * （`...r`）：退款判定要 `refund_of`、按分类取 id 要 `category_id`、按金额求和要
 */
function statRowsOf(store, uid, from, to, cats) {
  const me = Number(uid);
  const out = [];
  // 取不到名字就回「未分类」（与前端 `CAT_UNCLASSIFIED` 同一个词，两端看得见的一致）
  const nameOf = (id) => {
    if (id == null) return NO_CATEGORY;
    const c = cats && cats.get(Number(id));
    const nm = c ? String(c.name == null ? '' : c.name).trim() : '';
    return nm || NO_CATEGORY;
  };

  // ---- ① 自有流水（整行留下，见上方说明）----
  for (const r of store._bk.selectLedgerEntriesBetween(me, from, to) || []) {
    out.push({
      ...r,
      at: String((r && r.at) == null ? '' : r.at),
      ie: String((r && r.ie) == null ? '' : r.ie),
      fen: Math.trunc(Number(r && r.amount_fen)) || 0,
      name: nameOf(r && r.category_id != null ? Number(r.category_id) : null),
      source: LEDGER_SOURCE,
      ref_id: Number((r && r.id) || 0),
    });
  }

  // ---- ② 各来源的导入行（表名从注册表来，⛔ 不写死）----
  for (const src of listSources()) {
    for (const r of store._bk.selectImportedBetween(me, src.table, from, to) || []) {
      const fen = Math.trunc(Number(r && r.fen)) || 0;
      out.push({
        at: String((r && r.at) == null ? '' : r.at),
        ie: String((r && r.ie_raw) == null ? '' : r.ie_raw),
        fen,
        name: String((r && r.category) == null ? '' : r.category).trim() || NO_CATEGORY,
        source: String(src.key),
        ref_id: Number((r && r.id) || 0),
        // 给上面那几个纯函数一个稳定的「没有退款 / 没有我们的分类」（见本函数说明）
        amount_fen: fen,
        refund_of: null,
        category_id: null,
      });
    }
  }
  return out;
}

/**
 * 功能：取一段区间里的**全部导入行**（明细屏那个 `imported` 数组 ——）。
 *
 * 说明：⭐⭐ 三条：
 * **不分页**：明细屏的「加载更多」只管自有流水，导入行一次给全（前端因此
 * 取数**遍历注册表**（同 `statRowsOf()`），键名照接口契约（`snake_case`，
 */
function importedBetween(store, uid, from, to) {
  const me = Number(uid);
  const out = [];
  for (const src of listSources()) {
    for (const r of store._bk.selectImportedBetween(me, src.table, from, to) || []) {
      out.push({
        id: Number((r && r.id) || 0),
        source: String(src.key),
        source_label: String(src.label || ''),
        at: String((r && r.at) == null ? '' : r.at),
        ie: String((r && r.ie_raw) == null ? '' : r.ie_raw),
        fen: Math.trunc(Number(r && r.fen)) || 0,
        date_raw: r && r.date_raw != null ? String(r.date_raw) : '',
        category: r && r.category != null ? String(r.category) : '',
        account: r && r.account != null ? String(r.account) : '',
        amount_raw: r && r.amount_raw != null ? String(r.amount_raw) : '',
        note: r && r.note != null ? String(r.note) : '',
      });
    }
  }
  out.sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1));
  return out;
}

/**
 * 功能：一条导入行的**去重判据** —— 六列**原样列**拼成一个可直接比较的串。
 *
 * 说明：⚠️⭐ 判据用的是**原样列**（⛔ 不是派生列）：`at` 认不出的行也能正确判重；
 * 不含 `batch_id`（含了的话「再导一次同一份文件」会一条都跳不掉）。
 *
 */
function importKeyOf(at, ie, category, account, amountRaw, note) {
  const s = (v) => (v == null ? '' : String(v));
  return JSON.stringify([s(at), s(ie), s(category), s(account), s(amountRaw), s(note)]);
}

/**
 * 各来源的**解析器** —— 把 `parseSheet()` 的网格折成「六列原样 ＋ 两个派生值」。
 *
 */
const SOURCE_PARSERS = { shark: shark.parseSharkRows };

/**
 * 功能：造一个「文件不认 / 某一行不认」的 **400** —— 文案带行号，另带 `code` 供前端分支。
 *
 * 说明：⚠️ `code` 用**解析层回的那个**（`sheet.parseSheet()` 的或 `lib/shark.js` 的），
 * 不在这里另起一套名字。⚠️ 本文件造不了 `httpError`（那在 `core/http-util.js`，
 * 而它 require `core/context.js` ⇒ 反向依赖本模块）⇒ 这里按它的形状手工拼一个
 */
function importError(code, message) {
  const e = new Error(message);
  e.status = 400;
  e.extra = { code: String(code || 'import-bad-file') };
  return e;
}

/**
 * 功能：把接口上的 `source`（来源键）折成来源定义；**不认识 ⇒ 400**。
 *
 * 说明：⭐ 判据是**注册表**（`getSource()`）而不是写死的字面量 —— 以后加别家只加注册表一项，
 * 这一处一个字都不用改；⚠️ 认不出回的是 400（入参非法）而**不是** 404（那不是「访问了一个
 * 不存在的资源」，而是「这个来源键我根本不认识」）。
 */
function importSourceOf(sourceKey) {
  const src = getSource(sourceKey);
  if (!src) throw badRequest('不认识这个导入来源，现在只支持注册表里的那几种。');
  return src;
}

/**
 * 功能：**解析 ＋ 去重** —— 预览与写库**共用的那一份**（⛔ 不写第二套：预览说「将写入 340」，
 * commit 就必须正好写 340）。
 *
 * 说明：⭐⭐ 三条：
 * **解析**：字节 → 网格交给 `parseSheet()`（编码 / 格式的唯一判据），网格 → 行交给
 */
function planImport(store, uid, src, buf) {
  // ---- ① 字节 -> 网格（编码 / 格式判定走核心那一份；解不出来就拒绝）----
  const parsed = sheet.parseSheet(buf);
  if (!parsed.ok) throw importError(parsed.code, parsed.message);

  // ---- ② 网格 -> 行（别人的规矩住 lib/<来源>.js）----
  const parse = SOURCE_PARSERS[String(src.key)];
  if (!parse) throw importError('import-no-parser', '这个导入来源还没有解析器，请联系维护者。');
  const shaped = parse(parsed.rows);
  if (!shaped.ok) throw importError(shaped.code, shaped.message);

  // ---- ③ 库里已有的「同款」——**多重集**（有几条就只跳几条）----
  const pool = new Map();
  for (const r of store._bk.selectImportedBetween(Number(uid), src.table, '', '') || []) {
    const k = importKeyOf(r.at, r.ie_raw, r.category, r.account, r.amount_raw, r.note);
    pool.set(k, (pool.get(k) || 0) + 1);
  }

  // ---- ④ 逐行消费 ----
  const rows = [];
  const months = new Map();
  let skipped = 0;
  let firstAt = '';
  let lastAt = '';
  for (const it of shaped.rows) {
    const k = importKeyOf(it.at, it.ieRaw, it.category, it.account, it.amountRaw, it.note);
    const left = pool.get(k) || 0;
    if (left > 0) {
      pool.set(k, left - 1);
      skipped += 1;
    } else {
      // 写库要的就是这个形状（六列原样 ＋ `at` / `fen`）：原语自己按下标算 `row_no`
      rows.push(it);
    }
    const m = String(it.at).slice(0, 7);
    const b = months.get(m) || { month: m, income_fen: 0, expense_fen: 0, count: 0 };
    if (it.ieRaw === shark.IE_EXPENSE) b.expense_fen += it.fen;
    else if (it.ieRaw === shark.IE_INCOME) b.income_fen += it.fen;
    b.count += 1;
    months.set(m, b);
    if (!firstAt || it.at < firstAt) firstAt = it.at;
    if (!lastAt || it.at > lastAt) lastAt = it.at;
  }

  const draft = {
    source: String(src.key),
    source_label: String(src.label || ''),
    parsed: shaped.rows.length,
    insert: rows.length,
    skip: skipped,
    // 恒为 0：`lib/shark.js` 是**一行不认就整份不认**（回 400），走不到这里
    // ⇒ 没有「照存但不进统计」的行。字段留着，是为了契约形状与前端分支不被牵动。
    failed: 0,
    failed_rows: [],
    from: firstAt || null,
    to: lastAt || null,
    months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
  };
  return { rows, skipped, draft };
}

module.exports = {
  /**
   * 功能：列出本账号的全部账户，**服务端排好序**（`KINDS` 顺序 → 组内 `sort_order` → id）。
   *
   * 说明：⭐ 两端**直接顺序画**、不再排序（`orderAccounts()` 的说明）。
   * **空账户不在里面**（`isListedAccount()` —— 排除判据只准那一处）：
   * 它不显示、不进合计 / 分组 / 图表 / 净值，但它的余额照样算得出来。
   */
  ledgerAccounts(uid) {
    const me = Number(uid);
    // ：类型之间的先后来自 `ledger_groups` 的 `scope='kind'`（可被用户拖），
    // 缺行时 `orderIndex()` 自动回落到 lib/kinds.js 的常量顺序 ⇒ 这里不必 seed
    const rank = kindRankOf(this._bk.listLedgerGroups(me, 'kind'));
    return orderAccounts(this._bk.listLedgerAccounts(me).filter(isListedAccount).map(shape), rank);
  },

  /**
   * 功能：建一个账户 —— 落 `user_id` + 六个可写列 + 两个审计时刻，**成功之后落今天的快照**。
   *
   * 说明：⭐ `sort_order` = **同 `kind` 组内** `COALESCE(MAX(sort_order), -1) + 1`
   * 入参已由路由层归一化并校验（`kind` 必是九类之一、`opening_fen` 已是整数分），
   * 本方法不再重复校验 —— 校验只住一处（`routes.js`）。
   */
  ledgerAddAccount(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const stamp = Math.round(Number(nowMs));
    // 只跟**同一个 kind** 的兄弟比大小：组间排序不靠 sort_order（靠 KINDS）
    const siblings = this._bk.listLedgerAccounts(me).filter((r) => r.kind === src.kind);
    const maxSo = siblings.length
      ? Math.max(...siblings.map((r) => (Number.isFinite(Number(r.sort_order)) ? Number(r.sort_order) : 0)))
      : -1;

    const row = this._bk.insertLedgerAccount(me, {
      kind: src.kind,
      name: src.name,
      tail: src.tail || '',
      note: src.note || '',
      opening_fen: src.opening_fen,
      tier: src.tier || null,
      limit_day_fen: src.limit_day_fen == null ? null : src.limit_day_fen,
      limit_month_fen: src.limit_month_fen == null ? null : src.limit_month_fen,
      limit_year_fen: src.limit_year_fen == null ? null : src.limit_year_fen,
      sort_order: maxSo + 1,
      created_at: stamp,
      updated_at: stamp,
    });
    // 建的时候可以顺手带上用途（表单里那几格）—— 归属校验的是这一层（它本来就要读库）
    if (src.tags) applyTags(this, me, Number(row.id), src.tags, stamp);
    snapshotToday(this, me, nowMs);
    return shape(row);
  },

  /**
   * 功能：改一个账户 —— ⭐ **逐字段**：请求带哪个键改哪个键，没带的保持原样。
   *
   * 说明：⭐ 做法是「**先取现状 → 把 patch 合上去 → 整行写回**」：
   * 逐字段的语义在**合并**这一步实现（没带的键从现状里来），调用方不必先 GET 一遍；
   * 写回是**整行**（`updateLedgerAccount`），两个后端因此不必各拼一段 SET。
   */
  ledgerUpdateAccount(uid, id, patch, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const aid = Number(id);
    const cur = this._bk.getLedgerAccount(me, aid);
    if (!cur) throw notFoundErr('账户');
    // 空账户是系统行（不显示、不可删）⇒ 它的名字 / 基准都不该被接口改到
    if (!isListedAccount(cur)) throw badRequest('空账户改不了');
    const src = patch && typeof patch === 'object' ? patch : {};
    const stamp = Math.round(Number(nowMs));
    const next = shape(cur);
    for (const k of ['kind', 'name', 'tail', 'note', 'opening_fen', 'tier', 'limit_day_fen', 'limit_month_fen', 'limit_year_fen']) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    // 余额那一格：先问「新值是不是就是用户现在看到的那个数」——是的话什么都不用记
    const curShape = shape(cur);
    let adjustFrom = null;
    if (Object.prototype.hasOwnProperty.call(src, 'opening_fen')) {
      const curBal = balanceOf({
        account: cur,
        adjusts: this._bk.listLedgerAdjustmentsByUser(me),
        transfers: this._bk.listLedgerTransfersByUser(me),
        entries: this._bk.listLedgerEntries(me, {}),
        now: stampOf(nowMs),
      });
      if (Math.trunc(Number(curBal)) !== Math.trunc(Number(next.opening_fen))) adjustFrom = Math.trunc(Number(curBal));
    }
    this._bk.updateLedgerAccount(
      me,
      aid,
      {
        kind: next.kind,
        name: next.name,
        tail: next.tail,
        note: next.note,
        // 要走 `applyLedgerAdjustment` 时，这一遍**先把基准写成原值** ——
        // 于是「基准」这一列只有那一个原语会改动它；万一调整记录没写成功，
        // 留下的也是「什么都没变」而不是「基准变了、却没痕」（见上面那条说明）。
        opening_fen: adjustFrom === null ? next.opening_fen : curShape.opening_fen,
        tier: next.tier || null,
        limit_day_fen: next.limit_day_fen,
        limit_month_fen: next.limit_month_fen,
        limit_year_fen: next.limit_year_fen,
        sort_order: next.sort_order,
      },
      stamp,
    );
    if (adjustFrom !== null) {
      this._bk.applyLedgerAdjustment(me, aid, adjustFrom, next.opening_fen, stampOf(nowMs), stamp);
    }
    // 用途与账户字段一样走**逐键改**：带了几套分类就动那几套（空串 = 回到「其它」）
    if (src.tags) applyTags(this, me, aid, src.tags, stamp);
    snapshotToday(this, me, nowMs);
    return shape(this._bk.getLedgerAccount(me, aid));
  },

  /**
   * **转账 / 记账流水 / 手动调整一条都不动**。
   *
   */
  ledgerDeleteAccount(uid, id, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const aid = Number(id);
    const cur = this._bk.getLedgerAccount(me, aid);
    if (!cur) throw notFoundErr('账户');
    if (!isListedAccount(cur)) throw badRequest('空账户删不了');
    // 一个原语里「先写删除记录、后硬删账户行」（⛔ 不做成两件事：只写记录不删行 ⇒ 用户以为没删掉；
    // 只删行不写记录 ⇒ 那条明细从此显示不出账户名、而且再也补不回来）。
    // 原名字取**当前这一刻**的（调用方先取一次现状）—— 它就是要留档的那个名字。
    const ok = this._bk.deleteLedgerAccountWithRecord(me, aid, String(cur.name == null ? '' : cur.name), Math.round(Number(nowMs)));
    // 账户一走，它在各套「视图」里的用途行也一起走（1 期那套数据；⛔ 不留指向已删账户的孤儿行）
    this._bk.deleteLedgerTagsOfAccount(me, aid);
    // 转账 / 记账流水 / 手动调整**一条都不删**（它们的 id 照旧指着这个已经没有行的账户）——
    // `deleteLedgerTransfersOfAccount` 因此**不再被任何路径调用**（原语保留，见那边的说明）。
    snapshotToday(this, me, nowMs);
    return ok;
  },

  /**
   * 功能：列出「与某个账户有关」的全部转账（转出 + 转入），**服务端排好序**（日期倒序）。
   *
   * 说明：⭐ 账户详情页那份「收支明细」由它供数（`GET /api/ledger/transfers?account=`）。
   * **先确认这个账户存在且属于本人**：不存在 / 越权一律 404——
   * 「这个账户还没有流水」（把拒绝伪装成正常）。
   */
  ledgerTransfers(uid, accountId) {
    const me = Number(uid);
    const id = Number(accountId);
    if (!this._bk.getLedgerAccount(me, id)) throw notFoundErr('账户');
    return this._bk.listLedgerTransfers(me, id).map(txShape);
  },

  /**
   *
   * 说明：⭐⭐⭐ **本方法是全模块唯一需要区分 `side` 的地方**，而它必须区分：
   */
  ledgerAddTransfer(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const fromId = Number(src.from_id);
    const toId = Number(src.to_id);
    const from = this._bk.getLedgerAccount(me, fromId);
    const to = this._bk.getLedgerAccount(me, toId);
    // 两个账户都验：任一不命中就 404（越权与不存在逐字一致 ——）
    if (!from || !to) throw notFoundErr('账户');
    const amt = Math.trunc(Number(src.amount_fen)) || 0;
    // 先派生这两个账户**当前**的余额（比的是它，⛔ 不是库里那一列 opening_fen）
    const bal = balancesOf({
      accounts: [from, to],
      adjusts: this._bk.listLedgerAdjustmentsByUser(me),
      transfers: this._bk.listLedgerTransfersByUser(me),
      entries: this._bk.listLedgerEntries(me, {}),
      now: stampOf(nowMs),
    });
    const have = (row) => Math.trunc(Number(bal[Number(row.id)]) || 0);
    // 判「要减少的那一侧够不够」用 delta 的正负，而不是「是不是 from」——
    if (transferDelta({ kind: from.kind, role: 'from', amountFen: amt }) < 0 && amt > have(from)) {
      throw badRequest('转出账户的余额不够 —— 请先在详情页把余额改对');
    }
    if (transferDelta({ kind: to.kind, role: 'to', amountFen: amt }) < 0 && amt > have(to)) {
      throw badRequest('这张卡欠的没这么多 —— 先看看它的欠款是多少');
    }
    const stamp = Math.round(Number(nowMs));
    const row = this._bk.transferLedger(
      me,
      {
        date: dateOf(nowMs),
        from_id: fromId,
        to_id: toId,
        amount_fen: amt,
        note: src.note || '',
      },
      stamp,
    );
    // 原语回 null = 写的时候那两个账户没改到（理论上不该发生：上面刚验过）
    if (!row) throw notFoundErr('账户');
    // 余额变了 ⇒ 今天那一行快照跟着更新（净值不变，但资产 / 负债两侧会动）
    snapshotToday(this, me, nowMs);
    return txShape(row);
  },

  /**
   * 功能：把「一屏所需的全部」一次给全 —— 服务端「今天」+ 三个合计 + 分组小计 + 账户 + 当年快照。
   *
   * 说明：⭐ 合并成**一个** `GET /api/ledger/overview`（能合并的请求必须合并）：
   * 少一次请求、少一处 401 分支，而且进屏时「合计 / 列表 / 走势」三块不会各闪一次。
   * —— 它同时决定「今天的快照落在哪一天」与界面上的日期口径。
   */
  /**
   */
  ledgerViews(uid) {
    return this._bk.listLedgerViews(Number(uid)).map(viewShape);
  },

  /**
   * 功能：建一套自定义分类 —— ⭐ 到 `VIEW_MAX` 套再建就是 **400**（可见地拒绝，⛔ 不静默丢弃）。
   *
   * 说明：⚠️ 上限在**业务层**判（它要读现有几套），形状与名字长度在 `routes.js` 判 ——
   * 「能判纯形状的住接口层、要读库的住业务层」这条分工写在 `routes.js` 的 `checkTags` 上。
   * `sort_order` = 现有最大值 + 1 ⇒ 新分类排在最后（顶部胶囊的先后）。
   */
  ledgerAddView(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const stamp = Math.round(Number(nowMs));
    // 先播种：内置那两颗也是「分类」，上限与 `sort_order` 都要算上它们
    seedLedger(this, me, stamp);
    const cur = this.ledgerViews(me);
    // 上限只数**自建**的（`builtin === 0`）：内置两颗不占用户额度
    const mine = cur.filter((v) => !v.builtin);
    if (mine.length >= VIEW_MAX) throw badRequest(`最多只能建 ${VIEW_MAX} 套分类，先删掉一套`);
    const maxSo = cur.length ? Math.max(...cur.map((v) => v.sort_order)) : -1;
    const row = this._bk.insertLedgerView(me, {
      name: src.name,
      sort_order: maxSo + 1,
      created_at: stamp,
      updated_at: stamp,
    });
    return viewShape(row);
  },

  /**
   * 功能：改一套自定义分类（逐键：目前只有 `name`）。
   *
   * 说明：⚠️ 取不到就是 **404**（越权与不存在逐字一致 ——）。
   * 改名**不动**任何用途归属：归属挂在分类的 id 上，不挂在名字上。
   *
   */
  ledgerUpdateView(uid, id, patch, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cur = this._bk.getLedgerView(me, Number(id));
    if (!cur) throw notFoundErr('分类');
    // 不是「前端不画那颗按钮」：接口是公开的，靠界面兜等于没兜。
    if (Number(cur.builtin) > 0) throw badRequest('这是内置分类，名字不能改');
    const next = viewShape(cur);
    if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'name')) {
      next.name = patch.name;
    }
    this._bk.updateLedgerView(
      me,
      Number(id),
      { name: next.name, sort_order: next.sort_order },
      Math.round(Number(nowMs)),
    );
    return viewShape(this._bk.getLedgerView(me, Number(id)));
  },

  /**
   * 功能：删一套自定义分类 —— ⭐ **连同它的用途归属一起删**，⛔ 不动任何账户、不改一分钱。
   *
   * 说明：⭐ 与「删内置类目」那种事不同：删一套**视图**永远可以 ——
   * 它只是看账的一种方式（稿：分类是视图，不是账的一部分）。
   *
   */
  ledgerDeleteView(uid, id) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cur = this._bk.getLedgerView(me, Number(id));
    if (!cur) throw notFoundErr('分类');
    // 所有归属一起抹掉，而用户只是想收拾一下自己建的那几套。
    if (Number(cur.builtin) > 0) throw badRequest('这是内置分类，删不了');
    return this._bk.deleteLedgerView(me, Number(id));
  },

  /**
   * 功能：写一组「分类 → 用途」（建 / 改账户时用）—— 薄壳，真正干活的是 `applyTags()`。
   *
   * 说明：⚠️ 包一层是为了让 `routes.js` 之外的调用点（测试）也能用同一个入口，
   * 而校验与「空串 = 回到其它」的口径只有 `applyTags()` 一份。
   *
   */
  ledgerApplyTags(uid, accountId, tags, nowMs) {
    this._assertLedgerWritable();
    applyTags(this, uid, accountId, tags, Math.round(Number(nowMs)));
  },

  /**
   * 功能：列出本账号的分组字段（`scope` 给 'kind' 或 'usage'；不给就两套都给）。
   *
   * 说明：⚠️ 这是**只读**入口，⛔ 不播种（种子住 `seedLedger()`，由写路径与 overview 触发）——
   * 少一行就少一次「读操作偷偷写库」的机会，顺序也自然回落到常量。
   * @param {number} uid - 账号 id
   */
  ledgerGroups(uid, scope) {
    return this._bk.listLedgerGroups(Number(uid), scope || null).map(groupShape);
  },

  /**
   * 功能：新增一个**用途字段**（内置「按账户用途」那一套）。
   *
   * 说明：⭐⭐ 键（`gkey`）取「现有最大编号 + 1」：删掉中间某个再新增时**不会撞上**还活着的键；
   * 上限 `USAGE_MAX` 在业务层判（它要读现有几个），形状与名字长度在 `routes.js` 判。
   * 新用途插在最末 ⇒ 可能排到「其它」后面 ⇒ 收尾把「其它」再顶回最后。
   */
  ledgerAddUsage(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const stamp = Math.round(Number(nowMs));
    seedLedger(this, me, stamp);
    const cur = this._bk.listLedgerGroups(me, 'usage');
    if (cur.length >= USAGE_MAX) throw badRequest(`最多只能有 ${USAGE_MAX} 个用途，先删掉一个`);
    let maxN = 0;
    for (const g of cur) {
      const m = /^u(\d+)$/.exec(String(g.gkey || ''));
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    const maxSo = cur.length ? Math.max(...cur.map((g) => Number(g.sort_order) || 0)) : -1;
    const row = this._bk.insertLedgerGroup(me, {
      scope: 'usage',
      gkey: `u${maxN + 1}`,
      name: src.name,
      sort_order: maxSo + 1,
      locked: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    this._pushOtherLast(me, stamp);
    return groupShape(row);
  },

  /**
   * 功能：改一个用途字段（目前只有 `name`）—— ⭐ **改名不动任何账户归属**。
   *
   * 说明：⭐⭐ 这就是「用途可以重命名」的全部实现：改的是 `ledger_groups.name`，
   * 而归属存的是 `gkey`（`ledger_view_tags.tag`）⇒ 已经归在那组下面的账户
   * **自动**跟着新名走，一行数据都不必动。
   */
  ledgerUpdateUsage(uid, id, patch, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cur = this._bk.getLedgerGroup(me, Number(id));
    if (!cur || String(cur.scope) !== 'usage') throw notFoundErr('用途');
    const next = groupShape(cur);
    if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'name')) {
      next.name = patch.name;
    }
    this._bk.updateLedgerGroup(
      me,
      Number(id),
      { name: next.name, sort_order: next.sort_order },
      Math.round(Number(nowMs)),
    );
    return groupShape(this._bk.getLedgerGroup(me, Number(id)));
  },

  /**
   * 功能：删一个用途字段 —— ⭐ **原本归在它下面的账户挪到「其它」**，⛔ 不让它们凭空消失。
   *
   * 说明：⭐⭐ 顺序不能反：**先把归属挪到「其它」，再删字段**。反过来的话，中途失败会留下一批
   * 指向不存在字段的归属行 —— 界面上它们会变成一个「幽灵组」（金额还在总数里、
   * 却在任何一组下面都找不到），而且**不报错**。
   */
  ledgerDeleteUsage(uid, id, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cur = this._bk.getLedgerGroup(me, Number(id));
    if (!cur || String(cur.scope) !== 'usage') throw notFoundErr('用途');
    if (Number(cur.locked)) throw badRequest('「其它」是兜底用途，删不了');
    const stamp = Math.round(Number(nowMs));
    const view = this._bk.listLedgerViews(me).find((v) => Number(v.builtin) === 2);
    if (view) this._bk.reassignLedgerViewTags(me, Number(view.id), String(cur.gkey), USAGE_OTHER_KEY, stamp);
    return this._bk.deleteLedgerGroup(me, Number(id));
  },

  /**
   * 功能：重排（拖拽的落点）—— `what` 是 `'accounts'` / `'views'` / `'groups'`。
   *
   * 说明：⭐⭐ 三处排序共用一个入口，但**落到三个不同的原语**（表名在那两个后端里写死，
   * 不从接口层传表名 —— 那等于把三张表的安全属性换成「任意表都能重排」）。
   * `ids` 只给**这一屏里可见的那些**：列表外的行保持原样（前端漏传一个 id 时，
   */
  ledgerReorder(uid, what, ids, nowMs, viewId) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const stamp = Math.round(Number(nowMs));
    seedLedger(this, me, stamp);
    const key = String(what || '');
    const list = Array.isArray(ids) ? ids : [];
    if (key === 'accounts') return this._bk.reorderLedgerAccounts(me, list, stamp);
    if (key === 'views') return this._bk.reorderLedgerViews(me, list, stamp);
    // ：某一套分类**组内的先后**（拖账户行）—— 与 what=accounts 是两件事：
    // accounts 改的是账户表的 sort_order（同 kind 内），它会串到**所有**视图；
    // tags 只改这一套分类里的位置，别的视图一丝不动。
    if (key === 'tags') {
      const vid = Number(viewId) || 0;
      const mine = this.ledgerViews(me).some((v) => Number(v.id) === vid);
      if (!mine) throw notFoundErr('分类');
      return this._bk.reorderLedgerTags(me, vid, list, stamp);
    }
    if (key === 'groups') {
      const moved = this._bk.reorderLedgerGroups(me, list, stamp);
      this._pushOtherLast(me, stamp);
      return moved;
    }
    throw badRequest('排序对象不认识');
  },

  /**
   * 功能：把「其它」那一行的 `sort_order` 顶到最大（内部用，兜住「永远最后」这条纪律）。
   *
   * 说明：⚠️ 它已经比所有行大时**不写库**（幂等、少一次写入）；
   * 它是**唯一**一处「动「其它」的位置」的地方 —— 拖排序、新增用途都结尾调它。
   * @param {number} uid - 账号 id
   */
  _pushOtherLast(uid, stamp) {
    const me = Number(uid);
    const rows = this._bk.listLedgerGroups(me, 'usage');
    const other = rows.find((g) => String(g.gkey) === USAGE_OTHER_KEY);
    if (!other) return;
    const maxSo = rows.reduce((m, g) => Math.max(m, Number(g.sort_order) || 0), 0);
    if (Number(other.sort_order) >= maxSo) return;
    this._bk.updateLedgerGroup(
      me,
      Number(other.id),
      { name: String(other.name), sort_order: maxSo + 1 },
      stamp,
    );
  },

  /**
   * 功能：把「一屏所需的全部」一次给全 —— 服务端「今天」+ 三个合计 + 分组小计 + 账户 + 当年快照。
   *
   * 说明：⭐ 合并成**一个** `GET /api/ledger/overview`（能合并的请求必须合并）：
   * 少一次请求、少一处 401 分支，而且进屏时「合计 / 列表 / 走势」三块不会各闪一次。
   * —— 它同时决定「今天的快照落在哪一天」与界面上的日期口径。
   */
  ledgerOverview(uid, year, nowMs) {
    const me = Number(uid);
    // ：开这一屏之前先把骨架补齐（幂等种子：只在缺的那一组一行都没有时才写）
    // 它**不是**业务写：不改用户已有的任何一行，种完就再也不动了
    seedLedger(this, me, Math.round(Number(nowMs)));
    // **一次**派生（全部账户 + 三类变动）—— 下面「合计 / 账户行 / 分组小计」都用这一份
    const derived = deriveLedger(this, me, nowMs);
    // 喂给 `summarize()` / `summarizeTags()` 的行必须把**派生余额写进 `opening_fen`**（深拷贝）
    const listed = withBalance(derived.accounts.filter(isListedAccount), derived.balances);
    const s = summarize(listed);
    const views = this.ledgerViews(me);
    // ：九类的显示顺序（用户可拖）与内置用途那一套（名字可改、可增删）
    const kindRows = this._bk.listLedgerGroups(me, 'kind');
    const kindRank = kindRankOf(kindRows);
    const usages = this._bk.listLedgerGroups(me, 'usage').map(groupShape);
    // `shape()` 读的就是 `opening_fen` ⇒ 这里出来的余额已经是派生值；再给两端一个语义明确的
    // `balance_fen`（同一个数，⛔ 不是第二份算法）
    const accounts = orderAccounts(listed.map(shape), kindRank).map((a) => ({ ...a, balance_fen: a.opening_fen }));

    // 一套分类一次读全部归属行（⛔ 不「一个账户问一次」—— 那是 N+1）
    const tagsOfView = new Map();
    for (const v of views) {
      tagsOfView.set(
        v.id,
        new Map(
          this._bk
            .listLedgerViewTags(me, v.id)
            // ：值从「标签名」变成「标签名 + 组内位置」—— 后者是这套分类自己的顺序
            .map((t) => [
              Number(t.account_id),
              { tag: String(t.tag || ''), sort: Number(t.sort_order) || 0 },
            ]),
        ),
      );
    }
    // 每行带上「它在各套分类里算哪一组」：前端只做**摆放**，金额仍然只有服务端算
    // 内置「按账户用途」那一栏的值是**用途键**（如 u3），前端拿 `usages` 映射成名字
    const withTags = accounts.map((a) => {
      const tags = {};
      for (const v of views) {
        const rec = tagsOfView.get(v.id).get(a.id);
        if (rec && rec.tag) tags[v.id] = rec.tag;
      }
      return { ...a, tags };
    });
    // 组小计：代数和（资产正 / 负债负），口径唯一出处是 lib/money.js 的 summarizeTags()
    // ：内置「按账户用途」下，**没设用途的账户按「其它」计**（需求 3 的「其它（默认）」）——
    // 不让它们另起一组的话，屏幕上会出现**两个同名「其它」**：一个是显式选了「其它」的
    const viewPayload = views.map((v) => {
      const m = tagsOfView.get(v.id);
      const fallback = Number(v.builtin) === 2 ? USAGE_OTHER_KEY : '';
      const tagKeyOf = (a) => (m.get(a.id) || {}).tag || fallback;
      const g = summarizeTags(accounts, tagKeyOf);
      // ：组内的先后由**这套分类自己**决定（ledger_view_tags.sort_order）。
      // 这是「按账户用途」视图里能跨账户类型排序的唯一办法：账户表的 sort_order 只在
      // 同一个 kind 内部起作用，而一个用途组里混着现金 / 储蓄卡 / 虚拟账户 —— 靠它永远
      const members = new Map();
      accounts.forEach((a, i) => {
        const key = tagKeyOf(a);
        if (!key) return;
        const rec = m.get(a.id);
        const list = members.get(key) || [];
        list.push({ id: Number(a.id), sort: rec ? rec.sort : NOSORT, i });
        members.set(key, list);
      });
      return {
        id: v.id,
        name: v.name,
        sort_order: v.sort_order,
        // 起前端要靠它：内置两颗不能改名 / 删除；按用途那一栏填的是「用途键」
        builtin: v.builtin,
        // ：每组多给一个 ids —— 组内的行顺序**在这里算好**，前端只做摆放
        // （与「排序只有一份实现」同一条纪律：⛔ 别让两端各自去排）
        groups: g.groups.map((row) => ({
          tag: row.tag,
          total_fen: row.total_fen,
          count: row.count,
          ids: (members.get(String(row.tag)) || [])
            .slice()
            .sort((x, y) => x.sort - y.sort || x.i - y.i)
            .map((x) => x.id),
        })),
        unassigned: g.unassigned,
      };
    });

    return {
      today: dateOf(Number(nowMs)),
      totals: { asset_fen: s.asset_fen, debt_fen: s.debt_fen, net_fen: s.net_fen },
      // `groups` 只含有账户的组（空组整段不画）；它是 summarize() 给的，⛔ 不在这里重算
      // ：**顺序**照用户拖出来的类型顺序重排（`summarize()` 给的是常量顺序）
      groups: s.groups.slice().sort((a, b) => orderIndex(a.kind, kindRank) - orderIndex(b.kind, kindRank)),
      accounts: withTags,
      snapshots: this._bk.listLedgerSnapshots(me, year).map(snapShape),
      // ：年度下拉的**选项**（今年 ∪ 有过快照的年，降序）。
      // 传的是**服务端今天**，⛔ 不是 `year`（正在看的那一年）—— 传 `year` 的话
      // 用户换到 2024 看一眼，下拉里就只剩 2024/2023、**再也选不回今年**（静默）。
      years: snapshotYearsOf(this, me, dateOf(Number(nowMs))),
      views: viewPayload,
      // 新增的两块：内置用途那一套（含空组要用的定义）＋ 九类那 9 行
      usages,
      // 九类**也下发完整的行**（含行 id）—— 拖「按账户类型」的组顺序时要拿这些 id 去
      // `POST /api/ledger/reorder`（`groups` 那一份是 `summarize()` 给的：只有**有账户的**
      kindGroups: kindRows.map(groupShape),
    };
  },


  /**
   * 功能：流水列表 —— **按月 ＋ 游标倒序**，一次最多 `PAGE_SIZE` 条。
   *
   * 说明：⭐⭐ 三条口径：
   * **区间是字典序的 `[月初, 下月初)`**（`at` 定长 ⇒ 字典序 = 时间序），
   * `month` 的缺省（＝服务端今天那个月）由**路由层**算好传进来（⛔ 不在这里读时钟）；
   */
  ledgerEntries(uid, month, before, limit, nowMs) {
    const me = Number(uid);
    const { from, to } = monthRange(month);
    const lim = Number(limit) > 0 ? Math.trunc(Number(limit)) : PAGE_SIZE;
    const rows = this._bk.listLedgerEntries(me, { from, to, before: before || null, limit: lim });
    const sums = refundSums(this, me, rows.map((r) => Number(r.id)));
    const out = rows.map((r) => entryShape(r, sums.get(Number(r.id)) || 0));

    // 3 期搭车：明细屏要「当月收入 / 支出」
    // 与「按天分组的两个小计」，而这两样**只能由服务端算**（首屏能合并的请求必须合并；
    // 2 期 §5.4：前端不算钱）。⚠️ 两个数**一律转发** `sumOf()` / `dayTotalsOf()`（口径只住
    const now = Number.isFinite(Number(nowMs)) ? stampOf(Number(nowMs)) : '';
    // ：这一屏的合计与按天小计**含导入行** ——
    // 取数一律走 `statRowsOf()`（合并流；判据只住那一处，⛔ 不在这里手写「再加上导入行」）。
    // 它内部只调**一次** `selectLedgerEntriesBetween`（§9.1-⑨ 钉着「不做 N+1」那一条）。
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    const all = statRowsOf(this, me, from, to, cats);
    out.summary = sumOf(all, now, from, to);
    out.dayTotals = dayTotalsOf(all, now, from, to);
    // 该月**全部**导入行（不分页、按 `(at, id)` 升序）—— 前端拿它与自有流水按天混排
    out.imported = importedBetween(this, me, from, to);
    return out;
  },

  /**
   * 功能：**记一笔** —— 不选账户就落到**空账户**，⛔ 不选分类就是「未分类」（成功之后落今天的快照）。
   *
   * 说明：⭐⭐ 两条落值口径（都错了不报错、只是数据悄悄不对）：
   * `account_id` 给 `null` / 不带 ⇒ 写**空账户的 id**（一切「没有账户的账」的落点）
   * —— `ledger_entries.account_id` 因此**永远非空**，余额派生 / 筛选 / 统计只有一条路；
   */
  ledgerAddEntry(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const stamp = Math.round(Number(nowMs));
    seedLedger(this, me, stamp);
    const accountId = resolveAccountId(this, me, src.account_id, stamp);
    const categoryId = resolveCategoryId(this, me, src.category_id);
    const row = this._bk.insertLedgerEntry(
      me,
      {
        at: src.at,
        ie: src.ie,
        amount_fen: src.amount_fen,
        category_id: categoryId,
        account_id: accountId,
        note: src.note || '',
      },
      stamp,
    );
    snapshotToday(this, me, nowMs);
    return entryShape(row, 0);
  },

  /**
   * 功能：改一笔（**逐键**：带哪个键改哪个键，没带的保持原样）—— 成功之后落今天的快照。
   *
   * 说明：⚠️ **`refund_of` 改不了**（原语的可改列里刻意没有它）：它表达「这一条**是**退款」
   * 这个身份，放开等于一次 PUT 就能把普通记账**变成**退款（绕开「累计 ≤ 原额」那条校验）。
   * **改退款自己的金额**时要重判「累计 ≤ 原额」（C-13）—— 插入那条路的校验在事务里，
   */
  ledgerUpdateEntry(uid, id, patch, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const eid = Number(id);
    const cur = this._bk.getLedgerEntry(me, eid);
    if (!cur) throw notFoundErr('记账条目');
    const src = patch && typeof patch === 'object' ? patch : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const stamp = Math.round(Number(nowMs));
    const next = entryShape(cur, 0);
    for (const k of ['at', 'ie', 'amount_fen', 'category_id', 'account_id', 'note']) {
      if (has(k)) next[k] = src[k];
    }
    // 只有**真带了**这两个键才验归属 / 归档（没带就沿用现状，现状本来就是合法的）
    const categoryId = has('category_id') ? resolveCategoryId(this, me, src.category_id) : next.category_id;
    const accountId = has('account_id') ? resolveAccountId(this, me, src.account_id, stamp) : Number(cur.account_id);
    if (cur.refund_of != null && Math.trunc(Number(next.amount_fen)) !== Math.trunc(Number(cur.amount_fen))) {
      assertRefundFits(this, me, Number(cur.refund_of), eid, next.amount_fen);
    }
    this._bk.updateLedgerEntry(
      me,
      eid,
      {
        at: next.at,
        ie: next.ie,
        amount_fen: next.amount_fen,
        category_id: categoryId == null ? null : Number(categoryId),
        account_id: accountId,
        note: next.note || '',
      },
      stamp,
    );
    snapshotToday(this, me, nowMs);
    const sums = refundSums(this, me, [eid]);
    return entryShape(this._bk.getLedgerEntry(me, eid), sums.get(eid) || 0);
  },

  /**
   * 功能：删一笔 —— ⭐ **连带删掉「退的是它」的那些退款条目**（C-14），成功之后落今天的快照。
   *
   * 说明：⭐⭐ 为什么必须连带（`deleteLedgerEntry` 原语的说明）：退款与它的原交易是**同一件事的
   * 两半**，原交易一删，那些退款行就指向一个不存在的 id ⇒ 名字显示不出来，而钱**还在余额里**。
   * 两端的删除确认文案要说清这一点（手机上「一并删掉退款」）。
   */
  ledgerDeleteEntry(uid, id, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const eid = Number(id);
    if (!this._bk.getLedgerEntry(me, eid)) throw notFoundErr('记账条目');
    const ok = this._bk.deleteLedgerEntry(me, eid);
    snapshotToday(this, me, nowMs);
    return ok;
  },

  /**
   * 功能：给一笔原交易**记一笔退款**（累计 ≤ 原额在一个事务里判）—— 成功之后落今天的快照。
   *
   * 说明：⭐⭐ 四条口径：
   * 退款＝一条普通条目（`ie` 固定「收入」）＋ `refund_of` 指向原交易（⛔ 不新开表）；
   * **账户与类别默认沿用原交易**（钱退回原卡、类别不变），⛔ 不是「沿用最近一次」；
   */
  ledgerAddRefund(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const stamp = Math.round(Number(nowMs));
    seedLedger(this, me, stamp);
    const orig = this._bk.getLedgerEntry(me, Number(src.refund_of));
    if (!orig) throw notFoundErr('记账条目');
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    // C-25：没带的键**沿用原交易**；带了的按带的来（`null` = 明确选「不关联 / 未分类」）
    const accRaw = has('account_id') ? src.account_id : orig.account_id;
    const catRaw = has('category_id') ? src.category_id : orig.category_id;
    const accountId = resolveAccountId(this, me, accRaw, stamp);
    // 沿用的那个类别可能**已经归档**了（历史条目照旧指着它）⇒ 只在「用户真带了」时才挡
    const categoryId = has('category_id') ? resolveCategoryId(this, me, catRaw) : catRaw == null ? null : Number(catRaw);
    const row = this._bk.insertLedgerRefund(
      me,
      {
        at: src.at,
        amount_fen: src.amount_fen,
        category_id: categoryId,
        account_id: accountId,
        refund_of: Number(orig.id),
        note: src.note || '',
      },
      stamp,
    );
    if (!row) throw notFoundErr('记账条目');
    snapshotToday(this, me, nowMs);
    return entryShape(row, 0);
  },

  /**
   * 功能：**备注历史候选** —— 该账号（可限某一类别）用过的不重复备注，最近用过的在前（≤ 20 条）。
   *
   * 说明：⭐⭐ 它由**服务端一处**给出：⛔ 不新开表、⛔ 不让两端各自
   * `distinct`（各自实现必然漂移）。上限 20 是**业务口径**，所以住这里（原语只「给了就用」）。
   * `categoryId` 给 `null` ⇒ 取**全部类别**的候选（＝用户还没选类别时那一档，C-23）。
   */
  ledgerNoteCandidates(uid, categoryId) {
    return this._bk.listLedgerNoteCandidates(Number(uid), categoryId == null ? null : Number(categoryId), NOTE_LIMIT);
  },

  /**
   * 功能：列出本账号的**全部收支分类**（两级一次性给全，含已归档的）。
   *
   * 说明：⭐ 已归档的**也取回来**（前端按 `archived` 决定「选择器里出不出」）—— 历史流水照旧
   * 指着它们，名字照显。
   * **前端只管摆放**：顺序由原语按 `(一级在前, sort_order, id)` 给好。
   */
  ledgerCategories(uid) {
    return this._bk.listLedgerCategories(Number(uid)).map(categoryShape);
  },

  /**
   * 功能：新建一个收支分类 —— `parent_id` 给了就是**二级**，没给就是**一级**。
   *
   * `ie` **只有一级填**（二级写 `null`、继承父）—— 冗余存一遍必然与父漂移；
   * `name` 本身**允许重名**（与账户名同一条纪律），但它的**全称**要全局唯一（见下）。
   * 一级必须说明 `ie`（支出 / 收入）—— 它就决定这颗胶囊出现在哪个 tab；
   */
  ledgerAddCategory(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const stamp = Math.round(Number(nowMs));
    seedLedger(this, me, stamp);
    let parentId = null;
    if (src.parent_id != null) {
      const p = this._bk.getLedgerCategory(me, Number(src.parent_id));
      if (!p) throw badRequest('上一级收支分类不存在');
      if (p.archived_at != null) throw badRequest('上一级收支分类已经归档了');
      if (p.parent_id != null) throw badRequest('收支分类只有两级，二级下面不能再建');
      parentId = Number(p.id);
    } else if (src.ie !== '支出' && src.ie !== '收入') {
      throw badRequest('一级收支分类要说明是支出还是收入');
    }
    // 全称判重（判据与前端 `calc.js` 同一份口径）：候选全称撞上谁就报谁
    const all = this._bk.listLedgerCategories(me);
    const hit = nameTaken(all, fullNameOf(all, { name: src.name, parent_id: parentId }), 0);
    if (hit) throw badRequest(`已经有叫「${hit}」的分类了`);
    // 组内排最后（同 `parent_id` 里 `sort_order` 最大 + 1）
    const siblings = all.filter((c) => Number(c.parent_id || 0) === (parentId || 0));
    const maxSo = siblings.length ? Math.max(...siblings.map((c) => Number(c.sort_order) || 0)) : -1;
    const row = this._bk.insertLedgerCategory(
      me,
      // `builtin: 0` 写死：**用户建不出内置**（内置只有 seed 与「恢复内置分类」两条原语会写 1）
      { parent_id: parentId, name: src.name, ie: parentId == null ? src.ie : null, sort_order: maxSo + 1, builtin: 0 },
      stamp,
    );
    return categoryShape(row);
  },

  /**
   * 功能：改一个收支分类（**只允许改 `name` 与 `sort_order`**）。
   *
   * 另一侧（而流水那条记录上什么都没变）；改 `parent_id` 是「搬家」，那是另一件事。
   * 想改这两样只有一条路：归档重建（可见、可解释）。
   * （⛔ 不是名字 —— 用户也能建一个叫「餐饮」的，那一行是自定义），
   */
  ledgerUpdateCategory(uid, id, patch, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cid = Number(id);
    const cur = this._bk.getLedgerCategory(me, cid);
    if (!cur) throw notFoundErr('收支分类');
    // 内置那条**要先判**（见说明）：它连 `sort_order` 一起锁 —— 内置的先后由预置清单说了算
    if (Number(cur.builtin) === 1) throw badRequest('内置分类不能改名');
    if (isOther(cur, null)) throw badRequest(`「${OTHER_NAME}」是兜底分类，名字改不了`);
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = categoryShape(cur);
    const renaming = Object.prototype.hasOwnProperty.call(src, 'name');
    if (renaming) next.name = src.name;
    if (Object.prototype.hasOwnProperty.call(src, 'sort_order')) next.sort_order = src.sort_order;
    // 判重**在既有那几条之后**（见说明）：候选全称 = 一级就是名字、二级是「父名-本名」
    if (renaming) {
      const all = this._bk.listLedgerCategories(me);
      const hit = nameTaken(all, fullNameOf(all, { name: next.name, parent_id: cur.parent_id }), cid);
      if (hit) throw badRequest(`已经有叫「${hit}」的分类了`);
    }
    this._bk.updateLedgerCategory(me, cid, { name: next.name, sort_order: next.sort_order }, Math.round(Number(nowMs)));
    return categoryShape(this._bk.getLedgerCategory(me, cid));
  },

  /**
   * 功能：**归档**一个收支分类（行留着、选择器里不再出现）—— 父分类要让用户选子分类怎么办。
   *
   * 说明：⭐⭐ 删除＝归档：⛔ 不物理删、⛔ 不把流水挪到「其它」。
   * **归档父分类时必须选**：
   * `mode = 'move-children'` ⇒ 把它的子分类**整批挂到同一侧那个「其它」**下面
   */
  ledgerArchiveCategory(uid, id, mode, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cid = Number(id);
    const cur = this._bk.getLedgerCategory(me, cid);
    if (!cur) throw notFoundErr('收支分类');
    if (Number(cur.builtin) === 1) throw badRequest('内置分类不能删除');
    if (isOther(cur, null)) throw badRequest(`「${OTHER_NAME}」是兜底分类，删不了`);
    const stamp = Math.round(Number(nowMs));
    const kids = this._bk.listLedgerCategories(me).filter((c) => Number(c.parent_id) === cid);
    if (kids.length) {
      if (String(mode) === 'move-children') {
        // 落点必须是**同一侧**的「其它」（父的 `ie`）—— 挪到另一侧就是把支出静默变成收入
        const other = this._bk
          .listLedgerCategories(me)
          .find((c) => c.parent_id == null && isOther(c, cur.ie));
        if (!other) throw badRequest(`找不到同一侧的「${OTHER_NAME}」，没法把子分类挪过去`);
        this._bk.reassignLedgerCategoryChildren(me, cid, Number(other.id), stamp);
      } else {
        // `mode = 'archive'`（缺省）：子分类**一起归档**（用户选的就是这一条）
        for (const k of kids) this._bk.archiveLedgerCategory(me, Number(k.id), stamp);
      }
    }
    this._bk.archiveLedgerCategory(me, cid, stamp);
    return categoryShape(this._bk.getLedgerCategory(me, cid));
  },

  /**
   * 功能：**取消归档**一个收支分类（把 `archived_at` 清成 `null`，其余一个字都不动）。
   *
   * 说明：⭐ 它是「删除＝归档」那条口径的**回程**：归档是行留着、只在
   * 选择器里消失；恢复就是让那一行**重新可选**，历史流水本来就一直指着它。
   * **不判重**（它的全称本来就还占着 —— 判重不排除已归档的，所以不会撞上自己）。
   */
  ledgerRestoreCategory(uid, id, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cid = Number(id);
    const cur = this._bk.getLedgerCategory(me, cid);
    if (!cur) throw notFoundErr('收支分类');
    if (cur.archived_at == null) throw badRequest('这个分类本来就没归档');
    this._bk.restoreLedgerCategory(me, cid, Math.round(Number(nowMs)));
    return categoryShape(this._bk.getLedgerCategory(me, cid));
  },

  /**
   * 功能：**真删除**一个收支分类 —— 一个动作里把「它名下与它下面的东西」都安顿好。
   *
   * 说明：⭐⭐ 与「归档」是两件事（归档＝行留着、可恢复；这里是**行没了**）。四件事的
   * **顺序不能乱**（的口径）：
   * ① 它**名下（直接挂在它身上）的流水** ⇒ 改挂到**同侧**的「其它」（金额 / 时刻 / 账户一个字不改）；
   */
  ledgerDeleteCategory(uid, id, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const cid = Number(id);
    const cur = this._bk.getLedgerCategory(me, cid);
    if (!cur) throw notFoundErr('收支分类');
    // 内置那条**先判**（它自己也是「变相删除」的边界），再判兜底「其它」—— 与归档同一顺序
    if (Number(cur.builtin) === 1) throw badRequest('内置分类不能删除');
    if (isOther(cur, null)) throw badRequest(`「${OTHER_NAME}」是兜底分类，不能删除`);
    const all = this._bk.listLedgerCategories(me);
    // 「同侧」= 一级看它自己的 `ie`；二级的 `ie` 是 NULL（继承父）⇒ 退到父那一侧
    let side = cur.ie == null ? null : String(cur.ie);
    if (side == null && cur.parent_id != null) {
      const p = all.find((c) => Number(c.id) === Number(cur.parent_id));
      side = p ? String(p.ie == null ? '' : p.ie) : null;
    }
    const other = all.find((c) => c.parent_id == null && isOther(c, side));
    if (!other) throw badRequest(`找不到同一侧的「${OTHER_NAME}」，没法把记的账挪过去`);
    const otherId = Number(other.id);
    const stamp = Math.round(Number(nowMs));
    // 顺序即上面 ①②③④（改挂类的原语各自幂等、只动该动的那一列）
    const movedEntries = this._bk.reassignLedgerCategoryEntries(me, cid, otherId, stamp);
    const movedChildren = this._bk.reassignLedgerCategoryChildren(me, cid, otherId, stamp);
    this._bk.deleteLedgerDefault(me, 'category', cid);
    this._bk.deleteLedgerCategory(me, cid);
    // 成功路径也带判据字段（只给失败路径给字段会被记成失败）：两个都是**真改到的行数**
    return { ok: true, movedEntries, movedChildren };
  },

  /**
   * 功能：**恢复内置分类** —— 把本账号的收支分类对齐到内置清单（补全内置 ＋ **硬删**旧预置）。
   *
   * 说明：⭐⭐ 这是换内置清单（34 行 → 22 行）时要的那个动作：
   * 旧清单里还在新清单里的名字**原地保留**、只是被标成内置（`marked`）；
   * 新清单里缺的**补上**（`added`，`builtin = 1`）；
   */
  ledgerRestoreBuiltin(uid, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const counts = this._bk.restoreBuiltinCategories(me, Math.round(Number(nowMs)));
    return { ok: true, ...counts, categories: this.ledgerCategories(me) };
  },

  /**
   * 功能：默认账户（全局两层 ＋ 每类别一层）—— 取值顺序的**前两级与兜底**都在这一份里给全。
   *
   * 说明：⭐⭐ 取值顺序是 **类别默认 → 全局默认（按这笔的收 / 支）→ 空账户**。
   * 本方法给的是**前两级**：
   * `income` / `expense` ＝ 全局两层那两行**解析后**的账户 id；
   */
  ledgerDefaults(uid) {
    const me = Number(uid);
    const rows = this._bk.listLedgerDefaults(me);
    const alive = new Set(this._bk.listLedgerAccounts(me).map((r) => Number(r.id)));
    const pick = (kind) => {
      const r = rows.find((x) => String(x.kind) === kind && Number(x.category_id) === 0);
      const id = r ? Number(r.account_id) : 0;
      return alive.has(id) ? id : null;
    };
    return {
      income: pick('income'),
      expense: pick('expense'),
      categories: rows
        .filter((r) => String(r.kind) === 'category')
        .map((r) => {
          const id = Number(r.account_id);
          return { category_id: Number(r.category_id), account_id: alive.has(id) ? id : null };
        }),
    };
  },

  /**
   * 功能：设一行默认账户（**upsert**：`(kind, category_id)` 是唯一落点）—— 全局两层也走这里。
   *
   * 说明：⚠️ `categoryId` 的取值：全局两层传 **`0`**（哨兵，⛔ 不是 `null` —— SQLite 的 `UNIQUE`
   * `kind = 'category'` 时它是那份分类的 id（必须是本人的分类）。
   * 账户校验住这里（要读库）：默认账户**可以指向空账户**（＝「没设过」那一档）。
   */
  ledgerSetDefault(uid, kind, categoryId, accountId, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const k = String(kind || '');
    if (k !== 'income' && k !== 'expense' && k !== 'category') throw badRequest('默认账户的类型不认识');
    const cid = Number(categoryId) || 0;
    if (k === 'category') {
      if (!cid) throw badRequest('要说清是哪个收支分类的默认账户');
      if (!this._bk.getLedgerCategory(me, cid)) throw badRequest('收支分类不存在');
    } else if (cid) {
      throw badRequest('全局默认只分收入 / 支出两层');
    }
    const acc = this._bk.getLedgerAccount(me, Number(accountId));
    if (!acc) throw badRequest('账户不存在');
    return defaultShape(this._bk.upsertLedgerDefault(me, k, cid, Number(acc.id), Math.round(Number(nowMs))));
  },

  /**
   * 功能：清掉一行默认账户 —— ⭐ **只该用于「每类别」那一层**（全局两层删不掉）。
   *
   * 说明：⭐⭐ 全局两层（`income` / `expense`）是**固定两层、只能改**：
   * 删掉它，界面上那两个格子就再也没有「怎么回到默认」这条路了。
   * ⇒ 这条判据**住这里**（⛔ 不是靠界面不画按钮：接口是公开的，靠界面兜等于没兜）。
   */
  ledgerClearDefault(uid, kind, categoryId) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const k = String(kind || '');
    if (k !== 'income' && k !== 'expense' && k !== 'category') throw badRequest('默认账户的类型不认识');
    if (k !== 'category') throw badRequest('全局默认的收支两层不能删，只能改');
    const cid = Number(categoryId) || 0;
    if (!cid) throw badRequest('要说清是哪个收支分类的默认账户');
    return this._bk.deleteLedgerDefault(me, k, cid);
  },

  /**
   * 功能：账户详情那一屏 —— **三类变动混排**（记账 ＋ 转账 ＋ 手动调整）＋ 游标 ＋ 类型过滤。
   *
   * 说明：⭐⭐ 三条：
   * **排序 = 时刻倒序、同一时刻按 `id` 倒序**（C-2：同一分钟内两笔按落库次序兜底 ⇒
   * 顺序永远确定，⛔ 不出现"随机顺序"）；
   */
  ledgerAccountChanges(uid, accountId, month, before, type) {
    const me = Number(uid);
    const aid = Number(accountId);
    if (!this._bk.getLedgerAccount(me, aid)) throw notFoundErr('账户');
    const { from, to } = monthRange(month);
    const t = String(type || 'all');
    const inMonth = (at) => at >= from && at < to;
    const items = [];

    if (t === 'all' || t === 'entry') {
      const rows = this._bk
        .listLedgerEntries(me, { from, to })
        .filter((r) => Number(r.account_id) === aid);
      const sums = refundSums(this, me, rows.map((r) => Number(r.id)));
      for (const r of rows) items.push({ type: 'entry', ...entryShape(r, sums.get(Number(r.id)) || 0) });
    }
    if (t === 'all' || t === 'transfer') {
      for (const r of this._bk.listLedgerTransfers(me, aid)) {
        const at = String(r.date || '');
        if (!inMonth(at)) continue;
        items.push({
          type: 'transfer',
          id: Number(r.id),
          at,
          from_id: Number(r.from_id),
          to_id: Number(r.to_id),
          amount_fen: Math.trunc(Number(r.amount_fen)) || 0,
          note: r.note != null ? String(r.note) : '',
        });
      }
    }
    if (t === 'all' || t === 'adjust') {
      for (const r of this._bk.listLedgerAdjustmentsByUser(me)) {
        if (Number(r.account_id) !== aid) continue;
        const at = String(r.at || '');
        if (!inMonth(at)) continue;
        items.push({ type: 'adjust', ...adjustShape(r) });
      }
    }

    // 倒序：时刻大的在前、同一时刻 id 大的在前
    items.sort((a, b) => (a.at === b.at ? b.id - a.id : a.at < b.at ? 1 : -1));
    const cur = before && before.at != null ? before : null;
    const kept = cur
      ? items.filter((r) => r.at < String(cur.at) || (r.at === String(cur.at) && r.id < (Number(cur.id) || 0)))
      : items;
    return kept.slice(0, PAGE_SIZE);
  },

  /**
   * 功能：取「账户 id → 名字」的**合并视图**（账户表 ∪ 删除记录表）—— 两端显示账目的**唯一取名口**。
   *
   * 说明：⭐⭐ 为什么必须合成一处：转账明细、流水列表、账户筛选**都要**
   * 显示账户名，而「先查账户表、查不到再查删除记录表」这条判据写两遍**必然漂移**
   * —— 漂移的表现是「同一个账户，在流水里显示得出名字、在转账明细里显示不出来」。
   */
  ledgerAccountNames(uid) {
    return this._bk.ledgerAccountNames(Number(uid));
  },

  //
  // 这一段的纪律（与文件头 / 3 期辅助函数那一段同款）：**算术只住 `lib/budget.js` 一份** ——
  // 下面每个方法都只做「取数 → 交给纯函数 → 拼形状」，⛔ 一个金额都不在这里加。

  /**
   * 功能：**预算屏一屏** —— 该期的总预算 ＋ 分类预算，每块给「已用 / 剩余 / 剩余 % / 超支」。
   *
   * 说明：⭐⭐ 四条（每条错了都**不报错**、只是界面上的数悄悄不对）：
   * **两层是两种切法，不是父子求和**：总预算的「已用」= 该期**全部**支出，
   * 某个分类预算的「已用」只算**它自己那一类**（分类预算之间可以重叠 —— T48-④
   */
  ledgerBudgetView(uid, periodType, periodKey, nowMs) {
    const me = Number(uid);
    const type = String(periodType || '');
    const key = String(periodKey || '');
    const range = budgetRangeOf(type, key);
    const now = stampOf(Number(nowMs));
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    // 只取**这一期**的流水（原语按 `at` 的字典序区间取；⛔ 原语不算钱、⛔ 不过滤未来）
    const merged = statRowsOf(this, me, range.from, range.to, cats);
    // ：**分类预算**那一块只看**自有流水**
    // —— 导入行没有我们的 `category_id`，归不进任何分类预算；⚠️ **总预算**那一块含（见文件末尾）。
    // 这里**从合并流里筛**而不是再取一次库：取数只发生一次（同一条流水两个口径）。
    const rows = merged.filter((r) => r.source === LEDGER_SOURCE);
    // 」）：
    // 导入行**没有我们的 `category_id`** ⇒ 只能**按名字**归：它的原文名与某个分类名一模一样
    // 就计入那个分类的已用。⚠️ 名字取 `statRowsOf()` 已经折好的 `name`（自有行 = 我们的分类名、
    const impByName = new Map();
    for (const r of merged) {
      if (r.source === LEDGER_SOURCE) continue;
      const nm = String(r.name || '').trim();
      if (!nm || nm === NO_CATEGORY) continue;
      if (!impByName.has(nm)) impByName.set(nm, []);
      impByName.get(nm).push(r);
    }
    let budRows = this._bk.selectLedgerBudgets(me, type, key);
    // 这一期**一行都没设** ⇒ 自动继承**最近一个设过的那一期**（见 `inheritBudgetsOf`）。
    // 继承来的行**不进库**：用户一编辑写的就是本期那一行；⛔ 这里一个写动作都没有。
    let inheritedFrom = '';
    if (!budRows.length) {
      const inh = inheritBudgetsOf(this, me, type, key);
      if (inh) {
        budRows = inh.rows;
        inheritedFrom = inh.from;
      }
    }
    // 总预算那一行 = `category_id === 0` 的**哨兵**行（见 `schema.js` 的设计说明 1：
    // 这张表里不出现 NULL，所以「哪一个键代表总预算」只有一个候选值）
    const totalRow = budRows.find((r) => Number(r.category_id) === 0) || null;
    // 按分类先把本期的行分好桶（一次 O(n)），分类块逐个取 —— ⛔ 不按分类各过滤一遍全表
    const byCat = new Map();
    for (const r of rows) {
      const cid = r.category_id == null ? null : Number(r.category_id);
      if (!byCat.has(cid)) byCat.set(cid, []);
      byCat.get(cid).push(r);
    }
    // 顺序 = **设置顺序**（`ledger_budgets.id` 升序）：界面上「＋ 添加分类预算」是一行一行
    // 加的，新加的那块照例落在末尾（⛔ 不按 `category_id` 排 —— 那样新加的会跳到最上面）
    const own = budRows.filter((r) => Number(r.category_id) !== 0).sort((a, b) => Number(a.id) - Number(b.id));
    const categories = own.map((r) => {
      const cid = Number(r.category_id);
      const c = cats.get(cid);
      // **一级分类的预算要把「它下面子分类」的支出也算进「已用」**——
      // 「一级分类的 预算 要计算 它下面的子分类预算」。
      // 为什么必须这样：用户记账通常选到**二级**（「餐饮-早餐」），若只算直接挂在一级上的
      const mine = byCat.get(cid) || [];
      const kidRows = [];
      for (const [kid, ck] of cats) {
        if (Number(ck.parent_id) === cid) kidRows.push(...(byCat.get(kid) || []));
      }
      // 把**同名的导入行**也算进来（一级把子分类名下的导入行一起算，与上面那条同一条分寸）
      const impMine = impByName.get(c ? String(c.name || '').trim() : '') || [];
      const impKids = [];
      for (const ck of cats.values()) {
        if (Number(ck.parent_id) !== cid) continue;
        impKids.push(...(impByName.get(String(ck.name || '').trim()) || []));
      }
      const kidAll = kidRows.length || impKids.length ? kidRows.concat(impKids) : kidRows;
      const useRows = (kidAll.length ? mine.concat(kidAll) : mine).concat(impMine);
      return {
        category_id: cid,
        name: c ? String(c.name == null ? '' : c.name) : '',
        ie: c ? String(c.ie == null ? '' : c.ie) : '',
        ...budgetBlockShape(r, usedFen(useRows, now, range.from, range.to)),
      };
    });
    return {
      period_type: type,
      period_key: key,
      from: range.from,
      to: range.to,
      today: dateOf(Number(nowMs)),
      // 这一期的额度是**从哪一期继承来的**（空串 = 就是本期自己设的 / 还没设）——
      // 界面据此说一句「继承自上周」，⛔ 别让用户以为"我没设怎么会有额度"
      inherited_from: inheritedFrom,
      total: budgetBlockShape(totalRow, usedFen(merged, now, range.from, range.to)),
      categories,
    };
  },

  /**
   * 功能：**设 / 改一行额度**（`UNIQUE` 是落点 ⇒ **upsert**，⛔ 命中已存在的行不是 400）。
   *
   * 「同一期 × 同一维度只有一行」这条不变式由库的 `UNIQUE` 自己保证。
   * `category_id` 的解析（`0` 哨兵 / 存在且属于本人）走 `resolveBudgetCategoryIdOf()`
   * —— 它要读库，所以住这里（形状住接口层、归属住业务层）。
   */
  ledgerSetBudget(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const type = String(src.period_type || '');
    const key = String(src.period_key || '');
    budgetRangeOf(type, key);
    const cid = resolveBudgetCategoryIdOf(this, me, src.category_id);
    this._bk.upsertLedgerBudget(me, type, key, cid, Math.trunc(Number(src.amount_fen)) || 0, Math.round(Number(nowMs)));
    return this.ledgerBudgetView(me, type, key, nowMs);
  },

  /**
   * 功能：**清除一行预算** —— ⭐ `category_id = 0` 时**连带清掉该期的全部分类预算**。
   *
   * 说明：⭐⭐ 两条：
   * **清总预算 = 清这一期的两层**：图 9 的二次确认原文就是「清除总预算将同时为您清除
   * 所有分类预算」⇒ 走 `deleteLedgerBudgetsForPeriod()`（**一个事务**：要么都成、
   */
  ledgerClearBudget(uid, input, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const type = String(src.period_type || '');
    const key = String(src.period_key || '');
    budgetRangeOf(type, key);
    const cid = resolveBudgetCategoryIdOf(this, me, src.category_id);
    if (!cid) this._bk.deleteLedgerBudgetsForPeriod(me, type, key);
    else this._bk.deleteLedgerBudget(me, type, key, cid);
    return this.ledgerBudgetView(me, type, key, nowMs);
  },

  /**
   * 功能：**账单屏一屏**（三档共用）—— 卡片三个数 ＋ 表格行（该档各自的切片）。
   *
   * 说明：⭐⭐⭐ 三档的**卡片范围与表格行**（T36 / T39 / 图 2，三档各是一套口径）：
   * `week`  ⇒ 卡片 = **该周**（周收入 / 周支出 / 周结余），表格 = **只有当前自然周那一行**
   * （T39 原话：「显示：（周收入 / 周支出 / 周结余）、当前自然周」，⛔ 不是滚动 7 天）；
   */
  ledgerBillView(uid, periodType, periodKey, nowMs) {
    const me = Number(uid);
    const type = String(periodType || '');
    const key = String(periodKey || '');
    // **周档的 `period_key` 是该月 1 号**（不再是某个周一）⇒ 它的区间按
    // 「该月内所有自然周」算（`weekMonthOf()`）；月 / 年档照旧走 `budgetRangeOf()`。
    const range = type === 'week' ? weekMonthOf(key) : budgetRangeOf(type, key);
    const now = stampOf(Number(nowMs));
    const today = dateOf(Number(nowMs));
    // ：三档的卡片与每一行都**含导入行** ——
    // 取数一律走 `statRowsOf()`（合并流；判据只住那一处）。
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));

    // 」）。
    // 口径：**每一行查它自己那一期的总预算**（`category_id === 0` 的哨兵行）——
    // 周档每行的 `key` 是该周的**周一**（与预算屏周档同一个键）、月档是一月、年档是一年。
    const budgetOf = (kind, key2) => {
      const list = this._bk.selectLedgerBudgets(me, kind, key2);
      const row = (Array.isArray(list) ? list : []).find((r) => Number(r.category_id) === 0);
      return row ? Math.trunc(Number(row.amount_fen)) || 0 : null;
    };
    const withBudget = (row, kind) => {
      const bud = budgetOf(kind, row.key);
      row.budget_fen = bud;
      row.overspent_fen = bud === null ? 0 : Math.max(0, Number(row.expense_fen) - bud);
      row.started = String(row.key) <= today;
      return row;
    };

    if (type === 'week') {
      // 表格列**该月每一周**（第一周 = 含 1 号那一周，可能从上个月末起算），
      // **倒序**（最近那一周在最上面 —— 与月档「12 月在前」同一条口径）。
      // 卡片按**本月**算（`range.month`）⇒「各行之和 ≠ 卡片」是**正常**的：
      const rows = statRowsOf(this, me, range.from, range.to, cats);
      const slices = range.mons.map((mon) => withBudget(sliceShape(rows, now, mon, shiftDaysOf(mon, 7), mon), 'week'));
      return {
        period_type: type,
        period_key: key,
        from: range.from,
        to: range.to,
        today,
        // ：卡片与表格**对齐** ——
        // 卡片 = **所有周的和**（`range.from ~ range.to`，含首周 / 末周跨月的那半截）。
        // 从前卡片按「本月」算（`range.month`），于是「卡片 411.90 vs 表格各行 1651.18」
        card: cardOf(rows, now, range.from, range.to),
        rows: slices.reverse(),
      };
    }

    if (type === 'month') {
      // 月档的两层口径：卡片 = 该「年」全年（T36），表格 = 该年 12 个月（倒序）
      const y = Number(key.slice(0, 4));
      const from = `${y}-01-01`;
      const to = `${y + 1}-01-01`;
      const rows = statRowsOf(this, me, from, to, cats);
      const slices = [];
      for (let m = 1; m <= 12; m += 1) {
        const r = monthRange(`${y}-${String(m).padStart(2, '0')}`);
        slices.push(withBudget(sliceShape(rows, now, r.from, r.to, r.from), 'month'));
      }
      return {
        period_type: type,
        period_key: key,
        from,
        to,
        today,
        card: cardOf(rows, now, from, to),
        rows: slices.reverse(),
      };
    }

    // 年档：卡片 = 记账以来全部，表格 = 各年（倒序）
    // 年表 = 「有记账的年 ∪ 今年」—— 这里取的是**合并流** ⇒ 只在导入数据里出现过的年份
    // 也会各占一行（⛔ 不取合并流的话，那几年的导入金额在表格里**一格都看不见**）。
    const rows = statRowsOf(this, me, '', '', cats);
    const years = new Set([today.slice(0, 4)]);
    for (const r of rows) {
      const at = String((r && r.at) == null ? '' : r.at);
      if (at.length >= 4) years.add(at.slice(0, 4));
    }
    const list = [...years].sort().reverse();
    const from = `${list[list.length - 1]}-01-01`;
    const to = `${Number(list[0]) + 1}-01-01`;
    return {
      period_type: type,
      period_key: key,
      from,
      to,
      today,
      card: cardOf(rows, now, from, to),
      rows: list.map((yy) =>
        withBudget(sliceShape(rows, now, `${yy}-01-01`, `${Number(yy) + 1}-01-01`, `${yy}-01-01`), 'year'),
      ),
    };
  },

  /**
   * 功能：**月详情页一屏给全**—— 卡片 / 类别占比 / 排行 / 趋势 / 环比 / 收入 / 成就。
   *
   * 不是删除线）＋ 支出 / 收入两条占比条；
   * **类别占比表**（饼图 ＋ 表）：一位小数（`pctRowsOf()` ⇒ `pctOf()`），按金额降序；
   * **支出排行**：就是同一份表的前三条（⛔ 不另算一遍 —— 同一份算术只准有一处）；
   */
  ledgerMonthBill(uid, month, nowMs) {
    const me = Number(uid);
    const m = String(month || '');
    const range = monthRange(m);
    const now = stampOf(Number(nowMs));
    const today = dateOf(Number(nowMs));
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    // ：这一屏**全部**含导入行 —— 一次取**合并流**
    // （`statRowsOf()`，判据只住那一处），下面九块全部从它切。
    const rows = statRowsOf(this, me, '', '', cats);

    // ---- ② 卡片：本月 ＋ 上月（上月三个数由前端弱化，形状与本月同构）----
    const cur = sumOf(rows, now, range.from, range.to);
    const prevRange = monthRange(prevMonthOf(m));
    const prev = sumOf(rows, now, prevRange.from, prevRange.to);
    // 两条占比条：各自 ÷ (收入 ＋ 支出)（一位小数；分母为 0 ⇒ `null`，前端画 `—`）
    const base = cur.income_fen + cur.expense_fen;
    const card = {
      income_fen: cur.income_fen,
      expense_fen: cur.expense_fen,
      refund_fen: cur.refund_fen,
      // 支出已是**净额** ⇒ 结余里**不再**把退款加回来（与 `sliceShape()` /
      balance_fen: cur.income_fen - cur.expense_fen,
      prev_income_fen: prev.income_fen,
      prev_expense_fen: prev.expense_fen,
      prev_refund_fen: prev.refund_fen,
      prev_balance_fen: prev.income_fen - prev.expense_fen,
      income_pct: pctOf(cur.income_fen, base),
      expense_pct: pctOf(cur.expense_fen, base),
    };

    // ---- ③④ 类别占比表 ＋ 支出排行（排行就是同一份表的前三条）----
    const expenseCategories = pctRowsOf(
      categoryBucketsOf(rows, now, range.from, range.to, false),
      cur.expense_fen,
    );

    // ---- ⑤ 支出趋势：本月每天（升序）＋ 单日最高 ＋ 日均 ----
    // 每天的数 = 那一天的**净支出**（`dayTotalsOf()` ⇒ `sumOf()` ⇒ 纯函数：退款已抵掉），
    // 并且**只留净支出不为 0 的天**：
    const dayMap = dayTotalsOf(rows, now, range.from, range.to);
    const days = Object.keys(dayMap)
      .sort()
      .filter((d) => Number(dayMap[d].expense_fen) !== 0)
      .map((d) => ({ day: d, amount_fen: Number(dayMap[d].expense_fen) }));
    let maxDay = null;
    let maxDayFen = 0;
    for (const d of days) {
      // 并列取**最早**那天（`days` 已升序 ⇒ 严格大于才换人）—— 顺序必须是判据
      if (d.amount_fen > maxDayFen) {
        maxDay = d.day;
        maxDayFen = d.amount_fen;
      }
    }
    const trend = {
      total_fen: cur.expense_fen,
      max_day: maxDay,
      max_day_fen: maxDayFen,
      daily_avg_fen: dailyAvgFen(rows, now, range.from, range.to),
      days,
    };

    // ---- ⑥⑧ 近 6 个月（升序，含本月）＋ 对比上月变化前三的类别 ----
    const months = lastMonthsOf(m, 6).map((x) => sliceShape(rows, now, x.from, x.to, x.from));
    const curBuckets = categoryBucketsOf(rows, now, range.from, range.to, false);
    const prevBuckets = categoryBucketsOf(rows, now, prevRange.from, prevRange.to, false);
    // 两边都要看：上月有、本月没了的那一类，变化量是**它上月的金额**（⛔ 只看本月会把
    // 分桶键是**显示名**（`statRowsOf()` 给的 `name`）而不是 `category_id`：自有流水的
    // 「餐饮」与导入的「餐饮」因此**合到同一档**（这就是要的「看得见的一致」）；
    const prevMap = new Map(prevBuckets.map((b) => [b.name, b]));
    const curMap = new Map(curBuckets.map((b) => [b.name, b]));
    // 两边都要看，而且**「本月那一份」必须按「有就有、没有就是 0」取** —— 不能拿
    // 「上月起底、本月覆盖」合成的那一份当本月值：那样「上月有、本月没花」的类别会拿
    // **它自己的上月桶**当本月桶，变化量算成 0 被下面那句跳过 ⇒ 把「这个月完全没花」
    const movers = [];
    for (const nm of new Set([...prevMap.keys(), ...curMap.keys()])) {
      const curBucket = curMap.get(nm) || null;
      const prevBucket = prevMap.get(nm) || null;
      const b = curBucket || prevBucket;
      const nowFen = Number(curBucket ? curBucket.amount_fen : 0) || 0;
      const diff = nowFen - (Number(prevBucket ? prevBucket.amount_fen : 0) || 0);
      if (!diff) continue;
      movers.push({
        category_id: b && b.category_id != null ? Number(b.category_id) : null,
        name: String(b && b.name != null ? b.name : ''),
        ie: String(b && b.ie != null ? b.ie : ''),
        amount_fen: nowFen,
        diff_fen: diff,
      });
    }
    // 平手的次序必须是判据：|变化| 降序 → `category_id` 升序（**未分类排最后**）
    const NIL = Number.MAX_SAFE_INTEGER;
    movers.sort((a, b) => {
      const d = Math.abs(b.diff_fen) - Math.abs(a.diff_fen);
      if (d) return d;
      return (a.category_id == null ? NIL : a.category_id) - (b.category_id == null ? NIL : b.category_id);
    });

    return {
      month: m,
      from: range.from,
      to: range.to,
      card,
      expense_categories: expenseCategories,
      expense_top: expenseCategories.slice(0, 3),
      expense_trend: trend,
      expense_movers: movers.slice(0, 3),
      income_categories: pctRowsOf(
        categoryBucketsOf(rows, now, range.from, range.to, true),
        cur.income_fen,
      ),
      months,
      achievement: achievementOf(rows, now, today),
    };
  },

  /**
   *
   * 说明：⭐⭐ 「搜索功能完善」—— 明细屏那颗放大镜原来只弹一句「开发中」，
   */
  ledgerSearch(uid, q) {
    const me = Number(uid);
    const kw = String(q == null ? '' : q).trim().toLowerCase();
    if (!kw) return { q: '', count: 0, rows: [] };
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    const all = statRowsOf(this, me, '', '', cats);
    // 自有行的备注不在合并流里（见上面第 3 条）⇒ 另取一次索引
    const ownById = new Map();
    for (const r of this._bk.listLedgerEntries(me, {}) || []) ownById.set(Number(r && r.id), r);
    const hit = [];
    for (const r of all) {
      const own = r && r.source === LEDGER_SOURCE ? ownById.get(Number(r.ref_id)) : null;
      const note = own ? String(own.note == null ? '' : own.note) : '';
      const src = exportSourceLabel(r && r.source);
      const money = yuanStr(Math.abs(Number((r && r.fen) || 0)));
      const hay = `${note} ${(r && r.name) == null ? '' : r.name} ${src} ${money}`.toLowerCase();
      if (!hay.includes(kw)) continue;
      hit.push({
        id: Number(r && r.id),
        at: String((r && r.at) == null ? '' : r.at),
        ie: String((r && r.ie) == null ? '' : r.ie),
        amount_fen: Number((r && r.fen) || 0),
        name: String((r && r.name) == null ? '' : r.name),
        note,
        source: String((r && r.source) == null ? '' : r.source),
        source_label: src,
      });
    }
    hit.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
    return { q: kw, count: hit.length, rows: hit.slice(0, SEARCH_LIMIT) };
  },


  /**
   * 功能：**「有数据的期间」清单**（年 / 月 / 周）—— 图表与导出「选期间」的地基。
   *
   * 从前前端只有「本会话翻过的月 ∪ 今天那个月」，所以**导入进来的 2024 年数据**
   * 在明细屏的月份选择里根本点不到 —— 不是画不出来，是**没有那个选项**。
   * 取数走**合并流**（`statRowsOf()`：自有 ＋ 三方导入）—— 只出现在导入数据里的
   */
  ledgerPeriods(uid, nowMs) {
    const me = Number(uid);
    const today = dateOf(Number(nowMs));
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    const rows = statRowsOf(this, me, '', '', cats);
    const years = new Set();
    const months = new Set();
    const weeks = new Set();
    const add = (d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      years.add(d.slice(0, 4));
      months.add(d.slice(0, 7));
      const mon = mondayOf(d);
      if (mon) weeks.add(mon);
    };
    for (const r of rows) add(String((r && r.at) == null ? '' : r.at).slice(0, 10));
    add(today);
    const asc = (s) => [...s].sort();
    const ms = asc(months);
    return {
      today,
      years: asc(years),
      months: ms,
      weeks: asc(weeks),
      // 导出页那两颗日期框的**默认值**（前端不算日期 ⇒ 由服务端给）——
      // 开始 = **最早有记录的月份的 1 号**（一笔都没有就是今天）＝「默认导全部」；
      // 结束 = 今天。⚠️ 与上面那三个清单**同一个来源**（`rows` 含三方导入的行）⇒
      export: { from: ms.length ? `${ms[0]}-01` : today, to: today },
    };
  },

  /**
   * 功能：**图表一屏**（内嵌在明细 / 账单里的那个视图）—— 折线 ＋ 两个数 ＋ 排行榜。
   *
   * 说明：⭐⭐ 口径与 3 期的账单 / 预算**逐字一致**（`period_type` = `week` / `month` / `year`、
   * `period_key` = 该期**起始日**）⇒ 账单屏那颗药丸切到「图表」时不用换参数。
   * **两个数**：`total_fen`（该口径的期间总额）与 `avg_fen`（平均值，分母见 `elapsedUnitsOf()`）；
   */
  ledgerChart(uid, dir, periodType, periodKey, nowMs) {
    const me = Number(uid);
    const d = String(dir) === 'in' ? 'in' : 'out';
    const type = String(periodType || '');
    const key = String(periodKey || '');
    // 与账单**同一条**口径 —— 周档的 `period_key` 是该月 1 号，
    // 区间 = 该月内所有自然周（`weekMonthOf()`）；月 / 年档照旧。
    const range = type === 'week' ? weekMonthOf(key) : budgetRangeOf(type, key);
    // ：**「总额」与图的点
    // 用同一个区间**（`range` = 这一屏覆盖的全部子期）—— 于是「图上各点之和 === 总额」，
    // 排行榜的占比分母也跟着自洽。
    const totalFrom = range.from;
    const totalTo = range.to;
    const now = stampOf(Number(nowMs));
    const today = dateOf(Number(nowMs));
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    const rows = statRowsOf(this, me, range.from, range.to, cats);
    const s = sumOf(rows, now, totalFrom, totalTo);
    const units = elapsedUnitsOf(type, range, today);
    // 一次把**两侧**都算出来——
    const sideOf = (dd) => {
      const total = dd === 'in' ? s.income_fen : s.expense_fen;
      const series = chartSeriesOf(type, rows, now, range, today, dd);
      let maxFen = 0;
      for (const p of series) {
        if (p.fen != null && Number.isFinite(p.fen)) maxFen = Math.max(maxFen, p.fen);
      }
      const ranks = pctRowsOf(categoryBucketsOf(rows, now, totalFrom, totalTo, dd === 'in'), total).map(
        (r) => ({
          category_id: r.category_id,
          name: r.name,
          amount_fen: r.amount_fen,
          pct: r.pct,
        }),
      );
      return {
        total_fen: total,
        // 分母 0（期还没开始）⇒ `null`：界面画 `—`，⛔ 不是除零、⛔ 也不是一个 0.00 的假数
        avg_fen: units > 0 ? Math.round(total / units) : null,
        avg_units: units,
        max_fen: maxFen,
        series,
        ranks,
      };
    };
    return {
      dir: d,
      period_type: type,
      period_key: key,
      from: totalFrom,
      to: totalTo,
      today,
      out: sideOf('out'),
      in: sideOf('in'),
    };
  },

  /**
   * 功能：**区间内每天的收入 / 支出小计** —— 供给**日历那第 4 个只读图层**。
   *
   * 说明：⭐⭐ 这是记账第一次**对外**开联动面 ⇒ 它是**公开方法**（⛔ 不是把内部的
   * **取数只走一处**：本方法**只是转发**「合并流 ＋ 按天小计」那两件 ——
   * **调用方（日历）必须守卫**：记账模块被**整目录删掉**时，日历那一层要走
   */
  ledgerDailyTotals(uid, from, to, nowMs) {
    const me = Number(uid);
    const now = stampOf(Number(nowMs));
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));
    const rows = statRowsOf(this, me, String(from || ''), String(to || ''), cats);
    return dayTotalsOf(rows, now, String(from || ''), String(to || ''));
  },

  /**
   * 功能：**导出 CSV** —— 三样数据（明细流水 / 账户余额 / 三方导入原样）产出**文本**。
   *
   * 说明：⭐⭐ 本方法**只产出文本**（表头 ＋ 行），列头按我们自己的字段定死。
   * 响应头 / 文件名 / **BOM** 都是接口层的事（§6.3 第 4 条）—— 所以这里回的 `csv`
   * **不带 BOM**（课表那条接口的 `'\uFEFF'` 就是接口层贴的）。
   */
  ledgerExportCsv(uid, what, from, to, nowMs) {
    const me = Number(uid);
    const w = String(what || '');
    const cats = new Map(this._bk.listLedgerCategories(me).map((c) => [Number(c.id), c]));

    // ---- 时间范围 → 字典序区间 + 文件名里的那半 ----
    // 严格形态：**一对日期**（`YYYY-MM-DD`）或**两个都空**（＝不限），⛔ **非法就 400**
    const df = String(from == null ? '' : from).trim();
    const dt = String(to == null ? '' : to).trim();
    if (df && !DAY_RE.test(df)) throw badRequest('导出的开始时间要写成 2026-09-28 这样');
    if (dt && !DAY_RE.test(dt)) throw badRequest('导出的结束时间要写成 2026-09-28 这样');
    if ((df && !dt) || (!df && dt)) throw badRequest('导出的开始 / 结束时间要成对给');
    if (df && dt && df > dt) throw badRequest('导出的开始时间不能晚于结束时间');
    const lo = df;
    // 结束时间是**含当天**的（填 09-28 就该拿到 09-28 那天的账）⇒ 换算成**左闭右开**的上界
    const hi = dt ? dayAfter(dt) : '';
    const scope = df && dt ? `${df}_${dt}` : '全部';

    // ---- ① 账户余额（⭐ 派生余额；账户没有「时间」，范围对它无意义）----
    if (w === 'accounts') {
      const derived = deriveLedger(this, me, nowMs);
      const listed = withBalance(derived.accounts.filter(isListedAccount), derived.balances);
      const rank = kindRankOf(this._bk.listLedgerGroups(me, 'kind'));
      const rows = [['账户', '类型', '余额', '备注']];
      for (const a of orderAccounts(listed.map(shape), rank)) {
        const k = KINDS.find((x) => x.key === a.kind);
        rows.push([a.name, k ? k.name : String(a.kind || ''), yuanStr(a.opening_fen), a.note]);
      }
      return { filename: 'ZXDesk-记账账户余额.csv', csv: buildCsv(rows), count: rows.length - 1 };
    }

    // ---- ③ 三方导入的**原样**数据（带一列「来源」，多来源合表时不混）----
    if (w === 'imported') {
      const rows = [['来源', '日期', '收支', '分类', '账户', '金额', '备注']];
      for (const src of listSources()) {
        for (const it of this._bk.selectImportedBetween(me, src.table, lo, hi) || []) {
          rows.push([
            String(src.label || src.key || ''),
            String((it && it.date_raw) == null ? '' : it.date_raw),
            String((it && it.ie_raw) == null ? '' : it.ie_raw),
            String((it && it.category) == null ? '' : it.category),
            String((it && it.account) == null ? '' : it.account),
            String((it && it.amount_raw) == null ? '' : it.amount_raw),
            String((it && it.note) == null ? '' : it.note),
          ]);
        }
      }
      return { filename: `ZXDesk-记账导入数据-${scope}.csv`, csv: buildCsv(rows), count: rows.length - 1 };
    }

    // ---- ② 明细流水（⭐ 自有 ＋ 三方导入，走合并流）----
    if (w === 'entries') {
      const rows = statRowsOf(this, me, lo, hi, cats);
      // 自有行在 `statRowsOf()` 里只带**六列**（那个取数原语的口径：`id / at / ie /
      // amount_fen / category_id / refund_of`）—— 「账户 id」与「备注」**不在其中**
      // ⇒ 这里另取一次 `id -> 整行` 的索引来补这两列。
      const ownById = new Map();
      for (const r of this._bk.listLedgerEntries(me, {}) || []) ownById.set(Number(r && r.id), r);
      // 账户名走 `ledgerAccountNames()`（含**已删账户的原名**）—— 已删账户名下的老流水
      const names = new Map();
      for (const x of this.ledgerAccountNames(me) || []) {
        const id = Number(x.id);
        names.set(id, Number(x.special) === 1 ? '不关联' : String(x.name == null ? '' : x.name));
      }
      // 末尾多一列「来源」—— 自有流水写 ZXDesk，三方导入写那家的显示名
      const out = [['日期', '时间', '收支', '分类', '账户', '金额', '备注', '来源']];
      for (const e of rows) {
        const at = String((e && e.at) == null ? '' : e.at);
        // 只有**自有流水**才有账户与备注（导入行不关联账户 ——  的结构性事实）。
        const own = e && e.source === LEDGER_SOURCE ? ownById.get(Number(e.ref_id)) : null;
        out.push([
          at.slice(0, 10),
          at.length >= 19 ? at.slice(11, 19) : '',
          String((e && e.ie) == null ? '' : e.ie),
          String((e && e.name) == null ? '' : e.name),
          names.get(Number(own && own.account_id)) || '',
          // 金额写**正数**（元的两位小数）：正负由「收支」那一列表达 —— 这样在 Excel 里
          // 按「收支」筛选一下就能直接 SUM，⛔ 不用处理负号
          yuanStr(Math.abs(Number((e && e.fen) || 0))),
          String((own && own.note) == null ? '' : own.note),
          exportSourceLabel(e && e.source),
        ]);
      }
      return { filename: `ZXDesk-记账流水-${scope}.csv`, csv: buildCsv(out), count: out.length - 1 };
    }

    throw badRequest('导出内容不认识');
  },


  /**
   * 功能：**预览**一次三方导入 —— 解析 ＋ 去重，**一个字节都不写库**。
   *
   * 也可能「一笔都不用写（你已经导过了）」；先让用户看一眼、再点一下确认。
   * 它**只调用 `planImport()`**（同一个函数也是 `commit` 用的那一份）——
   * 「预览说将写入 340、commit 却写了 341」这种漂移因此**在结构上不可能发生**。
   */
  ledgerImportPreview(uid, buf, sourceKey, _nowMs) {
    const src = importSourceOf(sourceKey);
    return planImport(this, Number(uid), src, buf).draft;
  },

  /**
   * 功能：**真的导** —— 把同一个文件再发一次，**一个事务**写进该来源的表。
   *
   * 说明：⭐⭐ 四条：
   * **同一个文件再发一次**就是它的入参（⛔ 不信任前端传来的明细 —— 那等于给了一条
   * 「随便造 375 笔账」的写路径）；
   */
  ledgerImportCommit(uid, buf, sourceKey, nowMs) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = importSourceOf(sourceKey);
    const plan = planImport(this, me, src, buf);
    // 批次号由业务层给（原语只按 `MAX(batch_id)+1` 算）；行号由原语按**下标**现算
    const batchId = this._bk.nextImportBatchId(me, src.table);
    const done = this._bk.insertImportedRows(me, src.table, plan.rows, batchId, Math.round(Number(nowMs)));
    return {
      inserted: Number(done && done.inserted) || 0,
      skipped: plan.skipped,
      failed: 0,
      batch_id: batchId,
    };
  },

  /**
   * 功能：该来源的**导入概况**（设置里那一行「已导入 N 笔（跨度）」）。
   *
   * 说明：⭐ `count = 0` ⇒ 界面上显示「还没导入过」，⛔ **不是错误**（照样回 200）。
   * `batches` = 在这批数据里出现过的**批次号个数**（用户看不到它，留着是为了
   * 排查「重复导入」这类问题：正常导过一次就是 1）。
   */
  ledgerImportSummary(uid, sourceKey) {
    const me = Number(uid);
    const src = importSourceOf(sourceKey);
    const rows = this._bk.selectImportedBetween(me, src.table, '', '') || [];
    const batches = new Set();
    let from = '';
    let to = '';
    for (const r of rows) {
      const at = String((r && r.at) == null ? '' : r.at);
      if (at) {
        if (!from || at < from) from = at;
        if (!to || at > to) to = at;
      }
      batches.add(Math.trunc(Number(r && r.batch_id)) || 0);
    }
    return {
      source: String(src.key),
      source_label: String(src.label || ''),
      count: this._bk.countImportedRows(me, src.table),
      batches: batches.size,
      from: from || null,
      to: to || null,
    };
  },

  /**
   * 功能：**整批清除** —— 把这个来源导进来的数据**全部**清掉，回清掉的条数。
   *
   * 说明：⭐⭐ 导入的数据是**只读**的（⛔ 没有单条改 / 单条删 ——），要撤走只有这条路
   * —— 用户要的是「把导进来的清掉」，一次全清。
   * 幂等：本来就没导过 ⇒ 删 0 行，**照样 200**（`deleted: 0`）。
   */
  ledgerImportClear(uid, sourceKey) {
    this._assertLedgerWritable();
    const me = Number(uid);
    const src = importSourceOf(sourceKey);
    return { deleted: Number(this._bk.deleteImportedByUser(me, src.table)) || 0 };
  },

  //
  // 本段的纪律（与 3 期那两段同款）：算术**只转发**纯函数（`sumOf()` / `categoryBucketsOf()` /
  // `pctRowsOf()` / `summarize()`），本段一个金额都不加；区间一律**左闭右开**。

  /**
   * 功能：一个**区间**的账单口径 —— 收支合计 ＋ 支出分类占比 ＋ 最近几笔流水（AI 读工具用）。
   *
   * 说明：⭐⭐ 三条口径（每条错了都**不报错**，只是数字悄悄不对）：
   * 取数走 `statRowsOf()`（**合并流**：自有流水 ＋ 三方导入）—— 与账单 / 预算 / 月详情
   * 逐字同源（那是唯一的合并取数点）；
   */
  ledgerAiStats(uid, range, nowMs, opt) {
    const me = Number(uid);
    const o = opt && typeof opt === 'object' ? opt : {};
    const r = String(range || '');
    const today = dateOf(Number(nowMs));
    const now = stampOf(Number(nowMs));
    // ：
    // 多认一对**自定义日期区间** `{from, to}`（都是 `YYYY-MM-DD`，**闭区间**）。
    // 为什么要它：原来只有 today/week/month/year 四档，模型被问「这个月和上个月比」时
    const cFrom = String(o.from == null ? '' : o.from).trim();
    const cTo = String(o.to == null ? '' : o.to).trim();
    const custom = !!(cFrom && cTo);
    let from = custom ? cFrom : today;
    let to = custom ? shiftDaysOf(cTo, 1) : shiftDaysOf(today, 1);
    if (custom) {
      // 自定义区间：跳过下面那串枚举映射
    } else if (r === 'week') {
      from = mondayOf(today);
      to = shiftDaysOf(from, 7);
    } else if (r === 'month') {
      const mr = monthRange(today.slice(0, 7));
      from = mr.from;
      to = mr.to;
    } else if (r === 'year') {
      const y = today.slice(0, 4);
      from = `${y}-01-01`;
      to = `${Number(y) + 1}-01-01`;
    } else if (r !== 'today' && !custom) {
      throw badRequest('范围只能是 today / week / month / year 这四个之一');
    }
    const catList = this._bk.listLedgerCategories(me);
    const cats = new Map(catList.map((c) => [Number(c.id), c]));
    // ：给模型的分类名一律是**全称**
    // （一级 = 名字；二级 = `父名-名`，与 `lib/categories.js` 的 `fullNameOf()` 同一口径）。
    // 为什么必须：二级分类**允许重名**（「其他」在餐饮、交通下各有一条），而
    const fullOf = (c) => fullNameOf(catList, c);
    const leafOf = (c) => String((c && c.name) || '');
    const parentNameOf = (c) => {
      const pid = c && c.parent_id != null ? Number(c.parent_id) : 0;
      const p = pid ? cats.get(pid) : null;
      return p ? String(p.name || '') : '';
    };
    const rowsAll = statRowsOf(this, me, from, to, cats).map((x) => {
      if (x.source !== LEDGER_SOURCE || x.category_id == null) return x;
      const c = cats.get(Number(x.category_id));
      if (!c) return x;
      return { ...x, name: fullOf(c), cat_leaf: leafOf(c), cat_parent: parentNameOf(c) };
    });
    // **分类筛选**（可选）。`wantCat` 只在「本机真有这个分类」时才生效 ——
    // 不替你新建分类，也⛔ 不把「分类名写错」当成「这个分类花了 0 元」（那两句在界面上完全两回事）。
    // 认**全称**（`餐饮-早餐`）与**叶子名**（`早餐`）；叶子名撞上多个分类时**拒绝**
    const wantCat = String(o.category == null ? '' : o.category).trim();
    const normCat = (v) => String(v == null ? '' : v).replace(/\s+/g, '');
    const wantKey = normCat(wantCat);
    let target = null;
    let catFound = null;
    if (wantCat) {
      const fullHit = catList.filter((c) => normCat(fullOf(c)) === wantKey);
      const leafHit = fullHit.length ? [] : catList.filter((c) => normCat(leafOf(c)) === wantKey);
      if (fullHit.length || leafHit.length) {
        const pool = fullHit.length ? fullHit : leafHit;
        if (pool.length > 1) {
          const names = pool.map((c) => `「${fullOf(c)}」`).join('、');
          throw badRequest(`「${wantCat}」在本机有多个分类（${names}），请用「一级-二级」全称再查一次`);
        }
        target = pool[0];
        catFound = true;
      } else {
        catFound = false;
      }
    }
    const okIds = new Set();
    const okNames = new Set();
    const okLeafs = new Set();
    if (target) {
      const tid = Number(target.id);
      okIds.add(tid);
      okNames.add(normCat(fullOf(target)));
      okLeafs.add(normCat(leafOf(target)));
      // 一级 ⇒ 子分类一起算（判据是 `parent_id`，⛔ 不比名字）
      for (const c of catList) {
        if (c.parent_id == null || Number(c.parent_id) !== tid) continue;
        okIds.add(Number(c.id));
        okNames.add(normCat(fullOf(c)));
        okLeafs.add(normCat(leafOf(c)));
      }
    }
    const rows =
      target === null
        ? rowsAll
        : rowsAll.filter((x) => {
            // 导入行只有**原文名**（没有我们的 `category_id`）⇒ 只能按叶子名匹配；
            if (x.source !== LEDGER_SOURCE) {
              const k = normCat(x.name);
              return okLeafs.has(k) || okNames.has(k);
            }
            return x.category_id != null && okIds.has(Number(x.category_id));
          });
    const sums = sumOf(rows, now, from, to);
    // 笔数 / 最近几笔都只看**已经发生的**（`at <= now`）：`statRowsOf` 取的是整段区间，
    const live = rows.filter((x) => {
      const at = String((x && x.at) == null ? '' : x.at);
      return !!at && at <= now;
    });
    const acctName = new Map(this._bk.listLedgerAccounts(me).map((a) => [Number(a.id), String(a.name || '')]));
    /** 功能：给占比表那几行补上「一级 / 二级」（`name` 已经是全称，这里只补拆开的两段）。 @param {Array.<Object>} list - `pctRowsOf()` 的产物 @returns {Array.<Object>} 补完的行 */
    const decorateCats = (list) =>
      (Array.isArray(list) ? list : []).map((x) => {
        const c = x && x.category_id != null ? cats.get(Number(x.category_id)) : null;
        return {
          ...x,
          leaf: c ? leafOf(c) : String((x && x.name) || ''),
          parent: c ? parentNameOf(c) : '',
        };
      });
    // **备注与账户名都不在合并流里** —— `selectLedgerEntriesBetween()` 刻意只回六列
    // （`id/at/ie/amount_fen/category_id/refund_of`，见那边的说明），所以 `x.note` 与
    // `x.account_id` 都是 `undefined`。
    const rowOf = (x) => (x && x.source === LEDGER_SOURCE ? this._bk.getLedgerEntry(me, Number(x.ref_id)) : null);
    const recent = live
      .slice()
      .sort((a, b) => String(b.at).localeCompare(String(a.at)) || Number(b.ref_id || 0) - Number(a.ref_id || 0))
      .slice(0, 10)
      .map((x) => {
        const row = rowOf(x);
        return {
          at: String(x.at),
          ie: String(x.ie || ''),
          amount_fen: Math.trunc(Number(x.fen)) || 0,
          category: String(x.name || ''),
          account: row ? String(acctName.get(Number(row.account_id)) || '') : '',
          note: row ? String(row.note == null ? '' : row.note).slice(0, NOTE_READ_MAX) : '',
        };
      });
    return {
      range: custom ? 'custom' : r,
      // 自定义区间回**闭区间**那对日期（内部 `to` 是排他上界，`shiftDaysOf(-1)` 还回去）
      from,
      to: custom ? cTo : to,
      today,
      // 把「筛了什么」一起带出去 —— 没筛就是 null；
      // `category_found === false` 表示用户说了个本机没有的分类（模型据此说人话，而不是报 0 元）。
      category: wantCat || null,
      category_found: catFound,
      income_fen: sums.income_fen,
      expense_fen: sums.expense_fen,
      refund_fen: sums.refund_fen,
      // 净额 = 收入 − 支出（支出已是净额，见 `sumOf()`）—— 与 `cardOf()` 同一式子。
      net_fen: sums.income_fen - sums.expense_fen,
      count: live.length,
      // 分类带上**一级 / 二级**（`name` = 全称、`leaf` = 二级名、`parent` = 一级名）。
      categories: decorateCats(
        pctRowsOf(categoryBucketsOf(rows, now, from, to, false), sums.expense_fen).slice(0, 10),
      ),
      income_categories: decorateCats(
        pctRowsOf(categoryBucketsOf(rows, now, from, to, true), sums.income_fen).slice(0, 10),
      ),
      recent,
    };
  },

  /**
   * 功能：**此刻的资产 / 负债 / 净值 ＋ 各账户余额**（AI 读工具用；只读）。
   *
   * 说明：⭐⭐ 与资产屏（`ledgerOverview()`）**同一份口径**（同一个 `deriveLedger()` ＋
   * 同一份 `summarize()`）—— 所以 AI 说的「你有多少净资产」与用户屏幕上那个数是同一个数。
   * 差别只有一处：**本方法不 seed**（⛔ 不写库，见这一段开头的纪律）。
   */
  ledgerAiAssets(uid, nowMs) {
    const me = Number(uid);
    const derived = deriveLedger(this, me, nowMs);
    const listed = withBalance(derived.accounts.filter(isListedAccount), derived.balances);
    const s = summarize(listed);
    const kindMap = new Map(KINDS.map((k) => [k.key, k]));
    return {
      today: dateOf(Number(nowMs)),
      asset_fen: s.asset_fen,
      debt_fen: s.debt_fen,
      net_fen: s.net_fen,
      accounts: listed.map((a) => {
        const k = kindMap.get(String(a.kind));
        return {
          name: String(a.name == null ? '' : a.name),
          kind: String(a.kind == null ? '' : a.kind),
          kind_name: k ? String(k.name) : '',
          side: k ? String(k.side) : '',
          balance_fen: Math.trunc(Number(a.opening_fen)) || 0,
        };
      }),
    };
  },
};
