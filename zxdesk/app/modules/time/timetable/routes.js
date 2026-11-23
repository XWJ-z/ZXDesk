/**
 * modules/timetable/routes.js —— 课表路由（学期 / 时段块 / 逐节时间 / 课程 / 课次 / 导入）
 *
 * 功能：`handleTimetable` 一处收全部课表接口 —— 学期与课程的增删改查、时段块与逐节时间、
 * 课表快照、以及「解析上传文件 → 落库」的两步式导入，
 * 外加 的**内置高校模板**：模板清单与「按模板生成课表草稿」。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/09-模块化重构.md
 */
'use strict';

const sheet = require('../../../core/sheet-parser.js');
const ti = require('../../../core/timetable-import.js');
const hd = require('../../../core/timetable/holiday-util.js');
const AU = require('../../../core/timetable/adjust-util.js');
const DR = require('../../../core/timetable/day-rules.js');
const { COURSE_COLORS } = require('./lib/palette.js');
const {
  checkAdjustment,
  checkBlocks,
  checkCommit,
  checkCourse,
  checkDayRule,
  checkDayNote,
  checkOnward,
  checkPeriods,
  checkSession,
  checkTerm,
} = require('../../../core/validate.js');
const { httpError, idParam, json, notFound, readBody, readRawBody, writeResult } = require('../../../core/http-util.js');
const { nowInfo, periodsFromBlocks, breaksFromBlocks, todayInfo, todayStr } = require('../../../core/time-util.js');
const { store } = require('../../../core/context.js');

/**
 * 功能：算出「假前一天下午」**第一节被提前的课** —— 整周视图那一列的角标用它。
 *
 * 说明：角标要写「那一节从几点开始」而不是「提前了多少分钟」（用户看的是上课时间）；
 * 同时给出**节次号**，前端才知道把角标挂在哪一行 —— 这样「下午从第几节起」
 * 这套判断也留在服务端一份，前端不重算。
 */
function firstPmPeriod(periods, plan) {
  const shifted = hd.shiftPeriods(periods, plan.advance_minutes, plan.pm_from);
  const first = shifted.find((p) => p.shifted);
  return first ? { index_no: first.index_no, start_time: first.start_time } : null;
}

/**
 * 功能：为「高校模板」生成的课表草稿编一份**与文件解析同形**的诊断报告。
 *
 * 说明：⭐ 为什么要编这一份、而不是让前端分辨两种来源：草稿的两个来源（教务文件 / 高校模板）
 * 在向导第 2 步要展示的是**同一件事**（这次会导入什么），让两边的报告字段一致，
 * 前端就只需要一套渲染逻辑、一套体检报告版式 —— 少一套版式就少一处会漂移的地方。
 */
function templateDiagnostics(draft, meta) {
  const m = meta || {};
  return {
    source: 'template',
    sheetName: m.name || '高校模板',
    rows: 0,
    cols: 0,
    blocks: draft.blocks.length,
    periods: draft.periods.length,
    rawEntries: 0,
    duplicates: 0,
    courses: 0,
    sessions: 0,
    teacherTitlesOmitted: 0,
    lowConfidence: 0,
    remarkExtra: [],
    unparsed: [],
    warnings: [
      '这是内置的高校模板：只带来这所学校的作息与课表版式，不含任何课程。' +
        '导入后是一个有作息、没有课的空学期，课程可以自己加、也可以之后再导入一份课表。',
    ],
    schedule: {
      confidence: 'high',
      note: `来自内置高校模板「${m.name || ''}」`,
      classMinutes: draft.blocks.length ? draft.blocks[0].class_minutes : 45,
      breakMinutes: draft.blocks.length ? draft.blocks[0].break_minutes : 5,
    },
  };
}

/**
 * 功能：处理 `/api/timetable/*` 全部接口 —— 模板下载、导入预览 / 提交、学期与作息（时段块 / 逐节时间 /
 *
 * 说明：`/api/timetable/*` 全部接口。
 *
 * **必须挂在 401 闸门之后**（与 `/api/admin` 同位置）：课表是业务数据，
 * 挂到闸门之前会直接漏鉴权（`uid` 也就无从取得）。
 */
