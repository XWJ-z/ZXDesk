'use strict';
/**
 * modules/teamwork/mobile-teamwork-board.js —— 协作看板在**手机版第二屏**的插槽片段
 *
 * 功能：`teamwork-board` 槽的手机版实现 —— 点开对话列表页「协作项目」组里的一条 ⇒ **进第二屏**
 *      （屏内二级屏，由宿主 `modules/teamwork/mobile.js` 的 `renderCollabBoard()` 画骨架，
 *      本片段只画内容），第二屏的主视图是一张**甘特图**（⭐ 契约 §0：把原来的「竖向分组卡片」换掉）：
 *      ① 页头：`已完成 n / 共 m` ＋ 一条细进度条 ＋ **一排四颗**（【⚙ 状态】（仅所有者）·
 *         【💬 评论】·【活动】·【协作成员】；⭐⭐ 0.8.54 起四颗等分宽、等高、**始终一排**）；
 *         ⭐ 2026-10-23：「新建任务」从这一排**挪到右下角悬浮**（`fabHtml()`，与首页那颗 `.fab` 同款）；
 *      ② ⭐ 顶部一排**状态图例**（五组 ＋ `全部`）：点某一组 ⇒ 时间轴只显示**当前在该组**的任务；
 *      ③ ⭐ 时间轴：**一屏一周的甘特图**（⭐ 契约 §1；⭐ 0.8.12 照任务板那套重画）—— 一行
 *         「« 周区间 » ＋ 今天」，下面**一天一列**（列头＝星期几 ＋ `M/D`；周日那列用强调色）；
 *         一屏**恰好一周**，窄屏**不做横向滚动**（横滑会被宿主的返回手势抢）⇒ 靠翻周看别的日子。
 *         ⭐ **照任务板那套画**：条 = 「创建日 → 截止日」的**彩色药丸**，**任务名写在条里**
 *         （没有截止日就用最新一条流水）；所有任务**共用一条时间轴**，**重叠的条自动错行**
 *         （贪心分道，与电脑端任务板同一套）。
 *         ⭐⭐ 0.8.53：**配色与电脑端同一套** —— 按**画出来的先后**轮流取
 *         共用层 `COLORS`（`--tlc`），**不再按组着色**（图例只管筛选，照电脑端 0.8.17）；
 *         已完成 ✓ / 已取消删除线 / 逾期红边红字的样式档都在 CSS 里。
 *         ⭐⭐ **整条落在本周之外的任务不画**（与电脑端 `lanesOf()` 同口径）——
 *         「所有过去的任务都会在当前周的最左侧显示」；从前收成贴边药丸，过去的任务全堆在
 *         当前周最左侧一摞。重叠本周的条仍**裁到周界**（照电脑端协作看板的 `max/min` 口径）。
 *         ⚠️ 负责人 / 截止日 / 💬n 📎n 收进条的 `title` 与卡片弹层（手机端没有悬停，靠弹层看）。
 *         点条开原来那张卡片弹层（里面的功能一个字不动）。
 *      ④ ⭐ 成员块收成一颗【协作成员】按钮（0.8.54 起并入页头那排；弹层标题仍是「协作成员管理」）
 *         ⇒ 弹窗里**显示和设置**都有：成员名单
 *         一行一个（`我` / `发起人` 标记 ＋ 每行 `移出`）· `＋ 加成员` · `移出协作` · `转让` ·
 *         那句说明 `移出后成员立刻看不到；成员名单还在，重新加回来又看得见。`；
 *         分「成员」与「项目操作」两组、说明放项目操作组下、用量放最底；
 *         ⚠️ 原来那些控件一个都没丢，`每个成员上传了多少` 也搬进这个弹窗。
 *      ⑤ 卡片弹层（点任务行 / 行末【详情】）里：改状态 / 改负责人 ＋ 评论（短视频评论区样式）
 *         ＋ 活动 ＋ 附件；评论 / 活动 / 附件写入后**只重取坏掉的那一块**，⛔ 不整屏 `paint()`。
 *      ⑥ ⭐ 附件下载：点【下载】**真点一次临时 `<a>`**（⛔ 不是内联打开）—— 服务端那条路带
 *         `Content-Disposition: attachment`，让那个头生效（见 `downloadFile()` 那段说明）。
 *
 * ⚠️ **实时刷新**（契约 §3-2）：打开 / **切回**看板时重取一次（宿主重画不重挂看板 ⇒ 这里用
 *    `IntersectionObserver` 在看板**重新可见**时重取）；任何**写操作**后重取受影响的那几块。
 *
 * ⭐ 谁负责哪一半（与 `mobile-teamwork-page.js` 分工，别搞混）：
 *      · **本文件**只画「一个项目」的看板与它那几个弹层（状态 / 新建任务 / 转让 / 加成员 / 成员管理）；
 *      · 「协作项目列表 + 添加共享项目弹层 + 往列表页第三组登记条目」全在 `mobile-teamwork-page.js`。
 *      两者都建立在 `teamwork` 模块的留白事件上，**谁都不认识 `teamwork` 模块的内部**。
 *
 * ⚠️ **判权全在服务端**：非成员 / 项目没共享 / 项目不存在，服务端一律 404 —— 前端按「看不到」处理，
 *    ⛔ 不去猜原因。⛔ **界面只做可见性**（例如非所有者不摆「改到已完成」那一项），
 *    真动到越界的动作时**照常把服务端那句话弹出来**，⛔ 不静默吞掉。
 *
 * ⚠️ **看板取数一次到位**：`GET /api/collab/projects/:pid/board` ⇒ `{project, states, groups,
 *    progress, members, unknown}`；每个任务行另带 `created_at` 与 `flow`（`[{from_status,
 *    to_status, created_at}]`，按时间正序 —— 甘特图的点与横条靠它）。
 *
 * ⚠️ **项目编号从挂载上下文拿**：宿主 `mountSlots(..., 'teamwork-board', { collabPid })` 把「点开的
 *    是哪一条」随 `ctx` 传进来（`render()` 里读 `ctx.collabPid`）—— 本文件不认识列表页、也不认识宿主。
 *
 * ⚠️ 本文件**自包含**（只 import core 与宿主 ui），不依赖任务板别的片段。
 *
 * @author zx
 * @date   2026-10-04
 * @since 0.8.54
 * 相关：docs/公共/开发方案/32-团队协作.md §丁 · §丙-2、core/slots.js、modules/teamwork/mobile-teamwork-page.js
 */

import { api, BASE, backToLogin } from '../../core/api.js';
import { esc } from '../../core/dom.js';
import { todayStr, addDays, dow, fmtShort, mondayOf, weekdayChar } from '../../core/date.js';
// ⭐ 2026-10-20：甘特条的**可见终点**必须与电脑端同源 —— 判据住在共用层 `core/task.js` 的
//    `visEnd()`（已完成止于完成日 / 逾期未完成顺延到今天），⛔ 别在这边另写一份。
import { visEnd } from '../../core/task.js';
// ⭐ 0.8.53（「任务配色与电脑端不一样」）：条色与电脑端同源 —— 共用层的
//    `COLORS`（按画出来的先后轮换），⛔ 别在手机端另抄一份色表（判据只准一处）。
import { COLORS } from '../../core/constants.js';
// ⭐ 0.8.53：判「任务类型有没有被改过」要把库里的 JSON 文本与编辑器里的对象折成同一形状
import { parseRule } from '../../core/recur.js';
// ⭐ 0.8.54：删待排期前要问一句 —— `askConfirm()` 是手机端统一的确认弹层（收对象，不是字符串）。
// ⭐⭐ 0.8.54（「弹窗弹不出来，统一改为走宿主的 opensheet」）：协作看板的弹层不再自绘
//    遮罩/卡片，一律交给宿主的底部弹层 —— 所以这里要 openSheet / closeSheet / isSheetOpen 三个口。
import { askConfirm, closeSheet, isSheetOpen, openSheet, toast } from '../../mobile/ui.js';
// ⭐⭐ 0.8.53（没有适配周期和窗口两个任务类型）：任务类型块与电脑端**同一份**
//    （三选一 ＋ 时间窗 ＋ 两个时刻 ＋ 周期规则；规则编辑器来自任务板的 `shared.js`）。
import { bindKindBlock, kindBlockHtml, readKindFields } from './teamwork-taskkind.js';

/** 五组的键，顺序即手机端从上到下的组顺序（与电脑端「从左到右」同序）。 @type {Array.<string>} */
const GROUP_KEYS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];

