/**
 * desktop/modules.js —— 电脑版的**模块接线表**（清单里有哪些模块、什么顺序，由服务端定；这里写这一端画成什么样）
 *
 * 功能：一张「模块名 → 本端怎么画」的表 ——
 *      `nav`  = 侧栏那一颗入口按钮（id / 显示名 / 副标题 / 悬浮提示 / 点它进哪一屏）；
 *      `card` = 设置页「模块功能」栏里那一块介绍卡（id / 副标题 / 功能行 / 安全提醒）。
 *      另导出 `uiOf()`（按名字取一条，查不到回 null）与 `NAV_VIEWS`（本端有侧栏入口的那些屏名）。
 *
 * ⭐ 0.8.7起还有三种「**借位置**」的声明：
 *      `slots`        要借哪些槽 —— 片段文件名按 `<端>-<槽名>.js` 推（`core/slots.js` 的约定）；
 *      `settingsPane` 设置页那一栏（`{id, ico, label}` 纯数据）；
 *      `dashView`     这个模块**贡献给首页看板**的视图（`{label}`）—— 看板顶部那条胶囊按它画。
 *      ⚠️ 三者都是**纯数据**：接线表仍然不 import 任何视图 / 片段。
 *
 * ⭐ 为什么文案留在这里、而不是塞进 `module.json`（0.5.0 模块化重构的边界，见 `docs/公共/架构文档/08`）：
 *    `module.json` 是**模块身份证**，只写客观事实（名字 / 图标 / 顺序 / 表 / 接口 / 开关字段）；
 *    而「侧栏上叫『大学课表』、设置页上叫『课表』」是**界面的事**，两端本来就各叫各的
 *    （手机版底部标签叫「课表」、电脑版侧栏叫「大学课表」）—— 硬塞进身份证会让它说一种、界面说另一种。
 *    所以分工是：**身份证决定「有哪些模块、什么顺序」**，本表决定「这一端画成什么样」。
 *
 * ⚠️ 规则（`ttt/test/module-ui.test.js` 逐条钉住）：
 *   ① **不在清单里的模块，这一端一个入口都不画** —— 这就是「删目录验收」在前端成立的原因；
 *   ② **顺序不在这里**：画的时候按清单的顺序（`module.json` 的 `order`）遍历，本表只管文案；
 *   ③ **`name` / `icon` 可以不写**：没写就回落到 `module.json` 的 `title` / `icon`
 *      （所以下面除「大学课表」外都没有重复写名字 —— 「大学课表」是电脑版自己起的叫法）；
 *   ④ **没有 `nav`（或没有 `card`）就是这一端不画那一处**：任务板压根不在这张表里 ——
 *      它不是「一个可以关掉的功能入口」，它就是主界面本身（`switchField` 也是空的）。
 *
 * ⚠️ 本文件**刻意不 import 任何视图**（纯数据）：`shell.js` 要它、`views/settings.js` 也要它，
 *    一旦它去 import 视图，就会绕成 `shell.js → modules.js → views/*.js → shell.js` 的环
 *    （各视图都从 `shell.js` 取 `renderSidebar` / `showView`）。「点它去哪一屏」只写屏名，
 *    真正的打开动作在 `app.js` 的派发表里（那里本来就 import 了全部视图）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.34
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 76）、core/modules.js
 */

/**
 * 模块名 → 电脑版怎么画。
 *
 * 说明：⚠️ 这里**只允许出现 `module.json` 里真实存在的模块名**（写错一个名字，那个入口会静静地不出现）。
 *
 * @type {Object.<string, {icon?: string, nav?: Object, card?: Object}>}
 */
