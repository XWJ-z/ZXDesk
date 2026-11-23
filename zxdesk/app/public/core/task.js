/**
 * core/task.js —— 任务语义（两端唯一一份）
 *
 * 功能：任务在时间轴上的共用语义 —— `doneInfo()` 求完成信息、`visEnd()` 求可见终点、
 * `activeOn()` 判断某天是否可见；另有四象限排序权重 `quadRank()` 与
 * 按截止日排序的比较器 `byDueAsc()`。
 * 修订：原先还有一个 `cap()`（截断数组），手机端撤掉「逾期未完成」那一段之后
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { parseRule, periodOf, periodsBetween } from './recur.js';

/**
 * `completed_at` 是「YYYY-MM-DD HH:mm:ss」时间戳，取前 10 位就是完成日；
 * 老数据缺它时按截止日期推定，并用 `approx: true` 标记。
 */
export function doneInfo(t) {
  if (t.status !== 'done') return null;
  const c = t.completed_at ? String(t.completed_at).slice(0, 10) : '';
  if (c) return { date: c, approx: false };
  return t.due_date ? { date: t.due_date, approx: true } : null;
}

/**
 * 功能：求任务的「可见终点」—— 截止日期只是**期限**，不是「这件事要到那天才结束」。
 *
 * 改成**三段式**，`today` **必须是入参**
 * （与 `dashTierOf(x, today)` 同一条约定：基准日从外面进来，测试才固定得住）。
 *
 */
export function visEnd(t, s, today) {
  const e = t.due_date;
  const d = doneInfo(t);
  if (d) {
    // 已完成：止于**完成日**（含老数据的 approx 分支）；完成日早于起始日 ⇒ 退回首日
    return s && d.date < s ? s : d.date;
  }
  // 未完成但已过理论截止日 ⇒ 逾期**顺延**到今天（明天再顺延一天）
  // 周期任务是个例外：`due_date` 是**整个周期的结束日**，过了它就是「这一轮做完了」
  // （`recur.js` 的 `cycleState()` 判它自动算完成）⇒ **不顺延**；它的账按**每一期**各算
  if (e && today && e < today) return t.task_kind === 'cycle' ? e : today;
  return e;
}

/**
 * 功能：判断某条任务在指定日期是否落在它的可见区间内。
 * 说明：区间两端取 `start_date || due_date` 与 `visEnd()`，闭区间，按字符串字典序比较。
 * `visEnd()` 多了一个 `today` 入参 ⇒ 这里也要透传
 * （漏传的表现是**逾期未完成的任务在日期条上不顺延**，而且不报错）。
 * @param {Object} t - 任务对象
 */
export function activeOn(t, date, today) {
  // **周期任务按期算可见性** —— 它只在该做那一期的那几天里露面
  // （四象限的「只显示该日那一期」、手机端日期条的圆点、日历图层全走这条）。
  // 规则解析不出来时**回落到区间判据**（宁可「整段都显示」，也不要整条任务消失不见）。
  if (t && t.task_kind === 'cycle' && parseRule(t.recur_rule)) {
    return !!periodOf(t, date);
  }
  const s = t.start_date || t.due_date,
    e = visEnd(t, s, today);
  return !!(s && e && s <= date && date <= e);
}

/**
 * 功能：判断某条任务该不该出现在**任务板选中的那一天**（四象限那一屏的可见判据）。
 *
 * 把 A 也显示了」—— 根因就在下面那第二条的**基准取错了**：它原先写的是
 * `t.due_date < date`（**选中日**），于是「看未来日期」时，凡截止日早于那一天的未完成任务
 * **统统被拉进来** —— 包括**今天还没到期、根本不算逾期**的那些。而「已逾期」那枚标记
 */
export function boardVisibleOn(t, date, today) {
  if (activeOn(t, date, today)) return true;
  // 定的口径：**逾期未完成的并入选中日的象限**（「欠的账在任何区间里都算数」）——
  // 它的可见止是「顺延到今天」，看今天以后的日子时会被区间判据挡掉，所以这一条不能省。
  // 周期任务**不进这条**：它按期显示（`activeOn` 已内含），再并一次会把整个周期结束
  return (
    t.task_kind !== 'cycle' && t.status !== 'done' && !!t.due_date && t.due_date < today && date >= today
  );
}

/**
 *
 * **「现在」是入参**（`nowMs`）—— 与 `visEnd(t, s, today)` 同一条约定：基准时刻从外面进来，
 */
