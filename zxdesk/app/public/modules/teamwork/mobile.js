/**
 * modules/teamwork/mobile.js —— 对话（手机版，0.3.5）
 *
 * 功能：手机版「对话」这一屏的全部渲染与交互 —— `renderTeamwork()` 按 `state.teamworkView` 画
 *      **列表页**（会话 / 好友 / 待处理申请）或**对话页**（消息流 + 底部固定输入框），
 *      `openTeamwork()` 打开一个会话并标记已读，`teamworkMore()` 是「向上翻历史」，
 *      `teamworkSend()` 发消息，`teamworkPoll()` 是断线补齐 / 降级轮询 / 在线对账共用的**幂等补齐入口**
 *      （⭐ 0.5.2 起也负责其它标签上的未读红点对账），`teamworkBoot()` / `startTeamworkStream()` /
 *      `stopTeamworkStream()` 管那条**应用级常驻**的 SSE 长连接，
 *      `teamworkAddFriend()` / `teamworkConfirm()` / `teamworkDelSheet()` / `teamworkBlock()` / `teamworkPeerSheet()`
 *      是加好友与同意 / 拒绝 / 删除 / 拉黑这几条关系的界面。
 *
 * ⭐ 与电脑版是**两套版式**（两端各一套 DOM，只共享 REST 契约与 `core/`）：
 *    电脑版是「左三区 + 右对话流」，手机版是**列表页 + 对话页两屏**（同一屏内切换），
 *    所以这里的函数与 `modules/teamwork/desktop.js` 同名不同实现，且都**不共用**。
 *
 * ⭐ 实时通道本身**一行都不在这里**：连接、自动重连、降级轮询、按 id 去重全在
 *    `modules/teamwork/teamwork-stream.js`（`createTeamworkStream()` / `mergeById()`）——
 *    「手机能收到、电脑收不到」这类问题必须不可能发生，所以它两端共用一份。
 *    本文件只做三件事：把事件翻译成「重画」，把**线路不正常**（重连中 / 已降级为轮询）
 *    翻译成一句提示（正常时一个字都不写，见 `teamworkStatusText()`），
 *    以及**在最该停掉的那一刻停掉它**。
 *
 * ⚠️ 三条硬约束（改这个文件前先读）：
 *   ① **消息正文一律 `esc()` 后拼进 HTML**（`body` / 别人改过的用户名与显示名都是别人可控内容）——
 *      这是本项目第一次出现「A 写的内容给 B 看」（方案 §八-1，头号风险）；
 *   ② ⭐ **0.5.2 起长连接是应用级常驻的**：`teamworkBoot()` 在模块清单确认对话开着时开一条，
 *      **只有**「设置里关掉对话模块」才 `stopTeamworkStream()`（登出 = 页面卸载，连接随之消失）。
 *      切标签 / 回列表页**不许**停它 —— 停了，未读红点与好友申请提示就再也不实时了
 *      （第二轮反馈第 1 条）。一台设备常驻一条，服务端每账号 5 条的
 *      名额（`modules/teamwork/stream.js` 的 `MAX_PER_USER`）毫无压力；
 *   ③ **每个渲染函数要写的 id 都必须在 `mobile/index.html` 里真实存在** ——
 *      手机版骨架是 HTML 与 JS 之间一份没有类型检查的契约，0.3.3 的硬件页就是因为漏写
 *      `#hw-count` 导致整屏「读取失败」（AGENTS §八）。本文件写到的骨架节点见 `renderTeamwork()` 的注释。
 *
 * ⭐ **0.4.4 / 0.7.6 / 0.7.7 的列表页交互**（与电脑版一条一条对齐）：
 *    ④ **列表页的两段可折叠**（0.7.7 起：内置助手 / 好友 —— 好友与申请在 0.7.6 已缩成两颗按钮）——
 *      直接复用设置页那套 `secHeadFold()` + `state.foldSecs` + `data-act="sec-toggle"`：
 *      ⭐ **只就地改 class、不整屏重画**，否则每收一块就被弹回页首；折起来之后**标题行照旧可见**。
 *      ⚠️ 分区 id 用 `teamwork-` 前缀（`teamwork-assist` / `teamwork-conv`）：
 *      它与设置页共用 `state.foldSecs` 这一个对象，撞名就是「收设置页那一块，对话也跟着收」。
 *    ⑤ **长按（或 Android 上的长按右键）一条消息 → 「添加到任务 / 复制文本」** —— 手机上没有右键，
 *      所以这里走 `bindTeamworkMessageHold()`（`mobile/app.js` 的 `bindEvents()` 调一次）：
 *      Android Chrome 长按会自己发 `contextmenu`、iOS Safari 不发，**两条路都必须接**
 *      （只接一条的后果是「一半手机用不了」，而且完全静默）。
 *    ⑥ **我起的备注优先于对方的显示名**（`teamworkRowName()`，0.4.4 服务端加 `teamwork_friendships.remark`）——
 *      ⚠️ 备注只写我这一行，**对方看不到**；入口在对话页的「⋯」菜单里（手机上那是关系菜单的家），
 *      电脑版的入口是右键好友行 + 对话标题旁的「✎ 备注」。
 *    ⑦ ⭐ 2h（丁 · 排版）：列表页第三组「协作项目」（与「内置助手」「好友」同款：`teamworkSec()` ＋ `secHeadFold()`）。
 *      条目走 `zx:teamwork-collab-entries` 留白事件登记（本模块**不认识 `tasks` 这个东西** ——
 *      删掉那个模块目录 ⇒ 这一组空着、其它一切照旧）；组内第一行恒为「＋ 添加共享项目」，
 *      点它派 `zx:teamwork-collab-add` 让片段去开它的弹层。点一条协作项目 ⇒ **进第二屏**
 *      （`renderCollabBoard()`，照 `renderTeamworkThread()` 那套屏内二级屏，⛔ 不是内嵌在列表里），
 *      第二屏内容区挂 **`teamwork-board`** 槽（⛔ 不复用 `teamwork-thread` —— 那是会话线程）。
 *
 * ⚠️ 本文件**不 import 入口**（`mobile/app.js`）：`stopTeamworkStream()` 与 `renderTeamworkList()` / `renderTeamworkThread()`
 *    都自己重画，不借 `render()` 整屏重画 —— 那会把正在输入的输入框连焦点一起重建
 *    （消息列表里滚动位置也会被打回顶部）。
 *    ⭐ 0.4.4 例外：为了「消息转任务之后把任务列表刷新一遍」而 import 了 `mobile/data.js` 的 `refresh()`
 *    （`board.js` / `projects.js` / `tasks.js` / `more.js` 都是这么做的）。⚠️ `data.js` 反过来
 *    import 了入口 `app.js`，所以这里确实存在一个循环 —— 安全的前提是**两边都只在函数体里用对方**，
 *    顶层一行都不调（`app.js` 的 `init()` 在最后一行，那时本文件已经求值完了）。
 *    ⚠️ 别把这条当成「可以随便 import 入口」：`render()` / `switchTab()` 一旦在顶层或渲染途中被调，
 *    就会把这一屏连同输入框、滚动位置一起重建。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.61
 * 相关：docs/公共/架构文档/17-对话.md、docs/公共/开发方案/06-对话-1期.md
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/mobile/views/teamwork.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）—— 除文件头路径、相对 import
 *    与这段说明外一个字没动。
 */

// ⭐ 0.8.54：图片上传走裸 `fetch`（`api()` 只发 JSON）⇒ 挂载前缀 `BASE` 与 401 跳登录要自己接。
import { BASE, api, backToLogin } from '../../core/api.js';
// ⭐ 0.7.1：新建任务统一走共用层那个入口 —— ⚠️ 它在 `core/` 而不是任务模块里，
//    因为 不许跨模块 import 实现（这条路径以前自己拼了一份 POST）
import { createTask } from '../../core/task-create.js';
// ⭐ 0.5.2 第二轮：消息转任务的弹层也能绑网址（与电脑版、任务表单共用 core 一份实现）
import { fillBookmarkSelect } from '../../core/bookmarks.js';
import { createTeamworkStream, mergeById } from './teamwork-stream.js';
import { addDays, todayStr } from '../../core/date.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { refresh } from '../../mobile/data.js';
// ⭐ 0.6.0：对话页是 AI 插槽的**宿主**—— 本文件只认识通用的 slots 宿主与本端接线表，
//    **不 import 任何具体模块的片段**（删掉那个模块目录后对话页必须照常能用）。
import { uiOf } from '../../mobile/modules.js';
import { mountSlots, warmSlots } from '../../core/slots.js';
import { state } from '../../mobile/state.js';
// ⭐ 0.8.54：`isSheetOpen()` —— 取数回来要确认弹层还开着（用户可能已经点了 ✕），
//    否则那句话会写进「已经关掉的弹层」，下次打开时先闪一下旧内容。
import {
  askConfirm,
  closeSheet,
  emptyHtml,
  isSheetOpen,
  openSheet,
  paintTeamworkUnread,
  paintChrome,
  secHeadFold,
  toast,
} from '../../mobile/ui.js';
// ⭐ 0.6.4（任务联动）：任务卡片的渲染与动作 —— 与电脑版**共用一份**。
//    ⚠️ 这是上面那句「两端不共用」的**一处刻意例外**：卡片里那几个字段名与「哪些文本必须转义」
//    是两端必须逐字一致的契约，各写一份的结果是「电脑端画出来了、手机端少一行」（见 shared.js）。
// ⭐ 0.6.4（任务联动）：任务卡片的渲染与动作 —— 与电脑版**共用一份**（见 `shared.js` 的说明）
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

/**
 * 功能：对话的 `data-act` 指令表 —— 由 `mobile/app.js` 的 `onAction()` 转过来。
 *
 * 说明：⭐ 照 `handleTtEditAct()` 的做法单独放一份，而不是逐个分支摊在入口的全局指令表里：
 *      对话的动作有十几个（打开 / 返回 / 发送 / 加好友 / 同意 / 拒绝 / 删除 / 拉黑 / 翻历史），
 *      而它们几乎只依赖本模块自己的状态。
 *      ⚠️ 未列出的动作静默忽略（与入口的 `default` 分支一致）。
 *
 * @param {string} act - 动作名，来自节点的 `data-act`
 * @param {HTMLElement} n - 触发动作的节点（从它的 `dataset` 取 id）
 * @returns {void}
 */
export function handleTeamworkAct(act, n) {
  const id = () => Number(n.dataset.id);
  switch (act) {
    case 'teamwork-open':
      // ⭐ 0.7.6：好友弹层里点名字也要能开会话 —— 先把弹层收掉，否则它会一直盖在对话页上。
      //    ⚠️ 从列表页点会话行走的也是这一支（那时没有弹层），`closeSheet()` 是幂等的。
      closeSheet();
      openTeamwork(n.dataset.id);
      break;
    // ⭐ 0.7.6：好友弹层里的「拉黑」—— 与对话页 ⋯ 菜单那条 `teamwork-block` **分开**：
    //    那个的语义取决于 `state.teamworkBuddy.blocked`（同一颗按钮要兼顾「拉黑 / 取消拉黑」），
    //    而弹层里的这一颗**永远是拉黑** ⇒ 写死语义，免得读到别处残留的 `state.teamworkBuddy` 拨反。
    case 'teamwork-block-go':
      teamworkBlock(id(), true);
      break;
    // ⭐ 0.7.6：列表页顶部那两颗入口按钮 —— 好友 / 申请的管理都搬进了底部弹层
    case 'teamwork-friends-open':
      teamworkFriendsSheet();
      break;
    case 'teamwork-req-open':
      teamworkRequestsSheet();
      break;
    // ⭐ 0.6.x：内置角色会话（提醒助手）按**会话 id** 打开 —— 它不是好友，
    //    `teamwork-open` 那条路（入参是 friendId）对它必然被服务端拒掉（见 `openTeamworkConv()`）。
    case 'teamwork-open-conv':
      openTeamworkConv(n.dataset.id);
      break;
    // ⭐ 0.6.x：插槽会话条目（AI 助手这类「会话对象」）—— 按**条目键**打开，
    //    内容由该模块的 `teamwork-thread` 插槽片段画（`openSlotConv()`）。
    case 'teamwork-slot-open':
      openSlotConv(n.dataset.key);
      break;
    case 'teamwork-back':
      closeTeamwork();
      break;
    case 'teamwork-more':
      teamworkMore();
      break;
    case 'teamwork-send':
      teamworkSend();
      break;
    // ⭐ 0.8.54（「和好友的聊天框左侧加个圆圈加号图标」）：那颗 ＋ 与它的三项。
    //    ⚠️ 三项各走一个动作名（而不是在弹层里判 `data-kind`）：宿主那张动作表按名字查，
    //    一个动作一个 `case` 与全仓既有写法一致，也不会有「多传一个 dataset」的隐式约定。
    case 'teamwork-plus':
      teamworkSendMenu();
      break;
    case 'teamwork-send-collab':
      teamworkSendPickSheet('collab');
      break;
    case 'teamwork-send-daily':
      teamworkSendPickSheet('daily');
      break;
    // ⭐ 0.6.x：对话自己的设置（提醒时刻等）—— 面板是**懒加载**的（面板本身一辈子只开一两次，
    //    不值得进首屏的静态依赖图；`import()` 字面量让孤岛检查认它，见开发）。
    case 'teamwork-settings':
      openTeamworkSettingsPanel();
      break;
    // ⭐ 0.6.x：设置面板里的「发一条测试提醒」—— 真机验收就靠这一下
    case 'teamwork-reminder-test':
      sendTestReminder();
      break;
    case 'teamwork-add-friend':
      teamworkAddFriend();
      break;
    case 'teamwork-accept':
      teamworkConfirm('teamwork-accept', id());
      break;
    case 'teamwork-reject':
      teamworkConfirm('teamwork-reject', id());
      break;
    case 'teamwork-del':
      teamworkDelSheet(id());
      break;
    case 'teamwork-del-go':
      teamworkDelGo(id());
      break;
    case 'teamwork-block':
      // 行上的「拉黑 / 取消拉黑」共用一个按钮：当前状态决定这一下是哪一个
      teamworkBlock(id(), !(state.teamworkBuddy && state.teamworkBuddy.blocked));
      break;
    case 'teamwork-unblock':
      teamworkBlock(id(), false);
      break;
    case 'teamwork-peer-manage':
      teamworkPeerSheet();
      break;
    // ⭐ 0.4.4：长按一条消息之后的两个动作（菜单本身由 `teamworkMsgMenu()` 直接画，不走指令表）
    case 'teamwork-msg-task':
      teamworkTaskSheet(findMessage(id()));
      break;
    case 'teamwork-msg-copy':
      teamworkMsgCopy(id());
      break;
    // ⭐ 0.4.4：改备注（入口在对话页的「⋯」菜单里）
    case 'teamwork-remark':
      teamworkRemarkSheet(id());
      break;
    case 'teamwork-remark-save':
      teamworkRemarkSave(id());
      break;
    case 'teamwork-retry':
      // 对话页取数失败时的重试：**重开同一个会话**，而不是 `refresh()` 整页 ——
      // 整页刷新拿不到「刚才想打开的是哪个人」，用户会莫名其妙被留在列表页。
      // ⭐ 0.6.x：内置角色会话没有 friendId，走它自己的那条锚点（两者互斥）。
      if (teamworkTryConv) openTeamworkConv(teamworkTryConv);
      else if (state.teamworkTryFriend) openTeamwork(state.teamworkTryFriend);
      else loadTeamwork();
      break;
    default:
      break;
  }
}

/**
 * 隐私提示原文（方案 §八-6 **要求必须显示在界面上**，不是可选的脚注）。
 *
 * ⭐ 写成模块级常量只为一件事：列表页与对话页显示的是**同一句话**。
 *    两边各抄一份的话，改了其中一处就会出现「列表页说加密、对话页说没加密」这种自相矛盾。
 *    ⚠️ 它是**朴素文本**（不带表情、不带 HTML）：渲染处一律 `textContent`，不给 XSS 留缝。
 *
 * @type {string}
 */
const TEAMWORK_PRIVACY = '消息以明文存在你自己的 NAS 上；登录与 HTTPS 保护的是访问通道，不是消息内容。';

/**
 * 打开一个会话时先取多少条历史。
 *
 * 说明：服务端默认也是 50，这里显式写出来只是为了「翻页判据」在两端各写一遍时不会各写一个数。
 *
 * @type {number}
 */
const TEAMWORK_PAGE = 50;

/**
 * 「消息转任务」时标题的截断长度 —— 必须与 `validate.js` 的 `MAX_NAME`（100）一致：
 * 超长时服务端**报 400 不静默截断**，所以在弹层里就截好，别让用户填完才吃一个错误。
 *
 * @type {number}
 */
const TEAMWORK_TASK_TITLE_MAX = 100;

/**
 * 向上翻历史时 `#teamwork-history` 距顶部多少像素之内就触发加载。
 *
 * ⚠️ 它必须 export：滚动的委托挂在入口（`mobile/app.js` 的 `bindEvents()`），
 * 判据却属于这一屏 —— 两处各写一个数就会出现「滑到顶了却迟迟不加载」这种没人查得出的漂移。
 *
 * @type {number}
 */
export const TEAMWORK_EDGE_PX = 40;

/**
 * 当前那条 SSE 通道的句柄（同一个时刻**最多一条**）。
 *
 * ⚠️ 它必须是模块级单例、而且在 `stopTeamworkStream()` 里清空：服务端每个账号只允许 5 条长连接
 * （`modules/teamwork/stream.js` 的 `MAX_PER_USER`）。⭐ 0.5.2 起它是**常驻**的（登录即开，
 * 不随进出对话页开关），一台设备任何时刻只有这一条，名额毫无压力。
 *
 * @type {?{start: Function, stop: Function, status: Function}}
 */
let teamworkStream = null;

/**
 * ⭐ 0.5.2 `teamworkBoot()` 是否已经跑过（幂等闸门）。`stopTeamworkStream()` 里复位：
 * 模块被关掉再重新打开时，引导要能重新走一遍。
 * @type {boolean}
 */
let teamworkBooted = false;

/**
 * ⭐ 0.5.2 下一次渲染对话流是否**无条件贴底**。刚打开会话 / 自己发消息时置真
 * （见 `renderTeamworkThread()`：平时只在本来就贴着底部时才跟随，往上翻历史时不拽人）。
 * @type {boolean}
 */
let teamworkStick = false;

/**
 * ⭐ 0.6.x 内置角色会话（提醒助手）的取数失败重试锚点 —— 与 `state.teamworkTryFriend` 同一用途。
 *
 * 说明：⚠️ 内置角色**没有 `friendId`**（它不是好友），所以「取数失败 → 重新加载」没法用它
 *      那套锚点；这里单独记一个**会话 id**。两条锚点互斥，`openTeamwork()` / `openTeamworkConv()`
 *      各自会把另一条清掉 —— 否则会出现「点重试打开的是上一次那个人」。
 * @type {?number}
 */
let teamworkTryConv = null;

/**
 * 连接状态 → **告警文案**（`''` = 一切正常，什么都不用说）。
 *
 * ⭐ 方案 §七 要的是「降级时界面必须说出来」：长连接断了而界面不响，用户会以为
 *    「对方没回」，其实是消息根本没推过来 —— 这正是「静默降级」最坏的一种。
 *    ⚠️ 但**「在线」这两个字不许再出现在对话页上**（报的
 *    「一直显示对方在线」）：它说的是「我这台设备和服务器连上了」，摆在对方名字旁边
 *    就会被读成「对方在线」，而本应用压根没有「对方在线」这个能力（服务端没有任何
 *    presence 数据）。所以这里对 `'online'` 返回空串，让那一行整个消失。
 *
 * @param {string} s - `'online'` / `'connecting'` / `'polling'` / 其它（`'off'`）
 * @returns {string} 需要告诉用户的话；一切正常时是空串
 */
