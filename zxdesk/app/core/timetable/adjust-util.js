/**
 * timetable/adjust-util.js —— **单次调课 / 停课**的唯一判定（纯函数）
 *
 * 功能：把「某条课次在第 W 周被挪到别的时间、或干脆停掉」这件事算清楚 ——
 *      `indexBySessionWeek()` 建索引、`slotOf()` 求某条课次某一周的**实际落点**、
 *      `applyAdjustments()` 把调整合并进课表格子、`findConflict()` 判断目标格子是否已被占。
 *
 * ⚠️ 为什么这套判定要单独一个文件、且是纯函数：
 *    ① **只有一份**。合并渲染（`/schedule`）与「能不能这么调」（保存前撞车检查）必须用同一套
 *       「这周这门课到底在哪一格」的算法 —— 两份实现迟早会不一致，而表现是
 *       「界面画在一处、撞车检查以为在另一处」，也就是**放行了真正撞车的调课**。
 *    ② **不碰数据库**。两个存储后端、路由层、测试都调它，谁也不必各写一遍。
 *
 * ⚠️ 两种范围的分工（调课时要能选「本节 / 此后全部」）：
 *    · **本节** → 写一行调整（`kind: 'move'` 调课 / `'cancel'` 停课），靠本文件在渲染时合并；
 *    · **此后全部** → **不经过本文件**，直接把课次的 `weeks` 劈开（见 `date-util.splitWeeks`）——
 *      改完就是两条普普通通的课次，渲染层不需要知道曾经调过课。
 *
 * ⚠️ 跨周调课（「调课应该要能选择调到那一周（从 X 周调到 Y 周）」）：
 *    本节口径下 `to_week_no` 写目标周（空 = 同周换时间）。渲染成**两处**：
 *      · 源周 X：这一格**变灰**并写明「调到 8 周 周三 第 3-4 节」—— 课条仍在原位、不占格；
 *      · 目标周 Y：多出这一次课（带「调」标 + 「从第 6 周调来」）。
 *    ⚠️ 目标周**只要求那一格是空的**（同一门课那周本来还有课也允许 —— 老师把两次课并到一周上
 *    是常态，不拦）。
 *
 * ⚠️ 全学期视图（不指定周次）**不合并**单次调整：一条课次覆盖 1-16 周，若把第 6 周的目标格子
 *    也画进去，同一门课会同时出现在两个格子里、看着像多了一节课。宁可如实说明「本视图不反映
 *    单次调课」，也不画一张会误导读者的表（由路由层只传 `has_adjustments` 让界面提示）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.52
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const { numOr, weeksInclude } = require('./date-util.js');

/** 调课：把这一周的这节课挪到别的时间 */
const KIND_MOVE = 'move';
/** 停课：这一周这节课不上 */
const KIND_CANCEL = 'cancel';

/**
 * 功能：求一条调整行的**目标周** —— 没写 `to_week_no` 时就是它自己的 `week_no`（同周调课）。
 *
 * @param {Object} adj - 调整行
 * @returns {number} 目标周次
 */
function targetWeekOf(adj) {
  const tw = numOr(adj && adj.to_week_no, 0);
  return tw > 0 ? tw : numOr(adj && adj.week_no, 0);
}

/**
 * 功能：判断这条调整是不是**跨周**调课（调课 · 目标周 与源周不同）。
 *
 * 说明：⭐ 要的「从 X 周调到 Y 周」。同周调课（老行为）仍是「这一周换个时间」，
 *      只写 `to_weekday` 等落点、`to_week_no` 为空；跨周才额外写目标周 —— 停课永远不跨周。
 *
 * @param {Object} adj - 调整行
 * @returns {boolean} 是否跨周
 */
function isCrossWeek(adj) {
  if (!adj || adj.kind === KIND_CANCEL) return false;
  const tw = numOr(adj.to_week_no, 0);
  return tw > 0 && tw !== numOr(adj.week_no, 0);
}

