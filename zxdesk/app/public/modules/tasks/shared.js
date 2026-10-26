/**
 * modules/tasks/shared.js —— 任务板**两端共用**的「任务联动」逻辑（0.6.4）
 *
 * 功能：与对话模块打交道的那几件事，两端必须**逐字一致**，所以只写一份：
 *      · `assigneeOptions(me, modules)` 取「可以当负责人的好友」清单（对话模块的好友），
 *        带 60 秒缓存，并先判**可用性**（模块在不在清单里 / 本账号有没有关掉对话）；
 *      · `matchFriend(list, name)` 把一个负责人名字匹配回好友（精确匹配，忽略大小写）；
 *      · `shareTaskCard(friend, card, from)` 把一条任务作为**任务卡片**发给好友；
 *      · `bindCardActions(meOf, handler)` 监听对话卡片上的动作留白事件（`zx:teamwork-card-actions`）。
 *
 * ⭐ **跨模块只走既有接口**（铁律 11）：本文件全部是 HTTP 调用（`/api/teamwork/...`），
 *    **没有 import 对话模块的任何实现**。所以对话模块被删掉（清单里没有了）或被本账号关掉
 *    （`hide_teamwork`）时，负责人那一栏就安静地退回手动输入 —— 任务板照常能用。
 *
 * ⚠️ **失败不许打扰用户**（但也不许吞）：拉好友清单失败时回空数组 + `console.warn`，
 *    绝不弹 toast —— 用户只是想在负责人里填个字，不该被一个接口错误打断。
 *    真正要「响」的是**发送那一步**（见 `shareTaskCard`）：那是用户明确点的动作，失败必须报出来。
 *
 * ⚠️ **卡片是快照**：`meta` 里装的全是发送那一刻的值，对方看到的东西**不会**
 *    跟着任务状态变 —— 多用户数据是隔离的，对方根本读不到这条任务。
 *
 * @author zx
 * @date   2026-09-16
 * @since 0.8.54
 * 相关：docs/公共/架构文档/05-任务板.md、17-对话.md、13-决策记录.md（决策 87）
 */

import { api } from '../../core/api.js';
import { esc } from '../../core/dom.js';
import { parseRule } from '../../core/recur.js';

/** 好友清单的缓存寿命（毫秒）：表单会被连着打开好几次，不必每次都问一遍接口 */
const FRIENDS_TTL_MS = 60000;

/** 卡片备注的**前端截断长度** —— 与 `validate.js` 的 `MAX_CARD_NOTE`（500）同值，改一处必须改另一处 */
const MAX_CARD_NOTE = 500;

/** 好友清单缓存（`at` 为 0 表示还没取过；拉失败时**不写**这里，下次再试） */
let friendsCache = { at: 0, list: [] };

/**
 * 功能：判断「对话模块」现在能不能给任务板供好友 —— 模块在不在清单里 + 本账号有没有关掉它。
 *
 * 说明：⭐ 两个判据缺一不可，与插槽显隐（`core/slots.js` 的 `slotDefs`）用的是同一套：
 *      「关掉的是入口，不是数据」在这里的落地是**界面不出现**，而不是接口不能用。
 *      ⚠️ `modules` 还没到手（`null`）时回 false —— 宁可这一屏先没有下拉，
 *      也不要拿一个必然 404 的请求去试探（那是「刷新一下就好了」那一类缺陷的温床）。
 *
 * @param {?Object} me - 当前登录账号（读 `hide_teamwork`）
 * @param {?Array.<Object>} modules - `/api/bootstrap` 的 `modules` 清单
 * @returns {boolean} 可以取好友清单返回 true
 */
function teamworkUsable(me, modules) {
  if (!me || !Array.isArray(modules)) return false;
  if (!modules.some((m) => m && m.name === 'teamwork')) return false;
  return !Number(me.hide_teamwork);
}

/**
 * 功能：取「可以作为负责人的好友」清单 —— 拿不到就回空数组（表单据此退回纯手输）。
 *
 * 说明：⚠️ 失败**不打扰用户**（见文件头的说明），而且失败的那一次**不写缓存**：
 *      否则一次网络抖动会让这一分钟内打开的所有表单都没有下拉。
 *      ⚠️ 好友显示名取「显示名 → 登录名」，与对话模块自己的口径一致；两个都没有的行直接丢掉
 *      （画一个没有名字的选项没有任何意义）。
 *
 * @param {?Object} me - 当前登录账号
 * @param {?Array.<Object>} modules - 模块清单
 * @returns {Promise.<Array.<{id: number, name: string}>>} `[{ id, name }]`，拿不到时为空数组
 */
