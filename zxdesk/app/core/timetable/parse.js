/**
timetable/parse.js —— 课表模板解析（签名识别 → 五段式拆格 → 诊断）
 *
 * 功能：把网格 IR 解析成可落库的课表草稿 —— 模板签名识别（`detectTemplate`）、
 *      单元格条目解析（`parseCellEntries`，`[节次]节` 是从格子里读出来的）、
 *      课程配色（`colorOfCourse`）、元信息与行文本（`parseMetaFields` / `joinRowText`）、
 *      两个公开入口 `parseTimetable` 与 `buildTemplateCsv`。
 *
 * ⚠️ 设计前提**都是从真实样本上量出来的**，别按「应该长什么样」改：
 *    行不是「第 N 节」而是**时段块**且块内小节数可以不等（样本 2/2/3/2/3）；
 *    连堂课会**跨行重复印刷**，精确去重即可、**不做相邻合并**；格子里自带 `[节次]节`。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.4
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const { WEEKDAY_NAMES, guessStartMonday, maxWeekOf, normalizeWeeks, weekdayOf } = require('./date-util.js');
const { contiguousRuns, generatePeriods, parsePeriodNumbers, solveSchedule } = require('./schedule-solve.js');
// ⭐ 0.8.3：CSV 序列化收口到共用层那一份（⛔ 本文件不再自带第二份 RFC 4180 转义）
const { buildCsv } = require('../sheet/csv.js');

/** 节次行：形如 `[01-02]节` / `1-2节` / `（3-4）节`，捕获组里是节次号串 */
const RE_PERIODS_LINE = /^[[［(（]?\s*(?:第)?\s*([\d\-–—~,，、\s]+?)\s*[\]］)）]?\s*节$/;

/** 教室特征词：判断某个「剩下的行」是不是教室时用（见 `parseCellEntries()` 的按特征认领） */
const RE_ROOM = /(室|楼|馆|场|区|号|机房|教室|实验室|中心|校区)/;

/**
 * 功能：把一个格子的文本解析成若干条目。
 *
 * 说明：五段式 `课程名 / 教师(职称) / 周次[周] / 教室 / [节次]节`，**条目之间用空行分隔**。
 *      ⚠️ 按**特征**认领而不是按位置取：别的系统可能没有教师或没有教室，
 *      按位置取会静默错位（把教室当教师）。
 *      ⚠️ 行内判定顺序要紧：「1-16[周]」既能匹配节次行也能匹配周次行，
 *      所以先判节次（要求以「节」结尾），避免把周次误当成节次。
 *
 * @param {string} text - 单元格原文（可含多行、多条目）
 * @returns {Array.<Object>} 条目数组，每项含 `course` / `teacher` / `room` / `weeksRaw` / `periods` / `lowConfidence`
 */
