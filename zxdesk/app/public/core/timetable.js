/**
 * core/timetable.js —— 课表的共用格式化与「现在」判定（两端唯一一份）
 *
 * 功能：分四块 ——
 *      ① `ttPeriodTag()` 把起止节次写成课条上那枚短标签（`[01-02]` / `[03]`）；
 *      ② ⭐ 课表 2 期的**实时状态判定**（`ttLessonState` / `ttTodayNow` / `ttCellSpans` / `ttDayLessons`）：
 *         「这节课什么状态、还有多久下课、课间剩多久」**全项目只在这里算一份**，
 *         课表页（两端）与首页看板（两端）都调它 —— 各写一遍的后果是同一节课在两处文案不一样，
 *         而且不报任何错（方案 `docs/公共/开发方案/13-课表2期-实时倒计时与看板联动.md` §三-D1）；
 *      ③ ⭐ **时间权威源**（`ttSyncServerNow` / `ttNowHM`）：服务端在既有响应里搭车给 `now`，
 *         前端记下「本机时钟 − 服务端时钟」的偏移，之后一律用偏移换算 ——
 *         手机时钟不准时倒计时照旧是对的（同方案 §三-D2）；
 *      ④ `ttTicker()` —— **全端唯一一个**倒计时定时器（60 秒一拍；屏可见才跑、切走即停、
 *         同一时刻至多一个，两屏来回切不会叠加）。
 *
 * ⭐ 纪律：判定函数全是**纯函数** —— `nowHM` 当参数传，函数体**不许读 `Date.now()`**
 *    （只有 ②③ 的时间换算块例外），这样 `node:test` 用假时间就能把边界全测掉，不用 sleep。
 *
 * ⭐ 为什么放在 `core/`：「每节课显示上课节次，如图所示」，
 *    而**同一门课在电脑版课条、电脑版格子、手机版课条、手机版整周格子上都要写成一个样子**——
 *    四处各写一遍 `padStart` 的后果不是报错，是同一节课在两个端上长得不一样（很难被当成 bug 报上来）。
 *    实时判定是同一个道理的更贵版本：判错的是「这节课还有多久」，错了就是误课。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.52
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/13-课表2期-实时倒计时与看板联动.md
 */

/**
 * 功能：把起止节次写成短标签 —— 连堂写 `[01-02]`，单节写 `[03]`；读不出节次时返回空串。
 *
 * 说明：⭐ 两位数补零是**照给的那张图**定的（`[01-02]` 而不是 `[1-2]`）：课条窄，
 *      定宽的数字排在一起才好看；而且上午第 1 节与下午第 10 节在视觉上不会串位。
 *      返回空串而不是 `[–]`：读不出节次的老数据宁可什么都不显示，也不显示一个假区间。
 *
 * @param {number} ps - 起始节次
 * @param {number} [pe] - 结束节次；与起始相同（或缺失 / 非法）时只写一节
 * @returns {string} 形如 `[01-02]` / `[03]`；起始节次非法时为空串
 */
export function ttPeriodTag(ps, pe) {
  const a = Number(ps);
  if (!Number.isFinite(a) || a < 1) return '';
  const p = (n) => String(n).padStart(2, '0');
  const b = Number(pe);
  return !Number.isFinite(b) || b === a ? `[${p(a)}]` : `[${p(a)}-${p(b)}]`;
}

// ---------- 时刻解析（本文件唯一的时间底层） ----------

/**
 * 功能：把 `HH:MM` 解析成「当天第几分钟」；解析不了返回 null。
 *
 * 说明：⭐ 判定的所有边界（开始前 / 正上 / 刚下课）都比的是这个整数，
 *      字符串比较（`'09:05' <= '10:00'`）虽然碰巧也对，但 `'9:05'` 这种不补零的脏数据会串位
 *      —— 统一走这里，脏数据在入口处就变成「不显示倒计时」（失败方向安全）。
 *
 * @param {string} hm - 形如 `09:05` 的时刻
 * @returns {?number} 当天第几分钟；格式不合法时为 null
 */
function ttToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm == null ? '' : hm));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 功能：把「当天第几分钟」写回 `HH:MM`（两位补零）。
 * @param {number} m - 当天第几分钟
 * @returns {string} 形如 `09:05`；负数按 0 算（提前量再大也不该算到昨天去）
 */