export async function assigneeOptions(me, modules) {
  if (!teamworkUsable(me, modules)) return [];
  const now = Date.now();
  if (friendsCache.at && now - friendsCache.at < FRIENDS_TTL_MS) return friendsCache.list;
  try {
    const r = await api('GET', '/api/teamwork/friends');
    const list = (Array.isArray(r && r.friends) ? r.friends : [])
      .map((f) => {
        const u = (f && f.user) || {};
        const id = Number(f && f.friend_id);
        const name = String(u.display_name || u.username || '').trim();
        return Number.isInteger(id) && id > 0 && name ? { id, name } : null;
      })
      .filter(Boolean);
    friendsCache = { at: now, list };
    return list;
  } catch (e) {
    console.warn('[tasks] 好友清单拉取失败，负责人退回手动输入：', e);
    return [];
  }
}

/**
 * 功能：把一个负责人名字匹配回好友 —— 精确匹配（忽略大小写与首尾空白）。
 *
 * 说明：⭐ 负责人在库里存的是**名字**（沿用既有的 `assignee` 文本列，零迁移），所以「这个人
 *      是不是我好友」只能按名字认。⚠️ 两个同名好友分不出来 —— 这是存名字的已知代价
 *      （与确认过），要解决得把负责人换成账号 id（结构迁移）。
 *      ⚠️ 只在**要发送**时才需要它：表单里那个下拉是 `datalist`，用户随手敲的名字本来就不必是好友。
 *
 * @param {Array.<{id: number, name: string}>} list - `assigneeOptions()` 的结果
 * @param {?string} name - 负责人那一栏的当前值
 * @returns {?{id: number, name: string}} 匹配到的好友；对不上返回 null
 */
export function matchFriend(list, name) {
  const want = String(name == null ? '' : name)
    .trim()
    .toLowerCase();
  if (!want) return null;
  return (Array.isArray(list) ? list : []).find(
    (f) => f && String(f.name).trim().toLowerCase() === want,
  ) || null;
}

/**
 * 功能：把一条任务组织成卡片的**降级文本**与**载荷**（发送与预览共用，所以只有一份）。
 *
 * 说明：⭐ `body` 是渲染端不认这个 `kind` 时显示的东西（服务端强制它必填），所以它必须是
 *      **人能读懂的一句话**，而不是什么内部标记。
 *      ⚠️ `note`（任务描述）按 `MAX_CARD_NOTE` 截断：2 万字的描述塞进对方的对话里没有意义，
 *      而截断要**在预览里看得见**（见各端的确认弹窗），不许悄悄截。
 *
 * @param {Object} card - `{ title, due, important, urgent, note }`（任务快照）
 * @param {string} from - 发送者署名（我的显示名 / 登录名）
 * @returns {{body: string, meta: Object, noteTruncated: boolean}} 降级文本 + 载荷 + 是否截过备注
 */
export function buildTaskCard(card, from) {
  const c = card || {};
  const title = String(c.title == null ? '' : c.title).trim();
  const note = String(c.note == null ? '' : c.note).trim();
  const noteTruncated = note.length > MAX_CARD_NOTE;
  const meta = {
    title,
    due: c.due ? String(c.due) : '',
    important: Number(c.important) ? 1 : 0,
    urgent: Number(c.urgent) ? 1 : 0,
    note: note.slice(0, MAX_CARD_NOTE),
    from: String(from == null ? '' : from).trim(),
  };
  const bits = [`【任务】${title}`];
  if (meta.due) bits.push(`截止 ${meta.due}`);
  const flags = [];
  if (meta.important) flags.push('重要');
  if (meta.urgent) flags.push('紧急');
  if (flags.length) bits.push(flags.join(' · '));
  return { body: bits.join(' · '), meta, noteTruncated };
}

/**
 * 功能：把好友清单填进一个 `<datalist>`（负责人那一栏用它给出下拉候选）。
 *
 * 说明：⭐ 用 `datalist` 而不是 `<select>`：**下拉与手输要同时成立**（与确认）——
 *      `select` 一上，「我」「张工」这类没加过好友的写法就填不了了，而这一栏以前就是自由文本。
 *      `datalist` 是浏览器原生的「可输入 + 有候选」，两端都不用额外的弹层代码。
 *      ⚠️ 它是**异步**的：表单先画出来、候选随后到（拿不到就永远空着，输入框照常能用）。
 *
 * @param {(string|HTMLElement)} target - 目标 `<datalist>`（选择器或节点）
 * @param {?Object} me - 当前登录账号
 * @param {?Array.<Object>} modules - 模块清单
 * @returns {Promise.<Array.<{id: number, name: string}>>} 好友清单（保存时还要用它匹配负责人）
 */
