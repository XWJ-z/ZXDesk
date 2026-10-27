'use strict';
/**
 * modules/teamwork/lib/collab.js —— ⭐⭐ **协作（共享任务与上报）的判权地基**（0.8.10 追加批）
 *
 * ⭐ 0.8.12：本文件从 `modules/teamwork/lib/collab.js` **整份搬进本模块**，
 *    方法体一个字没改（纯归属搬家，判据与接口从此与「团队协作」住在同一个模块）。
 *    ⚠️ 唯一跟着变的只有相对路径与这段话：`./state-groups.js` 同在本模块 `lib/` 下，相对路径不变；
 *    `../../../core/store/helpers.js` 层级也不变（两个模块同在 `modules/` 下）。
 *    ⚠️⭐ A 的唯一真代价在此：**判权（本文件）与取数（`tasks` 的 `projects` / `project_tasks`）分居两个模块** ——
 *    本文件读那两张地基表时一律走 `tasks` 的**公开业务方法 / 取数原语**（`this.listProjectTasks`、
 *    `this._bk.findProjectById`、`this._bk.listProjects` 等），⛔ 不读它的表、⛔ 不 require 它的文件。
 *
 * 功能：本文件只做两件事 ——
 *      ① `taskShareGuard(uid, projectId)`：**全项目唯一的判权判据**，回答
 *         「这个人能不能看 / 写这个项目的共享任务与上报」（返回 `{ ok, role, project, reason }`）；
 *      ② 建立在这个判据之上的几个业务方法：协作项目列表 / 详情 / 任务 / 成员 / 上报。
 *
 * ⭐⭐ **判据只准一处**：⛔ **任何别的文件都不许自己拼
 *      `shared` + `project_members` + `user_id` 的条件**去判可见性 —— 那种副本的失效方式是**静默**的
 *      （某处漏了一个条件 ⇒ 越权读别人的任务，而且不报错）。要看能不能访问，
 *      **一律**经过 `_assertCollabVisible()` / `_assertCollabOwner()`（它们就是 guard 的两个出口）。
 *
 * ⭐⭐ **只看成员关系，⛔ 不看 `user_id`、⛔ 不给管理员开后门**：
 *      「不是这个项目的成员就看不到」—— 与「管理员也看不到成员的任务」那条红线同一条。
 *      ⛔ 「越权」与「不存在」**返回同一个 404**（403 等于告诉对方「这条存在、只是不归你」）。
 *
 * ⭐ **成员只能从「我的好友」里挑**：复用**本模块对话那一份**的既有业务方法
 *      `teamworkFriendsOverview(uid)`（**走既有接口、复用同一份判据**），
 *      ⛔ 不 require 别的模块的文件、⛔ 不读 / 不写它的表。
 *      ⚠️ 那个方法不在时（模块被拆走 / 缺装）这一条**明确报错**（⛔ 不静默放行陌生人）。
 *
 * ⭐ **上报「各报各的」**：一条任务可以有多条上报（一人一条时间线），
 *      ⛔ 不是「一条任务一个公共状态」—— 那会互相覆盖，也分不清是谁说的。
 *      这里额外给出「每人最新一条」（`latest`），界面直接用它拼「谁 · 什么状态 · 什么时候」。
 *
 * ⚠️ **第一版的边界**：共享任务**不进**别人的看板 / 日历 / 番茄钟 / 提醒，
 *      也**不进 AI 的可读面** —— 那些路径全部走原有的 `/api/projects/*` 与 `/api/tasks/*`，
 *      而它们仍然只按 `user_id` 过滤（一个字都没改）。共享面**只**出现在 `/api/collab/*`。
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.8.54
 * 相关：docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/31-协作与共享任务.md
 */

