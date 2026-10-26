'use strict';
/**
 * modules/ai/lib/tools-read.js —— 工具面的**读侧 + 执行基础件**（`0.7.6` 从 `tools.js` 拆出）
 *
 * 功能：4 条**读**工具的目录项（`READ_TOOLS`）、它们的执行表（`READ_EXEC`）与执行体，
 *      外加两条**读写执行器共用**的基础件：日期 / 时刻换算（`dayStr` / `shiftDay` / `weekdayCn` /
 *      `mondayOf` / `hhmm` / `minutesOf`）与入参错构造（`httpError`）。
 *
 * ⚠️ 拆分口径（「把 tools.js 拆分为 tools-read.js 和 tools-write.js」）：
 *    读 / 写各自的**实现**分家；「目录合并 + 授权判据 + 执行分发」留在 `tools.js` ——
 *    它仍是对外的**唯一入口**，导出逐字未变（`routes.js` / `store.js` / `openai-client.js` 一行没改）。
 *
 * ⚠️⭐ **依赖方向恒为 `tools-write.js → tools-read.js`**（写侧只从本文件取 `httpError`）。
 *    本文件**不 require 任何东西** —— ⛔ 别把它 require 回来、也别在这里 require `tools.js`
 *    （后者会成环：`tools.js` 要 require 本文件才能组出目录）。基础件放读侧的由来：
 *    读工具是 3 期落地的、写工具在，时间换算与入参错本来先长在这一侧。
 *
 * ⚠️ 本文件与 `tools.js` 一样**不 require 任何东西**（纯数据 + 纯函数）：`store.js` 与
 *    `routes.js` 都要用它，一旦拉进 `core/context.js`（一 require 就建库），存储层单测会当场失去独立性。
 *
 * ⚠️ 硬边界（`vault` / `chat` 永不进工具面）的判据是「**表里没有**」而不是「有一处 if 拦着」：
 *    往 `READ_TOOLS` 里加一条 `vault` 就等于把它放进了工具面（`ai.test.js` 有硬边界扫描用例咬住）。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.61
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/16-AI辅助任务-3期-AI工具调用与授权.md
 */

/**
 * 可以授权给 AI **读**的模块名（白名单）。
 *
 * 说明：⭐ 0.8.5 起是这**六个** —— 任务板 / 课表 / 记账 / 收藏夹 / 随手记 / 硬件。
 *      ⚠️ **密码库与对话永远不在**（硬边界，见文件头）：读者是模型，而这两块的内容
 *      一旦出网就没有任何补救手段。
 *      ⚠️ 记账（`ledger`）是 0.8.4 加的第三条：**账单 / 预算 / 资产**三样都是「排期与决策」
 *      要用的事实（「这个月还剩多少可花」），而且读者是**账本的主人自己**。
 *      ⭐ 0.8.5（「接入 ai 的读写，参照其它模块的 ai 实现」）：
 *      收藏夹 / 随手记 / NAS硬件管理 三块一起进工具面 —— 它们原先写在「进后期路线」里。
 *      三块的**出网面都比前几块更窄**（见各自那条 `PANEL_READ` 文案与 `READ_TOOLS`
 *      的 `returns`）：网址**只到域名**、硬件**不给序列号 / 位置 / 详述**。
 *
 *      ⭐⭐ **0.8.55 全面体检**（「AI模板需要全面体检和修复，几乎所有模块都有更新
 *      和变化，ai对话辅助几乎没有了」）：产品已经是 **12 块**，而这张白名单还停在 0.8.5 的七个 ——
 *      AI 对「个人资产管理 / 日历 / 番茄钟 / 协作项目」四块**完全失明**。本次补齐这四块：
 *      · `assets`（个人资产管理）：存量台账（分组树 ＋ 条目金额）—— ⭐ 与记账的「流量」互不并入，
 *        这一点在提示词里说死，否则模型会把「这套房 300 万」算进这个月支出；
 *      · `calendar`（日历）：**用户自己建的日程**（⛔ 不含课表 / 任务 / 假期那三个派生图层 ——
 *        课表走 `timetable.range`、任务走 `tasks.query`，重复进工具面＝同一件事两份口径）；
 *      · `pomodoro`（番茄钟）：今天 / 本周的专注时长与次数；
 *      · `collab`（协作项目）：**只读「我参与的」**（选的口径）—— 我看得到的共享
 *        项目与我这个成员该看到的任务；⛔ 不含他人的对话、附件、上报与评论正文。
 *      ⚠️ 硬边界仍然只有那两条（`vault` / `chat`）：`webpass`（网址/密码夹）是纯屏模块，
 *      它的数据全在收藏夹与密码库里 ⇒ 前者已有开关、后者永不进 —— 因此**不单独开一条**。
 * @type {Array.<string>}
 */
const READ_MODULES = ['tasks', 'timetable', 'ledger', 'bookmarks', 'idea', 'digital', 'trip', 'assets', 'calendar', 'pomodoro', 'collab'];

/**
 * ⭐ AI 卡片屏「AI 能力」那一块**逐字使用**的文案里**属于读侧**的那几句。
 *
 * 说明：⚠️ 每个开关**旁边**都要有一句人话（不是底部一句免责声明）—— 这是定调的第 3 条
 *      「选择权交给用户 + 尽到风险告知义务」。所以文案写得具体到「哪几个字段会出去」。
 *      ⚠️ 与 `shared.js` 的一致性由测试盯着，两边改一处必须改另一处。
 *      ⚠️ 这里刻意**不带 markdown 星号**：它是界面上直接显示的纯文本（星号会照原样显示出来）。
 *      ⚠️ 读 / 写各持一半（写侧那几句在 `tools-write.js` 的 `PANEL_WRITE`），由 `tools.js`
 *      合并成界面用的那一个 `PANEL`（⛔ 对外仍然只有一份，界面与测试都只认它）。
 * @type {{boundary: string, master: string, tasksRead: string, timetableRead: string,
 *         ledgerRead: string, bookmarksRead: string, ideaRead: string, hardwareRead: string,
 *         tripRead: string, assetsRead: string, calendarRead: string, pomodoroRead: string,
 *         collabRead: string, coreTime: string}}
 */
const PANEL_READ = {
  // 这一屏顶部那句边界声明（不可配置的那条线）
  boundary: '密码库与对话的数据永远不会发送给 AI —— 这里没有开关，也不会有。',
  // 总开关旁边的解释
  // ⚠️ 0.8.5：末句从「也不会提议建任务」改成「也不会提议新建任何东西」—— 能提议的
  //    已经不止任务（记账 / 收藏 / 随手记 / 硬件），旧措辞会低估这一开关的作用。
  master: '关掉后，AI 只能聊天，不会读取你的任何数据，也不会提议新建任何东西。',
  // 「任务板（读）」旁边……
  // ⭐⭐ 2026-10-19（截图：「移除这些开关的提示语」）：每个开关下面那句逐条重复的
  //    「打开后，你的…会被发送给你配置的模型。」**界面上整块撤掉**了（七遍同一件事）。
  //    但这几句在本文件里**仍然保留**：它们是服务端那份「出网面告知」的唯一出处，
  //    由 `GET /api/ai/tools` 原样回给界面，也是「界面上说只发标题、实际发了课表」这类事故的
  //    对账依据（`ai.test.js` 逐字比对）。⇒ 界面上改由**这一区顶上那一句通用说明**承担
  //    （`shared.js` 的「打开哪一项，AI 才读得到哪一项；没打开的，一个字都不会发出去。」），
  //    ⛔ 别为了「界面上看不见了」就把这里删掉。
  tasksRead: '打开后，你的任务标题、截止时间、优先级与归属会被发送给你配置的模型。',
  // 「课表（读）」旁边的解释
  timetableRead: '打开后，你的课程名、教室、上课时间（用来判断哪些时段没空）会被发送给你配置的模型。',
  // 「记账（读）」旁边的解释（0.8.4）—— ⚠️ 逐个字段点明：金额／分类／账户名／余额
  ledgerRead: '打开后，你的收支金额、分类名、账户名与账户余额会被发送给你配置的模型。',
  // ⭐ 0.8.5 那三块（收藏夹 / 随手记 / NAS硬件管理）—— ⚠️ 同样逐个字段点明，
  //    而且**明说哪些不发**：出网面这件事，「没发什么」与「发了什么」一样要写清楚。
  // 「网址收藏夹（读）」旁边的解释
  bookmarksRead: '打开后，你收藏的标题、网站域名与分类名会被发送给你配置的模型（网址的完整路径不会发）。',
  // 「随手记（读）」旁边的解释 —— ⚠️ 这一块出网的是**用户自己写的正文**，务必写明
  ideaRead: '打开后，你随手记下的正文内容与标签会被发送给你配置的模型。',
  // 「数码管理（读）」旁边的解释 —— 序列号 / 位置 / 详细内容**不发**
  // ⚠️ 0.8.10：模块 `hardware` 改名 `digital`（界面「数码管理」）——
  //    授权那一维用的是**模块名**，所以文案与白名单都要跟着改，⛔ 否则老授权会被静默剔除。
  hardwareRead:
    '打开后，你的数码设备名称、分类、品牌型号、购买日期、价格与寿命信息会被发送给你配置的模型（序列号、位置与详细内容不会发）。',
  // 读工具那一组开头的第二句：说明「时间」这一条不读用户数据（`now.info` 的出网面就是它）
  coreTime: 'AI 也会自己知道「现在是什么时候」—— 这一条不读你的任何数据，不用单独授权。',
  // ⭐ 0.8.6（行程 / 车票）—— ⚠️ 同样逐个字段点明，而且**明说哪些不发**：
  //    订单号（票号）与任何坐标**永远不出网**，这是这一条工具面收得最紧的地方。
  tripRead:
    '打开后，你的行程标题、起止日期，以及车票的车次、出发到达站、出发到达时刻、座位与检票口会被发送给你配置的模型（订单号与任何位置信息不会发）。',
  // ⭐⭐ 0.8.55 全面体检：四块新读数 —— 同样逐个字段点明，而且**明说哪些不发**。
  // 「个人资产管理（读）」旁边的解释 —— ⚠️ 条目备注与所在位置不发
  assetsRead:
    '打开后，你的资产分组名、条目名称、金额与日期会被发送给你配置的模型（条目的备注不会发）。',
  // 「日历（读）」旁边的解释 —— ⚠️ 只发你自己建的日程，**不发**课表 / 任务 / 假期那三层派生内容
  //    （它们各有自己的开关）。条目的备注同样不发。
  calendarRead:
    '打开后，你自己建的日程标题、日期与起止时刻会被发送给你配置的模型（日程备注不会发；课表与任务走它们各自的开关）。',
  // 「番茄钟（读）」旁边的解释 —— 只发计数与时长，⛔ 不发任何任务名
  pomodoroRead: '打开后，你的专注次数与专注时长（今天 / 本周）会被发送给你配置的模型。',
  // 「协作项目（读）」旁边的解释 —— ⚠️ 只发「我参与的」项目与其中的任务，⛔ 不发对话与附件
  collabRead:
    '打开后，你参与的协作项目名称、其中任务的标题、状态、负责人与截止日期会被发送给你配置的模型（聊天记录、评论与附件不会发）。',
};

