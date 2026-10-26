'use strict';

/**
 * modules/timetable/backend/json.js —— 课表的八张表（学期 / 时段块 / 逐节时间 / 课程 / 课次 / 单次调课 / 内置作息 / 内置版式 …）的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/json.js` 按**行区间逐字节**切出来的，一个字都没重写
 *    （切块前后 sha256 见 0.5.0的提交说明）。
 *    ⚠️ 课表那一段在原来那个大文件里是被 `exportAll()` 的 `return {...}` **隔开的连续两块**：
 *    前一块是**读取语句**（原样搬进文件末尾的 `exportTimetable()`，只把共享的 `let x` 改成 `const x`），
 *    后一块是 op 方法（原样进下面的 `ops`）。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._listSql()`。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.13
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/06-课表.md、docs/公共/开发方案/09-模块化重构.md
 */

const { uidOf } = require('../../../../core/store/helpers.js');

const ops = {
  /**
   * 功能：列出某个账号的全部学期，按 `sort_order`、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 学期行数组
   */
  listTerms(uid) {
    return (this.data.time_timetable_terms || [])
      .filter((t) => uidOf(t) === Number(uid))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  },

  /**
   * 功能：按 id 取一个学期，并限定归属。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 学期 id
   * @returns {?Object} 命中的学期行，未命中为 null
   */
  getTerm(uid, id) {
    return (this.data.time_timetable_terms || []).find((t) => t.id === Number(id) && uidOf(t) === Number(uid)) || null;
  },

  /**
   * 功能：删除一个学期，并级联删掉它名下的课次、课程、逐节时间、时段块。
   * @param {number} id - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {boolean} 学期行是否真的被删掉
   * 说明：六张子表按学期 id 无条件各清一遍（0.7.1 起多了 `time_timetable_day_notes`）；
   *      归属判断用的是已归一化的 `u`，所以调用方必须先 `Number(uid)`。
   */
  deleteTerm(id, u) {
    /** 功能：判断一行是否属于该账号。 */
    const mine = (x) => uidOf(x) === u;
    /** 功能：过滤掉「属于该账号且属于该学期」的行，其余原样保留。 */
    const keepOther = (arr) => (arr || []).filter((x) => !(mine(x) && Number(x.term_id) === Number(id)));
    this.data.time_timetable_day_notes = keepOther(this.data.time_timetable_day_notes);
    this.data.time_timetable_day_rules = keepOther(this.data.time_timetable_day_rules);
    this.data.time_timetable_adjustments = keepOther(this.data.time_timetable_adjustments);
    this.data.time_timetable_sessions = keepOther(this.data.time_timetable_sessions);
    this.data.time_timetable_courses = keepOther(this.data.time_timetable_courses);
    this.data.time_timetable_periods = keepOther(this.data.time_timetable_periods);
    this.data.time_timetable_blocks = keepOther(this.data.time_timetable_blocks);
    const before = (this.data.time_timetable_terms || []).length;
    this.data.time_timetable_terms = (this.data.time_timetable_terms || []).filter((t) => !(t.id === Number(id) && mine(t)));
    this._saveJson();
    return this.data.time_timetable_terms.length < before;
  },

  /**
   * 功能：清空某个学期下的课表内容（课次、课程、逐节时间、时段块），保留学期行本身。
   * @param {number} termId - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {void}
   */
  clearTermData(termId, u) {
    /** 功能：判断一行是否属于该账号且属于该学期。 */
    const mine = (x) => uidOf(x) === u && Number(x.term_id) === Number(termId);
    [
      'time_timetable_day_notes',
      'time_timetable_day_rules',
      'time_timetable_adjustments',
      'time_timetable_sessions',
      'time_timetable_courses',
      'time_timetable_periods',
      'time_timetable_blocks',
    ].forEach((t) => {
      this.data[t] = (this.data[t] || []).filter((x) => !mine(x));
    });
    this._saveJson();
  },

  /**
   * 功能：列出某个学期下的时段块（作息表），按 `sort_order`、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 时段块行数组
   */
  listBlocks(uid, termId) {
    return (this.data.time_timetable_blocks || [])
      .filter((b) => uidOf(b) === Number(uid) && Number(b.term_id) === Number(termId))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  },

  /**
   * 功能：删除某个学期下的全部时段块。
   * @param {number} termId - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {void}
   * 说明：只改内存数据，不写盘；是否落盘由调用方决定。
   */
  clearBlocks(termId, u) {
    this.data.time_timetable_blocks = (this.data.time_timetable_blocks || []).filter(
      (b) => !(uidOf(b) === u && Number(b.term_id) === Number(termId)),
    );
  },

  /**
   * 功能：列出某个学期下的逐节时间，按 `index_no`、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 逐节时间行数组
   */
  listPeriods(uid, termId) {
    return (this.data.time_timetable_periods || [])
      .filter((p) => uidOf(p) === Number(uid) && Number(p.term_id) === Number(termId))
      .sort((a, b) => (a.index_no || 0) - (b.index_no || 0) || a.id - b.id);
  },

  /**
   * 功能：删除某个学期下的全部逐节时间。
   * @param {number} termId - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {void}
   * 说明：与 `clearBlocks` 一样只改内存、不写盘，落盘时机由调用方决定。
   */
  clearPeriods(termId, u) {
    this.data.time_timetable_periods = (this.data.time_timetable_periods || []).filter(
      (p) => !(uidOf(p) === u && Number(p.term_id) === Number(termId)),
    );
  },

  /**
   * 功能：列出某个学期下的全部课程，按 `sort_order`、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 课程行数组
   */
  listCourses(uid, termId) {
    return (this.data.time_timetable_courses || [])
      .filter((c) => uidOf(c) === Number(uid) && Number(c.term_id) === Number(termId))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  },

  /**
   * 功能：判断某门课程是否属于该账号，供课次的越权检查使用。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} courseId - 课程 id
   * @returns {boolean} 属于该账号返回 true
   */
  ownsCourse(uid, courseId) {
    return (this.data.time_timetable_courses || []).some((c) => c.id === Number(courseId) && uidOf(c) === Number(uid));
  },

  /**
   * 功能：按 id 取一门课程，并限定归属。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} courseId - 课程 id
   * @returns {?Object} 命中的课程行，未命中为 null
   */
  getCourse(uid, courseId) {
    return (
      (this.data.time_timetable_courses || []).find((c) => c.id === Number(courseId) && uidOf(c) === Number(uid)) || null
    );
  },

  /**
   * 功能：删除一门课程，并连带删掉它的全部课次。
   * @param {number} id - 课程 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {boolean} 课程行是否真的被删掉
   */
  deleteCourse(id, u) {
    /** 功能：这门课名下的课次 id 集合（先算出来，删完课次就查不到了）。 */
    const sids = new Set(
      (this.data.time_timetable_sessions || [])
        .filter((s) => Number(s.course_id) === Number(id) && uidOf(s) === u)
        .map((s) => s.id),
    );
    this.data.time_timetable_adjustments = (this.data.time_timetable_adjustments || []).filter(
      (a) => !(uidOf(a) === u && sids.has(a.session_id)),
    );
    this.data.time_timetable_sessions = (this.data.time_timetable_sessions || []).filter(
      (s) => !(Number(s.course_id) === Number(id) && uidOf(s) === u),
    );
    const before = (this.data.time_timetable_courses || []).length;
    this.data.time_timetable_courses = (this.data.time_timetable_courses || []).filter(
      (c) => !(c.id === Number(id) && uidOf(c) === u),
    );
    this._saveJson();
    return this.data.time_timetable_courses.length < before;
  },

  /**
   * 功能：列出某个学期下的全部课次，按星期、起始节、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 课次行数组
   */
  listSessions(uid, termId) {
    return (this.data.time_timetable_sessions || [])
      .filter((s) => uidOf(s) === Number(uid) && Number(s.term_id) === Number(termId))
      .sort(
        (a, b) => (a.weekday || 0) - (b.weekday || 0) || (a.period_start || 0) - (b.period_start || 0) || a.id - b.id,
      );
  },

  /**
   * 功能：列出某门课程的全部课次，按星期、起始节、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} courseId - 课程 id
   * @returns {Array.<Object>} 课次行数组
   */
  listCourseSessions(uid, courseId) {
    return (this.data.time_timetable_sessions || [])
      .filter((s) => uidOf(s) === Number(uid) && Number(s.course_id) === Number(courseId))
      .sort(
        (a, b) => (a.weekday || 0) - (b.weekday || 0) || (a.period_start || 0) - (b.period_start || 0) || a.id - b.id,
      );
  },

  /**
   * 功能：删除一条课次。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 课次 id
   * @returns {boolean} 课次行是否真的被删掉
   */
  deleteSession(uid, id) {
    // ⚠️ 先清它名下的单次调课：课次没了，调整行就是悬空的孤儿（与 SQLite 后端逐字一致）
    this.data.time_timetable_adjustments = (this.data.time_timetable_adjustments || []).filter(
      (a) => !(a.session_id === Number(id) && uidOf(a) === Number(uid)),
    );
    const before = (this.data.time_timetable_sessions || []).length;
    this.data.time_timetable_sessions = (this.data.time_timetable_sessions || []).filter(
      (s) => !(s.id === Number(id) && uidOf(s) === Number(uid)),
    );
    this._saveJson();
    return this.data.time_timetable_sessions.length < before;
  },

  /**
   * 功能：列出某个学期的全部单次调课 / 停课，按周次、课次、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 调整行数组
   */
  listAdjustments(uid, termId) {
    return (this.data.time_timetable_adjustments || [])
      .filter((a) => uidOf(a) === Number(uid) && Number(a.term_id) === Number(termId))
      .sort((a, b) => (a.week_no || 0) - (b.week_no || 0) || (a.session_id || 0) - (b.session_id || 0) || a.id - b.id);
  },

  /**
   * 功能：删掉一条单次调课 / 停课。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 调整行 id
   * @returns {boolean} 调整行是否真的被删掉
   */
  deleteAdjustment(uid, id) {
    const before = (this.data.time_timetable_adjustments || []).length;
    this.data.time_timetable_adjustments = (this.data.time_timetable_adjustments || []).filter(
      (a) => !(a.id === Number(id) && uidOf(a) === Number(uid)),
    );
    this._saveJson();
    return this.data.time_timetable_adjustments.length < before;
  },

  /**
   * 功能：清空某个学期下的全部单次调课 / 停课。
   * @param {number} termId - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {void}
   */
  clearAdjustments(termId, u) {
    this.data.time_timetable_adjustments = (this.data.time_timetable_adjustments || []).filter(
      (a) => !(uidOf(a) === u && Number(a.term_id) === Number(termId)),
    );
  },

  /**
   * 功能：列出某个学期的全部按天调休规则（与 SQLite 后端语义一致）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 规则行数组（按 date、id 升序）
   */
  listDayRules(uid, termId) {
    return (this.data.time_timetable_day_rules || [])
      .filter((r) => uidOf(r) === Number(uid) && Number(r.term_id) === Number(termId))
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id - b.id);
  },

  /**
   * 功能：删掉一条按天调休规则。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 规则行 id
   * @returns {boolean} 规则行是否真的被删掉
   */
  deleteDayRule(uid, id) {
    const before = (this.data.time_timetable_day_rules || []).length;
    this.data.time_timetable_day_rules = (this.data.time_timetable_day_rules || []).filter(
      (r) => !(r.id === Number(id) && uidOf(r) === Number(uid)),
    );
    this._saveJson();
    return this.data.time_timetable_day_rules.length < before;
  },

  /**
   * 功能：清空某个学期下的全部按天调休规则。
   * @param {number} termId - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {void}
   */
  clearDayRules(termId, u) {
    this.data.time_timetable_day_rules = (this.data.time_timetable_day_rules || []).filter(
      (r) => !(uidOf(r) === u && Number(r.term_id) === Number(termId)),
    );
    this._saveJson();
  },

  /**
   * 功能：列出某个学期的全部**按日期的课次备注**（0.7.1，与 SQLite 后端语义一致）。
   *
   * 说明：⚠️ 写入同样**不走原语层**（见 SQLite 后端同名 op 的注释）—— 这里只提供读口，
   *      两个后端各一份、逐字对齐。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} termId - 学期 id
   * @returns {Array.<Object>} 备注行数组（按 date、id 升序）
   */
  listDayNotes(uid, termId) {
    return (this.data.time_timetable_day_notes || [])
      .filter((r) => uidOf(r) === Number(uid) && Number(r.term_id) === Number(termId))
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id - b.id);
  },

  /**
   * 功能：删掉「某一天那节课」的那一条备注（0.7.1，与 SQLite 后端语义一致）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} sessionId - 课次 id
   * @param {string} date - 公历日期 `YYYY-MM-DD`
   * @returns {boolean} 备注行是否真的被删掉
   */
  deleteDayNote(uid, sessionId, date) {
    const before = (this.data.time_timetable_day_notes || []).length;
    this.data.time_timetable_day_notes = (this.data.time_timetable_day_notes || []).filter(
      (r) =>
        !(
          uidOf(r) === Number(uid) &&
          Number(r.session_id) === Number(sessionId) &&
          String(r.date) === String(date)
        ),
    );
    this._saveJson();
    return this.data.time_timetable_day_notes.length < before;
  },

  /**
   * 功能：把某条课次「第 `fromWeek` 周起」的调整行改挂到另一条课次上（与 SQLite 后端语义一致）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} sessionId - 原课次 id
   * @param {(number|string)} newSessionId - 新课次 id
   * @param {(number|string)} fromWeek - 分界周次，>= 它的调整改挂
   * @returns {number} 改挂的行数
   */
  repointAdjustments(uid, sessionId, newSessionId, fromWeek) {
    let n = 0;
    (this.data.time_timetable_adjustments || []).forEach((a) => {
      if (uidOf(a) !== Number(uid)) return;
      if (a.session_id !== Number(sessionId)) return;
      if (Number(a.week_no) < Number(fromWeek)) return;
      a.session_id = Number(newSessionId);
      n++;
    });
    this._saveJson();
    return n;
  },

  /**
   * 功能：删掉某条课次「第 `fromWeek` 周起」的调整行（与 SQLite 后端语义一致）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} sessionId - 课次 id
   * @param {(number|string)} fromWeek - 分界周次，>= 它的调整被删
   * @returns {number} 删掉的行数
   */
  dropAdjustmentsFrom(uid, sessionId, fromWeek) {
    const before = (this.data.time_timetable_adjustments || []).length;
    this.data.time_timetable_adjustments = (this.data.time_timetable_adjustments || []).filter(
      (a) => !(uidOf(a) === Number(uid) && a.session_id === Number(sessionId) && Number(a.week_no) >= Number(fromWeek)),
    );
    this._saveJson();
    return before - this.data.time_timetable_adjustments.length;
  },

  /**
   * 功能：组装某个学期的课表格子 —— 把课次与课程表连起来，输出界面可直接渲染的一维单元格列表。
   * @param {number} termId - 学期 id
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {{ cells: Array.<Object> }} 每个单元格含 `session_id` / `course_id` / 课程名与短名 / 颜色 / 教师 / 教室 / 星期 / 起止节 / 周次
   * 说明：教师优先取课次上的值，为空才回退到课程上的值；只保留能在课程表里找到对应课程的课次（JSON 里没有外键，可能残留孤儿课次）。
   */
  scheduleOf(termId, u) {
    /* eslint-disable prefer-const -- 这几行是从改造前的 db.js 原样搬来的**共享声明**：
       原代码里它们同时服务 if/else 两个分支，所以必须是 let、且 daily 需要初值（JSON 分支要走 daily++）。
       拆开后各占一个 op，lint 才会建议改 const / 去掉初值 —— 改了就属于「改逻辑」，不在本次搬家范围内。 */
    let cells;
    const cmap = new Map(
      (this.data.time_timetable_courses || [])
        .filter((c) => uidOf(c) === u && Number(c.term_id) === Number(termId))
        .map((c) => [c.id, c]),
    );
    cells = (this.data.time_timetable_sessions || [])
      .filter((s) => uidOf(s) === u && Number(s.term_id) === Number(termId) && cmap.has(Number(s.course_id)))
      .sort(
        (a, b) => (a.weekday || 0) - (b.weekday || 0) || (a.period_start || 0) - (b.period_start || 0) || a.id - b.id,
      )
      .map((s) => {
        const c = cmap.get(Number(s.course_id));
        return {
          session_id: s.id,
          course_id: s.course_id,
          name: c.name,
          short_name: c.short_name || '',
          color: c.color || '',
          teacher: s.teacher || c.teacher || '',
          room: s.room || '',
          weekday: s.weekday,
          period_start: s.period_start,
          period_end: s.period_end,
          weeks: s.weeks || '',
          // 0.2.3：课次备注与课程备注分开带出，与 SQLite 后端逐字一致
          remark: s.remark || '',
          course_remark: c.remark || '',
        };
      });
    /* eslint-enable prefer-const */
    // ⭐ 0.7.1：按日期的课次备注一起带出（与 SQLite 后端**逐字一致**：同样只给这三列）
    const dayNotes = (this.data.time_timetable_day_notes || [])
      .filter((r) => uidOf(r) === u && Number(r.term_id) === Number(termId))
      .map((r) => ({ session_id: r.session_id, date: r.date, note: r.note }));
    return { cells, day_notes: dayNotes };
  },

  /**
   * 功能：统计某个账号名下有几张学期、几门课程、几条课次。
   * @param {number} u - 已转成数字的用户 id（由调用方保证）
   * @returns {{ terms: number, courses: number, sessions: number }} 三张课表主表的条数
   */
  countTimetable(u) {
    /** 功能：数出数组里属于该账号的行数，入参为空时按 0 条算。 */
    const n = (arr) => (arr || []).filter((x) => uidOf(x) === u).length;
    return {
      terms: n(this.data.time_timetable_terms),
      courses: n(this.data.time_timetable_courses),
      sessions: n(this.data.time_timetable_sessions),
    };
  },

  /**
   * 功能：本模块进个人备份的那一份读取 —— 对应原先 `exportAll()` 里课表那一段（**逐字搬运**）。
   * @param {number} uid - 账号 id
   * @returns {Object} `{ terms, pblocks, periods, courses, sessions, adjustments, day_rules, day_notes }` 八组行数组
   */
  exportTimetable(uid) {
    const d = this.data || {};
    /** 功能：深拷贝一个数组（借 JSON 序列化实现），入参为空时给空数组。 */
    const cp = (arr) => JSON.parse(JSON.stringify(arr || []));
    /** 功能：深拷贝后只保留属于该账号的行。 */
    const mine = (arr) => cp(arr).filter((r) => uidOf(r) === Number(uid));
    /** 功能：课表相关各表的统一二级排序键 —— 先按学期、再按 id。 */
    const byTerm = (a, b) => a.term_id - b.term_id || a.id - b.id;
    const terms = mine(d.time_timetable_terms).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const pblocks = mine(d.time_timetable_blocks).sort((a, b) => byTerm(a, b) || a.sort_order - b.sort_order);
    const periods = mine(d.time_timetable_periods).sort((a, b) => byTerm(a, b) || a.index_no - b.index_no);
    const courses = mine(d.time_timetable_courses).sort((a, b) => byTerm(a, b) || a.sort_order - b.sort_order);
    const sessions = mine(d.time_timetable_sessions).sort(
      (a, b) => byTerm(a, b) || a.weekday - b.weekday || a.period_start - b.period_start,
    );
    // ⭐ 0.2.3 单次调课：也要进备份 —— 漏了它的表现是「备份看着成功，恢复后调过的课全变回原样」
    const adjustments = mine(d.time_timetable_adjustments).sort((a, b) => byTerm(a, b) || a.week_no - b.week_no);
    // ⭐ 0.6.2 假期调休：同理（漏了是「恢复后调休规则全没了」）
    const dayRules = mine(d.time_timetable_day_rules).sort(
      (a, b) => byTerm(a, b) || String(a.date || '').localeCompare(String(b.date || '')),
    );
    // ⭐ 0.7.1 按日期的课次备注：同理（漏了是「备份看着成功，恢复后写的备注全没了」）
    const dayNotes = mine(d.time_timetable_day_notes).sort(
      (a, b) => byTerm(a, b) || String(a.date || '').localeCompare(String(b.date || '')),
    );
    return {
      terms,
      pblocks,
      periods,
      courses,
      sessions,
      adjustments,
      day_rules: dayRules,
      day_notes: dayNotes,
    };
  },
};

module.exports = { ops };
