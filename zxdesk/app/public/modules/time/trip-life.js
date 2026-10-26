'use strict';
/**
 * modules/calendar/life.js —— 「人生日历」的口径（0.7.8，· 纯函数、零依赖）
 *
 * 功能：把「出生日期 ＋ 预期寿命 ＋ 今天」这三个数算成一张**格子图**所需的全部坐标 ——
 *      总格数 / 已过格数 / 今天落在哪一格 / 每格的日期区间。日历那一屏的第二个视图用它。
 *
 * ⭐⭐ **本文件是这套口径的唯一出处**（方案 §4.2）：格子里画什么、结论句里写什么，
 *    全部从 `lifeGrid()` 的返回值取 —— ⛔ 界面里不许再算一遍。第二份算错的表现是
 *    「同一个账号、同一个今天，电脑上说 41 格、手机上却说 40 格」，而且**不报任何错**。
 *
 * ⚠️⭐ **「今天」由调用方传进来**（`today` 参数）：—— 日历的「今天」只有一个权威来源
 *    （`GET /api/calendar` 响应里的 `today`）。所以本文件里**绝不出现本机时钟**：
 *    `new Date()` 一次都没有；`Date.UTC` 只用来取一个**纯天数差**，不参与任何展示。
 *    收参数才喂得了假时间 —— `ttt/test/calendar.test.js` 的边界向量就是这么钉的。
 *
 * ⚠️ **零依赖**（铁律 5）：不引日期库、不碰 DOM、不碰网络、不读写任何全局状态。
 *    它是前端 ESM，`public/index.html` 的 `modulepreload` 里登记了它 —— 漏登记 =
 *    「孤岛检查」与 modulepreload 等式都会红（`lunar.js` 踩过同一个坑）。
 *
 * ⚠️⭐ **为什么这里有一份自己的「日序」，而且是纯整数算术**：
 *    · 方案写的是「复用 `core/timetable/date-util.js` 的 `dateOrdinal()`」，但那一份是
 *      **服务端 CJS**（`app/core/` 下、`module.exports`），前端 ESM 物理上取不到；
 *    · 于是本文件自己实现一对互逆函数（`daysFromCivil` / `civilFromDays`，公开的标准算法），
 *      与 `dateOrdinal()` **逐日等价**（测试拿 2/29、跨年、月末这些样本对拍过）。
 *    ⛔ **本文件里一个 `Date` 都不出现**，这是刻意的、不是洁癖：`Date` 一旦在场，迟早有人写
 *    `new Date()` 去读本机时钟 —— 那会让「今天」多出第二个来源，
 *    而这一屏对「今天在哪一格」极其敏感：差一天就画错一格，而且**不报任何错**。
 *    本机时区的加减还会在夏令时边界上凭空差一天。
 *
 * @author zx
 * @date   2026-09-19
 * @since 0.8.13
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/19-日历2期-人生日历.md
 */

/**
 * 一格 = 一周（7 天）—— 电脑端周格的格宽。
 * @type {number}
 */
export const WEEK_DAYS = 7;

/**
 * 一年按 **52 周**算 —— ⭐ **刻意的简化口径，不是算错**（方案 §4.2）。
 *
 * 说明：80 年真实约 4174 周，而 80 × 52 = 4160，差 14 周（0.3%）。选 52 的理由是
 *      **这个数用户能自己验算**（拿计算器敲 80 × 52 = 4160），而 52.18 是伪精确 ——
 *      与「不显示百分比」同一条纪律。
 *      ⛔ 界面上必须写明「按每年 52 周算」，⛔ 不许悄悄改成 52.18 去「修正」它。
 * @type {number}
 */
export const YEAR_WEEKS = 52;

