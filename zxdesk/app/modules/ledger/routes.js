'use strict';
/**
 * modules/ledger/routes.js —— 记账路由（一屏一次给全 ＋ 账户的增 / 改 / 删）
 * 功能：`handleLedger` 一处收全部记账接口 —— `GET /api/ledger/overview`（资产 / 负债 / 净值 ＋
 * 分组小计 ＋ 账户 ＋ 当年快照 ＋ 服务端「今天」搭车）、`POST /api/ledger/accounts`（建）、
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

const { httpError, idParam, json, notFound, readBody, readRawBody, MAX_UPLOAD, rfc5987 } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');
const { isKind } = require('./lib/kinds.js');
const { parseFen } = require('./lib/money.js');
const { TAG_MAX, VIEW_NAME_MAX } = require('./lib/views.js');
// 收支分类的名字上限（与账户名同值 60，唯一出处住 lib/）
const { MAX_CATEGORY_NAME } = require('./lib/categories.js');
// ：三档周期的白名单 —— **唯一出处**住 lib，
// 不在这里再抄一份 `['week','month','year']`（那就是第二份真相源）
const { PERIOD_TYPES } = require('./lib/budget.js');
// ：三方导入的**来源注册表** —— ⭐ 接口上的 `?source=`
// 只认它里面的键（⛔ 这里不抄 `'shark'` 那种字面量，加来源只加注册表一项）；
// 表名**永远由注册表给**（业务层取 `src.table`），⛔ 绝不来自请求体 / 文件名 / 路径。
const { getSource, listSources } = require('./lib/import-sources.js');

/**
 * 名称长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_NAME`（任务 / 项目 / 日历标题）**同值 100 不同**：
 */
const NAME_MAX = 60;
/** 备注长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_HW_NOTE` 同值（硬件备注也是 200） */
const NOTE_MAX = 200;
/** 尾号四位：**恰好四位数字**（⛔ 不宽容：`'123'` / `'12345'` / `'12a4'` 一律 400）
 * 起这一列一列两用：储蓄卡 / 信用卡是「卡号后四位」，
 *  信用支付 / 虚拟账户是「手机号 / 账号后 4 位」—— 形状一模一样，只是 label 不同。 */
const TAIL_RE = /^\d{4}$/;
/** 可在查询里指定的年份区间（1900~2100 之外 400） */
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
/** 月份参数 `YYYY-MM`（缺省 = 服务端今天那个月） */
const MONTH_RE = /^\d{4}-\d{2}$/;
/** 记账时刻的格式 —— `'YYYY-MM-DD HH:MM:SS'`（秒由前端带上， 第 11 条） */
const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** 纯日期（3 期预算 / 账单的 `period_key` 就是它 —— **该期的起始日**） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 一次最多几条 —— ⭐ C-16：30；> 30 **不静默截断**，直接 400 */
const PAGE_MAX = 30;
/** 账户详情那一屏的「变动类型」白名单（⛔ 不做关键词搜索 —— C-22） */
const CHANGE_TYPES = ['all', 'entry', 'transfer', 'adjust'];
/** 归档方式的白名单 */
const ARCHIVE_MODES = ['archive', 'move-children'];
/** 图表口径（支出 / 收入）—— 与前端 `calc.js` 的 `CHART_DIRS` 是同一套键 */
const CHART_DIRS = ['out', 'in'];
/** 导出「导什么」—— 与前端 `calc.js` 的 `EXPORT_WHATS` 是同一套键 */
const EXPORT_WHATS = ['entries', 'accounts', 'imported'];

/**
 * 功能：校验并归一化「建 / 改一个账户」的入参。
 *
 * 说明：⭐ **部分更新（`partial`）只校验请求里真的带了的字段**——
 * 没带的键不进结果对象，业务层会用**现状**补上。
 * 空串一律按「清掉」处理（`tail` / `note` 都是可空的）：`''` 与 `null` 在库里是同一件事。
 */
function checkLedgerAccount(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};

  if (has('kind')) {
    if (!isKind(src.kind)) throw httpError(400, '账户类型只能是这九种之一');
    out.kind = src.kind;
  } else if (!partial) {
    throw httpError(400, '请先选一个账户类型');
  }

  if (has('name')) {
    const t = String(src.name == null ? '' : src.name).trim();
    if (!t) throw httpError(400, '名称不能为空');
    if (t.length > NAME_MAX) throw httpError(400, `名称不能超过 ${NAME_MAX} 个字`);
    out.name = t;
  } else if (!partial) {
    throw httpError(400, '名称不能为空');
  }

  if (has('tail')) {
    const v = String(src.tail == null ? '' : src.tail).trim();
    // 空串 = 「没填后四位」，不是非法值（它本来就是选填）
    if (v && !TAIL_RE.test(v)) throw httpError(400, '后四位只收 4 位数字');
    out.tail = v;
  }

  if (has('note')) {
    const n = String(src.note == null ? '' : src.note).trim();
    if (n.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
    out.note = n;
  }

  if (has('opening')) {
    const fen = parseFen(src.opening);
    if (fen === null) throw httpError(400, '余额要填 0 ~ 99999999.99 之间的数，最多两位小数');
    out.opening_fen = fen;
  } else if (!partial) {
    throw httpError(400, '请填一下余额（没有就填 0）');
  }

  // ：储蓄卡 / 信用卡的**分级**与**三个限额**（只给这两类用；⚠️ 服务端不按类型卡它 ——
  // 「哪几类显示」是**版式**的事，住前端 `calc.js` 的 needLimitOf()，⛔ 这里不抄第二份名单）
  if (has('tier')) {
    const t = String(src.tier == null ? '' : src.tier).trim();
    if (t && t !== 'Ⅰ' && t !== 'Ⅱ' && t !== 'Ⅲ') throw httpError(400, '分级只收 Ⅰ / Ⅱ / Ⅲ');
    out.tier = t;
  }
  for (const [k, col] of [
    ['limit_day', 'limit_day_fen'],
    ['limit_month', 'limit_month_fen'],
    ['limit_year', 'limit_year_fen'],
  ]) {
    if (!has(k)) continue;
    const raw = src[k];
    if (raw == null || String(raw).trim() === '') {
      // 清空 ⇒ `null`（**不是 0**：「没设」与「设成 0」是两件事）
      out[col] = null;
      continue;
    }
    const fen = parseFen(raw);
    if (fen === null) throw httpError(400, '限额要填 0 ~ 99999999.99 之间的数，最多两位小数');
    out[col] = fen;
  }

  if (has('tags')) out.tags = checkTags(src.tags);

  if (partial && !Object.keys(out).length) throw httpError(400, '没有要改的内容');
  return out;
}

