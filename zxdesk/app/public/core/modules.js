/**
 * core/modules.js —— 模块清单 × 本端接线表 → 界面上要画的入口项（两端唯一一份）
 *
 * 功能：把服务端 `GET /api/bootstrap` 回来的 `modules`（模块清单，由 `app/modules/registry.js`
 *      扫 `app/modules/` 目录聚合而来）与**本端的接线表**合并成一组「入口项」：
 *      `moduleItems(modules, uiOf, me)`；另导出 `prefsKeyOf()`，把 `module.json` 的
 *      `switchField`（`hide_bookmarks`，库里的列名）转成接口键（`hideBookmarks`）。
 *
 * ⭐ 为什么要有它（0.5.0 模块化重构，方案 `09-模块化重构` §四 第 5 行）：
 *    改造前两端各自手写一份「有哪些模块」的清单（侧栏五颗按钮、设置页五个开关、手机版四个入口），
 *    **删掉一个模块目录，界面上的入口照样在**（点了 404），加一个模块则要挨个文件补。
 *    现在：**「有哪些模块、什么顺序」只在 `module.json` 里写一次**，本端只写「这一端画成什么样」。
 *
 * ⭐ 规则（两端一致，`ttt/test/module-ui.test.js` 逐条钉住）：
 *   ① **入口 = 清单 ∩ 本端接线表**：接线表里没有的模块，这一端不画（一个模块要在界面上出现，
 *      就得有人接上「点它去哪一屏」——那是界面的事，不是模块自己的事）；
 *   ② **顺序一律取清单的顺序**（`module.json` 的 `order`）—— 本端接线表只管文案与接线，不管排序。
 *      于是删掉一个模块目录 ⇒ 清单里少一条 ⇒ **界面自动少一个入口**；
 *   ③ **文案兜底**：接线表没写 `title` / `icon` 时回落清单里的（即 `module.json` 的 `title` / `icon`）；
 *   ④ **开关状态**：`module.json` 的 `switchField` 为空（如任务板）时恒为「开着」——
 *      那类模块本来就没有开关（它就是主界面本身）。
 *
 * ⚠️ 与后端 `app/modules/registry.js` 的分工：那边管**代码**（表 / 接口 / 导出怎么聚合），
 *    这里只管**界面**；两边都从同一份 `module.json` 推导，谁都不再手写第二份清单。
 *
 * ⚠️ `switchField` → 接口键的换算是**机械的**（下划线转驼峰）：`PUT /api/auth/prefs` 收的就是
 *    `hideTimetable` 这种驼峰键（见 `core/routes/auth.js`），而库里是 `hide_timetable` 列。
 *    这条换算**只能有一份**（两端各写一份 ⇒ 一端悄悄 400），所以它住在这里。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.32
 * 相关：docs/公共/架构文档/01-架构总览.md、07-前端-电脑版与手机版.md、13-决策记录.md（决策 76）
 */

/**
 * 功能：把 `module.json` 的 `switchField`（库里的列名）转成 `PUT /api/auth/prefs` 认的接口键。
 *
 * 说明：`hide_bookmarks` → `hideBookmarks`。没有 `switchField`（不可关的模块）时回空串 ——
 *      调用方据此判断「这个模块没有开关」，而不是拿去提交一个空键。
 *
 * ⚠️⭐ 0.8.13：`switchField` 现在是 `string|string[]|null`。
 *      **数组**（一个模块几个子开关）走的是**另一条通道**（`prefsKeysOf()` ＋ 每条子行各提交自己那一个键），
 *      ⛔ 不走这条单键通道 ⇒ 这里回**空串**，调用方那句 `if (!it.prefsKey) return;` 正好把它挡住
 *      （⛔ 别让它返回数组：那会让 `applyPref()` 收到一个数组键，提交出去是 400）。
 *
 * @param {?string|Array.<string>} field - `module.json` 的 `switchField`，如 `'hide_bookmarks'`
 * @returns {string} 接口键，如 `'hideBookmarks'`；入参为空 / 是数组时返回空串
 */
export const prefsKeyOf = (field) =>
  typeof field === 'string' && field ? field.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()) : '';

