'use strict';
/**
 * modules/calendar/routes.js —— 日历路由（一个屏所需的全部 + 事件 CRUD + 图层开关）
 *
 * 功能：`handleCalendar` 一处收全部日历接口 —— 区间聚合（事件 + **四个**开关 + **四个**图层 +
 *      服务端「今天」搭车 + 0.7.8 起还有「人生日历」的两项设置）、新建 / 改 / 删事件、
 *      改四个图层开关、改「人生日历」两项设置、⭐ 0.8.7 起还有「首页看板默认视图」的读与改。
 *
 * 说明：⭐ **事件只属于账号本人**（`userScoped`），所以每条带 id 的动作都先过归属校验，
 *      越权与「不存在」统一 404（403 等于告诉对方「这条记录存在，只是不归你」）。
 *
 * 说明：⭐ 接口设计与番茄钟 / 灵感库 / 硬件台账同构（统一 `ctx` 参数表），鉴权由 `server.js`
 *      的 401 闸门保证 —— `/api/calendar/*` 挂在闸门**之后**。
 *
 * ⚠️ **全部入参校验在接口层**：空标题 / 超长标题 / 非法日期 / 非法时刻 / 全天却带时刻
 *    一律 **400**，⛔ **不静默清空、不静默截断**。
 *    ⭐ 唯一的例外是「跨列约束判的是合并之后那一行」—— 那条落在 `store.js` 的 `assertEventRow()`
 *    （`PUT` 只带一个键时，坏数据是合并之后才产生的，单看请求体判不出来）。
 *
 * ⚠️ **常量"只写一处、写在用它的文件里"**：**格式与长度**在这里（只有接口层做入参校验），
 *    **默认值**在 `store.js`（存储层判空要用）。两者都不放同一个文件 —— 若 `store.js`
 *    反过来 require 本文件，装配链会把 `core/context.js` 拉进来（一 require 就建库），
 *    存储层单测当场失去独立性（本项目已记录的坑）。
 *
 * ⭐ **「现在」只取一次**：本文件的 `nowMs` 在整个请求内是同一个值，转手交给业务层 ——
 *    事件的时间戳、图层取数与「今天是几号」因此共享同一个"现在"，
 *    不会出现「同一个请求里两处差了几毫秒、跨过午夜就分成两天」这种漂移。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.9
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/18-日历-1期.md
 */

const { httpError, idParam, json, notFound, readBody } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');
const { nowInfo } = require('../../core/time-util.js');

/** 标题长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_NAME` **同值**（任务 / 项目标题也是 100） */
const TITLE_MAX = 100;
/** 备注长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_TT_REMARK` 同值（课表备注也是 500） */
const NOTE_MAX = 500;
/**
 * 一次最多能查多少天 —— ⚠️ **不是凑数**：`calendarLayer()` 是按天循环的（假期图层逐日问
 * `core/holidays.js`），没有上限的话一个手写的 `?from=1900-01-01` 就能让服务端转很久。
 * 月视图一个月最多 31 天，400 天足够覆盖「一次看一整年」的合理用法。
 */
const MAX_SPAN_DAYS = 400;

/**
 * 四个图层名 —— ⚠️ 与 `store.js` 的 `LAYER_KINDS` **必须逐字一致**（原语与业务层各留一份是惯例：
 * 路由层不许 require 业务层常量，否则会把 `core/context.js` 拉进装配链，见文件头）。
 * ⭐ 0.8.3 加的 `ledger`（记账）—— 漏了这一处，「`?layers=ledger` 指名要它」
 * 会被 `parseLayers()` **静默忽略**。
 * @type {Array.<string>}
 */
const LAYER_KINDS = ['course', 'task', 'holiday', 'ledger'];

/**
 * 图层开关的四个键 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**。
 * ⚠️ 漏了这一处，`PUT /api/calendar/layers` 收不到这个键 ⇒ 开关**存不下去**（且不报错）。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['layer_course', 'layer_task', 'layer_holiday', 'layer_ledger'];

/**
 * 「首页看板默认视图」的两个合法取值 —— ⚠️ 与 `store.js` 的 `VIEWS` **必须逐字一致**
 * （理由同上面两份清单：路由层不许 require 业务层常量）。
 *
 * 说明：⭐ 0.8.7。⛔ 漏了这一处，「药丸」存进去的值就会被当成非法而 400；
 *      反过来，值域写宽了（例如「任意字符串都收」）会让库里存进第三值 ——
 *      而读侧回落 `'list'` ⇒ 表现是「点了药丸、下次进来又是关的」且**不报错**。
 * @type {Array.<string>}
 */
