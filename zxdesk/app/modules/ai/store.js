'use strict';
/**
 * modules/ai/store.js —— ai辅助任务的**业务方法**（0.6.0）
 *
 * 功能：AI 接口配置的读写视图与保存 —— `aiGetConfigView()`（**永不含 key 的任何投影**的视图）、
 *      `aiSaveConfig()`（保存配置，key 明文只在这里的**一瞬间**被封装成密文）、
 *      `aiClearKey()`（显式清除 key）。方法只写 `this._bk.<op>()`，不判后端。
 *
 * ⭐⭐ 0.8.12：**AI 聊天会话改由团队协作托管** —— 会话行与消息的落库并进
 *    协作的两张表（`builtin_key = 'ai'` / `sender_builtin = 'ai'`），本文件那一组聊天方法
 *    （`aiGetChat` / `aiEnsureChat` / `aiAppendMessage` / `aiListMessages` / `aiMessageImage` /
 *    `aiNewSegment` / `aiContextWindow` / `aiResolveProposal`）**只调协作的公开业务方法**
 *    （`this.teamworkAi*`；AI 不直接读写对话的表）。
 *    ⚠️ 存量老会话由协作侧一次性搬迁（`ai_chats` / `ai_messages` **保留、不再写**，降级退路）。
 *
 * ⭐ **「绝不回显」红线的实现边界就在本文件**：`aiGetConfigView()` 是 HTTP 读接口唯一的数据来源，
 *    它的返回值里只有 `{ configured, enabled, baseUrl, model, keySet }` ——
 *    **没有任何字段承载 key 的明文、密文、长度或尾号**。整行（含密文三列）不走出本文件。
 *
 * ⭐ **KEK 作参数传进来、不在本文件里找**：`lib/seal.js` 是纯函数（不 require `core/context.js`），
 *    而 `AUTH_SECRET` 在 `context.js` —— routes 层（本来就 require 了 context）派生 KEK 后传下来。
 *    这样做有两个收获：① Store 装配链上**没有**指向 context 的 require（无循环加载）；
 *    ② 存储层测试可以拿一把**测试密钥**直接调这些方法，不必起整个应用。
 *
 * ⚠️ **fail-safe**：解 key 时若密文材料失效（换实例 / `auth.secret` 被删 / 密文被篡改），
 *    GCM tag 校验会抛 —— 本模块**绝不**把它静默成「未配置」；`aiSaveConfig` 里**没有**解 key 的路径
 *    （保存只封装、不回读），解 key 只发生在出网路径上（`aiOutboundConfig`），失败按「明确报错请重填」处理。
 *
 * ⚠️ 方法名一律带 `ai` 前缀：业务方法平铺到同一 Store 原型上，
 *    通用名会**静默覆盖**；`assertNoMethodClash()` 在装配期兜底。
 *
 * ⭐ **2 期在本文件新增**：对话分段（`aiNewSegment` / `aiContextWindow`）与
 *    长期记忆的 CRUD（`aiListMemories` / `aiAddMemory` / `aiUpdateMemory` / `aiDeleteMemory` /
 *    `aiClearMemories` / `aiReadMemoriesForPrompt`）。⚠️ 记忆**不与出网耦合**：
 *    本文件只负责取「该带哪几条」，「怎么拼进提示词」在 `routes.js` 的 `chatSystemPrompt()`。
 *
 * ⭐ **3 期在本文件新增**：AI 工具调用的**授权底座** —— `aiGetConfigView` 多回四个
 *    「工具」字段、`aiSaveConfig` 多认四个键、⭐ **`aiAuthorizedTools(uid)` 是本模块唯一那处授权判据**
 *    （服务端执行任何工具前都必须问它，⛔ 不许各处自己去读那两列拼条件 —— 那是「两份口径」的病根），
 *    以及审计的记与读（`aiAppendAudit` / `aiListAudit`）。
 *    ⚠️ 清单的合法值（`tasks` / `timetable` / `ledger`）与硬边界（`vault` / `chat` 永不在表里）都在 `lib/tools.js`，
 *    本文件只负责「解析 + 清洗 + 按总开关收敛」。
 *    ⚠️ 审计**只记工具名 / 参数摘要 / 成败 / 拒绝原因**，⛔ 工具结果、记忆正文、任何 key 都不进审计
 *    （与「六不」同一条红线：日志与审计都不承载用户内容）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.61
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、docs/公共/开发方案/14-AI辅助任务-2期.md、docs/公共/开发方案/16-AI辅助任务-3期-AI工具调用与授权.md、modules/vault/store.js
 */

const { nowStamp, badRequest } = require('../../core/store/helpers.js');
const logs = require('../../core/logs.js');
const seal = require('./lib/seal.js');
const client = require('./lib/openai-client.js');
const tools = require('./lib/tools.js');

/**
 * 字符兜底常数（2 期）—— **用户不可配**，界面上也不提。
 *
 * 说明：⚠️ 它防的是「一条超长消息把请求撑爆」，不是「管住 token」——用户填的是**自定义通用接口**，
 *      token 上限本来就不可知，所以不该让用户操心这件事。
 *      ⚠️ 与另外两组**可配**上限（条数 20~200 / 记忆 5~50）不同：那两个的默认值必须与
 *      `routes.js` 的区间常量同处一套口径，但**互不重复** ——
 *      本文件写「默认值」（NULL 列回落用），`routes.js` 写「区间」（入参校验用），各自只写一处。
 *
 *      ⭐ 0.7.7-⑰：**20000 → 60000**。原因不是「想多带」，而是**条数上限抬到 200 之后必须一起抬**：
 *      这个窗口是**双上限**（`aiContextWindow()` 每条先判条数、再判字符），200 条 × 平均 100 字
 *      正好撞上 20000 ⇒ 用户把「每次带多少条历史」填成 200，实际只带上几十条，而且**不报错**。
 *      按 200 条 × 每条约 250 字的上限水位留出余量（`checkAiMessage` 那一侧对单条没有字数闸门，
 *      长消息靠这 60000 兜住；超长的那一条会把它自己截在窗口外，语义与原来一致）。
 *
 * @type {number}
 */
const AI_CTX_MAX_CHARS = 60000;

/** 带多少条历史的**默认值**（`ai_configs.ctx_max_turns` 为 NULL 时用它） @type {number} */
const CTX_TURNS_DEFAULT = 20;
/** 是否把记忆带进上下文的**默认值**（`mem_enabled` 为 NULL 时用它） @type {number} */
const MEM_ENABLED_DEFAULT = 1;
/** 最多带几条记忆的**默认值**（`mem_max` 为 NULL 时用它） @type {number} */
const MEM_MAX_DEFAULT = 20;

/**
 * ⭐ 0.7.7-⑱：**预设三条的名称** —— 它们**不能被删除**，只能改内容。
 *
 * 说明：⭐ 名字必须有**一份**权威出处才守得住：前端 `public/modules/ai/shared.js` 的
 *      `MEM_PRESETS` 是那份**镜像**（它负责界面：名称只读、不画 ✕），本文件是**护栏**
 *      （就算有人绕过界面直接打 `DELETE /api/ai/memories/<id>` 也删不掉）。
 *      ⚠️ 两层各一份是**刻意**的（前端是体验、服务端是护栏），与「两端文案」「前后端区间常量」
 *      同一套路 —— **改这里必须同步改 `shared.js` 那一份**。
 *      ⚠️ 判据是**名称**（不是 id、不是新列）：库里正好已经有这三条同名记忆
 *      （`用户名称` / `AI助手名称` / `约定`），靠名称复用才能「升级之后原样还在」，
 *      且**一个字节都不用改库**（不新增列、不建新表）。
 * @type {Array.<string>}
 */
const MEM_PRESET_LABELS = ['用户名称', 'AI助手名称', '约定'];

/**
 * 功能：这一条是不是**预设三条**之一（按名称判 —— 与前端复用口径同一个判据）。
 * @param {?string} label - 记忆名称（NULL / 空串都算「不是预设」）
 * @returns {boolean} 是预设为 true
 */
const isPresetMemory = (label) => MEM_PRESET_LABELS.includes(String(label == null ? '' : label).trim());

/**
 * 功能：可空整数列的取值 —— `NULL` / `undefined` 时回落代码里的默认值。
 * @param {*} v - 列值
 * @param {number} d - 默认值
 * @returns {number} 取值
 */
const intOr = (v, d) => (v == null ? d : Number(v));

/**
 * 功能：可空布尔列的取值 —— `NULL` / `undefined` 时回落代码里的默认值。
 * @param {*} v - 列值
 * @param {number} d - 默认值（0 / 1）
 * @returns {boolean} 取值
 */
const boolOr = (v, d) => (v == null ? !!d : !!v);

/** 读 AI 记录时最多回多少条（`AUDIT_MAX`；更旧的仍在文件里，只是这一次不展示） @type {number} */
const AUDIT_MAX = 200;

// ---- ⭐ 0.7.7-⑲：AI 任务确认卡（会话流里的那张卡）----

/**
 * 确认卡的消息种类（`ai_messages.kind`）—— ⚠️ 只认下面这两个值。
 *
 * 说明：⭐ `task_proposal`（0.7.7-⑲，任务）与 `ledger_proposal`（0.8.4，记账）是**同一套机制**
 *      的两种载荷：都是「只提议、点确认才落库」，差别只在卡上的字段与「同意」时调哪个唯一入口。
 *      ⚠️ 判「是不是一张提议卡」**只此一处**（`isProposalKind()`）：⛔ 别在别处再写一遍
 *      `=== 'task_proposal' || === 'ledger_proposal'`（那种写法漏一处就是「卡画不出来、且不报错」）。
 * @type {string}
 */
const KIND_TASK_PROPOSAL = 'task_proposal';

/** 记账提议卡的消息种类（0.8.4）。 @type {string} */
const KIND_LEDGER_PROPOSAL = 'ledger_proposal';

/** ⭐ 0.8.5：收藏提议卡的消息种类（「接入 ai 的读写」）。 @type {string} */
const KIND_BOOKMARKS_PROPOSAL = 'bookmarks_proposal';

/** ⭐ 0.8.5：随手记提议卡的消息种类。 @type {string} */
const KIND_IDEA_PROPOSAL = 'idea_proposal';

/** ⭐ 0.8.5：硬件提议卡的消息种类。 @type {string} */
const KIND_HARDWARE_PROPOSAL = 'hardware_proposal';

/** ⭐ 0.8.6：车票提议卡的消息种类（行程模块）。 @type {string} */
const KIND_TRIP_PROPOSAL = 'trip_proposal';

/** ⭐⭐ 0.8.55：资产提议卡的消息种类（个人资产管理）。 @type {string} */
const KIND_ASSETS_PROPOSAL = 'assets_proposal';

/** ⭐⭐ 0.8.55：日程提议卡的消息种类（日历）。 @type {string} */
const KIND_CALENDAR_PROPOSAL = 'calendar_proposal';

