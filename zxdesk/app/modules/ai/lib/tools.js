'use strict';
/**
 * modules/ai/lib/tools.js —— ai辅助任务的**工具面底座**（3 期落地，`0.7.6` 拆出读写实现）
 *
 * 功能：把「AI 能用的工具」合成一张**静态定义表**（`TOOLS` = 读侧 10 条 + 写侧 5 条），
 *      并给出三件只此一处的东西 —— 合法模块名判据（`isValidModule`）、
 *      「某份授权下这个工具可不可用」的纯函数判据（`isAuthorized`）、以及**唯一**的执行入口
 *      （`runTool` / `runReadTool`，公共骨架 `execOnce`）。
 *
 * ⚠️ 拆分口径（「把 tools.js 拆分为 tools-read.js 和 tools-write.js」）：
 *    · 读侧实现（目录项 + 执行器 + 时间换算 + 入参错构造）→ `tools-read.js`；
 *    · 写侧实现（目录项 + 提议构造 + 上限）→ `tools-write.js`；
 *    · **目录合并 + 判据 + 分发留在这里** —— 因为 `TOOLS` 必须是**全量**（界面要能画出
 *      「哪些开着、哪些没开」，`GET /api/ai/tools` 回的是全表），而判据同时要用两份清单；
 *      把合并交给调用方＝造出第二份真值（本项目最贵的病）。
 *    ⭐ 本文件因此仍是**对外的唯一入口**：导出**逐字未变**，`routes.js` / `store.js` /
 *      `openai-client.js` / `ai.test.js` 一行都不用改。
 *
 * ⚠️⭐ **依赖方向**：`tools.js → {tools-read.js, tools-write.js}`，且 `tools-write.js → tools-read.js`
 *    （写侧只取一个 `httpError`）—— 严格单向、无环。⛔ 别让子文件 require 回本文件。
 *
 * ⭐ **硬边界就写在这里，且只有这一份**：`vault`（密码库）与
 *    `chat`（对话）**永远不在**这张表里、也永远不在两个清单里 —— 界面上连开关都没有。
 *    没有开关 = 不会误开，比「默认关」更硬。⚠️ 判据是「**表里没有**」而不是「有一处 if 拦着」：
 *    往任一侧的目录里加一条 `vault` 就等于把它放进了工具面（`ai.test.js` 有硬边界扫描用例咬住）。
 *
 * ⚠️ 本文件只 require **本模块的两个纯数据文件**（它们都不 require 任何东西）：
 *    一旦顺着装配链拉进 `core/context.js`（一 require 就建库），存储层单测会当场失去独立性。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.5
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/16-AI辅助任务-3期-AI工具调用与授权.md
 */

const read = require('./tools-read.js');
const write = require('./tools-write.js');

/** 可以授权给 AI **读**的模块名（白名单，唯一出处在 `tools-read.js`）。 @type {Array.<string>} */
const READ_MODULES = read.READ_MODULES;

/** 可以授权给 AI **写**的模块名（白名单，唯一出处在 `tools-write.js`）。 @type {Array.<string>} */
const WRITE_MODULES = write.WRITE_MODULES;

/**
 * ⭐ AI 卡片屏「AI 能力」那一块**逐字使用**的文案（本模块唯一的授权话术出处）。
 *
 * 说明：⚠️ 每个开关**旁边**都要有一句人话（不是底部一句免责声明）—— 这是定调的第 3 条
 *      「选择权交给用户 + 尽到风险告知义务」。所以文案写得具体到「哪几个字段会出去」。
 *      ⚠️ 读侧几句在 `tools-read.js` 的 `PANEL_READ`、写侧与审计在 `tools-write.js` 的
 *      `PANEL_WRITE`，**在这里合成一份**给界面与测试用（⛔ 对外只有这一个 `PANEL`）。
 *      ⚠️ 与 `shared.js` 的一致性由测试盯着，两边改一处必须改另一处。
 *      ⚠️ 这些句子刻意**不带 markdown 星号**：它是界面上直接显示的纯文本。
 * @type {{boundary: string, master: string, tasksRead: string, timetableRead: string,
 *         ledgerRead: string, bookmarksRead: string, ideaRead: string, hardwareRead: string,
 *         tasksWrite: string, ledgerWrite: string, bookmarksWrite: string, ideaWrite: string,
 *         hardwareWrite: string, audit: string, coreTime: string}}
 */
const PANEL = {
  ...read.PANEL_READ,
  ...write.PANEL_WRITE,
};

