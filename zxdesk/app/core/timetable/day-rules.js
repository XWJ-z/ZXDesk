'use strict';
/**
 * core/timetable/day-rules.js —— 按天的假期调休：规则判定（**全项目唯一一份**）
 *
 * 功能：把 `timetable_day_rules` 的规则行解成「某一天实际上哪一天的课」——
 *      `ruleOn()` 取某天命中的规则，`resolveDay()` 给出这一天是停课、还是按另一天的课表上。
 *
 * ⭐ 为什么住在 `core/`：逐日展开课表的地方有**两处** —— 课表接口
 *    （`modules/timetable/routes.js` 的 `schedule`）与首页看板
 *    （`core/store/methods/stats.js` 的 `courseItems()`）。规则必须只有一份，
 *    否则会出现「课表页显示调休了、首页看板还按老课表显示」这种两端不一致。
 *    同类先例：`adjust-util.js` / `holiday-util.js` 也是「core 与模块共用」才留在 `core/`。
 *
 * ⚠️ 只解**一层**：`A 日补 B 日` 时，若 B 日本身也配了规则，**不跟着链下去** ——
 *    A→B→A 会绕成环，而用户的真实意图从来不是「链式借用」（要那样就该直接填 B 的课表日）。
 *
 * @author zx
 * @date   2026-09-16
 * @since 0.8.52
 * 相关：docs/公共/架构文档/06-课表.md
 */

const { weekNumberOf, weekdayOfDate, weeksInclude } = require('./date-util.js');
const { applyAdjustments } = require('./adjust-util.js');

/**
 * 功能：取某一天命中的调休规则。
 *
 * 说明：⚠️ 用**字符串逐字比对**而不是 `Date` 比较：规则里存的就是 `YYYY-MM-DD` 文本
 *      （见 `schema.js` 里那张表的说明），解析成时间再比会把时区搅进来。
 *
 * @param {Array.<Object>} rules - 规则行数组（每项含 `date` / `kind` / `to_date`）
 * @param {string} date - `YYYY-MM-DD`
 * @returns {?Object} 命中的规则行；没有规则或参数不合法时返回 null
 */
function ruleOn(rules, date) {
  if (!Array.isArray(rules) || !date) return null;
  const d = String(date);
  return rules.find((r) => r && String(r.date) === d) || null;
}

/**
 * 功能：解出「这一天实际上哪一天的课」。
 *
 * 说明：三种结果 ——
 *   · **停课**（`kind='off'`）→ `{ off: true, srcDate: null }`：这一天一节课都没有；
 *   · **补课**（`kind='swap'` 且 `to_date` 合法、又不等于本日）→ `{ off: false, srcDate: to_date }`：
 *     这一天按 `srcDate` 那一天的课表上（连**周次**也取那一天的 —— 「9/20 补 10/6」补的是
 *     第 N 周周二的课，不是「本周的周二课」）；
 *   · **没有规则**，或规则残缺（`swap` 缺 `to_date`）→ `{ off: false, srcDate: date }`：照常上本日的课。
 *
 * ⚠️ `swap` 的 `to_date` **等于本日**时按「无规则」处理：自己补自己是空转，算下去只会让这一天
 *    被搬到它自己身上（看起来像没生效，实际多绕一圈）。
 *
 * @param {Array.<Object>} rules - 规则行数组
 * @param {string} date - `YYYY-MM-DD`
 * @returns {{off: boolean, srcDate: ?string}} 判定结果（`srcDate` 在停课时为 null）
 */
function resolveDay(rules, date) {
  const r = ruleOn(rules, date);
  if (!r) return { off: false, srcDate: date };
  if (String(r.kind) === 'off') return { off: true, srcDate: null };
  const to = String(r.to_date || '').trim();
  if (String(r.kind) === 'swap' && to && to !== String(date)) return { off: false, srcDate: to };
  return { off: false, srcDate: date };
}

/**
 * 功能：查「**这一天的课已经被哪一天借走了**」。
 *
 * 说明：⭐ 0.6.2 调休把某天的课提前到另一天上之后，**原来那天的课要留在原位、
 *      变灰、标「已调休」** —— 不能一声不响地照常显示（用户会以为那天还得去上课），
 *      也不能直接抹掉（抹掉就看不出「这门课被挪走了」）。
 *      本函数就是那句标记的数据来源。
 * ⚠️ 只看 `kind='swap'` 且 `to_date` 正好等于这一天的规则（`off` 是「整天空掉」，没有「借走」一说）。
 *
 * @param {Array.<Object>} rules - 规则行数组
 * @param {string} date - `YYYY-MM-DD`
 * @returns {string} 借走它的那一天（`YYYY-MM-DD`）；没有被借走时是空串
 */
function movedToOn(rules, date) {
  if (!Array.isArray(rules) || !date) return '';
  const hit = rules.find((r) => r && String(r.kind) === 'swap' && String(r.to_date) === String(date));
  return hit ? String(hit.date) : '';
}

