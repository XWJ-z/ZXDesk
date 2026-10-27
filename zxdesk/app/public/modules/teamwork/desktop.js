/**
 * modules/teamwork/desktop.js —— 对话**视图**（电脑版，0.3.5）
 *
 * 功能：电脑版「对话」这一屏的全部取数与渲染 ——
 *      `openTeamwork()` 开屏（拉好友总览 + 接上实时通道），`teamworkLeave()` 离开时收尾（⭐ 0.5.2 起不停通道），
 *      `renderTeamworkSide()` 画左栏（⭐ 0.7.6 起只有**会话区** + 顶部两颗入口按钮；⭐ 2h 起会话区是三组：
 *      「内置助手」「好友」「协作项目」），`renderTeamworkHead()` / `renderTeamworkMessages()`
 *      画右边的对话流，`openConversation()` / `openTeamworkWithFriend()` 打开一个会话，
 *      `sendTeamworkMessage()` 发消息，`bindTeamworkEvents()` 给整屏挂**一次性**事件委托。
 *
 * ⭐ **实时通道走 `modules/teamwork/teamwork-stream.js`**（两端共用）：它负责连、重连、降级轮询与 `mergeById()` 去重；
 *    本文件只负责「收到事件之后该刷哪块界面」。历史消息**永远不走 SSE**（只走 REST 分页），
 *    所以这里没有第二处「消息怎么取」的实现。
 *
 * ⚠️ **三条界面硬约定**（方案 §七 / §八，别被后来的人改掉）：
 *    ① ⭐ **消息正文一律 `esc()` 转义后插入**（`body` / `username` / `display_name` 都是**别人可控**的内容）——
 *       这是本项目第一次出现「A 的内容给 B 看」，XSS 是本模块的头号风险（方案）；
 *    ② ⚠️⭐ **2026-10-04：页头那颗常驻「连接状态」徽标已整颗移除**（原约定是
 *       「连接状态必须看得见」，要求删掉）—— 电脑端从此没有常驻连接提示
 *       （重连中 / 已降级为轮询也不再显示，别当成缺陷往回调）。手机端另有「只在异常时出现」
 *       的告警条（`#teamwork-netwarn`），电脑端目前没有对应物；
 *    ③ ⭐ **适用范围那句常驻**（`index.html` 的 `.teamwork-privacy`）—— 稿为
 *       「仅ZXDesk成员可互相加好友，仅用于团队间的任务下达和协作交流」（原先放的是
 *       「消息以明文存在你自己的 NAS 上」那句，方案 §八-6）。⭐ 0.4.4 起它贴在**「对话」标题右边**
 *       （「移动到 对话旁边」），不再占标题下面那一条。⚠️ 那句诚实边界**仍要出现在界面上**：
 *       `confirmRemoveFriend()` 的确认框里写着「消息一条都没删 —— 它仍然以明文存在你自己的 NAS 上」，
 *       手机版列表页也照旧显示 —— 别因为顶栏换了文案就对用户说「加密聊天」。
 *
 * ⭐ **0.4.4 的三处新交互**（四条需求里的三条落在这里，第四条是备注的显示规则）：
 *    ④ **会话区可折叠** —— 折叠态存在 `teamworkState.fold` 里，**不是 DOM class**：
 *       左栏每收一条消息就整块重画，状态放 DOM 上会被下一次重画抹掉（表现是「一有新消息，
 *       收起来的那块又自己弹开了」）。⭐ 收起只影响**列表**，分区标题里的计数始终可见。
 *       ⚠️⭐ 0.7.6 起「好友」「申请」两块不再内联（改成两颗按钮 + 弹窗，见 `openTeamworkFriendsModal()` /
 *       `openTeamworkRequestsModal()`）；⭐ 0.7.7 起会话列表**拆成两段**（「内置助手」/「好友」，
 *       判据走 `shared.js` 的 `isAssistConv()`）⇒ `teamworkState.fold` 现在是 `assist` / `convs` 两个键。
 *       ⚠️ 而**申请按钮上的红点在左栏始终看得见**（这一点与原「收起 ≠ 藏红点」同源）。
 *    ⑤ **右键消息 → 添加到任务** —— 菜单里还有一条「复制文本」：拦下右键就顶掉了浏览器原生菜单，
 *       不给复制通道的话，用户在这屏再也复制不走消息（`core/dom.js` 的 `copyText()` 带兜底）。
 *    ⑥ **我起的备注优先于对方的显示名**（`teamworkRowName()`，0.4.4 服务端加 `teamwork_friendships.remark`）——
 *       ⚠️ 备注只写我这一行，**对方看不到**（服务端 `teamworkSetFriendRemark()` 有说明），
 *       所以界面上「左栏显示的名字」与「对话头显示的名字」必须都走同一个函数，不许各处自己拼。
 *
 * ⭐ **0.5.2 起通道是应用级常驻的**（`teamworkBoot()` 登录后开一条，`teamworkShutdown()` 只在
 *    「设置里关掉对话模块」时调）：一台设备任何时刻只有一条，服务端每账号 5 条的
 *    名额（`server.js` → `modules/teamwork/stream.js` 的连接表）毫无压力。
 *    旧的「离开这一屏必须 `stream.stop()`」口径已废 —— 那样做红点/实时性要靠
 *    「记得重新开」来维持，漏一处就是静默失联。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/desktop/views/teamwork.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 前端两屏跟着模块走，
 *    `public/modules/` 与后端 `app/modules/` 模块名对齐。只改了文件头路径、相对 import 与这段说明，
 *    渲染与交互一个字没动。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.1
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 */

// ⭐ 0.8.54：图片上传走裸 `fetch`（`api()` 只发 JSON）⇒ 挂载前缀 `BASE` 与 401 跳登录要自己接。
import { BASE, api, backToLogin } from '../../core/api.js';
// ⭐ 0.7.1：新建任务统一走共用层那个入口（不许跨模块 import 实现，所以它在 `core/`）
import { createTask } from '../../core/task-create.js';
// ⭐ 0.5.2 第二轮：消息转任务的弹窗也能绑网址（「添加消息到任务的弹窗
//    没有选择网址的能力」）—— 实现与任务表单共用 core 一份（见 core/bookmarks.js 的说明）。
import { fillBookmarkSelect } from '../../core/bookmarks.js';
import { createTeamworkStream, mergeById } from './teamwork-stream.js';
import { todayStr } from '../../core/date.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { loadProjects, renderSidebar, setTeamworkUnread, showView } from '../../desktop/shell.js';
// ⭐ 0.6.0：对话页是 AI 插槽的**宿主**—— 本文件只认识通用的 slots 宿主与本端接线表，
//    **不 import 任何具体模块的片段**（删掉那个模块目录后对话页必须照常能用）。
import { uiOf } from '../../desktop/modules.js';
import { mountSlots, warmSlots } from '../../core/slots.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import { openBoard } from '../tasks/desktop-board.js';
import { bindDateRangeMin } from '../tasks/desktop-forms.js';
import { openTaskDetail } from '../tasks/desktop-items.js';
// ⭐ 0.6.4（任务联动）：任务卡片的渲染与动作 —— 与手机版**共用一份**（见 `shared.js` 的说明）
// ⭐ 0.7.7：四种**系统提醒**的卡片同样共用一份（理由一字不差：两端必须长得一样）；
//    `isAnyCardMsg()` 是「卡片 → `.teamwork-msg.is-card`」那一步的判据，`isAssistConv()` 是
//    「内置助手 / 好友」两段的判据 —— ⛔ 两处判断都不许在本文件里再写一遍。
// ⭐ 0.8.54：图片消息（`isImageMsg` / `imageMsgHtml`）、点开看大图（`bindImageZoom`）与
//    任务选择弹窗（`pickListHtml`）同样两端一份 —— 理由与卡片一字不差。
import {
  bindImageZoom,
  // ⭐ 0.8.54：取数（`fetchSendGroups`）与筛选（`filterPickGroups` / `pickPanelHtml`）也共用了
  //    —— 两端原本是一字不差的两份复制，改一处忘另一处就会「电脑端有、手机端没有」。
  fetchSendGroups,
  filterPickGroups,
  imageMsgHtml,
  isAnyCardMsg,
  isAssistConv,
  isCardMsg,
  isImageMsg,
  isRemindMsg,
  pickListHtml,
  pickPanelHtml,
  remindCardHtml,
  runCardAction,
  taskCardHtml,
} from './shared.js';

/** 一次拉多少条消息（服务端默认 50、上限 200 —— 历史与首屏都用这一页大小） */
const TEAMWORK_PAGE_SIZE = 50;

/**
 * 「消息转任务」时标题的截断长度 —— 必须与 `validate.js` 的 `MAX_NAME`（100）一致：
 * 超长时服务端**报 400 不静默截断**，所以在弹窗里就截好，别让用户填完才吃一个错误。
 */
const TEAMWORK_TASK_TITLE_MAX = 100;

/**
 * 对话这一屏的临时状态。
 *
 * ⚠️ **刻意不放进 `desktop/state.js`**：`state` 是「多个视图都要读」的共享真值，
 * 而这里的每一项（当前会话、消息列表、连接句柄）只有本屏自己用 ——
 * 放进去只会让「谁在读它」变得需要全仓库搜索。连接句柄更是本模块的私有资源。
 *
 * @type {Object}
 */
const teamworkState = {
  friends: [], // 好友（含 conversation_id / unread）
  incoming: [], // 待我处理的申请
  outgoing: [], // 我发出的申请
  blocked: [], // 我拉黑的人
  conversations: [], // 会话列表（含未读数与最后一条摘要）
  unreadTotal: 0, // 未读合计（会话区头部显示）
  activeConvId: null, // 当前打开的会话 id
  messages: [], // 当前会话的消息（**按 id 升序**，与接口一致）
  hasMore: true, // 还能不能继续往上翻历史
  loadingMore: false, // 正在翻历史（防止一次滚动触发多次请求）
  opening: false, // 正在开新会话（防止连点好友行造出两次 POST）
  stream: null, // `createTeamworkStream()` 的句柄（⭐ 0.5.2 起应用级常驻，见 `teamworkBoot()`）
  /**
   * ⭐ 0.5.2 `teamworkBoot()` 是否已经跑过（幂等闸门）。`teamworkShutdown()` 里复位：
   * 模块被关掉再重新打开时，引导要能重新走一遍。
   */
  booted: false,
  /**
   * ⭐ 左栏三组的折叠态（`assist` = 内置助手、`convs` = 好友、`collab` = 协作项目）。
   *
   * ⚠️⭐ 0.7.6 起「好友」「申请」不再内联（改成两颗按钮 + 弹窗，「折叠一块按钮」没有意义）。
   *    ⛔ 别把 `friends` / `reqs` 加回来 —— 那是永远不会被读的死状态，下次改的人会以为它还在起作用。
   * ⚠️⭐ 0.7.7 拆组时**必须先在这里加上 `assist`**：`toggleTeamworkFold()` 只认这个对象里**已经有的键**
   *    （见它的说明），漏加的表现是「点标题没反应」，而且**不报错**。
   * ⚠️ 必须住在 state 里、不能只改 DOM class：左栏每收一条消息就整块 `innerHTML` 重画，
   *    状态放 DOM 上会被下一次重画抹掉 —— 表现是「一有新消息，收起来的那块又自己弹开了」。
   * ⚠️ 与手机版 `state.foldSecs` 同一个套路（0.3.3 设置页折叠），只是各自存各自的 key。
   */
  fold: { assist: false, convs: false, collab: false },
  /**
   * ⭐ 0.6.x「会话对象插槽」（0.6.1）：`slotEntries` 是**当前登记进会话区的
   *    插槽条目**（键 → `{ key, icon, name, sub }`，由 `zx:teamwork-conv-entries` 留白事件收集，
   *    每次重画左栏都会重新收集 —— 条目是纯展示数据，行为在 `openSlotConv()`）；
   *    `slotConv` 是**当前打开的插槽会话**（键）：它非空时右栏的对话流与输入区整个让位给
   *    `teamwork-thread` 插槽片段（`setSlotMain()`），再点一条真会话就还回来（`closeSlotConv()`）。
   * ⚠️ 两个都必须住 state：左栏整块 `innerHTML` 重画，放 DOM 上会被抹掉（与 `fold` 同一条理由）。
   */
  slotEntries: new Map(),
  slotConv: null,
  /**
   * ⭐ 2h（丁 · 排版）「协作项目组」：`collabEntries` 是**当前登记进左栏第三组的协作项目**
   *    （键 → `{ key, name, sub }`，由 `zx:teamwork-collab-entries` 留白事件收集 ——
   *    派发方是本文件、填写方是 tasks 模块的 page 片段；⚠️ 宿主**不认识 `tasks` 这个东西**，
   *    ⇒ 这一组空着、其它一切照旧）；
   *    `collabBoard` 是**当前打开的协作看板**（项目 id 字符串）：它非空时右栏的对话流与输入区
   *    整个让位给 `teamwork-board` 插槽片段（`setSlotMain()`），点一条真会话就还回来（`closeCollabBoard()`）。
   * ⚠️ 两个都必须住 state：左栏整块 `innerHTML` 重画，放 DOM 上会被抹掉（与 `slotEntries` 同一条理由）。
   * ⚠️ 与「插槽会话」（`slotConv`）**互斥**：同一时刻只许有一个占着主区。
   */
  collabEntries: new Map(),
  collabBoard: null,
  /**
   * ⭐ 0.4.4「这条消息建过哪些任务」—— `{ 消息 id: [{ scope, id, title }] }`。
   * ⚠️ **刻意不挂在消息对象上**：同一条消息会从 REST 与 SSE 两条路到达，而 `mergeById()`
   *    是「后到的整个对象覆盖先到的」，SSE 那条不带标记 ⇒ 挂上去会把标记抹掉（时有时无）。
   */
  msgTasks: {},
};

// ⭐ 2h（丁 · 排版）：第三组「协作项目」的折叠键就住在上面那个对象里（`collab`）——
//    ⚠️ 它必须**预先登记**：`toggleTeamworkFold()` 只认 `teamworkState.fold` 里**已经有的键**，
//    漏加的表现是「点标题没反应」，而且**完全不报错**。

/**
 * 功能：右键菜单的当前现场（同一时刻只会有一个）—— 元素与三个「该收起」的监听器。
 * 说明：⚠️ 监听器必须**成对地挂上与摘掉**（`closeTeamworkMenu()` 里逐个 `removeEventListener`）：
 *      `document` 上的 `click` / `keydown` 是长期存在的节点，漏摘一次就多一个再也不走的处理器。
 * @type {{ el: ?HTMLElement, onDoc: ?Function, onKey: ?Function, onScroll: ?Function }}
 */
const teamworkCtx = { el: null, onDoc: null, onKey: null, onScroll: null };

/**
 * 功能：取一段关系（好友行 / 会话行）该显示的名字 —— ⭐ 0.4.4 起**我起的备注优先**，
 *      没有备注才回落到对方的显示名 / 登录名。
 *
 * 说明：⚠️ 三种行的字段名不一样，这里必须一次收齐，否则就会在某一处「忘了备注」：
 *      · 好友行（`GET /api/teamwork/friends` 的 `friends[i]`）—— `remark` + `user`；
 *      · 会话行 —— `peer_remark` + `peer_user`（服务端 `teamworkListConversations()` 补的）。
 *      ⚠️ 备注是**我单方面**的（只在我这一行），所以它天然只影响我看到的界面。
 *
 * @param {Object} row - 好友行或会话行
 * @returns {string} 可显示的名字
 */
function teamworkRowName(row) {
  const o = row || {};
  // ⭐ 0.6.x：内置角色会话（提醒助手）**最先判** —— 它既没有 `peer_user`、也没有 `peer_gone`，
  //    落到下面任何一支都会得到一个含义不明的名字（『?』或『（账号已不可见）』）。
  //    名字由**服务端**随会话行给出（`builtin_name`），前端不另写一份 —— 见 `modules/teamwork/store.js`。
  if (o.builtin_key) return String(o.builtin_name || '助手');
  if (o.peer_gone) return teamworkConvName(o);
  const remark = o.remark || o.peer_remark;
  if (remark) return String(remark);
  return o.peer_user !== undefined ? teamworkConvName(o) : teamworkPeerName(o.user);
}

/**
 * 功能：把两种来源的消息**归一成同一个形状** —— REST 的 `user_id` / `conversation_id` / `created_at`
 *      与 SSE 的 `senderId` / `conversationId` / `createdAt` 必须变成同一套字段名才能交给 `mergeById()`。
 *
 * 说明：⭐ 这是「按 id 去重」能成立的前提：`mergeById()` 只按 `id` 合并，**同一条消息从两条路到达时
 *      会以后到的那个对象为准** —— 两边字段名不一致的话，界面会在「自己的消息」与「对方的消息」之间闪。
 *
 * ⚠️ **`senderId` 这一支绝不能漏**（0.3.5 修的真实缺陷）：REST 返回的是库里的列名 `user_id`，
 *    而 SSE 事件体（本模块 `routes.js` 的 `pushMessage()`）与「自己刚发出去的那条」用的都是 `senderId`。
 *    漏掉它的后果不是报错，而是 `Number(undefined) = NaN` ⇒ `teamworkMsgHtml()` 里
 *    `NaN === myUserId()` 恒为 false ⇒ **自己发的消息显示在左边（成了对方的消息）**，
 *    直到下一次走 REST 取数（重新打开会话 / 断线补齐）才自己好 —— 表现就是
 *    「有几率我的消息跑到对方那边，刷新一下又好了」，前端不报任何错。
 *
 * @param {Object} m - 任一种来源的消息行
 * @returns {{ id: number, userId: number, conversationId: number, body: string, createdAt: string,
 *      senderBuiltin: ?string }} 归一后的消息
 */
function normMsg(m) {
  const o = m || {};
  // ⚠️ 三个候选键的**优先级不能调换**：`userId`（已归一过的列表再加一次）>
  //    `senderId`（SSE / 本地乐观插入）> `user_id`（REST 的库列名）
  const sender = o.userId !== undefined ? o.userId : o.senderId !== undefined ? o.senderId : o.user_id;
  return {
    id: Number(o.id),
    userId: Number(sender),
    conversationId: Number(o.conversationId !== undefined ? o.conversationId : o.conversation_id),
    body: String(o.body == null ? '' : o.body),
    createdAt: o.createdAt !== undefined ? o.createdAt : o.created_at,
    // ⭐ 0.6.x：内置角色（提醒助手）发的消息 —— **REST 的 `sender_builtin` 与 SSE 的
    //    `senderBuiltin` 两个名字都要认**（与 `sender` 是同一个坑、同一套理由）。
    //    ⚠️ 漏认的后果不是报错，而是**提醒消息被画成「我自己发的」**（靠右、和自己一个颜色）：
    //    因为内置角色消息的 `user_id` 就是收件人自己（见 `teamwork_messages` 的建表说明）。
    senderBuiltin: o.senderBuiltin !== undefined ? o.senderBuiltin : o.sender_builtin || null,
    // ⭐⭐ 0.7.7：**卡片的两个字段必须一起带过去** —— `kind`（画哪一种卡片）与 `meta`
    //    （任务卡片的快照载荷）。⚠️⭐ 漏这两行的后果**不是报错**：消息会安静地退回降级文本
    //    （一条普通气泡 + 它的 `body`），而「任务卡片 / 四种提醒卡片在**电脑端**永远画不出来」
    //    —— 手机端不经过本函数（它直接读消息行），所以别人只会看到「手机上有卡片、电脑上没有」。
    //    ⚠️ `kind` 在 REST（库列名）与 SSE 里**同名**，所以只需认一个；`meta` 由服务端解析成对象。
    kind: o.kind == null ? null : o.kind,
    meta: o.meta === undefined ? null : o.meta,
  };
}

/**
 * 功能：当前登录账号的 id（0 表示还没读到 `/api/auth/me`）。
 * @returns {number} 账号 id
 */
function myUserId() {
  return state.me ? Number(state.me.id) : 0;
}

/**
 * 功能：取一个跨账号传过来的账号对象的**显示名**（显示名 → 登录名 → 占位）。
 * @param {?Object} u - `{ id, username, display_name, last_login_at }`
 * @returns {string} 可显示的名字
 */
function teamworkPeerName(u) {
  const o = u || {};
  return o.display_name || o.username || '（账号已不可见）';
}