/**
 * 功能：公历 `(年, 月, 日)` → **日序**（1970-01-01 为 0）—— Howard Hinnant 的 `days_from_civil`。
 *
 * 说明：⚠️ **纯整数运算，一个 `Date` 都不构造**（见文件头：本文件的「今天」只能由调用方传进来，
 *      连「读本机时钟」的入口都不留）。数值与 `core/timetable/date-util.js` 的 `dateOrdinal()`
 *      （那个走 `Date.UTC`）**逐日等价** —— 测试里用「生日 2/29」「跨年」等样本对拍过。
 *      这个算法是公开的标准实现（公历 400 年一循环），⛔ 不是近似公式。
 *
 * @param {number} y - 年
 * @param {number} m - 月（1~12）
 * @param {number} d - 日（1~31）
 * @returns {number} 日序
 */
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/**
 * 功能：日序 → `YYYY-MM-DD` —— 上面那个的逆（Howard Hinnant 的 `civil_from_days`）。
 *
 * 说明：⚠️ 同样纯整数运算。正反两个方向用**同一套算法**是刻意的：一个走 `Date.UTC`、
 *      另一个走别处，迟早在某个闰年边界上对不上，而表现是「格子画出来的日期差了几天」。
 *
 * @param {number} ord - 日序
 * @returns {string} 日期文本 `YYYY-MM-DD`
 */
function civilFromDays(ord) {
  const z = ord + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  const p = (n) => String(n).padStart(2, '0');
  return `${m <= 2 ? y + 1 : y}-${p(m)}-${p(d)}`;
}

/**
 * 功能：把 `YYYY-MM-DD` 换成**日序**（1970-01-01 起的天数），用于纯天数差。
 *
 * 说明：⚠️ 只粗卡「月 1~12、日 1~31」：像 `2026-02-30` 这种会被放行，那是**接口层**的事
 *      （`routes.js` 的 `checkDate()` 用回环校验挡住它）—— 两处都做一遍就成了两份口径。
 *
 * @param {string} dateStr - 形如 `2026-09-01` 的日期文本
 * @returns {?number} 日序；格式不匹配或月 / 日越界时为 null
 */