/**
 * 功能：把调整行按 `session_id:week_no` 索引起来，供 O(1) 查「这条课次这一周有没有被调整」。
 *
 * @param {Array.<Object>} adjustments - 调整行数组
 * @returns {Map.<string, Object>} 键为 `session_id:week_no`
 */
function indexBySessionWeek(adjustments) {
  const m = new Map();
  (adjustments || []).forEach((a) => {
    m.set(`${Number(a.session_id)}:${Number(a.week_no)}`, a);
  });
  return m;
}

/**
 * 功能：求一条课次在某一周的**实际落点** —— 有调课就用调课给的，没调整就用课次自身的。
 *
 * 说明：`to_*` 一律**逐项回落**到课次原值：允许「只改教室」或「只挪到周五」这种局部调整。
 *      ⚠️ `to_period_end` 缺省时回落的是**原本的止节**（不是新的起节）—— 回落到起节会把
 *      「周三第 3-4 节 → 周五」变成「周五只有第 3 节」，白白吃掉一节课。只有新起节越过原止节时
 *      才退化成单节（见函数内注释）。
 *
 * @param {Object} cell - 课次（`/schedule` 的 cells 元素，含 `weekday` / `period_start` / `period_end` / `room`）
 * @param {?Object} adj - 这一周该课次的调整行；没有则传 null
 * @param {?number} [weekNo] - 正在算的是哪一周（跨周调课要靠它区分「源周」与「目标周」）；
 *    缺省时按**目标周**算（调用方几乎都会传，只有老调用点不传）
 * @returns {?Object} `{ weekday, period_start, period_end, room, note, adjustment_id }`；
 *     **停课、以及跨周调课的源周都返回 null**（那一周这一次不上，格子不占）
 */
function slotOf(cell, adj, weekNo) {
  if (adj && adj.kind === KIND_CANCEL) return null;
  // ⭐ 跨周调课的**源周**：这一次课已经被挪到别的周了 ⇒ 本周不占格（灰条由 `applyAdjustments` 另画）。
  //    ⚠️ 不返回 null 的话，源周会画出一条「调到同一周某处」的假课条，撞车检查也会以为它还占着原位。
  if (isCrossWeek(adj) && weekNo !== undefined && numOr(weekNo, 0) === numOr(adj.week_no, 0)) return null;
  const base = {
    weekday: numOr(cell.weekday, 1),
    period_start: numOr(cell.period_start, 1),
    period_end: numOr(cell.period_end, numOr(cell.period_start, 1)),
    room: cell.room || '',
    note: '',
    adjustment_id: null,
  };
  if (!adj) return base;
  const start = numOr(adj.to_period_start, base.period_start);
  // ⚠️ `to_period_end` 缺省时回落到**课次原本的止节**，而不是回落到新的起节：
  //    回落到起节会把「周三第 3-4 节 → 周五」变成「周五只有第 3 节」—— 白白吃掉一节课。
  //    只有「新起节已经越过了原止节」时才退化成单节。
  const rawEnd = numOr(adj.to_period_end, base.period_end);
  return {
    weekday: numOr(adj.to_weekday, base.weekday),
    period_start: start,
    period_end: rawEnd < start ? start : rawEnd,
    room: adj.to_room || base.room,
    note: adj.note || '',
    adjustment_id: adj.id,
    // 原落点一起带上：界面要能说清「原本是周三第 3-4 节」
    origin_weekday: base.weekday,
    origin_period_start: base.period_start,
    origin_period_end: base.period_end,
    // ⭐ 跨周调课：这条是「从第几周调过来的」；同周调课为 null
    moved_from_week: isCrossWeek(adj) ? numOr(adj.week_no, 0) : null,
  };
}

