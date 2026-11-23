/**
 * core/recur.js —— 周期任务的**期展开**与状态
 *
 * 功能：把 `recur_rule`（服务端存的规范化 JSON 字符串）解析成规则，并回答两类问题：
 * `periodOf(task, date)` —— **这一天该做的是哪一期**（四象限 / 日期条 / 日历都问它）；
 * `periodsBetween(task, from, to)` —— 某个区间里有哪些期（甘特打勾、数欠账问它）；
 * 另有 `cycleState(task, today)` —— 「整个周期结束了没有」（到结束日**自动算已完成**）。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/34-任务与随手记优化.md
 */

// 只借 `mondayOf()` / `addDays()` 推期：weekly 的 slot 坐标（`1 = 周一`）与
// `core/dashboard.js` 的 `weekdayNo()` 同一套，用「周一起点 + 偏移」表达即可，
// 本文件不需要再算一次「今天周几」（那是**编辑器**回填「勾了周几」时才用到的判据）。
import { addDays, mondayOf } from './date.js';

/** 三种频率（与服务端 `RECUR_FREQS` 一一对应） @type {Array.<string>} */
const FREQS = ['daily', 'weekly', 'monthly'];

/**
 * 功能：把 `recur_rule` 解析成规则对象；不是一条能用的规则时回 `null`。
 *
 * 说明：⚠️ 服务端存的是**字符串**，但调用方（表单回填 / 手搓的测试对象）也可能直接给对象 ⇒
 * 两种都认。**认不出来就回 `null`**（界面按「不是周期任务」处理），⛔ 绝不抛错 ——
 * 一条坏规则不该让整屏白掉（服务端已经在校验时拦过一次了）。
 */