function ttFmtMin(m) {
  const t = Math.max(0, Math.round(Number(m) || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * 功能：把一条课的起止时间按「假前一天下午提前」整体前移 —— **只动下午的节次**（0.7.2）。
 *
 * 说明：⭐ 这是服务端 `core/timetable/holiday-util.js` 的 `shiftPeriods()` 的**前端一份**，
 *      两份的判据必须逐字一致（起始时刻早于下午起点 ⇒ 不动；否则前移 N 分钟）。
 *      ⚠️ 它是「假前一天下午提前」这条链上唯一的分叉点，所以两边都用注释互相钉住；
 *      只改一边的后果是「课表页说还有 35 分钟、看板说 5 分钟」，而且不报任何错。
 *      ⭐ 为什么前端要有这一份：看板的课程是**按天展开**的（一天一条、各带各的时间），
 *      而服务端那个 `periods` 是**整个学期**一张表、按天不同没法表达 —— 逐条决定正好落在前端。
 *      ⚠️ `spans`（格内逐节明细）**必须一起偏移**：它喂给 `ttTodayNow()` 算「课间还剩多久」，
 *      漏掉它会出现「倒计时是对的、课间文案是错的」。
 *      ⚠️ `advance <= 0`、或 `pmFrom` 解析不出来 ⇒ **原样返回** + `shifted: false`（不猜）。
 *
 * @param {Object} x - 一条课程条目（读 `start_time` / `end_time` / `spans`）
 * @param {number} advance - 提前的分钟数（0 = 不启用该功能）
 * @param {string} pmFrom - 几点之后算下午（`HH:MM`）
 * @returns {{start_time: string, end_time: string, spans: Array.<Object>, shifted: boolean}}
 *      偏移后的起止与逐节明细（可直接覆盖原条目）；`shifted` 供界面标注「已提前」
 */
export function ttShiftTimes(x, advance, pmFrom) {
  const src = x || {};
  const spans = src.spans || [];
  const n = Number(advance) || 0;
  const from = ttToMin(pmFrom);
  if (n <= 0 || from === null) {
    return { start_time: src.start_time || '', end_time: src.end_time || '', spans, shifted: false };
  }

  /**
   * 功能：偏移单个起止对。
   * @param {string} s - 起始 `HH:MM`
   * @param {string} e - 结束 `HH:MM`
   * @returns {{s: string, e: string, on: boolean}} 偏移后的起止与「这一节到底动没动」
   */
  const one = (s, e) => {
    const st = ttToMin(s);
    // ⚠️ 上午（起始早于下午起点）**一节都不动** —— 学校的安排就是「上午照常、下午提前」
    if (st === null || st < from) return { s: s || '', e: e || '', on: false };
    const et = ttToMin(e);
    return { s: ttFmtMin(st - n), e: et === null ? e || '' : ttFmtMin(et - n), on: true };
  };
  const head = one(src.start_time, src.end_time);
  return {
    start_time: head.s,
    end_time: head.e,
    spans: spans.map((sp) => {
      const r = one(sp && sp.start_time, sp && sp.end_time);
      return { start_time: r.s, end_time: r.e };
    }),
    shifted: head.on,
  };
}

/**
 * 功能：算「**某一天**实际生效的逐节时间」—— 假前一天下午提前时给出前移后的那一份（0.7.2）。
 *
 * 说明：⭐ 为什么必须是「按天」而不是改学期作息：`sch.periods` 是**整个学期一张表**
 *      （`timetable_periods` 只有 `term_id` + `index_no`，没有日期维度），
 *      而「提前」只作用于**某几天** —— 把整张表改了就变成所有天都提前。
 *      ⚠️ 判定**不由这里推**：它读的是服务端下发的 `day.pre_holiday`（这一天是不是假前一天）
 *      与 `plan`（`{enabled, advance_minutes, pm_from}`），前端只负责**应用**。
 *      ⚠️ 不需要提前时**原样返回入参**（同一个数组），别白白复制一份。
 *
 * @param {Array.<Object>} periods - 学期逐节时间表（`sch.periods`）
 * @param {?Object} day - 这一天的信息（`sch.days` 里那一项，读 `pre_holiday`）
 * @param {?Object} plan - 假日口径（`sch.holiday`，读 `enabled` / `advance_minutes` / `pm_from`）
 * @returns {Array.<Object>} 这一天的逐节时间表
 */
export function ttPeriodsOn(periods, day, plan) {
  const list = periods || [];
  if (!day || !day.pre_holiday || !plan || !plan.enabled) return list;
  return list.map((p) => {
    const r = ttShiftTimes(p, plan.advance_minutes, plan.pm_from);
    return Object.assign({}, p, { start_time: r.start_time, end_time: r.end_time });
  });
}

/**
 * 功能：从课表快照里取「**正看着的那一天**」的逐节时间（0.7.2）。
 *
 * 说明：⭐ 两端课表页与共享判定（`ttDayLessons`）都走这一个入口 ——
 *      「哪一天是假前一天」在 `sch.days` 里、提前量在 `sch.holiday` 里，两者都是服务端给的，
 *      所以这里**不需要任何额外参数**，签名与调用方一行都不用改。
 * @param {?Object} sch - 课表快照（`/api/timetable/.../schedule` 的响应）
 * @param {number} weekday - 星期几（1~7）
 * @returns {Array.<Object>} 这一天的逐节时间表（不是假前一天时就是学期那一份）
 */
export function ttDayPeriods(sch, weekday) {
  const wd = Number(weekday);
  const day = ((sch && sch.days) || []).find((d) => Number(d.weekday) === wd) || null;
  return ttPeriodsOn(sch && sch.periods, day, sch && sch.holiday);
}

// ---------- ② 「现在」：服务端时间 + 本机偏移 ----------

/**
 * 本机时钟相对服务端时钟的偏移（毫秒）：`Date.now() − serverNowMs`。
 * 服务端还没给过 `now` 时为 0（＝退回用本机时钟，总比不显示好）。
 * @type {number}
 */
let ttServerOffsetMs = 0;

/**
 * 上一次校准用的服务端快照指纹（`date hm`）—— **同一份快照只校准一次**。
 * ⭐ 0.6.1：挡掉「倒计时被自己钉死」那个坑，见 `ttSyncServerNow` 的说明。
 * @type {string}
 */
let ttSyncKey = '';

/**
 * 功能：记下服务端的「现在」—— 之后所有倒计时都以它为基准换算。
 *
 * 说明：⭐ 时间权威源 = **服务端**：手机时钟被拨快 / 时区不对时，
 *      直接用本机时间算「还有几分钟下课」就会静默算错 = 误课。
 *      前端只记一次偏移（`Date.now() − serverNowMs`），之后每一拍都用
 *      `Date.now() − 偏移` 还原服务端的钟 —— 偏移是常数，服务端不用反复问。
 *      ⚠️ `now` 缺字段 / 解析不了时**原样忽略**（偏移保持旧值），绝不抛错
 *      —— 时间同步失败不该把界面搞挂。
 *      ⚠️⭐ 0.6.1：**同一份快照不重复校准**（指纹判重）—— 重复调只会白算，
 *      还会把界面上的「现在」钉死在快照时刻（就是「倒计时不刷新」那个bug）。
 *
 * @param {?{date: string, hm: string}} now - 服务端当前时刻（课表 / 看板响应里搭车的 `now`）
 * @returns {void}
 */
export function ttSyncServerNow(now) {
  if (!now || !now.date || !now.hm) return;
  // ⚠️⭐ 0.6.1（报「倒计时不刷新、手动刷新才变」）：**同一份快照不重算偏移**。
  //    倒计时屏的 tick 是 60 秒一拍，手里只有响应里那一份 `now`（不会变）—— 从前每拍都重算，于是
  //    `Date.now() − 偏移` 恒等于**快照时刻**，界面上的「现在」被自己钉死在打开页面那一刻
  //    （倒计时一动不动，连「上完变灰」也跟着冻）。偏移本就是常数 ⇒ 用指纹挡掉。
  const key = `${now.date} ${now.hm}`;
  if (key === ttSyncKey) return;
  // 无时区后缀的日期时间串按**本地时区**解析（ES2015+ 的规定行为，Node 与浏览器一致）：
  // 服务端的 `HH:MM` 就是给「同地使用者」看的墙上时间，按本机时区解读正是我们要的。
  const ms = Date.parse(`${now.date}T${now.hm}:00`);
  if (Number.isFinite(ms)) {
    // ⚠️⭐ 0.6.1（报「倒计时有半分钟左右延迟」）：**本机时刻也要截到整分钟**再相减。
    //    服务端给的 `hm` 只有分钟（`nowInfo()` 返回的就是 `HH:MM`，秒数在上游就没了）——
    //    拿「带秒的本机时刻」减「整分的服务端时刻」，差值里会混进**快照生成那一刻的秒数**，
    //    于是整个界面时钟被推后 0~59 秒（平均半分钟）。两个都截到整分，差才是真正的「两个钟的差」。
    //    ⚠️ 副作用（好的那种）：偏移由此恒为**整分钟**的倍数 ⇒ 本机整分就是服务端整分，
    //    `ttStartTimer` 按本机整分对齐也就等于按服务端整分对齐。
    const local = new Date(Date.now());
    local.setSeconds(0, 0);
    ttServerOffsetMs = local.getTime() - ms;
    ttSyncKey = key;
  }
}

/**
 * 功能：取「服务端口径的现在」—— `{ date, hm }`，判定函数的统一时间入口。
 *
 * 说明：`hm` 供 `ttLessonState` / `ttTodayNow` 用，`date` 供看板挑出「今天」的条目用。
 *      服务端还没给过 `now` 时它就是本机时钟（偏移为 0）—— 降级方向是「照常显示」。
 *
 * @returns {{date: string, hm: string}} 服务端口径的今天与当前时刻
 */
export function ttNowHM() {
  const d = new Date(Date.now() - ttServerOffsetMs);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hm: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

// ---------- ③ 状态判定（纯函数，判定的唯一一份） ----------

/**
 * 功能：判某一时刻这节课处于什么状态 —— `upcoming` 没开始 / `ongoing` 正在上 / `done` 已结束。
 *
 * 说明：⭐ 边界口径：`start_time <= now <= end_time` 都算「正在上」——
 *      最后一分钟（结束那一拍）宁可多显示一分钟「即将下课」，也不要提前变灰
 *      （手机版 0.5.5 之前的「正在上」高亮就是 `>=` 这个口径，这里原样收编）。
 *      ⭐ 一节的起止 = **课次格**的起止（连堂算一节）：
 *      调用方先把格子的首节开始 / 末节结束解好再传进来（`ttDayLessons` / 服务端 `spans`）。
 *      时刻解析不了时返回 **null**（调用方跳过它，不显示倒计时）—— 宁可少显示，不显示错。
 *
 * @param {string} nowHM - 当前时刻 `HH:MM`（**参数传入，函数里不读时钟**）
 * @param {?{start_time: string, end_time: string}} lesson - 这节课的起止时刻
 * @returns {?string} `upcoming` / `ongoing` / `done`；时刻不合法时为 null
 */
export function ttLessonState(nowHM, lesson) {
  const now = ttToMin(nowHM);
  const s = ttToMin(lesson && lesson.start_time);
  const e = ttToMin(lesson && lesson.end_time);
  if (now === null || s === null || e === null) return null;
  if (now < s) return 'upcoming';
  if (now <= e) return 'ongoing';
  return 'done';
}

/**
 * 功能：把一条课次格（起节 `ps` ~ 止节 `pe`）摊成**逐节的起止时刻**，
 *      供连堂内部的「小课间」判定用。
 *
 * 说明：⭐ 连堂算一节，但第 1 节下课到第 2 节上课之间要显示「课间 X 分钟」
 *      —— 这个小课间只藏在逐节时间里，整格的 `start_time / end_time` 看不出它。
 *      某一节缺时间（作息没配全）就只摊到它为止 —— 上半截照样能算，别整条作废。
 *
 * @param {Array.<Object>} periods - 逐节时间表（元素含 `index_no` / `start_time` / `end_time`）
 * @param {number} ps - 起始节次
 * @param {number} pe - 结束节次
 * @returns {Array.<{start_time: string, end_time: string}>} 格内逐节的起止；作息缺失时可能为空数组
 */
export function ttCellSpans(periods, ps, pe) {
  const byIdx = new Map();
  (periods || []).forEach((p) => {
    const i = Number(p && p.index_no);
    if (Number.isFinite(i)) byIdx.set(i, p);
  });
  const a = Number(ps);
  const bRaw = pe === undefined || pe === null || pe === '' ? ps : pe;
  const b = Number(bRaw);
  const spans = [];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return spans;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const p = byIdx.get(i);
    if (p && ttToMin(p.start_time) !== null && ttToMin(p.end_time) !== null) {
      spans.push({ start_time: p.start_time, end_time: p.end_time });
    }
  }
  return spans;
}

/**
 * 功能：从课表快照里取出**某一天的全部课次格**，折成判定函数要的「课」数组。
 *
 * 说明：⭐ 课表页（两端）与看板拿到的数据形状不同，但这一步是**同一段逻辑**：
 *      起止时刻 = 首节的 `start_time` → 末节的 `end_time`（连堂算一节的口径），
 *      逐节明细挂在 `spans` 上供小课间判定。电脑版与手机版都调它，别再各写一遍。
 *      作息缺失的格子 `start_time / end_time` 为空串 —— 判定函数会把它跳过（不显示倒计时）。
 *
 * @param {?Object} sch - 课表快照（`/api/timetable/.../schedule` 的响应，含 `cells` 与 `periods`）
 * @param {number} weekday - 星期几（1~7）
 * @returns {Array.<{id: number, start_time: string, end_time: string,
 *     spans: Array.<{start_time: string, end_time: string}>}>} 那一天的课（未排序）
 */
export function ttDayLessons(sch, weekday) {
  if (!sch || !Array.isArray(sch.cells)) return [];
  // ⭐ 0.7.2：这里取的是「**这一天的**」逐节时间 —— 假前一天下午提前时它是前移过的那一份
  //    （`ttDayPeriods` 读 `sch.days` 的 `pre_holiday` + `sch.holiday` 的提前量，两者都由服务端给）。
  //    ⚠️ 直接拿 `sch.periods` 会让课表页「卡片上的时间」与「倒计时」打架 —— 那正是 0.7.2 修的缺陷。
  const dayPeriods = ttDayPeriods(sch, weekday);
  return sch.cells
    // ⚠️ 跨周调课的**源周灰条**（`moved_out`）不算这一天要上的课：它已经调到别的周了，
    //    混进来会让倒计时 / 课间判定把「空出来的一节」当成还要上课（课表页画它只是为了写明去向）。
    .filter((c) => Number(c.weekday) === Number(weekday) && !c.moved_out)
    .map((c) => {
      const spans = ttCellSpans(dayPeriods, c.period_start, c.period_end);
      return {
        id: c.session_id,
        start_time: spans.length ? spans[0].start_time : '',
        end_time: spans.length ? spans[spans.length - 1].end_time : '',
        spans,
      };
    });
}

/**
 * 功能：算「下课后到下一节之间」还算不算**课间**的空档上限 —— **一小节的实际长度**。
 *
 * 说明：⭐ 0.6.1（真机反馈）：一小节多长**按课表作息设置算**，不写死 ——
 *      取当前这格 `spans`（逐节明细）里单节时长的最大值（兜连堂里长短不一的小节）；
 *      空档超过一小节的长度 = 中间起码空出一整节没课，那是午休 / 大空档，**不叫课间**
 *      （否则「一小节 45 分钟，距离课间 2 小时 55 分」）。
 *      ⚠️ `spans` 缺失（老响应 / 无作息，与「不算小课间」同一退化口径）时回落 45 分钟
 *      （标准小节长度）—— 宁可按常量判，也不把长空档误叫成课间。
 * @param {Object} cur - 正在上的那格课（`ttTodayNow` 内部的包装形状，`spans` 已折成 `{s, e}`）
 * @returns {number} 课间空档的判定上限（分钟）
 */
function breakGapMaxOf(cur) {
  let max = 0;
  for (const sp of cur.spans || []) {
    const len = sp.e - sp.s;
    if (len > max) max = len;
  }
  return max > 0 ? max : 45;
}

/**
 * 功能：算「这一刻，今天这些课的全景」—— 谁在上、下一节是谁、谁上完了、各自该显示什么文案。
 *
 * 说明：⭐ **课表页（两端）与看板（两端）都调这一份**，文案逐字一致靠的就是它。
 *      返回的 `byId` 是**渲染直接可用的最终文案**（原子文案已经按处境合成好了），
 *      四个渲染点只做「查 Map → 写 textContent」，不许再自己拼字符串。
 *
 *      文案口径（⭐ 0.6.1 两段式，**逐字照**）：
 *      · 正在上的课 → 下课后紧跟下一节、且空档是**课间量级**（≤ 一小节的实际时长，
 *        按本格 `spans` 算，见 `breakGapMaxOf`）时带课间预告段：`M 分钟课间 · N 分钟下课`；
 *        更长的空档是午休 / 半天没课，**不叫课间**（「一小节 45 分钟，距离课间 2 小时」就是这么
 *        误出来的）→ 只写 `N 分钟下课`；最后 N ≤ 1 分钟 → `即将下课`；
 *      · 课间（两节课之间的空档 / 连堂内部小节之间的空档，**同一套**）→
 *        `N 分钟后上课 · M 分钟下课`（第一段是实时倒数，第二段 = 下一段课的时长；
 *        最后 1 分钟 → `即将上课 · M 分钟下课`）；
 *      · 一天第一节课之前（今天还没上过课）→ **只报上课**：`N 分钟后上课` / `即将上课`
 *        —— 还没开始的课不谈下课；
 *      · 已上完 → 不给文案（调用方给它加 `is-done` 半灰）。
 *      ⚠️ 时长**一律写纯分钟**（`116 分钟下课`、`291 分钟后上课`），不折成「1 小时 56 分」
 *      —— 格式通篇是「xx分钟」，逐字照抄；`fmtDuration` 会折小时，这里不用。
 *      ⚠️ 数字与单位之间**留一个空格**（`25 分钟`）—— 与全项目既有写法一致，是排版细节、不是措辞。
 *
 * @param {string} nowHM - 当前时刻 `HH:MM`（**参数传入，函数里不读时钟**）
 * @param {Array.<{id: number|string, start_time: string, end_time: string,
 *     spans?: Array.<{start_time: string, end_time: string}>}>} todaysLessons - 今天的课
 * @returns {{ongoing: ?(number|string), next: ?(number|string), doneIds: Set,
 *     text: {ongoing: ?string, upcoming: ?string, break: ?string, innerBreak: ?string},
 *     byId: Map}} `ongoing` / `next` 是课的 `id`（没有则 null）；`doneIds` 是已结束课的 id 集合；
 *     `text` 是四条**原子文案**（单测按方案 §七 的形状断言它）；`byId` 是每条课此刻该显示的最终文案
 */
export function ttTodayNow(nowHM, todaysLessons) {
  /** 功能：拼一份空结果，保证每次调用返回的都是独立对象。 @returns {Object} 空全景 */
  const blank = () => ({
    ongoing: null,
    next: null,
    doneIds: new Set(),
    text: { ongoing: null, upcoming: null, break: null, innerBreak: null },
    byId: new Map(),
  });
  const res = blank();
  const now = ttToMin(nowHM);
  if (now === null || !Array.isArray(todaysLessons)) return res;
  // 只留时刻可读、有 id 的课，按开始时刻升序（同刻按结束升序，保证遍历顺序确定）
  const list = todaysLessons
    .map((l) => ({
      lesson: l || {},
      id: l ? l.id : null,
      s: ttToMin(l && l.start_time),
      e: ttToMin(l && l.end_time),
      spans: (l && Array.isArray(l.spans) ? l.spans : [])
        .map((sp) => ({ s: ttToMin(sp && sp.start_time), e: ttToMin(sp && sp.end_time) }))
        .filter((sp) => sp.s !== null && sp.e !== null),
    }))
    .filter((x) => x.id !== null && x.id !== undefined && x.s !== null && x.e !== null)
    .sort((a, b) => a.s - b.s || a.e - b.e);

  // 已上完的（严格晚于结束时刻；结束那一拍仍算「正在上」，见 ttLessonState 的边界口径）
  list.forEach((x) => {
    if (now > x.e) res.doneIds.add(x.id);
  });

  // 下一节：第一条还没开始的（⭐ 判「正在上的课下课后是不是课间」也要用它，所以提前算）
  const nxt = list.find((x) => now < x.s);

  // 正在上的：取「已开始且未结束」里开始最晚的那条（同格撞课的脏数据也能确定取一条）
  let cur = null;
  list.forEach((x) => {
    if (x.s <= now && now <= x.e) cur = x;
  });
  if (cur) {
    res.ongoing = cur.id;
    // 连堂内部的小课间：now 严格落在两小节之间（端点都算课堂上）才认 —— 记下**下一小节**
    let innerNext = null;
    for (let i = 0; i + 1 < cur.spans.length; i++) {
      if (now > cur.spans[i].e && now < cur.spans[i + 1].s) {
        innerNext = cur.spans[i + 1];
        break;
      }
    }
    if (innerNext) {
      // ⭐ 0.6.3：「课间」这两段**都是倒计时** —— `N 分钟后上课 · M 分钟后下课`。
      //    从前第二段写的是**下一小节的时长**（一个固定值），真机上被问
      //    「下课期间这个下课怎么是固定的 45 分钟」。
      //    ⚠️ M 取**整格结束**（`cur.e`）—— 与「上课中」那条的 N 指向**同一件事**：
      //      用户看到的「多久下课」始终是"这一整块什么时候结束"，不会在两种状态之间跳变。
      //    这一格仍是 `ongoing`（连堂还没散），只是文案换成课间态。
      const rem = innerNext.s - now;
      const toEnd = cur.e - now;
      res.text.innerBreak = `${rem <= 1 ? '即将上课' : `${rem} 分钟后上课`} · ${
        toEnd <= 1 ? '即将下课' : `${toEnd} 分钟后下课`
      }`;
      res.byId.set(cur.id, res.text.innerBreak);
    } else {
      const rem = cur.e - now;
      // ⭐ 0.6.3：「课间」那一段从**时长**改成**倒计时**，两段都在倒数 ——
      //    `M 分钟后课间 · N 分钟后下课`。
      //    · N = 距离**整格下课**（这一大块课真正结束，与从前一致）；
      //    · M = 距离**下一次休息** —— 连堂课里就是「本小节结束」（内部小课间的预告；
      //      真到那一刻时走的是上面的 `innerBreak` 分支）。
      //    ⚠️ 处在**最后一小节**里时，「下一次休息」＝整格下课 ⇒ M 与 N 是同一个时刻，
      //       写成「181 分钟后课间 · 181 分钟后下课」纯属废话 ⇒ 那种情况**只报 N**。
      //       单节课（`spans` 只有一节）同理；`spans` 缺失（无作息）也走这一支。
      //    ⚠️ 因此这里**不再需要**「空档是不是课间量级」的判断（`breakGapMaxOf`）——
      //       那是「报课间有多长」时才要问的；现在报的是「还有多久到课间」，与空档长度无关。
      const lastSpan = cur.spans.length ? cur.spans[cur.spans.length - 1] : null;
      let spanEnd = null;
      for (const sp of cur.spans) {
        if (now >= sp.s && now <= sp.e) {
          spanEnd = sp.e;
          break;
        }
      }
      const hasNextBreak = spanEnd !== null && !!lastSpan && spanEnd < lastSpan.e;
      const breakTxt = hasNextBreak ? (spanEnd - now <= 1 ? '即将课间 · ' : `${spanEnd - now} 分钟后课间 · `) : '';
      res.text.ongoing = `${breakTxt}${rem <= 1 ? '即将下课' : `${rem} 分钟后下课`}`;
      res.byId.set(cur.id, res.text.ongoing);
    }
  }

  if (nxt) {
    res.next = nxt.id;
    // 「两门课之间」只在**没有课正在上**时成立（正在上课时，下一节的文案走 upcoming）
    let prev = null;
    if (!cur) {
      list.forEach((x) => {
        if (x.e <= now && (!prev || x.e > prev.e)) prev = x;
      });
    }
    const rem = nxt.s - now;
    // ⭐ 0.6.2：与「正在上的课」用**同一把尺子** —— 空档超过**一小节的实际时长**就不是课间
    //    （那是午休 / 半天没课），这时**只报上课**：课还没开始，谈「多久下课」没有意义。
    //    就是它：上午 11:55 下课、下午 14:50 才上（隔了 175 分钟），
    //    界面上却写着「133 分钟后上课 · 205 分钟下课」。
    const gapMin = prev ? nxt.s - prev.e : null;
    const isBreak = prev && gapMin !== null && gapMin >= 1 && gapMin <= breakGapMaxOf(prev);
    if (isBreak) {
      // 课间（两节课之间的空档 / 连堂内部小节之间的空档，**同一套**）：两段式，**两段都倒数** ——
      //    `N 分钟后上课 · M 分钟后下课`。⭐ 0.6.3：第二段从「下一节的时长」（固定值）改成倒计时，
      //    与上面的 `innerBreak` 同一口径 —— M 指向 `nxt` 那节课的结束。
      const toEnd = nxt.e - now;
      res.text.break = `${rem <= 1 ? '即将上课' : `${rem} 分钟后上课`} · ${
        toEnd <= 1 ? '即将下课' : `${toEnd} 分钟后下课`
      }`;
      res.byId.set(nxt.id, res.text.break);
    } else {
      // 一天第一节课之前、以及长空档（午休 / 半天没课）：**只报上课**
      res.text.upcoming = rem <= 1 ? '即将上课' : `${rem} 分钟后上课`;
      res.byId.set(nxt.id, res.text.upcoming);
    }
  }
  return res;
}

/**
 * 功能：算「**某一天**的课里哪些已经上完了」—— 供课表页把**过去的日子整列**变灰。
 *
 * 说明：⭐ 0.6.2（报「今天上过的课变灰了，过了零点又恢复」）：
 *      课表页是**整周视图**，而变灰从前只按「今天那一列」算 —— 到了第二天，昨天那一列
 *      没人再管它，重画后就恢复成「没上过」的样子。正解是**按每一列自己的日期判**：
 *      · 日期早于今天 → 那天已经过完了，**整列都算上过**（不必再比时刻）；
 *      · 日期晚于今天 → 一节都不算；
 *      · 就是今天 → 交给 `ttTodayNow()` 按当前时刻判（与倒计时**同一份**判定）。
 *
 * @param {string} date - 这一列的日期 `YYYY-MM-DD`
 * @param {string} today - 今天（服务端口径，见 `ttNowHM()`）
 * @param {string} nowHM - 当前时刻 `HH:MM`（只有「今天」这一列用得上）
 * @param {Array} lessons - 这一天的课（`ttDayLessons()` 的形状）
 * @returns {Set} 已上完的课的 id；日期读不出时返回**空集合**（宁可不变灰，也不误判成「全上过」）
 */
export function ttDoneIdsOn(date, today, nowHM, lessons) {
  const list = Array.isArray(lessons) ? lessons : [];
  if (!date || !today) return new Set();
  if (date < today) return new Set(list.map((l) => l && l.id).filter((v) => v !== null && v !== undefined));
  if (date > today) return new Set();
  return ttTodayNow(nowHM, list).doneIds;
}

// ---------- ④ 倒计时定时器（全端唯一一个） ----------

/** 每分钟一拍（分钟级，不显示秒） */
const TT_TICK_MS = 60000;

/** 当前持有倒计时的屏的刷新函数（同一时刻至多一个） */
let ttTickFn = null;
/** 唯一的 `setInterval` 句柄；隐藏 / 切走时被清成 null */
let ttTimer = null;
/** `visibilitychange` 只挂一次的标记 */
let ttVisBound = false;

/**
 * 功能：跑一拍并保证定时器活着（屏可见时才真的跑；隐藏时只挂名）。
 * @returns {void}
 */
function ttRunTick() {
  if (ttTickFn && !document.hidden) ttTickFn();
}

/**
 * 功能：启动唯一的定时器；已启动或页面隐藏时不启动（隐藏时由可见事件唤起）。
 *
 * 说明：⭐ 0.6.1（报「半分钟左右的延迟」）：**首拍对齐到下一个整分**，之后才是
 *      60 秒一拍。否则「挂上那一刻的秒数」会被带进之后每一拍（10:30:47 挂上 ⇒ 此后永远在每分钟的
 *      第 47 秒才刷新），整分之后的头几十秒里界面一直显示**上一分钟**的倒计时，看着就是「慢半拍」。
 *      ⚠️ 用**本机**时刻对齐就够：偏移恒为整分钟的倍数（见 `ttSyncServerNow`），
 *      本机整分即服务端整分。
 * @returns {void}
 */
function ttStartTimer() {
  if (ttTimer || document.hidden) return;
  ttTimer = setTimeout(() => {
    ttRunTick();
    ttTimer = setInterval(ttRunTick, TT_TICK_MS);
  }, TT_TICK_MS - (Date.now() % TT_TICK_MS));
}

/**
 * 功能：停掉唯一的定时器 —— 首拍是 `setTimeout`、之后才换成 `setInterval`，两个清法都调一遍
 *      （两种 id 共用一套编号空间，多调一次无害）。
 * @returns {void}
 */
function ttStopTimer() {
  if (ttTimer) {
    clearTimeout(ttTimer);
    clearInterval(ttTimer);
    ttTimer = null;
  }
}

/**
 * 功能：挂页面可见性监听（整个会话只挂一次）—— 隐藏即停表，回前台立刻补算一拍再重新起表。
 * @returns {void}
 */
function ttBindVisibility() {
  if (ttVisBound) return;
  ttVisBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      ttStopTimer();
      return;
    }
    if (ttTickFn) {
      ttTickFn();
      ttStartTimer();
    }
  });
}

