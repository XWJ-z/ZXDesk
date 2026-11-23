/**
 * modules/teamwork/routes.js —— 对话路由（好友 / 会话 / 消息）
 *
 * 功能：`handleTeamwork` 一处收全部对话接口 —— 好友总览与申请 / 同意 / 拒绝 / 删除 / 拉黑，
 * 会话列表与开设，消息的历史分页、增量补齐、发送与标记已读。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
// 0.6.x：消息的 SSE 推送口搬去 `./notify.js` —— 后台 ticker 也要用它，
// 而事件形状必须**只有一份**（见那个文件头的说明）。
const { pushTeamworkMessage: pushMessage } = require('./notify.js');
const stream = require('./stream.js');
// 协作附件上传的**上限常量**（与业务层单一出处）。
const { FILE_MAX_BYTES } = require('./lib/collab.js');
// 聊天图片的落盘口径（扩展名白名单 / 上限 / 内容寻址文件名 / 反解）—— 一处实现。
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
 * 收到 `abc` 时若当成「没带」，用户看到的是「翻页没反应」而不是「参数不对」。
 *
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
 * `/api/teamwork/friends` 即可 —— 少一处「哪些字段能给别人看」的重复答案（见文件头）。
 *
 */
function pushFriend(toUid, action, actorId) {
  // 009 报告 S3：store 传下去做「会话世代」复核（失效的连接不再收推送）
  return stream.pushToUsers([Number(toUid)], { type: 'friend', action, userId: Number(actorId) }, store);
}

