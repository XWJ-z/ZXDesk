/**
 * validate.js —— 项目 / 任务 / 课表的统一入参校验与归一化
 *
 * 功能：`checkProject` / `checkProjectTask` / `checkDailyTask` 三个入口共用 `checkTaskInput`，
 *      以及课表那套 `checkTerm` / `checkBlocks` / `checkPeriods` / `checkSession` /
 *      `checkCourse` / `checkCommit`、收藏夹的 `checkBookmark` / `checkTag`、
 *      NAS硬件管理的 `checkHardware`、个人资产管理的 `checkAssetGroup` / `checkAssetGroupMerge` /
 *      `checkAssetItem`
 *      与密码库的 `checkMasterPassword` / `checkVaultItem` /
 *      `checkVaultGenerator` / `checkVaultLockMinutes` / `checkVaultTagRename` / `checkVaultTagRemove`
 *      / `checkVaultTagCreate`；
 *      对话的 `checkTeamworkMessage` / `checkFriendRequest` /
 *      `checkFriendRemark`；
 *      超长一律 **400 且不静默截断**，必填传空串也是 400。
 *
 * ⚠️ **只校验请求里真的带了的字段**：这三个接口都支持局部更新（拖拽排序只发 `sort_order`、
 *    勾选完成只发 `status`、就地改标题只发 `title`），拿「必填」去卡局部更新会把正常操作打成 400。
 * ⚠️ **未知键原样透传**：真正的落库白名单只有 `store/schema/*` 的 `allowedCols`，
 *    这里再列一份迟早会与它漂移并静默丢掉新字段。
 * ⚠️ **日期只保证「真实存在」，不保证「合理」**：`2026-13-99` / `2026-02-30` 挡得住，
 *    但不校验范围（`1900-01-01` 照样收下）——「合不合理」属于业务语义，本应用不做猜测。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.61
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const ti = require('./timetable-import.js');
const { badDateRange, httpError, idParam } = require('./http-util.js');
const { store } = require('./context.js');

// ---- 项目 / 任务的入参校验（0.1.3，审查报告 C2）----
/**
 * 硬上限（与课表那套 `checkTerm` / `checkBlocks` 同一口径：**长度、范围、格式都有上限**）。
 * 取值不是拍的：标题/名称 100 字远超真实使用（真实标题十几个字），长文本 2 万字给足了备注空间，
 * 但要防的是「拿接口当免费存储」这类输入。
 */
const MAX_NAME = 100;

/**
 * 「这条灵感已变成的任务」的来源 —— 只能是这两张表之一（灵感库，0.7.1）。
 * ⚠️ 日常任务与项目任务是**两张表**，id 各自从 1 开始 ⇒ 只记 id 认不出是哪一张
 *    。
 */
const IDEA_TASK_SOURCES = ['daily', 'project'];

const MAX_LONG_TEXT = 20000;

const MAX_SHORT_TEXT = 50;

const MAX_STATUS = 20;

const MAX_STAMP = 30;

/**
 * 课表备注的长度上限 —— 课程备注 / 课次备注（`time_timetable_sessions.remark`，0.7.1 起界面不再写）/
 * 本节备注（`time_timetable_day_notes.note`）共用它。上限的意义是「别拿接口当免费存储」，
 * 500 字足够写下考试安排、要带的东西与一次作业；超长**报 400 而不是静默截断**。
 */
const MAX_TT_REMARK = 500;

/**
 * 一学期的周次上限（1..60）—— 与 `timetable/date-util.js` 的 `normalizeWeeks` 同口径，
 * 也扫住了「Excel 把周次转成日期」那种离谱值。调课的周次 / 起始周次都用它。
 */
const MAX_WEEKS = 60;

/** [字段, 中文名, 上限, 带了就不能为空]。⚠️ `description` / `content` 这类**必须允许显式清空**（传空串） */
const PROJECT_TEXT = [
  ['name', '项目名称', MAX_NAME, true],
  ['description', '项目描述', MAX_LONG_TEXT, false],
  ['color', '项目颜色', MAX_SHORT_TEXT, false],
  ['icon', '项目图标', MAX_SHORT_TEXT, false],
  ['status', '项目状态', MAX_STATUS, false],
];

const TASK_TEXT = [
  ['title', '任务标题', MAX_NAME, true],
  ['description', '任务描述', MAX_LONG_TEXT, false],
  ['assignee', '负责人', MAX_SHORT_TEXT, false],
  ['tag', '标签', MAX_SHORT_TEXT, false],
  ['status', '任务状态', MAX_STATUS, false],
  ['completed_at', '完成时间', MAX_STAMP, false],
];

const DAILY_TEXT = [
  ['title', '任务标题', MAX_NAME, true],
  ['content', '任务内容', MAX_LONG_TEXT, false],
  ['status', '任务状态', MAX_STATUS, false],
  ['completed_at', '完成时间', MAX_STAMP, false],
];

const FLAG_LABEL = { important: '重要', urgent: '紧急' };

/**
 * 任务的三种类型（0.8.14）：普通 / 窗口 / 周期。
 * ⚠️ 它是**加在现有「日常任务 / 项目任务」之上的新维度** —— 两种归属都能选三种类型。
 */
const TASK_KINDS = ['plain', 'window', 'cycle'];

/** 周期规则的三种频率（方案 §1.3.1）@type {Array.<string>} */
const RECUR_FREQS = ['daily', 'weekly', 'monthly'];

/**
 * 每种频率下 `slots` 的坐标上限：weekly 用 `1..7`（1 = 周一，与 `core/dashboard.js` 的
 * `weekdayNo()` 同一套）；monthly 用 `1..31`；daily 不吃 `slots`。
 */
const RECUR_MAX = { weekly: 7, monthly: 31 };

/**
 * 功能：判断对象自身（不含原型链）是否真的带了某个键 —— 用它区分「没传这个字段」与「传了 null」。
 * @param {Object} o - 待检查的对象
 * @param {string} k - 键名
 * @returns {boolean} 自身含有该键返回 true
 */
function hasKey(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * 功能：判断一个字符串是不是 `YYYY-MM-DD` 形状**且这一天真实存在**的日期。
 *
 * 说明：`YYYY-MM-DD` 且**这一天真实存在**。
 *
 * ⚠️ 只测 `DATE_RE` 是不够的：那是形状检查，`2026-13-99` 也符合 `\d{4}-\d{2}-\d{2}`，
 *    会被照单收下并落库（课表那边的 `checkTerm` 早就用 `ti.dateOrdinal` 挡了真实日期，
 *    任务这边 0.1.2 之前只有 `badDateRange` 比大小 —— 于是同一个日期串在两类接口上表现不同）。
 * ⚠️ `ti.dateOrdinal` 自身只挡「月 > 12 / 日 > 31」，`2026-02-30` 会被 `Date.UTC` 顺延成 3 月 2 日而**不报错**，
 *    所以这里再做一次**回读比对**（构造出来的年月日必须与输入逐字一致），把 2/30、4/31、非闰年 2/29 一并挡住。
 *
 * @param {string} s - 待校验的日期字符串
 * @returns {boolean} 形状正确且真实存在返回 true
 */
function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  if (ti.dateOrdinal(s) === null) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 功能：校验并归一化一条周期规则（`recur_rule`），返回**规范化 JSON 字符串**；没有规则时回 `null`。
 *
 * 说明：⭐ 形状——
 *      `{freq:'daily'}` · `{freq:'weekly',slots:[[1,1],[3,3],[5,5]]}` ·
 *      `{freq:'monthly',slots:[[1,9]]}`。每个 slot 是一期（闭区间 `[起, 止]`）。
 *      ⭐⭐ **不存「次数」这个字段** —— 次数 ≡ `slots.length`，存两份必然漂移。
 *      ⚠️ `daily` **不吃 `slots`**（每一期就是当天）⇒ 归一成 `{"freq":"daily"}`，
 *      多塞进来的 `slots` 一律**丢弃**（它不是「截断」，是没有意义的键）。
 *      ⚠️ 归一成按「起」升序（服务端存的就是规范形，读出来即可直接画，两端不必各排一次）。
 *      ⚠️ 非法输入一律 **400 且不静默截断**（与日期 / 超长的口径一致）。
 *
 * @param {*} raw - 请求里带的 `recur_rule`：对象、JSON 字符串，或空
 * @returns {?string} 规范化的 JSON 字符串；无规则时为 null
 * @throws {Error} 格式 / 频率 / 期段 / 重叠 任一不合法时抛 400
 */
function checkRecurRule(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      throw httpError(400, '循环规则的格式不正确');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw httpError(400, '循环规则的格式不正确');
  const freq = String(obj.freq == null ? '' : obj.freq).trim();
  if (!RECUR_FREQS.includes(freq)) throw httpError(400, '循环规则只能是「每天 / 每周 / 每月」');
  if (freq === 'daily') return JSON.stringify({ freq: 'daily' });
  const src = obj.slots;
  if (!Array.isArray(src) || src.length === 0) throw httpError(400, '选了每周 / 每月就至少要设一个期');
  const max = RECUR_MAX[freq];
  const slots = src.map((s) => {
    if (!Array.isArray(s) || s.length !== 2) throw httpError(400, '每个期要写成「起, 止」两个数');
    const a = Number(s[0]);
    const b = Number(s[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw httpError(400, '期的起止必须是整数');
    if (a < 1 || a > max || b < 1 || b > max) {
      throw httpError(400, freq === 'weekly' ? '每周的期只能落在周一到周日' : '每月的期只能落在 1 到 31 号');
    }
    if (a > b) throw httpError(400, '期的起始不能晚于结束');
    return [a, b];
  });
  slots.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i][0] <= slots[i - 1][1]) throw httpError(400, '周期规则里的几个期不能重叠');
  }
  return JSON.stringify({ freq, slots });
}

/**
 * 功能：项目 / 项目任务 / 日常任务的统一入参校验与归一化 —— 逐字段校验长度与格式，通过后返回可直接落库的新对象。
 *
 * 说明：为什么要有（以前这些接口**只**校验日期区间 `badDateRange`，其余全靠数据库的 NOT NULL 兜底）：
 *   ① 超长文本照单全收（接口成了免费存储）；② 非法日期（`2026-13-99`）能进库；
 *   ③ `important: 2` 会被表上的 `CHECK (important IN (0,1))` 拦成 **500**，前端只看到「请求失败」，
 *      而不是一句能读懂的原因；④ **JSON 回退后端没有任何约束**，同样的输入在两种后端下表现不同。
 *
 * ⚠️ **只校验请求里真的带了的字段**：这三个接口都支持局部更新 —— 拖拽排序只发 `{sort_order}`、
 *    勾选完成只发 `{status}`、就地改标题只发 `{title}`、撤销删除只发 `{completed_at}` ——
 *    拿「必填」去卡局部更新，会把正常操作打成 400（课表那边就踩过这个坑，见 `modules/timetable/routes.js` 的 PUT）。
 *    没带的字段一律交给数据层的默认值，**行为与 0.1.2 完全一致**。
 * ⚠️ **未知键原样透传**：真正的落库白名单只有一个地方（schema 模块的 `allowedCols`）。
 *    这里再列一份「允许的键」迟早会与它漂移，并静默丢掉新加的字段。
 * ⚠️ 这里只做**校验**（throw 400），不做鉴权、不碰归属 —— 归属仍由存储层的 `uid` 过滤负责。
 *
 * @param {Object} b - 请求体对象
 * @param {Array.<Array>} textSpec - 文本字段规格表，每项为 `[字段名, 中文名, 长度上限, 带了就不能为空]`
 * @param {boolean} withDates - 是否校验 `start_date` / `due_date` 两个日期字段
 * @returns {Object} 归一化后的字段对象，可直接交给存储层
 * @throws {Error} 任一字段不合法时抛出 400（由 `fail()` 收口成响应）
 */
function checkTaskInput(b, textSpec, withDates) {
  const src = b && typeof b === 'object' ? b : {};
  const out = Object.assign({}, src);

  for (const [key, label, max, required] of textSpec) {
    if (!hasKey(src, key) || src[key] === undefined || src[key] === null) continue;
    if (typeof src[key] !== 'string') throw httpError(400, `${label}必须是文本`);
    const v = src[key].trim();
    if (!v) {
      if (required) throw httpError(400, `${label}不能为空`);
      out[key] = ''; // 允许「清空备注/描述」这类正常操作
      continue;
    }
    if (v.length > max) throw httpError(400, `${label}过长（最多 ${max} 字）`);
    out[key] = v;
  }

  // 重要/紧急：归一化成 0/1（表上有 CHECK，传 2 或不认识的字符串会变成 500，这里给一句人话）
  for (const [key, label] of Object.entries(FLAG_LABEL)) {
    if (!hasKey(src, key) || src[key] === undefined || src[key] === null) continue;
    const n = src[key] === true ? 1 : src[key] === false ? 0 : Number(src[key]);
    if (n !== 0 && n !== 1) throw httpError(400, `${label}标记只能是 0 或 1`);
    out[key] = n;
  }

  if (hasKey(src, 'sort_order') && src.sort_order !== undefined && src.sort_order !== null) {
    const n = Number(src.sort_order);
    if (!Number.isFinite(n)) throw httpError(400, '排序值必须是数字');
    out.sort_order = Math.trunc(n);
  }

  // ⭐ 0.4.4：这条任务「从对话里哪条消息建的」（对话页那枚「已添加到任务」标记的唯一依据）。
  //    ⚠️ 只校验格式（正整数），**不在这里查那条消息存不存在**：即使客户端传了个乱值，
  //    后果也只是「我自己某条任务上挂了一个永远显示不出来的来源」—— 标记只按我自己的任务查、
  //    且只在**我参与的那几个会话**的消息下面渲染，别人看不到、也无从利用。
  if (hasKey(src, 'from_message_id') && src.from_message_id !== undefined && src.from_message_id !== null) {
    const n = Number(src.from_message_id);
    if (!Number.isInteger(n) || n <= 0) throw httpError(400, '来源消息的编号不合法');
    out.from_message_id = n;
  }

  // ⭐ 0.5.2 跨模块：这条任务绑的网址（`0` / 空 = 不绑）—— 「任务可绑定网址」。
  //    ⚠️ 同样只校验格式、**不查那条书签存不存在**：存不存在由读取时的 `attachBookmarkLinks()`
  //    决定（取不到就是 null，界面上表现为「没有绑网址」），写的时候查一次只会让「先删书签、
  //    再改任务」这条路径变成 400 —— 而那恰恰是最常见的顺序。
  if (hasKey(src, 'bookmark_id') && src.bookmark_id !== undefined && src.bookmark_id !== null) {
    const n = Number(src.bookmark_id);
    if (!Number.isInteger(n) || n < 0) throw httpError(400, '绑定的网址编号不合法');
    out.bookmark_id = n;
  }

  if (withDates) {
    for (const [key, label] of [
      ['start_date', '任务日'],
      ['due_date', '截止日期'],
    ]) {
      if (!hasKey(src, key) || src[key] === undefined || src[key] === null) continue;
      const v = String(src[key]).trim();
      if (v && !isRealDate(v)) throw httpError(400, `${label}不是一个真实存在的日期（应为 YYYY-MM-DD）`);
      out[key] = v;
    }
    // ⚠️ 只比请求里同时出现的两个日期（与 0.1.2 语义一致）：局部改一个日期时不拿库里的另一个去卡，
    //    否则「只改截止日期」的 PUT 会突然变成「必须把任务日一起发上来」。
    const d = badDateRange(out);
    if (d) throw httpError(400, d);
  }

  // ⭐⭐ 0.8.14：任务类型这一维度 —— 类型 / 两个时刻 / 周期规则。
  //    ⚠️ 与日期一样**只在请求真带了该字段时**校验（「只改类型」「只改时刻」都是正常操作）。
  //    ⚠️ 判据挂在 `withDates` 上：它正是「这是一条任务、不是项目」的那个开关 ——
  //      项目入参走的是 `checkProject`（`withDates=false`），这三样在项目上没有意义。
  //    ⚠️⭐ 时刻（`HH:MM`）**只进这两列**，⛔ 绝不并进 `start_date` / `due_date`
  //      —— 服务端两处按字符串字典序比日期，合并会让「今天到期」被判成「还没到」而静默漏掉。
  if (withDates) {
    if (hasKey(src, 'task_kind') && src.task_kind !== undefined && src.task_kind !== null) {
      const k = String(src.task_kind).trim();
      if (!k) out.task_kind = 'plain';
      else if (!TASK_KINDS.includes(k)) throw httpError(400, '任务类型只能是普通 / 窗口 / 周期');
      else out.task_kind = k;
    }
    for (const [key, label] of [
      ['start_time', '开始时刻'],
      ['due_time', '截止时刻'],
    ]) {
      if (!hasKey(src, key) || src[key] === undefined || src[key] === null) continue;
      const v = String(src[key]).trim();
      if (v && !HHMM.test(v)) throw httpError(400, `${label}不是一个真实存在的时刻（应为 HH:MM）`);
      out[key] = v;
    }
    if (hasKey(src, 'recur_rule')) out.recur_rule = checkRecurRule(src.recur_rule);
  }
  return out;
}

