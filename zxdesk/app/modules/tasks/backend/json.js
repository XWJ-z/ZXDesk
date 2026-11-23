'use strict';

/**
 * modules/tasks/backend/json.js —— 任务板存储原语（**JSON 回退版**）
 * 功能：项目 / 项目任务 / 日常任务三类存储原语，与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/09-模块化重构.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

const ops = {
  /**
   * 功能：列出某个账号名下的全部项目，按 `sort_order`、`id` 升序。
   * @param {(number|string)} uid - 用户 id，函数内部统一转成数字比较
   * @returns {Array.<Object>} 该项目行的数组
   */
  listProjects(uid) {
    return this.data.projects
      .filter((p) => uidOf(p) === Number(uid))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  },

  /**
   * 功能：删除一个项目，并连带删掉它名下的全部项目任务。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 项目 id
   * @returns {boolean} 项目行是否真的被删掉
   */
  deleteProject(uid, id) {
    const before = this.data.projects.length;
    // 项目的任务马上要被删 ⇒ **先**把它们的打卡记录清掉
    // （与 SQLite 后端同一条口径，见那边同名 op 的说明）。
    const doomed = new Set(
      (this.data.project_tasks || [])
        .filter((t) => t.project_id === id && uidOf(t) === Number(uid))
        .map((t) => Number(t.id)),
    );
    if (doomed.size && Array.isArray(this.data.task_occurrences)) {
      this.data.task_occurrences = this.data.task_occurrences.filter(
        (o) => !(uidOf(o) === Number(uid) && o.task_source === 'project' && doomed.has(Number(o.task_id))),
      );
    }
    this.data.projects = this.data.projects.filter((p) => !(p.id === id && uidOf(p) === Number(uid)));
    this.data.project_tasks = this.data.project_tasks.filter((t) => !(t.project_id === id && uidOf(t) === Number(uid)));
    const removed = this.data.projects.length < before;
    // 项目真被删掉了才连带清它的**协作数据**（状态配置 /
    // 评论 / 附件＋磁盘）—— 那五张表搬去了 `modules/teamwork`，连带清理由 teamwork 的
    // `deleteProjectCollabData()` 一处负责（与 SQLite 后端同一条口径，见那边同名 op 的说明）。
    if (removed && typeof this._bk.deleteProjectCollabData === 'function') {
      this._bk.deleteProjectCollabData(id);
    }
    this._saveJson();
    return removed;
  },

  /**
   * 功能：判断某个项目是否属于该账号，供越权检查使用。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} projectId - 项目 id
   * @returns {boolean} 属于该账号返回 true
   */
  ownsProject(uid, projectId) {
    return (this.data.projects || []).some((p) => p.id === Number(projectId) && uidOf(p) === Number(uid));
  },

  /**
   * 功能：列出某个项目下属于该账号的任务，按 `sort_order`、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} projectId - 项目 id
   * @returns {Array.<Object>} 补齐默认字段后的任务行数组
   * 说明：老 JSON 数据可能没有 `user_id` / `important` / `urgent` / `start_date` 这些键，统一补默认值（缺失开始日期时按截止日期算）。
   */
  listProjectTasks(uid, projectId) {
    return this.data.project_tasks
      .filter((t) => t.project_id === projectId && uidOf(t) === Number(uid))
      .map((t) => Object.assign({ user_id: 1, important: 0, urgent: 0, start_date: t.due_date || '' }, t))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  },

  /**
   *
   * 说明：⭐ 返回 `{ message_id, scope, task_id, title }`，`scope` 是 `'daily'` 或项目 id（数字）。
   */
  tasksFromMessages(uid, messageIds) {
    const me = Number(uid);
    const ids = new Set(
      (Array.isArray(messageIds) ? messageIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    );
    if (!ids.size) return [];
    const out = [];
    for (const t of this.data.daily_tasks || []) {
      if (uidOf(t) !== me || !ids.has(Number(t.from_message_id))) continue;
      out.push({
        message_id: Number(t.from_message_id),
        scope: 'daily',
        task_id: Number(t.id),
        title: String(t.title == null ? '' : t.title),
        // 完成状态（见 SQLite 后端同名的说明）
        status: t.status === 'done' ? 'done' : 'todo',
      });
    }
    for (const t of this.data.project_tasks || []) {
      if (uidOf(t) !== me || !ids.has(Number(t.from_message_id))) continue;
      out.push({
        message_id: Number(t.from_message_id),
        scope: Number(t.project_id),
        task_id: Number(t.id),
        title: String(t.title == null ? '' : t.title),
        status: t.status === 'done' ? 'done' : 'todo',
      });
    }
    return out;
  },

  /**
   * 功能：删除一条项目任务。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 任务 id
   * @returns {boolean} 任务行是否真的被删掉
   */
  deleteProjectTask(uid, id) {
    const before = this.data.project_tasks.length;
    this.data.project_tasks = this.data.project_tasks.filter((t) => !(t.id === id && uidOf(t) === Number(uid)));
    const removed = this.data.project_tasks.length < before;
    // 任务真被删掉了才连带清它的打卡记录
    // （与 SQLite 后端同一条口径，见那边同名 op 的说明）。
    if (removed && Array.isArray(this.data.task_occurrences)) {
      this.data.task_occurrences = this.data.task_occurrences.filter(
        (o) => !(uidOf(o) === Number(uid) && o.task_source === 'project' && Number(o.task_id) === Number(id)),
      );
    }
    // 任务真被删掉了才连带清它的**任务级**协作数据
    // （评论 ＋ 附件行与磁盘文件）—— 由 teamwork 的 `deleteTaskCollabData()` 一处负责
    // （与 SQLite 后端同一条口径，见那边同名 op 的说明）。
    if (removed && typeof this._bk.deleteTaskCollabData === 'function') {
      this._bk.deleteTaskCollabData(id);
    }
    this._saveJson();
    return removed;
  },

  /**
   * 功能：列出某个账号名下的全部日常任务，按 `sort_order`、`id` 升序。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 补齐默认字段后的任务行数组
   * 说明：与项目任务同理，为老 JSON 数据缺失的 `user_id` / `important` / `urgent` / `start_date` 补默认值。
   */
  listDailyTasks(uid) {
    return this.data.daily_tasks
      .filter((t) => uidOf(t) === Number(uid))
      .map((t) => Object.assign({ user_id: 1, important: 0, urgent: 0, start_date: t.due_date || '' }, t))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  },

  /**
   * 功能：在指定的任务表里按 id 取一条记录，并限定归属；不存在或不属于该账号都返回 null。
   * @param {string} table - 表名，'project_tasks' 或 'daily_tasks'
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 任务 id
   * @returns {?Object} 命中的任务行，未命中为 null
   */
  findTask(table, uid, id) {
    return this.data[table].find((t) => t.id === Number(id) && uidOf(t) === Number(uid)) || null;
  },

  /**
   * 功能：删除一条日常任务。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 任务 id
   * @returns {boolean} 任务行是否真的被删掉
   */
  deleteDailyTask(uid, id) {
    const before = this.data.daily_tasks.length;
    this.data.daily_tasks = this.data.daily_tasks.filter((t) => !(t.id === id && uidOf(t) === Number(uid)));
    const removed = this.data.daily_tasks.length < before;
    // 日常任务真被删掉了才连带清它的打卡记录。
    if (removed && Array.isArray(this.data.task_occurrences)) {
      this.data.task_occurrences = this.data.task_occurrences.filter(
        (o) => !(uidOf(o) === Number(uid) && o.task_source === 'daily' && Number(o.task_id) === Number(id)),
      );
    }
    this._saveJson();
    return removed;
  },

  /**
   * 功能：统计某一天仍在进行中的任务数 —— 项目任务按项目 id 分组计数，日常任务给一个总数。
   * @param {(number|string)} uid - 用户 id
   * @param {string} d - 日期，'YYYY-MM-DD'
   * @returns {{ projects: Object, daily: number }} `projects` 是「项目 id → 条数」，`daily` 是日常任务条数
   * 说明：区间口径为「`start_date || due_date` 到 `due_date`」—— 开始日期缺失时按截止日期当天算，
   */
  todayCounts(uid, d) {
    const projects = {};
    let daily = 0;
    this.data.project_tasks.forEach((t) => {
      if (uidOf(t) !== Number(uid)) return;
      if (t.status === 'done') return;
      const s = t.start_date || t.due_date,
        e = t.due_date;
      if (s && e && s <= d && d <= e) projects[t.project_id] = (projects[t.project_id] || 0) + 1;
    });
    this.data.daily_tasks.forEach((t) => {
      if (uidOf(t) !== Number(uid)) return;
      if (t.status === 'done') return;
      const s = t.start_date || t.due_date,
        e = t.due_date;
      if (s && e && s <= d && d <= e) daily++;
    });
    return { projects, daily };
  },

  /**
   * 功能：本模块进个人备份的那一份读取 —— 对应原先 `exportAll()` 里任务那一段（**逐字搬运**）。
   *
   * 说明：⚠️ 三张表之间有**父子引用**（`project_tasks.project_id` → `projects.id`），
   * （个人导入的父子顺序见 `store/methods/backup.js` 的 `PERSONAL_SOURCES`）。
   *
   */
  exportTasks(uid) {
    const d = this.data || {};
    /** 功能：深拷贝一个数组（借 JSON 序列化实现），入参为空时给空数组。 */
    const cp = (arr) => JSON.parse(JSON.stringify(arr || []));
    /** 功能：深拷贝后只保留属于该账号的行。 */
    const mine = (arr) => cp(arr).filter((r) => uidOf(r) === Number(uid));
    const projects = mine(d.projects).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const ptasks = mine(d.project_tasks).sort(
      (a, b) => a.project_id - b.project_id || a.sort_order - b.sort_order || a.id - b.id,
    );
    const dtasks = mine(d.daily_tasks).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    return { projects, ptasks, dtasks };
  },

  /**
   * 功能：**按 id 直接取一个项目**（不管归属）。
   * @param {(number|string)} id - 项目 id
   * @returns {?Object} 项目行；不存在时为 null
   * 所以**留在本模块**（判据搬去 `teamwork` 后由那边的 `taskShareGuard()` 经 `_bk` 调它）——
   */
  findProjectById(id) {
    return (this.data.projects || []).find((p) => Number(p.id) === Number(id)) || null;
  },

  /**
   * 功能：给某条任务的某一期写一条完成记录；**已打过卡时什么都不做**（幂等）。
   *
   * 说明：⚠️ JSON 回退版**没有唯一索引**可撞 ⇒ 只能先查一遍再插 —— 这一步是**必须的**
   * （不是「顺手优化」）：漏了它，重复打卡会写进第二行，「已完成的期数」当场算错，
   * 而 SQLite 那侧却是对的 ⇒ 两个后端行为漂移（本项目最贵的一类缺陷）。
   */
  insertOccurrence(uid, source, taskId, periodKey, doneAt) {
    if (!Array.isArray(this.data.task_occurrences)) this.data.task_occurrences = [];
    const hit = this.data.task_occurrences.some(
      (o) =>
        uidOf(o) === Number(uid) &&
        o.task_source === source &&
        Number(o.task_id) === Number(taskId) &&
        String(o.period_key) === String(periodKey),
    );
    if (hit) return 0;
    this.data.task_occurrences.push({
      id: this.data._seq++,
      user_id: Number(uid),
      task_source: source,
      task_id: Number(taskId),
      period_key: String(periodKey),
      done_at: doneAt,
      created_at: doneAt,
      updated_at: doneAt,
    });
    this._saveJson();
    return 1;
  },

  /**
   * 功能：删掉某条任务某一期的打卡记录。
   * @param {(number|string)} uid - 用户 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {(number|string)} taskId - 任务 id
   * @param {string} periodKey - 本期的周期起点日期 `YYYY-MM-DD`
   */
  deleteOccurrence(uid, source, taskId, periodKey) {
    const all = this.data.task_occurrences || [];
    const before = all.length;
    this.data.task_occurrences = all.filter(
      (o) =>
        !(
          uidOf(o) === Number(uid) &&
          o.task_source === source &&
          Number(o.task_id) === Number(taskId) &&
          String(o.period_key) === String(periodKey)
        ),
    );
    const removed = this.data.task_occurrences.length < before;
    if (removed) this._saveJson();
    return removed;
  },

  /**
   * 功能：取某条任务已打卡的期，按 `period_key` 升序。
   * @param {(number|string)} uid - 用户 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {(number|string)} taskId - 任务 id
   * @returns {Array.<Object>} 记录行数组
   */
  listOccurrences(uid, source, taskId) {
    return (this.data.task_occurrences || [])
      .filter((o) => uidOf(o) === Number(uid) && o.task_source === source && Number(o.task_id) === Number(taskId))
      .sort((a, b) => String(a.period_key).localeCompare(String(b.period_key)));
  },

  /**
   * 功能：取该账号**全部**打卡记录（看板一次拿齐）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 记录行数组（按 `task_source`、`task_id`、`period_key` 升序）
   */
  listOccurrencesOfUser(uid) {
    return (this.data.task_occurrences || [])
      .filter((o) => uidOf(o) === Number(uid))
      .sort(
        (a, b) =>
          String(a.task_source).localeCompare(String(b.task_source)) ||
          Number(a.task_id) - Number(b.task_id) ||
          String(a.period_key).localeCompare(String(b.period_key)),
      );
  },
};

module.exports = { ops };
