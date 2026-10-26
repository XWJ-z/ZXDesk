/**
 * modules/tasks/routes.js —— 任务板与首屏聚合相关的业务路由
 *
 * 功能：`handleTasks`（本人全部任务）、`handleDaily`、`handleProjects`（项目与其任务）、
 *      `handleSummary`（首页汇总看板）、`handleTodayCount`（今日待办数）、
 *      `handleSearch`（全局搜索）、`handleExport`（导出完整 JSON 备份）。
 *
 * ⚠️ 拆自 `server.js`（002 报告 §5.1 ①），**只搬家不改逻辑**；运行期单例从 `../../core/context.js` 取。
 * ⚠️ `handleTasks` 与 `handleSummary` 是 0.2.0 的首屏聚合接口（**纯增量**，老接口一个没删）；
 *    聚合接口最容易出的问题是「悄悄少算一项或过滤条件写宽」，而前端根本察觉不到。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/routes/tasks.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了三处：① 相对路径；
 *    ② 导出键从七个 `handleXxx` 改成 **`module.json` 声明的七个 `apiPrefix`**
 *    （`tasks` / `projects` / `daily` / `export` / `search` / `summary` / `today-count`）——
 *    `server.js` 的 `routeTable()` 据此自动挂到 `/api/<键>` 上，模块自己不用认识路由表；
 *    ③ 本段说明。处理函数体一个字没动。
 *    ⚠️ `handleSummary` / `handleSearch` 调的是 `store.summary()` / `store.search()` ——
 *    那是**核心**（`store/methods/stats.js`）的方法（跨模块汇总），所以本模块搬走时它们**不跟着走**。
 *
 * ⭐ 0.8.12：原先挂在本文件的 `handleCollab()`（`/api/collab/*`）
 *    与它的 `collab` 导出键、`checkTaskReport` / `readBodyToFile` / `rfc5987` / `FILE_MAX_BYTES` / `fs`
 *    依赖，**整份搬去了 `modules/teamwork/routes.js`** —— ⚠️ 接口路径一个字节没改
 *    （`teamwork/module.json` 的 `apiPrefix` 里加回了 `collab`）。
 *
 * ⭐⭐ 0.8.14：本文件新增**第八个键** `occurrences` —— 周期任务的打卡接口
 *    （`GET / POST / DELETE /api/occurrences`，见 `handleOccurrences()`），
 *    并让三个列表接口顺手带上每条周期任务的打卡期。
 *    ⭐ 0.8.17：那个「挂打卡期」的原语**搬去 store 了** ——
 *    它从本文件的局部函数 `attachTicks()` 变成 `store.attachTicks(uid, rows, source)`
 *    （实现住 `modules/tasks/lib/occurrences.js`，与 `listOccurrencesOfUser` 同屋）。
 *    为什么搬：协作看板也要给**周期任务**挂同一份打卡期（它的卡片走另一条取数路径），
 *    而跨模块只许走 store 的公开业务方法⇒ 它必须住在 store 上。⚠️ 只搬不重写。
 *
 * ⭐⭐ 0.8.14 修订（第四轮「**任务的归属要可以修改**」）：`handleTasks` 不再是
 *    「只读」的那一个 —— 多了 `POST /api/tasks/move`（body `{ from, id, to }`，把一条任务搬到
 *    另一个归属；真身是 `store.moveTask()`）。⚠️ 它是本模块**唯一**一个挂在 `tasks` 这个键上的
 *    写接口，⛔ 别把别的写操作也塞进来（改任务走 `/api/daily/:id` 与 `/api/projects/:pid/tasks/:id`）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.17
 * 相关：docs/公共/架构文档/05-任务板.md
 */
'use strict';

const { checkDailyTask, checkProject, checkProjectTask } = require('../../core/validate.js');
const { httpError, idParam, json, notFound, readBody, writeResult } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');
const { todayStr } = require('../../core/time-util.js');

/** 任务来源 → 真实表名（`task_occurrences.task_source` 与它逐字对应） @type {Object} */
const SOURCE_TABLE = { daily: 'daily_tasks', project: 'project_tasks' };

/**
 * 功能：判断 `source` 是不是合法的任务来源。
 * @param {string} s - 待判断的值
 * @returns {boolean} 是 `'daily'` / `'project'` 之一则为 true
 */
function isSource(s) {
  return s === 'daily' || s === 'project';
}

/**
 * 功能：按「来源 + 任务 id」确认这条任务**归当前账号**（不存在 / 是别人的一律 404）。
 *
 * 说明：⚠️ 打卡接口必须先过这一关：不过就会变成「往别人的任务上写记录」——
 *      而 `task_occurrences.task_id` 不是外键，数据库拦不住（越权与「不存在」统一 404，
 *      ⛔ 不区分 403 —— 那是一条探测通道）。
 *
 * @param {number} uid - 账号 id
 * @param {string} source - `'daily'` / `'project'`
 * @param {(number|string)} taskId - 任务 id
 * @returns {?Object} 命中的任务行；不归本人 / 不存在时为 null
 */
