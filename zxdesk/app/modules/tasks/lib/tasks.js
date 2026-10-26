'use strict';
/**
 * modules/tasks/lib/tasks.js —— 日常任务的业务方法（0.2.0，审查报告 B2）
 *
 * 功能：日常任务的业务方法 —— `listDailyTasks` / `createDailyTask` / `updateDailyTask` /
 *      `deleteDailyTask`，与取单条的 `_findTask` / `_findDailyTask`；`_maintainCompletedAt`
 *      负责 `completed_at` 的状态跃迁维护。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⚠️ 方法体是从改造前的 `db.js` 按字节切出来的（分岔那段搬去了 backend/*.js）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/tasks.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了一处：`helpers.js` 的相对路径。
 *    ⚠️ 与它**同源**的 `_insert` / `_update`（通用写原语，六个模块共用）**没有跟着搬** ——
 *    它们留在 `core/store/methods/task-writes.js`：搬进模块目录之后，**删掉本模块**
 *    会让收藏夹 / 硬件 / 密码库 / 课表 / 对话的写入全部变成运行期 `undefined`
 *    （施工单 §2 的硬约束，也是本批最重要的一处划分）。
 *    ⚠️ `_findTask` / `_maintainCompletedAt` / `_findDailyTask` **跟着本模块走**：
 *    它们只服务两类任务（`projects.js` 的 `updateProjectTask()` 与这里的 `updateDailyTask()`），
 *    是任务板自己的业务。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.14
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/架构文档/05-任务板.md
 */
const { today, nowStamp, clampRange } = require('../../../core/store/helpers.js');