const VIEW_VALUES = ['list', 'cal'];

/**
 * 预期寿命的取值范围（年）—— 0.7.8「人生日历」。
 *
 * 说明：⚠️ **上限是防呆**，不是「人只能活这么久」的结论 —— 与 `core/validate.js` 的
 *      `MAX_HW_LIFE_MONTHS = 600`（硬件的预期寿命上限）同款口径。
 *      超出范围一律 400，且**把范围写进报错文案**（方案 §六）。
 */
const EXPECT_YEARS_MIN = 1;
const EXPECT_YEARS_MAX = 150;

/**
 * 功能：校验 `YYYY-MM-DD`，并确认它**真的是日历上的一天**（不是 `2026-02-30`）。
 *
 * 说明：⚠️ 只比字符串是不够的：`2026-13-45` 也过正则。
 *      回环校验（`new Date(y, m-1, d)` 再取回来比一遍）能挡住「月份溢出 / 日期溢出」——
 *      那种值落库之后字典序仍然可比，但**永远匹配不到任何一天**，
 *      表现是「这条事件保存成功了、却在日历上找不到」，而且不报错。
 *
 * @param {string} v - 待校验的值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {string} 合法的日期串
 * @throws {Error} 格式不对 / 不是真实日期时抛 400
 */
function checkDate(v, what) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw httpError(400, `${what}要写成 2026-09-18 这样的日期`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    throw httpError(400, `${what}不是一个真实存在的日期`);
  }
  return s;
}

/**
 * 功能：校验 `HH:MM`（24 小时制）。
 *
 * 说明：⚠️ **必须是定长两位**：字典序就是时间序，靠的就是「`'09:05' < '10:00'`」这条性质
 *      （方案 §三）。`'9:05'` 会让字典序失效 —— 它比 `'10:00'` 大。
 *
 * @param {string} v - 待校验的值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {string} 合法的时刻串
 * @throws {Error} 格式不对 / 时分越界时抛 400
 */
function checkTime(v, what) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw httpError(400, `${what}要写成 09:30 这样的时刻`);
  if (Number(m[1]) > 23 || Number(m[2]) > 59) throw httpError(400, `${what}不是一个真实存在的时刻`);
  return s;
}

/**
 * 功能：校验 `from` / `to` 两个区间参数；都没给时取**服务端今天所在的那一个月**。
 *
 * 说明：⭐ 默认值是「今天所在整月」而不是「今天一天」：月视图是 V1 唯一的视图（方案 §三），
 *      不带参数进来时给一整月最有用。⚠️ 用的是**调用方给的服务端日期**，⛔ 不是本机日期
 *      （手机日期 / 时区不可靠）。
 *
 * @param {?string} fromRaw - 请求里的 `from`
 * @param {?string} toRaw - 请求里的 `to`
 * @param {string} todayStr - 服务端今天 `YYYY-MM-DD`
 * @returns {{from: string, to: string}} 归一后的区间
 * @throws {Error} 日期非法 / `from > to` / 跨度过大时抛 400
 */
function checkRange(fromRaw, toRaw, todayStr) {
  const has = (x) => x !== undefined && x !== null && String(x).trim() !== '';
  const monthStart = `${todayStr.slice(0, 7)}-01`;
  const from = has(fromRaw) ? checkDate(fromRaw, '区间起点') : monthStart;
  let to;
  if (has(toRaw)) {
    to = checkDate(toRaw, '区间终点');
  } else if (has(fromRaw)) {
    // 只给了起点 ⇒ 默认「起点所在整月」的月末（而不是起点当天）：与不带参数时的口径一致
    to = lastDayOfMonth(from);
  } else {
    to = lastDayOfMonth(from);
  }
  if (to < from) throw httpError(400, '区间的终点不能早于起点');
  if (spanDays(from, to) > MAX_SPAN_DAYS) throw httpError(400, `一次最多看 ${MAX_SPAN_DAYS} 天`);
  return { from, to };
}

/**
 * 功能：取某个日期所在**月份的最后一天**（`2026-02` → `2026-02-28`）。
 *
 * 说明：⚠️ 用 `Date(y, m, 0)` 这个「下个月第 0 天＝本月最后一天」的写法，
 *      ⛔ 不自己写闰年判断（那正是「到了 2 月 29 号才现形」的那类错）。
 *
 * @param {string} dateStr - `YYYY-MM-DD`
 * @returns {string} 同月最后一天 `YYYY-MM-DD`
 */
