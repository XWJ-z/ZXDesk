/**
 * modules/teamwork/notify.js —— 对话的**消息推送口**（0.6.x，对话 2 期）
 *
 * 功能：把「一条新消息」按约定的事件形状推给这个会话的全部成员 —— 就一个函数
 * `pushTeamworkMessage(msg, senderId)`。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/12-对话2期-内置提醒角色.md
 */
'use strict';

const { store } = require('../../core/context.js');
const stream = require('./stream.js');

/**
 * 功能：把一个会话里的一条增量消息推给它的**全部成员**（含发送者自己的其它设备：同一账号多端
 * 在线时本机也会收到一份，由前端按 `id` 去重合并）。
 *
 * 说明：⭐ 事件体刻意只带最小信息（类型 + 会话 id + 发送者 + 正文 + 时间），
 * 前端收到后不再回查 —— 「哪些字段能跨账号传」这个问题因此仍只有 REST 一处答案。
 */
function pushTeamworkMessage(msg, senderId) {
  return stream.pushToUsers(store.teamworkMemberIds(msg.conversationId), {
    type: 'message',
    conversationId: Number(msg.conversationId),
    message: {
      id: Number(msg.id),
      conversationId: Number(msg.conversationId),
      senderId: Number(senderId),
      body: String(msg.body == null ? '' : msg.body),
      senderBuiltin: msg.senderBuiltin || null,
      // ：卡片的两列**必须一起推** —— 少了它们，实时到达的那一条
      // 会被渲染成降级文本，直到刷新页面走 REST 才变回卡片（典型的「刷新一下就好了」）。
      // 这里传的 `meta` 已经是**对象**（`store.js` 的 `parseCardMeta()` 解析过），
      kind: msg.kind || null,
      meta: msg.meta || null,
      createdAt: msg.createdAt,
    },
    // 009 报告 S3：把 store 传下去 —— 推送前要复核「会话世代」，
    // 已经失效（改密 / 被重置）的连接一条都不该再收到消息
    store,
  });
}

module.exports = { pushTeamworkMessage };
