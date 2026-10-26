'use strict';
/**
 * modules/ledger/routes.js —— 记账路由（一屏一次给全 ＋ 账户的增 / 改 / 删）
 *
 * 功能：`handleLedger` 一处收全部记账接口 —— `GET /api/ledger/overview`（资产 / 负债 / 净值 ＋
 *      分组小计 ＋ 账户 ＋ 当年快照 ＋ 服务端「今天」搭车）、`POST /api/ledger/accounts`（建）、
 *      `PUT /api/ledger/accounts/:id`（逐键改）、`DELETE /api/ledger/accounts/:id`（删）、
 *      `GET /api/ledger/transfers?account=`（一个账户的转账明细）、
 *      `POST /api/ledger/transfers`（账户之间转一笔）、
 *      `/api/ledger/views`（自定义分类的增 / 改 / 删）。
 *
 * ⭐ 3 期（`0.8.2`）新增：`GET /api/ledger/budget?period_type=&period_key=`（预算屏一屏）、
 *      `PUT /api/ledger/budget`（设 / 改一行额度 ⇒ 200）、`DELETE /api/ledger/budget`（清除一行；
 *      ⭐ `category_id=0` ⇒ 连带清掉该期全部分类预算）、`GET /api/ledger/bill?period_type=&period_key=`
 *      （账单屏一屏，三档共用）、`GET /api/ledger/month-bill?month=YYYY-MM`（月详情页一屏）；
 *      ⭐ 另外 `GET /api/ledger/entries` 的响应**搭车**加了 `summary`（当月收入 / 支出）与
 *      `dayTotals`（按天两个小计）—— 明细屏因此**一个请求**就够。
 *
 * ⭐⭐ 3.1 期（`0.8.2`）新增**四条**（三方导入 · 鲨鱼记账）：
 *      · `POST   /api/ledger/import/preview?source=shark`  **原始字节体** ⇒ 预览草稿（⛔ 不落库）；
 *      · `POST   /api/ledger/import/commit?source=shark`   同一个文件**再发一次** ⇒ 真写库；
 *      · `GET    /api/ledger/import?source=shark`          该来源的导入概况（⛔ 不写库）；
 *      · `DELETE /api/ledger/import?source=shark`          **整批清除**（回 `deleted`）。
 *      ⚠️ `source` **必填**且只认注册表（`lib/import-sources.js`）里的键（其余 ⇒ 400）；
 *      请求体是**原始字节**（⛔ 不是 JSON）—— 解析（编码 / 格式 / 列名 / 逐行）整份住业务层，
 *      本层只负责「读原始体 ＋ 限体积（413 在读体之前）＋ 拼响应」。
 *      ⭐ 另外 `GET /api/ledger/entries` 的响应又多搭了 `imported`（该月**全部**导入行，不分页）
 *      —— 明细屏仍是**一个请求**。
 *
 * 说明：⭐ **账户只属于账号本人**（`userScoped`），所以每条带 id 的动作都先过归属校验，
 *      越权与「不存在」统一 404（403 等于告诉对方「这条记录存在，只是不归你」）。
 *
 * 说明：⭐ 接口设计与日历 / 番茄钟 / 灵感库同构（统一 `ctx` 参数表），鉴权由 `server.js`
 *      的 401 闸门保证 —— `/api/ledger/*` 挂在闸门**之后**。
 *
 * ⚠️ **全部入参校验在接口层**：类型不在九类 / 名称为空或超长 / 卡号不是四位数字 /
 *    备注超长 / 余额串非法（负号 / `+` / 千分位 / 超两位小数） / 年份越界 ——
 *    一律 **400**，⛔ **不静默清空、不静默截断、不静默四舍五入**。
 *
 * ⚠️ **「串 → 分」只在这一层调用 `lib/money.js`**（⛔ 原语层不做金额换算）：
 *    接口收的是**用户输入的字符串**（`opening`），⛔ 不接收「已经算好的分」——
 *    收一份算好的数字就等于把「谁是权威」这个问题交给了客户端。
 *
 * ⚠️ **本文件不许 require `./store.js` 或 `core/context.js`**：一 require 就建库，
 *    存储层单测当场失去独立性（本项目已记录的坑）。所以它只 `require` 纯函数与 `http-util`，
 *    `store` 从 `core/context.js` 取（那是运行期单例，本来就该在请求路径上取）。
 *
 * ⭐ **「现在」只取一次**：本文件的 `nowMs` 在整个请求内是同一个值，转手交给业务层 ——
 *    账户的时间戳、快照与「今天是几号」因此共享同一个「现在」。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.8.4
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

const { httpError, idParam, json, notFound, readBody, readRawBody, MAX_UPLOAD, rfc5987 } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');
const { isKind } = require('./lib/kinds.js');
const { parseFen } = require('./lib/money.js');
const { TAG_MAX, VIEW_NAME_MAX } = require('./lib/views.js');
// ⭐ 0.8.1：收支分类的名字上限（与账户名同值 60，唯一出处住 lib/）
const { MAX_CATEGORY_NAME } = require('./lib/categories.js');
// ⭐ 0.8.2（3 期）：三档周期的白名单 —— **唯一出处**住 lib，
//    ⛔ 不在这里再抄一份 `['week','month','year']`（那就是第二份真相源）
const { PERIOD_TYPES } = require('./lib/budget.js');
// ⭐⭐ 0.8.2（3.1 期）：三方导入的**来源注册表** —— ⭐ 接口上的 `?source=`
//    只认它里面的键（⛔ 这里不抄 `'shark'` 那种字面量，加来源只加注册表一项）；
//    ⚠️ 表名**永远由注册表给**（业务层取 `src.table`），⛔ 绝不来自请求体 / 文件名 / 路径。
const { getSource, listSources } = require('./lib/import-sources.js');

/**
 * 名称长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_NAME`（任务 / 项目 / 日历标题）**同值 100 不同**：
 * 账户名是「工商银行(1904)」这种短标签，60 足够（方案 §六 的入参校验表写的就是 60）。
 */