/** 八种提议卡（判据的唯一出处）。 @type {Array.<string>} */
const PROPOSAL_KINDS = [
  KIND_TASK_PROPOSAL,
  KIND_LEDGER_PROPOSAL,
  KIND_BOOKMARKS_PROPOSAL,
  KIND_IDEA_PROPOSAL,
  KIND_HARDWARE_PROPOSAL,
  KIND_TRIP_PROPOSAL,
  KIND_ASSETS_PROPOSAL,
  KIND_CALENDAR_PROPOSAL,
];

/**
 * ⭐ 0.8.5：写工具产物上带的 `kind` 是**模块名**（`tasks` / `ledger` / `bookmarks` / `idea` /
 * `hardware` —— 见 `lib/tools-write.js` 里每一处 `return { kind: … }` 与
 * `public/modules/ai/shared.js` 的 `PROPOSAL_UI`），这里翻译成**消息种类**。
 * ⚠️ 认不出来的（老数据 / 没带 kind）一律当任务卡 —— 与 `unpackProposalMeta()` 的兜底同一条口径。
 * @type {Object.<string, string>}
 */
const KIND_BY_MODULE = {
  tasks: KIND_TASK_PROPOSAL,
  ledger: KIND_LEDGER_PROPOSAL,
  bookmarks: KIND_BOOKMARKS_PROPOSAL,
  idea: KIND_IDEA_PROPOSAL,
  digital: KIND_HARDWARE_PROPOSAL,
  trip: KIND_TRIP_PROPOSAL,
  assets: KIND_ASSETS_PROPOSAL,
  calendar: KIND_CALENDAR_PROPOSAL,
};

/**
 * ⭐ 0.8.5：用户点「同意」之后，助手**立刻回的那句话**的模板 —— 每种卡一套。
 *
 * 说明：⚠️ `%A` = 成功条数、`%F` = 失败条数、`%R` = 失败原因（见 `replyOf()`）。
 *      ⚠️ 任务与记账那两套文案与 0.8.4 **逐字一致**（⛔ 无谓地改它只会让老用户觉得界面变了）。
 * @type {Object.<string, {ok: string, part: string, why: string}>}
 */
const KIND_REPLY = {
  [KIND_TASK_PROPOSAL]: {
    ok: '已加入任务：%A 条。',
    part: '已加入任务：%A 条；另有 %F 条没能加上（%R），可以让 AI 重新整理一遍。',
    why: '标题为空或归属的项目已不存在',
  },
  [KIND_LEDGER_PROPOSAL]: {
    ok: '已记账：%A 笔。',
    part: '已记账：%A 笔；另有 %F 笔没能记上（%R），可以让 AI 重新整理一遍。',
    why: '金额没填对',
  },
  [KIND_BOOKMARKS_PROPOSAL]: {
    ok: '已收藏：%A 条。',
    part: '已收藏：%A 条；另有 %F 条没能存进去（%R），可以让 AI 重新整理一遍。',
    why: '网址没写全或它已经收藏过了',
  },
  [KIND_IDEA_PROPOSAL]: {
    ok: '已记下：%A 条。',
    part: '已记下：%A 条；另有 %F 条没能记下（%R），可以让 AI 重新整理一遍。',
    why: '正文为空',
  },
  [KIND_HARDWARE_PROPOSAL]: {
    ok: '已登记：%A 件。',
    part: '已登记：%A 件；另有 %F 件没能写进台账（%R），可以让 AI 重新整理一遍。',
    why: '名称没填',
  },
  [KIND_TRIP_PROPOSAL]: {
    ok: '已加进去：%A 张票。',
    part: '已加进去：%A 张票；另有 %F 张没能加上（%R），可以让 AI 重新整理一遍。',
    why: '出发站、到达站或出发时刻没填对',
  },
  [KIND_ASSETS_PROPOSAL]: {
    ok: '已记进资产台账：%A 条。',
    part: '已记进资产台账：%A 条；另有 %F 条没能记上（%R），可以让 AI 重新整理一遍。',
    why: '名称没填，或那个分组已经不在了',
  },
  [KIND_CALENDAR_PROPOSAL]: {
    ok: '已加进日历：%A 条日程。',
    part: '已加进日历：%A 条；另有 %F 条没能加上（%R），可以让 AI 重新整理一遍。',
    why: '标题或日期没填对',
  },
};

/**
 * 功能：把 `KIND_REPLY` 里的模板填成实际数字与原因。
 * @param {Object} t - `KIND_REPLY` 里的一项
 * @param {number} added - 成功条数
 * @param {number} failed - 失败条数
 * @returns {string} 助手回话正文
 */
function replyOf(t, added, failed) {
  return (failed ? t.part : t.ok).replace('%A', String(added)).replace('%F', String(failed)).replace('%R', t.why);
}

/**
 * 功能：判断一个 `kind` 是不是提议卡 —— ⭐ 本文件里唯一的判据。
 * @param {*} kind - `ai_messages.kind` 的值
 * @returns {boolean} 是提议卡为 true
 */
function isProposalKind(kind) {
  return PROPOSAL_KINDS.includes(String(kind == null ? '' : kind));
}

/**
 * 用户点「拒绝」之后，助手立刻回的那句话 —— ⭐ 正文**只此一处**（指定的原话）。
 *
 * 说明：⚠️ 前端两个主文件里都**不许**再写一份字面量（各写一份 = 改一处忘一处）。
 *      它由服务端在拒绝那条路径上落成一条真正的助手消息（刷新页面也还在）。
 * @type {string}
 */
const PROPOSAL_REJECT_REPLY = '有哪里不对，我继续修改';

/**
 * 确认卡在**注入模型**时被降级成的那句话 —— ⚠️⭐ 这是本项最要紧的一条护栏。
 *
 * 说明：卡片的 `meta` 是一段 JSON（字段名、结构都是内部约定）。把它原样喂回模型，模型会学着
 *      自己吐这种结构，与协议 V1「只输出一个纯 JSON」的约定打架。
 *      所以注入时只留**一句人话**：提议了几个、第一个叫什么、用户处理了没有。
 *
 * @param {Object} meta - 已解析的卡片快照
 * @returns {string} 一句话（含括号，直接拼进上下文）
 */
function proposalLine(meta) {
  const items = Array.isArray(meta && meta.items) ? meta.items : [];
  const n = items.length;
  const kind = String((meta && meta.kind) || '') || KIND_TASK_PROPOSAL;
  // ⚠️⭐ 每种卡的「第一个」说的东西**不一样**（任务说标题、记账说金额 + 分类、收藏说标题或网址、
  //    随手记说正文开头、硬件说名称）—— 表驱动，加一种卡只加一行（⛔ 别摊成一串 if）。
  const FIRST_OF = {
    [KIND_TASK_PROPOSAL]: (x) => (x && x.title ? `『${String(x.title)}』` : ''),
    [KIND_LEDGER_PROPOSAL]: (x) =>
      x && x.amount ? `『${String(x.category_name || x.note || '一笔账')} ${String(x.amount)} 元』` : '',
    [KIND_BOOKMARKS_PROPOSAL]: (x) => (x && (x.title || x.url) ? `『${String(x.title || x.url)}』` : ''),
    [KIND_IDEA_PROPOSAL]: (x) => (x && x.content ? `『${String(x.content).slice(0, 20)}』` : ''),
    [KIND_HARDWARE_PROPOSAL]: (x) => (x && x.name ? `『${String(x.name)}』` : ''),
    [KIND_TRIP_PROPOSAL]: (x) =>
      x && (x.from || x.to)
        ? `『${[String(x.code || ''), `${String(x.from || '?')} → ${String(x.to || '?')}`].filter(Boolean).join(' ')}』`
        : '',
  };
  const WHAT_OF = {
    [KIND_TASK_PROPOSAL]: '个任务',
    [KIND_LEDGER_PROPOSAL]: '笔记账',
    [KIND_BOOKMARKS_PROPOSAL]: '条收藏',
    [KIND_IDEA_PROPOSAL]: '条随手记',
    [KIND_HARDWARE_PROPOSAL]: '件硬件',
    [KIND_TRIP_PROPOSAL]: '张车票',
  };
  const first = (FIRST_OF[kind] || FIRST_OF[KIND_TASK_PROPOSAL])(items[0]);
  const state = String((meta && meta.state) || 'pending');
  const word = state === 'agreed' ? '用户已同意' : state === 'rejected' ? '用户已拒绝' : '用户还没有处理';
  const what = WHAT_OF[kind] || WHAT_OF[KIND_TASK_PROPOSAL];
  return `（你上一次提议了 ${n} ${what}${first ? '，第一个是' + first : ''}，${word}）`;
}

/**
 * 功能：把模型回复里解析出的提议条目收成**卡片快照**（逐字段白名单搬运）。
 *
 * 说明：⚠️⭐ **逐个字段搬运、绝不整包透传**（照 卡片是快照的同一条理由）——
 *      模型输出里多出来的键（内部调试字段、原文片段、甚至它自己编的结构）一个都进不来。
 *      ⚠️ 字段名与 `public/modules/ai/shared.js` 的 `confirmCardHtml()` 认的那几个**逐字对齐**。
 *      ⭐ 0.8.4：**两套白名单**（任务 / 记账）—— ⛔ 别把它们合成一张「所有键都收」的宽表：
 *      任务卡上的字段与记账卡上的字段**没有交集**，合并的结果是两张卡各带一半用不上的键。
 *
 * @param {Array.<Object>} items - 提议条目（`routes.js` 已归一过一次）
 * @param {string} [kind] - 卡片种类（`KIND_TASK_PROPOSAL` / `KIND_LEDGER_PROPOSAL`）
 * @returns {Array.<Object>} 快照条目
 */