function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：两个日期之间相差多少天（含首尾）。
 * @param {string} from - `YYYY-MM-DD`
 * @param {string} to - `YYYY-MM-DD`
 * @returns {number} 天数
 */
function spanDays(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000) + 1;
}

/**
 * 功能：解析 `?layers=course,task,holiday,ledger` —— 要算哪几个图层。
 *
 * 说明：⚠️ **不认识的值一律忽略**，不打回 400（与 `pomodoro/stats` 的 `range`、
 *      灵感库的筛选参数同一条口径：筛选参数打回 400 只会让用户对着一个报错页，
 *      而不是"没筛出来"）。但**一个都没给**（或给了全是废值）时按**全要**处理：
 *      不带参数进来是绝大多数情况，那时用户要的就是完整的一屏。
 *
 * @param {?string} raw - 查询参数原文
 * @returns {Array.<string>} 要算的图层名（去重、顺序照 `LAYER_KINDS`）
 */
function parseLayers(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return LAYER_KINDS.slice();
  const asked = s.split(',').map((x) => x.trim());
  return LAYER_KINDS.filter((k) => asked.includes(k));
}

/**
 * 功能：校验并归一化「新建 / 改一条事件」的入参。
 *
 * 说明：⭐ **部分更新（`partial`）只校验请求里真的带了的字段**——
 *      没带的键不进结果对象，业务层会用**现状**补上（合并之后再判跨列约束）。
 *      ⚠️ 空串一律按「清掉」处理（`end_date` / `start_time` / `end_time` / `note` 都是可空的）：
 *      `''` 与 `null` 在库里是同一件事，让它们分家会在读侧造出两条不同的分支。
 *
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只校验带了的键），false = 新建（必填键必须齐）
 * @returns {Object} 归一化后的入参（只含要被写的键）
 * @throws {Error} 任一字段非法时抛 400
 */
function checkCalendarEvent(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};

  if (has('title')) {
    const t = String(src.title == null ? '' : src.title).trim();
    if (!t) throw httpError(400, '标题不能为空');
    if (t.length > TITLE_MAX) throw httpError(400, `标题不能超过 ${TITLE_MAX} 个字`);
    out.title = t;
  } else if (!partial) {
    throw httpError(400, '标题不能为空');
  }

  if (has('date')) out.date = checkDate(src.date, '开始日期');
  else if (!partial) throw httpError(400, '请给这条事件一个开始日期');

  if (has('end_date')) {
    const v = src.end_date == null ? '' : String(src.end_date).trim();
    // ⚠️ 空串 = 「当天结束」，不是非法值（表单清空跨天日期是常规操作）
    out.end_date = v ? checkDate(v, '结束日期') : '';
  }

  if (has('all_day')) {
    if (typeof src.all_day !== 'boolean') throw httpError(400, '「全天」只能是 true 或 false');
    out.all_day = src.all_day ? 1 : 0;
  }

  if (has('start_time')) {
    const v = src.start_time == null ? '' : String(src.start_time).trim();
    out.start_time = v ? checkTime(v, '开始时刻') : '';
  }
  if (has('end_time')) {
    const v = src.end_time == null ? '' : String(src.end_time).trim();
    out.end_time = v ? checkTime(v, '结束时刻') : '';
  }

  if (has('note')) {
    const n = String(src.note == null ? '' : src.note).trim();
    if (n.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
    out.note = n;
  }

  if (partial && !Object.keys(out).length) throw httpError(400, '没有要改的内容');
  return out;
}

/**
 * 功能：校验并归一化「改图层开关」的入参 —— ⭐ **带哪个键写哪个键**。
 * @param {*} b - 请求体
 * @returns {Object} 只含请求里真的带了的键（值是 0 / 1）
 * @throws {Error} 值不是布尔 / 一个键都没带时抛 400
 */
function checkCalendarLayers(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  for (const k of PREF_KEYS) {
    if (!has(k)) continue;
    if (typeof src[k] !== 'boolean') throw httpError(400, '图层开关只能是 true 或 false');
    out[k] = src[k] ? 1 : 0;
  }
  if (!Object.keys(out).length) throw httpError(400, '没有要改的图层开关');
  return out;
}