const NAME_MAX = 60;
/** 备注长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_HW_NOTE` 同值（硬件备注也是 200） */
const NOTE_MAX = 200;
/** 尾号四位：**恰好四位数字**（⛔ 不宽容：`'123'` / `'12345'` / `'12a4'` 一律 400）
 *  ⭐ 起这一列一列两用：储蓄卡 / 信用卡是「卡号后四位」，
 *  信用支付 / 虚拟账户是「手机号 / 账号后 4 位」—— 形状一模一样，只是 label 不同。 */
const TAIL_RE = /^\d{4}$/;
/** 可在查询里指定的年份区间（方案 §六：1900~2100 之外 400） */
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
/** 月份参数 `YYYY-MM`（缺省 = 服务端今天那个月） */
const MONTH_RE = /^\d{4}-\d{2}$/;
/** 记账时刻的格式 —— `'YYYY-MM-DD HH:MM:SS'`（秒由前端带上， 第 11 条） */
const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** ⭐ 0.8.2：纯日期（3 期预算 / 账单的 `period_key` 就是它 —— **该期的起始日**，方案 §4.3 说明 2） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 一次最多几条 —— ⭐ C-16：30；> 30 **不静默截断**，直接 400 */
const PAGE_MAX = 30;
/** 账户详情那一屏的「变动类型」白名单（⛔ 不做关键词搜索 —— C-22） */
const CHANGE_TYPES = ['all', 'entry', 'transfer', 'adjust'];
/** 归档方式的白名单 */
const ARCHIVE_MODES = ['archive', 'move-children'];
/** ⭐ 0.8.3：图表口径（支出 / 收入）—— 与前端 `calc.js` 的 `CHART_DIRS` 是同一套键 */
const CHART_DIRS = ['out', 'in'];
/** ⭐ 0.8.3：导出「导什么」—— 与前端 `calc.js` 的 `EXPORT_WHATS` 是同一套键 */
const EXPORT_WHATS = ['entries', 'accounts', 'imported'];

/**
 * 功能：校验并归一化「建 / 改一个账户」的入参。
 *
 * 说明：⭐ **部分更新（`partial`）只校验请求里真的带了的字段**——
 *      没带的键不进结果对象，业务层会用**现状**补上。
 *      ⚠️ 空串一律按「清掉」处理（`tail` / `note` 都是可空的）：`''` 与 `null` 在库里是同一件事。
 *      ⚠️ `opening` 走 `parseFen()` 且**只收字符串**：数字类型的 `8.7` 在解析成 double 那一刻
 *      就已经丢过精度了，收下它就是收下一个可能已经错了的数（⛔ 不 `String()` 纠正）。
 *
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只校验带了的键），false = 建（必填键必须齐）
 * @returns {Object} 归一化后的入参（只含要被写的键；金额已转成整数分）
 * @throws {Error} 任一字段非法时抛 400
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
    // ⚠️ 空串 = 「没填后四位」，不是非法值（它本来就是选填）
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

  // ⭐：储蓄卡 / 信用卡的**分级**与**三个限额**（只给这两类用；⚠️ 服务端不按类型卡它 ——
  //    「哪几类显示」是**版式**的事，住前端 `calc.js` 的 needLimitOf()，⛔ 这里不抄第二份名单）
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
      // ⚠️ 清空 ⇒ `null`（**不是 0**：「没设」与「设成 0」是两件事）
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
 *      ⚠️ 非四位数字 / 越界一律 400 且**把范围写进报错文案**（方案 §六）。
 *
 * @param {?string} raw - 请求里的 `year`
 * @param {string} todayStr - 服务端今天 `YYYY-MM-DD`
 * @returns {number} 归一后的年份
 * @throws {Error} 格式不对 / 越界时抛 400
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
 *      · 两个 id 必须是**正整数**（`'abc'` / `0` / `-3` / 空 一律 400）——
 *        ⚠️ 别用 `idParam()`：它对空串回 `0`（`Number('') === 0`），而 `0` 在这里是**非法 id**，
 *        静默当成 0 会让「没传转出账户」变成一个查不到的账户（错误信息变味）；
 *      · `from_id !== to_id`（自己转给自己 ⇒ 400）：它不读库就能判，而且**必须拒**
 *        （否则两个相反的 UPDATE 打在同一个账户上，结果取决于执行顺序，谁也说不清）；
 *      · 金额走 `parseFen()` 且**必须 > 0**：`parseFen` 允许 `'0'`（账户余额可以是 0），
 *        但转 0 元没有意义 ⇒ 这里补一条 400（⛔ 不静默接受）。
 *      ⚠️ **「余额够不够」不在这里** —— 那要读库，住 `store.js` 的 `ledgerAddTransfer()`
 *      （分工与 `checkTags()` / `applyTags()` 那一条完全同款）。
 *
 * @param {*} b - 请求体
 * @returns {{from_id: number, to_id: number, amount_fen: number, note: string}} 归一化后的入参（金额已转成整数分）
 * @throws {Error} 任一字段非法时抛 400
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
 *      （`Number('') === 0`），而 `0` 不是一个合法 id ⇒ 会把「没传」与「传了 0」
 *      合并成同一种错，报错文案也跟着变味。本函数对空串 / 小数 / 负号 / 文字一律 null。
 *
 * @param {*} raw - 原始值（查询参数或请求体里的字段）
 * @returns {?number} 正整数，或 null
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
 *      ⇒ 形状必须在进库前卡死：⛔ 不「大概像就收下」（那会让按月取数静默漏行）。
 *      ⚠️ 秒**由前端带上**（它知道「点开建这一步」那一刻的真实秒， 第 11 条）；
 *      ⛔ 服务端不覆盖前端给的时刻（用户可以补记过去 / 记未来 ——  第 3 条）。
 * @param {*} raw - 请求里的 `at`
 * @returns {string} 归一后的时刻串
 * @throws {Error} 格式不对 / 越界时抛 400
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
 *      ⛔ 不是本机日期、⛔ 不是「正在看的那一年」。
 * @param {?string} raw - 请求里的 `month`
 * @param {string} todayStr - 服务端今天 `YYYY-MM-DD`
 * @returns {string} `YYYY-MM`
 * @throws {Error} 格式不对 / 月份或年份越界时抛 400
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
 *      （那里同时定义了这三档各自的区间口径）—— 两处各写一份字面量数组必然漂移。
 *      ⚠️ 档位不认识 ⇒ **400**（⛔ 不兜成「月」：静默兜底会让一个拼错的档位按错的口径算账，
 *      而界面上看不出任何异常）。
 *
 * @param {?string} raw - 请求里的 `period_type`
 * @returns {string} `'week'` / `'month'` / `'year'`
 * @throws {Error} 缺 / 不认识时抛 400
 */