/**
 * 功能：校验查询参数 `year`；没给时取**服务端今天所在的那一年**。
 *
 * 说明：⭐ 默认值用的是**调用方给的服务端日期**，⛔ 不是本机日期（手机日期 / 时区不可靠）。
 *
 * @param {?string} raw - 请求里的 `year`
 */
function checkYear(raw, todayStr) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return Number(todayStr.slice(0, 4));
  const s = String(raw).trim();
  if (!/^\d{4}$/.test(s)) throw httpError(400, '年份要写成 2026 这样的四位数字');
  const y = Number(s);
  if (y < YEAR_MIN || y > YEAR_MAX) throw httpError(400, `年份要在 ${YEAR_MIN} ~ ${YEAR_MAX} 之间`);
  return y;
}

/**
 * 功能：把 epoch 毫秒转成本地日期 `YYYY-MM-DD`（只用于「今天」与年份默认值）。
 * @param {number} ms - epoch 毫秒
 * @returns {string} 本地日期字符串
 */
function dateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：校验「转一笔钱」的入参，并把它归一化。
 *
 * 说明：⭐⭐ 三条形状判据住这里（⛔ 不住 `store.js`）：
 * 两个 id 必须是**正整数**（`'abc'` / `0` / `-3` / 空 一律 400）——
 * 别用 `idParam()`：它对空串回 `0`（`Number('') === 0`），而 `0` 在这里是**非法 id**，
 */
function checkTransfer(b) {
  const src = b && typeof b === 'object' ? b : {};
  const from = positiveId(src.from_id);
  const to = positiveId(src.to_id);
  if (from === null) throw httpError(400, '请先选转出账户');
  if (to === null) throw httpError(400, '请先选转入账户');
  if (from === to) throw httpError(400, '转出和转入不能是同一个账户');
  const fen = parseFen(src.amount);
  if (fen === null) throw httpError(400, '转账金额要填 0.01 ~ 99999999.99 之间的数，最多两位小数');
  if (fen <= 0) throw httpError(400, '转账金额要大于 0');
  const note = String(src.note == null ? '' : src.note).trim();
  if (note.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
  return { from_id: from, to_id: to, amount_fen: fen, note };
}

/**
 * 功能：把「一个正整数 id」解析出来 —— 形状不对 / 不是正数一律回 `null`。
 *
 * 说明：⚠️ 它替代 `idParam()` 在这个位置上的使用：那个函数对空串回 `0`
 * （`Number('') === 0`），而 `0` 不是一个合法 id ⇒ 会把「没传」与「传了 0」
 * 合并成同一种错，报错文案也跟着变味。本函数对空串 / 小数 / 负号 / 文字一律 null。
 */
function positiveId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * 功能：校验一个记账时刻 —— `'YYYY-MM-DD HH:MM:SS'`（格式 / 各段范围都不对就 400）。
 *
 * 说明：⭐ 定长串是**整套取数与排序的地基**（`at` 的字典序 = 时间序，按月取数是字典序区间）
 * 秒**由前端带上**（它知道「点开建这一步」那一刻的真实秒， 第 11 条）；
 * 服务端不覆盖前端给的时刻（用户可以补记过去 / 记未来 ——  第 3 条）。
 */
function checkAt(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!AT_RE.test(s)) throw httpError(400, '时间要写成 2026-09-22 14:30:00 这样的格式');
  const [date, time] = s.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mi, ss] = time.split(':').map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) {
    throw httpError(400, '时间不是有效的日期时间');
  }
  if (y < YEAR_MIN || y > YEAR_MAX) throw httpError(400, `年份要在 ${YEAR_MIN} ~ ${YEAR_MAX} 之间`);
  return s;
}

/**
 * 功能：校验查询参数 `month`；没给时取**服务端今天所在的那个月**。
 *
 * 说明：⭐ 缺省值用的是**调用方给的服务端日期**（手机日期 / 时区不可靠），
 * 不是本机日期、⛔ 不是「正在看的那一年」。
 * @param {?string} raw - 请求里的 `month`
 */
function checkMonth(raw, todayStr) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return String(todayStr).slice(0, 7);
  if (!MONTH_RE.test(s)) throw httpError(400, '月份要写成 2026-09 这样的格式');
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  if (mo < 1 || mo > 12) throw httpError(400, '月份不是有效的月份');
  if (y < YEAR_MIN || y > YEAR_MAX) throw httpError(400, `年份要在 ${YEAR_MIN} ~ ${YEAR_MAX} 之间`);
  return s;
}

/**
 * 功能：校验「期」的档位 `period_type` —— **只认 `week` / `month` / `year` 三档**。
 *
 * 说明：⭐ 白名单**不在本文件里另抄一份**：`PERIOD_TYPES` 住在 `lib/budget.js`
 * （那里同时定义了这三档各自的区间口径）—— 两处各写一份字面量数组必然漂移。
 * 而界面上看不出任何异常）。
 */
function checkPeriodType(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!PERIOD_TYPES.includes(s)) throw httpError(400, '预算周期只能是 周 / 月 / 年 三档');
  return s;
}

/**
 * 功能：校验 `period_key` —— 必须是 `YYYY-MM-DD`，且**真的是这一档的起始日**。
 *
 * 周 ⇒ **周一**（预算）或 **1 号**（账单 / 图表，见 `weekMode`）、月 ⇒ **1 号**、
 * 年 ⇒ **1 月 1 日**；
 * 3 月 2 日（于是它「看起来」是一个合法的周一）⇒ 必须回读年月日核对，⛔ 不能只看范围。
 */