/**
 * 功能：取一个**会话**里对方的名字 —— ⚠️ 对方账号已注销时 `peer_user` 是 `null`，
 *      这时必须说清「人没了、会话还在」，而不是显示一句含义不明的「账号已不可见」。
 *
 * 说明：⭐ 服务端对已注销的对端**照样列出这个会话**（`peer_gone: true`，只读）：
 *      否则「对方的历史会话缺一段」会变成「会话凭空消失」，用户完全不知道发生过什么。
 *
 * @param {Object} c - 会话行（`peer_user` / `peer_gone`）
 * @returns {string} 对方名字（或「已注销」的说明）
 */
function teamworkConvName(c) {
  return c && c.peer_gone ? '（对方账号已注销）' : teamworkPeerName(c && c.peer_user);
}

/**
 * 功能：取当前打开的会话行（没打开时为 `undefined`）。
 * @returns {?Object} 会话行
 */
function activeConversation() {
  if (!teamworkState.activeConvId) return null;
  return teamworkState.conversations.find((c) => Number(c.id) === Number(teamworkState.activeConvId)) || null;
}

/**
 * 功能：按「当前有没有可写的会话」开关输入区 —— 没打开会话、或对方账号已注销时**置灰输入框与发送键**。
 *
 * 说明：⚠️ 这不是装饰：对方账号注销后服务端**允许读历史、拒绝发新消息**，
 *      不置灰的话用户敲完一整段话才收到一个 400，而他根本不知道为什么。
 *      与 `sendTeamworkMessage()` 里的那道判断是**同一条规则的两次表达**（一处管「能不能点」，一处管「点了也别发」）。
 *
 * @returns {void}
 */
function syncTeamworkComposer() {
  const c = activeConversation();
  const canWrite = !!c && !c.peer_gone;
  const inp = $('#teamwork-input');
  const btn = $('#teamwork-send');
  if (inp) {
    inp.disabled = !canWrite;
    // ⭐ 0.6.x：内置角色这一屏**可以打字，但它不会回话** —— 这句话必须说出来：
    //    不说的话用户敲一句、等半天、什么也没发生，只会以为应用坏了。
    //    ⚠️ 名字取**我起的那个**（`teamworkRowName()`），不写死「提醒助手」：名字是可以改的。
    //    `placeholder` 是纯文本属性（不进 HTML 解析器），所以这里不必 esc。
    inp.placeholder = !canWrite
      ? '先在左边选一个好友或会话'
      : c && c.builtin_key
        ? // ⭐ 0.7.7：内置角色现在**会回一句**（服务端自动回复「请与 AI 助手对话」）⇒
          //    这句提示必须跟着改，否则它写在输入框上、说的却是一件已经不成立的事。
          //    ⚠️ 与手机版 `renderTeamworkThread()` 副标题里那一句**逐字一致**。
          '这里只发提醒；想聊天请到「AI 助手」'
        : '输入消息，Enter 发送（Shift + Enter 换行）';
  }
  if (btn) btn.disabled = !canWrite;
  // ⭐ 0.8.54：那颗 ＋ 同样要跟着置灰 —— 没会话时点开菜单，挑完任务才发现发不出去
  //    （与服务端「对方已注销 ⇒ 拒发」同一条规则，⛔ 不各写一份判断）
  const plus = $('#teamwork-plus');
  if (plus) plus.disabled = !canWrite;
}

/**
 * 功能：取头像上的那一个字符（取不到就给 `?`）。
 * 说明：用 `[...s]` 而不是 `s[0]` —— emoji / 生僻字是代理对，按码元切会切出半个字符。
 * @param {string} name - 名字
 * @returns {string} 一个字符
 */
function teamworkAvatar(name) {
  const s = String(name == null ? '' : name).trim();
  return [...s][0] || '?';
}

/**
 * 功能：把服务端的时间戳（`YYYY-MM-DD HH:MM:SS`）压成聊天界面习惯的短标签 ——
 *      今天的只写 `HH:MM`，更早的写 `M/D HH:MM`。
 *
 * 说明：⚠️ 一律按**字符串切片**解析，不 `new Date()` —— 项目里「日期字符串比较用字典序、
 *      不转 Date」是老规矩（时区坑会把 UTC 的某条消息显示成昨天）。
 *
 * @param {string} s - 时间戳
 * @returns {string} 短标签；格式不认识时原样返回
 */
function fmtTeamworkTime(s) {
  const t = String(s == null ? '' : s);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return t;
  const hm = `${m[4]}:${m[5]}`;
  return `${m[1]}-${m[2]}-${m[3]}` === todayStr() ? hm : `${Number(m[2])}/${Number(m[3])} ${hm}`;
}

/**
 * 功能：把消息流容器滚到底部 —— `force` 为假时**只在用户本来就贴着底部**时才滚。
 *
 * 说明：⚠️ 「只在贴底时滚」是聊天界面的必备细节：用户正在往上翻历史，
 *      一条新消息到达就把他拽回底部，等于历史根本翻不动。
 *
 * @param {boolean} [force] - 是否无条件滚到底（刚打开会话时为 true）
 * @returns {void}
 */
function scrollTeamworkToBottom(force) {
  const box = $('#teamwork-body');
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || near) box.scrollTop = box.scrollHeight;
}

/**
 * 功能：渲染一条消息（气泡 + 时间），自己的消息靠右。
 *
 * ⚠️ **正文必须走 `esc()`** —— `body` 是别人可控内容，直接拼进 `innerHTML` 就是一个存储型 XSS
 *    （对方只要发一句 `<img onerror=…>` 就能拿到你的会话）。这是本文件最不能改的一行。
 * ⭐ 0.4.4：气泡带 `data-teamwork-msg="<id>"`（右键「添加到任务 / 复制文本」靠它认出点的是哪一条）。
 *    ⚠️ **正文不进属性**：`data-*` 里塞用户内容等于把它们摆到 HTML 解析器面前，
 *    菜单要正文时一律按 id 回 `teamworkState.messages` 里取（见 `onTeamworkMessageMenu()`）。
 *
 * @param {Object} m - 归一后的消息
 * @returns {string} 消息气泡的 HTML 片段
 */
function teamworkMsgHtml(m) {
  // ⭐ 0.6.x：内置角色发的消息**不是「我发的」** —— 它的 `user_id` 恰好等于收件人自己
  //    （见 `teamwork_messages` 的建表说明），只看发送者会把它画成「我自己说的话」。
  const mine = Number(m.userId) === myUserId() && !m.senderBuiltin;
  // ⭐ 同上：助手说的话再带一层 `builtin`，气泡走暖色 —— 一屏里「我说的 / 真人说的 / 助手说的」
  //    三种气泡各有各的样子（配色在 `desktop/app.css`）。
  const bl = m.senderBuiltin ? ' builtin' : '';
  // ⭐ 0.6.4（任务联动）：卡片消息把气泡换成一张**任务卡片**（版式在 `desktop/app.css`）。
  //    渲染本身在 `shared.js`（两端一份）—— 这里只管把它放进消息行。
  //    ⚠️ 卡片**不是活的**：它画的全是发送那一刻的快照；`body` 是渲染端不认这个
  //    `kind` 时的降级文本（服务端强制必填），所以卡片替掉气泡时它不显示，但也没有丢。
  // ⭐ 0.7.7：四种系统提醒各画一种卡片（渲染在 `shared.js`，两端一份）。
  //    ⚠️ 认不出 kind（含**老消息的 kind 是 NULL**）⇒ 退回普通气泡 —— 这是**有意的**降级，
  //    `body` 本来就是「渲染端不认这个 kind 时显示的东西」。
  const inner = isCardMsg(m)
    ? taskCardHtml(m)
    : isRemindMsg(m)
      ? remindCardHtml(m)
      : isImageMsg(m)
        ? // ⭐ 0.8.54：图片消息 —— 画成一张圆角缩略图（点开看大图，见 `bindImageZoom()`）
          imageMsgHtml(m, teamworkState.activeConvId)
        : `<div class="teamwork-bubble">${esc(m.body)}</div>`;
  // ⭐ 0.7.7：卡片消息在**外层**消息行上再加一个 `is-card` —— 卡片的宽度统一在那一层定
  //    （`width: min(78%, 560px)`，见 `desktop/app.css` 的 `.teamwork-msg.is-card`）。
  //    ⚠️ 判据走 `shared.js` 的 `isAnyCardMsg()`（任务卡片 + 四种提醒的并集），⛔ 不在这里另写一份。
  //    ⚠️ 为什么不在 `.teamwork-card` / `.teamwork-remind` 本体上定宽：那两个类**被发送前的预览弹窗复用**
  //    （那时外面没有 `.teamwork-msg` 那一层，卡片得自己撑满）—— 给本体加宽度会连带改坏那个预览。
  const card = isAnyCardMsg(m);
  return (
    `<div class="teamwork-msg${mine ? ' mine' : ''}${bl}${card ? ' is-card' : ''}" data-teamwork-msg="${Number(m.id)}">` +
    inner +
    `<div class="teamwork-mtime">${esc(fmtTeamworkTime(m.createdAt))}</div>` +
    teamworkMsgTasksHtml(m) +
    `</div>`
  );
}

/**
 * 功能：画一条消息下面那几枚「已添加到任务」标记（0.4.4，第 5 条）。
 *
 * 说明：⭐ 标记来自 `teamworkState.msgTasks`（服务端 `teamworkMessages()` 按**我自己的任务**反查出来的，
 *      所以对方的界面上永远没有这一块 —— 见 `modules/tasks/schema.js` 的文件头）。
 *      一条消息可以对应**多条**任务（同一句话分别落进两个项目），所以这里是一个列表。
 *      ⚠️ **为什么不挂在消息对象上**（`m.tasks`）：同一条消息会在 REST 与 SSE 两条路上到达，
 *      而 `mergeById()` 是「后到的整个对象覆盖先到的」—— SSE 那一条**不带** `tasks`，
 *      挂上去的话每次推送都会把已经画出来的标记抹掉（一次静默的「标记时有时无」）。
 *      所以它单独存在 `teamworkState.msgTasks` 里，由 REST 取数写、SSE 不碰。
 *      ⚠️ 标题是**我自己写的任务标题**（用户内容）⇒ 一律 `esc()`；进 `data-*` 的只有
 *      「'daily' / 数字」两种形态，不含用户内容。
 *      ⭐ 0.5.2：标记上要写清**这条任务做完没有**（「添加到任务的消息下应该
 *      显示这个任务的完成状态，没有完成用红色、完成是灰色并用横线划掉」）——
 *      两种状态的样式差异 `.teamwork-task-chip.todo / .done` 由 CSS 给，这里只落 class。
 *
 * @param {Object} m - 归一后的消息
 * @returns {string} 标记区的 HTML 片段（没有任务时是空串）
 */
function teamworkMsgTasksHtml(m) {
  const list = teamworkState.msgTasks[Number(m.id)] || [];
  if (!list.length) return '';
  return (
    `<div class="teamwork-msg-tasks">` +
    list
      .map((t) => {
        const done = t.status === 'done';
        return (
          `<button class="teamwork-task-chip ${done ? 'done' : 'todo'}" type="button" data-teamwork-task-id="${Number(t.id)}" ` +
          // ⚠️ `scope` 只可能是 `'daily'` 或一个数字 —— 这里**刻意不写 `esc()`**：
          //    它不是用户内容（任务是「日常任务」还是某个项目，由我们自己的数据决定），
          //    归一成这两态之后连转义都不需要。`teamwork.test.js` 有一条机械断言钉住
          //    「`data-teamwork-*` 里不许出现 `${esc(…)}`」，就是为了把这种地方逼成「不可能有用户内容」。
          `data-teamwork-task-scope="${String(t.scope) === 'daily' ? 'daily' : Number(t.scope)}" title="${
            done ? '这条任务已完成' : '这条任务还没完成'
          } · 点开看详情">` +
          `📋 已添加到任务 · ${esc(t.title || '未命名')}</button>`
        );
      })
      .join('') +
    `</div>`
  );
}

/**
 * 功能：把服务端给的消息标记收进 `teamworkState.msgTasks`（**只写不改**，按消息 id 归位）。
 *
 * 说明：⚠️ 只在服务端真的带了 `tasks` 数组时才写：SSE / 本地乐观插入的那些行没有这个字段，
 *      不能拿「没有」当成「没有标记」去覆盖（那正是标记会闪没的原因）。
 *
 * @param {Array.<Object>} items - 服务端返回的消息行（可能带 `tasks`）
 * @returns {void}
 */
function applyMsgTasks(items) {
  for (const m of Array.isArray(items) ? items : []) {
    if (m && Array.isArray(m.tasks)) teamworkState.msgTasks[Number(m.id)] = m.tasks;
  }
}

/**
 * 功能：从对话里的「已添加到任务」标记跳到那条任务 —— 进任务板那一屏，并**弹出它的详情**。
 *
 * 说明：⭐ 用 `openBoard(scope)` 而不是自己拼一个视图：它顺带把这一屏的数据取回来、
 *      让侧栏高亮与选中态都对（换屏的唯一出口，见 `shell.js`）；`openBoard` 是 async 的，
 *      等它取完数再从 `state.tasks` 里按 id 找那条任务。
 *      ⚠️ **找不到**（任务刚被删掉）时说一句人话，不要静默什么都不做 ——
 *      标记还在而点下去没反应，用户会以为应用坏了。
 *
 * @param {string} scope - `'daily'` 或项目 id（来自标记的 `data-teamwork-task-scope`）
 * @param {number} id - 任务 id
 * @returns {Promise.<void>}
 */
async function jumpToTask(scope, id) {
  const s = String(scope) === 'daily' ? 'daily' : Number(scope);
  if (s !== 'daily' && !Number.isFinite(s)) return;
  await openBoard(s);
  const task = (state.tasks || []).find((x) => Number(x.id) === Number(id));
  if (!task) return toast('这条任务已经不在了（可能刚被删掉）', true);
  openTaskDetail(s, task);
}

/**
 * 功能：把「未读合计」这一件事**一次说清** —— 重算 / 记进 `teamworkState` / 通知宿主。
 *
 * 说明：⭐ 0.5.5（「来消息并不是实时出现红点提示，需要刷新才能出现」）。
 *      在此之前 `teamworkState.unreadTotal` 被四处各赋一次值，而那四个地方**谁也不知道
 *      外面还有人在看这个数** —— 于是侧栏角标与首页看板那张卡永远停在旧值上。
 *      现在四条路都走这里，宿主那边一处收口（`shell.js` 的 `setTeamworkUnread()`）。
 *      ⚠️ 别绕开它直接给 `teamworkState.unreadTotal` 赋值：那样红点又不会亮，而且**不报任何错**。
 *
 * @param {number} [total] - 明确的未读合计；不给就按 `teamworkState.conversations` 重算
 *      （`/api/teamwork/friends` 直接给了一个数，别丢掉它）
 * @returns {void}
 */
function publishUnread(total) {
  teamworkState.unreadTotal =
    total === undefined ? teamworkState.conversations.reduce((n, x) => n + (Number(x.unread) || 0), 0) : Number(total) || 0;
  setTeamworkUnread(teamworkState.unreadTotal);
}

/**
 * 功能：把一条消息的结果就地写回会话列表那一行（最后一条摘要 / 排序 / 未读），
 *      免得为「自己刚发的那句话」再打一次接口。
 *
 * 说明：⭐ 未读数**只对「不是我发的 + 不是当前打开的会话」**递增 —— 与后端口径一致
 *      （打开着的会话会立刻 `read`）；自己的消息永远不给自己算未读。
 *
 * @param {Object} msg - 归一后的消息
 * @returns {void}
 */
function applyMessageToConversations(msg) {
  const c = teamworkState.conversations.find((x) => Number(x.id) === Number(msg.conversationId));
  if (!c) return;
  c.last_body = msg.body;
  c.last_created_at = msg.createdAt;
  c.last_sender_id = msg.userId;
  // ⭐⭐ 0.7.7 修复（真机报的「我：」闪现）：内置角色（提醒助手）发的消息，`user_id` **就是收件人自己**
  //    （`teamwork_messages` 建表说明）⇒ 只判发送者会把它当成「我发的」，预览行于是写上「我：」；
  //    下一次 REST 全量刷新时服务端算对了（`store.js` 的 `lastMine()`：发送者是我 **且** 不是内置角色）
  //    ⇒ 「我：」消失 ⇒ 表现为**闪现**。
  //    ⚠️ 口径必须与服务端**逐字对齐**：`Number(uid) === 我 && !senderBuiltin`（见下面未读那一段，
  //    它早就带着 `|| msg.senderBuiltin` —— 同一条规矩，别只改一半）。
  c.last_mine = Number(msg.userId) === myUserId() && !msg.senderBuiltin;
  if (Number(msg.id) > Number(c.last_message_id || 0)) c.last_message_id = Number(msg.id);
  // ⭐ 0.6.x：内置角色（提醒助手）发的消息**要计未读** —— 它就是「叫你」的唯一方式，
  //    而它的 `userId` 恰好是我自己，只判发送者会把红点吃掉（后端同样口径，见 `teamwork_reminders` 那一批）。
  if (
    (msg.userId !== myUserId() || msg.senderBuiltin) &&
    Number(msg.conversationId) !== Number(teamworkState.activeConvId)
  ) {
    c.unread = (Number(c.unread) || 0) + 1;
  }
  // 会话列表按最后一条消息倒序（后端的排序口径）—— 就地排一下，别等下一次拉列表
  teamworkState.conversations.sort((a, b) => Number(b.last_message_id || 0) - Number(a.last_message_id || 0));
  publishUnread();
}

/**
 * 功能：拉一次 `GET /api/teamwork/friends` 覆盖左栏数据，并重画左栏与对话头部。
 *
 * 说明：⭐ 这是**唯一**给 `teamworkState.friends / conversations` 赋值的入口（SSE 的 `friend` 事件、
 *      好友申请、同意、删除、拉黑全都回到这里重新取一次）—— 这样「哪些字段能跨账号传」
 *      只有服务端一处答案，前端不去自己拼账号信息。
 *      ⚠️ 当前打开的会话若已不在列表里（被删好友 / 拉黑），必须**主动关掉**：
 *      否则右边会一直挂着一个再也读不到（404）的对话，用户点发送只会不断报错。
 *
 * @returns {Promise.<void>}
 */
export async function loadTeamworkOverview() {
  const r = await api('GET', '/api/teamwork/friends');
  teamworkState.friends = Array.isArray(r.friends) ? r.friends : [];
  teamworkState.incoming = Array.isArray(r.incoming) ? r.incoming : [];
  teamworkState.outgoing = Array.isArray(r.outgoing) ? r.outgoing : [];
  teamworkState.blocked = Array.isArray(r.blocked) ? r.blocked : [];
  teamworkState.conversations = Array.isArray(r.conversations) ? r.conversations : [];
  publishUnread(r.unreadTotal);
  if (teamworkState.activeConvId && !teamworkState.conversations.some((c) => Number(c.id) === teamworkState.activeConvId)) {
    teamworkState.activeConvId = null;
    teamworkState.messages = [];
    teamworkState.hasMore = false;
    renderTeamworkMessages();
  }
  renderTeamworkSide();
  renderTeamworkHead();
}

/**
 * 功能：只刷会话列表（`GET /api/teamwork/conversations`）并重画左栏 ——
 *      用于「消息到达了别的会话」与「轮询周期到」这两种只想更新未读数的场合。
 *
 * 说明：⚠️ 失败**只吞掉**：未读数是锦上添花，为它弹一个错误框反而打断正在进行的对话；
 *      真正的连接异常由顶栏的「重连中 / 已降级为轮询」负责说明。
 *
 * @returns {Promise.<void>}
 */
async function refreshConversations() {
  try {
    const r = await api('GET', '/api/teamwork/conversations');
    teamworkState.conversations = Array.isArray(r.items) ? r.items : [];
    publishUnread();
    renderTeamworkSide();
  } catch (_e) {
    /* 见函数说明：不打断对话 */
  }
}

/**
 * 功能：把当前会话标记为已读（`POST …/read`），并就地清掉左边那一行的红点。
 *
 * 说明：⭐ 游标取「已加载消息里的最大 id」而不是某个计数 —— 服务端的已读游标就是消息 id，
 *      而且它会把游标夹到会话现有的最大 id（多端同时在线也不会把将来的消息误标已读）。
 *      ⚠️ 已经零未读时**不再发请求**：否则每来一条自己的消息都会白白多一次往返。
 *
 * @returns {Promise.<void>}
 */
async function markConversationRead() {
  const cid = Number(teamworkState.activeConvId);
  if (!cid || !teamworkState.messages.length) return;
  const last = Number(teamworkState.messages[teamworkState.messages.length - 1].id);
  if (!last) return;
  const conv = teamworkState.conversations.find((c) => Number(c.id) === cid);
  if (conv && !Number(conv.unread) && Number(conv.last_read_id || 0) >= last) return;
  try {
    const r = await api('POST', `/api/teamwork/conversations/${cid}/read`, { lastReadId: last });
    if (conv) {
      conv.unread = 0;
      conv.last_read_id = Number(r.lastReadId) || last;
    }
    publishUnread();
    renderTeamworkSide();
  } catch (_e) {
    /* 标记已读失败不该打断阅读 —— 下一次打开这个会话会再标一次 */
  }
}

