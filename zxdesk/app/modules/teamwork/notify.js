/**
 * modules/teamwork/notify.js —— 对话的**消息推送口**（0.6.x，对话 2 期）
 *
 * 功能：把「一条新消息」按约定的事件形状推给这个会话的全部成员 —— 就一个函数
 *      `pushTeamworkMessage(msg, senderId)`。
 *
 * ⭐ **为什么单独一个文件**（而不是留在 `routes.js` 里）：0.6.x 起**后台 ticker 也要发消息**
 *    （提醒助手说的话），而它要推的事件形状必须与「用户自己发的消息」**逐字一致** ——
 *    否则同一个前端要认两种形状，表现是「提醒到了但界面当没看见」。
 *    `routes.js` 的导出表是**接口前缀表**（`module.exports = { teamwork: handleTeamwork }`，
 *    多导出一个键会被 `registry.routesFor()` 当场判成「暴露了未声明的接口前缀」），
 *    所以这个跨文件共用的函数不能挂在那里。
 *
 * ⚠️ 它 require `core/context.js`（要 `store.teamworkMemberIds()`）—— 这条依赖链
 *    (`notify → context → storage → store → registry → routes → notify`) 是个**环**，
 *    但**不会出问题**：`notify` 只在**函数体里**用 `store`，加载期不碰它，
 *    而加载结束时环上每一环都已完成求值。这与 `stream.js` 刻意不 require `context.js`
 *    的情形不同 —— 那个是在**模块顶层**用（所以那条会真的成环）。
 *
 * ⚠️ **收件人一律来自 `store.teamworkMemberIds(cid)`**（方案 §八-3）：绝不能退化成「推给所有人」，
 *    那等于把消息内容广播给整个 NAS 的账号。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/12-对话2期-内置提醒角色.md
 */
'use strict';

const { store } = require('../../core/context.js');
const stream = require('./stream.js');

/**
 * 功能：把一个会话里的一条增量消息推给它的**全部成员**（含发送者自己的其它设备：同一账号多端
 *      在线时本机也会收到一份，由前端按 `id` 去重合并）。
 *
 * 说明：⭐ 事件体刻意只带最小信息（类型 + 会话 id + 发送者 + 正文 + 时间），
 *      前端收到后不再回查 —— 「哪些字段能跨账号传」这个问题因此仍只有 REST 一处答案。
 *      ⚠️ `senderBuiltin` **不能省**：内置角色消息的 `senderId` 就是收件人自己
 *      （`teamwork_messages.user_id` 写会话归属者），前端没有这个标记只能把它画成
 *      「我自己发的」，而它明明是助手说的话。
 *
 * @param {Object} msg - `{ id, conversationId, body, createdAt }`（可带 `senderBuiltin` / `kind` / `meta`）
 * @param {number} senderId - 发送者账号 id（内置角色消息传**收件人**自己，见上）
 * @returns {number} 实际推送到的连接数
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
      // ⭐ 0.6.4（任务联动）：卡片的两列**必须一起推** —— 少了它们，实时到达的那一条
      //    会被渲染成降级文本，直到刷新页面走 REST 才变回卡片（典型的「刷新一下就好了」）。
      //    ⚠️ 这里传的 `meta` 已经是**对象**（`store.js` 的 `parseCardMeta()` 解析过），
      //    与 REST 那条路形状一致 —— 前端不必为了 SSE 再解析一次。
      kind: msg.kind || null,
      meta: msg.meta || null,
      createdAt: msg.createdAt,
    },
    // ⭐ 009 报告 S3：把 store 传下去 —— 推送前要复核「会话世代」，
    //    已经失效（改密 / 被重置）的连接一条都不该再收到消息
    store,
  });
}

module.exports = { pushTeamworkMessage };