export async function fillAssigneeList(target, me, modules) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  const list = await assigneeOptions(me, modules);
  if (el) {
    el.textContent = '';
    for (const f of list) {
      const o = document.createElement('option');
      o.value = f.name;
      el.appendChild(o);
    }
  }
  return list;
}

/**
 * 功能：发送前那个确认弹窗的**正文 HTML** —— 「将要发出去的是什么」摆给用户看（两端逐字一致）。
 *
 * 说明：⭐ 与 0.6.0「AI 辅助任务」的预览层同一个精神：**发出去之前看得见发的是什么**。
 *      这里比 AI 那条更确定（内容本来就是结构化的），所以只做只读展示，不给改的入口。
 *      ⚠️ 卡片正文全是**我自己写的任务内容**，但照样 `esc()` —— 任务是用户输入，一律按不可信处理。
 *      ⚠️ 备注被截断时**明说**（`truncated`），不许悄悄截（与「超长一律 400 不静默截断」同一条规矩）。
 *
 * @param {Object} card - `{ title, due, important, urgent, note }`
 * @param {string} friendName - 要发给谁（显示名）
 * @returns {string} 弹窗正文 HTML
 */
export function cardOfferHtml(card, friendName) {
  const built = buildTaskCard(card, '');
  const meta = built.meta;
  const chips = [];
  if (meta.due) chips.push(`<span class="teamwork-card-chip">📅 截止 ${esc(meta.due)}</span>`);
  if (meta.important) chips.push(`<span class="teamwork-card-chip imp">🔴 重要</span>`);
  if (meta.urgent) chips.push(`<span class="teamwork-card-chip urg">⏰ 紧急</span>`);
  return (
    `<p class="card-offer-lead">任务已经保存好了。要把这张任务卡片发给 <b>${esc(friendName)}</b> 吗？</p>` +
    `<div class="teamwork-card card-offer-preview">` +
    `<div class="teamwork-card-title">${esc(meta.title || '未命名任务')}</div>` +
    (chips.length ? `<div class="teamwork-card-chips">${chips.join('')}</div>` : '') +
    (meta.note ? `<div class="teamwork-card-note">${esc(meta.note)}</div>` : '') +
    `</div>` +
    `<p class="card-offer-note">他会在对话里收到这张卡片；任务本身仍在你自己的任务板里，` +
    `他看不到它的后续状态${built.noteTruncated ? '。备注只带前 500 字' : ''}。</p>`
  );
}

/**
 * 功能：把一条任务作为**任务卡片**发给一位好友 —— 走对话模块的既有接口（先开会话、再发消息）。
 *
 * 说明：⭐ 两步都是对话模块**已经存在**的接口（`POST /api/teamwork/conversations` 带 `friendId`
 *      是幂等的，开过就直接回那一条），任务板这边一个字段都不多要。
 *      ⚠️ 这是用户明确点的动作 ⇒ **失败必须报出来**（由调用方的 try/catch 弹 toast），
 *      不能像拉好友清单那样静默降级。
 *
 * @param {Object} friend - `{ id, name }`（来自 `assigneeOptions()`）
 * @param {Object} card - `{ title, due, important, urgent, note }`
 * @param {string} from - 发送者署名
 * @returns {Promise.<Object>} 对话模块返回的发送结果（`{ id, conversationId, createdAt, ... }`）
 * @throws {Error} 开会话失败 / 发送失败时抛出（错误消息已由服务端写成给用户看的话）
 */
export async function shareTaskCard(friend, card, from) {
  const fid = Number(friend && friend.id);
  if (!Number.isInteger(fid) || fid <= 0) throw new Error('没有选中要发送的好友');
  const built = buildTaskCard(card, from);
  if (!built.meta.title) throw new Error('任务没有标题，发不了');
  const conv = await api('POST', '/api/teamwork/conversations', { friendId: fid });
  const cid = Number(conv && conv.id);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error('没能打开与对方的会话');
  return api('POST', `/api/teamwork/conversations/${cid}/messages`, {
    body: built.body,
    kind: 'task_card',
    meta: built.meta,
  });
}