/**
 * 工具定义表里**属于读侧**的那 4 条（表字段说明见 `tools.js` 的 `TOOLS`）。
 *
 * ⚠️ **读工具为什么是这三样一起给**（调 5~7，方案 §4.3）：
 *    「安排」= 在**可用时间**里给**事情**排序 —— 缺「现在」不知道今天还剩几小时、
 *    缺「占用」不知道下午有 4 节课、缺「事情」无从排起 ⇒ 三条要么都给、要么都不给。
 *    所以 `now.info` / `tasks.query` / `timetable.range` 是**一套**，别只放其中一条给模型。
 *
 * ⚠️ **返回面 = 出网面**：这里每多回一个字段，`returns` 与 `PANEL_READ` 的文案都要跟着动
 *    （出网面变大必须可见，方案 §4.3 / §7.2）。
 * @type {Array.<Object>}
 */
const READ_TOOLS = [
  {
    name: 'now.info',
    module: 'core',
    mode: 'read',
    title: '现在是什么时候',
    purpose: '排期要先知道「现在几点、今天周几、本周还剩几天」—— 时间以服务端为准，模型猜不准。',
    share: 'AI 也会自己知道「现在是什么时候」—— 这一条不读你的任何数据，不用单独授权。',
    args: ['无'],
    returns: ['日期', '星期几', '当前时刻', '本周剩余天数'],
  },
  {
    name: 'tasks.query',
    module: 'tasks',
    mode: 'read',
    title: '看看你的任务',
    purpose: '知道有哪些事、什么时候到期、轻重缓急 —— 排期与调整建议的原料。',
    share: PANEL_READ.tasksRead,
    args: ['范围：今日 / 本周 / 逾期 / 全部未完成', '⭐ 或自己给日期：from / to（YYYY-MM-DD，按截止日筛，含已完成）'],
    // ⚠️ 如实写真实字段：任务表**没有**「时刻」列、也**没有**独立的「优先级」列
    //    （优先级就是 `important` / `urgent` 两格四象限）—— ⛔ 不在这里编一个「高/中/低」。
    //    ⭐ 0.8.55：补上任务类型 —— 周期任务（`kind:'cycle'`）**没有「逾期」这个概念**，
    //    它的 `due` 是这一轮周期的终点；⛔ 别把它的 `due` 当成截止时刻去判逾期。
    returns: [
      '标题',
      '截止日期（周期任务的那一格是「这一轮周期的终点」，不是硬截止）',
      '重要',
      '紧急',
      '完成状态',
      '所属项目',
      '任务类型 kind（plain = 普通 / window = 限时完成 / cycle = 周期打卡）',
      '周期规则 rule（仅 cycle 非空，形如 {"freq":"daily"}）',
    ],
  },
  {
    name: 'timetable.range',
    module: 'timetable',
    mode: 'read',
    title: '这几天的上课时段',
    purpose: '把课表当**不可用时段表**用：知道「下午有 4 节课」，才不会把事排进上课时间。',
    share: PANEL_READ.timetableRead,
    args: ['天数：今天 / 未来 7 天 / 下周', '⭐ 或自己给日期：from / to（YYYY-MM-DD，最多 31 天）'],
    returns: ['日期', '起止时刻', '课程名', '教室（有则带）', '取不到课程时的原因（枚举值，只说「没有学期 / 没填开学日期」）'],
  },
  {
    name: 'timetable.next',
    module: 'timetable',
    mode: 'read',
    title: '下一节课',
    purpose: '回答「我一会儿有没有课、还有多久上课」。',
    share: PANEL_READ.timetableRead,
    args: ['无'],
    returns: ['课程名', '起止时刻', '教室（有则带）', '距上课还有多久'],
  },
  // ---- 0.8.4：记账那三条（账单 / 预算 / 资产）----
  // ⚠️⭐ 金额字段的单位**一律是分**（项目全局口径；提示词里明说，见 `openai-client.js` 的 `toolsPrompt()`）。
  //    ⛔ 不回备注正文（那是用户写的自由文本）、⛔ 不回任何 id（模型用不上，出了网只是白送内部编号）。
  {
    name: 'ledger.bill',
    module: 'ledger',
    mode: 'read',
    title: '看你的收支账单',
    purpose: '回答「这段时间花了多少、钱花在哪儿了」—— 期间合计 ＋ 支出分类 ＋ 最近几笔。',
    share: PANEL_READ.ledgerRead,
    args: ['范围：今天 / 本周 / 本月 / 本年', '⭐ 或自己给日期：from / to（YYYY-MM-DD，任意区间，最多 366 天）', '⭐ 可选分类：category（本机已有的分类名）'],
    returns: [
      '区间起止',
      '收入合计（分）',
      '支出合计（分）',
      '结余（分）',
      '笔数',
      '支出分类（名称 / 金额 / 占比）',
      '最近几笔（时间 / 收支 / 金额 / 分类 / 账户名）',
    ],
  },
  {
    name: 'ledger.budget',
    module: 'ledger',
    mode: 'read',
    title: '看你的预算',
    purpose: '回答「这一期预算还剩多少、超没超」—— 总预算与各分类预算的进度。',
    share: PANEL_READ.ledgerRead,
    args: ['档位：本周 / 本月 / 本年'],
    // ⚠️ 如实写：预算屏的三档是**周 / 月 / 年**（没有「当天」这一档 —— 一天的预算没有意义）
    returns: [
      '区间起止',
      '总预算（额度 / 已用 / 剩余 / 是否超支 / 这一期设过没有）',
      '各分类预算（分类名 / 额度 / 已用 / 剩余 / 是否超支）',
    ],
  },
  {
    name: 'ledger.assets',
    module: 'ledger',
    mode: 'read',
    title: '看你的资产',
    purpose: '回答「我有多少钱、净资产多少、各账户还剩多少」—— 此刻的资产快照。',
    share: PANEL_READ.ledgerRead,
    args: ['无'],
    // ⚠️ 账户**按名字给**（⛔ 不回 `ledger_accounts.id`）；`side` 告诉我们这一行算资产还是负债
    returns: ['资产合计（分）', '负债合计（分）', '净值（分）', '各账户（名称 / 类型 / 资产或负债 / 余额）'],
  },
  // ---- ⭐ 0.8.5：收藏夹 / 随手记 / NAS硬件管理 三块 ----
  // ⚠️⭐ **返回面 = 出网面**（与上面同一条规矩）：这里每多回一个字段，`returns` 与
  //    `PANEL_READ` 那句就要跟着动 —— 三块的字段是**刻意挑过**的，增删前先想清楚。
  {
    name: 'bookmarks.query',
    module: 'bookmarks',
    mode: 'read',
    title: '看看你的收藏夹',
    purpose: '回答「我收藏过什么 / 某个分类下有哪些」—— 标题 ＋ 网站域名 ＋ 分类名。',
    share: PANEL_READ.bookmarksRead,
    args: ['范围：不筛 / 某个分类名'],
    // ⚠️⭐ 网址**只给域名**：完整 URL 可能带着查询串（单号、一次性 token、私人参数），
    //    而模型用域名就够了（「我收藏过 github 没有」）。⛔ 也不回 `bookmarks.id`。
    returns: ['标题', '网站域名（不含路径与查询串）', '分类名', '来源（自己存的 / 导入的）'],
  },
  {
    name: 'idea.query',
    module: 'idea',
    mode: 'read',
    title: '看看你的随手记',
    purpose: '回答「我记过什么 / 未归档里有哪些」—— 正文（截断）＋ 标签 ＋ 记录时间。',
    share: PANEL_READ.ideaRead,
    args: ['范围：未归档 / 已归档 / 全部'],
    // ⚠️ 正文是**截断**着给的（每条最多 `IDEA_TEXT_LIMIT` 字，被截的带 `truncated` 标记）——
    //    ⛔ 不做摘要、不改写：我们不猜用户写了什么（那是这个模块从立项起就守着的那条线）。
    returns: ['正文（每条最多 200 字，被截断的带标记）', '标签', '记录时间', '是否已归档'],
  },
  {
    name: 'hardware.query',
    module: 'digital',
    mode: 'read',
    title: '看看你的硬件台账',
    purpose: '回答「我买过什么 / 哪件该换了 / 愿望单上有什么」—— 台账 ＋ 服务端算好的寿命。',
    share: PANEL_READ.hardwareRead,
    args: ['范围：全部 / 在用 / 想买 / 已退役 / 需关注'],
    // ⚠️⭐ **序列号 / 位置 / 盘位 / 购买渠道 / 愿望链接 / 详细内容一律不回**：前几样是这台
    //    机器的身份信息，后几样是用户写的自由文本（出网面已在 `PANEL_READ` 里写明）。
    //    ⚠️ 价格单位是**元**（硬件表存的就是元；⛔ 与记账那种「分」不是一回事，别混）。
    returns: [
      '名称',
      // ⚠️ 枚举值的语义写在括号里 —— 回的是英文枚举，别让模型把它当中文猜
      '状态（owned = 在用 / wishlist = 想买 / retired = 已退役）',
      '分类',
      '品牌型号',
      '购买日期',
      '价格（元）',
      '寿命（已用月数 / 剩余月数 / 到期日；算不出来的为 null）',
    ],
  },
  {
    name: 'trips.query',
    module: 'trip',
    mode: 'read',
    title: '看看你的行程与车票',
    purpose: '回答「我接下来要去哪 / 什么时候出发 / 坐哪趟车」—— 行程 ＋ 车票两个范围都靠它。',
    share: PANEL_READ.tripRead,
    args: ['范围：upcoming（今天起 30 天，默认）/ recent（最近 30 天）'],
    // ⚠️⭐ **订单号 / 票价 / 备注 / 任何坐标一律不回**。
    //    ⚠️ 票的 `from` / `to` 是**站名**（用户自己填的文本），不是坐标 —— 两个别混。
    //    ⚠️ `reason` 那一项是**故意**列出来的：空结果与「模块被关掉」在模型眼里长得一样，
    //    不给原因它就会编一句「你最近没有出行安排」。
    returns: [
      'reason（ok = 有数据 / disabled = 这块被关掉了 / empty = 确实没有）',
      '行程：标题、交通工具、起点、终点、开始日期、起始时刻、结束日期',
      '车票：票型、车次 / 航班号、出发站、到达站、出发时刻、到达时刻、座位、检票口',
    ],
  },
  // ---- ⭐⭐ 0.8.55 全面体检：四块新读数（资产 / 日历 / 番茄钟 / 协作项目）----
  {
    name: 'assets.query',
    module: 'assets',
    mode: 'read',
    title: '看看你的资产台账',
    purpose:
      '回答「我有多少东西 / 值多少钱 / 房产和数字资产分别多少」—— 个人资产管理里用户自己建的' +
      '分组与条目都靠它。⚠️ 它是**存量**（这些东西值多少），与记账的**流量**（这段时间花了多少）' +
      '是两回事，⛔ 别把两者相加。',
    share: PANEL_READ.assetsRead,
    args: ['分组名（可选）：不填 = 全部；填了只看那一组及其子组'],
    // ⚠️⭐ **条目的备注与「位置」一律不回**。
    //    ⚠️ 金额单位是**分**，在 `returns` 里写明 —— 与记账那三条同一个坑。
    returns: [
      '合计：资产合计（分）、条目数',
      '分组：名称、层级（depth，0 = 顶层子模块）、条目数、该组金额合计（分）',
      '条目：名称、所属分组名、金额（分）、日期',
    ],
  },
  {
    name: 'calendar.query',
    module: 'calendar',
    mode: 'read',
    title: '看看你日历上的日程',
    purpose:
      '回答「我明天有什么安排 / 这周哪几天有事」—— ⚠️ 它只回**用户自己在日历里建的日程**；' +
      '课表走 timetable.range、任务截止走 tasks.query（三块口径不同，⛔ 别互相顶替）。',
    share: PANEL_READ.calendarRead,
    args: ['范围：today（今天）/ week（今天起 7 天，默认）/ next_week（下周一到周日）/ month（今天起 30 天）', '⭐ 或自己给日期：from / to（YYYY-MM-DD）'],
    // ⚠️ ⛔ 备注（note）不回：那是用户写的正文，与收藏夹的完整网址、硬件的详述同一族。
    returns: [
      'reason（ok = 有数据 / empty = 这段里确实没有日程）',
      '日程：标题、开始日期、结束日期（跨天时非空）、是否全天、开始时刻、结束时刻',
    ],
  },
  {
    name: 'pomodoro.query',
    module: 'pomodoro',
    mode: 'read',
    title: '看看你专注了多久',
    purpose: '回答「我今天专注了多久 / 这周打了几个番茄」—— 只有计数与时长，⛔ 不含任何任务名。',
    share: PANEL_READ.pomodoroRead,
    args: ['范围：today（今天，默认）/ week（本周一起）'],
    returns: ['专注：完成个数、总分钟数', '休息：完成个数、总分钟数'],
  },
  {
    name: 'collab.query',
    module: 'collab',
    mode: 'read',
    title: '看看你参与的协作项目',
    purpose:
      '回答「我在协作项目里还有什么没做 / 那个项目现在什么进度」—— ⚠️ 只回**我参与的**项目' +
      '（我开共享的 ＋ 我作为成员加入的），⛔ 别人的其它项目一条都看不到。',
    share: PANEL_READ.collabRead,
    args: ['无入参'],
    // ⚠️⭐ 只回「我这双眼睛本来就看得见的」：项目名 / 我的角色 / 任务标题 / 状态 / 负责人显示名 /
    //    截止日。⛔ 对话、评论正文、附件、上报内容、成员的联系方式**一律不回**。
    returns: [
      'reason（ok = 有数据 / empty = 你还没有参与任何协作项目）',
      '项目：名称、我的角色（owner = 我发起的 / member = 我参与的）、未完成任务数、总任务数',
      '任务：标题、状态、负责人显示名、截止日期（每个项目最多回 30 条未完成的）',
    ],
  },
];

