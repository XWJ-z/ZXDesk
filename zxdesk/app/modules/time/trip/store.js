'use strict';
/**
 * modules/trip/store.js —— 行程业务方法（0.8.6）
 *
 * 功能：本模块的业务方法 —— `tripState`（一屏所需的全部：服务端「今天」＋ 三档开关 ＋
 *      下一张待出发的票 ＋ 行程列表（每条带票数与点数）＋ 区间车票）、行程 CRUD、车票 CRUD、
 *      三档提醒开关。轨迹点与打卡随、提醒候选与 AI 读方法随/。
 *
 * ⚠️ **方法名一律带 `trip` 前缀，绝不用 `list` / `get` / `state` 这种通用名**：
 *    `store/index.js` 把全部业务模块平铺到**同一个原型**上 —— 两个模块各写一个 `list()`，
 *    后来者会**静默覆盖**前者（0.5.0 起另有装配期护栏 `assertNoMethodClash()` 兜住，撞名即抛）。
 *    （`listTrips` / `getTrip` / `deleteTrip` 与同名 op 重名是**惯例**：业务方法住原型、
 *    原语住 `_bk`，两个对象互不干扰。）
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走 `this._bk.<op>(...)`。
 *
 * ⭐⭐ **车票的「当地时刻字符串」口径**（方案 §三）：`depart_at` / `arrive_at` 是
 *    `YYYY-MM-DD HH:MM`（**定长两位**，字典序即时间序）—— ⛔ 不存 epoch、⛔ 不转 `Date` 比较。
 *    越是「减 3 天 / 加 3 天」这种算术，越要交给 `lib/depart.js`（唯一那份实现）。
 *
 * ⭐ **「现在」由调用方传进来**（`nowMs`，epoch 毫秒）：路由层取一次 `Date.now()` 传下来 ——
 *    本文件**不读 `Date.now()`**，测试才能喂假时间，而且一个请求内的「今天」「倒计时」共享同一个现在。
 *
 * ⚠️⚠️ **跨列校验判的是「改完之后整行长什么样」**（照 `calendar/store.js` 的 `assertEventRow`）：
 *    `kind` 枚举 / `depart_at` 与 `arrive_at` 的格式 / `lat` `lng` 范围 —— 一律 **400**，
 *    ⛔ 不静默清空、⛔ 不静默截断。`PUT` 只带一个键时，坏数据是**合并之后**才产生的。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.33
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

const { badRequest, notFoundErr } = require('../../../core/store/helpers.js');
const { addMinutesKey, TRIP_STAGES, tripFireAt, tripReminderBody } = require('./lib/depart.js');

/**
 * 三档提醒开关的**缺省值** —— ⭐ 全项目**唯一一处**。
 *
 * 说明：⚠️ 两个后端与建表语句都**不兜默认值**（`getTripPrefs()` 取不到就回 null）：
 *      默认值分散在多处时，表现是「换了后端行为就变了」，而且查起来毫无线索
 *      （与 `PREF_DEFAULT` / `REMINDER_PREFS_DEFAULT` 同一条理由）。
 *      ⭐ 三档都默认**开**：提醒是这一期的卖点，默认关掉等于把这个功能藏起来。
 * @type {Object.<string, number>}
 */
const TRIP_PREF_DEFAULT = { remind_d3: 1, remind_d1: 1, remind_h3: 1 };

/**
 * 三档开关里**允许被写**的键 —— 与 `upsertTripPrefs` 的几个列一一对应（多一个都没有去处）。
 *
 * 说明：⚠️ 请求体里多出来的键一律丢弃，⛔ 绝不让它顺着 `Object.assign` 流到别的列上。
 *      ⚠️ 与两个后端里那份 `PREF_KEYS` **必须逐字一致**（原语层不许 require 业务层常量，故各留一份）。
 * @type {Array.<string>}
 */
const PREF_KEYS = ['remind_d3', 'remind_d1', 'remind_h3'];

/**
 * 「人生日历」两项设置允许写入的键 —— ⭐ 0.8.9：从日历模块**整体搬来**。
 * ⚠️ 与两个后端里那份 `LIFE_KEYS` **必须逐字一致**；与上面的 `PREF_KEYS` **刻意分成两份**
 *（合并一份的下场是「改提醒开关时把出生日期写成 `undefined`」= 静默清空，先例见 calendar 那三份）。
 */
const LIFE_KEYS = ['birth_date', 'expect_years'];

/**
 * 功能：把 `time_trip_prefs` 那一行里的「人生日历」两项归一化 —— 空串 / 缺列 / null 一律当「没设」。
 *
 * 说明：⚠️ 与日历模块 `calendarLife()` 的归一化逐字同义（搬过来时一起搬的）：
 *      `expect_years` 过一遍 `Number` 是**必需的** —— 老库 / 手改过的 JSON 里它可能是字符串，
 *      前端拿 `'80'` 去乘 52 会**静默得到 NaN**（界面上就是一片空白，不报错）。
 *
 * @param {Object} row - `time_trip_prefs` 的一行（可能缺列）
 * @returns {{birth_date: ?string, expect_years: ?number}} 两项设置（没设就是 null）
 */
function lifeOfRow(row) {
  const bd = row.birth_date;
  const ey = row.expect_years;
  return {
    birth_date: bd === undefined || bd === null || String(bd).trim() === '' ? null : String(bd),
    expect_years: ey === undefined || ey === null || String(ey).trim() === '' ? null : Number(ey),
  };
}

/** 车票六型 —— ⚠️ 与 `schema.js` 的 `CHECK (kind IN (…))`、两个后端的列清单**逐字一致**。 */
const TICKET_KINDS = ['train', 'highspeed', 'flight', 'bus', 'ship', 'other'];

/** 改一条行程时**允许改**的八个键（`id` / `user_id` / 审计列一个都不在其中）。 */
const TRIP_EDIT_COLS = ['title', 'vehicle', 'from_place', 'to_place', 'start_date', 'start_time', 'end_date', 'end_time', 'note'];

/** 改一张车票时**允许改**的键 —— ⚠️ 与两个后端的 `TICKET_COLS` 逐字一致。 */
const TICKET_EDIT_COLS = [
  'trip_id',
  'kind',
  'code',
  'from_station',
  'to_station',
  'depart_at',
  'arrive_at',
  'seat',
  'gate',
  'terminal',
  'price_fen',
  'order_no',
  'note',
];

/** 完整时刻串（定长两位）与纯日期串 —— ⛔ 宽松解析是「静默算错提醒时刻」的入口。 */
const KEY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 票价上限（整数分）= 一百万元 —— 与 `routes.js` 那一份同值。 */
const PRICE_MAX_FEN = 100000000;

/** 备注长度上限 —— ⚠️ 与 `core/validate.js` 的 `MAX_TT_REMARK`、`routes.js` 的 `NOTE_MAX` 同值。 */
const NOTE_MAX = 500;

/** 轨迹点 / 打卡点的两种类型 —— ⚠️ 与 `schema.js` 的 `CHECK (kind IN (…))` 逐字一致。 */
const POINT_KINDS = ['track', 'checkin'];

/** ⭐ 一次最多补多少个点（方案 §6.2：超限**可见地拒绝**，⛔ 不静默截断）。 */
const POINT_MAX_BATCH = 200;

/** 点的测量时刻下限（2000-01-01 UTC）—— 比这还早的 `at` 一定是设备时钟坏了。 */
const AT_FLOOR_MS = Date.UTC(2000, 0, 1);