/**
 * 功能：登记 / 摘除当前屏的倒计时刷新函数 —— **全端只有一个定时器**在这背后周转。
 *
 * 说明：⭐ 用法：倒计时屏每次渲染完调 `ttTicker(true, fn)`（`fn` 内部只改文本与 class、
 *      **绝不重画**，而且每次都重新查 DOM，不攥旧节点）；离开该屏时由两端唯一的
 *      切屏收口（电脑版 `shell.js` 的 `showView` / 手机版 `app.js` 的 `switchTab`）调
 *      `ttTicker(false)` 摘除 —— 与 `teamworkLeave()` 同一个「唯一出口」思路。
 *      ⭐ 重复 `ttTicker(true, fn)` 是**替换**不是叠加：两屏来回切不会长出第二个定时器。
 *      ⚠️ 挂上时**立刻跑一拍**（首次渲染的文案就是它填的，渲染点自己不用再算一遍）；
 *      页面隐藏时挂上则只登记、等回前台再算（`visibilitychange` 里补那一拍）。
 *
 * @param {boolean} on - true = 登记并起表；false = 摘除（`fn` 省略时摘当前持有者）
 * @param {Function} [fn] - 刷新函数（`on` 为 true 时必传）
 * @returns {void}
 */
export function ttTicker(on, fn) {
  if (on) {
    ttTickFn = fn;
    ttBindVisibility();
    ttRunTick();
    ttStartTimer();
    return;
  }
  if (!fn || ttTickFn === fn) {
    ttTickFn = null;
    ttStopTimer();
  }
}

