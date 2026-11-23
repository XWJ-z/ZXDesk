'use strict';
/**
 * modules/ai/lib/tools.js —— ai辅助任务的**工具面底座**
 * 功能：把「AI 能用的工具」合成一张**静态定义表**（`TOOLS` = 读侧 10 条 + 写侧 5 条），
 * 并给出三件只此一处的东西 —— 合法模块名判据（`isValidModule`）、
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/16-AI辅助任务-3期-AI工具调用与授权.md
 */

const read = require('./tools-read.js');
const write = require('./tools-write.js');

/** 可以授权给 AI **读**的模块名（白名单，唯一出处在 `tools-read.js`）。 @type {Array.<string>} */
const READ_MODULES = read.READ_MODULES;

/** 可以授权给 AI **写**的模块名（白名单，唯一出处在 `tools-write.js`）。 @type {Array.<string>} */
const WRITE_MODULES = write.WRITE_MODULES;

/**
 * AI 卡片屏「AI 能力」那一块**逐字使用**的文案（本模块唯一的授权话术出处）。
 *
 */
const PANEL = {
  ...read.PANEL_READ,
  ...write.PANEL_WRITE,
};

/**
 *
 * 说明：每条字段 ——
 */
const TOOLS = [...read.READ_TOOLS, ...write.WRITE_TOOLS];

/**
 * 功能：判断模块名是不是「该授权方向下的合法值」—— 配置校验与视图清洗都问它。
 *
 * 说明：⭐ 两份清单唯一的出处是读 / 写两侧各自的常量，本函数是**唯一**读它们拼条件的地方
 * @param {'read'|'write'} mode - 授权方向
 * @param {string} name - 模块名
 */
function isValidModule(mode, name) {
  const list = mode === 'write' ? WRITE_MODULES : READ_MODULES;
  return list.includes(String(name == null ? '' : name).trim());
}

/**
 * 功能：给定一份授权，判断某个工具**现在能不能用**（纯函数，判据只吃 `aiAuthorizedTools()` 的产物）。
 *
 * 总开关关着 ⇒ 一律不可用（`auth.enabled` 为假时 `read` / `write` 本来就是空清单，
 * 这里再判一次是**故意的冗余**：调用方传什么进来都安全）。
 * `module === 'core'` 的工具（只有 `now.info`）不碰用户数据 ⇒ 总开关开着就可用。
 */
function isAuthorized(tool, auth) {
  const a = auth || {};
  if (!a.enabled) return false;
  if (tool.module === 'core') return true;
  const list = tool.mode === 'write' ? a.write : a.read;
  return Array.isArray(list) && list.includes(tool.module);
}

/** 功能：这个工具**本期有没有执行器**（读工具在、写工具在落地；表分别在读 / 写两侧）。 @param {Object} tool - `TOOLS` 里的一条 @returns {boolean} 有执行器为 true */
function hasExecutor(tool) {
  return !!(tool && (read.READ_EXEC[tool.name] || write.PROPOSE_EXEC[tool.name]));
}

/**
 * 功能：跑一条工具（读或写）的公共骨架 —— 守卫、上下文、错误归一都在这里，只此一处。
 *
 * @param {Object} tool - `TOOLS` 里的一条
 * @param {Object} store - 装配好的 store
 * @param {number} uid - 账号 id
 */
function execOnce(tool, store, uid, name, args, now, table) {
  const missing = table[name].need.filter((m) => typeof store[m] !== 'function');
  if (missing.length) {
    return { ok: false, status: 503, message: '这个功能当前不可用（对应的模块没装或已经关掉了）' };
  }
  const ctx = { store, uid: Number(uid), now: now instanceof Date ? now : new Date() };
  const today = read.dayStr(ctx.now);
  try {
    const out = table[name].run(ctx, args || {}, today);
    return tool.mode === 'read'
      ? { ok: true, status: 200, kind: 'read', result: out }
      : { ok: true, status: 200, kind: 'write', proposal: out };
  } catch (e) {
    // 两种错误形状都要认 —— `httpError`（core/http-util）挂 `statusCode`，
    // `core/store/helpers.js` 的 `badRequest` 挂的是 `status`；只认前者会把 store 层抛的
    // 入参错（如分类重名的 400）抬成 500，模型看到「内部错误」就不知道该怎么改说法了。
    const status = e && (e.statusCode || e.status) ? e.statusCode || e.status : 500;
    const fallback = tool.mode === 'read' ? '读取数据时出错了，请稍后再试' : '整理任务时出错了，请稍后再试';
    return { ok: false, status, message: status === 400 ? e.message : fallback };
  }
}

/**
 * 功能：执行一条工具（读或写）—— ⭐ 本模块唯一的执行入口，⛔ 一律不抛（除 400 入参错）。
 *
 * 说明：⚠️ 返回值刻意做成「结果对象」而不是抛异常：调用方（`/api/ai/tools/run` 与 chat 的
 * 工具循环）要按 `status` 分流 —— 接口层照错误出口四规则回，工具循环则把失败
 * **当成一条结果发回模型**（让它换个说法或者明说读不到），而不是把整轮对话打断。
 */
function runTool(store, uid, name, args, now) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!hasExecutor(tool)) return { ok: false, status: 404, message: '没有这个工具' };
  const table = tool.mode === 'read' ? read.READ_EXEC : write.PROPOSE_EXEC;
  return execOnce(tool, store, uid, name, args, now, table);
}

/**
 * 功能：只跑**读**工具（的入口，语义不变）—— 写工具在这里一律 404。
 *
 * 而写工具必须**另走一条**（它的产物是提议，不是数据）—— 两者的返回形状不同，
 * 混在一个函数里迟早有人把 `proposal` 当 `result` 用。
 *
 */
function runReadTool(store, uid, name, args, now) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || tool.mode !== 'read') return { ok: false, status: 404, message: '没有这个工具' };
  return runTool(store, uid, name, args, now);
}

module.exports = {
  READ_MODULES,
  WRITE_MODULES,
  PANEL,
  TOOLS,
  PROPOSE_MAX: write.PROPOSE_MAX,
  PROPOSE_ENTRY_MAX: write.PROPOSE_ENTRY_MAX,
  isValidModule,
  isAuthorized,
  hasExecutor,
  runTool,
  runReadTool,
};
