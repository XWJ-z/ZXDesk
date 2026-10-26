/**
 * modules/teamwork/routes.js —— 对话路由（好友 / 会话 / 消息）
 *
 * 功能：`handleTeamwork` 一处收全部对话接口 —— 好友总览与申请 / 同意 / 拒绝 / 删除 / 拉黑，
 *      会话列表与开设，消息的历史分页、增量补齐、发送与标记已读。
 *
 * ⚠️ **SSE 长连接的 HTTP 入口不在这里**，它住在同目录的 `stream.js`（`handleTeamworkStream`）——
 *    长连接不能走「处理完就 `res.end()`」的常规路径，`server.js` 用**可选钩子**
 *    （注册表给目录 + `fs.existsSync`）单独取它，模块被删掉时那条请求退化成 **404**。
 *
 * 说明：⭐ 接口设计与 `modules/bookmarks/routes.js` 同构（统一 `ctx` 参数表），鉴权由 `server.js`
 *      的 401 闸门保证 —— `/api/teamwork/*` 挂在闸门**之后**。
 *
 * ⚠️ 与其它路由最大的不同有两条：
 *   ① **判权不在这一层**：所有「能不能碰这个会话」都交给 `store.teamworkConversationOr404()`
 *      （成员关系 + 一对一里是否仍是好友），路由层只解析路径与请求体；
 *   ② **推送范围不在这一层拍脑袋**：`stream.js` 的 `pushToUsers()` 的收件人一律来自
 *      `store.teamworkMemberIds(cid)`（方案 §八-3：**绝不能广播给所有人**）。
 *
 * ⭐ **事件体刻意只带最小信息**（类型 + 会话 id + 发送者 id），前端收到后重新拉一次
 *    `/api/teamwork/friends` / 增量消息：这样「哪些账号字段能跨账号传」这个问题就**只有一处答案**
 *    （REST 响应里的 `peer_user`），而不是「REST 一套、SSE 又一套」——两套迟早会不一致。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/routes/teamwork.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了三件事：
 *    ① 相对路径（`../validate.js` → `../../core/validate.js`，`../chat-stream.js` → `./stream.js`）；
 *    ② 导出键 `handleTeamwork` → **`teamwork`**（= `module.json` 的 `apiPrefix`，由注册表自动挂上路由表）；
 *    ③ `handleTeamworkStream` 那一段搬去同目录的 `stream.js`（它要用 `stream.*` 自己的东西，
 *       留在路由文件里就得反过来把本文件 require 进 stream —— 见那里的说明）。
 *    ⚠️ **跨账号的三条规矩一个字都没改**：判权看成员关系、越权与不存在统一 404、
 *    推送范围只按 `teamwork_members` 算。
 *
 * ⭐⭐ 0.8.12：`handleCollab()`（协作 `/api/collab/*` 的唯一入口）
 *    从 `modules/tasks/routes.js` **整份搬进本文件**（判据在 `./lib/collab.js`，路由与它同模块）。
 *    ⚠️ 接口路径一个字节没改（`module.json` 的 `apiPrefix` 现在是 `['teamwork', 'collab']`）；
 *    ⚠️⭐ **判权一条都不在这一层**（`store.taskShareGuard()` 一处判据），本文件只把 404 翻译成响应 ——
 *    ⛔ 这里**不许**出现任何一个 `shared` / 成员判断式（在路由层再写一遍就是判据的第二处）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.54
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */
'use strict';

const {
  checkTeamworkMessage,
  checkFriendPrefs,
  checkFriendRemark,
  checkFriendRequest,
  checkReminderPrefs,
  checkProjectTask,
  checkTaskReport,
  MAX_TEAMWORK_PAGE,
} = require('../../core/validate.js');
const { fail, httpError, idParam, json, notFound, readBody, readBodyToFile, rfc5987, writeResult } = require('../../core/http-util.js');
const { store } = require('../../core/context.js');
// ⭐ 0.6.x：消息的 SSE 推送口搬去 `./notify.js` —— 后台 ticker 也要用它，
//    而事件形状必须**只有一份**（见那个文件头的说明）。
const { pushTeamworkMessage: pushMessage } = require('./notify.js');
const stream = require('./stream.js');
// ⭐⭐ 0.8.12：协作附件上传的**上限常量**（与业务层单一出处）。
const { FILE_MAX_BYTES } = require('./lib/collab.js');
// ⭐ 0.8.54：聊天图片的落盘口径（扩展名白名单 / 上限 / 内容寻址文件名 / 反解）—— 一处实现。
const {
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  imageDirOf,
  imageExtOf,
  imageFileName,
  parseImageFileName,
  sha256OfFile,
} = require('./lib/chat-image.js');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 功能：把查询串里的一个正整数分页参数解析出来（没带 / 空串 → null；非法 → 400）。
 *
 * 说明：⚠️ 分页参数**必须校验**（与收藏夹的检索参数刻意不同）：`before` / `after` 是游标，
 *      收到 `abc` 时若当成「没带」，用户看到的是「翻页没反应」而不是「参数不对」。
 *
 * @param {Object} url - 解析好的 URL 对象
 * @param {string} key - 参数名（`before` / `after`）
 * @returns {?number} 正整数，或 null（没带）
 * @throws {Error} 带了但不是正整数时抛 400
 */
