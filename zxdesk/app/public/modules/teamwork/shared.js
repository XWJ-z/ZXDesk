/**
 * modules/teamwork/shared.js —— 对话**两端共用**的卡片消息渲染（0.6.4，任务联动）
 *
 * 功能：任务卡片消息的**渲染与动作**都收在这一份里，两端只负责把它塞进自己的消息行：
 *      · `isCardMsg(m)`     判断一条消息是不是卡片；
 *      · `taskCardHtml(m)`  一张卡片的 HTML（署名 / 标题 / 截止 / 重要· 紧急 / 备注 + 动作按钮）；
 *      · `cardActionsOf(m)` 派发 `zx:teamwork-card-actions` **留白事件**，收集「谁能给这张卡片加动作」；
 *      · `runCardAction(m, k)` 点按钮时**重新收集**并执行 —— 渲染路径与点击路径各收集一次，
 *        中间不存任何状态（与 `zx:teamwork-msg-menu` 同一套规矩）。
 *
 * ⭐ **为什么是一份**（本项目「该一致的只留一份」的口径；先例：`modules/hardware/shared.js`）：
 *    卡片里那几个字段的名字、以及「哪些文本必须转义」，是**两端必须逐字一致**的契约 ——
 *    写两份的结果不是报错，而是「电脑端画出来了、手机端少一行」这种只在真机上才看得见的分叉
 *    （对话模块已经有过一次教训：消息形状的归一函数只有电脑版有，见 `11` 的记录）。
 *
 * ⭐ **卡片是快照、不是活的**：卡片里的一切都来自发送那一刻的 `meta`，
 *    本文件**不去查任务状态**、也不反查发送者的名字画像 —— 收件人看不到发送者的任务数据
 *    （本项目多用户是数据隔离的，管理员也看不到成员的任务）。要「活的」就等于开一条越权通道。
 *
 * ⚠️ **XSS 口径**：卡片里的标题 / 备注 / 署名全部是**对方可控内容** ⇒ 一律 `esc()`；
 *    `data-card-act` 里只放归一成 `[A-Za-z0-9_:-]` 的动作键，**不含任何用户内容**
 *    （与 `data-teamwork-*` 那条机械断言同一个理由）。
 *
 * ⚠️ **不认识这个 `kind` 的渲染端看到的仍是 `body`**（服务端强制它必填，是**降级文本**）——
 *    所以这里画失败、或者旧版本客户端打开，都只是「少一张卡片」，不会丢消息。
 *
 * @author zx
 * @date   2026-09-16
 * @since 0.8.54
 * 相关：docs/公共/架构文档/17-对话.md、05-任务板.md、13-决策记录.md（决策 87）
 */

// ⭐ 0.8.54：发送任务弹层的**取数**也挪到这里 —— 两端本来就是一字不差的两份
//    （复制粘贴出来的），而 `api()` 本来就是两端同一个 `core/api.js`。
import { api } from '../../core/api.js';
import { esc } from '../../core/dom.js';
// ⭐ 0.8.54：图片消息的 URL 必须带应用挂载前缀（网关下 `/app/zxdesk/...`），⛔ 不写死 `/api/...`。
import { BASE } from '../../core/api.js';

/**
 * ⭐ 0.8.54：**图片消息**的种类标识 —— 与服务端 `modules/teamwork/lib/chat-image.js` 的
 * `IMAGE_KIND` 是**同一份契约的两端**（那边决定怎么落盘、这边决定怎么画）。
 * ⚠️ 它**不在**客户端可发白名单里：图片消息只能由上传路由造出来。
 * @type {string}
 */
export const IMAGE_KIND = 'image';

/**
 * 卡片消息的种类标识 —— 与服务端 `core/validate.js` 的 `TEAMWORK_KINDS` 是**同一份契约的两端**：
 * 那边是白名单（收不收这个 kind），这边是渲染分派（认不认这个 kind）。改一处必须改另一处。
 * @type {string}
 */
export const CARD_KIND = 'task_card';

