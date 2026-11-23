/**
 * desktop/state.js —— 应用状态（唯一的可变真值，视图只读它）
 *
 * 功能：定义并导出电脑版的全局状态对象 `state`，字段覆盖项目与任务列表、当前作用域与视图、
 * 日期轴与看板的选中状态、今日待办数与首页汇总、数据层健康与只读标记、搜索与详情弹窗、
 * 当前登录账号与成员管理，以及课表视图的一整套临时状态；
 * 另导出 `scopeKey()`，把作用域标识统一成存储层使用的键。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

// ---------- 状态 ----------
export const state = {
  projects: [], // 项目列表（侧栏、看板与项目选择处都读它）
  tasks: [], // 当前作用域的任务列表（切作用域时由 loadBoard 覆盖）
  // `scope` 多一个取值 `'all'` —— **汇总任务视图**：四象限里汇总显示**所有项目**的任务
  // （「项目任务默认显示汇总任务视图」）。⚠️ 它是**视图**不是项目：
  // 勾选 / 编辑 / 删除一律按任务自己那个项目走（`taskScope()`），⛔ 不要拿它去拼 REST 路径。
  scope: 'all', // 'all' 汇总 | 'daily' 日常任务 | 项目 id
  view: 'board', // 'home' 首页汇总 | 'projects' 项目任务 | 'board' 任务板 | 'search' 搜索结果
  weekStart: null, // 当前显示周的周一日期
  selectedDate: null, // 选中日期（四象限显示该日任务）
  boardPane: 'quad', // 看板当前视图：'quad' 四象限 | 'timeline' 时间轴（二选一，不同屏）
  // 任务板那一屏**屏头那颗药丸**当前选的是哪一块 —— 空串 = 任务板自己
  // （默认，也是药丸的第一项），其余 = 某个模块借这一屏的位置贡献的视图（**模块名**，
  // 与上面的 `boardPane` **不是一回事**：那个是任务板内部「四象限 / 甘特图」的二选一，
  boardTab: '',
  // 进「个人资产管理」那一屏时**要落到哪一格**（模块名；空串 = 不指定）。
  // 撤了 `hub`，不再有自己的一屏，界面挂进资产屏的药丸；于是「点一条硬件类事项」这类入口
  // 只点侧栏那扇门，**落到哪一格得由这个字段带过去**（`desktop/views/home.js` 写，
  assetsWant: '',
  // **现在挂在「个人资产管理」那一屏里的是哪个模块**（模块名；空串 =
  // 自建分组 / 还没画）。由 `modules/assets/desktop.js` 画屏时写（与手机端的
  // `state.assetsPane` 同口径）—— 它答的是「那一格上是谁」。
  assetsPane: '',
  todayCounts: { daily: 0, projects: {} }, // 今日待办数
  // 首页看板：`preset` 是三档预设（today / week / month，手改日期后是 'custom'），
  // `range` 是折出来的闭区间，`data` 是 `GET /api/dashboard` 的响应。
  // 写在输入框上的区间会被抹掉。
  dash: { preset: 'today', range: { from: '', to: '' }, data: null, filter: '', panel: '', q: '' },
  // 看板当前看的是**哪个视图** —— 空串 = 看板自己的**列表视图**；
  // 它是**看板自己的界面状态**，与 `cal`（日历模块的数据）不是一回事：看板只决定
  // 必须在**进屏**时按服务端的偏好重落一次（`views/home.js` 的 `defaultDashView()`），
  dashView: '',
  health: null, // 数据层状态（降级时挂横幅）
  readOnly: false, // 数据层只读降级 → 禁用一切写入口
  search: '', // 搜索关键词
  prevView: 'home', // 搜索前的视图（清空搜索时回到这里）
  detail: null, // 详情弹窗当前任务 { scope, task }
  itemMap: new Map(), // 当前渲染出的任务条目 → 任务数据
  me: null, // 当前登录账号（/api/auth/me，含 is_admin）
  // 模块化重构：模块清单（`/api/bootstrap` 的 `modules`，服务端扫 `app/modules/` 聚合而来）。
  // 初值是 null 而**不是空数组**：「还没拿到」与「服务端说一个模块都没有」对界面是两件不同的事
  // （前者不能判显隐、后者要真的一颗入口都不画），见 shell.js 的 applyPrefsVisibility()。
  modules: null,
  setPane: 'modules', // 设置页左侧选中的那一栏（'data' / 'modules' / 'account' / 'members' / 'backup' / 'org'）
  adminUsers: null, // 成员列表（仅管理员的「设置 → 成员管理」栏用）
  adminMeId: null, // 成员列表里「我」的账号 id
  allowSelfRegister: true, // 自主注册开关（同一栏）
  storage: null, // 数据位置
  storageError: null, // 数据位置读取失败的原因（⚠️ 同时是「别再自动重试」的闸门，见 settings.js）
  // `null` = 这次还没检查过（**进页面不自动联网**：许可协议写明只有主动点「检查更新」才请求一次）。
  // 值是 `GET /api/versions` 的**整份载荷**（成功 `{ok:true, items:[...]}`，失败 `{ok:false, message}`）——
  // 失败也存下来：不存就分不清「没查过」与「查了但连不上」，界面只能一直说「还没检查过」。
  versions: null,
  versionsBusy: false, // 正在请求中（按钮转「检查中…」并禁用，防连点）
  logFile: 'app.log', // 当前在看的日志文件（切走再回来还停在这儿）
  logDir: '', // 日志文件夹的绝对路径（`GET /api/admin/logs` 的 `dir`，「复制路径」用它）
  logFiles: [], // 日志文件清单（名字 / 大小 / 修改时间）
  // ---- 课表：与任务板互不干扰 ----
  ttTerms: [], // 学期列表
  ttTermId: null, // 当前学期 id
  tt: null, // 当前 schedule 响应（term / blocks / periods / cells / today）
  ttWeek: null, // 当前周次；null = 全学期（不做周次筛选）
  ttShowWeekend: true, // 是否显示周六周日
  ttTemplates: [], // ⭐ 内置高校模板清单
  ttWizard: null, // 导入向导的临时状态（来源 / 文件 / 模式 / 草稿 / 扁平课次表）
  bmItems: [], // 当前筛选结果（每条含 tag_ids / tag_names）
  bmTags: [], // 分类列表（含每个分类下的书签数）
  bmTagId: null, // 当前选中的分类筛选；null = 全部
  bmTotalAll: 0, // 不带任何筛选时的总数（筛选中也保持显示，不跟着变小）
  // 关联密码库：⚠️ 这三样**都不落盘、也不进任何快照**：
  // `bmVaultFor`   正在关联 / 查看的那条收藏 id；
  // `bmVaultNext`  「验过主密码之后要干的事」（一个函数，⛔ 别改成枚举名再在别处 switch）；
  bmVaultFor: 0,
  bmVaultNext: null,
  bmVaultShown: null,
  hwItems: [], // 当前筛选结果（每条含服务端算好的 life）
  hwSummary: null, // 顶部概览行（全部 / 在用 / 想买 / 已退役 / 需关注 + 三个金额合计）
  hwCategories: [], // **当前子类别下面**的子分类清单（含每类件数），筛选中保持全量
  hwSections: [], // 左栏那一列**子类别**（含每格件数与 `active` 标记）—— 批 4
  hwSectionId: '', // 当前子类别 id（左栏高亮的基准、右栏下拉的基准）—— 批 4
  hwRootId: '', // 「数码管理」那一格的 id（新建子类别要拿它当父格）—— 批 4
  // ：左栏**展开了子分类**的那几个子类别
  // 的 id（数组，可以同时展开好几格）。纯界面状态 —— ⛔ 它不进请求参数、⛔ 不取数，
  // 点箭头只重画左栏（`renderHwSections()`）。
  hwOpenSec: [],
  // ：「管理」弹层当前停在哪一页 ——
  // 第一页 `'catman'`（**类别管理**：类别与分类合并成的一棵两级树）/ 第二页 `'tpl'` 模板。
  // 任务三起，原先那两个标签（`'sec'` 类别 / `'cat'` 分类）并进了 `'catman'`。
  hwManageTab: 'catman',
  // 任务三：**类别管理那一页里展开了哪几个类别**（数组）。
  // 任务四（「进入默认全部折叠」）：初值是**空数组**
  // —— 进来时每一格都收着（从前是 `null` ＝ 全部展开，类别一多那一屏根本看不完）。
  hwManageOpen: [],
  // 左栏的**合并模式**（`null` = 不在模式里；`{ids: [...]}` = 进了模式、勾了哪几格）。
  // 它是**纯界面状态**，进这一屏时清掉（`mountHardware()`），⛔ 不落库、⛔ 不跨屏留着。
  hwMerge: null,
  hwQuery: '', // 搜索关键词（多个词都会被匹配）
  hwStatus: '', // 状态筛选：'' 全部 / 'owned' / 'wishlist' / 'retired'
  hwCategory: '', // 子分类筛选：'' 不细分（= 看当前子类别的全部）
  hwFocusAlert: false, // 是否「只看需关注」
  // 排序改成**四个真字段**：`used` 使用时间 / `remain` 剩余寿命 /
  // `price` 价格 / `new` 最近添加；`hwSortDesc` 是方向（true = 大 / 贵 / 新的在前）。
  // 旧的 `alert`（该看的在前）不再是排序项 —— 它是一条**筛选**（顶部「⚠ 需关注」）。
  hwSort: 'used',
  hwSortDesc: true,
  hwDetailId: null, // 只读详情弹窗对着的那一条（详情里的按钮要按它回列表取行）
  // 这里**只放解锁后的摘要**（标题 / 用户名 / 网址），**绝不把密码留在 state 里**：
  // 详情弹窗每次现取（`GET /api/vault/:id`），关掉弹窗就没有明文密码还在内存里躺着；
  // 锁定或超时后 `vaultReset()` 会把这几项清空。
  vault: null, // 服务端状态：{ initialized, unlocked, lockAfterSeconds, lockMinutes }
  vaultItems: [], // 条目摘要列表（id / title / username / url / tags，**不含密码**）
  vaultBroken: 0, // 解不开的条目数（密文被改过），界面上要明确说出来，不能静默
  vaultTimer: null, // 解锁倒计时的定时器句柄（离开这一屏或锁定时必须清掉）
  vaultLeft: 0, // 距自动锁定还剩多少秒（界面上的倒计时）
  // 列表每次取数都整块重画，写在 class / value 上的筛选条件会被抹掉，
  // 表现是「一保存就自己跳回全部」而**不报任何错**。
  vaultQuery: '', // 关键词（标题 / 用户名 / 网址，多词 AND）
  vaultTag: null, // 标签筛选：null = 全部；{kind:'none'} = 未分类；{kind:'tag', name} = 某个标签
  // 任务八：**绑在这个密码条目上的网址收藏**（键 = 条目 id 的字符串形式，值 = 收藏夹条目数组）。
  // 绑定关系的唯一真相在收藏夹那边（`bookmarks.vault_entry_id`），这里只是一份**只读快照**，
  // 每次 `loadVaultList()` 跟着列表一起取（收藏夹模块不在时是空对象 ⇒ 绑定区块整块不显示）。
  vaultBmLinks: {},
  // 这里**只放服务端给的「事实」**（`started_at` / `planned_seconds` / `paused_*`）——
  // **绝不出现「剩余秒数」这样的字段**：剩余每一拍都由 `core/clock.js` 的 `remaining()`
  // **算出来**。攒出来的剩余会切后台停走、切回来就漂、刷新归零，那才是真正的第三份时间口径。
  pomo: null, // `GET /api/pomodoro` 的响应：{ nowMs, session, prefs, stats }
  pomoLoaded: false, // 手机端「这一屏取过数没有」（电脑端每次进来都重取，用不上它）
  pomoScopes: [], // 可绑的作用域（项目清单；拉不到就是空数组 ⇒ 只能「不绑」）
  pomoTasks: [], // 当前作用域下的任务清单（`[]` = 这个作用域下没有可绑的）
  pomoScope: '', // '' 不绑 | 'daily' 日常任务 | 项目 id 的字符串
  pomoTaskId: null, // 选中的任务 id（`null` = 还没选）；起电脑版也用（见上面那条）
  pomoDueSaid: false, // 这一轮的「到点」提示弹过没有（⛔ 别每秒弹一次）
  pomoBaseTitle: '', // 进屏前的 `document.title`（到点闪一下，离开或确认后还回去）
  // 这里放的是**服务端给的那一份**（事件 + 四个图层 + 服务端「今天」）——
  // 前端不自己算「今天」、不自己判「某天有课」（
  // 日历是消费方，不是判定方；第二份口径的下场是「课表页有这节、日历上没有」且不报错）。
  cal: null, // `GET /api/calendar` 的响应：{ today, from, to, events, prefs, layers, life }
  // 写在节点上的月份 / 选中日会被抹掉，表现是「翻到下个月又自己跳回本月」而不报任何错。
  calMonth: '', // 当前显示的月份 `YYYY-MM`（换月只改它，再重取一次）
  calDay: '', // 当前选中的那一天 `YYYY-MM-DD`（点某天只改它 —— ⛔ 不换屏，决策 49）
  // 日历这一屏的**第二个视图** —— `'month'` 月视图 / `'life'` 人生日历。
  // 必须住 state：这一屏会整块重画，挂在 DOM class 上会被抹掉，
  // 表现是「切到人生日历、随便动一下就自己跳回月视图」，而且**不报任何错**。
  calTab: 'month',
  // 「番茄钟与日程表」这一屏**停在哪一格** —— `'home'` 首页日程表 / `'timetable'` /
  // `'pomodoro'` / `'trip'`（四格，与 `modules/time/home-shared.js` 的 `TIME_PANES` 同一套名字）。
  // **必须有初值**：它一缺，`paintTimePanes()` 就拿 `undefined` 去和四个 pane 逐个比，
  timeTab: 'home',
  // 这里放的是**服务端算好的那一份**（资产 / 负债 / 净值 ＋ 分组小计 ＋ 账户 ＋ 当年快照）——
  lg: null, // `GET /api/ledger/overview` 的响应：{ today, totals, groups, accounts, snapshots, years }
  // ：两个**只住内存**的界面口径（⛔ 不落 localStorage）。
  // 电脑端**没有 `lgTab`** —— 那一屏是两栏同屏（左台账 / 右图表），没有"切视图"这回事。
  lgRange: 'asset', // 图表看哪一侧：`asset` | `debt` | `net`
  lgYear: 0, // 走势图看哪一年（0 = 还没取过数 ⇒ 首次加载后填成服务端的「今年」）
  // 这里放的是**服务端给的那一份**（一屏：今天 / 三档开关 / 下一张票 / 行程列表 / 车票列表）——
  // 前端不自己算「还有多久出发」的权威值、不自己遍历点算里程（双份判据必然漂移）。
  trip: null, // `GET /api/trip` 的响应：{ today, prefs, upcoming, trips, tickets }
  // 挂在节点上的子屏名 / 选中 id 会被抹掉，表现是「点了详情又自己跳回主屏」而不报任何错。
  tripTab: 'main', // 屏内子屏：`main` 主屏 | `detail` 行程详情 | `ticket` 车票表单 | `track` 轨迹屏
  tripId: 0, // 当前打开的行程 id（0 = 没打开任何行程）
  tripForm: null, // 车票表单的编辑草稿（null = 还没打开过表单）
  tripPoints: null, // 轨迹屏的点（`GET /api/trip/points` 的 `points` 数组；null = 还没取过）
  tripPointsTrip: 0, // 轨迹屏看的是哪个行程的点（0 = 不挂行程的那些）
  tripCi: null, // 打卡子屏的临时态：{ locating, error }
  // 记账：当前选中的「分类视图」（0 = 按账户类型；其余是 ledger_views 的 id）
  lgView: 0,
  // 详情弹窗正在看哪个账户（0 = 没开），以及那一份明细。
  // `lgTx: null` = 还没取到（画「正在读取…」）；`[]` = 这个账户一笔都没有（画空态）——
  // 「还没取」与「一笔都没有」是两件不同的事，⛔ 别用同一个值表示。
  lgAcctId: 0,
  lgTx: null,
  // **眼睛**（点一下把所有金额糊成圆点）。⚠️ **只住内存**：刷新就回到「显示」——
  // 它防的是肩窥，⛔ 不是安全机制、⛔ 不落库（与手机端同一个字段、同一语义）。
  lgHide: false,
  // 屏内顶部那排分段控件当前在哪一段，
  // **默认「明细」**（T32/T33：「设置不变，其它按钮顺序与手机端相同」）。
  // 起电脑端是**三段**（`明细 ｜ 预算 ｜ 资产`）：原来那一格 `entry`（「记账」）
  lgSeg: 'detail',
  // **记账设置二级菜单**当前看的是哪一页 —— 空串 = 设置首页（三条目那张列表），
  // 非空 = `calc.js` 的 `SET_PAGES` 里的一个 `key`（`acct` / `cat` / `imp`）。
  // 判据只认 `setPageOf()` 那一处（`calc.js`）：认不出**一律回落到首页**（空串），
  lgSetPage: '',
  // ：【收支分类】里**展开着的一级分类**
  // （`{ [一级id]: true }`）。⚠️ 只住**这一次会话**、⛔ 不落库（它是个临时的看法，不是偏好）；
  // 默认空对象 ＝ 全部折叠（要的默认态）。
  lgCatOpen: {},
  // 明细屏那颗放大镜的搜索 —— `lgSearchSeq` 是**请求序号**（防竞态）。
  // 打字快的时候上一个请求可能后到，不丢的话会把**旧关键字**的结果画在新结果上，
  // 而界面看起来完全正常（一个不报错的错）。初值必须是数字 `0`：
  lgSearchSeq: 0,
  // 流水列表的月份（`YYYY-MM`；空串 = 用**服务端今天**那个月）。
  lgMonth: '',
  // 本月「有记录」的月份候选 —— 服务端没给「有流水的月份」清单（见报告的阻塞项），
  // 只能拿 overview 的快照月份 ∪ 今天那个月 ∪ **本次会话访问过的月**兜。
  lgMonths: [],
  lgEntries: [], // 当前流水列表（一次 30 条，翻页往后累加）
  lgCursor: null, // 下一 30 条的游标（`null` = 到底了 / 还没取）
  lgDone: false, // 这个月是否已经取完（false + cursor 为 null = 还没取过）
  // 三态分得开：`idle` 还没取 / `loading` 读取中 / `done` 取到了 / `error` **读不到**。
  lgLoad: 'idle',
  lgErr: '',
  // 收支分类（`GET /api/ledger/categories`，两级一次性给全，含 `archived`）——只取一次。
  lgCats: [],
  // 默认账户（`GET /api/ledger/defaults`）——只取一次；记一笔的预填与记账设置都读它。
  lgDefaults: null,
  // 点一级分类都要重画），挂在节点上的值会被抹掉。
  lgDraft: null,
  // 备注历史候选（`GET /api/ledger/notes?category=` 的返回值；点一下即填）。
  // 候选**只来自服务端**，前端不做 `distinct`。
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
  // 只住内存（⛔ 不落 localStorage）；⚠️ 金额一律由服务端给（前端不算钱）。
  lgSum: null, // 明细屏：`ledgerEntries` 搭车回来的当月合计 { incomeFen, expenseFen }
  lgDayTotals: null, // 明细屏：按天小计 { 'YYYY-MM-DD': { incomeFen, expenseFen } }
  // 原来那个 `lgBillOpen`（＝"账单屏在不在"）**已删** —— 把「账单」从
  // 「明细的子屏」升成**一级格**（`state.lgSeg === 'bill'`）⇒ ⛔ 不再有"那一屏在不在"这个独立状态。
  lgBillTab: 'month', // `week` | `month` | `year`（默认 month，C-19）
  // ：**图表**那几件状态。
  // 图表**只长在「账单」那一屏**（明细那一屏那颗药丸已撤
  // 「删除 明细中的图表」）⇒ 它的期间直接吃账单自己那两颗（`lgBillTab` / `lgBillKey`），
  lgBillTab2: 'list', // `list` | `chart`（账单屏那颗药丸；⭐ 默认列表）
  lgChartDir: 'out', // `out`（支出）| `in`（收入）；⭐ 参考图默认就是「支出」
  lgChart: null, // `GET /api/ledger/chart` 回来的那一屏（null = 还没取过）
  lgChartLoad: 'idle', // `idle` | `loading` | `done` | `error`
  lgChartErr: '',
  lgPeriods: null, // `GET /api/ledger/periods` 的期间清单（第二行那些候选）
  // ：设置【导出数据】那一页的两个选择 ——
  // `lgExportWhat` 是**勾了哪几样**（`calc.js` 的 `EXPORT_WHATS` 的 key 数组；默认只勾「明细流水」），
  // `lgExportFrom` / `lgExportTo` 是**开始 / 结束日期**（`YYYY-MM-DD`；空串 = 用服务端给的默认）。
  lgExportWhat: ['entries'],
  lgExportFrom: '',
  lgExportTo: '',
  lgBillKey: '',
  lgBill: null,
  lgBillLoad: 'idle',
  lgBillErr: '',
  lgMdMonth: 0, // 月详情页看哪个月（`0` = 不在这一屏）
  lgMd: null,
  lgMdLoad: 'idle',
  lgMdErr: '',
  lgBudgetTab: 'month', // 预算屏三档（默认 month）
  lgBudgetKey: '',
  lgBudget: null,
  lgBudgetLoad: 'idle',
  lgBudgetErr: '',
};


/**
 * 功能：把作用域标识统一成存储层使用的键 —— `'daily'` 与 `null` / `undefined` 一律归为 `'daily'`，
 * 起 `'all'`（**汇总任务视图**：所有项目的任务）也原样保留，其余（项目 id）转成数字。
 * @param {(string|number|null)} s - 作用域标识，`'daily'` / `'all'` 或项目 id
 * @returns {(string|number)} `'daily'` / `'all'` 或项目的数字 id
 */
export const scopeKey = (s) => (s === 'daily' || s == null ? 'daily' : s === 'all' ? 'all' : Number(s));