function readCursor(url, key) {
  const raw = url && url.searchParams ? url.searchParams.get(key) : null;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `${key} 必须是正整数（消息 id）`);
  return n;
}

/**
 * 功能：把一条**好友关系变化**的事件推给对方（申请 / 同意 / 拒绝 / 删除 / 拉黑）。
 *
 * 说明：⚠️ 事件体里**不含任何账号资料**（只有动作与我的 id）：前端收到后重新拉一次
 *      `/api/teamwork/friends` 即可 —— 少一处「哪些字段能给别人看」的重复答案（见文件头）。
 *
 * @param {number} toUid - 推给谁（一般是关系里的另一方）
 * @param {string} action - `requested` / `accepted` / `removed` / `blocked` / `unblocked`
 * @param {number} actorId - 动作发起人
 * @returns {number} 实际推送到的连接数
 */
function pushFriend(toUid, action, actorId) {
  // ⭐ 009 报告 S3：store 传下去做「会话世代」复核（失效的连接不再收推送）
  return stream.pushToUsers([Number(toUid)], { type: 'friend', action, userId: Number(actorId) }, store);
}

/**
 * 功能：⭐ **错误出口的收口** —— 把业务层抛出的 404 / 429 映射成项目规定的两种响应形态。
 *
 * 说明：⚠️ 这一层不是装饰，而是**必须**的：
 *      · 业务层（本模块 `store.js`）抛的 404 是给**进程内调用方**用的（测试、将来的定时任务），
 *        它走 `fail()` 会带上 `readOnly` 之类的附加字段 —— 而 404 的响应体必须**逐字固定**
 *        （`{"error":"not found"}`），否则「越权」与「不存在」就不再逐字一致，
 *        状态码本身又会变回一条 id 探测通道；
 *      · 429（发得太快）同样要求响应体固定，不能掺 `readOnly`。
 *      400 / 5xx **原样上抛**，由 `fail()` 统一收口（那才是它们的归宿，见 `http-util.js`）。
 *
 * ⚠️ 收口要收**两处**：同步路径（外层 try）与 `readBody` 的回调**两条都要包** ——
 *    回调跑在 `'end'` 事件里，外层 createServer 与这里的 try 都抓不到它
 *    （这正是 `http-util.js` 在 `readBody` 里自带 try/catch 的原因）。
 *
 * @param {Object} res - HTTP 响应对象
 * @param {Function} fn - 真正干活的函数
 * @returns {void}
 */
function withTeamworkErrors(res, fn) {
  try {
    fn();
  } catch (e) {
    if (e && e.status === 404) return notFound(res);
    if (e && e.status === 429) return json(res, 429, { error: e.message });
    throw e;
  }
}

/**
 * 功能：`readBody` 的**受保护版本** —— 回调里的 404 / 429 走同一套收口（见 `withTeamworkErrors`）。
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @param {Function} cb - 解析完成后的回调
 * @returns {void}
 */
function readBodySafe(req, res, cb) {
  return readBody(req, res, (b) => withTeamworkErrors(res, () => cb(b)));
}

/**
 * 功能：处理 `/api/teamwork` 及其子路径 —— 好友、会话与消息的全部 REST 接口。
 *
 * 说明：路由表（`parts = ['api','teamwork', …]`）——
 *      · `GET    /api/teamwork/friends`                          好友总览（含待处理申请、会话与未读）
 *      · `POST   /api/teamwork/friends`                          发起好友申请 `{ username | userId }`
 *      · `POST   /api/teamwork/friends/:id/accept`               同意申请
 *      · `POST   /api/teamwork/friends/:id/reject`               拒绝申请
 *      · `DELETE /api/teamwork/friends/:id`                      删除好友
 *      · `POST   /api/teamwork/friends/:id/block`                拉黑 / 取消拉黑 `{ blocked }`
 *      · `GET    /api/teamwork/conversations`                    会话列表（含未读数与最后一条）
 *      · `POST   /api/teamwork/conversations`                    开一对一 `{ friendId }`（幂等）
 *      · `GET    /api/teamwork/conversations/:id/messages`       历史（`before`）/ 增量（`after`）/ `limit`
 *      · `POST   /api/teamwork/conversations/:id/messages`       发消息 `{ body }`；
 *        ⭐ 0.6.4（任务联动）：可另带 `{ kind: 'task_card', meta: {...} }` 发一条**任务卡片**，
 *        `body` 照样必填（它是渲染端不认这个种类时的降级文本；字段契约见 `17-对话.md`）
 *      · `POST   /api/teamwork/conversations/:id/read`           标记已读 `{ lastReadId }`
 *      · `POST   /api/teamwork/conversations/:id/images`         ⭐ 0.8.54：发图片（`octet-stream` ＋ 查询串 `name`；
 *                                                            只收 png/jpg/jpeg/webp/gif，8 MB 上限）
 *      · `GET    /api/teamwork/images/:cid/:file`                ⭐ 0.8.54：读图片（判权 = 会话成员；
 *                                                            `inline` ＋ 内容寻址（`<sha256>.<扩展名>`））
 *      · `POST   /api/teamwork/conversations/:id/clear`          ⭐ 0.7.7：清掉**我这一侧**的一段聊天记录
 *                                                            `{ from?, to? }`（`YYYY-MM-DD`，都不给 = 整个会话）；
 *        ⚠️ 刻意用 POST：**一行数据都不删**（对话是跨账号数据），它只是一个动作
 *      · `GET    /api/teamwork/reminder-prefs`                  读本账号的提醒设置（0.6.x，缺省值由服务端给）
 *      · `PUT    /api/teamwork/reminder-prefs`                  改提醒设置（**带哪个键写哪个键**）；
 *                                                            ⭐ 给内置角色起的**称呼**（`builtin_name`）也走这一条
 *      · `GET    /api/teamwork/friend-prefs`                    读本账号的好友设置（0.7.7）
 *      · `PUT    /api/teamwork/friend-prefs`                    改好友设置（自动通过好友申请；带哪个键写哪个键）
 *      · `POST   /api/teamwork/reminder-test`                   ⭐ 0.7.7：立刻发**一组**测试提醒（四种各一条）
 *      · `GET    /api/teamwork/cleared`                         回收站：还没过期的清理记录（0.7.7）
 *      · `POST   /api/teamwork/cleared/:id/restore`             恢复那一段（= 删掉那条清理记录）
 *      · `GET    /api/teamwork/stream`                           **SSE 长连接**（在 `server.js` 里另行分派）
 *
 * ⚠️ `accept` / `reject` / `block` / `messages` / `read` 都是 **5 段路径**，
 *    必须**先按段数分派再取 id**：把 `idParam(parts[3])` 提前会让
 *    `/api/teamwork/friends` 这种 3 段路径走进「非法 id → 404」的死路（收藏夹的 `tags` 踩过同一个坑）。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {Object} ctx.url - 解析好的 URL 对象（取查询参数）
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleTeamwork(ctx) {
  const { req, res } = ctx;
  // 同步路径的收口（异步回调那条在 readBodySafe 里再包一层）
  return withTeamworkErrors(res, () => routeTeamwork(ctx, req, res));
}

/**
 * 功能：`handleTeamwork` 的实际分派体（拆出来只为了给上面那层统一收口留出位置）。
 * @param {Object} ctx - 分派上下文
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @returns {void}
 */
