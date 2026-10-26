/**
timetable/schedule-solve.js —— 作息求解（时段块 → 逐节时间）
 *
 * 功能：把「时段块」解成逐节时间 —— 生成默认节次（`generatePeriods`）、算块时长
 *      （`blockDuration`）、用「节次覆盖」与「时长拟合」两个**独立信号交叉求解**上课时间
 *      （`fitClassTimes` / `bestSplits` / `sameNums` / `solveSchedule`），
 *      以及解析节次串与连续区段（`parsePeriodNumbers` / `contiguousRuns`）。
 *
 * ⚠️ 为什么是「两个独立信号交叉」：真实课表里「第 1 节」几点开始**不写在格子里**，
 *    只能从「节次覆盖了哪几行」与「每节课多长」两头夹逼；单靠任一头都会被样本推翻。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

const { fmtMin, numOr, toMin } = require('./date-util.js');

/**
 * 功能：由时段块生成逐节时间表（需求 2 的四个参数就在这一层）。
 *
 * 说明：`block_index` 指向入参数组下标 —— 落库时再换成真实 `block_id`；
 *      某块起始时间读不出时，仍按节数补齐占位条目，只是时间留空。
 *
 * @param {Array.<Object>} blocks - 时段块数组，每块用到 `period_count` / `class_minutes` / `break_minutes` / `start_time`
 * @returns {Array.<Object>} 逐节条目，形如 `{ index_no, block_index, start_time, end_time }`
 */
function generatePeriods(blocks) {
  const out = [];
  let index = 1;
  (blocks || []).forEach((b, bi) => {
    const n = Math.max(0, Math.floor(numOr(b.period_count, 0)));
    const cls = Math.max(1, Math.floor(numOr(b.class_minutes, 45)));
    const brk = Math.max(0, Math.floor(numOr(b.break_minutes, 5)));
    const startMin = toMin(b.start_time);
    if (startMin === null) {
      for (let k = 0; k < n; k++) out.push({ index_no: index++, block_index: bi, start_time: '', end_time: '' });
      return;
    }
    let cur = startMin;
    for (let k = 0; k < n; k++) {
      out.push({ index_no: index++, block_index: bi, start_time: fmtMin(cur), end_time: fmtMin(cur + cls) });
      cur += cls + brk;
    }
  });
  return out;
}

/**
 * 功能：算一个时段块的总时长（分钟）。
 *
 * @param {Object} b - 时段块，用到 `start_time` / `end_time`
 * @returns {?number} 时长分钟数；起止时间读不出、或止不晚于起时返回 null
 */
function blockDuration(b) {
  const s = toMin(b.start_time);
  const e = toMin(b.end_time);
  if (s === null || e === null || e <= s) return null;
  return e - s;
}

/**
 * 功能：信号② —— 由「块时长」穷举求解 `(每节分钟, 课间分钟)`。
 *
 * 说明：判据是**精确整除**（残差必须为 0）：`时长 = 节数 × 课时 + (节数−1) × 课间`。
 *      返回 `[{ c, b, n: [..] }]`（可能有多个解 —— 样本上就有 (20,5) 与 (45,5) 两组）。
 *
 * @param {Array.<Object>} blocks - 时段块数组
 * @returns {Array.<Object>} 所有能精确拟合的解，每项含每节分钟 `c`、课间分钟 `b` 与各块节数 `n`
 */
function fitClassTimes(blocks) {
  const durs = (blocks || []).map(blockDuration);
  if (!durs.length || durs.some((d) => d === null)) return [];
  const out = [];
  for (let c = 10; c <= 90; c++) {
    for (let b = 0; b <= 45; b++) {
      const n = [];
      let ok = true;
      for (const d of durs) {
        const k = Math.round((d + b) / (c + b));
        if (k < 1 || k * c + (k - 1) * b !== d) {
          ok = false;
          break;
        }
        n.push(k);
      }
      if (ok) out.push({ c, b, n });
    }
  }
  return out;
}

