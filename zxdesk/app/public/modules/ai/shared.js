/**
 * modules/ai/shared.js —— ai辅助任务**两端共用**的界面引擎（0.6.0）
 *
 * 功能：本模块插槽片段（desktop/mobile × teamwork-page / teamwork-thread）与 **AI 卡片屏**共用的那一部分 ——
 *      · `bindTeamworkConvEntries()` 会话列表登记（`zx:teamwork-conv-entries` 留白事件：AI 是一条**会话对象**）；
 *      · `createAiThreadView()`   插槽会话屏的聊天视图（消息区 + 输入行 + 用量小字，SSE 读流 + 停止 + 历史）；
 *      · `createAiPanel()`        AI 卡片屏的四块（**连接 → 上下文 → 记忆 → 能力**，顺序固定），由
 *        `createAiConnBlock()` / `createAiCtxBlock()` / `createAiMemBlock()` / `createAiToolsBlock()`
 *        拼成（⭐ 第四块「能力」是 3 期：工具授权）——
 *        ⭐ 2 期起配置入口从「设置页的一栏」搬到左侧「AI 辅助任务」卡片：原来那两个
 *        `*-settings-pane.js` 薄壳一起删掉，全项目只有这一份；
 *      · `bindTeamworkMsgMenuHook()` 往对话模块的消息菜单里添「问 AI / 记成任务」（走 `zx:teamwork-msg-menu`
 *        留白事件，—— chat 不认识本模块）；
 *      · 预览层 / 确认卡的 HTML 与绑定（`extractPreviewHtml()` / `confirmCardHtml()` / `bindConfirmCard()`）。
 *
 * ⭐ **为什么收在一个文件**：SSE 帧的消费顺序、发送内容的边界、任务草稿 → 既有任务接口的字段映射，
 *    这些是「两端必须一模一样」的语义（`core/` 判定标准的模块内版本）—— 写两份迟早走偏
 *    （对话模块的教训：连接管理必须一份）。端的差异只留两处：**toast / 弹层容器**由片段注入，
 *    **CSS** 按 两端各写一份（类名是共用的约定）。
 *
 * ⭐ **XSS 口径**：AI 回复是**外部内容**，消息文本一律 `textContent`；
 *    模板串里只允许出现 `esc()` 过的内容与受控的枚举值。
 *
 * ⚠️ **写库只走既有任务接口**：确认卡落库调 `POST /api/daily` /
 *    `POST /api/projects/:id/tasks`，带 `from_message_id`；本模块没有第二个写任务表的路径。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.9.5
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、
 *      docs/公共/开发方案/14-AI辅助任务-2期.md、core/slots.js
 */

import { api, BASE } from '../../core/api.js';
// ⭐ 0.7.1：新建任务统一走共用层那个入口（不许跨模块 import 实现，所以它在 `core/`）
import { createTask } from '../../core/task-create.js';
// ⭐ 0.8.4：记一笔账同理 —— 记账确认卡点「同意」时逐条落库，走共用层那个唯一入口
import { createBookmark } from '../../core/bookmark-create.js';
import { createHardware } from '../../core/hardware-create.js';
import { createIdea } from '../../core/idea-create.js';
import { createLedgerEntry } from '../../core/ledger-create.js';
import { createTicket } from '../../core/trip-create.js';
// ⭐⭐ 0.8.55：资产与日程的确认卡走各自那一条唯一入口
import { createAssetItem } from '../../core/asset-create.js';
import { createCalendarEvent } from '../../core/calendar-create.js';
import { el, esc } from '../../core/dom.js';
import { todayStr } from '../../core/date.js';

/** 输入长度上限的**前端一份**（与服务端 `MAX_AI_TEXT` 同值 —— 改一处必须改另一处） @type {number} */
const MAX_AI_TEXT = 4000;

/** 发图的大小上限（与服务端 `IMAGE_MAX_BYTES` 同值 —— 8 MB；前端先拦一道，省一次注定 413 的上传） @type {number} */
const IMG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 功能：把时间戳压成聊天界面习惯的短标签（今天的只写 `HH:MM`，更早的写 `M/D HH:MM`）。
 *
 * 说明：⚠️ 与 `modules/teamwork/desktop.js` 的 `fmtTeamworkTime()` **同一套口径**（两边各自一份，
 *      因为 不许跨模块 import 实现）—— 聊天区要与好友聊天一模一样，这一行的时间格式
 *      就必须一致：日期串按**字符串切片**解析，⛔ 不 `new Date()`（时区坑会把 UTC 的某条消息
 *      显示成昨天，这是本项目的老规矩）。
 * @param {?string} s - 时间戳（`YYYY-MM-DD HH:MM:SS`）；空 = 「现在」
 * @returns {string} 短标签
 */
function fmtChatTime(s) {
  const t = String(s == null || s === '' ? '' : s);
  if (!t) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return t;
  const hm = `${m[4]}:${m[5]}`;
  return `${m[1]}-${m[2]}-${m[3]}` === todayStr() ? hm : `${Number(m[2])}/${Number(m[3])} ${hm}`;
}

/**
 * 功能：一张**任务卡片**的 HTML —— ⭐ 0.8.55：把任务发给 AI 时用。
 *
 * 说明：⚠️ 结构与类名与 `modules/teamwork/shared.js` 的 `taskCardHtml()` **逐字对齐**
 *      （`.teamwork-card` / `-head` / `-title` / `-chips` / `-note`）——
 *      两边看到的是同一种卡片，那也是「AI 聊天与好友聊天一模一样」的一部分。
 *      ⚠️ 两份是**刻意的**： 不许 AI import 协作的实现，而卡片只有这五六个类名，
 *      抽到 `core/` 反而要为它开一个新共用文件（两边谁都不愿先欠那一笔）。
 *      ⛔ 不画卡片底部那排动作按钮（那是「收进我的任务板」，发给 AI 的是**我已有的**任务）。
 * @param {Object} raw - 卡片快照
 * @returns {string} HTML
 */
function chatCardHtml(raw) {
  const src = String((raw && raw.src) || '').trim();
  const proj = String((raw && raw.project) || '').trim();
  const from = String((raw && raw.from) || '').trim();
  const title = String((raw && raw.title) || '').trim() || '未命名任务';
  const note = String((raw && raw.note) || '').trim();
  const head =
    src === 'collab'
      ? `📋 分享了${proj ? `「${esc(proj)}」里的` : ''}任务`
      : `📋 ${from ? `${esc(from)} 分享了一个任务` : '分享了一个任务'}`;
  const chips = [];
  if (raw && raw.due) chips.push(`<span class="teamwork-card-chip">📅 截止 ${esc(String(raw.due))}</span>`);
  if (raw && Number(raw.important)) chips.push(`<span class="teamwork-card-chip imp">🔴 重要</span>`);
  if (raw && Number(raw.urgent)) chips.push(`<span class="teamwork-card-chip urg">⏰ 紧急</span>`);
  return (
    `<div class="teamwork-card">` +
    `<div class="teamwork-card-head">${head}</div>` +
    `<div class="teamwork-card-title">${esc(title)}</div>` +
    (chips.length ? `<div class="teamwork-card-chips">${chips.join('')}</div>` : '') +
    (note ? `<div class="teamwork-card-note">${esc(note)}</div>` : '') +
    `</div>`
  );
}


/** 建任务时 AI 提议优先级 → 四象限勾选的映射（用户在确认卡上仍可改） */
const PRIORITY_FLAGS = {
  高: { important: true, urgent: true },
  中: { important: true, urgent: false },
  低: { important: false, urgent: false },
};

// ================================================================ 对话页：插槽会话（0.6.x）

/**
 * 功能：把一次对话的用量拼成一句**人话**（写在会话屏输入框下方的那行小字）。
 *
 * 说明：⭐ 数字来自服务端 `done` 帧的 `used`（那一次**实际**拼进请求的几条），前端不估算、不改写。
 *      ⚠️ 用户看得见的词里不许出现段号 / token / 接口这类开发者叫法 ——
 *      「历史」就是历史、「记忆」就是记忆；没带记忆时干脆不提记忆那半句。
 *
 * @param {{msgs: number, chars: number, mems: number, seg: number}} used - 服务端给的用量
 * @returns {string} 形如 `本次带了 12 条历史 · 3 条记忆`
 */
function usageText(used) {
  const msgs = Number(used && used.msgs) || 0;
  const mems = Number(used && used.mems) || 0;
  return mems > 0 ? `本次带了 ${msgs} 条历史 · ${mems} 条记忆` : `本次带了 ${msgs} 条历史`;
}

/**
 * AI 会话在会话列表里登记用的**条目键** —— 对话模块的 `zx:teamwork-conv-close` 事件靠它认领。
 * @type {string}
 */
export const AI_CONV_KEY = 'ai';

/**
 * 功能：把 AI 作为一条**会话对象**登记进对话模块的会话列表（`zx:teamwork-conv-entries` 留白事件）。
 *
 * 说明：⭐ 0.6.x 起不再是「对话页里的入口条 + 折叠面板」，而是与提醒助手同一形态 ——
 *      会话区里的一行（头像 / 名字 / 摘要由**对话模块**用它自己的行样式画，本模块只供数据），
 *      点开由对话模块挂 `teamwork-thread` 插槽（`desktop/mobile-teamwork-thread.js`）。
 *      ⚠️ **只挂一次**（模块级标记）：对话模块每次重画会话区都会发这个事件，监听器只能有一份。
 * @returns {void}
 */
export function bindTeamworkConvEntries() {
  if (bindTeamworkConvEntries._bound) return;
  bindTeamworkConvEntries._bound = true;
  document.addEventListener('zx:teamwork-conv-entries', (e) => {
    const detail = e && e.detail;
    if (!detail || !Array.isArray(detail.items)) return;
    detail.items.push({
      key: AI_CONV_KEY,
      icon: '🤖',
      name: 'AI 助手',
      sub: '让它帮你把消息整理成任务，或者随便问点什么',
      // 对话屏头部那行副标题（与列表摘要不同：这里要说清「出网」这条边界）
      head: '系统内置角色 · 发送的内容会发给你自己配置的 AI 接口',
    });
  });
}

// ================================================================ 轻量 markdown：AI 回复的字体渲染

/**
 * 轻量 markdown 的**类型白名单** —— 解析器只会产出这几种节点，⛔ 永远没有 `'html'` 这一种。
 *
 * 说明：⭐ 「安全」就落在这张表上：AI 回复是**外部内容**，而这里根本不产出 HTML ——
 *      渲染层只把这些类型映射成 `createElement` / `createTextNode`。
 * @type {Array.<string>}
 */
