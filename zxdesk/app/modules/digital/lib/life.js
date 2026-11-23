/**
 * modules/hardware/lib/life.js —— NAS硬件管理的**寿命与保修推算**（纯函数层）
 *
 * 功能：把一条 `hardware_items` 行 + 一个「今天」换算成界面上要显示的那几个数 ——
 * 已用多少个月、离用户设定的预期寿命还有多久、保修还剩多少、该不该提醒。
 * **不碰数据库、不碰 HTTP、不看时钟**（今天由调用方传进来，所以能对着固定日期写测试向量）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-NAS硬件管理.md、docs/公共/开发方案/04-NAS硬件管理-1期.md
 */
'use strict';

/**
 * 「快了」的阈值：已用时间达到预期寿命的 **80%** 就算「临近」。
 *
 */
const SOON_RATIO = 0.8;

/**
 * 保修「快了」的阈值：离到期 **30 天**以内算「临近」。
 *
 */
const WARRANTY_SOON_DAYS = 30;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 功能：把 `YYYY-MM-DD` 的日期文本换算成**序日**（1970-01-01 起的天数），用于纯天数差。
 *
 * 说明：⚠️ 与 `timetable/date-util.js` 的同名函数**故意各写一份**：那个只挡「月 > 12 / 日 > 31」，
 * 所以这里再做一次回读比对（构造出来的年月日必须与输入逐字一致），
 * 非法日期一律返回 `null` → 上层 `known = false`（宁可不显示，也不给一个错的天数）。
 */
