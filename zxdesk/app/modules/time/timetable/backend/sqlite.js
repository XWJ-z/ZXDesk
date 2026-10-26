'use strict';

/**
 * modules/timetable/backend/sqlite.js —— 课表的八张表（学期 / 时段块 / 逐节时间 / 课程 / 课次 / 单次调课 / 内置作息 / 内置版式 …）的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/sqlite.js` 按**行区间逐字节**切出来的，一个字都没重写
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

const ops = {
  /**
   * 功能：列出该账号的全部学期。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 学期行数组（按 sort_order、id 升序）
   */
  listTerms(uid) {
    return this._listSql('SELECT * FROM time_timetable_terms WHERE user_id=? ORDER BY sort_order ASC, id ASC', [uid]);
  },

  /**
   * 功能：按 id 取该账号的单个学期。
   * @param {number} uid - 用户 id
   * @param {number} id - 学期 id
   * @returns {?Object} 学期行；不存在时返回 null
   */
  getTerm(uid, id) {
    return this.db.prepare('SELECT * FROM time_timetable_terms WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：删除一个学期，并连同其下的课次、课程、逐节时间、时段块、假期调休规则与按日期的备注一并删除；
   *      返回是否删到了学期行。
   * @param {number} id - 学期 id
   * @param {number} u - 用户 id
   * @returns {boolean} 删到学期行则为 true
   */
  deleteTerm(id, u) {
    // ⭐ 0.7.1：按日期的备注引用课次（FK）⇒ 必须排在删 sessions 之前
    this.db.prepare('DELETE FROM time_timetable_day_notes WHERE term_id=? AND user_id=?').run(id, u);
    this.db.prepare('DELETE FROM time_timetable_day_rules WHERE term_id=? AND user_id=?').run(id, u);
    this.db.prepare('DELETE FROM time_timetable_adjustments WHERE term_id=? AND user_id=?').run(id, u);
    this.db.prepare('DELETE FROM time_timetable_sessions WHERE term_id=? AND user_id=?').run(id, u);
    this.db.prepare('DELETE FROM time_timetable_courses WHERE term_id=? AND user_id=?').run(id, u);
    this.db.prepare('DELETE FROM time_timetable_periods WHERE term_id=? AND user_id=?').run(id, u);
    this.db.prepare('DELETE FROM time_timetable_blocks WHERE term_id=? AND user_id=?').run(id, u);
    return this.db.prepare('DELETE FROM time_timetable_terms WHERE id=? AND user_id=?').run(id, u).changes > 0;
  },

  /**
   * 功能：清空某个学期下的课次、课程、逐节时间、时段块、假期调休规则与按日期的备注，但**保留学期本身**
   *      （供重新导入前清场）。
   * @param {number} termId - 学期 id
   * @param {number} u - 用户 id
   * @returns {void}
   */
  clearTermData(termId, u) {
    // ⭐ 0.7.1：同上 —— 引用课次的表要排在删 sessions 之前
    this.db.prepare('DELETE FROM time_timetable_day_notes WHERE term_id=? AND user_id=?').run(termId, u);
    this.db.prepare('DELETE FROM time_timetable_day_rules WHERE term_id=? AND user_id=?').run(termId, u);
    this.db.prepare('DELETE FROM time_timetable_adjustments WHERE term_id=? AND user_id=?').run(termId, u);
    this.db.prepare('DELETE FROM time_timetable_sessions WHERE term_id=? AND user_id=?').run(termId, u);
    this.db.prepare('DELETE FROM time_timetable_courses WHERE term_id=? AND user_id=?').run(termId, u);
    this.db.prepare('DELETE FROM time_timetable_periods WHERE term_id=? AND user_id=?').run(termId, u);
    this.db.prepare('DELETE FROM time_timetable_blocks WHERE term_id=? AND user_id=?').run(termId, u);
    return;
  },

  /**
   * 功能：列出某个学期下的全部时段块。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 时段块行数组（按 sort_order、id 升序）
   */
  listBlocks(uid, termId) {
    return this._listSql(
      'SELECT * FROM time_timetable_blocks WHERE user_id=? AND term_id=? ORDER BY sort_order ASC, id ASC',
      [uid, termId],
    );
  },

  /**
   * 功能：清空某个学期下的全部时段块。
   * @param {number} termId - 学期 id
   * @param {number} u - 用户 id
   * @returns {void}
   */
  clearBlocks(termId, u) {
    this.db.prepare('DELETE FROM time_timetable_blocks WHERE term_id=? AND user_id=?').run(termId, u);
  },

  /**
   * 功能：列出某个学期下的全部逐节时间。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 逐节时间行数组（按 index_no、id 升序）
   */
  listPeriods(uid, termId) {
    return this._listSql(
      'SELECT * FROM time_timetable_periods WHERE user_id=? AND term_id=? ORDER BY index_no ASC, id ASC',
      [uid, termId],
    );
  },

  /**
   * 功能：清空某个学期下的全部逐节时间。
   * @param {number} termId - 学期 id
   * @param {number} u - 用户 id
   * @returns {void}
   */
  clearPeriods(termId, u) {
    this.db.prepare('DELETE FROM time_timetable_periods WHERE term_id=? AND user_id=?').run(termId, u);
  },

  /**
   * 功能：列出某个学期下的全部课程。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 课程行数组（按 sort_order、id 升序）
   */
  listCourses(uid, termId) {
    return this._listSql(
      'SELECT * FROM time_timetable_courses WHERE user_id=? AND term_id=? ORDER BY sort_order ASC, id ASC',
      [uid, termId],
    );
  },

  /**
   * 功能：判断某门课程是否属于该账号，供越权校验使用（不通过时上层统一按「不存在」处理）。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsCourse(uid, courseId) {
    return !!this.db.prepare('SELECT id FROM time_timetable_courses WHERE id=? AND user_id=?').get(courseId, uid);
  },

  /**
   * 功能：按 id 取该账号的单门课程。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {?Object} 课程行；不存在时返回 null
   */
  getCourse(uid, courseId) {
    return this.db.prepare('SELECT * FROM time_timetable_courses WHERE id=? AND user_id=?').get(courseId, uid) || null;
  },

  /**
   * 功能：删除一门课程，并连同其下的课次一并删除；返回是否删到了课程行。
   * @param {number} id - 课程 id
   * @param {number} u - 用户 id
   * @returns {boolean} 删到课程行则为 true
   */
  deleteCourse(id, u) {
    this.db
      .prepare(
        `DELETE FROM time_timetable_adjustments
          WHERE user_id=? AND session_id IN (SELECT id FROM time_timetable_sessions WHERE course_id=? AND user_id=?)`,
      )
      .run(u, id, u);
    this.db.prepare('DELETE FROM time_timetable_sessions WHERE course_id=? AND user_id=?').run(id, u);
    return this.db.prepare('DELETE FROM time_timetable_courses WHERE id=? AND user_id=?').run(id, u).changes > 0;
  },

  /**
   * 功能：列出某个学期下的全部课次。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 课次行数组（按 weekday、period_start、id 升序）
   */
  listSessions(uid, termId) {
    return this._listSql(
      `SELECT * FROM time_timetable_sessions WHERE user_id=? AND term_id=?
        ORDER BY weekday ASC, period_start ASC, id ASC`,
      [uid, termId],
    );
  },

  /**
   * 功能：列出某门课程下的全部课次。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {Array.<Object>} 课次行数组（按 weekday、period_start、id 升序）
   */
  listCourseSessions(uid, courseId) {
    return this._listSql(
      `SELECT * FROM time_timetable_sessions WHERE user_id=? AND course_id=?
        ORDER BY weekday ASC, period_start ASC, id ASC`,
      [uid, courseId],
    );
  },

  /**
   * 功能：删除一条课次，返回是否真的删到了行。
   * @param {number} uid - 用户 id
   * @param {number} id - 课次 id
   * @returns {boolean} 删到行则为 true
   */
  deleteSession(uid, id) {
    // ⚠️ 先清它名下的单次调课：课次没了，调整行就是悬空的孤儿
    //    （不靠外键级联 —— 本文件里所有父子删除都是**手写显式删**，口径一致、也不依赖 PRAGMA foreign_keys）
    this.db.prepare('DELETE FROM time_timetable_adjustments WHERE session_id=? AND user_id=?').run(id, uid);
    return this.db.prepare('DELETE FROM time_timetable_sessions WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：列出某个学期的全部单次调课 / 停课，按周次、课次升序。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 调整行数组
   */
  listAdjustments(uid, termId) {
    return this._listSql(
      'SELECT * FROM time_timetable_adjustments WHERE user_id=? AND term_id=? ORDER BY week_no ASC, session_id ASC, id ASC',
      [uid, termId],
    );
  },

  /**
   * 功能：删掉一条单次调课 / 停课，返回是否真的删到了行。
   * @param {number} uid - 用户 id
   * @param {number} id - 调整行 id
   * @returns {boolean} 删到行则为 true
   */
  deleteAdjustment(uid, id) {
    return this.db.prepare('DELETE FROM time_timetable_adjustments WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：清空某个学期下的全部单次调课 / 停课。
   * @param {number} termId - 学期 id
   * @param {number} u - 用户 id
   * @returns {void}
   */
  clearAdjustments(termId, u) {
    this.db.prepare('DELETE FROM time_timetable_adjustments WHERE term_id=? AND user_id=?').run(termId, u);
  },

  /**
   * 功能：列出某个学期的全部**按天调休规则**，按日期升序。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 规则行数组（按 date、id 升序）
   */
  listDayRules(uid, termId) {
    return this._listSql(
      'SELECT * FROM time_timetable_day_rules WHERE user_id=? AND term_id=? ORDER BY date ASC, id ASC',
      [uid, termId],
    );
  },

  /**
   * 功能：删掉一条按天调休规则，返回是否真的删到了行。
   * @param {number} uid - 用户 id
   * @param {number} id - 规则行 id
   * @returns {boolean} 删到行则为 true
   */
  deleteDayRule(uid, id) {
    return this.db.prepare('DELETE FROM time_timetable_day_rules WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：清空某个学期下的全部按天调休规则（删学期与「重导入前清场」都要用）。
   * @param {number} termId - 学期 id
   * @param {number} u - 用户 id
   * @returns {void}
   */
  clearDayRules(termId, u) {
    this.db.prepare('DELETE FROM time_timetable_day_rules WHERE term_id=? AND user_id=?').run(termId, u);
  },

  /**
   * 功能：列出某个学期的全部**按日期的课次备注**（0.7.1），按日期、id 升序。
   *
   * 说明：⚠️ 本表的**写入不走原语层** —— 与 `time_timetable_day_rules` 同款做法：`store.js` 的
   *      `setDayNote()` 用通用的 `_insert` / `_update` 完成 upsert，唯一性由库里的
   *      `idx_tt_daynote_session` 兜底（JSON 后端没有索引，靠 store 层先查后写达到同款语义）。
   *      两个后端因此**只需要这一个读口** —— 少一处漂移的可能。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 备注行数组（按 date、id 升序）
   */
  listDayNotes(uid, termId) {
    return this._listSql(
      'SELECT * FROM time_timetable_day_notes WHERE user_id=? AND term_id=? ORDER BY date ASC, id ASC',
      [uid, termId],
    );
  },

  /**
   * 功能：删掉「某一天那节课」的那一条备注，返回是否真的删到了行（0.7.1）。
   *
   * 说明：⚠️ 与 `listDayNotes` 一样，这是本表**唯一**的删除口 —— `store.js` 的 `setDayNote()`
   *      在备注被清空时调它（而不是写一行空串），库里不留空壳行。
   * @param {number} uid - 用户 id
   * @param {number} sessionId - 课次 id
   * @param {string} date - 公历日期 `YYYY-MM-DD`
   * @returns {boolean} 删到行则为 true
   */
  deleteDayNote(uid, sessionId, date) {
    return (
      this.db
        .prepare('DELETE FROM time_timetable_day_notes WHERE user_id=? AND session_id=? AND date=?')
        .run(Number(uid), Number(sessionId), String(date)).changes > 0
    );
  },

  /**
   * 功能：把某条课次「第 `fromWeek` 周起」的调整行**改挂到另一条课次**上（「此后全部」调课劈开课次时用）。
   * @param {number} uid - 用户 id
   * @param {number} sessionId - 原课次 id
   * @param {number} newSessionId - 新课次 id
   * @param {number} fromWeek - 分界周次，>= 它的调整改挂
   * @returns {number} 改挂的行数
   */
  repointAdjustments(uid, sessionId, newSessionId, fromWeek) {
    return this.db
      .prepare('UPDATE time_timetable_adjustments SET session_id=? WHERE user_id=? AND session_id=? AND week_no>=?')
      .run(newSessionId, uid, sessionId, fromWeek).changes;
  },

  /**
   * 功能：删掉某条课次「第 `fromWeek` 周起」的调整行（「此后全部」停课时用）。
   * @param {number} uid - 用户 id
   * @param {number} sessionId - 课次 id
   * @param {number} fromWeek - 分界周次，>= 它的调整被删
   * @returns {number} 删掉的行数
   */
  dropAdjustmentsFrom(uid, sessionId, fromWeek) {
    return this.db
      .prepare('DELETE FROM time_timetable_adjustments WHERE user_id=? AND session_id=? AND week_no>=?')
      .run(uid, sessionId, fromWeek).changes;
  },

  /**
   * 功能：取某个学期的课表格子数据：课次左联课程，拼出课程名 / 简称 / 颜色，以及「课次教师优先、
   *      课程教师兜底」的教师名，形成前端可直接渲染的一份列表。
   * @param {number} termId - 学期 id
   * @param {number} u - 用户 id
   * @returns {{ cells: Array.<Object>, day_notes: Array.<Object> }} `cells` 为课表格子数组；
   *      `day_notes`（0.7.1）为按日期的课次备注，元素形如 `{ session_id, date, note }`
   */
  scheduleOf(termId, u) {
    /* eslint-disable prefer-const -- 这几行是从改造前的 db.js 原样搬来的**共享声明**：
       原代码里它们同时服务 if/else 两个分支，所以必须是 let、且 daily 需要初值（JSON 分支要走 daily++）。
       拆开后各占一个 op，lint 才会建议改 const / 去掉初值 —— 改了就属于「改逻辑」，不在本次搬家范围内。 */
    let cells;
    const rows = this._listSql(
      `SELECT s.id AS session_id, s.course_id, s.weekday, s.period_start, s.period_end,
              s.weeks, s.room, s.teacher AS session_teacher, s.remark AS session_remark,
              c.name, c.short_name, c.color, c.teacher AS course_teacher, c.remark AS course_remark
         FROM time_timetable_sessions s JOIN time_timetable_courses c ON c.id = s.course_id
        WHERE s.user_id=? AND s.term_id=?
        ORDER BY s.weekday ASC, s.period_start ASC, s.id ASC`,
      [u, termId],
    );
    cells = rows.map((r) => ({
      session_id: r.session_id,
      course_id: r.course_id,
      name: r.name,
      short_name: r.short_name || '',
      color: r.color || '',
      teacher: r.session_teacher || r.course_teacher || '',
      room: r.room || '',
      weekday: r.weekday,
      period_start: r.period_start,
      period_end: r.period_end,
      weeks: r.weeks || '',
      // 0.2.3：课次备注（这节课的作业等）与课程备注（期末考试、带电脑等）**分开带出**，前端各摆一处
      remark: r.session_remark || '',
      course_remark: r.course_remark || '',
    }));
    /* eslint-enable prefer-const */
    // ⭐ 0.7.1：把「某一天那节课的备注」一起带出 —— 前端按 `(session_id, date)`
    //    取用，只渲染**该格对应那一天**的那一条。这就是「备注只在那天显示」的落地：
    //    它不再挂在课次上，所以不会每周重复出现。
    //    ⚠️ 一次取整学期（备注是稀疏的，一学期几十条顶天），不做按周过滤 ——
    //    前端本来就要按周切片渲染，多一次往返没有收益。
    const dayNotes = this._listSql(
      'SELECT session_id, date, note FROM time_timetable_day_notes WHERE user_id=? AND term_id=?',
      [u, termId],
    );
    return { cells, day_notes: dayNotes };
  },

  /**
   * 功能：统计该账号的课表规模（学期数 / 课程数 / 课次数）。
   * @param {number} u - 用户 id
   * @returns {{ terms: number, courses: number, sessions: number }} 三类计数
   */
  countTimetable(u) {
    const r = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM time_timetable_terms           WHERE user_id=?) AS t,
                (SELECT COUNT(*) FROM time_timetable_courses         WHERE user_id=?) AS c,
                (SELECT COUNT(*) FROM time_timetable_sessions WHERE user_id=?) AS s`,
      )
      .get(u, u, u);
    return { terms: (r && r.t) || 0, courses: (r && r.c) || 0, sessions: (r && r.s) || 0 };
  },

  /**
   * 功能：本模块进个人备份的那一份读取 —— 对应原先 `exportAll()` 里课表那一段（**逐字搬运**）。
   * @param {number} uid - 账号 id
   * @returns {Object} `{ terms, pblocks, periods, courses, sessions, adjustments, day_rules, day_notes }` 八组行数组
   */
  exportTimetable(uid) {
    // 课表：**必须纳入**，否则「导出完整备份」名不副实
    const terms = this.db
      .prepare('SELECT * FROM time_timetable_terms WHERE user_id=? ORDER BY sort_order ASC, id ASC')
      .all(uid);
    const pblocks = this.db
      .prepare('SELECT * FROM time_timetable_blocks WHERE user_id=? ORDER BY term_id ASC, sort_order ASC, id ASC')
      .all(uid);
    const periods = this.db
      .prepare('SELECT * FROM time_timetable_periods WHERE user_id=? ORDER BY term_id ASC, index_no ASC, id ASC')
      .all(uid);
    const courses = this.db
      .prepare('SELECT * FROM time_timetable_courses WHERE user_id=? ORDER BY term_id ASC, sort_order ASC, id ASC')
      .all(uid);
    const sessions = this.db
      .prepare(
        'SELECT * FROM time_timetable_sessions WHERE user_id=? ORDER BY term_id ASC, weekday ASC, period_start ASC, id ASC',
      )
      .all(uid);
    // ⭐ 0.2.3 单次调课：也要进备份 —— 漏了它的表现是「备份看着成功，恢复后调过的课全变回原样」
    const adjustments = this.db
      .prepare('SELECT * FROM time_timetable_adjustments WHERE user_id=? ORDER BY term_id ASC, week_no ASC, id ASC')
      .all(uid);
    // ⭐ 0.6.2 假期调休：同样必须进备份 —— 漏了它的表现与当年漏调课那次一模一样
    //    （「备份看着成功，恢复后调休规则全没了」）
    const dayRules = this.db
      .prepare('SELECT * FROM time_timetable_day_rules WHERE user_id=? ORDER BY term_id ASC, date ASC, id ASC')
      .all(uid);
    // ⭐ 0.7.1 按日期的课次备注：同样必须进备份 —— 漏了它的表现与前两条一模一样
    //    （「备份看着成功，恢复后写的备注全没了」）
    const dayNotes = this.db
      .prepare('SELECT * FROM time_timetable_day_notes WHERE user_id=? ORDER BY term_id ASC, date ASC, id ASC')
      .all(uid);
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