function findOwnTask(uid, source, taskId) {
  const id = Number(taskId);
  if (!isSource(source) || !Number.isInteger(id) || id <= 0) return null;
  return store._findTask(SOURCE_TABLE[source], uid, id);
}

/**
 * 功能：一次返回当前账号的全部任务（日常任务 + 按项目分组的项目任务），供手机版首屏使用。
 *
 * 说明：⭐ `GET /api/tasks` —— 一次拿齐「我的全部任务」，按 scope 分组（手机版首屏用）。
 *
 * 为什么不是「每个项目发一次」：那是 N+1 —— 10 个项目就是 10 个请求，
 * 每个都要过一次会话校验、一次同步 SQL 查询、一次 JSON 序列化。
 *
 * ⚠️ 权限口径与单项目接口**逐条一致**：项目来自 `listProjects(uid)`，任务是
 *    `listProjectTasks(uid, pid)` —— 批量**不是**放松过滤的理由。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleTasks({ req, res, parts, method, uid }) {
  // ⭐⭐ 0.8.14 修订（第四轮）：`POST /api/tasks/move` —— 把一条任务搬到另一个归属
  //    （日常任务 ⇄ 某个项目）。⚠️ 判据是 `parts[2] === 'move'`（`/api/tasks` 是两段，`parts`
  //    含 `api` ⇒ 本接口是**三段**），与 `/api/occurrences` 那处同一条读法。
  if (method === 'POST' && parts.length === 3 && parts[2] === 'move') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const out = store.moveTask(uid, b.from, b.id, b.to);
      // 任务不是自己的 / 压根没有 / 目标项目不是自己的 ⇒ 一律 404（不区分，免得当探测器用）
      if (!out) return notFound(res);
      return json(res, 200, out);
    });
  }
  if (method !== 'GET') return notFound(res);
  // ⭐ 0.5.2：两条出口都过一遍 `attachBookmarkLinks()` —— 任务上绑的网址要给成
  //    「标题 + 网址」，而不是让前端再拿 `bookmark_id` 去猜（见 `stats.js` 里那个方法的说明）。
  const daily = store.attachTicks(uid, store.attachBookmarkLinks(uid, store.listDailyTasks(uid)), 'daily');
  const byProject = {};
  for (const p of store.listProjects(uid)) {
    byProject[p.id] = store.attachTicks(uid, store.attachBookmarkLinks(uid, store.listProjectTasks(uid, p.id)), 'project');
  }
  return json(res, 200, { daily, byProject });
}

/**
 * 功能：导出当前账号全部数据 —— 以附件形式回一份可直接读的 JSON 快照。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleExport({ res, method, uid }) {
  if (method !== 'GET') return notFound(res);
  const dump = store.exportAll(uid);
  const name = `zxdesk-backup-${String(dump.exportedAt).slice(0, 10)}.json`;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    // ⭐ 009 报告 S4：整份个人数据（任务 / 课表 / 密码库**密文** / AI 记忆明文）的 GET 响应
    //    必须禁缓存 —— 与整体备份 `core/routes/backup.js` 的响应头同一个口径（那里早就有这条）。
    //    ⚠️ 共享机器上「登出后磁盘里还留着上一次的导出」正是这条要挡的。
    'Cache-Control': 'no-store',
  });
  return res.end(JSON.stringify(dump, null, 2));
}

/**
 * 功能：全局搜索 —— 在**当前账号**的日常任务与项目任务里按关键词匹配标题、备注、负责人、标签与项目名。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {URL} ctx.url - 解析好的 URL，查询参数 `q` 为关键词
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleSearch({ res, method, url, uid }) {
  if (method !== 'GET') return notFound(res);
  const q = (url.searchParams.get('q') || '').trim();
  return json(res, 200, store.search(uid, q));
}

/**
 * 功能：统计某一天的今日待办数 —— 区间覆盖该日且尚未完成的任务条数。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {URL} ctx.url - 解析好的 URL，查询参数 `date` 为 `YYYY-MM-DD`（缺省用服务端的今天）
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleTodayCount({ res, method, url, uid }) {
  if (method !== 'GET') return notFound(res);
  // ⚠️ 默认值走服务端统一的 `todayStr()`（本体在 storage.js），**不再在这里重算一遍本地时间**
  const date = (url.searchParams.get('date') || todayStr()).trim();
  return json(res, 200, store.todayCounts(uid, date));
}

/**
 * 功能：首页汇总看板 —— 回当前账号的任务计数与各象限分布。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleSummary({ res, method, uid }) {
  if (method !== 'GET') return notFound(res);
  return json(res, 200, store.summary(uid));
}

/**
 * 功能：处理 `/api/projects` 及其子路径 —— 项目的增删改查，以及项目下任务的新增改删。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleProjects({ req, res, parts, method, uid }) {
  if (method === 'GET' && parts.length === 2) return json(res, 200, store.listProjects(uid));
  if (method === 'POST' && parts.length === 2) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      json(res, 201, store.createProject(uid, checkProject(b)));
    });
  }
  const pid = idParam(parts[2]);
  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      writeResult(res, store.updateProject(uid, pid, checkProject(b)));
    });
  }
  if (method === 'DELETE' && parts.length === 3) return writeResult(res, store.deleteProject(uid, pid));

  // project tasks
  if (parts[3] === 'tasks') {
    // ⚠️ 只读也要校验父项目归属：否则「项目不存在 / 是别人的 / 空项目」都是 200 []，
    //    越权看起来跟正常一样（§六 #6）。三种情况统一 404，响应逐字一致。
    if (method === 'GET' && parts.length === 4) {
      if (!store.ownsProject(uid, pid)) return notFound(res);
      return json(res, 200, store.attachTicks(uid, store.attachBookmarkLinks(uid, store.listProjectTasks(uid, pid)), 'project'));
    }
    if (method === 'POST' && parts.length === 4) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.createProjectTask(uid, pid, checkProjectTask(b))); // 内部 _assertProjectOwned → 404
      });
    }
    const tid = idParam(parts[4]);
    if (method === 'PUT' && parts.length === 5) {
      // 父项目也校验（§六 #5 的「双校验」）：任务行本身按 uid 过滤已经安全，
      // 但 `/api/projects/<别人的项目>/tasks/<我的任务>` 这种自相矛盾的 URL 不该生效。
      if (!store.ownsProject(uid, pid)) return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        writeResult(res, store.updateProjectTask(uid, tid, checkProjectTask(b)));
      });
    }
    if (method === 'DELETE' && parts.length === 5) {
      if (!store.ownsProject(uid, pid)) return notFound(res);
      return writeResult(res, store.deleteProjectTask(uid, tid));
    }
  }
  return notFound(res);
}

/**
 * 功能：处理 `/api/daily` 及其子路径 —— 日常任务的列表、新增、修改与删除。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleDaily({ req, res, parts, method, uid }) {
  if (method === 'GET' && parts.length === 2) {
    return json(res, 200, store.attachTicks(uid, store.attachBookmarkLinks(uid, store.listDailyTasks(uid)), 'daily'));
  }
  if (method === 'POST' && parts.length === 2) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      json(res, 201, store.createDailyTask(uid, checkDailyTask(b)));
    });
  }
  const did = idParam(parts[2]);
  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      writeResult(res, store.updateDailyTask(uid, did, checkDailyTask(b)));
    });
  }
  if (method === 'DELETE' && parts.length === 3) return writeResult(res, store.deleteDailyTask(uid, did));
  return notFound(res);
}

/**
 * 功能：处理 `/api/occurrences` —— ⭐ 0.8.14周期任务的**打卡**接口。
 *
 * 说明：三种动作各一条路，都**先确认这条任务归当前账号**（不存在 / 是别人的统一 404）：
 *      · `GET    /api/occurrences?source=&taskId=` ⇒ 这条任务已打卡的期；
 *      · `POST   /api/occurrences` body `{source, taskId, periodKey}` ⇒ 打卡（**幂等**）；
 *      · `DELETE /api/occurrences?source=&taskId=&periodKey=` ⇒ 取消这一期的打卡。
 *      ⚠️ 打卡走**写闸门**（数据层只读时由 `tickTask` 抛 503），⛔ 不做成「静默成功」。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Object} ctx.url - 解析好的 URL（`GET` / `DELETE` 从查询串取参）
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleOccurrences({ req, res, url, parts, method, uid }) {
  if (parts.length !== 2) return notFound(res);
  if (method === 'GET') {
    const source = String(url.searchParams.get('source') || '');
    const taskId = url.searchParams.get('taskId');
    if (!findOwnTask(uid, source, taskId)) return notFound(res);
    return json(res, 200, store.ticksOf(uid, source, Number(taskId)));
  }
  if (method === 'POST') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      if (!findOwnTask(uid, b.source, b.taskId)) return notFound(res);
      const n = store.tickTask(uid, b.source, Number(b.taskId), b.periodKey);
      // ⚠️ 回的是「这次真新增了几行」——重复打卡回 0 但**仍是 200**（幂等：用户点两下不该看到失败）。
      return json(res, 200, { ok: true, added: n });
    });
  }
  if (method === 'DELETE') {
    const source = String(url.searchParams.get('source') || '');
    const taskId = url.searchParams.get('taskId');
    if (!findOwnTask(uid, source, taskId)) return notFound(res);
    const removed = store.untickTask(uid, source, Number(taskId), url.searchParams.get('periodKey'));
    return json(res, 200, { ok: true, removed });
  }
  return notFound(res);
}

module.exports = {
  // ⭐ 导出键**正好**是 `modules/tasks/module.json` 的 `apiPrefix` 那七个
  //    （`registry.routesFor()` 会核对：暴露了没声明的键一律启动即抛）
  tasks: handleTasks,
  export: handleExport,
  search: handleSearch,
  'today-count': handleTodayCount,
  summary: handleSummary,
  projects: handleProjects,
  daily: handleDaily,
  // ⭐ 0.8.14：周期任务的打卡（导出键必须与 module.json 的 apiPrefix 逐字一致）
  occurrences: handleOccurrences,
};
