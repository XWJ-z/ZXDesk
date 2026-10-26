'use strict';
/**
 * modules/pomodoro/routes.js —— 番茄钟路由（一个屏所需的全部 + 计时状态机）
 *
 * 功能：`handlePomodoro` 一处收全部番茄钟接口 —— 状态聚合（含 `nowMs` 搭车）、开始、
 *      暂停 / 继续 / 结束、改时长偏好、单独取统计。
 *
 * 说明：⭐ **番茄只属于账号本人**（`userScoped`），所以每条带 id 的动作都先过归属校验，
 *      越权与「不存在」统一 404（403 等于告诉对方「这条记录存在，只是不归你」）。
 *
 * 说明：⭐ 接口设计与灵感库 / 硬件台账同构（统一 `ctx` 参数表），鉴权由 `server.js`
 *      的 401 闸门保证 —— `/api/pomodoro/*` 挂在闸门**之后**。
 *
 * ⚠️ **区间校验在接口层**（方案 §5.2）：超区间 / 非数字 / 负数一律 **400**，⛔ **不静默截断**
 *    —— 把 `focus_min=2` 悄悄改成 5 再保存，用户会以为自己设的 2 分钟生效了。
 *    ⭐ `checkCtxTurns` / `checkMemMax`（`modules/ai/routes.js`）就是这条口径的先例。
 *
 * ⚠️ **常量"只写一处、写在用它的文件里"**：**区间**在这里（只有接口层做入参校验），
 *    **默认值**在 `store.js`（存储层判 NULL 要用）。两者都不放同一个文件 —— 若 `store.js`
 *    反过来 require 本文件，装配链会把 `core/context.js` 拉进来（一 require 就建库），
 *    存储层单测当场失去独立性（本项目已记录的坑）。
 *
 * ⭐ **「现在」只取一次**：本文件的 `nowMs` 在整个请求内是同一个值，转手交给业务层 ——
 *    计时相关的一切判定（暂停结算 / 归属日 / 统计边界）因此共享同一个"现在"，
 *    不会出现「同一个请求里两处差了几毫秒、跨过整点就分成两天」这种漂移。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.32
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md
 */

const { httpError, idParam, json, notFound, readBody } = require('../../../core/http-util.js');
const { store } = require('../../../core/context.js');

// ---- 时长区间（方案 §5.2 的四条，与 `store.js` 的默认值配套）----
/** 专注时长（分钟）下限 @type {number} */
const FOCUS_MIN = 5;
/** 专注时长（分钟）上限 @type {number} */
const FOCUS_MAX = 120;
/** 短休时长（分钟）下限 @type {number} */
const BREAK_MIN = 1;
/** 短休时长（分钟）上限 @type {number} */
const BREAK_MAX = 30;
/** 长休时长（分钟）下限 @type {number} */
const LONG_BREAK_MIN = 5;
/** 长休时长（分钟）上限 @type {number} */
const LONG_BREAK_MAX = 60;
/** 长休前要几个轮次：下限 @type {number} */
const ROUNDS_MIN = 2;
/** 长休前要几个轮次：上限 @type {number} */
const ROUNDS_MAX = 8;

/**
 * 绑任务时 `task_source` 的合法取值 —— ⚠️ 与 `core/validate.js` 的 `IDEA_TASK_SOURCES` **同口径**
 * （`daily` = 日常任务，`project` = 项目任务）。
 *
 * 说明：⭐ 这里各留一份是刻意的（常量"写在用它的文件里"）：`core/validate.js` 那两个常量
 *      **没有对外导出**，为了共用去改共用文件属于越界（铁律 11）。
 *      ⚠️ 任务板那边加第三种来源时，**两处都要改** —— 漏一处的表现是「新手来源的任务绑不上」。
 * @type {Array.<string>}
 */
const TASK_SOURCES = ['daily', 'project'];

/**
 * 功能：校验一个「必须是整数且在区间内」的时长参数。
 * @param {*} v - 入参值
 * @param {number} lo - 下限（含）
 * @param {number} hi - 上限（含）
 * @param {string} what - 出错文案里对它的称呼
 * @returns {number} 合法值
 * @throws {Error} 非整数 / 越界时抛 400（⛔ 不截断到最近的合法值）
 */
function checkIntIn(v, lo, hi, what) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    throw httpError(400, `${what}只能是 ${lo}~${hi} 之间的整数`);
  }
  return v;
}

/**
 * 功能：校验并归一化「开始一个番茄」的入参。
 *
 * 说明：⭐ `minutes` 就是「本次专注多少分钟」—— 它**不是**偏好里的 `focus_min`
 *      （那是"下次默认选多久"）。界面上三档预设与自定义值都从这里进来。
 *      ⚠️ **绑任务必须成套给**：`task_id` 与 `task_source` 要么都不给（= 不绑），
 *      要么都给且合法 —— 只给 id 会在库里留下一个"指向哪张表都不知道"的半截指针，
 *      而这一列的意义正是"回溯到哪个任务"。
 *      ⚠️ **不校验任务是否真实存在**：那要查任务表 = 跨模块（铁律 11 /）。
 *      与 `idea.task_id` 同一手法 —— 单向溯源列只存 id，任务被删掉之后这列就成了一条
 *      指向过去的记录，不影响番茄钟自己。
 *
 * @param {*} b - 请求体
 * @returns {{minutes: number, task_id: ?number, task_source: ?string}} 归一化后的入参
 * @throws {Error} 时长越界 / 任务指针不成套时抛 400
 */
