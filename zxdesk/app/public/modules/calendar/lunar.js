'use strict';
/**
 * modules/calendar/lunar.js —— 农历换算与节日查表（0.7.6，纯函数、零依赖）
 *
 * 功能：把公历日期换成农历（年 / 月 / 日 / 是否闰月），并给出「这一天是什么节日」。
 *      日历的月视图用它往格子里写「农历 / 节日」那一行。
 *
 * ⭐ **为什么自己写**：项目**零依赖**（铁律 1 / 5 —— `Project/fnos/zxdesk/` 内不许出现第三方库），
 *    而农历是一张**固定压缩表**，不需要任何运行时、也不需要构建链。
 *
 * ⭐ **数据来源**：1900–2100 农历压缩表（每年一个整数）——
 *    · 低 12 位依次标记「正月…腊月」这 12 个朔望月是大月（30 天）还是小月（29 天）；
 *    · `0x10000` 那一位标记闰月是大月还是小月；
 *    · 最低 4 位存**闰月的月份**（0 = 这一年没有闰月）。
 *    这是公开的权威压缩数据（各地农历库共用同一张），本文件只做**纯查表 + 算术**，
 *    ⛔ 不含任何近似公式或经验修正。
 *
 * ⚠️ **验证方式**（`ttt/test/calendar.test.js` 钉成断言）：用几个**已知日期**反查 ——
 *    2026-02-17 = 正月初一（春节）、2026-06-19 = 五月初五（端午）、2026-09-25 = 八月十五（中秋），
 *    再覆盖闰月年（2025 闰六月、2023 闰二月）。这几条覆盖了「春节」「闰月」「大月 / 小月」三种边界。
 *
 * ⚠️ 本文件只被 `modules/calendar/*` 用（日历是唯一的消费方）。将来若课表 / 看板也要用，
 *    再上移到 `core/`—— 现在上移等于白造一层。
 *
 * @author zx
 * @date   2026-09-19
 * @since 0.7.6
 * 相关：docs/公共/架构文档/22-日历.md、core/holidays.js（**法定节假日数据**是另一回事）
 */

/**
 * 农历年数据表（下标 = 年份 - 1900，覆盖 1900–2100 共 201 项）。
 * @type {number[]}
 */
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

/** 农历日名（下标 = 日期 - 1） @type {string[]} */
const DAY_CN = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

/** 农历月名（与上面的「月」字拼成「正月」「八月」「冬月」「腊月」） @type {string[]} */
const MON_CN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];

/** 公历固定节日（`MM-DD` → 名称）—— ⛔ 只许查表，不许在渲染代码里写 if @type {Object.<string,string>} */
const SOLAR_FESTIVALS = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '03-12': '植树节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
};

/** 农历节日（`月-日` → 名称）；**闰月不算**（闰五月初五不是端午） @type {Object.<string,string>} */
const LUNAR_FESTIVALS = {
  '1-1': '春节',
  '1-15': '元宵节',
  '2-2': '龙抬头',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
};

/** 表覆盖的年份区间（含端点） @type {number} */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/** `1900-01-31` 是农历 1900 年正月初一 —— 换算的基准点（UTC 毫秒） */
const BASE_MS = Date.UTC(1900, 0, 31);

/**
 * 功能：取某一农历年的**闰月月份**（0 = 这一年没有闰月）。
 * @param {number} y - 农历年
 * @returns {number} 闰月月份（1~12），没有闰月时是 0
 */
function leapMonthOf(y) {
  return LUNAR_INFO[y - MIN_YEAR] & 0xf;
}

/**
 * 功能：取某一农历年**闰月的天数**（没有闰月时是 0）。
 * @param {number} y - 农历年
 * @returns {number} 29 / 30，没有闰月时是 0
 */
function leapDaysOf(y) {
  if (!leapMonthOf(y)) return 0;
  return LUNAR_INFO[y - MIN_YEAR] & 0x10000 ? 30 : 29;
}

/**
 * 功能：取某一农历年**某个平月的天数**。
 * @param {number} y - 农历年
 * @param {number} m - 月份（1~12，**不含闰月**）
 * @returns {number} 29 / 30
 */
function daysOfMonth(y, m) {
  return LUNAR_INFO[y - MIN_YEAR] & (0x10000 >> m) ? 30 : 29;
}

/**
 * 功能：取某一农历年**全年天数**（12 个平月 + 可能的闰月）。
 * @param {number} y - 农历年
 * @returns {number} 353~385
 */
function daysOfYear(y) {
  let sum = 348; // 12 × 29
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += LUNAR_INFO[y - MIN_YEAR] & i ? 1 : 0;
  return sum + leapDaysOf(y);
}