/**
 * 功能：项目入参校验 —— 套用 `PROJECT_TEXT` 字段表，不校验日期。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的项目字段
 * @throws {Error} 字段不合法时抛出 400
 */
function checkProject(b) {
  return checkTaskInput(b, PROJECT_TEXT, false);
}

/**
 * 功能：项目任务入参校验 —— 套用 `TASK_TEXT` 字段表，并校验两个日期字段。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的任务字段
 * @throws {Error} 字段不合法时抛出 400
 */
function checkProjectTask(b) {
  return checkTaskInput(b, TASK_TEXT, true);
}

/**
 * 功能：日常任务入参校验 —— 套用 `DAILY_TEXT` 字段表，并校验两个日期字段。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的任务字段
 * @throws {Error} 字段不合法时抛出 400
 */
function checkDailyTask(b) {
  return checkTaskInput(b, DAILY_TEXT, true);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_BLOCKS = 20;

const MAX_PERIODS = 200;

const MAX_COURSES = 200;

const MAX_SESSIONS = 2000;

/**
 * 功能：校验并归一化学期入参 —— 学期名长度、开学日期格式、总周数范围，未给名称时补「未命名学期」。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的学期字段（`name` / `start_monday` / `total_weeks` / `remark` / `meta`）
 * @throws {Error} 字段不合法时抛出 400
 */
function checkTerm(b) {
  const src = b || {};
  const name = String(src.name === undefined || src.name === null ? '' : src.name).trim();
  if (name.length > 100) throw httpError(400, '学期名过长（最多 100 字）');
  const sm = String(src.start_monday || '').trim();
  if (sm && (!DATE_RE.test(sm) || ti.dateOrdinal(sm) === null))
    throw httpError(400, '开学日期格式不对（应为 YYYY-MM-DD）');
  const tw = src.total_weeks === undefined || src.total_weeks === '' ? 17 : Number(src.total_weeks);
  if (!Number.isFinite(tw) || tw < 1 || tw > 60) throw httpError(400, '总周数应在 1 到 60 之间');
  // ⭐ 假前一天下午提前（0.2.3）：0 = 不启用；上限与 holiday-util 的 MAX_ADVANCE_MINUTES 同一口径
  const adv =
    src.holiday_advance_minutes === undefined || src.holiday_advance_minutes === ''
      ? 0
      : Number(src.holiday_advance_minutes);
  if (!Number.isFinite(adv) || adv < 0 || adv > 180)
    throw httpError(400, '「节假日前一天下午提前」应在 0 到 180 分钟之间（0 = 不启用）');
  const pmFrom = String(src.holiday_pm_from || '').trim();
  if (pmFrom && !HHMM.test(pmFrom)) throw httpError(400, '「下午从几点算起」格式不对（应为 HH:MM）');
  return {
    name: name || '未命名学期',
    start_monday: sm || null,
    total_weeks: Math.floor(tw),
    remark: String(src.remark || '').slice(0, 2000),
    meta: String(src.meta || '').slice(0, 2000),
    holiday_advance_minutes: Math.floor(adv),
    holiday_pm_from: pmFrom,
  };
}

/**
 * 功能：校验并归一化「时段块」数组 —— 逐个检查时间格式、节数、每节时长与课间，并限制块的数量上限。
 * @param {Array.<Object>} list - 请求里的时段块数组（非数组时按空数组处理）
 * @returns {Array.<Object>} 归一化后的时段块数组
 * @throws {Error} 任一时段块不合法时抛出 400
 */
function checkBlocks(list) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_BLOCKS) throw httpError(400, `时段块过多（最多 ${MAX_BLOCKS} 个）`);
  return arr.map((b, i) => {
    const src = b || {};
    const st = String(src.start_time || '').trim();
    const et = String(src.end_time || '').trim();
    if (st && !HHMM.test(st)) throw httpError(400, `第 ${i + 1} 个时段块的开始时间格式不对（应为 HH:MM）`);
    if (et && !HHMM.test(et)) throw httpError(400, `第 ${i + 1} 个时段块的结束时间格式不对（应为 HH:MM）`);
    if (st && et && et <= st) throw httpError(400, `第 ${i + 1} 个时段块的结束时间必须晚于开始时间`);
    const pc = src.period_count === undefined || src.period_count === '' ? 0 : Number(src.period_count);
    if (!Number.isFinite(pc) || pc < 0 || pc > 30) throw httpError(400, `第 ${i + 1} 个时段块的节数应在 0 到 30 之间`);
    const cm = src.class_minutes === undefined || src.class_minutes === '' ? 45 : Number(src.class_minutes);
    if (!Number.isFinite(cm) || cm < 1 || cm > 180)
      throw httpError(400, `第 ${i + 1} 个时段块的每节时长应在 1 到 180 分钟之间`);
    const bm = src.break_minutes === undefined || src.break_minutes === '' ? 5 : Number(src.break_minutes);
    if (!Number.isFinite(bm) || bm < 0 || bm > 120)
      throw httpError(400, `第 ${i + 1} 个时段块的课间应在 0 到 120 分钟之间`);
    return {
      label: String(src.label || '').slice(0, 20) || `时段${i + 1}`,
      sort_order: Number.isFinite(Number(src.sort_order)) ? Number(src.sort_order) : i,
      start_time: st,
      end_time: et,
      period_count: Math.floor(pc),
      class_minutes: Math.floor(cm),
      break_minutes: Math.floor(bm),
    };
  });
}

/**
 * 功能：校验并归一化「逐节时间」数组 —— 逐条检查节次号与起止时间格式，并把 `block_index` / `block_id`
 *      两种写法统一成 `block_index` + `block_id` 两个字段。
 * @param {Array.<Object>} list - 请求里的逐节时间数组（非数组时按空数组处理）
 * @param {Array.<Object>} blocks - 已存在的时段块数组；为空表示块尚未落库（此时保留 `block_index`）
 * @returns {Array.<Object>} 归一化后的逐节时间数组
 * @throws {Error} 任一逐节时间不合法时抛出 400
 */
function checkPeriods(list, blocks) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_PERIODS) throw httpError(400, `逐节时间过多（最多 ${MAX_PERIODS} 条）`);
  return arr.map((p, i) => {
    const src = p || {};
    const idx = Number(src.index_no);
    if (!Number.isFinite(idx) || idx < 1 || idx > MAX_PERIODS)
      throw httpError(400, `第 ${i + 1} 条逐节时间的节次号非法`);
    const st = String(src.start_time || '').trim();
    const et = String(src.end_time || '').trim();
    if (st && !HHMM.test(st)) throw httpError(400, `第 ${idx} 节的开始时间格式不对`);
    if (et && !HHMM.test(et)) throw httpError(400, `第 ${idx} 节的结束时间格式不对`);
    // ⚠️ 0.2.3 起逐节时间可以由界面直接改（作息设置的第二块），所以补上「结束必须晚于开始」——
    //    与 checkBlocks 同一口径；导入路径的 periods 由 generatePeriods 生成，本来就是合法的。
    if (st && et && et <= st) throw httpError(400, `第 ${idx} 节的结束时间必须晚于开始时间`);
    // `block_index` 与 `block_id` 两种写法都收：
    //   · `PUT /terms/:id/periods` 时块已存在（有 id）→ 两个都能解析成 block_id；
    //   · `import/commit` 时块**还没插**（没有 id）→ 保留 `block_index`，由 commitTimetable 落库后再换。
    let bidx = null;
    let bid = null;
    if (src.block_index !== undefined && src.block_index !== null && src.block_index !== '') {
      bidx = Number(src.block_index);
      if (!Number.isFinite(bidx) || bidx < 0) throw httpError(400, `第 ${idx} 节关联的时段块非法`);
      if (blocks.length && bidx >= blocks.length) throw httpError(400, `第 ${idx} 节关联的时段块不存在`);
      if (blocks.length && blocks[bidx]) bid = blocks[bidx].id === undefined ? null : blocks[bidx].id;
    } else if (src.block_id !== undefined && src.block_id !== null && src.block_id !== '') {
      bid = Number(src.block_id);
      if (!Number.isFinite(bid)) throw httpError(400, `第 ${idx} 节关联的时段块非法`);
    }
    return { index_no: Math.floor(idx), block_index: bidx, block_id: bid, start_time: st, end_time: et };
  });
}

/**
 * 功能：校验并归一化一条课次 —— 星期、起止节次、周次文本、教室与教师，周次一律由服务端重新规范化。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的课次字段（`weekday` / `period_start` / `period_end` / `weeks` / `room` / `teacher`）
 * @throws {Error} 字段不合法或周次无法识别时抛出 400
 */
function checkSession(b) {
  const src = b || {};
  const wd = Number(src.weekday);
  if (!Number.isFinite(wd) || wd < 1 || wd > 7) throw httpError(400, '星期应在 1（周一）到 7（周日）之间');
  const ps = Number(src.period_start);
  const pe = src.period_end === undefined || src.period_end === '' ? ps : Number(src.period_end);
  if (!Number.isFinite(ps) || ps < 1 || ps > MAX_PERIODS) throw httpError(400, '起节非法');
  if (!Number.isFinite(pe) || pe < 1 || pe > MAX_PERIODS) throw httpError(400, '止节非法');
  if (pe < ps) throw httpError(400, '止节不能早于起节');
  // ⚠️ 周次**服务端重新规范化**，绝不信任前端回传的文本
  const norm = ti.normalizeWeeks(src.weeks);
  if (!norm.ok) throw httpError(400, `周次无法识别：${norm.error}`);
  const remark = String(src.remark || '');
  if (remark.length > MAX_TT_REMARK) throw httpError(400, `课次备注过长（最多 ${MAX_TT_REMARK} 字）`);
  return {
    weekday: Math.floor(wd),
    period_start: Math.floor(ps),
    period_end: Math.floor(pe),
    weeks: norm.text,
    room: String(src.room || '').slice(0, 100),
    teacher: String(src.teacher || '').slice(0, 100),
    remark,
  };
}

/**
 * 功能：校验并归一化一门课程的元信息 —— 课程名必填且限长，简称 / 教师限长，颜色只收 `#RRGGBB` 形式。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的课程字段（`name` / `short_name` / `teacher` / `color` / `sort_order`）
 * @throws {Error} 课程名为空或过长时抛出 400
 */
function checkCourse(b) {
  const src = b || {};
  const name = String(src.name || '').trim();
  if (!name) throw httpError(400, '课程名不能为空');
  if (name.length > 100) throw httpError(400, '课程名过长（最多 100 字）');
  const remark = String(src.remark || '');
  if (remark.length > MAX_TT_REMARK) throw httpError(400, `课程备注过长（最多 ${MAX_TT_REMARK} 字）`);
  return {
    name,
    short_name: String(src.short_name || '').slice(0, 20),
    teacher: String(src.teacher || '').slice(0, 100),
    color: /^#[0-9a-fA-F]{6}$/.test(String(src.color || '')) ? String(src.color) : '',
    remark,
    sort_order: Number.isFinite(Number(src.sort_order)) ? Number(src.sort_order) : 0,
  };
}

/**
 * 功能：把「调到哪里」那几个字段（`to_weekday` / `to_period_start` / `to_period_end` / `to_room`）
 *      从请求体里读出来并校验，就地写进 `out`。
 *
 * 说明：⚠️ **只校验请求里真的带了的字段**：这几个字段都是「不传就沿用原值」的，
 *      拿「必填」卡它会把手填课表这种正常用法打成 400。
 *      ⚠️ 校验的只是**字段本身合法**（星期 1-7、节次 1..MAX_PERIODS、止节不早于起节）；
 *      「这个学期有没有这么多节次」「是不是撞了别的课」要查库，在 `store` 那一层判。
 *
 * @param {Object} src - 请求体对象
 * @param {Object} out - 累积结果对象（就地写入）
 * @returns {void}
 * @throws {Error} 字段不合法时抛出 400
 */
function readToFields(src, out) {
  if (hasKey(src, 'to_weekday')) {
    const wd = Number(src.to_weekday);
    if (!Number.isFinite(wd) || wd < 1 || wd > 7) throw httpError(400, '调到星期几应在 1（周一）到 7（周日）之间');
    out.to_weekday = Math.floor(wd);
  }
  if (hasKey(src, 'to_period_start')) {
    const n = Number(src.to_period_start);
    if (!Number.isFinite(n) || n < 1 || n > MAX_PERIODS) throw httpError(400, '调到第几节非法');
    out.to_period_start = Math.floor(n);
  }
  if (hasKey(src, 'to_period_end')) {
    const n = Number(src.to_period_end);
    if (!Number.isFinite(n) || n < 1 || n > MAX_PERIODS) throw httpError(400, '调到第几节结束非法');
    out.to_period_end = Math.floor(n);
  }
  if (out.to_period_start !== undefined && out.to_period_end !== undefined && out.to_period_end < out.to_period_start) {
    throw httpError(400, '结束节次不能早于开始节次');
  }
  if (hasKey(src, 'to_room')) out.to_room = String(src.to_room || '').slice(0, 100);
}

/**
 * 功能：校验「单次调课 / 停课」（`kind` / 周次 / 调到哪 / 说明）。
 *
 * 说明：⭐ 「本节」口径的入参。`kind` 只认 `'move'`（调课）与 `'cancel'`（停课），
 *      其它值一律按 `'move'` 兜 —— 与 `checkSession` 的宽松归一化风格一致，
 *      真正的合法性由枚举列（表上的 `CHECK (kind IN ...)`）兜底。
 *      ⭐ 跨周调课：`to_week_no` = **调到第几周**；不传 / 与 `week_no` 相同 ⇒ 归一成 `null`
 *      （同周换时间，老行为）。⚠️ 停课没有「目标周」—— 停课永远只停源周那一次。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的调整字段
 * @throws {Error} 周次或调课字段不合法时抛出 400
 */
