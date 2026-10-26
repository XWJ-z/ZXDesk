'use strict';
/**
 * modules/teamwork/store.js —— 对话业务方法（0.3.5）
 *
 * 功能：好友（申请 / 同意 / 拒绝 / 删除 / 拉黑 / **备注**）与一对一消息（开会话 / 列表 / 分页 / 增量 /
 *      发送 / 标记已读 / 未读合计）的全部业务规则都落在这里。路由层只做「解析路径 + 读请求体」，
 *      存储层只做数据搬运 —— ⭐ **权限判定只在本文件里实现一份**。
 *
 * ⭐ **本模块是项目里唯一的「跨账号」模块，三条与其它模块不同的硬约束**（方案 §4.4）：
 *   ① **判权看成员关系，不看 `user_id`**：会话不归某一个人所有，「你是不是这个会话的成员」
 *      才是唯一判据（`teamwork_members`）。所以每个方法开头都是 `_assertTeamworkAccess()`。
 *   ② **越权与「不存在」逐字一致（404）**：不能让人靠状态码探测「这个会话存不存在」。
 *   ③ ⭐ **好友关系是一道额外的闸门**：一对一对话里，**不再是好友就读不到**（含历史消息）——
 *      这是方案 §八-2 明确要求的一期规则，也是「删掉好友」这个动作真正的含义。
 *      ⚠️ 它与 ① 并不矛盾：① 说的是「谁能碰这个会话」，③ 说的是「碰得到的前提下还算不算数」。
 *      实现上**数据一条不删**：重新加回好友，历史消息原样回来（比「删好友即焚」更符合直觉，
 *      也避免了「手滑点错删除，几年的聊天记录全没了」）。
 *
 * ⚠️ 本文件的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走 `this._bk.<op>(...)`
 *    （存储原语层门面，见 store/backend/index.js）。
 * ⚠️ 也**不许**用 `list` / `get` / `update` 这类通用方法名（`store/index.js` 用 `Object.assign`
 *    把各业务模块平铺到同一个原型上，通用名会静默覆盖别的模块 —— 见 `modules/hardware/store.js`
 *    记录的撞名事故；⚠️ 0.5.0起这条规矩由装配期护栏 `assertNoMethodClash()` 机械兜住）。
 *    所以本文件所有方法都带 `teamwork` 前缀。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/teamwork.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 只改了相对路径与这段说明，
 *    方法体一个字没动。
 *    ⚠️ **跨账号的三条硬约束一个字都没改**：判权看成员关系（`teamwork_members`）不看 `user_id`、
 *    越权与不存在统一 404、删好友只是关闸门**不删消息**。
 *
 * ⭐⭐ 0.8.12：**AI 助手的聊天会话并进本模块** —— 会话行 `builtin_key = 'ai'`、
 *    消息行 `sender_builtin = 'ai'`，形状与提醒助手一视同仁。本文件新增一组 `teamworkAi*`
 *    公开业务方法（AI 模块**只许**调它们），以及**存量 AI 会话的懒迁移**
 *    `_ensureAiMigrated()`（挂在进对话页 / 首次碰 AI 会话那一拍；先体检、整份事务、幂等、老表保留）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.54
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */
const { addDays, nowStamp, notFoundErr, badRequest } = require('../../core/store/helpers.js');
// ⭐ 0.8.54：聊天图片的消息种类（`kind='image'`）—— 落盘口径与它同住 `lib/chat-image.js`，
//    ⛔ 别在方法体里写字符串字面量（前端那份同名常量由测试对账）。
const { IMAGE_KIND } = require('./lib/chat-image.js');
// ⭐ 0.7.7：`dateOrdinal()` 用来算「回收站还剩几天」（与 ticker 里「逾期几天」同一条规矩：
//    用序日差，不用 `new Date()` 相减 —— 那个会在某些日子差一天）。它只依赖日期字符串，不成环。
const { dateOrdinal } = require('../../core/timetable/date-util.js');

/**
 * 功能：构造 429（太频繁）错误 —— 由路由层直接 `json()` 回给前端。
 * @param {string} message - 中文说明
 * @returns {Error} 带 `status = 429` 的错误对象
 */
function tooMany(message) {
  const e = new Error(message);
  e.status = 429;
  return e;
}

/**
 * 内置角色标识 —— ⭐ **提醒助手**（「中性、无文化或政治联想 —— 起名要先过敏感关」）。
 * @type {string}
 */
const BUILTIN_REMINDER = 'reminder';

/**
 * 内置角色标识 —— ⭐ **AI 助手**（0.8.12）。
 *
 * 说明：⭐ AI 的聊天会话从「ai 模块自己的两张表」并进对话两张表（`builtin_key = 'ai'`），
 *      形状与提醒助手**完全一致**：会话行靠 `builtin_key`、消息行靠 `sender_builtin = 'ai'`。
 *      ⚠️ 与提醒助手的两点不同（别照抄）：
 *      · 它**不走**「发消息就自动回一句」（那是提醒助手专有的行为，见 `teamworkSendMessage`）；
 *      · 它的回复由 `modules/ai` 调模型生成，经 `teamworkAiAppendMessage()` 落库。
 * @type {string}
 */
const BUILTIN_AI = 'ai';

/**
 * 内置角色标识 → 界面上显示的名字。
 *
 * 说明：⭐ 名字**只有这一处**（服务端随会话行一起给出 `builtin_name`），两端界面只负责显示 ——
 *      两端各写一份的下场是「电脑端叫提醒助手、手机端叫小助手」，而且不报任何错。
 *      ⚠️ `builtin_name` 里「我起的称呼」只对**提醒助手**生效（住 `teamwork_reminder_prefs`）——
 *      AI 助手没有那个设置，直接用这里的固定名。
 * @type {Object.<string, string>}
 */
const BUILTIN_LABELS = { [BUILTIN_REMINDER]: '提醒助手', [BUILTIN_AI]: 'AI 助手' };

/**
 * 提醒偏好的**缺省值** —— ⭐ 全项目**唯一一处**。
 *
 * 说明：⚠️ 两个后端与两处 DDL 都**不兜默认值**（`getReminderPrefs` 取不到就回 null）：
 *      默认值分散在多处时，表现是「换了后端提醒时刻就变了」，而且查起来毫无线索。
 *      这里就是方案 §十三-3 定案的那三档：上课提前 **20 分钟** / 任务提醒 **20:00** /
 *      逾期汇总 **07:00**。
 * @type {Object}
 */
const REMINDER_PREFS_DEFAULT = {
  enabled: 1,
  course_lead_minutes: 20,
  task_at: '20:00',
  overdue_at: '07:00',
  due_lead_minutes: 0,
  // ⭐ 0.6.4（「增加人文关怀消息」）：当天课上完了发一句问候。默认**开**。
  //    ⚠️ 它与那四个时刻不是一回事 —— 那几个回答「什么时候提醒我做事」，这条是「课都上完了，说句话」。
  care_enabled: 1,
  // ⭐ 我给内置角色起的**称呼**。空串 = **没改过**，显示时回落 `BUILTIN_LABELS`。
  //    ⚠️ 它就在这张「对话自己的设置」表里：一个账号一份、与提醒设置同生同死（同一个接口写）。
  builtin_name: '',
};

/** 提醒偏好里**允许被写**的七个键 —— 与 `upsertReminderPrefs` 的几个列一一对应（多一个都没有去处） */
const REMINDER_PREF_KEYS = [
  'enabled',
  'course_lead_minutes',
  'task_at',
  'overdue_at',
  'due_lead_minutes',
  'care_enabled',
  'builtin_name',
];

/**
 * 「发一组测试提醒」的四种正文（0.7.7）—— ⭐ 定义在**服务端这一处**（路由层只负责把它们推出去）。
 *
 * 说明：⚠️ 别让路由层再拼一遍：那样「测试提醒的内容」就有了两份，改一处忘一处是迟早的事。
 *      这四句话要说清的正是用户唯一想知道的：**每种提醒长什么样、落在哪儿**。
 *      ⭐ 顺序 = 四种卡片的顺序（上课 / 今日到期 / 逾期 / 问候），与 `REMIND_TEST_KINDS` 一一对应。
 * @type {Array.<{kind: string, body: string}>}
 */
const REMINDER_TEST_ITEMS = [
  {
    kind: 'remind_course',
    body:
      '【上课提醒】还有 20 分钟上课\n\n第 3–4 节 10:00 开始 ·《医学影像设备学》\n' +
      '教室：实训楼 A302\n【课程备注】带上学籍卡\n【本节备注】这节课要交实验报告',
  },
  {
    kind: 'remind_task_today',
    body: '【任务提醒】今天到期 2 件\n· [项目：毕业设计] 整理第 3 章数据\n· 交实习周报',
  },
  {
    kind: 'remind_overdue',
    body: '【逾期提醒】有 2 件任务已经逾期，最久的排在最前\n· 【逾期 5 天】[项目：毕业设计] 找导师签字\n· 【逾期 1 天】体检表交到学院',
  },
  { kind: 'remind_care', body: '今天的课都上完啦，辛苦啦 ☕' },
];

/**
 * ⭐ 给内置角色发消息之后的**自动回复**（0.7.7）。
 *
 * 说明：⭐ 只定义在**服务端这一处**：两端界面上那句提示（「这里只发提醒；想聊天请到「AI 助手」」）
 *      与这句话说的是同一件事 —— 措辞由两端自己定（它们是提示语），但这句**回复的正文**
 *      必须只有一份，否则改一处就会出现「电脑端说请与 AI 助手对话、手机端说别的话」。
 *      ⚠️ 它是**无状态**的：每条用户消息回一条（时序无关）。若将来「刷屏」成为真问题，
 *      再加一个 60 秒窗口 —— 本期不做（见 17-对话.md 的相应说明）。
 * @type {string}
 */
const BUILTIN_AUTO_REPLY = '请与 AI 助手对话';

/**
 * 清理记录在**回收站里可恢复**的天数（0.7.7）。
 *
 * 说明：⚠️⭐ 它**只决定回收站里还显不显示、还能不能恢复** —— ⛔ 绝不参与可见性判定
 *      （一旦参与，30 天后被清掉的消息会全部复活，见 `schema.js` 的 `teamwork_cleared`）。
 *      ⚠️ 「到期自动清理」= 条目从回收站消失、**不可再恢复**，⛔ 不加定时器、不写后台任务。
 * @type {number}
 */
const CLEAR_KEEP_DAYS = 30;


/**
 * 好友设置的**缺省值** —— ⭐ 全项目**唯一一处**（0.7.7）。
 *
 * 说明：⚠️ 与提醒偏好同一手法：两个后端都**不兜默认值**（`getFriendPrefs` 取不到就回 null），
 *      默认值分散在多处时的表现是「换了后端设置就变了」，而且查起来毫无线索。
 *      ⚠️ `auto_accept_friend` 默认 **0（关）**：一期「必须对方同意」那条规矩是默认行为，
 *      自动通过是**我主动打开**的一个便利开关，不该反过来。
 * @type {Object}
 */
const FRIEND_PREFS_DEFAULT = { auto_accept_friend: 0 };

/** 好友设置里**允许被写**的键 —— 与 `upsertFriendPrefs` 的列一一对应（多一个都没有去处） */
const FRIEND_PREF_KEYS = ['auto_accept_friend'];

/** 消息发送节流：**多久之内最多几条**（方案 §八-4）。⚠️ 这是「防打垮服务」而不是「防刷屏」 */
const SEND_MAX = 20;
const SEND_WINDOW_MS = 10000;

/** 好友申请节流（防骚扰）：一分钟最多 10 次 */
const FRIEND_REQ_MAX = 10;
const FRIEND_REQ_WINDOW_MS = 60000;