// ---------- ⑤ 课条合并：同一天里「本质同一节课」的多个格子（⭐ 0.6.2） ----------

/**
 * 功能：把周次文本解析成**周次号集合**。
 *
 * 说明：⚠️ 这里必须与服务端 `core/timetable/date-util.js` 的 `normalizeWeeks()` **口径一致**
 *      （库里存的就是它产出的规范形）：同样的清洗顺序、同样的片段正则。
 *      ⚠️ `6,8,10,12,14,16` 这种**枚举不算双周**（服务端明文注明：识别成双周会让 6 周变 8 周）。
 *      片段认不出就**跳过**（不抛错）—— 认不出时宁可「不合并」，也不能合并错。
 *
 * @param {string} text - 周次文本（`1-16` / `1-5,7-11单` / `6,8,10`）
 * @returns {Set.<number>} 命中的周次号
 */
function ttWeeksSet(text) {
  const out = new Set();
  let s = String(text === undefined || text === null ? '' : text).trim();
  if (!s) return out;
  s = s
    .replace(/\s+/g, '')
    .replace(/单周/g, '单')
    .replace(/双周/g, '双')
    .replace(/周次|周数/g, '')
    .replace(/[|｜]/g, '')
    .replace(/[［【（(]/g, '')
    .replace(/[］】）)]/g, '')
    .replace(/^第/, '')
    .replace(/[，、；;]/g, ',')
    .replace(/[－–—~～至]/g, '-')
    .replace(/周/g, '')
    .replace(/[^0-9,\-单双]/g, '');
  if (!s) return out;
  for (const part of s.split(',')) {
    const m = /^(\d{1,2})(?:-(\d{1,2}))?(单|双)?$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (!(from >= 1) || !(to >= from) || to > 60) continue;
    const parity = m[3] || '';
    for (let i = from; i <= to; i++) {
      if (parity === '单' && i % 2 === 0) continue;
      if (parity === '双' && i % 2 === 1) continue;
      out.add(i);
    }
  }
  return out;
}

