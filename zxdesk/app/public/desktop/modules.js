/**
 * desktop/modules.js —— 电脑版的**模块接线表**（清单里有哪些模块、什么顺序，由服务端定；这里写这一端画成什么样）
 *
 * 功能：一张「模块名 → 本端怎么画」的表 ——
 * `nav`  = 侧栏那一颗入口按钮（id / 显示名 / 副标题 / 悬浮提示 / 点它进哪一屏）；
 * `card` = 设置页「模块功能」栏里那一块介绍卡（id / 副标题 / 功能行 / 安全提醒）。
 * 另导出 `uiOf()`（按名字取一条，查不到回 null）与 `NAV_VIEWS`（本端有侧栏入口的那些屏名）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 76）、core/modules.js
 */
export const MODULES_UI = {
  tasks: {
    // **协作那四个界面片段搬去了 `teamwork`** —— 任务板
    // 从此不借任何插槽 ⇒ 这一条**只剩一个 `icon`**。
    // 它**仍然必须两端都在接线表里**：它是「不可关的模块」（`module.json` 的
    icon: '🗂',
  },
  teamwork: {
    icon: '💬',
    // `teamwork-page` / `teamwork-board` 两个槽**从 `tasks`
    // 挪到这里** —— 协作那一层的界面（登记器 ＋ 添加弹层 ＋ 看板本体）现在挂在
    // **本模块自己的槽** 上，片段文件在 `modules/teamwork/{desktop,mobile}-teamwork-{page,board}.js`。
    slots: ['teamwork-page', 'teamwork-board', 'settings-pane'],
    // 两个设置是同一个，不是两边独立设置」）：
    // 它**开始借设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    // 界面文件 `modules/teamwork/desktop-settings-pane.js` / `mobile-settings-pane.js`。
    settingsPane: { id: 'teamwork', label: '团队协作' },
    nav: {
      id: 'nav-teamwork',
      // 界面名「团队协作」，模块名 / 目录 / 表 / 接口同名 `teamwork`。
      name: '团队协作',
      sub: '好友 · 私聊 · 实时',
      tip: '团队协作（好友 · 一对一私聊 · 实时推送）',
      view: 'teamwork',
      // `core: true` = 这一颗提进核心组：画在静态那两块（首页看板 / 任务与随手记）之后。
      core: true,
    },
    // 团队协作不画 `card`：它不可关闭（`module.json` 的 `switchField: null`），没有开关的模块不画介绍卡。
  },
  time: {
    // **课表 / 番茄钟 / 行程三块并成一个模块** —— 界面名「番茄钟与日程表」，
    // 代码标识 `time`，内部是三个同级子模块（`app/modules/time/{timetable,pomodoro,trip}/`）。
    // 三个接口前缀一个字没改（`/api/{timetable,pomodoro,trip}`），AI 的授权键与工具名也没动。
    icon: '⏳',
    nav: {
      // 屏名统一 `time`（与 `nav-trip` / `nav-teamwork` / `nav-assets` 同风格）：
      // `nav-time` 是侧栏那颗按钮的 id，`view: 'time'` 是屏名，屏容器是 `#time-view`。
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
      // **子开关清单**（一张卡 N 行，每行只提交自己那一个键）。
      // `field` 就是 `users` 上的列名（与 `switchField` 同一套词汇），换算成接口键
      // 只在 `core/modules.js` 里做一次。与手机端**同序**（列名逐字一致，只有行名各端各的叫法）。
      subs: [
        { field: 'hide_timetable', label: '大学课表', tip: '' },
        { field: 'hide_pomodoro', label: '番茄钟', tip: '' },
        { field: 'hide_trip', label: '行程', tip: '' },
      ],
    },
  },
  bookmarks: {
    icon: '🔖',
    // **撤掉 `nav`** —— 收藏夹不再有自己的屏，界面挂进 `webpass` 那一屏的
    // 「网址」视图（`slots` 声明的那个插槽）。⚠️ 侧栏那一格因此消失，入口是 `webpass` 的 `nav`。
    // `card` **必须留着**：设置页只为「带 `card` 的模块」画那一行（`views/settings.js` 的
    slots: ['webpass-pane'],
    card: {
      id: 'set-bm',
      sub: '存网址 · 分类 · 搜索',
      desc: '收藏网址、自定义分类、搜索。',
      tip: '',
    },
  },
  lab: {
    // 与 `webpass` 不同：**这一屏是自己的屏**（`nav.view: 'lab'`，不借别人的槽），
    // 反过来是实验功能借**它的**槽（`slots: ['lab-pane']`）。
    // `card` **必须有**：`module.json` 的 `switchField: "hide_lab"`（可关）⇒
    icon: '🧪',
    nav: {
      id: 'nav-lab',
      sub: '新功能试用区',
      tip: 'zx实验室（新功能先在这里试，可能变、可能撤）',
      view: 'lab',
    },
    card: {
      id: 'set-lab',
      sub: '新功能试用区',
      desc: '新功能先在这里试着用，稳定了再放出来。',
      tip: '⚠️ 这里的功能可能变、也可能撤；撤掉或试用结束时，你写下的内容都一条不删。',
    },
  },
  downloader: {
    // **借位置的实验功能**：没有自己的屏、没有侧栏入口、也没有设置卡
    // （模块身份证的 `switchField` 是 null ⇒ 不可关 ⇒ 不该长出开关行），
    // 只把界面挂进实验室那一屏的 `lab-pane` 槽。
    icon: '📥',
    slots: ['lab-pane'],
    // 实验室卡片首页上那一句说明（**纯数据**，与手机端逐字一致）。
    // `design: true` = 这一格有**设计说明书**（屏头那颗「设计说明」开的就是它），
    // 正文按约定住 `modules/downloader/design.js`，两端**同一份**、字段也必须一致。
    lab: {
      // 卡片叫「视频下载器」（这一格的身份：将来接别的平台也不用改名），
      // 进来之后屏头叫「快手作品下载器」（现在只有这一个下载器，里面就是它）。
      // `title` 只覆盖**屏头**（`lab/desktop.js` 的 `barHtml()`）；卡片仍用 `it.title`。
      desc: '目前支持接入快手作品下载器，未来会提供多平台下载。',
      title: '快手作品下载器',
      design: true,
    },
  },
  secrets: {
    // 它没有自己的屏、没有侧栏入口、也没有设置卡（`module.json` 的 `switchField` 是 null），
    // 只是把界面挂进实验室那一屏的 `lab-pane` 槽。
    // 所以这里**刻意不写 `nav`**（写了 `OPEN_MODULE` 就得多一个键，而它没有屏可开 ——
    icon: '🔑',
    slots: ['lab-pane'],
    // 它是**纯数据**（与 `card.desc` 同一性质）：实验室屏只按它画卡片，不认识任何具体实验。
    // 与手机端**逐字一致**（`module-ui.test.js` 比对）—— 同一个功能在两端说两句不同的话，
    // 用户会以为是两个东西。
    lab: {
      desc: '长文本、图片、视频、文件等的加密，与密码库共用一个主密码与解锁机制。',
      design: true,
    },
  },
  webpass: {
    // 网址/密码夹—— **纯屏模块**：它自己一条功能都没有，只有那一屏
    // （屏头一颗药丸 `网址收藏夹 ｜ 密码库`），两个视图的界面全由 `bookmarks` / `vault`
    // 的视图片段动态挂进来（`slots: ['webpass-pane']` + `core/slots.js` 的 `mountModuleSlot`）。
    needs: ['bookmarks', 'vault'],
    nav: {
      id: 'nav-webpass',
      sub: '网址 · 密码 · 一处进出',
      tip: '网址/密码夹（网址收藏夹与密码库，一屏切换）',
      view: 'webpass',
    },
  },
  idea: {
    // `defaultEnabled: true`：它是「随手记」的落点，默认该在；关掉的是入口，数据一行不动。
    // 下面这几句都是界面上**逐字显示**的文案，与手机端**逐字一致**。
    // **撤掉 `nav`** —— 随手记不再有自己的屏，界面挂进任务板那一屏的
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
    // 个人资产管理 —— **纯屏模块**（自己一张屏、屏头一颗药丸）。
    // 声明位置照着 `module.json` 的 `order`（38 < `digital` 的 40）——
    // 与手机端接线表**逐字同序**（`module-ui.test.js` 有一条断言钉着两端 `Object.keys()` 相等）。
    needs: ['ledger', 'digital'],
    nav: {
      id: 'nav-assets',
      sub: '生活记账 · 我的设备',
      tip: '个人资产管理（生活记账 / 我的设备）',
      view: 'assets',
    },
  },
  digital: {
    // 原「NAS硬件管理」（模块名 `hardware`）**改名为「数码管理」** ——
    // 目录 / 表（`hardware_items`）/ 接口前缀（`apiPrefix = hardware`）一个字没动
    // **撤掉 `nav`** —— 数码管理不再有自己的屏，界面挂进「个人资产管理」
    title: '我的设备',
    icon: '🧩',
    slots: ['assets-pane'],
    card: {
      id: 'set-digital',
      sub: '硬件台账 · 到期提醒 · 愿望单',
      desc: '记下买过什么、什么时候该换。',
      tip: '',
      // 任务四（「这个设置要在全局设置中设置，全局设置和设置
      // 应该指向同一个设置，不能两边独立代码」）：卡上多一颗**「设置」**按钮 ——
      // 点击走 `core/slots.js` 的 `openModuleSettings('desktop', <模块名>)`，按约定
      settings: true,
    },
  },
  calendar: {
    // 「日历自己作为独立模块，视图显示上日历不独立显示，在设置中删除日历模块开关，
    // 变为一个药丸开关【默认使用日历视图】」。
    // 所以这一条**没有 `nav`、也没有 `card`**，两处都是**判据**而不是省事：
    icon: '📆',
    slots: ['settings-pane', 'dash-view'],
    settingsPane: { id: 'calendar', ico: '📆', label: '日历视图' },
    dashView: { label: '日历视图' },
  },
  ledger: {
    // 记账：左侧一颗入口，与收藏夹 / 数码管理同款（`order` 47，
    // 紧挨在日历之后、密码库之前）。
    // 图标用 `💰` —— 它与前后的 `📆`（日历）/ `🔐`（密码库）都不同形，侧栏上分得清。
    title: '生活记账',
    icon: '💰',
    // **撤掉 `nav`** —— 记账不再有自己的屏，界面挂进「个人资产管理」那一屏的
    // 药丸（`slots` 声明的那个槽）。⚠️ 侧栏那一格因此消失，入口是 `assets` 的 `nav`。
    // `card` **必须留着**（`hide_ledger` 那颗开关的宿主）；⛔ 也别去掉 `title` ——
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
    // **撤掉 `nav`** —— 密码库不再有自己的屏，界面挂进 `webpass` 那一屏的
    // **四条红线一个字没动**（见 `16-密码库.md`）：未解锁仍回 **403**、绑定仍
    // 单独验一次主密码、「切到网址 / 关掉本模块」仍清前端明文（`zx:pane-flush` 留白事件）。
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
    // 所以这一条**没有 `nav`、也没有 `hub`/`tab`**，两处都是**判据**而不是省事：
    // 没有 `nav` ⇒ 侧栏那一格消失、`OPEN_MODULE` 里也没有它（`app.js` 那处一起撤的），
    // 而且**看板「其它」里那张卡也不再出**（`views/home.js` 的 `briefRowsOf()`：
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
 */
export const NAV_VIEWS = Object.values(MODULES_UI)
  .filter((u) => u.nav)
  .map((u) => u.nav.view);
