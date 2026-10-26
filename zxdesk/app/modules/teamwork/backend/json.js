'use strict';

/**
 * modules/teamwork/backend/json.js —— 对话四张表的存储原语（好友 / 会话 / 成员 / 消息）的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/json.js` 按片段**逐字节切出来**的，一个字都没重写
 *    （切块前后 sha256 见 0.5.0的提交说明）。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.13
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/09-模块化重构.md
 */

const { uidOf, nowStamp } = require('../../../core/store/helpers.js');
// ⭐⭐ 0.8.12：协作五张表搬进本模块后，删项目 / 删任务的**磁盘连带**
//    要用附件路径助手（与业务层单一出处）。
const { removeFileDisk, removeProjectDir } = require('../lib/collab.js');

/**
 * ⭐⭐ **「我清掉的那一段消息」的可见性判据** —— 与 SQLite 同名函数**逐字同一语义**
 *     （形状不同：那边是 SQL 片段，这边是内存里的谓词）。
 *
 * 说明：⚠️ 三个调用者**必须都用这一份**（`listMessages` 的两个游标 / 未读数 / 左栏预览）——
 *      各写一份的后果是「清空后往回翻又能翻出来」这类静默漏洞。
 *      ⚠️⭐ `expires_at` **不参与判定**（它只决定回收站里还显不显示）：
 *      让它参与 ⇒ 30 天后被清掉的消息全部复活。
 *
 * @param {Array.<Object>} cleared - `teamwork_cleared` 的全表行（调用方一次取出，别每条消息扫一遍库）
 * @param {(number|string)} uid - 「我」
 * @param {(number|string)} cid - 会话 id
 * @param {number} msgId - 消息 id
 * @returns {boolean} 这条消息被我清掉了（= 不该出现）返回 true
 */
function isCleared(cleared, uid, cid, msgId) {
  const u = Number(uid);
  const c = Number(cid);
  const id = Number(msgId);
  return (cleared || []).some(
    (r) =>
      uidOf(r) === u &&
      Number(r.conversation_id) === c &&
      id >= Number(r.from_message_id) &&
      id <= Number(r.to_message_id),
  );
}

