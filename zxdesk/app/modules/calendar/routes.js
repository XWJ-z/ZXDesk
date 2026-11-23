'use strict';
/**
 * modules/calendar/routes.js —— 日历路由（一个屏所需的全部 + 事件 CRUD + 图层开关）
 * 功能：`handleCalendar` 一处收全部日历接口 —— 区间聚合（事件 + **四个**开关 + **四个**图层 +
 * 服务端「今天」搭车 + 还有「人生日历」的两项设置）、新建 / 改 / 删事件、
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
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
 */
const MAX_SPAN_DAYS = 400;

/**
 * 四个图层名 —— ⚠️ 与 `store.js` 的 `LAYER_KINDS` **必须逐字一致**（原语与业务层各留一份是惯例：
 * 加的 `ledger`（记账）—— 漏了这一处，「`?layers=ledger` 指名要它」
 */
const LAYER_KINDS = ['course', 'task', 'holiday', 'ledger'];

/**
 * 图层开关的四个键 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['layer_course', 'layer_task', 'layer_holiday', 'layer_ledger'];

/**
 * 「首页看板默认视图」的两个合法取值 —— ⚠️ 与 `store.js` 的 `VIEWS` **必须逐字一致**
 *
 */
const VIEW_VALUES = ['list', 'cal'];

/**
 *
 * 说明：⚠️ **上限是防呆**，不是「人只能活这么久」的结论 —— 与 `core/validate.js` 的
 */
const EXPECT_YEARS_MIN = 1;
const EXPECT_YEARS_MAX = 150;

/**
 *
 * 回环校验（`new Date(y, m-1, d)` 再取回来比一遍）能挡住「月份溢出 / 日期溢出」——
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
 *
 * @param {string} v - 待校验的值
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
 * 不带参数进来时给一整月最有用。⚠️ 用的是**调用方给的服务端日期**，⛔ 不是本机日期
 * （手机日期 / 时区不可靠）。
 *
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
 *
 * 说明：⚠️ 用 `Date(y, m, 0)` 这个「下个月第 0 天＝本月最后一天」的写法，
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
 * 而不是"没筛出来"）。但**一个都没给**（或给了全是废值）时按**全要**处理：
 * 不带参数进来是绝大多数情况，那时用户要的就是完整的一屏。
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
 * 没带的键不进结果对象，业务层会用**现状**补上（合并之后再判跨列约束）。
 * 空串一律按「清掉」处理（`end_date` / `start_time` / `end_time` / `note` 都是可空的）：
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
    // 空串 = 「当天结束」，不是非法值（表单清空跨天日期是常规操作）
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
 * `expect_years` **只认整数**（`typeof === 'number'` 且 `Number.isInteger`）：
 * 字符串 `'80'` 同样 400 —— 与「非法一律 400、⛔ 不静默纠正」同一条。
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
 * 刻意**不**接受 `null`（与 `life` 那两项不同）：这一列是「两个视图挑一个」，
 * 「清空」没有独立语义 —— 想让看板默认停列表，就明确写 `'list'`。
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
 * `GET    /api/calendar?from=&to=&layers=`  区间事件 + 四个开关 + 四个图层 + 「人生日历」两项设置
 * `POST   /api/calendar`                    新建事件
 */
function handleCalendar({ req, res, parts, url, method, uid }) {
  // 整个请求共用同一个「现在」（见文件头说明）
  const nowMs = Date.now();
  const todayStr = dateOf(nowMs);

  // ---- 两段：`GET` 一屏 / `POST` 新建 ----
  if (parts.length === 2) {
    if (method === 'GET') {
      const p = (url && url.searchParams) || null;
      const range = checkRange(p ? p.get('from') : null, p ? p.get('to') : null, todayStr);
      const kinds = parseLayers(p ? p.get('layers') : null);
      // 搭车带回服务端的「现在」（`core/time-util.js` 的 `nowInfo()`）——
      // 当天面板的课程条要算「还有多久上课 / 上完没有」，时间权威源必须与看板、课表页**同一处**
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
    // 「人生日历」：与 `layers` 平级的另一个子资源，同样**必须先于 id 解析**判掉
    // （理由见文件头的路由表说明）。它改的是 `calendar_prefs` 上属于自己的那两个列，
    // 与四个图层开关互不覆盖（各有一条自己的 upsert 原语）。
    if (parts[2] === 'life') {
      if (method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.calendarSaveLife(uid, checkCalendarLife(b), nowMs);
        return json(res, 200, { ok: true, life: next });
      });
    }
    // 「首页看板默认视图」：第三个与 `layers` / `life` 平级的子资源。
    // 同样**必须先于 id 解析**判掉（`idParam('view')` 回 null，先解析会把它当「不存在的 id」）。
    // 它既有 `GET` 也有 `PUT`（与那两个只写不读的子资源不同）：药丸只要一个枚举值，
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
    // ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`（那样合法的 id=0 会被误判）。
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