/**
 * 功能：把周次号集合写回文本（`5-16` / `6,8,10`）。
 *
 * 说明：只压缩**连续段**（步长 1），**不推断单双周** —— 把 `1,3,5` 猜成 `1-5单`，会在用户
 *      改开学日之后变成假话（与服务端「枚举不等于双周」同一条纪律）。空集合返回空串。
 *
 * @param {Set.<number>} set - 周次号集合
 * @returns {string} 周次文本
 */
function ttWeeksText(set) {
  const arr = Array.from(set).sort((a, b) => a - b);
  if (!arr.length) return '';
  const out = [];
  for (let i = 0; i < arr.length; ) {
    let j = i;
    while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
    out.push(j > i ? `${arr[i]}-${arr[j]}` : String(arr[i]));
    i = j + 1;
  }
  return out.join(',');
}

/**
 * 功能：把一组节次区间**归一化** —— 排序（起始节次升序、相同再比起止）+ 去掉完全重复的。
 *
 * 说明：⭐ 去重是必须的：`ttMergeCells()` 里那条「**节次完全一致**也并」的判据，
 *      会把同一格的两段周次并成一条，两段的起止**一模一样**（`[1-2]` + `[1-2]`）——
 *      不去重，课条上就会画出两行一模一样的钟点。
 *      ⚠️ 读不出节次的段直接丢掉（宁可少一段，也不画一个假区间）。
 *      ⚠️ 两端渲染那一层也走它（`ttCellSegs()`）—— 判据只住一份。
 *
 * @param {Array.<Object>} raw - 形如 `[{period_start, period_end}, …]`
 * @returns {Array.<{period_start: number, period_end: number}>} 归一化后的段；全读不出时为空数组
 */