/**
 * 功能：把 `switchField` 归一成**数组**（`null` → `[]`；单数 → 一件；复数原样）。
 *
 * 说明：⭐ 与后端 `app/modules/registry.js` 的 `switchFieldsOf()` **同一口径**（两端各一份，
 *      因为前端不许 require 后端的注册表）。消费方只认这一种形状，⛔ 不必各自写 `Array.isArray` 分支。
 *
 * @param {?string|Array.<string>} field - `module.json` 的 `switchField`
 * @returns {Array.<string>} 开关列名数组（可能为空）
 */
export const switchFieldsOf = (field) => {
  if (field === null || field === undefined) return [];
  return Array.isArray(field) ? field.slice() : [field];
};

/**
 * 功能：把 `switchField` 里**每一个**开关列都换算成接口键（数组）。
 *
 * 说明：⭐ 0.8.13：设置页那张卡要按它画 N 行、**每行只提交自己那一个键**
 *      （⛔ 绝不一次提交两个：会把另一台设备刚改的值覆盖掉）。单开关的模块得到的是**一件**数组。
 *
 * @param {?string|Array.<string>} field - `module.json` 的 `switchField`
 * @returns {Array.<string>} 接口键数组；没有开关时是空数组
 */
export const prefsKeysOf = (field) => switchFieldsOf(field).map(prefsKeyOf);

/**
 * 功能：把模块清单与本端接线表合并成界面上要画的入口项。
 *
 * 说明：返回项 = 接线表那一条（`card` / `nav` / `hub` / `tab` 等本端字段）+ 清单里的客观事实
 *      （`name` / `order` / `switchField`）+ 算好的开关状态（`on`）。
 *      ⚠️ 清单为空 / 还没到手（首屏之前是 `null`）时一律返回空数组 —— 调用方画不出东西，
 *      但**不许抛**：这两处调用都在渲染路径上。
 *
 * @param {?Array.<Object>} modules - `bootstrap.modules`（服务端已按 `order` 排好）
 * @param {Function} uiOf - `(name) => Object`：本端接线表；查不到时该模块这一端不画
 * @param {?Object} me - 当前登录账号（读它的 `hide_*` 决定开关状态）
 * @returns {Array.<Object>} 入口项数组，字段见下方 `return` 处
 */
export function moduleItems(modules, uiOf, me) {
  const out = [];
  for (const m of modules || []) {
    const ui = (uiOf && uiOf(m.name)) || null;
    if (!ui) continue;
    const field = m.switchField || null;
    const fields = switchFieldsOf(field);
    // ⚠️⭐ 0.8.13：子开关清单是**接线表的纯数据**（`card.subs`），
    //    每条的 `field` 就是 `users` 上的列名（与 `switchField` 同一套词汇）——
    //    「哪一列 → 哪个接口键」的换算只在这个文件里做一次。
    const subs = ((ui.card && ui.card.subs) || []).map((s) => ({
      ...s,
      prefsKey: prefsKeyOf(s.field),
      on: !(me && me[s.field]),
    }));
    out.push({
      ...ui,
      /** 模块名（= 目录名 = `module.json` 的 `name`）—— 本端接线表与清单靠它对上 */
      name: m.name,
      /** 界面上显示的名字：本端接线表优先，没写就用 `module.json` 的 `title` */
      title: ui.title || m.title,
      /** 图标：同上，本端优先 */
      icon: ui.icon || m.icon,
      /** 入口排序（来自 `module.json`）—— 画的时候已经是清单的顺序了，这里只留给断言看 */
      order: m.order,
      /** `module.json` 的 `switchField`（库里的列名；可能是数组）；不可关的模块是 null */
      switchField: field,
      /** 上一次那个字段归一成数组（`[]` = 不可关）—— ⭐ 0.8.13 新增 */
      switchFields: fields,
      /** 提交给 `PUT /api/auth/prefs` 的键名（单开关）；不可关 / 是数组时是空串 */
      prefsKey: prefsKeyOf(field),
      /** ⭐ 0.8.13：**每一个**子开关的接口键（单开关模块是一件数组） */
      prefsKeys: fields.map(prefsKeyOf),
      /** ⭐ 0.8.13：接线表声明的子开关行（含各自的接口键与开关状态）；没声明时是空数组 */
      subs,
      /** 这个账号现在开着它吗（不可关的模块恒为 true；多个子开关时**任一开着就算开着**） */
      on: fields.length ? fields.some((f) => !(me && me[f])) : true,
    });
  }
  return out;
}

