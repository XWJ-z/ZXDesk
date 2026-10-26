/**
 * core/task.js —— 任务语义（两端唯一一份）
 *
 * 功能：任务在时间轴上的共用语义 —— `doneInfo()` 求完成信息、`visEnd()` 求可见终点、
 *      `activeOn()` 判断某天是否可见；另有四象限排序权重 `quadRank()` 与
 *      按截止日排序的比较器 `byDueAsc()`。
 *      ⚠️ 0.8.14 修订：原先还有一个 `cap()`（截断数组），手机端撤掉「逾期未完成」那一段之后
 *      **再无调用方** ⇒ 一并删掉（⛔ 别当它是别处在用的工具函数）。
 *
 * ⭐ 这几个函数以前在两端各一份，靠「改一处记得改两处」维持一致 ——
 *    `doneInfo` / `visEnd` 决定「已完成的任务还能看见到哪一天」，两边不一致就是
 *    同一个任务在手机上看得到、在电脑上看不到。收成一份是 A1 最实在的收益。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.15
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { parseRule, periodOf, periodsBetween } from './recur.js';

/**
 * 功能：求任务的完成信息 —— 没完成返回 `null`，否则返回 `{ date, approx }`。
 *      `completed_at` 是「YYYY-MM-DD HH:mm:ss」时间戳，取前 10 位就是完成日；
 *      老数据缺它时按截止日期推定，并用 `approx: true` 标记。
 * 说明：`doneInfo` / `visEnd` 决定「已完成任务还能看见到哪一天」，两端必须用同一份实现，
 *      否则会出现同一任务手机看得到、电脑看不到。
 *
 * ⭐ **老数据（已完成但没有 `completed_at`）按截止日期算**：
 *    0.1.2 之前项目任务**压根没有这一列**，日常任务里 0.0.8 之前标记完成的也全是 NULL。
 *    「哪天做完的」库里没有，能当替身的只有 `updated_at` —— 而它**改一次标题就会变**，是错的。
 *    所以用用户自己填的**截止日期**：这条任务本来就以它为终点，语义上最诚实。
 *    `approx: true` 标记它是**推定值**：界面必须与真实记录分开写，
 *    否则一条 9/8~9/15 的老任务在 9/10 看会显示成「已完成 9/15」—— 一个未来的完成日，看着像 bug。
 *    ⚠️ 这一切只发生在**显示与判断**上，**库里一个字节都不写** ——
 *    与 `start_date` 为 NULL 时用 `COALESCE(start_date, due_date)` 推断是同一条规矩。
 *
 * @param {Object} t - 任务对象，读 `status` / `completed_at` / `due_date`
 * @returns {?{ date: string, approx: boolean }} 完成日与「是否为推定值」；未完成时为 null
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
 * ⭐⭐ 0.8.14改成**三段式**，`today` **必须是入参**
 *    （与 `dashTierOf(x, today)` 同一条约定：基准日从外面进来，测试才固定得住）。
 *
 * | 情形                                 | 返回                                                      |
 * | ------------------------------------ | --------------------------------------------------------- |
 * | 已完成                               | ⭐ **完成日**（`doneInfo().date`，**不再要求它落在截止日之前**）；完成日早于起始日时**退回起始日**，免得一天都不出现 |
 * | 未完成 + 有截止 + `due_date < today`  | ⭐ **`today`**（**顺延**到今天；明天再顺延一天，依次往后）  |
 * | 其余                                 | 照旧（未完成 = `due_date`）                                |
 *
 * 「这个任务在到期之前没有完成，就把**完成时间顺延**，只是过了理论
 * 完成时间变为了逾期，因此这个 2 号的任务在 4 号完成了，**完成时间和显示完成的都应该是 4 号**，
 * 而不是现在这样跳转回 2 号显示了。」
 *
 * ⚠️⭐ 它是**两端共用**的纯函数 ⇒ **一处改动**，四象限 / 甘特 / 手机端日期条 / 首页看板 / 日历
 *    全部一致（判据只有一处）。⛔ 别为某一块界面另开一份「只服务它」的判据。
 * ⚠️ 一条**已知且被接受的副作用**：手机端日期条的**圆点会变多** —— 一条逾期一个月的任务，
 *    从它的任务日到今天**每一格都会有圆点**（那条判据就是 `activeOn`）。已拍：
 *    接受（甘特与日期条永远一致；语义上也说得通 —— 它确实每天都还挂在头上）。
 * ⚠️ 顺延**只影响「画到哪一天」**：逾期判定与「逾期 N 天」仍从**理论截止日**算
 *    （`overdueDays()`），首页看板那颗「已逾期」的数、提醒助手每天那条逾期提醒**口径一律不变**。
 * ⚠️ 容错：`today` 没传（老调用点忘了补）时**退回老语义**（不抛错、不顺延）——
 *    这是刻意的失败方向：宁可「那块界面上不顺延」，也不要整页崩掉。
 *
 * @param {Object} t - 任务对象，读 `due_date` 与完成信息
 * @param {string} s - 任务的开始日（调用方按 `start_date || due_date` 给出）
 * @param {string} today - 基准日 `YYYY-MM-DD`（**服务端校准过的「今天」**，见 §五④）
 * @returns {?string} 可见终点日期 `YYYY-MM-DD`；任务没有截止日期时为 null / undefined
 */