function snapshotProposalItems(items, kind) {
  const list = Array.isArray(items) ? items : [];
  // ⭐ 0.8.6：车票（行程模块）—— ⚠️ `kind` 是**已归一化**的六值枚举，`kind_want` 是「模型原本说的」；
  //    `bad` / `why` 是**服务端标出来的「这一条没看懂」** ⇒ 卡上必须显示出来，⛔ 不许静默丢掉那一条
  //    （丢掉了用户就以为「AI 什么都没整理出来」）。
  if (String(kind || '') === KIND_TRIP_PROPOSAL) {
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      return {
        kind: String(s.kind == null ? '' : s.kind),
        kind_want: String(s.kind_want == null ? '' : s.kind_want),
        code: String(s.code == null ? '' : s.code),
        from: String(s.from == null ? '' : s.from),
        to: String(s.to == null ? '' : s.to),
        depart: String(s.depart == null ? '' : s.depart),
        arrive: String(s.arrive == null ? '' : s.arrive),
        seat: String(s.seat == null ? '' : s.seat),
        gate: String(s.gate == null ? '' : s.gate),
        note: String(s.note == null ? '' : s.note),
        bad: !!s.bad,
        why: String(s.why == null ? '' : s.why),
      };
    });
  }
  if (String(kind || '') === KIND_LEDGER_PROPOSAL) {
    // ⚠️ 记账那几列：`category_id` / `account_id` 是**落库要用的**（`null` = 未分类 / 不关联账户）；
    //    `*_want` 是「模型原本说的名字」—— 卡上据此写「它想记到『餐饮』，本机没有这个分类」。
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      const cid = Number(s.category_id);
      const aid = Number(s.account_id);
      return {
        at: String(s.at == null ? '' : s.at),
        ie: String(s.ie == null ? '' : s.ie) === '收入' ? '收入' : '支出',
        amount_fen: Math.trunc(Number(s.amount_fen)) || 0,
        amount: String(s.amount == null ? '' : s.amount),
        category_id: s.category_id != null && Number.isFinite(cid) ? cid : null,
        category_name: String(s.category_name == null ? '' : s.category_name),
        category_want: String(s.category_want == null ? '' : s.category_want),
        account_id: s.account_id != null && Number.isFinite(aid) ? aid : null,
        account_name: String(s.account_name == null ? '' : s.account_name),
        account_want: String(s.account_want == null ? '' : s.account_want),
        note: String(s.note == null ? '' : s.note),
      };
    });
  }
  // ⭐ 0.8.5：收藏 / 随手记 / 硬件 三套白名单（字段与各自 `*ItemHtml()` 认的键**逐字对齐**）
  if (String(kind || '') === KIND_BOOKMARKS_PROPOSAL) {
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      return {
        url: String(s.url == null ? '' : s.url),
        title: String(s.title == null ? '' : s.title),
        tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t)).filter(Boolean),
        // `dup` = 服务端拿库里的网址核过（点了同意也写不进去）—— 卡上要显眼写出来
        dup: !!s.dup,
      };
    });
  }
  if (String(kind || '') === KIND_IDEA_PROPOSAL) {
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      return {
        content: String(s.content == null ? '' : s.content),
        tag: String(s.tag == null ? '' : s.tag),
      };
    });
  }
  if (String(kind || '') === KIND_HARDWARE_PROPOSAL) {
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      const text = (v) => String(v == null ? '' : v);
      return {
        name: text(s.name),
        category: text(s.category),
        status: ['owned', 'wishlist', 'retired'].includes(text(s.status)) ? text(s.status) : 'owned',
        brand: text(s.brand),
        model: text(s.model),
        capacity: text(s.capacity),
        purpose: text(s.purpose),
        purchase_date: text(s.purchase_date),
        purchase_price: text(s.purchase_price),
        expected_life_months: text(s.expected_life_months),
      };
    });
  }
  // ---- ⭐⭐ 0.8.55：资产与日程两套白名单（字段与 `assetItemHtml()` / `eventItemHtml()` 逐字对齐）----
  if (String(kind || '') === KIND_ASSETS_PROPOSAL) {
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      const fen = Number(s.amount_fen);
      const gid = Number(s.group_id);
      return {
        name: String(s.name == null ? '' : s.name),
        group_id: s.group_id != null && Number.isFinite(gid) ? gid : null,
        group_name: String(s.group_name == null ? '' : s.group_name),
        group_want: String(s.group_want == null ? '' : s.group_want),
        // ⚠️ 金额单位**分**；`null` = 「没记金额」（与 0 分是两件事，⛔ 别糊成 0）
        amount_fen: s.amount_fen != null && Number.isFinite(fen) ? fen : null,
        date: String(s.date == null ? '' : s.date),
        bad: !!s.bad,
        why: String(s.why == null ? '' : s.why),
      };
    });
  }
  if (String(kind || '') === KIND_CALENDAR_PROPOSAL) {
    return list.map((it) => {
      const s = it && typeof it === 'object' ? it : {};
      return {
        title: String(s.title == null ? '' : s.title),
        date: String(s.date == null ? '' : s.date),
        end_date: String(s.end_date == null ? '' : s.end_date),
        all_day: !!s.all_day,
        start_time: String(s.start_time == null ? '' : s.start_time),
        end_time: String(s.end_time == null ? '' : s.end_time),
        bad: !!s.bad,
        why: String(s.why == null ? '' : s.why),
      };
    });
  }
  return list.map((it) => {
    const s = it && typeof it === 'object' ? it : {};
    return {
      title: String(s.title == null ? '' : s.title),
      due: String(s.due == null ? '' : s.due),
      important: s.important ? 1 : 0,
      urgent: s.urgent ? 1 : 0,
      note: String(s.note == null ? '' : s.note),
      scope: s.scope == null ? 'daily' : s.scope,
      // ⭐⭐ 0.8.55：任务类型与周期规则 —— ⚠️ 字段名是 `task_kind`（**不是** `kind`）：
      //    `kind` 在提议产物里是**模块名**，两件事不能共用一个键（见 `tools-write.js` 的说明）。
      //    白名单里漏掉它 ⇒ 卡上「周期」那一条会退化成普通任务，用户点同意建出来的是另一种东西。
      task_kind: ['plain', 'window', 'cycle'].includes(String(s.task_kind || '')) ? String(s.task_kind) : 'plain',
      rule: String(s.rule == null ? '' : s.rule),
    };
  });
}

/**
 * 功能：把卡片快照序列化成 `meta` 列要存的 JSON 文本。
 *
 * 说明：⭐ 0.8.4：`kind` **存进 `meta`**（不只存在消息行那一列）—— 前端渲染时只拿得到
 *      `{id, meta}`（历史消息那条路径），靠它才能知道该画任务卡还是记账卡。
 * @param {Array.<Object>} items - 快照条目
 * @param {string} [state] - `'pending'` / `'agreed'` / `'rejected'`
 * @param {string} [kind] - 卡片种类（缺省 = 任务卡，与老数据一致）
 * @returns {string} JSON 文本
 */
function packProposalMeta(items, state, kind) {
  // ⭐ 0.8.5：`kind` 直接来自 `PROPOSAL_KINDS` 那五个值（写工具的产物已由 `KIND_BY_MODULE` 翻过）
  const want = String(kind || '');
  const k = PROPOSAL_KINDS.includes(want) ? want : KIND_TASK_PROPOSAL;
  return JSON.stringify({ items: snapshotProposalItems(items, k), state: state || 'pending', kind: k });
}

/**
 * 功能：解析 `ai_messages.meta`（坏 JSON / 空值一律当「不是卡片内容」，返回 null，⛔ 不抛错）。
 *
 * 说明：⚠️ 解析失败的方向必须是**安全**的：调用方据此把这一行当普通消息显示
 *      （`content` 是降级文本），而不是把整段会话读崩。
 *
 * @param {*} text - 列值
 * @returns {?Object} 解析出来的快照；解析不出来为 null
 */
