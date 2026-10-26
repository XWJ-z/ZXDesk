'use strict';
/**
 * modules/timetable/store.js —— 课表（0.2.0，审查报告 B2）
 *
 * 功能：存储层的课表业务方法集合，按「学期 → 时段块（作息）→ 逐节时间 → 课程 → 课次」五级模型组织：
 *      `listTerms` / `getTerm` / `createTerm` / `updateTerm` / `deleteTerm` / `clearTermData` 负责学期；
 *      `listBlocks` / `replaceBlocks` 与 `listPeriods` / `replacePeriods` 负责作息与逐节时间；
 *      `listCourses` / `getCourse` / `createCourse` / `updateCourse` / `deleteCourse` 负责课程；
 *      `listSessions` / `listCourseSessions` / `createSession` / `updateSession` / `deleteSession` 负责课次；
 *      `listAdjustments` / `findAdjustment` / `setAdjustment` / `deleteAdjustment` 负责**单次调课 / 停课**，
 *      `splitSessionOnward` 负责「此后全部」（劈周次，不写调整表）；
 *      `commitTimetable` 做导入落库，`scheduleOf` 输出某个学期的完整课表。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⚠️ 方法体是从改造前的 `db.js` 按字节切出来的（分岔那段搬去了 backend/*.js）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/timetable.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了 4 行 require 的相对路径：
 *    核心的 `helpers.js` 与**留在 `core/` 的**日期 / 调课 / 配色工具，以及本模块自己的
 *    `lib/school-templates.js`。⚠️ 课表语义（周次模型 / 调课两个口径 / 假日 / 配色）一个字都没改。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.52
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/06-课表.md
 */
const { nowStamp, numOr, sessionSig } = require('../../../core/store/helpers.js');
const { pickCourseColor } = require('./lib/palette.js');
const { splitWeeks, weeksInclude, maxWeekOf } = require('../../../core/timetable/date-util.js');
const AU = require('../../../core/timetable/adjust-util.js');

/**
 * ⭐ 0.7.2：本节备注自动建出来的**日常任务**的标题前缀（
 *    「【课表任务】+ 备注原文」）。任务标题 = 前缀 + 备注原文 ⇒ **回写备注时要把它摘掉**
 *    （见 `syncDayNoteFromTask()`）—— 去程与回程共用这一个常量，⛔ 别各写一遍字面量
 *    （写歪了的表现是「改一次任务标题，备注里就多一个【课表任务】」）。
 */
const NOTE_TASK_PREFIX = '【课表任务】';