/**
 * 功能：把公历日期（`YYYY-MM-DD`）换成农历 —— ⭐ 本模块的**唯一**换算入口。
 *
 * 说明：⚠️ 用 `Date.UTC` 而不是本地时间构造：这条换算只做「相差多少天」的算术，
 *      一旦掺进本机时区（夏令时 / UTC+8 的午夜边界），同一天在会算出不同结果。
 *      ⚠️ 表外的年份（<1900 / >2100）**如实返回 `null`**，⛔ 不许拿边界年份的数据硬套
 *      （没收录的就不算，别静默按旧的算）。
 *
 * @param {string} dateStr - 公历日期（`YYYY-MM-DD`）
 * @returns {?{year: number, month: number, day: number, leap: boolean, monthName: string, dayName: string}}
 *          农历四项 + 两个现成的名字；超出表范围时是 `null`
 */
export function solarToLunar(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr == null ? '' : dateStr));
  if (!m) return null;
  const y = Number(m[1]);
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  let offset = Math.round((Date.UTC(y, Number(m[2]) - 1, Number(m[3])) - BASE_MS) / 86400000);

  // ① 先减掉整年，定位到农历年
  let i = MIN_YEAR;
  let span = 0;
  for (; i <= MAX_YEAR && offset > 0; i++) {
    span = daysOfYear(i);
    offset -= span;
  }
  if (offset < 0) {
    offset += span;
    i--;
  }
  const ly = i;

  // ② 再减掉整月，定位到农历月（闰月插在 `leapMonthOf(ly)` 之后）
  const leap = leapMonthOf(ly);
  let isLeap = false;
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leap > 0 && i === leap + 1 && !isLeap) {
      --i;
      isLeap = true;
      span = leapDaysOf(ly);
    } else {
      span = daysOfMonth(ly, i);
    }
    if (isLeap && i === leap + 1) isLeap = false;
    offset -= span;
  }
  // 恰好落在闰月起始那一天：上一轮循环多减了一次，退回去
  if (offset === 0 && leap > 0 && i === leap + 1) {
    if (isLeap) isLeap = false;
    else {
      isLeap = true;
      --i;
    }
  }
  if (offset < 0) {
    offset += span;
    --i;
  }
  const lm = i;
  const ld = offset + 1;
  return {
    year: ly,
    month: lm,
    day: ld,
    leap: isLeap,
    monthName: `${isLeap ? '闰' : ''}${MON_CN[lm - 1]}月`,
    dayName: DAY_CN[ld - 1],
  };
}

/**
 * 功能：取这一天是**什么节日**（没有就返回空串）—— 公历节日优先，其次农历节日。
 *
 * 说明：⭐ 除夕要单独算：它是「腊月的最后一天」（腊月可能是廿九或三十），
 *      表里查不出来，只能按当年的腊月天数推。
 *      ⚠️ 闰月里的同一个日子**不算节日**（闰五月初五不是端午）。
 *      ⚠️ 只认表里的日子 —— 表外的年份（`solarToLunar` 返回 null）只可能命中公历节日。
 *
 * @param {string} dateStr - 公历日期（`YYYY-MM-DD`）
 * @returns {string} 节日名（如「中秋节」），没有时是空串
 */
export function festivalOf(dateStr) {
  const s = String(dateStr == null ? '' : dateStr);
  const solar = SOLAR_FESTIVALS[s.slice(5)];
  if (solar) return solar;
  const l = solarToLunar(s);
  if (!l || l.leap) return l ? '' : '';
  if (l.month === 12 && l.day === daysOfMonth(l.year, 12)) return '除夕';
  return LUNAR_FESTIVALS[`${l.month}-${l.day}`] || '';
}

/**
 * 功能：算月视图格子**该显示的那一句**农历文字 —— ⭐ 优先级只在这里定一份。
 *
 * 规则（高 → 低）：**节日名** > **农历初一显示月名**（如「八月」）> **农历日**（如「廿八」）。
 * 说明：⚠️ 这是**桌面端**的规则（格子宽，放得下一个词）。手机端格子更小，只显示节日名
 *      （见 `modules/calendar/mobile.js` 的说明）—— 那边不再走这个函数，而是直接问 `festivalOf()`。
 *      ⚠️ 表外年份（1900 前 / 2100 后）返回空串：格子上那一行**留空**，⛔ 不显示假数据。
 *
 * @param {string} dateStr - 公历日期（`YYYY-MM-DD`）
 * @returns {string} 一句农历文字（可能为空串）
 */
export function gridLunarText(dateStr) {
  const f = festivalOf(dateStr);
  if (f) return f;
  const l = solarToLunar(dateStr);
  if (!l) return '';
  if (l.day === 1) return l.monthName;
  return l.dayName;
}