// ---------- 渲染：左栏（会话区 + 顶部两颗入口按钮） ----------
/**
 * 功能：画**会话区**的标题行 —— ⭐ 0.4.4 起它是一颗**按钮**（点一下收起 / 展开这一区），
 *      右侧的计数**始终画着**（收起来也看得见「有几个会话 / 几条未读」）。
 *
 * 说明：⚠️ 计数在按钮**里面**，所以点它也算折叠 —— 这正是想要的（整行都能点）。
 *      箭头方向就是当前状态：`▾` 展开着、`▸` 已收起（不看文案也能一眼分辨）。
 *      ⚠️ 0.7.6 起本函数只服务会话区（好友 / 申请改成了两颗按钮 + 弹窗，见 `paintTeamworkActs()`），
 *      于是原先那个给「好友区待处理红点」用的 `badge` 参数没人传了 —— 一并去掉，红点搬到申请按钮上。
 *
 * @param {string} key - 折叠键（`assist` / `convs`，必须是 `teamworkState.fold` 里已有的键）
 * @param {string} title - 分区名
 * @param {string} cnt - 右侧计数文案（已转义）
 * @param {boolean} folded - 当前是否收起
 * @returns {string} 标题行（`<button>`）的 HTML 片段
 */
function teamworkSecHeadHtml(key, title, cnt, folded) {
  return (
    `<button class="teamwork-sec-head" type="button" data-teamwork-fold="${key}" ` +
    `aria-expanded="${folded ? 'false' : 'true'}" title="${folded ? '展开' : '收起'}这一区">` +
    `<span class="teamwork-caret" aria-hidden="true">${folded ? '▸' : '▾'}</span>` +
    `<span>${title}</span><span class="teamwork-cnt">${cnt}</span></button>`
  );
}

/**
 * 功能：算一段会话标题右侧的计数 —— 有未读就说未读，否则说条数。
 *
 * 说明：⚠️⭐ 两段**各算各的**：共用一个数（旧口径是全局的 `teamworkState.unreadTotal`）会让
 *      两行标题写着同一个数字，看的人只会以为算错了。
 *      ⚠️ 插槽会话条目**没有未读语义**（`teamworkSlotRowHtml()` 里不画红点）⇒ 它只用 `extra`
 *      计入条数，不进未读。
 *
 * @param {Array.<Object>} rows - 本段的会话行
 * @param {number} extra - 本段额外的「非会话行」条数（插槽条目），可为 0
 * @returns {string} 计数文案
 */
function teamworkSecCnt(rows, extra) {
  const un = (rows || []).reduce((n, c) => n + (Number(c.unread) || 0), 0);
  return un > 0 ? `未读 ${un}` : String((rows || []).length + (Number(extra) || 0));
}

/**
 * 功能：渲染左栏 —— ⭐ 0.7.7 起是**可折叠的分组**（`内置助手` / `好友`），⭐ 2h 起多第三组
 *      `协作项目`，三组各用 `teamworkSecHeadHtml()` 画头（⇒ 同款），
 *      顺手把顶部两颗入口按钮的计数刷一遍。
 *
 * 说明：⚠️ 好友 / 申请两块已从内联改成**两颗按钮**（点开是弹窗，见 `openTeamworkFriendsModal()` /
 *      `openTeamworkRequestsModal()`），这里不再画它们；但按钮上的数字与红点必须跟着数据变，
 *      所以每回重画都顺手调一次 `paintTeamworkActs()` —— 所有 `renderTeamworkSide()` 的调用点
 *      （收消息、拉总览、折叠…）于是自动覆盖到按钮，不必各自记得刷。
 *      ⚠️ 那两颗按钮住在 `#teamwork-side-body` **外面**（`index.html` 的 `.teamwork-acts`），
 *      不参与这块 `innerHTML` 重画 —— 否则每收一条消息按钮就要被重建一次。
 *
 * @returns {void}
 */
export function renderTeamworkSide() {
  const box = $('#teamwork-side-body');
  if (!box) return;
  box.innerHTML = teamworkConvSecHtml();
  paintTeamworkActs();
  // ⭐ 0.8.4：这一拍重启完之后，条目表是新的 ⇒ 顺手兑现一次「外部请求打开某个插槽会话」
  //    （记账那颗 AI 圆环走的就是这条路；幂等，没请求时立刻返回）。
  tryOpenWantSlot();
}

/**
 * 功能：把**顶部两颗入口按钮**（好友 / 申请）的计数与红点刷成当前值。
 *
 * 说明：⭐ 按钮是 `index.html` 里的**静态骨架**（不进左栏那块重画范围），所以计数得由本函数补上去。
 *      ⚠️ 节点取不到时**静默返回**：手机版没有这两颗按钮（它用自己的列表页操作行），
 *      而且骨架与代码不同步时也不该把整屏拖挂（本项目记过「少一个节点 = 整屏读取失败」）。
 *      ⚠️ 申请按钮上的红点只在**有待处理**时出现 —— 数字与弹窗里「收到」那一段同源
 *      （都取 `teamworkState.incoming`），不会出现「按钮说 2、点开只有 1」。
 *
 * @returns {void}
 */
function paintTeamworkActs() {
  const fb = $('#teamwork-friends-btn');
  const rb = $('#teamwork-req-btn');
  if (fb) {
    const n = fb.querySelector('.teamwork-act-n');
    if (n) {
      const total = (teamworkState.friends || []).filter((f) => Number.isFinite(Number(f.user && f.user.id)));
      n.textContent = total.length ? String(total.length) : '还没有';
    }
  }
  if (!rb) return;
  const inc = teamworkState.incoming.length;
  const out = teamworkState.outgoing.length;
  const rn = rb.querySelector('.teamwork-act-n');
  if (rn) rn.textContent = `收到 ${inc} · 发出 ${out}`;
  let dot = rb.querySelector('.teamwork-dot');
  if (inc > 0) {
    if (!dot) {
      dot = document.createElement('span');
      rb.appendChild(dot);
    }
    dot.className = 'teamwork-dot';
    dot.textContent = String(inc);
    dot.title = `有 ${inc} 条待处理的申请`;
  } else if (dot) {
    dot.remove();
  }
}

/**
 * 功能：画**好友弹窗**的正文 —— 全部好友，每行「名字（点了开会话）+ 拉黑 + 删好友」。
 *
 * 说明：⭐ 0.7.6 从原来的内联区搬过来，行的结构与动作**一个字没改**（仍是 `teamworkFriendRowHtml()`）——
 *      改的只是它被谁装：以前装进左栏，现在装进弹窗。
 *      ⚠️ 只画「账号还查得到」的好友：后端把 `user` 补不出来时是 `null`（对方账号已注销），
 *      这种行既不能开会话也不能删好友（`data-*` 会变成 NaN），画出来只是个会报错的按钮。
 *      ⚠️ 右键这一行仍然能改备注 —— 委托挂在弹窗容器上（见 `bindTeamworkEvents()`）。
 *
 * @returns {string} 弹窗正文的 HTML 片段
 */
function teamworkFriendsListHtml() {
  const fs = (teamworkState.friends || []).filter((f) => Number.isFinite(Number(f.user && f.user.id)));
  const rows = fs.length
    ? fs.map(teamworkFriendRowHtml).join('')
    : '<div class="teamwork-empty">还没有好友 —— 让对方把他的登录名告诉你，' +
      '填在左栏上面的输入框里点「加好友」。</div>';
  return `<div class="teamwork-list">${rows}</div>`;
}

/**
 * 功能：画**申请弹窗**的正文 —— 收到（可同意 / 拒绝）/ 发出（只能等）/ 已拉黑（可取消）。
 *
 * 说明：⭐ 「已拉黑」放在这一层而不是单开一个入口：它同样是「关系待处理」的一种状态，
 *      而且它必须有一个**取消拉黑的入口** —— 否则拉黑过一次就再也没有回头路。
 *
 * @returns {string} 弹窗正文的 HTML 片段
 */
function teamworkRequestsListHtml() {
  // 同上：账号已注销的申请 / 拉黑行没有可执行的动作，不画（而不是画一个点了报错的按钮）
  const withUser = (rows) => (rows || []).filter((f) => Number.isFinite(Number(f.user && f.user.id)));
  const inc = withUser(teamworkState.incoming);
  const out = withUser(teamworkState.outgoing);
  const blk = withUser(teamworkState.blocked);
  const parts = [];
  if (!inc.length && !out.length && !blk.length) {
    parts.push('<div class="teamwork-empty">暂时没有待处理的申请。</div>');
  }
  parts.push(inc.map((f) => teamworkReqRowHtml(f, true)).join(''), out.map((f) => teamworkReqRowHtml(f, false)).join(''));
  if (blk.length) {
    parts.push('<div class="teamwork-sub">已拉黑</div>');
    parts.push(blk.map(teamworkBlockedRowHtml).join(''));
  }
  return `<div class="teamwork-list">${parts.join('')}</div>`;
}

/**
 * 功能：渲染一位好友 —— 名字本身是按钮（点了就开/接着聊），右侧是拉黑与删好友。
 *
 * 说明：⚠️ 名字与操作**是两个并排的按钮**，不是「整行可点 + 行内按钮」——
 *      后者靠 `closest()` 分派时，先判整行会让「点删好友」变成「打开对话」，且不报任何错
 *      （本项目已记录的坑）。这里从结构上就不给它出错的机会。
 *      ⭐ 0.4.4：名字走 `teamworkRowName()`（**我起的备注优先**）；`@登录名` 那一行照旧显示 ——
 *      备注只是「我认他的方式」，登录名才是「他到底是谁」，两样都要看得见。
 *      改备注的入口是**右键这一行**（`onTeamworkSideMenu()`），所以行上不必再挤第三颗按钮。
 *
 * @param {Object} f - 好友行（`remark` / `user` / `conversation_id` / `unread`）
 * @returns {string} 好友行的 HTML 片段
 */
function teamworkFriendRowHtml(f) {
  const u = f.user || {};
  const uid = Number(u.id);
  const name = teamworkRowName(f);
  const unread = Number(f.unread) || 0;
  const sub = `@${esc(u.username || '')}${f.conversation_id ? '' : ' · 还没聊过'}`;
  return (
    `<div class="teamwork-row">` +
    `<span class="teamwork-ava">${esc(teamworkAvatar(name))}</span>` +
    `<button class="teamwork-row-main" type="button" data-teamwork-friend="${uid}" title="开始 / 继续对话">` +
    `<b>${esc(name)}</b><small>${sub}</small></button>` +
    (unread > 0 ? `<span class="teamwork-dot">${unread}</span>` : '') +
    `<span class="teamwork-row-acts">` +
    `<button class="btn btn-subtle btn-sm" type="button" data-teamwork-block="${uid}" title="拉黑对方">拉黑</button>` +
    `<button class="btn btn-danger btn-sm" type="button" data-teamwork-del="${uid}" title="删除好友（消息不删）">删好友</button>` +
    `</span></div>`
  );
}

/**
 * 功能：渲染会话区（⭐ 2h 起是**三组**：`内置助手` / `好友` / `协作项目`）—— 每个会话带未读数与最后一条摘要，
 *      当前打开的那个高亮。
 *
 * 说明：⭐ 0.6.x 会话区顶部多一块「**插槽会话条目**」：本区每次重画都先发一次
 *      `zx:teamwork-conv-entries` 留白事件（与 `zx:teamwork-msg-menu` 同一套规矩 —— 本模块不认识
 *      任何具体模块，谁想把自己的会话摆进这张列表谁就来填），收集到的条目用**本模块自己的
 *      行样式**画在真会话前面 —— 条目长得和真会话一模一样（头像 / 名字 / 摘要），点它
 *      由 `openSlotConv()` 接手。⚠️ 事件是同步派发的（`dispatchEvent` 不异步），
 *      所以可以在拼 HTML 前就地收齐。
 *      ⭐ 0.7.7：这些插槽条目与 `builtin_key` 会话**同属「内置助手」那一组**（它们都不是真人）。
 *      ⭐ 2h：第三组「协作项目」由 `teamworkCollabSecHtml()` 画（同样走留白事件登记条目）。
 * @returns {string} 会话区各组的 HTML 片段（「内置助手」那一段可能整段不画）
 */
function teamworkConvSecHtml() {
  const cs = teamworkState.conversations || [];
  // ⚠️ 先清再收：条目清单必须与「这一拍登记的」严格一致，残留的旧条目会指向已卸载的片段
  teamworkState.slotEntries.clear();
  const ev = new CustomEvent('zx:teamwork-conv-entries', { detail: { items: [] } });
  document.dispatchEvent(ev);
  const slots = ((ev.detail && ev.detail.items) || []).filter((it) => it && it.key);
  for (const it of slots) teamworkState.slotEntries.set(String(it.key), it);
  const slotHtml = slots.map(teamworkSlotRowHtml).join('');
  // ⭐ 0.7.7：会话列表拆成**两段** —— 「内置助手」（插槽条目 + `builtin_key` 会话）与「好友」（其余）。
  //    判据只走 `shared.js` 的 `isAssistConv()`（⛔ 两端各写一份 `if` 就是分叉的起点）；
  //    ⚠️ 两段的**组内顺序照服务端给的顺序**（`store.js` 已把内置角色排最前）—— 这里只分组、不重排。
  const assist = cs.filter(isAssistConv);
  const friends = cs.filter((c) => !isAssistConv(c));
  const secs = [];
  // ⚠️⭐ 内置助手一条都没有 ⇒ **整段不画**（连标题一起不画）：一个孤零零的空标题比没有更难懂
  //    。两组都空时下面只剩「好友」那一句，正是想要的。
  if (assist.length || slots.length) {
    const foldedA = !!teamworkState.fold.assist;
    secs.push(
      `<div class="teamwork-sec${foldedA ? ' folded' : ''}">` +
        teamworkSecHeadHtml('assist', '内置助手', teamworkSecCnt(assist, slots.length), foldedA) +
        `<div class="teamwork-sec-body"><div class="teamwork-list">${slotHtml + assist.map(teamworkConvRowHtml).join('')}</div></div>` +
        `</div>`,
    );
  }
  const folded = !!teamworkState.fold.convs;
  const rows = friends.length
    ? friends.map(teamworkConvRowHtml).join('')
    : '<div class="teamwork-empty">还没有会话 —— 点上面好友的名字就能开始聊天。</div>';
  secs.push(
    `<div class="teamwork-sec${folded ? ' folded' : ''}">` +
      teamworkSecHeadHtml('convs', '好友', teamworkSecCnt(friends, 0), folded) +
      `<div class="teamwork-sec-body"><div class="teamwork-list">${rows}</div></div></div>`,
  );
  // ⭐ 2h（丁 · 排版）：第三组「协作项目」—— 与上面两组**同一个 `teamworkSecHeadHtml()`**，
  //    行也是同一套 `.teamwork-row` 样式 ⇒ 三组才真正同款（高度 / 折叠箭头 / 条数位置 / hover）。
  secs.push(teamworkCollabSecHtml());
  return secs.join('');
}

/**
 * 功能：画左栏**第三组**「协作项目」—— 组内第一行恒为「＋ 添加共享项目」，其余行是每个已加进
 *      协作的项目（点它 ⇒ 主区让位给看板，走 `openCollabBoard()`）。
 *
 * 说明：⭐ 与「内置助手 / 好友」两组用**同一个** `teamworkSecHeadHtml()` 画分组头 ⇒ 三组同款，
 *      这正是提这一条的**全部理由**。⚠️ 条目走 `zx:teamwork-collab-entries` 留白事件收集
 *      （与 `zx:teamwork-conv-entries` 同一套规矩）—— 本模块**不认识 `tasks` 这个东西**，
 *      谁想把自己的项目摆进这一组谁就来填；填的是 `{ key, name, sub }`，行由本模块用自己的样式画。
 *      ⚠️ 事件是同步派发的，所以可以在拼 HTML 前就地收齐；⚠️ 先清再收（残留的旧条目会指向已卸载的片段）。
 *      ⭐ 三组恒画（不像「内置助手」那样整段不画）：组内第一行「＋ 添加共享项目」永远要有 ——
 *      一组都不能凭空消失，否则「加进来」的门就没了。
 *
 * @returns {string} 第三组的 HTML 片段
 */
function teamworkCollabSecHtml() {
  // ⚠️ 先清再收：条目清单必须与「这一拍登记的」严格一致（照 `zx:teamwork-conv-entries` 的写法）
  teamworkState.collabEntries.clear();
  const ev = new CustomEvent('zx:teamwork-collab-entries', { detail: { items: [] } });
  document.dispatchEvent(ev);
  const items = ((ev.detail && ev.detail.items) || []).filter((it) => it && it.key);
  for (const it of items) teamworkState.collabEntries.set(String(it.key), it);
  const folded = !!teamworkState.fold.collab;
  // ⚠️ 第一行**恒为**「＋ 添加共享项目」（契约 §丁-4-3）：点它不由本模块处理，而是派
  //    `zx:teamwork-collab-add` 让 tasks 的 page 片段去开它的弹层 —— 宿主不认识那个弹层。
  const addRow =
    '<button class="teamwork-row conv collab-add-row" type="button" data-teamwork-collab-add ' +
    'title="把一个项目加进协作，拉上好友一起做">' +
    '<span class="teamwork-ava">＋</span>' +
    '<span class="teamwork-row-main"><b>添加共享项目</b><small>拉上好友一起做</small></span></button>';
  const rows = items.length
    ? items.map(teamworkCollabRowHtml).join('')
    : '<div class="teamwork-empty">还没有协作项目</div>';
  return (
    '<div class="teamwork-sec' + (folded ? ' folded' : '') + '">' +
    teamworkSecHeadHtml('collab', '协作项目', teamworkSecCnt([], items.length), folded) +
    '<div class="teamwork-sec-body"><div class="teamwork-list">' + addRow + rows + '</div></div>' +
    '</div>'
  );
}

/**
 * 功能：画一条**协作项目行** —— 与真会话行（`teamworkConvRowHtml()`）同一套类名与结构，
 *      只是数据来自条目本身（头像用统一的文件夹图标、没有未读数与时间）。
 *      ⭐ 点它由 `openCollabBoard()` 接手（主区让位给看板），选中态与真会话同一个 `on` 类。
 *      ⭐⭐ 0.8.53（团队协作的项目中也要有 + 图标可以新建任务）：行尾多一颗 `＋`
 *      （`data-teamwork-collab-new`）—— 点它打开这个项目的看板并**直接摆出新建任务弹层**。
 *      ⚠️ 它在**行按钮内部**，所以点击委托里必须先判它、再判整行（见 `onClick` 那一段）。
 * @param {Object} it - 条目（`{ key, name, sub }`，`key` ＝ 项目 id 字符串）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkCollabRowHtml(it) {
  const on = String(teamworkState.collabBoard || '') === String(it.key);
  // ⚠️ 键先 esc 落到局部变量再拼（与 `teamworkSlotRowHtml()` 同一条口径）
  const key = esc(String(it.key));
  return (
    '<button class="teamwork-row conv' + (on ? ' on' : '') + '" type="button" data-teamwork-collab="' + key + '">' +
    '<span class="teamwork-ava">📁</span>' +
    '<span class="teamwork-row-main"><b>' + esc(it.name || String(it.key)) + '</b><small>' + esc(it.sub || '') + '</small></span>' +
    '<span class="teamwork-row-plus" role="button" title="在这个项目里新建任务" data-teamwork-collab-new="' + key + '">＋</span>' +
    '</button>'
  );
}

/**
 * 功能：画一条**插槽会话条目** —— 与真会话行（`teamworkConvRowHtml()`）同一套类名与结构，
 *      只是数据来自条目本身：头像用条目自带的图标、没有未读数与时间（插槽会话没有未读语义）。
 *      ⭐ 整行带 `builtin`（与提醒助手同一条约定：不是真人的会话走**暖色**），选中态与真会话
 *      同一个 `on` 类 —— 「点开它」和「点开一条真会话」在界面上必须是同一件事。
 * @param {Object} it - 条目（`{ key, icon, name, sub }`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkSlotRowHtml(it) {
  const on = teamworkState.slotConv === String(it.key);
  // ⚠️ 键是模块自己登记的内部常量（不是用户内容），但仍先 esc 落到局部变量再拼 ——
  //    别把 `${esc(` 直接写进 data-teamwork-* 属性（特征化断言钉着这条口径，teamwork.test.js 0.4.4 需求 3）
  const key = esc(String(it.key));
  return (
    `<button class="teamwork-row conv${on ? ' on' : ''} builtin" type="button" data-teamwork-slot="${key}">` +
    `<span class="teamwork-ava builtin">${esc(it.icon || '🤖')}</span>` +
    `<span class="teamwork-row-main"><b>${esc(it.name || String(it.key))}</b><small>${esc(it.sub || '')}</small></span>` +
    `</button>`
  );
}

/**
 * 功能：把一条消息摘要压成**会话列表里那一行**能放的形状 —— ⭐ 0.6.x：只取第一行。
 *
 * 说明：⚠️ 提醒助手的消息是**多行**的（上课提醒含教室与两条备注），整段塞进 320px 的预览行
 *      会被挤成一团（`<small>` 里换行渲染成空格，读者只看到一长串）。活人的消息通常是单行，
 *      所以只对内置角色生效 —— 不改变原有的显示习惯。
 *
 * @param {Object} c - 会话行
 * @returns {string} 预览文案（未转义；由调用方 `esc()`）
 */
