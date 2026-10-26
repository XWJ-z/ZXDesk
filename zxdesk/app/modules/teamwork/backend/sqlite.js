'use strict';

/**
 * modules/teamwork/backend/sqlite.js —— 对话四张表的存储原语（好友 / 会话 / 成员 / 消息）的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/sqlite.js` 按片段**逐字节切出来**的，一个字都没重写
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

/**
 * ⭐⭐ **「我清掉的那一段消息」的可见性判据** —— 全项目**只有这一处**（一处定义、三处复用）。
 *
 * 说明：⚠️ 清一段聊天记录**不删任何一行**（对话是跨账号数据，删行＝连对方的记录一起删），
 *      只往 `teamwork_cleared` 记一行「我隐藏了哪个会话的哪一段」，读的时候把这一段滤掉。
 *      ⇒ 三个调用者**必须都用这一份**（各写一份的后果是「清空后往回翻又能翻出来」这类静默漏洞）：
 *      ① `listMessages()` —— `before` / `after` **两个游标都要服从**；
 *      ② `listConversations()` 的**未读数**子查询；
 *      ③ `listConversations()` 的**左栏预览**四个子查询（body / 发送者 / 是否内置 / 时间）。
 *
 *      ⚠️⭐ 两条**写进判据形状里**的硬规矩（见 `schema.js` 那张表的说明）：
 *      · `expires_at` **绝不出现在这里** —— 它只决定「回收站里还显不显示、还能不能恢复」；
 *        让它参与可见性 ⇒ 30 天后被清掉的消息**全部复活**。
 *      · 「会话排序」**刻意不服从**它（会话还是那个会话，按真实的最后一条消息排）—— 这是**有意**的，
 *        别让后来者以为漏了。
 *
 * @param {string} alias - 消息表的别名（`m` / `x` / `y`）
 * @param {string} owner - 「我」的表达式（外层成员行的 `m.user_id`，或 `listMessages` 里的绑定占位符 `?`）
 * @returns {string} 可直接拼进 `WHERE … AND` 的 SQL 片段
 */
function clearedVisible(alias, owner) {
  return (
    `NOT EXISTS (SELECT 1 FROM teamwork_cleared r WHERE r.user_id = ${owner}` +
    ` AND r.conversation_id = ${alias}.conversation_id` +
    ` AND ${alias}.id BETWEEN r.from_message_id AND r.to_message_id)`
  );
}