export function visEnd(t, s, today) {
  const e = t.due_date;
  const d = doneInfo(t);
  if (d) {
    // 已完成：止于**完成日**（含老数据的 approx 分支）；完成日早于起始日 ⇒ 退回首日
    return s && d.date < s ? s : d.date;
  }
  // 未完成但已过理论截止日 ⇒ 逾期**顺延**到今天（明天再顺延一天）
  // ⚠️ 周期任务是个例外：`due_date` 是**整个周期的结束日**，过了它就是「这一轮做完了」
  //    （`recur.js` 的 `cycleState()` 判它自动算完成）⇒ **不顺延**；它的账按**每一期**各算
  //    （哪一期过了没打卡就是那一期逾期），画在甘特的期标记上，而不是把主条往今天拉。
  if (e && today && e < today) return t.task_kind === 'cycle' ? e : today;
  return e;
}

/**
 * 功能：判断某条任务在指定日期是否落在它的可见区间内。
 * 说明：区间两端取 `start_date || due_date` 与 `visEnd()`，闭区间，按字符串字典序比较。
 * ⚠️ 0.8.14：`visEnd()` 多了一个 `today` 入参 ⇒ 这里也要透传
 *    （漏传的表现是**逾期未完成的任务在日期条上不顺延**，而且不报错）。
 * @param {Object} t - 任务对象
 * @param {string} date - 待判断的日期，`YYYY-MM-DD`
 * @param {string} today - 基准日 `YYYY-MM-DD`
 * @returns {boolean} 落在可见区间内为 true
 */
