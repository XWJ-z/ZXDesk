/**
 * mobile/state.js —— 应用状态
 *
 * 功能：导出手机端唯一的可变状态对象 `state` —— 界面当前位置（标签 / 作用域 / 象限 / 日期）、
 *      已加载的数据（项目 / 任务分组 / 汇总 / 健康状态 / 当前账号）、管理员按需加载的数据、
 *      底部弹层的临时状态、设置页的分区折叠状态，以及课表标签页的加载状态。各模块直接读写这里的字段。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.1
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

// ---------- 状态 ----------
export const state = {
  tab: 'today', // 当前标签页：'today' / 'board' / 'projects' / 'timetable' / 'more'
  // 任务板当前作用域。
  // ⭐ 0.5.5：多一个取值 `'all'` —— **汇总任务视图**：一次看全部项目的任务
  // （与电脑版 `state.scope` 的 `'all'` 逐字同名同义）。⚠️ 它是**视图**不是项目：
  // 勾选 / 编辑 / 删除一律按任务自己那个项目走（`rowHtml()` 写在 `data-scope` 上的 `w.scope`），
  // ⛔ 不要拿它去拼 REST 路径（`/api/projects/all/tasks` ⇒ 404）。
  // ⭐ 0.5.5 下半场（「任务板的进入默认显示汇总任务视图」）：
  // **初值就是 `'all'`** —— 这就是「默认」的全部含义。⚠️ 它是**初值**而不是「每次进任务板
  // 都强制切回汇总」：用户在这一屏自己挑了某个项目，切走再回来不该被拽回汇总
  // （电脑版 `openProjects()` 也是同一条分寸：只在当前是 `daily` 时才落到汇总）。
  scope: 'all', // 'all' 汇总 | 'daily' 日常任务 | 项目 id
  // ⭐ 0.5.5：筛选条从「全部 + 四象限五格 + 含已完成」改成**三个独立开关**：
  //    `全部` = 两个都清掉；`重要` / `紧急` 各自开关，**两个都开 = 既重要又紧急**（收窄）。
  //    ⚠️ 它们必须住 state、不许只放在 DOM 上：重画会把写在 class 上的条件抹掉。
  impOn: false, // 只看重要的
  urgOn: false, // 只看紧急的
  // ⭐ 0.5.5：`showDone`（含已完成）开关**已删** —— 已完成的任务改成「**当天完成就照常显示**」
  //    （灰色 + 「已完成」标），之后的日期靠 `core/task.js` 的 `visEnd()` 自然移出去。
  //    这与电脑端四象限**逐字同一口径**（那边本来就没有这个开关，一直用 `activeOn()`）。
  weekStart: null, // 任务板周视图的起始日（YYYY-MM-DD）
  selDate: null, // 任务板当前选中的日期（YYYY-MM-DD）
  // ⭐ 0.8.7：任务板那一屏**第一行那颗药丸**当前选的是哪一块 —— 空串 = 任务板自己
  //    （默认，也是药丸的第一项），其余 = 某个模块借这一屏的位置贡献的视图（**模块名**，
  //    由接线表的 `slots: ['board-pane']` 声明，0.8.7 起是 `idea`）。
  //    ⚠️ 与电脑端 `desktop/state.js` 的同名字段**逐字同义**，两处一起改。
  //    ⚠️ 手机端的任务板**没有**「四象限 / 甘特图」那一层 ⇒ 这里没有与 `boardPane` 撞名的风险。
  boardTab: '',
  day: null, // 进入应用时的「真实今天」，用于跨零点检测后整页刷新
  projects: [], // 项目列表（/api/bootstrap）
  byScope: {}, // 按作用域分组的任务：{ daily: [...], [项目 id]: [...] }
  all: [], // 上面分组的摊平结果，元素带 t / scope / name / icon / color
  summary: null, // 首页汇总（/api/bootstrap 的 summary）——⚠️ 0.4.5 起手机版只剩「项目」屏还在用它
  // ⭐ 0.4.5 首页看板（「今天」这一屏）：`preset` 是三档预设（today / week / month，手改日期后是 'custom'），
  //    `range` 是折出来的闭区间，`data` 是 `GET /api/dashboard` 的响应。
  //    ⚠️ 区间**必须住 state**、不许只放在 DOM 上：切区间会整块重画 `#today-body`。
  // ⭐ 0.5.2：`preset` 多了一档 `day`（**单日**＝用户挑的那一天，不是「今日」）；
  //    `filter` 是「点了概览上哪个数」（`core/dashboard.js` 的 `DASH_FILTERS` 的 key，空串＝不筛选）；
  //    `error` 是上一次取看板数据失败的原因（看板挂了不该拖垮整个首屏，见 `data.js`）。
  //    ⭐ 0.8.9再加两个（与电脑端 `desktop/state.js` **逐字同义**，两处一起改）：
  //    · `panel` = 工具栏下面展开了哪一块（'' | 'filter' | 'search'）；
  //    · `q` = 搜索词（纯前端筛，⛔ 不重新取数）。
  dash: { preset: 'today', range: { from: '', to: '' }, data: null, error: null, filter: '', panel: '', q: '' },
  // ⭐ 0.8.7：「今天」当前看的是**哪个视图** —— 空串 = 看板自己的**列表视图**；
  //    其余 = 某个模块贡献的视图（模块名，由接线表的 `dashView` 声明，0.8.7 起是 `'calendar'`）。
  //    ⚠️ 与电脑端 `desktop/state.js` 的同名字段**逐字同义**，两处一起改。
  //    ⚠️ 它是**看板自己的界面状态**，与 `cal`（日历模块的数据）不是一回事：看板只决定
  //    「什么时候挂那个视图、挂进哪个容器」，数据一律以 `state.cal` 为准（方案 §二·8）。
  //    ⚠️ 必须在**进屏**（`switchTab('today')`）与服务端数据刚到（`data.js` 的 `loadAll()`）时
  //    按偏好重落一次 —— 见 `views/today.js` 的 `snapDashView()`。
  dashView: '',
  // ⭐ 0.5.2：首屏取数的两个标记 —— `loading` 为真是「正在取」，`loadError` 非空是「上一次取失败了」。
  //    顶栏靠它们决定写什么：以前只有一句「正在读取…」，取数一悬着它就永远挂在那儿，
  //    界面看着像死机（报的手机端卡死）。⚠️ 必须住 state：顶栏会被整块重画，
  //    写在 DOM 上分分钟被抹掉。
  loading: false,
  loadError: null,
  health: null, // 服务健康状态（/api/bootstrap 的 health，含 readOnly）
  me: null, // 当前登录账号（/api/auth/me，含 is_admin）
  // ⭐ 0.5.0 模块化重构：模块清单（`/api/bootstrap` 的 `modules`，服务端扫 `app/modules/` 聚合而来）。
  //    ⚠️ 初值是 null 而**不是空数组**：「还没拿到」与「服务端说一个模块都没有」对界面是两件不同的事
  //    （前者不能判显隐、后者要真的一颗入口都不画），见 app.js 的 applyPrefsVisibility()。
  modules: null,
  members: null, // 成员列表（仅管理员；进「更多」页时才加载）
  adminLoaded: false, // 成员数据是否已加载过（首屏不拉，见 m/data.js 文件头）
  adminLoading: false, // 成员数据是否正在加载（防重复触发）
  memberMeId: null, // 成员列表里「我」的 id
  allowSelfRegister: true, // 自主注册开关
  storage: null, // 数据位置（/api/admin/storage，仅管理员）
  // ---- ⭐ 0.9.1 各端最新版本（更多 → 设置 → 版本数据）----
  //    `null` = 这次还没检查过（**进页面不自动联网**：许可协议写明只有主动点「检查更新」才请求一次）。
  //    值是 `GET /api/versions` 的整份载荷（成功 `{ok:true, items}`，失败 `{ok:false, message}`）——
  //    ⚠️ 失败也存：不存就分不清「没查过」与「查了连不上」。
  versions: null,
  versionsBusy: false, // 正在请求中（按钮转「检查中…」并禁用，防连点）
  sheetSave: null, // 底部弹层上挂的保存回调，弹层关闭前由事件处理调用
  sheetTask: null, // 详情弹层当前对应的任务包装项
  confirmResolve: null, // 确认层的 Promise resolve，关闭弹层时按「取消」兑现
  // ---- 课表：与任务板互不干扰 ----
  ttTerms: [], // 学期列表
  ttTermId: null, // 当前学期
  tt: null, // 当前 schedule 响应
  ttWeek: null, // 当前周次（null = 全学期）
  ttDay: null, // 当前选中的星期 1..7
  ttLoaded: false, // 是否已加载过（进入标签时按需加载）
  ttWeekInit: false, // 是否已做过「默认落到本周」的初始化
  ttWizard: null, // 导入向导临时状态
  ttTemplates: [], // ⭐ 内置高校模板清单（0.3.5；进导入向导时按需拉一次）
  // ---- 网址收藏夹（0.3.0）----
  bmItems: [], // 当前筛选结果（每条含 tag_ids / tag_names）
  bmTags: [], // 分类列表（含每个分类下的书签数）
  bmTagId: null, // 当前选中的分类筛选；null = 全部
  bmTotalAll: 0, // 不带任何筛选时的总数（筛选中也保持显示，不跟着变小）
  bmQuery: '', // 搜索关键词（列表页输入框的值）
  bmError: null, // 上一次取列表失败的原因（有值时列表区显示错误块而不是空态）
  bmLoaded: false, // 是否已拉过一次（标签页按需加载，见 app.js 的 switchTab）
  // ⭐ 0.8.5 关联密码库：⚠️ 这三样**都不落盘、也不进任何快照**：
  //    · `bmVaultFor`   正在关联 / 查看的那条收藏 id；
  //    · `bmVaultNext`  「验过主密码之后要干的事」（一个函数，⛔ 别改成枚举名再在别处 switch）；
  //    · `bmVaultShown` 当前弹层里那条的明文 —— **只在「看密码」那一层存在**，取消关联时清掉。
  bmVaultFor: 0,
  bmVaultNext: null,
  bmVaultShown: null,
  // ---- NAS硬件管理（0.3.1）----
  hwItems: [], // 当前筛选结果（每条含服务端算好的 life）
  hwSummary: null, // 顶部概览行（全部 / 在用 / 想买 / 已退役 / 需关注 + 三个金额合计）
  hwCategories: [], // **当前子类别下面**的子分类清单（含每类件数），筛选中保持全量
  hwSections: [], // 子类别那一行药丸（含每格件数与 `active` 标记）—— 0.8.10 批 4
  hwSectionId: '', // 当前子类别 id（药丸高亮的基准、下拉的基准）—— 0.8.10 批 4
  hwRootId: '', // 「数码管理」那一格的 id（新建子类别要拿它当父格）—— 0.8.10 批 4
  // ⭐⭐ 0.8.23：硬件模板清单（内置 11 个 + 自建，`{ id, name, builtin, fields }`）——
  // 「新建先选一个模板」、表单里的「专业参数」那一组都靠它（与电脑端 `state.hwTemplates` 同名同义）。
  hwTemplates: [],
  //    ⭐ 0.8.10：药丸行的**合并模式**（`null` = 不在模式里；`{ids: [...]}` = 进了模式、勾了哪几格）。
  //    ⚠️ 它是**纯界面状态**，进这一屏时清掉（`mountHardware()`），⛔ 不落库、⛔ 不跨屏留着。
  hwMerge: null,
  //    ⭐⭐ 0.8.24（「【三个管理】合并为管理」）：「管理」弹层当前停在哪一页 ——
  //    第一页 `'catman'`（**类别管理**：类别与分类合并成的一棵两级树）/ 第二页 `'tpl'` 模板。
  //    ⚠️ 同理是**纯界面状态**：⛔ 不进请求参数、⛔ 不落库。
  hwManageTab: 'catman',
  //    ⭐⭐ 0.8.24 任务三：类别管理那一页里展开了哪几个类别（数组）。
  //    ⭐⭐ 0.8.24 任务四（「进入默认全部折叠」）：初值是**空数组**（进来每格都收着）。
  hwManageOpen: [],
  hwQuery: '', // 搜索关键词（多个词都会被匹配）
  hwStatus: '', // 状态筛选：'' 全部 / 'owned' / 'wishlist' / 'retired'
  hwCategory: '', // 子分类筛选：'' 不细分（= 看当前子类别的全部）
  hwFocusAlert: false, // 是否「只看需关注」
  // ⭐ 0.5.2：排序改成**四个真字段**：`used` 使用时间 / `remain` 剩余寿命 /
  //    `price` 价格 / `new` 最近添加；`hwSortDesc` 是方向（true = 大 / 贵 / 新的在前）。
  //    ⚠️ 旧的 `alert`（该看的在前）不再是排序项 —— 它是一条**筛选**（顶部「⚠ 需关注」）。
  hwSort: 'used',
  hwSortDesc: true,
  hwError: null, // 上一次取列表失败的原因（有值时列表区显示错误块而不是空态）
  hwLoaded: false, // 是否已拉过一次（标签页按需加载，见 app.js 的 switchTab）
  // ---- 密码库（0.3.2）----
  //    ⚠️ 这里**只放解锁后的摘要**（标题 / 用户名 / 网址 / 标签），**绝不把密码留在 state 里**：
  //      详情弹层每次现取（`GET /api/vault/:id`），关掉弹层就没有明文密码还在内存里躺着
  //      （手机端那份额外放在 `modules/vault/mobile.js` 的模块级 `sheetItem` 里，随弹层一起丢）。
  vault: null, // 服务端状态：{ initialized, unlocked, lockAfterSeconds, lockMinutes }
  vaultItems: [], // 条目摘要列表（id / title / username / url / tags，**不含密码**）
  vaultBroken: 0, // 解不开的条目数（密文被改过），界面上要明确说出来，不能静默
  vaultTimer: null, // 解锁倒计时的定时器句柄（离开这一屏或锁定时必须清掉）
  vaultLeft: 0, // 距自动锁定还剩多少秒（界面上的倒计时）
  // ⭐ 筛选态（0.4.4 起）**必须住这里**、不许只放在 DOM 上：
  //    重画会把写在 class / value 上的条件抹掉，表现是「一保存就自己跳回全部」而**不报错**。
  vaultQuery: '', // 关键词（标题 / 用户名 / 网址，多词 AND）
  vaultTag: null, // 标签筛选：null = 全部；{kind:'none'} = 未分类；{kind:'tag', name} = 某个标签
  // ⭐⭐ 0.8.18 任务八：**绑在这个密码条目上的网址收藏**（键 = 条目 id 的字符串形式，值 = 收藏夹条目数组）。
  //    ⚠️ 绑定关系的唯一真相在收藏夹那边（`bookmarks.vault_entry_id`），这里只是一份**只读快照**，
  //    每次 `loadVault()` 跟着列表一起取（收藏夹模块不在时是空对象 ⇒ 绑定区块整块不显示）。
  vaultBmLinks: {},
  // ---- 设置页与对话列表的分区折叠（0.3.3）----
  // ⭐ 0.5.5 起是**三态**（见 `views/more.js` 的 `isFolded()`）：
  //    `undefined` = 没动过（走该块的默认值）、`true` = 手动收起、`false` = 手动展开。
  //    ⚠️ 设置页与对话**共用这一个对象** —— 对话那几块的 id 必须带 `teamwork-` 前缀，否则撞名。
  foldSecs: {}, // 只放内存、不落 localStorage
  // ---- 番茄钟（0.7.5）----
  // ⚠️ 与电脑版**同名同义**（版式可以各写一份，字段与语义只有一份）——
  //    `pomoTaskId` 当初只有手机端需要（那两个下拉住底部弹层里，选完就没了，得把选择留住）；
  //    ⭐ 0.8.33 起电脑版也一样：那两个下拉搬进了「设置」弹窗，弹窗一关节点就没了。
  // ⚠️ 这里**只放服务端给的「事实」**（`started_at` / `planned_seconds` / `paused_*`）——
  //    ⛔ **绝不出现「剩余秒数」这样的字段**：剩余每一拍都由 `core/clock.js` 的 `remaining()`
  //    **算出来**。攒出来的剩余会切后台停走、切回来就漂、刷新归零。
  pomo: null, // `GET /api/pomodoro` 的响应：{ nowMs, session, prefs, stats }
  pomoLoaded: false, // 这一屏取过数没有（手机端按需加载，与 `hwLoaded` / `ideaLoaded` 同款）
  pomoScopes: [], // 可绑的作用域（项目清单；拉不到就是空数组 ⇒ 只能「不绑」）
  pomoTasks: [], // 当前作用域下的任务清单（`[]` = 这个作用域下没有可绑的）
  pomoScope: '', // '' 不绑 | 'daily' 日常任务 | 项目 id 的字符串
  pomoTaskId: null, // 选中的任务 id（`null` = 还没选）；⚠️ 两端都用，见上面那条说明
  pomoDueSaid: false, // 这一轮的「到点」提示弹过没有（⛔ 别每秒弹一次）
  pomoBaseTitle: '', // 进屏前的 `document.title`（到点闪一下，离开或确认后还回去）
  // ---- 日历（0.7.5；⭐ 0.8.7  起是「今天」里的第二个视图）----
  // ⚠️ 这里放的是**服务端给的那一份**（事件 + 四个图层 + 服务端「今天」）——
  //    ⛔ 前端不自己算「今天」、不自己判「某天有课」（
  //    日历是消费方，不是判定方；第二份口径的下场是「课表页有这节、日历上没有」且不报错）。
  //    ⭐ 视图本身由「今天」通过插槽动态挂载（`mobile-dash-view.js`），数据仍以这里为准。
  cal: null, // `GET /api/calendar` 的响应：{ today, from, to, events, prefs, layers, life }
  // ⚠️ 这两个**必须住 state**、不许只放在 DOM 上：换月与点某天都会重画，
  //    写在节点上的月份 / 选中日会被抹掉，表现是「翻到下个月又自己跳回本月」而不报任何错。
  calMonth: '', // 当前显示的月份 `YYYY-MM`（换月只改它，再重取一次）
  calDay: '', // 当前选中的那一天 `YYYY-MM-DD`（点某天只改它 —— ⛔ 不换屏，决策 49）
  // ⚠️ 0.7.8：「人生日历」是**同一屏的第二个视图**，不是第 12 块屏 ——
  //    这个字段决定页头画哪一套（`'month'` 月视图 | `'life'` 人生日历）。
  //    与 `calMonth` / `calDay` 一样**只住内存**（⛔ 不落 localStorage）：切走再回来保留当前视图，
  //    与电脑端一致；⛔ 也不挂 DOM class —— 这一屏会整块重画，挂节点上会被抹掉。
  calTab: 'month',
  // ⭐⭐ 0.8.30：「番茄钟与日程表」这一屏**停在哪一格** —— `'home'` 首页日程表 / `'timetable'` /
  //    `'pomodoro'` / `'trip'`（四格，与 `modules/time/home-shared.js` 的 `TIME_PANES` 同一套名字）。
  //    ⚠️⚠️ **必须有初值**：它一缺，`paintTimePanes()` 就拿 `undefined` 去和四个 pane 逐个比，
  //    四个**全被加上 `hidden`** ⇒ 进这一屏**整块空白**；而首页那三颗进子屏的按钮就画在里面，
  //    也被一起藏了 ⇒ 用户连自救（点一下切回来）都做不到。
  //    这个洞是 `0.8.13` 并版那次留下的：`tripTab` / `calTab` / `lgSeg` 都有初值，单单漏了它
  //    （手机端 真机报「进这一屏一片空白」就是这么来的；电脑端因为 `openTime()`
  //    会把归一化后的值写回 state 才一直没露）。
  //    ⚠️ 与 `desktop/state.js` 的同名字段**逐字同义**，两处一起改。
  timeTab: 'home',
  // ---- 行程（0.8.6）：同上，独立于任务板 ----
  // ⚠️ 这里放的是**服务端给的那一份**（一屏：今天 / 三档开关 / 下一张票 / 行程列表 / 车票列表）。
  trip: null, // `GET /api/trip` 的响应：{ today, prefs, upcoming, trips, tickets }
  // ⚠️ 这几个**必须住 state**：这一屏会整块重画，挂在节点上的会被抹掉。
  tripTab: 'main', // 屏内子屏：`main` 主屏 | `detail` 行程详情 | `ticket` 车票表单 | `track` 轨迹屏
  tripId: 0, // 当前打开的行程 id（0 = 没打开任何行程）
  tripForm: null, // 车票表单的编辑草稿（null = 还没打开过表单）
  tripPoints: null, // 轨迹屏的点（`GET /api/trip/points` 的 `points` 数组；null = 还没取过）
  tripPointsTrip: 0, // 轨迹屏看的是哪个行程的点（0 = 不挂行程的那些）
  tripCi: null, // 打卡子屏的临时态：{ locating, error }
  // ---- 记账（0.8.0）：同上，独立于任务板 ----
  // ⚠️ 这里放的是**服务端算好的那一份**（资产 / 负债 / 净值 ＋ 分组小计 ＋ 账户 ＋ 当年快照）——
  //    ⛔ 前端不自己 sum 金额、不自己算「今天」（方案 §三 /  同源）。
  lg: null, // `GET /api/ledger/overview` 的响应：{ today, totals, groups, accounts, snapshots, years }
  // ⭐ 0.8.0 记账：当前选中的「分类视图」（0 = 按账户类型；其余是 `ledger_views` 的 id）。
  //    ⚠️⭐ 0.8.1 起它**仍然是「按哪套分类看账户」那一个数字 id** —— 屏内那两段控件
  //    （资产 ｜ 记账）用的是下面的 `lgSeg`。⚠️ 电脑端**逐字同一条口径**（`desktop/state.js`
  //    的 `lgSeg` 那段注释写了理由）：`Number('entry')` 会悄悄变成 `NaN`，借 `lgView`
  //    会把「按哪套分类看」一起搞坏，而**不报任何错**。
  lgView: 0,
  // ⭐⭐ 0.8.2：手机端「进记账 = 全屏接管」——
  //    宿主那套底部主导航让位给**记账自己的导航**
  //    （⛔ 没有「图表」—— 图表仍是资产那一侧的内部视图）。
  //    ⭐ 0.8.3：它是**四格**了（`明细 ｜ 预算 ｜ 资产 ｜ 设置`）——
  //    「撤销记账中导航栏里的记账，改为悬浮 + 标志进入记账，参考手机端的今天的+创建任务」
  //    ⇒ 「记账」那一格撤掉，「记一笔」的入口改成屏级那颗**悬浮钮**（⭐ 0.8.20 起它是
  //    `#view-assets` 里的 `#assets-new`，与数码管理的「＋ 新增」共用一颗）。
  //    这个字段就是那四格的当前格，⭐ **默认 `'detail'`（打开即明细，T32）**。
  //    ⚠️⭐ 它**取代**了 0.8.1 那句「默认 `'entry'`（打开即记账）」——
  //     明写「它取代了 2 期 里『默认落记账』 ⇒ 落地时两处一起改，
  //    ⛔ 不许只改一半」（另一半是 `desktop/state.js` 的 `lgSeg`）。
  //    ⚠️ 只住内存（⛔ 不落 localStorage，与 `lgTab` / `calTab` 同款）；⚠️ 必须住 state ——
  //    这一屏会整块重画，挂在 DOM class 上会被抹掉。
  //    ⚠️ `'asset'` 那一侧**保持 1 期原样**（净值卡 ＋ 分类胶囊 ＋ 分组列表，图表仍是它内部的第二个视图）。
  lgSeg: 'detail',
  // ⭐ 0.8.3：**记账设置二级菜单**当前看的是哪一页 —— 空串 = 设置首页（四条目那张列表），
  //    非空 = `calc.js` 的 `SET_PAGES` 里的一个 `key`（`acct` / `cat` / `imp`）。
  //    ⚠️⚠️ 判据只认 `setPageOf()` 那一处（`calc.js`）：认不出**一律回落到首页**（空串），
  //    ⛔ 别在两端各判一遍 —— 各判一遍必然漂移，而且表现是"某一端点进去站着的是另一页"。
  //    ⚠️⭐ 子页是**二级屏**（照账户详情那条分寸）：顶栏收起来 ＋ 屏内自画「‹ 返回」条，
  //    ⛔ 不压历史栈（`syncHistory()` 只认底部标签那一层）。⚠️ 只住内存；
  //    ⚠️ 与 `desktop/state.js` 的同名字段**逐字同义**，两处一起改。
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
  // ⭐ 0.8.1 `'asset'` 那一侧内部还是 1 期那条「资产 / 图表」两个视图（⛔ 图表不是导航上的一项）。
  lgTab: 'asset', // 手机端「资产 / 图表」两个视图（⚠️ 电脑端两个视图同屏，不需要它）
  lgRange: 'asset', // 图表看哪一侧：`asset` | `debt` | `net`
  lgYear: 0, // 走势图看哪一年（0 = 还没取过数 ⇒ 首次加载后填成服务端的「今年」）
  // ⭐ 0.8.0：**账户详情屏**（二级屏）当前在看哪个账户（0 = 还在列表屏）。
  //    ⚠️ 必须住 state、⛔ 不挂 DOM class —— 这一屏整块重画，挂在节点上会被抹掉。
  //    ⚠️ 它同时是「顶栏要不要收起来」的判据（见 `mobile/app.js` 的 `updateChrome()`），
  //    与对话的 `teamworkView === 'thread'` 同一手法。
  lgAcct: 0,
  // ---- ⭐ 0.8.1 记账 2 期：流水 / 收支分类 / 默认账户 / 记一笔（照电脑端逐字同名同义）----
  //    ⚠️ 下面这一整组**全部只住内存**（⛔ 不落 localStorage， 同款）；⚠️ 必须住 state ——
  //    这一屏整块重画，挂在 DOM 上会被抹掉（表现是「翻页又跳回第一页」这种不报错的错）。
  lgMonth: '', // 流水列表看哪个月（空串 = 服务端今天那个月，⛔ 不用本机时钟）
  lgMonths: [], // 本次会话访问过的月（写操作之后也要能回到那个月 —— 服务端没有「有记录的月」那条接口）
  lgEntries: [], // 当前流水列表（一次 30 条，翻页往后累加）
  lgCursor: null, // 下一 30 条的游标（`null` = 到底了 / 还没取）；⚠️ 分页只用游标，⛔ 不用 offset（C-15）
  lgDone: false, // 这个月是否已经取完（`false` + cursor 为 null = 还没取过）
  lgLoad: 'idle', // 流水那一片的三态：`idle` | `loading` | `done` | `error`
  lgErr: '', // 上一次取流水失败的原因（有值时画「读不到 ＋ 重试」，⛔ 绝不画成空态）
  lgCats: [], // 收支分类清单（`GET /api/ledger/categories`，两级一次性给全，含已归档）
  lgDefaults: null, // 默认账户（`GET /api/ledger/defaults`）—— 记一笔的预填与记账设置都读它
  lgDraft: null, // 「记一笔」的草稿（金额 / 收或支 / 一级 / 二级 / 账户 / 备注 / 时间）
  lgNotes: [], // 备注历史候选（**服务端一处给**，⛔ 前端不 distinct —— C-17 / 反向验证 ⑧）
  lgNotesCat: null, // 这批候选是哪个分类的（换类别要重取；`null` = 全部类别 —— C-23）
  // ⭐ 0.8.1（§7.4 / C-22）：账户详情那一屏的「变动类型」过滤 —— 四档**就是服务端的四个值**。
  lgType: 'all', // `all` | `entry` | `transfer` | `adjust`
  lgChgMonth: '', // 详情屏看哪个月（空串 = 服务端今天那个月）
  lgChg: [], // 三类混排（记账 ＋ 转账 ＋ 手动调整，每条带 `type`）
  lgChgCursor: null, // 详情屏的游标（与流水同一套）
  lgChgDone: false,
  lgChgLoad: 'idle', // 与流水同一套三态
  lgChgErr: '',
  // ⚠️ 0.8.1：原来那个 `lgSet`（＝「记账设置二级屏在不在」）**已删** ——
  //    把「记账设置」从二级屏**升成底部导航的第三格**（与 `资产` / `记账` 同级）
  //    ⇒ 它现在只是 `lgSeg` 的一个取值（`'set'`），⛔ 不再有「那一屏在不在」这个独立状态。
  // ⭐ 0.8.0：**眼睛**（点一下把所有金额糊成圆点要的）。
  //    ⚠️ **只住内存**：刷新 / 重开就回到「显示」—— 它防的是肩窥，⛔ 不是安全机制、⛔ 不落库
  //    （方案 §十二-5 当初留下的那个口子，这一批把它做成一颗眼睛）。
  //    ⭐ 0.8.1：它**必须覆盖记账那一屏**（流水列表 / 按天小计 / 详情明细一个不漏）——
  //    判据只住 `calc.js` 的 `fmtFen` / `fmtSide` / `fmtTx` / `fmtSignedFen` 那几处。
  lgHide: false,
  // ---- ⭐⭐ 0.8.2 记账 3 期：明细 / 账单 / 月详情 / 预算 四个屏 ----
  //    ⚠️ 与上面那一整组同一条口径：**只住内存**（⛔ 不落 localStorage），必须住 state
  //    （这一屏整块重画，挂 DOM class 上会被抹掉 ——）。
  //    ⚠️⭐ **金额一律由服务端给**（2 期 §5.4「前端不算钱」）⇒ 这里存的全是服务端那一份，
  //    ⛔ 前端不在这几个字段上做加减乘除。
  // 明细屏：`ledgerEntries` 搭车回来的当月合计与按天小计（§5.3 第 5 条 / §6.1 第 6 条）。
  lgSum: null, // { incomeFen, expenseFen }
  lgDayTotals: null, // { 'YYYY-MM-DD': { incomeFen, expenseFen } }
  // 账单那一格（⭐ 0.8.3 起它是**一级格**了，不再是「明细的子屏」—— 「明细中的账单独立出来，
  // 账单放到明细后面」）：三档 `week` | `month` | `year`，⭐ 默认 `month`（C-19）。
  // ⚠️ 原来那个 `lgBillOpen`（＝"账单屏在不在"）**已删**：它现在是 `state.lgSeg === 'bill'`。
  lgBillTab: 'month',
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
  //    这一页会整块重画，挂在 DOM 上的 checked / value 会被抹掉。
  lgExportWhat: ['entries'],
  lgExportFrom: '',
  lgExportTo: '',
  lgBillKey: '', // 当前期的 `period_key`（空串 = 用服务端「今天」所在的那一期）
  lgBill: null, // `GET /api/ledger/bill` 的响应
  lgBillLoad: 'idle', // `idle` | `loading` | `done` | `error`（三态必须分得开）
  lgBillErr: '',
  // 月详情页（⭐ **只有「月」有这一页**，T41）：`0` = 不在这一屏（与 `lgAcct` 同一条手法）。
  lgMdMonth: 0, // 看的是哪个月（`YYYY-MM`）；0 = 不在这一屏
  lgMd: null,
  lgMdLoad: 'idle',
  lgMdErr: '',
  // 预算屏：三档 `week` | `month` | `year`，⭐ 默认 `month`（C-18）。
  lgBudgetTab: 'month',
  lgBudgetKey: '', // 当前期的 `period_key`（空串 = 用服务端「今天」所在的那一期）
  lgBudget: null,
  lgBudgetLoad: 'idle',
  lgBudgetErr: '',
  // ⭐ 明细屏那颗「眼睛」复用上面的 `lgHide`（同一个字段、同一语义，⛔ 不新开第二个）。
};