/**
 * 功能：⭐ **错误出口的收口** —— 把业务层抛出的 404 / 429 映射成项目规定的两种响应形态。
 *
 * 说明：⚠️ 这一层不是装饰，而是**必须**的：
 * 业务层（本模块 `store.js`）抛的 404 是给**进程内调用方**用的（测试、将来的定时任务），
 * 它走 `fail()` 会带上 `readOnly` 之类的附加字段 —— 而 404 的响应体必须**逐字固定**
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
 * `GET    /api/teamwork/friends`                          好友总览（含待处理申请、会话与未读）
 * `POST   /api/teamwork/friends`                          发起好友申请 `{ username | userId }`
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

  // ：读一张聊天图片。
  // 判权 = **会话成员**（`teamworkConversationOr404()`，与读消息同一个口）⇒ 不是成员就是 404，
  // 与「这张图不存在」**逐字一致**（不给探测信号）。
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
          // 只有真的新发出了一条申请才打扰对方（幂等重发不推）。
          // 对方开着「自动通过」时 `status` 直接是 `accepted` ⇒ 推的是 `accepted`
          // （他那边要看到「你们已经是好友了」，而不是「有一条待处理申请」）。
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
      // 好友备注：**不推 SSE、也不打扰对方** —— 备注只写我这一行，
      // 对方那一行一个字节都没动，推给他反而是错的（他那边什么都不该变）。
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
          // 推送的事件体要带上**正文**：`teamworkSendMessage` 的返回值里只有 id / createdAt
          // `kind` / `meta` 不在这里补 —— `teamworkSendMessage` 的返回值里已经有了
          // （且 `meta` 已是对象），少写一处就少一个「REST 有、SSE 没有」的形状差异。
          const pushed = pushMessage(Object.assign({}, r, { body }), uid);
          // 内置角色会话的**自动回复** —— 与上面那条走**同一个推送口**
          // 「要不要回」的判据在 `teamworkSendMessage()` 里已经定了（`reply` 为 null 就是不回）。
          if (r.reply) pushMessage(r.reply, uid);
          return json(res, 201, {
            ok: true,
            id: r.id,
            conversationId: r.conversationId,
            createdAt: r.createdAt,
            pushed,
            // 回复**原样带回给前端**：它立刻就能把这句话画出来，不必等 SSE 绕一圈
            // （自己这一端也收得到推送，但等它到会有肉眼可见的延迟）
            reply: r.reply,
          });
        });
      }
      return notFound(res);
    }

    // ：**发图片** —— 原始字节 ＋ 查询串里的 `name`。
    // 流程与协作附件同一套：`readBodyToFile()` 边收边写临时文件 → 算 sha → 内容寻址改名。
    // `kind='image'` 的消息**只能**从这里造出来（它不在客户端可发白名单里）。
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
          // 推送要带 `body`（降级文本）—— 对面收到的是同一条消息，不能「REST 有、SSE 没有」
          const pushed = pushMessage(Object.assign({}, r, { body: `【图片】${rawName || '图片'}` }), uid);
          return json(res, 201, {
            ok: true,
            id: r.id,
            conversationId: r.conversationId,
            createdAt: r.createdAt,
            // `meta` 原样回给前端：图片的 `sha` 就在里面，缺了它前端画不出发出去的那一张
            // （只能等一次整屏重取才看得见自己的图 —— 那是肉眼可见的「发完没反应」）
            meta: r.meta,
            pushed,
          });
        },
      });
      return;
    }

    // 清掉「我这一侧」的一段聊天记录 —— ⚠️ 用 **POST 不是 DELETE**：
    // 它**必须写在 `if (parts[4] === 'messages')` 之外** —— 写进那一块里的话，
    // 只有 `parts[4] === 'messages'` 才会进来，`clear` 那条永远走不到（一路 404）。
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
  // 这两条刻意**不做成会话子路径**（`/api/teamwork/reminders/...`）：提醒设置是**账号级**的
  if (sub === 'reminder-prefs') {
    if (parts.length !== 3) return notFound(res);
    if (method === 'GET') return json(res, 200, { prefs: store.teamworkReminderPrefs(uid) });
    if (method === 'PUT') {
      return readBodySafe(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // 带哪个键写哪个键：校验与「只认带了的那几个键」都在 `checkReminderPrefs()` 一处。
        return json(res, 200, { ok: true, prefs: store.teamworkSetReminderPrefs(uid, checkReminderPrefs(b)) });
      });
    }
    return notFound(res);
  }

  // 与提醒设置同一条理由：**不做成会话子路径** —— 它是**账号级**的（一个账号一份）。
  if (sub === 'friend-prefs') {
    if (parts.length !== 3) return notFound(res);
    if (method === 'GET') return json(res, 200, { prefs: store.teamworkFriendPrefs(uid) });
    if (method === 'PUT') {
      return readBodySafe(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        // 带哪个键写哪个键，校验在 `checkFriendPrefs()` 一处
        return json(res, 200, { ok: true, prefs: store.teamworkSetFriendPrefs(uid, checkFriendPrefs(b)) });
      });
    }
    return notFound(res);
  }

  // 它真发消息（写库 + 推 SSE），所以是 POST；⚠️ **不写提醒流水**（理由见 store 的同名方法）。
  if (sub === 'reminder-test') {
    if (parts.length !== 3 || method !== 'POST') return notFound(res);
    const r = store.teamworkReminderTest(uid);
    // `senderId` 传的是**收件人自己**：内置角色消息的 `user_id` 就是会话归属者，
    // 前端靠事件体里的 `senderBuiltin` 把它画成「助手说的话」（见 `notify.js`）。
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

  // 两条都刻意**不做成会话子路径**：回收站是「我这一侧的全部清理记录」，与某个会话无关
  // （而「清理」本身必须带会话 id，它走 `conversations/:id/clear`）。
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
 *
 * 路由表（`parts = ['api','collab', …]`）——
 */