/**
 * ⭐ **四种系统提醒**的消息种类（0.7.7）—— 与服务端 `core/validate.js` 的 `TEAMWORK_BUILTIN_KINDS`
 * 是**同一份契约的两端**（那边是「仅服务端可写」的白名单，这边是「认不认这几种卡片」的渲染分派）。
 *
 * 说明：⚠️⭐ 它们**绝不在** `TEAMWORK_KINDS`（客户端可发）里 ⇒ 客户端伪造不了系统提醒。
 *      ⚠️ 改一处必须改另一处；`ttt/test/teamwork.test.js` 有对账断言钉住两边逐字相等
 *      （与 `CARD_KIND` 那条同一手法）。
 * @type {Array.<string>}
 */
export const REMIND_KINDS = ['remind_course', 'remind_task_today', 'remind_overdue', 'remind_care', 'remind_trip'];

/**
 * 五种提醒各自的**图标 / 标题 / 配色类名**（0.7.7；0.8.6 加 `remind_trip`）。
 *
 * 说明：⭐ 颜色**只走既有令牌**（`core/tokens.css` 的 `--zx-warn` / `--zx-brand-2` /
 *      `--zx-danger` / `--zx-ok`），配色写在两端 CSS 里，这里只落 class ——
 *      与「提醒助手暖色」那一条同一个规矩（写死色值的话，改语义色时它会留在原地）。
 *      ⚠️ 图标与标题是**给人看的那半**，服务端只给 `kind`：两端因此必然一致。
 * @type {Object.<string, {icon: string, title: string, cls: string}>}
 */
const REMIND_META = {
  remind_course: { icon: '🔔', title: '上课提醒', cls: 'k-course' },
  remind_task_today: { icon: '📌', title: '今日到期', cls: 'k-task' },
  remind_overdue: { icon: '⏰', title: '逾期汇总', cls: 'k-overdue' },
  remind_care: { icon: '☕', title: '问候', cls: 'k-care' },
  remind_trip: { icon: '🚄', title: '出发提醒', cls: 'k-trip' },
};

/**
 * 功能：判断一条消息是不是**系统提醒卡片**。
 *
 * 说明：⚠️ 认不出来（含**老消息的 kind 是 NULL**）⇒ 一律按普通气泡画 —— 这是**有意的**：
 *      历史消息不该因为一次前端改动就变样，⛔ 不写迁移、不回填。
 * @param {?Object} m - 消息行（REST / SSE / 本地构造都行）
 * @returns {boolean} 是四种提醒之一返回 true
 */
export function isRemindMsg(m) {
  return !!m && REMIND_KINDS.indexOf(String(m.kind == null ? '' : m.kind)) >= 0;
}

/**
 * 功能：一张**提醒卡片**的 HTML（0.7.7）—— 四种各有各的图标、标题与配色。
 *
 * 说明：⭐ 正文照旧是 `body`（它同时是「渲染端不认这个 kind 时」的降级文本），
 *      卡片只是给它套一层「这是什么提醒」的壳 ⇒ 内容与样式互不绑架。
 *      ⚠️ 正文是**服务端拼出来的多行文本**（含课程名 / 任务标题 ⇒ 用户可控内容）⇒ 一律 `esc()`；
 *      换行由 CSS 的 `white-space: pre-wrap` 负责，⛔ 不许为了让换行好看改用 innerHTML 拼。
 *      ⚠️ 认不出这个 kind 时返回空串（调用方画普通气泡）—— 卡片画失败不该让消息消失。
 *
 * @param {Object} m - 提醒消息（读 `kind` / `body`）
 * @returns {string} 卡片 HTML；不是四种提醒时返回空串
 */
export function remindCardHtml(m) {
  if (!isRemindMsg(m)) return '';
  // ⚠️ 这个局部变量**刻意不叫 `meta`**：本文件里 `meta` 是「卡片载荷」的名字（跨账号内容、
  //    必须逐个 esc），而这里的图标与标题是**我们自己写的常量**。同名会让「哪些东西必须转义」
  //    这条线在这份文件里变得含糊（`teamwork.test.js` 也有一条机械断言盯着 `${meta.xxx}` 的写法）。
  const info = REMIND_META[String(m.kind)] || { icon: '🔔', title: '提醒', cls: 'k-course' };
  return (
    `<div class="teamwork-remind ${info.cls}" data-teamwork-remind="${String(m.kind)}">` +
    `<div class="teamwork-remind-head"><span class="teamwork-remind-ico">${info.icon}</span>${info.title}</div>` +
    `<div class="teamwork-remind-body">${esc(String(m.body == null ? '' : m.body))}</div>` +
    `</div>`
  );
}

