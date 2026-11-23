'use strict';
/**
 * modules/pomodoro/routes.js —— 番茄钟路由（一个屏所需的全部 + 计时状态机）
 * 功能：`handlePomodoro` 一处收全部番茄钟接口 —— 状态聚合（含 `nowMs` 搭车）、开始、
 * 暂停 / 继续 / 结束、改时长偏好、单独取统计。
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md
 */

const { httpError, idParam, json, notFound, readBody } = require('../../../core/http-util.js');
const { store } = require('../../../core/context.js');

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
 */
const TASK_SOURCES = ['daily', 'project'];

/**
 * 功能：校验一个「必须是整数且在区间内」的时长参数。
 * @param {*} v - 入参值
 * @param {number} lo - 下限（含）
 * @param {number} hi - 上限（含）
 * @param {string} what - 出错文案里对它的称呼
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
 * （那是"下次默认选多久"）。界面上三档预设与自定义值都从这里进来。
 * **绑任务必须成套给**：`task_id` 与 `task_source` 要么都不给（= 不绑），
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
 *
 * 说明：⚠️ 与 `checkIntIn` **分开**是刻意的：那个函数把「不是数字」与「越界」混在一句话里，
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
  // 到点提示音开关（0/1）—— 落库的理由是「两端同一个账号该是同一个设置」
  if (has('sound_on')) out.sound_on = checkSwitch(src.sound_on, '提示音');
  if (!Object.keys(out).length) throw httpError(400, '没有要改的设置');
  return out;
}

/**
 *
 * 说明：⚠️ **只收 `kind`，不收分钟数**：那两档时长住偏好里（界面上那两个输入框与它是同一份），
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
 * `GET    /api/pomodoro`              状态 + 偏好 + 今日/本周统计（⭐ 搭车给 `nowMs`）
 * `POST   /api/pomodoro/start`        开始 `{ minutes, task_id?, task_source? }`
 */
function handlePomodoro({ req, res, parts, url, method, uid }) {
  // 整个请求共用同一个「现在」（见文件头说明）
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
    // 开一次休息（短休 / 长休）—— 时长由服务端从偏好里取，⛔ 不收前端传的分钟数
    if (parts[2] === 'break') {
      if (method !== 'POST') return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.pomodoroBreak(uid, nowMs, checkPomodoroBreak(b)));
      });
    }
    if (parts[2] === 'stats') {
      if (method !== 'GET') return notFound(res);
      // `range` **不做校验式拦截**：不认识的值当「今天」（与灵感库列表同一口径 ——
      const p = (url && url.searchParams) || null;
      return json(res, 200, store.pomodoroStats(uid, p ? p.get('range') || '' : '', nowMs));
    }
    return notFound(res);
  }

  // ---- 四段：单条上的动作 `/api/pomodoro/:id/<动作>` ----
  if (parts.length === 4) {
    if (method !== 'POST') return notFound(res);
    const id = idParam(parts[2]);
    // ⇒ 判「解析失败」必须写 `=== null`，⛔ 不能写成 `if (!id)`（那样合法的 id=0 会被误判）。
    if (id === null) return notFound(res);
    if (parts[3] === 'pause') return json(res, 200, store.pomodoroPause(uid, id, nowMs));
    if (parts[3] === 'resume') return json(res, 200, store.pomodoroResume(uid, id, nowMs));
    if (parts[3] === 'finish') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 200, store.pomodoroFinish(uid, id, nowMs, checkPomodoroFinish(b)));
      });
    }
    // 修（「点了报错」）：**这条分支原来根本不存在** ——
    // 前端 `pomoAction('abandon')` 打的是 `/api/pomodoro/:id/abandon`，落到下面 `notFound(res)` ⇒ **404**。
    // 路由清单（本文件 153~156 行的注释）里也只写了 pause / resume / finish —— 落实现的时候就漏了这一个。
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