function ordinal(dateStr) {
  const m = String(dateStr == null ? '' : dateStr).match(DATE_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(t / 86400000);
}

/**
 * 功能：取某年某月一共有多少天（用于「月末对齐」—— 1/31 加一个月应该是 2/28 而不是 3/2）。
 * @param {number} y - 年
 * @param {number} mo - 月（1..12）
 * @returns {number} 该月天数
 */
function daysInMonth(y, mo) {
  // `Date.UTC(y, mo, 0)` = 下个月的第 0 天 = 这个月的最后一天
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * 功能：把一个日期往后推 N 个月，**月末自动对齐**（不足则取该月最后一天）。
 *
 * 说明：这是「预期寿命」的分母侧 —— 用户填「60 个月」，那么到期日就是购买日 + 60 个月：
 *
 * @param {string} dateStr - 起始日期 `YYYY-MM-DD`
 */
function addMonths(dateStr, months) {
  const m = String(dateStr == null ? '' : dateStr).match(DATE_RE);
  if (!m || ordinal(dateStr) === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const total = y * 12 + (mo - 1) + Math.trunc(months);
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  const p = (n) => String(n).padStart(2, '0');
  return `${ny}-${p(nm)}-${p(nd)}`;
}

/**
 * 功能：算两个日期之间**整月数**（不足一个月不算，`to` 早于 `from` 时为负）。
 *
 *
 * @param {string} from - 起始日期 `YYYY-MM-DD`
 * @param {string} to - 结束日期 `YYYY-MM-DD`
 */
function monthsBetween(from, to) {
  const mf = String(from == null ? '' : from).match(DATE_RE);
  const mt = String(to == null ? '' : to).match(DATE_RE);
  if (!mf || !mt || ordinal(from) === null || ordinal(to) === null) return null;
  const months =
    (Number(mt[1]) - Number(mf[1])) * 12 + (Number(mt[2]) - Number(mf[2])) + (Number(mt[3]) < Number(mf[3]) ? -1 : 0);
  return months;
}

/**
 * 功能：把月数写成中文的「N 年 M 个月」。
 *
 * 说明：⚠️ 这里**只写年月，不写天数** —— 精度就是「月」，写成「3 年 2 个月零 5 天」是在
 * 假装自己知道得比实际更多（预期寿命本来就是用户估的）。
 *
 */
function usedText(months) {
  const m = Math.max(0, Math.trunc(Number(months) || 0));
  if (m <= 0) return '不到 1 个月';
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (y && r) return `${y} 年 ${r} 个月`;
  if (y) return `${y} 年`;
  return `${m} 个月`;
}

/**
 * 功能：把月数写成**短格式** —— 满一年写「N 年 / N.N 年」，不满一年写「N 个月」。
 *
 * 如：使用 2 个月/3 年、使用 2.8 年/3 年」。
 * 与 `usedText()` 的分工：`usedText` 是**长格式**（「3 年 2 个月」）用于详情弹窗，
 * 这里是列表那一行要的短格式 —— 一行里放不下「3 年 2 个月」这种写法。
 */
function shortSpan(months) {
  const m = Math.max(0, Math.trunc(Number(months) || 0));
  if (m < 12) return `${m} 个月`;
  const y = m / 12;
  return `${Number.isInteger(y) ? y : y.toFixed(1)} 年`;
}

/**
 * 功能：拼出列表上那句「使用 xxxx/xxxx」—— 已用多久 / 你设的预期寿命。
 *
 * 说明：⚠️ 「你设的」这四个字在**详情**里仍然必须出现（端到端的红线 3：预期寿命是用户自己填的
 * 经验值），但它太长，塞不进列表那一行 —— 所以列表只给两个数，详情里另有完整说法。
 * 两端都用它（服务端算好给前端）：同一份数据在电脑版与手机版**必须**是同一句话。
 */
function lifeShortText(usedMonths, expectMonths) {
  return `使用${shortSpan(usedMonths)}/${shortSpan(expectMonths)}`;
}

/**
 * 功能：算保修状态。
 *
 * 说明：判据只有「离到期还有几天」这一件事 —— 与寿命完全是两个口径，所以它**不受
 * `expected_life_months` 影响**，也不受「算不算得出寿命」影响（没填寿命也照样提醒保修）。
 *
 */
function warrantyOf(until, todayStr) {
  const a = ordinal(until);
  const t = ordinal(todayStr);
  if (a === null || t === null) return 'none';
  const d = a - t;
  if (d < 0) return 'over';
  if (d <= WARRANTY_SOON_DAYS) return 'soon';
  return 'ok';
}

/**
 * 功能：算一条硬件记录的寿命与保修口径 —— 界面要显示的那几个数全在这里。
 *
 * 说明：⭐ `known = false` 时**只**给 `'—'` 与 `level = 'unknown'`，`percent` 为 null：
 * 界面据此**不画任何进度条**（画一条 0% 的灰条会被读成「全新」，
 * 画一条 100% 的满条会被读成「该换了」，两种都是编数据）。
 */
function lifeOf(row, todayStr) {
  const r = row || {};
  const warranty = warrantyOf(r.warranty_until, todayStr);

  const start = ordinal(r.purchase_date);
  const t = ordinal(todayStr);
  const months = Number(r.expected_life_months);
  const monthsOk = Number.isInteger(months) && months >= 1 && months <= 600;
  const dueDate = start === null || !monthsOk ? null : addMonths(r.purchase_date, months);
  const due = ordinal(dueDate);

  if (start === null || t === null || !monthsOk || due === null) {
    return {
      known: false,
      usedMonths: null,
      percent: null,
      level: 'unknown',
      warranty,
      usedText: '—',
      remainText: '—',
      expectedText: '—',
      shortText: '—',
      dueDate: null,
    };
  }

  const totalDays = due - start;
  const usedDays = t - start;
  // 分母为 0 只可能在「预期寿命 0 个月」时出现，而 1..600 的区间已经把它挡掉了；
  // 这里仍然留一道保险，避免除零得到一个 Infinity 画进进度条。
  const percent = totalDays > 0 ? Math.max(0, usedDays / totalDays) : 1;
  // 档位判据写成**整数比较** `usedDays * 5 >= totalDays * 4`（= 已用 ≥ 80%），
  // 而不是 `usedDays / totalDays >= 0.8`：浮点的 0.8 不精确，会产生
  // `3040 * 0.8 === 2432.0000000000005` 这种结果 —— 于是「正好 80%」这一天
  const level = t > due ? 'over' : usedDays * 5 >= totalDays * 4 ? 'soon' : 'ok';
  const left = monthsBetween(todayStr, dueDate);

  let remainText;
  if (level === 'over') {
    // 「已超期 不到 1 个月」读起来像病句：刚过几天时改说人话
    const over = Math.abs(left || 0);
    remainText = over === 0 ? '刚过你设的期限' : `已超期 ${usedText(over)}`;
  } else if (t === due) remainText = '今天到期';
  else remainText = `还剩 ${usedText(left || 0)}`;

  const usedMonths = Math.max(0, monthsBetween(r.purchase_date, todayStr) || 0);
  return {
    known: true,
    usedMonths,
    percent,
    level,
    warranty,
    usedText: usedText(monthsBetween(r.purchase_date, todayStr) || 0),
    remainText,
    // 「你设的 N 年 M 个月」也由服务端算好给前端 —— 两端界面**共用一个格式化**，
    // 免得电脑版写「5 年」、手机版写「60 个月」这种同一份数据两种说法。
    expectedText: usedText(months),
    // 列表那一行要的短格式「使用2.8年/3年」，同理只此一份
    shortText: lifeShortText(usedMonths, months),
    // 「按剩余寿命排序」要的**剩余月数**（`remainText` 是给人看的，排序要数字）
    remainMonths: left === null ? null : left,
    dueDate,
  };
}

module.exports = {
  SOON_RATIO,
  WARRANTY_SOON_DAYS,
  ordinal,
  addMonths,
  monthsBetween,
  usedText,
  shortSpan,
  lifeShortText,
  warrantyOf,
  lifeOf,
};
