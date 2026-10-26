'use strict';
/**
 * modules/trip/routes.js —— 行程路由（0.8.6）
 *
 * 功能：`handleTrip` 一处收全部行程接口 —— 一屏聚合（`GET /api/trip`）、行程 CRUD、车票 CRUD、
 *      三档提醒开关。轨迹点与打卡的 6 条随落地。
 *
 * 说明：⭐ 接口设计与日历 / 番茄钟同构（统一 `ctx` 参数表）；鉴权由 `server.js` 的 401 闸门保证
 *      —— `/api/trip/*` 挂在闸门**之后**。
 *
 * ⚠️ **全部入参校验在接口层**：空标题 / 超长 / 非法日期 / 非法时刻 / 非法枚举 / 票价为负
 *    一律 **400**，⛔ **不静默清空、不静默截断**。
 *    ⭐ 唯一的例外是「跨列约束判的是合并之后那一行」—— 那条落在 `store.js` 的
 *    `assertTripRow()` / `assertTicketRow()`（`PUT` 只带一个键时，坏数据是合并之后才产生的）。
 *
 * ⚠️ **常量「只写一处、写在用它的文件里」**：**格式与长度**在这里
 *    （只有接口层做入参校验），**默认值**在 `store.js`。两者都不放同一个文件 —— 若 `store.js`
 *    反过来 require 本文件，装配链会把 `core/context.js` 拉进来（一 require 就建库），
 *    存储层单测当场失去独立性。
 *
 * ⭐ **「现在」只取一次**：本文件的 `nowMs` 在整个请求内是同一个值，转手交给业务层 ——
 *    「今天」「倒计时」「下一张票」因此共享同一个"现在"。
 *
 * ⚠️⭐ **路由解析顺序**：`trips` / `tickets` / `points` / `prefs` 这几段**必须先于 id 解析**判掉
 *    —— id 是数字段，固定名段天然优先（本文件按段名逐个 `if`，不会走到 id 分支）。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.13
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

const { httpError, idParam, json, notFound, readBody } = require('../../../core/http-util.js');
const { store } = require('../../../core/context.js');

/** 标题长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_NAME` **同值**（任务 / 项目标题也是 100） */
const TITLE_MAX = 100;
/** 备注长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_TT_REMARK` 同值（课表备注也是 500） */
const NOTE_MAX = 500;
/** 短文本字段（车次 / 座位 / 检票口 / 航站楼 / 订单号 / 站名）的长度上限 */
const SHORT_MAX = 60;
/** 票价上限（整数分）= 一百万元 —— 与 `store.js` 那一份同值。 */
const PRICE_MAX_FEN = 100000000;

/**
 * 三档提醒开关的三个键 —— ⚠️ 与 `store.js` 的 `PREF_KEYS` **必须逐字一致**。
 * ⚠️ 漏了这一处，`PUT /api/trip/prefs` 收不到这个键 ⇒ 开关**存不下去**（且不报错）。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['remind_d3', 'remind_d1', 'remind_h3'];

/** ⭐ 一次最多补多少个点 —— ⚠️ 与 `store.js` 的 `POINT_MAX_BATCH` **必须逐字一致**。 */
const POINT_MAX_BATCH = 200;

/** 打卡点名字的长度上限 —— ⚠️ 与 `store.js` 的 `LABEL_MAX` 同值（按「站名 / 地名」的量级取 60）。 */
const LABEL_MAX = 60;

/** 车票六型 —— ⚠️ 与 `store.js` 的 `TICKET_KINDS`、`schema.js` 的 CHECK 逐字一致。 */
const TICKET_KINDS = ['train', 'highspeed', 'flight', 'bus', 'ship', 'other'];

/**
 * 「人生日历」预期寿命的取值范围（年）—— ⭐ 0.8.9：与日历模块那处**同值**。
 * ⚠️ 两处各留一份是刻意的（模块之间不互相 require 常量；先例见 `TICKET_KINDS` 那三份）。
 */
const EXPECT_YEARS_MIN = 1;
const EXPECT_YEARS_MAX = 150;

/**
 * 功能：校验 `YYYY-MM-DD`，并确认它**真的是日历上的一天**（不是 `2026-02-30`）。
 * @param {*} v - 待校验的值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {string} 合法的日期串
 * @throws {Error} 格式不对 / 不是真实日期时抛 400
 */
