/**
 * core/modules.js —— 模块清单 × 本端接线表 → 界面上要画的入口项（两端唯一一份）
 *
 * 功能：把服务端 `GET /api/bootstrap` 回来的 `modules`（模块清单，由 `app/modules/registry.js`
 * 扫 `app/modules/` 目录聚合而来）与**本端的接线表**合并成一组「入口项」：
 * `moduleItems(modules, uiOf, me)`；另导出 `prefsKeyOf()`，把 `module.json` 的
 * `switchField`（`hide_bookmarks`，库里的列名）转成接口键（`hideBookmarks`）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/01-架构总览.md、07-前端-电脑版与手机版.md、13-决策记录.md（决策 76）
 */
export const prefsKeyOf = (field) =>
  typeof field === 'string' && field ? field.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()) : '';

/**
 * 功能：把 `switchField` 归一成**数组**（`null` → `[]`；单数 → 一件；复数原样）。
 *
 * 说明：⭐ 与后端 `app/modules/registry.js` 的 `switchFieldsOf()` **同一口径**（两端各一份，
 *
 * @param {?string|Array.<string>} field - `module.json` 的 `switchField`
 */
export const switchFieldsOf = (field) => {
  if (field === null || field === undefined) return [];
  return Array.isArray(field) ? field.slice() : [field];
};

/**
 * 功能：把 `switchField` 里**每一个**开关列都换算成接口键（数组）。
 *
 * （⛔ 绝不一次提交两个：会把另一台设备刚改的值覆盖掉）。单开关的模块得到的是**一件**数组。
 *
 * @param {?string|Array.<string>} field - `module.json` 的 `switchField`
 */
export const prefsKeysOf = (field) => switchFieldsOf(field).map(prefsKeyOf);

/**
 * 功能：把模块清单与本端接线表合并成界面上要画的入口项。
 *
 * 说明：返回项 = 接线表那一条（`card` / `nav` / `hub` / `tab` 等本端字段）+ 清单里的客观事实
 * （`name` / `order` / `switchField`）+ 算好的开关状态（`on`）。
 * 清单为空 / 还没到手（首屏之前是 `null`）时一律返回空数组 —— 调用方画不出东西，
 */
export function moduleItems(modules, uiOf, me) {
  const out = [];
  for (const m of modules || []) {
    const ui = (uiOf && uiOf(m.name)) || null;
    if (!ui) continue;
    const field = m.switchField || null;
    const fields = switchFieldsOf(field);
    // 子开关清单是**接线表的纯数据**（`card.subs`），
    // 每条的 `field` 就是 `users` 上的列名（与 `switchField` 同一套词汇）——
    // 「哪一列 → 哪个接口键」的换算只在这个文件里做一次。
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
      /** 上一次那个字段归一成数组（`[]` = 不可关）—— 新增 */
      switchFields: fields,
      /** 提交给 `PUT /api/auth/prefs` 的键名（单开关）；不可关 / 是数组时是空串 */
      prefsKey: prefsKeyOf(field),
      /** **每一个**子开关的接口键（单开关模块是一件数组） */
      prefsKeys: fields.map(prefsKeyOf),
      /** 接线表声明的子开关行（含各自的接口键与开关状态）；没声明时是空数组 */
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
 * 自己一条功能都没有（零表零接口），它们的屏完全靠别人借位置（`bookmarks` / `vault`、
 * `ledger` / `digital`）⇒ 那些模块**全被关掉**之后，入口还在、点进去却是一块空白屏。
 * ⇒ 接线表用**顶层 `needs`** 声明「这一屏的内容来自哪几个模块」，本函数据此决定入口画不画。
 */
export function entryOn(it, items) {
  if (!it || !it.on) return false;
  const needs = it.needs;
  if (!Array.isArray(needs) || !needs.length) return true;
  return needs.some((n) => (items || []).some((x) => x && x.name === n && x.on));
}

/**
 * 手机端底部标签栏里**最多放几个「可选」模块标签**（固定那几颗之外）。
 *
 */
export const MAX_NAV_TABS = 2;

/**
 * 功能：把库里存的 `users.nav_order` / `users.nav_tabs` 解析成模块名数组（两端唯一一份）。
 *
 * 说明：⭐ 库里是**逗号分隔的串**（理由见 `schema/core.js` 的建表语句），这里统一负责解析。
 * `null` / `undefined` = **从没排过**，回空数组 —— 调用方据此走默认顺序；
 * 而**空串**（`''`）同样回空数组，但它的语义是「用户明确排成空的」——
 */
export function parseNavList(v) {
  if (typeof v !== 'string' || !v) return [];
  const names = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => LEGACY_NAV_ALIASES[n] || n);
  return [...new Set(names)];
}

/**
 * `users.nav_order` / `nav_tabs` 的**过渡兼容映射**。
 *
 */
const LEGACY_NAV_ALIASES = { timetable: 'time', pomodoro: 'time', trip: 'time' };

/**
 *
 * 说明：⭐ 规则（「电脑端可以拖动排序（首页看板只能顶置）」）：
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
 * `join(',')` 落库）⇒ 版本前缀只能挂在**第一项**上。
 * ⇒ 读侧把它当老格式、又走回默认，表现是「底栏全清空之后又自己冒回来三颗」。
 *
 */
export const navTabsWire = (names) => [
  NAV_TABS_V + String((names && names[0]) || ''),
  ...(Array.isArray(names) ? names.slice(1) : []),
];

/**
 *
 * 说明：⭐ 底栏那三颗静态的（今天 / 任务 / 设置）由 `mobile/index.html` 画好，
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
