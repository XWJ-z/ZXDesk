/**
 * core/date.js —— 日期工具（两端唯一一份）
 *
 * 功能：以 `YYYY-MM-DD` 字符串为中心的一组日期助手 —— `todayStr()` 取今天、`addDays()` 加减天数、
 *      `dow()` / `weekName()` / `weekdayChar()` 取星期、`isWeekend()` 判周末、`mondayOf()` 求所在周周一，
 *      以及 `fmtShort()` / `fmtLong()` / `fmtDuration()` 三种短格式化。
 *
 * ⚠️ 一律手工解析字符串，**不转 Date 做比较**：`YYYY-MM-DD` 字典序即时序，
 *    而 `new Date(...)` 会带进时区坑（本项目踩过）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.18
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

// ---------- 日期工具 ----------
/**
 * 功能：取本机当前日期，按本地时区拼成 `YYYY-MM-DD`。
 * @returns {string} 今天的日期字符串
 */
export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：在日期字符串上加减天数，返回新的 `YYYY-MM-DD`。
 * 说明：借 `Date` 只做**天数运算与进位**；比较日期时一律走字符串字典序、不转 `Date`（时区坑）。
 * @param {string} dateStr - 起始日期，`YYYY-MM-DD`
 * @param {number} n - 天数偏移，负数表示往前推
 * @returns {string} 偏移后的日期字符串
 */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * 功能：求某天是星期几，返回数字形式。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`
 * @returns {number} 0 为周日、1~6 为周一至周六
 */
export function dow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * 功能：求某天的中文星期名。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`
 * @returns {string} 形如 '周一' / '周日'
 */
export function weekName(dateStr) {
  return '周' + '日一二三四五六'[dow(dateStr)];
}

/**
 * 功能：判断某天是不是周末（周六或周日）。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`
 * @returns {boolean} 周六 / 周日为 true
 */
export function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const w = new Date(y, m - 1, d).getDay();
  return w === 0 || w === 6;
}

/**
 * 功能：求某天所在那一周的周一。
 * 说明：周日归入**上一个**周一（`(getDay()+6)%7` 的口径），比较与偏移仍走字符串。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`
 * @returns {string} 该周周一的日期字符串
 */
export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const off = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0=周一 ... 6=周日
  return addDays(dateStr, -off);
}

/**
 * 功能：把日期压成 `M/D` 短格式，供窄栏位显示。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`；为空时返回空串
 * @returns {string} 形如 '9/11'；未传值时为 ''
 */
export function fmtShort(dateStr) {
  if (!dateStr) return '';
  const p = dateStr.split('-');
  return `${Number(p[1])}/${Number(p[2])}`;
}

/**
 * 功能：把日期压成 `M月D日` 中文短格式。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`；为空时返回空串
 * @returns {string} 形如 '9月11日'；未传值时为 ''
 */
export function fmtLong(dateStr) {
  if (!dateStr) return '';
  const p = dateStr.split('-');
  return `${Number(p[1])}月${Number(p[2])}日`;
}

/**
 * 功能：求某天对应的单个星期汉字，用于只有一位宽度的日期轴。
 * @param {string} dateStr - 日期，`YYYY-MM-DD`
 * @returns {string} '日' / '一' / … / '六'
 */
export function weekdayChar(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}

/**
 * 功能：把「分钟数」写成中文时长（`150` → `2 小时 30 分`）—— 课表「午休 / 晚休」分界行用它。
 *
 * 说明：放在 `core/` 是因为**两端要一模一样**：同一个空档在电脑版写「2 小时 30 分」、
 *      手机版写「150 分钟」会让人以为是两回事。
 *
 * @param {number} m - 分钟数
 * @returns {string} 形如 `45 分钟` / `2 小时` / `2 小时 30 分`
 */
export function fmtDuration(m) {
  const n = Math.max(0, Math.floor(Number(m) || 0));
  if (n < 60) return `${n} 分钟`;
  const h = Math.floor(n / 60);
  const mm = n % 60;
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
}

// ⚠️ 电脑版管它叫 fmtDate、手机版管它叫 fmtLong —— **同一份实现**，两个名字都导出，

//    免得为了统一名字去改几十处调用点（改名是没收益的 churn）。

export { fmtLong as fmtDate };

/**
 * 功能：把服务端时间戳（`YYYY-MM-DD HH:MM:SS`）压成「今天 14:30」这种一眼看得懂的小字。
 *
 * 说明：⭐ 0.8.18 收进 `core/` —— 原先 `modules/idea/` 的**两端各写了一份私有的同名函数**，
 *      而收藏夹的「网址详情」现在也要显示时间。模块之间⛔ **不许互相 import**
 *      （删掉 `modules/idea/` 整目录时收藏夹仍要起得来），所以共用件只能住在 `core/`。
 *      ⚠️ 纯字符串切片，⛔ **不转 `Date`** —— 与本文件其余部分同一条口径（时区坑）。
 *      ⚠️ 判「今天」走 `todayStr()`（同一个 core 里的口径），⛔ 别自己 `new Date()` 拼一次。
 *
 * @param {string} stamp - 服务端时间戳；为空时返回空串
 * @returns {string} 展示用文案（空时间戳回空串）
 */
export function whenText(stamp) {
  const s = String(stamp || '');
  if (!s) return '';
  const d = s.slice(0, 10);
  const hm = s.slice(11, 16);
  if (d === todayStr()) return hm ? `今天 ${hm}` : '今天';
  return hm ? `${d.slice(5)} ${hm}` : d.slice(5);
}