// ⭐⭐ 0.8.12：协作五张表搬进本模块后，这里补齐它们的原语。
//    `ensureReportFlowSchema()` 重建 `task_reports` 时要用**本模块自己的 DDL**（单一出处，避免
//    重建出来的表与 `schema.js` 漂移）；schema.js 是纯数据、无 require，不会成环。
const TEAMWORK_SCHEMA = require('../schema.js');
// ⭐⭐ 0.8.12：删项目 / 删任务的**磁盘连带**要用附件路径助手（与业务层单一出处）。
const { removeFileDisk, removeProjectDir } = require('../lib/collab.js');
// ⭐⭐ 0.8.12：存量 AI 会话搬迁要给新建的会话 / 成员行一个时间戳。
//    与业务层同一份（`nowStamp()` 的时区口径只此一处）。
const { nowStamp } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 对话（0.3.5）----
  /**
   * 功能：列出该账号**自己这一侧**的全部好友关系行（含 `pending` / `accepted` / `blocked`）。
   *
   * 说明：⭐ 好友存两行（我→他 / 他→我），所以「我的好友列表」就是这一条最简单的单表查询。
   *      ⚠️ 状态与对方那一行**由 `setFriendshipPair` 保证一致**，这里不做任何推导。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 好友关系行数组（按 id 升序，即「先加的在前面」）
   */
  listFriendships(uid) {
    return this._listSql('SELECT * FROM teamwork_friendships WHERE user_id=? ORDER BY id ASC', [uid]);
  },

  /**
   * 功能：取「我 → 某人」这一行好友关系；没有则为 null。
   * @param {number} uid - 用户 id
   * @param {number} friendId - 对方账号 id
   * @returns {?Object} 好友关系行；未命中为 null
   */
  getFriendship(uid, friendId) {
    return this.db.prepare('SELECT * FROM teamwork_friendships WHERE user_id=? AND friend_id=?').get(uid, friendId) || null;
  },

  /**
   * 功能：把一对账号的好友关系**两行一起**写成同一个状态（不存在则建），返回是否成功。
   *
   * 说明：⭐ **必须是一个事务**，这是本模块最容易出「裂脑」的一处：只写了「我→他」而没写
   *      「他→我」的话，A 的界面上是好友、B 的界面上却不是 —— 而且没有任何报错。
   *      一条 SQL 就够：`INSERT … ON CONFLICT(user_id, friend_id) DO UPDATE`
   *      （依赖建表时的 `UNIQUE(user_id, friend_id)`）。
   *
   * @param {number} uid - 一方账号 id
   * @param {number} friendId - 另一方账号 id
   * @param {string} status - 目标状态（`pending` / `accepted` / `blocked`）
   * @param {number} requestedBy - 发起人账号 id（只在新插入时写入，改状态时**不动它**）
   * @param {string} stamp - 时间戳（`created_at` 与 `updated_at` 都写它）
   * @returns {boolean} 恒为 true（写入失败会抛错而不是返回 false）
   */
  setFriendshipPair(uid, friendId, status, requestedBy, stamp) {
    const a = Number(uid);
    const b = Number(friendId);
    const by = Number(requestedBy) || a;
    const up = this.db.prepare(
      `INSERT INTO teamwork_friendships (user_id, friend_id, status, requested_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, friend_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      up.run(a, b, status, by, stamp, stamp);
      up.run(b, a, status, by, stamp, stamp);
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return true;
  },

  /**
   * 功能：删除一对账号之间的**两行**好友关系（删好友走它），返回是否真的删掉了行。
   * @param {number} uid - 一方账号 id
   * @param {number} friendId - 另一方账号 id
   * @returns {boolean} 删到行则为 true
   */
  deleteFriendshipsBetween(uid, friendId) {
    const a = Number(uid);
    const b = Number(friendId);
    const r = this.db
      .prepare('DELETE FROM teamwork_friendships WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)')
      .run(a, b, b, a);
    return r.changes > 0;
  },

  /**
   * 功能：列出「我参与的会话」，每条带上**我自己的未读数**与**最后一条消息的三个摘要字段**。
   *
   * 说明：⭐ 一次查询就把会话列表页要画的东西取齐（方案 §4.1 取舍 3）——
   *      改造前那种「先查会话、再逐条 `MAX(id)`」的写法是 N+1，在 `node:sqlite` 全同步 +
   *      Node 单线程下会直接反映到首屏上（与收藏夹 / 硬件台账同一条理由）。
   *      ⚠️ 未读数**不算自己发的消息**（`x.user_id <> ?`）：自己刚发完还顶着一个红点，
   *      是最容易被当成本应用有 bug 的那种表现。
   *      ⭐ 0.6.x 的**唯一例外**：内置角色（提醒助手）发的消息 `user_id` 也写会话归属者
   *      （= 我自己，见 `insertMessage` 的说明），所以判据是「不是我发的 **或** 是内置角色发的」
   *      —— 少了后半句，「提醒助手未读计入总数」（定案 6）会**静默失效**：
   *      服务端算出 0 条未读，红点永远不会亮，而不报任何错。
   *      ⚠️ 排序用冗余列 `last_message_id`（空会话排最后），不再对消息表做聚合。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 会话行数组（含 `last_read_id` / `unread` / `last_body` /
   *      `last_sender_id` / `last_created_at`，按最后一条消息倒序）
   */
  listConversations(uid) {
    const u = Number(uid);
    // ⭐ 0.7.7：五个子查询都要过「我清掉的那一段」这道闸（判据见 `clearedVisible()` 的说明）。
    //    「我」一律取外层成员行的 `m.user_id`（相关子查询引用外层列是合法的）⇒ 绑定参数仍只有两个 u。
    const vis = (alias) => clearedVisible(alias, 'm.user_id');
    return this._listSql(
      `SELECT c.*, m.last_read_id,
              (SELECT COUNT(*) FROM teamwork_messages x
                WHERE x.conversation_id = c.id AND x.id > COALESCE(m.last_read_id, 0)
                  AND (x.user_id <> ? OR x.sender_builtin IS NOT NULL) AND ${vis('x')}) AS unread,
              (SELECT y.body       FROM teamwork_messages y WHERE y.conversation_id = c.id AND ${vis('y')} ORDER BY y.id DESC LIMIT 1) AS last_body,
              (SELECT y.user_id    FROM teamwork_messages y WHERE y.conversation_id = c.id AND ${vis('y')} ORDER BY y.id DESC LIMIT 1) AS last_sender_id,
              (SELECT y.sender_builtin FROM teamwork_messages y WHERE y.conversation_id = c.id AND ${vis('y')} ORDER BY y.id DESC LIMIT 1) AS last_sender_builtin,
              (SELECT y.created_at FROM teamwork_messages y WHERE y.conversation_id = c.id AND ${vis('y')} ORDER BY y.id DESC LIMIT 1) AS last_created_at
         FROM teamwork_conversations c
         JOIN teamwork_members m ON m.conversation_id = c.id AND m.user_id = ?
        ORDER BY c.last_message_id DESC, c.id DESC`,
      [u, u],
    );
  },

  /**
   * 功能：找「我和某人之间已有的那一对一会话」；没有则为 null（开对话接口的**幂等**就靠它）。
   * @param {number} uid - 我
   * @param {number} friendId - 对方
   * @returns {?Object} 会话行；未命中为 null
   */
  findDirectConversation(uid, friendId) {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM teamwork_conversations c
             JOIN teamwork_members a ON a.conversation_id = c.id AND a.user_id = ?
             JOIN teamwork_members b ON b.conversation_id = c.id AND b.user_id = ?
            WHERE c.kind = 'direct'
            ORDER BY c.id ASC LIMIT 1`,
        )
        .get(Number(uid), Number(friendId)) || null
    );
  },

  /**
   * 功能：按 id 取一个会话行（**不带归属条件** —— 判权由调用方先 `isMember()` 做）。
   *
   * 说明：⚠️ 这是本模块与其它模块在写法上最大的不同：会话是**跨账号**的，
   *      「这行是不是你的」没有意义（它同时属于两个人），所以这里只按 id 取，
   *      而**「能不能看」一律由 `methods/teamwork.js` 先问 `isMember()`**。
   *
   * @param {number} cid - 会话 id
   * @returns {?Object} 会话行；不存在为 null
   */
  getConversation(cid) {
    return this.db.prepare('SELECT * FROM teamwork_conversations WHERE id=?').get(Number(cid)) || null;
  },

  /**
   * 功能：按 id 改写会话的若干列（**不带 `user_id` 条件**，理由见 `getConversation`）。
   * @param {number} cid - 会话 id
   * @param {Array.<string>} setKeys - 要写入的列名
   * @param {Array.<*>} values - 与 `setKeys` 一一对应的新值
   * @returns {boolean} 更新到行则为 true
   */
  updateConversation(cid, setKeys, values) {
    const sql = `UPDATE teamwork_conversations SET ${setKeys.map((k) => k + '=?').join(',')} WHERE id=?`;
    return this.db.prepare(sql).run(...values, Number(cid)).changes > 0;
  },

  /**
   * 功能：⭐ **判权核心** —— 该账号是不是这个会话的成员。
   *
   * 说明：本模块的每一条读、每一条写、每一次 SSE 推送范围，都以它为唯一判据
   *      （方案 §4.4 问题 1）。⚠️ **好友关系不构成读历史消息的权限**：
   *      删好友之后这个会话就不可读了（已批准的一期规则）。
   *
   * @param {number} uid - 用户 id
   * @param {number} cid - 会话 id
   * @returns {boolean} 是成员则为 true
   */
  isMember(uid, cid) {
    return !!this.db
      .prepare('SELECT id FROM teamwork_members WHERE user_id=? AND conversation_id=?')
      .get(Number(uid), Number(cid));
  },

  /**
   * 功能：列出某个会话的全部成员行（SSE 推送要按它确定「推给谁」）。
   * @param {number} cid - 会话 id
   * @returns {Array.<Object>} 成员行数组（按 id 升序）
   */
  listMembers(cid) {
    return this._listSql('SELECT * FROM teamwork_members WHERE conversation_id=? ORDER BY id ASC', [Number(cid)]);
  },

  /**
   * 功能：往会话里加一个成员；同一个人重复加入不会重复插入（唯一约束兜底）。
   * @param {number} uid - 用户 id
   * @param {number} cid - 会话 id
   * @param {string} stamp - 加入时间戳
   * @returns {boolean} 真的插入了新行则为 true
   */
  insertMember(uid, cid, stamp) {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO teamwork_members (user_id, conversation_id, last_read_id, joined_at) VALUES (?,?,0,?)',
      )
      .run(Number(uid), Number(cid), stamp);
    return r.changes > 0;
  },

  /**
   * 功能：取「我在这个会话里的成员行」（读已读游标用）；不是成员则为 null。
   * @param {number} uid - 用户 id
   * @param {number} cid - 会话 id
   * @returns {?Object} 成员行；未命中为 null
   */
  getMember(uid, cid) {
    return (
      this.db
        .prepare('SELECT * FROM teamwork_members WHERE user_id=? AND conversation_id=?')
        .get(Number(uid), Number(cid)) || null
    );
  },

  /**
   * 功能：把「我在这个会话里的已读游标」推进到指定消息 id（标记已读走它）。
   *
   * 说明：⚠️ 游标**只许前进**（`COALESCE(last_read_id,0) < ?`）：多端同时在线时，
   *      一端读到 100、另一端还在 50，若允许回退就会出现「已读红点去掉了又回来」。
   *
   * @param {number} uid - 用户 id
   * @param {number} cid - 会话 id
   * @param {number} lastReadId - 目标游标
   * @returns {boolean} 更新到行则为 true
   */
  updateMemberRead(uid, cid, lastReadId) {
    const r = this.db
      .prepare(
        'UPDATE teamwork_members SET last_read_id=? WHERE user_id=? AND conversation_id=? AND COALESCE(last_read_id,0) < ?',
      )
      .run(Number(lastReadId), Number(uid), Number(cid), Number(lastReadId));
    return r.changes > 0;
  },

  /**
   * 功能：按游标取一个会话的消息 —— `afterId` 给增量补齐（升序），否则取 `beforeId` 之前的历史（倒序）。
   *
   * 说明：⭐ 两种情况共用一条原语，但**排序方向刻意不同**：
   *      · `afterId`（断线补齐 / 轮询降级）要**升序**，直接按到达顺序合并即可；
   *      · 历史分页要**倒序取最近 N 条**（界面从下往上翻），由业务层再反转成展示顺序。
   *      ⚠️ 判权**不在这里**（这一层只做数据）：调用方必须先 `isMember()`。
   *
   * @param {number} cid - 会话 id
   * @param {?number} beforeId - 取比它更早的消息（历史分页）
   * @param {?number} afterId - 取比它更新的消息（增量补齐）
   * @param {number} limit - 条数上限（路由层已限到 200）
   * @param {number} uid - ⭐ 0.7.7：读者账号 id —— 可见性判据要按**他**清掉的那几段算
   *      （`before` / `after` **两个游标都服从**，否则「清空后往回翻又能翻出来」）
   * @returns {Array.<Object>} 消息行数组
   */
  listMessages(cid, beforeId, afterId, limit, uid) {
    const c = Number(cid);
    const n = Number(limit) || 50;
    const u = Number(uid) || 0;
    const vis = clearedVisible('m', '?');
    // ⭐ 0.8.12：显式列清单 —— ⛔ **永不 `SELECT m.*`**。
    //    本表 2g 起多了一列 `image`（整串 data URL），`m.*` 会把 base64 拖进每一次列表 /
    //    SSE 载荷（一页 50 条就是几十 MB）。所以这里**只回 `has_image`**（0/1），
    //    与 ai 那边 0.8.6 的定式逐字一致。⚠️ 两个后端必须同列同序。
    const cols =
      'm.id, m.user_id, m.conversation_id, m.body, m.sender_builtin, m.kind, m.meta, m.segment, ' +
      '(m.image IS NOT NULL) AS has_image, m.created_at';
    const after = Number(afterId) > 0 ? Number(afterId) : null;
    if (after !== null) {
      return this._listSql(
        `SELECT ${cols} FROM teamwork_messages m WHERE m.conversation_id=? AND m.id>? AND ${vis} ORDER BY m.id ASC LIMIT ?`,
        [c, after, u, n],
      );
    }
    const before = Number(beforeId) > 0 ? Number(beforeId) : null;
    if (before !== null) {
      return this._listSql(
        `SELECT ${cols} FROM teamwork_messages m WHERE m.conversation_id=? AND m.id<? AND ${vis} ORDER BY m.id DESC LIMIT ?`,
        [c, before, u, n],
      );
    }
    return this._listSql(
      `SELECT ${cols} FROM teamwork_messages m WHERE m.conversation_id=? AND ${vis} ORDER BY m.id DESC LIMIT ?`,
      [c, u, n],
    );
  },

  /**
   * 功能：写入一条消息，并**在同一个事务里**把会话的 `last_message_id` 推进到它；返回新消息行。
   *
   * 说明：⭐ 两件事必须一起成：只写消息不推 `last_message_id`，会话列表的排序就停了
   *      （新消息永远排不到最上面，而且不报任何错）。
   *      ⚠️ 这里有**两次写**却只有一条语句是「业务」—— 所以走显式事务，不用 `_insert`
   *      （`_insert` 是单行插入，无法覆盖会话那一行）。
   *
   * @param {number} uid - 发送者 id
   * @param {number} cid - 会话 id
   * @param {string} body - 消息正文（纯文本，长度已由 `validate.js` 把关）
   * @param {string} createdAt - 发送时间戳
   * @param {?string} [senderBuiltin] - 有值 = 这条是**内置角色**发的（0.6.x，方案 12）；
   *      普通消息传 `null` / 不传。⚠️ 即便如此，`user_id` 照样写**会话归属者** —— 不建虚拟账号
   *      （口令列 NOT NULL），未读/判权/推送那三套机制因此一行都不用改。
   * @param {?string} [kind] - 消息种类（0.6.4，任务联动）：`'task_card'` = 任务卡片；普通消息传 `null`。
   * @param {?string} [meta] - 卡片载荷（**已序列化好的 JSON 文本**，校验与序列化都在 `validate.js` 一处）；
   *      `kind` 为空时必须为空。⚠️ 这里**不解析**它：存储层不认识载荷的字段语义。
   * @returns {Object} 新消息行（带 `id`）
   */
  insertMessage(uid, cid, body, createdAt, senderBuiltin, kind, meta) {
    const u = Number(uid);
    const c = Number(cid);
    const from = senderBuiltin === undefined || senderBuiltin === null ? null : String(senderBuiltin);
    const k = kind === undefined || kind === null || kind === '' ? null : String(kind);
    const m = meta === undefined || meta === null || meta === '' ? null : String(meta);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db
        .prepare(
          'INSERT INTO teamwork_messages (user_id, conversation_id, body, sender_builtin, kind, meta, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(u, c, body, from, k, m, createdAt);
      const id = Number(r.lastInsertRowid);
      this.db.prepare('UPDATE teamwork_conversations SET last_message_id=?, updated_at=? WHERE id=?').run(id, createdAt, c);
      this.db.exec('COMMIT');
      return { id, user_id: u, conversation_id: c, body, sender_builtin: from, kind: k, meta: m, created_at: createdAt };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
  },

  /**
   * 功能：数一个会话里有多少条消息（个人导出与限流判定用）。
   * @param {number} cid - 会话 id
   * @returns {number} 消息条数
   */
  countMessages(cid) {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM teamwork_messages WHERE conversation_id=?').get(Number(cid));
    return (r && Number(r.n)) || 0;
  },

  /**
   * 功能：取一个会话里**最大**的消息 id（没有消息时为 0）—— 标记已读时用来**夹住游标**。
   *
   * 说明：⚠️ 这一条不是可选的：游标是**全局自增 id**（不是会话内序号），
   *      若原样接受客户端传来的 `lastReadId: 999999`，这个会话未来所有的消息都会被判成「已读」，
   *      而且**再也收不到未读红点** —— 用户只会觉得「这个功能时灵时不灵」。
   *
   * @param {number} cid - 会话 id
   * @returns {number} 该会话最大消息 id；没有消息为 0
   */
  maxMessageId(cid) {
    const r = this.db.prepare('SELECT MAX(id) AS n FROM teamwork_messages WHERE conversation_id=?').get(Number(cid));
    return (r && Number(r.n)) || 0;
  },

  // ---- 对话：个人备份要带出去的那一份（方案 §4.5）----
  /**
   * 功能：列出该账号**参与**的全部会话行（含别人的会话元信息，但**不含别人的消息**）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 会话行数组（按 id 升序）
   */
  listMyConversations(uid) {
    return this._listSql(
      `SELECT c.* FROM teamwork_conversations c
         JOIN teamwork_members m ON m.conversation_id = c.id AND m.user_id = ?
        ORDER BY c.id ASC`,
      [Number(uid)],
    );
  },

  /**
   * 功能：列出该账号在全部会话里的成员行（导出已读游标用）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 成员行数组
   */
  listMyMemberships(uid) {
    return this._listSql('SELECT * FROM teamwork_members WHERE user_id=? ORDER BY id ASC', [Number(uid)]);
  },

  /**
   * 功能：列出该账号**自己发出的**全部消息 —— ⚠️ **对方的消息一条都不许进导出**（方案 §4.5）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 消息行数组（按 id 升序）
   */
  listMyMessages(uid) {
    return this._listSql('SELECT * FROM teamwork_messages WHERE user_id=? ORDER BY id ASC', [Number(uid)]);
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（只带我这一侧的四张表）。
   *
   * 说明：⭐ 这是 0.5.0唯一新增的**新代码**：四条 SQL 与排序**逐字照抄**改造前
   *      `exportAll()` 里那几行，一个字都没重写（`teamworkMsgs` 那一条本来就只取我发出的消息）。
   *      ⚠️ **「只带我这一侧」是 的硬规矩**：好友关系（我发的与我收的都算我的关系行）、
   *      我参与的会话、我在各会话里的已读游标、以及**我发出的消息** ——
   *      **对方的消息一条都不许进来**（把别人的聊天内容装进我的备份文件，
   *      既超出「一人一份」的边界，也让「导出一下」变成泄露别人隐私的动作）。
   *      ⚠️ SQLite 版靠 `JOIN teamwork_members … AND m.user_id = ?` 一步取出「我参与的会话」；
   *      JSON 版没有 JOIN，得先算成员集合（见那边同名 op 的说明）。
   *      ⚠️ 四条语句的顺序与改造前 `exportAll()` 里逐字一致。
   *
   *      ⭐ 0.7.7：**第五个键 `teamworkCleared`**（我清掉了哪几段）。它是「我这一侧的读取状态」，
   *      与已经在导出里的 `teamworkMembers`（我的已读游标）是同一类东西 ——
   *      不带的话语义说不通（备份里带着我发出的消息，却不带「这些我已经清掉了」）。
   *      ⚠️ 它照样只带**我这一行**的记录，与另外四个键同一个过滤口径。
   *
   * @param {number} uid - 用户 id
   * @returns {{teamworkFriends: Array.<Object>, teamworkConvs: Array.<Object>,
   *      teamworkMembers: Array.<Object>, teamworkMsgs: Array.<Object>,
   *      teamworkCleared: Array.<Object>}} 备份里的那五个键
   */
  exportTeamwork(uid) {
    const teamworkFriends = this.db.prepare('SELECT * FROM teamwork_friendships WHERE user_id=? ORDER BY id ASC').all(uid);
    const teamworkConvs = this.db
      .prepare(
        `SELECT c.* FROM teamwork_conversations c
           JOIN teamwork_members m ON m.conversation_id = c.id AND m.user_id = ?
          ORDER BY c.id ASC`,
      )
      .all(uid);
    const teamworkMembers = this.db.prepare('SELECT * FROM teamwork_members WHERE user_id=? ORDER BY id ASC').all(uid);
    const teamworkMsgs = this.db.prepare('SELECT * FROM teamwork_messages WHERE user_id=? ORDER BY id ASC').all(uid);
    const teamworkCleared = this.db.prepare('SELECT * FROM teamwork_cleared WHERE user_id=? ORDER BY id ASC').all(uid);
    return { teamworkFriends, teamworkConvs, teamworkMembers, teamworkMsgs, teamworkCleared };
  },

  // ---- 内置角色会话与提醒（0.6.x，对话 2 期）----
  /**
   * 功能：取该账号的**内置角色会话**（`builtin_key` 命中的那一行）；没有则为 null。
   *
   * 说明：⭐ 内置会话是**懒创建**的（首次进对话页 / 首次发提醒时建），所以「没有」是常态、
   *      不是错误 —— 调用方（`teamworkEnsureBuiltinConversation()`）据此决定要不要建。
   *      ⚠️ 按 `user_id` 限定：每个账号**各自一条**（它是我和助手，不是跨账号数据）。
   *
   * @param {number} uid - 用户 id
   * @param {string} key - 内置角色标识（`'reminder'`）
   * @returns {?Object} 会话行；未命中为 null
   */
  findBuiltinConversation(uid, key) {
    return (
      this.db
        .prepare('SELECT * FROM teamwork_conversations WHERE user_id=? AND builtin_key=? ORDER BY id ASC LIMIT 1')
        .get(Number(uid), String(key)) || null
    );
  },

  /**
   * 功能：往提醒流水里写一行（**幂等记账**），撞唯一键时返回 null 表示「这个时刻已经发过」。
   *
   * 说明：⭐ ticker 一律**先调它、再发消息**：返回 null 就当场跳过。这样「服务重启不重发、
   *      两个 tick 撞在同一分钟也只发一条」是**数据库约束保证的**，不是靠先查后插
   *      （那中间有一个竞态窗口）。⚠️ 这也是「重启不补发历史」那条规矩的落点。
   *
   * @param {number} uid - 收件账号 id
   * @param {string} kind - 提醒类别（`'course'` / `'task_today'` / `'overdue_daily'`）
   * @param {string} refKey - 这件事的稳定标识（`'task:<id>'` / `'overdue:<日期>'` / `'course:<日期>:<课次id>'`）
   * @param {string} fireAt - **分钟级**触发时刻 `YYYY-MM-DD HH:MM`
   * @param {string} firedAt - 实际发出的时刻（`nowStamp()`）
   * @param {string} createdAt - 记账行创建时刻
   * @returns {?Object} 新插入的行（带 `id`）；已存在时返回 null
   */
  insertReminder(uid, kind, refKey, fireAt, firedAt, createdAt) {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO teamwork_reminders (user_id, kind, ref_key, fire_at, fired_at, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(Number(uid), String(kind), String(refKey), String(fireAt), firedAt, createdAt);
    if (!r.changes) return null;
    return {
      id: Number(r.lastInsertRowid),
      user_id: Number(uid),
      kind: String(kind),
      ref_key: String(refKey),
      fire_at: String(fireAt),
      fired_at: firedAt,
      created_at: createdAt,
    };
  },

  /**
   * 功能：列出该账号的**全部**提醒流水（按 id 升序）—— 给测试与探针核对「发过什么」。
   *
   * 说明：⚠️ 刻意不做时间过滤：调用方（`store` 的 `teamworkRemindersFor()`）拿它做断言与少量展示，
   *      真正的窄查询在 ticker 那边另走「当前分钟」这一条路。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 流水行数组（按 id 升序）
   */
  listReminders(uid) {
    return this._listSql('SELECT * FROM teamwork_reminders WHERE user_id=? ORDER BY id ASC', [Number(uid)]);
  },

  /**
   * 功能：清掉 `before` 之前的旧流水行，返回删掉的条数（默认保留 90 天，`tick` 里顺带清）。
   *
   * 说明：⭐ 流水是**运行态数据**（不进个人备份）：它的用处只有「这个时刻响过没有」，
   *      90 天前的记账不会再被任何判据读到 ⇒ 不清就是一张只涨不缩的表。
   *
   * @param {string} before - 早于这个时刻（`created_at` 字典序）的行都删掉
   * @returns {number} 实际删除的条数
   */
  purgeReminders(before) {
    const r = this.db.prepare('DELETE FROM teamwork_reminders WHERE created_at < ?').run(String(before));
    return Number(r.changes) || 0;
  },

  /**
   * 功能：取该账号的提醒偏好行；没有则为 null（缺省值由**业务层**给，见 `teamworkReminderPrefs()`）。
   *
   * 说明：⚠️ 这里**不兜默认值**：默认值只有一处（`modules/teamwork/store.js` 的 `REMINDER_PREFS_DEFAULT`），
   *      两个后端各抄一份迟早会不一致，而表现是「换了后端提醒时刻就变了」而且不报错。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 偏好行；未命中为 null
   */
  getReminderPrefs(uid) {
    return this.db.prepare('SELECT * FROM teamwork_reminder_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的提醒偏好**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 为什么是「整份写入」而不是逐列 patch：默认值住在业务层（`teamworkReminderPrefs()` 给的是
   *      合并过默认值的完整对象），调用方先读合并再整份写回 —— 于是「默认值」只有一处、
   *      两个后端也不必各自兜一套。⚠️ `PUT /api/teamwork/reminder-prefs` 的「带哪个键写哪个键」
   *      是在**路由/业务层**做的，不是靠这里放宽。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 恰好六个键：`enabled` / `course_lead_minutes` / `task_at` / `overdue_at` /
   *      `due_lead_minutes` / `builtin_name`
   * @param {string} stamp - 更新时间戳
   * @returns {Object} 写入后的偏好行（含 `id` / `user_id`）
   */
  upsertReminderPrefs(uid, values, stamp) {
    const u = Number(uid);
    // ⚠️ 这份列名清单与 `store.js` 的 `REMINDER_PREF_KEYS` 必须**逐字一致**（两边各留一份是刻意的：
    //    原语层不许 require 业务层常量）。漏一列的表现是「那个开关在界面上能点、但存不进去」。
    const cols = [
      'enabled',
      'course_lead_minutes',
      'task_at',
      'overdue_at',
      'due_lead_minutes',
      'care_enabled',
      'builtin_name',
    ];
    this.db
      .prepare(
        `INSERT INTO teamwork_reminder_prefs (user_id, ${cols.join(',')}, updated_at)
         VALUES (?, ${cols.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${cols.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...cols.map((k) => values[k]), stamp);
    // ⚠️ 这里**不能**写 `this.getReminderPrefs(u)`：op 里的 `this` 是 **Store 实例**，
    //    op 挂在 `ops` 表上、只能通过 `this._bk.xxx` 取到 —— 直接写是
    //    `this.getReminderPrefs is not a function`（原语层内部一律内联，与 json.js 的
    //    `updateMemberRead` 是同一条规矩）。
    return this.db.prepare('SELECT * FROM teamwork_reminder_prefs WHERE user_id=?').get(u) || null;
  },

  // ---- 好友设置（0.7.7）----
  /**
   * 功能：取该账号的好友设置行；没有则为 null（缺省值由**业务层**给，见 `teamworkFriendPrefs()`）。
   *
   * 说明：⚠️ 与 `getReminderPrefs()` 同一条规矩：**不兜默认值** ——
   *      默认值只有一处（`store.js` 的 `FRIEND_PREFS_DEFAULT`），两个后端各抄一份迟早不一致。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 设置行；未命中为 null
   */
  getFriendPrefs(uid) {
    return this.db.prepare('SELECT * FROM teamwork_friend_prefs WHERE user_id=?').get(Number(uid)) || null;
  },

  /**
   * 功能：把该账号的好友设置**整份写入**（一人一行，不存在则建），返回写入后的行。
   *
   * 说明：⭐ 与 `upsertReminderPrefs()` 同一手法（`ON CONFLICT(user_id) DO UPDATE`）。
   *      ⚠️ 列名清单与 `store.js` 的 `FRIEND_PREF_KEYS` 必须**逐字一致**（原语层不许 require
   *      业务层常量，两边各留一份是刻意的）—— 漏一列的表现是「那个开关能点、但存不进去」。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - 好友设置的键（目前只有 `auto_accept_friend`）
   * @param {string} stamp - 更新时间戳
   * @returns {Object} 写入后的设置行（含 `id` / `user_id`）
   */
  upsertFriendPrefs(uid, values, stamp) {
    const u = Number(uid);
    const cols = ['auto_accept_friend'];
    this.db
      .prepare(
        `INSERT INTO teamwork_friend_prefs (user_id, ${cols.join(',')}, updated_at)
         VALUES (?, ${cols.map(() => '?').join(',')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${cols.map((k) => `${k}=excluded.${k}`).join(', ')}, updated_at=excluded.updated_at`,
      )
      .run(u, ...cols.map((k) => values[k]), stamp);
    // ⚠️ 不能写 `this.getFriendPrefs(u)`：op 里的 `this` 是 Store 实例（见 `upsertReminderPrefs`）
    return this.db.prepare('SELECT * FROM teamwork_friend_prefs WHERE user_id=?').get(u) || null;
  },

  // ---- 聊天记录清理（0.7.7）----
  /**
   * 功能：列出该账号**全部**清理记录（按 id 升序）—— 回收站与可见性合并都读它。
   *
   * 说明：⚠️ **不做过期过滤**：`expires_at` 只决定「回收站里还显不显示」，
   *      而可见性判据（同一张表）必须对所有行一视同仁 —— 在这里筛掉过期行，
   *      等于让 30 天后被清掉的消息**全部复活**（见 `schema.js` 那张表的说明）。
   *      ⇒ 「只列未过期的」是**业务层**的事（`teamworkClearedList()`）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 清理记录行数组
   */
  listCleared(uid) {
    return this._listSql('SELECT * FROM teamwork_cleared WHERE user_id=? ORDER BY id ASC', [Number(uid)]);
  },

  /**
   * 功能：写一条清理记录（一次清理动作 = 一行），返回新行。
   * @param {Object} row - `{ user_id, conversation_id, from_message_id, to_message_id, msg_count, hidden_at, expires_at, created_at }`
   * @returns {Object} 新行（带 `id`）
   */
  insertCleared(row) {
    const r = this.db
      .prepare(
        `INSERT INTO teamwork_cleared (user_id, conversation_id, from_message_id, to_message_id, msg_count, hidden_at, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        Number(row.user_id),
        Number(row.conversation_id),
        Number(row.from_message_id),
        Number(row.to_message_id),
        Number(row.msg_count),
        String(row.hidden_at),
        String(row.expires_at),
        row.created_at === undefined || row.created_at === null ? null : String(row.created_at),
      );
    return {
      id: Number(r.lastInsertRowid),
      user_id: Number(row.user_id),
      conversation_id: Number(row.conversation_id),
      from_message_id: Number(row.from_message_id),
      to_message_id: Number(row.to_message_id),
      msg_count: Number(row.msg_count),
      hidden_at: String(row.hidden_at),
      expires_at: String(row.expires_at),
      created_at: row.created_at === undefined || row.created_at === null ? null : String(row.created_at),
    };
  },

  /**
   * 功能：删掉一条清理记录（= **恢复**那一段消息），返回是否真的删到了行。
   *
   * 说明：⭐⭐ **删这一行的唯一合法理由就是「用户点了恢复」** —— 行的存在 = 那段消息被隐藏，
   *      删掉 = 取消隐藏 = 消息复活。⛔ 绝不为「过期清理」去删它（那是把消息放回来），
   *      ⛔ 也不许在任何别的路径上删（比如删会话 / 删好友时顺手清一遍）。
   *      ⚠️ 带 `user_id=?`：只删得掉**我自己**那条记录（越权一律「没删到」）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 清理记录 id
   * @returns {boolean} 删到行则为 true
   */
  deleteCleared(uid, id) {
    const r = this.db.prepare('DELETE FROM teamwork_cleared WHERE id=? AND user_id=?').run(Number(id), Number(uid));
    return r.changes > 0;
  },

  /**
   * 功能：取一个会话里**落在某个时刻区间内**的消息 id 区间与条数。
   *
   * 说明：⭐ 判据是「**真实命中的 id 区间**」—— ⛔ 不许拿时间戳去比消息 id
   *      （`created_at` 是写入时刻、`id` 是自增序号，两者在并发 / 补写场景下会有偏差，
   *      自己换算出来的区间会静默多清或少清几条）。
   *      ⚠️ `fromAt` / `toAt` 为 null 表示这一端不限（= 清整个会话）。
   *      ⚠️ 时刻一律按**字符串字典序**比（与项目其余日期比较同一口径，不转 Date）。
   *
   * @param {number} cid - 会话 id
   * @param {?string} fromAt - 起始时刻（含，本地 `YYYY-MM-DD HH:MM:SS`）；null = 不限
   * @param {?string} toAt - 结束时刻（含）；null = 不限
   * @returns {{min: ?number, max: ?number, count: number}} 命中的最小 / 最大消息 id 与条数；一条都没有时 min/max 为 null
   */
  msgIdRange(cid, fromAt, toAt) {
    const c = Number(cid);
    const conds = ['conversation_id=?'];
    const args = [c];
    if (fromAt) {
      conds.push('created_at >= ?');
      args.push(String(fromAt));
    }
    if (toAt) {
      conds.push('created_at <= ?');
      args.push(String(toAt));
    }
    const r = this.db
      .prepare(`SELECT MIN(id) AS mn, MAX(id) AS mx, COUNT(*) AS n FROM teamwork_messages WHERE ${conds.join(' AND ')}`)
      .get(...args);
    const n = Number(r && r.n) || 0;
    return { min: n ? Number(r.mn) : null, max: n ? Number(r.mx) : null, count: n };
  },

  /**
   * 功能：数一个会话里 `id` 落在 `[fromId, toId]`（**含两端**）内的消息条数。
   *
   * 说明：⭐ 供「区间合并后**重算** `msg_count`」用 —— 合并的几条区间不能把条数相加
   *      （重叠部分会被算两遍，回收站上的「清了多少条」就变成一个假数字）。
   *
   * @param {number} cid - 会话 id
   * @param {number} fromId - 起始消息 id（含）
   * @param {number} toId - 结束消息 id（含）
   * @returns {number} 条数
   */
  countMessagesBetween(cid, fromId, toId) {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM teamwork_messages WHERE conversation_id=? AND id BETWEEN ? AND ?')
      .get(Number(cid), Number(fromId), Number(toId));
    return Number(r && r.n) || 0;
  },

  /**
   * 功能：把一个**即将注销**的账号在本模块里留下的东西收拾干净 —— 第一步：**会话先过户**。
   *
   * 说明：⭐ 为什么需要这一步（0.3.5，方案 §4.4 问题 3）：本模块是项目里唯一的**跨账号**数据，
   *      而「删账号要清空哪些表」这条机制是**按 `user_id` 列**工作的（`USER_SCOPED_TABLES`）。
   *      直接照章办事的后果是：由我创建、对方还在用的那个会话，会因为 `teamwork_conversations.user_id = 我`
   *      而被删掉 —— 对方面对的是「**整个会话没了**」，而方案承诺的只是「历史会话缺一段」
   *      （对方自己发的那些消息也不该跟着消失）。所以先把「还有别人在」的会话**过户**给留下的人。
   *
   * ⚠️ 过户必须在**成员行还被删之前**做 —— 成员行一旦清了就无从知道「会话里还有谁」。
   * ⚠️ 只认「会话里还有的别的成员」：没有任何别人的会话照旧被删（它会变成一条谁都打不开的孤岛）。
   *
   * ⭐ 0.8.12：本 op 与 `teamworkPurgeOnDelete` 是从
   * `core/store/backend/{sqlite,json}.js` 的 `deleteUser` 里**搬进来的**（既定的「散乱的全部收回」）——
   * 它们从此回到 `assertOpsContract()` 的覆盖范围内（少写一个后端当场启动即抛）。
   * 调用点是核心 `deleteUser` 的**可选钩子**（`typeof this.teamworkTransferOnDelete === 'function'`）。
   *
   * @param {number} uid - 即将注销的账号 id
   * @returns {void}
   */
  teamworkTransferOnDelete(uid) {
    const u = Number(uid);
    this.db
      .prepare(
        `UPDATE teamwork_conversations
            SET user_id = (SELECT m.user_id FROM teamwork_members m
                            WHERE m.conversation_id = teamwork_conversations.id AND m.user_id <> ?
                            ORDER BY m.user_id ASC LIMIT 1)
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM teamwork_members m2
                         WHERE m2.conversation_id = teamwork_conversations.id AND m2.user_id <> ?)`,
      )
      .run(u, u, u);
  },

  /**
   * 功能：删账号第二步 —— 好友补刀 ＋ 收拾**悬空引用**（本模块特有的两条收尾）。
   *
   * 说明：⚠️ **好友补刀不能省**：好友关系存**两行**，而通用清空按 `user_id` 只清掉「他→我」
   *      那一行，**「我→他」那一行会留在库里** —— 表现是别人的好友列表里还挂着一个已经
   *      不存在的账号（点开会话还会 404）。这一条不在 `userScoped` 的语义里，是本模块特有的。
   *
   * ⚠️ **清孤儿也不能省**，而且它是**顺序**上的必需品、不是「顺手清理」：`teamwork_members` /
   *      `teamwork_messages` 都是按 `user_id` 单列清空的，而会话行可能因为「创建者注销」整条消失；
   *      不留这一步就会在库里留下「指向不存在会话的消息」——它们永远显示不出来，
   *      却会跟着个人导出与整体备份一直搬来搬去（也就是永久残留）。
   *      最后一句把「一个成员都没有了的会话」也清掉，保证不会出现谁都打不开的孤岛。
   *
   * @param {number} uid - 即将注销的账号 id
   * @returns {void}
   */
  teamworkPurgeOnDelete(uid) {
    const u = Number(uid);
    this.db.prepare('DELETE FROM teamwork_friendships WHERE friend_id=?').run(u);
    this.db.prepare('DELETE FROM teamwork_members  WHERE conversation_id NOT IN (SELECT id FROM teamwork_conversations)').run();
    this.db.prepare('DELETE FROM teamwork_messages WHERE conversation_id NOT IN (SELECT id FROM teamwork_conversations)').run();
    this.db.prepare('DELETE FROM teamwork_conversations WHERE id NOT IN (SELECT conversation_id FROM teamwork_members)').run();
  },

  // ==== ⭐⭐ 0.8.12：协作原语（从 `modules/tasks/backend/sqlite.js` 整批搬来）====
  //    ⚠️ 这里**一条判权逻辑都没有**：本层只回答「表里有什么 / 删掉几行」，
  //    「谁能看 / 谁能写」全部住在 `../lib/collab.js` 的 `taskShareGuard()`（判据只准一处）。

  /**
   * 功能：列出「我是成员」的那些**共享项目**（不含我自己拥有的 —— 那些走 `listProjects`）。
   *
   * 说明：⭐ 判权在 SQL 里只做了**一半**（`project_members.user_id = 我`），另一半是
   *      「这个项目现在还共享着吗」（`p.shared = 1`）—— 两条都要，缺一条就会出现
   *      「项目关了共享、成员还看得见」。⚠️ 它**不是**判据的第二个副本：判据（`taskShareGuard`）
   *      仍然只有一处，这里只是「我有哪些共享项目」这一个列表的取数。
   *
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 项目行数组
   */
  listProjectsOfMember(uid) {
    return this._listSql(
      'SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id ' +
        'WHERE m.user_id = ? AND p.shared = 1 ORDER BY p.sort_order ASC, p.id ASC',
      [uid],
    );
  },

  /**
   * 功能：列出某个项目的成员行（谁先加进来排在前面）。
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 成员行数组
   */
  listProjectMembers(projectId) {
    return this._listSql('SELECT * FROM project_members WHERE project_id=? ORDER BY id ASC', [projectId]);
  },

  /**
   * 功能：把一个人移出项目；返回是否真的删掉了一行。
   * @param {number} projectId - 项目 id
   * @param {number} memberId - 被移出的人
   * @returns {boolean} 删到行则为 true
   */
  deleteProjectMember(projectId, memberId) {
    return (
      this.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, memberId).changes >
      0
    );
  },

  /**
   * 功能：清空某个项目的成员名单（删项目时连带），返回删掉的行数。
   * @param {number} projectId - 项目 id
   * @returns {number} 受影响的行数
   */
  deleteProjectMembersOfProject(projectId) {
    return this.db.prepare('DELETE FROM project_members WHERE project_id=?').run(projectId).changes;
  },

  /**
   * 功能：按「任务来源 + 一批任务 id」取上报（按时间正序，方便前端取「每人最新一条」）。
   *
   * 说明：⚠️ **必须同时给 `taskSource` 与 `taskId`**：日常任务与项目任务是两张表、
   *      id 都从 1 开始，只按 id 查会把两条毫不相干的任务混成一条时间线。
   *      ⚠️ 空 id 数组直接回空数组（`IN ()` 是 SQL 语法错，不是「查不到」）。
   *
   * @param {string} taskSource - `'project_tasks'` / `'daily_tasks'`
   * @param {Array.<number>} taskIds - 任务 id 数组
   * @returns {Array.<Object>} 上报行数组
   */
  listTaskReportsForTasks(taskSource, taskIds) {
    if (!Array.isArray(taskIds) || !taskIds.length) return [];
    const ph = taskIds.map(() => '?').join(',');
    return this._listSql(
      `SELECT * FROM task_reports WHERE task_source=? AND task_id IN (${ph}) ORDER BY created_at ASC, id ASC`,
      [String(taskSource), ...taskIds],
    );
  },

  /**
   * 功能：删除**我自己**的一条上报；返回是否真的删掉了一行。
   *
   * 说明：⚠️ 带 `user_id` 过滤是**判权的第二道保险**（第一道在 `taskShareGuard`）：
   *      删别人的上报永远删不到。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 上报 id
   * @returns {boolean} 删到行则为 true
   */
  deleteTaskReport(uid, id) {
    return this.db.prepare('DELETE FROM task_reports WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：清空一批任务上的上报（删项目 / 删项目任务时连带），返回删掉的行数。
   * @param {string} taskSource - `'project_tasks'` / `'daily_tasks'`
   * @param {Array.<number>} taskIds - 任务 id 数组
   * @returns {number} 受影响的行数
   */
  deleteTaskReportsOfTasks(taskSource, taskIds) {
    if (!Array.isArray(taskIds) || !taskIds.length) return 0;
    const ph = taskIds.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM task_reports WHERE task_source=? AND task_id IN (${ph})`).run(String(taskSource), ...taskIds).changes;
  },

  /**
   * 功能：列出某个项目的状态集（组内顺序在前、id 升序兜底）。
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 状态行数组
   */
  listCollabStates(projectId) {
    return this._listSql('SELECT * FROM collab_states WHERE project_id=? ORDER BY sort_order ASC, id ASC', [projectId]);
  },

  /**
   * 功能：按 id 取一个状态行，且**限定它属于这个项目**（⛔ 防止跨项目改 / 删）。
   * @param {number} projectId - 项目 id
   * @param {number} stateId - 状态 id
   * @returns {?Object} 状态行；不存在或不属于该项目时为 null
   */
  findCollabState(projectId, stateId) {
    return this.db.prepare('SELECT * FROM collab_states WHERE id=? AND project_id=?').get(stateId, projectId) || null;
  },

  /**
   * 功能：改一个状态行（只有调用方挑好的列进 SET），返回是否真的更新到。
   * @param {number} projectId - 项目 id
   * @param {number} stateId - 状态 id
   * @param {Object} patch - 列名 → 新值（键由业务层白名单挑好，见 `allowedCols.collab_states`）
   * @returns {boolean} 更新到行则为 true
   */
  updateCollabState(projectId, stateId, patch) {
    const keys = Object.keys(patch || {});
    if (!keys.length) return false;
    const sql = 'UPDATE collab_states SET ' + keys.map((k) => k + '=?').join(',') + ' WHERE id=? AND project_id=?';
    const r = this.db
      .prepare(sql)
      .run(...keys.map((k) => patch[k]), Number(stateId), Number(projectId));
    return r.changes > 0;
  },

  /**
   * 功能：删一个状态行（限定属于该项目），返回是否真的删掉了一行。
   * @param {number} projectId - 项目 id
   * @param {number} stateId - 状态 id
   * @returns {boolean} 删到行则为 true
   */
  deleteCollabState(projectId, stateId) {
    return this.db.prepare('DELETE FROM collab_states WHERE id=? AND project_id=?').run(stateId, projectId).changes > 0;
  },

  /**
   * 功能：把项目**过户**给另一个账号 —— 改 `projects.user_id` 与它名下全部 `project_tasks.user_id`。
   *
   * 说明：⚠️⭐ 为什么任务行的 `user_id` 也要跟着改：`project_tasks.user_id` 是**项目所有者**
   *      （语义见），而看板/任务列表都是按 `user_id + project_id` 读的
   *      （`listProjectTasks`）—— 只改 projects 会让新所有者**读不到任何任务**。
   *      ⭐「已设的负责人（`assignee_id`）全不变、成员名单一行不动」是本原语的硬约束：
   *      这里只碰 `user_id` 两处，`assignee_id` / `project_members` 一个字都不动。
   *      ⚠️ 判权（只有所有者能转让、目标必须是成员）在业务层做，本层只执行。
   *      ⭐ 0.8.12：本 op 是**协作专属**（只有 `collabTransfer()` 调），随协作搬进本模块 ——
   *      它写的是 `tasks` 的两张地基表（`projects` / `project_tasks`），这是**原语层**，
   *      与「业务层只走公开方法」是两回事（见方案 §丙-2-9-④）。
   *
   * @param {number} projectId - 项目 id
   * @param {number} newOwnerId - 新所有者账号 id
   * @returns {boolean} 项目存在且过户成功则为 true
   */
  transferProject(projectId, newOwnerId) {
    const pid = Number(projectId);
    const nid = Number(newOwnerId);
    const r = this.db.prepare('UPDATE projects SET user_id=? WHERE id=?').run(nid, pid);
    if (!r.changes) return false;
    this.db.prepare('UPDATE project_tasks SET user_id=? WHERE project_id=?').run(nid, pid);
    return true;
  },

  /**
   * 功能：列出一个项目的**全部评论**（项目级 ＋ 任务级），按时间正序。
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 评论行数组
   */
  listProjectComments(projectId) {
    return this._listSql('SELECT * FROM project_comments WHERE project_id=? ORDER BY created_at ASC, id ASC', [projectId]);
  },

  /**
   * 功能：按 id 直接取一条评论（不管归属）—— 删除前要拿它判「作者是谁 / 属于哪个项目」。
   * @param {number} id - 评论 id
   * @returns {?Object} 评论行；不存在时为 null
   */
  findCommentById(id) {
    return this.db.prepare('SELECT * FROM project_comments WHERE id=?').get(id) || null;
  },

  /**
   * 功能：删除**我自己**的一条评论（并**连带删掉这条评论的附件**：文件行 ＋ 磁盘文件）；
   *      返回是否真的删掉了一行。
   *
   * 说明：⚠️ 带 `user_id` 过滤是**判权的第二道保险**（第一道在业务层）：删别人的评论永远删不到
   *      （连项目所有者也不行，/ 105）。
   *      ⭐ 0.8.12：评论没了，挂在它下面的附件也没有意义 —— 与「删任务 / 删项目连带」
   *      同一条口径（见 `deleteTaskCollabData`）。⚠️ 只删 `comment_id` 等于这条评论的，
   *      同任务的其他附件（`comment_id` 为空 / 指别处）一个字不动。
   *
   * @param {number} id - 评论 id
   * @param {number} userId - 必须是作者
   * @returns {boolean} 删到行则为 true
   */
  deleteComment(id, userId) {
    const r = this.db.prepare('DELETE FROM project_comments WHERE id=? AND user_id=?').run(id, userId);
    if (r.changes > 0) {
      const files = this.db.prepare('SELECT * FROM project_files WHERE comment_id=?').all(id);
      files.forEach((f) => removeFileDisk(this.dataDir, f));
      this.db.prepare('DELETE FROM project_files WHERE comment_id=?').run(id);
    }
    return r.changes > 0;
  },

  /**
   * 功能：列出**我写过的**全部评论（进个人备份那一份读取）。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 评论行数组（按项目、id 升序）
   */
  listCommentsOfAuthor(uid) {
    return this._listSql('SELECT * FROM project_comments WHERE user_id=? ORDER BY project_id ASC, id ASC', [uid]);
  },

  /**
   * 功能：列出某个项目的**全部附件**（项目级 ＋ 任务级），按时间正序。
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 附件行数组
   */
  listProjectFiles(projectId) {
    return this._listSql('SELECT * FROM project_files WHERE project_id=? ORDER BY created_at ASC, id ASC', [projectId]);
  },

  /**
   * 功能：列出**全库**附件行（整体备份打包 / 启动孤儿巡检用），按项目、id 升序。
   * @returns {Array.<Object>} 附件行数组
   */
  listAllProjectFiles() {
    return this._listSql('SELECT * FROM project_files ORDER BY project_id ASC, id ASC', []);
  },

  /**
   * 功能：按 id 直接取一行附件（不管归属）—— 下载 / 删除前要拿它判「属于哪个项目、谁传的」。
   * @param {number} id - 附件 id
   * @returns {?Object} 附件行；不存在时为 null
   */
  findFileById(id) {
    return this.db.prepare('SELECT * FROM project_files WHERE id=?').get(id) || null;
  },

  /**
   * 功能：删除一行附件记录（按 id）；返回是否真的删掉了一行。
   *
   * 说明：⚠️ 判权（是不是成员 / 上传者或所有者）在业务层做，本层只删 —— 磁盘文件由业务层
   *      `collabRemoveFile()` 一起清掉。
   * @param {number} id - 附件 id
   * @returns {boolean} 删到行则为 true
   */
  deleteFile(id) {
    return this.db.prepare('DELETE FROM project_files WHERE id=?').run(id).changes > 0;
  },

  /**
   * 功能：给 `task_reports` 的老行补 `project_id`（按 `task_id` 反查 `project_tasks.project_id`）。
   *
   * 说明：⭐ **只补一列，老行一个字不改**—— 这不是改写用户数据，是多出一份可读的历史。
   *      ⚠️ 幂等判据钉在 `project_id IS NULL` 上：补过的行不再进这条语句，跑几次结果一样；
   *      找不到对应任务的行（`task_id` 悬空）**保持 NULL**（不猜、不硬塞）。
   *      ⚠️ 只处理 `task_source='project_tasks'`：日常任务没有项目，本就该一直 NULL。
   *
   * @returns {number} 受影响的行数
   */
  backfillReportProjects() {
    const r = this.db
      .prepare(
        `UPDATE task_reports
            SET project_id = (SELECT project_id FROM project_tasks WHERE project_tasks.id = task_reports.task_id)
          WHERE project_id IS NULL AND task_source = 'project_tasks'`,
      )
      .run();
    return r.changes;
  },

  /**
   * 功能：把某个项目里「负责人文本名」按**精确匹配** `users.username` 补成 `assignee_id`。
   *
   * 说明：⚠️ **匹配不上不改写**（保留原文、`assignee_id` 留 NULL）—— 手输的、已改名的、
   *      指向不存在的人，一律不认领（界面上标「未认领」，兜底「视为没有负责人」）。
   *      ⚠️ 幂等判据钉在 `assignee_id IS NULL` 上；`EXISTS` 保证匹配不上的行不进 `changes`
   *      （失败方向安全，也避免把 NULL 写成 NULL 的空改动算进去）。
   *      ⭐ 0.8.12：本 op 是**协作专属**（只有 `_migrateCollabProject()` 调），随协作搬进本模块 ——
   *      它写的是 `tasks` 的 `project_tasks.assignee_id`（原语层，见方案 §丙-2-9-④）。
   *
   * @param {number} projectId - 项目 id
   * @returns {number} 受影响的行数
   */
  backfillProjectAssignees(projectId) {
    const r = this.db
      .prepare(
        `UPDATE project_tasks
            SET assignee_id = (SELECT id FROM users WHERE users.username = project_tasks.assignee)
          WHERE project_id = ? AND assignee_id IS NULL AND assignee IS NOT NULL AND assignee != ''
            AND EXISTS (SELECT 1 FROM users WHERE users.username = project_tasks.assignee)`,
      )
      .run(Number(projectId));
    return r.changes;
  },

  /**
   * 功能：老库上把 `task_reports.status` 的那条窄 CHECK 去掉 —— ⭐ **同一张表的原地重建**
   *      （搬数据 + 行数守恒，⛔ 不是新建同义表；**不动 `SCHEMA_VERSION`**）。
   *
   * 说明：⭐⭐ 0.8.12 · 2d 把 `task_reports` 改造成「活动流水」后，`status` 落的是**项目自定义
   *      状态键**（`backlog` / `done` / `cancelled` / 用户自建的 `s1` …），而老 DDL 上的
   *      `CHECK (status IN ('todo','doing','blocked','done'))` 会把「改到 `backlog`」这种正常
   *      状态变更**当场挡下**（写流水撞约束、变 500）。新库的 DDL 已无这条 CHECK（见 `schema.js`），
   *      老库靠这条幂等重建补上。
   *      ⚠️ 判据钉在 `sqlite_master.sql` 里有没有 `CHECK (status IN` 上：去掉之后不再进这条语句，
   *      跑几次结果一样。⚠️ 建表用**本模块的 DDL**（`TEAMWORK_SCHEMA`），单一出处、不手抄列。
   *      ⚠️ 重建会丢掉这张表的索引 ⇒ 结尾把两条索引补回来（启动期的建索引只在启动跑一次）。
   *
   * @returns {boolean} 是否真的重建了（已经是新结构则 false）
   */
  ensureReportFlowSchema() {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_reports'").get();
    const ddl = row && row.sql ? String(row.sql) : '';
    if (!ddl.includes('CHECK (status IN')) return false;
    const tmp = 'task_reports__flow';
    this.db.exec(`DROP TABLE IF EXISTS ${tmp}`);
    this.db.exec(TEAMWORK_SCHEMA.tables.task_reports(tmp, false));
    // 只搬两边都有的列（新表新增的列交给 DEFAULT，此处无新增列）
    const oldCols = this.db.prepare('PRAGMA table_info(task_reports)').all().map((c) => c.name);
    const newCols = new Set(this.db.prepare(`PRAGMA table_info(${tmp})`).all().map((c) => c.name));
    const list = oldCols
      .filter((c) => newCols.has(c))
      .map((c) => `"${c}"`)
      .join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.exec(`INSERT INTO ${tmp} (${list}) SELECT ${list} FROM task_reports`);
      // 行数必须一致 —— 少一条都是数据事故，宁可不改（抛出去，由事务回滚）
      const before = Number(this.db.prepare('SELECT COUNT(*) AS n FROM task_reports').get().n);
      const after = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${tmp}`).get().n);
      if (before !== after) throw new Error(`task_reports 重建前后行数不一致：${before} → ${after}`);
      this.db.exec('DROP TABLE task_reports');
      this.db.exec(`ALTER TABLE ${tmp} RENAME TO task_reports`);
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e2) {
        /* 已经回滚 / 没有活动事务：忽略 */
      }
      throw e;
    }
    // 重建丢了这张表上的索引 ⇒ 补回来（与 schema.js 的 indexStatements 同名同参）。
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_treports_task ON task_reports(task_source, task_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_treports_project ON task_reports(project_id)');
    return true;
  },

  /**
   * 功能：删项目时**连带清协作那张公共数据**（状态配置 / 评论 / 附件行 ＋ 磁盘目录）—— 删项目连带的一处出口。
   *
   * 说明：⭐⭐ 0.8.12：这五张表搬进本模块后，`tasks` 的 `deleteProject()` 不能再自己拼表名去删
   *      （那会把 teamwork 的表名抄进 tasks）。它改成在项目行真被删掉时经 `_bk` 调本 op ——
   *      表名 / 磁盘布局只在本模块一处。⚠️ 顺序与原实现一致：先清库里三类行，再删整个
   *      `<project_id>` 目录（一次到位，不必逐条算路径）。
   *      ⚠️ **不判权**：调用方（`tasks/backend/*.js` 的 `deleteProject`）已保证「项目行真被删掉」。
   *
   * @param {number} projectId - 项目 id
   * @returns {void}
   */
  deleteProjectCollabData(projectId) {
    const id = Number(projectId);
    this.db.prepare('DELETE FROM collab_states WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM project_comments WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM project_files WHERE project_id=?').run(id);
    removeProjectDir(this.dataDir, id);
  },

  /**
   * 功能：删项目任务时**连带清它的任务级协作数据**（评论行 / 附件行 ＋ 磁盘文件）—— 删任务连带的一处出口。
   *
   * 说明：⭐⭐ 0.8.12：与 `deleteProjectCollabData` 同一条理由 —— 表名与磁盘布局只在本模块一处。
   *      ⚠️ 项目级评论（`task_id` 为 NULL）与同任务其他附件（`comment_id` 指别处）一个字不动。
   *      ⚠️ 顺序与原实现一致：先清评论行，再取附件行（拿 id 算磁盘路径）、删文件、删行。
   *
   * @param {number} taskId - 项目任务 id
   * @returns {void}
   */
  deleteTaskCollabData(taskId) {
    const id = Number(taskId);
    this.db.prepare('DELETE FROM project_comments WHERE task_id=?').run(id);
    const files = this.db.prepare('SELECT * FROM project_files WHERE task_id=?').all(id);
    files.forEach((f) => removeFileDisk(this.dataDir, f));
    this.db.prepare('DELETE FROM project_files WHERE task_id=?').run(id);
  },

  // ==== 0.8.12：AI 助手会话并进对话两张表 —— 存量搬迁 ＋ 内置聊天原语 ====

  /**
   * 功能：把存量 AI 会话从 `ai_chats` / `ai_messages` **一次性搬迁**进 `teamwork_conversations`
   *      （`builtin_key = 'ai'`）/ `teamwork_messages` —— 先体检、整份事务、幂等、老表保留。
   *
   * 说明：⭐⭐ 四条安全规矩（方案 §乙-7，照/ 25 的口径）——
   *      ① **先体检**：`ai_messages` 有没有指向不存在会话的**孤儿行** · `role` 值是否合法；
   *      ② **整份在一个事务里**：体检不过 ⇒ 整份放弃（返回 `abort`），**一行数据都不动**；
   *      ③ **幂等判据 =「新表里已有 `builtin_key='ai'` 的会话」** —— 会话行与它的全部消息、
   *         以及这个「已完成」的结果**在同一个事务里提交** ⇒ 看见会话行就等价于「搬完了」；
   *      ④ ⚠️ **老表 `ai_chats` / `ai_messages` 保留、不再写**（降级回旧包的退路）——
   *         ⛔ 本 op 里一句 `DROP` / `DELETE` 老表都没有（搬迁是「多出一份可读的历史」）。
   *
   * 映射（方案 §乙-7 表）：`ai_chats.user_id/title/cur_segment` 原样；`ai_messages.content` -> `body`、
   *      `role='assistant'` -> `sender_builtin='ai'`、`role='user'` -> `sender_builtin=NULL`、
   *      `user_id` -> **收件人自己**（= `ai_chats.user_id`）、`kind`/`meta`/`segment`/`image`/`created_at` 原样。
   *
   * @returns {{status: string, migrated: number, conversations: number, reason: string}}
   *      `status`：`done` 真搬了 / `skip` 没什么可搬或已搬过 / `abort` 体检不过整份放弃
   */
  migrateAiChatSessions() {
    // ③ 幂等判据：新表里已有内置 AI 会话 ⇒ 认为「搬完了」（会话行与它的消息同事务提交）
    const marker = this.db.prepare("SELECT id FROM teamwork_conversations WHERE builtin_key='ai' LIMIT 1").get();
    if (marker) return { status: 'skip', migrated: 0, conversations: 0, reason: 'already' };
    let chats;
    try {
      chats = this.db.prepare('SELECT * FROM ai_chats ORDER BY id ASC').all();
    } catch (_e) {
      return { status: 'skip', migrated: 0, conversations: 0, reason: 'no-old-table' };
    }
    if (!chats.length) return { status: 'skip', migrated: 0, conversations: 0, reason: 'empty' };
    // ① 体检（不过 ⇒ 整份放弃，一行不动）
    let orphan;
    let badRole;
    try {
      orphan = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM ai_messages m LEFT JOIN ai_chats c ON c.id = m.chat_id WHERE c.id IS NULL',
        )
        .get();
      badRole = this.db
        .prepare("SELECT COUNT(*) AS n FROM ai_messages WHERE role IS NULL OR role NOT IN ('user','assistant')")
        .get();
    } catch (_e) {
      return { status: 'skip', migrated: 0, conversations: 0, reason: 'no-old-table' };
    }
    if (Number(orphan.n) > 0) return { status: 'abort', migrated: 0, conversations: 0, reason: 'orphan' };
    if (Number(badRole.n) > 0) return { status: 'abort', migrated: 0, conversations: 0, reason: 'role' };
    const stamp = nowStamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let migratedMsgs = 0;
      let migratedConvs = 0;
      for (const c of chats) {
        const owner = Number(c.user_id);
        const title = c.title == null || String(c.title).trim() === '' ? 'AI 助手' : String(c.title);
        const ins = this.db
          .prepare(
            'INSERT INTO teamwork_conversations (user_id, kind, title, builtin_key, cur_segment, last_message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            owner,
            'direct',
            title,
            'ai',
            c.cur_segment == null ? null : Number(c.cur_segment),
            0,
            c.created_at == null ? stamp : String(c.created_at),
            c.updated_at == null ? stamp : String(c.updated_at),
          );
        const cid = Number(ins.lastInsertRowid);
        this.db
          .prepare('INSERT OR IGNORE INTO teamwork_members (user_id, conversation_id, last_read_id, joined_at) VALUES (?,?,0,?)')
          .run(owner, cid, stamp);
        const msgs = this.db.prepare('SELECT * FROM ai_messages WHERE chat_id=? ORDER BY id ASC').all(Number(c.id));
        let last = 0;
        for (const m of msgs) {
          const sb = m.role === 'assistant' ? 'ai' : null;
          const r2 = this.db
            .prepare(
              'INSERT INTO teamwork_messages (user_id, conversation_id, body, kind, meta, sender_builtin, segment, image, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
            )
            .run(
              owner,
              cid,
              m.content == null ? '' : String(m.content),
              m.kind == null ? null : String(m.kind),
              m.meta == null ? null : String(m.meta),
              sb,
              m.segment == null ? null : Number(m.segment),
              m.image == null ? null : String(m.image),
              m.created_at == null ? stamp : String(m.created_at),
            );
          last = Number(r2.lastInsertRowid);
          migratedMsgs += 1;
        }
        if (last) this.db.prepare('UPDATE teamwork_conversations SET last_message_id=? WHERE id=?').run(last, cid);
        migratedConvs += 1;
      }
      this.db.exec('COMMIT');
      return { status: 'done', migrated: migratedMsgs, conversations: migratedConvs, reason: '' };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e2) {
        /* 已经回滚 / 没有活动事务：忽略 */
      }
      throw e;
    }
  },

  /**
   * 功能：往**内置助手会话**（AI 助手那条 `teamwork_messages`）追加一条消息，返回 `{ id }`。
   * 说明：与 `insertMessage` 同一手法（消息 + 会话 `last_message_id` 一个事务），但多带
   *      `segment` / `image` 两列（2g 新增）。`senderBuiltin` 有值 = 这条是助手说的（`'ai'`）。
   * @param {number} uid - 收件人（= 会话归属者）
   * @param {number} cid - 会话 id
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
    const u = Number(uid);
    const c = Number(cid);
    const from = senderBuiltin === undefined || senderBuiltin === null ? null : String(senderBuiltin);
    const k = kind === undefined || kind === null || kind === '' ? null : String(kind);
    const m = meta === undefined || meta === null || meta === '' ? null : String(meta);
    const img = image === undefined || image === null ? null : String(image);
    const seg = segment === undefined || segment === null ? null : Number(segment);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db
        .prepare(
          'INSERT INTO teamwork_messages (user_id, conversation_id, body, sender_builtin, kind, meta, image, segment, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(u, c, body, from, k, m, img, seg, createdAt);
      const id = Number(r.lastInsertRowid);
      this.db.prepare('UPDATE teamwork_conversations SET last_message_id=?, updated_at=? WHERE id=?').run(id, createdAt, c);
      this.db.exec('COMMIT');
      return { id };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e2) {
        /* 已经回滚：忽略 */
      }
      throw e;
    }
  },

  /**
   * 功能：按游标取内置助手会话的消息（**id 降序**、`beforeId` 往前翻），只回 `has_image`。
   * @param {number} uid - 收件人
   * @param {number} cid - 会话 id
   * @param {?number} beforeId - 游标；null = 从最新开始
   * @param {number} limit - 条数上限
   * @param {?number} segment - 只取这一段；null = 全部
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listBuiltinChatMessages(uid, cid, beforeId, limit, segment) {
    // ⭐ 0.8.12：AI 会话的读口也要过「我清掉的那一段」这道闸
    //    —— 与好友会话 / 提醒助手共用同一条 `clearedVisible()` 判据（唯一出处）。
    const conds = ['m.conversation_id=?', 'm.user_id=?', clearedVisible('m', '?')];
    const args = [Number(cid), Number(uid), Number(uid)];
    if (beforeId) {
      conds.push('m.id<?');
      args.push(Number(beforeId));
    }
    if (segment) {
      conds.push('COALESCE(m.segment, 1)=?');
      args.push(Number(segment));
    }
    return this._listSql(
      `SELECT m.id, m.user_id, m.conversation_id, m.body, m.sender_builtin, m.kind, m.meta, m.segment, (m.image IS NOT NULL) AS has_image, m.created_at FROM teamwork_messages m WHERE ${conds.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
      args.concat([Number(limit) || 50]),
    );
  },

  /**
   * 功能：数内置助手会话**某一段**里的消息条数（开新段的幂等判据 / `truncated` 判据）。
   * @param {number} uid - 收件人
   * @param {number} cid - 会话 id
   * @param {number} segment - 段号
   * @returns {number} 条数
   */
  countBuiltinChatMessagesInSegment(uid, cid, segment) {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM teamwork_messages WHERE conversation_id=? AND user_id=? AND COALESCE(segment, 1)=?')
      .get(Number(cid), Number(uid), Number(segment));
    return Number(r.n);
  },

  /**
   * 功能：取内置助手会话**某一段**的最近 `limit` 条消息（**id 降序**，调用方再反转）。
   * @param {number} uid - 收件人
   * @param {number} cid - 会话 id
   * @param {number} segment - 段号
   * @param {number} limit - 条数上限
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listBuiltinChatContext(uid, cid, segment, limit) {
    // ⭐ 0.8.12：喂模型的上下文同样不该带「我已经清掉的那一段」。
    return this._listSql(
      `SELECT m.id, m.body, m.sender_builtin, m.kind, m.meta, m.segment, m.created_at FROM teamwork_messages m WHERE m.conversation_id=? AND m.user_id=? AND COALESCE(m.segment, 1)=? AND ${clearedVisible('m', '?')} ORDER BY m.id DESC LIMIT ?`,
      [Number(cid), Number(uid), Number(segment), Number(uid), Number(limit) || 20],
    );
  },

  /**
   * 功能：取内置助手会话里的**一条**消息（确认卡状态流转用；判权带 `user_id` + `conversation_id`）。
   * @param {number} uid - 收件人
   * @param {number} cid - 会话 id
   * @param {number} id - 消息 id
   * @returns {?Object} 消息行；不是自己的 / 不存在为 null
   */
  getBuiltinChatMessage(uid, cid, id) {
    return (
      this.db
        .prepare(
          'SELECT id, body, sender_builtin, kind, meta, segment, (image IS NOT NULL) AS has_image, created_at FROM teamwork_messages WHERE id=? AND conversation_id=? AND user_id=?',
        )
        .get(Number(id), Number(cid), Number(uid)) || null
    );
  },

  /**
   * 功能：改内置助手会话里一条消息的 `meta`（确认卡状态写回），返回影响行数。
   * @param {number} uid - 收件人
   * @param {number} cid - 会话 id
   * @param {number} id - 消息 id
   * @param {string} meta - 新的快照 JSON 文本
   * @returns {number} 影响行数
   */
  setBuiltinChatMessageMeta(uid, cid, id, meta) {
    const r = this.db
      .prepare('UPDATE teamwork_messages SET meta=? WHERE id=? AND conversation_id=? AND user_id=?')
      .run(String(meta), Number(id), Number(cid), Number(uid));
    return Number(r.changes);
  },

  /**
   * 功能：取内置助手会话里一条消息的**图片**（显示路由专用；判权带 `user_id` + `conversation_id`）。
   * @param {number} uid - 收件人
   * @param {number} cid - 会话 id
   * @param {number} id - 消息 id
   * @returns {?string} 整串 data URL；不是自己的 / 不存在 / 没有图 ⇒ null
   */
  getBuiltinChatMessageImage(uid, cid, id) {
    const row = this.db
      .prepare('SELECT image FROM teamwork_messages WHERE id=? AND conversation_id=? AND user_id=?')
      .get(Number(id), Number(cid), Number(uid));
    const s = row && row.image != null ? String(row.image) : '';
    return s || null;
  },

  /**
   * 功能：把内置助手会话的**当前段号**写成 `segment`；返回是否改到了行。
   * @param {number} cid - 会话 id
   * @param {number} segment - 新段号
   * @returns {boolean} 改到为 true
   */
  setBuiltinChatSegment(cid, segment) {
    const r = this.db.prepare('UPDATE teamwork_conversations SET cur_segment=? WHERE id=?').run(Number(segment), Number(cid));
    return r.changes > 0;
  },
};

module.exports = { ops };