function checkPomodoroStart(b) {
  const src = b && typeof b === 'object' ? b : {};
  const minutes = checkIntIn(src.minutes, FOCUS_MIN, FOCUS_MAX, '时长（分钟）');
  const hasTask = src.task_id !== undefined && src.task_id !== null;
  if (!hasTask) return { minutes, task_id: null, task_source: null };
  const id = Number(src.task_id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, '要绑的任务不对');
  if (!TASK_SOURCES.includes(src.task_source)) {
    throw httpError(400, `要绑的任务来源不对（只能是 ${TASK_SOURCES.join(' 或 ')}）`);
  }
  return { minutes, task_id: id, task_source: src.task_source };
}

/**
 * 功能：校验一个**开关**入参（0 / 1）—— ⭐ 0.8.32 的 `sound_on` 用它。
 *
 * 说明：⚠️ 与 `checkIntIn` **分开**是刻意的：那个函数把「不是数字」与「越界」混在一句话里，
 *      而开关的错法不一样（传 `2` / `'yes'` 都该说「只能开或关」）。
 *      ⚠️ 收 boolean 与 0/1 两种写法：前端 `<input type="checkbox">` 给的是 `checked`，
 *      而库里存的是 0/1 —— 在**边界这一处**把两种写法统一成 0/1，读侧就只剩一种形状。
 *
 * @param {*} v - 入参值
 * @param {string} what - 出错文案里对它的称呼
 * @returns {number} 0 或 1
 * @throws {Error} 既不是布尔也不是 0/1 时抛 400
 */
function checkSwitch(v, what) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  throw httpError(400, `${what}只能开或关`);
}

/**
 * 功能：校验并归一化「改时长偏好」的入参 —— ⭐ **带哪个键写哪个键**。
 * @param {*} b - 请求体
 * @returns {Object} 只含请求里真的带了的键
 * @throws {Error} 越界 / 非整数时抛 400；一个键都没带也抛 400
 */
function checkPomodoroPrefs(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  if (has('focus_min')) out.focus_min = checkIntIn(src.focus_min, FOCUS_MIN, FOCUS_MAX, '专注时长（分钟）');
  if (has('break_min')) out.break_min = checkIntIn(src.break_min, BREAK_MIN, BREAK_MAX, '短休时长（分钟）');
  if (has('long_break_min')) {
    out.long_break_min = checkIntIn(src.long_break_min, LONG_BREAK_MIN, LONG_BREAK_MAX, '长休时长（分钟）');
  }
  if (has('rounds_before_long')) {
    out.rounds_before_long = checkIntIn(src.rounds_before_long, ROUNDS_MIN, ROUNDS_MAX, '长休前的轮次');
  }
  // ⭐ 0.8.32：到点提示音开关（0/1）—— 落库的理由是「两端同一个账号该是同一个设置」
  if (has('sound_on')) out.sound_on = checkSwitch(src.sound_on, '提示音');
  if (!Object.keys(out).length) throw httpError(400, '没有要改的设置');
  return out;
}

/**
 * 功能：校验并归一化「开一次休息」的入参 —— ⭐ 0.8.32 新增。
 *
 * 说明：⚠️ **只收 `kind`，不收分钟数**：那两档时长住偏好里（界面上那两个输入框与它是同一份），
 *      让前端再传一遍就是第二份真相。判定与写库在 `store.pomodoroBreak()` 里。
 *
 * @param {*} b - 请求体
 * @returns {string} `'short_break'` 或 `'long_break'`
 * @throws {Error} 取值非法时抛 400
 */
function checkPomodoroBreak(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (src.kind !== 'short_break' && src.kind !== 'long_break') {
    throw httpError(400, '休息只能是短休（short_break）或长休（long_break）');
  }
  return src.kind;
}

/**
 * 功能：校验并归一化「结束一个番茄」的入参 —— `completed`（完成，默认）或 `abandoned`（放弃）。
 * @param {*} b - 请求体
 * @returns {string} 终态
 * @throws {Error} 状态取值非法时抛 400
 */
function checkPomodoroFinish(b) {
  const src = b && typeof b === 'object' ? b : {};
  const s = src.status === undefined || src.status === null || src.status === '' ? 'completed' : src.status;
  if (s !== 'completed' && s !== 'abandoned') throw httpError(400, '结束状态只能是 completed 或 abandoned');
  return s;
}

