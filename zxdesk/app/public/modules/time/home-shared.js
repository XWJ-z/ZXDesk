/**
 * modules/time/home-shared.js —— 「番茄钟与日程表」首页的**两端共用纯函数 / 文案**（0.8.13）
 *
 * 功能：宿主（`home-desktop.js` / `home-mobile.js`）共用的那一小层 —— 四个 pane 的名字、
 *      归一化、选择器与「‹ 日程表」返回键的 HTML 片段。
 *
 * ⚠️⭐ **两端各一份的是「怎么画」，共用的是「叫什么」**：按钮类名两端是两套
 *    （电脑版 `btn btn-subtle btn-sm` / 手机版 `btn ghost sm`），所以这里只产出结构、
 *    类名由调用方传进来（决策：共用片段不写死类名，否则一端必然画歪）。
 *
 * ⚠️ 这里**只放纯函数 / 常量**：碰 DOM 的事一律留在两端各自的宿主文件里，⛔ 不在这里写 `document`。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.33
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、07-前端-电脑版与手机版.md
 */

/**
 * 这一屏里住着的四个 pane（第一个是首页自己）。
 * @type {Array.<string>}
 */
export const TIME_PANES = ['home', 'timetable', 'pomodoro', 'trip'];

/**
 * 三个**子屏**（首页上那三颗按钮通向它们）。
 * @type {Array.<string>}
 */
export const TIME_SUB_TABS = ['timetable', 'pomodoro', 'trip'];

/**
 * 功能：算某个 pane 的容器选择器 —— 两端**同名**（`#time-home` / `#time-timetable` / …）。
 * @param {string} tab - pane 名
 * @returns {string} 选择器
 */
export const timePaneSel = (tab) => `#time-${tab}`;

/**
 * 功能：把任意输入归一成合法 pane 名（认不出来一律回首页）。
 * @param {?string} tab - 目标 pane
 * @returns {string} `TIME_PANES` 里的一个
 */
export const normTimeTab = (tab) => (TIME_PANES.includes(tab) ? tab : 'home');

/**
 * 功能：生成「**‹ 日程表**」返回键（三个子屏的屏头各一颗）。
 *
 * 说明：⭐ 它**只派动作、不做跳转**：宿主在 `#time-view` 上一次性委托 `[data-time-tab]`，
 *      拿到 `home` 就去开首页 —— 子屏因此**不需要认识宿主**（也就不必互相 import）。
 *
 * @param {string} cls - 本端的按钮类名（两端两套，见文件头）
 * @returns {string} 按钮的 HTML
 */
export const timeBackHtml = (cls) => `<button class="${cls}" type="button" data-time-tab="home">‹ 日程表</button>`;

// ---------- 首页「日程表」的几何（⭐ 纯函数，两端共用；⛔ 这里一个 DOM 都不碰） ----------

/**
 * 一周七列的表头文案（列 0 = 周一，与 `WEEK_LABELS.indexOf()` 对齐）。
 * @type {Array.<string>}
 */
export const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 一天的分钟数（0~24 点的尺子就是它）。 */
const DAY_MIN = 1440;

/**
 * 功能：日期串加天数（纯字符串 → `Date.UTC` 算术 → 字符串，⛔ 不碰本机时区）。
 * @param {string} day - `YYYY-MM-DD`
 * @param {number} n - 天数（可为负）
 * @returns {string} `YYYY-MM-DD`
 */