export function parseRule(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try {
      o = JSON.parse(s);
    } catch (_e) {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const freq = String(o.freq || '');
  if (!FREQS.includes(freq)) return null;
  if (freq === 'daily') return { freq: 'daily', slots: [] };
  if (!Array.isArray(o.slots) || !o.slots.length) return null;
  const slots = [];
  for (const s of o.slots) {
    if (!Array.isArray(s) || s.length !== 2) return null;
    const a = Number(s[0]);
    const b = Number(s[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || a > b) return null;
    slots.push([a, b]);
  }
  return { freq, slots };
}

/** 周几的中文名（下标 1 = 周一；与 `parseRule` 的 weekly 坐标系一一对应） */
const WEEK_CN = ['', '一', '二', '三', '四', '五', '六', '日'];

/**
 *
 * （一句话两处拼必然漂移，而且用户看不出来）。
 */
export function ruleText(raw) {
  const r = parseRule(raw);
  if (!r) return '';
  if (r.freq === 'daily') return '每天';
  const weekly = r.freq === 'weekly';
  const parts = r.slots.map(([a, b]) =>
    weekly
      ? a === b
        ? `周${WEEK_CN[a]}`
        : `周${WEEK_CN[a]}~周${WEEK_CN[b]}`
      : a === b
        ? `${a} 号`
        : `${a}~${b} 号`,
  );
  return weekly ? `每${parts.join('、')}` : `每月 ${parts.join('、')}`;
}

/**
 * 功能：求 `YYYY-MM` 这个月有多少天。
 * @param {string} monthStr - `YYYY-MM-01`（或该月任意一天）
 * @returns {number} 该月天数
 */
function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * 功能：把一个月的某一天夹进该月的天数里（`31` 碰上 2 月 ⇒ 28 / 闰年 29）。
 * @param {string} monthStr - 该月的第一天 `YYYY-MM-01`
 * @param {number} dayNo - 规则里的日期号（1~31）
 * @returns {string} 夹好之后的日期 `YYYY-MM-DD`
 */
function clampDay(monthStr, dayNo) {
  const d = Math.min(Math.max(1, dayNo), daysInMonth(monthStr));
  return monthStr.slice(0, 8) + String(d).padStart(2, '0');
}

/**
 * 功能：展开 `[from, to]` 区间里落在这个周期任务范围内的**每一期**。
 *
 * 说明：⭐ 返回的每一项 `{key, start, end}` —— `key` 是本期的**周期起点日期**（与
 * `task_occurrences.period_key` 逐字对应，界面拿它去对「这一期打过卡没有」）。
 * 只展开 `[max(from, 任务起始日), min(to, 任务截止日)]` 这一段：周期任务只活在
 */
export function periodsBetween(task, from, to) {
  const rule = parseRule(task && task.recur_rule);
  if (!rule || !from || !to) return [];
  const cs = (task.start_date || task.due_date || '').slice(0, 10);
  const ce = (task.due_date || task.start_date || '').slice(0, 10);
  if (!cs || !ce) return [];
  const lo = from > cs ? from : cs;
  const hi = to < ce ? to : ce;
  if (hi < lo) return [];
  const out = [];
  if (rule.freq === 'daily') {
    for (let d = lo; d <= hi; d = addDays(d, 1)) out.push({ key: d, start: d, end: d });
    return out;
  }
  if (rule.freq === 'weekly') {
    for (let wk = mondayOf(lo); wk <= mondayOf(hi); wk = addDays(wk, 7)) {
      for (const [a, b] of rule.slots) {
        const start = addDays(wk, a - 1);
        const end = addDays(wk, b - 1);
        if (end < lo || start > hi) continue;
        out.push({ key: start, start, end });
      }
    }
  } else {
    for (let mon = lo.slice(0, 8) + '01'; mon <= hi; mon = addDays(mon, daysInMonth(mon))) {
      for (const [a, b] of rule.slots) {
        const start = clampDay(mon, a);
        const end = clampDay(mon, b);
        if (end < lo || start > hi) continue;
        out.push({ key: start, start, end });
      }
    }
  }
  return out.sort((x, y) => x.start.localeCompare(y.start));
}

/**
 *
 * 四象限的「只显示该日那一期」、手机端日期条的圆点、日历图层全走它
 */
export function periodOf(task, date) {
  if (!task || !date) return null;
  const key = String(date).slice(0, 10);
  return periodsBetween(task, key, key)[0] || null;
}

/**
 * 功能：判断一个周期任务**整个周期是不是已经结束**（到结束日当天就算结束）。
 *
 * **到了整个周期的结束日期 ⇒ 自动算「已完成」**。
 * 它是**纯函数、不写库**（🟦 已定）：判据收在这一处，任何「只读 `status`」的地方
 * 都问它 —— 写库要在「两张表 × 两个后端」各挂一条「顺手 UPDATE」，那是**四条新的写入路径**
 */
export function cycleState(task, today) {
  const isCycle = !!(task && task.task_kind === 'cycle' && parseRule(task.recur_rule));
  const end = (task && task.due_date) || '';
  const ended = !!(isCycle && end && today && end <= today);
  const done = !!(task && task.status === 'done') || ended;
  return { isCycle, ended, done };
}

/**
 * 功能：数一个周期任务**欠了几期的账** —— 到基准日为止，**已经过完、却还没打卡**的那几期。
 *
 * 「周期任务的逾期没有实现」—— 这一条就是它的判据。
 * 「过完」的口径是**期的截止日 `<= 基准日`**（本期还在进行中就不算欠）——
 * 所以它**不是** `periodsElapsed()`（那个数的是「已开始的期」，用来画进度）。
 */
export function missedPeriods(task, ticked, today, nowMs) {
  if (!task || !today) return [];
  const done = new Set(
    (Array.isArray(ticked) ? ticked : []).map((x) => String((x && x.period_key) || x || '')),
  );
  const end = (task.due_date || task.start_date || '').slice(0, 10);
  const stop = end && end < today ? end : today;
  return periodsBetween(task, (task.start_date || '').slice(0, 10), stop).filter((p) => {
    if (done.has(String(p.key))) return false;
    // ① 早就过完的期 ⇒ 欠
    if (p.end < today) return true;
    // ② 还没到的期 ⇒ 不欠
    if (p.end > today) return false;
    // 追加（「加吧」）：本期**带时间窗**时，光比日期不够 ——
    // 窗口 21:09~22:09 的那一期，今天 14:09 时窗口还没开始，23:00 之后才算真的过完。
    // ⇒ 这时要看「现在的时刻」有没有越过窗口的**结束时刻**：越过了才算欠。
    if (!task.start_time && !task.due_time) return false;
    const now = new Date(Number(nowMs));
    if (!Number.isFinite(now.getTime())) return false;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    // 结束时刻缺省 = 23:59（与 `core/task.js` 的 `windowState()` 同一条缺省口径；
    // 这里不 import 它 —— 那两个文件互相 import 会成环）。
    const endMin = hmToMin(task.due_time);
    return nowMin > (endMin == null ? 23 * 60 + 59 : endMin);
  });
}

/**
 * 功能：把 `HH:MM` 折成「当天第几分钟」；认不出来（空 / 缺零 / 越界）时返回 `null`。
 * 说明：⚠️ 与 `core/task.js` 里那份同口径（`windowState()` 的缺省同样是「开始 00:00 / 截止 23:59」）——
 * 刻意各留一份：那两个文件互相 import 会成环（`task.js` 已经从本文件拿 `parseRule` 那一批）。
 * @param {string} hm - `HH:MM`
 * @returns {?number} 分钟数；认不出来时 null
 */
function hmToMin(hm) {
  const m = String(hm == null ? '' : hm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 功能：算一个周期任务的**打卡进度**（整段周期）：已打卡几期 / 一共几期。
 *
 * 「周期任务的详情要显示：打卡 x 天 / 共 x 天，任务条上也要显示」。
 * 理由：「每天」的任务说「期」是绕的，而「每周三一次」说「天」是错的。
 * **分母是整段周期**（不是当前这一屏那 7 天）—— 用户问的是「这个周期我完成了多少」，
 */
export function tickProgress(task, ticked) {
  const rule = parseRule(task && task.recur_rule);
  if (!rule || !(task && task.task_kind === 'cycle')) return { done: 0, total: 0, unit: '', text: '' };
  const all = periodsBetween(task, (task.start_date || '').slice(0, 10), (task.due_date || '').slice(0, 10));
  const done = new Set(
    (Array.isArray(ticked) ? ticked : []).map((x) => String((x && x.period_key) || x || '')),
  );
  const ok = all.filter((p) => done.has(String(p.key))).length;
  const unit = rule.freq === 'daily' ? '天' : '期';
  return { done: ok, total: all.length, unit, text: `打卡 ${ok} / 共 ${all.length} ${unit}` };
}

/**
 * 功能：数一个周期任务**欠了几期的账** —— 在 `[任务起始日, 基准日]` 之间、**已经过完**的期。
 *
 * 说明：⚠️ 它**不查打卡记录**（那是数据层的事）⇒ 回的是「到基准日为止一共有几期过完了」，
 * 界面拿它减「已打卡的期数」才是欠账。拆成两步是刻意的：这样这个纯函数不依赖任何数据。
 *
 */
export function periodsElapsed(task, today) {
  const end = (task && task.due_date) || '';
  const stop = end && end < today ? end : today;
  return periodsBetween(task, (task && task.start_date) || '', stop).length;
}
