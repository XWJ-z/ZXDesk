/**
 * modules/trip/shared.js —— 行程**两端共用**的纯函数层（0.8.6）
 *
 * 功能：几何 / 统计 / 文案 / 手写轨迹图 —— ⭐ 两端 import **同一份**（双份判据必然漂移）。
 *      · `tripFireAt()`    —— 三档 `fire_at` 的算法（与 `modules/trip/lib/depart.js` **必须逐字同解**，
 *         `ttt/test/trip.test.js` 有一组对账向量钉着）；
 *      · `tripCountdown()` —— 「还有 x 天 y 小时」/「已经出发」的文案（两端共用一份）；
 *      · `tripHaversine()` —— 两点球面距离（米）；
 *      · `tripTrackStats()`—— 里程 / 时长 / 点数（带断点规则）；
 *      · `tripSegments()`  —— ⭐ 按断点把轨迹切成若干段（**里程与画面共用同一个判据**）；
 *      · `tripProject()`   —— 等距圆柱投影 + 等比塞进 `viewBox`；
 *      · `tripSimplify()`  —— 画面抽稀（⭐ **打卡点永不抽掉**）；
 *      · `tripDistanceText()` / `tripDurationText()` —— 米 / 毫秒 → 人话；
 *      · `tripTrackSvg()`  —— ⭐ **手写 SVG**（无底图、无地图库；`polyline` 必带 `fill="none"`）。
 *
 * ⭐⭐ **投影的确切公式**（方案 §5.4，依据 PROJ 的 `+proj=eqc`）：
 *      `x = R·(λ − λ₀)·cos φ₁`、`y = R·(φ − φ₀)`，`φ₁` 是**标准纬线**（取轨迹包围盒的平均纬度）。
 *      ⚠️⭐ **`cos φ₁` 不能省**：在华中一带（约北纬 30°）1° 经度 ≈ 96 km、1° 纬度 ≈ 111 km ——
 *      省掉它，**东西向会被拉伸约 15%**，一条正南北的路会画成斜的，而且**看不出来是错的**。
 *      ⇒ 最后用 `k = min(W/ΔX, H/ΔY)` **等比**缩放（⛔ 不许两轴各自拉伸）。
 *
 * ⭐ **画布的三条硬要求**（方案 §5.4，依据 W3C SVG 1.1）：
 *      ① `<polyline>` **必须写 `fill="none"`**（默认会填充 ⇒ 一块乱涂的色块）；
 *      ② `points` 必须是**偶数个坐标**（奇数个 ⇒ 规范说 the element is in error）；
 *      ③ **y 轴要翻**（地理北向上、SVG 的 y 向下）⇒ `py = H − y`，⛔ 别用 `scale(1,-1)`
 *      （那会把文字一起镜像）。⇒ 本文件直接给出**已经翻好**的屏幕坐标。
 *
 * ⚠️ 本文件**不碰 DOM、不 import 任何东西**（纯函数）：`frontend-modules.test.js` 会在 Node 里
 *    直接 import 它跑断言，所以它必须能在没有 `window` 的环境里求值。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.33
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md、docs/公共/调研报告/11-行程调研.md
 */

/** 地球平均半径（米）—— ⚠️ Haversine 与投影**必须用同一个 R**（⛔ 别一处 6371 km 一处半长轴）。 */
const EARTH_R = 6371008.8;

/**
 * 票型 —— ⭐ **两端共用这一份**：图标与名字是界面上逐字显示的东西，
 * 两份的下场是「电脑端叫高铁、手机端叫动车」而且**没有任何用例会红**。
 * ⚠️ `key` 必须与 `schema.js` 的 `CHECK (kind IN (…))`、服务的 `TICKET_KINDS` 逐字一致。
 * @type {Array.<{key: string, label: string, icon: string}>}
 */
export const TRIP_KINDS = [
  { key: 'train', label: '火车', icon: '🚂' },
  { key: 'highspeed', label: '高铁', icon: '🚄' },
  { key: 'flight', label: '飞机', icon: '✈️' },
  { key: 'bus', label: '汽车', icon: '🚌' },
  { key: 'ship', label: '船', icon: '⛴️' },
  { key: 'other', label: '其它', icon: '🎫' },
];