/**
 * 工具定义表（0.8.5 共 15 条：10 条读 + 5 条写 —— 读侧在 `tools-read.js`、写侧在 `tools-write.js`）。
 *
 * 说明：每条字段 ——
 *      · `name`：工具名（`模块.动作`，服务端与模型之间的约定串）；
 *      · `module`：归属模块（`core` = 不属于任何数据模块，只回服务端自己的时间）；
 *      · `mode`：`'read'` 自动执行 / `'write'` **只生成提议**（一律过确认卡，方案 §4.4）；
 *      · `title`：给用户看的一句短名；
 *      · `purpose`：**用途**（为什么给它这个数据）；
 *      · `share`：**出网面** —— 这条工具会把什么发出去（与 `PANEL` 同源，改一处即两处）；
 *      · `args`：入参（窄契约：能用枚举就用枚举，⛔ 不收自由文本当参数，方案 §4.5-1）；
 *      · `returns`：返回字段（⭐ = 排期必需的那几样）。
 *      ⚠️ 顺序 = 读（`now.info` → `tasks.query` → `timetable.range` → `timetable.next` →
 *      记账那三条 → **0.8.5 那三条（收藏夹 / 随手记 / 硬件）**）再接写（任务 → 记账 →
 *      **0.8.5 那三条**）—— `GET /api/ai/tools` 按这个顺序回给界面，别打乱。
 * @type {Array.<Object>}
 */
const TOOLS = [...read.READ_TOOLS, ...write.WRITE_TOOLS];

/**
 * 功能：判断模块名是不是「该授权方向下的合法值」—— 配置校验与视图清洗都问它。
 *
 * 说明：⭐ 两份清单唯一的出处是读 / 写两侧各自的常量，本函数是**唯一**读它们拼条件的地方
 *      （⛔ 别处不许再手写一份白名单）。
 * @param {'read'|'write'} mode - 授权方向
 * @param {string} name - 模块名
 * @returns {boolean} 合法为 true
 */
function isValidModule(mode, name) {
  const list = mode === 'write' ? WRITE_MODULES : READ_MODULES;
  return list.includes(String(name == null ? '' : name).trim());
}

/**
 * 功能：给定一份授权，判断某个工具**现在能不能用**（纯函数，判据只吃 `aiAuthorizedTools()` 的产物）。
 *
 * 说明：⭐ 唯一判据是 `store.aiAuthorizedTools(uid)`（方案 §5.2）—— 本函数只是「工具 → 需要哪一档授权」
 *      的映射，**不自己去读那两列**（⛔ 不许各处自己拼条件，那是「两份口径」的病根）。
 *      ⚠️ 总开关关着 ⇒ 一律不可用（`auth.enabled` 为假时 `read` / `write` 本来就是空清单，
 *      这里再判一次是**故意的冗余**：调用方传什么进来都安全）。
 *      ⚠️ `module === 'core'` 的工具（只有 `now.info`）不碰用户数据 ⇒ 总开关开着就可用。
 *
 * @param {Object} tool - `TOOLS` 里的一条
 * @param {{enabled: boolean, read: Array.<string>, write: Array.<string>}} auth - `aiAuthorizedTools()` 的产物
 * @returns {boolean} 可用为 true
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
 * @param {string} name - 工具名
 * @param {Object} args - 模型给的入参
 * @param {Date} now - 服务端当前时刻
 * @param {Object} table - 执行表（读侧的 `READ_EXEC` 或写侧的 `PROPOSE_EXEC`）
 * @returns {Object} 结果对象（读带 `result`、写带 `proposal`）
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
    const status = e && e.statusCode ? e.statusCode : 500;
    const fallback = tool.mode === 'read' ? '读取数据时出错了，请稍后再试' : '整理任务时出错了，请稍后再试';
    return { ok: false, status, message: status === 400 ? e.message : fallback };
  }
}

/**
 * 功能：执行一条工具（读或写）—— ⭐ 本模块唯一的执行入口，⛔ 一律不抛（除 400 入参错）。
 *
 * 说明：⚠️ 返回值刻意做成「结果对象」而不是抛异常：调用方（`/api/ai/tools/run` 与 chat 的
 *      工具循环）要按 `status` 分流 —— 接口层照错误出口四规则回，工具循环则把失败
 *      **当成一条结果发回模型**（让它换个说法或者明说读不到），而不是把整轮对话打断。
 *      ⚠️ `404` 的文案**不回显**调用方传来的那个名字：响应里因此不会出现 `vault` / `chat`
 *      这类硬边界词（与 `routes.js` 的 `checkToolModules` 同一条红线的另一半）。
 *      ⚠️ 写工具走到这里也**只回提议**：`kind:'write'` 的那一支不碰任何表。
 *
 * @param {Object} store - 装配好的 store（`core/context.js` 的产物）
 * @param {number} uid - 账号 id
 * @param {string} name - 工具名
 * @param {Object} [args] - 模型给的入参
 * @param {Date} [now] - 服务端当前时刻（测试注入口；缺省取真实时钟）
 * @returns {{ok: boolean, status: number, kind?: string, result?: Object, proposal?: Object, message?: string}} 执行结果
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
 * 说明：⚠️ 留着它是因为「读」这条路上有两个调用点（`/run` 的读分支与 chat 循环），
 *      而写工具必须**另走一条**（它的产物是提议，不是数据）—— 两者的返回形状不同，
 *      混在一个函数里迟早有人把 `proposal` 当 `result` 用。
 *
 * @param {Object} store - 装配好的 store
 * @param {number} uid - 账号 id
 * @param {string} name - 工具名
 * @param {Object} [args] - 模型给的入参
 * @param {Date} [now] - 服务端当前时刻
 * @returns {Object} 结果对象（形状同 `runTool`，但只可能是读）
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