/**
 * 功能：注册「对话里那张任务卡片上的动作」—— 监听 `zx:teamwork-card-actions` 留白事件。
 *
 * 说明：⭐ 与对话模块自己的消息菜单（`zx:teamwork-msg-menu`）同一套规矩：**宿主不认识本模块**，
 *      本模块也不认识宿主；卡片上有哪些动作只由这里决定。
 *      ⚠️ **自己发的卡片不给这个动作**：那条任务本来就在我自己的任务板里，
 *      「收进我的任务板」只会多出一条重复的。判断放在这里（唯一一份），各端不必各判一次。
 *      ⚠️ **只挂一次**（模块级标记）：两端入口都在启动时调它，重复挂会往卡片上塞两枚按钮。
 *
 * @param {Function} meOf - `() => ?Object`：返回当前登录账号（延迟求值 —— 绑定时它可能还没到手）
 * @param {Function} handler - `(msg) => void`：点「收进我的任务板」时干什么（各端打开自己的新建表单）
 * @returns {void}
 */
export function bindCardActions(meOf, handler) {
  if (bindCardActions._bound) return;
  bindCardActions._bound = true;
  document.addEventListener('zx:teamwork-card-actions', (e) => {
    const d = e && e.detail;
    if (!d || !d.msg || !Array.isArray(d.items)) return;
    const me = typeof meOf === 'function' ? meOf() : null;
    const sender = d.msg.senderId !== undefined ? d.msg.senderId : d.msg.user_id;
    if (me && Number(sender) === Number(me.id)) return;
    // ⭐ 0.8.54：**协作项目任务**的卡片不给这颗按钮 —— 它本来就是那个共享项目里的一条任务，
    //    收件人（项目成员）在协作看板里就能看到它；再「收进我的任务板」只会多出一条重复的。
    //    ⚠️ 判据跟着 `meta.src` 走（服务端只认 `daily` / `collab` 两个值），⛔ 不要在这里猜项目名。
    if (d.msg.meta && String(d.msg.meta.src || '') === 'collab') return;
    d.items.push({
      key: 'tasks:save',
      label: '📥 收进我的任务板',
      run: (msg) => handler(msg),
    });
  });
}

/**
 * 功能：监听「别的模块要开一张**预填好的任务表单**」—— 留白事件 `zx:task-draft`。
 *
 * 说明：⭐ 与上面的 `bindCardActions` 同一套规矩：派发方不认识任务板、任务板也不认识派发方，
 *      两边只认这一个事件名 —— **将来多一个消费方，任务板一行都不用改**。
 *      ⚠️ 方向为什么是「任务板开表单、别人只派事件」：写任务的**路径只有一条**，就是任务板
 *      自己的表单（的口径：**表单点了保存才建任务**）。别的模块要是自己去
 *      POST `/api/daily`，就会绕开「所属项目 / 重要紧急 / 绑定网址」那一整套，迟早对不齐。
 *      ⚠️ 只挂一次（模块级标记）：两端都在启动时调它，重复挂会开两次表单。
 *
 * @param {Function} handler - `(draft) => void`：收到请求时干什么（各端打开自己的新建表单）。
 *      `draft` 形如 `{ title, description, start_date, due_date, from_day_note, from_idea }`。
 *      ⭐ `from_day_note` 是**来源标记**（课表那条本节备注的身份），表单要把它**原样透传**回
 *      建任务的接口 —— 服务端建完任务靠它回绑备注（`timetable/store.js` 的 `linkDayNoteTask()`）。
 *      ⭐⭐ 0.8.14：`from_idea`（随手记）是**同一性质的第二个来源标记**——
 *      同样**原样透传**，服务端建完任务靠它回绑随手记（`idea/store.js` 的 `bindIdeaTask()`）。
 *      ⚠️ 两处都要透传：**漏一处就是「随手记那边永远显示不出『已变成任务』」而且不报错**。
 * @returns {void}
 */
export function bindTaskDraft(handler) {
  if (bindTaskDraft._bound) return;
  bindTaskDraft._bound = true;
  document.addEventListener('zx:task-draft', (e) => {
    const d = e && e.detail;
    if (!d || typeof d !== 'object') return;
    handler({
      draft: true,
      title: String(d.title || ''),
      description: String(d.description || ''),
      start_date: String(d.start_date || ''),
      due_date: String(d.due_date || ''),
      from_day_note: d.from_day_note || null,
      from_idea: d.from_idea || null,
    });
  });
}

/**
 * 功能：给周期任务的某一期**打卡 / 取消打卡**（0.8.14）—— 两端共用一份。
 *
 * 说明：⭐ 周期任务的勾选走这条，⛔ **不走** `toggleTask()`（那条是「把整条任务标完成」，
 *      而周期任务的语义是「这一期做完了」，任务本身还要继续）。
 *      ⚠️ 失败**必须抛出去**（调用方弹 toast）：打卡是用户明确点的动作，
 *      静默失败会让「勾了但没打上」变成一个查不出来的玄学。
 *
 * @param {string} source - `'daily'` / `'project'`
 * @param {(number|string)} taskId - 任务 id
 * @param {string} periodKey - 本期的周期起点日期 `YYYY-MM-DD`（`core/recur.js` 的 `periodOf().key`）
 * @param {boolean} on - true 打卡、false 取消
 * @returns {Promise.<Object>} 服务端结果 `{ ok, added|removed }`
 * @throws {Error} 请求失败时抛出
 */