/**
 * 功能：判断一条消息是不是卡片消息。
 * 说明：⚠️ `kind` 在 REST 与 SSE 两条路上**同名**（不像 `sender_builtin` / `senderBuiltin` 那样
 *      有两套写法），所以这里不需要两个名字都认 —— 但仍然统一走这个函数，
 *      免得将来有人把判断散到两端的渲染代码里（那正是「两端分叉」的起点）。
 * @param {?Object} m - 消息行（REST / SSE / 本地构造都行）
 * @returns {boolean} 是任务卡片返回 true
 */
export function isCardMsg(m) {
  return !!m && String(m.kind == null ? '' : m.kind) === CARD_KIND;
}

/**
 * 功能：判断一条消息要不要**按卡片画**（任务卡片 + 四种系统提醒，0.7.7）。
 *
 * ⭐ 「是不是卡片」只有这一处答案 —— 它是上面两个判断的**并集**，两端各调它一次：
 *    消息行要靠它加 `is-card` 修饰类，卡片才会统一宽度（见两端 CSS 的 `.teamwork-msg.is-card`）。
 *    ⛔ 两端各写一份 `kind` 判断就是「两端分叉」的起点（这正是本文件存在的理由）。
 *
 * ⚠️⭐ **别顺手把 `isCardMsg()` 本身改成「也认 remind_\*」**：它的调用方长这样 ——
 *    `isCardMsg(m) ? taskCardHtml(m): isRemindMsg(m) ? …` ⇒ 改宽之后提醒消息会落进
 *    **任务卡片**那条分支；而 `taskCardHtml()` 读的是 `meta`，提醒的 `meta` 恒为 NULL
 *    （本批刻意不新造字段契约）⇒ 每一条提醒都会画成一张写着「未命名任务」的卡片。
 *
 * @param {?Object} m - 消息行（REST / SSE / 本地构造都行）
 * @returns {boolean} 是卡片消息（任务卡片或四种提醒之一）返回 true
 */
export function isAnyCardMsg(m) {
  return isCardMsg(m) || isRemindMsg(m) || isImageMsg(m);
}

/**
 * 功能：判断一条消息是不是**图片**（⭐ 0.8.54）。
 *
 * 说明：⭐ 判据只写这一处（与 `isCardMsg` / `isRemindMsg` 同一条规矩）：两端渲染都调它，
 *      外层的 `is-card`（定宽）也靠它 —— 图片**不该**占满一屏宽。
 *      ⚠️ 认不出来（`kind` 为空的老消息）⇒ 照旧画普通气泡，⛔ 不回填、不迁移。
 * @param {?Object} m - 消息行（REST / SSE / 本地构造都行）
 * @returns {boolean} 是图片消息返回 true
 */
export function isImageMsg(m) {
  return !!m && String(m.kind == null ? '' : m.kind) === IMAGE_KIND;
}

/**
 * 功能：一条**图片消息**的 HTML（⭐ 0.8.54）—— 一个圆角缩略图，点开看大图。
 *
 * 说明：⚠️ 文件名是**内容寻址**的（`<sha256>.<扩展名>`，见服务端 `lib/chat-image.js`）⇒ 这里只做
 *      「把 sha 与扩展名安全地拼进 URL」，⛔ 不拼任何用户可控的路径片段（防路径穿越）。
 *      ⚠️ 形状不对（sha 不是 64 位 / 没扩展名）⇒ **退回降级文本**（`body` 本来就写着「【图片】名字」），
 *      绝不画一个必然 404 的 `<img>`（那在界面上就是一块碎图）。
 *      ⚠️ `loading="lazy"` ＋ `decoding="async"`：一屏十几张图时不要卡住滚动。
 * @param {Object} m - 图片消息（读 `meta`：`{ name, ext, size, sha }`）
 * @param {number|string} cid - 会话 id（URL 里要它 —— 权限就是按会话判的）
 * @returns {string} 图片 HTML（形状不对时是降级气泡）
 */
