/**
 * modules/calendar/shared.js —— 日历**两端共用的纯逻辑**（0.7.5）
 *
 * 功能：月视图的日期算术与图层常量的**唯一一份实现** —— 年月平移、42 天网格范围、
 *      跨天事件展开成逐日、按日期分组、图层清单与长度上限、**记账金额的显示串**。
 *
 * ⭐ 为什么收一份（与 `hardware/shared.js` / `vault/shared.js` 同一理由）：
 *    「这个月有几行、第一格是哪天」这类算术**两端必须逐字一致** —— 各写一份的下场是
 *    「电脑上 9 月 1 号在周二那一格、手机上是周一那一格」，而且**不报任何错**。
 *    ⚠️ 只收**纯逻辑**：版式（颜色 / 间距 / 结构）仍然两端各写一份，那是**刻意**的。
 *
 * ⚠️ 本文件**不 import 任何 DOM / 状态**（纯函数 + 常量）⇒ 两端都能安心引它，
 *    也不会把它卷进 `shell.js → modules.js → 视图` 那种环里。
 *    ⭐ 同理它**不 import 别的模块的实现**（0.8.3 的记账图层是第一条跨模块联动，
 *    取数一律走服务端那份 —— 见 `layerAmountText()` 的说明与）。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.9
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { addDays, fmtLong, mondayOf, weekName } from '../../core/date.js';

/** 表头的星期（**周一起**，与 `core/date.js` 的 `mondayOf()` 同一口径；⛔ 别改成周日起） */
export const DOW_CN = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 功能：日历这一屏**四个**只读图层（页面上的顺序）——
 * ⚠️ `key` 必须与后端 `calendar_prefs` 的列名逐字一致（`PUT /api/calendar/layers` 认它）。
 * ⭐ 0.8.3（记账 4 期）加了第 4 项「记账」——
 * ⚠️⭐ **漏了这一处 = 两端的图层开关都不出现**（方案 §7.4 点名的那三处「漏了不报错」之一）。
 * @type {Array.<{key: string, kind: string, label: string}>}
 */
export const LAYERS = [
  { key: 'layer_course', kind: 'course', label: '课表' },
  { key: 'layer_task', kind: 'task', label: '任务截止' },
  { key: 'layer_holiday', kind: 'holiday', label: '法定假期' },
  { key: 'layer_ledger', kind: 'ledger', label: '记账' },
];

/** 标题 / 备注的长度上限 —— 与后端 `routes.js` 的同名常量一致（前端先拦一道，省一次往返） */
export const TITLE_MAX = 100;
export const NOTE_MAX = 500;

/**
 * 功能：一节课程在**当天列表**里的稳定键 —— 倒计时的定时器靠它把「DOM 上那一行」与
 *      「这一节」对上（服务端的课程图层条目**没有 id**：它只是「某天某门课」的一份快照）。
 *
 * 说明：⭐ 0.8.9（「日历视图的课程条也要像列表的一样有倒计时…」）——
 *      两端都要用它 ⇒ 与日期算术同一理由收在这一份文件里（各写一份必然漂移，而且不报错）。
 *      ⚠️ 键里必须带日期（同一天同一门课可能有两节，只有时间能区分；而跨天必须不同键）。
 * @param {Object} c - 课程图层的一条（`{date, title, start, end, room}`）
 * @returns {string} 形如 `2026-09-30|08:30|中国近现代史纲要`
 */
export function calCourseKey(c) {
  return `${String((c && c.date) || '')}|${String((c && c.start) || '')}|${String((c && c.title) || '')}`;
}