/** 周几的中文名（下标 1 直接对应 `slots` 的 weekly 坐标系 `1..7`） */
const WEEK_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

/**
 * 功能：生成**周期规则编辑器**的 HTML（0.8.14）—— 两端共用同一份片段。
 *
 * 说明：⭐ 三种频率：每天 / 每周 / 每月。`slots` 里每一行是**一期**（`[起, 止]` 闭区间）：
 *      · 每周：**勾周几**（勾中的各成「单天期」）＋ 若干「起~止」的**跨天期**（勾了起=止 也行）；
 *      · 每月：若干「起~止」的号数段（`1~9` 就是「每月 1 号到 9 号」）。
 *      ⭐⭐ **不存「次数」** —— 次数 ≡ 期数（`slots.length`），界面上的「每周 N 次」只是
 *      「加 N 行」这个动作的说法（存两份必然漂移）。
 *      ⚠️⭐ 版式两端**共用这一份**（`.rk-*` 那一套类名，两端样式表各写一遍）——
 *      这是「判据共用」的落地：规则**怎么生成 / 怎么读回来**只有一处，
 *      ⛔ 两端各写一份必然漂移（改一端忘另一端＝那条规则静默存错）。
 *
 * @param {(Object|string|null)} rule - 现有规则（编辑时回填；空 = 每天）
 * @returns {string} 编辑器 HTML
 */
export function recurEditorHtml(rule) {
  const r = parseRule(rule) || { freq: 'daily', slots: [] };
  const isDaily = r.freq === 'daily';
  /** 功能：给某一档生成的 `on` 类。 @param {string} f - 档位值 @returns {string} 类名字串 */
  const on = (f) => (r.freq === f ? ' on' : '');
  /**
   * 功能：给某一档生成 `hidden`。
   * ⚠️⭐ 它拼在 `class="…"` 的**引号外面** ⇒ 落成的是 **`hidden` 属性**（不是类名！）——
   *     所以切显隐只能用 `el.hidden = …`，⛔ 不能 `classList.toggle('hidden', …)`
   *     （理由见 `bindRecurEditor()` 里 `syncFreq()` 那段说明）。
   * @param {boolean} b - 是否隐藏
   * @returns {string} `' hidden'` / `''`
   */
  const hide = (b) => (b ? ' hidden' : '');
  const dayBtns = [1, 2, 3, 4, 5, 6, 7]
    .map((d) => `<button type="button" class="rk-day" data-day="${d}">周${WEEK_NAMES[d]}</button>`)
    .join('');
  const rows = isDaily ? '' : r.slots.map((s) => slotRowHtml(r.freq, s)).join('');
  return (
    `<div class="rk" id="rk-root" data-freq="${r.freq}">` +
    `<div class="rk-freq">` +
    `<button type="button" class="rk-f${on('daily')}" data-freq="daily">每天</button>` +
    `<button type="button" class="rk-f${on('weekly')}" data-freq="weekly">每周</button>` +
    `<button type="button" class="rk-f${on('monthly')}" data-freq="monthly">每月</button>` +
    `</div>` +
    // ⭐ 「勾周几」是**快捷方式**：点一下就加 / 去一条 `[d,d]` 的单天期（见 `bindRecurEditor`）。
    //    ⚠️ 它**不是**第二份真相 —— 期段行才是唯一真相，勾选状态每次都由行反推（`syncDays`）。
    `<div class="rk-weekly"${hide(r.freq !== 'weekly')}>${dayBtns}</div>` +
    // ⭐⭐ 0.8.14：「每周和每月可以输入几次 然后默认均分显示 用户可以自己调整」
    `<div class="rk-nrow"${hide(isDaily)}>` +
    `<span class="rk-nlabel" id="rk-nlabel"></span>` +
    `<input class="rk-n" id="rk-n" type="number" min="1" max="7" value="1" />` +
    `<span class="rk-nlabel">次</span>` +
    `<span class="rk-hint">改次数会重新均分；分完可以自己再调</span>` +
    `</div>` +
    `<div class="rk-spans" id="rk-spans">${rows}</div>` +
    // ⚠️ 「＋ 加一期」**只在每周 / 每月出现**（「每天就不要有 + 加一期」）——
    //    每天这个频率不吃 `slots`，放一个加不出东西的按钮只会让人白点。
    `<div class="rk-foot"${hide(isDaily)}>` +
    `<button type="button" class="btn btn-subtle btn-sm" id="rk-add">＋ 加一期</button>` +
    `</div>` +
    `</div>`
  );
}