function ttNormSegs(raw) {
  const seen = new Set();
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((s) => {
    const a = Number(s && s.period_start);
    const bRaw = s && s.period_end;
    const b = bRaw === undefined || bRaw === null || bRaw === '' ? a : Number(bRaw);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}|${hi}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ period_start: lo, period_end: hi });
  });
  out.sort((x, y) => x.period_start - y.period_start || x.period_end - y.period_end);
  return out;
}

/**
 * 功能：把「同一天里本质是同一节课」的多个格子合并成一个 —— **只为渲染**，存储与接口一行不动。
 *
 * 背景：教务系统导出时**同一门课会按周次段拆成多条**，例：
 *      `1-16 周的 01-02 节` 与 `5-16 周的 03-04 节` —— 画出来一上一下两个块，看着像两门课。
 *
 * 判定（既定的规则）：**同一天** 且 `课程名 + 教室 + 教师` **三者全等**，再加节次/周次那条：
 *      **节次相邻或重叠** 且（**周次有重合** 或 **节次完全一致**）。
 *      ⚠️ 「节次相邻或重叠」是必须的**安全阀**：否则 `01-02` 与 `05-06` 会并成 `01-06`，
 *      把夹在中间的课**吞掉**。
 *      ⚠️ **教室参与判定**：`一教207` 与 `十五教107` 的同名课不合并。
 *
 * 合并结果：节次取**并集**（`01-02`+`03-04` ⇒ `01-04`）；周次取**并集**（列全，不丢周次）；
 *      其余字段取**第一条**。
 *
 * ⭐ 0.7.2：周次口径由「重合段（交集）」改成**并集**、判据放宽到「节次
 *      完全一致的也并」—— 两处改动是同一个目标（**全学期视图里同一格不再出现两条**）。
 *      来龙去脉写在函数体里那段注释，改判据前先读它。
 *
 * ⚠️ 必须做在**数据源头**（两端拉完 `/schedule` 就地合并一次）：渲染与倒计时
 *      （`ttDayLessons()` 拿 `session_id` 当 key）必须看到**同一份**数据 ——
 *      只合并渲染那一侧，倒计时会静默挂不上（不报错，只是不动）。
 * ⚠️ 纯函数、**不改入参**（参与合并的格子返回浅拷贝；没合并的原样返回）。
 *
 * @param {Array.<Object>} cells - 课表快照里的课次数组
 * @returns {Array.<Object>} 合并后的数组（不足两条时原样返回）
 */
