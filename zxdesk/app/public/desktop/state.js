/**
 * desktop/state.js —— 应用状态（唯一的可变真值，视图只读它）
 *
 * 功能：定义并导出电脑版的全局状态对象 `state`，字段覆盖项目与任务列表、当前作用域与视图、
 *      日期轴与看板的选中状态、今日待办数与首页汇总、数据层健康与只读标记、搜索与详情弹窗、
 *      当前登录账号与成员管理，以及课表视图的一整套临时状态；
 *      另导出 `scopeKey()`，把作用域标识统一成存储层使用的键。
 *
 * ⚠️ `state` 是**唯一的可变真值**：各视图只读它、不各自留副本；改数据一律改它身上的字段
 *    （ESM 的 import 是只读视图，不能整体重新赋值）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.33
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

// ---------- 状态 ----------
export const state = {
  projects: [], // 项目列表（侧栏、看板与项目选择处都读它）
  tasks: [], // 当前作用域的任务列表（切作用域时由 loadBoard 覆盖）
  // ⭐ 0.5.2：`scope` 多一个取值 `'all'` —— **汇总任务视图**：四象限里汇总显示**所有项目**的任务
  //    （「项目任务默认显示汇总任务视图」）。⚠️ 它是**视图**不是项目：
  //    勾选 / 编辑 / 删除一律按任务自己那个项目走（`taskScope()`），⛔ 不要拿它去拼 REST 路径。
  scope: 'all', // 'all' 汇总 | 'daily' 日常任务 | 项目 id
  view: 'board', // 'home' 首页汇总 | 'projects' 项目任务 | 'board' 任务板 | 'search' 搜索结果
  weekStart: null, // 当前显示周的周一日期
  selectedDate: null, // 选中日期（四象限显示该日任务）
  boardPane: 'quad', // 看板当前视图：'quad' 四象限 | 'timeline' 时间轴（二选一，不同屏）
  // ⭐ 0.8.7：任务板那一屏**屏头那颗药丸**当前选的是哪一块 —— 空串 = 任务板自己
  //    （默认，也是药丸的第一项），其余 = 某个模块借这一屏的位置贡献的视图（**模块名**，
  //    由接线表的 `slots: ['board-pane']` 声明，0.8.7 起是 `idea`）。
  //    ⚠️⚠️ 与上面的 `boardPane` **不是一回事**：那个是任务板内部「四象限 / 甘特图」的二选一，
  //    这个是「任务板 ｜ 随手记」这一层。⛔ 别拿一个字段兼两个语义 ——
  //    那是「一个词指两件事」的老坑（与 `lgView` / `lgSeg` 被拆开同一条理由）。
  boardTab: '',
  // ⭐⭐ 0.8.10：进「个人资产管理」那一屏时**要落到哪一格**（模块名；空串 = 不指定）。
  //    蹭它的是「从别的屏进借住的模块」那几条路 —— 0.8.10 起数码管理 / 生活记账撤了 `nav`、
  //    撤了 `hub`，不再有自己的一屏，界面挂进资产屏的药丸；于是「点一条硬件类事项」这类入口
  //    只点侧栏那扇门，**落到哪一格得由这个字段带过去**（`desktop/views/home.js` 写，
  //    `modules/assets/desktop.js` 画屏时读走并**立刻清空**）。
  //    ⚠️ 用掉即清是判据不是省事：不清的话「这次进去停在数码管理」会被下一次进屏继承。
  //    ⚠️ 与手机端的 `assetsWant`（住在宿主 `mobile/app.js`）是同一条设计思路，两端不必逐字一致。
  assetsWant: '',
  // ⭐⭐ 0.8.10：**现在挂在「个人资产管理」那一屏里的是哪个模块**（模块名；空串 =
  //    自建分组 / 还没画）。由 `modules/assets/desktop.js` 画屏时写（与手机端的
  //    `state.assetsPane` 同口径）—— 它答的是「那一格上是谁」。
  //    ⚠️⭐ 为什么借屏的模块**必须有人写这一项**：那几家的界面搬进资产屏之后 `state.view`
  //    恒为 `'assets'`，任何「按屏名判自己在不在场」的代码都会**永远判错**，而且是静默的。
  //    第一个用户就是记账的翻页闸门（`modules/ledger/desktop.js` 的 `maybeLoadMore()`：
  //    判错 = 滚到底不翻页）。⚠️ 离开那一屏**不会自动清空**（与手机端同款）⇒ 读它的地方
  //    必须**一起要求 `state.view === 'assets'`**（`.main` 是全端共用的滚动容器）。
  assetsPane: '',
  todayCounts: { daily: 0, projects: {} }, // 今日待办数
  // ⭐ 0.4.5 首页看板：`preset` 是三档预设（today / week / month，手改日期后是 'custom'），
  //    `range` 是折出来的闭区间，`data` 是 `GET /api/dashboard` 的响应。
  //    ⚠️ 区间**必须住 state**、不许只放在 DOM 上：看板每次切区间都整块重画 `#home-body`，
  //    写在输入框上的区间会被抹掉。
  // ⭐ 0.5.2：`preset` 多了一档 `day`（**单日**＝用户挑的那一天，不是「今日」）；
  //    `filter` 是「点了概览上哪个数」（`core/dashboard.js` 的 `DASH_FILTERS` 的 key，空串＝不筛选）。
  // ⭐ 0.8.9再加两个：
  //    · `panel` = 区间工具栏下面**展开了哪一块**（'' = 都没展开 | 'filter' = 单日/本周/本月 ＋ 两个日期框 |
  //      'search' = 搜索行）—— 把「单日/本周/本月 ＋ 两个日期框」收成了一颗**筛选图标**、
  //      另加一颗**放大镜**，两颗都在周条工具栏里、点开才展开。
  //    · `q` = 搜索词（**纯前端**筛看板上的事项，⛔ 不重新取数）。
  //    ⚠️ 两个都给**显式空串初值**：靠 `undefined` 兜的话，那个分支在「刚进屏」那一刻是静默不生效的。
  dash: { preset: 'today', range: { from: '', to: '' }, data: null, filter: '', panel: '', q: '' },
  // ⭐ 0.8.7：看板当前看的是**哪个视图** —— 空串 = 看板自己的**列表视图**；
  //    其余 = 某个模块贡献的视图（模块名，由接线表的 `dashView` 声明，0.8.7 起是 `'calendar'`）。
  //    ⚠️ 它是**看板自己的界面状态**，与 `cal`（日历模块的数据）不是一回事：看板只决定
  //    「什么时候挂那个视图、挂进哪个容器」，数据一律以 `state.cal` 为准（方案 §二·8）。
  //    ⚠️ 必须在**进屏**时按服务端的偏好重落一次（`views/home.js` 的 `defaultDashView()`），
  //    否则「刚在设置里翻了药丸、再进看板」会被上一次的快照吃掉，表现是「药丸开了、进去还是列表」。
  dashView: '',
  health: null, // 数据层状态（降级时挂横幅）
  readOnly: false, // 数据层只读降级 → 禁用一切写入口
  search: '', // 搜索关键词
  prevView: 'home', // 搜索前的视图（清空搜索时回到这里）
  detail: null, // 详情弹窗当前任务 { scope, task }
  itemMap: new Map(), // 当前渲染出的任务条目 → 任务数据
  me: null, // 当前登录账号（/api/auth/me，含 is_admin）
  // ⭐ 0.5.0 模块化重构：模块清单（`/api/bootstrap` 的 `modules`，服务端扫 `app/modules/` 聚合而来）。
  //    ⚠️ 初值是 null 而**不是空数组**：「还没拿到」与「服务端说一个模块都没有」对界面是两件不同的事
  //    （前者不能判显隐、后者要真的一颗入口都不画），见 shell.js 的 applyPrefsVisibility()。
  modules: null,
  setPane: 'modules', // ⭐ 0.4.1 设置页左侧选中的那一栏（'data' / 'modules' / 'account' / 'members' / 'backup' / 'org'）
  adminUsers: null, // 成员列表（仅管理员的「设置 → 成员管理」栏用）
  adminMeId: null, // 成员列表里「我」的账号 id
  allowSelfRegister: true, // 自主注册开关（同一栏）
  storage: null, // 数据位置（/api/admin/storage，仅管理员；0.4.1 起归「设置 → 数据来源」）
  storageError: null, // 数据位置读取失败的原因（⚠️ 同时是「别再自动重试」的闸门，见 settings.js）
  // ---- ⭐ 0.8.5 日志栏（`views/settings.js` 的 logsPaneHtml）----
  logFile: 'app.log', // 当前在看的日志文件（切走再回来还停在这儿）
  logDir: '', // 日志文件夹的绝对路径（`GET /api/admin/logs` 的 `dir`，「复制路径」用它）
  logFiles: [], // 日志文件清单（名字 / 大小 / 修改时间）
  // ---- 课表：与任务板互不干扰 ----
  ttTerms: [], // 学期列表
  ttTermId: null, // 当前学期 id
  tt: null, // 当前 schedule 响应（term / blocks / periods / cells / today）
  ttWeek: null, // 当前周次；null = 全学期（不做周次筛选）
  ttShowWeekend: true, // 是否显示周六周日
  ttTemplates: [], // ⭐ 内置高校模板清单（0.3.5；进导入向导时按需拉一次）
  ttWizard: null, // 导入向导的临时状态（来源 / 文件 / 模式 / 草稿 / 扁平课次表）
  // ---- 网址收藏夹（0.3.0）：同样独立于任务板 ----
  bmItems: [], // 当前筛选结果（每条含 tag_ids / tag_names）
  bmTags: [], // 分类列表（含每个分类下的书签数）
  bmTagId: null, // 当前选中的分类筛选；null = 全部
  bmTotalAll: 0, // 不带任何筛选时的总数（筛选中也保持显示，不跟着变小）
  // ⭐ 0.8.5 关联密码库：⚠️ 这三样**都不落盘、也不进任何快照**：
  //    · `bmVaultFor`   正在关联 / 查看的那条收藏 id；
  //    · `bmVaultNext`  「验过主密码之后要干的事」（一个函数，⛔ 别改成枚举名再在别处 switch）；
  //    · `bmVaultShown` 当前弹窗里那条的明文 —— **只在「看密码」那一层存在**，取消关联时清掉。
  bmVaultFor: 0,
  bmVaultNext: null,
  bmVaultShown: null,
  // ---- NAS硬件管理（0.3.1）：同样独立于任务板 ----
  hwItems: [], // 当前筛选结果（每条含服务端算好的 life）
  hwSummary: null, // 顶部概览行（全部 / 在用 / 想买 / 已退役 / 需关注 + 三个金额合计）
  hwCategories: [], // **当前子类别下面**的子分类清单（含每类件数），筛选中保持全量
  hwSections: [], // 左栏那一列**子类别**（含每格件数与 `active` 标记）—— 0.8.10 批 4
  hwSectionId: '', // 当前子类别 id（左栏高亮的基准、右栏下拉的基准）—— 0.8.10 批 4
  hwRootId: '', // 「数码管理」那一格的 id（新建子类别要拿它当父格）—— 0.8.10 批 4
  // ⭐ 0.8.22（「子类别二级展开子分类」）：左栏**展开了子分类**的那几个子类别
  //    的 id（数组，可以同时展开好几格）。纯界面状态 —— ⛔ 它不进请求参数、⛔ 不取数，
  //    点箭头只重画左栏（`renderHwSections()`）。
  hwOpenSec: [],
  //    ⭐⭐ 0.8.24（「【三个管理】合并为管理」）：「管理」弹层当前停在哪一页 ——
  //    第一页 `'catman'`（**类别管理**：类别与分类合并成的一棵两级树）/ 第二页 `'tpl'` 模板。
  //    ⚠️ 0.8.24 任务三起，原先那两个标签（`'sec'` 类别 / `'cat'` 分类）并进了 `'catman'`。
  //    ⚠️ 同理是**纯界面状态**：⛔ 不进请求参数、⛔ 不落库，只在「改完 / 删完就地重画这一页」时用。
  hwManageTab: 'catman',
  //    ⭐⭐ 0.8.24 任务三：**类别管理那一页里展开了哪几个类别**（数组）。
  //    ⭐⭐ 0.8.24 任务四（「进入默认全部折叠」）：初值是**空数组**
  //      —— 进来时每一格都收着（从前是 `null` ＝ 全部展开，类别一多那一屏根本看不完）。
  //    ⚠️⭐ 刻意与左栏那份 `hwOpenSec` **分开**：两处的语境不同（左栏是浏览 / 筛选，
  //      弹层里是「管理」，点一格看它下面的分类）。⛔ 别把这两个合成一份。
  hwManageOpen: [],
  //    ⭐ 0.8.10：左栏的**合并模式**（`null` = 不在模式里；`{ids: [...]}` = 进了模式、勾了哪几格）。
  //    ⚠️ 它是**纯界面状态**，进这一屏时清掉（`mountHardware()`），⛔ 不落库、⛔ 不跨屏留着。
  hwMerge: null,
  hwQuery: '', // 搜索关键词（多个词都会被匹配）
  hwStatus: '', // 状态筛选：'' 全部 / 'owned' / 'wishlist' / 'retired'
  hwCategory: '', // 子分类筛选：'' 不细分（= 看当前子类别的全部）
  hwFocusAlert: false, // 是否「只看需关注」
  // ⭐ 0.5.2：排序改成**四个真字段**：`used` 使用时间 / `remain` 剩余寿命 /
  //    `price` 价格 / `new` 最近添加；`hwSortDesc` 是方向（true = 大 / 贵 / 新的在前）。
  //    ⚠️ 旧的 `alert`（该看的在前）不再是排序项 —— 它是一条**筛选**（顶部「⚠ 需关注」）。
  hwSort: 'used',
  hwSortDesc: true,
  hwDetailId: null, // 只读详情弹窗对着的那一条（详情里的按钮要按它回列表取行）
  // ---- 密码库（0.3.2）：同上，独立于任务板 ----
  //    ⚠️ 这里**只放解锁后的摘要**（标题 / 用户名 / 网址），**绝不把密码留在 state 里**：
  //      详情弹窗每次现取（`GET /api/vault/:id`），关掉弹窗就没有明文密码还在内存里躺着；
  //      锁定或超时后 `vaultReset()` 会把这几项清空。
  vault: null, // 服务端状态：{ initialized, unlocked, lockAfterSeconds, lockMinutes }
  vaultItems: [], // 条目摘要列表（id / title / username / url / tags，**不含密码**）
  vaultBroken: 0, // 解不开的条目数（密文被改过），界面上要明确说出来，不能静默
  vaultTimer: null, // 解锁倒计时的定时器句柄（离开这一屏或锁定时必须清掉）
  vaultLeft: 0, // 距自动锁定还剩多少秒（界面上的倒计时）
  // ⭐ 筛选态（0.4.4 起）**必须住这里**、不许只放在 DOM 上：
  //    列表每次取数都整块重画，写在 class / value 上的筛选条件会被抹掉，
  //    表现是「一保存就自己跳回全部」而**不报任何错**。
  vaultQuery: '', // 关键词（标题 / 用户名 / 网址，多词 AND）
  vaultTag: null, // 标签筛选：null = 全部；{kind:'none'} = 未分类；{kind:'tag', name} = 某个标签
  // ⭐⭐ 0.8.18 任务八：**绑在这个密码条目上的网址收藏**（键 = 条目 id 的字符串形式，值 = 收藏夹条目数组）。
  //    ⚠️ 绑定关系的唯一真相在收藏夹那边（`bookmarks.vault_entry_id`），这里只是一份**只读快照**，
  //    每次 `loadVaultList()` 跟着列表一起取（收藏夹模块不在时是空对象 ⇒ 绑定区块整块不显示）。
  vaultBmLinks: {},
  // ---- 番茄钟（0.7.5）：同上，独立于任务板 ----
  // ⚠️ 这里**只放服务端给的「事实」**（`started_at` / `planned_seconds` / `paused_*`）——
  //    ⛔ **绝不出现「剩余秒数」这样的字段**：剩余每一拍都由 `core/clock.js` 的 `remaining()`
  //    **算出来**。攒出来的剩余会切后台停走、切回来就漂、刷新归零，那才是真正的第三份时间口径。
  // ⚠️ `pomoScope` / `pomoTasks` 是「绑一条任务」那两个下拉的临时选择，**必须住这里**、
  //    不许只挂在 DOM 上（下拉每次重画，写在节点上的选择会被抹掉，
  //    表现是「一保存就自己跳回不绑」而**不报任何错**）。
  // ⭐ 0.8.33：两个下拉搬进了「设置」弹窗 ⇒ 电脑版也需要 `pomoTaskId`（弹窗一关，
  //    `#pomo-scope` / `#pomo-task` 这两个节点就没了，主屏那颗「开始专注」只能读这里）。
  //    ⚠️ 与手机端**同名同义**，⛔ 别改成两个不同的名字。
  pomo: null, // `GET /api/pomodoro` 的响应：{ nowMs, session, prefs, stats }
  pomoLoaded: false, // 手机端「这一屏取过数没有」（电脑端每次进来都重取，用不上它）
  pomoScopes: [], // 可绑的作用域（项目清单；拉不到就是空数组 ⇒ 只能「不绑」）
  pomoTasks: [], // 当前作用域下的任务清单（`[]` = 这个作用域下没有可绑的）
  pomoScope: '', // '' 不绑 | 'daily' 日常任务 | 项目 id 的字符串
  pomoTaskId: null, // 选中的任务 id（`null` = 还没选）；⭐ 0.8.33 起电脑版也用（见上面那条）
  pomoDueSaid: false, // 这一轮的「到点」提示弹过没有（⛔ 别每秒弹一次）
  pomoBaseTitle: '', // 进屏前的 `document.title`（到点闪一下，离开或确认后还回去）
  // ---- 日历（0.7.5；⭐ 0.8.7  起是**首页看板里的第二个视图**）----
  // ⚠️ 这里放的是**服务端给的那一份**（事件 + 四个图层 + 服务端「今天」）——
  //    ⛔ 前端不自己算「今天」、不自己判「某天有课」（
  //    日历是消费方，不是判定方；第二份口径的下场是「课表页有这节、日历上没有」且不报错）。
  //    ⭐ 视图本身由看板通过插槽动态挂载（`desktop-dash-view.js`）—— 但**数据仍以这里为准**：
  //    看板只决定「什么时候挂它、挂进哪个容器」（方案 §二·8），⛔ 它不碰日历的取数。
  cal: null, // `GET /api/calendar` 的响应：{ today, from, to, events, prefs, layers, life }
  // ⚠️ 这两个**必须住 state**、不许只放在 DOM 上：换月与点某天都会重画，
  //    写在节点上的月份 / 选中日会被抹掉，表现是「翻到下个月又自己跳回本月」而不报任何错。
  calMonth: '', // 当前显示的月份 `YYYY-MM`（换月只改它，再重取一次）
  calDay: '', // 当前选中的那一天 `YYYY-MM-DD`（点某天只改它 —— ⛔ 不换屏，决策 49）
  // ⭐ 0.7.8：日历这一屏的**第二个视图** —— `'month'` 月视图 / `'life'` 人生日历。
  //    ⚠️ 必须住 state：这一屏会整块重画，挂在 DOM class 上会被抹掉，
  //    表现是「切到人生日历、随便动一下就自己跳回月视图」，而且**不报任何错**。
  calTab: 'month',
  // ⭐⭐ 0.8.30：「番茄钟与日程表」这一屏**停在哪一格** —— `'home'` 首页日程表 / `'timetable'` /
  //    `'pomodoro'` / `'trip'`（四格，与 `modules/time/home-shared.js` 的 `TIME_PANES` 同一套名字）。
  //    ⚠️⚠️ **必须有初值**：它一缺，`paintTimePanes()` 就拿 `undefined` 去和四个 pane 逐个比，
  //    四个**全被加上 `hidden`** ⇒ 进这一屏**整块空白**（这个洞是 `0.8.13` 并版那次留下的：
  //    `tripTab` / `calTab` / `lgSeg` 都有初值，单单漏了它）。电脑端 `openTime()` 本来就会把
  //    归一化后的值写回 state，所以这边一直没露 —— 补它是为了两端**同一条口径**。
  //    ⚠️ 与 `mobile/state.js` 的同名字段**逐字同义**，两处一起改。
  timeTab: 'home',
  // ---- 记账（0.8.0）：同上，独立于任务板 ----
  // ⚠️ 这里放的是**服务端算好的那一份**（资产 / 负债 / 净值 ＋ 分组小计 ＋ 账户 ＋ 当年快照）——
  //    ⛔ 前端不自己 sum 金额、不自己算「今天」（方案 §三 /  同源）。
  lg: null, // `GET /api/ledger/overview` 的响应：{ today, totals, groups, accounts, snapshots, years }
  // ⭐ 0.8.0（图表）：两个**只住内存**的界面口径（⛔ 不落 localStorage）。
  //    ⚠️ 电脑端**没有 `lgTab`** —— 那一屏是两栏同屏（左台账 / 右图表），没有"切视图"这回事。
  lgRange: 'asset', // 图表看哪一侧：`asset` | `debt` | `net`
  lgYear: 0, // 走势图看哪一年（0 = 还没取过数 ⇒ 首次加载后填成服务端的「今年」）
  // ---- 行程（0.8.6）：同上，独立于任务板 ----
  // ⚠️ 这里放的是**服务端给的那一份**（一屏：今天 / 三档开关 / 下一张票 / 行程列表 / 车票列表）——
  //    ⛔ 前端不自己算「还有多久出发」的权威值、不自己遍历点算里程（双份判据必然漂移）。
  trip: null, // `GET /api/trip` 的响应：{ today, prefs, upcoming, trips, tickets }
  // ⚠️ 这几个**必须住 state**、不许只放在 DOM 上：这一屏会整块重画，
  //    挂在节点上的子屏名 / 选中 id 会被抹掉，表现是「点了详情又自己跳回主屏」而不报任何错。
  tripTab: 'main', // 屏内子屏：`main` 主屏 | `detail` 行程详情 | `ticket` 车票表单 | `track` 轨迹屏
  tripId: 0, // 当前打开的行程 id（0 = 没打开任何行程）
  tripForm: null, // 车票表单的编辑草稿（null = 还没打开过表单）
  tripPoints: null, // 轨迹屏的点（`GET /api/trip/points` 的 `points` 数组；null = 还没取过）
  tripPointsTrip: 0, // 轨迹屏看的是哪个行程的点（0 = 不挂行程的那些）
  tripCi: null, // 打卡子屏的临时态：{ locating, error }
  // ⭐ 0.8.0 记账：当前选中的「分类视图」（0 = 按账户类型；其余是 ledger_views 的 id）
  lgView: 0,
  // ⭐ 0.8.0：详情弹窗正在看哪个账户（0 = 没开），以及那一份明细。
  //    ⚠️ `lgTx: null` = 还没取到（画「正在读取…」）；`[]` = 这个账户一笔都没有（画空态）——
  //    「还没取」与「一笔都没有」是两件不同的事，⛔ 别用同一个值表示。
  //    ⚠️ 电脑端详情是**弹窗**（不是二级屏）：弹窗可能被「转账 / 编辑」替换掉内容，
  //    要能回到详情 ⇒ 账户 id 得住 state，⛔ 不能只放在闭包里（那样「转账之后回详情」得靠闭包接力）。
  lgAcctId: 0,
  lgTx: null,
  // ⭐ 0.8.0：**眼睛**（点一下把所有金额糊成圆点）。⚠️ **只住内存**：刷新就回到「显示」——
  //    它防的是肩窥，⛔ 不是安全机制、⛔ 不落库（与手机端同一个字段、同一语义）。
  lgHide: false,
  // ---- 记账 2 期（0.8.1）：同样只住内存（⛔ 不落 localStorage） ----
  // ⭐⭐ 0.8.2：屏内顶部那排分段控件当前在哪一段，
  //    ⭐ **默认「明细」**（T32/T33：「设置不变，其它按钮顺序与手机端相同」）。
  //    ⚠️ 0.8.3 起电脑端是**三段**（`明细 ｜ 预算 ｜ 资产`）：原来那一格 `entry`（「记账」）
  //    已撤掉 —— 它 0.8.2 起就只剩一颗「＋ 记一笔」，那颗挪去了顶部那一行右侧（见
  //    `modules/ledger/desktop.js` 的 `segBarHtml()`）；⛔ 这个字段**不再接受 `entry`**
  //    （写了它只会落到「明细」那一支）。
  //    ⚠️⚠️ 它**不是** `lgView`：1 期与手机端的 `lgView` 是「按哪套分类看账户」（一个数字 id），
  //    两者语义完全不同 —— 借 `lgView` 会被 `Number('entry')` 悄悄变成 NaN，
  //    把用户上次选的分类视图静默抹掉（正是「一个词指两件事」的坑， 同族）。
  //    ⚠️ 它取代了 0.8.1 的「默认记账」—— 与 `mobile/state.js` 的 `lgSeg` 是同一条口径，两处一起改。
  lgSeg: 'detail',
  // ⭐ 0.8.3：**记账设置二级菜单**当前看的是哪一页 —— 空串 = 设置首页（三条目那张列表），
  //    非空 = `calc.js` 的 `SET_PAGES` 里的一个 `key`（`acct` / `cat` / `imp`）。
  //    ⚠️⚠️ 判据只认 `setPageOf()` 那一处（`calc.js`）：认不出**一律回落到首页**（空串），
  //    ⛔ 别在两端各判一遍 —— 各判一遍必然漂移，而且表现是"某一端点进去站着的是另一页"。
  //    ⚠️ 只住内存（⛔ 不落 localStorage）；⚠️ 与 `mobile/state.js` 的同名字段**逐字同义**，两处一起改。
  lgSetPage: '',
  // ⭐⭐ 0.8.22（「设置-收支分类：默认全部折叠」）：【收支分类】里**展开着的一级分类**
  //    （`{ [一级id]: true }`）。⚠️ 只住**这一次会话**、⛔ 不落库（它是个临时的看法，不是偏好）；
  //    ⚠️ 默认空对象 ＝ 全部折叠（要的默认态）。
  lgCatOpen: {},
  // ⭐⭐ 0.8.4：明细屏那颗放大镜的搜索 —— `lgSearchSeq` 是**请求序号**（防竞态）。
  //    ⚠️⭐ 打字快的时候上一个请求可能后到，不丢的话会把**旧关键字**的结果画在新结果上，
  //    而界面看起来完全正常（一个不报错的错）。初值必须是数字 `0`：
  //    `Number(undefined) + 1` 是 `NaN`，而 `NaN !== NaN` 恒真 ⇒ 结果**永远被丢掉**（屏幕上什么都不出现）。
  lgSearchSeq: 0,
  // 流水列表的月份（`YYYY-MM`；空串 = 用**服务端今天**那个月）。
  lgMonth: '',
  // ⭐ 本月「有记录」的月份候选 —— 服务端没给「有流水的月份」清单（见报告的阻塞项），
  //    只能拿 overview 的快照月份 ∪ 今天那个月 ∪ **本次会话访问过的月**兜。
  lgMonths: [],
  lgEntries: [], // 当前流水列表（一次 30 条，翻页往后累加）
  lgCursor: null, // 下一 30 条的游标（`null` = 到底了 / 还没取）
  lgDone: false, // 这个月是否已经取完（false + cursor 为 null = 还没取过）
  // ⭐ 三态分得开：`idle` 还没取 / `loading` 读取中 / `done` 取到了 / `error` **读不到**。
  //    ⛔ 「读不到」绝不许画成「一笔都没有」（那等于把错误藏起来）。
  lgLoad: 'idle',
  lgErr: '',
  // 收支分类（`GET /api/ledger/categories`，两级一次性给全，含 `archived`）——只取一次。
  lgCats: [],
  // 默认账户（`GET /api/ledger/defaults`）——只取一次；记一笔的预填与记账设置都读它。
  lgDefaults: null,
  // 记一笔的草稿（方案 §7.7）。⚠️ 住 state 而**不是**弹窗 DOM：弹窗会整块重画（换收/支、
  //    点一级分类都要重画），挂在节点上的值会被抹掉。
  lgDraft: null,
  // 备注历史候选（`GET /api/ledger/notes?category=` 的返回值；点一下即填）。
  //    ⛔ 候选**只来自服务端**，前端不做 `distinct`。
  lgNotes: [],
  lgNotesCat: null, // 这批候选是哪个分类的（换分类要重取；null = 全部类别）
  // 账户详情那一屏的类型过滤（`all` / `entry` / `transfer` / `adjust`，§7.7 的 `lgType`）。
  lgType: 'all',
  lgChgMonth: '', // 账户详情那一屏的月份（空串 = 服务端今天那个月）
  lgChg: [], // 三类混排（记账 ＋ 转账 ＋ 手动调整）
  lgChgCursor: null,
  lgChgDone: false,
  lgChgLoad: 'idle', // 与流水同一套三态
  lgChgErr: '',
  // ---- ⭐⭐ 0.8.2 记账 3 期：与手机端**逐字同名同义**----
  //    ⚠️ 只住内存（⛔ 不落 localStorage）；⚠️ 金额一律由服务端给（前端不算钱）。
  lgSum: null, // 明细屏：`ledgerEntries` 搭车回来的当月合计 { incomeFen, expenseFen }
  lgDayTotals: null, // 明细屏：按天小计 { 'YYYY-MM-DD': { incomeFen, expenseFen } }
  // ⚠️⭐ 0.8.3：原来那个 `lgBillOpen`（＝"账单屏在不在"）**已删** —— 把「账单」从
  //    「明细的子屏」升成**一级格**（`state.lgSeg === 'bill'`）⇒ ⛔ 不再有"那一屏在不在"这个独立状态。
  lgBillTab: 'month', // `week` | `month` | `year`（默认 month，C-19）
  // ⭐⭐ 0.8.3（4 期）：**图表**那几件状态。
  //    ⭐ 0.8.4：图表**只长在「账单」那一屏**（明细那一屏那颗药丸已撤
  //    「删除 明细中的图表」）⇒ 它的期间直接吃账单自己那两颗（`lgBillTab` / `lgBillKey`），
  //    ⛔ 不再有独立的「图表期间」（`lgChartPeriod` / `lgChartKey` 已删）。
  //    ⚠️ `lgBillTab2` 与上面那个 `lgBillTab` **不是一回事**：后者是账单的「周/月/年」档，
  //       前者是「列表/图表」视图档（名字里那个 `2` 就是为了别让人看混）。
  //    ⚠️ 全部**不落 localStorage**（屏内选择不落库；与 一族的「显示偏好才落库」同一条分寸）。
  lgBillTab2: 'list', // `list` | `chart`（账单屏那颗药丸；⭐ 默认列表）
  lgChartDir: 'out', // `out`（支出）| `in`（收入）；⭐ 参考图默认就是「支出」
  lgChart: null, // `GET /api/ledger/chart` 回来的那一屏（null = 还没取过）
  lgChartLoad: 'idle', // `idle` | `loading` | `done` | `error`
  lgChartErr: '',
  lgPeriods: null, // `GET /api/ledger/periods` 的期间清单（第二行那些候选）
  // ⭐⭐ 0.8.3（4 期）：设置【导出数据】那一页的两个选择 ——
  //    `lgExportWhat` 是**勾了哪几样**（`calc.js` 的 `EXPORT_WHATS` 的 key 数组；默认只勾「明细流水」），
  //    `lgExportFrom` / `lgExportTo` 是**开始 / 结束日期**（`YYYY-MM-DD`；空串 = 用服务端给的默认）。
  //    ⚠️ 它们是**界面选择**（⛔ 不落 localStorage，与上面几个同一条分寸）；⚠️ 必须住 state ——
  //    这一弹窗会整块重画，挂在 DOM 上的 checked / value 会被抹掉。
  //    ⚠️ 与手机端 `mobile/state.js` 的同名字段**逐字同义**，两处一起改。
  lgExportWhat: ['entries'],
  lgExportFrom: '',
  lgExportTo: '',
  lgBillKey: '',
  lgBill: null,
  lgBillLoad: 'idle',
  lgBillErr: '',
  lgMdMonth: 0, // 月详情页看哪个月（`0` = 不在这一屏）；⭐ 只有「月」有这一页（T41）
  lgMd: null,
  lgMdLoad: 'idle',
  lgMdErr: '',
  lgBudgetTab: 'month', // 预算屏三档（默认 month，C-18）
  lgBudgetKey: '',
  lgBudget: null,
  lgBudgetLoad: 'idle',
  lgBudgetErr: '',
};


/**
 * 功能：把作用域标识统一成存储层使用的键 —— `'daily'` 与 `null` / `undefined` 一律归为 `'daily'`，
 *      ⭐ 0.5.2 起 `'all'`（**汇总任务视图**：所有项目的任务）也原样保留，其余（项目 id）转成数字。
 * @param {(string|number|null)} s - 作用域标识，`'daily'` / `'all'` 或项目 id
 * @returns {(string|number)} `'daily'` / `'all'` 或项目的数字 id
 */
export const scopeKey = (s) => (s === 'daily' || s == null ? 'daily' : s === 'all' ? 'all' : Number(s));