export function addDaysStr(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * 功能：`HH:MM` → 当天的分钟数（0~1439）；认不出来回 `null`。
 *
 * 说明：⚠️ 回 `null` 而不是 `0` —— 「没填时刻」与「零点整」是两件事，
 *      前者要画默认长度并打记号，后者就是零点整。
 *
 * @param {?string} v - `HH:MM`
 * @returns {?number} 分钟数
 */
export function hhmmToMin(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 功能：把 `YYYY-MM-DD HH:MM` 拆成 `[日期, 分钟数]`（车票那两列就是这个形状）。
 * @param {?string} v - `YYYY-MM-DD HH:MM`
 * @returns {?Array} `[day, min]`；认不出来回 `null`
 */
export function dayMinOf(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length < 16) return null;
  const day = s.slice(0, 10);
  const min = hhmmToMin(s.slice(11, 16));
  return min == null ? null : [day, min];
}

/**
 * 功能：epoch 毫秒 → 当天的分钟数（`started_at` / `ended_at` 是毫秒）。
 * @param {?number} ms - epoch 毫秒
 * @returns {?number} 分钟数
 */
export function msToMin(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const d = new Date(Number(ms));
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 功能：epoch 毫秒 → 本地日期串 `YYYY-MM-DD`。
 * @param {?number} ms - epoch 毫秒
 * @returns {string} 日期串；认不出来回空串
 */
export function msToDay(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：把一段 `[起, 止]`（分钟）画成**0~100 的百分比**（`top` / `height`），并夹在当天里。
 *
 * 说明：⭐ 0.8.33 起顺手带回这一块在这一列上的**结束分钟数**（`endMin`）—— 「今天已经
 *      过完的块」要按它判（见 `buildWeek()` 第 ⑥ 步）。⚠️ 它是**夹过之后**的值：跨天的
 *      行程在今天这一列上画到 24:00 ⇒ `endMin = 1440`，于是「还没结束」自然不会被判成已过。
 *
 * @param {number} startMin - 起始分钟
 * @param {number} endMin - 结束分钟（可以 > 1440，会被夹到 1440）
 * @returns {{top: number, height: number, endMin: number}} 百分比 ＋ 夹过的结束分钟
 */
function spanPct(startMin, endMin) {
  const s = Math.max(0, Math.min(DAY_MIN, startMin));
  const e = Math.max(s + 1, Math.min(DAY_MIN, endMin)); // ⚠️ 至少 1 分钟：0 高度的块看不见
  return { top: (s / DAY_MIN) * 100, height: ((e - s) / DAY_MIN) * 100, endMin: e };
}

/**
 * 功能：把「这一趟在某一列上占哪一段」算出来 —— 含**跨天**（首日到 24:00、末日从 0:00、中间整天满列）。
 *
 * 说明：⭐ 跨天是「行程 / 车票」的常态（23:40 出发、次日 01:20 到），所以判据必须按
 *      「这一天落在这段区间的哪里」来算，⛔ 不能只比 `start_date`。
 *
 * @param {string} day - 这一列的日期
 * @param {string} startDay - 起始日
 * @param {number} startMin - 起始分钟
 * @param {string} endDay - 结束日（可空 ⇒ 同起始日）
 * @param {number} endMin - 结束分钟
 * @returns {?{top: number, height: number}} 这一列上的百分比；这一天不在区间里回 `null`
 */
function crossDayPct(day, startDay, startMin, endDay, endMin) {
  const eDay = endDay || startDay;
  if (day < startDay || day > eDay) return null;
  const s = day === startDay ? startMin : 0;
  const e = day === eDay ? endMin : DAY_MIN;
  return spanPct(s, e);
}

/**
 * 功能：把首页接口的载荷压成**七列**（每列一堆块）—— ⭐ 两端共用这一份，⛔ 几何只写一次。
 *
 * 说明：⭐ 口径（方案 §四，逐条）：
 *      · 课程：`start_time` → `end_time`（作息必填，不会缺）；
 *      · 行程：`start_date`＋`start_time` → `end_date || start_date`＋`end_time`；
 *        **缺 `end_time` ⇒ 按默认 60 分钟画并打记号**（⛔ 不静默）；
 *      · 车票：`depart_at` → `arrive_at`（**缺 ⇒ 默认 120 分钟并打记号**）；
 *      · 番茄：只算 `completed`，`started_at` → `ended_at`（缺 ⇒ `planned_seconds`）；
 *        ⚠️ 跨零点的番茄**截断在 24:00**（⛔ 不跨列 —— 它属于**开始那天**，与统计口径一致）。
 *        ⭐ 0.8.32：**休息也画**（`kind` 是短休 / 长休时出 `kind: 'rest'` 的块）——
 *        休息与专注是两种块，⛔ 不是把它从时间轴上抹掉。
 *      · ⚠️ 重叠的块**叠着画**（`stack` 递增，界面据此加阴影）—— ⛔ 不做并排分道。
 *
 * @param {Object} data - `GET /api/time/home` 的响应
 * @param {?number} [nowMin] - 「现在」是当天的第几分钟（`0~1439`）—— ⭐ 0.8.33 新增，只用来判
 *      「**今天**这一列里哪些块已经过完了」（见第 ⑥ 步）。缺省 / 认不出来 ⇒ 一块都不标。
 * @returns {Array.<Object>} 七列：`{ date, label, isToday, past, blocks }`
 *      （`past` = **今天之前的那几天**，整列压暗；块上的 `isPast` = 今天这一列里已过完的那些）
 */
export function buildWeek(data, nowMin) {
  const from = String((data && data.from) || '');
  const to = String((data && data.to) || '');
  const today = String((data && data.today) || '');
  const cols = [];
  if (!from) return cols;
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysStr(from, i);
    if (to && date > to) break;
    // ⭐ 0.8.31（「过了的时间要变灰色」）：多带一个「**这一天过完了没有**」
    //    （`past`）—— 首页两端据此把**整列压暗**。判据只此一份，⛔ 别在两端各写各的日期比较。
    //    ⚠️ `today` 是**服务端**给的（页面不读本机时钟）；它为空时（老响应）past 恒 false，安全。
    cols.push({ date, label: WEEK_LABELS[i] || '', isToday: date === today, past: !!today && date < today, blocks: [] });
  }
  const at = new Map(cols.map((c, i) => [c.date, i]));
  /** 功能：把一块塞进某一列（日期不在这一周里就丢掉）。 */
  const put = (day, block) => {
    const i = at.get(day);
    if (i == null) return;
    cols[i].blocks.push(block);
  };

  // ① 课程
  for (const c of (data && data.courses) || []) {
    const s = hhmmToMin(c.start_time);
    const e = hhmmToMin(c.end_time);
    if (s == null || e == null) continue;
    put(String(c.date || ''), {
      kind: 'course',
      title: String(c.name || ''),
      sub: [c.teacher, c.location].filter(Boolean).join(' '),
      color: String(c.color || ''),
      timeText: `${c.start_time}–${c.end_time}`,
      noTime: false,
      ...spanPct(s, e),
    });
  }

  // ② 行程（缺结束时刻 ⇒ 默认 1 小时 ＋ 记号）
  for (const tr of (data && data.trips) || []) {
    const startDay = String(tr.start_date || '');
    const s = hhmmToMin(tr.start_time);
    if (!startDay || s == null) continue; // ⚠️ 老数据（没时刻）不上时间轴 —— 它没有长度，画不出来
    const eOwn = hhmmToMin(tr.end_time);
    const e = eOwn == null ? s + 60 : eOwn;
    const endDay = eOwn == null ? startDay : String(tr.end_date || startDay);
    for (const col of cols) {
      const geo = crossDayPct(col.date, startDay, s, endDay, eOwn == null ? s + 60 : e);
      if (!geo) continue;
      put(col.date, {
        kind: 'trip',
        title: String(tr.title || ''),
        sub: tr.vehicle ? String(tr.vehicle) : '',
        color: '',
        timeText: eOwn == null ? `${tr.start_time}–（没填结束时刻，按 1 小时画）` : `${tr.start_time}–${tr.end_time}`,
        noTime: eOwn == null,
        ...geo,
      });
    }
  }

  // ③ 车票（缺到达时刻 ⇒ 默认 2 小时 ＋ 记号）
  for (const tk of (data && data.tickets) || []) {
    const dep = dayMinOf(tk.depart_at);
    if (!dep) continue;
    const arr = dayMinOf(tk.arrive_at);
    const endDay = arr ? arr[0] : dep[0];
    const endMin = arr ? arr[1] : dep[1] + 120;
    for (const col of cols) {
      const geo = crossDayPct(col.date, dep[0], dep[1], endDay, endMin);
      if (!geo) continue;
      put(col.date, {
        kind: 'ticket',
        title: String(tk.code || tk.from_station || '车票'),
        sub: `${tk.from_station || ''}→${tk.to_station || ''}`,
        color: '',
        timeText: arr ? `${String(tk.depart_at).slice(11, 16)}–${String(tk.arrive_at).slice(11, 16)}` : '（没填到达时刻，按 2 小时画）',
        noTime: !arr,
        ...geo,
      });
    }
  }

  // ④ 番茄与休息（只 completed；跨零点**截断在 24:00**，⛔ 不跨列）
  //    ⭐ 0.8.32：休息（短休 / 长休）也画 —— 它是**另一种块**（`k-rest`），⛔ 不是不画。
  for (const p of (data && data.pomodoros) || []) {
    const long = String(p.kind) === 'long_break';
    const rest = long || String(p.kind) === 'short_break';
    const day = String(p.date || '') || msToDay(p.started_at);
    const s = msToMin(p.started_at);
    if (!day || s == null) continue;
    const lenMin = Math.max(1, Math.round((Number(p.planned_seconds) || 0) / 60));
    const eMs = p.ended_at == null ? s + lenMin : s + Math.max(1, Math.round((Number(p.ended_at) - Number(p.started_at)) / 60000));
    put(day, {
      kind: rest ? 'rest' : 'pomo',
      title: rest ? (long ? '长休' : '短休') : '番茄',
      sub: `${lenMin} 分钟`,
      color: '',
      timeText: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} 起 · ${lenMin} 分钟`,
      noTime: false,
      ...spanPct(s, Math.min(DAY_MIN, eMs)),
    });
  }

  // ⑤ 每列按起点排序 ＋ 算「叠了几层」（重叠的块加阴影，⛔ 不分道）
  for (const col of cols) {
    col.blocks.sort((a, b) => a.top - b.top || a.height - b.height);
    let lastBottom = -1;
    let stack = 0;
    for (const b of col.blocks) {
      if (b.top < lastBottom - 0.01) stack += 1;
      else stack = 0;
      b.stack = Math.min(stack, 3);
      lastBottom = Math.max(lastBottom, b.top + b.height);
    }
  }

  // ⑥ ⭐⭐ 0.8.33（「今天过了的也要变灰色」）：**今天这一列**里逐块判「过完没有」。
  //    ⚠️⭐ 判据是「**结束时刻**已经过去」（`endMin <= 现在`）—— 正在进行中的那一件保持原色，
  //    它还没过完；跨天还在进行中的行程在今天这一列上 `endMin = 1440` ⇒ 天然不会被标上。
  //    ⚠️ 只在 `isToday` 那一列上判：今天之前的整列已经由 `col.past` 压暗，不必逐块再标一次。
  //    ⚠️ `nowMin` 由调用方从**服务端**时刻算出来（`core/timetable.js` 的 `ttNowHM()`）——
  //    本函数仍然不读本机时钟，⛔ 也不在这里 import 任何东西。
  const nowM = Number(nowMin);
  const hasNow = nowMin != null && Number.isFinite(nowM);
  for (const col of cols) {
    if (!col.isToday || !hasNow) continue;
    for (const b of col.blocks) b.isPast = b.endMin <= nowM;
  }
  return cols;
}

// ---------- 0.8.30：周切换（翻周）与屏上共用文案 ----------

/**
 * 功能：算某一天所在那一周的**周一**。
 *
 * 说明：⚠️ 与后端 `modules/time/routes.js` 的 `weekRangeOf()` **同口径**（本项目一律以周一为一周之首），
 *      全程 `Date.UTC` 算术 —— ⛔ 不碰本机时区。
 *
 * @param {string} day - `YYYY-MM-DD`
 * @returns {string} 那一周的周一
 */
export function mondayOf(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 周一 = 1 … 周日 = 7
  return addDaysStr(day, 1 - wd);
}

/**
 * 功能：算「从某一天起偏移 N 周」的那一周 —— 给 `‹ ›` 翻周用。
 *
 * @param {string} day - 锚点日（`YYYY-MM-DD`）
 * @param {number} offsetWeeks - 周偏移（`-1` = 上一周，`0` = 本周）
 * @returns {Array.<string>} `[周一, 周日]`
 */
export function weekRangeOf(day, offsetWeeks) {
  const mon = addDaysStr(mondayOf(day), (Number(offsetWeeks) || 0) * 7);
  return [mon, addDaysStr(mon, 6)];
}

/**
 * 块的四类 → 点它要进的那一个子屏（0.8.30：首页的块可以点了）。
 * ⭐ 0.8.32：休息（`rest`）跟番茄进同一屏 —— 它也是番茄钟那边的事。
 * @type {Object.<string, string>}
 */
export const HOME_TAB_OF_KIND = { course: 'timetable', trip: 'trip', ticket: 'trip', pomo: 'pomodoro', rest: 'pomodoro' };

// ---------- ⭐ 0.8.32：日程表顶部那条「日期卡」（照首页看板列表视图那条周条的样子） ----------

/**
 * 功能：把日期压成 `M/D` —— 日期卡下面那一行（与 `core/date.js` 的 `fmtShort` **同口径**）。
 *
 * 说明：⚠️ 本文件**不 import 任何东西**（`frontend-modules.test.js` 会在 Node 里直接 import 它跑断言，
 *      所以它必须没有依赖）⇒ 这三行自己写一份，取舍与 `trip-shared.js` 的 `escapeText` 同款。
 *
 * @param {string} day - `YYYY-MM-DD`
 * @returns {string} 形如 `10/12`；认不出来回空串
 */
export function mdOf(day) {
  const p = String(day == null ? '' : day).split('-');
  if (p.length !== 3) return '';
  return `${Number(p[1])}/${Number(p[2])}`;
}

/**
 * 功能：把一周七列折成**七张日期卡**要的那几个字段 —— ⭐ 两端共用这一份（⛔ 别各写一份）。
 *
 * 说明：⭐ 「日程表顶部那条日期切换改成首页看板那样的周条，接在对应日期下面」
 *      —— 于是这七张卡就是**七列各自的表头**（列宽自然对齐，⛔ 不必自己算偏移）。
 *      ⚠️ `past` 沿用 `buildWeek()` 的口径（**服务端**给的今天之前，⛔ 不读本机时钟）。
 *
 * @param {Array.<Object>} cols - `buildWeek()` 的产物（每列 `{ date, label, isToday, past }`）
 * @param {?string} selDay - 当前选中的那一天（可空 = 一张都不选中）
 * @returns {Array.<Object>} `{ date, weekday, md, isToday, past, sel }`
 */
export function dayCards(cols, selDay) {
  const sel = String(selDay == null ? '' : selDay);
  return (cols || []).map((c) => ({
    date: String(c.date || ''),
    weekday: String(c.label || ''),
    md: mdOf(c.date),
    isToday: !!c.isToday,
    past: !!c.past,
    sel: !!sel && String(c.date) === sel,
  }));
}

/**
 * 日期卡要用的类名（⭐ 沿用首页看板那条周条的 `.dash-day` —— 要的就是「和看板一样」）——
 * 两端的版式各写一份，但**状态怎么算、叫什么名字只有这一处**。
 *
 * @param {Object} c - `dayCards()` 的一条
 * @returns {string} 逗号分隔的类名（供两端各自拼进自己的骨架）
 */
export function dayCardCls(c) {
  return ['dash-day', c.isToday ? 'is-today' : '', c.past ? 'is-past' : '', c.sel ? 'is-sel' : '']
    .filter(Boolean)
    .join(' ');
}

// ---------- ⭐ 0.8.33：顶部那行标题（「显示今天日期即可」） ----------

/**
 * 功能：顶部那行标题该说**哪一天**。
 *
 * 说明：⭐ 0.8.33（「这个显示日期断干啥，显示今天日期即可」）：原来是
 *      「2026-10-12 ~ 2026-10-18」那种区间。口径（与手机端进屏滚动那一支同源）：
 *      · 选中了某一天 ⇒ 就说那一天（那一张卡与它下面那一列都高亮着，标题必须对得上）；
 *      · 没选中 ⇒ 说今天；今天不在这一屏上（翻到别的周了）⇒ 说这一屏的第一天（周一）。
 *      ⚠️ `today` 一律用**服务端**给的那一个（⛔ 页面不读本机时钟）。
 *
 * @param {Array.<Object>} cols - `buildWeek()` 的产物
 * @param {?string} selDay - 当前选中的那一天（空 = 一张都没选）
 * @param {?string} today - 服务端的今天
 * @returns {string} `YYYY-MM-DD`；一列都没有时回空串
 */
export function headDayOf(cols, selDay, today) {
  const list = cols || [];
  if (!list.length) return '';
  const has = (d) => !!d && list.some((c) => c.date === d);
  if (has(selDay)) return String(selDay);
  if (has(today)) return String(today);
  return String(list[0].date || '');
}

/**
 * 功能：把一天写成顶部那行标题 —— 与首页看板 `dashRangeLabel()` 的**单日格式逐字同款**
 *      （`10月15日 周四 · 今天`）。
 * @param {string} day - `YYYY-MM-DD`
 * @param {string} weekday - 单个汉字（一~日）
 * @param {boolean} isToday - 这一天是不是今天（是才带「 · 今天」）
 * @returns {string} 标题；日期认不出来回空串
 */
export function dayHeadText(day, weekday, isToday) {
  const p = String(day == null ? '' : day).split('-');
  if (p.length !== 3) return '';
  return `${Number(p[1])}月${Number(p[2])}日 周${String(weekday || '')}${isToday ? ' · 今天' : ''}`;
}

/**
 * 功能：一步给出顶部那行标题 —— ⭐ 两端都调它（⛔ 别各自挑日期、各自拼格式）。
 * @param {Array.<Object>} cols - `buildWeek()` 的产物
 * @param {?string} selDay - 当前选中的那一天（空 = 一张都没选）
 * @param {?string} today - 服务端的今天
 * @returns {string} 标题文案
 */
export function homeHeadText(cols, selDay, today) {
  const day = headDayOf(cols, selDay, today);
  if (!day) return '';
  const c = (cols || []).find((x) => x.date === day);
  return dayHeadText(day, c ? c.label : '', day === String(today || ''));
}

/**
 * 首页**底部**那句口径说明 —— ⭐ 两端共用这一份（0.8.30 之前两端各写一份，还写歪成 Markdown 粗体）。
 *
 * ⚠️⭐ 0.8.33（「介绍语要简洁明了」）：从 34 字压到 20 字 —— 只留
 *      「怎么画的」这一条，⛔ 不再解释重叠与虚线的来龙去脉（界面上看得出来）。
 * @type {string}
 */
export const HOME_FOOT_HINT = '按实际时长等比例画；缺时刻的按默认长度画。';

/**
 * 首页**一件安排都没有**时那句人话（前三颗按钮恒在屏上，这里只指路、⛔ 不重复画按钮）。
 * @type {string}
 */
export const HOME_EMPTY_HINT = '这一周还没有安排（用上面三颗按钮加一条）。';

/**
 * 「课表这一块没开」那句 —— 两端逐字一致（设置页那一节的叫法两端本来就一样）。
 * @type {string}
 */
export const HOME_TT_OFF_HINT = '课表这一块没开（去设置里打开）';

/**
 * 功能：课表开着、但一个学期都没有时那句指路 —— ⚠️ 模块名**按各端自己的叫法**（电脑「大学课表」/ 手机「课表」）。
 * @param {string} ttName - 本端对课表那一格的叫法
 * @returns {string} 一句提示
 */
export const homeNoTermHint = (ttName) => `还没有课表（进「${ttName}」导入一份）`;