export function imageMsgHtml(m, cid) {
  const raw = m && m.meta && typeof m.meta === 'object' ? m.meta : {};
  const sha = String(raw.sha == null ? '' : raw.sha).replace(/[^0-9a-f]/g, '');
  const ext = String(raw.ext == null ? '' : raw.ext).replace(/[^a-z0-9]/g, '');
  const name = String(raw.name == null ? '' : raw.name).trim() || '图片';
  const c = Number(cid);
  if (sha.length !== 64 || !ext || !Number.isInteger(c) || c < 1) {
    return `<div class="teamwork-bubble">${esc(String((m && m.body) || '【图片】'))}</div>`;
  }
  const url = `${BASE}/api/teamwork/images/${c}/${sha}.${ext}`;
  return (
    `<figure class="teamwork-img-box" data-teamwork-img="${url}" data-teamwork-img-name="${esc(name)}">` +
    `<img class="teamwork-img" src="${url}" alt="${esc(name)}" loading="lazy" decoding="async">` +
    `</figure>`
  );
}

/**
 * 功能：给「点开看大图」挂上事件委托（⭐ 0.8.54）—— **各端只调一次**（模块级标记）。
 *
 * 说明：⭐ 判定（点到哪张图）在共用层，**怎么展示**交给各端：电脑端画一层浮层，
 *      手机端走 `openSheet()`（它自己压/退一条 history —— 直接塞一层自绘浮层的话，
 *      按返回键会把整个页面退掉，那是 踩过的坑）。
 * @param {function(string, string): void} onOpen - `(url, name) => void`：各端的展示方式
 * @returns {void}
 */
export function bindImageZoom(onOpen) {
  if (bindImageZoom._bound) return;
  if (typeof onOpen !== 'function') return;
  bindImageZoom._bound = true;
  document.addEventListener('click', (e) => {
    const el = e.target;
    const box = el && typeof el.closest === 'function' ? el.closest('[data-teamwork-img]') : null;
    if (!box) return;
    const url = box.getAttribute('data-teamwork-img') || '';
    if (!url) return;
    onOpen(url, box.getAttribute('data-teamwork-img-name') || '图片');
  });
}

/**
 * 功能：判断一条会话属不属于左栏「**内置助手**」那一组（0.7.7）。
 *
 * ⭐ 判据只写这一处、两端各调一次（两端各写一份 `if` 就是分叉的起点）：
 *    ① 有 `builtin_key` 的会话（提醒助手这类角色会话）算内置助手；
 *    ② 插槽会话条目（`zx:teamwork-conv-entries` 收来的，如 AI 助手）**不经这个函数** ——
 *       它们自己就知道自己是内置助手，两端都是**无条件**放进那一组；
 *    ③ 其余全部（真人 direct）算「好友」，⚠️ **包含** `peer_gone` 的只读会话 ——
 *       那是「一个已经没了的真人」，不是助手。
 *
 * ⚠️ 两组的**组内顺序**照服务端给的顺序（`store.js` 已把内置角色排最前），前端⛔ 不重排。
 *
 * @param {?Object} c - 会话行（读 `builtin_key`）
 * @returns {boolean} 属内置助手那一组返回 true
 */
export function isAssistConv(c) {
  return !!c && !!c.builtin_key;
}

/**
 * 功能：把动作键归一成可以安全写进 `data-card-act` 的形态。
 * 说明：⚠️ 归一后为空的动作**一律丢掉**（见 `cardActionsOf`）—— 一个键都写不出来的按钮，
 *      点下去只会静默没反应，不如干脆不画。
 * @param {?Object} it - 一个动作 `{ key, label, run }`
 * @returns {string} 归一后的键（可能为空串）
 */
function actKey(it) {
  return String(it && it.key != null ? it.key : '').replace(/[^A-Za-z0-9_:-]/g, '');
}