const { nowStamp, notFoundErr, badRequest, today, clampRange } = require('../../../core/store/helpers.js');
const { GROUP_KEYS, DEFAULT_STATES, groupOf, countsOf } = require('./state-groups.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 功能：把一个 `collab_states` 数据库行**归一成对外的状态项** —— ⭐ 数据库列名 `group_key`
 *      在这里改回 `group`（`group` 是 SQLite 保留关键字，见 `schema.js` 里那张表的说明）。
 * @param {Object} row - 数据库行
 * @returns {Object} `{ id, key, name, color, group, sort_order, is_default }`
 */
function stateOut(row) {
  const r = row || {};
  return {
    id: Number(r.id),
    key: String(r.key == null ? '' : r.key),
    name: String(r.name == null ? '' : r.name),
    color: r.color == null ? '' : String(r.color),
    group: String(r.group_key == null ? '' : r.group_key),
    sort_order: Number(r.sort_order) || 0,
    is_default: Number(r.is_default) ? 1 : 0,
  };
}

/** 上报的状态枚举（⛔ 不做百分比进度 —— 伪精确）。 @type {Array.<string>} */
const REPORT_STATUSES = ['todo', 'doing', 'blocked', 'done'];

/** 上报能挂在哪张任务表上（⚠️ 必须与 `task_id` **成对**）。 @type {Array.<string>} */
const REPORT_SOURCES = ['project_tasks', 'daily_tasks'];

/**
 * 评论正文的长度上限（⭐ 0.8.12）—— 超了回 400。
 * ⚠️ 与 `task_reports` 的 `note` 不同，评论是**主要输入**，给个上限挡住「整篇文章塞进一行」。
 * @type {number}
 */
const COMMENT_BODY_MAX = 2000;

// ---- ⭐⭐ 0.8.12：留言附件的落盘与白名单 ----

/** 附件落盘根目录名（在数据目录下，⛔ 绝不放 `app/`、⛔ 绝不放 `public/`）。 @type {string} */
const FILE_TEAMWORK_DIR = 'teamwork';

/** 磁盘文件名里 id 的补零位数（落盘布局，见方案 §戊-4）。 @type {number} */
const FILE_ID_WIDTH = 5;

/** 每个「id 分片」目录装多少个 id（避免单目录堆几万个文件）。 @type {number} */
const FILE_SHARD_SIZE = 100;

/** 单个附件上限：10 MB（方案 §戊-6，超限由读取器回 413）。 @type {number} */
const FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 附件类型白名单（方案 §戊-6）—— ⛔ 其余一律 400。
 * ⛔ **不收** `svg` / `html` / `exe` / `js`：可执行或可内联渲染的一律不收（内联＝XSS 与钓鱼面）。
 * @type {Array.<string>}
 */
const FILE_EXT_WHITELIST = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv', 'docx', 'xlsx', 'pptx', 'zip'];

/** 扩展名 → MIME（服务端派生；⛔ 不信客户端给的 Content-Type）。 @type {Object} */
const FILE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/**
 * 功能：取「id 分片」目录名 —— 每 `FILE_SHARD_SIZE` 个 id 一层（例：id 341 → `03`）。
 * @param {number} id - 附件 id
 * @returns {string} 分片目录名
 */
function fileShardOf(id) {
  return String(Math.floor(Number(id) / FILE_SHARD_SIZE)).padStart(2, '0');
}

/**
 * 功能：取磁盘文件名 —— **只用 id ＋ 扩展名**（例：id 341 + `.pdf` → `00341.pdf`），
 *      ⛔ **绝不用用户给的名字**（路径穿越 / 非法字符）。
 * @param {number} id - 附件 id
 * @param {string} ext - 小写扩展名（含点）
 * @returns {string} 磁盘文件名
 */
function fileDiskName(id, ext) {
  return String(Number(id)).padStart(FILE_ID_WIDTH, '0') + String(ext == null ? '' : ext);
}

/**
 * 功能：从一行附件记录取扩展名（小写、含点；取不到回空串）—— 磁盘路径要靠它还原。
 * @param {Object} row - `project_files` 行
 * @returns {string} 小写扩展名（含点）
 */
function fileExtOf(row) {
  return path.extname(String((row && row.name) == null ? '' : row.name)).toLowerCase();
}

/**
 * 功能：算一个附件在磁盘上的绝对路径 —— **落盘布局的唯一出处**（后端连带删除与业务层共用）。
 * @param {string} dataDir - 数据目录
 * @param {number} projectId - 项目 id
 * @param {number} id - 附件 id
 * @param {string} ext - 小写扩展名（含点）
 * @returns {string} 绝对路径
 */
function fileDiskPath(dataDir, projectId, id, ext) {
  return path.join(dataDir, FILE_TEAMWORK_DIR, String(Number(projectId)), fileShardOf(id), fileDiskName(id, ext));
}

/**
 * 功能：删掉一个附件在磁盘上的文件（删不到就忽略）—— 删一行时连带，供后端复用。
 * @param {string} dataDir - 数据目录
 * @param {Object} row - `project_files` 行
 * @returns {void}
 */
function removeFileDisk(dataDir, row) {
  if (!row) return;
  try {
    fs.unlinkSync(fileDiskPath(dataDir, row.project_id, row.id, fileExtOf(row)));
  } catch (_e) {
    /* 文件不在 / 已删：忽略（绝不因清理失败而中断删除） */
  }
}

/**
 * 功能：删掉一个项目的**整个附件目录**（删项目时连带，方案 §戊-7）。
 * @param {string} dataDir - 数据目录
 * @param {number} projectId - 项目 id
 * @returns {void}
 */
function removeProjectDir(dataDir, projectId) {
  try {
    fs.rmSync(path.join(dataDir, FILE_TEAMWORK_DIR, String(Number(projectId))), { recursive: true, force: true });
  } catch (_e) {
    /* 目录不在 / 被占用：忽略 */
  }
}

/**
 * 功能：算一个文件的 sha256（十六进制）—— 附件元数据（完整性留痕）。
 * @param {string} filePath - 文件绝对路径
 * @returns {string} 十六进制摘要
 */
function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 功能：把一行附件记录归一成对外形状（补上传者显示名；注销账号显示「已注销成员」）。
 * @param {Object} row - `project_files` 行
 * @param {Map.<number, Object>} usersById - 账号 id → 账号行
 * @returns {Object} `{ id, project_id, task_id, report_id, comment_id, uploader_id, uploader_name, name, mime, size, sha256, created_at }`
 */
function fileOut(row, usersById) {
  const r = row || {};
  const u = (usersById || new Map()).get(Number(r.uploader_id)) || {};
  return {
    id: Number(r.id),
    project_id: Number(r.project_id),
    // ⚠️ 先挡 null / ''（`Number(null) === 0` 是有限数，会静默把项目级附件算到 0 号任务上）。
    task_id: r.task_id == null || r.task_id === '' ? null : Number(r.task_id),
    report_id: r.report_id == null || r.report_id === '' ? null : Number(r.report_id),
    // ⭐ 0.8.12：同理，先挡 null / '' —— 附件靠它归位到「某条评论」下面。
    comment_id: r.comment_id == null || r.comment_id === '' ? null : Number(r.comment_id),
    uploader_id: Number(r.uploader_id),
    uploader_name: u.display_name || u.username || '（已注销成员）',
    name: String(r.name == null ? '' : r.name),
    mime: r.mime == null ? '' : String(r.mime),
    size: Number(r.size) || 0,
    sha256: r.sha256 == null ? '' : String(r.sha256),
    created_at: r.created_at == null ? '' : String(r.created_at),
  };
}

/**
 * 功能：递归列出附件根目录下的全部文件绝对路径（孤儿巡检用；目录不在就回空数组）。
 * @param {string} dir - 待遍历目录
 * @param {Array.<string>} [out] - 收集结果
 * @returns {Array.<string>} 文件绝对路径数组
 */
function walkFiles(dir, out) {
  const acc = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

/**
 * 功能：判断一个人能不能看 / 写某个项目的共享内容 —— **全项目唯一的判权判据**。
 *
 * 说明：⭐⭐ 判据只有两条分支，**顺序不能颠倒**：
 *      ① `project.user_id === uid` ⇒ 这是**我自己的项目**（`role: 'owner'`）——
 *         ⚠️ **不看 `shared`**：我自己的项目当然看得见，共享只是「有没有给别人看」；
 *      ② 否则，必须**同时**满足「项目现在共享着」与「我在成员名单里」⇒ `role: 'member'`。
 *      ⚠️ 为什么两条都要（缺一条的失效方式）：只有成员不看 `shared` ⇒ 所有者一关共享，
 *        成员**照样看得见**（那是本版最重要的一条验收）；只有 `shared` 不看成员 ⇒ **所有人都看得见**。
 *      ⚠️ ⛔ 这里**没有**「是不是管理员」这一支 —— 管理员不是成员就看不到。
 *
 * @param {number} uid - 账号 id
 * @param {number} projectId - 项目 id
 * @returns {{ok: boolean, role: ?string, project: ?Object, reason: string}} 判权结果
 */
function taskShareGuard(uid, projectId) {
  const me = Number(uid);
  const project = this._bk.findProjectById(projectId);
  if (!project) return { ok: false, role: null, project: null, reason: 'missing' };
  if (Number(project.user_id) === me) return { ok: true, role: 'owner', project, reason: 'owner' };
  if (Number(project.shared) !== 1) return { ok: false, role: null, project, reason: 'not-shared' };
  const isMember = this._bk.listProjectMembers(project.id).some((m) => Number(m.user_id) === me);
  if (!isMember) return { ok: false, role: null, project, reason: 'not-member' };
  return { ok: true, role: 'member', project, reason: 'member' };
}

/**
 * 功能：判权结果的**唯一出口之一** —— 看不到 / 不存在一律抛 404（响应逐字一致）。
 * @param {number} uid - 账号 id
 * @param {number} projectId - 项目 id
 * @returns {Object} `{ role, project }`
 * @throws {Error} 任何人看不到时抛 404（⛔ 不区分「不存在」「没共享」「不是成员」）
 */
function assertCollabVisible(uid, projectId) {
  const g = module.exports.taskShareGuard.call(this, uid, projectId);
  if (!g.ok) throw notFoundErr('这个共享项目');
  return { role: g.role, project: g.project };
}

/**
 * 功能：判权结果的**另一个出口** —— 非项目所有者一律抛 404（改共享开关 / 改成员名单用）。
 * @param {number} uid - 账号 id
 * @param {number} projectId - 项目 id
 * @returns {Object} `{ role, project }`
 * @throws {Error} 不是所有者时抛 404
 */
function assertCollabOwner(uid, projectId) {
  const g = module.exports.taskShareGuard.call(this, uid, projectId);
  if (!g.ok || g.role !== 'owner') throw notFoundErr('这个共享项目');
  return { role: g.role, project: g.project };
}

/**
 * 功能：取**本模块对话那一份**的好友总览（既有业务方法）—— 拿不到时**明确报错**，⛔ 不静默放行。
 *
 * 说明：⭐⭐ 这是协作这一层对对话那一层**唯一**的一处调用，走的是它的**公开业务方法**
 *      （复用同一份判据），⛔ 不是 require 别的文件、⛔ 不是读它的表。
 *      ⚠️ `teamworkFriendsOverview` 不存在时（缺装 / 模块被拆）—— 那种情况下**不许**把
 *      「加成员」当成「随便哪个 id 都行」放过去（那等于让陌生人进项目）⇒ 抛 503 并说明原因。
 *
 * @param {number} uid - 账号 id
 * @returns {Array.<Object>} 已接受的好友（`{ id, username, display_name }`）
 * @throws {Error} 对话模块不在时抛 503
 */
function friendCandidates(uid) {
  if (typeof this.teamworkFriendsOverview !== 'function') {
    const err = new Error('「协作」暂时不可用：好友功能不在这台设备上');
    err.status = 503;
    throw err;
  }
  const ov = this.teamworkFriendsOverview(Number(uid)) || {};
  const rows = Array.isArray(ov.friends) ? ov.friends : [];
  return rows
    .map((f) => f && f.user)
    .filter(Boolean)
    .map((u) => ({ id: Number(u.id), username: u.username, display_name: u.display_name || u.username }));
}

module.exports = {
  REPORT_STATUSES,
  REPORT_SOURCES,
  COMMENT_BODY_MAX,

  taskShareGuard,

  /**
   * 功能：列出「我能看到」的共享项目 —— 我自己**开了共享**的项目 ＋ 我作为**成员**加入的项目。
   *
   * 说明：⚠️ 两侧都要在服务端过滤（不能靠前端），而且成员那一侧必须带上 `shared = 1`
   *      （所有者一关共享，成员立刻看不到 —— 方案 §五·2）。
   * @param {number} uid - 账号 id
   * @returns {{items: Array.<Object>, mine: Array.<Object>}} 我看到的两类共享项目
   */
  listCollabProjects(uid) {
    // ⭐ 0.8.12：**只回「已被添加进协作」的我自己的项目**。
    //
    // ⚠️⭐ 这一行**推翻了 的 `C-13`**（原口径：`mine` ＝ 我的**全部**项目）。
    //    当初那么写的理由是「『把某个项目设为共享』这件事只能在协作那一块做，⛔ 若只回共享的，
    //    用户就**永远开不了共享**（一个**真**的功能闭环缺口）」—— 那个缺口是**真的**，
    //    但否掉了「把全部项目都列出来」这个解法：产品上不接受协作里堆着没进协作的项目。
    //    ⇒ 缺口改由**显式入口**解决：【添加共享项目】（选现有 / 新建），见两端片段的同一个函数。
    //
    // ⚠️⭐ **判据一个字没动**（§丙-1 我自己定的第 1 条）：`taskShareGuard()` 第 2 条仍然是
    //    「`project.user_id === uid` ⇒ 放行，**不看 `shared`**」—— 否则项目一移出协作，
    //    所有者就再也加不回来（那才是闭环缺口的**真身**）。本次**只改列表这一处**。
    //
    // ⚠️ 存量行为：已经 `shared = 1` 的照旧显示；**从没开过共享的账号，这一节会变成空的**
    //    —— 那是正确行为（空态文案已改成指向【添加共享项目】），⛔ 不是回归。
    const mine = this._bk
      .listProjects(Number(uid))
      .filter((p) => Number(p.shared) === 1)
      .map((p) => Object.assign({}, p, { role: 'owner' }));
    // ⚠️⭐ `listProjectsOfMember()` 只按「我在成员名单里 且 项目还共享着」取数，**不认识**「这个项目
    //    已经是我自己的了」—— 而**转让**恰好会造出这种形状：新所有者仍是 `project_members` 里的一行
    //    （转让刻意不动成员名单，见 `collabTransfer()`），于是 `mine` 与 `joined` 会命中**同一条项目**。
    //    症状是左栏「协作项目」组里出现**两条一模一样的行**（键相同、副标题一个「我发起的」一个
    //    「我参与的」），点哪条都对、看着却像数据坏了。⇒ 这里按 id 去重：**所有者那一侧优先**
    //    （它在判权里是 `role:'owner'`，语义更强）。⚠️ 判据仍只有 `taskShareGuard()` 一处，
    //    这里只是「同一个项目在清单里只出现一次」的呈现口径。
    const mineIds = new Set(mine.map((p) => Number(p.id)));
    const joined = this._bk
      .listProjectsOfMember(Number(uid))
      .filter((p) => !mineIds.has(Number(p.id)))
      .map((p) => Object.assign({}, p, { role: 'member' }));
    return { items: mine.concat(joined), mine };
  },

  /**
   * 功能：取**我自己的、还没加进协作的**项目 —— 【添加共享项目】→「选一个已有项目」那个列表（⭐ 0.8.12）。
   *
   * 说明：⭐⭐ **判据（谁是我的）只住服务端**：这里直接用 `_bk.listProjects(uid)`（它本身就只回我的），
   *      再按 `shared !== 1` 过滤 —— ⛔ 前端**不许**自己去 `/api/projects` 拉一份再筛
   *      （那就成了第二份判据，而副本的失效方式是静默的：某天 `listProjects` 的语义一改，
   *      协作里就会冒出别人的项目）。
   *      ⚠️ 为什么**不**新开一条 `/api/collab/*` 的路由：这一条读口只服务「添加」那个弹层，
   *      形状与 `/api/collab/projects` 完全一致（同一份 `role` 口径），放进同一族更好找。
   *
   * @param {number} uid - 账号 id
   * @returns {{ items: Array.<Object> }} 我自己的、`shared !== 1` 的项目（每行带 `role: 'owner'`）
   */
  collabAddableProjects(uid) {
    const items = this._bk
      .listProjects(Number(uid))
      .filter((p) => Number(p.shared) !== 1)
      .map((p) => Object.assign({}, p, { role: 'owner' }));
    return { items };
  },

  /**
   * 功能：取一个共享项目的详情（判权后）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {Object} `{ project, role, memberCount }`
   * @throws {Error} 看不到时抛 404
   */
  collabProject(uid, projectId) {
    const { role, project } = assertCollabVisible.call(this, uid, projectId);
    // ⚠️ 与 `collabMembers()` 同一个口径：**成员数不含所有者**（转让后他会留在 `project_members`
    //    里，照 `length` 数会**多算一个人** —— 成员弹层写「共 N 人」、详情写 `memberCount`，两处必须同源）。
    const ownerId = Number(project.user_id);
    const memberCount = this._bk.listProjectMembers(project.id).filter((m) => Number(m.user_id) !== ownerId).length;
    return {
      project: Object.assign({}, project, { role }),
      role,
      memberCount,
    };
  },

  /**
   * 功能：列出一个共享项目下的任务（判权后）。
   *
   * 说明：⚠️ 任务行归**项目所有者**所有（`user_id` 是所有者）⇒ 这里用 `project.user_id` 去读
   *      原有那份业务方法（`listProjectTasks` 按 `user_id + project_id` 过滤），
   *      ⛔ 不新写一条「按 project_id 查任务」的 SQL（那会变成第二份取数判据）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} 任务行数组
   * @throws {Error} 看不到时抛 404
   */
  collabTasks(uid, projectId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    return this.listProjectTasks(project.user_id, project.id);
  },

  /**
   * 功能：改一条共享任务 —— ⭐ 按「组」判权：成员可以改到**非完成组**的状态、
   *      可以改负责人 / 标题 / 描述 / **任务日与截止日**；**改到 `completed` 组仅项目所有者**（＝验收）。
   *
   * 说明：⚠️ 先确认这条任务**真的属于这个项目**（⛔ 否则可以拿别人的项目 id 去改另一个项目的任务）。
   *      ⚠️ 写的时候用 `project.user_id`（任务行的归属）—— 任务仍然属于所有者，成员只是代改。
   *      ⭐ **完成时间按组维护**（`completed_at`）：迁进/迁出 `completed` 组时补写 / 清空，
   *      而不是靠 `status === 'done'` —— 自定义的完成态 key 也照样对（复用纯函数判组）。
   *      ⚠️ `assignee_id` 传 `null` / 空 ⇒ 回落到**项目所有者**（与「新建任务缺省负责人」同一口径）。
   *      ⭐⭐ 0.8.51（任务详情也要能编辑）：标题 / 描述 / 两个日期都走 `updateProjectTask()`，
   *      与任务板**同一套白名单与同一套 `completed_at` 维护** —— 协作侧只是另一个入口，
   *      不是第二份任务。⚠️ 日期区间在下面**按合并之后的值**再校验一次（理由见那段注释）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} taskId - 任务 id
   * @param {Object} input - 已由 `validate.checkProjectTask` 归一化
   * @returns {boolean} 是否真的更新到了
   * @throws {Error} 看不到 / 任务不属于该项目 / 越权到完成组时抛 404；负责人非法 / 日期区间倒挂时抛 400
   */
  collabUpdateTask(uid, projectId, taskId, input) {
    const { role, project } = assertCollabVisible.call(this, uid, projectId);
    // ⭐ 0.8.12：这条是**写**路径，老库上「改状态 = 写流水」之前必须先把
    //    `task_reports.status` 上那条窄 CHECK 去掉（否则写 `backlog` 这类状态当场 500）。
    this._migrateCollabProject(project);
    const prev = this.listProjectTasks(project.user_id, project.id).find((t) => Number(t.id) === Number(taskId));
    if (!prev) throw notFoundErr('这条任务');
    const states = this._bk.listCollabStates(project.id).map(stateOut);
    const cur = Object.assign({}, input);
    // ⚠️⭐ 2026-10-20（本版质检）：**空状态键一律 400**，绝不落库。
    //    病根在前端那张卡片弹层：任务的状态**不在本项目状态集里**（老脏数据 / 状态被删过）时，
    //    下拉里那个 `value=""` 的占位项会被当成「用户选过」⇒ 发上来的 `status` 是空串。
    //    从前这里照单全收 ⇒ 那条任务的真实状态被**静默抹成空串**（`groupOf('')` 又把它算进
    //    「未开始」组，于是它在看板里从「未知状态」列**悄悄搬家**，谁也没点过任何东西）。
    //    前端两处已改成「空值不发」（`saveCard()`），这里再挡一道：**空状态不是一个状态**。
    //    ⚠️ 只挡空串，**不挡**「不在状态集里的历史键」—— 那是零迁移允许存在的存量数据。
    if (cur.status !== undefined && String(cur.status == null ? '' : cur.status).trim() === '') {
      throw badRequest('状态不能为空');
    }
    if (cur.status !== undefined) {
      const key = String(cur.status == null ? '' : cur.status);
      const g = groupOf(key, states);
      if (g === 'completed' && role !== 'owner') throw notFoundErr('这条任务');
      // 完成时间按**组**的跃迁维护（同一人可自报自验，不额外拦）
      const wasDone = groupOf(String(prev.status == null ? '' : prev.status), states) === 'completed';
      if (g === 'completed' && !wasDone) cur.completed_at = nowStamp();
      else if (g !== 'completed' && wasDone) cur.completed_at = null;
    }
    if (cur.assignee_id === null || cur.assignee_id === '') cur.assignee_id = Number(project.user_id);
    if (cur.assignee_id !== undefined) cur.assignee_id = this._resolveAssignee(project, cur.assignee_id);
    // ⚠️⭐ 0.8.51（「团队协作的任务详情也要可以编辑任务」）：**日期区间按合并之后的样子校验**。
    //    `validate.badDateRange()` 只在「两个日期都在请求里」时才比大小（局部更新的口径），
    //    而「只改截止日」是一条完全正常的编辑 ⇒ 必须拿库里那一行补齐另一边再比，
    //    否则会静默落一条「任务日 > 截止日」的倒挂数据（甘特条会被换头、看板判据也不认它）。
    //
    // ⭐⭐ 0.8.53（待排期单列）：**迁入「待排期」组 ⇒ 日期一起清空**。
    //    「待排期」的语义就是「还没排期」，带着日期的待排期任务会在转任务时冒出旧日期，
    //    也会让「待排期没有日期」这条口径出现第二份真相。
    //    ⚠️ 只在**真的从别组迁进来**时清（本来就待排期、只是改个标题 ⇒ 一个字节都不动）。
    //    ⚠️ 清空必须发生在下面那段区间校验**之前**：校验读的是 `cur`，留着旧日期会误报倒挂。
    const wasGroup = groupOf(String(prev.status == null ? '' : prev.status), states);
    const nextGroup = cur.status !== undefined ? groupOf(String(cur.status), states) : wasGroup;
    if (nextGroup === 'backlog' && wasGroup !== 'backlog') {
      cur.start_date = null;
      cur.due_date = null;
    }
    if (cur.start_date !== undefined || cur.due_date !== undefined) {
      const s = String((cur.start_date !== undefined ? cur.start_date : prev.start_date) || '');
      const e = String((cur.due_date !== undefined ? cur.due_date : prev.due_date) || '');
      if (s && e && s > e) throw badRequest('任务日不能晚于截止日期');
    }
    const changed = this.updateProjectTask(project.user_id, taskId, cur);
    // ⭐⭐ 0.8.12：每次**改任务状态**自动写一条活动流水 ——
    //    与状态一起落库；⚠️ 状态**没变**时不写（避免刷屏）。`from_status` 取自改之前的那一行
    //    （上面 `prev` 已读好，等于「同一拍里先读旧值再写新值」）。
    if (changed && cur.status !== undefined) {
      const from = String(prev.status == null ? '' : prev.status);
      const to = String(cur.status == null ? '' : cur.status);
      if (from !== to) {
        this._insert('task_reports', {
          user_id: Number(uid),
          task_source: 'project_tasks',
          task_id: Number(taskId),
          project_id: Number(project.id),
          from_status: from,
          status: to,
          note: cur.note == null ? '' : String(cur.note),
          created_at: nowStamp(),
        });
      }
    }
    return changed;
  },

  /**
   * 功能：列出一个共享项目的成员名单（判权后）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {Array.<Object>} `[{ user_id, display_name, username, created_at }]`
   * @throws {Error} 看不到时抛 404
   */
  collabMembers(uid, projectId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    const who = (id) => {
      const u = usersById.get(Number(id));
      return u ? { username: u.username, display_name: u.display_name || u.username } : {};
    };
    const owner = { user_id: Number(project.user_id), role: 'owner', ...who(project.user_id) };
    // ⚠️⭐ 所有者**不进成员名单**（他是 `role: 'owner'`，本来就不在 `project_members` 里）——
    //    但**转让**会造出「新所有者仍然躺在成员表里」这种形状（转让刻意不动成员名单）。
    //    不过滤就会在成员弹层里出现**同一个人两行**（一行「我 / 发起人」、一行「我」），
    //    看着像多了个重名账号。⇒ 按 user_id 与所有者比对，重复的那一行不画。
    const ownerId = Number(project.user_id);
    const members = this._bk
      .listProjectMembers(project.id)
      .filter((m) => Number(m.user_id) !== ownerId)
      .map((m) => ({ user_id: Number(m.user_id), role: 'member', created_at: m.created_at, ...who(m.user_id) }));
    return [owner].concat(members);
  },

  /**
   * 功能：项目所有者把**好友**加进项目（幂等：已在名单里就原样返回）。
   *
   * 说明：⭐ 只能从**我的好友**里挑：普通用户看不到本机有哪些账号，
   *      凭空拉人 = 陌生人能进你的项目。
   *      ⚠️ 不允许把所有者自己加进名单（他是 `role: 'owner'`，不在成员表里）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} memberId - 要加的人
   * @returns {Object} `{ added: boolean, user_id }`
   * @throws {Error} 不是所有者 / 不是好友时抛 404 或 400
   */
  collabAddMember(uid, projectId, memberId) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    const mid = Number(memberId);
    if (mid === Number(project.user_id)) {
      const err = new Error('项目所有者本来就在里面，不用再加');
      err.status = 400;
      throw err;
    }
    const friend = friendCandidates.call(this, uid).some((f) => Number(f.id) === mid);
    if (!friend) {
      // ⚠️ 与「这个人不存在」同一个出口 —— 不给「他在本机上但不是我好友」这个探测信号
      const err = new Error('只能把好友加进项目');
      err.status = 404;
      throw err;
    }
    if (this._bk.listProjectMembers(project.id).some((m) => Number(m.user_id) === mid)) {
      return { added: false, user_id: mid };
    }
    this._insert('project_members', {
      project_id: Number(project.id),
      user_id: mid,
      created_at: nowStamp(),
    });
    return { added: true, user_id: mid };
  },

  /**
   * 功能：项目所有者把一个人移出项目。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} memberId - 要移出的人
   * @returns {boolean} 是否真的移出了一行
   * @throws {Error} 不是所有者时抛 404
   */
  collabRemoveMember(uid, projectId, memberId) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    return this._bk.deleteProjectMember(project.id, Number(memberId));
  },

  /**
   * 功能：项目所有者开关「共享」（⛔ 关掉之后成员**立刻**看不到 —— 方案 §五·2）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {boolean} shared - 开 / 关
   * @returns {Object} 更新后的项目行
   * @throws {Error} 不是所有者时抛 404
   */
  collabSetShared(uid, projectId, shared) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    this._update('projects', Number(uid), project.id, { shared: shared ? 1 : 0 });
    return Object.assign({}, project, { shared: shared ? 1 : 0 });
  },

  /**
   * 功能：列出某个共享项目下**全部任务**的上报，并额外给出「每人最新一条」。
   *
   * 说明：⭐ 界面要的是「谁 · 什么状态 · 什么时候」⇒ 服务端把 `latest` 算好（判据只准一处）。
   *      ⚠️ 任务 id 从项目里取，再按 `task_source + task_id` 成对查。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {{reports: Array.<Object>, latest: Object}} 全部上报 + `{ [任务id]: { [用户id]: 最新一条 } }`
   * @throws {Error} 看不到时抛 404
   */
  collabReports(uid, projectId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const tasks = this.listProjectTasks(project.user_id, project.id);
    const reports = this._bk.listTaskReportsForTasks(
      'project_tasks',
      tasks.map((t) => Number(t.id)),
    );
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    const decorated = reports.map((r) =>
      Object.assign({}, r, {
        display_name: (usersById.get(Number(r.user_id)) || {}).display_name || '（已删除的账号）',
      }),
    );
    const latest = {};
    for (const r of decorated) {
      const key = String(r.task_id);
      if (!latest[key]) latest[key] = {};
      latest[key][String(r.user_id)] = r;
    }
    return { reports: decorated, latest };
  },

  /**
   * 功能：我（成员或所有者）就某条**共享项目里的任务**上报一个状态。
   *
   * 说明：⭐⭐ **上报只对共享项目开放**：判权走同一个 guard ——
   *      项目没共享 ⇒ 404（不是「只有自己时也能报」）。
   *      ⚠️ 日常任务（`daily_tasks`）没有项目 ⇒ 查不到项目 ⇒ 一律 404：
   *      「一条只有自己看得见的任务」上报没有意义，这一条**不是缺陷**。
   * @param {number} uid - 账号 id
   * @param {Object} input - 已由 `validate.checkTaskReport` 归一化
   * @returns {Object} 新建的上报行
   * @throws {Error} 任务不存在 / 项目没共享 / 不是成员时抛 404
   */
  collabAddReport(uid, input) {
    this._assertWritable();
    const src = String(input.task_source || '');
    const tid = Number(input.task_id);
    let project = null;
    if (src === 'project_tasks') {
      const task = this._bk.findTask('project_tasks', Number(uid), tid);
      // ⚠️ `findTask` 按 `user_id + id` 找 —— 成员报的是**别人的**任务，所以改成按项目反查：
      const owned = task || null;
      project = owned ? this._bk.findProjectById(owned.project_id) : null;
      if (!project) {
        // 兜底：任务不属于我 ⇒ 通过「我是成员的那些共享项目」反查它属于哪个项目
        const joined = this._bk.listProjectsOfMember(Number(uid));
        const mineShared = this._bk.listProjects(Number(uid)).filter((p) => Number(p.shared) === 1);
        for (const p of joined.concat(mineShared)) {
          if (this.listProjectTasks(p.user_id, p.id).some((t) => Number(t.id) === tid)) {
            project = p;
            break;
          }
        }
      }
    }
    if (!project) throw notFoundErr('这条任务');
    const { project: p } = assertCollabVisible.call(this, uid, project.id);
    if (Number(p.shared) !== 1) throw notFoundErr('这条任务');
    const row = {
      user_id: Number(uid),
      task_source: src,
      task_id: tid,
      // ⭐ 0.8.12：新上报也带上 `project_id`（老上报由懒迁移补，两边口径一致）。
      project_id: Number(project.id),
      status: String(input.status),
      note: input.note == null ? '' : String(input.note),
      created_at: nowStamp(),
    };
    return this._insert('task_reports', row);
  },

  /**
   * 功能：删掉**我自己**的一条上报（⛔ 删不到别人的 —— 原语带 `user_id` 过滤）。
   * @param {number} uid - 账号 id
   * @param {number} id - 上报 id
   * @returns {boolean} 是否真的删掉了一行
   */
  collabRemoveReport(uid, id) {
    this._assertWritable();
    return this._bk.deleteTaskReport(Number(uid), id);
  },

  // ---- ⭐⭐ 0.8.12：评论（项目级 ＋ 任务级）----

  /**
   * 功能：列出一个共享项目的评论（判权后）—— `taskId` 缺省 ⇒ **只回项目级**；给了 ⇒ 只回该任务的。
   *
   * 说明：⭐ **一张表装两级评论**，级差只看 `task_id` 是否为空（见 `schema.js` 的 `project_comments`）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {?number} [taskId] - 任务 id；缺省 / 空 ⇒ 项目级评论
   * @returns {{items: Array.<Object>}} 评论项数组（按时间正序）
   * @throws {Error} 看不到时抛 404；`taskId` 非法时抛 400
   */
  collabComments(uid, projectId, taskId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    let want = null;
    if (!(taskId === undefined || taskId === null || taskId === '')) {
      want = Number(taskId);
      if (!Number.isInteger(want) || want < 1) throw badRequest('任务编号不合法');
    }
    const items = this._bk
      .listProjectComments(project.id)
      .filter((c) => (want === null ? c.task_id == null || c.task_id === '' : Number(c.task_id) === want))
      .map((c) => this._commentOut(c, usersById));
    return { items };
  },

  /**
   * 功能：成员就某个共享项目（或它的一条任务）发一条评论。
   *
   * 说明：⚠️ 任务级评论要**先确认这条任务真的属于这个项目**（否则能拿别的项目的任务 id 挂评论）。
   *      ⚠️ 正文**纯文本**（⛔ 不做 markdown 渲染），空 / 超 2000 字回 400。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {Object} input - `{ task_id?, body }`
   * @returns {{item: Object}} 新建的评论项（带作者名）
   * @throws {Error} 看不到 / 任务不属于该项目时抛 404；正文非法 / 任务编号非法时抛 400
   */
  collabAddComment(uid, projectId, input) {
    this._assertWritable();
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const src = input && typeof input === 'object' ? input : {};
    const body = String(src.body == null ? '' : src.body).trim();
    if (!body) throw badRequest('评论内容不能为空');
    if (body.length > COMMENT_BODY_MAX) throw badRequest('评论太长（最多 ' + COMMENT_BODY_MAX + ' 字）');
    let taskId = null;
    if (!(src.task_id === undefined || src.task_id === null || src.task_id === '')) {
      const n = Number(src.task_id);
      if (!Number.isInteger(n) || n < 1) throw badRequest('任务编号不合法');
      if (!this.listProjectTasks(project.user_id, project.id).some((t) => Number(t.id) === n)) {
        throw notFoundErr('这条任务');
      }
      taskId = n;
    }
    const item = this._insert('project_comments', {
      project_id: Number(project.id),
      task_id: taskId,
      user_id: Number(uid),
      body,
      created_at: nowStamp(),
    });
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    return { item: this._commentOut(item, usersById) };
  },

  /**
   * 功能：删一条评论 —— ⚠️ **仅作者**（连项目所有者也不能删别人的，/ 105）。
   *
   * 说明：⭐⭐ 两道判权都走**判据唯一出口**：① 先过 `assertCollabVisible`（不是成员 ⇒ 404）；
   *      ② 再比作者（不是作者 ⇒ **同一个 404**，⛔ 不给「这条存在」的探测信号）。
   * @param {number} uid - 账号 id
   * @param {number} id - 评论 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 评论不存在 / 不是成员 / 不是作者时抛 404
   */
  collabRemoveComment(uid, id) {
    this._assertWritable();
    const c = this._bk.findCommentById(Number(id));
    if (!c) throw notFoundErr('这条评论');
    assertCollabVisible.call(this, uid, c.project_id);
    if (Number(c.user_id) !== Number(uid)) throw notFoundErr('这条评论');
    return this._bk.deleteComment(Number(id), Number(uid));
  },

  // ---- ⭐⭐ 0.8.12：留言与流水的**附件**（文件子系统）----
  //    ⚠️ 判权一律先过 `assertCollabVisible`（判据只准一处）；⛔ 上传者 / 所有者的区分只在这一层。

  /**
   * 功能：列出某个共享项目的附件（判权后）＋ **每个成员上传了多少字节**（只统计、不限额）。
   *
   * 说明：⭐ §戊-8-2：1 期**只统计不限额** —— 界面给出「每个成员上传了多少」，`used` 就是这个口径。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {{items: Array.<Object>, used: Object}} 附件项数组 ＋ `{ [uploader_id]: bytes }`
   * @throws {Error} 看不到时抛 404
   */
  collabFiles(uid, projectId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    const used = {};
    const items = this._bk.listProjectFiles(project.id).map((row) => {
      const item = fileOut(row, usersById);
      const k = String(item.uploader_id);
      used[k] = (used[k] || 0) + item.size;
      return item;
    });
    return { items, used };
  },

  /**
   * 功能：上传前的**校验与落点计算**（判权 ＋ 白名单 ＋ 任务/流水/评论编号），返回给路由去边收边写盘。
   *
   * 说明：⚠️ 磁盘文件名要用**附件 id**，而 id 是入库后才有的 ⇒ 上传分两步：本方法只算目录与
   *      校验元数据，字节由路由的 `readBodyToFile()` 写进临时文件，`collabSaveFile()` 再入库
   *      并把文件移到最终路径（`<id 分片>/<id><扩展名>`）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {string} rawName - 用户给的原文件名（只用于取扩展名与显示）
   * @param {*} [rawTaskId] - 查询串里的 `task_id`（空 ⇒ 项目级附件）
   * @param {*} [rawReportId] - 查询串里的 `report_id`（空 ⇒ 不挂在某条流水上）
   * @param {*} [rawCommentId] - 查询串里的 `comment_id`（空 ⇒ 不挂在某条评论上）
   * @returns {Object} `{ project, name, ext, mime, taskId, reportId, commentId, dir }`
   * @throws {Error} 看不到 / 任务不属于该项目时抛 404；类型不支持 / 编号非法 / 缺文件名 /
   *      评论不存在或属于别的项目时抛 400
   */
  collabPrepareFile(uid, projectId, rawName, rawTaskId, rawReportId, rawCommentId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const name = String(rawName == null ? '' : rawName).trim();
    if (!name) throw badRequest('缺少文件名');
    const ext = path.extname(name).toLowerCase();
    if (!FILE_EXT_WHITELIST.includes(ext.replace('.', ''))) throw badRequest('这种文件类型不支持');
    let taskId = null;
    if (!(rawTaskId === undefined || rawTaskId === null || rawTaskId === '')) {
      const n = Number(rawTaskId);
      if (!Number.isInteger(n) || n < 1) throw badRequest('任务编号不合法');
      if (!this.listProjectTasks(project.user_id, project.id).some((t) => Number(t.id) === n)) {
        throw notFoundErr('这条任务');
      }
      taskId = n;
    }
    let reportId = null;
    if (!(rawReportId === undefined || rawReportId === null || rawReportId === '')) {
      const r = Number(rawReportId);
      if (!Number.isInteger(r) || r < 1) throw badRequest('流水编号不合法');
      reportId = r;
    }
    // ⭐ 0.8.12：附件跟着评论走 —— `comment_id` 必须是**这个项目**里的一条评论。
    //    ⚠️ 跨项目 / 不存在**一律 400**（契约 §2）：编号非法、评论不存在、评论属于别的项目
    //    三种情况回同一句话 —— 不给「这条评论存在、只是不属于你」的探测信号。
    let commentId = null;
    if (!(rawCommentId === undefined || rawCommentId === null || rawCommentId === '')) {
      const cid = Number(rawCommentId);
      if (!Number.isInteger(cid) || cid < 1) throw badRequest('评论编号不合法');
      const c = this._bk.findCommentById(cid);
      if (!c || Number(c.project_id) !== Number(project.id)) throw badRequest('评论编号不合法');
      commentId = cid;
    }
    return {
      project,
      name,
      ext: '.' + ext.replace('.', ''),
      mime: FILE_MIME[ext.replace('.', '')] || 'application/octet-stream',
      taskId,
      reportId,
      commentId,
      dir: path.join(this.dataDir, FILE_TEAMWORK_DIR, String(Number(project.id))),
    };
  },

  /**
   * 功能：把落好的临时文件**入库并移到最终路径**（上传第二步）。
   *
   * 说明：⭐⭐ 三个「谁」写清楚：`user_id` ＝ **项目所有者**（租户列、⛔ 不记上传者）、
   *      `uploader_id` ＝ **调用者**（上传者）。⚠️ 磁盘文件名只用 `<id><扩展名>`。
   *      ⚠️ 任何一步失败（只读 503 / 入库抛错 / 移动失败）都要把临时文件清掉，⛔ 绝不留半个。
   * @param {number} uid - 账号 id（上传者）
   * @param {number} projectId - 项目 id
   * @param {Object} plan - `collabPrepareFile()` 的产物
   * @param {string} tmpPath - 临时文件绝对路径（由读取器写好）
   * @param {number} size - 字节数
   * @returns {Object} 新建的附件项（对外形状）
   * @throws {Error} 看不到时抛 404；数据层只读抛 503；文件大小为 0 或保存失败抛 400 / 500
   */
  collabSaveFile(uid, projectId, plan, tmpPath, size) {
    this._assertWritable();
    const { project } = assertCollabVisible.call(this, uid, projectId);
    if (!size) {
      // 空体：读取器没有落盘（`path` 为 null）⇒ 只把可能存在的临时文件清掉，再回 400。
      try {
        if (tmpPath) fs.unlinkSync(tmpPath);
      } catch (_e) {
        /* 空体没有临时文件：忽略 */
      }
      throw badRequest('文件是空的');
    }
    let row;
    try {
      row = this._insert('project_files', {
        user_id: Number(project.user_id),
        uploader_id: Number(uid),
        project_id: Number(project.id),
        task_id: plan.taskId,
        report_id: plan.reportId,
        // ⭐ 0.8.12：附件跟着评论走 —— 这条附件属于哪条评论（空 = 不挂评论）。
        comment_id: plan.commentId,
        name: plan.name,
        mime: plan.mime,
        size: Number(size),
        sha256: sha256OfFile(tmpPath),
        created_at: nowStamp(),
      });
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_e2) {
        /* 已经不在：忽略 */
      }
      throw e;
    }
    const finalPath = fileDiskPath(this.dataDir, project.id, row.id, plan.ext);
    try {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(tmpPath, finalPath);
    } catch (_e) {
      // 移动失败：把刚写进去的行回滚掉，再清临时文件 —— 失败方向必须安全（宁可没有这行）。
      try {
        this._bk.deleteFile(row.id);
      } catch (_e2) {
        /* 回滚也失败：忽略（下面照样抛） */
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch (_e2) {
        /* 忽略 */
      }
      const err = new Error('文件保存失败，请稍后再试');
      err.status = 500;
      throw err;
    }
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    return { item: fileOut(row, usersById) };
  },

  /**
   * 功能：取某个附件的下载信息（判权后）—— 路由据此**流式**回文件。
   *
   * 说明：⚠️ 判权走 `assertCollabVisible(row.project_id)`（不是成员 ⇒ 404）；文件在磁盘上找不到
   *      时同样 404（库里那一行已无意义）。
   * @param {number} uid - 账号 id
   * @param {number} fileId - 附件 id
   * @returns {{row: Object, path: string, name: string, mime: string, size: number}}
   * @throws {Error} 看不到 / 附件不存在 / 磁盘上没文件时抛 404
   */
  collabDownloadFile(uid, fileId) {
    const row = this._bk.findFileById(Number(fileId));
    if (!row) throw notFoundErr('这个附件');
    assertCollabVisible.call(this, uid, row.project_id);
    const p = fileDiskPath(this.dataDir, row.project_id, row.id, fileExtOf(row));
    if (!fs.existsSync(p)) throw notFoundErr('这个附件');
    return {
      row,
      path: p,
      name: String(row.name == null ? '' : row.name),
      mime: row.mime == null ? 'application/octet-stream' : String(row.mime),
      size: Number(row.size) || 0,
    };
  },

  /**
   * 功能：删一个附件 —— ⭐ **上传者自己 ＋ 项目所有者**（⚠️ 与评论**刻意不同**，方案 §戊-8-1）。
   *
   * 说明：⭐⭐ 磁盘空间是**项目级资源**，所以所有者要能清理别人的附件；而评论只有作者能删。
   *      两道判权都走**判据唯一出口**：① 先过 `assertCollabVisible`（不是成员 ⇒ 404）；
   *      ② 再比「上传者 / 所有者」（都不是 ⇒ **同一个 404**，⛔ 不给「这条存在」的探测信号）。
   * @param {number} uid - 账号 id
   * @param {number} fileId - 附件 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 附件不存在 / 不是成员 / 既不是上传者也不是所有者时抛 404
   */
  collabRemoveFile(uid, fileId) {
    this._assertWritable();
    const row = this._bk.findFileById(Number(fileId));
    if (!row) throw notFoundErr('这个附件');
    const { project } = assertCollabVisible.call(this, uid, row.project_id);
    const isOwner = Number(project.user_id) === Number(uid);
    const isUploader = Number(row.uploader_id) === Number(uid);
    if (!isOwner && !isUploader) throw notFoundErr('这个附件');
    const changed = this._bk.deleteFile(Number(row.id));
    if (changed) removeFileDisk(this.dataDir, row);
    return changed;
  },

  /**
   * 功能：把**整个库的附件**打成一组 `{ entry, buf }` 给整体备份的 zip（方案 §戊-6）。
   *
   * 说明：⭐ zip 里的路径是 `files/<project_id>/<id 分片>/<id><扩展名>`（与磁盘布局同形，顶层加
   *      `files/`）—— 恢复时的落点就是把它原样写到 `<数据目录>/teamwork/...`。
   *      ⚠️ 库里有一行、磁盘上没文件（孤儿）就**跳过**，由启动巡检如实报告，⛔ 不在这里报错。
   * @returns {Array.<{entry: string, buf: Buffer}>} 附件条目数组（可能为空）
   */
  collabFileBundle() {
    const out = [];
    for (const row of this._bk.listAllProjectFiles()) {
      const ext = fileExtOf(row);
      const p = fileDiskPath(this.dataDir, row.project_id, row.id, ext);
      if (!fs.existsSync(p)) continue;
      out.push({
        entry: `files/${String(Number(row.project_id))}/${fileShardOf(row.id)}/${fileDiskName(row.id, ext)}`,
        buf: fs.readFileSync(p),
      });
    }
    return out;
  },

  /**
   * 功能：把整体备份 zip 里的 `files/**` 落回 `数据目录/teamwork/**`（恢复侧）。
   *
   * 说明：⚠️⭐ **只在包里真有附件时才动磁盘**（先把 `teamwork/` 整目录换掉再逐条写）；包里没有
   *      附件（老备份 / 空项目）时**不动磁盘** —— 那种情况下多出来的磁盘文件会被启动巡检
   *      如实报告为孤儿，⛔ 也绝不因为「恢复一份老备份」而静默删掉用户现有的文件。
   *      ⚠️ 只认与落盘布局**逐字同形**的路径（`<数字>/<两位数字>/<数字><扩展名>`）——
   *      zip 里的 `..` 或别的形状一律跳过（防路径穿越）。
   * @param {Array.<{rel: string, buf: Buffer}>} files - `{ rel, buf }` 数组（`rel` 已去掉 `files/` 前缀）
   * @returns {{restored: number}} 实际写回的文件数
   */
  collabRestoreFiles(files) {
    const list = Array.isArray(files) ? files : [];
    const ok = list.filter((f) => f && /^\d+\/\d{2,}\/\d+\.[a-z0-9]+$/.test(String(f.rel || '')));
    if (!ok.length) return { restored: 0 };
    const root = path.join(this.dataDir, FILE_TEAMWORK_DIR);
    fs.rmSync(root, { recursive: true, force: true });
    let restored = 0;
    for (const f of ok) {
      const dst = path.join(root, f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.buf);
      restored += 1;
    }
    return { restored };
  },

  /**
   * 功能：附件**孤儿巡检** —— 回答「库里有记录、磁盘上没文件」与「磁盘上有文件、库里没记录」。
   *
   * 说明：⭐⭐ **只在启动日志报告、绝不自动删**（绝不改写用户数据）。返回两个计数，
   *      由 `core/context.js` 写进启动日志。
   * @returns {{diskOnly: number, rowsOnly: number, rows: number, onDisk: number}} 巡检计数
   */
  collabFileOrphans() {
    const rows = this._bk.listAllProjectFiles();
    const known = new Set();
    let rowsOnly = 0;
    for (const row of rows) {
      const p = path.normalize(fileDiskPath(this.dataDir, row.project_id, row.id, fileExtOf(row)));
      known.add(p);
      if (!fs.existsSync(p)) rowsOnly += 1;
    }
    const disk = walkFiles(path.join(this.dataDir, FILE_TEAMWORK_DIR));
    let diskOnly = 0;
    for (const p of disk) {
      if (!known.has(path.normalize(p))) diskOnly += 1;
    }
    return { diskOnly, rowsOnly, rows: rows.length, onDisk: disk.length };
  },

  // ---- ⭐⭐ 0.8.12：活动流水（任务级 ＋ 项目级）----

  /**
   * 功能：列出一个共享项目**全部任务**的活动流水（判权后，时间倒序）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {{items: Array.<Object>}} 流水项数组
   * @throws {Error} 看不到时抛 404
   */
  collabActivity(uid, projectId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    this._migrateCollabProject(project);
    const tasks = this.listProjectTasks(project.user_id, project.id);
    const reports = this._bk.listTaskReportsForTasks(
      'project_tasks',
      tasks.map((t) => Number(t.id)),
    );
    return { items: this._activityItems(reports, tasks) };
  },

  /**
   * 功能：列出**某一条任务**的活动流水（判权后，时间倒序）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} taskId - 任务 id
   * @returns {{items: Array.<Object>}} 流水项数组
   * @throws {Error} 看不到 / 任务不属于该项目时抛 404
   */
  collabTaskActivity(uid, projectId, taskId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    this._migrateCollabProject(project);
    const tasks = this.listProjectTasks(project.user_id, project.id);
    const task = tasks.find((t) => Number(t.id) === Number(taskId));
    if (!task) throw notFoundErr('这条任务');
    const reports = this._bk.listTaskReportsForTasks('project_tasks', [Number(taskId)]);
    return { items: this._activityItems(reports, [task]) };
  },

  /**
   * 功能：把一条评论行归一成对外的评论项（补上作者名）。
   * @param {Object} row - `project_comments` 行
   * @param {Map.<number, Object>} usersById - 账号 id → 账号行
   * @returns {Object} `{ id, task_id, user_id, username, display_name, body, created_at }`
   */
  _commentOut(row, usersById) {
    const r = row || {};
    const u = usersById.get(Number(r.user_id)) || {};
    return {
      id: Number(r.id),
      // ⚠️ 先挡 null / ''（空串也要归一成 null）—— 直接 Number() 会把 null 静默判成 0。
      task_id: r.task_id == null || r.task_id === '' ? null : Number(r.task_id),
      user_id: Number(r.user_id),
      username: u.username || '',
      display_name: u.display_name || u.username || '（已删除的账号）',
      body: String(r.body == null ? '' : r.body),
      created_at: r.created_at == null ? '' : String(r.created_at),
    };
  },

  /**
   * 功能：按 `task_id` 归并评论条数（只数**任务级**评论；给看板卡片用）。
   * @param {Array.<Object>} rows - 评论行数组
   * @returns {Object} `{ [任务id]: 条数 }`
   */
  _commentCounts(rows) {
    const out = {};
    for (const c of rows || []) {
      // ⚠️ 先挡 null / ''（`Number(null) === 0` 是有限数，会静默把项目级评论算到 0 号任务上）。
      if (c.task_id == null || c.task_id === '') continue;
      const k = Number(c.task_id);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  },

  /**
   * 功能：把一批上报行归并成**每条任务的流水**（只给甘特图要画的三个字段），按时间**正序**。
   *
   * 说明：⭐ 本轮契约 §1：`board` 的每个任务行带 `flow` —— ⚠️ 项目级**一次取完再按 task 分组**
   *      （`listTaskReportsForTasks` 是批量 op），⛔ 不按 task 逐条去查（那就是 N+1）。
   *      `from_status` 与 `_activityItems` 同一口径：老流水（迁移前）补不出 ⇒ 留 `null`。
   *      ⚠️ 同 `created_at` 时靠**插入顺序**（批量 op 已按 `created_at ASC, id ASC` 排过）兜底。
   * @param {Array.<Object>} reports - `task_reports` 行数组（可以跨多条任务）
   * @returns {Object} `{ [任务id]: [{from_status, to_status, created_at}] }`
   */
  _flowByTask(reports) {
    const out = {};
    for (const r of reports || []) {
      const k = Number(r.task_id);
      if (!out[k]) out[k] = [];
      out[k].push({
        // ⚠️ 老流水（迁移前）补不出 `from_status` ⇒ 留 null（与 `_activityItems` 同一口径）。
        from_status: r.from_status == null || r.from_status === '' ? null : String(r.from_status),
        to_status: String(r.status == null ? '' : r.status),
        created_at: r.created_at == null ? '' : String(r.created_at),
      });
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    return out;
  },

  /**
   * 功能：把一批上报行归一成流水项（补上任务标题与作者名），按时间**倒序**。
   * @param {Array.<Object>} reports - `task_reports` 行数组
   * @param {Array.<Object>} tasks - 这些上报所属的任务行（取标题）
   * @returns {Array.<Object>} 流水项数组
   */
  _activityItems(reports, tasks) {
    const titleById = new Map((tasks || []).map((t) => [Number(t.id), t.title]));
    const usersById = new Map(this.listUsers().map((u) => [Number(u.id), u]));
    return (reports || [])
      .map((r) => {
        const u = usersById.get(Number(r.user_id)) || {};
        return {
          id: Number(r.id),
          task_id: Number(r.task_id),
          task_title: String(titleById.get(Number(r.task_id)) == null ? '' : titleById.get(Number(r.task_id))),
          user_id: Number(r.user_id),
          username: u.username || '',
          display_name: u.display_name || u.username || '（已删除的账号）',
          // ⚠️ 老流水（迁移前）补不出 `from_status` ⇒ 留 null，界面显示「—」。
          from_status: r.from_status == null || r.from_status === '' ? null : String(r.from_status),
          to_status: String(r.status == null ? '' : r.status),
          note: r.note == null ? '' : String(r.note),
          created_at: r.created_at == null ? '' : String(r.created_at),
        };
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
  },

  // ---- ⭐⭐ 0.8.12：两处存量迁移 —— 懒迁移、幂等、不改写用户数据 ----

  /**
   * 功能：读看板 / 流水（以及写流水前）先跑一次的两处懒迁移 —— ⚠️ 幂等、⛔ 不改写用户数据。
   *
   * 说明：⭐⭐ **不新增核心钩子**：两处迁移都做成**懒迁移**，挂在「读该项目看板 / 流水」那一拍
   *      （与状态播种同一处、同一风格），外加「改任务状态前」那一拍（老库要先把
   *      `task_reports.status` 上那条窄 CHECK 去掉，否则写流水当场 500）。
   *      · ① **老上报补 `project_id`**（按 `task_id` 反查项目，找不到留 NULL，老行一个字不动）；
   *      · ② **负责人文本名 → 账号 id**（精确匹配 `users.username`，**匹配不上不改写**）；
   *      · ①-blocked：真有 `blocked` 上报时才播种内置态「卡住了」（归 `started` 组，幂等）。
   *      ⚠️ 只读降级（`_assertWritable` 抛 503）时**吞掉异常直接返回**（照 `_seedCollabStates`）——
   *      读口不该因为「迁移写不了」而整条失败。
   * @param {Object} project - 项目行
   * @returns {void}
   */
  _migrateCollabProject(project) {
    if (!project || !project.id) return;
    try {
      this._assertWritable();
    } catch (_e) {
      return; // 只读降级：迁移是写操作，读口不因此失败
    }
    this._bk.ensureReportFlowSchema(); // 老库：去掉 task_reports.status 上的窄 CHECK（幂等）
    this._bk.backfillReportProjects(); // ① 老上报补 project_id（找不到留 NULL）
    this._bk.backfillProjectAssignees(project.id); // ② 负责人文本名 → 账号 id（匹配不上不改写）
    this._seedBlockedState(project); // ①-blocked：真有 blocked 上报才播种「卡住了」
  },

  /**
   * 功能：⚠️ 只有这个项目**真有 `blocked` 上报**时，才给它的状态集播种一条内置态「卡住了」
   *      （`key='blocked'`、归 `started` 组）—— **幂等**（已有 `blocked` 就跳过）。
   *
   * 说明：⭐ 2e 的老 `blocked` 上报要落到**进行中组**。⚠️ 它**不在**
   *      `state-groups.js` 的内置五态里（那条路会**无条件**播种）—— 按口径只在真有 `blocked`
   *      上报时才加，否则「新项目凭空多一个『卡住了』」。
   * @param {Object} project - 项目行
   * @returns {void}
   */
  _seedBlockedState(project) {
    if (!project || !project.id) return;
    if (this._bk.listCollabStates(project.id).some((s) => String(s.key) === 'blocked')) return;
    const taskIds = this.listProjectTasks(project.user_id, project.id).map((t) => Number(t.id));
    if (!taskIds.length) return;
    const hasBlocked = this._bk
      .listTaskReportsForTasks('project_tasks', taskIds)
      .some((r) => String(r.status) === 'blocked');
    if (!hasBlocked) return;
    this._insert('collab_states', {
      project_id: Number(project.id),
      key: 'blocked',
      name: '卡住了',
      color: '#f59e0b',
      group_key: 'started',
      // ⚠️ 与内置 `doing`（sort_order 2）并列 —— 组内顺序按 sort_order 再按 id，故它落在 doing 之后。
      sort_order: 2,
      is_default: 0,
    });
  },

  /**
   * 功能：可被拉进项目的好友清单（项目所有者用）。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} `[{ id, username, display_name }]`
   * @throws {Error} 对话模块不在时抛 503
   */
  collabFriendCandidates(uid) {
    return friendCandidates.call(this, uid);
  },

  /**
   * 功能：项目**首次进看板时**播种内置五态 —— ⚠️ 幂等（已有任意一行就不播）。
   *
   * 说明：⭐ 判权不在这一步（调用方都已过 `assertCollabVisible`）。`GET /states` 这类**读口**
   *      也允许播种（契约：读口允许播种，但要幂等）；⚠️ 只读降级时**不写库**（`_assertWritable`
   *      会抛 503，这里吞掉直接返回）—— 读口不该因为「播不了种」而整条失败。
   * @param {Object} project - 项目行
   * @returns {void}
   */
  _seedCollabStates(project) {
    if (!project || !project.id) return;
    if (this._bk.listCollabStates(project.id).length) return;
    try {
      this._assertWritable();
    } catch (_e) {
      return; // 只读降级：不写库就不播
    }
    for (const s of DEFAULT_STATES) {
      this._insert('collab_states', {
        project_id: Number(project.id),
        key: s.key,
        name: s.name,
        color: s.color,
        group_key: s.group,
        sort_order: s.sort_order,
        is_default: s.is_default,
      });
    }
  },

  /**
   * 功能：取一个项目的**状态集**（判权后；空则先播种）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {{items: Array.<Object>}} 状态项数组（每项 `{id,key,name,color,group,sort_order,is_default}`）
   * @throws {Error} 看不到时抛 404
   */
  collabStates(uid, projectId) {
    const { project } = assertCollabVisible.call(this, uid, projectId);
    this._seedCollabStates(project);
    return { items: this._bk.listCollabStates(project.id).map(stateOut) };
  },

  /**
   * 功能：项目所有者新增一个状态（`key` 服务端生成，⛔ 不许和现有 key 撞）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {Object} input - `{ name, color?, group }`
   * @returns {{item: Object}} 新建的状态项
   * @throws {Error} 不是所有者时抛 404；`name` 为空 / `group` 非法时抛 400
   */
  collabAddState(uid, projectId, input) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    const src = input && typeof input === 'object' ? input : {};
    const name = String(src.name == null ? '' : src.name).trim();
    if (!name) throw badRequest('状态名不能为空');
    const group = String(src.group == null ? '' : src.group).trim();
    if (!GROUP_KEYS.includes(group)) throw badRequest('状态必须属于五组之一');
    const item = this._insert('collab_states', {
      project_id: Number(project.id),
      key: this._nextStateKey(project.id),
      name,
      color: src.color == null ? '' : String(src.color),
      group_key: group,
      sort_order: 0,
      is_default: 0,
    });
    return { item: stateOut(item) };
  },

  /**
   * 功能：项目所有者改一个状态（`name` / `color` / `group` / `sort_order`，⛔ 改不到 `key` / `is_default`）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} stateId - 状态 id
   * @param {Object} input - `{ name?, color?, group?, sort_order? }`
   * @returns {boolean} 是否更新到（找不到这个状态时抛 404）
   * @throws {Error} 不是所有者 / 状态不存在时抛 404；入参非法时抛 400
   */
  collabUpdateState(uid, projectId, stateId, input) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    const state = this._bk.findCollabState(project.id, Number(stateId));
    if (!state) throw notFoundErr('这个状态');
    const src = input && typeof input === 'object' ? input : {};
    const patch = {};
    if (src.name !== undefined) {
      const name = String(src.name == null ? '' : src.name).trim();
      if (!name) throw badRequest('状态名不能为空');
      patch.name = name;
    }
    if (src.color !== undefined) patch.color = src.color == null ? '' : String(src.color);
    if (src.group !== undefined) {
      const group = String(src.group == null ? '' : src.group).trim();
      if (!GROUP_KEYS.includes(group)) throw badRequest('状态必须属于五组之一');
      patch.group_key = group;
    }
    if (src.sort_order !== undefined) {
      const n = Number(src.sort_order);
      if (!Number.isFinite(n)) throw badRequest('排序值必须是数字');
      patch.sort_order = Math.trunc(n);
    }
    if (!Object.keys(patch).length) return true;
    return this._bk.updateCollabState(project.id, Number(stateId), patch);
  },

  /**
   * 功能：项目所有者删一个状态 —— ⚠️ 三条 400：默认状态、有任务在用、每组的最后一个。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} stateId - 状态 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 不是所有者 / 状态不存在时抛 404；三条禁令各抛 400（文案逐字见方案 §三·2）
   */
  collabDeleteState(uid, projectId, stateId) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    const state = this._bk.findCollabState(project.id, Number(stateId));
    if (!state) throw notFoundErr('这个状态');
    if (Number(state.is_default) === 1) throw badRequest('默认状态不能删');
    const key = String(state.key == null ? '' : state.key);
    const used = this.listProjectTasks(project.user_id, project.id).some(
      (t) => String(t.status == null ? '' : t.status) === key,
    );
    if (used) throw badRequest('这个状态还有任务在用，先把它们改到别的状态');
    const sameGroup = this._bk
      .listCollabStates(project.id)
      .filter((s) => String(s.group_key) === String(state.group_key));
    if (sameGroup.length <= 1) throw badRequest('每组至少要留一个状态');
    return this._bk.deleteCollabState(project.id, Number(stateId));
  },

  /**
   * 功能：**看板取数（一次到位）** —— 项目 / 状态集 / 五组分组 / 进度 / 成员 / 未知状态列。
   *
   * 说明：⭐⭐ 进度口径走 `countsOf()`（唯一纯函数）：**取消的不进分母**。
   *      ⚠️ 状态不在集里的任务**单独进 `unknown` 列**（界面单列一列），⛔ 不重复进五组、
   *      也⛔ 不丢（进度里照样算它）。卡片另外带上 `comment_count` / `file_count`（真值）。
   *      ⭐ 甘特图（本轮契约 §1）：每个任务行还带 `created_at` 与 `flow`（该任务的流水，
   *      `[{from_status, to_status, created_at}]`，按时间**正序**；没流水时是**空数组**）。
   *      ⚠️ `flow` 与评论数 / 附件数一样**项目级一次取完再按 task 分组**（⛔ 不 N+1）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @returns {Object} `{ project:{id,name,role}, states, groups, progress, members, unknown }`
   * @throws {Error} 看不到时抛 404
   */
  collabBoard(uid, projectId) {
    const { role, project } = assertCollabVisible.call(this, uid, projectId);
    this._seedCollabStates(project);
    // ⭐ 0.8.12：读看板这一拍先跑一次懒迁移（幂等）。
    this._migrateCollabProject(project);
    const states = this._bk.listCollabStates(project.id).map(stateOut);
    const tasks = this.listProjectTasks(project.user_id, project.id);
    // ⭐⭐ 0.8.17：给**周期任务**挂上「已打卡的期」—— 协作看板那一版甘特图
    //    照任务板画成「一期一段」，并给打过卡的期打勾，数据就来自这里。
    //    ⚠️ 那个原语（`attachTicks`）住在 **tasks 模块的 store** 上；跨模块只许走公开业务方法
    //    （先例就是上一行那个 `this.listProjectTasks`），⛔ 不 require 对方的文件
    //    （`teamwork/schema.js` 开头明写这条）。⚠️ 传的是 `project.user_id`（＝任务行的归属人），
    //    不是调用者 —— 打卡记录是按任务归属人存的。
    //    ⚠️ 它只对 `task_kind === 'cycle'` 的行动手，其余任务一个字节不加。
    this.attachTicks(project.user_id, tasks, 'project');
    // ⭐ 0.8.12：卡片上的评论数取**真值**（只数任务级评论）——一次读、按 task_id 归并。
    const commentCounts = this._commentCounts(this._bk.listProjectComments(project.id));
    // ⭐⭐ 甘特图（本轮契约 §1）：每个任务行带 `flow` —— ⚠️ 项目级**一次取完再按 task 分组**
    //    （照 `collabReports` 那样用批量 op），⛔ 不按任务逐条查（那就是 N+1）。
    const flowByTask = this._flowByTask(
      this._bk.listTaskReportsForTasks(
        'project_tasks',
        tasks.map((t) => Number(t.id)),
      ),
    );
    // ⭐⭐ 0.8.12（方案 §戊-8-2 / 契约 §4）：卡片上的 `file_count` 也取**真值**（只数任务级附件）；
    //    项目级附件（`task_id` 为空）归到**项目行**上的 `file_count`。
    const fileRows = this._bk.listProjectFiles(project.id);
    const fileCounts = {};
    let projectFileCount = 0;
    for (const f of fileRows) {
      if (f.task_id == null || f.task_id === '') {
        projectFileCount += 1;
        continue;
      }
      const k = Number(f.task_id);
      fileCounts[k] = (fileCounts[k] || 0) + 1;
    }
    const groups = {};
    for (const k of GROUP_KEYS) groups[k] = [];
    const unknown = [];
    for (const t of tasks) {
      // ⚠️ 卡片字段由 board 一次带齐（评论数 / 附件数 / 流水都取真值）。
      const card = Object.assign({}, t, {
        // ⭐ 甘特图（本轮契约 §1）：任务行带上**创建时间**与**流水**（⛔ 纯加字段，不改既有形状）。
        created_at: t.created_at == null ? '' : String(t.created_at),
        flow: flowByTask[Number(t.id)] || [],
        comment_count: commentCounts[Number(t.id)] || 0,
        file_count: fileCounts[Number(t.id)] || 0,
      });
      const key = String(t.status == null ? '' : t.status);
      if (!states.some((s) => s.key === key)) unknown.push(card);
      else groups[groupOf(key, states)].push(card);
    }
    const members = this.collabMembers(uid, project.id).map((m) => ({
      user_id: Number(m.user_id),
      username: m.username || '',
      display_name: m.display_name || m.username || '',
    }));
    return {
      project: { id: Number(project.id), name: project.name, role, file_count: projectFileCount },
      states,
      groups,
      progress: countsOf(tasks, states),
      members,
      unknown,
    };
  },

  /**
   * 功能：**任何成员**都可以在共享项目里发布任务（⛔ 推翻 `C-15`）。
   *
   * 说明：⭐ 三个「谁」写清楚：
   *      · `user_id` ＝ **项目所有者**（任务行归所有者，⛔ 语义不许改）；
   *      · `creator_id` ＝ **调用者**（谁建的这条任务）；
   *      · `assignee_id` 缺省 ＝ **项目创建者**（＝ `projects.user_id`）。
   *      ⚠️ `status` 缺省 ＝ 项目的**默认状态**；若显式给了 status，必须**在状态集里**
   *      （否则会静默造出一条「未知状态」的任务，界面只能塞进 unknown 列）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {Object} input - 已由 `validate.checkProjectTask` 归一化
   * @returns {{item: Object}} 新建的任务行（卡片字段齐全）
   * @throws {Error} 看不到时抛 404；标题为空 / 状态不在集 / 负责人非法时抛 400
   */
  collabAddTask(uid, projectId, input) {
    this._assertWritable();
    const { project } = assertCollabVisible.call(this, uid, projectId);
    this._seedCollabStates(project);
    const states = this._bk.listCollabStates(project.id).map(stateOut);
    const src = input && typeof input === 'object' ? input : {};
    const title = String(src.title == null ? '' : src.title).trim();
    if (!title) throw badRequest('任务标题不能为空');
    const def = states.find((s) => s.is_default === 1) || states[0];
    const statusKey = src.status == null || src.status === '' ? (def ? def.key : 'todo') : String(src.status).trim();
    if (!states.some((s) => s.key === statusKey)) throw badRequest('状态不在这个项目的状态集里');
    // ⭐⭐ 0.8.53（待排期单列）：`backlog` 组不等于「排期中的任务」—— 它**没有日期**
    //    （甘特图不画它，只在待排期列表里出现），所以这里不能照旧兜底成 `today()`。
    //    ⚠️ 其余组保持原口径（没传日期 = 今天），⛔ 别把这条放宽到所有组：那会让甘特条凭空消失。
    const group = groupOf(statusKey, states);
    const backlog = group === 'backlog';
    const row = {
      project_id: Number(project.id),
      user_id: Number(project.user_id),
      title,
      description: src.description == null ? '' : String(src.description),
      status: statusKey,
      completed_at: group === 'completed' ? nowStamp() : null,
      start_date: backlog ? null : src.start_date || src.due_date || today(),
      due_date: backlog ? null : src.due_date || today(),
      assignee: '',
      tag: '',
      important: 0,
      urgent: 0,
      assignee_id: this._resolveAssignee(project, src.assignee_id),
      creator_id: Number(uid),
      // ⭐⭐ 0.8.53（没有适配周期和窗口两个任务类型）：任务类型这一维度照任务板逐列带上。
      //    ⚠️ 这里**必须显式逐列写** —— `collabAddTask` 不是走 PUT 白名单，键漏一个就是那一列静默不写
      //    （本项目在 `bookmark_id` 上真踩过）。入参已由 `checkProjectTask()` 归一化。
      task_kind: src.task_kind || 'plain',
      start_time: src.start_time || null,
      due_time: src.due_time || null,
      recur_rule: src.recur_rule || null,
      sort_order: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    const item = this._insert('project_tasks', clampRange(row));
    return { item: Object.assign({}, item, { comment_count: 0, file_count: 0 }) };
  },

  /**
   * 功能：**删掉一条协作任务**（⭐ 0.8.54「团队协作的待排期任务没有删除功能」）。
   *
   * 说明：⭐⭐ 判权 = **项目所有者 ＋ 任务创建者**（`creator_id`），与「删附件」同一档口径
   *      （上传者自己 ＋ 项目所有者）—— 协作任务归项目，但「谁建的谁能撤」。
   *      ⚠️ 判据只写在这一处：两条都不满足 ⇒ **同一个 404**（⛔ 不给「这条存在」的探测信号）。
   *      ⚠️⭐ 删除**不自己写 DELETE**：委托任务板的 `deleteProjectTask()`（按**所有者**的 uid 调用，
   *      因为 `project_tasks.user_id` 就是所有者）—— 它会连带清掉上报、评论与附件（含磁盘文件）、
   *      打卡记录、随手记绑定。在协作层再写一份 DELETE 等于把那套连带清理抄第二遍。
   *      ⚠️ 已知小瑕疵：随手记绑定清的是**所有者名下**那条 —— 成员建的随手记绑定会留下一个
   *      指向已删任务的「已变成任务」标记（不改写别人的数据，故不追）。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} taskId - 任务 id
   * @returns {boolean} 恒为 true（失败会抛错）
   * @throws {Error} 看不到项目 / 任务不存在 / 既不是所有者也不是创建者时抛 404
   */
  collabRemoveTask(uid, projectId, taskId) {
    this._assertWritable();
    const { project } = assertCollabVisible.call(this, uid, projectId);
    const tid = Number(taskId);
    if (!Number.isInteger(tid) || tid < 1) throw badRequest('任务编号不合法');
    const row = this.listProjectTasks(project.user_id, project.id).find((t) => Number(t.id) === tid);
    if (!row) throw notFoundErr('这条任务');
    const isOwner = Number(project.user_id) === Number(uid);
    const isCreator = Number(row.creator_id) === Number(uid);
    if (!isOwner && !isCreator) throw notFoundErr('这条任务');
    const ok = this.deleteProjectTask(Number(project.user_id), tid);
    if (!ok) throw notFoundErr('这条任务');
    return true;
  },

  /**
   * 功能：项目所有者把项目**转让**给一个成员 —— 改 `projects.user_id`。
   *
   * 说明：⭐ 转让**只影响后续**：⭐ 已设的负责人（`assignee_id`）全不变、
   *      ⛔ 成员名单一行不动。⚠️ 任务行的 `user_id` 是**项目所有者**、且列表按它读
   *      ⇒ 由 `transferProject` 原语**一起改**（否则新所有者读不到任务，见那个 op 的说明）。
   *      ⚠️ 转让给自己是**无操作**（返回 true）；目标是**非成员**时抛 400。
   * @param {number} uid - 账号 id
   * @param {number} projectId - 项目 id
   * @param {number} targetId - 新所有者账号 id（必须是成员）
   * @returns {boolean} 恒为 true（失败会抛错）
   * @throws {Error} 不是所有者时抛 404；目标不是成员 / id 非法时抛 400
   */
  collabTransfer(uid, projectId, targetId) {
    this._assertWritable();
    const { project } = assertCollabOwner.call(this, uid, projectId);
    const nid = Number(targetId);
    if (!Number.isInteger(nid) || nid < 1) throw badRequest('要转让给的账号不合法');
    if (nid !== Number(project.user_id)) {
      const isMember = this._bk.listProjectMembers(project.id).some((m) => Number(m.user_id) === nid);
      if (!isMember) throw badRequest('只能转让给项目成员');
    }
    return this._bk.transferProject(Number(project.id), nid);
  },

  /**
   * 功能：判断一个人算不算这个项目的参与者（所有者或名单里的成员）—— 负责人校验用。
   * @param {Object} project - 项目行
   * @param {number} uid - 账号 id
   * @returns {boolean} 是参与者则为 true
   */
  _isProjectParticipant(project, uid) {
    if (Number(project.user_id) === Number(uid)) return true;
    return this._bk.listProjectMembers(project.id).some((m) => Number(m.user_id) === Number(uid));
  },

  /**
   * 功能：归一负责人 —— 缺省 / 空 ⇒ **项目所有者**；给了就必须是**项目参与者**。
   * @param {Object} project - 项目行
   * @param {*} raw - 原始 `assignee_id`
   * @returns {number} 负责人账号 id
   * @throws {Error} 编号非法 / 不是参与者时抛 400
   */
  _resolveAssignee(project, raw) {
    if (raw === undefined || raw === null || raw === '') return Number(project.user_id);
    const aid = Number(raw);
    if (!Number.isInteger(aid) || aid < 1) throw badRequest('负责人编号不合法');
    if (!this._isProjectParticipant(project, aid)) throw badRequest('负责人只能是项目成员');
    return aid;
  },

  /**
   * 功能：生成一个**不与现有 key 相撞**的新状态键（`s1` / `s2` / …）。
   * @param {number} projectId - 项目 id
   * @returns {string} 新状态键
   */
  _nextStateKey(projectId) {
    const used = new Set(this._bk.listCollabStates(projectId).map((s) => String(s.key)));
    let i = 1;
    while (used.has('s' + i)) i += 1;
    return 's' + i;
  },

  /** 供测试与路由复用的出口 —— ⛔ 判据本体仍在 `taskShareGuard()` 一处。 */
  _assertCollabVisible: assertCollabVisible,
  _assertCollabOwner: assertCollabOwner,

  // ⭐⭐ 0.8.12：附件子系统的**常量与路径助手**（路由取上限/白名单、两后端取连带删除用）。
  FILE_MAX_BYTES,
  FILE_EXT_WHITELIST,
  fileDiskPath,
  removeFileDisk,
  removeProjectDir,
};