/**
 * 功能：某个模块的**入口**此刻该不该出现 —— 「它自己开着」＋「它声明的 `needs` 里至少有一个开着」。
 *
 * 说明：⭐⭐ 0.8.32：「网址/密码夹」与「个人资产管理」这两个**纯屏模块**
 *      自己一条功能都没有（零表零接口），它们的屏完全靠别人借位置（`bookmarks` / `vault`、
 *      `ledger` / `digital`）⇒ 那些模块**全被关掉**之后，入口还在、点进去却是一块空白屏。
 *      ⇒ 接线表用**顶层 `needs`** 声明「这一屏的内容来自哪几个模块」，本函数据此决定入口画不画。
 *      ⚠️ 它只管**入口**（电脑版侧栏那一格 / 手机端底部标签与「更多」页那一行），
 *      ⛔ 不改模块自己的 `on` —— 设置页那颗开关读的仍是 `on`，两者是不同的东西。
 *      ⚠️ 没有 `needs` 的模块恒等于 `it.on`：绝大多数模块走这一支，行为与从前一字不差。
 *      ⚠️ 判据只写这一份，两端各调一次（⛔ 别在两端各拼一套名字比对）。
 *
 * @param {Object} it - `moduleItems()` 的一条
 * @param {Array.<Object>} items - 同一份 `moduleItems()` 产物（按名字找 `needs` 里那几个）
 * @returns {boolean} 真 = 这个入口该出现
 */
export function entryOn(it, items) {
  if (!it || !it.on) return false;
  const needs = it.needs;
  if (!Array.isArray(needs) || !needs.length) return true;
  return needs.some((n) => (items || []).some((x) => x && x.name === n && x.on));
}

// ---------- ⭐ 0.8.5 导航排序（两端的「顺序 / 取舍」偏好，判据全在这一份里） ----------
/**
 * 手机端底部标签栏里**最多放几个「可选」模块标签**（固定那几颗之外）。
 *
 * 说明：⭐ 底栏总数固定 **6 颗**（「保持 6 颗」）⇒ 6 − 4 = **2**。
 *      ⭐⭐ 0.8.19 任务七残留：「协作 **不能自定义**，必须显示在导航栏」——
 *      那几个「4」= 今天 / 任务 / **协作**（`tab.fixed`）/ 设置 ⇒ 可选的只剩 **2** 个
 *      （出厂默认就是**资产 ＋ 收藏夹**）。
 *      ⚠️ 上一轮它一度是 3（当时协作只是「出厂默认」、仍可被换掉）—— 那条口径已经被
 *      「协作固定」取代，⛔ 别把 3 加回来：那会让总数变成 7 颗。
 *      ⚠️ 这条判据**只写这一处**：手机端 UI 用它决定「还能不能再勾一个」，
 *      服务端不复制它（服务端只保证存进去的是一个结构合理的字符串 —— 见
 *      `core/routes/auth.js` 的 `navList()`：多写一份就多一个会漂移的真相）。
 *
 * @type {number}
 */
export const MAX_NAV_TABS = 2;

/**
 * 功能：把库里存的 `users.nav_order` / `users.nav_tabs` 解析成模块名数组（两端唯一一份）。
 *
 * 说明：⭐ 库里是**逗号分隔的串**（理由见 `schema/core.js` 的建表语句），这里统一负责解析。
 *      ⚠️ `null` / `undefined` = **从没排过**，回空数组 —— 调用方据此走默认顺序；
 *      而**空串**（`''`）同样回空数组，但它的语义是「用户明确排成空的」——
 *      两者在 `navTabItems()` 里靠 `== null` 区分，⛔ 别在这里把 `null` 归一成 `''`（那会把
 *      「没排过 ⇒ 显示默认的两个标签」和「清空了 ⇒ 一个都不显示」混成一件事）。
 *      ⚠️ 脏数据（空项、前后空白）在这里就滤掉：库里可能留着已被删掉的模块名，
 *      调用方不必（也不该）各自再写一遍 `filter`。
 *
 * @param {?string} v - 库里那一列（`null` / `''` / `'teamwork,timetable'`）
 * @returns {Array.<string>} 模块名数组（可能为空）
 */