function checkPeriodType(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!PERIOD_TYPES.includes(s)) throw httpError(400, '预算周期只能是 周 / 月 / 年 三档');
  return s;
}

/**
 * 功能：校验 `period_key` —— 必须是 `YYYY-MM-DD`，且**真的是这一档的起始日**。
 *
 * 说明：⭐⭐ 三档各自的起点（方案 §6.2 / §4.3 说明 2）：
 *      周 ⇒ **周一**（预算）或 **1 号**（账单 / 图表，见 `weekMode`）、月 ⇒ **1 号**、
 *      年 ⇒ **1 月 1 日**；
 *      ⛔ **不替用户四舍五入到起点**（静默纠正会让「取到的是哪一期」变成一个
 *      客户端永远猜不准的东西）。传 `2026-09-23`（周三）当周起点 ⇒ **400**，
 *      而不是悄悄当成 `2026-09-21` 那一周。
 *      ⚠️⭐ 另外还要过**真实日历**这一关：`2026-02-30` 这种串 `new Date` 会**静默进位**成
 *      3 月 2 日（于是它「看起来」是一个合法的周一）⇒ 必须回读年月日核对，⛔ 不能只看范围。
 *      ⚠️ 星期的判据用**本地时区**的 `getDay()`：与 `dateOf()` 的「今天」、`AT_RE` 的时刻
 *      是同一条尺子（`at` 本来就是按本地时刻写出来的）。
 *
 * @param {string} periodType - 已校验的档位（`'week'` / `'month'` / `'year'`）
 * @param {?string} raw - 请求里的 `period_key`
 * @param {string} [weekMode] - ⭐⭐ 0.8.4：**周档的键是哪一种** ——
 *      `'month'` = 账单 / 图表（那一格的期间是**某个月**，键必须是那个月的 **1 号**，
 *      表格列该月内各周）；缺省 = 预算（那一期是**某一周**，键必须是**周一**）。
 *      ⚠️ 两种形状**互斥**：`2026-09-21`（周一）给账单 ⇒ 400，`2026-09-01` 给预算 ⇒ 400。
 *      ⛔ 不做「猜一个」的回落 —— 那会让「取到的是哪一期」变成一个客户端猜不准的东西。
 * @returns {string} 归一后的起始日 `YYYY-MM-DD`
 * @throws {Error} 格式 / 日历 / 起点任一不合法时抛 400
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
 *      **带了**一个不认识的字符串 ⇒ 400，⛔ 不静默回落 —— 回落的话前端传 `income`（英文全称）
 *      会画出一屏**支出**的图，而用户以为自己切到了收入（一个看着正常的假图）。
 *
 * @param {?string} raw - 查询参数 `dir`
 * @returns {string} `'out'` / `'in'`
 * @throws {Error} 带了但不认识时抛 400
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
 *      用户还没打字时就是这个状态，⛔ 别把它当 400（那会让搜索框一打开就弹错）。
 *
 * @param {?string} raw - 查询参数 `q`
 * @returns {string} 去空白后的关键字
 * @throws {Error} 超过 `SEARCH_Q_MAX` 个字符时抛 400
 * @since 0.8.4
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
 *      拿到的却是全部数据 —— 他会用一个错的文件做后续所有事，而且**没人报错**。
 *
 * @param {?string} raw - 查询参数 `range`
 * @returns {string} `'all'` / `'YYYY'` / `'YYYY-MM'`
 * @throws {Error} 形态非法或年份越界时抛 400
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
 * 说明：⭐⭐ 照既有三先例（方案 §6.1 / C-19）：
 *      · `Content-Type: text/csv; charset=utf-8`（与课表模板那条一致）；
 *      · `Content-Disposition` = **ASCII 兜底名 ＋ RFC 5987 中文名**（照 `routes/backup.js`）——
 *        `filename=` 只允许 ASCII，直接塞中文会被浏览器丢掉或变乱码，所以两者**成对**出现；
 *      · `Cache-Control: no-store`：这是**用户自己的全量账目**，⛔ 不许被任何中间层缓存；
 *      · **BOM 在这里贴**（`'\uFEFF' + csv`）—— 业务方法只产出文本（⛔ 不掺 BOM），
 *        与课表模板那种「生成器不管 BOM」同一条分工。
 *      ⚠️ ⛔ **不许用 Blob / `createObjectURL`**（那是前端的事，且全仓零命中）——
 *      这条接口就是给浏览器**导航下载**用的（C-20）。
 *
 * @param {Object} res - HTTP 响应对象
 * @param {string} filename - 中文文件名（如 `ZXDesk-记账流水-2024年.csv`）
 * @param {string} asciiName - ASCII 兜底名（老客户端用）
 * @param {string} csv - CSV 文本（**不含 BOM**）
 * @returns {void}
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
 * 说明：⭐ `0` 是**哨兵**（方案 §4.3 说明 1：⛔ 不用 NULL —— SQLite 的 `UNIQUE` 把 NULL 当
 *      互不相等，用 NULL 表示总预算会让它能被插进去无数多行）。
 *      ⚠️⭐ 这里只验**形状**（非负整数）；「这个分类存不存在 / 是不是本人的」要读库
 *      ⇒ 住 `store.js`。⚠️ 它是**入参字段**不是被访问的资源
 *      ⇒ 不存在是 **400**（与「访问别人的资源 ⇒ 404」区分开，方案 §6.2）。
 *
 * @param {?string} raw - 请求里的 `category_id`（可以是 `null` / 不带）
 * @returns {number} 分类 id（`0` = 总预算）
 * @throws {Error} 不是非负整数时抛 400
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
 *      缺 `period_type` / `period_key` / `amount_fen` 一律 400（⛔ 不猜缺省值：
 *      「没带 = 总预算」这种默认会让一次拼错的请求悄悄改掉总预算）。
 *      ⚠️⭐ `amount_fen` 走 `parseFen()` 且**只收字符串**（数字类型在解析成 double 那一刻
 *      就已经丢过精度了，收下它就是收下一个可能已经错了的数）——
 *      **允许 `'0'`**（0 = 明确设成 0，与「没设过」是两件事，方案 §9.1-①）。
 *
 * @param {*} b - 请求体
 * @returns {{period_type: string, period_key: string, category_id: number, amount_fen: number}} 归一后的入参
 * @throws {Error} 任一字段非法时抛 400
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
 *      会重复或漏行。⚠️ 时刻里带空格 ⇒ 从**最后一个 `|`** 切开（时刻本身不含 `|`）。
 * @param {?string} raw - 请求里的 `before`
 * @returns {?{at: string, id: number}} 游标；没给时为 null
 * @throws {Error} 格式不对时抛 400
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
 *      · **必填**：缺了 ⇒ 400（⛔ 不兜成「第一个来源」—— 那会让一次拼错的请求悄悄导入另一种账）；
 *      · **只认注册表里的键**（`lib/import-sources.js`）：其余一律 400，⛔ 这里**不抄** `'shark'`
 *        这种字面量 —— 以后加别家只加注册表一项，这一处一个字都不用改；
 *      · ⚠️ **只返回键**（⛔ 不是表名）：表名由业务层从注册表取（`src.table`），
 *        ⛔ 绝不接受请求体 / 文件名 / 路径里的表名（那是 SQL 注入面 —— 方案 §2.2）。
 *      ⚠️ 报错文案里的来源名单**也来自注册表**（两处各写一份必然漂移）。
 *
 * @param {?URLSearchParams} p - 查询参数
 * @returns {string} 来源键（注册表里的 `key`）
 * @throws {Error} 缺 / 不认识时抛 400
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
 *      ⇒ 判据写成「带了这个键就收下，值是 `null` 就原样给 `null`」，
 *      ⛔ 不能写成「`if (src[k])`」（那会把 `null` 与「没带」混成同一件事）。
 * @param {Object} src - 请求体
 * @param {function(string): boolean} has - 判断键是否存在
 * @param {Object} out - 结果对象（就地写）
 * @returns {void}
 * @throws {Error} 给了不是正整数也不是 null 的值时抛 400
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
 *      业务层用**现状**补上。
 *      ⚠️ 金额走 `parseFen()` 且**只收字符串**（数字类型在解析成 double 那一刻已经丢过精度）；
 *      ⭐ **允许 `'0'`**（一笔可以记 0 元）。
 *      ⚠️ `category_id` 只验**形状**；「是不是本人的 / 有没有归档」要读库，住 `store.js`。
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只校验带了的键），false = 记（必填键必须齐）
 * @returns {Object} 归一化后的入参（金额已转成整数分）
 * @throws {Error} 任一字段非法时抛 400
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
 *      `ie` 一改，历史流水就跨到另一侧去了；`parent_id` 一改就是「搬家」，那是另一件事
 *      ⇒ 想改这两样只有一条路：归档重建（可见、可解释）。
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只收 `name` / `sort_order`）
 * @returns {Object} 归一化后的入参
 * @throws {Error} 任一字段非法时抛 400
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
 *      `categories` 里某个分类给 `null` ⇒ **清掉**该分类的默认（回到全局那一层）。
 *      ⚠️ 全局两层**只改不删**⇒ 那两个键只收账户 id，⛔ 不收 `null`
 *      （要给 `null` 是 400，不是「静默忽略」）。
 * @param {*} b - 请求体
 * @returns {Array.<{kind: string, category_id: number, account_id: ?number}>} 要执行的动作（`account_id: null` = 清除）
 * @throws {Error} 形状不对时抛 400
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
 *      · `GET    /api/ledger/overview?year=YYYY`  一屏所需的全部（⭐ 搭车给服务端「今天」）
 *      · `GET    /api/ledger/account-names`       账户 id → 名字的**合并视图**（⭐ 2 期新增的取名口）
 *      · `POST   /api/ledger/accounts`            建账户
 *      · `PUT    /api/ledger/accounts/:id`        改账户（逐键）
 *      · `DELETE /api/ledger/accounts/:id`        删账户（⭐ 历史快照不动；⚠️ 转账明细跟着删）
 *      · `GET    /api/ledger/transfers?account=`  某个账户的转账明细（日期倒序）
 *      · `POST   /api/ledger/transfers`           转一笔（转出减、转入加，一个事务里写完）
 *      · `POST   /api/ledger/views`               建一套自定义分类（≤5 套；超了 400）
 *      · `PUT    /api/ledger/views/:id`           改一套分类（改名）
 *      · `DELETE /api/ledger/views/:id`           删一套分类（⭐ 连带它的用途归属；⛔ 不动账户）
 *      · `GET    /api/ledger/groups?scope=`       分组字段（九类顺序 / 内置用途）—— 只读
 *      · `POST   /api/ledger/usages`              新增一个用途字段（≤ `USAGE_MAX`；超了 400）
 *      · `PUT    /api/ledger/usages/:id`          给用途改名（⭐ 不动任何账户归属）
 *      · `DELETE /api/ledger/usages/:id`          删用途（⭐ 它下面的账户挪到「其它」）
 *      · `POST   /api/ledger/reorder`             拖排序的落点（`{what, ids}`，三处共用）
 *
 * ⭐ 0.8.1（2 期）新增的十三条：
 *      · `GET    /api/ledger/entries?month=&before=&limit=`  流水（按月 ＋ 游标倒序，一次 ≤ 30）
 *      · `POST   /api/ledger/entries`             记一笔 ⇒ 201
 *      · `PUT    /api/ledger/entries/:id`         改一笔（逐键）
 *      · `DELETE /api/ledger/entries/:id`         删一笔（⭐ 连带删它的退款条目）
 *      · `POST   /api/ledger/entries/:id/refunds` 给这一笔记一笔退款 ⇒ 201
 *      · `GET    /api/ledger/notes?category=&limit=`  备注历史候选（服务端一处给，≤ 20）
 *      · `GET    /api/ledger/categories`          收支分类（两级一次性给全，含已归档）
 *      · `POST   /api/ledger/categories`          新建（`parent_id` 决定一级 / 二级）
 *      · `PUT    /api/ledger/categories/:id`      改名 / 排序（⛔ 改不了 `ie` / `parent_id`；⭐ 改名的全称要唯一）
 *      · `DELETE /api/ledger/categories/:id?mode=` 归档（`archive` / `move-children`）／**真删除**（`delete`）
 *      · `POST   /api/ledger/categories/:id/restore` 取消归档（让那一行重新可选）
 *      · `POST   /api/ledger/restore-builtin`     恢复内置分类（对齐到内置清单；硬删旧预置）
 *      · `GET    /api/ledger/defaults`            默认账户（全局两层 ＋ 每类别一层）
 *      · `PUT    /api/ledger/defaults`            逐条 upsert（带哪个键写哪个）
 *      · `GET    /api/ledger/accounts/:id/changes?month=&before=&type=` 三类混排（记账 ＋ 转账 ＋ 调整）
 *
 * ⭐⭐ 上面那十三条是 §6.1 清单里的；**实际是十四条** —— 第 14 条是本次补的：
 *      · `GET    /api/ledger/account-names`       账户 id → 名字的**合并视图**（⭐ 取名口；含已删账户原名）
 *
 * ⭐ 0.8.1 又补一条（换内置清单时要的「恢复内置分类」）：
 *      · `POST   /api/ledger/restore-builtin`     把库里的收支分类对齐到内置清单（三段路径）
 *
 *      ⚠️ 为什么 §6.1 的清单里漏了它、它又非有不可：§7.3 / §7.4 明写「账户名要能显示**已删除账户的原名**」，
 *      真机验收第 8 条就是「删一个账户 ⇒ 它的转账 / 流水一条不少，列表里仍显示**原账户名**」；
 *      而「先查账户表、查不到再查删除记录表」这条判据按 C-8 **只准有一处**（就是 `store.ledgerAccountNames()`）。
 *      服务端**早就有**那个唯一判据，但它**没挂在任何一条路由上** ⇒ 两端拿不到名字，只能"拿不到就留空"
 *      （两端当时的注释里把它记成阻塞项）。所以这一条不是可选装饰，缺了它第 8 条验收根本不成立。
 *      ⭐ 编排者已在方案「附录 D · 执行期决策」里为这次补挂留痕。
 *
 * ⭐⭐ 0.8.2（3.1 期）又补**四条**（三方导入 · 鲨鱼记账）：
 *      · `POST   /api/ledger/import/preview?source=shark`  **原始字节体** ⇒ 预览草稿（⛔ 不落库）
 *      · `POST   /api/ledger/import/commit?source=shark`   同一个文件**再发一次** ⇒ 真写库
 *      · `GET    /api/ledger/import?source=shark`          导入概况（⭐ `count=0` 不是错误）
 *      · `DELETE /api/ledger/import?source=shark`          **整批清除**（回 `deleted`）
 *      ⚠️ 三条**三段**（与 `bill` / `month-bill` 同级），一条**四段**（`import/preview|commit`）
 *      —— 这正是它们的 `method` 分派方式不同的原因（三段靠 GET / DELETE，四段靠 POST）。
 *
 * ⚠️ `overview` / `accounts` 这两段**必须先于 id 解析**判掉：`idParam('accounts')` 回 `null`，
 *      先解析就会把它当成一个「不存在的 id」→ 404，而它们其实是**合法的子资源**。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {Object} ctx.url - 解析好的 URL 对象（取查询参数）
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
/**
 * 功能：校验「账户在某几套分类里的用途」这一格 —— ⚠️ 只验**形状**，不验归属。
 *
 * 说明：⭐ 分工写死在这里：`tags` 的形状（是不是对象 / 键是不是正整数 / 值是不是串 / 长度）
 *      是**纯形状**判据，住本层；「这套分类是不是你的」要读库，住 `store.js` 的 `applyTags()`。
 *      ⚠️ 空串是**合法值**（＝ 回到「其它」），⛔ 不当错误 —— 它的语义是「清掉这一套的用途」。
 *      ⚠️ 键不是正整数一律 400：静默忽略会让用户以为设上了，而那条归属**根本没写进去**。
 *
 * @param {*} raw - 请求体里的 `tags`
 * @returns {Object} `{ <viewId>: <用途 | ''> }`
 * @throws {Error} 形状不对 / 用途名超长时抛 400
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
 *      （一行放得下），分类名是**胶囊**（更宽），两者本来就是两把尺子。
 *      ⚠️ 覆盖的是 `scope='usage'` 那一套；九类（`scope='kind'`）的名字来自代码，**不可改**，
 *      所以这里没有「改类型名」的口子（`store.ledgerUpdateUsage` 也只认 usage）。
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只校验带了的键）
 * @returns {Object} `{name}`
 * @throws {Error} 名字为空 / 超长时抛 400
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
 *      三个值之外一律 400 —— 这一层挡住「让人传表名」的可能，原语层再挡一次
 *      （表名在两个后端里写死，见那两处注释）。
 *      ⚠️ `ids` 必须**整体都是合法 id**：有一个不是就 400（⛔ 不「过滤掉坏的那个接着排」——
 *      那会让前端以为自己拖成功了，而顺序里少了一个）。
 * @param {*} b - 请求体
 * @returns {{what: string, ids: Array.<number>}} 归一化后的入参
 * @throws {Error} 形状不对时抛 400
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
  // ⭐：what=tags 是「某一套分类**组内的先后**」⇒ 必须说明是**哪一套**。
  //    ⚠️ 缺了就 400（⛔ 别默认成「第一套」—— 那会静默改错一套分类的顺序）
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
 *      「先查账户表、查不到再查删除记录表」这条判据**只准有一处**）—— ⛔ 本文件不另写一份 SQL、
 *      ⛔ 不按 id 另拼一份 map（那正是「前端/路由自己拼一份取名口径」）。
 *      ⭐ **空账户（`special = 1`）的名字在这一处由「空账户」改成 `'不关联'`**：库里的那一行
 *      名字写死成「空账户」，而界面上它代表的正是「不关联」——
 *      这个转换**只住这一处**，⛔ 不让两端各自再判一次 `special`（那就是第二份口径）。
 *      ⚠️ `deleted_ids` 是「名字来自删除记录表」的那些 id（两端可据此做弱化样式）。
 *      ⚠️ 只读：⛔ 不写库（GET 一律不写库）。没有 id 入参 ⇒ 不存在「越权 / 不存在」这一档，
 *      正常路径只可能 200（401 由闸门在 `/api/ledger/*` 之前判掉）。
 *
 * @param {number} uid - 账号 id
 * @returns {{names: Object.<string, string>, deleted_ids: Array.<number>}} 这条接口的响应体
 */