/**
 * 功能：生成「一期」的输入行（`起 ~ 止`）—— 每周用下拉（周一~周日）、每月用数字（1~31）。
 * @param {string} freq - `'weekly'` / `'monthly'`
 * @param {Array.<number>} s - 一期的 `[起, 止]`
 * @returns {string} 该行的 HTML
 */
function slotRowHtml(freq, s) {
  const a = s && s[0] ? s[0] : 1;
  const b = s && s[1] ? s[1] : a;
  const field = (cls, val) =>
    freq === 'weekly'
      ? `<select class="${cls}">${[1, 2, 3, 4, 5, 6, 7]
          .map((d) => `<option value="${d}"${d === val ? ' selected' : ''}>周${WEEK_NAMES[d]}</option>`)
          .join('')}</select>`
      : `<input class="${cls}" type="number" min="1" max="31" value="${val}" />`;
  return (
    `<div class="rk-slot">${field('rk-a', a)}<span class="rk-tilde">~</span>${field('rk-b', b)}` +
    `<button type="button" class="rk-del" title="删掉这一期">✕</button></div>`
  );
}

/**
 * 功能：给周期规则编辑器接线 —— 切频率、勾周几、加 / 删期。**必须**在片段进文档之后调。
 *
 * 说明：⚠️ 加一期的默认值随频率走（每周默认「周一~周一」、每月默认「1~1」）。
 *      ⚠️ 切到「每天」时**把期段清空**（每天不吃 `slots`）—— 留着会让用户以为还有什么没生效。
 *      ⚠️ 只挂一次（`_bound` 标记在根节点上）：表单重复打开时同一个 id 会被重新造出来，
 *      所以这里按**节点**判重而不是按模块级标记。
 *
 * @param {string} root - 编辑器根节点的选择器（约定 `#rk-root`）
 * @returns {void}
 */