/**
 * 功能：把 `1..total` 拆成 `parts` 份连续正整数时，返回覆盖得分最高的那些拆法（动态规划，允许并列）。
 *
 * 说明：得分按「`[节次]` 区间完整落在本行内」的条目数累计 —— 这是作息求解的信号①。
 *
 * @param {Array.<Array.<Array.<number>>>} rowPeriods - 每行解析到的节次分组，供覆盖打分
 * @param {number} total - 需要拆分的总小节数
 * @param {number} parts - 要拆成的份数（即时段块数）
 * @returns {{score: number, splits: Array.<Array.<number>>}} 最高得分与所有并列最优拆法；无解时得分为 -Infinity、拆法为空
 */
function bestSplits(rowPeriods, total, parts) {
  /**
   * 功能：统计第 `i` 行里有多少条 `[节次]` 分组完整落在 `[lo, hi]` 这一段内。
   *
   * @param {number} i - 行下标
   * @param {number} lo - 划分段的起始小节号
   * @param {number} hi - 划分段的结束小节号
   * @returns {number} 完整落入该段的节次分组条数
   */
  const cover = (i, lo, hi) => {
    let n = 0;
    for (const ps of rowPeriods[i] || []) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const p of ps) {
        if (p < mn) mn = p;
        if (p > mx) mx = p;
      }
      if (mn >= lo && mx <= hi) n++;
    }
    return n;
  };

  const NEG = -Infinity;
  const dp = Array.from({ length: parts + 1 }, () => new Array(total + 1).fill(NEG));
  const from = Array.from({ length: parts + 1 }, () => new Array(total + 1).fill(null));
  dp[0][0] = 0;
  for (let i = 1; i <= parts; i++) {
    for (let j = i; j <= total - (parts - i); j++) {
      for (let n = 1; n <= j - (i - 1); n++) {
        const lo = j - n + 1;
        const prev = dp[i - 1][lo - 1];
        if (prev === NEG) continue;
        const sc = prev + cover(i - 1, lo, j);
        if (sc > dp[i][j]) {
          dp[i][j] = sc;
          from[i][j] = [n];
        } else if (sc === dp[i][j] && dp[i][j] !== NEG) {
          from[i][j].push(n);
        }
      }
    }
  }
  if (dp[parts][total] === NEG) return { score: NEG, splits: [] };

  // 回溯所有并列最优
  const splits = [];
  /**
   * 功能：顺着 `from` 表回溯，把一条到达当前状态的拆法收进 `splits`。
   *
   * @param {number} i - 已处理的份数
   * @param {number} j - 已用掉的小节号上限
   * @param {Array.<number>} acc - 回溯过程中累积的每份小节数（倒序）
   * @returns {void}
   */
  const walk = (i, j, acc) => {
    if (i === 0) {
      splits.push(acc.slice().reverse());
      return;
    }
    for (const n of from[i][j] || []) {
      const lo = j - n + 1;
      if (dp[i - 1][lo - 1] + cover(i - 1, lo, j) === dp[i][j]) {
        acc.push(n);
        walk(i - 1, lo - 1, acc);
        acc.pop();
      }
    }
  };
  walk(parts, total, []);
  return { score: dp[parts][total], splits };
}

/**
 * 功能：判断两个数字数组是否逐项相等。
 *
 * 说明：用来比对信号①的节次划分与信号②拟合出的节数是不是同一组。
 *
 * @param {Array.<number>} a - 数组一
 * @param {Array.<number>} b - 数组二
 * @returns {boolean} 长度相同且逐项相等时为 true
 */
const sameNums = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 功能：求解「每个时段块占哪几个小节」以及「每节多长、课间多长」。
 *
 * 说明：⭐ **两个独立信号必须交叉**：
 *      ① 节次覆盖 —— 正确的划分会让尽可能多的 `[节次]` 区间完整落在它所属的行内；
 *      ② 时长拟合 —— 块时长必须能被 `节数×课时+(节数−1)×课间` 精确整除。
 *      单独任何一个都不唯一：样本上 ① 有并列最优（[2,2,3,2,3] 与 [2,2,4,1,3] 同为 14 分），
 *      ② 也有多解（(20,5) 与 (45,5) 都能精确拟合）。交集才是唯一的。
 *      交集为空时不猜，按块时长均分，并把置信度标成 `low` 提醒人工确认。
 *
 * @param {Array.<Object>} blocks - 时段块数组
 * @param {Array.<Array.<Array.<number>>>} rowPeriods - 每行解析到的节次分组
 * @returns {Object} 求解结果：`ok` 是否可信、`splits` 各块小节数、`classMinutes` 每节分钟、
 *                    `breakMinutes` 课间分钟、`confidence` 置信度（`high` / `medium` / `low`）、`note` 中文说明
 */