function routeTeamwork({ parts, url, method, uid }, req, res) {
  const sub = parts[2];

  // ⭐⭐ 0.8.54（「点击加号可以发送图片」）：读一张聊天图片。
  //    ⚠️ 判权 = **会话成员**（`teamworkConversationOr404()`，与读消息同一个口）⇒ 不是成员就是 404，
  //    与「这张图不存在」**逐字一致**（不给探测信号）。
  //    ⚠️⭐ 文件名只认 `<64 位 sha256>.<白名单扩展名>`（`parseImageFileName()`）——
  //      ⛔ 绝不把 URL 那一段直接丢进 `path.join`（那是路径穿越的经典入口）。
  //    ⚠️ 这一条与协作附件的下载**刻意不同**：那边强制 `attachment`（用户文件不内联渲染），
  //      这里必须 **inline** —— 它是本应用自己 `<img>` 要加载的图，且只收位图、类型由服务端派生。
  if (sub === 'images' && method === 'GET' && parts.length === 5) {
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    const parsed = parseImageFileName(parts[4]);
    if (!parsed) return notFound(res);
    store.teamworkConversationOr404(uid, cid);
    const filePath = path.join(imageDirOf(store.dataDir, cid), imageFileName(parsed.sha, parsed.ext));
    if (!fs.existsSync(filePath)) return notFound(res);
    res.writeHead(200, {
      'Content-Type': IMAGE_MIME[parsed.ext] || 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Content-Length': fs.statSync(filePath).size,
      // 内容寻址 ⇒ 同一个 URL 的字节永不改变（判权仍逐次做，这里只是省一次传输）
      'Cache-Control': 'private, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath)
      .on('error', () => {
        // 读到一半出错：断开连接（响应头已经发出去，没法再回 JSON 错误体）
        try {
          res.destroy();
        } catch (_e) {
          /* 已断开：忽略 */
        }
      })
      .pipe(res);
    return;
  }

  // ---- 好友 ----
  if (sub === 'friends') {
    if (parts.length === 3) {
      if (method === 'GET') return json(res, 200, store.teamworkFriendsOverview(uid));
      if (method === 'POST') {
        return readBodySafe(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const r = store.teamworkRequestFriend(uid, checkFriendRequest(b));
          // ⭐ 只有真的新发出了一条申请才打扰对方（幂等重发不推）。
          //    ⚠️ 0.7.7：对方开着「自动通过」时 `status` 直接是 `accepted` ⇒ 推的是 `accepted`
          //    （他那边要看到「你们已经是好友了」，而不是「有一条待处理申请」）。
          //    ⛔ 这里**不再判一次**「是不是自动通过」（判据只在 `teamworkRequestFriend()` 里一处）。
          if (r.notified) pushFriend(r.friendId, r.status === 'accepted' ? 'accepted' : 'requested', uid);
          return json(res, 200, { ok: true, friendId: r.friendId, status: r.status });
        });
      }
      return notFound(res);
    }
    const fid = idParam(parts[3]);
    if (fid === null) return notFound(res);
    if (method === 'DELETE' && parts.length === 4) {
      const r = store.teamworkRemoveFriend(uid, fid);
      pushFriend(fid, 'removed', uid);
      return json(res, 200, { ok: true, friendId: r.friendId });
    }
    if (parts.length === 5 && method === 'POST') {
      const action = parts[4];
      if (action === 'accept') {
        const r = store.teamworkAcceptFriend(uid, fid);
        pushFriend(fid, 'accepted', uid);
        return json(res, 200, { ok: true, friendId: r.friendId });
      }
      if (action === 'reject') {
        const r = store.teamworkRejectFriend(uid, fid);
        pushFriend(fid, 'removed', uid);
        return json(res, 200, { ok: true, friendId: r.friendId });
      }
      if (action === 'block') {
        return readBodySafe(req, res, (b) => {
          if (!b || typeof b.blocked !== 'boolean') throw httpError(400, 'bad body');
          const r = store.teamworkSetBlocked(uid, fid, b.blocked);
          pushFriend(fid, r.blocked ? 'blocked' : 'unblocked', uid);
          return json(res, 200, { ok: true, friendId: r.friendId, blocked: r.blocked });
        });
      }
      // ⭐ 0.4.4 好友备注：**不推 SSE、也不打扰对方** —— 备注只写我这一行，
      //    对方那一行一个字节都没动，推给他反而是错的（他那边什么都不该变）。
      if (action === 'remark') {
        return readBodySafe(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const r = store.teamworkSetFriendRemark(uid, fid, checkFriendRemark(b).remark);
          return json(res, 200, { ok: true, friendId: r.friendId, remark: r.remark });
        });
      }
    }
    return notFound(res);
  }

  // ---- 会话 / 消息 ----
  if (sub === 'conversations') {
    if (parts.length === 3) {
      if (method === 'GET') return json(res, 200, { items: store.teamworkListConversations(uid) });
      if (method === 'POST') {
        return readBodySafe(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const fid = Number(b.friendId);
          if (!Number.isInteger(fid) || fid <= 0) throw httpError(400, '请提供 friendId（对方账号 id）');
          return json(res, 200, store.teamworkStartConversation(uid, fid));
        });
      }
      return notFound(res);
    }

    const cid = idParam(parts[3]);
    if (cid === null || parts.length !== 5) return notFound(res);

    if (parts[4] === 'messages') {
      if (method === 'GET') {
        const before = readCursor(url, 'before');
        const after = readCursor(url, 'after');
        if (before !== null && after !== null) throw httpError(400, 'before 与 after 只能给一个');
        const rawLimit = url && url.searchParams ? url.searchParams.get('limit') : null;
        let limit = 50;
        if (rawLimit !== null && rawLimit !== '') {
          const n = Number(rawLimit);
          if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'limit 必须是正整数');
          if (n > MAX_TEAMWORK_PAGE) throw httpError(400, `一次最多取 ${MAX_TEAMWORK_PAGE} 条消息`);
          limit = n;
        }
        return json(res, 200, store.teamworkMessages(uid, cid, { before, after, limit }));
      }
      if (method === 'POST') {
        return readBodySafe(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const { body, kind, meta } = checkTeamworkMessage(b);
          const r = store.teamworkSendMessage(uid, cid, body, { kind, meta });
          // ⚠️ 推送的事件体要带上**正文**：`teamworkSendMessage` 的返回值里只有 id / createdAt
          //    （那是给 HTTP 响应用的），这里必须自己补上 body，否则对面收到的是一条空消息。
          //    ⭐ 0.6.4：`kind` / `meta` 不在这里补 —— `teamworkSendMessage` 的返回值里已经有了
          //    （且 `meta` 已是对象），少写一处就少一个「REST 有、SSE 没有」的形状差异。
          const pushed = pushMessage(Object.assign({}, r, { body }), uid);
          // ⭐ 0.7.7：内置角色会话的**自动回复** —— 与上面那条走**同一个推送口**
          //    （`notify.js` 的 `pushTeamworkMessage`），否则一端看得到、另一端要刷新才看得到。
          //    ⚠️ 「要不要回」的判据在 `teamworkSendMessage()` 里已经定了（`reply` 为 null 就是不回）。
          if (r.reply) pushMessage(r.reply, uid);
          return json(res, 201, {
            ok: true,
            id: r.id,
            conversationId: r.conversationId,
            createdAt: r.createdAt,
            pushed,
            // ⚠️ 回复**原样带回给前端**：它立刻就能把这句话画出来，不必等 SSE 绕一圈
            //    （自己这一端也收得到推送，但等它到会有肉眼可见的延迟）
            reply: r.reply,
          });
        });
      }
      return notFound(res);
    }

    // ⭐⭐ 0.8.54（「点击加号可以发送图片」）：**发图片** —— 原始字节 ＋ 查询串里的 `name`。
    //    流程与协作附件同一套：`readBodyToFile()` 边收边写临时文件 → 算 sha → 内容寻址改名。
    //    ⚠️⭐ 判权在**收字节之前**先做一次（不是成员直接 404）—— 否则任何人可以先拿 8MB 试试路。
    //    ⚠️ `kind='image'` 的消息**只能**从这里造出来（它不在客户端可发白名单里）。
    if (parts[4] === 'images' && method === 'POST' && parts.length === 5) {
      const rawName = String(url.searchParams.get('name') || '').trim();
      const ext = imageExtOf(rawName);
      if (!ext) return json(res, 400, { error: '这种图片不支持（只收 png / jpg / jpeg / webp / gif）' });
      store.teamworkConversationOr404(uid, cid);
      const dir = imageDirOf(store.dataDir, cid);
      const tmpName = `upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
      readBodyToFile(req, res, {
        dir,
        name: tmpName,
        limit: IMAGE_MAX_BYTES,
        tooBigMsg: `图片太大（上限 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB）。`,
        onDone: ({ path: tmpPath, size }) => {
          if (!tmpPath || !size) throw httpError(400, '图片是空的');
          let sha;
          try {
            sha = sha256OfFile(tmpPath);
            const finalPath = path.join(dir, imageFileName(sha, ext));
            if (finalPath !== tmpPath) {
              // 内容寻址 ⇒ 同一张图发两次只留一份：已存在就删掉临时文件。
              if (fs.existsSync(finalPath)) fs.unlinkSync(tmpPath);
              else fs.renameSync(tmpPath, finalPath);
            }
          } catch (_e) {
            try {
              fs.unlinkSync(tmpPath);
            } catch (_e2) {
              /* 已经不在了：忽略 */
            }
            throw httpError(500, '图片保存失败，请稍后再试');
          }
          const r = store.teamworkSendImage(uid, cid, { name: rawName, ext, size, sha });
          // ⚠️ 推送要带 `body`（降级文本）—— 对面收到的是同一条消息，不能「REST 有、SSE 没有」
          const pushed = pushMessage(Object.assign({}, r, { body: `【图片】${rawName || '图片'}` }), uid);
          return json(res, 201, {
            ok: true,
            id: r.id,
            conversationId: r.conversationId,
            createdAt: r.createdAt,
            // ⚠️ `meta` 原样回给前端：图片的 `sha` 就在里面，缺了它前端画不出发出去的那一张
            //    （只能等一次整屏重取才看得见自己的图 —— 那是肉眼可见的「发完没反应」）
            meta: r.meta,
            pushed,
          });
        },
      });
      return;
    }

    // ⭐ 0.7.7：清掉「我这一侧」的一段聊天记录 —— ⚠️ 用 **POST 不是 DELETE**：
    //    它**不删任何数据**（对话是跨账号数据），是一个动作；`DELETE` 会让人以为数据没了。
    //    ⚠️⭐ 它**必须写在 `if (parts[4] === 'messages')` 之外** —— 写进那一块里的话，
    //    只有 `parts[4] === 'messages'` 才会进来，`clear` 那条永远走不到（一路 404）。
    if (parts[4] === 'clear' && method === 'POST') {
      return readBodySafe(req, res, (b) => {
        const src = b && typeof b === 'object' ? b : {};
        const r = store.teamworkClearMessages(uid, cid, { from: src.from, to: src.to });
        return json(res, 200, r);
      });
    }

    if (parts[4] === 'read' && method === 'POST') {
      return readBodySafe(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const r = store.teamworkMarkRead(uid, cid, b.lastReadId);
        return json(res, 200, { ok: true, lastReadId: r.lastReadId });
      });
    }
    return notFound(res);
  }

  // ---- 提醒设置（0.6.x，对话 2 期）----
  // ⚠️ 这两条刻意**不做成会话子路径**（`/api/teamwork/reminders/...`）：提醒设置是**账号级**的
  //    （一个账号一份），与会话无关；挂在会话下面会让人以为「每个会话各有一套提醒设置」。
  if (sub === 'reminder-prefs') {
    if (parts.length !== 3) return notFound(res);
    if (method === 'GET') return json(res, 200, { prefs: store.teamworkReminderPrefs(uid) });
    if (method === 'PUT') {
      return readBodySafe(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // ⭐ 带哪个键写哪个键：校验与「只认带了的那几个键」都在 `checkReminderPrefs()` 一处。
        return json(res, 200, { ok: true, prefs: store.teamworkSetReminderPrefs(uid, checkReminderPrefs(b)) });
      });
    }
    return notFound(res);
  }

  // ---- 好友设置（0.7.7）----
  // ⚠️ 与提醒设置同一条理由：**不做成会话子路径** —— 它是**账号级**的（一个账号一份）。
  if (sub === 'friend-prefs') {
    if (parts.length !== 3) return notFound(res);
    if (method === 'GET') return json(res, 200, { prefs: store.teamworkFriendPrefs(uid) });
    if (method === 'PUT') {
      return readBodySafe(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // ⭐ 带哪个键写哪个键，校验在 `checkFriendPrefs()` 一处
        return json(res, 200, { ok: true, prefs: store.teamworkSetFriendPrefs(uid, checkFriendPrefs(b)) });
      });
    }
    return notFound(res);
  }

  // ---- 「发一组测试提醒」（0.7.7 起是四种各一条）—— 真机验收要用 ----
  // ⚠️ 它真发消息（写库 + 推 SSE），所以是 POST；⚠️ **不写提醒流水**（理由见 store 的同名方法）。
  if (sub === 'reminder-test') {
    if (parts.length !== 3 || method !== 'POST') return notFound(res);
    const r = store.teamworkReminderTest(uid);
    // ⚠️ `senderId` 传的是**收件人自己**：内置角色消息的 `user_id` 就是会话归属者，
    //    前端靠事件体里的 `senderBuiltin` 把它画成「助手说的话」（见 `notify.js`）。
    //    ⭐ 0.7.7：四条各推一次 —— 每条的 `kind` 都要带对，否则实时到达的那条画不回卡片。
    let pushed = 0;
    for (const it of r.items) {
      pushed += pushMessage(Object.assign({}, it, { senderBuiltin: 'reminder' }), uid);
    }
    return json(res, 201, {
      ok: true,
      count: r.items.length,
      items: r.items.map((it) => ({ id: it.id, kind: it.kind })),
      conversationId: r.items.length ? r.items[0].conversationId : 0,
      pushed,
    });
  }

  // ---- 清理记录（回收站，0.7.7）----
  // ⚠️ 两条都刻意**不做成会话子路径**：回收站是「我这一侧的全部清理记录」，与某个会话无关
  //    （而「清理」本身必须带会话 id，它走 `conversations/:id/clear`）。
  if (sub === 'cleared') {
    if (parts.length === 3) {
      if (method === 'GET') return json(res, 200, store.teamworkClearedList(uid));
      return notFound(res);
    }
    // `POST /api/teamwork/cleared/:id/restore` —— 恢复那一段（越权 / 不存在一律 404）
    if (parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
      const id = idParam(parts[3]);
      if (id === null) return notFound(res);
      const r = store.teamworkRestoreCleared(uid, id);
      return json(res, 200, { ok: true, id: r.id });
    }
    return notFound(res);
  }

  return notFound(res);
}

/**
 * 功能：处理 `/api/collab` 及其子路径 —— **协作（共享任务与上报）的唯一入口**（0.8.10 追加批）。
 *
 * 路由表（`parts = ['api','collab', …]`）——
 *      · `GET    /api/collab/projects`                     我能看到的共享项目（我开的 ＋ 我加入的）
 *      · `GET    /api/collab/addable`                       ⭐ 0.8.12：我自己的、**还没进协作**的项目（【添加共享项目】用）
 *      · `GET    /api/collab/friends`                      可拉进项目的好友（好友功能不在 ⇒ 503）
 *      · `GET    /api/collab/projects/:pid`                项目详情（判权）
 *      · `PUT    /api/collab/projects/:pid/shared`         `{ shared: bool }`（**仅所有者**）
 *      · `GET    /api/collab/projects/:pid/members`        成员名单（判权）
 *      · `POST   /api/collab/projects/:pid/members`        `{ user_id }`（**仅所有者**，且必须是好友）
 *      · `DELETE /api/collab/projects/:pid/members/:uid`   移出（**仅所有者**）
 *      · `GET    /api/collab/projects/:pid/tasks`          该项目的任务（判权）
 *      · `POST   /api/collab/projects/:pid/tasks`          ⭐ 0.8.12：**任何成员**发任务（`{title,status?,assignee_id?,due_date?,description?}`）
 *      · `PUT    /api/collab/projects/:pid/tasks/:tid`     成员改任务状态（判权；改到完成组仅所有者）
 *      · `DELETE /api/collab/projects/:pid/tasks/:tid`     ⭐ 0.8.54：删任务（**所有者 ＋ 创建者**；连带上报 / 评论 / 附件 / 打卡）
 *      · `GET    /api/collab/projects/:pid/states`         状态集（判权；空则先播种）
 *      · `POST   /api/collab/projects/:pid/states`         新增状态（**仅所有者**）
 *      · `PUT    /api/collab/projects/:pid/states/:sid`    改状态（**仅所有者**）
 *      · `DELETE /api/collab/projects/:pid/states/:sid`    删状态（**仅所有者**；三条禁令各 400）
 *      · `GET    /api/collab/projects/:pid/board`          ⭐ 0.8.12：看板取数（判权；一次到位）
 *      · `POST   /api/collab/projects/:pid/transfer`       转让（**仅所有者**；新所有者必须是成员）
 *      · `GET    /api/collab/projects/:pid/comments`       ⭐ 0.8.12：评论（判权；`?task_id=` 缺省只回项目级）
 *      · `POST   /api/collab/projects/:pid/comments`       ⭐ 2d：`{ task_id?, body }`（判权；成员）
 *      · `DELETE /api/collab/comments/:id`                 ⭐ 2d：删评论（⚠️ **仅作者**；非成员 / 非作者一律 404）
 *      · `GET    /api/collab/projects/:pid/activity`       ⭐ 2d：项目活动流水（判权；时间倒序）
 *      · `GET    /api/collab/projects/:pid/tasks/:tid/activity` ⭐ 2d：单任务活动流水（判权）
 *      · `GET    /api/collab/projects/:pid/files`          ⭐ 2f：附件列表 ＋ 每成员用量（判权）
 *      · `POST   /api/collab/projects/:pid/files`          ⭐ 2f：上传（`octet-stream` ＋ 查询串元数据 `name/task_id/report_id/comment_id`；成员）
 *      · `GET    /api/collab/files/:fid`                   ⭐ 2f：下载（判权；⚠️ attachment ＋ 流式）
 *      · `DELETE /api/collab/files/:fid`                   ⭐ 2f：删附件（⚠️ 上传者自己 ＋ 项目所有者）
 *      · `GET    /api/collab/projects/:pid/reports`        上报（判权；含「每人最新一条」）
 *      · `POST   /api/collab/reports`                      `{ task_source, task_id, status, note }`（判权）
 *      · `DELETE /api/collab/reports/:id`                  删**我自己**的那一条
 *
 * ⚠️⭐ **判权全部落在 store 层**（`store.taskShareGuard()` 一处判据）：本文件只负责
 *      「把 404 翻译成响应」—— ⛔ 这里**不许**出现任何一个 `shared` / 成员判断式
 *      （在路由层再写一遍就是「判据的第二处」，那种副本的失效方式是**静默越权**）。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @returns {void}
 */
function handleCollab({ req, res, parts, method, url, uid }) {
  if (parts.length === 3 && parts[2] === 'projects' && method === 'GET') {
    return json(res, 200, store.listCollabProjects(uid));
  }
  // ⭐ 0.8.12：【添加共享项目】→「选一个已有项目」那个列表 —— 我自己的、还没进协作的。
  //    ⚠️ 判据（谁是我的）在服务端（`_bk.listProjects(uid)`），⛔ 前端别自己拉一份再筛。
  if (parts.length === 3 && parts[2] === 'addable' && method === 'GET') {
    return json(res, 200, store.collabAddableProjects(uid));
  }
  if (parts.length === 3 && parts[2] === 'friends' && method === 'GET') {
    return json(res, 200, { items: store.collabFriendCandidates(uid) });
  }
  if (parts.length === 3 && parts[2] === 'reports' && method === 'POST') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      json(res, 201, store.collabAddReport(uid, checkTaskReport(b)));
    });
  }
  if (parts.length === 4 && parts[2] === 'reports' && method === 'DELETE') {
    const rid = idParam(parts[3]);
    if (rid === null) return notFound(res);
    return writeResult(res, store.collabRemoveReport(uid, rid));
  }
  // ⭐ 0.8.12：删评论 —— ⚠️ **仅作者**（连项目所有者也不行）。
  //    判权（是否存在 / 是不是成员 / 是不是作者）全在 store 层，路由只翻译 404。
  if (parts.length === 4 && parts[2] === 'comments' && method === 'DELETE') {
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    return writeResult(res, store.collabRemoveComment(uid, cid));
  }
  // ⭐⭐ 0.8.12：附件 —— 下载（成员）与删除（**上传者自己 ＋ 项目所有者**）。
  //    ⚠️ 下载**必须** `Content-Disposition: attachment`（本应用被飞牛桌面 iframe 嵌着 ⇒
  //    用户文件绝不能内联渲染），且**流式**回（⛔ 别把整个文件读进内存）。
  //    判权（是不是成员 / 是不是上传者或所有者）全在 store 层，路由只翻译 404。
  if (parts.length === 4 && parts[2] === 'files') {
    const fid = idParam(parts[3]);
    if (fid === null) return notFound(res);
    if (method === 'DELETE') return writeResult(res, store.collabRemoveFile(uid, fid));
    if (method === 'GET') {
      const d = store.collabDownloadFile(uid, fid);
      res.writeHead(200, {
        'Content-Type': d.mime || 'application/octet-stream',
        // ⚠️ 中文名必须走 `filename*`（`filename=` 只允许 ASCII），另留一个 ASCII 兜底名。
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${rfc5987(d.name)}`,
        'Content-Length': d.size,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(d.path);
      stream.on('error', () => {
        // 读到一半出错：断开连接（响应头已经发出去，没法再回 JSON 错误体）
        try {
          res.destroy();
        } catch (_e) {
          /* 已断开：忽略 */
        }
      });
      stream.pipe(res);
      return;
    }
  }

  // 以下全在 `/api/collab/projects/:pid/…` 之下
  if (parts[2] !== 'projects') return notFound(res);
  const pid = idParam(parts[3]);
  if (pid === null) return notFound(res);

  if (method === 'GET' && parts.length === 4) return json(res, 200, store.collabProject(uid, pid));

  if (method === 'PUT' && parts.length === 5 && parts[4] === 'shared') {
    return readBody(req, res, (b) => {
      if (!b || typeof b.shared !== 'boolean') throw httpError(400, 'bad body');
      json(res, 200, store.collabSetShared(uid, pid, b.shared));
    });
  }
  if (parts[4] === 'members') {
    if (method === 'GET' && parts.length === 5) return json(res, 200, { items: store.collabMembers(uid, pid) });
    if (method === 'POST' && parts.length === 5) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const mid = idParam(String(b.user_id == null ? '' : b.user_id));
        if (mid === null) throw httpError(400, 'bad body');
        json(res, 200, store.collabAddMember(uid, pid, mid));
      });
    }
    if (method === 'DELETE' && parts.length === 6) {
      const mid = idParam(parts[5]);
      if (mid === null) return notFound(res);
      return writeResult(res, store.collabRemoveMember(uid, pid, mid));
    }
  }
  if (parts[4] === 'tasks') {
    // ⭐ 0.8.12：单任务活动流水（`GET …/tasks/:tid/activity`）。
    if (method === 'GET' && parts.length === 7 && parts[6] === 'activity') {
      const tid = idParam(parts[5]);
      if (tid === null) return notFound(res);
      return json(res, 200, store.collabTaskActivity(uid, pid, tid));
    }
    if (method === 'GET' && parts.length === 5) return json(res, 200, store.collabTasks(uid, pid));
    // ⭐ 0.8.12：**任何成员**都可以在共享项目里发布任务（判权在 store 层）。
    //    ⚠️ 三个「谁」由 store 写死（`user_id`＝所有者、`creator_id`＝调用者、`assignee_id` 缺省＝所有者），
    //    路由层只做校验与转发 —— ⛔ 这里不许出现任何一个归属判断式。
    if (method === 'POST' && parts.length === 5) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.collabAddTask(uid, pid, checkProjectTask(b)));
      });
    }
    if (method === 'PUT' && parts.length === 6) {
      const tid = idParam(parts[5]);
      if (tid === null) return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        writeResult(res, store.collabUpdateTask(uid, pid, tid, checkProjectTask(b)));
      });
    }
    // ⭐ 0.8.54（「团队协作的待排期任务没有删除功能」）：删一条协作任务。
    //    ⚠️ 判权（成员 → 所有者 / 创建者）、存在性、连带清理**全在 store 层**
    //    （`collabRemoveTask()` → `deleteProjectTask()`）—— 本层只翻译 404，⛔ 不出现判断式。
    if (method === 'DELETE' && parts.length === 6) {
      const tid = idParam(parts[5]);
      if (tid === null) return notFound(res);
      return writeResult(res, store.collabRemoveTask(uid, pid, tid));
    }
  }
  // ⭐ 0.8.12 状态集：读口判成员、写口判所有者 —— 判据全在 store 层。
  if (parts[4] === 'states') {
    if (method === 'GET' && parts.length === 5) return json(res, 200, store.collabStates(uid, pid));
    if (method === 'POST' && parts.length === 5) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.collabAddState(uid, pid, b));
      });
    }
    if (method === 'PUT' && parts.length === 6) {
      const sid = idParam(parts[5]);
      if (sid === null) return notFound(res);
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        writeResult(res, store.collabUpdateState(uid, pid, sid, b));
      });
    }
    if (method === 'DELETE' && parts.length === 6) {
      const sid = idParam(parts[5]);
      if (sid === null) return notFound(res);
      return writeResult(res, store.collabDeleteState(uid, pid, sid));
    }
  }
  // ⭐ 0.8.12：评论 —— 读口判成员（`?task_id=` 缺省只回项目级评论），
  //    写口判成员（任何成员都能发）。判权全在 store 层。
  if (parts[4] === 'comments') {
    if (method === 'GET' && parts.length === 5) {
      const raw = url.searchParams.get('task_id');
      return json(res, 200, store.collabComments(uid, pid, raw === null ? null : raw));
    }
    if (method === 'POST' && parts.length === 5) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        json(res, 201, store.collabAddComment(uid, pid, b));
      });
    }
  }
  // ⭐⭐ 0.8.12：附件列表（成员）与上传（成员）。
  //    ⚠️ 上传是**二进制**，不走 JSON body（现有 `readBody` 是 JSON 的）⇒
  //    `Content-Type: application/octet-stream` ＋ 查询串带元数据（`?name=&task_id=&report_id=&comment_id=`）。
  if (parts[4] === 'files') {
    if (method === 'GET' && parts.length === 5) return json(res, 200, store.collabFiles(uid, pid));
    if (method === 'POST' && parts.length === 5) {
      let plan;
      try {
        plan = store.collabPrepareFile(
          uid,
          pid,
          url.searchParams.get('name'),
          url.searchParams.get('task_id'),
          url.searchParams.get('report_id'),
          url.searchParams.get('comment_id'),
        );
      } catch (e) {
        return fail(res, e);
      }
      // ⚠️ 磁盘文件名只用 id ＋ 扩展名（入库后才有 id）⇒ 先写临时名，`collabSaveFile` 再改名。
      const tmpName = 'up-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      return readBodyToFile(req, res, {
        dir: plan.dir,
        name: tmpName,
        limit: FILE_MAX_BYTES,
        tooBigMsg: '文件太大（单个不超过 10 MB）',
        onDone: (info) => {
          const r = store.collabSaveFile(uid, pid, plan, info.path, info.size);
          json(res, 201, { item: r.item });
        },
      });
    }
  }
  // ⭐ 0.8.12：项目活动流水（判成员）。
  if (parts[4] === 'activity' && method === 'GET' && parts.length === 5) {
    return json(res, 200, store.collabActivity(uid, pid));
  }
  // ⭐ 0.8.12 看板取数：一次拿到 项目 / 状态集 / 五组 / 进度 / 成员 / 未知列。
  if (parts[4] === 'board' && method === 'GET' && parts.length === 5) {
    return json(res, 200, store.collabBoard(uid, pid));
  }
  // ⭐ 0.8.12 转让：**仅所有者**，目标必须是本项目成员。
  if (parts[4] === 'transfer' && method === 'POST' && parts.length === 5) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const target = idParam(String(b.user_id == null ? '' : b.user_id));
      if (target === null) throw httpError(400, 'bad body');
      writeResult(res, store.collabTransfer(uid, pid, target));
    });
  }
  if (parts[4] === 'reports' && method === 'GET' && parts.length === 5) {
    return json(res, 200, store.collabReports(uid, pid));
  }
  return notFound(res);
}

// ⚠️ 导出键 = `module.json` 的 `apiPrefix`（注册表按它自动挂上 `/api/teamwork`）；
//    SSE 长连接的入口在 `./stream.js`（`handleTeamworkStream`），由 `server.js` 的可选钩子单独取。
// ⭐⭐ 0.8.12：`collab` 是从 `modules/tasks/routes.js` **整份搬来**的
//    （接口路径 `/api/collab/*` 一个字节没改 —— `module.json` 的 `apiPrefix` 里已登记 `collab`）。
module.exports = { teamwork: handleTeamwork, collab: handleCollab };
