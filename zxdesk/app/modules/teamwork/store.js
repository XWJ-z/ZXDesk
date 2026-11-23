'use strict';
/**
 * modules/teamwork/store.js —— 对话业务方法
 * 功能：好友（申请 / 同意 / 拒绝 / 删除 / 拉黑 / **备注**）与一对一消息（开会话 / 列表 / 分页 / 增量 /
 * 发送 / 标记已读 / 未读合计）的全部业务规则都落在这里。路由层只做「解析路径 + 读请求体」，
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */
const { addDays, nowStamp, notFoundErr, badRequest } = require('../../core/store/helpers.js');
// 聊天图片的消息种类（`kind='image'`）—— 落盘口径与它同住 `lib/chat-image.js`，
// 别在方法体里写字符串字面量（前端那份同名常量由测试对账）。
const { IMAGE_KIND } = require('./lib/chat-image.js');
// `dateOrdinal()` 用来算「回收站还剩几天」（与 ticker 里「逾期几天」同一条规矩：
// 用序日差，不用 `new Date()` 相减 —— 那个会在某些日子差一天）。它只依赖日期字符串，不成环。
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
 *
 * 说明：⭐ AI 的聊天会话从「ai 模块自己的两张表」并进对话两张表（`builtin_key = 'ai'`），
 */
const BUILTIN_AI = 'ai';

/**
 * 内置角色标识 → 界面上显示的名字。
 *
 */
const BUILTIN_LABELS = { [BUILTIN_REMINDER]: '提醒助手', [BUILTIN_AI]: 'AI 助手' };

/**
 * 提醒偏好的**缺省值** —— ⭐ 全项目**唯一一处**。
 *
 */
