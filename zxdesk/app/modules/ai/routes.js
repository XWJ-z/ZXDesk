/**
 * modules/ai/routes.js —— ai辅助任务路由（0.6.0）
 *
 * 功能：`handleAi` 一处收全部 AI 接口 ——
 *      · `GET  /api/ai/config`            配置视图（**永不含 key 的任何投影**）
 *      · `PUT  /api/ai/config`            保存（只写请求里真带了的字段；key 明文现场封装；
 *                                         ⭐ 2 期多认 3 个键：`ctx_max_turns` / `mem_enabled` / `mem_max`）
 *      · `POST /api/ai/config/clear-key`  显式清除 key（幂等）
 *      · `POST /api/ai/test`              测连通（GET {base}/models，省额度）
 *      · `POST /api/ai/chat`              聊天（**流式 SSE**：delta → done；错误走 error 帧不落库）
 *                                         ⭐ 2 期：带上「本段的上下文 + 记忆」，`done` 帧回 `used` 用量
 *      · `POST /api/ai/chat/new`          ⭐ 2 期：开启新对话（返回新段号；幂等；**不删任何消息**）
 *      · `GET  /api/ai/memories`          ⭐ 2 期：记忆列表
 *      · `POST /api/ai/memories`          ⭐ 2 期：新增一条记忆（201）
 *      · `PUT  /api/ai/memories/<id>`     ⭐ 2 期：改一条（越权 / 不存在统一 404）
 *      · `DELETE /api/ai/memories/<id>`   ⭐ 2 期：删一条（幂等；越权 / 不存在统一 404）；
 *                                                            ⚠️ 0.7.7-⑱：预设三条（用户名称 / AI助手名称 / 约定）
 *                                                            删不掉 ⇒ 400 说人话
 *      · `POST /api/ai/memories/clear`    ⭐ 2 期：清空（返回删掉的条数）；
 *                                                            ⚠️ 0.7.7-⑱：预设三条不删，只清空内容
 *      · `POST /api/ai/proposals/<id>`    ⭐ 0.7.7-⑲：对一张任务确认卡表态
 *                                                            `{ action: 'agree'|'reject', added?, failed? }`
 *      · `POST /api/ai/extract`           指挥 AI 建任务（**只提议**，返回结构化草稿，落库由前端调既有任务接口）
 *      · `GET  /api/ai/messages`          AI 会话历史（游标翻页；⭐ 2 期：每项带 `segment`、
 *                                         可选 `?segment=N` 过滤；**不带 = 返回全部**，见下面说明）
 *      · ⭐ 3 期：
 *        `GET  /api/ai/tools`             当前可用工具清单（含**用途**与**出网面说明**，给人看的）
 *        `GET  /api/ai/audit`             审计列表（本次运行期间的最近 N 条；⛔ 不含内容与 key）
 *
 * ⭐ **本文件是全项目第一个「出网」的接口层**，三条硬规矩（方案 §八）：
 *      ① 节流 —— 出网动作（test / chat / extract）共用一个**每账号滑动窗口**（10 次/分钟），
 *         超限 429 直接 `json()`（鉴权类出口），绝不静默丢；
 *      ② 上游错误**不透传** —— 带给前端的每个错误文案都来自 `lib/openai-client.js` 的转译表，
 *         上游错误体 / key / 消息原文一个字都不进响应、不进日志；
 *      ③ **没有任何写任务表的接口** —— 确认卡落库由前端调既有 `POST /api/daily` /
 *         `POST /api/projects/:id/tasks`（`from_message_id` 口径），任务模块一行不改。
 *
 * ⭐ **异步出网的错误要自己接住**：`readBody` 的回调只兜**同步** throw；出网是异步的，
 *      所以每个出网分支都包 `(async () => { … })().catch((e) => fail(res, e))` ——
 *      不接住的话请求会挂到前端超时，页面上一句错误都没有。
 *
 * ⭐ **KEK 的来源**：`core/context.js` 的 `AUTH_SECRET`（实例密钥）经 `lib/seal.js` 的 `deriveKek()`
 *      派生，每次 handler 调用时现派（HKDF 微秒级）；⚠️ KEK 不进日志、不进任何错误信息、不进返回值。
 *
 * ⭐ **2 期往这里加的三件事**：① 记忆的 5 个接口与「开启新对话」（都**不出网**，
 *      所以**不进节流窗口** —— 节流只管 `test` / `chat` / `extract` 那三个真会发请求的）；
 *      ② `chat` 的 system 提示词里追加**记忆段落**（用现成注入点，不新建链路）；
 *      ③ `done` 帧带上 `used{msgs,chars,mems,seg}` —— 数字**必须来自实际拼进请求的那一组消息**，
 *      界面上那句「本次带了 N 条历史 · M 条记忆」才是实话（⛔ 不是估算、不是配置值）。
 *      ⚠️ 记忆内容与 key 一样**不进日志、不进错误信息**（方案 §八-2）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.61
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、docs/公共/开发方案/14-AI辅助任务-2期.md
 */
'use strict';

const { checkAiConfig, checkAiChat, checkAiExtract, parseImageDataUrl, DATE_RE } = require('../../core/validate.js');
const { json, notFound, readBody, readRawBody, fail, httpError } = require('../../core/http-util.js');
const { store, AUTH_SECRET } = require('../../core/context.js');
const seal = require('./lib/seal.js');
const client = require('./lib/openai-client.js');
const tools = require('./lib/tools.js');

/**
 * 功能：派生本模块的 KEK（每次调用现派，见文件头「KEK 的来源」）。
 * @returns {Buffer} 32 字节 KEK
 */
function aiKek() {
  return seal.deriveKek(AUTH_SECRET);
}

// ---- 节流----
/** 每账号每窗口的出网次数上限 @type {number} */
const AI_RATE_LIMIT = 10;
/** 滑动窗口宽度（毫秒）：60 秒 @type {number} */
const AI_RATE_WINDOW_MS = 60000;
/** 滑动窗口记账表：`uid → 时间戳数组`（进程内状态，重启即清 —— 节流不是配额） @type {Map.<number, Array.<number>>} */
const rateWindow = new Map();

/**
 * 功能：给一次出网动作记账并判断是否放行（滑动窗口：只数最近 60 秒内的）。
 * @param {number} uid - 账号 id
 * @returns {boolean} 放行为 true；超限为 false（调用方回 429）
 */
function aiAllow(uid) {
  const now = Date.now();
  const arr = (rateWindow.get(Number(uid)) || []).filter((t) => now - t < AI_RATE_WINDOW_MS);
  if (arr.length >= AI_RATE_LIMIT) {
    rateWindow.set(Number(uid), arr);
    return false;
  }
  arr.push(now);
  rateWindow.set(Number(uid), arr);
  return true;
}

/** 超限的 429 文案（鉴权类出口：直接 `json()`） */
const RATE_MSG = `操作太频繁了（每分钟最多 ${AI_RATE_LIMIT} 次），请稍等一会再试`;

/** 审计一次最多回几条（⭐ 与 `store.js` 的 `AUDIT_MAX` 同值 —— 改一处必须改另一处） @type {number} */
const AI_AUDIT_MAX = 200;

/**
 * 未授权就调用工具时的 403 文案 —— ⭐ 必须是**人话且说清去哪儿开**（方案 §4.5 第 6 条：失败要响）。
 *
 * 说明：⚠️ 403 走 `json()`（鉴权类出口），不是 `fail()`。
 *      ⚠️ 文案里**不许**出现硬边界的名字（那是「报错文案泄露探测通道」）。
 * @type {string}
 */
const TOOL_DENIED_MSG =
  '这个工具还没有授权给 AI。请到「AI 辅助任务」的「AI 能力」里打开总开关，并勾上对应的模块。';

/**
 * 一轮对话里最多执行几次工具（方案 §4.5 第 4 条：限次）。
 *
 * 说明：⚠️ 这是「读工具」的轮次上限 —— 模型每轮只许输出一个意图（协议如此），
 *      超过就停手把已有信息交给它收尾，⛔ 不让它无限读下去（那是在烧上游额度）。
 * @type {number}
 */
const TOOL_ROUND_MAX = 3;

/**
 * 功能：把工具入参压成一段**能进审计的摘要** —— ⛔ 不含用户内容。
 *
 * 说明：⭐ 判据是「**短**且是标量」：本期的读工具入参全是枚举（`range=week`），所以这一条
 *      天然只留下枚举值；而的写工具入参里有**任务标题**（那是用户内容）——
 *      它长度超过 20 就会被这里整条丢掉（§13.7 第 10 条：审计里不许记内容）。
 * @param {Object} args - 工具入参
 * @returns {string} 形如 `range=week days=today`；没有可记的项时为空串
 */
function briefToolArgs(args) {
  const src = args && typeof args === 'object' ? args : {};
  const out = [];
  for (const k of Object.keys(src).slice(0, 5)) {
    const v = src[k];
    const s =
      typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (s && s.length <= 20) out.push(`${k}=${s}`);
  }
  return out.join(' ');
}

