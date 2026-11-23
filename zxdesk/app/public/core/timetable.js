/**
 * core/timetable.js —— 课表的共用格式化与「现在」判定（两端唯一一份）
 *
 * 功能：分四块 ——
 * ① `ttPeriodTag()` 把起止节次写成课条上那枚短标签（`[01-02]` / `[03]`）；
 * ② ⭐ 课表 2 期的**实时状态判定**（`ttLessonState` / `ttTodayNow` / `ttCellSpans` / `ttDayLessons`）：
 * 「这节课什么状态、还有多久下课、课间剩多久」**全项目只在这里算一份**…
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/13-课表2期-实时倒计时与看板联动.md
 */

/**
 * 功能：把起止节次写成短标签 —— 连堂写 `[01-02]`，单节写 `[03]`；读不出节次时返回空串。
 *
 * 说明：⭐ 两位数补零是**照给的那张图**定的（`[01-02]` 而不是 `[1-2]`）：课条窄，
 * 定宽的数字排在一起才好看；而且上午第 1 节与下午第 10 节在视觉上不会串位。
 * 返回空串而不是 `[–]`：读不出节次的老数据宁可什么都不显示，也不显示一个假区间。
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
 * 字符串比较（`'09:05' <= '10:00'`）虽然碰巧也对，但 `'9:05'` 这种不补零的脏数据会串位
 * —— 统一走这里，脏数据在入口处就变成「不显示倒计时」（失败方向安全）。
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
 *
 * 说明：⭐ 这是服务端 `core/timetable/holiday-util.js` 的 `shiftPeriods()` 的**前端一份**，
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
    // 上午（起始早于下午起点）**一节都不动** —— 学校的安排就是「上午照常、下午提前」
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
 *
 * 说明：⭐ 为什么必须是「按天」而不是改学期作息：`sch.periods` 是**整个学期一张表**
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
 *
 * 说明：⭐ 两端课表页与共享判定（`ttDayLessons`）都走这一个入口 ——
 */
export function ttDayPeriods(sch, weekday) {
  const wd = Number(weekday);
  const day = ((sch && sch.days) || []).find((d) => Number(d.weekday) === wd) || null;
  return ttPeriodsOn(sch && sch.periods, day, sch && sch.holiday);
}

// ---------- ② 「现在」：服务端时间 + 本机偏移 ----------

/**
 * 本机时钟相对服务端时钟的偏移（毫秒）：`Date.now() − serverNowMs`。
 * @type {number}
 */
let ttServerOffsetMs = 0;

/**
 * 上一次校准用的服务端快照指纹（`date hm`）—— **同一份快照只校准一次**。
 * @type {string}
 */
let ttSyncKey = '';

/**
 * 功能：记下服务端的「现在」—— 之后所有倒计时都以它为基准换算。
 *
 * 说明：⭐ 时间权威源 = **服务端**：手机时钟被拨快 / 时区不对时，
 * 直接用本机时间算「还有几分钟下课」就会静默算错 = 误课。
 * 前端只记一次偏移（`Date.now() − serverNowMs`），之后每一拍都用
 */