function checkDate(v, what) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw httpError(400, `${what}要写成 2026-09-30 这样的日期`);
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (dt.getFullYear() !== Number(m[1]) || dt.getMonth() !== Number(m[2]) - 1 || dt.getDate() !== Number(m[3])) {
    throw httpError(400, `${what}不是一个真实存在的日期`);
  }
  return s;
}

/**
 * 功能：校验 `YYYY-MM-DD HH:MM`（24 小时制、**定长两位**）。
 *
 * 说明：⚠️ **必须是定长两位**：字典序就是时间序，靠的就是「`'09:05' < '10:00'`」这条性质
 *      （方案 §三）。`'9:05'` 会让字典序失效 —— 它比 `'10:00'` 大。
 *
 * @param {*} v - 待校验的值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {string} 合法的时刻串
 * @throws {Error} 格式不对 / 时分越界 / 日期不存在时抛 400
 */
function checkKey(v, what) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (!m) throw httpError(400, `${what}要写成 2026-09-30 08:00 这样的时刻`);
  if (Number(m[4]) > 23 || Number(m[5]) > 59) throw httpError(400, `${what}不是一个真实存在的时刻`);
  checkDate(`${m[1]}-${m[2]}-${m[3]}`, what);
  return s;
}

/**
 * 功能：校验一段**可空的短文本**（≤ `SHORT_MAX` 字），空串原样返回（= 清空）。
 * @param {*} v - 待校验的值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {string} 归一化后的字符串（可能是空串）
 * @throws {Error} 超长时抛 400
 */
function checkShort(v, what) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > SHORT_MAX) throw httpError(400, `${what}不能超过 ${SHORT_MAX} 个字`);
  return s;
}

/**
 * 功能：校验一个**可空的时刻** `HH:MM`（行程的「起始时刻」用；空串原样返回 = 没填具体时刻）。
 *
 * 说明：⭐ 它与车票的 `checkKey`（`YYYY-MM-DD HH:MM`）**刻意分开**：行程的日期与时刻是两格
 *      （`start_date` ＋ `start_time`），合成「起始日期时间」由两端渲染时拼 —— 落库不拼成一份，
 *      因为 `trips.start_date` 是 `NOT NULL` 并且老数据里只可能是纯日期，
 *      ⛔ 把它改写成「日期时间」等于**改写用户数据**（铁律 18）。
 *
 * @param {*} v - 待校验的值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {string} `HH:MM` 或空串
 * @throws {Error} 格式非法时抛 400
 */
function checkClock(v, what) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw httpError(400, `${what}要写成 08:30 这样的时刻`);
  }
  return s;
}

/**
 * 功能：校验并归一化「新建 / 改一条行程」的入参。
 *
 * 说明：⭐ **部分更新（`partial`）只校验请求里真的带了的字段**——
 *      没带的键不进结果对象，业务层会用**现状**补上（合并之后再判跨列约束）。
 *      ⚠️ 空串一律按「清掉」处理（`vehicle` / `from_place` / `to_place` / `start_time` /
 *      `end_date` / `note` 都是可空的）。
 *      ⭐ `vehicle`（交通工具）的值域**就是票型那一套 key**（`TICKET_KINDS`）——
 *      两者本来就是同一个问题「这趟怎么走」；⛔ 别另立第二份清单（两份迟早分叉成
 *      「车里能选、票里不能选」）。
 *
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改（只校验带了的键），false = 新建（必填键必须齐）
 * @returns {Object} 归一化后的入参（只含要被写的键）
 * @throws {Error} 任一字段非法时抛 400
 */
