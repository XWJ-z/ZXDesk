/**
timetable/date-util.js —— 课表用的日期与周次工具（纯函数）
 *
 * 功能：课表这块的日期与周次算术 —— 时间字符串与分钟互转（`toMin` / `fmtMin`）、
 *      星期识别（`weekdayOf` / `weekdayOfDate`）、求所在周周一（`mondayOf`）、
 *      日期序数与第几周（`dateOrdinal` / `weekNumberOf`）、从学期名猜开学周一（`guessStartMonday`）
 *      与反向的「由今天猜学期名」（`guessTermName`），
 *      以及周次模型（`normalizeWeeks` / `weeksInclude` / `splitWeeks` / `maxWeekOf`）。
 *
 * ⚠️ 周次模型**服务端与前端各有一份实现**，靠同一批测试向量对齐 —— 改这里必须同时看前端那一份。
 *    ⚠️ 例外：`splitWeeks`（「调课 → 此后全部」劈周次）**只有服务端有**，前端不需要劈开 ——
 *    劈开是写库动作（把一条课次变成两条），只在服务端发生，前端拿到的永远是已经劈好的行。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

/**
 * 功能：把入参转成数字，转不出有效数字时返回兜底值。
 *
 * 说明：**`0` 是合法值**（课间 0 分钟真实存在），不能被 `|| 默认值` 吃掉，
 *      所以这里只把 `undefined` / `null` / 空串当作「没给值」。
 *
 * @param {*} v - 待转换的原始值
 * @param {number} dflt - 转不出有效数字时使用的兜底值
 * @returns {number} 转换后的数字，或兜底值
 */
function numOr(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 功能：把 `HH:MM` 形式的时刻换算成当天的分钟数，供时长计算与作息拟合使用。
 *
 * @param {string} hhmm - 形如 `08:30` 的时刻文本
 * @returns {?number} 当天分钟数；格式非法或时 / 分越界时返回 null
 */
function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 功能：把当天分钟数格式化成 `HH:MM` 文本。
 *
 * 说明：跨天则截到 23:59 —— 作息不可能跨天。
 *
 * @param {number} v - 当天分钟数
 * @returns {string} `HH:MM` 文本；非有限数或负数返回空串
 */
function fmtMin(v) {
  if (!Number.isFinite(v) || v < 0) return '';
  const capped = Math.min(v, 23 * 60 + 59);
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
}

/**
 * 功能：求 `YYYY-MM-DD` 对应的星期序号（1=周一 … 7=周日）。
 *
 * 说明：结果不参与比较，只用于算「第几周周一」。
 *
 * @param {string} dateStr - 形如 `2026-09-01` 的日期文本
 * @returns {number} 星期序号 1..7；日期拆不出年月日时返回 0
 */
function weekdayOfDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return 0;
  const w = new Date(y, m - 1, d).getDay(); // 0=周日
  return w === 0 ? 7 : w;
}

/**
 * 功能：取某日期所在周的周一日期。
 *
 * @param {string} dateStr - 形如 `2026-09-01` 的日期文本
 * @returns {string} 该周周一的 `YYYY-MM-DD`；日期非法时返回空串
 */
function mondayOf(dateStr) {
  const w = weekdayOfDate(dateStr);
  if (!w) return '';
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d - (w - 1));
  /**
   * 功能：把数字补零到两位，用于拼装 `YYYY-MM-DD`。
   *
   * @param {number} x - 月份或日期数字
   * @returns {string} 两位数字文本
   */
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * 功能：把日期换算成「序日」（1970-01-01 起的天数），用于做纯天数差。
 *
 * 说明：用 `Date.UTC` 只为拿一个**纯天数差**，不参与任何展示 —— 避开本地时区偏移。
 *
 * @param {string} dateStr - 形如 `2026-09-01` 的日期文本
 * @returns {?number} 序日；格式不匹配或月 / 日越界时返回 null
 */