function unpackProposalMeta(text) {
  if (text == null || text === '') return null;
  try {
    const v = JSON.parse(String(text));
    return v && typeof v === 'object' ? v : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：把一行 AI 消息整理成**给前端的形状** —— `kind` 归一、`meta` 解析成对象。
 *
 * 说明：⚠️ `meta` 给前端的必须是**对象**（不是库里那段 JSON 文本）：两端渲染同一个 `shared.js`，
 *      形状不一致就会「一端画得出卡片、另一端只有一行降级文本」，且不报错。
 *      ⚠️ 解析不出来时 `meta` 是 `null` ⇒ 前端按普通消息渲染那一行（`content` 是降级文本）。
 *
 * @param {Object} r - 存储层返回的消息行
 * @returns {Object} 前端用的消息行
 */
/**
 * 一段「机器语法」历史消息被读出来时替换成的那句话。
 *
 * ⭐⭐ 0.8.55（真机）：拦截层修好之前，有些回复把**原生工具调用标记**
 * （`<｜｜DSML｜｜calls>` 那一坨）当成正文落了库。修好之后不会再产生新的，
 * 但**已经躺在库里的那几条**不会自己消失 —— 而且会被当作上下文再喂给模型（它下轮学得更像）。
 * ⇒ 出口处统一换成人话：界面上不再显示那堆符号，模型也看不到。
 * @type {string}
 */
const MACHINE_TEXT_NOTICE = '（这条回复当时是一段机器语法，已经不再显示。）';

/**
 * 功能：把一条历史消息的正文**清洗成能给人看的样子**（只动 assistant 那侧）。
 *
 * 说明：⚠️ 只判「看起来是原生调用标记」（`client.nativeCallShaped()`，认全角与半角竖线），
 *      ⛔ 不做任何改写 —— 正文一个字不动，只在这条整体是机器语法时整条替换。
 *      ⚠️ 用户自己发的消息**永远不动**（他打什么就是什么，哪怕他真的贴了一段 `<|DSML|`）。
 * @param {*} role - `'user'` / `'assistant'`
 * @param {*} content - 正文
 * @returns {string} 可以给界面 / 给模型看的正文
 */
function cleanHistoryText(role, content) {
  const t = String(content == null ? '' : content);
  if (String(role) !== 'assistant') return t;
  return client.hasNativeMarkers(t) ? MACHINE_TEXT_NOTICE : t;
}

/**
 * 功能：把一行消息行整成**对外形状**（历史列表每一行都过它）。
 * @param {Object} r - 消息行（含 `role` / `content` / `kind` / `meta` / `has_image` …）
 * @returns {Object} 对外形状
 */
function decorateMessage(r) {
  return {
    id: r.id,
    role: r.role,
    // ⭐ 0.8.55：机器语法那一类历史消息换成一句人话（见 `MACHINE_TEXT_NOTICE`）
    content: cleanHistoryText(r.role, r.content),
    segment: r.segment,
    kind: r.kind == null ? null : String(r.kind),
    meta: unpackProposalMeta(r.meta),
    // ⭐ 0.8.6：**只给「这条有没有图」，⛔ 不给图本身**（`decorateMessage` 的入参来自
    //    两后端那份「只选 has_image」的清单）⇒ 历史列表的载荷永远不会拖 base64。
    //    `Number(...) === 1` 对 undefined / null / 0 一律 false（老库补出来的行没有这个键）。
    has_image: Number(r.has_image) === 1,
    created_at: r.created_at,
  };
}

/** 审计里「参数摘要」的长度上限（字）—— 摘要只说明「动了哪一步」，不是复刻参数本身 @type {number} */
const AUDIT_ARGS_MAX = 80;

/** 审计里「失败原因」的长度上限（字） @type {number} */
const AUDIT_REASON_MAX = 120;

/**
 * 功能：把一份「模块清单」清洗成合法值数组 —— **白名单外的（含 `vault` / `chat`）一律剔除**。
 *
 * 说明：⭐ 这是硬边界的**第二道**（第一道是「表里没有这个工具」，见 `lib/tools.js`）：
 *      授权清单只认 `tools.READ_MODULES` / `tools.WRITE_MODULES` 里的名字，
 *      于是「库里躺着一条脏数据」与「有人绕过接口直接写库」都进不了工具面。
 *      ⚠️ 重复项顺手去重；非数组**不是抛错而是空清单** —— 调用方（`viewOf`）拿到的永远是可用值。
 *
 * @param {*} v - 任意值（正常是数组）
 * @param {Array.<string>} allowed - 该授权方向的白名单模块名
 * @returns {Array.<string>} 清洗后的模块名（**失败方向安全：拿不准就是空清单 = 全关**）
 */
function cleanModules(v, allowed) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v) {
    const name = String(it == null ? '' : it).trim();
    if (allowed.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 功能：把授权清单**列**（JSON 数组文本）解析并清洗 —— ⭐ **解析失败一律空清单（全关）**。
 *
 * 说明：⚠️ 这里刻意不做「解析失败就放行」：脏数据（手改过的库 / 半截写入）只会让 AI **少**用工具，
 *      绝不让它多读一份数据。总开关关着时外层还会再收敛一次（见 `aiAuthorizedTools`）。
 *
 * @param {*} text - 列值（JSON 文本；NULL / 空 / 非 JSON / 非数组都算空清单）
 * @param {Array.<string>} allowed - 该授权方向的白名单模块名
 * @returns {Array.<string>} 合法模块名数组
 */
function parseModules(text, allowed) {
  let arr;
  try {
    arr = JSON.parse(String(text == null ? '' : text));
  } catch (_e) {
    return [];
  }
  return cleanModules(arr, allowed);
}

/**
 * 功能：patch 键 → `ai_configs` 列名的**硬映射**（`updateAiConfig` op 的白名单收口）。
 *
 * 说明：⚠️ 三个 key 密文列**不在这张映射上**（它们只能由 `apiKey` 一个 patch 键**整体**写入，
 *      绝不出现「只更新了 iv 没更新 cipher」的中间态）；`created_at` / `user_id` / `id`
 *      同样不可达 —— 配置没有「过户」与「改创建时间」的语义。
 *      ⭐ 2 期追加 3 个：`ctx_max_turns` / `mem_enabled` / `mem_max` ——
 *      **区间校验在 `routes.js`**（越界一律 400），本映射只管「patch 键 → 列名」。
 *
 * @type {Object.<string, string>}
 */
const CONFIG_COLS = {
  base_url: 'base_url',
  model: 'model',
  enabled: 'enabled',
  ctx_max_turns: 'ctx_max_turns',
  mem_enabled: 'mem_enabled',
  mem_max: 'mem_max',
  // ⭐ 0.7.0（009 报告 R1）：内网地址开关 —— 判定函数在 `lib/openai-client.js`（`isPrivateBaseUrl`）
  allow_private: 'allow_private',
  // ⭐ 3 期：工具授权的四个键 —— 两个布尔、两个「模块清单」（JSON 数组文本）。
  //    ⚠️ 清单的**内容**在这里不做合法性判断（那是 `routes.js` 的入参校验 + `cleanModules` 的清洗），
  //    本映射照旧只管「patch 键 → 列名」。
  tools_enabled: 'tools_enabled',
  tools_read: 'tools_read',
  tools_write: 'tools_write',
  tools_audit: 'tools_audit',
  // ⭐ 0.8.6（行程 1 期 ·）：能不能收图片（NULL = 关）
  vision: 'vision',
};

/**
 * 功能：记忆的 patch 键 → `ai_memories` 列名的**硬映射**（`updateAiMemory` op 的白名单收口）。
 *
 * 说明：⚠️ 与 `CONFIG_COLS` 同一个道理 —— `updateAiMemory` 的 `SET` 是拼出来的，
 *      「哪些键合法」必须在**进入存储层之前**收窄；`id` / `user_id` / `created_at`
 *      刻意不可达（记忆没有「过户」与「改创建时间」的语义）。
 *      ⭐ 2 期只开放 `content`；⭐ **0.7.1 起多一个 `label`**（这一条记忆的**名称**，如「称呼」）——
 *      接口层（`PUT /api/ai/memories/<id>`）也只认这两个键。
 *
 * @type {Object.<string, string>}
 */
const MEMORY_COLS = { content: 'content', label: 'label' };

/**
 * 功能：由配置行推导对外视图 —— **HTTP 读接口唯一的数据形状**。
 *
 * 说明：⭐ 字段口径：
 *      · `keySet` = key 密文三列**齐全**（不是「能解开」—— 解开只发生在出网那一刻）；
 *      · `configured` = base_url + model + key 三者齐备（「可以发请求了」）；
 *      · `enabled` 是用户自己的总开关，与 `configured` 互相独立：
 *        开了但没配好 → 出网路径会明确报「请先到『AI 辅助任务』配置」；配好了但关着 → 一样明确报「已关闭」。
 *      ⭐ 2 期追加三个「上下文 / 记忆」字段，**缺值回落代码里的默认值**（20 / 真 / 20）——
 *      它们是**可空列**（老库补列补出来就是 NULL），所以「默认值只写一处」就落在本函数：
 *      接口层与前端拿到的永远是**实值**，不必各自再判空。
 *
 * @param {?Object} row - `ai_configs` 行（可为 null = 没配过）
 * @returns {{configured: boolean, enabled: boolean, baseUrl: string, model: string, keySet: boolean,
 *            ctxMaxTurns: number, memEnabled: boolean, memMax: number, allowPrivate: boolean,
 *            toolsEnabled: boolean, toolsRead: Array.<string>, toolsWrite: Array.<string>,
 *            toolsAudit: boolean}} 视图
 */
function viewOf(row) {
  const r = row || {};
  const baseUrl = String(r.base_url || '');
  const model = String(r.model || '');
  const keySet = !!(r.key_iv && r.key_cipher && r.key_tag);
  return {
    configured: !!(baseUrl && model && keySet),
    enabled: !!(r && r.enabled),
    baseUrl,
    model,
    keySet,
    ctxMaxTurns: intOr(r.ctx_max_turns, CTX_TURNS_DEFAULT),
    memEnabled: boolOr(r.mem_enabled, MEM_ENABLED_DEFAULT),
    memMax: intOr(r.mem_max, MEM_MAX_DEFAULT),
    // ⭐ 0.7.0（009 报告 R1）：**默认 false = 拦内网地址**。界面上的「允许访问内网地址」开关读它；
    //    真正的拦截在 `aiSaveConfig`（保存时）与 `aiOutboundConfig`（出网前）两处各判一次
    allowPrivate: boolOr(r.allow_private, false),
    // ⭐ 3 期：工具授权四项 —— ⚠️ 这里回的是**存下来的偏好**（界面上要能看见开关
    //    原来的位置），**不是**「现在真的能用哪些」；「真的能用哪些」一律由 `aiAuthorizedTools()`
    //    按总开关收敛后给出（两者刻意分开：总开关关着时下面三个开关的形态仍然看得见，但一个都不生效）。
    toolsEnabled: boolOr(r.tools_enabled, false),
    toolsRead: parseModules(r.tools_read, tools.READ_MODULES),
    toolsWrite: parseModules(r.tools_write, tools.WRITE_MODULES),
    // ⚠️ 四个里**只有审计默认开**（方案 §十二-7）：它是「给用户回看 AI 做过什么」的留痕，
    //    默认关掉等于出事时没有依据；而前三个默认关是「默认不给数据」，方向正好相反。
    toolsAudit: boolOr(r.tools_audit, true),
    // ⭐ 0.8.6（行程 1 期 ·）：能不能收图片 —— ⚠️ **默认关**（`NULL` = 关）。
    //    理由：不是每个模型都收图（本地 ollama 常见的不收），开着会让上游直接 400；
    //    「默认不给能力」与工具授权那三项同一个方向（只有审计默认开，那是留痕不是能力）。
    vision: boolOr(r.vision, false),
  };
}

module.exports = {
  /**
   * 功能：读该账号的 AI 配置视图（**永不含 key 的任何投影**）。
   * @param {number} uid - 用户 id
   * @returns {{configured: boolean, enabled: boolean, baseUrl: string, model: string, keySet: boolean}} 视图
   */
  aiGetConfigView(uid) {
    return viewOf(this._bk.getAiConfig(uid));
  },

  /**
   * 功能：保存 AI 配置 —— **只写请求里真带了的字段**，key 明文在此封装成密文。
   *
   * 说明：⚠️ 逐键语义（与 `PUT /api/auth/prefs` 同一手法）：
   *      · `base_url` / `model`：trim 后非空才写（空串 = 不改动，防「顺手清空」）；
   *      · `enabled`：布尔，写 0 / 1；
   *      · `apiKey`：**非空串才写**（空串 = 不改动）；写 = 用传入的 KEK 现场封装成密文三列整体落库。
   *        ⚠️ 明文只在这一行的三次函数调用里存在，**不进日志、不进返回值、不进任何错误信息**；
   *      ⭐ 2 期追加三个（`ctx_max_turns` / `mem_enabled` / `mem_max`）：**只写带了的**，
   *        区间校验（20~200 / 5~50）在 `routes.js` 的**入参层**完成 —— 越界一律 400，绝不静默截断。
   *      · 一个合法键都没带 → 400（「什么都不改」不是一次合法的保存请求）。
   *      ⚠️ KEK（`kek`）由 routes 层派生后传入（见文件头「为什么作参数」）。
   *
   * @param {number} uid - 用户 id
   * @param {Buffer} kek - 32 字节 KEK（`lib/seal.js` 的 `deriveKek(AUTH_SECRET)` 产物）
   * @param {Object} patch - 已通过校验的增量字段（基础 4 个键由 `checkAiConfig` 校验，2 期的 3 个由接口层校验）
   * @param {string} [patch.base_url] - 接口地址（已校验为 http/https URL）
   * @param {string} [patch.model] - 模型名
   * @param {boolean} [patch.enabled] - 总开关
   * @param {string} [patch.apiKey] - API Key 明文（非空才写）
   * @param {number} [patch.ctx_max_turns] - 带多少条历史（接口层已校验落在 20~200）
   * @param {boolean} [patch.mem_enabled] - 是否把记忆带进上下文
   * @param {number} [patch.mem_max] - 最多带几条记忆（接口层已校验落在 5~50）
   * @param {boolean} [patch.tools_enabled] - ⭐ 3 期：AI 工具总开关
   * @param {Array.<string>} [patch.tools_read] - ⭐ 3 期：已授权的读模块清单（白名单外的会被剔除）
   * @param {Array.<string>} [patch.tools_write] - ⭐ 3 期：已授权的写模块清单（同上）
   * @param {boolean} [patch.tools_audit] - ⭐ 3 期：是否记录审计
   * @returns {{configured: boolean, enabled: boolean, baseUrl: string, model: string, keySet: boolean,
   *            ctxMaxTurns: number, memEnabled: boolean, memMax: number}} 保存后的视图
   * @throws {Error} patch 为空 / KEK 不合法时抛出
   */
  aiSaveConfig(uid, kek, patch) {
    this._assertWritable();
    const p = patch && typeof patch === 'object' ? patch : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(p, k);
    if (
      !has('base_url') &&
      !has('model') &&
      !has('enabled') &&
      !has('apiKey') &&
      !has('ctx_max_turns') &&
      !has('mem_enabled') &&
      !has('mem_max') &&
      !has('allow_private') &&
      // ⭐ 3 期：工具授权四项也是合法键（否则「只想改授权」的保存会被判成空请求）
      !has('tools_enabled') &&
      !has('tools_read') &&
      !has('tools_write') &&
      !has('tools_audit') &&
      // ⭐ 0.8.6：图片开关也是合法键（否则「只想开关图片」的保存会被判成空请求）
      !has('vision')
    ) {
      throw badRequest('没有要保存的内容');
    }

    // ⭐ 0.7.0（009 报告 R1）：**填了内网 / 本机地址就必须先打开开关** —— 这一道是为了**当场**
    //    告诉用户怎么办（真正的兜底在 `aiOutboundConfig`，所有出网路径都得从它取数）。
    //    ⚠️ **只在本次带了 `base_url` 时判**：否则「先填私网地址、再单独把开关关掉」会被自己拦住，
    //    用户就关不掉开关了 —— 那种状态交给出网闸去报错，话术一模一样（同一个 `PRIVATE_HINT`）。
    if (has('base_url')) {
      const cur = this._bk.getAiConfig(uid) || {};
      const nextAllow = has('allow_private') ? !!p.allow_private : !!cur.allow_private;
      if (!nextAllow && client.isPrivateBaseUrl(p.base_url)) throw badRequest(client.PRIVATE_HINT);
    }

    // ⭐ 每账号一行：先保证行存在（首保存 = 建一行空配置），再按 patch 增量更新
    if (!this._bk.getAiConfig(uid)) {
      this._bk.insertAiConfig(uid, {
        base_url: '',
        model: '',
        enabled: 0,
        key_iv: null,
        key_cipher: null,
        key_tag: null,
        stamp: nowStamp(),
      });
    }

    const setKeys = [];
    const values = [];
    if (has('base_url')) {
      const v = String(p.base_url == null ? '' : p.base_url).trim();
      if (v) {
        setKeys.push(CONFIG_COLS.base_url);
        values.push(v);
      }
    }
    if (has('model')) {
      const v = String(p.model == null ? '' : p.model).trim();
      if (v) {
        setKeys.push(CONFIG_COLS.model);
        values.push(v);
      }
    }
    if (has('enabled')) {
      setKeys.push(CONFIG_COLS.enabled);
      values.push(p.enabled ? 1 : 0);
    }
    if (has('apiKey')) {
      const key = String(p.apiKey == null ? '' : p.apiKey);
      if (key) {
        // ⭐ 整体写入三列：seal 一次产生 {iv, cipher, tag}，三列来自**同一次加密**
        const sealed = seal.sealKey(kek, key);
        setKeys.push('key_iv', 'key_cipher', 'key_tag');
        values.push(sealed.iv, sealed.cipher, sealed.tag);
      }
    }
    // ⭐ 2 期：三个「上下文 / 记忆」列 —— 值已由接口层校验过区间，本层只落库。
    //    ⚠️ 布尔列统一写 0 / 1（与 `enabled` 同款；SQLite 没有布尔类型）。
    if (has('ctx_max_turns')) {
      setKeys.push(CONFIG_COLS.ctx_max_turns);
      values.push(Number(p.ctx_max_turns));
    }
    if (has('mem_enabled')) {
      setKeys.push(CONFIG_COLS.mem_enabled);
      values.push(p.mem_enabled ? 1 : 0);
    }
    if (has('mem_max')) {
      setKeys.push(CONFIG_COLS.mem_max);
      values.push(Number(p.mem_max));
    }
    // ⭐ 0.7.0（009 报告 R1）：内网地址开关 —— 布尔列统一写 0 / 1（同 `enabled` / `mem_enabled`）
    if (has('allow_private')) {
      setKeys.push(CONFIG_COLS.allow_private);
      values.push(p.allow_private ? 1 : 0);
    }
    // ⭐ 3 期：工具授权四项 —— 两个布尔写 0 / 1，两个清单**再清洗一遍**后序列化落库。
    //    ⚠️ 清洗是**刻意的第二道**（第一道在 `routes.js` 的入参校验）：存储层不假设调用方一定校验过，
    //    于是「绕过接口直接调 store」也写不进 `vault` / `chat`（硬边界只认白名单）。
    if (has('tools_enabled')) {
      setKeys.push(CONFIG_COLS.tools_enabled);
      values.push(p.tools_enabled ? 1 : 0);
    }
    if (has('tools_read')) {
      setKeys.push(CONFIG_COLS.tools_read);
      values.push(JSON.stringify(cleanModules(p.tools_read, tools.READ_MODULES)));
    }
    if (has('tools_write')) {
      setKeys.push(CONFIG_COLS.tools_write);
      values.push(JSON.stringify(cleanModules(p.tools_write, tools.WRITE_MODULES)));
    }
    if (has('tools_audit')) {
      setKeys.push(CONFIG_COLS.tools_audit);
      values.push(p.tools_audit ? 1 : 0);
    }
    // ⭐ 0.8.6：图片能力开关（与上面那几个布尔列同款 —— 统一写 0 / 1）
    if (has('vision')) {
      setKeys.push(CONFIG_COLS.vision);
      values.push(p.vision ? 1 : 0);
    }
    if (setKeys.length) {
      setKeys.push('updated_at');
      values.push(nowStamp());
      this._bk.updateAiConfig(uid, setKeys, values);
    }
    return this.aiGetConfigView(uid);
  },

  /**
   * 功能：显式清除该账号的 API Key（密文三列置 NULL）—— 「换 key / 停用」的正式路径。
   *
   * 说明：⚠️ 行不存在也返回视图（幂等成功）——「清除一个本来就没有的 key」不该报错。
   *      ⚠️ 清的是**密文**：明文从封装那一刻起就不在库里，无所谓「残留」。
   *
   * @param {number} uid - 用户 id
   * @returns {{configured: boolean, enabled: boolean, baseUrl: string, model: string, keySet: boolean}} 清除后的视图
   */
  aiClearKey(uid) {
    this._assertWritable();
    if (!this._bk.getAiConfig(uid)) {
      this._bk.insertAiConfig(uid, {
        base_url: '',
        model: '',
        enabled: 0,
        key_iv: null,
        key_cipher: null,
        key_tag: null,
        stamp: nowStamp(),
      });
    }
    this._bk.updateAiConfig(uid, ['key_iv', 'key_cipher', 'key_tag', 'updated_at'], [null, null, null, nowStamp()]);
    return this.aiGetConfigView(uid);
  },

  // ---- 3 期：工具授权与审计 ----

  /**
   * 功能：⭐ **本模块唯一那处授权判据** —— 该账号**现在真的**能用哪些数据给 AI 用。
   *
   * 说明：⭐ 服务端执行任何工具之前**必须**问它（`lib/tools.js` 的 `isAuthorized()` 只吃它的产物），
   *      ⛔ 不许别处自己去读 `tools_read` / `tools_write` 那两列拼条件 —— 本项目最贵的病就是
   *      「同一件事两份口径」，而授权判据有两份 = 迟早有一处漏判（方案 §5.2）。
   *      ⚠️ **总开关关着 ⇒ 读 / 写都回空清单**：这是「关了就是零工具」那句承诺的落点，
   *      请求体里因此连工具说明都不会出现（方案 §八-1）。
   *      ⚠️ **解析失败 / 脏数据 ⇒ 空清单**（见 `parseModules`）—— 失败方向永远安全。
   *      ⚠️ 硬边界（`vault` / `chat`）在这一层已被白名单剔除：它们**不可能**出现在返回值里。
   *
   * @param {number} uid - 用户 id
   * @returns {{enabled: boolean, read: Array.<string>, write: Array.<string>, audit: boolean}}
   *      总开关 / 可读模块 / 可写模块 / 是否记审计
   */
  aiAuthorizedTools(uid) {
    const cfg = viewOf(this._bk.getAiConfig(uid));
    return {
      enabled: cfg.toolsEnabled,
      read: cfg.toolsEnabled ? cfg.toolsRead : [],
      write: cfg.toolsEnabled ? cfg.toolsWrite : [],
      audit: cfg.toolsAudit,
    };
  },

  /**
   * 功能：记一条**工具审计**（工具名 / 参数摘要 / 成败 / 失败原因），返回记下的那一条（未记则 null）。
   *
   * 说明：⚠️⭐ **审计只承载「动作」，不承载「内容」**：本函数只认下面这五个字段，
   *      调用方多传的一律丢掉 —— 于是「工具结果 / 记忆正文 / 任务标题 / 任何 key」
   *      **在结构上进不了审计**（不是靠调用方自觉，方案 §4.5-5）。
   *      ⚠️ 参数摘要与失败原因都**截断**（`AUDIT_ARGS_MAX` / `AUDIT_REASON_MAX`）：
   *      留痕是用来回看「AI 动过哪一步」的，不是复刻参数原文。
   *      ⚠️ `tools_audit` 关着 ⇒ 一条都不记（返回 null）—— 开关是用户的，关掉就是关掉。
   *      ⭐⭐ 0.8.5：**落文件 `ai-<uid>.log`**（一行一条 JSON）。
   *      原来它住在 Store 实例的环形数组里、**重启即清** —— 用户想问「AI 上周拿我的数据干了什么」
   *      时，答案永远是「不知道，重启过了」。落文件之后：可查、留得住、管理员也能拿去排查。
   *      ⛔ 字段还是那五个（红线没变）；写失败静默（日志不该把用户的操作带崩）。
   *
   * @param {number} uid - 用户 id
   * @param {{tool?: string, args?: string, ok?: boolean, reason?: string}} rec - 一条审计（多传的键被忽略）
   * @returns {?Object} 记下的那一条；审计开关关着时 null
   */
  aiAppendAudit(uid, rec) {
    if (!viewOf(this._bk.getAiConfig(uid)).toolsAudit) return null;
    const r = rec && typeof rec === 'object' ? rec : {};
    const entry = {
      at: nowStamp(),
      tool: String(r.tool == null ? '' : r.tool).slice(0, 60),
      args: String(r.args == null ? '' : r.args).slice(0, AUDIT_ARGS_MAX),
      ok: !!r.ok,
      reason: String(r.reason == null ? '' : r.reason).slice(0, AUDIT_REASON_MAX),
    };
    // ⭐ 0.8.5：追加到 `ai-<uid>.log`（见上面 JSDoc 与 `core/logs.js` 的文件头）。
    //    ⚠️ 目录判不出来时**不写**（⛔ 不落到进程 cwd 里去）。
    const dir = logs.dirOfStore(this);
    if (dir) logs.appendLine(dir, logs.aiLogName(uid), JSON.stringify(entry));
    return entry;
  },

  /**
   * 功能：读该账号的 AI 使用记录（**最新在前**，最多 `AUDIT_MAX` 条）。
   *
   * 说明：⭐ 0.8.5：读的是 `ai-<uid>.log` 的**尾部** ——
   *      `core/logs.js` 的 `readTail` 只抓末尾 256KB 再切行，因为日志文件的常态是越滚越大，
   *      整个 `readFileSync` 进来会把事件循环卡住（本项目对同步 IO 拖慢首屏有明确教训）。
   *      ⚠️ 只回**自己的**（文件名里就带 uid）；⛔ 行里结构上就没有用户内容与 key。
   *      ⚠️ 一行坏掉（被截断 / 手改过）只跳过那一行，不因为一行脏数据让整份记录读不出来。
   *      ⚠️ 文件还不存在（装好之后 AI 一次都没用过）⇒ 空数组，**不是错误**。
   *
   * @param {number} uid - 用户 id
   * @param {number} [limit] - 最多回几条（缺省 = 上限 `AUDIT_MAX`；超过上限按上限收敛）
   * @returns {Array.<Object>} 记录条目（最新在前）
   */
  aiListAudit(uid, limit) {
    const dir = logs.dirOfStore(this);
    if (!dir) return [];
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, AUDIT_MAX) : AUDIT_MAX;
    const r = logs.readTail(dir, logs.aiLogName(uid), n);
    if (!r || !r.text) return [];
    const out = [];
    for (const line of r.text.split('\n')) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object') out.push(o);
      } catch (_e) {
        /* 坏行跳过（见 JSDoc） */
      }
    }
    // `readTail` 给的是「末尾 n 行，旧 → 新」⇒ 反转成最新在前，与从前的口径一致
    return out.reverse();
  },

  /**
   * 功能：取该账号的**出网配置**（地址 + 模型 + 解开的 key 明文）—— 全部出网路径唯一的取数口。
   *
   * 说明：⭐ 三个前置条件在这里一次判清，缺哪个都抛**用户能照着做**的 400：
   *      · 没填地址 / 模型 → 「请先到『AI 辅助任务』填好接口地址与模型名」；
   *      · 没填 key → 「请先到『AI 辅助任务』填写 API Key」；
   *      · `opts.needEnabled`（chat / extract 要，测连通不要 —— 配好先测通再打开是正常顺序）
   *        且总开关是关的 → 「AI 辅助任务当前是关闭状态…」。
   *      ⚠️ **key 明文只在这里被解出来**（`seal.openKey`），返回值只给**同一个进程内**的
   *      出网客户端用 —— 绝不进任何 HTTP 响应、日志或错误信息（「绝不回显」红线的另一半）。
   *      ⚠️ 解 key 失败（换实例 / 密文被篡改）= 明确报「请重新填写」，绝不静默当没配。
   *
   * @param {number} uid - 用户 id
   * @param {Buffer} kek - 32 字节 KEK
   * @param {{needEnabled?: boolean}} [opts] - 是否要求总开关已打开
   * @returns {{baseUrl: string, model: string, key: string}} 出网配置
   * @throws {Error} 前置条件不满足时抛 400
   */
  aiOutboundConfig(uid, kek, opts) {
    const row = this._bk.getAiConfig(uid);
    if (!row || !String(row.base_url || '').trim() || !String(row.model || '').trim()) {
      throw badRequest(`请先到${client.CFG_AT}填好接口地址与模型名`);
    }
    // ⭐ 0.7.0（009 报告 R1）：**内网 / 本机地址默认拦**。
    //    判定放这里等于把 test / chat / extract 三条出网路径一次全覆盖 —— 本方法是它们**唯一**的取数口。
    //    保存那一刻也拦一道（见 `aiSaveConfig`），那是为了**当场**告诉用户怎么办，不是为了安全。
    //    ⚠️ 开关是**每账号**的（只放开自己账号填的目标地址），不是「给成员放权」的入口。
    if (!row.allow_private && client.isPrivateBaseUrl(row.base_url)) {
      throw badRequest(client.PRIVATE_HINT);
    }
    if (opts && opts.needEnabled && !row.enabled) {
      throw badRequest(`AI 辅助任务当前是关闭状态，请先到${client.CFG_AT}打开`);
    }
    const keySet = !!(row.key_iv && row.key_cipher && row.key_tag);
    if (!keySet) throw badRequest(`请先到${client.CFG_AT}填写 API Key`);
    let key;
    try {
      key = seal.openKey(kek, { iv: row.key_iv, cipher: row.key_cipher, tag: row.key_tag });
    } catch (_e) {
      throw badRequest(`密钥材料已失效（可能更换过实例），请到${client.CFG_AT}重新填写 API Key`);
    }
    return { baseUrl: String(row.base_url).trim(), model: String(row.model).trim(), key };
  },

  /**
   * 功能：测连通 —— 用已存的配置发一次 `GET {base}/models`（省额度），返回 `{ok, ms}` 或 `{ok:false, reason}`。
   *
   * 说明：⚠️ **结果对象是 200 响应**：连通失败不是请求格式错，把原因放在 `reason` 里
   *      比抛 500 更诚实。`reason` 已是转译过的用户话术（client 的错误转译表）。
   *
   * @param {number} uid - 用户 id
   * @param {Buffer} kek - 32 字节 KEK
   * @param {{connectMs?: number, totalMs?: number}} [copts] - 可选：测试用的小超时（默认值在 client）
   * @returns {Promise.<{ok: boolean, ms?: number, reason?: string}>} 测试结果
   */
  async aiTestConnection(uid, kek, copts) {
    const t0 = Date.now();
    try {
      const out = this.aiOutboundConfig(uid, kek);
      await client.listModels({ baseUrl: out.baseUrl, apiKey: out.key }, copts);
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || '测试失败' };
    }
  },

  /**
   * 功能：读该账号的 AI 会话行（**不创建**）—— 历史查询等只读路径用（会话没建过返回 null）。
   * @param {number} uid - 用户 id
   * @returns {?Object} `ai_chats` 行；没有为 null
   */
  aiGetChat(uid) {
    // ⭐ 0.8.12：会话落库已并进对话模块 —— **只读**走协作的公开业务方法
    //    （⛔ AI 不直接读写对话的表）。没聊过 = null（只读路径不建会话）。
    const c = this.teamworkAiConversation(uid);
    return c ? { id: Number(c.id), title: c.title } : null;
  },

  /**
   * 功能：取（或首用即建）该账号的默认 AI 会话 —— 一期每账号一条。
   * @param {number} uid - 用户 id
   * @returns {{id: number, title: string}} 会话行
   */
  aiEnsureChat(uid) {
    this._assertWritable();
    // ⭐ 0.8.12：内置 AI 会话住对话模块（`builtin_key = 'ai'`）—— 建会话前先由协作跑一次
    //    存量搬迁（幂等），所以升级后第一次打开就能接着用老会话（见 `teamworkEnsureAiConversation`）。
    const c = this.teamworkEnsureAiConversation(uid);
    return { id: Number(c.id), title: c.title };
  },

  /**
   * 功能：往**自己的**会话追加一条消息（chatId 必须是自己会话的 id —— 判权先于落库）。
   *
   * 说明：⭐ 2 期：落库时带上**当前段号** —— 段号只在「开启新对话」（`aiNewSegment`）
   *      时才 +1，所以这里读到的就是这条消息该落的段。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {string} role - 'user' | 'assistant'（错误帧不落库，见 schema.js）
   * @param {string} content - 消息内容
   * @param {{kind?: ?string, meta?: ?string}} [opts] - ⭐ 0.7.7-⑲：`kind` 消息种类（`'task_proposal'`
   *      = 确认卡）、`meta` 卡片快照 JSON 文本。⚠️ 普通消息（含回归前的老调用）一个都不传 ⇒ 两列都是 NULL。
   * @returns {{id: number}} 新消息 id
   * @throws {Error} 会话 id 不是自己的时抛 400
   */
  aiAppendMessage(uid, chatId, role, content, opts) {
    this._assertWritable();
    // ⭐ 0.8.12：落库走协作的公开业务方法—— 形状不变：`role` 翻成
    //    `sender_builtin`（`assistant` -> `'ai'`、`user` -> NULL），其余原样。
    const chat = this.teamworkAiConversation(uid);
    if (!chat || Number(chat.id) !== Number(chatId)) throw badRequest('AI 会话不存在');
    if (role !== 'user' && role !== 'assistant') throw badRequest('AI 消息角色不合法');
    const o = opts || {};
    const r = this.teamworkAiAppendMessage(uid, role === 'assistant' ? 'ai' : null, String(content == null ? '' : content), {
      kind: o.kind == null ? null : String(o.kind),
      meta: o.meta == null ? null : String(o.meta),
      // ⭐ 0.8.6（行程 1 期 ·）：这条消息带的图片（整串 data URL；null = 没有图）。
      //    ⚠️⭐ 落库时机由调用方把关：**只在上游接受了这次请求之后**才调本函数 ⇒
      //    「没被接受的图不进历史」（与用户消息的既有落库时机逐字一致）。
      image: o.image == null ? null : String(o.image),
    });
    return { id: r.id };
  },

  /**
   * 功能：读**一条消息的图片**（显示路由 `GET /api/ai/messages/<id>/image` 专用）。
   *
   * 说明：⭐⭐ 归属校验与「不存在 / 这条没有图」在**同一个出口**上收口（
   *      越权与不存在一律 404 同体 —— 403 是探测通道）⇒ 本函数统一回 `null`，由路由一律 404。
   *      ⚠️ 它**不返回** mime / 大小之类：那些由 `parseImageDataUrl()`（core）从串里现解析，
   *      「什么算合法图片」只有那一份判据。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 消息 id
   * @returns {?string} 整串 data URL；不是自己的 / 不存在 / 没有图 ⇒ null
   */
  aiMessageImage(uid, id) {
    // ⭐ 0.8.12：图片列随消息一起进了对话模块 —— 经协作的公开业务方法读。
    const s = this.teamworkAiMessageImage(uid, Number(id));
    return s ? String(s) : null;
  },

  /**
   * 功能：翻页读自己的 AI 会话历史（旧→新排序；`hasMore` 由「游标之前还有没有」判出）。
   *
   * 说明：⚠️ `limit` 先取 `limit + 1` 条再裁掉一条 —— `hasMore` 用**多取的那一条**判断，
   *      不做第二次计数查询；会话还没建过（一条消息都没有）返回空页。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {?number} before - 游标（取 id 小于它的）；null = 从最新开始
   * @param {number} limit - 页大小（1~200，路由层已校验）
   * @param {?number} [segment] - ⭐ 2 期：只取这一段；**缺省 = 不带段过滤（返回全部）**
   * @returns {{items: Array.<{id: number, role: string, content: string, segment: number, created_at: string}>, hasMore: boolean}} 一页
   * @throws {Error} 会话 id 不是自己的时抛 400
   */
  aiListMessages(uid, chatId, before, limit, segment) {
    const chat = this.teamworkAiConversation(uid);
    if (!chat || Number(chat.id) !== Number(chatId)) throw badRequest('AI 会话不存在');
    // ⭐ 0.8.12：消息从对话模块取（形状与旧存储一致）—— 多取一条判 `hasMore`，再反转成旧→新。
    const rows = this.teamworkAiMessages(uid, before || null, limit + 1, segment || null);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    items.reverse(); // 取回来是 id 降序 —— 给前端前翻回旧→新
    return { items: items.map(decorateMessage), hasMore };
  },

  /**
   * 功能：⭐ 0.7.7-⑲：把 AI 提议的条目**落成一张确认卡**（会话流里的一条消息）。
   *
   * 说明：⭐ 为什么必须落库：卡上有两颗按钮（拒绝 / 同意），不落库的话刷新一下卡就没了、
   *      按钮也没了（用户会以为「AI 从没提议过」）。它是 `role='assistant'` 的一条消息，
   *      靠 `kind='task_proposal'` 与普通消息区分（⛔ 不改 `role` 的 CHECK —— 那要重建表）。
   *      ⚠️ `content` 是**降级文本**：渲染端不认这个 `kind` 时按它显示（与 chat 的 kind 同一规矩）。
   *      ⚠️ 一条提议 = 一张卡（AI 一次给几条都列在同一张里）。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {Array.<Object>} items - 提议条目（已归一）
   * @returns {{id: number, kind: string, meta: Object}} 新卡片消息（`meta` 是解析后的快照）
   */
  aiAppendProposal(uid, chatId, items) {
    // ⭐ 0.8.4：卡的种类由**条目自带**的 `kind` 决定 —— `routes.js` 从写工具的产物上带过来
    //    （`'tasks'` / `'ledger'`）。⛔ 不在这儿另判一次「是谁调用的」（那就成了第二份判据）。
    const first = Array.isArray(items) && items[0] && typeof items[0] === 'object' ? items[0] : null;
    // ⭐ 0.8.5：产物上带的 `kind` 是**模块名**（`tasks` / `ledger` / `bookmarks` / `idea` / `hardware`），
    //    经 `KIND_BY_MODULE` 翻成消息种类。⛔ 不在这儿另判一次「是谁调用的」（那就成了第二份判据）。
    const kind = KIND_BY_MODULE[String((first && first.kind) || '')] || KIND_TASK_PROPOSAL;
    const snap = snapshotProposalItems(items, kind);
    // ⚠️ `content` 是**降级文本**（渲染端不认这个 kind 时按它显示）：五种卡的说法各一套
    const SUMMARY_OF = {
      [KIND_TASK_PROPOSAL]: { unit: '个任务', line: (x) => String(x.title || '') },
      [KIND_LEDGER_PROPOSAL]: {
        unit: '笔记账',
        line: (x) => (x.amount ? `${x.amount} 元${x.category_name ? ' ' + x.category_name : ''}` : ''),
      },
      [KIND_BOOKMARKS_PROPOSAL]: { unit: '条收藏', line: (x) => String(x.title || x.url || '') },
      [KIND_IDEA_PROPOSAL]: {
        unit: '条随手记',
        line: (x) =>
          String(x.content || '')
            .replace(/\s+/g, ' ')
            .slice(0, 20),
      },
      [KIND_HARDWARE_PROPOSAL]: { unit: '件硬件', line: (x) => String(x.name || '') },
      // ⭐ 0.8.6：车票 —— 降级文本写「G1234 北京南 → 上海虹桥」（没车次时只写站名）
      [KIND_TRIP_PROPOSAL]: {
        unit: '张车票',
        line: (x) => [String(x.code || ''), `${String(x.from || '')} → ${String(x.to || '')}`].filter(Boolean).join(' '),
      },
      // ⭐⭐ 0.8.55：资产（名称 + 金额）与日程（标题 + 日期）—— 降级文本要能看懂是哪一条
      [KIND_ASSETS_PROPOSAL]: {
        unit: '条资产',
        line: (x) => {
          const name = String(x.name || '');
          const fen = Number(x.amount_fen);
          if (!name) return '';
          return x.amount_fen != null && Number.isFinite(fen) ? `${name}（${fen / 100} 元）` : name;
        },
      },
      [KIND_CALENDAR_PROPOSAL]: {
        unit: '条日程',
        line: (x) => [String(x.date || ''), String(x.title || '')].filter(Boolean).join(' '),
      },
    };
    const sum = SUMMARY_OF[kind] || SUMMARY_OF[KIND_TASK_PROPOSAL];
    const names = snap
      .map(sum.line)
      .filter(Boolean)
      .join('、');
    const body = `（已整理出 ${snap.length} ${sum.unit}待你确认${names ? '：' + names : ''}）`;
    const metaText = packProposalMeta(snap, 'pending', kind);
    const r = this.aiAppendMessage(uid, chatId, 'assistant', body, { kind, meta: metaText });
    return { id: r.id, kind, meta: unpackProposalMeta(metaText) };
  },

  /**
   * 功能：⭐ 0.7.7-⑲：用户**同意 / 拒绝**一张确认卡 —— 写回卡片状态，并按结果追加一条助手消息。
   *
   * 说明：⭐⭐ 两条分工（已定）——
   *      · **拒绝**：**不额外调用模型**（本地即时）。只把状态改成 `rejected` + 追加那句
   *        「有哪里不对，我继续修改」。⚠️ 但「上次提议被拒」会作为**下一轮的事实**注入
   *        ——`aiContextWindow()` 把这个 `task_proposal` 行降级成一句话，用户接着说哪里不对时
   *        模型就知道刚才那次被拒了（那一句是「继续修改」真能发生的关键）。
   *      · **同意**：条目其实**已经由前端逐条建好了**（走 `core/task-create.js` 这个唯一入口，
   *        ）。这里只负责改状态 + 记一句结果 —— ⛔ 服务端**不自己建任务**
   *        （那会成为第二条创建路径）。
   *      ⚠️ 幂等：已经处理过的卡再点一次 ⇒ 返回现状、**不重复追加消息**
   *      是用「返回值里如实带 `changed: false`」满足的，不是靠再写一条重复的助手消息。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 卡片消息 id
   * @param {string} action - `'agree'` | `'reject'`
   * @param {{added?: number, failed?: number}} [opts] - 同意时前端报上来的成功 / 失败条数
   * @returns {?{ok: boolean, changed: boolean, card: Object, reply: ?Object}} 结果；不是自己的 / 不是卡片 ⇒ null
   */
  aiResolveProposal(uid, id, action, opts) {
    this._assertWritable();
    // ⭐ 0.8.12：读一条 / 写 meta 都改走协作的公开业务方法。
    const row = this.teamworkAiGetMessage(uid, Number(id));
    // ⭐ 0.8.4：两种提议卡都认（判据只此一处：`isProposalKind()`）—— 别的消息一律当「不是卡片」回 null
    if (!row || !isProposalKind(row.kind)) return null;
    const kind = String(row.kind);
    // ⭐ 0.8.5：五种卡各一套回话模板（`KIND_REPLY`）—— 认不出来的 kind 按任务卡算
    const ui = KIND_REPLY[kind] || KIND_REPLY[KIND_TASK_PROPOSAL];
    const meta = unpackProposalMeta(row.meta) || { items: [], state: 'pending' };
    const card = { id: Number(row.id), kind, meta, createdAt: row.created_at };
    if (meta.state !== 'pending') return { ok: true, changed: false, card, reply: null };
    const o = opts || {};
    let next;
    let replyText;
    if (action === 'agree') {
      const added = Math.max(0, Number(o.added) || 0);
      const failed = Math.max(0, Number(o.failed) || 0);
      next = Object.assign({}, meta, { state: 'agreed', added, failed });
      replyText = replyOf(ui, added, failed);
    } else {
      next = Object.assign({}, meta, { state: 'rejected' });
      replyText = PROPOSAL_REJECT_REPLY;
    }
    const metaText = JSON.stringify(next);
    this.teamworkAiSetMessageMeta(uid, Number(row.id), metaText);
    const chat = this.teamworkAiConversation(uid);
    const chatId = chat ? Number(chat.id) : 0;
    const saved = chatId ? this.aiAppendMessage(uid, chatId, 'assistant', replyText) : null;
    const reply = saved
      ? { id: Number(saved.id), body: replyText, createdAt: nowStamp() }
      : null;
    return { ok: true, changed: true, card: { id: Number(row.id), kind, meta: next }, reply };
  },

  /**
   * 功能：取**自己的**一条对话消息（`teamwork_messages`）—— 指挥 AI 建任务的原料（越权 = 与不存在同体）。
   * @param {number} uid - 用户 id
   * @param {number} id - 对话消息 id
   * @returns {?Object} `{ id, body, created_at }`；取不到为 null
   */
  aiGetOwnChatMessage(uid, id) {
    return this._bk.getChatMessageForAi(uid, Number(id));
  },

  // ---- 2 期：对话分段 ----

  /**
   * 功能：**开启新对话** —— 返回新段号（同一条会话里开新的一段，**不是**多会话列表）。
   *
   * 说明：⭐ **幂等**：当前段**一条消息都没有**时返回当前段号、
   *      不 +1 —— 否则连点两下就造出一堆空段，段号从此不好读。
   *      ⚠️⭐ **段号必须落盘**（`ai_chats.cur_segment`）：用户按完这个按钮、还没发第一条消息时，
   *      新段一条消息都没有 —— 只靠「消息里最大的 segment」推不出它，表现就是
   *      「开了新对话，AI 却还记得上一段」。这一处是方案 §四/§五 没写到、实施时才发现的。
   *      ⚠️ **不删任何消息**：老段的历史一条不动，只是不再进上下文（界面上仍能看到）。
   *      ⚠️ 段号从 1 起；历史行 `segment` 为 NULL 视为第 1 段（老库零迁移）。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id（会话还没建过时传 0：等同于「还没有消息」）
   * @returns {{segment: number}} 新段号
   */
  aiNewSegment(uid, _chatId) {
    this._assertWritable();
    // ⭐ 0.8.12：段号住会话行（协作的 `teamwork_conversations.cur_segment`），逻辑在协作那侧
    //    。⚠️ 保留第二个形参只为兼容旧调用方 —— 协作按账号唯一定位那条内置会话。
    return this.teamworkAiNewSegment(uid);
  },

  /**
   * 功能：取**当前段**的上下文窗口 —— 按「条数 + 字符」双上限从新往旧裁，返回时间正序的消息。
   *
   * 说明：⭐ 算法逐条：
   *      ① `seg` = 当前段（NULL 视为 1）；
   *      ② 该段消息**按 id 降序**（最新在前）取最多 `maxTurns + 1` 条；
   *      ③ 从最新往回累加，**每条都先判两次**：已选条数 + 1 超上限 ⇒ 停；已选字符 + 本条 > `AI_CTX_MAX_CHARS` ⇒ 停；
   *      ④ 选中的**反转成时间正序**返回；`truncated` = 选中的条数 < 该段总条数。
   *      ⚠️ 返回的 `chars` 是**选中消息的字符数合计**（不是估算、不是配置值）—— SSE 的用量帧直接用它与
   *      `msgs.length`，界面上那句「本次带了 N 条历史」才是实话。
   *
   * ⭐ 0.7.7-⑲：**确认卡在注入前必须降级** —— `kind='task_proposal'` 的那些行不喂 `content`
   *      （那只是降级文本），也⛔ **绝不喂 `meta` 的 JSON**，而是换成**一句话**
   *      （「（你上一次提议了 1 个任务：『X』，用户已拒绝）」）。
   *      理由：把那段 JSON 原样喂回去，模型会学着自己吐这种结构，与协议 V1
   *      「只输出一个纯 JSON」的约定打架；而降级成一句话，
   *      「上次被拒」就变成了**下一轮的事实**（用户说哪里不对时模型知道要改）。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {{ctxMaxTurns?: number}} [cfg] - 配置（取 `aiGetConfigView()` 的 `ctxMaxTurns`；缺省回落默认值）
   * @returns {{segment: number, msgs: Array.<Object>, chars: number, truncated: boolean}} 窗口
   */
  aiContextWindow(uid, _chatId, cfg) {
    const maxTurns = Number(cfg && cfg.ctxMaxTurns) || CTX_TURNS_DEFAULT;
    // ⭐ 0.8.12：上下文原料从对话模块取—— 取数只做「按当前段、id 降序、限条数」，
    //    下面的双上限裁剪与确认卡降级仍是 ai 自己的业务规则。`_chatId` 形参保留只为兼容旧调用方。
    const ctx = this.teamworkAiContext(uid, maxTurns + 1);
    const segment = ctx.segment;
    const rows = ctx.rows; // id 降序
    const picked = [];
    let chars = 0;
    for (const r of rows) {
      if (picked.length + 1 > maxTurns) break;
      // ⭐ 0.7.7-⑲：确认卡降级成一句话（字符数也按降级后的**实际发出去的那句话**算，
      //    否则 `used.chars` 与请求体对不上，界面上那句「本次带了 N 条历史」会变成假话）
      // ⭐ 0.8.55：喂给模型的正文同样要过一遍清洗 —— 否则它会在上下文里看到自己上次吐的
      //    原生调用标记，下一轮学得更像（这正是 那几条连续复发的助推剂）。
      const body = isProposalKind(r.kind)
        ? proposalLine(unpackProposalMeta(r.meta))
        : cleanHistoryText(r.role, r.content);
      const len = body.length;
      if (chars + len > AI_CTX_MAX_CHARS) break;
      // ⚠️ 保留原行字段（`id` / `segment` …）只换 `content` —— 返回值形状与 2 期**一字不差**，
      //    调用方（`routes.js`）仍旧只取 `role` 与 `content` 拼请求。
      picked.push(Object.assign({}, r, { content: body }));
      chars += len;
    }
    picked.reverse(); // 时间正序
    const total = ctx.total;
    return { segment, msgs: picked, chars, truncated: picked.length < total };
  },

  // ---- 2 期：长期记忆 ----

  /**
   * 功能：读该账号的全部记忆（`sort_no ASC, id ASC` —— 原样透传 ops）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 记忆行（`{id, label, content, source, sort_no, created_at, updated_at}`；
   *          `label` 为 `?string` —— **null = 这一条没有名称**，与 SQLite 的 NULL / JSON 的归一值同形状
   *          ⚠️ 0.7.6 之前这里漏写了 `label`，而 SQLite 的 SELECT 也真的漏了一列 —— 两处一起漏，
   *          单测又没覆盖 ⇒ 记忆名称功能一直没生效。写返回类型时请与后端 SELECT 逐字对齐。）
   */
  aiListMemories(uid) {
    return this._bk.listAiMemories(uid);
  },

  /**
   * 功能：新增一条记忆，返回新 id。
   *
   * 说明：⚠️ `content` 的**空 / 超长（2000 字）由路由层校验**（400 且不静默截断）——
   *      本层只做「非空值原样落库」，不猜用户想说什么。
   *      ⚠️ `source` 恒为 `'manual'`（2 期不做 AI 自动记忆）。
   *
   * @param {number} uid - 用户 id
   * @param {string} content - 记忆正文
   * @param {number} [sortNo] - 排序位（缺省 0；列表与注入都按它排）
   * @param {string} [label] - ⭐ 0.7.1：这一条的名称（如「称呼」）；空 / 缺省 = 无名称
   * @returns {{id: number}} 新记忆 id
   */
  aiAddMemory(uid, content, sortNo, label) {
    this._assertWritable();
    const n = Number.isInteger(sortNo) ? sortNo : 0;
    const id = this._bk.insertAiMemory(
      uid,
      String(content == null ? '' : content),
      'manual',
      n,
      // ⚠️ 空名称一律落 **NULL**（不是空串）：NULL 才是「没有名称」的唯一形状，
      //    否则界面要同时认 '' 与 null 两种「没写名称」，迟早漏一处（不留两套口径）
      String(label == null ? '' : label).trim() || null,
      nowStamp(),
    );
    return { id };
  },

  /**
   * 功能：改**自己的**一条记忆 —— 影响 0 行返回 `false`（路由层据此转 **404**）。
   *
   * 说明：⚠️ 列名由 `MEMORY_COLS` **硬映射**收口（2 期只开放 `content`）；一个合法键都没带 → 400。
   *      ⚠️ 越权（别人的 id）与「不存在」在存储层是同一个结果（影响 0 行）—— 这正是
   *      「越权与不存在统一 404」能成立的原因：存储层根本不区分这两件事。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 记忆 id
   * @param {Object} fields - patch 键 → 新值（只会用到 `MEMORY_COLS` 里的键）
   * @returns {boolean} 改到为 true
   * @throws {Error} 一个合法键都没带时抛 400
   */
  aiUpdateMemory(uid, id, fields) {
    this._assertWritable();
    const cols = {};
    for (const k of Object.keys(fields || {})) {
      if (MEMORY_COLS[k]) cols[MEMORY_COLS[k]] = fields[k];
    }
    if (!Object.keys(cols).length) throw badRequest('没有要保存的内容');
    return this._bk.updateAiMemory(uid, Number(id), cols, nowStamp()) > 0;
  },

  /**
   * 功能：这一条记忆是不是**预设三条**之一（按 id 查，给接口层判「能不能把它清空」用）。
   * @param {number} uid - 用户 id
   * @param {number} id - 记忆 id
   * @returns {boolean} 是预设为 true（不存在 / 别人的一律 false）
   */
  aiMemoryIsPreset(uid, id) {
    const row = this._bk.listAiMemories(uid).find((r) => Number(r.id) === Number(id));
    return !!row && isPresetMemory(row.label);
  },

  /**
   * 功能：删**自己的**一条记忆 —— 影响 0 行返回 `false`（路由层转 404）。
   *
   * 说明：⭐ 0.7.7-⑱：**预设三条删不掉** —— 命中就抛 400 说人话（不许静默成功）。
   *      ⚠️ 这一层是**护栏**（界面那边根本不画 ✕，是体验层）；两层都要有，照本项目一贯口径。
   *      ⚠️ 判据按**名称**（见 `MEM_PRESET_LABELS` 的理由）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 记忆 id
   * @returns {boolean} 删到为 true
   * @throws {Error} 命中预设三条时抛 400
   */
  aiDeleteMemory(uid, id) {
    this._assertWritable();
    if (this.aiMemoryIsPreset(uid, id)) throw badRequest('这三条是预设，不能删，只能改内容');
    return this._bk.deleteAiMemory(uid, Number(id)) > 0;
  },

  /**
   * 功能：清空该账号的记忆，返回**删掉的条数**（0 条也算成功 —— 幂等）。
   *
   * 说明：⭐ 0.7.7-⑱：预设三条**不删** —— 它们的内容被清空、行保留（清完再打开还是三行空框）。
   *      ⇒ 返回的 `removed` 是**「自己加的行里被删掉的那几条」**，不含预设
   *      （预设那几行还在，只是内容空了 —— 把它们算进「删掉了 N 条」是一句假话）。
   *
   * @param {number} uid - 用户 id
   * @returns {number} 删掉的行数（⛔ 不含被清空内容的预设行）
   */
  aiClearMemories(uid) {
    this._assertWritable();
    let removed = 0;
    for (const r of this._bk.listAiMemories(uid)) {
      if (isPresetMemory(r.label)) {
        // 预设：内容清空、行保留。⚠️ 已经空着的就别白写一次（幂等 + 少一次落盘）
        if (String(r.content == null ? '' : r.content) !== '') {
          this._bk.updateAiMemory(uid, Number(r.id), { content: '' }, nowStamp());
        }
        continue;
      }
      this._bk.deleteAiMemory(uid, Number(r.id));
      removed += 1;
    }
    return removed;
  },

  /**
   * 功能：取**本次要注入提示词**的全部记忆正文（⭐ 0.7.6 起**全量** —— 不再按上限截断）
   *      —— `[]` = 一条都不带。
   *
   * 说明：⭐ 「一条都不带」只剩一个入口：记忆总开关关着（`mem_enabled = 0`）。
   *      **调用方据此把 `used.mems` 报成 0** —— 界面上那句「本次带了 N 条记忆」于是永远与
   *      实际发出去的内容一致（不许静默）。
   *      ⚠️⭐ **不再收 `max` 参数**：那个「每次最多带几条」的配置已从界面撤掉（方案 §7.2 的
   *      「出网面变大必须可见」）—— 记忆写了几条就带几条。⛔ `ai_configs.mem_max` 列与
   *      `PUT /api/ai/config` 的 `mem_max` 键**保留**（向后兼容 + 老备份恢复路径要认它），
   *      但它**不再影响注入条数**。
   *      ⚠️ 空白内容不进提示词（用户手滑存了个空格，不该变成一行空的「· 」）。
   *      ⚠️ **返回值只给同一个进程内的出网请求用** —— 记忆内容绝不进日志。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<string>} 记忆正文列表（可能是空数组）
   */
  aiReadMemoriesForPrompt(uid) {
    const cfg = viewOf(this._bk.getAiConfig(uid));
    if (!cfg.memEnabled) return [];
    return this._bk
      .listAiMemories(uid)
      // ⭐ 0.7.1：有名称的按「**名称**：正文」拼（与用户在界面上看到的是同一个样子）；
      //    没名称的仍旧只给正文 —— 老数据（`label` 是 NULL）的注入内容**一个字都不变**。
      .map((r) => {
        const body = String(r.content == null ? '' : r.content);
        const label = String(r.label == null ? '' : r.label).trim();
        return label ? `${label}：${body}` : body;
      })
      .filter((s) => s.trim() !== '');
  },
};