/**
 * 功能：收集「谁能给这张卡片加动作」—— 派发 `zx:teamwork-card-actions` 留白事件。
 *
 * 说明：⭐ 与对话模块自己的消息菜单（`zx:teamwork-msg-menu`）同一套规矩：**派发是同步的**，
 *      监听方在 `detail.items` 上 push 即可（形状 `{ key, label, run(msg) }`）；
 *      **本模块不认识添动作的是谁** —— 没有监听方时事件无人在意，卡片上就没有动作区。
 *      ⚠️ 只收「有 run 函数、且有归一后非空 key、且有 label」的条目。
 *
 * @param {Object} msg - 这条卡片消息（原样交给动作的 `run(msg)`）
 * @returns {Array.<Object>} 动作数组（可能为空）
 */
export function cardActionsOf(msg) {
  const items = [];
  document.dispatchEvent(new CustomEvent('zx:teamwork-card-actions', { detail: { msg, items } }));
  return items.filter((it) => it && typeof it.run === 'function' && actKey(it) && it.label);
}

/**
 * 功能：一张任务卡片的 HTML —— 纯展示（快照）+ 一行由留白事件收集来的动作按钮。
 *
 * 说明：⚠️ 卡片里的每一项都可能**不存在**（任务没有截止日、没有备注、用户没填署名）——
 *      逐项判空后再画，不留空行（空行在气泡里看着像样式坏了）。
 *      ⚠️ 署名写「XX 分享了一个任务」而不是「来自 XX 的任务」：这是**通知**语气，
 *      与实际语义一致（任务仍在发送者自己账下，收件人不持有它）。
 *
 * @param {Object} m - 卡片消息（读 `meta`：`{ title, due, important, urgent, note, from }`）
 * @returns {string} 卡片 HTML
 */
export function taskCardHtml(m) {
  const raw = m && m.meta && typeof m.meta === 'object' ? m.meta : {};
  const title = String(raw.title == null ? '' : raw.title).trim() || '未命名任务';
  const from = String(raw.from == null ? '' : raw.from).trim();
  const note = String(raw.note == null ? '' : raw.note).trim();
  // ⭐ 0.8.54（加号里可以发「协作项目任务」）：协作任务与日常任务的**抬头不一样** ——
  //    协作任务不是「谁分享了我的一条私事」，而是「某个共享项目里的这条任务」，所以写明项目名。
  const src = String(raw.src == null ? '' : raw.src).trim();
  const proj = String(raw.project == null ? '' : raw.project).trim();
  const head =
    src === 'collab'
      ? `📋 分享了${proj ? `「${esc(proj)}」里的` : ''}任务`
      : `📋 ${from ? `${esc(from)} 分享了一个任务` : '分享了一个任务'}`;
  const chips = [];
  if (raw.due) chips.push(`<span class="teamwork-card-chip">📅 截止 ${esc(String(raw.due))}</span>`);
  if (Number(raw.important)) chips.push(`<span class="teamwork-card-chip imp">🔴 重要</span>`);
  if (Number(raw.urgent)) chips.push(`<span class="teamwork-card-chip urg">⏰ 紧急</span>`);
  const acts = cardActionsOf(m);
  return (
    `<div class="teamwork-card" data-teamwork-card="${CARD_KIND}">` +
    `<div class="teamwork-card-head">${head}</div>` +
    `<div class="teamwork-card-title">${esc(title)}</div>` +
    (chips.length ? `<div class="teamwork-card-chips">${chips.join('')}</div>` : '') +
    (note ? `<div class="teamwork-card-note">${esc(note)}</div>` : '') +
    (acts.length
      ? `<div class="teamwork-card-acts">${acts
          .map((a) => `<button class="teamwork-card-act" type="button" data-card-act="${actKey(a)}">${esc(a.label)}</button>`)
          .join('')}</div>`
      : '') +
    `</div>`
  );
}