function solveSchedule(blocks, rowPeriods) {
  const parts = (blocks || []).length;
  let total = 0;
  (rowPeriods || []).forEach((ps) => {
    ps.forEach((one) => {
      one.forEach((p) => {
        if (p > total) total = p;
      });
    });
  });
  if (!parts || total < parts) {
    return {
      ok: false,
      splits: [],
      classMinutes: 45,
      breakMinutes: 5,
      confidence: 'low',
      note: '无法从格子里推出节次划分（缺少 [节次] 或时段块数与小节数不匹配），已按块时长均分',
    };
  }

  const cover = bestSplits(rowPeriods, total, parts);
  const fits = fitClassTimes(blocks).filter((f) => f.c >= 25 && f.c <= 60);
  const inter = cover.splits.map((n) => ({ n, fit: fits.find((f) => sameNums(f.n, n)) })).filter((x) => x.fit);

  if (inter.length === 1) {
    const { n, fit } = inter[0];
    return {
      ok: true,
      splits: n,
      classMinutes: fit.c,
      breakMinutes: fit.b,
      confidence: 'high',
      note: `节次覆盖与块时长两个信号一致：${n.join('+')} 节，每节 ${fit.c} 分钟、课间 ${fit.b} 分钟`,
    };
  }
  if (inter.length > 1) {
    // 多解：选最接近「45 分钟一节 / 5 分钟课间」的那组
    inter.sort(
      (a, b) => Math.abs(a.fit.c - 45) + Math.abs(a.fit.b - 5) - (Math.abs(b.fit.c - 45) + Math.abs(b.fit.b - 5)),
    );
    const { n, fit } = inter[0];
    return {
      ok: true,
      splits: n,
      classMinutes: fit.c,
      breakMinutes: fit.b,
      confidence: 'medium',
      note: `有 ${inter.length} 组作息都能对上，已选最接近常规的（${n.join('+')} 节，每节 ${fit.c} 分钟 / 课间 ${fit.b} 分钟），请确认`,
    };
  }

  // 交集为空：不猜，走「均分」并显著标注
  const n = cover.splits.length ? cover.splits[0] : new Array(parts).fill(1);
  return {
    ok: false,
    splits: n,
    classMinutes: 45,
    breakMinutes: 5,
    confidence: 'low',
    note: '节次覆盖与块时长对不上（可能是大课间或非 45 分钟一节），已按块时长均分，请人工确认作息',
  };
}

/**
 * 功能：从节次文本里抽出节次号数组，例：`[01-02-03-04]节` / `1-2节` → `[1,2,3,4]`。
 *
 * 说明：超出 1..60 或转不成数字的号一律丢弃。
 *
 * @param {string} s - 节次号串
 * @returns {?Array.<number>} 节次号数组；一个有效号都没有时返回 null
 */
function parsePeriodNumbers(s) {
  const nums = String(s)
    .split(/[-–—~,，、\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 60);
  return nums.length ? nums : null;
}

/**
 * 功能：把一组节次号拆成若干「连续段」：`[1,2,3,5]` → `[[1,2,3],[5]]`。
 *
 * 说明：用于把跨小节的连堂课合并成一次课次。
 *
 * @param {Array.<number>} nums - 节次号（允许重复与乱序）
 * @returns {Array.<Array.<number>>} 去重升序后的连续段
 */
function contiguousRuns(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[last.length - 1] + 1) last.push(n);
    else runs.push([n]);
  }
  return runs;
}

module.exports = {
  generatePeriods,
  blockDuration,
  fitClassTimes,
  bestSplits,
  sameNums,
  solveSchedule,
  parsePeriodNumbers,
  contiguousRuns,
};