// ==================== 执行器（3 期：四条**读**工具） ====================
//
// ⚠️ 本段是**唯一**执行读工具的地方：`routes.js` 的 `POST /api/ai/tools/run` 与 chat 的
//    工具循环都调 `runReadTool()`。因此两件事在这里各判一次、都只此一处 ——
//    · **授权**：由调用方先问 `store.aiAuthorizedTools()`（⭐ 唯一判据）；
//      本文件**绝不**自己去读 `tools_read` / `tools_write` 那两列（两份口径是本项目最贵的病）。
//    · **能不能跑**：`runReadTool()` 里的 `need` 守卫 —— 模块被整目录删掉时
//      原型上就没有那些方法了，此时该工具**不可用**（降级返回，⛔ 不抛；负向清单第 5 条）。
//
// ⚠️ ⛔ 这一整段**只读**：一条都不写库（方案 §13.2 步骤 2-1）。
//    写工具 `tasks.propose_create` 在落地，且**永远只生成提议**（在 `tools-write.js`）。
//
// ⚠️ ⛔ 取到的数据**不进日志**：本段没有任何 console，调用方也不许把结果写进日志
//    （方案 §13.2 步骤 2-4 / 负向清单第 7 条）。
//
// ⚠️ **返回面 = 出网面**：这里每多回一个字段，`READ_TOOLS[].returns` 与 `PANEL_READ` 的文案
//    都要跟着动（出网面变大必须可见，方案 §4.3 / §7.2）。

/** 功能：本地时区的 `YYYY-MM-DD`。 @param {Date} d - 时刻 @returns {string} 日期串 */
function dayStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 功能：把 `YYYY-MM-DD` 加 n 天（n 可为负）。 @param {string} s - 日期串 @param {number} n - 天数 @returns {string} 新的日期串 */
function shiftDay(s, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n);
  return dayStr(d);
}

/**
 * 功能：把 `YYYY-MM-DD` 换成「星期X」。
 *
 * 说明：⚠️ 用**星期一起始**的周（周一到周日）—— 与课表的周次口径一致
 *      （`timetable` 的 `start_monday`），别换成周日起始。
 * @param {string} s - 日期串
 * @returns {string} 「星期一」这类中文星期
 */
function weekdayCn(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const idx = (d.getDay() + 6) % 7; // 周一 = 0
  return `星期${'一二三四五六日'.charAt(idx)}`;
}

/** 功能：本周一（星期一起始）。 @param {string} s - 日期串 @returns {string} 本周一的日期串 */
function mondayOf(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return shiftDay(s, -((d.getDay() + 6) % 7));
}