/**
 * 功能：把一个学期的课次合并上「某一周」的单次调课，输出该周真正要画的格子。
 *
 * 说明：⚠️ 入参 `cells` 必须**已经按周次筛过**（调用方负责），本函数只管调整这一层；
 *      停课的课次直接从结果里去掉（于是那一格空出来）。
 *
 * @param {Array.<Object>} cells - 该周的课次数组（已按 `weeksInclude` 过滤）
 * @param {Array.<Object>} adjustments - 该学期的全部调整行（不筛选，本函数按 key 取用）
 * @param {number} weekNo - 周次
 * @param {?Array.<Object>} [allCells] - 该学期的**全部**课次（不筛周）。跨周调课时，目标周的课次
 *     可能本来就不覆盖这一周（例如一门只上第 6 周的课调到第 8 周）—— 不传它就画不出目标周那一条。
 * @returns {Array.<Object>} 合并后的课次数组；被调课的格子额外带
 *     `adjusted` / `adjustment_id` / `adjust_note` / `origin_weekday` / `origin_period_start` / `origin_period_end`；
 *     跨周调课还带 `moved_out` + `moved_to_week` 等（源周灰条）或 `moved_from_week`（目标周那一条）
 */
function applyAdjustments(cells, adjustments, weekNo, allCells) {
  const idx = indexBySessionWeek(adjustments);
  const w = Number(weekNo);
  const out = [];
  (cells || []).forEach((c) => {
    const adj = idx.get(`${Number(c.session_id)}:${w}`);
    if (!adj) {
      out.push(c);
      return;
    }
    // ⭐ 跨周调课的**源周**：这一次课被挪到别的周去了 —— 原位留一张灰条写明去向，**不占课格**。
    //    「变灰色 并 显示 调到8周星期x第x-x节」。
    if (isCrossWeek(adj)) {
      out.push(
        Object.assign({}, c, {
          adjusted: KIND_MOVE,
          adjustment_id: adj.id,
          adjust_note: adj.note || '',
          moved_out: true,
          moved_to_week: targetWeekOf(adj),
          moved_to_weekday: numOr(adj.to_weekday, numOr(c.weekday, 1)),
          // ⚠️ 与 `slotOf()` 同一条回落规矩：止节缺省回落到**原本的止节**，不是新的起节
          moved_to_period_start: numOr(adj.to_period_start, numOr(c.period_start, 1)),
          moved_to_period_end: numOr(
            adj.to_period_end,
            numOr(c.period_end, numOr(c.period_start, 1)),
          ),
          moved_to_room: adj.to_room || c.room || '',
        }),
      );
      return;
    }
    const slot = slotOf(c, adj, w);
    if (!slot) return; // 停课：这一周不画
    out.push(
      Object.assign({}, c, {
        weekday: slot.weekday,
        period_start: slot.period_start,
        period_end: slot.period_end,
        room: slot.room,
        adjusted: adj.kind,
        adjustment_id: adj.id,
        adjust_note: slot.note,
        origin_weekday: slot.origin_weekday,
        origin_period_start: slot.origin_period_start,
        origin_period_end: slot.origin_period_end,
      }),
    );
  });
  // ⭐ 从别的周**调进本周**的条目：它们不在本周的 `cells` 里，要单独补上来（否则目标周看不见这次课）。
  //    ⚠️ 同一门课本周本来也有课时会多出一条（允许：「大学老师有事情调到后面
  //    一起上的太多了」）—— 刻意不去重。
  (adjustments || []).forEach((a) => {
    if (!isCrossWeek(a) || targetWeekOf(a) !== w) return;
    const c = (allCells || []).find((x) => Number(x.session_id) === Number(a.session_id));
    if (!c) return; // 课次已被删（后端会连带清调整行，这里只是兜底）
    const slot = slotOf(c, a, w);
    if (!slot) return;
    out.push(
      Object.assign({}, c, {
        weekday: slot.weekday,
        period_start: slot.period_start,
        period_end: slot.period_end,
        room: slot.room,
        adjusted: KIND_MOVE,
        adjustment_id: a.id,
        adjust_note: slot.note,
        origin_weekday: slot.origin_weekday,
        origin_period_start: slot.origin_period_start,
        origin_period_end: slot.origin_period_end,
        moved_from_week: slot.moved_from_week,
      }),
    );
  });
  return out;
}