/**
 * 功能：校验并归一化「改人生日历两项设置」的入参 —— ⭐ **带哪个键写哪个键**。
 *
 * 说明：⭐ 与 `checkCalendarLayers` 同一条口径（只认请求里真带了的键），但底下是两个**不同**的校验：
 *      · `birth_date` 复用本文件的 `checkDate()`（含回环校验 ⇒ `2026-02-30` 一律 400）。
 *        ⛔ **刻意不做**「不许填 1900 年前」这类**合理性**判断 —— `18` §4.1 那条老缺陷是
 *        「只保证存在、不保证合理」，本项照旧（方案 §六 末段：别顺手扩大校验面）。
 *      · `expect_years` **只认整数**（`typeof === 'number'` 且 `Number.isInteger`）：
 *        字符串 `'80'` 同样 400 —— 与「非法一律 400、⛔ 不静默纠正」同一条。
 *      ⛔ 没带的键**不进结果对象**：业务层会用**现状**补上（`store.js` 的 `calendarSaveLife`），
 *      于是「只改出生日期」不会把预期寿命写成空 —— 这是「逐键」这件事的落点。
 *
 * ⭐⭐ **0.7.8补了一件事：显式清空**。带 `null` = 「这一项不要了」，与「**没带**这个键」
 *      是**两件事**，而两者都与「带了空串」不同：
 *      · 带 `null`        ⇒ 清空那一项（写回 NULL）；
 *      · 不带这个键       ⇒ 一个字不动；
 *      · 带 `''` / 非法值 ⇒ 一律 400。
 *      动机很实在：填错一次就得能退回去，而的「空串 / NULL 一律 400」会让用户**永远
 *      回不到空态**（与硬件那边「清空必须是一条合法操作」同一条精神，见 `ttt/test/hardware.test.js`）。
 *      ⚠️⭐ **与 hardware 刻意不同**（那边**空串**即清空）：这里的 `birth_date` 是个
 *      `type="date"` 输入框，「没选日期」在表单里天然就是空串 —— 让空串也算清空的话，
 *      误触一次保存就把生日抹了，而且**不报任何错**。所以清空必须是**明说**的那一下。
 *
 * @param {*} b - 请求体
 * @returns {Object} 只含请求里真的带了的键（值可以是 `null` = 清空）
 * @throws {Error} 日期不是真实存在的日期 / 预期寿命不是 `1~150` 的整数 / 一个键都没带时抛 400
 */
function checkCalendarLife(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};

  if (has('birth_date')) {
    out.birth_date = src.birth_date === null ? null : checkDate(src.birth_date, '出生日期');
  }

  if (has('expect_years')) {
    const v = src.expect_years;
    if (v !== null) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < EXPECT_YEARS_MIN || v > EXPECT_YEARS_MAX) {
        throw httpError(400, `预期寿命要填 ${EXPECT_YEARS_MIN}~${EXPECT_YEARS_MAX} 之间的整数（年）`);
      }
    }
    out.expect_years = v;
  }

  if (!Object.keys(out).length) throw httpError(400, '没有要改的内容');
  return out;
}

/**
 * 功能：校验「改首页看板默认视图」的入参 —— 只认 `'list'` / `'cal'` 两个字面量。
 *
 * 说明：⚠️ **不静默纠正**：认不出来的值一律 400，并把值域写进报错文案。
 *      ⛔ 刻意**不**接受 `null`（与 `life` 那两项不同）：这一列是「两个视图挑一个」，
 *      「清空」没有独立语义 —— 想让看板默认停列表，就明确写 `'list'`。
 *
 * @param {*} b - 请求体
 * @returns {{default_view: string}} 归一后的入参
 * @throws {Error} 键缺失 / 值不在值域内时抛 400
 */
function checkCalendarView(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (!Object.prototype.hasOwnProperty.call(src, 'default_view')) throw httpError(400, '没有要改的内容');
  const v = String(src.default_view == null ? '' : src.default_view).trim();
  if (!VIEW_VALUES.includes(v)) throw httpError(400, '默认视图只能是 list 或 cal');
  return { default_view: v };
}