/** 功能：`HH:MM`。 @param {Date} d - 时刻 @returns {string} 时刻串 */
function hhmm(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 功能：`HH:MM` → 分钟数。 @param {string} s - 时刻串 @returns {number} 距零点的分钟数；解不出为 -1 */
function minutesOf(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/**
 * 功能：构造一条**入参错**（400）—— 与 `routes.js` 的 `httpError` 同形状，供**读 / 写两侧**
 *      的执行器复用，避免为了一个错误类型把 `core/http.js` 拉进来（会连带建库）。
 *
 * 说明：⭐ 读侧（本文件）与写侧（`tools-write.js`）都用它 ⇒ 定义**只此一份**，写侧从本文件
 *      `require` 过去 —— 依赖方向因此恒为 `write → read`（0.7.6 拆分时定的口径）。
 * @param {number} status - HTTP 状态（本文件只用 400）
 * @param {string} message - 人话文案
 * @returns {Error} 带 `statusCode` 的错误
 */
function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

/**
 * 功能：读工具 `now.info` —— 服务端的「现在」。
 *
 * 说明：⭐ 时间**只以服务端为准**（模型的时钟是它自己猜的）：日期 / 周几 / 当前时刻 /
 *      本周剩余天数。⚠️ 这一条**不读用户任何数据**，所以它只需要总开关、不需要模块授权。
 * @param {Date} now - 服务端的当前时刻
 * @returns {{date: string, weekday: string, time: string, daysLeftInWeek: number}} 时间信息
 */
/** 日期的形状（全站一致：`YYYY-MM-DD`）。 @type {RegExp} */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 一次自定义区间最多多少天（防止模型一口气拉全库，也防止「去年」被理解成一整年）。 @type {number} */
const MAX_RANGE_DAYS = 366;

/**
 * 功能：读「模型自己给的日期区间」`{from, to}` —— **没给返回 null，给了但不合法一律 400**。
 *
 * 说明：⭐⭐ 0.8.55（「给ai更高的查询条件，可以让它自己选择日期、筛选条件」）：
 *      工具面原来把区间写死成 today/week/month/year 四档，于是「这个月和上个月比」这种
 *      再正常不过的问题，模型只能回「没有上月这一档」。数据本来就在库里 —— 是**接口太窄**。
 *      ⚠️ 三条硬规矩（都是「宁可 400，也别猜」）：
 *      ① `from`/`to` 必须**成对**给（只给一半就 400 —— 兜成「今天」会答出一份看起来像真的数）；
 *      ② 必须是 `YYYY-MM-DD`，且 `from <= to`（字典序比较，⛔ 不转 Date）；
 *      ③ 跨度 ≤ 366 天。
 *      ⚠️ 算跨度时用 `Date.parse('…T00:00:00Z')` —— **只算天数**，不参与任何显示或比较，
 *      所以不会踩「转 Date 丢时区」那个老坑（日期比较本身仍是字典序）。
 * @param {Object} args - 工具入参
 * @returns {?{from: string, to: string, days: number}} 闭区间；没给返回 null
 * @throws {Error} 只给一半 / 格式不对 / 顺序反了 / 跨度超限时抛 400
 */
function readCustomRange(args) {
  const a = args && typeof args === 'object' ? args : {};
  const from = String(a.from == null ? '' : a.from).trim();
  const to = String(a.to == null ? '' : a.to).trim();
  if (!from && !to) return null;
  if (!from || !to) throw httpError(400, '要自己指定区间就请把 from 和 to 一起给（YYYY-MM-DD）');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw httpError(400, '日期要写成 YYYY-MM-DD，例如 2026-09-01');
  }
  if (from > to) throw httpError(400, 'from 不能晚于 to');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (!Number.isFinite(days) || days < 1) throw httpError(400, '这组日期看不懂，请按 YYYY-MM-DD 重给');
  if (days > MAX_RANGE_DAYS) throw httpError(400, `一次最多查 ${MAX_RANGE_DAYS} 天，请分段问`);
  return { from, to, days };
}

function nowInfo(now) {
  const date = dayStr(now);
  // 「本周剩余天数」= 从今天（含）到本周日的天数：周一 ⇒ 7，周日 ⇒ 1
  const daysLeftInWeek = 7 - ((now.getDay() + 6) % 7);
  return { date, weekday: weekdayCn(date), time: hhmm(now), daysLeftInWeek };
}

/**
 * 功能：把一行任务行归一成**给模型看的那几个字段**（窄契约，方案 §4.3）。
 *
 * 说明：⚠️ 与 `core/store/methods/stats.js` 的 `dashboard()` 不同，这里**不**做「与区间有没有
 *      交集」的宽口径预筛（那是看板的事）；筛选由调用方按 `范围` 枚举做。
 *      ⚠️ 任务表**没有**「时刻」列、也**没有**独立的「优先级」列（只有 `important` / `urgent`
 *      两格四象限）—— 所以这里如实回两格布尔值，⛔ **不编**一个「高/中/低」出来。
 *
 * ⭐⭐ **0.8.55 全面体检（「几乎所有模块都有更新和变化」）**：任务板从 0.8.53 起
 *      有**三种任务类型**（普通 / 窗口 / 周期），而这份窄契约一直只回「标题 / 截止 / 四象限 /
 *      状态 / 项目」—— **周期任务的「身份证」被丢在这里**。后果与 0.8.54 修掉的看板那条
 *      一模一样（`stats.js` 的 `push()` 漏了 `task_kind`）：模型看到的就是「一条截止日
 *      已经过去了、还没完成的任务」⇒ 张口就说「你这个任务逾期了」，而它其实是一个
 *      **每一期都打完卡的周期任务**。⇒ 本次把 `kind` 与 `rule` 带上，并让 `overdue`
 *      那条筛选**整体不接周期任务**（周期任务没有「逾期」这个概念，它按「每一期」算）。
 *
 * ⚠️ `due` 对周期任务而言是**这一轮周期的结束日**（`due_date` 就是周期终点），
 *    ⛔ 别把它当「这条任务的截止时刻」去判逾期 —— 提示词里有一句专门说这件事。
 * @param {Object} row - 任务行
 * @param {string} project - 所属项目名（日常任务为空串）
 * @returns {Object} `{title, due, important, urgent, status, project, kind, rule}`
 */
function taskBrief(row, project) {
  // ⚠️ 认不出来的值一律按 `plain`（与 `modules/tasks/lib/tasks.js` 的整形同一条兜底）
  const kind = ['plain', 'window', 'cycle'].includes(String(row.task_kind || '')) ? String(row.task_kind) : 'plain';
  return {
    title: String(row.title || ''),
    due: String(row.due_date || row.start_date || ''),
    important: row.important ? 1 : 0,
    urgent: row.urgent ? 1 : 0,
    status: String(row.status || 'todo'),
    project: String(project || ''),
    kind,
    // ⚠️ 只有周期任务带规则；其余一律空串（⛔ 别把别的字段塞进这一格）
    rule: kind === 'cycle' ? String(row.recur_rule || '') : '',
  };
}

/**
 * 功能：读工具 `tasks.query` —— 按 `范围` 枚举取任务。
 *
 * 说明：⚠️ 取数走**任务板模块自己的 Store 方法**（`listDailyTasks` / `listProjects` /
 *      `listProjectTasks`），⛔ 不直连别人的表。这些方法缺失（任务板被整目录删掉）时
 *      由 `runReadTool()` 的守卫拦下，根本走不到这里。
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{range: string}} args - 归一后的入参
 * @param {string} today - 服务端今天 `YYYY-MM-DD`
 * @returns {Object} `{range, items}`
 * @throws {Error} `range` 不在枚举里时抛 400（⛔ 不静默按默认值处理）
 */
function tasksQuery(ctx, args, today) {
  const a = args && typeof args === 'object' ? args : {};
  // ⭐⭐ 0.8.55：**自己给区间（tasks）** —— 按「截止日落在 [from, to] 内」筛，含各种状态。
  //    为什么要它：「上周到期的有哪些」「9 月我都干了什么」这类问题，四档枚举答不了。
  const custom = readCustomRange(a);
  const range = String(a.range || '').trim();
  if (!custom && !['today', 'week', 'overdue', 'open'].includes(range)) {
    throw httpError(400, '范围只能是 today / week / overdue / open 之一，或者自己给 from/to（YYYY-MM-DD）');
  }
  const store = ctx.store;
  const uid = ctx.uid;
  const rows = [];
  store.listDailyTasks(uid).forEach((r) => rows.push(taskBrief(r, '')));
  store.listProjects(uid).forEach((p) => {
    store.listProjectTasks(uid, p.id).forEach((r) => rows.push(taskBrief(r, p.name)));
  });
  const from = custom ? custom.from : range === 'week' ? mondayOf(today) : today;
  const to = custom ? custom.to : range === 'week' ? shiftDay(from, 6) : today;
  const items = rows.filter((it) => {
    // ⭐ 0.8.55：自己给区间时，「没有截止日」的任务不进来（它不在任何区间里，硬塞会变成假答案）
    if (!it.due) return !custom && range === 'open';
    // 自己给区间 ⇒ 按截止日落在区间内，**含已完成**（问「上个月我做完哪些」很常见；
    // 每条都带 status 字段，模型自己分得清）
    if (custom) return it.due >= from && it.due <= to;
    // ⭐⭐ 0.8.55：**周期任务不进「逾期」**（下的同一条口径：
    //    「周期结束即算完成」由 `public/core/recur.js` 的 `cycleState()` 判，服务端不另造一套）。
    //    ⛔ 别把这一句理解成「周期任务不重要」—— 它们仍出现在今日 / 本周 / 未完成三个范围里。
    if (range === 'overdue') return it.kind !== 'cycle' && it.status !== 'done' && it.due < today;
    if (range === 'open') return it.status !== 'done';
    // 今日 / 本周：截止日落在区间里（含今天到期与本周到期的）
    return it.due >= from && it.due <= to;
  });
  items.sort((a, b) => String(a.due).localeCompare(String(b.due)) || a.title.localeCompare(b.title));
  // ⭐ 0.8.55：把实际筛的区间一起回（模型据此说「9 月 1 日到 30 日一共 N 条」，而不是含糊其辞）
  return { range: custom ? 'custom' : range, from, to, items };
}

/**
 * 功能：读工具 `timetable.range` / `timetable.next` 的公共取数 —— 走**看板那一份**课表展开。
 *
 * 说明：⭐ 复用 `store.dashboard()` 而不是自己去 `scheduleOf()` 展开：课表要变成
 *      「这几天的占用时段」得同时处理「按周次重复 + 单次调课 + 假期调休 + 逐节时间」，
 *      而那份实现**已经有一份**（`core/store/methods/stats.js` 的 `courseItems`）。
 *      自己再写一份 = 第二个真值，抄错的后果是「AI 说下午没课、而课表上有」。
 *      ⚠️⭐ **`dashboard().courses` 是数组**（就是 `course.items`，见 `stats.js` 里
 *      `courses: course.items,` 那一行；全项目另四处消费点也全按数组用）——
 *      ⛔ 别写成 `d.courses.items`：那恒为 `undefined` ⇒ 这个工具**永远回空**、
 *      AI 只会说「这段里没有课」（0.7.6 修的真 bug 就是这个，见 `ttt/test/ai.test.js`
 *      里那条契约护栏「`Array.isArray(...courses)`」）。
 *      ⚠️ 区间必须**有界**（`courseItems` 是按天循环的）：本文件的调用点最大只到 14 天
 *      （`next_week` = 下周一~下周日，`next` = 今天起 8 天）。
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {string} from - 区间起点
 * @param {string} to - 区间终点
 * @returns {{items: Array.<Object>, reason: string}} 占用时段（已剥掉课程备注正文）+ 取不到课程的原因
 */
function busySlots(ctx, from, to) {
  const d = ctx.store.dashboard(ctx.uid, { from, to });
  // ⚠️ 防一手非数组：模块被换掉 / 老结构时不至于把 `.map` 炸掉（那种报错模型看不懂）
  const items = d && Array.isArray(d.courses) ? d.courses : [];
  // ⚠️⭐ `reason` 只回**枚举值**（'' / 'no_term' / 'no_start_monday'），⛔ 绝不回任何用户内容；
  //    认不出来的值一律当空 —— 免得将来某个版本往里塞了自由文本，悄悄从工具面出网。
  const rawReason = String((d && d.course_reason) || '');
  const reason = ['no_term', 'no_start_monday'].includes(rawReason) ? rawReason : '';
  // ⚠️ ⛔ 只留「日期 / 起止时刻 / 课名 / 教室」：`remark`（本节备注）与 `course_remark`
  //    （课程备注）是**用户写的正文**，方案 §4.3 明写「⛔ 不带备注正文」（用例 20）。
  return {
    reason,
    items: items.map((c) => ({
      date: String(c.date || ''),
      weekday: weekdayCn(String(c.date || '')),
      start: String(c.start_time || ''),
      end: String(c.end_time || ''),
      name: String(c.name || ''),
      room: String(c.room || ''),
    })),
  };
}

/**
 * 功能：读工具 `timetable.range` —— 把课表当**不可用时段表**给模型。
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{days: string}} args - 归一后的入参
 * @param {string} today - 服务端今天
 * @returns {{from: string, to: string, reason: string, items: Array.<Object>}} 区间 + 空区间的原因 + 时段
 * @throws {Error} `days` 不在枚举里时抛 400
 */
function timetableRange(ctx, args, today) {
  const a = args && typeof args === 'object' ? args : {};
  // ⭐⭐ 0.8.55：**自己给区间（课表）** —— 「下周有没有课」「9 月 20 号那周的课」都能问。
  //    ⚠️ 上限收到 31 天（dashboard() 的课表展开是按天循环的，一次拉三个学期没有意义）。
  const custom = readCustomRange(a);
  if (custom && custom.days > 31) throw httpError(400, '课表一次最多查 31 天');
  const days = String(a.days || '').trim();
  if (!custom && !['today', 'week', 'next_week'].includes(days)) {
    throw httpError(400, '天数只能是 today / week / next_week 之一，或者自己给 from/to（YYYY-MM-DD）');
  }
  let from = custom ? custom.from : today;
  let to = custom ? custom.to : today;
  if (custom) {
    // 自定义区间：直接用
  } else if (days === 'week') {
    to = shiftDay(today, 6); // 今天起 7 天（含今天）
  } else if (days === 'next_week') {
    // ⚠️ 下周一 ~ 下周日：**周一起始**（与课表周次口径一致，见 `mondayOf` 的说明）
    from = shiftDay(mondayOf(today), 7);
    to = shiftDay(from, 6);
  }
  const r = busySlots(ctx, from, to);
  // ⚠️⭐ `reason` 必须回：区间是空的可能是「真没课」，也可能是「**课表还没填开学日期**」——
  //    不带上它，模型只能说「这段里没有课」（真机上撞到的就是这个）。
  return { from, to, reason: r.reason, items: r.items };
}

/**
 * 功能：读工具 `timetable.next` —— 下一节课（含「还有多久上课」）。
 * @param {{store: Object, uid: number, now: Date}} ctx - 执行上下文
 * @param {string} today - 服务端今天
 * @returns {Object} `{date, start, end, name, room, minutesUntil}`；没有下一节课时为 `{none: true}`
 */
function timetableNext(ctx, today) {
  const nowMin = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  const items = busySlots(ctx, today, shiftDay(today, 7)).items;
  for (const it of items) {
    if (it.date < today) continue;
    const endMin = minutesOf(it.end);
    if (it.date === today && endMin >= 0 && endMin <= nowMin) continue; // 今天已经下课了
    return { ...it, minutesUntil: it.date === today ? Math.max(0, minutesOf(it.start) - nowMin) : null };
  }
  return { none: true };
}

/**
 * 功能：读工具 `ledger.bill` —— 一个区间的收支（合计 ＋ 支出分类 ＋ 最近几笔）。
 *
 * 说明：⭐ 取数走**记账模块自己的**业务方法 `store.ledgerAiStats()`（⛔ 不直连它的表），
 *      那边与账单 / 预算 / 月详情同源（`statRowsOf()` 合并流）。
 *      ⚠️⭐ 金额**一律保留「分」**（⛔ 不在这里除 100）—— 换算成元是**说给人听**的那一步，
 *      由模型在回答里做；工具层做换算就会让「元」这个单位在下游各处再被除一次。
 *      ⚠️ 只挑模型用得上的字段：分类只给「名称 / 金额 / 占比」（⛔ 不给 id）、
 *      最近几笔只给「时间 / 收支 / 金额 / 分类 / 账户名」（⛔ 不给备注正文 —— 那是用户写的自由文本）。
 *
 * @param {{store: Object, uid: number, now: Date}} ctx - 执行上下文
 * @param {{range: string}} args - 归一后的入参
 * @returns {Object} 区间账单（形状见下）
 * @throws {Error} `range` 不在枚举里时抛 400
 */
function ledgerBill(ctx, args) {
  const a = args && typeof args === 'object' ? args : {};
  // ⭐⭐ 0.8.55：**模型可以自己给日期区间**（from/to），不必挤在四档枚举里。
  //    ⚠️ 自己给了区间就以区间为准，`range` 那格忽略（不混用 —— 混用会让「到底按哪个筛」说不清）。
  const custom = readCustomRange(a);
  const range = String(a.range || '').trim();
  if (!custom && !['today', 'week', 'month', 'year'].includes(range)) {
    throw httpError(400, '范围只能是 today / week / month / year 之一，或者自己给 from/to（YYYY-MM-DD）');
  }
  // ⭐ 0.8.55：分类筛选（可选）—— 分类名由服务端在**本机**核对，查无此分类时不会假装「花了 0 元」
  const category = String(a.category == null ? '' : a.category).trim();
  const r =
    ctx.store.ledgerAiStats(ctx.uid, custom ? 'custom' : range, ctx.now.getTime(), {
      from: custom ? custom.from : '',
      to: custom ? custom.to : '',
      category,
    }) || {};
  const fen = (v) => Math.trunc(Number(v)) || 0;
  return {
    range: String(r.range || range),
    from: String(r.from || ''),
    to: String(r.to || ''),
    // ⭐ 0.8.55：把「筛了什么」带出去 —— `category_found === false` 表示本机没有这个分类，
    //    模型据此说「没找到这个分类」，而不是答一句「这个分类花了 0 元」。
    category: r.category == null ? null : String(r.category),
    category_found: r.category_found == null ? null : !!r.category_found,
    income_fen: fen(r.income_fen),
    expense_fen: fen(r.expense_fen),
    net_fen: fen(r.net_fen),
    count: Number(r.count) || 0,
    categories: (Array.isArray(r.categories) ? r.categories : []).map((c) => ({
      name: String((c && c.name) == null ? '' : c.name),
      amount_fen: fen(c && c.amount_fen),
      // ⚠️ 占比可能为 `null`（这一侧合计为 0 ⇒ 分母不存在）—— 原样带出，⛔ 不兜成 0
      pct: c && c.pct != null ? Number(c.pct) : null,
    })),
    recent: (Array.isArray(r.recent) ? r.recent : []).map((x) => ({
      at: String((x && x.at) == null ? '' : x.at),
      ie: String((x && x.ie) == null ? '' : x.ie),
      amount_fen: fen(x && x.amount_fen),
      category: String((x && x.category) == null ? '' : x.category),
      account: String((x && x.account) == null ? '' : x.account),
    })),
  };
}

/**
 * 功能：读工具 `ledger.budget` —— 某档（周 / 月 / 年）的预算进度。
 *
 * 说明：⚠️⭐ **档位只有周 / 月 / 年**（⛔ 没有「当天」）—— 「一天的预算」在本产品里不是个概念，
 *      硬造一个只会让模型排出「今天预算剩 3 元」这种没有依据的话。
 *      ⚠️ 该期的 `period_key` = 这一期的**起始日**：周档给**周一**（预算的周档是自然周，
 *      ⛔ 不是账单那个「该月 1 号」的口径 —— 两处口径不同，见 `checkPeriodKey` 的 `weekMode`）。
 *      ⚠️ 取数走记账模块自己的 `store.ledgerBudgetView()`（含**自动继承上一期**那条口径）。
 *
 * @param {{store: Object, uid: number, now: Date}} ctx - 执行上下文
 * @param {{range: string}} args - 归一后的入参
 * @param {string} today - 服务端今天 `YYYY-MM-DD`
 * @returns {Object} `{period, from, to, total, categories}`
 * @throws {Error} `range` 不在枚举里时抛 400
 */
function ledgerBudget(ctx, args, today) {
  const range = String((args && args.range) || '').trim();
  if (!['week', 'month', 'year'].includes(range)) {
    throw httpError(400, '档位只能是 week / month / year 这三个之一');
  }
  const key =
    range === 'week'
      ? mondayOf(today)
      : range === 'month'
        ? `${String(today).slice(0, 7)}-01`
        : `${String(today).slice(0, 4)}-01-01`;
  const v = ctx.store.ledgerBudgetView(ctx.uid, range, key, ctx.now.getTime()) || {};
  const block = (b) => {
    const s = b && typeof b === 'object' ? b : {};
    const fen = (v2) => Math.trunc(Number(v2)) || 0;
    return {
      amount_fen: fen(s.amount_fen),
      used_fen: fen(s.used_fen),
      remain_fen: fen(s.remain_fen),
      remain_pct: s.remain_pct != null ? Number(s.remain_pct) : null,
      overspent: !!s.overspent,
      set: !!s.set,
    };
  };
  return {
    period: String(v.period_type || range),
    from: String(v.from || ''),
    to: String(v.to || ''),
    total: block(v.total),
    categories: (Array.isArray(v.categories) ? v.categories : []).slice(0, 20).map((c) => ({
      name: String((c && c.name) == null ? '' : c.name),
      ...block(c),
    })),
  };
}

/**
 * 功能：读工具 `ledger.assets` —— 此刻的资产 / 负债 / 净值 ＋ 各账户余额。
 *
 * 说明：⚠️ 取数走记账模块自己的 `store.ledgerAiAssets()`（与资产屏同一份 `deriveLedger()` ＋
 *      `summarize()`，只是**不 seed**）—— 所以 AI 说的净值与用户屏幕上那个数逐字一致。
 *      ⚠️ 账户名是**用户自己起的**（可能是「工资卡」这种），出网面已在 `PANEL_READ.ledgerRead`
 *      里说明；⛔ 不带账户 id（模型用不上）。
 *
 * @param {{store: Object, uid: number, now: Date}} ctx - 执行上下文
 * @returns {Object} `{today, asset_fen, debt_fen, net_fen, accounts}`
 */
function ledgerAssets(ctx) {
  const a = ctx.store.ledgerAiAssets(ctx.uid, ctx.now.getTime()) || {};
  const fen = (v) => Math.trunc(Number(v)) || 0;
  return {
    today: String(a.today || ''),
    asset_fen: fen(a.asset_fen),
    debt_fen: fen(a.debt_fen),
    net_fen: fen(a.net_fen),
    accounts: (Array.isArray(a.accounts) ? a.accounts : []).map((x) => ({
      name: String((x && x.name) == null ? '' : x.name),
      kind_name: String((x && x.kind_name) == null ? '' : x.kind_name),
      side: String((x && x.side) == null ? '' : x.side),
      balance_fen: fen(x && x.balance_fen),
    })),
  };
}

// ==================== ⭐ 0.8.5：收藏夹 / 随手记 / 硬件 三块 ====================
//
// ⚠️ 三块的取数**都走对应模块自己的业务方法**（`listBookmarks` / `listIdeas` / `listHardware`），
//    ⛔ 不直连别人的表。那三个方法都是**纯只读**的（不 seed、不写库）——
//    所以这里不像记账那样需要另写一个「不 seed 的取数口」。
// ⚠️ 三块都只回**该账号自己的行**（业务方法内部按 `user_id` 收口）。

/** 一次给模型看多少条收藏（再多请用分类筛） @type {number} */
const BOOKMARK_LIMIT = 50;

/** 一次给模型看多少条随手记 @type {number} */
const IDEA_LIMIT = 30;

/** 每条随手记正文最多给模型多少个字（**截断**，⛔ 不摘要） @type {number} */
const IDEA_TEXT_LIMIT = 200;

/** 一次给模型看多少条台账 @type {number} */
const HARDWARE_LIMIT = 50;

/**
 * 功能：从网址里取主机名 —— ⭐ 出网面**只到域名这一层**。
 *
 * 说明：⚠️ 完整 URL 可能带着查询串（单号 / 一次性 token / 私人参数），而那些是用户
 *      没打算外发的东西；模型用域名就够了（「我收藏过 github 没有」）。
 *      解析不出来的一律回**空串** —— ⛔ 不回落成原串，那等于把「解析失败」偷偷变成
 *      「照样发出去」。
 *
 * @param {string} url - 收藏里存的地址
 * @returns {string} 主机名；解析不出来时为空串
 */
function hostOf(url) {
  try {
    return new URL(String(url || '')).host || '';
  } catch (_e) {
    return '';
  }
}

/**
 * 功能：读工具 `bookmarks.query` —— 收藏夹的标题 / 域名 / 分类 / 来源。
 *
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{tag: string}} args - 归一后的入参
 * @returns {Object} `{tag, total, tags, count, items}`
 */
function bookmarksQuery(ctx, args) {
  const tag = String((args && args.tag) == null ? '' : args.tag).trim();
  const r = ctx.store.listBookmarks(ctx.uid, '', null) || {};
  const all = Array.isArray(r.items) ? r.items : [];
  const hit = tag ? all.filter((b) => ((b && b.tag_names) || []).some((n) => String(n) === tag)) : all;
  return {
    tag,
    // ⚠️「一共收了多少条」与「这次给了你几条」**分开写**：截断不该被读成「就这么多」
    total: all.length,
    // ⚠️⭐ 0.8.15：`listBookmarks()` 的响应里从本版起多了一项「未分类」**哨兵**
    //    （`{ id:'none', name:'未分类', count }`，给界面筛选下拉用）—— 它是**视图项、不是分类**。
    //    这里是给模型看的「**你能按什么筛**」清单，把「未分类」混进去等于告诉模型用户有一个
    //    叫「未分类」的分类（而它根本筛不出东西）。⇒ 只留**真分类**。
    //    ⚠️ 判据取「`id` 是不是数字」而不是去比字面量 `'none'`：真分类的 `id` 一定来自
    //    `bookmark_tags.id`（数据库自增 ⇒ 数字），视图项不是 —— 这样 AI 模块不必知道别家的哨兵字面量。
    tags: (Array.isArray(r.tags) ? r.tags : [])
      .filter((t) => t && typeof t.id === 'number')
      .map((t) => String((t && t.name) == null ? '' : t.name))
      .filter(Boolean),
    count: hit.length,
    items: hit.slice(0, BOOKMARK_LIMIT).map((b) => ({
      title: String((b && b.title) || '') || hostOf(b && b.url),
      host: hostOf(b && b.url),
      tags: ((b && b.tag_names) || []).map((n) => String(n)),
      source: String((b && b.source) || '') === 'import' ? '导入' : '自己存的',
    })),
  };
}

/**
 * 功能：读工具 `idea.query` —— 随手记的正文（截断）＋ 标签 ＋ 时间。
 *
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{view: string}} args - 归一后的入参
 * @returns {Object} `{view, total, inbox, archived, count, items}`
 * @throws {Error} `view` 不在枚举里时抛 400
 */
function ideaQuery(ctx, args) {
  const view = String((args && args.view) == null ? '' : args.view).trim();
  if (!['inbox', 'archived', 'all'].includes(view)) {
    throw httpError(400, '范围只能是 inbox / archived / all 这三个之一');
  }
  const r = ctx.store.listIdeas(ctx.uid, { view }) || {};
  const all = Array.isArray(r.items) ? r.items : [];
  return {
    view,
    total: Number(r.total) || 0,
    inbox: Number(r.inbox) || 0,
    archived: Number(r.archived) || 0,
    count: all.length,
    items: all.slice(0, IDEA_LIMIT).map((it) => {
      const content = String((it && it.content) || '');
      return {
        content: content.slice(0, IDEA_TEXT_LIMIT),
        // ⚠️ 被截断**要说出来**：不然模型会把它当全文，「你记的是……」就漏掉后半段
        truncated: content.length > IDEA_TEXT_LIMIT,
        tag: String((it && it.tag) || ''),
        at: String((it && it.created_at) || ''),
        archived: !!(it && it.archived),
      };
    }),
  };
}

/**
 * 功能：读工具 `hardware.query` —— 台账 ＋ 服务端算好的寿命。
 *
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{range: string}} args - 归一后的入参
 * @returns {Object} `{range, total, alert, count, items}`
 * @throws {Error} `range` 不在枚举里时抛 400
 */
function hardwareQuery(ctx, args) {
  const range = String((args && args.range) == null ? '' : args.range).trim();
  if (!['all', 'owned', 'wishlist', 'retired', 'alert'].includes(range)) {
    throw httpError(400, '范围只能是 all / owned / wishlist / retired / alert 这五个之一');
  }
  /** @type {Object} */
  const opts = range === 'all' ? {} : range === 'alert' ? { focus: 'alert' } : { status: range };
  const r = ctx.store.listHardware(ctx.uid, opts) || {};
  const all = Array.isArray(r.items) ? r.items : [];
  const s = r.summary || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    range,
    // 「一共几件」用汇总里的全量数（它**不随筛选变化** —— 与界面上那排计数同一口径）
    total: Number(s.total) || 0,
    alert: Number(s.alert) || 0,
    count: all.length,
    items: all.slice(0, HARDWARE_LIMIT).map((h) => {
      const life = (h && h.life) || {};
      return {
        name: String((h && h.name) || ''),
        status: String((h && h.status) || ''),
        category: String((h && h.category) || ''),
        model: [(h && h.brand) || '', (h && h.model) || ''].filter(Boolean).join(' '),
        purchased: String((h && h.purchase_date) || ''),
        // ⚠️ 单位是**元**（硬件表存的就是元）；⛔ 不回 `wish_url` / `serial` / `location` / `note`
        price: num(h && h.purchase_price),
        // ⚠️ 寿命只回**服务端算好的那几样**（`lib/life.js` 是唯一的算法）——
        //    ⛔ 不在这里造「健康度 %」：这个模块从 1 期起就守着「不编数据」那条线。
        life: life.known
          ? {
              used_months: num(life.usedMonths),
              remain_months: num(life.remainMonths),
              due_date: String(life.dueDate || ''),
            }
          : null,
      };
    }),
  };
}

