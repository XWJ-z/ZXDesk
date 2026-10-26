'use strict';
/**
 * modules/tasks/lib/projects.js —— 项目与项目任务（0.2.0，审查报告 B2）
 *
 * 功能：项目与项目任务的业务方法。项目侧有 `listProjects` / `createProject` /
 *      `updateProject` / `deleteProject`，以及归属判定 `ownsProject` 与写操作前的
 *      `_assertProjectOwned`；项目任务侧有 `listProjectTasks` / `createProjectTask` /
 *      `updateProjectTask` / `deleteProjectTask`。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⚠️ 方法体是从改造前的 `db.js` 按字节切出来的（分岔那段搬去了 backend/*.js）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/projects.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了一处：`helpers.js` 的相对路径
 *    （多上跳三层）。方法体一个字没动 —— 「项目 / 项目任务是任务板模块自己的业务」。
 *    ⚠️ 它用的 `_insert` / `_update` 是**通用**写原语，留在
 *    `core/store/methods/task-writes.js`（六个模块共用，见那个文件的说明）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.14
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md
 */
const { today, nowStamp, clampRange } = require('../../../core/store/helpers.js');

module.exports = {
  // ---- projects ----
  /**
   * 功能：列出某账号名下的全部项目，按 `sort_order`、`id` 升序。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 项目行数组
   */
  listProjects(uid) {
    return this._bk.listProjects(uid);
  },

  /**
   * 功能：新建项目 —— 未传的字段在这里兜底（名称「未命名项目」、颜色 `#3b82f6`、
   *      状态 `doing` 等），随后交给通用 `_insert`。
   * @param {number} uid - 账号 id，作为项目归属写入 `user_id`
   * @param {Object} input - 项目字段：name / description / color / icon / status / sort_order
   * @returns {Object} 新建的项目行（含回填的 `id`）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  createProject(uid, input) {
    const row = {
      user_id: Number(uid),
      name: input.name || '未命名项目',
      description: input.description || '',
      color: input.color || '#3b82f6',
      icon: input.icon || '',
      status: input.status || 'doing',
      sort_order: input.sort_order || 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    return this._insert('projects', row);
  },

  /**
   * 功能：更新项目 —— 直接交给通用 `_update`，可改的列由 `projects` 的 `allowedCols` 白名单限定，
   *      并顺带刷新 `updated_at`。
   *
   * 说明：⚠️ `_update()` 不会把 `id` / `user_id` 写进 SET —— 别绕过它，
   *      否则一次 PUT 就能把记录「过户」给别人。
   *
   * @param {number} uid - 账号 id（限定只能改自己的行）
   * @param {number} id - 项目 id
   * @param {Object} input - 要改的字段（不在白名单里的一律被忽略）
   * @returns {boolean} 是否真的更新到了（无可改字段、或项目不归本人时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  updateProject(uid, id, input) {
    return this._update('projects', uid, id, input);
  },

  /**
   * 功能：删除项目，并连同它名下的全部项目任务一并删除。
   * @param {number} uid - 账号 id
   * @param {number} id - 项目 id
   * @returns {boolean} 是否真的删掉了项目行
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  deleteProject(uid, id) {
    this._assertWritable();
    // ⭐⭐ 0.8.10 追加批：删项目**连带**删成员与上报 ——
    //    项目是**组织**（不是事实凭证）⇒ 与「删行程只解绑」**刻意相反**，
    //    照任务板既有的「删项目连带删任务」口径。⚠️ 顺序：先取任务 id（项目没了就取不到了），
    //    再删上报，最后删成员与项目本身。
    // ⭐⭐ 0.8.12：成员与上报那两张表搬去了 `modules/teamwork`，
    //    这两个 op 也搬走了 ⇒ 用 `typeof` 守卫调用（`modules/teamwork` 被整目录删掉时协作面本就消失）。
    //    另：状态配置 / 评论 / 附件（含磁盘）的连带清理由 `tasks/backend/*.js` 的 `deleteProject`
    //    在项目行真被删掉时经 `_bk` 调 teamwork 的 `deleteProjectCollabData()` 一处负责。
    const taskIds = (this._bk.listProjectTasks(uid, id) || []).map((t) => Number(t.id));
    if (typeof this._bk.deleteTaskReportsOfTasks === 'function') {
      this._bk.deleteTaskReportsOfTasks('project_tasks', taskIds);
    }
    if (typeof this._bk.deleteProjectMembersOfProject === 'function') {
      this._bk.deleteProjectMembersOfProject(id);
    }
    // ⭐⭐ 0.8.14：⭐ **先**把该项目名下任务的 id 取出来（上面 `taskIds` 就是），
    //    再逐个清掉随手记上的绑定 —— 项目级联删掉之后这些 id 就查不出来了（"先取后删"）。
    //    ⚠️ 这一步与「删项目任务」那条路**各管各的**：项目级联删走的是 `_bk.deleteProject`
    //    （项目任务行由它按 project_id 一把删光，**不经过** `deleteProjectTask`）⇒ 两处都要写，
    //    只写一处会让「删项目」这条路留下永远指空的「已变成任务」。
    if (typeof this.clearIdeaTask === 'function') {
      for (const tid of taskIds) {
        try {
          this.clearIdeaTask(Number(uid), 'project', tid);
        } catch (_e) {
          /* 绑定清不掉是小事，项目照删 */
        }
      }
    }
    return this._bk.deleteProject(uid, id);
  },

  /**
   * 功能：判断项目是否属于该账号（不存在、或属于别人 → `false`）。
   *
   * 说明：⭐ 只读接口也需要它：`GET /api/projects/:id/tasks` 过去直接按 `user_id` 过滤返回数组，
   *      于是「项目不存在」「项目是别人的」「项目存在但没任务」三种情况**长得一模一样**（`200 []`）。
   *      三者一致确实不泄露信息，但「越权」看起来就像「正常但为空」，验收和排查都很吃亏 ——
   *      现在交给路由层统一判 404（方案 §六 #6）。
   *
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {boolean} 项目存在且归该账号所有时为 true
   */
  ownsProject(uid, projectId) {
    return this._bk.ownsProject(uid, projectId);
  },

  /**
   * 功能：校验项目归属：不属于 `uid`（或根本不存在）时抛 404。
   *
   * 说明：用于「在项目下建任务」这类**必须校验父资源归属**的写操作 ——
   *      否则 B 可以往 A 的项目里塞任务。
   *
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {void}
   * @throws {Error} 项目不归该账号所有时抛 404
   */
  _assertProjectOwned(uid, projectId) {
    if (!this.ownsProject(uid, projectId)) {
      const err = new Error('项目不存在');
      err.status = 404;
      throw err;
    }
  },

  // ---- project tasks ----
  /**
   * 功能：列出某个项目下属于该账号的全部任务，按 `sort_order`、`id` 升序。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 项目任务行数组
   */
  listProjectTasks(uid, projectId) {
    return this._bk.listProjectTasks(uid, projectId);
  },

  /**
   * 功能：在项目下新建任务 —— 未传字段在这里兜底，日期区间交给 `clampRange` 清洗后写入。
   *
   * 说明：先校验父项目必须属于本人 —— 否则 B 能把自己的任务挂到 A 的项目下
   *      （污染 A 的项目、留下删不掉的孤儿行）。
   *
   * @param {number} uid - 账号 id，作为任务归属写入 `user_id`
   * @param {number} projectId - 父项目 id
   * @param {Object} input - 任务字段：title / description / status / start_date / due_date /
   *      assignee / tag / important / urgent / sort_order
   * @returns {Object} 新建的项目任务行（含回填的 `id`）
   * @throws {Error} 父项目不归本人所有时抛 404；数据层只读时抛 503
   */
  createProjectTask(uid, projectId, input) {
    // 父项目必须属于本人：否则 B 能把自己的任务挂到 A 的项目下（污染 A 的项目、留下删不掉的孤儿行）
    this._assertProjectOwned(uid, projectId);
    const row = {
      project_id: Number(projectId),
      user_id: Number(uid),
      title: input.title || '未命名任务',
      description: input.description || '',
      status: input.status || 'todo',
      completed_at: input.status === 'done' ? nowStamp() : null,
      start_date: input.start_date || input.due_date || today(),
      due_date: input.due_date || today(),
      assignee: input.assignee || '',
      tag: input.tag || '',
      important: input.important ? 1 : 0,
      urgent: input.urgent ? 1 : 0,
      // ⭐ 0.4.4：从对话里的哪条消息建的（没有就是 null）—— 与日常任务同一套（见 schema/tasks.js 文件头）
      from_message_id: input.from_message_id ? Number(input.from_message_id) : null,
      // ⭐ 0.5.2：绑的网址（`0` / 没传 = 不绑 → 存 null）。⚠️ 这里必须**逐列显式带上**：
      //    `createProjectTask` 不是走 PUT 的白名单，row 里没有这个键就**静默不写** ——
      //    0.5.2 首轮实测踩过：新建任务选了网址、保存后是 null（测试者反馈「绑定没生效」）。
      bookmark_id: input.bookmark_id ? Number(input.bookmark_id) : null,
      // ⭐⭐ 0.8.14：任务类型这一维度（与日常任务同一套）——
      //    ⚠️ 逐列显式带上，键漏一个就是那一列**静默不写**（见上面 `bookmark_id` 那条实测教训）。
      task_kind: input.task_kind || 'plain',
      start_time: input.start_time || null,
      due_time: input.due_time || null,
      recur_rule: input.recur_rule || null,
      sort_order: input.sort_order || 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    const created = this._insert('project_tasks', clampRange(row));
    // ⭐⭐ 0.8.14：这条任务是**从随手记「变成任务」过来的** ⇒ 建完**回绑**那条
    //    随手记 —— 与日常任务 `createDailyTask()` 里那一段**逐字同构**（同一处纪律、同一条理由，
    //    那里有完整说明）。⚠️ 灵感模块被整目录删掉 ⇒ `bindIdeaTask` 不在 ⇒ 静默跳过，任务照常建好。
    const iid = input && input.from_idea ? Number(input.from_idea.id) : 0;
    if (created && created.id && iid && typeof this.bindIdeaTask === 'function') {
      try {
        this.bindIdeaTask(Number(uid), iid, 'project', created.id);
      } catch (_e) {
        /* 绑不上就绑不上，任务已经建好了 */
      }
    }
    return created;
  },

  /**
   * 功能：更新项目任务 —— 与 `updateDailyTask` 走**同一套** `completed_at` 维护规则
   *      （见 `_maintainCompletedAt`）。
   *
   * 说明：0.1.2 之前这里只是通用 `_update`，项目任务**根本没有完成时间这一列**：
   *      于是「完成时间之后不再出现在计划日期里」这条规则对项目任务无从谈起。
   *      `updateProjectTask()` 不可绕过：`completed_at` 是状态跃迁的派生物，
   *      直接调 `_update()` 会再丢完成时间。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 项目任务 id
   * @param {Object} input - 要改的字段（先经 `_maintainCompletedAt` 补齐 `completed_at`）
   * @returns {boolean} 是否真的更新到了
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  updateProjectTask(uid, id, input) {
    return this._update('project_tasks', uid, id, this._maintainCompletedAt('project_tasks', uid, id, input));
  },

  /**
   * 功能：删除一条项目任务。
   * @param {number} uid - 账号 id
   * @param {number} id - 项目任务 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  deleteProjectTask(uid, id) {
    this._assertWritable();
    // ⭐⭐ 0.8.10 追加批：任务没了，挂在它上面的上报也没有意义（同「删项目连带」）。
    // ⭐ 0.8.12：上报那张表搬去了 `modules/teamwork`，这个 op 也搬走了
    //    ⇒ `typeof` 守卫调用（模块被整目录删掉时协作面本就消失）。任务级评论 / 附件的连带清理
    //    由 `tasks/backend/*.js` 的 `deleteProjectTask` 经 `_bk` 调 teamwork 的
    //    `deleteTaskCollabData()` 一处负责。
    if (typeof this._bk.deleteTaskReportsOfTasks === 'function') {
      this._bk.deleteTaskReportsOfTasks('project_tasks', [Number(id)]);
    }
    const r = this._bk.deleteProjectTask(uid, id);
    // ⭐⭐ 0.8.14：任务被删 ⇒ 清掉随手记上那条绑定（理由与 `deleteDailyTask()`
    //    那一段一字不差）。⚠️ `typeof` 守卫 ＋ 吞异常照旧。
    if (r && typeof this.clearIdeaTask === 'function') {
      try {
        this.clearIdeaTask(Number(uid), 'project', Number(id));
      } catch (_e) {
        /* 绑定清不掉是小事，任务已经删了 */
      }
    }
    return r;
  },
};