function checkAdjustment(b) {
  const src = b || {};
  const week = Number(src.week_no);
  if (!Number.isFinite(week) || week < 1 || week > MAX_WEEKS) {
    throw httpError(400, `周次应在 1 到 ${MAX_WEEKS} 之间`);
  }
  const note = String(src.note || '');
  if (note.length > MAX_TT_REMARK) throw httpError(400, `调课说明过长（最多 ${MAX_TT_REMARK} 字）`);
  const out = { kind: src.kind === 'cancel' ? 'cancel' : 'move', week_no: Math.floor(week), note };
  if (out.kind !== 'move') return out;
  readToFields(src, out);
  out.to_week_no = null;
  if (hasKey(src, 'to_week_no') && src.to_week_no !== null && src.to_week_no !== '') {
    const tw = Number(src.to_week_no);
    if (!Number.isFinite(tw) || tw < 1 || tw > MAX_WEEKS) {
      throw httpError(400, `调到第几周应在 1 到 ${MAX_WEEKS} 之间`);
    }
    // 与源周相同 ⇒ 按「同周换时间」存（不写目标周），老客户端与老数据只有这一种形态
    if (Math.floor(tw) !== out.week_no) out.to_week_no = Math.floor(tw);
  }
  return out;
}

/**
 * 功能：校验「按天的假期调休 / 停课」（0.6.2）—— `date` 必填且必须是真日期，
 *      `kind='swap'` 时必须给一个**另一天**的 `to_date`。
 *
 * 说明：⭐ 与 `checkAdjustment()`（按课次的单次调课）是两回事：这里管的是
 *      「学校通知某一天整体怎么上」，那边管的是「某一节课被挪走了」。
 *      ⚠️ 刻意**只校验这两条**（日期是真的、补课指向另一天），不查别的：
 *      「这一天在不在学期范围内」不该拦 —— 学期开学日可能后来才改；
 *      「补的那天本来有没有课」也不该拦 —— 用户可能正是要借那一天来补一门别的课。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的字段 `{ date, kind, to_date, note }`
 * @throws {Error} 日期缺失 / 格式不对 / 补课指向自己时抛出 400
 */
function checkDayRule(b) {
  const src = b || {};
  const date = String(src.date || '').trim();
  if (!date) throw httpError(400, '请选择要设置的那一天');
  if (!DATE_RE.test(date) || ti.dateOrdinal(date) === null) {
    throw httpError(400, '日期格式不对（应为 YYYY-MM-DD）');
  }
  const kind = src.kind === 'swap' ? 'swap' : 'off';
  const note = String(src.note || '');
  if (note.length > MAX_TT_REMARK) throw httpError(400, `备注过长（最多 ${MAX_TT_REMARK} 字）`);
  if (kind === 'off') return { date, kind, to_date: null, note };
  const to = String(src.to_date || '').trim();
  if (!to) throw httpError(400, '「补哪一天的课」不能为空');
  if (!DATE_RE.test(to) || ti.dateOrdinal(to) === null) {
    throw httpError(400, '「补哪一天」的日期格式不对（应为 YYYY-MM-DD）');
  }
  if (to === date) throw httpError(400, '「补课」补的是**另一天**的课，不能是它自己');
  return { date, kind, to_date: to, note };
}

/**
 * 功能：校验「某一天那节课的备注」的写入请求（0.7.1， 修订）。
 *
 * 说明：⭐ 与上面的 `checkDayRule` 不是一回事：那条是**按天**的调休规则（身份 = 日期），
 *      这条是**按课次 + 日期**的备注（身份 = `(session_id, date)`）—— 同一节课每天各一条。
 *      ⚠️ `note` **允许为空**（空 = 清掉这一条，不是 400）：那正是「把备注删掉」这个正常动作，
 *      与 `/sessions` 那条"备注可以是空串"同源；**超长仍然 400、不静默截断**。
 *      ⚠️ 本函数是**白名单**（只返回显式列出的键）—— 联动的两个动作开关必须在这里显式放行，
 *      否则前端传了也等于没传（0.7.2 前 `drop_task` 就吃过这个亏：前端一直在传，服务端恒读到
 *      `undefined`，行为恰好蒙对所以一直没暴露）。
 * @param {Object} b - 请求体对象
 * @returns {Object} `{ session_id, date, note, with_task?, drop_task? }`
 * @throws {Error} 课次 id 缺失 / 日期不合法 / 备注超长时抛出 400
 */
function checkDayNote(b) {
  const src = b || {};
  const sid = Number(src.session_id);
  if (!Number.isFinite(sid) || sid <= 0) throw httpError(400, '缺少课次 id');
  const date = String(src.date || '').trim();
  if (!date) throw httpError(400, '缺少日期');
  if (!DATE_RE.test(date) || ti.dateOrdinal(date) === null) {
    throw httpError(400, '日期格式不对（应为 YYYY-MM-DD）');
  }
  const note = String(src.note == null ? '' : src.note).trim();
  if (note.length > MAX_TT_REMARK) throw httpError(400, `本节备注过长（最多 ${MAX_TT_REMARK} 字）`);
  const out = { session_id: sid, date, note };
  // ⭐ 0.7.2：备注与「日常任务」联动时调用方捎带的两个开关（见上面的 JSDoc）——
  //    `with_task`：**没有绑定**时，这次要不要顺手建一条日常任务（前端弹窗问过才传）；
  //    `drop_task`：清空备注时，那条已绑定的任务留不留。
  //    ⚠️ 只在「请求里真带了这个键」时才回填（只校验真带来的字段）——
  //    一律写默认值会盖掉服务端自己的缺省口径（`drop_task !== false ⇒ 删`）。
  if (src.with_task !== undefined) out.with_task = !!src.with_task;
  if (src.drop_task !== undefined) out.drop_task = !!src.drop_task;
  return out;
}

/**
 * 功能：校验「此后全部」改时间 / 停课（`from_week` + 与单次调课同一套「调到哪里」字段）。
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的字段（`from_week` / `kind` / 可选 `to_*`）
 * @throws {Error} 起始周次或调课字段不合法时抛出 400
 */
function checkOnward(b) {
  const src = b || {};
  const from = Number(src.from_week);
  if (!Number.isFinite(from) || from < 1 || from > MAX_WEEKS) {
    throw httpError(400, `「从第几周起」应在 1 到 ${MAX_WEEKS} 之间`);
  }
  const out = { kind: src.kind === 'cancel' ? 'cancel' : 'move', from_week: Math.floor(from) };
  if (out.kind === 'move') readToFields(src, out);
  return out;
}

/**
 * 功能：校验 `import/commit` 的入参 —— 导入方式、目标学期归属、学期 / 时段块 / 逐节时间 / 课程与课次，
 *      全部通过后返回可直接交给 `store.commitTimetable` 的 payload。
 *
 * 说明：⭐ **重新校验是唯一的安全边界** —— 前端可能被改、可能带脏数据回来。
 *
 * @param {number} uid - 当前账号 id，用于校验目标学期是否属于本人
 * @param {Object} b - 请求体对象
 * @returns {{ mode: string, payload: Object }} 导入方式与可直接落库的 payload
 * @throws {Error} 入参不合法时抛出 400，目标学期不属于本人时抛出 404
 */
function checkCommit(uid, b) {
  const src = b || {};
  const mode = String(src.mode || 'new');
  if (!['new', 'replace', 'append'].includes(mode)) throw httpError(400, '导入方式只能是 new / replace / append');
  let termId = null;
  if (mode !== 'new') {
    termId = idParam(src.term_id);
    if (termId === null) throw httpError(400, '缺少目标学期');
    // 越权与不存在统一 404（复用同一出口，不新造）
    if (!store.ownsTerm(uid, termId)) throw httpError(404, 'not found');
  }

  const term = checkTerm(src.term || {});
  const blocks = checkBlocks(src.blocks);
  let periods = checkPeriods(src.periods, []);
  if (!periods.length && blocks.length) periods = ti.generatePeriods(blocks); // 前端没带就现算
  if (periods.length && !blocks.length && mode !== 'append') throw httpError(400, '有逐节时间却没有时段块');

  const rawCourses = Array.isArray(src.courses) ? src.courses : [];
  if (rawCourses.length > MAX_COURSES) throw httpError(400, `课程过多（最多 ${MAX_COURSES} 门）`);
  let total = 0;
  const courses = rawCourses.map((c) => {
    const src2 = c || {};
    const name = String(src2.name || '').trim();
    if (!name) throw httpError(400, '课程名不能为空');
    if (name.length > 100) throw httpError(400, '课程名过长（最多 100 字）');
    const sessions = (Array.isArray(src2.sessions) ? src2.sessions : []).map(checkSession);
    total += sessions.length;
    if (total > MAX_SESSIONS) throw httpError(400, `课次过多（最多 ${MAX_SESSIONS} 条）`);
    const meta = checkCourse(src2);
    return { name: meta.name, short_name: meta.short_name, teacher: meta.teacher, color: meta.color, sessions };
  });

  return { mode, payload: { term_id: termId, term, blocks, periods, courses } };
}

/**
 * 功能：网址收藏夹的限长常量（0.3.0）。
 *
 * 说明：⭐ 只**限制长度与形态**，不做任何「聪明」的归一化：
 *      `MAX_URL = 2048` 是浏览器与主流代理的通行上限；`MAX_BM_TITLE = 512` 给标题足够余量；
 *      `MAX_BM_TAGS = 30` / `MAX_BM_TAG_NAME = 50` 防的是「一次贴进来一万个标签」这类事。
 *
 * @type {number}
 */
const MAX_URL = 2048;

/** 书签标题长度上限（可为空：空标题时界面显示域名） @type {number} */
const MAX_BM_TITLE = 512;

/** 一条书签最多能归入多少个分类 @type {number} */
const MAX_BM_TAGS = 30;

/** 单个分类名的长度上限 @type {number} */
const MAX_BM_TAG_NAME = 50;

/**
 * 功能：校验书签标题 —— 允许为空（界面会退回显示域名），但**超长一律 400，不静默截断**。
 * @param {Object} src - 请求体对象
 * @param {Object} out - 累积结果对象（就地写入）
 * @returns {void}
 * @throws {Error} 标题过长时抛出 400
 */
function readBookmarkTitle(src, out) {
  if (!hasKey(src, 'title')) return;
  const title = String(src.title || '').trim();
  if (title.length > MAX_BM_TITLE) throw httpError(400, `标题过长（最多 ${MAX_BM_TITLE} 字）`);
  out.title = title;
}

/**
 * 功能：校验并归一化书签的分类入参 —— **分类名（字符串）与分类 id（数字）都接受**。
 *
 * 说明：⭐ 两种形态都要收（与 `store.setBookmarkTags` 的约定一致）：多选控件里既可能有
 *      已选中的分类 id，也可能有用户当场输入的新分类名。名字只做长度与去重，
 *      「不存在就自动建」由 store 层负责（那是业务规则，不是入参校验）。
 *      ⚠️ 超长 / 超量一律 400，**不静默截断**。
 *
 * @param {Object} src - 请求体对象
 * @param {Object} out - 累积结果对象（就地写入）
 * @returns {void}
 * @throws {Error} 分类过多或某个名字过长时抛出 400
 */
function readBookmarkTags(src, out) {
  if (!hasKey(src, 'tags')) return;
  const raw = src.tags;
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) throw httpError(400, '分类应是一个数组');
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_BM_TAGS) throw httpError(400, `分类过多（最多 ${MAX_BM_TAGS} 个）`);
  const outList = [];
  for (const item of list) {
    if (typeof item === 'number' || /^\d+$/.test(String(item == null ? '' : item))) {
      const id = Number(item);
      if (Number.isInteger(id) && id > 0) outList.push(id);
      continue;
    }
    const name = String(item == null ? '' : item).trim();
    if (!name) continue; // 空名字直接丢掉（多选控件的空占位符）
    if (name.length > MAX_BM_TAG_NAME) throw httpError(400, `分类名过长（最多 ${MAX_BM_TAG_NAME} 字）`);
    outList.push(name);
  }
  out.tags = [...new Set(outList)];
}

/**
 * 功能：校验新增 / 编辑书签的入参 —— `url` / `title` / `tags`，**只校验请求里真的带了的字段**。
 *
 * 说明：⭐ 沿用 的口径：三个字段都支持局部更新，拿「必填」卡编辑会把
 *      「只改标题」这种正常操作打成 400。
 *      ⚠️ `url` 必须是**能被 `new URL()` 解析**的串；但
 *      `javascript:` / `file://` / `place:` 这些**允许存**（那是用户自己的数据）——
 *      1 期应用**根本不请求任何 URL**（无元数据抓取、无死链检测），所以没有 SSRF 问题。
 *      前端渲染时也用相对这个约定的方式（新窗口打开 + `rel="noopener noreferrer"`）。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的书签字段（只含请求里带了的键）
 * @throws {Error} url 缺失 / 非法 / 超长，或标题 / 分类不合法时抛出 400
 */
function checkBookmark(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  if (hasKey(src, 'url')) {
    const url = String(src.url == null ? '' : src.url).trim();
    if (!url) throw httpError(400, '网址不能为空');
    if (url.length > MAX_URL) throw httpError(400, `网址过长（最多 ${MAX_URL} 字符）`);
    // `new URL()` 只用来判断「这是不是一个能解析的绝对地址」——能解析的一律放行
    try {
      new URL(url);
    } catch (_e) {
      throw httpError(400, '网址格式不对（要写全，例如 https://example.com/page）');
    }
    out.url = url;
  }
  readBookmarkTitle(src, out);
  readBookmarkTags(src, out);
  if (hasKey(src, 'pinned')) out.pinned = src.pinned ? 1 : 0;
  if (hasKey(src, 'sort_order')) {
    const so = Number(src.sort_order);
    if (!Number.isFinite(so)) throw httpError(400, '排序号不合法');
    out.sort_order = Math.floor(so);
  }
  // ⭐ 0.8.5：关联的**密码库条目 id** —— 可空（`null` = 不关联）。
  //    ⚠️⭐ 先挡 `null` / 空串再转数字：`Number(null)` 与 `Number('')` **都是 0**，
  //    直接转会把它静默变成「编号 0 的条目」（本项目反复踩过的那一类坑）。
  //    ⛔ 这里**只做形状校验**：那一条到底是不是**自己的**密码库条目，由密码库那一侧兜住 ——
  //    前端要先解锁密码库并验过主密码才去取条目，而 `/api/vault/entries/:id` 自己会做归属校验
  //    （别人的 id 一律 404）。本条不为了这个去碰密码库（跨模块，且没有必要）。
  if (hasKey(src, 'vault_entry_id')) {
    const raw = src.vault_entry_id;
    if (raw == null || raw === '') {
      out.vault_entry_id = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw httpError(400, '关联的密码库条目 id 不合法');
      out.vault_entry_id = n;
    }
  }
  return out;
}

/**
 * 功能：校验分类的入参 —— 只认 `name`，必填、去空白、限长（超长 400，不截断）。
 *
 * 说明：分类的**重名与「智能新建」**都由 store 层处理（那是业务规则）——
 *      这里只保证「进来的名字本身是干净的」。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} `{ name }`
 * @throws {Error} 分类名为空或过长时抛出 400
 */
function checkTag(b) {
  const src = b && typeof b === 'object' ? b : {};
  const name = String(src.name == null ? '' : src.name).trim();
  if (!name) throw httpError(400, '分类名不能为空');
  if (name.length > MAX_BM_TAG_NAME) throw httpError(400, `分类名过长（最多 ${MAX_BM_TAG_NAME} 字）`);
  return { name };
}