function accountNamesOf(uid) {
  const names = {};
  const deletedIds = [];
  for (const r of store.ledgerAccountNames(uid)) {
    const id = Number(r.id);
    // ⭐ 空账户 ⇒「不关联」（唯一转换点，见上）；其余照原名，⛔ 不猜、不造
    names[String(id)] = Number(r.special) === 1 ? '不关联' : String(r.name == null ? '' : r.name);
    if (r.deleted) deletedIds.push(id);
  }
  return { names, deleted_ids: deletedIds };
}

function handleLedger({ req, res, parts, url, method, uid }) {
  // ⭐ 整个请求共用同一个「现在」（见文件头说明）
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
    // ⭐ 0.8.1：取名口 —— 账户 id → 名字的**合并视图**（含已删账户的原名；空账户显示为「不关联」）。
    //    ⚠️ 段名 `account-names` 必须先于四段的 `accounts/:id` 判掉？不必：它是**三段**
    //    （`['api','ledger','account-names']`），与 `accounts/:id` 那两段（四段 / 五段）根本不同长，
    //    ⛔ 也不会被 `idParam('account-names')` 当 id 解析（那一条只在四段以上才跑）。
    if (parts[2] === 'account-names') {
      if (method !== 'GET') return notFound(res);
      return json(res, 200, accountNamesOf(uid));
    }
    // ⭐ 0.8.1：流水列表（按月 ＋ 游标倒序，一次 ≤ 30）与记一笔
    if (parts[2] === 'entries') {
      const p = (url && url.searchParams) || null;
      if (method === 'GET') {
        const month = checkMonth(p ? p.get('month') : null, dateOf(nowMs));
        const before = checkCursor(p ? p.get('before') : null);
        const limit = checkLimit(p ? p.get('limit') : null);
        // ⭐ 3 期搭车：`summary`（当月收入 / 支出）与 `dayTotals`
        //    （按天两个小计）**由业务层算好挂在返回值上**（见 `ledgerEntries` 的说明）——
        //    ⚠️ 这里只把它们**原样放进响应体**，⛔ 接口层一个金额都不算（§6.3 第 4 条）。
        //    ⚠️⭐ 业务层回的是**数组**（本仓库老调用点全按数组用它）⇒ 必须**显式拼响应体**：
        //    `JSON.stringify` 会丢掉挂在数组上的那两个属性。
        //    ⭐⭐ 0.8.2（3.1 期）：第四个键 `imported` = 该月**全部**导入行
        //    （不分页、按 `(at, id)` 升序）—— 前端拿它与自有流水按天混排。
        //    ⚠️ 一律**显式拼响应体**：`JSON.stringify` 会丢掉挂在数组上的那三个属性。
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
    // ⭐ 0.8.2（3 期）：预算屏 —— 读一屏 / 设一行 / 清一行，三条**同级同段**
    //    （路径里没有 id，靠 `method` 分派：GET / PUT / DELETE）。三段都在这里。
    //    ⭐ `PUT` 是 **upsert**（命中已存在的那一行是**更新**，⛔ 不是 400）⇒ 回 **200**（⛔ 不是 201）。
    //    ⭐ `DELETE` 的 `category_id=0` ⇒ 业务层连带清掉该期**全部**分类预算（一个事务，/ 图 9）。
    //    ⚠️ 三条写完都**把最新的预算屏给回去**：界面「编辑 → 设 / 清额度 → 回预算屏」一个来回就够。
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
        // ⚠️ `category_id` 走 `checkCategoryId()`（`0` = 总预算哨兵；空 / 不带也是 `0`）
        const input = {
          period_type: q.period_type,
          period_key: q.period_key,
          category_id: checkCategoryId(p ? p.get('category_id') : null),
        };
        return json(res, 200, { ok: true, budget: store.ledgerClearBudget(uid, input, nowMs) });
      }
      return notFound(res);
    }
    // ⭐ 0.8.2：账单屏 —— 周 / 月 / 年三档**共用这一条**（靠 `period_type` 分派，⛔ 不是三条接口）
    if (parts[2] === 'bill') {
      if (method !== 'GET') return notFound(res);
      // ⭐⭐ 0.8.4：账单的周档 = **某个月内的各周** ⇒ 键按「月 1 号」校验（`weekMode='month'`）。
      const q = checkPeriodQuery((url && url.searchParams) || null, 'month');
      return json(res, 200, { bill: store.ledgerBillView(uid, q.period_type, q.period_key, nowMs) });
    }
    // ⭐ 0.8.2：月详情页（⭐ **只有「月」档有这一页** —— 周 / 年停在账单屏，§7.3.3 范围已澄清）
    //    ⚠️ `month` 的口径照现有 `ledgerEntries`（缺省 = 服务端今天那个月）
    if (parts[2] === 'month-bill') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const month = checkMonth(p ? p.get('month') : null, dateOf(nowMs));
      return json(res, 200, { month_bill: store.ledgerMonthBill(uid, month, nowMs) });
    }
    // ⭐⭐ 0.8.3（4 期）：三条**只读** GET —— 期间清单 / 图表一屏 / 导出 CSV。
    //    · `GET /api/ledger/periods`  ⭐「有数据的年 / 月 / 周」（图表与导出「选期间」的地基，
    //      同时解掉 0.8.1 起那条「月份下拉拿不到有记录的月」的已知问题）；
    //    · `GET /api/ledger/chart`    折线 ＋ 两个数 ＋ 排行榜（参数与账单**逐字一致**：
    //      `period_type` / `period_key` ＋ 一个 `dir`）；
    //    · `GET /api/ledger/export`   ⭐ 附件下载（⛔ 不是 JSON）—— 响应头照既有三先例（`sendCsv()`）。
    //    · ⭐ 0.8.4 补 `GET /api/ledger/search`（搜流水）—— 同样只读、同样是**三段**路径。
    //    ⚠️ 三条路径都是**三段**（与 `bill` / `month-bill` 同级）：⛔ 不能写成 `export/csv`
    //    那种四段 —— 那会落进下面那条 `parts[2] === 'import'` 之类的分支里（0.8.2 已经踩过一次）。
    //    ⚠️ 三条都**不写库**：`periods` / `chart` 纯读，`export` 也是纯读。
    // ⭐⭐ 0.8.4：**搜流水**（只读）—— 明细屏那颗放大镜要走它。
    //    ⚠️ 路径是**三段**（与 `periods` / `chart` / `export` 同级）。
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
      // ⭐⭐ 0.8.4：图表与账单**联动**（同一份期间选择）⇒ 周档的键也按「月 1 号」校验。
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
    // ⭐⭐ 0.8.2（3.1 期）：三方导入的**概况**与**整批清除** —— 两条**同级同段**
    //    （路径里没有 id，靠 `method` 分派：GET / DELETE）。
    //    · `GET    /api/ledger/import?source=shark`  概况（已导入多少笔 / 批次 / 跨度）；
    //    · `DELETE /api/ledger/import?source=shark`  整批清除（回 `deleted`）。
    //    ⚠️ 路径**必须是三段**（与 `bill` / `month-bill` 同级）：⛔ 不能写成 `import/summary`
    //    那种四段 —— 那会落进下面那条 `parts[2] === 'import'` 的 preview / commit 分支里。
    //    ⚠️ `GET` 那条**不写库**；`DELETE` 那条是「整批」（⛔ 没有单条删的路）。
    if (parts[2] === 'import') {
      const p = (url && url.searchParams) || null;
      const source = checkImportSource(p);
      if (method === 'GET') return json(res, 200, { ok: true, summary: store.ledgerImportSummary(uid, source) });
      if (method === 'DELETE') {
        return json(res, 200, { ok: true, deleted: store.ledgerImportClear(uid, source).deleted });
      }
      return notFound(res);
    }
    // ⭐ 0.8.1：备注历史候选（⛔ 无表：直接来自已有流水；上限 20 住业务层）
    if (parts[2] === 'notes') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const raw = p ? p.get('category') : null;
      // ⚠️ `category` 没给 ⇒ `null`（＝全部类别的候选）；给了就必须是一个正整数
      let cid = null;
      if (raw != null && String(raw).trim() !== '') {
        cid = positiveId(raw);
        if (cid === null) throw httpError(400, '类别要选一个存在的');
      }
      return json(res, 200, { notes: store.ledgerNoteCandidates(uid, cid) });
    }
    // ⭐ 0.8.1：收支分类（两级一次性给全，含已归档）与新建
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
    // ⭐ 0.8.1：「恢复内置分类」—— 把库里的收支分类对齐到内置清单（补全内置 ＋ 硬删旧预置）。
    //    ⚠️⭐ 路径**必须是三段**（与 `notes` / `defaults` 同级），⛔ 不能写成
    //    `categories/restore` —— 那会命中四段那条 `parts[2] === 'categories'`，
    //    被当成 `:id = 'restore'` ⇒ `idParam()` 回 null ⇒ 404（看着像路由没挂）。
    //    ⚠️ **不是管理员专属**：分类是**每账号自己**的数据，谁都能管自己的。
    //    ⚠️ 只写不读 ⇒ POST ✓；错误出口照四条规则，没有第五种写法。
    if (parts[2] === 'restore-builtin') {
      if (method !== 'POST') return notFound(res);
      return json(res, 200, store.ledgerRestoreBuiltin(uid, nowMs));
    }
    // ⭐ 0.8.1：默认账户（全局两层 ＋ 每类别一层）—— 读一次 / 逐条 upsert
    if (parts[2] === 'defaults') {
      if (method === 'GET') return json(res, 200, { defaults: store.ledgerDefaults(uid) });
      if (method === 'PUT') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          for (const op of checkDefaults(b)) {
            // ⚠️ `account_id` 为 `null` = **清掉**这一条（只可能是「每类别」那一层：
            //    全局两层只改不删，`checkDefaults()` 已经把 `null` 挡成 400）
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
    // ⭐ 0.8.0：分组字段（九类的显示顺序 ＋ 内置用途）—— 只读入口
    //    ⚠️ `scope` 白名单：给别的值就是 400（⛔ 不静默当成「两套都给」）
    if (parts[2] === 'groups') {
      if (method !== 'GET') return notFound(res);
      const p = (url && url.searchParams) || null;
      const scope = String((p && p.get('scope')) || '').trim();
      if (scope && scope !== 'kind' && scope !== 'usage') throw httpError(400, '分组类型不认识');
      return json(res, 200, { groups: store.ledgerGroups(uid, scope || null) });
    }
    // ⭐ 0.8.0：新增一个用途字段（内置「按账户用途」那一套）
    if (parts[2] === 'usages') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.ledgerAddUsage(uid, checkUsage(b, false), nowMs));
      });
    }
    // ⭐ 0.8.0：拖排序的落点（账户 / 分类胶囊 / 分组字段三处共用一个入口）
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
        // ⚠️ 账户不是本人的 ⇒ `store.ledgerTransfers()` 抛 404（⛔ 不许把「不是你的账户」
        //    显示成「这个账户还没有流水」—— 那等于把拒绝伪装成正常）
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
  // ---- ⭐⭐ 3.1 期（0.8.2）：三方导入（鲨鱼记账）—— **先看再导** ----
  //    · `POST /api/ledger/import/preview?source=shark` —— 原始字节体；**一个字节都不写库**；
  //    · `POST /api/ledger/import/commit?source=shark`  —— **同一个文件再发一次**，真写库。
  //    ⚠️ 为什么 commit 收的是文件本体、而不是前端回传的明细（与课表那条先例的**差别**）：
  //    课表的向导**让用户改草稿**，所以只能提交草稿；这里⛔ 不让改 ⇒ 再发一次文件更安全 ——
  //    否则等于开了一条「随便造 375 笔账」的写路径。
  //    ⚠️ 413 必须**在读体之前**回：先看 `Content-Length`，
  //    超了就直接回（⛔ 不等请求体收完）—— 文案用**记账自己的话**，⛔ 不借课表那句。
  //    ⚠️⭐ 解析（编码 / 格式 / 列名 / 逐行）**整份住业务层的 `planImport()`**：预览与写库
  //    共用同一份⇒ 本层只把**原始字节**转手交下去、一个字节都不自己解释。
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
      // ⚠️ 删用途会把它下面那些账户挪到「其它」（`store.ledgerDeleteUsage` 里做），
      //    所以这里**必须**把 nowMs 传下去（那些归属行要写 updated_at）
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
    // ⚠️ `idParam` 对 `'overview'` 这类非数字段回 **null**（正是我们要的），但对 `null` 入参回 **0**
    //    ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`（那样合法的 id=0 会被误判）。
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

  // ---- 0.8.1 四段：`entries/:id`（改 / 删）与 `categories/:id`（改 / 归档）----
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
      // ⚠️ `mode` 是**查询参数**：缺省 `archive`（子分类一起归档）／`move-children`（子分类挪到同侧「其它」）
      const p = (url && url.searchParams) || null;
      const raw = p ? p.get('mode') : null;
      // ⭐ 0.8.3：`mode=delete` 走**真删除**（行没了）—— ⛔ 既有那两种模式一个字节不改。
      //    判据写在这里、⛔ 不塞进 `checkMode()`：那个白名单只认归档那一族的取值。
      if (String(raw == null ? '' : raw).trim() === 'delete') {
        return json(res, 200, store.ledgerDeleteCategory(uid, cid, nowMs));
      }
      return json(res, 200, store.ledgerArchiveCategory(uid, cid, checkMode(raw), nowMs));
    }
    return notFound(res);
  }

  // ---- 0.8.1 五段：`entries/:id/refunds`（记一笔退款）与 `accounts/:id/changes`（三类混排）----
  if (parts.length === 5 && parts[2] === 'entries' && parts[4] === 'refunds') {
    if (method !== 'POST') return notFound(res);
    const eid = idParam(parts[3]);
    if (eid === null) return notFound(res);
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      // ⚠️ `refund_of` 取自**路径**（`/entries/:id/refunds`），⛔ 不收请求体里带来的那个
      //    —— 收的话「给哪一笔记退款」就交给客户端了（与「user_id 一律来自会话」同一条纪律）。
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
  // ⭐ 0.8.3：取消归档（「删除＝归档」的回程 —— 让那一行重新可选）。
  //    ⚠️⭐ **五段**（`categories/:id/restore`），⛔ 不能写成四段 `categories/restore`
  //    （那会命中四段那条 `parts[2] === 'categories'`、被当成 `:id='restore'` ⇒ 404）。
  //    ⚠️ 只写不读 ⇒ POST；错误出口照四条规则，没有第五种写法。
  if (parts.length === 5 && parts[2] === 'categories' && parts[4] === 'restore') {
    if (method !== 'POST') return notFound(res);
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    return json(res, 200, store.ledgerRestoreCategory(uid, cid, nowMs));
  }

  return notFound(res);
}

module.exports = { ledger: handleLedger };