/** 五组的显示名（⭐ 两端逐字一致，见）。 @type {Object.<string,string>} */
const GROUP_LABEL = {
  backlog: '待排期',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

/** 状态不在状态集里时单列的那一组（老脏状态兜底，⛔ 不许丢任务）。 */
const UNKNOWN_KEY = 'unknown';

/**
 * ⭐ 甘特图状态图例里「全部」那一颗的取值（默认筛选项；⛔ 不是任何一组，所以单列一个常量）。
 * @type {string}
 */
const GANTT_ALL = 'all';

/**
 * ⭐⭐ 0.8.53（「还是一周一周的切换，只是这一周的每一列显示宽一些，
 * 可以左右滑动」）：**单列宽度**（px）。
 *
 * 说明：⚠️ 它必须**大于「屏宽 / 7」**（390 的屏约 55.7）—— 否则一周 7 列又刚好塞满屏幕，
 *      等于没加宽、也没得滑。
 *      ⭐⭐ 2026-10-23（「24 号一天的任务，显示了 24 和 25，可以适当加宽格子」）：
 *      从 64 加到 **88**。同时**撤掉了「1 天的条加宽到 2 列」那条**（原 `GANTT_MIN_COLS`）——
 *      列宽够了之后，1 天的条就老实占 1 列，⛔ 不再撑到第二天去假装跨两天。
 *      88 × 7 = 616 ⇒ 一屏大约看到 4~5 列，剩下的横滑。
 *      列宽由 JS 写内联 `grid-template-columns`（`.collab-gt-weekhead` / `.collab-gt-track`），
 *      CSS 只留 `display:grid` 与底纹 ⇒ ⛔ 别在 CSS 里再写一份列宽。
 * @type {number}
 */
const GANTT_COL_W = 88;

/**
 * ⭐⭐ 0.8.53：时间窗 = **一周 7 天**（翻周仍然是「一周一周地切换」，见 `fitStart()`）。
 *
 * 说明：⚠️ 上一版曾把它写成 35（五周长轴）纠正：「还是一周一周的切换，
 *      只是这一周的每一列显示宽一些，可以左右滑动」⇒ 窗口回到一周，**横向滚动只在本周内**。
 * @type {number}
 */
const GANTT_DAYS = 7;

/**
 * 甘特图一「道」的高度（px）—— 必须与 `mobile/app.css` 里 `.collab-gt-bar` 的几何配套
 * （条 28px 在行内居中 ⇒ 上下各让 2px）。
 * ⚠️ 起条上不再有节点小点，行高只为「条的高度 ＋ 两道之间的呼吸」而留。
 * @type {number}
 */
const GANTT_ROW_H = 32;

/**
 * ⭐ 成员管理弹窗里那句说明 —— **逐字**照契约 §2.2-①（两端一个标点都不许改）。
 * @type {string}
 */
const MEMBER_NOTE = '移出后成员立刻看不到；成员名单还在，重新加回来又看得见。';

/**
 * ⭐ 转让的二次确认语 —— **逐字**照）。
 * @type {string}
 */
const TRANSFER_NOTE = '转让后你不再是所有者：验收权与成员管理权都归新所有者；已设的负责人不变。';

/**
 * ⭐ 删评论被服务端 404 时用的兜底文案（契约 §3 逐字）。
 *
 * 说明：⚠️ 界面上**只给自己发的那几条**画「删除」，所以正常路径不会越权；
 *      这句只在服务端回 404（不是作者 / 评论已没了）时兜底提示，⛔ 不是给别人的评论画删除键。
 * @type {string}
 */
const DELETE_DENY = '只有作者能删这条评论';

/** 颜色写得像十六进制才认（用户内容不进 style，防拼出奇怪样式）。 */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/** 取色控件 / 色点没有合法颜色时的回落色（与内置「未开始」态同色的中性灰）。 */
const DEFAULT_COLOR = '#64748b';

/**
 * ⭐ 2f：单个附件的**上限**（10 MB，与 逐字一致）—— ⚠️ 客户端**先挡一次**，
 * 服务端那道 413 仍要看（这里只是省一趟白跑）。
 * @type {number}
 */
const FILE_MAX = 10 * 1024 * 1024;

/**
 * ⭐ 2f：允许上传的扩展名白名单—— ⛔ 不含 `svg` / `html` / `exe` / `js`
 * （可执行或可内联渲染的一律不收）。⚠️ 服务端是最终判据，这里只是**先挡一次**。
 * @type {Array.<string>}
 */
const FILE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv', 'docx', 'xlsx', 'pptx', 'zip'];

/**
 * ⭐ 附件选择框的 `accept` 串 —— 与白名单同源（两边一起改，⛔ 别只改一处）。
 * @type {string}
 */
const FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.docx,.xlsx,.pptx,.zip';

/** 评论正文为空时的提示语（⭐ 两端逐字一致，与电脑端同款）。 @type {string} */
const COMMENT_NEED_BODY = '请填写评论内容';

/** 附件类型不支持的兜底文案（⭐ 两端逐字一致，契约 §5）。 @type {string} */
const FILE_TYPE_BAD = '这种文件类型不支持';

/** 附件太大的兜底文案（⭐ 两端逐字一致，契约 §5）。 @type {string} */
const FILE_TOO_BIG = '文件太大（单个不超过 10 MB）';

/** 上传者账号已注销时的显示名（⭐ 两端逐字一致，契约 §5）。 @type {string} */
const GONE_USER = '已注销成员';

/**
 * 功能：取一个**合法十六进制**颜色（取色控件的 value 只认 hex，`var(...)` 会被浏览器丢掉）。
 * @param {*} c - 服务端给的颜色
 * @returns {string} 十六进制颜色
 */
function hexOf(c) {
  const s = String(c == null ? '' : c);
  return HEX_COLOR.test(s) ? s : DEFAULT_COLOR;
}

/**
 * 功能：从错误对象里取一句能看的文案（服务端的原文优先，⛔ 不自己换一句话）。
 * @param {*} e - 抛出来的错误
 * @returns {string} 错误文案
 */
function msgOf(e) {
  return e && e.message ? e.message : '读取失败';
}

/**
 * 功能：把一个计数归一成「非负整数」，缺失 / 非数按 0（本轮评论 / 附件字段可能缺）。
 * @param {*} v - 原始计数
 * @returns {number} 非负整数
 */
function numOf(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 功能：判断两个账号 id 是不是同一个人 —— ⚠️ 先挡 `null` / 空串（`Number(null) === 0` 会误判）。
 * @param {*} a - 账号 id（甲）
 * @param {*} b - 账号 id（乙）
 * @returns {boolean} 是同一个有效账号则为 true
 */
function sameUser(a, b) {
  if (a == null || a === '' || b == null || b === '') return false;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * 功能：判断一个「宿主列」是不是空（⚠️ 先挡 `null` / 空串 —— 附件挂在任务 / 流水 / 项目哪一级看它）。
 * @param {*} v - `task_id` / `report_id` 之类的宿主列
 * @returns {boolean} 空则为 true
 */
function hostEmpty(v) {
  return v == null || v === '';
}

/**
 * 功能：把字节数格式化成一句能读的大小（`0 B` / `512 B` / `1.5 KB` / `3.2 MB`）。
 * @param {*} bytes - 字节数
 * @returns {string} 大小文案
 */
function fmtSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 功能：把服务端时间戳 `YYYY-MM-DD HH:mm:ss` 缩成评论区那行要的 `MM-DD HH:mm`。
 * 说明：⚠️ 认不出格式（长度不够）时**原样返回**，⛔ 不硬切出半个时间。
 * @param {*} s - 服务端时间戳
 * @returns {string} `MM-DD HH:mm` 或原串
 */
function fmtWhen(s) {
  const t = String(s == null ? '' : s);
  return t.length >= 16 ? t.slice(5, 16) : t;
}

/**
 * 功能：头像里那个「名字首字」（短视频评论区那一圈头像）—— 没名字时回 `?`。
 * @param {*} name - 显示名
 * @returns {string} 一个字符
 */
function initialOf(name) {
  const s = String(name == null ? '' : name).trim();
  return s ? s.slice(0, 1) : '?';
}

/**
 * 功能：一个附件的**上传者显示名** —— 服务端给了名字（`uploader_name`）就用它；否则在成员表里
 *      按 `uploader_id` 反查；查不到（账号已注销）⇒ `已注销成员`。
 *
 * 说明：⚠️ 服务端对已注销账号回的是带括号的「（已注销成员）」—— 这里**归一到共用文案** `已注销成员`
 *      （契约 §5 两端逐字一致），⛔ 不把括号那版直接摆到界面上。
 * @param {Object} f - 附件项
 * @param {Object} cfg - 取值包（读 `members`）
 * @returns {string} 上传者显示名
 */
function uploaderName(f, cfg) {
  const direct = f && (f.uploader_name || f.display_name || f.username);
  if (direct) {
    const s = String(direct);
    return s.indexOf('已注销') >= 0 ? GONE_USER : s;
  }
  const uid = f && f.uploader_id;
  if (hostEmpty(uid)) return GONE_USER;
  const list = (cfg && Array.isArray(cfg.members) && cfg.members) || [];
  const hit = list.find((m) => sameUser(m.user_id, uid));
  return hit && (hit.display_name || hit.username) ? hit.display_name || hit.username : GONE_USER;
}

/**
 * 功能：客户端**先挡一次**大小 / 类型（服务端那道 400 / 413 仍是最终判据）。
 * @param {File} file - 用户选中的文件
 * @returns {string} 不合法时回一句文案，合法回空串
 */
function checkFile(file) {
  if (!file) return FILE_TYPE_BAD;
  if (Number(file.size) > FILE_MAX) return FILE_TOO_BIG;
  const name = String(file.name == null ? '' : file.name);
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return FILE_EXT.includes(ext) ? '' : FILE_TYPE_BAD;
}

/**
 * 功能：附件那套 UI 的取值包（上传作用域 ＋ 成员表 ＋ 我是不是所有者 ＋ 我自己的账号 id）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板数据（读 `members` / `project.role`）
 * @param {string} up - 上传种类：`comment`（评论块）/ `flow`（活动某一条）
 * @param {?number|string} tid - 所属任务 id（项目级评论传空）
 * @param {?number|string} rid - 所属流水（上报）id（评论块传空）
 * @returns {Object} 取值包
 */
function fileCfg(st, b, up, tid, rid) {
  return {
    meId: st.me && st.me.id,
    members: (b && b.members) || [],
    owner: !!(b && b.project && b.project.role === 'owner'),
    up: up,
    upTid: hostEmpty(tid) ? '' : String(tid),
    upRid: hostEmpty(rid) ? '' : String(rid),
  };
}

/**
 * 功能：取**某一条评论自己的**附件 —— ⭐ 2g 的归属判据：附件行的 `comment_id` 等于这条评论的 `id`。
 * 说明：⚠️ 先挡 `null` / 空串（`Number(null) === 0` 是有限数，`sameUser` 已收口）；⛔ 不按顺序配。
 * @param {Array.<Object>} files - 全部附件项
 * @param {*} cid - 评论 id
 * @returns {Array.<Object>} 命中的附件项
 */
function filesOfComment(files, cid) {
  const list = Array.isArray(files) ? files : [];
  return list.filter((f) => f && sameUser(f.comment_id, cid));
}

/**
 * 功能：取挂在**任务 / 项目那一级、却没有 `comment_id`** 的老附件（收进「其他附件」那一小块）。
 * 说明：⚠️ 流水附件（`report_id` 有值）归活动块、评论附件（`comment_id` 有值）归评论行，都不进这里。
 * @param {Object} st - 状态（读 `files` / `cardFor`）
 * @param {string} scope - `card` / `proj`
 * @returns {Array.<Object>} 命中的附件项
 */
function otherFilesOf(st, scope) {
  const list = Array.isArray(st.files) ? st.files : [];
  return list.filter((f) => {
    if (!f || !hostEmpty(f.report_id) || !hostEmpty(f.comment_id)) return false;
    if (scope === 'proj') return hostEmpty(f.task_id);
    return sameUser(f.task_id, st.cardFor);
  });
}

/**
 * 功能：取挂在**某条流水**上的附件（活动块用，按 `report_id` 归位）。
 * @param {Object} st - 状态（读 `files`）
 * @param {*} rid - 流水（上报）id
 * @returns {Array.<Object>} 命中的附件项
 */
function filesOfFlow(st, rid) {
  const list = Array.isArray(st.files) ? st.files : [];
  return list.filter((f) => f && sameUser(f.report_id, rid));
}

/**
 * 功能：取**某张任务卡片上**的附件总数（卡片 `📎 n` 用；与服务端 `file_count` 同口径：按 `task_id`）。
 * @param {Object} st - 状态（读 `files`）
 * @param {*} tid - 任务 id
 * @returns {number} 附件条数
 */
function filesOfCard(st, tid) {
  const list = Array.isArray(st.files) ? st.files : [];
  return list.filter((f) => f && sameUser(f.task_id, tid)).length;
}

/**
 * 功能：把评论 / 流水按时间排序（评论正序、流水倒序），同一时间再按 id 归位。
 * 说明：⚠️ 服务端已排过一遍，这里再排是**兜底** —— 契约要求评论「按时间正序」、流水「时间倒序」，
 *      界面自己钉住这条，⛔ 不寄望上游顺序。`created_at` 是同格式的字符串，直接比字符串即可。
 * @param {*} raw - 服务端回的列表
 * @param {boolean} asc - true 为正序（评论），false 为倒序（流水）
 * @returns {Array.<Object>} 排好序的新数组
 */
function sortByTime(raw, asc) {
  const list = Array.isArray(raw) ? raw.slice() : [];
  list.sort((a, b) => {
    const x = String((a && a.created_at) || '');
    const y = String((b && b.created_at) || '');
    if (x !== y) return asc ? (x < y ? -1 : 1) : x > y ? -1 : 1;
    const ai = numOf(a && a.id);
    const bi = numOf(b && b.id);
    return asc ? ai - bi : bi - ai;
  });
  return list;
}

/**
 * 功能：把一个状态键翻成显示名（取该项目的状态集；认不出时原样显示那个键）。
 * 说明：⚠️ `from_status` / `to_status` 可能是空（老流水补不出改前状态）⇒ 显示 `—`；
 *      ⛔ 不对键做 `Number()`（键是带连字符的字符串）。
 * @param {Object} b - 看板数据（读 `states`）
 * @param {*} key - 状态键
 * @returns {string} 显示名或 `—`
 */
function stateName(b, key) {
  const k = key == null || key === '' ? '' : String(key);
  if (!k) return '—';
  const list = b && Array.isArray(b.states) ? b.states : [];
  const hit = list.find((s) => String(s.key == null ? '' : s.key) === k);
  return hit && (hit.name || k) ? hit.name || k : k;
}

/**
 * 功能：看板页头那句进度文案（⭐ 两端逐字一致：`已完成 {n} / 共 {m}`）。
 * @param {number} done - 已完成条数
 * @param {number} total - 参与进度的总条数（不含已取消）
 * @returns {string} 进度文案
 */
function progressText(done, total) {
  return '已完成 ' + done + ' / 共 ' + total;
}

/**
 * 功能：细进度条 —— 用原生 `<progress>`（宽度随值变化，⛔ 不写行内样式）。
 * @param {number} done - 已完成条数
 * @param {number} total - 总条数（为 0 时画 0%）
 * @returns {string} `<progress>` 标签
 */
function progressBarHtml(done, total) {
  const max = total > 0 ? total : 1;
  const val = total > 0 ? done : 0;
  return '<progress class="collab-progressbar" value="' + val + '" max="' + max + '"></progress>';
}

/**
 * 功能：一条任务的负责人显示名 —— `assignee_id` 有值且能在成员表里找到就用成员名，否则`未认领`。
 * @param {Object} b - 看板数据（读 `members`）
 * @param {Object} t - 任务行
 * @returns {string} 负责人显示名或 `未认领`
 */
function assigneeText(b, t) {
  const raw = t && t.assignee_id;
  if (raw == null || raw === '') return '未认领';
  const list = (b && b.members) || [];
  const hit = list.find((m) => Number(m.user_id) === Number(raw));
  return hit && (hit.display_name || hit.username) ? hit.display_name || hit.username : '未认领';
}

/**
 * 功能：取一条任务的截止日（空 / 缺 ⇒ 空串，卡片据此不画那一块）。
 * @param {Object} t - 任务行
 * @returns {string} `YYYY-MM-DD` 或空串
 */
function dueText(t) {
  if (!t) return '';
  const s = t.due_date;
  return s == null || s === '' ? '' : String(s);
}

/**
 * 功能：从时间戳里取前 10 位日期（`YYYY-MM-DD`）—— ⚠️ 长度不够（认不出）时回空串，⛔ 不硬切。
 * @param {*} v - `created_at` / `due_date` 这类时间戳
 * @returns {string} `YYYY-MM-DD` 或空串
 */
function date10(v) {
  const s = String(v == null ? '' : v);
  return s.length >= 10 ? s.slice(0, 10) : '';
}

/**
 * 功能：把一个 `YYYY-MM-DD` 换算成「自 epoch 起的天数」（甘特图算百分比用）—— 认不出回 `NaN`。
 * 说明：⚠️ 用 `Date.UTC` 而不是 `new Date(y,m,d)`：后者带本地时区，算出的天数在跨时区时会差一天。
 * @param {*} s - 日期串
 * @returns {number} 天序号（不是日期则 `NaN`）
 */
function dayNum(s) {
  const t = String(s == null ? '' : s);
  if (t.length < 10) return NaN;
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  const d = Number(t.slice(8, 10));
  if (!(y > 0 && m > 0 && d > 0)) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/**
 * 功能：一条任务**当前在哪一组**（甘特图的图例筛选靠它）—— 跨五组与 `unknown` 找。
 * @param {Object} b - 看板数据
 * @param {*} tid - 任务 id
 * @returns {string} 组键（`backlog` … / `unknown`），找不到为空串
 */
function groupOfTask(b, tid) {
  const id = Number(tid);
  const groups = b && b.groups ? b.groups : {};
  for (const k of GROUP_KEYS) {
    const arr = Array.isArray(groups[k]) ? groups[k] : [];
    if (arr.some((t) => Number(t.id) === id)) return k;
  }
  const unk = Array.isArray(b && b.unknown) ? b.unknown : [];
  return unk.some((t) => Number(t.id) === id) ? UNKNOWN_KEY : '';
}

/**
 * 功能：看板里**全部任务**摊平成一个数组（五组按序 ＋ 未知状态那一组放最后）。
 * @param {Object} b - 看板数据
 * @returns {Array.<Object>} 任务行数组
 */
function allTasks(b) {
  const groups = b && b.groups ? b.groups : {};
  const out = [];
  for (const k of GROUP_KEYS) {
    const arr = Array.isArray(groups[k]) ? groups[k] : [];
    for (const t of arr) out.push(t);
  }
  const unk = Array.isArray(b && b.unknown) ? b.unknown : [];
  for (const t of unk) out.push(t);
  return out;
}

/**
 * 功能：把任务按**截止日**排一遍（没截止日的排最后）—— 同一天再按创建日、最后按 id 归位。
 * 说明：⚠️ `YYYY-MM-DD` 字典序即时序，直接比字符串；⛔ 不转 `Date`。
 * @param {Array.<Object>} list - 任务行
 * @returns {Array.<Object>} 排好序的新数组
 */
function sortForGantt(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => {
    const da = dueText(a);
    const db = dueText(b);
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    }
    const ca = date10(a && a.created_at);
    const cb = date10(b && b.created_at);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return numOf(a && a.id) - numOf(b && b.id);
  });
  return arr;
}

/**
 * 功能：一条任务在时间轴上的**横条范围** —— 端点语义与电脑端**逐字同源**（`barSpanOf()`）：
 *      **起点 = `start_date || created_at`**，**终点 = `visEnd(t, 起点, today)`**；
 *      没有截止日时用**最新一条流水**兜底。
 *
 * 说明：⭐⭐ 2026-10-20（本版质检）：这里原来是「创建日 → 截止日」，而电脑端 0.8.17 已改成
 *      「任务日 → `visEnd()`」——于是**同一个项目在两端画出来的条位置不一样**：
 *      · 一条「上周建的、这周截止」的任务，电脑端从**任务日**起画、手机端从**创建日**起画
 *        （手机端那根条短了一截，且 8 月建的 9 月任务在 9 月那一周完全不出现）；
 *      · 已完成的任务电脑端止于**完成日**、手机端仍铺满到截止日；
 *      · 逾期未完成的电脑端**顺延到今天**、手机端不会。
 *      判据住在共用层 `core/task.js` 的 `visEnd()`（判据只准一处），
 *      ⛔ 别在这边自己再写一份。`visEnd()` 收的是日期字符串，所以这里直接传 `YYYY-MM-DD`。
 *      ⚠️⭐ `today` **必须传**（漏传不报错，只是「逾期顺延到今天」静默失效）。
 *      ⚠️ 数据不齐时兜底：什么都没有就拿今天；起点晚于终点时**对调**，⛔ 不画负宽度的条。
 * @param {Object} t - 任务行
 * @param {string} today - 今天（`YYYY-MM-DD`）
 * @param {string} [group] - 该任务所在的**组**（`completed` / `cancelled` 两支口径与电脑端一致）
 * @returns {{start: string, end: string}} 起止日期
 */
function barRange(t, today, group) {
  const due = dueText(t);
  const startRaw = date10(t && t.start_date) || date10(t && t.created_at) || due || today;
  let start = startRaw;
  let end = due;
  if (!end) {
    const flow = Array.isArray(t && t.flow) ? t.flow : [];
    let last = '';
    for (const f of flow) {
      const d = date10(f && f.created_at);
      if (d && (!last || d > last)) last = d;
    }
    end = last || start;
  }
  // ⭐⭐ 终点照电脑端套 `visEnd()`（已完成止于完成日 / 逾期未完成顺延到今天 / 周期任务不顺延）。
  //    ⚠️⭐ 两个**协作专有**的例外（电脑端 `barSpanOf()` 同一份口径，⛔ 别只改一边）：
  //    ① `completed` 组直接用 `completed_at` —— `visEnd()` → `doneInfo()` 只认 `status === 'done'`
  //       这个字面量，而协作的状态集是项目自配的（「验收通过」这类 key 落在完成组里它认不出）；
  //    ② `cancelled` 组只画到截止日 —— 作废的任务不该随时间一天天长到今天。
  const g = String(group == null ? '' : group);
  let ve;
  if (g === 'completed') {
    ve = date10(t && t.completed_at) || date10(visEnd(t, start, today));
  } else if (g === 'cancelled') {
    ve = due || end;
  } else {
    ve = date10(visEnd(t, start, today));
  }
  if (ve && ve >= start) end = ve;
  if (end < start) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return { start: start, end: end };
}

/**
 * 功能：这一屏时间轴的**第一天** —— 用户没自己翻过时，取**本周的周一**。
 *
 * 说明：⭐⭐ 0.8.53（纠正）：「手机端还是**一周一周的切换**，只是这一周的
 *      每一列显示宽一些，可以左右滑动」——
 *      · 窗口仍然**恰好一周**（周一起算七天），翻周（`« / »`）每次平移七天然；
 *      · 变的是**列宽**（`GANTT_COL_W` 88px）⇒ 一周 7 列比屏幕宽，靠横滑看本周剩下的日子；
 *      · 进来时把**今天**滑到屏幕中间（`paint()` 里那一段），别让第一眼看到的是一周的开头。
 *      ⚠️ 上一版曾把窗口做成五周长轴，被否掉 —— ⛔ 别再改回去。
 *      ⚠️ `st.gtStart` 有值（翻过周 / 点过今天）就一律听它 —— 与电脑端 `weekStartOf()` 同义。
 * @param {Object} st - 状态（读 `gtStart`）
 * @param {string} today - 今天（`YYYY-MM-DD`）
 * @returns {string} 时间轴第一天（`YYYY-MM-DD`）
 */
function fitStart(st, today) {
  return st && st.gtStart ? st.gtStart : mondayOf(today);
}

/**
 * 功能：时间轴这一屏要画的东西 —— 本周的七天 ＋ 筛选后的条（含裁到周界的起止列）。
 *
 * 说明：⭐⭐ 0.8.53（「还是一周一周的切换，只是这一周的每一列显示宽一些，
 * 可以左右滑动」）：
 *      · 窗口仍是**一周七天**（`GANTT_DAYS`），列宽 88px（`GANTT_COL_W`）⇒ 7 列比屏宽，
 *        本周内部靠横滑看完整；翻周仍走页头 `« / »`；
 *      · **待排期不进甘特图**：它在**甘特图下面**单独一块列表里
 *        （0.8.54 起从页头下面挪到这里），
 *        条只画 backlog 组以外的任务；
 *      · 每条任务都**照常列出来**（⛔ 不按窗口把任务筛掉）：条**裁到周界**（`cs` / `ce`）；
 *        ⭐⭐ 0.8.53（「所有过去的任务都会在当前周的最左侧显示」）：
 *        **整条落在本周之外（更早 / 更晚）的任务不再画** —— 与电脑端 `lanesOf()` 同一口径
 *        （`s > e` 就跳过）。从前收成第一列 / 最后一列的「贴边药丸」，过去的任务全堆在
 *        当前周最左侧一摞；要看它们用页头 `« / »` 翻到那一周。⭐ 剔除前的条数记在 `total`，
 *        空态文案靠它区分「真没有任务」和「有任务但不在这周」。
 *        所有条共用同一条时间轴 ⇒ 这里先把**重叠的条分道**（`lane`），
 *        渲染时条各占自己那道（`grid-row`），这就是「重叠自动错行」。
 *
 * @param {Object} st - 状态（读 `gtFilter` / `gtStart`）
 * @param {Object} b - 看板数据
 * @returns {Object} `{today, start, days, filter, rows, total, lanes}`（每行多带 `cs` / `ce` / `over` / `lane`）
 */
function ganttModel(st, b) {
  const today = todayStr();
  const start = fitStart(st, today);
  const days = [];
  for (let i = 0; i < GANTT_DAYS; i++) days.push(addDays(start, i));
  const filter = st.gtFilter || GANTT_ALL;
  const list = allTasks(b)
    .map((t) => ({ t: t, g: groupOfTask(b, t.id) }))
    .filter((r) => r.g !== 'backlog');
  const picked = filter === GANTT_ALL || filter === 'backlog' ? list : list.filter((r) => r.g === filter);
  const rows = sortForGantt(picked.map((r) => r.t)).map((t) => {
    const g = groupOfTask(b, t.id);
    // ⚠️ 组要传给 `barRange()`：`completed` / `cancelled` 两支的终点口径与普通任务不同
    return { t: t, g: g, bar: barRange(t, today, g) };
  });
  const w0 = dayNum(start);
  const wLast = w0 + GANTT_DAYS - 1;
  // ⭐⭐ 0.8.53：整条在本周之外的**不画**（与电脑端 `lanesOf()` 同口径）——
  //    从前收成第一列 / 最后一列的贴边药丸，过去的任务全堆在当前周最左侧。
  //    ⚠️ 剔除前先记 `total`（空态文案要区分「真没有任务」和「有任务但不在这周」）。
  const total = rows.length;
  const inWeek = rows.filter((r) => {
    const s0 = dayNum(r.bar.start);
    const e0 = dayNum(r.bar.end);
    return !(Number.isFinite(s0) && Number.isFinite(e0) && (e0 < w0 || s0 > wLast));
  });
  // ⭐ 裁到周界：起列 / 止列夹进 0~6（跨周长条只画落在本周那一段，照电脑端）。
  for (const r of inWeek) {
    const s = dayNum(r.bar.start);
    const e = dayNum(r.bar.end);
    r.cs = Number.isFinite(s) ? Math.max(0, Math.min(GANTT_DAYS - 1, s - w0)) : 0;
    r.ce = Number.isFinite(e) ? Math.max(0, Math.min(GANTT_DAYS - 1, e - w0)) : r.cs;
    if (r.ce < r.cs) r.ce = r.cs;
    // ⭐ 0.8.53（对齐电脑端 `.due`）：逾期**未完成**只红边红字，不动条色
    //    （已取消的顺延已被 `visEnd()` 免了，这里再按组挡一道，口径与电脑端 `barHtml()` 相同）。
    const dn = dayNum(r.t && r.t.due_date);
    r.over = r.g !== 'completed' && r.g !== 'cancelled' && Number.isFinite(dn) && dn < dayNum(today);
    // ⭐⭐ 2026-10-23（「24 号一天的任务，显示了 24 和 25」）：**不再给窄条加宽**。
    //    从前 1 天的条被撑到 2 列（`GANTT_MIN_COLS`），视觉上就跨了两天 —— 那是假的跨天。
    //    现在 1 天就占 1 列；名字放不下靠**列宽**（`GANTT_COL_W` = 88）解决。
  }
  // 贪心分道（与电脑端任务板同一套）：按起列排序，逐条放进「上一段已经结束」的第一条道，
  // 都放不下才新开一条 ⇒ 同一道里不会重叠，道数就是同时进行的任务峰值。
  const order = inWeek
    .slice()
    .sort((a, c) => a.cs - c.cs || (a.bar.start < c.bar.start ? -1 : a.bar.start > c.bar.start ? 1 : 0));
  const laneEnd = [];
  for (const r of order) {
    let lane = laneEnd.findIndex((last) => r.cs > last);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = r.ce;
    r.lane = lane;
  }
  return {
    today: today,
    start: start,
    days: days,
    filter: filter,
    rows: inWeek,
    total: total,
    lanes: Math.max(1, laneEnd.length),
  };
}

/**
 * 功能：建一份本片段自己的状态（一次挂载一份，重画不丢已选中的筛选与打开着的弹层）。
 * @param {Object} ctx - 槽的挂载上下文
 * @returns {Object} 状态对象
 */
function createState(ctx) {
  return {
    me: (ctx && ctx.me) || null,
    // ⚠️ 宿主把「点开的是哪一条」写进 ctx.collabPid（条目的 key = 项目 id 字符串）
    pid: ctx && ctx.collabPid != null ? String(ctx.collabPid) : '',
    board: null,
    boardErr: '',
    // ⭐ 甘特图顶部图例选中的那一组（`GANTT_ALL` ＝ 全部）
    gtFilter: GANTT_ALL,
    // ⭐ 0.8.53：时间轴窗口的第一天（`null` = 用默认窗口：今天所在周往前一周，见 `fitStart()`）
    gtStart: null,
    // ⭐ 0.8.53：横向滚动**是否已经居中过** —— 首帧数据到手时把今天滑到屏幕中间，
    //    之后的重画只还原用户自己滑到的位置（⛔ 别每次都把人拽回今天）。
    gtCentered: false,
    // ⭐ 0.8.53：翻周 / 点「今天」之后要把横向滚动**归零**（新的一周从周初看起）。
    gtReset: false,
    cardFor: 0,
    // ⭐ 0.8.53：待排期列表里点【转为任务】开的那条任务（0 = 没开）
    promoteFor: 0,
    // 卡片弹层里的两块（评论 / 该任务的活动流水）：`null` ＝ 还没读到
    cardComments: null,
    cardCommentsErr: '',
    cardActivity: null,
    cardActivityErr: '',
    stateOpen: false,
    newTaskOpen: false,
    transferOpen: false,
    transferPick: 0,
    membersOpen: false,
    addOpen: false,
    friends: null,
    friendErr: '',
    // ⭐ 2f：整个项目的附件（`null` ＝ 还没读到）＋ 每个成员上传了多少（`used`：账号 id → 字节）
    files: null,
    filesErr: '',
    used: {},
    // ⭐ 2g：发送前先攒在输入条里的待发文件（按评论作用域分）：发送时才建评论、再挂上去
    pend: { card: [], proj: [] },
    // 页头两颗弹层（项目级评论 / 整个项目的流水）
    projCommentsOpen: false,
    projComments: null,
    projCommentsErr: '',
    projActivityOpen: false,
    projActivity: null,
    projActivityErr: '',
    busy: false,
  };
}

// ================================================================ 取数

/**
 * 功能：取一个项目的**看板**（一次到位：状态集 / 五组 / 进度 / 成员 / 未知状态）。
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function fetchBoard(st) {
  const r = await api('GET', '/api/collab/projects/' + Number(st.pid) + '/board');
  st.board = r && r.groups ? r : null;
}

/**
 * 功能：取评论 —— `taskId` 为空串 / null 时取**项目级**评论，给了就取**该任务**的评论。
 * @param {Object} st - 状态
 * @param {?number|string} taskId - 任务 id（项目级评论传 null）
 * @returns {Promise.<Array.<Object>>} 评论项数组
 */
async function fetchComments(st, taskId) {
  const base = '/api/collab/projects/' + Number(st.pid) + '/comments';
  const url = taskId == null || taskId === '' ? base : base + '?task_id=' + Number(taskId);
  const r = await api('GET', url);
  return Array.isArray(r && r.items) ? r.items : [];
}

/**
 * 功能：取流水 —— `taskId` 为空串 / null 时取**整个项目**的流水，给了就取**该任务**的流水。
 * @param {Object} st - 状态
 * @param {?number|string} taskId - 任务 id（项目级流水传 null）
 * @returns {Promise.<Array.<Object>>} 流水项数组
 */
async function fetchActivity(st, taskId) {
  const base = '/api/collab/projects/' + Number(st.pid);
  const url = taskId == null || taskId === '' ? base + '/activity' : base + '/tasks/' + Number(taskId) + '/activity';
  const r = await api('GET', url);
  return Array.isArray(r && r.items) ? r.items : [];
}

/**
 * 功能：取一个项目的**全部附件**与**每个成员上传了多少**（⭐ 一次到位：`{items, used}`）。
 * 说明：⚠️ 一块读回来（不分任务 / 流水各取一遍）—— 界面按 `task_id` / `report_id` 自己归位；
 *      `used` 只统计**不限额**。
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function fetchFiles(st) {
  const r = await api('GET', '/api/collab/projects/' + Number(st.pid) + '/files');
  st.files = Array.isArray(r && r.items) ? r.items : [];
  st.used = r && r.used && typeof r.used === 'object' ? r.used : {};
}

/**
 * 功能：取一次看板并重画（进项目 / 写操作后 / 手动重试都走它）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function reloadBoard(root, st) {
  st.boardErr = '';
  try {
    await fetchBoard(st);
  } catch (e) {
    st.boardErr = msgOf(e);
  }
  // ⭐ 2f：看板带上附件（卡片的 `📎 n` 与成员用量都要它）。⚠️ 读不到不拖垮看板，只记一句错误。
  st.filesErr = '';
  try {
    await fetchFiles(st);
  } catch (e) {
    st.files = st.files || [];
    st.filesErr = msgOf(e);
  }
  paint(root, st);
}

/**
 * 功能：取一份「可以拉进项目的好友」清单（好友功能不在时服务端回 503，这里如实转达）。
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadFriends(st) {
  st.friendErr = '';
  try {
    const r = await api('GET', '/api/collab/friends');
    st.friends = Array.isArray(r && r.items) ? r.items : [];
  } catch (e) {
    st.friends = [];
    st.friendErr = msgOf(e);
  }
}

// ================================================================ 写操作

/**
 * 功能：所有者把一个好友加进项目（服务端会判「必须是好友」，不是好友回 404，如实转达）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function addMember(root, st) {
  if (st.busy) return;
  const sel = document.querySelector('.collab-add [data-role="friend"]');
  const uid = sel ? Number(sel.value) : 0;
  if (!Number.isInteger(uid) || uid <= 0) {
    toast('先选一个好友', true);
    return;
  }
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/members', { user_id: uid });
    toast('已加进项目');
    st.addOpen = false;
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：所有者把一个人移出项目。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} uid - 被移出的人
 * @returns {Promise.<void>}
 */
async function removeMember(root, st, uid) {
  if (st.busy) return;
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/projects/' + st.pid + '/members/' + Number(uid));
    toast('已移出');
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：把项目**移出协作**（`PUT .../shared { shared:false }`）。
 *
 * 说明：⚠️ 移出**只置 `shared = 0`、不清成员名单**—— 重新加回来成员照旧看得见。
 *      移出后这个项目不再属于协作 ⇒ 宿主会把它从列表页「协作项目」组里去掉，所以这里先请
 *      **登记器**（`mobile-teamwork-page.js`）重取项目列表，再请**宿主**把第二屏关掉、退回列表
 *      （两个方向各一个留白事件，⛔ 别直接改宿主的 DOM）。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function unshareProject(root, st) {
  if (st.busy) return;
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + st.pid + '/shared', { shared: false });
    toast('已移出协作');
    document.dispatchEvent(new CustomEvent('zx:teamwork-collab-refresh'));
    document.dispatchEvent(new CustomEvent('zx:teamwork-board-close'));
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：**任何成员**都能在看板里新建一条任务（⛔ 推翻 `C-15`）。
 *
 * 说明：⭐⭐ 0.8.53：与电脑端 `createTask()` 同一套口径 ——
 *      · 补上「任务类型」（普通 / 窗口 / 周期）与「任务日」；
 *      · 状态落在 **backlog 组（待排期）** 时**日期与类型整块不发**（服务端对 backlog 组也不写日期）；
 *      · 窗口任务两个时刻必填、同一天要比先后。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function createTask(root, st) {
  if (st.busy) return;
  const titleEl = document.querySelector('[data-role="nt-title"]');
  const statusEl = document.querySelector('[data-role="nt-status"]');
  const whoEl = document.querySelector('[data-role="nt-assignee"]');
  const startEl = document.querySelector('[data-role="nt-start"]');
  const dueEl = document.querySelector('[data-role="nt-due"]');
  const descEl = document.querySelector('[data-role="nt-desc"]');
  const title = titleEl ? String(titleEl.value || '').trim() : '';
  if (!title) {
    toast('请填写任务标题', true);
    return;
  }
  const opt = statusEl && statusEl.selectedOptions ? statusEl.selectedOptions[0] : null;
  const group = opt ? String(opt.dataset.group || '') : '';
  const backlog = group === 'backlog';
  const body = {
    title: title,
    status: statusEl ? String(statusEl.value || '') : '',
    description: descEl ? String(descEl.value || '') : '',
  };
  const uid = whoEl ? Number(whoEl.value) : 0;
  if (Number.isInteger(uid) && uid > 0) body.assignee_id = uid;
  if (!backlog) {
    const start = startEl ? String(startEl.value || '').trim() : '';
    const due = dueEl ? String(dueEl.value || '').trim() : '';
    if (!start || !due) {
      toast('请选择任务日与截止日期', true);
      return;
    }
    if (start > due) {
      toast('任务日不能晚于截止日期', true);
      return;
    }
    const kf = readKindFields('nt');
    if (!kf) {
      toast('周期规则至少要设一期', true);
      return;
    }
    if (kf.task_kind === 'window') {
      if (!kf.start_time || !kf.due_time) {
        toast('窗口任务要填开始与截止时刻', true);
        return;
      }
      if (start === due && kf.start_time >= kf.due_time) {
        toast('同一天的窗口，开始时刻要早于截止时刻', true);
        return;
      }
    }
    body.start_date = start;
    body.due_date = due;
    body.task_kind = kf.task_kind;
    body.start_time = kf.start_time;
    body.due_time = kf.due_time;
    body.recur_rule = kf.recur_rule;
  }
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/tasks', body);
    toast('已新建任务');
    st.newTaskOpen = false;
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：待排期任务【转为任务】—— 读任务日 / 截止日 ＋ 任务类型块，`PUT` 一次就把它挪出待排期。
 *
 * 说明：⭐⭐ 与电脑端 `promoteTask()` 同一套判据：状态落到「未开始」组的默认状态
 *      （`stateKeyOfGroup()`，⛔ 不写死 `todo`）；类型四项一次发全，改回普通时才能清掉旧规则。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function promoteTask(root, st) {
  if (st.busy) return;
  const t = findCard(st.board, st.promoteFor);
  if (!t) return;
  const modal = document.querySelector('[data-role="pm-dates"]');
  const box = modal ? modal.closest('.collab-modal') : null;
  if (!box) return;
  /**
   * 功能：取弹层里某一格的值。
   * @param {string} role - `data-role`
   * @returns {string} 值（取不到回空串）
   */
  const val = (role) => {
    const el = box.querySelector('[data-role="' + role + '"]');
    return el ? String(el.value == null ? '' : el.value) : '';
  };
  const kf = readKindFields('pm');
  if (!kf) {
    toast('周期规则至少要设一期', true);
    return;
  }
  const start = val('pm-start');
  const due = val('pm-due');
  if (!start || !due) {
    toast('请选择任务日与截止日期', true);
    return;
  }
  if (start > due) {
    toast('任务日不能晚于截止日期', true);
    return;
  }
  if (kf.task_kind === 'window') {
    if (!kf.start_time || !kf.due_time) {
      toast('窗口任务要填开始与截止时刻', true);
      return;
    }
    if (start === due && kf.start_time >= kf.due_time) {
      toast('同一天的窗口，开始时刻要早于截止时刻', true);
      return;
    }
  }
  const body = {
    task_kind: kf.task_kind,
    start_date: start,
    due_date: due,
    start_time: kf.start_time,
    due_time: kf.due_time,
    recur_rule: kf.recur_rule,
  };
  const status = stateKeyOfGroup(st.board, 'unstarted', 'todo');
  if (status) body.status = status;
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + st.pid + '/tasks/' + Number(t.id), body);
    toast('已转为任务');
    st.promoteFor = 0;
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：把一条周期规则折成**可比较的字符串**（判「用户到底改没改任务类型」用）。
 *
 * 说明：⚠️ 库里存的是规范化 JSON **文本**、编辑器读回来的是对象 ⇒ 直接比永远不等；
 *      这里用 `parseRule()`（共用层的唯一解析口）把两边折成同一形状再比。
 * @param {*} v - 规则（对象 / JSON 文本 / 空）
 * @returns {string} `freq:起-止,起-止` 或空串
 */
function ruleKeyOf(v) {
  const r = parseRule(v);
  if (!r) return '';
  const slots = Array.isArray(r.slots) ? r.slots : [];
  return String(r.freq) + ':' + slots.map((s) => Number(s[0]) + '-' + Number(s[1])).join(',');
}

/**
 * 功能：任务类型这一维（类型 / 两个时刻 / 循环规则）**有没有被改过**。
 * @param {Object} t - 库里的任务
 * @param {Object} kf - `readKindFields()` 的产物
 * @returns {boolean} 任一项不同则为 true
 */
function kindChanged(t, kf) {
  if (String(t.task_kind || 'plain') !== String(kf.task_kind || 'plain')) return true;
  if (String(t.start_time || '') !== String(kf.start_time || '')) return true;
  if (String(t.due_time || '') !== String(kf.due_time || '')) return true;
  return ruleKeyOf(t.recur_rule) !== ruleKeyOf(kf.recur_rule);
}

/**
 * 功能：卡片弹层里那颗「确定」—— 读六格（标题 / 描述 / 任务日 / 截止日 / 状态 / 负责人），
 *      **只发改动过的字段**（⛔ 不误伤其它列：四象限 / 标签 / 任务类型 / 绑定网址一个字节都不动）。
 *
 * 说明：⭐ 2026-10-20（「团队协作的任务详情，也要可以编辑任务」）：从前这里只读「状态 / 负责人」。
 *      ⚠️ 日期两格**绑定在一起**：任一改动就两个都发 —— 服务端 `badDateRange` 只在「两个都在
 *      请求里」时才比大小，只发改动的那个会绕过区间校验（出现「截止日早于任务日」）。
 *      ⚠️ 标题空着**不发**（服务端对「带了但是空」一律 400），先说人话。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} tid - 任务 id
 * @returns {Promise.<void>}
 */
async function saveCard(root, st, tid) {
  if (st.busy) return;
  const t = findCard(st.board, tid);
  if (!t) return;
  // ⭐ 0.8.54：弹层本体已经是宿主 `#sheet.body`（不再是自绘的 `.collab-modal`）
  const card = document.getElementById('sheet-body');
  if (!card) return;
  /** 取弹层里某一格的值（取不到回空串） */
  const val = (role) => {
    const el = card.querySelector('[data-role="' + role + '"]');
    return el ? String(el.value == null ? '' : el.value) : '';
  };
  const body = {};
  // ---- 标题 / 描述：只发改动过的（两端都按 trim 后比 —— 服务端 `checkTaskInput` 会 trim）
  const title = val('card-title').trim();
  if (!title) {
    toast('任务标题不能为空', true);
    return;
  }
  if (title !== String(t.title == null ? '' : t.title).trim()) body.title = title;
  const desc = val('card-desc').trim();
  if (desc !== String(t.description == null ? '' : t.description).trim()) body.description = desc;
  // ---- 状态 / 负责人（沿用原来的两条口径：空值不发）
  const sEl = card.querySelector('[data-role="card-status"]');
  const aEl = card.querySelector('[data-role="card-assignee"]');
  // ⭐⭐ 0.8.53：**保存后的组**决定「日期与类型要不要发」—— 落进 backlog 组（待排期）
  //    就是「还没排期」：日期由服务端清空、类型也不该带着（与电脑端 `saveCard()` 同一条）。
  const states = Array.isArray(st.board && st.board.states) ? st.board.states : [];
  const curState = states.find((s) => String(s.key) === String(t.status == null ? '' : t.status));
  const nextOpt = sEl && sEl.selectedOptions ? sEl.selectedOptions[0] : null;
  const nextGroup = nextOpt ? String(nextOpt.dataset.group || '') : curState ? String(curState.group || '') : '';
  if (nextGroup !== 'backlog') {
    // ---- 日期区间：任一改动就**两个一起发**（局部更新时服务端不替你比大小）
    const start = val('card-start');
    const due = val('card-due');
    if (start !== date10(t.start_date) || due !== date10(t.due_date)) {
      if (start && due && start > due) {
        toast('任务日不能晚于截止日期', true);
        return;
      }
      body.start_date = start;
      body.due_date = due;
    }
    // ---- 任务类型：类型 / 时刻 / 规则任一变化 ⇒ 四项一起发（改回普通时才能把旧规则清掉）
    const kf = readKindFields('cd');
    if (!kf) {
      toast('周期规则至少要设一期', true);
      return;
    }
    if (kf.task_kind === 'window' && (!kf.start_time || !kf.due_time)) {
      toast('窗口任务要填开始与截止时刻', true);
      return;
    }
    if (kindChanged(t, kf)) {
      body.task_kind = kf.task_kind;
      body.start_time = kf.start_time;
      body.due_time = kf.due_time;
      body.recur_rule = kf.recur_rule;
    }
  }
  // ⚠️⭐ 2026-10-20（本版质检）：与电脑端 `saveCard()` 同一条口径 —— **空状态不发**。
  //    任务状态不在本项目状态集里时，下拉的 `value` 是空串（占位项），照发会把真实状态静默抹成空。
  if (sEl && String(sEl.value == null ? '' : sEl.value) !== '' && sEl.value !== sEl.dataset.init) {
    body.status = String(sEl.value);
  }
  // ⚠️ 负责人选「未认领」时**不发**（服务端把空值当「回落所有者」，那会静默改库）
  if (aEl && aEl.value !== aEl.dataset.init && aEl.value !== '') body.assignee_id = Number(aEl.value);
  if (!Object.keys(body).length) {
    st.cardFor = 0;
    paint(root, st);
    return;
  }
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + st.pid + '/tasks/' + Number(tid), body);
    toast('已更新');
    st.cardFor = 0;
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：所有者改一个状态（改名 / 调色 / 改组）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} sid - 状态 id
 * @returns {Promise.<void>}
 */
async function saveState(root, st, sid) {
  if (st.busy) return;
  const row = document.querySelector('.collab-strow[data-sid="' + Number(sid) + '"]');
  if (!row) return;
  const nameEl = row.querySelector('[data-role="st-name"]');
  const colorEl = row.querySelector('[data-role="st-color"]');
  const groupEl = row.querySelector('[data-role="st-group"]');
  const name = nameEl ? String(nameEl.value || '').trim() : '';
  if (!name) {
    toast('状态名不能为空', true);
    return;
  }
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + st.pid + '/states/' + Number(sid), {
      name: name,
      color: colorEl ? String(colorEl.value || '') : '',
      group: groupEl ? String(groupEl.value || '') : '',
    });
    toast('已保存');
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：所有者删一个状态 —— ⚠️ 三条禁令由服务端回 400，前端把**原文**弹出来（⛔ 不静默）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} sid - 状态 id
 * @returns {Promise.<void>}
 */
async function deleteState(root, st, sid) {
  if (st.busy) return;
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/projects/' + st.pid + '/states/' + Number(sid));
    toast('已删除');
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：所有者新增一个状态（状态名 / 颜色 / 所属组）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function addState(root, st) {
  if (st.busy) return;
  const nameEl = document.querySelector('[data-role="ns-name"]');
  const colorEl = document.querySelector('[data-role="ns-color"]');
  const groupEl = document.querySelector('[data-role="ns-group"]');
  const name = nameEl ? String(nameEl.value || '').trim() : '';
  if (!name) {
    toast('状态名不能为空', true);
    return;
  }
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/states', {
      name: name,
      color: colorEl ? String(colorEl.value || '') : '',
      group: groupEl ? String(groupEl.value || '') : '',
    });
    toast('已新增状态');
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：所有者把项目**转让**给一个成员（已二次确认过）⇒ 之后角色会变，重取看板并请登记器刷新。
 *
 * 说明：⭐ 已设的负责人全不变、⛔ 不动成员名单；转让成功后我在这个项目里的角色会变，
 *      所以看板要重取，并请**登记器**重取项目列表（列表页那一行的角色副标题跟着变）。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function confirmTransfer(root, st) {
  if (st.busy) return;
  const uid = Number(st.transferPick);
  if (!Number.isInteger(uid) || uid <= 0) return;
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/transfer', { user_id: uid });
    toast('已转让');
    st.transferOpen = false;
    st.transferPick = 0;
    document.dispatchEvent(new CustomEvent('zx:teamwork-collab-refresh'));
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

// ================================================================ 评论 / 活动（2d）

/**
 * 功能：只重画弹层里**评论区那一块**（⛔ 不动整屏，避免发 / 删评论 / 传附件时整个看板闪一下）。
 * 说明：⚠️ 重画前先记下输入框里已打好的字，重画后放回去（⛔ 别把用户打了一半的评论抹掉）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {string} role - 那一块的 `data-role`（`card-comments-body` / `proj-comments-body`）
 * @param {Array.<Object>} list - 评论项（`null` ＝ 还在读）
 * @param {string} err - 读取错误（空串 ＝ 没出错）
 * @param {Object} cfg - 输入框 / 动作名 / 我自己的账号 id / 附件作用域
 * @returns {void}
 */
function paintCommentsBody(root, role, list, err, cfg) {
  const box = document.querySelector('[data-role="' + role + '"]');
  if (!box) return;
  const inp = box.querySelector('[data-role="' + cfg.input + '"]');
  const keep = inp ? String(inp.value == null ? '' : inp.value) : '';
  box.innerHTML = commentsInnerHtml(list, err, cfg);
  if (keep) {
    const next = box.querySelector('[data-role="' + cfg.input + '"]');
    if (next) next.value = keep;
  }
}

/**
 * 功能：只重画弹层里**活动那一块**（同上，⛔ 不整屏重画）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {string} role - 那一块的 `data-role`（`card-activity-body` / `proj-activity-body`）
 * @param {Array.<Object>} list - 流水项（`null` ＝ 还在读）
 * @param {string} err - 读取错误（空串 ＝ 没出错）
 * @param {Object} b - 看板数据（流水里的状态键要翻成显示名）
 * @param {boolean} showTask - 是否显示「哪条任务」（项目级要、任务级不要）
 * @param {Object} st - 状态（⭐ 2f：每条流水挂自己的附件要读 `files`）
 * @returns {void}
 */
function paintActivityBody(root, role, list, err, b, showTask, st) {
  const box = document.querySelector('[data-role="' + role + '"]');
  if (box) box.innerHTML = activityInnerHtml(list, err, b, showTask, st);
}

/**
 * 功能：把任务卡片上那枚 `💬 n` 与看板内存里的 `comment_count` 一并对齐（发 / 删评论后调用）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function syncCardCommentCount(root, st) {
  if (st.cardCommentsErr) return;
  const n = Array.isArray(st.cardComments) ? st.cardComments.length : 0;
  const t = findCard(st.board, st.cardFor);
  if (t) t.comment_count = n;
  const badge = document.querySelector('[data-role="badge-cmt"][data-tid="' + Number(st.cardFor) + '"]');
  if (badge) badge.textContent = '💬 ' + n;
}

/**
 * 功能：取**该任务**的评论并只重画卡片弹层里的评论区。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadCardComments(root, st) {
  // ⚠️⭐ 2026-10-20（本版质检）：**取哪条任务要在 await 之前记下来**。
  //    这里原先是 `fetchComments(st, st.cardFor)` —— `await` 回来之后没有再核对「用户是不是已经
  //    点了另一条任务」，于是慢网下「点 A → 关掉 → 点 B」会把 A 的评论**画进 B 的弹层**
  //    （作者 / 附件全错，且不报错）。`loadCardActivity()` 同一条。
  const tid = Number(st.cardFor);
  let list = null;
  let err = '';
  try {
    list = sortByTime(await fetchComments(st, tid), true);
  } catch (e) {
    err = msgOf(e);
  }
  if (Number(st.cardFor) !== tid) return; // 已经换成别的任务 ⇒ 这一趟作废
  st.cardComments = list;
  st.cardCommentsErr = err;
  paintCommentsBody(root, 'card-comments-body', st.cardComments, st.cardCommentsErr, cardCfg(st));
  syncCardCommentCount(root, st);
}

/**
 * 功能：取**该任务**的活动流水并只重画卡片弹层里的活动块。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadCardActivity(root, st) {
  // ⚠️ 与 `loadCardComments()` 同一条：`await` 前后都必须是**同一条任务**（否则 A 的流水画进 B 的弹层）
  const tid = Number(st.cardFor);
  let list = null;
  let err = '';
  try {
    list = sortByTime(await fetchActivity(st, tid), false);
  } catch (e) {
    err = msgOf(e);
  }
  if (Number(st.cardFor) !== tid) return;
  st.cardActivity = list;
  st.cardActivityErr = err;
  paintActivityBody(root, 'card-activity-body', st.cardActivity, st.cardActivityErr, st.board, false, st);
}

/**
 * 功能：取**项目级**评论并只重画项目评论弹层里的评论区。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadProjComments(root, st) {
  try {
    st.projComments = sortByTime(await fetchComments(st, null), true);
    st.projCommentsErr = '';
  } catch (e) {
    st.projCommentsErr = msgOf(e);
  }
  paintCommentsBody(root, 'proj-comments-body', st.projComments, st.projCommentsErr, projCfg(st));
}

/**
 * 功能：取**整个项目**的活动流水并只重画项目活动弹层里的活动块。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadProjActivity(root, st) {
  try {
    st.projActivity = sortByTime(await fetchActivity(st, null), false);
    st.projActivityErr = '';
  } catch (e) {
    st.projActivityErr = msgOf(e);
  }
  paintActivityBody(root, 'proj-activity-body', st.projActivity, st.projActivityErr, st.board, true, st);
}

/**
 * 功能：⭐ 2g 发一条评论 —— **先建评论拿到新 id，再把输入条里攒的待发文件逐条挂上去**。
 *
 * 说明：⚠️ 两步的先后不可换：附件要带 `comment_id`，而评论 id 是 `POST …/comments` 之后才有的。
 *      评论建好后无论附件有没有挂上都**清空输入框与待发队列**（评论已经成立，⛔ 不假装没发生），
 *      再重取评论与附件两块；某条附件失败时把服务端原话弹出来（⛔ 不静默）。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `card`（卡片弹层的任务评论）/ `proj`（项目级评论）
 * @param {?number|string} taskId - 任务 id（项目级评论传 null）
 * @param {Function} reload - 成功后重取哪一块（`loadCardComments` / `loadProjComments`）
 * @returns {Promise.<void>}
 */
async function sendComment(root, st, scope, taskId, reload) {
  if (st.busy) return;
  const cfg = scope === 'proj' ? projCfg(st) : cardCfg(st);
  const el = document.querySelector('[data-role="' + cfg.input + '"]');
  const body = el ? String(el.value == null ? '' : el.value).trim() : '';
  if (!body) {
    toast(COMMENT_NEED_BODY, true);
    return;
  }
  const pend = st.pend[scope].slice();
  const payload = { body: body };
  if (taskId != null && taskId !== '') payload.task_id = Number(taskId);
  st.busy = true;
  try {
    const r = await api('POST', '/api/collab/projects/' + Number(st.pid) + '/comments', payload);
    const cid = r && r.item && !hostEmpty(r.item.id) ? Number(r.item.id) : 0;
    let failed = '';
    if (cid > 0 && pend.length) failed = await uploadCommentFiles(st, scope, cid, pend);
    st.pend[scope] = [];
    if (el) el.value = '';
    await reload(root, st);
    await afterFilesChanged(root, st);
    if (failed) toast(failed, true);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：删一条**自己发的**评论（`DELETE /api/collab/comments/:id`）⇒ 成功后只重取评论区那一块。
 *
 * 说明：⚠️ 界面上只给自己那条画「删除」，越权时服务端回 404 ⇒ 用契约 §3 的兜底文案（⛔ 不静默）。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} cid - 评论 id
 * @param {string} scope - `card`（卡片弹层）/ `proj`（项目弹层）
 * @returns {Promise.<void>}
 */
async function deleteComment(root, st, cid, scope) {
  if (st.busy) return;
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/comments/' + Number(cid));
    if (scope === 'proj') await loadProjComments(root, st);
    else await loadCardComments(root, st);
  } catch (e) {
    toast(e && e.status === 404 ? DELETE_DENY : msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

// ================================================================ 附件（2f）

/**
 * 功能：把卡片上那枚 `📎 n` 与看板内存里的 `file_count` 一并对齐（传 / 删附件后调用）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function syncCardFileCount(root, st) {
  if (!st.cardFor) return;
  const n = filesOfCard(st, st.cardFor);
  const t = findCard(st.board, st.cardFor);
  if (t) t.file_count = n;
  const badge = document.querySelector('[data-role="badge-file"][data-tid="' + Number(st.cardFor) + '"]');
  if (badge) badge.textContent = '📎 ' + n;
}

/**
 * 功能：只重画成员块里那句「每个成员上传了多少」（附件增删后调用）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function paintUsage(root, st) {
  const box = document.querySelector('[data-role="collab-usage"]');
  // ⚠️⭐ 2026-10-20（本版质检）：`usageHtml()` 的**第二个参数是看板数据**（它要从 `b.members`
  //    取成员名单、逐人一行）。原先这里只传了 `st` ⇒ `b` 是 `undefined` ⇒ 名单被当成空数组，
  //    于是**名单里每一个人都不见了**，只剩最下面那行「已注销成员 N MB」（把所有用量加总进去）。
  //    触发点：在成员管理弹层开着时传 / 删一个附件（`afterFilesChanged()` → 本函数）。
  //    ⛔ 别再把 `st.board` 省掉 —— 少传一个参数不报错，只是整块用量说错了话。
  if (box) box.innerHTML = usageHtml(st, st.board);
}

/**
 * 功能：附件增删成功后 —— 重取附件一次，再**只重画受影响的那几块**
 *      （成员用量 ＋ 当前弹层的评论 / 活动两块 ＋ 打开着的那张卡片的 `📎 n`），⛔ 不整屏重画。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function afterFilesChanged(root, st) {
  st.filesErr = '';
  try {
    await fetchFiles(st);
  } catch (e) {
    st.filesErr = msgOf(e);
  }
  paintUsage(root, st);
  if (st.cardFor) {
    paintCommentsBody(root, 'card-comments-body', st.cardComments, st.cardCommentsErr, cardCfg(st));
    paintActivityBody(root, 'card-activity-body', st.cardActivity, st.cardActivityErr, st.board, false, st);
  } else if (st.projCommentsOpen) {
    paintCommentsBody(root, 'proj-comments-body', st.projComments, st.projCommentsErr, projCfg(st));
  } else if (st.projActivityOpen) {
    paintActivityBody(root, 'proj-activity-body', st.projActivity, st.projActivityErr, st.board, true, st);
  }
  syncCardFileCount(root, st);
}

/**
 * 功能：把用户选中的文件上传（⭐ 二进制走裸 `fetch`，元数据走**查询串**）。
 *
 * 说明：⚠️ ⛔ 不用拖拽、不用 `api()`（它固定 JSON 体）—— `body` 直接是 `File`，
 *      `Content-Type` 写死 `application/octet-stream`；`task_id` / `report_id` 挂在查询串上。
 *      成功 / 失败后**只重取附件那一块**（`afterFilesChanged`），并弹服务端原话。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {HTMLInputElement} el - 触发这次上传的 `<input type="file">`
 * @param {File} file - 用户选中的文件
 * @returns {Promise.<void>}
 */
async function uploadFile(root, st, el, file) {
  const bad = checkFile(file);
  if (bad) {
    toast(bad, true);
    return;
  }
  if (st.busy) return;
  st.busy = true;
  try {
    const qs = ['name=' + encodeURIComponent(String(file.name == null ? '' : file.name))];
    const tid = el.dataset.tid;
    const rid = el.dataset.rid;
    if (!hostEmpty(tid)) qs.push('task_id=' + Number(tid));
    if (!hostEmpty(rid)) qs.push('report_id=' + Number(rid));
    const url = BASE + '/api/collab/projects/' + Number(st.pid) + '/files?' + qs.join('&');
    const r = await fetch(url, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const j = await r.json().catch(() => null);
    if (r.status === 401) {
      backToLogin();
      const e401 = new Error('登录已过期，正在回到登录页…');
      e401.status = 401;
      throw e401;
    }
    if (!r.ok) {
      const err = new Error((j && j.error) || 'HTTP ' + r.status);
      err.status = r.status;
      throw err;
    }
    toast('已上传附件');
    await afterFilesChanged(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：删一个附件（`DELETE /api/collab/files/:fid`）。
 *
 * 说明：⚠️ **上传者自己 ＋ 项目所有者**都能删——
 *      按钮的可见性在 `fileRowHtml` 里已按这条收口，越权时服务端回 404，这句原话照弹。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} fid - 附件 id
 * @returns {Promise.<void>}
 */
async function deleteFile(root, st, fid) {
  if (st.busy) return;
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/files/' + Number(fid));
    toast('已删除');
    await afterFilesChanged(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：下载一个附件 —— **真点一次临时 `<a>`**（与电脑端同一套做法，⛔ 不开新窗口内联渲染）。
 *
 * 说明：⚠️ 服务端那条路带 `Content-Disposition: attachment`⇒ 浏览器只下载、
 *      ⛔ 不会把 PDF / HTML 内联画出来；这里**刻意不加** `download` 属性（文件名由服务端那个头给）——
 *      加了它反而在**跨源 iframe**（飞牛桌面嵌本应用）下被忽略 / 被沙箱拦下，表现就是
 *      「点了没反应」。⚠️ id 非正整数时**什么都不做**（⛔ 不发一个必然 404 的请求）。
 * @param {number|string} fid - 附件 id
 * @returns {void}
 */
function downloadFile(fid) {
  const id = Number(fid);
  if (!Number.isInteger(id) || id <= 0) return;
  const a = document.createElement('a');
  a.href = BASE + '/api/collab/files/' + id;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 功能：把输入条里攒着的待发文件**逐条挂到刚建好的那条评论上**（⭐ 2g 的第二步）。
 *
 * 说明：⚠️ 元数据走**查询串**：`name` ＋（卡片评论再带 `task_id`）＋ **必带的 `comment_id`**；
 *      二进制体走裸 `fetch`（同 `uploadFile`）。⚠️ 一条失败**不阻断**后面的（评论已经建好，
 *      ⛔ 不因为一个附件失败就把其余全丢），回**第一句**失败文案给调用方弹出来。
 *
 * @param {Object} st - 状态
 * @param {string} scope - `card` / `proj`
 * @param {number} cid - 刚建好的评论 id
 * @param {Array.<File>} files - 待发文件
 * @returns {Promise.<string>} 第一句失败文案（全成功为空串）
 */
async function uploadCommentFiles(st, scope, cid, files) {
  const tid = scope === 'card' ? st.cardFor : '';
  let firstErr = '';
  for (const file of files) {
    try {
      const qs = ['name=' + encodeURIComponent(String(file && file.name == null ? '' : file.name))];
      if (!hostEmpty(tid)) qs.push('task_id=' + Number(tid));
      qs.push('comment_id=' + Number(cid));
      const url = BASE + '/api/collab/projects/' + Number(st.pid) + '/files?' + qs.join('&');
      const r = await fetch(url, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const j = await r.json().catch(() => null);
      if (r.status === 401) {
        backToLogin();
        const e401 = new Error('登录已过期，正在回到登录页…');
        e401.status = 401;
        throw e401;
      }
      if (!r.ok) {
        const err = new Error((j && j.error) || 'HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
    } catch (e) {
      if (!firstErr) firstErr = msgOf(e);
    }
  }
  return firstErr;
}

/**
 * 功能：文件选择框的 change 委托入口（`<input type="file">` 选中文件后走它）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {Event} e - change 事件
 * @returns {void}
 */
function onFilePick(root, st, e) {
  const el = e.target;
  if (!el || el.type !== 'file') return;
  const file = el.files && el.files[0];
  // ⚠️ 先清空 value：上传失败后重选**同一个文件**也要能触发 change
  el.value = '';
  if (!file) return;
  // ⭐ 2g：评论输入条那颗 `＋` 选的先**攒着**（画成 chips），点「发送」才上传
  if (el.dataset.staged) {
    repaintStaged(root, st, el.dataset.staged, file);
    return;
  }
  uploadFile(root, st, el, file);
}

/**
 * 功能：只手重画**某一档的评论区**（传 / 删 chip 后调用；⛔ 不整屏重画）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `card` / `proj`
 * @returns {void}
 */
function repaintCommentBody(root, st, scope) {
  if (scope === 'proj') {
    paintCommentsBody(root, 'proj-comments-body', st.projComments, st.projCommentsErr, projCfg(st));
  } else {
    paintCommentsBody(root, 'card-comments-body', st.cardComments, st.cardCommentsErr, cardCfg(st));
  }
}

/**
 * 功能：⭐ 2g 把评论输入条里选中的文件收进待发队列并重画评论区（⛔ 此时不发任何请求）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `card` / `proj`
 * @param {File} file - 用户刚选中的文件
 * @returns {boolean} 是否收下了（类型 / 大小被客户端先挡掉时为 false）
 */
function repaintStaged(root, st, scope, file) {
  const bad = checkFile(file);
  if (bad) {
    toast(bad, true);
    return false;
  }
  st.pend[scope].push(file);
  repaintCommentBody(root, st, scope);
  return true;
}

/**
 * 功能：⭐ 2g 从待发队列里移除一个 chip（输入条上方那颗 `×`）并只重画评论区。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `card` / `proj`
 * @param {number|string} idx - 待发队列里的下标
 * @returns {void}
 */
function removeStaged(root, st, scope, idx) {
  const i = Number(idx);
  const arr = st.pend[scope];
  if (Number.isInteger(i) && i >= 0 && i < arr.length) arr.splice(i, 1);
  repaintCommentBody(root, st, scope);
}

/**
 * 功能：点卡片 ⇒ 开弹层，并把「该任务的评论 / 活动」两块一起读进来。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} tid - 任务 id
 * @returns {void}
 */
function openCard(root, st, tid) {
  closeAll(st);
  st.cardFor = Number(tid);
  st.cardComments = null;
  st.cardCommentsErr = '';
  st.cardActivity = null;
  st.cardActivityErr = '';
  // ⭐ 2g：换一条任务 ⇒ 丢掉上一轮的待发文件（它们挂在别处，⛔ 别带过来）
  st.pend.card = [];
  paint(root, st);
  loadCardComments(root, st);
  loadCardActivity(root, st);
}

/**
 * 功能：开**项目级评论**弹层（同一套评论 UI，`task_id` 缺省 ⇒ 只回项目级）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function openProjComments(root, st) {
  closeAll(st);
  st.projCommentsOpen = true;
  st.projComments = null;
  st.projCommentsErr = '';
  // ⭐ 2g：重开项目评论弹层 ⇒ 丢掉上一轮的待发文件
  st.pend.proj = [];
  paint(root, st);
  loadProjComments(root, st);
}

/**
 * 功能：开**整个项目活动**弹层（该项目全部任务的流水）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function openProjActivity(root, st) {
  closeAll(st);
  st.projActivityOpen = true;
  st.projActivity = null;
  st.projActivityErr = '';
  paint(root, st);
  loadProjActivity(root, st);
}

// ================================================================ 画界面

/**
 * 功能：一个分组的选项串（用于状态编辑器里「改所属组」的下拉）。
 * @param {string} cur - 当前组键
 * @returns {string} `<option>` 串
 */
function groupOptions(cur) {
  return GROUP_KEYS.map(
    (k) => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + GROUP_LABEL[k] + '</option>',
  ).join('');
}

/**
 * 功能：一次状态集拼成下拉选项 —— `role !== 'owner'` 时**完成组不可选**（前端可见性，服务端才是判据）。
 * @param {Array.<Object>} states - 状态集
 * @param {string} cur - 当前选中的状态键
 * @param {boolean} owner - 是不是项目所有者
 * @returns {string} `<option>` 串
 */
function stateOptions(states, cur, owner) {
  const list = Array.isArray(states) ? states : [];
  return list
    .map((s) => {
      const key = String(s.key == null ? '' : s.key);
      const disabled = !owner && String(s.group == null ? '' : s.group) === 'completed';
      return (
        '<option value="' +
        esc(key) +
        '" data-group="' +
        esc(String(s.group == null ? '' : s.group)) +
        '"' +
        (key === cur ? ' selected' : '') +
        (disabled ? ' disabled' : '') +
        '>' +
        esc(s.name || key) +
        '</option>'
      );
    })
    .join('');
}

/**
 * 功能：成员拼成「负责人」下拉 —— 第一项是 `未认领`（空值）。
 * @param {Array.<Object>} members - 成员表
 * @param {string} cur - 当前选中的账号 id（空串 = 未认领）
 * @returns {string} `<option>` 串
 */
function assigneeOptions(members, cur) {
  const list = Array.isArray(members) ? members : [];
  const opts = ['<option value=""' + (cur === '' ? ' selected' : '') + '>未认领</option>'];
  for (const m of list) {
    const id = String(Number(m.user_id));
    opts.push(
      '<option value="' +
        esc(id) +
        '"' +
        (id === cur ? ' selected' : '') +
        '>' +
        esc(m.display_name || m.username || '') +
        '</option>',
    );
  }
  return opts.join('');
}

/**
 * 功能：一条附件 —— `📎 文件名 · 大小`（可再带上传者）＋ 一颗【下载】＋（有权时）一颗【删除】。
 *
 * 说明：⭐ 【下载】是一颗**按钮**（不是 `<a href download>`）—— 点它走 `downloadFile()`：
 *      **真点一次临时 `<a>`**，让服务端那条路的 `Content-Disposition: attachment` 生效
 *      （⛔ 本片段**绝不**内联渲染 PDF / HTML / SVG）。
 *      ⚠️ 为什么不用 `<a href download>`：本应用被飞牛桌面**跨源 iframe** 嵌着，`download`
 *      属性会被忽略 / 被 iframe 沙箱拦下 ⇒ **点了没有任何反应，也不报错**（
 *      「手机端附件下载不了」）。改成「真点一次 `<a>`」与电脑端同一套做法。
 *      ⭐ 【删除】只给**上传者自己 ＋ 项目所有者**（方案 §戊-8-1）。
 *      ⭐ 2g：评论行下面的附件**不带上传者**（⭐ 逐字照契约 §1 那行 `📎 文件名 · 大小`）——
 *      作者就摆在上一行，重复一遍反而挤；流水那条（活动块）**照旧**带上传者（活动不动）。
 *
 * @param {Object} f - 附件项
 * @param {Object} cfg - 取值包（`meId` / `owner` / `members`）
 * @param {boolean} [withUploader] - 是否再画一段上传者（流水传 true，评论行的附件不传）
 * @returns {string} 附件行 HTML
 */
function fileRowHtml(f, cfg, withUploader) {
  const name = String(f && f.name != null ? f.name : '') || '未命名文件';
  const canDel = !!cfg.owner || sameUser(cfg.meId, f && f.uploader_id);
  const del = canDel
    ? '<button class="collab-file-x" type="button" data-act="collab-file-del" data-fid="' +
      esc(String(f && f.id)) +
      '">删除</button>'
    : '';
  const who = withUploader ? ' · ' + esc(uploaderName(f, cfg)) : '';
  return (
    '<div class="collab-file">' +
    '<span class="collab-file-name">📎 ' +
    esc(name) +
    '</span>' +
    '<span class="collab-file-meta">· ' +
    esc(fmtSize(f && f.size)) +
    who +
    '</span>' +
    '<button class="collab-file-dl" type="button" data-act="collab-file-dl" data-fid="' +
    esc(String(f && f.id)) +
    '">下载</button>' +
    del +
    '</div>'
  );
}

/**
 * 功能：一个「＋ 附件」上传入口（`<label>` 包一个**隐藏的** `<input type="file">`）——
 *      ⚠️ 手机端一律用文件选择框，⛔ 不用拖拽；作用域随 `data-tid` / `data-rid` 走。
 * @param {Object} cfg - 取值包（`up` / `upTid` / `upRid`）
 * @returns {string} 上传入口 HTML
 */
function fileAddHtml(cfg) {
  const tid = cfg.upTid ? ' data-tid="' + esc(String(cfg.upTid)) + '"' : '';
  const rid = cfg.upRid ? ' data-rid="' + esc(String(cfg.upRid)) + '"' : '';
  return (
    '<label class="collab-btn collab-file-add">＋ 附件<input class="collab-file-input" type="file" data-up="' +
    esc(cfg.up) +
    '"' +
    tid +
    rid +
    ' accept="' +
    FILE_ACCEPT +
    '"></label>'
  );
}

/**
 * 功能：附件那一块的正文（列表 ＋ 上传入口；三种态：读取中 / 出错 / 有内容）——
 *      空态用 `还没有附件`（⭐ 两端逐字一致）。
 * @param {Array.<Object>} files - 命中的附件项（`null` ＝ 还没读到）
 * @param {string} err - 读取错误（空串 ＝ 没出错）
 * @param {Object} cfg - 取值包
 * @returns {string} 附件块正文 HTML
 */
function filesInnerHtml(files, err, cfg) {
  if (err) return '<div class="collab-hint err">' + esc(err) + '</div>';
  const list = Array.isArray(files) ? files : [];
  const rows = list.length
    ? list.map((f) => fileRowHtml(f, cfg, true)).join('')
    : '<div class="collab-hint">还没有附件</div>';
  return '<div class="collab-files">' + rows + '</div>' + fileAddHtml(cfg);
}

/**
 * 功能：卡片弹层里那套评论 UI 的取值（作用域 / 输入框 / 动作名 / ⭐ 2g 的待发文件与「其他附件」）。
 * @param {Object} st - 状态
 * @returns {Object} 取值包
 */
function cardCfg(st) {
  return Object.assign(fileCfg(st, st.board, 'comment', st.cardFor, null), {
    scope: 'card',
    meId: st.me && st.me.id,
    input: 'card-comment-input',
    send: 'collab-card-comment-send',
    del: 'collab-card-comment-del',
    chipDel: 'collab-card-comment-chip-del',
    files: st.files,
    legacy: otherFilesOf(st, 'card'),
    filesErr: st.filesErr,
    pend: st.pend.card,
  });
}

/**
 * 功能：项目级评论弹层里那套评论 UI 的取值（同一套 UI，只是动作名换一拨；⭐ 附件为**项目级**）。
 * @param {Object} st - 状态
 * @returns {Object} 取值包
 */
function projCfg(st) {
  return Object.assign(fileCfg(st, st.board, 'comment', null, null), {
    scope: 'proj',
    meId: st.me && st.me.id,
    input: 'proj-comment-input',
    send: 'collab-proj-comment-send',
    del: 'collab-proj-comment-del',
    chipDel: 'collab-proj-comment-chip-del',
    files: st.files,
    legacy: otherFilesOf(st, 'proj'),
    filesErr: st.filesErr,
    pend: st.pend.proj,
  });
}

/**
 * 功能：一条评论（⭐ 2g「短视频评论区」样式）—— 头一行 `头像 · 名字 · 时间 MM-DD HH:mm`
 *      （自己发的多一颗右上角「删除」），正文单起一行，⭐ 紧贴正文下面画**这条评论自己的附件**。
 * @param {Object} c - 评论项
 * @param {Object} cfg - 取值包（`meId` ＋ `del` 动作名 ＋ `files` 全部附件）
 * @returns {string} 评论项 HTML
 */
function commentItemHtml(c, cfg) {
  const name = String((c && (c.display_name || c.username)) || '');
  const who = esc(name);
  const when = esc(fmtWhen(c && c.created_at));
  const text = esc(c && c.body != null ? String(c.body) : '');
  const mine = sameUser(cfg.meId, c && c.user_id);
  const del = mine
    ? '<button class="collab-cmt-x" type="button" data-act="' +
      cfg.del +
      '" data-cid="' +
      esc(String(c && c.id)) +
      '">删除</button>'
    : '';
  const rows = filesOfComment(cfg.files, c && c.id)
    .map((f) => fileRowHtml(f, cfg))
    .join('');
  return (
    '<div class="collab-cmt">' +
    '<div class="collab-cmt-head">' +
    '<span class="collab-cmt-avatar">' +
    esc(initialOf(name)) +
    '</span>' +
    '<span class="collab-cmt-who">' +
    who +
    '</span>' +
    '<span class="collab-cmt-when">' +
    when +
    '</span>' +
    del +
    '</div>' +
    '<div class="collab-cmt-body">' +
    text +
    '</div>' +
    (rows ? '<div class="collab-cmt-files">' + rows + '</div>' : '') +
    '</div>'
  );
}

/**
 * 功能：⭐ 2g 底部输入条（短视频评论区那种）—— 左边 `＋`（选文件）＋ 中间单行圆角输入 ＋ 右边 `发送`。
 * 说明：⚠️ 输入框**不写 placeholder**（本仓红线）；`＋` 那颗 `<label>` 包里是**隐藏的文件框**，
 *      选中的文件先攒着（显示成输入条上方的 chips），点 `发送` 才真正上传。
 * @param {Object} cfg - 取值包（`input` / `send` / `scope`）
 * @returns {string} 输入条 HTML
 */
function commentFormHtml(cfg) {
  return (
    '<div class="collab-cmt-bar">' +
    '<label class="collab-cmt-plus">＋<input class="collab-cmt-pick" type="file" data-staged="' +
    esc(cfg.scope) +
    '" accept="' +
    FILE_ACCEPT +
    '"></label>' +
    '<input class="collab-cmt-in" type="text" data-role="' +
    cfg.input +
    '" maxlength="2000">' +
    '<button class="collab-btn primary collab-cmt-send" type="button" data-act="' +
    cfg.send +
    '">发送</button>' +
    '</div>'
  );
}

/**
 * 功能：⭐ 2g 待发文件的那排 chips（在输入条**上方**）—— 每个一条文件名 ＋ 一颗 `×`（可移除）。
 * 说明：⚠️ chips 只是**界面上的待发队列**，⛔ 发送前一个请求都不发。
 * @param {Object} cfg - 取值包（`pend` / `chipDel` 动作名）
 * @returns {string} chips HTML（没有待发文件时为空串）
 */
function chipsHtml(cfg) {
  const list = Array.isArray(cfg.pend) ? cfg.pend : [];
  if (!list.length) return '';
  const rows = list
    .map((f, i) => {
      const name = String(f && f.name != null ? f.name : '') || '未命名文件';
      return (
        '<span class="collab-chip">' +
        '<span class="collab-chip-name">' +
        esc(name) +
        '</span>' +
        '<button class="collab-chip-x" type="button" data-act="' +
        cfg.chipDel +
        '" data-idx="' +
        i +
        '">×</button>' +
        '</span>'
      );
    })
    .join('');
  return '<div class="collab-chips">' + rows + '</div>';
}

/**
 * 功能：评论列表最下面那块 `其他附件` —— **老的、没有 `comment_id`** 的任务 / 项目级附件（⭐ 不丢）。
 * 说明：⚠️ 没有这类附件时整块不画（⛔ 不摆一个空壳）。
 * @param {Object} cfg - 取值包（`legacy`）
 * @returns {string} 那一块 HTML（空则为空串）
 */
function otherFilesHtml(cfg) {
  const list = Array.isArray(cfg.legacy) ? cfg.legacy : [];
  if (!list.length) return '';
  return (
    '<div class="collab-sec collab-other">' +
    '<div class="collab-sub">其他附件</div>' +
    list.map((f) => fileRowHtml(f, cfg)).join('') +
    '</div>'
  );
}

/**
 * 功能：评论区那一块的正文（评论列表 ＋ `其他附件` ＋ 底部输入条；三种态：读取中 / 出错 / 有内容）。
 * @param {Array.<Object>} list - 评论项（`null` ＝ 还在读）
 * @param {string} err - 读取错误（空串 ＝ 没出错）
 * @param {Object} cfg - 取值包
 * @returns {string} 评论区正文 HTML
 */
function commentsInnerHtml(list, err, cfg) {
  if (err) return '<div class="collab-hint err">' + esc(err) + '</div>';
  if (list === null) return '<div class="collab-hint">正在读取评论…</div>';
  const items = list.length
    ? list.map((c) => commentItemHtml(c, cfg)).join('')
    : '<div class="collab-hint">还没有评论</div>';
  return '<div class="collab-cmts">' + items + '</div>' + otherFilesHtml(cfg) + chipsHtml(cfg) + commentFormHtml(cfg);
}

/**
 * 功能：评论区那一块的外壳（标题 ＋ 可单独重画的正文容器）。
 * @param {Array.<Object>} list - 评论项
 * @param {string} err - 读取错误
 * @param {Object} cfg - 取值包
 * @param {string} bodyRole - 正文容器的 `data-role`
 * @returns {string} 评论区 HTML
 */
function commentsSectionHtml(list, err, cfg, bodyRole) {
  return (
    '<div class="collab-sec">' +
    '<div class="collab-sub">评论</div>' +
    '<div class="collab-sec-body" data-role="' +
    bodyRole +
    '">' +
    commentsInnerHtml(list, err, cfg) +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：一条活动流水 —— `谁 · 何时` ＋ `从→到` ＋（有留言时）留言 ＋ ⭐ 2f 它自己的附件（按 `report_id`）。
 * @param {Object} a - 流水项
 * @param {Object} b - 看板数据（流水里的状态键要翻成显示名）
 * @param {boolean} showTask - 是否显示「哪条任务」（项目级要）
 * @param {Object} st - 状态（⭐ 2f：读 `files` 归位这条流水的附件）
 * @returns {string} 流水项 HTML
 */
function activityItemHtml(a, b, showTask, st) {
  const who = esc((a && (a.display_name || a.username)) || '');
  const when = esc(String((a && a.created_at) || ''));
  const from = esc(stateName(b, a && a.from_status));
  const to = esc(stateName(b, a && a.to_status));
  const note = a && a.note != null && String(a.note) !== '' ? String(a.note) : '';
  const task = showTask && a && a.task_title ? String(a.task_title) : '';
  const cfg = Object.assign(fileCfg(st, b, 'flow', a && a.task_id, a && a.id), {
    files: filesOfFlow(st, a && a.id),
    filesErr: st.filesErr,
  });
  return (
    '<div class="collab-act">' +
    (task ? '<div class="collab-act-task">' + esc(task) + '</div>' : '') +
    '<div class="collab-act-head">' +
    '<span class="collab-act-who">' +
    who +
    '</span>' +
    '<span class="collab-act-when">' +
    when +
    '</span>' +
    '</div>' +
    '<div class="collab-act-move">' +
    from +
    ' → ' +
    to +
    '</div>' +
    (note ? '<div class="collab-act-note">' + esc(note) + '</div>' : '') +
    '<div class="collab-act-files">' +
    filesInnerHtml(cfg.files, cfg.filesErr, cfg) +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：活动块那一块的正文（三种态：读取中 / 出错 / 有内容）。
 * @param {Array.<Object>} list - 流水项（`null` ＝ 还在读）
 * @param {string} err - 读取错误（空串 ＝ 没出错）
 * @param {Object} b - 看板数据
 * @param {boolean} showTask - 是否显示「哪条任务」
 * @param {Object} st - 状态（⭐ 2f：每条流水挂自己的附件）
 * @returns {string} 活动块正文 HTML
 */
function activityInnerHtml(list, err, b, showTask, st) {
  if (err) return '<div class="collab-hint err">' + esc(err) + '</div>';
  if (list === null) return '<div class="collab-hint">正在读取活动…</div>';
  if (!list.length) return '<div class="collab-hint">还没有活动</div>';
  return '<div class="collab-acts">' + list.map((a) => activityItemHtml(a, b, showTask, st)).join('') + '</div>';
}

/**
 * 功能：活动块那一块的外壳（标题 ＋ 可单独重画的正文容器）。
 * @param {Array.<Object>} list - 流水项
 * @param {string} err - 读取错误
 * @param {Object} b - 看板数据
 * @param {boolean} showTask - 是否显示「哪条任务」
 * @param {string} bodyRole - 正文容器的 `data-role`
 * @param {Object} st - 状态（⭐ 2f：每条流水挂自己的附件）
 * @returns {string} 活动块 HTML
 */
function activitySectionHtml(list, err, b, showTask, bodyRole, st) {
  return (
    '<div class="collab-sec">' +
    '<div class="collab-sub">活动</div>' +
    '<div class="collab-sec-body" data-role="' +
    bodyRole +
    '">' +
    activityInnerHtml(list, err, b, showTask, st) +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：甘特图顶部那一排**状态图例**（五组 ＋ `全部`）—— 点某颗只显示**当前在该组**的任务。
 * 说明：⭐ 契约 §0：⛔ 不按状态分四张甘特图（那样看不出任务在状态之间怎么流动，且状态数是项目自配的、
 *      拆图会随状态数变）—— 一张时间轴 ＋ 这一排图例来做「按状态看」。
 * @param {string} cur - 当前选中的筛选项（组键或 `GANTT_ALL`）
 * @returns {string} 图例 HTML
 */
function ganttLegendHtml(cur) {
  // ⭐⭐ 0.8.53（待排期单列）：图例**不再有「待排期」** —— 它已经不在时间轴上了，
  //    留着那颗只会让人点了之后看到一张空图。
  const items = [{ key: GANTT_ALL, label: '全部' }].concat(
    GROUP_KEYS.filter((k) => k !== 'backlog').map((k) => ({ key: k, label: GROUP_LABEL[k] })),
  );
  const chips = items
    .map((it) => {
      const on = it.key === cur;
      const dot = it.key === GANTT_ALL ? '' : '<span class="collab-gt-leg-dot g-' + it.key + '"></span>';
      return (
        '<button class="collab-gt-leg' +
        (on ? ' on' : '') +
        '" type="button" data-act="collab-gt-filter" data-grp="' +
        esc(it.key) +
        '">' +
        dot +
        esc(it.label) +
        '</button>'
      );
    })
    .join('');
  return '<div class="collab-gt-legend">' + chips + '</div>';
}

/**
 * 功能：时间轴顶上一行 —— `«` 上一周 ＋ 周区间 ＋ `»` 下一周 ＋ 一颗 `今天`（回到本周）。
 *
 * 说明：⭐⭐ 0.8.53（纠正）：仍然是**一周一页地切换**（不是长轴平移）；
 *      变的是这一周里每列更宽（`GANTT_COL_W`），周内靠横滑看完整。
 *      那颗 `今天` 把窗口拨回本周，并让横向滚动重新把今天摆到中间（`paint()` 里那一段）。
 * @param {string} start - 窗口第一天（`YYYY-MM-DD`）
 * @returns {string} 那一行 HTML
 */
function weekBarHtml(start) {
  return (
    '<div class="collab-gt-weekbar">' +
    '<button class="collab-gt-nav" type="button" data-act="collab-gt-prev" aria-label="上一周">«</button>' +
    '<span class="collab-gt-range">' +
    esc(fmtShort(start)) +
    ' ~ ' +
    esc(fmtShort(addDays(start, GANTT_DAYS - 1))) +
    '</span>' +
    '<button class="collab-gt-nav" type="button" data-act="collab-gt-next" aria-label="下一周">»</button>' +
    '<button class="collab-gt-jump" type="button" data-act="collab-gt-today">今天</button>' +
    '</div>'
  );
}

/**
 * 功能：时间轴的列头 —— **一天一列**（`星期几` ＋ `M/D`）；⚠️ 周日那一列用强调色（照任务模块的惯例）。
 * 说明：⭐ 与每条任务的横槽（`.collab-gt-track`）用**同一套网格口径**（同样列宽、同样左右留白）
 *      ⇒ 列头与横条严格对齐。列宽与列数由本函数按 `GANTT_COL_W` / `days.length` 内联给出
 *      （⛔ 别在 CSS 里写 `repeat(7, 1fr)`：一周 7 列按屏宽等分就又回到「挤在一屏」了）。
 * @param {Array.<string>} days - 窗口里的每一天
 * @param {string} today - 今天（`YYYY-MM-DD`）
 * @returns {string} 列头 HTML
 */
function weekHeadHtml(days, today) {
  const cells = days
    .map((d) => {
      const cls = 'collab-gt-col' + (dow(d) === 0 ? ' sun' : '') + (d === today ? ' today' : '');
      return (
        '<div class="' +
        cls +
        '">' +
        '<span class="collab-gt-dow">' +
        esc(weekdayChar(d)) +
        '</span>' +
        '<span class="collab-gt-date">' +
        esc(fmtShort(d)) +
        '</span>' +
        '</div>'
      );
    })
    .join('');
  return (
    '<div class="collab-gt-weekhead" style="grid-template-columns:repeat(' +
    days.length +
    ', ' +
    GANTT_COL_W +
    'px)">' +
    cells +
    '</div>'
  );
}

/**
 * 功能：一条任务条上的悬浮说明（`title`）—— 任务名 ＋ 负责人 / 截止日 / 💬n 📎n。
 * 说明：⚠️ 手机端**没有悬停**，所以这几个字段在卡片弹层里也画一份（见 `cardMetaHtml`）——
 *      这里只是让电脑 / 触屏长按 / 无障碍读屏也拿得到。这是「一条信息都不丢」的另一半。
 * @param {Object} t - 任务行
 * @param {Object} b - 看板数据（读 `members` 翻负责人名）
 * @returns {string} 悬浮说明
 */
function barTip(t, b) {
  const name = (t && t.title) || '未命名任务';
  let meta = assigneeText(b, t);
  const due = dueText(t);
  if (due) meta += ' · 截止 ' + due;
  meta += ' · 💬 ' + numOf(t && t.comment_count) + ' · 📎 ' + numOf(t && t.file_count);
  return name + '（' + meta + '）';
}

/**
 * 功能：⭐ 所有任务**共用一条时间轴**的画法（照任务板那套）—— 一天一列（列头由 `weekHeadHtml`
 *      画，两边网格口径一致 ⇒ 对得齐），每条任务是这一格网里的一根**彩色药丸**（任务名写在条里），
 *      **重叠的条各占一道**（`grid-row: lane + 1`，道由 `ganttModel()` 分好），今天是一条贯穿
 *      全道的竖参考线。
 *
 * 说明：⭐⭐ 0.8.53（「任务配色与电脑端不一样」）：条色与电脑端 `barHtml()`
 *      **同一套口径** —— 按**画出来的先后**轮流取共用层 `COLORS`（`--tlc`，相邻必然不同），
 *      **不再按组着色**（顶部图例从此只管筛选，不兼任条色说明书，照电脑端 0.8.17）；
 *      已完成 `.done` / 已取消 `.cancelled` 的状态档与逾期 `.due`（红边红字）样式都在 CSS 里。
 *      · 轨道宽度 = `GANTT_DAYS × GANTT_COL_W`（7 × 88 = 616px）⇒ 比窄屏宽，
 *        由外层 `.collab-gt-scroll` 横向滚动看本周剩下的日子；
 *      · **已完成**的条前面加 `✓`、已取消的加删除线（「没有完成区分」）。
 *      ⚠️ 条都带 `data-act="collab-card"`：点条就开卡片弹层（改状态 / 改负责人 /
 *      评论 / 活动 / 附件，里面的功能一个字不动）。
 *      ⭐ 2026-10-20：条下沿那排**时间节点小点已移除**（行高仍按 `GANTT_ROW_H` 给，
 *      条在行内居中）—— 每一条状态变更的来龙去脉仍在卡片弹层的「活动」栏里。
 * @param {Object} m - `ganttModel()` 的产物（读 `start` / `today` / `days` / `rows` / `lanes`）
 * @param {Object} b - 看板数据（读 `members` 翻负责人名）
 * @returns {string} 共用时间轴 HTML
 */
function ganttTrackHtml(m, b) {
  const w0 = dayNum(m.start);
  const n = m.days.length;
  let out = '';
  // 一天的竖格线打底（周日与今天另给底色）—— 让条看得出落在哪几天
  for (let i = 0; i < n; i++) {
    const d = m.days[i];
    out +=
      '<span class="collab-gt-grid' +
      (dow(d) === 0 ? ' sun' : '') +
      (d === m.today ? ' today' : '') +
      '" style="grid-column:' +
      (i + 1) +
      ';grid-row:1 / span ' +
      m.lanes +
      '"></span>';
  }
  const tn = dayNum(m.today);
  if (Number.isFinite(tn) && tn >= w0 && tn < w0 + n) {
    out +=
      '<span class="collab-gt-today" style="grid-column:' +
      (tn - w0 + 1) +
      ';grid-row:1 / span ' +
      m.lanes +
      '"></span>';
  }
  m.rows.forEach((r, i) => {
    const t = r.t;
    const tid = esc(String(t && t.id));
    const tip = barTip(t, b);
    const done = r.g === 'completed';
    const cancelled = r.g === 'cancelled';
    out +=
      '<span class="collab-gt-bar' +
      (done ? ' done' : '') +
      (cancelled ? ' cancelled' : '') +
      (r.over ? ' due' : '') +
      '" style="grid-column:' +
      (r.cs + 1) +
      ' / ' +
      (r.ce + 2) +
      ';grid-row:' +
      (r.lane + 1) +
      ';--tlc:' +
      COLORS[i % COLORS.length] +
      '" title="' +
      esc(tip) +
      '" data-act="collab-card" data-tid="' +
      tid +
      '">' +
      (done ? '✓ ' : '') +
      esc((t && t.title) || '未命名任务') +
      '</span>';
  });
  return (
    '<div class="collab-gt-track" style="grid-template-columns:repeat(' +
    n +
    ', ' +
    GANTT_COL_W +
    'px);grid-template-rows: repeat(' +
    m.lanes +
    ', ' +
    GANTT_ROW_H +
    'px);width:' +
    n * GANTT_COL_W +
    'px">' +
    out +
    '</div>'
  );
}

/**
 * 功能：把看板画成**一周一页、周内可横滑**的时间轴（契约 §1；⭐ 0.8.12 起照任务板那套，
 *      0.8.53 起列宽放大到 64px（0.8.53 追加修到 88px）、周内横滑、进来把今天摆到中间）—— 顶部图例 ＋
 *      一行「« 周区间 » 今天」＋ 一天一列的列头 ＋ 一条共用的时间轴（彩色药丸 / 错行 / 今天竖线）。
 * @param {Object} st - 状态（读 `gtFilter` / `gtStart`）
 * @param {Object} b - 看板数据
 * @returns {string} 甘特图 HTML
 */
function ganttHtml(st, b) {
  const m = ganttModel(st, b);
  // ⭐ 2026-10-05：「我框起来的整体还是加个卡片背景」—— 图例 ＋ 翻周行 ＋ 日期轴 ＋ 任务条
  //    这一整块以前**没有共同的容器**（直接排在页头下面），所以加一层 `.collab-gantt` 当卡片。
  //    ⚠️ 类名与电脑端同名（类名是共用约定，样式两端各写一份）。
  const head =
    '<div class="collab-gantt">' + ganttLegendHtml(m.filter) + weekBarHtml(m.start);
  if (!m.rows.length) {
    // ⭐ 0.8.53（对齐电脑端）：本周外不画之后，「有任务但不在这周」必须说一句人话，
    //    ⛔ 别让画面看着像坏了 —— 文案与电脑端 `ganttHtml()` 逐字相同。
    const empty =
      m.total > 0
        ? '这一周没有任务 —— 用 « / » 翻到别的周看看'
        : m.filter === GANTT_ALL
          ? '还没有任务'
          : '这一组还没有任务';
    return head + '<div class="collab-hint">' + empty + '</div></div>';
  }
  return (
    head +
    '<div class="collab-gt-scroll" data-role="gt-scroll">' +
    '<div class="collab-gt-inner" style="width:' +
    m.days.length * GANTT_COL_W +
    'px">' +
    weekHeadHtml(m.days, m.today) +
    ganttTrackHtml(m, b) +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：成员区下面那一块 —— 没展开时是一颗「＋ 加成员」，展开后是好友下拉 + 添加 / 取消。
 * @param {Object} st - 状态
 * @returns {string} 那一块 HTML
 */
function addMemberHtml(st) {
  if (!st.addOpen) {
    return '<button class="collab-btn ghost" type="button" data-act="collab-add-open">＋ 加成员</button>';
  }
  if (st.friendErr) return '<div class="collab-hint err">' + esc(st.friendErr) + '</div>';
  if (st.friends === null) return '<div class="collab-hint">正在读取好友…</div>';
  if (!st.friends.length) return '<div class="collab-hint">还没有好友可以拉进来</div>';
  return (
    '<div class="collab-add">' +
    '<select data-role="friend">' +
    st.friends
      .map((f) => '<option value="' + esc(String(f.id)) + '">' + esc(f.display_name || f.username || '') + '</option>')
      .join('') +
    '</select>' +
    '<button class="collab-btn primary" type="button" data-act="collab-add-save">添加</button>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-add-cancel">取消</button>' +
    '</div>'
  );
}

/**
 * 功能：用量块里**一行**（`名字` ＋ 右侧 `大小`）。
 * @param {string} name - 显示名
 * @param {string} size - 已格式化的大小
 * @returns {string} 一行 HTML
 */
function usageRowHtml(name, size) {
  return (
    '<div class="collab-use-row">' +
    '<span class="collab-use-name">' +
    esc(name) +
    '</span>' +
    '<span class="collab-use-size">' +
    esc(size) +
    '</span>' +
    '</div>'
  );
}

/**
 * 功能：⭐ 成员管理弹窗最底那块**上传用量**（⭐ 2f）。
 *
 * 说明：⚠️ 取 `GET /files` 回的 `used`（账号 id → 字节）＋ 看板成员名单 —— 名单里的每一个人
 *      **都摆一行**（没传过就是 `0 B`）；名字在名单里查不到的（账号已注销）单列一行 `已注销成员`。
 *      ⭐ 契约 §2：用量放最底、一行一个成员；⚠️ **没有用量时整块不画**（回空串，外壳 `:empty` 收掉）。
 *
 * @param {Object} st - 状态（读 `files` / `filesErr` / `used`）
 * @param {Object} b - 看板数据（读 `members`）
 * @returns {string} 用量块正文 HTML（只有内容，外壳由 `membersModalHtml` 套）
 */
function usageHtml(st, b) {
  if (st.filesErr) return '<div class="collab-hint err">附件读取失败：' + esc(st.filesErr) + '</div>';
  if (st.files === null) return '<div class="collab-hint">正在读取用量…</div>';
  const used = st.used && typeof st.used === 'object' ? st.used : {};
  const list = Array.isArray(b && b.members) ? b.members : [];
  const rows = list.map((m) =>
    usageRowHtml(m.display_name || m.username || '', fmtSize(used[String(Number(m.user_id))])),
  );
  // ⚠️ 名单里没有、却还有占用字节的上传者（账号已注销）单独收一行，⛔ 不丢用量。
  let gone = 0;
  for (const k of Object.keys(used)) {
    if (!list.some((m) => String(Number(m.user_id)) === String(k))) gone += Number(used[k]) || 0;
  }
  if (gone > 0) rows.push(usageRowHtml(GONE_USER, fmtSize(gone)));
  if (!rows.length) return '';
  return '<div class="collab-sub">上传用量</div>' + rows.join('');
}

/**
 * 功能：⭐ 成员管理弹窗里的**一行成员**（契约 §2：成员一行一个）—— 名字 ＋ 右侧 `我` / `发起人`
 *      标记 ＋（我是所有者、且这一行不是发起人时）右侧一颗【移出】。
 * @param {Object} m - 成员项
 * @param {boolean} isOwner - 是不是发起人（名单第一行）
 * @param {*} meId - 我自己的账号 id
 * @param {boolean} owner - 我是不是项目所有者
 * @returns {string} 一行 HTML
 */
function memberRowHtml(m, isOwner, meId, owner) {
  const isMe = meId != null && Number(m.user_id) === Number(meId);
  const tags = [];
  if (isMe) tags.push('<i class="collab-mem-tag">我</i>');
  if (isOwner) tags.push('<i class="collab-mem-tag">发起人</i>');
  const remove =
    owner && !isOwner
      ? '<button class="collab-mem-x" type="button" data-act="collab-remove-member" data-uid="' +
        esc(String(m.user_id)) +
        '">移出</button>'
      : '';
  return (
    '<div class="collab-mem-row">' +
    '<span class="collab-mem-name">' +
    esc(m.display_name || m.username || '') +
    '</span>' +
    (tags.length ? '<span class="collab-mem-tags">' + tags.join('') + '</span>' : '') +
    remove +
    '</div>'
  );
}

/**
 * 功能：⭐ 【协作成员管理】弹窗（契约 §2）—— 分「成员」与「项目操作」两组：成员名单一行一个
 *      （`我` / `发起人` 标记 ＋ 每行 `移出`）＋ `＋ 加成员` · `移出协作` / `转让` ＋ 那句说明；
 *      用量放**最底**。
 *
 * 说明：⭐ 契约 §2.2-①：「显示**和**设置」都在这个弹窗里，原来那些控件**一个都不许丢** ——
 *      ⛔ 页头不再平铺成员块，只留一颗【协作成员管理】按钮开它。
 *      ⚠️ `＋ 加成员` / `转让` / `移出协作` 都**仅所有者**可见（服务端才是判据）；
 *      那句说明（`MEMBER_NOTE`）**两端逐字不变**，立在「项目操作」组下。
 * @param {Object} st - 状态
 * @param {Object} b - 看板数据
 * @returns {string} 弹层 HTML
 */
function membersModalHtml(st, b) {
  const owner = !!(b.project && b.project.role === 'owner');
  const meId = st.me && st.me.id;
  const list = Array.isArray(b.members) ? b.members : [];
  const rows = list.length
    ? list.map((m, i) => memberRowHtml(m, i === 0, meId, owner)).join('')
    : '<div class="collab-hint">还没有成员</div>';
  const memberSec =
    '<div class="collab-sec">' +
    '<div class="collab-sub">成员<small class="collab-mem-n">共 ' +
    list.length +
    ' 人</small></div>' +
    '<div class="collab-mem-list">' +
    rows +
    (owner ? '<div class="collab-mem-row collab-mem-addrow">' + addMemberHtml(st) + '</div>' : '') +
    '</div>' +
    '</div>';
  const opsSec =
    '<div class="collab-sec">' +
    '<div class="collab-sub">项目操作</div>' +
    (owner
      ? '<div class="collab-mem-ops">' +
        '<button class="collab-btn ghost" type="button" data-act="collab-unshare" data-pid="' +
        esc(String(b.project.id)) +
        '">移出协作</button>' +
        '<button class="collab-btn ghost" type="button" data-act="collab-transfer-open">转让</button>' +
        '</div>'
      : '') +
    '<div class="collab-hint">' +
    esc(MEMBER_NOTE) +
    '</div>' +
    '</div>';
  const usageSec = '<div class="collab-use" data-role="collab-usage">' + usageHtml(st, b) + '</div>';
  return mask('collab-members-close', '协作成员管理', memberSec + opsSec + usageSec);
}

/**
 * 功能：看板页头 ——「已完成 n / 共 m」＋ 细进度条 ＋ 一排四颗动作按钮。
 *
 * 说明：⚠️ 项目名与「‹ 返回」**不在这里** —— 它们由宿主画在第二屏那条 `teamwork-peerbar`
 *      （与本模块的插槽会话屏同一个位置感，见 `teamwork/mobile.js` 的 `renderCollabBoard()`）。
 *      ⭐ 契约 §2.2-①：成员块（名单 / 加成员 / 转让 / 移出协作）**收进**弹窗 ⇒ 这里只留一颗按钮。
 *      ⭐⭐ 0.8.54（「状态、评论、活动、协作成员，这四个按钮请显示在一排，
 *      高度请统一，可以适当缩小字体和大小（自适应窗口大小，四个始终在一排）」）：
 *      ① 成员那颗**也并进** `.collab-board-btns`（从前它是这个 div 的兄弟、单独占一行）；
 *      ② 按钮文案收成「协作成员」（原名「协作成员管理」6 字，四颗等分时最窄屏放不下，
 *         会被省略号吃掉后两个字 —— 弹层标题仍叫「协作成员管理」，意思一个字没丢）；
 *      ③ 四颗等分宽（`flex: 1 1 0`）＋ 统一高度 34px ＋ `nowrap`，字号用 `clamp()` 跟屏宽走
 *         ⇒ **任何窗口宽度都只占一排**（样式见 `mobile/app.css` 的 `.collab-board-btns`）。
 *      ⚠️ 「⚙ 状态」仍然仅所有者可见 —— 此时是三颗（同样等分、同样一排）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板数据
 * @returns {string} 页头 HTML
 */
function boardTopHtml(st, b) {
  const owner = !!(b.project && b.project.role === 'owner');
  const p = b.progress || {};
  const total = p.total == null ? 0 : Number(p.total) || 0;
  const done = p.done == null ? 0 : Number(p.done) || 0;
  return (
    '<div class="collab-board">' +
    '<div class="collab-progress">' +
    '<span class="collab-progress-t">' +
    esc(progressText(done, total)) +
    '</span>' +
    progressBarHtml(done, total) +
    '</div>' +
    '<div class="collab-board-btns">' +
    (owner ? '<button class="collab-btn ghost" type="button" data-act="collab-state-open">⚙ 状态</button>' : '') +
    '<button class="collab-btn ghost" type="button" data-act="collab-proj-comments-open">💬 评论</button>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-proj-activity-open">活动</button>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-members-open">协作成员</button>' +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：**右下角悬浮的 ＋**（新建任务）—— 与首页看板那颗 `.fab` **逐字同款**。
 *
 * 说明：⭐⭐ 2026-10-23（「变为和首页一样的悬浮图标，两端都是」）：从页头按钮排里挪出来，
 *      形态 / 位置 / 阴影照宿主那颗 `.fab`（56px 圆 / 品牌渐变 / 白 ＋ / 距右 18 /
 *      距底 `safe + --tabbar-h + 28` / z 45）。
 *      ⚠️ 类名**独立**（`.collab-fab-float`，⛔ 不复用宿主 `.fab`）：那颗由宿主 `updateChrome()`
 *      按标签切 `.off`，模块里这颗要跟着**片段**活着 —— 片段卸载时它自然一起走
 *      （照电脑端 `.btn-fab-float` 那条已知坑）。z 45 < 弹层遮罩的 60 ⇒ 弹层会盖住它。
 *      ⚠️ `.view` 的底部留白本来就含 TabBar ＋ 96px（那颗 FAB 的位置正是照它算的）⇒ ⛔ 别再补占位。
 *      文案在 `title` / `aria-label` 上（⛔ 别往按钮里补文字）。
 * @returns {string} 那颗按钮的 HTML
 */
function fabHtml() {
  return '<button class="collab-fab-float" type="button" data-act="collab-newtask-open" title="新建任务" aria-label="新建任务">＋</button>';
}

/**
 * 功能：**待排期列表**（0.8.53；⭐ 0.8.54 起摆在**甘特图下面**）—— 单独一块（待排期不在甘特图中显示，
 *      单独列表显示，没有日期，可以转为任务）。
 *
 * 说明：⭐⭐ 与电脑端 `backlogHtml()` 同一套口径：
 *      · 只有 `backlog` 组进这里（自定义状态只要落在 backlog 组，同样算待排期）；
 *      · **不显示日期** —— 待排期的语义就是「还没排期」，旧数据上残留的日期一概不露出；
 *      · 每条右侧一颗【转为任务】：选任务类型与日期时间后挪到「未开始」组（见 `promoteTask()`）。
 *      ⚠️ 一条都没有时**整块不画**（回空串）。
 *      ⚠️ 点标题开任务卡片弹层（`collab-card`，与甘特条同一个动作）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板数据
 * @returns {string} 待排期那一块 HTML（没有待排期任务时为空串）
 */
function backlogHtml(st, b) {
  const groups = b && b.groups ? b.groups : {};
  const list = (Array.isArray(groups.backlog) ? groups.backlog : []).slice().sort((a, c) => Number(c.id) - Number(a.id));
  if (!list.length) return '';
  const rows = list
    .map((t) => {
      const tid = esc(String(t && t.id));
      return (
        '<div class="collab-bl-row">' +
        '<button class="collab-bl-title" type="button" data-act="collab-card" data-tid="' +
        tid +
        '">' +
        esc((t && t.title) || '未命名任务') +
        '</button>' +
        '<span class="collab-bl-who">' +
        esc(assigneeText(b, t)) +
        '</span>' +
        '<button class="collab-btn primary collab-bl-go" type="button" data-act="collab-promote-open" data-tid="' +
        tid +
        '">转为任务</button>' +
        // ⭐ 0.8.54（「团队协作的待排期任务没有删除功能」）：待排期是「随手记」——
        //    记错了必须能撤。一颗小 ✕（触控范围在 CSS 里补到 44px），点了先问一句。
        '<button class="collab-bl-x" type="button" data-act="collab-task-del" data-tid="' +
        tid +
        '" title="删除这条待排期" aria-label="删除">✕</button>' +
        '</div>'
      );
    })
    .join('');
  return (
    '<div class="collab-backlog">' +
    '<div class="collab-bl-head">' +
    '<span class="collab-bl-label">' +
    esc(GROUP_LABEL.backlog) +
    '</span>' +
    '<b class="collab-bl-n">' +
    list.length +
    '</b>' +
    '</div>' +
    '<div class="collab-bl-list">' +
    rows +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：删一条**待排期**任务（⭐ 0.8.54：「团队协作的待排期任务没有删除功能」）。
 *
 * 说明：⭐⭐ 删除**不可撤销**，而且服务端会连带上报 / 评论 / 附件 / 打卡记录一起清 ⇒ 必须问一句。
 *      ⚠️ 确认文案里带任务标题 —— 它是**用户自己写的内容**，只走 `askConfirm()` 的纯文本参数
 *      （那个函数内部 `esc()`），⛔ 不要自己拼进 HTML。
 *      ⚠️ 判权（所有者 ＋ 创建者）在服务端；这里只把它的原话（404）弹出来。
 * @param {HTMLElement} root - 本片段根节点
 * @param {Object} st - 状态
 * @param {number|string} tid - 任务 id
 * @returns {Promise.<void>}
 */
async function deleteBacklogTask(root, st, tid) {
  const id = Number(tid);
  const list = st.board && st.board.groups && Array.isArray(st.board.groups.backlog) ? st.board.groups.backlog : [];
  const t = list.find((x) => Number(x.id) === id);
  if (!id) return;
  const ok = await askConfirm({
    title: '删除待排期',
    text: `确定删除「${(t && t.title) || '未命名任务'}」吗？它的评论与附件会一起删掉，不能撤销。`,
    ok: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/collab/projects/${Number(st.pid)}/tasks/${id}`);
    toast('已删除');
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  }
}

/**
 * 功能：【转为任务】弹层 —— 给一条待排期任务选任务类型与日期时间（手机端）。
 *
 * 说明：⭐ 字段与电脑端 `promoteModalHtml()` 逐项一致：任务日 / 截止日 ＋ 任务类型块
 *      （普通 / 窗口 / 周期；窗口要两个时刻，周期要循环规则，可选每期时间窗）。
 *      ⚠️ 日期**必填**（转成任务 = 上甘特图，没有日期的条画不出来）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML（找不到那条任务就回空串）
 */
function promoteModalHtml(st) {
  const t = findCard(st.board, st.promoteFor);
  if (!t) return '';
  const today = todayStr();
  const start = date10(t.start_date) || today;
  const due = date10(t.due_date) || start;
  const body =
    '<div class="collab-promote-t">' +
    esc(t.title || '未命名任务') +
    '</div>' +
    '<div class="collab-field-row" data-role="pm-dates">' +
    field('任务日', '<input class="collab-input" type="date" data-role="pm-start" value="' + esc(start) + '">') +
    field('截止日', '<input class="collab-input" type="date" data-role="pm-due" value="' + esc(due) + '">') +
    '</div>' +
    kindBlockHtml('pm', t) +
    btns(
      '<button class="collab-btn primary" type="button" data-act="collab-promote-save">转为任务</button>' +
        '<button class="collab-btn ghost" type="button" data-act="collab-promote-close">取消</button>',
    );
  return mask('collab-promote-close', '转为任务', body);
}

/**
 * 功能：本片段的看板正文（读失败 / 还没读完 / 有内容）。
 *
 * 说明：⭐⭐ 0.8.53（待排期单列）：正文 = 页头 ＋ 甘特图 ＋ **待排期列表**。
 *      待排期不在时间轴上（`ganttModel()` 里剔掉了），它在甘特图下面单独一块里（0.8.54）。
 *      ⭐⭐ 0.8.54（「待排期应该显示在任务下面」）：这块从**甘特图上面**
 *      挪到**甘特图下面** —— 主视图（任务）在上，待排期（还没排期的）在下，与「先看排期、
 *      再看没排的」的读法一致。⚠️ 只改拼接顺序，`backlogHtml()` 本身一个字没动。
 * @param {Object} st - 状态
 * @returns {string} 正文 HTML
 */
function boardBody(st) {
  if (st.boardErr) {
    return (
      '<div class="collab-hint err">' +
      esc(st.boardErr) +
      ' <button class="collab-btn ghost" type="button" data-act="collab-board-reload">重试</button></div>'
    );
  }
  const b = st.board;
  if (!b) return '<div class="collab-hint">正在读取看板…</div>';
  // ⭐ 0.8.54：待排期在**甘特图下面**（「待排期应该显示在任务下面」）。
  return boardTopHtml(st, b) + ganttHtml(st, b) + backlogHtml(st, b) + fabHtml();
}

/**
 * 功能：从看板里按 id 找一条任务（跨五组与 `unknown`）。
 * @param {Object} b - 看板数据
 * @param {number|string} tid - 任务 id
 * @returns {?Object} 命中的任务行，找不到为 null
 */
function findCard(b, tid) {
  const id = Number(tid);
  const groups = b && b.groups ? b.groups : {};
  const all = GROUP_KEYS.flatMap((k) => (Array.isArray(groups[k]) ? groups[k] : [])).concat(
    Array.isArray(b && b.unknown) ? b.unknown : [],
  );
  return all.find((t) => Number(t.id) === id) || null;
}

/**
 * 功能：取某一组里**用来当默认落点**的状态键（0.8.53）。
 *
 * 说明：⭐ 「待排期 → 转为任务」要把状态从 backlog 组挪出去，落点取该组里 `is_default` 的那一条
 *      （没有就取第一条）—— 状态集是**每个项目自配**的，⛔ 不写死 `'todo'`。
 * @param {Object} b - 看板数据
 * @param {string} g - 组键
 * @param {string} [fallback] - 该组一个状态都没有时的兜底键
 * @returns {string} 状态键（可能为空串 = 无可用状态）
 */
function stateKeyOfGroup(b, g, fallback) {
  const list = Array.isArray(b && b.states) ? b.states : [];
  const hit = list.find((s) => String(s.group) === g && Number(s.is_default) === 1) || list.find((s) => String(s.group) === g);
  return hit && hit.key != null ? String(hit.key) : fallback || '';
}

/**
 * 功能：一个弹层的**描述**（标题 ＋ 正文 ＋ 关闭动作），交给宿主底部弹层去画。
 *
 * 说明：⭐⭐ 0.8.54（20:37 截图「弹窗弹不出来，统一改为走宿主的 opensheet」）：
 *      **这里从前返回的是一整块自绘遮罩的 HTML**（`.collab-mask` + `.collab-modal`）。自绘那套
 *      在真机上出过两次事：一次是居中卡片与任务详情两种形态不一致，一次是改抽屉后整块塌成一条白条
 *      （截图）。⇒ 现在**不再自绘**：本函数只回一个对象，`syncSheet()` 拿它去调宿主
 *      `openSheet()` —— 弹层的外观、滑入、把手、✕、返回键、点遮罩关全由宿主一处负责，
 *      与任务详情/收藏夹/硬件那几十个弹层**同一个东西**。
 *      ⚠️ 正文里那排「确定 / 取消」按钮不变（`data-act` 仍是 `collab-*`，由本片段的
 *      文档级委托处理 —— `#sheet` 在片段根节点之外，root 上的委托收不到它）。
 * @param {string} closeAct - 关闭动作名（正文里的「取消」也用它）
 * @param {string} title - 弹层标题
 * @param {string} body - 正文 HTML
 * @returns {{closeAct: string, title: string, body: string}} 弹层描述
 */
function mask(closeAct, title, body) {
  return { closeAct, title, body };
}

/**
 * 功能：一个表单字段（标签 + 控件）。
 * @param {string} label - 字段名（会自动转义）
 * @param {string} control - 控件 HTML
 * @returns {string} 字段 HTML
 */
function field(label, control) {
  return '<label class="collab-field"><span class="collab-field-lab">' + esc(label) + '</span>' + control + '</label>';
}

/**
 * 功能：弹层底部一排按钮。
 * @param {string} inner - 按钮 HTML
 * @returns {string} 按钮排 HTML
 */
function btns(inner) {
  return '<div class="collab-modal-btns">' + inner + '</div>';
}

/**
 * 功能：卡片弹层顶上那一行**角标** —— 💬n / 📎n。
 *
 * 说明：⭐ 0.8.12：甘特图的条改成「名字写在条里」之后，条上不再有负责人 / 截止日 —— 手机端又没有悬停，
 *      所以当时在这里显式画了一份只读摘要，保证**一条信息都不丢**（的要求）。
 *      ⭐ 2026-10-20（「任务详情也要可以编辑任务」）：负责人与截止日**变成了下面那两格可编辑控件**
 *      ⇒ 这里不再重复画一遍摘要（同一个值在同一个弹层里出现两次，看着像两组数据），只留两枚角标。
 *      ⚠️ 两枚角标带 `data-role` / `data-tid`：发 / 删评论、增删附件后，
 *      `syncCardCommentCount()` / `syncCardFileCount()` 就地改它们（⛔ 不整屏重画）。
 * @param {Object} t - 任务行
 * @returns {string} 一行 HTML
 */
function cardMetaHtml(t) {
  const tid = esc(String(t && t.id));
  return (
    '<div class="collab-card-meta">' +
    '<span class="collab-badge" data-role="badge-cmt" data-tid="' +
    tid +
    '">💬 ' +
    numOf(t && t.comment_count) +
    '</span>' +
    '<span class="collab-badge" data-role="badge-file" data-tid="' +
    tid +
    '">📎 ' +
    numOf(t && t.file_count) +
    '</span>' +
    '</div>'
  );
}

/**
 * 功能：卡片弹层 —— 编辑一条任务（标题 / 描述 / 任务日 / 截止日 / 状态 / 负责人），
 *      下面接**评论 → 活动 → 附件**。
 *
 * 说明：⭐ 2026-10-20（「团队协作的任务详情，也要可以编辑任务」）：从前这里只有「状态 / 负责人」
 *      两颗下拉。现在补成与电脑端、与任务板**同一组字段**；「确定」只发改动过的那几格
 *      （⛔ 不整行覆盖：四象限 / 标签 / 任务类型 / 绑定网址这些协作侧看不见的列，一个字节都不许动）。
 *      ⚠️ 「任务日」就是任务板那个 `start_date`（甘特条起点走 `start_date || created_at`）——
 *      协作任务从前只能靠创建日兜底，补上这一格条才落得准。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function cardModalHtml(st) {
  const b = st.board;
  const t = findCard(b, st.cardFor);
  if (!t) return '';
  const owner = !!(b.project && b.project.role === 'owner');
  const members = Array.isArray(b.members) ? b.members : [];
  const curStatus = String(t.status == null ? '' : t.status);
  const rawAid = t.assignee_id == null || t.assignee_id === '' ? '' : String(Number(t.assignee_id));
  const initAid = rawAid && members.some((m) => String(Number(m.user_id)) === rawAid) ? rawAid : '';
  const body =
    cardMetaHtml(t) +
    field(
      '标题',
      '<input class="collab-input" type="text" data-role="card-title" maxlength="100" value="' +
        esc(t.title || '') +
        '">',
    ) +
    field(
      '描述',
      '<textarea class="collab-input" data-role="card-desc" maxlength="20000">' + esc(t.description || '') + '</textarea>',
    ) +
    '<div class="collab-field-row" data-role="card-dates">' +
    field(
      '任务日',
      '<input class="collab-input" type="date" data-role="card-start" value="' + esc(date10(t.start_date)) + '">',
    ) +
    field(
      '截止日',
      '<input class="collab-input" type="date" data-role="card-due" value="' + esc(date10(t.due_date)) + '">',
    ) +
    '</div>' +
    field(
      '状态',
      '<select data-role="card-status" data-init="' +
        esc(curStatus) +
        '">' +
        stateOptions(b.states, curStatus, owner) +
        '</select>',
    ) +
    (owner ? '' : '<div class="collab-hint">只有项目所有者能验收</div>') +
    field(
      '负责人',
      '<select data-role="card-assignee" data-init="' +
        esc(initAid) +
        '">' +
        assigneeOptions(members, initAid) +
        '</select>',
    ) +
    '<div data-role="card-kind">' +
    kindBlockHtml('cd', t) +
    '</div>' +
    btns(
      '<button class="collab-btn primary" type="button" data-act="collab-card-save" data-tid="' +
        esc(String(t.id)) +
        '">确定</button>' +
        '<button class="collab-btn ghost" type="button" data-act="collab-card-close">取消</button>',
    ) +
    // ⭐ 2d：上面是任务本身，下面接**评论 → 活动**两块
    commentsSectionHtml(st.cardComments, st.cardCommentsErr, cardCfg(st), 'card-comments-body') +
    activitySectionHtml(st.cardActivity, st.cardActivityErr, b, false, 'card-activity-body', st);
  return mask('collab-card-close', t.title || '未命名任务', body);
}

/**
 * 功能：**项目级评论**弹层 —— 与卡片里的评论同一套 UI，只是 `task_id` 缺省（只回项目级）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function projCommentsModalHtml(st) {
  const body = commentsSectionHtml(st.projComments, st.projCommentsErr, projCfg(st), 'proj-comments-body');
  return mask('collab-proj-comments-close', '评论', body);
}

/**
 * 功能：**整个项目活动**弹层 —— 该项目全部任务的流水（时间倒序，带「哪条任务」）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function projActivityModalHtml(st) {
  const body = activitySectionHtml(st.projActivity, st.projActivityErr, st.board, true, 'proj-activity-body', st);
  return mask('collab-proj-activity-close', '活动', body);
}

/**
 * 功能：状态弹层里的一行 —— 改名 / 调色 / 改所属组 / 保存 / 删。
 * @param {Object} s - 状态项
 * @returns {string} 行 HTML
 */
function stateRow(s) {
  const sid = esc(String(s.id));
  return (
    '<div class="collab-strow" data-sid="' +
    sid +
    '">' +
    // ⚠️⭐ 2026-10-20（本版质检）：`maxlength` 原先是 **20**，而电脑端是 **100** —— 同一个状态名
    //    在电脑端打得下 100 字、在手机端被**静默截断**到 20（还不报错）。两端统一成 100。
    '<input class="collab-stname" type="text" data-role="st-name" maxlength="100" value="' +
    esc(s.name) +
    '">' +
    '<input class="collab-stcolor" type="color" data-role="st-color" value="' +
    hexOf(s.color) +
    '">' +
    '<select class="collab-stgroup" data-role="st-group">' +
    groupOptions(String(s.group == null ? '' : s.group)) +
    '</select>' +
    '<button class="collab-btn ghost collab-stsave" type="button" data-act="collab-state-save" data-sid="' +
    sid +
    '">保存</button>' +
    '<button class="collab-btn ghost collab-stdel" type="button" data-act="collab-state-del" data-sid="' +
    sid +
    '">删</button>' +
    // ⚠️⭐ 2026-10-20：**「默认」标记原先只有电脑端有**。而默认状态**不能删**（服务端 400）——
    //    手机端看不到这一颗标记，用户只会觉得「这个『删』按了没反应」。两端同款。
    (Number(s.is_default) === 1 ? '<i class="collab-mem-tag">默认</i>' : '') +
    '</div>'
  );
}

/**
 * 功能：⚙ 状态弹层 —— 按组分块列出状态 ＋ 新增一块（**仅所有者**）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function stateModalHtml(st) {
  const b = st.board;
  const states = Array.isArray(b.states) ? b.states : [];
  const blocks = GROUP_KEYS.map((k) => {
    const items = states.filter((s) => String(s.group == null ? '' : s.group) === k);
    const rows = items.length
      ? items.map((s) => stateRow(s)).join('')
      : '<div class="collab-hint">这一组还没有状态</div>';
    return '<div class="collab-stblk"><div class="collab-sub">' + GROUP_LABEL[k] + '</div>' + rows + '</div>';
  }).join('');
  const add =
    '<div class="collab-stblk"><div class="collab-sub">＋ 新增状态</div>' +
    '<div class="collab-strow">' +
    '<input class="collab-stname" type="text" data-role="ns-name" maxlength="20">' +
    '<input class="collab-stcolor" type="color" data-role="ns-color" value="' +
    DEFAULT_COLOR +
    '">' +
    '<select class="collab-stgroup" data-role="ns-group">' +
    groupOptions('backlog') +
    '</select>' +
    '<button class="collab-btn primary" type="button" data-act="collab-state-add">新增</button>' +
    '</div></div>';
  return mask('collab-state-close', '⚙ 状态', blocks + add);
}

/**
 * 功能：【＋ 新建任务】弹层 —— 标题 / 状态 / 负责人 / 截止日 / 描述。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function newTaskModalHtml(st) {
  const b = st.board;
  const states = Array.isArray(b.states) ? b.states : [];
  const members = Array.isArray(b.members) ? b.members : [];
  const owner = !!(b.project && b.project.role === 'owner');
  const def = states.find((s) => Number(s.is_default) === 1) || states[0] || {};
  const defKey = String(def.key == null ? '' : def.key);
  const ownerId = members.length ? String(Number(members[0].user_id)) : '';
  const today = todayStr();
  const body =
    field('标题', '<input class="collab-input" type="text" data-role="nt-title" maxlength="100">') +
    field('状态', '<select data-role="nt-status">' + stateOptions(states, defKey, owner) + '</select>') +
    field('负责人', '<select data-role="nt-assignee">' + assigneeOptions(members, ownerId) + '</select>') +
    '<div class="collab-field-row" data-role="nt-dates">' +
    field('任务日', '<input class="collab-input" type="date" data-role="nt-start" value="' + esc(today) + '">') +
    field('截止日', '<input class="collab-input" type="date" data-role="nt-due" value="' + esc(today) + '">') +
    '</div>' +
    '<div data-role="nt-kind">' +
    kindBlockHtml('nt', {}) +
    '</div>' +
    field('描述', '<textarea class="collab-input" data-role="nt-desc" maxlength="2000"></textarea>') +
    btns(
      '<button class="collab-btn primary" type="button" data-act="collab-newtask-save">确定</button>' +
        '<button class="collab-btn ghost" type="button" data-act="collab-newtask-close">取消</button>',
    );
  return mask('collab-newtask-close', '新建任务', body);
}

/**
 * 功能：【转让】弹层 —— 先选成员，再二次确认（确认语逐字）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function transferModalHtml(st) {
  const b = st.board;
  const members = Array.isArray(b.members) ? b.members : [];
  const others = members.slice(1);
  if (!st.transferPick) {
    const rows = others.length
      ? others
          .map(
            (m) =>
              '<button class="collab-btn ghost collab-wide" type="button" data-act="collab-transfer-pick" data-uid="' +
              esc(String(m.user_id)) +
              '">' +
              esc(m.display_name || m.username || '') +
              '</button>',
          )
          .join('')
      : '<div class="collab-hint">还没有其他成员可以转让</div>';
    return mask('collab-transfer-close', '转让', '<div class="collab-vlist">' + rows + '</div>');
  }
  const body =
    '<div class="collab-hint">' +
    esc(TRANSFER_NOTE) +
    '</div>' +
    btns(
      '<button class="collab-btn primary" type="button" data-act="collab-transfer-confirm">确定</button>' +
        '<button class="collab-btn ghost" type="button" data-act="collab-transfer-close">取消</button>',
    );
  return mask('collab-transfer-close', '转让', body);
}

/**
 * 功能：给【＋ 新建任务】弹层接线 —— 任务类型块 ＋「状态选在待排期时藏起日期与类型」。
 *
 * 说明：⚠️ 必须在弹层**进文档之后**调（`paint()` 末尾）—— `bindKindBlock()` 要按 id 找节点、
 *      周期规则编辑器也要在文档里才能挂事件。
 * @param {HTMLElement} _root - 本片段根节点（**不再使用**：弹层住宿主的 `#sheet`，节点按 id 全局找）
 * @returns {void}
 */
function bindNewTaskModal(_root) {
  const dates = document.querySelector('[data-role="nt-dates"]');
  if (!dates) return;
  // ⭐ 0.8.54：弹层本体已经是宿主的 `#sheet-body`（`.collab-modal` 那层壳已经不用了）
  const modal = document.getElementById('sheet-body');
  if (!modal) return;
  bindKindBlock('nt', '[data-role="nt-due"]');
  const sel = modal.querySelector('[data-role="nt-status"]');
  const kind = modal.querySelector('[data-role="nt-kind"]');
  if (!sel) return;
  /**
   * 功能：按选中的状态所属的组，切「日期 ＋ 类型」两块的显隐。
   * @returns {void}
   */
  const sync = () => {
    const opt = sel.selectedOptions ? sel.selectedOptions[0] : null;
    const backlog = opt ? String(opt.dataset.group || '') === 'backlog' : false;
    dates.hidden = backlog;
    if (kind) kind.hidden = backlog;
  };
  sel.addEventListener('change', sync);
  sync();
}

/**
 * 功能：给**任务卡片**弹层接线 —— 任务类型块 ＋「这条在待排期时藏起日期与类型」。
 * @param {HTMLElement} _root - 本片段根节点（**不再使用**，理由同上）
 * @returns {void}
 */
function bindCardModal(_root) {
  const dates = document.querySelector('[data-role="card-dates"]');
  if (!dates) return;
  // ⭐ 0.8.54：同上 —— 容器是宿主的 `#sheet-body`
  const modal = document.getElementById('sheet-body');
  if (!modal) return;
  bindKindBlock('cd', '[data-role="card-due"]');
  const sel = modal.querySelector('[data-role="card-status"]');
  const kind = modal.querySelector('[data-role="card-kind"]');
  if (!sel) return;
  /**
   * 功能：按选中的状态所属的组，切「日期 ＋ 类型」两块的显隐。
   * @returns {void}
   */
  const sync = () => {
    const opt = sel.selectedOptions ? sel.selectedOptions[0] : null;
    const backlog = opt ? String(opt.dataset.group || '') === 'backlog' : false;
    dates.hidden = backlog;
    if (kind) kind.hidden = backlog;
  };
  sel.addEventListener('change', sync);
  sync();
}

/**
 * 功能：把整块重画一遍（正文整块替换；根节点上的事件委托不受影响）。
 *
 * ⚠️⭐ 2026-10-20（本版质检）：与电脑端 `paint()` 同一条 —— 重画前**先收**输入框里的字，
 *      重画后放回去。这里原先是无条件 `root.innerHTML = …`，而「看板重新可见」会走
 *      `watchVisible() → reloadBoard() → paint()`（切个标签再切回来、或者从别的屏退回看板）
 *      ⇒ 正在评论框 / 新建任务弹层里打的字**凭空消失**，且没有任何提示。
 *      ⚠️ 下拉（状态 / 负责人 / 分组）**不回填**：它们的值必须由看板数据决定。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function paint(root, st) {
  if (!root) return;
  // ⚠️⭐ 0.8.51 修订：与电脑端 `paint()` 同一条 —— 卡片弹层里那几格（标题 / 描述 / 两个日期）是
  //    **按任务**的草稿，而 `keep` 是按 `data-role` 收的：换一条任务重画时会把上一条任务的字
  //    填进新弹层。⇒ 收之前先认「画着的还是不是同一条」（弹层里那颗「确定」带着 `data-tid`）。
  const saveBtn = document.querySelector('[data-act="collab-card-save"]');
  const sameCard = !!saveBtn && String(saveBtn.dataset.tid || '') === String(st.cardFor || '');
  const keep = new Map();
  for (const el of document.querySelectorAll('[data-role]')) {
    const tag = String(el.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') continue;
    const role = String(el.dataset.role || '');
    if (!role) continue;
    // ⚠️ 文本与日期都收（新建任务弹层里有 `type=date` 的截止日）；`color` / `file` 不收。
    const type = String(el.type || '').toLowerCase();
    if (tag === 'INPUT' && type !== 'text' && type !== 'date') continue;
    // ⚠️ 换了另一条任务 ⇒ 卡片那几格**一格都不收**（见上面 `sameCard` 的说明）。
    if (!sameCard && role.indexOf('card-') === 0) continue;
    keep.set(role, String(el.value == null ? '' : el.value));
  }
  // ⚠️⭐ 2026-10-20：**滚动位置也要收/放** —— 这一屏的滚动落在父容器 `#teamwork-board-body`
  //    上（`app.css` 里它是滚动区），而整块替换后那段偏移会归 0：往下翻到第 10 条、点开卡片
  //    再关掉，人就**被弹回页顶**，得重新往下找。宿主那条「重画不重挂」（`boardMounted`）
  //    管不到片段内部的 `paint()`，只能在这里自己记住。
  const scroller =
    root.parentElement && root.parentElement.scrollHeight > root.parentElement.clientHeight + 4
      ? root.parentElement
      : root;
  const scrollTop = scroller.scrollTop || 0;
  // ⭐ 0.8.53：时间轴的横向滚动位置也收/放（首帧改用「今天居中」，见下面那段）
  const gtBox = root.querySelector('[data-role="gt-scroll"]');
  const gtLeft = gtBox ? gtBox.scrollLeft || 0 : 0;
  root.innerHTML = '<div class="collab-body">' + boardBody(st) + '</div>';
  // ⭐⭐ 0.8.54（「弹窗弹不出来，统一改为走宿主的 opensheet」）：**弹层不再画进看板**，
  //    改由 `syncSheet()` 交给宿主底部弹层（见那个函数的说明）。⚠️ 顺序：先把看板画完再同步弹层 ——
  //    反过来的话，打开弹层那一拍还在老的 DOM 上算滚动位置。
  syncSheet(st);
  if (scrollTop) scroller.scrollTop = scrollTop;
  // ---- 时间轴横向滚动（0.8.53）：首帧把**今天**滑到屏幕中间；之后只还原用户自己滑到的位置
  const gt2 = root.querySelector('[data-role="gt-scroll"]');
  if (gt2) {
    // ⚠️ 只有内容真的比容器宽时才算「可以居中」—— 看板被 hidden 时 `scrollWidth` 是 0，
    //    那一刻把 `gtCentered` 置真，等屏显示出来就再也不会居中了。
    if (!st.gtCentered && gt2.scrollWidth > gt2.clientWidth) {
      const idx = dayNum(todayStr()) - dayNum(fitStart(st, todayStr()));
      if (idx >= 0 && idx < GANTT_DAYS) {
        const max = Math.max(0, gt2.scrollWidth - gt2.clientWidth);
        const want = idx * GANTT_COL_W - (gt2.clientWidth - GANTT_COL_W) / 2;
        gt2.scrollLeft = Math.max(0, Math.min(max, want));
      } else {
        gt2.scrollLeft = 0; // 翻到别的周时今天不在窗口里 ⇒ 从周初看
      }
      st.gtCentered = true;
      st.gtReset = false;
    } else if (st.gtReset) {
      // 翻周 / 点「今天」：新的一周从周初看起（⛔ 别把上一周的滑动位置带过来）
      gt2.scrollLeft = 0;
      st.gtReset = false;
    } else if (gtLeft) {
      gt2.scrollLeft = gtLeft;
    }
  }
  // ---- 弹层联动（0.8.53）：任务类型块 ＋「待排期时藏起日期与类型」
  if (st.newTaskOpen && st.board) bindNewTaskModal(root);
  if (st.cardFor && st.board) bindCardModal(root);
  if (st.promoteFor && st.board) bindKindBlock('pm', '[data-role="pm-due"]');
  if (!keep.size) return;
  for (const el of document.querySelectorAll('[data-role]')) {
    const role = String(el.dataset.role || '');
    if (!keep.has(role)) continue;
    if (role === 'card-status' || role === 'card-assignee' || role === 'nt-status') continue;
    el.value = keep.get(role);
  }
}

// ================================================================ 弹层（宿主底部弹层）

/**
 * 上一次同步时我们开在宿主底部弹层里的**是哪一个**弹层（`''` = 没开）。
 *
 * ⚠️ 为什么要记：宿主的 `openSheet()` 是「把内容灌进 #sheet-body」的模型 —— 同一次打开
 * 反复灌内容不该再压一条 history（那边已经用 `isSheetOpen()` 挡住了），但**我们**还需要
 * 认出「用户把弹层关了」这件事（× / 点遮罩 / 按返回），否则下一次重画会把弹层又弹回来。
 * @type {string}
 */
let sheetKey = '';

/**
 * 功能：当前该开哪个弹层（把原来「按 st 拼 HTML」的判断收在一处）。
 *
 * 说明：⚠️ 判断顺序 = 原来的拼接顺序，⛔ 别改 —— 同一时刻只会有一个弹层开着，
 *      但「先开谁」决定了并发置位时谁赢（例如打开详情的同时又点了新建）。
 * @param {Object} st - 状态
 * @returns {?{closeAct: string, title: string, body: string}} 弹层描述；没开时为 null
 */
function currentSheet(st) {
  if (!st.board) return null;
  if (st.stateOpen) return Object.assign({ key: 'state' }, stateModalHtml(st));
  if (st.newTaskOpen) return Object.assign({ key: 'new-task' }, newTaskModalHtml(st));
  if (st.membersOpen) return Object.assign({ key: 'members' }, membersModalHtml(st, st.board));
  if (st.transferOpen) return Object.assign({ key: 'transfer' }, transferModalHtml(st));
  if (st.cardFor) return Object.assign({ key: 'card:' + Number(st.cardFor) }, cardModalHtml(st));
  if (st.promoteFor) return Object.assign({ key: 'promote:' + Number(st.promoteFor) }, promoteModalHtml(st));
  if (st.projCommentsOpen) return Object.assign({ key: 'proj-comments' }, projCommentsModalHtml(st));
  if (st.projActivityOpen) return Object.assign({ key: 'proj-activity' }, projActivityModalHtml(st));
  return null;
}

/**
 * 功能：把「该开的弹层」同步到**宿主底部弹层**（⭐ 0.8.54：「统一改为走宿主的 opensheet」）。
 *
 * 说明：⭐⭐ 这是本轮的关键一步 —— 以前弹层是本片段自己画的遮罩，现在一律 `openSheet()`：
 *      · 该开、宿主还关着 ⇒ `openSheet(title, body)`（内部自己压一条 history）；
 *      · 该开、已经开着且**同一个**弹层 ⇒ 只换 `#sheet-body` 的内容（不重压 history、不重播动画）；
 *      · 该开、已经开着但是**换了一个**弹层 ⇒ 重新 `openSheet()`（标题也要换）；
 *      · 不该开、宿主还开着 ⇒ `closeSheet()`（动作收尾时会被调，例如「取消」）；
 *      · 不该开、宿主也已经关了（用户点了 × / 遮罩 / 返回）⇒ 什么都不做。
 *      ⚠️ 用户自己关掉的那一趟由 `zx:sheet-closed` 事件兜住（见 `bindSheetClosed`）：
 *      那里会把 `st` 上的标记一起清掉，所以下一次重画不会把弹层又弹回来。
 *      ⚠️ 反复重画时**只换 innerHTML**：内容里的输入框会重建（与从前自绘遮罩的行为一致，
 *      值由 `paint()` 里那段 keep/restore 还原）—— 这是既有取舍，⛔ 不是本轮引入的。
 * @param {Object} st - 状态
 * @returns {void}
 */
function syncSheet(st) {
  const want = currentSheet(st);
  if (!want) {
    if (isSheetOpen()) closeSheet();
    sheetKey = '';
    return;
  }
  if (!isSheetOpen()) {
    // 我们以为开着、宿主其实关着（理论上由 zx:sheet-closed 兜住，这里是第二道保险）
    sheetKey = want.key;
    openSheet(want.title, '<div class="collab-sheet">' + want.body + '</div>', '');
    return;
  }
  if (sheetKey !== want.key) {
    sheetKey = want.key;
    openSheet(want.title, '<div class="collab-sheet">' + want.body + '</div>', '');
    return;
  }
  const box = document.getElementById('sheet-body');
  if (box) box.innerHTML = '<div class="collab-sheet">' + want.body + '</div>';
}

/**
 * 功能：听「宿主弹层关了」—— 把本片段记的「开着哪个弹层」一起清掉（⭐ 0.8.54）。
 *
 * 说明：⚠️ 宿主 `#sheet` 的 × / 点遮罩 / 返回键三条关法都发生在宿主层，本片段收不到动作，
 *      所以 `closeSheet()` 里会派一个 `zx:sheet-closed`（见 `mobile/ui.js`）。
 *      没有这一条的表现是：用户点 × 关掉详情，下一次任何操作（比如切筛选）重画时弹层**又回来了**。
 *      ⚠️ 只挂一次（模块级标记）：片段重挂不重复。
 * @param {Function} getSt - `() => st`：拿当前状态（片段重挂后 st 会换新对象，所以取函数）
 * @returns {void}
 */
function bindSheetClosed(getSt) {
  if (bindSheetClosed._bound) return;
  bindSheetClosed._bound = true;
  document.addEventListener('zx:sheet-closed', () => {
    const st = typeof getSt === 'function' ? getSt() : null;
    if (st) closeAll(st);
    sheetKey = '';
  });
}

/**
 * 功能：给**宿主弹层里的动作**接线（⭐ 0.8.54）—— 文档级委托，只挂一次。
 *
 * 说明：⭐⭐ `#sheet` 是 `#app` 的子节点、**不是**本片段 `root` 的子节点 ⇒ 弹层里的
 *      「确定 / 取消 / 发评论 / 删附件 / 上传」这些 `data-act` 走到 root 那条委托时**根本收不到**
 *      （症状：弹层能显示，但按钮点了没反应）。所以这里补一条文档级入口。
 *      ⚠️ 三重收窄，避免抢别人的动作：
 *      ① `isSheetOpen()` —— 只在自己开着弹层时接管；
 *      ② 只认 `#sheet-body` 里的节点（宿主的 ✕ / 遮罩不在 body 里，仍归宿主）；
 *      ③ 只认 `collab-` 前缀（宿主的 `sheet-close` / 别的模块的动作一律放行）。
 *      ⚠️ 宿主自己那条 document 委托也会收到同一个点击，但它按 `data-act` 查表 ——
 *      表里没有 `collab-*` 键，查不到就什么都不做（既有约定），不会重复执行。
 * @param {Function} getRoot - `() => HTMLElement`：片段根节点（重挂会换，故取函数）
 * @param {Function} getSt - `() => Object`：状态
 * @returns {void}
 */
function bindSheetActs(getRoot, getSt) {
  if (bindSheetActs._bound) return;
  bindSheetActs._bound = true;
  document.addEventListener('click', (e) => {
    if (!isSheetOpen()) return;
    const el = e.target;
    const t = el && el.closest ? el.closest('#sheet-body [data-act]') : null;
    if (!t) return;
    const act = String(t.dataset.act || '');
    if (act.indexOf('collab-') !== 0) return;
    const root = getRoot();
    const st = getSt();
    if (root && st) runAct(root, st, act, t);
  });
  document.addEventListener('change', (e) => {
    if (!isSheetOpen()) return;
    const el = e.target;
    if (!el || el.type !== 'file' || !el.closest('#sheet-body')) return;
    const root = getRoot();
    const st = getSt();
    if (root && st) onFilePick(root, st, e);
  });
}

// ================================================================ 交互

/**
 * 功能：关掉全部弹层（遮罩空白处点一下就走它）。
 * @param {Object} st - 状态
 * @returns {void}
 */
function closeAll(st) {
  st.stateOpen = false;
  st.newTaskOpen = false;
  st.transferOpen = false;
  st.transferPick = 0;
  st.membersOpen = false;
  st.cardFor = 0;
  st.promoteFor = 0;
  st.addOpen = false;
  st.projCommentsOpen = false;
  st.projActivityOpen = false;
}

/**
 * 功能：点事件的委托入口（挂在根节点上，重画不丢）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {Event} e - 点击事件
 * @returns {void}
 */
function onClick(root, st, e) {
  const el = e.target;
  const t = el && el.closest ? el.closest('[data-act]') : null;
  if (!t) return;
  runAct(root, st, String(t.dataset.act || ''), t);
}

/**
 * 功能：**动作分派本体**（从 `onClick()` 里拆出来的那条 if-else 链，⭐ 0.8.54）。
 *
 * 说明：⭐⭐ 为什么要拆：弹层现在住**宿主的 `#sheet`**（它是片段根节点 `root` 的兄弟节点），
 *      挂在 `root` 上的点击委托**收不到弹层里的点击**。所以必须有第二条入口
 *      （文档级委托，见 `bindSheetActs()`），两条入口共用这一份分派 ——
 *      ⛔ 别把动作链复制第二遍（那正是「几处各写一份」的经典坏味道）。
 *      ⚠️ 原来那条「点 `.collab-mask` 空白处关弹层」的分支**删掉了**：遮罩是宿主的 `#scrim`，
 *      点它关弹层的逻辑在宿主里（`closeSheet()` → 派 `zx:sheet-closed`），本片段不必也不该再判一次。
 * @param {HTMLElement} root - 本片段根节点（画看板用）
 * @param {Object} st - 状态
 * @param {string} act - 动作名（`data-act`）
 * @param {HTMLElement} t - 触发节点（动作要读它的 `dataset`）
 * @returns {void}
 */
function runAct(root, st, act, t) {
  if (act === 'collab-board-reload') reloadBoard(root, st);
  else if (act === 'collab-gt-filter') {
    st.gtFilter = t.dataset.grp || GANTT_ALL;
    paint(root, st);
  } else if (act === 'collab-gt-prev') {
    // ⭐ 0.8.53：一周一页地翻（窗口就是一周）；翻过去之后横向滚动回到**周初**看
    st.gtStart = addDays(fitStart(st, todayStr()), -7);
    st.gtCentered = true;
    st.gtReset = true;
    paint(root, st);
  } else if (act === 'collab-gt-next') {
    st.gtStart = addDays(fitStart(st, todayStr()), 7);
    st.gtCentered = true;
    st.gtReset = true;
    paint(root, st);
  } else if (act === 'collab-gt-today') {
    // 回到本周 —— 并让下一帧重新把今天横滑到中间
    st.gtStart = null;
    st.gtCentered = false;
    st.gtReset = true;
    paint(root, st);
  } else if (act === 'collab-promote-open') {
    // ⭐ 0.8.53：待排期列表里那一颗【转为任务】—— 先关掉别的弹层，再开它
    closeAll(st);
    st.promoteFor = Number(t.dataset.tid) || 0;
    paint(root, st);
  } else if (act === 'collab-task-del') deleteBacklogTask(root, st, t.dataset.tid);
  else if (act === 'collab-promote-close') {
    st.promoteFor = 0;
    paint(root, st);
  } else if (act === 'collab-promote-save') promoteTask(root, st);
  else if (act === 'collab-card') {
    openCard(root, st, t.dataset.tid);
  } else if (act === 'collab-card-close') {
    st.cardFor = 0;
    paint(root, st);
  } else if (act === 'collab-card-save') saveCard(root, st, t.dataset.tid);
  else if (act === 'collab-card-comment-send') sendComment(root, st, 'card', st.cardFor, loadCardComments);
  else if (act === 'collab-card-comment-del') deleteComment(root, st, t.dataset.cid, 'card');
  else if (act === 'collab-card-comment-chip-del') removeStaged(root, st, 'card', t.dataset.idx);
  else if (act === 'collab-file-del') deleteFile(root, st, t.dataset.fid);
  else if (act === 'collab-file-dl') downloadFile(t.dataset.fid);
  else if (act === 'collab-members-open') {
    st.membersOpen = true;
    paint(root, st);
  } else if (act === 'collab-members-close') {
    st.membersOpen = false;
    st.addOpen = false;
    paint(root, st);
  } else if (act === 'collab-proj-comments-open') openProjComments(root, st);
  else if (act === 'collab-proj-comments-close') {
    st.projCommentsOpen = false;
    paint(root, st);
  } else if (act === 'collab-proj-comment-send') sendComment(root, st, 'proj', null, loadProjComments);
  else if (act === 'collab-proj-comment-del') deleteComment(root, st, t.dataset.cid, 'proj');
  else if (act === 'collab-proj-comment-chip-del') removeStaged(root, st, 'proj', t.dataset.idx);
  else if (act === 'collab-proj-activity-open') openProjActivity(root, st);
  else if (act === 'collab-proj-activity-close') {
    st.projActivityOpen = false;
    paint(root, st);
  } else if (act === 'collab-state-open') {
    st.stateOpen = true;
    paint(root, st);
  } else if (act === 'collab-state-close') {
    st.stateOpen = false;
    paint(root, st);
  } else if (act === 'collab-state-save') saveState(root, st, t.dataset.sid);
  else if (act === 'collab-state-del') deleteState(root, st, t.dataset.sid);
  else if (act === 'collab-state-add') addState(root, st);
  else if (act === 'collab-newtask-open') {
    st.newTaskOpen = true;
    paint(root, st);
  } else if (act === 'collab-newtask-close') {
    st.newTaskOpen = false;
    paint(root, st);
  } else if (act === 'collab-newtask-save') createTask(root, st);
  else if (act === 'collab-transfer-open') {
    st.transferOpen = true;
    st.transferPick = 0;
    paint(root, st);
  } else if (act === 'collab-transfer-pick') {
    st.transferPick = Number(t.dataset.uid);
    paint(root, st);
  } else if (act === 'collab-transfer-close') {
    st.transferOpen = false;
    st.transferPick = 0;
    paint(root, st);
  } else if (act === 'collab-transfer-confirm') confirmTransfer(root, st);
  else if (act === 'collab-add-open') {
    st.addOpen = true;
    if (st.friends === null) loadFriends(st).then(() => paint(root, st));
    else paint(root, st);
  } else if (act === 'collab-add-cancel') {
    st.addOpen = false;
    paint(root, st);
  } else if (act === 'collab-add-save') addMember(root, st);
  else if (act === 'collab-remove-member') removeMember(root, st, t.dataset.uid);
  else if (act === 'collab-unshare') unshareProject(root, st);
}

/**
 * 功能：渲染手机版协作看板的插槽片段（`core/slots.js` 的挂载入口）。
 *
 * 说明：⚠️ 项目编号从 `ctx.collabPid` 拿（宿主写进来的「点开的是哪一条」）——
 *      本片段不认识列表页、也不认识宿主，槽里只有一个「画哪个项目」的入参。
 *
 * @param {Object} ctx - 挂载上下文（`{ end, modules, uiOf, me, collabPid }`）
 * @returns {HTMLElement} 本片段的根节点
 */
export function render(ctx) {
  const root = document.createElement('div');
  root.className = 'collab-board-block';
  const st = createState(ctx);
  root.addEventListener('click', (e) => onClick(root, st, e));
  // ⭐ 2f：附件上传走 `<input type="file">` 的 change（⛔ 不用拖拽）
  root.addEventListener('change', (e) => onFilePick(root, st, e));
  // ⭐⭐ 0.8.54：**弹层住在宿主的 `#sheet` 里**（兄弟节点）⇒ 它的点击 / 选文件要另挂文档级入口；
  //    另外「用户把弹层关了」也要有人告诉我们（× / 遮罩 / 返回三条都在宿主层）。
  bindSheetActs(() => root, () => st);
  bindSheetClosed(() => st);
  // ⚠️⭐ 2026-10-20（本版质检）：**系统返回键先关弹层**（见 `mobile.js` 的 `teamworkBackLayer()`）。
  //    本片段画的这七个弹层不是宿主的 `openSheet()`，宿主认不出来；没有这一条的话，
  //    看板里开着弹层按返回会把**整屏**一起退掉（填了一半的评论 / 新建任务跟着没了）。
  //    ⚠️ 只在真有弹层时把 `handled` 置真 —— 没弹层时要让宿主照常退屏。
  const onBack = (e) => {
    if (!e || !e.detail) return;
    if (!hasAnyModal(st)) return;
    closeAll(st);
    paint(root, st);
    e.detail.handled = true;
  };
  document.addEventListener('zx:teamwork-collab-back', onBack);
  paint(root, st);
  // ⚠️ 没拿到编号就**不取数**：画一句「没拿到要打开的项目编号」，⛔ 别静默开个空看板
  if (!st.pid) {
    st.boardErr = '没拿到要打开的项目编号';
    paint(root, st);
    return root;
  }
  const loaded = reloadBoard(root, st);
  // ⭐⭐ 0.8.53（团队协作的项目里也要有 + 图标可以新建任务）：宿主从**项目行**那颗
  //    ＋ 进来时，挂载上下文带 `openNew` —— 等看板数据到手再把【新建任务】弹层打开
  //    （弹层要用状态集与成员名单，数据没到就弹不出来）。
  if (ctx && ctx.openNew) {
    loaded.then(() => {
      if (!root.isConnected || !st.board) return;
      st.newTaskOpen = true;
      paint(root, st);
    });
  }
  watchVisible(root, st);
  return root;
}

/**
 * 功能：当前有没有**任何一个**弹层开着（系统返回键那条路用）。
 * 说明：⚠️ 与 `closeAll()` 的字段清单必须同进同出 —— 漏一个的表现是「那个弹层开着时按返回，整屏被退掉」。
 * @param {Object} st - 状态
 * @returns {boolean} 有弹层则为 true
 */
function hasAnyModal(st) {
  return !!(
    st.stateOpen ||
    st.newTaskOpen ||
    st.transferOpen ||
    st.membersOpen ||
    st.cardFor ||
    st.promoteFor ||
    st.projCommentsOpen ||
    st.projActivityOpen
  );
}

/**
 * 功能：⭐ 看板**重新可见**时重取一次（契约 §3-2「打开 / 切回看板时重取」）。
 *
 * 说明：⚠️ 宿主 `paintCollabBoard()` 是「重画不重挂」——切到别的标签再切回来**不会**再调 `render()`
 *      ⇒ 只靠挂载时取一次，期间别的成员改的东西就永远看不到（「没有实时刷新」）。
 *      这里用 `IntersectionObserver` 看本片段的根节点**在不在视口 / 有没有被 `hidden` 藏掉**：
 *      从「看不见」变成「看得见」时重取一次（首次挂载那一下跳过 —— `render()` 已经取过了）。
 *      ⚠️ 老浏览器没有 `IntersectionObserver` 时**当作没这回事**（⛔ 不抛，只是少了这层刷新）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function watchVisible(root, st) {
  if (typeof IntersectionObserver !== 'function') return;
  let wasVisible = false;
  let primed = false;
  const io = new IntersectionObserver((entries) => {
    const vis = !!(entries && entries[0] && entries[0].isIntersecting);
    if (!primed) {
      primed = true;
      wasVisible = vis;
      return;
    }
    // ⭐⭐ 0.8.54：看板**被切走**（切标签 / 退出项目 / 从别的屏盖上来）时，把开着的弹层一起关掉。
    //    ⚠️ 为什么现在需要：弹层住宿主的 `#sheet`，**不跟着看板一起消失**（从前自绘的遮罩在
    //    片段根节点里，看板一藏它就跟着走）。不关的话会出现「人已经到『今天』了，屏幕上还压着一张
    //    协作的任务详情」。
    if (!vis && wasVisible && (sheetKey || isSheetOpen())) {
      closeAll(st);
      sheetKey = '';
      if (isSheetOpen()) closeSheet();
    }
    // ⭐⭐ 0.8.54：看板**被切走**（切标签 / 退出项目 / 从别的屏盖上来）时，把开着的弹层一起关掉。
    //    ⚠️ 为什么现在需要：弹层住宿主的 `#sheet`，**不跟着看板一起消失**（从前自绘的遮罩在
    //    片段根节点里，看板一藏它就跟着走）。不关的话会出现「人已经到『今天』了，屏幕上还压着一张
    //    协作的任务详情」。
    if (!vis && wasVisible && (sheetKey || isSheetOpen())) {
      closeAll(st);
      sheetKey = '';
      if (isSheetOpen()) closeSheet();
    }
    if (vis && !wasVisible && !st.busy) reloadBoard(root, st);
    wasVisible = vis;
  });
  io.observe(root);
}