export function activeOn(t, date, today) {
  // ⭐⭐ 0.8.14：**周期任务按期算可见性** —— 它只在该做那一期的那几天里露面
  //    （四象限的「只显示该日那一期」、手机端日期条的圆点、日历图层全走这条）。
  //    ⚠️ 规则解析不出来时**回落到区间判据**（宁可「整段都显示」，也不要整条任务消失不见）。
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
 * 说明：⭐ 0.8.15 修缺陷（报）：「今天 8 号，任务 A 是 9 号的，我看 10 号的任务
 *      把 A 也显示了」—— 根因就在下面那第二条的**基准取错了**：它原先写的是
 *      `t.due_date < date`（**选中日**），于是「看未来日期」时，凡截止日早于那一天的未完成任务
 *      **统统被拉进来** —— 包括**今天还没到期、根本不算逾期**的那些。而「已逾期」那枚标记
 *      走的是 `overdueDays(t, today)`（按**真实今天**）⇒ 它连红标都没有，看过去就是
 *      「10 号的任务里混进了一条 9 号的」。
 *      ⇒ 基准改成**真实今天**，与两处已定口径对齐：`docs/公共/架构文档/05-任务板.md`
 *      （「**逾期只按真实今天**判断 —— 切到未来日期看板不会把未来的任务误报成逾期」）
 *      与首页看板的 `core/dashboard.js` 的 `dashEntries()`（那边的 `overdue` 就是
 *      `t.due_date < today`）。
 *      ⚠️ 再加一道 `date >= today`：**过去的日子里不并入** —— 一条任务在选中日还没开始 /
 *      还没到期，摆在那一天是错的（旧实现会把它摆进去）。⇒ 本判据相对旧实现
 *      **只减少误显示、从不新增**。
 *      ⚠️ 它与 `activeOn()` 是**同一个语义家族**：`activeOn` 答「这一天在不在它的可见区间里」，
 *      本函数答「这一天该不该在任务板上看到它」—— 后者 = 前者 ＋ 「逾期的欠账并入」。
 *      ⛔ 别在界面里再手写一遍这两个条件（0.8.15 修的就是手写那份的基准取错）。
 *
 * @param {Object} t - 任务对象
 * @param {string} date - 选中日 `YYYY-MM-DD`
 * @param {string} today - 真实今天 `YYYY-MM-DD`（服务端校准过的，见 `visEnd` 的说明）
 * @returns {boolean} 该出现在选中日则为 true
 */
export function boardVisibleOn(t, date, today) {
  if (activeOn(t, date, today)) return true;
  // ⭐ 0.5.2 定的口径：**逾期未完成的并入选中日的象限**（「欠的账在任何区间里都算数」）——
  //    它的可见止是「顺延到今天」，看今天以后的日子时会被区间判据挡掉，所以这一条不能省。
  //    ⚠️ 周期任务**不进这条**：它按期显示（`activeOn` 已内含），再并一次会把整个周期结束
  //    之后的每一天都塞进来。
  return (
    t.task_kind !== 'cycle' && t.status !== 'done' && !!t.due_date && t.due_date < today && date >= today
  );
}

/**
 * 功能：算一条**窗口任务**当前处在时间窗的哪一段，并给出一句人话（0.8.14）。
 *
 * ⭐⭐ **「现在」是入参**（`nowMs`）—— 与 `visEnd(t, s, today)` 同一条约定：基准时刻从外面进来，
 *    测试才固定得住；而**「现在」的唯一提供者是 `core/clock.js`**（服务端校准过的偏移 + 一次
 *    心跳），⛔ 本函数体内**一个 `Date.now()` 都不许有**（禁的不是第二个计时器，
 *    禁的是第二个「现在」）。
 * ⭐ 判据**只住这里**：四象限 / 甘特 / 触屏那一排都调它，⛔ 别各渲染点各算一次。
 *
 * 三段（方案 §1.1②）：未开始 ⇒「距开始 X」；窗口内 ⇒「剩 X」；已过 ⇒「已过窗口」。
 * ⚠️ 时刻缺省：开始取 `00:00`、截止取 `23:59`（普通任务那两个时刻是可选的，窗口任务表单
 *    会要求都填，但老数据 / 手搓的请求可能只有一个）。
 *
 * ⭐⭐ 0.8.14 修订（第二轮）：「**设置了窗口期的也要和窗口任务一样显示**」——
 *    ⛔ 原先函数第一行是 `t.task_kind !== 'window'` 一刀切，于是**周期任务勾了「设置时间窗」
 *    之后界面上一片空白**（条目上没有那枚 ⏱ 药丸的倒计时、详情里没有「当前」那一格）。
 *    ⇒ 改成按**有没有填时刻**判（普通任务保存时时刻一律送空串 ⇒ 天然不参与）。
 * ⭐⭐ 0.8.14 修订（第三轮）：「**当期**窗口期过了，不应该显示已过窗口期吗，
 *    和窗口任务一样」—— 周期任务的时段挂在**每一期**上（「本期 10/5 09:23~19:23」），
 *    所以窗口起止必须取**本期**（`periodOf()` 按基准日给出这一期），⛔ 不能拿**整段周期**的
 *    起止去算 —— 那是「整段还剩 25 天」，与「今天这一期什么时候过完」是两件事（就是这么
 *    看出来的）。基准日不在任何一期里（周期还没开始 / 已经走完）时，退回**最近过完的那一期**。
 *
 * @param {Object} t - 任务对象，读 `task_kind` / `start_date` / `due_date` / `start_time` / `due_time`
 * @param {number} nowMs - 基准时刻（epoch 毫秒，**来自 `clock.now()`**）
 * @returns {?{phase: string, text: string}} `phase` 取 `'before'` / `'in'` / `'after'`；没填时刻时为 null
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
      // ⭐⭐ 0.8.14 修订（第四轮）：「这里都完成了还剩 23 小时」——
      //    那个时段是**每一期里每一天**的时段（一期 10/2~10/6 ＋ 20:29~21:29 = 每天那个点要做），
      //    所以窗口要取**夹进这一期之后的那一天**的 st~et；
      //    ⛔ 不能拿「期首 st → 期末 et」（那会算成 10/2 20:29 ~ 10/6 21:29 ⇒ 打过卡了还显示「剩 23 小时」）。
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
 *      差值才是对的（与 `overdueDays` 里那条时区纪律同源）。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @param {string} timeStr - `HH:MM`
 * @returns {number} 分钟数
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
 * ⭐ 0.8.14新增 —— 四象限与甘特图上那句「逾期 N 天」的唯一出处。
 * ⚠️ 口径钉死：**从理论截止日算**，⛔ 不用 `visEnd()` 顺延后的日期算（那个是「画到哪一天」，
 *    不是「欠了几天」）。已完成的也照算 —— 界面用它写「逾期 N 天后完成」
 *    （N = 完成日 − 截止日，见这个函数的 `end` 分支）。
 * ⚠️ 自然日差：`2026-10-02` 截止、今天 `2026-10-03` ⇒ **1 天**（不是 0，也不是「不足一天」）。
 *
 * @param {Object} t - 任务对象，读 `status` / `due_date` / `completed_at`
 * @param {string} today - 基准日 `YYYY-MM-DD`
 * @returns {number} 逾期天数；**没逾期 / 没有截止日 / 基准日缺失时为 0**
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
 *      一律用 UTC 构造，避免本地时区把「差一天」算成 0 或 2）。
 *
 * @param {string} a - 起始日 `YYYY-MM-DD`
 * @param {string} b - 结束日 `YYYY-MM-DD`
 * @returns {number} `b - a` 的天数
 */
function dayDiff(a, b) {
  const [y1, m1, d1] = String(a).split('-').map(Number);
  const [y2, m2, d2] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * 功能：算任务的象限权重（**紧急 ×2 + 重要 ×1**），供四象限排序。
 *
 * ⭐ 0.7.2 改了口径：「紧急且重要 → 紧急 → 重要 → 都不」——
 *    **紧急优先**。此前是 `重要×2 + 紧急×1`（艾森豪威尔矩阵的通行口径，重要优先），
 *    要在看板上按紧急优先排，于是这份权重整个掉了个头。
 *    ⚠️ 这一个公式同时决定**手机任务板的列表顺序**（`mobile-board.js` 拿它排序）——
 *    知情并选了「两边统一改紧急优先」，所以是**故意**的联动，别当事故改回去。
 * @param {Object} t - 任务对象，读 `important` / `urgent` 两个字段
 * @returns {number} 0~3 的权重，数值越大排得越靠前
 *    （3 = 又急又重要 / 2 = 只急 / 1 = 只重要 / 0 = 都不）
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