const ops = {
  // ---- 对话（0.3.5）----
  /**
   * 功能：列出该账号**自己这一侧**的全部好友关系行（含 `pending` / `accepted` / `blocked`）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 好友关系行数组（按 id 升序）
   */
  listFriendships(uid) {
    return (this.data.teamwork_friendships || []).filter((f) => uidOf(f) === Number(uid)).sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：取「我 → 某人」这一行好友关系；没有则为 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} friendId - 对方账号 id
   * @returns {?Object} 好友关系行；未命中为 null
   */
  getFriendship(uid, friendId) {
    return (
      (this.data.teamwork_friendships || []).find(
        (f) => uidOf(f) === Number(uid) && Number(f.friend_id) === Number(friendId),
      ) || null
    );
  },

  /**
   * 功能：把一对账号的好友关系**两行一起**写成同一个状态（不存在则建），返回是否成功。
   *
   * 说明：⭐ SQLite 那边一条 `INSERT … ON CONFLICT` 就够，JSON 这边**必须自己写「查了再改/插」**：
   *      没有唯一约束兜底，重复插入会让「我的好友列表」里出现两条同一个人。
   *      两行写在同一份内存数据里、最后只落盘一次，所以不会出现「只写了一半」的裂脑
   *      （与 SQLite 的事务等价，这是 JSON 后端唯一还能提供的原子性）。
   *
   * @param {(number|string)} uid - 一方账号 id
   * @param {(number|string)} friendId - 另一方账号 id
   * @param {string} status - 目标状态（`pending` / `accepted` / `blocked`）
   * @param {number} requestedBy - 发起人账号 id（只在新插入时写入，改状态时**不动它**）
   * @param {string} stamp - 时间戳
   * @returns {boolean} 恒为 true
   */
  setFriendshipPair(uid, friendId, status, requestedBy, stamp) {
    const a = Number(uid);
    const b = Number(friendId);
    const by = Number(requestedBy) || a;
    const one = (x, y) => {
      const cur = (this.data.teamwork_friendships || []).find((f) => uidOf(f) === x && Number(f.friend_id) === Number(y));
      if (cur) {
        cur.status = status;
        cur.updated_at = stamp;
        return;
      }
      this.data.teamwork_friendships.push({
        id: this.data._seq++,
        user_id: x,
        friend_id: Number(y),
        status,
        requested_by: by,
        created_at: stamp,
        updated_at: stamp,
      });
    };
    one(a, b);
    one(b, a);
    this._saveJson();
    return true;
  },

  /**
   * 功能：删除一对账号之间的**两行**好友关系，返回是否真的删掉了行。
   * @param {(number|string)} uid - 一方账号 id
   * @param {(number|string)} friendId - 另一方账号 id
   * @returns {boolean} 删到行则为 true
   */
  deleteFriendshipsBetween(uid, friendId) {
    const a = Number(uid);
    const b = Number(friendId);
    const before = (this.data.teamwork_friendships || []).length;
    this.data.teamwork_friendships = (this.data.teamwork_friendships || []).filter(
      (f) => !((uidOf(f) === a && Number(f.friend_id) === b) || (uidOf(f) === b && Number(f.friend_id) === a)),
    );
    if (this.data.teamwork_friendships.length === before) return false;
    this._saveJson();
    return true;
  },

  /**
   * 功能：列出「我参与的会话」，每条带上**我自己的未读数**与**最后一条消息的摘要**。
   * 说明：口径必须与 SQLite 那条查询**逐字一致**（含「自己发的不算未读」与排序规则）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 会话行数组
   */
  listConversations(uid) {
    const u = Number(uid);
    // ⭐ 0.7.7：可见性判据（与 SQLite 那条 SQL 逐字同一语义）—— **先取出清理记录**，
    //    再让「未读数」与「左栏预览」都从**滤掉之后**的那一份里算（不这么做 = 清空后预览还显示旧正文）。
    const cleared = this.data.teamwork_cleared || [];
    const msgs = (this.data.teamwork_messages || []).filter(
      (x) => !isCleared(cleared, u, x.conversation_id, x.id),
    );
    const members = this.data.teamwork_members || [];
    const out = [];
    members
      .filter((m) => uidOf(m) === u)
      .forEach((m) => {
        const c = (this.data.teamwork_conversations || []).find((x) => x.id === Number(m.conversation_id));
        if (!c) return;
        const mine = msgs.filter((x) => Number(x.conversation_id) === c.id);
        const last = mine.length ? mine.reduce((a, b) => (b.id > a.id ? b : a)) : null;
        const lastRead = Number(m.last_read_id) || 0;
        // ⚠️ 与 SQLite 那条子查询**逐字同口径**：自己发的不算未读，**但内置角色（提醒助手）发的算**
        //    —— 它的 `user_id` 也是会话归属者（见 `insertMessage`），漏掉后半句的表现是
        //    「提醒到了但红点永远不亮」，而且不报任何错。
        const unread = mine.filter((x) => x.id > lastRead && (uidOf(x) !== u || x.sender_builtin)).length;
        out.push(
          Object.assign({}, c, {
            last_read_id: lastRead,
            unread,
            last_body: last ? last.body : null,
            last_sender_id: last ? uidOf(last) : null,
            // ⭐ 0.6.x：与 SQLite 那条子查询逐字同一口径 —— 最后一条是不是**内置角色**发的。
            //    前端据此决定「我：」前缀与「算不算我自己发的」，少它会让提醒预览写成「我：【上课提醒】…」。
            last_sender_builtin: last ? last.sender_builtin || null : null,
            last_created_at: last ? last.created_at : null,
          }),
        );
      });
    return out.sort((a, b) => (Number(b.last_message_id) || 0) - (Number(a.last_message_id) || 0) || b.id - a.id);
  },

  /**
   * 功能：找「我和某人之间已有的那一对一会话」；没有则为 null。
   * @param {(number|string)} uid - 我
   * @param {(number|string)} friendId - 对方
   * @returns {?Object} 会话行；未命中为 null
   */
  findDirectConversation(uid, friendId) {
    const a = Number(uid);
    const b = Number(friendId);
    const mine = (this.data.teamwork_members || []).filter((m) => uidOf(m) === a).map((m) => Number(m.conversation_id));
    const found = (this.data.teamwork_conversations || [])
      .filter((c) => c.kind === 'direct' && mine.includes(c.id))
      .filter((c) => (this.data.teamwork_members || []).some((m) => Number(m.conversation_id) === c.id && uidOf(m) === b))
      .sort((x, y) => x.id - y.id);
    return found.length ? found[0] : null;
  },

  /**
   * 功能：按 id 取一个会话行（**不带归属条件** —— 判权由调用方先 `isMember()` 做）。
   * @param {(number|string)} cid - 会话 id
   * @returns {?Object} 会话行；不存在为 null
   */
  getConversation(cid) {
    return (this.data.teamwork_conversations || []).find((c) => c.id === Number(cid)) || null;
  },

  /**
   * 功能：按 id 改写会话的若干列（**不带 `user_id` 条件**：会话可能已过户给别人）。
   * @param {(number|string)} cid - 会话 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateConversation(cid, setKeys, values) {
    const c = (this.data.teamwork_conversations || []).find((x) => x.id === Number(cid));
    if (!c) return false;
    setKeys.forEach((k, i) => {
      c[k] = values[i];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：⭐ **判权核心** —— 该账号是不是这个会话的成员。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} cid - 会话 id
   * @returns {boolean} 是成员则为 true
   */
  isMember(uid, cid) {
    return (this.data.teamwork_members || []).some(
      (m) => uidOf(m) === Number(uid) && Number(m.conversation_id) === Number(cid),
    );
  },

  /**
   * 功能：列出某个会话的全部成员行（SSE 推送要按它确定「推给谁」）。
   * @param {(number|string)} cid - 会话 id
   * @returns {Array.<Object>} 成员行数组（按 id 升序）
   */
  listMembers(cid) {
    return (this.data.teamwork_members || [])
      .filter((m) => Number(m.conversation_id) === Number(cid))
      .sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：往会话里加一个成员；同一个人重复加入不会重复插入。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} cid - 会话 id
   * @param {string} stamp - 加入时间戳
   * @returns {boolean} 真的插入了新行则为 true
   */
  insertMember(uid, cid, stamp) {
    const exist = (this.data.teamwork_members || []).some(
      (m) => uidOf(m) === Number(uid) && Number(m.conversation_id) === Number(cid),
    );
    if (exist) return false;
    this.data.teamwork_members.push({
      id: this.data._seq++,
      user_id: Number(uid),
      conversation_id: Number(cid),
      last_read_id: 0,
      joined_at: stamp,
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：取「我在这个会话里的成员行」；不是成员则为 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} cid - 会话 id
   * @returns {?Object} 成员行；未命中为 null
   */
  getMember(uid, cid) {
    return (
      (this.data.teamwork_members || []).find(
        (m) => uidOf(m) === Number(uid) && Number(m.conversation_id) === Number(cid),
      ) || null
    );
  },

  /**
   * 功能：把「我在这个会话里的已读游标」推进到指定消息 id（**只许前进**）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} cid - 会话 id
   * @param {number} lastReadId - 目标游标
   * @returns {boolean} 更新到行则为 true
   */
  updateMemberRead(uid, cid, lastReadId) {
    // ⚠️ 这里**不能**写 `this.getMember(...)`：op 里的 `this` 是 Store 实例，而 `getMember`
    //    挂在 `ops` 上、只能通过 `this._bk.getMember(...)` 取到 —— 直接写是
    //    `this.getMember is not a function`（原语层内部一律内联，见 sqlite.js 同名 op 的注释）。
    const m = (this.data.teamwork_members || []).find(
      (x) => uidOf(x) === Number(uid) && Number(x.conversation_id) === Number(cid),
    );
    if (!m) return false;
    if (Number(lastReadId) <= (Number(m.last_read_id) || 0)) return false;
    m.last_read_id = Number(lastReadId);
    this._saveJson();
    return true;
  },

  /**
   * 功能：按游标取一个会话的消息 —— `afterId` 给增量补齐（升序），否则取 `beforeId` 之前的历史（倒序）。
   * @param {(number|string)} cid - 会话 id
   * @param {?number} beforeId - 取比它更早的消息
   * @param {?number} afterId - 取比它更新的消息
   * @param {number} limit - 条数上限
   * @returns {Array.<Object>} 消息行数组
   */
  listMessages(cid, beforeId, afterId, limit, uid) {
    const c = Number(cid);
    const n = Number(limit) || 50;
    // ⭐ 0.8.12：与 SQLite 同名 op **同列同序** —— ⛔ 永不把 `image`
    //    （整串 data URL）带出去，只回 `has_image`。JSON 这边没有列清单，靠这道投影实现。
    const shape = (m) => ({
      id: m.id,
      user_id: m.user_id,
      conversation_id: m.conversation_id,
      body: m.body,
      sender_builtin: m.sender_builtin === undefined ? null : m.sender_builtin,
      kind: m.kind === undefined ? null : m.kind,
      meta: m.meta === undefined ? null : m.meta,
      segment: m.segment === undefined ? null : m.segment,
      has_image: m.image == null || m.image === '' ? 0 : 1,
      created_at: m.created_at,
    });
    // ⭐ 0.7.7：两个游标都服从可见性判据（否则「清空后往回翻又能翻出来」）
    const cleared = this.data.teamwork_cleared || [];
    const all = (this.data.teamwork_messages || []).filter(
      (m) => Number(m.conversation_id) === c && !isCleared(cleared, uid, m.conversation_id, m.id),
    );
    const after = Number(afterId) > 0 ? Number(afterId) : null;
    if (after !== null) {
      return all
        .filter((m) => m.id > after)
        .sort((a, b) => a.id - b.id)
        .slice(0, n)
        .map(shape);
    }
    const before = Number(beforeId) > 0 ? Number(beforeId) : null;
    const tail = before === null ? all : all.filter((m) => m.id < before);
    return tail.sort((a, b) => b.id - a.id).slice(0, n).map(shape);
  },

  /**
   * 功能：写入一条消息，并把会话的 `last_message_id` 一起推进；返回新消息行。
   * @param {(number|string)} uid - 发送者 id
   * @param {(number|string)} cid - 会话 id
   * @param {string} body - 消息正文
   * @param {string} createdAt - 发送时间戳
   * @param {?string} [senderBuiltin] - 有值 = 这条是**内置角色**发的（0.6.x）；普通消息传 null / 不传。
   *      ⚠️ `user_id` 照样写会话归属者 —— 与 SQLite 同名 op 逐字同一口径。
   * @param {?string} [kind] - 消息种类（0.6.4，任务联动）：`'task_card'` = 任务卡片；普通消息传 null。
   * @param {?string} [meta] - 卡片载荷（**已序列化好的 JSON 文本**）；`kind` 为空时必须为空。
   *      ⚠️ 这里不解析它 —— 与 SQLite 同名 op 逐字同一口径。
   * @returns {Object} 新消息行（带 `id`）
   */
  insertMessage(uid, cid, body, createdAt, senderBuiltin, kind, meta) {
    const from = senderBuiltin === undefined || senderBuiltin === null ? null : String(senderBuiltin);
    const k = kind === undefined || kind === null || kind === '' ? null : String(kind);
    const m = meta === undefined || meta === null || meta === '' ? null : String(meta);
    const row = {
      id: this.data._seq++,
      user_id: Number(uid),
      conversation_id: Number(cid),
      body,
      sender_builtin: from,
      kind: k,
      meta: m,
      created_at: createdAt,
    };
    this.data.teamwork_messages.push(row);
    const c = (this.data.teamwork_conversations || []).find((x) => x.id === Number(cid));
    if (c) {
      c.last_message_id = row.id;
      c.updated_at = createdAt;
    }
    this._saveJson();
    return row;
  },

  /**
   * 功能：数一个会话里有多少条消息。
   * @param {(number|string)} cid - 会话 id
   * @returns {number} 消息条数
   */
  countMessages(cid) {
    return (this.data.teamwork_messages || []).filter((m) => Number(m.conversation_id) === Number(cid)).length;
  },

  /**
   * 功能：取一个会话里**最大**的消息 id（没有消息时为 0）—— 标记已读时用来**夹住游标**。
   * 说明：理由与 SQLite 后端逐字一致（游标是全局自增 id，不能原样接受客户端给的大数）。
   * @param {(number|string)} cid - 会话 id
   * @returns {number} 该会话最大消息 id；没有消息为 0
   */
  maxMessageId(cid) {
    const ids = (this.data.teamwork_messages || [])
      .filter((m) => Number(m.conversation_id) === Number(cid))
      .map((m) => Number(m.id));
    return ids.length ? Math.max(...ids) : 0;
  },

  /**
   * 功能：列出该账号**参与**的全部会话行（个人导出用；不含别人的消息）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 会话行数组（按 id 升序）
   */
  listMyConversations(uid) {
    const ids = (this.data.teamwork_members || [])
      .filter((m) => uidOf(m) === Number(uid))
      .map((m) => Number(m.conversation_id));
    return (this.data.teamwork_conversations || []).filter((c) => ids.includes(c.id)).sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：列出该账号在全部会话里的成员行（导出已读游标用）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 成员行数组
   */
  listMyMemberships(uid) {
    return (this.data.teamwork_members || []).filter((m) => uidOf(m) === Number(uid)).sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：列出该账号**自己发出的**全部消息 —— ⚠️ 对方的消息一条都不许进导出。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 消息行数组（按 id 升序）
   */
  listMyMessages(uid) {
    return (this.data.teamwork_messages || []).filter((m) => uidOf(m) === Number(uid)).sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（只带我这一侧的四张表）。
   *
   * 说明：⭐ 这是 0.5.0唯一新增的**新代码**：深拷贝 + 归属过滤 + 排序**逐字照抄**
   *      改造前 `exportAll()` 里那几行（连 `cp()` / `mine()` 两个局部小工具都照搬），一个字没重写。
   *      ⚠️ **「只带我这一侧」是 的硬规矩**：好友关系（我发的与我收的都算我的关系行）、
   *      我参与的会话、我在各会话里的已读游标、以及**我发出的消息** ——
   *      **对方的消息一条都不许进来**。
   *      ⚠️ `teamworkConvs` 依赖 `teamworkMembers` 算出来的 `myConvIds`，**顺序不能换**
   *      （SQLite 版靠 JOIN 一步做到，见那边同名 op 的说明）。
   *
   * @param {(number|string)} uid - 用户 id
   * @returns {{teamworkFriends: Array.<Object>, teamworkConvs: Array.<Object>,
   *      teamworkMembers: Array.<Object>, teamworkMsgs: Array.<Object>}} 备份里的那四个键
   */
  exportTeamwork(uid) {
    const d = this.data || {};
    /** 功能：深拷贝一个数组（借 JSON 序列化实现），入参为空时给空数组。 */
    const cp = (arr) => JSON.parse(JSON.stringify(arr || []));
    /** 功能：深拷贝后只保留属于该账号的行。 */
    const mine = (arr) => cp(arr).filter((r) => uidOf(r) === Number(uid));
    const teamworkFriends = mine(d.teamwork_friendships).sort((a, b) => a.id - b.id);
    const teamworkMembers = mine(d.teamwork_members).sort((a, b) => a.id - b.id);
    const myConvIds = teamworkMembers.map((m) => Number(m.conversation_id));
    const teamworkConvs = cp(d.teamwork_conversations)
      .filter((c) => myConvIds.includes(c.id))
      .sort((a, b) => a.id - b.id);
    const teamworkMsgs = mine(d.teamwork_messages).sort((a, b) => a.id - b.id);
    // ⭐ 0.7.7：第五个键 —— 我清掉了哪几段（「我这一侧的读取状态」，与已读游标同类）
    const teamworkCleared = mine(d.teamwork_cleared).sort((a, b) => a.id - b.id);
    return { teamworkFriends, teamworkConvs, teamworkMembers, teamworkMsgs, teamworkCleared };
  },

  // ---- 内置角色会话与提醒（0.6.x，对话 2 期）----
  /**
   * 功能：取该账号的**内置角色会话**（`builtin_key` 命中的那一行）；没有则为 null。
   * 说明：与 SQLite 同名 op 逐字同一口径（懒创建 ⇒「没有」是常态）。按 `user_id` 限定。
   * @param {(number|string)} uid - 用户 id
   * @param {string} key - 内置角色标识（`'reminder'`）
   * @returns {?Object} 会话行；未命中为 null
   */
  findBuiltinConversation(uid, key) {
    const u = Number(uid);
    const k = String(key);
    return (
      (this.data.teamwork_conversations || []).find((c) => uidOf(c) === u && c.builtin_key === k) || null
    );
  },

  /**
   * 功能：往提醒流水里写一行（**幂等记账**），已存在同键行时返回 null 表示「这个时刻已经发过」。
   *
   * 说明：⭐ SQLite 那边靠 `UNIQUE(...)` + `INSERT OR IGNORE` 一步做到；JSON 这边**没有唯一约束**，
   *      必须自己「查了再插」。两边的对外语义完全一致：**返回 null 就是跳过**。
   *      ⚠️ 判据必须与建表时的 `UNIQUE(user_id, kind, ref_key, fire_at)` 四列逐字一致 ——
   *      少比一列就是「同一分钟重复发」，多比一列就是「该发的不发」，而且两种都不报错。
   *
   * @param {(number|string)} uid - 收件账号 id
   * @param {string} kind - 提醒类别
   * @param {string} refKey - 这件事的稳定标识
   * @param {string} fireAt - **分钟级**触发时刻 `YYYY-MM-DD HH:MM`
   * @param {string} firedAt - 实际发出的时刻
   * @param {string} createdAt - 记账行创建时刻
   * @returns {?Object} 新插入的行（带 `id`）；已存在时返回 null
   */
  insertReminder(uid, kind, refKey, fireAt, firedAt, createdAt) {
    const u = Number(uid);
    const k = String(kind);
    const ref = String(refKey);
    const at = String(fireAt);
    const dup = (this.data.teamwork_reminders || []).some(
      (r) => uidOf(r) === u && r.kind === k && r.ref_key === ref && r.fire_at === at,
    );
    if (dup) return null;
    const row = { id: this.data._seq++, user_id: u, kind: k, ref_key: ref, fire_at: at, fired_at: firedAt, created_at: createdAt };
    this.data.teamwork_reminders.push(row);
    this._saveJson();
    return row;
  },

  /**
   * 功能：列出该账号的全部提醒流水（按 id 升序）—— 与 SQLite 同名 op 逐字同一口径。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 流水行数组（按 id 升序）
   */
  listReminders(uid) {
    return (this.data.teamwork_reminders || []).filter((r) => uidOf(r) === Number(uid)).sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：清掉 `before` 之前的旧流水行，返回删掉的条数。
   * @param {string} before - 早于这个时刻（`created_at` 字典序）的行都删掉
   * @returns {number} 实际删除的条数
   */
  purgeReminders(before) {
    const all = this.data.teamwork_reminders || [];
    const keep = all.filter((r) => String(r.created_at || '') >= String(before));
    const removed = all.length - keep.length;
    if (removed > 0) {
      this.data.teamwork_reminders = keep;
      this._saveJson();
    }
    return removed;
  },

  /**
   * 功能：取该账号的提醒偏好行；没有则为 null。
   * 说明：⚠️ 与 SQLite 同名 op 一样**不兜默认值** —— 默认值只有业务层一处（`REMINDER_PREFS_DEFAULT`）。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 偏好行；未命中为 null
   */
  getReminderPrefs(uid) {
    return (this.data.teamwork_reminder_prefs || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把该账号的提醒偏好**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 与 SQLite 那条 `ON CONFLICT(user_id) DO UPDATE` 逐字同一语义：**一人一行**。
   *      JSON 这边没有唯一约束，所以「先找、找到就改、找不到就插」必须自己写全 ——
   *      少了「找到就改」会让同一个账号攒出多行，而 `getReminderPrefs()` 只认第一行，
   *      表现是「改了设置不生效」且不报错。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Object} values - 恰好五个键：`enabled` / `course_lead_minutes` / `task_at` / `overdue_at` / `due_lead_minutes`
   * @param {string} stamp - 更新时间戳
   * @returns {Object} 写入后的偏好行（含 `id` / `user_id`）
   */
  upsertReminderPrefs(uid, values, stamp) {
    const u = Number(uid);
    // ⚠️ 与 SQLite 同名 op 逐字同一份清单（含 `care_enabled`）—— 两个后端必须同名同参地成对。
    const cols = [
      'enabled',
      'course_lead_minutes',
      'task_at',
      'overdue_at',
      'due_lead_minutes',
      'care_enabled',
      'builtin_name',
    ];
    let row = (this.data.teamwork_reminder_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.teamwork_reminder_prefs.push(row);
    }
    cols.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  // ---- 好友设置（0.7.7）----
  /**
   * 功能：取该账号的好友设置行；没有则为 null（缺省值由**业务层**给）。
   * 说明：与 SQLite 同名 op 逐字同一口径（**不兜默认值**）。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 设置行；未命中为 null
   */
  getFriendPrefs(uid) {
    return (this.data.teamwork_friend_prefs || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：把该账号的好友设置**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ JSON 这边没有唯一约束 ⇒ 必须自己写全「先找、找到就改、找不到就插」
   *      （与 `upsertReminderPrefs()` 同一条理由：少了「找到就改」会让同一个账号攒出多行，
   *      而 `getFriendPrefs()` 只认第一行 ⇒ 表现是「改了设置不生效」且不报错）。
   *      ⚠️ 列名清单与 SQLite 同名 op 逐字同一份。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Object} values - 好友设置的键（目前只有 `auto_accept_friend`）
   * @param {string} stamp - 更新时间戳
   * @returns {Object} 写入后的设置行（含 `id` / `user_id`）
   */
  upsertFriendPrefs(uid, values, stamp) {
    const u = Number(uid);
    const cols = ['auto_accept_friend'];
    let row = (this.data.teamwork_friend_prefs || []).find((r) => uidOf(r) === u);
    if (!row) {
      row = { id: this.data._seq++, user_id: u };
      this.data.teamwork_friend_prefs.push(row);
    }
    cols.forEach((k) => {
      row[k] = values[k];
    });
    row.updated_at = stamp;
    this._saveJson();
    return row;
  },

  // ---- 聊天记录清理（0.7.7）----
  /**
   * 功能：列出该账号**全部**清理记录（按 id 升序）。
   * 说明：⚠️ 与 SQLite 同名 op 一样**不做过期过滤**（`expires_at` 不参与可见性，见 `isCleared()`）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 清理记录行数组
   */
  listCleared(uid) {
    return (this.data.teamwork_cleared || []).filter((r) => uidOf(r) === Number(uid)).sort((a, b) => a.id - b.id);
  },

  /**
   * 功能：写一条清理记录（一次清理动作 = 一行），返回新行。
   * @param {Object} row - `{ user_id, conversation_id, from_message_id, to_message_id, msg_count, hidden_at, expires_at, created_at }`
   * @returns {Object} 新行（带 `id`）
   */
  insertCleared(row) {
    const r = {
      id: this.data._seq++,
      user_id: Number(row.user_id),
      conversation_id: Number(row.conversation_id),
      from_message_id: Number(row.from_message_id),
      to_message_id: Number(row.to_message_id),
      msg_count: Number(row.msg_count),
      hidden_at: String(row.hidden_at),
      expires_at: String(row.expires_at),
      created_at: row.created_at === undefined || row.created_at === null ? null : String(row.created_at),
    };
    this.data.teamwork_cleared.push(r);
    this._saveJson();
    return r;
  },

  /**
   * 功能：删掉一条清理记录（= **恢复**那一段消息），返回是否真的删到了行。
   *
   * 说明：⭐⭐ 与 SQLite 同名 op 逐字同一语义：**删行的唯一合法理由是「用户点了恢复」**
   *      （删行 = 取消隐藏 = 消息复活），⛔ 绝不为「过期清理」去删它。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 清理记录 id
   * @returns {boolean} 删到行则为 true
   */
  deleteCleared(uid, id) {
    const all = this.data.teamwork_cleared || [];
    const keep = all.filter((r) => !(Number(r.id) === Number(id) && uidOf(r) === Number(uid)));
    if (keep.length === all.length) return false;
    this.data.teamwork_cleared = keep;
    this._saveJson();
    return true;
  },

  /**
   * 功能：取一个会话里**落在某个时刻区间内**的消息 id 区间与条数。
   *
   * 说明：⭐ 与 SQLite 同名 op 逐字同一口径：**用真实命中的 id 区间**，时刻按字典序比，
   *      `fromAt` / `toAt` 为 null 表示这一端不限。
   *
   * @param {(number|string)} cid - 会话 id
   * @param {?string} fromAt - 起始时刻（含）；null = 不限
   * @param {?string} toAt - 结束时刻（含）；null = 不限
   * @returns {{min: ?number, max: ?number, count: number}} 最小 / 最大消息 id 与条数
   */
  msgIdRange(cid, fromAt, toAt) {
    const c = Number(cid);
    const ids = (this.data.teamwork_messages || [])
      .filter((m) => Number(m.conversation_id) === c)
      .filter((m) => !(fromAt && String(m.created_at || '') < String(fromAt)))
      .filter((m) => !(toAt && String(m.created_at || '') > String(toAt)))
      .map((m) => Number(m.id));
    if (!ids.length) return { min: null, max: null, count: 0 };
    return { min: Math.min(...ids), max: Math.max(...ids), count: ids.length };
  },

  /**
   * 功能：数一个会话里 `id` 落在 `[fromId, toId]`（**含两端**）内的消息条数。
   * @param {(number|string)} cid - 会话 id
   * @param {number} fromId - 起始消息 id（含）
   * @param {number} toId - 结束消息 id（含）
   * @returns {number} 条数
   */
  countMessagesBetween(cid, fromId, toId) {
    return (this.data.teamwork_messages || []).filter(
      (m) => Number(m.conversation_id) === Number(cid) && Number(m.id) >= Number(fromId) && Number(m.id) <= Number(toId),
    ).length;
  },

  /**
   * 功能：删账号第一步：**会话先过户**给还留在会话里的那个人（含语义与理由见 SQLite 版，两者逐字对齐）。
   *
   * 说明：⚠️ JSON 这一侧与 SQLite **同语义、不同写法**（两后端成对）——
   *      直接改内存里那一行的 `user_id`，没有 SQL。⚠️ 仍然必须发生在**通用清空之前**。
   *
   * ⭐ 0.8.12：与 `teamworkPurgeOnDelete` 一起从核心的 `deleteUser` 搬进本模块。
   *
   * @param {number} uid - 即将注销的账号 id
   * @returns {void}
   */
  teamworkTransferOnDelete(uid) {
    const u = Number(uid);
    (this.data.teamwork_conversations || []).forEach((c) => {
      if (uidOf(c) !== u) return;
      const others = (this.data.teamwork_members || [])
        .filter((m) => Number(m.conversation_id) === c.id && uidOf(m) !== u)
        .sort((a, b) => uidOf(a) - uidOf(b));
      if (others.length) c.user_id = uidOf(others[0]);
    });
  },

  /**
   * 功能：删账号第二步：好友补刀 ＋ 收拾悬空引用（含理由与顺序约束见 SQLite 版，两者逐字对齐）。
   *
   * ⚠️ 三句的顺序就是 SQLite 版三句的顺序，⛔ 不许换（换了的后果见那边的方法说明）。
   *
   * @param {number} uid - 即将注销的账号 id
   * @returns {void}
   */
  teamworkPurgeOnDelete(uid) {
    const u = Number(uid);
    this.data.teamwork_friendships = (this.data.teamwork_friendships || []).filter(
      (f) => Number(f.friend_id) !== u,
    );
    const convIds = new Set((this.data.teamwork_conversations || []).map((c) => c.id));
    this.data.teamwork_members = (this.data.teamwork_members || []).filter((m) => convIds.has(Number(m.conversation_id)));
    this.data.teamwork_messages = (this.data.teamwork_messages || []).filter((m) =>
      convIds.has(Number(m.conversation_id)),
    );
    const liveConvs = new Set((this.data.teamwork_members || []).map((m) => Number(m.conversation_id)));
    this.data.teamwork_conversations = (this.data.teamwork_conversations || []).filter((c) => liveConvs.has(c.id));
  },

  // ==== ⭐⭐ 0.8.12：协作原语（从 `modules/tasks/backend/json.js` 整批搬来）====
  //    ⚠️ 判权逻辑一条都不在这一层（见 sqlite.js 同段的说明）。

  /**
   * 功能：列出「我是成员」的那些**共享项目**（不含我自己拥有的）。
   * @param {(number|string)} uid - 账号 id
   * @returns {Array.<Object>} 项目行数组
   */
  listProjectsOfMember(uid) {
    const d = this.data || {};
    const mine = new Set((d.project_members || []).filter((m) => uidOf(m) === Number(uid)).map((m) => Number(m.project_id)));
    return (d.projects || [])
      .filter((p) => mine.has(Number(p.id)) && Number(p.shared) === 1)
      .map((p) => ({ ...p }))
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id));
  },

  /**
   * 功能：列出某个项目的成员行（谁先加进来排在前面）。
   * @param {(number|string)} projectId - 项目 id
   * @returns {Array.<Object>} 成员行数组
   */
  listProjectMembers(projectId) {
    return (this.data.project_members || [])
      .filter((m) => Number(m.project_id) === Number(projectId))
      .map((m) => ({ ...m }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  },

  /**
   * 功能：把一个人移出项目；返回是否真的删掉了一行。
   * @param {(number|string)} projectId - 项目 id
   * @param {(number|string)} memberId - 被移出的人
   * @returns {boolean} 行是否真的被删掉
   */
  deleteProjectMember(projectId, memberId) {
    const before = (this.data.project_members || []).length;
    this.data.project_members = (this.data.project_members || []).filter(
      (m) => !(Number(m.project_id) === Number(projectId) && uidOf(m) === Number(memberId)),
    );
    this._saveJson();
    return this.data.project_members.length < before;
  },

  /**
   * 功能：清空某个项目的成员名单（删项目时连带），返回删掉的行数。
   * @param {(number|string)} projectId - 项目 id
   * @returns {number} 受影响的行数
   */
  deleteProjectMembersOfProject(projectId) {
    const before = (this.data.project_members || []).length;
    this.data.project_members = (this.data.project_members || []).filter(
      (m) => Number(m.project_id) !== Number(projectId),
    );
    if (this.data.project_members.length !== before) this._saveJson();
    return before - this.data.project_members.length;
  },

  /**
   * 功能：按「任务来源 + 一批任务 id」取上报（按时间正序）。
   * @param {string} taskSource - `'project_tasks'` / `'daily_tasks'`
   * @param {Array.<number>} taskIds - 任务 id 数组
   * @returns {Array.<Object>} 上报行数组
   */
  listTaskReportsForTasks(taskSource, taskIds) {
    if (!Array.isArray(taskIds) || !taskIds.length) return [];
    const ids = new Set(taskIds.map(Number));
    return (this.data.task_reports || [])
      .filter((r) => String(r.task_source) === String(taskSource) && ids.has(Number(r.task_id)))
      .map((r) => ({ ...r }))
      .sort(
        (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || Number(a.id) - Number(b.id),
      );
  },

  /**
   * 功能：删除**我自己**的一条上报；返回是否真的删掉了一行。
   * @param {(number|string)} uid - 账号 id
   * @param {(number|string)} id - 上报 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteTaskReport(uid, id) {
    const before = (this.data.task_reports || []).length;
    this.data.task_reports = (this.data.task_reports || []).filter(
      (r) => !(Number(r.id) === Number(id) && uidOf(r) === Number(uid)),
    );
    if (this.data.task_reports.length !== before) this._saveJson();
    return this.data.task_reports.length < before;
  },

  /**
   * 功能：清空一批任务上的上报（删项目 / 删项目任务时连带），返回删掉的行数。
   * @param {string} taskSource - `'project_tasks'` / `'daily_tasks'`
   * @param {Array.<number>} taskIds - 任务 id 数组
   * @returns {number} 受影响的行数
   */
  deleteTaskReportsOfTasks(taskSource, taskIds) {
    if (!Array.isArray(taskIds) || !taskIds.length) return 0;
    const ids = new Set(taskIds.map(Number));
    const before = (this.data.task_reports || []).length;
    this.data.task_reports = (this.data.task_reports || []).filter(
      (r) => !(String(r.task_source) === String(taskSource) && ids.has(Number(r.task_id))),
    );
    if (this.data.task_reports.length !== before) this._saveJson();
    return before - this.data.task_reports.length;
  },

  /**
   * 功能：列出某个项目的状态集（组内顺序在前、id 升序兜底）。
   * @param {(number|string)} projectId - 项目 id
   * @returns {Array.<Object>} 状态行数组（深拷贝）
   */
  listCollabStates(projectId) {
    return (this.data.collab_states || [])
      .filter((s) => Number(s.project_id) === Number(projectId))
      .map((s) => ({ ...s }))
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id));
  },

  /**
   * 功能：按 id 取一个状态行，且**限定它属于这个项目**。
   * @param {(number|string)} projectId - 项目 id
   * @param {(number|string)} stateId - 状态 id
   * @returns {?Object} 状态行（深拷贝）；不存在或不属于该项目时为 null
   */
  findCollabState(projectId, stateId) {
    const row = (this.data.collab_states || []).find(
      (s) => Number(s.id) === Number(stateId) && Number(s.project_id) === Number(projectId),
    );
    return row ? { ...row } : null;
  },

  /**
   * 功能：改一个状态行（只有调用方挑好的列进 patch），返回是否真的更新到。
   * @param {(number|string)} projectId - 项目 id
   * @param {(number|string)} stateId - 状态 id
   * @param {Object} patch - 列名 → 新值
   * @returns {boolean} 更新到行则为 true
   */
  updateCollabState(projectId, stateId, patch) {
    const row = (this.data.collab_states || []).find(
      (s) => Number(s.id) === Number(stateId) && Number(s.project_id) === Number(projectId),
    );
    if (!row) return false;
    Object.keys(patch || {}).forEach((k) => {
      row[k] = patch[k];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：删一个状态行（限定属于该项目），返回是否真的删掉了一行。
   * @param {(number|string)} projectId - 项目 id
   * @param {(number|string)} stateId - 状态 id
   * @returns {boolean} 删到行则为 true
   */
  deleteCollabState(projectId, stateId) {
    const before = (this.data.collab_states || []).length;
    this.data.collab_states = (this.data.collab_states || []).filter(
      (s) => !(Number(s.id) === Number(stateId) && Number(s.project_id) === Number(projectId)),
    );
    if (this.data.collab_states.length !== before) this._saveJson();
    return this.data.collab_states.length < before;
  },

  /**
   * 功能：把项目**过户**给另一个账号 —— 改 `projects.user_id` 与它名下全部 `project_tasks.user_id`。
   * @param {(number|string)} projectId - 项目 id
   * @param {(number|string)} newOwnerId - 新所有者账号 id
   * @returns {boolean} 项目存在且过户成功则为 true
   * 说明：⚠️ 为什么任务行的 `user_id` 也要改、为什么负责人（`assignee_id`）与成员名单一个字不动 ——
   *      见 sqlite.js 同名 op 的说明（两后端必须同语义）。
   */
  transferProject(projectId, newOwnerId) {
    const pid = Number(projectId);
    const nid = Number(newOwnerId);
    const p = (this.data.projects || []).find((x) => Number(x.id) === pid);
    if (!p) return false;
    p.user_id = nid;
    (this.data.project_tasks || []).forEach((t) => {
      if (Number(t.project_id) === pid) t.user_id = nid;
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：列出一个项目的**全部评论**（项目级 ＋ 任务级），按时间正序。
   * @param {(number|string)} projectId - 项目 id
   * @returns {Array.<Object>} 评论行数组（深拷贝）
   */
  listProjectComments(projectId) {
    return (this.data.project_comments || [])
      .filter((c) => Number(c.project_id) === Number(projectId))
      .map((c) => ({ ...c }))
      .sort(
        (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || Number(a.id) - Number(b.id),
      );
  },

  /**
   * 功能：按 id 直接取一条评论（不管归属）。
   * @param {(number|string)} id - 评论 id
   * @returns {?Object} 评论行（深拷贝）；不存在时为 null
   */
  findCommentById(id) {
    const row = (this.data.project_comments || []).find((c) => Number(c.id) === Number(id));
    return row ? { ...row } : null;
  },

  /**
   * 功能：删除**我自己**的一条评论（并**连带删掉这条评论的附件**：文件行 ＋ 磁盘文件）；
   *      返回是否真的删掉了一行。
   * @param {(number|string)} id - 评论 id
   * @param {(number|string)} userId - 必须是作者
   * @returns {boolean} 行是否真的被删掉
   * 说明：⚠️ 带作者过滤是判权的第二道保险（第一道在业务层）。⭐ 0.8.12 · 2g 连带删附件 ——
   *      与 SQLite 版同一条口径（只删 `comment_id` 等于这条评论的，同任务的其他附件不动）。
   */
  deleteComment(id, userId) {
    const before = (this.data.project_comments || []).length;
    this.data.project_comments = (this.data.project_comments || []).filter(
      (c) => !(Number(c.id) === Number(id) && uidOf(c) === Number(userId)),
    );
    const removed = this.data.project_comments.length < before;
    if (removed) {
      // ⚠️ 先挡 null / ''（`Number(null) === 0` 是有限数，会误伤没挂评论的附件）。
      const gone = (this.data.project_files || []).filter(
        (f) => f.comment_id != null && f.comment_id !== '' && Number(f.comment_id) === Number(id),
      );
      gone.forEach((f) => removeFileDisk(this.dataDir, f));
      this.data.project_files = (this.data.project_files || []).filter(
        (f) => !(f.comment_id != null && f.comment_id !== '' && Number(f.comment_id) === Number(id)),
      );
    }
    if (removed) this._saveJson();
    return removed;
  },

  /**
   * 功能：列出**我写过的**全部评论（进个人备份那一份读取）。
   * @param {(number|string)} uid - 账号 id
   * @returns {Array.<Object>} 评论行数组（深拷贝，按项目、id 升序）
   */
  listCommentsOfAuthor(uid) {
    return (this.data.project_comments || [])
      .filter((c) => uidOf(c) === Number(uid))
      .map((c) => ({ ...c }))
      .sort((a, b) => Number(a.project_id) - Number(b.project_id) || Number(a.id) - Number(b.id));
  },

  /**
   * 功能：列出某个项目的**全部附件**（项目级 ＋ 任务级），按时间正序。
   * @param {(number|string)} projectId - 项目 id
   * @returns {Array.<Object>} 附件行数组（深拷贝）
   */
  listProjectFiles(projectId) {
    return (this.data.project_files || [])
      .filter((f) => Number(f.project_id) === Number(projectId))
      .map((f) => ({ ...f }))
      .sort(
        (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || Number(a.id) - Number(b.id),
      );
  },

  /**
   * 功能：列出**全库**附件行（整体备份 / 启动孤儿巡检用），按项目、id 升序。
   * @returns {Array.<Object>} 附件行数组（深拷贝）
   */
  listAllProjectFiles() {
    return (this.data.project_files || [])
      .map((f) => ({ ...f }))
      .sort((a, b) => Number(a.project_id) - Number(b.project_id) || Number(a.id) - Number(b.id));
  },

  /**
   * 功能：按 id 直接取一行附件（不管归属）。
   * @param {(number|string)} id - 附件 id
   * @returns {?Object} 附件行（深拷贝）；不存在时为 null
   */
  findFileById(id) {
    const row = (this.data.project_files || []).find((f) => Number(f.id) === Number(id));
    return row ? { ...row } : null;
  },

  /**
   * 功能：删除一行附件记录（按 id）；返回是否真的删掉了一行。
   * @param {(number|string)} id - 附件 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteFile(id) {
    const before = (this.data.project_files || []).length;
    this.data.project_files = (this.data.project_files || []).filter((f) => Number(f.id) !== Number(id));
    if (this.data.project_files.length !== before) this._saveJson();
    return this.data.project_files.length < before;
  },

  /**
   * 功能：给 `task_reports` 的老行补 `project_id`（按 `task_id` 反查 `project_tasks.project_id`）。
   * @returns {number} 受影响的行数
   * 说明：⚠️ 幂等（补过的行不再处理）、找不到对应任务的行保持 NULL（不猜、不硬塞）；
   *      只处理 `task_source='project_tasks'`。见 sqlite.js 同名 op 的说明。
   */
  backfillReportProjects() {
    let n = 0;
    const tasks = this.data.project_tasks || [];
    (this.data.task_reports || []).forEach((r) => {
      if (r.project_id != null) return;
      if (String(r.task_source) !== 'project_tasks') return;
      const t = tasks.find((x) => Number(x.id) === Number(r.task_id));
      if (!t) return;
      r.project_id = Number(t.project_id);
      n += 1;
    });
    if (n) this._saveJson();
    return n;
  },

  /**
   * 功能：把某个项目里「负责人文本名」按**精确匹配** `users.username` 补成 `assignee_id`。
   * @param {(number|string)} projectId - 项目 id
   * @returns {number} 受影响的行数
   * 说明：⚠️ **匹配不上不改写**（`assignee_id` 留 NULL）；幂等判据钉在 `assignee_id == null` 上。
   *      见 sqlite.js 同名 op 的说明。
   */
  backfillProjectAssignees(projectId) {
    let n = 0;
    const users = this.data.users || [];
    (this.data.project_tasks || []).forEach((t) => {
      if (Number(t.project_id) !== Number(projectId)) return;
      if (t.assignee_id != null) return;
      const name = t.assignee == null ? '' : String(t.assignee);
      if (!name) return;
      const u = users.find((x) => String(x.username) === name);
      if (!u) return;
      t.assignee_id = Number(u.id);
      n += 1;
    });
    if (n) this._saveJson();
    return n;
  },

  /**
   * 功能：与 SQLite 版同名同参 —— JSON 回退后端**没有表结构约束**（NOT NULL / CHECK 都不存在），
   *      所以这里恒为无操作。保留这个 op 只为满足「两后端同名同参」（`assertOpsContract()`）。
   * @returns {boolean} 恒为 false
   */
  ensureReportFlowSchema() {
    return false;
  },

  /**
   * 功能：删项目时**连带清协作那张公共数据**（状态配置 / 评论 / 附件行 ＋ 磁盘目录）—— 删项目连带的一处出口。
   * @param {(number|string)} projectId - 项目 id
   * @returns {void}
   * 说明：⭐⭐ 0.8.12：与 SQLite 版同名同参、同语义 —— 表名与磁盘布局只在本模块一处，
   *      `tasks` 的 `deleteProject()` 只负责在项目行真被删掉时经 `_bk` 调它。
   */
  deleteProjectCollabData(projectId) {
    const id = Number(projectId);
    this.data.collab_states = (this.data.collab_states || []).filter((s) => Number(s.project_id) !== id);
    this.data.project_comments = (this.data.project_comments || []).filter((c) => Number(c.project_id) !== id);
    this.data.project_files = (this.data.project_files || []).filter((f) => Number(f.project_id) !== id);
    removeProjectDir(this.dataDir, id);
    this._saveJson();
  },

  /**
   * 功能：删项目任务时**连带清它的任务级协作数据**（评论行 / 附件行 ＋ 磁盘文件）—— 删任务连带的一处出口。
   * @param {(number|string)} taskId - 项目任务 id
   * @returns {void}
   * 说明：⭐⭐ 0.8.12：与 SQLite 版同名同参、同语义 —— 项目级评论（`task_id` 为 NULL）与
   *      同任务其他附件（`comment_id` 指别处）一个字不动。
   */
  deleteTaskCollabData(taskId) {
    const id = Number(taskId);
    this.data.project_comments = (this.data.project_comments || []).filter(
      (c) => !(c.task_id != null && Number(c.task_id) === id),
    );
    const gone = (this.data.project_files || []).filter((f) => f.task_id != null && Number(f.task_id) === id);
    gone.forEach((f) => removeFileDisk(this.dataDir, f));
    this.data.project_files = (this.data.project_files || []).filter(
      (f) => !(f.task_id != null && Number(f.task_id) === id),
    );
    this._saveJson();
  },

  // ==== 0.8.12：AI 助手会话并进对话两张表 —— 与 SQLite 同名同参同语义 ====

  /**
   * 功能：存量 AI 会话的**一次性搬迁**（JSON 后端）—— 先体检、整份提交、幂等、老表保留。
   * 说明：⚠️ JSON 回退后端**没有真事务**，所以「整份回滚」用「先把全部校验做完、再整体赋值、
   *      赋值失败就把旧数组原样换回去」近似 —— 与 SQLite 的 `BEGIN / COMMIT / ROLLBACK` 等价。
   *      ⛔ 老表 `ai_chats` / `ai_messages` 一个字都不删、不改（退路）。
   * @returns {{status: string, migrated: number, conversations: number, reason: string}} 见 SQLite 版
   */
  migrateAiChatSessions() {
    const d = this.data;
    const convs = d.teamwork_conversations || [];
    if (convs.some((c) => String(c.builtin_key) === 'ai'))
      return { status: 'skip', migrated: 0, conversations: 0, reason: 'already' };
    const chats = d.ai_chats || [];
    if (!chats.length) return { status: 'skip', migrated: 0, conversations: 0, reason: 'empty' };
    const msgs = d.ai_messages || [];
    const chatIds = new Set(chats.map((c) => Number(c.id)));
    if (msgs.some((m) => !chatIds.has(Number(m.chat_id))))
      return { status: 'abort', migrated: 0, conversations: 0, reason: 'orphan' };
    if (msgs.some((m) => m.role !== 'user' && m.role !== 'assistant'))
      return { status: 'abort', migrated: 0, conversations: 0, reason: 'role' };
    const stamp = nowStamp();
    const backup = {
      convs: d.teamwork_conversations,
      members: d.teamwork_members,
      msgs: d.teamwork_messages,
      seq: d._seq,
    };
    const nextConvs = convs.slice();
    const nextMembers = (d.teamwork_members || []).slice();
    const nextMsgs = (d.teamwork_messages || []).slice();
    let seq = Number(d._seq) || 1;
    let migratedMsgs = 0;
    try {
      for (const c of chats) {
        const owner = Number(c.user_id);
        const title = c.title == null || String(c.title).trim() === '' ? 'AI 助手' : String(c.title);
        const convRow = {
          id: seq++,
          user_id: owner,
          kind: 'direct',
          title,
          builtin_key: 'ai',
          cur_segment: c.cur_segment == null ? null : Number(c.cur_segment),
          last_message_id: 0,
          created_at: c.created_at == null ? stamp : String(c.created_at),
          updated_at: c.updated_at == null ? stamp : String(c.updated_at),
        };
        nextConvs.push(convRow);
        nextMembers.push({ id: seq++, user_id: owner, conversation_id: convRow.id, last_read_id: 0, joined_at: stamp });
        const mine = msgs
          .filter((m) => Number(m.chat_id) === Number(c.id))
          .sort((a, b) => Number(a.id) - Number(b.id));
        let last = 0;
        for (const m of mine) {
          const mid = seq++;
          nextMsgs.push({
            id: mid,
            user_id: owner,
            conversation_id: convRow.id,
            body: m.content == null ? '' : String(m.content),
            sender_builtin: m.role === 'assistant' ? 'ai' : null,
            kind: m.kind == null ? null : String(m.kind),
            meta: m.meta == null ? null : String(m.meta),
            segment: m.segment == null ? null : Number(m.segment),
            image: m.image == null ? null : String(m.image),
            created_at: m.created_at == null ? stamp : String(m.created_at),
          });
          last = mid;
          migratedMsgs += 1;
        }
        convRow.last_message_id = last;
      }
      d.teamwork_conversations = nextConvs;
      d.teamwork_members = nextMembers;
      d.teamwork_messages = nextMsgs;
      d._seq = seq;
      this._saveJson();
      return { status: 'done', migrated: migratedMsgs, conversations: chats.length, reason: '' };
    } catch (e) {
      d.teamwork_conversations = backup.convs;
      d.teamwork_members = backup.members;
      d.teamwork_messages = backup.msgs;
      d._seq = backup.seq;
      throw e;
    }
  },

  /**
   * 功能：往内置助手会话追加一条消息（JSON 版，与 SQLite 同名 op 同语义）。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {string} body - 正文
   * @param {string} createdAt - 时间戳
   * @param {?string} senderBuiltin - `'ai'` / null
   * @param {?string} kind - 消息种类
   * @param {?string} meta - 卡片快照 JSON 文本
   * @param {?string} image - 整串 data URL
   * @param {?number} segment - 段号
   * @returns {{id: number}} 新消息 id
   */
  insertBuiltinChatMessage(uid, cid, body, createdAt, senderBuiltin, kind, meta, image, segment) {
    const row = {
      id: this.data._seq++,
      user_id: Number(uid),
      conversation_id: Number(cid),
      body,
      sender_builtin: senderBuiltin === undefined || senderBuiltin === null ? null : String(senderBuiltin),
      kind: kind === undefined || kind === null || kind === '' ? null : String(kind),
      meta: meta === undefined || meta === null || meta === '' ? null : String(meta),
      image: image === undefined || image === null ? null : String(image),
      segment: segment === undefined || segment === null ? null : Number(segment),
      created_at: createdAt,
    };
    this.data.teamwork_messages.push(row);
    const c = (this.data.teamwork_conversations || []).find((x) => Number(x.id) === Number(cid));
    if (c) {
      c.last_message_id = row.id;
      c.updated_at = createdAt;
    }
    this._saveJson();
    return { id: row.id };
  },

  /**
   * 功能：按游标取内置助手会话的消息（JSON 版，id 降序、只回 `has_image`）。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {?number} beforeId - 游标
   * @param {number} limit - 条数上限
   * @param {?number} segment - 只取这一段；null = 全部
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listBuiltinChatMessages(uid, cid, beforeId, limit, segment) {
    const u = Number(uid);
    const c = Number(cid);
    const seg = segment ? Number(segment) : null;
    // ⭐ 0.8.12：AI 会话的读口也要过「我清掉的那一段」这道闸
    //    —— 与 SQLite 的 `clearedVisible()` 同一判据（这里按 id 区间过滤）。
    const cleared = (this.data.teamwork_cleared || []).filter(
      (r) => Number(r.user_id) === u && Number(r.conversation_id) === c,
    );
    let all = (this.data.teamwork_messages || []).filter(
      (m) =>
        Number(m.conversation_id) === c &&
        Number(m.user_id) === u &&
        !cleared.some((r) => Number(m.id) >= Number(r.from_message_id) && Number(m.id) <= Number(r.to_message_id)),
    );
    if (seg !== null) all = all.filter((m) => (m.segment == null ? 1 : Number(m.segment)) === seg);
    if (beforeId) all = all.filter((m) => m.id < Number(beforeId));
    return all
      .sort((a, b) => b.id - a.id)
      .slice(0, Number(limit) || 50)
      .map((m) => ({
        id: m.id,
        user_id: m.user_id,
        conversation_id: m.conversation_id,
        body: m.body,
        sender_builtin: m.sender_builtin === undefined ? null : m.sender_builtin,
        kind: m.kind === undefined ? null : m.kind,
        meta: m.meta === undefined ? null : m.meta,
        segment: m.segment === undefined ? null : m.segment,
        has_image: m.image == null || m.image === '' ? 0 : 1,
        created_at: m.created_at,
      }));
  },

  /**
   * 功能：数内置助手会话某一段里的消息条数（JSON 版）。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {number} segment - 段号
   * @returns {number} 条数
   */
  countBuiltinChatMessagesInSegment(uid, cid, segment) {
    const u = Number(uid);
    const c = Number(cid);
    const seg = Number(segment);
    return (this.data.teamwork_messages || []).filter(
      (m) =>
        Number(m.conversation_id) === c &&
        Number(m.user_id) === u &&
        (m.segment == null ? 1 : Number(m.segment)) === seg,
    ).length;
  },

  /**
   * 功能：取内置助手会话某一段的最近 `limit` 条消息（JSON 版，id 降序）。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {number} segment - 段号
   * @param {number} limit - 条数上限
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listBuiltinChatContext(uid, cid, segment, limit) {
    const u = Number(uid);
    const c = Number(cid);
    const seg = Number(segment);
    // ⭐ 0.8.12：喂模型的上下文同样不该带「我已经清掉的那一段」。
    const cleared = (this.data.teamwork_cleared || []).filter(
      (r) => Number(r.user_id) === u && Number(r.conversation_id) === c,
    );
    return (this.data.teamwork_messages || [])
      .filter(
        (m) =>
          Number(m.conversation_id) === c &&
          Number(m.user_id) === u &&
          (m.segment == null ? 1 : Number(m.segment)) === seg &&
          !cleared.some((r) => Number(m.id) >= Number(r.from_message_id) && Number(m.id) <= Number(r.to_message_id)),
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, Number(limit) || 20)
      .map((m) => ({
        id: m.id,
        body: m.body,
        sender_builtin: m.sender_builtin === undefined ? null : m.sender_builtin,
        kind: m.kind === undefined ? null : m.kind,
        meta: m.meta === undefined ? null : m.meta,
        segment: m.segment == null ? 1 : Number(m.segment),
        created_at: m.created_at,
      }));
  },

  /**
   * 功能：取内置助手会话里的一条消息（JSON 版）。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {number} id - 消息 id
   * @returns {?Object} 消息行；不存在为 null
   */
  getBuiltinChatMessage(uid, cid, id) {
    const u = Number(uid);
    const c = Number(cid);
    const m = (this.data.teamwork_messages || []).find(
      (x) => Number(x.id) === Number(id) && Number(x.conversation_id) === c && Number(x.user_id) === u,
    );
    if (!m) return null;
    return {
      id: m.id,
      body: m.body,
      sender_builtin: m.sender_builtin === undefined ? null : m.sender_builtin,
      kind: m.kind === undefined ? null : m.kind,
      meta: m.meta === undefined ? null : m.meta,
      segment: m.segment == null ? 1 : Number(m.segment),
      has_image: m.image == null || m.image === '' ? 0 : 1,
      created_at: m.created_at,
    };
  },

  /**
   * 功能：改内置助手会话里一条消息的 `meta`（JSON 版），返回影响行数。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {number} id - 消息 id
   * @param {string} meta - 新的快照 JSON 文本
   * @returns {number} 影响行数
   */
  setBuiltinChatMessageMeta(uid, cid, id, meta) {
    const u = Number(uid);
    const c = Number(cid);
    const m = (this.data.teamwork_messages || []).find(
      (x) => Number(x.id) === Number(id) && Number(x.conversation_id) === c && Number(x.user_id) === u,
    );
    if (!m) return 0;
    m.meta = String(meta);
    this._saveJson();
    return 1;
  },

  /**
   * 功能：取内置助手会话里一条消息的图片（JSON 版）。
   * @param {(number|string)} uid - 收件人
   * @param {(number|string)} cid - 会话 id
   * @param {number} id - 消息 id
   * @returns {?string} 整串 data URL；不存在 / 没有图 ⇒ null
   */
  getBuiltinChatMessageImage(uid, cid, id) {
    const u = Number(uid);
    const c = Number(cid);
    const m = (this.data.teamwork_messages || []).find(
      (x) => Number(x.id) === Number(id) && Number(x.conversation_id) === c && Number(x.user_id) === u,
    );
    const s = m && m.image != null ? String(m.image) : '';
    return s || null;
  },

  /**
   * 功能：把内置助手会话的当前段号写成 `segment`（JSON 版）。
   * @param {(number|string)} cid - 会话 id
   * @param {number} segment - 新段号
   * @returns {boolean} 改到为 true
   */
  setBuiltinChatSegment(cid, segment) {
    const c = (this.data.teamwork_conversations || []).find((x) => Number(x.id) === Number(cid));
    if (!c) return false;
    c.cur_segment = Number(segment);
    this._saveJson();
    return true;
  },
};

module.exports = { ops };