/**
 * 读工具的**执行表**：`need` 是「跑它必须先有的 Store 方法」（守卫用），`run` 是执行体。
 *
 * 说明：⭐ `now.info` 的 `need` 是空数组 —— 它不读任何用户数据，所以谁都不依赖。
 * @type {Object.<string, {need: Array.<string>, run: Function}>}
 */
/**
 * 功能：`trips.query` 的执行体 —— ⭐ **只回白名单字段**（返回面 = 出网面）。
 *
 * 说明：⚠️ 真正的取数与字段筛选在**行程模块自己的** `store.tripAiUpcoming()` 里
 *      （方案 §5.3：⛔ 不给 AI 单独开一条读数据的路 —— 那会变成第二份口径，
 *      而且「哪些字段出网」就散在两处了）。本函数只负责「入参归一 + 转手」。
 *      ⚠️ **窄契约**：只认 `upcoming` / `recent` 两个枚举值，认不出来**一律按默认**
 *      （⛔ 不收自由文本；⛔ 也不为这个报错打断整轮对话 —— 模型给个没见过的范围
 *      不该让用户看到「参数错误」）。
 *
 * @param {Object} ctx - `{ store, uid, now }`
 * @param {Object} args - 模型给的入参（只认 `range`）
 * @param {string} today - 服务端今天 `YYYY-MM-DD`
 * @returns {Object} `{ range, reason, trips, tickets }`（字段白名单见 `tripAiUpcoming`）
 */