/**
 * ⭐ 允许的「未来量」：`at` 最多能比服务端现在晚 5 分钟（方案 §6.2）。
 *
 * 说明：⚠️ 完全不判「不能是未来」会放过一台时钟差了几个小时的设备 —— 那台设备采的点
 *      会**排到轨迹最前面**，里程与时长当场算错，而且**没有任何迹象**。
 *      给 5 分钟是给设备间的正常时钟漂移留余量（NTP 之外的机器差几秒很常见）。
 */
const AT_FUTURE_MS = 5 * 60 * 1000;

/** 打卡点名字的长度上限 —— ⚠️ 方案 §6.2 没写 label 的上限，按「站名 / 地名」的量级取 60（记附录 D）。 */
const LABEL_MAX = 60;

/**
 * 功能：`YYYY-MM-DD` 是不是**真实存在**的一天（回环校验）。
 *
 * 说明：⚠️ 只比字符串不够：`2026-02-30` 也过正则，落库后字典序照样可比，
 *      但**永远匹配不到任何一天** ⇒ 表现是「保存成功了，却找不到它」，而且不报错。
 *
 * @param {string} s - 待校验的日期串
 * @returns {boolean} 真实存在为 true
 */
function realDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (
    d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
  );
}

/**
 * 功能：`YYYY-MM-DD HH:MM` 是不是**真实存在**的一刻（回环校验）。
 * @param {string} s - 待校验的时刻串
 * @returns {boolean} 真实存在为 true
 */
function realKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  if (Number(m[4]) > 23 || Number(m[5]) > 59) return false;
  return realDate(`${m[1]}-${m[2]}-${m[3]}`);
}

/**
 * 功能：把 epoch 毫秒转成**本地时区**的日期 `YYYY-MM-DD`。
 * @param {number} ms - epoch 毫秒
 * @returns {string} 本地日期串
 */
function dateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：把 epoch 毫秒转成**本地时区**的 `YYYY-MM-DD HH:MM`（与票的时刻同口径）。
 * @param {number} ms - epoch 毫秒
 * @returns {string} 本地时刻串
 */
function keyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${dateOf(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 功能：把一条行程整理成界面要的形状（同一份字段名，两端共用）。
 *
 * 说明：⚠️ 空值一律给**稳定的空形状**（`''` 而不是 `null` / `undefined`）：
 *      两端渲染都直接读这些字段，缺键会让 `undefined` 混进 DOM 与比较里。
 *      ⚠️ **刻意不落「状态（计划中 / 进行中 / 已结束）」**（方案 §4.4）：它是派生的，
 *      由两端自己用 `start_date` / `end_date` 与「今天」算。
 *
 * @param {Object} r - 库里的行
 * @returns {Object} 界面用的对象
 */
function shapeTrip(r) {
  return {
    id: Number(r.id),
    title: String(r.title || ''),
    // ⭐ 0.8.6：交通工具 / 起点 / 终点 / 起始时刻 —— 四个都**可空**，
    //    ⇒ 一律给稳定的空串（⛔ 不是 null，两端渲染直接读这些字段）。
    vehicle: r.vehicle == null ? '' : String(r.vehicle),
    from_place: r.from_place == null ? '' : String(r.from_place),
    to_place: r.to_place == null ? '' : String(r.to_place),
    start_date: String(r.start_date || ''),
    start_time: r.start_time == null ? '' : String(r.start_time),
    end_date: r.end_date == null ? '' : String(r.end_date),
    end_time: r.end_time == null ? '' : String(r.end_time),
    note: r.note == null ? '' : String(r.note),
  };
}

/**
 * 功能：把一张车票整理成界面要的形状。
 *
 * 说明：⚠️ `price_fen` 空时给 **`null`**（不是 0）：「没填票价」与「票价 0 元」是两件事，
 *      把它们合成 0 会让界面显示一个凭空捏造的「¥0.00」。
 *      ⚠️ `trip_id` 空时给 `null`（= 不归属任何行程， 的**正常状态**）。
 *
 * @param {Object} r - 库里的行
 * @returns {Object} 界面用的对象
 */
function shapeTicket(r) {
  return {
    id: Number(r.id),
    trip_id: r.trip_id == null || r.trip_id === '' ? null : Number(r.trip_id),
    kind: String(r.kind || 'other'),
    code: r.code == null ? '' : String(r.code),
    from_station: r.from_station == null ? '' : String(r.from_station),
    to_station: r.to_station == null ? '' : String(r.to_station),
    depart_at: String(r.depart_at || ''),
    arrive_at: r.arrive_at == null ? '' : String(r.arrive_at),
    seat: r.seat == null ? '' : String(r.seat),
    gate: r.gate == null ? '' : String(r.gate),
    terminal: r.terminal == null ? '' : String(r.terminal),
    price_fen: r.price_fen == null || r.price_fen === '' ? null : Number(r.price_fen),
    order_no: r.order_no == null ? '' : String(r.order_no),
    note: r.note == null ? '' : String(r.note),
  };
}

/**
 * 功能：校验**合并之后**的一行行程（方案 §6.2 的三条硬约束）。
 * @param {Object} row - 合并之后的行程行（界面形状）
 * @returns {void}
 * @throws {Error} 违反任一条时抛 400
 */
function assertTripRow(row) {
  const title = String(row.title || '').trim();
  if (!title) throw badRequest('行程得有个名字');
  // ⭐ 0.8.6：交通工具的值域 = 票型那一套（`TICKET_KINDS`）—— ⛔ 别在别处再内联一份 `===` 判断。
  //    ⚠️ 接口层（`routes.js` 的 `checkTrip`）已经拦过一道；这里**再判一次**是照 `assertTicketRow`
  //    的既有做法（两层都判）：Store 是别的模块能直接调的入口，硬边界不该只挂在路由上。
  const vehicle = String(row.vehicle || '');
  if (vehicle && !TICKET_KINDS.includes(vehicle)) throw badRequest('交通工具不对');
  if (!DATE_RE.test(String(row.start_date || '')) || !realDate(row.start_date)) {
    throw badRequest('开始日期要写成 2026-09-30 这样的日期，而且要真实存在');
  }
  // ⭐ 起始**时刻**可空；给了就必须是 `HH:MM`（⚠️ 与 `routes.js` 的 `checkClock` 同一条口径）
  //    ⚠️⭐ 0.8.13：这里**刻意不要求非空**（「新建必填」只落在 `createTrip()` 那条路上）——
  //    无条件要求非空会让老行（`start_time` 是 NULL）「改个标题就 400」。
  const st = String(row.start_time || '');
  if (st) {
    const m = /^(\d{2}):(\d{2})$/.exec(st);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw badRequest('起始时刻要写成 08:30 这样');
  }
  // ⭐⭐ 0.8.13：结束**时刻**（可空）—— 首页按它算那一段的长度
  const et = String(row.end_time || '');
  if (et) {
    const m = /^(\d{2}):(\d{2})$/.exec(et);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw badRequest('结束时刻要写成 18:30 这样');
    if (!st) throw badRequest('填了结束时刻就得有起始时刻');
    // ⚠️ 只在**同一天**里比先后：跨天时结束时刻天然可能早于起始时刻（23:40 出发、次日 01:20 到）
    const sameDay = !String(row.end_date || '').trim() || String(row.end_date) === String(row.start_date);
    if (sameDay && et < st) throw badRequest('结束时刻不能早于起始时刻');
  }
  const end = String(row.end_date || '');
  if (end) {
    if (!DATE_RE.test(end) || !realDate(end)) throw badRequest('结束日期不是一个真实存在的日期');
    if (end < String(row.start_date)) throw badRequest('结束日期不能早于开始日期');
  }
}

/**
 * 功能：校验**合并之后**的一行车票（方案 §6.2 的跨列硬约束）。
 *
 * 说明：⭐ 判的是「改完之后整行长什么样」，不是请求体 —— `PUT` 只带 `kind` 时，
 *      坏数据是**合并之后**才产生的。
 *      ⚠️⭐ **刻意不判「到达必须晚于出发」**：红眼航班与跨零点的车都是**正常情形**
 *      （方案 §4.2 明令 ⛔ 不加那条跨列约束）。
 *
 * @param {Object} row - 合并之后的车票行（界面形状）
 * @returns {void}
 * @throws {Error} 违反任一条时抛 400
 */
function assertTicketRow(row) {
  if (!TICKET_KINDS.includes(String(row.kind || ''))) throw badRequest('票型不对');
  if (!String(row.from_station || '').trim()) throw badRequest('出发站不能为空');
  if (!String(row.to_station || '').trim()) throw badRequest('到达站不能为空');
  if (!KEY_RE.test(String(row.depart_at || '')) || !realKey(row.depart_at)) {
    throw badRequest('出发时刻要写成 2026-09-30 08:00 这样，而且要真实存在');
  }
  const arrive = String(row.arrive_at || '');
  if (arrive && (!KEY_RE.test(arrive) || !realKey(arrive))) {
    throw badRequest('到达时刻要写成 2026-09-30 12:28 这样，而且要真实存在');
  }
  const p = row.price_fen;
  if (p !== null && p !== undefined && p !== '') {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > PRICE_MAX_FEN) throw badRequest('票价要填 0 ~ 1000000 之间的数字（元）');
  }
}

/**
 * 功能：把 `YYYY-MM-DD` 加减 N 天。
 * @param {string} s - 起点日期
 * @param {number} n - 天数（可负）
 * @returns {string} 结果日期；读不出来时原样返回
 */
function shiftDate(s, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
  if (!m) return String(s || '');
  return dateOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(n)).getTime());
}