export const MD_TYPES = [
  'p',
  'text',
  'strong',
  'em',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'h4',
  // ⭐⭐ 0.8.55（「md格式的表格没有支持渲染」）：GFM 表格
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

/**
 * 功能：把一行表格切成单元格（去掉首尾竖线，逐格 trim）。
 * @param {string} line - 一行
 * @returns {Array.<string>} 单元格文本
 */
function mdSplitCells(line) {
  let t = String(line == null ? '' : line).trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * 功能：判断一行是不是 GFM 表格的**分隔行**（`|---|:--:|---|`）。
 *
 * 说明：⚠️ 每一格都必须是 `-` 的重复（可带对齐冒号），一格不合格就整行不算 ——
 *      这样「正文里恰好写了一串竖线和横线」不会被误判成表格。
 * @param {string} line - 一行
 * @returns {boolean} 是分隔行返回 true
 */
function mdIsSepRow(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t.includes('-')) return false;
  const cells = mdSplitCells(t);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * 功能：从第 `i` 行起认一张 GFM 表格 —— **认不出返回 null（⛔ 不猜）**。
 *
 * 说明：⭐ 判据是「表头行 ＋ 下一行分隔行」两行一起看，且列数必须一致：
 *      · 表头必须**至少两列**（一列的「表格」没有意义，按普通文本处理）；
 *      · 分隔行列数必须与表头相同（GFM 的规定，也顺带挡掉半截表格）。
 *      数据行一直吃到「空行」或「不含竖线的行」为止；**多出的格子丢掉、少的补空** ——
 *      宁可画一张整齐的表，也不因为一行不规整就把整张表退化成文本。
 * @param {Array.<string>} lines - 全部行
 * @param {number} i - 表头行的下标
 * @returns {?{node: Object, next: number}} 表格节点与下一行的下标；不是表格为 null
 */
function mdTableAt(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  if (head == null || sep == null) return null;
  if (!String(head).includes('|')) return null;
  const hc = mdSplitCells(head);
  if (hc.length < 2) return null;
  if (!mdIsSepRow(sep)) return null;
  if (mdSplitCells(sep).length !== hc.length) return null;
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const ln = lines[j];
    if (!String(ln).trim() || !String(ln).includes('|')) break;
    rows.push(mdSplitCells(ln));
    j += 1;
  }
  const th = { type: 'tr', children: hc.map((c) => ({ type: 'th', children: mdInline(c, 0) })) };
  const tb = rows.map((r) => ({
    type: 'tr',
    children: hc.map((_, k) => ({ type: 'td', children: mdInline(r[k] == null ? '' : r[k], 0) })),
  }));
  return {
    node: {
      type: 'table',
      children: [
        { type: 'thead', children: [th] },
        { type: 'tbody', children: tb },
      ],
    },
    next: j,
  };
}

/**
 * 功能：把一段 AI 回复解析成**节点描述树**（纯数据、不碰 DOM）—— 只认一小撮写法。
 *
 * 支持的写法（**就这些** —— 要的是「字体渲染」，不是完整 markdown）：
 *   粗体 `**x**` · 斜体 `*x*` · 行内代码 · 三反引号代码块 · 无序列表 `- x` ·
 *   有序列表 `1. x` · 标题 `#`~`####`（一律渲染成 h4）· 空行分段。
 * ⛔ 明确不做：链接（`[x](url)` **原样当普通文本** —— 点了会离开应用）、表格、图片、
 *    任何 HTML 透传。认不出来的标记一律当普通文本；未闭合的标记**不许吞掉后面的字**。
 *
 * @param {string} text - 原始回复
 * @returns {Array.<Object>} 节点数组：`{type:'text', value}` 或 `{type, children}`（type ∈ `MD_TYPES`）
 */
export function parseMarkdownLite(text) {
  const lines = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let para = [];
  let list = null;
  let pre = null; // 非 null = 正处在代码块里（值是攒下的行）；`null` = 不在代码块里

  const flushPara = () => {
    if (!para.length) return;
    out.push({ type: 'p', children: mdInline(para.join('\n'), 0) });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(list);
    list = null;
  };
  const flushPre = () => {
    out.push({ type: 'pre', children: [{ type: 'text', value: pre.join('\n') }] });
    pre = null;
  };

  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li];
    if (pre !== null) {
      // ⚠️ 代码块里**不做任何二次解析**（内容原样，连星号都不动）
      if (/^\s*```/.test(raw)) flushPre();
      else pre.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flushPara();
      flushList();
      pre = [];
      continue;
    }
    // ⭐⭐ 0.8.55：GFM 表格（`| 任务 | 截止 |` ＋ 下一行分隔符 `|---|:--:|`）。
    //  ⚠️ 判据是**两行一起看**：只有「表头行 ＋ 分隔行」都成立才算表格 ——
    //    单看一行含 `|` 就把后面当表格，会把「A|B 这种写法」也吃掉（散文里出现竖线很正常）。
    if (raw.includes('|')) {
      const tb = mdTableAt(lines, li);
      if (tb) {
        flushPara();
        flushList();
        out.push(tb.node);
        li = tb.next - 1; // `for` 还会 +1
        continue;
      }
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) {
      flushPara();
      flushList();
      out.push({ type: 'h4', children: mdInline(h[2], 0) });
      continue;
    }
    // ⚠️ 无序列表只认 `-`：`*` 开头与「斜体」天然二义（`* a` 到底是要点还是强调？），
    //    宁可少认一种，也不猜。
    const ul = /^\s*-\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (!list || list.type !== kind) {
        flushList();
        list = { type: kind, children: [] };
      }
      list.children.push({ type: 'li', children: mdInline((ul || ol)[1], 0) });
      continue;
    }
    if (!raw.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(raw);
  }
  // 未闭合的三反引号：把攒下的行当代码块收尾（⛔ 不许把内容吞掉）
  if (pre !== null) flushPre();
  flushPara();
  flushList();
  return out;
}

/**
 * 功能：解析**行内**标记（粗体 / 斜体 / 行内代码）—— `parseMarkdownLite()` 的内部件。
 *
 * 说明：⚠️ 三条都要满足才认一段强调：开头后面是**非空白**、收尾前面是**非空白**、里面有内容 ——
 *      否则 `2 * 3 * 4` 与孤零零一个 `*` 会被误当成斜体（⛔ 不许猜）。
 *      ⚠️ 嵌套最多三层（再深的当纯文本）：既防病态输入，也防 `*a**b**c*` 这种自相矛盾的写法乱套。
 * @param {string} s - 待解析的片段
 * @param {number} depth - 当前嵌套深度（0 起）
 * @returns {Array.<Object>} 节点数组
 */
function mdInline(s, depth) {
  const str = String(s == null ? '' : s);
  if (depth >= 3) return [{ type: 'text', value: str }];
  const nodes = [];
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ type: 'text', value: buf });
    buf = '';
  };
  let i = 0;
  while (i < str.length) {
    const c = str.charAt(i);
    // 行内代码优先：`x` 里面**不解析**任何标记
    if (c === '`') {
      const end = str.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        nodes.push({ type: 'code', children: [{ type: 'text', value: str.slice(i + 1, end) }] });
        i = end + 1;
        continue;
      }
    }
    if (c === '*') {
      const two = str.startsWith('**', i);
      const len = two ? 2 : 1;
      const close = two ? '**' : '*';
      const next = str.charAt(i + len);
      const end = str.indexOf(close, i + len);
      if (next && /\S/.test(next) && end > i + len && /\S/.test(str.charAt(end - 1))) {
        flush();
        nodes.push({ type: two ? 'strong' : 'em', children: mdInline(str.slice(i + len, end), depth + 1) });
        i = end + len;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return nodes;
}

/** 描述树里的类型 → 真实标签名（⛔ 不在表里的类型没有对应元素 —— 这就是「白名单」）. @type {Object.<string,string>} */
const MD_TAGS = {
  p: 'p',
  strong: 'strong',
  em: 'em',
  code: 'code',
  pre: 'pre',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  h4: 'h4',
  // ⭐ 0.8.55：表格（GFM）—— 仍然逐节点 `createElement`，⛔ 没有 HTML 拼装
  table: 'table',
  thead: 'thead',
  tbody: 'tbody',
  tr: 'tr',
  th: 'th',
  td: 'td',
};

/**
 * 功能：把一个描述树节点变成真 DOM 节点 —— ⛔ 只用 `createElement` / `createTextNode`。
 * @param {Object} n - 描述树节点
 * @returns {Node} DOM 节点
 */
function mdNode(n) {
  const type = n && typeof n.type === 'string' ? n.type : 'text';
  const textOf = () => document.createTextNode(String((n && n.value) == null ? '' : n.value));
  if (type === 'text') return textOf();
  const tag = MD_TAGS[type];
  // ⚠️ 白名单外的类型**当纯文本**，⛔ 绝不 createElement —— 那就等于开了一条 HTML 透传的口子
  if (!tag) return textOf();
  const node = document.createElement(tag);
  for (const c of n.children || []) node.appendChild(mdNode(c));
  return node;
}

/**
 * 功能：把一条 AI 回复**渲染进**气泡（重画成 DOM）。
 *
 * 说明：⭐ 外部内容进 DOM 的**唯一**一条渲染路径：解析成描述树 → 逐节点 `createElement` /
 *      `createTextNode`，⛔ 全程不用任何「HTML 拼装」的 API（同级红线，
 *      `ttt/test/ai.test.js` 按**源码文本**扫描这件事，连带那个 API 的名字都不许出现在本文件里）。
 * @param {HTMLElement} box - 气泡里的 `.ai-msg-text`
 * @param {string} text - 原始回复
 * @returns {void}
 */
function paintMd(box, text) {
  box.textContent = '';
  for (const n of parseMarkdownLite(text)) box.appendChild(mdNode(n));
}

/**
 * 功能：让一个 textarea 跟着内容**自己长高**（到 `max-height` 为止就内部滚动）。
 *
 * 说明：⭐ 0.7.7-⑭：算法与对话页 `modules/teamwork/desktop.js` 的 `autoGrow()` **同一套**
 *      （那是刚统一过的样子，两端看起来得是同一个框）：先把高度归零、再读 `scrollHeight` 赋回去。
 *      ⚠️⭐ **先归零是前提**：不归零的话，删掉几行之后 `scrollHeight` 仍是旧高度 ⇒ 输入框缩不回去。
 *      ⚠️ 封顶交给 CSS 的 `max-height`（本文件是两端共用的，所以这一个函数同时服务电脑端与手机端）。
 *
 * @param {HTMLElement} box - 目标 textarea
 * @returns {void}
 */
function autoGrow(box) {
  if (!box) return;
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

/**
 * ⭐ 0.8.6（行程 1 期 ·）：图片压缩的三个目标值。
 * ⚠️ 服务端那道硬上限是**解码后 ≤ 1 MB**（`core/validate.js` 的 `IMAGE_MAX_BYTES`）——
 * 这里压到 700 KB 是**前端的目标**，两者不是同一个数（前端是「压到多小」，服务端是「最多能收多大」）。
 * @type {number}
 */
const IMG_LONG_SIDE = 1600;
const IMG_QUALITY = 0.8;
const IMG_QUALITY_MIN = 0.4;
const IMG_TARGET_BYTES = 700 * 1024;

/**
 * 功能：算一串 data URL **解码后**的字节数（`n*3/4` 再去掉尾部 padding）。
 * ⚠️ 与 `core/validate.js` 的 `parseImageDataUrl()` 同一套算法（⛔ 不真解码 —— 只判「超没超」）。
 * @param {string} s - data URL
 * @returns {number} 字节数
 */
function dataUrlBytes(s) {
  const t = String(s || '');
  const i = t.indexOf(',');
  if (i < 0) return 0;
  const b64 = t.slice(i + 1);
  const pad = (b64.match(/=+$/) || [''])[0].length;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * 功能：把用户选的一张图**压到能发的大小**，回一整串 data URL。
 *
 * 说明：⭐ 长边 ≤ 1600px / JPEG quality 0.8 / 目标 ≤ 700 KB；压不下去就**如实抛错**
 *      （⛔ **绝不静默丢弃**、也绝不静默发一张超标的图 —— 那两种用户都只会觉得「点了没反应」）。
 *      ⚠️ 先铺一层白底再画：原图可能是带透明通道的 PNG，而 JPEG 没有 alpha，
 *      不铺底会把透明区画成黑块（截图类图片一般没事，但图标类的会很难看）。
 *
 * @param {File} file - 用户选的图片文件
 * @returns {Promise.<string>} 压缩后的 data URL（`data:image/jpeg;base64,…`）
 * @throws {Error} 读不出来 / 打不开 / 压不下去时抛出（文案直接给用户看）
 */
async function shrinkImage(file) {
  // ⚠️⚠️ 真机（「图片发送是打不开」）：**先经 `createImageBitmap` 解码，别用 `<img>`**。
  //    根因：CSP 是 `img-src 'self'`（见 `core/server.js` 的 `CSP_DIRECTIVES`），`data:` 图片被**直接拦掉**，
  //    `<img src="data:…">` 必然触发 `onerror` ⇒ 不管选什么图都报「这张图打不开」。
  //    `createImageBitmap()` 走的是**解码器**而不是图片加载链，不受 `img-src` 管 ⇒ 这条路才通。
  //    ⛔ 别改回 `new Image()`，也⛔ 不要为了这个去放宽 CSP（安全头不为一处便利开口子）。
  const bmp = await (async () => {
    // ⚠️ 走 `window.createImageBitmap`（不是裸名）：eslint 的 browser globals 里没有它，
    //    裸写会触发 no-undef；顺带也正好做「老 WebView 没这个 API」的存在判断。
    if (typeof window !== 'undefined' && typeof window.createImageBitmap === 'function') {
      try {
        return await window.createImageBitmap(file);
      } catch (_e) {
        /* 落到下面那句更准确的话术（多半是 HEIC 这类解码器不认的格式） */
      }
    }
    throw new Error('这张图读不出来（可能是 HEIC 之类手机专有格式）—— 换成 JPG 或 PNG 再发');
  })();
  const iw = Number(bmp.width) || 0;
  const ih = Number(bmp.height) || 0;
  if (!iw || !ih) {
    if (typeof bmp.close === 'function') bmp.close();
    throw new Error('这张图尺寸读不出来，换一张试试');
  }
  const long = Math.max(iw, ih);
  const k = long > IMG_LONG_SIDE ? IMG_LONG_SIDE / long : 1;
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d');
  if (!cx) {
    if (typeof bmp.close === 'function') bmp.close();
    throw new Error('这个浏览器画不了图，换一台设备再试');
  }
  cx.fillStyle = '#ffffff';
  cx.fillRect(0, 0, w, h);
  cx.drawImage(bmp, 0, 0, w, h);
  if (typeof bmp.close === 'function') bmp.close();
  let q = IMG_QUALITY;
  let out = cv.toDataURL('image/jpeg', q);
  while (dataUrlBytes(out) > IMG_TARGET_BYTES && q > IMG_QUALITY_MIN) {
    q = Math.max(IMG_QUALITY_MIN, q - 0.15);
    out = cv.toDataURL('image/jpeg', q);
  }
  if (dataUrlBytes(out) > IMG_TARGET_BYTES) {
    throw new Error('这张图太大了（压到最小还是超过 700 KB）—— 换一张，或者先裁一下再发');
  }
  return out;
}

/**
 * 功能：建 AI 会话的**聊天视图**（消息区 + 输入行）—— 挂在对话模块让位出来的插槽会话屏里，
 *      版式与真人聊天一致：消息自己滚、只向下长高、输入行贴底。
 *
 * 说明：⭐ 交互要点（方案 §七 + ai-console 的通用规矩）：
 *      · **流不算加载态**：发送中发送按钮**原地**变成「停止」（常驻控制，不出现在别处）；
 *      · **失败明确报错**：上游接受**之前**失败 → 文本原样退回输入框（什么都没发生）；
 *        接受之后失败 → 错误气泡带「再试一次」（那一轮已发生，重试是新的一轮）；
 *      · 用户消息在上游接受后才由服务端落库（没发出去的东西不进历史）。
 *      · ⭐ **插槽会话被关掉时**（对话模块发 `zx:teamwork-conv-close` 且 key 认领）就地停流，
 *        监听器自摘（一次挂载只收一次关闭）。
 *
 * @returns {HTMLElement} 视图根节点
 */
export function createAiThreadView() {
  let streaming = false;
  let ctrl = null; // 当次发送的 AbortController（「停止」就是 abort 它）
  let historyLoaded = false;

  const root = el('div', 'ai-thread');
  // ⭐⭐ 0.8.55（「AI对话的UI和其它聊天窗口要一模一样」）：
  //    消息区与输入行**改用好友聊天那一套类名与结构**（`.teamwork-body` / `.teamwork-msg` /
  //    `.teamwork-bubble` / `.teamwork-mtime` / `.teamwork-compose` / `.teamwork-plus`）——
  //    样式一份、类名一套，⛔ 不再自绘 `.ai-msgs` / `.ai-composer`（那是第二套聊天 UI，
  //    与「一模一样」背道而驰，而且好友聊天以后改版这里一定跟不上）。
  //    ⚠️ 消息区挂**两个类**：电脑端好友聊天是 `.teamwork-body`（padding 12 / 底色），
  //    手机端是 `.teamwork-scroll`（padding 12px 2px / 滚动）—— 两端各自的规则只认自己那个类，
  //    而这一份视图两端共用 ⇒ 两个都挂上，各端自然只生效自己那份（不新造第三个容器类）。
  //    ⚠️ AI 专有的三样仍在，但都收进了**顶部那一行**与**输入行右侧**，不占聊天区：
  //    段进度 / 用量（`segstate`）、风险提示（`segmsg`）、「开启新对话」（`newseg`）。
  root.innerHTML = `
    <div class="ai-thread-head">
      <div class="ai-note" data-ai="segstate">正在读取对话进度…</div>
      <button class="ai-btn ai-btn-line" type="button" data-ai="newseg">开启新对话</button>
    </div>
    <div class="ai-note" data-ai="segmsg" hidden></div>
    <div class="teamwork-scroll teamwork-body" data-ai="msgs">
      <div class="ai-note" data-ai="empty">还没有对话。问点什么，或粘贴一段话让它帮你整理成任务。</div>
    </div>
    <div class="teamwork-compose teamwork-input">
      <button class="teamwork-plus" type="button" data-ai="plus" title="发送图片 / 任务" aria-label="发送图片或任务">＋</button>
      <textarea data-ai="input" rows="1" maxlength="${MAX_AI_TEXT}"
        placeholder="问 AI"></textarea>
      <button class="btn btn-primary primary" type="button" data-ai="send">发送</button>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-ai="picfile" hidden />
    </div>`;

  const q = (name) => root.querySelector(`[data-ai="${name}"]`);
  const msgsBox = q('msgs');
  const emptyBox = q('empty');
  const inputBox = q('input');
  const sendBtn = q('send');
  const segState = q('segstate');
  const segMsg = q('segmsg');
  const plusBtn = q('plus');
  // ⚠️ 用量小字与风险提示**不再是布局里的两块**（好友聊天没有它们）——
  //    用量并进顶部那句进度话（`loadSeg()` 之外由 `renderUsage()` 追加），
  //    风险提示挪进「开启新对话」那颗按钮的 title（点开设置也能看到同一句）。
  segMsg.textContent = '发送的内容会离开 NAS，发往「AI 辅助任务」卡片里填写的接口；AI 的提议在落库前都要你确认。';
  segMsg.hidden = true;

  /** 功能：把用量那句拼进顶部（有就追加，没有就不写）。 @param {Object} used - 服务端 `used` 字段 @returns {void} */
  function renderUsage(used) {
    const base = segState.dataset.base || segState.textContent || '';
    segState.dataset.base = base;
    const extra = used ? usageText(used) : '';
    segState.textContent = extra ? `${base} · ${extra}` : base;
  }

  // ⭐ 0.8.6：**待发送的那一张图**已取消 —— 与好友聊天同一条口径：选了图**直接发**，
  //    ⛔ 不再留一个「预览条 + 去掉这张图」的中间态（那正是两套聊天 UI 的差异之一）。
  //    这个账号开没开「支持图片输入」—— ⚠️ **问服务端**，前端不自己猜。
  let visionOn = false;

  const picFile = q('picfile');

  /**
   * 功能：把输入框里的文字发出去 —— 发送按钮与回车都走这里。
   * @returns {void}
   */
  function sendFromComposer() {
    if (streaming) return;
    const v = inputBox.value.trim();
    if (!v) {
      inputBox.focus();
      return;
    }
    inputBox.value = '';
    autoGrow(inputBox); // ⭐ 0.7.7-⑭：发完缩回一行高
    sendText(v, null);
  }

  /**
   * 功能：⭐ 0.8.55 —— 输入框左边那颗圆圈 ＋ 的菜单（与好友聊天**同一套类名**）。
   *
   * 说明：⚠️ 三项顺序与好友聊天逐字一致：发送图片 / 协作项目任务 / 普通任务。
   *      ⚠️「支持图片输入」没开时，**图片那一项置灰并写明原因**（⛔ 不静默禁用、⛔ 更不是点了没反应）——
   *      与好友聊天那边「没选会话就置灰」是同一条做法。
   * @returns {void}
   */
  function openAiSendMenu() {
    const items = [
      {
        act: 'image',
        icon: '🖼',
        title: '发送图片',
        desc: visionOn ? '挑一张图让它看（png / jpg / webp，8 MB 以内）' : '「支持图片输入」没开 —— 到「AI 设置」里打开它',
        off: !visionOn,
      },
      { act: 'collab', icon: '📁', title: '协作项目任务', desc: '把某个协作项目里的任务发给它（按项目分）', off: false },
      { act: 'daily', icon: '✅', title: '普通任务', desc: '把日常任务 / 我的项目任务发给它（按项目分）', off: false },
    ];
    const box = document.createElement('div');
    box.className = 'tw-send-menu';
    box.dataset.aiSendMenu = '1';
    box.innerHTML = items
      .map(
        (it) =>
          `<button class="tw-send-item" type="button" data-ai-send="${it.act}"${it.off ? ' disabled' : ''}>` +
          `<span class="tw-send-ico">${it.icon}</span>` +
          `<span class="tw-send-txt"><b>${esc(it.title)}</b><small>${esc(it.desc)}</small></span>` +
          `</button>`,
      )
      .join('');
    openHostPopover(box, plusBtn);
  }

  /**
   * 功能：开一次发送菜单所需的「挂到哪」—— ⚠️ 本视图不接 host（没有弹层能力），
   *      所以菜单就地挂在输入行上方（一个绝对定位的小浮层），点空白 / 选完就收。
   * @param {HTMLElement} box - 菜单节点
   * @param {HTMLElement} anchor - 贴着谁弹
   * @returns {void}
   */
  function openHostPopover(box, anchor) {
    closeHostPopover();
    root.classList.add('has-pop');
    box.classList.add('ai-send-menu');
    root.appendChild(box);
    // ⚠️ 位置由 CSS 给（`.ai-send-menu` 贴在输入行上方、左边对齐那颗 ＋）；
    //    这里只负责「点外面收起来」与「再点一次 ＋ 收起来」。
    const close = (e) => {
      if (e && e.target && (box.contains(e.target) || anchor.contains(e.target))) return;
      closeHostPopover();
    };
    setTimeout(() => document.addEventListener('click', close), 0);
    box._aiClose = () => document.removeEventListener('click', close);
  }

  /** 功能：收起发送菜单。 @returns {void} */
  function closeHostPopover() {
    const old = root.querySelector('[data-ai-send-menu]');
    if (old) {
      if (typeof old._aiClose === 'function') old._aiClose();
      old.remove();
    }
    root.classList.remove('has-pop');
  }

  /**
   * 功能：⭐ 与好友聊天同一条口径 —— **选了图直接发**（不再有「预览条 → 再点发送」这一步）。
   * @returns {void}
   */
  function onPickImage() {
    const f = picFile.files && picFile.files[0];
    picFile.value = '';
    if (!f) return;
    if (!visionOn) return;
    if (f.size > IMG_MAX_BYTES) return errorLine('这张图太大了（8 MB 以内）—— 压一下或者裁一刀再发。');
    // ⭐ 与好友聊天同一条口径：**先压再发**（长边 ≤1600 / JPEG 0.8 / 目标 ≤700 KB），
    //    压不下去就如实报错 —— ⛔ 不静默丢弃、也不静默发一张超标的图。
    shrinkImage(f)
      .then((url) => sendText('', url))
      .catch((e) => errorLine(e && e.message ? e.message : '这张图用不了'));
  }

  /**
   * 功能：重新读一次「现在是第几段、这一段有多少条」，写进顶部那行进度句。
   *
   * 说明：⭐ 0.7.6 从配置屏搬过来 —— 「这是第几段」是**会话自己的事**，配置屏管不着它。
   *      ⚠️ 段号取「消息里最大的那个」：不带 `segment` 的历史行语义就是第 1 段（服务端已归一）。
   * @returns {Promise.<void>}
   */
  async function loadSeg() {
    try {
      const r = await api('GET', '/api/ai/messages?limit=200');
      const items = r.items || [];
      if (!items.length) {
        segState.textContent = '还没有任何对话。';
        return;
      }
      const seg = items.reduce((m, x) => Math.max(m, Number(x.segment) || 1), 1);
      const here = items.filter((x) => (Number(x.segment) || 1) === seg).length;
      // ⚠️ 只取了最近 200 条：这一段的条数可能被截断，那就**别报一个假精确的数**
      const capped = items.length >= 200 && here >= 200;
      // ⭐ 0.7.7-⑮：界面上说**「轮」**，代码里仍叫 `segment` —— 这是**有意**的，不是漏改：
      //    `segment` / `cur_segment` / `aiNewSegment()` / REST 字段 / 表列名一个字都没动，
      //    只有**用户看得见的那句话**换了词。全屏不再出现「段」（术语混用会让人以为是两回事）。
      segState.textContent = capped
        ? `第 ${seg} 轮，本轮消息很多（这里只数了最近 200 条）`
        : `第 ${seg} 轮，本轮 ${here} 条消息`;
    } catch (e) {
      segState.textContent = `对话进度读取失败：${e.message}`;
    }
  }

  // ⭐ 0.7.6：开新对话 —— 只让**接下来的**对话不带更早的内容，旧消息一条都不删（回显里对用户说明白）
  q('newseg').addEventListener('click', async () => {
    const btn = q('newseg');
    btn.disabled = true;
    segMsg.hidden = true;
    try {
      const r = await api('POST', '/api/ai/chat/new', {});
      segMsg.hidden = false;
      segMsg.textContent =
        `已开启第 ${r.segment} 轮：接下来的对话不会带上更早的内容。` + '旧消息一条都没删，往上翻还能看到。';
      await loadSeg();
    } catch (e) {
      segMsg.hidden = false;
      segMsg.textContent = `没能开启新对话：${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  /**
   * 功能：画一条消息 —— ⭐ 0.8.55 起**用好友聊天那一套 DOM**（`.teamwork-msg` + `.teamwork-bubble`
   *      + `.teamwork-mtime`），⛔ 不再自绘 `.ai-msg` / `.ai-msg-text`。
   *
   * 说明：⭐ 0.7.6：**AI 的回复**走轻量 markdown 渲染（`paintMd()`，仍是逐节点建 DOM，
   *      ⛔ 没有 HTML 透传）；**用户自己发的**照旧原样纯文本 —— 用户打的是原话，不该被当成格式。
   *      ⚠️ 返回值的 `firstChild` **必须是那颗气泡**（`.teamwork-bubble`）—— 流式那一段靠
   *      `assistantBox.firstChild.textContent = acc` 往里写字，这是与 `sendText()` 的既有约定。
   *      所以结构固定成「气泡在前、时间在后」，⛔ 别把时间放到前面。
   * @param {string} role - 'user' | 'assistant'
   * @param {string} text - 消息文本（空串 = 先立个位，流式随后往里写）
   * @param {string} [imgUrl] - 图片地址（有就画一张缩略图）
   * @param {string} [createdAt] - 时间戳（历史消息带；本地乐观消息不带给「现在」）
   * @returns {HTMLElement} 消息行（调用方决定是否接着往里追加流式增量）
   */
  function bubble(role, text, imgUrl, createdAt) {
    const mine = role === 'user';
    const box = el('div', `teamwork-msg${mine ? ' mine' : ' builtin'}`);
    if (imgUrl) {
      // ⭐ 0.8.55：图片走**好友聊天同款的 `figure.teamwork-img-box`** —— 类名与
      //    `data-teamwork-img` 一致，点开看大图由 teamwork 那份文档级委托接（⛔ 不用另写一套）。
      const fig = document.createElement('figure');
      fig.className = 'teamwork-img-box';
      fig.dataset.teamworkImg = imgUrl;
      fig.dataset.teamworkImgName = '图片';
      const im = document.createElement('img');
      im.className = 'teamwork-img';
      im.src = imgUrl;
      im.alt = '这张消息带的图片';
      im.loading = 'lazy';
      im.decoding = 'async';
      fig.appendChild(im);
      box.appendChild(fig);
    }
    const t = el('div', 'teamwork-bubble');
    // ⚠️ 只有图、一个字都没写时**不画那个空气泡**（空 div 会留下一条多余的间隙）
    if (!imgUrl || text) {
      if (mine || !text) t.textContent = text;
      else paintMd(t, text);
      box.appendChild(t);
      if (!text) box.dataset.empty = '1';
    }
    const time = el('div', 'teamwork-mtime');
    time.textContent = fmtChatTime(createdAt);
    box.appendChild(time);
    msgsBox.appendChild(box);
    emptyBox.hidden = true;
    scrollEnd();
    return box;
  }

  /**
   * 功能：把一条消息里那张图**换成另一个地址**（⭐ 0.8.55 修「图片发送打不开」）。
   *
   * 说明：⭐⭐ 本地刚选的那张图是 `data:` URL，而 CSP 是 `img-src 'self'`
   *      （`core/server.js` 的 `CSP_DIRECTIVES`）⇒ 它在气泡里**显示不出来**（不是图坏了，是被拦了）。
   *      `start` 帧一到，服务端已把图落库，这里把 `src` 与点开大图用的 `data-teamwork-img`
   *      一起换成**同源**取图接口 —— 于是预览、点开、刷新之后看到的是同一张图。
   * @param {HTMLElement} box - 消息行
   * @param {string} url - 同源图片地址
   * @returns {void}
   */
  function swapImageSrc(box, url) {
    const fig = box && box.querySelector ? box.querySelector('figure[data-teamwork-img]') : null;
    if (!fig) return;
    fig.dataset.teamworkImg = url;
    const im = fig.querySelector('img');
    if (im) im.src = url;
  }

  /**
   * 功能：把消息区滚到底部（流式追加时每帧都要，别让新字长在视野外）。
   * @returns {void}
   */
  function scrollEnd() {
    msgsBox.scrollTop = msgsBox.scrollHeight;
  }

  // ---------------- ⭐ 0.7.7-⑲：会话流里的「任务确认卡」 ----------------

  /**
   * 每张卡片的**快照**（卡片消息 id → `meta` 对象）—— 点「同意」时要拿它去逐条建任务。
   * ⚠️ 为什么不用 DOM 反读：卡片是**只读**的展示，把结构化数据塞进 HTML 属性再读回来
   * 只会多一层转义/反解析的出错面。 @type {Map.<number, Object>}
   */
  const proposalMetas = new Map();

  /**
   * 功能：把一张确认卡画进消息区（放在 AI 那条回复的下一条，与它对用户的说法挨着）。
   *
   * 说明：⭐ 0.8.55：外层换成好友聊天那一套（`.teamwork-msg builtin is-card`）——
   *      卡片消息与好友聊天里的任务卡片**同宽同位**（定宽规则写在 `.teamwork-msg.is-card` 上）。
   *      卡片本体仍是 `.ai-prop-card`（确认卡是 AI 独有，好友聊天没有对应的东西）。
   * @param {{id: number, meta: ?Object}} card - 卡片
   * @returns {?HTMLElement} 卡片节点；`meta` 认不出来时为 null（调用方退回普通气泡）
   */
  function cardMsg(card) {
    const html = proposalCardHtml(card);
    if (!html) return null;
    const id = Number(card && card.id) || 0;
    proposalMetas.set(id, card.meta && card.meta.items ? card.meta : { items: [], state: 'pending' });
    const b = el('div', 'teamwork-msg builtin is-card');
    b.innerHTML = html;
    const time = el('div', 'teamwork-mtime');
    time.textContent = fmtChatTime(card && card.createdAt);
    b.appendChild(time);
    msgsBox.appendChild(b);
    emptyBox.hidden = true;
    scrollEnd();
    return b;
  }

  /**
   * 功能：把一张**任务卡片**画进消息区 —— ⭐ 0.8.55：把任务发给 AI 时用它。
   *
   * 说明：⚠️ 那是**我发出去**的一条消息（`mine`），所以靠右。
   *      结构与类名与好友聊天里那张卡片**逐字一致**（`.teamwork-card` / `-head` / `-title`
   *      / `-chips` / `-note`）—— 两边看到的是同一种卡片。
   *      ⛔ 不画卡片底部那排动作按钮：那边是「收进我的任务板」，而我发给 AI 的是**我自己已有的**
   *      任务，收进来等于自己抄自己。
   * @param {Object} meta - 卡片快照（`{title, due, important, urgent, note, src, project, from}`）
   * @param {string} [createdAt] - 时间戳
   * @returns {HTMLElement} 消息行
   */
  function taskCardMsg(meta, createdAt) {
    const raw = meta && typeof meta === 'object' ? meta : {};
    const box = el('div', 'teamwork-msg mine is-card');
    box.innerHTML = chatCardHtml(raw);
    const time = el('div', 'teamwork-mtime');
    time.textContent = fmtChatTime(createdAt);
    box.appendChild(time);
    msgsBox.appendChild(box);
    emptyBox.hidden = true;
    scrollEnd();
    return box;
  }

  /**
   * 功能：把卡片里的条目逐条建成任务 —— ⚠️ **逐条尽力而为**（一条失败不拖累其余），
   *      并把成功 / 失败条数报回去（卡上要写清结论）。
   *
   * 说明：⭐⭐ 落库**只走** `core/task-create.js`—— ⛔ 这里不许自己拼
   *      `POST /api/daily`。二次校验：① 一次最多 `MAX_AI_PROPOSAL_ITEMS` 条（超了**抛错** =
   *      可见地拒绝）；② 标题必填；③ 归属必须是 `'daily'` 或**自己的**项目（拉不到清单时只有日常）。
   *
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败条数
   * @throws {Error} 条数超上限时（调用方把它显示成一条人话）
   */
  async function createProposalTasks(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_PROPOSAL_ITEMS) {
      throw new Error(`一次最多加 ${MAX_AI_PROPOSAL_ITEMS} 条，这次有 ${list.length} 条 —— 让 AI 分批整理吧。`);
    }
    let own = new Set();
    try {
      const ps = await api('GET', '/api/projects');
      own = new Set((Array.isArray(ps) ? ps : []).map((p) => Number(p.id)));
    } catch (_e) {
      // 拉不到项目清单 ⇒ 只剩「日常任务」可用（与模态确认卡同一处理，不拦这一步）
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      const title = String(s.title || '').trim();
      const raw = s.scope == null || s.scope === '' ? 'daily' : s.scope;
      const scope = raw === 'daily' || own.has(Number(raw)) ? (raw === 'daily' ? 'daily' : Number(raw)) : null;
      if (!title || scope === null) {
        failed += 1;
        continue;
      }
      try {
        await createTask(scope, {
          title,
          due_date: String(s.due || ''),
          important: Number(s.important) ? 1 : 0,
          urgent: Number(s.urgent) ? 1 : 0,
          content: String(s.note || ''),
          // ⭐ 0.8.55：任务类型与周期规则（服务端提议里已经归一过；老卡没有这两个键 ⇒ 普通任务）
          //    ⚠️ 字段是 `task_kind` —— `kind` 在这个对象里另有含义（模块名），别混
          task_kind: s.task_kind ? String(s.task_kind) : '',
          recur_rule: s.rule || null,
        });
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的账目逐条记进账本 —— ⚠️ **逐条尽力而为**（一笔失败不拖累其余），
   *      并把成功 / 失败笔数报回去（卡上要写清结论）。
   *
   * 说明：⭐⭐ 落库**只走** `core/ledger-create.js`（记账创建的唯一入口，与任务的 同一条规矩）
   *      —— ⛔ 这里不许自己拼 `POST /api/ledger/entries`。
   *      二次校验：① 一次最多 `MAX_AI_LEDGER_ITEMS` 笔（超了**抛错** = 可见地拒绝）；
   *      ② `at` 与 `amount` 必填（缺了那条直接记失败 —— 服务端也会 400，但在这里挡掉省一次往返）。
   *      ⚠️ `category_id` / `account_id` 原样透传（`null` 是**有意义的两个落点**：未分类 / 不关联账户，
   *      ）—— ⛔ 别在这里「兜一个默认分类」（那会把 AI 的猜测变成用户的账）。
   *
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败笔数
   * @throws {Error} 笔数超上限时（调用方把它显示成一条人话）
   */
  async function createProposalEntries(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_LEDGER_ITEMS) {
      throw new Error(`一次最多记 ${MAX_AI_LEDGER_ITEMS} 笔，这次有 ${list.length} 笔 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      const at = String(s.at || '');
      const amount = String(s.amount || '');
      if (!at || !amount) {
        failed += 1;
        continue;
      }
      try {
        await createLedgerEntry({
          at,
          ie: s.ie,
          amount,
          category_id: s.category_id == null ? null : s.category_id,
          account_id: s.account_id == null ? null : s.account_id,
          note: String(s.note || ''),
        });
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的收藏逐条存进收藏夹（0.8.5）—— ⚠️ **逐条尽力而为**，并报回成功 / 失败条数。
   *
   * 说明：⭐⭐ 落库**只走** `core/bookmark-create.js`（收藏创建的唯一入口，与 同一条规矩）
   *      —— ⛔ 这里不许自己拼 `POST /api/bookmarks`。
   *      ⚠️ 重复的网址（快照里的 `dup`）**照样会试一次**：卡上已经写明「不会重复写入」，
   *      而真正挡住它的是服务端那道 400 —— 前端**不替服务端做判重**（那会变成第二份口径）。
   *
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败条数
   * @throws {Error} 条数超上限时（调用方把它显示成一条人话）
   */
  async function createProposalBookmarks(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_BOOKMARK_ITEMS) {
      throw new Error(`一次最多存 ${MAX_AI_BOOKMARK_ITEMS} 条，这次有 ${list.length} 条 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      const url = String(s.url || '').trim();
      if (!url) {
        failed += 1;
        continue;
      }
      try {
        await createBookmark({ url, title: String(s.title || ''), tags: Array.isArray(s.tags) ? s.tags : [] });
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的随手记逐条记下来（0.8.5）—— ⚠️ **逐条尽力而为**。
   *
   * 说明：⭐⭐ 落库**只走** `core/idea-create.js`（随手记创建的唯一入口）——
   *      ⛔ 这里不许自己拼 `POST /api/idea`。
   *
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败条数
   * @throws {Error} 条数超上限时
   */
  async function createProposalIdeas(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_IDEA_ITEMS) {
      throw new Error(`一次最多记 ${MAX_AI_IDEA_ITEMS} 条，这次有 ${list.length} 条 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      if (!String(s.content || '').trim()) {
        failed += 1;
        continue;
      }
      try {
        await createIdea({ content: String(s.content || ''), tag: String(s.tag || '') });
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的硬件逐件写进台账（0.8.5）—— ⚠️ **逐条尽力而为**。
   *
   * 说明：⭐⭐ 落库**只走** `core/hardware-create.js`（硬件创建的唯一入口）——
   *      ⛔ 这里不许自己拼 `POST /api/hardware`。
   *      ⚠️ 快照对象整个交出去：`createHardware()` 只挑它认识的那几个键（多送的会被忽略），
   *      而快照的字段白名单本来就由服务端 `snapshotProposalItems()` 定。
   *
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败件数
   * @throws {Error} 件数超上限时
   */
  async function createProposalHardware(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_HARDWARE_ITEMS) {
      throw new Error(`一次最多登记 ${MAX_AI_HARDWARE_ITEMS} 件，这次有 ${list.length} 件 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      if (!String(s.name || '').trim()) {
        failed += 1;
        continue;
      }
      try {
        await createHardware(s);
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的车票逐张建出来（0.8.6）—— ⚠️ **逐条尽力而为**。
   *
   * 说明：⭐⭐ 落库**只走** `core/trip-create.js`（车票创建的唯一入口）——
   *      ⛔ 这里不许自己拼 `POST /api/trip/tickets`（不造第二条创建路径）。
   *      ⚠️ **标了 `bad` 的那几条照样送过去**：服务端按它自己的字段校验如实拒掉（那一条算失败），
   *      卡上因此会写「有 N 张没能加上」—— 这比在这里**静默跳过**好得多
   *      （跳过的话用户以为 AI 漏了一条，而卡上还写着「已加进去 N 张」）。
   *
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败张数
   * @throws {Error} 张数超上限时
   */
  async function createProposalTrips(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_TRIP_ITEMS) {
      throw new Error(`一次最多加 ${MAX_AI_TRIP_ITEMS} 张，这次有 ${list.length} 张 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      // 本地先挡一道「连必填都没有」的：省一次注定失败的请求（服务端那道校验照样在）
      if (!String(s.from || '').trim() || !String(s.to || '').trim() || !String(s.depart || '').trim()) {
        failed += 1;
        continue;
      }
      try {
        await createTicket(s);
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的资产条目逐条记进台账（⭐ 0.8.55）—— ⚠️ **逐条尽力而为**。
   *
   * 说明：⭐⭐ 落库**只走** `core/asset-create.js`（资产条目的唯一入口）——
   *      ⛔ 这里不许自己拼 `POST /api/assets/items`（不造第二条创建路径）。
   *      ⚠️ 分组是**服务端解析好的 `group_id`**（模型说的名字在本机找不到时它是 null）——
   *      那就按「未分组」落库，与用户在那个弹层里不选分组是同一种结果。
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败条数
   * @throws {Error} 条数超上限时
   */
  async function createProposalAssets(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_ASSET_ITEMS) {
      throw new Error(`一次最多记 ${MAX_AI_ASSET_ITEMS} 条，这次有 ${list.length} 条 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      if (!String(s.name || '').trim()) {
        failed += 1;
        continue;
      }
      try {
        await createAssetItem({
          name: s.name,
          group_id: s.group_id == null ? null : s.group_id,
          amount_fen: s.amount_fen == null ? null : s.amount_fen,
          date: s.date,
        });
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * 功能：把卡片里的日程逐条建出来（⭐ 0.8.55）—— ⚠️ **逐条尽力而为**。
   *
   * 说明：⭐⭐ 落库**只走** `core/calendar-create.js`（日程创建的唯一入口）。
   *      ⚠️ 标了 `bad` 的那几条照样送过去：服务端按自己的校验如实拒掉（那一条算失败），
   *      卡上因此会写「有 N 条没能加上」——比在这里**静默跳过**好（跳过的话用户以为 AI 漏了一条）。
   * @param {Array.<Object>} items - 卡片快照里的条目
   * @returns {Promise.<{added: number, failed: number}>} 成功 / 失败条数
   * @throws {Error} 条数超上限时
   */
  async function createProposalEvents(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_AI_EVENT_ITEMS) {
      throw new Error(`一次最多加 ${MAX_AI_EVENT_ITEMS} 条，这次有 ${list.length} 条 —— 让 AI 分批整理吧。`);
    }
    let added = 0;
    let failed = 0;
    for (const it of list) {
      const s = it && typeof it === 'object' ? it : {};
      // 本地先挡一道「连必填都没有」的（服务端那道校验照样在）
      if (!String(s.title || '').trim() || !String(s.date || '').trim()) {
        failed += 1;
        continue;
      }
      try {
        await createCalendarEvent({
          title: s.title,
          date: s.date,
          end_date: s.end_date,
          all_day: s.all_day === true,
          start_time: s.start_time,
          end_time: s.end_time,
        });
        added += 1;
      } catch (_e) {
        failed += 1;
      }
    }
    return { added, failed };
  }

  /**
   * ⭐ 0.8.5：kind → 落库函数（**闭包内**的这张表 —— 它要用 `api` 与上面那五个函数）。
   * ⚠️ 模块级的 `PROPOSAL_UI` 管「怎么画」，这张表管「怎么落库」；两张表各管一段。
   * @type {Object.<string, Function>}
   */
  const PROPOSAL_RUNNERS = {
    [PROPOSAL_KIND]: createProposalTasks,
    [LEDGER_PROPOSAL_KIND]: createProposalEntries,
    [BOOKMARKS_PROPOSAL_KIND]: createProposalBookmarks,
    [IDEA_PROPOSAL_KIND]: createProposalIdeas,
    [HARDWARE_PROPOSAL_KIND]: createProposalHardware,
    [TRIP_PROPOSAL_KIND]: createProposalTrips,
    [ASSETS_PROPOSAL_KIND]: createProposalAssets,
    [CALENDAR_PROPOSAL_KIND]: createProposalEvents,
  };

  /**
   * 功能：⭐ 0.8.55 点「修改」—— 把这张卡的内容**带进那个模块自己的「新建」弹窗**，预填好让用户改。
   *
   * 说明：⭐⭐ 走**留白事件** `zx:ai-proposal-edit`：AI 模块只管「把内容交出去」，
   *      弹窗长什么样、字段怎么校验、存到哪儿，全都是那个模块自己的事 —— ⛔ 不在这里画第二份表单。
   *      ⚠️ 用 `detail.handled` 回执判断「有没有模块认领」：没人认领就**明说**支持不了，
   *      ⛔ 不许点了没反应（那正是最讨厌的那种）。
   *      ⚠️ 卡片状态**不动**：改完存下的是那个模块自己的记录，这张卡仍「待处理」——
   *      用户可以回头再点同意 / 拒绝（「修改」不是一种表态）。
   * @param {number} id - 卡片消息 id
   * @returns {void}
   */
  function editProposal(id) {
    const meta = proposalMetas.get(Number(id));
    if (!meta) return;
    const detail = {
      id: Number(id),
      kind: String(meta.kind || ''),
      items: Array.isArray(meta.items) ? meta.items : [],
      // ⚠️ 回执：谁认领谁把它置 true
      handled: false,
    };
    document.dispatchEvent(new CustomEvent('zx:ai-proposal-edit', { detail }));
    if (!detail.handled) {
      errorLine('这类卡片还不能改完再存 —— 先用「同意」或「拒绝」吧（要改的话，可以把内容发给我重新整理一遍）。');
    }
  }

  /**
   * 功能：点「同意 / 拒绝」—— 同意先逐条建任务、再请服务端写回卡片状态；拒绝直接写回。
   *
   * 说明：⚠️ 服务端**不自己建任务**（那会变成第二条创建路径）：它只改状态 + 追加一条助手消息，
   *      并把那条消息回给我们显示（单一真相：刷新之后看到的是同一条）。
   * @param {number} id - 卡片消息 id
   * @param {string} action - `'agree'` | `'reject'`
   * @returns {Promise.<void>}
   */
  async function resolveProposal(id, action) {
    const meta = proposalMetas.get(Number(id));
    if (!meta) return;
    const box = msgsBox.querySelector(`[data-ai-prop-card="${Number(id)}"]`);
    const btns = box ? Array.from(box.querySelectorAll('[data-ai-prop-act]')) : [];
    btns.forEach((b) => {
      b.disabled = true;
    });
    const unlock = () => {
      // ⚠️ 只有卡还在「待处理」时才解锁（处理成功的话卡里已经没有按钮了）
      if (box && box.querySelector('[data-ai-prop-act]')) {
        btns.forEach((b) => {
          b.disabled = false;
        });
      }
    };
    try {
      let payload = { action };
      if (action === 'agree') {
        // ⭐ 0.8.5：五种「同意」各走各的唯一入口（见 `PROPOSAL_RUNNERS` 那张表）——
        //    任务 → createTask、记账 / 收藏 / 随手记 / 硬件 → 各自 `core/*-create.js`。
        const ui = uiOfKind(meta.kind);
        const run = PROPOSAL_RUNNERS[String(meta.kind || '')] || PROPOSAL_RUNNERS[PROPOSAL_KIND];
        const r = await run(meta.items);
        if (!r.added) {
          // 一条都没成功 ⇒ 卡**留在待处理**（用户可以点「拒绝」让 AI 重来）
          errorLine(`一条都没${ui.verb}（${r.failed} ${ui.unit}没成）—— 可以点「拒绝」，让 AI 重新整理一遍。`);
          unlock();
          return;
        }
        payload = { action, added: r.added, failed: r.failed };
      }
      const res = await api('POST', `/api/ai/proposals/${Number(id)}`, payload);
      if (box && res && res.card) {
        proposalMetas.set(Number(id), res.card.meta || meta);
        box.innerHTML = proposalCardHtml({ id: Number(id), meta: res.card.meta }) || '';
      }
      if (res && res.reply && res.reply.body) bubble('assistant', res.reply.body);
      unlock();
    } catch (e) {
      errorLine(`这个操作没成功：${e && e.message ? e.message : '未知原因'}`);
      unlock();
    }
  }

  // ⚠️ 委托挂在**消息区**上（卡片是后画进来的，逐张绑会漏掉历史里那些）
  msgsBox.addEventListener('click', (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest('[data-ai-prop-act]') : null;
    if (!btn) return;
    const act = String(btn.dataset.aiPropAct);
    // ⭐ 0.8.55：「修改」不表态（卡片状态不动），只是把内容搬进那个模块的新建弹窗
    if (act === 'edit') return void editProposal(Number(btn.dataset.aiPropId));
    resolveProposal(Number(btn.dataset.aiPropId), act);
  });

  /**
   * 功能：在会话区里画一条**错误行**（不是气泡 —— 错误不是会话内容，也不落库）。
   * @param {string} text - 用户能照着做的错误说明
   * @param {?Function} retry - 可选：附一枚「再试一次」按钮（重发同一段输入，是一轮新对话）
   * @returns {void}
   */
  function errorLine(text, retry) {
    const line = el('div', 'ai-msg-err');
    const t = el('span');
    t.textContent = `⚠️ ${text}`;
    line.appendChild(t);
    if (retry) {
      const btn = el('button', 'ai-btn ai-btn-mini');
      btn.type = 'button';
      btn.textContent = '再试一次';
      btn.addEventListener('click', () => {
        line.remove();
        retry();
      });
      line.appendChild(btn);
    }
    msgsBox.appendChild(line);
    scrollEnd();
  }

  /**
   * 功能：拉一次会话历史（首次展开时）—— 空历史不动「还没有对话」的提示。
   * @returns {Promise.<void>}
   */
  async function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    try {
      const r = await api('GET', '/api/ai/messages?limit=50');
      for (const m of r.items || []) {
        // ⭐ 0.7.7-⑲：确认卡按卡片画（刷新页面卡还在、两颗按钮也还在）；认不出来就当普通消息
        // ⭐ 0.8.4：两种卡都认（任务 / 记账）—— 判据只此一处（`isProposalMsgKind()`）
        if (isProposalMsgKind(m.kind) && m.meta && cardMsg({ id: m.id, meta: m.meta, createdAt: m.createdAt })) continue;
        // ⭐⭐ 0.8.55：**我把任务发给它**的那张卡片 —— 与好友聊天里那张同款（刷新后还在）
        if (String(m.kind || '') === 'task_card' && m.meta) {
          taskCardMsg(m.meta, m.createdAt);
          continue;
        }
        // ⭐ 0.8.6：带图的那条 —— 历史列表只回 `has_image`（⛔ 永不拖 base64），
        //    图本身按需向**它自己的接口**取（`<img>` 自己去请求，正好省掉一次显式取数）。
        bubble(m.role, m.content, m.has_image ? `${BASE}/api/ai/messages/${m.id}/image` : '', m.createdAt);
      }
      if ((r.items || []).length) emptyBox.hidden = true;
    } catch (e) {
      historyLoaded = false; // 失败允许下次展开再试
      errorLine(`历史读取失败：${e.message}`);
    }
  }

  /**
   * 功能：切「发送 / 停止」按钮的形态 —— 同一个槽位原地换（常驻控制，别让按钮跑来跑去）。
   * @param {boolean} on - 是否处于发送中
   * @returns {void}
   */
  function setStreaming(on) {
    streaming = on;
    sendBtn.textContent = on ? '停止' : '发送';
    // ⭐ 0.8.55：按钮就是好友聊天那颗 `.btn.btn-primary`，发送中只换文案与一个 `is-stop` 类
    //    （⛔ 不换掉 `.btn-primary` —— 换了之后尺寸与配色都跟好友聊天不一样了）
    sendBtn.classList.toggle('is-stop', on);
    inputBox.disabled = on;
  }

  /**
   * 功能：⭐ 0.8.55 —— 借宿主的**同一个任务选择器**（好友聊天＋ 菜单里那个）。
   *
   * 说明：⚠️ 走留白事件而不是自己再画一个选择器：那个弹层有搜索、三个筛选、按项目折叠，
   *      复制一份就是第二套 UI（这次要的正是两端「一模一样」）。
   *      协作模块收到 `zx:ai-pick-task` 后会打开它自己的选择器，选中时把
   *      `{card, bodyText}` 回调给这里 —— ⛔ 本模块不认识任务的表结构。
   * @param {'daily'|'collab'} act - 要挑哪一类任务
   * @returns {void}
   */
  function pickTaskForAi(act) {
    if (streaming) return;
    document.dispatchEvent(
      new CustomEvent('zx:ai-pick-task', {
        detail: {
          act,
          done: (picked) => {
            if (!picked || !picked.card) return;
            // ⚠️ 正文就是「降级文本」：模型读到的就是它（卡片本身是给人看的）
            sendText(String(picked.bodyText || ''), null, picked.card);
          },
        },
      }),
    );
  }

  /**
   * 功能：把一段文本发出去（SSE 读流）—— 发送按钮与「再试一次」都走这里。
   *
   * 说明：⭐ 用 `fetch` 读 POST 的流式响应（`EventSource` 只支持 GET）；帧解析与
   *      `modules/teamwork/teamwork-stream.js` 同口径：按 `\n\n` 切帧、`data:` 行、注释帧忽略、坏帧跳过。
   *      ⭐ `timeout: 0`（不设前端超时上界）：等待的上界由**服务端** 30 秒总时长闸门决定 ——
   *      前端 15 秒的默认超时比它短，会把「模型还在想」掐成假失败。
   *      ⭐ 失败分两半（与服务端的落库时机对齐）：
   *      `start` 帧**之前**失败 = 什么都没发生 → 撤掉乐观气泡、文本退回输入框；
   *      `start` 帧**之后**失败 = 那一轮已发生（用户消息在历史里）→ 保留残段 + 错误行 +「再试一次」。
   *
   * @param {string} content - 要发送的文本（非空；只发图时为空串）
   * @param {?string} image - 图片 data URL（null = 没有图）
   * @param {?Object} card - ⭐ 0.8.55：任务卡片快照（把任务发给 AI 时带；null = 普通消息）
   * @returns {Promise.<void>}
   */
  async function sendText(content, image, card) {
    if (streaming) return;
    // ⭐ 0.8.55：任务卡片按卡片画（与好友聊天里那张同款）；0.8.6 起本地刚选的图直接用 data URL 先画
    const userB = card ? taskCardMsg(card) : bubble('user', content, image || '');
    setStreaming(true);
    ctrl = new AbortController();
    let started = false; // 收到 start 帧 = 上游已接受、用户消息已落库
    let gotDone = false; // 收到 done 帧 = 服务端已确认完整回复
    let assistantBox = null;
    let acc = '';
    // ⭐ 3 期：写工具的提议随 `done` 帧下来（服务端从不落库，等用户点确认）。
    //    攒在这里、收尾后再交给端去开确认卡 —— 本视图拿不到 `host`（没有弹层能力）。
    let proposalItems = null;
    try {
      const res = await fetch(`${BASE}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⚠️⭐ 没带图、没带卡片时请求体与 2 期**逐字相同**（⛔ 别写成 `{content, image: null}`）——
        //    「没用图片时出网内容一个字不变」是一条既有承诺，`ai.test.js` 拿假上游抓请求体钉着它。
        body: JSON.stringify(
          card ? { content, card: { kind: 'task_card', meta: card } } : image ? { content, image } : { content },
        ),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error((j && j.error) || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frameText = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frameText.split('\n')) {
            const m = /^data:\s?(.*)$/.exec(line.trim());
            if (!m) continue;
            let f = null;
            try {
              f = JSON.parse(m[1]);
            } catch (_e) {
              continue; // 坏帧当不存在
            }
            if (f.type === 'start') {
              started = true;
              // ⭐ 0.8.55：用户消息已落库 ⇒ 把那张本地 data: 预览换成同源地址（CSP 只放行 'self'）
              if (image && f.userMessageId) swapImageSrc(userB, `${BASE}/api/ai/messages/${Number(f.userMessageId)}/image`);
              assistantBox = bubble('assistant', '');
              assistantBox.firstChild.classList.add('ai-streaming');
            } else if (f.type === 'delta' && assistantBox) {
              acc += f.text || '';
              assistantBox.firstChild.textContent = acc;
              scrollEnd();
            } else if (f.type === 'done') {
              gotDone = true;
              if (assistantBox) {
                assistantBox.firstChild.classList.remove('ai-streaming');
                // ⭐ 0.7.6：收尾这一拍把整条回复重画成**渲染后的 DOM**（流式期间一直是纯文本）
                paintMd(assistantBox.firstChild, acc);
              }
              // ⭐ 2 期：把「这一次到底带了什么」写在输入框下方。
              //    ⚠️ 四个数取自服务端实际拼进请求的那一组消息，前端不算、不估。
              if (f.used) renderUsage(f.used);
              // ⭐ 3 期：写工具的提议（数组，**可选字段** —— 没有提议时这一帧与 2 期逐字相同）。
              //    去重是服务端做的（同轮按「标题 + 截止日期」），前端原样收。
              // ⭐ 0.7.7-⑲：服务端现在还会带 `card`（**落库之后**的那张确认卡）—— 有它就**在会话流里**
              //    画卡（要的形态），不再开那张模态确认卡；`proposals` 只作为老服务端的兼容回落。
              if (f.card && cardMsg(f.card)) proposalItems = null;
              else if (Array.isArray(f.proposals) && f.proposals.length) proposalItems = f.proposals;
            } else if (f.type === 'error') {
              throw new Error(f.message || 'AI 接口出错了');
            }
          }
        }
      }
      // 流断了但两个收尾帧都没来 —— 按失败处理，绝不把半截话当好答案
      if (started && !gotDone) throw new Error('连接中断了，这段回复没有保存');
      // ⭐ 3 期：写工具的提议交给**端**去开确认卡（本视图没有弹层能力）。
      //    走留白事件而不是直接调 `host.openForm`：`createAiThreadView()` 不接 host，
      //    而两端的 `bindTeamworkMsgMenuHook(host)` 手里已经拿全了 toast / openForm ⇒
      //    电脑端与手机端**都**通，且两端文件一行都不用改。
      //    ⚠️ 只在**真的成功收尾**时才发：失败的那一轮提议不作数，别让用户对着半截话点确认。
      if (proposalItems) {
        document.dispatchEvent(
          new CustomEvent('zx:ai-proposals', { detail: { proposals: proposalItems, fromTool: true } }),
        );
      }
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      if (!started) {
        // 什么都没发生：撤掉乐观气泡，文本原样退回输入框
        userB.remove();
        if (!msgsBox.querySelector('.teamwork-msg')) emptyBox.hidden = false;
        if (!aborted) {
          inputBox.value = content;
          // ⭐ 0.7.7-⑭：退回的文本可能有好几行 ⇒ 高度得跟着长回去，否则字被压在框里看不见
          autoGrow(inputBox);
          errorLine(e && e.message ? e.message : '请求失败');
        }
      } else {
        // 那一轮已经发生：残段保留并注明，错误行带「再试一次」（重发 = 新的一轮）
        if (assistantBox) {
          assistantBox.firstChild.classList.remove('ai-streaming');
          if (acc) {
            // ⭐ 0.7.6：残段同样重画成渲染后的 DOM（与正常收尾同一口径，否则半截话会留下裸星号）
            paintMd(assistantBox.firstChild, acc);
            const st = el('div', 'ai-msg-state');
            st.textContent = aborted ? '已停止 —— 这段回复没有保存' : '这段回复没有保存';
            assistantBox.appendChild(st);
          } else {
            assistantBox.remove();
          }
        }
        if (!aborted) errorLine(e && e.message ? e.message : '请求失败', () => sendText(content, image, card));
      }
    } finally {
      setStreaming(false);
      ctrl = null;
      scrollEnd();
    }
  }

  // ⭐ 插槽会话被关掉（或切到别的屏导致容器被卸载）时：停掉在途的流式请求，监听器自摘。
  //    服务端会跟着掐掉上游请求（30 秒总时长闸门），已落库的用户消息不会丢。
  const onClose = (e) => {
    if (!e || !e.detail || e.detail.key !== AI_CONV_KEY) return;
    document.removeEventListener('zx:teamwork-conv-close', onClose);
    if (ctrl) ctrl.abort();
  };
  document.addEventListener('zx:teamwork-conv-close', onClose);
  sendBtn.addEventListener('click', () => {
    if (streaming) {
      // ⭐ 停止是常驻控制：点了立刻改界面（乐观），服务端随后把上游请求一并掐掉
      if (ctrl) ctrl.abort();
      return;
    }
    sendFromComposer();
  });
  inputBox.addEventListener('keydown', (e) => {
    // Enter 发送、Shift+Enter 换行（与主流聊天框同一习惯；手机上软键盘自带换行键）。
    // ⚠️ 发送中必须忽略：此时点「发送」按钮是「停止」，回车不该把它误触发成停止。
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !streaming) {
      e.preventDefault();
      sendFromComposer();
    }
  });
  // ⭐ 0.7.7-⑭：输入即自增高（⚠️ 别只挂在 keydown 上：粘贴 / 语音输入 / 脚本赋值都不发 keydown）
  inputBox.addEventListener('input', () => autoGrow(inputBox));

  // ⭐⭐ 0.8.55：圆圈 ＋ —— 与好友聊天同一套菜单、三项同一顺序（图片 / 协作项目任务 / 普通任务）。
  //    ⚠️ 图片：选了就发（不再有预览条）；任务：借宿主的**同一个选择器**（留白事件），
  //    选中后把那张卡片当一条用户消息发给 AI —— 它会读到任务并回答。
  plusBtn.addEventListener('click', () => {
    if (root.querySelector('[data-ai-send-menu]')) closeHostPopover();
    else openAiSendMenu();
  });
  picFile.addEventListener('change', () => onPickImage());
  // 菜单里的三项（委托挂在 root 上：菜单是后插进来的节点）
  root.addEventListener('click', (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest('[data-ai-send]') : null;
    if (!btn || btn.disabled) return;
    const act = String(btn.dataset.aiSend || '');
    closeHostPopover();
    if (act === 'image') {
      if (!visionOn) return errorLine('「支持图片输入」这项能力没开 —— 到「AI 设置」里打开它才能发图。');
      if (streaming) return;
      return void picFile.click();
    }
    if (act === 'collab' || act === 'daily') return void pickTaskForAi(act);
  });

  // ⚠️ 「能不能发图」**以服务端为准**（配置屏与提示词用的都是它那一处口径）；读不到就按「没开」画
  //    —— 失败方向安全：宁可置灰，也不给一颗点了会被服务端 400 的按钮。
  api('GET', '/api/ai/config')
    .then((cfg) => {
      visionOn = !!(cfg && cfg.vision);
    })
    .catch(() => {
      visionOn = false;
    });

  // ⭐ 挂载即取历史：插槽会话只在「点开它」时才挂载，进场就该看到历史（以前是「展开面板」那一拍才拉）
  loadHistory();
  // ⭐ 0.7.6：段进度句也一并读（它就在这一屏顶上，进场就该是准的）
  loadSeg().catch(() => {});
  return root;
}

// ================================================================ 消息菜单 → 指挥 AI 建任务

/**
 * 功能：往对话模块的消息菜单里添「🤖 问 AI / 记成任务」（`zx:teamwork-msg-menu` 留白事件的消费端）。
 *
 * 说明：⭐ **只挂一次**（模块级标记）：片段每次进对话页都会重新渲染，事件监听不能跟着重复挂，
 *        否则菜单里会多出几条一样的项。⚠️ 片段只在模块开着时才会被挂载，
 *        所以监听器存在 = 功能开着 —— 关掉后菜单自然恢复两项，不需要额外判断。
 *
 * @param {Object} host - 端注入：`openForm(opts)`（见 `runExtractFlow`）与 `toast`
 * @returns {void}
 */
export function bindTeamworkMsgMenuHook(host) {
  if (bindTeamworkMsgMenuHook._bound) return;
  bindTeamworkMsgMenuHook._bound = true;
  document.addEventListener('zx:teamwork-msg-menu', (e) => {
    const detail = e && e.detail;
    if (!detail || !detail.msg || !Array.isArray(detail.items)) return;
    detail.items.push({
      key: 'ai-extract',
      label: '🤖 问 AI / 记成任务',
      run: () => runExtractFlow(detail.msg, host),
    });
  });
  // ⭐ 3 期：AI **自己**提议建任务（写工具 `tasks.propose_create` 的产物随 `done` 帧下来）
  //    —— 在这里开确认卡。会话视图（`createAiThreadView()`）不接 host，所以它把提议发成
  //    这个留白事件，由已经拿全 host 的这里收口；两端因此都通，且两端文件都不用改。
  //    ⚠️ 与「被点消息 → 记成任务」**共用同一张卡**，只是卡上多一句「由 AI 提议（可改）」；
  //    落库依旧**逐条确认**、走 `core/task-create.js`（任务创建的唯一入口）。
  document.addEventListener('zx:ai-proposals', (e) => {
    const list = e && e.detail && Array.isArray(e.detail.proposals) ? e.detail.proposals : null;
    if (!list || !list.length) return;
    openConfirmCard(list, 0, host, true);
  });
}

/**
 * 功能：预览层的正文 HTML —— 顶部**逐字展示将要发出去的原文**（发送前看得到，方案 §八-9），
 *      下面一个可选的补充输入框。
 * @param {string} sourceBody - 被点的消息原文
 * @returns {string} HTML
 */
export function extractPreviewHtml(sourceBody) {
  return `
    <div class="ai-warn">发送前请确认：下面这段内容会离开 NAS，发给你自己配置的 AI 接口。</div>
    <div class="ai-f"><label class="ai-f-label">将发送的内容</label><pre class="ai-preview-src">${esc(sourceBody)}</pre></div>
    <div class="ai-f"><label class="ai-f-label">补充给 AI 的话（可不填）</label>
      <textarea class="ai-input" data-ai="sup" rows="3" maxlength="${MAX_AI_TEXT}" placeholder="例如：只要今天要做的事；负责人是我…"></textarea></div>`;
}

/**
 * 功能：确认卡的正文 HTML —— **每条提议一个可编辑的块**，各自带一枚「添加到任务」。
 *
 * 说明：归属下拉在这里只有「日常任务」一项，项目选项由 `bindConfirmCard()` 拉到清单后补上
 *      （HTML 与数据分离：模板不依赖拉取时序）。
 *      ⭐ 3 期：这条卡现在**两个来源共用** —— ① 被点消息的「让 AI 记成任务」（`extract`）；
 *      ② AI 自己提议建任务（写工具 `tasks.propose_create`，提议随 `done` 帧下来）。
 *      两者的条目字段略有不同（`extract` 给 `priority`/`note`/`assignee`，写工具给
 *      `important`/`urgent`/`scope`），所以这里两套都认、不要求调用方先归一。
 *
 * @param {Array.<{title: string, assignee?: string, due?: string, priority?: string, note?: string,
 *     important?: (number|boolean), urgent?: (number|boolean), scope?: (string|number)}>} tasks - AI 提议
 * @param {Object} [opts] - 可选项
 * @param {boolean} [opts.byAi] - 由**写工具**提议的（卡上写明「由 AI 提议（可改）」）
 * @returns {string} HTML
 */
export function confirmCardHtml(tasks, opts) {
  const o = opts || {};
  const warn = o.byAi
    ? '由 AI 提议（可改）：AI 的提议可能有错，每一条都能改，确认一条加一条；「归属」决定它进日常任务还是某个项目。'
    : 'AI 的提议可能有错：每一条都能改，确认一条加一条；「归属」决定它进日常任务还是某个项目。';
  return `
    <div class="ai-warn">${warn}</div>
    ${tasks
      .map((t, i) => {
        // ⚠️ 两套优先级口径都认：`extract` 给「高/中/低」，写工具直接给两轴布尔值。
        //    ⛔ 别在写工具那条路上反推一个「高/中/低」出来 —— 四象限才是源，优先级是它的说法。
        const flags = PRIORITY_FLAGS[t.priority] || { important: !!t.important, urgent: !!t.urgent };
        const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due) && t.due >= todayStr() ? t.due : todayStr();
        return `
    <div class="ai-task" data-ai-task="${i}" data-ai-scope="${esc(t.scope == null ? 'daily' : t.scope)}">
      <div class="ai-f"><label class="ai-f-label">归属</label>
        <select class="ai-input" data-f="scope">
          <option value="daily">日常任务</option>
        </select></div>
      <div class="ai-f"><label class="ai-f-label">标题</label>
        <input class="ai-input" data-f="title" value="${esc(t.title)}" maxlength="100" /></div>
      <div class="ai-row2">
        <div class="ai-f" data-f-wrap="assignee"><label class="ai-f-label">负责人</label>
          <input class="ai-input" data-f="assignee" value="${esc(t.assignee)}" maxlength="50" /></div>
        <div class="ai-f"><label class="ai-f-label">截止日期</label>
          <input class="ai-input" type="date" data-f="due" value="${esc(due)}" min="${esc(todayStr())}" /></div>
      </div>
      <div class="ai-checks">
        <label><input type="checkbox" data-f="important" ${flags.important ? 'checked' : ''} /> 重要</label>
        <label><input type="checkbox" data-f="urgent" ${flags.urgent ? 'checked' : ''} /> 紧急</label>
      </div>
      <div class="ai-f"><label class="ai-f-label">备注</label>
        <textarea class="ai-input" data-f="note" rows="2" maxlength="1000">${esc(t.note)}</textarea></div>
      <div class="ai-task-foot">
        <button class="ai-btn ai-btn-primary" type="button" data-ai-add="${i}">添加到任务</button>
        <span class="ai-task-state" data-ai-state="${i}"></span>
      </div>
    </div>`;
      })
      .join('')}`;
}

/**
 * 功能：给确认卡绑上行为 —— 归属联动（日常任务没有负责人）与逐条落库（走既有任务接口）。
 *
 * 说明：⚠️ 日常任务表没有负责人列（`checkDailyTask` 不认），选「日常任务」时负责人栏必须收起来；
 *      ⚠️ 落库成功把该块置灰成「✓ 已添加」，绝不替用户连加多条 —— 一条一次确认。
 *
 * @param {HTMLElement} root - 确认卡的容器（弹层正文）
 * @param {Object} opts - 上下文
 * @param {Array.<Object>} opts.tasks - AI 提议（`/api/ai/extract` 的 `tasks`）
 * @param {number} opts.sourceMsgId - 来源对话消息 id（0 = 不是从对话消息来的，不带溯源）
 * @param {{toast: Function, onCreated: Function}} host - 端注入：toast 与「加完刷一下项目侧栏」
 * @returns {Promise.<void>}
 */
export async function bindConfirmCard(root, opts, host) {
  let projects = [];
  try {
    projects = (await api('GET', '/api/projects')) || [];
  } catch (_e) {
    // 拉不到项目就只给「日常任务」一个选项，不拦确认卡（projects 保持空数组）
  }
  // 归属下拉补上项目（模板里只有「日常任务」一项，项目选项在清单到手后追加）
  for (const sel of root.querySelectorAll('select[data-f="scope"]')) {
    for (const p of projects) {
      const o = document.createElement('option');
      o.value = String(Number(p.id));
      o.textContent = `${p.icon || '📁'} ${p.name || ''}`.trim();
      sel.appendChild(o);
    }
    // ⭐ 3 期：AI 提议里带了归属就替用户**预选**上（用户仍可改）。
    //    ⚠️ 只在自己名下的项目才预选 —— 模型给了一个不属于自己的项目 id 时，
    //    那个 option 根本不存在，select 自然回落「日常任务」，⛔ 不会静默换成别人的项目。
    const blk = sel.closest('[data-ai-task]');
    const want = blk ? blk.dataset.aiScope : '';
    if (want && want !== 'daily' && [...sel.options].some((op) => op.value === want)) sel.value = want;
  }
  const toast = host && host.toast ? host.toast : () => {};
  for (const block of root.querySelectorAll('[data-ai-task]')) {
    const idx = Number(block.dataset.aiTask);
    const t = opts.tasks[idx];
    if (!t) continue;
    const scopeSel = block.querySelector('select[data-f="scope"]');
    const syncScope = () => {
      const wrap = block.querySelector('[data-f-wrap="assignee"]');
      if (wrap) wrap.hidden = scopeSel.value === 'daily';
    };
    scopeSel.addEventListener('change', syncScope);
    syncScope();
    const addBtn = block.querySelector(`[data-ai-add="${idx}"]`);
    addBtn.addEventListener('click', async () => {
      const f = (name) => block.querySelector(`[data-f="${name}"]`);
      const title = f('title').value.trim();
      const due = f('due').value;
      if (!title) {
        toast('任务标题不能是空的', true);
        f('title').focus();
        return;
      }
      if (!due) {
        toast('请选择截止日期', true);
        return;
      }
      const scope = scopeSel.value;
      const common = {
        title,
        start_date: todayStr(),
        due_date: due,
        important: f('important').checked ? 1 : 0,
        urgent: f('urgent').checked ? 1 : 0,
        status: 'todo',
        ...(Number(opts.sourceMsgId) ? { from_message_id: Number(opts.sourceMsgId) } : {}),
      };
      addBtn.disabled = true;
      try {
        // ⭐ 0.7.1：统一走「任务创建」的对外入口（两套字段名它都认，调用方不必记得自己是哪一套）
        await createTask(scope, {
          ...common,
          content: f('note').value.trim(),
          assignee: f('assignee').value.trim(),
        });
        const state = block.querySelector(`[data-ai-state="${idx}"]`);
        if (state) state.textContent = '✓ 已添加';
        addBtn.textContent = '已添加';
        toast('已添加到任务');
        if (host && host.onCreated) host.onCreated();
      } catch (e) {
        addBtn.disabled = false;
        toast(e.message, true);
      }
    });
  }
}

/**
 * 功能：「问 AI / 记成任务」的完整流程 —— 预览 → 发送 → 确认卡。
 *
 * 说明：⭐ 弹层容器由端注入（`host.openForm`）：桌面 = 通用模态框，手机 = 底部弹层。
 *      `openForm({ title, bodyHtml, saveLabel, onSave })` 里 `onSave(close)` 的 `close`
 *      由调用方收下，先 `close()` 再开下一层（预览 → 确认卡是两次弹层）。
 *      ⚠️ 发送期间主按钮**禁用并写明在等什么** —— 出网要几秒，空白按钮最像卡死。
 *
 * @param {Object} msg - 被点的对话消息（`zx:teamwork-msg-menu` 的 `detail.msg`，至少有 `id` 与 `body`）
 * @param {{toast: Function, onCreated?: Function, openForm: Function}} host - 端注入
 * @returns {void}
 */
export function runExtractFlow(msg, host) {
  const body = String(msg && msg.body ? msg.body : '');
  let busy = false;
  host.openForm({
    title: '让 AI 记成任务',
    bodyHtml: extractPreviewHtml(body),
    saveLabel: '发送给 AI',
    onSave: async (close) => {
      const supEl = document.querySelector('[data-ai="sup"]');
      const text = supEl ? supEl.value.trim() : '';
      if (busy) return;
      busy = true;
      try {
        const r = await api(
          'POST',
          '/api/ai/extract',
          { messageId: Number(msg.id), ...(text ? { text } : {}) },
          { timeout: 90000 }, // 服务端总闸 30 秒 —— 前端上界放宽到 90 秒，让服务端的错误话术先到
        );
        close();
        if (!r.tasks || !r.tasks.length) {
          host.toast('AI 没有从这段话里认出任务，可以试试补充一句话再发', true);
          return;
        }
        openConfirmCard(r.tasks, Number(msg.id), host);
      } catch (e) {
        busy = false;
        host.toast(e.message, true);
        // 主按钮还原，允许改一改再发
        const btn = document.querySelector('#modal-save, #sheet-foot [data-ai-save]');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '发送给 AI';
        }
      }
    },
  });
}

/**
 * 功能：确认卡层（预览发送成功后 / AI 自己提议建任务时）—— 把提议变成可编辑的块，逐条确认落库。
 * @param {Array.<Object>} tasks - AI 提议
 * @param {number} sourceMsgId - 来源对话消息 id（0 = 无来源）
 * @param {{toast: Function, onCreated?: Function, openForm: Function}} host - 端注入
 * @param {boolean} [byAi] - 来自**写工具**（卡上标明「由 AI 提议（可改）」）
 * @returns {void}
 */
function openConfirmCard(tasks, sourceMsgId, host, byAi) {
  host.openForm({
    title: `确认添加到任务（${tasks.length} 条提议）`,
    bodyHtml: confirmCardHtml(tasks, { byAi: !!byAi }),
    saveLabel: '完成',
    onSave: (close) => close(),
    onRendered: async (root) => {
      await bindConfirmCard(root, { tasks, sourceMsgId }, host);
    },
  });
}

// ================================================================ 0.7.7-⑲：会话流里的「任务确认卡」
//
// ⭐ 与上面那张**模态确认卡**是两条路，别混：
//   · 模态卡（`confirmCardHtml()` / `bindConfirmCard()`）= 用户**主动**点一条消息、让 AI「记成任务」
//     那条路（右键菜单里的选择）—— 保留原样（用户本来就是去看那张卡的）。
//   · 会话流里的这张卡 = AI **自己**在会话里提议建任务 —— 「AI 整理后在聊天框里发出
//     一张卡，卡下方有拒绝和同意」。
// ⚠️ 两条路的**建任务入口仍是同一个** `core/task-create.js`。

/** 确认卡的消息种类（`ai_messages.kind`）—— 与服务端 `store.js` 的 `KIND_TASK_PROPOSAL` 同值 @type {string} */
export const PROPOSAL_KIND = 'task_proposal';

/** ⭐ 0.8.4：记账确认卡的消息种类 —— 与服务端 `store.js` 的 `KIND_LEDGER_PROPOSAL` 同值 @type {string} */
export const LEDGER_PROPOSAL_KIND = 'ledger_proposal';

/** ⭐ 0.8.5：收藏确认卡 —— 与服务端 `store.js` 的 `KIND_BOOKMARKS_PROPOSAL` 同值 @type {string} */
export const BOOKMARKS_PROPOSAL_KIND = 'bookmarks_proposal';

/** ⭐ 0.8.5：随手记确认卡 —— 与服务端 `store.js` 的 `KIND_IDEA_PROPOSAL` 同值 @type {string} */
export const IDEA_PROPOSAL_KIND = 'idea_proposal';

/** ⭐ 0.8.5：硬件确认卡 —— 与服务端 `store.js` 的 `KIND_HARDWARE_PROPOSAL` 同值 @type {string} */
export const HARDWARE_PROPOSAL_KIND = 'hardware_proposal';

/** ⭐ 0.8.6：车票确认卡（行程模块）—— 与服务端 `store.js` 的 `KIND_TRIP_PROPOSAL` 同值 @type {string} */
export const TRIP_PROPOSAL_KIND = 'trip_proposal';

/** ⭐⭐ 0.8.55：资产确认卡 —— 与服务端 `store.js` 的 `KIND_ASSETS_PROPOSAL` 同值 @type {string} */
export const ASSETS_PROPOSAL_KIND = 'assets_proposal';

/** ⭐⭐ 0.8.55：日程确认卡 —— 与服务端 `store.js` 的 `KIND_CALENDAR_PROPOSAL` 同值 @type {string} */
export const CALENDAR_PROPOSAL_KIND = 'calendar_proposal';

/** 八种确认卡（判据的唯一出处）。 @type {Array.<string>} */
const PROPOSAL_KINDS = [
  PROPOSAL_KIND,
  LEDGER_PROPOSAL_KIND,
  BOOKMARKS_PROPOSAL_KIND,
  IDEA_PROPOSAL_KIND,
  HARDWARE_PROPOSAL_KIND,
  TRIP_PROPOSAL_KIND,
  ASSETS_PROPOSAL_KIND,
  CALENDAR_PROPOSAL_KIND,
];

/**
 * 功能：判断一条消息是不是**确认卡**（任务 / 记账 / 收藏 / 随手记 / 硬件 / 车票 / 资产 / 日程 八种）。
 *
 * 说明：⭐ 判据只写这一处（与服务端 `store.js` 的 `isProposalKind()` 是**同一份契约的两端**）：
 *      ⛔ 别在渲染代码里再写一遍 `=== 'task_proposal' || === 'ledger_proposal' || …` ——
 *      漏一处就是「卡画不出来、且不报错」（历史消息退回成一行降级文本）。
 * @param {*} kind - `ai_messages.kind` 的值
 * @returns {boolean} 是确认卡返回 true
 */
export function isProposalMsgKind(kind) {
  return PROPOSAL_KINDS.includes(String(kind == null ? '' : kind));
}

/** 一次同意最多加几条（**可见地拒绝**，⛔ 不静默截断）—— 与服务端写工具的条数水位同一量级 @type {number} */
const MAX_AI_PROPOSAL_ITEMS = 20;

/** 一次同意最多记几笔账 —— 与服务端 `tools-write.js` 的 `PROPOSE_ENTRY_MAX` 同值（改一处必须改另一处） @type {number} */
const MAX_AI_LEDGER_ITEMS = 10;

/**
 * ⭐ 0.8.5：收藏 / 随手记 / 硬件 三条各自的「一次同意最多几条」——
 * ⚠️ **必须与服务端 `tools-write.js` 的 `PROPOSE_BM_MAX` / `PROPOSE_IDEA_MAX` / `PROPOSE_HW_MAX` 同值**
 * （两边各写一份是刻意的：前端要**可见地拒绝**，服务端要独立挡请求 —— 改一处必须改另一处）。
 * @type {number}
 */
const MAX_AI_BOOKMARK_ITEMS = 10;
/** 同上（随手记）。 @type {number} */
const MAX_AI_IDEA_ITEMS = 10;
/** 同上（硬件 —— 它与服务端一样只有 5：字段最多，一条要核的东西顶三条任务）。 @type {number} */
const MAX_AI_HARDWARE_ITEMS = 5;

/**
 * 同上（车票 —— ⚠️ **与服务端 `tools-write.js` 的 `PROPOSE_TRIP_MAX` 同值**）。
 * 一张票要核的东西不比硬件少，而且**转机换乘算两张票** ⇒ 一次只让它整理一段行程。
 * @type {number}
 */
const MAX_AI_TRIP_ITEMS = 5;

/**
 * 同上（资产 / 日程 —— ⚠️ **与服务端 `tools-write.js` 的 `PROPOSE_ASSET_MAX` /
 * `PROPOSE_EVENT_MAX` 同值**）。两者都是 10：字段少，但日程错一天就是白跑一趟。
 * @type {number}
 */
const MAX_AI_ASSET_ITEMS = 10;
/** 同上（日程）。 @type {number} */
const MAX_AI_EVENT_ITEMS = 10;

/**
 * 功能：把卡片快照里的一条**任务**提议画成一行 —— ⭐ **只读**（编辑权交给 AI，这正是「拒绝 ⇒ 我继续修改」的意义）。
 * @param {Object} it - 快照条目
 * @returns {string} HTML（用户 / 模型给的文字一律 `esc()`）
 */
function proposalItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const flags = [];
  if (Number(s.important)) flags.push('重要');
  if (Number(s.urgent)) flags.push('紧急');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(s.due || '')) ? String(s.due) : '';
  const bits = [];
  if (due) bits.push(`截止 ${due}`);
  if (flags.length) bits.push(flags.join(' · '));
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(String(s.title || '（这条没有标题）'))}</div>` +
    (bits.length ? `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` : '') +
    (s.note ? `<div class="ai-prop-note">${esc(String(s.note))}</div>` : '') +
    `</div>`
  );
}

/**
 * 功能：把卡片快照里的一条**记账**提议画成一行（0.8.4）—— 同样是**只读**的。
 *
 * 说明：⚠️ 三处刻意的写法：
 *      · 金额取服务端算好的 `amount`（**前端不算钱**，项目 一族）—— 缺了才退回用 `amount_fen`
 *        除 100（只在老数据 / 手工构造的快照上会发生）；
 *      · 分类 / 账户**解析不到时把模型的原话带出来**（`category_want` / `account_want`）——
 *        用户点确认之前就该看见「它想记到『餐饮』，本机没这个分类，会记成未分类」；
 *      · 日期只显示到天（`at` 是 `YYYY-MM-DD HH:MM:SS`，时刻那半截在卡上没用）。
 * @param {Object} it - 快照条目
 * @returns {string} HTML（模型给的文字一律 `esc()`）
 */
function ledgerItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const fen = Math.trunc(Number(s.amount_fen)) || 0;
  const amount = String(s.amount || '') || (fen / 100).toFixed(2);
  const ie = String(s.ie || '') === '收入' ? '收入' : '支出';
  const day = /^\d{4}-\d{2}-\d{2}/.test(String(s.at || '')) ? String(s.at).slice(0, 10) : '';
  const cat = String(s.category_name || '').trim();
  const want = String(s.category_want || '').trim();
  const acct = String(s.account_name || '').trim();
  const wantAcct = String(s.account_want || '').trim();
  const bits = [`${ie} ${amount} 元`];
  if (day) bits.push(day);
  bits.push(cat ? `分类 ${cat}` : want ? `分类未匹配（AI 说的是「${want}」）` : '未分类');
  if (acct) bits.push(`账户 ${acct}`);
  else if (wantAcct) bits.push(`账户未匹配（AI 说的是「${wantAcct}」）`);
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(cat || want || '一笔账')}</div>` +
    `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` +
    (s.note ? `<div class="ai-prop-note">${esc(String(s.note))}</div>` : '') +
    `</div>`
  );
}

/**
 * 功能：把卡片快照里的一条**收藏**提议画成一行（0.8.5）—— 只读。
 *
 * 说明：⚠️ 两处刻意的写法：
 *      · 网址**完整显示**：这张卡是给**用户自己**核对用的 —— ⛔ 与「发给模型的那一份」不同
 *        （出网那一侧只给域名，见 `lib/tools-read.js` 的 `hostOf()`）；
 *      · `dup`（服务端拿库里的网址核过）**必须显眼写出来**：用户点确认之前就该知道
 *        「这条已经收藏过了，点了也不会重复写入」，而不是点完才吃一个 400。
 * @param {Object} it - 快照条目
 * @returns {string} HTML（模型给的文字一律 `esc()`）
 */
function bookmarkItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const url = String(s.url || '');
  const title = String(s.title || '').trim();
  const tags = (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t)).filter(Boolean);
  const bits = [];
  // 有标题时网址退到 meta 里；没标题时它自己就是主行（见下面的 title 表达式）
  if (title) bits.push(url);
  bits.push(tags.length ? `分类 ${tags.join(' / ')}` : '未分类');
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(title || url || '（这条没写网址）')}</div>` +
    `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` +
    (s.dup ? `<div class="ai-prop-note">⚠️ 这条网址已经收藏过了 —— 点同意也不会重复写入</div>` : '') +
    `</div>`
  );
}

/**
 * 功能：把卡片快照里的一条**随手记**提议画成一行（0.8.5）—— 只读。
 *
 * 说明：⚠️ 正文**压成一行、截到 100 字**再显示：这张卡是让人**扫一眼核对**的，不是阅读器 ——
 *      快照里存的是全文，落库落的也是全文（⛔ 这里截的只是**显示**）。
 * @param {Object} it - 快照条目
 * @returns {string} HTML
 */
function ideaItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const tag = String(s.tag || '').trim();
  const flat = String(s.content || '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(flat.slice(0, 100) || '（这条没写正文）')}</div>` +
    (tag ? `<div class="ai-prop-meta">${esc('标签 #' + tag)}</div>` : '') +
    `</div>`
  );
}

/**
 * 功能：把卡片快照里的一条**硬件**提议画成一行（0.8.5）—— 只读。
 *
 * 说明：⚠️ 只画**这张卡上真有的那几样**（服务端提议里本来就没有序列号 / 位置 / 详细内容，
 *      见 `lib/tools-write.js` 的 `proposeHardware()`）—— ⛔ 不在这里补一个「未填」出来。
 * @param {Object} it - 快照条目
 * @returns {string} HTML
 */
function hardwareItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const st = { owned: '在用', wishlist: '想买', retired: '已退役' }[String(s.status || '')] || '在用';
  const bits = [st];
  for (const k of ['category', 'model', 'capacity', 'purpose']) {
    const v = String(s[k] || '').trim();
    if (v) bits.push(v);
  }
  const day = String(s.purchase_date || '').trim();
  if (day) bits.push(day);
  const price = String(s.purchase_price || '').trim();
  if (price) bits.push(`${price} 元`);
  const life = String(s.expected_life_months || '').trim();
  if (life) bits.push(`预期寿命 ${life} 个月`);
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(String(s.name || '') || '（这件没写名称）')}</div>` +
    `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` +
    `</div>`
  );
}

/**
 * ⭐ 0.8.6：车票确认卡的条目渲染。
 *
 * 说明：⚠️⭐ **`bad` 那一行必须显示出来**：服务端认出「出发时刻没看懂 / 缺站名」时会标 `bad:true`
 *      并给一句 `why` —— 卡上不显示的话，用户点「同意」只会看到「有 N 张没能加上」，
 *      却**不知道为什么**。而这一条恰恰是「⛔ 不猜一个时间」那条纪律的可见面。
 *      ⚠️ 票型归一化成 `other` 而模型原本说了别的（`kind_want`）时，也把那句话带出来 ——
 *      与记账「它想记到『餐饮』，本机没有这个分类」同一个手法。
 *
 * @param {Object} it - 卡片快照里的一张票
 * @returns {string} HTML
 */
function tripItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const names = { train: '火车', highspeed: '高铁', flight: '飞机', bus: '汽车', ship: '船', other: '其它' };
  const kind = names[String(s.kind || '')] || '其它';
  const head = [String(s.code || '').trim(), `${String(s.from || '')} → ${String(s.to || '')}`]
    .filter(Boolean)
    .join(' ');
  const bits = [kind];
  const when = String(s.depart || '').trim();
  if (when) bits.push(when);
  const seat = String(s.seat || '').trim();
  if (seat) bits.push(seat);
  const gate = String(s.gate || '').trim();
  if (gate) bits.push(`检票口 ${gate}`);
  const want = String(s.kind_want || '').trim();
  const wantLine = want && String(s.kind || '') === 'other' ? `它说的是「${want}」` : '';
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(head || '（这张票没写站名）')}</div>` +
    `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` +
    (wantLine ? `<div class="ai-prop-meta">${esc(wantLine)}</div>` : '') +
    (s.bad ? `<div class="ai-prop-note">⚠️ ${esc(String(s.why || '这一条没看懂，请你补一下'))}</div>` : '') +
    `</div>`
  );
}

/**
 * ⭐ 0.8.55：资产条目 —— 名称 / 分组 / 金额（分 → 元）/ 日期；`bad` 时写明为什么。
 * @param {Object} it - 卡片里的一条
 * @returns {string} HTML
 */
function assetItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const bits = [];
  // ⚠️ 分组名可能是空（模型没说 / 本机没有那个分组）—— 后一种情况下面单独一行说清楚
  const group = String(s.group_name || '').trim();
  if (group) bits.push(group);
  // ⚠️ 金额单位是**分**（与记账同一个口径）：卡上给人看的一律换成元
  const fen = s.amount_fen;
  if (fen !== null && fen !== undefined && fen !== '') {
    const yuan = Number(fen) / 100;
    bits.push(`¥${Number.isFinite(yuan) ? yuan.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'}`);
  }
  const date = String(s.date || '').trim();
  if (date) bits.push(date);
  const want = String(s.group_want || '').trim();
  const wantLine = want && !group ? `它想放到「${want}」，但本机没有这个分组 —— 会记成未分组` : '';
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(String(s.name || '').trim() || '（这条没写名称）')}</div>` +
    (bits.length ? `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` : '') +
    (wantLine ? `<div class="ai-prop-meta">${esc(wantLine)}</div>` : '') +
    (s.bad ? `<div class="ai-prop-note">⚠️ ${esc(String(s.why || '这一条没看懂，请你补一下'))}</div>` : '') +
    `</div>`
  );
}

/**
 * ⭐ 0.8.55：日程条目 —— 标题 / 日期（含跨天）/ 时刻（全天时写明「全天」）。
 * @param {Object} it - 卡片里的一条
 * @returns {string} HTML
 */
function eventItemHtml(it) {
  const s = it && typeof it === 'object' ? it : {};
  const date = String(s.date || '').trim();
  const endDate = String(s.end_date || '').trim();
  const bits = [endDate && endDate !== date ? `${date} → ${endDate}` : date].filter(Boolean);
  if (s.all_day) bits.push('全天');
  else {
    const st = String(s.start_time || '').trim();
    const en = String(s.end_time || '').trim();
    if (st) bits.push(en ? `${st}–${en}` : st);
  }
  return (
    `<div class="ai-prop-item">` +
    `<div class="ai-prop-title">${esc(String(s.title || '').trim() || '（这条没写标题）')}</div>` +
    (bits.length ? `<div class="ai-prop-meta">${esc(bits.join(' · '))}</div>` : '') +
    (s.bad ? `<div class="ai-prop-note">⚠️ ${esc(String(s.why || '这一条没看懂，请你补一下'))}</div>` : '') +
    `</div>`
  );
}

/**
 * ⭐ 0.8.5：五种确认卡各自的**卡头 / 量词 / 结论词 / 条目画法** —— 表驱动，
 * 加一种卡只加一行（⛔ 别在渲染代码里再摊一串 if）。
 *
 * 说明：⚠️ 落库函数（`createProposalTasks` 那几个）**不在**这张表里：它们住在会话闭包内
 *      （要用 `own` / `api` 那些上下文），而这张表在模块级 —— 两张表各管一段，见 `resolveProposal`。
 *      ⚠️ 文案刻意与 0.8.4 那两句**逐字一致**（改文案要一起改测试里那几条断言）。
 * @type {Object.<string, {head: string, unit: string, done: string, verb: string, paint: Function}>}
 */
const PROPOSAL_UI = {
  [PROPOSAL_KIND]: { head: '任务确认卡', unit: '条', done: '已加入任务', verb: '加上', paint: proposalItemHtml },
  [LEDGER_PROPOSAL_KIND]: { head: '记账确认卡', unit: '笔', done: '已记账', verb: '记上', paint: ledgerItemHtml },
  [BOOKMARKS_PROPOSAL_KIND]: {
    head: '收藏确认卡',
    unit: '条',
    done: '已收藏',
    verb: '存进去',
    paint: bookmarkItemHtml,
  },
  [IDEA_PROPOSAL_KIND]: { head: '随手记确认卡', unit: '条', done: '已记下', verb: '记下', paint: ideaItemHtml },
  [HARDWARE_PROPOSAL_KIND]: {
    head: '数码确认卡',
    unit: '件',
    done: '已登记',
    verb: '写进台账',
    paint: hardwareItemHtml,
  },
  [TRIP_PROPOSAL_KIND]: {
    head: '车票确认卡',
    unit: '张',
    done: '已加进去',
    verb: '加上',
    paint: tripItemHtml,
  },
  [ASSETS_PROPOSAL_KIND]: {
    head: '资产确认卡',
    unit: '条',
    done: '已记进资产台账',
    verb: '记上',
    paint: assetItemHtml,
  },
  [CALENDAR_PROPOSAL_KIND]: {
    head: '日程确认卡',
    unit: '条',
    done: '已加进日历',
    verb: '加上',
    paint: eventItemHtml,
  },
};

/**
 * 功能：取某个 kind 的界面配置 —— ⛔ 认不出来的 kind（老数据 / 手工构造的快照）一律按**任务卡**算。
 * @param {*} kind - `meta.kind`
 * @returns {Object} `PROPOSAL_UI` 里的一项
 */
function uiOfKind(kind) {
  return PROPOSAL_UI[String(kind == null ? '' : kind)] || PROPOSAL_UI[PROPOSAL_KIND];
}

/**
 * 功能：卡片的**结论**那句话（已经处理过的卡上写它，⛔ 不再摆两颗点了会报错的按钮）。
 * @param {Object} meta - 卡片快照
 * @returns {string} 一句人话
 */
function proposalStateText(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const ui = uiOfKind(m.kind);
  const state = String(m.state || 'pending');
  if (state === 'agreed') {
    const added = Number(m.added) || 0;
    const failed = Number(m.failed) || 0;
    if (failed) return `${ui.done} ${added} ${ui.unit}（${failed} ${ui.unit}没${ui.verb}）`;
    return `${ui.done}（${added} ${ui.unit}）`;
  }
  if (state === 'rejected') return '已拒绝';
  return '等你决定';
}

/**
 * 功能：画那张**会话流里的确认卡**（一次提议一张卡，几条都列在同一张里）。
 *
 * 说明：⚠️ 已处理的卡（`state` 不是 `pending`）**不画**那两颗按钮，改成一句结论 ——
 *      摆两颗点了必然报错的按钮是更坏的选择（本轮口径）。
 *      ⚠️ 认不出 `meta`（缺 / 坏）时**返回空串**，调用方退回普通消息渲染（`content` 是降级文本）。
 *      ⭐ 0.8.4：卡的种类**在 `meta.kind` 里**（服务端落的快照带它）—— 任务卡与记账卡的
 *      标题、条目行、结论文案各一套；`meta.kind` 缺省（老数据）一律按任务卡画。
 *
 * @param {{id: number, meta: ?Object}} card - 卡片（id + 快照）
 * @returns {string} HTML；`meta` 认不出来时为空串
 */
export function proposalCardHtml(card) {
  const meta = card && card.meta && typeof card.meta === 'object' ? card.meta : null;
  if (!meta || !Array.isArray(meta.items)) return '';
  const id = Number(card.id) || 0;
  const items = meta.items;
  const ui = uiOfKind(meta.kind);
  const state = String(meta.state || 'pending');
  const head = `${ui.head} · ${items.length} ${ui.unit}`;
  // ⭐⭐ 0.8.55（「除了有接受、拒绝两种还要加一个修改按键。点修改直接进入新建弹窗，
  //    ai 生成的预填入，可以修改」）：待处理时**三颗**——修改 / 拒绝 / 同意。
  //    ⚠️ 「修改」**不改卡片状态**：它只是把这张卡的内容带进那个模块自己的「新建」弹窗里让用户改完再存；
  //    卡片留在「待处理」，用户改完若没存，回头还能点同意或拒绝。
  const foot =
    state === 'pending'
      ? `<div class="ai-prop-foot">` +
        `<button class="ai-btn" type="button" data-ai-prop-act="edit" data-ai-prop-id="${id}">修改</button>` +
        `<button class="ai-btn" type="button" data-ai-prop-act="reject" data-ai-prop-id="${id}">拒绝</button>` +
        `<button class="ai-btn ai-btn-primary" type="button" data-ai-prop-act="agree" data-ai-prop-id="${id}">同意</button>` +
        `</div>`
      : `<div class="ai-prop-state">${esc(proposalStateText(meta))}</div>`;
  return (
    `<div class="ai-prop-card" data-ai-prop-card="${id}">` +
    `<div class="ai-prop-head">${head}</div>` +
    `<div class="ai-prop-list">${items.map(ui.paint).join('')}</div>` +
    foot +
    `</div>`
  );
}

// ================================================================ AI 卡片屏：连接 / 上下文 / 记忆（2 期）

/**
 * 「每次带多少条历史」的可选范围（**前端一份**；必须与服务端 `routes.js` 的区间同值） @type {number}
 *
 * ⚠️⭐ 0.7.7-⑰：上限 50 → 200。它与服务端是**两份**（前后端各写一份是刻意的：前端要画
 *    `min` / `max` 与本地校验，服务端要挡请求）—— 改一处忘一处 = 前端不让填 200（或填了被服务端 400）。
 * ⚠️ 同时服务端把字符兜底常数抬到 60000（`store.js` 的 `AI_CTX_MAX_CHARS`）—— 只抬条数不抬它，
 *    200 条会被字符上限悄悄截成几十条。
 */
const CTX_TURNS_MIN = 20;
const CTX_TURNS_MAX = 200;

// ⚠️ 0.7.6：「每次最多带几条记忆」这个配置**已从界面撤掉**（记忆改为全量注入）⇒
//    原来的 `MEM_MAX_MIN` / `MEM_MAX_MAX` 两个常量与生成下拉的 `rangeOptions()` 一并删掉。
//    ⛔ 服务端的 `mem_max` 列与校验**保留**（向后兼容 + 老备份恢复），它不再影响注入条数。

/** 记忆单条长度上限（与服务端 `checkAiMemory` 的 2000 同值 —— 改一处必须改另一处） @type {number} */
const MEM_TEXT_MAX = 2000;

/** 记忆**名称**长度上限（与服务端 `routes.js` 的 `AI_MEM_LABEL_MAX` 同值 —— 改一处必须改另一处） @type {number} */
const MEM_LABEL_MAX = 20;

/**
 * 除「连接设置」之外，每一个区顶部那句指引 —— ⭐ 只有一份，面板与工具块都用它。
 *
 * 说明：它讲的是**保存语义**：连接设置那三样要攒着点保存，其余开关都是点了就生效。
 *      ⚠️ 改这句话只改这里（别在别处再抄一份字面量）。
 * @type {string}
 */
const SAME_HINT = '这一区的开关点了就生效，不用保存。';

/**
 * ⭐ 0.7.7-⑱：**永远存在的三条预设**（「预设这三条，且不能删除，只能填内容」）——
 * 名称已定稿，**内容框里是填写提示**（灰字 `placeholder`），照着填就行。
 *
 * 说明：⚠️ 与旧版（0.7.1）的两点不同，都是既定的：
 *      ① **名称只读、行不能删** —— 所以每行**不画 × 键**（摆一颗必然点不动的按钮是更坏的选择）；
 *         服务端另有一道护栏：`DELETE /api/ai/memories/<id>` 命中这三条的名称一律 400。
 *      ② **永远存在** —— 打开记忆界面时先把这三行摆上，用户自己加的接在后面；
 *         老版是「一条记忆都没有时才预填」，一旦库里有内容这三行就再也不出现，等于提出了预设。
 *      ⚠️⭐ **靠名称复用**（不是靠新建列 / 新表）：库里已经有同名行就直接用那一行、**内容一个字节都不动**
 *      —— 库里正好就有这三条（截图里就是），升级之后必须原样在。
 *
 * @type {Array.<{label: string, hint: string}>}
 */
const MEM_PRESETS = [
  { label: '用户名称', hint: '怎么称呼你，例如：叫我老张' },
  { label: 'AI助手名称', hint: '它自称什么，例如：回我时署名叫小六' },
  { label: '约定', hint: '每次都要遵守的一条，例如：先给结论再给理由' },
];

/**
 * 预设三条的**名称** —— ⭐ 「哪几行是预设」**只此一处**判（本文件里别处不许再列一遍名字）。
 *
 * 说明：⚠️ 服务端有一份**镜像**（`modules/ai/store.js` 的 `MEM_PRESET_LABELS`）：那边要在
 *      `aiDeleteMemory()` 里挡住「删预设」，两层各一份是刻意的（前端是体验、服务端是护栏，
 *      与「两端文案」「前后端区间常量」同一套路）。**改这里必须同步改那一份**。
 * @type {Array.<string>}
 */
const MEM_PRESET_LABELS = MEM_PRESETS.map((p) => p.label);

/**
 * 功能：这一行是不是**预设三行**之一（按名称判 —— 与复用口径同一个判据）。
 * @param {?string} label - 记忆名称
 * @returns {boolean} 是预设为 true
 */
const isPresetLabel = (label) => MEM_PRESET_LABELS.includes(String(label == null ? '' : label).trim());

/**
 * 功能：建「连接」块 —— 接口地址 / 模型名 / API 密钥 / 总开关 / 允许访问内网地址 / 测连通 / 清除密钥。
 *
 * 说明：⭐ 这就是 1 期设置页那一栏的 DOM 与行为（**原样搬过来**，不重写）——
 *      搬走之后 `desktop-settings-pane.js` / `mobile-settings-pane.js` 两个薄壳一起删掉，
 *      全项目只有这一份（方案 §15.6 第 11 条：两处各一份 = 两套真相）。
 *      ⭐ 「绝不回显」在界面上的样子：密钥框**永远空着**，配没配只看那句状态说明
 *      （「已配置 —— 留空表示不修改」）；⭐ 开关点了就生效；
 *      ⚠️ `http://` 地址放行但必须给明文提示（方案 §八-5）。
 *      ⭐ 「允许访问内网地址」是**安全审查报告 009 的 R1**：地址由用户自填，此前任意地址都放行，
 *      登录成员可以拿它探测 NAS 所在内网（错误文案能区分「连不上 / 不存在 / 超时」）。
 *      后端因此默认拦私网地址，但**本地 ollama（`http://127.0.0.1:11434`）是真实用法**，
 *      一刀切会伤它，所以留了这个显式开关（默认关 = 拦）。开关只是一次 `PUT`，
 *      当前值永远以服务端返回的 `allowPrivate` 为准（`fill` 回填，不做本地记忆）。
 *
 * @param {{toast: Function, ask: Function}} host - 端注入：toast 与二次确认
 *        （`ask({title, text, ok, danger}, fn)` —— 桌面走确认模态框、手机走确认弹层）
 * @param {{sync: Function}} [hooks] - 面板级联动：任一块保存成功后，把最新视图推给另外两块
 * @returns {{node: HTMLElement, fill: Function, fail: Function}} 块节点 + 回填 / 报错入口
 */
export function createAiConnBlock(host, hooks) {
  const toast = host && host.toast ? host.toast : () => {};
  const ask = host && host.ask ? host.ask : (_o, fn) => fn();
  const sync = hooks && hooks.sync ? hooks.sync : () => {};
  const root = el('div', 'ai-task');
  root.innerHTML = `
    <div class="ai-warn">⚠️ 开启后，你点选的内容会发送给你自己填写的 AI 接口（会离开 NAS）。
      第三方接口的行为不受本应用控制；AI 的提议可能有错，落库前必须由你确认。</div>
    <div class="ai-f"><label class="ai-f-label" for="ai-cfg-url">接口地址</label>
      <div class="ai-sub">OpenAI 兼容</div>
      <input class="ai-input" id="ai-cfg-url" data-ai="url" type="text" maxlength="500"
        aria-describedby="ai-cfg-httpwarn ai-cfg-iihint" placeholder="https://api.deepseek.com/v1" autocomplete="off" spellcheck="false" />
      <div class="ai-hint" id="ai-cfg-iihint" data-ai="iihint" hidden>
        <span>这个地址在你的内网里，现在还访问不了。</span>
        <button class="ai-btn ai-btn-mini" type="button" data-ai="iion">打开它</button>
      </div></div>
    <div class="ai-warn" id="ai-cfg-httpwarn" data-ai="httpwarn" hidden>⚠️ 这个地址不是 https:// —— 传输过程是明文，只建议在自家局域网里这样用。</div>
    <div class="ai-f"><label class="ai-f-label" for="ai-cfg-model">模型名</label>
      <input class="ai-input" id="ai-cfg-model" data-ai="model" type="text" maxlength="200"
        placeholder="deepseek-chat" autocomplete="off" spellcheck="false" /></div>
    <div class="ai-f"><label class="ai-f-label" for="ai-cfg-key">API 密钥</label>
      <input class="ai-input" id="ai-cfg-key" data-ai="key" type="password" maxlength="500" autocomplete="new-password"
        aria-describedby="ai-cfg-keynote" placeholder="未配置，粘贴你的 API Key" /></div>
    <div class="ai-note" id="ai-cfg-keynote" data-ai="keynote">还没有配置密钥。密钥只保存在这台 NAS 上（密文），不会回显。</div>
    <button class="ai-switch" type="button" data-ai="on" aria-pressed="false">
      <span>启用 AI 辅助任务</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="vision" aria-pressed="false">
      <span>支持图片输入</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <div class="ai-note">打开后，你可以给 AI 发一张图片（例如一张车票截图），让它照着图说话。
      ⚠️ 图片会随请求一起发给你填写的那个接口；<b>不是每个模型都收图</b>（本机 ollama 常见的不收），
      开着而模型不收时会报错 —— 那时把它关掉即可。⭐ 一张图<b>只看得到一次</b>：需要它做什么，
      请在发图的那一轮说清楚。</div>
    <div class="ai-cfg-actions">
      <button class="ai-btn" type="button" data-ai="test">测连通</button>
      <button class="ai-btn ai-btn-primary" type="button" data-ai="save">保存连接设置</button>
      <span class="ai-dirty" data-ai="dirty" hidden>有改动还没保存</span>
    </div>
    <div class="ai-note" data-ai="result" hidden></div>
    <details class="ai-adv">
      <summary>高级（谨慎操作）</summary>
      <button class="ai-switch" type="button" data-ai="privon" aria-pressed="false">
        <span>允许访问内网地址</span><span class="ai-switch-pill" aria-hidden="true"></span>
      </button>
      <div class="ai-note">要用局域网或本机的模型服务（例如 http://127.0.0.1:11434 的 ollama）就打开它。
        ⚠️ 打开后，这个账号可以访问你 NAS 所在内网的任意网址 —— 请只在你自己的网络里打开。</div>
      <button class="ai-btn ai-btn-danger" type="button" data-ai="clear" hidden>清除密钥</button>
    </details>`;

  const q = (name) => root.querySelector(`[data-ai="${name}"]`);
  const urlIn = q('url');
  const modelIn = q('model');
  const keyIn = q('key');
  const onBtn = q('on');
  const clearBtn = q('clear');
  const privBtn = q('privon');
  // ⭐ 0.8.6（行程 1 期 ·）：「支持图片输入」开关 —— 与上面那些开关同一口径
  //    （状态一律以服务端返回的 `vision` 为准，前端不做本地记忆）
  const visionBtn = q('vision');
  const saveBtn = q('save');
  const dirtyBox = q('dirty');
  const iiBox = q('iihint');
  let enabled = false;
  // 009-R1：是否允许接口地址指向私网（默认关 —— 后端 NULL 也按 0 处理）
  let allowPrivate = false;
  /** ⭐ 0.8.6：图片能力开关的当前值（同样以服务端为准） */
  let visionOn = false;
  // 0.7.6（批次 A3）：已保存内容的快照 —— 用来判断「输入框里有没有没保存的改动」
  let snap = { url: '', model: '', key: '' };
  // ⭐ 0.7.6：手机端「入口行」要看「配没配密钥」⇒ 把它留在手里（`summary()` 用，⛔ 不为它多发请求）
  let keySet = false;

  /**
   * 功能：把任意地址串的**主机名**抠出来（用户可能没写协议，`new URL` 会解析失败）。
   * @param {string} raw - 地址输入框里的原文
   * @returns {string} 小写主机名；抠不出为空串
   */
  function hostOf(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      return new URL(s).hostname.toLowerCase();
    } catch (_e) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(s) || /^([^/:?#]+)/.exec(s);
      return m ? String(m[1]).toLowerCase() : '';
    }
  }

  /**
   * 功能：这个地址是不是「本机 / 局域网」那一类（界面据此提示「要打开内网开关」）。
   *
   * 说明：⭐ 与服务端 `lib/openai-client.js` 的 `isPrivateBaseUrl()` **不是同一份判据** ——
   *      这里只用于**提前提示**（少一次「保存被 400」的往返），真正的放行判据永远在服务端。
   *      ⚠️ 判定刻意宽一点（连 `http://` 也算）：`http://` 与局域网地址几乎总是同一批用法，
   *      而这里多提示一句的代价只是一行字，漏提示的代价是用户撞一次 400 还不知道去哪开。
   * @param {string} raw - 地址输入框里的原文
   * @returns {boolean} 该提示「打开内网开关」为 true
   */
  function looksLocal(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    if (/^http:\/\//i.test(s)) return true;
    const host = hostOf(s);
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (/^127\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }

  /**
   * 功能：重画「私网地址就地提示」—— 地址像本机 / 局域网、而内网开关还关着时才出现。
   * @returns {void}
   */
  function paintLocalHint() {
    iiBox.hidden = !(looksLocal(urlIn.value) && !allowPrivate);
  }

  /**
   * 功能：重画「有没有没保存的改动」—— 输入框里与已保存内容不一致时亮出来。
   *
   * 说明：⭐ 解决「改了地址不保存就切走 = 静默丢失」：用户至少能看到「有东西没存」。
   *      ⚠️ 密钥框的比对口径是「**非空**即有改动」：它永远不回显，填了字就是要改。
   * @returns {void}
   */
  function paintDirty() {
    const dirty =
      urlIn.value.trim() !== snap.url || modelIn.value.trim() !== snap.model || keyIn.value.trim() !== snap.key;
    dirtyBox.hidden = !dirty;
    saveBtn.classList.toggle('dirty', dirty);
  }

  /**
   * 功能：把一份配置视图填进连接块（初次加载 / 自己保存之后 / 别处保存时同步过来）。
   * @param {Object} v - 配置视图（`GET|PUT /api/ai/config` 的响应）
   * @param {{keepInputs?: boolean}} [opts] - 为真时**不覆盖**地址与模型输入框。⚠️ 别处保存触发的同步
   *        必须带上它：用户可能正改着地址还没保存，覆盖 = 悄悄抹掉他刚打的字。
   * @returns {void}
   */
  function fill(v, opts) {
    if (!(opts && opts.keepInputs)) {
      urlIn.value = v.baseUrl || '';
      modelIn.value = v.model || '';
      q('httpwarn').hidden = !/^http:\/\//i.test(v.baseUrl || '');
    }
    // 不论哪种填法都刷新快照：服务端的值就是「已保存的样子」（密钥永远算空白）
    snap = { url: String(v.baseUrl || ''), model: String(v.model || ''), key: '' };
    enabled = !!v.enabled;
    onBtn.classList.toggle('on', enabled);
    onBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    onBtn.setAttribute('data-on', enabled ? '1' : '0'); // ⭐ 药丸：状态由类 + data-on 表达，不再写文字
    // 009-R1：开关状态一律以服务端返回的 `allowPrivate` 为准（旧后端没这个键时按关处理）
    allowPrivate = !!v.allowPrivate;
    privBtn.classList.toggle('on', allowPrivate);
    privBtn.setAttribute('aria-pressed', allowPrivate ? 'true' : 'false');
    privBtn.setAttribute('data-on', allowPrivate ? '1' : '0');
    // ⭐ 0.8.6：图片开关（同一个口径 —— 旧后端没这个键时按关处理）
    visionOn = !!v.vision;
    visionBtn.classList.toggle('on', visionOn);
    visionBtn.setAttribute('aria-pressed', visionOn ? 'true' : 'false');
    visionBtn.setAttribute('data-on', visionOn ? '1' : '0');
    keyIn.placeholder = v.keySet ? '已配置 —— 留空表示不修改' : '未配置，粘贴你的 API Key';
    keySet = !!v.keySet;
    q('keynote').textContent = v.keySet
      ? '密钥已保存在这台 NAS 上（密文），不会回显；留空保存 = 不修改。'
      : '还没有配置密钥。密钥只保存在这台 NAS 上（密文），不会回显。';
    clearBtn.hidden = !v.keySet;
    paintLocalHint();
    paintDirty();
  }

  /**
   * 功能：给**手机端的入口行**一句话状态（「还没配置密钥 / 未启用 / 已启用 · <模型名>」）。
   *
   * 说明：⚠️ 这是 1 期起就在手机端当过摘要的那三态（见 `docs/公共/开发方案/14-AI辅助任务-2期.md`），
   *      **只用手里已有的字段**算，⛔ 不为它单独发请求。
   * @returns {string} 一句短文案
   */
  function summary() {
    if (!keySet) return '还没配置密钥';
    if (!enabled) return '未启用';
    return `已启用 · ${snap.model || '还没填模型名'}`;
  }

  /**
   * 功能：在读不到配置时，把这句失败写在块里 —— 界面不静默。
   * @param {string} msg - 用户能看懂的一句话
   * @returns {void}
   */
  function fail(msg) {
    const r = q('result');
    r.hidden = false;
    r.textContent = msg;
  }

  // ⭐ 0.7.6（A3）：三个输入框任何变化都要重算「有没有没保存的改动」；
  //    地址还要顺带重算「私网提示」（用户可能刚把它改成本机 / 局域网地址）
  [urlIn, modelIn, keyIn].forEach((inp) => {
    inp.addEventListener('input', () => {
      paintDirty();
      paintLocalHint();
    });
  });
  // ⭐ 0.7.6（A4）：就地打开内网开关 —— 与高级区里那颗开关走同一套保存逻辑，
  //    省掉「保存被 400 → 自己回头找开关」那一次往返
  q('iion').addEventListener('click', async () => {
    const btn = q('iion');
    btn.disabled = true;
    try {
      const v = await api('PUT', '/api/ai/config', { allow_private: true });
      fill(v, { keepInputs: true });
      sync(v);
      toast('已允许访问内网地址');
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  saveBtn.addEventListener('click', async () => {
    const patch = { base_url: urlIn.value.trim(), model: modelIn.value.trim() };
    const k = keyIn.value.trim();
    if (k) patch.apiKey = k;
    saveBtn.disabled = true;
    try {
      const v = await api('PUT', '/api/ai/config', patch);
      keyIn.value = '';
      fill(v);
      sync(v);
      toast('连接设置已保存');
    } catch (e) {
      toast(e.message, true);
    } finally {
      saveBtn.disabled = false;
      paintDirty(); // 保存失败时输入框内容没变 ⇒ 「有改动还没保存」要留着
    }
  });
  onBtn.addEventListener('click', async () => {
    const next = !enabled;
    try {
      const v = await api('PUT', '/api/ai/config', { enabled: next });
      fill(v, { keepInputs: true });
      sync(v);
    } catch (e) {
      toast(e.message, true);
    }
  });
  // 009-R1：点一下就存（与上面的总开关同一口径）。⚠️ 字段名是下划线 `allow_private`（与 `mem_enabled` 一致）；
  //        ⚠️ 关掉而地址还是私网时**不在这里拦**——后端会回 400、文案已写明要打开哪个开关，原样 toast 给用户。
  privBtn.addEventListener('click', async () => {
    const next = !allowPrivate;
    try {
      const v = await api('PUT', '/api/ai/config', { allow_private: next });
      fill(v, { keepInputs: true });
      sync(v);
    } catch (e) {
      toast(e.message, true);
    }
  });
  // ⭐ 0.8.6：图片能力开关 —— 点一下就存（与上面两个开关同一口径）。
  //    ⚠️ 它**只影响「能不能发图」**，不改变任何已存的数据；关掉之后历史里那些图照样看得见。
  visionBtn.addEventListener('click', async () => {
    const next = !visionOn;
    try {
      const v = await api('PUT', '/api/ai/config', { vision: next });
      fill(v, { keepInputs: true });
      sync(v);
    } catch (e) {
      toast(e.message, true);
    }
  });
  q('test').addEventListener('click', async () => {
    const btn = q('test');
    const r = q('result');
    // ⭐ 0.7.6（A3/B3）：测连通测的是**服务端已保存的那份配置**（接口不带 body）——
    //    有没保存的改动时，先把这句话写在结果行上，别让「✅ 连通正常」把用户骗过去。
    //    ⚠️ 仍然照测（不把按钮变成死的）：用户想验的往往是「上次保存的那份还能不能用」。
    const warn = dirtyBox.hidden ? '' : '请先保存连接设置，再测连通。\n本次测的是已保存的配置：\n';
    btn.disabled = true;
    btn.textContent = '正在测试…';
    r.hidden = true;
    try {
      const out = await api('POST', '/api/ai/test', {}, { timeout: 45000 });
      r.hidden = false;
      r.textContent = warn + (out.ok ? `✅ 连通正常，用时 ${out.ms} 毫秒` : `❌ ${out.reason}`);
    } catch (e) {
      r.hidden = false;
      r.textContent = warn + `❌ ${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '测连通';
    }
  });
  clearBtn.addEventListener('click', () => {
    ask(
      {
        title: '清除 API 密钥',
        text: '清除之后，聊天与「记成任务」都会提示先到这里重新配置（地址与模型名不受影响）。确定清除吗？',
        ok: '清除',
        danger: true,
      },
      async () => {
        try {
          const v = await api('POST', '/api/ai/config/clear-key', {});
          keyIn.value = '';
          fill(v, { keepInputs: true });
          sync(v);
          toast('已清除 API 密钥');
        } catch (e) {
          toast(e.message, true);
        }
      },
    );
  });
  return { node: root, fill, fail, summary };
}

/**
/**
 * 功能：建「上下文」块 —— 每次带多少条历史。
 *
 * 说明：⚠️ 「带多少条历史」改一下就生效（与总开关同一口径）：数字框在**失焦 / 回车**时保存，
 *      ⛔ 没有「保存」按钮。非法值（空 / 非整数 / 越界）**一个请求都不发**、就地给一句提示、
 *      把框拨回服务端的真值 —— 界面上留一个没生效的值比报错更糟，
 *      而「悄悄钳到 20 或 200 再发」是**静默截断**。
 *      ⭐ 0.7.6：「开启新对话」已搬去**会话屏**（`createAiThreadView()`）—— 那本就是会话的事，
 *      这一块原来带着的 `newseg` / `segstate` / `segmsg` / `loadSeg()` 全部随之搬走。
 *
 * @param {{toast: Function}} host - 端注入：toast
 * @param {{sync: Function}} [hooks] - 面板级联动
 * @returns {{node: HTMLElement, fill: Function, summary: Function}} 块节点 + 回填 / 入口行摘要
 */
export function createAiCtxBlock(host, hooks) {
  const toast = host && host.toast ? host.toast : () => {};
  const sync = hooks && hooks.sync ? hooks.sync : () => {};
  const root = el('div', 'ai-task');
  root.innerHTML = `
    <div class="ai-f"><div class="ai-note">带的条数越多，AI 记得越清楚，但每一次发出去的内容也越多、越费额度。</div></div>
    <div class="ai-f"><label class="ai-f-label" for="ai-cfg-turns">每次带多少条历史</label>
      <input class="ai-input" id="ai-cfg-turns" data-ai="turns" type="number" inputmode="numeric"
        min="${CTX_TURNS_MIN}" max="${CTX_TURNS_MAX}" step="1" aria-describedby="ai-cfg-turnshint" />
      <div class="ai-hint" id="ai-cfg-turnshint" data-ai="turnshint" hidden></div></div>`;

  const q = (name) => root.querySelector(`[data-ai="${name}"]`);
  const turnsIn = q('turns');
  const hintBox = q('turnshint');
  /** 服务端那份**真值**（每次 `fill()` 刷新）—— 用来判「有没有改」、以及非法时要拨回哪儿 @type {number} */
  let saved = CTX_TURNS_MIN;

  /**
   * 功能：回填「每次带多少条历史」，并把上一次的提示收起来。
   * @param {Object} v - 配置视图
   * @returns {void}
   */
  function fill(v) {
    saved = Number(v.ctxMaxTurns) || CTX_TURNS_MIN;
    turnsIn.value = String(saved);
    hintBox.hidden = true;
  }

  /**
   * 功能：读输入框并校验 —— 合法返回整数，非法返回 `null`（调用方据此**不发请求**）。
   *
   * 说明：⚠️ 别信浏览器：`type="number"` 允许手打 `e` / `-` / 小数，`min` / `max` 也不挡手输 ⇒
   *      这里自己按「纯整数串 + 区间」判一遍（与服务端 `checkCtxTurns` 同一口径）。
   * @returns {?number} 合法值；空 / 非整数 / 越界一律 null
   */
  function readTurns() {
    const raw = String(turnsIn.value == null ? '' : turnsIn.value).trim();
    if (!/^-?\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < CTX_TURNS_MIN || n > CTX_TURNS_MAX) return null;
    return n;
  }

  /**
   * 功能：失焦 / 回车时保存一次（⛔ 没有「保存」按钮）。
   * @returns {Promise.<void>}
   */
  async function saveTurns() {
    const n = readTurns();
    if (n === null) {
      hintBox.hidden = false;
      hintBox.textContent = `请填 ${CTX_TURNS_MIN}~${CTX_TURNS_MAX} 之间的整数 —— 这一格没有保存。`;
      // 拨回服务端的真值：手里就有（`fill()` 每次刷新它），⛔ 不为这个再多发一次请求
      turnsIn.value = String(saved);
      return;
    }
    if (n === saved) {
      hintBox.hidden = true;
      return; // 没改动就不发请求
    }
    turnsIn.disabled = true;
    try {
      const v = await api('PUT', '/api/ai/config', { ctx_max_turns: n });
      fill(v);
      sync(v);
      toast(`每次会带 ${n} 条历史`);
    } catch (e) {
      toast(e.message, true);
      // 没生效就把框拨回服务端的真值（界面上不许留一个假的当前值）
      try {
        fill(await api('GET', '/api/ai/config'));
      } catch (_e) {
        turnsIn.value = String(saved);
      }
    } finally {
      turnsIn.disabled = false;
    }
  }

  turnsIn.addEventListener('blur', () => {
    saveTurns().catch(() => {});
  });
  turnsIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // ⛔ 别让回车把面板里的别的东西也触发了
      saveTurns().catch(() => {});
    }
  });

  /**
   * 功能：给**手机端的入口行**一句话状态（「每次带 N 条历史」）。
   * @returns {string} 一句短文案
   */
  function summary() {
    return `每次带 ${saved} 条历史`;
  }

  return { node: root, fill, summary };
}

/**
 * 功能：建「记忆」块 —— 开关 / 条数结论 / 管理记忆（增删改在那个弹层里）。
 *
 * 说明：⭐ 「本次会带几条」是**算出来的实话**（有几条带几条），不是配置值的复述 ——
 *      0.7.6 起记忆**全量注入**，那个「每次最多带几条」的下拉已撤（服务端 `mem_max` 保留仅为兼容）。
 *      ⭐ 清空要二次确认（那是唯一会一次删掉多条的操作）；单条删除不必 —— 记忆是随时能再添一句的东西。
 *      ⚠️ 内容一律 `textContent` 落进 DOM：它是用户自己打的字，也可能粘自别处（XSS 口径同消息区）。
 *
 * @param {{toast: Function, ask: Function}} host - 端注入：toast 与清空的二次确认
 * @param {{sync: Function}} [hooks] - 面板级联动
 * @returns {{node: HTMLElement, fill: Function, loadList: Function, summary: Function}} 块节点 + 回填 / 重读列表 / 入口行摘要
 */
export function createAiMemBlock(host, hooks) {
  const toast = host && host.toast ? host.toast : () => {};
  const ask = host && host.ask ? host.ask : (_o, fn) => fn();
  const sync = hooks && hooks.sync ? hooks.sync : () => {};
  const root = el('div', 'ai-task');
  root.innerHTML = `
    <div class="ai-f"><div class="ai-note">AI 每次都会带上这些背景，比如「我习惯用四象限排任务」。它们会随每次对话一起发出去。</div></div>
    <button class="ai-switch" type="button" data-ai="memon" aria-pressed="true">
      <span>让 AI 记住这些</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <div class="ai-verdict" data-ai="memsum">正在读取…</div>
    <div class="ai-note">记忆条数没有上限：写了几条就带几条。想少发一点，就在「管理记忆…」里删掉几条。</div>
 <!-- ⭐ 0.7.1：记忆的增删改**搬进独立的配置界面**（一个按钮点开）—— 有一张示意图：
         每行两个框（**左边名称、右边内容**）+ 行尾一个 ✕，底部「添加 / 保存」。
         这一屏因此只留「开关 / 有多少条」这两件需要一眼看到的事。 -->
    <div class="ai-cfg-actions">
      <button class="ai-btn ai-btn-primary" type="button" data-ai="memopen">管理记忆…</button>
    </div>`;

  const q = (name) => root.querySelector(`[data-ai="${name}"]`);
  const onBtn = q('memon');
  const sumBox = q('memsum');
  const openBtn = q('memopen');
  let cfg = { memEnabled: true };
  let items = [];

  /**
   * 功能：把「现在有几条、下次会带几条」写成一句实话（关掉时明说一条都不带）。
   *
   * 说明：⭐ 0.7.6 起记忆是**全量注入**（没有「最多带几条」这个配置了）⇒ 三句话都按全量口径写，
   *      ⛔ 别再出现「会带 min(N, 上限) 条」那种说法，那会让用户以为还有个数在管着。
   * @returns {void}
   */
  function paintSum() {
    // ⭐ 0.7.6（A9）：条数并进按钮文案 —— 原来那排末尾挂着一个裸 span，读起来像两件事
    openBtn.textContent = items.length ? `管理记忆（${items.length} 条）…` : '管理记忆…';
    if (!cfg.memEnabled) {
      sumBox.textContent = `记忆已关闭 —— 下次对话不会带上任何一条（这 ${items.length} 条都还留着）。`;
      return;
    }
    if (!items.length) {
      sumBox.textContent = '已开启，但还没记下任何一条 —— 点「管理记忆…」添一条，下次对话就会带上。';
      return;
    }
    sumBox.textContent = `已开启：现在有 ${items.length} 条，下次对话会全部带上。`;
  }

  /**
   * 功能：重新读一次记忆列表，并把「有几条 / 会带几条」一起刷新。
   *
   * 说明：⭐ 0.7.1 起卡片**不由这里画** —— 记忆的增删改都在独立配置界面（`openMemDialog()`）
   *      里一次性完成，这里的职责只剩「取最新列表 + 刷外面那行小字」。
   * @returns {Promise.<void>}
   */
  async function loadList() {
    try {
      const r = await api('GET', '/api/ai/memories');
      items = r.items || [];
      paintSum();
    } catch (e) {
      sumBox.textContent = `记忆读取失败：${e.message}`;
    }
  }

  /**
   * 功能：回填开关（设置视图到手时调用）。
   * @param {Object} v - 配置视图
   * @returns {void}
   */
  function fill(v) {
    cfg = { memEnabled: !!v.memEnabled };
    onBtn.classList.toggle('on', cfg.memEnabled);
    onBtn.setAttribute('aria-pressed', cfg.memEnabled ? 'true' : 'false');
    onBtn.setAttribute('data-on', cfg.memEnabled ? '1' : '0');
    paintSum();
  }

  onBtn.addEventListener('click', async () => {
    const next = !cfg.memEnabled;
    try {
      const v = await api('PUT', '/api/ai/config', { mem_enabled: next });
      fill(v);
      sync(v);
    } catch (e) {
      toast(e.message, true);
    }
  });

  /**
   * 功能：打开**记忆的配置界面**（0.7.1）—— 一个自己搭的模态层，两端共用同一份实现。
   *
   * 说明：⭐ 形态就是给的示意图：**每行两个框（左名称 / 右内容）+ 行尾一个 ✕**，
   *      底部「＋ 添加 / 保存 / 清空全部」。⛔ 别做成「左边一列预设字段 + 右边卡片」那种两层结构 ——
   *      上一版正是那样，是「点一次左边创建一个，不需要怎么复杂」。
   *      ⚠️ 为什么**自己搭**而不复用宿主的弹层：本文件两端共用，而电脑端的 `openModal` 与手机端的
   *      `openSheet` 是**两套 API**，在共用文件里调谁都等于把另一端写死。
   *      样式类 `.ai-mem-*` 因此要在两端各写一份（与 `.ai-*` 同款规矩）。
   *
   * ⭐ **保存是「整表对齐」而不是逐行落库**：界面上只有一颗「保存」，用户改完一次交 ——
   *    新增的 POST、改过的 PUT、被 ✕ 掉的 DELETE 都在 `saveAll()` 里一起算出来。
   *    ⚠️ 内容为空的行 = 不要它（有 id 就删、没落库的跳过），这是「清空一个框」最自然的解释。
   * @returns {Promise.<void>}
   */
  async function openMemDialog() {
    const mask = el('div', 'ai-mem-mask');
    const panel = el('div', 'ai-mem-panel');
    panel.innerHTML = `
      <div class="ai-mem-head"><b>长期记忆</b>
        <button class="ai-btn ai-btn-mini" type="button" data-x="close">关闭</button></div>
      <div class="ai-note">前三条是<b>预设</b> —— 名称固定、删不掉，只填内容就行。
        下面自己加的行：<b>右边留空就不会保存</b>，想彻底不要它就点那一行的 ✕。</div>
      <div class="ai-note">AI 每次对话都会带上这些背景，它们会随每次对话一起发出去。</div>
      <div class="ai-mem-rows" data-x="rows"></div>
      <div class="ai-mem-foot">
        <button class="ai-btn" type="button" data-x="add">＋ 添加</button>
        <button class="ai-btn ai-btn-primary" type="button" data-x="save">保存</button>
        <button class="ai-btn ai-btn-danger" type="button" data-x="clear">清空全部</button>
      </div>`;
    const rowsBox = panel.querySelector('[data-x="rows"]');
    const close = () => mask.remove();
    panel.querySelector('[data-x="close"]').addEventListener('click', close);
    // 点遮罩关掉（手机上没有 Esc 键，这是唯一的「随手关」）
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close();
    });

    /**
     * 功能：画一行「名称 + 内容 + ✕」。
     * @param {{id?: number, label?: string, content?: string, hint?: string, preset?: boolean}} d - 行数据；
     *     `id` 缺省 / 0 = 还没落库；`hint` 只给预设那三行用（内容框里的灰字提示）；
     *     `preset` = 预设行（名称只读、不画 ✕）
     * @returns {HTMLElement} 这一行
     */
    const addRow = (d) => {
      const row = el('div', 'ai-mem-row');
      // ⚠️ 预设行打标记：`saveAll()` 与「清空全部」都要按它走不同的分支（不删、名称不改）
      if (d.preset) row.dataset.preset = '1';
      row.dataset.id = String(Number(d.id) || 0);
      // ⚠️ 原始值记在数据集里：保存时靠它判断「这一行到底改没改」，省掉一次多余的 PUT
      row.dataset.origLabel = String(d.label == null ? '' : d.label);
      row.dataset.origContent = String(d.content == null ? '' : d.content);
      const nameIn = el('input', 'ai-input ai-mem-name');
      nameIn.type = 'text';
      nameIn.maxLength = MEM_LABEL_MAX;
      nameIn.placeholder = '名称（可留空）';
      nameIn.value = row.dataset.origLabel;
      if (d.preset) {
        // ⭐ 0.7.7-⑱：预设行的名称**只读**（⛔ 不用 `disabled`：那会连值一起变灰、还给不出可读的焦点）
        nameIn.readOnly = true;
        nameIn.title = '这三条是预设，名称不能改';
      }
      const valIn = el('input', 'ai-input ai-mem-val');
      valIn.type = 'text';
      valIn.maxLength = MEM_TEXT_MAX;
      valIn.placeholder = d.hint || '要记住的内容，例：我习惯用四象限给任务排优先级';
      valIn.value = row.dataset.origContent;
      row.append(nameIn, valIn);
      if (!d.preset) {
        // ⭐ 预设行**不画** ✕（服务端也拒删）—— 摆一颗点了必然报错的按钮是更坏的选择
        const del = el('button', 'ai-btn ai-btn-mini ai-btn-danger ai-mem-x');
        del.type = 'button';
        del.textContent = '✕';
        del.title = '删掉这一行';
        del.addEventListener('click', () => row.remove());
        row.append(del);
      }
      rowsBox.appendChild(row);
      return row;
    };

    /**
     * 功能：把库里已有的行原样画出来（**预设三条排在最前、且永远在**）。
     *
     * 说明：⭐ 0.7.7-⑱：先把三条预设摆上，内容取库里同名那一行（没有就是空的）；
     *      再把用户**自己加的**其它行接在后面 —— ⛔ 预设行不许在这里被画成第二遍
     *      （同名行已经在预设那三行里被复用了）。
     * @returns {void}
     */
    const paintAll = () => {
      const used = new Set();
      MEM_PRESETS.forEach((p) => {
        const hit = items.find((m) => String(m.label == null ? '' : m.label).trim() === p.label);
        if (hit) used.add(Number(hit.id));
        addRow({ id: hit ? hit.id : 0, label: p.label, content: hit ? hit.content : '', hint: p.hint, preset: true });
      });
      // ⚠️ 预设行**已经在上面那三行里复用过了**，这里必须把它们排掉（否则库里那条同名行会被画第二遍）——
      //    用的是同一个判据 `isPresetLabel()`（⛔ 别在这里另写一遍名字比对）。
      items
        .filter((m) => !used.has(Number(m.id)) && !isPresetLabel(m.label))
        .forEach((m) => addRow({ id: m.id, label: m.label, content: m.content }));
    };

    /**
     * 功能：把界面上的全部行与库里的记忆**一次性对齐**（新增 / 改 / 删）。
     *
     * 说明：⭐ 0.7.7-⑱：预设三行**永不删**，所以它们与用户自己那几行走两条分支 ——
     *      · 预设行内容留空 ⇒ 库里那行**留着但内容清空**（服务端只对预设放行空内容）；
     *        还没落过库的（`id` 0）直接跳过（本来就"不存在"，没什么可清）。
     *      · 非预设行内容留空 ⇒ 照旧「这一行不要它」（有 id 就删、没落库的跳过）。
     * @returns {Promise.<void>}
     * @throws {Error} 任何一步被服务端拒绝时抛出（调用方 toast；界面**不关**，让用户改完重试）
     */
    async function saveAll() {
      const rows = Array.from(rowsBox.querySelectorAll('.ai-mem-row')).map((row) => ({
        id: Number(row.dataset.id) || 0,
        preset: row.dataset.preset === '1',
        label: row.querySelector('.ai-mem-name').value.trim(),
        content: row.querySelector('.ai-mem-val').value.trim(),
        origLabel: row.dataset.origLabel,
        origContent: row.dataset.origContent,
      }));
      // ① 界面上已经没有的行 = 被 ✕ 掉了 ⇒ 删（先删后写，避开"删了又立刻重建"这种顺序歧义）
      //    ⚠️ 预设行**不参与**这一段：它们永远在界面上（没有 ✕），所以永远进不了这个差集
      const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
      for (const m of items.filter((x) => !keep.has(Number(x.id)))) {
        await api('DELETE', `/api/ai/memories/${Number(m.id)}`, undefined);
      }
      // ② 逐行写回
      for (const r of rows) {
        // 内容空：预设行**留着行、清空内容**；其余行照旧「不要它」（已落库的删掉，没落库的跳过）
        if (!r.content) {
          if (!r.id) continue; // 还没落库、内容又是空的 —— 本来就没什么可写（预设的初始状态）
          if (r.preset) {
            if (r.origContent) await api('PUT', `/api/ai/memories/${r.id}`, { content: '' });
            continue;
          }
          await api('DELETE', `/api/ai/memories/${r.id}`, undefined);
          continue;
        }
        if (r.id) {
          if (r.label === r.origLabel && r.content === r.origContent) continue; // 一个字都没动
          await api('PUT', `/api/ai/memories/${r.id}`, { label: r.label, content: r.content });
        } else {
          await api('POST', '/api/ai/memories', { label: r.label, content: r.content });
        }
      }
    }

    panel.querySelector('[data-x="add"]').addEventListener('click', () => {
      addRow({ id: 0, label: '', content: '' }).querySelector('.ai-mem-val').focus();
    });
    panel.querySelector('[data-x="save"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await saveAll();
        await loadList(); // 让外面那行「共 N 条」跟上
        close();
        toast('已保存');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    panel.querySelector('[data-x="clear"]').addEventListener('click', () => {
      if (!items.length) {
        toast('现在一条都没有', true);
        return;
      }
      ask(
        {
          title: `清空全部记忆（${items.length} 条）`,
          text: '自己加的记忆会被删掉，预设那三条只清空内容、仍然留着。找不回来，确定清空吗？',
          ok: '清空',
          danger: true,
        },
        async () => {
          try {
            const r = await api('POST', '/api/ai/memories/clear', {});
            await loadList();
            // 清空之后重画：三条预设**还在**（内容空了）+ 自己加的那几行没了
            // （不清空面板的话，用户会以为还得再点一次保存）
            rowsBox.textContent = '';
            paintAll();
            toast(`已清空 ${r.removed} 条记忆（三条预设保留）`);
          } catch (e) {
            toast(e.message, true);
          }
        },
      );
    });

    mask.appendChild(panel);
    document.body.appendChild(mask);
    await loadList();
    // ⭐ 0.7.7-⑱：**三条预设永远排在最前**（内容取库里同名那一行），自己加的接在后面
    paintAll();
  }

  q('memopen').addEventListener('click', () => {
    openMemDialog().catch((e) => toast(e.message, true));
  });

  /**
   * 功能：给**手机端的入口行**一句话状态（关掉就是「已关闭」，开着就报条数）。
   * @returns {string} 一句短文案
   */
  function summary() {
    if (!cfg.memEnabled) return '已关闭';
    return `已开启 · ${items.length} 条`;
  }

  return { node: root, fill, loadList, summary };
}

/**
 * 功能：建「AI 能力（工具）」块（⭐ 3 期）—— 总开关 / 读授权（任务板、课表）/
 *      写授权（任务板）/ 审计。
 *
 * 说明：⭐ 这一屏是「把选择权交给用户」的落点（调的第 3 条）。
 *      ⭐⭐ 两轮反馈把文案收成「**每区顶上一句**」：
 *      ① 第一轮（「移除这些开关的提示语」）撤掉读区七句；
 *      ② 第二轮（「这里的提示语也删掉」）撤掉写区六句 + 写区底部那句汇总。
 *      ⇒ 现在每区只有**一句人话**（读区「打开哪一项，AI 才读得到哪一项」／写区「写操作永远
 *      只生成『提议』」），⛔ 别再按开关逐条加回去（那是同一件事说六七遍）。
 *      顶部那句是**不可配置的边界**：密码库与对话永远不进工具面。
 *      ⚠️⭐ 服务端 `modules/ai/lib/tools-read.js` 的 `PANEL_READ` 与 `tools-write.js` 的
 *      `PANEL_WRITE` **一条不少地留着**（`GET /api/ai/tools` 照旧原样回给界面）——
 *      它是「界面上说只发标题、实际发了课表」这类事故的**对账依据**，⛔ 不许因为界面不显示就删。
 *      边界由 `ttt/test/ai.test.js` 的「授权页文案」用例机械盯着（服务端一条不少 ＋ 界面仍有说明）。
 *      ⚠️ 开关是**点了就存**（与总开关 / 记忆开关同一口径）；任一开关保存失败就把界面拨回
 *      服务端的真值 —— 界面上留一个没生效的开关，比报错更糟。
 *      ⚠️ 只复用既有类名（`.ai-switch` / `.ai-note` / `.ai-warn` / `.ai-f`）——
 *      本模块两端各有一份 CSS，新造类名就要两端各改一遍 CSS，而这一块不需要新样式。
 *
 * @param {{toast: Function, ask: Function}} host - 端注入：toast（这一块不需要二次确认，`ask` 不收）
 * @param {{sync: Function}} [hooks] - 面板级联动：任一块保存成功后，把最新视图推给另外几块
 * @returns {{node: HTMLElement, fill: Function}} 块节点 + 回填入口
 */
export function createAiToolsBlock(host, hooks) {
  const toast = host && host.toast ? host.toast : () => {};
  const sync = hooks && hooks.sync ? hooks.sync : () => {};
  // ⭐ 0.7.6（本轮）：这一块从「一个大块」拆成 **一个常驻块 + 三个区**。
  //    ⛔ 刻意**不拆成三个独立的 createXxxBlock**：那几个开关共用同一份 `cfg`、同一个 `put()`、
  //    同一个 `paint()` —— 拆成多块就会让 `cfg` 出现多份拷贝，那是**两套真相**，
  //    必然长出「开了这一个、那个被顶掉」的 bug（0.7.6 的 B1 就是这类事故）。
  //    所以这里只拆 **DOM**：四个平级的子容器，闭包一个都不多。
  //    旧块里那两个 `.ai-f-label` 小标题（「可以让它读」「可以让它做」）已删 —— 区标题接管了这个角色。
  const gate = el('div', 'ai-task');
  const readSec = el('div', 'ai-task');
  const writeSec = el('div', 'ai-task');
  const recordSec = el('div', 'ai-task');
  // 常驻块：安全承诺 + 总开关（不属于任何区，也不出现在导航里）
  gate.innerHTML = `
    <div class="ai-guard">密码库与对话的数据永远不会发送给 AI —— 这里没有开关，也不会有。</div>
    <button class="ai-switch" type="button" data-ai="toolson" aria-pressed="false">
      <span>让 AI 调用工具</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <div class="ai-note">关掉后，AI 只能聊天，不会读取你的任何数据，也不会提议新建任何东西。</div>`;
  // 区一：读工具
  // ⭐⭐ 2026-10-19（截图：「移除这些开关的提示语」）—— 每个开关下面那句
  //    「打开后，你的任务标题、截止时间、优先级与归属会被发送给你配置的模型。」整块撤掉：
  //    七个开关说了七遍同一件事（「打开后…会被发送给你配置的模型」），
  //    而**这一区顶上那句已经把规则说清楚了**（「打开哪一项，AI 才读得到哪一项」）。
  //    ⛔ 别把逐项明细加回来 —— 用户要判断的是「要不要给这一项」，不是逐字读一遍字段清单。
  readSec.innerHTML = `
    <div class="ai-note">打开哪一项，AI 才读得到哪一项；没打开的，一个字都不会发出去。</div>
    <div class="ai-note" data-ai="offhintread" hidden>总开关关着，这些暂不生效。</div>
    <button class="ai-switch" type="button" data-ai="readtasks" aria-pressed="false">
      <span>读我的任务板</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readtt" aria-pressed="false">
      <span>读我的课表</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readledger" aria-pressed="false">
      <span>读我的记账</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readbm" aria-pressed="false">
      <span>读我的收藏夹</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readidea" aria-pressed="false">
      <span>读我的随手记</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readhw" aria-pressed="false">
      <span>读我的数码设备台账</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readtrip" aria-pressed="false">
      <span>读我的行程与车票</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readassets" aria-pressed="false">
      <span>读我的资产台账</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readcal" aria-pressed="false">
      <span>读我的日历日程</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readpomo" aria-pressed="false">
      <span>读我的专注统计</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="readcollab" aria-pressed="false">
      <span>读我参与的协作项目</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <div class="ai-verdict" data-ai="readsum">正在读取…</div>`;
  // 区二：写工具
  // ⭐⭐ 第二轮（截图：「这里的提示语也删掉」）—— 与读区同一刀：
  //    六个开关下面那六句「AI 可以提议…；每次都会先给你看，你点确认才会…」整块撤掉
  //    （同一件事说了六遍），底部那句「AI 可以提议建任务与记账与…」的汇总也撤掉 ——
  //    ⛔ 别把逐项明细加回来：用户要判断的是「要不要放开这一项」，不是逐条读一遍
  //    「点了会怎样」（区顶那句已经把「只会生成提议」说清楚了）。
  //    ⚠️ 服务端 `lib/tools-write.js` 的 `PANEL_WRITE` **一句不少地留着**（`GET /api/ai/tools`
  //    照旧回给界面），它是「界面上说只提议、实际落了库」这类事故的对账依据。
  writeSec.innerHTML = `
    <div class="ai-note">写操作永远只生成「提议」，真正落库那一下永远由你点。</div>
    <div class="ai-note" data-ai="offhintwrite" hidden>总开关关着，这些暂不生效。</div>
    <button class="ai-switch" type="button" data-ai="writetasks" aria-pressed="false">
      <span>让它提议建任务</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writeledger" aria-pressed="false">
      <span>让它提议记账</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writebm" aria-pressed="false">
      <span>让它提议收藏网址</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writeidea" aria-pressed="false">
      <span>让它提议记随手记</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writehw" aria-pressed="false">
      <span>让它提议登记数码设备</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writetrip" aria-pressed="false">
      <span>让它提议建车票</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writeassets" aria-pressed="false">
      <span>让它提议记资产</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <button class="ai-switch" type="button" data-ai="writecal" aria-pressed="false">
      <span>让它提议建日程</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <div class="ai-verdict" data-ai="writesum">正在读取…</div>`;
  // 区三：使用记录（审计）
  recordSec.innerHTML = `
    <button class="ai-switch" type="button" data-ai="audit" aria-pressed="true">
      <span>记录 AI 用过哪些工具</span><span class="ai-switch-pill" aria-hidden="true"></span>
    </button>
    <div class="ai-note">只记工具名、参数摘要与成败 —— 不记内容，也不记任何密钥。</div>
    <div class="ai-f">
      <div class="ai-note">每个账号一份记录文件，只记最近 200 条 —— 重启也在。</div>
      <div data-ai="auditlist"></div></div>
    <div class="ai-note" data-ai="toolsmsg" hidden></div>`;

  /**
   * 功能：按 `data-ai` 名取节点 —— ⚠️ **在四个子容器里依次找**。
   *
   * 说明：拆分之后这些节点**不再是同一个 root 的后代**（它们分散在常驻块与三个区里），
   *      而它们又要被同一份闭包统一 paint ⇒ 取节点必须跨这四个容器找。
   * @param {string} name - `data-ai` 的值
   * @returns {?HTMLElement} 命中的节点（没有为 null，与拆分前的 `root.querySelector` 同语义）
   */
  const scopes = [gate, readSec, writeSec, recordSec];
  function q(name) {
    for (const scope of scopes) {
      const hit = scope.querySelector(`[data-ai="${name}"]`);
      if (hit) return hit;
    }
    return null;
  }

  const msgBox = q('toolsmsg');
  const auditBox = q('auditlist');
  const readSum = q('readsum');
  const writeSum = q('writesum');
  let cfg = { toolsEnabled: false, toolsRead: [], toolsWrite: [], toolsAudit: true };

  /**
   * 功能：把一个开关画成开 / 关的样子（类名与文案都是 1 期那一套，不新造样式）。
   * @param {string} name - 开关的 `data-ai` 名
   * @param {boolean} on - 开为 true
   * @returns {void}
   */
  function paintSwitch(name, on) {
    const btn = q(name);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('data-on', on ? '1' : '0'); // ⭐ 药丸：只留类 + aria-pressed + data-on
  }

  /**
   * 功能：**读区**那句结论 —— 只谈「读得到什么」（总开关关着时明说读不到）。
   *
   * 说明：⚠️ 这是**界面上的结论句**，与 `PANEL_READ` 里那几句风险告知**不是一回事** ——
   *      ⛔ 别拿这里的句子去替 PANEL 的任何一句（那几句必须逐字留在源码里，测试盯着）。
   * @returns {string} 一句人话
   */
  function readSummaryText() {
    if (!cfg.toolsEnabled) return '现在是关闭状态 —— AI 读不到你的任何数据。';
    const reads = [];
    if (cfg.toolsRead.includes('tasks')) reads.push('任务板');
    if (cfg.toolsRead.includes('timetable')) reads.push('课表');
    if (cfg.toolsRead.includes('ledger')) reads.push('记账');
    if (cfg.toolsRead.includes('bookmarks')) reads.push('收藏夹');
    if (cfg.toolsRead.includes('idea')) reads.push('随手记');
    if (cfg.toolsRead.includes('digital')) reads.push('数码台账');
    if (cfg.toolsRead.includes('trip')) reads.push('行程');
    if (cfg.toolsRead.includes('assets')) reads.push('资产台账');
    if (cfg.toolsRead.includes('calendar')) reads.push('日历');
    if (cfg.toolsRead.includes('pomodoro')) reads.push('专注统计');
    if (cfg.toolsRead.includes('collab')) reads.push('协作项目');
    if (!reads.length) return '已打开，但还没授权任何数据 —— 上面这几项 AI 一项都读不到。';
    return `AI 现在能读：${reads.join('、')}。`;
  }

  /**
   * 功能：**写区**那句结论 —— 只谈「能不能提议新建东西」。
   *
   * 说明：⚠️ 第二轮把它从「AI 可以提议建任务与记账与…；每次都要你点确认才会真的落库。」
   *      改成**纯状态句**：前半句用顿号列全（原来连「与」读起来像一句话套一句话），
   *      后半句「每次都要你点确认」撤掉 —— 区顶那句「写操作永远只生成『提议』」已经说过了，
   *      这里再说一遍就是同一件事的第三遍。⛔ 别把「提议 → 确认 → 落库」的流程再写回这一行。
   * @returns {string} 一句人话
   */
  function writeSummaryText() {
    if (!cfg.toolsEnabled) return '现在是关闭状态 —— AI 不会提议新建任何东西。';
    const can = [];
    if (cfg.toolsWrite.includes('tasks')) can.push('建任务');
    if (cfg.toolsWrite.includes('ledger')) can.push('记账');
    if (cfg.toolsWrite.includes('bookmarks')) can.push('收藏网址');
    if (cfg.toolsWrite.includes('idea')) can.push('记随手记');
    if (cfg.toolsWrite.includes('digital')) can.push('登记数码设备');
    if (cfg.toolsWrite.includes('trip')) can.push('建车票');
    if (cfg.toolsWrite.includes('assets')) can.push('记资产');
    if (cfg.toolsWrite.includes('calendar')) can.push('建日程');
    if (!can.length) return '已打开，但还没允许它提议新建任何东西。';
    return `AI 现在可以提议：${can.join('、')}。`;
  }

  /**
   * 功能：**手机端入口行**的三个摘要文案 —— 只讲「这一项现在是什么状态」。
   *
   * 说明：⚠️ 与上面两句「结论句」不是一回事：结论句是给**区里面**读的完整判断（含总开关关着时
   *      的说明），入口行只有一行字的宽度，只报这一项自己的状态（总开关状态由常驻块表达）。
   * @returns {string} 一句短文案
   */
  function readRowText() {
    const reads = [];
    if (cfg.toolsRead.includes('tasks')) reads.push('任务板');
    if (cfg.toolsRead.includes('timetable')) reads.push('课表');
    if (cfg.toolsRead.includes('ledger')) reads.push('记账');
    if (cfg.toolsRead.includes('bookmarks')) reads.push('收藏夹');
    if (cfg.toolsRead.includes('idea')) reads.push('随手记');
    if (cfg.toolsRead.includes('digital')) reads.push('数码台账');
    if (cfg.toolsRead.includes('trip')) reads.push('行程');
    if (cfg.toolsRead.includes('assets')) reads.push('资产');
    if (cfg.toolsRead.includes('calendar')) reads.push('日历');
    if (cfg.toolsRead.includes('pomodoro')) reads.push('专注');
    if (cfg.toolsRead.includes('collab')) reads.push('协作项目');
    return reads.length ? reads.join('、') : '没有授权任何数据';
  }

  /** 功能：入口行 —— 写区状态。 @returns {string} 「可以提议建任务」或「未允许」 */
  function writeRowText() {
    const can = [];
    if (cfg.toolsWrite.includes('tasks')) can.push('建任务');
    if (cfg.toolsWrite.includes('ledger')) can.push('记账');
    if (cfg.toolsWrite.includes('bookmarks')) can.push('收藏网址');
    if (cfg.toolsWrite.includes('idea')) can.push('记随手记');
    if (cfg.toolsWrite.includes('digital')) can.push('登记数码设备');
    if (cfg.toolsWrite.includes('trip')) can.push('建车票');
    if (cfg.toolsWrite.includes('assets')) can.push('记资产');
    if (cfg.toolsWrite.includes('calendar')) can.push('建日程');
    return can.length ? `可以提议${can.join('与')}` : '未允许';
  }

  /** 功能：入口行 —— 使用记录（审计）开关状态。 @returns {string} 「已开启」或「已关闭」 */
  function recordRowText() {
    return cfg.toolsAudit ? '已开启' : '已关闭';
  }

  /**
   * 功能：按当前配置重画这几块（开关形态 + 读 / 写两区各一句汇总）。
   * @returns {void}
   */
  function paint() {
    paintSwitch('toolson', cfg.toolsEnabled);
    paintSwitch('readtasks', cfg.toolsRead.includes('tasks'));
    paintSwitch('readtt', cfg.toolsRead.includes('timetable'));
    paintSwitch('readledger', cfg.toolsRead.includes('ledger'));
    paintSwitch('readbm', cfg.toolsRead.includes('bookmarks'));
    paintSwitch('readidea', cfg.toolsRead.includes('idea'));
    paintSwitch('readhw', cfg.toolsRead.includes('digital'));
    paintSwitch('readtrip', cfg.toolsRead.includes('trip'));
    paintSwitch('readassets', cfg.toolsRead.includes('assets'));
    paintSwitch('readcal', cfg.toolsRead.includes('calendar'));
    paintSwitch('readpomo', cfg.toolsRead.includes('pomodoro'));
    paintSwitch('readcollab', cfg.toolsRead.includes('collab'));
    paintSwitch('writetasks', cfg.toolsWrite.includes('tasks'));
    paintSwitch('writeledger', cfg.toolsWrite.includes('ledger'));
    paintSwitch('writebm', cfg.toolsWrite.includes('bookmarks'));
    paintSwitch('writeidea', cfg.toolsWrite.includes('idea'));
    paintSwitch('writehw', cfg.toolsWrite.includes('digital'));
    paintSwitch('writetrip', cfg.toolsWrite.includes('trip'));
    paintSwitch('writeassets', cfg.toolsWrite.includes('assets'));
    paintSwitch('writecal', cfg.toolsWrite.includes('calendar'));
    paintSwitch('audit', cfg.toolsAudit);
    readSum.textContent = readSummaryText();
    writeSum.textContent = writeSummaryText();
    // ⭐ 0.7.6（A6）：总开关关着 ⇒ 下面四个开关变淡 + **读 / 写两区顶上各一句**说明。
    //    ⛔ 刻意**不 disabled、不隐藏**：允许用户先把权限配好，也避免「关一次就丢状态」；
    //    点了照旧保存（后端本来就不看它们，总开关关着一律不生效）。
    //    ⚠️ 两句说明必须是**两个不同的 data-ai 名** —— 它们现在住在两个区里，
    //       而 `q()` 只返回第一个命中的节点（同名会让其中一句永远不显示）。
    for (const n of ['offhintread', 'offhintwrite']) q(n).hidden = cfg.toolsEnabled;
    // ⚠️ 0.8.4：这一串是**逐项**列的（⛔ 别写成「读区全部 + 写区全部」那种推导）——
    //    漏一个开关的表现是「那一颗在保存处理中仍可点」，而它写的是同一份配置。
    for (const n of [
      'readtasks',
      'readtt',
      'readledger',
      'readbm',
      'readidea',
      'readhw',
      'readtrip',
      'readassets',
      'readcal',
      'readpomo',
      'readcollab',
      'writetasks',
      'writeledger',
      'writebm',
      'writeidea',
      'writehw',
      'writetrip',
      'writeassets',
      'writecal',
      'audit',
    ]) {
      q(n).classList.toggle('ai-off', !cfg.toolsEnabled);
    }
  }

  // ⭐ 0.7.6（B2）：去重 —— 拨一次开关会依次走到 `fill()` 与面板的 `sync()`，两处都调本函数，
  //    于是每次都打两次 `/api/ai/audit`（列表还会闪一下）。复用同一个未决请求即可。
  /** @type {?Promise.<void>} 正在读审计的那次请求（没在读时为 null） */
  let auditInflight = null;

  /**
   * 功能：把「AI 用过哪些工具」画成几行 —— ⛔ 只画工具名 / 参数摘要 / 成败与拒绝原因。
   *
   * 说明：⭐ 0.8.5：审计从「**进程内**环形缓冲、重启即清」改成
   *      **落文件 `ai-<uid>.log`**（见 `core/logs.js` 的文件头）⇒ 旧文案里那句「随重启清空」
   *      已经不成立，换成「每个账号一份记录文件 …… 重启也在」。
   *      ⛔ 别再写回旧文案：`ai.test.js` 的 3期-4-1 与 `ai-probe.js` 的 G6 都盯着这一条，
   *      而且是**对整个文件做串扫描** —— ⚠️ 连**注释里**出现旧串都会让它们红（这次就踩了一脚）。
   *      ⚠️ 只回**自己**的（文件名里带 uid）；管理员在「全局设置 → 日志」里能看全部。
   *      ⚠️ 每行都用 `textContent` 拼 —— 审计里虽然没有用户内容，但「不拼 HTML」是本模块
   *      一以贯之的口径，别开特例。
   * @returns {Promise.<void>} 本次读取（或正在读的那一次）
   */
  function loadAudit() {
    if (auditInflight) return auditInflight;
    auditInflight = (async () => {
      let items;
      try {
        const r = await api('GET', '/api/ai/audit');
        items = r && Array.isArray(r.items) ? r.items : [];
      } catch (_e) {
        auditBox.textContent = '暂时读不到记录（不影响上面的开关）。';
        return;
      }
      auditBox.textContent = '';
      if (!items.length) {
        auditBox.appendChild(noteLine('这个账号还一次都没用过。'));
        return;
      }
      // 服务端是「最新在前」，这里按时间正序读下来更像一份流水
      for (const it of items.slice().reverse()) {
        const args = it.args ? `（${it.args}）` : '';
        const how = it.ok ? '成功' : `被拒：${it.reason || '未授权'}`;
        auditBox.appendChild(noteLine(`${it.at || ''} ${it.tool || ''}${args} —— ${how}`));
      }
    })().finally(() => {
      auditInflight = null;
    });
    return auditInflight;
  }

  /** 功能：建一行小字。 @param {string} text - 行文本 @returns {HTMLElement} 行节点 */
  function noteLine(text) {
    const d = el('div', 'ai-note');
    d.textContent = text;
    return d;
  }

  /**
   * 功能：把一份配置视图填进本块（初次加载 / 自己保存之后 / 别处保存时同步过来）。
   * @param {Object} v - 配置视图（`GET|PUT /api/ai/config` 的响应）
   * @returns {void}
   */
  function fill(v) {
    cfg = {
      toolsEnabled: !!v.toolsEnabled,
      toolsRead: Array.isArray(v.toolsRead) ? v.toolsRead : [],
      toolsWrite: Array.isArray(v.toolsWrite) ? v.toolsWrite : [],
      toolsAudit: !!v.toolsAudit,
    };
    paint();
    // 顺带刷新审计列表（开关一拨、面板一开都会走到这里）
    loadAudit();
  }

  /** 这一块里「点了就存」的开关（保存处理中一起禁用 —— 它们写的是同一份配置） @type {Array.<string>} */
  const TOOL_SWITCHES = [
    'toolson',
    'readtasks',
    'readtt',
    'readledger',
    'readbm',
    'readidea',
    'readhw',
    'readtrip',
    'readassets',
    'readcal',
    'readpomo',
    'readcollab',
    'writetasks',
    'writeledger',
    'writebm',
    'writeidea',
    'writehw',
    'writetrip',
    'writeassets',
    'writecal',
    'audit',
  ];
  // ⭐ 0.7.6（B1）：串行守卫。快速连点两个开关时，第二次 PUT 必须**等第一次的结果回来**再发 ——
  //    否则两次请求都基于「点击那一刻的本地 cfg」，后发的那次会把前一次改动**顶掉**
  //    （现场：连点「读我的任务板」+「读我的课表」，刷新后只剩一个）。
  let saving = false;

  /** 功能：把这一组开关临时禁用（保存处理中）。 @param {boolean} on - 禁用为 true @returns {void} */
  function setSwitchesDisabled(on) {
    for (const n of TOOL_SWITCHES) q(n).disabled = on;
  }

  /**
   * 功能：保存一项授权并刷新（失败就把界面拨回服务端的真值）。
   *
   * 说明：⭐ 0.7.6（B1）：**串行化** —— 处理中直接忽略新的点击（同组开关在这期间本来就是禁用的），
   *      等响应回来再按服务端返回的视图重画。
   * @param {Object} patch - 要写的键（只带这一个键，与「带哪个键写哪个键」同口径）
   * @returns {Promise.<void>}
   */
  async function put(patch) {
    if (saving) return;
    saving = true;
    setSwitchesDisabled(true);
    try {
      const v = await api('PUT', '/api/ai/config', patch);
      fill(v);
      sync(v);
    } catch (e) {
      toast(e.message, true);
      try {
        fill(await api('GET', '/api/ai/config'));
      } catch (_e) {
        /* 连读都读不到时保持原样：上面那条 toast 已经说了失败 */
      }
    } finally {
      saving = false;
      setSwitchesDisabled(false);
    }
  }

  /**
   * 功能：把一个模块名从清单里加上 / 去掉（返回**新数组**，不改原值）。
   * @param {Array.<string>} list - 现清单
   * @param {string} name - 模块名
   * @returns {Array.<string>} 新清单
   */
  function toggled(list, name) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const i = arr.indexOf(name);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(name);
    return arr;
  }

  q('toolson').addEventListener('click', () => put({ tools_enabled: !cfg.toolsEnabled }));
  q('audit').addEventListener('click', () => put({ tools_audit: !cfg.toolsAudit }));
  q('readtasks').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'tasks') }));
  q('readtt').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'timetable') }));
  q('readledger').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'ledger') }));
  q('readbm').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'bookmarks') }));
  q('readidea').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'idea') }));
  q('readhw').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'digital') }));
  q('readtrip').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'trip') }));
  q('readassets').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'assets') }));
  q('readcal').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'calendar') }));
  q('readpomo').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'pomodoro') }));
  q('readcollab').addEventListener('click', () => put({ tools_read: toggled(cfg.toolsRead, 'collab') }));
  q('writetasks').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'tasks') }));
  q('writeledger').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'ledger') }));
  q('writebm').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'bookmarks') }));
  q('writeidea').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'idea') }));
  q('writehw').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'digital') }));
  q('writetrip').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'trip') }));
  q('writeassets').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'assets') }));
  q('writecal').addEventListener('click', () => put({ tools_write: toggled(cfg.toolsWrite, 'calendar') }));
  // ⭐ 0.7.6（本轮）：这一块交出去的是**一个常驻块 + 三个区**（而不是原来的单个 node）。
  //    `gate` 由面板挂在导航下面（不在导航里、不属于任何区）；`sections` 的 key 只用于 id。
  return {
    gate,
    sections: [
      { key: 'read', title: 'AI 读工具', hint: SAME_HINT, node: readSec, summary: readRowText },
      { key: 'write', title: 'AI 写工具', hint: SAME_HINT, node: writeSec, summary: writeRowText },
      {
        key: 'record',
        title: 'AI 使用记录',
        hint: SAME_HINT,
        node: recordSec,
        summary: recordRowText,
        // ⭐ 手机端打开这一区时顺手刷一次审计（打开就要看最新流水）；电脑端不用（面板一次性填好）
        whenOpen: () => loadAudit(),
      },
    ],
    fill,
    fail: (m) => {
      msgBox.hidden = false;
      msgBox.textContent = m;
    },
  };
}

/**
 * 功能：装配 AI 配置的**六个区**（两端共用同一份内容）—— 常驻块 + 六区清单 + 取数入口。
 *
 * 说明：⭐ 0.7.6（M0）：从 `createAiPanel()` 里抽出来的。电脑端把六个区铺成「左导航 + 右内容」，
 *      手机端把它们收进**六个入口行各自的底部弹层**（一次只看一区）—— 但两端的区是
 *      **同一份 DOM 节点、同一份闭包状态**，⛔ 不许为手机端另建一套块：那会让 `cfg` 出现两份拷贝
 *      （两套真值），必然重演「开了这一个、那个被顶掉」（0.7.6 批次 B1 的根因）。
 *      ⭐ 顺序固定：连接设置 → 对话上下文 → 长期记忆 → AI 读工具 → AI 写工具 → AI 使用记录 ——
 *      「先能连上 → 再定带多少上下文 → 再定记住什么 → 最后才谈放权」，越往后越要用户多想一步。
 *      ⚠️ 取数只用**两个并行请求**：`GET /api/ai/config`（各块共用）+ `GET /api/ai/memories`（记忆块）。
 *      ⚠️ 工具那一块交上来的是「一个常驻块 + 三个区」：常驻块（安全承诺 + 总开关）**不属于任何区**
 *      （所以它既不进导航、也没得跳），由两端自己决定挂哪儿。
 *
 * @param {{toast: Function, ask: Function, onSaved?: Function}} host - 端注入（toast / 二次确认 /
 *        可选的「保存成功后」回调 —— 手机端用它把入口行的摘要一起刷新，见 `mobile.js`）
 * @returns {{gate: HTMLElement, sections: Array.<{key: string, title: string, hint: string,
 *          node: HTMLElement, summary: Function, whenOpen?: Function}>, refresh: Function,
 *          loadSeg: Function}} 常驻块 + 六区清单 + 「重新取数」/「重读对话进度」入口
 */
export function createAiSections(host) {
  // ⭐ 手机端的入口行与这里的区是**两份状态**：任一块保存成功之后，行上的摘要得跟着变，
  //    否则会出现「弹层里改完了、退回屏上还是旧状态」。怎么知道「保存成功了」——
  //    就是下面这个 `sync()`（它本来就是「任一块保存成功后把最新视图推给其他块」的钩子）。
  const onSaved = host && typeof host.onSaved === 'function' ? host.onSaved : null;
  const sync = (v) => {
    conn.fill(v, { keepInputs: true });
    ctx.fill(v);
    mem.fill(v);
    tool.fill(v);
    if (onSaved) onSaved(v);
  };
  const conn = createAiConnBlock(host, { sync });
  const ctx = createAiCtxBlock(host, { sync });
  const mem = createAiMemBlock(host, { sync });
  const tool = createAiToolsBlock(host, { sync });

  const sections = [
    {
      key: 'conn',
      title: '连接设置',
      hint: '地址、模型名与密钥改完，要点下面那颗「保存连接设置」才生效。',
      node: conn.node,
      summary: conn.summary,
    },
    { key: 'ctx', title: '对话上下文', hint: SAME_HINT, node: ctx.node, summary: ctx.summary },
    { key: 'mem', title: '长期记忆', hint: SAME_HINT, node: mem.node, summary: mem.summary },
    // 读 / 写 / 记录三区由工具块给出（顺序即「读 → 写 → 记录」）
    ...tool.sections,
  ];

  /**
   * 功能：重新取数并回填六区（两端共用的入口）。
   *
   * 说明：⚠️ 两个页面级请求**并行**发出（首屏能合并的就得合并）；
   *      失败时把原因写进面板（不静默），并**继续抛给调用方** —— 手机端的入口行
   *      也要知道读失败（它要把原因写在行的摘要位置）。
   * @returns {Promise.<void>}
   */
  async function refresh() {
    try {
      const [v] = await Promise.all([api('GET', '/api/ai/config'), mem.loadList()]);
      conn.fill(v);
      ctx.fill(v);
      mem.fill(v);
      tool.fill(v);
    } catch (e) {
      conn.fail(`配置读取失败：${e.message}`);
      tool.fail(`能力开关读取失败：${e.message}`);
      throw e;
    }
  }

  return { gate: tool.gate, sections, refresh };
}

/**
 * 功能：组装 **电脑端 AI 卡片屏** —— 左侧竖排导航 + 右侧六个区（锚点版，一次看到全部）。
 *
 * 说明：⭐ 内容与手机端是**同一份**（都来自 `createAiSections()`），差别只在摆法：
 *      电脑端屏宽、可以「左导航 + 右内容」；手机端屏窄，改成「入口行 + 每区一个弹层」。
 *      ⚠️ 不做「一次只显示一个区」的 tab —— 那会牵扯手机端每屏的 history 规矩。
 *
 * @param {{toast: Function, ask: Function, onSaved?: Function}} host - 端注入（toast / 二次确认）
 * @returns {{node: HTMLElement, refresh: Function}} 面板根节点 + 「重新取数并回填六区」入口
 *          （异步把内容填进来，先把骨架交出去）
 */
export function createAiPanel(host) {
  const box = el('div', 'ai-cfg');
  const built = createAiSections(host);
  const SECTIONS = built.sections;
  const nav = el('nav', 'ai-cfg-nav');
  nav.setAttribute('aria-label', '配置分区');
  const body = el('div', 'ai-cfg-body');
  // ⭐ 常驻块挂在**导航下方、第一个区之前**（`ai-cfg-body` 里）。
  //    ⚠️ 刻意不塞进 `.ai-cfg` 里排在 nav 前面：那个容器在电脑端是**两栏 grid**（左导航 + 右内容），
  //      多一个直接子节点会把三块挤成「gate 左上 / nav 右上 / body 左下」。
  //      挂进 body 首部既满足「常驻、不在导航里、在导航下方」，也不动任何布局规则。
  body.appendChild(built.gate);
  const items = SECTIONS.map((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-nav-item';
    btn.textContent = s.title;
    const sec = el('section', 'ai-sec');
    sec.id = `ai-sec-${s.key}`;
    sec.setAttribute('aria-labelledby', `ai-sec-${s.key}-t`);
    const h = document.createElement('h2');
    h.className = 'ai-sec-title';
    h.id = `ai-sec-${s.key}-t`;
    h.textContent = s.title;
    const hint = document.createElement('p');
    hint.className = 'ai-sec-hint';
    hint.textContent = s.hint;
    sec.append(h, hint, s.node);
    nav.appendChild(btn);
    body.appendChild(sec);
    return { btn, sec };
  });
  box.append(nav, body);

  /** 功能：是否要求减少动态效果（系统偏好在，就不做平滑滚动）。 @returns {boolean} 减少为 true */
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /**
   * 功能：把「当前在看哪一区」画到导航上（高亮 + `aria-current`）。
   * @param {number} i - 区序号
   * @returns {void}
   */
  let active = -1;
  function mark(i) {
    if (i < 0 || i === active) return;
    active = i;
    items.forEach((it, k) => {
      const on = k === i;
      it.btn.classList.toggle('on', on);
      if (on) it.btn.setAttribute('aria-current', 'true');
      else it.btn.removeAttribute('aria-current');
    });
    // ⭐ 0.7.6：导航**横向可滚**时，切到靠后的区要把选中的那颗滚进视野
    //    （否则它停在屏幕外，用户看不到自己点的是哪个）。
    //    ⚠️ 手机端现在**不再渲染导航**（改成「入口行 + 每区一个弹层」，见 `mobile.js`），
    //      所以这段眼下只有「电脑端左竖列」一种情形 —— 竖列时 `scrollWidth ≈ clientWidth`，
    //      这个判断是空操作。保留它是为了将来真有横滚导航时不必再想一遍。
    //    ⚠️ `block` 必须是 `'nearest'` —— 用默认值会把整个页面纵向拽一下，而用户此刻正滚着区。
    if (nav.scrollWidth > nav.clientWidth + 1) {
      const onBtn = items[i].btn;
      if (onBtn.scrollIntoView) onBtn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  // 点导航 → 滚到对应区（`scroll-margin-top` 由两端 CSS 给，手机端的 sticky 导航才不会盖住区标题）
  items.forEach((it, i) => {
    it.btn.addEventListener('click', () => {
      const sec = it.sec;
      if (sec.scrollIntoView) sec.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
      mark(i);
    });
  });
  mark(0);

  // 滚动时高亮：优先 IntersectionObserver（拿不准可见性时保持原样，不来回跳）；
  // 退化到滚动监听 —— 滚动事件不冒泡，得挂到**真正滚动的那个祖先**上
  // （桌面端是 `.main`、手机端是这一屏自己，两端都不是 box 本身）。
  if (typeof IntersectionObserver === 'function') {
    const seen = new Map();
    const obs = new IntersectionObserver(
      (entries) => {
        // 整屏被换掉之后（桌面端每次进屏重建）就自我断开，别一直抱着已移除的节点
        if (!box.isConnected) {
          obs.disconnect();
          return;
        }
        for (const e of entries) seen.set(e.target, e.isIntersecting);
        const idx = items.findIndex((it) => seen.get(it.sec));
        if (idx >= 0) mark(idx);
      },
      { rootMargin: '-15% 0px -60% 0px', threshold: 0 },
    );
    items.forEach((it) => obs.observe(it.sec));
  } else {
    let scroller = box.parentElement;
    while (scroller && scroller !== document.body) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      scroller = scroller.parentElement;
    }
    let raf = 0;
    const pick = () => {
      raf = 0;
      if (!box.isConnected) return;
      const top = box.getBoundingClientRect().top;
      let idx = 0;
      items.forEach((it, k) => {
        if (it.sec.getBoundingClientRect().top - top <= 80) idx = k;
      });
      mark(idx);
    };
    (scroller || window).addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(pick);
      },
      { passive: true },
    );
  }

  /**
   * 功能：重新取一次配置，把六区填成最新值，并重读一次对话进度。
   * @returns {Promise.<void>}
   */
  async function refresh() {
    await built.refresh();
  }
  // 首次加载：失败原因已经写在面板里，这里吞掉免得变成 unhandled rejection
  refresh().catch(() => {});
  return { node: box, refresh };
}
