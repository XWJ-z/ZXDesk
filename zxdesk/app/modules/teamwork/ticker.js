/**
 * modules/teamwork/ticker.js —— 对话 2 期的**后台提醒**（0.6.x）
 *
 * 功能：每分钟醒一次，算出「这一分钟该给谁发什么提醒」，并把它发进「提醒助手」那个会话。
 *      三分工刻意拆开：
 *      ① `dueJobs(now, data)` —— ⭐ **纯函数**：这一分钟该发什么（输入假时间就能测，**不用 sleep**）；
 *      ② `collect()` —— 取数（提醒设置 / 今天的课 / 任务，全部走既有接口，见下）；
 *      ③ `runOnce()` / `start()` —— 定时与落库、推送。
 *
 * ⭐⭐ **本项目第一个、也是唯一一个常驻定时器**（`core/` 全树此前 `setInterval` 出现 0 次）。
 *    三条硬规矩：
 *    · `setInterval(60_000).unref()` —— 不阻止进程退出（飞牛停应用时要能停下来）；
 *    · **逐账号 try/catch 隔离** —— 一个账号的数据出错绝不拖累别人；
 *    · **错误必须可见**：任何异常都写进启动日志那一份日志里，绝不静默吞。
 *
 * ⭐ **幂等靠记账，不靠「先查后插」**：发之前先往 `teamwork_reminders` 插一行
 *    （`UNIQUE(user_id, kind, ref_key, fire_at)`）—— 撞唯一键 = 这一分钟已经发过，当场跳过。
 *    所以「服务重启不重发、两个 tick 撞在同一分钟也只发一条」是**数据库约束**保证的。
 *    ⛔ **停机跨过的提醒不补发、当日已过时刻不补发** —— 开机瞬间糊一脸通知，用户会直接关掉它
 *    （启动时只把「今天已经过去的提醒时刻有几个」写进日志，不去补）。
 *
 * ⭐ **「一切皆任务」与「不另造口径」**：
 *    · 任务那一侧**只用** `store.dashboard()` 的宽口径预筛结果 —— ⛔ 这里**不许**自己查任务表、
 *      也不许另写一套「逾期」判据（那会变成第三份口径：前端一份、预筛一份、提醒一份，
 *      而 0.5.5 那个 bug 正是「只改了一半」造成的）。判定用的「今天」也取自 `dashboard()` 的
 *      `today` 字段，不在这里重新算一个日期。
 *    · 课表那一侧复用 `store.dashboard().courses`（它已经合并过单次调课 / 停课与周次）
 *      ＋ 课表模块的假日口径（放假不发 / 假前一天下午提前，/ 71）。
 *
 * ⚠️⭐ **跨模块的东西一律「可选地」拿**：课表模块可以被整目录删掉，
 *    所以 `scheduleOf` / `listPeriods` / `holiday-util.js` 全部**先探再用、拿不到就退化成不发课程提醒**
 *    —— ⛔ 绝不在模块顶层硬 `require` 别人模块目录里的文件：那会让「删掉课表 ⇒ 应用起不来」。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.54
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/架构文档/07-大学课表.md、docs/公共/开发方案/12-对话2期-内置提醒角色.md
 */
'use strict';

const { addDays, nowStamp } = require('../../core/store/helpers.js');
const { dateOrdinal } = require('../../core/timetable/date-util.js');

/** 检查间隔：一分钟一次（提醒是**分钟级**的，再密没有意义、再疏会漏掉整整一分钟） */
const TICK_MS = 60_000;

/** 提醒流水保留天数（超期在每天凌晨顺带清 —— 它是运行态数据，不进个人备份，见方案 §四） */
const REMINDER_KEEP_DAYS = 90;

/** 一天里清理旧流水的时刻 —— 取凌晨 4 点：默认设置里最早的提醒是 07:00，谁也碰不上 */
const PURGE_AT = '04:00';

/** 内置角色标识（与 `store.js` 的 `BUILTIN_REMINDER` 同一个值；各写一份是**结构性**的，见下方 `start()`） */
const BUILTIN_KEY = 'reminder';

/**
 * 提醒类别 —— ⛔ 这里的取值就是**幂等键的一半**，改它等于让历史流水全部作废（会重发一遍）。
 * ⭐ 0.6.4 加 `care`（课上完了的一句关怀）：它的 `ref_key` 是 `care:<日期>`。
 * ⭐ 0.8.6 加 `trip`（行程的出发提醒）：取值 `trip_depart`，`ref_key` 是
 *    `trip:<车票 id>:<档位>` —— ⚠️ **刻意不带「归属」**：项目 要求「任务类 `ref_key`
 *    必须带归属」，理由是**日常任务与项目任务是两张表、id 都从 1 开始**；
 *    而车票**只有一张表、id 全局唯一** ⇒ 带归属是多余的。
 * @type {Object.<string, string>}
 */
const KIND = { course: 'course', taskToday: 'task_today', overdue: 'overdue_daily', care: 'care', trip: 'trip_depart' };

/**
 * ⭐ 提醒类别 → **消息种类**（0.7.7）—— 映射表**全项目只此一处**。
 *
 * 说明：⚠️ 左右两边**刻意不同名**：左边是**幂等记账**用的 `kind`（改它会让历史流水全部作废、
 *      重发一遍），右边是**消息行**上的 `kind`（只决定前端画哪一种卡片）。
 *      ⚠️⭐ 右边这四类**只能在服务端写**（`validate.js` 的 `TEAMWORK_BUILTIN_KINDS`）——
 *      ⛔ 它们绝不在 `TEAMWORK_KINDS`（客户端可发）里：进了就等于谁都能伪造一条「系统提醒」。
 * @type {Object.<string, string>}
 */