export function bindRecurEditor(root) {
  const box = document.querySelector(root || '#rk-root');
  if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';
  const spans = box.querySelector('#rk-spans');
  const weekly = box.querySelector('.rk-weekly');
  const nrow = box.querySelector('.rk-nrow');
  const foot = box.querySelector('.rk-foot');
  const nIn = box.querySelector('#rk-n');
  const nLabel = box.querySelector('#rk-nlabel');
  /** 功能：当前频率。 @returns {string} `'daily'` / `'weekly'` / `'monthly'` */
  const freq = () => box.dataset.freq || 'daily';
  /** 功能：取期段行的 DOM 列表。 @returns {Array.<HTMLElement>} 行数组 */
  const rows = () => [...spans.querySelectorAll('.rk-slot')];
  /** 功能：取某一行某个输入的值（数字）。 @param {HTMLElement} row - 行 @param {string} cls - `.rk-a` / `.rk-b` @returns {number} 值 */
  const valOf = (row, cls) => {
    const n = row.querySelector(cls);
    return n ? Number(n.value) : 0;
  };
  /**
   * 功能：同步「勾周几」的亮灭 —— ⚠️ 状态**由期段行反推**（行是唯一真相）：
   *      某一行是单天期（起=止）且等于那一天 ⇒ 那颗按钮亮。
   * @returns {void}
   */
  const syncDays = () => {
    const singles = new Set(
      rows()
        .filter((r) => valOf(r, '.rk-a') === valOf(r, '.rk-b'))
        .map((r) => valOf(r, '.rk-a')),
    );
    box.querySelectorAll('.rk-day').forEach((b) => b.classList.toggle('on', singles.has(Number(b.dataset.day))));
  };
  /**
   * 功能：把「几次」输入对齐到**当前行数**，并按频率改单位（每周分 / 每月分）。
   * @returns {void}
   */
  const syncN = () => {
    const n = rows().length;
    const len = spanLen(freq());
    if (nIn) {
      nIn.max = String(len);
      nIn.value = String(n || 1);
    }
    if (nLabel) nLabel.textContent = freq() === 'weekly' ? '每周分' : '每月分';
  };
  /**
   * 功能：按频率切换三块的显隐（勾周几 / 几次 / ＋加一期）—— 每天都不出现。
   * @returns {void}
   */
  const syncFreq = () => {
    const f = freq();
    // ⚠️⭐⭐ 这三块在 HTML 里是用 **`hidden` 属性**标出来的（见 `recurEditorHtml()` 的 `hide()` ——
    //    它拼在 `class="…"` 的**引号外面**，所以落成的是属性、不是类名）⇒ 切显隐必须动**属性**。
    //    ⛔ 从前这里写的是 `classList.toggle('hidden', …)`：它只改**类名**，`hidden` 属性原地不动，
    //    而 `[hidden] { display: none !important }` 一直生效 ⇒ **这三块永远显示不出来**
    //    （切到「每周 / 每月」后，勾周几、分几次、＋加一期**一个都看不到**，界面还不报任何错）。
    //    装机看到的就是这个：「每月和每周怎么只能设置一期的」。
    //    ⚠️ lint / 单测 / 构建**全都拦不住这一类** —— 判据只有真渲染探针（`task-form-probe.js`）。
    weekly.hidden = f !== 'weekly';
    nrow.hidden = f === 'daily';
    foot.hidden = f === 'daily';
    syncN();
  };
  box.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const f = t.closest('.rk-f');
    if (f) {
      const want = f.dataset.freq;
      if (want === freq()) return;
      box.dataset.freq = want;
      // ⚠️⭐ 换频率**必须重建期段行**（报的「每月和每周切换下面没有刷新」）：
      //    每周那两个格子是「周几」下拉、每月是数字框，形状根本不同 ——
      //    沿用旧行就会出现「选了每月、下面还写着周一~周一」这种**自相矛盾**的界面。
      spans.innerHTML = want === 'daily' ? '' : slotRowHtml(want, [1, 1]);
      box.querySelectorAll('.rk-f').forEach((b) => b.classList.toggle('on', b === f));
      syncFreq();
      syncDays();
      return;
    }
    const d = t.closest('.rk-day');
    if (d) {
      // 「勾周几」＝ 加 / 去一条**单天期**（起=止），不是第二份状态
      const day = Number(d.dataset.day);
      const hit = rows().find((r) => valOf(r, '.rk-a') === day && valOf(r, '.rk-b') === day);
      if (hit) hit.remove();
      else spans.insertAdjacentHTML('beforeend', slotRowHtml(freq(), [day, day]));
      syncN();
      syncDays();
      return;
    }
    if (t.closest('#rk-add')) {
      spans.insertAdjacentHTML('beforeend', slotRowHtml(freq(), [1, 1]));
      syncN();
      syncDays();
      return;
    }
    const del = t.closest('.rk-del');
    if (del) {
      const row = del.closest('.rk-slot');
      if (row) row.remove();
      syncN();
      syncDays();
    }
  });
  // ⭐ 「几次」：改完按**等分区间**重铺（选的口径 —— 每周 3 次 ⇒ 一二 / 三四 / 五七日；
  //    每月 3 次 ⇒ 1~10 / 11~20 / 21~31 号），铺完用户自己再改。
  //    ⚠️ 用 `change`（失焦 / 回车才触发），⛔ 不用 `input` —— 每敲一个数字就重铺会把正在输入的框换掉。
  box.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'rk-n') return;
    spans.innerHTML = evenRows(freq(), clampCount(e.target.value, spanLen(freq())));
    syncN();
    syncDays();
  });
  syncFreq();
  syncDays();
}

/**
 * 功能：某个频率的坐标范围长度（weekly 是 `1..7`、monthly 是 `1..31`）。
 * @param {string} f - 频率
 * @returns {number} 长度
 */
function spanLen(f) {
  return f === 'weekly' ? 7 : 31;
}

/**
 * 功能：把「几次」夹进合法区间（整数、`1..len`）。
 * @param {*} raw - 输入框里的值
 * @param {number} len - 坐标范围长度
 * @returns {number} 合法的次数
 */
function clampCount(raw, len) {
  let n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > len) n = len;
  return n;
}

/**
 * 功能：把 `1..len` 按**等分区间**切成 `n` 段，返回这些期段行（余数落在**最后一段**）。
 *
 * 说明：⭐ 这是选的口径，与界面上那句提示逐字对应：
 *      每周 3 次 ⇒ `一二 / 三四 / 五七日`；每月 3 次 ⇒ `1~10 / 11~20 / 21~31`。
 *      ⚠️ 只负责**铺初始值**，铺完用户改哪一段都行（服务端照常校验重叠与范围）。
 *
 * @param {string} f - 频率（`'weekly'` / `'monthly'`）
 * @param {number} n - 次数（已夹过）
 * @returns {string} `n` 条期段行的 HTML
 */