/**
 * 功能：判断「把某条课次在第 W 周放到 `slot`」会不会和别的课撞上；撞了就给出撞的是哪一门。
 *
 * 说明：⭐ 为什么必须拦：课表是「人只有一个身体」的表 —— 同一周同一时段两门课，
 *      叠着画出来用户根本看不出有问题，而真实后果是他到教室才发现两门课都排在那。
 *      ⚠️ 判据是**合并调整之后**的实际落点：B 课自己也被调到这一格，同样算撞车。
 *      ⚠️ 允许「和自己撞」以外的任何情况返回冲突；`exceptSessionId` 用来把被调整的这条排掉。
 *
 * @param {Array.<Object>} cells - 该学期的**全部**课次（不筛选，本函数自己按周次判）
 * @param {Array.<Object>} adjustments - 该学期的全部调整行
 * @param {number} weekNo - 周次（跨周调课时传**目标周**）
 * @param {{weekday: number, period_start: number, period_end: number}} slot - 目标落点
 * @param {number} exceptSessionId - 被调整的那条课次 id（自己不算撞自己）
 * @param {?{selfAsOrigin: boolean}} [opts] - `selfAsOrigin=true`：对 `exceptSessionId` 那条，
 *     用**课次本位落点**比对而不是它自己的调整落点（跨周调课要用 —— 源周那一次不上，但同一门课
 *     若在本周本来还有一节、且正好压在目标格上，那就是真撞车，必须拦）
 * @returns {?Object} 撞到的课次 `{ session_id, name, room }`；没撞返回 null
 */
function findConflict(cells, adjustments, weekNo, slot, exceptSessionId, opts) {
  const idx = indexBySessionWeek(adjustments);
  const w = Number(weekNo);
  const want = numOr(slot.weekday, 0);
  const wantStart = numOr(slot.period_start, 0);
  const wantEnd = numOr(slot.period_end, wantStart);
  /** 功能：判断一个落点是否与目标格重叠。 @param {?Object} s - 落点。 @returns {boolean} 是否重叠。 */
  const hit = (s) =>
    !!s &&
    Number(s.weekday) === want &&
    !(s.period_end < wantStart || wantEnd < s.period_start);
  const selfAsOrigin = !!(opts && opts.selfAsOrigin);
  for (const c of cells || []) {
    const isSelf = Number(c.session_id) === Number(exceptSessionId);
    if (isSelf && !selfAsOrigin) continue;
    if (!weeksInclude(c.weeks, w)) continue;
    // 自己那一条：跨周调课时按**本位**落点比（不套用「把它调走了」这条调整）
    const own = isSelf ? null : idx.get(`${Number(c.session_id)}:${w}`);
    const s = slotOf(c, own, w);
    if (!s) continue; // 它这一周也停了（或跨周调走了）
    if (!hit(s)) continue;
    return { session_id: c.session_id, name: c.short_name || c.name || '', room: s.room || '' };
  }
  // ⭐ 从别的周调进本周的条目也占格 —— 不比对就会放行两次跨周调课调到同一格（画出来两门课重叠）。
  for (const a of adjustments || []) {
    if (!isCrossWeek(a) || targetWeekOf(a) !== w) continue;
    if (Number(a.session_id) === Number(exceptSessionId)) continue;
    const c = (cells || []).find((x) => Number(x.session_id) === Number(a.session_id));
    if (!c) continue;
    const s = slotOf(c, a, w);
    if (!hit(s)) continue;
    return { session_id: c.session_id, name: c.short_name || c.name || '', room: s.room || '' };
  }
  return null;
}

module.exports = {
  KIND_MOVE,
  KIND_CANCEL,
  targetWeekOf,
  isCrossWeek,
  indexBySessionWeek,
  slotOf,
  applyAdjustments,
  findConflict,
};