const MSG_KIND = {
  [KIND.course]: 'remind_course',
  [KIND.taskToday]: 'remind_task_today',
  [KIND.overdue]: 'remind_overdue',
  [KIND.care]: 'remind_care',
  [KIND.trip]: 'remind_trip',
};

/** 定时器句柄（`start()` 幂等靠它） @type {?Object} */
let timer = null;

/** 本进程是否已经报告过「今天已过去的提醒时刻」（启动时一次，别每分钟刷屏） @type {boolean} */
let missedReported = false;

/**
 * 功能：取当前的**本地**日期与分钟级时刻 —— 与 `store/helpers.js` 的 `today()` / `nowStamp()` 同一时区口径。
 *
 * 说明：⚠️ 刻意不用 `toISOString()`（那是 UTC，会比本地早 8 小时）：「今天」在提醒里是**用户的一天**，
 *      差 8 小时的代价是「早上的提醒发到了昨天」。
 *
 * @param {Object} [d] - 时间源（默认 `new Date()`；测试传假时间）
 * @returns {{date: string, time: string, key: string}} `date` = `YYYY-MM-DD`、`time` = `HH:MM`、
 *     `key` = `YYYY-MM-DD HH:MM`（**就是流水里的 `fire_at`**）
 */
function nowOf(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  const time = `${p(t.getHours())}:${p(t.getMinutes())}`;
  return { date, time, key: `${date} ${time}` };
}

/**
 * 功能：由「这节课几点开始」与「提前多少分钟」算出**该在哪一分钟提醒**。
 *
 * 说明：⚠️ 提前量把时刻推到零点之前时**夹到 `00:00`**（凌晨那节课不该因为提前量算出一个
 *      负时刻 —— 那会让这个提醒**永远不触发**，而且不报任何错）。
 *
 * @param {string} startTime - 开课时刻 `HH:MM`（已含调课 / 假日前提前等修正）
 * @param {number} leadMinutes - 提前分钟数（0 = 打铃那一刻提醒）
 * @returns {string} 该提醒的时刻 `HH:MM`；`startTime` 读不出来时返回空串
 */