/**
 * 功能：**进程内**的滑动窗口限流 —— `Map<key, 时间戳数组>`。
 *
 * 说明：⚠️ 刻意**只用进程内内存**、不落库：这类节流是「防打垮服务」的护栏，
 *      重启后重新计数没有任何问题，而落库会平白多出一张会无限增长的表。
 *      与登录失败节流（`auth.js`）同一个性质。
 *
 * @param {Map<string, Array.<number>>} map - 该用途的时间戳表
 * @param {string} key - 限流键（`teamwork:send:<uid>` / `teamwork:req:<uid>`）
 * @param {number} max - 窗口内允许的次数
 * @param {number} windowMs - 窗口长度（毫秒）
 * @returns {boolean} 允许通过返回 true，超限返回 false
 */
function allowRate(map, key, max, windowMs) {
  const now = Date.now();
  const hits = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    map.set(key, hits);
    return false;
  }
  hits.push(now);
  map.set(key, hits);
  return true;
}

/** 发消息节流表（`teamwork:send:<uid>` → 时间戳数组） @type {Map<string, Array.<number>>} */
const sendHits = new Map();

/** 好友申请节流表（`teamwork:req:<uid>` → 时间戳数组） @type {Map<string, Array.<number>>} */
const friendReqHits = new Map();

/**
 * 功能：把账号行裁成「可以给**别人**看的那几列」。
 *
 * 说明：⭐ 对话是本项目第一次出现「A 的内容给 B 看」，所以「哪些字段能跨账号」必须显式写出来，
 *      而不是顺手把 `sanitizeUser()` 的结果整个递出去（那个结果里有 `hide_*` 显示偏好、
 *      有 `vault_lock_minutes`、有 `updated_at` 这类与别人无关的东西 ——
 *      它们不是机密，但「用不到的字段就不给」是项目里 `listUsers()` 一直守着的规矩）。
 *      这里只留：id / 登录名 / 显示名 / 最近登录时间。
 *      ⚠️ 不含 `is_admin` —— 加好友不需要知道对方是不是管理员，那是身份标签而非社交信息。
 *
 * @param {?Object} u - 账号元信息（`sanitizeUser` 的产物）
 * @returns {?Object} 只含 `id` / `username` / `display_name` / `last_login_at` 的对象
 */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    last_login_at: u.last_login_at || null,
  };
}

/**
 * ⭐⭐ **仅服务端可写**的消息种类（0.7.7）—— 四种系统提醒各一个名字。
 *
 * 说明：⚠️⭐ 它们**绝不在 `core/validate.js` 的 `TEAMWORK_KINDS`（客户端可发）里** ——
 *      进了就等于任何登录用户都能伪造一条「系统提醒」。
 *      ⚠️ 与 `core/validate.js` 的 `TEAMWORK_BUILTIN_KINDS` 是**同一份契约的两端**
 *      （那边是给「客户端可发白名单」做对照用的，这里是真正的校验处）。
 *      两份刻意**不互相 require**：`core/validate.js` 会 require `core/context.js`，
 *      而本文件正被 `context.js` 那条依赖链加载 —— 顶层 / 惰性的 require 都会把这条环真的走一遍
 *      （副作用是在测试进程里凭空建出一个数据目录）。⇒ 由 `ttt/test/teamwork.test.js` 那条
 *      「两处常量逐字相等」的对账断言兜住漂移（双份判据必须配对账测试）。
 *
 * @type {Array.<string>}
 */
const REMIND_KINDS = ['remind_course', 'remind_task_today', 'remind_overdue', 'remind_care', 'remind_trip'];

/**
 * 功能：把库里那一列 JSON 文本解析成对象（0.6.4，任务联动）。
 *
 * 说明：⭐ **解析只在这一处**（REST 与 SSE 两条路拿到的都是对象）：前端不必自己 `JSON.parse` ——
 *      手机端没有电脑版那样的 `normMsg()` 归一函数（见 `11` 的记录），
 *      「某一端忘了解析」的表现是那条卡片静静地退回降级文本，**谁也不报错**。
 *      ⚠️ 解析失败一律回 `null`（按普通消息处理）：库里的文本可能来自手改或更早的写入，
 *      那种情况下**降级成正文**才是对的 —— 不能让一条坏数据打断整个会话的渲染。
 *
 * @param {*} v - `teamwork_messages.meta` 的原始值（JSON 文本 / null / undefined / 已是对象）
 * @returns {?Object} 解析出的对象；空值、非对象或解析失败时返回 null
 */
function parseCardMeta(v) {
  if (v === undefined || v === null || v === '') return null;
  // ⚠️ 已经是对象就直接放行：JSON 后端存的是原样值，测试夹具也常常直接给对象
  if (typeof v === 'object') return Array.isArray(v) ? null : v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (_e) {
    return null;
  }
}