function dateOrdinal(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

/**
 * 功能：算今天（`todayStr`）是开学后的第几周（1 起）。
 *
 * 说明：⚠️ 返回 null 时**界面不许猜**（不标本周、不做周次筛选），而是提示用户去设置开学日期。
 *
 * @param {string} startMonday - 第 1 周周一的 `YYYY-MM-DD`
 * @param {string} todayStr - 今天的 `YYYY-MM-DD`
 * @returns {?number} 周次（1 起）；任一日期为空或非法时返回 null
 */
function weekNumberOf(startMonday, todayStr) {
  const a = dateOrdinal(startMonday);
  const b = dateOrdinal(todayStr);
  if (a === null || b === null) return null;
  return Math.floor((b - a) / 7) + 1;
}

/**
 * 功能：由学年学期名猜测「第 1 周星期一」。
 *
 * 说明：⚠️ **文件里没有这个信息**，只能猜，且必须在界面上标成猜测值。
 *      规则：秋季（学年学期以 `-1` 结尾）→ 当年 `09-01` 所在周的周一；春季（`-2`）→ 次年 `02-20` 所在周的周一。
 *      解析不出学年学期 → 返回空串（**不猜**，让用户自己填或选择暂不设置）。
 *
 * @param {string} termName - 学年学期名，形如 `2026-2027-1`
 * @returns {string} 猜测的「第 1 周周一」`YYYY-MM-DD`；解析不出时返回空串
 */
function guessStartMonday(termName) {
  const m = String(termName || '').match(/(\d{4})\s*[-–—]\s*(\d{4})\s*[-–—]\s*(\d)/);
  if (!m) return '';
  const half = Number(m[3]);
  const base = half === 2 ? `${m[2]}-02-20` : `${m[1]}-09-01`;
  return mondayOf(base);
}

/**
 * 功能：由「今天是几号」猜一个**学年学期名**（`guessStartMonday()` 的反方向）。
 *
 * 说明：⭐ 高校模板里**没有学期信息**（它只描述学校，不描述哪一学期），所以按今天的月份猜一个
 *      形如 `2026-2027-1` 的名字填进向导，用户改成自己的即可。规则按国内高校的通行口径：
 *      8~12 月 → 当年秋季 `Y-(Y+1)-1`；1 月 → 仍是上一年的秋季 `(Y-1)-Y-1`；2~7 月 → 春季 `(Y-1)-Y-2`。
 *      ⚠️ 它**只是一个猜测**，界面上必须与文件导入那条路一样标出来（`start_monday_guessed`），
 *      让用户知道这是猜的、要去核对 —— 猜错的学期名只会让「今天是第几周」标错，不会毁数据。
 *
 * @param {string} dateStr - 今天的日期 `YYYY-MM-DD`
 * @returns {string} 猜测的学年学期名；入参不是合法日期时返回空串（**不猜**）
 */
function guessTermName(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo >= 8) return `${y}-${y + 1}-1`;
  if (mo <= 1) return `${y - 1}-${y}-1`;
  return `${y - 1}-${y}-2`;
}

/** 星期全称，下标顺序即星期序号 1..7 */
const WEEKDAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
/** 单个汉字的星期写法，按 `一…六日天` 排列（`天` 与 `日` 同义），供 `weekdayOf()` 查表 */
const WD_CN = ['一', '二', '三', '四', '五', '六', '日', '天'];

/**
 * 功能：把一段文本识别成星期序号，支持中文（`周一` / `星期一` / `礼拜一`）、
 *      数字（`1`..`7`）与英文缩写（`mon` / `tuesday` 等）。
 *
 * @param {string} text - 待识别的文本
 * @returns {number} 星期序号 1..7；认不出来返回 0
 */
function weekdayOf(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s || s.length > 8) return 0;
  const m = s.match(/^(?:星期|周|礼拜)([一二三四五六日天])$/);
  if (m) return WD_CN.indexOf(m[1]) + 1;
  const d = s.match(/^([1-7])$/);
  if (d) return Number(d[1]);
  const en = s.match(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?$/i);
  if (en) {
    const k = en[1].toLowerCase().slice(0, 3);
    return { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }[k] || 0;
  }
  return 0;
}