export function teamworkStatusText(s) {
  if (s === 'connecting') return '正在重连…消息可能要等一下才到';
  if (s === 'polling') return '实时连接不可用，已改为自动刷新（消息会自动补上）';
  return '';
}

/**
 * 功能：把消息 / 会话时间戳缩成中文短标签（今天只写时刻，昨天加「昨天」，更早写月日）。
 *
 * 说明：时间戳是服务端的 `YYYY-MM-DD HH:MM:SS`（`nowStamp()`），也兼容 ISO 的 `T` 分隔 ——
 *      ⚠️ **字符串比较用字典序、不用 `Date`**（转 `Date` 会踩时区坑，见 AGENTS §八）。
 *
 * @param {?string} stamp - 服务端时间戳
 * @returns {string} 短标签；没有时间戳时返回空串
 */
export function teamworkTime(stamp) {
  const s = String(stamp == null ? '' : stamp).trim();
  if (!s) return '';
  const d = s.slice(0, 10);
  // 服务端的 `nowStamp()` 是 'YYYY-MM-DD HH:MM:SS'，也兼容 ISO 的 'T' 分隔
  const t = s.slice(11, 16);
  const today = todayStr();
  if (d === today) return t;
  if (d === addDays(today, -1)) return '昨天 ' + t;
  const p = d.split('-');
  return p.length === 3 ? `${Number(p[1])}月${Number(p[2])}日 ${t}` : d;
}

/**
 * 功能：取一条消息的**时间戳** —— ⚠️ 两个字段名都要认：REST 回来的行带的是库里的列名
 *      `created_at`（`teamwork_messages` 的 DDL 就是它），SSE 事件体与本机自己发的那条用 `createdAt`。
 *
 * 说明：⭐ 这与 `teamworkMsgHtml()` 里 sender 那两个名字（`senderId` / `user_id`）是**同一个坑**，
 *      而这一处以前只认 `createdAt` ⇒ REST 拉回来的历史消息时间**整列空着**，且不报任何错
 *      （「手机端消息没有显示时间（电脑端有）」）。
 *      电脑版没有这个问题，是因为它有 `normMsg()` 把两种形状归一成 `createdAt`；
 *      手机版没有归一那一步，所以必须在这里两个都认。
 *      ⚠️ 收进一个函数而不是在两处各写一遍三元：落点有三处（气泡、转任务的引用、以后的），
 *      抄漏一处就是「有的地方有时间、有的地方没有」。
 *
 * @param {Object} m - 消息行（`{ createdAt }` 或 `{ created_at }`）
 * @returns {string} 时间戳字符串；两个字段都没有时是空串（`teamworkTime('')` 同样返回空串）
 */
function msgStamp(m) {
  const o = m || {};
  if (o.createdAt !== undefined && o.createdAt !== null) return o.createdAt;
  return o.created_at === undefined || o.created_at === null ? '' : o.created_at;
}

/**
 * 功能：取一个账号适合显示的称呼 —— 优先显示名，其次登录名。
 * @param {?Object} u - 账号对象（服务端只给 `id` / `username` / `display_name` / `last_login_at`）
 * @returns {string} 显示名或登录名；都没有时返回 '?'（不返回 'null' 这种字面量）
 */
function teamworkName(u) {
  const v = u || {};
  return v.display_name || v.username || '?';
}

/**
 * 功能：取一段关系（好友行 / 会话行 / 当前会话）该显示的名字 —— ⭐ 0.4.4 起**我起的备注优先**，
 *      没有备注才回落到对方的显示名 / 登录名。
 *
 * 说明：⚠️ 三种行的字段名不一样，必须一次收齐，否则总有一处会「忘了备注」：
 *      · 好友行 —— `remark` + `user`；· 会话行 —— `peer_remark` + `peer_user`。
 *      ⚠️ 备注是**我单方面**的（服务端只写我这一行），所以它只影响我看到的界面。
 *
 * @param {Object} row - 好友行 / 会话行 / `state.teamworkBuddy`
 * @returns {string} 可显示的名字
 */
function teamworkRowName(row) {
  const o = row || {};
  // ⭐ 0.6.x：内置角色会话（提醒助手）**最先判** —— 它既没有 `peer_user`、也没有 `peer_gone`，
  //    落到下面任何一支都会得到一个含义不明的名字（『?』）。
  //    名字由**服务端**随会话行给出（`builtin_name`），前端不另写一份（见 `modules/teamwork/store.js`）。
  if (o.builtin_key) return String(o.builtin_name || '助手');
  // ⚠️ 「对方账号已注销」要单独判：那时 `peer_user` 是 null，落到下面的 `teamworkName(null)` 会显示成一个
  //    含义不明的「?」。服务端**刻意**把这类会话留在列表里（见 `teamworkListConversations()` 的说明：
  //    「历史缺一段」不能变成「会话凭空消失」），所以界面必须说清「人没了、会话还在」。
  if (o.peer_gone) return '（对方账号已注销）';
  const remark = o.remark || o.peer_remark;
  if (remark) return String(remark);
  return teamworkName(o.user || o.peer_user);
}

/**
 * 功能：按 id 从当前会话的消息列表里找一条消息（找不到返回 null）。
 *
 * 说明：⭐ 菜单里的动作都只带 id，**正文一律回内存里取、不从 DOM 上读** ——
 *      `data-*` 里不放用户内容（那是把用户输入摆到 HTML 解析器面前），
 *      而且气泡里的正文可能已经是被同 id 的新版本覆盖过的了。
 *
 * @param {number} id - 消息 id
 * @returns {?Object} 消息行
 */
function findMessage(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return (state.teamworkMessages || []).find((m) => Number(m.id) === n) || null;
}

/**
 * 功能：把服务端给的消息标记收进 `state.teamworkMsgTasks`（0.4.4）—— 只写不改，按消息 id 归位。
 *
 * 说明：⭐ 与电脑版同一个理由：标记**刻意不挂在消息对象上**。同一条消息会从 REST 与 SSE
 *      两条路到达，而 `mergeById()` 是「后到的整个对象覆盖先到的」，SSE 那条不带标记 ⇒
 *      挂上去会被抹掉，表现是「标记时有时无」。所以它单独存一份，只由 REST 取数写。
 *      ⚠️ 只在服务端真的带了 `tasks` 数组时才写（别拿「没带」当成「没有标记」）。
 *
 * @param {Array.<Object>} items - 服务端返回的消息行（可能带 `tasks`）
 * @returns {void}
 */
function applyMsgTasks(items) {
  const map = state.teamworkMsgTasks || (state.teamworkMsgTasks = {});
  for (const m of Array.isArray(items) ? items : []) {
    if (m && Array.isArray(m.tasks)) map[Number(m.id)] = m.tasks;
  }
}

/**
 * 功能：把一次失败的取数收成界面上的错误态 —— 记住原因、重画当前那一屏。
 * @param {Error} e - 抛出的错误
 * @returns {void}
 */
function teamworkFail(e) {
  state.teamworkError = e.message;
  renderTeamwork();
}

/**
 * 功能：生成「读取失败」块 —— 与 `ui.js` 的 `errHtml()` 同一套版式，但**重试走对话自己的动作**。
 *
 * 说明：⚠️ 不能用 `errHtml()` 的 `data-act="refresh"`：那个动作是**整页**刷新，
 * 在对话页上它拉不回「刚才要打开的是哪个人」，用户会莫名其妙被留在列表页。
 *
 * @param {string} msg - 错误文案（会被转义）
 * @returns {string} 错误块的 HTML 字符串
 */
function teamworkErrHtml(msg) {
  return `<div class="err-box"><b>读取失败</b><p>${esc(msg)}</p>
    <button class="chip on" type="button" data-act="teamwork-retry" style="margin-top:14px">重新加载</button></div>`;
}

// ---------- 取数（全部幂等，可以随便重复调） ----------

/**
 * 功能：打开「对话设置」—— ⭐ **懒加载**真正的面板（`mobile-settings.js`）。
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
    const m = await import('./mobile-settings.js');
    return await m.openTeamworkSettings();
  } catch (e) {
    return toast('打不开对话设置：' + e.message, true);
  }
}

/**
 * 功能：立刻发一条**测试提醒**（设置面板里那一颗按钮）—— 让用户当场确认「提醒落在哪儿、长什么样」。
 *
 * 说明：⚠️ 失败必须弹出来（`toast(..., true)`）：它是一个用户主动发起的动作，
 *      静默失败会让人以为「提醒功能坏了」。
 *
 * @returns {Promise.<void>}
 */
async function sendTestReminder() {
  // ⚠️ 防连点：它是**四连写**（0.7.7 起一次发四种），连点两下就是八条消息糊一通。
  //    与电脑版 `desktop-settings.js` 的同名函数同一条规矩（两端行为要一致）。
  const btn = document.querySelector('[data-act="teamwork-reminder-test"]');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await api('POST', '/api/teamwork/reminder-test');
    // ⚠️ 不点名「提醒助手」：名字可以自己改（0.6.x），写死的话「小爪」的机器上会看到一句
    //    指向另一个名字的提示。两端这一句**逐字一致**。
    toast('已发出 —— 去对话里看看');
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * 功能：重拉好友总览（好友 / 待处理申请 / 我发出的 / 已拉黑 / 会话列表 / 未读合计）并重画。
 *
 * 说明：⭐ 一个请求就把列表页与对话页要画的东西取齐（服务端顺带给出了 `conversations`）——
 *      收到 `friend` 事件后重拉它是最省事也最不容易漂的做法：**「哪些账号字段能跨账号传」
 *      这个问题只有服务端一个答案**，前端不去猜。
 *
 * @returns {Promise.<void>}
 */
export async function loadTeamwork(opts) {
  // ⭐ 0.5.2：`opts.quiet` = 「只要数据，不要重画」—— 后台刷红点时用（见 `teamworkPoll()`）。
  const quiet = !!(opts && opts.quiet);
  try {
    const r = await api('GET', '/api/teamwork/friends');
    state.teamworkFriends = Array.isArray(r.friends) ? r.friends : [];
    state.teamworkIncoming = Array.isArray(r.incoming) ? r.incoming : [];
    state.teamworkOutgoing = Array.isArray(r.outgoing) ? r.outgoing : [];
    state.teamworkBlocked = Array.isArray(r.blocked) ? r.blocked : [];
    state.teamworkConversations = Array.isArray(r.conversations) ? r.conversations : [];
    state.teamworkUnreadTotal = Number(r.unreadTotal) || 0;
    state.teamworkError = null;
    state.teamworkLoaded = true;
  } catch (e) {
    state.teamworkError = e.message;
    // ⚠️ 失败也要算「已经拉过一次」：否则列表页会一直停在空态文案上，
    //    而错误块才是唯一能让用户看见「是读取失败、可以点重试」的东西。
    state.teamworkLoaded = true;
  }
  if (!quiet) renderTeamwork();
  updateTeamworkUnread();
}

/**
 * 功能：进入「对话」标签 —— 第一次进来拉好友总览，并开一条实时通道。
 *
 * 说明：⭐ 由 `mobile/app.js` 的 `switchTab()` 调用一次，是这一屏**唯一的入口**：
 *      拉数据与建长连接的顺序、以及「重复进来不要建第二条」（`startTeamworkStream()` 里那句
 *      `if (teamworkStream) return`）都收在这里，入口那边只写一行。
 *
 * @returns {void}
 */
export function teamworkEnter() {
  if (!state.teamworkLoaded) loadTeamwork();
  startTeamworkStream();
}

/**
 * 功能：把未读合计写到「对话」自己的底部标签上那个小红点（0 时收起）。
 *
 * 说明：⭐ 0.5.2 起对话有**自己的底部标签**（顶替被删掉的「项目」那颗），红点跟着搬了过来 ——
 *      在任何标签上（不只「更多」）来消息它都会亮。⚠️ 标签按钮是 `renderModuleTabs()`
 *      按清单**动态生成**的，红点这个小 `<span>` 由本函数**就地创建**（幂等）：按钮不在
 *      （模块被关 / 清单还没到手）就静默返回，节点被重建后下一次调用会补画
 *      （`renderModuleTabs()` 重建按钮后也会调一次本函数）。
 *      ⚠️ 红点上**只显示数字，不显示内容** —— 未读数是社交信息里最小的一种。
 *
 * @returns {void}
 */
export function updateTeamworkUnread() {
  const n = Number(state.teamworkUnreadTotal) || 0;
  // ⭐ 0.5.5：这一个数是「未读」在手机端的**唯一出口** —— 除了自己那颗标签红点，
  //    「今天」那一屏的未读卡也靠它跟着变（那张卡读的是 `/api/dashboard` 的**快照**，
  //    不会自己更新，这正是「要刷新才出现」）。
  //    ⚠️ 必须放在下面那个早退**之前**：标签按钮不在（模块被关 / 清单还没到手）时，
  //    看板那张卡照样得跟着走。
  paintTeamworkUnread(n);
  const btn = document.getElementById('tab-teamwork');
  if (!btn) return;
  let badge = document.getElementById('tab-teamwork-dot');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'tab-teamwork-dot';
    badge.className = 'tab-dot hidden';
    btn.appendChild(badge);
  }
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('hidden', n <= 0);
}

/**
 * 功能：拉当前会话的**增量**消息并重画 —— 幂等（同一段拉几次都只显示一次）。
 *
 * 说明：游标 = 本地已有的**最大消息 id**，`after` 只取比它新的。
 *      服务端按 id 升序返回，再交给 `mergeById()` 去重合并 ——
 *      「重连补齐」与「SSE 实时推送」**必然会重叠**，靠 id 去重之后重叠不产生重复气泡。
 *      ⚠️ 会话没打开（`state.teamworkLoaded` 为假）时**一个请求都不发**。
 *
 * @returns {Promise.<void>}
 */
export async function teamworkRefreshMessages() {
  if (!state.teamworkLoaded || !state.teamworkId) return;
  try {
    // ⭐ 0.5.2 两处改动（「没有实时刷新」整改的一部分）：
    // ① **不再按 `after` 游标追增量，而是直接拉最近一页**：「已添加到任务」标记睡在消息行里，
    //    按 after 追永远只拿新消息，旧消息上的标记就再也不会变（在另一台设备上把消息落成任务，
    //    这一台永远看不到）。一页 50 条成本很低，`mergeById()` 按 id 去重，重复拉没有副作用。
    // ② 旧写法在本地还没有任何消息时会发出 `after=0`，服务端按契约回 400
    //    （游标必须是正整数）—— 表现是**全新会话一打开就「读取失败」**，电脑版早有
    //    「没有游标就退化成拉最近一页」的处理，手机版漏了。改成一律拉最近一页后此坑不复存在。
    const r = await api('GET', `/api/teamwork/conversations/${state.teamworkId}/messages?limit=${TEAMWORK_PAGE}`);
    const add = Array.isArray(r.items) ? r.items : [];
    applyMsgTasks(r.items);
    if (add.length) {
      const before = state.teamworkMessages || [];
      const lastBefore = before.length ? Number(before[before.length - 1].id) : 0;
      const merged = mergeById(before, add);
      state.teamworkMessages = merged;
      // ⚠️ 已读游标只在真的前进时才发：一页 50 条每拍都会回来，无条件发就是每拍一次无谓写库
      const lastAfter = Number(merged[merged.length - 1].id);
      if (lastAfter > lastBefore) markTeamworkRead();
    }
    state.teamworkError = null;
  } catch (e) {
    state.teamworkError = e.message;
  }
  renderTeamwork();
}

/**
 * 功能：把「我读到哪儿了」告诉服务端（打开会话、以及收到新消息时各一次）。
 *
 * 说明：⚠️ 这是**尽力而为**的：失败只记进 `state.teamworkError`，不弹 toast ——
 *      未读游标没推进只影响红点，不该为它在发消息时插一句报错。
 *      ⚠️ 游标取本地最大消息 id（服务端还会夹到「这个会话现有的最大 id」，
 *      直接收下别人的大数字会让这个会话将来所有消息都被当成已读）。
 *
 * @returns {void}
 */
function markTeamworkRead() {
  if (!state.teamworkId) return;
  const list = state.teamworkMessages || [];
  if (!list.length) return;
  const lastReadId = Number(list[list.length - 1].id);
  api('POST', `/api/teamwork/conversations/${state.teamworkId}/read`, { lastReadId })
    .then(() => {
      state.teamworkUnreadTotal = 0;
      updateTeamworkUnread();
      const c = state.teamworkConversations.find((x) => Number(x.id) === Number(state.teamworkId));
      if (c) c.unread = 0;
    })
    .catch((e) => {
      state.teamworkError = e.message;
    });
}

/**
 * 功能：向上翻历史（`before=<本地最小消息 id>`）并**保持视口不动**（把新增的高度补进滚动位置）。
 *
 * 说明：⚠️ 不补滚动位置的表现是「一往上滑就跳回最新那条」—— 用户会以为历史加载坏了。
 *      服务端返回的 `hasMore` 决定还能不能继续翻（`after` 模式它恒为假）。
 *
 * @returns {Promise.<void>}
 */
export async function teamworkMore() {
  if (!state.teamworkId || state.teamworkMoreBusy || !state.teamworkHasMore) return;
  const list = state.teamworkMessages || [];
  if (!list.length) return;
  state.teamworkMoreBusy = true;
  const before = Number(list[0].id);
  try {
    const r = await api('GET', `/api/teamwork/conversations/${state.teamworkId}/messages?before=${before}&limit=${TEAMWORK_PAGE}`);
    const older = Array.isArray(r.items) ? r.items : [];
    state.teamworkHasMore = !!r.hasMore;
    applyMsgTasks(r.items);
    if (older.length) {
      const box = $('#teamwork-history');
      const h0 = box ? box.scrollHeight : 0;
      state.teamworkMessages = mergeById(older, state.teamworkMessages);
      renderTeamworkThread();
      if (box) box.scrollTop = box.scrollHeight - h0;
    }
    state.teamworkError = null;
  } catch (e) {
    state.teamworkError = e.message;
    toast(e.message, true);
  }
  state.teamworkMoreBusy = false;
  renderTeamwork();
}

// ---------- 打开 / 关闭会话 ----------

/**
 * 功能：打开与某个好友的会话 —— 先幂等地开（或取回）会话，再取最近一页消息、标记已读。
 *
 * 说明：⭐ 用 `friendId` 而不是会话 id 作为入口参数：好友可能一次都没聊过（那时还没有会话），
 *      而 `POST /api/teamwork/conversations` 是**幂等**的（已存在则原样返回），
 *      所以「点好友名字」与「点会话行」走的是同一条路径，不会造出两个同人的空会话。
 *      ⚠️ 老会话仍然能读回来：删好友只是让会话**读不到**，消息一条都没删（见 `teamworkDelSheet()`）。
 *
 * @param {number} friendId - 对方账号 id
 * @returns {Promise.<void>}
 */