/**
 * 功能：把**可空的数字列**归一化 —— 空串 / null 一律给 `null`（⛔ 不给 0）。
 *
 * 说明：⚠️⭐ **不在这里做类型校验**：`Number('abc')` 是 `NaN`，而 `NaN` 落进库之后
 *      既不等于任何数、`JSON.stringify` 还会把它变成 `null` —— 那就成了「存进去了一列空值」
 *      且**没有人报错**。校验由 `assertPointRow()` 负责（`Number.isFinite` 会拦下 NaN）。
 *
 * @param {*} v - 原始值
 * @returns {?number} 数字或 null
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  return Number(v);
}

/**
 * 功能：把一条轨迹点 / 打卡点整理成界面要的形状（同一份字段名，两端共用）。
 *
 * 说明：⚠️ 空值一律给**稳定的空形状**（`''` 而不是 `undefined`）—— 两端直接读这些字段渲染。
 *      ⚠️ `accuracy` / `altitude` / `speed` / `heading` 空时给 **`null`**（不是 0）：
 *      「手填的点没有精度」与「精度 0 米」是两件事（同 `price_fen` 的口径）。
 *
 * @param {Object} r - 库里的行
 * @returns {Object} 界面用的对象
 */
function shapePoint(r) {
  return {
    id: Number(r.id),
    trip_id: r.trip_id == null || r.trip_id === '' ? null : Number(r.trip_id),
    kind: String(r.kind || 'track'),
    at: Number(r.at),
    lat: Number(r.lat),
    lng: Number(r.lng),
    accuracy: r.accuracy == null || r.accuracy === '' ? null : Number(r.accuracy),
    altitude: r.altitude == null || r.altitude === '' ? null : Number(r.altitude),
    speed: r.speed == null || r.speed === '' ? null : Number(r.speed),
    heading: r.heading == null || r.heading === '' ? null : Number(r.heading),
    label: r.label == null ? '' : String(r.label),
    note: r.note == null ? '' : String(r.note),
  };
}

/**
 * 功能：校验一个点的所有字段（方案 §6.2 的「点」那几行）—— 不满足一律抛 400。
 *
 * 说明：⭐ 判的是**准备落库的那一行**（不是请求体）：`at` 缺省时会被补成服务端现在，
 *      所以 `at` 的上下界要**在补完之后**判。
 *      ⚠️ `at` 未来量那条是**安全边界**：设备时钟差了 3 小时的话，那批点会排到轨迹最前面，
 *      里程与时长当场算错、而且没有任何迹象（见 `AT_FUTURE_MS` 的说明）。
 *
 * @param {Object} row - 准备落库的点行
 * @param {number} nowMs - 服务端现在（epoch 毫秒）
 * @returns {void}
 * @throws {Error} 违反任一条时抛 400
 */
function assertPointRow(row, nowMs) {
  if (!POINT_KINDS.includes(String(row.kind || ''))) throw badRequest('点的类型不对');
  if (!Number.isInteger(row.at)) throw badRequest('这个点的时刻不对');
  if (row.at < AT_FLOOR_MS) throw badRequest('这个点的时刻比 2000 年还早，先看看设备的时钟');
  if (row.at > nowMs + AT_FUTURE_MS) throw badRequest('这个点的时刻比现在还晚，先校准一下设备时间');
  if (!Number.isFinite(row.lat) || row.lat < -90 || row.lat > 90) throw badRequest('纬度要填 -90 ~ 90 之间的数字');
  if (!Number.isFinite(row.lng) || row.lng < -180 || row.lng > 180) {
    throw badRequest('经度要填 -180 ~ 180 之间的数字');
  }
  for (const [k, what] of [
    ['accuracy', '精度'],
    ['altitude', '海拔'],
    ['speed', '速度'],
    ['heading', '方向角'],
  ]) {
    const v = row[k];
    if (v === null) continue;
    if (!Number.isFinite(v)) throw badRequest(`${what}要是一个数字`);
  }
  if (row.accuracy !== null && row.accuracy < 0) throw badRequest('精度不能是负数');
}

/**
 * 功能：把「归属行程」归一化成行程 id 或 `null`，并确认它**是自己的行程**。
 *
 * 说明：⚠️ 方案 §6.2 明写：`trip_id` 不是自己的行程 ⇒ **400**（不是 404 —— 它是个**入参**，
 *      不是被访问的资源）。`null` / 空串是**合法值**（= 不归属任何行程， 的正常状态）。
 *
 * @param {Object} store - Store 实例（取 `_bk.getTrip` 判权）
 * @param {number} uid - 账号 id
 * @param {*} tripId - 原始入参
 * @returns {?number} 行程 id 或 null
 * @throws {Error} 形状不对 / 不是自己的行程时抛 400
 */
function resolveTripId(store, uid, tripId) {
  if (tripId === null || tripId === undefined || tripId === '') return null;
  const n = Number(tripId);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('归属行程不对');
  if (!store._bk.getTrip(Number(uid), n)) throw badRequest('这个行程不在了');
  return n;
}

/**
 * 功能：把一条入参点归一化成**准备落库的行**（含 `user_id` / `trip_id` / `created_at`）。
 *
 * 说明：⭐ `created_at` 是**服务端收下那一刻**（审计），与 `at`（设备给的测量时刻）**分两列**——
 *      轨迹是批量补传的，把「服务端收到」当成「测量时刻」会把一路上采的点全压成同一时刻
 *      （方案 §三）。
 *      ⚠️ `at` 没带时用服务端现在（打卡走「此刻」是合理的；补传的点一定带 `at`）。
 *
 * @param {number} uid - 账号 id
 * @param {?(number|string)} tripId - 归属行程 id 或 null
 * @param {Object} p - 原始点
 * @param {number} stamp - 服务端现在（epoch 毫秒）
 * @param {number} nowMs - 服务端现在（校验 `at` 上界用，与 `stamp` 同值）
 * @returns {Object} 准备插入的行
 * @throws {Error} 字段非法时抛 400
 */