/**
 * 功能：把各种写法的周次文本规范化成统一形式，并拆成可逐段判定的「段」。
 *
 * 说明：规范形 `<段>[,<段>]*`，段 = `<起>-<止>[单|双]` 或 `<单周次>[单|双]`，
 *      例：`1-16` / `1-8,10-16` / `1-16单` / `1-5,7-11单` / `6,8,10,12,14,16`。
 *      ⚠️ **保留单双后缀，不展开成具体周号**（§7.2）：展开后就再也回不去了 ——
 *      用户改「第 1 周周一」时，已展开的数据会永久错。
 *      ⚠️ **枚举不等于双周**：`6,8,10,12,14,16` 是从第 6 周起的 6 个偶数周，
 *      识别成「双周」会把它变成 8 周（样本里真实出现过这个值）。
 *
 * @param {*} raw - 原始周次文本（任意写法）
 * @returns {{ok: boolean, text?: string, segments?: Array.<Object>, error?: string}} 成功时给出规范形文本与段数组，失败时给出中文原因
 */
function normalizeWeeks(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return { ok: false, error: '周次为空' };
  if (s.length > 200) return { ok: false, error: '周次文本过长' };

  s = s.replace(/\s+/g, '');
  s = s.replace(/单周/g, '单').replace(/双周/g, '双');
  s = s.replace(/周次|周数/g, '');
  s = s.replace(/[|｜]/g, '');
  s = s.replace(/[［【（(]/g, '').replace(/[］】）)]/g, '');
  s = s.replace(/^第/, '');
  s = s.replace(/[，、；;]/g, ',');
  s = s.replace(/[－–—~～至]/g, '-');
  s = s.replace(/周/g, '');
  s = s.replace(/[^0-9,\-单双]/g, ''); // 清掉其余装饰
  if (!s) return { ok: false, error: '周次里没有数字' };

  const segments = [];
  for (const part of s.split(',')) {
    if (!part) continue;
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?(单|双)?$/);
    if (!m) return { ok: false, error: `周次片段「${part}」看不懂` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    const parity = m[3] || '';
    if (from < 1 || to < 1) return { ok: false, error: `周次「${part}」小于 1` };
    if (to < from) return { ok: false, error: `周次「${part}」起止颠倒` };
    if (to > 60) return { ok: false, error: `周次「${part}」超过 60（像是被 Excel 转成了日期？）` };
    segments.push({ from, to, parity });
  }
  if (!segments.length) return { ok: false, error: '周次里没有有效片段' };

  const text = segments.map((g) => (g.from === g.to ? `${g.from}` : `${g.from}-${g.to}`) + g.parity).join(',');
  return { ok: true, text, segments };
}

/**
 * 功能：判断第 `weekNo` 周上不上这门课。
 *
 * 说明：⚠️ **解析不出来时宽松放行**（返回 true）：课表漏显示一门课的代价，
 *      远大于多显示一门（用户看到多余的一格会去改；看不到少的一格则永远不知道）。
 *
 * @param {string} weeksText - 周次文本（任意写法）
 * @param {number} weekNo - 待判断的周次
 * @returns {boolean} 该周是否包含这门课；周次非法返回 false
 */
function weeksInclude(weeksText, weekNo) {
  const n = Number(weekNo);
  if (!Number.isFinite(n) || n < 1) return false;
  const norm = normalizeWeeks(weeksText);
  if (!norm.ok) return true;
  for (const g of norm.segments) {
    if (n < g.from || n > g.to) continue;
    if (g.parity === '单' && n % 2 === 0) continue;
    if (g.parity === '双' && n % 2 === 1) continue;
    return true;
  }
  return false;
}

