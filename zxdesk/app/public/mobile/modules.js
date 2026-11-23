/**
 * mobile/modules.js —— 手机版的**模块接线表**（清单里有哪些模块、什么顺序，由服务端定；这里写这一端画成什么样）
 *
 * 功能：一张「模块名 → 本端怎么画」的表 ——
 * `tab`  = 这个模块**有被摆到底部标签栏的能力**（`{ id, view, name, seq?, def? }`：
 * `def: true` 表示「没排过时的出厂默认」（就是团队协作 + 课表那两颗），`seq` 是本端的顺序微调）；
 * `hub`  = 「更多」页里那一行入口（收藏夹 / 随手记 / 个人资产管理 / 数码管理 / 密码库 / 番茄钟…）…
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 67 / 76）、core/modules.js
 */
export const MODULES_UI = {
  tasks: {
    // **协作那两个槽搬去了 `teamwork`** —— 任务板从此不借
    // 任何插槽。⚠️ 它**仍然必须两端都在接线表里**：它是「不可关的模块」（`module.json`
    // 的 `switchField` 是 null），`module-ui.test.js` 要求这类模块要么进 `NO_UI`、
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M8.4 10.4l1.7 1.7 3.2-3.6M12.6 15.6h4.2"/></svg>',
  },
  teamwork: {
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v11H9.5L4.5 20.5v-4H4z"/></svg>',
    // `teamwork-page` / `teamwork-board` 两个槽**从 `tasks`
    // 挪到这里** —— 协作那层的界面（登记器 ＋ 添加弹层 ＋ 看板本体）现在挂在**本模块
    // 自己的槽**上，片段文件在 `modules/teamwork/{desktop,mobile}-teamwork-{page,board}.js`。
    slots: ['teamwork-page', 'teamwork-board', 'settings-pane'],
    // 两个设置是同一个，不是两边独立设置」）：与电脑端**逐字同一份声明**。
    // 设置页那一块打开的就是模块自己的底部弹层（`openTeamworkSettings()`），
    // 不是另写一份表单。
    settingsPane: { id: 'teamwork', label: '团队协作' },
    // 对话从「更多」页入口**升为底部标签**，顶替被删掉的「项目」那一颗
    // （「删除现在的项目视图，项目位置替换为对话」）。
    // `seq` 是**本端的标签排序微调**：底部标签默认按清单 `order` 排（课表 20 在前），
    tab: { id: 'tab-teamwork', view: 'teamwork', name: '协作', seq: 15, fixed: true },
    // 任务七：**这里原来有一张 `card`**（设置页那一行开关 ＋ 介绍 ＋ 安全提醒）——
    // 本轮**整块撤了**：团队协作已改成**不可关闭**（`module.json` 的 `switchField: null`），
    // 而没有开关的模块不该被画成「可关的卡」（`module-ui.test.js` 钉着）。
  },
  time: {
    // **课表 / 番茄钟 / 行程三块并成一个模块** —— 界面名「番茄钟与日程表」，
    // 代码标识 `time`，内部三个同级子模块。三个接口前缀一个字没改。
    // `def: true` 保留 —— 课表本来就是底栏的**出厂默认**两颗之一（改造前的口径就是它俩），
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.6V2.8M8.4 2.8h7.2"/><circle cx="12" cy="13.4" r="8.2"/><path d="M12 8.6v4.8l3.2 2"/></svg>',
    hub: { view: 'time', sub: '日程 · 番茄钟 · 行程' },
    tab: { id: 'tab-time', view: 'time', name: '日程' },
    // `def` 撤了，理由与上面 `teamwork` 那颗**逐字相同**（默认两颗让给收藏夹与资产；
    // 能力还在，用户可以在「设置 → 导航栏设置」里换进来）。
    card: {
      desc: '按周排开的日程表，另有专注计时、行程与车票。',
      tip: '',
      // **子开关清单** —— 与电脑端**同序、同列名**，只有行名各端各的叫法
      // （电脑「大学课表」/ 手机「课表」，与两侧一直以来的叫法对齐）。
      subs: [
        { field: 'hide_timetable', label: '课表', tip: '' },
        { field: 'hide_pomodoro', label: '番茄钟', tip: '' },
        { field: 'hide_trip', label: '行程', tip: '' },
      ],
    },
  },
  bookmarks: {
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v15l-7-4.2-7 4.2V5a1.5 1.5 0 0 1 1.5-1.5z"/></svg>',
    // **撤掉 `hub` 与 `tab`** —— 收藏夹不再有自己的屏，
    // 界面挂进 `webpass` 那一屏的「网址」视图（`slots` 声明的那个插槽）。
    // 撤 `tab` 之后，用户底栏配置（`users.nav_tabs`）里若还留着旧名字，
    slots: ['webpass-pane'],
    card: {
      desc: '收藏网址、自定义分类、搜索。',
      tip: '',
    },
  },
  lab: {
    // 底栏那几颗的语义是「主功能」，实验室是**试用区**，不该占底栏（与 `webpass` / `assets`
    // 早期同一条先例）。⛔ **刻意不声明 `tab`**。
    // `card` **必须有**（`switchField: "hide_lab"`，可关 ⇒ 设置页要有那一行开关）。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.4 3.4h5.2M10.4 3.4v6.3l-3.6 7.6a2.5 2.5 0 0 0 2.2 3.6h6a2.5 2.5 0 0 0 2.2-3.6l-3.6-7.6V3.4"/><path d="M8.4 14.6h7.2"/></svg>',
    hub: { view: 'lab', sub: '新功能试用区' },
    card: {
      desc: '新功能先在这里试着用，稳定了再放出来。',
      tip: '⚠️ 这里的功能可能变、也可能撤；撤掉或试用结束时，你写下的内容都一条不删。',
    },
  },
  downloader: {
    // **借位置的实验功能**：与电脑端逐字同形 —— 没有自己的屏 / 「更多」里的入口 / 设置卡，
    // 只把界面挂进实验室那一屏的 `lab-pane` 槽。
    // 所以这里**刻意不写 `hub` / `tab`**（写了手机上就多一个进不去的入口），
    icon: '📥',
    slots: ['lab-pane'],
    // `design: true` = 这一格有**设计说明书**（与电脑端必须一致，`module-ui.test.js` 钉着）。
    lab: {
      // 与电脑端逐字同款：卡片叫「视频下载器」，进来之后屏头叫「快手作品下载器」。
      desc: '目前支持接入快手作品下载器，未来会提供多平台下载。',
      title: '快手作品下载器',
      design: true,
    },
  },
  secrets: {
    // 没有自己的屏 / 入口 / 设置卡，只把界面挂进实验室那一屏的 `lab-pane` 槽。
    // 所以这里**刻意不写 `hub` / `tab`**（写了手机上就多一个进不去的入口），
    // 也**刻意不写 `card`**（`switchField: null` ⇒ 不可关 ⇒ 不该有开关行）。
    icon: '🔑',
    slots: ['lab-pane'],
    // 与电脑端**逐字一致**（`module-ui.test.js` 比对）。
    // `design: true` = 这个实验有**设计说明书**（屏头那颗「设计说明」开的就是它），
    // 正文按约定从 `modules/<名>/design.js` 动态取 —— 两端这个字段也必须一致。
    lab: {
      desc: '长文本、图片、视频、文件等的加密，与密码库共用一个主密码与解锁机制。',
      design: true,
    },
  },
  webpass: {
    // 网址/密码夹—— **纯屏模块**：手机端从「更多」进（`hub`）——
    // 底部固定 6 颗标签，所以它只能走「更多」
    // （被合并的收藏夹与密码库本来也都住「更多」）。⛔ **刻意不声明 `tab`**：
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a3.6 3.6 0 0 0 5.1 0l2.9-2.9a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.4 10.6a3.6 3.6 0 0 0-5.1 0l-2.9 2.9a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/></svg>',
    // ：这一屏的内容**全来自这两个模块**
    // —— 它自己零功能 ⇒ 两个都关掉时，底栏那颗标签与「更多」页那一行都跟着消失
    // 电脑端那条同名声明在 `desktop/modules.js`（两端都写，`module-ui.test.js` 钉着两端的键一致）。
    needs: ['bookmarks', 'vault'],
    hub: { view: 'webpass', sub: '网址 · 密码 · 一处进出' },
    // （「手机端：更多改名为导航栏设置，并移到设置中。网址/密码夹
    // 显示到导航栏，显示为**收藏夹**；个人资产管理显示为**资产**」）：本模块**开始声明 `tab`**
    // —— 从前那句「⛔ 刻意不声明 `tab`」到这一版**不再成立**：底栏从「固定 6 颗」改成
    tab: { id: 'tab-webpass', view: 'webpass', name: '收藏夹', seq: 17, def: true },
  },
  idea: {
    // **撤掉 `hub` 与 `tab`** —— 随手记不再有自己的屏，
    // 界面挂进任务板那一屏的「随手记」视图（`slots` 声明的 `board-pane` 槽）。
    // 撤 `tab` 之后，用户底栏配置（`users.nav_tabs`）里若还留着旧名字，
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 17.5h5M10.5 20.5h3M12 3.5a5.5 5.5 0 0 1 3.4 9.8c-.4.3-.6.8-.6 1.3v.4H9.2v-.4c0-.5-.2-1-.6-1.3A5.5 5.5 0 0 1 12 3.5z"/></svg>',
    slots: ['board-pane'],
    card: {
      // 界面上改叫「随手记」（模块 id / 接口 / 表名仍是 `idea`）—— 与电脑版逐字一致。
      desc: '记下一闪而过的念头，之后能变成任务。',
      tip: '',
    },
  },
  assets: {
    // **个人资产管理** —— **纯屏模块**：手机端从「更多」进（`hub`）——
    // 底部固定 6 颗标签，所以它只能走「更多」。
    // **刻意不声明 `tab`**：这一屏是「一个入口装三块」的屏 —— 第一层药丸
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6.6" rx="7" ry="3"/><path d="M5 6.6v5.4c0 1.7 3.1 3 7 3s7-1.3 7-3V6.6"/><path d="M5 12v5.4c0 1.7 3.1 3 7 3s7-1.3 7-3V12"/></svg>',
    // ：这一屏的内容全来自「生活记账」与「我的设备」——
    // 两个都关掉 ⇒ 底栏那颗标签与「更多」页那一行一起消失。判据在 `core/modules.js` 的 `entryOn()`。
    needs: ['ledger', 'digital'],
    hub: { view: 'assets', sub: '生活记账 · 我的设备' },
    // ：与 `webpass` 同一条改动 ——
    // 本模块开始声明 `tab`，底栏那颗叫**资产**（不是模块标题「个人资产管理」，四个字塞不进底栏）。
    // 屏内那一层药丸（生活记账 ｜ 数码管理 ｜ 自建分组）一个字没变，仍是那一屏的主角。
    tab: { id: 'tab-assets', view: 'assets', name: '资产', seq: 16, def: true },
  },
  digital: {
    // 由 `hardware`「NAS硬件管理」**改名扩写**而来 ——
    // 目录 `git mv`、`module.json` 的 `name` / `title` / 开关列换成 `digital` / 「数码管理」/ `hide_digital`；
    // **表名（`hardware_items`）与接口前缀（`hardware`）一个字不改**（备份键是表名、前缀是对外契约）。
    title: '我的设备',
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8l8-4.5z"/><path d="M12 12l8-4.5M12 12v8.5M12 12L4 7.5"/></svg>',
    slots: ['assets-pane'],
    card: {
      desc: '记下买过什么、什么时候该换。',
      tip: '',
      // 任务四（「这个设置要在全局设置中设置，全局设置和设置
      // 应该指向同一个设置，不能两边独立代码」）：与电脑版**同一套** —— 手机端「设置」页
      // 那一行上多一颗**「设置」**按钮，点击走 `core/slots.js` 的
      settings: true,
    },
  },
  calendar: {
    // 「日历自己作为独立模块，视图显示上日历不独立显示，在设置中删除日历模块开关，
    // 变为一个药丸开关【默认使用日历视图】」。
    // 所以这一条**没有 `hub`、没有 `tab`、也没有 `card`**，三处都是**判据**而不是省事：
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="15" rx="2.6"/><path d="M3.5 10.2h17M8 3.4v4.2M16 3.4v4.2M7.6 14.2h2.2M14.2 14.2h2.2"/></svg>',
    slots: ['settings-pane', 'dash-view'],
    settingsPane: { id: 'calendar', ico: '📆', label: '日历视图' },
    dashView: { label: '日历视图' },
  },
  ledger: {
    // 记账：手机端从「更多」进（`hub`）——
    // 底部固定 6 颗标签，所以它只能走「更多」。
    // `svg` 必须写（手机版画线性图标，`module.json` 里只有 emoji，回落不过去）。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.6h13.4a2.6 2.6 0 0 1 2.6 2.6v6.4H6.6A2.6 2.6 0 0 1 4 15z"/><path d="M4 8.6V7.4A2.4 2.4 0 0 1 6.4 5h8.2"/><path d="M15.6 13.2h2.2"/></svg>',
    // **只改显示口径**（模块名 / 目录 / 表 / 接口 / 独立库 / 开关一字不动）。
    // **撤掉 `hub` 与 `tab`** —— 记账不再有自己的屏，界面挂进
    // 「个人资产管理」那一屏的药丸（`slots` 声明的那个槽）。⚠️ 撤 `tab` 之后，用户底栏配置
    slots: ['assets-pane', 'settings-pane'],
    settingsPane: { id: 'ledger', ico: '💰', label: '生活记账' },
    card: {
      desc: '记下每个账户有多少钱，算出净资产。',
      tip: '',
    },
  },
  vault: {
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10" width="15" height="10" rx="2.4"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2.5"/></svg>',
    // **撤掉 `hub` 与 `tab`** —— 密码库不再有自己的屏，
    // **四条红线一个字没动**（见 `16-密码库.md`）：未解锁仍回 **403**、绑定仍单独验一次
    // 主密码、「切到网址 / 关掉本模块 / 切到别的标签」仍清前端明文（留白事件 `zx:pane-flush`）。
    slots: ['webpass-pane', 'settings-pane'],
    settingsPane: { id: 'vault', ico: '🔐', label: '密码库' },
    card: {
      desc: '用一把主密码加密保存各种密码。',
      tip: '⚠️ 主密码忘了就永远打不开了：谁也帮不了你，请记牢（这是刻意的，不是缺陷）。',
    },
  },
  ai: {
    // 所以这一条**没有 `hub`、也没有 `tab`**（也没有 `nav` —— 那是电脑端的事）：
    // 没有 `hub` ⇒ 「更多」页里那一行消失（那几行本来就是按清单画的）；
    // 没有 `tab` ⇒ 底部那排标签里那一颗消失（`HUB_VIEWS` 也跟着少一个屏名）。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3.5v3.5M9.5 12h.01M14.5 12h.01M9.5 15h5"/></svg>',
    slots: ['teamwork-page', 'teamwork-thread', 'settings-pane'],
    settingsPane: { id: 'ai', ico: '🤖', label: 'AI 设置' },
    card: {
      desc: '让 AI 把消息整理成任务草稿。',
      tip: '⚠️ 用这个功能时，你点选的内容会发送给你自己填写的 AI 服务地址；默认关闭，每个账号各开各的。',
    },
  },
};

/**
 * 功能：按模块名取手机版的接线条目。
 * @param {string} name - 模块名（= `app/modules/` 下的目录名）
 * @returns {?Object} 接线条目；本端不画这个模块时返回 null（调用方据此跳过，见 `core/modules.js`）
 */
export const uiOf = (name) => MODULES_UI[name] || null;

/**
 * 「更多」页里那几行入口通向的**屏名**（由接线表推出来）—— 它们没有自己的底部标签。
 *
 */
export const HUB_VIEWS = Object.values(MODULES_UI)
  .filter((u) => u.hub)
  .map((u) => u.hub.view);