/** 票型 key → 那一条（渲染用，两端共用） */
export const tripKindOf = (key) => TRIP_KINDS.find((k) => k.key === key) || TRIP_KINDS[TRIP_KINDS.length - 1];

/**
 * 行程的**状态**三档 —— ⭐ 0.8.32 收成一份（从前两端各写了一遍同样的三元表达式）。
 *
 * 说明：⭐⭐ 状态**不落库**（方案 §4.4）：它由「起止日 ＋ 服务端给的今天」当场算出来 ——
 *      落库就等于存了一份会过期的判断（明天打开还是「进行中」）。
 *      ⚠️ `today` 必须用**服务端**给的那一个（`GET /api/trip` 搭车回来的 `today`）——
 *      页面自己读本机时钟会在跨时区 / 跨零点时与列表上的日期打架。
 *      ⚠️ 容错方向：起止日都缺 ⇒ 当「计划中」（一块没有日期的卡片不该显示成「已结束」）。
 *
 * @type {Array.<{key: string, label: string}>}
 */
export const TRIP_STATES = [
  { key: 'plan', label: '计划中' },
  { key: 'live', label: '进行中' },
  { key: 'done', label: '已结束' },
];

/**
 * 功能：算一条行程现在处于哪一档（判据只此一份，两端共用）。
 *
 * 说明：⭐ 0.8.33 追改（「**还没开始怎么就进行中了**」）：起止那两天要**看时刻** ——
 *      从前只比整日（`start_date ≤ today ≤ end_date` ⇒ 进行中），于是一条今天 18:00 才出发的行程，
 *      上午十点就顶着「进行中」。现在：
 *        · 今天就是**起日**、且起时刻还没到 ⇒ 仍是「计划中」；
 *        · 今天就是**止日**、且止时刻已经过了 ⇒ 就是「已结束」；
 *        · 中间那些整天、以及起日已过 / 止日未到 ⇒ 照旧「进行中」。
 *      ⚠️ 缺时刻（`start_time` / `end_time` 空）或缺 `now` ⇒ **退回按整日算**的旧口径
 *      —— ⛔ 绝不拿 `00:00` / `23:59` 去替用户猜一个他没填的时刻（与「没填票价不给 0」同一条纪律）。
 *      ⚠️ `now` 必须是**服务端**给的那一个（`GET /api/trip` 搭车回来的 `now`，
 *      形如 `YYYY-MM-DD HH:MM`）—— 前端自己读本机时钟会在跨零点 / 跨时区时与列表上的日期打架。
 *      ⚠️ 两端各写一遍的后果见 `11`：同一个「今天」两处给的档不一样（0.8.32 修过一次）。
 *
 * @param {Object} tr - 行程（`start_date` / `start_time` / `end_date` / `end_time`）
 * @param {string} today - **服务端**给的今天 `YYYY-MM-DD`
 * @param {?string} now - **服务端**给的现在 `YYYY-MM-DD HH:MM`（缺 ⇒ 按整日算）
 * @returns {string} `'plan'` / `'live'` / `'done'`
 */
export function tripStateOf(tr, today, now) {
  const d = String(today == null ? '' : today);
  const s = String((tr && tr.start_date) || '');
  const e = String((tr && tr.end_date) || s);
  if (!s) return 'plan';
  if (d < s) return 'plan';
  if (d > e) return 'done';
  // 落在起止区间内（含首尾两天）—— 首尾那两天还要看时刻
  const cur = String(now == null ? '' : now).slice(11, 16);
  if (!/^\d\d:\d\d$/.test(cur)) return 'live';
  if (d === s) {
    const st = String((tr && tr.start_time) || '');
    if (/^\d\d:\d\d$/.test(st) && cur < st) return 'plan';
  }
  if (d === e) {
    const et = String((tr && tr.end_time) || '');
    if (/^\d\d:\d\d$/.test(et) && cur > et) return 'done';
  }
  return 'live';
}

/**
 * 功能：状态键 → 界面上那两个字。
 * @param {string} key - `tripStateOf()` 的返回值
 * @returns {string} `计划中` / `进行中` / `已结束`
 */
export function tripStateText(key) {
  const one = TRIP_STATES.find((s) => s.key === key);
  return one ? one.label : TRIP_STATES[0].label;
}

/**
 * 功能：这一张票是不是**即将出发那一张**（界面据此给它加强调底色）。
 * @param {Object} tk - 车票
 * @param {?Object} upcoming - `GET /api/trip` 的 `upcoming`
 * @returns {boolean} 是则为 true
 */