export function ttSyncServerNow(now) {
  if (!now || !now.date || !now.hm) return;
  // ：**同一份快照不重算偏移**。
  // 倒计时屏的 tick 是 60 秒一拍，手里只有响应里那一份 `now`（不会变）—— 从前每拍都重算，于是
  // `Date.now() − 偏移` 恒等于**快照时刻**，界面上的「现在」被自己钉死在打开页面那一刻
  const key = `${now.date} ${now.hm}`;
  if (key === ttSyncKey) return;
  // 无时区后缀的日期时间串按**本地时区**解析（ES2015+ 的规定行为，Node 与浏览器一致）：
  const ms = Date.parse(`${now.date}T${now.hm}:00`);
  if (Number.isFinite(ms)) {
    // ：**本机时刻也要截到整分钟**再相减。
    // 服务端给的 `hm` 只有分钟（`nowInfo()` 返回的就是 `HH:MM`，秒数在上游就没了）——
    // 拿「带秒的本机时刻」减「整分的服务端时刻」，差值里会混进**快照生成那一刻的秒数**，
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
 * 服务端还没给过 `now` 时它就是本机时钟（偏移为 0）—— 降级方向是「照常显示」。
 *
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
 * 最后一分钟（结束那一拍）宁可多显示一分钟「即将下课」，也不要提前变灰
 * 一节的起止 = **课次格**的起止（连堂算一节）：
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
 * 供连堂内部的「小课间」判定用。
 *
 * 说明：⭐ 连堂算一节，但第 1 节下课到第 2 节上课之间要显示「课间 X 分钟」
 * —— 这个小课间只藏在逐节时间里，整格的 `start_time / end_time` 看不出它。
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
 * 起止时刻 = 首节的 `start_time` → 末节的 `end_time`（连堂算一节的口径），
 * 逐节明细挂在 `spans` 上供小课间判定。电脑版与手机版都调它，别再各写一遍。
 */
export function ttDayLessons(sch, weekday) {
  if (!sch || !Array.isArray(sch.cells)) return [];
  // 这里取的是「**这一天的**」逐节时间 —— 假前一天下午提前时它是前移过的那一份
  // （`ttDayPeriods` 读 `sch.days` 的 `pre_holiday` + `sch.holiday` 的提前量，两者都由服务端给）。
  const dayPeriods = ttDayPeriods(sch, weekday);
  return sch.cells
    // 跨周调课的**源周灰条**（`moved_out`）不算这一天要上的课：它已经调到别的周了，
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
 * 取当前这格 `spans`（逐节明细）里单节时长的最大值（兜连堂里长短不一的小节）；
 * 空档超过一小节的长度 = 中间起码空出一整节没课，那是午休 / 大空档，**不叫课间**
 * `spans` 缺失（老响应 / 无作息，与「不算小课间」同一退化口径）时回落 45 分钟
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
 * 返回的 `byId` 是**渲染直接可用的最终文案**（原子文案已经按处境合成好了），
 *
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
      // 「课间」这两段**都是倒计时** —— `N 分钟后上课 · M 分钟后下课`。
      // 从前第二段写的是**下一小节的时长**（一个固定值），真机上被问
      // 「下课期间这个下课怎么是固定的 45 分钟」。
      const rem = innerNext.s - now;
      const toEnd = cur.e - now;
      res.text.innerBreak = `${rem <= 1 ? '即将上课' : `${rem} 分钟后上课`} · ${
        toEnd <= 1 ? '即将下课' : `${toEnd} 分钟后下课`
      }`;
      res.byId.set(cur.id, res.text.innerBreak);
    } else {
      const rem = cur.e - now;
      // 「课间」那一段从**时长**改成**倒计时**，两段都在倒数 ——
      // `M 分钟后课间 · N 分钟后下课`。
      // N = 距离**整格下课**（这一大块课真正结束，与从前一致）；
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
    // 与「正在上的课」用**同一把尺子** —— 空档超过**一小节的实际时长**就不是课间
    // （那是午休 / 半天没课），这时**只报上课**：课还没开始，谈「多久下课」没有意义。
    // 就是它：上午 11:55 下课、下午 14:50 才上（隔了 175 分钟），
    const gapMin = prev ? nxt.s - prev.e : null;
    const isBreak = prev && gapMin !== null && gapMin >= 1 && gapMin <= breakGapMaxOf(prev);
    if (isBreak) {
      // 课间（两节课之间的空档 / 连堂内部小节之间的空档，**同一套**）：两段式，**两段都倒数** ——
      // 与上面的 `innerBreak` 同一口径 —— M 指向 `nxt` 那节课的结束。
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
 * 课表页是**整周视图**，而变灰从前只按「今天那一列」算 —— 到了第二天，昨天那一列
 * 没人再管它，重画后就恢复成「没上过」的样子。正解是**按每一列自己的日期判**：
 * 日期早于今天 → 那天已经过完了，**整列都算上过**（不必再比时刻）；
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
 * 第 47 秒才刷新），整分之后的头几十秒里界面一直显示**上一分钟**的倒计时，看着就是「慢半拍」。
 * 用**本机**时刻对齐就够：偏移恒为整分钟的倍数（见 `ttSyncServerNow`），
 * 本机整分即服务端整分。
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
 * （两种 id 共用一套编号空间，多调一次无害）。
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
 * **绝不重画**，而且每次都重新查 DOM，不攥旧节点）；离开该屏时由两端唯一的
 * 切屏收口（电脑版 `shell.js` 的 `showView` / 手机版 `app.js` 的 `switchTab`）调
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


/**
 * 功能：把周次文本解析成**周次号集合**。
 *
 * 说明：⚠️ 这里必须与服务端 `core/timetable/date-util.js` 的 `normalizeWeeks()` **口径一致**
 * （库里存的就是它产出的规范形）：同样的清洗顺序、同样的片段正则。
 * 片段认不出就**跳过**（不抛错）—— 认不出时宁可「不合并」，也不能合并错。
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
 * 改开学日之后变成假话（与服务端「枚举不等于双周」同一条纪律）。空集合返回空串。
 *
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
 * 会把同一格的两段周次并成一条，两段的起止**一模一样**（`[1-2]` + `[1-2]`）——
 * 不去重，课条上就会画出两行一模一样的钟点。
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
 * `1-16 周的 01-02 节` 与 `5-16 周的 03-04 节` —— 画出来一上一下两个块，看着像两门课。
 *
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
        // ：判据由「相邻且周次有重合」
        // 放宽成「相邻且（周次有重合 **或** 节次完全一致）」。
        // 起因是教务常把同一门课按周次段拆成**节次完全相同**的两条（`1-8 周` + `9-16 周`），
        if (adjacent && (overlap || sameSpan)) {
          // 把**这一格自己的**节次区间也留住 —— 并集（`01-04`）
          // 只是「这个块画多大」的口径；每格真实的钟点（`08:30–10:05` / `10:20–11:55`）
          // 是另一件事，从前就在这一句里被并掉、再也找不回来（课条只能写成 `08:30–11:55`）。
          if (acc._ttSegs) {
            acc._ttSegs.push({ period_start: Number(c.period_start), period_end: Number(c.period_end) });
          }
          acc.period_start = Math.min(Number(acc.period_start), Number(c.period_start));
          acc.period_end = Math.max(Number(acc.period_end), Number(c.period_end));
          // 周次取**并集**（不再是交集）—— 交集会把「哪几周上这门课」直接抹掉：
          // `1-8 周` 与 `9-16 周` 交出来是**空集**，而并集是 `1-16 周`。
          for (const w of set) acc._ttSet.add(w);
          acc._ttMerged = true;
          continue;
        }
      }
      if (acc) out.push(acc);
      acc = Object.assign({}, c);
      acc._ttSet = set;
      // 新开一段时先记下**它自己**那一段（后面的成员格会往里 push）——
      // 临时字段以 `_tt` 打头，收尾时一律删掉（见下面那个 `map`）。
      acc._ttSegs = [{ period_start: Number(c.period_start), period_end: Number(c.period_end) }];
    }
    if (acc) out.push(acc);
  }

  return out.map((c) => {
    if (c._ttMerged && c._ttSet) {
      const text = ttWeeksText(c._ttSet);
      if (text) c.weeks = text; // 交集算不出文本时保留原值，宁可不改
    }
    // **只有真的合并过**的格子才带 `period_segs`。
    // 未合并的格子（单条输入 / 分组里只有一条 / 同组但没并成）一律**不带这个键** ——
    // 渲染那一层因此可以放心地「有 `period_segs` 就按它逐段画、没有就当一段」。
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
 * （`08:30–10:05` / `10:20–11:55` 两段）是两件事 —— 前者让课条画成一个块，后者才是用户要看的。
 * `ttMergeCells()` 合并时把成员段留在 `period_segs` 上，这里取出来（**再排一次序、
 * 去一次重**，防外部数据脏），渲染那一层就不用自己判「到底合没合」。
 */
export function ttCellSegs(c) {
  if (!c) return [];
  const raw = Array.isArray(c.period_segs) && c.period_segs.length ? c.period_segs : null;
  return ttNormSegs(raw || [{ period_start: c.period_start, period_end: c.period_end }]);
}

/**
 * 功能：把一格课**按没合并时的那几段**各自折成时钟文案 —— 一段一条（`08:30–10:05`）。
 *
 * （【今天】中的是正确的）」—— 合并只是**视图**上并成一个块（「本质上并不是一节，
 * 只是合并显示」），倒计时与今天屏本来就按逐节算，而课条却把并集（`08:30–11:55`）
 * 折成了一整段 ⇒ 同一门课在两屏显示得不一样。
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
