'use strict';
/**
 * modules/teamwork/desktop-teamwork-board.js —— 协作看板在**电脑版主区**的插槽片段
 *
 * 功能：`teamwork-board` 槽的电脑版实现 —— 点开左栏「协作项目」组里的一条 ⇒ 主区（**聊天窗口位置**）
 *      让位给这个共享项目的看板：
 *      ① 页头：`已完成 n / 共 m` ＋ 一条细进度条 ＋【⚙ 状态】（仅所有者）＋【协作成员管理】【💬 评论】【活动】；
 *         ⭐ 2026-10-23：「新建任务」从这一排**挪到右下角悬浮**（`fabHtml()`，与首页看板那颗同款）；
 *         ⚠️ 项目名与「← 返回」由**宿主**画在 `#teamwork-conv-head`（与插槽会话同一个位置感）；
 *      ② 成员块：收成一颗【协作成员管理】按钮 —— 点开弹层里**显示和设置**成员
 *         （分「成员」与「项目操作」两组；成员**一行一个**：名字 ＋ `我`/`发起人` ＋ 移出 ·
 *         ＋加成员 · 移出协作 · 转让 · 那句说明 · 最底一行上传用量）；
 *      ③ 看板：一张**按周列的甘特时间轴** —— ⭐ 照任务板 `modules/tasks/desktop-board.js` 的
 *         `renderTimeline()` 那一套（「照着抄任务-甘特图」）：一行 `«` 周区间 `»`
 *         ＋ 一颗 `今天`；下面**一天一列**，列头＝星期几 ＋ `M/D`；⭐ **条里直接写任务名**的彩色药丸，
 *         同一时段重叠的条**自动错行**（贪心分道，见 `lanesOf`），⛔ **没有左侧名字列**；
 *         顶部一排状态图例可只看某一组的任务。⚠️ 负责人 / 截止日 / `💬 n` / `📎 n` 收进条的
 *         `title`（悬停可见）与任务详情弹层里本来就有（条里放不下）；
 *         ⭐ 进入时默认显示**本周**（自己点「»」翻走之后听用户的，`今天` 拨回本周）；
 *         ⛔ 任务条下沿**不再画时间节点小圆点**（移除 —— 流水仍在卡片弹层的
 *         「活动」栏里，信息一个字没丢）；
 *      ④ 卡片四样：标题 / 负责人（`未认领` 兜底）/ 截止日 / 两个角标（评论 / 附件，缺失按 0）；
 *      ⑤ ⭐ 2f / 2g：卡片弹层里 —— **活动**流水每条带自己的附件（挂在 `report_id` 上，不变）；
 *         **评论**做成「短视频评论区」样式（头像首字 / 名字 / 时间 `MM-DD HH:mm` / 右上角删除），
 *         ⭐ 附件跟着评论走（挂在 `comment_id` 上，紧贴正文下面画，`📎 文件名 · 大小` 可下 / 可删），
 *         底部一条输入条（`＋` 选文件 · 单行输入 · `发送`，先建评论再挂附件）；没挂评论的老附件
 *         归到评论列表最下面的「其他附件」块；＋ 成员块里一行「每个成员上传了多少」（只统计、不限额）。
 *
 * ⭐ 谁负责哪一半（与 `desktop-teamwork-page.js` 分工，别搞混）：
 *      · **本文件**只画「一个项目」的看板与它那几个弹层（状态 / 新建任务 / 转让 / 加成员）；
 *      · 「协作项目列表 + 添加共享项目弹层 + 往左栏登记条目」全在 `desktop-teamwork-page.js`。
 *      两者都建立在 `teamwork` 模块的留白事件上，**谁都不认识 `teamwork` 模块的内部**。
 *
 * ⚠️ **判权全在服务端**：非成员 / 项目没共享 / 项目不存在，服务端一律 404 —— 前端按「看不到」处理，
 *    ⛔ 不去猜原因。⛔ **界面只做可见性**（例如非所有者不摆「改到已完成」那一项），
 *    真动到越界的动作时**照常把服务端那句话弹出来**，⛔ 不静默吞掉。
 *
 * ⚠️ **看板取数一次到位**：`GET /api/collab/projects/:pid/board` ⇒ `{project, states, groups,
 *    progress, members, unknown}` —— 本文件不再分别取任务 / 上报 / 成员（那些是旧形态）。
 *
 * ⚠️ **项目编号从挂载上下文拿**：宿主 `mountSlots(..., 'teamwork-board', { collabPid })` 把「点开的
 *    是哪一条」随 `ctx` 传进来（`render()` 里读 `ctx.collabPid`）—— 本文件不认识左栏、也不认识宿主。
 *
 * ⚠️ 本文件**自包含**（只 import core 与宿主 ui），不依赖任务板别的片段。
 *
 * @author zx
 * @date   2026-10-04
 * @since 0.8.54
 * 相关：docs/公共/开发方案/32-团队协作.md §丁 · §丙-2、core/slots.js、modules/teamwork/desktop-teamwork-page.js
 */

import { api, BASE, backToLogin } from '../../core/api.js';
import { esc } from '../../core/dom.js';
// ⭐⭐ 0.8.17：甘特条的**区间语义**照任务板 —— 终点走共用层的 `visEnd()`
//    （已完成止于完成日 · 逾期未完成顺延到今天）；周期任务画成「**一期一段**」，它的三个判据
//    （哪几期 · 欠没欠 · 打卡进度）全住共用层 `core/recur.js`。
//    ⚠️ 这三个都是 **core 共用层**（与任务板 `desktop-board.js:43-44` 同一批 import），
//    ⛔ 不是「import 别的模块的实现」。
import { visEnd } from '../../core/task.js';
import { missedPeriods, parseRule, periodsBetween, tickProgress } from '../../core/recur.js';
import { COLORS } from '../../core/constants.js';
import { toast } from '../../desktop/ui.js';
// ⭐⭐ 0.8.53（没有适配周期和窗口两个任务类型）：任务类型块**两端共用一份**
//    （三选一 ＋ 时间窗 ＋ 两个时刻 ＋ 周期规则；规则编辑器本身来自任务板的 `shared.js`）。
import { bindKindBlock, kindBlockHtml, readKindFields } from './teamwork-taskkind.js';

/** 五组 → 组名（与契约 §3.2 逐字一致，⛔ 一个字都不许改）。 @type {Object.<string,string>} */
const GROUP_LABEL = {
  backlog: '待排期',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

/** 五组的固定先后（列从左到右就是它）。 @type {Array.<string>} */
const GROUP_ORDER = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];

/** 状态不在状态集里时那一列的列名。 @type {string} */
const UNKNOWN_LABEL = '未知状态';

/** 没有负责人时卡片上显示的那句话（契约 §3.2 逐字）。 @type {string} */
const UNCLAIMED = '未认领';

/** 非所有者想在已完成组动手时给的那句话（契约 §3.2 逐字）。 @type {string} */
const OWNER_ONLY = '只有项目所有者能验收';

/** 转让的二次确认语（契约 §3.2 逐字，⛔ 一个标点都不许改）。 @type {string} */
const TRANSFER_ASK = '转让后你不再是所有者：验收权与成员管理权都归新所有者；已设的负责人不变。';

/** 成员弹层里那句说明（契约 §2.1-① 逐字，⛔ 一个标点都不许改）。 @type {string} */
const SHARED_NOTE = '移出后成员立刻看不到；成员名单还在，重新加回来又看得见。';

/** 调色器没有可用色值时的回落色（与 `--zx-brand` 同值，只用作表单初值）。 @type {string} */
const FALLBACK_COLOR = '#4f46e5';

/** 空值那一格显示的那个破折号（流水里 `from_status` 为空时用它）。 @type {string} */
const DASH = '—';

/** ⭐ 2f：单个附件的大小上限（字节，与方案 §戊-6 及服务端口径一致）。 @type {number} */
const FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * ⭐ 2f：允许上传的扩展名（与服务端白名单一致）。
 * 说明：⚠️ 服务端才是判据，这里只挡一次「注定白跑」的请求；⛔ 不在这里收 `svg` / `html` / `exe` / `js`。
 * @type {Array.<string>}
 */
const FILE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv', 'docx', 'xlsx', 'pptx', 'zip'];

/**
 * ⭐ 评论 / 活动两块里的固定文案 —— **逐字**照契约 §3（手机端必须与它一致，⛔ 一个标点都不许改）。
 * @type {Object.<string,string>}
 */
const TXT = {
  comment: '评论',
  send: '发送',
  noComment: '还没有评论',
  activity: '活动',
  noActivity: '还没有活动',
  del: '删除',
  onlyAuthor: '只有作者能删这条评论',
  loading: '正在读取…',
  needBody: '请填写评论内容',
  // ⭐ 2f：附件相关的文案（契约 §5，两端逐字一致）
  file: '附件',
  addFile: '＋ 附件',
  noFile: '还没有附件',
  otherFiles: '其他附件',
  download: '下载',
  goneUser: '已注销成员',
  tooBig: '文件太大（单个不超过 10 MB）',
  badType: '这种文件类型不支持',
  usage: '上传用量',
};

/**
 * 功能：取一个能喂给 `<input type="color">` 的十六进制色 —— 它只认 `#rrggbb`。
 * @param {*} c - 服务端给的颜色
 * @returns {string} `#rrggbb`（认不出来时回落默认色）
 */
function hexOf(c) {
  const s = String(c == null ? '' : c).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return FALLBACK_COLOR;
}

/**
 * 功能：判断一个值算不算「有编号」—— ⚠️ 先挡 `null` / 空串（`Number(null) === 0` 会静默判错）。
 * @param {*} v - 待判断的值
 * @returns {boolean} 是有限数则为 true
 */
function isNum(v) {
  if (v == null || v === '') return false;
  return Number.isFinite(Number(v));
}

/**
 * 功能：把一个值归一成数字，认不出就是 0（**先挡 null / 空串**）。
 * @param {*} v - 待归一的值
 * @returns {number} 数字（非有限数回落 0）
 */