export function parseNavList(v) {
  if (typeof v !== 'string' || !v) return [];
  const names = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => LEGACY_NAV_ALIASES[n] || n);
  // ⚠️ 兼容映射会把几个老名字并成同一个 `time` ⇒ 去重（否则底栏会多出一颗重复的标签）。
  return [...new Set(names)];
}

/**
 * ⭐ 0.8.13：`users.nav_order` / `nav_tabs` 的**过渡兼容映射**。
 *
 * 说明：三块并成一个模块 `time` 之前，用户可能把「课表 / 番茄钟 / 行程」挑进过底栏 / 侧栏排序。
 *      存量那几列**一个字都不改**（改列＝写库＝碰用户数据）⇒ 在**读取时**把老名字映射到 `time`。
 *      ⚠️ 只映射**曾经有过独立入口**的三个：`timetable` / `pomodoro` / `trip`。
 *      ⚠️ 这是**过渡兼容**，下一版评估删除（那时要一并确认老库里已无残留）。
 *
 * @type {Object.<string, string>}
 */
const LEGACY_NAV_ALIASES = { timetable: 'time', pomodoro: 'time', trip: 'time' };

/**
 * 功能：按本账号的偏好，把入口项重排成**电脑端侧栏**的顺序（0.8.5）。
 *
 * 说明：⭐ 规则（「电脑端可以拖动排序（首页看板只能顶置）」）：
 *      · 首页看板 / 项目任务两颗核心入口**不在这里管**（它们由 `index.html` 静态画在 `#project-list` 顶部，
 *        本来就不参与排序）；
 *      · 本函数只重排**模块入口**：`nav_order` 里点过名的按它给的先后排在最前，
 *        没点名的（新加的模块、或用户没动过的那些）**按清单原本的顺序**接在后面。
 *      ⚠️ 存的是名字不是下标 ⇒ 删掉一个模块目录之后，剩下的顺序**不会集体前移**
 *        （那个名字匹配不上，自然被忽略）——这正是「存名字」要买的那份保险。
 *      ⚠️ 没排过（`nav_order` 是 null / 空）时**原样返回**：走清单顺序，老库升级上来零变化。
 *      ⚠️ 用 `Array.prototype.sort` 的**稳定性**：都不在 `nav_order` 里的那几项保持清单顺序，
 *        所以「排过一次」不会把没涉及的模块弄乱。
 *
 * @param {Array.<Object>} items - `moduleItems()` 的产物（已按清单 `order` 排好）
 * @param {?Object} me - 当前登录账号（读它的 `nav_order`）
 * @returns {Array.<Object>} 重排后的新数组；没排过时是原数组本身
 */
export function applyNavOrder(items, me) {
  const order = parseNavList(me && me.nav_order);
  if (!order.length) return items;
  const rank = new Map(order.map((n, i) => [n, i]));
  return items.slice().sort((a, b) => {
    const ha = rank.has(a.name);
    const hb = rank.has(b.name);
    if (ha && hb) return rank.get(a.name) - rank.get(b.name);
    if (ha) return -1;
    if (hb) return 1;
    return 0;
  });
}

/**
 * `users.nav_tabs` 的**口径版本前缀**（0.8.19 任务七新增，见 `navTabItems()` 的说明）。
 * @type {string}
 */
export const NAV_TABS_V = 'v2:';

/**
 * 功能：出厂默认那几颗**模块标签** —— 接线表里标了 `tab.def` 的，按 `tab.seq ?? order` 排。
 * @param {Array.<Object>} tabs - 带 `tab` 的入口项
 * @returns {Array.<Object>} 默认标签（有序）
 */
function defaultTabs(tabs) {
  return tabs
    .filter((it) => it.tab.def)
    .sort((a, b) => (a.tab.seq ?? a.order ?? 0) - (b.tab.seq ?? b.order ?? 0));
}