function tripsQuery(ctx, args, today) {
  const raw = args && typeof args === 'object' ? args.range : null;
  const range = String(raw == null ? '' : raw).trim() === 'recent' ? 'recent' : 'upcoming';
  return ctx.store.tripAiUpcoming(ctx.uid, range, today);
}

/**
 * 功能：读工具 `assets.query` —— 个人资产台账（分组树 ＋ 条目金额）。
 *
 * 说明：⭐ 取数走资产模块自己的 `listAssetGroups()` / `listAssetItems()`（⛔ 不直连它的表）。
 *      ⚠️⭐ **`listAssetGroups()` 有懒播种副作用**（一行都没有时会建两个默认分组）——
 *      这是那个模块自己的读方法，界面读它也是同样的行为，所以这里不另造一条只读副本
 *      （造了就是第二份真值，而且「AI 看过一眼就多两个分组」与「用户打开那一屏」完全等价）。
 *      ⛔ **备注（`note`）不回**：那是用户写的正文，与硬件的「详述」、收藏夹的「完整网址」同一族。
 *      ⚠️ 金额单位是**分**（与记账那三条同一个坑），提示词里已有换算法则。
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{group: string}} args - 归一后的入参（`group` 为空 = 全部分组）
 * @returns {{reason: string, total_fen: number, count: number, groups: Array.<Object>, items: Array.<Object>}}
 *      合计 ＋ 分组 ＋ 条目（`reason` = ok / empty）
 */