export async function openTeamwork(friendId) {
  const fid = Number(friendId);
  if (!fid) return;
  // ⚠️ 记下「想打开的是谁」：取数失败时对话页上的「重新加载」要能重开同一个会话
  //    （整页刷新拿不到这个信息，用户会被莫名其妙丢回列表页）
  state.teamworkTryFriend = fid;
  teamworkTryConv = null; // ⭐ 两条重试锚点互斥（见 `teamworkTryConv` 的说明）
  closeCollabBoard(); // ⭐ 2h：进真人会话就把协作看板屏还掉（否则它会盖住对话页）
  // ⭐ 0.5.2：不再在这里 stop / start 长连接 —— 通道已改为**应用级常驻**（见 startTeamworkStream 的说明），
  //    一台设备始终只有一条，重复 open 不会多占服务端的连接名额。
  state.teamworkView = 'thread';
  state.teamworkId = null;
  state.teamworkPeer = null;
  state.teamworkBuddy = null;
  state.teamworkMessages = [];
  state.teamworkHasMore = false;
  state.teamworkMoreBusy = false;
  state.teamworkLoaded = false;
  state.teamworkError = null;
  renderTeamwork();
  try {
    const r = await api('POST', '/api/teamwork/conversations', { friendId: fid });
    state.teamworkId = Number(r.id);
    // 「拉黑 / 删除」这两个动作在对话页的「⋯」菜单里，需要知道当前是不是已拉黑 ——
    // ⚠️ 拉黑之后它**不在 teamworkFriends 里**，而在 teamworkBlocked 里（服务端按 status 分组），
    //    所以两个清单都要看；两个都没有时兜一个「还不是好友」的壳。
    const buddy =
      (state.teamworkFriends || []).find((f) => Number(f.friend_id) === fid) ||
      (state.teamworkBlocked || []).find((f) => Number(f.friend_id) === fid) ||
      null;
    state.teamworkBuddy = buddy || { friend_id: fid, blocked: false };
    state.teamworkPeer = buddy ? buddy.user : null;
    const m = await api('GET', `/api/teamwork/conversations/${state.teamworkId}/messages?limit=${TEAMWORK_PAGE}`);
    state.teamworkMessages = Array.isArray(m.items) ? m.items : [];
    applyMsgTasks(m.items);
    state.teamworkHasMore = !!m.hasMore;
    state.teamworkLoaded = true;
    state.teamworkError = null;
    // ⭐ 0.5.2：刚打开的会话直接**贴底**（最新消息在最下面，进来看的应该是它，
    //     而不是第一条几年前的历史）—— 见 renderTeamworkThread 里同一处说明。
    teamworkStick = true;
    renderTeamwork();
    markTeamworkRead();
  } catch (e) {
    teamworkFail(e);
  }
}

/**
 * 功能：按**会话 id** 直接打开一个会话（0.6.x）—— 内置角色（提醒助手）走这条。
 *
 * 说明：⭐ 为什么不能复用 `openTeamwork(friendId)`：那条路的入口参数是**对方账号 id**，
 *      服务端会先查「你们是不是好友」（`POST /api/teamwork/conversations` 的闸门）——
 *      而提醒助手**不是好友、也不进 `teamwork_friendships`**，
 *      拿它去开会话只会得到一句「你们还不是好友」。
 *      会话 id 本来就在会话行里（`c.id`），所以这里直接用，一次请求都不多。
 *      ⚠️ 打开之后的一切（取消息 / 标已读 / 顶部连接条）与 `openTeamwork()` 逐字同一套。
 *
 * @param {number} convId - 会话 id
 * @returns {Promise.<void>}
 */
export async function openTeamworkConv(convId) {
  const cid = Number(convId);
  if (!cid) return;
  // ⚠️ 记下「想打开的是哪个会话」：取数失败时「重新加载」要能重开同一个
  //    （与 `state.teamworkTryFriend` 同一用途，只是内置角色没有 friendId 可记）。
  teamworkTryConv = cid;
  state.teamworkTryFriend = null;
  closeCollabBoard(); // ⭐ 2h：进内置角色会话同样把协作看板屏还掉（两块二级屏互斥）
  state.teamworkView = 'thread';
  state.teamworkId = cid;
  state.teamworkPeer = null;
  const conv = (state.teamworkConversations || []).find((c) => Number(c.id) === cid) || null;
  // 内部角色没有「关系行」，给它一个最小的壳：标题与副标题仍走同一套渲染（见 `renderTeamworkThread`）
  state.teamworkBuddy = conv || { id: cid, builtin_key: 'reminder' };
  state.teamworkMessages = [];
  state.teamworkHasMore = false;
  state.teamworkMoreBusy = false;
  state.teamworkLoaded = false;
  state.teamworkError = null;
  renderTeamwork();
  try {
    const m = await api('GET', `/api/teamwork/conversations/${cid}/messages?limit=${TEAMWORK_PAGE}`);
    state.teamworkMessages = Array.isArray(m.items) ? m.items : [];
    applyMsgTasks(m.items);
    state.teamworkHasMore = !!m.hasMore;
    state.teamworkLoaded = true;
    state.teamworkError = null;
    teamworkStick = true; // 刚打开的会话直接贴底（与 openTeamwork 同一口径）
    renderTeamwork();
    markTeamworkRead();
  } catch (e) {
    teamworkFail(e);
  }
}

/**
 * 功能：从对话页回到列表页。
 *
 * 说明：⭐ 0.5.2 起长连接是**应用级常驻**的，这里不再停它（离开对话标签也不停，
 *      见 `switchTab()` 与 `startTeamworkStream()` 的说明）；本函数只负责把视图复位到列表页
 *      并把对话页的临时数据清掉。
 *
 * @returns {void}
 */
export function closeTeamwork() {
  closeSlotConv(); // ⭐ 0.6.x：插槽会话屏与真人对话页共用一个返回钮 / 一个出口，先还掉插槽
  closeCollabBoard(); // ⭐ 2h：协作看板屏与上面那两块共用同一个返回钮 / 同一个出口，一并还掉
  state.teamworkView = 'list';
  state.teamworkId = null;
  state.teamworkPeer = null;
  state.teamworkBuddy = null;
  state.teamworkTryFriend = null;
  teamworkTryConv = null;
  state.teamworkMessages = [];
  state.teamworkHasMore = false;
  state.teamworkLoaded = false;
  state.teamworkError = null;
  renderTeamwork();
  loadTeamwork();
}

/**
 * 功能：**按手机的系统返回键时退一层** —— 在某个会话里就退回会话列表。
 *
 * 说明：⭐⭐ 0.8.5（「返回是回到**上一级**页面，而不是**上一次**页面」）：
 *      会话页（含 AI 的插槽会话屏）以前**不参与历史** ⇒ 按返回会**直接离开对话**
 *      （退到上一个标签），而不是先退回列表。宿主在 `popstate` 里问这里一句。
 *      ⚠️ 必须先判"在不在会话里"再动手：`closeTeamwork()` 会**重取列表**（有副作用），
 *      在列表页上无条件调它等于每次按返回都白刷一遍。
 *      ⚠️ 退回去走的是**与那颗「‹」返回钮同一个** `closeTeamwork()`（它内部先还插槽再复位视图）。
 *
 * @returns {boolean} 真 = 退了一层（宿主据此吞掉这次返回）；假 = 已经在列表页，返回该往屏外走
 */
export function teamworkBackLayer() {
  // ⚠️⭐ 2026-10-20（本版质检）：协作看板**自己画的那些弹层**（卡片 / 成员管理 / 状态 / 新建任务 /
  //    转让 / 评论 / 活动）不是宿主的 `openSheet()`，宿主的 `isSheetOpen()` 认不出它们
  //    。于是从前的行为是：
  //    看板里开着弹层按系统返回 ⇒ 弹层**不关**、整屏被一起退掉（填了一半的评论 / 新任务跟着没了）。
  //    ⇒ 先问看板片段一句（留白事件，本文件不认识它）：**手里有弹层就自己关掉**，
  //    并把 `detail.handled` 置真 —— 这一趟返回到此为止，屏不动。
  try {
    const ev = new CustomEvent('zx:teamwork-collab-back', { detail: { handled: false } });
    document.dispatchEvent(ev);
    if (ev.detail && ev.detail.handled) return true;
  } catch (_e) {
    /* 派发失败（极老浏览器）：照旧往下走 —— 宁可退屏，也别让返回键失效 */
  }
  // ⭐ 2h（丁 · 排版）：协作看板屏也是「屏内二级屏」的一层 —— 按系统返回同样先退回列表页。
  if (state.teamworkSlot || state.teamworkCollab || state.teamworkView === 'thread') {
    closeTeamwork();
    return true;
  }
  return false;
}

// ---------- 实时通道 ----------

/**
 * 功能：开一条 SSE 长连接（幂等：已开着就什么都不做）。
 *
 * 说明：⭐ **0.5.2 起通道是「应用级常驻」的**：登录后（清单确认对话模块开着）就开一条，
 *      切标签、回列表都不停 —— 只有模块被关掉 / 登出才 `stopTeamworkStream()`。
 *      旧方案「进对话页才开、离开就关」是给服务端「每账号 5 条」上限让路；改成常驻后
 *      一台设备任何时刻只有一条，名额毫无压力，换来的是：
 *      「更多」页 / 今天页上那个未读红点、好友申请提示都能**实时**亮起来（
 *      第二轮反馈第 1 条），而不是「回到对话页才看到」。
 *      三个回调的职责 ——
 *      · `onEvent` 把事件翻译成「重画」：本会话的消息并进列表，别人的消息只刷新会话列表，
 *        `friend` 事件（申请 / 同意 / 拒绝 / 删除 / 拉黑）重新拉一次好友总览；
 *      · `onStatus` 把连接状态写进 `state.teamworkStreamStatus` 并**立刻**重画状态条 ——
 *        降级为轮询这件事必须让用户看见（方案 §七）；
 *      · `onPoll` 是补齐入口，**必须幂等**（`modules/teamwork/teamwork-stream.js` 在降级轮询的每一拍、
 *        在线对账的每一拍、以及重连成功时都会调它）。
 *
 * @returns {void}
 */
export function startTeamworkStream() {
  if (teamworkStream) return;
  state.teamworkStreamStatus = 'connecting';
  teamworkStream = createTeamworkStream({
    /**
     * 功能：收到一条 SSE 事件 —— 只做「该重画什么」的判断，不解析业务。
     * @param {Object} ev - `{type:'message'|'friend', …}`
     * @returns {void}
     */
    onEvent(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'message') {
        // ⚠️ 事件里**只有**会话 id 与最小字段（服务端刻意如此）：
        //    发给别人的消息一律只刷新会话列表，绝不往当前对话里塞。
        // ⭐ 0.5.2：通道常驻之后，「当前会话」必须同时要求**人真的在对话页上**
        //    （`state.tab === 'teamwork' && state.teamworkView === 'thread'`）——
        //    离开对话标签只复位 `teamworkView`，`teamworkId` 仍留着（回来自动回到上下文）；
        //    不加这个判断的话，人在「今天」页也会替他把新消息标成已读，红点永远不亮。
        if (
          state.tab === 'teamwork' &&
          state.teamworkView === 'thread' &&
          state.teamworkLoaded &&
          state.teamworkId &&
          Number(ev.conversationId) === Number(state.teamworkId)
        ) {
          const msg = ev.message || {};
          if (msg.id !== undefined) {
            state.teamworkMessages = mergeById(state.teamworkMessages, [msg]);
            markTeamworkRead();
            renderTeamwork();
          }
        } else {
          // ⭐ 0.5.2：不在对话页时只**静默**刷新（不重画当前屏）——
          //    红点靠 loadTeamwork 里的 updateTeamworkUnread() 更新，当前那一屏（今天 / 任务板…）一个字节都不动。
          loadTeamwork({ quiet: state.tab !== 'teamwork' });
        }
        return;
      }
      if (ev.type === 'friend') loadTeamwork({ quiet: state.tab !== 'teamwork' }); // 关系变了：重新拉总览（事件体里刻意不含账号资料）
    },
    /**
     * 功能：连接状态变化 —— 写进状态并就地重画状态条。
     * @param {string} s - `'online'` / `'connecting'` / `'polling'` / `'off'`
     * @returns {void}
     */
    onStatus(s) {
      state.teamworkStreamStatus = s;
      paintTeamworkStatus();
      if (s === 'polling') toast('实时连接不可用，已改为自动刷新', true);
    },
    /**
     * 功能：补齐增量（降级轮询 / 在线对账 / 重连成功）—— 幂等。
     * @returns {void}
     */
    onPoll() {
      teamworkPoll();
    },
  });
  teamworkStream.start();
}

/**
 * 功能：⭐ 0.5.2 应用启动后的常驻通道引导 —— 模块清单确认「对话开着」时由
 *      `app.js` 的 `applyPrefsVisibility()` 调一次（幂等）。
 *
 * 说明：只开连接、**不当场拉数据**：首屏正是请求最挤的时候（bootstrap / 任务 / 看板 +
 *      几十个 modulepreload），好友总览这份不急 —— 延后两秒半再补一次静默拉取，
 *      未读红点就能在进任何屏之前亮起来；此后靠 SSE 事件与 `teamworkPoll()` 的后台拍子维持。
 *
 * @returns {void}
 */
export function teamworkBoot() {
  if (teamworkBooted) return;
  teamworkBooted = true;
  startTeamworkStream();
  setTimeout(() => {
    if (state.tab !== 'teamwork' && !state.teamworkLoaded) loadTeamwork({ quiet: true });
  }, 2500);
  // ⭐⭐ 0.8.17：预热「团队协作」插槽片段（含 AI 助手那一片）—— 与电脑端同一条理由，
  //    说明见 `modules/teamwork/desktop.js` 的 `teamworkBoot()`。
  //    ⚠️ 一律不 await；⛔ 不许把差事塞给宿主（`app.js` 一个字不改）。
  warmSlots('mobile', 'teamwork-page', { modules: state.modules, uiOf, me: state.me });
}

/**
 * 功能：停掉长连接并复位状态 —— ⭐ 0.5.2 起只有两种调用方：
 *      「设置里关掉了对话模块」（`app.js` 的 `applyPrefsVisibility`）与登出（页面随之卸载）。
 *      ⚠️ 切标签、回列表页**不许**调它 —— 那会把红点与实时刷新一起关掉。
 * @returns {void}
 */
export function stopTeamworkStream() {
  if (teamworkStream) teamworkStream.stop();
  teamworkStream = null;
  teamworkBooted = false;
  state.teamworkStreamStatus = 'off';
  paintTeamworkStatus();
}

/**
 * 后台刷新的最小间隔（毫秒）：不在对话标签时，红点与列表数据至多每 30 秒静默对账一次 ——
 * 手机浏览器一挂一整天，每 3 秒打一次接口既费电也没必要；前台（对话标签打开时）仍是
 * 降级轮询的 3 秒 / SSE 事件即时。
 * @type {number}
 */
const TEAMWORK_BG_POLL_MS = 30000;

/** 上一次后台静默对账的时刻（`Date.now()`），配 `TEAMWORK_BG_POLL_MS` 用 */
let teamworkBgAt = 0;

/**
 * 功能：补齐增量 —— 降级轮询 / 在线对账的每一拍、重连成功时各一次；幂等。
 *
 * 说明：⭐ 0.5.2 起它**不再因为「不在对话标签」就早退**：通道常驻之后，轮询的每一拍
 *      都是把未读红点、好友申请提示送到其它标签上的唯一通路（SSE 假死的真机上尤其是）。
 *      节流靠 `TEAMWORK_BG_POLL_MS`：后台每 30 秒静默拉一次总览（只写数据 + 更新红点，
 *      不重画当前屏），前台照旧全速刷。
 *
 * @returns {void}
 */
export function teamworkPoll() {
  if (state.tab !== 'teamwork') {
    const now = Date.now();
    if (now - teamworkBgAt < TEAMWORK_BG_POLL_MS) return;
    teamworkBgAt = now;
    loadTeamwork({ quiet: true });
    return;
  }
  if (state.teamworkView === 'thread' && state.teamworkLoaded && state.teamworkId) teamworkRefreshMessages();
  else loadTeamwork();
}

/**
 * 功能：刷新对话页那条**连接告警条** —— 不重画整屏（重画会打断正在输入的输入框）。
 *
 * 说明：⚠️ 一切正常（`teamworkStatusText()` 返回空串）时整条**收起来**，页面上不留任何字样 ——
 *      连接正常是常态，不需要占一行；而「在线」两个字摆在对方名字旁边会被读成「对方在线」
 *      （见 `teamworkStatusText()` 的说明）。
 *
 * @returns {void}
 */
export function paintTeamworkStatus() {
  const box = document.getElementById('teamwork-netwarn');
  if (!box) return;
  const msg = teamworkStatusText(state.teamworkStreamStatus || 'off');
  box.textContent = msg;
  box.classList.toggle('hidden', !msg);
}

// ---------- 渲染 ----------

/**
 * 功能：按 `state.teamworkView` 画列表页 / 对话页 / 插槽会话屏 / 协作看板屏，并在它们之间切换。
 *
 * 说明：⚠️ 本函数写到的**静态骨架节点**（都在 `mobile/index.html` 的 `#view-teamwork` 里）——
 *      两块屏幕：`#teamwork-screen-list` / `#teamwork-screen-thread`；
 *      ⭐ 0.6.x 还有第三块**动态建**的插槽会话屏 `#teamwork-screen-slot`（`ensureSlotScreen()`）；
 *      ⭐ 2h（丁 · 排版）再加第四块**动态建**的协作看板屏 `#teamwork-screen-board`（`ensureBoardScreen()`）——
 *      两块动态屏都没有静态骨架，没被打开时永远 hidden。
 *      列表页：`#teamwork-add-name`（加好友输入框）/ `#teamwork-privacy`（隐私提示）/ `#teamwork-list-rows`（列表的共同落点）；
 *      对话页：`#teamwork-peer-name` / `#teamwork-peer-sub` / `#teamwork-netwarn` / `#teamwork-history`；
 *      另有一个在标签栏上（不在本屏内）：`#tab-teamwork-dot`（未读角标，由 `updateTeamworkUnread()` 写）。
 *      骨架与代码不同步的代价见 0.3.3 的 `#hw-count` 事故（AGENTS §八）——
 *      本文件的每处写入也都先判节点在不在，两道保险。
 *
 * @returns {void}
 */
export function renderTeamwork() {
  if (!$('#view-teamwork')) return;
  const thread = state.teamworkView === 'thread';
  // ⭐ 0.6.x 插槽会话（AI 助手这类的「会话对象」）：第三块屏，由 `teamwork-thread` 插槽片段画内容 ——
  //    骨架（返回钮 / 名字 / 副标题）仍是本模块自己的，与真人对话页同一套结构。
  const slot = !!state.teamworkSlot;
  // ⭐ 2h（丁 · 排版）协作看板（点开工项目进的那一屏）：第四块屏，内容区挂 `teamwork-board` 槽。
  const collab = !!state.teamworkCollab;
  const scrList = $('#teamwork-screen-list');
  const scrThread = $('#teamwork-screen-thread');
  const scrSlot = ensureSlotScreen();
  const scrBoard = ensureBoardScreen();
  if (scrList) scrList.classList.toggle('hidden', thread || slot || collab);
  if (scrThread) scrThread.classList.toggle('hidden', !thread);
  if (scrSlot) scrSlot.classList.toggle('hidden', !slot);
  if (scrBoard) scrBoard.classList.toggle('hidden', !collab);
  if (collab) paintCollabBoard();
  else if (slot) renderSlotThread();
  else if (thread) renderTeamworkThread();
  else {
    renderTeamworkList();
    mountTeamworkSlots();
  }
  // ⭐ 0.8.4：外部（记账的 AI 圆环）请求「进对话并打开某个会话对象」⇒ 条目齐了就兑现
  tryOpenWantSlot();
  paintTeamworkStatus();
  // ⭐ 0.7.7-⑯：**换完屏就请宿主重画一次顶栏**（进会话收起来 / 退回列表恢复）。
  //    ⚠️ 必须在这里（而不是各自的点击处理里）：各块屏的切换全收口在本函数 ——
  //    进真人会话、退回列表、开 / 关插槽屏、开 / 关协作看板都走到，漏一条就是「某种进法顶栏不收」。
  //    ⚠️⭐ 2h 已知边界：宿主的「收起顶栏」判据（`mobile/app.js` 的 `inConv`）当前只认
  //    `teamworkView === 'thread'` 与 `teamworkSlot` ⇒ 协作看板屏上那条宿主顶栏**仍是展开的**
  //    （它是一条全局栏，判据不在这份文件里；补 `|| !!state.teamworkCollab` 即可，属另一份文件的事）。
  //    ⚠️ 宿主那边是幂等的（只写文字与 class，不重建 DOM），本函数被多处调用也不会造成重画风暴。
  //    ⚠️ 走 `paintChrome()`（`mobile/ui.js` 的窄入口）而不是 import 宿主 `app.js` ——
  //    模块不许认识宿主（会绕成 `app → 模块 → app` 的环）。
  paintChrome();
}