/**
 * 功能：按「按天调休」规则重排**某一周**的课次 —— 停课日清空、补课日借用源日期那一列的课。
 *
 * 说明：⭐ 抽成纯函数是为了**能被测到**：这段逻辑原本写在 `modules/timetable/routes.js` 的
 *      `schedule` 分支里，而那一段只有起 HTTP 才走得到。
 *      ⚠️ **只给单周视图用** —— 全学期视图里一条课次罩着 1-16 周，「这一天按哪天上」在那里
 *      没有单一答案（与「全学期视图不合并单次调课」是同一条理由）。
 *      ⚠️ 补课那一列要连**周次**一起借（「9/20 补 10/6」补的是第 N 周周二的课，不是「本周的周二课」），
 *      同时也要合并**源日期那一周**的单次调课 —— 否则「老师把周二那节课挪了」会在这天看得见、那天看不见。
 *      ⭐ 被调休碰到的课**不删**：留在原位并打上 `rescheduled: true`（`rescheduled_to` = 借走它的那一天），
 *      由界面画成「已调休」的灰条 —— 见下面函数体里的说明。
 *
 * @param {Array.<Object>} cells - 本周已经合并过单次调课的课次
 * @param {Object} term - 学期行（用 `start_monday` 把日期换算成周次 / 星期）
 * @param {Array.<Object>} days - `holiday-util.weekDaysOf()` 的结果，每项含 `weekday` / `date` /
 *     `day_rule`（这一天的规则）与 `rule_moved_to`（这一天的课被借到哪一天去了）
 * @param {Array.<Object>} allCells - 该学期**全部**课次（未按周过滤 —— 补课要从别的周里取）
 * @param {Array.<Object>} allAdjs - 该学期全部单次调课
 * @returns {Array.<Object>} 重排后的课次；**没有任何规则时原样返回入参**（不复制、不改写）
 */
function applyDayRules(cells, term, days, allCells, allAdjs) {
  if (!Array.isArray(days) || !days.length) return cells;
  const offDays = new Set(); // 停课日：整列清空
  const swapDays = new Set(); // 补课日：这一列换成借来的课（原有的课让位、留灰）
  const movedOff = new Map(); // 星期几 → 这一天的课被挪到哪一天去了（源日期那一列）
  const swaps = [];
  for (const d of days) {
    if (!d) continue;
    const wd = Number(d.weekday);
    if (d.rule_moved_to) movedOff.set(wd, String(d.rule_moved_to));
    const r = d.day_rule;
    if (!r) continue;
    if (r.kind === 'off') {
      offDays.add(wd);
      continue;
    }
    if (r.kind !== 'swap' || !r.to_date) continue;
    const srcWeek = weekNumberOf(term && term.start_monday, r.to_date);
    const srcWd = weekdayOfDate(r.to_date);
    // 源日期算不出周次（开学日为空 / 日期不合法）→ 这条规则**不生效**、该列保持原样：
    // 不猜、也不抛错 —— 课表照常显示，比整个接口 500 强。
    if (!(srcWeek >= 1) || !(srcWd >= 1)) continue;
    swapDays.add(wd);
    swaps.push({ weekday: wd, srcWeek, srcWd });
  }
  if (!offDays.size && !swapDays.size && !movedOff.size) return cells;

  // ⭐ 0.6.2：调休碰到的课**留在原位、变灰、标「已调休」** ——
  //    ① 源日期那一列（这节课已经被提前到别的日子上掉了）；
  //    ② 补课日本来那节课（被借来的课顶掉了，`rescheduled_to` 为空）。
  //    ⚠️ 从前这里是直接把①**抹掉**的 —— 抹掉就看不出「这门课被挪走了」，
  //    用户只会当它凭空消失；「看得见它被调休了」。
  const out = [];
  for (const c of cells) {
    const wd = Number(c.weekday);
    if (offDays.has(wd)) continue; // 停课日：一节课都没有
    if (swapDays.has(wd)) {
      out.push(Object.assign({}, c, { rescheduled: true, rescheduled_to: '' }));
      continue;
    }
    const to = movedOff.get(wd);
    out.push(to ? Object.assign({}, c, { rescheduled: true, rescheduled_to: to }) : c);
  }
  for (const s of swaps) {
    const srcCells = (allCells || []).filter(
      (c) => weeksInclude(c.weeks, s.srcWeek) && Number(c.weekday) === s.srcWd,
    );
    // ⚠️ 第 4 参传全量课次：借的这一天如果正好有课是**从别的周调进来**的，也该跟着搬过来
    applyAdjustments(srcCells, allAdjs || [], s.srcWeek, allCells || []).forEach((c) => {
      out.push(Object.assign({}, c, { weekday: s.weekday }));
    });
  }
  return out;
}

module.exports = { ruleOn, resolveDay, movedToOn, applyDayRules };
