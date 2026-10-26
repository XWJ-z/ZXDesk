'use strict';

/**
 * modules/ai/backend/json.js —— ai辅助任务（接口配置 / AI 会话 / AI 消息）的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * ⚠️ 本层**只做数据**，权限判断不在这一层 —— 但每个读写 op 都带 `uid` 参数，
 *    让 methods 层能先判归属再操作（「先判权、后取数」是硬约束）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、docs/公共/开发方案/14-AI辅助任务-2期.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

/**
 * 功能：把一行的 `segment` 归一成段号（`null` / `undefined` → **1**）——「NULL 视为第 1 段」的唯一落点。
 *
 * 说明：⚠️ **只归一读出来的值，绝不写回数据**（可空列的语义保持一致）；SQLite 版对应用 `COALESCE`。
 *
 * @param {*} v - 原始列值
 * @returns {number} 段号（≥ 1）
 */
const seg1 = (v) => (v == null ? 1 : Number(v));

const ops = {
  // ---- AI 辅助任务（0.6.0）----
  /**
   * 功能：取该账号的 AI 接口配置行；没配过返回 null。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} 配置行；未配置为 null
   */
  getAiConfig(uid) {
    return (this.data.ai_configs || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：为该账号插入一行 AI 接口配置（**每账号一行**，调用方保证先查过没有）。
   *
   * 说明：⚠️ id 用 JSON 后端的**全局自增序列** `data._seq`（与全部表同一发号器，不按表各发各的）。
   *      ⚠️⭐ 这里必须写 `this.data._seq` —— 0.6.x（2 期）修的一处既有笔误：原先写的是
   *      `this._seq`（Store 上没有这个属性）⇒ 发出来的 id 是 `undefined`、写完 `undefined + 1` 变 NaN。
   *      SQLite 后端走 rowid、`getAiConfig` 又只按 `user_id` 找，所以这个错**一直没露出来**；
   *      2 期的分段与消息路径按 id 排序/核对，JSON 后端第一次跑就被它咬住（见 ttt/test/ai.test.js
   *      的「两个后端同一批用例」）。其它模块的 JSON 后端一律是 `this.data._seq`，与它们对齐。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {{base_url: string, model: string, enabled: number, key_iv: ?string,
   *          key_cipher: ?string, key_tag: ?string, stamp: string}} f - 字段与时间戳
   * @returns {void}
   */
  insertAiConfig(uid, f) {
    const row = {
      id: this.data._seq,
      user_id: Number(uid),
      base_url: f.base_url,
      model: f.model,
      enabled: f.enabled ? 1 : 0,
      key_iv: f.key_iv,
      key_cipher: f.key_cipher,
      key_tag: f.key_tag,
      created_at: f.stamp,
      updated_at: f.stamp,
    };
    this.data._seq += 1;
    (this.data.ai_configs = this.data.ai_configs || []).push(row);
    this._saveJson();
  },

  /**
   * 功能：更新该账号的 AI 接口配置的**指定列**，返回是否更新到了行。
   *
   * 说明：⚠️ `setKeys` 的合法集由 `modules/ai/store.js` 的**硬映射**收口，本层不再重复校验。
   *      ⚠️ 与 SQLite 版**逐字段同语义**：行不存在返回 false（调用方保证先 `insertAiConfig`）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {Array.<string>} setKeys - 要写的列名（已过 store 层白名单）
   * @param {Array.<*>} values - 与 setKeys 一一对应的值
   * @returns {boolean} 行存在且更新了为 true
   */
  updateAiConfig(uid, setKeys, values) {
    const row = (this.data.ai_configs || []).find((r) => uidOf(r) === Number(uid));
    if (!row) return false;
    setKeys.forEach((k, i) => {
      row[k] = values[i];
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：取该账号的 AI 会话行；还没建过返回 null。
   * @param {(number|string)} uid - 用户 id
   * @returns {?Object} `ai_chats` 行；没有为 null
   */
  getAiChat(uid) {
    return (this.data.ai_chats || []).find((r) => uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：为该账号插入 AI 会话（**每账号一条**，调用方保证先查过没有），返回新会话 id。
   * @param {(number|string)} uid - 用户 id
   * @param {{title: string, stamp: string}} f - 标题与时间戳
   * @returns {number} 新会话 id
   */
  insertAiChat(uid, f) {
    const row = { id: this.data._seq, user_id: Number(uid), title: f.title, created_at: f.stamp, updated_at: f.stamp };
    this.data._seq += 1;
    (this.data.ai_chats = this.data.ai_chats || []).push(row);
    this._saveJson();
    return row.id;
  },

  /**
   * 功能：往自己的 AI 会话里追加一条消息，返回新消息 id；顺手把会话的 `updated_at` 顶到现在。
   *
   * 说明：⚠️ 与 SQLite 版**逐字段同语义**（id 都由后端发号；`ai_chats.updated_at` 一起动）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {number} chatId - 会话 id（调用方已判过归属）
   * @param {string} role - 'user' | 'assistant'
   * @param {string} content - 消息内容
   * @param {number} segment - 对话段号（2 期，方案 14；调用方给实值）
   * @param {string} stamp - 时间戳
   * @param {?string} [kind] - ⭐ 0.7.7-⑲：消息种类（NULL = 普通消息；`'task_proposal'` = 确认卡）
   * @param {?string} [meta] - ⭐ 0.7.7-⑲：卡片快照 JSON 文本（普通消息为 NULL）
   * @returns {number} 新消息 id
   */
  insertAiMessage(uid, chatId, role, content, segment, stamp, kind, meta, image) {
    const row = {
      id: this.data._seq,
      user_id: Number(uid),
      chat_id: Number(chatId),
      role,
      content,
      // ⭐ 2 期：段号**原样存**（与 SQLite 版同语义 —— 调用方给的一定是数字，NULL 语义只对老数据有效）
      segment,
      // ⭐ 0.7.7-⑲：与 SQLite 版同形状（`null` = 普通消息）—— 两边都要有，漏一个就只坏一个后端
      kind: kind == null ? null : String(kind),
      meta: meta == null ? null : String(meta),
      // ⭐ 0.8.6：图片（整串 data URL；`null` = 没有图）—— 与 SQLite 版同参同序
      image: image == null ? null : String(image),
      created_at: stamp,
    };
    this.data._seq += 1;
    (this.data.ai_messages = this.data.ai_messages || []).push(row);
    const chat = (this.data.ai_chats || []).find((r) => uidOf(r) === Number(uid));
    if (chat) chat.updated_at = stamp;
    this._saveJson();
    return row.id;
  },

  /**
   * 功能：按游标翻页取会话消息（**id 降序**、`beforeId` 往前翻）；判权带 `user_id`。
   *
   * 说明：⭐ 2 期：`segment` 读出来**归一成 1**（`seg1()`），**不写回数据**；`segment` 为空
   *      = 不带段过滤（返回全部）。与 SQLite 版（`COALESCE`）逐字段同语义。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {?number} beforeId - 游标（取 id 小于它的）；null = 从最新开始
   * @param {number} limit - 条数上限
   * @param {?number} segment - 只取这一段；null = 全部
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listAiMessages(uid, chatId, beforeId, limit, segment) {
    const u = Number(uid);
    const cid = Number(chatId);
    const seg = segment ? Number(segment) : null;
    let rows = (this.data.ai_messages || []).filter(
      (r) => uidOf(r) === u && r.chat_id === cid && (!seg || seg1(r.segment) === seg),
    );
    if (beforeId) rows = rows.filter((r) => r.id < Number(beforeId));
    rows.sort((a, b) => b.id - a.id);
    return rows
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        segment: seg1(r.segment),
        // ⭐ 0.7.7-⑲：`kind` / `meta` 与 SQLite 版逐字段同名同语义（老行没有这两个键 ⇒ 归一成 null）
        kind: r.kind == null ? null : r.kind,
        meta: r.meta == null ? null : r.meta,
        // ⭐ 0.8.6：图片**只回「有没有」**（与 SQLite 版的 `(image IS NOT NULL) AS has_image` 同语义、
        //    同 0 / 1 取值），⛔ **绝不回 base64** —— 那会让整个会话列表暴涨。
        has_image: r.image == null || r.image === '' ? 0 : 1,
        created_at: r.created_at,
      }));
  },

  /**
   * 功能：数会话里 id 小于 `beforeId` 的消息条数（翻页的 `hasMore` 判据用）。
   * @param {(number|string)} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {?number} beforeId - 游标；null = 数全部
   * @returns {number} 条数
   */
  countAiMessages(uid, chatId, beforeId) {
    const u = Number(uid);
    const cid = Number(chatId);
    return (this.data.ai_messages || []).filter(
      (r) => uidOf(r) === u && r.chat_id === cid && (!beforeId || r.id < Number(beforeId)),
    ).length;
  },

  /**
   * 功能：取**自己的**一条对话消息（`teamwork_messages`），返回原文；不是自己的 / 不存在 / 表不存在返回 null。
   *
   * 说明：判权口径与 SQLite 版逐字一致（`user_id` 必须是自己）；
   *      ⚠️ 对话模块被删时 `data.teamwork_messages` 根本没有 —— 按「不存在」处理（同体 404）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {number} id - 对话消息 id
   * @returns {?Object} `{ id, body, created_at }`；取不到为 null
   */
  getChatMessageForAi(uid, id) {
    const list = this.data.teamwork_messages || [];
    const row = list.find((r) => r && Number(r.id) === Number(id) && uidOf(r) === Number(uid));
    return row ? { id: row.id, body: row.body, created_at: row.created_at } : null;
  },

  // ---- AI 辅助任务 2 期：对话分段 · 记忆 ----
  /**
   * 功能：取该会话的**当前段号** —— 读会话行上的 `cur_segment`（NULL / 没有会话 ⇒ **1**）。
   *
   * 说明：⚠️ 与 SQLite 版逐字段同语义：段号从**会话行**读，不从「消息里最大的 segment」推
   *      （点了「开启新对话」还没发消息时，新段一条消息都没有）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {number} chatId - 会话 id（0 = 不按 id 核对）
   * @returns {number} 当前段号（≥ 1）
   */
  currentAiSegment(uid, chatId) {
    const u = Number(uid);
    const cid = Number(chatId) || 0;
    const chat = (this.data.ai_chats || []).find(
      (r) => uidOf(r) === u && (!cid || Number(r.id) === cid),
    );
    return chat && chat.cur_segment ? Number(chat.cur_segment) : 1;
  },

  /**
   * 功能：把该账号会话行的**当前段号**写成 `segment`；返回是否改到了行（会话不存在 ⇒ false）。
   * @param {(number|string)} uid - 用户 id
   * @param {number} segment - 新段号
   * @returns {boolean} 改到为 true
   */
  setAiChatSegment(uid, segment) {
    const u = Number(uid);
    const chat = (this.data.ai_chats || []).find((r) => uidOf(r) === u);
    if (!chat) return false;
    chat.cur_segment = Number(segment);
    this._saveJson();
    return true;
  },

  /**
   * 功能：数**某一段**里的消息条数（幂等判据 / truncated 判据）。
   * @param {(number|string)} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {number} segment - 段号
   * @returns {number} 条数
   */
  countAiMessagesInSegment(uid, chatId, segment) {
    const u = Number(uid);
    const cid = Number(chatId);
    const seg = Number(segment);
    return (this.data.ai_messages || []).filter(
      (r) => uidOf(r) === u && Number(r.chat_id) === cid && seg1(r.segment) === seg,
    ).length;
  },

  /**
   * 功能：取某一段的**最近** `limit` 条消息（**id 降序**，调用方再反转成时间正序）。
   * @param {(number|string)} uid - 用户 id
   * @param {number} chatId - 会话 id
   * @param {number} segment - 段号
   * @param {number} limit - 条数上限
   * @returns {Array.<Object>} 消息行（id 降序）
   */
  listAiContextMessages(uid, chatId, segment, limit) {
    const u = Number(uid);
    const cid = Number(chatId);
    const seg = Number(segment);
    const rows = (this.data.ai_messages || []).filter(
      (r) => uidOf(r) === u && Number(r.chat_id) === cid && seg1(r.segment) === seg,
    );
    rows.sort((a, b) => b.id - a.id);
    return rows
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        segment: seg1(r.segment),
        // ⚠️ `kind` / `meta` 必须带出来：注入模型前要把确认卡降级成一句话（见 store.js）
        kind: r.kind == null ? null : r.kind,
        meta: r.meta == null ? null : r.meta,
        created_at: r.created_at,
      }));
  },

  /**
   * 功能：取该账号的**一条** AI 消息（判权带 `user_id`）—— 确认卡的状态流转要用。
   * @param {(number|string)} uid - 用户 id
   * @param {number} id - 消息 id
   * @returns {?Object} 消息行（含 `kind` / `meta`）；不是自己的 / 不存在为 null
   */
  getAiMessage(uid, id) {
    const row = (this.data.ai_messages || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    if (!row) return null;
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      segment: seg1(row.segment),
      kind: row.kind == null ? null : row.kind,
      meta: row.meta == null ? null : row.meta,
      created_at: row.created_at,
    };
  },

  /**
   * 功能：取该账号**一条消息的图片**（显示路由专用；判权带 `user_id`）。
   *
   * 说明：⭐ 与 `getAiMessage` **刻意分成两个 op** —— 列表 / 上下文 / 单条那三处⛔ 永不选 `image`，
   *      只有这条显示路由会读它（与 SQLite 版同语义：不是自己的 / 不存在 / 没图 ⇒ null）。
   *
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 消息 id
   * @returns {?string} 整串 data URL；不是自己的 / 不存在 / 这条没有图 ⇒ null
   */
  getAiMessageImage(uid, id) {
    const row = (this.data.ai_messages || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    const s = row && row.image != null ? String(row.image) : '';
    return s || null;
  },

  /**
   * 功能：改**自己的**一条 AI 消息的 `meta`（确认卡状态写回），返回影响行数。
   * @param {(number|string)} uid - 用户 id
   * @param {number} id - 消息 id
   * @param {string} meta - 新的快照 JSON 文本
   * @returns {number} 影响行数（0 或 1）
   */
  setAiMessageMeta(uid, id, meta) {
    const row = (this.data.ai_messages || []).find((r) => uidOf(r) === Number(uid) && Number(r.id) === Number(id));
    if (!row) return 0;
    row.meta = String(meta);
    this._saveJson();
    return 1;
  },

  /**
   * 功能：取该账号的全部记忆（`sort_no ASC, id ASC`）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 记忆行
   */
  listAiMemories(uid) {
    const u = Number(uid);
    const rows = (this.data.ai_memories || []).filter((r) => uidOf(r) === u);
    rows.sort((a, b) => a.sort_no - b.sort_no || a.id - b.id);
    return rows.map((r) => ({
      id: r.id,
      // ⭐ 0.7.1：名称一并带出 —— ⚠️ **两个后端都是「显式字段清单」**（本文件一行行抄，
      //    `backend/sqlite.js` 的 `listAiMemories` 是一条 SQL 的列清单，**不是 `SELECT *`**），
      //    这里漏一个键的表现是「SQLite 上好好的、切到 JSON 后端名称全空」——
      //    只坏一个后端的 bug 最难查，⚠️ 0.7.6 就真出过一次（SQLite 那边漏了 `label`），
      //    改动时**两个后端一起看**。
      //    老数据没有这个键 ⇒ 归一成 `null`（与 SQLite 补列后的 NULL 同形状）。
      label: r.label === undefined ? null : r.label,
      content: r.content,
      source: r.source,
      sort_no: r.sort_no,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  },

  /**
   * 功能：插入一条记忆，返回新 id。
   * @param {(number|string)} uid - 用户 id
   * @param {string} content - 记忆正文
   * @param {string} source - 来源（2 期恒为 'manual'）
   * @param {number} sortNo - 排序位
   * @param {?string} label - ⭐ 0.7.1：这一条的名称（`null` = 没有名称；空串由 store 层归一成 null）
   * @param {string} stamp - 时间戳
   * @returns {number} 新记忆 id
   */
  insertAiMemory(uid, content, source, sortNo, label, stamp) {
    const row = {
      id: this.data._seq,
      user_id: Number(uid),
      label,
      content,
      source,
      sort_no: sortNo,
      created_at: stamp,
      updated_at: stamp,
    };
    this.data._seq += 1;
    (this.data.ai_memories = this.data.ai_memories || []).push(row);
    this._saveJson();
    return row.id;
  },

  /**
   * 功能：改**自己的**一条记忆的指定列，返回**影响行数**（别人的 / 不存在 ⇒ 0，**不抛错**）。
   * @param {(number|string)} uid - 用户 id
   * @param {number} id - 记忆 id
   * @param {Object} fields - 列名 → 新值（合法集由 store 层硬映射收口）
   * @param {string} stamp - 时间戳（写进 `updated_at`）
   * @returns {number} 影响行数
   */
  updateAiMemory(uid, id, fields, stamp) {
    const u = Number(uid);
    const row = (this.data.ai_memories || []).find((r) => r && Number(r.id) === Number(id) && uidOf(r) === u);
    if (!row) return 0;
    for (const k of Object.keys(fields || {})) row[k] = fields[k];
    row.updated_at = stamp;
    this._saveJson();
    return 1;
  },

  /**
   * 功能：删**自己的**一条记忆，返回影响行数（别人的 / 不存在 ⇒ 0）。
   * @param {(number|string)} uid - 用户 id
   * @param {number} id - 记忆 id
   * @returns {number} 影响行数
   */
  deleteAiMemory(uid, id) {
    const u = Number(uid);
    const list = this.data.ai_memories || [];
    const i = list.findIndex((r) => r && Number(r.id) === Number(id) && uidOf(r) === u);
    if (i < 0) return 0;
    list.splice(i, 1);
    this._saveJson();
    return 1;
  },

  /**
   * 功能：清空该账号的全部记忆，返回删除条数（0 条也算成功 —— 幂等）。
   * @param {(number|string)} uid - 用户 id
   * @returns {number} 删除条数
   */
  clearAiMemories(uid) {
    const u = Number(uid);
    const list = this.data.ai_memories || [];
    const keep = list.filter((r) => uidOf(r) !== u);
    const removed = list.length - keep.length;
    this.data.ai_memories = keep;
    if (removed) this._saveJson();
    return removed;
  },
};

module.exports = { ops };