function parseCellEntries(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  if (!raw.trim()) return [];
  const chunks = raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let periodsRaw = null;
    let weeksRaw = null;
    let periodsText = '';
    const rest = [];
    for (const ln of lines) {
      let m;
      if ((m = ln.match(RE_PERIODS_LINE))) {
        periodsRaw = m[1];
        periodsText = ln;
        continue;
      }
      // ⚠️ 顺序要紧：「1-16[周]」既能匹配节次行也能匹配周次行，所以先判节次（要求以「节」结尾）
      if (/周/.test(ln) && (m = ln.match(/^(.*?)[[［(（]?\s*周\s*[\]］)）]?$/))) {
        weeksRaw = m[1] || ln.replace(/[[［(（\]）)］周]/g, '');
        continue;
      }
      rest.push(ln);
    }
    // 兜底：整块里正则扫一遍（应对「(3-4节)1-12周」这种把两样写在一行的系统）
    if (periodsRaw === null) {
      const m = chunk.match(/[[［(（]?\s*(?:第)?\s*([\d\-–—~,，、]+)\s*[\]］)）]?\s*节/);
      if (m) {
        periodsRaw = m[1];
        periodsText = m[0];
      }
    }
    if (weeksRaw === null) {
      const m = chunk.replace(periodsText, '').match(/([\d\-–—~,，、单双\s]+)\s*周/);
      if (m) weeksRaw = m[1];
    }

    const course = rest[0] || '';
    let teacher = '';
    let room = '';
    const ti = rest.findIndex((l, i) => i > 0 && /[（(]/.test(l));
    if (ti > 0) teacher = rest[ti].replace(/[（(].*$/, '').trim();
    const others = rest.filter((l, i) => i > 0 && i !== ti);
    if (others.length) {
      const last = others[others.length - 1];
      if (ti > 0) room = last;
      else if (RE_ROOM.test(last)) room = last;
      else teacher = last;
    }

    const nums = periodsRaw === null ? null : parsePeriodNumbers(periodsRaw);
    out.push({
      course: course.trim(),
      teacher: teacher.trim(),
      room: room.trim(),
      weeksRaw: weeksRaw === null ? '' : String(weeksRaw).trim(),
      periods: nums,
      lowConfidence: !course || !nums || !weeksRaw,
    });
  }
  return out;
}

/** 时段块的识别条数上限：扫到这么多块就停，不再往下找（避免把表格下方的其它内容当成时段块） */
const MAX_BLOCK_ROWS = 12;

/**
 * 功能：识别「时段块网格式」模板，返回星期表头行、块标签列、星期列位置、
 *      各时段块以及标题行 / 元信息行 / 备注行的行号。
 *
 * 说明：不匹配时**不是一句"格式不对"**，而是把「我看到了什么」一起返回（§8.9 的体检报告原则）。
 *
 * @param {Array.<Array.<*>>} rows - 网格数据（二维数组）
 * @returns {Object} 命中时含 `ok: true` 与各定位信息；未命中时含 `ok: false`、`code`、`message` 与 `saw`
 */
function detectTemplate(rows) {
  const grid = Array.isArray(rows) ? rows : [];
  const saw = {
    rows: grid.length,
    cols: grid.reduce((a, r) => Math.max(a, r.length), 0),
    head: grid.slice(0, 4).map((r) =>
      r
        .map((c) => String(c).slice(0, 20))
        .filter(Boolean)
        .slice(0, 6),
    ),
  };

  // 1) 找星期表头：某行里连续 ≥5 个格子能认出星期
  let headerRow = -1;
  let headerCols = [];
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const cols = [];
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) if (weekdayOf(row[c])) cols.push({ c, wd: weekdayOf(row[c]) });
    if (cols.length >= 5) {
      headerRow = r;
      headerCols = cols;
      break;
    }
  }
  if (headerRow < 0) {
    return {
      ok: false,
      code: 'NO_HEADER',
      message: '没找到「星期一…星期日」这一行，这看起来不是一张课表网格。',
      saw,
    };
  }

  // 2) 时段块行：表头下方，首列（表头列之前那一列）含「段名 + 时间区间」
  const labelCol = headerCols[0].c > 0 ? 0 : headerCols[0].c;
  const blocks = [];
  for (let r = headerRow + 1; r < grid.length && blocks.length < MAX_BLOCK_ROWS; r++) {
    const row = grid[r] || [];
    const labelCell = String(row[labelCol] || '').trim();
    const m = labelCell.match(/(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/);
    if (!m) {
      // 备注行 / 其它行：这里只跳过，备注行稍后单独定位
      continue;
    }
    const firstLine = (labelCell.split(/\r?\n/)[0] || '').trim();
    const label = firstLine.replace(/[:：].*$/, '').trim() || `时段${blocks.length + 1}`;
    blocks.push({ row: r, label, start_time: m[1], end_time: m[2] });
  }

  if (!blocks.length) {
    return {
      ok: false,
      code: 'NO_BLOCKS',
      message:
        '找到了星期表头，但左边没有「上午 08:30-10:05」这样的时段块（第一列缺少「段名 + 起止时间」）。' +
        '当前版本只认这一种版式。',
      saw,
    };
  }

  // 3) 标题行 / 元信息行 / 备注行
  let titleRow = -1;
  let metaRow = -1;
  for (let r = 0; r < headerRow; r++) {
    const text = (grid[r] || []).map((x) => String(x)).join(' ');
    if (/学年学期|学期[:：]|班级[:：]|打印日期/.test(text)) metaRow = r;
    else if (/课表/.test(text) && titleRow < 0) titleRow = r;
  }
  let remarkRow = -1;
  for (let r = headerRow + 1; r < grid.length; r++) {
    const text = (grid[r] || [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join(' ');
    if (/^备注/.test(text)) {
      remarkRow = r;
      break;
    }
  }

  return {
    ok: true,
    headerRow,
    labelCol,
    weekdays: headerCols,
    blocks,
    titleRow,
    metaRow,
    remarkRow,
    saw,
  };
}

/** 课程配色候选池：`colorOfCourse()` 按课程名散列后从这里取一个 */
const PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
  '#14b8a6',
  '#6366f1',
  '#eab308',
];

/**
 * 功能：按课程名稳定分配一个颜色（同一门课每次导入颜色一致）。
 *
 * 说明：名字散列后取色，若该色已被本次导入占用则顺延到下一个。
 *
 * @param {string} name - 课程名
 * @param {Set.<string>} used - 已被占用的颜色集合；本函数会把选中的颜色加进去
 * @returns {string} 十六进制颜色值
 */
function colorOfCourse(name, used) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  let idx = h % PALETTE.length;
  for (let k = 0; k < PALETTE.length && used.has(PALETTE[idx]); k++) idx = (idx + 1) % PALETTE.length;
  used.add(PALETTE[idx]);
  return PALETTE[idx];
}