function ordinal(dateStr) {
  const m = String(dateStr == null ? '' : dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return daysFromCivil(y, mo, d);
}

/**
 * 功能：日序 → `YYYY-MM-DD`（算格子的两端要用它）。
 * @param {number} ord - 日序
 * @returns {string} 日期文本 `YYYY-MM-DD`
 */
function dateOf(ord) {
  return civilFromDays(ord);
}

/**
 * 功能：第 `i` 格覆盖的日期区间（**闭区间**，含首尾两天）。
 *
 * 说明：第 0 格 = 出生那天起 7 天；第 i 格的起点 = 出生日往后 i × 7 天，终点是它的前一天。
 *      日期推进**一律走日序** ⇒ 生日是 2 月 29 日也不受影响（周格天然安全：加的是天数，
 *      不是「加一个月」那种会撞上闰年的写法）。
 *
 * @param {string} birthDate - 出生日期 `YYYY-MM-DD`
 * @param {number} i - 第几格（0 起）
 * @returns {?{from: string, to: string}} 区间；出生日期非法时为 null
 */
export function cellRange(birthDate, i) {
  const b = ordinal(birthDate);
  if (b === null) return null;
  const start = b + Number(i) * WEEK_DAYS;
  return { from: dateOf(start), to: dateOf(start + WEEK_DAYS - 1) };
}

/**
 * 功能：一次算齐「人生日历」要用的全部坐标。
 *
 * 说明：⭐⭐ **「已过」只数完全走完的格子**（方案 §4.1）：判据是
 *      **「第 i 格的终点 ≤ 今天」**，于是**今天所在的那一格不算已过**，它单独高亮。
 *      把正在进行的那一格算成「已过」会虚报 1 格，而用户会拿它当准数。
 *      收敛成一句：`passed = floor((今天 - 出生日 + 1) / 7)`，再按 `total` 截顶
 *      （已过完就是 `total`，⛔ 不出现负数、⛔ 不显示「已经超过了 X」这种评判）。
 *
 *      ⚠️ 正常情况下 `todayIndex === passed` —— 今天正好落在**第一个没走完的格子**里。
 *      已过完所有格子时 `todayIndex = -1`（**没有「今天那一格」了**，界面上⛔ 不高亮任何格）。
 *
 *      ⚠️ `expectYears` 为空时**本文件不给默认值**：默认 80 是**显示口径**，
 *      住在界面那一层（方案 §4.2）。这里只认正整数，拿不到就说 `bad_expect` ——
 *      ⛔ 绝不悄悄按 80 算（那会让「我没设过」和「我设了 80」变成同一件事）。
 *
 * @param {?string} birthDate - 出生日期 `YYYY-MM-DD`；空 = 还没填（走空态）
 * @param {?number} expectYears - 预期寿命（年）；空 ⇒ 调用方按 80 传
 * @param {string} today - 服务端的「今天」`YYYY-MM-DD`
 * @returns {{ok: boolean, reason: string, cols: number, rows: number, total: number, passed: number,
 *      todayIndex: number, firstCellDate: ?string, lastCellDate: ?string}} 坐标；
 *      `ok` 为 false 时 `reason` 说明是哪一种算不出（`no_birth` / `bad_birth` /
 *      `bad_expect` / `bad_today`），`ok` 为 true 且 `reason` 为 `before_birth` 时表示
 *      「出生日期填成了将来的日子」（passed 为 0，⛔ 不当成正常的一天）——
 *      ⚠️ 这两种都不是错误，是**要让人看得见的状态**
 */
export function lifeGrid(birthDate, expectYears, today) {
  const y = Number(expectYears);
  const yearsOk = Number.isInteger(y) && y > 0;
  const cols = YEAR_WEEKS;
  /** 出生日期还没填 / 不合法时，总格数无从谈起 ⇒ 一律给 0（界面走空态，不画格子） */
  const blank = {
    ok: false,
    reason: '',
    cols,
    rows: 0,
    total: 0,
    passed: 0,
    todayIndex: -1,
    firstCellDate: null,
    lastCellDate: null,
  };

  // ① 出生日期：还没填 ⇒ 空态（⛔ 不给默认生日）
  if (birthDate === undefined || birthDate === null || String(birthDate).trim() === '') {
    return Object.assign({}, blank, { reason: 'no_birth' });
  }
  // ② 出生日期不是一条能算的日期
  const b = ordinal(birthDate);
  if (b === null) return Object.assign({}, blank, { reason: 'bad_birth' });
  // ③ 预期寿命：只认正整数（空值由界面按 80 传，⛔ 这里不兜）
  if (!yearsOk) return Object.assign({}, blank, { reason: 'bad_expect' });
  // ④ 今天也得是能算的日期（服务端给的，正常不会坏；坏了宁可说不算，也不画一张假图）
  const t = ordinal(today);
  if (t === null) return Object.assign({}, blank, { reason: 'bad_today', rows: y });

  const total = y * YEAR_WEEKS;
  const rows = y;
  const firstCellDate = dateOf(b);
  const lastCellDate = dateOf(b + total * WEEK_DAYS - 1);
  const base = { ok: true, cols, rows, total, passed: 0, todayIndex: -1, firstCellDate, lastCellDate };

  // ⑤ 今天早于出生日期（填错了）—— passed 0，但**说得出来是哪一种**（⛔ 不静默当 0）
  if (t < b) return Object.assign({}, base, { reason: 'before_birth' });

  // ⑥ 正常：已过 = 完全走完的格子数（今天那一格不算）
  const passed = Math.min(Math.floor((t - b + 1) / WEEK_DAYS), total);
  return Object.assign({}, base, {
    reason: '',
    passed,
    // 今天落在第一个没走完的格子里；已过完 ⇒ -1（没有「今天那一格」了）
    todayIndex: passed < total ? passed : -1,
  });
}