const REMINDER_PREFS_DEFAULT = {
  enabled: 1,
  course_lead_minutes: 20,
  task_at: '20:00',
  overdue_at: '07:00',
  due_lead_minutes: 0,
  // ：当天课上完了发一句问候。默认**开**。
  // 它与那四个时刻不是一回事 —— 那几个回答「什么时候提醒我做事」，这条是「课都上完了，说句话」。
  care_enabled: 1,
  // 我给内置角色起的**称呼**。空串 = **没改过**，显示时回落 `BUILTIN_LABELS`。
  // 它就在这张「对话自己的设置」表里：一个账号一份、与提醒设置同生同死（同一个接口写）。
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
 *
 * 说明：⚠️ 别让路由层再拼一遍：那样「测试提醒的内容」就有了两份，改一处忘一处是迟早的事。
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
 *
 * 说明：⭐ 只定义在**服务端这一处**：两端界面上那句提示（「这里只发提醒；想聊天请到「AI 助手」」）
 */
const BUILTIN_AUTO_REPLY = '请与 AI 助手对话';

/**
 *
 * 说明：⚠️⭐ 它**只决定回收站里还显不显示、还能不能恢复** —— ⛔ 绝不参与可见性判定
 */
const CLEAR_KEEP_DAYS = 30;


/**
 *
 * 说明：⚠️ 与提醒偏好同一手法：两个后端都**不兜默认值**（`getFriendPrefs` 取不到就回 null），
 */
const FRIEND_PREFS_DEFAULT = { auto_accept_friend: 0 };

/** 好友设置里**允许被写**的键 —— 与 `upsertFriendPrefs` 的列一一对应（多一个都没有去处） */
const FRIEND_PREF_KEYS = ['auto_accept_friend'];

/** 消息发送节流：**多久之内最多几条**。⚠️ 这是「防打垮服务」而不是「防刷屏」 */
const SEND_MAX = 20;
const SEND_WINDOW_MS = 10000;

/** 好友申请节流（防骚扰）：一分钟最多 10 次 */
const FRIEND_REQ_MAX = 10;
const FRIEND_REQ_WINDOW_MS = 60000;

/**
 * 功能：**进程内**的滑动窗口限流 —— `Map<key, 时间戳数组>`。
 *
 * 说明：⚠️ 刻意**只用进程内内存**、不落库：这类节流是「防打垮服务」的护栏，
 * 重启后重新计数没有任何问题，而落库会平白多出一张会无限增长的表。
 * 与登录失败节流（`auth.js`）同一个性质。
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
 * 而不是顺手把 `sanitizeUser()` 的结果整个递出去（那个结果里有 `hide_*` 显示偏好、
 * 有 `vault_lock_minutes`、有 `updated_at` 这类与别人无关的东西 ——
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
 *
 * 说明：⚠️⭐ 它们**绝不在 `core/validate.js` 的 `TEAMWORK_KINDS`（客户端可发）里** ——
 */
const REMIND_KINDS = ['remind_course', 'remind_task_today', 'remind_overdue', 'remind_care', 'remind_trip'];

/**
 *
 * 说明：⭐ **解析只在这一处**（REST 与 SSE 两条路拿到的都是对象）：前端不必自己 `JSON.parse` ——
 */
function parseCardMeta(v) {
  if (v === undefined || v === null || v === '') return null;
  // 已经是对象就直接放行：JSON 后端存的是原样值，测试夹具也常常直接给对象
  if (typeof v === 'object') return Array.isArray(v) ? null : v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (_e) {
    return null;
  }
}

// `lib/collab.js`（协作那一层的判权与业务方法）从
// `modules/tasks/` **整份搬进本模块**，在这里与本文件的「对话」方法合成一张方法表
// （`Object.assign`；两份**决不允许有同名方法** —— 装配期 `assertNoMethodClash()` 机械复查）。
module.exports = Object.assign(
  {
  // ================= 好友 =================
  /**
   * 功能：好友总览 —— 我的好友 / 待我处理 / 我发出的 / 已拉黑 / 未读合计（`GET /api/teamwork/friends`）。
   *
   * 说明：⭐ 一次请求把「好友页 + 会话页」要画的东西取齐：
   * `conversations` 顺带给出去（含每个会话的未读数与最后一条），前端打开对话页不必再打一次接口。
   */
  teamworkFriendsOverview(uid) {
    const u = Number(uid);
    // 0.6.x：进对话页是内置角色会话的**懒创建时机之一**（另一个是 ticker 第一次要发提醒时）——
    // 比启动时给所有账号批量建会话要克制得多。
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
   * 幂等：已经是好友、或已经有 pending 申请，都直接返回成功（连点两次不会造出两份关系）。
   * **不能加自己**；⚠️ **任何一方拉黑了就拒绝**（拉黑的意义就是「别再发来」）。
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
    // 幂等的两种返回**不带 `notified`**：那一头什么都没变，推给对方就是一次无谓的打扰
    if (mine && mine.status === 'accepted') return { friendId: fid, status: 'accepted', notified: false };
    if (mine && mine.status === 'pending') return { friendId: fid, status: 'pending', notified: false };

    const stamp = nowStamp();
    // **自动通过好友申请**（判据**只在这一处**，见方法说明 ①）。
    // 读的是**被申请方**（`fid`）的设置 —— 那是「谁在决定要不要别人直接进来」。
    const auto = Number(this.teamworkFriendPrefs(fid).auto_accept_friend) ? 1 : 0;
    this._bk.setFriendshipPair(me, fid, auto ? 'accepted' : 'pending', me, stamp);
    return { friendId: fid, status: auto ? 'accepted' : 'pending', notified: true };
  },

  /**
   * 功能：同意好友申请（`POST /api/teamwork/friends/:id/accept`）—— 把两行一起改成 `accepted`。
   *
   * 说明：⚠️ 只有**被申请方**能同意：`requested_by !== 我` 才行。
   * 自己发出的申请自己点同意，等于绕开「必须对方同意」这条设计（也就等于单向关注）。
   *
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
   * 那是一种**已读回执式的社交压力**，而一期只要「申请没了」这个结果。
   * 对方看到的只是「申请还在等」（其实已作废），这是本应用刻意选择的方向。
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
   * 但实现上**一条消息都不删**（见文件头 ③）：只是这道闸门关上了，
   * 重新加回好友，历史消息原样回来。⚠️ 这也意味着「删好友」不是「清空聊天记录」，
   *
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
   * 这样对方发来的申请会被明确拒绝（「已被拉黑」），而已有的会话两边都读不到。
   * **取消拉黑 = 回到陌生人**（两行删掉、需要重新加好友），而不是「恢复成好友」：
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
   *
   * 说明：⭐ **备注是单方面的** —— 它写在我这一行（`user_id = 我`），对方那一行一个字节都不动，
   */
  teamworkSetFriendRemark(uid, friendId, remark) {
    this._assertWritable();
    const me = Number(uid);
    const fid = Number(friendId);
    const mine = this._bk.getFriendship(me, fid);
    // 只有 accepted 才给改：给「还没同意的申请人」起备注没有意义，
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
   * 「先判权、后取数」）。⚠️ 抛的是 404 而不是 403：403 等于告诉对方
   * 「这条记录存在，只是不归你」——那本身就是一个探测通道。
   */
  teamworkConversationOr404(uid, cid) {
    const me = Number(uid);
    const c = this._bk.getConversation(Number(cid));
    if (!c) throw notFoundErr('会话');
    if (!this._bk.isMember(me, c.id)) throw notFoundErr('会话');
    // 0.6.x：**内置角色会话（提醒助手）到此为止** —— 它没有「对方」这个人，
    // 所以下面那道「还得是好友」的闸门对它不适用（它压根不在 `teamwork_friendships` 里）。
    // 判权仍然**只看 `teamwork_members`**：不是成员照样在上面就 404 了。
    if (c.builtin_key) return c;
    // 一对一的额外闸门：不再互为好友 ⇒ 这个会话读不到（数据仍在，重新加回好友即恢复）。
    // **例外：对方账号已注销**（会话里只剩我一个人）—— 那时它不是「被删了好友」，
    // 而是「那个人不在了」。这种会话**仍然读得到**（只读）：方案对删账号的承诺是
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
   * 未读数与排序都由 `listConversations` 这条原语算好（两个后端逐字一致），
   * 这里只负责把「对方是谁」补上，并**滤掉已不是好友的会话**（它们不可读，留在列表里只会点出 404）。
   */
  teamworkListConversations(uid) {
    const me = Number(uid);
    // 进对话页这一拍顺手跑一次**存量 AI 会话搬迁**（幂等、体检不过整份放弃）——
    this._ensureAiMigrated();
    const usersById = new Map(this.listUsers().map((x) => [Number(x.id), x]));
    /**
     * 功能：会话列表里「最后一条是不是**我**发的」—— 用于给预览加「我：」前缀。
     * 说明：.x：内置角色（提醒助手）发的消息 `user_id` 也是我，所以**必须再排除它** ——
     * 少了后半句，提醒预览会写成「我：【上课提醒】…」（明明不是我说的）。
     */
    const lastMine = (c) =>
      c.last_sender_id === null || c.last_sender_id === undefined
        ? null
        : Number(c.last_sender_id) === me && !c.last_sender_builtin;
    const out = [];
    // 0.6.x：内置角色在列表里显示的名字 —— **我给它起的称呼优先**，没起过才回落内置标签。
    // 读一次就够（循环外）：这是同一账号的一份配置，不是每个会话各一份。
    const myBuiltinName = this.teamworkReminderPrefs(me).builtin_name;
    for (const c of this._bk.listConversations(me)) {
      // **AI 助手会话（`builtin_key = 'ai'`）刻意不进这张列表。**
      // 它的会话行与消息**已经住在本模块的两张表里**（2g 的搬迁，AI 只经 `teamworkAi*`
      // 这一组公开方法读写），但它的**界面**这一半还由 ai 模块自己的插槽视图提供
      if (c.builtin_key === BUILTIN_AI) continue;
      // 0.6.x：内置角色会话（提醒助手）单独一支 —— 它没有 `peer_user`、不进好友关系，
      // 所以下面那一整套「对方是谁 / 还是不是好友」的判据对它全都不适用。
      if (c.builtin_key) {
        // 那个「我起的称呼」只属于**提醒助手**（住在提醒偏好里）——
        // AI 助手直接用它自己的固定名，⛔ 别把提醒助手的称呼串到 AI 头上。
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
      // 「对方的历史会话缺一段」会变成「会话凭空消失」，而用户完全不知道发生了什么。
      const peerGone = peerId === null;
      let peerRemark = null;
      if (!peerGone) {
        const f = this._bk.getFriendship(me, peerId);
        if (!f || f.status !== 'accepted') continue;
        // 会话列表要显示「我给他起的名字」，所以这里把我这一行的备注一起带出去
        // （`f` 是**我这一侧**的关系行，取的天然是单方面的备注，不会拿到对方的）。
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
    // 内置角色会话排最前（其余保持「最后一条消息倒序」）—— 理由见上面循环里那一支的说明。
    // 用 `filter` 两趟而不是 `sort`：排序键（`last_message_id`）在两类会话之间没有可比性，
    return out.filter((c) => c.builtin_key).concat(out.filter((c) => !c.builtin_key));
  },

  /**
   * 功能：开一个一对一对话（`POST /api/teamwork/conversations`）—— **幂等**：已有就返回原来那个。
   *
   * 说明：⭐ 幂等是必须的：「点好友名字进对话」这个动作可能被点两次、可能两个设备同时点，
   * 不幂等就会造出两个同人的空会话，而且用户没有任何办法删掉多余的那个。
   * 两个成员行与会话行**一起写**：中间失败留下的是「谁都进不去的空会话」。
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
   * `before` 取更早的历史（向上翻），`after` 取更新的增量（断线补齐 / 轮询降级）。
   *
   * 说明：⭐ 返回的 `items` **一律按 id 升序**（= 展示顺序，旧的在上）：
   * 存储层历史上是倒序取「最近 N 条」，这里翻回来，前端不必关心方向。
   */
  teamworkMessages(uid, cid, opts) {
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const o = opts || {};
    const limit = Number(o.limit) > 0 ? Math.min(Number(o.limit), 200) : 50;
    const after = Number(o.after) > 0 ? Number(o.after) : null;
    const before = Number(o.before) > 0 ? Number(o.before) : null;
    // `me` 传下去 —— 「我清掉的那几段」要在存储层就滤掉（判据在 `backend/` 里一处）
    const rows = this._bk.listMessages(c.id, before, after, limit, me);
    const items = after !== null ? rows.slice() : rows.slice().reverse();
    // ：卡片消息的两列在这里**统一归一**（`kind` 补成 null、`meta` 解析成对象）——
    // 前端两条路（REST / SSE）拿到同一种形状，两端渲染代码不必各判一次「这列在不在」。
    // 老库补出来的列就是 NULL，这一段对普通消息是**恒等变换**（改动前的老数据一字不变）。
    for (const m of items) {
      m.kind = m.kind || null;
      m.meta = parseCardMeta(m.meta);
    }
    // 给这一页消息补上「我从它建过哪些任务」——
    // 界面据此在气泡下面画一枚可点的「已添加到任务 · 任务标题」。
    // 关联存在**任务那一侧**（`project_tasks` / `daily_tasks` 的 `from_message_id`），
    this._attachMessageTasks(me, items);
    return { items, hasMore: after === null && rows.length === limit };
  },

  /**
   * 功能：就地把「我从这些消息建过的任务」挂到消息行上（`tasks` 字段，按消息 id 分组）。
   *
   * 说明：⭐ 查不到的消息行**也挂一个空数组**（而不是不挂）：前端两种形状都要判，
   * 统一成「一定有个数组」少一处 `undefined` 分支。
   * 每项带 `status`（`todo` / `done`）—— 界面在这枚标记上要写清做完没有。
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
      // 带上 `status` —— 「添加到任务的消息下应该显示这个任务的完成状态，
      // 没有完成用红色、完成是灰色并用横线划掉」。它由任务那一侧的 `tasksFromMessages` 一起给出。
      byMsg
        .get(k)
        .push({ scope: row.scope, id: Number(row.task_id), title: row.title, status: row.status === 'done' ? 'done' : 'todo' });
    }
    for (const m of items) m.tasks = byMsg.get(Number(m.id)) || [];
  },

  /**
   * 功能：发一条消息（`POST /api/teamwork/conversations/:id/messages`）。
   *
   * 两层都过了才写库；写入本身在一个事务里（消息 + 会话的 `last_message_id`）。
   * 正文的「非空 + 长度上限」由 `validate.checkTeamworkMessage` 在这一层之前把关，
   * 这里再兜一次「去空白后不能为空」——路由层不是唯一入口（将来还会有别的调用方）。
   */
  teamworkSendMessage(uid, cid, body, opts) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const text = String(body == null ? '' : body).trim();
    if (!text) throw badRequest('消息不能为空');
    // 0.6.x：内置角色会话**可以发**（那是「我」和助手之间的一条线，写进去只落在我自己库里）。
    // 它没有「对方」，所以下面那道「对方已注销」的判断对它不适用。
    // 对方账号已注销 ⇒ 这个会话是**只读**的：还能翻历史，但发出去也没人收得到。
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
    // 内置角色会话 ⇒ 立刻回一句（判据**只在这一处**：`c.builtin_key` 有值）。
    // 路由层负责把它推出去（本层不碰 SSE —— `notify.js` 那条链有加载时序的讲究）。
    // ⛔ **只对提醒助手**自动回复 —— AI 的会话（`builtin_key = 'ai'`）
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
        // 这条回复**不画卡片**（它就是一句普通文本）⇒ kind 恒为 null
        kind: null,
      };
    }
    // 返回值里的 `meta` 是**对象**（不是库里那个 JSON 字符串）：路由层拿它拼 SSE 帧，
    // 前端两条路（REST / SSE）必须拿到同一种形状。
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
   *
   * 说明：⭐⭐ 字节已经由路由落好盘（`readBodyToFile()` → 算 sha → 内容寻址改名），本方法只做三件事：
   */
  teamworkSendImage(uid, cid, info) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const i = info || {};
    if (!i.sha || !i.ext || !(Number(i.size) > 0)) throw badRequest('图片没存好，请再试一次');
    // 与文本消息同一档：对方账号已注销 ⇒ 这条会话只读（理由见 `teamworkSendMessage()`）。
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
   * 多端同时在线时不会出现「红点去掉了又回来」。
   * 而且**先夹到「这个会话现有的最大消息 id」**：游标是**全局自增 id**，
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
   * 一会儿又要验证正常发送，节流表会互相干扰。生产代码里没有任何调用点。
   *
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
   * 而绝大多数账号从不进对话页 —— 启动时给所有人批量建会话，等于给一张表先灌一堆
   */
  teamworkEnsureBuiltinConversation(uid) {
    const me = Number(uid);
    const existed = this._bk.findBuiltinConversation(me, BUILTIN_REMINDER);
    if (existed) return Number(existed.id);
    if (this.readOnly) return null;
    const stamp = nowStamp();
    const conv = this._bk.insert('teamwork_conversations', {
      user_id: me,
      // `kind` 恒为 `'direct'`：DDL 上是 `CHECK (kind IN ('direct'))`，改它要重建表
      // ⇒ 推 SCHEMA_VERSION—— 为一个枚举值付一次结构迁移不划算。
      // 「这是不是内置角色」由 `builtin_key` 表达。
      kind: 'direct',
      // `title` 恒为 null：内置角色的显示名**不走这一列** —— 它住在
      // `teamwork_reminder_prefs.builtin_name`（那是「我这一份对话设置」的一项，
      // 与提醒时刻同一个接口写、同生同死）。`title` 留给将来真正的群聊。
      title: null,
      builtin_key: BUILTIN_REMINDER,
      last_message_id: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    this._bk.insertMember(me, conv.id, stamp);
    return Number(conv.id);
  },

  // AI 的聊天落库并进对话两张表之后，AI 模块**只提供「回复怎么生成」**，一切读写都走下面这组

  /**
   * 功能：跑一次（幂等的）**存量 AI 会话搬迁** —— 懒迁移，挂在每个碰 AI 会话的入口上。
   *
   * 说明：⭐⭐ 为什么是懒迁移而不是启动钩子：核心层对模块没有通用的启动钩子（只有课表那个
   * 第一次碰 AI 会话」这一拍（与协作那两处存量迁移同一手法）。
   * 三条口径：
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
   * 搬迁的幂等判据（新表里已有 `builtin_key='ai'` 的会话）提前点亮，老会话就永远搬不过来了。
   * 只读降级**不建**（抛 503 由调用方收口，与提醒助手不同 —— AI 的创建是显式写路径）。
   * @param {number} uid - 账号 id
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
   * 不造机器人账号、`user_id` 就是收件人自己）。⚠️ `meta` 这一层**原样是文本** ——
   * 解析成对象是 ai 侧 `decorateMessage()` 的事（提议卡的载荷格式属于 ai 模块）。
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
   * `senderBuiltin` 只应是 `'ai'`（助手说的）或 null（用户说的）。
   * @param {number} uid - 账号 id
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
   * 消息时，新段一条消息都没有，只看消息表会退回旧段。
   * **不删任何消息**：老段的历史一条不动，只是不再进上下文。
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
   * `aiContextWindow()` 的事（那是 AI 的业务规则，不属于对话模块）。
   * @param {number} uid - 账号 id
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
   * 所以「这台机器还从没改过提醒设置」与「改了、但改成了默认值」对外表现完全一样。
   *
   */
  teamworkReminderPrefs(uid) {
    const row = this._bk.getReminderPrefs(Number(uid)) || {};
    const out = {};
    for (const k of REMINDER_PREF_KEYS) {
      const v = row[k];
      out[k] = v === undefined || v === null || v === '' ? REMINDER_PREFS_DEFAULT[k] : v;
    }
    // 数值列从库里回来可能是字符串（老库 / JSON 手改）—— 统一成数字，
    out.enabled = Number(out.enabled) ? 1 : 0;
    out.course_lead_minutes = Number(out.course_lead_minutes) || 0;
    out.due_lead_minutes = Number(out.due_lead_minutes) || 0;
    // 关怀开关与总开关同款归一（0/1）—— 老库补出来的列、手改过的 JSON 都可能是字符串
    out.care_enabled = Number(out.care_enabled) ? 1 : 0;
    out.task_at = String(out.task_at);
    out.overdue_at = String(out.overdue_at);
    // 称呼：库里是 NULL / 空串都算「没改过」（两个后端的「没写过」长得不一样：SQLite 是 NULL、
    // JSON 回退后端里那列**根本不存在**）—— 统一压成空串，别让 `null` 流到界面上变成 "null"。
    out.builtin_name = String(out.builtin_name == null ? '' : out.builtin_name).trim();
    return out;
  },

  /**
   * 功能：改本账号的提醒偏好 —— ⭐ **带哪个键写哪个键**，返回改完之后的完整值。
   *
   * 说明：⚠️ 校验（`HH:MM` 格式、分钟数范围）**不在这一层**，由 `validate.checkReminderPrefs()`
   * 在路由层把关；这里只认 `REMINDER_PREF_KEYS` 里的键 —— 请求体里多出来的键一律丢弃，
   * 绝不让它顺着 `Object.assign` 流到 `updated_at` 甚至别的列上。
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
   *
   * 说明：⭐ 与 `teamworkReminderPrefs()` 同一手法：两个后端都不兜默认值 ⇒
   */
  teamworkFriendPrefs(uid) {
    const row = this._bk.getFriendPrefs(Number(uid)) || {};
    const out = {};
    for (const k of FRIEND_PREF_KEYS) {
      const v = row[k];
      out[k] = v === undefined || v === null || v === '' ? FRIEND_PREFS_DEFAULT[k] : v;
    }
    // 与提醒偏好同款归一：老库 / 手改过的 JSON 里可能是字符串
    out.auto_accept_friend = Number(out.auto_accept_friend) ? 1 : 0;
    return out;
  },

  /**
   * 功能：改本账号的好友设置 —— ⭐ **带哪个键写哪个键**，返回改完之后的完整值。
   *
   * 说明：⚠️ 校验**不在这一层**，由 `validate.checkFriendPrefs()` 在路由层把关；
   * 这里只认 `FRIEND_PREF_KEYS` 里的键 —— 请求体里多出来的键一律丢弃。
   *
   */
  teamworkSetFriendPrefs(uid, patch) {
    this._assertWritable();
    const me = Number(uid);
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = this.teamworkFriendPrefs(me);
    for (const k of FRIEND_PREF_KEYS) {
      // 一律压成 0/1：这一列是 INTEGER，而调用方（含将来的别处）可能给 boolean ——
      // SQLite 会把 boolean 当成「无法绑定的值」当场抛错（node:sqlite 的口径），
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
   * 「服务重启不重发、同一分钟只发一条」由**唯一键**保证，而不是靠「先查后插」
   * （那中间有一个竞态窗口）。⚠️ 这也是「停机跨过的提醒不补发」那条规矩的落点。
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
   * 会话的 `last_message_id` 推进会做、会话列表的排序会动、多端未读会算 ——
   * 这些一条都不必重写，也就不存在「提醒发了但列表不更新」这种第二套实现。
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
   *
   * 说明：⭐ 四种各发一条，是为了让人**一次**看清四种卡片长什么样：
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

  /**
   * 功能：清掉「我这一侧」某个会话的一段消息（`POST /api/teamwork/conversations/:id/clear`）。
   *
   * 说明：⭐⭐ **一行消息都不删**（对话是跨账号数据，真删＝删掉对方的记录）——
   * 只是往 `teamwork_cleared` 记一行「我隐藏了哪一段」，读的时候滤掉它（判据在 `backend/` 一处）。
   * **区间合并**：新区间与既有区间**相交或相邻** ⇒ 合并成一条
   */
  teamworkClearMessages(uid, cid, range) {
    this._assertWritable();
    const me = Number(uid);
    const c = this.teamworkConversationOr404(me, cid);
    const r = range || {};
    const from = normClearDay(r.from, 'from');
    const to = normClearDay(r.to, 'to');
    // 用**真实命中的 id 区间**（不是「拿时间戳去比 id」—— 两者会有偏差，见原语的说明）
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
      // 按**合并后**的区间重算（不是把几条区的条数相加 —— 重叠部分会被算两遍）
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
   * 不让前端拿本机时钟自己算（本机时钟不可信，两端还会算得不一样 ——  的同源要求）。
   * `peerName` 走**既有的显示名口径**（备注优先 → 显示名 → 登录名；内置角色走我起的称呼），
   */
  teamworkClearedList(uid) {
    const me = Number(uid);
    const now = nowStamp();
    const convById = new Map(this.teamworkListConversations(me).map((c) => [Number(c.id), c]));
    return {
      items: this._bk
        .listCleared(me)
        // 只有**这里**用 `expires_at`：它决定「回收站里还显不显示、还能不能恢复」，
        // 绝不参与可见性判定（可见性在 `backend/` 那一份，见 `schema.js` 的说明）
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
            // 服务端算「还剩几天」（向上取整：还剩不到一天也说 1 天，别说 0 天让人以为已经不能恢复了）
            daysLeft: Math.max(1, Math.ceil(daysBetween(now.slice(0, 10), String(x.expires_at).slice(0, 10)))),
          };
        }),
    };
  },

  /**
   * 功能：**恢复**一段被清掉的消息（`POST /api/teamwork/cleared/:id/restore`）—— 删掉那一行。
   *
   * 说明：⭐⭐ 删行 = 取消隐藏 = 消息回来。它是**唯一**合法地删 `teamwork_cleared` 行的路径
   * （⛔ 过期清理不删行 —— 那是让消息复活）。
   * 越权 / 不存在一律 404（响应体与「不存在」逐字一致）。
   */
  teamworkRestoreCleared(uid, id) {
    this._assertWritable();
    const me = Number(uid);
    if (!this._bk.deleteCleared(me, Number(id))) throw notFoundErr('清理记录');
    return { id: Number(id) };
  },

  /**
   *
   * 说明：⭐ 本模块是项目里唯一的**跨账号**数据，而「删账号要清空哪些表」是按 `user_id` 列工作的
   */
  teamworkTransferOnDelete(uid) {
    return this._bk.teamworkTransferOnDelete(Number(uid));
  },

  /**
   *
   * 说明：⚠️ 两步都**不能省**，且顺序与 SQLite / JSON 两侧的实现逐字对齐：
   */
  teamworkPurgeOnDelete(uid) {
    return this._bk.teamworkPurgeOnDelete(Number(uid));
  },
  },
  // 协作那一层（从 `modules/teamwork/lib/collab.js` 整份搬来）—— 同名方法两处都为 0。
  require('./lib/collab.js'),
);

/**
 *
 * 说明：⚠️ 空值（没带 / 空串）返回 null（= 这一端不限）；**带了就必须是一个真实存在的日期**，
 */
function normClearDay(v, label) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(`${label} 必须是日期（YYYY-MM-DD）`);
  return s;
}

/**
 *
 * 说明：⚠️ 用 `dateOrdinal()`（序日差）而不是 `new Date()` 相减 —— 与 ticker 里「逾期几天」
 */
function daysBetween(from, to) {
  const a = dateOrdinal(String(from || ''));
  const b = dateOrdinal(String(to || ''));
  return a === null || b === null ? 0 : b - a;
}

/**
 *
 * 说明：⭐ 口径必须与两端 `teamworkRowName()` **逐字一致**（内置角色 → 我起的称呼；备注 → 显示名 → 登录名），
 */
function _teamworkConvTitle(c) {
  if (c.builtin_key) return String(c.builtin_name || BUILTIN_LABELS[c.builtin_key] || '助手');
  if (c.peer_gone) return '（对方账号已注销）';
  if (c.peer_remark) return String(c.peer_remark);
  const u = c.peer_user || {};
  return u.display_name || u.username || '（账号已不可见）';
}