function checkPeriodKey(periodType, raw, weekMode) {
  const s = String(raw == null ? '' : raw).trim();
  if (!DATE_RE.test(s)) throw httpError(400, '周期要写成 2026-09-21 这样的日期');
  const [y, mo, d] = s.split('-').map(Number);
  if (y < YEAR_MIN || y > YEAR_MAX) throw httpError(400, `年份要在 ${YEAR_MIN} ~ ${YEAR_MAX} 之间`);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    throw httpError(400, '周期不是有效的日期');
  }
  if (periodType === 'month' && d !== 1) throw httpError(400, '月预算的周期要从 1 号开始');
  if (periodType === 'year' && (mo !== 1 || d !== 1)) throw httpError(400, '年预算的周期要从 1 月 1 日开始');
  if (periodType === 'week') {
    if (weekMode === 'month') {
      if (d !== 1) throw httpError(400, '周账单的周期要从 1 号开始');
    } else if (dt.getDay() !== 1) {
      throw httpError(400, '周预算的周期要从周一开始');
    }
  }
  return s;
}

/**
 * 功能：把「预算 / 账单」几个入口共用的查询参数折成 `{period_type, period_key}`。
 * @param {?URLSearchParams} p - 查询参数
 * @param {string} [weekMode] - 周档的键按哪一种校验（见 `checkPeriodKey()`；账单 / 图表传 `'month'`）
 * @returns {{period_type: string, period_key: string}} 归一后的入参
 * @throws {Error} 档位 / 起始日不合法时抛 400
 */
function checkPeriodQuery(p, weekMode) {
  const periodType = checkPeriodType(p ? p.get('period_type') : null);
  return {
    period_type: periodType,
    period_key: checkPeriodKey(periodType, p ? p.get('period_key') : null, weekMode),
  };
}

/**
 * 功能：校验图表口径 `dir`（`支出` / `收入`）—— ⭐ 缺省按「支出」，带了但不认识 ⇒ **400**。
 *
 * 说明：⭐ 「只校验请求里**真带了的**字段」：不带 ⇒ 给默认值（参考图默认就是「支出」）；
 * **带了**一个不认识的字符串 ⇒ 400，⛔ 不静默回落 —— 回落的话前端传 `income`（英文全称）
 * 会画出一屏**支出**的图，而用户以为自己切到了收入（一个看着正常的假图）。
 */
function checkChartDir(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'out';
  if (!CHART_DIRS.includes(s)) throw httpError(400, '图表口径只有 支出 / 收入 两档');
  return s;
}

/**
 * 功能：校验导出的 `what` —— ⭐ 缺省按「明细流水」，带了但不认识 ⇒ 400。
 * @param {?string} raw - 查询参数 `what`
 * @returns {string} `'entries'` / `'accounts'` / `'imported'`
 * @throws {Error} 带了但不认识时抛 400
 */
function checkExportWhat(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'entries';
  if (!EXPORT_WHATS.includes(s)) throw httpError(400, '要导的内容只有 明细流水 / 账户余额 / 导入数据');
  return s;
}

/** 搜索关键字长度上限（JS 字符数，中文算一个）—— ⛔ 不限的话一个超长串会拖垮全表扫描。 */
const SEARCH_Q_MAX = 60;

/**
 * 功能：校验搜索关键字 —— 去空白；超长 ⇒ **400**（⛔ 不静默截断：截断会把「搜不到」装成事实）。
 *
 * 说明：⚠️ 空串是**合法**的（回空结果，见 `ledgerSearch()` 第一段）—— 界面刚打开、
 *
 * @param {?string} raw - 查询参数 `q`
 */
function checkSearchQuery(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s.length > SEARCH_Q_MAX) throw httpError(400, `搜索关键字最多 ${SEARCH_Q_MAX} 个字`);
  return s;
}

/**
 * 功能：校验导出的 `range` —— ⭐ 缺省 `all`；严格形态 `all` / `YYYY` / `YYYY-MM`，其余 ⇒ **400**。
 *
 * 说明：⚠️⭐ **非法就 400，⛔ 不回落成「全部」**：回落的话用户选了「2024 年」、
 * 拿到的却是全部数据 —— 他会用一个错的文件做后续所有事，而且**没人报错**。
 *
 */
function checkExportDay(raw, name) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (!DATE_RE.test(s)) throw httpError(400, `${name}要写成 2026-09-28 这样`);
  const y = Number(s.slice(0, 4));
  if (y < YEAR_MIN || y > YEAR_MAX) throw httpError(400, `${name}的年份要在 ${YEAR_MIN} ~ ${YEAR_MAX} 之间`);
  return s;
}

/**
 * 功能：把一份 CSV 文本作为**附件**发出去（中文名走 `filename*`，BOM 在接口层贴）。
 *
 * `Content-Type: text/csv; charset=utf-8`（与课表模板那条一致）；
 * `Content-Disposition` = **ASCII 兜底名 ＋ RFC 5987 中文名**（照 `routes/backup.js`）——
 * `filename=` 只允许 ASCII，直接塞中文会被浏览器丢掉或变乱码，所以两者**成对**出现；
 */
