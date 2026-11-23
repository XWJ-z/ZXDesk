'use strict';

/**
 * modules/tasks/backend/sqlite.js —— 任务板存储原语（**SQLite版**）
 * 功能：项目 / 项目任务 / 日常任务三类存储原语，与另一个后端**同名同参** ——
 * 「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/09-模块化重构.md
 */

const ops = {
  /**
   * 功能：按排序号列出该账号名下的全部项目。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 项目行数组（按 sort_order、id 升序）
   */
  listProjects(uid) {
    return this._listSql('SELECT * FROM projects WHERE user_id=? ORDER BY sort_order ASC, id ASC', [uid]);
  },

  /**
   * 功能：删除一个项目，并连同它下面的全部项目任务一并删除；返回是否真的删到了项目行。
   * @param {number} uid - 用户 id
   * @param {number} id - 项目 id
   * @returns {boolean} 删到项目行则为 true
   */
  deleteProject(uid, id) {
    // 项目的任务马上要被删 ⇒ **先**把它们的打卡记录清掉
    // （`task_occurrences.task_id` 不是外键，没有 ON DELETE CASCADE 帮我兜）。
    // 必须**在删 project_tasks 之前**按子查询清 —— 任务行没了就查不出 id 了。
    this.db
      .prepare(
        `DELETE FROM task_occurrences WHERE user_id=? AND task_source='project'
           AND task_id IN (SELECT id FROM project_tasks WHERE project_id=? AND user_id=?)`,
      )
      .run(uid, id, uid);
    this.db.prepare('DELETE FROM project_tasks WHERE project_id=? AND user_id=?').run(id, uid);
    const r = this.db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(id, uid);
    // 项目没了，它的**协作数据**（状态配置 / 评论 / 附件＋磁盘）
    // 也没有意义（项目是**组织**，不是事实凭证）—— 那五张表搬去了 `modules/teamwork`，连带清理
    // 由 teamwork 的 `deleteProjectCollabData()` 一处负责（唯一出处，⛔ 不在这里再抄一遍表名）。
    if (r.changes > 0 && typeof this._bk.deleteProjectCollabData === 'function') {
      this._bk.deleteProjectCollabData(id);
    }
    return r.changes > 0;
  },

  /**
   * 功能：判断某个项目是否属于该账号，供越权校验使用（不通过时上层统一按「不存在」处理）。
   * @param {number} uid - 用户 id
   * @param {number} projectId - 项目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsProject(uid, projectId) {
    return !!this.db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(projectId, uid);
  },

  /**
   * 功能：列出某个项目下属于该账号的全部任务。
   * @param {number} uid - 用户 id
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 项目任务行数组（按 sort_order、id 升序）
   */
  listProjectTasks(uid, projectId) {
    return this._listSql(
      'SELECT * FROM project_tasks WHERE project_id=? AND user_id=? ORDER BY sort_order ASC, id ASC',
      [projectId, uid],
    );
  },

  /**
   *
   * 说明：⭐ 一次查两张任务表（日常 + 项目），返回**归一后的形状** ——
   */
  tasksFromMessages(uid, messageIds) {
    const ids = (Array.isArray(messageIds) ? messageIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    // `status` 是要的「这条任务的完成状态」——
    // 对话里那枚「已添加到任务」标记下面要写明**做完没有**（没做完红色、做完灰色划掉），
    // 所以反查必须把状态一起带出来（前端再拿不到第二个接口去问）。
    const daily = this._listSql(
      `SELECT id, title, status, from_message_id FROM daily_tasks WHERE user_id=? AND from_message_id IN (${marks})`,
      [uid, ...ids],
    );
    const proj = this._listSql(
      `SELECT id, title, status, project_id, from_message_id FROM project_tasks WHERE user_id=? AND from_message_id IN (${marks})`,
      [uid, ...ids],
    );
    return [
      ...daily.map((r) => ({
        message_id: Number(r.from_message_id),
        scope: 'daily',
        task_id: Number(r.id),
        title: String(r.title == null ? '' : r.title),
        status: r.status === 'done' ? 'done' : 'todo',
      })),
      ...proj.map((r) => ({
        message_id: Number(r.from_message_id),
        scope: Number(r.project_id),
        task_id: Number(r.id),
        title: String(r.title == null ? '' : r.title),
        status: r.status === 'done' ? 'done' : 'todo',
      })),
    ];
  },

  /**
   * 功能：删除一条项目任务，返回是否真的删到了行。
   * @param {number} uid - 用户 id
   * @param {number} id - 任务 id
   * @returns {boolean} 删到行则为 true
   */
  deleteProjectTask(uid, id) {
    const r = this.db.prepare('DELETE FROM project_tasks WHERE id=? AND user_id=?').run(id, uid);
    // 任务没了，它的打卡记录也没有意义（理由见 `deleteProject`）。
    // 会顺手清掉别人任务的打卡记录（失败方向必须安全，与 `deleteProjectCollabData` 同一口径）。
    if (r.changes > 0) {
      this.db
        .prepare("DELETE FROM task_occurrences WHERE user_id=? AND task_source='project' AND task_id=?")
        .run(uid, id);
    }
    // 任务没了，挂在它上面的**任务级**协作数据
    // （评论 ＋ 附件行与磁盘文件）也没有意义 —— 那两张表搬去了 `modules/teamwork`，连带清理由
    // teamwork 的 `deleteTaskCollabData()` 一处负责（项目级评论 `task_id` 为 NULL，不会被误伤）。
    if (r.changes > 0 && typeof this._bk.deleteTaskCollabData === 'function') {
      this._bk.deleteTaskCollabData(id);
    }
    return r.changes > 0;
  },

  /**
   * 功能：列出该账号的全部日常任务。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 日常任务行数组（按 sort_order、id 升序）
   */
  listDailyTasks(uid) {
    return this._listSql('SELECT * FROM daily_tasks WHERE user_id=? ORDER BY sort_order ASC, id ASC', [uid]);
  },

  /**
   * 功能：按表名与 id 取单条任务行（项目任务与日常任务共用同一个读取口）。
   * @param {string} table - 表名，由调用方保证取自固定白名单（`project_tasks` 或 `daily_tasks`）
   * @param {number} uid - 用户 id
   * @param {number} id - 任务 id
   * @returns {?Object} 任务行；不存在时返回 null
   */
  findTask(table, uid, id) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id, uid) || null;
  },

  /**
   * 功能：删除一条日常任务，返回是否真的删到了行。
   * @param {number} uid - 用户 id
   * @param {number} id - 任务 id
   * @returns {boolean} 删到行则为 true
   */
  deleteDailyTask(uid, id) {
    const r = this.db.prepare('DELETE FROM daily_tasks WHERE id=? AND user_id=?').run(id, uid);
    // 日常任务没了，它的打卡记录也没有意义。
    // 只在任务行真被删掉时才清（与 `deleteProjectTask` 同一条口径）。
    if (r.changes > 0) {
      this.db.prepare("DELETE FROM task_occurrences WHERE user_id=? AND task_source='daily' AND task_id=?").run(uid, id);
    }
    return r.changes > 0;
  },

  /**
   * 功能：统计某一天仍在进行中的任务条数：项目任务按 project_id 分组、日常任务为总数，供今日待办口径使用。
   * 说明：日期区间用 `COALESCE(start_date, due_date)` 推断 —— 老任务的 start_date 可能为 NULL，
   * 这里只改查询口径，绝不改写用户数据（见 `_migrateSqlite` 的注释）。
   * @param {number} uid - 用户 id
   * @param {string} d - 日期（`YYYY-MM-DD` 字符串）
   */
  todayCounts(uid, d) {
    /* eslint-disable no-useless-assignment -- 这几行是从改造前的 db.js 原样搬来的**共享声明**：
 * 原代码里它们同时服务 if/else 两个分支，所以必须是 let、且 daily 需要初值（JSON 分支要走 daily++）。
       拆开后各占一个 op，lint 才会建议改 const / 去掉初值 —— 改了就属于「改逻辑」，不在本次搬家范围内。 */
    const projects = {};
    let daily = 0;
    const proj = this.db
      .prepare(
        `SELECT project_id AS pid, COUNT(*) AS c FROM project_tasks
           WHERE user_id=? AND status!='done' AND due_date>=? AND COALESCE(start_date, due_date)<=?
           GROUP BY project_id`,
      )
      .all(uid, d, d);
    proj.forEach((r) => {
      projects[r.pid] = r.c;
    });
    const dr = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM daily_tasks
           WHERE user_id=? AND status!='done' AND due_date>=? AND COALESCE(start_date, due_date)<=?`,
      )
      .get(uid, d, d);
    daily = (dr && dr.c) || 0;
    /* eslint-enable no-useless-assignment */
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
    const projects = this.db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY sort_order ASC, id ASC').all(uid);
    const ptasks = this.db
      .prepare('SELECT * FROM project_tasks WHERE user_id=? ORDER BY project_id ASC, sort_order ASC, id ASC')
      .all(uid);
    const dtasks = this.db
      .prepare('SELECT * FROM daily_tasks WHERE user_id=? ORDER BY sort_order ASC, id ASC')
      .all(uid);
    return { projects, ptasks, dtasks };
  },

  /**
   * 功能：**按 id 直接取一个项目**（不管归属）—— 共享项目那条路要读「别人的项目」。
   *
   * （那样「项目不存在」与「不共享」就分不出来了，而两者都必须回同一个 404）。
   * 它是**取数原语**、绑的是 `projects`（任务板的地基表），
   * 所以**留在本模块**（判据搬去 `teamwork` 后由那边的 `taskShareGuard()` 经 `_bk` 调它）——
   */
  findProjectById(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) || null;
  },

  /**
   * 功能：给某条任务的某一期写一条完成记录；**已打过卡时什么都不做**（幂等）。
   *
   * 说明：⭐ 用 `INSERT OR IGNORE` 吃掉 `UNIQUE(user_id, task_source, task_id, period_key)` 的冲突
   * 别改成先 SELECT 再 INSERT：那是两次往返，且并发下仍会撞（虽然本项目是单进程同步，
   * 但没有理由把简单的事写复杂）。
   */
  insertOccurrence(uid, source, taskId, periodKey, doneAt) {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO task_occurrences
           (user_id, task_source, task_id, period_key, done_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(uid, source, taskId, periodKey, doneAt, doneAt, doneAt);
    return r.changes;
  },

  /**
   * 功能：删掉某条任务某一期的打卡记录。
   * @param {number} uid - 用户 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @param {string} periodKey - 本期的周期起点日期 `YYYY-MM-DD`
   */
  deleteOccurrence(uid, source, taskId, periodKey) {
    const r = this.db
      .prepare('DELETE FROM task_occurrences WHERE user_id=? AND task_source=? AND task_id=? AND period_key=?')
      .run(uid, source, taskId, periodKey);
    return r.changes > 0;
  },

  /**
   * 功能：取某条任务已打卡的期，按 `period_key` 升序。
   * @param {number} uid - 用户 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @returns {Array.<Object>} 记录行数组
   */
  listOccurrences(uid, source, taskId) {
    return this._listSql(
      'SELECT * FROM task_occurrences WHERE user_id=? AND task_source=? AND task_id=? ORDER BY period_key ASC',
      [uid, source, taskId],
    );
  },

  /**
   * 功能：取该账号**全部**打卡记录（看板一次拿齐，避免「每条周期任务各发一次请求」）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 记录行数组（按 `task_source`、`task_id`、`period_key` 升序）
   */
  listOccurrencesOfUser(uid) {
    return this._listSql(
      'SELECT * FROM task_occurrences WHERE user_id=? ORDER BY task_source ASC, task_id ASC, period_key ASC',
      [uid],
    );
  },
};

module.exports = { ops };