/**
 * 功能：挂载对话列表页的**模块插槽**（0.6.0）—— tasks 的协作登记器从这里借位置进来。
 *
 * 说明：⭐ 容器在 `#teamwork-screen-list` 里、隐私提示行之后，由本函数**动态创建并复用**
 *      （`data-slot="teamwork-page"` 是它的唯一标记）；挂载逻辑全部在 `core/slots.js`
 *      （清单 ∩ 接线表里谁声明了这个槽、模块开着才画、失败不静默），本文件不认识任何具体模块。
 *      ⚠️⭐ 2h（丁 · 排版）起这个容器是**零高度、不占位置**的（`class="teamwork-collab-registrar"`，
 *      见 `mobile/app.css`）：那一块以前整块横跨、把列表页往下推（「上下太丑」的根因）。
 *      片段本身只当**登记器**（把协作项目登记进第三组）＋ **弹层宿主**（弹层是 `position: fixed`，
 *      不受零高度裁剪），⛔ 没有常驻可见内容。
 *      ⚠️ `state.modules` 还没到手时槽为空即隐藏，不会报错；清单到手后重画即挂上。
 *
 * @returns {void}
 */
function mountTeamworkSlots() {
  const scrList = $('#teamwork-screen-list');
  if (!scrList) return;
  let box = scrList.querySelector(':scope > [data-slot="teamwork-page"]');
  if (!box) {
    box = document.createElement('div');
    box.dataset.slot = 'teamwork-page';
    box.className = 'teamwork-collab-registrar';
    const priv = scrList.querySelector('#teamwork-privacy');
    if (priv && priv.parentNode) priv.parentNode.insertBefore(box, priv.nextSibling);
    else scrList.insertBefore(box, scrList.firstChild);
  }
  mountSlots(box, 'teamwork-page', { end: 'mobile', modules: state.modules, uiOf, me: state.me }).then(() => {
    // ⭐ 插槽片段是异步 import 的：它要往会话区 / 协作项目组登记条目（`zx:teamwork-conv-entries` /
    //    `zx:teamwork-collab-entries`），开屏那一次列表重画可能已经跑完 —— 挂载完补画一次列表，
    //    条目才稳定出现（幂等）。⚠️ 别在别的屏上补画：那会把看板 / 会话屏顶掉。
    if (state.tab === 'teamwork' && state.teamworkView !== 'thread' && !state.teamworkSlot && !state.teamworkCollab)
      renderTeamworkList();
    // ⭐ 0.8.4：片段挂完之后**再兑现一次**那个待打开的插槽会话 —— 首次进对话时条目还不存在，
    //    光靠 `renderTeamwork()` 末尾那一次会落空（表现是「点了 AI 圆环只到了对话列表」）。
    tryOpenWantSlot();
  });
}

// ---------- 插槽会话（0.6.x）----------

/**
 * 当前登记进会话区的**插槽会话条目**（键 → `{ key, icon, name, sub, head }`）。
 * ⚠️ 每次重画列表都先清再收（`zx:teamwork-conv-entries` 留白事件）：残留的旧条目会指向已卸载的片段。
 * @type {Map.<string, Object>}
 */
const teamworkSlotEntries = new Map();

/**
 * ⭐ 2h（丁 · 排版）当前登记进**列表页第三组「协作项目」**的条目（键 → `{ key, name, sub }`）。
 *
 * 说明：⭐ 与 `teamworkSlotEntries` 同一套规矩 —— 每次重画列表都先发一次
 *      `zx:teamwork-collab-entries` 留白事件（**同步**派发）**先清再收**；本模块
 *      **不认识 `tasks` 这个模块**（删掉那个目录 ⇒ 这一组空着、其它一切照旧），
 *      谁想把自己的项目摆进这一组谁就来填；行与分组头由本模块统一画（三组才同款）。
 *      ⚠️ 残留的旧条目会指向已卸载的片段，所以「清」这一步不能省。
 * @type {Map.<string, Object>}
 */
const teamworkCollabEntries = new Map();

/**
 * ⭐ 2h（丁 · 排版）「协作项目」那一块的折叠键 —— ⚠️ 必须**预先登记**进 `state.foldSecs`。
 *
 * 说明：契约 §2 要求折叠键与电脑端 `teamworkState.fold.collab` 逐字一致（`collab`）。
 *      ⚠️ `state.foldSecs` 是设置页与对话列表**共用的一个对象**：这里显式写一个初值
 *      （`false` = 展开），⛔ 别在这里写「除了某些 id 一律收起」那种全局默认 ——
 *      那会把设置页自己的分块一起收掉（见 `views/more.js` 的 `isFolded()`）。
 * @type {boolean}
 */
state.foldSecs.collab = false;

/** 外部请求要打开的插槽会话键（空串 = 没有待兑现的请求）。 @type {string} */
let wantSlot = '';

/**
 * 功能：兑现「外部请求打开某个插槽会话」—— ⭐ 0.8.4 新增（记账的 AI 圆环要用）。
 *
 * 说明：⭐⭐ 为什么要有这一步：插槽会话的**条目**是 ai 片段异步 import 之后才登记的
 *      （`zx:teamwork-conv-entries`），而记账那颗圆环点下去时片段可能**还没挂**——直接
 *      `openSlotConv(key)` 会因为它「不在条目表里」而**什么都不做**（表现是
 *      「点了 AI 圆环只停在对话列表」这种**不报错**的坏体验）。
 *      ⇒ 请求先记在 `wantSlot`，**每次列表渲染完 / 片段挂载完**都来问一次，条目齐了才真开。
 * @returns {void}
 * @since 0.8.4
 */