/**
 * 功能：密码库（0.3.2）的限长与取值常量。
 *
 * 说明：⭐ 上限存在的意义都是「**防手滑，不是下结论**」——
 *      · `VAULT_MIN_MASTER = 8`：这是**唯一**一个有下限的字段。主密码是整库唯一的钥匙，
 *        而且**忘了就永久打不开**（没有找回通道），所以下限比登录口令（6 位）更严一档；
 *        但**刻意不设复杂度规则**（必须大小写 + 数字 + 符号）—— 那只会逼出 `Password1!` 这种
 *        可预测的密码，长短语更安全。界面上引导「12 位以上」即可（方案 §六）。
 *      · 条目字段**只有上限、没有下限**：`password` 那 1024 的上限里**有意包含空值** ——
 *        用户完全可能存的是一个旧系统的弱口令、甚至一个「没有密码、只有用户名」的账号
 *        （方案 §六 明确写了「不设最小长度」）。**只有新增那一次**要求 password 非空。
 *      · `note` 4096 与课表备注（500）不同：这里是「一整段说明」，给宽一点。
 *      · 标签（0.4.4 起）的口径与收藏夹的分类**刻意一致**（`MAX_SHORT_TEXT = 50` 一个字、
 *        一条最多 20 个）：用户心里这两件事是同一件事（「给东西归个类」），两处给出
 *        不一样的限长只会在换模块时突然报错。⚠️ 与收藏夹不同的是**标签名没有独立表**，
 *        它是密文里的一个字符串数组（见 `modules/vault/schema.js`）。
 *
 * @type {number}
 */
const VAULT_MIN_MASTER = 8;

/** 主密码长度上限（512）：够长的密码短语也放得下 @type {number} */
const VAULT_MAX_MASTER = 512;

/** 条目「标题」上限 @type {number} */
const MAX_VAULT_TITLE = 512;

/** 条目「用户名」上限 @type {number} */
const MAX_VAULT_USERNAME = 512;

/** 条目「密码」上限 —— ⚠️ 上限内**包含空串**，只有新增时另行要求非空 @type {number} */
const MAX_VAULT_PASSWORD = 1024;

/** 条目「备注」上限 @type {number} */
const MAX_VAULT_NOTE = 4096;

/** 密码生成器的长度区间与字符集白名单（与 `modules/vault/lib/crypto.js` 的 `PASSWORD_PRESETS` 对齐） */
const VAULT_GEN_MIN = 8;
const VAULT_GEN_MAX = 128;
const VAULT_GEN_CHARSETS = ['letters', 'alnum', 'all'];

/** 一条密码记录最多能打几个标签（0.4.4 起）—— 防「一次贴进来一串」，不是给人定规矩 @type {number} */
const MAX_VAULT_TAGS = 20;

/**
 * 功能：校验主密码 —— 去首尾空白后必须落在 `[8, 512]`。
 *
 * 说明：⚠️ **去空白是对的做法**，不是「苛待用户」：主密码要手输两遍（设置时还要二次确认），
 *      首尾多敲一个空格会让「本人也打不开自己的库」，而这种失败提示和「密码错」一模一样，
 *      用户永远查不出来。中间的空格一律保留（密码短语就是要靠空格）。
 *      ⚠️ **不接受纯空白**：那等于给库设了一个「看不见的密码」。
 *
 * @param {Object} b - 请求体对象，读 `masterPassword`
 * @returns {string} 去空白后的主密码
 * @throws {Error} 为空 / 过短 / 过长时抛出 400
 */
function checkMasterPassword(b) {
  const src = b && typeof b === 'object' ? b : {};
  const pw = String(src.masterPassword == null ? '' : src.masterPassword).trim();
  if (!pw) throw httpError(400, '请输入主密码');
  if (pw.length < VAULT_MIN_MASTER) {
    throw httpError(400, `主密码至少 ${VAULT_MIN_MASTER} 位（建议 12 位以上，用一句你记得住的话更好）`);
  }
  if (pw.length > VAULT_MAX_MASTER) throw httpError(400, `主密码过长（最多 ${VAULT_MAX_MASTER} 位）`);
  return pw;
}

/**
 * 功能：校验密码条目的入参 —— 标题 / 用户名 / 密码 / 网址 / 备注 / 标签。
 *
 * 说明：⭐ 沿用 的口径：**只校验请求里真的带了的字段**（每个字段都支持局部更新，
 *      拿「必填」卡编辑会把「只想改个标题」这种正常操作打成 400）；**未知键原样透传**
 *      （真正的落库白名单是 `modules/vault/store.js` 里那 6 个字段）。
 *      ⚠️ `password` 新增时必填由路由层查（与收藏夹的 `url`、硬件的 `name` 同一手法）。
 *      ⚠️ `url` **不做格式拦截**（与硬件台账的 `wish_url` 同一条理由）：密码库 1 期
 *      **不发生任何对外请求**，它只是用户自己的笔记；而且很多内网地址（`http://nas:5000`）
 *      本来就不是标准 URL，硬卡会把合法内容挡在外面。
 *      ⚠️ 标签（0.4.4 起）走 `readVaultTags()`：它是一个**数组**，不是字符串 ——
 *      别把它塞进上面那个 `String()` 循环里（那会把 `['a','b']` 变成 `'a,b'`，
 *      在密文里悄悄换了一种形态）。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的字段（只含请求里带了的键）
 * @throws {Error} 任一字段超长 / 标签不合法时抛出 400
 */
function checkVaultItem(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  for (const [key, label, max] of [
    ['title', '标题', MAX_VAULT_TITLE],
    ['username', '用户名', MAX_VAULT_USERNAME],
    ['password', '密码', MAX_VAULT_PASSWORD],
    ['url', '网址', MAX_URL],
    ['note', '备注', MAX_VAULT_NOTE],
  ]) {
    if (!hasKey(src, key) || src[key] === undefined) continue;
    const v = String(src[key] == null ? '' : src[key]);
    if (v.length > max) throw httpError(400, `${label}过长（最多 ${max} 字）`);
    out[key] = v;
  }
  readVaultTags(src, out);
  if (hasKey(src, 'sort_order')) {
    const so = Number(src.sort_order);
    if (!Number.isFinite(so)) throw httpError(400, '排序号不合法');
    out.sort_order = Math.floor(so);
  }
  return out;
}

/**
 * 功能：校验并归一化密码条目的**标签**入参（0.4.4 起）—— 一串自由文本的名字。
 *
 * 说明：⭐ 与收藏夹的分类（`readBookmarkTags`）有一处**刻意不同**：这里**没有 id 形态**。
 *      收藏夹有独立的分类表，所以「选已有分类」传的是 id；密码库的标签只活在密文里
 *      （服务端看不见、也没有第二张表），只有一个名字，界面上的「点已有标签追加」
 *      传的就是那个名字本身。
 *      ⚠️ 口径与收藏夹一致：去空白、丢空串（多选控件的空占位符）、去重、
 *      超过 `MAX_VAULT_TAGS` 或某个名字超过 `MAX_SHORT_TEXT` 一律 **400 不静默截断**。
 *      ⚠️ `tags: null` 与 `tags: []` 同义 = **清空标签**（与收藏夹「清空分类」同一个约定），
 *      而**不带** `tags` 键则表示「这次不动标签」（只校验请求里真的带了的字段）。
 *
 * @param {Object} src - 请求体对象
 * @param {Object} out - 累积结果对象（就地写入）
 * @returns {void}
 * @throws {Error} 标签不是数组 / 过多 / 某个名字过长时抛出 400
 */
function readVaultTags(src, out) {
  if (!hasKey(src, 'tags') || src.tags === undefined) return;
  const raw = src.tags;
  if (raw !== null && !Array.isArray(raw)) throw httpError(400, '标签应是一个数组');
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_VAULT_TAGS) throw httpError(400, `标签过多（最多 ${MAX_VAULT_TAGS} 个）`);
  /** @type {Array.<string>} */
  const names = [];
  for (const item of list) {
    const name = String(item == null ? '' : item).trim();
    if (!name) continue; // 空名字直接丢掉（界面上多出来的空位）
    if (name.length > MAX_SHORT_TEXT) throw httpError(400, `标签过长（最多 ${MAX_SHORT_TEXT} 字）`);
    names.push(name);
  }
  out.tags = [...new Set(names)];
}

/**
 * 功能：校验一个标签名（重命名 / 删除标签的入参）—— 非空、不超 `MAX_SHORT_TEXT`。
 *
 * 说明：⚠️ 错误信息里**不回显用户输入的名字**：这句话会被写进响应体（给本人看，没问题），
 *      但这个函数同时被日志附近的路径调用，少一处能带出用户内容的地方更安全
 *      ——密码库这一模块的硬要求是「明文绝不落日志」（方案 §5.3 硬要求 4）。
 *
 * @param {*} raw - 原始值
 * @param {string} label - 错误信息里的字段名（「原标签名」/「新标签名」）
 * @returns {string} 去空白后的标签名
 * @throws {Error} 为空或过长时抛出 400
 */
function checkVaultTagValue(raw, label) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) throw httpError(400, `请填写${label}`);
  if (name.length > MAX_SHORT_TEXT) throw httpError(400, `${label}过长（最多 ${MAX_SHORT_TEXT} 字）`);
  return name;
}

/**
 * 功能：校验「重命名标签」的入参 —— `{from, to}` 两个标签名。
 * @param {Object} b - 请求体对象
 * @returns {{from: string, to: string}} 归一化后的两个标签名
 * @throws {Error} 任一为空 / 过长，或两者相同时抛出 400
 */
function checkVaultTagRename(b) {
  const src = b && typeof b === 'object' ? b : {};
  const from = checkVaultTagValue(src.from, '原标签名');
  const to = checkVaultTagValue(src.to, '新标签名');
  // ⚠️ 相同就明确报 400（而不是静默返回「改好了」）：用户会以为发生了一次改动，
  //    而下一次再看到这个标签时会更困惑「到底改没改」。
  if (from === to) throw httpError(400, '新标签名与原标签名相同，不需要改');
  return { from, to };
}

/**
 * 功能：校验「删除标签」的入参 —— `{name}` 一个标签名。
 * @param {Object} b - 请求体对象
 * @returns {{name: string}} 归一化后的标签名
 * @throws {Error} 为空 / 过长时抛出 400
 */
function checkVaultTagRemove(b) {
  const src = b && typeof b === 'object' ? b : {};
  return { name: checkVaultTagValue(src.name, '标签名') };
}

/**
 * 功能：校验「新建一个空标签」的入参 —— `{name}` 一个标签名（0.8.18）。
 *
 * 说明：⭐ 与 `checkVaultTagRemove` 逐字同形（同一个 `checkVaultTagValue` 归一化），
 *      单独留一个名字是为了**路由层读起来是它的本意** —— 复用它只会让「删除」那条
 *      在调用点上看起来像在删东西。密码库的标签名**不分新建 / 删除两套长度口径**。
 *
 * @param {Object} b - 请求体对象
 * @returns {{name: string}} 归一化后的标签名
 * @throws {Error} 为空 / 过长时抛出 400
 */
function checkVaultTagCreate(b) {
  const src = b && typeof b === 'object' ? b : {};
  return { name: checkVaultTagValue(src.name, '标签名') };
}

/**
 * 功能：校验密码生成器的入参 —— 长度与字符集（**白名单**）。
 *
 * 说明：⚠️ 字符集白名单不能省：把用户传的字符串当字符集用，等于让请求体决定生成出来的密码长什么样，
 *      传一串 `'a'` 就会「生成」一串 `aaaaaaaa`，而界面上看不出任何异常。
 *
 * @param {Object} b - 请求体对象，读 `length` / `charset` / `noAmbiguous`
 * @returns {{length: number, charset: string, noAmbiguous: boolean}} 归一化后的生成参数
 * @throws {Error} 长度越界或字符集不认识时抛出 400
 */
function checkVaultGenerator(b) {
  const src = b && typeof b === 'object' ? b : {};
  const length = src.length === undefined || src.length === null || src.length === '' ? 16 : Number(src.length);
  if (!Number.isInteger(length) || length < VAULT_GEN_MIN || length > VAULT_GEN_MAX) {
    throw httpError(400, `密码长度应是 ${VAULT_GEN_MIN} 到 ${VAULT_GEN_MAX} 之间的整数`);
  }
  const charset = String(src.charset == null || src.charset === '' ? 'all' : src.charset);
  if (!VAULT_GEN_CHARSETS.includes(charset)) throw httpError(400, '字符集只能是 letters / alnum / all');
  return { length, charset, noAmbiguous: !!src.noAmbiguous };
}

/**
 * 功能：校验密码库自动锁定分钟数 —— 1~120 的整数（**不允许 0**）。
 *
 * 说明：⚠️ 不给「0 = 不自动锁定」这个选项是刻意的：自动锁定是密码库**唯一**在
 *      「服务被别人碰到」时的防线（本期没有硬件密钥、没有二次验证）。要放宽就放宽到 120 分钟，
 *      而不是提供一个「关掉」的开关 —— 那正是用户会在没想清楚时点下去的东西。
 *
 * @param {Object} b - 请求体对象，读 `lockMinutes`
 * @returns {number} 归一化后的分钟数
 * @throws {Error} 取值非法时抛出 400
 */
function checkVaultLockMinutes(b) {
  const src = b && typeof b === 'object' ? b : {};
  const n = Number(src.lockMinutes);
  if (!Number.isInteger(n) || n < 1 || n > 120) throw httpError(400, '自动锁定时间应是 1 到 120 分钟之间的整数');
  return n;
}

/**
 * 功能：NAS硬件管理（0.3.1）的限长与取值常量。
 *
 * 说明：⭐ 上限存在的意义都是「**防手滑，不是下结论**」——
 *      · `MAX_HW_PRICE = 99999999`（≈1 亿元）：家庭硬件几乎不可能到这个数，专门拦「多打了几个 0」；
 *      · `MAX_HW_LIFE_MONTHS = 600`（50 年）：预期寿命的**上限是防呆**，
 *        不是「硬件只能活 50 年」这种寿命结论（那种结论本应用不做，方案）；
 *      · `MAX_HW_QUANTITY = 999`：一手样本里的「买两个 4T 硬盘」是一条记录 + 数量 2，
 *        所以数量要能填，但没道理让人填一万个。
 *
 * @type {number}
 */
const MAX_HW_PRICE = 99999999;

/** 预期寿命上限（月）：600 = 50 年 @type {number} */
const MAX_HW_LIFE_MONTHS = 600;

/** 一件硬件的数量上限 @type {number} */
const MAX_HW_QUANTITY = 999;

/** 愿望优先级上限（0 = 没填 / 普通，1..3 越高越想买） @type {number} */
const MAX_HW_PRIORITY = 3;

/** 「为什么想买」的长度上限（500 字，与课表备注同口径） @type {number} */
const MAX_HW_REASON = 500;

/** 三值状态机的合法取值 */
const HW_STATUSES = ['wishlist', 'owned', 'retired'];

/** 硬件的短文本字段（都是自由文本，只限长不枚举） —— `[字段, 中文名]` */
const HW_SHORT_TEXT = [
  ['category', '分类'],
  ['purpose', '用途'],
  ['brand', '品牌'],
  ['model', '型号'],
  ['serial', '序列号'],
  ['capacity', '容量'],
  ['location', '位置'],
  ['slot', '盘位 / 槽位'],
  ['vendor', '购买渠道'],
];

/**
 * 功能：读一个**可清空的整数**字段（金额 / 月数 / 数量 / 优先级）—— 没带就不动，带了空值就清空。
 *
 * 说明：⚠️「清空」必须是一条合法操作：愿望单买回来之前没有价格、预期寿命可以反悔不设，
 *      如果 `''` 被判成 400，用户就永远删不掉那个数（只能重录整条）。所以：
 *      带了 `null` / `''` → 写 `null`；带了别的 → 必须是区间内的整数，否则 400。
 *
 * @param {Object} src - 请求体对象
 * @param {string} key - 字段名
 * @param {string} label - 中文名（进错误文案）
 * @param {number} min - 允许的最小值（含）
 * @param {number} max - 允许的最大值（含）
 * @param {Object} out - 累积结果对象（就地写入）
 * @returns {void}
 * @throws {Error} 取值非法时抛出 400
 */