function handleTimetable(req, res, parts, user, u) {
  const uid = user.id;
  const method = req.method;
  const sub = parts[2];

  // ---- 手输模板下载（UTF-8 **带 BOM**，Excel 双击不乱码）----
  if (sub === 'template.csv' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="zxdesk-timetable-template.csv"',
    });
    return res.end('\uFEFF' + ti.buildTemplateCsv());
  }

  // ---- 导入（先看再导：preview 不落库、不落临时文件）----
  if (sub === 'import') {
    if (method === 'POST' && parts[3] === 'preview') {
      return readRawBody(req, res, (buf) => {
        const parsed = sheet.parseSheet(buf);
        // `code` / `saw` 是前端「说人话」提示的分支依据（如 .xlsx → 教用户另存为 .xls），必须原样带回
        if (!parsed.ok) throw httpError(400, parsed.message, { code: parsed.code });
        const imported = ti.parseTimetable(parsed);
        if (!imported.ok) {
          throw httpError(400, imported.message, { code: imported.code, saw: imported.saw || null });
        }
        return json(res, 200, { ok: true, draft: imported.draft, diagnostics: imported.diagnostics });
      });
    }
    if (method === 'POST' && parts[3] === 'commit') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const v = checkCommit(uid, b); // 抛 400 / 404，由 readBody 的 catch → fail() 收口
        const result = store.commitTimetable(uid, v.mode, v.payload);
        return json(res, 200, Object.assign({ ok: true }, result));
      });
    }
    return notFound(res);
  }

  // 草稿形状与 `import/preview` 的产物**逐字段同形**，所以向导第 2 步只需要一套渲染逻辑，
  // 提交也走同一个 `import/commit`（少一条写库通道就少一处会漂移的地方）。
  if (sub === 'templates' && method === 'GET') {
    if (parts.length === 3) return json(res, 200, { ok: true, templates: store.listSchoolTemplates() });
    if (parts.length === 4 && parts[3] === 'draft') {
      const code = (u.searchParams.get('code') || '').trim();
      const campus = (u.searchParams.get('campus') || '').trim();
      const draft = store.schoolTemplateDraft(code, campus);
      // 模板来自同一个服务端的清单，取不到只可能是「清单过期 / 代码被改」——
      // 按 404 的唯一出口走，不另造一种错误写法。
      if (!draft) return notFound(res);
      // 高校模板只描述「学校长什么样」，**没有学期信息** —— 按今天的月份猜一个学年学期名
      // 与开学周一填进去（与文件导入那条路的 `guessStartMonday` 同一套口径、同样标成猜测值）。
      // 放在路由层而不是 store 层：它依赖「今天」，而 store 层不该知道时间（`today()` 在 storage.js）。
      if (!draft.term.name) {
        const guess = ti.guessTermName(todayStr());
        if (guess) {
          draft.term.name = guess;
          const sm = ti.guessStartMonday(guess);
          if (sm) {
            draft.term.start_monday = sm;
            draft.term.start_monday_guessed = true;
          }
        }
      }
      // 报告里那句「来自内置高校模板『某某』」要跟**草稿本身**对得上：campus 传空时
      // 「默认变体叫 main」的学校会显示成没有名字的模板）。
      const mine = store.listSchoolTemplates().filter((t) => t.code === code);
      const meta = campus ? mine.find((t) => (t.campus || '') === campus) : mine[0];
      return json(res, 200, { ok: true, draft, diagnostics: templateDiagnostics(draft, meta) });
    }
    return notFound(res);
  }

  // ---- 学期与作息 ----
  if (sub === 'terms') {
    if (method === 'GET' && parts.length === 3) return json(res, 200, store.listTerms(uid));
    if (method === 'POST' && parts.length === 3) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const term = checkTerm(b);
        if (!term.name || term.name === '未命名学期') term.name = String(b.name || '未命名学期').trim() || '未命名学期';
        return json(res, 201, store.createTerm(uid, term));
      });
    }
    const tid = idParam(parts[3]);
    if (tid === null) return notFound(res);
    if (method === 'PUT' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const patch = {};
        if (b.name !== undefined) patch.name = checkTerm({ name: b.name }).name;
        if (b.start_monday !== undefined) patch.start_monday = checkTerm({ start_monday: b.start_monday }).start_monday;
        if (b.total_weeks !== undefined) patch.total_weeks = checkTerm({ total_weeks: b.total_weeks }).total_weeks;
        if (b.remark !== undefined) patch.remark = String(b.remark).slice(0, 2000);
        if (b.meta !== undefined) patch.meta = String(b.meta).slice(0, 2000);
        if (b.holiday_advance_minutes !== undefined || b.holiday_pm_from !== undefined) {
          // 一并交给 checkTerm 校验（0~180 分钟、`HH:MM`），它也是这两个字段的**唯一**口径出处
          const checked = checkTerm({
            holiday_advance_minutes: b.holiday_advance_minutes,
            holiday_pm_from: b.holiday_pm_from,
          });
          if (b.holiday_advance_minutes !== undefined) patch.holiday_advance_minutes = checked.holiday_advance_minutes;
          if (b.holiday_pm_from !== undefined) patch.holiday_pm_from = checked.holiday_pm_from;
        }
        if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 0;
        return writeResult(res, store.updateTerm(uid, tid, patch));
      });
    }
    if (method === 'DELETE' && parts.length === 4) return writeResult(res, store.deleteTerm(uid, tid));

    // 子资源一律先校验学期归属：不属于本人 → 与「不存在」逐字一致的 404
    if (!store.ownsTerm(uid, tid)) return notFound(res);
    const leaf = parts[4];

    if (leaf === 'blocks') {
      if (method === 'GET' && parts.length === 5) return json(res, 200, store.listBlocks(uid, tid));
      if (method === 'PUT' && parts.length === 5) {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const blocks = checkBlocks(b.blocks);
          const saved = store.replaceBlocks(uid, tid, blocks);
          // 「重新生成逐节时间」是破坏性操作（会覆盖手工微调）——
          // 前端必须先二次确认；这里只负责执行，且**只动 periods，不碰课程数据**。
          const periods = store.replacePeriods(uid, tid, periodsFromBlocks(saved));
          return json(res, 200, { ok: true, blocks: saved, periods });
        });
      }
    }

    if (leaf === 'periods') {
      if (method === 'GET' && parts.length === 5) return json(res, 200, store.listPeriods(uid, tid));
      if (method === 'PUT' && parts.length === 5) {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const existing = store.listBlocks(uid, tid);
          const periods = checkPeriods(b.periods, existing);
          return json(res, 200, { ok: true, periods: store.replacePeriods(uid, tid, periods) });
        });
      }
    }

    // GET    /terms/:tid/day-rules      → 规则清单
    // POST   /terms/:tid/day-rules      → 录入 / 覆盖（**按 `date` upsert**，同一天只留一条）
    // DELETE /terms/:tid/day-rules/:id  → 撤销
    if (leaf === 'day-rules') {
      if (method === 'GET' && parts.length === 5) {
        return json(res, 200, { ok: true, rules: store.listDayRules(uid, tid) });
      }
      if (method === 'POST' && parts.length === 5) {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const fields = checkDayRule(b);
          return json(res, 200, { ok: true, rule: store.setDayRule(uid, tid, fields) });
        });
      }
      if (method === 'DELETE' && parts.length === 6) {
        // 判据必须是 `!rid` 而不是 `=== null`：`idParam()` 走的是 `Number()`，缺参数时返回 **0**
        // （与 `/sessions` 那条同源，详见它的说明）。坏掉时不报错、只是静默少一个 404。
        const rid = idParam(parts[5]);
        if (!rid) return notFound(res);
        return writeResult(res, store.deleteDayRule(uid, rid));
      }
      return notFound(res);
    }

    // GET /terms/:tid/day-notes  → 该学期的全部备注（`{ session_id, date, note }`）
    // PUT /terms/:tid/day-notes  → 写 / 清一条（body `{ session_id, date, note }`；note 空 = 删）
    // 那个挂在**课次**上、课次按周重复 ⇒ 那几周都显示；这个挂在 `(课次, 日期)` 上 ——
    if (leaf === 'day-notes') {
      if (method === 'GET' && parts.length === 5) {
        return json(res, 200, { ok: true, notes: store.listDayNotes(uid, tid) });
      }
      if (method === 'PUT' && parts.length === 5) {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const fields = checkDayNote(b);
          const owned = store.listSessions(uid, tid).find((s) => Number(s.id) === fields.session_id);
          if (!owned) return notFound(res);
          return json(res, 200, { ok: true, note: store.setDayNote(uid, tid, fields) });
        });
      }
      return notFound(res);
    }

    if (leaf === 'schedule' && method === 'GET' && parts.length === 5) {
      const sch = store.scheduleOf(uid, tid);
      if (!sch) return notFound(res);
      const raw = (u.searchParams.get('week') || '').trim();
      const week = raw ? Number(raw) : null;
      const useWeek = Number.isFinite(week) && week >= 1;
      const weekNo = useWeek ? Math.floor(week) : null;
      // 周次过滤用的是与前端**同一套语义**（`weeksInclude`），测试用同一批向量对齐
      let cells = useWeek ? sch.cells.filter((c) => ti.weeksInclude(c.weeks, weekNo)) : sch.cells;
      // 单次调课**只在单周视图合并**。全学期视图下一条课次罩着 1-16 周，把「第 6 周挪到的
      // 目标格子」也画进去，同一门课会同时出现在两个格子里、看着像多了一节课 —— 宁可如实说一句
      // 「本视图不反映单次调课」（`has_adjustments` 交给界面），也不画一张会误导读者的表。
      const allAdj = store.listAdjustments(uid, tid);
      const bySid = new Map(sch.cells.map((c) => [Number(c.session_id), c]));
      // 第 4 参传**全量课次**：跨周调课的目的一周可能本来不覆盖目标周（只上第 6 周的课调到第 8 周），
      // 不传它，目标周就画不出那一条。
      if (useWeek) cells = AU.applyAdjustments(cells, allAdj, weekNo, sch.cells);
      // 本周的调整清单：**它同时是「撤销调课」的唯一入口** —— 被停掉的那一周格子里什么都没有，
      // 不把调整列出来，用户就再也点不回去取消了。
      // 跨周调课两向都列：①源在本周（`moved_out`，格子里是灰条）；②调到本周（`moved_in`）——
      const weekAdj = useWeek
        ? allAdj
            .filter(
              (a) =>
                Number(a.week_no) === weekNo || (AU.isCrossWeek(a) && AU.targetWeekOf(a) === weekNo),
            )
            .filter((a) => {
              const c = bySid.get(Number(a.session_id));
              if (!c) return false;
              // 源在本周：本周本来要有这节课（跨周调走的不占格，但仍是本周的调整）
              return Number(a.week_no) === weekNo ? ti.weeksInclude(c.weeks, weekNo) : true;
            })
            .map((a) => {
              const c = bySid.get(Number(a.session_id)) || {};
              return {
                id: a.id,
                session_id: a.session_id,
                course_id: c.course_id === undefined ? null : c.course_id,
                name: c.short_name || c.name || '',
                kind: a.kind,
                week_no: a.week_no,
                // 跨周调课：目标周（空 = 同周换时间）；两向标记供界面分别说话
                to_week_no: a.to_week_no === undefined ? null : a.to_week_no,
                moved_out: AU.isCrossWeek(a) && Number(a.week_no) === weekNo,
                moved_in: AU.isCrossWeek(a) && AU.targetWeekOf(a) === weekNo,
                note: a.note || '',
                to_weekday: a.to_weekday === undefined ? null : a.to_weekday,
                to_period_start: a.to_period_start === undefined ? null : a.to_period_start,
                to_period_end: a.to_period_end === undefined ? null : a.to_period_end,
                to_room: a.to_room || '',
                origin_weekday: c.weekday === undefined ? null : c.weekday,
                origin_period_start: c.period_start === undefined ? null : c.period_start,
                origin_period_end: c.period_end === undefined ? null : c.period_end,
                origin_room: c.room || '',
              };
            })
        : [];
      const plan = hd.planOf(sch.term);
      // 假期调休：规则同样只算一份、随 `days` 下发（界面拿它画「补课 / 停课」角标）
      const dayRuleRows = store.listDayRules(uid, tid);
      const days = useWeek
        ? hd.weekDaysOf(sch.term, Math.floor(week)).map((d) => {
            const pm = d.pre_holiday && plan.enabled ? firstPmPeriod(sch.periods, plan) : null;
            const rule = DR.ruleOn(dayRuleRows, d.date);
            return Object.assign(d, {
              pm_first_index: pm ? pm.index_no : null,
              pm_first_time: pm ? pm.start_time : null,
              // 这一天有没有调休规则（`null` = 照常）
              day_rule: rule ? { kind: rule.kind, to_date: rule.to_date || '', note: rule.note || '' } : null,
              // 这一天的课**是不是已经被借到别的日子上了**（本日是某条补课规则的源日期）——
              // 界面拿它把那批课画成「已调休」的灰条
              rule_moved_to: DR.movedToOn(dayRuleRows, d.date),
              // 有规则时 `rest` 以**规则**为准：停课日就是「休」；补课日哪怕落在周末也是上课日
              rest: rule ? rule.kind === 'off' : d.rest,
            });
          })
        : [];

      // 假期调休：把「借别的日子上课」的那一列换成**源日期**那一列的课，停课日则清空。
      // 只在单周视图生效（与单次调课同一个理由）；判定本体在 `core/timetable/day-rules.js`
      // （抽成纯函数才测得到），**前端一行都不用改** —— 搬过来的课已经带上本列的 `weekday`。
      if (useWeek) cells = DR.applyDayRules(cells, sch.term, days, sch.cells, allAdj);
      return json(res, 200, {
        term: sch.term,
        blocks: sch.blocks,
        periods: sch.periods,
        week: weekNo,
        cells,
        // 该学期的「按日期的课次备注」，元素是 `{ session_id, date, note }`。
        // 一次全给（数据本就稀疏），前端按 `(session_id, date)` 取用 —— 详情里切换日期
        // **不必再往返一次**（与 `palette` 同一条理由）。
        day_notes: sch.day_notes,
        today: todayInfo(sch.term),
        // 课表 2 期：服务端「现在」搭车带回 —— 倒计时的时间权威源。
        // 判定仍在前端一份（`public/core/timetable.js`），服务端只负责把钟给准。
        now: nowInfo(),
        holiday: plan,
        days,
        // 块之间的休息分界行（午休 / 晚休）—— 只在服务端算，两端各自插行，见 time-util.js
        breaks: breaksFromBlocks(sch.blocks),
        // 单次调课：本周的调整清单（可撤销）+「这个学期到底调过课没有」（全学期视图提示用）
        adjustments: weekAdj,
        has_adjustments: allAdj.length > 0,
        // 课程配色：调色板随课表一起下发 —— 「手动加课程/改颜色」要用它，
        // 它是「这门课显示成什么颜色」的一部分，再单开一个接口就是白白多一次往返
        palette: COURSE_COLORS,
      });
    }
    return notFound(res);
  }

  // 为什么加它：前端「课程管理」要把一个学期的课程与课次一次画出来，原先只能**逐门课**调
  // `/courses/:id/sessions` ⇒ 打开一次 = **1 + N 次请求**（「点击加载延迟太大」）。
  // 写得很明确：「**减请求数是唯一有效的办法**」（HTTP/1.1 每源 6 并发 + `node:sqlite`
  if (sub === 'sessions') {
    if (method === 'GET' && parts.length === 3) {
      const termId = idParam(u.searchParams.get('term_id'));
      // 判据必须是 `!termId` 而不是 `=== null`：`idParam()` 内部走的是 `Number()`，
      // 而 **`Number(null) === 0`** ⇒ 缺参数时它返回的是 **0**（不是 null），
      // （查实，`/courses` 那条一模一样）。`0` 也不是合法 id，一并挡掉。
      if (!termId) throw httpError(400, '缺少 term_id');
      if (!store.ownsTerm(uid, termId)) return notFound(res);
      return json(res, 200, store.listSessions(uid, termId));
    }
    return notFound(res);
  }

  // ---- 课程与课次 ----
  if (sub === 'courses') {
    if (method === 'GET' && parts.length === 3) {
      const termId = idParam(u.searchParams.get('term_id'));
      // 同 `/sessions`：`idParam(null)` 返回的是 **0**，`=== null` 判不出来（详见那条的说明）。
      if (!termId) throw httpError(400, '缺少 term_id');
      if (!store.ownsTerm(uid, termId)) return notFound(res);
      return json(res, 200, store.listCourses(uid, termId));
    }
    if (method === 'POST' && parts.length === 3) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const termId = idParam(b.term_id);
        if (termId === null || !store.ownsTerm(uid, termId)) return notFound(res);
        const course = checkCourse(b);
        return json(res, 201, store.createCourse(uid, Object.assign({ term_id: termId }, course)));
      });
    }
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    if (method === 'PUT' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // 与现有行**合并后再全量校验**：`checkCourse` 要求 name 非空，
        // 直接拿局部 body 去校验会把「只改老师」这种正常请求打成 400。
        const cur = store.getCourse(uid, cid);
        if (!cur) return notFound(res);
        return writeResult(res, store.updateCourse(uid, cid, checkCourse(Object.assign({}, cur, b))));
      });
    }
    if (method === 'DELETE' && parts.length === 4) return writeResult(res, store.deleteCourse(uid, cid));

    // 嵌套资源双重校验：课程归属 + 课次确实挂在这门课下
    if (!store.ownsCourse(uid, cid)) return notFound(res);
    if (parts[4] === 'sessions') {
      if (method === 'GET' && parts.length === 5) return json(res, 200, store.listCourseSessions(uid, cid));
      if (method === 'POST' && parts.length === 5) {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const s = checkSession(b);
          return json(res, 201, store.createSession(uid, Object.assign({ course_id: cid }, s)));
        });
      }
      const sid = idParam(parts[5]);
      if (sid === null) return notFound(res);
      const owned = store.listCourseSessions(uid, cid).find((s) => Number(s.id) === sid);
      if (!owned) return notFound(res);
      if (method === 'PUT' && parts.length === 6) {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          // 同上：与现有行合并后再校验，局部更新（只改教室）才不会被误判成 400
          return writeResult(res, store.updateSession(uid, sid, checkSession(Object.assign({}, owned, b))));
        });
      }
      if (method === 'DELETE' && parts.length === 6) return writeResult(res, store.deleteSession(uid, sid));

      if (method === 'POST' && parts.length === 7 && parts[6] === 'onward') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          return json(res, 200, store.splitSessionOnward(uid, owned.term_id, sid, checkOnward(b)));
        });
      }

      if (parts[6] === 'adjustments') {
        const week = idParam(parts[7]);
        if (week === null) return notFound(res);
        if (method === 'PUT' && parts.length === 8) {
          return readBody(req, res, (b) => {
            if (!b) throw httpError(400, 'bad body');
            // 周次以**路径**为准（body 里那份忽略）：路径是这个资源的身份，body 只是它的状态
            const fields = checkAdjustment(Object.assign({}, b, { week_no: week }));
            return json(res, 200, store.setAdjustment(uid, owned.term_id, Object.assign({ session_id: sid }, fields)));
          });
        }
        if (method === 'DELETE' && parts.length === 8) {
          const row = store.findAdjustment(uid, owned.term_id, sid, week);
          if (!row) return notFound(res);
          return writeResult(res, store.deleteAdjustment(uid, row.id));
        }
      }
    }
    return notFound(res);
  }

  return notFound(res);
}

module.exports = {
  // 导出键 = `module.json` 的 `apiPrefix`（注册表按它把 `/api/timetable` 挂到这个处理函数上）。
  // `handleTimetable` 保留**旧的参数表**（`req, res, parts, user, url`）—— 它与 `/api/admin`
  // 同款：有独立的历史与测试，不为「签名统一」去重写。这里折一次统一上下文 `ctx`，
  timetable: (c) => handleTimetable(c.req, c.res, c.parts, c.user, c.url),
};