/**
 * 功能：从元信息行里抽出 `键：值` 字段表。
 *
 * 说明：字段之间用连续空格（2 个及以上）分隔。
 *
 * @param {string} text - 元信息行文本
 * @returns {Object.<string, string>} 键到值（均已去空白）的映射
 */
function parseMetaFields(text) {
  const out = {};
  const s = String(text || '');
  for (const part of s.split(/\s{2,}/)) {
    const m = part.match(/^([^:：]{1,12})[:：]\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/**
 * 功能：把一行的单元格拼成可读文本，并**去掉重复值**。
 *
 * 说明：⚠️ 必须去重：合并区（标题 `A1:H1`、元信息 `A2:H2`）被展开后，
 *      同一段文字会在 8 个格子里各出现一次，直接 join 会得到重复 8 遍的垃圾 meta。
 *
 * @param {Array.<*>} row - 一行单元格
 * @returns {string} 去重后以单空格拼接的文本
 */
function joinRowText(row) {
  const seen = new Set();
  const out = [];
  for (const cell of row || []) {
    const t = String(cell === undefined || cell === null ? '' : cell).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(' ');
}

/**
 * 功能：课表导入主入口 —— 把网格 IR 解析成可落库的课表草稿，并附一份诊断报告。
 *
 * 说明：流程是 版式识别 → 逐块逐格解析 → 作息交叉求解 → 聚合去重 → 学期信息与诊断。
 *      去重只做**精确去重、不做相邻合并**（连堂课会跨行重复印刷，重复项精确相等）。
 *      凡是「没导进去的东西」都会在诊断里留一条带理由的记录（§8.9）。
 *
 * @param {Object} sheet - `sheet-parser.js` 产出的网格 IR：用到 `rows` / `source` / `sheetName` / `warnings`
 * @returns {Object} 成功时 `{ok: true, draft, diagnostics}`（课表草稿与诊断报告）；
 *          失败时 `{ok: false, code, message, saw}`（错误码、中文提示与「看到了什么」）
 */
function parseTimetable(sheet) {
  const rows = (sheet && sheet.rows) || [];
  const sig = detectTemplate(rows);
  if (!sig.ok) return sig;

  const sourceWarnings = (sheet.warnings || []).slice();
  const unparsed = [];
  const rowPeriods = [];
  const rowEntries = [];
  // 教师职称被省略的**不同教师**（不是条目数 —— 同一门课重复印刷十几次不该算十几次）
  const teacherTitleSet = new Set();

  sig.blocks.forEach((b, bi) => {
    const row = rows[b.row] || [];
    const list = [];
    const periodsOfRow = [];
    for (const { c, wd } of sig.weekdays) {
      const text = row[c];
      for (const e of parseCellEntries(text)) {
        if (!e.periods) {
          unparsed.push({ weekday: wd, blockRow: b.row + 1, reason: '读不出节次', text: String(text).slice(0, 200) });
          continue;
        }
        if (!e.course) {
          unparsed.push({ weekday: wd, blockRow: b.row + 1, reason: '读不出课程名', text: String(text).slice(0, 200) });
          continue;
        }
        const wk = normalizeWeeks(e.weeksRaw);
        if (!wk.ok) {
          unparsed.push({
            weekday: wd,
            blockRow: b.row + 1,
            reason: `周次读不出（${wk.error}）`,
            text: `${e.course} · 周次原文「${e.weeksRaw}」`,
          });
          continue;
        }
        if (/[（(]/.test(e.teacher) || /[（(]/.test(String(text)))
          teacherTitleSet.add(e.teacher || String(text).slice(0, 40));
        list.push({
          weekday: wd,
          blockIdx: bi,
          periods: e.periods,
          weeks: wk.text,
          course: e.course,
          teacher: e.teacher,
          room: e.room,
          lowConfidence: e.lowConfidence,
        });
        periodsOfRow.push(e.periods);
      }
    }
    rowEntries.push(list);
    rowPeriods.push(periodsOfRow);
  });

  const rawEntries = rowEntries.reduce((a, l) => a + l.length, 0);
  if (!rawEntries) {
    return {
      ok: false,
      code: 'NO_COURSES',
      message: '找到了时段块，但格子里没有解析出任何课程条目（可能不是这个版式的课表）。',
      saw: sig.saw,
    };
  }

  // ---- 作息求解 ----
  const solved = solveSchedule(sig.blocks, rowPeriods);
  const blocks = sig.blocks.map((b, i) => ({
    label: b.label,
    sort_order: i,
    start_time: b.start_time,
    end_time: b.end_time,
    period_count: solved.splits[i] || 1,
    class_minutes: solved.classMinutes,
    break_minutes: solved.breakMinutes,
  }));
  const periods = generatePeriods(blocks);

  // ---- 聚合去重（§8.8：**只做精确去重，不做相邻合并**）----
  const seen = new Set();
  const courses = new Map();
  let duplicates = 0;
  let sessions = 0;
  for (const list of rowEntries) {
    for (const e of list) {
      const sigKey = [e.course, e.teacher, e.room, e.weeks, e.weekday, e.periods.join('-')].join('\u0001');
      if (seen.has(sigKey)) {
        duplicates++;
        continue;
      }
      seen.add(sigKey);
      let course = courses.get(e.course);
      if (!course) {
        course = { name: e.course, short_name: '', teacher: e.teacher, color: '', sessions: [] };
        courses.set(e.course, course);
      }
      if (!course.teacher && e.teacher) course.teacher = e.teacher;
      for (const run of contiguousRuns(e.periods)) {
        course.sessions.push({
          weekday: e.weekday,
          period_start: run[0],
          period_end: run[run.length - 1],
          weeks: e.weeks,
          room: e.room,
          teacher: e.teacher,
        });
        sessions++;
      }
    }
  }

  // ---- 学期信息 ----
  const metaText = sig.metaRow >= 0 ? joinRowText(rows[sig.metaRow]) : '';
  const titleText = sig.titleRow >= 0 ? joinRowText(rows[sig.titleRow]) : '';
  const meta = parseMetaFields(metaText);
  const termName = meta['学年学期'] || meta['学期'] || '';
  const remarkText =
    sig.remarkRow >= 0
      ? (rows[sig.remarkRow] || [])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] || ''
      : '';
  const remarkBody = remarkText.replace(/^备注\s*[:：]?\s*/, '');
  const allWeeks = [...seen].map((k) => k.split('\u0001')[3]);
  const totalWeeks = allWeeks.reduce((a, w) => Math.max(a, maxWeekOf(w)), 0) || 17;

  // 备注里提到了、但网格里没有的课程（尽力而为的提示，不生成课次）
  const remarkExtra = [];
  if (remarkBody) {
    const names = new Set(courses.keys());
    for (const chunk of remarkBody.split(/[;；]/)) {
      const t = chunk.trim();
      if (!t) continue;
      const first = t.split(/\s+/)[0];
      if (first && first.length >= 2 && !names.has(first) && !/^\d/.test(first) && !remarkExtra.includes(first)) {
        remarkExtra.push(first);
      }
    }
  }

  const used = new Set();
  const courseList = [...courses.values()].map((c, i) => {
    c.color = colorOfCourse(c.name, used);
    c.sort_order = i;
    return c;
  });

  // ---- 诊断（§8.9：凡是"没导进去的东西"都必须有一条带理由的记录）----
  const diagnostics = {
    source: sheet.source || '',
    sheetName: sheet.sheetName || '',
    rows: rows.length,
    cols: rows.reduce((a, r) => Math.max(a, r.length), 0),
    blocks: blocks.length,
    periods: periods.length,
    rawEntries,
    duplicates,
    courses: courseList.length,
    sessions,
    teacherTitlesOmitted: teacherTitleSet.size,
    lowConfidence: rowEntries.flat().filter((e) => e.lowConfidence).length,
    remarkExtra,
    unparsed,
    warnings: sourceWarnings,
    schedule: {
      confidence: solved.confidence,
      note: solved.note,
      classMinutes: solved.classMinutes,
      breakMinutes: solved.breakMinutes,
    },
  };

  const draft = {
    term: {
      name: termName || sheet.sheetName || '导入的学期',
      start_monday: guessStartMonday(termName),
      start_monday_guessed: !!guessStartMonday(termName),
      total_weeks: totalWeeks,
      remark: remarkBody,
      meta: [titleText, metaText].filter(Boolean).join('\n'),
    },
    blocks,
    periods,
    courses: courseList,
  };
  return { ok: true, draft, diagnostics };
}

/**
 * 功能：生成手输用的 CSV 模板文本（**与导入同一种网格语义**，所以能直接导回来）。
 *
 * 说明：分隔符用逗号，单元格内的换行按 RFC 4180 用引号包住 —— 由调用方负责加 UTF-8 BOM。
 *      ⭐ 0.8.3：序列化改成调**共用层**的 `buildCsv()`（`core/sheet/csv.js`）——
 *      从前这里自带一份 `q()` / `line()` 局部实现，那是同一段 RFC 4180 转义的**第二份拷贝**
 *      （项目，而漂移的是「导出的表是不是坏的」）。
 *      ⚠️ 输出与从前**逐字节一致**：`buildCsv()` 同样是「每个单元格加引号 ＋ 逗号 ＋ CRLF
 *      行尾（末行也带）」—— 所以 `ttt/test/timetable.test.js` 里的模板向量一个字都不用动。
 *
 * @returns {string} 模板 CSV 文本（CRLF 行尾）
 */
function buildTemplateCsv() {
  const rows = [];
  rows.push(['示例学院 某某 学生个人课表', '', '', '', '', '', '', '']);
  rows.push(['学年学期：2026-2027-1  班级：XX  专业：XX  学院：XX  打印日期：2026-09-01', '', '', '', '', '', '', '']);
  rows.push(['', ...WEEKDAY_NAMES]);
  const sample = '\n高等数学\n张三(讲师)\n1-16[周]\n一教101室\n[01-02]节\n';
  rows.push(['上午\n08:00-09:35', sample, '', '', '', '', '', '']);
  rows.push(['上午\n09:50-11:25', '', '', '', '', '', '', '']);
  rows.push(['下午\n14:00-15:35', '', '', '', '', '', '', '']);
  rows.push(['下午\n15:50-17:25', '', '', '', '', '', '', '']);
  rows.push(['晚上\n19:00-20:35', '', '', '', '', '', '', '']);
  rows.push(['备注：', '', '', '', '', '', '', '']);
  return buildCsv(rows);
}

module.exports = {
  RE_PERIODS_LINE,
  RE_ROOM,
  parseCellEntries,
  MAX_BLOCK_ROWS,
  detectTemplate,
  PALETTE,
  colorOfCourse,
  parseMetaFields,
  joinRowText,
  parseTimetable,
  buildTemplateCsv,
};
