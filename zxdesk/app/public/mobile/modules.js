/**
 * mobile/modules.js —— 手机版的**模块接线表**（清单里有哪些模块、什么顺序，由服务端定；这里写这一端画成什么样）
 *
 * 功能：一张「模块名 → 本端怎么画」的表 ——
 *      `tab`  = 这个模块**有被摆到底部标签栏的能力**（`{ id, view, name, seq?, def? }`：
 *      `def: true` 表示「没排过时的出厂默认」（就是团队协作 + 课表那两颗），`seq` 是本端的顺序微调）；
 *      `hub`  = 「更多」页里那一行入口（收藏夹 / 随手记 / 个人资产管理 / 数码管理 / 密码库 / 番茄钟…）；
 *      `card` = 「设置 → 模块功能」里那一行开关。
 *      另导出 `uiOf()`（按名字取一条）与 `HUB_VIEWS`（「更多」页入口通向的那些屏名）。
 *
 * ⭐ 0.8.7起还有三种「**借位置**」的声明，与电脑端**同形同义**：
 *      `slots`        要借哪些槽 —— 片段文件名按 `<端>-<槽名>.js` 推（`core/slots.js` 的约定）；
 *      `settingsPane` 设置页那一块（`{id, ico, label}` 纯数据）；
 *      `dashView`     这个模块**贡献给首页看板**的视图（`{label}`）—— 手机端的看板就是「今天」。
 *
 * ⭐ 0.8.5 导航排序（「手机端在更多中设置首页导航栏显示的东西和排序」）：
 *    底栏那几颗**模块标签不再写死**（改造前是「接线表里有 `tab` 就必摆」，于是只有对话 + 课表）——
 *    现在**每个模块都声明 `tab` 能力**，实际摆哪两颗由用户在这个账号的 `nav_tabs` 偏好里挑
 *    （判据只在 `core/modules.js` 的 `navTabItems()` 一处，两端共用）。
 *    ⚠️ 底栏**固定那四颗**（今天 / 任务板 / 更多 / 设置）由 `mobile/index.html` 静态画好，⛔ 不在这里。
 *
 * ⭐ 与电脑版的分工完全一样（见 `desktop/modules.js` 的文件头）：**身份证决定「有哪些模块、什么顺序」**，
 *    本表决定「这一端画成什么样」。两端的 `desc` / `tip` **必须逐字一致**（④，
 *    `ttt/test/module-ui.test.js` 会逐字比对），所以改文案时两边都要改。
 *
 * ⚠️ 规则：
 *   ① **不在清单里的模块，这一端一个入口都不画** —— 删掉模块目录 ⇒ 底部标签 / 「更多」行 / 开关一起消失；
 *   ② **顺序不在这里**：按清单的顺序（`module.json` 的 `order`）遍历 —— 「更多」页那些行
 *      跟着 `order` 排（收藏夹 → 随手记 → 数码管理 → 密码库），与设置页、电脑版侧栏同一套顺序。
 *      ⭐ **例外**：底部**模块标签**的先后归用户偏好（`nav_tabs`）—— 没排过时才按
 *      `tab.seq ?? order` 排（团队协作用 `seq: 15` 顶替「项目」原来的位置），
 *      所以本文件的条目声明顺序**仍然决定出厂默认的呈现顺序**，新加带 `tab` 的模块时
 *      把条目插到对应的声明位置上；
 *   ③ **`name` 可以不写**：没写就回落到 `module.json` 的 `title`（行名都回落，
 *      所以这里除了 `svg` 没有重复的名字）；⚠️ `svg` 必须写 —— 手机版画的是线性图标，
 *      `module.json` 里只有 emoji，回落不过去；
 *   ④ **任务板不在这张表里**：它不是「一个可以关掉的功能入口」，它就是主界面本身
 *      （`switchField` 也是空的）。
 *
 * ⚠️ `act` 一律用两个**通用动作**（`mod-open` / `mod-toggle`）+ `data-mod` 指模块名：
 *    每加一个模块就多一个 `case 'hw-open'` 那种写法，正是这次重构要消灭的东西。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.34
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 67 / 76）、core/modules.js
 */