export function tripIsUpcoming(tk, upcoming) {
  return !!(upcoming && tk && Number(tk.id) === Number(upcoming.id));
}

/**
 * 功能：把行程的「起点 → 终点」拼成一行字（⭐ 两端共用一份 ——）。
 *
 * 说明：⚠️ **两个都没填 ⇒ 回空串**（调用方据此整段不显示，⛔ 不显示一条「— → —」的空壳）。
 *      只填了一头 ⇒ 另一头写 `—`（那确实是「不知道从哪儿来」，比编一个地名诚实）。
 *      ⚠️ 两端各写一份的下场是「电脑端写 `→`、手机端写 `-`」这种没人会报错的差异。
 *
 * @param {Object} tr - 行程（`from_place` / `to_place`）
 * @returns {string} 如「重庆北 → 云阳」；两个都没填时为空串
 */
export function tripOdText(tr) {
  const a = String((tr && tr.from_place) || '').trim();
  const b = String((tr && tr.to_place) || '').trim();
  if (!a && !b) return '';
  return `${a || '—'} → ${b || '—'}`;
}

/**
 * 功能：行程的「起始日期时间」与「起止区间」两行文案（⭐ 两端共用一份 ——）。
 *
 * 说明：⚠️ 起始**时刻**可空（`start_time`）⇒ 空时**只显示日期**，⛔ 不补 `00:00`
 *      —— 那会凭空造一个用户没填的时刻（与「没填票价」不给 0 是同一条纪律）。
 *      结束日期为空、或与起始日**相同** ⇒ 区间退化成一点，只显示起始那一头。
 *
 * @param {Object} tr - 行程（`start_date` / `start_time` / `end_date`）
 * @returns {{start: string, range: string}} `start` = 「2026-09-30 08:30」或「2026-09-30」；
 *      `range` = 「2026-09-30 08:30 ~ 2026-10-06」，没有结束日时与 `start` 相同
 */
export function tripWhenText(tr) {
  const d = String((tr && tr.start_date) || '').trim();
  const t = String((tr && tr.start_time) || '').trim();
  const e = String((tr && tr.end_date) || '').trim();
  // ⭐ 0.8.13：结束**时刻**也参与 —— 同一天时只说时刻（`08:30 ~ 12:00` 比
  //    `2026-10-05 08:30 ~ 2026-10-05` 好读），跨天时带上日期（`… ~ 10-07 18:00`）。
  const et = String((tr && tr.end_time) || '').trim();
  if (!d) return { start: '', range: '' };
  const start = t ? `${d} ${t}` : d;
  const crossDay = !!e && e !== d;
  const endSide = et && crossDay ? `${e} ${et}` : et || (crossDay ? e : '');
  return { start, range: endSide ? `${start} ~ ${endSide}` : start };
}

/**
 * 功能：把「元」的输入串换算成**整数分**。
 *
 * 说明：⭐ 字符串解析而不是浮点乘法（方案 §7.4）：本机实测 `8.7 * 100 === 869.9999999999999`。
 *      超两位小数 / 非数字 ⇒ 回 `NaN`，由调用方报错（⛔ 不四舍五入、⛔ 不静默丢弃）。
 *      空串 ⇒ `null`（= 没填票价，与「票价 0 元」是两件事）。
 *      ⚠️ 两端**共用这一份**—— 两份换算的下场是「一边算对、一边差一分」。
 *
 * @param {string} s - 用户输入的「元」
 * @returns {?number} 整数分；不合法为 NaN；空为 null
 */
export function yuanToFen(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  const [a, b = ''] = t.split('.');
  return Number(a) * 100 + Number(`${b}00`.slice(0, 2));
}

/**
 * 功能：把**整数分**还原成「元」的显示串（表单回填用）。
 * @param {?(number|string)} fen - 整数分
 * @returns {string} 如 `35.5`；空为 ''
 */