// ⭐ 0.8.12：`lib/collab.js`（协作那一层的判权与业务方法）从
//    `modules/tasks/` **整份搬进本模块**，在这里与本文件的「对话」方法合成一张方法表
//    （`Object.assign`；两份**决不允许有同名方法** —— 装配期 `assertNoMethodClash()` 机械复查）。
module.exports = Object.assign(
  {
  // ================= 好友 =================
  /**
   * 功能：好友总览 —— 我的好友 / 待我处理 / 我发出的 / 已拉黑 / 未读合计（`GET /api/teamwork/friends`）。
   *
   * 说明：⭐ 一次请求把「好友页 + 会话页」要画的东西取齐：
   *      `conversations` 顺带给出去（含每个会话的未读数与最后一条），前端打开对话页不必再打一次接口。
   *      ⚠️ 账号信息**一次性取回**（`listUsers()` 一张表，不是「每个好友查一次」的 N+1）：
   *      好友数量在这个应用里是「一家人 / 一个团队」的量级，但 N+1 的写法一旦留下，
   *      将来没人会回头改。
   *      ⚠️ **已不是好友的会话不出现在任何列表里**（删好友之后它就是不可读的，见文件头 ③）。
   *
   * @param {number} uid - 账号 id
   * @returns {{ friends: Array.<Object>, incoming: Array.<Object>, outgoing: Array.<Object>,
   *      blocked: Array.<Object>, conversations: Array.<Object>, unreadTotal: number }} 好友页数据
   */
  teamworkFriendsOverview(uid) {
    const u = Number(uid);
    // ⭐ 0.6.x：进对话页是内置角色会话的**懒创建时机之一**（另一个是 ticker 第一次要发提醒时）——
    //    放在这里是因为「对话页的头一次取数」正好是「这个人真的在用对话」的时刻，
    //    比启动时给所有账号批量建会话要克制得多。
    this.teamworkEnsureBuiltinConversation(u);
    const usersById = new Map(this.listUsers().map((x) => [Number(x.id), x]));
    const withUser = (f) => Object.assign({}, f, { user: publicUser(usersById.get(Number(f.friend_id))) });

    const rows = this._bk.listFriendships(u);
    const conversations = this.teamworkListConversations(u);
    const convByFriend = new Map();
    conversations.forEach((c) => {
      if (c.peer_user) convByFriend.set(Number(c.peer_user.id), c);
    });

    const friends = rows
      .filter((f) => f.status === 'accepted')
      .map((f) => {
        const o = withUser(f);
        const c = convByFriend.get(Number(f.friend_id));
        return Object.assign(o, { conversation_id: c ? c.id : null, unread: c ? c.unread : 0 });
      });
    const incoming = rows.filter((f) => f.status === 'pending' && Number(f.requested_by) !== u).map(withUser);
    const outgoing = rows.filter((f) => f.status === 'pending' && Number(f.requested_by) === u).map(withUser);
    const blocked = rows.filter((f) => f.status === 'blocked').map(withUser);

    return {
      friends,
      incoming,
      outgoing,
      blocked,
      conversations,
      unreadTotal: conversations.reduce((n, c) => n + (Number(c.unread) || 0), 0),
    };
  },

  /**
   * 功能：发起好友申请（`POST /api/teamwork/friends`）—— 一次请求写**两行**（我→他 / 他→我）。
   *
   * 说明：⭐ 好友模型照 XMPP 的 roster/subscription：**申请 → 同意**才算好友，
   *      不是单向关注（否则陌生人可以直接骚扰，方案）。
   *      幂等：已经是好友、或已经有 pending 申请，都直接返回成功（连点两次不会造出两份关系）。
   *      ⚠️ **不能加自己**；⚠️ **任何一方拉黑了就拒绝**（拉黑的意义就是「别再发来」）。
   *      ⚠️ 目标账号不存在一律 404（与「会话不存在」同一种口径，见）。
   *
   *      ⭐ 0.7.7：**被申请方**开着「自动通过好友申请」时，申请**直接落成好友**（不再等对方点同意）。
   *      ⚠️⭐ 三条定死的语义：
   *      ① **判据只在这一处** —— 路由层不许再判一次（它只按返回的 `status` / `notified` 决定推什么）；
   *      ② **只对之后收到的申请生效** —— ⛔ 不做「打开开关就把历史申请批量同意掉」
   *         （一次误点会加进一堆人）；这句话也写在设置页的提示里；
   *      ③  一个字没动：⛔ 不造机器人账号、⛔ 不给 `teamwork_members` 加类型，
   *         判权继续只看 `teamwork_members`（这里只是让两行 `status` 直接是 `accepted`）。
   *
   * @param {number} uid - 发起人账号 id
   * @param {{userId?: number, username?: string}} input - 目标（二选一，`userId` 优先）
   * @returns {{ friendId: number, status: string, notified: boolean }} 目标账号 id / 结果状态 /
   *      「这一次真的建了关系、该通知对方」
   * @throws {Error} 目标为空 / 加自己 / 已被拉黑时抛 400；目标不存在抛 404；太频繁抛 429
   */
  teamworkRequestFriend(uid, input) {
    this._assertWritable();
    const me = Number(uid);
    const src = input || {};
    const target = src.userId ? this.getUser(Number(src.userId)) : this.findUserByName(src.username);
    if (!target) throw notFoundErr('账号');
    const fid = Number(target.id);
    if (fid === me) throw badRequest('不能加自己为好友');

    if (!allowRate(friendReqHits, `teamwork:req:${me}`, FRIEND_REQ_MAX, FRIEND_REQ_WINDOW_MS)) {
      throw tooMany('好友申请太频繁了，请稍后再试');
    }

    const mine = this._bk.getFriendship(me, fid);
    const theirs = this._bk.getFriendship(fid, me);
    // 拉黑是**单向动作、双向生效**：任一方拉黑过，就不再接受新的申请（改由对方先取消拉黑）
    if ((mine && mine.status === 'blocked') || (theirs && theirs.status === 'blocked')) {
      throw badRequest('对方已被拉黑（或你已拉黑对方）：需要先取消拉黑，才能再发好友申请');
    }
    // ⚠️ 幂等的两种返回**不带 `notified`**：那一头什么都没变，推给对方就是一次无谓的打扰
    if (mine && mine.status === 'accepted') return { friendId: fid, status: 'accepted', notified: false };
    if (mine && mine.status === 'pending') return { friendId: fid, status: 'pending', notified: false };

    const stamp = nowStamp();
    // ⭐ 0.7.7：**自动通过好友申请**（判据**只在这一处**，见方法说明 ①）。
    //    读的是**被申请方**（`fid`）的设置 —— 那是「谁在决定要不要别人直接进来」。
    const auto = Number(this.teamworkFriendPrefs(fid).auto_accept_friend) ? 1 : 0;
    this._bk.setFriendshipPair(me, fid, auto ? 'accepted' : 'pending', me, stamp);
    return { friendId: fid, status: auto ? 'accepted' : 'pending', notified: true };
  },

  /**
   * 功能：同意好友申请（`POST /api/teamwork/friends/:id/accept`）—— 把两行一起改成 `accepted`。
   *
   * 说明：⚠️ 只有**被申请方**能同意：`requested_by !== 我` 才行。
   *      自己发出的申请自己点同意，等于绕开「必须对方同意」这条设计（也就等于单向关注）。
   *
   * @param {number} uid - 账号 id
   * @param {number} friendId - 申请人账号 id
   * @returns {{ friendId: number }} 结果
   * @throws {Error} 没有待同意的申请时抛 400
   */
  teamworkAcceptFriend(uid, friendId) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    const row = this._bk.getFriendship(me, fid);
    if (!row) throw notFoundErr('好友申请');
    if (row.status === 'accepted') return { friendId: fid };
    if (row.status !== 'pending') throw badRequest('这条关系不是待处理的申请，无法同意');
    if (Number(row.requested_by) === me) throw badRequest('这是你发出的申请，要等对方同意');

    this._bk.setFriendshipPair(me, fid, 'accepted', fid, nowStamp());
    return { friendId: fid };
  },

  /**
   * 功能：拒绝好友申请（`POST /api/teamwork/friends/:id/reject`）—— **两行一起删掉**（不做「已拒绝」状态）。
   *
   * 说明：⭐ 为什么不留一个 `rejected` 状态：留着它就等于在对方那里显示「被拒绝了」——
   *      那是一种**已读回执式的社交压力**，而一期只要「申请没了」这个结果。
   *      对方看到的只是「申请还在等」（其实已作废），这是本应用刻意选择的方向。
   *
   * @param {number} uid - 账号 id
   * @param {number} friendId - 申请人账号 id
   * @returns {{ friendId: number }} 结果
   * @throws {Error} 没有待处理的申请时抛 404
   */
  teamworkRejectFriend(uid, friendId) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    const row = this._bk.getFriendship(me, fid);
    if (!row || row.status !== 'pending' || Number(row.requested_by) === me) throw notFoundErr('好友申请');
    this._bk.deleteFriendshipsBetween(me, fid);
    return { friendId: fid };
  },

  /**
   * 功能：删除好友（`DELETE /api/teamwork/friends/:id`）—— 两行一起删；**旧会话随之不可读**。
   *
   * 说明：⭐ 达到的效果就是方案 §八-2 要的那一条：「好友关系不构成读历史消息的权限」。
   *      ⚠️ 但实现上**一条消息都不删**（见文件头 ③）：只是这道闸门关上了，
   *      重新加回好友，历史消息原样回来。⚠️ 这也意味着「删好友」不是「清空聊天记录」，
   *      界面上必须把这一点说清楚，否则用户会以为删了就没了。
   *
   * @param {number} uid - 账号 id
   * @param {number} friendId - 对方账号 id
   * @returns {{ friendId: number }} 结果
   * @throws {Error} 双方不是好友时抛 404；数据层只读时抛 503
   */
  teamworkRemoveFriend(uid, friendId) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    const row = this._bk.getFriendship(me, fid);
    if (!row || row.status !== 'accepted') throw notFoundErr('好友');
    this._bk.deleteFriendshipsBetween(me, fid);
    return { friendId: fid };
  },

  /**
   * 功能：拉黑 / 取消拉黑（`POST /api/teamwork/friends/:id/block`，入参 `{ blocked }`）。
   *
   * 说明：⭐ 拉黑是**单向动作、双向冻结**：我的行是 `blocked`，对方那一行也置 `blocked` ——
   *      这样对方发来的申请会被明确拒绝（「已被拉黑」），而已有的会话两边都读不到。
   *      ⚠️ **取消拉黑 = 回到陌生人**（两行删掉、需要重新加好友），而不是「恢复成好友」：
   *      我们并没有保存「拉黑之前是不是好友」这个状态，与其猜，不如给一个确定的、说得清的规则。
   *      界面上会写明这一条。⚠️ 也不能取消「对方对我的拉黑」（那要求改对方那一行，
   *      属于越权）——对方拉黑了你时，你这里的 `blocked` 行根本不存在。
   *
   * @param {number} uid - 账号 id
   * @param {number} friendId - 对方账号 id
   * @param {boolean} blocked - true 拉黑，false 取消拉黑
   * @returns {{ friendId: number, blocked: boolean }} 结果
   * @throws {Error} 目标账号不存在抛 404；数据层只读时抛 503
   */
  teamworkSetBlocked(uid, friendId, blocked) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    if (me === fid) throw badRequest('不能拉黑自己');
    if (!this.getUser(fid)) throw notFoundErr('账号');
    const mine = this._bk.getFriendship(me, fid);
    if (!blocked) {
      // 「取消拉黑」= 两行都删掉（回到陌生人），不是恢复成好友 —— 理由见方法说明
      if (!mine || mine.status !== 'blocked') throw notFoundErr('拉黑记录');
      this._bk.deleteFriendshipsBetween(me, fid);
      return { friendId: fid, blocked: false };
    }
    const stamp = nowStamp();
    const by = mine && Number(mine.requested_by) ? Number(mine.requested_by) : me;
    this._bk.setFriendshipPair(me, fid, 'blocked', by, stamp);
    return { friendId: fid, blocked: true };
  },

  /**
   * 功能：改「我给某位好友起的备注」（`POST /api/teamwork/friends/:id/remark`，0.4.4）。
   *
   * 说明：⭐ **备注是单方面的** —— 它写在我这一行（`user_id = 我`），对方那一行一个字节都不动，
   *      所以对方在任何界面上都看不到我给他起的名字。这正是它与 `status` 的根本区别：
   *      `status` 两行必须一致（否则就是「A 认为是好友、B 不认为」的裂脑），备注则**必须不一致**。
   *      ⚠️ 走 `_update()` 而不是 `setFriendshipPair()`：后者会**两行一起写**，
   *      用它写备注等于把我的备注镜像给对方（一处静默的跨账号数据泄露）。
   *      `_update()` 自带 `user_id=?` 限定，天然改不到别人那一行。
   *      空串 = 清除备注（回到显示名）—— 这是正常操作，不是错误。
   *
   * @param {number} uid - 账号 id
   * @param {number} friendId - 对方账号 id
   * @param {string} remark - 新备注（已由 `checkFriendRemark()` 去空白；空串表示清除）
   * @returns {{ friendId: number, remark: string }} 结果
   * @throws {Error} 不是好友时抛 404（与「会话不存在」同一口径，见决策 31）；只读时抛 503
   */
  teamworkSetFriendRemark(uid, friendId, remark) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    const mine = this._bk.getFriendship(me, fid);
    // ⚠️ 只有 accepted 才给改：给「还没同意的申请人」起备注没有意义，
    //    而 blocked / pending 行一旦被改，将来同意/拉黑时会连同备注一起漂到不该在的地方。
    if (!mine || mine.status !== 'accepted') throw notFoundErr('好友');
    const value = String(remark == null ? '' : remark);
    const ok = this._update('teamwork_friendships', me, mine.id, { remark: value || null });
    if (!ok) throw notFoundErr('好友');
    return { friendId: fid, remark: value };
  },

  // ================= 会话 =================
  /**
   * 功能：⭐ **判权的唯一入口** —— 不是成员（或一对一里已不是好友）就抛 404。
   *
   * 说明：每一个读会话、写消息、标记已读的入口都**先过它**（方案 §4.4 的硬约束：
   *      「先判权、后取数」）。⚠️ 抛的是 404 而不是 403：403 等于告诉对方
   *      「这条记录存在，只是不归你」——那本身就是一个探测通道。
   *
   * @param {number} uid - 账号 id
   * @param {number} cid - 会话 id
   * @returns {Object} 会话行（判权通过后返回，调用方不必再查一次）
   * @throws {Error} 不是成员 / 会话不存在 / 一对一里已不是好友时抛 404
   */
  teamworkConversationOr404(uid, cid) {
    const me = Number(uid);
    const c = this._bk.getConversation(Number(cid));
    if (!c) throw notFoundErr('会话');
    if (!this._bk.isMember(me, c.id)) throw notFoundErr('会话');
    // ⭐ 0.6.x：**内置角色会话（提醒助手）到此为止** —— 它没有「对方」这个人，
    //    所以下面那道「还得是好友」的闸门对它不适用（它压根不在 `teamwork_friendships` 里）。
    //    ⚠️ 判权仍然**只看 `teamwork_members`**：不是成员照样在上面就 404 了。
    //    ⛔ 少了这一行，提醒助手会话会走进 `_teamworkPeerId() === null` 那一支，
    //    被当成「对方账号已注销」——能读、不能发，而且头衔写着「对方账号已注销」（一句假话）。
    if (c.builtin_key) return c;
    // ⭐ 一对一的额外闸门：不再互为好友 ⇒ 这个会话读不到（数据仍在，重新加回好友即恢复）。
    //    ⚠️ **例外：对方账号已注销**（会话里只剩我一个人）—— 那时它不是「被删了好友」，
    //    而是「那个人不在了」。这种会话**仍然读得到**（只读）：方案对删账号的承诺是
    //    「对方的历史会话缺一段」，若连会话一起看不见，就变成「整个会话消失」，比承诺的更糟。
    if (c.kind === 'direct') {
      const peer = this._teamworkPeerId(me, c.id);
      if (peer === null) return c; // 只剩我 → 对方账号已注销，可读不可写（见 teamworkSendMessage）
      const f = this._bk.getFriendship(me, peer);
      if (!f || f.status !== 'accepted') throw notFoundErr('会话');
    }
    return c;
  },

  /**
   * 功能：内部工具 —— 取一个一对一会话里**对方**的账号 id；取不到（成员数不对）时为 null。
   * @param {number} uid - 我方账号 id
   * @param {number} cid - 会话 id
   * @returns {?number} 对方账号 id
   */
  _teamworkPeerId(uid, cid) {
    const me = Number(uid);
    const other = this._bk.listMembers(Number(cid)).find((m) => Number(m.user_id) !== me);
    return other ? Number(other.user_id) : null;
  },

  /**
   * 功能：列出「我参与的、且仍然是好友的」一对一会话（会话列表页）。
   *
   * 说明：⭐ 每个会话带上：对方的账号信息、**我自己的**未读数、最后一条消息的摘要（谁发的 / 内容 / 时间）。
   *      ⚠️ 未读数与排序都由 `listConversations` 这条原语算好（两个后端逐字一致），
   *      这里只负责把「对方是谁」补上，并**滤掉已不是好友的会话**（它们不可读，留在列表里只会点出 404）。
   *
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 会话数组（**内置角色排最前**，其余按最后一条消息倒序）
   */
  teamworkListConversations(uid) {
    const me = Number(uid);
    // ⭐ 0.8.12：进对话页这一拍顺手跑一次**存量 AI 会话搬迁**（幂等、体检不过整份放弃）——
    //    它必须排在下面取列表之前，否则升级后第一次进对话页看不到那条 AI 会话。
    this._ensureAiMigrated();
    const usersById = new Map(this.listUsers().map((x) => [Number(x.id), x]));
    /**
     * 功能：会话列表里「最后一条是不是**我**发的」—— 用于给预览加「我：」前缀。
     * 说明：⭐ 0.6.x：内置角色（提醒助手）发的消息 `user_id` 也是我，所以**必须再排除它** ——
     *      少了后半句，提醒预览会写成「我：【上课提醒】…」（明明不是我说的）。
     */
    const lastMine = (c) =>
      c.last_sender_id === null || c.last_sender_id === undefined
        ? null
        : Number(c.last_sender_id) === me && !c.last_sender_builtin;
    const out = [];
    // ⭐ 0.6.x：内置角色在列表里显示的名字 —— **我给它起的称呼优先**，没起过才回落内置标签。
    //    ⚠️ 读一次就够（循环外）：这是同一账号的一份配置，不是每个会话各一份。
    const myBuiltinName = this.teamworkReminderPrefs(me).builtin_name;
    for (const c of this._bk.listConversations(me)) {
      // ⚠️⭐ 0.8.12：**AI 助手会话（`builtin_key = 'ai'`）刻意不进这张列表。**
      //    它的会话行与消息**已经住在本模块的两张表里**（2g 的搬迁，AI 只经 `teamworkAi*`
      //    这一组公开方法读写），但它的**界面**这一半还由 ai 模块自己的插槽视图提供
      //    （`zx:teamwork-conv-entries` ＋ `teamwork-thread` 槽 ——  的「托管」**尚未实施**）。
      //    ⇒ 若它在这里也列一遍，左栏「内置助手」会**同时出现两条 AI 助手**（一条插槽条目、
      //    一条真会话行），且点第二条会进一个只会画普通气泡、认不出提议卡与图片的空壳会话。
      //    ⚠️ **托管做完后删掉这一行** —— 届时就该由它作为一条真会话出现，AI 侧那条
      //    `zx:teamwork-conv-entries` 条目也要一起撤。`ttt/test/collab.test.js` 有断言钉住当前行为。
      if (c.builtin_key === BUILTIN_AI) continue;
      // ⭐ 0.6.x：内置角色会话（提醒助手）单独一支 —— 它没有 `peer_user`、不进好友关系，
      //    所以下面那一整套「对方是谁 / 还是不是好友」的判据对它全都不适用。
      if (c.builtin_key) {
        // ⚠️ 0.8.12：那个「我起的称呼」只属于**提醒助手**（住在提醒偏好里）——
        //    AI 助手直接用它自己的固定名，⛔ 别把提醒助手的称呼串到 AI 头上。
        const label = c.builtin_key === BUILTIN_REMINDER ? myBuiltinName || BUILTIN_LABELS[c.builtin_key] : BUILTIN_LABELS[c.builtin_key];
        out.push(
          Object.assign({}, c, {
            peer_user: null,
            peer_gone: false,
            peer_remark: null,
            builtin_name: label || '助手',
            last_mine: lastMine(c),
          }),
        );
        continue;
      }
      if (c.kind !== 'direct') continue;
      const peerId = this._teamworkPeerId(me, c.id);
      // ⚠️ `peerId === null` = 对方账号已注销：**仍然列出来**（只读），否则方案承诺的
      //    「对方的历史会话缺一段」会变成「会话凭空消失」，而用户完全不知道发生了什么。
      const peerGone = peerId === null;
      let peerRemark = null;
      if (!peerGone) {
        const f = this._bk.getFriendship(me, peerId);
        if (!f || f.status !== 'accepted') continue;
        // ⭐ 0.4.4：会话列表要显示「我给他起的名字」，所以这里把我这一行的备注一起带出去
        //    （`f` 是**我这一侧**的关系行，取的天然是单方面的备注，不会拿到对方的）。
        peerRemark = f.remark || null;
      }
      out.push(
        Object.assign({}, c, {
          peer_user: peerGone ? null : publicUser(usersById.get(peerId)),
          peer_gone: peerGone,
          peer_remark: peerRemark,
          last_mine: lastMine(c),
        }),
      );
    }
    // ⭐ 内置角色会话排最前（其余保持「最后一条消息倒序」）—— 理由见上面循环里那一支的说明。
    //    ⚠️ 用 `filter` 两趟而不是 `sort`：排序键（`last_message_id`）在两类会话之间没有可比性，
    //    硬塞进一个比较函数只会让「谁在前」变得看不出原因。
    return out.filter((c) => c.builtin_key).concat(out.filter((c) => !c.builtin_key));
  },

  /**
   * 功能：开一个一对一对话（`POST /api/teamwork/conversations`）—— **幂等**：已有就返回原来那个。
   *
   * 说明：⭐ 幂等是必须的：「点好友名字进对话」这个动作可能被点两次、可能两个设备同时点，
   *      不幂等就会造出两个同人的空会话，而且用户没有任何办法删掉多余的那个。
   *      ⚠️ **必须是好友**（方案 §六）：不然就等于绕开申请流程直接给陌生人发消息。
   *      两个成员行与会话行**一起写**：中间失败留下的是「谁都进不去的空会话」。
   *
   * @param {number} uid - 账号 id
   * @param {number} friendId - 对方账号 id
   * @returns {{ id: number, created: boolean }} 会话 id 与这次是不是新建的
   * @throws {Error} 不是好友时抛 400；数据层只读时抛 503
   */
  teamworkStartConversation(uid, friendId) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    const f = this._bk.getFriendship(me, fid);
    if (!f || f.status !== 'accepted') throw badRequest('你们还不是好友，先加好友才能开始对话');
    const existed = this._bk.findDirectConversation(me, fid);
    if (existed) return { id: Number(existed.id), created: false };

    const stamp = nowStamp();
    const conv = this._bk.insert('teamwork_conversations', {
      user_id: me,
      kind: 'direct',
      title: null,
      last_message_id: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    this._bk.insertMember(me, conv.id, stamp);
    this._bk.insertMember(fid, conv.id, stamp);
    return { id: Number(conv.id), created: true };
  },

  /**
   * 功能：取一个会话的消息（`GET /api/teamwork/conversations/:id/messages`）——
   *      `before` 取更早的历史（向上翻），`after` 取更新的增量（断线补齐 / 轮询降级）。
   *
   * 说明：⭐ 返回的 `items` **一律按 id 升序**（= 展示顺序，旧的在上）：
   *      存储层历史上是倒序取「最近 N 条」，这里翻回来，前端不必关心方向。
   *      ⚠️ `hasMore` 只在 `before` 模式下有意义（还有更早的没取），
   *      前端据此决定「还能不能继续往上翻」；`after` 模式永远不会「还有更多」。
   *
   * @param {number} uid - 账号 id
   * @param {number} cid - 会话 id
   * @param {{before?: ?number, after?: ?number, limit?: number}} [opts] - 分页参数（路由层已校验）
   * @returns {{ items: Array.<Object>, hasMore: boolean }} 消息数组（升序）与是否还有更早的
   * @throws {Error} 不是成员 / 已不是好友时抛 404
   */
  teamworkMessages(uid, cid, opts) {
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const o = opts || {};
    const limit = Number(o.limit) > 0 ? Math.min(Number(o.limit), 200) : 50;
    const after = Number(o.after) > 0 ? Number(o.after) : null;
    const before = Number(o.before) > 0 ? Number(o.before) : null;
    // ⭐ 0.7.7：`me` 传下去 —— 「我清掉的那几段」要在存储层就滤掉（判据在 `backend/` 里一处）
    const rows = this._bk.listMessages(c.id, before, after, limit, me);
    const items = after !== null ? rows.slice() : rows.slice().reverse();
    // ⭐ 0.6.4（任务联动）：卡片消息的两列在这里**统一归一**（`kind` 补成 null、`meta` 解析成对象）——
    //    前端两条路（REST / SSE）拿到同一种形状，两端渲染代码不必各判一次「这列在不在」。
    //    ⚠️ 老库补出来的列就是 NULL，这一段对普通消息是**恒等变换**（改动前的老数据一字不变）。
    for (const m of items) {
      m.kind = m.kind || null;
      m.meta = parseCardMeta(m.meta);
    }
    // ⭐ 0.4.4：给这一页消息补上「我从它建过哪些任务」——
    //    界面据此在气泡下面画一枚可点的「已添加到任务 · 任务标题」。
    //    ⚠️ 关联存在**任务那一侧**（`project_tasks` / `daily_tasks` 的 `from_message_id`），
    //    查的是**我自己的任务** ⇒ 对方那边永远查不到，结构上不会泄露（见 modules/tasks/schema.js 文件头）。
    //    ⚠️ 顺带把「存储层的行」与「对外的消息形状」分开：这里只**加**一个 `tasks` 字段，
    //    原本的列照原样带出去（前端 `normMsg()` 不认它，所以它不会污染消息本身）。
    this._attachMessageTasks(me, items);
    return { items, hasMore: after === null && rows.length === limit };
  },

  /**
   * 功能：就地把「我从这些消息建过的任务」挂到消息行上（`tasks` 字段，按消息 id 分组）。
   *
   * 说明：⭐ 查不到的消息行**也挂一个空数组**（而不是不挂）：前端两种形状都要判，
   *      统一成「一定有个数组」少一处 `undefined` 分支。
   *      ⭐ 0.5.2：每项带 `status`（`todo` / `done`）—— 界面在这枚标记上要写清做完没有。
   *      ⚠️ 只在有消息时才发查询；一次查两张任务表（原语 `tasksFromMessages`），
   *      不做「每条消息查一次」的 N+1。
   *
   * @param {number} uid - 账号 id（**只查这个账号自己的任务**）
   * @param {Array.<Object>} items - 消息行数组（就地修改）
   * @returns {void}
   */
  _attachMessageTasks(uid, items) {
    if (!items.length) return;
    const byMsg = new Map();
    for (const row of this._bk.tasksFromMessages(
      uid,
      items.map((m) => m.id),
    )) {
      const k = Number(row.message_id);
      if (!byMsg.has(k)) byMsg.set(k, []);
      // ⭐ 0.5.2：带上 `status` —— 「添加到任务的消息下应该显示这个任务的完成状态，
      //    没有完成用红色、完成是灰色并用横线划掉」。它由任务那一侧的 `tasksFromMessages` 一起给出。
      byMsg
        .get(k)
        .push({ scope: row.scope, id: Number(row.task_id), title: row.title, status: row.status === 'done' ? 'done' : 'todo' });
    }
    for (const m of items) m.tasks = byMsg.get(Number(m.id)) || [];
  },

  /**
   * 功能：发一条消息（`POST /api/teamwork/conversations/:id/messages`）。
   *
   * 说明：⚠️ 这道闸门里有两层：**判权**（成员 + 仍是好友 → 否则 404）与**节流**（太频繁 → 429）。
   *      两层都过了才写库；写入本身在一个事务里（消息 + 会话的 `last_message_id`）。
   *      ⚠️ 正文的「非空 + 长度上限」由 `validate.checkTeamworkMessage` 在这一层之前把关，
   *      这里再兜一次「去空白后不能为空」——路由层不是唯一入口（将来还会有别的调用方）。
   *
   * @param {number} uid - 发送者账号 id
   * @param {number} cid - 会话 id
   * @param {string} body - 消息正文（纯文本）
   * @param {{kind?: ?string, meta?: ?string}} [opts] - 0.6.4（任务联动）：可选的卡片种类与
   *      **已序列化**的载荷（两者都来自 `validate.js`，本层不解析也不校验字段语义）
   *      ⭐ 0.7.7：在**内置角色会话**里发消息之后，服务端**立刻自动回一句**
   *      （`BUILTIN_AUTO_REPLY`）—— 它是「这里只发提醒、不陪聊」这件事的**行为化表达**：
   *      只把那句话写在输入框提示里，用户仍会以为「发了没反应」。
   *      ⚠️ 三条定死的语义：
   *      ① **每条回一条**（无状态、时序无关）；⛔ 本期不做「60 秒只回一次」的窗口；
   *      ②  一个字没动：⛔ 不造机器人账号 —— 这条回复的 `user_id` 照样写**会话归属者**，
   *         ⛔ 不动 `teamwork_members`、⛔ 不改判权（别人读这条会话照样 404）；
   *      ③ **不写提醒流水**（它不是提醒，是一条自动回复）⇒ `teamwork_reminders` 里没有它。
   *
   * @returns {{ id: number, conversationId: number, createdAt: string, kind: ?string,
   *      meta: ?Object, reply: ?Object }} 新消息（`meta` 已解析成对象，与 `teamworkMessages()` 的形状一致）；
   *      `reply` 是内置会话里的自动回复（普通会话恒为 null）
   * @throws {Error} 判权失败抛 404、空正文抛 400、太频繁抛 429；数据层只读时抛 503
   */
  teamworkSendMessage(uid, cid, body, opts) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const text = String(body == null ? '' : body).trim();
    if (!text) throw badRequest('消息不能为空');
    // ⭐ 0.6.x：内置角色会话**可以发**（那是「我」和助手之间的一条线，写进去只落在我自己库里）。
    //    它没有「对方」，所以下面那道「对方已注销」的判断对它不适用。
    // ⭐ 对方账号已注销 ⇒ 这个会话是**只读**的：还能翻历史，但发出去也没人收得到。
    //    与其写进库里变成一条永远不会有回音的记录，不如当场说清楚。
    if (!c.builtin_key && this._teamworkPeerId(me, c.id) === null) {
      throw badRequest('对方的账号已注销，这条会话不能再发消息（历史消息仍可查看）');
    }
    if (!allowRate(sendHits, `teamwork:send:${me}`, SEND_MAX, SEND_WINDOW_MS)) {
      throw tooMany('发得太快了，请稍后再发');
    }
    const o = opts || {};
    const kind = o.kind ? String(o.kind) : null;
    const meta = kind && o.meta ? String(o.meta) : null;
    const createdAt = nowStamp();
    const row = this._bk.insertMessage(me, c.id, text, createdAt, null, kind, meta);
    // ⭐ 0.7.7：内置角色会话 ⇒ 立刻回一句（判据**只在这一处**：`c.builtin_key` 有值）。
    //    ⚠️ 路由层负责把它推出去（本层不碰 SSE —— `notify.js` 那条链有加载时序的讲究）。
    //    ⚠️⭐ 0.8.12：⛔ **只对提醒助手**自动回复 —— AI 的会话（`builtin_key = 'ai'`）
    //    回复由模型生成、经 `teamworkAiAppendMessage()` 落库；在这里回一句「请与 AI 助手对话」
    //    会驴唇不对马嘴（AI 自己就是那个助手）。
    let reply = null;
    if (c.builtin_key === BUILTIN_REMINDER) {
      const at = nowStamp();
      const rr = this._bk.insertMessage(me, c.id, BUILTIN_AUTO_REPLY, at, BUILTIN_REMINDER, null, null);
      reply = {
        id: Number(rr.id),
        conversationId: Number(c.id),
        body: BUILTIN_AUTO_REPLY,
        createdAt: at,
        senderBuiltin: BUILTIN_REMINDER,
        // ⚠️ 这条回复**不画卡片**（它就是一句普通文本）⇒ kind 恒为 null
        kind: null,
      };
    }
    // ⚠️ 返回值里的 `meta` 是**对象**（不是库里那个 JSON 字符串）：路由层拿它拼 SSE 帧，
    //    前端两条路（REST / SSE）必须拿到同一种形状。
    return {
      id: Number(row.id),
      conversationId: Number(c.id),
      createdAt,
      kind,
      meta: parseCardMeta(meta),
      reply,
    };
  },

  /**
   * 功能：**发一条图片消息**（⭐ 0.8.54「点击加号可以发送图片」）。
   *
   * 说明：⭐⭐ 字节已经由路由落好盘（`readBodyToFile()` → 算 sha → 内容寻址改名），本方法只做三件事：
   *      ① 会话判权（`teamworkConversationOr404`，与读消息**同一个口**）；
   *      ② 限流（与文本消息**同一个桶** —— 不然「发图片」就是绕开频率限制的后门）；
   *      ③ 写一行 `kind='image'` 的消息，`meta` 由**服务端自己拼**（⛔ 不吃客户端给的 meta）。
   *      ⚠️⭐ `kind='image'` **不在**客户端可发的白名单里（`validate.js` 的 `TEAMWORK_KINDS`）：
   *      只有上传路由能造出图片消息 —— 否则谁都能发一条指向「别人图片」的消息。
   *      ⚠️ `body` 照样必填（降级文本：老客户端 / 渲染失败时看到的是「【图片】名字」，不是空白）。
   * @param {number} uid - 账号 id
   * @param {number} cid - 会话 id
   * @param {{name: string, ext: string, size: number, sha: string}} info - 落盘结果
   * @returns {{id: number, conversationId: number, createdAt: string, kind: string, meta: Object}}
   *      新消息（`meta` 已解析成对象，形状与 `teamworkMessages()` 一致）
   * @throws {Error} 判权失败抛 404、对方已注销 / 参数不全抛 400、太频繁抛 429；只读时抛 503
   */
  teamworkSendImage(uid, cid, info) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const i = info || {};
    if (!i.sha || !i.ext || !(Number(i.size) > 0)) throw badRequest('图片没存好，请再试一次');
    // ⭐ 与文本消息同一档：对方账号已注销 ⇒ 这条会话只读（理由见 `teamworkSendMessage()`）。
    if (!c.builtin_key && this._teamworkPeerId(me, c.id) === null) {
      throw badRequest('对方的账号已注销，这条会话不能再发消息（历史消息仍可查看）');
    }
    if (!allowRate(sendHits, `teamwork:send:${me}`, SEND_MAX, SEND_WINDOW_MS)) {
      throw tooMany('发得太快了，请稍后再发');
    }
    const name = String(i.name == null ? '' : i.name).slice(0, 120);
    const createdAt = nowStamp();
    const body = `【图片】${name || '图片'}`;
    const meta = JSON.stringify({ name, ext: String(i.ext), size: Number(i.size), sha: String(i.sha) });
    const row = this._bk.insertMessage(me, c.id, body, createdAt, null, IMAGE_KIND, meta);
    return {
      id: Number(row.id),
      conversationId: Number(c.id),
      createdAt,
      kind: IMAGE_KIND,
      meta: JSON.parse(meta),
    };
  },

  /**
   * 功能：标记会话已读（`POST /api/teamwork/conversations/:id/read`）—— 把**我的**已读游标推进。
   *
   * 说明：⚠️ 游标只许前进（存储层用 `COALESCE(last_read_id,0) < ?` 兜住），
   *      多端同时在线时不会出现「红点去掉了又回来」。
   *      ⚠️ 而且**先夹到「这个会话现有的最大消息 id」**：游标是**全局自增 id**，
   *      直接收下 `999999` 会让这个会话**将来所有**的消息都被当成已读 —— 那是一个
   *      「未读红点时灵时不灵」的静默故障（用户在若干天后才会发现，且完全查不出原因）。
   *      ⚠️ 一期**不把已读状态推给对方**（方案 §一：已读回执「给对方看」不做）——
   *      所以这里不产生任何 SSE 事件。
   *
   * @param {number} uid - 账号 id
   * @param {number} cid - 会话 id
   * @param {number} lastReadId - 读到的最后一条消息 id
   * @returns {{ lastReadId: number }} 生效后的游标
   * @throws {Error} 判权失败抛 404、游标非法抛 400；数据层只读时抛 503
   */
  teamworkMarkRead(uid, cid, lastReadId) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const n = Number(lastReadId);
    if (!Number.isInteger(n) || n < 0) throw badRequest('已读位置不合法');
    const target = Math.min(n, this._bk.maxMessageId(c.id));
    const member = this._bk.getMember(me, c.id);
    const cur = member ? Number(member.last_read_id) || 0 : 0;
    if (target > cur) this._bk.updateMemberRead(me, c.id, target);
    return { lastReadId: Math.max(cur, target) };
  },

  /**
   * 功能：取一个会话的**成员账号 id 清单** —— 路由层据此决定 SSE 推给谁（方案 §八-3）。
   * @param {number} cid - 会话 id
   * @returns {Array.<number>} 成员账号 id 数组
   */
  teamworkMemberIds(cid) {
    return this._bk
      .listMembers(Number(cid))
      .map((m) => Number(m.user_id))
      .filter((n) => Number.isInteger(n));
  },

  /**
   * 功能：未读消息合计（侧栏 / 底部标签的红点用）。
   * @param {number} uid - 账号 id
   * @returns {number} 未读条数
   */
  teamworkUnreadTotal(uid) {
    return this.teamworkListConversations(uid).reduce((n, c) => n + (Number(c.unread) || 0), 0);
  },

  /**
   * 功能：清空**进程内**的节流计数（测试缝）。
   *
   * 说明：⚠️ 只给测试用（`ttt/test/teamwork.test.js`）：同一批用例一会儿要连发几十条验证上限、
   *      一会儿又要验证正常发送，节流表会互相干扰。生产代码里没有任何调用点。
   *
   * @returns {void}
   */
  _teamworkDebugResetRateLimits() {
    sendHits.clear();
    friendReqHits.clear();
  },

  // ================= 内置角色与提醒（0.6.x，对话 2 期）=================
  /**
   * 功能：取（必要时**懒创建**）本账号与「提醒助手」的会话 id —— 没有可用会话时返回 null。
   *
   * 说明：⭐ **懒创建**是刻意的：内置角色会话「每个账号各自一条」，
   *      而绝大多数账号从不进对话页 —— 启动时给所有人批量建会话，等于给一张表先灌一堆
   *      「从没被打开过」的空会话。两个创建时机：**首次进对话页**（`teamworkFriendsOverview()`）
   *      与**首次要发提醒**（ticker 调用本方法）。
   *      ⚠️ 成员行只放「我」一条 ⇒ **判权继续只看 `teamwork_members`**；
   *      ⛔ 它**不进 `teamwork_friendships`**：内置角色不是好友，不能删、不能改备注、不能拉黑。
   *      ⚠️ **只读降级时不建**（返回 null）：创建是一次写，让它在只读态抛 503 会把
   *      整个对话页的首屏请求一起打掉 —— 宁可页面上少一个会话，也不能整屏打不开。
   *
   * @param {number} uid - 账号 id
   * @returns {?number} 会话 id；只读降级时返回 null
   */
  teamworkEnsureBuiltinConversation(uid) {
    const me = Number(uid);
    const existed = this._bk.findBuiltinConversation(me, BUILTIN_REMINDER);
    if (existed) return Number(existed.id);
    if (this.readOnly) return null;
    const stamp = nowStamp();
    const conv = this._bk.insert('teamwork_conversations', {
      user_id: me,
      // ⚠️ `kind` 恒为 `'direct'`：DDL 上是 `CHECK (kind IN ('direct'))`，改它要重建表
      //    ⇒ 推 SCHEMA_VERSION—— 为一个枚举值付一次结构迁移不划算。
      //    「这是不是内置角色」由 `builtin_key` 表达。
      kind: 'direct',
      // ⚠️ `title` 恒为 null：内置角色的显示名**不走这一列** —— 它住在
      //    `teamwork_reminder_prefs.builtin_name`（那是「我这一份对话设置」的一项，
      //    与提醒时刻同一个接口写、同生同死）。`title` 留给将来真正的群聊。
      title: null,
      builtin_key: BUILTIN_REMINDER,
      last_message_id: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    this._bk.insertMember(me, conv.id, stamp);
    return Number(conv.id);
  },

  // ================= AI 助手会话（0.8.12）=================
  // ⭐ AI 的聊天落库并进对话两张表之后，AI 模块**只提供「回复怎么生成」**，一切读写都走下面这组
  //    公开业务方法（⛔ AI 不许直接读写 teamwork 的表）。形状刻意与提醒助手一致。

  /**
   * 功能：跑一次（幂等的）**存量 AI 会话搬迁** —— 懒迁移，挂在每个碰 AI 会话的入口上。
   *
   * 说明：⭐⭐ 为什么是懒迁移而不是启动钩子：核心层对模块没有通用的启动钩子（只有课表那个
   *      `seedSchoolTemplates`），本模块**不许动核心层** ⇒ 把搬迁挂在「第一次进对话页 /
   *      第一次碰 AI 会话」这一拍（与协作那两处存量迁移同一手法）。
   *      ⚠️ 三条口径：
   *      ① **只读降级不搬**（`_assertWritable` 抛 503 时直接返回）—— 读口不因写不了而失败；
   *      ② **体检不过整份放弃**（op 返回 `abort`）：一行数据都不动、**不置已搬标记**，
   *         下一次再进来会重试，并按；
   *      ③ **见了就信**：op 返回 `skip`（已有 `builtin_key='ai'` 的会话）或 `done` 都算搬过，置标记。
   * @returns {void}
   */
  _ensureAiMigrated() {
    if (this._aiMigrated) return;
    try {
      this._assertWritable();
    } catch (_e) {
      return; // 只读降级：搬迁是写操作，读口不因此失败
    }
    const r = this._bk.migrateAiChatSessions();
    if (r && r.status === 'abort') {
      // —— 说清楚「哪一步没过、一行都没动、老表还在、会重试」。
      console.error(
        `[协作] AI 会话搬迁的体检没过（原因：${r.reason}）：整份放弃、一行数据都没动；` +
          '老表 ai_chats / ai_messages 原样保留。修好之后重启应用或再次进入对话页会重试。',
      );
      return;
    }
    this._aiMigrated = true;
  },

  /**
   * 功能：读本账号的 **AI 助手会话行**（不创建）；没有则 null —— AI 那边的只读路径用。
   * @param {number} uid - 账号 id
   * @returns {?Object} `teamwork_conversations` 行；没有为 null
   */
  teamworkAiConversation(uid) {
    this._ensureAiMigrated();
    return this._bk.findBuiltinConversation(Number(uid), BUILTIN_AI);
  },

  /**
   * 功能：取（必要时**懒创建**）本账号的 AI 助手会话行 —— 首用即建（每账号一条）。
   *
   * 说明：⚠️ 创建**之前先跑搬迁**（`_ensureAiMigrated`）：否则「新库先建了空会话」会把
   *      搬迁的幂等判据（新表里已有 `builtin_key='ai'` 的会话）提前点亮，老会话就永远搬不过来了。
   *      ⚠️ 只读降级**不建**（抛 503 由调用方收口，与提醒助手不同 —— AI 的创建是显式写路径）。
   * @param {number} uid - 账号 id
   * @returns {Object} 会话行
   * @throws {Error} 只读降级时抛 503
   */
  teamworkEnsureAiConversation(uid) {
    const me = Number(uid);
    this._ensureAiMigrated();
    const existed = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (existed) return existed;
    this._assertWritable();
    const stamp = nowStamp();
    const conv = this._bk.insert('teamwork_conversations', {
      user_id: me,
      kind: 'direct',
      title: BUILTIN_LABELS[BUILTIN_AI],
      builtin_key: BUILTIN_AI,
      cur_segment: null,
      last_message_id: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    this._bk.insertMember(me, conv.id, stamp);
    return conv;
  },

  /**
   * 功能：读 AI 助手会话的消息（**id 降序**，形状与 ai 的旧存储一致：`role` / `content` / `segment` …）。
   *
   * 说明：⭐ `sender_builtin = 'ai'` 翻译成 `role = 'assistant'`，其余一律 `'user'`（
   *      不造机器人账号、`user_id` 就是收件人自己）。⚠️ `meta` 这一层**原样是文本** ——
   *      解析成对象是 ai 侧 `decorateMessage()` 的事（提议卡的载荷格式属于 ai 模块）。
   * @param {number} uid - 账号 id
   * @param {?number} before - 游标（取 id 小于它的）；null = 从最新开始
   * @param {number} limit - 条数上限
   * @param {?number} segment - 只取这一段；null = 全部
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  teamworkAiMessages(uid, before, limit, segment) {
    this._ensureAiMigrated();
    const me = Number(uid);
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) return [];
    const rows = this._bk.listBuiltinChatMessages(me, Number(c.id), before || null, limit, segment || null);
    return rows.map((m) => ({
      id: Number(m.id),
      role: m.sender_builtin === BUILTIN_AI ? 'assistant' : 'user',
      content: m.body == null ? '' : String(m.body),
      segment: m.segment == null ? 1 : Number(m.segment),
      kind: m.kind == null ? null : String(m.kind),
      meta: m.meta == null ? null : String(m.meta),
      has_image: Number(m.has_image) === 1,
      created_at: m.created_at,
    }));
  },

  /**
   * 功能：往 AI 助手会话追加一条消息（AI 的回复与用户消息都走它），返回新消息 id。
   *
   * 说明：⚠️ 段号由**会话行**上的 `cur_segment` 决定（NULL 视为 1）—— 与 ai 2 期的口径一字不差。
   *      ⚠️ `senderBuiltin` 只应是 `'ai'`（助手说的）或 null（用户说的）。
   * @param {number} uid - 账号 id
   * @param {?string} senderBuiltin - `'ai'` / null
   * @param {string} body - 正文
   * @param {{kind?: ?string, meta?: ?string, image?: ?string}} [opts] - 卡片种类 / 快照文本 / 整串 data URL
   * @returns {{id: number}} 新消息 id
   * @throws {Error} 会话不存在时抛 400；只读降级时抛 503
   */
  teamworkAiAppendMessage(uid, senderBuiltin, body, opts) {
    const me = Number(uid);
    this._ensureAiMigrated();
    this._assertWritable();
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) throw badRequest('AI 会话不存在');
    const o = opts || {};
    const segment = c.cur_segment ? Number(c.cur_segment) : 1;
    const r = this._bk.insertBuiltinChatMessage(
      me,
      Number(c.id),
      String(body == null ? '' : body),
      nowStamp(),
      senderBuiltin === undefined || senderBuiltin === null ? null : String(senderBuiltin),
      o.kind == null ? null : String(o.kind),
      o.meta == null ? null : String(o.meta),
      o.image == null ? null : String(o.image),
      segment,
    );
    return { id: Number(r.id) };
  },

  /**
   * 功能：读 AI 助手会话里**一条消息的图片**（显示路由专用）。
   * @param {number} uid - 账号 id
   * @param {number} id - 消息 id
   * @returns {?string} 整串 data URL；没有会话 / 不是自己的 / 没有图 ⇒ null
   */
  teamworkAiMessageImage(uid, id) {
    this._ensureAiMigrated();
    const me = Number(uid);
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) return null;
    return this._bk.getBuiltinChatMessageImage(me, Number(c.id), Number(id));
  },

  /**
   * 功能：读 AI 助手会话里的**一条消息**（确认卡状态流转用）。
   * @param {number} uid - 账号 id
   * @param {number} id - 消息 id
   * @returns {?Object} 消息行（形状同 `teamworkAiMessages` 的一项）；取不到为 null
   */
  teamworkAiGetMessage(uid, id) {
    this._ensureAiMigrated();
    const me = Number(uid);
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) return null;
    const row = this._bk.getBuiltinChatMessage(me, Number(c.id), Number(id));
    if (!row) return null;
    return {
      id: Number(row.id),
      role: row.sender_builtin === BUILTIN_AI ? 'assistant' : 'user',
      content: row.body == null ? '' : String(row.body),
      segment: row.segment == null ? 1 : Number(row.segment),
      kind: row.kind == null ? null : String(row.kind),
      meta: row.meta == null ? null : String(row.meta),
      has_image: Number(row.has_image) === 1,
      created_at: row.created_at,
    };
  },

  /**
   * 功能：改 AI 助手会话里一条消息的 `meta`（确认卡状态写回），返回影响行数。
   * @param {number} uid - 账号 id
   * @param {number} id - 消息 id
   * @param {string} meta - 新的快照 JSON 文本
   * @returns {number} 影响行数
   */
  teamworkAiSetMessageMeta(uid, id, meta) {
    this._ensureAiMigrated();
    const me = Number(uid);
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) return 0;
    return this._bk.setBuiltinChatMessageMeta(me, Number(c.id), Number(id), String(meta));
  },

  /**
   * 功能：**开启新对话** —— 返回新段号（幂等：当前段为空就不 +1），并把新段号落盘在会话行上。
   *
   * 说明：⚠️ 段号必须落盘（`teamwork_conversations.cur_segment`）—— 用户按完按钮、还没发第一条
   *      消息时，新段一条消息都没有，只看消息表会退回旧段。
   *      ⚠️ **不删任何消息**：老段的历史一条不动，只是不再进上下文。
   * @param {number} uid - 账号 id
   * @returns {{segment: number}} 新段号
   * @throws {Error} 只读降级时抛 503
   */
  teamworkAiNewSegment(uid) {
    const me = Number(uid);
    this._ensureAiMigrated();
    this._assertWritable();
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) return { segment: 1 };
    const cur = c.cur_segment ? Number(c.cur_segment) : 1;
    if (this._bk.countBuiltinChatMessagesInSegment(me, Number(c.id), cur) === 0) return { segment: cur };
    const next = cur + 1;
    this._bk.setBuiltinChatSegment(Number(c.id), next);
    return { segment: next };
  },

  /**
   * 功能：取 AI 助手会话**当前段**的上下文原料（id 降序）＋ 当前段号 ＋ 该段总条数。
   *
   * 说明：⭐ 只做「取数」—— 条数 / 字符双上限的裁剪、确认卡降级成一句话，都是 ai 侧
   *      `aiContextWindow()` 的事（那是 AI 的业务规则，不属于对话模块）。
   * @param {number} uid - 账号 id
   * @param {number} limit - 条数上限（调用方传 `maxTurns + 1`）
   * @returns {{segment: number, rows: Array.<Object>, total: number}} 上下文原料
   */
  teamworkAiContext(uid, limit) {
    this._ensureAiMigrated();
    const me = Number(uid);
    const c = this._bk.findBuiltinConversation(me, BUILTIN_AI);
    if (!c) return { segment: 1, rows: [], total: 0 };
    const segment = c.cur_segment ? Number(c.cur_segment) : 1;
    const rows = this._bk.listBuiltinChatContext(me, Number(c.id), segment, limit).map((m) => ({
      id: Number(m.id),
      role: m.sender_builtin === BUILTIN_AI ? 'assistant' : 'user',
      content: m.body == null ? '' : String(m.body),
      segment: m.segment == null ? 1 : Number(m.segment),
      kind: m.kind == null ? null : String(m.kind),
      meta: m.meta == null ? null : String(m.meta),
      created_at: m.created_at,
    }));
    const total = this._bk.countBuiltinChatMessagesInSegment(me, Number(c.id), segment);
    return { segment, rows, total };
  },

  /**
   * 功能：读本账号的提醒偏好 —— **缺省值在这里合并**（数据库里没有行时也给一份可用的）。
   *
   * 说明：⭐ 这是「默认值只有一处」的落点（`REMINDER_PREFS_DEFAULT`）：两个后端都不兜默认值，
   *      所以「这台机器还从没改过提醒设置」与「改了、但改成了默认值」对外表现完全一样。
   *
   * @param {number} uid - 账号 id
   * @returns {Object} `{ enabled, course_lead_minutes, task_at, overdue_at, due_lead_minutes }`
   */
  teamworkReminderPrefs(uid) {
    const row = this._bk.getReminderPrefs(Number(uid)) || {};
    const out = {};
    for (const k of REMINDER_PREF_KEYS) {
      const v = row[k];
      out[k] = v === undefined || v === null || v === '' ? REMINDER_PREFS_DEFAULT[k] : v;
    }
    // ⚠️ 数值列从库里回来可能是字符串（老库 / JSON 手改）—— 统一成数字，
    //    否则 `now.time === prefs.task_at` 这种判据会在「'20:00' vs 1200」之间静默比错。
    out.enabled = Number(out.enabled) ? 1 : 0;
    out.course_lead_minutes = Number(out.course_lead_minutes) || 0;
    out.due_lead_minutes = Number(out.due_lead_minutes) || 0;
    // ⭐ 0.6.4：关怀开关与总开关同款归一（0/1）—— 老库补出来的列、手改过的 JSON 都可能是字符串
    out.care_enabled = Number(out.care_enabled) ? 1 : 0;
    out.task_at = String(out.task_at);
    out.overdue_at = String(out.overdue_at);
    // ⭐ 称呼：库里是 NULL / 空串都算「没改过」（两个后端的「没写过」长得不一样：SQLite 是 NULL、
    //    JSON 回退后端里那列**根本不存在**）—— 统一压成空串，别让 `null` 流到界面上变成 "null"。
    out.builtin_name = String(out.builtin_name == null ? '' : out.builtin_name).trim();
    return out;
  },

  /**
   * 功能：改本账号的提醒偏好 —— ⭐ **带哪个键写哪个键**，返回改完之后的完整值。
   *
   * 说明：⚠️ 校验（`HH:MM` 格式、分钟数范围）**不在这一层**，由 `validate.checkReminderPrefs()`
   *      在路由层把关；这里只认 `REMINDER_PREF_KEYS` 里的键 —— 请求体里多出来的键一律丢弃，
   *      ⛔ 绝不让它顺着 `Object.assign` 流到 `updated_at` 甚至别的列上。
   *      ⚠️ 写法是「先读合并、再整份写回」：`upsertReminderPrefs` 收的是**整行**，
   *      于是「默认值」不必在两个后端里各写一份（见 `teamworkReminderPrefs()` 的说明）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} patch - 只含要改的那几个键（已由 `validate.checkReminderPrefs()` 校验）
   * @returns {Object} 写入后的完整偏好
   * @throws {Error} 数据层只读时抛 503（由 HTTP 层收口）
   */
  teamworkSetReminderPrefs(uid, patch) {
    this._assertWritable();
    const me = Number(uid);
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.teamworkReminderPrefs(me);
    for (const k of REMINDER_PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    }
    this._bk.upsertReminderPrefs(me, next, nowStamp());
    return this.teamworkReminderPrefs(me);
  },

  /**
   * 功能：读本账号的**好友设置**（0.7.7） —— **缺省值在这里合并**（库里没有行时也给一份可用的）。
   *
   * 说明：⭐ 与 `teamworkReminderPrefs()` 同一手法：两个后端都不兜默认值 ⇒
   *      「这台机器还从没改过好友设置」与「改成了默认值」对外表现完全一样。
   *
   * @param {number} uid - 账号 id
   * @returns {Object} `{ auto_accept_friend }`
   */
  teamworkFriendPrefs(uid) {
    const row = this._bk.getFriendPrefs(Number(uid)) || {};
    const out = {};
    for (const k of FRIEND_PREF_KEYS) {
      const v = row[k];
      out[k] = v === undefined || v === null || v === '' ? FRIEND_PREFS_DEFAULT[k] : v;
    }
    // ⚠️ 与提醒偏好同款归一：老库 / 手改过的 JSON 里可能是字符串
    out.auto_accept_friend = Number(out.auto_accept_friend) ? 1 : 0;
    return out;
  },

  /**
   * 功能：改本账号的好友设置 —— ⭐ **带哪个键写哪个键**，返回改完之后的完整值。
   *
   * 说明：⚠️ 校验**不在这一层**，由 `validate.checkFriendPrefs()` 在路由层把关；
   *      这里只认 `FRIEND_PREF_KEYS` 里的键 —— 请求体里多出来的键一律丢弃。
   *
   * @param {number} uid - 账号 id
   * @param {Object} patch - 只含要改的那几个键（已由 `validate.checkFriendPrefs()` 校验）
   * @returns {Object} 写入后的完整设置
   * @throws {Error} 数据层只读时抛 503（由 HTTP 层收口）
   */
  teamworkSetFriendPrefs(uid, patch) {
    this._assertWritable();
    const me = Number(uid);
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.teamworkFriendPrefs(me);
    for (const k of FRIEND_PREF_KEYS) {
      // ⚠️ 一律压成 0/1：这一列是 INTEGER，而调用方（含将来的别处）可能给 boolean ——
      //    SQLite 会把 boolean 当成「无法绑定的值」当场抛错（node:sqlite 的口径），
      //    那种错误出现在「保存设置」这种最平常的操作上，代价太大。
      if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = Number(src[k]) ? 1 : 0;
    }
    this._bk.upsertFriendPrefs(me, next, nowStamp());
    return this.teamworkFriendPrefs(me);
  },

  /**
   * 功能：列出本账号的提醒流水（0.6.x）—— 供测试与探针核对「这个时刻到底响过没有」。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 流水行数组（按 id 升序）
   */
  teamworkRemindersFor(uid) {
    return this._bk.listReminders(Number(uid));
  },

  /**
   * 功能：⛔ **幂等记账** —— 往流水里写一行；返回 null 表示「这个时刻已经发过了」。
   *
   * 说明：⭐ ticker **先调它、再发消息**（顺序不能反）：返回 null 就当场跳过。
   *      「服务重启不重发、同一分钟只发一条」由**唯一键**保证，而不是靠「先查后插」
   *      （那中间有一个竞态窗口）。⚠️ 这也是「停机跨过的提醒不补发」那条规矩的落点。
   *
   * @param {number} uid - 收件账号 id
   * @param {string} kind - 类别（`'course'` / `'task_today'` / `'overdue_daily'`）
   * @param {string} refKey - 这件事的稳定标识
   * @param {string} fireAt - **分钟级**触发时刻 `YYYY-MM-DD HH:MM`
   * @param {string} firedAt - 实际发出时刻
   * @param {string} createdAt - 记账时刻
   * @returns {?Object} 新流水行；已存在时为 null
   */
  teamworkRecordReminder(uid, kind, refKey, fireAt, firedAt, createdAt) {
    return this._bk.insertReminder(Number(uid), kind, refKey, fireAt, firedAt, createdAt);
  },

  /**
   * 功能：清掉早于 `before` 的旧提醒流水（90 天），返回删掉的条数。
   * @param {string} before - 早于这个时刻（`created_at` 字典序）的行都删掉
   * @returns {number} 删除条数
   */
  teamworkPurgeReminders(before) {
    if (this.readOnly) return 0;
    return this._bk.purgeReminders(String(before));
  },

  /**
   * 功能：往「提醒助手」会话里**发一条角色消息**（0.6.x）—— 提醒真正落地的唯一出口。
   *
   * 说明：⭐⭐ **复用 `teamworkSendMessage` 的写库路径**（同一个 `insertMessage` 原语）：
   *      会话的 `last_message_id` 推进会做、会话列表的排序会动、多端未读会算 ——
   *      这些一条都不必重写，也就不存在「提醒发了但列表不更新」这种第二套实现。
   *      ⚠️ 与 `teamworkSendMessage` 的三点不同（都是有意的）：
   *      ① 不走**判权**（调用方是后台任务，不是某个会话里的用户动作）；
   *      ② 不走**节流**（它不是用户手速问题，而且同 tick 内本来就已经合并成一条）；
   *      ③ 显式写 `sender_builtin` ⇒ 前端把它画成「助手说的话」而不是「我发的」。
   *      ⚠️ **不推进已读游标**：提醒的意义就是未读红点（定案 6），标成已读等于没提醒。
   *
   *      ⭐ 0.7.7：**可以带一个 `kind`**（四种系统提醒各一个名字）—— 它决定前端画哪一种卡片。
   *      ⚠️⭐ 它**只能来自服务端**：`remind_*` ⛔ 绝不在 `validate.js` 的 `TEAMWORK_KINDS`（客户端可发）
   *      里 —— 加了就等于任何登录用户都能伪造一条「系统提醒」。这里的校验用的正是另一份常量
   *      （`TEAMWORK_BUILTIN_KINDS`），传不在表里的值直接抛错（不许静默降级）。
   *      ⚠️ `meta` 保持 NULL：本项**样式只由 kind 决定**，刻意不新造字段契约。
   *
   * @param {number} uid - 收件账号 id
   * @param {string} body - 消息正文（**纯文本**，已由 ticker 拼好）
   * @param {?string} [kind] - 0.7.7：提醒种类（`remind_course` / `remind_task_today` /
   *      `remind_overdue` / `remind_care`）；普通角色消息传 null
   * @returns {?Object} `{ id, conversationId, createdAt, builtin, kind }`；只读降级时为 null
   * @throws {Error} kind 不在「仅服务端可用」的那份白名单里时抛 400
   */
  teamworkSendBuiltinMessage(uid, body, kind) {
    const me = Number(uid);
    const cid = this.teamworkEnsureBuiltinConversation(me);
    if (!cid || this.readOnly) return null;
    const k = kind === undefined || kind === null || kind === '' ? null : String(kind);
    if (k && !REMIND_KINDS.includes(k)) {
      throw badRequest(`「${k}」不是服务端可以写的消息种类`);
    }
    const createdAt = nowStamp();
    const row = this._bk.insertMessage(me, cid, String(body), createdAt, BUILTIN_REMINDER, k, null);
    return {
      id: Number(row.id),
      conversationId: Number(cid),
      createdAt,
      builtin: BUILTIN_REMINDER,
      kind: k,
    };
  },

  /**
   * 功能：立刻发**一组**测试提醒（`POST /api/teamwork/reminder-test`，0.7.7 起是四种各一条）。
   *
   * 说明：⭐ 四种各发一条，是为了让人**一次**看清四种卡片长什么样（真机验收第 4 条）：
   *      只发一条的话，「颜色一眼能分辨」这件事根本没法验。
   *      ⚠️ **不写流水**（不记幂等键）：它是「我现在想看一条」，不是「这个时刻该发的事」——
   *      写进去反而会污染流水，让「今天 20:00 的任务提醒」被判成已发过。
   *
   * @param {number} uid - 账号 id
   * @returns {{ items: Array.<Object> }} 四条新消息（`{ id, conversationId, createdAt, kind, body }`）
   * @throws {Error} 数据层只读时抛 503；只读降级下建不出会话时抛 400（说人话）
   */
  teamworkReminderTest(uid) {
    this._assertWritable();
    const items = [];
    for (const it of REMINDER_TEST_ITEMS) {
      const r = this.teamworkSendBuiltinMessage(uid, it.body, it.kind);
      if (!r) throw badRequest('当前数据层不可写，建不出「提醒助手」会话，稍后再试');
      items.push({
        id: r.id,
        conversationId: r.conversationId,
        createdAt: r.createdAt,
        kind: r.kind,
        body: it.body,
      });
    }
    return { items };
  },

  // ================= 聊天记录清理与回收站（0.7.7）=================
  /**
   * 功能：清掉「我这一侧」某个会话的一段消息（`POST /api/teamwork/conversations/:id/clear`）。
   *
   * 说明：⭐⭐ **一行消息都不删**（对话是跨账号数据，真删＝删掉对方的记录）——
   *      只是往 `teamwork_cleared` 记一行「我隐藏了哪一段」，读的时候滤掉它（判据在 `backend/` 一处）。
   *      ⚠️⭐ **区间合并**：新区间与既有区间**相交或相邻** ⇒ 合并成一条
   *      （from 取更小 / to 取更大 / `hidden_at` 取较近的 / `msg_count` 按合并后的区间**重算**）。
   *      不合并的话，一次清理会留下几条互相重叠的记录 ⇒「恢复某一次」有不止一种解释，
   *      用户只会把它当成 bug（「恢复了一次、还是看不见」）。
   *      ⚠️ 被合并掉的旧行是**被新行完整覆盖**（新行的区间不小于它）⇒ 删旧行**不等于**取消隐藏，
   *      这正是它与「恢复」那条路径的区别。
   *
   * @param {number} uid - 账号 id
   * @param {number} cid - 会话 id
   * @param {{from?: ?string, to?: ?string}} [range] - 日期区间（`YYYY-MM-DD`，都在**当天**的两端上：
   *      `from` = 当天 00:00:00 起、`to` = 到当天 23:59:59 止；都不给 = 整个会话）
   * @returns {{ ok: true, cleared: number, rangeId: number, from: number, to: number }} 清理结果
   * @throws {Error} 判权失败抛 404；日期格式不对 / 那段里一条消息都没有时抛 400（决策 20：不许静默）
   */
  teamworkClearMessages(uid, cid, range) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const r = range || {};
    const from = normClearDay(r.from, 'from');
    const to = normClearDay(r.to, 'to');
    // ⭐ 用**真实命中的 id 区间**（不是「拿时间戳去比 id」—— 两者会有偏差，见原语的说明）
    const hit = this._bk.msgIdRange(c.id, from ? `${from} 00:00:00` : null, to ? `${to} 23:59:59` : null);
    if (!hit.count) throw badRequest('这个时间段里没有消息');
    const stamp = nowStamp();
    const hiddenAt = stamp;
    const expiresAt = `${addDays(String(hiddenAt).slice(0, 10), CLEAR_KEEP_DAYS)} ${String(hiddenAt).slice(11)}`;
    // 合并：与该会话里**相交或相邻**的既有区间合成一条（相邻 = 中间没有空隙：`r.from - 1 <= max`）
    const near = this._bk
      .listCleared(me)
      .filter((x) => Number(x.conversation_id) === Number(c.id))
      .filter((x) => Number(x.from_message_id) - 1 <= hit.max && Number(x.to_message_id) + 1 >= hit.min);
    const fromId = near.reduce((n, x) => Math.min(n, Number(x.from_message_id)), hit.min);
    const toId = near.reduce((n, x) => Math.max(n, Number(x.to_message_id)), hit.max);
    const hiddenAt2 = near.reduce((s, x) => (String(x.hidden_at) > s ? String(x.hidden_at) : s), hiddenAt);
    for (const x of near) this._bk.deleteCleared(me, x.id);
    const row = this._bk.insertCleared({
      user_id: me,
      conversation_id: Number(c.id),
      from_message_id: fromId,
      to_message_id: toId,
      // ⚠️ 按**合并后**的区间重算（不是把几条区的条数相加 —— 重叠部分会被算两遍）
      msg_count: this._bk.countMessagesBetween(c.id, fromId, toId),
      hidden_at: hiddenAt2,
      expires_at: expiresAt,
      created_at: stamp,
    });
    return { ok: true, cleared: Number(row.msg_count), rangeId: Number(row.id), from: fromId, to: toId };
  },

  /**
   * 功能：列出**回收站**里的清理记录（`GET /api/teamwork/cleared`）—— 只列**还没过期**的那些。
   *
   * 说明：⭐ 「还剩几天可恢复」由**服务端**算好一并给出（`daysLeft`）：
   *      ⛔ 不让前端拿本机时钟自己算（本机时钟不可信，两端还会算得不一样 ——  的同源要求）。
   *      ⚠️ `peerName` 走**既有的显示名口径**（备注优先 → 显示名 → 登录名；内置角色走我起的称呼），
   *      与会话列表那一行的名字是同一套（见 `_teamworkConvTitle()`）。
   *
   * @param {number} uid - 账号 id
   * @returns {{ items: Array.<Object> }} `{ id, conversationId, peerName, msgCount, hiddenAt, expiresAt, daysLeft }`
   */
  teamworkClearedList(uid) {
    const me = Number(uid);
    const now = nowStamp();
    const convById = new Map(this.teamworkListConversations(me).map((c) => [Number(c.id), c]));
    return {
      items: this._bk
        .listCleared(me)
        // ⚠️ 只有**这里**用 `expires_at`：它决定「回收站里还显不显示、还能不能恢复」，
        //    ⛔ 绝不参与可见性判定（可见性在 `backend/` 那一份，见 `schema.js` 的说明）
        .filter((x) => String(x.expires_at) > now)
        .sort((a, b) => String(b.hidden_at).localeCompare(String(a.hidden_at)) || Number(b.id) - Number(a.id))
        .map((x) => {
          const c = convById.get(Number(x.conversation_id));
          return {
            id: Number(x.id),
            conversationId: Number(x.conversation_id),
            peerName: c ? _teamworkConvTitle(c) : '（这个会话现在已经读不到了）',
            msgCount: Number(x.msg_count) || 0,
            hiddenAt: String(x.hidden_at),
            expiresAt: String(x.expires_at),
            // ⭐ 服务端算「还剩几天」（向上取整：还剩不到一天也说 1 天，别说 0 天让人以为已经不能恢复了）
            daysLeft: Math.max(1, Math.ceil(daysBetween(now.slice(0, 10), String(x.expires_at).slice(0, 10)))),
          };
        }),
    };
  },

  /**
   * 功能：**恢复**一段被清掉的消息（`POST /api/teamwork/cleared/:id/restore`）—— 删掉那一行。
   *
   * 说明：⭐⭐ 删行 = 取消隐藏 = 消息回来。它是**唯一**合法地删 `teamwork_cleared` 行的路径
   *      （⛔ 过期清理不删行 —— 那是让消息复活）。
   *      ⚠️ 越权 / 不存在一律 404（响应体与「不存在」逐字一致）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 清理记录 id
   * @returns {{ id: number }} 结果
   * @throws {Error} 不是我的记录 / 记录不存在时抛 404
   */
  teamworkRestoreCleared(uid, id) {
    this._assertWritable();
    const me = Number(uid);
    if (!this._bk.deleteCleared(me, Number(id))) throw notFoundErr('清理记录');
    return { id: Number(id) };
  },

  /**
   * 功能：删账号第一步 —— **会话先过户**给还留在会话里的那个人（⭐ 0.8.12：从核心的 `deleteUser` 搬回本模块）。
   *
   * 说明：⭐ 本模块是项目里唯一的**跨账号**数据，而「删账号要清空哪些表」是按 `user_id` 列工作的
   *      （`USER_SCOPED_TABLES`）。直接照章办事的后果是：由我创建、对方还在用的那个会话会被删掉 ——
   *      对方面对的是「**整个会话没了**」，而方案承诺的只是「历史会话缺一段」。
   *      所以先把「还有别人在」的会话过户给留下的人，**再**让通用清单去删。
   *
   * ⚠️⭐ **它由核心 `deleteUser` 通过可选钩子调用**（`typeof this.teamworkTransferOnDelete === 'function'`，
   *      先例 `_seedModuleData()`）—— 为的是：① 与「删账号要清哪些表」这条核心机制**解耦**；
   *      ② 模块被整目录删掉时**静静地不做**（那正是本次搬家顺带修掉的那个缺陷：以前核心无条件调用，
   *      `modules/teamwork/` 一删，「删除成员」就 500 `no such table: teamwork_conversations`）。
   *      ⚠️ 顺序由**核心**保证：本方法必须在通用清空**之前**，`teamworkPurgeOnDelete` 在**之后**。
   *
   * @param {number} uid - 即将注销的账号 id
   * @returns {void}
   */
  teamworkTransferOnDelete(uid) {
    return this._bk.teamworkTransferOnDelete(Number(uid));
  },

  /**
   * 功能：删账号第二步 —— **好友补刀 ＋ 收拾悬空引用**（⭐ 0.8.12：从核心的 `deleteUser` 搬回本模块）。
   *
   * 说明：⚠️ 两步都**不能省**，且顺序与 SQLite / JSON 两侧的实现逐字对齐：
   *      · **好友补刀**：好友关系存两行，通用清空按 `user_id` 只清掉「他→我」那一行，
   *        「我→他」那一行会留在库里 ⇒ 别人的好友列表里还挂着一个已不存在的账号（点开会话还 404）。
   *        这一条不在 `userScoped` 的语义里，是本模块特有的。
   *      · **清孤儿**：成员行 / 消息指向已不存在的会话时一并清掉，最后清掉「一个成员都没有」的会话
   *        （否则库里会永久残留一批谁都读不到、却跟着备份搬来搬去的行）。
   *
   * @param {number} uid - 即将注销的账号 id
   * @returns {void}
   */
  teamworkPurgeOnDelete(uid) {
    return this._bk.teamworkPurgeOnDelete(Number(uid));
  },
  },
  // ⭐⭐ 0.8.12：协作那一层（从 `modules/teamwork/lib/collab.js` 整份搬来）—— 同名方法两处都为 0。
  require('./lib/collab.js'),
);