function checkTrip(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};

  if (has('title')) {
    const t = String(src.title == null ? '' : src.title).trim();
    if (!t) throw httpError(400, '行程得有个名字');
    if (t.length > TITLE_MAX) throw httpError(400, `名字不能超过 ${TITLE_MAX} 个字`);
    out.title = t;
  } else if (!partial) {
    throw httpError(400, '行程得有个名字');
  }

  // ⭐ 0.8.6：交通工具 / 起点 / 终点 —— 三个都可空（不填就是没填）。
  if (has('vehicle')) {
    const v = src.vehicle == null ? '' : String(src.vehicle).trim();
    if (v && !TICKET_KINDS.includes(v)) {
      throw httpError(400, '交通工具只能从火车 / 高铁 / 飞机 / 汽车 / 船 / 其它里选');
    }
    out.vehicle = v;
  }

  if (has('from_place')) out.from_place = checkShort(src.from_place, '起点');
  if (has('to_place')) out.to_place = checkShort(src.to_place, '终点');

  if (has('start_date')) out.start_date = checkDate(src.start_date, '开始日期');
  else if (!partial) throw httpError(400, '请给这条行程一个开始日期');

  // ⭐⭐ 0.8.13：起始**时刻**从「可空」改成「**新建必填**」——
  //    首页「日程表」要按 `start_time` ~ `end_time` 画那一段的长度，缺了它那一段画不出来。
  //    ⚠️⭐ 只在**新建**（`partial === false`）时要求必填：老行（0.8.6 之前建的）`start_time` 是 NULL，
  //    `PUT` 只带 `{title}` 时不带这个键 ⇒ 这里必须放行，否则「老行程改个标题就 400」。
  //    ⚠️ 带了**空串**一律 400（空串的语义是「清掉」，而这一列不让清）。
  if (has('start_time')) {
    const v = checkClock(src.start_time, '起始时刻');
    if (!v) throw httpError(400, '请给这条行程一个起始时刻（格式 08:30）');
    out.start_time = v;
  } else if (!partial) {
    throw httpError(400, '请给这条行程一个起始时刻（格式 08:30）');
  }

  // ⭐⭐ 0.8.13：结束**时刻**（可空，与 `end_date` 同一条口径：空串 = 没填 / 清掉）。
  //    ⚠️ 「不得早于起始时刻」的跨列判据在**业务层**（`store.js` 的 `checkTripRow`）——
  //    那里判的是「合并之后整行长什么样」，同一天内才比先后（跨天时 23:40 → 次日 01:20 是正常的）。
  if (has('end_time')) out.end_time = checkClock(src.end_time, '结束时刻');

  if (has('end_date')) {
    const v = src.end_date == null ? '' : String(src.end_date).trim();
    // ⚠️ 空串 = 「当天结束」，不是非法值（表单清空结束日期是常规操作）
    out.end_date = v ? checkDate(v, '结束日期') : '';
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
 * 功能：校验并归一化「新建 / 改一张车票」的入参。
 *
 * 说明：⭐ `kind` / `from_station` / `to_station` / `depart_at` 是**新建时的必填**（方案 §6.2）；
 *      `arrive_at` / `code` / `seat` / `gate` / `terminal` / `order_no` / `note` 都可空。
 *      ⚠️⭐ **`price_fen` 只认数字**（整数分）：字符串 `'350'` 一律 **400**
 *      —— 与记账「不静默纠正」同款；「元 → 分」的换算在前端做（字符串解析，见 §7.4）。
 *      ⚠️ `trip_id` 只认**正整数或 null**（null = 解绑）；「是不是自己的行程」在业务层判（400）。
 *
 * @param {*} b - 请求体
 * @param {boolean} partial - true = 改，false = 新建
 * @returns {Object} 归一化后的入参（只含要被写的键）
 * @throws {Error} 任一字段非法时抛 400
 */
function checkTicket(b, partial) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};

  if (has('kind')) {
    if (!TICKET_KINDS.includes(String(src.kind))) throw httpError(400, '票型不对');
    out.kind = String(src.kind);
  } else if (!partial) {
    throw httpError(400, '请选一个票型');
  }

  for (const [k, what] of [
    ['code', '车次 / 航班号'],
    ['seat', '座位'],
    ['gate', '检票口'],
    ['terminal', '航站楼'],
    ['order_no', '订单号'],
  ]) {
    if (has(k)) out[k] = checkShort(src[k], what);
  }

  for (const [k, what] of [
    ['from_station', '出发站'],
    ['to_station', '到达站'],
  ]) {
    if (has(k)) {
      const v = checkShort(src[k], what);
      if (!v) throw httpError(400, `${what}不能为空`);
      out[k] = v;
    } else if (!partial) {
      throw httpError(400, `${what}不能为空`);
    }
  }

  if (has('depart_at')) out.depart_at = checkKey(src.depart_at, '出发时刻');
  else if (!partial) throw httpError(400, '请给这张票一个出发时刻');

  if (has('arrive_at')) {
    const v = src.arrive_at == null ? '' : String(src.arrive_at).trim();
    // ⚠️ 空串 = 「不填到达时刻」（它**不是票面的法定字段**，方案 §4.2）——
    //    ⛔ 也**不判**「到达必须晚于出发」：红眼航班与跨零点都是正常情形。
    out.arrive_at = v ? checkKey(v, '到达时刻') : '';
  }

  if (has('price_fen')) {
    const v = src.price_fen;
    if (v === null) out.price_fen = null;
    else {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > PRICE_MAX_FEN) {
        throw httpError(400, `票价要填 0 ~ ${PRICE_MAX_FEN / 100} 元之间的数字`);
      }
      out.price_fen = v;
    }
  }

  if (has('trip_id')) {
    const v = src.trip_id;
    if (v === null) out.trip_id = null;
    else {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw httpError(400, '归属行程不对');
      out.trip_id = v;
    }
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
 * 功能：校验并归一化「改三档提醒开关」的入参 —— ⭐ **带哪个键写哪个键**。
 * @param {*} b - 请求体
 * @returns {Object} 只含请求里真的带了的键（值是 0 / 1）
 * @throws {Error} 值不是布尔 / 一个键都没带时抛 400
 */
function checkTripPrefs(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  for (const k of PREF_KEYS) {
    if (!has(k)) continue;
    if (typeof src[k] !== 'boolean') throw httpError(400, '提醒开关只能是 true 或 false');
    out[k] = src[k] ? 1 : 0;
  }
  if (!Object.keys(out).length) throw httpError(400, '没有要改的提醒开关');
  return out;
}

/**
 * 功能：校验并归一化「改人生日历两项设置」的入参 —— ⭐ **带哪个键写哪个键**。
 *
 * 说明：⭐ 0.8.9：这两项从日历模块整体搬来进行程，校验口径与那边**逐字一致**：
 *      · `birth_date` 走本文件的 `checkDate()`（含回环校验 ⇒ `2026-02-30` 一律 400）；
 *        ⛔ **刻意不做**「不许填 1900 年前」这类**合理性**判断（老缺陷「只保证存在、不保证合理」照旧）。
 *      · `expect_years` **只认整数**：字符串 `'80'` 同样 400 —— 与「非法一律 400、⛔ 不静默纠正」同条。
 *      · 带 `null` = **清空那一项**；与「**没带**这个键」是两件事，也与「带了空串」不同
 *        （空串一律 400：`<input type="date">` 没选日期时天然是空串，让空串也算清空的话，
 *        误触一次保存就把生日抹了，而且**不报任何错**）。
 *      · 一个键都没带 ⇒ 400。
 *
 * @param {*} b - 请求体
 * @returns {Object} 只含请求里真的带了的键（值可以是 `null` = 清空）
 * @throws {Error} 日期不是真实日期 / 预期寿命不是整数或越界 / 一个键都没带时抛 400
 */
function checkTripLife(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  if (has('birth_date')) {
    out.birth_date = src.birth_date === null ? null : checkDate(src.birth_date, '出生日期');
  }
  if (has('expect_years')) {
    const v = src.expect_years;
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < EXPECT_YEARS_MIN || v > EXPECT_YEARS_MAX)) {
      throw httpError(400, `预期寿命要填 ${EXPECT_YEARS_MIN}~${EXPECT_YEARS_MAX} 之间的整数（年）`);
    }
    out.expect_years = v;
  }
  if (!Object.keys(out).length) throw httpError(400, '没有要改的设置');
  return out;
}