/**
 * 模块名 → 手机版怎么画。
 *
 * 说明：⚠️ 这里**只允许出现 `module.json` 里真实存在的模块名**（写错一个名字，那个入口会静静地不出现）。
 *
 * @type {Object.<string, {svg: string, tab?: Object, hub?: Object, card?: Object}>}
 */
export const MODULES_UI = {
  tasks: {
    // ⭐⭐ 0.8.12：**协作那两个槽搬去了 `teamwork`** —— 任务板从此不借
    //    任何插槽。⚠️ 它**仍然必须两端都在接线表里**：它是「不可关的模块」（`module.json`
    //    的 `switchField` 是 null），`module-ui.test.js` 要求这类模块要么进 `NO_UI`、
    //    要么两端都接线 —— 而任务板是主界面本身，不属于 `NO_UI`。
    //    ⛔ 不写 `tab` / `hub` / `card`：它在底栏、更多页与设置页里**都不出现**。
    //    ⚠️ `svg` 仍留着（任务板那一屏的图标用它，手机版一贯画线性图标）。
    //    ⚠️⭐ 这里**没有 `slots`**：`teamwork-page` / `teamwork-board` 已挪到 `teamwork`
    //    条目（一个槽不能两边都声明 —— 两边都写会让其中一端静静地不挂）。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M8.4 10.4l1.7 1.7 3.2-3.6M12.6 15.6h4.2"/></svg>',
  },
  teamwork: {
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v11H9.5L4.5 20.5v-4H4z"/></svg>',
    // ⭐⭐ 0.8.12：`teamwork-page` / `teamwork-board` 两个槽**从 `tasks`
    //    挪到这里** —— 协作那层的界面（登记器 ＋ 添加弹层 ＋ 看板本体）现在挂在**本模块
    //    自己的槽**上，片段文件在 `modules/teamwork/{desktop,mobile}-teamwork-{page,board}.js`。
    //    ⚠️ 两个槽的文件都必须真实存在（`module-ui.test.js` 钉着接线表 slots 声明的文件）：
    //       `mobile-teamwork-page.js`（登记器 ＋ 添加弹层）与 `mobile-teamwork-board.js`（看板本体）。
    //    ⛔ 一个槽不能两边都声明：`tasks` 条目里那份 `slots` 已整个删掉。
    slots: ['teamwork-page', 'teamwork-board', 'settings-pane'],
    // ⭐⭐ 2026-10-19（「团队协作中的设置应该在全局设置中也要有一份，
    //    两个设置是同一个，不是两边独立设置」）：与电脑端**逐字同一份声明**。
    //    ⚠️⭐ 设置页那一块打开的就是模块自己的底部弹层（`openTeamworkSettings()`），
    //    ⛔ 不是另写一份表单。
    settingsPane: { id: 'teamwork', label: '团队协作' },
    // ⭐ 0.5.2：对话从「更多」页入口**升为底部标签**，顶替被删掉的「项目」那一颗
    //    （「删除现在的项目视图，项目位置替换为对话」）。
    //    ⚠️ `seq` 是**本端的标签排序微调**：底部标签默认按清单 `order` 排（课表 20 在前），
    //    但「项目」原来的位置 —— 即任务板之后、课表之前（对话的清单 order 是 60，
    //    照排会落到课表后面）。`renderModuleTabs()` 按 `tab.seq ?? order` 排序，只影响手机端，
    //    电脑版侧栏与设置页开关的顺序仍跟清单（`order`）走。
    //    ⭐ 0.8.5 导航排序：`def: true` = **默认就摆在底部标签栏上**（可以在「更多 → 首页导航栏」
    //    里换掉，见 `core/modules.js` 的 `navTabItems()`）。⚠️ 它只表示「没排过时的默认值」，
    //    ⛔ 不是「只能这两个」—— 0.8.5 起每个模块都能被用户挑上底栏。
    //    ⭐ 0.8.10 追加批：底栏那一颗的界面名从「对话」改成「协作」
    //    ⭐ 0.8.12：再改成「团队协作」—— 这一版连模块名 / 目录 / 表 / 接口
    //    一起换成了 `teamwork`（不再是「只改界面上的叫法」）。
    //    ⭐ 0.8.19 任务七：「团队协作**在手机端导航栏显示为协作**」⇒
    //    底栏那颗的界面名从「团队协作」缩成「**协作**」（底栏放不下四个字，与 `time`
    //    那颗叫「日程」同一条理由；模块标题仍是「团队协作」）。
    //    ⭐⭐ 0.8.19 任务七**残留**（同日第二轮）：「协作**不能自定义**，必须显示在导航栏」——
    //    它一度是 `def: true`（出厂默认，但仍能在「导航栏设置」里被换掉）⇒ 现在改成
    //    **`fixed: true`**：无条件摆上底栏、排在可选标签之前、**不出现在那张可选清单里**。
    //    ⚠️ 于是「可选档」的名额回到 2 个（`MAX_NAV_TABS`），底栏总数仍是 6 颗。
    //    ⚠️ `seq: 15` 保留：它决定固定档自己的先后（目前固定档只有它一颗）。
    tab: { id: 'tab-teamwork', view: 'teamwork', name: '协作', seq: 15, fixed: true },
    // ⚠️⚠️ 0.8.19 任务七：**这里原来有一张 `card`**（设置页那一行开关 ＋ 介绍 ＋ 安全提醒）——
    //    本轮**整块撤了**：团队协作已改成**不可关闭**（`module.json` 的 `switchField: null`），
    //    而没有开关的模块不该被画成「可关的卡」（`module-ui.test.js` 钉着）。
    //    ⚠️ 那上面那句安全提醒**没丢**：协作那一屏自己早有一句更完整的（`TEAMWORK_PRIVACY`），
    //    那条用例已改成守这个新落点。⛔ 别把这张卡加回来。
  },
  time: {
    // ⭐⭐ 0.8.13：**课表 / 番茄钟 / 行程三块并成一个模块** —— 界面名「番茄钟与日程表」，
    //    代码标识 `time`，内部三个同级子模块。三个接口前缀一个字没改。
    //    ⚠️ 底栏那一颗叫「**日程**」（`tab.name`，方案 §一 A5）：底栏宽度有限，只放得下两个字。
    //    ⚠️ `def: true` 保留 —— 课表本来就是底栏的**出厂默认**两颗之一（改造前的口径就是它俩），
    //      合并之后这一格接替它的位置（⚠️ 出厂底栏仍然**恰好 6 颗**，有用例钉）。
    //    ⚠️ `svg` 必须写（手机版画线性图标，`module.json` 里只有 emoji，回落不过去）。
    //    ⚠️ 图标 `⏳`（`module.json` 的 `icon`）与全部模块都不同形；三个子屏继续各用各的。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.6V2.8M8.4 2.8h7.2"/><circle cx="12" cy="13.4" r="8.2"/><path d="M12 8.6v4.8l3.2 2"/></svg>',
    hub: { view: 'time', sub: '日程 · 番茄钟 · 行程' },
    tab: { id: 'tab-time', view: 'time', name: '日程' },
    // ⚠️ 0.8.16：`def` 撤了，理由与上面 `teamwork` 那颗**逐字相同**（默认两颗让给收藏夹与资产；
    //    能力还在，用户可以在「设置 → 导航栏设置」里换进来）。
    card: {
      desc: '按周排开的日程表，另有专注计时、行程与车票。',
      tip: '',
      // ⭐ 0.8.13：**子开关清单** —— 与电脑端**同序、同列名**，只有行名各端各的叫法
      //    （电脑「大学课表」/ 手机「课表」，与两侧一直以来的叫法对齐）。
      subs: [
        { field: 'hide_timetable', label: '课表', tip: '' },
        { field: 'hide_pomodoro', label: '番茄钟', tip: '' },
        { field: 'hide_trip', label: '行程', tip: '' },
      ],
    },
  },
  bookmarks: {
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v15l-7-4.2-7 4.2V5a1.5 1.5 0 0 1 1.5-1.5z"/></svg>',
    // ⚠️⭐ 0.8.7：**撤掉 `hub` 与 `tab`** —— 收藏夹不再有自己的屏，
    //    界面挂进 `webpass` 那一屏的「网址」视图（`slots` 声明的那个插槽）。
    //    ⚠️ 撤 `tab` 之后，用户底栏配置（`users.nav_tabs`）里若还留着旧名字，
    //    `core/modules.js` 的 `navTabItems()` 会**自然忽略**它。
    //    ⚠️⭐ `card` **必须留着**：设置页只为带 `card` 的模块画那一行，撤了它等于把
    //    `hide_bookmarks` 这颗开关一起删掉（方案 §二·5：两个开关都留着）。
    slots: ['webpass-pane'],
    card: {
      desc: '收藏网址、自定义分类、搜索。',
      tip: '',
    },
  },
  webpass: {
    // ⭐⭐ 0.8.7 网址/密码夹—— **纯屏模块**：手机端从「更多」进（`hub`）——
    //    ⚠️ 底部固定 6 颗标签，所以它只能走「更多」
    //    （被合并的收藏夹与密码库本来也都住「更多」）。⛔ **刻意不声明 `tab`**：
    //    这一屏是「一个入口装两个功能」，底栏那 6 颗的语义是主功能。
    //    ⚠️ `svg` 必须写（手机版画线性图标，`module.json` 里只有 emoji，回落不过去）。
    //    ⚠️ 它**没有 `card`**（不可关的模块，设置页里不出现）—— 两个真开关仍各占一行。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a3.6 3.6 0 0 0 5.1 0l2.9-2.9a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.4 10.6a3.6 3.6 0 0 0-5.1 0l-2.9 2.9a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/></svg>',
    // ⭐ 0.8.32（「这些开关形同虚设」的后半）：这一屏的内容**全来自这两个模块**
    //    —— 它自己零功能 ⇒ 两个都关掉时，底栏那颗标签与「更多」页那一行都跟着消失
    //    （否则点进去是一块空白屏）。⚠️ 判据在 `core/modules.js` 的 `entryOn()`；
    //    电脑端那条同名声明在 `desktop/modules.js`（两端都写，`module-ui.test.js` 钉着两端的键一致）。
    needs: ['bookmarks', 'vault'],
    hub: { view: 'webpass', sub: '网址 · 密码 · 一处进出' },
    // ⭐⭐ 0.8.16（「手机端：更多改名为导航栏设置，并移到设置中。网址/密码夹
    //    显示到导航栏，显示为**收藏夹**；个人资产管理显示为**资产**」）：本模块**开始声明 `tab`**
    //    —— 从前那句「⛔ 刻意不声明 `tab`」到这一版**不再成立**：底栏从「固定 6 颗」改成
    //    「今天 / 任务 / 模块×2 / 设置」五颗（「更多」那一颗撤了），收藏夹与资产正是那两颗模块标签。
    //    ⚠️ 底栏那颗的文案走 `tab.name`（**收藏夹**，不是模块标题「网址/密码夹」）——
    //    底栏宽度有限，这正是 `tab.name` 这个字段存在的理由（照 `time` 那颗叫「日程」的先例）。
    //    ⚠️ `seq` 决定默认顺序：与 `assets` 一起按 `seq` 排 ⇒ 收藏夹（20）排在资产（21）前面。
    tab: { id: 'tab-webpass', view: 'webpass', name: '收藏夹', seq: 17, def: true },
  },
  idea: {
    // ⭐ 灵感库（0.7.1）：界面上叫「随手记」（模块 id / 目录 / 接口 / 表名仍是 `idea`）。
    //    ⚠️⭐ 0.8.7：**撤掉 `hub` 与 `tab`** —— 随手记不再有自己的屏，
    //    界面挂进任务板那一屏的「随手记」视图（`slots` 声明的 `board-pane` 槽）。
    //    ⚠️ 撤 `tab` 之后，用户底栏配置（`users.nav_tabs`）里若还留着旧名字，
    //    `core/modules.js` 的 `navTabItems()` 会**自然忽略**它。
    //    ⚠️⭐ `card` **必须留着**：设置页只为带 `card` 的模块画那一行，撤了它等于把
    //    `hide_idea` 这颗开关一起删掉。
    //    ⚠️ `svg` **留着**：任务板那一屏的药丸就用它（手机端一贯画线性图标）。
    //    ⚠️ `card` 的 desc / tip 与电脑版**逐字一致**。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 17.5h5M10.5 20.5h3M12 3.5a5.5 5.5 0 0 1 3.4 9.8c-.4.3-.6.8-.6 1.3v.4H9.2v-.4c0-.5-.2-1-.6-1.3A5.5 5.5 0 0 1 12 3.5z"/></svg>',
    slots: ['board-pane'],
    card: {
      // ⭐ 0.8.5：界面上改叫「随手记」（模块 id / 接口 / 表名仍是 `idea`）—— 与电脑版逐字一致。
      desc: '记下一闪而过的念头，之后能变成任务。',
      tip: '',
    },
  },
  assets: {
    // ⭐⭐ 0.8.10**个人资产管理** —— **纯屏模块**：手机端从「更多」进（`hub`）——
    //    ⚠️ 底部固定 6 颗标签，所以它只能走「更多」。
    //    ⛔ **刻意不声明 `tab`**：这一屏是「一个入口装三块」的屏 —— 第一层药丸
    //    （生活记账 ｜ 数码管理 ｜ 用户自建分组）才是主角，底栏那几颗的语义是主功能
    //    （与 `webpass` 同一条先例）。
    //    ⚠️⭐ 它 **没有 `card`**：`module.json` 的 `switchField` 是 `null`（不可关），
    //    `module-ui.test.js` 钉着「不可关的模块不许被画成可关的卡」。
    //    ⚠️ `svg` 必须写（手机版画线性图标，`module.json` 里只有 emoji，回落不过去）。
    //    ⚠️ 屏内药丸的项来自 `GET /api/assets/groups` 的**数据**（不是这里写死的），
    //    本条目只回答「点开它去哪一屏」。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6.6" rx="7" ry="3"/><path d="M5 6.6v5.4c0 1.7 3.1 3 7 3s7-1.3 7-3V6.6"/><path d="M5 12v5.4c0 1.7 3.1 3 7 3s7-1.3 7-3V12"/></svg>',
    // ⭐ 0.8.32（与 `webpass` 同一条）：这一屏的内容全来自「生活记账」与「我的设备」——
    //    两个都关掉 ⇒ 底栏那颗标签与「更多」页那一行一起消失。判据在 `core/modules.js` 的 `entryOn()`。
    needs: ['ledger', 'digital'],
    hub: { view: 'assets', sub: '生活记账 · 我的设备' },
    // ⭐⭐ 0.8.16（「个人资产管理显示为**资产**」）：与 `webpass` 同一条改动 ——
    //    本模块开始声明 `tab`，底栏那颗叫**资产**（不是模块标题「个人资产管理」，四个字塞不进底栏）。
    //    ⚠️ 屏内那一层药丸（生活记账 ｜ 数码管理 ｜ 自建分组）一个字没变，仍是那一屏的主角。
    tab: { id: 'tab-assets', view: 'assets', name: '资产', seq: 16, def: true },
  },
  digital: {
    // ⭐⭐ 0.8.10：由 `hardware`「NAS硬件管理」**改名扩写**而来 ——
    //    目录 `git mv`、`module.json` 的 `name` / `title` / 开关列换成 `digital` / 「数码管理」/ `hide_digital`；
    //    ⚠️ **表名（`hardware_items`）与接口前缀（`hardware`）一个字不改**（备份键是表名、前缀是对外契约）。
    //    ⚠️⭐ 0.8.10：**撤掉 `hub` 与 `tab`** —— 数码管理不再有自己的屏，界面挂进
    //    「个人资产管理」那一屏的药丸（`slots` 声明的那个槽）。⚠️ 撤 `tab` 之后，用户底栏配置
    //    （`users.nav_tabs`）里若还留着旧名字，`core/modules.js` 的 `navTabItems()` 会**自然忽略**它。
    //    ⚠️ `svg` **留着**：药丸那一格画线性图标用的就是它（手机端一贯画线性图标）。
    //    ⛔ `card` **不许撤** —— 那是设置页 `hide_digital` 那颗开关的宿主。
    //    ⚠️ `card` 的 desc / tip 与电脑版**逐字一致**（决策 67 ④，`module-ui.test.js` 比对）。
    //    ⭐ 0.8.20：「数码管理」显示名改成「**NAS/数码管理**」——
    //    走**顶层 `title`**（与电脑版逐字一致；⛔ 模块名 / 表 / 接口一个字不动）。
    //    ⭐⭐ 0.8.24：「NAS/数码管理」再改成「**我的设备**」（与电脑版逐字一致）。
    title: '我的设备',
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8l8-4.5z"/><path d="M12 12l8-4.5M12 12v8.5M12 12L4 7.5"/></svg>',
    slots: ['assets-pane'],
    card: {
      desc: '记下买过什么、什么时候该换。',
      tip: '',
      //    ⭐⭐ 0.8.24 任务四（「这个设置要在全局设置中设置，全局设置和设置
      //    应该指向同一个设置，不能两边独立代码」）：与电脑版**同一套** —— 手机端「设置」页
      //    那一行上多一颗**「设置」**按钮，点击走 `core/slots.js` 的
      //    `openModuleSettings('mobile', <模块名>)`，按约定 import
      //    `modules/digital/mobile-settings.js`（一行转发到 `openHwManageSheet()`）。
      settings: true,
    },
  },
  calendar: {
    // ⭐ 日历（0.7.5）—— ⭐⭐ **0.8.7起它不再有自己的屏**：
    //    「日历自己作为独立模块，视图显示上日历不独立显示，在设置中删除日历模块开关，
    //    变为一个药丸开关【默认使用日历视图】」。
    //    ⚠️⭐ 所以这一条**没有 `hub`、没有 `tab`、也没有 `card`**，三处都是**判据**而不是省事：
    //      · 没有 `hub` ⇒ 「更多」页那一行消失；
    //      · 没有 `tab` ⇒ 它不再是「能被挑到底栏的模块」（⛔ 不是「不摆上去」——是**没有这个能力**）；
    //        ⚠️ 于是老用户 `nav_tabs` 里可能还留着 `calendar` 这个**悬空名字** ⇒
    //        `core/modules.js` 的 `navTabItems()` 只认「清单 ∩ 接线表里带 `tab` 的」，会忽略它
    //        （有一条用例钉着这件事）。
    //      · 没有 `card` ⇒ 设置页「模块功能」那一行连开关一起消失（`module.json` 的 `switchField`
    //        已是 `null`，`module-ui.test.js` 钉着「不可关的模块不许被画成可关的卡」）。
    //    ⭐ 它改借两处位置：**看板的视图槽**（`dashView` ＋ `slots` 里的 `dash-view`，
    //    手机端的「看板」就是「今天」这一屏）与**设置页的一块**（`settingsPane`）。
    //    ⚠️ 图标是「一本日历」而不是课表那种单张日历页 —— 两个模块并排时得能一眼分开
    //    （0.8.7 起它出现在「今天」顶部那条胶囊上，同一条理由）。
    //    ⚠️ `svg` **留着**：看板胶囊就用它（手机端一贯画线性图标）；`settingsPane.label` /
    //    `dashView.label` 与电脑端**逐字一致**（决策 67 ④，`module-ui.test.js` 比对 label）。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="15" rx="2.6"/><path d="M3.5 10.2h17M8 3.4v4.2M16 3.4v4.2M7.6 14.2h2.2M14.2 14.2h2.2"/></svg>',
    slots: ['settings-pane', 'dash-view'],
    settingsPane: { id: 'calendar', ico: '📆', label: '日历视图' },
    dashView: { label: '日历视图' },
  },
  ledger: {
    // ⭐ 0.8.0 记账：手机端从「更多」进（`hub`）——
    //    ⚠️ 底部固定 6 颗标签，所以它只能走「更多」。
    //    ⚠️ `svg` 必须写（手机版画线性图标，`module.json` 里只有 emoji，回落不过去）。
    //    ⚠️ `card` 的 desc / tip 与电脑版**逐字一致**。
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.6h13.4a2.6 2.6 0 0 1 2.6 2.6v6.4H6.6A2.6 2.6 0 0 1 4 15z"/><path d="M4 8.6V7.4A2.4 2.4 0 0 1 6.4 5h8.2"/><path d="M15.6 13.2h2.2"/></svg>',
    // ⭐ 0.8.10：**只改显示口径**（模块名 / 目录 / 表 / 接口 / 独立库 / 开关一字不动）。
    //    ⚠️⭐ 0.8.10：**撤掉 `hub` 与 `tab`** —— 记账不再有自己的屏，界面挂进
    //    「个人资产管理」那一屏的药丸（`slots` 声明的那个槽）。⚠️ 撤 `tab` 之后，用户底栏配置
    //    （`users.nav_tabs`）里若还留着旧名字，`core/modules.js` 的 `navTabItems()` 会**自然忽略**它。
    //    ⚠️ `svg` **留着**：药丸那一格画线性图标用的就是它。
    //    ⛔ `card` **必须留着**：设置页只为带 `card` 的模块画那一行，撤了它等于把 `hide_ledger`
    //    这颗开关一起删掉。
    //    ⭐⭐ 0.8.21（「生活记账的【设置】在全局设置中也要有一份」）：
    //    它另借**设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //    界面文件 `modules/ledger/mobile-settings-pane.js`。
    //    ⚠️ `slots` 与电脑端**逐字一致**、`settingsPane` 的 id / label 两端一致（`module-ui.test.js` 钉着）。
    slots: ['assets-pane', 'settings-pane'],
    settingsPane: { id: 'ledger', ico: '💰', label: '生活记账' },
    card: {
      desc: '记下每个账户有多少钱，算出净资产。',
      tip: '',
    },
  },
  vault: {
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10" width="15" height="10" rx="2.4"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2.5"/></svg>',
    // ⚠️⭐ 0.8.7：**撤掉 `hub` 与 `tab`** —— 密码库不再有自己的屏，
    //    界面挂进 `webpass` 那一屏的「密码」视图。⚠️ `card` **永远不许撤**（那是 `hide_vault` 的宿主）。
    //    ⚠️⭐ **四条红线一个字没动**（见 `16-密码库.md`）：未解锁仍回 **403**、绑定仍单独验一次
    //    主密码、「切到网址 / 关掉本模块 / 切到别的标签」仍清前端明文（留白事件 `zx:pane-flush`）。
    //    ⭐⭐ 0.8.18：「自动锁定时间设置移动到全局设置中」——
    //    它另借**设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //    界面文件 `modules/vault/mobile-settings-pane.js`。
    //    ⚠️ `settingsPane.label` **与电脑端逐字一致**（决策 67 ④，`module-ui.test.js` 比对）；
    //    `slots` 也两端逐字一致。
    slots: ['webpass-pane', 'settings-pane'],
    settingsPane: { id: 'vault', ico: '🔐', label: '密码库' },
    card: {
      desc: '用一把主密码加密保存各种密码。',
      tip: '⚠️ 主密码忘了就永远打不开了：谁也帮不了你，请记牢（这是刻意的，不是缺陷）。',
    },
  },
  ai: {
    // ⭐ ai辅助任务（0.6.0）—— ⭐⭐ **0.8.9起它不再有自己的屏**：
    //    「撤销独立显示卡，因为全是设置，现在并入全局设置中的 AI 设置里」。
    //    ⚠️⭐ 所以这一条**没有 `hub`、也没有 `tab`**（也没有 `nav` —— 那是电脑端的事）：
    //      · 没有 `hub` ⇒ 「更多」页里那一行消失（那几行本来就是按清单画的）；
    //      · 没有 `tab` ⇒ 底部那排标签里那一颗消失（`HUB_VIEWS` 也跟着少一个屏名）。
    //      · 它改借**设置页的一栏**（`settingsPane` ＋ `slots` 里的 `settings-pane`），
    //        界面文件 `modules/ai/mobile-settings-pane.js`。
    //    ⚠️ `card` **保留**：它是设置页「模块功能」里 `hide_ai` 那颗开关的宿主。
    //    ⚠️ `svg` **留着**：它另有用处（`card` 那一行画线性图标用的是它），⛔ 别跟着一起删。
    //    ⚠️⭐ `slots` 与电脑端**逐字一致**（`module-ui.test.js` 钉着）——
    //      `teamwork-page` / `teamwork-thread` 是「对话页问 AI」那条真功能，⛔ 别跟着一起撤。
    //    ⚠️ `settingsPane.label` 两端逐字一致（决策 67 ④，`module-ui.test.js` 比对）。
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
 * 说明：⚠️ 用在 `app.js` 的 `switchTab()` 里：从「更多」进去的那几屏，底部要**高亮「更多」**，
 *      否则底部一个高亮都没有，看起来像「当前不在任何一屏」。
 *      ⚠️ 这几个屏**不在**底部标签栏上，但按偏好显隐 / 被删掉时仍要把人送走 ——
 *      「更多」页那几行本身是按 `on` 渲染的（见 `views/more.js`），这里只管高亮。
 *
 * @type {Array.<string>}
 */
export const HUB_VIEWS = Object.values(MODULES_UI)
  .filter((u) => u.hub)
  .map((u) => u.hub.view);