/**
 * 功能：处理 `/api/pomodoro` 及其子路径 —— 番茄钟的状态与动作。
 *
 * 说明：路由表（`parts = ['api','pomodoro', …]`）——
 *      · `GET    /api/pomodoro`              状态 + 偏好 + 今日/本周统计（⭐ 搭车给 `nowMs`）
 *      · `POST   /api/pomodoro/start`        开始 `{ minutes, task_id?, task_source? }`
 *      · `POST   /api/pomodoro/break`        开一次休息 `{ kind: 'short_break'|'long_break' }`（⭐ 0.8.32）
 *      · `PUT    /api/pomodoro/prefs`        改时长偏好（逐键）
 *      · `GET    /api/pomodoro/stats?range=` 单独取统计（`today` 默认 / `week`）
 *      · `POST   /api/pomodoro/:id/pause`    暂停
 *      · `POST   /api/pomodoro/:id/resume`   继续
 *      · `POST   /api/pomodoro/:id/finish`   结束 `{ status? }`
 *
 * ⚠️ `:id` 这一段**没有** GET / PUT / DELETE（没有"取单条"这种形状）——
 *     所以 `/api/pomodoro/5` 这类三段的请求一律 404，而不是被当成某个动作的名字。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {Object} ctx.url - 解析好的 URL 对象（取查询参数）
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handlePomodoro({ req, res, parts, url, method, uid }) {
  // ⭐ 整个请求共用同一个「现在」（见文件头说明）
  const nowMs = Date.now();

  // ---- 状态聚合：`GET /api/pomodoro` ----
  if (parts.length === 2) {
    if (method === 'GET') return json(res, 200, store.pomodoroState(uid, nowMs));
    return notFound(res);
  }

  // ---- 三段：子资源（start / prefs / stats）----
  if (parts.length === 3) {
    if (parts[2] === 'start') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.pomodoroStart(uid, nowMs, checkPomodoroStart(b)));
      });
    }
    if (parts[2] === 'prefs') {
      if (method !== 'PUT') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = store.pomodoroSavePrefs(uid, checkPomodoroPrefs(b), nowMs);
        return json(res, 200, { ok: true, prefs: next });
      });
    }
    // ⭐ 0.8.32：开一次休息（短休 / 长休）—— 时长由服务端从偏好里取，⛔ 不收前端传的分钟数
    if (parts[2] === 'break') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.pomodoroBreak(uid, nowMs, checkPomodoroBreak(b)));
      });
    }
    if (parts[2] === 'stats') {
      if (method !== 'GET') return notFound(res);
      // ⚠️ `range` **不做校验式拦截**：不认识的值当「今天」（与灵感库列表同一口径 ——
      //    筛选参数打回 400 只会让用户对着一个报错页，而不是"没筛出来"）
      const p = (url && url.searchParams) || null;
      return json(res, 200, store.pomodoroStats(uid, p ? p.get('range') || '' : '', nowMs));
    }
    return notFound(res);
  }

  // ---- 四段：单条上的动作 `/api/pomodoro/:id/<动作>` ----
  if (parts.length === 4) {
    if (method !== 'POST') return notFound(res);
    const id = idParam(parts[2]);
    // ⚠️ `idParam` 对 `'start'` 这类非数字段回 **null**（正是我们要的），但对 `null` 入参回 **0**
    //    ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`（那样合法的 id=0 会被误判）。
    if (id === null) return notFound(res);
    if (parts[3] === 'pause') return json(res, 200, store.pomodoroPause(uid, id, nowMs));
    if (parts[3] === 'resume') return json(res, 200, store.pomodoroResume(uid, id, nowMs));
    if (parts[3] === 'finish') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.pomodoroFinish(uid, id, nowMs, checkPomodoroFinish(b)));
      });
    }
    // ⭐⭐ 0.7.6 修（「点了报错」）：**这条分支原来根本不存在** ——
    //    前端 `pomoAction('abandon')` 打的是 `/api/pomodoro/:id/abandon`，落到下面 `notFound(res)` ⇒ **404**。
    //    路由清单（本文件 153~156 行的注释）里也只写了 pause / resume / finish —— 落实现的时候就漏了这一个。
    //    ⚠️ 语义固定是「放弃」，所以请求体可有可无（前端会带 `{ status: 'abandoned' }`，
    //    这里用 `readBody` 把它消费掉再固定按 `abandoned` 结算，⛔ 不去校验体）。
    //    ⚠️⭐ 0.8.5 修（「点放弃报错」）：传给 `pomodoroFinish()` 的第四个参数必须是
    //    **字符串** `'abandoned'`，⛔ 不是 `{status:'abandoned'}` 那个对象 —— 第四个形参就是
    //    `status` 本身，它会被原样透传给 sqlite 的 `?` 占位符；**绑定一个对象**时
    //    node:sqlite 会把它当成「命名参数集合」去要 `status` ⇒ 抛
    //    `Unknown named parameter 'status'`（JSON 后端则静默把对象存进那一列，
    //    所以两后端跑同一批用例也不一定抓得到 —— 见 `pomodoro.test.js` 的那条）。
    if (parts[3] === 'abandon') {
      return readBody(req, res, () =>
        json(res, 200, store.pomodoroFinish(uid, id, nowMs, 'abandoned')),
      );
    }
    return notFound(res);
  }

  return notFound(res);
}

module.exports = { pomodoro: handlePomodoro };