function assetsQuery(ctx, args) {
  const want = String((args && args.group) || '').trim();
  const tree = ctx.store.listAssetGroups(ctx.uid) || {};
  const groups = Array.isArray(tree.groups) ? tree.groups : [];
  const items = (ctx.store.listAssetItems(ctx.uid, null) || {}).items || [];
  const byId = new Map(groups.map((g) => [Number(g.id), g]));

  // ⚠️ 分组名筛选：命中一个分组时**连它的子分组一起算**（用户说的「我的设备」当然是整棵树）
  const keep = new Set();
  if (want) {
    const hit = groups.filter((g) => String(g.name || '') === want);
    for (const h of hit) {
      keep.add(Number(h.id));
      // 子分组：按 parent_id 往下走（树已经摊平成带 depth 的数组，但父子关系仍靠 parent_id）
      let added = true;
      while (added) {
        added = false;
        for (const g of groups) {
          const pid = g.parent_id == null || g.parent_id === '' ? null : Number(g.parent_id);
          if (pid === null || keep.has(Number(g.id))) continue;
          if (keep.has(pid)) {
            keep.add(Number(g.id));
            added = true;
          }
        }
      }
    }
    if (!keep.size) return { reason: 'empty', total_fen: 0, count: 0, groups: [], items: [] };
  }

  const picked = items.filter((it) => {
    if (!want) return true;
    const gid = it.group_id == null || it.group_id === '' ? null : Number(it.group_id);
    return gid !== null && keep.has(gid);
  });
  if (!picked.length) return { reason: 'empty', total_fen: 0, count: 0, groups: [], items: [] };

  // 每组的条目数与金额合计（一次遍历，⛔ 不为每个分组再扫一遍）
  const stat = new Map();
  let total = 0;
  for (const it of picked) {
    const gid = it.group_id == null || it.group_id === '' ? null : Number(it.group_id);
    const fen = Number(it.amount_fen);
    if (Number.isFinite(fen)) total += fen;
    if (gid === null) continue;
    const cur = stat.get(gid) || { count: 0, fen: 0 };
    cur.count += 1;
    if (Number.isFinite(fen)) cur.fen += fen;
    stat.set(gid, cur);
  }

  return {
    reason: 'ok',
    total_fen: total,
    count: picked.length,
    // ⚠️ 逐字段白名单搬运（⛔ 不是 `{...g}`）：多带一个 `module_key` / `icon` 都是白出网
    groups: groups
      .filter((g) => !want || keep.has(Number(g.id)))
      .slice(0, 40)
      .map((g) => ({
        name: String(g.name || ''),
        depth: Number(g.depth) || 0,
        count: (stat.get(Number(g.id)) || {}).count || 0,
        total_fen: (stat.get(Number(g.id)) || {}).fen || 0,
      })),
    items: picked.slice(0, 60).map((it) => {
      const gid = it.group_id == null || it.group_id === '' ? null : Number(it.group_id);
      return {
        name: String(it.name || ''),
        group: gid !== null && byId.has(gid) ? String(byId.get(gid).name || '') : '',
        // ⚠️ 空金额回 null（「这套房没记金额」与「这套房值 0 元」是两件事，⛔ 别糊成 0）
        amount_fen: Number.isFinite(Number(it.amount_fen)) && it.amount_fen != null ? Number(it.amount_fen) : null,
        date: String(it.date || ''),
      };
    }),
  };
}