function numOrZero(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 功能：组键 → 组名（认不出的原样返回，不编一个名字）。
 * @param {*} g - 组键
 * @returns {string} 组名
 */
function groupLabel(g) {
  const k = String(g == null ? '' : g);
  return GROUP_LABEL[k] || k;
}

/**
 * 功能：从错误对象里取一句能看的文案（服务端的原话优先）。
 * @param {*} e - 抛出来的错误
 * @returns {string} 错误文案
 */
function msgOf(e) {
  return e && e.message ? e.message : '读取失败';
}

/**
 * 功能：删评论失败时的提示语 —— 优先服务端原话；服务端只回了「HTTP 404」这种空壳时，
 *      才用契约 §3 那句「只有作者能删这条评论」兜底（⛔ 不静默吞掉）。
 * @param {*} e - 抛出来的错误
 * @returns {string} 提示语
 */
function delErrText(e) {
  const m = msgOf(e);
  if (e && e.status === 404 && /^HTTP \d+$/.test(m)) return TXT.onlyAuthor;
  return m;
}

/**
 * 功能：把一个时间戳裁成「日期 时分」（`2026-10-04T12:34:56Z` ⇒ `2026-10-04 12:34`）。
 * 说明：⚠️ `created_at` 是带连字符的字符串，⛔ 不许对它包 `Number()`。
 * @param {*} s - 服务端给的时间戳
 * @returns {string} 展示用时间（空值回空串）
 */
function stampOf(s) {
  if (s == null || s === '') return '';
  return String(s).slice(0, 16).replace('T', ' ');
}

/**
 * 功能：把时间戳裁成评论区那种短格式（`MM-DD HH:mm`，照契约 §1 的版式图）。
 * @param {*} s - 服务端给的时间戳
 * @returns {string} 展示用短时间（认不出原样回退 `stampOf`）
 */
function stampShort(s) {
  const t = stampOf(s);
  return t.length >= 16 ? t.slice(5) : t;
}

// ================================================================ 甘特图的小几何

/** 一天的毫秒数（把「天序号」与时间戳来回换算用它）。 @type {number} */
const DAY_MS = 86400000;

/** 一个任务的当前状态认不出时归到的那一组（只用于配色与筛选，⛔ 不编名字）。 @type {string} */
const GROUP_UNKNOWN = 'unknown';

/**
 * 功能：把一个时间戳裁成**天序号**（自 1970 起算的整数天）—— 甘特图按天定位。
 * 说明：⚠️ 只取前面的 `YYYY-MM-DD`（日期粒度足够）；⛔ 不直接丢给 `Date` 解析 ——
 *      `YYYY-MM-DD` 会被当 UTC、`YYYY-MM-DD HH:mm` 会被当本地时间，混着算会整体偏一天。
 * @param {*} s - 服务端给的时间戳 / 日期
 * @returns {?number} 天序号（认不出回 null）
 */
function dayIndexOf(s) {
  if (s == null || s === '') return null;
  const m = String(s)
    .slice(0, 10)
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/**
 * 功能：从 `YYYY-MM-DD` 或时间戳里取前 10 位日期 —— ⚠️ 长度不够（认不出）时回空串，⛔ 不硬切。
 *
 * 说明：任务详情弹层里那两格 `<input type="date">` 只认 `YYYY-MM-DD`；而 `start_date` / `due_date`
 *      在库里可能是空串、也可能是带时刻的串（老数据）⇒ 先截到 10 位，认不出就让那格空着。
 * @param {*} v - 日期 / 时间戳
 * @returns {string} `YYYY-MM-DD` 或空串
 */
function date10Of(v) {
  const s = String(v == null ? '' : v);
  return s.length >= 10 ? s.slice(0, 10) : '';
}

/**
 * 功能：今天的天序号（按**本机本地日历**取年月日，再统一到与 `dayIndexOf` 同一个刻度）。
 * @returns {number} 今天的天序号
 */
function todayIndex() {
  const d = new Date();
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/**
 * 功能：把天序号还原成 `YYYY-MM-DD`（刻度与 `dayIndexOf` 一致）。
 * @param {number} i - 天序号
 * @returns {string} 日期文案
 */
function dayText(i) {
  const d = new Date(i * DAY_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + mm + '-' + dd;
}

/** 一周 7 天（周视图**一天一列**）。 @type {number} */
const WEEK_DAYS = 7;

/** 星期单字表（下标 0 = 周日，与 `getUTCDay()` 同口径）。 @type {string} */
const WEEK_CHARS = '日一二三四五六';

/**
 * 功能：一个天序号是星期几（0 = 周日，与 `getUTCDay()` 一致）—— ⚠️ 全程走 UTC，
 *      与 `dayIndexOf` / `dayText` 同一个刻度，⛔ 不会偏一天。
 * @param {number} i - 天序号
 * @returns {number} 0~6（0 = 周日）
 */
function weekdayOf(i) {
  return new Date(i * DAY_MS).getUTCDay();
}

/**
 * 功能：某天所在那一周的**周一**天序号（周视图一周从周一起，照任务模块的既有惯例）。
 * 说明：`(weekday + 6) % 7` ⇒ 周一 0、周日 6（与 `core/date.js` 的 `mondayOf` 同口径）。
 * @param {number} i - 天序号
 * @returns {number} 周一的天序号
 */
function mondayOfIndex(i) {
  return i - ((weekdayOf(i) + 6) % 7);
}

/**
 * 功能：天序号 → 列头那种 `M/D` 短文案（照契约 §1 的版式图）。
 * @param {number} i - 天序号
 * @returns {string} 形如 `9/28`
 */
function dayShort(i) {
  const t = dayText(i);
  return Number(t.slice(5, 7)) + '/' + Number(t.slice(8, 10));
}

// ================================================================ 看板数据的小读口

/**
 * 功能：取看板响应里的状态集。
 * @param {Object} b - 看板响应
 * @returns {Array.<Object>} 状态项数组
 */
function statesOf(b) {
  return b && Array.isArray(b.states) ? b.states : [];
}

/**
 * 功能：取看板响应里的五组分组表。
 * @param {Object} b - 看板响应
 * @returns {Object} `{ backlog: [], ... }`
 */
function groupsOf(b) {
  return b && b.groups && typeof b.groups === 'object' ? b.groups : {};
}

/**
 * 功能：取看板响应里的成员名单。
 * @param {Object} b - 看板响应
 * @returns {Array.<Object>} 成员数组
 */
function membersOf(b) {
  return b && Array.isArray(b.members) ? b.members : [];
}

/**
 * 功能：取某一组里的任务卡片。
 * @param {Object} b - 看板响应
 * @param {string} g - 组键
 * @returns {Array.<Object>} 任务数组
 */
function cardsOf(b, g) {
  const list = groupsOf(b)[g];
  return Array.isArray(list) ? list : [];
}

/**
 * 功能：取某一组里**用来当默认落点**的状态键（0.8.53）。
 *
 * 说明：⭐ 「待排期 → 转为任务」要把状态从 backlog 组挪出去，落点取该组里
 *      `is_default` 的那一条（没有就取第一条）—— 状态集是**每个项目自配**的，
 *      ⛔ 不写死 `'todo'`（自定义过的项目里它可能根本不存在）。
 * @param {Object} b - 看板响应
 * @param {string} g - 组键
 * @param {string} [fallback] - 该组一个状态都没有时的兜底键
 * @returns {string} 状态键（可能为空串 = 无可用状态）
 */
function stateKeyOfGroup(b, g, fallback) {
  const list = statesOf(b);
  const hit = list.find((s) => String(s.group) === g && Number(s.is_default) === 1) || list.find((s) => String(s.group) === g);
  return hit && hit.key != null ? String(hit.key) : fallback || '';
}

/**
 * 功能：取「未知状态」那一列的任务（状态不在状态集里的老脏状态）。
 * @param {Object} b - 看板响应
 * @returns {Array.<Object>} 任务数组
 */
function unknownOf(b) {
  return b && Array.isArray(b.unknown) ? b.unknown : [];
}

/**
 * 功能：跨五组与「未知状态」列按 id 找一条任务。
 * @param {Object} b - 看板响应
 * @param {*} tid - 任务 id
 * @returns {?Object} 命中的任务行，找不到为 null
 */
function findTask(b, tid) {
  if (!isNum(tid)) return null;
  const id = Number(tid);
  const all = GROUP_ORDER.flatMap((g) => cardsOf(b, g)).concat(unknownOf(b));
  return all.find((t) => Number(t && t.id) === id) || null;
}

/**
 * 功能：流水里的一个状态键 → 能看的名字（认不出原样返回，空值回破折号）。
 * @param {Object} b - 看板响应（借状态集查名字）
 * @param {*} key - 状态键
 * @returns {string} 状态名
 */
function statusLabel(b, key) {
  const k = key == null ? '' : String(key);
  if (!k) return DASH;
  const s = statesOf(b).find((x) => String(x.key) === k);
  return s ? String(s.name || k) : k;
}

/**
 * 功能：按账号 id 在成员名单里找显示名。
 * @param {Object} b - 看板响应
 * @param {*} uid - 账号 id
 * @returns {string} 显示名（找不到回空串）
 */
function memberName(b, uid) {
  if (!isNum(uid)) return '';
  const id = Number(uid);
  const m = membersOf(b).find((x) => Number(x.user_id) === id);
  return m ? String(m.display_name || m.username || '') : '';
}

/**
 * 功能：卡片上的负责人那一格 —— 有 `assignee_id` 就显示对应的成员名，否则「未认领」。
 * @param {Object} b - 看板响应
 * @param {Object} t - 任务卡片
 * @returns {string} 负责人文案
 */
function assigneeText(b, t) {
  if (!t || !isNum(t.assignee_id)) return UNCLAIMED;
  return memberName(b, t.assignee_id) || UNCLAIMED;
}

/**
 * 功能：取一个角标的数字（评论数 / 附件数）—— 本轮字段可能缺失，**缺失按 0**。
 * @param {Object} t - 任务卡片
 * @param {string} key - 字段名（`comment_count` / `file_count`）
 * @returns {number} 数字
 */
function badgeCount(t, key) {
  return numOrZero(t ? t[key] : 0);
}

// ================================================================ 甘特图的小读口

/**
 * 功能：看板里的全部任务（五组 ＋ `unknown`），每条带上它所在的组 —— 甘特图按它排序与筛选。
 * @param {Object} b - 看板响应
 * @returns {Array.<Object>} `[{ t, group }]`
 */
function allBoardTasks(b) {
  const out = [];
  for (const g of GROUP_ORDER) for (const t of cardsOf(b, g)) out.push({ t: t, group: g });
  for (const t of unknownOf(b)) out.push({ t: t, group: GROUP_UNKNOWN });
  return out;
}

/**
 * 功能：当前要显示的那一周的**周一**天序号 —— 没手动翻过（`weekStart` 为空）就是**本周**。
 *
 * 说明：⭐⭐ 2026-10-20：**进来显示的应该是本周**，⛔ 不是「撑到有任务的那一周」。
 *      原来那套「撑周」（为「10 月的周里看不到 9 月的任务」而加的那个函数）有个说不通
 *      的地方：那块页头明明写着 `今天`、列头也标着「今天」那一列，进去却不是本周 ——
 *      用户第一眼看到的日期与「今天」无关，翻周按钮的起点也跟着落在别人的周上。
 *      ⇒ 默认周回到本周；要找别周的任务就用 `« / »` 翻，或点 `今天` 拨回本周。
 *      ⚠️ 只影响「没手动翻过」这一种情况：`weekStart` 一旦有值（翻过周 / 点过今天）就一律听它。
 * @param {Object} st - 状态
 * @returns {number} 周一的天序号
 */
function weekStartOf(st) {
  return st && st.weekStart != null ? st.weekStart : mondayOfIndex(todayIndex());
}

/**
 * 功能：按当前状态算一遍「正在显示的那一周」（翻周按钮「上一周 / 下一周」从它起算）。
 * 说明：⚠️ 翻周的起点必须与画出来的那一个周**同源** —— 否则「显示的是本周」、
 *      而 `«` 却从别的周往回退，用户按一下会跳到毫无关系的一周。
 * @param {Object} st - 状态
 * @returns {number} 当前显示的周一（天序号）
 */
function curWeekStart(st) {
  return weekStartOf(st);
}

/**
 * 功能：两条任务按截止日先后比（没截止日的排最后；先后相同就按 id 稳定排）。
 * @param {Object} a - 任务卡片
 * @param {Object} c - 任务卡片
 * @returns {number} 排序值
 */
function cmpByDue(a, c) {
  const da = dayIndexOf(a && a.due_date);
  const dc = dayIndexOf(c && c.due_date);
  if (da == null && dc == null) return Number(a && a.id) - Number(c && c.id);
  if (da == null) return 1;
  if (dc == null) return -1;
  if (da !== dc) return da - dc;
  return Number(a && a.id) - Number(c && c.id);
}

/**
 * 功能：按当前图例筛选（`all` 之外只看当前在该组的任务）并按截止日排序。
 *
 * 说明：⭐⭐ 0.8.53（待排期单列）：**待排期不进甘特图** —— 它在看板甘特图下面
 *      单独一块列表里（没有日期、可「转为任务」；0.8.54 起从页头下面挪到甘特图下面），所以这里先把它剔掉。
 *      ⚠️ 剔的判据是**组**（`backlog`）而不是状态键：项目状态集是自配的，
 *      落在 backlog 组里的自定义状态同样不该出现在时间轴上。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {Array.<Object>} `[{ t, group }]`
 */
function visibleTasks(st, b) {
  const f = st.filter || 'all';
  let list = allBoardTasks(b).filter((x) => x.group !== 'backlog');
  if (f !== 'all') list = list.filter((x) => x.group === f);
  return list.sort((a, c) => cmpByDue(a.t, c.t));
}

/**
 * 功能：一条任务的横条端点 —— ⭐⭐ 0.8.17 起照任务板的区间语义：
 *      **起点 = `start_date || created_at`**，**终点 = `visEnd(t, s, today)`**。
 *
 * 说明：⭐ 为什么要换口径：原来画的是「创建日 → 截止日」——
 *      一条「上周建的、本周截止」的任务裁到本周就**正好铺满 7 列**（截图里那两根全宽条
 *      「发布」「飞牛上架申请」就是这么来的），看着像样式问题，其实是**口径**产物。
 *      照任务板取 `start_date`（任务日）之后，条才落在它真正该在的那几天上。
 *      ⚠️⭐ 协作的「＋ 新建任务」弹层**不收「任务日」**（只有标题 / 状态 / 负责人 / 截止日 / 描述）
 *      ⇒ 硬切会让所有条退化成 1 天宽的小方块（比改之前更难看）。所以起点保留
 *      **`created_at` 兜底**：有任务日就用任务日，没有就用创建日（老数据的条不至于消失）。
 *      ⚠️ 终点必须套 **`visEnd()`**（已完成止于完成日 / 逾期未完成顺延到今天）—— 判据住在共用层
 *      `core/task.js`，⛔ 别在这边自己写一份。`visEnd()` 收的是**日期字符串**，所以这里把天序号
 *      转回去喂它（`dayText()`，与 `dayIndexOf` 同一个刻度）。
 *      ⚠️ 没有 `due_date` 时保留原来那条「最后一条流水」兜底（协作的任务可以没有截止日）。
 * @param {Object} t - 任务卡片
 * @param {string} [group] - 该任务所在的**组**（`completed` / `cancelled` 两支要用；缺省按普通任务画）
 * @returns {Object} `{ start, end }`（都是**天序号**；都没有时为 `{ start: null, end: null }`）
 */
function barSpanOf(t, group) {
  let start = dayIndexOf((t && (t.start_date || t.created_at)) || '');
  let end = dayIndexOf(t && t.due_date);
  const flow = t && Array.isArray(t.flow) ? t.flow : [];
  let lastFlow = null;
  for (const f of flow) {
    const d = dayIndexOf(f && f.created_at);
    if (d != null && (lastFlow == null || d > lastFlow)) lastFlow = d;
  }
  if (end == null) end = lastFlow;
  if (start == null) start = end;
  if (end == null) end = start;
  if (start != null && end != null && start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  // ⭐⭐ 0.8.17：终点照任务板套 `visEnd()` 截断 / 顺延。
  //    ⚠️⭐ `today` 这一参数**必须传** —— 漏传不报错，只是「逾期顺延到今天」静默失效
  //    。
  //
  // ⚠️⭐ 2026-10-20（本版质检）：`visEnd()` 有两处**不适用于协作看板**，这里按组补两条：
  //    ① **自定义的「已完成」状态**：`visEnd()` → `doneInfo()` 只认 `status === 'done'` 这个**字面量**，
  //       而协作的状态集是**每个项目自配**的——「验收通过」这类 key 落在
  //       `completed` 组里，`doneInfo()` 认不出 ⇒ 条会一直铺到截止日。
  //       ⇒ 已完成的组**直接用 `completed_at` 的日期**（服务端 `collabUpdateTask()` 进完成组时会写它）。
  //    ② **已取消**：作废的任务不该随时间往前长 —— `visEnd()` 只给周期任务免了顺延，
  //       `cancelled` 会一天天长到「今天」，看着像还在推进。⇒ 这一组只画到截止日。
  //    ⛔ 别去改 `core/task.js`：那两处是任务板 / 日历 / 手机端的共用判据，
  //       它们的语义里没有「项目自配状态集」与「作废」这两个协作专有概念。
  if (start != null && end != null) {
    const g = String(group == null ? '' : group);
    /** 终点天序号（三条分支各算各的；`null` = 认不出 ⇒ 保留原 `end`） */
    let ve;
    if (g === 'completed') {
      const doneAt = dayIndexOf(t && t.completed_at);
      // 没有 `completed_at`（老数据）⇒ 回落 `visEnd()` 的老口径（approx 用截止日）
      ve = doneAt != null ? doneAt : dayIndexOf(visEnd(t, dayText(start), dayText(todayIndex())));
      if (ve != null && ve < start) ve = start; // 完成日早于起始日 ⇒ 退回首日（与 visEnd 同一条）
    } else if (g === 'cancelled') {
      ve = dayIndexOf(t && t.due_date);
      if (ve == null) ve = end;
      if (ve != null && ve < start) ve = start;
    } else {
      ve = dayIndexOf(visEnd(t, dayText(start), dayText(todayIndex())));
    }
    if (ve != null && ve >= start) end = ve;
  }
  return { start: start, end: end };
}

// ================================================================ 附件（2f）小读口

/**
 * 功能：附件的上传者显示名 —— 找不到对应成员时用契约 §5 那句「已注销成员」。
 * @param {Object} b - 看板响应
 * @param {*} uid - 上传者账号 id
 * @returns {string} 显示名
 */
function uploaderName(b, uid) {
  return memberName(b, uid) || TXT.goneUser;
}

/**
 * 功能：把字节数裁成一句能看的容量（`1.2 MB` / `345 B`），认不出就回空串。
 * @param {*} v - 字节数
 * @returns {string} 容量文案
 */
function fmtSize(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 功能：取一个文件名的扩展名（小写，认不出回空串）。
 * @param {*} name - 文件名
 * @returns {string} 扩展名
 */
function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i + 1).toLowerCase();
}

/**
 * 功能：文件类型是不是支持的（客户端预挡一次；服务端才是判据）。
 * @param {*} name - 文件名
 * @returns {boolean} 支持则为 true
 */
function extAllowed(name) {
  return FILE_EXTS.indexOf(extOf(name)) >= 0;
}

/**
 * 功能：读当前状态里已经取到的附件清单（还没取到就是空数组）。
 * @param {Object} st - 状态
 * @returns {Array.<Object>} 附件数组
 */
function allFiles(st) {
  return st && Array.isArray(st.files) ? st.files : [];
}

/**
 * 功能：附件挂在哪条流水上（空 ⇒ 0）。
 * @param {Object} f - 附件行
 * @returns {number} 流水 id（没有则 0）
 */
function reportIdOf(f) {
  return f == null || f.report_id == null || f.report_id === '' ? 0 : Number(f.report_id);
}

/**
 * 功能：附件的宿主任务 id（空 ⇒ 0）。
 * @param {Object} f - 附件行
 * @returns {number} 任务 id（没有则 0）
 */
function hostTaskOf(f) {
  return f == null || f.task_id == null || f.task_id === '' ? 0 : Number(f.task_id);
}

/**
 * 功能：附件挂在哪条评论上（空 ⇒ 0）—— ⭐ 2g「附件跟着评论走」的归属判据。
 * @param {Object} f - 附件行
 * @returns {number} 评论 id（没有则 0）
 */
function commentIdOf(f) {
  return f == null || f.comment_id == null || f.comment_id === '' ? 0 : Number(f.comment_id);
}

/**
 * 功能：某条任务的**任务级**附件（不挂在某条流水上的那一拨）。
 * @param {Object} st - 状态
 * @param {*} tid - 任务 id
 * @returns {Array.<Object>} 附件数组
 */
function filesOfTask(st, tid) {
  const id = Number(tid);
  return allFiles(st).filter((f) => reportIdOf(f) === 0 && hostTaskOf(f) === id);
}

/**
 * 功能：挂在某条**流水**上的附件。
 * @param {Object} st - 状态
 * @param {*} rid - 流水 id
 * @returns {Array.<Object>} 附件数组
 */
function filesOfReport(st, rid) {
  const id = Number(rid);
  return allFiles(st).filter((f) => reportIdOf(f) === id);
}

/**
 * 功能：挂在某条**评论**上的附件 —— ⭐ 2g 归属判据：`comment_id` 等于这条评论的 `id`。
 * @param {Object} st - 状态
 * @param {*} cid - 评论 id
 * @returns {Array.<Object>} 附件数组
 */
function filesOfComment(st, cid) {
  const id = Number(cid);
  return allFiles(st).filter((f) => commentIdOf(f) === id);
}

/**
 * 功能：**项目级**附件（既不在任务上、也不在流水上）。
 * @param {Object} st - 状态
 * @returns {Array.<Object>} 附件数组
 */
function filesOfProject(st) {
  return allFiles(st).filter((f) => reportIdOf(f) === 0 && hostTaskOf(f) === 0);
}

/**
 * 功能：⭐ 2g 老附件兜底 —— 没挂评论的那一拨（任务级 / 项目级），归到评论列表最下面的
 *      「其他附件」小块，⛔ 一条都不丢。
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {Array.<Object>} 附件数组
 */
function orphanFilesOf(st, scope) {
  const list = scope === 'task' ? filesOfTask(st, st.cardFor) : filesOfProject(st);
  return list.filter((f) => commentIdOf(f) === 0);
}

/**
 * 功能：某条任务名下的全部附件条数（卡片角标用它就地更新）。
 * @param {Object} st - 状态
 * @param {*} tid - 任务 id
 * @returns {number} 条数
 */
function taskFileCount(st, tid) {
  const id = Number(tid);
  return allFiles(st).filter((f) => hostTaskOf(f) === id).length;
}

/**
 * 功能：我能不能删这个附件 —— ⭐ **上传者自己 ＋ 项目所有者**（与评论刻意不同，方案 §戊-8-1）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @param {Object} f - 附件行
 * @returns {boolean} 能删则为 true
 */
function canDeleteFile(st, b, f) {
  const meId = st && st.me ? st.me.id : null;
  const mine = isNum(meId) && isNum(f && f.uploader_id) && Number(f.uploader_id) === Number(meId);
  const owner = !!(b && b.project && b.project.role === 'owner');
  return mine || owner;
}

/**
 * 功能：页头那句「已完成 n / 共 m」。
 * @param {Object} b - 看板响应
 * @returns {string} 进度文案
 */
function progressText(b) {
  const p = b && b.progress ? b.progress : {};
  return '已完成 ' + numOrZero(p.done) + ' / 共 ' + numOrZero(p.total);
}

/**
 * 功能：细进度条的百分比（`total` 为 0 时画 0%）。
 * @param {Object} b - 看板响应
 * @returns {number} 0~100 的整数
 */
function progressPct(b) {
  const p = b && b.progress ? b.progress : {};
  const total = numOrZero(p.total);
  if (total <= 0) return 0;
  const v = Math.round((numOrZero(p.done) / total) * 100);
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// ================================================================ 状态

/**
 * 功能：建一份本片段自己的状态（一次挂载一份，重画不丢弹层开合）。
 * @param {Object} ctx - 槽的挂载上下文
 * @returns {Object} 状态对象
 */
function createState(ctx) {
  return {
    me: (ctx && ctx.me) || null,
    // ⚠️ 宿主把「点开的是哪一条」写进 ctx.collabPid（左栏条目的 key = 项目 id 字符串）
    pid: ctx && ctx.collabPid != null ? String(ctx.collabPid) : '',
    board: null,
    boardErr: '',
    statusOpen: false,
    taskOpen: false,
    transferOpen: false,
    addOpen: false,
    // ⭐ 本轮：成员块收成一颗按钮，点开这颗弹层里**显示和设置**成员
    membersOpen: false,
    // ⭐ 本轮：甘特图顶部状态图例当前选中的那一组（`all` = 全部）
    filter: 'all',
    // ⭐ 本轮：周视图当前翻到的那个**周一**（天序号）；为空 ⇒ 跟着「今天」走（本周）
    weekStart: null,
    // ⭐ 0.8.17：点列选中的那一天（**天序号**；`-1` = 没选）。
    //    ⚠️ 它只驱动**列头高亮**（就地改 class，⛔ 不换屏、不重画整块）—— 不参与筛选。
    selected: -1,
    // ⭐ 2d：点卡片开的那张「任务详情」弹层（评论 ＋ 活动都在它里面）
    cardFor: 0,
    // ⭐ 0.8.53：待排期列表里点【转为任务】开的那条任务（0 = 没开）
    promoteFor: 0,
    // ⭐ 0.8.54：待排期列表里点 ✕ 要删的那条任务（0 = 没开确认弹层）
    delFor: 0,
    cardComments: null,
    cardCommentsErr: '',
    cardActivity: null,
    cardActivityErr: '',
    // ⭐ 2d：页头那两颗（项目级评论 / 整项目流水）
    commentsOpen: false,
    projComments: null,
    projCommentsErr: '',
    activityOpen: false,
    projActivity: null,
    projActivityErr: '',
    // ⭐ 2f：项目的全部附件（`files === null` 表示还没取到）＋ 每成员用量（`used`）
    files: null,
    used: {},
    filesErr: '',
    // ⭐ 2g：输入条里选好、**发送前不发请求**的待传文件（点 `发送` 才先建评论再挂上去）
    pending: [],
    friends: null,
    friendErr: '',
    busy: false,
    // ⭐ 2026-10-20（本版质检）：看板取数的**请求序号** —— 每发一次自增，`await` 回来只有
    //    「我还是最新那一趟」才允许写 `st.board`。没有它，「连点两次重试」或「取数途中改了状态」
    //    这种并发下，**后 resolve 的旧快照会盖掉新状态**（进度条 / 分组 / 💬 n 退回旧值，
    //    刷新之后才对 —— 典型的「看着像没保存」）。⚠️ `desktop.js` 的会话消息用
    //    `activeConvId` 做同一件事，这里是它在本片段的对应物。
    seq: 0,
  };
}

// ================================================================ 取数

/**
 * 功能：取一次看板（一次到位）并重画。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadBoard(root, st) {
  // ⚠️⭐ 2026-10-20：带序号取数 —— 慢回来的旧响应不许盖掉新状态（见 `createState().seq` 的说明）
  const my = ++st.seq;
  st.board = null;
  st.boardErr = '';
  paint(root, st);
  if (!st.pid) {
    st.boardErr = '没拿到要打开的项目编号';
    paint(root, st);
    return;
  }
  let data = null;
  let err = '';
  try {
    data = await api('GET', '/api/collab/projects/' + st.pid + '/board');
  } catch (e) {
    err = msgOf(e);
  }
  if (my !== st.seq) return; // 已经有更新的一趟在跑 / 跑完了 ⇒ 这一次的结果作废
  st.board = data;
  st.boardErr = err;
  paint(root, st);
}

/**
 * 功能：只重取看板（写操作成功后的收尾），不动别的东西。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function reloadBoard(root, st) {
  // ⚠️ 同 `loadBoard()`：带序号，慢回来的旧快照不许盖掉新状态
  const my = ++st.seq;
  let data = null;
  let err = '';
  try {
    data = await api('GET', '/api/collab/projects/' + st.pid + '/board');
  } catch (e) {
    err = msgOf(e);
  }
  if (my !== st.seq) return;
  if (err) toast(err, true);
  else {
    st.board = data;
    st.boardErr = '';
    // ⚠️⭐ 2026-10-20：**角色降级要收掉仅所有者的弹层** —— 另一个标签页把项目转让给别人之后，
    //    本页会走 `visibilitychange → reloadBoard()`；原先 `statusOpen` / `transferOpen` /
    //    `addOpen` 原样留着 ⇒ 弹层还在、还能编辑，一保存就弹服务端 404（「看着能用，其实不能用」）。
    if (st.board && st.board.project && st.board.project.role !== 'owner') {
      st.statusOpen = false;
      st.transferOpen = false;
      st.addOpen = false;
    }
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

// ================================================================ 取数（评论 / 活动）

/**
 * 功能：取一轮评论并写进状态（`scope` = `task` 取该任务、`proj` 取项目级）。
 * 说明：⚠️ 只是取数，画界面由 `fillComments()` 单独做 —— 这样「发 / 删」后能只换那一块，
 *      ⛔ 不去重取整个看板（避免整屏闪一下）。
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {Promise.<void>}
 */
async function loadComments(st, scope) {
  const isTask = scope === 'task';
  try {
    const q = isTask ? '?task_id=' + Number(st.cardFor) : '';
    const r = await api('GET', '/api/collab/projects/' + st.pid + '/comments' + q);
    const items = Array.isArray(r && r.items) ? r.items : [];
    if (isTask) {
      st.cardComments = items;
      st.cardCommentsErr = '';
    } else {
      st.projComments = items;
      st.projCommentsErr = '';
    }
  } catch (e) {
    if (isTask) {
      st.cardComments = null;
      st.cardCommentsErr = msgOf(e);
    } else {
      st.projComments = null;
      st.projCommentsErr = msgOf(e);
    }
  }
}

/**
 * 功能：取**这一条任务**的流水。
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadTaskActivity(st) {
  try {
    const r = await api('GET', '/api/collab/projects/' + st.pid + '/tasks/' + Number(st.cardFor) + '/activity');
    st.cardActivity = Array.isArray(r && r.items) ? r.items : [];
    st.cardActivityErr = '';
  } catch (e) {
    st.cardActivity = null;
    st.cardActivityErr = msgOf(e);
  }
}

/**
 * 功能：取**整个项目**的流水。
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadProjectActivity(st) {
  try {
    const r = await api('GET', '/api/collab/projects/' + st.pid + '/activity');
    st.projActivity = Array.isArray(r && r.items) ? r.items : [];
    st.projActivityErr = '';
  } catch (e) {
    st.projActivity = null;
    st.projActivityErr = msgOf(e);
  }
}

// ================================================================ 取数（附件）

/**
 * 功能：取一次项目的附件清单与每成员用量（`GET .../files` ⇒ `{items, used}`）。
 *
 * 说明：⚠️ 只取附件，不碰看板 —— 上传 / 删除后只重取这一块（避免整屏闪一下）。
 *      `used` 是「每个成员上传了多少」（uid ⇒ 字节）；⭐ 只统计、不限额（方案 §戊-8-2）。
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function loadFiles(st) {
  if (!st.pid) {
    st.files = [];
    st.used = {};
    st.filesErr = '';
    return;
  }
  try {
    const r = await api('GET', '/api/collab/projects/' + st.pid + '/files');
    st.files = Array.isArray(r && r.items) ? r.items : [];
    st.used = r && r.used && typeof r.used === 'object' ? r.used : {};
    st.filesErr = '';
  } catch (e) {
    st.files = null;
    st.used = {};
    st.filesErr = msgOf(e);
  }
}

/**
 * 功能：附件还没取到时补取一次（开弹层时用），取完只补相关的那几块。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function ensureFiles(root, st) {
  // ⚠️⭐ 2026-10-20（本版质检）：这里原来写的是 `if (st.files !== null || st.filesErr) return;` ——
  //    一旦**取附件失败过一次**，`filesErr` 就把它自己锁死：之后再开任务卡片 / 评论弹层 /
  //    成员弹层都不会重取（而唯一能清掉错误的那条路是「上传或删除一个附件」，可附件区本身
  //    正显示着错误句、连文件框都没有）⇒ 网络恢复之后只能**退出看板再重进**。
  //    现在：`filesErr` 时**允许重试**（每次开弹层试一次，失败就再显示同一句错误，不会更坏）。
  if (st.files !== null && !st.filesErr) return;
  st.filesErr = '';
  loadFiles(st).then(() => {
    fillUsage(root, st);
    if (st.cardFor) fillFileArea(root, st, 'task');
    if (st.commentsOpen) fillFileArea(root, st, 'proj');
    if (st.activityOpen) fillFileArea(root, st, 'proj');
  });
}

// ================================================================ 写操作（评论）

/**
 * 功能：发一条评论（任务级带 `task_id`、项目级不带）—— ⭐ 2g：若有待传附件，**先建评论拿 id**，
 *      再对每个待传文件 `POST .../files?comment_id=<id>` 把附件挂到这条评论下，最后刷新评论列表。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {Promise.<void>}
 */
async function sendComment(root, st, scope) {
  if (st.busy) return;
  const isTask = scope === 'task';
  const box = root.querySelector(isTask ? '[data-role="task-comment-input"]' : '[data-role="proj-comment-input"]');
  const body = box ? String(box.value == null ? '' : box.value).trim() : '';
  const pend = Array.isArray(st.pending) ? st.pending.slice() : [];
  if (!body) {
    toast(TXT.needBody, true);
    return;
  }
  st.busy = true;
  let created = false;
  try {
    const payload = { body: body };
    if (isTask) payload.task_id = Number(st.cardFor);
    const r = await api('POST', '/api/collab/projects/' + st.pid + '/comments', payload);
    created = true;
    const cid = r && r.item && r.item.id != null ? Number(r.item.id) : 0;
    for (const f of pend) {
      let q = '?name=' + encodeURIComponent(String(f.name == null ? '' : f.name));
      if (isTask) q += '&task_id=' + encodeURIComponent(String(Number(st.cardFor)));
      q += '&comment_id=' + encodeURIComponent(String(cid));
      try {
        await rawSend('POST', '/api/collab/projects/' + st.pid + '/files' + q, f, {
          'Content-Type': 'application/octet-stream',
        });
      } catch (e) {
        // ⚠️ 评论已经建好了：一个附件挂了不把整条评论回滚，只把这一句响出来（其余照传）。
        toast(msgOf(e), true);
      }
    }
  } catch (e) {
    toast(msgOf(e), true);
  }
  // ⚠️ 评论建成功后就清空输入与待传文件（即便某个附件没传上，也⛔ 不留下「再点一次又建一条」的坑）。
  if (created) {
    if (box) box.value = '';
    st.pending = [];
    if (pend.length) await loadFiles(st);
    await loadComments(st, scope);
    fillPending(root, st);
    if (pend.length) afterFilesChanged(root, st);
    fillComments(root, st, scope);
    if (isTask) syncCommentCount(root, st);
  }
  st.busy = false;
}

/**
 * 功能：删一条自己发的评论（服务端越权会 404）—— ⭐ 2g：删评论连带的附件也一并没了，
 *      所以顺便重取一次附件并只补相关的那几块。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} cid - 评论 id
 * @param {string} scope - `task` 或 `proj`
 * @returns {Promise.<void>}
 */
async function deleteComment(root, st, cid, scope) {
  if (st.busy) return;
  const id = Number(cid);
  if (!Number.isInteger(id) || id <= 0) return;
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/comments/' + id);
    await loadFiles(st);
    await loadComments(st, scope);
    afterFilesChanged(root, st);
    fillComments(root, st, scope);
    if (scope === 'task') syncCommentCount(root, st);
  } catch (e) {
    toast(delErrText(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：⭐ 2g —— 在输入条先选文件：只攒进 `st.pending`（本地预挡类型 / 大小），
 *      **发送前不发任何请求**，选中的文件显示成输入条上方可移除的 chips。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {HTMLElement} input - 被选完的那个 `<input type="file">`
 * @returns {void}
 */
function addPendingFiles(root, st, input) {
  if (!input || !input.files || !input.files.length) return;
  if (!Array.isArray(st.pending)) st.pending = [];
  let reject = '';
  for (const f of Array.from(input.files)) {
    const name = String(f.name == null ? '' : f.name);
    if (!extAllowed(name)) {
      reject = TXT.badType;
      continue;
    }
    if (numOrZero(f.size) > FILE_MAX_BYTES) {
      reject = TXT.tooBig;
      continue;
    }
    st.pending.push(f);
  }
  input.value = '';
  if (reject) toast(reject, true);
  fillPending(root, st);
}

/**
 * 功能：从一个待传 chip 上撤掉那个文件（⛔ 不再发请求）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} idx - 在该档 pending 数组里的下标
 * @returns {void}
 */
function removePending(root, st, idx) {
  const i = Number(idx);
  if (!Array.isArray(st.pending) || !Number.isInteger(i) || i < 0 || i >= st.pending.length) return;
  st.pending.splice(i, 1);
  fillPending(root, st);
}

// ================================================================ 写操作（附件）

/**
 * 功能：发一个**二进制**请求并解析响应 —— 附件上传走它（体积大，不走 JSON 的 `api()`）。
 *
 * 说明：⚠️ 401 与失败一律照 `api()` 的口径处理（401 回登录页；非 2xx 抛服务端原话）。
 * @param {string} method - HTTP 方法
 * @param {string} path - 应用内绝对路径
 * @param {*} body - 请求体（这里是一个 `File`）
 * @param {Object} headers - 请求头
 * @returns {Promise.<?Object>} 解析后的响应 JSON
 * @throws {Error} 401 / 非 2xx 时抛出
 */
async function rawSend(method, path, body, headers) {
  const r = await fetch(BASE + path, { method: method, headers: headers || {}, body: body });
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
  return j;
}

/**
 * 功能：上传一个附件 —— 二进制走 body、元数据走**查询串**（契约 §4）。
 *
 * 说明：⚠️ 先做一次客户端预挡（类型 / 大小），服务端才是判据；成功后**只重取附件那一块**。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {HTMLElement} input - 被选完的那个 `<input type="file">`
 * @returns {Promise.<void>}
 */
async function uploadFile(root, st, input) {
  if (st.busy) return;
  const f = input && input.files && input.files[0];
  if (!f) return;
  const name = String(f.name == null ? '' : f.name);
  if (!extAllowed(name)) {
    toast(TXT.badType, true);
    input.value = '';
    return;
  }
  if (numOrZero(f.size) > FILE_MAX_BYTES) {
    toast(TXT.tooBig, true);
    input.value = '';
    return;
  }
  const ds = input.dataset || {};
  let q = '?name=' + encodeURIComponent(name);
  if (isNum(ds.task)) q += '&task_id=' + encodeURIComponent(String(Number(ds.task)));
  if (isNum(ds.report)) q += '&report_id=' + encodeURIComponent(String(Number(ds.report)));
  st.busy = true;
  try {
    await rawSend('POST', '/api/collab/projects/' + st.pid + '/files' + q, f, {
      'Content-Type': 'application/octet-stream',
    });
    await loadFiles(st);
    afterFilesChanged(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
    if (input) input.value = '';
  }
}

/**
 * 功能：删一个附件（服务端判：上传者自己 ＋ 项目所有者）—— 成功后只重取附件那一块。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} fid - 附件 id
 * @returns {Promise.<void>}
 */
async function deleteFile(root, st, fid) {
  if (st.busy) return;
  const id = Number(fid);
  if (!Number.isInteger(id) || id <= 0) return;
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/files/' + id);
    await loadFiles(st);
    afterFilesChanged(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：下载一个附件 —— 用一次临时 `<a>` 点击（⛔ 不开新窗口内联渲染）。
 *
 * 说明：⚠️ 服务端那条路带 `Content-Disposition: attachment`（方案 §戊-7），所以浏览器**只下载**、
 *      ⛔ 不会把 PDF / HTML 内联画出来；这里**刻意不加** `download` 属性（文件名由服务端那个头给）。
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

// ================================================================ 写操作（成员）

/**
 * 功能：所有者把一个好友加进项目。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function addMember(root, st) {
  if (st.busy) return;
  const sel = root.querySelector('.collab-add [data-role="friend"]');
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
 * 说明：⚠️ 移出**只置 `shared = 0`、不清成员名单** —— 重新加回来成员照旧看得见。
 *      移出后这个项目不再属于协作 ⇒ 宿主会把它从左栏「协作项目」组里去掉，
 *      所以这里先请**登记器**（`desktop-teamwork-page.js`）重取项目列表，
 *      再请**宿主**把这块看板关掉、把主区还给真会话（两个方向各一个留白事件）。
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

// ================================================================ 写操作（任务 / 状态 / 转让）

/**
 * 功能：从当前弹层里读一个控件的值（取不到回空串）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {string} sel - 选择器
 * @returns {string} 控件值
 */
function fieldValue(root, sel) {
  const el = root.querySelector(sel);
  return el ? String(el.value == null ? '' : el.value) : '';
}

/**
 * 功能：把一条周期规则折成**可比较的字符串**（判「用户到底改没改任务类型」用）。
 *
 * 说明：⚠️ 库里存的是规范化 JSON **文本**、编辑器读回来的是对象 ⇒ 直接比对象永远不等；
 *      这里用 `parseRule()`（共用层的唯一解析口）把两边都折成同一形状再比。
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
 * 功能：新建任务 —— 弹层里的标题 / 状态 / 负责人 / 任务日与截止日 / **任务类型** / 描述
 *      ⇒ `POST .../tasks`。
 *
 * 说明：⭐⭐ 0.8.53：状态落在 **backlog 组（待排期）** 时**日期与类型整块不发**
 *      （服务端对 backlog 组也不写日期，见 `collabAddTask()`）—— 待排期就是「还没排期」；
 *      要排期走待排期列表里那条【转为任务】。
 *      ⚠️ 窗口任务的两个时刻必填、同一天要比先后（与任务板同一套前置校验）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function createTask(root, st) {
  if (st.busy) return;
  const title = fieldValue(root, '.collab-modal-task [data-role="title"]').trim();
  if (!title) {
    toast('请填写任务标题', true);
    return;
  }
  const sel = root.querySelector('.collab-modal-task [data-role="status"]');
  const opt = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
  const group = opt ? String(opt.dataset.group || '') : '';
  const backlog = group === 'backlog';
  const status = sel ? String(sel.value == null ? '' : sel.value).trim() : '';
  const assignee = fieldValue(root, '.collab-modal-task [data-role="assignee"]').trim();
  const desc = fieldValue(root, '.collab-modal-task [data-role="desc"]');
  const body = { title: title, description: desc };
  if (status) body.status = status;
  if (!backlog) {
    const start = fieldValue(root, '.collab-modal-task [data-role="start"]').trim();
    const due = fieldValue(root, '.collab-modal-task [data-role="due"]').trim();
    if (!start || !due) {
      toast('请选择任务日与截止日期', true);
      return;
    }
    if (start > due) {
      toast('任务日不能晚于截止日期', true);
      return;
    }
    const kf = readKindFields('tk');
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
  const aid = Number(assignee);
  if (assignee && Number.isInteger(aid) && aid > 0) body.assignee_id = aid;
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/tasks', body);
    toast('已新建任务');
    st.taskOpen = false;
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
 * 说明：⭐⭐ 0.8.53（待排期可以转为任务，类似随手记，转的时候选任务类型和日期时间）：
 *      · 状态落到「未开始」组里那条默认状态（`stateKeyOfGroup()`，⛔ 不写死 `todo`）；
 *      · 日期与类型**一次发全**：`start_time` / `due_time` / `recur_rule` 按类型给空串或 null，
 *        否则「周期改回普通」会留着上一次的循环规则（服务端 `allowedCols` 认这四列，改得动）；
 *      · 服务端 `collabUpdateTask()` 对「迁出 backlog」不清日期 —— 正好，这里就是要它落日期。
 *      ⚠️ 窗口任务的两个时刻必填（同一天还要比先后），⛔ 不靠服务端 400 兜底。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function promoteTask(root, st) {
  if (st.busy) return;
  const t = findTask(st.board, st.promoteFor);
  if (!t) return;
  const box = root.querySelector('.collab-modal-promote');
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
 * 功能：任务详情弹层里那颗「保存」—— 读六格（标题 / 描述 / 任务日 / 截止日 / 状态 / 负责人），
 *      **只发改动过的字段**。
 *
 * 说明：⚠️ 负责人选回「未认领」（空值）**不发**（服务端把空值当「回落所有者」，那会静默改库）；
 *      改状态会写一条流水 ⇒ 保存后顺便把该任务的流水重取一遍（评论那块不动）。
 *      ⚠️⭐ 日期两格**绑定在一起**：任一改动就两个都发（见 `cardModalHtml()` 的说明 ——
 *      服务端只在「两个都在请求里」时才比区间）。
 *      ⚠️ 标题**空着不发**：服务端对「带了但是空」一律 400（`任务标题不能为空`），
 *      与其发一趟再弹错误，不如在前端先说人话。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function saveCard(root, st) {
  if (st.busy) return;
  const t = findTask(st.board, st.cardFor);
  if (!t) return;
  const card = root.querySelector('.collab-modal-card');
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
  // ---- 状态 / 负责人：沿用原来的两条口径（空值不发、未知状态不发）
  const sEl = card.querySelector('[data-role="card-status"]');
  const aEl = card.querySelector('[data-role="card-assignee"]');
  // ⭐⭐ 0.8.53：**保存后的组**决定「日期与类型要不要发」——
  //    落进 backlog 组（待排期）＝ 还没排期：日期由服务端清空、类型也不该带着，
  //    否则一条待排期任务会在库里留着日期/循环规则，转任务时又冒出来。
  const curState = statesOf(st.board).find((s) => String(s.key) === String(t.status == null ? '' : t.status));
  const curGroup = curState ? String(curState.group || '') : '';
  const selOpt = sEl && sEl.selectedOptions ? sEl.selectedOptions[0] : null;
  const nextGroup = selOpt && !sEl.disabled ? String(selOpt.dataset.group || '') : curGroup;
  const backlog = nextGroup === 'backlog';
  if (!backlog) {
    // ---- 日期区间：任一改动就**两个一起发**（局部更新时服务端不替你比大小）
    const start = val('card-start');
    const due = val('card-due');
    if (start !== date10Of(t.start_date) || due !== date10Of(t.due_date)) {
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
  // ⚠️⭐ 2026-10-20（本版质检）：状态**只发一个真的选中的状态键**。
  //    病根在 `cardStatusPickHtml()`：任务的状态**不在这个项目的状态集里**（老脏数据 / 状态被删过）时，
  //    下拉里会多出一项 `value=""` 的占位（写着「未知状态」），而它带着 `selected` ⇒ 下拉的 `value` 是空串。
  //    原先的判据只比「与 `data-init` 是否相等」（`data-init` 是那个未知键）⇒ 空串 ≠ 未知键 ⇒
  //    **误判成「用户改过」**，于是把 `status: ''` 发出去，服务端照单全收、把那条任务的真实状态**静默抹成空**。
  //    症状：打开一条老任务、什么都不改、点「保存」⇒ 它从「未知状态」列掉进「未开始」组（空状态被判成 unstarted）。
  //    ⇒ 空值一律**不发**（与「负责人选未认领不发」同一条口径：空值在服务端有别的含义）。
  if (
    sEl &&
    !sEl.disabled &&
    String(sEl.value == null ? '' : sEl.value) !== '' &&
    String(sEl.value) !== String(sEl.dataset.init || '')
  ) {
    body.status = String(sEl.value);
  }
  if (aEl && aEl.value !== (aEl.dataset.init || '') && aEl.value !== '') body.assignee_id = Number(aEl.value);
  if (!Object.keys(body).length) return;
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + st.pid + '/tasks/' + Number(t.id), body);
    toast('已更新');
    await reloadBoard(root, st);
    await loadTaskActivity(st);
    fillActivity(root, st, 'task');
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：新增一个状态（`POST .../states { name, color, group }`，仅所有者）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function addState(root, st) {
  if (st.busy) return;
  const name = fieldValue(root, '.collab-modal-state [data-role="newname"]').trim();
  if (!name) {
    toast('请填写状态名', true);
    return;
  }
  const group = fieldValue(root, '.collab-modal-state [data-role="newgroup"]').trim();
  const color = fieldValue(root, '.collab-modal-state [data-role="newcolor"]').trim();
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/states', {
      name: name,
      group: group,
      color: color,
    });
    await reloadBoard(root, st);
    return;
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
  paint(root, st);
}

/**
 * 功能：改一个状态（`PUT .../states/:sid { name, color, group }`，仅所有者）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {HTMLElement} btn - 被点的「保存」按钮（它的那一行就是取值的范围）
 * @returns {Promise.<void>}
 */
async function saveState(root, st, btn) {
  if (st.busy) return;
  const row = btn && btn.closest ? btn.closest('.collab-strow') : null;
  if (!row) return;
  const nameEl = row.querySelector('[data-role="name"]');
  const colorEl = row.querySelector('[data-role="color"]');
  const groupEl = row.querySelector('[data-role="group"]');
  const name = nameEl ? String(nameEl.value == null ? '' : nameEl.value).trim() : '';
  if (!name) {
    toast('请填写状态名', true);
    return;
  }
  const sid = Number(btn.dataset ? btn.dataset.sid : 0);
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + st.pid + '/states/' + sid, {
      name: name,
      group: groupEl ? String(groupEl.value || '') : '',
      color: colorEl ? String(colorEl.value || '') : '',
    });
    await reloadBoard(root, st);
    return;
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
  paint(root, st);
}

/**
 * 功能：删一个状态（`DELETE .../states/:sid`，仅所有者）。
 *
 * 说明：⚠️ 服务端会用 400 拒绝三种删（有任务在用 / 默认状态 / 每组最后一个）——
 *      **必须把那句原话显示出来**，⛔ 不许自己换一句话、⛔ 不许静默。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {HTMLElement} btn - 被点的「删除」按钮
 * @returns {Promise.<void>}
 */
async function deleteState(root, st, btn) {
  if (st.busy) return;
  const sid = Number(btn && btn.dataset ? btn.dataset.sid : 0);
  st.busy = true;
  try {
    await api('DELETE', '/api/collab/projects/' + st.pid + '/states/' + sid);
    await reloadBoard(root, st);
    return;
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
  paint(root, st);
}

/**
 * 功能：把项目**转让**给一个成员（`POST .../transfer { user_id }`，仅所有者）。
 *
 * 说明：⭐ 已设的负责人全不变、⛔ 不动成员名单；转让成功后我在这个项目里的角色会变，
 *      所以看板要重取，并请**登记器**重取项目列表（左栏那个角色副标题跟着变）。
 *
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function transferProject(root, st) {
  if (st.busy) return;
  const raw = fieldValue(root, '.collab-modal-transfer [data-role="target"]').trim();
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid < 1) {
    toast('先选一个人', true);
    return;
  }
  st.busy = true;
  try {
    await api('POST', '/api/collab/projects/' + st.pid + '/transfer', { user_id: uid });
    st.transferOpen = false;
    toast('已转让');
    document.dispatchEvent(new CustomEvent('zx:teamwork-collab-refresh'));
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  } finally {
    st.busy = false;
  }
}

// ================================================================ 画界面：看板

/**
 * 功能：看板页头 —— 进度文案 + 细进度条 /【协作成员管理】/（所有者）⚙ 状态 / 评论 / 活动。
 *      ⚠️ 起「新建任务」不在这排了 —— 改成右下角悬浮的 ＋（见 `fabHtml()`）。
 *
 * 说明：⚠️ 项目名与「← 返回」**不在这里** —— 它们由宿主画在 `#teamwork-conv-head`
 *      （与插槽会话同一个位置感，见 `teamwork/desktop.js` 的 `renderTeamworkHead()`）。
 * @param {Object} b - 看板响应
 * @returns {string} 页头 HTML
 */
/**
 * 功能：看板页头 —— 第一行「进度 ＋ 翻周」、第二行那一排按钮（成员 / 状态 / 评论 / 活动）。
 *
 * 说明：⭐⭐ 0.8.17：翻周那一行（`weekNavHtml()`）**并进页头**（第一行的右半）——
 *      同一屏从此只剩一处翻周；版式照任务板页头 `« 区间 » 今天` 的位置感（左进度、右翻周）。
 *      它自己那三个 `data-act` 与委托分支原样不动（只搬家，⛔ 不改键名）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 页头 HTML
 */
function boardHeadHtml(st, b) {
  const owner = !!(b && b.project && b.project.role === 'owner');
  return (
    '<div class="collab-board-head">' +
    '<div class="collab-head-top">' +
    '<div class="collab-progress">' +
    '<span class="collab-progress-text">' +
    esc(progressText(b)) +
    '</span>' +
    '<span class="collab-progress-bar"><i class="collab-progress-fill" style="width:' +
    progressPct(b) +
    '%"></i></span>' +
    '</div>' +
    weekNavHtml(st) +
    '</div>' +
    '<div class="collab-board-btns">' +
    '<button class="collab-btn" type="button" data-act="collab-members-open">协作成员管理</button>' +
    (owner ? '<button class="collab-btn" type="button" data-act="collab-state-open">⚙ 状态</button>' : '') +
    '<button class="collab-btn" type="button" data-act="collab-comments-open">💬 ' +
    esc(TXT.comment) +
    '</button>' +
    '<button class="collab-btn" type="button" data-act="collab-activity-open">' +
    esc(TXT.activity) +
    '</button>' +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：**右下角悬浮的 ＋**（新建任务）—— 与任务板 `#btn-new-task` / 首页看板那颗 **逐字同款**。
 *
 * 说明：⭐⭐ 2026-10-23（「变为和首页一样的悬浮图标，两端都是」）：从页头按钮排里挪出来，
 *      直接复用宿主的 `.btn-fab` ＋ `.btn-fab-float`（54px 圆 / `fixed` / 距右 32 / 距底 28 / z 30）
 *      —— ⛔ 别再单写一份色值（能借宿主组件就借）。
 *      ⚠️ 它仍住在看板片段里（⛔ 不挪到宿主）：宿主切走时整块 `hidden`，`display: none` 会连带
 *      收掉里面的 `fixed` 孩子（照任务板 `.btn-fab-float` 那条已知坑）⇒ 不必再补一处
 *      「哪一屏该显示哪颗 ＋」的判据。
 *      文案在 `title` / `aria-label` 上（⛔ 别往按钮里补文字 —— 那会把图标覆盖成一句话）。
 * @returns {string} 那颗按钮的 HTML
 */
function fabHtml() {
  return '<button class="btn-fab btn-fab-float" type="button" data-act="collab-task-open" title="新建任务" aria-label="新建任务">＋</button>';
}

/**
 * 功能：成员名单**一行一个**（名字 ＋ `我`/`发起人` 标记 ＋（所有者）右侧「移出」）。
 * 说明：⭐ 本轮要求「排版好看一点」⇒ 从挤在一排的 chips 改成逐行列表，层级清楚。
 *      ⚠️⭐ 2026-10-20（本版质检）：**「发起人」标记看的是「这一行是不是名单第一行」**
 *      （服务端 `collabMembers()` 恒把所有者排在第一位，见 `[owner].concat(members)`），
 *      ⛔ 不是「这一行是不是我自己」。原先写的是 `owner && isMe` ⇒ 两处错：
 *      ① 普通成员打开成员弹层，**永远看不到谁是发起人**（他看不到任何标记）；
 *      ② 所有者自己那一行同时挂着「我」与「发起人」，而真正的发起人标记本该与「我」无关。
 *      手机端 `memberRowHtml(m, i === 0, …)` 一直用的是「第一行」口径 —— 两端必须逐字同源。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 成员行 HTML
 */
function memberRowsHtml(st, b) {
  const meId = st.me && st.me.id;
  const owner = !!(b && b.project && b.project.role === 'owner');
  return membersOf(b)
    .map((m, i) => {
      const isMe = isNum(meId) && Number(m.user_id) === Number(meId);
      // ⭐ 第一行 ＝ 项目所有者（服务端保证的顺序）—— 与手机端同一个判据
      const isFounder = i === 0 || String(m.role || '') === 'owner';
      let tags = '';
      if (isMe || isFounder) {
        tags =
          '<span class="collab-mrow-tags">' +
          (isMe ? '<i class="collab-mem-tag">我</i>' : '') +
          (isFounder ? '<i class="collab-mem-tag">发起人</i>' : '') +
          '</span>';
      }
      return (
        '<div class="collab-mrow">' +
        '<b class="collab-mrow-name">' +
        esc(m.display_name || m.username || '') +
        '</b>' +
        '<span class="collab-mrow-sp"></span>' +
        tags +
        (owner && !isMe && !isFounder
          ? '<button class="collab-mem-x" type="button" data-act="collab-remove-member" data-uid="' +
            esc(String(m.user_id)) +
            '">移出</button>'
          : '') +
        '</div>'
      );
    })
    .join('');
}

/**
 * 功能：上传用量那一行的内容 —— `上传用量` ＋ 逐成员「名字 大小」（方案 §戊-8-2：只统计、不限额）。
 * 说明：⚠️ 上传者不在成员名单里（已注销）时显示 `已注销成员`；⭐ 没有任何用量时**整行不画**（回空串）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 用量内容 HTML（没用量 / 还没取到就是空串）
 */
function usageInnerHtml(st, b) {
  if (st.filesErr) return '<div class="collab-hint err">' + esc(st.filesErr) + '</div>';
  if (st.files === null) return '';
  const used = st.used && typeof st.used === 'object' ? st.used : {};
  const uids = Object.keys(used).filter((k) => numOrZero(used[k]) > 0);
  if (!uids.length) return '';
  let body = '<span class="collab-usage-label">' + esc(TXT.usage) + '</span>';
  for (const k of uids) {
    body +=
      '<span class="collab-usage-item"><b>' + esc(uploaderName(b, k)) + '</b> ' + esc(fmtSize(used[k])) + '</span>';
  }
  return body;
}

/**
 * 功能：用量块 —— 包一层容器（`data-role="collab-usage"` 供上传后**就地更新**）；
 *      ⭐ 没有用量时整块不画（回空串），⛔ 不再给破折号。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 用量块 HTML
 */
function usageBlockHtml(st, b) {
  const inner = usageInnerHtml(st, b);
  if (!inner) return '';
  return '<div class="collab-usage" data-role="collab-usage">' + inner + '</div>';
}

/**
 * 功能：成员区那一块 —— 没展开时是一颗「＋ 加成员」，展开后是好友下拉 + 添加 / 取消。
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
 * 功能：看板正文 —— 页头 ＋ 一张甘特图 ＋ **待排期列表**（`unknown` 的任务也照画，只是没有横条颜色归属）。
 *
 * 说明：⭐⭐ 0.8.53（待排期单列）：待排期任务**不在甘特图上** —— 甘特图下面单独一块列表
 *      （⭐ 0.8.54 起从页头下面挪到这里），
 *      没有日期，每条可以「转为任务」（选任务类型与日期时间），见 `backlogHtml()`。
 * @param {Object} st - 状态
 * @returns {string} 看板 HTML
 */
function boardHtml(st) {
  if (st.boardErr) {
    return (
      '<div class="collab-hint err">' +
      esc(st.boardErr) +
      ' <button class="collab-btn ghost" type="button" data-act="collab-board-reload">重试</button></div>'
    );
  }
  if (!st.board) return '<div class="collab-hint">正在读取看板…</div>';
  const b = st.board;
  // ⭐ 0.8.54（「待排期应该显示在任务下面」）：待排期那块从**页头下面**
  //    挪到**甘特图下面** —— 主视图（任务）在上、待排期（还没排期的）在下。
  //    ⚠️ 只改拼接顺序，`backlogHtml()` 本身一个字没动。
  return '<div class="collab-board">' + boardHeadHtml(st, b) + ganttHtml(st, b) + backlogHtml(st, b) + fabHtml() + '</div>';
}

// ================================================================ 画界面：甘特图

/**
 * 功能：按当前可用宽度算甘特单列宽（px），夹在 44 ~ 160 之间 —— 照任务板 `computeColW()` 的口径。
 *
 * 说明：⭐⭐ 0.8.17：原先这一屏的条一律走 `flex: 1 1 0` 的百分比 7 等分
 *      （那时刻意「不必量宽」）—— 但那样**几何与任务板对不上**，而本轮要的正是「和任务板一样」。
 *      ⇒ 改成实测列宽：量 `#teamwork-board-mount`（本片段的挂载点，是**静态骨架** ⇒ paint 时
 *      已经在文档里、有真实宽度），减掉这一块的左右留白就是甘特卡片的可用宽度。
 *      ⚠️ 减的是**两处** padding：片段根 `.collab-board-block`（12px×2）＋ 甘特卡片 `.collab-gantt`
 *      （14px×2）＝ 52px。⛔ 只减一处会让 7 列加起来比可用宽多出 28px，白白撑出一条横向滚动条。
 *      ⚠️ 拿不到宽度（视图还没显示 / 骨架不在）时回落 7×56 —— 与任务板同一条兜底写法。
 *      ⚠️ 末尾那个 `- 2` 也是照抄任务板的：亚像素 / 边框那点误差就够撑出一条滚动条。
 * @returns {number} 单列宽度（px）
 */
function collabColW() {
  // ① 优先量**上一帧的** `.collab-tl` 自己 —— 最准：它已经扣掉了外层 padding 与纵向滚动条。
  const prev = document.querySelector('.collab-tl');
  if (prev && prev.clientWidth > 0) {
    return Math.max(44, Math.min(160, Math.floor((prev.clientWidth - 2) / WEEK_DAYS)));
  }
  // ② 首帧还没有它（进屏这一次先画「正在读取看板…」，拿到数据才画甘特图）⇒ 用挂载点估算。
  //    ⚠️⭐ 除了那 52px 的两处 padding，还要再扣 **16px 给纵向滚动条**：`.collab-board-block`
  //    是 `overflow-y: auto`，任务一多它就出现，把可用宽吃掉十几 px —— 不扣这一项，7 列加起来
  //    会比可用宽多出十几 px、白白撑出一条横向滚动条（本机实测 13px，探针 ㉙-7 抓到的就是它）。
  const host = document.getElementById('teamwork-board-mount');
  const avail = ((host && host.clientWidth) || WEEK_DAYS * 56) - 52 - 16;
  return Math.max(44, Math.min(160, Math.floor(Math.max(avail - 2, 300) / WEEK_DAYS)));
}

/** 甘特条高度（px）—— 必须与 `desktop/app.css` 里 `.collab-tl-bar` 的 `height` 一致。
 *  ⭐⭐ 0.8.17：**30 → 28**，照任务板 `.tl-taskbar` 的值 —— 本轮的
 *    协作甘特图是「照任务板重写」，条高 / 字号 / 圆角 / 内边距四项必须与它**逐字同值**
 *    （护栏：`ttt/test/frontend-modules.test.js` 的跨模块数值对账）。
 *  ⚠️ 30 是上一轮的值，那时候条里要**分两段**塞下时间节点（上 23px 名字 / 下 7px 节点带）
 *    —— 那正是截图里「像任务板但不是」的根因。 @type {number} */
const TL_BAR_H = 28;

/** 道与道之间的间距（px）—— 与 `.collab-tl-bar` 的 `top` 一起排错行。
 *  ⭐⭐ 2026-10-20：时间节点小点**已移除**（原先它挂在条下沿外侧、为此还把道距从 6 加到 12）。
 *    ⇒ 道距回到**与任务板同值**的 6px（`modules/tasks/desktop-board.js` 的 `TL_BAR_GAP`）——
 *    条与条之间不再需要为小点让出那条轨道，一屏还能多放一道。 @type {number} */
const TL_BAR_GAP = 6;

/** 时间轴上下留白（px）—— 必须与 `.collab-tl-barwrap` 的 `padding: 6px 0` 一致。 @type {number} */
const TL_PAD = 6;

/**
 * 功能：周视图的翻周那一行 —— `«` 周区间 `»` ＋ 一颗 `今天`（照契约 §1 的版式图）。
 *
 * 说明：⭐⭐ 0.8.17：这一行从**甘特卡片里**搬到了**看板页头**（见 `boardHeadHtml()`），
 *      同一屏从此**只剩一处**翻周 —— 原先卡片里自带一份、页头在卡片外，一屏两处既重复、
 *      又让人不知道该按哪个。
 *      ⚠️ 三个 `data-act`（`collab-gweek-*`）**与委托分支同进同出**：这里只搬位置，⛔ 键名一个字不改。
 * @param {Object} st - 状态
 * @returns {string} 翻周行 HTML
 */
function weekNavHtml(st) {
  const ws = weekStartOf(st);
  return (
    '<div class="collab-gnav">' +
    '<button class="collab-gnav-b" type="button" data-act="collab-gweek-prev" title="上一周">«</button>' +
    '<span class="collab-gnav-label">' +
    esc(dayShort(ws) + ' ~ ' + dayShort(ws + WEEK_DAYS - 1)) +
    '</span>' +
    '<button class="collab-gnav-b" type="button" data-act="collab-gweek-next" title="下一周">»</button>' +
    '<button class="collab-gnav-b collab-gnav-today" type="button" data-act="collab-gweek-today">今天</button>' +
    '</div>'
  );
}

/**
 * 功能：图例里的一颗（`全部` ＋ 五组），点它只看该组当前的任务。
 * @param {string} key - 组键或 `all`
 * @param {string} label - 组名
 * @param {number} n - 条数
 * @param {string} cur - 当前选中的键
 * @returns {string} 一颗图例 HTML
 */
function legendBtn(key, label, n, cur) {
  return (
    '<button class="collab-glegend-b g-' +
    key +
    (key === cur ? ' is-on' : '') +
    '" type="button" data-act="collab-glegend" data-group="' +
    esc(key) +
    '"><i class="collab-glegend-dot"></i>' +
    esc(label) +
    ' <b class="collab-glegend-n">' +
    n +
    '</b></button>'
  );
}

/**
 * 功能：顶部那排状态图例（四组 ＋ 全部，各带当前条数）。
 *
 * 说明：⭐⭐ 0.8.53（待排期单列）：图例**不再有「待排期」** —— 它已经不在时间轴上了，
 *      留着那颗只会让人点了之后看到一张空图（「全部」的条数也同步剔掉它）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 图例 HTML
 */
function legendHtml(st, b) {
  const cur = st.filter || 'all';
  const onAxis = allBoardTasks(b).filter((x) => x.group !== 'backlog');
  let html = '<div class="collab-glegend">' + legendBtn('all', '全部', onAxis.length, cur);
  for (const g of GROUP_ORDER) {
    if (g === 'backlog') continue;
    html += legendBtn(g, groupLabel(g), cardsOf(b, g).length, cur);
  }
  return html + '</div>';
}

/**
 * 功能：一天是不是周末（周六 / 周日）—— 天序号版，与 `weekdayOf()` 同刻度。
 * @param {number} i - 天序号
 * @returns {boolean} 周六 / 周日为 true
 */
function isWendIndex(i) {
  const w = weekdayOf(i);
  return w === 0 || w === 6;
}

/**
 * 功能：周视图的列头那一行 —— **一天一列**（星期几 ＋ `M/D`），每一列可点（点列只高亮列头）。
 * 说明：⚠️ 与下面那条 7 等分轨道按天对齐；**今天那列用品牌色**、**周末那两列转灰**。
 *      形状 / 字号 / 描边照任务板 `renderTimeline()` 的 `.tl-col-head`。
 *      ⭐ 0.8.17：列头支持 `.sel` 高亮 ＋ 带上点列的落点
 *      （`data-act="collab-gcol"` ＋ `data-col`）—— 点哪一列就把它自己的 `.sel` 加上、其余摘掉，
 *      **只改 class、不重画整块**（重画会把横向滚动位置打回最左）。
 * @param {Object} st - 状态（读 `selected`，天序号；`-1` = 没选）
 * @param {number} ws - 这一周的周一（天序号）
 * @returns {string} 列头行 HTML
 */
function ganttHeadHtml(st, ws) {
  const today = todayIndex();
  let cells = '';
  for (let i = 0; i < WEEK_DAYS; i++) {
    const d = ws + i;
    cells +=
      '<div class="collab-tl-col' +
      (d === today ? ' is-today' : '') +
      (isWendIndex(d) ? ' is-wend' : '') +
      (st && st.selected === d ? ' sel' : '') +
      '" data-act="collab-gcol" data-col="' +
      i +
      '">' +
      '<div class="collab-tl-dow">' +
      esc(WEEK_CHARS[weekdayOf(d)]) +
      '</div>' +
      '<div class="collab-tl-date">' +
      esc(dayShort(d)) +
      '</div>' +
      '</div>';
  }
  return '<div class="collab-tl-head">' + cells + '</div>';
}

/**
 * 功能：把可见任务**裁到本周**之后**贪心分道**（重叠自动错行）—— 同一道内绝不重叠。
 *
 * 说明：⭐⭐ 照任务板 `renderTimeline()` 的分道与裁边口径，一个字都没换：
 *      ① **跨周把条裁到边界**（`s = max(起点, 周一)` / `e = min(终点, 周日)`）——
 *         8 月底开始、9 月初结束的长条在本周照样看得见（只画落在本周那一段）；
 *      ② **完全落在本周之外的不画**（参照实现里就是被 `s <= end && e >= start` 滤掉的那批）
 *         —— 默认周就是**本周**（`weekStartOf`），别周的任务用页头那颗 `« / »` 翻过去；
 *      ③ 分道前**按起点升序**排（贪心才紧凑），逐条放进「上一段已经结束」的第一条道，
 *         都放不下才新开一条；道数＝同一时段最挤的条数。
 * @param {Array.<Object>} list - `visibleTasks()` 的产物 `[{ t, group }]`
 * @param {number} ws - 这一周的周一（天序号）
 * @returns {Array.<Object>} `[{ x, s, e, si, ei, lane }]`（`si` / `ei` 是列下标 0~6）
 */
function lanesOf(list, ws) {
  const end = ws + WEEK_DAYS - 1;
  const laid = [];
  for (const x of list) {
    // ⚠️ 组要传下去：`completed` 看完成日、`cancelled` 不顺延（见 `barSpanOf()` 里那两条）
    const span = barSpanOf(x.t, x.group);
    if (span.start == null || span.end == null) continue;
    const s = Math.max(span.start, ws);
    const e = Math.min(span.end, end);
    if (s > e) continue;
    const si = s - ws;
    const ei = e - ws;
    // ⭐⭐ 0.8.17：**删掉「最小宽度加宽」**（原 `TL_MIN_COLS = 2`）——
    //    它当年是为了「1 天的条太窄、名字被截、节点没处放」才加的；现在两件事都变了：
    //    ① 起点改口径（`start_date || created_at`）之后短条本来就少；
    //    ② 时间节点**搬到条下沿外侧的小轨**上（见 `ganttHtml()`），不再需要条内空间。
    //    ⇒ 留着加宽只会让条**与日期轴对不上**（这次要的正是「和任务板一样」）。
    laid.push({ x: x, s: s, e: e, si: si, ei: ei, lane: 0 });
  }
  laid.sort((a, c) => a.si - c.si || a.ei - c.ei || Number(a.x.t.id) - Number(c.x.t.id));
  const laneEnd = [];
  for (const row of laid) {
    let lane = laneEnd.findIndex((last) => row.si > last);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = row.ei;
    row.lane = lane;
  }
  return laid;
}

/**
 * 功能：一条任务条的悬停提示 —— ⭐ 条里放不下的四样全收在这里：
 *      **任务名 · 负责人 · 截止日 · `💬 n` · `📎 n`**，末尾按情况补「已完成 / 已取消 / 已逾期」。
 * @param {Object} b - 看板响应
 * @param {Object} x - `{ t, group }`
 * @returns {string} 提示文案
 */
function barTip(b, x) {
  const t = x.t;
  const parts = [String((t && t.title) || '未命名任务')];
  parts.push(assigneeText(b, t));
  const due = String(t && t.due_date != null ? t.due_date : '').slice(0, 10);
  if (due) parts.push('截止 ' + due);
  parts.push('💬 ' + badgeCount(t, 'comment_count'));
  parts.push('📎 ' + badgeCount(t, 'file_count'));
  if (x.group === 'completed') parts.push('已完成');
  else if (x.group === 'cancelled') parts.push('已取消');
  else {
    const di = dayIndexOf(t && t.due_date);
    if (di != null && di < todayIndex()) parts.push('已逾期');
  }
  return parts.join(' · ');
}

/**
 * 功能：一条任务在甘特图上的**条** —— 照任务板形态：**单段**、条里直接写任务名、按**画出来的先后**
 *      轮流取 `COLORS`（`--tlc`）、三类任务形状齐全；**点这条**开**协作卡片弹层**（D4：⛔ 不换成任务详情）。
 *
 * 说明：⭐⭐ 0.8.17三类形状：
 *      · **普通** —— 一条到底，无前缀；
 *      · **窗口**（`task_kind === 'window'`）—— 加 `tl-win`（条两端各 3px 橙竖线 ＋ 条首 ⏱）；
 *      · **周期**（`task_kind === 'cycle'`）—— **一期一段**（`tl-cyc tl-seg`）：每一期单独一条，
 *        打过卡的段加 `.ok`（绿 ✓）、过完还没打卡的段加 `.due`（红边）；⛔ 不画贯穿主条。
 *        ⚠️ 判据（哪几期 · 欠没欠 · 打卡进度）**全在共用层** `core/recur.js`，⛔ 别在这边自己算一份；
 *        数据来自—— store 的 `attachTicks()` 给周期任务挂上的 `ticks`。
 *      ⚠️ 完成 / 逾期的样式在 CSS 里靠 `:not(.done)` 让位（⛔ 别让已完成的条丢掉那枚 ✓）。
 * @param {Object} b - 看板响应
 * @param {Object} row - `lanesOf()` 的一行
 * @param {number} i - 这一条在**本轮画出来的条**里的序号（配色轮换用，照任务板）
 * @param {number} ws - 这一周的周一（天序号，周期任务分期用）
 * @param {number} colw - 单列宽度（px）
 * @returns {string} 该任务的全部条 HTML（普通 / 窗口任务 1 条；周期任务一期一条）
 */
function barHtml(b, row, i, ws, colw) {
  const t = row.x.t;
  const tid = esc(t && t.id != null ? String(t.id) : '');
  const top = TL_PAD + row.lane * (TL_BAR_H + TL_BAR_GAP);
  // ⭐ 配色照任务板：按**画出来的先后**轮流取 `COLORS`（相邻必然不同）。
  //    ⚠️ 0.8.17 起**不再按组着色**（原 `barClass()`）—— 顶部那条状态图例从此只管**筛选**，
  //    不再兼任「条色说明书」。
  const tlc = COLORS[i % COLORS.length];
  const done = row.x.group === 'completed';
  const due = dayIndexOf(t && t.due_date);
  const over = !done && row.x.group !== 'cancelled' && due != null && due < todayIndex();
  const title = (t && t.title) || '未命名任务';
  // ---- 周期任务：一期一段（数据来自 store 的 `attachTicks()`，判据全在 core/recur.js）----
  if (t && t.task_kind === 'cycle') {
    const ticks = Array.isArray(t.ticks) ? t.ticks : [];
    const tickSet = new Set(ticks.map((x) => String(x)));
    const today = dayText(todayIndex());
    const missed = new Set(missedPeriods(t, ticks, today).map((p) => String(p.key)));
    const prog = tickProgress(t, ticks);
    let out = '';
    for (const p of periodsBetween(t, dayText(ws), dayText(ws + WEEK_DAYS - 1))) {
      const i0 = dayIndexOf(p.start);
      const i1 = dayIndexOf(p.end);
      const lo = i0 == null ? 0 : Math.max(0, i0 - ws);
      const hi = i1 == null ? WEEK_DAYS - 1 : Math.min(WEEK_DAYS - 1, i1 - ws);
      if (hi < lo) continue;
      const ok = tickSet.has(String(p.key));
      const segTip =
        '🔁 ' +
        title +
        (prog.total ? '（' + prog.text + '）' : '') +
        '\n本期 ' +
        p.start +
        (p.end !== p.start ? ' ~ ' + p.end : '') +
        '：' +
        (ok ? '已打卡' : '还没打卡') +
        ' —— 点开卡片看流水';
      out +=
        '<div class="collab-tl-bar tl-cyc tl-seg' +
        (ok ? ' ok' : '') +
        (missed.has(String(p.key)) ? ' due' : '') +
        '" role="button" data-act="collab-card-open" data-tid="' +
        tid +
        '" style="left:' +
        lo * colw +
        'px;width:' +
        ((hi - lo + 1) * colw - 4) +
        'px;top:' +
        top +
        'px;--tlc:' +
        tlc +
        '" title="' +
        esc(segTip) +
        '">' +
        esc(title) +
        '</div>';
    }
    return out;
  }
  // ---- 普通 / 窗口 ----
  const kindCls = t && t.task_kind === 'window' ? ' tl-win' : '';
  return (
    '<div class="collab-tl-bar' +
    (done ? ' done' : '') +
    (over ? ' due' : '') +
    kindCls +
    '" role="button" data-act="collab-card-open" data-tid="' +
    tid +
    '" style="left:' +
    row.si * colw +
    'px;width:' +
    ((row.ei - row.si + 1) * colw - 4) +
    'px;top:' +
    top +
    'px;--tlc:' +
    tlc +
    '" title="' +
    esc(barTip(b, row.x)) +
    '">' +
    esc(title) +
    '</div>'
  );
}

/**
 * 功能：一张**按周列的甘特时间轴**（照任务板 `renderTimeline()`）—— 顶部状态图例 ＋
 *      一天一列的列头 ＋ 一条按**实测列宽**铺满的轨道（条按**道**错行、条里写任务名）。
 *
 * 说明：⚠️ 一周之外的任务不画（照参照实现的口径）—— 默认周就是**本周**（`weekStartOf`）；
 *      要看别周的任务用页头那颗 `« / »` 翻，或点 `今天` 回来。一条任务都没有时才画那句空态。
 *      ⭐⭐ 0.8.17几何从「百分比 7 等分」改成**实测 px**（`collabColW()`）——
 *      与任务板同一口径，条才能与日期轴严格对齐（也才能与任务板做「起止列号逐条相等」的对账）。
 *      ⚠️ 翻周那一行（`weekNavHtml()`）**不在这一块里**了 —— 它已并进看板页头（见 `boardHeadHtml()`），
 *      同一屏只剩一处翻周。
 *      ⭐ 2026-10-20：条下沿那排时间节点小点**已移除** —— 轨迹高度回到「与任务板同一套」
 *      （上下留白 ＋ 车道 × 条高 ＋ 空档 × 道距），⛔ 不再为小点多留那 10px。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 时间轴 HTML
 */
function ganttHtml(st, b) {
  const list = visibleTasks(st, b);
  const ws = weekStartOf(st);
  const laid = lanesOf(list, ws);
  const colw = collabColW();
  const W = colw * WEEK_DAYS;
  const today = todayIndex();
  const end = ws + WEEK_DAYS - 1;
  let grid = '';
  for (let i = 0; i < WEEK_DAYS; i++) {
    const d = ws + i;
    grid +=
      '<div class="collab-tl-gcol' + (d === today ? ' is-today' : '') + (isWendIndex(d) ? ' is-wend' : '') + '"></div>';
  }
  const todaymark =
    today >= ws && today <= end
      ? '<div class="collab-tl-todaymark" style="left:' + ((today - ws) * colw + colw / 2) + 'px"></div>'
      : '';
  const lanes = laid.reduce((m, r) => Math.max(m, r.lane + 1), 0);
  // 高度口径与任务板 `renderTimeline()` **逐项同源**（那条轨道只装条，没有小点轨）。
  const h = TL_PAD * 2 + Math.max(1, lanes) * TL_BAR_H + Math.max(0, lanes - 1) * TL_BAR_GAP;
  let bars = '';
  laid.forEach((row, i) => {
    bars += barHtml(b, row, i, ws, colw);
  });
  // ⭐ 2026-10-20：默认周回到本周之后，可能出现「有任务、但这一周一条都不在」——
  //    那时整条轨道是空的，**必须说一句人话**，⛔ 别让画面看着像坏了（从前靠「撑周」永远不会空）。
  let empty = '';
  if (!list.length) empty = '<div class="collab-gempty">还没有任务</div>';
  else if (!laid.length) empty = '<div class="collab-gempty">这一周没有任务 —— 用 « / » 翻到别的周看看</div>';
  return (
    '<div class="collab-gantt">' +
    legendHtml(st, b) +
    '<div class="collab-tl"><div class="collab-tl-inner" style="width:' +
    W +
    'px">' +
    ganttHeadHtml(st, ws) +
    '<div class="collab-tl-body">' +
    '<div class="collab-tl-grid">' +
    grid +
    '</div>' +
    todaymark +
    '<div class="collab-tl-barwrap" style="height:' +
    h +
    'px">' +
    bars +
    '</div>' +
    '</div>' +
    '</div></div>' +
    empty +
    '</div>'
  );
}

// ================================================================ 画界面：待排期（0.8.53）

/**
 * 功能：**待排期列表** —— **甘特图下面**单独一块（待排期不在甘特图中显示；0.8.54 起从页头下面挪下来，
 *      单独列表显示，没有日期，可以转为任务）。
 *
 * 说明：⭐⭐ 这几条都是**刻意**的：
 *      · 只有 `backlog` 组进这里（自定义状态只要落在 backlog 组，同样算待排期）；
 *      · 列表**不显示日期** —— 待排期的语义就是「还没排期」，旧数据上残留的日期一概不露出；
 *      · 每条右侧一颗【转为任务】：选任务类型（普通 / 窗口 / 周期）与日期时间后，
 *        状态从 backlog 组挪到「未开始」组（见 `promoteTask()`）。
 *      ⚠️ 一条待排期都没有时**整块不画**（回空串）—— 空标题比不画更占地方。
 *      ⚠️ 点标题开任务详情弹层（与甘特条同一个动作 `collab-card-open`）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 待排期那一块 HTML（没有待排期任务时为空串）
 */
function backlogHtml(st, b) {
  const list = cardsOf(b, 'backlog').slice().sort((a, c) => Number(c.id) - Number(a.id));
  if (!list.length) return '';
  const rows = list
    .map((t) => {
      const tid = esc(t && t.id != null ? String(t.id) : '');
      return (
        '<div class="collab-bl-row">' +
        '<button class="collab-bl-title" type="button" data-act="collab-card-open" data-tid="' +
        tid +
        '" title="打开任务详情">' +
        esc((t && t.title) || '未命名任务') +
        '</button>' +
        '<span class="collab-bl-who">' +
        esc(assigneeText(b, t)) +
        '</span>' +
        '<button class="collab-btn primary" type="button" data-act="collab-promote-open" data-tid="' +
        tid +
        '">转为任务</button>' +
        // ⭐ 0.8.54（「团队协作的待排期任务没有删除功能」）：待排期是「随手记」——
        //    记错了必须能撤。一颗小 ✕，点了先问一句（不可撤销）。
        '<button class="collab-bl-x" type="button" data-act="collab-task-del" data-tid="' +
        tid +
        '" title="删除这条待排期">✕</button>' +
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
    '<span class="collab-bl-hint">没有日期 · 不进甘特图 · 转为任务时才排期</span>' +
    '</div>' +
    '<div class="collab-bl-list">' +
    rows +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：删待排期前的**确认弹层**（⭐ 0.8.54）—— 删除不可撤销，而且会连带上报 / 评论 / 附件。
 *
 * 说明：⭐ 走本模块既有的 `showModal()` 外壳（与【转为任务】同一套），⛔ 不去开全局 `#modal`
 *      —— 两套弹层叠在一起时，关闭顺序与层级都要重新想一遍，不值。
 *      ⚠️ 标题是**用户内容** ⇒ 一律 `esc()`；⛔ 不拼进属性里。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML（找不到那条任务就回空串）
 */
function delModalHtml(st, b) {
  const t = findTask(b, st.delFor);
  if (!t) return '';
  const inner =
    '<div class="collab-promote-t">' +
    esc(t.title || '未命名任务') +
    '</div>' +
    '<div class="collab-hint">这条任务会连同它的评论、附件一起删掉，<b>不能撤销</b>。</div>' +
    '<div class="collab-modal-foot">' +
    '<button class="collab-btn danger" type="button" data-act="collab-task-del-go">删除</button>' +
    '<button class="collab-btn" type="button" data-act="collab-task-del-close">取消</button>' +
    '</div>';
  return showModal('删除待排期', inner, 'collab-task-del-close', 'collab-modal-del');
}

/**
 * 功能：真的删掉那条待排期（`DELETE /api/collab/projects/:pid/tasks/:tid`，⭐ 0.8.54）。
 *
 * 说明：⚠️ 判权（**所有者 ＋ 创建者**）在服务端；这里只把它的原话（404「这条任务」）弹出来。
 *      ⚠️ 删完必须 `reloadBoard()` —— 待排期、进度、"共 N 条"三处都跟着变，就地改一处就会留旧值。
 * @param {HTMLElement} root - 本片段根节点
 * @param {Object} st - 状态
 * @returns {Promise.<void>}
 */
async function deleteBacklogTask(root, st) {
  const id = Number(st.delFor);
  if (!id) return;
  try {
    await api('DELETE', '/api/collab/projects/' + Number(st.pid) + '/tasks/' + id);
    st.delFor = 0;
    toast('已删除');
    await reloadBoard(root, st);
  } catch (e) {
    toast(msgOf(e), true);
  }
}

/**
 * 功能：【转为任务】弹层 —— 给一条待排期任务选任务类型与日期时间。
 *
 * 说明：⭐ 字段与任务板的「新建任务」同一套：任务日 / 截止日 ＋ 任务类型块
 *      （普通 / 窗口 / 周期；窗口要两个时刻，周期要循环规则，可选每期时间窗）。
 *      ⚠️ 日期**必填**（转成任务 = 上甘特图，没有日期的条画不出来）——
 *      默认值用这条任务残留的日期，没有就今天。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML（找不到那条任务就回空串）
 */
function promoteModalHtml(st, b) {
  const t = findTask(b, st.promoteFor);
  if (!t) return '';
  const today = dayText(todayIndex());
  const start = date10Of(t.start_date) || today;
  const due = date10Of(t.due_date) || start;
  const inner =
    '<div class="collab-promote-t">' +
    esc(t.title || '未命名任务') +
    '</div>' +
    '<div class="collab-field-row">' +
    field('任务日', '<input class="collab-input" data-role="pm-start" type="date" value="' + esc(start) + '">') +
    field('截止日', '<input class="collab-input" data-role="pm-due" type="date" value="' + esc(due) + '">') +
    '</div>' +
    kindBlockHtml('pm', t) +
    '<div class="collab-modal-foot">' +
    '<button class="collab-btn primary" type="button" data-act="collab-promote-save">转为任务</button>' +
    '<button class="collab-btn" type="button" data-act="collab-promote-close">取消</button>' +
    '</div>';
  return showModal('转为任务', inner, 'collab-promote-close', 'collab-modal-promote');
}

// ================================================================ 画界面：弹层

/**
 * 功能：套一个模态框外壳（复用电脑版既有的 `.modal` / `.modal-card` 一族）。
 * @param {string} title - 标题
 * @param {string} inner - 弹层正文
 * @param {string} closeAct - 关闭按钮的 `data-act`
 * @param {string} cardClass - 加在 `.modal-card` 上的额外类名（取值时用来定位）
 * @returns {string} 弹层 HTML
 */
function showModal(title, inner, closeAct, cardClass) {
  return (
    '<div class="modal" style="z-index:60">' +
    '<div class="modal-card ' +
    cardClass +
    '">' +
    '<div class="modal-head"><h3>' +
    esc(title) +
    '</h3>' +
    '<button class="collab-btn ghost" type="button" data-act="' +
    closeAct +
    '">关闭</button>' +
    '</div>' +
    '<div class="modal-body">' +
    inner +
    '</div>' +
    '</div></div>'
  );
}

/**
 * 功能：弹层里的一个字段（标签 ＋ 控件）。
 * @param {string} label - 字段名
 * @param {string} control - 控件 HTML
 * @returns {string} 字段 HTML
 */
function field(label, control) {
  return '<div class="collab-field"><span class="collab-sub">' + esc(label) + '</span>' + control + '</div>';
}

/**
 * 功能：五组的下拉选项（认不出就选第一个）。
 * @param {string} cur - 当前组键
 * @returns {string} option 列表
 */
function groupOptions(cur) {
  return GROUP_ORDER.map(
    (g) => '<option value="' + g + '"' + (g === cur ? ' selected' : '') + '>' + esc(groupLabel(g)) + '</option>',
  ).join('');
}

/**
 * 功能：⚙ 状态弹层 —— 按组分块列出状态，每条可改名 / 调色 / 改所属组 / 删；末行可新增。
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML
 */
function stateModalHtml(b) {
  const states = statesOf(b);
  let body = '';
  for (const g of GROUP_ORDER) {
    const inGroup = states.filter((s) => String(s.group) === g);
    body += '<div class="collab-stgroup"><div class="collab-sub">' + esc(groupLabel(g)) + '</div>';
    if (!inGroup.length) body += '<div class="collab-col-empty">—</div>';
    for (const s of inGroup) {
      body +=
        '<div class="collab-strow">' +
        '<input class="collab-input" data-role="name" type="text" maxlength="100" value="' +
        esc(s.name || '') +
        '">' +
        '<input class="collab-color" data-role="color" type="color" value="' +
        esc(hexOf(s.color)) +
        '">' +
        '<select class="collab-mini" data-role="group">' +
        groupOptions(String(s.group)) +
        '</select>' +
        '<button class="collab-btn" type="button" data-act="collab-state-save" data-sid="' +
        esc(String(s.id)) +
        '">保存</button>' +
        '<button class="collab-btn" type="button" data-act="collab-state-del" data-sid="' +
        esc(String(s.id)) +
        '">删除</button>' +
        (Number(s.is_default) === 1 ? '<i class="collab-mem-tag">默认</i>' : '') +
        '</div>';
    }
    body += '</div>';
  }
  body +=
    '<div class="collab-stadd">' +
    '<span class="collab-sub">＋ 新增状态</span>' +
    '<input class="collab-input" data-role="newname" type="text" maxlength="100">' +
    '<select class="collab-mini" data-role="newgroup">' +
    groupOptions('backlog') +
    '</select>' +
    '<input class="collab-color" data-role="newcolor" type="color" value="' +
    FALLBACK_COLOR +
    '">' +
    '<button class="collab-btn primary" type="button" data-act="collab-state-add">新增</button>' +
    '</div>';
  return showModal('状态', body, 'collab-state-close', 'collab-modal-state');
}

/**
 * 功能：新建任务弹层 —— 标题 / 状态 / 负责人 / 任务日与截止日 / **任务类型** / 描述。
 *
 * 说明：⭐⭐ 0.8.53：
 *      · 补上「任务类型」块（普通 / 窗口 / 周期）与「任务日」—— 从前只能建普通任务、
 *        起止日期只靠截止日兜底，周期与窗口在协作侧根本建不出来；
 *      · 状态选在 **backlog 组（待排期）** 时**日期与类型整块隐藏** —— 待排期的语义就是
 *        「还没排期」，它的类型与日期要到【转为任务】那一步再选。
 *      ⚠️ option 上带 `data-group`：联动判据是**组**而不是状态键（状态集是项目自配的）。
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML
 */
function taskModalHtml(b) {
  const owner = !!(b && b.project && b.project.role === 'owner');
  const states = statesOf(b);
  let stOpts = '';
  for (const s of states) {
    const key = String(s.key == null ? '' : s.key);
    if (!owner && String(s.group) === 'completed') continue;
    stOpts += '<option value="' + esc(key) + '" data-group="' + esc(String(s.group)) + '">' + esc(s.name || key) + '</option>';
  }
  const memOpts = membersOf(b)
    .map(
      (m) => '<option value="' + esc(String(m.user_id)) + '">' + esc(m.display_name || m.username || '') + '</option>',
    )
    .join('');
  const today = dayText(todayIndex());
  const inner =
    field('标题', '<input class="collab-input" data-role="title" type="text" maxlength="100">') +
    field('状态', '<select class="collab-input" data-role="status">' + stOpts + '</select>') +
    field('负责人', '<select class="collab-input" data-role="assignee">' + memOpts + '</select>') +
    '<div class="collab-field-row" data-role="tk-dates">' +
    field('任务日', '<input class="collab-input" data-role="start" type="date" value="' + esc(today) + '">') +
    field('截止日', '<input class="collab-input" data-role="due" type="date" value="' + esc(today) + '">') +
    '</div>' +
    '<div data-role="tk-kind">' +
    kindBlockHtml('tk', {}) +
    '</div>' +
    field('描述', '<textarea class="collab-input" data-role="desc"></textarea>') +
    '<div class="collab-modal-foot">' +
    '<button class="collab-btn primary" type="button" data-act="collab-task-save">确定</button>' +
    '<button class="collab-btn" type="button" data-act="collab-task-close">取消</button>' +
    '</div>';
  return showModal('新建任务', inner, 'collab-task-close', 'collab-modal-task');
}

/**
 * 功能：转让弹层 —— 选成员 ＋ 二次确认语（原话照抄）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML
 */
function transferModalHtml(st, b) {
  const meId = st.me && st.me.id;
  const targets = membersOf(b).filter((m) => !(isNum(meId) && Number(m.user_id) === Number(meId)));
  let inner;
  if (!targets.length) {
    inner = '<div class="collab-hint">这个项目还没有别的成员，转让不了。</div>';
  } else {
    const opts = targets
      .map(
        (m) =>
          '<option value="' + esc(String(m.user_id)) + '">' + esc(m.display_name || m.username || '') + '</option>',
      )
      .join('');
    inner =
      field('转让给谁', '<select class="collab-input" data-role="target">' + opts + '</select>') +
      '<div class="collab-note">' +
      esc(TRANSFER_ASK) +
      '</div>' +
      '<div class="collab-modal-foot">' +
      '<button class="collab-btn primary" type="button" data-act="collab-transfer-save">确定</button>' +
      '<button class="collab-btn" type="button" data-act="collab-transfer-close">取消</button>' +
      '</div>';
  }
  return showModal('转让', inner, 'collab-transfer-close', 'collab-modal-transfer');
}

/**
 * 功能：【协作成员管理】弹层 —— 分「成员」与「项目操作」两组：成员**一行一个**
 *      （名字 ＋ `我` / `发起人` 标记 ＋ 右侧 `移出`）·（所有者）`＋ 加成员` · `移出协作` · `转让` ·
 *      那句说明 · 最底一行上传用量。
 * 说明：⭐ 本轮要「排版好看一点」⇒ 只重排 ＋ 分层，控件与文案一个没丢。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML
 */
function membersModalHtml(st, b) {
  const owner = !!(b && b.project && b.project.role === 'owner');
  const members = membersOf(b);
  const inner =
    '<div class="collab-mgroup">' +
    '<div class="collab-mgroup-head">' +
    '<span class="collab-sub">成员</span>' +
    '<span class="collab-mcount">共 ' +
    members.length +
    ' 人</span>' +
    '</div>' +
    '<div class="collab-mlist">' +
    memberRowsHtml(st, b) +
    '</div>' +
    '<div class="collab-madd">' +
    (owner ? addMemberHtml(st) : '') +
    '</div>' +
    '</div>' +
    (owner
      ? '<div class="collab-mgroup">' +
        '<div class="collab-mgroup-head"><span class="collab-sub">项目操作</span></div>' +
        '<div class="collab-member-acts">' +
        '<button class="collab-btn" type="button" data-act="collab-unshare">移出协作</button>' +
        '<button class="collab-btn" type="button" data-act="collab-transfer-open">转让</button>' +
        '</div>' +
        '<span class="collab-shared-note">' +
        esc(SHARED_NOTE) +
        '</span>' +
        '</div>'
      : '') +
    usageBlockHtml(st, b);
  return showModal('协作成员管理', inner, 'collab-members-close', 'collab-modal-members');
}

// ================================================================ 画界面：附件（2f）

/**
 * 功能：一个附件行 —— `📎 文件名 · 大小`（可点下载）＋ 上传者 ＋ 下载 / 删除。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @param {Object} f - 附件行
 * @returns {string} 附件行 HTML
 */
function fileRowHtml(st, b, f) {
  const fid = f && f.id != null ? String(f.id) : '';
  const name = f && f.name != null ? String(f.name) : '';
  const size = fmtSize(f ? f.size : 0);
  return (
    '<span class="collab-file">' +
    '<span class="collab-file-name" role="button" data-act="collab-file-dl" data-fid="' +
    esc(fid) +
    '" title="' +
    esc(TXT.download) +
    '">📎 ' +
    esc(name) +
    (size ? ' · ' + esc(size) : '') +
    '</span>' +
    '<span class="collab-file-who">' +
    esc(uploaderName(b, f && f.uploader_id)) +
    '</span>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-file-dl" data-fid="' +
    esc(fid) +
    '">' +
    esc(TXT.download) +
    '</button>' +
    (canDeleteFile(st, b, f)
      ? '<button class="collab-btn ghost" type="button" data-act="collab-file-del" data-fid="' +
        esc(fid) +
        '">' +
        esc(TXT.del) +
        '</button>'
      : '') +
    '</span>'
  );
}

/**
 * 功能：一拨附件（空态 `还没有附件`；读失败把服务端原话摆出来；`null` = 还在读）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @param {?Array.<Object>} items - 附件数组
 * @returns {string} 附件列表 HTML
 */
function fileListHtml(st, b, items) {
  if (st.filesErr) return '<div class="collab-hint err">' + esc(st.filesErr) + '</div>';
  if (items === null) return '<div class="collab-hint">' + esc(TXT.loading) + '</div>';
  if (!items || !items.length) return '<div class="collab-hint">' + esc(TXT.noFile) + '</div>';
  return items.map((f) => fileRowHtml(st, b, f)).join('');
}

/**
 * 功能：一个 `＋ 附件` 上传入口（`<label>` 套一个隐藏的文件框，点它弹选择框）。
 * 说明：⚠️ 宿主 / 目标由 `data-task` / `data-report` 带着走，⛔ 不用灰色占位提示。
 * @param {Object} opts - `{ role, task?, report? }`
 * @returns {string} 上传入口 HTML
 */
function fileAddHtml(opts) {
  const o = opts || {};
  return (
    '<label class="collab-file-add">' +
    esc(TXT.addFile) +
    '<input class="collab-file-input" type="file" data-role="' +
    esc(o.role || '') +
    '"' +
    (o.task ? ' data-task="' + esc(String(o.task)) + '"' : '') +
    (o.report ? ' data-report="' + esc(String(o.report)) + '"' : '') +
    ' hidden>' +
    '</label>'
  );
}

// ================================================================ 画界面：评论 / 活动

/**
 * 功能：⭐ 2g —— 一条**评论自己的**附件行（照契约 §1 的版式图）：`📎 文件名 · 大小` ＋ 下载 ＋ 删除。
 * 说明：⚠️ `删除` 只在上传者是自己**或**我是项目所有者时画（判据同 `canDeleteFile`）；
 *      ⛔ 行里不再带上传者名（短格式，与手机端逐字一致）。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @param {Object} f - 附件行
 * @returns {string} 附件行 HTML
 */
function cmtFileRowHtml(st, b, f) {
  const fid = f && f.id != null ? String(f.id) : '';
  const name = f && f.name != null ? String(f.name) : '';
  const size = fmtSize(f ? f.size : 0);
  return (
    '<span class="collab-file">' +
    '<span class="collab-file-name" role="button" data-act="collab-file-dl" data-fid="' +
    esc(fid) +
    '" title="' +
    esc(TXT.download) +
    '">📎 ' +
    esc(name) +
    (size ? ' · ' + esc(size) : '') +
    '</span>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-file-dl" data-fid="' +
    esc(fid) +
    '">' +
    esc(TXT.download) +
    '</button>' +
    (canDeleteFile(st, b, f)
      ? '<button class="collab-btn ghost" type="button" data-act="collab-file-del" data-fid="' +
        esc(fid) +
        '">' +
        esc(TXT.del) +
        '</button>'
      : '') +
    '</span>'
  );
}

/**
 * 功能：一条评论 —— ⭐ 2g「短视频评论区」样式：`头像(首字) · 名字 · 时间(MM-DD HH:mm) · 删除`，
 *      正文换行照显，**紧贴正文下面**画这条评论自己的附件。
 * 说明：⚠️ `删除` 只挂在自己那条的右上角；附件归属只看 `comment_id === 这条评论 id`，⛔ 不按顺序猜。
 * @param {Object} c - 评论行
 * @param {*} meId - 我的账号 id
 * @param {string} scope - `task` 或 `proj`（删除键要把它带上，否则不知道删哪一档）
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 评论行 HTML
 */
function commentRowHtml(c, meId, scope, st, b) {
  const uid = c ? c.user_id : null;
  const mine = isNum(meId) && isNum(uid) && Number(uid) === Number(meId);
  const who = c ? c.display_name || c.username || '' : '';
  const body = c && c.body != null ? String(c.body) : '';
  const av = who ? who.slice(0, 1) : '';
  const cid = c && c.id != null ? Number(c.id) : 0;
  const files = st && st.files === null ? null : filesOfComment(st, cid);
  return (
    '<div class="collab-cmt">' +
    '<div class="collab-cmt-head">' +
    '<span class="collab-avatar">' +
    esc(av) +
    '</span>' +
    '<span class="collab-cmt-who">' +
    esc(who) +
    '</span>' +
    '<span class="collab-cmt-when">' +
    esc(stampShort(c && c.created_at)) +
    '</span>' +
    (mine
      ? '<button class="collab-btn ghost collab-cmt-x" type="button" data-act="collab-comment-del" data-cid="' +
        esc(c && c.id != null ? String(c.id) : '') +
        '" data-scope="' +
        scope +
        '">' +
        esc(TXT.del) +
        '</button>'
      : '') +
    '</div>' +
    '<div class="collab-cmt-body">' +
    esc(body) +
    '</div>' +
    (files && files.length
      ? '<div class="collab-files collab-cmt-files">' + files.map((f) => cmtFileRowHtml(st, b, f)).join('') + '</div>'
      : '') +
    '</div>'
  );
}

/**
 * 功能：评论列表（空态 `还没有评论`；读失败把服务端原话摆出来）。
 * @param {?Array.<Object>} items - 评论数组（null = 还在读）
 * @param {string} err - 错误文案
 * @param {*} meId - 我的账号 id
 * @param {string} scope - `task` 或 `proj`
 * @param {Object} st - 状态
 * @returns {string} 列表 HTML
 */
function commentListHtml(items, err, meId, scope, st) {
  if (err) return '<div class="collab-hint err">' + esc(err) + '</div>';
  if (items === null) return '<div class="collab-hint">' + esc(TXT.loading) + '</div>';
  if (!items.length) return '<div class="collab-hint">' + esc(TXT.noComment) + '</div>';
  return items.map((c) => commentRowHtml(c, meId, scope, st, st && st.board)).join('');
}

/**
 * 功能：⭐ 2g 老附件兜底块 —— 没挂评论的那一拨（任务级 / 项目级）摆在评论列表最下面，
 *      标题 `其他附件`；⛔ 一条都不丢，也⛔ 不丢到别的区里去。
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {string} 兜底块 HTML（没有这种附件 / 附件还没取到就回空串）
 */
function orphanBlockHtml(st, scope) {
  if (st.files === null) return '';
  const files = orphanFilesOf(st, scope);
  if (!files.length) return '';
  return (
    '<div class="collab-sub">' +
    esc(TXT.otherFiles) +
    '</div>' +
    '<div class="collab-files">' +
    files.map((f) => cmtFileRowHtml(st, st.board, f)).join('') +
    '</div>'
  );
}

/**
 * 功能：评论列表那一块的整份内容（评论各自带附件 ＋ 最下面的「其他附件」兜底）。
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {string} 内容 HTML
 */
function commentAreaHtml(st, scope) {
  const isTask = scope === 'task';
  return (
    commentListHtml(
      isTask ? st.cardComments : st.projComments,
      isTask ? st.cardCommentsErr : st.projCommentsErr,
      st.me && st.me.id,
      scope,
      st,
    ) + orphanBlockHtml(st, scope)
  );
}

/**
 * 功能：⭐ 2g —— 输入条上方那排待传文件的 chips（可逐个移除；⛔ 发送前不发请求）。
 * @param {Object} st - 状态
 * @returns {string} chips HTML
 */
function pendingChipsHtml(st) {
  const list = Array.isArray(st.pending) ? st.pending : [];
  return list
    .map(
      (f, i) =>
        '<span class="collab-chip">' +
        esc(String(f.name == null ? '' : f.name)) +
        '<button class="collab-chip-x" type="button" data-act="collab-pending-del" data-idx="' +
        i +
        '">✕</button>' +
        '</span>',
    )
    .join('');
}

/**
 * 功能：一条流水 —— `谁 · 何时 · 从→到`（`from_status` 为空那一格显示破折号）＋ 留言 ＋ 附件。
 * 说明：⭐ 附件挂在这条**流水**上（`report_id`）⇒ 每条流水各带各的附件与上传入口。
 * @param {Object} b - 看板响应（借状态集把键翻成名字）
 * @param {Object} a - 流水行
 * @param {Object} st - 状态
 * @returns {string} 流水行 HTML
 */
function activityRowHtml(b, a, st) {
  const who = a ? a.display_name || a.username || '' : '';
  const note = a && a.note != null ? String(a.note) : '';
  const rid = a && a.id != null ? Number(a.id) : 0;
  const files = st && st.files === null ? null : filesOfReport(st, rid);
  return (
    '<div class="collab-act">' +
    '<div class="collab-act-meta"><b>' +
    esc(who) +
    '</b> · <span class="collab-act-when">' +
    esc(stampOf(a && a.created_at)) +
    '</span> · <span class="collab-act-move">' +
    esc(statusLabel(b, a && a.from_status)) +
    '→' +
    esc(statusLabel(b, a && a.to_status)) +
    '</span></div>' +
    (note ? '<div class="collab-act-note">' + esc(note) + '</div>' : '') +
    '<div class="collab-files" data-role="act-files" data-report="' +
    esc(String(rid)) +
    '">' +
    fileListHtml(st, b, files) +
    '</div>' +
    (a && isNum(a.task_id) ? fileAddHtml({ role: 'act-file-input', task: Number(a.task_id), report: rid }) : '') +
    '</div>'
  );
}

/**
 * 功能：流水列表（空态 `还没有活动`）。
 * @param {Object} b - 看板响应
 * @param {?Array.<Object>} items - 流水数组（null = 还在读）
 * @param {string} err - 错误文案
 * @param {Object} st - 状态
 * @returns {string} 列表 HTML
 */
function activityListHtml(b, items, err, st) {
  if (err) return '<div class="collab-hint err">' + esc(err) + '</div>';
  if (items === null) return '<div class="collab-hint">' + esc(TXT.loading) + '</div>';
  if (!items.length) return '<div class="collab-hint">' + esc(TXT.noActivity) + '</div>';
  return items.map((a) => activityRowHtml(b, a, st)).join('');
}

/**
 * 功能：评论那一块 —— ⭐ 2g「短视频评论区」样式：评论列表（各自带附件 ＋ 最下面「其他附件」兜底）
 *      ＋ 底部一条输入条（`＋` 选文件 · 圆角单行输入 · `发送`）。
 * 说明：⚠️ 输入框**不许写灰色的占位提示**；待传文件是输入条上方的 chips（可移除，发送前不发请求）。
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {string} 评论块 HTML
 */
function commentBlockHtml(st, scope) {
  const isTask = scope === 'task';
  const inputRole = isTask ? 'task-comment-input' : 'proj-comment-input';
  const pickRole = isTask ? 'task-cmt-file' : 'proj-cmt-file';
  const pendRole = isTask ? 'task-pending' : 'proj-pending';
  return (
    '<div class="collab-sec">' +
    '<div class="collab-sub">' +
    esc(TXT.comment) +
    '</div>' +
    '<div class="collab-cmt-list" data-role="' +
    (isTask ? 'task-comment-list' : 'proj-comment-list') +
    '">' +
    commentAreaHtml(st, scope) +
    '</div>' +
    '<div class="collab-cmt-pend" data-role="' +
    pendRole +
    '">' +
    pendingChipsHtml(st) +
    '</div>' +
    '<div class="collab-cmt-bar">' +
    '<label class="collab-cmt-pick">＋' +
    '<input class="collab-file-input" type="file" multiple data-pend="1" data-role="' +
    pickRole +
    '" hidden>' +
    '</label>' +
    '<input class="collab-cmt-input" type="text" data-role="' +
    inputRole +
    '" maxlength="2000">' +
    '<button class="collab-btn primary" type="button" data-act="collab-comment-send" data-scope="' +
    scope +
    '">' +
    esc(TXT.send) +
    '</button>' +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：活动那一块（该任务 / 整个项目的流水）。
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {string} 活动块 HTML
 */
function activityBlockHtml(st, scope) {
  const isTask = scope === 'task';
  const items = isTask ? st.cardActivity : st.projActivity;
  const err = isTask ? st.cardActivityErr : st.projActivityErr;
  return (
    '<div class="collab-sec">' +
    '<div class="collab-sub">' +
    esc(TXT.activity) +
    '</div>' +
    '<div class="collab-act-list" data-role="' +
    (isTask ? 'task-activity-list' : 'proj-activity-list') +
    '">' +
    activityListHtml(st.board, items, err, st) +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：任务详情弹层里的**状态下拉**（不上自动保存，等「保存」按钮读它）。
 * @param {Object} t - 任务卡片
 * @param {Array.<Object>} states - 状态集
 * @param {boolean} owner - 我是不是所有者
 * @returns {string} 下拉 HTML
 */
function cardStatusPickHtml(t, states, owner) {
  const cur = String(t && t.status != null ? t.status : '');
  const curState = states.find((s) => String(s.key) === cur) || null;
  const locked = !owner && !!curState && String(curState.group) === 'completed';
  let hasCur = false;
  let opts = '';
  for (const s of states) {
    const key = String(s.key == null ? '' : s.key);
    if (!owner && String(s.group) === 'completed') continue;
    if (key === cur) hasCur = true;
    opts +=
      '<option value="' +
      esc(key) +
      '" data-group="' +
      esc(String(s.group)) +
      '"' +
      (key === cur ? ' selected' : '') +
      '>' +
      esc(s.name || key) +
      '</option>';
  }
  if (!hasCur) {
    const label = curState ? curState.name || cur : UNKNOWN_LABEL;
    opts =
      '<option value="" selected disabled data-group="' +
      esc(curState ? String(curState.group) : '') +
      '">' +
      esc(label) +
      '</option>' +
      opts;
  }
  return (
    '<select class="collab-input" data-role="card-status" data-init="' +
    esc(cur) +
    '"' +
    (locked ? ' disabled title="' + esc(OWNER_ONLY) + '"' : '') +
    '>' +
    opts +
    '</select>'
  );
}

/**
 * 功能：任务详情弹层里的**负责人下拉**（不上自动保存，等「保存」按钮读它）。
 * @param {Object} t - 任务卡片
 * @param {Array.<Object>} members - 成员名单
 * @returns {string} 下拉 HTML
 */
function cardAssigneePickHtml(t, members) {
  const cur = isNum(t && t.assignee_id) ? Number(t.assignee_id) : 0;
  const init = cur > 0 ? String(cur) : '';
  let hasCur = false;
  let opts = '';
  for (const m of members) {
    const id = Number(m.user_id);
    if (id === cur) hasCur = true;
    opts +=
      '<option value="' +
      esc(String(id)) +
      '"' +
      (id === cur ? ' selected' : '') +
      '>' +
      esc(m.display_name || m.username || '') +
      '</option>';
  }
  if (!hasCur) opts = '<option value="" selected disabled>' + UNCLAIMED + '</option>' + opts;
  return '<select class="collab-input" data-role="card-assignee" data-init="' + esc(init) + '">' + opts + '</select>';
}

/**
 * 功能：任务详情弹层 —— 最上面是**任务本身**（标题 / 描述 / 任务日 / 截止日 / 状态 / 负责人），
 *      **下面依次是评论、活动**。
 *
 * 说明：⭐ 2026-10-20（「团队协作的任务详情，也要可以编辑任务」）：从前这里只有「状态 / 负责人」
 *      两颗下拉 —— 协作里的人能替别人改状态，却改不了自己建的那条任务的标题和日期。
 *      现在补成**与任务板同一组字段**，一次「保存」只发改动过的那几格（⛔ 不整行覆盖：
 *      四象限 / 标签 / 任务类型 / 绑定网址这些协作侧看不见的列，一个字节都不许动）。
 *      ⚠️⭐ 日期两格**要么都不发、要么一起发**：服务端 `badDateRange` 只在「两个都在请求里」时
 *      才比大小（`checkTaskInput` 的局部更新口径）—— 只发改动的那个，会出现「截止日比库里的
 *      任务日还早」这种它根本看不出来的组合。
 *      ⚠️ 「任务日」不是创建日 —— 它就是任务板那个 `start_date`（甘特条的起点走
 *      `start_date || created_at`）。协作任务从前只能靠创建日兜底，补上这一格条才落得准。
 * @param {Object} st - 状态
 * @param {Object} b - 看板响应
 * @returns {string} 弹层 HTML（找不到那条任务就回空串）
 */
function cardModalHtml(st, b) {
  const t = findTask(b, st.cardFor);
  if (!t) return '';
  const owner = !!(b && b.project && b.project.role === 'owner');
  const ctrl =
    field(
      '标题',
      '<input class="collab-input" data-role="card-title" type="text" maxlength="100" value="' +
        esc(t.title || '') +
        '">',
    ) +
    field(
      '描述',
      '<textarea class="collab-input" data-role="card-desc" maxlength="20000">' + esc(t.description || '') + '</textarea>',
    ) +
    field('状态', cardStatusPickHtml(t, statesOf(b), owner)) +
    field('负责人', cardAssigneePickHtml(t, membersOf(b))) +
    '<div class="collab-field-row" data-role="cd-dates">' +
    field(
      '任务日',
      '<input class="collab-input" data-role="card-start" type="date" value="' + esc(date10Of(t.start_date)) + '">',
    ) +
    field(
      '截止日',
      '<input class="collab-input" data-role="card-due" type="date" value="' + esc(date10Of(t.due_date)) + '">',
    ) +
    '</div>' +
    '<div data-role="cd-kind">' +
    kindBlockHtml('cd', t) +
    '</div>' +
    '<div class="collab-modal-foot">' +
    '<button class="collab-btn primary" type="button" data-act="collab-card-save" data-tid="' +
    esc(t.id != null ? String(t.id) : '') +
    '">保存</button>' +
    '</div>';
  const inner =
    '<div class="collab-card-ctrl">' + ctrl + '</div>' + commentBlockHtml(st, 'task') + activityBlockHtml(st, 'task');
  return showModal(t.title || '未命名任务', inner, 'collab-card-close', 'collab-modal-card');
}

/**
 * 功能：页头那颗 `💬 评论` —— **项目级**评论弹层（与任务级同一套 UI）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function projCommentsModalHtml(st) {
  return showModal(TXT.comment, commentBlockHtml(st, 'proj'), 'collab-comments-close', 'collab-modal-comments');
}

/**
 * 功能：页头那颗 `活动` —— **整个项目**的流水弹层。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML
 */
function projActivityModalHtml(st) {
  return showModal(TXT.activity, activityBlockHtml(st, 'proj'), 'collab-activity-close', 'collab-modal-activity');
}

/**
 * 功能：看板上的弹层（状态 / 新建任务 / 转让 / 任务详情 / 项目评论 / 项目活动）。
 * @param {Object} st - 状态
 * @returns {string} 弹层 HTML（没有打开的就回空串）
 */
function modalsHtml(st) {
  const b = st.board;
  if (!b) return '';
  let html = '';
  if (st.statusOpen) html += stateModalHtml(b);
  if (st.taskOpen) html += taskModalHtml(b);
  if (st.transferOpen) html += transferModalHtml(st, b);
  if (st.membersOpen) html += membersModalHtml(st, b);
  if (st.cardFor) html += cardModalHtml(st, b);
  if (st.promoteFor) html += promoteModalHtml(st, b);
  if (st.delFor) html += delModalHtml(st, b);
  if (st.commentsOpen) html += projCommentsModalHtml(st);
  if (st.activityOpen) html += projActivityModalHtml(st);
  return html;
}

/**
 * 功能：给【＋ 新建任务】弹层接线 —— 任务类型块 ＋「状态选在待排期时藏起日期与类型」。
 *
 * 说明：⚠️ 必须在弹层**进文档之后**调（`paint()` 末尾）—— `bindKindBlock()` 要按 id 找节点、
 *      周期规则编辑器也要在文档里才能挂事件。
 * @param {HTMLElement} root - 本片段的根节点
 * @returns {void}
 */
function bindTaskModal(root) {
  const box = root.querySelector('.collab-modal-task');
  if (!box) return;
  bindKindBlock('tk', '.collab-modal-task [data-role="due"]');
  const sel = box.querySelector('[data-role="status"]');
  const dates = box.querySelector('[data-role="tk-dates"]');
  const kind = box.querySelector('[data-role="tk-kind"]');
  if (!sel) return;
  /**
   * 功能：按选中的状态所属的组，切「日期 ＋ 类型」两块的显隐。
   * @returns {void}
   */
  const sync = () => {
    const opt = sel.selectedOptions ? sel.selectedOptions[0] : null;
    const backlog = opt ? String(opt.dataset.group || '') === 'backlog' : false;
    if (dates) dates.hidden = backlog;
    if (kind) kind.hidden = backlog;
  };
  sel.addEventListener('change', sync);
  sync();
}

/**
 * 功能：给**任务详情**弹层接线 —— 任务类型块 ＋「这条在待排期时藏起日期与类型」。
 *
 * 说明：⚠️ 待排期任务要到【转为任务】那一步才选类型与日期；这条联动与新建弹层同一套判据。
 * @param {HTMLElement} root - 本片段的根节点
 * @returns {void}
 */
function bindCardModal(root) {
  const box = root.querySelector('.collab-modal-card');
  if (!box) return;
  bindKindBlock('cd', '.collab-modal-card [data-role="card-due"]');
  const sel = box.querySelector('[data-role="card-status"]');
  const dates = box.querySelector('[data-role="cd-dates"]');
  const kind = box.querySelector('[data-role="cd-kind"]');
  if (!sel) return;
  /**
   * 功能：按选中的状态所属的组，切「日期 ＋ 类型」两块的显隐。
   * @returns {void}
   */
  const sync = () => {
    const opt = sel.selectedOptions ? sel.selectedOptions[0] : null;
    const backlog = opt ? String(opt.dataset.group || '') === 'backlog' : false;
    if (dates) dates.hidden = backlog;
    if (kind) kind.hidden = backlog;
  };
  sel.addEventListener('change', sync);
  sync();
}

/**
 * 功能：把整块重画一遍（正文整块替换；根节点上的事件委托不受影响）。
 *
 * ⚠️⭐ 2026-10-20（本版质检）：重画之前要**先收两样东西**，重画之后放回去 —— 这里原来是无条件
 *      `root.innerHTML = …`，于是两件很显眼的毛病：
 *      ① **正在打的字没了**：评论输入框 / 【＋ 新建任务】弹层里的标题与截止日只活在 DOM 里
 *         （`st` 里没有草稿），而切窗回来（`visibilitychange` → `reloadBoard()`）、点图例、翻周
 *         都会走这里 ⇒ 打了半天的评论随手一切窗口就**凭空消失**，且没有任何提示。
 *      ② **滚动位置归零**：根节点自己就是 `overflow-y: auto` 的 `.collab-board-block`，
 *         整块替换后 `scrollTop` 变 0 ⇒ 任务一多，点一下图例就被弹回页顶。
 *      ⇒ 这里统一收 / 放：所有带 `data-role` 的输入框（评论、任务标题、描述、截止日、状态、负责人）
 *      与两个滚动容器的偏移。⛔ 别把它做成「每处调用点自己记」—— 那样漏一处就是一个静默丢失。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function paint(root, st) {
  if (!root) return;
  // ⚠️⭐ 0.8.51 修订：卡片弹层里那几格（标题 / 描述 / 两个日期）是**按任务**的草稿，
  //    而 `keep` 是按 `data-role` 收的 —— 换一条任务重画时，会把**上一条任务**的字填进新弹层
  //    （看板数据没变，用户的字就这么「搬」到别人那条上了）。⇒ 收之前先认「画着的还是不是同一条」：
  //    弹层里那颗「保存」带着 `data-tid`。
  const saveBtn = root.querySelector('[data-act="collab-card-save"]');
  const sameCard = !!saveBtn && String(saveBtn.dataset.tid || '') === String(st.cardFor || '');
  // ---- ① 收：输入框里的字（只收**用户可能刚打的**那几个：text / textarea / date / select）
  const keep = new Map();
  for (const el of root.querySelectorAll('[data-role]')) {
    const tag = String(el.tagName || '').toUpperCase();
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) continue;
    const role = String(el.dataset.role || '');
    if (!role) continue;
    // ⚠️ 只收**会丢**的那几种：`type=color` / `file` 不收（重画后由状态决定）。
    const type = String(el.type || '').toLowerCase();
    if (tag === 'INPUT' && type !== 'text' && type !== 'date') continue;
    // ⚠️ 换了另一条任务 ⇒ 卡片那几格**一格都不收**（见上面 `sameCard` 的说明）。
    if (!sameCard && role.indexOf('card-') === 0) continue;
    keep.set(role, String(el.value == null ? '' : el.value));
  }
  const scroller = root;
  const scrollTop = scroller.scrollTop || 0;
  const tl = root.querySelector('.collab-tl');
  const scrollLeft = tl ? tl.scrollLeft || 0 : 0;
  // 焦点落在哪个输入框上（切窗回来时人正要接着打字 ⇒ 把焦点也还回去）
  const active = document.activeElement;
  const focusRole = active && root.contains(active) && active.dataset ? String(active.dataset.role || '') : '';

  // ---- ② 换
  root.innerHTML = '<div class="collab-board-body">' + boardHtml(st) + '</div>' + modalsHtml(st);

  // ---- ③ 放：把字、滚动与焦点还回去
  if (keep.size) {
    for (const el of root.querySelectorAll('[data-role]')) {
      const role = String(el.dataset.role || '');
      if (!keep.has(role)) continue;
      // ⚠️ 状态 / 负责人这两个下拉**不回填**：它们的值由看板数据决定（回填等于把用户的旧选择
      //    硬按在一个可能已经变了的任务上）。评论框与新建任务的文本 / 日期才需要回填。
      if (role === 'card-status' || role === 'card-assignee' || role === 'status' || role === 'assignee') continue;
      el.value = keep.get(role);
    }
  }
  if (scrollTop) root.scrollTop = scrollTop;
  if (scrollLeft) {
    const tl2 = root.querySelector('.collab-tl');
    if (tl2) tl2.scrollLeft = scrollLeft;
  }
  if (focusRole) {
    const back = root.querySelector('[data-role="' + focusRole + '"]');
    if (back && typeof back.focus === 'function') {
      try {
        back.focus({ preventScroll: true });
      } catch (_e) {
        /* 老浏览器不认 preventScroll：忽略（位置已经还原过了） */
      }
    }
  }
  // ---- ④ 弹层联动（0.8.53）：任务类型块 ＋「待排期时藏起日期与类型」。
  //    ⚠️ 每次重画都是**新节点**，所以监听随新节点重建；旧的随旧节点一起丢掉，不会累积。
  if (st.taskOpen) bindTaskModal(root);
  if (st.cardFor) bindCardModal(root);
  if (st.promoteFor) bindKindBlock('pm', '.collab-modal-promote [data-role="pm-due"]');
}

// ================================================================ 交互

/**
 * 功能：关掉所有弹层与展开中的小表单。
 * @param {Object} st - 状态
 * @returns {void}
 */
function closeAllModals(st) {
  st.statusOpen = false;
  st.taskOpen = false;
  st.transferOpen = false;
  st.addOpen = false;
  st.membersOpen = false;
  st.cardFor = 0;
  st.promoteFor = 0;
  st.delFor = 0;
  st.commentsOpen = false;
  st.activityOpen = false;
}

/**
 * 功能：开**任务详情**弹层 —— 先摆出「正在读取…」，再分别把评论与流水补进去。
 * 说明：⭐ 取数完成后只换弹层里那两块（`fillComments` / `fillActivity`），
 *      ⛔ 不整屏重画（`openCardModal` 那一发 `paint` 是首帧骨架）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} tid - 任务 id
 * @returns {void}
 */
function openCardModal(root, st, tid) {
  const id = Number(tid);
  if (!Number.isInteger(id) || id <= 0) return;
  closeAllModals(st);
  st.cardFor = id;
  st.cardComments = null;
  st.cardCommentsErr = '';
  st.cardActivity = null;
  st.cardActivityErr = '';
  st.pending = [];
  paint(root, st);
  ensureFiles(root, st);
  loadComments(st, 'task').then(() => fillComments(root, st, 'task'));
  loadTaskActivity(st).then(() => fillActivity(root, st, 'task'));
}

/**
 * 功能：开**项目级评论**弹层（骨架先出，评论随后补进来）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function openProjectComments(root, st) {
  closeAllModals(st);
  st.commentsOpen = true;
  st.projComments = null;
  st.projCommentsErr = '';
  st.pending = [];
  paint(root, st);
  ensureFiles(root, st);
  loadComments(st, 'proj').then(() => fillComments(root, st, 'proj'));
}

/**
 * 功能：开**整项目流水**弹层（骨架先出，流水随后补进来）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function openProjectActivity(root, st) {
  closeAllModals(st);
  st.activityOpen = true;
  st.projActivity = null;
  st.projActivityErr = '';
  paint(root, st);
  ensureFiles(root, st);
  loadProjectActivity(st).then(() => fillActivity(root, st, 'proj'));
}

/**
 * 功能：只换评论列表那一块（发 / 删评论后的收尾；栏里没有它就什么也不做）。
 * 说明：⭐ 2g —— 列表里每条评论都带自己的附件，最下面还有「其他附件」兜底，整块一起重画。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {void}
 */
function fillComments(root, st, scope) {
  const isTask = scope === 'task';
  const el = root.querySelector(isTask ? '[data-role="task-comment-list"]' : '[data-role="proj-comment-list"]');
  if (!el) return;
  el.innerHTML = commentAreaHtml(st, scope);
}

/**
 * 功能：只换输入条上方那排待传文件的 chips（选 / 撤文件后调用）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function fillPending(root, st) {
  const html = pendingChipsHtml(st);
  for (const role of ['task-pending', 'proj-pending']) {
    const el = root.querySelector('[data-role="' + role + '"]');
    if (el) el.innerHTML = html;
  }
}

/**
 * 功能：只换流水列表那一块。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {void}
 */
function fillActivity(root, st, scope) {
  const isTask = scope === 'task';
  const el = root.querySelector(isTask ? '[data-role="task-activity-list"]' : '[data-role="proj-activity-list"]');
  if (!el) return;
  el.innerHTML = activityListHtml(
    st.board,
    isTask ? st.cardActivity : st.projActivity,
    isTask ? st.cardActivityErr : st.projActivityErr,
    st,
  );
}

/**
 * 功能：附件变了之后只补相关的那几块 —— ⭐ 2g：评论区（每条评论自己的附件 ＋ 兜底块）
 *      与每条流水自己那一拨。
 * 说明：⚠️ 元素不在（那一档弹层没开）时静默跳过，⛔ 不整屏重画。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {string} scope - `task` 或 `proj`
 * @returns {void}
 */
function fillFileArea(root, st, scope) {
  fillComments(root, st, scope);
  fillActivity(root, st, scope);
}

/**
 * 功能：只换成员块里那一行上传用量。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function fillUsage(root, st) {
  const el = root.querySelector('[data-role="collab-usage"]');
  if (el) el.innerHTML = usageInnerHtml(st, st.board);
}

/**
 * 功能：就地刷新一条甘特条的 `title`（⭐ 不重画整块看板）。
 *
 * 说明：⭐ 本轮 `💬 n` / `📎 n` 从「行上一个角标」搬进了**条的 `title`**（条里写任务名，放不下角标）——
 *      所以发 / 删评论、增删附件之后就地把提示语重算一遍，⛔ 不用整块闪。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {number|string} tid - 任务 id
 * @returns {void}
 */
function refreshBarTip(root, st, tid) {
  // ⚠️⭐ 2026-10-20（本版质检）：**周期任务在甘特图上是「一期一段」**（同一个 `data-tid` 有多条条），
  //    而这里原来只取 `querySelector()` 命中**第一条**、并用普通的 `barTip()` 覆盖它的 `title` ——
  //    于是发 / 删一条评论之后，周期的第一段提示从
  //    「🔁 名（3/10）· 本期 10/5~10/7：已打卡」变成「名 · 负责人 · 截止 … 💬 1 · 📎 0」，
  //    其余段还是旧文案（同一张图里两种口径）。段条的提示语由 `barHtml()` 的周期分支生成，
  //    `barTip()` 根本不知道「本期」那几句 —— 所以这里**跳过段条**，只刷普通条 / 窗口条。
  const bar = root.querySelector('.collab-tl-bar[data-tid="' + Number(tid) + '"]:not(.tl-seg)');
  if (!bar) return;
  const x = allBoardTasks(st.board).find((y) => Number(y.t && y.t.id) === Number(tid));
  if (!x) return;
  bar.title = barTip(st.board, x);
}

/**
 * 功能：上传 / 删除附件之后的收尾 —— 把 `file_count` 与用量对齐，并只补相关的那几块。
 *
 * 说明：⚠️ 两处都要动 —— 条上的 `title` 是「就地改」不让整块闪；`st.board` 里每条任务的
 *      `file_count` 是给**下一次** `paint`（比如关掉弹层）用的，否则那一发重画会把提示语退回旧数。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function afterFilesChanged(root, st) {
  if (st.board) {
    for (const x of allBoardTasks(st.board)) {
      const n = taskFileCount(st, x.t.id);
      x.t.file_count = n;
      refreshBarTip(root, st, x.t.id);
    }
  }
  fillUsage(root, st);
  if (st.cardFor) fillFileArea(root, st, 'task');
  if (st.commentsOpen) fillFileArea(root, st, 'proj');
  if (st.activityOpen) fillFileArea(root, st, 'proj');
}

/**
 * 功能：发 / 删一条**任务级**评论后，把条的 `title` 与 `st.board` 里的 `comment_count` 一起对齐。
 *
 * 说明：⚠️ 两处都要动 —— `title` 是「就地改」不让整块闪；`st.board` 是给**下一次** `paint`
 *      （比如关掉弹层）用的，否则那一发重画会把提示语退回旧数（取数没重跑，data 是旧的）。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @returns {void}
 */
function syncCommentCount(root, st) {
  if (!Array.isArray(st.cardComments)) return;
  const n = st.cardComments.length;
  const t = findTask(st.board, st.cardFor);
  if (t) t.comment_count = n;
  refreshBarTip(root, st, st.cardFor);
}

/**
 * 功能：只开其中一个弹层（先把别的都关掉）。
 * @param {Object} st - 状态
 * @param {string} which - 要打开的入口（`statusOpen` / `taskOpen` / `transferOpen`）
 * @returns {void}
 */
function showModalOnly(st, which) {
  closeAllModals(st);
  st[which] = true;
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
  // 点遮罩空白处 = 关掉弹层（面板里的点击另有 data-act，不会命中这里）
  if (el && el.classList && el.classList.contains('modal')) {
    closeAllModals(st);
    paint(root, st);
    return;
  }
  const t = el && el.closest ? el.closest('[data-act]') : null;
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'collab-board-reload') loadBoard(root, st);
  else if (act === 'collab-gcol') {
    // ⭐⭐ 0.8.17：点某一列 ⇒ **只**把那一列的列头高亮 ——
    //    ⛔ 不换屏（照任务板「点日期只选中、不换屏」）、⛔ 不新增筛选语义。
    //    ⚠️⭐ 必须**就地改 class**（`classList.toggle`），⛔ 别调 `paint()` 整块重画 ——
    //    重画会把 `.collab-tl` 的横向滚动位置打回最左（与任务板 `renderTimeline()`
    //    末尾那段注释同因）。`selected` 存的是**天序号**，所以要从这一列的列号推回去。
    const col = Number(t.dataset.col);
    if (Number.isInteger(col) && col >= 0 && col < WEEK_DAYS) {
      st.selected = curWeekStart(st) + col;
      const head = t.closest('.collab-tl-head');
      if (head) head.querySelectorAll('.collab-tl-col').forEach((c, i) => c.classList.toggle('sel', i === col));
    }
  } else if (act === 'collab-glegend') {
    st.filter = t.dataset.group || 'all';
    paint(root, st);
  } else if (act === 'collab-gweek-prev') {
    // ⚠️ 起点必须与**画出来的那个周**同源（`curWeekStart`），⛔ 别自己再算一遍 ——
    //    两处口径一旦漂移，用户按一下 `«` 就会跳到毫无关系的一周。
    st.weekStart = curWeekStart(st) - WEEK_DAYS;
    paint(root, st);
  } else if (act === 'collab-gweek-next') {
    st.weekStart = curWeekStart(st) + WEEK_DAYS;
    paint(root, st);
  } else if (act === 'collab-gweek-today') {
    // ⭐⭐ 2026-10-20：进来的默认周就是**本周**（`weekStartOf()`），这颗按钮的语义
    //    就是「翻回本周」—— 必须写死本周的周一，⛔ 不要写 `null`（`null` 的含义是「还没翻过」，
    //    虽然结果同样是本周，但少了这一步之后就没法一眼看出「用户已经手动看过别的周了」）。
    st.weekStart = mondayOfIndex(todayIndex());
    paint(root, st);
  } else if (act === 'collab-members-open') {
    closeAllModals(st);
    st.membersOpen = true;
    paint(root, st);
    ensureFiles(root, st);
  } else if (act === 'collab-members-close') {
    st.membersOpen = false;
    paint(root, st);
  } else if (act === 'collab-state-open') {
    showModalOnly(st, 'statusOpen');
    paint(root, st);
  } else if (act === 'collab-state-close') {
    st.statusOpen = false;
    paint(root, st);
  } else if (act === 'collab-state-add') addState(root, st);
  else if (act === 'collab-state-save') saveState(root, st, t);
  else if (act === 'collab-state-del') deleteState(root, st, t);
  else if (act === 'collab-task-open') {
    showModalOnly(st, 'taskOpen');
    paint(root, st);
  } else if (act === 'collab-task-close') {
    st.taskOpen = false;
    paint(root, st);
  } else if (act === 'collab-task-save') createTask(root, st);
  else if (act === 'collab-transfer-open') {
    showModalOnly(st, 'transferOpen');
    paint(root, st);
  } else if (act === 'collab-transfer-close') {
    st.transferOpen = false;
    paint(root, st);
  } else if (act === 'collab-transfer-save') transferProject(root, st);
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
  else if (act === 'collab-card-open') openCardModal(root, st, t.dataset.tid);
  else if (act === 'collab-promote-open') {
    // ⭐ 0.8.53：待排期列表里那一颗【转为任务】—— 先关掉别的弹层，再开它
    closeAllModals(st);
    st.promoteFor = Number(t.dataset.tid) || 0;
    paint(root, st);
  } else if (act === 'collab-promote-close') {
    st.promoteFor = 0;
    paint(root, st);
  } else if (act === 'collab-promote-save') promoteTask(root, st);
  // ⭐ 0.8.54：删待排期 —— 先开确认弹层（记下是哪条），确认后才真删
  else if (act === 'collab-task-del') {
    closeAllModals(st);
    st.delFor = Number(t.dataset.tid) || 0;
    paint(root, st);
  } else if (act === 'collab-task-del-close') {
    st.delFor = 0;
    paint(root, st);
  } else if (act === 'collab-task-del-go') deleteBacklogTask(root, st);
  else if (act === 'collab-card-close') {
    st.cardFor = 0;
    paint(root, st);
  } else if (act === 'collab-card-save') saveCard(root, st);
  else if (act === 'collab-comments-open') openProjectComments(root, st);
  else if (act === 'collab-comments-close') {
    st.commentsOpen = false;
    paint(root, st);
  } else if (act === 'collab-activity-open') openProjectActivity(root, st);
  else if (act === 'collab-activity-close') {
    st.activityOpen = false;
    paint(root, st);
  } else if (act === 'collab-comment-send') sendComment(root, st, t.dataset.scope);
  else if (act === 'collab-comment-del') deleteComment(root, st, t.dataset.cid, t.dataset.scope);
  else if (act === 'collab-pending-del') removePending(root, st, t.dataset.idx);
  else if (act === 'collab-file-dl') downloadFile(t.dataset.fid);
  else if (act === 'collab-file-del') deleteFile(root, st, t.dataset.fid);
}

/**
 * 功能：下拉改变的委托入口 —— 只认文件框（选附件即上传 / 评论输入条的 `＋` 先攒起来）。
 * 说明：⭐ 本轮起「改状态 / 改负责人」不再摆在看板行上，统一在**任务详情弹层**里改
 *      （点甘特图的一行开它），所以这里不再有 `collab-set-status` / `collab-set-assignee` 两档。
 * @param {HTMLElement} root - 本片段的根节点
 * @param {Object} st - 状态
 * @param {Event} e - 改变事件
 * @returns {void}
 */
function onChange(root, st, e) {
  const el = e.target;
  // ⭐ 2f：选完附件就上传（文件框挂在弹层里，事件冒泡到这里）；
  // ⭐ 2g：评论输入条那颗 `＋` 是**先攒起来**（`data-pend="1"`），点 `发送` 时才先建评论再挂附件。
  if (el && el.classList && el.classList.contains('collab-file-input')) {
    if (el.dataset && el.dataset.pend === '1') addPendingFiles(root, st, el);
    else uploadFile(root, st, el);
  }
}

/**
 * 功能：渲染电脑版协作看板的插槽片段（`core/slots.js` 的挂载入口）。
 *
 * 说明：⚠️ 项目编号从 `ctx.collabPid` 拿（宿主写进来的「点开的是哪一条」）——
 *      本片段不认识左栏、也不认识宿主，槽里只有一个「画哪个项目」的入参。
 *
 * @param {Object} ctx - 挂载上下文（`{ end, modules, uiOf, me, collabPid }`）
 * @returns {HTMLElement} 本片段的根节点
 */
export function render(ctx) {
  const root = document.createElement('div');
  root.className = 'collab-board-block';
  const st = createState(ctx);
  root.addEventListener('click', (e) => onClick(root, st, e));
  root.addEventListener('change', (e) => onChange(root, st, e));
  // ⭐ 本轮「没有实时刷新」：**切回这一屏时重取一次**（`loadBoard` 会先摆「正在读取…」，
  //   这里用 `reloadBoard`（静默取完再重画一次）⇒ 不整块闪；节点已摘掉就不再白跑一次。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && root.isConnected) reloadBoard(root, st);
  });
  paint(root, st);
  const loaded = loadBoard(root, st);
  // ⭐⭐ 0.8.53（团队协作的项目里也要有 + 图标可以新建任务）：宿主从**项目行**那颗
  //    ＋ 进来时，看板挂载上下文带 `openNew` —— 等看板数据到手再把【新建任务】弹层打开
  //    （新建弹层要用状态集与成员名单，数据没到就弹不出来）。
  if (ctx && ctx.openNew) {
    loaded.then(() => {
      if (!root.isConnected || !st.board) return;
      st.taskOpen = true;
      paint(root, st);
    });
  }
  ensureFiles(root, st);
  return root;
}