/**
 * 功能：把记账图层给来的**整数分**写成界面上的金额串（`1234` → `1,234.56`）。
 *
 * 说明：⭐ 与「日期算术」收在这一份文件里的理由一样：**两端必须逐字一致** ——
 *      各写一份的下场是「电脑上一格写 `1,234.56`、手机上是 `1234.56`」，而且**不报任何错**。
 *      ⚠️ 实现只走**整数运算**（`Math.floor(abs / 100)` + `abs % 100`）：经过浮点乘除的话，
 *      大额金额会现出尾巴 —— 而这是钱（记账那边 `fmtFen()` 的注释里写着同一条）。
 *      ⚠️ 负号用 **ASCII `-`**（不是排版用的 `−`），与记账那套逐字一致、也便于测试比对。
 *      ⚠️ 入参不是有限数时按 `0` 处理（⛔ 界面上不许出现 `NaN` / `Infinity`）。
 *
 * ⚠️⭐ **它为什么是「另一份」而不是 import 记账的 `fmtFen()`**：
 *      `modules/ledger/calc.js` 是**别的模块的文件** —— ⛔ 跨模块 import 别人的实现会让
 *      「删掉 `modules/ledger/` 之后日历照旧可用」这条**删目录验收**当场失效
 *      （静态 import 404 ⇒ 整个日历模块加载不起来）。⇒ 这里留一份，
 *      ⭐ 并**配对账用例**钉住它与记账那份逐字一致（`ttt/test/calendar.test.js` 里那条
 *      「金额串与记账的 fmtFen 逐字一致」）。改这份必须同步改那份（反之亦然）。
 *
 * @param {number} fen - 整数分
 * @returns {string} 显示串，如 `1,234.56` / `-12.00` / `0.00`
 */