module.exports = {
  // ---- daily tasks ----
  /**
   * 功能：把一条任务**搬到另一个归属**（日常任务 ⇄ 某个项目）—— ⭐ 0.8.14：
   *      「任务的归属要可以修改」。
   *
   * 说明：⭐⭐ 这是**真正的搬移**：往目标表插一行新的、把原来那行删掉。
   *      为什么要这么麻烦 —— `daily_tasks` 与 `project_tasks` 是**两张物理表、列也不一样**，
   *      没有「改一个 `project_id` 就换归属」这回事（那是把两张表合并的大重构，不在本次射程）。
   *      ⚠️⭐ 因此 **id 会变**（新表新行）⇒ 两处「按 id 挂着的东西」必须一起搬，漏了都**不报错**：
   *      ① 周期任务的打卡记录（`task_occurrences` 按 `task_source` + `task_id` 认任务）；
   *      ② 随手记「变成任务」的追溯（`idea_items.task_id` / `task_source`）。
   *      ⚠️ 目标表**没有的列直接丢弃**：搬到日常任务时 `assignee` / `tag` 留不下（那张表压根没有
   *      这两列）。这是两张表的固有差异，⛔ 不要为了搬家给 `daily_tasks` 也补这两列。
   *      ⚠️ 搬完**不预设**「完成状态 / 打卡」会变：`status` / `completed_at` / 打卡记录原样跟着走。
   *
   * @param {number} uid - 账号 id
   * @param {(string|number)} from - 原归属：`'daily'` 或项目 id
   * @param {(number|string)} id - 任务 id
   * @param {(string|number)} to - 新归属：`'daily'` 或项目 id
   * @returns {?Object} 搬过去之后的**新**任务行（含新 `id`）；任务不存在 / 不是自己的 / 目标项目
   *      不是自己的 ⇒ `null`（由 HTTP 层收口成 404）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  moveTask(uid, from, id, to) {
    this._assertWritable();
    const src = from === 'daily' || from == null || from === '' ? 'daily' : Number(from);
    const dst = to === 'daily' || to == null || to === '' ? 'daily' : Number(to);
    const row = this._bk.findTask(src === 'daily' ? 'daily_tasks' : 'project_tasks', Number(uid), Number(id));
    if (!row) return null;
    // 归属没变 ⇒ 幂等：原样把这一行还回去（⛔ 不要白搬一趟，那会让 id 平白变掉）
    if (String(src) === String(dst)) return row;
    if (dst !== 'daily' && !this.ownsProject(uid, dst)) return null;
    // ⚠️ 逐列显式建 row：只搬**两张表都有**的那些键（键漏了就是那一列静默不写，本项目踩过）
    //    ⚠️⭐ **内容列名两张表不一样**：日常任务叫 `content`、项目任务叫 `description` ——
    //    把 `content` 带进 `project_tasks` 会当场 500（`table project_tasks has no column named content`，
    //    第一次跑用例就撞上了）⇒ 内容列在下面按目标表**单独给**，⛔ 不放这里。
    const base = {
      title: row.title || '未命名',
      important: Number(row.important) ? 1 : 0,
      urgent: Number(row.urgent) ? 1 : 0,
      bookmark_id: row.bookmark_id ? Number(row.bookmark_id) : null,
      from_message_id: row.from_message_id ? Number(row.from_message_id) : null,
      start_date: row.start_date || row.due_date || today(),
      due_date: row.due_date || today(),
      status: row.status === 'done' ? 'done' : 'todo',
      completed_at: row.completed_at || null,
      sort_order: Number(row.sort_order) || 0,
      task_kind: row.task_kind || 'plain',
      start_time: row.start_time || null,
      due_time: row.due_time || null,
      recur_rule: row.recur_rule || null,
      created_at: row.created_at || nowStamp(),
      updated_at: nowStamp(),
    };
    // ⚠️ 内容列按目标表给（见上面那段）：两个键都兜底取，老数据里可能只有其中一个
    const text = row.content || row.description || '';
    const target =
      dst === 'daily'
        ? Object.assign({ user_id: Number(uid), content: text }, base)
        : Object.assign({ user_id: Number(uid), project_id: Number(dst), creator_id: Number(uid), description: text }, base);
    const created = this._insert(dst === 'daily' ? 'daily_tasks' : 'project_tasks', clampRange(target));
    if (!created || !created.id) return null;
    const srcSource = src === 'daily' ? 'daily' : 'project';
    const dstSource = dst === 'daily' ? 'daily' : 'project';
    // ① 打卡记录跟着搬（只对周期任务有意义，其余 `listOccurrences` 回空数组）
    const ticks = this._bk.listOccurrences(Number(uid), srcSource, Number(id)) || [];
    for (const o of ticks) {
      this._bk.insertOccurrence(Number(uid), dstSource, Number(created.id), o.period_key, o.done_at);
      this._bk.deleteOccurrence(Number(uid), srcSource, Number(id), o.period_key);
    }
    // ② 随手记的追溯改绑到新 id（⚠️ 灵感模块被整目录删掉 / 出错都不许拦住搬家 —— 与
    //    `createDailyTask()` 里 `bindIdeaTask` 那条同一条纪律）
    if (typeof this.rebindIdeaTask === 'function') {
      try {
        this.rebindIdeaTask(Number(uid), srcSource, Number(id), dstSource, Number(created.id));
      } catch (_e) {
        /* 追溯没搬过去不影响任务本身 */
      }
    }
    // ③ 最后删原行（⚠️ 顺序不能反：先删后插一旦插入失败，任务就凭空没了）
    if (src === 'daily') this._bk.deleteDailyTask(Number(uid), Number(id));
    else this._bk.deleteProjectTask(Number(uid), Number(id));
    return created;
  },

  /**
   * 功能：列出某账号名下的全部日常任务，按 `sort_order`、`id` 升序。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 日常任务行数组
   */
  listDailyTasks(uid) {
    return this._bk.listDailyTasks(uid);
  },

  /**
   * 功能：新建日常任务 —— 未传字段在这里兜底，日期区间交给 `clampRange` 清洗后写入。
   * @param {number} uid - 账号 id，作为任务归属写入 `user_id`
   * @param {Object} input - 任务字段：title / content / important / urgent /
   *      start_date / due_date / status / sort_order
   * @returns {Object} 新建的日常任务行（含回填的 `id`）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  createDailyTask(uid, input) {
    const row = {
      user_id: Number(uid),
      title: input.title || '未命名',
      content: input.content || '',
      important: input.important ? 1 : 0,
      urgent: input.urgent ? 1 : 0,
      start_date: input.start_date || input.due_date || today(),
      due_date: input.due_date || today(),
      status: input.status || 'todo',
      completed_at: input.status === 'done' ? nowStamp() : null,
      // ⭐ 0.4.4：从对话里的哪条消息建的（没有就是 null）。**写一次就定死** ——
      //    它不在 `allowedCols` 里，所以任何 PUT 都改不到它（见 schema/tasks.js 文件头）。
      from_message_id: input.from_message_id ? Number(input.from_message_id) : null,
      // ⭐ 0.5.2：绑的网址（`0` / 没传 = 不绑 → 存 null）—— 与 createProjectTask 同一处的教训：
      //    逐列显式建 row，键漏了就**静默不写**（首轮实测踩过，见 projects.js 同名注释）。
      bookmark_id: input.bookmark_id ? Number(input.bookmark_id) : null,
      // ⭐⭐ 0.8.14：任务类型这一维度 —— ⚠️ 同样是「逐列显式建 row」，
      //    这四个键漏一个就是那一列**静默不写**（本项目在 `bookmark_id` 上真的踩过）。
      task_kind: input.task_kind || 'plain',
      start_time: input.start_time || null,
      due_time: input.due_time || null,
      recur_rule: input.recur_rule || null,
      sort_order: input.sort_order || 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    const created = this._insert('daily_tasks', clampRange(row));
    // ⭐ 0.7.2：这条任务是**从课表的「本节备注」过来的**（表单里点了保存）⇒ 建完**回绑**那条备注
    //    —— 两边本质是同一个东西。跨模块只走 store 上的既有方法。
    //    ⚠️ 课表模块被整目录删掉 / 被账号关掉时 `linkDayNoteTask` 压根不在 ⇒ **静默跳过**，
    //    任务照常建好（任务不能被别的模块连累，与 `timetable/store.js` 的 `_syncNoteTask` 同一条纪律）。
    //    ⚠️ 认不出形状的 `from_day_note` 一律当没传：它只用来回绑，绑不上不影响任务本身。
    //    ⚠️ 回绑失败**不许**把「建任务」带崩 —— 数据层只读降级时会抛，吞掉即可
    //    （备注那侧下次改还会重建绑定，不会留下不一致的语义）。
    const src = input && input.from_day_note;
    const tid = src ? Number(src.term_id) : 0;
    const sid = src ? Number(src.session_id) : 0;
    const date = src ? String(src.date || '').trim() : '';
    if (created && created.id && tid && sid && date && typeof this.linkDayNoteTask === 'function') {
      try {
        this.linkDayNoteTask(Number(uid), tid, { session_id: sid, date }, created.id);
      } catch (_e) {
        /* 见上面第三条说明：绑不上就绑不上，任务已经建好了 */
      }
    }
    // ⭐⭐ 0.8.14：这条任务是**从随手记「变成任务」过来的**（走留白事件
    //    `zx:task-draft` ＋ 任务板自己的草稿表单）⇒ 建完**回绑**那条随手记。⭐ 与上面
    //    `from_day_note` → `linkDayNoteTask()` **逐字同构**：同一处落点、同一条纪律。
    //    ⚠️ 为什么不让随手记「建完再 PUT 一次」把 task_id 写回去（那正是 0.8.13 以前的做法）：
    //    表单一旦交给任务板，刚建出来的任务 id 就**到不了随手记手里**了 —— 剩下的只有
    //    「再读一次任务列表猜哪条是刚建的」那种不可靠做法（方案 §四②末段）。
    //    ⚠️ 灵感模块被整目录删掉 ⇒ `bindIdeaTask` 压根不在 ⇒ **静默跳过**，任务照常建好。
    //    ⚠️ 回绑失败**不许**把「建任务」带崩（数据层只读降级时会抛，吞掉即可 —— 与上面同一条）。
    const iid = input && input.from_idea ? Number(input.from_idea.id) : 0;
    if (created && created.id && iid && typeof this.bindIdeaTask === 'function') {
      try {
        this.bindIdeaTask(Number(uid), iid, 'daily', created.id);
      } catch (_e) {
        /* 绑不上就绑不上，任务已经建好了 */
      }
    }
    return created;
  },

  /**
   * 功能：维护 `completed_at`（**状态跃迁的派生物**，日常任务与项目任务共用同一套规则），
   *      返回补过该字段的新对象，不改动调用方传入的 `input`。
   *
   * 说明：历史缺陷（0.0.8 由测试套件发现，0.1.2 扩到项目任务）：`completed_at` 只在
   *      **创建时状态即为 done** 才写入，事后勾选完成不补写、取消完成也不清空，
   *      导致该字段在事后完成的任务上恒为 `null`。现在的规则是：
   *      · 调用方**显式**传了 `completed_at` 就尊重它，不自动维护（含显式传 null）
   *      · 没传 `status` 就不碰 `completed_at`
   *      · 迁入 done → 补写当前时间戳；迁出 done → 清空为 null
   *      · 已是 done 再标 done 不重写时间戳（保留首次完成时刻，便于「完成时间」排序）
   *      ⚠️ 这个字段现在是**有语义的**，不只是个记录：前端按「完成日之后不再显示这条任务」
   *      来排计划日期（需求）。所以「迁出 done 必须清空」不是可选项 ——
   *      留着旧时间戳会让一条被重新打开的任务在它原来完成日之后的日期里继续隐身。
   *      也正因如此，`updateDailyTask()` / `updateProjectTask()` **不可绕过**：
   *      `completed_at` 是状态跃迁的派生物，直接调 `_update()` 会再丢完成时间。
   *
   * @param {string} table - 表名，'daily_tasks' 或 'project_tasks'
   * @param {number} uid - 账号 id
   * @param {number} id - 任务 id
   * @param {Object} input - 调用方传入的更新字段
   * @returns {Object} 补过 `completed_at` 的新字段对象
   */
  _maintainCompletedAt(table, uid, id, input) {
    const next = Object.assign({}, input);
    if (next.completed_at === undefined && next.status !== undefined) {
      const prev = this._findTask(table, uid, id);
      if (prev) {
        const wasDone = prev.status === 'done';
        const isDone = next.status === 'done';
        if (isDone && !wasDone) next.completed_at = nowStamp();
        else if (!isDone && wasDone) next.completed_at = null;
        // ⭐⭐ 0.8.14：状态**迁入 done** ⇒ 顺手把「这条任务是从哪条随手记来的」
        //    那条随手记**归档**（「任务完成之后，这个随手记也要变为归档」）。
        //    ⚠️ 落在这里的理由：`_maintainCompletedAt()` 是「状态迁入 done」的**唯一判定处**
        //    （日常任务与项目任务共用），落在这儿就**只有一处**，不会漏掉某条路径。
        //    ⚠️ `typeof` 守卫 ⇒ 灵感模块被整目录删掉时**静默跳过**，任务照常标完成
        //    （与 `linkDayNoteTask` / `syncDayNoteFromTask` 同一条纪律）。
        //    ⚠️ 绑不上的（这条任务不是从随手记来的）那边第一行就返回了，是一次纯内存查询，
        //    别为了省它加缓存。
        //    ⭐ **不对称是刻意的**：取消完成**不自动取回**归档 —— 库里分不出「因为任务完成而归档」
        //    与「用户手动归档」（要分开就得再加一列），而用户想取回，界面上那颗「取回」一直都在。
        if (isDone && !wasDone && typeof this.archiveIdeaByTask === 'function') {
          try {
            this.archiveIdeaByTask(Number(uid), table === 'project_tasks' ? 'project' : 'daily', id);
          } catch (_e) {
            /* 归档失败不该把「标完成」带崩（数据层只读时归档那侧同样写不动，状态一致） */
          }
        }
      }
    }
    return next;
  },

  /**
   * 功能：更新日常任务（`completed_at` 规则见 `_maintainCompletedAt`）。
   *
   * 说明：`updateDailyTask()` 不可绕过：`completed_at` 是状态跃迁的派生物，
   *      直接调 `_update()` 会再丢完成时间。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 日常任务 id
   * @param {Object} input - 要改的字段（先经 `_maintainCompletedAt` 补齐 `completed_at`）
   * @returns {boolean} 是否真的更新到了
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  updateDailyTask(uid, id, input) {
    const r = this._update('daily_tasks', uid, id, this._maintainCompletedAt('daily_tasks', uid, id, input));
    // ⭐ 0.7.2：**任务侧改了标题 ⇒ 回写绑定的那条「本节备注」**（双向同步的回程）。
    //    跨模块只走 store 上已有的方法—— 与 `teamwork/ticker.js` 调课表的 `listPeriods`
    //    是同一种走法，⛔ 没有 import 任何课表模块的实现。
    //    ⚠️ 课表模块是**可以被整目录删掉**的 ⇒ 先判方法在不在；拿不到就什么都不做（任务照常改）。
    //    ⚠️ 只认 `title`：改日期 / 标记完成**不回写** —— 那些在备注侧没有对应物
    //    （备注只有一句话，没有「截止日」「完成态」可言）。
    //    ⚠️ 绝大多数任务没有绑定，那边第一行就返回了，是一次纯内存判断，别为了省它加缓存。
    if (input && input.title !== undefined && typeof this.syncDayNoteFromTask === 'function') {
      this.syncDayNoteFromTask(uid, id, input.title);
    }
    return r;
  },

  /**
   * 功能：按 id 取一条任务（两种后端统一行为，且**限定归属**）。
   * @param {string} table - 表名，'daily_tasks' 或 'project_tasks'
   * @param {number} uid - 账号 id
   * @param {number} id - 任务 id
   * @returns {?Object} 任务行；不存在或不属于该账号时为 null
   */
  _findTask(table, uid, id) {
    return this._bk.findTask(table, uid, id);
  },

  /**
   * 功能：按 id 取一条日常任务（`_findTask` 对 'daily_tasks' 的便捷封装）。
   * @param {number} uid - 账号 id
   * @param {number} id - 日常任务 id
   * @returns {?Object} 日常任务行；不存在或不属于该账号时为 null
   */
  _findDailyTask(uid, id) {
    return this._findTask('daily_tasks', uid, id);
  },

  /**
   * 功能：删除一条日常任务。
   * @param {number} uid - 账号 id
   * @param {number} id - 日常任务 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  deleteDailyTask(uid, id) {
    this._assertWritable();
    const r = this._bk.deleteDailyTask(uid, id);
    // ⭐⭐ 0.8.14：任务被删 ⇒ 清掉随手记上那条**绑定** —— 否则那条随手记
    //    永远顶着一枚**指空的**「已变成任务」，而且再也点不了「变成任务」（`bindIdeaTask`
    //    只在「本来没有绑定」时才写）。
    //    ⚠️ `typeof` 守卫照旧（灵感模块可整目录删）；清绑定失败不带崩删除本身。
    if (r && typeof this.clearIdeaTask === 'function') {
      try {
        this.clearIdeaTask(Number(uid), 'daily', id);
      } catch (_e) {
        /* 见上：绑定清不掉是小事，任务已经删了 */
      }
    }
    return r;
  },
};
