'use strict';

/**
 * store/backend/index.js —— 存储原语层的**契约自检**
 * 功能：在模块加载时比对**每一对** `{sqlite,json}` 后端的 `ops` —— 键集合与每个 op 的形参个数必须完全一致，
 * `OPS` 供 `store/index.js` 的 `_bk` 门面按名字生成转发函数，本文件同时把两个后端原样再导出。
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */

const sqlite = require('./sqlite.js');
const json = require('./json.js');
const { registry, opsPairs } = require('../../../modules/registry.js');

/** 尚未搬进 `app/modules/` 的原语所在的来源名（第一对；模块全部搬完时这一对会变成空对象） */
const LEGACY_LABEL = 'store/backend（尚未搬进模块的原语）';

/**
 * 功能：比对**一对**后端的 ops（键集合 + 每个 op 的形参个数），把问题写进 `problems`。
 *
 * @param {Object} a - SQLite 后端的 `ops`
 * @param {Object} b - JSON 后端的 `ops`
 * @param {string} label - 出错信息里的来源名（哪个模块 / 哪对文件）
 */
function compareOps(a, b, label, problems, seen) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  const onlySqlite = ka.filter((k) => !kb.includes(k));
  const onlyJson = kb.filter((k) => !ka.includes(k));
  if (onlySqlite.length || onlyJson.length) {
    problems.push(
      `${label} 后端 ops 契约不一致：SQLite 独有 [${onlySqlite.join(', ')}] / JSON 独有 [${onlyJson.join(', ')}]` +
        '（两个后端必须实现同一组原语，业务方法才能不判别 backend）',
    );
  }
  for (const k of ka) {
    if (typeof b[k] === 'function' && a[k].length !== b[k].length) {
      problems.push(`${label} 的 op ${k} 形参个数不一致：sqlite ${a[k].length} 参 / json ${b[k].length} 参`);
    }
  }
  for (const k of ka) {
    const from = seen.get(k);
    if (from) problems.push(`op ${k} 同时来自「${from}」与「${label}」—— 后者会静默覆盖前者（搬家时旧的忘了删？）`);
    else seen.set(k, label);
  }
  return ka;
}

/**
 * 功能：比对全部后端对的 `ops`（旧的两个大文件 + 每个已搬迁模块自己的一对），并返回排好序的 op 名字清单。
 *
 * @returns {Array.<string>} 排好序的 op 名字清单
 * @throws {Error} 某一对里 op 名称不一致、形参个数不一致、跨来源重名，或一对 op 都没有时抛出
 */
function assertOpsContract() {
  const pairs = collectPairs();

  const problems = [];
  const seen = new Map();
  const names = [];
  for (const p of pairs) {
    const ka = compareOps(p.a, p.b, p.label, problems, seen);
    if (ka.length === 0) problems.push(`${p.label} 一个 op 都没有 —— 原语层没装配上`);
    names.push(...ka);
  }

  if (problems.length)
    throw new Error(`后端 ops 契约自检失败（共 ${problems.length} 处）：\n  ${problems.join('\n  ')}`);
  if (names.length === 0) throw new Error('后端 ops 一个都没有 —— 原语层没装配上');
  return [...new Set(names)].sort();
}

/**
 * 功能：收集**全部**后端对 —— 旧的两个大文件（第一对）+ 每个已搬迁模块自己的一对。
 * @returns {Array.<{label: string, a: Object, b: Object}>} 逐对比对的对象
 */
function collectPairs() {
  return [
    { label: LEGACY_LABEL, a: sqlite.ops, b: json.ops },
    ...opsPairs(registry).map((p) => ({ label: p.label, a: p.sqlite, b: p.json })),
  ];
}

/**
 * 功能：把两个后端各自的全部 op 汇成**一张名字 → 函数**的表（旧的大文件 + 已搬迁模块的一对）。
 *
 * `sqlite.ops[k]` / `json.ops[k]`，**只认那两个大文件**；模块把 op 搬走之后，
 * 门面就会去一个已经没有这个键的对象上取，表现是
 * `Cannot read properties of undefined (reading 'apply')`（**运行期**，而且只在走到那条路径时）。
 */
function mergedOpsOf(backend) {
  const out = { ...(backend === 'sqlite' ? sqlite.ops : json.ops) };
  for (const p of opsPairs(registry)) Object.assign(out, backend === 'sqlite' ? p.sqlite : p.json);
  return out;
}

/** op 名字清单（`store/index.js` 的 `_bk` 门面按它生成转发函数） */
const OPS = assertOpsContract();

/** 合并后的两个后端原语表：`_bk` 门面按**调用时刻**的 backend 从这里取函数 */
const MERGED_OPS = { sqlite: mergedOpsOf('sqlite'), json: mergedOpsOf('json') };

module.exports = { OPS, MERGED_OPS, assertOpsContract, collectPairs, sqlite, json };