function teamworkPreview(c) {
  const body = c && c.last_body ? String(c.last_body) : '';
  if (!body) return c && c.builtin_key ? '还没有提醒' : '（还没有消息）';
  const text = c.builtin_key ? body.split('\n')[0] : body;
  return `${c.last_mine ? '我：' : ''}${text}`;
}

/**
 * 功能：渲染一行会话（整行是一个按钮，键盘 Enter 天然可用）。
 * @param {Object} c - 会话行（`id` / `peer_user` / `peer_remark` / `unread` / `last_body` / `last_mine` / `last_created_at`）
 * @returns {string} 会话行的 HTML 片段
 */
function teamworkConvRowHtml(c) {
  const name = teamworkRowName(c);
  const unread = Number(c.unread) || 0;
  const on = Number(c.id) === Number(teamworkState.activeConvId);
  const sub = c.peer_gone ? '对方账号已注销 · 只能看历史' : teamworkPreview(c);
  // ⭐ 0.6.x：内置角色（提醒助手）整行带 `builtin` —— 头像与名字走**暖色**，
  //    在会话列表里一眼就能和真人区分开（「颜色要不一样」）。
  //    配色写在 `desktop/app.css` 的 `.teamwork-*` 那一段，这里只落 class。
  const bl = c.builtin_key ? ' builtin' : '';
  // ⚠️ 头像的两个修饰类**互斥**（内置角色不会有 `peer_gone`），所以是二选一而不是叠加：
  //    写成 `bl + dim` 那种拼法，将来多一个状态就会出现「谁盖谁」看不出来的规则冲突。
  const ava = c.builtin_key ? ' builtin' : c.peer_gone ? ' dim' : '';
  return (
    `<button class="teamwork-row conv${on ? ' on' : ''}${bl}" type="button" data-teamwork-open="${Number(c.id)}">` +
    `<span class="teamwork-ava${ava}">${esc(teamworkAvatar(name))}</span>` +
    `<span class="teamwork-row-main"><b>${esc(name)}</b><small>${esc(sub)}</small></span>` +
    `<span class="teamwork-row-meta">` +
    (c.last_created_at ? `<span class="teamwork-time">${esc(fmtTeamworkTime(c.last_created_at))}</span>` : '') +
    (unread > 0 ? `<span class="teamwork-dot">${unread}</span>` : '') +
    `</span></button>`
  );
}

/**
 * 功能：渲染一条好友申请 —— 收到的给「同意 / 拒绝」，发出的只写「等对方同意」。
 *
 * 说明：⚠️ 发出的申请**刻意不给任何按钮**：一期没有「撤回申请」接口，
 *      而「拒绝」在服务端只允许被申请方调用 —— 摆一个点了必然报错的按钮是更坏的选择。
 *      「作废一条自己发出的申请」要等二期给了接口再说。
 *
 * @param {Object} f - 申请行（`user`）
 * @param {boolean} isIn - 是否是我收到的（true = 我可以同意 / 拒绝）
 * @returns {string} 申请行的 HTML 片段
 */
function teamworkReqRowHtml(f, isIn) {
  const u = f.user || {};
  const uid = Number(u.id);
  const name = teamworkPeerName(u);
  const acts = isIn
    ? `<span class="teamwork-row-acts">` +
      `<button class="btn btn-primary btn-sm" type="button" data-teamwork-accept="${uid}">同意</button>` +
      `<button class="btn btn-subtle btn-sm" type="button" data-teamwork-reject="${uid}">拒绝</button>` +
      `</span>`
    : `<span class="teamwork-row-acts"><span class="teamwork-wait">等对方同意</span></span>`;
  return (
    `<div class="teamwork-row">` +
    `<span class="teamwork-ava">${esc(teamworkAvatar(name))}</span>` +
    `<span class="teamwork-row-main"><b>${esc(name)}</b>` +
    `<small>@${esc(u.username || '')} · ${isIn ? '想加你为好友' : '你发出的申请'}</small></span>` +
    acts +
    `</div>`
  );
}

/**
 * 功能：渲染一条「已拉黑」的行 —— 唯一的动作是**取消拉黑**。
 * @param {Object} f - 拉黑行（`user`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkBlockedRowHtml(f) {
  const u = f.user || {};
  const uid = Number(u.id);
  const name = teamworkPeerName(u);
  return (
    `<div class="teamwork-row">` +
    `<span class="teamwork-ava dim">${esc(teamworkAvatar(name))}</span>` +
    `<span class="teamwork-row-main"><b>${esc(name)}</b><small>@${esc(u.username || '')} · 你已拉黑对方</small></span>` +
    `<span class="teamwork-row-acts">` +
    `<button class="btn btn-subtle btn-sm" type="button" data-teamwork-unblock="${uid}">取消拉黑</button>` +
    `</span></div>`
  );
}

// ---------- 关系弹窗：好友 / 申请（0.7.6，从内联区改成两颗按钮） ----------
/**
 * 当前打开的**关系弹窗**是哪一个（`'friends'` / `'reqs'` / `null`）。
 *
 * 说明：⭐ 它只服务一件事：弹窗里做了个动作（同意 / 拉黑 / 删好友…）之后，要把**同一个弹窗**
 *      重画成最新数据 —— 否则用户会盯着一个「刚同意过、却还写着等处理」的旧列表。
 *      ⚠️ 弹窗关闭时**不必清它**：重画只发生在「弹窗内的操作成功之后」这条路径上，
 *      那一刻这个值必然就是刚操作的那个弹窗；悬空的值不会被别的路径读走。
 *      ⚠️ 它只记**本模块自己开的**这两个弹窗；改备注 / 转任务那些弹窗不参与。
 *
 * @type {?('friends'|'reqs')}
 */
let teamworkModalKind = null;

/**
 * 功能：打开「好友」弹窗 —— 列出全部好友，行上「拉黑 / 删好友」，右键「改备注」。
 *
 * 说明：⭐ 0.7.6：好友管理从**左栏内联区**改成**一颗按钮 + 弹窗** —— 左栏只留会话，
 *      好友与申请各占一颗按钮。行的结构与操作一个字没动（仍是 `teamworkFriendRowHtml()`），
 *      改的只是它被装进哪里。
 *      ⚠️ 内容**每次打开都重画**（读当前 `teamworkState`），不缓存 —— 好友/申请随时在变。
 *      ⚠️ 主按钮设成「关闭」并绑 `closeModal`（这是个只读列表，没有要保存的东西），
 *      而且**必须每次都设**：`closeModal()` 只还原按钮文案、不解除 `onclick`，
 *      漏设就会顶着上一个弹窗的动作（本项目记过这类串味）。
 *
 * @returns {void}
 */
