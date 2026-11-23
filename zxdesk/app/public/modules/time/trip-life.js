'use strict';
/**
 * modules/calendar/life.js —— 「人生日历」的口径
 * 功能：把「出生日期 ＋ 预期寿命 ＋ 今天」这三个数算成一张**格子图**所需的全部坐标 ——
 * 总格数 / 已过格数 / 今天落在哪一格 / 每格的日期区间。日历那一屏的第二个视图用它。
 * @author zx
 * @date   2026-09-19
 * @since 0.9.7
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/开发方案/19-日历2期-人生日历.md
 */

/**
 * 一格 = 一周（7 天）—— 电脑端周格的格宽。
 * @type {number}
 */
export const WEEK_DAYS = 7;

/**
 *
 * 说明：80 年真实约 4174 周，而 80 × 52 = 4160，差 14 周（0.3%）。选 52 的理由是
 */
export const YEAR_WEEKS = 52;

/**
 * 功能：公历 `(年, 月, 日)` → **日序**（1970-01-01 为 0）—— Howard Hinnant 的 `days_from_civil`。
 *
 * 说明：⚠️ **纯整数运算，一个 `Date` 都不构造**（见文件头：本文件的「今天」只能由调用方传进来，
 * 连「读本机时钟」的入口都不留）。数值与 `core/timetable/date-util.js` 的 `dateOrdinal()`
 * （那个走 `Date.UTC`）**逐日等价** —— 测试里用「生日 2/29」「跨年」等样本对拍过。
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
 * 另一个走别处，迟早在某个闰年边界上对不上，而表现是「格子画出来的日期差了几天」。
 *
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
 * （`routes.js` 的 `checkDate()` 用回环校验挡住它）—— 两处都做一遍就成了两份口径。
 *
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
 * 日期推进**一律走日序** ⇒ 生日是 2 月 29 日也不受影响（周格天然安全：加的是天数，
 * 不是「加一个月」那种会撞上闰年的写法）。
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
 * **「第 i 格的终点 ≤ 今天」**，于是**今天所在的那一格不算已过**，它单独高亮。
 * 把正在进行的那一格算成「已过」会虚报 1 格，而用户会拿它当准数。
 * 收敛成一句：`passed = floor((今天 - 出生日 + 1) / 7)`，再按 `total` 截顶
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