/**
 * 功能：读工具 `calendar.query` —— 用户**自己建的**日程（⛔ 不含课表 / 任务 / 假期三个派生图层）。
 *
 * 说明：⚠️ 只走 `listCalendarEvents()`（那是「事件」这张表本身），⛔ 不走 `calendarLayer()`——
 *      后者会把课表与任务截止日也拌进来，于是同一个问题在 AI 这边会有**三份答案**
 *      （课表走 `timetable.range`、任务走 `tasks.query`），而三份口径迟早不一致。
 *      ⛔ 备注（`note`）不回：用户写的正文，不外发。
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{days: string}} args - 归一后的入参
 * @param {string} today - 服务端今天 `YYYY-MM-DD`
 * @returns {{from: string, to: string, reason: string, items: Array.<Object>}} 区间 ＋ 日程
 * @throws {Error} `days` 不在枚举里时抛 400
 */
function calendarQuery(ctx, args, today) {
  const a = args && typeof args === 'object' ? args : {};
  // ⭐⭐ 0.8.55：**自己给区间（日历）** —— 「下个月有什么安排」「9 月那两周」都问得了
  const custom = readCustomRange(a);
  const days = String(a.days || 'week').trim();
  if (!custom && !['today', 'week', 'next_week', 'month'].includes(days)) {
    throw httpError(400, '范围只能是 today / week / next_week / month 之一，或者自己给 from/to（YYYY-MM-DD）');
  }
  let from = custom ? custom.from : today;
  let to = custom ? custom.to : today;
  if (custom) {
    // 自定义区间：直接用
  } else if (days === 'week') to = shiftDay(today, 6);
  else if (days === 'next_week') {
    from = shiftDay(mondayOf(today), 7);
    to = shiftDay(from, 6);
  } else if (days === 'month') to = shiftDay(today, 29);
  const rows = ctx.store.listCalendarEvents(ctx.uid, from, to) || [];
  return {
    from,
    to,
    reason: rows.length ? 'ok' : 'empty',
    items: rows.slice(0, 60).map((r) => ({
      title: String(r.title || ''),
      date: String(r.date || ''),
      end_date: String(r.end_date || ''),
      all_day: r.all_day ? 1 : 0,
      start: String(r.start_time || ''),
      end: String(r.end_time || ''),
    })),
  };
}

/**
 * 功能：读工具 `pomodoro.query` —— 今天 / 本周的专注与休息统计。
 *
 * 说明：⚠️ 只回**计数与时长**，⛔ 一个任务名都不带（番茄钟那几条会话记的是时长，不记任务）。
 * @param {{store: Object, uid: number, now: Date}} ctx - 执行上下文
 * @param {{range: string}} args - 归一后的入参
 * @returns {{range: string, focus_count: number, focus_minutes: number, break_count: number, break_minutes: number}}
 *      统计（字段名写成模型一眼能懂的样子，⛔ 不把 `breaks` 那种嵌套形状丢给它）
 */
function pomodoroQuery(ctx, args) {
  const raw = String((args && args.range) || 'today').trim();
  // ⚠️ 认不出来按 today（⛔ 不为一个枚举值打断整轮对话 —— 与 `tripsQuery` 同一条宽容口径）
  const range = raw === 'week' ? 'week' : 'today';
  const s = ctx.store.pomodoroStats(ctx.uid, range, ctx.now.getTime()) || {};
  const br = s.breaks || {};
  return {
    range,
    focus_count: Number(s.count) || 0,
    focus_minutes: Number(s.minutes) || 0,
    break_count: Number(br.count) || 0,
    break_minutes: Number(br.minutes) || 0,
  };
}

/**
 * 功能：读工具 `collab.query` —— 我参与的协作项目与其中的任务（⭐ 选的口径：
 *      **只读我参与的**）。
 *
 * 说明：⭐ 取数走协作自己的 `listCollabProjects()` / `collabTasks()` —— 判权**只住服务端**
 *      （`collabTasks()` 内部就过 `assertCollabVisible()`，⛔ 本函数不自己判「我能不能看」，
 *      那是第二份判据）。
 *      ⛔ **对话、评论正文、附件、上报内容、成员 id 与登录名一律不回**：
 *      负责人只回**显示名**（那是他在这个协作项目里本来就用着的名字；为空就不给，
 *      ⛔ 绝不拿登录名顶上 —— 登录名是账号信息，别人不该从 AI 嘴里听到）。
 *      ⚠️ 每个项目最多 30 条**未完成**任务：项目可能有几百条，全塞给模型既贵又没用。
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @returns {{reason: string, projects: Array.<Object>}} 项目 ＋ 任务（`reason` = ok / empty）
 */
function collabQuery(ctx) {
  const r = ctx.store.listCollabProjects(ctx.uid) || {};
  const list = Array.isArray(r.items) ? r.items : [];
  if (!list.length) return { reason: 'empty', projects: [] };
  const nameOf = (id) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    const u = typeof ctx.store.getUser === 'function' ? ctx.store.getUser(n) : null;
    // ⚠️ 只用显示名（⛔ 不回落 username）
    return u ? String(u.display_name || '').trim() : '';
  };
  return {
    reason: 'ok',
    projects: list.slice(0, 20).map((p) => {
      const rows = ctx.store.collabTasks(ctx.uid, p.id) || [];
      const open = rows.filter((t) => String(t.status || '') !== 'done');
      return {
        name: String(p.name || ''),
        role: p.role === 'owner' ? 'owner' : 'member',
        task_total: rows.length,
        task_open: open.length,
        tasks: open.slice(0, 30).map((t) => ({
          title: String(t.title || ''),
          status: String(t.status || ''),
          assignee: nameOf(t.assignee_id),
          due: String(t.due_date || ''),
        })),
      };
    }),
  };
}

const READ_EXEC = {
  'now.info': { need: [], run: (ctx) => nowInfo(ctx.now) },  'tasks.query': {
    need: ['listDailyTasks', 'listProjects', 'listProjectTasks'],
    run: (ctx, args, today) => tasksQuery(ctx, args, today),
  },
  'timetable.range': {
    need: ['dashboard'],
    run: (ctx, args, today) => timetableRange(ctx, args, today),
  },
  // ⚠️ 形参位必须与 `runReadTool()` 的调用形状 `run(ctx, args, today)` 对上 ——
  //    `timetable.next` 不看入参，但**中间那一位不能省**（省了就把 `today` 挤给了 args）。
  'timetable.next': { need: ['dashboard'], run: (ctx, _args, today) => timetableNext(ctx, today) },
  // ⚠️ 记账那三条：`need` 写的是**记账模块自己的业务方法名** —— 记账被整目录删掉时
  //    原型上就没有它们，`runReadTool()` 的守卫据此回 503 降级（⛔ 不抛）。
  'ledger.bill': { need: ['ledgerAiStats'], run: (ctx, args) => ledgerBill(ctx, args) },
  'ledger.budget': { need: ['ledgerBudgetView'], run: (ctx, args, today) => ledgerBudget(ctx, args, today) },
  'ledger.assets': { need: ['ledgerAiAssets'], run: (ctx) => ledgerAssets(ctx) },
  // ⚠️ 0.8.5 那三条：`need` 同样是**那个模块自己的业务方法名**（都是只读的列表方法）——
  //    模块被整目录删掉时守卫回 503 降级（⛔ 不抛）。
  'bookmarks.query': { need: ['listBookmarks'], run: (ctx, args) => bookmarksQuery(ctx, args) },
  'idea.query': { need: ['listIdeas'], run: (ctx, args) => ideaQuery(ctx, args) },
  'hardware.query': { need: ['listHardware'], run: (ctx, args) => hardwareQuery(ctx, args) },
  // ⚠️ 0.8.6：`need` 同样是**行程自己的业务方法名**（`tripAiUpcoming`）——
  //    行程被整目录删掉时原型上就没有它，守卫据此回 503 降级（⛔ 不抛）。
  'trips.query': { need: ['tripAiUpcoming'], run: (ctx, args, today) => tripsQuery(ctx, args, today) },
  // ⭐⭐ 0.8.55 全面体检：四块新读数 —— `need` 同样写**那个模块自己的业务方法名**，
  //    模块被整目录删掉时守卫据此回 503 降级（⛔ 不抛）。
  //    ⚠️ `collab` 那一条多要一个 `getUser`：负责人显示名要查账号表（只取 `display_name`）。
  'assets.query': { need: ['listAssetGroups', 'listAssetItems'], run: (ctx, args) => assetsQuery(ctx, args) },
  'calendar.query': {
    need: ['listCalendarEvents'],
    run: (ctx, args, today) => calendarQuery(ctx, args, today),
  },
  'pomodoro.query': { need: ['pomodoroStats'], run: (ctx, args) => pomodoroQuery(ctx, args) },
  'collab.query': { need: ['listCollabProjects', 'collabTasks'], run: (ctx) => collabQuery(ctx) },
};

module.exports = {
  READ_MODULES,
  PANEL_READ,
  READ_TOOLS,
  READ_EXEC,
  // ⚠️ 这两条是**读写两侧共用**的基础件（写侧从本文件取 `httpError`；`dayStr` 另被
  //    `tools.js` 的 `execOnce()` 用来算 `today`）—— 别把它们挪进哪个执行器内部。
  dayStr,
  httpError,
};