function fireTimeOf(startTime, leadMinutes) {
  const m = String(startTime || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return '';
  const total = Math.max(0, Number(m[1]) * 60 + Number(m[2]) - (Number(leadMinutes) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 60))}:${p(total % 60)}`;
}

/**
 * 「课上完了」那句问候的**投递窗口**（分钟，0.6.4「增加人文关怀消息」）。
 *
 * 说明：⭐ 判据是「现在落在 [最后一节课的下课时刻, 下课时刻 + 这个窗口) 之内」，
 *      而**不是**「现在恰好等于下课时刻」—— 后者的前提是 ticker 那一拍正好落在那一分钟上，
 *      而 NAS 完全可能在那一刻恰好在重启、或在跑别的活。给一个窗口才容错。
 *      ⚠️ 窗口之外**不补发**（与「停机跨过的时刻不补发」同一条规矩）：凌晨才把服务起起来时，
 *      不该突然收到一句「今天的课都上完啦、辛苦啦」。
 *      ⚠️ 窗口刻意短于「一节课的最长时间」，避免和别的提醒挤在同一分钟里。
 * @type {number}
 */
const CARE_WINDOW_MIN = 90;

/**
 * 「课上完了」的几句问候 —— 按**日期**轮换（不是真随机）。
 *
 * 说明：⚠️ `dueJobs()` 是**纯函数**（输入假 `now` 就能测、不许 sleep、不许碰时钟）：
 *      真随机会让同一份输入产出不同结果，测试根本钉不住。按日期取模既天天不一样、又可复现。
 *      ⚠️ 文案里**不许**出现「今天上了几节课」这类要另查库的话 —— 这一条手上只有课表条目。
 * @type {Array.<string>}
 */
const CARE_LINES = [
  '今天的课都上完啦，辛苦啦 ☕',
  '一天的课结束咯 —— 歇一会儿吧 🍵',
  '课上完啦，今天也辛苦你了 🌙',
  '今天的学习收工啦，辛苦辛苦 🐾',
];

/**
 * 功能：把 `HH:MM` 换成当天的分钟数（用来比较两个时刻的先后）。
 * @param {string} t - `HH:MM`
 * @returns {number} 分钟数；读不出来时返回 -1
 */
function toMinutes(t) {
  const m = String(t || '').match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/**
 * 功能：挑出今天那句关怀 —— 按日期轮换（见 `CARE_LINES` 的说明）。
 * @param {string} date - `YYYY-MM-DD`
 * @returns {string} 一句问候
 */
function careBody(date) {
  const n = CARE_LINES.length;
  const ord = dateOrdinal(String(date || '')) || 0;
  return CARE_LINES[((ord % n) + n) % n];
}

/**
 * 功能：把「第几节」写成人话（单节写 `第 3 节`，连堂写 `第 3–4 节`）。
 * @param {Object} c - 课程条目（`period_start` / `period_end`）
 * @returns {string} 节次文案
 */
function periodText(c) {
  const a = Number(c.period_start) || 0;
  const b = Number(c.period_end) || a;
  return a === b ? `第 ${a} 节` : `第 ${a}–${b} 节`;
}

/**
 * 功能：拼「上课提醒」的正文（多条同分钟的课合并成一条）。
 *
 * 说明：⭐ **两种备注都带，且标得清谁是谁** —— 课程备注（这门课）与**本节备注**（这一天这一节），
 *      标签与课表页、看板上写的**逐字一致**（`【课程备注】` / `【本节备注】`）——
 *      用户在两处看到同一个词，才知道说的是同一件事。
 *      ⚠️ 0.7.1 之前这里的第二条装的是**课次备注**（挂课次 = 按周重复）⇒ 这门课**每次上课
 *      都带同一条**，那正是毛病。现在它取自 `timetable_day_notes`，
 *      由 `dashboard().courses` 按「提醒的那一天」查好（见 `core/store/methods/stats.js`）。
 *
 * @param {Array.<Object>} list - 同一分钟要提醒的课程条目
 * @param {number} lead - 提前分钟数（0 时改说「现在开始上课」）
 * @returns {string} 提醒正文（纯文本）
 */
function courseBody(list, lead) {
  const head = Number(lead) > 0 ? `【上课提醒】还有 ${Number(lead)} 分钟上课` : '【上课提醒】现在开始上课';
  const blocks = list.map((c) => {
    const lines = [`${periodText(c)} ${c.start_time || ''} 开始 ·《${c.name || '（未命名课程）'}》`];
    if (c.room) lines.push(`教室：${c.room}`);
    if (c.course_remark) lines.push(`【课程备注】${c.course_remark}`);
    // ⭐ 0.7.1：**本节备注** —— 只在「这一天这一节」有（`timetable_day_notes`），不会每周重复
    if (c.remark) lines.push(`【本节备注】${c.remark}`);
    return lines.join('\n');
  });
  return [head].concat(blocks).join('\n\n');
}

/**
 * 功能：拼「今天到期」提醒的正文 —— 每条一行，带上它属于哪个项目（与看板上看到的一致）。
 * @param {Array.<Object>} list - 今天到期的未完成任务
 * @returns {string} 提醒正文（纯文本）
 */
function taskTodayBody(list) {
  const lines = list.map((t) => `· ${t.name ? `[${t.name}] ` : ''}${t.title || '（未命名任务）'}`);
  return [`【任务提醒】今天到期 ${list.length} 件`, ...lines].join('\n');
}

/**
 * 功能：这条任务是不是**周期任务**（`task_kind === 'cycle'` 且有可解析的规则串）。
 *
 * 说明：⚠️ `recur_rule` 必须有内容才算 —— 只有 `task_kind` 是 `cycle` 而规则空的那种行，
 *      前端 `parseRule()` 解析不出来，各处都按普通任务处理（见 `public/core/recur.js`）。
 * @param {Object} t - 预筛给的任务行（`dashboard().tasks.items`）
 * @returns {boolean} 是周期任务为 true
 */
function isCycle(t) {
  return !!(t && t.task_kind === 'cycle' && t.recur_rule);
}

/**
 * 功能：这条周期任务**整个周期是不是已经过完了**（结束日当天就算过完）。
 *
 * ⭐⭐ 0.8.54（「周期任务的完成判定不对，当所有打卡都完成了还是逾期没有完成的状态，
 *    这个在提醒助手和首页看板中一直存在」）：
 *    ⚠️⭐ 从前这个文件里**一次都没提过「周期」** —— 两份一次性提醒（今天到期 / 逾期汇总）都只判
 *    `status !== 'done' && due_date < today`，而周期任务**永远不会**被写成 `status = 'done'`
 *    （它的勾选是「打卡本期」，不碰任务行）⇒ 打完卡、周期结束之后，每天仍然被拉进逾期汇总。
 *    ⇒ 这两条一次性提醒**整体不接周期任务**（理由见各自那段注释）；「按期提醒」是另一个功能。
 *    ⚠️ 判据与前端 `public/core/recur.js` 的 `cycleState().ended` **逐字同条件**
 *    （`结束日 <= 今天`）—— 那两份文件一个是 ESM、一个是 CJS，不能互相 require，
 *    所以这里是**有意**的第二处；改一处必须改另一处（`dashboard.js` 里也标了同一条）。
 * @param {Object} t - 任务行
 * @param {string} today - 基准日 `YYYY-MM-DD`（`dashboard()` 校准过的那个）
 * @returns {boolean} 周期已结束为 true
 */
function cycleEnded(t, today) {
  return isCycle(t) && !!t.due_date && String(t.due_date) <= today;
}

/**
 * 功能：拼「每日逾期汇总」的正文 —— 逾期最久的排最前（与看板 tier 的顺序一致）。
 *
 * 说明：⚠️ 天数用**两个日期字符串的序日差**算（`dateOrdinal`），不 `new Date()` 相减 ——
 *      夏令时 / 时区会让后者在某些日子差一天，而「逾期 1 天」写错比不写更伤信任。
 *
 * @param {Array.<Object>} list - 已逾期的未完成任务（调用方已按截止日升序排好）
 * @param {string} today - 今天 `YYYY-MM-DD`
 * @returns {string} 提醒正文（纯文本）
 */
function overdueBody(list, today) {
  const ordToday = dateOrdinal(today);
  const lines = list.map((t) => {
    const ord = dateOrdinal(String(t.due_date || ''));
    const days = ordToday === null || ord === null ? null : ordToday - ord;
    const when = days === null ? `截止 ${t.due_date}` : days <= 0 ? '今天到期' : `逾期 ${days} 天`;
    return `· 【${when}】${t.name ? `[${t.name}] ` : ''}${t.title || '（未命名任务）'}`;
  });
  return [`【逾期提醒】有 ${list.length} 件任务已经逾期，最久的排在最前`, ...lines].join('\n');
}

/**
 * 功能：⭐ **纯函数** —— 算出「这一分钟该发什么」（方案 §九-1：输入假 `now` 就能测，不许 sleep）。
 *
 * 说明：判据全部落在**入参**上，不碰时钟、不碰数据库：
 *      · 上课：`start_time − course_lead_minutes == now.time`（`start_time` 已含调课与假日前提前）；
 *      · 今天到期：`now.time == task_at` **且** `due_date == dashboard 给的今天` **且** 未完成；
 *      · 逾期汇总：`now.time == overdue_at` 且存在逾期未完成任务，**零条不发**（别每天发「没有逾期」）；
 *      · 课上完了的问候（0.6.4）：今天有课 **且** `now.time` 落在「最后一节课下课之后」的窗口内
 *        （`care_enabled` 关掉则完全不判）。
 *      ⚠️ 「今天」取自 `data.today`（= `dashboard()` 的 `today` 字段），**不在这里另算一个日期** ——
 *      这是「提醒分级与看板同源」那条硬约束的落点。
 *      ⚠️ 同一分钟里**同一种**提醒合并成一条（多条一起发会刷屏）；不同种类**不合并** ——
 *      它们是不同的事，挤进一个气泡反而看不清。
 *
 * @param {Object} now - `{ date, time, key }`（见 `nowOf()`）
 * @param {Object} data - `{ prefs, today, courses, tasks, trips }`：
 *      `prefs` 是 `store.teamworkReminderPrefs()` 的结果；`today` 是 `dashboard()` 给的今天；
 *      `courses` 是今天的课（`{ session_id, name, room, period_start, period_end, start_time, remark, course_remark }`）；
 *      `tasks` 是 `dashboard().tasks.items`（宽口径预筛结果）；
 *      `trips` 是 `store.tripReminderCandidates()` 给的**这一分钟该发的出发提醒**
 *      （形状 `{ stage, ref_keys: Array.<string>, fire_at, body }`；行程侧已判完，见第 ⑤ 组）
 * @returns {Array.<Object>} 待发清单：`{ kind, fireAt, refKeys, body }`（`refKeys` 是该消息的幂等记账键）
 */
function dueJobs(now, data) {
  const out = [];
  const prefs = (data && data.prefs) || {};
  // 总开关关掉 ⇒ 一条都不发（连判定都不做）
  if (!Number(prefs.enabled)) return out;
  const today = String((data && data.today) || now.date);
  const courses = (data && data.courses) || [];
  const tasks = (data && data.tasks) || [];

  // ① 上课提醒（含备注）
  const lead = Number(prefs.course_lead_minutes) || 0;
  const hit = courses.filter((c) => fireTimeOf(c.start_time, lead) === now.time);
  if (hit.length) {
    out.push({
      kind: KIND.course,
      fireAt: now.key,
      refKeys: hit.map((c) => `course:${today}:${Number(c.session_id)}`),
      body: courseBody(hit, lead),
    });
  }

  // ② 今天到期的任务（一次性汇总，既定的默认 20:00）
  if (String(prefs.task_at) === now.time) {
    // ⭐ 0.8.54：**周期任务不进这条**。它是「一天一条汇总」，而周期任务该按**每一期**提醒
    //    （哪一期该打卡了）；混进来只会出现那种情况 —— 全打卡了、周期也结束了，
    //    结束日当天仍被当成「今天到期」。⚠️「按期提醒」目前**没有实现**，已记进缺陷索引。
    const due = tasks.filter(
      (t) => t.status !== 'done' && !!t.due_date && t.due_date === today && !isCycle(t),
    );
    if (due.length) {
      out.push({
        kind: KIND.taskToday,
        fireAt: now.key,
        // ⚠️⭐ `ref_key` 里**必须带 `source`**：日常任务与项目任务是**两张表**，各自的 id
        //    从 1 开始自增 ⇒ 只写 `task:<id>` 会把「日常任务 1」与「某项目任务 1」判成同一件事，
        //    撞唯一键的第二条**记不上账**（静默）。⚠️ 实测口径：今天不至于漏发 ——
        //    本组只要有**一条**键记上就发消息、正文来自整份 `due`，所以两条都在正文里；
        //    但流水因此少一行（它不再是「这件事响过」的可靠凭据），等「每条任务单独一条提醒」
        //    立项时会**真的漏发且不报错**。
        refKeys: due.map((t) => `task:${t.source}:${Number(t.id)}`),
        body: taskTodayBody(due),
      });
    }
  }

  // ③ 每日逾期汇总（默认早上 07:00；**零条不发**）
  if (String(prefs.overdue_at) === now.time) {
    const late = tasks
      // ⭐ 0.8.54：**已结束的周期任务不算逾期**（它已经打完卡了，只是 `status` 永远停在 todo）——
      //    这正是「提醒助手每天早上都报一遍」的来源。⚠️ 还没结束的周期任务也不会漏：
      //    它的 `due_date`（= 整个周期的结束日）还没到，本来就不该报。
      .filter((t) => t.status !== 'done' && !!t.due_date && t.due_date < today && !cycleEnded(t, today))
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)) || Number(a.id) - Number(b.id));
    if (late.length) {
      out.push({
        kind: KIND.overdue,
        fireAt: now.key,
        // ⭐ 逾期汇总是**一条汇总消息** ⇒ 一个记账键（按天）—— 与「每条任务一个键」的另外两类不同
        refKeys: [`overdue:${today}`],
        body: overdueBody(late, today),
      });
    }
  }

  // ④ 课上完了的一句问候（0.6.4「增加人文关怀消息」）
  //    ⭐ 判据：**今天有课**，且现在落在「最后一节课下课之后」的窗口内（见 `CARE_WINDOW_MIN`）。
  //    ⚠️「最后一节」按 `end_time` 取最大 —— 调课 / 停课 / 假期调休**都已经在 `data.courses` 里
  //    算好了**（那是 `dashboard()` 那一份），这里不重新判课表：两处口径必然分叉。
  //    ⚠️⭐ 记账键的 `fire_at` 用**下课时刻**、不用 `now.key`：窗口内每一分钟都会命中这一条，
  //    只有把它钉死成同一个值，`UNIQUE(user_id, kind, ref_key, fire_at)` 才挡得住第二、第三次
  //    （否则一天会连着发出好几条「辛苦啦」）。`ref_key` 里带日期 ⇒ 第二天是新的一条。
  //    ⚠️ 没课的日子一条都不发（`courses` 为空 ⇒ `last` 为 null）。
  if (Number(prefs.care_enabled)) {
    const last = courses.reduce((a, c) => (!a || String(c.end_time || '') > String(a.end_time || '') ? c : a), null);
    const end = last ? toMinutes(last.end_time) : -1;
    const nowMin = toMinutes(now.time);
    if (end >= 0 && nowMin >= end && nowMin < end + CARE_WINDOW_MIN) {
      out.push({
        kind: KIND.care,
        fireAt: `${today} ${last.end_time}`,
        refKeys: [`care:${today}`],
        body: careBody(today),
      });
    }
  }

  // ⑤ 出发提醒（⭐ 0.8.6）：把**行程侧算好的**候选原样展开。
  //    ⭐⭐ **这一组一行算术都不做** —— 「哪一档、该在那一分钟发、正文是什么」全部由
  //    `store.tripReminderCandidates(uid, now.key)` 判定（它住在行程模块里，三档算术只有那一份）。
  //    ⛔ 别在这里按 `depart_at` 再判一遍：那会变成第二份口径，
  //    而且两份迟早分叉成「有的票早发一分钟、有的晚发一分钟」，谁都不会报错。
  //    ⚠️⭐ `ref_keys` 是**数组**（每一个 (票, 档位) 一个键）—— 同一分钟多张票时，
  //    「只要有**一条**键记上账就发、全记过就跳过」这条既有语义（`fireGroup`）自动成立。
  //    ⚠️⭐ **没有记账键的候选一律不发**：`fireGroup` 靠键去重，键为空 ⇒ 每分钟都会重发
  //    （一场刷屏）。这一条是**故意**写成「不发」而不是「随便补一个键」——
  //    补出来的键（比如 `'undefined'`）会让**所有**没有键的候选共用同一个幂等键，
  //    表现是「第一张票发了，其余的永远不发」而且不报错。
  for (const t of (data && data.trips) || []) {
    const keys = Array.isArray(t && t.ref_keys) ? t.ref_keys.map((k) => String(k)) : [];
    if (!keys.length) continue;
    out.push({ kind: KIND.trip, fireAt: now.key, refKeys: keys, body: String(t.body || '') });
  }

  return out;
}

/**
 * 功能：判断课表模块现在**真的能用吗**（`store` 上那几个方法在不在）。
 *
 * 说明：⭐ 判据与 `core/store/methods/stats.js` 的 `usable()` 同一条：课表是**可以被整目录删掉**
 *      的模块，删掉之后 `store.scheduleOf` / `store.listPeriods` 在原型上根本不存在，
 *      硬调就是 `is not a function`，而那是**后台定时器**里抛出来的 —— 表现是「提醒从此一条都不发」
 *      且很难查到原因。⚠️ 只探**课表独有的**业务方法名，别用 `list` / `get` 这类通用名。
 *
 * @param {Object} store - Store 实例
 * @returns {boolean} 可用为 true
 */
function timetableUsable(store) {
  return typeof store.getTerm === 'function' && typeof store.listPeriods === 'function';
}

/**
 * 功能：判断行程模块现在**真的能用吗**（那个公开读方法在不在）。
 *
 * 说明：⭐ 与 `timetableUsable()` 逐字同一条理由：行程可以被**整目录删掉**，
 *      删掉之后 `store.tripReminderCandidates` 在原型上根本不存在，硬调就是 `is not a function`，
 *      而那是**后台定时器**里抛出来的 —— 表现是「这个账号所有提醒从此一条都不发」且很难查。
 *      ⚠️ 探的是**行程独有的**方法名（`tripReminderCandidates`），⛔ 不用 `list` / `get` 这类通用名
 *      —— 通用名迟早被别家占用，守卫会**静默失效**。
 *
 * @param {Object} store - Store 实例
 * @returns {boolean} 可用为 true
 */
function tripUsable(store) {
  return typeof store.tripReminderCandidates === 'function';
}

/**
 * 功能：取「这一分钟该发的出发提醒」—— 拿不到（模块被删 / 取数出错）就回**空数组**。
 *
 * 说明：⚠️⭐ 出错的失败方向是**少发**而不是**崩**：行程侧取数失败绝不该拖垮这个账号
 *      课程与任务的提醒（那些是这一拍里独立的组）。但**必须记一行日志**（
 *      降级与失败都要「响」）—— 而日志里**只记账号与原因，⛔ 不记车次与站名**（方案 §8.4）。
 *
 * @param {Object} store - Store 实例
 * @param {number} uid - 账号 id
 * @param {Object} now - `{ date, time, key }`
 * @returns {Array.<Object>} 候选数组（每项 `{ stage, ref_key, fire_at, body }`）
 */
function tripCandidates(store, uid, now) {
  if (!tripUsable(store)) return [];
  try {
    const list = store.tripReminderCandidates(uid, now.key);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    const say = log();
    if (typeof say === 'function') {
      say('warn', `[提醒] 账号 ${uid} 的行程提醒取数失败（本组跳过，其它提醒照常）：${(e && e.message) || String(e)}`);
    }
    return [];
  }
}

/**
 * 功能：取**假日口径**（放假 / 假前一天下午提前）；拿不到时返回 null。
 *
 * 说明：⭐ 这里刻意用**函数内的 `require` + try/catch**，而不是模块顶层的 `require`：
 *      顶层硬 require 一个「随时可能被删掉的模块目录里的文件」，在删目录验收时会抛
 *      `MODULE_NOT_FOUND`，而本文件是被 `server.js` 的可选钩子加载的 ⇒ **应用直接起不来**
 *      （验收第 ① 条当场失败）。拿不到就返回 null，课程提醒退化成「不判假日」而不是崩掉。
 *      ⚠️ 0.7.2 起它在 `core/`（不再住在会被整目录删掉的模块里），这个兜底**已不是必需的**；
 *      保留它、连同调用处的判空，是为了不动「拿不到就走退化路径」这条既有契约（改动最小）。
 *
 * @returns {?Object} `core/timetable/holiday-util.js` 的导出；拿不到时为 null
 */
function holidayUtil() {
  try {
    // 见函数说明：故意延迟到运行时、且失败要能兜住
    return require('../../core/timetable/holiday-util.js');
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：取**今天要在提醒里出现的课** —— 复用看板的课程展开，再补上「放假 / 假日前提前」这一层。
 *
 * 说明：⭐ 基准数据来自 `dashboard().courses`（`core/store/methods/stats.js` 的 `courseItems`）：
 *      周次筛选、单次调课 / 停课合并、课程配色、两种备注**都已经在那一份里做过**，
 *      ⛔ 这里不许再写一遍（另写一份的后果是「课表页有这节、提醒里没有」，而且不报错）。
 *      本函数只补两件**看板不管**的事（它们只在「今天要不要提醒」这个语境下才有意义）：
 *      ① 放假不发—— 休息日整天一条都不发；
 *      ② 假前一天下午提前—— 学期里配了提前量、且今天是「上课日 + 次日休息」时，
 *         下午的节次整体前移，**提醒时刻跟着走**（否则提醒会在已经上完课之后才响）。
 *
 * @param {Object} store - Store 实例
 * @param {number} uid - 账号 id
 * @param {string} date - 今天 `YYYY-MM-DD`
 * @param {Object} dash - `store.dashboard(uid, { from: date, to: date })` 的结果
 * @returns {Array.<Object>} 今天的课程条目（`start_time` 已按假日前提前修正）
 */
function courseToday(store, uid, date, dash) {
  const items = ((dash && dash.courses) || []).slice();
  if (!items.length) return [];
  const hu = holidayUtil();
  if (!hu) return items; // 课表模块被删 ⇒ 不判假日，但课（如果还有）照发
  if (hu.isRestDay(date)) return []; // 放假 / 周末：今天没有课要提醒
  if (!timetableUsable(store) || !dash.course_term) return items;
  const term = store.getTerm(uid, dash.course_term.id);
  const plan = hu.planOf(term);
  if (!plan.enabled || !hu.isPreHoliday(date)) return items;
  // 只在这一天真的「假日前」时才偏移 —— 偏移后的时刻按 `period_start` 查表，逐节取用。
  const shifted = new Map(
    hu
      .shiftPeriods(store.listPeriods(uid, dash.course_term.id), plan.advance_minutes, plan.pm_from)
      .map((p) => [Number(p.index_no), p.start_time]),
  );
  return items.map((c) => {
    const t = shifted.get(Number(c.period_start));
    return t ? Object.assign({}, c, { start_time: t }) : c;
  });
}

/**
 * 功能：为一个账号取齐「这一分钟判定所需的一切」—— 总开关关掉时直接返回 null（连数据都不取）。
 *
 * 说明：⚠️ `dashboard()` 是**首屏那一条路上**的方法，也是任务与课程两份数据的**唯一合法来源**：
 *      它自带「模块被删 / 账号关掉该模块」的守卫（/5b 的教训），这里再包一层 try/catch
 *      只是为了不让一个账号的异常拖垮整轮。
 *      ⚠️ 代价：每分钟、每个账号都会走一次 `dashboard()`（十来个查询）。在这个应用的量级上
 *      （一台 NAS、个位数账号、几百条任务、进程内 SQLite）完全可以接受；**刻意不做**「先猜这一分钟
 *      可能响不响、再决定要不要取数」的省法 —— 要猜就必须自己算一遍「今天哪几节几点开始」，
 *      那正好是 明令禁止的**第二套课程口径**（省下的是微秒，换来的是两套判据）。
 *
 * @param {Object} store - Store 实例
 * @param {number} uid - 账号 id
 * @param {Object} now - `{ date, time, key }`
 * @returns {?Object} `{ prefs, today, courses, tasks }`；总开关关掉或数据取不到时为 null
 */
function collect(store, uid, now) {
  const prefs = store.teamworkReminderPrefs(uid);
  if (!Number(prefs.enabled)) return null;
  if (typeof store.dashboard !== 'function') return null;
  const dash = store.dashboard(uid, { from: now.date, to: now.date });
  if (!dash) return null;
  return {
    prefs,
    today: String(dash.today || now.date),
    courses: courseToday(store, uid, now.date, dash),
    tasks: (dash.tasks && dash.tasks.items) || [],
    // ⭐ 0.8.6：行程那一侧自己按「未来 3 天 + 1 分钟」扫（判据住行程模块，见 `dueJobs` 第 ⑤ 组）
    trips: tripCandidates(store, uid, now),
  };
}

/**
 * 功能：把一组待发项**发出去** —— ⭐ **先插记账、再发消息**（顺序不能反）。
 *
 * 说明：⭐ 返回 null 的 `teamworkRecordReminder()` = 这个时刻已经记过账（撞唯一键）⇒ 当场跳过。
 *      一组里只要**有至少一条**是新记的账，就把这条消息发出去（同分钟的同类提醒本来就是一条）；
 *      全组都已记过账 ⇒ 整组跳过，一个字节都不写。
 *      ⚠️ 消息正文由**已记过账的那些**决定（不是重新拼一遍）：`body` 在 `dueJobs()` 里一次拼好，
 *      这里只负责写库与推送 —— 免得两处各拼一份、拼出两个版本。
 *
 * @param {Object} store - Store 实例
 * @param {number} uid - 收件账号 id
 * @param {Object} group - `dueJobs()` 的一项 `{ kind, fireAt, refKeys, body }`
 * @param {?Function} [push] - 推送实现覆盖（测试缝，见 `runOnce`）；省略时用 `pushMessage()`
 * @returns {?Object} 发出的消息 `{ id, conversationId, createdAt, body, senderBuiltin }`；跳过时为 null
 */
function fireGroup(store, uid, group, push) {
  const stamp = nowStamp();
  let fresh = 0;
  for (const ref of group.refKeys) {
    if (store.teamworkRecordReminder(uid, group.kind, ref, group.fireAt, stamp, stamp)) fresh += 1;
  }
  if (!fresh) return null;
  // ⭐ 0.7.7：把这一组映射成一种**卡片**（`MSG_KIND`，映射表只此一处）⇒ 四种提醒各有各的样式
  const msg = store.teamworkSendBuiltinMessage(uid, group.body, MSG_KIND[group.kind] || null);
  if (!msg) return null; // 只读降级等：账记了但发不出去，下一拍不会再发（不补）—— 如实记日志
  const payload = {
    id: msg.id,
    conversationId: msg.conversationId,
    body: group.body,
    senderBuiltin: BUILTIN_KEY,
    // ⚠️ 帧里**必须带 kind**：少了它，实时到达的那条会被画成普通气泡，
    //    直到刷新走 REST 才变回卡片（典型的「刷新一下就好了」，见 `notify.js` 的同一条理由）
    kind: msg.kind,
    createdAt: msg.createdAt,
  };
  // ⚠️ 推送**只发给收件人自己**（内置会话里只有他一个成员）—— `pushTeamworkMessage` 按
  //    `teamworkMemberIds()` 算收件人，所以这里传的 `senderId` 与收件人是同一个账号。
  //    它要的是「别的设备上的同一个人也立刻看得到」（多端一致），不是「别人也看得到」。
  (push || pushMessage)(payload, uid);
  return payload;
}

/**
 * 功能：把消息推给该会话的成员 —— ⭐ 与 `routes.js` / `notify.js` **共用同一份实现**。
 *
 * 说明：⚠️ 这里用**函数内 require** 而不是顶层 `require('./notify.js')`：`notify.js` 会
 *      require `core/context.js`（为了 `teamworkMemberIds`），而本文件是被 `server.js` 的
 *      可选钩子加载的 —— 顶层引入会把加载时序钉死。放在函数里，时序就由「真的要用」决定。
 *
 * @param {Object} msg - `{ id, conversationId, body, senderBuiltin, createdAt }`
 * @param {number} toUid - 收件账号 id
 * @returns {number} 推送到的连接数
 */
function pushMessage(msg, toUid) {
  // 见函数说明（延迟到运行时，避开加载时序）
  const { pushTeamworkMessage } = require('./notify.js');
  return pushTeamworkMessage(msg, toUid);
}

/**
 * 功能：取日志口 —— `core/context.js` 的 `logLine`（同样用函数内 require 避开加载时序）。
 * @returns {Function} `(level, msg) => void`；拿不到时退化成空函数（**绝不因为日志而抛**）
 */
function log() {
  try {
    // 见函数说明：延迟到运行时，日志失败绝不拖垮提醒
    return require('../../core/context.js').logLine;
  } catch (_e) {
    return () => {};
  }
}

/**
 * 功能：取全部账号 id —— 提醒是「发给账号」的，而 `store.listUsers()` 是**唯一**能列出全部账号
 *      的业务方法（只取 id，不碰任何任务数据，所以与「管理员看不到成员任务」那条规矩无关）。
 *
 * 说明：⚠️ 取不到时返回 **null**（而不是空数组）：空数组的意思是「这台 NAS 上一个账号都没有」，
 *      那是个**完全正常**的状态（全新安装），不该报警；取不到则是故障，必须说出来。
 *      ⚠️ 写成独立函数是为了让调用方的 `let users = []` 那种「先给个初值、再在 try 里覆盖」
 *      的写法消失 —— 那种写法在 lint 里是 `no-useless-assignment`，而且初值其实从没被用过。
 *
 * @param {Object} store - Store 实例
 * @returns {?Array.<Object>} 账号行数组；取不到时为 null
 */
function accountsOf(store) {
  try {
    return store.listUsers() || [];
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：跑**一拍** —— 逐账号算、逐账号发，**一个账号出错不影响别人**。
 *
 * 说明：⭐ 本函数是**可注入**的（`store` 与 `now` 都从参数进来），所以测试可以拿假时间 +
 *      真 store 跑一遍完整链路，**不用 sleep、不用等真实时钟**。
 *      ⚠️ `deps` 是**测试缝**：`say`（日志）与 `push`（SSE 推送）默认的实现都要
 *      `require('core/context.js')` —— 那个模块**在被 require 的那一刻就会建一个数据目录与库**
 *      （见它的文件头）。测试里直接 require 它会在仓库里凭空造出一个 `var/`，所以这两件事
 *      必须能被替换掉，而不是「测一次就污染一次工作区」。
 *      ⛔ 生产代码里 `start()` **不传** `deps`（走真实实现）。
 *
 * @param {Object} store - Store 实例
 * @param {Object} now - `{ date, time, key }`
 * @param {{say?: Function, push?: Function}} [deps] - 测试缝（日志口 / 推送口）
 * @returns {{accounts: number, sent: number, errors: number}} 本拍的结果统计（给日志与测试用）
 */
function runOnce(store, now, deps) {
  const say = (deps && deps.say) || log();
  const push = (deps && deps.push) || null;
  const stat = { accounts: 0, sent: 0, errors: 0 };
  const users = accountsOf(store);
  if (!users) {
    say('error', '[提醒] 取账号清单失败，本拍跳过');
    stat.errors += 1;
    return stat;
  }
  // ⭐ 每天 `PURGE_AT` 顺带清一次 90 天前的流水（**一个进程动作，不属于任何账号**）。
  //    流水是运行态数据（不进个人备份），它的唯一用处是「这个时刻响过没有」——
  //    90 天前的记账再也不会被任何判据读到，不清就是一张只涨不缩的表。
  //    ⚠️ 幂等且代价极小（一条带索引的 DELETE），所以不必记「今天清过没有」。
  if (now.time === PURGE_AT) {
    try {
      const cutoff = `${addDays(now.date, -REMINDER_KEEP_DAYS)} 00:00:00`;
      const n = store.teamworkPurgeReminders(cutoff);
      if (n) say('info', `[提醒] 已清理 ${n} 条 ${REMINDER_KEEP_DAYS} 天前的提醒流水`);
    } catch (e) {
      say('warn', `[提醒] 清理旧提醒流水失败（不影响发提醒）：${(e && e.message) || String(e)}`);
    }
  }
  for (const u of users) {
    const uid = Number(u && u.id);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    stat.accounts += 1;
    // ⚠️ 逐账号 try/catch：一个账号的数据有问题（老库脏数据 / 课表模块被删…）绝不能让
    //    其余账号这一分钟的提醒一起消失 —— 而那种「一起消失」是**完全静默**的。
    try {
      const data = collect(store, uid, now);
      if (!data) continue;
      for (const group of dueJobs(now, data)) {
        const sent = fireGroup(store, uid, group, push);
        if (sent) {
          stat.sent += 1;
          // ⚠️ 日志里**只记动作与类别，不记正文**：提醒正文含课程名与任务标题（用户的私事），
          //    与「标签名绝不进日志」是同一条规矩（方案 §八）。
          say('info', `[提醒] 账号 ${uid} 发出 ${group.kind}（记账 ${group.refKeys.length} 条，${group.fireAt}）`);
        }
      }
    } catch (e) {
      stat.errors += 1;
      say('error', `[提醒] 账号 ${uid} 这一拍出错（已隔离，不影响别人）：${(e && e.message) || String(e)}`);
    }
  }
  return stat;
}

/**
 * 功能：启动时报告一次「今天已经过去的提醒时刻」—— ⛔ **只报告，不补发**。
 *
 * 说明：⭐ 这一行的存在是为了让「停机跨过的提醒没补」这件事**看得见**：
 *      否则用户只会觉得「提醒有时灵有时不灵」，而日志里一个字都没有。
 *      ⚠️ 只在进程启动后跑一次（`missedReported` 闸门）：每分钟都报一遍等于把日志淹掉。
 *
 * @param {Object} store - Store 实例
 * @param {Object} now - `{ date, time, key }`
 * @param {?Function} [say] - 日志口覆盖（测试缝，理由见 `runOnce`）
 * @returns {number} 报出「今天已过去」的提醒时刻个数（给测试与日志用）
 */
function reportMissed(store, now, say) {
  if (missedReported) return 0;
  missedReported = true;
  const logger = say || log();
  const users = accountsOf(store);
  if (!users) return 0;
  let missed = 0;
  for (const u of users) {
    const uid = Number(u && u.id);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    try {
      const data = collect(store, uid, now);
      if (!data) continue;
      const lead = Number(data.prefs.course_lead_minutes) || 0;
      const times = data.courses.map((c) => fireTimeOf(c.start_time, lead));
      times.push(String(data.prefs.task_at || ''), String(data.prefs.overdue_at || ''));
      const past = times.filter((t) => t && t < now.time).length;
      if (past) missed += past;
    } catch (_e) {
      /* 报告失败绝不值得打断启动 —— 它只是日志 */
    }
  }
  if (missed) {
    logger('info', `[提醒] 今天已有 ${missed} 个提醒时刻过去 —— 按设计**不补发**（停机跨过的提醒不补、当日已过时刻不补）`);
  }
  return missed;
}

/**
 * 功能：启动后台提醒 —— ⭐ 由 `core/server.js` 的**可选钩子**调用（模块被删掉时它根本不会被调用）。
 *
 * 说明：⚠️ 幂等（重复调用只留一个定时器）、⚠️ 定时器 `.unref()`（不阻止进程退出）。
 *      启动后的第一拍**立刻**跑一次（不是等满 60 秒）：否则在整分钟前启动的服务会整整
 *      晚一分钟才发第一条 —— 而「该响的时候响」正是这个功能的命门。
 *
 * @returns {void}
 */
function start() {
  if (timer) return;
  const say = log();
  // 见文件头：延迟到运行时，避开加载时序
  const { store } = require('../../core/context.js');
  const first = nowOf();
  try {
    reportMissed(store, first, say);
  } catch (_e) {
    /* 只报告，失败不影响启动 */
  }
  runOnce(store, first, { say });
  timer = setInterval(() => {
    try {
      runOnce(store, nowOf(), { say });
    } catch (e) {
      // ⚠️ 兜底：`runOnce` 自己已经逐账号隔离过，能逃到这里的是「连账号清单都取不到」那类故障。
      //    打死也不能让一个异常把定时器掀掉 —— 定时器一断，提醒就**永远不会再响**（且静默）。
      say('error', `[提醒] 这一拍整体失败（定时器继续运行）：${(e && e.message) || String(e)}`);
    }
  }, TICK_MS);
  timer.unref();
  say('info', `[提醒] 后台提醒已启动：每 ${TICK_MS / 1000} 秒检查一次（停机跨过的提醒按设计不补发）`);
}

/**
 * 功能：停掉后台提醒（清定时器 + 复位一次性闸门）—— 给测试与优雅停机用。
 * @returns {void}
 */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  missedReported = false;
}

module.exports = {
  TICK_MS,
  REMINDER_KEEP_DAYS,
  PURGE_AT,
  KIND,
  MSG_KIND,
  nowOf,
  fireTimeOf,
  dueJobs,
  runOnce,
  start,
  stop,
};