function tryOpenWantSlot() {
  const k = String(wantSlot || '');
  if (!k) return;
  if (String(state.teamworkSlot || '') === k) {
    wantSlot = ''; // 已经开着这一个 ⇒ 请求已兑现
    return;
  }
  if (!teamworkSlotEntries.has(k)) return; // 条目还没登记 ⇒ 留着，等下一次
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

/** 当前已挂过 `teamwork-thread` 片段的插槽会话键（空串 = 没挂）——重画不重挂，免得输入与历史被打掉。 @type {string} */
let slotMounted = '';

/**
 * 功能：懒建**插槽会话屏**（第三块屏，与 `#teamwork-screen-list` / `#teamwork-screen-thread` 平级）。
 *
 * 说明：⭐ 骨架与真人对话页同一套结构（返回钮 + 名字 + 副标题 + 内容区），但它是**动态建**的：
 *      它只为插槽会话服务，没有插槽条目时永远不出现（建出来也是 hidden，零成本）。
 *      返回钮走 `data-act="teamwork-back"` —— 与真人对话页同一个动作、同一个 `closeTeamwork()` 出口。
 * @returns {?HTMLElement} 屏节点（`#view-teamwork` 不存在时为 null）
 */
function ensureSlotScreen() {
  const view = $('#view-teamwork');
  if (!view) return null;
  let scr = $('#teamwork-screen-slot');
  if (scr) return scr;
  scr = document.createElement('div');
  scr.id = 'teamwork-screen-slot';
  scr.className = 'hidden';
  scr.innerHTML =
    '<div class="teamwork-peerbar">' +
    '<button class="teamwork-back" type="button" data-act="teamwork-back" aria-label="返回列表">‹</button>' +
    '<div class="teamwork-peer"><b id="teamwork-slot-name" class="builtin"></b>' +
    '<small class="teamwork-status"><span id="teamwork-slot-sub"></span></small></div>' +
    '</div>' +
    '<div class="teamwork-slot-body" id="teamwork-slot-body" data-slot="teamwork-thread"></div>';
  const thread = $('#teamwork-screen-thread');
  if (thread && thread.parentNode) thread.parentNode.insertBefore(scr, thread.nextSibling);
  else view.appendChild(scr);
  return scr;
}

/**
 * 功能：渲染插槽会话屏 —— 名字 / 副标题来自条目，内容区挂 `teamwork-thread` 插槽片段。
 * @returns {void}
 */
function renderSlotThread() {
  const it = teamworkSlotEntries.get(String(state.teamworkSlot)) || {};
  const name = $('#teamwork-slot-name');
  const sub = $('#teamwork-slot-sub');
  if (name) name.textContent = `${it.icon || '🤖'} ${it.name || state.teamworkSlot}`;
  if (sub) sub.textContent = it.head || '插槽会话';
  if (slotMounted === String(state.teamworkSlot)) return; // 重画不重挂：输入中的字与历史都别动
  const body = $('#teamwork-slot-body');
  if (!body) return;
  slotMounted = String(state.teamworkSlot);
  mountSlots(body, 'teamwork-thread', { end: 'mobile', modules: state.modules, uiOf, me: state.me });
}

/**
 * 功能：打开一个**插槽会话**（会话区里由 `zx:teamwork-conv-entries` 登记的条目）。
 * @param {string} key - 条目键
 * @returns {void}
 */
export function openSlotConv(key) {
  const k = String(key || '');
  if (!teamworkSlotEntries.has(k)) return;
  closeCollabBoard(); // ⭐ 2h：与协作看板屏互斥（两块二级屏同一时刻只画一个）
  state.teamworkSlot = k;
  state.teamworkView = 'list'; // 插槽会话屏与真人对话页互斥：各块屏都由 renderTeamwork() 按 state 分开关
  renderTeamwork();
}

/**
 * 功能：关掉插槽会话 —— 先发 `zx:teamwork-conv-close`（片段用它停掉在途的流式请求），再清状态。
 *      ⚠️ **不重画**：调用方（`closeTeamwork()` / 切标签）自己会重画或正在离开这一屏。
 * @returns {void}
 */
export function closeSlotConv() {
  if (!state.teamworkSlot) return;
  document.dispatchEvent(new CustomEvent('zx:teamwork-conv-close', { detail: { key: String(state.teamworkSlot) } }));
  state.teamworkSlot = null;
  slotMounted = '';
}

// ---------- 协作看板（⭐ 2h · 丁 · 排版）----------

/** 当前已挂过 `teamwork-board` 片段的项目键（空串 = 没挂）——重画不重挂，免得看板被打回顶部。 @type {string} */
let boardMounted = '';

/**
 * 功能：懒建**协作看板屏**（第四块屏，与 `#teamwork-screen-list` / `-thread` / `-slot` 平级）。
 *
 * 说明：⭐ 骨架与插槽会话屏同一套结构（返回钮 + 名字 + 副标题 + 内容区），也是**动态建**的：
 *      它只为协作看板服务，没点开时永远 hidden（建出来也是 hidden，零成本）。
 *      返回钮走 `data-act="teamwork-back"` —— 与插槽会话屏、真人对话页同一个动作、同一个出口。
 *      ⚠️ 内容区挂 **`teamwork-board`** 槽（⛔ **不复用** `teamwork-thread` —— 那是会话线程）。
 *
 * @returns {?HTMLElement} 屏节点（`#view-teamwork` 不存在时为 null）
 */
function ensureBoardScreen() {
  const view = $('#view-teamwork');
  if (!view) return null;
  let scr = $('#teamwork-screen-board');
  if (scr) return scr;
  scr = document.createElement('div');
  scr.id = 'teamwork-screen-board';
  scr.className = 'hidden';
  scr.innerHTML =
    '<div class="teamwork-peerbar">' +
    '<button class="teamwork-back" type="button" data-act="teamwork-back" aria-label="返回列表">‹</button>' +
    '<div class="teamwork-peer"><b id="teamwork-board-name"></b>' +
    '<small class="teamwork-status"><span id="teamwork-board-sub"></span></small></div>' +
    '</div>' +
    '<div class="teamwork-board-body" id="teamwork-board-body" data-slot="teamwork-board"></div>';
  const slot = ensureSlotScreen();
  if (slot && slot.parentNode) slot.parentNode.insertBefore(scr, slot.nextSibling);
  else view.appendChild(scr);
  return scr;
}

/**
 * 功能：画**协作看板屏** —— 名字 / 副标题来自条目，内容区挂 `teamwork-board` 插槽片段。
 *
 * 说明：⚠️ 项目名与「‹ 返回」由本函数画在第二屏那条 `teamwork-peerbar` 上（片段只画内容，
 *      见 `mobile-teamwork-board.js` 的 `boardTopHtml()` 那段说明）。
 *      ⚠️ 一个项目**只挂一次**（`boardMounted`）：重画不重挂 —— 免得看板的滚动位置与
 *      已展开 / 已收起的那些组被打回原样。换项目则由 `renderCollabBoard()` 重设后另挂。
 *
 * @returns {void}
 */
function paintCollabBoard() {
  const k = String(state.teamworkCollab);
  const it = teamworkCollabEntries.get(k) || {};
  const name = $('#teamwork-board-name');
  const sub = $('#teamwork-board-sub');
  if (name) name.textContent = it.name || k;
  if (sub) sub.textContent = it.sub || '协作项目';
  if (boardMounted === k) return; // 重画不重挂：看板的滚动与展开状态都别动
  const body = $('#teamwork-board-body');
  if (!body) return;
  boardMounted = k;
  // ⭐ 0.8.53：从项目行那颗 ＋ 进来 ⇒ 把「进去就开新建弹层」随挂载上下文传给片段
  const openNew = !!state.teamworkBoardNew;
  state.teamworkBoardNew = false;
  mountSlots(body, 'teamwork-board', {
    end: 'mobile',
    modules: state.modules,
    uiOf,
    me: state.me,
    collabPid: k,
    openNew: openNew,
  });
}

/**
 * 功能：点开列表页「协作项目」组里的一条 ⇒ **进第二屏**（协作看板）。
 *
 * 说明：⭐ 与 `openSlotConv()` 是**同一形态**（同一条「屏内二级屏」的路，见 `renderTeamworkThread()`）：
 *      第二屏的骨架（返回钮 / 项目名 / 副标题）仍由本模块画，内容区挂 `teamwork-board` 槽
 *      （⛔ 不复用 `teamwork-thread` —— 那是会话线程）；点开的是**哪一个项目**随挂载上下文
 *      （`collabPid`）传给片段 —— 本模块不认识那个片段画什么。
 *      ⚠️ 与插槽会话**互斥**：先 `closeSlotConv()` 把那边关掉（第二屏同一时刻只画一个）。
 *      ⚠️ 条目还没登记（列表页没画过这一组）时**不开** —— 免得开出一个指向不存在项目的空看板。
 *
 * @param {string} pid - 项目 id
 * @param {boolean} [openNew] - ⭐ 0.8.53：进去后**立刻摆出【新建任务】弹层**（项目行那颗 ＋ 用）
 * @returns {void}
 */
export function renderCollabBoard(pid, openNew) {
  const k = pid == null ? '' : String(pid);
  if (!k) return;
  if (!teamworkCollabEntries.has(k)) return;
  closeSlotConv(); // ⭐ 与「插槽会话」互斥
  state.teamworkCollab = k;
  state.teamworkView = 'list'; // 两块二级屏互斥，由 renderTeamwork() 按 state 分开关
  // ⭐ 0.8.53：「点 ＋ 新建」在**已经开着这个项目的看板**时也要生效 ——
  //    `paintCollabBoard()` 有一条「重画不重挂」的缓存，不把缓存清掉就弹不出新建弹层。
  if (openNew) {
    state.teamworkBoardNew = true;
    boardMounted = '';
  }
  renderTeamwork();
}

/**
 * 功能：关掉协作看板（幂等）—— 把第二屏还给列表页。
 *      ⚠️ **不重画**：调用方（`closeTeamwork()` / `zx:teamwork-board-close` / 切标签）自己会重画。
 * @returns {void}
 */
export function closeCollabBoard() {
  if (!state.teamworkCollab) return;
  state.teamworkCollab = null;
  boardMounted = '';
}

// ⭐ 2h（丁 · 排版）：列表页第三组「协作项目」的点击委托 —— 行与分组头由本模块画（三组同款），
//    所以点击也留在本模块处理：⛔ **不往宿主动作表（`mobile/app.js` 的 ACTIONS）加新键**。
//    ⚠️ 这些行上**没有 `data-act`**（用的是 `data-teamwork-collab*`）—— 入口 `onClick()` 的
//    `closest('[data-act]')` 不会命中它们，所以两条路不会重复处理。
document.addEventListener('click', (e) => {
  const t = e && e.target && e.target.closest ? e.target : null;
  if (!t) return;
  // ⚠️ 先判「＋ 添加共享项目」那一行：它**不带** `data-teamwork-collab`，但排前面最稳
  //    （派 `zx:teamwork-collab-add` 让 tasks 的 page 片段去开它的弹层 —— 本模块不认识那个弹层）。
  if (t.closest('[data-teamwork-collab-add]')) {
    document.dispatchEvent(new CustomEvent('zx:teamwork-collab-add'));
    return;
  }
  // ⭐⭐ 0.8.53（团队协作的项目中也要有 + 图标可以新建任务）：行尾那颗 ＋ 先在委托里判，
  //    打开的仍是同一个项目的**第二屏**，只是进去之后立刻摆出【新建任务】弹层（`openNew`）。
  const newRow = t.closest('[data-teamwork-collab-new]');
  if (newRow) return renderCollabBoard(newRow.dataset.teamworkCollabNew, true);
  const row = t.closest('[data-teamwork-collab]');
  if (row) renderCollabBoard(row.dataset.teamworkCollab);
});

// ⭐ 2h（丁 · 排版）：协作项目条目表变了（`mobile-teamwork-page.js` 派这个留白事件）⇒
//    重画列表页第三组；⚠️ 当前开着的那个项目若已不在协作里（例如刚被移出），把第二屏收掉、退回列表。
document.addEventListener('zx:teamwork-collab-changed', () => {
  if (state.tab !== 'teamwork') return;
  if (state.teamworkCollab) {
    if (!teamworkCollabEntries.has(String(state.teamworkCollab))) {
      closeCollabBoard();
      renderTeamwork();
    }
    return;
  }
  if (state.teamworkView !== 'thread' && !state.teamworkSlot) renderTeamworkList();
});

// ⭐ 2h（丁 · 排版）：看板那边请求「关掉看板」（例如刚把项目移出协作，它已无内容可画）
//    ⇒ 当成本模块自己的「返回」：第二屏还给列表页。与 `closeCollabBoard()` 幂等。
document.addEventListener('zx:teamwork-board-close', () => {
  if (!state.teamworkCollab) return;
  closeCollabBoard();
  renderTeamwork();
});

/**
 * 功能：画**列表页** —— 隐私提示、会话、好友、待处理申请、我发出的、已拉黑，各一块。
 * @returns {void}
 */
export function renderTeamworkList() {
  const box = $('#teamwork-list-rows');
  if (!box) return;
  const priv = $('#teamwork-privacy');
  if (priv) priv.textContent = '🔒 ' + TEAMWORK_PRIVACY;
  if (state.teamworkError) {
    box.innerHTML = teamworkErrHtml(state.teamworkError);
    return;
  }

  // ⭐ 0.6.x 插槽会话条目：本函数每次重画都先发一次 `zx:teamwork-conv-entries` 留白事件
  //    （与电脑版 `teamworkConvSecHtml()` 同一套规矩）—— 谁想把自己的「会话对象」摆进这张列表
  //    谁就来填，本模块不认识任何具体模块。条目用本模块自己的行样式（`teamworkSlotRow()`）
  //    画在真会话前面，长得和真会话一模一样。
  teamworkSlotEntries.clear();
  const ev = new CustomEvent('zx:teamwork-conv-entries', { detail: { items: [] } });
  document.dispatchEvent(ev);
  const slotItems = ((ev.detail && ev.detail.items) || []).filter((it) => it && it.key);
  for (const it of slotItems) teamworkSlotEntries.set(String(it.key), it);

  // ⭐ 2h（丁 · 排版）：列表页**第三组「协作项目」**的条目 —— 与上面 `zx:teamwork-conv-entries`
  //    同一套规矩（本模块不认识 `tasks` 这个模块，谁想摆进这一组谁就来填）。同样**先清再收**：
  //    残留的旧条目会指向已卸载的片段。⚠️ 事件是同步派发的，所以可以就地收齐。
  teamworkCollabEntries.clear();
  const cev = new CustomEvent('zx:teamwork-collab-entries', { detail: { items: [] } });
  document.dispatchEvent(cev);
  const collabItems = ((cev.detail && cev.detail.items) || []).filter((it) => it && it.key);
  for (const it of collabItems) teamworkCollabEntries.set(String(it.key), it);

  const convs = state.teamworkConversations || [];
  const friends = state.teamworkFriends || [];
  const incoming = state.teamworkIncoming || [];
  const outgoing = state.teamworkOutgoing || [];
  const blocked = state.teamworkBlocked || [];

  // ⚠️⭐ 2h（丁 · 排版）：这一段原来是「会话 / 好友 / 申请 / 内置助手**全空** ⇒ 画一句引导然后 return」。
  //    本轮起 **不再 return**（改成把引导句摆在最上面）：它下面还有第三组「协作项目」，
  //    组内第一行「＋ 添加共享项目」必须**始终可达** —— 直接 return 会把「把第一个项目加进协作」
  //    的门也一起藏掉（全新账号恰是最想试这一步的人）。
  const nothing =
    !convs.length &&
    !friends.length &&
    !incoming.length &&
    !outgoing.length &&
    !blocked.length &&
    !slotItems.length &&
    !collabItems.length;

  // ⭐ 0.7.6：好友 / 申请从内联区改成**两颗按钮**（点开是底部弹层）。
  // ⭐ 0.7.7：列表页拆成**两段** —— 「内置助手」（插槽条目 + `builtin_key` 会话）与「好友」（其余）。
  //    ⚠️ 判据走 `shared.js` 的 `isAssistConv()`（与电脑版同一份，⛔ 不在这里另写一个 `if`）；
  //    ⚠️ 组内顺序照服务端给的顺序 —— 这里只分组、不重排。
  const parts = [];
  if (nothing) {
    parts.push(
      emptyHtml(
        '💬',
        '还没有对话',
        '点右上角「＋ 加好友」，输入对方的登录名发起申请；对方同意之后就能开始聊天了。消息只在你和对方之间，别人看不到。',
      ),
    );
  }
  parts.push(teamworkActsHtml(friends.length, incoming.length, outgoing.length));
  const assistConvs = convs.filter(isAssistConv);
  const friendConvs = convs.filter((c) => !isAssistConv(c));
  const slotRows = slotItems.map(teamworkSlotRow).join('');
  // ⚠️⭐ 内置助手一条都没有 ⇒ **整段不画**（连标题一起不画）：一个孤零零的空标题比没有更难懂
  //    ；两组都空时下面只剩「好友」那一句，正是想要的。
  if (assistConvs.length || slotItems.length) {
    parts.push(
      teamworkSec('teamwork-assist', '内置助手', '', `<div class="teamwork-rows">${slotRows}${assistConvs.map(teamworkConvRow).join('')}</div>`),
    );
  }
  parts.push(
    teamworkSec(
      'teamwork-conv',
      '好友',
      '',
      friendConvs.length
        ? `<div class="teamwork-rows">${friendConvs.map(teamworkConvRow).join('')}</div>`
        : '<div class="m-tip">还没有会话 —— 点上面「好友」里的一位，就能开始聊。</div>',
    ),
  );
  // ⭐ 2h（丁 · 排版）：第三组「协作项目」—— 与上面两组**同一个 `teamworkSec()`**（标题行 /
  //    折叠箭头 / 条数位置 / 行样式全同款），行也是同一套 `.teamwork-row` ⇒ 三组才真正同款。
  //    ⚠️ 这一组**恒画**（不像「内置助手」那样空了就整段不画）：组内第一行「＋ 添加共享项目」
  //    永远要在 —— 否则「把一个项目加进来」的门就没了（与电脑端同一口径）。
  parts.push(
    teamworkSec(
      'collab',
      '协作项目',
      String(collabItems.length),
      '<div class="teamwork-rows">' +
        teamworkCollabAddRow() +
        (collabItems.length
          ? collabItems.map(teamworkCollabRow).join('')
          : '<div class="m-tip">还没有协作项目</div>') +
        '</div>',
    ),
  );
  box.innerHTML = parts.join('');
}

/**
 * 功能：画一块**可折叠**的分区（0.4.4）—— 标题行用设置页那套 `secHeadFold()`，正文是它的兄弟节点。
 *
 * 说明：⭐ 折叠靠**一条 CSS**（`.sec.folded >:not(.sec-head){display:none}`）+ 就地翻 class
 *      （`ui.js` 的 `toggleSec()`），**不整屏重画** —— 重画会把滚动位置打回页首，
 *      用户每收一块就被弹回顶部，比不折叠还难用。
 *      ⚠️ 结构必须是「`.sec` 的直接子节点」：`toggleSec()` 只切 `#sec-<id>` 的 class，
 *      CSS 也只认直接子节点，正文多包一层就会出现「收不起来」。
 *      ⚠️ 分区 id 带 `teamwork-` 前缀：`state.foldSecs` 与设置页共用，撞名会互相牵连。
 *      ⭐ 2h（丁 · 排版）的唯一例外是第三组 `collab`：它与电脑端 `teamworkState.fold.collab`
 *      **逐字同名**（契约 §2 要求折叠键两端一致），且不与设置页任何分块的 id 撞名。
 *
 * @param {string} id - 分区标识（`teamwork-assist` / `teamwork-conv` / `collab`）
 * @param {string} title - 分区标题
 * @param {string} note - 右侧备注（计数 / 提示），可为空
 * @param {string} bodyHtml - 正文 HTML
 * @returns {string} 该块的 HTML 字符串
 */
function teamworkSec(id, title, note, bodyHtml) {
  const folded = !!(state.foldSecs && state.foldSecs[id]);
  return (
    `<div class="sec${folded ? ' folded' : ''}" id="sec-${id}">` +
    secHeadFold(id, title, '', note, folded) +
    bodyHtml +
    `</div>`
  );
}

/**
 * 功能：画**对话页** —— 对方名字、消息流、翻历史的提示。
 *
 * 说明：⚠️ 消息气泡里的正文**只经过 `esc()`**（`state.teamworkMessages` 是别人可控内容）；
 *      ⚠️ 这里**不重画输入框**：输入框是 `mobile/index.html` 里的静态骨架，
 *      重画整屏会让正在打的字与焦点一起消失。
 *      ⭐ 0.5.2 起渲染完**按需贴底**：刚打开会话 / 自己刚发了消息（`teamworkStick`）时无条件滚到
 *      最新一条；其余时候只在用户本来就贴着底部（120px 内）时才跟随 ——
 *      正在往上翻历史的人不会被一条新消息拽回底部（与电脑版 `scrollTeamworkToBottom()` 同一口径）。
 *      ⚠️ 旧版完全没有这段：打开有历史的会话停在**最旧**那条、发消息后也不跟到最新，
 *      看起来就像「消息发出去没反应」。
 * @returns {void}
 */
export function renderTeamworkThread() {
  const box = $('#teamwork-history');
  if (!box) return;
  // ⚠️ 取不到 `teamworkPeer` 时（例如会话打不开 —— 已经不是好友了）退到关系行上的那份，
  //    否则标题会显示一个没意义的「对话」。
  const b = state.teamworkBuddy || {};
  const peer = state.teamworkPeer || (Number(b.friend_id) ? b.user : null) || {};
  // ⭐ 0.6.x：内置角色会话（提醒助手）**不是一个人** —— 它排在「备注 / 显示名」那一套之前，
  //    否则标题会退化成没意义的「对话」。
  const builtin = !!b.builtin_key;
  // ⭐ 0.4.4：标题走备注优先；没有备注时回落到显示名 / 登录名（两者都没有 = 关系行也丢了 → 「对话」）。
  const title = builtin
    ? teamworkRowName(b)
    : peer && (peer.username || peer.display_name)
      ? b.remark || teamworkRowName(b)
      : '对话';
  const name = $('#teamwork-peer-name');
  if (name) {
    name.textContent = title;
    // ⭐ 0.6.x：内置角色（提醒助手）的标题走**暖色**，与列表行那一条同一个约定
    //    （配色在 `mobile/app.css`，这里只落 class）。
    name.classList.toggle('builtin', builtin);
  }
  // ⚠️ 内置角色没有「好友管理」可做（不能删好友 / 不能改备注 / 不能拉黑）——
  //    那颗「⋯」必须收起来：留着它点开只会是一屏点了必然 404 的按钮。
  const manage = $('#teamwork-screen-thread [data-act="teamwork-peer-manage"]');
  if (manage) manage.classList.toggle('hidden', builtin);
  const sub = $('#teamwork-peer-sub');
  if (sub) {
    const bits = [];
    // ⚠️ 这一行**不重复名字**：0.6.x 起名字可以自己改，标题写着「小爪」而副标题还写死「提醒助手」
    //    就是自相矛盾的文案 —— 名字只由标题那一处给（它取的是服务端的 `builtin_name`）。
    // ⭐ 0.7.7：内置角色现在**会回一句**（服务端自动回复「请与 AI 助手对话」）⇒ 这句必须跟着改。
    //    ⚠️ 与电脑版 `syncTeamworkComposer()` 的 placeholder **逐字一致**。
    if (builtin) bits.push('这里只发提醒；想聊天请到「AI 助手」');
    if (peer && peer.username) bits.push('@' + peer.username);
    if (b.blocked) bits.push('已拉黑');
    sub.textContent = bits.join(' · ');
  }

  if (state.teamworkError) {
    box.innerHTML = teamworkErrHtml(state.teamworkError);
    return;
  }
  const list = state.teamworkMessages || [];
  if (!list.length) {
    // ⚠️ 「正在取第一页」与「这个会话真的还没有消息」要分开：把加载中画成「还没有消息，
    //    说第一句话吧」，用户会真的以为历史空了 —— 而它只是还没回来。
    if (!state.teamworkLoaded) {
      box.innerHTML = skeletonHtml(4);
      teamworkStick = false;
      return;
    }
    // ⭐ 0.6.x：内置角色的空态要说清「它靠什么出声」—— 用户第一次点进来时它必然是空的
    //    （提醒要等到那个时刻才发），不说清楚就只剩一句让人以为坏了的「还没有消息」。
    //    ⚠️ 标题里的名字**取我自己起的那个**（`title`），不写死「提醒助手」；`emptyHtml` 内部会转义。
    box.innerHTML = builtin
      ? emptyHtml(
          '🔔',
          `${title}还没有发过消息`,
          '上课提醒、任务到期提醒与每天的逾期汇总都会发到这里 —— 可以在这一屏的「对话设置」里改时刻。',
        )
      : emptyHtml('👋', '还没有消息', '在下面输入框里说第一句话吧。' + TEAMWORK_PRIVACY);
    teamworkStick = false;
    return;
  }
  const meId = Number((state.me && state.me.id) || 0);
  const more = state.teamworkHasMore
    ? `<button class="teamwork-more" type="button" data-act="teamwork-more">↑ 看更早的消息</button>`
    : `<div class="teamwork-more-none">没有更早的消息了</div>`;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = more + list.map((m) => teamworkMsgHtml(m, meId)).join('');
  if (teamworkStick || near) box.scrollTop = box.scrollHeight;
  teamworkStick = false;
}

/**
 * 功能：画一条消息气泡。
 *
 * ⚠️ **发送者字段有两个名字，这里必须两个都认**（0.3.5 修的真实缺陷）：
 *    REST 返回的是库里的列名 `user_id`（`teamwork_messages` 表），而 SSE 事件体
 *    （本模块 `routes.js` 的 `pushMessage()`）与本地发送的那条用的是 `senderId`。
 *    只认一个的后果不是报错，而是 `Number(undefined) = NaN` ⇒ 与自己的 id 比较恒为 false ⇒
 *    **自己发的消息显示在左边（成了对方的消息）**，直到走一次 REST 取数才自己好 ——
 *    表现就是「有几率我的消息跑到对方那边，刷新一下又好了」，前端不报任何错。
 *
 * @param {Object} m - 消息行（`{ id, senderId | user_id, body, createdAt | created_at }`）
 * @param {number} meId - 当前账号 id（决定靠左还是靠右）
 * @returns {string} 气泡的 HTML 片段
 */
function teamworkMsgHtml(m, meId) {
  const o = m || {};
  const sender = o.senderId !== undefined ? o.senderId : o.userId !== undefined ? o.userId : o.user_id;
  // ⭐ 0.6.x：内置角色（提醒助手）发的消息**不是「我发的」** —— 它的 `user_id` 恰好是收件人自己
  //    （见 `teamwork_messages` 的建表说明），只看发送者会把它画成「我自己说的话」（靠右、同色）。
  //    ⚠️ REST 的 `sender_builtin` 与 SSE 的 `senderBuiltin` 两个名字都要认（与 sender / created_at 同坑）。
  const fromBuiltin = o.senderBuiltin !== undefined ? o.senderBuiltin : o.sender_builtin;
  const mine = Number(sender) === meId && !fromBuiltin;
  // ⭐ 0.6.x：助手说的话再带一层 `builtin` —— 气泡走暖色，一屏里「我说的 / 真人说的 /
  //    助手说的」三种气泡各有各的样子（配色在 `mobile/app.css`，与电脑版同一个类名）。
  const bl = fromBuiltin ? ' builtin' : '';
  // ⭐ 0.6.4（任务联动）：卡片消息 → 一张**任务卡片**替掉气泡（渲染在 `shared.js`，两端一份）。
  //    ⚠️ 卡片不是活的：画的全是发送那一刻的快照；`body` 是渲染端不认这个 `kind` 时
  //    的降级文本（服务端强制必填），所以卡片替掉气泡时它不显示，但也没有丢。
  // ⭐ 0.7.7：四种系统提醒各画一种卡片（渲染在 `shared.js`，两端一份）；
  //    认不出 kind（含老消息的 NULL）⇒ 退回普通气泡（有意的降级，`body` 本来就是降级文本）。
  const inner = isCardMsg(o)
    ? taskCardHtml(o)
    : isRemindMsg(o)
      ? remindCardHtml(o)
      : isImageMsg(o)
        ? // ⭐ 0.8.54：图片消息 —— 圆角缩略图（点开看大图走 `openSheet()`，见 `bindTeamworkPlus()`）
          imageMsgHtml(o, state.teamworkId)
        : `<div class="teamwork-bubble">${esc(o.body)}</div>`;
  // ⚠️ 正文是**别人写的内容**：esc() 之后还要让换行生效（CSS 的 white-space: pre-wrap），
  //    绝不能为了让换行好看而改用 innerHTML 拼接。
  // ⭐ 0.4.4：气泡带 `data-teamwork-msg="<id>"`（长按识别点的是哪一条）。
  //    ⚠️ **正文不进属性** —— 菜单要正文时按 id 回 `state.teamworkMessages` 里取（见 `findMessage()`）。
  // ⚠️ 时间走 `msgStamp()`（REST 的 `created_at` 与 SSE 的 `createdAt` 两个都认），
  //    只认一个的后果是历史消息的 `.teamwork-time` 恒为空、且不报错。
  // ⭐ 0.7.7：卡片消息在**外层**消息行上再加一个 `is-card` —— 卡片的宽度统一在那一层定
  //    （`width: min(78%, 560px)`，见 `mobile/app.css` 的 `.teamwork-msg.is-card`）。
  //    ⚠️ 判据走 `shared.js` 的 `isAnyCardMsg()`（任务卡片 + 四种提醒的并集），⛔ 不另写一份；
  //    ⚠️ 两个类本体上定宽会**连带改坏发送前的预览弹窗**（那时外面没有 `.teamwork-msg` 这一层）。
  const card = isAnyCardMsg(o);
  return `<div class="teamwork-msg${mine ? ' mine' : ''}${bl}${card ? ' is-card' : ''}" data-teamwork-msg="${Number(o.id)}">
    ${inner}
    <div class="teamwork-time">${esc(teamworkTime(msgStamp(o)))}</div>
    ${teamworkMsgTasksHtml(o)}
  </div>`;
}

/**
 * 功能：画一条消息下面那几枚「已添加到任务」标记（0.4.4）—— ⭐ 点一下跳到那条任务。
 *
 * 说明：⭐ 标记来自 `state.teamworkMsgTasks`（服务端 `teamworkMessages()` 按**我自己的任务**反查出来的，
 *      对方的界面上永远没有这一块 —— 见 `modules/tasks/schema.js` 的文件头）。
 *      一条消息可以对应多条任务（同一句话分别落进两个项目），所以这里是循环。
 *      ⚠️ 跳转由 `app.js` 的 `teamwork-task` 分支做（切标签 + 打开任务详情是导航的事，
 *      而导航的家在入口那一层）；这里只负责带上 `scope` 与 `id`。
 *      ⚠️ 标题是**我自己写的任务标题**（用户内容）⇒ 一律 `esc()`；进 `data-*` 的只有
 *      「'daily' / 数字」两种形态，不含用户内容。
 *
 * @param {Object} m - 消息行
 * @returns {string} 标记区的 HTML 片段（没有任务时是空串）
 */
function teamworkMsgTasksHtml(m) {
  const list = (state.teamworkMsgTasks || {})[Number(m.id)] || [];
  if (!list.length) return '';
  return (
    `<div class="teamwork-msg-tasks">` +
    list
      .map((t) => {
        // ⭐ 0.5.2：标记上写清**做完没有**（未完成红色、完成灰色划掉）
        const done = t.status === 'done';
        return (
          `<button class="teamwork-task-chip ${done ? 'done' : 'todo'}" type="button" data-act="teamwork-task" data-id="${Number(
            t.id,
          )}" ` +
          // ⚠️ `scope` 只可能是 `'daily'` 或数字，**刻意不写 `esc()`**（与电脑版同一条规矩：
          //    `data-*` 里不许出现用户内容；`teamwork.test.js` 有机械断言钉住这一点）。
          `data-scope="${String(t.scope) === 'daily' ? 'daily' : Number(t.scope)}">` +
          `📋 已添加到任务 · ${esc(t.title || '未命名')}</button>`
        );
      })
      .join('') +
    `</div>`
  );
}

/**
 * 功能：把一条消息摘要压成**会话列表里那一行**能放的形状 —— ⭐ 0.6.x：内置角色的只取第一行。
 *
 * 说明：⚠️ 提醒助手的消息是**多行**的（上课提醒含教室与两条备注），整段塞进一行小字会被挤成一团。
 *      活人的消息通常是单行，所以只对内置角色生效 —— 不改变原有的显示习惯。
 *      与电脑版 `desktop.js` 的 `teamworkPreview()` 是同一口径（两端看起来必须是一回事）。
 *
 * @param {Object} c - 会话行
 * @returns {string} 预览文案（未转义；由调用方 `esc()`）
 */
function teamworkPreview(c) {
  const body = c && c.last_body ? String(c.last_body) : '';
  if (!body) return c && c.builtin_key ? '还没有提醒' : '还没有消息，点进去说第一句';
  const text = c.builtin_key ? body.split('\n')[0] : body;
  return `${c.last_mine ? '我：' : ''}${text}`;
}

/**
 * 功能：画一条会话行 —— 对方名字、最后一条摘要（我发的加「我：」前缀）、未读红点。
 * 说明：⭐ 0.4.4 起名字走 `teamworkRowName(c)`（**我起的备注优先**），与电脑版同一个口径。
 *      ⭐ 0.6.x：内置角色会话（提醒助手）走**另一条打开路径** —— 它没有「好友」，
 *      而 `teamwork-open` 的入口参数是 `friendId`（服务端会拿它去查好友关系）。所以那一行用
 *      `teamwork-open-conv` + **会话 id**，见 `openTeamworkConv()`。
 * @param {Object} c - 会话行（含 `id` / `peer_user` / `peer_remark` / `last_body` / `last_mine` / `unread`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkConvRow(c) {
  const unread = Number(c.unread) || 0;
  const name = teamworkRowName(c);
  const body = teamworkPreview(c);
  // ⚠️ `data-id` 的取值必须与 `data-act` 配套：内置角色传**会话 id**，其余传对方账号 id
  const act = c.builtin_key ? 'teamwork-open-conv' : 'teamwork-open';
  const id = c.builtin_key ? Number(c.id) : esc((c.peer_user || {}).id);
  // ⭐ 0.6.x：内置角色（提醒助手）整行带 `builtin` —— 头像与名字走**暖色**，在会话列表里
  //    一眼就能和真人区分开（「颜色要不一样」）。配色在 `mobile/app.css`，
  //    这里只落 class（与电脑版同一个类名，两端样式各自写）。
  const bl = c.builtin_key ? ' builtin' : '';
  return `<button class="teamwork-row${bl}" type="button" data-act="${act}" data-id="${id}">
    <span class="teamwork-ava${bl}">${esc(name.slice(0, 1))}</span>
    <span class="teamwork-row-main">
      <span class="teamwork-row-top"><b>${esc(name)}</b><i>${esc(teamworkTime(c.last_created_at || c.updated_at))}</i></span>
      <small>${esc(body)}</small>
    </span>
    ${unread ? `<span class="teamwork-dot">${unread > 99 ? '99+' : unread}</span>` : ''}
  </button>`;
}

/**
 * 功能：画一条**插槽会话条目** —— 与真会话行（`teamworkConvRow()`）同一套类名与结构，
 *      数据来自条目本身；整行带 `builtin`（与提醒助手同一条约定：不是真人的会话走暖色）。
 * @param {Object} it - 条目（`{ key, icon, name, sub }`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkSlotRow(it) {
  return `<button class="teamwork-row builtin" type="button" data-act="teamwork-slot-open" data-key="${esc(String(it.key))}">
    <span class="teamwork-ava builtin">${esc(it.icon || '🤖')}</span>
    <span class="teamwork-row-main">
      <span class="teamwork-row-top"><b>${esc(it.name || String(it.key))}</b><i>助手</i></span>
      <small>${esc(it.sub || '')}</small>
    </span>
  </button>`;
}

/**
 * 功能：画第三组「协作项目」组内**恒为第一行**的那一条 ——「＋ 添加共享项目」。
 *
 * 说明：⭐ 点它不由本模块处理：派 `zx:teamwork-collab-add` 让 tasks 的 page 片段去开它的弹层
 *      （本模块不认识那个弹层 ——）。所以这一行**不带 `data-act`**，只带
 *      `data-teamwork-collab-add`（本模块自己的点击委托认它，⛔ 不往宿主动作表加键）。
 *
 * @returns {string} 该行的 HTML 片段
 */
function teamworkCollabAddRow() {
  return (
    '<button class="teamwork-row" type="button" data-teamwork-collab-add>' +
    '<span class="teamwork-ava">＋</span>' +
    '<span class="teamwork-row-main">' +
    '<span class="teamwork-row-top"><b>添加共享项目</b></span>' +
    '<small>拉上好友一起做</small>' +
    '</span></button>'
  );
}

/**
 * 功能：画一条**协作项目行** —— 与真会话行（`teamworkConvRow()`）同一套类名与结构，
 *      只是数据来自条目本身（头像用统一的文件夹图标、没有未读数与时间）。
 *      ⭐ 点它 ⇒ 进**第二屏**显示协作看板（本模块自己的点击委托认 `data-teamwork-collab`，
 *      见 `renderCollabBoard()`）。
 *      ⭐⭐ 0.8.53（团队协作的项目中也要有 + 图标可以新建任务）：行尾多一颗 `＋`。
 *      ⚠️ 整行从 `<button>` 拆成 `<div>` + 两个按钮 —— 照好友行 0.7.6 的教训：
 *      一行里不能再套按钮，拆成**并排的兄弟**，点击委托就不会「点 ＋ 变成打开项目」。
 *
 * @param {Object} it - 条目（`{ key, name, sub }`，`key` ＝ 项目 id 字符串）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkCollabRow(it) {
  // ⚠️ 键先 esc 落到局部变量再拼（与 `teamworkSlotRow()` 同一条口径）
  const key = esc(String(it.key));
  return (
    '<div class="teamwork-row">' +
    '<span class="teamwork-ava">📁</span>' +
    '<button class="teamwork-row-main" type="button" data-teamwork-collab="' + key + '">' +
    '<span class="teamwork-row-top"><b>' + esc(it.name || String(it.key)) + '</b></span>' +
    '<small>' + esc(it.sub || '') + '</small>' +
    '</button>' +
    '<button class="teamwork-row-plus" type="button" data-teamwork-collab-new="' + key + '"' +
    ' aria-label="在这个项目里新建任务" title="新建任务">＋</button>' +
    '</div>'
  );
}

/**
 * 功能：画一条「还没有会话」的好友行。
 * @param {Object} f - 好友关系行（含 `friend_id` / `user` / `remark` / `unread`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkFriendRow(f) {
  const unread = Number(f.unread) || 0;
  const name = teamworkRowName(f);
  const fid = esc(f.friend_id);
  // ⚠️⭐ 0.7.6：整行从 `<button>` 改成 `<div>` + 三个子控件（名字是按钮、右侧两颗动作按钮）——
  //    一行里不能再套按钮（HTML 不允许），而且 `data-act` 靠 `closest()` 认最近的祖先，
  //    拆成**并排的兄弟**就不给它出错的机会（本项目记过「先判整行 ⇒ 点删好友变成开会话」）。
  return `<div class="teamwork-row">
    <span class="teamwork-ava">${esc(name.slice(0, 1))}</span>
    <button class="teamwork-row-main" type="button" data-act="teamwork-open" data-id="${fid}">
      <span class="teamwork-row-top"><b>${esc(name)}</b><i>好友</i></span>
      <small>点一下开始聊</small>
    </button>
    ${unread ? `<span class="teamwork-dot">${unread}</span>` : ''}
    <button class="m-mini" type="button" data-act="teamwork-block-go" data-id="${fid}">拉黑</button>
    <button class="m-mini danger" type="button" data-act="teamwork-del" data-id="${fid}">删好友</button>
  </div>`;
}

/**
 * 功能：画一条「待我处理」的申请行 —— 同意 / 拒绝两个按钮。
 *
 * 说明：⚠️ 按钮在行**里面**，而事件委托用 `closest()` 会先命中按钮本身，
 *      所以这两个按钮各自带 `data-act`、不冒泡成「打开这一行」——
 *      这正是 AGENTS §八 记的坑（先判里面的按钮、再判整行）。
 * @param {Object} f - 关系行（含 `friend_id` / `user`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkIncomingRow(f) {
  const peer = f.user || {};
  return `<div class="teamwork-row static">
    <span class="teamwork-ava">${esc(teamworkName(peer).slice(0, 1))}</span>
    <span class="teamwork-row-main">
      <span class="teamwork-row-top"><b>${esc(teamworkName(peer))}</b><i>想加你</i></span>
      <small>${esc(peer.username ? '@' + peer.username : '')}</small>
    </span>
    <button class="m-mini" type="button" data-act="teamwork-accept" data-id="${esc(f.friend_id)}">同意</button>
    <button class="m-mini danger" type="button" data-act="teamwork-reject" data-id="${esc(f.friend_id)}">拒绝</button>
  </div>`;
}

/**
 * 功能：画一条「我发出的」申请行（只给一句状态说明，不给按钮）。
 * @param {Object} f - 关系行（含 `friend_id` / `user`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkOutgoingRow(f) {
  const peer = f.user || {};
  return `<div class="teamwork-row static">
    <span class="teamwork-ava">${esc(teamworkName(peer).slice(0, 1))}</span>
    <span class="teamwork-row-main">
      <span class="teamwork-row-top"><b>${esc(teamworkName(peer))}</b><i>等待对方处理</i></span>
      <small>对方同意之后你们就是好友了</small>
    </span>
  </div>`;
}

/**
 * 功能：画一条已拉黑的行 —— 可以就地取消拉黑。
 * @param {Object} f - 关系行（含 `friend_id` / `user`）
 * @returns {string} 该行的 HTML 片段
 */
function teamworkBlockedRow(f) {
  const peer = f.user || {};
  return `<div class="teamwork-row static">
    <span class="teamwork-ava">${esc(teamworkName(peer).slice(0, 1))}</span>
    <span class="teamwork-row-main">
      <span class="teamwork-row-top"><b>${esc(teamworkName(peer))}</b><i>已拉黑</i></span>
      <small>对方不能再给你发好友申请</small>
    </span>
    <button class="m-mini" type="button" data-act="teamwork-unblock" data-id="${esc(f.friend_id)}">取消拉黑</button>
  </div>`;
}

// ---------- 关系弹层：好友 / 申请（0.7.6，从内联区改成两颗按钮） ----------
/**
 * 当前打开的**关系弹层**是哪一个（`'friends'` / `'reqs'` / `null`）。
 *
 * 说明：⭐ 与电脑版的 `teamworkModalKind` 同一个用途 —— 弹层里做了个动作（同意 / 拉黑 / 删好友…）之后，
 *      把它重画成最新数据，否则会盯着一个「刚同意过、却还写着等处理」的旧列表。
 *      ⚠️ 弹层关闭时不必清：重画只发生在「弹层内的操作成功之后」这条路径上，悬空的值没人读。
 * @type {?('friends'|'reqs')}
 */
let teamworkSheetKind = null;

/** 关系弹层底部那颗「关闭」按钮（`data-act="sheet-close"` 是宿主认的动作） @type {string} */
const SHEET_CLOSE_BTN =
  '<button class="btn ghost" type="button" data-act="sheet-close" style="flex:1">关闭</button>';

/**
 * 功能：画**列表页顶部**那两颗入口按钮（好友 / 申请）—— ⭐ 0.7.6 起好友与申请不再内联成一整块，
 *      各自缩成一颗按钮，点开是底部弹层（与电脑端同一个形态与理由）。
 *
 * 说明：⚠️ 数字与红点**当场算**（列表页每次重画都跑这一遍），不缓存：
 *      好友 / 申请随时在变，缓存就会出现「按钮说 2、点开只有 1」。
 *      ⚠️ 申请按钮上的红点只在**有待处理**时出现（复用 `.teamwork-dot`，与电脑端一致）。
 *
 * @param {number} nFriends - 好友数
 * @param {number} nIn - 我收到的待处理申请数
 * @param {number} nOut - 我发出的申请数
 * @returns {string} 该行 HTML
 */
function teamworkActsHtml(nFriends, nIn, nOut) {
  return `<div class="teamwork-acts">
    <button class="teamwork-act" type="button" data-act="teamwork-friends-open">
      <span class="teamwork-act-t">好友</span><span class="teamwork-act-n">${nFriends ? nFriends : '还没有'}</span>
    </button>
    <button class="teamwork-act" type="button" data-act="teamwork-req-open">
      <span class="teamwork-act-t">申请</span><span class="teamwork-act-n">收到 ${nIn} · 发出 ${nOut}</span>
      ${nIn ? `<span class="teamwork-dot">${nIn}</span>` : ''}
    </button>
  </div>`;
}

/**
 * 功能：画**好友弹层**的正文 —— 全部好友，每行「名字（点了开会话）+ 拉黑 + 删好友」。
 * @returns {string} 弹层正文 HTML
 */
function teamworkFriendsListHtml() {
  const fs = (state.teamworkFriends || []).filter((f) => Number.isFinite(Number(f.friend_id)));
  const rows = fs.length
    ? fs.map(teamworkFriendRow).join('')
    : '<div class="m-tip">还没有好友 —— 点右上角「＋ 加好友」，填对方给你的登录名。</div>';
  return `<div class="teamwork-rows">${rows}</div>`;
}

/**
 * 功能：画**申请弹层**的正文 —— 收到（可同意 / 拒绝）/ 发出（只能等）/ 已拉黑（可取消）三段。
 * @returns {string} 弹层正文 HTML
 */
function teamworkRequestsListHtml() {
  const inc = (state.teamworkIncoming || []).filter((f) => Number.isFinite(Number(f.friend_id)));
  const out = (state.teamworkOutgoing || []).filter((f) => Number.isFinite(Number(f.friend_id)));
  const blk = (state.teamworkBlocked || []).filter((f) => Number.isFinite(Number(f.friend_id)));
  const parts = [];
  if (!inc.length && !out.length && !blk.length) {
    parts.push('<div class="m-tip">暂时没有待处理的申请。</div>');
  }
  if (inc.length) {
    parts.push('<div class="teamwork-m-sub">收到</div>');
    parts.push(`<div class="teamwork-rows">${inc.map(teamworkIncomingRow).join('')}</div>`);
  }
  if (out.length) {
    parts.push('<div class="teamwork-m-sub">发出</div>');
    parts.push(`<div class="teamwork-rows">${out.map(teamworkOutgoingRow).join('')}</div>`);
  }
  if (blk.length) {
    parts.push('<div class="teamwork-m-sub">已拉黑</div>');
    parts.push(`<div class="teamwork-rows">${blk.map(teamworkBlockedRow).join('')}</div>`);
  }
  return parts.join('');
}

/**
 * 功能：打开「好友」弹层 —— 列出全部好友，行上「拉黑 / 删好友」。
 * @returns {void}
 */
export function teamworkFriendsSheet() {
  teamworkSheetKind = 'friends';
  openSheet('好友', teamworkFriendsListHtml(), SHEET_CLOSE_BTN);
}

/**
 * 功能：打开「申请」弹层 —— 收到 / 发出 / 已拉黑三段，收到的带「同意 / 拒绝」。
 * @returns {void}
 */
export function teamworkRequestsSheet() {
  teamworkSheetKind = 'reqs';
  openSheet('申请', teamworkRequestsListHtml(), SHEET_CLOSE_BTN);
}

/**
 * 功能：把当前打开的关系弹层重画成最新数据（弹层内任一操作成功之后调）。
 * @returns {void}
 */
function repaintTeamworkSheet() {
  if (teamworkSheetKind === 'friends') teamworkFriendsSheet();
  else if (teamworkSheetKind === 'reqs') teamworkRequestsSheet();
}

// ---------- 关系：加好友 / 同意 / 拒绝 / 删除 / 拉黑 ----------

/**
 * 功能：提交好友申请 —— 读列表页那个**静态**输入框（`#teamwork-add-name`），成功 / 失败都给一句人话。
 *
 * 说明：⭐ 输入框刻意留在**列表页页头**而不是底部弹层里（与收藏夹搜索框、硬件搜索框同一条规矩）：
 *      它是 `teamwork-add-friend` 与「回车」两条路径共读的节点，动态建就多一份「节点可能不在」的风险 ——
 *      那正是 0.3.3 的 `#hw-count` 事故形态。可见性上也更好：加好友是个低频动作，
 *      不该让人先想到「要点右上角那个按钮」。
 *      ⚠️ 节点取不到时**不抛错**，只提示一句 —— 手机版骨架与代码不同步的代价是整屏「读取失败」。
 *      ⚠️ 服务端对「已经是好友」「已经申请过」都是**幂等**的（返回 `status`），
 *      所以这里按 `status` 说一句对应的话，而不是把所有情况都说成「已发送申请」。
 *
 * @returns {Promise.<void>}
 */
export async function teamworkAddFriend() {
  const input = $('#teamwork-add-name');
  if (!input) return toast('页面骨架不对：找不到输入框，请刷新后重试', true);
  const name = String(input.value || '').trim();
  if (!name) return toast('请先填对方的登录名', true);
  try {
    const r = await api('POST', '/api/teamwork/friends', { username: name });
    input.value = '';
    input.blur();
    await loadTeamwork();
    toast(r && r.status === 'accepted' ? '你们已经是好友了' : '申请已发出，等对方同意');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：同意 / 拒绝一条好友申请。
 *
 * 说明：同意用不弹确认（它的结果是「多一个好友」，随时可删）；
 *      拒绝也不弹（只是谢绝这次申请，对方还能再发一次）——但**结果要说清楚**。
 * @param {string} act - `'teamwork-accept'` 或 `'teamwork-reject'`
 * @param {number} friendId - 对方账号 id
 * @returns {Promise.<void>}
 */
export async function teamworkConfirm(act, friendId) {
  const yes = act === 'teamwork-accept';
  try {
    await api('POST', `/api/teamwork/friends/${Number(friendId)}/${yes ? 'accept' : 'reject'}`);
    await loadTeamwork();
    // ⭐ 0.7.6：这个动作只可能从「申请」弹层里发起（列表页那一区已经不存在了）⇒
    //   把弹层重画成最新列表，否则会盯着一条「刚同意过、却还写着等处理」的旧行。
    repaintTeamworkSheet();
    toast(yes ? '已同意，现在可以开始聊天了' : '已拒绝这条申请');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：按对方账号 id 找出对应的关系行 / 账号 —— 好友、已拉黑、当前对话页这三处都要看。
 *
 * 说明：⭐ 三处都写一遍的话一定会漏：**拉黑之后对方就不在 `teamworkFriends` 里了**
 *      （服务端按 `status` 分组，blocked 单独一块），只看好友列表会让确认框写出
 *      「拉黑「?」？」这种文案。列表页与对话页的入口本来就在不同的清单上。
 *
 * @param {number} fid - 对方账号 id
 * @returns {{ friend_id: number, blocked: boolean, user: ?Object, remark: string, name: string }} 归一后的关系信息
 */
function teamworkPeerInfo(fid) {
  const id = Number(fid);
  const row =
    (state.teamworkFriends || []).find((f) => Number(f.friend_id) === id) ||
    (state.teamworkBlocked || []).find((f) => Number(f.friend_id) === id) ||
    (state.teamworkIncoming || []).find((f) => Number(f.friend_id) === id) ||
    (state.teamworkOutgoing || []).find((f) => Number(f.friend_id) === id) ||
    null;
  const buddy = Number((state.teamworkBuddy || {}).friend_id) === id ? state.teamworkBuddy : null;
  const user = (row && row.user) || (buddy && buddy.user) || state.teamworkPeer || null;
  return {
    friend_id: id,
    blocked: !!(row && row.blocked) || !!(buddy && buddy.blocked),
    user,
    // ⭐ 0.4.4：我给他起的备注（只有我这一份）。⚠️ `name` 仍是**真名** ——
    // 「删除好友 / 拉黑」这类不可逆动作的确认框里要显示对方真正的身份，不能显示我随口起的绰号。
    remark: (row && row.remark) || (buddy && buddy.remark) || '',
    name: teamworkName(user),
  };
}

/**
 * 功能：对话页「⋯」菜单 —— 对**当前这段关系**能做的那几件事（改备注 / 拉黑 / 取消拉黑、删除好友）。
 *
 * 说明：⭐ 关系的管理入口放在对话页而不是列表页：用户想到「删掉这个人」的时机，
 *      十有八九就是正看着他这一屏的时候。列表页只保留「同意 / 拒绝 / 取消拉黑」这类
 *      不需要先点进去的动作。
 *      ⭐ 0.4.4 加了「✎ 修改备注」：电脑版那个入口是右键好友行 + 对话标题旁的按钮，
 *      手机上「⋯」就是关系菜单的家（没有右键），所以加在这里而不是新开一个入口。
 *
 * ⭐ 0.5.5（「手机端 ui 优化：修改备注、好友、删除好友这些的按键」）：
 *    三行菜单改成**图标 + 标题 + 次要说明**的两栏结构，并去掉行内 `style` ——
 *    ⚠️ 手机端 `app.css` 里**根本没有 `.btn` 基础样式**（电脑端有、`login.css` 有），
 *    所以这三颗以前只拿到 `.teamwork-menulist .btn{width:100%}` 一条规则，其余全靠
 *    **浏览器默认按钮**在渲染。样式与 `.mn-*` 那几栏一起写在 `mobile/app.css`。
 *
 * @returns {void}
 */
export function teamworkPeerSheet() {
  const fid = Number((state.teamworkBuddy || {}).friend_id);
  if (!fid) return;
  // ⚠️⭐ 0.7.6：这一层是「对话页 ⋯ 菜单」，与列表页那两个关系弹层**互斥** ⇒ 打开它就清掉
  //    `teamworkSheetKind`，否则从对话页拉黑一个人之后会莫名其妙弹回「好友」列表层
  //    （那边也会重画一次，盖在用户当前这一屏上）。
  teamworkSheetKind = null;
  const { name, remark, blocked } = teamworkPeerInfo(fid);
  openSheet(
    '「' + name + '」',
    `<div class="teamwork-menulist">
       <button class="btn" type="button" data-act="teamwork-remark" data-id="${fid}">
         <span class="mn-ico" aria-hidden="true">✎</span>
         <span class="mn-main"><span class="mn-t">修改备注</span>${
           remark ? `<span class="mn-v">现在是「${esc(remark)}」</span>` : ''
         }</span>
       </button>
       <button class="btn" type="button" data-act="${blocked ? 'teamwork-unblock' : 'teamwork-block'}" data-id="${fid}">
         <span class="mn-ico" aria-hidden="true">${blocked ? '↩' : '🚫'}</span>
         <span class="mn-main"><span class="mn-t">${blocked ? '取消拉黑' : '拉黑'}</span><span class="mn-v">${
           blocked ? '恢复接收对方的消息与申请' : '不再收到对方的消息与申请'
         }</span></span>
       </button>
       <button class="btn danger" type="button" data-act="teamwork-del" data-id="${fid}">
         <span class="mn-ico" aria-hidden="true">🗑</span>
         <span class="mn-main"><span class="mn-t">删除好友</span><span class="mn-v">消息一条都没删，重新加回好友就原样回来</span></span>
       </button>
     </div>`,
    `<button class="btn ghost" type="button" data-act="sheet-close" style="flex:1">关闭</button>`,
  );
}

/**
 * 功能：改「我给这位好友起的备注」的底部弹层（0.4.4）—— 留空 = 取消备注。
 *
 * 说明：⭐ 文案必须说清「只有你自己看得见」：这是用户唯一的疑问 ——「改了会不会被他发现」。
 * @param {number} friendId - 对方账号 id
 * @returns {void}
 */
export function teamworkRemarkSheet(friendId) {
  const fid = Number(friendId);
  if (!fid) return;
  const { name, remark } = teamworkPeerInfo(fid);
  openSheet(
    '修改备注',
    `<div class="field"><label>备注（只有你自己看得见）</label>
       <input type="text" id="teamwork-remark-input" maxlength="50" value="${esc(remark)}" placeholder="例如：张工（研发）" /></div>
     <div class="m-tip">⭐ 备注只写在你自己的账号里 —— <b>对方那边一切照旧</b>：他看不到你给他起的名字，
       消息与会话也不受任何影响。它只是把你列表里的名字换成一个你更好认的称呼。</div>
     <div class="m-tip">留空 = 取消备注，名字回到「${esc(name)}」。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="teamwork-remark-save" data-id="${fid}">保存</button>`,
  );
  const inp = $('#teamwork-remark-input');
  if (inp) inp.focus();
}

/**
 * 功能：保存好友备注 —— 成功后重拉一次好友总览（服务端的 `remark` 才是真值），再提示一句。
 * @param {number} friendId - 对方账号 id
 * @returns {Promise.<void>}
 */
export async function teamworkRemarkSave(friendId) {
  const fid = Number(friendId);
  if (!fid) return;
  const inp = $('#teamwork-remark-input');
  const remark = inp ? String(inp.value || '').trim() : '';
  try {
    await api('POST', `/api/teamwork/friends/${fid}/remark`, { remark });
    closeSheet();
    await loadTeamwork();
    toast(remark ? '备注已保存' : '已取消备注');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：删除好友确认。
 *
 * 说明：⭐ 这段文案是本文件里**最要紧的一段**：用户真正怕的是「我的聊天记录没了」。
 *      所以必须一次说清三件事 —— 旧会话读不到了、**消息一条都没删**、重新加回好友就原样回来。
 *      ⚠️ 「旧会话读不到」是服务端的规则（`teamworkConversationOr404()` 里一对一还要再看好友关系），
 *      不是前端藏起来的：别以为改这里就能绕过。
 * @param {number} friendId - 对方账号 id
 * @returns {void}
 */
export function teamworkDelSheet(friendId) {
  const fid = Number(friendId);
  const { name } = teamworkPeerInfo(fid);
  openSheet(
    '删除好友',
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">
       确定删除「${esc(name)}」吗？</p>
     <div class="m-tip warn">删除之后：<b>旧的会话打不开了</b>（他会从你的好友与会话列表里消失）。</div>
     <div class="m-tip">但是 —— <b>消息一条都没删</b>，都还在你自己的 NAS 上。
       以后你们重新加回好友，这段历史原样回来。</div>`,
    `<button class="btn danger" type="button" data-act="teamwork-del-go" data-id="${fid}" style="flex:1.4">删除好友</button>
     <button class="btn ghost" type="button" data-act="sheet-close">取消</button>`,
  );
}

/**
 * 功能：确认删除好友（由 `app.js` 的 `teamwork-del-go` 分支调用）。
 * @param {number} friendId - 对方账号 id
 * @returns {Promise.<void>}
 */
export async function teamworkDelGo(friendId) {
  try {
    await api('DELETE', '/api/teamwork/friends/' + Number(friendId));
    closeSheet();
    await loadTeamwork();
    // ⭐ 0.7.6：从好友弹层里删的 ⇒ 把弹层重画成最新列表（否则刚删掉的那个人还站在里面）
    repaintTeamworkSheet();
    toast('已删除好友。消息没有删，重新加回好友就能看回来');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：拉黑 / 取消拉黑 —— 拉黑**先问一句**（它是一个会挡住对方的动作）。
 *
 * 说明：⭐ 拉黑是**单向动作、双向生效**：任一方拉黑过就不再接受新的好友申请，
 *      想再联系必须先取消拉黑（服务端 `teamworkRequestFriend()` 里那条判断）。
 *      这句话必须写进确认框，否则用户会以为「拉黑只是我这边看不见他」。
 * @param {number} friendId - 对方账号 id
 * @param {boolean} blocked - 目标状态：true = 拉黑，false = 取消拉黑
 * @returns {Promise.<void>}
 */
export async function teamworkBlock(friendId, blocked) {
  const fid = Number(friendId);
  if (!blocked) {
    // 取消拉黑：结果是把对方放回来，不必再弹一层
    try {
      await api('POST', `/api/teamwork/friends/${fid}/block`, { blocked: false });
      await loadTeamwork();
      // ⭐ 0.7.6：从「申请」弹层的「已拉黑」段取消拉黑 ⇒ 那一行要跟着消失
      repaintTeamworkSheet();
      toast('已取消拉黑');
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  const { name } = teamworkPeerInfo(fid);
  const ok = await askConfirm({
    title: '拉黑「' + name + '」？',
    text: '拉黑之后，对方不能再给你发好友申请，你也不会再收到他的消息（旧会话同样打不开，消息一条都没删）。想恢复要先取消拉黑。',
    ok: '拉黑',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', `/api/teamwork/friends/${fid}/block`, { blocked: true });
    await loadTeamwork();
    // ⭐ 0.7.6：从好友弹层里拉黑的 ⇒ 那个人要从「好友」列表里消失（转进「申请 → 已拉黑」）
    repaintTeamworkSheet();
    toast('已拉黑');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：发一条消息（由 `app.js` 的 `teamwork-send` 分支调用）。
 *
 * 说明：⚠️ 发送**不清空输入框直到成功**：失败（429 太频繁 / 404 已不是好友 / 网络断了）时
 *      用户打的一整段话不能说没就没 —— 那是最让人恼火的一类交互。
 *      成功后立刻把返回的那条并进列表（服务端同时也会推 SSE，靠 id 去重，不会出现两条）。
 * @returns {Promise.<void>}
 */
export async function teamworkSend() {
  const input = $('#teamwork-input');
  if (!input || !state.teamworkId) return;
  const body = String(input.value || '').trim();
  if (!body) return toast('消息不能是空的', true);
  try {
    const r = await api('POST', `/api/teamwork/conversations/${state.teamworkId}/messages`, { body });
    // ⭐ 0.7.7：清空之后把高度一起收回去（自增高留下的高度不收，输入框会一直占着半屏）
    input.value = '';
    autoGrow(input);
    const meId = Number((state.me && state.me.id) || 0);
    state.teamworkMessages = mergeById(state.teamworkMessages, [
      { id: r.id, conversationId: r.conversationId, senderId: meId, body, createdAt: r.createdAt },
    ]);
    teamworkStick = true; // 自己发的消息必须当场看到（渲染完无条件贴底，见 renderTeamworkThread）
    renderTeamworkThread();
    markTeamworkRead();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- ⭐ 0.8.54：输入框左边那颗 ＋（发送图片 / 协作项目任务 / 普通任务） ----------

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
 * 说明：⚠️ 与 `teamworkSend()` 里那几行同一套口径（`mergeById` → 贴底 → 重画 → 标已读），
 *      抽出来只是因为「发卡片」「发图片」两条新路都要它。
 *      ⚠️ `kind` / `meta` 必须一起带：漏了它俩，卡片会**安静地**退回一句降级文本（不报错）。
 * @param {{id: number, conversationId: number, createdAt: string}} r - 服务端返回
 * @param {string} body - 降级文本
 * @param {?string} kind - `task_card` / `image`；纯文本传 null
 * @param {?Object} meta - 结构化载荷（已解析成对象）
 * @returns {void}
 */
function pushSentMessage(r, body, kind, meta) {
  const meId = Number((state.me && state.me.id) || 0);
  state.teamworkMessages = mergeById(state.teamworkMessages, [
    { id: r.id, conversationId: r.conversationId, senderId: meId, body, createdAt: r.createdAt, kind: kind || null, meta: meta || null },
  ]);
  teamworkStick = true; // 自己发的消息必须当场看到
  renderTeamworkThread();
  markTeamworkRead();
}

/**
 * 功能：打开**发送菜单**（⭐ 0.8.54）—— 底部弹层三项：发送图片 / 协作项目任务 / 普通任务。
 * @returns {void}
 */
function teamworkSendMenu() {
  if (!state.teamworkId) return toast('先在左边选一个好友或会话', true);
  const body =
    '<div class="tw-send-menu">' +
    SEND_MENU_ITEMS.map((it) => {
      const inner =
        '<span class="tw-send-ico">' +
        it.icon +
        '</span><span class="tw-send-txt"><b>' +
        esc(it.title) +
        '</b><small>' +
        esc(it.desc) +
        '</small></span>';
      // ⭐⭐ 0.8.54（「手机端点击图片无反应，发不了图片」）：
      //    「发送图片」这一项用 **`<label for>` 原生触发**文件框，⛔ 不再走 JS `input.click()`。
      //    原因：`#teamwork-img-file` 是隐藏的（`display: none`），在飞牛 App 的 WebView 上
      //    对它调 `click()` **不弹选择器、也不报错** —— 表现就是「点了发送图片，什么都没发生」。
      //    `<label for>` 是浏览器自己的激活行为，不受「元素不可见 / 手势已被消费」那套限制；
      //    协作附件的上传入口（`collab-file-add`）从 0.8.12 起一直是这么写的，真机上验过。
      //    ⚠️ 这张 label **不带** `data-act`：带了就会「原生触发一次 ＋ 动作表再跑一次」，
      //    可能弹出两个选择器。
      if (it.act === 'image') {
        return (
          '<label class="tw-send-item" for="teamwork-img-file" role="button" tabindex="0">' + inner + '</label>'
        );
      }
      return '<button class="tw-send-item" type="button" data-act="teamwork-send-' + it.act + '">' + inner + '</button>';
    }).join('') +
    '</div>';
  openSheet('发送', body, '<button class="btn" type="button" data-act="sheet-close">取消</button>');
}

/**
 * 功能：把选中的图片**上传并发出去**（⭐ 0.8.54）—— 二进制走裸 `fetch`，元数据走查询串。
 *
 * 说明：⚠️ 与协作附件上传同一条路：`Content-Type: application/octet-stream`、服务端自己派生 MIME。
 *      ⚠️ 401 要回登录页（裸 `fetch` 绕过了 `api()` 的统一处理）。
 * @param {File} file - 用户选中的图片
 * @returns {Promise.<void>}
 */
async function teamworkUploadImage(file) {
  const cid = Number(state.teamworkId);
  if (!cid || !file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(String(file.type || ''))) {
    return toast('只支持 png / jpg / webp / gif 这几种图片', true);
  }
  if (Number(file.size) > 8 * 1024 * 1024) return toast('图片太大（上限 8 MB）', true);
  try {
    toast('正在发送图片…');
    const url = `${BASE}/api/teamwork/conversations/${cid}/images?name=` + encodeURIComponent(String(file.name || 'image'));
    const r = await fetch(url, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
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
 * 发送任务弹层当前的筛选状态（⭐ 0.8.54）。
 *
 * 说明：⚠️ `groups` 存的是 `fetchSendGroups()` 的**原始结果**（全量，含已完成）——
 *      每次筛选都从它重新算，⛔ 不在过滤结果上再过滤（那样「切回全部」就回不来了）。
 *      弹层关掉不用清：下一次打开由 `teamworkSendPickSheet()` 整个重置。
 * @type {{kind: string, groups: Array.<Object>, q: string, tab: string}}
 */
let sendPick = { kind: 'collab', groups: [], q: '', tab: 'all', delegate: null };

/**
 * 功能：按当前筛选条件**只重画列表区**（⭐ 0.8.54）。
 *
 * 说明：⚠️⚠️ 只换 `[data-pick-list]` 的内容，⛔ 不许 `#sheet-body.innerHTML = …`：
 *      整块重画会把搜索框一起重建 —— 光标与输入法当场断掉（打一个字停一次），
 *      这是「弹层里带输入框」最容易踩的一脚。筛选按钮的高亮同理，只切 class。
 * @returns {void}
 */
function paintSendPickList() {
  const box = $('#sheet-body');
  if (!box) return;
  const list = box.querySelector('[data-pick-list]');
  if (list) list.innerHTML = pickListHtml(filterPickGroups(sendPick.groups, sendPick));
  const tabs = box.querySelector('.tw-pick-tabs');
  if (tabs) {
    for (const b of tabs.querySelectorAll('[data-pick-tab]')) {
      b.classList.toggle('on', String(b.dataset.pickTab || '') === sendPick.tab);
    }
  }
}

/**
 * 功能：打开**任务选择**弹层（⭐ 0.8.54；0.8.54 加「按项目折叠 ＋ 筛选」）——
 *      按项目分组、默认折起，点一条就发出去。
 *
 * 说明：⭐⭐ 弹层用**定高**（`{ fixed: true }`，占外壳 80%）：筛选栏钉在顶上、列表自己滚。
 *      这不只是好看 —— 截图那次的症状是「标题在、下面全空、只剩一条分隔线」，
 *      根因就是**不定高**时 `.sheet-body` 的 `flex: 1; min-height: 0` 被内层
 *      （`max-height` ＋ 自己滚的列表）顶成 0 高，正文整块被裁掉。定高之后这一族问题不存在。
 *      ⚠️ `await` 回来要再确认弹层还开着：用户可能已经点了 ✕ 或换了别的一项，
 *      这时再往里写内容就是「关了又自己回来」的另一种形态。
 * @param {string} kind - `'collab'`（协作项目任务）/ `'daily'`（普通任务）
 * @returns {Promise.<void>}
 */
async function teamworkSendPickSheet(kind, onPick) {
  // ⭐ 0.8.55：**代挑**模式（AI 会话借这个弹层把任务发给 AI）不需要当前会话
  const delegate = typeof onPick === 'function' ? onPick : null;
  if (!state.teamworkId && !delegate) return toast('先在左边选一个好友或会话', true);
  const isCollab = kind === 'collab';
  sendPick = {
    kind: isCollab ? 'collab' : 'daily',
    groups: [],
    q: '',
    tab: 'all',
    // ⚠️ 选中后**回传给调用方**而不是发消息（null = 老路径：往当前会话发卡片）
    delegate,
  };
  openSheet(
    isCollab ? '发送协作项目任务' : '发送普通任务',
    '<div class="tw-pick-empty">正在读取任务…</div>',
    '',
    { fixed: true },
  );
  let groups;
  try {
    groups = await fetchSendGroups(isCollab ? 'collab' : 'daily');
  } catch (e) {
    const box = $('#sheet-body');
    if (box) box.innerHTML = '<div class="tw-pick-empty">' + esc((e && e.message) || '读取任务失败') + '</div>';
    return;
  }
  if (!isSheetOpen()) return;
  sendPick.groups = Array.isArray(groups) ? groups : [];
  const box = $('#sheet-body');
  if (box) box.innerHTML = pickPanelHtml(sendPick.groups, sendPick);
}

/**
 * 功能：点一条任务 ⇒ 取回它的字段、拼一张**任务卡片**发给对方（⭐ 0.8.54）。
 * 说明：⭐ 卡片是**快照**，⛔ 不反查对方任务；协作任务带 `src: 'collab'` ＋ 项目名。
 * @param {string} key - `data-pick` 的值（`daily:<id>` / `collab:<id>:<pid>`）
 * @returns {Promise.<void>}
 */
async function teamworkSendPicked(key) {
  const cid = Number(state.teamworkId);
  const parts = String(key || '').split(':');
  const kind = parts[0];
  const tid = Number(parts[1]);
  const pid = Number(parts[2]);
  // ⭐ 0.8.55：代挑模式 —— 选中就回传给调用方（AI 会话要自己发，不走会话消息那条路）
  const delegate = sendPick.delegate;
  if (!tid) return;
  if (!delegate && !cid) return;
  closeSheet();
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
    const r = await api('POST', `/api/teamwork/conversations/${cid}/messages`, { body: bodyText, kind: 'task_card', meta: card });
    pushSentMessage(r, bodyText, 'task_card', card);
    toast('已发送');
  } catch (e) {
    toast((e && e.message) || '发送失败', true);
  }
}

/**
 * 功能：给「＋ 那一排」接线（⭐ 0.8.54）—— 文件框、任务列表点击、点图看大图。**只挂一次**。
 *
 * 说明：⚠️ 任务列表在**弹层**里（`#sheet-body` 是 `#app` 的兄弟节点）⇒ 动作委托要挂在它自己身上；
 *      `[data-pick]` 不适合走宿主那张 `data-act` 表（键里带 id，不是固定动作名）。
 *      ⚠️ 图片放大走 `openSheet()` 而**不是**自绘浮层：弹层会压一条 history，返回键先关图；
 *      自绘浮层在手机上按返回会把整个页面退掉（踩过的坑）。
 * @returns {void}
 */
export function bindTeamworkPlus() {
  if (bindTeamworkPlus._bound) return;
  bindTeamworkPlus._bound = true;
  const fileEl = $('#teamwork-img-file');
  if (fileEl) {
    fileEl.addEventListener('change', () => {
      const f = fileEl.files && fileEl.files[0];
      // ⚠️ 先清空 `value`：同一张图连发两次时，不清空就不会再触发 `change`
      fileEl.value = '';
      if (!f) return;
      // ⭐ 0.8.54：文件框由 `<label for>` 打开，**菜单是留在后面的**（不像从前点的那一下
      //    就 `closeSheet()` 了）⇒ 选完图要自己把菜单收掉，否则选完还压着一张「发送」。
      closeSheet();
      teamworkUploadImage(f);
    });
  }
  const sheetBody = $('#sheet-body');
  if (sheetBody) {
    sheetBody.addEventListener('click', (e) => {
      const el = e.target;
      // ⭐ 0.8.54：筛选标签（全部 / 未完成 / 已完成）—— 先判它，再判任务行
      const tab = el && el.closest ? el.closest('[data-pick-tab]') : null;
      if (tab) {
        sendPick.tab = String(tab.dataset.pickTab || 'all');
        paintSendPickList();
        return;
      }
      const row = el && el.closest ? el.closest('[data-pick]') : null;
      if (row) teamworkSendPicked(row.dataset.pick);
    });
    // ⭐ 0.8.54：搜索框 —— 用 `input`（不是 `change`）：要边打边滤。只在列表区重画，
    //    ⛔ 不重建输入框本身（重建就断输入法）。
    sheetBody.addEventListener('input', (e) => {
      const q = e.target && e.target.closest ? e.target.closest('[data-pick-q]') : null;
      if (!q) return;
      sendPick.q = String(q.value || '');
      paintSendPickList();
    });
  }
  bindImageZoom((url, name) => {
    openSheet('图片', `<img class="tw-img-view" src="${url}" alt="${esc(name)}">`);
  });
}
/**
 * 功能：⭐ 0.8.55 —— 把「挑一条任务」借给别的会话用（目前是 AI 助手）。
 *
 * 说明：⭐ 走留白事件：AI 模块不认识任务表，也不该复制一份选择器 ——
 *      它派发 `zx:ai-pick-task`，这里用**同一个弹层**挑完，把 `{card, bodyText}` 回给它。
 *      ⚠️ 只挂一次（模块级标记）。
 * @returns {void}
 */
export function bindChatPickTask() {
  if (bindChatPickTask._bound) return;
  bindChatPickTask._bound = true;
  document.addEventListener('zx:ai-pick-task', (e) => {
    const d = e && e.detail;
    if (!d || typeof d.done !== 'function') return;
    void teamworkSendPickSheet(String(d.act == null ? 'daily' : d.act), d.done);
  });
}

// ---------- 长按消息 → 添加到任务 / 复制文本（0.4.4） ----------

/** 长按判定的毫秒数：500ms 是移动端通行值（再短会和「点一下」「开始滚动」打架） */
const TEAMWORK_HOLD_MS = 500;
/** 长按期间允许的手指位移（px）：超过就按「他在滚动」处理，不再算长按 */
const TEAMWORK_HOLD_MOVE = 10;

/**
 * 功能：给整页挂上「长按一条消息」的识别（由 `mobile/app.js` 的 `bindEvents()` 调一次）。
 *
 * 说明：⭐ 手机上没有右键，所以「长按」是电脑版右键的对位动作。⚠️ **两条路都要接**：
 *      Android Chrome 长按会**自己发一个 `contextmenu`**（同时会选中文字 / 弹出系统菜单），
 *      iOS Safari **不发** —— 只接 `contextmenu` 的话 iPhone 上这个功能根本不存在，
 *      而且完全静默（没有任何报错）。所以这里是「自己计时 500ms」+「接管 contextmenu」双保险，
 *      触发前用 `cancel()` 保证不会同一次长按弹两层。
 *      ⚠️ 用**事件委托**而不是给每一条气泡单独绑：消息列表每次重画都是整块 `innerHTML`，
 *      逐个绑必然漏（漏的那处表现是「点了没反应」，本项目最忌讳的一类缺陷）。
 *      ⚠️ 三个 touch 监听器都是 `passive`：消息区是要滚动的，声明 `passive: false` 会让
 *      Safari 的滚动变差，而我们**只读坐标、不阻止默认行为**。
 * ⭐ 0.6.4（任务联动）：这里**也挂卡片上的动作按钮**（`[data-card-act]` 的 click 委托）——
 *    它与长按是同一类事（消息气泡上的交互），理由也同上面那条：都要挂整页、都要走委托。
 *
 * @returns {void}
 */
export function bindTeamworkMessageHold() {
  const app = $('#app');
  if (!app) return;
  let timer = null;
  let startX = 0;
  let startY = 0;
  let holdId = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    holdId = 0;
  };
  app.addEventListener(
    'touchstart',
    (e) => {
      const hit = e.target && e.target.closest ? e.target.closest('[data-teamwork-msg]') : null;
      if (!hit || !e.touches || e.touches.length !== 1) return;
      holdId = Number(hit.dataset.teamworkMsg);
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        const msg = findMessage(holdId);
        holdId = 0;
        if (msg) teamworkMsgMenu(msg);
      }, TEAMWORK_HOLD_MS);
    },
    { passive: true },
  );
  app.addEventListener(
    'touchmove',
    (e) => {
      if (!timer) return;
      const p = e.touches && e.touches[0];
      // ⚠️ 位移超阈值 = 用户是在滚消息，不是在长按 —— 不取消的话「翻历史」会顺手弹出菜单
      if (!p || Math.abs(p.clientX - startX) > TEAMWORK_HOLD_MOVE || Math.abs(p.clientY - startY) > TEAMWORK_HOLD_MOVE) {
        cancel();
      }
    },
    { passive: true },
  );
  app.addEventListener('touchend', cancel, { passive: true });
  app.addEventListener('touchcancel', cancel, { passive: true });
  app.addEventListener('contextmenu', (e) => {
    const hit = e.target && e.target.closest ? e.target.closest('[data-teamwork-msg]') : null;
    if (!hit) return;
    e.preventDefault();
    cancel();
    const msg = findMessage(hit.dataset.teamworkMsg);
    if (msg) teamworkMsgMenu(msg);
  });
  // ⭐ 0.6.4（任务联动）：任务卡片里的动作按钮（「收进我的任务板」等）。
  //    ⚠️ 刻意**不走宿主动作表**（`data-act` + `mobile/app.js` 的登记）：卡片按钮由**别的模块**
  //    通过 `zx:teamwork-card-actions` 留白事件供给，键名是它们自己起的 —— 登记进宿主那张表，
  //    等于把「谁提供了什么动作」写成一份两边必须对账的清单（漏一处就是点了没反应）。
  //    ⚠️ 委托挂在 `#app` 上（与上面的长按同一条理由）：消息区是整块重画的，逐条绑必然漏。
  app.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-card-act]') : null;
    if (!btn) return;
    const wrap = btn.closest('[data-teamwork-msg]');
    const msg = wrap ? findMessage(wrap.dataset.teamworkMsg) : null;
    if (!msg) return;
    // 找不到动作时说一句人话（不许静默）—— 常见原因是提供它的模块被关掉 / 被删掉了
    if (!runCardAction(msg, btn.dataset.cardAct)) {
      toast('这个操作现在用不了（提供它的功能可能被关掉了）', true);
    }
  });
  // ⭐ 0.7.7：发送框的「输入即自增高」—— 输入框是 `mobile/index.html` 里的**静态骨架**
  //    （从头到尾都在、不参与重画），所以这里挂一次就够。
  //    ⚠️ 宿主（mobile/app.js）只调 `bindTeamworkMessageHold()` 这一个入口 ⇒ 顺带在这里挂上，
  //    不为它单独开一条需要改宿主的入口（改 HTML 节点 / 入口都要同步宿主的绑定）。
  bindTeamworkComposer();
}

/**
 * 功能：给发送框挂「输入即自增高」（0.7.7）—— 拖拽手柄由 CSS 的 `resize: none` 已经去掉。
 *
 * 说明：⚠️ 先归零再按 `scrollHeight` 设回去（不归零的话，删掉几行之后它**不会缩回去**）。
 *      ⚠️ 封顶交给 CSS 的 `max-height`（`max-height` 优先于 `height`）⇒ 两端不必各写一个上限数。
 *
 * @returns {void}
 */
function bindTeamworkComposer() {
  const inp = $('#teamwork-input');
  if (!inp) return;
  inp.addEventListener('input', () => autoGrow(inp));
}

/**
 * 功能：让一个 textarea **跟着内容变高**（0.7.7）—— 与电脑版 `desktop.js` 的同名函数**同一个写法**。
 * @param {HTMLTextAreaElement} el - 输入框
 * @returns {void}
 */
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * 功能：一条消息的操作菜单（底部弹层）——「添加到任务 / 复制文本」（0.4.4，与电脑版右键同一套动作）。
 *
 * 说明：⚠️ 用底部弹层而不是自绘浮层：手机上的浮层要自己处理贴边、旋转、软键盘，
 *      而 `openSheet()` 已经把这些事做完了一整套（收藏夹 / 硬件 / 密码库都是这么用的）。
 *
 * @param {?Object} msg - 消息行（`findMessage()` 的结果）
 * @returns {void}
 */
export function teamworkMsgMenu(msg) {
  const id = Number(msg && msg.id);
  if (!id) return;
  // ⭐ 0.6.0 菜单留白：插槽片段往 `extra` 里 push
  //    `{ label, run }` 就能在弹层里多一行 —— 本文件不认识添菜单的是谁；
  //    片段贡献的按钮不走全局动作表（那是宿主自己那套），由本函数就地绑定 `run`。
  const extra = [];
  document.dispatchEvent(new CustomEvent('zx:teamwork-msg-menu', { detail: { msg, items: extra } }));
  const extraBtns = extra
    .map(
      (it, i) =>
        `<button class="btn" type="button" data-teamwork-extra="${i}" style="min-height:48px">${esc(it.label)}</button>`,
    )
    .join('');
  openSheet(
    '这条消息',
    `<div class="teamwork-menulist">
       <button class="btn" type="button" data-act="teamwork-msg-task" data-id="${id}" style="min-height:48px">📋 添加到任务</button>
       <button class="btn" type="button" data-act="teamwork-msg-copy" data-id="${id}" style="min-height:48px">📄 复制文本</button>
       ${extraBtns}
     </div>
     <div class="m-tip">长按消息就能调出这个菜单。</div>`,
    `<button class="btn ghost" type="button" data-act="sheet-close" style="flex:1">关闭</button>`,
  );
  extra.forEach((it, i) => {
    const btn = document.querySelector(`#sheet [data-teamwork-extra="${i}"]`);
    if (btn) btn.addEventListener('click', () => it.run());
  });
}

/**
 * 功能：复制一条消息的文字（长按菜单的第二项）。
 *
 * 说明：⚠️ 「这个环境不允许自动复制」是真实存在的一条分支（明文 http 下 `navigator.clipboard`
 *      不可用 —— 飞牛的局域网直连地址就是 http），所以失败时必须给一句人能照做的话
 *      （`core/dom.js` 的 `copyText()` 已经带 textarea 兜底，这里是兜底也失败的那一档）。
 *
 * @param {number} id - 消息 id
 * @returns {Promise.<void>}
 */
export async function teamworkMsgCopy(id) {
  const msg = findMessage(id);
  if (!msg) return;
  const ok = await copyText(String(msg.body || ''));
  // ⚠️ 先收起菜单再提示：留着弹层的话，轻提示会被压在它后面看不见（手机上尤其明显）
  closeSheet();
  toast(ok ? '消息文字已复制' : '这个环境不允许自动复制，请长按消息手动选中复制', !ok);
}

/**
 * 功能：把一条消息变成一条任务 —— 弹层里选**归属**（日常任务 / 某个项目）并设置任务自己的属性。
 *
 * 说明：⭐ 第 3 条（手机版同样要做）：动作是长按消息 →「添加到任务」。
 *      两个「不能省」的细节：
 *      ① **归属切换要联动字段**：日常任务的正文列叫 `content`、项目任务的叫 `description`，
 *         而且只有项目任务有负责人 / 标签 —— 选「日常任务」时那两栏必须收起来，
 *         否则就是「填了会被丢掉」（服务端 `checkDailyTask` 不认这两个字段）；
 *      ② **正文默认带来源引用**（谁、什么时候、说了什么）—— 任务与那句话的关联要落在数据上。
 *      ⚠️ 保存走 `state.sheetSave`（`sheet-save` 那条全局分支），与其它表单同一个出口。
 *      ⚠️ 成功后 `refresh()` 一次：任务落在「今天 / 任务板 / 项目」那几屏上，
 *      不刷的话这一条要等到用户自己下拉刷新才出现（本项目记过「静默过期」这类坑）。
 *
 * @param {?Object} msg - 消息行
 * @returns {void}
 */
export function teamworkTaskSheet(msg) {
  const id = Number(msg && msg.id);
  if (!id) return;
  const b = state.teamworkBuddy || {};
  const from =
    Number(msg.senderId !== undefined ? msg.senderId : msg.user_id) === Number((state.me && state.me.id) || 0)
      ? '我'
      : teamworkRowName(b);
  const body = String(msg.body || '');
  const firstLine = (body.split('\n').find((l) => l.trim()) || '').trim();
  const title = [...firstLine].slice(0, TEAMWORK_TASK_TITLE_MAX).join('') || '来自对话的任务';
  const quote = `来自「${from}」的消息（${teamworkTime(msgStamp(msg))}）：\n${body}`;
  const today = todayStr();
  const opts =
    '<option value="daily">日常任务（不归属任何项目）</option>' +
    (state.projects || [])
      .map((p) => `<option value="${Number(p.id)}">${esc(`${p.icon || '📁'} ${p.name || ''}`.trim())}</option>`)
      .join('');
  openSheet(
    '添加到任务',
    `<div class="field"><label>归属项目 *</label><select id="ct-scope">${opts}</select></div>
     <div class="field"><label>任务标题 *</label>
       <input type="text" id="ct-title" value="${esc(title)}" placeholder="要做什么？" /></div>
     <div class="field"><label>内容描述</label>
       <textarea id="ct-desc">${esc(quote)}</textarea></div>
     <div class="two">
       <div class="field"><label>任务日 *</label><input type="date" id="ct-start" value="${esc(today)}" /></div>
       <div class="field"><label>截止日期 *</label><input type="date" id="ct-due" value="${esc(today)}" /></div>
     </div>
     <div class="two" id="ct-proj-row">
       <div class="field"><label>负责人</label><input type="text" id="ct-assignee" placeholder="我" /></div>
       <div class="field"><label>标签</label><input type="text" id="ct-tag" placeholder="设计 / 物料" /></div>
     </div>
     <div class="field"><label>重要 / 紧急（决定四象限）</label><div class="switches">
       <button class="sw imp" type="button" data-act="tg" data-tg="imp">🔴 重要</button>
       <button class="sw urg" type="button" data-act="tg" data-tg="urg">⏰ 紧急</button>
     </div></div>
     <div class="field"><label>绑定网址</label><select id="ct-bookmark"></select></div>
     <div class="m-tip">⭐ 消息原文已经填进「内容描述」里了，并写明了是谁在什么时候说的 ——
       任务和那句话的关联就留在数据里，不必回头翻聊天记录。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  // ⚠️ 手机版的两个日期框也要联动（`bindDateMin()` 认的是 `#f-start` / `#f-due`，
  //    这是对话自己的表单，节点名不同，所以就地绑一次）
  const s = $('#ct-start');
  const d = $('#ct-due');
  if (s && d) {
    d.min = s.value || '';
    s.addEventListener('change', () => {
      d.min = s.value || '';
      if (d.value && d.value < s.value) d.value = s.value;
    });
  }
  const syncScope = () => {
    const row = $('#ct-proj-row');
    const sel = $('#ct-scope');
    if (row && sel) row.classList.toggle('hidden', sel.value === 'daily');
  };
  const sel = $('#ct-scope');
  if (sel) sel.addEventListener('change', syncScope);
  syncScope();
  fillBookmarkSelect('#ct-bookmark');
  state.sheetSave = async () => {
    const t = $('#ct-title').value.trim();
    const start = $('#ct-start').value;
    const due = $('#ct-due').value;
    if (!t) return toast('请填写任务标题', true);
    if (!start || !due) return toast('请选择任务日与截止日期', true);
    if (start > due) return toast('任务日不能晚于截止日期', true);
    const scope = $('#ct-scope').value;
    const common = {
      title: t,
      start_date: start,
      due_date: due,
      important: $('[data-tg="imp"]').classList.contains('on') ? 1 : 0,
      urgent: $('[data-tg="urg"]').classList.contains('on') ? 1 : 0,
      status: 'todo',
      // ⭐ 0.5.2：绑的网址（`0` = 不绑）
      bookmark_id: Number($('#ct-bookmark').value) || 0,
      // ⭐ 0.4.4：记下「这条任务是从哪条消息建的」—— 消息下面那枚「已添加到任务」标记靠它反查
      //    （只写一次，PUT 改不到它）。
      from_message_id: Number(msg.id),
    };
    try {
      let created = null;
      // ⭐ 0.7.1：统一走「任务创建」的对外入口 —— 两套字段名（`content` / `description`）它都认。
      //    ⚠️ `common` 里已经带上了 `from_message_id`：那个字段**只在创建时能写**，
      //    所以必须在这一步给出去，否则消息下面那枚「已添加到任务」标记永远反查不出来。
      created = await createTask(
        scope,
        Object.assign(
          {
            content: $('#ct-desc').value.trim(),
            assignee: $('#ct-assignee').value.trim(),
            tag: $('#ct-tag').value.trim(),
          },
          common,
        ),
      );
      // ⭐ 就地补上标记（服务端下次取数时会给同一份）：不补的话要退出重进才看得见
      if (created && created.id) {
        const map = state.teamworkMsgTasks || (state.teamworkMsgTasks = {});
        const key = Number(msg.id);
        if (!Array.isArray(map[key])) map[key] = [];
        map[key].push({ scope: scope === 'daily' ? 'daily' : Number(scope), id: Number(created.id), title: t });
      }
      closeSheet();
      renderTeamworkThread();
      await refresh();
      toast(scope === 'daily' ? '已添加到「日常任务」' : '已添加到项目任务');
    } catch (e) {
      toast(e.message, true);
    }
  };
}