/**
 * 功能：把一个「清理日期」归一成 `YYYY-MM-DD`（0.7.7）。
 *
 * 说明：⚠️ 空值（没带 / 空串）返回 null（= 这一端不限）；**带了就必须是一个真实存在的日期**，
 *      否则 400 —— 静默忽略的表现是「清了整个会话」，那是把用户的话听成了另一件事。
 *
 * @param {*} v - 请求里的日期
 * @param {string} label - 字段名（进错误文案）
 * @returns {?string} `YYYY-MM-DD`；没带时为 null
 * @throws {Error} 格式不对时抛 400
 */
function normClearDay(v, label) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(`${label} 必须是日期（YYYY-MM-DD）`);
  return s;
}

/**
 * 功能：两个 `YYYY-MM-DD` 之间差几天（`0.7.7`）—— 只给「回收站还剩几天」这一处用。
 *
 * 说明：⚠️ 用 `dateOrdinal()`（序日差）而不是 `new Date()` 相减 —— 与 ticker 里「逾期几天」
 *      同一条规矩：时区 / 夏令时会让后者在某些日子差一天，而「还剩 1 天」说错比不说更伤人。
 *
 * @param {string} from - 起始日期
 * @param {string} to - 结束日期
 * @returns {number} 天数差（可为负；读不出来时返回 0）
 */
function daysBetween(from, to) {
  const a = dateOrdinal(String(from || ''));
  const b = dateOrdinal(String(to || ''));
  return a === null || b === null ? 0 : b - a;
}

/**
 * 功能：一个会话在**界面上**叫什么名字（0.7.7）—— 给回收站那一行用。
 *
 * 说明：⭐ 口径必须与两端 `teamworkRowName()` **逐字一致**（内置角色 → 我起的称呼；备注 → 显示名 → 登录名），
 *      否则回收站里写着「张工」、左栏里写着「张三」，用户不知道是不是同一个会话。
 *      ⚠️ 它只在服务端用（前端直接显示 `peerName`，不再自己拼一遍）。
 *
 * @param {Object} c - `teamworkListConversations()` 给的一行会话
 * @returns {string} 显示名
 */
function _teamworkConvTitle(c) {
  if (c.builtin_key) return String(c.builtin_name || BUILTIN_LABELS[c.builtin_key] || '助手');
  if (c.peer_gone) return '（对方账号已注销）';
  if (c.peer_remark) return String(c.peer_remark);
  const u = c.peer_user || {};
  return u.display_name || u.username || '（账号已不可见）';
}