export function windowState(t, nowMs) {
  if (!t) return null;
  if (!t.start_time && !t.due_time) return null;
  if (!Number.isFinite(Number(nowMs))) return null;
  const now = new Date(Number(nowMs));
  const nowMin =
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 60000;
  let sd = t.start_date;
  let ed = t.due_date || sd;
  if (t.task_kind === 'cycle') {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const past = periodsBetween(t, t.start_date || today, today);
    const p = periodOf(t, today) || (past.length ? past[past.length - 1] : null);
    if (p) {
      // 修订（第四轮）：「这里都完成了还剩 23 小时」——
      // 那个时段是**每一期里每一天**的时段（一期 10/2~10/6 ＋ 20:29~21:29 = 每天那个点要做），
      // 所以窗口要取**夹进这一期之后的那一天**的 st~et；
      const day = today < p.start ? p.start : today > p.end ? p.end : today;
      sd = day;
      ed = day;
    }
  }
  if (!sd || !ed) return null;
  const st = t.start_time || '00:00';
  const et = t.due_time || '23:59';
  const startMin = wallClockMinutes(sd, st);
  const endMin = wallClockMinutes(ed, et);
  if (nowMin < startMin) return { phase: 'before', text: `距开始 ${gapText(startMin - nowMin)}` };
  if (nowMin <= endMin) return { phase: 'in', text: `剩 ${gapText(endMin - nowMin)}` };
  return { phase: 'after', text: '已过窗口' };
}

/**
 * 功能：把「日期 + 时刻」折成自 1970 起的**分钟数**（纯天数运算，借 `Date.UTC` 避开时区）。
 * 说明：⚠️ 任务上的时刻是**墙上时间**（没有时区），所以两边一律用同一套「本地字段 → UTC 构造」，
 * 差值才是对的（与 `overdueDays` 里那条时区纪律同源）。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @param {string} timeStr - `HH:MM`
 */
function wallClockMinutes(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0) / 60000;
}

/**
 * 功能：把一段分钟差说成人话（天 → 小时 → 分钟）。
 * @param {number} mins - 分钟差（非负）
 * @returns {string} 例如 `2 天` / `3 小时` / `25 分` / `不到 1 分`
 */
function gapText(mins) {
  const n = Math.max(0, Math.round(mins));
  if (n >= 1440) return `${Math.floor(n / 1440)} 天`;
  if (n >= 60) return `${Math.floor(n / 60)} 小时`;
  if (n >= 1) return `${n} 分`;
  return '不到 1 分';
}

/**
 * 功能：算一条任务**逾期了几天**（`today − 理论截止日`，按自然日差，跨天即算、不按 24 小时）。
 *
 * 新增 —— 四象限与甘特图上那句「逾期 N 天」的唯一出处。
 * 口径钉死：**从理论截止日算**，⛔ 不用 `visEnd()` 顺延后的日期算（那个是「画到哪一天」，
 * 不是「欠了几天」）。已完成的也照算 —— 界面用它写「逾期 N 天后完成」
 */
export function overdueDays(t, today) {
  const due = t && t.due_date;
  if (!due || !today) return 0;
  // 已完成：算「完成日 − 截止日」；未完成：算「今天 − 截止日」
  const d = doneInfo(t);
  const end = d ? d.date : today;
  if (!end || end <= due) return 0;
  return dayDiff(due, end);
}

/**
 * 功能：数两个 `YYYY-MM-DD` 之间差几天（正数表示 `b` 在 `a` 之后）。
 *
 * 说明：⚠️ 借 `Date.UTC` 做纯天数运算，**不把 `Date` 带出本函数**（本项目一贯的时区纪律：
 * 一律用 UTC 构造，避免本地时区把「差一天」算成 0 或 2）。
 *
 */
function dayDiff(a, b) {
  const [y1, m1, d1] = String(a).split('-').map(Number);
  const [y2, m2, d2] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * 功能：算任务的象限权重（**紧急 ×2 + 重要 ×1**），供四象限排序。
 *
 * 改了口径：「紧急且重要 → 紧急 → 重要 → 都不」——
 * **紧急优先**。此前是 `重要×2 + 紧急×1`（艾森豪威尔矩阵的通行口径，重要优先），
 * 要在看板上按紧急优先排，于是这份权重整个掉了个头。
 */
export function quadRank(t) {
  return Number(t.urgent) * 2 + Number(t.important);
}

/**
 * 功能：按截止日期升序比较两条任务，供 `Array#sort` 使用。
 * 说明：直接用 `localeCompare` 比字符串，不转 `Date`（时区坑）；缺 `due_date` 的按空串参与比较。
 * @param {Object} a - 任务 A
 * @param {Object} b - 任务 B
 * @returns {number} 比较器约定的负数 / 0 / 正数
 */
export function byDueAsc(a, b) {
  return String(a.due_date || '').localeCompare(String(b.due_date || ''));
}