function pointRow(uid, tripId, p, stamp, nowMs) {
  const src = p && typeof p === 'object' ? p : {};
  const row = {
    user_id: Number(uid),
    trip_id: tripId == null ? null : Number(tripId),
    kind: String(src.kind || 'track'),
    at: src.at == null || src.at === '' ? stamp : Math.round(Number(src.at)),
    lat: Number(src.lat),
    lng: Number(src.lng),
    accuracy: numOrNull(src.accuracy),
    altitude: numOrNull(src.altitude),
    speed: numOrNull(src.speed),
    heading: numOrNull(src.heading),
    label: src.label == null || src.label === '' ? null : String(src.label).trim(),
    note: src.note == null || src.note === '' ? null : String(src.note).trim(),
    created_at: stamp,
  };
  if (row.label && row.label.length > LABEL_MAX) throw badRequest(`名字不能超过 ${LABEL_MAX} 个字`);
  assertPointRow(row, nowMs);
  return row;
}

module.exports = {
  // ---- 三档提醒开关 ----
  /**
   * 功能：读本账号的三档出发提醒开关 —— ⭐ **缺省值在这里合并**（表里没有行时也给一份可用的）。
   *
   * 说明：⭐ 这是「默认值只有一处」的落点（`TRIP_PREF_DEFAULT`）：两个后端都不兜默认值，
   *      所以「这台机器还从没改过开关」与「改了、但改成了默认值」对外表现完全一样。
   *      ⚠️ 库里的值可能是字符串（老库 / 手改过的 JSON）—— 统一压成 0/1，
   *      否则前端 `remind_d3 === 1` 这种判据会在 `'1'` 上静默比错。
   *
   * @param {number} uid - 账号 id
   * @returns {Object} `{ remind_d3, remind_d1, remind_h3 }`（都是 0 / 1）
   */
  tripPrefs(uid) {
    const row = this._bk.getTripPrefs(Number(uid)) || {};
    const out = {};
    for (const k of PREF_KEYS) {
      const v = row[k];
      out[k] = v === undefined || v === null || v === '' ? TRIP_PREF_DEFAULT[k] : Number(v) ? 1 : 0;
    }
    return out;
  },

  /**
   * 功能：改本账号的三档出发提醒开关 —— ⭐ **带哪个键写哪个键**。
   * @param {number} uid - 账号 id
   * @param {Object} patch - 只含要改的那几个键（已由路由层校验成 0/1）
   * @param {number} nowMs - 现在（epoch 毫秒，当 `updated_at` 用）
   * @returns {Object} 写入后的完整开关
   * @throws {Error} 数据层只读时抛 503（由 HTTP 层收口）
   */
  tripSavePrefs(uid, patch, nowMs) {
    this._assertWritable();
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.tripPrefs(uid);
    for (const k of PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    this._bk.upsertTripPrefs(Number(uid), next, Math.round(Number(nowMs)));
    return this.tripPrefs(uid);
  },

  // ---- 人生日历（⭐ 0.8.9：「整体从日历模块搬进行程」）----
  /**
   * 功能：取本账号的「人生日历」两项设置（出生日期 / 预期寿命）。
   *
   * 说明：⭐ 0.8.9：这两项**原住日历模块**（`calendar_prefs.birth_date` / `expect_years`，0.7.8 起），
   *      本版整体搬进行程 ⇒ 现在读的是 `time_trip_prefs` 的两列（与提醒开关同一行，一人一行）。
   *      ⚠️ **搬迁是懒的、且不改写旧数据**：新表两列都还空着时，就**只读地**回退
   *      去问日历模块要一次旧值（走它的公开方法 `calendarLife()`，⛔ 不直连它的表）。
   *      「真正搬过去」发生在**第一次在行程里保存**（`tripSaveLife()` 写新表 ＋ 清日历那两列）。
   *      ⇒ 从没改过设置的人照样看得到自己的生日；改过一次之后，数据就只在行程这边了。
   *      ⚠️ 日历模块被整个删掉时 `calendarLife` 根本不存在 ⇒ 自然回退成「没设过」（空态），
   *      不抛错（与「模块被删 ⇒ 界面照常」的既有口径一致）。
   *
   * @param {number} uid - 账号 id
   * @returns {{birth_date: ?string, expect_years: ?number}} 两项设置（没设就是 null）
   */
  tripLife(uid) {
    const row = this._bk.getTripPrefs(Number(uid)) || {};
    const mine = lifeOfRow(row);
    if (mine.birth_date !== null || mine.expect_years !== null) return mine;
    if (typeof this.calendarLife === 'function') {
      const old = this.calendarLife(Number(uid));
      if (old && (old.birth_date !== null || old.expect_years !== null)) return old;
    }
    return mine;
  },

  /**
   * 功能：改本账号的「人生日历」两项设置 —— ⭐ **带哪个键写哪个键**。
   *
   * 说明：⚠️ 与 `tripSavePrefs()` 同构（先读合并、再整份写回）—— 合并的**基准是 `tripLife()`**，
   *      也就是**含上面那次回退**的当前值，于是「只改出生日期」不会把预期寿命写成空。
   *      ⭐ 写新表之后**顺手把日历那边那两列清空** —— 这一步才是「搬」。
   *      ⛔ 顺序不能反：先写新表、成功了再清旧列；反过来的话中途出错就是两边都空 = 真丢数据。
   *      它是**幂等**的：旧列已经是空时不再动手。
   *      ⚠️ 清空走日历模块的公开方法 `calendarSaveLife()`（⛔ 不直连它的表）；模块不在时跳过。
   *
   * @param {number} uid - 账号 id
   * @param {Object} patch - 只含要改的那几个键（已由路由层校验格式；值可为 `null` = 清空）
   * @param {number} nowMs - 现在（epoch 毫秒，当 `updated_at` 用）
   * @returns {{birth_date: ?string, expect_years: ?number}} 写入后的两项设置
   * @throws {Error} 数据层只读时抛 503（由 HTTP 层收口）
   */
  tripSaveLife(uid, patch, nowMs) {
    this._assertWritable();
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.tripLife(uid);
    for (const k of LIFE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    const stamp = Math.round(Number(nowMs));
    this._bk.upsertTripLife(Number(uid), next, stamp);
    // ⭐ 搬家收尾（幂等）：日历那边还留着旧值就清掉 —— ⛔ 必须在新表写成功之后。
    if (typeof this.calendarSaveLife === 'function' && typeof this.calendarLife === 'function') {
      const old = this.calendarLife(Number(uid));
      if (old && (old.birth_date !== null || old.expect_years !== null)) {
        this.calendarSaveLife(Number(uid), { birth_date: null, expect_years: null }, stamp);
      }
    }
    return this.tripLife(uid);
  },

  // ---- 行程 ----
  /**
   * 功能：列出本账号在 `[from, to]` 区间里的行程（**跨天行程两端都算命中**）。
   * @param {number} uid - 账号 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 界面形状的行程数组
   */
  listTrips(uid, from, to) {
    return this._bk.listTrips(Number(uid), String(from), String(to)).map(shapeTrip);
  },

  /**
   * 功能：按 id 取一条行程（界面形状）；不存在 / 不属于本人返回 null。
   * @param {number} uid - 账号 id
   * @param {number} id - 行程 id
   * @returns {?Object} 界面形状的行程；未命中为 null
   */
  getTrip(uid, id) {
    const row = this._bk.getTrip(Number(uid), Number(id));
    return row ? shapeTrip(row) : null;
  },

  /**
   * 功能：新建一条行程。
   * @param {number} uid - 账号 id
   * @param {Object} input - 已归一化：`{title, vehicle, from_place, to_place, start_date,
   *      start_time, end_date, note}`
   * @param {number} nowMs - 现在（epoch 毫秒，当两个审计列）
   * @returns {Object} 新建的行（界面形状）
   * @throws {Error} 违反约束时抛 400；数据层只读时抛 503
   */
  createTrip(uid, input, nowMs) {
    this._assertWritable();
    const src = input && typeof input === 'object' ? input : {};
    const row = {
      user_id: Number(uid),
      title: src.title,
      vehicle: src.vehicle || null,
      from_place: src.from_place || null,
      to_place: src.to_place || null,
      start_date: src.start_date,
      start_time: src.start_time || null,
      end_date: src.end_date || null,
      end_time: src.end_time || null,
      note: src.note || null,
      created_at: Math.round(Number(nowMs)),
      updated_at: Math.round(Number(nowMs)),
    };
    // ⭐⭐ 0.8.13：起始时刻**新建必填** —— 首页「日程表」要按
    //    `start_time` ~ `end_time` 画那一段的**长度**，缺了它那一段就画不出来。
    //    ⚠️⭐ 判据刻意只落在**新建**这一条路上：老行（0.8.6 之前建的）`start_time` 是 NULL，
    //    若在 `checkTripRow()` 里无条件要求非空，**老行程改个标题就会 400**（真踩过的同类）。
    //    ⚠️ 两层都判（与 `assertTripRow` 同款）：Store 也是别的模块能直接调的入口。
    if (!String(row.start_time || '').trim()) throw badRequest('请给这条行程一个起始时刻（格式 08:30）');
    assertTripRow(shapeTrip(row));
    return shapeTrip(this._insert('time_trips', row));
  },

  /**
   * 功能：改一条行程 —— ⭐ **逐字段**：请求带哪个键改哪个键，没带的保持原样。
   *
   * 说明：⭐ 做法是「**先取现状 → 把 patch 合上去 → 校验合并结果 → 整行写回**」。
   *      ⚠️ 取不到就是 **404**（越权与不存在逐字一致 ——）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 行程 id
   * @param {Object} patch - 只含要改的那几个键
   * @param {number} nowMs - 现在（epoch 毫秒，当 `updated_at`）
   * @returns {Object} 改完之后的行（界面形状）
   * @throws {Error} 不存在 / 不属于本人时抛 404；违反约束时抛 400
   */
  updateTrip(uid, id, patch, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getTrip(me, Number(id));
    if (!cur) throw notFoundErr('行程');
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = shapeTrip(cur);
    for (const k of TRIP_EDIT_COLS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k] == null ? '' : String(src[k]);
    }
    // ⭐⭐ 0.8.13：起始时刻**不许被清空** —— 它的语义是「必填」，
    //    而空串在这套口径里正是「清掉」。
    //    ⚠️⭐ 判据是「**从有值改成空**」，⛔ 不是「合并之后为空」：老行（0.8.6 之前建的）
    //    `start_time` 本来就是 NULL，无条件拦会让**老行程改个标题就 400**（这一条真踩过）。
    if (String(cur.start_time || '') && !String(next.start_time || '')) {
      throw badRequest('起始时刻不能清空（日程表要按它排那一段）');
    }
    assertTripRow(next);
    this._bk.setTrip(
      me,
      Number(id),
      {
        title: next.title,
        vehicle: next.vehicle || null,
        from_place: next.from_place || null,
        to_place: next.to_place || null,
        start_date: next.start_date,
        start_time: next.start_time || null,
        end_date: next.end_date || null,
        end_time: next.end_time || null,
        note: next.note || null,
      },
      Math.round(Number(nowMs)),
    );
    return this.getTrip(me, id);
  },

  /**
   * 功能：删一条行程 —— ⭐ **解绑不级联删**。
   *
   * 说明：⭐⭐ 「解绑 → 删」由**原语的 `deleteTrip`** 在**一个事务**里做完（方案 §5.5）：
   *      挂在它名下的车票与轨迹点 `trip_id` 置空、行程那一行删掉 —— ⛔ 不许出现半截状态。
   *      ⚠️ 先取一次再删：取不到就 404（越权与不存在逐字一致）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 行程 id
   * @returns {boolean} 删成功为 true
   * @throws {Error} 不存在 / 不属于本人时抛 404；数据层只读时抛 503
   */
  deleteTrip(uid, id) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getTrip(me, Number(id));
    if (!cur) throw notFoundErr('行程');
    return this._bk.deleteTrip(me, Number(id));
  },

  // ---- 车票 ----
  /**
   * 功能：列出本账号在 `[from, to]` 区间里的车票（**跨天票两端都算命中**）。
   * @param {number} uid - 账号 id
   * @param {string} from - 区间起点 `YYYY-MM-DD`
   * @param {string} to - 区间终点 `YYYY-MM-DD`
   * @returns {Array.<Object>} 界面形状的车票数组（按出发时刻升序）
   */
  listTripTickets(uid, from, to) {
    return this._bk.listTripTickets(Number(uid), String(from), String(to)).map(shapeTicket);
  },

  /**
   * 功能：按 id 取一张车票（界面形状）；不存在 / 不属于本人返回 null。
   * @param {number} uid - 账号 id
   * @param {number} id - 车票 id
   * @returns {?Object} 界面形状的车票；未命中为 null
   */
  getTripTicket(uid, id) {
    const row = this._bk.getTripTicket(Number(uid), Number(id));
    return row ? shapeTicket(row) : null;
  },

  /**
   * 功能：新建一张车票。
   *
   * 说明：⚠️ `trip_id` 带值时**必须是自己的行程** ⇒ 否则 **400**（不是 404 ——
   *      它是个**入参**，不是被访问的资源；方案 §6.2 明写这一条）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - 已归一化的车票字段
   * @param {number} nowMs - 现在（epoch 毫秒，当两个审计列）
   * @returns {Object} 新建的行（界面形状）
   * @throws {Error} 违反约束 / `trip_id` 不是自己的行程时抛 400；数据层只读时抛 503
   */
  createTripTicket(uid, input, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const src = input && typeof input === 'object' ? input : {};
    const tripId = src.trip_id == null || src.trip_id === '' ? null : Number(src.trip_id);
    if (tripId !== null && !this._bk.getTrip(me, tripId)) throw badRequest('这个行程不在了');
    const row = {
      user_id: me,
      trip_id: tripId,
      kind: src.kind,
      code: src.code || null,
      from_station: src.from_station,
      to_station: src.to_station,
      depart_at: src.depart_at,
      arrive_at: src.arrive_at || null,
      seat: src.seat || null,
      gate: src.gate || null,
      terminal: src.terminal || null,
      price_fen: src.price_fen == null || src.price_fen === '' ? null : Math.round(Number(src.price_fen)),
      order_no: src.order_no || null,
      note: src.note || null,
      created_at: Math.round(Number(nowMs)),
      updated_at: Math.round(Number(nowMs)),
    };
    assertTicketRow(shapeTicket(row));
    return shapeTicket(this._insert('time_trip_tickets', row));
  },

  /**
   * 功能：改一张车票 —— ⭐ **逐字段**，跨列校验判**合并之后**的那一行。
   * @param {number} uid - 账号 id
   * @param {number} id - 车票 id
   * @param {Object} patch - 只含要改的那几个键
   * @param {number} nowMs - 现在（epoch 毫秒，当 `updated_at`）
   * @returns {Object} 改完之后的行（界面形状）
   * @throws {Error} 不存在 / 不属于本人时抛 404；违反约束 / `trip_id` 不是自己的行程时抛 400
   */
  updateTripTicket(uid, id, patch, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getTripTicket(me, Number(id));
    if (!cur) throw notFoundErr('车票');
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = shapeTicket(cur);
    for (const k of TICKET_EDIT_COLS) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const v = src[k];
      if (k === 'trip_id') {
        next.trip_id = v == null || v === '' ? null : Number(v);
        if (next.trip_id !== null && !this._bk.getTrip(me, next.trip_id)) throw badRequest('这个行程不在了');
      } else if (k === 'price_fen') {
        next.price_fen = v == null || v === '' ? null : Math.round(Number(v));
      } else {
        next[k] = v == null ? '' : String(v);
      }
    }
    assertTicketRow(next);
    this._bk.setTripTicket(
      me,
      Number(id),
      {
        trip_id: next.trip_id,
        kind: next.kind,
        code: next.code || null,
        from_station: next.from_station,
        to_station: next.to_station,
        depart_at: next.depart_at,
        arrive_at: next.arrive_at || null,
        seat: next.seat || null,
        gate: next.gate || null,
        terminal: next.terminal || null,
        price_fen: next.price_fen == null ? null : Math.round(Number(next.price_fen)),
        order_no: next.order_no || null,
        note: next.note || null,
      },
      Math.round(Number(nowMs)),
    );
    return this.getTripTicket(me, id);
  },

  /**
   * 功能：删一张车票。
   * @param {number} uid - 账号 id
   * @param {number} id - 车票 id
   * @returns {boolean} 删成功为 true
   * @throws {Error} 不存在 / 不属于本人时抛 404；数据层只读时抛 503
   */
  deleteTripTicket(uid, id) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getTripTicket(me, Number(id));
    if (!cur) throw notFoundErr('车票');
    return this._bk.deleteTripTicket(me, Number(id));
  },

  // ---- 轨迹点与打卡点 ----
  /**
   * 功能：取一条行程（或「不挂行程」）的**全部点**（按测量时刻升序）。
   *
   * 说明：⭐⭐ **它刻意不进 `tripState`**（方案 §5.3）：`time_trip_points` 是本项目**第一张可能上万行
   *      的用户表**（一段两小时的车程 ≈ 数百到数千点）⇒ 首屏只给**点数**（一条 `COUNT`），
   *      点只在**轨迹屏**单独取。⛔ 别图省事把它并进一屏接口 —— 那会让每次进屏都拖上万个点。
   *
   * @param {number} uid - 账号 id
   * @param {?(number|string)} tripId - 行程 id；`null` / 省略 = 「不挂行程的那些」
   * @param {?number} fromMs - 最早测量时刻（epoch 毫秒，含）；null = 不限 —— ⚠️ 它来自
   *      `GET /api/trip/points?from=&to=`（方案 §6.1 第 9 条），不是方案 §5.3 的签名简写里那两项
   * @param {?number} toMs - 最晚测量时刻（epoch 毫秒，含）；null = 不限
   * @returns {Array.<Object>} 界面形状的点数组（按 `at` 升序）
   */
  tripPoints(uid, tripId, fromMs, toMs) {
    const t = tripId === null || tripId === undefined || tripId === '' ? null : Number(tripId);
    const lo = fromMs === null || fromMs === undefined || fromMs === '' ? null : Number(fromMs);
    const hi = toMs === null || toMs === undefined || toMs === '' ? null : Number(toMs);
    return this._bk.listTripPoints(Number(uid), t, lo, hi).map(shapePoint);
  },

  /**
   * 功能：⭐ **批量补点** —— 整批要么全进、要么不进（一个事务）。
   *
   * 说明：⭐⭐ **一次 ≤ 200 个**（方案 §6.2「超限可见地拒绝」，⛔ 不静默截断）：前端每 20 秒或
   *      每满 50 个点发一批，200 是它 4 倍余量 ⇒ 正常路径永远碰不到这道闸门，碰到就是有人在
   *      拿别的客户端一次性灌点，那种请求该被看得见地拒掉。
   *      ⚠️ 路由层也判一次（那里能把 `max` / `got` 一起回给调用方）；这里是**第二道**，
   *      防的是「跨模块直接调业务方法」绕过接口层。
   *      ⚠️ 空数组 ⇒ **400 而不是静默成功**：一次什么都没带的补点请求一定是调用方写错了，
   *      静默回 200 会让它一直错下去。
   *
   * @param {number} uid - 账号 id
   * @param {?(number|string)} tripId - 归属行程 id 或 null
   * @param {Array.<Object>} points - 待写入的点（每项可含 `kind` / `at` / `lat` / `lng` / …）
   * @param {number} nowMs - 服务端现在（epoch 毫秒；同时也是 `created_at`）
   * @returns {Array.<Object>} 写入后的点（界面形状）
   * @throws {Error} 空批 / 超限 / 任一字段非法时抛 400；数据层只读时抛 503
   */
  createTripPoints(uid, tripId, points, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const list = Array.isArray(points) ? points : [];
    if (!list.length) throw badRequest('没有要记的点');
    if (list.length > POINT_MAX_BATCH) {
      throw badRequest(`一次最多补 ${POINT_MAX_BATCH} 个点（这次收到 ${list.length} 个）`);
    }
    const t = resolveTripId(this, me, tripId);
    const stamp = Math.round(Number(nowMs));
    const rows = list.map((p) => pointRow(me, t, p, stamp, stamp));
    return this._bk.insertTripPoints(me, t, rows).map(shapePoint);
  },

  /**
   * 功能：⭐ **打卡** —— 记一个点 ＋ 一个名字（`kind = 'checkin'`）。
   *
   * 说明：⭐ 「打卡」与「轨迹」是**同一张表里的两种点**（方案 §三），差别只在 `kind`
   *      与 `label`：轨迹点是「走过的路」，打卡点是「一个有意义的地点」。
   *      ⚠️ **不要求有行程**（方案 §11.1-5）： 的直接结果 —— 不建行程也能打卡。
   *
   * @param {number} uid - 账号 id
   * @param {?(number|string)} tripId - 归属行程 id 或 null
   * @param {Object} point - `{ at?, lat, lng, accuracy?, label?, note? }`
   * @param {number} nowMs - 服务端现在（epoch 毫秒）
   * @returns {Object} 写入后的点（界面形状）
   * @throws {Error} 字段非法 / 归属不是自己的行程时抛 400；数据层只读时抛 503
   */
  tripCheckin(uid, tripId, point, nowMs) {
    this._assertWritable();
    const me = Number(uid);
    const t = resolveTripId(this, me, tripId);
    const stamp = Math.round(Number(nowMs));
    const row = pointRow(me, t, { ...(point || {}), kind: 'checkin' }, stamp, stamp);
    return shapePoint(this._insert('time_trip_points', row));
  },

  /**
   * 功能：改一个点的**名字 / 备注 / 归属** —— ⛔ 坐标与测量时刻**一个都不许改**。
   *
   * 说明：⭐⭐ 「打卡点的名字写错了」与「这条轨迹记的不对」是**两件事**：前者随手可改，
   *      后者只能删掉重记。⇒ 原语 `setTripPoint()` 的列清单里**只有三列**
   *      （`label` / `note` / `trip_id`），`lat` / `lng` / `at` 进不了 SET
   *      （与 `allowedCols` 四张表全空是同一条纪律的两个落点）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 点 id
   * @param {Object} patch - 只含要改的那几个键（`label` / `note` / `trip_id`）
   * @returns {Object} 改完之后的点（界面形状）
   * @throws {Error} 不存在 / 不属于本人时抛 404；字段非法时抛 400
   */
  updateTripPoint(uid, id, patch) {
    this._assertWritable();
    const me = Number(uid);
    const cur = this._bk.getTripPoint(me, Number(id));
    if (!cur) throw notFoundErr('这个点');
    const src = patch && typeof patch === 'object' ? patch : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const next = shapePoint(cur);
    if (has('trip_id')) next.trip_id = resolveTripId(this, me, src.trip_id);
    if (has('label')) {
      next.label = src.label == null ? '' : String(src.label).trim();
      if (next.label.length > LABEL_MAX) throw badRequest(`名字不能超过 ${LABEL_MAX} 个字`);
    }
    if (has('note')) {
      next.note = src.note == null ? '' : String(src.note);
      if (next.note.length > NOTE_MAX) throw badRequest(`备注不能超过 ${NOTE_MAX} 个字`);
    }
    this._bk.setTripPoint(me, Number(id), {
      label: next.label || null,
      note: next.note || null,
      trip_id: next.trip_id,
    });
    return next;
  },

  /**
   * 功能：删掉一个点。
   * @param {number} uid - 账号 id
   * @param {number} id - 点 id
   * @returns {boolean} 删成功为 true
   * @throws {Error} 不存在 / 不属于本人时抛 404；数据层只读时抛 503
   */
  deleteTripPoint(uid, id) {
    this._assertWritable();
    const me = Number(uid);
    if (!this._bk.getTripPoint(me, Number(id))) throw notFoundErr('这个点');
    return this._bk.deleteTripPoint(me, Number(id));
  },

  /**
   * 功能：清空一条行程（或「不挂行程」）的全部点，返回删掉的条数。
   *
   * 说明：⚠️ `tripId` 为 `null` 时**只清「不挂行程的那些」**（⛔ 不是「清全部」）——
   *      与 `listTripPoints` 共用同一个判据（原语层的 `tripCond()`，一处实现）。
   *      ⚠️ 前端必须做二次确认（方案 §6.1 第 14 条）；服务端**不**代做那个判断
   *      （接口只做「取参数 → 校验 → 调业务方法 → 回响应」）。
   *
   * @param {number} uid - 账号 id
   * @param {?(number|string)} tripId - 行程 id 或 null
   * @returns {number} 删掉的条数
   * @throws {Error} 数据层只读时抛 503
   */
  clearTripPoints(uid, tripId) {
    this._assertWritable();
    const me = Number(uid);
    const t = tripId === null || tripId === undefined || tripId === '' ? null : Number(tripId);
    return this._bk.clearTripPoints(me, t);
  },

  // ---- 给对话 ticker 的公开读方法----
  /**
   * 功能：⭐ **判据唯一处** —— 「这一分钟该发哪些出发提醒」（方案 §8.3）。
   *
   * 说明：⭐⭐ 上游（`modules/teamwork/ticker.js` 的 `dueJobs()` 第 ⑤ 组）**一行算术都不做**，
   *      它只把这个函数的返回值原样展开。这么分工的理由：三档 `fire_at` 的算术只该有一份
   *      ，而它住在 `lib/depart.js`；在 ticker 里再判一遍就是第二份口径。
   *
   * **两扇门**（任一条不成立 ⇒ 一个候选都不给）：
   *      ① `users.hide_trip` 开着（这个账号把行程模块关掉了）；
   *      ② 三档提醒开关全关（`time_trip_prefs` 那一行，读侧已合并默认值）。
   *
   * ⭐ **扫的窗口**：从 `nowKey` 起、未来「最长档位 + 1 分钟」（3 天 + 1 分钟）——
   *      靠 `idx_trip_tickets_user_depart` 那条索引，⛔ 不把全部车票捞回来。
   *      「+1 分钟」是为了让**恰好落在窗口末端的**那一分钟也进得来（闭区间）。
   *
   * ⭐ **同一分钟多张票 ⇒ 一条消息**（照 `courseBody()` 的做法）：按**档位**分组，
   *      每组一个候选，`ref_keys` 是组里每一个 (票, 档位) 的键 —— 于是
   *      「只要有**一条**键记上账就发、全记过就跳过」这条既有语义（`fireGroup`）自动成立。
   *      ⚠️ 同一分钟**不同档位**（一张票的 d3 与另一张票的 d1 撞在一起）**不合并**：
   *      它们开头那句不一样，挤进一个气泡反而看不清。
   *
   * ⚠️ **`ref_key` 的形状**：`trip:<车票 id>:<档位>` —— 刻意**不带「归属」**（见 `ticker.js`
   *      的 `KIND` 说明）；也刻意**不带 `fire_at` 之外的时刻信息** ⇒
   *      「票被改到另一个出发时刻之后，同一档**不会**再发第二次」是**刻意的**
   *      （否则改一次票就多发一轮）。这条在方案 §8.5 明写、`trip.test.js` 有测试钉着，⛔ 别当 bug 修。
   *
   * @param {number} uid - 账号 id
   * @param {string} nowKey - 这一分钟 `YYYY-MM-DD HH:MM`
   * @returns {Array.<{stage: string, ref_keys: Array.<string>, fire_at: string, body: string}>}
   *      待发候选（按 `TRIP_STAGES` 的顺序；空数组 = 这一分钟没有）
   */
  tripReminderCandidates(uid, nowKey) {
    const me = Number(uid);
    const key = String(nowKey == null ? '' : nowKey);
    // ⛔ 时间串读不出来 ⇒ 空数组（在 ticker 里猜一个时刻等于安静地发错提醒）
    if (!KEY_RE.test(key) || !realKey(key)) return [];

    // 门 ①：这个账号把行程关掉了
    const user = this.getUser(me) || {};
    if (Number(user.hide_trip)) return [];

    // 门 ②：三档全关
    const prefs = this.tripPrefs(me);
    const stages = TRIP_STAGES.map((s) => ({ tag: s.tag, mins: s.minutes, on: Number(prefs[`remind_${s.tag}`]) ? 1 : 0 }));
    if (!stages.some((s) => s.on)) return [];

    // 扫窗口：从这一分钟起、未来「最长档位 + 1 分钟」
    const longest = Math.max(...TRIP_STAGES.map((s) => s.minutes));
    const horizon = addMinutesKey(key, longest + 1);
    if (!horizon) return [];
    const rows = this._bk.departingTripTickets(me, key, horizon);

    const byStage = new Map();
    for (const t of rows) {
      for (const s of stages) {
        if (!s.on) continue;
        if (tripFireAt(t.depart_at, s.mins) !== key) continue;
        if (!byStage.has(s.tag)) byStage.set(s.tag, []);
        byStage.get(s.tag).push(t);
      }
    }

    const out = [];
    for (const s of TRIP_STAGES) {
      const hit = byStage.get(s.tag);
      if (!hit || !hit.length) continue;
      out.push({
        stage: s.tag,
        ref_keys: hit.map((t) => `trip:${Number(t.id)}:${s.tag}`),
        fire_at: key,
        body: tripReminderBody(s.tag, hit),
      });
    }
    return out;
  },

  // ---- 给 AI 读工具的公开读方法----
  /**
   * 功能：⭐ **给 AI 读工具的公开读方法**（方案 §9.1）—— **返回面就是出网面**。
   *
   * 说明：⭐⭐ **刻意与 `tripState` 分开**（方案 §5.3）：工具面要的是「有哪些行程、什么票」，
   *      而 `tripState` 带 `id` / 订单号 / 备注 / 点数…… 混用一个方法的下场是
   *      「改一屏的摘要顺手就把订单号带出了网」，而且**没有任何用例会红**。
   *
   * ⛔ **不给**：`id` / `order_no`（票号与订单号）/ `price_fen` / `note` / 任何坐标
   *      。
   * ⭐ **取不到要带原因**（照 `busySlots()` 的既有教训）：`reason ∈ {ok, disabled, empty}`
   *      —— ⛔ 一律**不许回一个空数组**（空数组与「我真的没有行程」在模型眼里长得一模一样）。
   *      ⚠️ `no_module` 那一种由调用方（AI 侧的 `need` 守卫）判 —— 模块被整目录删掉时
   *      这个方法在原型上根本不存在，那时**轮不到它自己说话**。
   *
   * @param {number} uid - 账号 id
   * @param {string} range - `upcoming`（今天起 30 天，默认）或 `recent`（最近 30 天）
   * @param {?string} today - 服务端「今天」`YYYY-MM-DD`（由调用方传，本方法不读时钟）
   * @returns {{range: string, reason: string, trips: Array.<Object>, tickets: Array.<Object>}} 只含白名单字段
   */
  tripAiUpcoming(uid, range, today) {
    const me = Number(uid);
    const r = String(range == null ? '' : range) === 'recent' ? 'recent' : 'upcoming';
    const day = DATE_RE.test(String(today == null ? '' : today)) ? String(today) : dateOf(Date.now());
    // 门：这个账号把行程关掉了 ⇒ 不给数据，但**要说清为什么**
    const user = this.getUser(me) || {};
    if (Number(user.hide_trip)) return { range: r, reason: 'disabled', trips: [], tickets: [] };

    const from = r === 'recent' ? shiftDate(day, -30) : day;
    const to = r === 'recent' ? day : shiftDate(day, 30);
    const trips = this.listTrips(me, from, to);
    const tickets = this.listTripTickets(me, from, to);
    if (!trips.length && !tickets.length) return { range: r, reason: 'empty', trips: [], tickets: [] };

    return {
      range: r,
      reason: 'ok',
      // ⚠️ 逐字段白名单搬运（⛔ 不是 `{...t}`）：多一个字段就是多一次出网
      //    ⭐ 0.8.6（给行程加了交通工具 / 起点 / 终点 / 起始时刻）：
      //    这四项恰恰是「我接下来要去哪」要答的东西 ⇒ 一并给出（与车票那边给 `from` / `to`
      //    同一个尺度：都是**用户自己填的地名与类别**）。
      //    ⛔ `note` / 任何 `id` / 任何坐标**仍然不给**。
      trips: trips.map((t) => ({
        title: t.title,
        vehicle: t.vehicle,
        from: t.from_place,
        to: t.to_place,
        start_date: t.start_date,
        start_time: t.start_time,
        end_date: t.end_date,
      })),
      tickets: tickets.map((t) => ({
        kind: t.kind,
        code: t.code,
        from: t.from_station,
        to: t.to_station,
        depart: t.depart_at,
        arrive: t.arrive_at,
        seat: t.seat,
        gate: t.gate,
      })),
    };
  },

  // ---- 一屏聚合 ----
  /**
   * 功能：把「一屏所需的全部」一次给全 —— 服务端「今天」＋ 三档开关 ＋ 下一张待出发的票
   *      ＋ 行程列表（每条带票数与点数）＋ 区间车票。
   *
   * 说明：⭐ 合并成**一个** `GET /api/trip`：少一次请求、少一处 401 分支，
   *      进屏时三块不会各闪一次。
   *      ⭐⭐ **不含任何轨迹点**：`time_trip_points` 是本项目第一张可能上万行的用户表，
   *      点只在**轨迹屏**单独取（`GET /api/trip/points`）—— 首屏只给**点数**（一条 COUNT）。
   *      ⚠️⭐ **列表摘要是「票数 ＋ 点数」，刻意不含里程**（方案 §7.2 的示例里写了 128 km）：
   *      要在列表里算里程就得把每条行程的上万个点**全取回来**，与方案自己那条
   *      「⛔ 前端不许为了画一行摘要把上万个点捞回来」冲突 ⇒ 里程只在轨迹屏算
   *      （那里本来就要取全部点）。这一处偏离已记进方案附录 D 与 §15.3.3。
   *      ⚠️ `upcoming` = **现在之后最早的一张票**（`depart_at > nowKey`），没有就给 `null`。
   *      倒计时文案由两端用 `shared.js` 的 `tripCountdown()` 现算（⛔ 服务端不下发文案）。
   *
   * @param {number} uid - 账号 id
   * @param {?string} from - 区间起点 `YYYY-MM-DD`（省略 = 不限）
   * @param {?string} to - 区间终点 `YYYY-MM-DD`（省略 = 不限）
   * @param {number} nowMs - 服务端当前时刻（epoch 毫秒）
   * @returns {{today: string, from: string, to: string, prefs: Object, upcoming: ?Object,
   *      trips: Array.<Object>, tickets: Array.<Object>, loose_point_count: number}} 一屏所需的全部
   */
  tripState(uid, from, to, nowMs) {
    const me = Number(uid);
    const now = Math.round(Number(nowMs));
    const today = dateOf(now);
    const nowKey = keyOf(now);
    // ⚠️ 不带区间 = **不限**（用极值兜底）：行程是「几十条」量级，一次给全比猜一个窗口稳。
    const f = from ? String(from) : '0000-01-01';
    const t = to ? String(to) : '9999-12-31';

    const tickets = this.listTripTickets(me, f, t);
    const perTrip = new Map();
    tickets.forEach((tk) => {
      if (tk.trip_id) perTrip.set(tk.trip_id, (perTrip.get(tk.trip_id) || 0) + 1);
    });
    const trips = this.listTrips(me, f, t).map((tr) => ({
      ...tr,
      ticket_count: perTrip.get(tr.id) || 0,
      point_count: this._bk.countTripPoints(me, tr.id) || 0,
    }));

    // 下一张待出发的票：扫未来 400 天（`departingTripTickets` 按完整时刻串比，够精确）
    const horizon = addMinutesKey(nowKey, 400 * 24 * 60) || '9999-12-31 23:59';
    const next = this._bk.departingTripTickets(me, nowKey, horizon);
    const upcoming = next.length ? this.getTripTicket(me, Number(next[0].id)) : null;

    // ⭐ 「没挂进行程的点」的条数（方案 §7.2 的 ③ 未归属块要含轨迹）：⛔ 不是「全部点」，是一条 COUNT
    const loosePointCount = this._bk.countTripPoints(me, null) || 0;

    return {
      today,
      // ⭐ 0.8.33 追改（「还没开始怎么就进行中了」）：「现在几点」也搭车带回 ——
      //    行程状态从前只看**整日**（`start_date ≤ today ≤ end_date` 就算进行中），
      //    于是一条今天 18:00 才出发的行程，上午十点就写着「进行中」。
      //    ⚠️ 与 `today` 同一条纪律：**服务端时间才是权威源**，前端⛔ 不许读本机时钟去算它
      //    （前端走 `ttSyncServerNow(data.now)` ＋ `ttNowHM()`，与首页看板同款）。
      now: nowKey,
      from: f,
      to: t,
      prefs: this.tripPrefs(me),
      // ⭐ 0.8.9：人生日历那两项设置随一屏搭车带回（零新请求）——
      //    它已经从日历模块整体搬进行程，行程屏那颗按钮点开就是它。
      life: this.tripLife(me),
      upcoming,
      trips,
      tickets,
      loose_point_count: loosePointCount,
    };
  },
};
