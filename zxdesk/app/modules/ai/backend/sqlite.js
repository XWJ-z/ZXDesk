'use strict';

/**
 * modules/ai/backend/sqlite.js —— ai辅助任务（接口配置 / AI 会话 / AI 消息）的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * ⚠️ 本层**只做数据**，权限判断不在这一层 —— 但每个读写 op 都带 `uid` 参数，
 *    让 methods 层能先判归属再操作（「先判权、后取数」是硬约束）。
 *    ⚠️ `ai_configs` 一行一个账号（`UNIQUE(user_id)`），所以这里的读写都**不带 id 参数**、
 *    直接按 `user_id` 定位 —— 配置没有「别人的配置 id」这种东西可越权。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.9.5
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、docs/公共/开发方案/14-AI辅助任务-2期.md
 */

const ops = {
  // ---- AI 辅助任务（0.6.0）----
  /**
   * 功能：取该账号的 AI 接口配置行；没配过返回 null。
   *
   * 说明：⚠️ 返回的是**整行**（含 key 密文三列）—— 读密文三列的只有两个地方：
   *      「keySet 是否齐全」的推导（`store.js` 的 `aiGetConfigView`）与出网前解 key。
   *      HTTP 读接口只回视图字段，**永远不会把这行原样吐给浏览器**。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 配置行；未配置为 null
   */
  getAiConfig(uid) {
    return this.db.prepare('SELECT * FROM ai_configs WHERE user_id=?').get(uid) || null;
  },

  /**
   * 功能：为该账号插入一行 AI 接口配置（**每账号一行**，调用方保证先查过没有）。
   * @param {number} uid - 用户 id
   * @param {{base_url: string, model: string, enabled: number, key_iv: ?string,
   *          key_cipher: ?string, key_tag: ?string, stamp: string}} f - 字段与时间戳
   * @returns {void}
   */
  insertAiConfig(uid, f) {
    this.db
      .prepare(
        'INSERT INTO ai_configs (user_id, base_url, model, enabled, key_iv, key_cipher, key_tag, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(uid, f.base_url, f.model, f.enabled ? 1 : 0, f.key_iv, f.key_cipher, f.key_tag, f.stamp, f.stamp);
  },

  /**
   * 功能：更新该账号的 AI 接口配置的**指定列**，返回是否更新到了行。
   *
   * 说明：⚠️ `setKeys` 的合法集由 `modules/ai/store.js` 的**硬映射**收口
   *      （patch 键 → 列名，映射表外的键根本进不来），本层不再重复校验 ——
   *      两道闸各管一件事：store 管「哪些列合法」，这里管「只改这一行、只改这些列」。
   *
   * @param {number} uid - 用户 id
   * @param {Array.<string>} setKeys - 要写的列名（已过 store 层白名单）
   * @param {Array.<*>} values - 与 setKeys 一一对应的值
   * @returns {boolean} 行存在且更新了为 true
   */
  updateAiConfig(uid, setKeys, values) {
    const set = setKeys.map((k) => `${k}=?`).join(', ');
    const r = this.db.prepare(`UPDATE ai_configs SET ${set} WHERE user_id=?`).run(...values, uid);
    return r.changes > 0;
  },

  /**
   * 功能：取该账号的 AI 会话行；还没建过返回 null。
   * @param {number} uid - 用户 id
   * @returns {?Object} `ai_chats` 行；没有为 null
   */
  getAiChat(uid) {
    return this.db.prepare('SELECT * FROM ai_chats WHERE user_id=?').get(uid) || null;
  },

  /**
   * 功能：为该账号插入 AI 会话（**每账号一条**，调用方保证先查过没有），返回新会话 id。
   * @param {number} uid - 用户 id
   * @param {{title: string, stamp: string}} f - 标题与时间戳
   * @returns {number} 新会话 id
   */
  insertAiChat(uid, f) {
    const r = this.db
      .prepare('INSERT INTO ai_chats (user_id, title, created_at, updated_at) VALUES (?,?,?,?)')
      .run(uid, f.title, f.stamp, f.stamp);
    return Number(r.lastInsertRowid);
  },

  /**
   * 功能：往自己的 AI 会话里追加一条消息，返回新消息 id；顺手把会话的 `updated_at` 顶到现在。
   *
   * 说明：⭐ 2 期多一个 `segment` 形参（对话分段）—— 段号由调用方
   *      （`store.js` 的 `aiAppendMessage`）算好，本层只管写。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id（调用方已判过归属）
   * @param {string} role - 'user' | 'assistant'（CHECK 约束兜底）
   * @param {string} content - 消息内容
   * @param {number} segment - 对话段号（2 期；调用方给实值）
   * @param {string} stamp - 时间戳
   * @param {?string} [kind] - ⭐ 0.7.7-⑲：消息种类（NULL = 普通消息；`'task_proposal'` = 确认卡）
   * @param {?string} [meta] - ⭐ 0.7.7-⑲：卡片快照 JSON 文本（普通消息为 NULL）
   * @returns {number} 新消息 id
   */
  insertAiMessage(uid, chatId, role, content, segment, stamp, kind, meta, image) {
    const r = this.db
      .prepare(
        'INSERT INTO ai_messages (user_id, chat_id, role, content, segment, kind, meta, image, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        uid,
        chatId,
        role,
        content,
        segment,
        kind == null ? null : String(kind),
        meta == null ? null : String(meta),
        // ⭐ 0.8.6：图片（整串 data URL；`null` = 没有图）。⚠️ 与 JSON 版**同参同序** ——
        //    两侧 op 加载时会比对，漏一处 = 启动即抛。
        image == null ? null : String(image),
        stamp,
      );
    this.db.prepare('UPDATE ai_chats SET updated_at=? WHERE user_id=?').run(stamp, uid);
    return Number(r.lastInsertRowid);
  },

  /**
   * 功能：按游标翻页取会话消息（**id 降序**、`beforeId` 往前翻）；判权带 `user_id`。
   *
   * 说明：⚠️ 调用方要 `limit + 1` 条来判断 `hasMore` —— 本层只管按条件取，不做第二层语义。
   *      ⭐ 2 期：`segment` 读出来**归一成 1**（`COALESCE`）—— 老行的 NULL 语义就是「第 1 段」，
   *      但**绝不把 1 写回数据**（可空列的语义保持一致）；JSON 后端做同一件事，两边逐字段相同。
   *      ⚠️ `segment` 为空 = **不带段过滤（返回全部）** —— 这是「不带 `?segment=` 就返回全部」
   *      那条口径的落点（理由见 `routes.js` 里 messages 那一段）。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {?number} beforeId - 游标（取 id 小于它的）；null = 从最新开始
   * @param {number} limit - 条数上限
   * @param {?number} segment - 只取这一段；null = 全部
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listAiMessages(uid, chatId, beforeId, limit, segment) {
    const conds = ['chat_id=?', 'user_id=?'];
    const args = [chatId, uid];
    if (beforeId) {
      conds.push('id<?');
      args.push(beforeId);
    }
    if (segment) {
      conds.push('COALESCE(segment, 1)=?');
      args.push(Number(segment));
    }
    return this.db
      .prepare(
        // ⚠️⭐ 显式列清单（不是 `SELECT *`）：0.7.7-⑲ 加 `kind` / `meta` 时**两个后端一起加** ——
        //    漏一个的表现是「换个后端卡片就消失」，只坏一个后端的 bug 最难查（0.7.6 栽过一次）。
        //    ⭐ 0.8.6：图片**只回「有没有」**（`(image IS NOT NULL) AS has_image`），
        //    ⛔ **绝不把 `image` 那一列选出来** —— 它是整串 data URL，一页 50 条就是几十 MB。
        `SELECT id, role, content, COALESCE(segment, 1) AS segment, kind, meta, (image IS NOT NULL) AS has_image, created_at FROM ai_messages WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit);
  },

  /**
   * 功能：数会话里 id 小于 `beforeId` 的消息条数（翻页的 `hasMore` 判据用）。
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {?number} beforeId - 游标；null = 数全部
   * @returns {number} 条数
   */
  countAiMessages(uid, chatId, beforeId) {
    if (beforeId) {
      const r = this.db
        .prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE chat_id=? AND user_id=? AND id<?')
        .get(chatId, uid, beforeId);
      return Number(r.n);
    }
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE chat_id=? AND user_id=?').get(chatId, uid);
    return Number(r.n);
  },

  /**
   * 功能：取**自己的**一条对话消息（`teamwork_messages`，指挥 AI 建任务的原料），返回原文；不是自己的 / 不存在返回 null。
   *
   * 说明：⭐ 判权就在这条 SQL 里（`user_id=?`）：AI 因此**读不到任何别人的数据**。
   *      ⚠️ **跨模块读的是单库里的另一张表**（不拆库；`depends: []` 的边界是
   *      「不 require 对方代码」，不是「不读同库的表」—— 方案 §八-2 点名的就是 `teamwork_messages`）。
   *      ⚠️ **try/catch 包住**：对话模块被删掉后这张表不存在，读它会抛 ——
   *      那种情形下按「这条消息不存在」处理（404），绝不能让 ai 模块因为别人被删而 500。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 对话消息 id
   * @returns {?Object} `{ id, body, created_at }`；不存在 / 不是自己的 / 表不存在为 null
   */
  getChatMessageForAi(uid, id) {
    try {
      return (
        this.db.prepare('SELECT id, body, created_at FROM teamwork_messages WHERE id=? AND user_id=?').get(id, uid) || null
      );
    } catch (_e) {
      return null; // 对话模块被删（表不存在）—— 按「不存在」处理，与越权同体
    }
  },

  // ---- AI 辅助任务 2 期：对话分段 · 记忆 ----
  /**
   * 功能：取该会话的**当前段号** —— 读会话行上的 `cur_segment`（NULL / 没有会话 ⇒ **1**）。
   *
   * 说明：⚠️ 段号**必须从会话行读**，不能拿「消息里最大的 segment」推：用户点了「开启新对话」
   *      之后、还没发第一条消息时，新段一条消息都没有 —— 只看消息表就会退回旧段，
   *      表现是「明明开了新对话，AI 还记得上一段」。
   *      ⚠️ **不写数据**（NULL 不归一成 1 写回去，保持可空列语义）；老库的会话行补出来是 NULL ⇒ 1。
   *
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id（0 = 不按 id 核对，直接用该账号唯一的那行会话）
   * @returns {number} 当前段号（≥ 1）
   */
  currentAiSegment(uid, chatId) {
    const cid = Number(chatId) || 0;
    const chat = cid
      ? this.db.prepare('SELECT cur_segment FROM ai_chats WHERE user_id=? AND id=?').get(uid, cid)
      : this.db.prepare('SELECT cur_segment FROM ai_chats WHERE user_id=?').get(uid);
    return chat && chat.cur_segment ? Number(chat.cur_segment) : 1;
  },

  /**
   * 功能：把该账号会话行的**当前段号**写成 `segment`；返回是否改到了行（会话不存在 ⇒ false）。
   * @param {number} uid - 用户 id
   * @param {number} segment - 新段号
   * @returns {boolean} 改到为 true
   */
  setAiChatSegment(uid, segment) {
    const r = this.db.prepare('UPDATE ai_chats SET cur_segment=? WHERE user_id=?').run(Number(segment), uid);
    return r.changes > 0;
  },

  /**
   * 功能：数**某一段**里的消息条数（`aiNewSegment` 的幂等判据 / 上下文裁剪的 truncated 判据）。
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {number} segment - 段号（NULL 语义由本层归一成 1）
   * @returns {number} 条数
   */
  countAiMessagesInSegment(uid, chatId, segment) {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE chat_id=? AND user_id=? AND COALESCE(segment, 1)=?')
      .get(chatId, uid, Number(segment));
    return Number(r.n);
  },

  /**
   * 功能：取某一段的**最近** `limit` 条消息（**id 降序**，调用方再反转成时间正序）。
   * @param {number} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {number} segment - 段号
   * @param {number} limit - 条数上限
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listAiContextMessages(uid, chatId, segment, limit) {
    return this.db
      .prepare(
        // ⚠️ `kind` / `meta` 必须带出来：`aiContextWindow()` 要在**注入模型前**把确认卡降级成一句话
        //    （⛔ 不能把 meta 的 JSON 原样喂回去 —— 见 store.js 那边的说明）。
        'SELECT id, role, content, COALESCE(segment, 1) AS segment, kind, meta, created_at FROM ai_messages WHERE chat_id=? AND user_id=? AND COALESCE(segment, 1)=? ORDER BY id DESC LIMIT ?',
      )
      .all(chatId, uid, Number(segment), limit);
  },

  /**
   * 功能：取该账号的**一条** AI 消息（判权带 `user_id`）—— 确认卡的状态流转要用。
   * @param {number} uid - 用户 id
   * @param {number} id - 消息 id
   * @returns {?Object} 消息行（含 `kind` / `meta`）；不是自己的 / 不存在为 null
   */
  getAiMessage(uid, id) {
    return (
      this.db
        .prepare('SELECT id, role, content, COALESCE(segment, 1) AS segment, kind, meta, created_at FROM ai_messages WHERE id=? AND user_id=?')
        .get(Number(id), uid) || null
    );
  },

  /**
   * 功能：取该账号**一条消息的图片**（显示路由专用；判权带 `user_id`）。
   *
   * 说明：⭐ 与 `getAiMessage` **刻意分成两个 op**：列表 / 上下文 / 单条那三处⛔ **永不选 `image`**
   *      （它是整串 data URL），只有这条显示路由会读它 —— 分开才挡得住「后人顺手把 image 加进
   *      `listAiMessages` 的列清单」这种事（那一次改动的代价是整个列表暴涨）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 消息 id
   * @returns {?string} 整串 data URL；不是自己的 / 不存在 / 这条没有图 ⇒ null（调用方一律回 404）
   */
  getAiMessageImage(uid, id) {
    const row = this.db
      .prepare('SELECT image FROM ai_messages WHERE id=? AND user_id=?')
      .get(Number(id), uid);
    const s = row && row.image != null ? String(row.image) : '';
    return s || null;
  },

  /**
   * 功能：改**自己的**一条 AI 消息的 `meta`（确认卡状态写回），返回影响行数。
   * @param {number} uid - 用户 id
   * @param {number} id - 消息 id
   * @param {string} meta - 新的快照 JSON 文本
   * @returns {number} 影响行数
   */
  setAiMessageMeta(uid, id, meta) {
    const r = this.db.prepare('UPDATE ai_messages SET meta=? WHERE id=? AND user_id=?').run(String(meta), Number(id), uid);
    return Number(r.changes);
  },

  /**
   * 功能：取该账号的全部记忆（`sort_no ASC, id ASC` —— 列表与注入取前 N 条都按这个序）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 记忆行
   */
  listAiMemories(uid) {
    return this.db
      .prepare(
        // ⚠️⭐ 这是**显式列清单**（不是 `SELECT *`）：漏一列的表现是「换个后端就好、而这个后端静默少字段」——
        //    0.7.6 就栽在这儿：漏了 `label` ⇒ 界面上的记忆名称永远空白、注入给 AI 的记忆也永远只有正文。
        //    ⛔ 加列时**两个后端一起看**（`backend/json.js` 的 `listAiMemories` 是另一份手抄清单）。
        'SELECT id, label, content, source, sort_no, created_at, updated_at FROM ai_memories WHERE user_id=? ORDER BY sort_no ASC, id ASC',
      )
      .all(uid);
  },

  /**
   * 功能：插入一条记忆，返回新 id。
   *
   * 说明：⚠️ `content` 是**用户内容**（明文落库，它不是密钥）；**内容绝不进日志**。
   *
   * @param {number} uid - 用户 id
   * @param {string} content - 记忆正文
   * @param {string} source - 来源（2 期恒为 'manual'）
   * @param {number} sortNo - 排序位
   * @param {?string} label - ⭐ 0.7.1：这一条的名称（`null` = 没有名称；空串由 store 层归一成 null）
   * @param {string} stamp - 时间戳
   * @returns {number} 新记忆 id
   */
  insertAiMemory(uid, content, source, sortNo, label, stamp) {
    const r = this.db
      .prepare(
        'INSERT INTO ai_memories (user_id, label, content, source, sort_no, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(uid, label, content, source, sortNo, stamp, stamp);
    return Number(r.lastInsertRowid);
  },

  /**
   * 功能：改**自己的**一条记忆的指定列，返回**影响行数**（别人的 / 不存在 ⇒ 0，**不抛错**）。
   *
   * 说明：⚠️ `fields` 的键必须是**列名**，它的合法集由 `modules/ai/store.js` 的**硬映射**收口
   *      （patch 键 → 列名，映射表外的键根本进不来）—— 本层的 `SET` 是拼出来的，
   *      所以「谁负责收窄键」这条必须清楚：store 管合法集，这里管「只改这一行、只改这些列」。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 记忆 id
   * @param {Object} fields - 列名 → 新值
   * @param {string} stamp - 时间戳（写进 `updated_at`）
   * @returns {number} 影响行数（0 = 没这条 / 不是自己的）
   */
  updateAiMemory(uid, id, fields, stamp) {
    const keys = Object.keys(fields || {});
    const set = keys.concat(['updated_at']).map((k) => `${k}=?`).join(', ');
    const values = keys.map((k) => fields[k]).concat([stamp]);
    const r = this.db.prepare(`UPDATE ai_memories SET ${set} WHERE id=? AND user_id=?`).run(...values, id, uid);
    return Number(r.changes);
  },

  /**
   * 功能：删**自己的**一条记忆，返回影响行数（别人的 / 不存在 ⇒ 0）。
   * @param {number} uid - 用户 id
   * @param {number} id - 记忆 id
   * @returns {number} 影响行数
   */
  deleteAiMemory(uid, id) {
    const r = this.db.prepare('DELETE FROM ai_memories WHERE id=? AND user_id=?').run(id, uid);
    return Number(r.changes);
  },

  /**
   * 功能：清空该账号的全部记忆，返回删除条数（0 条也算成功 —— 幂等）。
   * @param {number} uid - 用户 id
   * @returns {number} 删除条数
   */
  clearAiMemories(uid) {
    const r = this.db.prepare('DELETE FROM ai_memories WHERE user_id=?').run(uid);
    return Number(r.changes);
  },
};

module.exports = { ops };