/**
 * 功能：执行卡片上的一个动作 —— 点按钮时**重新收集**一次，按 key 找到并调用它的 `run(msg)`。
 *
 * 说明：⭐ 「重新收集」而不是把 `run` 存在渲染结果里：渲染只产出 HTML 字符串，
 *      函数塞不进去；而把函数存进某个模块级表又要处理「消息被重画 / 会话被切走」时的清理。
 *      重新收集一次既没有状态，也不会有陈旧引用。
 *      ⚠️ 找不到动作时**返回 false**（让调用方有机会说一句话），不静默装作点过了。
 *
 * @param {Object} msg - 这条卡片消息
 * @param {string} key - 动作键（来自 `data-card-act`）
 * @returns {boolean} 找到并执行了返回 true
 */
export function runCardAction(msg, key) {
  const want = String(key == null ? '' : key);
  const hit = cardActionsOf(msg).find((it) => actKey(it) === want);
  if (!hit) return false;
  hit.run(msg);
  return true;
}

// ================================================================ 发送任务弹层（⭐ 0.8.54）

/**
 * 功能：日常任务的状态 → 中文（与任务模块那张状态表的**显示口径**一致）。
 *
 * 说明：⚠️ 这里只做「显示」，⛔ 不参与任何判权/筛选逻辑（筛选只认 `done` 那一个布尔值，
 *      由 `dailyRow()` 从 `status === 'done'` 推出来）—— 以后任务模块加了新状态，
 *      这里是「显示成原样」，不会把功能弄坏。
 * @type {Object.<string, string>}
 */
const DAILY_STATE_TEXT = { backlog: '待排期', todo: '未开始', doing: '进行中', done: '已完成' };

/**
 * 功能：把一条**普通任务**压成弹层里的一行。
 * @param {Object} t - `/api/tasks` 里的任务对象
 * @returns {{kind: string, id: number, title: string, done: number, sub: string}} 行数据
 */
function dailyRow(t) {
  const key = String((t && t.status) || '');
  const due = String((t && t.due_date) || '');
  const sub = [DAILY_STATE_TEXT[key] || key, due ? '截止 ' + due : ''].filter(Boolean).join(' · ');
  return { kind: 'daily', id: t.id, title: t.title, done: key === 'done' ? 1 : 0, sub };
}

/**
 * 功能：取「普通任务」那一份分组 —— 日常任务一组 ＋ 我的每个项目一组。
 *
 * 说明：⭐⭐ 0.8.54 起**不再在这里滤掉已完成**：筛选是弹层里的一个按钮（全部 / 未完成 / 已完成），
 *      数据侧必须**全给**，否则「已完成」那个筛选永远是空的。⚠️ 完成与否只由这一个 `done` 表达，
 *      ⛔ 别在渲染层再判一次 `status`（两处判据迟早分家）。
 * @returns {Promise.<Array.<Object>>} 分组数组（形状见 `pickListHtml()`）
 */
async function dailyGroups() {
  const [tasks, projects] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/projects')]);
  const nameOf = new Map((Array.isArray(projects) ? projects : []).map((p) => [Number(p.id), p.name || '未命名项目']));
  const out = [];
  const daily = Array.isArray(tasks && tasks.daily) ? tasks.daily : [];
  if (daily.length) out.push({ title: '日常任务', items: daily.map(dailyRow) });
  const byProject = (tasks && tasks.byProject) || {};
  for (const pid of Object.keys(byProject)) {
    const rows = Array.isArray(byProject[pid]) ? byProject[pid] : [];
    if (!rows.length) continue;
    out.push({ title: nameOf.get(Number(pid)) || '项目', items: rows.map(dailyRow) });
  }
  return out;
}

/**
 * 功能：取「协作项目任务」那一份分组 —— **一个协作项目一组**。
 *
 * 说明：⚠️ N+1（先列项目、再每个项目取一次看板）是**有意**的：协作侧本来就没有「我参与的全部任务」
 *      这种聚合接口，而一个账号的协作项目通常只有几个。⚠️ 某个项目取失败**只让那一组消失**，
 *      ⛔ 不许让整个弹层因为一个项目 500 而打不开（那是最差的结果）。
 *      ⭐ 完成判定**只认看板给的组名**（`completed` / `cancelled` 都是终态）—— 状态名是用户可以
 *      自己改的（`states` 表），按名字判会在改名那天静默失效；组名是五个固定的桶。
 * @returns {Promise.<Array.<Object>>} 分组数组
 */