function sendCsv(res, filename, asciiName, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${rfc5987(filename)}`,
    'Cache-Control': 'no-store',
  });
  return res.end('\uFEFF' + csv);
}

/**
 * 功能：解析预算的维度键 `category_id` —— **`0`（或不带）= 总预算哨兵**，正整数 = 分类预算。
 *
 * 这里只验**形状**（非负整数）；「这个分类存不存在 / 是不是本人的」要读库
 * ⇒ 住 `store.js`。⚠️ 它是**入参字段**不是被访问的资源
 *
 */
function checkCategoryId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 0;
  if (!/^\d+$/.test(s)) throw httpError(400, '收支分类要选一个存在的');
  return Number(s);
}

/**
 * 功能：校验「设 / 改一行额度」（`PUT /api/ledger/budget`）的请求体。
 *
 * 说明：⭐ 四个键**都是必填**（这一条接口**只做一件事**：设某一期某一维度的额度）——
 * 缺 `period_type` / `period_key` / `amount_fen` 一律 400（⛔ 不猜缺省值：
 * `amount_fen` 走 `parseFen()` 且**只收字符串**（数字类型在解析成 double 那一刻
 */
function checkBudgetBody(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  if (!has('period_type')) throw httpError(400, '请说明是哪一档周期');
  const periodType = checkPeriodType(src.period_type);
  if (!has('period_key')) throw httpError(400, '请说明是哪一个周期');
  const periodKey = checkPeriodKey(periodType, src.period_key);
  if (!has('amount_fen')) throw httpError(400, '请填一下额度（可以是 0）');
  const fen = parseFen(src.amount_fen);
  if (fen === null) throw httpError(400, '额度要填 0 ~ 99999999.99 之间的数，最多两位小数');
  return {
    period_type: periodType,
    period_key: periodKey,
    category_id: checkCategoryId(src.category_id),
    amount_fen: fen,
  };
}

/**
 * 功能：解析**游标** —— 不透明串 `<时刻>|<id>`（缺省 / 空串 ⇒ `null` = 取最新那一端）。
 *
 * 说明：⭐⭐ 分页用游标而不是 offset：中途有人插数据时 offset 会漂、
 * 会重复或漏行。⚠️ 时刻里带空格 ⇒ 从**最后一个 `|`** 切开（时刻本身不含 `|`）。
 * @param {?string} raw - 请求里的 `before`
 */
function checkCursor(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const i = s.lastIndexOf('|');
  if (i <= 0) throw httpError(400, '翻页游标的格式不对');
  const at = s.slice(0, i);
  const id = positiveId(s.slice(i + 1));
  if (!at || at.includes('|') || id === null) throw httpError(400, '翻页游标的格式不对');
  return { at, id };
}

/**
 * 功能：校验查询参数 `limit` —— 缺省 `PAGE_MAX`，**> 30 ⇒ 400**（⛔ 不静默截断）。
 * @param {?string} raw - 请求里的 `limit`
 * @returns {number} 1 ~ 30
 * @throws {Error} 非法 / 越界时抛 400
 */
function checkLimit(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return PAGE_MAX;
  if (!/^\d+$/.test(s)) throw httpError(400, `一次最多取 ${PAGE_MAX} 条`);
  const n = Number(s);
  if (n < 1 || n > PAGE_MAX) throw httpError(400, `一次最多取 ${PAGE_MAX} 条`);
  return n;
}

/**
 * 功能：校验账户详情那一屏的「变动类型」过滤（缺省 `all`）。
 * @param {?string} raw - 请求里的 `type`
 * @returns {string} `all` / `entry` / `transfer` / `adjust`
 * @throws {Error} 不认识的值抛 400
 */
function checkChangeType(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'all';
  if (!CHANGE_TYPES.includes(s)) throw httpError(400, '变动类型不认识');
  return s;
}

/**
 * 功能：把 `?source=` 折成**注册表里的那个键**（原样返回，供业务层取来源定义）。
 *
 * 说明：⭐⭐ 三条：
 * **只认注册表里的键**（`lib/import-sources.js`）：其余一律 400，⛔ 这里**不抄** `'shark'`
 * 这种字面量 —— 以后加别家只加注册表一项，这一处一个字都不用改；
 */
function checkImportSource(p) {
  const key = String((p ? p.get('source') : '') || '').trim();
  if (!key) throw httpError(400, '请说明是哪一种导入（例如 source=shark）。');
  if (!getSource(key)) {
    const names = listSources()
      .map((s) => `「${s.label}」`)
      .join('、');
    throw httpError(400, `不认识这个导入来源 —— 现在只支持${names}。`);
  }
  return key;
}

/**
 * 功能：校验归档方式（缺省 `archive`）。
 * @param {?string} raw - 请求里的 `mode`
 * @returns {string} `archive` / `move-children`
 * @throws {Error} 不认识的值抛 400
 */
function checkMode(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'archive';
  if (!ARCHIVE_MODES.includes(s)) throw httpError(400, '归档方式不认识');
  return s;
}

/**
 * 功能：把「可选的 id 型字段」（`category_id` / `account_id`）从请求体里挑出来。
 *
 * 说明：⚠️ **`null` 是一个合法值**（分类 `null` = 未分类；账户 `null` = 不关联 ⇒ 服务端落空账户）
 * ⇒ 判据写成「带了这个键就收下，值是 `null` 就原样给 `null`」，
 * 不能写成「`if (src[k])`」（那会把 `null` 与「没带」混成同一件事）。
 */
function takeRefIds(src, has, out) {
  for (const k of ['category_id', 'account_id']) {
    if (!has(k)) continue;
    if (src[k] == null) {
      out[k] = null;
      continue;
    }
    const id = positiveId(src[k]);
    if (id === null) throw httpError(400, k === 'category_id' ? '收支分类要选一个存在的' : '账户要选一个存在的');
    out[k] = id;
  }
}

/**
 * 功能：校验并归一化「记一笔 / 改一笔」的入参。
 *
 * 说明：⭐ **部分更新只校验请求里真的带了的字段**——没带的键不进结果对象，
 * 业务层用**现状**补上。
 * 金额走 `parseFen()` 且**只收字符串**（数字类型在解析成 double 那一刻已经丢过精度）；
 */
function checkEntry(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  if (has('at')) out.at = checkAt(src.at);
  else if (!partial) throw httpError(400, '请填一下时间');
  if (has('ie')) {
    if (src.ie !== '支出' && src.ie !== '收入') throw httpError(400, '收支类型只能是支出或收入');
    out.ie = src.ie;
  } else if (!partial) {
    throw httpError(400, '请选一下是支出还是收入');
  }
  if (has('amount')) {
    const fen = parseFen(src.amount);
    if (fen === null) throw httpError(400, '金额要填 0 ~ 99999999.99 之间的数，最多两位小数');
    out.amount_fen = fen;
  } else if (!partial) {
    throw httpError(400, '请填一下金额（可以是 0）');
  }
  takeRefIds(src, has, out);
  if (has('note')) {
    const n = String(src.note == null ? '' : src.note).trim();
    if (n.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
    out.note = n;
  }
  if (partial && !Object.keys(out).length) throw httpError(400, '没有要改的内容');
  return out;
}

/**
 * 功能：校验「给这一笔记一笔退款」的入参 —— `ie` 不收（退款一律是收入侧，原语里写死）。
 * @param {*} b - 请求体
 * @returns {Object} 归一化后的入参（金额已转成整数分）
 * @throws {Error} 任一字段非法时抛 400
 */
function checkRefund(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  if (!has('at')) throw httpError(400, '请填一下时间');
  out.at = checkAt(src.at);
  if (!has('amount')) throw httpError(400, '请填一下退款金额');
  const fen = parseFen(src.amount);
  if (fen === null) throw httpError(400, '退款金额要填 0 ~ 99999999.99 之间的数，最多两位小数');
  out.amount_fen = fen;
  takeRefIds(src, has, out);
  if (has('note')) {
    const n = String(src.note == null ? '' : src.note).trim();
    if (n.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
    out.note = n;
  }
  return out;
}

/**
 * 功能：校验并归一化「新建 / 改一个收支分类」的入参。
 *
 * 说明：⭐⭐ **改（`partial`）时 `ie` 与 `parent_id` 一律 400**（§6.3 第 1 条）：
 * `ie` 一改，历史流水就跨到另一侧去了；`parent_id` 一改就是「搬家」，那是另一件事
 * ⇒ 想改这两样只有一条路：归档重建（可见、可解释）。
 */
function checkCategory(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  if (partial && (has('ie') || has('parent_id'))) {
    throw httpError(400, '收支分类的收支方向与上一级改不了（要改只能归档重建）');
  }
  const out = {};
  if (has('name')) {
    const t = String(src.name == null ? '' : src.name).trim();
    if (!t) throw httpError(400, '分类名不能为空');
    if (t.length > MAX_CATEGORY_NAME) throw httpError(400, `分类名不能超过 ${MAX_CATEGORY_NAME} 个字`);
    out.name = t;
  } else if (!partial) {
    throw httpError(400, '给这个分类起个名字');
  }
  if (has('parent_id')) {
    if (src.parent_id == null) out.parent_id = null;
    else {
      const pid = positiveId(src.parent_id);
      if (pid === null) throw httpError(400, '上一级收支分类要选一个存在的');
      out.parent_id = pid;
    }
  }
  if (has('ie')) {
    if (src.ie !== '支出' && src.ie !== '收入') throw httpError(400, '一级收支分类只能是支出或收入');
    out.ie = src.ie;
  }
  if (has('sort_order')) {
    const so = positiveId(src.sort_order);
    if (so === null) throw httpError(400, '排序号要是正整数');
    out.sort_order = so;
  }
  if (partial && !Object.keys(out).length) throw httpError(400, '没有要改的内容');
  return out;
}

/**
 * 功能：把「设置默认账户」的请求体折成**一串动作**（逐条 upsert —— 带哪个键写哪个）。
 *
 * 说明：⭐ 请求体形状：`{income_id, expense_id, categories: {<分类 id>: <账户 id> | null}}`；
 * `categories` 里某个分类给 `null` ⇒ **清掉**该分类的默认（回到全局那一层）。
 * 全局两层**只改不删**⇒ 那两个键只收账户 id，⛔ 不收 `null`
 */
function checkDefaults(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const ops = [];
  for (const [key, kind] of [
    ['income_id', 'income'],
    ['expense_id', 'expense'],
  ]) {
    if (!has(key)) continue;
    const id = positiveId(src[key]);
    if (id === null) throw httpError(400, '默认账户要选一个存在的账户');
    ops.push({ kind, category_id: 0, account_id: id });
  }
  if (has('categories')) {
    const raw = src.categories;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, '每类别默认账户的格式不对');
    for (const [k, v] of Object.entries(raw)) {
      const cid = positiveId(k);
      if (cid === null) throw httpError(400, '每类别默认账户的格式不对');
      if (v == null) {
        ops.push({ kind: 'category', category_id: cid, account_id: null });
        continue;
      }
      const aid = positiveId(v);
      if (aid === null) throw httpError(400, '默认账户要选一个存在的账户');
      ops.push({ kind: 'category', category_id: cid, account_id: aid });
    }
  }
  if (!ops.length) throw httpError(400, '没有要改的内容');
  return ops;
}

/**
 * 功能：处理 `/api/ledger` 及其子路径 —— 记账的一屏与账户的增删改。
 *
 * 说明：路由表（`parts = ['api','ledger', …]`）——
 * `GET    /api/ledger/overview?year=YYYY`  一屏所需的全部（⭐ 搭车给服务端「今天」）
 * `GET    /api/ledger/account-names`       账户 id → 名字的**合并视图**（⭐ 2 期新增的取名口）
 */
/**
 */
function checkTags(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, '分类归属的格式不对');
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, '分类归属的格式不对');
    if (v !== null && v !== undefined && typeof v !== 'string') throw httpError(400, '用途要写成文字');
    const t = String(v == null ? '' : v).trim();
    if (t.length > TAG_MAX) throw httpError(400, `用途名不能超过 ${TAG_MAX} 个字`);
    out[id] = t;
  }
  return out;
}

/**
 * 功能：校验「建 / 改一套自定义分类」的入参（目前只有 `name`）。
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只校验带了的键）
 * @returns {Object} `{name}`
 * @throws {Error} 名字为空 / 超长时抛 400
 */
function checkLedgerView(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  if (!Object.prototype.hasOwnProperty.call(src, 'name')) {
    throw httpError(400, partial ? '没有要改的内容' : '给这个分类起个名字');
  }
  const t = String(src.name == null ? '' : src.name).trim();
  if (!t) throw httpError(400, '分类名不能为空');
  if (t.length > VIEW_NAME_MAX) throw httpError(400, `分类名不能超过 ${VIEW_NAME_MAX} 个字`);
  return { name: t };
}

/**
 * 功能：校验「新增 / 改名一个用途字段」的入参（形状与「分类」同构，长度用 `TAG_MAX`）。
 *
 * 说明：⚠️ 用的是 `TAG_MAX`（12）而不是 `VIEW_NAME_MAX` —— 用途名是**分组标题**
 * （一行放得下），分类名是**胶囊**（更宽），两者本来就是两把尺子。
 * 覆盖的是 `scope='usage'` 那一套；九类（`scope='kind'`）的名字来自代码，**不可改**，
 */
function checkUsage(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  if (!Object.prototype.hasOwnProperty.call(src, 'name')) {
    throw httpError(400, partial ? '没有要改的内容' : '给这个用途起个名字');
  }
  const t = String(src.name == null ? '' : src.name).trim();
  if (!t) throw httpError(400, '用途名不能为空');
  if (t.length > TAG_MAX) throw httpError(400, `用途名不能超过 ${TAG_MAX} 个字`);
  return { name: t };
}

/**
 * 功能：校验「重排」的入参 —— `{what, ids}`。
 *
 * 说明：⭐⭐ `what` 决定重排哪一张表，所以它是**白名单**（⛔ 不是自由字符串）：
 * 三个值之外一律 400 —— 这一层挡住「让人传表名」的可能，原语层再挡一次
 * （表名在两个后端里写死，见那两处注释）。
 */
function checkReorder(b) {
  const src = b && typeof b === 'object' ? b : {};
  const what = String(src.what == null ? '' : src.what).trim();
  if (what !== 'accounts' && what !== 'views' && what !== 'groups' && what !== 'tags') {
    throw httpError(400, '排序对象不认识');
  }
  if (!Array.isArray(src.ids) || !src.ids.length) throw httpError(400, '排序要给出一个 id 列表');
  const ids = src.ids.map(positiveId);
  if (ids.some((n) => n === null)) throw httpError(400, '排序列表里有不是 id 的东西');
  // ：what=tags 是「某一套分类**组内的先后**」⇒ 必须说明是**哪一套**。
  // 缺了就 400（⛔ 别默认成「第一套」—— 那会静默改错一套分类的顺序）
  let view = 0;
  if (what === 'tags') {
    view = positiveId(src.view);
    if (view === null) throw httpError(400, '按分类排序要说明是哪一套分类');
  }
  return { what, ids, view };
}

/**
 * 功能：把「账户 id → 名字」的**合并视图**折成 `GET /account-names` 的响应体。
 *
 * 说明：⭐⭐ 数据**只准**来自 `store.ledgerAccountNames(uid)`（C-8 /  第 6 条：
 * 「先查账户表、查不到再查删除记录表」这条判据**只准有一处**）—— ⛔ 本文件不另写一份 SQL、
 * **空账户（`special = 1`）的名字在这一处由「空账户」改成 `'不关联'`**：库里的那一行
 * 正常路径只可能 200（401 由闸门在 `/api/ledger/*` 之前判掉）。
 */
function accountNamesOf(uid) {
  const names = {};
  const deletedIds = [];
  for (const r of store.ledgerAccountNames(uid)) {
    const id = Number(r.id);
    // 空账户 ⇒「不关联」（唯一转换点，见上）；其余照原名，⛔ 不猜、不造
    names[String(id)] = Number(r.special) === 1 ? '不关联' : String(r.name == null ? '' : r.name);
    if (r.deleted) deletedIds.push(id);
  }
  return { names, deleted_ids: deletedIds };
}

function handleLedger({ req, res, parts, url, method, uid }) {
  // 整个请求共用同一个「现在」（见文件头说明）
  const nowMs = Date.now();

  // ---- 三段：`overview`（只读） / `accounts`（新建） ----
  if (parts.length === 3) {
    if (parts[2] === 'overview') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const year = checkYear(p ? p.get('year') : null, dateOf(nowMs));
      return json(res, 200, store.ledgerOverview(uid, year, nowMs));
    }
    if (parts[2] === 'accounts') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.ledgerAddAccount(uid, checkLedgerAccount(b, false), nowMs));
      });
    }
    // 取名口 —— 账户 id → 名字的**合并视图**（含已删账户的原名；空账户显示为「不关联」）。
    // 段名 `account-names` 必须先于四段的 `accounts/:id` 判掉？不必：它是**三段**
    // （`['api','ledger','account-names']`），与 `accounts/:id` 那两段（四段 / 五段）根本不同长，
    if (parts[2] === 'account-names') {
      if (method !== 'GET') return notFound(res);
      return json(res, 200, accountNamesOf(uid));
    }
    // 流水列表（按月 ＋ 游标倒序，一次 ≤ 30）与记一笔
    if (parts[2] === 'entries') {
      const p = (url && url.searchParams) || null;
      if (method === 'GET') {
        const month = checkMonth(p ? p.get('month') : null, dateOf(nowMs));
        const before = checkCursor(p ? p.get('before') : null);
        const limit = checkLimit(p ? p.get('limit') : null);
        // 3 期搭车：`summary`（当月收入 / 支出）与 `dayTotals`
        // （按天两个小计）**由业务层算好挂在返回值上**（见 `ledgerEntries` 的说明）——
        // 这里只把它们**原样放进响应体**，⛔ 接口层一个金额都不算（§6.3 第 4 条）。
        const page = store.ledgerEntries(uid, month, before, limit, nowMs);
        return json(res, 200, {
          entries: page,
          summary: page.summary,
          dayTotals: page.dayTotals,
          imported: page.imported,
        });
      }
      if (method === 'POST') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          json(res, 201, store.ledgerAddEntry(uid, checkEntry(b, false), nowMs));
        });
      }
      return notFound(res);
    }
    // ：预算屏 —— 读一屏 / 设一行 / 清一行，三条**同级同段**
    // （路径里没有 id，靠 `method` 分派：GET / PUT / DELETE）。三段都在这里。
    // `PUT` 是 **upsert**（命中已存在的那一行是**更新**，⛔ 不是 400）⇒ 回 **200**（⛔ 不是 201）。
    if (parts[2] === 'budget') {
      const p = (url && url.searchParams) || null;
      if (method === 'GET') {
        const q = checkPeriodQuery(p);
        return json(res, 200, { budget: store.ledgerBudgetView(uid, q.period_type, q.period_key, nowMs) });
      }
      if (method === 'PUT') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          json(res, 200, { ok: true, budget: store.ledgerSetBudget(uid, checkBudgetBody(b), nowMs) });
        });
      }
      if (method === 'DELETE') {
        const q = checkPeriodQuery(p);
        // `category_id` 走 `checkCategoryId()`（`0` = 总预算哨兵；空 / 不带也是 `0`）
        const input = {
          period_type: q.period_type,
          period_key: q.period_key,
          category_id: checkCategoryId(p ? p.get('category_id') : null),
        };
        return json(res, 200, { ok: true, budget: store.ledgerClearBudget(uid, input, nowMs) });
      }
      return notFound(res);
    }
    // 账单屏 —— 周 / 月 / 年三档**共用这一条**（靠 `period_type` 分派，⛔ 不是三条接口）
    if (parts[2] === 'bill') {
      if (method !== 'GET') return notFound(res);
      // 账单的周档 = **某个月内的各周** ⇒ 键按「月 1 号」校验（`weekMode='month'`）。
      const q = checkPeriodQuery((url && url.searchParams) || null, 'month');
      return json(res, 200, { bill: store.ledgerBillView(uid, q.period_type, q.period_key, nowMs) });
    }
    // `month` 的口径照现有 `ledgerEntries`（缺省 = 服务端今天那个月）
    if (parts[2] === 'month-bill') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const month = checkMonth(p ? p.get('month') : null, dateOf(nowMs));
      return json(res, 200, { month_bill: store.ledgerMonthBill(uid, month, nowMs) });
    }
    // ：三条**只读** GET —— 期间清单 / 图表一屏 / 导出 CSV。
    // `GET /api/ledger/periods`  ⭐「有数据的年 / 月 / 周」（图表与导出「选期间」的地基，
    // `GET /api/ledger/chart`    折线 ＋ 两个数 ＋ 排行榜（参数与账单**逐字一致**：
    if (parts[2] === 'search') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      return json(res, 200, { search: store.ledgerSearch(uid, checkSearchQuery(p ? p.get('q') : null)) });
    }
    if (parts[2] === 'periods') {
      if (method !== 'GET') return notFound(res);
      return json(res, 200, { periods: store.ledgerPeriods(uid, nowMs) });
    }
    if (parts[2] === 'chart') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      // 图表与账单**联动**（同一份期间选择）⇒ 周档的键也按「月 1 号」校验。
      const q = checkPeriodQuery(p, 'month');
      const dir = checkChartDir(p ? p.get('dir') : null);
      return json(res, 200, { chart: store.ledgerChart(uid, dir, q.period_type, q.period_key, nowMs) });
    }
    if (parts[2] === 'export') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const what = checkExportWhat(p ? p.get('what') : null);
      const from = checkExportDay(p ? p.get('from') : null, '开始时间');
      const to = checkExportDay(p ? p.get('to') : null, '结束时间');
      if ((from && !to) || (!from && to)) throw httpError(400, '开始 / 结束时间要成对给');
      if (from && to && from > to) throw httpError(400, '开始时间不能晚于结束时间');
      const out = store.ledgerExportCsv(uid, what, from, to, nowMs);
      const tail = from && to ? `-${from}_${to}` : '';
      return sendCsv(res, out.filename, `zxdesk-ledger-${what}${tail}.csv`, out.csv);
    }
    // ：三方导入的**概况**与**整批清除** —— 两条**同级同段**
    // （路径里没有 id，靠 `method` 分派：GET / DELETE）。
    // `GET    /api/ledger/import?source=shark`  概况（已导入多少笔 / 批次 / 跨度）；
    if (parts[2] === 'import') {
      const p = (url && url.searchParams) || null;
      const source = checkImportSource(p);
      if (method === 'GET') return json(res, 200, { ok: true, summary: store.ledgerImportSummary(uid, source) });
      if (method === 'DELETE') {
        return json(res, 200, { ok: true, deleted: store.ledgerImportClear(uid, source).deleted });
      }
      return notFound(res);
    }
    // 备注历史候选（⛔ 无表：直接来自已有流水；上限 20 住业务层）
    if (parts[2] === 'notes') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const raw = p ? p.get('category') : null;
      // `category` 没给 ⇒ `null`（＝全部类别的候选）；给了就必须是一个正整数
      let cid = null;
      if (raw != null && String(raw).trim() !== '') {
        cid = positiveId(raw);
        if (cid === null) throw httpError(400, '类别要选一个存在的');
      }
      return json(res, 200, { notes: store.ledgerNoteCandidates(uid, cid) });
    }
    // 收支分类（两级一次性给全，含已归档）与新建
    if (parts[2] === 'categories') {
      if (method === 'GET') return json(res, 200, { categories: store.ledgerCategories(uid) });
      if (method === 'POST') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          json(res, 201, store.ledgerAddCategory(uid, checkCategory(b, false), nowMs));
        });
      }
      return notFound(res);
    }
    // 「恢复内置分类」—— 把库里的收支分类对齐到内置清单（补全内置 ＋ 硬删旧预置）。
    // 路径**必须是三段**（与 `notes` / `defaults` 同级），⛔ 不能写成
    // `categories/restore` —— 那会命中四段那条 `parts[2] === 'categories'`，
    if (parts[2] === 'restore-builtin') {
      if (method !== 'POST') return notFound(res);
      return json(res, 200, store.ledgerRestoreBuiltin(uid, nowMs));
    }
    // 默认账户（全局两层 ＋ 每类别一层）—— 读一次 / 逐条 upsert
    if (parts[2] === 'defaults') {
      if (method === 'GET') return json(res, 200, { defaults: store.ledgerDefaults(uid) });
      if (method === 'PUT') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          for (const op of checkDefaults(b)) {
            // `account_id` 为 `null` = **清掉**这一条（只可能是「每类别」那一层：
            // 全局两层只改不删，`checkDefaults()` 已经把 `null` 挡成 400）
            if (op.account_id === null) store.ledgerClearDefault(uid, op.kind, op.category_id);
            else store.ledgerSetDefault(uid, op.kind, op.category_id, op.account_id, nowMs);
          }
          json(res, 200, { ok: true, defaults: store.ledgerDefaults(uid) });
        });
      }
      return notFound(res);
    }
    if (parts[2] === 'views') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.ledgerAddView(uid, checkLedgerView(b, false), nowMs));
      });
    }
    // 分组字段（九类的显示顺序 ＋ 内置用途）—— 只读入口
    // `scope` 白名单：给别的值就是 400（⛔ 不静默当成「两套都给」）
    if (parts[2] === 'groups') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const scope = String((p && p.get('scope')) || '').trim();
      if (scope && scope !== 'kind' && scope !== 'usage') throw httpError(400, '分组类型不认识');
      return json(res, 200, { groups: store.ledgerGroups(uid, scope || null) });
    }
    // 新增一个用途字段（内置「按账户用途」那一套）
    if (parts[2] === 'usages') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.ledgerAddUsage(uid, checkUsage(b, false), nowMs));
      });
    }
    // 拖排序的落点（账户 / 分类胶囊 / 分组字段三处共用一个入口）
    if (parts[2] === 'reorder') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const { what, ids, view } = checkReorder(b);
        json(res, 200, { ok: true, moved: store.ledgerReorder(uid, what, ids, nowMs, view) });
      });
    }
    // ---- 转账：明细（GET，按账户问）与转一笔（POST） ----
    if (parts[2] === 'transfers') {
      if (method === 'GET') {
        const p = (url && url.searchParams) || null;
        const aid = positiveId(p ? p.get('account') : null);
        if (aid === null) throw httpError(400, '要看哪个账户的明细？');
        // 显示成「这个账户还没有流水」—— 那等于把拒绝伪装成正常）
        return json(res, 200, { transfers: store.ledgerTransfers(uid, aid) });
      }
      if (method === 'POST') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          json(res, 201, store.ledgerAddTransfer(uid, checkTransfer(b), nowMs));
        });
      }
      return notFound(res);
    }
    return notFound(res);
  }

  // ---- 四段：`accounts/:id`（改 / 删） ----
  // `POST /api/ledger/import/preview?source=shark` —— 原始字节体；**一个字节都不写库**；
  // `POST /api/ledger/import/commit?source=shark`  —— **同一个文件再发一次**，真写库。
  if (parts.length === 4 && parts[2] === 'import') {
    const sub = String(parts[3]);
    if ((sub !== 'preview' && sub !== 'commit') || method !== 'POST') return notFound(res);
    const source = checkImportSource((url && url.searchParams) || null);
    const size = Number(req.headers['content-length']) || 0;
    if (size > MAX_UPLOAD) {
      return json(res, 413, {
        error:
          `文件太大（上限 ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB）—— ` +
          '鲨鱼记账导出的明细一般只有几十 KB，请确认选对了文件。',
      });
    }
    return readRawBody(req, res, (buf) => {
      if (sub === 'preview') {
        return json(res, 200, { ok: true, draft: store.ledgerImportPreview(uid, buf, source, nowMs) });
      }
      return json(res, 200, { ok: true, result: store.ledgerImportCommit(uid, buf, source, nowMs) });
    });
  }

  if (parts.length === 4 && parts[2] === 'usages') {
    const gid = idParam(parts[3]);
    if (gid === null) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.ledgerUpdateUsage(uid, gid, checkUsage(b, true), nowMs));
      });
    }
    if (method === 'DELETE') {
      // 删用途会把它下面那些账户挪到「其它」（`store.ledgerDeleteUsage` 里做），
      // 所以这里**必须**把 nowMs 传下去（那些归属行要写 updated_at）
      store.ledgerDeleteUsage(uid, gid, nowMs);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }
  if (parts.length === 4 && parts[2] === 'views') {
    const vid = idParam(parts[3]);
    if (vid === null) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.ledgerUpdateView(uid, vid, checkLedgerView(b, true), nowMs));
      });
    }
    if (method === 'DELETE') {
      store.ledgerDeleteView(uid, vid);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }
  if (parts.length === 4 && parts[2] === 'accounts') {
    // ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`（那样合法的 id=0 会被误判）。
    const id = idParam(parts[3]);
    if (id === null) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.ledgerUpdateAccount(uid, id, checkLedgerAccount(b, true), nowMs));
      });
    }
    if (method === 'DELETE') {
      store.ledgerDeleteAccount(uid, id, nowMs);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }

  if (parts.length === 4 && parts[2] === 'entries') {
    const eid = idParam(parts[3]);
    if (eid === null) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.ledgerUpdateEntry(uid, eid, checkEntry(b, true), nowMs));
      });
    }
    if (method === 'DELETE') {
      store.ledgerDeleteEntry(uid, eid, nowMs);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }
  if (parts.length === 4 && parts[2] === 'categories') {
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.ledgerUpdateCategory(uid, cid, checkCategory(b, true), nowMs));
      });
    }
    if (method === 'DELETE') {
      // `mode` 是**查询参数**：缺省 `archive`（子分类一起归档）／`move-children`（子分类挪到同侧「其它」）
      const p = (url && url.searchParams) || null;
      const raw = p ? p.get('mode') : null;
      // `mode=delete` 走**真删除**（行没了）—— ⛔ 既有那两种模式一个字节不改。
      // 判据写在这里、⛔ 不塞进 `checkMode()`：那个白名单只认归档那一族的取值。
      if (String(raw == null ? '' : raw).trim() === 'delete') {
        return json(res, 200, store.ledgerDeleteCategory(uid, cid, nowMs));
      }
      return json(res, 200, store.ledgerArchiveCategory(uid, cid, checkMode(raw), nowMs));
    }
    return notFound(res);
  }

  if (parts.length === 5 && parts[2] === 'entries' && parts[4] === 'refunds') {
    if (method !== 'POST') return notFound(res);
    const eid = idParam(parts[3]);
    if (eid === null) return notFound(res);
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      // `refund_of` 取自**路径**（`/entries/:id/refunds`），⛔ 不收请求体里带来的那个
      // —— 收的话「给哪一笔记退款」就交给客户端了（与「user_id 一律来自会话」同一条纪律）。
      const input = checkRefund(b);
      input.refund_of = eid;
      json(res, 201, store.ledgerAddRefund(uid, input, nowMs));
    });
  }
  if (parts.length === 5 && parts[2] === 'accounts' && parts[4] === 'changes') {
    if (method !== 'GET') return notFound(res);
    const aid = idParam(parts[3]);
    if (aid === null) return notFound(res);
    const p = (url && url.searchParams) || null;
    const month = checkMonth(p ? p.get('month') : null, dateOf(nowMs));
    const before = checkCursor(p ? p.get('before') : null);
    const type = checkChangeType(p ? p.get('type') : null);
    return json(res, 200, { changes: store.ledgerAccountChanges(uid, aid, month, before, type) });
  }
  // 取消归档（「删除＝归档」的回程 —— 让那一行重新可选）。
  // **五段**（`categories/:id/restore`），⛔ 不能写成四段 `categories/restore`
  // （那会命中四段那条 `parts[2] === 'categories'`、被当成 `:id='restore'` ⇒ 404）。
  if (parts.length === 5 && parts[2] === 'categories' && parts[4] === 'restore') {
    if (method !== 'POST') return notFound(res);
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    return json(res, 200, store.ledgerRestoreCategory(uid, cid, nowMs));
  }

  return notFound(res);
}

module.exports = { ledger: handleLedger };