/**
 * 功能：归一化「归属行程」这个入参 —— `null` / 空串是**合法值**（= 不归属任何行程）。
 *
 * 说明：⚠️ 只判**形状**（正整数或 null）；「是不是自己的行程」在 `store.js` 判 **400**
 *      （方案 §6.2：它是个**入参**，不是被访问的资源）。
 *
 * @param {*} v - 原始值
 * @returns {?number} 行程 id 或 null
 * @throws {Error} 形状不对时抛 400
 */
function checkTripRef(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw httpError(400, '归属行程不对');
  return v;
}

/**
 * 功能：校验并归一化「一个点」（打卡 / 批量补点共用的那一半）。
 *
 * 说明：⭐ **只校验形状**（是不是数字、是不是有限数、长度对不对）；**上下界**（`at` 的
 *      2000 年下限与「不晚于现在 + 5 分钟」、经纬度范围、`accuracy >= 0`）留在 `store.js` 的
 *      `assertPointRow()` —— 因为 `at` 缺省时会被**补成服务端现在**，那个上界只有补完之后才判得准。
 *      ⇒ 「同一件事只判一处」这条纪律的落点在业务层，这里不重复第二份。
 *      ⚠️ `kind` **不由请求体决定**：打卡接口固定 `checkin`，补点接口固定 `track`
 *      （`pointRow()` 的缺省值）⇒ 请求体里带 `kind` 也没用，本函数**不拷贝它**。
 *      ⚠️ `at` 必须是**整数**（epoch 毫秒）：带上 `'2026-09-30 08:00'` 这种字符串一律 400 ——
 *      静默 `Number()` 会得到 `NaN`，`NaN` 落库后 `JSON.stringify` 变成 `null`，那条点就废了。
 *
 * @param {*} b - 请求体（一个点的对象）
 * @returns {Object} 归一化后的点字段
 * @throws {Error} 任一字段非法时抛 400
 */