function readHwInt(src, key, label, min, max, out) {
  if (!hasKey(src, key) || src[key] === undefined) return;
  const raw = src[key];
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    out[key] = null; // 显式清空
    return;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, `${label}应是 ${min} 到 ${max} 之间的整数`);
  }
  out[key] = n;
}

/**
 * 功能：校验 NAS硬件管理的新增 / 编辑入参 —— 台账字段、采购字段、寿命字段与愿望字段。
 *
 * 说明：⭐ 沿用 的口径：**只校验请求里真的带了的字段**（每个字段都支持局部更新，
 *      拿「必填」卡编辑会把「只想改个状态」这种正常操作打成 400）；**未知键原样透传**
 *      （真正的落库白名单只有 schema 模块的 `allowedCols`）。
 *      ⚠️ `name` **不在这里强制**：新增时由路由层查（与收藏夹的 `url` 同一手法），
 *      这样编辑时「只改备注」不会被要求重发名称。
 *      ⚠️ `wish_url` **不做 URL 合法性拦截** —— 它是用户自己的笔记，而且 1 期应用
 *      **根本不请求任何 URL**（不抓标题、不探死链），所以没有 SSRF 面。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 归一化后的字段（只含请求里带了的键）
 * @throws {Error} 任一字段不合法时抛出 400
 */
/**
 * 功能：把灵感标签归一化成一**组**干净的标签（0.8.14）。
 *
 * 说明：⭐ 「一个随手记可以有多个标签，参考网址收藏夹」。
 *      ⚠️ 接受**两种形状**：数组（新）或字符串（旧包的 `tag` —— 当成「只有一个标签」）。
 *      每一项 trim、去空、**去重（保留首次出现的先后）**；单项超长或总个数超上限一律 400
 *      （⛔ 不静默截断、不静默丢弃， 的老口径）。
 *      ⚠️ 上限刻意给得宽松（20 个）：标签是给人认路的，不是分类学的树 —— 定死上限是为了
 *      挡住「把整篇文章粘进标签框」这类滥用，不是限制正常用法。
 *
 * @param {*} raw - 请求里的 `tags`（数组）或 `tag`（字符串）
 * @returns {Array.<string>} 归一化后的标签数组（可能为空数组 = 清空标签）
 * @throws {Error} 单项过长、个数过多、类型不对时抛 400
 */
function normIdeaTags(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item !== 'string' && typeof item !== 'number') throw httpError(400, '标签必须是文本');
    const v = String(item).trim();
    if (!v) continue;
    if (v.length > MAX_SHORT_TEXT) throw httpError(400, `标签过长（最多 ${MAX_SHORT_TEXT} 字）`);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > 20) throw httpError(400, '标签最多 20 个');
  return out;
}

/**
 * 功能：校验并归一化一条灵感（灵感库，0.7.1）。
 *
 * 说明：⚠️ **只收请求里真的带了的键**（`hasKey`）：`POST` 只带 `content`，`PUT` 可能只带 `tags`
 *      或只带 `archived` —— 一次「只改标签」的请求不该被要求重发正文。
 *      ⭐ `archived` 在接口上是**布尔**（库里存 `archived_at` 时间戳，翻译在 store 层做）：
 *      让界面去造时间戳，等于把「库里的形状」泄漏到两端去。
 *      ⚠️ 正文**不许清空**由路由层判（那里才知道是新增还是编辑）—— 这里只管长度与类型。
 *
 * @param {Object} b - 请求体
 * @returns {Object} 归一化后的字段（只含请求里带了的键）
 * @throws {Error} 正文 / 标题 / 标签超长、类型不对时抛 400（⛔ 不静默截断，决策 36）
 */
function checkIdea(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};

  if (hasKey(src, 'content') && src.content !== undefined) {
    if (src.content !== null && typeof src.content !== 'string') throw httpError(400, '灵感内容必须是文本');
    const v = String(src.content == null ? '' : src.content).trim();
    if (v.length > MAX_LONG_TEXT) throw httpError(400, `灵感太长了（最多 ${MAX_LONG_TEXT} 字）`);
    out.content = v;
  }
  // ⭐⭐ 0.8.15：标题 —— 新增的可选字段。
  //    ⚠️ **只收请求里真带了的键**：旧包不传 ⇒ 库里是 NULL ⇒ 界面走「正文前 10 字」兜底
  //    ⇒ 旧包照常工作（与「老 `tag` 照样收」同一条纪律）。
  //    ⚠️ 超长 ⇒ **400 且不静默截断**（与正文、标签同一条口径）；`null` / `''` 一律归一成空串
  //    （空串 = 没有标题，界面自己兜底）。
  if (hasKey(src, 'title') && src.title !== undefined) {
    if (src.title !== null && typeof src.title !== 'string') throw httpError(400, '标题必须是文本');
    const v = String(src.title == null ? '' : src.title).trim();
    // ⭐ 0.8.15 真机修订（「标题限制为 50 个汉字」）：
    //    ⚠️ 从 `MAX_NAME`（100，任务标题 / 项目名共用）改成 `MAX_SHORT_TEXT`（50，标签 / 备注 /
    //    称呼那一族）—— 随手记的标题是**列表上的一行话**，不是任务标题那种要写完整信息的字段。
    //    ⚠️ 前端弹层的 `maxlength` 必须与这里**同一个数**（前端挡不住直接打接口的请求）。
    if (v.length > MAX_SHORT_TEXT) throw httpError(400, `标题过长（最多 ${MAX_SHORT_TEXT} 字）`);
    out.title = v;
  }
  // ⭐⭐ 0.8.14：「一个随手记可以有多个标签」⇒ `tags` 是一组。
  //    ⚠️ `tag`（老的单个）**照样收**：真机上装的旧包还在传它 —— 归一成「只有一个标签」，
  //    旧包于是照常工作（⛔ 不认它的话，旧包的「改标签」会**静默失效**）。
  //    ⚠️ 两个都传时以 `tags` 为准（新字段赢）。
  if (hasKey(src, 'tags') && src.tags !== undefined) out.tags = normIdeaTags(src.tags);
  else if (hasKey(src, 'tag') && src.tag !== undefined) out.tags = normIdeaTags(src.tag);
  if (hasKey(src, 'archived') && src.archived !== undefined) out.archived = !!src.archived;
  // ⭐ 「变成了哪个任务」：id 与来源**成对**收；带不齐 / 来源不认识 ⇒ 把这一对一起清空
  //    （⛔ 不留半截状态，见 `modules/idea/schema.js` 的取舍 ②）
  if (hasKey(src, 'task_id') && src.task_id !== undefined) {
    const n = Number(src.task_id);
    const s = String(src.task_source == null ? '' : src.task_source);
    if (Number.isFinite(n) && n > 0 && IDEA_TASK_SOURCES.includes(s)) {
      out.task_id = Math.floor(n);
      out.task_source = s;
    } else {
      out.task_id = null;
      out.task_source = null;
    }
  }
  return out;
}

/** 专业参数**值**的长度上限（与短文本同一把尺子：一个属性值不该比「型号」还长）。 @type {number} */
const MAX_HW_ATTR = MAX_SHORT_TEXT;

/** 一个模板最多几个专业参数（防手滑 / 防拿接口当免费存储）。 @type {number} */
const MAX_TPL_FIELDS = 30;

/**
 * 功能：把界面提交的「专业参数」归一成落库用的 JSON 文本（`hardware_items.attrs`）。
 *
 * 说明：⚠️ 只认**扁平对象**（`{ <字段key>: <值文本> }`）—— 键来自模板的字段定义、值是用户在
 *      表单里敲的那一行。非对象 / 数组一律当「没填」（回 `'{}'`）而⛔ 不是报错：那一组本来就
 *      都可以不填，从控制台传个怪东西进来也不该把整次保存打死（失败方向安全：存空、不存坏）。
 *      ⚠️ 值统一 `String()` + trim，**超长报 400**（与短文本同口径，⛔ 不静默截断）；
 *      空值的键**直接丢掉**（⛔ 不写 `{"缓存":""}`）—— 让「没填」在库里就是「没有这一项」。
 *
 * @param {*} raw - 请求体里的 `attrs`
 * @returns {string} 落库用的 JSON 文本（无有效项时是 `'{}'`）
 */
function serializeHwAttrs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (!key || key.length > MAX_SHORT_TEXT) continue;
    if (v === null || v === undefined) continue;
    const val = String(v).trim();
    if (!val) continue;
    if (val.length > MAX_HW_ATTR) throw httpError(400, `「专业参数」的取值过长（最多 ${MAX_HW_ATTR} 字）`);
    out[key] = val;
  }
  return JSON.stringify(out);
}

/**
 * 功能：归一化「硬件模板」的入参（`POST` / `PUT /api/hardware/templates`）。
 *
 * 说明：⚠️ 与别的 `check*` 同一条纪律：**只校验请求里真的带了的字段**（改名时不必重发 `fields`、
 *      改 `fields` 时不必重发 `name`）。⚠️ `fields` 在这里只做**形状与上限**（是数组 / 每项是
 *      对象 / 名字非空 / 长度），**`key` 的补齐与去重由 store 的 `normalizeFields()` 一处做** ——
 *      ⛔ 别在两处各写一份字段归一（迟早漂移，而漂移的表现是「某个属性莫名消失」）。
 *      ⚠️ 「内置模板不能改名 / 不能删预置字段」**不在这里判**：那要读库里的那一行（`builtin`），
 *      而本层不碰 store（与 `checkHardware` 里「这个模板是不是本人的」同一条分工）。
 *
 * @param {Object} b - 请求体
 * @returns {Object} 归一化后的字段（只含请求里真的带了的）
 */
function checkHardwareTemplate(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  if (hasKey(src, 'name') && src.name !== undefined && src.name !== null) {
    if (typeof src.name !== 'string') throw httpError(400, '模板名必须是文本');
    const name = src.name.trim();
    if (name.length > MAX_NAME) throw httpError(400, `模板名过长（最多 ${MAX_NAME} 字）`);
    out.name = name;
  }
  if (hasKey(src, 'fields') && src.fields !== undefined) {
    if (src.fields !== null && !Array.isArray(src.fields)) throw httpError(400, '「专业参数」必须是一个数组');
    const list = Array.isArray(src.fields) ? src.fields : [];
    if (list.length > MAX_TPL_FIELDS) throw httpError(400, `一个模板最多 ${MAX_TPL_FIELDS} 个专业参数`);
    list.forEach((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw httpError(400, `「专业参数」的第 ${i + 1} 项不是一个对象`);
      }
      const label = String(f.label == null ? '' : f.label).trim();
      if (!label) throw httpError(400, `「专业参数」的第 ${i + 1} 项没有名字`);
      if (label.length > MAX_SHORT_TEXT) throw httpError(400, `「专业参数」的名字过长（最多 ${MAX_SHORT_TEXT} 字）`);
      if (f.ph != null && String(f.ph).length > MAX_SHORT_TEXT) {
        throw httpError(400, `「专业参数」的提示过长（最多 ${MAX_SHORT_TEXT} 字）`);
      }
    });
    // ⚠️ 原样往下传（上面只做了形状校验）：`key` 的补齐 / 去重由 store 的 normalizeFields 一处做
    out.fields = list;
  }
  return out;
}

function checkHardware(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};

  // ---- 名称与短文本 ----
  if (hasKey(src, 'name') && src.name !== undefined && src.name !== null) {
    if (typeof src.name !== 'string') throw httpError(400, '名称必须是文本');
    const name = src.name.trim();
    if (name.length > MAX_NAME) throw httpError(400, `名称过长（最多 ${MAX_NAME} 字）`);
    out.name = name;
  }
  for (const [key, label] of HW_SHORT_TEXT) {
    if (!hasKey(src, key) || src[key] === undefined) continue;
    if (src[key] === null) {
      out[key] = '';
      continue;
    }
    if (typeof src[key] !== 'string') throw httpError(400, `${label}必须是文本`);
    const v = src[key].trim();
    if (v.length > MAX_SHORT_TEXT) throw httpError(400, `${label}过长（最多 ${MAX_SHORT_TEXT} 字）`);
    out[key] = v;
  }

  // ---- 状态（三值枚举；不认识的值一律 400，不静默兜底 —— 状态是分组的依据，猜错会被看见）----
  if (hasKey(src, 'status') && src.status !== undefined && src.status !== null && src.status !== '') {
    const st = String(src.status);
    if (!HW_STATUSES.includes(st)) throw httpError(400, '状态只能是「想买 / 在用 / 已退役」三种之一');
    out.status = st;
  }

  // ---- 分类归属（0.8.10）----
  // ⭐ 「分类」从自由文本 `category` 换成了 `asset_groups` 里的一行⇒ 入参只认 id。
  //    ⚠️ 复用资产那一边同一个读法（空 = 解绑到「未分类」，这是个有意义的动作）；
  //    ⚠️ 「这个分组是不是本人的」由 store 层查（`_assertHwGroupOwned`，越权统一 404），
  //    这里只管「它得是个正整数编号」。
  if (hasKey(src, 'group_id')) readAssetId(src, 'group_id', '分类', out);

  // ---- 模板与专业参数（⭐⭐ 0.8.23，「新建硬件必须选择一个模板」）----
  // ⭐ 与 `group_id` 同款：只认正整数编号 —— 「这个模板是不是本人的」由 store 层查
  //    （`_assertHwTemplateOwned()`，越权统一 404），这里只管「它得是个有效编号」。
  if (hasKey(src, 'template_id')) readAssetId(src, 'template_id', '模板', out);
  // ⚠️ `attrs` 从界面来的是一个**扁平对象**（`{ <字段key>: <值文本> }`）⇒ 在这里序列化成 JSON
  //    文本落库（两个后端存的是同一串字符）。⛔ 不做「这个键是不是该模板定义的字段」那种校验 ——
  //    那要查库，而本层**不碰 store**（它只管形状与上限；归属、业务规则全在 store 层）。
  if (hasKey(src, 'attrs') && src.attrs !== undefined) out.attrs = serializeHwAttrs(src.attrs);

  // ---- 采购与寿命 ----
  for (const [key, label] of [
    ['purchase_date', '购买日期'],
    ['warranty_until', '保修到期日'],
  ]) {
    if (!hasKey(src, key) || src[key] === undefined) continue;
    if (src[key] === null) {
      out[key] = '';
      continue;
    }
    const v = String(src[key]).trim();
    if (v && !isRealDate(v)) throw httpError(400, `${label}不是一个真实存在的日期（应为 YYYY-MM-DD）`);
    out[key] = v;
  }
  for (const [key, label, min, max] of [
    ['purchase_price', '价格', 0, MAX_HW_PRICE],
    ['wish_target_price', '目标价', 0, MAX_HW_PRICE],
    ['expected_life_months', '预期寿命（月）', 1, MAX_HW_LIFE_MONTHS],
    ['quantity', '数量', 1, MAX_HW_QUANTITY],
    ['wish_priority', '愿望优先级', 0, MAX_HW_PRIORITY],
  ]) {
    readHwInt(src, key, label, min, max, out);
  }

  // ---- 愿望 ----
  if (hasKey(src, 'wish_url') && src.wish_url !== undefined) {
    const v = String(src.wish_url == null ? '' : src.wish_url).trim();
    if (v.length > MAX_URL) throw httpError(400, `链接过长（最多 ${MAX_URL} 字符）`);
    out.wish_url = v;
  }
  if (hasKey(src, 'wish_reason') && src.wish_reason !== undefined) {
    const v = String(src.wish_reason == null ? '' : src.wish_reason);
    if (v.length > MAX_HW_REASON) throw httpError(400, `「为什么想买」过长（最多 ${MAX_HW_REASON} 字）`);
    out.wish_reason = v;
  }

  // ---- 详细内容（现有 txt 正文的落点，**超长报 400 不截断**）----
  if (hasKey(src, 'note') && src.note !== undefined) {
    const v = String(src.note == null ? '' : src.note);
    if (v.length > MAX_LONG_TEXT) throw httpError(400, `详细内容过长（最多 ${MAX_LONG_TEXT} 字）`);
    out.note = v;
  }

  return out;
}