// ---- 2 期：配置项的**合法区间** ----
// ⚠️ 常量「只写一处、写在用它的文件里」：**默认值**在 `store.js`（存储层判 NULL 要用），
//    **区间**在这里（只有接口层做入参校验）。两者都不放同一个文件 —— 若 `store.js` 反过来
//    require 本文件，装配链会把 `core/context.js` 拉进来（一 require 就建库），
//    存储层单测当场失去独立性（本项目已记录的坑）。
/** 带多少条历史：下限（含） @type {number} */
const AI_CTX_TURNS_MIN = 20;
/**
 * 带多少条历史：上限（含） @type {number}
 *
 * ⭐ 0.7.7-⑰：**50 → 200**（下限 20 不动）。⚠️ 它必须与 `store.js` 的 `AI_CTX_MAX_CHARS`
 * （字符兜底，20000 → 60000）**一起抬** —— `aiContextWindow()` 是双上限，只抬条数会被字符上限
 * 悄悄截住（「设了 200、实际带 60 条」，且不报错）。
 * ⚠️ 前端 `public/modules/ai/shared.js` 的 `CTX_TURNS_MAX` 是**另一份**（两端各写一份），必须同值。
 */
const AI_CTX_TURNS_MAX = 200;
/** 最多带几条记忆：下限（含） @type {number} */
// ⚠️⭐ 0.7.6：界面上的「每次最多带几条记忆」已撤（记忆改为**全量注入**，见 `store.aiReadMemoriesForPrompt`），
//    但**这两个常量与 `checkMemMax` 都保留** —— 理由三条：① 删列 / 删键 = 结构迁移，本轮不碰；
//    ② 老备份恢复路径还要认 `mem_max` 这个键；③ 配置视图（`GET /api/ai/config`）仍如实回它。
//    ⛔ 别再让「注入条数」看它 —— 那个口径已经作废。
const AI_MEM_MAX_MIN = 5;
/** 最多带几条记忆：上限（含） @type {number} */
const AI_MEM_MAX_MAX = 50;
/** 单条记忆正文的长度上限（字） @type {number} */
const AI_MEM_CONTENT_MAX = 2000;

/**
 * 功能：校验一条**记忆正文** —— 去首尾空白后非空、≤ 2000 字。
 * @param {*} b - 请求体
 * @returns {string} 归一化后的正文
 * @throws {Error} 非文本 / 为空 / 超长时抛 400（⛔ 不静默截断，决策 36）
 */
function checkMemoryContent(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (typeof src.content !== 'string') throw httpError(400, '记忆内容必须是文本');
  const v = src.content.trim();
  if (!v) throw httpError(400, '记忆内容不能是空的');
  if (v.length > AI_MEM_CONTENT_MAX) {
    throw httpError(400, `记忆内容过长（最多 ${AI_MEM_CONTENT_MAX} 字），请精简后再存`);
  }
  return v;
}

/** 记忆**名称**的长度上限（字） @type {number} */
const AI_MEM_LABEL_MAX = 20;

/**
 * 功能：校验一条记忆的**名称**（0.7.1，**可选**）—— 缺省 / 空串都表示「这条没有名称」。
 *
 * 说明：⭐ 名称是 0.7.1 加的：界面上每条记忆变成「名称 + 内容」两栏（给的那张参考图），
 *      AI 注入时按「名称：内容」拼。⚠️ **老数据没有名称**（`label` 是 NULL）⇒ 这里把
 *      「没给 / 空串」统一归一成 `null`（不是空串），让「没有名称」只有一种形状。
 * @param {*} b - 请求体
 * @returns {?string} 归一化后的名称；没给 / 空串 ⇒ `null`
 * @throws {Error} 非文本 / 超长时抛 400（⛔ 不静默截断，决策 36）
 */
function checkMemoryLabel(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (src.label === undefined || src.label === null) return null;
  if (typeof src.label !== 'string') throw httpError(400, '记忆名称必须是文本');
  const v = src.label.trim();
  if (!v) return null;
  if (v.length > AI_MEM_LABEL_MAX) throw httpError(400, `记忆名称过长（最多 ${AI_MEM_LABEL_MAX} 字）`);
  return v;
}

/**
 * 功能：校验「带多少条历史」—— 必须是**整数**且落在 20~200（含端点）。
 * @param {*} v - 入参值
 * @returns {number} 合法值
 * @throws {Error} 非整数 / 越界时抛 400（⛔ 不截断到最近的合法值）
 */
function checkCtxTurns(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < AI_CTX_TURNS_MIN || v > AI_CTX_TURNS_MAX) {
    throw httpError(400, `带多少条历史只能是 ${AI_CTX_TURNS_MIN}~${AI_CTX_TURNS_MAX} 之间的整数`);
  }
  return v;
}

/**
 * 功能：校验「记忆条数上限」—— 整数且落在 5~50（含端点）。
 *
 * 说明：⚠️ 0.7.6 起界面**不再暴露**这个配置（记忆改为全量注入）⇒ 这个校验只为**兼容**留着：
 *      老的备份 / 老客户端仍可能带 `mem_max` 键，带着就得校验、不能 400 也不能静默丢。
 * @param {*} v - 入参值
 * @returns {number} 合法值
 * @throws {Error} 非整数 / 越界时抛 400
 */
function checkMemMax(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < AI_MEM_MAX_MIN || v > AI_MEM_MAX_MAX) {
    throw httpError(400, `记忆条数上限只能是 ${AI_MEM_MAX_MIN}~${AI_MEM_MAX_MAX} 之间的整数`);
  }
  return v;
}

/**
 * 功能：校验一份「模块清单」入参（3 期）—— 必须是数组，每一项都得是**白名单里的模块名**。
 *
 * 说明：⭐ 白名单来自 `lib/tools.js`（合法值的唯一出处，`vault` / `chat` 从来不在里面）——
 *      本函数**不自己维护第二份白名单**。
 *      ⚠️ 非法值一律 **400 且不静默丢弃**：把 `"vault"` 悄悄删掉再保存，用户会以为
 *      「授权成功了」，而实际上什么都没发生 —— 那是最坏的一种「错了不报错」。
 *      ⚠️ 报错文案里**只列合法名字**、不回显用户传进来的那个：响应里因此永远不会出现
 *      `vault` / `chat` 这类词（`ai.test.js` 的硬边界扫描会咬住这一点）。
 *
 * @param {*} v - 入参值
 * @param {'read'|'write'} mode - 授权方向（决定查哪一份白名单）
 * @param {string} label - 出错文案里对这份清单的称呼（前面要带引号，读起来像一句人话）
 * @returns {Array.<string>} 归一化后的清单（去重、去首尾空白）
 * @throws {Error} 非数组 / 含非字符串 / 含白名单外的值时抛 400
 */