function handleCollab({ req, res, parts, method, url, uid }) {
  if (parts.length === 3 && parts[2] === 'projects' && method === 'GET') {
    return json(res, 200, store.listCollabProjects(uid));
  }
  // 【添加共享项目】→「选一个已有项目」那个列表 —— 我自己的、还没进协作的。
  // 判据（谁是我的）在服务端（`_bk.listProjects(uid)`），⛔ 前端别自己拉一份再筛。
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
  // 删评论 —— ⚠️ **仅作者**（连项目所有者也不行）。
  // 判权（是否存在 / 是不是成员 / 是不是作者）全在 store 层，路由只翻译 404。
  if (parts.length === 4 && parts[2] === 'comments' && method === 'DELETE') {
    const cid = idParam(parts[3]);
    if (cid === null) return notFound(res);
    return writeResult(res, store.collabRemoveComment(uid, cid));
  }
  // 附件 —— 下载（成员）与删除（**上传者自己 ＋ 项目所有者**）。
  // 下载**必须** `Content-Disposition: attachment`（本应用被飞牛桌面 iframe 嵌着 ⇒
  // 用户文件绝不能内联渲染），且**流式**回（⛔ 别把整个文件读进内存）。
  if (parts.length === 4 && parts[2] === 'files') {
    const fid = idParam(parts[3]);
    if (fid === null) return notFound(res);
    if (method === 'DELETE') return writeResult(res, store.collabRemoveFile(uid, fid));
    if (method === 'GET') {
      const d = store.collabDownloadFile(uid, fid);
      res.writeHead(200, {
        'Content-Type': d.mime || 'application/octet-stream',
        // 中文名必须走 `filename*`（`filename=` 只允许 ASCII），另留一个 ASCII 兜底名。
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
    // 单任务活动流水（`GET …/tasks/:tid/activity`）。
    if (method === 'GET' && parts.length === 7 && parts[6] === 'activity') {
      const tid = idParam(parts[5]);
      if (tid === null) return notFound(res);
      return json(res, 200, store.collabTaskActivity(uid, pid, tid));
    }
    if (method === 'GET' && parts.length === 5) return json(res, 200, store.collabTasks(uid, pid));
    // **任何成员**都可以在共享项目里发布任务（判权在 store 层）。
    // 三个「谁」由 store 写死（`user_id`＝所有者、`creator_id`＝调用者、`assignee_id` 缺省＝所有者），
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
    // ：删一条协作任务。
    // 判权（成员 → 所有者 / 创建者）、存在性、连带清理**全在 store 层**
    // （`collabRemoveTask()` → `deleteProjectTask()`）—— 本层只翻译 404，⛔ 不出现判断式。
    if (method === 'DELETE' && parts.length === 6) {
      const tid = idParam(parts[5]);
      if (tid === null) return notFound(res);
      return writeResult(res, store.collabRemoveTask(uid, pid, tid));
    }
  }
  // 状态集：读口判成员、写口判所有者 —— 判据全在 store 层。
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
  // 评论 —— 读口判成员（`?task_id=` 缺省只回项目级评论），
  // 写口判成员（任何成员都能发）。判权全在 store 层。
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
  // 附件列表（成员）与上传（成员）。
  // 上传是**二进制**，不走 JSON body（现有 `readBody` 是 JSON 的）⇒
  // `Content-Type: application/octet-stream` ＋ 查询串带元数据（`?name=&task_id=&report_id=&comment_id=`）。
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
      // 磁盘文件名只用 id ＋ 扩展名（入库后才有 id）⇒ 先写临时名，`collabSaveFile` 再改名。
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
  // 项目活动流水（判成员）。
  if (parts[4] === 'activity' && method === 'GET' && parts.length === 5) {
    return json(res, 200, store.collabActivity(uid, pid));
  }
  // 看板取数：一次拿到 项目 / 状态集 / 五组 / 进度 / 成员 / 未知列。
  if (parts[4] === 'board' && method === 'GET' && parts.length === 5) {
    return json(res, 200, store.collabBoard(uid, pid));
  }
  // 转让：**仅所有者**，目标必须是本项目成员。
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

// 导出键 = `module.json` 的 `apiPrefix`（注册表按它自动挂上 `/api/teamwork`）；
// SSE 长连接的入口在 `./stream.js`（`handleTeamworkStream`），由 `server.js` 的可选钩子单独取。
// `collab` 是从 `modules/tasks/routes.js` **整份搬来**的
// （接口路径 `/api/collab/*` 一个字节没改 —— `module.json` 的 `apiPrefix` 里已登记 `collab`）。
module.exports = { teamwork: handleTeamwork, collab: handleCollab };