/**
 * 个人资产管理（0.8.10）的上限 —— 与别的模块同一条口径：
 * 「防手滑 ＋ 防拿接口当免费存储」，超长一律 **400 且不静默截断**。
 *
 * ⚠️ `MAX_ASSET_FEN` 是**单条金额**的上限（约 100 亿元，单位：分），**允许负数** ——
 *    「这套房还欠银行 80 万」也是资产台账里的一句实话，⛔ 别用「必须为正」把它挡掉。
 *    ⚠️ 与记账的 `MAX_HW_PRICE`（整数**元**）不同：这里存的是**分**（记账口径，前端不算钱）。
 * @type {number}
 */
const MAX_ASSET_FEN = 999999999999;

/** 分组的两种界面角色（子模块 / 分类）—— 不在表里的一律 400。 @type {Array.<string>} */
const ASSET_KINDS = ['module', 'group'];

/**
 * 功能：读一个「可空的外键 id」（`parent_id` / `group_id`）—— 空值一律归一成 `null`。
 *
 * 说明：⚠️ 只校验请求里真的带了的字段；`null` / 空串 = **解绑**（这是个有意义的动作），
 *      与「没带这个键」是两件事，所以这里**必须**用 `hasKey` 区分。
 * @param {Object} src - 请求体
 * @param {string} key - 列名
 * @param {string} label - 中文名（错误信息用）
 * @param {Object} out - 归一化结果的落点
 * @returns {void}
 */
function readAssetId(src, key, label, out) {
  const v = src[key];
  if (v === null || v === '' || v === undefined) {
    out[key] = null;
    return;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `${label}不是一个有效的编号`);
  out[key] = n;
}

/**
 * 功能：读一个整数（可给范围），非法一律 400。
 * @param {Object} src - 请求体
 * @param {string} key - 列名
 * @param {string} label - 中文名
 * @param {number} min - 下界（含）
 * @param {number} max - 上界（含）
 * @param {Object} out - 归一化结果的落点
 * @returns {void}
 */