function checkPoint(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};

  // 坐标必填：没有坐标的「点」不是点（打卡与补点都如此）
  for (const [k, what, lo, hi] of [
    ['lat', '纬度', -90, 90],
    ['lng', '经度', -180, 180],
  ]) {
    if (!has(k)) throw httpError(400, `${what}是必填的`);
    const v = src[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      throw httpError(400, `${what}要填 ${lo} ~ ${hi} 之间的数字`);
    }
    out[k] = v;
  }

  if (has('at')) {
    const v = src.at;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      throw httpError(400, '时刻要填整数毫秒');
    }
    out.at = v;
  }

  for (const [k, what] of [
    ['accuracy', '精度'],
    ['altitude', '海拔'],
    ['speed', '速度'],
    ['heading', '方向角'],
  ]) {
    if (!has(k)) continue;
    const v = src[k];
    if (v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw httpError(400, `${what}要填数字`);
    out[k] = v;
  }

  if (has('label')) {
    const s = String(src.label == null ? '' : src.label).trim();
    if (s.length > LABEL_MAX) throw httpError(400, `名字不能超过 ${LABEL_MAX} 个字`);
    out.label = s;
  }

  if (has('note')) {
    const s = String(src.note == null ? '' : src.note).trim();
    if (s.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
    out.note = s;
  }

  // ⚠️ 归属只判「形状」（正整数或 null）；「是不是自己的行程」在业务层判 400（方案 §6.2）
  if (has('trip_id')) out.trip_id = checkTripRef(src.trip_id);

  return out;
}

/**
 * 功能：校验并归一化「改一个点」的入参 —— ⭐ 只认三个键（`label` / `note` / `trip_id`）。
 *
 * 说明：⭐⭐ **坐标与测量时刻不可改**（方案 §5.3）：「打卡点的名字写错了」与
 *      「这条轨迹记的不对」是两件事 —— 前者随手可改，后者只能删掉重记。
 *      ⇒ 请求体里带 `lat` / `lng` / `at` 一律 **静默忽略**？⛔ 不，**这里就 400 拒掉**：
 *      静默忽略会让调用方以为改成功了（本项目最贵的那一类错）。
 *      ⚠️ 一个键都没带 ⇒ 400（与 `checkTrip` / `checkTicket` 的 `partial` 口径逐字一致）。
 *
 * @param {*} b - 请求体
 * @returns {Object} 只含请求里真的带了的、可改的那几个键
 * @throws {Error} 带了不可改的键 / 值的形状不对 / 一个键都没带时抛 400
 */
function checkPointPatch(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  for (const k of ['lat', 'lng', 'at', 'kind', 'accuracy', 'altitude', 'speed', 'heading', 'user_id', 'id']) {
    if (has(k)) throw httpError(400, '这个点的坐标和时刻不能改，只能改名字、备注或归属');
  }
  const out = {};
  if (has('label')) {
    const s = String(src.label == null ? '' : src.label).trim();
    if (s.length > LABEL_MAX) throw httpError(400, `名字不能超过 ${LABEL_MAX} 个字`);
    out.label = s;
  }
  if (has('note')) {
    const s = String(src.note == null ? '' : src.note).trim();
    if (s.length > NOTE_MAX) throw httpError(400, `备注不能超过 ${NOTE_MAX} 个字`);
    out.note = s;
  }
  if (has('trip_id')) out.trip_id = checkTripRef(src.trip_id);
  if (!Object.keys(out).length) throw httpError(400, '没有要改的内容');
  return out;
}

/**
 * 功能：解析查询串里的「时刻区间」（`from` / `to`，**epoch 毫秒**）。
 * @param {URLSearchParams} p - 查询参数
 * @param {string} name - 参数名
 * @returns {?number} 毫秒数；没带为 null
 * @throws {Error} 带了但不是数字时抛 400
 */
function checkMsParam(p, name) {
  const raw = p.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw httpError(400, `${name} 要填毫秒数`);
  return Math.round(n);
}

/**
 * 功能：处理 `/api/trip` 及其子路径 —— 一屏、行程、车票、轨迹点与打卡、提醒开关。
 *
 * 说明：路由表（`parts = ['api','trip', …]`）——
 *      · `GET    /api/trip?from=&to=`    一屏（`today` / `prefs` / `upcoming` / `trips` / `tickets`）
 *      · `POST   /api/trip/trips`        新建行程
 *      · `PUT    /api/trip/trips/<id>`   改行程（逐字段）
 *      · `DELETE /api/trip/trips/<id>`   删行程 ⭐ **解绑不级联**
 *      · `POST   /api/trip/tickets`      新建车票（⭐ AI 确认卡走的也是它）
 *      · `PUT    /api/trip/tickets/<id>` 改车票（逐字段）
 *      · `DELETE /api/trip/tickets/<id>` 删车票
 *      · `GET    /api/trip/points?trip_id=&from=&to=` 取点（按 `at` 升序；省略 `trip_id` = 不挂行程的）
 *      · `POST   /api/trip/points`       批量补点（`{trip_id?, points:[…]}`，⭐ 一次 ≤ 200）
 *      · `POST   /api/trip/checkin`      打卡（一个点 ＋ `label`）
 *      · `PUT    /api/trip/points/<id>`  改一个点（只允许 `label` / `note` / `trip_id`）
 *      · `DELETE /api/trip/points/<id>`  删一个点
 *      · `POST   /api/trip/points/clear` 清空（`{trip_id}`）
 *      · `PUT    /api/trip/prefs`        改三档提醒开关（逐键）
 *      · `PUT    /api/trip/life`         改「人生日历」两项设置（逐键，⭐ 0.8.9 从日历模块搬来）
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
function handleTrip({ req, res, parts, url, method, uid }) {
  // ⭐ 整个请求共用同一个「现在」
  const nowMs = Date.now();

  // ---- 两段：一屏 ----
  if (parts.length === 2) {
    if (method === 'GET') {
      const p = (url && url.searchParams) || null;
      const from = p && p.get('from') ? checkDate(p.get('from'), '区间起点') : null;
      const to = p && p.get('to') ? checkDate(p.get('to'), '区间终点') : null;
      if (from && to && to < from) throw httpError(400, '区间的终点不能早于起点');
      return json(res, 200, store.tripState(uid, from, to, nowMs));
    }
    return notFound(res);
  }

  // ---- 三段 / 四段：子资源 ----
  if (parts.length >= 3) {
    const seg = parts[2];

    // ⭐ 三档提醒开关
    if (seg === 'prefs') {
      if (parts.length !== 3 || method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.tripSavePrefs(uid, checkTripPrefs(b), nowMs);
        return json(res, 200, { ok: true, prefs: next });
      });
    }

    // ⭐ 人生日历两项设置（⭐ 0.8.9：从日历模块整体搬来）—— 与 `prefs` 同段、同样必须先于 id 解析判掉
    if (seg === 'life') {
      if (parts.length !== 3 || method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.tripSaveLife(uid, checkTripLife(b), nowMs);
        return json(res, 200, { ok: true, life: next });
      });
    }

    // ⭐ 行程 / 车票：`POST /api/trip/<seg>` 新建；`PUT` / `DELETE /api/trip/<seg>/<id>` 改删
    if (seg === 'trips' || seg === 'tickets') {
      const isTrip = seg === 'trips';
      const check = isTrip ? checkTrip : checkTicket;
      if (parts.length === 3) {
        if (method !== 'POST') return notFound(res);
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const created = isTrip
            ? store.createTrip(uid, check(b, false), nowMs)
            : store.createTripTicket(uid, check(b, false), nowMs);
          return json(res, 201, created);
        });
      }
      if (parts.length === 4) {
        const id = idParam(parts[3]);
        // ⚠️ `idParam` 对非数字段回 **null**（正是我们要的），但对 `null` 入参回 **0**
        //    ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`。
        if (id === null) return notFound(res);
        if (method === 'PUT') {
          return readBody(req, res, (b) => {
            if (!b) throw httpError(400, 'bad body');
            const next = isTrip
              ? store.updateTrip(uid, id, check(b, true), nowMs)
              : store.updateTripTicket(uid, id, check(b, true), nowMs);
            return json(res, 200, next);
          });
        }
        if (method === 'DELETE') {
          if (isTrip) store.deleteTrip(uid, id);
          else store.deleteTripTicket(uid, id);
          return json(res, 200, { ok: true });
        }
      }
      return notFound(res);
    }

    // ---- ⭐ 轨迹点与打卡----
    // ⚠️ 路由解析顺序：`points` / `checkin` 是**固定名段**，天然先于 id 解析被判掉
    //    （`idParam('points')` 回 null，走不到 id 分支）。
    if (seg === 'checkin') {
      if (parts.length !== 3 || method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const p = checkPoint(b);
        const created = store.tripCheckin(uid, 'trip_id' in p ? p.trip_id : null, p, nowMs);
        return json(res, 201, created);
      });
    }

    if (seg === 'points') {
      // 三段的 `points`：取点（GET）与批量补点（POST）
      if (parts.length === 3) {
        if (method === 'GET') {
          const p = (url && url.searchParams) || new URLSearchParams();
          const raw = p.get('trip_id');
          let tripId = null;
          if (raw !== null && raw !== '') {
            const n = Number(raw);
            if (!Number.isInteger(n) || n <= 0) throw httpError(400, '归属行程不对');
            tripId = n;
          }
          // ⚠️ `from` / `to` 是 **epoch 毫秒**（原语层就是按毫秒筛的）
          return json(res, 200, {
            points: store.tripPoints(uid, tripId, checkMsParam(p, 'from'), checkMsParam(p, 'to')),
          });
        }
        if (method === 'POST') {
          return readBody(req, res, (b) => {
            if (!b) throw httpError(400, 'bad body');
            const src = b && typeof b === 'object' ? b : {};
            const list = Array.isArray(src.points) ? src.points : null;
            if (!list) throw httpError(400, 'points 得是一个数组');
            // ⭐ 超限**可见地拒绝**：把上限与实际条数一起回给调用方（方案 §6.2）
            if (list.length > POINT_MAX_BATCH) {
              throw httpError(400, `一次最多补 ${POINT_MAX_BATCH} 个点`, {
                max: POINT_MAX_BATCH,
                got: list.length,
              });
            }
            const pts = list.map((x) => checkPoint(x));
            const t = 'trip_id' in src ? checkTripRef(src.trip_id) : null;
            const saved = store.createTripPoints(uid, t, pts, nowMs);
            return json(res, 201, { ok: true, saved: saved.length, points: saved });
          });
        }
        return notFound(res);
      }
      // 四段的 `points/<id>` 与 `points/clear`
      if (parts.length === 4) {
        if (parts[3] === 'clear') {
          if (method !== 'POST') return notFound(res);
          return readBody(req, res, (b) => {
            const src = b && typeof b === 'object' ? b : {};
            const t = 'trip_id' in src ? checkTripRef(src.trip_id) : null;
            return json(res, 200, { ok: true, removed: store.clearTripPoints(uid, t) });
          });
        }
        const id = idParam(parts[3]);
        // ⚠️ `idParam` 对非数字段回 **null**，但对 `null` 入参回 **0** ⇒ 判「解析失败」必须写 `=== null`
        if (id === null) return notFound(res);
        if (method === 'PUT') {
          return readBody(req, res, (b) => {
            if (!b) throw httpError(400, 'bad body');
            return json(res, 200, store.updateTripPoint(uid, id, checkPointPatch(b)));
          });
        }
        if (method === 'DELETE') {
          store.deleteTripPoint(uid, id);
          return json(res, 200, { ok: true });
        }
        return notFound(res);
      }
      return notFound(res);
    }

    return notFound(res);
  }

  return notFound(res);
}

module.exports = { trip: handleTrip };