async function collabGroups() {
  const list = await api('GET', '/api/collab/projects');
  const items = Array.isArray(list && list.items) ? list.items : [];
  const boards = await Promise.all(
    items.map((p) => api('GET', `/api/collab/projects/${Number(p.id)}/board`).catch(() => null)),
  );
  const out = [];
  items.forEach((p, i) => {
    const b = boards[i];
    if (!b) return;
    const nameOfState = new Map(
      (Array.isArray(b.states) ? b.states : []).map((st) => [String(st.key), st.name || st.key]),
    );
    const rows = [];
    for (const g of Object.keys(b.groups || {})) {
      const closed = g === 'completed' || g === 'cancelled';
      for (const t of b.groups[g] || []) rows.push({ t, closed });
    }
    // 状态被删掉、任务还挂着的那些（`unknown`）—— 照旧列出来，按「未完成」算
    for (const t of Array.isArray(b.unknown) ? b.unknown : []) rows.push({ t, closed: false });
    if (!rows.length) return;
    out.push({
      title: p.name || '未命名项目',
      items: rows.map(({ t, closed }) => {
        const due = String((t && t.due_date) || '');
        const st = nameOfState.get(String((t && t.status) || '')) || '';
        const sub = [st, due ? '截止 ' + due : ''].filter(Boolean).join(' · ');
        return { kind: 'collab', id: t.id, pid: p.id, title: t.title, done: closed ? 1 : 0, sub };
      }),
    });
  });
  return out;
}

/**
 * 功能：取「发送任务」弹层要的那一份数据（两端同一个入口）。
 * @param {string} kind - `'collab'`（协作项目任务）/ `'daily'`（普通任务）
 * @returns {Promise.<Array.<Object>>} 分组数组
 */
export function fetchSendGroups(kind) {
  return String(kind) === 'collab' ? collabGroups() : dailyGroups();
}

/**
 * 发送任务弹层里的三个筛选标签。⭐ 顺序即显示顺序，「全部」必须第一个。
 * @type {Array.<{key: string, text: string}>}
 */
export const PICK_TABS = [
  { key: 'all', text: '全部' },
  { key: 'open', text: '未完成' },
  { key: 'done', text: '已完成' },
];

/**
 * 功能：按「搜索词 ＋ 筛选标签」过滤分组数据（**纯函数，不碰 DOM**）。
 *
 * 说明：⭐⭐ 把过滤写成纯函数是为了**可测** —— 仓里没有 jsdom，凡是要真 DOM 的交互都只能靠
 *      「真机看」，而「哪些行该出现」恰恰是最容易写错、也最该被钉住的一条。这里返回**新数组**
 *      （不改入参：原数据要留着给下一次筛选，各端存一份 `groups` 就够）。
 *      ⚠️ 搜到/筛选后的组一律带 `open: true`：用户输了字却看到一排**收起的组头**，
 *      等于「搜了还是看不到」，比不搜更糟。
 * @param {Array.<Object>} groups - `[{ title, items: [...] }]`
 * @param {{q?: string, tab?: string}} [filter] - 搜索词（大小写不敏感）＋ 标签（all/open/done）
 * @returns {Array.<Object>} 过滤后的分组（空组已剔除；每组的 `open` 表示要不要默认展开）
 */