/**
 * 功能：处理 `/api/calendar` 及其子路径 —— 日历的事件与图层。
 *
 * 说明：路由表（`parts = ['api','calendar', …]`）——
 *      · `GET    /api/calendar?from=&to=&layers=`  区间事件 + 四个开关 + 四个图层 + 「人生日历」两项设置
 *                                                  （⭐ 搭车给服务端「今天」；0.7.8 起还有 `life`）
 *      · `POST   /api/calendar`                    新建事件
 *      · `PUT    /api/calendar/:id`                改事件（逐字段）
 *      · `DELETE /api/calendar/:id`                删事件
 *      · `PUT    /api/calendar/layers`             改四个图层开关（逐键）
 *      · `PUT    /api/calendar/life`               改「人生日历」两项设置（逐键，0.7.8 ·）
 *      · `GET    /api/calendar/view`               读「首页看板默认视图」（0.8.7 ·）
 *      · `PUT    /api/calendar/view`               改「首页看板默认视图」（逐键，值域 `list` / `cal`）
 *
 * ⚠️ `layers` / `life` / `view` 这三段**必须先于 id 解析**判掉：`idParam('layers')` 回 `null`，
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
function handleCalendar({ req, res, parts, url, method, uid }) {
  // ⭐ 整个请求共用同一个「现在」（见文件头说明）
  const nowMs = Date.now();
  const todayStr = dateOf(nowMs);

  // ---- 两段：`GET` 一屏 / `POST` 新建 ----
  if (parts.length === 2) {
    if (method === 'GET') {
      const p = (url && url.searchParams) || null;
      const range = checkRange(p ? p.get('from') : null, p ? p.get('to') : null, todayStr);
      const kinds = parseLayers(p ? p.get('layers') : null);
      // ⭐ 0.8.9：搭车带回服务端的「现在」（`core/time-util.js` 的 `nowInfo()`）——
      //    当天面板的课程条要算「还有多久上课 / 上完没有」，时间权威源必须与看板、课表页**同一处**
      //    （服务端是时间权威；⛔ 不许在前端拿本机时钟自己判）。
      return json(res, 200, { ...store.calendarState(uid, range.from, range.to, kinds, nowMs), now: nowInfo() });
    }
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.createCalendarEvent(uid, checkCalendarEvent(b, false), nowMs));
      });
    }
    return notFound(res);
  }

  // ---- 三段：子资源 `layers` / `life`，或单条事件 `:id` ----
  if (parts.length === 3) {
    if (parts[2] === 'layers') {
      if (method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.calendarSavePrefs(uid, checkCalendarLayers(b), nowMs);
        return json(res, 200, { ok: true, prefs: next });
      });
    }
    // ⭐ 0.7.8「人生日历」：与 `layers` 平级的另一个子资源，同样**必须先于 id 解析**判掉
    //    （理由见文件头的路由表说明）。它改的是 `calendar_prefs` 上属于自己的那两个列，
    //    与四个图层开关互不覆盖（各有一条自己的 upsert 原语）。
    if (parts[2] === 'life') {
      if (method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.calendarSaveLife(uid, checkCalendarLife(b), nowMs);
        return json(res, 200, { ok: true, life: next });
      });
    }
    // ⭐ 0.8.7「首页看板默认视图」：第三个与 `layers` / `life` 平级的子资源。
    //    ⚠️ 同样**必须先于 id 解析**判掉（`idParam('view')` 回 null，先解析会把它当「不存在的 id」）。
    //    ⭐ 它既有 `GET` 也有 `PUT`（与那两个只写不读的子资源不同）：药丸只要一个枚举值，
    //    而设置页可能整个会话都没打开过看板 —— 为它算一遍 42 天的四个图层没有意义
    //    （`GET /api/calendar` 那一大份是给日历视图用的）。
    if (parts[2] === 'view') {
      if (method === 'GET') return json(res, 200, { view: store.calendarView(uid) });
      if (method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.calendarSaveView(uid, checkCalendarView(b), nowMs);
        return json(res, 200, { ok: true, view: next });
      });
    }
    const id = idParam(parts[2]);
    // ⚠️ `idParam` 对 `'layers'` 这类非数字段回 **null**（正是我们要的），但对 `null` 入参回 **0**
    //    ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`（那样合法的 id=0 会被误判）。
    if (id === null) return notFound(res);
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.updateCalendarEvent(uid, id, checkCalendarEvent(b, true), nowMs));
      });
    }
    if (method === 'DELETE') {
      store.deleteCalendarEvent(uid, id);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }

  return notFound(res);
}

/**
 * 功能：把 epoch 毫秒转成本地日期 `YYYY-MM-DD`（只用于「今天」与区间默认值）。
 * @param {number} ms - epoch 毫秒
 * @returns {string} 本地日期字符串
 */
function dateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { calendar: handleCalendar };