function checkToolModules(v, mode, label) {
  const allowed = mode === 'write' ? tools.WRITE_MODULES : tools.READ_MODULES;
  if (!Array.isArray(v)) throw httpError(400, `${label}必须是数组`);
  const out = [];
  for (const it of v) {
    if (typeof it !== 'string') throw httpError(400, `${label}里只能写模块名`);
    const name = it.trim();
    if (!tools.isValidModule(mode, name)) throw httpError(400, `${label}里只能出现：${allowed.join('、')}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 功能：校验 `PUT /api/ai/config` 的请求体 —— 1 期的四个键交给 `core/validate.js` 的
 *      `checkAiConfig()`，2 期（含 0.7.0 的 `allow_private`）的键在**本文件**校验，最后合成一份 patch。
 *
 * 说明：⚠️ 为什么要拆这一步：`checkAiConfig()` 有一条「一个键都没认出来 ⇒ 400」的规矩，
 *      而 2 期的请求体完全可能**只带** `ctx_max_turns` —— 整份丢给它会被那条规矩误杀。
 *      所以先按 1 期的四个键**取子集**交给它（行为与 1 期逐字一致），再校验 2 期的那些键。
 *      ⚠️ 归属判权与 key 的封装都不在这里 —— 本函数只回答「这次到底要改哪几个字段」。
 *
 * @param {*} b - 请求体
 * @returns {Object} patch（`base_url` / `model` / `enabled` / `apiKey` / `ctx_max_turns` /
 *      `mem_enabled` / `mem_max` / `allow_private`）
 * @throws {Error} 任何一项不合法、或一个合法键都没带时抛 400
 */
function checkAiConfigPatch(b) {
  const src = b && typeof b === 'object' ? b : {};
  const legacy = {};
  for (const k of ['base_url', 'model', 'enabled', 'apiKey']) {
    if (Object.prototype.hasOwnProperty.call(src, k)) legacy[k] = src[k];
  }
  const patch = Object.keys(legacy).length ? checkAiConfig(legacy) : {};
  if (src.ctx_max_turns !== undefined && src.ctx_max_turns !== null) {
    patch.ctx_max_turns = checkCtxTurns(src.ctx_max_turns);
  }
  if (src.mem_max !== undefined && src.mem_max !== null) {
    // ⚠️ 0.7.6：界面已撤掉这个配置，这个键**只为兼容**（老备份 / 老客户端）继续接住并校验
    patch.mem_max = checkMemMax(src.mem_max);
  }
  if (src.mem_enabled !== undefined && src.mem_enabled !== null) {
    if (typeof src.mem_enabled !== 'boolean') throw httpError(400, '记忆开关必须是布尔值');
    patch.mem_enabled = src.mem_enabled;
  }
  // ⭐ 0.7.0（009 报告 R1）：内网地址开关 —— 与 `mem_enabled` 同一个布尔口径。
  //    （真正的「私网地址 + 没开开关」拦截在 `store.aiSaveConfig` / `aiOutboundConfig` 里，
  //     因为那两处才看得到「库里现存的地址与开关」—— 本函数只管键与类型。）
  if (src.allow_private !== undefined && src.allow_private !== null) {
    if (typeof src.allow_private !== 'boolean') throw httpError(400, '「允许访问内网地址」开关必须是布尔值');
    patch.allow_private = src.allow_private;
  }
  // ⭐ 3 期：工具授权四项 —— 两个布尔 + 两个「模块清单」。
  //    ⚠️ 清单**不走布尔那条路**：它的合法值由 `lib/tools.js` 的白名单收口（见 `checkToolModules`）。
  if (src.tools_enabled !== undefined && src.tools_enabled !== null) {
    if (typeof src.tools_enabled !== 'boolean') throw httpError(400, 'AI 工具总开关必须是布尔值');
    patch.tools_enabled = src.tools_enabled;
  }
  if (src.tools_audit !== undefined && src.tools_audit !== null) {
    if (typeof src.tools_audit !== 'boolean') throw httpError(400, '「记录 AI 工具审计」开关必须是布尔值');
    patch.tools_audit = src.tools_audit;
  }
  if (src.tools_read !== undefined && src.tools_read !== null) {
    patch.tools_read = checkToolModules(src.tools_read, 'read', '「让 AI 读」的授权清单');
  }
  if (src.tools_write !== undefined && src.tools_write !== null) {
    patch.tools_write = checkToolModules(src.tools_write, 'write', '「让 AI 写」的授权清单');
  }
  // ⭐ 0.8.6（行程 1 期 ·）：能不能收图片 —— 与上面几个布尔同一个口径。
  if (src.vision !== undefined && src.vision !== null) {
    if (typeof src.vision !== 'boolean') throw httpError(400, '「支持图片输入」开关必须是布尔值');
    patch.vision = src.vision;
  }
  if (!Object.keys(patch).length) throw httpError(400, '没有要保存的内容');
  return patch;
}

/**
 * 功能：出网失败的错误归一 —— 客户端的转译错误（带 `kind`）按 **400** 出口（不是 500）。
 *
 * 说明：⚠️ 「用户填错了 key / 上游限流」不是本服务器的内部错误：回 500 会把这类
 *      可自愈的配置问题记成 error 级日志（污染可观测性），也会让前端把它当「服务器坏了」。
 *      错误文案不变（已由 `lib/openai-client.js` 的转译表翻成人话）。
 *
 * @param {Error} e - 捕获到的错误
 * @returns {Error} 归一过 status 的错误（交给 `fail()` 收口）
 */
function upstreamFail(e) {
  if (e && e.kind && !e.status) e.status = 400;
  return e;
}

// ---- SSE 帧格式（与 chat 模块同源：`data: {json}\n\n`）----
/**
 * 功能：把 SSE 响应头写下去（POST 流式响应，客户端用 fetch 读流，不需要 `retry:` 行）。
 *
 * 说明：⚠️ `X-Accel-Buffering: no` 必须带 —— 飞牛网关 / 反代不加它会缓冲整段响应，
 *      流式打字机就变成「转圈 30 秒后一次性出全文」（chat 模块同一教训）。
 *
 * @param {Object} res - HTTP 响应对象
 * @returns {void}
 */
function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

/**
 * 功能：把一条事件写成 SSE 帧。
 * @param {Object} payload - 事件体（`{type:…}`）
 * @returns {string} 可直接 `res.write()` 的帧文本
 */
function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ---- 指挥建任务：提示词与产物归一（只提议、三层兜底解析）----
/**
 * 指挥 AI 建任务的 system 提示词。
 * ⚠️ 只押「只输出 JSON」的约定 + 服务端三层兜底解析，**不押** `response_format`（各家支持不一）。
 * @type {string}
 */
const EXTRACT_SYSTEM = [
  '你是任务整理助手。把用户给你的内容整理成待办任务清单。',
  '只输出一个 JSON 对象，不要输出任何其它文字（不要解释、不要代码围栏、不要问候）：',
  '{"tasks":[{"title":"任务标题，30字以内","assignee":"负责人，没有就留空串","due":"截止日期 YYYY-MM-DD，原文没说就留空串","priority":"高、中或低，原文没说就留空串","note":"补充说明，没有就留空串"}]}',
  '规则：只整理「需要动手做的事」；日期只认原文里写了的；不要编造原文没有的信息；最多 8 条。',
].join('\n');

/**
 * 聊天（POST /api/ai/chat）的 system 提示词 —— ⭐ 0.6.1：**每次调用前注入**。
 *
 * 说明：⚠️ 会话是**无状态**的（上游每次只收到这一条 user 消息、不带历史），所以提示词
 *      必须每调一次带一次；⚠️ 提示词只描述**本产品的功能边界与助手的角色**，
 *      不含任何用户数据 —— 出网的只有用户亲手发的那句话（key 六不的同一条红线）；
 *      「今天是哪天」由 `chatSystemPrompt()` 在调用那一刻现拼（模块加载时常量会跨零点变旧）。
 *
 * ⭐ 0.7.7-⑳：按现在的能力重写了两句（按现有内容优化）。改动的**界线**：
 *      · 说的仍是「角色与边界」，⛔ 不含任何用户数据 / 密钥 / 接口地址 / 账号名；
 *      · ⛔ 不写 `meta` 的结构、字段名、内部函数名（那是内部约定，不该教给模型）；
 *      · ⛔ 不把代码里的护栏（一次最多几条、最多几轮工具调用）写成提示词里的承诺 ——
 *        护栏在代码里，写进提示词只会被模型当成「必须复述的规则」；
 *      · ⛔ 协议约定（「只输出一个 JSON」）一个字不动。
 *
 * ⭐⭐ **0.7.8 修**：把**只有写工具被授权时才成立**的那两句**挪出这个常量** —— 它是个恒定的常量，
 *      却承诺了一件「看授权才有」的事，于是没开写工具的账号也被这样承诺，模型只好**用文字模仿**
 *      一张卡、再编一句「已经发出去了」（就是那条「确认卡从上线起就不可达」的缺陷）。
 *      ⇒ 现在这里只留**任何情况下都对**的那半句（你不能创建、别假装建好了）；
 *      「会变成一张待确认的卡片」与「被拒绝之后怎么办」搬进 `openai-client.js` 的 `toolsPrompt()`
 *      写工具段（授权时才出现），而没授权时那段会**明说「这项能力没开」**。
 *
 * @type {string}
 */
const CHAT_SYSTEM = [
  '你是 ZXDesk 工作台内置的 AI 助手。ZXDesk 是部署在用户自己 NAS 上的私有工作台，现在有这些模块：',
  '任务与随手记（日常任务与项目任务：标题、任务日与截止日、重要/紧急四象限、负责人、备注；' +
    '任务分三种 —— 普通、限时完成、周期打卡）；',
  '番茄钟与日程表（大学课表的课程与上课时间、番茄钟的专注计时与统计、行程与车票的起止与车次时刻）；',
  '网址收藏夹（网址与分类）；我的设备（数码与家电台账：名称、分类、品牌型号、购买日期、价格、寿命）；' +
    '随手记（记下来的想法与标签）；日历（用户自己建的日程）；',
  '生活记账（账户、收支流水、分类、预算）；个人资产管理（分组台账：房子、设备这些值多少）；' +
    '团队协作（好友对话、共享项目与其中的任务）。',
  // ⚠️⭐ 密码库**不列进上面那份"功能"里**（它不在 AI 的工具面上，硬边界见 `lib/tools.js`）——
  //    但要**明说读不到**：不说的话，用户一提「帮我看看我的密码」它就会开始编。
  '你**读不到**密码库里的任何内容，也读不到别人的聊天记录 —— 问到时如实说读不到，⛔ 不要猜。',
  '你的职责：回答用户的提问；帮用户把一段话、一条消息整理成待办任务的建议（给出任务标题、截止日期、' +
    '重要/紧急程度、负责人、补充说明）；用户问起自己的任务、课表、账目、预算、资产、日程、专注时长、' +
    '收藏、随手记、设备、行程或协作项目时，如实回答。',
  // ⭐ 0.7.8：只留「任何情况下都对」的那半句 —— 「你不能创建、别假装建好了」。
  //    ⚠️ 「会变成一张待确认的卡片」那半句挪走了（它只在写工具被授权时才成立，见上面的说明）。
  '关于整理任务：你不能直接创建任务，也不要假装已经创建成功；在用户表态之前，别说任务已经建好。',
  // ⭐ 0.8.4：记账那一条 —— 与上面任务那条**同一条界线**（只写「任何情况下都对」的那半句）
  '关于记账：你不能直接记账，也不要假装已经记好；在用户表态之前，别说哪笔账已经记下。',
  // ⭐ 0.8.5：收藏 / 随手记 / 硬件那三条 —— 与上面两条**同一条界线**
  '关于收藏网址、随手记与设备台账：你同样不能直接新建它们，也不要假装已经加好了；在用户表态之前，别说哪一条已经存进去。',
  // ⭐ 0.8.55：资产与日程那两条 —— 同一条界线（只写「任何情况下都对」的半句）
  '关于资产台账与日历日程：你同样不能直接新建，也不要假装已经加好了；在用户表态之前，别说哪一条已经写进去。',
  // ⚠️ 这一句是**任何情况下都对**的事实（他拿到的是分就按分说话）—— ⛔ 不是「承诺某个能力」。
  '涉及金钱的数字：如果工具给你的数是「分」，说给用户听之前要换算成元（除以 100），别把 3500 分说成 3500 元。',
  // ⭐ 0.8.55：存量与流量别混（资产台账 vs 记账）—— 这是本轮体检里最容易答错的一处
  '个人资产台账记的是「这些东西值多少」（存量），生活记账记的是「这段时间花了多少」（流量）—— 两者不要相加。',
  '用户提到的日期若相对今天，请按下面给的今天日期推算成 YYYY-MM-DD。',
  '用简体中文回答，简洁直接，不要编造不确定的信息。',
].join('\n');

/**
 * 功能：拼聊天这一次调用用的 system 消息内容 —— 固定角色描述 + 调用那一刻的今天日期 + **记忆段落**。
 *
 * 说明：⭐ 2 期：记忆就走**这个现成的注入点**，不新建链路 ——
 *      `mems` 为空（没存过 / 总开关关着 / 上限为 0）时**一个字都不加**，
 *      于是「没记忆」与「有记忆」的提示词不会长得像两种东西。
 *      ⚠️ 记忆是**用户自己写的**、会过时，所以开场那句要说清「与用户当次说的冲突时以后者为准」——
 *      否则模型会拿三天前的一条记忆当铁律，把用户刚说的话顶回去。
 *
 * @param {Array.<string>} [mems] - 本次要带的记忆正文（`store.aiReadMemoriesForPrompt()` 的产物）
 * @param {string} [toolText] - 3 期：本次**已授权工具**的说明（`client.toolsPrompt()` 的产物）。
 *      ⚠️ 没开工具 / 一条读工具都没授权时是**空串** —— 此时拼出来的提示词与 2 期逐字相同，
 *      出网请求体里因此一条工具说明都不带（用例 1）。
 * @returns {string} system 消息内容
 */
function chatSystemPrompt(mems, toolText, vision) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const wk = '日一二三四五六'.charAt(d.getDay());
  const head = `${CHAT_SYSTEM}\n今天是 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}（星期${wk}）。`;
  // ⭐ 0.8.6（行程 1 期 ·）：图片能力声明。
  //    ⚠️⭐ **为什么放在这里、而不是 `toolsPrompt()` 里**：后者在「一条工具都没授权」时
  //    会**早退成空串**，而图片能力与工具授权是两回事（用户完全可能只开图片、不开任何工具）
  //    ⇒ 放进去会让这句话根本到不了模型耳朵里，表现是「模型收到了图却只会说我看不到图」。
  //    ⚠️ 关着时必须**明说「你现在收不到图片」**（
  //    只说「有这功能」却不说「你现在没有」，模型就会照着前半句编）。
  const visionText = vision
    ? '【图片】用户**可能**在消息里带一张图片（例如一张车票截图）。有图时优先看图说话；' +
      '要建票就用上面那个 trips.propose_create 提议。⚠️ **图只看得到一次** —— ' +
      '需要它做什么请在收到图的那一轮说清楚，下一轮就看不到那张图了。'
    : '【图片】你现在**收不到图片**（「支持图片输入」这项能力没开）。' +
      '用户说「帮我看看这张图」这类话时，如实说明你现在看不到图，并让他到「AI 助手 → AI 设置」里' +
      '打开「支持图片输入」；⛔ 不要猜图里有什么，⛔ 也不要假装看到了。';
  const base = toolText ? `${head}\n\n${visionText}\n\n${toolText}` : `${head}\n\n${visionText}`;
  const list = Array.isArray(mems) ? mems : [];
  if (!list.length) return base;
  return (
    `${base}\n\n【用户自己维护的长期记忆】\n` +
    '下面是用户自己记下来的偏好与背景，回答时可以按它来；它们可能已经过时，\n' +
    '与用户这一次说的话冲突时，以用户这一次说的为准。\n' +
    list.map((m) => `· ${m}`).join('\n')
  );
}

/** 任务标题上限（与对话模块「消息→任务」同一水位：服务端 100 字） @type {number} */
const TASK_TITLE_MAX = 100;

/**
 * 功能：把 AI 给的任意值收成**有上限的干净文本**（这是归一化模型输出，不是校验用户输入 —— 截断没问题）。
 * @param {*} v - 任意值
 * @param {number} cap - 字数上限（按码点截）
 * @returns {string} trim 后的文本
 */
function capText(v, cap) {
  const s = String(v == null ? '' : v).trim();
  return [...s].slice(0, cap).join('');
}

/**
 * 功能：把模型回复解析出的值归一成任务草稿数组 —— **解析不出来返回 null**（调用方报 400 format，绝不猜）。
 *
 * 说明：认两种形状：裸数组、`{"tasks":[…]}`；条目没有标题就丢掉；日期不合法就清空；
 *      优先级只认 高/中/低；最多收 8 条。
 *
 * @param {*} v - `parseLooseJson()` 的产物
 * @returns {?Array.<{title: string, assignee: string, due: string, priority: string, note: string}>} 草稿数组；解析不出为 null
 */
function normalizeTasks(v) {
  let arr = null;
  if (Array.isArray(v)) arr = v;
  else if (v && typeof v === 'object' && Array.isArray(v.tasks)) arr = v.tasks;
  if (!arr) return null;
  const out = [];
  for (const it of arr.slice(0, 8)) {
    if (!it || typeof it !== 'object') continue;
    const title = capText(it.title, TASK_TITLE_MAX);
    if (!title) continue;
    const due = capText(it.due, 10);
    out.push({
      title,
      assignee: capText(it.assignee, 50),
      due: DATE_RE.test(due) ? due : '',
      priority: ['高', '中', '低'].includes(it.priority) ? it.priority : '',
      note: capText(it.note, 1000),
    });
  }
  return out;
}

/**
 * 功能：拼「将发给 AI 的原文」（`sentPreview` 与发出的 user 消息**逐字相同** —— 发送前看得到的就是发出去的）。
 * @param {string} sourceBody - 被点的对话消息原文（可空）
 * @param {string} supplement - 手填补充（可空）
 * @returns {string} 发送内容
 */
function extractUserContent(sourceBody, supplement) {
  const parts = [];
  if (sourceBody) parts.push(`【来自对话的消息】\n${sourceBody}`);
  if (supplement) parts.push(`【我的补充】\n${supplement}`);
  return parts.join('\n\n');
}

/**
 * 功能：处理 `/api/ai` 及其子路径 —— 配置读写 / 测连通 / 聊天 / 指挥建任务 / 历史。
 *
 * 说明：路由表（`parts = ['api','ai', …]`；顶层键 `ai` 由 `module.json` 的 `apiPrefix` 声明，
 *      本模块所有接口都在 `/api/ai/<子路径>` 上，从 parts[2] 判起）——
 *      见文件头那张清单。⚠️ `chat` 是流式响应：一旦 `sseHead()` 写下去，后续错误只能走
 *      **error 帧**（HTTP 状态码已经发出去了，改不了了）—— 所以所有**前置**校验都必须在它之前完成。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {Object} ctx.url - 解析好的 URL 对象（取查询参数）
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleAi({ req, res, parts, url, method, uid }) {
  const p2 = parts[2];

  // ---- GET /api/ai/config —— 配置视图 ----
  if (parts.length === 3 && p2 === 'config' && method === 'GET') {
    return json(res, 200, store.aiGetConfigView(uid));
  }

  // ---- PUT /api/ai/config —— 保存（1 期四个键 + 2 期三个键，只写请求里真带了的）----
  if (parts.length === 3 && p2 === 'config' && method === 'PUT') {
    return readBody(req, res, (b) => {
      const patch = checkAiConfigPatch(b);
      return json(res, 200, store.aiSaveConfig(uid, aiKek(), patch));
    });
  }

  // ---- POST /api/ai/config/clear-key —— 显式清除 key（幂等）----
  if (parts.length === 4 && p2 === 'config' && parts[3] === 'clear-key' && method === 'POST') {
    return json(res, 200, store.aiClearKey(uid));
  }

  // ---- 2 期：记忆的五个接口（⛔ 都不出网 ⇒ 不进节流窗口）----
  // ⚠️ `clear` 必须排在 `<id>` 前面判断：`Number('clear')` 是 NaN，但把顺序写反会让
  //    `/memories/clear` 先被当成「编号不合法的记忆」回 400 —— 用户点「清空」却得到「编号不合法」。
  if (parts.length === 4 && p2 === 'memories' && parts[3] === 'clear' && method === 'POST') {
    try {
      return json(res, 200, { removed: store.aiClearMemories(uid) });
    } catch (e) {
      return fail(res, e);
    }
  }

  // ---- GET /api/ai/memories —— 记忆列表 ----
  if (parts.length === 3 && p2 === 'memories' && method === 'GET') {
    try {
      return json(res, 200, { items: store.aiListMemories(uid) });
    } catch (e) {
      return fail(res, e);
    }
  }

  // ---- POST /api/ai/memories —— 新增一条（201）----
  if (parts.length === 3 && p2 === 'memories' && method === 'POST') {
    return readBody(req, res, (b) => {
      const content = checkMemoryContent(b);
      // ⭐ 0.7.1：名称**可选**（不给 = `null`，就是老数据那种「没有名称的自由文本」）
      return json(res, 201, store.aiAddMemory(uid, content, 0, checkMemoryLabel(b)));
    });
  }

  // ---- PUT / DELETE /api/ai/memories/<id> —— 改 / 删（越权与不存在统一 404）----
  if (parts.length === 4 && p2 === 'memories' && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(parts[3]);
    if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: '记忆编号不合法' });
    const run = (b) => {
      try {
        if (method === 'DELETE') {
          // ⭐ 0.7.7-⑱：预设三条删不掉 —— 由存储层抛 400（护栏在那一层，这里不重复判一遍；
          //    判据只准一处，见 `store.MEM_PRESET_LABELS`）
          const ok = store.aiDeleteMemory(uid, id);
          return ok ? json(res, 200, { ok: true }) : notFound(res);
        }
        // ⭐ 0.7.1：PUT 同时认 `content` 与 `label`，但**只写请求里真带了的键**（/ 36 的
        //    「带哪个键写哪个键」）。⚠️ 名称是唯一**允许被清空**的那个（`label: null` / `''` =
        //    去掉名称）⇒ 必须用 `'label' in b` 判「带没带」，不能判它是不是空值 —— 否则
        //    「把名称删掉」这个动作永远做不到（会被当成"没带这个键"而跳过）。
        const patch = {};
        if (b && typeof b === 'object' && 'content' in b) {
          // ⭐ 0.7.7-⑱：**预设三条放行空内容** —— 它们删不掉，所以「清空内容」是它们唯一能被抹掉的方式；
          //    若这里同样按 `checkMemoryContent` 拦空串，用户把预设内容清掉再保存就会吃一个 400
          //    （界面上一句话都留不下来）。⚠️ 只对预设放行，其余行照旧「空内容 = 那一行不要它」。
          const blank = typeof b.content === 'string' && b.content.trim() === '';
          patch.content = blank && store.aiMemoryIsPreset(uid, id) ? '' : checkMemoryContent(b);
        }
        if (b && typeof b === 'object' && 'label' in b) patch.label = checkMemoryLabel(b);
        // ⭐ 存储层不区分「别人的」与「不存在」（影响 0 行）—— 这正是两条出口能合并成 404 的原因
        const ok = store.aiUpdateMemory(uid, id, patch);
        return ok ? json(res, 200, { ok: true }) : notFound(res);
      } catch (e) {
        return fail(res, e);
      }
    };
    return method === 'PUT' ? readBody(req, res, run) : run();
  }

  // ---- ⭐ 0.7.7-⑲：POST /api/ai/proposals/<id> —— 对一张确认卡表态（同意 / 拒绝）----
  // ⚠️ 用 POST 而不是 PUT：它不是「改一条记录」，是一个**动作**（会顺带追加一条助手消息）。
  // ⚠️ `agree` 的条目**由前端逐条建好**（走 `core/task-create.js` 这个唯一入口）——
  //    服务端只改状态 + 记一句结果，⛔ 不自己建任务（那会变成第二条创建路径）。
  // ⚠️ 越权 / 不存在 / 不是卡片 ⇒ 一律 404（不让状态码变成探测通道）。
  if (parts.length === 4 && p2 === 'proposals' && method === 'POST') {
    const id = Number(parts[3]);
    if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: '提议编号不合法' });
    return readBody(req, res, (b) => {
      try {
        const src = b && typeof b === 'object' ? b : {};
        const action = src.action === 'agree' ? 'agree' : src.action === 'reject' ? 'reject' : '';
        if (!action) throw httpError(400, '动作只能是 agree 或 reject');
        const r = store.aiResolveProposal(uid, id, action, { added: src.added, failed: src.failed });
        if (!r) return notFound(res);
        return json(res, 200, r);
      } catch (e) {
        return fail(res, e);
      }
    });
  }

  // ---- 3 期：工具面（⛔ 两条都不出网 ⇒ 不进节流窗口）----

  // ---- GET /api/ai/tools —— 当前可用工具清单（含用途与出网面说明，给人看的）----
  // ⭐ 回的是**目录全表 + 每条「本账号现在能不能用」**：界面要能画出「哪些开着、哪些没开」，
  //    而不是只列开着的（那样用户看不见自己关掉了什么）。⚠️ 目录是常量，硬边界永不在里面。
  if (parts.length === 3 && p2 === 'tools' && method === 'GET') {
    try {
      const auth = store.aiAuthorizedTools(uid);
      return json(res, 200, {
        enabled: auth.enabled,
        boundary: tools.PANEL.boundary,
        masterNote: tools.PANEL.master,
        items: tools.TOOLS.map((t) => ({
          name: t.name,
          module: t.module,
          mode: t.mode,
          title: t.title,
          purpose: t.purpose,
          share: t.share,
          args: t.args,
          returns: t.returns,
          authorized: tools.isAuthorized(t, auth),
        })),
      });
    } catch (e) {
      return fail(res, e);
    }
  }

  // ---- POST /api/ai/tools/run —— 服务端执行一次工具（3 期；⭐ 先过唯一判据）----
  // ⚠️ 未授权 ⇒ **403 + 人话文案**（说清去哪儿开，用例 9）；目录外 / 硬边界的名字 ⇒ **404**（用例 10）
  //    —— 404 的响应里**不回显**调用方传来的那个名字，所以 `vault` / `chat` 这类词永远不出现在响应里。
  if (parts.length === 4 && p2 === 'tools' && parts[3] === 'run' && method === 'POST') {
    return handleToolRun({ req, res, uid });
  }

  // ---- GET /api/ai/audit —— 审计列表（只回自己的；本次运行期间；不含内容与 key）----
  if (parts.length === 3 && p2 === 'audit' && method === 'GET') {
    const sp = url.searchParams;
    let limit = null; // null = 用存储层默认（= 上限 200）
    if (sp.has('limit')) {
      const n = Number(sp.get('limit'));
      if (!Number.isInteger(n) || n <= 0) return json(res, 400, { error: '条数参数不合法' });
      limit = Math.min(n, AI_AUDIT_MAX);
    }
    try {
      return json(res, 200, { items: store.aiListAudit(uid, limit), max: AI_AUDIT_MAX });
    } catch (e) {
      return fail(res, e);
    }
  }

  // ---- POST /api/ai/test —— 测连通（结果对象是 200：连通失败不是请求格式错）----
  // ⚠️⭐ 节流也要记账（009 报告 S1）：出网动作 test / chat / extract 是**三端合账**一个滑动窗口 ——
  //    这里原先漏了 `aiAllow()`，于是「10 次/分钟」对 test 名存实亡（还放大了 R1 的内网探测速率）。
  if (parts.length === 3 && p2 === 'test' && method === 'POST') {
    if (!aiAllow(uid)) return json(res, 429, { error: RATE_MSG });
    return (async () => json(res, 200, await store.aiTestConnection(uid, aiKek())))().catch((e) => fail(res, e));
  }

  // ---- GET /api/ai/messages —— AI 会话历史（游标翻页；默认 50 条、上限 200，同 chat 口径）----
  // ⭐ 2 期：每项多一个 `segment`；可选 `?segment=N` 只取那一段。
  //    ⚠️⭐ **不带 `segment` = 返回全部**（不是「只返回当前段」）—— 理由：前端 `loadHistory()`
  //    不带参数，若默认只回当前段，用户刷新之后就**再也滚不到上一段历史**，
  //    与「开启新对话 → 上一段历史仍在（能滚到）」这条验收直接冲突（方案 §15.2 步骤 2-4）。
  if (parts.length === 3 && p2 === 'messages' && method === 'GET') {
    const sp = url.searchParams;
    let before = null;
    let limit = 50;
    let segment = null;
    if (sp.has('before')) {
      const n = Number(sp.get('before'));
      if (!Number.isInteger(n) || n <= 0) return json(res, 400, { error: '翻页参数不合法' });
      before = n;
    }
    if (sp.has('limit')) {
      const n = Number(sp.get('limit'));
      if (!Number.isInteger(n) || n <= 0) return json(res, 400, { error: '翻页参数不合法' });
      limit = Math.min(n, 200);
    }
    if (sp.has('segment')) {
      const n = Number(sp.get('segment'));
      if (!Number.isInteger(n) || n <= 0) return json(res, 400, { error: '分段参数不合法' });
      segment = n;
    }
    try {
      const chat = store.aiGetChat(uid); // 只读路径不建会话（没聊过 = 空历史）
      if (!chat) return json(res, 200, { items: [], hasMore: false });
      return json(res, 200, store.aiListMessages(uid, chat.id, before, limit, segment));
    } catch (e) {
      return fail(res, e);
    }
  }

  // ---- GET /api/ai/messages/<id>/image —— 一条消息带的图片（⭐ 0.8.6 显示专用）----
  //    ⚠️⭐ **越权 / 不存在 / 这条没有图，一律 404 同体**（403 是探测通道）。
  //    ⚠️ 历史列表那条路由**永远不拖 base64**（它只回 `has_image`），图片一律走这一条。
  //    ⚠️ `Cache-Control: no-store`：图本身不会变，但**归属是每账号的** ——
  //    落进共享缓存就成了越权读的入口。
  if (parts.length === 5 && p2 === 'messages' && parts[4] === 'image' && method === 'GET') {
    const id = Number(parts[3]);
    if (!Number.isInteger(id) || id <= 0) return notFound(res);
    const raw = store.aiMessageImage(uid, id);
    const p = raw ? parseImageDataUrl(raw) : null;
    if (!p || !p.ok) return notFound(res);
    let buf;
    try {
      buf = Buffer.from(p.base64, 'base64');
    } catch (_e) {
      return notFound(res);
    }
    res.writeHead(200, {
      'Content-Type': p.mime,
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return;
  }

  // ---- POST /api/ai/chat/new —— 开启新对话（⭐ 2 期；不出网，不进节流窗口）----
  if (parts.length === 4 && p2 === 'chat' && parts[3] === 'new' && method === 'POST') {
    try {
      // 会话还没建过时传 0：等同「还没有消息」⇒ 段号 1（这一下**不建会话**，只读）
      const chat = store.aiGetChat(uid);
      return json(res, 200, store.aiNewSegment(uid, chat ? chat.id : 0));
    } catch (e) {
      return fail(res, e);
    }
  }

  // ---- POST /api/ai/chat —— 聊天（流式 SSE）----
  if (parts.length === 3 && p2 === 'chat' && method === 'POST') {
    return handleChat({ req, res, uid });
  }

  // ---- POST /api/ai/extract —— 指挥 AI 建任务（只提议）----
  if (parts.length === 3 && p2 === 'extract' && method === 'POST') {
    return handleExtract({ req, res, uid });
  }

  return notFound(res);
}

/**
 * 功能：判断「已经收到的这一段」**还可能是一条工具指令**吗？（决定要不要继续压着不发）
 *
 * 说明：⚠️ 这是一个**前缀判定**，不是判定「它是指令」—— 拿不准一律返回真（继续压着），
 *      判定权交给轮末的 `client.parseToolIntent()`（那一步才严格）。
 *      理由是两头都要安全：早放出去 ⇒ 用户屏幕上闪过一段 JSON；晚放出去 ⇒ 顶多晚几十毫秒。
 *      ⭐ `0.7.6`：`<|` 开头的也压住 —— 那是**原生调用标记泄漏**的形状（真机实测），
 *      一样要等轮末判定，别让机器语法闪上屏（`client.nativeCallShaped()` 同一款特征）。
 * @param {string} s - 本轮已收到的文本
 * @returns {boolean} 还可能是指令为 true
 */
function looksLikeIntentPrefix(s) {
  const t = String(s == null ? '' : s).trimStart();
  if (!t) return true; // 还一个字都没有（有些上游第一帧是空串）：继续等
  const c = t.charAt(0);
  if (c === '{' || c === '`') return true;
  // ⭐⭐ 0.8.55：**单个 `<` 也先压住**。原生调用标记（`<|DSML|` / DeepSeek 的 `<｜｜DSML｜｜`）
  //    以它开头；只在认到两字符 `<|` 时才压，第一个 `<` 早就发出去了 —— 用户会看到气泡里
  //    先冒一个尖角、随后整坨机器语法（真机截图就是这样）。
  //    ⚠️ 压住**只是一拍**：下一帧若不是竖线（正文里的 `<` 通常后面跟字母），`flushing`
  //    立刻置真并把攒下的整段一次发出去 —— 正常回答不受影响，只多等一帧。
  if (c === '<') return true;
  return false;
}

/**
 * 功能：执行一条**模型提出的**工具意图，并把它压成一段能续接给模型的结果文本（3 期）。
 *
 * 说明：⭐ 与 `handleToolRun()` 的关键差别：**接口层的失败在这里不打断整轮对话** ——
 *      工具循环是在用户已经等着的 SSE 流里跑的，把整轮掐掉等于「问一句话，回一个报错」。
 *      所以这里把失败也当成**一条结果**发回模型（让它换个说法或如实说读不到），
 *      前端因此总会拿到一段回答（方案 §4.5 第 6 条：失败要响 —— 响在回答里，不是响在断连里）。
 *      ⚠️ `auth` 由调用方**传进来**（chat 那一次调用开头算好的那一份），这里**不重算** ——
 *      重算就多了一处判据，而判据只允许有一处（`store.aiAuthorizedTools()`）。
 *      ⚠️ 写工具走到这里也**只生成提议**：产物通过返回值里的 `proposal` 交给调用方收进
 *      `done` 帧，⛔ 本函数（以及它调用的执行器）一条都不落库。
 *      ⚠️ 审计只记工具名 / 入参摘要 / 成败 / 拒绝原因；⛔ 结果与入参内容都不进审计、不进日志。
 *
 * @param {number} uid - 账号 id
 * @param {{enabled: boolean, read: Array.<string>, write: Array.<string>}} auth - 本次的授权
 * @param {{tool: string, args: Object}} intent - 解析出来的意图
 * @returns {{text: string, proposal?: Object}} 续接给模型的文本；写工具另带一份提议
 */
function runIntentForChat(uid, auth, intent) {
  const deny =
    '【工具结果】\n这个工具现在不可用（没有授权或不存在）。请不要再尝试调用工具，直接用已有信息回答用户；' +
    '确实缺数据就如实说你现在读不到。';
  const tool = tools.TOOLS.find((t) => t.name === intent.tool);
  if (!tool || !tools.hasExecutor(tool) || !tools.isAuthorized(tool, auth)) {
    store.aiAppendAudit(uid, { tool: intent.tool, args: briefToolArgs(intent.args), ok: false, reason: '未授权' });
    return { text: deny };
  }
  const out = tools.runTool(store, uid, intent.tool, intent.args);
  store.aiAppendAudit(uid, {
    tool: intent.tool,
    args: briefToolArgs(intent.args),
    ok: out.ok,
    reason: out.ok ? '' : out.message,
  });
  if (!out.ok) {
    return { text: `【工具结果】\n调用失败：${out.message}\n请不要再重试同一个调用，直接向用户说明。` };
  }
  if (out.kind === 'write') {
    // ⚠️ 措辞必须说清「还没有落库」—— 否则模型会跟用户说「已经帮你建好了」，
    //    而用户手上只有一张还没点的确认卡（那是最坏的一种错报）。
    const n = out.proposal.items.length;
    return {
      text:
        `【工具结果】\n已生成 ${n} 条待用户确认的任务草稿，**还没有落库** —— 用户点了确认才会真建。\n` +
        '请简短告诉用户「我拟了 N 条，你确认一下」，不要再重复提议同样的内容，也不要输出 JSON。',
      proposal: out.proposal,
    };
  }
  return {
    text:
      `【工具结果】\n${intent.tool} 的结果（JSON）：\n${JSON.stringify(out.result)}\n\n` +
      '请据此用简体中文回答用户，不要再输出 JSON。',
  };
}

/**
 * 功能：执行一次工具（3 期，方案 §六）—— ⭐ 判据只有一处（`store.aiAuthorizedTools()`）。
 *
 * 说明：⚠️ 本文件**绝不**自己去读 `tools_read` / `tools_write` 那两列拼条件（方案 §5.2：
 *      「两份口径」是本项目最贵的病）。
 *      ⚠️ 出口分流：目录外的名字 → `notFound()`；未授权 → `json(403)`；
 *      超限 → `json(429)`；入参错 / 执行失败 → 按 `status` 走 `json()`。
 *      ⚠️ 审计**只记工具名 / 入参摘要 / 成败 / 拒绝原因**（`briefToolArgs` 保证不进用户内容）；
 *      工具结果**不进审计、不进日志**（负向清单第 7 / 10 条）。
 *
 * @param {{req: Object, res: Object, uid: number}} c - 上下文（req / res / uid）
 * @returns {void}
 */
function handleToolRun({ req, res, uid }) {
  readBody(req, res, (b) => {
    const src = b && typeof b === 'object' ? b : {};
    if (typeof src.tool !== 'string' || !src.tool.trim()) return fail(res, httpError(400, '要说清执行哪个工具'));
    const name = src.tool.trim();
    let args = {};
    if (src.args !== undefined && src.args !== null) {
      if (typeof src.args !== 'object' || Array.isArray(src.args)) {
        return fail(res, httpError(400, '工具入参必须是一个对象'));
      }
      args = src.args;
    }
    const tool = tools.TOOLS.find((t) => t.name === name);
    // ⚠️ 目录外（含 vault / chat 这类永不进工具面的）与「本期还没有执行器」的，**统一 404** ——
    //    与「越权与不存在同体」同一条红线，且不回显调用方传来的名字。
    if (!tool || !tools.hasExecutor(tool)) return notFound(res);
    const auth = store.aiAuthorizedTools(uid);
    if (!tools.isAuthorized(tool, auth)) {
      store.aiAppendAudit(uid, { tool: name, args: briefToolArgs(args), ok: false, reason: '未授权' });
      return json(res, 403, { error: TOOL_DENIED_MSG });
    }
    if (!aiAllow(uid)) return json(res, 429, { error: RATE_MSG });
    const out = tools.runTool(store, uid, name, args);
    store.aiAppendAudit(uid, {
      tool: name,
      args: briefToolArgs(args),
      ok: out.ok,
      reason: out.ok ? '' : out.message,
    });
    if (!out.ok) return json(res, out.status, { error: out.message });
    // ⭐ 3 期：写工具只回**提议**（⛔ 一条都不落库）；读工具回数据。
    //    两个键刻意不同 —— 免得哪一天有人把 `proposal` 当 `result` 用。
    return json(
      res,
      200,
      out.kind === 'write' ? { tool: name, proposal: out.proposal } : { tool: name, result: out.result },
    );
  });
}

/**
 * 聊天请求体的字节上限 —— ⭐ 0.8.6 起**从 2 MB 提到 3 MB**。
 * 依据：一张压缩后的图（目标 ≤ 700 KB）base64 之后会涨约 1/3，再套上 JSON 与文字，2 MB 不够。
 * @type {number}
 */
const CHAT_BODY_MAX = 3 * 1024 * 1024;

/**
 * 功能：读聊天请求体 —— ⭐ 0.8.6 起改读**原始字节**再自己 `JSON.parse`。
 *
 * 说明：⭐⭐ **为什么必须换**：`readBody` 用**字符串拼接**且上限写死 `2e6`，超限直接 `req.destroy()`
 *      ⇒ 带图时前端只看到「网络错误」，而不是一句能读懂的话。换成本函数之后超限得到的是
 *      **礼貌的 413**（⛔ 其余接口一个字不动 —— 那 2e6 是它们既有的约定）。
 *      ⚠️ 解析失败给 `null`，与 `readBody` 的既有行为**逐字一致**（随后 `checkAiChat(null)`
 *      抛 400「聊天内容必须是文本」）。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象（超限时回 413）
 * @param {function(?*)} cb - 解析完成后的回调
 * @returns {void}
 */
function readChatBody(req, res, cb) {
  readRawBody(
    req,
    res,
    (buf) => {
      let b;
      try {
        b = buf.length ? JSON.parse(buf.toString('utf8')) : null;
      } catch (_e) {
        b = null;
      }
      cb(b);
    },
    CHAT_BODY_MAX,
    // ⚠️ 这句是给**用户**看的：不能说成「课表文件」（那是 readRawBody 的缺省措辞）
    '这次发的内容太大了（上限 3 MB）—— 换一张小一点的图，或者先裁一下再发。',
  );
}

/**
 * 功能：把「这一次的用户输入」拼成发给上游的那一条 —— ⭐ 带图时 `content` 由字符串换成**数组**。
 *
 * 说明：⭐⭐ **只有最后这一条会带图，而且图片永远来自本次请求体**（⛔ 不从库里读）——
 *      这就是
 *      （走 `GET /api/ai/messages/<id>/image`），而 `listAiContextMessages()` 的列清单里
 *      根本没有 `image` ⇒ 图**天然不会**被重发。
 *      ⚠️ 纯文本消息**仍然用字符串**形式（⛔ 别顺手统一成数组）—— 只有这样
 *      「没用图片时的请求体与 2 期逐字相同」这条既有承诺才继续成立。
 *      ⚠️ 只带图不带字时**不塞空的 text 段**（部分上游对空 text 段会判参数错）。
 *
 * @param {{content: string, image: ?string}} input - `checkAiChat()` 的结果
 * @returns {{role: string, content: (string|Array.<Object>)}} 发给上游的那一条
 */
function lastUserMessage(input) {
  const text = String((input && input.content) || '');
  const img = input && input.image;
  if (!img) return { role: 'user', content: text };
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  parts.push({ type: 'image_url', image_url: { url: String(img) } });
  return { role: 'user', content: parts };
}

/**
 * 功能：聊天接口的流式实现 —— 用户消息在上游接受后落库，增量逐帧转发，错误走 error 帧（不落库）。
 *
 * 说明：帧序列 —— `{type:'start', chatId, userMessageId}` → `N × {type:'delta', text}` →
 *      `{type:'done', id, used}`（id = 已落库的 assistant 消息 id；`used` 见下）；失败 → `{type:'error', message}`。
 *      ⭐ 用户消息**只在 `onOpen`（上游回 200）之后落库**：没被上游收到的东西不进会话历史，
 *      前端「重发」也不会在历史里留重复的两条；中途停止 / 上游断掉则只留 user 消息
 *      （assistant 残段不落库 —— 那不是一句完整的话）。
 *      ⭐ 客户端断开（关页面 / 点「停止」）→ `req 'close'` → `shouldAbort` 轮询把上游请求一并掐掉
 *      —— 人走了还继续烧上游的额度是最坏的静默浪费。
 *      ⭐ **2 期**：出网内容从「只有这一句话」变成「**本段上下文 + 记忆 + 这一句话**」——
 *      上下文由 `aiContextWindow()` 按「条数 + 字符」双上限裁出来（`cfg.ctxMaxTurns`），
 *      记忆由 `aiReadMemoriesForPrompt()` **全量**取（0.7.6 起不再按 `mem_max` 截断；总开关关着 ⇒ 一条不带）。
 *      `done` 帧的 `used{msgs,chars,mems,seg}` **全部来自实际拼进请求的那一组消息**
 *      （⛔ 不是估算、不是配置值）—— 界面上那句「本次带了 N 条历史 · M 条记忆」才是实话。
 *
 * @param {{req: Object, res: Object, uid: number}} c - 上下文（req / res / uid）
 * @returns {void}
 */
function handleChat({ req, res, uid }) {
  // ⭐ 0.8.6：改走 `readChatBody`（原始字节 + 3 MB 上限）—— 带图时 `readBody` 会直接把连接掐掉
  readChatBody(req, res, (b) => {
    const input = checkAiChat(b); // 同步 throw 由 readChatBody → fail() 收口成 400
    if (!aiAllow(uid)) return json(res, 429, { error: RATE_MSG });
    let out;
    try {
      out = store.aiOutboundConfig(uid, aiKek(), { needEnabled: true });
    } catch (e) {
      return fail(res, e);
    }
    // ---- 前置全部通过，从这里起错误只能走 error 帧 ----
    sseHead(res);
    // ⭐ 断开检测必须挂 **res** 的 close（不是 req）：POST 的请求体被 readBody 消费完后，
    //    req 流自己就会发 close（与「客户端断开」是两回事）—— 挂错的话第一帧都发不出去（实测踩过）。
    //    res 的 close 在「客户端提前断开」与「自己 end()」时都会来，用 writableEnded 区分：
    //    正常收尾不算断开，只有「还没写完连接就没了」才是客户端走了。
    let closed = false;
    res.on('close', () => {
      if (!res.writableEnded) closed = true;
    });
    const send = (o) => {
      if (closed) return;
      try {
        res.write(sseFrame(o));
      } catch (_e) {
        closed = true;
      }
    };
    (async () => {
      try {
        const chat = store.aiEnsureChat(uid);
        // ⭐ 2 期：先算好「这次要带哪些历史 / 哪些记忆」——再拼进请求，`used` 用的也是这一份
        const cfg = store.aiGetConfigView(uid);
        const ctx = store.aiContextWindow(uid, chat.id, cfg);
        const mems = store.aiReadMemoriesForPrompt(uid);
        // ⭐ 3 期：本次带哪些工具说明，由**唯一判据**决定 —— 关着 ⇒ 空串 ⇒ 请求体与 2 期逐字相同
        const auth = store.aiAuthorizedTools(uid);
        const toolText = client.toolsPrompt(auth);
        const messages = [
          // ⭐ 0.6.1：每次调用前注入适配本功能的 system 提示词（无状态会话，不带就等于没说）
          // ⭐ 2 期：本段的历史 + 记忆一并带上（顺序：system → 历史（旧→新）→ 这一次的输入）
          { role: 'system', content: chatSystemPrompt(mems, toolText, cfg.vision) },
          ...ctx.msgs.map((m) => ({ role: m.role, content: m.content })),
          // ⭐ 0.8.6：带图时**只有这一条**的 `content` 是数组（纯文本一个字节都不变）
          lastUserMessage(input),
        ];
        let full = '';
        // ⭐ 3 期：这一轮攒下的**任务提议**（写工具的产物）—— 去重后随 `done` 帧回前端。
        //    ⚠️ 去重键 =「标题 + 截止日期」：模型换个说法把同一件事重复提议很常见，
        //    而确认卡上出现两条一模一样的草稿，只会让人以为要建两条（方案 §4.5 第 4 条）。
        const proposals = [];
        const seenProposal = new Set();
        for (let round = 0; round <= TOOL_ROUND_MAX; round += 1) {
          // ⚠️ 最后一轮**把工具说明摘掉**：模型只能用手上已有的信息收尾 —— 否则它可能
          //    一直只回指令、一个字都不答，用户看到的就是「转了半天什么都没有」。
          const last = round === TOOL_ROUND_MAX;
          if (last) messages[0] = { role: 'system', content: chatSystemPrompt(mems, '', cfg.vision) };
          // ⚠️ 开了读工具时，这一轮的输出**可能是指令**（一整段 JSON）：先压着不发，
          //    判定完再决定「当结果执行」还是「当作回答放出去」。没开工具时 `flushing`
          //    一开始就是真 ⇒ 每个增量当场转发，与 2 期**逐帧相同**。
          let pending = '';
          let flushing = !toolText;
          let delta = '';
          full = await client.chatStream(
            {
              baseUrl: out.baseUrl,
              apiKey: out.key,
              model: out.model,
              messages,
              onOpen: () => {
                if (round !== 0) return; // 用户消息只在上游第一次接受后落库
                const saved = store.aiAppendMessage(uid, chat.id, 'user', input.content, {
                  // ⭐ 0.8.6：图片**跟着用户消息一起落**，而且时机与消息**完全一致** ——
                  //    都在「上游接受了这次请求」之后（⛔ 没被接受的图不进历史）
                  image: input.image,
                  // ⭐⭐ 0.8.55：任务卡片（把任务发给 AI 时带）—— 与图片同一拍落库，
                  //    刷新之后仍是那张卡片（`kind` / `meta` 由历史列表原样带回）。
                  kind: input.card ? input.card.kind : null,
                  meta: input.card ? JSON.stringify(input.card.meta) : null,
                });
                send({ type: 'start', chatId: chat.id, userMessageId: saved.id });
              },
              onDelta: (t) => {
                delta += t;
                if (flushing) {
                  send({ type: 'delta', text: t });
                  return;
                }
                pending += t;
                if (looksLikeIntentPrefix(pending)) return; // 还可能是指令：继续压着
                flushing = true;
                send({ type: 'delta', text: pending });
              },
            },
            { shouldAbort: () => closed },
          );
          // ⛔ 解析失败 / 不是意图 ⇒ 一律**不执行**（这是 R4 的锚点），按普通回答处理。
          // ⭐ `0.7.6`（真机缺陷）：部分第三方部署不守上面的文本协议、把训练里的原生调用
          //    语法（`<|DSML|invoke …` 之类）当正文吐出来。分两路处理，触发都收窄在
          //    「整段以 <| 开头」（`nativeCallShaped`），正常回答不受影响：
          //    ① 抽得出工具名 ⇒ 照常走执行链（判权 / 目录 / 二次校验 / 审计一道不少）；
          //    ② 像标记但抽不出 ⇒ **拦下**：不显示、不落原文，给用户一句人话。
          //    ⚠️ `parseNativeToolCall` 只在形状判定为真之后才调用 —— 它内部用的
          //    `parseLooseJson` 有「从文本抠块」的兜底层，对散文是危险的（R4 的教训）。
          let intent = last || !toolText ? null : client.parseToolIntent(delta);
          let intercepted = false;
          if (!intent && !last && toolText && client.nativeCallShaped(delta)) {
            intent = client.parseNativeToolCall(delta);
            if (!intent) intercepted = true;
          }
          if (intercepted) {
            // ⚠️ 话术要能看懂「该干什么」：不是报错、也不用重登 —— 重问一次就行。
            //    落库的是这句人话；那段机器语法绝不进历史（否则模型下轮学得更像）。
            const notice = '（AI 这条回复没按约定的格式来，已经被拦下。请把刚才的问题再发一次。）';
            send({ type: 'delta', text: notice });
            full = notice;
            break;
          }
          if (!intent) {
            if (!flushing && pending) send({ type: 'delta', text: pending });
            break;
          }
          // 是指令：⛔ 不发给用户、⛔ 不落库；执行后把**结果**续接成下一条消息，让模型接着答
          const r = runIntentForChat(uid, auth, intent);
          if (r.proposal) {
            for (const it of r.proposal.items) {
              const key = `${it.title}\u0000${it.due}`;
              if (seenProposal.has(key)) continue;
              seenProposal.add(key);
              proposals.push({ ...it, kind: r.proposal.kind });
            }
          }
          messages.push({ role: 'assistant', content: JSON.stringify(intent) });
          messages.push({ role: 'user', content: r.text });
        }
        const saved = store.aiAppendMessage(uid, chat.id, 'assistant', full);
        // ⭐ 0.7.7-⑲：有提议 ⇒ 把确认卡**落成一条消息**（不落库的话刷新就没了、两颗按钮也没了）。
        //    ⚠️ 它与上面那条助手回复是**两条消息**：回复是「AI 说的话」，卡片是「待你决定的东西」，
        //    合成一条会让「刷新之后卡还在不在」变成一个说不清的问题。
        const card = proposals.length ? store.aiAppendProposal(uid, chat.id, proposals) : null;
        send({
          type: 'done',
          id: saved.id,
          used: { msgs: ctx.msgs.length, chars: ctx.chars, mems: mems.length, seg: ctx.segment },
          // ⚠️ **只在真有提议时才带这两个键** —— 没有提议时这一帧与 2 期**逐字相同**
          //    （老前端不认识它们也照旧工作， 两端共用同一份 shared.js）。
          //    ⭐ `card` 是**落库之后**的卡片（含 id 与快照），前端据此在会话流里画那张卡；
          //    `proposals` 一起带着，只为兼容 0.7.7 之前的前端（它靠这个开模态确认卡）。
          ...(proposals.length ? { proposals } : {}),
          ...(card ? { card } : {}),
        });
        res.end();
      } catch (e) {
        send({ type: 'error', message: (e && e.message) || 'AI 接口出错了，请稍后再试' });
        try {
          res.end();
        } catch (_e) {
          /* 连接已经没了 */
        }
      }
    })();
  });
}

/**
 * 功能：指挥 AI 建任务 —— 被点消息（判权后）+ 手填补充发给模型，返回结构化草稿与发送预览。
 *
 * 说明：⭐ `sentPreview` 与**实际发出的** user 消息逐字相同（前端弹预览时展示的就是它）；
 *      `messageId` 不是自己的 / 不存在 / 对话模块被删 → 一律 404（与不存在同体）；
 *      模型回复解析不出任务 → 400 `{reason:'format'}`；**不落任何库** —— 草稿只进前端确认卡。
 *
 * @param {{req: Object, res: Object, uid: number}} c - 上下文（req / res / uid）
 * @returns {void}
 */
function handleExtract({ req, res, uid }) {
  readBody(req, res, (b) => {
    const input = checkAiExtract(b);
    if (!aiAllow(uid)) return json(res, 429, { error: RATE_MSG });
    let out;
    try {
      out = store.aiOutboundConfig(uid, aiKek(), { needEnabled: true });
    } catch (e) {
      return fail(res, e);
    }
    let source = null;
    if (input.messageId) {
      source = store.aiGetOwnChatMessage(uid, input.messageId);
      if (!source) return notFound(res);
    }
    const sentPreview = extractUserContent(source ? source.body : '', input.text || '');
    (async () => {
      try {
        const content = await client.chatOnce({
          baseUrl: out.baseUrl,
          apiKey: out.key,
          model: out.model,
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: sentPreview },
          ],
        });
        const tasks = normalizeTasks(client.parseLooseJson(content));
        if (!tasks) throw httpError(400, 'AI 没有返回能认的任务清单，请换个说法再试一次', { reason: 'format' });
        return json(res, 200, { tasks, sentPreview });
      } catch (e) {
        return fail(res, upstreamFail(e));
      }
    })();
  });
}

// ⭐ 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/ai` 上
module.exports = { ai: handleAi };