export function ttMergeCells(cells) {
  if (!Array.isArray(cells) || cells.length < 2) return cells;

  /** 分组：同一天 + 同课名 + 同教室 + 同教师 */
  const groups = new Map();
  const order = [];
  cells.forEach((c) => {
    const k = [Number(c.weekday), c.name || '', c.room || '', c.teacher || ''].join('\u0000');
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k).push(c);
  });

  const out = [];
  for (const k of order) {
    const list = groups.get(k);
    if (list.length < 2) {
      out.push(list[0]);
      continue;
    }
    list.sort(
      (a, b) => Number(a.period_start) - Number(b.period_start) || Number(a.period_end) - Number(b.period_end),
    );
    let acc = null;
    for (const c of list) {
      const set = ttWeeksSet(c.weeks);
      if (acc) {
        const adjacent = Number(c.period_start) <= Number(acc.period_end) + 1;
        /** 节次**完全一致**（起止都一样）⇒ 就是同一格里的两段周次 */
        const sameSpan =
          Number(c.period_start) === Number(acc.period_start) &&
          Number(c.period_end) === Number(acc.period_end);
        let overlap = false;
        for (const w of set) {
          if (acc._ttSet.has(w)) {
            overlap = true;
            break;
          }
        }
        // ⭐ 0.7.2（选「同格合并 + 周次取并集」）：判据由「相邻且周次有重合」
        //    放宽成「相邻且（周次有重合 **或** 节次完全一致）」。
        //    ⚠️ 起因是教务常把同一门课按周次段拆成**节次完全相同**的两条（`1-8 周` + `9-16 周`），
        //    它们周次不重合，老判据一条都不并 ⇒ **同一格里堆两条同名 chip**（「有重复」）。
        //    ⛔ 不可以干脆去掉 `adjacent`：`01-02` 与 `05-06` 会并成 `01-06`，把夹在中间的课吞掉。
        //    ⛔ 也不可以对「节次不同且周次不重合」放行：那是「上半学期上 1-2 节、下半学期换到
        //    3-4 节」，并成 `1-4 节` 会让看板每天都多出两节根本不存在的课。
        if (adjacent && (overlap || sameSpan)) {
          // ⭐ 0.7.8：把**这一格自己的**节次区间也留住 —— 并集（`01-04`）
          //    只是「这个块画多大」的口径；每格真实的钟点（`08:30–10:05` / `10:20–11:55`）
          //    是另一件事，从前就在这一句里被并掉、再也找不回来（课条只能写成 `08:30–11:55`）。
          //    ⚠️ push 的是 `c`（成员格）自己的区间，⛔ 不是并集、⛔ 也不是按小节展开成 4 段。
          if (acc._ttSegs) {
            acc._ttSegs.push({ period_start: Number(c.period_start), period_end: Number(c.period_end) });
          }
          acc.period_start = Math.min(Number(acc.period_start), Number(c.period_start));
          acc.period_end = Math.max(Number(acc.period_end), Number(c.period_end));
          // ⭐ 周次取**并集**（不再是交集）—— 交集会把「哪几周上这门课」直接抹掉：
          //    `1-8 周` 与 `9-16 周` 交出来是**空集**，而并集是 `1-16 周`。
          //    宁可把周次列全，也不许算成「没有」。
          for (const w of set) acc._ttSet.add(w);
          acc._ttMerged = true;
          continue;
        }
      }
      if (acc) out.push(acc);
      acc = Object.assign({}, c);
      acc._ttSet = set;
      // ⭐ 0.7.8：新开一段时先记下**它自己**那一段（后面的成员格会往里 push）——
      //    临时字段以 `_tt` 打头，收尾时一律删掉（见下面那个 `map`）。
      acc._ttSegs = [{ period_start: Number(c.period_start), period_end: Number(c.period_end) }];
    }
    if (acc) out.push(acc);
  }

  return out.map((c) => {
    if (c._ttMerged && c._ttSet) {
      const text = ttWeeksText(c._ttSet);
      if (text) c.weeks = text; // 交集算不出文本时保留原值，宁可不改
    }
    // ⭐ 0.7.8：**只有真的合并过**的格子才带 `period_segs`。
    //    ⛔ 未合并的格子（单条输入 / 分组里只有一条 / 同组但没并成）一律**不带这个键** ——
    //    它们本来就只有一段，多一个键只会让「到底合没合」变得判不出来；
    //    渲染那一层因此可以放心地「有 `period_segs` 就按它逐段画、没有就当一段」。
    if (c._ttMerged && c._ttSegs) c.period_segs = ttNormSegs(c._ttSegs);
    if (c._ttSet) delete c._ttSet;
    if (c._ttSegs) delete c._ttSegs;
    if (c._ttMerged) delete c._ttMerged;
    return c;
  });
}