export function layerAmountText(fen) {
  const n = Number(fen);
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  const abs = Math.abs(v);
  const yuan = Math.floor(abs / 100);
  const cent = abs % 100;
  // ⚠️ `\B(?=(\d{3})+(?!\d))` 是从右往左每三位插一个逗号的标准写法（⛔ 别自己按字符数循环）
  const head = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}${head}.${String(cent).padStart(2, '0')}`;
}

/**
 * 功能：取日期所在的年月 `YYYY-MM`。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @returns {string} `YYYY-MM`
 */
export function ymOf(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

/**
 * 功能：把 `YYYY-MM` 平移若干个月（跨年自己进位）。
 * @param {string} ym - `YYYY-MM`
 * @param {number} n - 月数偏移（负数往前）
 * @returns {string} 平移后的 `YYYY-MM`
 */
export function shiftYm(ym, n) {
  const [y0, m0] = String(ym).split('-').map(Number);
  const total = y0 * 12 + (m0 - 1) + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * 功能：求某个月的月视图网格范围 —— **42 天**（6 行 × 7 列，周一起）。
 *
 * 说明：⭐ 取的是「整周网格」而不是「1 号到月末」：否则第一行会缺几天、最后一行也会缺几天，
 *      那几格既画不出东西、点开也没有数据。多取十来天的代价可以忽略（一次接口而已）。
 *
 * @param {string} ym - `YYYY-MM`
 * @returns {{from: string, to: string}} 42 天的闭区间
 */
export function gridRangeOf(ym) {
  const from = mondayOf(`${ym}-01`);
  return { from, to: addDays(from, 41) };
}

/**
 * 功能：把 `YYYY-MM` 写成界面上的月份标题。
 * @param {string} ym - `YYYY-MM`
 * @returns {string} 形如 `2026 年 9 月`
 */
export function monthTitle(ym) {
  return `${Number(String(ym).slice(0, 4))} 年 ${Number(String(ym).slice(5, 7))} 月`;
}

/**
 * 功能：把日期写成「9月18日 · 周五」。
 * @param {string} dateStr - `YYYY-MM-DD`
 * @returns {string} 中文日期 + 星期
 */
export function dayLabel(dateStr) {
  return `${fmtLong(dateStr)} · ${weekName(dateStr)}`;
}

/**
 * 功能：把「一串条目」按某一天聚成 `Map`（键是日期串），供格子与当天列表查。
 * @param {Array.<Object>} items - 条目数组
 * @param {string} key - 用哪个字段当日期（`date`）
 * @returns {Map.<string, Array.<Object>>} 日期 → 条目数组
 */
export function groupByDate(items, key) {
  const map = new Map();
  for (const it of items || []) {
    const d = String(it[key] || '');
    if (!d) continue;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(it);
  }
  return map;
}

/**
 * 功能：把**跨天事件展开成逐日的出现**（只取落在网格里的那些天）。
 *
 * 说明：⭐ 一条 `09-18 → 09-20` 的事件要在**三天**的格子里都看得到（台账口径：
 *      区间查询两端都命中，见后端 `listCalendarEvents`）。跨出网格的天直接丢掉，
 *      所以不会画出界。
 *
 * @param {Array.<Object>} events - 服务端给的事件（已落在查询区间里）
 * @param {string} from - 网格起点
 * @param {string} to - 网格终点
 * @returns {Map.<string, Array.<Object>>} 日期 → 该天要画的事件
 */
export function expandEvents(events, from, to) {
  const map = new Map();
  for (const e of events || []) {
    const s = String(e.date || '');
    const eEnd = String(e.end_date || '') || s;
    if (!s || eEnd < s) continue;
    let d = s < from ? from : s;
    const last = eEnd > to ? to : eEnd;
    while (d <= last) {
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(e);
      d = addDays(d, 1);
    }
  }
  return map;
}

/**
 * 功能：这一天的假期是哪种 —— `'rest'` 法定放假日 / `'work'` 调休上班日 / `''` 都不是。
 * @param {Map.<string, Array.<Object>>} holMap - 假期图层按日聚好的表
 * @param {string} d - 日期
 * @returns {string} 上三者之一
 */
export function holidayKindOf(holMap, d) {
  const rows = holMap.get(d) || [];
  if (rows.some((h) => h.kind === 'rest')) return 'rest';
  if (rows.some((h) => h.kind === 'work')) return 'work';
  return '';
}

/**
 * 功能：事件在列表里那句「什么时候」—— 全天 / `09:00–10:00` / 「没填时刻」，跨天再补「至 X月X日」。
 *
 * 说明：⚠️ 两端**逐字共用**这句文案（各写一份必然出现「电脑上写『全天』、手机上写『整天』」）。
 *
 * @param {Object} e - 事件
 * @returns {string} 人话
 */
export function eventWhenText(e) {
  const when = e.all_day ? '全天' : [e.start_time, e.end_time].filter(Boolean).join('–') || '没填时刻';
  return e.end_date && e.end_date !== e.date ? `${when} 至 ${fmtLong(e.end_date)}` : when;
}

/** 四象限的**优先级**（当天列表同一组内的排序用；给定：重要且紧急 → 紧急 → 重要 → 都不） @type {Object} */
export const QUAD_RANK = { q1: 0, q3: 1, q2: 2, q4: 3 };

/**
 * 功能：按 `important` / `urgent` 把任务归到四象限的**短键**（`q1`~`q4`）。
 *
 * 说明：⭐ 0.8.9 修订：「重要和紧急显示了名称就显示不全了 —— 不显示紧急和重要，
 *      用颜色和排序区分」⇒ 当天列表那条任务**从此不画**「🔴 重要 / ⏰ 紧急」两枚徽章（它们把标题
 *      挤成「选.」这种），改成把象限写成 `data-q`：交给 CSS 上色、交给 `byQuadRank()` 排序。
 *      ⚠️ 本函数**只出键、不出文案** —— 文案那半住 `desktop-board.js` 的 `quadOf()`，⛔ 别抄过来。
 *      ⚠️ 住 `shared.js` 是因为**两端都要**（各写一份必然出现两边排序不一样，且不报错）。
 *
 * @param {Object} t - 任务（读 `important` / `urgent`）
 * @returns {string} `'q1'`（重要且紧急）/ `'q3'`（紧急）/ `'q2'`（重要）/ `'q4'`（都不）
 */
export function quadKeyOf(t) {
  if (Number(t.important) && Number(t.urgent)) return 'q1';
  if (Number(t.urgent)) return 'q3';
  if (Number(t.important)) return 'q2';
  return 'q4';
}

/**
 * 功能：同一组内的排序 —— 按 `QUAD_RANK` 把四象限依次排前面（同一象限内保持原顺序，`sort` 稳定）。
 * @param {Object} a - 任务
 * @param {Object} b - 任务
 * @returns {number} 比较值
 */
export function byQuadRank(a, b) {
  return QUAD_RANK[quadKeyOf(a)] - QUAD_RANK[quadKeyOf(b)];
}