export function filterPickGroups(groups, filter) {
  const q = String((filter && filter.q) || '').trim().toLowerCase();
  const tab = String((filter && filter.tab) || 'all');
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || !Array.isArray(g.items)) continue;
    const items = g.items.filter((it) => {
      if (tab === 'open' && Number(it && it.done)) return false;
      if (tab === 'done' && !Number(it && it.done)) return false;
      if (q && String((it && it.title) || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (!items.length) continue;
    out.push({ title: g.title, items, open: Boolean(q) || tab !== 'all' });
  }
  return out;
}

/**
 * 功能：**任务选择弹层**里那一份列表（⭐ 0.8.54 建立，0.8.54 改成「按项目折叠」）。
 *
 * 说明：⭐ 只产出 HTML，**不发请求、不认识接口** —— 数据由 `fetchSendGroups()` 给。
 *      ⭐⭐ 「任务要**默认按项目折叠**，要有筛选功能」⇒ 每组用原生 `<details>`：
 *      收起/展开是浏览器自己的事（零 JS、零状态、返回键也不会被吃掉），**默认不写 `open`**
 *      就是折叠态。`g.open` 只在「搜索/筛选命中」时由 `filterPickGroups()` 置真。
 *      ⚠️ 每一行带 `data-pick="<kind>:<id>:<pid>"`（协作任务才带 pid），键里**只有数字**，
 *      不含任何用户内容 —— 与 `data-card-act` 同一条机械断言口径。
 *      ⚠️ 一条都没有时给一句人话，⛔ 不画一个空白弹层（用户会以为卡住了）。
 * @param {Array.<Object>} groups - `[{ title, items: [{ kind, id, pid?, title, done?, sub? }], open? }]`
 * @returns {string} 列表 HTML
 */
export function pickListHtml(groups) {
  const gs = (Array.isArray(groups) ? groups : []).filter((g) => g && Array.isArray(g.items) && g.items.length);
  if (!gs.length) return '<div class="tw-pick-empty">没有符合条件的任务</div>';
  return (
    '<div class="tw-pick">' +
    gs
      .map((g) => {
        const rows = g.items
          .map((it) => {
            const key = String(it.kind) + ':' + Number(it.id) + (it.pid ? ':' + Number(it.pid) : '');
            return (
              '<button class="tw-pick-row" type="button" data-pick="' +
              key +
              '">' +
              '<span class="tw-pick-t">' +
              esc(it.title || '未命名任务') +
              '</span>' +
              (it.sub ? '<span class="tw-pick-s">' + esc(it.sub) + '</span>' : '') +
              '</button>'
            );
          })
          .join('');
        return (
          '<details class="tw-pick-grp"' +
          (g.open ? ' open' : '') +
          '><summary class="tw-pick-grp-t">' +
          esc(g.title) +
          '<b>' +
          g.items.length +
          '</b></summary>' +
          '<div class="tw-pick-rows">' +
          rows +
          '</div></details>'
        );
      })
      .join('') +
    '</div>'
  );
}

/**
 * 功能：任务选择弹层的**整个正文**（筛选栏 ＋ 列表），两端首次渲染都用它。
 *
 * 说明：⚠️ 筛选栏与列表必须是**两个节点**：筛选变化时只重画列表区
 *      （`[data-pick-list]`），⛔ 不许整块 `innerHTML` —— 那会把搜索框一起重建，
 *      输入法当场断掉、字数一多就「打一个字停一次」。
 *      ⚠️ 列表区高度由 CSS 管（`.tw-pick-list` 是唯一的滚动层），所以外层要有确定高度
 *      （手机端 `openSheet(..., { fixed: true })`，电脑端弹窗自己有 `max-height`）。
 * @param {Array.<Object>} groups - `fetchSendGroups()` 的结果
 * @param {{q?: string, tab?: string}} [filter] - 初始筛选状态
 * @returns {string} 正文 HTML
 */
export function pickPanelHtml(groups, filter) {
  const q = String((filter && filter.q) || '');
  const tab = String((filter && filter.tab) || 'all');
  const tabs = PICK_TABS.map(
    (t) =>
      '<button class="tw-pick-tab' +
      (t.key === tab ? ' on' : '') +
      '" type="button" data-pick-tab="' +
      t.key +
      '">' +
      esc(t.text) +
      '</button>',
  ).join('');
  return (
    '<div class="tw-pick-wrap">' +
    '<div class="tw-pick-bar">' +
    '<input class="tw-pick-q" type="search" data-pick-q value="' +
    esc(q) +
    '" placeholder="搜索任务名" autocomplete="off">' +
    '<div class="tw-pick-tabs">' +
    tabs +
    '</div>' +
    '</div>' +
    '<div class="tw-pick-list" data-pick-list>' +
    pickListHtml(filterPickGroups(groups, { q, tab })) +
    '</div>' +
    '</div>'
  );
}