/**
 * 功能：把一份模块名单拼成**提交给服务端的数组**（前缀挂在第一项上）—— 写侧的唯一出口。
 *
 * 说明：⭐ 0.8.19 任务七：`PUT /api/auth/nav` 收的是**字符串数组**（服务端 `navList()` 自己
 *      `join(',')` 落库）⇒ 版本前缀只能挂在**第一项**上。
 *      ⚠️ 名单为空时提交 **`['v2:']`**（不是 `[]`）—— 否则服务端落成空串，而空串**不带前缀**
 *      ⇒ 读侧把它当老格式、又走回默认，表现是「底栏全清空之后又自己冒回来三颗」。
 *
 * @param {Array.<string>} names - 模块名（顺序即标签顺序）
 * @returns {Array.<string>} 提交给服务端用的数组
 */
export const navTabsWire = (names) => [
  NAV_TABS_V + String((names && names[0]) || ''),
  ...(Array.isArray(names) ? names.slice(1) : []),
];

/**
 * 功能：算出**手机端底部标签栏**上要摆哪几个模块（有序）—— 0.8.5 的新能力。
 *
 * 说明：⭐ 底栏那三颗静态的（今天 / 任务 / 设置）由 `mobile/index.html` 画好，
 *      本函数管**中间那几颗模块标签**，它们分两档：
 *      · **固定档**（`it.tab.fixed`，目前只有「协作」）—— ⭐⭐ 0.8.19 任务七残留
 *        （「协作**不能自定义**，必须显示在导航栏」）⇒ **无条件**摆上底栏、
 *        排在可选档**之前**；它不出现在「导航栏设置」那张可选清单里，也拖不动。
 *      · **可选档**（其余带 `tab` 的模块）—— 用户在「设置 → 导航栏设置」里挑，最多 `MAX_NAV_TABS` 个。
 *
 *      取值口径（0.8.19 任务七起走**版本前缀**，与原说明同一条）：
 *      · 只有**带 `v2:` 前缀**的值才被当成用户排过的（`navTabsWire()` 写进去的就是这种）；
 *      · 其它一切（`null` / `''` / 老格式的 `'teamwork,timetable'`）一律走**出厂默认**
 *        —— 老库升级上来不需要任何迁移，也就不会「升级之后底栏还是乱的」。
 *      ⚠️⛔ **刻意不写库**：铁律 18「启动与迁移绝不改写用户数据」⇒「强制重置」落成
 *      「**解释口径**换了一版」，可逆、零风险；用户下一次在导航栏设置里改动时，
 *      写回去的就是带前缀的新值（功能照旧）。
 *      ⚠️ 名字对不上的（模块被关掉 / 目录被删掉 / 存了脏名字 / 固定档已经把那个名字占了）
 *        直接跳过；超过 `MAX_NAV_TABS` 的截断（防手改接口塞进来一堆）。
 *      ⚠️ 「被 `hide_*` 关掉的模块」不在这里滤 —— 调用方拿到的 `items` 本来就带 `on`，
 *        手机上那几颗标签一直是「留着节点、只加 hidden」，保持原样最省事。
 *
 * @param {Array.<Object>} items - `moduleItems()` 的产物（已按清单 `order` 排好）
 * @param {?Object} me - 当前登录账号（读它的 `nav_tabs`）
 * @returns {Array.<Object>} 要摆到底栏的模块项（有序；**固定档永远在，所以不会是空数组**）
 */
export function navTabItems(items, me) {
  const tabs = items.filter((it) => it.tab);
  const fixed = tabs.filter((it) => it.tab.fixed);
  const pickable = tabs.filter((it) => !it.tab.fixed);
  const byName = new Map(pickable.map((it) => [it.name, it]));
  const raw = me ? me.nav_tabs : null;
  const picked =
    typeof raw === 'string' && raw.startsWith(NAV_TABS_V)
      ? parseNavList(raw.slice(NAV_TABS_V.length))
          .map((n) => byName.get(n))
          .filter(Boolean)
          .slice(0, MAX_NAV_TABS)
      : defaultTabs(pickable);
  return [...fixed, ...picked];
}