function evenRows(f, n) {
  const len = spanLen(f);
  const base = Math.floor(len / n);
  let a = 1;
  let out = '';
  for (let i = 0; i < n; i++) {
    const b = i === n - 1 ? len : a + base - 1;
    out += slotRowHtml(f, [a, b]);
    a = b + 1;
  }
  return out;
}

/**
 * 功能：把周期规则编辑器里的内容**读成 `{freq, slots}`**（服务端还会再校验一次）。
 *
 * 说明：⚠️ 归一（升序、去重）在这里做一次，服务端 `checkRecurRule()` 再做一次并**判重叠** ——
 *      前端这一层只是「让用户少看到一次 400」，⛔ 不替代服务端校验（入参校验的唯一权威是服务端）。
 *      ⚠️ 读不到编辑器（不是周期任务）时回 `null`。
 *
 * @param {string} [root] - 编辑器根节点的选择器（约定 `#rk-root`）
 * @returns {?{freq: string, slots: Array.<Array.<number>>}} 规则；不是周期任务时为 null
 */
export function readRecurEditor(root) {
  const box = document.querySelector(root || '#rk-root');
  if (!box) return null;
  const f = box.dataset.freq || 'daily';
  if (f === 'daily') return { freq: 'daily' };
  const out = [];
  // ⚠️⭐ **只读期段行** —— 「勾周几」不是第二份状态（点它就会加 / 去一条单天期行，见 `bindRecurEditor`），
  //    所以这里再读一遍那七颗按钮会把单天期**读重**（服务端会判成「两期重叠」⇒ 400）。
  box.querySelectorAll('#rk-spans .rk-slot').forEach((row) => {
    const a = Number((row.querySelector('.rk-a') || {}).value);
    const b = Number((row.querySelector('.rk-b') || {}).value);
    if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1) out.push([a, b]);
  });
  // 去重（勾了「周三」又加了一段「周三~周三」是很自然的事，别让它变成 400）
  const seen = new Set();
  const slots = out
    .filter((s) => {
      const k = s[0] + '-' + s[1];
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return { freq: f, slots };
}

/**
 * 功能：把「任务的归属可能被改过」算清楚 —— 改了就**先搬**（`POST /api/tasks/move`），
 *      返回搬完之后该用的归属与任务 id。
 *
 * ⭐⭐ 0.8.14（第四轮）：「**任务的归属要可以修改**」。⭐⭐ 这份逻辑**只写一份**
 *    （两端共用，与 `tickOccurrence()` 同一条理由）：它不是版式，是「归属改了要怎么办」的**判据**，
 *    两端各写一遍必然漂移 —— 而漂移的表现是「手机上搬对了、电脑上按老 id 发 PUT ⇒ 404」。
 *
 * 说明：⚠️⭐ 搬移是「往另一张表插一行 + 删原行」⇒ **任务 id 会变**（见 `tasks/lib/tasks.js` 的
 *      `moveTask()`），所以后续那条 PUT 必须用**新归属 + 新 id**拼路径；沿用老 id 会打到一条
 *      已经不存在的老行（404）。⚠️ 归属**没变时一个请求都不发** —— 白搬一趟会让 id 平白改掉，
 *      所有按 id 挂着的东西（打卡记录、随手记追溯）都要跟着挪一遍，那是纯粹的风险。
 *
 * @param {?Object} t - 原任务（新建 / 草稿传 `null`）
 * @param {(string|number)} orig - 原归属（`'daily'` / 项目 id / `'all'` 当日常任务）
 * @param {(string|number)} next - 表单里选的归属
 * @returns {Promise.<{scope: (string|number), id: number}>} 后续要用的归属与任务 id（新建时 id 为 0）
 */
export async function settleScope(t, orig, next) {
  const scope = next === 'daily' || next == null || next === '' ? 'daily' : Number(next);
  if (!t || !t.id) return { scope, id: 0 };
  const from = orig === 'daily' || orig == null || orig === '' || orig === 'all' ? 'daily' : Number(orig);
  if (String(from) === String(scope)) return { scope, id: Number(t.id) };
  const moved = await api('POST', '/api/tasks/move', { from, id: Number(t.id), to: scope });
  return { scope, id: Number(moved.id) };
}

export function tickOccurrence(source, taskId, periodKey, on) {
  const q = `source=${encodeURIComponent(source)}&taskId=${encodeURIComponent(taskId)}&periodKey=${encodeURIComponent(
    periodKey,
  )}`;
  if (on) return api('POST', '/api/occurrences', { source, taskId: Number(taskId), periodKey });
  return api('DELETE', `/api/occurrences?${q}`);
}