module.exports = {
  // ---- 学期 ----
  /**
   * 功能：列出某个用户的全部学期，按 `sort_order`、`id` 升序。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 学期行数组（无数据时为空数组）
   */
  listTerms(uid) {
    return this._bk.listTerms(uid);
  },

  /**
   * 功能：按 id 取单个学期。
   * @param {number} uid - 用户 id
   * @param {number} id - 学期 id
   * @returns {?Object} 学期行；不存在或不属于该用户时为 null
   */
  getTerm(uid, id) {
    return this._bk.getTerm(uid, id);
  },

  /**
   * 功能：判断某个学期是否存在且属于该用户。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {boolean} true = 学期归该用户所有
   */
  ownsTerm(uid, termId) {
    return !!this.getTerm(uid, termId);
  },

  /**
   * 功能：校验学期归属：不属于 uid（或不存在）→ 404。用于所有带 `:termId` 的子资源路由。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {void}
   * @throws {Error} 学期不存在或不属于该用户时抛出（`err.status = 404`）
   */
  _assertTermOwned(uid, termId) {
    if (!this.ownsTerm(uid, termId)) {
      const err = new Error('学期不存在');
      err.status = 404;
      throw err;
    }
  },

  /**
   * 功能：新建一个学期，未给的字段一律走默认值（名称缺省为「未命名学期」、总周数缺省 17 周）。
   * @param {number} uid - 用户 id
   * @param {Object} input - 学期字段（`name` / `start_monday` / `total_weeks` / `remark` / `meta` / `sort_order`）
   * @returns {Object} 新插入的学期行（含自增 id）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  createTerm(uid, input) {
    const row = {
      user_id: Number(uid),
      name: input.name || '未命名学期',
      start_monday: input.start_monday || null,
      total_weeks: numOr(input.total_weeks, 17),
      remark: input.remark || '',
      meta: input.meta || '',
      holiday_advance_minutes: numOr(input.holiday_advance_minutes, 0),
      holiday_pm_from: input.holiday_pm_from || '',
      sort_order: numOr(input.sort_order, 0),
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    return this._insert('time_timetable_terms', row);
  },

  /**
   * 功能：局部更新学期字段，只写入请求里真的带了的列，并刷新 `updated_at`。
   * @param {number} uid - 用户 id
   * @param {number} id - 学期 id
   * @param {Object} input - 待更新的字段集
   * @returns {boolean} 是否真的有行被更新（没有可写列或目标不存在时为 false）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  updateTerm(uid, id, input) {
    return this._update('time_timetable_terms', uid, id, input);
  },

  /**
   * 功能：删学期 —— 级联删掉它的时段块 / 逐节时间 / 课程 / 课次。
   * 说明：⚠️ 级联的每一条删除都带 `user_id` 条件，避免跨用户误删。
   * @param {number} uid - 用户 id
   * @param {number} id - 学期 id
   * @returns {boolean} 是否删掉了学期行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  deleteTerm(uid, id) {
    this._assertWritable();
    const u = Number(uid);
    return this._bk.deleteTerm(id, u);
  },

  /**
   * 功能：清空某个学期的课表内容（保留学期行本身）—— 给导入的「覆盖」策略用。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {void}
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不存在或不属于该用户时抛出（`err.status = 404`）
   */
  clearTermData(uid, termId) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    return this._bk.clearTermData(termId, u);
  },

  // ---- 时段块（作息）----
  /**
   * 功能：列出某学期的全部时段块（作息），按 `sort_order`、`id` 升序。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 时段块行数组（无数据时为空数组）
   */
  listBlocks(uid, termId) {
    return this._bk.listBlocks(uid, termId);
  },

  /**
   * 功能：整份替换某学期的时段块（先清空、再按入参顺序重建），并返回带 id 的新行。
   * 说明：返回 id 是必需的 —— 调用方紧接着要用 `generatePeriods(blocks)` 生成逐节时间，
   *      而 `periods.block_id` 必须指向真实存在的块。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {Array.<Object>} blocks - 时段块数组，元素含 `label` / `sort_order` / `start_time` / `end_time` /
   *     `period_count` / `class_minutes` / `break_minutes`（缺省走默认值）
   * @returns {Array.<Object>} 新插入的时段块行（顺序同入参）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不存在或不属于该用户时抛出（`err.status = 404`）
   */
  replaceBlocks(uid, termId, blocks) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    this._bk.clearBlocks(termId, u);
    return (blocks || []).map((b, i) =>
      this._insert('time_timetable_blocks', {
        user_id: u,
        term_id: Number(termId),
        label: b.label || '',
        sort_order: numOr(b.sort_order, i),
        start_time: b.start_time || '',
        end_time: b.end_time || '',
        period_count: numOr(b.period_count, 0),
        class_minutes: numOr(b.class_minutes, 45),
        break_minutes: numOr(b.break_minutes, 5),
      }),
    );
  },

  // ---- 逐节时间表 ----
  /**
   * 功能：列出某学期的逐节时间表，按 `index_no`、`id` 升序。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 逐节时间行数组（无数据时为空数组）
   */
  listPeriods(uid, termId) {
    return this._bk.listPeriods(uid, termId);
  },

  /**
   * 功能：整份替换某学期的逐节时间表（先清空、再按 `index_no` 全量重建），并返回带 id 的新行。
   * 说明：`periods` 是纯派生物，按 `index_no` 全量重建最不容易错。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {Array.<Object>} periods - 逐节时间数组，元素含 `index_no` / `block_id` / `start_time` / `end_time`
   * @returns {Array.<Object>} 新插入的逐节时间行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不存在或不属于该用户时抛出（`err.status = 404`）
   */
  replacePeriods(uid, termId, periods) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    this._bk.clearPeriods(termId, u);
    return (periods || []).map((p) =>
      this._insert('time_timetable_periods', {
        user_id: u,
        term_id: Number(termId),
        index_no: numOr(p.index_no, 0),
        block_id: p.block_id === undefined || p.block_id === null ? null : Number(p.block_id),
        start_time: p.start_time || '',
        end_time: p.end_time || '',
      }),
    );
  },

  // ---- 课程 ----
  /**
   * 功能：列出某学期的全部课程，按 `sort_order`、`id` 升序。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 课程行数组（无数据时为空数组）
   */
  listCourses(uid, termId) {
    return this._bk.listCourses(uid, termId);
  },

  /**
   * 功能：判断某课程是否存在且属于该用户。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {boolean} true = 课程归该用户所有
   */
  ownsCourse(uid, courseId) {
    return this._bk.ownsCourse(uid, courseId);
  },

  /**
   * 功能：校验课程归属：不属于 uid（或不存在）→ 404；通过则直接返回该课程行，省去调用方再查一次。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {Object} 校验通过的课程行
   * @throws {Error} 课程不存在或不属于该用户时抛出（`err.status = 404`）
   */
  _assertCourseOwned(uid, courseId) {
    if (!this.ownsCourse(uid, courseId)) {
      const err = new Error('课程不存在');
      err.status = 404;
      throw err;
    }
    return this.getCourse(uid, courseId);
  },

  /**
   * 功能：按 id 取单门课程。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {?Object} 课程行；不存在或不属于该用户时为 null
   */
  getCourse(uid, courseId) {
    return this._bk.getCourse(uid, courseId);
  },

  /**
   * 功能：在某学期下新建课程，未给的字段走默认值（名称缺省为「未命名课程」）。
   * 说明：写库前先校验 `input.term_id` 的归属，避免把课程挂到别人的学期上。
   * @param {number} uid - 用户 id
   * @param {Object} input - 课程字段（`term_id` / `name` / `short_name` / `teacher` / `color` / `sort_order`）
   * @returns {Object} 新插入的课程行（含自增 id）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不存在或不属于该用户时抛出（`err.status = 404`）
   */
  createCourse(uid, input) {
    this._assertTermOwned(uid, input.term_id);
    const termId = Number(input.term_id);
    // ⭐ 0.2.3：没给颜色就按「这门课在学期里的次序」从调色板取一个 ——
    //    以前没人定颜色，导入进来的课全是空 → 前端统统回落同一个默认蓝，整张课表一片同色。
    //    ⚠️ 用**现有课程数**而不是 `input.sort_order`：接口那层的 `checkCourse` 会把没传的
    //    `sort_order` 兜成 0，拿它当序号的话每门课都会取到同一个颜色（这正是测试抓到的那次）。
    //    计数对「导入」也成立：新/覆盖模式先清空学期再从 0 数起，追加模式接着已有的数。
    const slot = this.listCourses(uid, termId).length;
    const row = {
      user_id: Number(uid),
      term_id: termId,
      name: input.name || '未命名课程',
      short_name: input.short_name || '',
      teacher: input.teacher || '',
      color: input.color || pickCourseColor(slot),
      remark: input.remark || '',
      sort_order: numOr(input.sort_order, 0),
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    return this._insert('time_timetable_courses', row);
  },

  /**
   * 功能：局部更新课程字段，只写入请求里真的带了的列，并刷新 `updated_at`。
   * @param {number} uid - 用户 id
   * @param {number} id - 课程 id
   * @param {Object} input - 待更新的字段集
   * @returns {boolean} 是否真的有行被更新（没有可写列或目标不存在时为 false）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  updateCourse(uid, id, input) {
    return this._update('time_timetable_courses', uid, id, input);
  },

  /**
   * 功能：删课程 —— 级联删掉它名下的课次。
   * 说明：⚠️ 级联的两条删除都带 `user_id` 条件，避免跨用户误删。
   * @param {number} uid - 用户 id
   * @param {number} id - 课程 id
   * @returns {boolean} 是否删掉了课程行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  deleteCourse(uid, id) {
    this._assertWritable();
    const u = Number(uid);
    return this._bk.deleteCourse(id, u);
  },

  // ---- 课次 ----
  /**
   * 功能：列出某学期的全部课次，按 `weekday`、`period_start`、`id` 升序。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 课次行数组（无数据时为空数组）
   */
  listSessions(uid, termId) {
    return this._bk.listSessions(uid, termId);
  },

  /**
   * 功能：列出某门课程下的全部课次（先校验该课程的归属）。
   * @param {number} uid - 用户 id
   * @param {number} courseId - 课程 id
   * @returns {Array.<Object>} 课次行数组（无数据时为空数组）
   * @throws {Error} 课程不存在或不属于该用户时抛出（`err.status = 404`）
   */
  listCourseSessions(uid, courseId) {
    this._assertCourseOwned(uid, courseId);
    return this._bk.listCourseSessions(uid, courseId);
  },

  /**
   * 功能：在某门课程下新建课次；`term_id` 由课程的归属推导，不取调用方给的值。
   * 说明：`period_end` 缺省时回落到 `period_start`，保证单节课也有合法的节次区间。
   * @param {number} uid - 用户 id
   * @param {Object} input - 课次字段（`course_id` / `weekday` / `period_start` / `period_end` /
   *     `weeks` / `room` / `teacher`）
   * @returns {Object} 新插入的课次行（含自增 id）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；课程不存在或不属于该用户时抛出（`err.status = 404`）
   */
  createSession(uid, input) {
    const course = this._assertCourseOwned(uid, input.course_id);
    const row = {
      user_id: Number(uid),
      term_id: Number(course.term_id),
      course_id: Number(input.course_id),
      weekday: numOr(input.weekday, 1),
      period_start: numOr(input.period_start, 1),
      period_end: numOr(input.period_end, numOr(input.period_start, 1)),
      weeks: input.weeks || '',
      room: input.room || '',
      teacher: input.teacher || '',
      remark: input.remark || '',
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    return this._insert('time_timetable_sessions', row);
  },

  /**
   * 功能：局部更新课次字段，只写入请求里真的带了的列，并刷新 `updated_at`。
   * @param {number} uid - 用户 id
   * @param {number} id - 课次 id
   * @param {Object} input - 待更新的字段集
   * @returns {boolean} 是否真的有行被更新（没有可写列或目标不存在时为 false）
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  updateSession(uid, id, input) {
    return this._update('time_timetable_sessions', uid, id, input);
  },

  /**
   * 功能：删掉一条课次。
   * @param {number} uid - 用户 id
   * @param {number} id - 课次 id
   * @returns {boolean} 是否删掉了课次行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  deleteSession(uid, id) {
    this._assertWritable();
    return this._bk.deleteSession(uid, id);
  },

  // ---- 单次调课 / 停课（0.2.3）----
  /**
   * 功能：造一个带 HTTP 状态码的业务错误 —— 存储层不 require `http-util`（依赖方向必须单向），
   *      所以这里只负责把 `status` 挂到 Error 上，由路由层的错误出口统一成响应。
   * @param {number} status - HTTP 状态码（本模块只会用 400 / 404）
   * @param {string} message - 给用户看的中文原因
   * @returns {Error} 带 `status` 的错误对象
   */
  _ttErr(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
  },

  /**
   * 功能：列出某个学期的全部单次调课 / 停课。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 调整行数组
   */
  listAdjustments(uid, termId) {
    return this._bk.listAdjustments(uid, termId);
  },

  /**
   * 功能：删掉一条单次调课 / 停课（「撤销这次调课」）。
   * @param {number} uid - 用户 id
   * @param {number} id - 调整行 id
   * @returns {boolean} 是否真的删到了行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  deleteAdjustment(uid, id) {
    this._assertWritable();
    return this._bk.deleteAdjustment(uid, id);
  },

  /**
   * 功能：按 id 与归属取一条调整行。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {number} sessionId - 课次 id
   * @param {number} weekNo - 周次
   * @returns {?Object} 命中的调整行；没有则为 null
   */
  findAdjustment(uid, termId, sessionId, weekNo) {
    return (
      this.listAdjustments(uid, termId).find(
        (a) => Number(a.session_id) === Number(sessionId) && Number(a.week_no) === Number(weekNo),
      ) || null
    );
  },

  /**
   * 功能：把「目标落点」补齐并校验到合法范围（`to_*` 逐项回落到课次原值）。
   *
   * 说明：⚠️ 节次必须落在该学期**真有的节次范围**内：写一个第 20 节进去，网格里根本没有那一行 ——
   *      课会凭空消失，用户只看到「调完课没了」。宁可当场 400 并告诉他先去设作息。
   *
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {Object} input - 请求体（可含 `to_weekday` / `to_period_start` / `to_period_end` / `to_room`）
   * @param {Object} session - 被调整的课次行（用作回落值）
   * @returns {{weekday: number, period_start: number, period_end: number, room: string}} 补齐后的落点
   * @throws {Error} 节次倒置或超出学期节次范围时抛出（`err.status = 400`）
   */
  _resolveSlot(uid, termId, input, session) {
    const nums = this.listPeriods(uid, termId)
      .map((p) => numOr(p.index_no, 0))
      .filter((n) => n > 0);
    const lo = nums.length ? Math.min(...nums) : 0;
    const hi = nums.length ? Math.max(...nums) : 0;
    const givenStart = input.to_period_start !== undefined && input.to_period_start !== null;
    const givenEnd = input.to_period_end !== undefined && input.to_period_end !== null;
    const start = numOr(input.to_period_start, numOr(session.period_start, lo || 1));
    // ⚠️ 与 `adjust-util.slotOf()` 同一条规矩：`to_period_end` 缺省时回落到**原本的止节**。
    //    回落到新的起节会把「周三第 3-4 节 → 周五」变成「周五只有第 3 节」，白吃一节课。
    const rawEnd = numOr(input.to_period_end, numOr(session.period_end, start));
    const end = rawEnd < start ? start : rawEnd;
    if (end < start) throw this._ttErr(400, '结束节次不能早于开始节次');
    // ⚠️ **只检查用户显式指定的节次**：老数据 / 导入数据里课次的节次可能本来就超出作息表的范围
    //    （种子与真实库里都出现过）。那种情况下「改到周五、节次不动」是**合法**的，
    //    拿范围去卡它会把正常操作打成 400，而且提示词还是「先去设作息」—— 用户会一头雾水。
    //    网格本来就只画 `periods` 里有的行，这是数据层面的既成状态，不是调课造成的。
    if (nums.length && ((givenStart && (start < lo || start > hi)) || (givenEnd && (end < lo || end > hi)))) {
      throw this._ttErr(400, `节次要落在第 ${lo}–${hi} 节之间（这个学期的作息只有这些节次，先在「作息设置」里加）`);
    }
    const room =
      input.to_room === undefined || input.to_room === null ? session.room || '' : String(input.to_room).trim();
    return { weekday: numOr(input.to_weekday, numOr(session.weekday, 1)), period_start: start, period_end: end, room };
  },

  /**
   * 功能：写入（或覆盖）**某一周**的单次调课 / 停课 —— 同一(课次, 周次)只有一行。
   *
   * 说明：⭐ 「本节」口径的落点。校验顺序刻意是「归属 → 这一周有没有课 → 落点合法性 → 撞车」——
   *      每一步失败都给出**用户能照着改**的中文原因（哪一周、撞的是哪门课）。
   *      ⚠️ 撞车必须**在写库之前**判出来：画出来才发现两门课重叠，用户是看不出问题的。
   *
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {Object} input - `session_id` / `week_no` / `kind`（'move' | 'cancel'）/ `to_weekday` /
   *     `to_period_start` / `to_period_end` / `to_room` / `note` / ⭐ `to_week_no`（调到第几周；
   *     空或与 `week_no` 相同 = 同周换时间 —— 跨周调课）
   * @returns {Object} 写入后的调整行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；参数不合法抛出（`err.status = 400`）；
   *     课次或学期不存在抛出（`err.status = 404`）
   */
  setAdjustment(uid, termId, input) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    const tid = Number(termId);
    const sid = numOr(input.session_id, 0);
    const session = this.listSessions(u, tid).find((s) => Number(s.id) === sid);
    if (!session) throw this._ttErr(404, '课次不存在');
    const week = numOr(input.week_no, 0);
    if (!weeksInclude(session.weeks, week)) {
      throw this._ttErr(400, `第 ${week} 周本来就没有这节课（它的周次是「${session.weeks}」），不用调`);
    }
    const kind = input.kind === AU.KIND_CANCEL ? AU.KIND_CANCEL : AU.KIND_MOVE;
    const fields = {
      week_no: week,
      // ⭐ 跨周调课的目标周；`null` = 同周换时间（老行为）
      to_week_no: null,
      kind,
      to_weekday: null,
      to_period_start: null,
      to_period_end: null,
      to_room: '',
      note: input.note || '',
    };
    if (kind === AU.KIND_MOVE) {
      const slot = this._resolveSlot(u, tid, input, session);
      // ⭐ 目标周：缺省 = 源周（同周换时间）。跨周调课**只要求那一格是空的** —— 同一门课在目标周
      //    本来还有课也放行（「大学老师有事情调到后面一起上的太多了」）。
      const toWeek = numOr(input.to_week_no, 0) || week;
      const term = this.listTerms(u).find((t) => Number(t.id) === tid);
      const totalWeeks = numOr(term && term.total_weeks, 0);
      if (toWeek !== week && totalWeeks > 0 && toWeek > totalWeeks) {
        throw this._ttErr(400, `调到第 ${toWeek} 周超出了这个学期的总周数（${totalWeeks} 周）`);
      }
      const clash = AU.findConflict(
        this.scheduleOf(u, tid).cells,
        this.listAdjustments(u, tid),
        toWeek,
        slot,
        sid,
        // ⚠️ 跨周时用**本位落点**比对：源周那一次已经不上了，但同一门课若在目标周本来还有一节、
        //    且正好压在目标格上，那是真撞车（同一门课自己也算）。
        { selfAsOrigin: toWeek !== week },
      );
      if (clash) {
        throw this._ttErr(
          400,
          `第 ${toWeek} 周这个时间已经有《${clash.name}》了${clash.room ? '（' + clash.room + '）' : ''}，换一个节次或先调开它`,
        );
      }
      fields.to_week_no = toWeek === week ? null : toWeek;
      fields.to_weekday = slot.weekday;
      fields.to_period_start = slot.period_start;
      fields.to_period_end = slot.period_end;
      fields.to_room = slot.room;
    }
    const existing = this.findAdjustment(u, tid, sid, week);
    if (existing) {
      this._update('time_timetable_adjustments', u, existing.id, Object.assign({}, fields, { updated_at: nowStamp() }));
      return this.findAdjustment(u, tid, sid, week);
    }
    return this._insert(
      'time_timetable_adjustments',
      Object.assign(
        {
          user_id: u,
          term_id: tid,
          session_id: sid,
          created_at: nowStamp(),
          updated_at: nowStamp(),
        },
        fields,
      ),
    );
  },

  /**
   * 功能：**此后全部**改时间 / 停课 —— 把课次的 `weeks` 在 `from_week` 处劈成两半。
   *
   * 说明：⭐ 「修改调课时要有选项：本节、此后全部」。
   *      「此后全部」**刻意不写调整表**，而是把「第 1-16 周」直接劈成两条普通课次
   *      （`date-util.splitWeeks`，单双周后缀跟着段走）—— 渲染层一行都不用改，
   *      也不会出现「规则叠规则」的解释歧义。
   *      · `kind='move'` 且前半非空 → 原课次截到 `from-1` 周，另立一条新课次从 `from` 周起；
   *        前半为空（从第一周就改）→ 直接改原课次，不新增行；
   *      · `kind='cancel'` → 只截不留；前半为空意味着「整门课都不上了」→ 删掉这条课次；
   *      · ⚠️ 原本挂在 `session_id` 上、周次 `>= from` 的**单次调整跟着搬**：调课改成把调整
   *        改挂到新课次（`repointAdjustments`），停课则把那些周次的调整删掉（那些周已经不存在了）。
   *      ⚠️ 整个过程放在**一个事务**里（与 `commitTimetable` 同款）：劈到一半失败会留下
   *      「两条课次都缺一截」的半成品，那比不做更糟。
   *
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {number} sessionId - 被调整的课次 id
   * @param {Object} input - `from_week` / `kind` / `to_weekday` / `to_period_start` / `to_period_end` / `to_room`
   * @returns {Object} `{ session_id, new_session_id, weeks_before, weeks_after, cancelled, moved_rows, dropped_rows }`
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；参数不合法 / 撞车抛出（`err.status = 400`）；
   *     学期或课次不存在抛出（`err.status = 404`）
   */
  splitSessionOnward(uid, termId, sessionId, input) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    const tid = Number(termId);
    const sid = numOr(sessionId, 0);
    const session = this.listSessions(u, tid).find((s) => Number(s.id) === sid);
    if (!session) throw this._ttErr(404, '课次不存在');
    const from = numOr(input.from_week, 0);
    if (from < 1) throw this._ttErr(400, '「从第几周起」必须是正整数（先切到具体某一周再调）');
    if (!weeksInclude(session.weeks, from)) {
      throw this._ttErr(400, `第 ${from} 周本来就没有这节课（它的周次是「${session.weeks}」），不用调`);
    }
    const sp = splitWeeks(session.weeks, from);
    if (!sp.ok) throw this._ttErr(400, '这条课次的周次读不出来：' + sp.error);
    const kind = input.kind === AU.KIND_CANCEL ? AU.KIND_CANCEL : AU.KIND_MOVE;

    const run = () => {
      if (kind === AU.KIND_CANCEL) {
        // 前半为空 = 从第一周起就停 ⇒ 这条课次整个不要了（deleteSession 会连带清掉它的调整）
        if (!sp.before) {
          this.deleteSession(u, sid);
          return { session_id: sid, new_session_id: null, weeks_before: '', weeks_after: '', cancelled: true };
        }
        this._update('time_timetable_sessions', u, sid, { weeks: sp.before, updated_at: nowStamp() });
        // 那些周次已经不在课次上了，挂在上面的单次调整跟着删（否则是一堆永远不生效的孤儿）
        const dropped = this._bk.dropAdjustmentsFrom(u, sid, from);
        return {
          session_id: sid,
          new_session_id: null,
          weeks_before: sp.before,
          weeks_after: '',
          cancelled: false,
          dropped_rows: dropped,
        };
      }

      const slot = this._resolveSlot(u, tid, input, session);
      const cells = this.scheduleOf(u, tid).cells;
      const adjustments = this.listAdjustments(u, tid);
      // 逐周查撞车：改的是「从第 W 周起的每一周」，只在第一周查会漏掉后面几周的冲突
      const last = maxWeekOf(sp.after);
      for (let w = from; w <= last; w++) {
        if (!weeksInclude(sp.after, w)) continue;
        const clash = AU.findConflict(cells, adjustments, w, slot, sid);
        if (clash) {
          throw this._ttErr(
            400,
            `第 ${w} 周这个时间已经有《${clash.name}》了${clash.room ? '（' + clash.room + '）' : ''}，换一个节次或先调开它`,
          );
        }
      }
      const patch = {
        weekday: slot.weekday,
        period_start: slot.period_start,
        period_end: slot.period_end,
        room: slot.room,
        updated_at: nowStamp(),
      };
      if (!sp.before) {
        // 整条课次都落在「此后」里 ⇒ 就地改，不新增行
        this._update('time_timetable_sessions', u, sid, patch);
        return { session_id: sid, new_session_id: null, weeks_before: '', weeks_after: sp.after, moved_rows: 0 };
      }
      this._update('time_timetable_sessions', u, sid, { weeks: sp.before, updated_at: nowStamp() });
      const created = this._insert('time_timetable_sessions', {
        user_id: u,
        term_id: tid,
        course_id: Number(session.course_id),
        weekday: slot.weekday,
        period_start: slot.period_start,
        period_end: slot.period_end,
        weeks: sp.after,
        room: slot.room,
        // ⚠️ 教师与**课堂备注**跟着继承：语义上它就是同一条课次的延续，重新填一遍是骚扰用户
        teacher: session.teacher || '',
        remark: session.remark || '',
        created_at: nowStamp(),
        updated_at: nowStamp(),
      });
      const moved = this._bk.repointAdjustments(u, sid, created.id, from);
      return {
        session_id: sid,
        new_session_id: created.id,
        weeks_before: sp.before,
        weeks_after: sp.after,
        moved_rows: moved,
      };
    };

    if (this.backend !== 'sqlite') return run();
    this.db.exec('BEGIN');
    try {
      const r = run();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略 */
      }
      throw e;
    }
  },

  // ---- ⭐ 0.6.2 假期调休（按天）—— 与上面的「按课次调课」是**两件独立的事** ----

  /**
   * 功能：列出某个学期的全部按天调休规则。
   *
   * 说明：⭐ 与 `listAdjustments()`（按课次调课）**正交**：那张表管「老师把某一节课挪了」，
   *      这张表管「学校通知某一天整体怎么上」。同一天可以两层叠加，各算各的。
   *
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 规则行数组（按日期升序）
   */
  listDayRules(uid, termId) {
    return this._bk.listDayRules(uid, termId);
  },

  /**
   * 功能：列出某个学期的全部**按日期的课次备注**（0.7.1）。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {Array.<Object>} 备注行数组（按 date、id 升序）
   */
  listDayNotes(uid, termId) {
    return this._bk.listDayNotes(uid, termId);
  },

  /**
   * 功能：录入 / 更新一条按天调休规则（**按日期 upsert** —— 同一天只留一条）。
   *
   * 说明：⭐ 「学校发的那种假期调休」（A 日补 B 日 / 某天停课），
   *      **纯手动录入** —— 各校通知不一样，不做自动识别。
   *      ⚠️ 为什么是 upsert 而不是只新增：表上有 `(user_id, term_id, date)` 唯一索引，
   *      一天只可能有一条规则；用户改主意时直觉是「再录一遍覆盖掉」，
   *      回他一个「已存在」的 400 只会让人困惑。
   *
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {Object} input - 归一化后的字段 `{ date, kind, to_date, note }`
   * @returns {Object} 落库后的规则行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不属于本人时抛出（`err.status = 404`）
   */
  setDayRule(uid, termId, input) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    const tid = Number(termId);
    const src = input || {};
    const date = String(src.date || '').trim();
    const kind = src.kind === 'swap' ? 'swap' : 'off';
    const fields = {
      date,
      kind,
      to_date: kind === 'swap' ? String(src.to_date || '').trim() : null,
      note: String(src.note || ''),
    };
    const existing = this.listDayRules(u, tid).find((r) => String(r.date) === date);
    if (existing) {
      this._update('time_timetable_day_rules', u, existing.id, Object.assign({}, fields, { updated_at: nowStamp() }));
      return this.listDayRules(u, tid).find((r) => Number(r.id) === Number(existing.id)) || null;
    }
    return this._insert(
      'time_timetable_day_rules',
      Object.assign({ user_id: u, term_id: tid, created_at: nowStamp(), updated_at: nowStamp() }, fields),
    );
  },

  /**
   * 功能：删掉一条按天调休规则（「取消这次调休」）。
   * @param {number} uid - 用户 id
   * @param {number} id - 规则行 id
   * @returns {boolean} 是否真的删到了行
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）
   */
  deleteDayRule(uid, id) {
    this._assertWritable();
    return this._bk.deleteDayRule(uid, id);
  },

  /**
   * 功能：写 / 清一条「**本节备注**」（某一天那节课的，0.7.1）—— 备注去空白后为空 = **删掉这一条**。
   *
   * 说明：⭐ **这是 修订后的落地点**。原先把「课堂备注」挂在**课次**上，而课次是按周重复的
   *      （周三 3-4 节 · 1-16 周）⇒ 写一条，这 16 周**每周那天都显示**。要的是
   *      「**只要那一天显示**」，于是身份改成 `(session_id, date)`：同一节课每天各一条、互不串味。
   *      ⚠️ upsert 在**业务层**里"先查后写"（与上面的 `setDayRule()` 同款）：SQLite 另有唯一索引
   *      兜底、JSON 后端没有索引 ⇒ 这条路径是**两个后端唯一的共同保证**，⛔ 别改成裸 insert
   *      （反复保存会越写越多，而且只在 JSON 后端上表现 —— 那种"只有一个后端坏"的 bug 最难查）。
   *      ⚠️ 归一化：`note` 一律 `trim()`（与前端 `value.trim()` 同口径，避免"看着是空的却存住了"）。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @param {Object} input - `{ session_id, date, note }`；`date` 必须是 `YYYY-MM-DD`
   * @returns {?Object} 写后的行；被清掉时为 null
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不属于该账号时抛出（`err.status = 404`）
   */
  setDayNote(uid, termId, input) {
    this._assertWritable();
    this._assertTermOwned(uid, termId);
    const u = Number(uid);
    const tid = Number(termId);
    const src = input || {};
    const sid = Number(src.session_id);
    const date = String(src.date || '').trim();
    const note = String(src.note == null ? '' : src.note).trim();
    const existing = this.listDayNotes(u, tid).find(
      (r) => Number(r.session_id) === sid && String(r.date) === date,
    );
    if (!note) {
      if (!existing) return null;
      // ⭐ 0.7.2：清空备注时**那条任务怎么办** —— 由调用方决定（前端会弹窗问）：
      //    `drop_task !== false` ⇒ 任务一起删（API 层的默认口径）；显式传 false ⇒ 留下任务、只解绑。
      //    ⚠️ 默认值刻意选「一起删」而不是「默默留下」：选的口径是「询问」，
      //    那么**没问**的那些调用方（脚本 / 将来的新入口）就该落到最自洽的一侧 ——
      //    「两者本质是同一个」，不留孤儿任务。
      if (src.drop_task !== false) this._dropNoteTask(u, existing.task_id);
      this._bk.deleteDayNote(u, sid, date);
      return null;
    }
    // ⭐ 0.7.2：备注与「日常任务」是**同一个东西的两个视图**（
    //    「这个任务要和备注绑定，他们本质是同一个，做一个 id 绑定，修改要同步」）。
    //    新建备注 ⇒ 建一条任务；改备注 ⇒ 改**那条**任务的标题（不新建）⇒ 改几次都只有一条。
    //    ⭐ 0.7.2：**建不建由调用方决定** —— `with_task: false` 时（前端弹窗问过、选了「不加」）
    //    只存备注；已绑定的一律照常同步标题（见 `_syncNoteTask` 的说明）。
    const taskId = this._syncNoteTask(u, existing ? existing.task_id : 0, note, date, src.with_task);
    if (existing) {
      this._update('time_timetable_day_notes', u, existing.id, {
        note,
        task_id: taskId,
        updated_at: nowStamp(),
      });
      return this.listDayNotes(u, tid).find((r) => Number(r.id) === Number(existing.id)) || null;
    }
    return this._insert(
      'time_timetable_day_notes',
      Object.assign({
        user_id: u,
        term_id: tid,
        session_id: sid,
        date,
        note,
        task_id: taskId,
        created_at: nowStamp(),
        updated_at: nowStamp(),
      }),
    );
  },

  /**
   * 功能：把一条本节备注同步成**日常任务** —— 已有绑定就改标题，没有（或任务已被删）就新建。
   *
   * 说明：⭐ 双向同步的「去程」（备注 → 任务）；回程在 `syncDayNoteFromTask()`。
   *      ⚠️ 任务板是**可以被整目录删掉 / 被账号关掉**的模块 —— 它的方法可能压根不存在。
   *      这时一律「不做任务」，**绝不连累备注**（备注是课表自己的数据，必须照常保存）。
   *      ⚠️ 绑定会悬空：任务被别处删掉之后 `task_id` 还留着 —— 这里按「没绑定」处理（**新建**），
   *      不去复活一个不存在的 id，也不做级联删除（两边删除路径互相知道太脆）。
   *
   * @param {number} u - 账号 id
   * @param {number} taskId - 当前绑定的任务 id（0 = 没有绑定）
   * @param {string} note - 备注原文（任务的标题 = 前缀 + 它）
   * @param {string} date - 备注挂的那一天（任务的起止日都取它，`YYYY-MM-DD`）
   * @param {boolean} [withTask] - ⭐ 0.7.2：**没有绑定**时要不要顺手建一条；
   *      显式传 `false` ⇒ 这次只存备注、不建任务（前端弹窗问过「不加」时走这条）。
   *      ⛔ 它只管「无绑定」这一种情形 —— **已绑定的一律照常改标题**（那是「修改要同步」，
   *      不该因为这次没问就断掉）。不传 = 建（脚本与老测试的行为不变）。
   * @returns {number} 同步后的任务 id；**任务板模块不在时为 0**（调用方照常存备注）
   */
  _syncNoteTask(u, taskId, note, date, withTask) {
    if (typeof this.createDailyTask !== 'function' || typeof this.updateDailyTask !== 'function') return 0;
    const title = NOTE_TASK_PREFIX + note;
    const bound = Number(taskId) || 0;
    if (bound && typeof this._findTask === 'function') {
      // 任务还在 ⇒ **只改标题**（这就是「修改要同步」的去程；不新建，所以改几次都只有一条）
      if (this._findTask('daily_tasks', u, bound)) {
        try {
          this.updateDailyTask(u, bound, { title });
          return bound;
        } catch (_e) {
          // 改标题失败（数据层只读等）⇒ 落到下面新建一条 —— 备注那边不能因此存不下去
        }
      }
    }
    // ⭐ 0.7.2：走到这里 = **没有可用绑定**（从来没绑 / 绑定已悬空）。调用方明确说「这次不加」
    //    就不建 —— 备注照常保存，只是任务板上不会多出一条。返回值 0 = 「没有绑定任务」的既有口径。
    if (withTask === false) return 0;
    const created = this.createDailyTask(u, {
      title,
      content: '',
      start_date: date,
      due_date: date,
    });
    return created && created.id ? Number(created.id) : 0;
  },

  /**
   * 功能：删掉某条本节备注绑定的日常任务（清空备注、且调用方选了「一起删」时）。
   *
   * 说明：⚠️ 刻意**不吞异常**：任务板模块不在时静默跳过是应该的（它本来就没这个能力），
   *      但数据层真的报错要让它冒上去 ——。
   *
   * @param {number} u - 账号 id
   * @param {?number} taskId - 绑定的任务 id
   * @returns {void}
   */
  _dropNoteTask(u, taskId) {
    const id = Number(taskId) || 0;
    if (!id || typeof this.deleteDailyTask !== 'function') return;
    this.deleteDailyTask(u, id);
  },

  /**
   * 功能：**任务侧改了标题 ⇒ 回写绑定的那条本节备注** —— 双向同步的「回程」（0.7.2）。
   *
   * 说明：⭐ 由 `modules/tasks/lib/tasks.js` 的 `updateDailyTask()` 在标题变化后调用
   *      （跨模块只走 store 上的既有方法）。
   *      ⚠️ 任务标题是「前缀 + 备注原文」，回写时要把前缀摘掉，备注里只存原文。
   *      ⚠️⭐ **内容没变就直接返回 false、不写库** —— 这既是幂等，也是**切断回环**的关键：
   *      改备注 → 改任务标题 → 回写备注，如果这里不判等，这条链会自己绕一圈再写一次。
   *
   * @param {number} uid - 账号 id
   * @param {number} taskId - 任务 id
   * @param {string} title - 任务的新标题
   * @returns {boolean} 真的回写了为 true；这个任务没绑定备注 / 内容没变时为 false（都不是异常）
   */
  syncDayNoteFromTask(uid, taskId, title) {
    const u = Number(uid);
    const id = Number(taskId) || 0;
    if (!id) return false;
    const row = this._findDayNoteByTask(u, id);
    if (!row) return false;
    const text = String(title == null ? '' : title);
    const note = (text.startsWith(NOTE_TASK_PREFIX) ? text.slice(NOTE_TASK_PREFIX.length) : text).trim();
    if (String(row.note || '') === note) return false; // 没变 ⇒ 不写（同时也是防回环的那一刀）
    this._update('time_timetable_day_notes', u, row.id, { note, updated_at: nowStamp() });
    return true;
  },

  /**
   * 功能：把一条**已经建好的**日常任务绑到某条本节备注上 —— 任务那侧建完任务之后的「回绑」（0.7.2）。
   *
   * 说明：⭐ 与 `setDayNote()` 里 `_syncNoteTask()` 的方向相反：那个是「顺手替备注建一条任务」，
   *      这个是「任务已经建好了，回来把备注指向它」。
   *      ⚠️ 为什么需要它：口径是**任务表单点了保存才建任务** ——
   *      任务由任务板自己的表单（走 `createTask`）建出来，课表这一侧**事先拿不到它的 id**，
   *      所以只能由任务侧建完回绑（跨模块只走 store 上的既有方法）。
   *      ⚠️ 备注不存在（已被清空 / 学期被删）⇒ 返回 false，**不建孤儿绑定**；任务 id 为 0 同理。
   *      ⚠️ 本来就绑着它 ⇒ 返回 true 且**不写库**（幂等：表单重复提交不该多写一次）。
   *
   * @param {number} uid - 账号 id
   * @param {number} termId - 学期 id（备注挂在哪个学期下）
   * @param {{session_id: (string|number), date: string}} key - 这条备注的身份
   * @param {number} taskId - 要绑上去的任务 id
   * @returns {boolean} 真绑上了（或原本就绑着）为 true；备注不存在 / 参数不合法为 false
   */
  linkDayNoteTask(uid, termId, key, taskId) {
    const u = Number(uid);
    const tid = Number(termId);
    const id = Number(taskId) || 0;
    const sid = Number(key && key.session_id) || 0;
    const date = String((key && key.date) || '').trim();
    if (!id || !sid || !date) return false;
    const row = this.listDayNotes(u, tid).find(
      (r) => Number(r.session_id) === sid && String(r.date) === date,
    );
    if (!row) return false;
    if (Number(row.task_id) === id) return true;
    this._update('time_timetable_day_notes', u, row.id, { task_id: id, updated_at: nowStamp() });
    return true;
  },

  /**
   * 功能：按绑定的任务 id 反查一条本节备注。
   *
   * 说明：⚠️ **跨全部学期找** —— 绑定关系只住在备注这一侧，学期不是这条绑定的一部分
   *      （任务板看到的是一条普通日常任务，它不知道自己挂在哪个学期上）。
   *      学期数通常个位数、备注表很稀疏，逐个学期查的代价可以忽略。
   *
   * @param {number} u - 账号 id
   * @param {number} taskId - 任务 id
   * @returns {?Object} 备注行（含 `id` / `note` / `task_id`）；没有绑定时为 null
   */
  _findDayNoteByTask(u, taskId) {
    const id = Number(taskId) || 0;
    if (!id) return null;
    const terms = typeof this.listTerms === 'function' ? this.listTerms(u) : [];
    for (const tm of terms) {
      const hit = this.listDayNotes(u, tm.id).find((r) => Number(r.task_id) === id);
      if (hit) return hit;
    }
    return null;
  },

  /**
   * 功能：把一次课表导入的结果落库，返回本次写入的条数统计。
   * 说明：**一次性事务**（SQLite 走 BEGIN/COMMIT；JSON 后端无事务，
   *      但 `_saveJson()` 是整文件原子写，最坏情况是内存状态部分更新 —— 由启动时重新读盘纠正）。
   *      mode：
   *        · `new`     —— 新建学期并写入（旧课表原样保留）
   *        · `replace` —— 清空该学期的课表内容后写入（⚠️ 破坏性，路由层必须先二次确认过）
   *        · `append`  —— 保留现有，只加**不重复**的课程与课次
   *      payload：`{ term, blocks, periods, courses }`，其中
   *        `periods[].block_index` 指向 `blocks` 数组下标（真实 `block_id` 要等块插完才知道）。
   *        `courses[].sessions[]` 是挂在该课程下的课次。
   * @param {number} uid - 用户 id
   * @param {string} mode - 导入策略，'new' / 'replace' / 'append'（既非 'replace' 也非 'append' 时按 'new' 处理）
   * @param {Object} payload - 导入数据（缺省时按空对象处理）
   * @returns {Object} 统计结果 `{ term_id, blocks, periods, courses, sessions, dropped }`；
   *     `dropped` 是 append 模式下去重丢弃的课次数
   * @throws {Error} 数据层只读时抛出（`err.status = 503`）；学期不存在或不属于该用户时抛出（`err.status = 404`）
   */
  commitTimetable(uid, mode, payload) {
    this._assertWritable();
    const u = Number(uid);
    const p = payload || {};
    const run = () => {
      // 1) 定学期
      let termId;
      if (mode === 'replace') {
        termId = Number(p.term_id);
        this._assertTermOwned(u, termId);
        this.clearTermData(u, termId);
        const patch = {};
        // ⚠️ ⭐ 0.4.4：`holiday_advance_minutes` / `holiday_pm_from`（节假日前一天下午提前）
        //    **必须**在这张名单里。两端前端都特意把它从模板 / 解析结果里透传上来
        //    （`modules/timetable/desktop-import.js` 与手机版的注释里都写着「否则差这一条而且不报错」），
        //    `checkTerm` 也一直保留着它们 —— 只在**这里**被过滤掉，后果就是
        //    「选了人文科技学院、覆盖导入之后那一项还是空的」，而且界面上完全看不出来。
        //    `checkCommit` 已经把 `p.term` 过了一遍 `checkTerm`，所以这两个值是校验过的。
        ['name', 'start_monday', 'total_weeks', 'remark', 'meta', 'holiday_advance_minutes', 'holiday_pm_from'].forEach(
          (k) => {
            if (p.term && p.term[k] !== undefined) patch[k] = p.term[k];
          },
        );
        if (Object.keys(patch).length) this._update('time_timetable_terms', u, termId, patch);
      } else if (mode === 'append') {
        termId = Number(p.term_id);
        this._assertTermOwned(u, termId);
      } else {
        termId = Number(this.createTerm(u, p.term || {}).id);
      }

      // 2) 时段块 + 逐节时间（块要先插，periods 才知道 block_id）
      let blocks;
      let periods;
      if (mode === 'append') {
        blocks = this.listBlocks(u, termId);
        periods = this.listPeriods(u, termId);
      } else {
        blocks = this.replaceBlocks(u, termId, p.blocks || []);
        periods = this.replacePeriods(
          u,
          termId,
          (p.periods || []).map((x) => ({
            index_no: x.index_no,
            block_id: x.block_index === undefined || x.block_index === null ? null : (blocks[x.block_index] || {}).id,
            start_time: x.start_time,
            end_time: x.end_time,
          })),
        );
      }

      // 3) 课程与课次（append 模式按签名去重）
      const existingCourses = mode === 'append' ? this.listCourses(u, termId) : [];
      const byName = new Map(existingCourses.map((c) => [c.name, c]));
      const existingSigs = new Set(
        mode === 'append'
          ? this.listSessions(u, termId).map((s) => {
              const c = existingCourses.find((x) => x.id === Number(s.course_id));
              return sessionSig(c ? c.name : '', s);
            })
          : [],
      );
      let nCourses = 0;
      let nSessions = 0;
      let dropped = 0;
      (p.courses || []).forEach((c) => {
        let course = byName.get(c.name);
        if (!course) {
          course = this.createCourse(u, {
            term_id: termId,
            name: c.name,
            short_name: c.short_name,
            teacher: c.teacher,
            color: c.color,
            remark: c.remark,
            sort_order: nCourses,
          });
          byName.set(c.name, course);
          nCourses++;
        }
        (c.sessions || []).forEach((s) => {
          const sig = sessionSig(c.name, s);
          if (existingSigs.has(sig)) {
            dropped++;
            return;
          }
          existingSigs.add(sig);
          this.createSession(u, {
            course_id: course.id,
            weekday: s.weekday,
            period_start: s.period_start,
            period_end: s.period_end,
            weeks: s.weeks,
            room: s.room,
            teacher: s.teacher,
            remark: s.remark,
          });
          nSessions++;
        });
      });

      return {
        term_id: termId,
        blocks: blocks.length,
        periods: periods.length,
        courses: nCourses,
        sessions: nSessions,
        dropped,
      };
    };

    if (this.backend !== 'sqlite') return run();
    this.db.exec('BEGIN');
    try {
      const r = run();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略 */
      }
      throw e;
    }
  },

  /**
   * 功能：取一个学期的完整课表：`{ term, blocks, periods, cells }`。
   * 说明：`cells` 已把课程信息并进课次（前端直接摆格子，不用自己 join）。
   *      ⚠️ `cells` 返回的是**原始课次**（带 `weeks` 文本）——
   *      「这一周上不上」由前端用 `weeksInclude()` 判断，与后端同一套语义。
   * @param {number} uid - 用户 id
   * @param {number} termId - 学期 id
   * @returns {?Object} 课表对象；学期不存在或不属于该用户时为 null
   */
  scheduleOf(uid, termId) {
    const term = this.getTerm(uid, termId);
    if (!term) return null;
    const u = Number(uid);
    const { cells } = this._bk.scheduleOf(termId, u);
    // ⭐ 0.2.3：两件事 —— ①老数据（早于配色那版导入的）`color` 是空的，这里按课程在学期里的次序兜一个，
    //    **只用于显示、不写库**（铁律 18：不改写用户数据），同一门课每次拿到的颜色都一样；
    //    ②颜色统一在这里算，两个后端不必各写一份（course_id → 颜色只依赖课程表的次序）。
    const courses = this.listCourses(u, termId);
    const slotOf = new Map(courses.map((c, i) => [Number(c.id), i]));
    const colored = cells.map((c) =>
      c.color ? c : Object.assign({}, c, { color: pickCourseColor(slotOf.get(Number(c.course_id)) || 0) }),
    );
    return {
      term,
      blocks: this.listBlocks(u, termId),
      periods: this.listPeriods(u, termId),
      cells: colored,
      // ⭐ 0.7.1：**按日期的课次备注**必须随快照一起走 ——
      //    ⚠️⭐ 漏掉这一个键，整条链**静默失效**：`setDayNote()` 写得进去（库里真有），
      //    但两端读的都是 `state.tt.day_notes`（＝本函数的产物）⇒ 永远读到 undefined、
      //    界面永远是空的，而且**不报任何错**。
      //    「本节备注保存了、重新打开并没有」就是这个（`routes.js` 的 schedule 响应写的是
      //    `day_notes: sch.day_notes`，取值取到 undefined ⇒ JSON 里那个键直接消失）。
      //    ⚠️ 它同时喂两处：课表页的 `state.tt.day_notes` **和**看板取数
      //    （`core/store/methods/stats.js` 的 `courseItems()` 也读 `sch.day_notes`）——
      //    所以修在这里一处、两端一起好；这也正是它该待的地方（快照的唯一组装点）。
      day_notes: this.listDayNotes(u, termId),
    };
  },

  // ---- ⭐ 内置高校模板（0.3.5）—— 两张**不属于任何账号**的只读内置表 ----

  /**
   * 功能：把本模块 `lib/school-templates.js` 里的高校模板**同步进数据库的两张内置表**。
   *
   * 说明：⭐ 这是「内置数据进库」的**唯一入口**，由 `store/index.js` 在每次启动收尾时调一次。
   *      做法是「先读库里现在是什么，与数据源算出来的逐行比对，**不一样才整体替换**」：
   *      · 一致（绝大多数启动）→ 一个字节都不写，启动零代价；
   *      · 不一致（升级带了新学校 / 改了某一节时间 / 有人手工动过库）→ 整体替换，
   *        库里随即与数据源严格一致。**不需要额外的版本号标记**，状态自己说明自己。
   *
   * ⚠️ 只在读到不一致时才写：这既避开了「每次启动都写库」的无谓抖动，
   *    也保证**升级后模板真的会更新**（不像「只在空表时播种」那样，老库永远停在旧作息上）。
   * ⚠️ 只读降级（`readOnly`）时**直接跳过**：宁可不播种，也不在只读态下试图写盘。
   * ⚠️ 本方法**绝不碰任何用户数据**：它只写 `time_timetable_school_schedules` /
   *    `time_timetable_school_grids` 这两张内置表（铁律 18：启动与迁移不改写用户数据）。
   *
   * @returns {{schedules: number, grids: number, changed: boolean}} 库里现有行数与「这次有没有写」
   */
  seedSchoolTemplates() {
    const templates = require('./lib/school-templates.js');
    let want;
    try {
      want = { schedules: templates.scheduleRows(), grids: templates.gridRows() };
    } catch (e) {
      this.schoolTemplateError = `[school-templates] 模板数据源展开失败：${(e && e.message) || String(e)}`;
      return { schedules: 0, grids: 0, changed: false };
    }
    try {
      const now = this.listSchoolTemplatesRaw();
      const same =
        JSON.stringify(stripIds(now.schedules)) === JSON.stringify(want.schedules) &&
        JSON.stringify(stripIds(now.grids)) === JSON.stringify(want.grids);
      if (same) {
        this.schoolTemplateError = null;
        return { schedules: now.schedules.length, grids: now.grids.length, changed: false };
      }
      if (this.readOnly) {
        return { schedules: now.schedules.length, grids: now.grids.length, changed: false };
      }
      const written = this._bk.replaceSchoolTemplates(want.schedules, want.grids);
      this.schoolTemplateError = null;
      return { schedules: written.schedules, grids: written.grids, changed: true };
    } catch (e) {
      // ⚠️ 播种失败**绝不能让启动挂掉**：它是锦上添花的参考数据，而启动失败等于整个应用打不开。
      //    如实记在 `schoolTemplateError` 上，由启动日志说出来（与 indexErrors 同一个哲学）。
      this.schoolTemplateError = (e && e.message) || String(e);
      return { schedules: 0, grids: 0, changed: false };
    }
  },

  /**
   * 功能：原样读出两张内置模板表的行（含 `id`），不做任何整理 —— 供播种时的比对与上层组装。
   * @returns {{schedules: Array.<Object>, grids: Array.<Object>}} 两张表的全部行
   */
  listSchoolTemplatesRaw() {
    return this._bk.listSchoolTemplates();
  },

  /**
   * 功能：给界面用的**高校模板清单** —— 每所学校的一个变体一项，含作息概要但不含逐节明细。
   *
   * 说明：清单**从库里读**（而不是直接从数据源读）—— 这样「库里到底有什么」与「界面看到什么」
   *      永远是一份；库是数据源在启动时同步出来的那一份（见 `seedSchoolTemplates()`）。
   *      逐节明细等用户真的选了某一所再取（`schoolTemplateDraft`），省一次大响应。
   *
   * @returns {Array.<Object>} 模板清单项数组（按 sort_order 排序）
   */
  listSchoolTemplates() {
    const { schedules, grids } = this.listSchoolTemplatesRaw();
    const parse = (txt) => {
      try {
        const v = JSON.parse(String(txt || '[]'));
        return Array.isArray(v) ? v : [];
      } catch (_e) {
        return [];
      }
    };
    return grids.map((g) => {
      const own = schedules.filter((s) => s.school_code === g.school_code && s.campus === g.campus);
      const labels = parse(g.row_labels);
      const dayParts = [];
      own.forEach((s) => {
        const last = dayParts[dayParts.length - 1];
        if (last && last.label === s.day_part) last.count += 1;
        else dayParts.push({ label: s.day_part || '', count: 1 });
      });
      return {
        code: g.school_code,
        school: g.school_name,
        campus: g.campus || '',
        campus_label: g.campus_label || '',
        name: g.name,
        row_mode: g.row_mode === 'big' ? 'big' : 'block',
        row_labels: labels,
        total_weeks: Number(g.total_weeks) || 17,
        periods: own.length,
        blocks: labels.length,
        day_parts: dayParts,
        first_period: own.length ? own[0].start_time : '',
        last_period: own.length ? own[own.length - 1].end_time : '',
        holiday_advance_minutes: Number(g.holiday_advance_minutes) || 0,
        holiday_pm_from: g.holiday_pm_from || '',
        source: g.source || '',
        note: g.note || '',
      };
    });
  },

  /**
   * 功能：把某个高校模板拼成**导入向导要的课表草稿**（`{ term, blocks, periods, courses }`）。
   *
   * 说明：⭐ 草稿形状与解析教务文件得到的那份**逐字段同形**，所以它可以原样走现有的
   *      `import/commit` 落库路径 —— 模板导入不需要另开一条写库通道（少一条通道就少一处会漂移的地方）。
   *      ⚠️ `courses` **恒为空数组**：模板只带来「这所学校的作息与课表版式」，
   *      课程是用户自己的东西，数据源里一个字都没有。
   *
   * ⚠️ 逐节时间直接从**内置作息表**读（唯一来源）；时段块的起止时间由块首节的开始与块末节的结束
   *    算出来，不另存一份 —— 存两份就有两份对不上的可能。
   *
   * @param {string} code - 学校代码
   * @param {string} [campus] - 变体标识（省略或空串取该学校的第一个变体）
   * @returns {?Object} 课表草稿；学校 / 变体不存在，或该模板没有任何节次时为 null
   */
  schoolTemplateDraft(code, campus) {
    const { schedules, grids } = this.listSchoolTemplatesRaw();
    const wantCode = String(code || '');
    const wantCampus = String(campus === undefined || campus === null ? '' : campus);
    const candidates = grids.filter((g) => g.school_code === wantCode);
    if (!candidates.length) return null;
    const grid = wantCampus ? candidates.find((g) => (g.campus || '') === wantCampus) : candidates[0];
    if (!grid) return null;
    const rows = schedules
      .filter((s) => s.school_code === grid.school_code && s.campus === grid.campus)
      .sort((a, b) => Number(a.period_index) - Number(b.period_index));
    if (!rows.length) return null;
    const byIndex = new Map(rows.map((r) => [Number(r.period_index), r]));
    /** 功能：把 JSON 文本安全解析成数组（坏数据当成空数组，绝不上抛）。 */
    const parse = (txt) => {
      try {
        const v = JSON.parse(String(txt || '[]'));
        return Array.isArray(v) ? v : [];
      } catch (_e) {
        return [];
      }
    };
    const labels = parse(grid.row_labels);
    const ranges = parse(grid.row_periods);

    const blocks = ranges.map((range, i) => {
      const list = (range || []).map(Number);
      const first = byIndex.get(list[0]);
      const last = byIndex.get(list[list.length - 1]);
      return {
        label: String(labels[i] === undefined ? `第 ${i + 1} 段` : labels[i]),
        sort_order: i,
        start_time: first ? first.start_time : '',
        end_time: last ? last.end_time : '',
        period_count: list.length,
        class_minutes: Number(rows[0].class_minutes) || 45,
        break_minutes: Number(rows[0].break_minutes) || 5,
      };
    });
    const periods = rows.map((r) => ({
      index_no: Number(r.period_index),
      block_index: ranges.findIndex((range) => (range || []).map(Number).includes(Number(r.period_index))),
      start_time: r.start_time,
      end_time: r.end_time,
    }));

    return {
      term: {
        name: '',
        start_monday: '',
        start_monday_guessed: false,
        total_weeks: Number(grid.total_weeks) || 17,
        remark: '',
        meta: `高校模板：${grid.name}`,
        holiday_advance_minutes: Number(grid.holiday_advance_minutes) || 0,
        holiday_pm_from: grid.holiday_pm_from || '',
      },
      blocks,
      periods,
      courses: [],
    };
  },
};

/**
 * 功能：剥掉行里的 `id`（以及 JSON 后端可能带上的其它非数据列），得到与数据源可逐字节比对的形状。
 * 说明：播种比对用 —— 库里多一列 `id`、列的顺序也可能不同，直接比 JSON 会永远「不一致」而每次启动都重写。
 * @param {Array.<Object>} rows - 库里的行
 * @returns {Array.<Object>} 按 `SCHOOL_TEMPLATE_COLS` 顺序重排、且不含 `id` 的行
 */
function stripIds(rows) {
  return (rows || []).map((r) => {
    const out = {};
    // 键的顺序必须稳定 —— 逐个数据源字段按固定次序取，`undefined` 归一成 null 与 SQLite 一致
    for (const k of Object.keys(r)) {
      if (k === 'id') continue;
      out[k] = r[k] === undefined ? null : r[k];
    }
    return out;
  });
}