export function fenToYuan(fen) {
  if (fen === null || fen === undefined || fen === '') return '';
  const n = Number(fen);
  if (!Number.isFinite(n)) return '';
  return (n / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** 一度纬度约合多少公里 —— 投影的比例尺用它（全球平均；本项目只做「相对形状」）。 */
const KM_PER_DEG = 111.32;

/** 两点间隔超过这个毫秒数 ⇒ **不算里程、也不连线**（页面切后台就采不到点了）。 */
const GAP_MS = 10 * 60 * 1000;

/** 精度差于这个米数的那一段**不计里程**（一个 ±500 m 的点会把里程带上几百米）。 */
const ACC_MAX_M = 100;

/**
 * 功能：两位补零。
 * @param {number} n - 数字
 * @returns {string} 两位字符串
 */
function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 功能：⭐ **严格**地把一个值当数字看 —— `null` / `undefined` / 空串一律回 `NaN`。
 *
 * 说明：⭐⭐ 本文件里**所有**「取一个数值字段」的地方都要走它，⛔ 不许直接写 `Number(x)`：
 *      `Number(null) === 0` 是个**有限数**，而 `0` 在经纬度上是一个**真实的坐标**
 *      （几内亚湾）⇒ 一条缺了 `lat` 的点会被静静地画到赤道上，里程也跟着变，
 *      而**没有任何一处会报错**（本项目最贵的那一类坑，「先挡 null 再转数字」的定式）。
 *
 * @param {*} v - 原始值
 * @returns {number} 数字；不是数字时为 NaN
 */
function strictNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
}

/**
 * 功能：把 `YYYY-MM-DD HH:MM` 解析成**本地时刻**的 `Date`；格式不对回 `null`。
 *
 * 说明：⚠️ 严格定长两位，并做**回环校验** ——
 *      `2026-02-30` 会被 `Date` 静默滚到 3 月 2 日，那种值算出来的倒计时是错的。
 *
 * @param {string} s - 待解析的字符串
 * @returns {?Date} 本地时刻；解析失败为 null
 */
export function parseTripTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

/**
 * 功能：把本地时刻格式化成 `YYYY-MM-DD HH:MM`。
 * @param {Date} d - 本地时刻
 * @returns {string} 定长两位的字符串
 */
export function formatTripTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 功能：⭐ 三档 `fire_at` 的算法（前端那一份）—— 把出发时刻减去 `leadMinutes` 分钟。
 *
 * 说明：⭐⭐ **与服务端 `modules/trip/lib/depart.js` 的同名函数是同一件事的两个视角** ⇒
 *      两处必须在同一组向量上**逐字同解**（`ttt/test/trip.test.js` 的对账用例钉着）。
 *      ⚠️ 前端这份只给**倒计时 / 提示**用；**发不发提醒一律以服务端那份为准**。
 *
 * @param {string} departAt - 出发当地时刻 `YYYY-MM-DD HH:MM`
 * @param {number} leadMinutes - 提前多少分钟
 * @returns {?string} 应发的那一分钟；算不出来为 null
 */
export function tripFireAt(departAt, leadMinutes) {
  const d = parseTripTime(departAt);
  if (!d) return null;
  // ⚠️ 先挡 null / '' 再转数字：`Number(null) === 0` 是个**有限数** ⇒ 会把「没传」当成「提前 0 分钟」
  if (leadMinutes === null || leadMinutes === undefined || leadMinutes === '') return null;
  const mins = Number(leadMinutes);
  if (!Number.isFinite(mins)) return null;
  return formatTripTime(new Date(d.getTime() - Math.round(mins) * 60000));
}

/**
 * 功能：「还有多久出发」的文案（两端共用一份）。
 *
 * 说明：⭐ 四种形态（方案 §11.3）：`已经出发` / `还有 x 天 y 小时` / `还有 x 小时 y 分钟` /
 *      `还有 x 分钟`（含「今天出发」= 小时档、`马上出发` = 不到一分钟）。
 *      ⚠️ 天 / 小时档里**第二段也必须是真实的剩余量**（项目 的同款教训：
 *      一句话里两段格式相同时，绝不能有一段是固定值）。
 *
 * @param {string} departAt - 出发当地时刻 `YYYY-MM-DD HH:MM`
 * @param {number} nowMs - 现在（epoch 毫秒）
 * @returns {string} 文案；时刻解析不出来时空串
 */
export function tripCountdown(departAt, nowMs) {
  const d = parseTripTime(departAt);
  if (!d) return '';
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return '';
  const diff = d.getTime() - now;
  if (diff <= 0) return '已经出发';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '马上出发';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `还有 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `还有 ${hours} 小时 ${rest} 分钟`;
  return `还有 ${rest} 分钟`;
}

/**
 * 功能：两点之间的**球面距离**（米，Haversine 公式）。
 *
 * 说明：⚠️ 用 `EARTH_R`（6381008.8 m）—— 与投影同一个 R。用例里拿权威里程做**容差 1%** 的比对，
 *      ⛔ 不用浮点相等断言（照番茄钟探针的容差口径）。
 *
 * @param {{lat: number, lng: number}} a - 点 A
 * @param {{lat: number, lng: number}} b - 点 B
 * @returns {number} 距离（米）；入参非法时为 0
 */
export function tripHaversine(a, b) {
  // ⚠️⭐ 必须用 `strictNum`：`Number(null) === 0`，而 0 度是个**真实坐标**（而不是「没有值」）
  const lat1 = strictNum(a && a.lat);
  const lng1 = strictNum(a && a.lng);
  const lat2 = strictNum(b && b.lat);
  const lng2 = strictNum(b && b.lng);
  if (![lat1, lng1, lat2, lng2].every((v) => Number.isFinite(v))) return 0;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 功能：按测量时刻升序排序（⛔ **不假设入参有序** —— 补传上来的批次本来就会乱）。
 * @param {Object} a - 点 A
 * @param {Object} b - 点 B
 * @returns {number} 比较结果
 */
function byAt(a, b) {
  return Number(a && a.at) - Number(b && b.at);
}

/**
 * 功能：只留**轨迹点**并按 `at` 升序（打卡点不是「走过的路」，不进里程）。
 * @param {Array.<Object>} points - 原始点数组（可能含打卡点）
 * @returns {Array.<Object>} 轨迹点（升序）
 */
export function tripTrackOnly(points) {
  return (Array.isArray(points) ? points : [])
    .filter((p) => p && p.kind !== 'checkin')
    .slice()
    .sort(byAt);
}

/**
 * 功能：⭐ **里程 / 时长 / 点数** —— 按 `at` 升序逐段累加，带两条断点规则。
 *
 * 说明：⭐ 断点规则：
 *      · **间隔 > 10 分钟**的那一段不计里程（页面切后台就采不到点了 —— 把那段算进去
 *        等于凭空造出一段「以几百公里时速横穿」的直线）；
 *      · **精度 > 100 m** 的那一段不计里程（一个 ±500 m 的点会把里程带上几百米）。
 *      两者都**只影响里程**：点数照数、时长照算。
 *      ⚠️ 时长 = 最后一点的 `at` − 第一点的 `at`（**总跨度**，含断点）——
 *      「这次出行从几点到几点」比「各段之和」更有意义，也更好复算。
 *
 * @param {Array.<Object>} points - 轨迹点（可含打卡点，本函数自己筛）
 * @returns {{distance_m: number, duration_ms: number, count: number, breaks: number}} 三个可复算的量 ＋ 断点数
 */
export function tripTrackStats(points) {
  const list = tripTrackOnly(points);
  let distance = 0;
  let breaks = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (breakBetween(list[i - 1], list[i])) {
      breaks += 1;
      continue;
    }
    distance += tripHaversine(list[i - 1], list[i]);
  }
  const duration = list.length > 1 ? Number(list[list.length - 1].at) - Number(list[0].at) : 0;
  return { distance_m: distance, duration_ms: duration, count: list.length, breaks };
}

/**
 * 功能：⭐ **画面抽稀** —— 等距抽到 ≤ `max` 个点，**打卡点一个都不抽掉**。
 *
 * 说明：⭐⭐ **只在画面上抽**：库里是**原始点**，抽稀进库就再也回不去了，
 *      而「里程」一旦按抽稀后的点算就会**偏小**，且**没有任何迹象**。
 *      ⇒ 本函数只被渲染层调用，⛔ 不改库、⛔ 不改里程。
 *      ⚠️ 点数本来 ≤ `max` ⇒ **原样返回**（不重新排、不复制）。
 *
 * @param {Array.<Object>} points - 全部点（含打卡）
 * @param {number} [max] - 上限，默认 400（ECharts 手册的经验值：>1k 点该换 Canvas，400 以内 SVG 更合适）
 * @returns {Array.<Object>} 抽稀后的点（按 `at` 升序）
 */
export function tripSimplify(points, max = 400) {
  const list = (Array.isArray(points) ? points : []).slice().sort(byAt);
  const cap = Number(max);
  if (!Number.isFinite(cap) || cap <= 0 || list.length <= cap) return list;
  const checkins = list.filter((p) => p.kind === 'checkin');
  const tracks = list.filter((p) => p.kind !== 'checkin');
  const keep = Math.max(0, cap - checkins.length);
  const picked = [];
  if (keep > 0 && tracks.length) {
    const n = tracks.length;
    for (let i = 0; i < keep; i += 1) {
      const idx = keep === 1 ? 0 : Math.round((i * (n - 1)) / (keep - 1));
      picked.push(tracks[idx]);
    }
  }
  return picked.concat(checkins).sort(byAt);
}

/**
 * 功能：⭐ **相邻两点之间是不是「断开」的** —— 里程与画面**共用这一个判据**。
 *
 * 说明：⭐⭐ ** 的落点**：`tripTrackStats()`（算里程）与 `tripSegments()`（画线时断段）
 *      必须是**同一批断点**。两处各写一遍的下场是「里程按断点算了、线却连起来了」——
 *      图上一段穿越几百公里的直线，而里程是正常的，谁都看不出来哪边错了。
 *      ⚠️ 断点不丢点：断开只表示「这两点之间没有可用的测量」。
 *
 * @param {Object} a - 前一个点
 * @param {Object} b - 后一个点
 * @returns {boolean} 断开为 true
 */
function breakBetween(a, b) {
  const gap = Number(b.at) - Number(a.at);
  const accA = a.accuracy === null || a.accuracy === undefined ? 0 : Number(a.accuracy);
  const accB = b.accuracy === null || b.accuracy === undefined ? 0 : Number(b.accuracy);
  return !(gap > 0) || gap > GAP_MS || accA > ACC_MAX_M || accB > ACC_MAX_M;
}

/**
 * 功能：⭐ **轨迹分段** —— 按「断点」把轨迹点切成若干段，每段内部才可以连线。
 *
 * 说明：⭐⭐ **这是「切走再回来不画穿越直线」的唯一判据**（方案 §十三的验收点）：
 *      页面切到后台就采不到点了（`§2.5-1`），把断开的两端连起来等于凭空画出一条
 *      「以几百公里时速横穿」的直线 —— 图上看不出来是错的，只会显得「这次走了很远」。
 *      断点判据与 `tripTrackStats()` **完全相同**（间隔 > 10 分钟、或任一端精度 > 100 m）：
 *      ⛔ 不许两处各写一遍—— 里程与画面必须是同一批段。
 *      ⚠️ 段内**点数不足 2 的段照回**（调用方自己决定画不画线）：一个孤立的点仍是数据。
 *
 * @param {Array.<Object>} points - **只含轨迹点**的数组（打卡点请先滤掉）
 * @returns {Array.<Array.<Object>>} 点段数组（每段按 `at` 升序）
 */
export function tripSegments(points) {
  const list = (Array.isArray(points) ? points : []).slice().sort(byAt);
  const out = [];
  let cur = [];
  for (const p of list) {
    if (!cur.length) {
      cur = [p];
      continue;
    }
    const a = cur[cur.length - 1];
    if (breakBetween(a, p)) {
      out.push(cur);
      cur = [p];
      continue;
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 功能：把**米**写成人话（`128.4 km` / `820 m`）。
 *
 * 说明：⚠️ 两端共用这一份—— 「一边写 `128.4 km`、一边写 `128.4公里`」这种漂移
 *      没有任何用例会红。不到 1 km 时给米（带一位小数反而假精确）。
 *
 * @param {number} m - 米
 * @returns {string} 文案
 */
export function tripDistanceText(m) {
  const n = strictNum(m);
  if (!Number.isFinite(n) || n <= 0) return '0 m';
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toFixed(1)} km`;
}

/**
 * 功能：把**毫秒跨度**写成人话（`2 小时 28 分` / `45 分钟` / `不到 1 分钟`）。
 * @param {number} ms - 毫秒
 * @returns {string} 文案
 */
export function tripDurationText(ms) {
  const n = strictNum(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 分钟';
  // ⚠️ 用 `floor` 而不是 `round`：round 会让 30 秒变成「1 分钟」，
  //    于是「不到 1 分钟」这句**永远不会出现**（一句到场不了的文案等于没写）
  const mins = Math.floor(n / 60000);
  if (mins < 1) return '不到 1 分钟';
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  if (!h) return `${rest} 分钟`;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/**
 * 功能：把测量时刻（epoch 毫秒）写成人话 —— `10-01 09:12`。
 *
 * 说明：⚠️ 两端共用：打卡点列表与记录面板都要它，两份的下场是
 *      「一边显示 `10-01`、一边显示 `2026-10-01`」，而这种差异没有任何用例会红。
 *      ⚠️ 用**本地时区**：这是「我当时在哪儿」，不是票面上的当地时刻（那是另一套口径，见）。
 *
 * @param {number} ms - epoch 毫秒
 * @returns {string} `MM-DD HH:MM`；算不出来回空串
 */
export function tripStampText(ms) {
  const n = strictNum(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 功能：⭐ **手写轨迹图** —— 回一段 `<svg>` 字符串（方案 §7.5）。
 *
 * 说明：⭐⭐ **不引任何地图 / 图表库**：投影是等距圆柱（`tripProject`）、
 *      底图**没有**、坐标**不出网**。这个函数返回的是纯字符串 ⇒ 两端可以各自包进自己的容器，
 *      而图的**形状判据只有这一份**（⛔ 别两端各拼一份 SVG）。
 *      ⚠️⭐ **`<polyline fill="none">`**（三条硬要求之首）：`polyline` 默认**会填充**，
 *      不写 `fill="none"` 就是一块乱涂的色块 —— 而且**照样渲染、不报错**。
 *      ⚠️ 轨迹**按段画**（`tripSegments`）：切后台断开的两端⛔**不连线**。
 *      ⚠️ 打卡点**一个都不抽掉**（`tripSimplify` 保证），画成小圆 ＋ 名字（超 6 字截断）。
 *      ⚠️ 颜色只走 `--zx-*` 令牌（⛔ 不写死色值）。
 *
 * @param {Array.<Object>} points - 全部点（含打卡点）
 * @param {Object} [opts] - `{ w, h }` 画布尺寸（用户单位，= `viewBox`）
 * @returns {string} `<svg>…</svg>`；**没有点时回空串**（空态由调用方画，⛔ 不画一张空画布）
 */
export function tripTrackSvg(points, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const w = Number.isFinite(Number(o.w)) ? Number(o.w) : 640;
  const h = Number.isFinite(Number(o.h)) ? Number(o.h) : 360;
  const all = (Array.isArray(points) ? points : []).filter(
    (p) => p && Number.isFinite(strictNum(p.lat)) && Number.isFinite(strictNum(p.lng)),
  );
  if (!all.length) return '';
  // ⭐ 抽稀（≤400）在画面上做，⛔ 不改库、⛔ 不改里程；打卡点永不被抽掉
  const draw = tripSimplify(all, 400);
  const { points: xy } = tripProject(draw, w, h, 18);
  /** 抽稀后的点 ↔ 屏幕坐标：`tripProject` 是 `map` 出来的 ⇒ **下标一一对应** */
  const at = new Map();
  draw.forEach((p, i) => at.set(p, xy[i]));

  const toPoly = (seg) =>
    seg
      .map((p) => at.get(p))
      .filter(Boolean)
      .map((c) => `${c[0]},${c[1]}`)
      .join(' ');

  const tracks = draw.filter((p) => p.kind !== 'checkin');
  const segs = tripSegments(tracks);
  const lines = segs
    .filter((s) => s.length > 1)
    .map(
      (s) =>
        `<polyline class="trip-line-path" fill="none" stroke-linejoin="round" stroke-linecap="round" points="${toPoly(s)}" />`,
    )
    .join('');

  // 起终点：只按**轨迹点**算（打卡点不该被当成「出发地」）
  let ends = '';
  if (tracks.length) {
    const a = at.get(tracks[0]);
    const b = at.get(tracks[tracks.length - 1]);
    if (a) ends += `<circle class="trip-dot-end" cx="${a[0]}" cy="${a[1]}" r="4.5" />`;
    if (b && tracks.length > 1) ends += `<circle class="trip-dot-end" cx="${b[0]}" cy="${b[1]}" r="4.5" />`;
  }

  const marks = draw
    .filter((p) => p.kind === 'checkin')
    .map((p) => {
      const c = at.get(p);
      if (!c) return '';
      const raw = String(p.label || '打卡');
      const name = raw.length > 6 ? `${raw.slice(0, 6)}…` : raw;
      return `<circle class="trip-dot-mark" cx="${c[0]}" cy="${c[1]}" r="3.5" /><text class="trip-dot-text" x="${c[0]}" y="${c[1] - 7}" text-anchor="middle">${escapeText(name)}</text>`;
    })
    .join('');

  return `<svg class="trip-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="这次走过的轨迹">
      ${lines}${ends}${marks}
    </svg>`;
}

/**
 * 功能：把一段文本转义成可以安全放进 SVG `<text>` 的样子。
 *
 * 说明：⚠️ 本文件**不 import `core/dom.js` 的 `esc()`** —— 那一份还转义引号与反引号，
 *      而 SVG 文本节点里只需要处理 `& < >`；更重要的是**本文件必须能在 Node 里被直接 import**
 *      （`frontend-modules.test.js` 就是这么干的）⇒ 它一行 import 都不该有。
 *
 * @param {string} s - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 功能：⭐ **等距圆柱投影 + 等比塞进画布** —— 回屏幕坐标（y 已经翻好）与比例尺。
 *
 * 说明：⭐⭐ 三条硬要求全在这里兑现（见文件头）：等比缩放、y 轴翻、坐标是偶数个（每个点两个数）。
 *      ⚠️ 单点 / 两点重合 / 全部点相同 ⇒ **不除零、不 NaN**（画在画布正中）。
 *
 * @param {Array.<Object>} points - 点数组
 * @param {number} w - 画布宽（用户单位，= `viewBox` 的宽）
 * @param {number} h - 画布高
 * @param {number} [pad] - 四边留白（默认 12），避免起终点圆点被裁掉一半
 * @returns {{points: Array.<Array.<number>>, scaleKm: number}} 屏幕坐标数组（`[x, y]`）与**每像素多少公里**
 */
export function tripProject(points, w, h, pad = 12) {
  // ⚠️ 用 `strictNum`：`Number(null) === 0` 会被当成「赤道上的一个点」（见 `strictNum` 的说明）
  const list = (Array.isArray(points) ? points : []).filter(
    (p) => p && Number.isFinite(strictNum(p.lat)) && Number.isFinite(strictNum(p.lng)),
  );
  const width = Number(w) || 0;
  const height = Number(h) || 0;
  const p = Number.isFinite(Number(pad)) ? Number(pad) : 12;
  const innerW = Math.max(1, width - p * 2);
  const innerH = Math.max(1, height - p * 2);
  if (!list.length) return { points: [], scaleKm: 0 };

  let latMin = Infinity;
  let latMax = -Infinity;
  let lngMin = Infinity;
  let lngMax = -Infinity;
  for (const it of list) {
    const la = strictNum(it.lat);
    const ln = strictNum(it.lng);
    if (la < latMin) latMin = la;
    if (la > latMax) latMax = la;
    if (ln < lngMin) lngMin = ln;
    if (ln > lngMax) lngMax = ln;
  }
  const latMid = (latMin + latMax) / 2;
  // ⚠️⭐ `cos φ₁` 不能省（φ₁ = 包围盒平均纬度）：省掉它东西向会被拉伸约 15%，且看不出来
  const kx = Math.cos((latMid * Math.PI) / 180);
  const dx = Math.max(1e-9, (lngMax - lngMin) * kx);
  const dy = Math.max(1e-9, latMax - latMin);
  const k = Math.max(1e-9, Math.min(innerW / dx, innerH / dy));

  // 等比缩放（同一个 k 用在两轴）+ 居中 + y 翻转
  const drawW = dx * k;
  const drawH = dy * k;
  const offX = p + (innerW - drawW) / 2;
  const offY = p + (innerH - drawH) / 2;
  const out = list.map((it) => {
    // x 用「经度 × cos φ₁」（等距圆柱），y 用纬度 —— 再翻成屏幕坐标（北在上）
    const x = offX + (strictNum(it.lng) - lngMin) * kx * k;
    const y = offY + (latMax - strictNum(it.lat)) * k;
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  });
  // 每像素多少公里：一个像素 = 1/k 度纬度 = KM_PER_DEG/k 公里
  const scaleKm = KM_PER_DEG / k;
  return { points: out, scaleKm };
}