export function openTeamworkFriendsModal() {
  teamworkModalKind = 'friends';
  openModal('好友', teamworkFriendsListHtml());
  setModalSave('关闭');
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：打开「申请」弹窗 —— 收到 / 发出 / 已拉黑三段，收到的带「同意 / 拒绝」。
 * @returns {void}
 */
export function openTeamworkRequestsModal() {
  teamworkModalKind = 'reqs';
  openModal('申请', teamworkRequestsListHtml());
  setModalSave('关闭');
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：把当前打开的关系弹窗重画成最新数据（弹窗内任一操作成功之后调）。
 * @returns {void}
 */
function repaintTeamworkModal() {
  if (teamworkModalKind === 'friends') openTeamworkFriendsModal();
  else if (teamworkModalKind === 'reqs') openTeamworkRequestsModal();
}

/**
 * 功能：弹窗内的点击委托 —— 好友行 / 申请行 / 拉黑行上的动作。
 *
 * 说明：⚠️⭐⭐ 弹窗（`#modal`）挂在 `body` 下、**不在 `#teamwork-view` 里面** ⇒
 *      `bindTeamworkEvents()` 给 `#teamwork-view` 挂的那条委托根本收不到弹窗里的点击，
 *      所以这一批动作必须有**第二条委托**（挂在 `#modal-body` 上，见 `bindTeamworkEvents()`）。
 *      ⚠️ 顺序与 `#teamwork-view` 那条一致：**先判行内的按钮、再判整行**（`[data-teamwork-friend]` 放最后）——
 *      反了的话「点删好友」会变成「打开对话」，且不报任何错。
 *
 * @param {MouseEvent} e - 点击事件
 * @returns {void}
 */
function onTeamworkModalClick(e) {
  const t = e.target;
  const del = t.closest('[data-teamwork-del]');
  if (del) return void confirmRemoveFriend(Number(del.dataset.teamworkDel));
  const blk = t.closest('[data-teamwork-block]');
  if (blk) return void confirmBlockFriend(Number(blk.dataset.teamworkBlock));
  const unb = t.closest('[data-teamwork-unblock]');
  if (unb) return void confirmUnblockFriend(Number(unb.dataset.teamworkUnblock));
  const acc = t.closest('[data-teamwork-accept]');
  if (acc) return void acceptTeamworkFriend(Number(acc.dataset.teamworkAccept));
  const rej = t.closest('[data-teamwork-reject]');
  if (rej) return void confirmRejectFriend(Number(rej.dataset.teamworkReject));
  const fr = t.closest('[data-teamwork-friend]');
  if (fr) {
    // 点名字 = 开始聊：先把弹窗收掉，否则它会一直盖在刚打开的对话上面
    closeModal();
    return void openTeamworkWithFriend(Number(fr.dataset.teamworkFriend));
  }
  // ⭐ 0.8.54：发送菜单的三项 + 任务选择弹窗里的一行
  const send = t.closest('[data-tw-send]');
  if (send) {
    const act = send.dataset.twSend;
    // ⚠️ 发图片要先关弹窗再开文件框：文件框在 Windows 上是模态的，弹窗留在后面会挡着
    if (act === 'image') {
      closeModal();
      return void pickSendImage();
    }
    if (act === 'collab' || act === 'daily') return void openSendTaskPicker(act);
  }
  // ⭐ 0.8.54：筛选标签（全部 / 未完成 / 已完成）—— 必须排在任务行**前面**
  const tab = t.closest('[data-pick-tab]');
  if (tab) {
    sendPick.tab = String(tab.dataset.pickTab || 'all');
    return void paintSendPickList();
  }
  const pick = t.closest('[data-pick]');
  if (pick) return void sendPickedTask(pick.dataset.pick);
}

// ---------- 渲染：右栏对话流 ----------
/**
 * 功能：渲染对话头部 —— 对方是谁 / 最近活跃时间 / 「备注」与「删除好友」两颗按钮。
 *
 * 说明：⭐ 0.4.4 加了一颗「✎ 备注」：想改备注的时机十有八九就是**正看着这个人这一屏**，
 *      不该让人退回左栏再右键找。⚠️ 名字走 `teamworkRowName()`（备注优先），与左栏同一个函数 ——
 *      两处各拼一次迟早会出现「左栏是备注、头上还是原名」。⚠️ 对方账号已注销时不摆任何按钮：
 *      没有可改的关系，点了必然是 404。
 *
 * @returns {void}
 */
export function renderTeamworkHead() {
  const box = $('#teamwork-conv-head');
  if (!box) return;
  // ⭐ 插槽会话开着时，头也由本模块画（名字 / 副标题来自条目）—— 「点开 AI 助手」与
  //    「点开一条真会话」看到的头部结构必须一致；插槽片段只画对话流与输入区。
  if (teamworkState.slotConv) {
    const it = teamworkState.slotEntries.get(teamworkState.slotConv) || {};
    box.innerHTML =
      `<div class="teamwork-conv-title builtin">` +
      `<b>${esc(it.icon || '🤖')} ${esc(it.name || teamworkState.slotConv)}</b>` +
      `<span class="teamwork-conv-sub">${esc(it.head || '插槽会话')}</span></div>`;
    return;
  }
  // ⭐ 2h（丁 · 排版）：协作看板开着时，头也由本模块画（返回键 ＋ 项目名 ＋ 角色）——
  //    「点开一条协作项目」与「点开一条真会话」看到的头部结构必须一致，看板片段只画进度 / 按钮 / 列。
  //    ⚠️ 返回入口在这里（**插槽块的头上**，与插槽会话同一个位置感）；它由本模块的点击委托接住（`closeCollabBoard()`）。
  //    ⭐ 2026-10-05：「这个返回按键**去掉箭头**，颜色**不要是白色**」
  //    ⇒ 文案 `← 返回` 改成 `返回`；类名从 `btn-subtle`（白底）换成自己的 `collab-back-btn`
  //      （品牌淡底 ＋ 品牌色字，定义在 `desktop/app.css`）。⛔ `data-teamwork-board-back` 与 title 不动。
  if (teamworkState.collabBoard) {
    const it = teamworkState.collabEntries.get(String(teamworkState.collabBoard)) || {};
    box.innerHTML =
      '<button class="btn btn-sm collab-back-btn" type="button" data-teamwork-board-back title="返回团队协作">返回</button>' +
      '<div class="teamwork-conv-title">' +
      '<b>' + esc(it.name || '协作项目') + '</b>' +
      '<span class="teamwork-conv-sub">' + esc(it.sub || '共享项目看板') + '</span></div>';
    return;
  }
  const c = activeConversation();
  syncTeamworkComposer();
  if (!c) {
    box.innerHTML = '<div class="teamwork-conv-title"><b>未打开对话</b></div>';
    return;
  }
  const u = c.peer_user || {};
  const name = teamworkRowName(c);
  // ⭐ 0.6.x：内置角色（提醒助手）不是「一个人」—— 它没有登录名、没有最近登录时间、
  //    也不能删好友 / 改备注，所以那一行副标题与两颗按钮**都不该出现**（见下面的 `acts`）。
  const sub = c.builtin_key
    ? '系统内置角色 · 上课、任务与逾期提醒都发在这里'
    : c.peer_gone
      ? '这段历史仍然可以看，但对方账号已注销，不能再发新消息'
      : `@${esc(u.username || '')}` + (u.last_login_at ? ` · 最近登录 ${esc(String(u.last_login_at))}` : '');
  // 对方账号已注销时 `peer_user` 是 null —— 此时没有可删的关系，别摆一个点了必然 404 的按钮
  const acts =
    c.builtin_key || !Number.isFinite(Number(u.id))
      ? ''
      : `<button class="btn btn-subtle btn-sm" type="button" data-teamwork-remark="${Number(u.id)}" ` +
        `title="改一个只你自己看得见的名字（对方那边不变）">✎ 备注</button>` +
        `<button class="btn btn-danger btn-sm" type="button" data-teamwork-del="${Number(u.id)}" ` +
        `title="删除好友（消息不删）">删除好友</button>`;
  box.innerHTML =
    // ⭐ 0.6.x：内置角色的标题走**暖色**，与左栏那一条同一个约定（
    //    「提醒助手的颜色要不一样」）—— 配色在 `desktop/app.css`，这里只落 class。
    `<div class="teamwork-conv-title${c.builtin_key ? ' builtin' : ''}">` +
    `<b>${esc(name)}</b><span class="teamwork-conv-sub">${sub}</span></div>` +
    acts;
}

/**
 * 功能：渲染右侧的消息流（或空态 / 未选会话的引导）。
 * @param {boolean} [force] - 是否无条件滚到底（刚打开会话时为 true）
 * @returns {void}
 */
export function renderTeamworkMessages(force) {
  const box = $('#teamwork-body');
  if (!box) return;
  // ⭐ 插槽会话（或协作看板）开着时消息区整个让位（`#teamwork-body` 已隐藏）—— 绝不往藏起来的节点里画
  if (teamworkState.slotConv || teamworkState.collabBoard) return;
  if (!teamworkState.activeConvId) {
    box.innerHTML =
      '<div class="empty-state"><div class="es-ico">💬</div><div class="es-title">还没有打开对话</div>' +
      '<div class="es-text">从左边点一个好友或会话就能开始 —— 也可以先把对方的登录名填进左上角的输入框，点「加好友」。</div></div>';
    return;
  }
  if (!teamworkState.messages.length) {
    // ⚠️ 已注销的对端不能再说「说点什么吧」—— 输入区此时是置灰的，两句文案自相矛盾
    const gone = activeConversation();
    // ⭐ 0.6.x：内置角色会话（提醒助手）的空态要**说清它靠什么出声** —— 它是这个功能唯一被看见的地方，
    //    而用户第一次点进来时它必然是空的（提醒要等到那个时刻才发）。
    //    ⚠️ 标题里的名字**取我自己起的那个**（`teamworkRowName()`），不写死「提醒助手」：名字是可以改的，
    //    写死就会出现「标题是我起的名、空态说『提醒助手还没有发过消息』」这种自相矛盾。
    if (gone && gone.builtin_key) {
      box.innerHTML =
        `<div class="empty-state"><div class="es-ico">🔔</div>` +
        `<div class="es-title">${esc(teamworkRowName(gone))}还没有发过消息</div>` +
        '<div class="es-text">上课提醒、任务到期提醒与每天的逾期汇总都会发在这里。' +
        '默认时刻是上课前 20 分钟、晚上 20:00、早上 07:00 —— 可以在这一屏右上角的「对话设置」里改。</div></div>';
      return;
    }
    box.innerHTML =
      gone && gone.peer_gone
        ? '<div class="empty-state"><div class="es-ico">💬</div><div class="es-title">这个对话没有历史消息</div>' +
          '<div class="es-text">对方账号已注销，所以这里既没有历史，也不能再发新消息。</div></div>'
        : '<div class="empty-state"><div class="es-ico">💬</div><div class="es-title">还没有消息</div>' +
          '<div class="es-text">说点什么吧 —— 消息只存在你自己的 NAS 上，不会经过任何第三方。</div></div>';
    return;
  }
  // ⚠️ 正文已经在 teamworkMsgHtml() 里 esc() 过 —— 这里是本模块唯一的 XSS 出口，别改成裸拼
  box.innerHTML =
    (teamworkState.hasMore ? '<div class="teamwork-more">↑ 向上滚动可以看更早的消息</div>' : '') +
    teamworkState.messages.map(teamworkMsgHtml).join('');
  scrollTeamworkToBottom(!!force);
}

// ---------- 插槽会话（0.6.x）----------

/** 外部请求要打开的插槽会话键（空串 = 没有待兑现的请求）。 @type {string} */
let wantSlot = '';

/**
 * 功能：兑现「外部请求打开某个插槽会话」—— ⭐ 0.8.4 新增（记账的 AI 圆环要用）。
 *
 * 说明：⭐⭐ 为什么要有这一步（与手机端**逐字同款**）：插槽会话的**条目**是 ai 片段异步
 *      `import()` 之后才登记的（`zx:teamwork-conv-entries`），而记账那颗圆环点下去时片段可能
 *      **还没挂** —— 直接 `openSlotConv(key)` 会因为它「不在条目表里」而**什么都不做**
 *      （表现是「点了 AI 圆环只停在对话列表」这种**不报错**的坏体验）。
 *      ⇒ 请求先记在 `wantSlot`，**每次左栏重画完**（含片段挂载完补画那一次）都来问一次，
 *      条目齐了才真开。
 * @returns {void}
 * @since 0.8.4
 */
function tryOpenWantSlot() {
  const k = String(wantSlot || '');
  if (!k) return;
  if (String(teamworkState.slotConv || '') === k) {
    wantSlot = ''; // 已经开着这一个 ⇒ 请求已兑现
    return;
  }
  if (!teamworkState.slotEntries.has(k)) return; // 条目还没登记 ⇒ 留着，等下一次
  wantSlot = '';
  openSlotConv(k);
}

// ⭐ 0.8.4：宿主转发过来的「请打开这个插槽会话」（它来自别处模块的 `zx:open-module`）
document.addEventListener('zx:teamwork-slot-open', (e) => {
  const k = String((e && e.detail && e.detail.key) || '');
  if (!k) return;
  wantSlot = k;
  tryOpenWantSlot();
});

// ⭐ 2h（丁 · 排版）：协作项目条目表变了（tasks 的 page 片段派这个留白事件）⇒ 重画左栏，
//    第三组「协作项目」跟着换。⚠️ 只在这一屏时重画 —— 不在对话屏时左栏本来就藏着，重画没意义。
document.addEventListener('zx:teamwork-collab-changed', () => {
  if (state.view === 'teamwork') renderTeamworkSide();
});

// ⭐ 2h（丁 · 排版）：协作看板那边请求「关掉看板」（例如刚把项目移出协作，它已无内容可画）⇒
//    当成本模块自己的「返回」：主区还给真会话。与 `closeCollabBoard()` 幂等。
document.addEventListener('zx:teamwork-board-close', () => {
  closeCollabBoard();
});

/**
 * 功能：打开一个**插槽会话**（会话区里由 `zx:teamwork-conv-entries` 登记的条目，键 = `it.key`）。
 *
 * 说明：⭐ 主区让位的形态：对话头仍由本模块画（`renderTeamworkHead()` 的插槽分支），
 *      消息流（`#teamwork-body`）与输入区（`.teamwork-compose`）隐藏，腾出的位置放
 *      `#teamwork-slot-main`（懒建，里头是 `teamwork-thread` 插槽）—— 插槽片段画什么、怎么聊，
 *      本模块一概不认识。⚠️ `teamwork-thread` 的挂载是异步的（动态 `import()`），
 *      不必 await：片段渲染完自己会出现。
 * @param {string} key - 条目键
 * @returns {void}
 */
export function openSlotConv(key) {
  const k = String(key || '');
  if (!teamworkState.slotEntries.has(k)) return;
  closeCollabBoard(); // ⭐ 与协作看板互斥：切到插槽会话就把看板关掉（主区同一时刻只让位给一个）
  teamworkState.activeConvId = null;
  teamworkState.slotConv = k;
  renderTeamworkSide();
  renderTeamworkHead();
  setSlotMain(true);
  mountSlots($('#teamwork-slot-mount'), 'teamwork-thread', { end: 'desktop', modules: state.modules, uiOf, me: state.me });
}

/**
 * 功能：关掉插槽会话、把主区还给真会话 —— 先发 `zx:teamwork-conv-close`（插槽片段用它停掉
 *      自己的流式请求等在途事务），再清容器、复位可见性。
 * @returns {void}
 */
export function closeSlotConv() {
  const k = teamworkState.slotConv;
  if (!k) return;
  teamworkState.slotConv = null;
  document.dispatchEvent(new CustomEvent('zx:teamwork-conv-close', { detail: { key: k } }));
  setSlotMain(false);
  renderTeamworkSide();
  renderTeamworkHead();
}

/**
 * 功能：打开一个**协作看板**（左栏「协作项目」组里的一条，键 ＝ 项目 id 字符串）。
 *
 * 说明：⭐ 与 `openSlotConv()` 是**同一个形态**：主区让位 —— 头由本模块画（`renderTeamworkHead()`
 *      的看板分支），消息流与输入区隐藏，腾出的位置放 `#teamwork-slot-main`（懒建）里的
 *      `teamwork-board` 挂载点，挂 `teamwork-board` 插槽片段（⛔ **不复用** `teamwork-thread`，
 *      那是会话线程）。点开的是**哪一个项目**随挂载上下文（`collabPid`）传给片段 ——
 *      本模块不认识那个片段画什么。
 *      ⚠️ 与「插槽会话」互斥：先 `closeSlotConv()` 把那边关掉（`setSlotMain()` 按 `collabBoard` 选挂载点）。
 *      ⚠️ 条目还没登记（左栏没画过这一组）时不开 —— 免得开出一个指向不存在项目的空看板。
 * @param {string} pid - 项目 id
 * @param {boolean} [openNew] - ⭐ 0.8.53：打开后**立刻摆出【新建任务】弹层**（项目行那颗 ＋ 用）
 * @returns {void}
 */
export function openCollabBoard(pid, openNew) {
  const k = pid == null ? '' : String(pid);
  if (!k) return;
  if (!teamworkState.collabEntries.has(k)) return;
  closeSlotConv(); // ⭐ 与「插槽会话」互斥
  teamworkState.activeConvId = null;
  teamworkState.collabBoard = k;
  renderTeamworkSide();
  renderTeamworkHead();
  setSlotMain(true);
  mountSlots($('#teamwork-board-mount'), 'teamwork-board', {
    end: 'desktop',
    modules: state.modules,
    uiOf,
    me: state.me,
    collabPid: k,
    openNew: !!openNew,
  });
}

/**
 * 功能：关掉协作看板、把主区还给真会话（幂等；没开着就什么都不做）。
 * @returns {void}
 */
export function closeCollabBoard() {
  if (!teamworkState.collabBoard) return;
  teamworkState.collabBoard = null;
  setSlotMain(false);
  renderTeamworkSide();
  renderTeamworkHead();
}

/**
 * 功能：主区在「真会话」与「插槽（会话线程 / 协作看板）」之间切换可见性 —— 头部三态共用
 *      `#teamwork-conv-head`，消息流与输入区让位给 `#teamwork-slot-main`（懒建一次、之后只切 `hidden`）。
 *
 * 说明：⭐ 2h（丁）起 `#teamwork-slot-main` 里放着**两个**挂载点 —— `#teamwork-slot-mount`
 *      （`teamwork-thread`，插槽会话）与 `#teamwork-board-mount`（`teamwork-board`，协作看板）。
 *      同一时刻只显示当前这一路，另一路**清空并藏起来**（两条路互斥，见 `openSlotConv()` /
 *      `openCollabBoard()`）；具体显示哪一路由 `teamworkState.collabBoard` 决定。
 * @param {boolean} on - true = 让位给插槽
 * @returns {void}
 */
function setSlotMain(on) {
  const mountId = teamworkState.collabBoard ? 'teamwork-board-mount' : 'teamwork-slot-mount';
  const body = $('#teamwork-body');
  // ⭐⭐ 0.8.61 修（真机：「团队协作从 AI 助手切换到其它对话，底部的输入框整体没有了，只有电脑端」）：
  //    这里从前是按**类名**找真人这一块（`#teamwork-view` 下的 `.teamwork-compose`）。
  //    0.8.55 起 AI 会话片段**自己也造了一个 `.teamwork-compose`**（`modules/ai/shared.js` 的
  //    `createAiThreadView()`，与好友聊天共用同一套类名 —— 那是「两套 UI 要一模一样」的要求），
  //    而下面 `insertBefore(slot, body.nextSibling)` 把插槽容器插在 `#teamwork-body` **之后、
  //    真人 compose 之前** ⇒ AI 片段一旦挂上过，那句按类名的查询命中的就是**AI 那一个**：
  //    `compose.hidden = false` 全设在它身上，真人的输入行从头到尾没被放开
  //    ⇒ 切回任何好友对话都只剩消息区，只能刷新页面。
  //    ⚠️ 第一次打开 AI 时看不出来（那时片段还没挂载，命中的仍是真人那一块），
  //    所以症状总在「切回去」的那一下才现 —— 而且**不报错**。
  //    ⛔ 别改回类名选择器（AI 那份是同一套类名，永远分不开），也别用 `:scope >` 赌结构。
  const compose = $('#teamwork-compose');
  let slot = $('#teamwork-slot-main');
  // ⚠️⭐ 懒建的判据是「里头那两个**挂载点**还在不在」，不是「`#teamwork-slot-main` 在不在」。
  //    只判外层那个 div，会让「外层还在、里头被清空」这种状态**再也建不回来** —— 真机上
  //    表现为「点开 AI 助手一片空白，只能重启应用」（0.6.4 修的就是这条）。
  if (on && body && body.parentNode && !(slot && slot.querySelector('#teamwork-slot-mount') && slot.querySelector('#teamwork-board-mount'))) {
    if (slot) slot.textContent = ''; // 结构残缺：整个重建
    slot = document.createElement('div');
    slot.id = 'teamwork-slot-main';
    slot.hidden = true;
    slot.innerHTML =
      '<div id="teamwork-slot-mount" data-slot="teamwork-thread"></div>' +
      '<div id="teamwork-board-mount" data-slot="teamwork-board"></div>';
    body.parentNode.insertBefore(slot, body.nextSibling);
  }
  if (body) body.hidden = !!on;
  if (compose) compose.hidden = !!on;
  if (slot) {
    slot.hidden = !on;
    // ⚠️⭐ 卸载 / 切换只清**挂载点里面**（片段画的 DOM），⛔ 绝不把外层那个 div 的内容清空 ——
    //    那连两个挂载点本身一起铲掉，而它们是懒建一次的（见上）⇒ 下次点开时 `mountSlots(null, …)`
    //    拿到 null 静默 return，消息区一片空白（0.6.4 修的正是这一条）。
    //    片段自己的收尾由 `closeSlotConv()` 的 `zx:teamwork-conv-close` 负责，不靠清 DOM。
    if (!on) {
      const tm = slot.querySelector('#teamwork-slot-mount');
      const bm = slot.querySelector('#teamwork-board-mount');
      if (tm) tm.textContent = '';
      if (bm) bm.textContent = '';
    } else {
      const tm = slot.querySelector('#teamwork-slot-mount');
      const bm = slot.querySelector('#teamwork-board-mount');
      if (tm) {
        tm.hidden = mountId !== 'teamwork-slot-mount';
        if (tm.hidden) tm.textContent = '';
      }
      if (bm) {
        bm.hidden = mountId !== 'teamwork-board-mount';
        if (bm.hidden) bm.textContent = '';
      }
    }
  }
}

// ---------- 打开会话 / 加载消息 ----------
/**
 * 功能：打开一个会话 —— 取最近一页消息、渲染、标记已读。
 *
 * 说明：⚠️ 取数回来时先核对 `teamworkState.activeConvId` 是否还是它：用户可能已经点了别的会话，
 *      慢回来的响应若照样写进 `messages`，就会出现「点 A 看到 B 的消息」这种串屏。
 *
 * @param {number} convId - 会话 id
 * @returns {Promise.<void>}
 */
export async function openConversation(convId) {
  const cid = Number(convId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  closeSlotConv(); // ⭐ 从插槽会话切回真会话：主区先还回来（反之 openSlotConv 也先清 activeConvId）
  closeCollabBoard(); // ⭐ 2h：从协作看板切回真会话同理（两条让位路径互斥）
  teamworkState.activeConvId = cid;
  teamworkState.messages = [];
  teamworkState.hasMore = false;
  teamworkState.loadingMore = false;
  renderTeamworkHead();
  renderTeamworkSide();
  const box = $('#teamwork-body');
  if (box) box.innerHTML = skeletonHtml(5);
  try {
    const r = await api('GET', `/api/teamwork/conversations/${cid}/messages?limit=${TEAMWORK_PAGE_SIZE}`);
    if (teamworkState.activeConvId !== cid) return;
    teamworkState.messages = (Array.isArray(r.items) ? r.items : []).map(normMsg);
    applyMsgTasks(r.items);
    teamworkState.hasMore = !!r.hasMore;
    renderTeamworkMessages(true);
    markConversationRead();
    const inp = $('#teamwork-input');
    if (inp) inp.focus();
  } catch (e) {
    if (teamworkState.activeConvId !== cid) return;
    teamworkState.messages = [];
    if (box) {
      box.innerHTML =
        '<div class="empty-state"><div class="es-ico">⚠️</div><div class="es-title">这个对话打不开</div>' +
        `<div class="es-text">${esc(e.message)}<br />最常见的原因是你们已经<b>不是好友</b>了 —— ` +
        '重新加回好友之后，这段对话的历史会原样回来（消息一直没被删）。</div></div>';
    }
    toast(e.message, true);
  }
}

/**
 * 功能：点好友 → 打开（或新建）与他的会话。
 *
 * 说明：⭐ 先用会话列表里的 `conversation_id`（已有就不打接口），没有才 `POST /api/teamwork/conversations`
 *      （那个接口是**幂等**的，两个设备同时点也只会有一个会话）。
 *      `opening` 标志挡住连点：连点两次会发两次 POST —— 虽然幂等，但两次 `loadTeamworkOverview`
 *      互相覆盖回来仍是浪费。
 *
 * @param {number} friendId - 对方账号 id
 * @returns {Promise.<void>}
 */
export async function openTeamworkWithFriend(friendId) {
  const fid = Number(friendId);
  const f = teamworkState.friends.find((x) => x.user && Number(x.user.id) === fid);
  if (f && f.conversation_id) return openConversation(f.conversation_id);
  if (teamworkState.opening) return;
  teamworkState.opening = true;
  try {
    const r = await api('POST', '/api/teamwork/conversations', { friendId: fid });
    await loadTeamworkOverview();
    await openConversation(r.id);
  } catch (e) {
    toast(e.message, true);
  } finally {
    teamworkState.opening = false;
  }
}

/**
 * 功能：向上翻历史 —— 用 `before=<当前最早一条的 id>` 再取一页并合并。
 *
 * 说明：⭐ 合并用 `mergeById()`（幂等），插入后**把滚动位置往下补回原来的高度**：
 *      新内容插在顶部，不补的话视口会跟着内容一起跳，用户会以为自己点错了。
 *      ⚠️ `hasMore` 是「还能不能继续往上翻」的唯一依据（服务端只在 `before` 模式下有意义），
 *      到 false 时上面会显示不出提示条，滚动也不会再触发请求。
 *
 * @returns {Promise.<void>}
 */
async function loadOlderMessages() {
  const cid = Number(teamworkState.activeConvId);
  if (!cid || teamworkState.loadingMore || !teamworkState.hasMore || !teamworkState.messages.length) return;
  const box = $('#teamwork-body');
  if (!box) return;
  teamworkState.loadingMore = true;
  const before = Number(teamworkState.messages[0].id);
  const prevH = box.scrollHeight;
  try {
    const r = await api('GET', `/api/teamwork/conversations/${cid}/messages?before=${before}&limit=${TEAMWORK_PAGE_SIZE}`);
    if (teamworkState.activeConvId !== cid) return;
    teamworkState.messages = mergeById(teamworkState.messages, (Array.isArray(r.items) ? r.items : []).map(normMsg));
    applyMsgTasks(r.items);
    teamworkState.hasMore = !!r.hasMore;
    renderTeamworkMessages(false);
    box.scrollTop += box.scrollHeight - prevH;
  } catch (e) {
    toast(e.message, true);
  } finally {
    teamworkState.loadingMore = false;
  }
}

/**
 * 功能：消息流容器的滚动监听 —— 滚到接近顶部时自动翻历史。
 *
 * 说明：⚠️ 挂在 `#teamwork-body` 本身（它是**静态骨架**，从头到尾都在），
 *      而不是靠事件委托：`scroll` 事件**不冒泡**，委托在普通阶段根本收不到。
 *
 * @returns {void}
 */
function onTeamworkScroll() {
  const box = $('#teamwork-body');
  if (!box || box.scrollTop > 40) return;
  loadOlderMessages();
}

// ---------- 发送 / 加好友 / 关系操作 ----------
/**
 * 功能：发一条消息（`POST /api/teamwork/conversations/:id/messages`）—— 成功后立刻就地插进消息流。
 *
 * 说明：⭐ **不等服务端推回来**：同一账号的其它端会收到 SSE，自己这一端也收得到，
 *      但等它绕一圈再显示会有肉眼可见的延迟。这里先插一条本地消息（id 用响应里的真 id），
 *      SSE 到达时 `mergeById()` 按 id 去重把它覆盖掉 —— 不会有重复气泡。
 *      ⚠️ 失败时把正文**还回输入框**：用户敲了一百个字，报个错就把它吞掉是不可接受的。
 *
 * @returns {Promise.<void>}
 */
export async function sendTeamworkMessage() {
  const cid = Number(teamworkState.activeConvId);
  if (!cid) return toast('先在左边选一个好友或会话', true);
  // ⚠️ 对方账号已注销：服务端允许读历史但拒绝发新消息 —— 在这里拦下并说清原因，
  //    别让用户敲完一整段话才吃一个 400（与 syncTeamworkComposer() 置灰是同一条规则）
  const conv = activeConversation();
  if (conv && conv.peer_gone) {
    return toast('对方账号已注销，这个对话只能看历史消息了', true);
  }
  const inp = $('#teamwork-input');
  const body = inp ? String(inp.value || '').trim() : '';
  if (!body) return;
  // ⭐ 0.7.7：清空之后要把高度一起收回去（否则发完一条长消息，输入框还占着半屏）
  if (inp) {
    inp.value = '';
    autoGrow(inp);
  }
  try {
    const r = await api('POST', `/api/teamwork/conversations/${cid}/messages`, { body });
    const msg = normMsg({
      id: r.id,
      conversationId: r.conversationId,
      senderId: myUserId(),
      body,
      createdAt: r.createdAt,
    });
    teamworkState.messages = mergeById(teamworkState.messages, [msg]);
    applyMessageToConversations(msg);
    renderTeamworkMessages(true);
    renderTeamworkSide();
    if (inp) inp.focus();
  } catch (e) {
    if (inp) {
      inp.value = body;
      autoGrow(inp);
    }
    toast(e.message, true);
  }
}

// ================================================================ ⭐ 0.8.54：输入框左边那颗 ＋

/**
 * 发送菜单的三项 —— 顺序就是那句话的顺序：「发送图片、协作项目任务、普通任务」。
 * @type {Array.<{act: string, icon: string, title: string, desc: string}>}
 */
const SEND_MENU_ITEMS = [
  { act: 'image', icon: '🖼', title: '发送图片', desc: '挑一张图（png / jpg / webp / gif，8 MB 以内）' },
  { act: 'collab', icon: '📁', title: '协作项目任务', desc: '把某个协作项目里的任务发给对方（按项目分）' },
  { act: 'daily', icon: '✅', title: '普通任务', desc: '把日常任务 / 我的项目任务发给对方（按项目分）' },
];

/**
 * 功能：把一条**已经发出去**的消息并进当前屏（⭐ 0.8.54）—— 文本 / 卡片 / 图片共用。
 *
 * 说明：⚠️ 与 `sendTeamworkMessage()` 里那三行是同一套口径（`mergeById` → 会话列表 → 重画），
 *      抽出来只是因为「发卡片」「发图片」两条新路都要它 —— ⛔ 别让任何一条路自己拼一半。
 *      ⚠️ `kind` / `meta` 必须一起带：漏了它俩，卡片会**安静地**退回一句降级文本（不报错）。
 * @param {{id: number, conversationId: number, createdAt: string}} r - 服务端返回
 * @param {string} body - 降级文本（服务端也存的是它）
 * @param {?string} kind - 消息种类（`task_card` / `image`；纯文本传 null）
 * @param {?Object} meta - 结构化载荷（已解析成对象）
 * @returns {void}
 */
function pushSentMessage(r, body, kind, meta) {
  const msg = normMsg({
    id: r.id,
    conversationId: r.conversationId,
    senderId: myUserId(),
    body,
    createdAt: r.createdAt,
    kind: kind || null,
    meta: meta || null,
  });
  teamworkState.messages = mergeById(teamworkState.messages, [msg]);
  applyMessageToConversations(msg);
  renderTeamworkMessages(true);
  renderTeamworkSide();
}

/**
 * 功能：电脑端的「看大图」—— 在 `body` 上盖一层浮层，点任意处 / 按 Esc 关掉（⭐ 0.8.54）。
 *
 * 说明：⚠️ 手机端**不用这个**：那边要压一条 history 才能让返回键先关图（见 `shared.js` 的
 *      `bindImageZoom()` 说明）—— 两边共用同一层浮层的话，手机返回会直接退出页面。
 * @param {string} url - 图片地址（内容寻址，服务端已校验过权限）
 * @param {string} name - 文件名（只用于 `alt`）
 * @returns {void}
 */
function openTeamworkImageBox(url, name) {
  const old = document.getElementById('tw-imgbox');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'tw-imgbox';
  box.className = 'tw-imgbox';
  box.innerHTML = `<img class="tw-imgbox-img" src="${url}" alt="${esc(name)}">`;
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

/**
 * 功能：打开**发送菜单**（⭐ 0.8.54：「点击加号可以发送图片、协作项目任务、普通任务」）。
 *
 * 说明：⚠️ 没选会话 / 对方已注销时**不打开**（与服务端拒发同一条规则）——
 *      让用户挑完任务才发现发不出去，比一开始就说清楚更费事。
 * @returns {void}
 */
function openSendMenu() {
  const cid = Number(teamworkState.activeConvId);
  if (!cid) return toast('先在左边选一个好友或会话', true);
  const conv = activeConversation();
  if (conv && conv.peer_gone) return toast('对方账号已注销，这个对话只能看历史消息了', true);
  openModal(
    '发送',
    '<div class="tw-send-menu">' +
      SEND_MENU_ITEMS.map(
        (it) =>
          '<button class="tw-send-item" type="button" data-tw-send="' +
          it.act +
          '">' +
          '<span class="tw-send-ico">' +
          it.icon +
          '</span>' +
          '<span class="tw-send-txt"><b>' +
          esc(it.title) +
          '</b><small>' +
          esc(it.desc) +
          '</small></span>' +
          '</button>',
      ).join('') +
      '</div>',
    { mid: true },
  );
  setModalSave('关闭');
  // ⚠️⭐ `openModal()` **不会**清掉 `#modal-save` 上一位使用者的 `onclick`（`openConfirmModal()`
  //    那类弹层会把它改成「真的去做那件事」）⇒ 这里必须显式改回「只关窗」，
  //    否则这颗「关闭」可能把上一个弹层的删除动作再执行一遍。
  const saveBtn = $('#modal-save');
  if (saveBtn) saveBtn.onclick = () => closeModal();
}

/**
 * 功能：发图片的第一步 —— 打开文件框（真正的上传在 `uploadImageAndSend()`）。
 * @returns {void}
 */
function pickSendImage() {
  const el = $('#teamwork-img-file');
  if (el) el.click();
}

/**
 * 功能：把选中的图片**上传并发出去**（⭐ 0.8.54）—— 二进制走裸 `fetch`，元数据走查询串。
 *
 * 说明：⚠️ ⛔ 不用 `api()`（它固定 JSON 体）；`Content-Type` 写死 `application/octet-stream`
 *      （与协作附件上传同一条路，服务端**自己派生** MIME，不信客户端）。
 *      ⚠️ 401 要回登录页（裸 `fetch` 绕过了 `api()` 的统一处理）；非 2xx 弹服务端那句原话。
 * @param {File} file - 用户选中的图片
 * @returns {Promise.<void>}
 */
async function uploadImageAndSend(file) {
  const cid = Number(teamworkState.activeConvId);
  if (!cid || !file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(String(file.type || ''))) {
    return toast('只支持 png / jpg / webp / gif 这几种图片', true);
  }
  if (Number(file.size) > 8 * 1024 * 1024) return toast('图片太大（上限 8 MB）', true);
  try {
    const url =
      `${BASE}/api/teamwork/conversations/${cid}/images?name=` + encodeURIComponent(String(file.name || 'image'));
    const r = await fetch(url, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const j = await r.json().catch(() => null);
    if (r.status === 401) {
      backToLogin();
      return;
    }
    if (!r.ok) return toast((j && j.error) || 'HTTP ' + r.status, true);
    pushSentMessage(j, `【图片】${String(file.name || '图片')}`, 'image', j.meta || null);
  } catch (e) {
    toast(e && e.message ? e.message : '图片发送失败', true);
  }
}

/**
 * 功能：打开**任务选择**弹窗（⭐ 0.8.54）—— 按项目分组的可点列表，点一条就发出去。
 *
 * @param {string} kind - `'collab'`（协作项目任务）/ `'daily'`（普通任务）
 * @returns {Promise.<void>}
 */
async function openSendTaskPicker(kind, onPick) {
  const cid = Number(teamworkState.activeConvId);
  // ⭐ 0.8.55：**代挑**模式（AI 会话借这个选择器把任务发给 AI）不需要当前会话 ——
  //    它只借「挑一条任务」这一段，不是要往会话里发消息。
  const delegate = typeof onPick === 'function' ? onPick : null;
  if (!cid && !delegate) return toast('先在左边选一个好友或会话', true);
  const isCollab = kind === 'collab';
  sendPick = {
    kind: isCollab ? 'collab' : 'daily',
    groups: [],
    q: '',
    tab: 'all',
    // ⚠️ 选中后**回传给调用方**而不是发消息（null = 老路径：往当前会话发卡片）
    delegate,
  };
  // ⚠️ 先把弹窗摆出来再取数（取数失败就把这句话写进同一个弹窗，而不是什么都不发生）
  openModal(
    isCollab ? '发送协作项目任务' : '发送普通任务',
    '<div class="tw-pick-empty">正在读取任务…</div>',
    { mid: true },
  );
  setModalSave('关闭');
  // ⚠️ 同上：把主按钮改回「只关窗」，⛔ 不继承上一颗的 onclick
  const saveBtn = $('#modal-save');
  if (saveBtn) saveBtn.onclick = () => closeModal();
  // ⚠️ 先声明后赋值（不是 `let groups = []`）：初值永远被覆盖，eslint 的
  //    no-useless-assignment 会把它当死代码（本项目零警告门禁）
  let groups;
  try {
    groups = await fetchSendGroups(isCollab ? 'collab' : 'daily');
  } catch (e) {
    const body = $('#modal-body');
    if (body) body.innerHTML = `<div class="tw-pick-empty">${esc((e && e.message) || '读取任务失败')}</div>`;
    return;
  }
  // ⚠️ `await` 期间用户可能已经关掉弹窗（或点了别的一项）⇒ 别再往里写。
  //    ⚠️⭐ 电脑端弹窗的「关」是 `.hidden` 类（`closeModal()` 加它），⛔ 不是手机端那个 `.on`
  if (!isModalOpen()) return;
  sendPick.groups = Array.isArray(groups) ? groups : [];
  const body = $('#modal-body');
  if (body) body.innerHTML = pickPanelHtml(sendPick.groups, sendPick);
}

/**
 * 发送任务弹窗当前的筛选状态（⭐ 0.8.54）—— 与手机端同名同义（那一份在 `mobile.js`）。
 * @type {{kind: string, groups: Array.<Object>, q: string, tab: string}}
 */
let sendPick = { kind: 'collab', groups: [], q: '', tab: 'all', delegate: null };

/**
 * 功能：按当前筛选条件**只重画列表区**（⭐ 0.8.54）。
 *
 * 说明：⚠️ 只换 `[data-pick-list]`，⛔ 不整块重画弹窗正文 —— 搜索框会被重建，输入法当场断。
 * @returns {void}
 */
function paintSendPickList() {
  const body = $('#modal-body');
  if (!body) return;
  const list = body.querySelector('[data-pick-list]');
  if (list) list.innerHTML = pickListHtml(filterPickGroups(sendPick.groups, sendPick));
  const tabs = body.querySelector('.tw-pick-tabs');
  if (tabs) {
    for (const b of tabs.querySelectorAll('[data-pick-tab]')) {
      b.classList.toggle('on', String(b.dataset.pickTab || '') === sendPick.tab);
    }
  }
}

/**
 * 功能：电脑端弹窗开着吗（⭐ 0.8.54）。
 *
 * 说明：⚠️ 判据是 `.hidden` **不在**（`closeModal()` 加它、`openModal()` 摘它）——
 *      ⛔ 别照抄手机端的 `.on`：两端的开关标记本来就不是同一个类名，抄错的表现是
 *      「弹窗打开了、里面永远是空的」（这边永远判成「已关掉」直接 return）。
 * @returns {boolean} 真 = 弹窗正开着
 */
function isModalOpen() {
  const el = document.getElementById('modal');
  return Boolean(el) && !el.classList.contains('hidden');
}

/**
 * 功能：点一条任务 ⇒ 取回它的字段、拼一张**任务卡片**发给对方（⭐ 0.8.54）。
 *
 * 说明：⭐ 卡片载荷是**快照**：标题 / 截止 / 重要紧急 / 备注在发送那一刻定死，
 *      收件人看到的是「那一刻的样子」，⛔ 对话不去反查对方任务（那是越权通道）。
 *      ⚠️ 协作任务带上 `src: 'collab'` ＋ 项目名：卡片抬头写「分享了「项目名」里的任务」，
 *      并且**不给**「收进我的任务板」那颗按钮（对方本来就是项目成员）。
 * @param {string} key - `data-pick` 的值（`daily:<id>` / `collab:<id>:<pid>`）
 * @returns {Promise.<void>}
 */
async function sendPickedTask(key) {
  const cid = Number(teamworkState.activeConvId);
  const parts = String(key || '').split(':');
  const kind = parts[0];
  const tid = Number(parts[1]);
  const pid = Number(parts[2]);
  if (!tid) return;
  // ⭐ 0.8.55：代挑模式 —— 选中就回传给调用方（AI 会话要自己发，不走会话消息那条路）
  const delegate = sendPick.delegate;
  if (!delegate && !cid) return;
  closeModal();
  const me = state.me && (state.me.display_name || state.me.username);
  try {
    let card;
    if (kind === 'collab') {
      const b = await api('GET', `/api/collab/projects/${pid}/board`);
      const all = [];
      for (const g of Object.keys(b.groups || {})) for (const t of b.groups[g] || []) all.push(t);
      for (const t of Array.isArray(b.unknown) ? b.unknown : []) all.push(t);
      const t = all.find((x) => Number(x.id) === tid);
      if (!t) return toast('这条任务已经不在了', true);
      card = {
        title: t.title || '未命名任务',
        due: t.due_date || '',
        important: Number(t.important) ? 1 : 0,
        urgent: Number(t.urgent) ? 1 : 0,
        note: String(t.description || '').slice(0, 500),
        src: 'collab',
        project: (b.project && b.project.name) || '',
      };
    } else {
      const tasks = await api('GET', '/api/tasks');
      const pool = (Array.isArray(tasks && tasks.daily) ? tasks.daily : []).concat(
        ...Object.keys((tasks && tasks.byProject) || {}).map((k) => tasks.byProject[k] || []),
      );
      const t = pool.find((x) => Number(x.id) === tid);
      if (!t) return toast('这条任务已经不在了', true);
      card = {
        title: t.title || '未命名任务',
        due: t.due_date || '',
        important: Number(t.important) ? 1 : 0,
        urgent: Number(t.urgent) ? 1 : 0,
        note: String(t.content || '').slice(0, 500),
        from: me ? String(me) : '',
        src: 'daily',
      };
    }
    const bodyText = `【任务】${card.title}` + (card.due ? ` · 截止 ${card.due}` : '');
    if (delegate) return void delegate({ card, bodyText });
    const r = await api('POST', `/api/teamwork/conversations/${cid}/messages`, {
      body: bodyText,
      kind: 'task_card',
      meta: card,
    });
    pushSentMessage(r, bodyText, 'task_card', card);
    toast('已发送');
  } catch (e) {
    toast((e && e.message) || '发送失败', true);
  }
}

/**
 * 功能：⭐ 0.8.55 —— 把「挑一条任务」这件事借给别的会话用（目前是 AI 助手）。
 *
 * 说明：⭐ 走留白事件：AI 模块**不认识**任务表，也不该复制一份选择器 ——
 *      它派发 `zx:ai-pick-task`，这里用**同一个弹层**挑完，把 `{card, bodyText}` 回给它。
 *      ⚠️ 只挂一次（模块级标记）：片段每次进对话页都会重新执行本文件。
 * @returns {void}
 */
export function bindChatPickTask() {
  if (bindChatPickTask._bound) return;
  bindChatPickTask._bound = true;
  document.addEventListener('zx:ai-pick-task', (e) => {
    const d = e && e.detail;
    if (!d || typeof d.done !== 'function') return;
    void openSendTaskPicker(String(d.act == null ? 'daily' : d.act), d.done);
  });
}

/**
 * 功能：按登录名发好友申请（`POST /api/teamwork/friends`）。
 *
 * 说明：⭐ 一期**没有「可添加的账号」列表**（那等于把全 NAS 的账号摊开给人挑，
 *      既有隐私问题也不需要）：所以这里的输入框配了一句「让对方把登录名给你」的说明，
 *      空态里也写着同一句。⚠️ 目标不存在时服务端回 404，这里原样把消息弹给用户看。
 *
 * @returns {Promise.<void>}
 */
export async function addTeamworkFriend() {
  const inp = $('#teamwork-friend-name');
  const name = inp ? String(inp.value || '').trim() : '';
  if (!name) return toast('请输入对方的登录名（让他把登录名给你）', true);
  try {
    const r = await api('POST', '/api/teamwork/friends', { username: name });
    if (inp) inp.value = '';
    await loadTeamworkOverview();
    toast(r && r.status === 'accepted' ? '你们已经是好友了' : '好友申请已发出，等对方同意');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：同意一条好友申请（正向动作，不再弹确认框 —— 按钮本身已经说清了要发生什么）。
 * @param {number} friendId - 申请人账号 id
 * @returns {Promise.<void>}
 */
async function acceptTeamworkFriend(friendId) {
  try {
    await api('POST', `/api/teamwork/friends/${Number(friendId)}/accept`);
    await loadTeamworkOverview();
    // ⭐ 0.7.6：这个动作现在只可能从「申请」弹窗里发起（左栏那一区已经不存在了）⇒
    //   把弹窗重画成最新列表 —— 否则用户会盯着一条「刚同意过、却还写着等处理」的旧行。
    repaintTeamworkModal();
    toast('已同意，你们现在是好友了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：拒绝一条好友申请（先确认，并说清「对方不会知道被拒绝」）。
 * @param {number} friendId - 申请人账号 id
 * @returns {void}
 */
function confirmRejectFriend(friendId) {
  const f = teamworkState.incoming.find((x) => x.user && Number(x.user.id) === Number(friendId));
  const name = teamworkPeerName(f && f.user);
  openConfirmModal(
    '拒绝好友申请',
    `<p>确定拒绝「<b>${esc(name)}</b>」的好友申请吗？</p>` +
      `<p class="set-note">这条申请会从你的列表里消失。⚠️ 一期<b>刻意不告诉对方「被拒绝了」</b> —— ` +
      `对方那边看到的仍然是「等对方同意」（这是为了不制造已读回执式的社交压力）。</p>`,
    '拒绝申请',
    async () => {
      await api('POST', `/api/teamwork/friends/${Number(friendId)}/reject`);
      closeModal();
      await loadTeamworkOverview();
      repaintTeamworkModal();
      toast('已拒绝（对方不会收到「被拒绝」的提示）');
    },
  );
}

/**
 * 功能：删除好友（必须确认）—— ⭐ 文案要把「消息一条都没删」说清楚。
 *
 * 说明：⚠️ 这是本模块最容易误解的操作：删好友**关掉的是读取这道闸门**，不是清空聊天记录。
 *      用户在确认框里读到的这句话，就是他事后不惊慌的唯一依据（方案 §八-2）。
 *
 * @param {number} friendId - 对方账号 id
 * @returns {void}
 */
export function confirmRemoveFriend(friendId) {
  const fid = Number(friendId);
  const f =
    teamworkState.friends.find((x) => x.user && Number(x.user.id) === fid) ||
    teamworkState.conversations.find((c) => c.peer_user && Number(c.peer_user.id) === fid);
  const name = teamworkPeerName(f && (f.user || f.peer_user));
  openConfirmModal(
    '删除好友',
    `<p>确定把「<b>${esc(name)}</b>」从好友列表里删掉吗？</p>` +
      `<p class="set-note">⚠️ 删掉之后，<b>这个对话就读不到了</b>（你们俩都读不到，也发不出消息）。</p>` +
      `<p class="set-note">⭐ 但<b>消息一条都没有删除</b> —— 它仍然以明文存在你自己的 NAS 上。` +
      `重新加回好友之后，这段对话的历史<b>原样回来</b>。</p>`,
    '删除好友',
    async () => {
      await api('DELETE', `/api/teamwork/friends/${fid}`);
      closeModal();
      await loadTeamworkOverview();
      repaintTeamworkModal();
      toast('已删除好友（消息仍在，重新加回即可恢复）');
    },
  );
}

/**
 * 功能：拉黑对方（必须确认）—— 文案里写明「双向冻结」与「取消拉黑 = 回到陌生人」。
 * @param {number} friendId - 对方账号 id
 * @returns {void}
 */
export function confirmBlockFriend(friendId) {
  const fid = Number(friendId);
  const f = teamworkState.friends.find((x) => x.user && Number(x.user.id) === fid);
  const name = teamworkPeerName(f && f.user);
  openConfirmModal(
    '拉黑对方',
    `<p>确定拉黑「<b>${esc(name)}</b>」吗？</p>` +
      `<p class="set-note">拉黑之后：对方再发来的好友申请会被拒绝；你们已有的对话<b>双方都读不到</b>；` +
      `消息同样<b>一条都不会删</b>。</p>` +
      `<p class="set-note">⚠️ 「取消拉黑」等于回到<b>陌生人</b>（需要重新加好友才能聊天）—— ` +
      `本应用不记录「拉黑之前是不是好友」，所以不会自动恢复成好友。</p>`,
    '拉黑',
    async () => {
      await api('POST', `/api/teamwork/friends/${fid}/block`, { blocked: true });
      closeModal();
      await loadTeamworkOverview();
      repaintTeamworkModal();
      toast('已拉黑（对方发来的申请会被拒绝）');
    },
  );
}

/**
 * 功能：取消拉黑（必须确认）—— 说清「回到陌生人，要重新加好友」。
 * @param {number} friendId - 对方账号 id
 * @returns {void}
 */
export function confirmUnblockFriend(friendId) {
  const fid = Number(friendId);
  const f = teamworkState.blocked.find((x) => x.user && Number(x.user.id) === fid);
  const name = teamworkPeerName(f && f.user);
  openConfirmModal(
    '取消拉黑',
    `<p>确定不再拉黑「<b>${esc(name)}</b>」吗？</p>` +
      `<p class="set-note">取消之后你们回到<b>陌生人</b>状态：要重新加好友才能再聊天、再看历史。</p>`,
    '取消拉黑',
    async () => {
      await api('POST', `/api/teamwork/friends/${fid}/block`, { blocked: false });
      closeModal();
      await loadTeamworkOverview();
      repaintTeamworkModal();
      toast('已取消拉黑（回到陌生人，需要重新加好友）');
    },
  );
}

// ---------- 折叠 / 右键菜单 / 消息转任务 / 备注（0.4.4）----------
/**
 * 功能：收起 / 展开左栏的**一段**（`assist` = 内置助手 / `convs` = 好友）—— 就地翻标志位再重画左栏。
 *
 * 说明：⚠️ 重画会让 `#teamwork-side-body` 的滚动位置回到顶部，所以先把 `scrollTop` 记下来再补回去：
 *      会话一多这块就有滚动条，「收起一节就把人弹回页首」是纯粹的骚扰。
 *      ⚠️⭐ 只认 `teamworkState.fold` 里**已经有的键**（现在是 `assist` / `convs`）：这是刻意的 ——
 *      `data-teamwork-fold` 将来多写一个别的值，宁可「点了没反应」也不许静默往 `teamworkState.fold`
 *      里塞新键（那是永不生效的死状态）。⚠️ 所以**新加一段时要先去 `teamworkState.fold` 里加上那个键**。
 *
 * @param {string} key - 折叠键（`assist` / `convs`）
 * @returns {void}
 */
function toggleTeamworkFold(key) {
  if (!Object.prototype.hasOwnProperty.call(teamworkState.fold, key)) return;
  teamworkState.fold[key] = !teamworkState.fold[key];
  const before = $('#teamwork-side-body');
  const top = before ? before.scrollTop : 0;
  renderTeamworkSide();
  const after = $('#teamwork-side-body');
  if (after) after.scrollTop = top;
}

/**
 * 功能：收起右键菜单 —— 摘掉元素与它挂上的三个监听器（幂等，没有菜单时什么都不做）。
 *
 * 说明：⚠️ 三个监听器都挂在 `document` 上、且都用**捕获**：`scroll` 事件不冒泡，
 *      只有捕获阶段能在 document 上收到「内部某个元素滚了」。
 *
 * @returns {void}
 */
function closeTeamworkMenu() {
  if (teamworkCtx.el) teamworkCtx.el.remove();
  if (teamworkCtx.onDoc) document.removeEventListener('click', teamworkCtx.onDoc, true);
  if (teamworkCtx.onKey) document.removeEventListener('keydown', teamworkCtx.onKey, true);
  if (teamworkCtx.onScroll) document.removeEventListener('scroll', teamworkCtx.onScroll, true);
  teamworkCtx.el = null;
  teamworkCtx.onDoc = null;
  teamworkCtx.onKey = null;
  teamworkCtx.onScroll = null;
}

/**
 * 功能：在鼠标位置弹一个右键菜单（0.4.4）。
 *
 * 说明：⭐ 用 `document.body` + `position: fixed` 而不是往 `#teamwork-view` 里塞：这一屏的左右两栏
 *      各自带 `overflow: hidden`，菜单一旦落进它们就会被裁掉半截（本项目记过同款坑）。
 *      ⚠️ 位置要夹回窗口内：右键点在屏幕右下角时，菜单默认会露到窗口外面去。
 *      ⚠️ 点菜单项**先收起菜单再执行**：动作里多半会弹窗 / 重画，留着菜单在屏幕上会跟新内容打架。
 *
 * @param {number} x - 视口坐标 X（`event.clientX`）
 * @param {number} y - 视口坐标 Y（`event.clientY`）
 * @param {Array.<{ key: string, label: string, run: Function }>} items - 菜单项（`label` 会被转义）
 * @returns {void}
 */
function openTeamworkMenu(x, y, items) {
  closeTeamworkMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.id = 'teamwork-ctx';
  el.setAttribute('role', 'menu');
  el.innerHTML = items
    .map(
      (it) =>
        `<button class="ctx-item" type="button" role="menuitem" data-ctx="${esc(it.key)}">${esc(it.label)}</button>`,
    )
    .join('');
  document.body.appendChild(el);
  // 先插进文档再量尺寸（`offsetWidth` 对游离节点是 0）
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 8))}px`;
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ctx]');
    if (!b) return;
    const it = items.find((i) => i.key === b.dataset.ctx);
    closeTeamworkMenu();
    if (it && typeof it.run === 'function') it.run();
  });
  teamworkCtx.el = el;
  teamworkCtx.onDoc = (ev) => {
    if (!el.contains(ev.target)) closeTeamworkMenu();
  };
  teamworkCtx.onKey = (ev) => {
    if (ev.key === 'Escape') closeTeamworkMenu();
  };
  teamworkCtx.onScroll = () => closeTeamworkMenu();
  document.addEventListener('click', teamworkCtx.onDoc, true);
  document.addEventListener('keydown', teamworkCtx.onKey, true);
  document.addEventListener('scroll', teamworkCtx.onScroll, true);
}

/**
 * 功能：右键**一条消息** → 菜单「添加到任务 / 复制文本」（0.4.4，第 3 条）。
 *
 * 说明：⚠️ 只在真的点中一条消息时才接管右键（查不到 `[data-teamwork-msg]` 就直接 return，
 *      让浏览器原生菜单照常出现在空白处 / 输入框上）。
 *      ⚠️ 拦下右键＝**顶掉浏览器原生菜单**，所以「复制文本」这一条必须给：
 *      不给的话用户在这一屏再也复制不走消息（只能用拖选 + Ctrl+C）。
 *      ⚠️ 正文按 id 从 `teamworkState.messages` 里取，**不从 DOM 上读**：
 *      一是 `data-*` 里不放用户内容，二是气泡里的正文可能被后到的同 id 消息覆盖过。
 *
 * @param {MouseEvent} e - 右键事件
 * @returns {void}
 */
function onTeamworkMessageMenu(e) {
  const hit = e.target && e.target.closest ? e.target.closest('[data-teamwork-msg]') : null;
  if (!hit) return;
  const msg = teamworkState.messages.find((m) => Number(m.id) === Number(hit.dataset.teamworkMsg));
  if (!msg) return;
  e.preventDefault();
  const items = [
    { key: 'task', label: '📋 添加到任务', run: () => openMessageTaskModal(msg) },
    { key: 'copy', label: '📄 复制文本', run: () => copyTeamworkMessage(msg) },
  ];
  // ⭐ 0.6.0 菜单留白：插槽片段可以往消息菜单里添自己的条目 ——
  //    派发是**同步**的，监听方在 `detail.items` 上 push 即可；本文件不认识添菜单的是谁，
  //    没有监听方时事件无人在意，菜单照旧两项。
  document.dispatchEvent(new CustomEvent('zx:teamwork-msg-menu', { detail: { msg, items } }));
  openTeamworkMenu(e.clientX, e.clientY, items);
}

/**
 * 功能：点任务卡片上的一个动作按钮（0.6.4，任务联动）—— 「收进我的任务板」这类按钮由**别的模块**
 *      通过 `zx:teamwork-card-actions` 留白事件供给，本模块只把点击转交过去（不认识具体模块）。
 *
 * 说明：⚠️ 消息对象**按 id 从 `teamworkState.messages` 里取**，不从 DOM 上读卡片里的字（与右键菜单
 *      同一条规矩：`data-*` 里不放用户内容，而卡片正文是对方可控内容）。
 *      ⚠️ 找不到对应动作时说一句人话（不许静默）—— 点一下没反应，用户只会以为应用坏了；
 *      真正常见的原因是「提供这个动作的模块被关掉了 / 被删掉了」。
 *
 * @param {HTMLElement} btn - 被点的按钮（读 `data-card-act`）
 * @returns {void}
 */
function onTeamworkCardAct(btn) {
  const wrap = btn.closest('[data-teamwork-msg]');
  if (!wrap) return;
  const msg = teamworkState.messages.find((m) => Number(m.id) === Number(wrap.dataset.teamworkMsg));
  if (!msg) return;
  if (!runCardAction(msg, btn.dataset.cardAct)) toast('这个操作现在用不了（提供它的功能可能被关掉了）', true);
}

/**
 * 功能：右键**一位好友** → 菜单「改备注」（0.4.4，第 4 条）。
 *
 * 说明：⭐ 备注入口用右键而不是在行上再挤一颗按钮：一行本来就窄，右侧还站着
 *      「拉黑」「删好友」两颗，再加一颗会把名字挤成两三个字。
 *      ⚠️ 只认好友行（`data-teamwork-friend`）：正在聊的那个人的备注，走对话标题旁那颗「✎ 备注」。
 *      ⚠️⭐ 0.7.6：好友行搬进了**弹窗**，所以这条委托现在挂在弹窗容器（`#modal-body`）上，
 *      见 `bindTeamworkEvents()` 末尾 —— 左栏已经没有好友行了。
 *
 * @param {MouseEvent} e - 右键事件
 * @returns {void}
 */
function onTeamworkSideMenu(e) {
  const hit = e.target && e.target.closest ? e.target.closest('[data-teamwork-friend]') : null;
  if (!hit) return;
  e.preventDefault();
  const fid = Number(hit.dataset.teamworkFriend);
  openTeamworkMenu(e.clientX, e.clientY, [{ key: 'remark', label: '✎ 改备注', run: () => openRemarkModal(fid) }]);
}

/**
 * 功能：把一条消息的文字复制到剪贴板，并按结果说一句人话（环境不允许时给手动复制的兜底）。
 * @param {Object} msg - 归一后的消息
 * @returns {Promise.<void>}
 */
async function copyTeamworkMessage(msg) {
  const ok = await copyText(msg && msg.body ? msg.body : '');
  toast(ok ? '消息文字已复制' : '这个环境不允许自动复制，请手动选中复制', !ok);
}

/**
 * 功能：把一条消息变成一条任务 —— 弹窗里选**归属**（日常任务 / 某个项目）并设置任务自己的属性。
 *
 * 说明：⭐ 第 3 条：右键消息就能直接落成任务，属性与归属在弹窗里定。
 *      两个「不能省」的细节：
 *      ① **归属切换要联动字段**：日常任务表里没有负责人 / 标签两列（`checkDailyTask` 也不认），
 *         选「日常任务」时那两栏必须**收起来**，否则就是「填了会被丢掉」；
 *      ② **描述默认带来源引用**（谁、什么时候、说了什么）—— 任务与那句话的关联要落在数据上，
 *         否则过两周没人记得这条任务是从哪句话变来的。
 *      ⚠️ 标题取消息**首行**并截到 `TEAMWORK_TASK_TITLE_MAX`（服务端 100 字上限、超了报 400 不截断）。
 *      ⚠️ 保存成功后刷一次 `loadProjects()`：侧栏的「今日待办」与项目列表里就多了一条，
 *      不刷的话那个数字会一直停在旧值（本项目记过「静默过期」这类坑）。
 *
 * @param {Object} msg - 归一后的消息（右键的那一条）
 * @returns {void}
 */
export function openMessageTaskModal(msg) {
  const conv = activeConversation();
  // ⭐ 0.7.7：与 `teamworkMsgHtml()` 同一口径 —— 内置角色发的消息**不是「我说的」**，
  //    它只是恰好 `user_id` 写着我。漏了后半句，从提醒转出来的任务会写着「来自『我』的消息」（一句假话）。
  const from = Number(msg.userId) === myUserId() && !msg.senderBuiltin ? '我' : teamworkRowName(conv);
  const body = String(msg.body || '');
  const firstLine = (body.split('\n').find((l) => l.trim()) || '').trim();
  const title = [...firstLine].slice(0, TEAMWORK_TASK_TITLE_MAX).join('') || '来自对话的任务';
  const quote = `来自「${from}」的消息（${fmtTeamworkTime(msg.createdAt)}）：\n${body}`;
  const today = todayStr();
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const opts =
    '<option value="daily">日常任务（不归属任何项目）</option>' +
    projects
      .map((p) => `<option value="${Number(p.id)}">${esc(`${p.icon || '📁'} ${p.name || ''}`.trim())}</option>`)
      .join('');
  openModal(
    '添加到任务',
    `<div class="form-group"><label>归属项目 *</label><select id="mt-scope">${opts}</select></div>
    <div class="form-group"><label>任务标题 *</label><input type="text" id="mt-title" value="${esc(title)}" placeholder="要做什么？" /></div>
    <div class="form-group"><label>内容描述</label><textarea id="mt-desc">${esc(quote)}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label>任务日 *</label><input type="date" id="mt-start" value="${esc(today)}" /></div>
      <div class="form-group"><label>截止日期 *</label><input type="date" id="mt-due" value="${esc(today)}" /></div>
    </div>
    <div class="form-row" id="mt-proj-row">
      <div class="form-group"><label>负责人</label><input type="text" id="mt-assignee" placeholder="我" /></div>
      <div class="form-group"><label>标签</label><input type="text" id="mt-tag" placeholder="设计 / 物料" /></div>
    </div>
    <div class="form-group"><label>重要 / 紧急（决定四象限）</label>
      <div class="toggle-row">
        <label class="toggle"><input type="checkbox" id="mt-important"> 🔴 重要</label>
        <label class="toggle"><input type="checkbox" id="mt-urgent"> ⏰ 紧急</label>
      </div></div>
    <div class="form-group"><label>绑定网址</label><select id="mt-bookmark"></select></div>
    <p class="set-note">⭐ 消息原文已经填进「内容描述」里了，并写明了是谁在什么时候说的 —— 任务和那句话的关联就留在数据里，不必回头翻聊天记录。</p>`,
  );
  bindDateRangeMin('#mt-start', '#mt-due');
  fillBookmarkSelect('#mt-bookmark');
  // 归属切换：只有「项目任务」才认负责人与标签
  const syncScope = () => {
    const row = $('#mt-proj-row');
    if (row) row.classList.toggle('hidden', $('#mt-scope').value === 'daily');
  };
  $('#mt-scope').addEventListener('change', syncScope);
  syncScope();
  $('#modal-save').onclick = async () => {
    const t = $('#mt-title').value.trim();
    const start = $('#mt-start').value;
    const due = $('#mt-due').value;
    if (!t) return toast('请填写任务标题', true);
    if (!start || !due) return toast('请选择任务日与截止日期', true);
    if (start > due) return toast('任务日不能晚于截止日期', true);
    const scope = $('#mt-scope').value;
    const common = {
      title: t,
      start_date: start,
      due_date: due,
      important: $('#mt-important').checked ? 1 : 0,
      urgent: $('#mt-urgent').checked ? 1 : 0,
      status: 'todo',
      // ⭐ 0.5.2：绑的网址（`0` = 不绑）
      bookmark_id: Number($('#mt-bookmark').value) || 0,
      // ⭐ 0.4.4：记下「这条任务是从对话里的哪条消息建的」—— 消息下面那枚
      //    「已添加到任务」标记就是靠它反查出来的（只写一次，PUT 改不到它）。
      from_message_id: Number(msg.id),
    };
    try {
      let created = null;
      // ⭐ 0.7.1：统一走「任务创建」的对外入口 —— 两套字段名（`content` / `description`）它都认。
      //    ⚠️ `common` 里带了 `from_message_id`：它**只在创建时能写**，必须这一步给出去
      created = await createTask(
        scope,
        Object.assign(
          {
            content: $('#mt-desc').value.trim(),
            assignee: $('#mt-assignee').value.trim(),
            tag: $('#mt-tag').value.trim(),
          },
          common,
        ),
      );
      // ⭐ 就地补上标记（服务端下次取数时会给同一份）：不补的话要用户切走再回来才看得见
      if (created && created.id) {
        const key = Number(msg.id);
        if (!Array.isArray(teamworkState.msgTasks[key])) teamworkState.msgTasks[key] = [];
        teamworkState.msgTasks[key].push({
          scope: scope === 'daily' ? 'daily' : Number(scope),
          id: Number(created.id),
          title: t,
        });
        renderTeamworkMessages(false);
      }
      closeModal();
      await loadProjects();
      toast(scope === 'daily' ? '已添加到「日常任务」' : '已添加到项目任务');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：改「我给某位好友起的备注」（0.4.4，第 4 条）—— 留空 = 取消备注。
 *
 * 说明：⭐ 文案必须说清「只有你自己看得见」：这是用户唯一的疑问 ——「改了会不会被他发现」。
 *      ⚠️ 保存成功后 `loadTeamworkOverview()` 重取一次（服务端的 `remark` 才是真值），
 *      不就地改内存：左栏与对话头都从那一份数据画，改内存就又多一处「谁知道对方是否也是这个名」。
 *
 * @param {number} friendId - 对方账号 id
 * @returns {void}
 */
export function openRemarkModal(friendId) {
  const fid = Number(friendId);
  const f =
    teamworkState.friends.find((x) => x.user && Number(x.user.id) === fid) ||
    teamworkState.conversations.find((c) => c.peer_user && Number(c.peer_user.id) === fid);
  const real = teamworkPeerName((f && (f.user || f.peer_user)) || null);
  const cur = (f && (f.remark || f.peer_remark)) || '';
  openModal(
    '修改备注',
    `<div class="form-group"><label>备注（只有你自己看得见）</label>
      <input type="text" id="rm-input" maxlength="50" value="${esc(cur)}" placeholder="例如：张工（研发）" /></div>
    <p class="set-note">⭐ 备注只写在你自己的账号里 —— <b>对方那边一切照旧</b>：他看不到你给他起的名字，
    你给他发的消息、你们的会话也不受任何影响。它只是把你列表里的名字换成一个你更好认的称呼。</p>
    <p class="set-note">留空 = 取消备注，名字回到「${esc(real)}」。</p>`,
  );
  const inp = $('#rm-input');
  if (inp) inp.focus();
  $('#modal-save').onclick = async () => {
    const remark = $('#rm-input').value.trim();
    try {
      await api('POST', `/api/teamwork/friends/${fid}/remark`, { remark });
      closeModal();
      await loadTeamworkOverview();
      toast(remark ? '备注已保存' : '已取消备注');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

// ---------- 实时通道 ----------
/**
 * 功能：收到一条 SSE 事件 —— 只做「该刷哪块界面」的分派，不在这里解析业务数据。
 * @param {Object} ev - 服务端推来的事件对象
 * @returns {void}
 */
function onTeamworkStreamEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'message') return void onTeamworkMessageEvent(ev);
  if (ev.type === 'friend') {
    loadTeamworkOverview().catch((e) => toast(e.message, true));
  }
}

/**
 * 功能：处理 `type === 'message'` 的推送 —— 属于当前会话就合并进消息流，否则只刷会话列表。
 * @param {Object} ev - `{ type:'message', conversationId, message }`
 * @returns {void}
 */
function onTeamworkMessageEvent(ev) {
  const cid = Number(ev.conversationId);
  const msg = ev.message ? normMsg(ev.message) : null;
  if (!msg || !Number.isFinite(msg.id)) return;
  // ⚠️ 左栏里还没有这个会话（对方刚建了会话就发来第一条）⇒ 拉一次总览：
  //    否则这条消息在界面上没有落点，只更新一个不存在的数据行等于什么都没发生
  if (!teamworkState.conversations.some((c) => Number(c.id) === cid)) {
    loadTeamworkOverview().catch((e) => toast(e.message, true));
  } else {
    applyMessageToConversations(msg);
    renderTeamworkSide();
  }
  // ⭐ 0.5.2：通道常驻之后，`activeConvId` 在人离开对话视图后仍留着 ——
  //    必须同时要求 `state.view === 'teamwork'` 才算「正开着这个会话」：
  //    否则人在首页看板也会替他把新消息标成已读（回对话屏时未读数永远是 0）。
  if (state.view === 'teamwork' && cid === Number(teamworkState.activeConvId)) {
    teamworkState.messages = mergeById(teamworkState.messages, [msg]);
    renderTeamworkMessages(false);
    // 正开着这个会话 ⇒ 当场已读（后端只许游标前进，重复标记没有副作用）
    if (msg.userId !== myUserId() || msg.senderBuiltin) markConversationRead();
  }
}

/**
 * 功能：需要补齐增量时调用 —— 降级轮询的每一拍、在线对账的每一拍、以及长连接重连成功的那一刻。
 *
 * ⭐ **必须幂等**：`modules/teamwork/teamwork-stream.js` 从任何非在线状态切回在线时会先调一次它，
 *    与轮询那一拍可能挨得很近；`mergeById()` 按 id 去重，重复拉不会出现重复气泡。
 *
 * ⭐ 0.5.2：⭐ 不在这一屏就**一个请求都不发** —— 电脑版侧栏没有全局未读红点，
 *    通道常驻只为「停在对话这一屏时是活的」；数据在 `openTeamwork()` 进屏时本来就现取，
 *    后台对账纯属浪费。（手机版不同：红点挂在底部标签上，后台每 30 秒对账一次，
 *    见 `modules/teamwork/mobile.js` 的 `teamworkPoll()`。）
 * ⭐ 0.5.2：会话消息**不再按 `after` 游标追增量，而是直接拉最近一页** ——
 *    「已添加到任务」标记睡在消息行里，按游标追永远只拿新消息，旧消息上的标记
 *    就再也不会变（在另一台设备上把消息落成任务，这一台看不到）。一页 50 条成本很低。
 *
 * @returns {void}
 */
/**
 * 后台静默对账的最小间隔（毫秒）—— 与手机端 `teamworkPoll()` 的 `TEAMWORK_BG_POLL_MS` **同一个数、
 * 同一条理由**：人不在对话视图时，未读与红点至多每 30 秒对一次账（别为红点每 3 秒打一次接口）；
 * 前台（真的停在这一屏）照旧全速刷。
 * @type {number}
 */
const TEAMWORK_BG_POLL_MS = 30000;

/** 上一次后台静默对账的时刻（`Date.now()`），配 `TEAMWORK_BG_POLL_MS` 用 */
let teamworkBgAt = 0;

/**
 * 功能：补齐增量 —— 降级轮询的每一拍 / 在线对账的每一拍 / 重连成功时各一次；幂等。
 *
 * ⭐ 0.5.5（报的「来消息不实时、需要刷新」）：**本函数第一句以前是
 *    `if (state.view !== 'teamwork') return;`** —— 人在首页看板 / 任务板时，这条轮询的每一拍
 *    全是空转。而 SSE 在真机上假死是常见形态（网关把正文缓冲住 / 空闲长连接被掐），
 *    那时这条轮询就是消息能到的**唯一通路**；它一空转，看板上就永远什么都不会变，
 *    只能手动刷新。现在不在对话视图时改走**节流后的静默对账**（只拉会话列表、
 *    刷新未读与红点，不重画当前屏），与手机端 `teamworkPoll()` 逐字同一口径。
 *
 * @returns {void}
 */
function onTeamworkPoll() {
  if (state.view !== 'teamwork') {
    const now = Date.now();
    if (now - teamworkBgAt < TEAMWORK_BG_POLL_MS) return;
    teamworkBgAt = now;
    refreshConversations();
    return;
  }
  refreshConversations();
  const cid = Number(teamworkState.activeConvId);
  if (!cid) return;
  api('GET', `/api/teamwork/conversations/${cid}/messages?limit=${TEAMWORK_PAGE_SIZE}`)
    .then((r) => {
      const items = (Array.isArray(r.items) ? r.items : []).map(normMsg);
      applyMsgTasks(r.items);
      if (!items.length || teamworkState.activeConvId !== cid) return;
      const lastBefore = teamworkState.messages.length ? Number(teamworkState.messages[teamworkState.messages.length - 1].id) : 0;
      teamworkState.messages = mergeById(teamworkState.messages, items);
      renderTeamworkMessages(false);
      items.forEach(applyMessageToConversations);
      renderTeamworkSide();
      // ⚠️ 已读游标只在真的前进时才发：整页每拍都会回来，无条件发就是每拍一次无谓写库
      const lastAfter = Number(teamworkState.messages[teamworkState.messages.length - 1].id);
      // ⭐ 0.7.7：与上面 `onTeamworkMessageEvent()` 那条**同一个口径** —— 内置角色发来的消息也要算
      //    「有别人的新内容」⇒ 当场标已读。少了 `|| m.senderBuiltin`，提醒助手的未读会一直挂着
      //    （人在这一屏、红点却不消失 —— 一个谁也说不清为什么的小毛病）。
      if (lastAfter > lastBefore && items.some((m) => m.userId !== myUserId() || m.senderBuiltin)) {
        markConversationRead();
      }
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：懒建（并复用）实时通道 —— 句柄只建一次，`start()` / `stop()` 由进出这一屏决定。
 *
 * 说明：⚠️ **不要每次 `openTeamwork()` 都 `createTeamworkStream()`**：旧句柄若没被 stop，
 *      它的定时器与 `EventSource` 都还在，会一直占着服务端那 5 条连接的名额。
 *
 * @returns {Object} 通道句柄（`{ start, stop, status }`）
 */
function ensureTeamworkStream() {
  if (teamworkState.stream) return teamworkState.stream;
  teamworkState.stream = createTeamworkStream({
    onEvent: onTeamworkStreamEvent,
    onPoll: onTeamworkPoll,
  });
  return teamworkState.stream;
}

// ---------- 进出这一屏 ----------
/**
 * 功能：挂载对话页的**模块插槽**（0.6.0）—— tasks 的「协作项目登记器」从这里借位置进来。
 *
 * 说明：⭐ 容器是**左栏里的一个零高度盒子**（`data-slot="teamwork-page"` 是它的唯一标记），
 *      由本函数**动态创建并复用**；挂载逻辑全部在 `core/slots.js`（清单 ∩ 接线表里谁声明了这个槽、
 *      模块开着才画、失败不静默），本文件不认识任何具体模块。
 *      ⚠️⭐ 2h（丁 · 排版）起它**不再放在 `.home-head` 之后整块横跨**：那一块会把左栏与主区一起
 *      往下推（「上下太丑」的根因，方案 §丁-2）。现在它挂在左栏里、`height: 0`、不占位置 ——
 *      片段只当登记器（把协作项目登记进左栏第三组）＋ 弹层宿主，本身没有常驻可见内容。
 *      ⚠️ `state.modules` 还没到手（首屏之前是 null）时 `slotDefs()` 返回空数组 —— 槽为空即隐藏，
 *      不会报错；清单到手后下一次进对话页就会挂上。
 *
 * @returns {void}
 */
function mountTeamworkSlots() {
  const side = $('#teamwork-view .teamwork-side');
  if (!side) return;
  let box = side.querySelector(':scope > [data-slot="teamwork-page"]');
  if (!box) {
    box = document.createElement('div');
    box.dataset.slot = 'teamwork-page';
    box.className = 'teamwork-collab-registrar';
    side.appendChild(box);
  }
  mountSlots(box, 'teamwork-page', { end: 'desktop', modules: state.modules, uiOf, me: state.me }).then(() => {
    // ⭐ 插槽片段是在**事件注册之后**才挂上的（动态 import 有延迟）：片段要在会话区登记条目
    //    （`zx:teamwork-conv-entries`），而开屏那一次左栏重画可能已经跑完 —— 挂载完补画一次左栏，
    //    条目才稳定出现。补画是幂等的（整块重画），没有时序风险。
    if (state.view === 'teamwork') renderTeamworkSide();
  });
}

/**
 * 功能：进入「对话」视图 —— 取一次好友总览、画出左栏，然后接上实时通道。
 *
 * 说明：⭐ 只认「好友总览」一个接口：它顺带返回会话列表（含未读数），
 *      所以开屏只要一个请求（与首屏聚合的思路一致）。
 *      `#teamwork-side-body` 只在**还没有任何数据**时才铺骨架屏 —— 否则每次点进来都闪一下白。
 *
 * @returns {Promise.<void>}
 */
export async function openTeamwork() {
  state.view = 'teamwork';
  renderSidebar();
  showView('teamwork');
  mountTeamworkSlots();
  const side = $('#teamwork-side-body');
  if (side && !teamworkState.friends.length && !teamworkState.conversations.length) side.innerHTML = skeletonHtml(4);
  try {
    await loadTeamworkOverview();
  } catch (e) {
    toast(e.message, true);
    if (side) {
      side.innerHTML =
        '<div class="es-text">好友列表读取失败，请点左下角「↻ 刷新」重试；' + '若一直失败，可能是登录已过期。</div>';
    }
  }
  ensureTeamworkStream().start();
  renderTeamworkMessages();
  renderTeamworkHead();
}

/**
 * 功能：离开「对话」视图 —— 收起右键菜单、复位翻页标记。
 *
 * 说明：⭐ **0.5.2 起不再关掉实时通道** —— 通道改为应用级常驻（登录后由 `teamworkBoot()` 开一条，
 *      只有「设置里关掉对话模块」才 `teamworkShutdown()`）；`shell.js` 的 `showView()` 在
 *      「上一个视图是 teamwork、新视图不是」时调它，那是所有视图切换的唯一出口。
 *      数据刻意**不清**（好友与会话列表留着），下次点进来不用重新转圈。
 *
 * @returns {void}
 */
export function teamworkLeave() {
  // ⚠️ 右键菜单是挂在 `document.body` 上的**游离节点**：离开这一屏不收起的话，
  //    它会一直浮在别的屏上面（而且菜单里的动作指向的还是对话里的消息）。
  closeTeamworkMenu();
  teamworkState.loadingMore = false;
}

/**
 * 功能：⭐ 0.5.2 应用启动后的常驻通道引导 —— 模块清单确认「对话开着」时由
 *      `shell.js` 的 `applyPrefsVisibility()` 调一次（幂等）。
 *
 * 说明：与手机版同一条道理（见 `modules/teamwork/mobile.js` 的 `teamworkBoot()`）：
 *      通道常驻之后，停留在对话屏的实时性不再依赖「刚从别的屏切过来」的时机，
 *      断线重连、降级轮询都由 `modules/teamwork/teamwork-stream.js` 自己兜住。电脑版没有全局红点，
 *      后台对账（`onTeamworkPoll`）不在这一屏时一个请求都不发，常驻没有额外流量。
 *
 * @returns {void}
 */
export function teamworkBoot() {
  if (teamworkState.booted) return;
  teamworkState.booted = true;
  ensureTeamworkStream().start();
  // ⭐⭐ 0.8.17：**预热**「团队协作」那几个插槽片段（含 AI 助手那一片）。
  //    为什么必须预热：AI 助手**不是一条会话数据，而是一条插槽条目** —— 它的登记代码住在
  //    `modules/ai/` 的片段里，要等浏览器 `import()` 回来、片段跑完 `render()` 才登记；
  //    而对话模块**先画列表、后等登记**（`mountTeamworkSlots()` 不 await）⇒ 它永远是
  //    「第二拍才蹦出来」的那一行（用户点进来的头一瞬看不到它）。
  //    ⇒ 在进屏**之前**把片段 JS 拉进模块缓存：等用户点进来时 `import()` 变成微任务、
  //      快过那次 API 往返，首拍就有 AI 行。
  //    ⚠️⭐ **一律不 await**（等它就等于把并行又变回串行，进屏反而变慢）；
  //      失败由 `warmSlots()` 自己静默吞掉（模块被关 / 被整目录删掉，本来就不该有它）。
  //    ⚠️ 现有那条「挂载完再补画一次列表」**原样保留**（见 `mountTeamworkSlots()` 的 `.then`）——
  //      它是预热没赶上（点得太快）时的幂等兜底，最坏也只是回到今天的行为，不会更差。
  //    ⚠️ `state.modules` 还是 `null` 时它空转（首屏之前），这是设计如此，⛔ 别去 await 引导数据。
  warmSlots('desktop', 'teamwork-page', { modules: state.modules, uiOf, me: state.me });
}

/**
 * 功能：⭐ 0.5.2 停掉常驻通道 —— 只有一个调用方：`shell.js` 的 `applyPrefsVisibility()`
 *      在「设置里关掉了对话模块（或模块被整目录删掉）」时调。
 *      ⚠️ 切视图**不许**调它（那是 `teamworkLeave()` 的地盘，它已经不停通道了）。
 * @returns {void}
 */
export function teamworkShutdown() {
  if (teamworkState.stream) teamworkState.stream.stop();
  teamworkState.booted = false;
}

// ---------- 事件 ----------
/**
 * 功能：打开「对话设置」—— ⭐ **懒加载**真正的面板（`desktop-settings.js`）。
 *
 * 说明：⚠️ 用 `import()` 字面量而不是顶层 `import`：设置面板对绝大多数人一辈子只打开一次，
 *      放进静态依赖图里会让**每一次**打进对话页的首屏都多下一个文件
 *      （`modulepreload` 清单也必须跟着加一条，见 `frontend-modules.test.js` 那一关）。
 *      ⚠️ 加载失败要说出来：否则表现是「点了没反应」。
 *
 * @returns {Promise.<void>}
 */
async function openTeamworkSettingsPanel() {
  try {
    const m = await import('./desktop-settings.js');
    return await m.openTeamworkSettings();
  } catch (e) {
    return toast('打不开对话设置：' + e.message, true);
  }
}

/**
 * 功能：给「对话」这一屏挂**一次性**事件委托 —— 左栏的打开会话 / 会话区折叠 / 两颗入口按钮、
 *      右上角的备注与删好友、发送按钮、加好友按钮，以及两个输入框的回车。
 *
 * 说明：⚠️ 左栏每次刷新都是整块 `innerHTML` 重画，逐个绑按钮必然漏（漏的那处表现是
 *      「点了没反应」，本项目最忌讳的一类缺陷）。
 *      ⚠️ 顶栏那颗常驻连接状态徽标（`#teamwork-status`）已于 整颗移除——
 *      `#teamwork-friend-name` / `#teamwork-input` 是**静态骨架**（不进重画范围），所以可以直接绑 ——
 *      它们若进了重画范围，表现就是「只能打进去一个字」。
 *      ⭐ 0.4.4 起：折叠（`data-teamwork-fold`）、对话头的「✎ 备注」（`data-teamwork-remark`）、
 *      两处 `contextmenu`（右键消息 / 右键好友行）。
 *      ⚠️⭐ 0.7.6：好友 / 申请搬进弹窗之后，「右键好友行」与弹窗内那批动作（拉黑 / 删好友 /
 *      同意 / 拒绝…）都**收不到**这里给 `#teamwork-view` 挂的委托（弹窗挂在 `body` 下、不在屏内）
 *      ⇒ 多了**第二条委托**（`#modal-body` 的 click + contextmenu，见函数末尾）。
 *
 * @returns {void}
 */
export function bindTeamworkEvents() {
  const view = $('#teamwork-view');
  if (!view) return;

  view.addEventListener('click', (e) => {
    const t = e.target;
    // ⚠️ 顺序：**先判行内的按钮、再判整行/整块**（按钮都在行里面，先判外面会把点击吃掉）
    const fold = t.closest('[data-teamwork-fold]');
    if (fold) return void toggleTeamworkFold(fold.dataset.teamworkFold);
    // ⭐ 0.6.4（任务联动）：任务卡片里的动作按钮（「收进我的任务板」等）。
    //    ⚠️ 必须排在所有「整块 / 整行」判定**之前** —— 它长在消息卡片里面（与下面那枚
    //    「已添加到任务」标记同一条理由）。
    const cardAct = t.closest('[data-card-act]');
    if (cardAct) return void onTeamworkCardAct(cardAct);
    // ⭐ 0.4.4：气泡下面那枚「已添加到任务」标记 → 跳到那条任务（进任务板 + 弹出详情）。
    //    ⚠️ 必须排在别的判定**之前**：它在消息气泡里面，而气泡自己不带任何动作，
    //    但将来若给气泡加了动作，顺序反了这里就永远收不到点击（本项目的老坑）。
    const taskChip = t.closest('[data-teamwork-task-id]');
    if (taskChip) return void jumpToTask(taskChip.dataset.teamworkTaskScope, Number(taskChip.dataset.teamworkTaskId));
    const acc = t.closest('[data-teamwork-accept]');
    if (acc) return void acceptTeamworkFriend(Number(acc.dataset.teamworkAccept));
    const rej = t.closest('[data-teamwork-reject]');
    if (rej) return void confirmRejectFriend(Number(rej.dataset.teamworkReject));
    const blk = t.closest('[data-teamwork-block]');
    if (blk) return void confirmBlockFriend(Number(blk.dataset.teamworkBlock));
    const unb = t.closest('[data-teamwork-unblock]');
    if (unb) return void confirmUnblockFriend(Number(unb.dataset.teamworkUnblock));
    const rem = t.closest('[data-teamwork-remark]');
    if (rem) return void openRemarkModal(Number(rem.dataset.teamworkRemark));
    const del = t.closest('[data-teamwork-del]');
    if (del) return void confirmRemoveFriend(Number(del.dataset.teamworkDel));
    const open = t.closest('[data-teamwork-open]');
    if (open) return void openConversation(Number(open.dataset.teamworkOpen));
    // ⭐ 2h（丁 · 排版）：左栏第三组「协作项目」——
    //    · 「＋ 添加共享项目」那一行 ⇒ 派 `zx:teamwork-collab-add`（宿主不认识那个弹层，
    //      由 tasks 的 page 片段开它）；⚠️ 它不带 `data-teamwork-collab`，所以要先判它。
    //    · 每一条项目 ⇒ `openCollabBoard()`（主区让位给看板）。
    if (t.closest('[data-teamwork-collab-add]')) {
      document.dispatchEvent(new CustomEvent('zx:teamwork-collab-add'));
      return;
    }
    // ⭐⭐ 0.8.53（团队协作的项目中也要有 + 图标可以新建任务）：项目行右侧那颗 ＋
    //    要先于整行判 —— 它就在**行按钮内部**，冒泡到行上会被当成「点开项目」。
    //    动作是「打开这个项目的看板 + 立刻摆出新建任务弹层」（`openNew` 随挂载上下文传下去）。
    const newRow = t.closest('[data-teamwork-collab-new]');
    if (newRow) return void openCollabBoard(newRow.dataset.teamworkCollabNew, true);
    const collabRow = t.closest('[data-teamwork-collab]');
    if (collabRow) return void openCollabBoard(collabRow.dataset.teamworkCollab);
    // ⭐ 2h：协作看板头上的「← 返回」—— 关掉看板、主区还给真会话
    if (t.closest('[data-teamwork-board-back]')) return void closeCollabBoard();
    // ⭐ 插槽会话条目（0.6.x）：必须在 `data-teamwork-friend` 之前判 —— 它俩互斥，但顺手排在这里
    //    是为了与「先行内按钮、再整行」的顺序说明一致
    const slotRow = t.closest('[data-teamwork-slot]');
    if (slotRow) return void openSlotConv(slotRow.dataset.teamworkSlot);
    const fr = t.closest('[data-teamwork-friend]');
    if (fr) return void openTeamworkWithFriend(Number(fr.dataset.teamworkFriend));
    if (t.closest('#teamwork-add-btn')) return void addTeamworkFriend();
    if (t.closest('#teamwork-send')) return void sendTeamworkMessage();
    // ⭐ 0.8.54：输入框左边那颗 ＋ —— 三选一（图片 / 协作项目任务 / 普通任务）
    if (t.closest('#teamwork-plus')) return void openSendMenu();
    // ⭐ 0.6.x：对话自己的设置（提醒时刻等）—— 面板是**懒加载**的（`import()` 字面量，
    //    所以孤岛检查认它、而 `modulepreload` 清单里不该有它，见开发）。
    if (t.closest('#teamwork-settings-btn')) return void openTeamworkSettingsPanel();
    // ⭐ 0.7.6：左栏顶部那两颗入口按钮 —— 好友 / 申请的全部管理都搬进了弹窗
    if (t.closest('#teamwork-friends-btn')) return void openTeamworkFriendsModal();
    if (t.closest('#teamwork-req-btn')) return void openTeamworkRequestsModal();
  });

  const body = $('#teamwork-body');
  if (body) {
    body.addEventListener('scroll', onTeamworkScroll);
    // ⭐ 右键一条消息 → 添加到任务 / 复制文本（0.4.4）
    body.addEventListener('contextmenu', onTeamworkMessageMenu);
  }

  // ⭐ 0.8.54：发图片 —— 选中文件就上传（⛔ 不上传 `files[0]` 之外的东西，也不允许一次多选）
  const imgFile = $('#teamwork-img-file');
  if (imgFile) {
    imgFile.addEventListener('change', () => {
      const f = imgFile.files && imgFile.files[0];
      // ⚠️ 先清空 `value`：同一张图连发两次时，不清空就不会再触发 `change`
      imgFile.value = '';
      if (f) uploadImageAndSend(f);
    });
  }
  // ⭐ 0.8.54：点图片看大图（判定在 `shared.js`，怎么展示归本端 —— 电脑端画一层浮层）
  bindImageZoom(openTeamworkImageBox);
  // ⭐ 0.8.55：把「挑一条任务」借给 AI 会话（`zx:ai-pick-task` 留白事件）——
  //    AI 那边要能像好友聊天一样从 ＋ 里挑任务发给它，但选择器只该有一份。
  bindChatPickTask();

  // ⭐ 右键一位好友 → 改备注（0.4.4）。⚠️⭐ 0.7.6：好友行搬进了**弹窗** ⇒ 这条委托跟着从
  //    `#teamwork-side-body` 挪到 `#modal-body`（左栏现在只剩会话行，右键它们没有任何菜单）。
  //    ⚠️ `#modal-body` 是长期存在的节点（`openModal()` 只换它的 `innerHTML`），挂一次就够；
  //    委托里靠 `closest('[data-teamwork-friend]')` 认行 —— 别的模块的弹窗里没有这个属性，不会误命中。
  const modalBody = $('#modal-body');
  if (modalBody) {
    modalBody.addEventListener('contextmenu', onTeamworkSideMenu);
    // ⚠️⭐⭐ 弹窗挂在 `body` 下、**不在 `#teamwork-view` 里面** ⇒ 上面那条 click 委托收不到它里的点击，
    //    所以弹窗内的动作（拉黑 / 删好友 / 同意 / 拒绝 / 取消拉黑 / 开会话）必须单独挂一条。
    modalBody.addEventListener('click', onTeamworkModalClick);
    // ⭐ 0.8.54：任务选择弹窗里的搜索框 —— `input`（要边打边滤），只重画列表区
    modalBody.addEventListener('input', (e) => {
      const q = e.target && e.target.closest ? e.target.closest('[data-pick-q]') : null;
      if (!q) return;
      sendPick.q = String(q.value || '');
      paintSendPickList();
    });
  }

  const nameInp = $('#teamwork-friend-name');
  if (nameInp) {
    nameInp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addTeamworkFriend();
    });
  }

  const msgInp = $('#teamwork-input');
  if (msgInp) {
    msgInp.addEventListener('keydown', (e) => {
      // Enter 发送、Shift+Enter 换行（与主流 IM 一致 —— 做反了每发一条都要多按一次键）
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      sendTeamworkMessage();
    });
    // ⭐ 0.7.7：输入即自增高（拖拽手柄已由 CSS 的 `resize: none` 去掉 —— 要手动拖才变高
    //    的发送框，在聊天里等于没有）。封顶交给 CSS 的 `max-height`（超出就内部滚动，不顶破布局）。
    msgInp.addEventListener('input', () => autoGrow(msgInp));
  }
}

/**
 * 功能：让一个 textarea **跟着内容变高**（0.7.7，两端同一个写法）—— 先归零再按 `scrollHeight` 设回去。
 *
 * 说明：⚠️ `height='auto'` 这一步不能省：不先归零，`scrollHeight` 在内容变少时不会变小
 *      （它给的是「当前高度与内容高度的较大者」）⇒ 删掉几行之后输入框**不会缩回去**。
 *      ⚠️ 上限由 CSS 的 `max-height` 兜住（`max-height` 优先于 `height`）⇒ 这里不必知道封顶多少，
 *      两端也不用各写一个数（各写一个就会出现「电脑端 6 行、手机端 8 行」这种没人要的差异）。
 *
 * @param {HTMLTextAreaElement} el - 输入框（静态骨架里的那个，从头到尾都在）
 * @returns {void}
 */
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