/**
 * 功能：取一个格子的**逐段节次区间** —— 合并过的回它留下的 `period_segs`，没合并的回落自己那一段。
 *
 * 说明：⭐ 0.7.8：合并的**视图**口径（节次并集 `[01-04]`）与**真实钟点**口径
 *      （`08:30–10:05` / `10:20–11:55` 两段）是两件事 —— 前者让课条画成一个块，后者才是用户要看的。
 *      `ttMergeCells()` 合并时把成员段留在 `period_segs` 上，这里取出来（**再排一次序、
 *      去一次重**，防外部数据脏），渲染那一层就不用自己判「到底合没合」。
 *      ⚠️ 没合并的格子**不带** `period_segs` 键 ⇒ 回落分支是常态路径，不是异常兜底。
 *
 * @param {Object} c - 课次格（合并过的或没合并的都行）
 * @returns {Array.<{period_start: number, period_end: number}>} 逐段节次；读不出时为空数组
 */
export function ttCellSegs(c) {
  if (!c) return [];
  const raw = Array.isArray(c.period_segs) && c.period_segs.length ? c.period_segs : null;
  return ttNormSegs(raw || [{ period_start: c.period_start, period_end: c.period_end }]);
}

/**
 * 功能：把一格课**按没合并时的那几段**各自折成时钟文案 —— 一段一条（`08:30–10:05`）。
 *
 * 说明：⭐ 0.7.8（真机）：「课表中显示的时间是合并后的第 2 节，这个不对
 *      （【今天】中的是正确的）」—— 合并只是**视图**上并成一个块（「本质上并不是一节，
 *      只是合并显示」），倒计时与今天屏本来就按逐节算，而课条却把并集（`08:30–11:55`）
 *      折成了一整段 ⇒ 同一门课在两屏显示得不一样。
 *      修法：**逐段折时刻**，一段一行；⛔ **不跨段取「第一段起、最后一段止」**。
 *      ⚠️ 作息必须走 `ttDayPeriods(sch, c.weekday)`（含**假前一天下午提前**）——
 *      直接读 `sch.periods` 会让卡片上的时间与倒计时打架，那正是 0.7.2 修过的缺陷。
 *      ⚠️ 判定与格式化**只住这一份**：两端只负责把字符串摆进 DOM。
 *      ⚠️ 段里首 / 末节的作息行缺失或时刻读不出 ⇒ **跳过那一段**（不显示半截时间）；
 *      一段都算不出 ⇒ 空数组，调用方此时不显示时间（与从前 `ttPeriodText()` 的退化口径一致）。
 *
 * @param {?Object} sch - 课表快照（读其 `periods` / `days` / `holiday`）
 * @param {Object} c - 课次格
 * @returns {Array.<string>} 逐段时钟文案（如 `['08:30–10:05', '10:20–11:55']`）；算不出时为空数组
 */
export function ttCellTimeTexts(sch, c) {
  if (!c) return [];
  const byIdx = new Map();
  (ttDayPeriods(sch, Number(c.weekday)) || []).forEach((p) => {
    const i = Number(p && p.index_no);
    if (Number.isFinite(i)) byIdx.set(i, p);
  });
  const out = [];
  for (const seg of ttCellSegs(c)) {
    const a = byIdx.get(seg.period_start);
    const b = byIdx.get(seg.period_end);
    if (!a || !b) continue;
    if (ttToMin(a.start_time) === null || ttToMin(b.end_time) === null) continue;
    out.push(`${a.start_time}–${b.end_time}`);
  }
  return out;
}