/**
 * 功能：把周次段数组还原成规范形文本 —— **收边**（去掉命中不了的首尾）并丢掉命中零周的段。
 *
 * 说明：⚠️ 「收边」不是为了好看，是为了**用户读得懂**：`1-10单` 劈到第 7 周，若照抄区间会写成
 *      `1-6单` —— 语义没错（6 是双周、本来就不含），但用户看到「1 到 6 的单周」会先愣一下。
 *      收成 `1-5单` 就是他本来会写的形状。`2-3单` 这种「区间合法但一周都不含」的段会直接消失。
 *
 * @param {Array.<Object>} list - 周次段数组 `{from, to, parity}`
 * @returns {string} 规范形周次文本；一周都不含时返回空串
 */
function joinSegments(list) {
  const out = [];
  list.forEach((g) => {
    let from = g.from;
    let to = g.to;
    if (g.parity) {
      const want = g.parity === '单' ? 1 : 0;
      while (from <= to && from % 2 !== want) from++;
      while (to >= from && to % 2 !== want) to--;
      if (from > to) return; // 一周都不含的段：整段丢掉
    }
    out.push((from === to ? `${from}` : `${from}-${to}`) + g.parity);
  });
  return out.join(',');
}

/**
 * 功能：把周次文本在 `fromWeek` 处**劈成两半** —— 前半 `< fromWeek`、后半 `>= fromWeek`。
 *
 * 说明：⭐ 这是「调课 → 此后全部」的落法：不用新增数据表，直接把「第 1-16 周」劈成
 *      「第 1-5 周」与「第 6-16 周」两条课次，渲染层一行都不用改。
 *      ⚠️ **单双后缀必须跟着段走**：`1-16单` 劈到第 6 周是 `1-5单` + `6-16单`（而不是展开成具体周号）——
 *      展开就回不去了，用户改「第 1 周星期一」时会永久错（同 `normalizeWeeks` 的说明）。
 *      ⚠️ 劈完可能有一侧**为空**（`fromWeek` 落在最前 / 最后），调用方必须处理空串。
 *
 * @param {string} weeksText - 周次文本（任意写法）
 * @param {number} fromWeek - 分界周次，>= 它的归后半
 * @returns {{ok: boolean, before?: string, after?: string, error?: string}} 成功时给出两半的规范形文本（可能为空串）
 */
function splitWeeks(weeksText, fromWeek) {
  const W = Number(fromWeek);
  if (!Number.isFinite(W) || W < 1) return { ok: false, error: '分界周次必须是正整数' };
  const norm = normalizeWeeks(weeksText);
  if (!norm.ok) return { ok: false, error: norm.error };
  const before = [];
  const after = [];
  norm.segments.forEach((g) => {
    if (g.to < W) {
      before.push({ from: g.from, to: g.to, parity: g.parity });
      return;
    }
    if (g.from >= W) {
      after.push({ from: g.from, to: g.to, parity: g.parity });
      return;
    }
    // 跨分界：同一个段切成两截，**parity 原样复制**（第 6-16 单周仍是单周）
    before.push({ from: g.from, to: W - 1, parity: g.parity });
    after.push({ from: W, to: g.to, parity: g.parity });
  });
  return { ok: true, before: joinSegments(before), after: joinSegments(after) };
}

/**
 * 功能：取周次文本里出现的最大周次，用来推 `total_weeks`。
 *
 * @param {string} weeksText - 周次文本（任意写法）
 * @returns {number} 最大周次；解析不出返回 0
 */
function maxWeekOf(weeksText) {
  const norm = normalizeWeeks(weeksText);
  if (!norm.ok) return 0;
  return norm.segments.reduce((a, g) => Math.max(a, g.to), 0);
}

module.exports = {
  numOr,
  toMin,
  fmtMin,
  weekdayOfDate,
  mondayOf,
  dateOrdinal,
  weekNumberOf,
  guessStartMonday,
  guessTermName,
  WEEKDAY_NAMES,
  WD_CN,
  weekdayOf,
  normalizeWeeks,
  weeksInclude,
  splitWeeks,
  maxWeekOf,
};