function readAssetInt(src, key, label, min, max, out) {
  const v = src[key];
  if (v === null || v === '') {
    out[key] = null;
    return;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${label}必须是 ${min}~${max} 之间的整数`);
  out[key] = n;
}

/**
 * 资产分组名字的**半角宽度**上限（「字体最多 5 个汉字或 10 个字母」）。
 *
 * 说明：⚠️ 按**宽度**算而不是「字符个数」—— 一个汉字占 2 个半角位，所以 5 个汉字与
 *      10 个字母在界面上**一样宽**（`halfWidthOf('一二三四五') === halfWidthOf('abcdefghij') === 10`）。
 *      ⚠️⭐ 因此这个常量是 **10**：`10 / 2 = 5 个汉字` 或 `10 个字母`。
 *      ⛔ **不是 20** —— 首版写成 20 就是把「5 个汉字」当成了 5 格，结果能打 10 个汉字，
 *      装机后一眼看出来「还是太长」。⚠️ 前端 `constants.js` 同一份，改一处必须改两处。
 *      ⚠️ 这是**额外的**一道（`MAX_NAME` 仍是 100）；只作用于**分组**，⛔ 不管通用条目。
 *      ⚠️⭐ 副作用（有意接受）：**比 10 格长的老名字**（内置的「NAS硬件管理」= 15 格、
 *      老分类文本搬来的子分类）之后**改不了名**（改名走同一道校验）—— 想改就先改成 ≤ 10 格的名字。
 *      不豁免的理由：豁免等于「先建个短名、再改成任意长」，那道限就白设了。
 * @type {number}
 */
const ASSET_NAME_UNITS = 10;

/**
 * 判断一个字符是不是「占两个半角位」的宽字符（CJK / 假名 / 谚文 / 全角形式与标点）。
 * @type {RegExp}
 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303F\u3040-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 功能：把一串文本折成「半角宽度」（宽字符算 2、其它算 1）。
 * @param {string} s - 文本
 * @returns {number} 半角宽度
 */
function halfWidthOf(s) {
  let n = 0;
  for (const ch of String(s || '')) n += WIDE_CHAR.test(ch) ? 2 : 1;
  return n;
}

/**
 * 功能：归一化「个人资产管理」的**分组**入参（`POST` / `PUT /api/assets/groups`）。
 *
 * 说明：⚠️ 只校验请求里真的带了的字段—— 编辑时「只改图标」不会被要求重发名称。
 *      ⚠️ **`module_key` 不收**：那是「这一格对应哪个代码模块」的代码层登记，
 *      ⛔ 不许由界面写（那等于「运行期造模块」， 明令禁止）。
 *      ⭐ 0.8.10：名称限 `ASSET_NAME_UNITS` 个**半角宽度**
 *      （= 5 个汉字 或 10 个字母）—— 新建 / 改名 / 子类别 / 子分类走的是**同一道**校验。
 * @param {Object} b - 请求体
 * @returns {Object} 归一化后的字段（只含请求里真的带了的）
 */
function checkAssetGroup(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};

  if (hasKey(src, 'name') && src.name !== undefined && src.name !== null) {
    if (typeof src.name !== 'string') throw httpError(400, '名称必须是文本');
    const name = src.name.trim();
    if (name.length > MAX_NAME) throw httpError(400, `名称过长（最多 ${MAX_NAME} 字）`);
    // ⭐ 0.8.10：分组名的**宽度**上限（见 `ASSET_NAME_UNITS`）—— 空名字放给后面的「必填」去管
    if (name && halfWidthOf(name) > ASSET_NAME_UNITS) {
      throw httpError(400, `名称过长（最多 ${ASSET_NAME_UNITS / 2} 个汉字或 ${ASSET_NAME_UNITS} 个字母）`);
    }
    out.name = name;
  }
  if (hasKey(src, 'icon') && src.icon !== undefined) {
    if (src.icon === null) {
      out.icon = '';
    } else {
      if (typeof src.icon !== 'string') throw httpError(400, '图标必须是文本');
      const v = src.icon.trim();
      if (v.length > MAX_SHORT_TEXT) throw httpError(400, `图标过长（最多 ${MAX_SHORT_TEXT} 字）`);
      out.icon = v;
    }
  }
  if (hasKey(src, 'kind') && src.kind !== undefined && src.kind !== null && src.kind !== '') {
    const k = String(src.kind);
    if (!ASSET_KINDS.includes(k)) throw httpError(400, '种类只能是「子模块」或「分类」');
    out.kind = k;
  }
  if (hasKey(src, 'parent_id') && src.parent_id !== undefined) readAssetId(src, 'parent_id', '父分组', out);
  if (hasKey(src, 'sort_order') && src.sort_order !== undefined) {
    readAssetInt(src, 'sort_order', '顺序', -100000, 100000, out);
  }
  return out;
}

/** 一次最多合并几个源（防手滑 / 防拿接口当批量工具）。 @type {number} */
const ASSET_MERGE_MAX = 50;

/**
 * 功能：归一化「**合并分组**」的入参（`POST /api/assets/groups/merge`）。
 *
 * 说明：⚠️⭐ 这是本项目少数几个**不是「整体替换」**的写接口 —— 它必须同时拿到「哪几格」
 *      （`ids`）与「并进哪一格」（`into`），**两个都是必填**（少一个这件事就没有意义可做）
 *      ⇒ 所以这里⛔ **不适用**「只校验请求里真带了的字段」那条，别照别的 `check*` 抄。
 *      ⚠️ `ids` 在这里**去重**（同一个 id 传两遍没有第二次意义，而重复会让服务端白跑一趟）；
 *      ⚠️「目标出现在 `ids` 里 / 跨层级 / 选了内置格」这些**语义**问题由业务层判 400
 *      （那里才说得出人话）—— 这里只管**形状**：正整数、条数上限。
 * @param {Object} b - 请求体
 * @returns {{ids: Array.<number>, into: number}} 归一化后的入参
 * @throws {Error} 形状不合法时抛 400
 */
function checkAssetGroupMerge(b) {
  const src = b && typeof b === 'object' ? b : {};
  const into = Number(src.into);
  if (!Number.isInteger(into) || into < 1) throw httpError(400, '「并进哪一格」不是一个有效的编号');
  if (!Array.isArray(src.ids)) throw httpError(400, '「要合并的」必须是一个数组');
  const ids = [];
  for (const raw of src.ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, '「要合并的」里有一个无效的编号');
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) throw httpError(400, '至少要选一格');
  if (ids.length > ASSET_MERGE_MAX) throw httpError(400, `一次最多合并 ${ASSET_MERGE_MAX} 格`);
  return { ids, into };
}

/**
 * 功能：归一化「个人资产管理」的**通用条目**入参（`POST` / `PUT /api/assets/items`）。
 *
 * 说明：⭐ **存量与流量刻意分开**：这里的金额**不进**记账的净值 / 预算 / 图表。
 *      ⚠️ `amount_fen` 允许为空 ——「空」与「0」是两件事（空 = 没填，0 = 真的是零元），
 *      ⛔ 别把空归一成 0（那会凭空造一个数字）。
 * @param {Object} b - 请求体
 * @returns {Object} 归一化后的字段（只含请求里真的带了的）
 */
function checkAssetItem(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};

  if (hasKey(src, 'name') && src.name !== undefined && src.name !== null) {
    if (typeof src.name !== 'string') throw httpError(400, '名称必须是文本');
    const name = src.name.trim();
    if (name.length > MAX_NAME) throw httpError(400, `名称过长（最多 ${MAX_NAME} 字）`);
    out.name = name;
  }
  if (hasKey(src, 'group_id') && src.group_id !== undefined) readAssetId(src, 'group_id', '所属分组', out);
  if (hasKey(src, 'amount_fen') && src.amount_fen !== undefined) {
    if (src.amount_fen === null || src.amount_fen === '') {
      out.amount_fen = null;
    } else {
      const n = Number(src.amount_fen);
      if (!Number.isInteger(n)) throw httpError(400, '金额必须是整数（单位：分）');
      if (Math.abs(n) > MAX_ASSET_FEN) throw httpError(400, '金额超出上限');
      out.amount_fen = n;
    }
  }
  if (hasKey(src, 'date') && src.date !== undefined) {
    if (src.date === null) {
      out.date = '';
    } else {
      const v = String(src.date).trim();
      if (v && !isRealDate(v)) throw httpError(400, '日期不是一个真实存在的日期（应为 YYYY-MM-DD）');
      out.date = v;
    }
  }
  if (hasKey(src, 'note') && src.note !== undefined) {
    const v = String(src.note == null ? '' : src.note);
    if (v.length > MAX_LONG_TEXT) throw httpError(400, `备注过长（最多 ${MAX_LONG_TEXT} 字）`);
    out.note = v;
  }
  return out;
}

/**
 * 协作上报（0.8.10 追加批）的两条口径。
 *
 * ⚠️ 这两个列表是 `modules/teamwork/lib/collab.js` 那两个常量的**同值镜像**（同样四个状态、
 *    同样两张任务表）—— 镜像的理由：`core` 不许 require 模块目录里的东西，
 *    而状态是**入参校验**必须挡住的东西（否则脏值一路走到 SQLite 的 CHECK 上、变成一句 500）。
 *    ⚠️ `ttt/test/collab.test.js` 有一条**逐值对比**的断言钉住两份不许漂移。
 * @type {Array.<string>}
 */
const REPORT_STATUSES = ['todo', 'doing', 'blocked', 'done'];

/** 同上（上报能挂在哪两张任务表上 —— ⚠️ `task_source` 与 `task_id` **必须成对**）。 @type {Array.<string>} */
const REPORT_SOURCES = ['project_tasks', 'daily_tasks'];

/** 上报那句备注的上限（与别的「一句话」同量级）。 @type {number} */
const MAX_REPORT_NOTE = 500;

/**
 * 功能：归一化「协作上报」的入参（`POST /api/collab/reports`）。
 *
 * 说明：⚠️ 只校验请求里真的带了的字段，但这里**三个都是必填**
 *      （来源 / 任务 id / 状态）—— 少一个这条上报就没有意义。
 *      ⚠️ `task_source` 用**白名单**：不认识的值当场 400，⛔ 不许透传
 *      （那会让「3 号任务」在两张表之间张冠李戴）。
 * @param {Object} b - 请求体
 * @returns {Object} 归一化后的字段
 */
function checkTaskReport(b) {
  const src = b && typeof b === 'object' ? b : {};
  const source = String(src.task_source == null ? '' : src.task_source).trim();
  if (!REPORT_SOURCES.includes(source)) throw httpError(400, '任务来源只能是「项目任务」或「日常任务」');
  const tid = Number(src.task_id);
  if (!Number.isInteger(tid) || tid < 1) throw httpError(400, '任务编号不是一个有效的编号');
  const status = String(src.status == null ? '' : src.status).trim();
  if (!REPORT_STATUSES.includes(status)) throw httpError(400, '状态只能是「待办 / 进行中 / 卡住了 / 已完成」之一');
  const note = String(src.note == null ? '' : src.note);
  if (note.length > MAX_REPORT_NOTE) throw httpError(400, `备注过长（最多 ${MAX_REPORT_NOTE} 字）`);
  return { task_source: source, task_id: tid, status, note };
}

/**
 * 对话（0.3.5）的几条上限 —— 都是「防手滑 + 防拿接口当免费存储」，不是产品结论。
 *
 * ⚠️ `MAX_TEAMWORK_BODY = 2000`：一条消息 2000 字足够写清楚一件事，而它同时是**跨账号内容**的
 *    体积闸门（消息是唯一一个「我写的东西要存进**别人**的列表里」的字段）。
 *    超长**报 400 且不静默截断**（与课表备注、密码库备注同一条规矩）。
 * ⚠️ `MAX_TEAMWORK_PAGE = 200`：历史分页一次最多 200 条（默认 50）。
 *    上限存在的意义是「别让一次请求把整段历史拉出来」，而不是分页本身。
 * ⭐ 0.6.4（任务联动）另加两条：卡片是**结构化载荷**，比正文更容易被当成「免费存储」
 *    （塞一整段 JSON 进去），所以与正文分开量。
 */
const MAX_TEAMWORK_BODY = 2000;
const MAX_TEAMWORK_PAGE = 200;

/**
 * 卡片消息的**种类白名单**（0.6.4，任务联动）—— 不在表里的一律 400。
 * 说明：⚠️ 未知种类**不许透传**：它一路流到渲染层，那边只能画成一块空白，
 *      而发出去的人以为「发出去了」。宁可当场报错。
 * @type {Array.<string>}
 */
const TEAMWORK_KINDS = ['task_card'];

/**
 * ⭐⭐ **仅服务端可用**的消息种类（0.7.7）—— 四种系统提醒各一个名字。
 *
 * 说明：⚠️⭐ **绝不能把它们并进 `TEAMWORK_KINDS`**：那份是「客户端可以发」的白名单
 *      （`checkTeamworkMessage()` 用它拦住不认识的种类），一旦混在一起，
 *      任何登录用户都能发一条 `kind='remind_course'` 的消息 ——
 *      那不是「多发一种卡片」，是**谁都能伪造一条系统提醒**（极强的社工素材）。
 *      ⇒ 真正的校验在 `modules/teamwork/store.js` 的 `REMIND_KINDS`（内置角色发消息的**唯一出口**
 *      `teamworkSendBuiltinMessage()` 用它把关），本常量是给「对照 / 断言」用的另一半。
 *      ⚠️ 两边**刻意不互相 require**（那边 require 本文件会牵出 `core/context.js` 那条环），
 *      由 `ttt/test/teamwork.test.js` 的「两处常量逐字相等」那条断言兜住漂移。
 *
 *      ⭐ 样式**只由 kind 决定**，刻意不新造 `meta` 字段契约（提醒不跨账号，
 *      用不上任务卡片那套逐字段白名单的机器）。
 *
 * @type {Array.<string>}
 */
const TEAMWORK_BUILTIN_KINDS = ['remind_course', 'remind_task_today', 'remind_overdue', 'remind_care', 'remind_trip'];

/** 卡片里「备注」那一行的长度上限（0.6.4）；整份载荷的上限由 `MAX_TEAMWORK_META` 兜底 */
const MAX_CARD_NOTE = 500;

/** 卡片载荷**序列化之后**的长度上限（0.6.4）—— 与正文同一个量级，够放下一个任务的摘要 */
const MAX_TEAMWORK_META = 2000;

/**
 * 功能：校验并归一化一条聊天消息的入参（`POST /api/teamwork/conversations/:id/messages`）。
 *
 * 说明：⚠️ 只认 `body` 一个键；**去首尾空白**（「敲了一串空格就发出去」在聊天里毫无意义，
 *      而且它会让对面收到一个空白气泡），**去完为空一律 400**。
 *      ⚠️ 保留正文里的换行与中间空格 —— 那是用户真实输入的一部分。
 * ⭐ 0.6.4（任务联动）：可另带一条**卡片消息**（`kind` + `meta`）—— 任务板把一条任务分享给
 *    好友时用它。三条规矩：
 *    ① `kind` 必须在白名单里（见 `TEAMWORK_KINDS`）；
 *    ② `meta` **逐个字段白名单搬运**，不做原样透传（见 `checkTaskCardMeta`）；
 *    ③ `body` 照样必填 —— 它是渲染端不认这个 `kind` 时的**降级文本**。
 *
 * @param {Object} b - 请求体对象
 * @returns {{ body: string, kind: ?string, meta: ?string }} 正文 + （可选的）种类与**已序列化**的载荷
 * @throws {Error} 正文为空 / 超长、种类不在白名单、载荷不合法时抛出 400
 */
function checkTeamworkMessage(b) {
  const src = b && typeof b === 'object' ? b : {};
  const body = String(src.body == null ? '' : src.body).trim();
  if (!body) throw httpError(400, '消息不能为空');
  if (body.length > MAX_TEAMWORK_BODY) throw httpError(400, `消息过长（最多 ${MAX_TEAMWORK_BODY} 字）`);
  const kind = src.kind == null ? '' : String(src.kind).trim();
  if (!kind) return { body, kind: null, meta: null };
  if (!TEAMWORK_KINDS.includes(kind)) throw httpError(400, '不支持的消息类型');
  return { body, kind, meta: checkTaskCardMeta(src.meta) };
}

/**
 * 功能：校验并**序列化**一条任务卡片的载荷（`checkTeamworkMessage` 的卡片分支，0.6.4）。
 *
 * 说明：⚠️ 字段**逐个白名单搬运** —— 它是**跨账号内容**（会存进对方的库里、在他的界面上渲染），
 *      所以「多一个字段」必须在这里显式加一行，而不是跟着请求体一起流过去。
 *      ⚠️ 这份字段契约**一头是任务板（怎么填）、一头是对话（怎么画）**，
 *      权威说明在 `docs/公共/架构文档/17-对话.md`；改动必须两边同改。
 *      ⚠️ `from`（署名）是**快照**：由任务板在发送时填好，对话模块**不去反查**发送者是谁 ——
 *      反查就意味着对话要再认识一次「账号显示名」那套口径（它已经有一处，但那是给好友列表用的）。
 *
 * @param {*} raw - 请求体里的 `meta`（必须是一个对象）
 * @returns {string} 序列化后的 JSON 文本（落库用；解析在 `store.js` 的 `parseCardMeta()` 一处）
 * @throws {Error} 不是对象 / 缺标题 / 字段超长 / 序列化后超长时抛出 400
 */
function checkTaskCardMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, '卡片内容不合法');
  const title = String(raw.title == null ? '' : raw.title).trim();
  if (!title) throw httpError(400, '卡片缺少任务标题');
  if (title.length > MAX_NAME) throw httpError(400, `任务标题过长（最多 ${MAX_NAME} 字）`);
  const out = { title };
  const due = String(raw.due == null ? '' : raw.due).trim();
  if (due) {
    if (!isRealDate(due)) throw httpError(400, '截止日期不是一个真实存在的日期（应为 YYYY-MM-DD）');
    out.due = due;
  }
  // ⭐ 这两项**总是写**（0 也写）：它们是四象限的核心信息，形状固定下来，
  //    两端渲染与「收进我的任务板」的预填就不必再判 `undefined`（结构化载荷的价值正在于此）。
  out.important = Number(raw.important) ? 1 : 0;
  out.urgent = Number(raw.urgent) ? 1 : 0;
  const note = String(raw.note == null ? '' : raw.note).trim();
  if (note) {
    if (note.length > MAX_CARD_NOTE) throw httpError(400, `卡片备注过长（最多 ${MAX_CARD_NOTE} 字）`);
    out.note = note;
  }
  const from = String(raw.from == null ? '' : raw.from).trim();
  if (from) {
    if (from.length > MAX_NAME) throw httpError(400, '署名过长');
    out.from = from;
  }
  // ⭐ 0.8.54（对话加号里能发「协作项目任务」）：来源与项目名 ——
  //    协作任务不是「谁分享了一条私事」，而是「某个共享项目里的这条任务」，卡片抬头要写明项目名。
  //    ⚠️ 只认两个取值（`daily` / `collab`），别的值一律 400：这是一个**枚举**，不是自由文本。
  const src = String(raw.src == null ? '' : raw.src).trim();
  if (src) {
    if (src !== 'daily' && src !== 'collab') throw httpError(400, '任务卡片的来源不合法');
    out.src = src;
  }
  const project = String(raw.project == null ? '' : raw.project).trim();
  if (project) {
    if (project.length > MAX_NAME) throw httpError(400, '项目名过长');
    out.project = project;
  }
  const text = JSON.stringify(out);
  if (text.length > MAX_TEAMWORK_META) throw httpError(400, `卡片内容过长（最多 ${MAX_TEAMWORK_META} 字）`);
  return text;
}

/**
 * 功能：校验好友申请的入参（`POST /api/teamwork/friends`）—— `userId` 或 `username` 二选一。
 *
 * 说明：⭐ 为什么要允许两种写法：界面上是「从账号列表里点一个人」（那时手里有 id），
 *      也允许「直接把登录名敲进去」（那时只有名字）。两种都支持，用户不必关心我们内部用哪个。
 *      ⚠️ **两个都没带一律 400**（「申请加好友」没有目标就不是一个合法请求）；
 *      名字的**存在性**不在这里查（那要动数据库，属于业务层，见 `modules/teamwork/store.js`）。
 *
 * @param {Object} b - 请求体对象
 * @returns {{ userId?: number, username?: string }} 归一化后的目标
 * @throws {Error} 两个键都没带、或 userId 不是正整数、或 username 过长时抛出 400
 */
function checkFriendRequest(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (hasKey(src, 'userId') && src.userId !== undefined && src.userId !== null && src.userId !== '') {
    const id = Number(src.userId);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, '账号 id 不合法');
    return { userId: id };
  }
  if (hasKey(src, 'username') && src.username !== undefined) {
    const name = String(src.username == null ? '' : src.username).trim();
    if (!name) throw httpError(400, '请填写要添加的账号名');
    if (name.length > MAX_SHORT_TEXT) throw httpError(400, `账号名过长（最多 ${MAX_SHORT_TEXT} 字）`);
    return { username: name };
  }
  throw httpError(400, '请提供要添加的账号（userId 或 username）');
}

/**
 * 功能：校验好友备注的入参（`POST /api/teamwork/friends/:id/remark`，0.4.4）。
 *
 * 说明：⭐ 备注是**纯文本、可以为空** —— 空串表示「清除备注、回到显示名」，
 *      这是一个正常操作，不是错误（所以这里**不**像消息那样「空就 400」）。
 *      ⚠️ 它只在**我这一行**上，对方看不到（见 `modules/teamwork/store.js` 的 `teamworkSetFriendRemark()`）。
 *      长度上限跟标签 / 负责人同一个口径（`MAX_SHORT_TEXT = 50`）：备注是给人快速认人的，
 *      不是第二个签名档。
 *
 * @param {Object} b - 请求体对象
 * @returns {{ remark: string }} 去首尾空白后的备注（空串 = 清除）
 * @throws {Error} 不是文本 / 超长时抛出 400
 */
function checkFriendRemark(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (src.remark !== undefined && src.remark !== null && typeof src.remark !== 'string') {
    throw httpError(400, '备注必须是文本');
  }
  const remark = String(src.remark == null ? '' : src.remark).trim();
  if (remark.length > MAX_SHORT_TEXT) throw httpError(400, `备注过长（最多 ${MAX_SHORT_TEXT} 字）`);
  return { remark };
}

/**
 * 「每日逾期汇总」时刻允许的范围 —— 它是一条**每天早上的汇总**，所以限在 00:00–12:00。
 * ⚠️ 上界存在是为了「说得出为什么」：逾期汇总是**一天的开场**（告诉你今天还欠着什么），
 *    把它设到下午三点既没有意义、又容易和任务提醒撞在同一分钟（同一分钟发两条）。
 */
const REMINDER_OVERDUE_MAX_MIN = 12 * 60;

/** 「上课提前多少分钟」的上限 —— 与作息表里「一节最长 180 分钟」同一个量级，够用且不至于早到离谱 */
const MAX_COURSE_LEAD_MINUTES = 180;

/**
 * 功能：校验提醒设置的入参（`PUT /api/teamwork/reminder-prefs`，0.6.x）。
 *
 * 说明：⭐ **带哪个键写哪个键**（与 `PUT /api/auth/prefs` 同款口径）：只校验并返回
 *      请求里**真的带了**的那几个键 —— 改「任务提醒时刻」绝不能顺手把「上课提前量」也写一遍。
 *      ⚠️ 一个受支持的键都没带 ⇒ 400（「什么都没改」不是一次合法请求，静默成功会让前端
 *      以为保存生效了）。
 *      ⚠️ 两个时刻字段必须是 `HH:MM`（**只认这一种写法**）：`8:00` / `20:00:00` 一律 400 ——
 *      它们会和 `fire_at` 的字典序比较、以及 `now.time === prefs.task_at` 的等值判断静默对不上，
 *      表现是「设了 8 点但到点不响」，而且**完全不报错**。
 *      ⚠️ 时刻越界（`24:00` / `20:60`）同样 400，不静默夹到边界。
 *      ⭐ 0.6.x 追加：`builtin_name`（我给内置角色起的称呼）也走这一处 —— 它与那几个时刻同属
 *      「对话自己的设置」那一张表、同一个接口写，**空串 = 恢复默认名**。
 *      ⭐ 0.6.4 追加 `care_enabled`（人文关怀：当天课上完了发一句问候）—— 与总开关同款
 *      （`true` / `false`）。它是一个**独立**开关：不想收这种消息、但仍要上课提醒的人关它一个就够。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 只含请求里真的带了的键的补丁（`enabled` / `care_enabled` 归一成 0/1）
 * @throws {Error} 一个键都没带 / 类型不对 / 时刻格式非法 / 越界时抛出 400
 */
function checkReminderPrefs(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== null && src[k] !== undefined;
  const out = {};
  if (has('enabled')) {
    if (typeof src.enabled !== 'boolean') throw httpError(400, '提醒总开关必须是 true / false');
    out.enabled = src.enabled ? 1 : 0;
  }
  // ⭐ 0.6.4（人文关怀）：与总开关同款 —— 只认 boolean，不静默接受 '0' / 0 这类写法
  if (has('care_enabled')) {
    if (typeof src.care_enabled !== 'boolean') throw httpError(400, '关怀消息开关必须是 true / false');
    out.care_enabled = src.care_enabled ? 1 : 0;
  }
  if (has('course_lead_minutes')) {
    const n = Number(src.course_lead_minutes);
    if (!Number.isInteger(n) || n < 0 || n > MAX_COURSE_LEAD_MINUTES) {
      throw httpError(400, `上课提前量必须是 0–${MAX_COURSE_LEAD_MINUTES} 之间的整数分钟（0 = 打铃那一刻提醒）`);
    }
    out.course_lead_minutes = n;
  }
  if (has('task_at')) out.task_at = checkReminderClock(src.task_at, '任务提醒时间', 23 * 60 + 59);
  if (has('overdue_at')) out.overdue_at = checkReminderClock(src.overdue_at, '逾期汇总时间', REMINDER_OVERDUE_MAX_MIN);
  if (has('due_lead_minutes')) {
    const n = Number(src.due_lead_minutes);
    if (!Number.isInteger(n) || n < 0 || n > MAX_COURSE_LEAD_MINUTES) {
      throw httpError(400, `任务截止提前量必须是 0–${MAX_COURSE_LEAD_MINUTES} 之间的整数分钟`);
    }
    out.due_lead_minutes = n;
  }
  // ⭐ 我给内置角色起的**称呼**。空串是**合法值**：它就是「恢复默认名」
  //    的表达方式（界面上的输入框留空即可），所以这里**不**当成「没带」。
  //    ⚠️ 换行/Tab 一律 400 而不是截掉：这个值要进单行标题，静默清理只会让人以为存下来的就是自己写的那串。
  if (has('builtin_name')) {
    if (typeof src.builtin_name !== 'string') throw httpError(400, '称呼必须是文本');
    const name = src.builtin_name.trim();
    if (name.length > MAX_SHORT_TEXT) throw httpError(400, `称呼过长（最多 ${MAX_SHORT_TEXT} 字）`);
    if (/[\r\n\t]/.test(name)) throw httpError(400, '称呼不能换行');
    out.builtin_name = name;
  }
  if (!Object.keys(out).length) throw httpError(400, '没有要修改的提醒设置');
  return out;
}

/**
 * 功能：校验好友设置的入参（`PUT /api/teamwork/friend-prefs`，0.7.7）。
 *
 * 说明：⭐ 与 `checkReminderPrefs()` **同一套写法**（带哪个键写哪个键，一个键都没带 ⇒ 400）——
 *      两处设置走同一条规矩，前端也就只有一种「保存」的语义要记。
 *      ⚠️ `auto_accept_friend` 只认 boolean（`1` / `'yes'` 一律 400，不静默当成 true）：
 *      它是「别人可以**不经我同意**直接成为我的好友」的开关 —— 这种开关被静默打开的代价，
 *      比它没被打开大得多。
 *
 * @param {Object} b - 请求体对象
 * @returns {Object} 只含请求里真的带了的键的补丁（`auto_accept_friend` 归一成 0/1）
 * @throws {Error} 一个键都没带 / 类型不对时抛出 400
 */
function checkFriendPrefs(b) {
  const src = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== null && src[k] !== undefined;
  const out = {};
  if (has('auto_accept_friend')) {
    if (typeof src.auto_accept_friend !== 'boolean') throw httpError(400, '自动通过好友申请必须是 true / false');
    out.auto_accept_friend = src.auto_accept_friend ? 1 : 0;
  }
  if (!Object.keys(out).length) throw httpError(400, '没有要修改的好友设置');
  return out;
}

/**
 * 功能：校验一个提醒时刻字段（`HH:MM`），返回**逐字原样**的字符串（不做补零 / 不夹边界）。
 *
 * 说明：⚠️ 只接受 `HH:MM` 两位写法：`8:00` 会被 `fire_at` 的字典序比较判成「不同的一分钟」，
 *      结果是「设了 8 点却到点不响」—— 一个**完全不报错**的缺陷。宁可当场 400。
 *
 * @param {*} v - 待校验的值
 * @param {string} label - 字段的中文名（进错误文案）
 * @param {number} maxMin - 允许的最大分钟数（含）
 * @returns {string} 原样的 `HH:MM`
 * @throws {Error} 格式非法或超出 `maxMin` 时抛出 400
 */
function checkReminderClock(v, label, maxMin) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) throw httpError(400, `${label}要写成 HH:MM（例如 20:00）`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 23 || Number(m[2]) > 59) throw httpError(400, `${label}不是一个有效的时刻`);
  if (minutes > maxMin) throw httpError(400, `${label}不能晚于 ${fmtClock(maxMin)}`);
  return s;
}

/**
 * 功能：把当天分钟数格式化成 `HH:MM`（只用于错误文案里的上界提示）。
 * @param {number} min - 当天分钟数
 * @returns {string} `HH:MM`
 */
function fmtClock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * AI 辅助任务（0.6.0）的三条上限 —— 口径与 teamwork / vault 一致：**防手滑 + 防拿接口当免费存储**。
 *
 * ⚠️ `MAX_AI_URL = 500`：自建网关的地址偶尔带路径与查询串（one-api 分发页会给出很长的地址），
 *    500 字足够覆盖；超长的几乎一定是把别的东西粘错了地方。
 * ⚠️ `MAX_AI_MODEL = 200`：模型名带组织前缀与量化后缀（如 `qwen2.5:14b-instruct-q4_K_M`）也不到 100 字。
 * ⚠️ `MAX_AI_KEY = 500`：各家的 key 长度从几十到一两百不等（有的中转网关发带前缀的长 token），
 *    500 字封顶足够；它**不明文落库**（`modules/ai/store.js` 现场封装成密文），上限只是给请求体一个边界。
 */
const MAX_AI_URL = 500;
const MAX_AI_MODEL = 200;
const MAX_AI_KEY = 500;

/**
 * 功能：校验并归一化 AI 配置保存的入参（`PUT /api/ai/config`）。
 *
 * 说明：⭐ **只校验请求里真带了的字段**（与 `PUT /api/auth/prefs` 同一手法）——
 *      保存支持「只改模型名」「只换 key」这类单字段操作。
 *      ⚠️ `baseUrl` 必须是 `http(s)://` 开头的 URL（**允许 http**：本地 ollama 是真实场景，
 *       拍板项 7；明文风险由设置页的界面提示承担，不在数据层拦）。
 *      ⚠️ `apiKey`：只认文本、设上限；**空串也原样返回** —— 「空串 = 不改动 key」是
 *      `modules/ai/store.js` 的刻意语义（防「只改模型名时顺手把 key 清了」），不是错误。
 *      ⚠️ 一个键都没带（或带的都是未知键）→ 400：「什么都不改」不是一次合法的保存请求。
 *
 * @param {Object} b - 请求体对象
 * @returns {{base_url?: string, model?: string, enabled?: boolean, apiKey?: string}} 归一化后的增量字段
 * @throws {Error} 类型不对 / 超长 / URL 不合法 / 一个合法键都没有时抛出 400
 */
function checkAiConfig(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  if (hasKey(src, 'base_url') && src.base_url !== undefined && src.base_url !== null) {
    if (typeof src.base_url !== 'string') throw httpError(400, '接口地址必须是文本');
    const v = src.base_url.trim();
    if (v) {
      if (v.length > MAX_AI_URL) throw httpError(400, `接口地址过长（最多 ${MAX_AI_URL} 字）`);
      if (!/^https?:\/\//i.test(v)) throw httpError(400, '接口地址必须以 http:// 或 https:// 开头');
      out.base_url = v;
    }
  }
  if (hasKey(src, 'model') && src.model !== undefined && src.model !== null) {
    if (typeof src.model !== 'string') throw httpError(400, '模型名必须是文本');
    const v = src.model.trim();
    if (v) {
      if (v.length > MAX_AI_MODEL) throw httpError(400, `模型名过长（最多 ${MAX_AI_MODEL} 字）`);
      out.model = v;
    }
  }
  if (hasKey(src, 'enabled') && src.enabled !== undefined) {
    if (typeof src.enabled !== 'boolean') throw httpError(400, '开关必须是布尔值');
    out.enabled = src.enabled;
  }
  if (hasKey(src, 'apiKey') && src.apiKey !== undefined && src.apiKey !== null) {
    if (typeof src.apiKey !== 'string') throw httpError(400, 'API Key 必须是文本');
    const v = src.apiKey.trim();
    if (v.length > MAX_AI_KEY) throw httpError(400, `API Key 过长（最多 ${MAX_AI_KEY} 字）`);
    // ⚠️ 空串**原样放进 out**：语义是「不改动」（见函数说明），不是错误
    out.apiKey = v;
  }
  if (!Object.keys(out).length) throw httpError(400, '没有要保存的内容');
  return out;
}

/**
 * AI 输入（聊天 / 指挥建任务）的长度上限：4000 字 —— 比 teamwork 消息的 2000 宽一倍
 * （AI 输入常是整段粘贴的需求描述， 拍板项 9）。
 * @type {number}
 */
const MAX_AI_TEXT = 4000;

/**
 * AI 消息里允许携带的图片类型 —— ⛔ **只有三种**。
 *
 * 说明：`svg` 是**脚本载体**（渲染侧能把 JS 执行起来），`gif` 体积不可控且没有使用场景
 *      ⇒ 两者一律 400。⭐ 这一份清单是图片链路**唯一**的 mime 判据。
 * @type {Array.<string>}
 */
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * 图片**解码后**的字节上限（1 MB）。
 * ⚠️ 前端那侧的目标是 ≤ 700 KB（长边 ≤ 1600 / JPEG quality 0.8）—— 这里留了余量，
 * 两者不是同一个数（前端是「压到多小」，这里是「最多能收多大」）。
 * @type {number}
 */
const IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * 功能：解析一串 data URL 图片 —— ⭐ **只回结论、不抛错**（调用方自己决定回 400 还是 404）。
 *
 * 说明：⭐⭐ 它是图片那条链路上**唯一**的解析处：`checkAiChat()`（**收下**时）与
 *      `GET /api/ai/messages/<id>/image`（**发出去**时）都调它 ⇒「什么算合法图片」只有一份判据。
 *      ⚠️ `bytes` 用 **base64 长度换算**（`n*3/4` 再去掉尾部 padding），⛔ **不去真解码**
 *      —— 1 MB 的图解码一次就是一次 1 MB 的内存分配，而这个数只用来判断「超没超」。
 *
 * @param {*} v - 待解析的值（期望整串 `data:image/jpeg;base64,…`）
 * @returns {{ok: boolean, reason?: string, mime?: string, base64?: string, bytes?: number}}
 *      `ok: true` 时给 `mime` / `base64` / `bytes`；否则 `reason ∈ {format, mime, size}`
 */
function parseImageDataUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return { ok: false, reason: 'format' };
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(s);
  if (!m) return { ok: false, reason: 'format' };
  const mime = m[1].toLowerCase();
  if (!IMAGE_MIMES.includes(mime)) return { ok: false, reason: 'mime' };
  const base64 = m[2];
  const pad = (base64.match(/=+$/) || [''])[0].length;
  const bytes = Math.floor((base64.length * 3) / 4) - pad;
  if (bytes > IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
  return { ok: true, mime, base64, bytes };
}

/**
 * 功能：校验**聊天**输入 —— `{ content, image?, card? }`。
 *
 * 说明：⭐ 0.8.6（行程 1 期 ·）：多认一个可选的 `image`（整串 data URL）。
 *      ⚠️⭐ **文字与图片至少要有一个** —— 「只发一张车票截图、一个字都不写」正是 AI 识票
 *      最常见的用法；而纯文字那条路**一个字不改**（⛔ 别顺手把 `content` 变成可空的）。
 *      ⚠️ 空串 / null 的 `image` 一律算「没有图片」（不是错误）—— 前端取消选中的图走的就是这一条。
 *
 *      ⭐⭐ **0.8.55**（「也要可以给AI发图片和任务」）：再多认一个可选的 `card` ——
 *      把一条**任务卡片**发给 AI（与好友聊天那颗 ＋ 里的「发送任务」同一个动作）。
 *      ⚠️ 只认 `kind === 'task_card'` 这一种，且 `meta` 逐字段白名单搬运 ＋ 定长截断：
 *      这张卡会被存进消息并在界面上重画，多带一个键就是多一处要防的东西。
 *      ⚠️ 卡片**不替代正文**：`content` 是「降级文本」（模型读到的就是它），卡片只是给人看的版式。
 *
 * @param {Object} b - 请求体对象
 * @returns {{content: string, image: ?string, card: ?Object}} 归一化后的输入
 * @throws {Error} 非文本 / 都没有 / 超长 / 图片不合法 / 卡片形状不对时抛 400（不静默截断，决策 36）
 */
function checkAiChat(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (typeof src.content !== 'string') throw httpError(400, '聊天内容必须是文本');
  const v = src.content.trim();
  if (v.length > MAX_AI_TEXT) throw httpError(400, `内容过长（最多 ${MAX_AI_TEXT} 字），请删减后再发`);
  let image = null;
  if (src.image !== undefined && src.image !== null && src.image !== '') {
    const p = parseImageDataUrl(src.image);
    if (!p.ok) {
      throw httpError(
        400,
        p.reason === 'mime'
          ? '只认得 JPEG / PNG / WebP 三种图片'
          : p.reason === 'size'
            ? '这张图太大了（压一下再发，或者裁一刀）'
            : '图片格式看不懂',
      );
    }
    image = String(src.image);
  }
  // ⭐ 0.8.55：任务卡片（可选）
  let card = null;
  if (src.card !== undefined && src.card !== null) {
    const c = src.card;
    if (!c || typeof c !== 'object' || String(c.kind == null ? '' : c.kind) !== 'task_card') {
      throw httpError(400, '这张卡片认不出来');
    }
    const m = c.meta && typeof c.meta === 'object' ? c.meta : {};
    const line = (x, cap) =>
      String(x == null ? '' : x)
        .trim()
        .slice(0, cap);
    const title = line(m.title, 100);
    if (!title) throw httpError(400, '这张任务卡片没有标题');
    const due = line(m.due, 10);
    card = {
      kind: 'task_card',
      meta: {
        title,
        due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '',
        important: m.important ? 1 : 0,
        urgent: m.urgent ? 1 : 0,
        note: line(m.note, 500),
        // ⚠️ `src` 只认两个值（决定卡片抬头那句：分享 vs 某个项目里的任务）
        src: String(m.src == null ? '' : m.src) === 'collab' ? 'collab' : 'daily',
        project: line(m.project, 60),
        from: line(m.from, 60),
      },
    };
  }
  if (!v && !image && !card) throw httpError(400, '要发的内容不能是空的');
  return { content: v, image, card };
}

/**
 * 功能：校验**指挥建任务**的输入 —— `{ messageId?, text? }`，至少其一（两式可并用）。
 *
 * 说明：⚠️ `messageId` 只认**正整数**（自己的对话消息 id）；`text` 是手填补充，去空白后可空串
 *      —— 但两个都没有 = 「没有要发给 AI 的内容」，400。
 *
 * @param {Object} b - 请求体对象
 * @returns {{messageId?: number, text?: string}} 归一化后的输入
 * @throws {Error} 类型不对 / 都缺时抛 400
 */
function checkAiExtract(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  if (src.messageId !== undefined && src.messageId !== null) {
    if (!Number.isInteger(src.messageId) || src.messageId <= 0) throw httpError(400, '消息编号不合法');
    out.messageId = src.messageId;
  }
  if (src.text !== undefined && src.text !== null) {
    if (typeof src.text !== 'string') throw httpError(400, '补充内容必须是文本');
    const v = src.text.trim();
    if (v.length > MAX_AI_TEXT) throw httpError(400, `补充内容过长（最多 ${MAX_AI_TEXT} 字）`);
    if (v) out.text = v;
  }
  if (!out.messageId && !out.text) throw httpError(400, '没有要交给 AI 的内容');
  return out;
}

module.exports = {
  MAX_NAME,
  MAX_LONG_TEXT,
  MAX_SHORT_TEXT,
  MAX_STATUS,
  MAX_STAMP,
  PROJECT_TEXT,
  TASK_TEXT,
  DAILY_TEXT,
  FLAG_LABEL,
  hasKey,
  isRealDate,
  checkTaskInput,
  checkProject,
  checkProjectTask,
  checkDailyTask,
  // ⭐ 0.8.14：周期规则的校验器单独导出 —— 用例直接打它比绕接口更省事
  checkRecurRule,
  TASK_KINDS,
  HHMM,
  DATE_RE,
  MAX_BLOCKS,
  MAX_PERIODS,
  MAX_WEEKS,
  MAX_TT_REMARK,
  checkAdjustment,
  checkDayRule,
  checkDayNote,
  checkOnward,
  MAX_COURSES,
  MAX_SESSIONS,
  checkTerm,
  checkBlocks,
  checkPeriods,
  checkSession,
  checkCourse,
  checkCommit,
  MAX_URL,
  MAX_BM_TITLE,
  MAX_BM_TAGS,
  MAX_BM_TAG_NAME,
  checkBookmark,
  checkTag,
  VAULT_MIN_MASTER,
  VAULT_MAX_MASTER,
  MAX_VAULT_TITLE,
  MAX_VAULT_USERNAME,
  MAX_VAULT_PASSWORD,
  MAX_VAULT_NOTE,
  MAX_VAULT_TAGS,
  VAULT_GEN_MIN,
  VAULT_GEN_MAX,
  VAULT_GEN_CHARSETS,
  checkMasterPassword,
  checkVaultItem,
  checkVaultGenerator,
  checkVaultLockMinutes,
  checkVaultTagRename,
  checkVaultTagRemove,
  checkVaultTagCreate,
  MAX_HW_PRICE,
  MAX_HW_LIFE_MONTHS,
  MAX_HW_QUANTITY,
  MAX_HW_PRIORITY,
  MAX_HW_REASON,
  HW_STATUSES,
  checkHardware,
  checkHardwareTemplate,
  MAX_ASSET_FEN,
  ASSET_KINDS,
  checkAssetGroup,
  checkAssetGroupMerge,
  checkAssetItem,
  REPORT_STATUSES,
  REPORT_SOURCES,
  MAX_REPORT_NOTE,
  checkTaskReport,
  checkIdea,
  MAX_TEAMWORK_BODY,
  MAX_TEAMWORK_PAGE,
  TEAMWORK_BUILTIN_KINDS,
  checkTeamworkMessage,
  checkFriendRequest,
  checkFriendRemark,
  REMINDER_OVERDUE_MAX_MIN,
  MAX_COURSE_LEAD_MINUTES,
  checkReminderPrefs,
  checkFriendPrefs,
  MAX_AI_URL,
  MAX_AI_MODEL,
  MAX_AI_KEY,
  MAX_AI_TEXT,
  IMAGE_MIMES,
  IMAGE_MAX_BYTES,
  parseImageDataUrl,
  checkAiConfig,
  checkAiChat,
  checkAiExtract,
};