export const MODULES_UI = {
  tasks: {
    // ⭐⭐ 0.8.12：**协作那四个界面片段搬去了 `teamwork`** —— 任务板
    //    从此不借任何插槽 ⇒ 这一条**只剩一个 `icon`**。
    //    ⚠️ 它**仍然必须两端都在接线表里**：它是「不可关的模块」（`module.json` 的
    //    `switchField` 是 null），而 `module-ui.test.js` 要求这类模块要么进 `NO_UI`、
    //    要么两端都接线 —— 而任务板就是主界面本身，不属于 `NO_UI`。
    //    ⛔ 不写 `nav` / `card`：它在侧栏与设置页里**都不出现**。
    //    ⚠️⭐ 这里**没有 `slots`**：`teamwork-page` / `teamwork-board` 两个槽已挪到
    //    `teamwork` 条目（一个槽不能两边都声明 —— 两边都写会让其中一端静静地不挂）。
    icon: '🗂',
  },
  teamwork: {
    icon: '💬',
    // ⭐⭐ 0.8.12：`teamwork-page` / `teamwork-board` 两个槽**从 `tasks`
    //    挪到这里** —— 协作那一层的界面（登记器 ＋ 添加弹层 ＋ 看板本体）现在挂在
    //    **本模块自己的槽** 上，片段文件在 `modules/teamwork/{desktop,mobile}-teamwork-{page,board}.js`。
    //    ⛔ 一个槽不能两边都声明：`tasks` 条目里那份 `slots` 已整个删掉。
    slots: ['teamwork-page', 'teamwork-board', 'settings-pane'],
    // ⭐⭐ 2026-10-19（「团队协作中的设置应该在全局设置中也要有一份，
    //    两个设置是同一个，不是两边独立设置」）：
    //    它**开始借设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //    界面文件 `modules/teamwork/desktop-settings-pane.js` / `mobile-settings-pane.js`。
    //    ⚠️⭐ 那一栏**不是另写一套**：它调的就是模块自己的 `openTeamworkSettings()`
    //    （同一个弹窗 / 同一个底部弹层、同一份校验、同一批接口）—— 与「我的设备」那颗
    //    「设置」键同一条口径（全站只有一份设置实现）。
    //    ⚠️ 与手机端**逐字一致**（`module-ui.test.js` 钉着 label）。
    settingsPane: { id: 'teamwork', label: '团队协作' },
    nav: {
      id: 'nav-teamwork',
      // ⭐ 0.8.10 追加批：界面名从「对话」改成「协作」
      //    ⭐ 0.8.12：再改成「团队协作」—— 这一版连模块名 / 目录 / 表 / 接口
      //    一起换成了 `teamwork`（不再是「只改界面上的叫法」）。
      name: '团队协作',
      sub: '好友 · 私聊 · 实时',
      tip: '团队协作（好友 · 一对一私聊 · 实时推送）',
      view: 'teamwork',
      // ⭐⭐ 0.8.19 任务七：「首页看板、任务与随手记、团队协作 为本软件核心功能，
      //    所以不可以关闭，不可以拖动排序」⇒ `core: true` = 这一颗**提进核心组**：
      //    ① `shell.js` 的 `renderNavModules()` 把它画在静态那两块（首页看板 / 任务与随手记）**之后**、
      //       其余模块之前；② 它**不带 `draggable` / `data-navmod`** ⇒ 拖不动、也不能被当成落点。
      //    ⚠️ 与 `module.json` 的 `switchField: null`（不可关）**必须成对** —— 只改一处就是
      //    「能关不能拖」或「能拖不能关」，两种都不对。
      core: true,
    },
    // ⚠️⚠️ 0.8.19 任务七：**这里原来有一张 `card`**（设置页「团队协作」那一行开关 + 介绍 + 安全提醒）——
    //    本轮它**整块撤了**，理由有两条、缺一不可：
    //      ① 团队协作已改成**不可关闭**（`module.json` 的 `switchField: null`），而没有开关的模块
    //         不该被画成「可关的卡」（`module-ui.test.js` 钉着）；
    //      ② 那张卡上原本挂着一句安全提醒（「聊天内容在 NAS 上是能直接看到原文的…」）——
    //         它**不是被删掉了**：团队协作那一屏自己早有一句更完整的
    //         （`TEAMWORK_PRIVACY`：「消息以明文存在你自己的 NAS 上；登录与 HTTPS 保护的是访问通道，
    //         不是消息内容。」，两端同一句）。那条用例已改成守这个新落点。
    //    ⛔ 别为了「设置页少了一行」把它加回来 —— 开关都没了，卡就是多余的。
  },
  time: {
    // ⭐⭐ 0.8.13：**课表 / 番茄钟 / 行程三块并成一个模块** —— 界面名「番茄钟与日程表」，
    //    代码标识 `time`，内部是三个同级子模块（`app/modules/time/{timetable,pomodoro,trip}/`）。
    //    ⚠️ 三个接口前缀一个字没改（`/api/{timetable,pomodoro,trip}`），AI 的授权键与工具名也没动。
    //    ⚠️ 名字盖不住「行程」这一块（名字里只有「番茄钟」与「日程表」）——这是**有意接受**的代价，
    //      补法走**现成字段**：下面那句副标题把三块都写出来（零新机制）。
    //    ⚠️ 界面显示名走 `module.json` 的 `title` —— 这里**不写 `nav.name`**（不写就回落，与
    //      「生活记账 / 数码管理」那几处的先例一致）。
    //    ⚠️ 图标 `⏳`：与现有全部模块图标都不同形（📅 课表子屏 / 🍅 番茄钟子屏 / 🧳 行程子屏 /
    //      📆 日历 / 💰 记账 / 🔐 密码库 / 💼 资产 / 🔗 网址密码夹 / 💡 随手记 / 🧩 数码 / 🗂 任务 /
    //      💬 协作 / 🤖 AI）；⚠️ 三个**子屏**继续各用各的（📅 / 🍅 / 🧳）。
    icon: '⏳',
    nav: {
      // ⚠️ 屏名统一 `time`（与 `nav-trip` / `nav-teamwork` / `nav-assets` 同风格）：
      //    `nav-time` 是侧栏那颗按钮的 id，`view: 'time'` 是屏名，屏容器是 `#time-view`。
      id: 'nav-time',
      sub: '日程 · 番茄钟 · 行程',
      tip: '番茄钟与日程表（日程表 / 番茄钟 / 行程）',
      view: 'time',
    },
    card: {
      id: 'set-time',
      sub: '日程 · 番茄钟 · 行程',
      desc: '按周排开的日程表，另有专注计时、行程与车票。',
      tip: '',
      // ⭐ 0.8.13：**子开关清单**（一张卡 N 行，每行只提交自己那一个键）。
      //    ⚠️ `field` 就是 `users` 上的列名（与 `switchField` 同一套词汇），换算成接口键
      //    只在 `core/modules.js` 里做一次。与手机端**同序**（列名逐字一致，只有行名各端各的叫法）。
      subs: [
        { field: 'hide_timetable', label: '大学课表', tip: '' },
        { field: 'hide_pomodoro', label: '番茄钟', tip: '' },
        { field: 'hide_trip', label: '行程', tip: '' },
      ],
    },
  },
  bookmarks: {
    icon: '🔖',
    // ⚠️⭐ 0.8.7：**撤掉 `nav`** —— 收藏夹不再有自己的屏，界面挂进 `webpass` 那一屏的
    //    「网址」视图（`slots` 声明的那个插槽）。⚠️ 侧栏那一格因此消失，入口是 `webpass` 的 `nav`。
    // ⚠️⭐ `card` **必须留着**：设置页只为「带 `card` 的模块」画那一行（`views/settings.js` 的
    //    `moduleCards()`），而 `hide_bookmarks` 这颗开关就长在那张卡上 —— 撤了它等于
    //    把开关一起删掉，直接违反方案 §二·5「两个开关都留着」。
    slots: ['webpass-pane'],
    card: {
      id: 'set-bm',
      sub: '存网址 · 分类 · 搜索',
      desc: '收藏网址、自定义分类、搜索。',
      tip: '',
    },
  },
  webpass: {
    // ⭐⭐ 0.8.7 网址/密码夹—— **纯屏模块**：它自己一条功能都没有，只有那一屏
    //    （屏头一颗药丸 `网址收藏夹 ｜ 密码库`），两个视图的界面全由 `bookmarks` / `vault`
    //    的视图片段动态挂进来（`slots: ['webpass-pane']` + `core/slots.js` 的 `mountModuleSlot`）。
    //    ⚠️ 这一条**没有 `card`**：设置页只为带 `card` 的模块画那一行，而它不可关
    //    （`module.json` 的 `switchField: null`）⇒ 它在设置页里**完全不出现**，
    //    两个真开关仍照旧各占一行。
    //    ⚠️ 图标回落 `module.json` 的 `🔗`（⛔ 不与 `📅`/`📆`/`💰`/`🔐` 同形）。
    // ⭐ 0.8.32（「这些开关形同虚设」的后半）：这一屏的内容**全来自这两个模块**
    //    —— 它自己零功能 ⇒ 两个都关掉时，侧栏这一格入口也跟着消失（否则点进去是一块空白屏）。
    //    ⚠️ 判据在 `core/modules.js` 的 `entryOn()`，⛔ 别在这里写第二份；手机端那条同名声明
    //    在 `mobile/modules.js`（两端都写，`module-ui.test.js` 钉着两端的键一致）。
    needs: ['bookmarks', 'vault'],
    nav: {
      id: 'nav-webpass',
      sub: '网址 · 密码 · 一处进出',
      tip: '网址/密码夹（网址收藏夹与密码库，一屏切换）',
      view: 'webpass',
    },
  },
  idea: {
    // ⭐ 灵感库（0.7.1）：界面上叫「随手记」—— 模块 id / 目录 / 接口 / 表名仍是 `idea`。
    //    ⚠️ `defaultEnabled: true`：它是「随手记」的落点，默认该在；关掉的是入口，数据一行不动。
    //    ⚠️ 下面这几句都是界面上**逐字显示**的文案，与手机端**逐字一致**。
    //    ⚠️⭐ 0.8.7：**撤掉 `nav`** —— 随手记不再有自己的屏，界面挂进任务板那一屏的
    //    「随手记」视图（`slots` 声明的那个插槽）。⚠️ 侧栏那一格因此消失，入口是任务板那颗核心。
    //    ⚠️⭐ `card` **必须留着**：设置页只为「带 `card` 的模块」画那一行
    //    （`views/settings.js` 的 `moduleCards()`），而 `hide_idea` 这颗开关就长在那张卡上 ——
    //    撤了它等于把开关一起删掉。
    icon: '💡',
    slots: ['board-pane'],
    card: {
      id: 'set-idea',
      sub: '随手记 · 归档 · 变成任务',
      desc: '记下一闪而过的念头，之后能变成任务。',
      tip: '',
    },
  },
  assets: {
    // ⭐ 0.8.10：个人资产管理 —— **纯屏模块**（自己一张屏、屏头一颗药丸）。
    //    ⚠️⭐ 声明位置照着 `module.json` 的 `order`（38 < `digital` 的 40）——
    //      与手机端接线表**逐字同序**（`module-ui.test.js` 有一条断言钉着两端 `Object.keys()` 相等）。
    //    ⚠️ 药丸的项**不来自接线表**，而是来自数据（`GET /api/assets/groups` 里第一层的分组）：
    //      `生活记账` / `数码管理` 两格由服务端在第一次取数时自动建出来，用户还能自己加。
    //    ⚠️ 这一条**没有 `card`**：`module.json` 的 `switchField` 是 null（不可关），
    //      而 `module-ui.test.js` 有一条断言钉着「不可关的模块不许被画成可关的卡」。
    //    ⚠️ 它也没有 `slots`：药丸与正文都长在**本屏自己的**片段里（与 `webpass` 借位置不同）。
    //    ⚠️⭐ 宿主（`desktop/app.js`）**动态** import 本模块的屏，⛔ 不许改成静态 import ——
    //      静态 import 会让「删掉 `public/modules/assets/`」连累宿主页起不来（方案 §四·1）。
    //    ⚠️ 图标 `💼`：未被任何模块占用（与前后几颗都不撞形）。
    // ⭐ 0.8.32（与 `webpass` 同一条）：这一屏的内容全来自「生活记账」与「我的设备」——
    //    两个都关掉 ⇒ 这一格入口一起消失。判据在 `core/modules.js` 的 `entryOn()`。
    needs: ['ledger', 'digital'],
    nav: {
      id: 'nav-assets',
      sub: '生活记账 · 我的设备',
      tip: '个人资产管理（生活记账 / 我的设备）',
      view: 'assets',
    },
  },
  digital: {
    // ⭐ 0.8.10：原「NAS硬件管理」（模块名 `hardware`）**改名为「数码管理」** ——
    //    目录 / 表（`hardware_items`）/ 接口前缀（`apiPrefix = hardware`）一个字没动
    //    （方案 §二·4：表名是备份键、前缀是对外契约，都不是"好看不好看"的问题）。
    //    ⚠️⭐ 0.8.10：**撤掉 `nav`** —— 数码管理不再有自己的屏，界面挂进「个人资产管理」
    //    那一屏的药丸（`slots` 声明的那个槽）。⚠️ 侧栏那一格因此消失，入口是 `assets` 的 `nav`。
    //    ⚠️⭐ `card` **必须留着**：设置页只为「带 `card` 的模块」画那一行，而 `hide_digital`
    //    这颗开关就长在那张卡上 —— 撤了卡等于把开关一起删掉。
    //    ⚠️ 下面这几句是界面上**逐字显示**的文案，与手机端**逐字一致**。
    //    ⭐ 0.8.20：「数码管理」显示名改成「**NAS/数码管理**」——
    //    走**顶层 `title`**（侧栏入口与设置页那张卡都读它，同 `ledger` 的先例）。
    //    ⭐⭐ 0.8.24：「NAS/数码管理」再改成「**我的设备**」——
    //    名字要能盖住**家用电器**（洗衣机 / 冰箱 / 空调…），「NAS/数码」太窄。
    //    ⛔ 模块名 / 目录 / 表（`hardware_items`）/ 接口前缀（`hardware`）一个字不动。
    //    ⚠️ 存量那一格由 `assets/store.js` 的 `listAssetGroups()` 幂等改名（认两个旧名）。
    title: '我的设备',
    icon: '🧩',
    slots: ['assets-pane'],
    card: {
      id: 'set-digital',
      sub: '硬件台账 · 到期提醒 · 愿望单',
      desc: '记下买过什么、什么时候该换。',
      tip: '',
      //    ⭐⭐ 0.8.24 任务四（「这个设置要在全局设置中设置，全局设置和设置
      //    应该指向同一个设置，不能两边独立代码」）：卡上多一颗**「设置」**按钮 ——
      //    点击走 `core/slots.js` 的 `openModuleSettings('desktop', <模块名>)`，按约定
      //    import `modules/digital/desktop-settings.js`（一行转发到 `manageHw()`）。
      //    ⇒ 它与左栏底下那颗「设置」是**同一个弹层、同一份代码**。
      settings: true,
    },
  },
  calendar: {
    // ⭐ 日历（0.7.5）—— ⭐⭐ **0.8.7起它不再有自己的屏**：
    //    「日历自己作为独立模块，视图显示上日历不独立显示，在设置中删除日历模块开关，
    //    变为一个药丸开关【默认使用日历视图】」。
    //    ⚠️⭐ 所以这一条**没有 `nav`、也没有 `card`**，两处都是**判据**而不是省事：
    //      · 没有 `nav` ⇒ 侧栏那一格消失（它不再是一屏，入口改成看板顶部那条胶囊）；
    //      · 没有 `card` ⇒ 设置页「模块功能」那一块连那颗开关一起消失 —— 因为
    //        `module.json` 的 `switchField` 已改成 `null`（不可关的模块），而
    //        `module-ui.test.js` 有一条断言钉着「不可关的模块不许被画成可关的卡」；
    //      · 它改借两处位置：**看板的视图槽**（`dashView` ＋ `slots` 里的 `dash-view`）与
    //        **设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`）。
    //    ⚠️ 图标仍用 `📆`（**不是** `📅`）—— 课表已经占了 `📅`，两个模块并排用同一个图标
    //    在侧栏上根本分不出谁是谁（0.8.7 起它出现在看板胶囊上，同一条理由）。
    //    ⚠️ `settingsPane.label` 与 `dashView.label` 两端**逐字一致**（④，
    //    `module-ui.test.js` 比对 label）。
    icon: '📆',
    slots: ['settings-pane', 'dash-view'],
    settingsPane: { id: 'calendar', ico: '📆', label: '日历视图' },
    dashView: { label: '日历视图' },
  },
  ledger: {
    // ⭐ 0.8.0 记账：左侧一颗入口，与收藏夹 / 数码管理同款（`order` 47，
    //    紧挨在日历之后、密码库之前）。
    //    ⚠️ 图标用 `💰` —— 它与前后的 `📆`（日历）/ `🔐`（密码库）都不同形，侧栏上分得清。
    //    ⚠️ `defaultEnabled: true`：它是普适工具、**零出网**、零风险，默认该在；
    //    关掉的是入口（⛔ 账户与净值历史一行不删 —— 关的是看它的门，不是账本本身）。
    //    ⚠️ 文案与手机端**逐字一致**（决策 67 ④，`module-ui.test.js` 逐字比对 desc / tip）。
    //    ⭐ 0.8.10：界面显示名改「**生活记账**」—— 模块名 / 目录 / 表 / 接口 / 独立库 /
    //    开关 / AI 授权项**一个字没动**（照「灵感库 → 随手记」的先例）。
    //    ⚠️⭐ 显示名走**顶层 `title`**（侧栏入口与设置页那张卡都读它）——
    //    只写 `nav.name` 的话，设置页里那一行还会叫「记账」，两处说法不一致（方案 §九 C-11）。
    title: '生活记账',
    icon: '💰',
    // ⚠️⭐ 0.8.10：**撤掉 `nav`** —— 记账不再有自己的屏，界面挂进「个人资产管理」那一屏的
    //    药丸（`slots` 声明的那个槽）。⚠️ 侧栏那一格因此消失，入口是 `assets` 的 `nav`。
    //    ⚠️⭐ `card` **必须留着**（`hide_ledger` 那颗开关的宿主）；⛔ 也别去掉 `title` ——
    //    设置页里那一行读的是它（两处说法必须一致，方案 §九 C-11）。
    //    ⭐⭐ 0.8.21（「生活记账的【设置】在全局设置中也要有一份」）：
    //    它另借**设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //    界面文件 `modules/ledger/desktop-settings-pane.js`。
    //    ⚠️ 与密码库 / 日历同一种形态（既有**视图槽** `assets-pane`，又有**设置分栏**）——
    //    两处都要声明，且 `slots` 与手机端**逐字一致**（`module-ui.test.js` 钉着）。
    slots: ['assets-pane', 'settings-pane'],
    settingsPane: { id: 'ledger', ico: '💰', label: '生活记账' },
    card: {
      id: 'set-ledger',
      sub: '资产 · 负债 · 净资产',
      desc: '记下每个账户有多少钱，算出净资产。',
      tip: '',
    },
  },
  vault: {
    icon: '🔐',
    // ⚠️⭐ 0.8.7：**撤掉 `nav`** —— 密码库不再有自己的屏，界面挂进 `webpass` 那一屏的
    //    「密码」视图。⚠️ `card` **永远不许撤**（`hide_vault` 那颗开关的宿主）。
    //    ⚠️⭐ **四条红线一个字没动**（见 `16-密码库.md`）：未解锁仍回 **403**、绑定仍
    //    单独验一次主密码、「切到网址 / 关掉本模块」仍清前端明文（`zx:pane-flush` 留白事件）。
    //    ⭐⭐ 0.8.18（截图批注：「自动锁定时间设置移动到全局设置中」）：
    //    它另借**设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //    界面文件 `modules/vault/desktop-settings-pane.js`。
    //    ⚠️ 它与日历同一种形态（既有**视图槽** `webpass-pane`，又有**设置分栏**）——
    //    两处都要声明、且 `slots` 与手机端逐字一致（`module-ui.test.js` 钉着）。
    slots: ['webpass-pane', 'settings-pane'],
    settingsPane: { id: 'vault', ico: '🔐', label: '密码库' },
    card: {
      id: 'set-vault',
      sub: '主密码 · 密文保存 · 自动上锁',
      desc: '用一把主密码加密保存各种密码。',
      tip: '⚠️ 主密码忘了就永远打不开了：谁也帮不了你，请记牢（这是刻意的，不是缺陷）。',
    },
  },
  ai: {
    // ⭐ ai辅助任务（0.6.0）—— ⭐⭐ **0.8.9起它不再有自己的屏**：
    //    「撤销独立显示卡，因为全是设置，现在并入全局设置中的 AI 设置里」。
    //    ⚠️⭐ 所以这一条**没有 `nav`、也没有 `hub`/`tab`**，两处都是**判据**而不是省事：
    //      · 没有 `nav` ⇒ 侧栏那一格消失、`OPEN_MODULE` 里也没有它（`app.js` 那处一起撤的），
    //        而且**看板「其它」里那张卡也不再出**（`views/home.js` 的 `briefRowsOf()`：
    //        没有独立屏的模块不出「去那一屏」的卡 —— 那扇门现在指向设置页）；
    //      · 它改借**设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //        界面文件 `modules/ai/desktop-settings-pane.js`。
    //    ⚠️ `card` **保留**：它是设置页「模块功能」里 `hide_ai` 那颗开关的宿主。
    //    ⚠️ `defaultEnabled: false`：它是项目第一个会把内容发往第三方接口的功能，
    //    「开」必须是用户亲手做的选择；关掉的是入口与插槽，配置数据一行不动。
    //    ⚠️⭐ `slots` 与手机端**逐字一致**（`module-ui.test.js` 钉着）——
    //    `teamwork-page` / `teamwork-thread` 是「对话页问 AI」那条真功能，⛔ 别跟着一起撤。
    //    ⚠️ `settingsPane.label` 两端逐字一致（决策 67 ④，`module-ui.test.js` 比对）。
    slots: ['teamwork-page', 'teamwork-thread', 'settings-pane'],
    settingsPane: { id: 'ai', ico: '🤖', label: 'AI 设置' },
    card: {
      id: 'set-ai',
      sub: '团队协作页问 AI · 一键整理成任务',
      desc: '让 AI 把消息整理成任务草稿。',
      tip: '⚠️ 用这个功能时，你点选的内容会发送给你自己填写的 AI 服务地址；默认关闭，每个账号各开各的。',
    },
  },
};

/**
 * 功能：按模块名取电脑版的接线条目。
 * @param {string} name - 模块名（= `app/modules/` 下的目录名）
 * @returns {?Object} 接线条目；本端不画这个模块时返回 null（调用方据此跳过，见 `core/modules.js`）
 */
export const uiOf = (name) => MODULES_UI[name] || null;

/**
 * 有侧栏入口的那些**屏名**（由接线表推出来）。
 *
 * 说明：⚠️ 这是「当前这一屏属于哪个模块」的唯一判据，用在 `shell.js` 的 `applyPrefsVisibility()` 里：
 *      模块被本账号关掉、或整个目录被删掉时，人正停在其中一屏上就得送回首页看板
 *      （「停在已经看不到的页面上」是这一块最容易犯的错）。
 *
 * @type {Array.<string>}
 */
export const NAV_VIEWS = Object.values(MODULES_UI)
  .filter((u) => u.nav)
  .map((u) => u.nav.view);
