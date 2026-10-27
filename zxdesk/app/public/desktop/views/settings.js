/**
 * desktop/views/settings.js —— 设置（0.2.1；⭐ 0.4.1 改成左右结构）
 *
 * 功能：电脑版「设置」页的全部渲染与交互 ——
 *      `openSettings()` / `renderSettings()` 画出设置页：**左边一列菜单、右边一块内容**，
 *      一次只画当前那一栏（`state.setPane`）；分栏清单在 `PANES`，内容在 `paneHtml()` 里分派；
 *      `selectPane()` 切换分栏（切到「数据来源」时按需拉一次管理员数据）；
 *      ⭐ 0.5.0 起「模块功能」栏的开关**由清单生成**：`toggleModule()` 一个函数管全部模块
 *      （提交走 `applyPref()`，五项显示开关仍是每账号各管各的偏好）；
 *      `exportBackup()` / `importBackup()` 是**个人数据**的导出与导入（导入可选合并或替换）；
 *      `exportOrgBackup()` / `restoreOrgBackup()` 是**整体备份**的导出与恢复（仅管理员，危险操作）；
 *      ⭐ 0.8.1 起 `migrateLedger()` / `doMigrate()` 是**记账数据迁移**（`POST /api/migrate-ledger`，
 *      仅管理员、危险操作，手打「迁移」二字才放行）。
 *
 * 为什么要有这一页（指令）：侧栏底部原本并排着「导出备份 / 账号 / 成员」三个按钮，
 * 它们**都不是主功能**，却和「课表 / 刷新」挤在同一条最显眼的位置；而且「成员」只对管理员出现，
 * 让那条按钮排的宽度还会随身份变化。现在这一排只剩「课表 / 刷新 / 设置」，
 * 设置里的各项各自归位 —— 加新设置项也不必再动侧栏。
 *
 * ⭐ **0.4.1 为什么改成左右结构**（指令：「设置界面分为左右结构」＋
 *    「在功能菜单中，应该对各个模块功能做具体介绍和开关」）：设置项已从 3 项长到 11 行，
 *    纵向堆叠一屏铺不下 —— 想找「导入我的数据」得先滚过五个开关。而纵向堆叠的容量是**有限**的
 *    （区块数与区块内行数同时增长），唯一解法是把「同一时刻只需要看一块」的内容收进分栏。
 *    分栏清单：**数据来源 / 模块功能 / 账号设置 / 备份与恢复 / 整体备份（仅管理员）**；
 *    判据是「这件事是干什么的」—— ⚠️ 个人备份与整体备份**刻意分成两栏**（一个只碰自己、一个动整库，
 *    并排时太容易点错，而点错的代价是全库被替换）。完整论证见 `docs/公共/开发方案/08`。
 *
 * ⭐ **模块功能介绍卡**（本次的核心）：每块写清「它是做什么的」，开关就在同一块里。
 *    ⚠️ 开关走的仍是 `PUT /api/auth/prefs` 的**单一键**，模块卡只是**排版**。
 *    ⭐ **0.5.0 起「有哪几个模块」不再写在这个文件里**：介绍卡按
 *      「服务端 `GET /api/bootstrap` 的 `modules` 清单 × 本端接线表 `desktop/modules.js`」生成
 *      （见 `modulesPaneHtml()`）—— 删掉 `app/modules/<模块>/` 那个目录，这一栏就少一块卡。
 *
 * ⭐ **「数据来源」把「数据位置」从成员管理搬了过来**：那一面板与成员列表本无关系，
 *    只是当年「管理员专属信息」都堆在成员页；现在它就是「我的数据存在哪」这一问的答案。
 *    ⚠️ 浏览器**打不开** NAS 上的文件夹，所以这里能做的仍然只是「把路径摆清楚 + 一键复制」。
 *
 * ⭐ **0.4.1（第四轮）的文案返工**（指令，逐条对着截图改）：
 *    ① 这一栏改叫「**数据来源**」（原「数据源」），并**去掉标题旁那句「这里只是看看，没有能改的东西」**
 *      与底部整段「复制路径后…」—— 只读这件事由「没有按钮可点」自己说明，不需要两段话解释；
 *    ② 三行字段改名换词：「删除时自动清理」→「**自动清理**」、「升级前的自动备份」→「**升级自动备份**」、
 *      读写方式的取值从口语化的「正常（一边读一边写，互不等）」改成「**正常（读写并行，互不阻塞）**」；
 *    ③ 模块介绍卡固定两段：**功能行**（`desc`，写它能做什么）+ **数据行**（五个模块逐字相同，
 *      只写一份在 `moduleCardHtml()` 里）；真正的**安全提醒**（主密码忘了打不开 / 聊天内容在 NAS 上能看到原文）
 *      另占一行 `tip` —— ⚠️ 课表与收藏夹**没有**这一行（它们没有安全提醒要写），所以 `tip` 允许是空串。
 *      卡片只讲「这个功能是什么、别人看不到你的东西」；⚠️ **「关掉会怎样」卡片不写、界面别处也不写**
 *      （见 ④）—— 别再加一个字段把它塞回来。
 *    ⚠️ ②③ 两端**必须逐字一致**：改文案时 `desktop/modules.js` 的 `MODULES_UI`
 *      与 `mobile/modules.js` 的 `MODULES_UI` 要一起改，`ttt/test/module-ui.test.js` 会逐字比对。
 *    ④ ⭐ **开关点了就生效：不弹确认框，也不弹轻提示**（「为什么还是有弹窗和提示语」）——
 *      每个开关一律直连 `applyPref()`，卡片里那行「已开启 / 已关闭」就是唯一反馈。
 *      ⚠️ 这条把前两轮的东西整套撤掉了：常驻的说明行 → 点下去弹的确认框 → 连确认框和「已关掉 X」的
 *      轻提示都不留。**「关闭不会删除数据：…」这句话随之从界面上消失**（在两个候选中明确选了
 *      「弹窗和提示语都去掉」，并知道那句话会没有）—— 关掉本来就没有任何删除动作。
 *      ⚠️ 危险操作不受影响：恢复整体备份 / 删成员仍然照旧弹框、照旧一左一右两颗按钮（`confirmAction()`）。
 *
 * ⭐ **「账号设置」就地显示**（0.4.0 及更早是独立的 `#account-view` + 「返回设置」按钮）：
 *    左右结构下「点左侧菜单却整页跳走」是自相矛盾的。账号资料由 `account.js` 的 `accountPaneHtml()`
 *    给出一段 HTML，改用户名 / 改密码 / 退出登录的弹窗与请求函数**原样复用**。
 *
 * ⭐ **「成员管理」0.4.1（第二轮）起也独立成一栏，紧跟在「账号设置」后面**（指令）：
 *    它原来是「账号设置」栏里一行「›」入口，点了会**整页跳到** `#admin-view` ——
 *    与上一条自相矛盾（别的栏都是就地换屏，只有它跳走），而且跳走之后左菜单还停在高亮「账号设置」。
 *    现在它就是一栏：右栏里直接是成员列表、自主注册开关与「添加成员」；
 *    ⚠️ 内容是 `views/admin.js` 画的（成员管理只有一个家），本文件只提供容器 `#admin-body`
 *    与 `adminPaneInto()` 这一次「按需取数 + 重画」的编排；`#admin-view` / `VIEW_NODES.admin` 已整段撤掉。
 *    ⚠️ 手机版**早已是**「账号设置」块后面紧跟「成员管理」块，所以这一条只动电脑版。
 *
 * ⭐ **页面上不摆任何提示**（指令）：每一行的说明只留一句**副标题**（`<small>`）——
 *    常驻的提示段落占着版面却没人读。⚠️ 0.4.1 第四轮起，模块开关连「点下去那一刻」的确认框也不弹了
 *    （见上面 ④），所以**页面本身上**除了行内 `small` 与页头「设置」旁那一行版本状态，没有任何 `.set-note` ——
 *    残留的那些 `.set-note` 全在弹窗的 HTML 里（个人导入 / 整体恢复那两处，它们才是真会动数据的操作）。
 *
 * ⚠️ 两端（电脑版 / 手机版）各自实现自己的设置页，共用的是**同一套 REST 契约**
 *    （`PUT /api/auth/prefs`、`GET /api/admin/storage`、`GET /api/export`、`POST /api/import`、
 *    `GET /api/backup`、`POST /api/restore`）。⚠️ **手机版 0.4.1 一行未改**：手机屏宽放不下左右两栏，
 *    它维持 0.3.3 起的可折叠分组。
 *
 * ⭐ **0.8.1：记账数据迁移的入口挂在这一栏**（而不是新开一栏）—— 两条理由：
 *    ① 它和「恢复整体备份」是**同一类**操作（都动整库级别的文件、都不可逆、都要手打两个字确认），
 *       并排放在同一栏里，用户认的就是那一栏的「⚠️ 危险操作都在这儿」；
 *       ⚠️ 而且左菜单的分栏清单被 `ttt/test/settings-ui.test.js` **逐项钉住**（六个、顺序固定）——
 *       为一个入口改左菜单，等于把那条护栏连同的顺序一起改掉，不值当。
 *    ② 迁移**只跟这一个功能有关**（1 期记账数据换库），它不是「备份」也不是「恢复」，
 *       所以它是一行**独立**的按钮，⛔ 不并进上面两颗，也不自己另开一套确认框。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.1
 * 相关：docs/公共/架构文档/03-数据安全.md、07-前端-电脑版与手机版.md、docs/公共/开发方案/08-设置页交互改版.md
 */

import { api, BASE } from '../../core/api.js';
import { isBackupZip, orgCounts, readZipManifest } from '../../core/backup.js';
import { $, copyText, esc, formatBytes } from '../../core/dom.js';
import { moduleItems } from '../../core/modules.js';
// ⭐ 0.8.51：切栏（三级）那一枚淡入 —— 判据只住 `core/transition.js`。
import { swapIn } from '../../core/transition.js';
// ⭐ 0.6.0：设置页是「模块贡献分栏」的宿主—— 模块想在这里要一栏配置页，
//    在本端接线表条目上声明 `settingsPane`（纯数据）+ `slots: ['settings-pane']`，
//    内容由 `core/slots.js` 动态挂载；本文件不 import 任何具体模块的片段。
import { mountModuleSlot, openModuleSettings, slotPaneDefs } from '../../core/slots.js';
import { uiOf } from '../modules.js';
import { applyPrefsVisibility, renderSidebar, showView } from '../shell.js';
import { state } from '../state.js';
import { closeModal, openModal, setModalSave, toast } from '../ui.js';
import { accountPaneHtml, doLogout, openPasswordModal, openUsernameModal } from './account.js';
import { loadAdmin, renderAdmin } from './admin.js';

/**
 * 功能：切到「设置」视图并渲染内容 —— 先把侧栏的高亮清掉（设置不是任何项目卡片），再显示容器。
 * @returns {void}
 */
export function openSettings() {
  state.view = 'settings';
  renderSidebar();
  showView('settings');
  renderSettings();
}

/**
 * 功能：分栏清单 —— ⭐ **左菜单就是按这个数组的顺序画的**，加一栏 = 这里加一条 + `paneHtml()` 加一个分支。
 *
 * 说明：⭐⭐ 0.8.30（「全局设置改造」）：左菜单从「按功能分栏」改成
 *      **「前面四栏是应用级的、后面每一栏就是一个模块」** ——
 *      ① 原来的「模块功能」那一栏**整块撤掉**，各模块的开关**下放到它自己那一栏**里
 *         （开关就长在接线表的 `card` 上，`moduleCardHtml()` 一个字没改，只是换成按组取）；
 *      ② 原来散着的「成员管理 / 整体备份 / 日志」并成**一项**「管理员设置」，
 *         「快捷键」并进「账号设置」，「数据来源」改名「版本数据」；
 *      ③ 模块贡献的那些设置分栏（日历视图 / 生活记账 / 密码库 / AI 设置）**不再各占一栏**，
 *         而是并进它所属模块那一栏里（见每条的 `mods`）。
 *      ⚠️ `mods` 是**这一端的界面配置**（这一栏要装哪些模块的开关与设置分栏），
 *      ⛔ 不是判据 —— 卡本身仍然由 `moduleItems()` 从服务端清单算出来（`moduleCards()`）。
 *      ⚠️ `navId` 是侧栏那颗入口按钮的 id：「进入模块」**直接点它**（⛔ 不新造第二条切屏通路）。
 *      留空 = 这个模块没有自己的屏（AI 就是），那一栏也就不画「进入」那颗键。
 * @type {Array.<{id: string, label: string, adminOnly?: boolean, desc?: string, mods?: Array.<string>, navId?: string}>}>}
 */
const PANES = [
  // ⭐ 设置页质检：前四栏也补上 `desc` —— 右栏统一是「标题 ＋ 一句话 ＋ 内容」，
  //    否则只有模块栏有那句说明，应用级四栏一进去就是一张裸卡片，节奏对不上。
  // ⭐⭐ 第四轮（「提示语是面向用户的，只简单介绍这个设置是干啥的即可
  //    （一句话介绍），不是讲解这个功能」）：
  //    ① `desc` **一律压成一句话**，只说「这一栏管什么」，⛔ 不再写「只有管理员看得到」
  //      「只碰这个账号、不影响别人」这类**解释**（那是讲解，不是介绍）；
  //    ② `ico` 全部删掉 —— 另一条要求是「移除除了设置的齿轮图标外的所有图标」。
  //      ⚠️ `ico` 曾经同时喂给左菜单 `.sni-ico` 与栏头 `.sph-ico`，删掉它两处一起消失；
  //      ⛔ 别只删一处（那会留下一个空 span 占着 20px 的位）。
  {
    id: 'version',
    label: '版本数据',
    adminOnly: false,
    desc: '应用版本、数据存放在哪。',
  },
  {
    id: 'admin',
    label: '管理员设置',
    adminOnly: true,
    desc: '成员、整体备份与日志。',
  },
  {
    id: 'account',
    label: '账号设置',
    adminOnly: false,
    desc: '你的资料、密码与快捷键。',
  },
  {
    id: 'backup',
    label: '备份与恢复',
    adminOnly: false,
    // ⭐ 第四轮（「像【只管你自己】这个就不对，应该是【**我的数据**】」）：
    //    就写这四个字 —— 它是**用户视角**的定位（这一栏管的是谁的数据），
    //    ⛔ 不是「只碰这个账号、不影响别人」那种口径解释。
    desc: '我的数据',
  },
  // ---- 以下每一栏 = 一个模块：介绍 ＋ 它的开关 ＋ 它的设置分栏 ＋ 进入它 ----
  {
    id: 'ai',
    label: 'AI 设置',
    desc: '模型服务地址与密钥。',
    mods: ['ai'],
    navId: '',
  },
  {
    id: 'home',
    label: '首页看板',
    desc: '「今天」那一屏的默认视图。',
    mods: ['calendar'],
    navId: 'nav-home',
  },
  {
    id: 'tasks',
    label: '任务与随手记',
    desc: '任务板与随手记的开关。',
    mods: ['tasks', 'idea'],
    navId: 'nav-projects',
  },
  {
    id: 'teamwork',
    label: '团队协作',
    desc: '好友、私聊与实时推送。',
    mods: ['teamwork'],
    navId: 'nav-teamwork',
  },
  {
    id: 'webpass',
    label: '网址/密码夹',
    desc: '网址收藏与密码库的开关。',
    mods: ['bookmarks', 'vault', 'webpass'],
    navId: 'nav-webpass',
  },
  {
    id: 'assets',
    label: '个人资产管理',
    desc: '生活记账与我的设备的开关。',
    mods: ['assets', 'digital', 'ledger'],
    navId: 'nav-assets',
  },
  {
    id: 'time',
    label: '番茄钟与日程表',
    desc: '日程表、番茄钟与行程的开关。',
    mods: ['time'],
    navId: 'nav-time',
  },
];

/**
 * 功能：设置页打开时默认落在哪一栏。
 *
 * 说明：⚠️ 0.8.30 从 `'modules'` 改成 `'version'` —— 原来那条「模块功能」已经拆掉了，
 *      而「版本数据」是新的第一栏（也只读信息，拿它当落地页不误导）。
 *      ⚠️ 要换默认栏，改这一行就够了（分栏清单与默认值分开，是为了让顺序与默认值各自独立）。
 * @type {string}
 */
const DEFAULT_PANE = 'version';

/**
 * 功能：本端要画的模块介绍卡 —— 「服务端清单 × 本端接线表（`desktop/modules.js`）」的交集里、
 *      带 `card` 的那些（`moduleItems()` 已经按清单顺序排好）。
 *
 * 说明：⭐ 0.5.0 模块化重构：这个数组以前是**手写死的五条**（`const MODULES = [...]`），
 *      所以删掉一个模块目录，卡片照样在（点了开关会 400）。现在**一张卡都不在这里登记**——
 *      `module.json` 说「有哪些模块、什么顺序」，`desktop/modules.js` 说「长什么样」。
 *      ⚠️ 文案里的字是**给用户看的，不是给开发者看的**（要求）：
 *      写「这个功能能帮你做什么」，不写它怎么实现。禁用词（会让人看不懂或像内部说明）：
 *      `入口`、`偏好`、`字段`、`隐藏`、`渲染`、`接口`、`数据保留`、`账号级隔离`……
 *      ⚠️ 每条 `desc` 都**一句话说完**，不堆功能点 —— 想了解全部细节的人会去点开用。
 *
 * @returns {Array.<Object>} `moduleItems()` 的条目（含 `card` / `prefsKey` / `on`）
 */
const moduleCards = () => moduleItems(state.modules, uiOf, state.me || {}).filter((it) => it.card);

/**
 * 功能：模块贡献的**分栏清单**（0.6.0）—— 声明了 `settingsPane` 且当前开着的模块。
 *
 * 说明：⭐ 追加在固定 `PANES` 之后（固定栏在前、模块贡献的在后）：左菜单多出一颗、
 *      `paneHtml()` 对它们的 id 走插槽挂载。**本文件不认识任何具体模块** ——
 *      删掉那个模块目录，清单里少一条，这一栏自动消失。
 *
 * @returns {Array.<{name: string, title: string, icon: string, settingsPane: Object}>} 贡献清单
 */
const slotPanes = () => slotPaneDefs(state.modules, uiOf, state.me || {});

/**
 * 功能：渲染设置页 —— ⭐ 0.4.1 起是**左右结构**：左边一列菜单、右边一块内容。
 *
 * 说明：① 左菜单按 `PANES` 画，`adminOnly` 的那一栏只对管理员出现 ——
 *      这只是**界面显隐**，权限在服务端（非管理员打 `/api/admin/*` 与 `/api/backup` 一律 403）；
 *      ② **只画当前那一栏**（不是六块都画好再藏五块）：设置页重画很频繁（翻开关、管理员数据到达都会重画），
 *      只画一块最省事，也不会在隐藏节点上留下陈旧状态；
 *      ③ ⚠️ **重画必须保持当前分栏** —— 翻开关后走 `applyPref()` → `renderSettings()`，
 *      若把分栏重置回第一栏，用户每关一个功能就被弹到别的屏去；
 *      ④ 当前分栏不在可见清单里时（例如管理员权限刚变化）落回 `DEFAULT_PANE`。
 *
 * @returns {void}
 */
export function renderSettings() {
  const me = state.me;
  const isAdmin = !!(me && me.is_admin);
  // ⭐⭐ 设置页质检：**重画前记住焦点** —— 翻一个开关就会整块重画 `#settings-body`，
  //    焦点随之掉到 `document.body`（键盘用户按完空格就「不知道自己在哪」了）。
  //    ⚠️ 只在焦点原本就在设置页里时才还原：别的屏的焦点不该被这一句抢走。
  const body = $('#settings-body');
  const keepFocus =
    body && document.activeElement && body.contains(document.activeElement)
      ? document.activeElement.id ||
        (document.activeElement.classList.contains('set-nav-item') ? `pane:${document.activeElement.dataset.pane}` : '')
      : '';
  // ⭐⭐ 0.8.30：左菜单**就是 `PANES` 那一份** —— 模块贡献的设置分栏已经并进各自模块那一栏，
  //    ⛔ 不再往左菜单后面追加（不然同一个设置会在两处各出现一次）。
  const panes = PANES.filter((p) => !p.adminOnly || isAdmin);
  if (!panes.some((p) => p.id === state.setPane)) state.setPane = DEFAULT_PANE;

  body.innerHTML = `
    <nav class="set-nav" aria-label="设置分栏">
      ${panes.map((p) => navItemHtml(p)).join('')}
    </nav>
    <div class="set-pane">
      ${paneHeadHtml(state.setPane)}
      ${paneHtml(state.setPane, isAdmin)}
    </div>`;
  // ⭐ 版本 / 数据状态写在**页头**（「设置」标题旁边），不写在左菜单底部
  //    （「移动到设置旁边显示」）—— 它贴在菜单最底下时要扫到底才看见。
  const note = $('#set-head-note');
  if (note) {
    note.textContent = `ZXDesk工作台 · v${(state.health && state.health.version) || '—'} · ${
      state.health && state.health.backend === 'sqlite' ? '数据正常' : '备用存储'
    }`;
  }

  for (const btn of document.querySelectorAll('#settings-body .set-nav-item')) {
    btn.addEventListener('click', () => selectPane(btn.dataset.pane));
  }
  bindPane(state.setPane);
  mountContributedPane(state.setPane);
  // ⭐⭐ 第二轮：页头吸顶之后，左菜单的 `top` 要让开它（`--set-head-h`），
  //    并在滚起来的时候给页头补一条发丝线（滚到顶时不要那条线）。
  //    ⚠️ 量高度必须在**画完之后**同步量（`getBoundingClientRect` 会强制重排，这里每次重画只量一次）。
  syncStickyHead();
  // ⭐⭐ 设置页质检：把重画弄丢的焦点还回去（见函数开头 `keepFocus`）。
  //    ⚠️ 用 `preventScroll`：还原焦点不该把刚回到栏首的滚动位置又拽回原处。
  if (keepFocus) {
    const again = keepFocus.startsWith('pane:')
      ? document.querySelector(`#settings-body .set-nav-item[data-pane="${keepFocus.slice(5)}"]`)
      : document.getElementById(keepFocus);
    if (again && typeof again.focus === 'function') again.focus({ preventScroll: true });
  }
  // ⭐⭐ 设置页质检：默认栏就是「版本数据」，从前只在 `selectPane('version')` 里补拉 ——
  //    于是「打开设置 → 停在版本数据」这条最常见的路径**永远不会**去拉数据目录，
  //    右栏一直停在「正在读取…」（真浏览器实测复现）。⇒ 改由渲染本身按需补拉：
  //    `ensureStorage()` 自带「已读过 / 读失败过就不再打」的闸门，重复调用是空操作。
  if (state.setPane === 'version') ensureStorage();
}

/**
 * 功能：把设置页那条**吸顶页头**的高度写进 `#settings-body`（`--set-head-h`），
 *      并在页面滚动时给它贴 / 摘 `.is-stuck`（只影响那条发丝线）。
 *
 * 说明：⭐⭐ 第二轮（「这个顶部应该固定」）——页头改成 `position: sticky` 之后，
 *      左菜单也是 sticky 的，两者会叠在一起；左菜单的 `top` 必须等于「页头高度」，否则吸上去会被压住一截。
 *      ⚠️ 高度**只能现量**：页头里有版本状态那一行，字号 / 换行随窗口宽度变（窄屏会折成两行）。
 *      ⚠️ 滚动监听**只挂一次**（`#settings-view` 是静态节点，`renderSettings()` 会被反复调用）——
 *      每次重画都挂一条，几十次之后滚动一下要跑几十个回调。
 *      ⚠️ 监听挂在**滚动容器 `.main`** 上：真正在滚的是它，不是 `#settings-view`。
 *
 * @returns {void}
 */
function syncStickyHead() {
  const view = document.getElementById('settings-view');
  const head = view ? view.querySelector(':scope > .home-head') : null;
  const body = $('#settings-body');
  if (head && body) {
    // ⚠️ 按「没贴住时」的高度量：贴住之后 top 是负的，直接量会算进那一段。
    const h = Math.round(head.getBoundingClientRect().height);
    body.style.setProperty('--set-head-h', `${h}px`);
  }
  const main = document.querySelector('.main');
  if (!main || !head) return;
  /** 功能：按当前滚动位置贴 / 摘 `.is-stuck`。 @returns {void} */
  const paint = () => head.classList.toggle('is-stuck', main.scrollTop > 4);
  paint();
  // ⚠️ 幂等：`#settings-view` 是静态节点、`renderSettings()` 会反复跑 ⇒ 用 dataset 记住挂过没有
  if (main.dataset.setHeadScroll !== '1') {
    main.dataset.setHeadScroll = '1';
    main.addEventListener('scroll', () => {
      const v = document.getElementById('settings-view');
      const h = v ? v.querySelector(':scope > .home-head') : null;
      if (h) h.classList.toggle('is-stuck', main.scrollTop > 4);
    });
  }
}

/**
 * 功能：左菜单的**一颗** —— 图标 ＋ 栏名 ＋（仅管理员时）右侧小标签。
 *
 * 说明：⭐⭐ 设置页质检：11 项平铺时读不出结构 ⇒ 在**应用级四栏**与**模块栏**之间加一条分隔线
 *      与一个「模块」组标题（第一条带 `mods` 的那一栏就是分界点）。「仅管理员」从前是名字下面
 *      第二行，会把那一行撑成 58px、与其余十行参差；现在收成右侧一颗小标签。
 *      ⚠️ 分隔与组标题是**画在 `#settings-body` 里的 DOM**（不是样式），
 *      所以 `.set-nav-item` 仍按 `PANES` 逐个绑事件（那两个节点不是按钮，绑不上也不该绑）。
 *
 * @param {Object} p - `PANES` 里的一条
 * @returns {string} 该项的 HTML（第一项是模块栏时，前面多出来分隔线与组标题）
 */
function navItemHtml(p) {
  const first = PANES.find((x) => x.mods);
  const isFirstModule = !!(first && p.id === first.id);
  const sep = isFirstModule
    ? '<div class="set-nav-sep" aria-hidden="true"></div><div class="set-nav-group">模块</div>'
    : '';
  const tag = p.adminOnly ? '<span class="sni-tag">仅管理员</span>' : '';
  const on = p.id === state.setPane;
  return `${sep}
        <button class="set-nav-item${on ? ' on' : ''}" type="button" data-pane="${p.id}"
                ${on ? 'aria-current="page"' : ''}>
          <span class="sni-label">${p.label}</span>${tag}
        </button>`;
}

/**
 * 功能：右栏顶部的**栏头** —— 栏名 ＋ 一句话。
 *
 * 说明：⭐⭐ 设置页质检：从前只有模块栏有那句说明（`modulePaneHtml()` 里的 `.set-sec-desc`），
 *      应用级四栏一进去就是一张裸卡片，右栏顶部没有「我在哪一栏」的锚点；而模块栏的说明
 *      又写在**栏内第一个 `.set-sec-head`** 里，与栏名重复一遍。
 *      ⇒ 统一收到这里一份：**栏名与说明都由栏头出**，栏内不再重复标题。
 *      ⚠️ 说明文案住 `PANES` 的 `desc`（本端界面配置），⛔ 不再散在各 `*PaneHtml()` 里。
 *      ⭐⭐ 第四轮（「只简单介绍这个设置是干啥的即可（一句话介绍）」）：
 *      栏头**不再有图标**（除了屏头那颗齿轮，全局设置里一个图标都不留），
 *      那句说明也压成一句 —— 只回答「这一栏管什么」。
 *
 * @param {string} id - 当前分栏标识
 * @returns {string} 栏头 HTML（未知标识回空串）
 */
function paneHeadHtml(id) {
  const p = PANES.find((x) => x.id === id);
  if (!p) return '';
  const desc = p.desc ? `<p class="set-pane-desc">${esc(p.desc)}</p>` : '';
  return `
    <div class="set-pane-head">
      <h3>${esc(p.label)}</h3>
      ${desc}
    </div>`;
}

/**
 * 功能：当前分栏若是**模块贡献的**，把那个模块的 `settings-pane` 插槽片段挂进去。
 *
 * 说明：⭐ 分栏内容是异步挂的（动态 import）：先画出「正在读取…」骨架，片段到了就地替换 ——
 *      与「数据来源」栏的按需拉数同一手法。固定分栏（`PANES` 里的 id）在这里直接短路。
 *      ⚠️ 片段文件的约定路径与失败处理都在 `core/slots.js`，本文件不认识任何具体模块。
 *
 * @param {string} id - 当前分栏标识
 * @returns {void}
 */
function mountContributedPane(id) {
  // ⭐⭐ 0.8.30：一栏里可能有**好几个**模块的设置分栏（如「个人资产管理」栏里同时有生活记账）——
  //    逐个挂，⛔ 不是从前那种「一个 id 对一个片段」。
  const p = PANES.find((x) => x.id === id);
  if (!p || !p.mods) return;
  for (const def of groupPanes(p)) {
    const box = document.querySelector(`#settings-body [data-slot-pane="${def.settingsPane.id}"]`);
    if (!box) continue;
    mountModuleSlot(box, 'desktop', def.name, 'settings-pane', {
      end: 'desktop',
      modules: state.modules,
      uiOf,
      me: state.me,
    });
  }
}

/**
 * 功能：切换左侧分栏 —— 落 `state.setPane`、重画，并在切到「数据来源」时按需补拉一次管理员数据。
 * @param {string} id - 分栏标识（见 `PANES`）
 * @returns {void}
 */
export function selectPane(id) {
  if (!id || id === state.setPane) return;
  state.setPane = id;
  // ⭐⭐ 设置页质检：切栏后**回到栏首** —— 从一个长栏（AI 设置三千多像素）滚到一半再切到另一栏时，
  //    右栏会停在同一个滚动偏移上（内容已经换了，位置毫无意义）。⛔ 别只重置右栏节点：
  //    真正在滚的是 `.main`（所有屏共用那一个滚动容器）。
  const main = document.querySelector('.main');
  renderSettings();
  if (main) main.scrollTop = 0;
  // ⭐ 0.8.51：切栏是**三级**（子模块内部）—— 右栏内容整块换掉，给它播一次淡入。
  //    ⚠️ 播在 `.set-pane` 上（不是 `#settings-body`）：后者连左菜单一起装，淡它会连菜单一起闪。
  const pane = document.querySelector('#settings-body .set-pane');
  if (pane) swapIn(pane, 3);
}

/**
 * 功能：按分栏标识取右侧内容的 HTML。
 * @param {string} id - 分栏标识
 * @param {boolean} isAdmin - 当前账号是不是管理员
 * @returns {string} 该栏的 HTML（未知标识落回「模块功能」）
 */
function paneHtml(id, isAdmin) {
  // ⭐⭐ 0.8.30：**一个模块一栏** —— 介绍 ＋ 它的开关卡 ＋ 它贡献的设置分栏 ＋ 进入它
  const p = PANES.find((x) => x.id === id);
  if (p && p.mods) return modulePaneHtml(p);
  // ⭐⭐ 设置页质检：管理员身份没就绪时，「管理员设置」栏只画一句空态，⛔ 不画成空白页。
  if (id === 'admin' && !isAdmin) {
    return '<div class="set-sec"><div class="es-text">这一栏只对管理员开放。</div></div>';
  }
  if (id === 'version') return dataPaneHtml(isAdmin);
  // ⭐ 0.8.30：「快捷键」并进「账号设置」（两者都是「我这个人在这台机器上怎么用」）
  if (id === 'account') return accountPaneHtmlWrap() + keysPaneHtml();
  // ⭐ 0.8.30：「成员管理 / 整体备份 / 日志」并成一项「管理员设置」—— 三段小节依次排下来
  if (id === 'admin') return membersPaneHtml() + orgPaneHtml() + logsPaneHtml();
  if (id === 'backup') return backupPaneHtml();
  return dataPaneHtml(isAdmin);
}

/**
 * 功能：取某一栏该显示的**模块介绍卡**（含开关与「设置」键）—— 该栏 `mods` 里那几个模块的。
 * @param {Object} p - `PANES` 里的一条（带 `mods`）
 * @returns {Array.<Object>} `moduleItems()` 的条目
 */
const groupCards = (p) => moduleCards().filter((it) => (p.mods || []).includes(it.name));

/**
 * 功能：取某一栏该显示的**模块设置分栏**（`settings-pane` 插槽的贡献者）。
 * @param {Object} p - `PANES` 里的一条（带 `mods`）
 * @returns {Array.<Object>} `slotPanes()` 的条目
 */
const groupPanes = (p) => slotPanes().filter((d) => (p.mods || []).includes(d.name));

/**
 * 功能：渲染**一个模块那一栏** —— 「进入」＋ 它的开关卡 ＋ 它的设置分栏。
 *
 * 说明：⭐⭐ 0.8.30（「全局设置改造」）—— 从前这套东西**散在三处**：开关在
 *      「模块功能」那一栏、设置分栏各占一栏、模块本体在侧栏，想用一个功能要跨三处跳。
 *      现在**同一个模块的东西都在同一栏里**：看它是什么 → 开 / 关 → 改它的设置 → 进去用。
 *      ⚠️ 开关卡仍然走 `moduleCardHtml()`：它画「名称 ＋ 一句话 ＋ 开关」，只是从前把**全部**
 *      带卡的模块堆进一栏，现在按组取。
 *      ⚠️⭐ 「进入」那颗键**点的是侧栏那颗入口按钮**（`PANES` 的 `navId`）—— ⛔ 不新造第二条
 *      切屏通路：侧栏那一下本来就要走「取数 ＋ 切屏 ＋ 记住从哪来」一整套，自己再写一遍必然漂移。
 *      没写 `navId` 的（AI 没有自己的屏）⇒ 这一栏不画那颗键。
 *
 * @param {Object} p - `PANES` 里带 `mods` 的那一条
 * @returns {string} 该栏的 HTML
 */
function modulePaneHtml(p) {
  const cards = groupCards(p);
  const panes = groupPanes(p);
  // ⭐⭐ 设置页质检：栏名与那句介绍**由栏头统一出**（`paneHeadHtml()`）—— 从前这里又画一遍，
  //    于是右栏顶部「模块名 ＋ 一句介绍」出现两次，中间还夹着「前往」那颗行。
  //    ⚠️ 卡片（开关）与模块设置分栏各占一个 `.set-sec`，**分节标题只在真有第二块时才写**
  //    （一栏里只有一张卡时，那个空标题只占一行、不说明任何事）。
  const goto = p.navId
    ? `
    <button id="set-goto-${esc(p.id)}" class="set-row set-row-go" type="button">
      <span class="set-main"><b>进入「${esc(p.label)}」</b></span>
      <span class="set-val">前往 ›</span>
    </button>`
    : '';
  const cardsHtml = cards.length
    ? `<div class="set-sec">${panes.length ? '<div class="set-sec-head">功能开关</div>' : ''}${cards
        .map((it) => moduleCardHtml(it))
        .join('')}</div>`
    : '';
  const panesHtml = panes
    .map((d) => {
      // ⚠️ 分节标题 = 那一栏的名字；**名字里已经带「设置」的（「AI 设置」）不再重复一次**
      //    （从前的 `${label}设置` 会画出「AI 设置设置」）。
      //    ⚠️⭐ 2026-10-19：**小标题与这一栏同名时整个不画**（「团队协作」那一栏里再冒出一行
      //    「团队协作设置」只是把栏名又念了一遍 —— 栏头就在它上面）。
      //    ⚠️ 比较的是**原始 label**，⛔ 不是拼好「设置」之后那个（拼完永远不相等，等于没生效）。
      const label = /设置$/.test(d.settingsPane.label) ? d.settingsPane.label : `${d.settingsPane.label}设置`;
      const head = d.settingsPane.label === p.label ? '' : `<div class="set-sec-head">${esc(label)}</div>`;
      return `
    <div class="set-sec">
      ${head}
      <div class="panel-card" data-slot-pane="${esc(d.settingsPane.id)}">
        <div class="es-text">正在读取…</div>
      </div>
    </div>`;
    })
    .join('');
  return `${goto}${cardsHtml}${panesHtml}`;
}

/**
 * 功能：渲染「日志」栏（⭐ 管理员专属）—— 日志文件夹 + 复制路径 + 文件清单 + 正文。
 *
 * 说明：⭐ 0.8.5（「建立日志系统，可以在全局设置中可以查看日志和
 *      复制日志文件夹路径」）。日志**就住在数据目录里**（`cmd/main` 把进程 stdout 重定向成
 *      `${TRIM_PKGVAR}/app.log`，而那就是数据目录）⇒ 这儿的「日志文件夹」与「数据来源」栏
 *      那个数据目录是同一个；这里再给一次，是因为管理员排查时的动线是「打开日志 → 直接去
 *      文件管理器找它」，而不是「先想起来数据目录在哪」。
 *      ⚠️ 内容**异步填**（`loadLogsPane()`）：画骨架时还没有数据，同步等会把设置页卡住。
 *      ⚠️ 只给管理员（`paneHtml` 已经判过 isAdmin）：`app.log` 里有别账号的痕迹。
 *
 * @returns {string} 该栏的 HTML 骨架
 */
function logsPaneHtml() {
  return `
    <div class="set-sec">
      <div class="set-sec-head">日志</div>
      <div class="panel-card">
        <div class="log-row">
          <span class="log-row-tag">日志文件夹</span>
          <code class="log-path" id="log-dir-path">正在读取…</code>
          <button class="btn btn-line btn-sm" type="button" id="log-copy-dir">复制路径</button>
        </div>
        <div class="log-files" id="log-files"></div>
      </div>
      <div class="panel-card" style="margin-top: 12px">
        <div class="log-row">
          <span class="log-row-tag" id="log-now">正在读取…</span>
          <button class="btn btn-line btn-sm" type="button" id="log-refresh">刷新</button>
        </div>
        <pre class="log-view" id="log-view"></pre>
      </div>
    </div>`;
}

/**
 * 功能：把「日志」栏的数据填上（目录 / 文件清单 / 当前那个文件的正文）。
 *
 * 说明：⚠️ 当前在看哪个文件住 `state.logFile`（默认 `app.log`）—— 切走再回来还停在那儿。
 *      文件不存在（那个账号还没用过 AI）**不是错误**：界面上说清楚就行。
 * @returns {Promise.<void>}
 */
async function loadLogsPane() {
  const dirEl = document.getElementById('log-dir-path');
  const filesEl = document.getElementById('log-files');
  const viewEl = document.getElementById('log-view');
  if (!dirEl || !filesEl || !viewEl) return;
  let r;
  try {
    r = await api('GET', '/api/admin/logs');
  } catch (e) {
    dirEl.textContent = '（读不到）';
    filesEl.textContent = e.message;
    viewEl.textContent = '';
    return;
  }
  state.logDir = r.dir || '';
  state.logFiles = Array.isArray(r.files) ? r.files : [];
  dirEl.textContent = r.dir || '（未知）';
  const cur = state.logFile || 'app.log';
  filesEl.innerHTML = state.logFiles.length
    ? state.logFiles
        .map(
          (f) =>
            `<button class="log-file${f.name === cur ? ' on' : ''}" type="button" data-log="${esc(f.name)}">` +
            `<span>${esc(f.name)}</span><small>${formatBytes(f.size)}</small></button>`,
        )
        .join('')
    : '<div class="es-text">还没有日志文件。</div>';
  // ⚠️ 每次重画都会换掉节点 ⇒ 监听器要跟着重挂（与手机端那些「重画后重挂」的地方同一个理由）
  for (const b of filesEl.querySelectorAll('[data-log]')) {
    b.addEventListener('click', () => {
      state.logFile = b.dataset.log;
      loadLogsPane();
    });
  }
  await loadLogText(cur);
}

/**
 * 功能：读某个日志文件的正文（服务端只给尾部 200 行）。
 * @param {string} name - 文件名（服务端还会过一遍白名单）
 * @returns {Promise.<void>}
 */
async function loadLogText(name) {
  const viewEl = document.getElementById('log-view');
  const nowEl = document.getElementById('log-now');
  if (!viewEl) return;
  viewEl.textContent = '正在读取…';
  try {
    const r = await api('GET', '/api/admin/logs/view/' + encodeURIComponent(name));
    state.logFile = name;
    if (nowEl) {
      nowEl.textContent = `${name} · 最后 ${r.lines} 行${r.truncated ? '（更早的没显示）' : ''}`;
    }
    viewEl.textContent = r.missing ? `（${name} 还不存在 —— 那个账号还没用过 AI）` : r.text || '（空）';
  } catch (e) {
    viewEl.textContent = e.message;
  }
}

/**
 * 功能：复制日志文件夹路径（与「数据来源」栏那颗同一个手法，含复制失败时的兜底选中）。
 * @returns {Promise.<void>}
 */
async function copyLogDir() {
  const p = state.logDir || '';
  if (!p) return toast('还没读到日志路径', true);
  const ok = await copyText(p);
  if (ok) return toast('日志文件夹路径已复制，去文件管理器粘贴即可');
  try {
    const el = document.getElementById('log-dir-path');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_e) {
    /* 选不中也无所谓，路径就在上面 */
  }
  return toast('这个环境不允许自动复制，路径已选中，请按 Ctrl+C', true);
}

/**
 * 功能：渲染「快捷键」栏（⭐ 0.8.14）—— 把原先挂在任务板底部的那行说明搬过来。
 *
 * 说明：⚠️ 搬的是**说明文字**，快捷键的功能本身一个字没动（键处理在 `desktop/app.js` 的
 *      `onKeydown()`，那才是唯一出处）。这里只有一张「键 → 干什么」的表。
 *      ⭐ 用现成的 `.kv-grid`（与「数据来源」同一套两列样式）+ `<kbd>` 芯片，
 *      ⛔ 不为它新造一套样式 —— 这一栏只有一张表，没有第二种形状。
 *      ⚠️ 两列是「键 | 说明」：`<dt>` 放键（窄），`<dd>` 放说明（宽），与 `.kv-grid` 的
 *      `88px 1fr` 正好对上。
 *
 * @returns {string} 该栏的 HTML
 */
function keysPaneHtml() {
  /** 一条快捷键：`[键（多个键各写一次）, 说明]`。顺序按「最常用 → 最少用」排。 @type {Array.<Array>} */
  const rows = [
    [['空格'], '勾选完成 / 取消完成'],
    [['Enter'], '打开这条任务的详情'],
    [['E'], '编辑当前选中的任务'],
    [['Del'], '删除当前选中的任务（可在提示里撤销）'],
    [['↑', '↓'], '在任务列表里上下切换选中'],
    [['N'], '新建任务'],
    [['/'], '跳到搜索'],
    [['Esc'], '关闭弹窗 / 取消当前操作'],
  ];
  return `
    <div class="set-sec">
      <div class="set-sec-head">快捷键</div>
      <div class="panel-card">
        <dl class="kv-grid">
          ${rows
            .map(([keys, what]) => `<dt>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</dt><dd>${esc(what)}</dd>`)
            .join('')}
        </dl>
      </div>
    </div>`;
}

// ⚠️⚠️ 0.8.30（「全局设置改造」）：原来这里有一个 `modulesPaneHtml()` ——
//   「模块功能」那一栏，把**全部**带卡的模块堆在一块儿。**它整块撤了**：各模块的介绍卡与开关
//   下放到**它自己那一栏**里（见 `modulePaneHtml()` 与 `groupCards()`）。
//   ⛔ 别把它加回来 —— 同一颗开关出现在两处，而「模块功能」这个名字本身也已经不在 `PANES` 里了。

/**
 * 功能：渲染一块模块介绍卡 —— 图标 + 名称与副标题 + 功能行 + 数据行 +（有的话）安全提醒 + 开关。
 *
 * 说明：⭐ 整块就是一个按钮（与 `set-row` 同一手法），所以点介绍文字也能翻开关。
 *      ⭐⭐ 0.8.24 任务四：声明了 `card.settings` 的模块走**另一支** —— 卡上多一颗「设置」，
 *      卡片本身从 `<button>` 换成 `<div>`（HTML 不许按钮套按钮），可点与键盘可达性照旧。
 *      ⚠️ 「数据行」那句话对所有模块**逐字相同**，所以只写在这里一份，别复制进接线表。
 *      ⚠️ `tip` 允许为空串（课表 / 收藏夹没有安全提醒要写）—— 空的那一行**整个不渲染**，
 *      别留一个空的 `<span class="mod-tip">` 在那里占位。
 *      ⚠️ **卡上不写「关掉会怎样」**（纠正）：「关闭不会删除数据」那句话原本在
 *      点开关时弹出的确认框里，0.4.1 第四轮连确认框一起撤了（见文件头 ④）—— 卡片只讲这个功能是什么。
 *      ⚠️ 名字 / 图标优先取接线表，没写就回落 `module.json`（`moduleItems()` 已经算好，见 `core/modules.js`）。
 *
 * @param {Object} it - `moduleItems()` 的一条（含 `card` / `icon` / `title` / `on`）
 * @returns {string} 卡片 HTML
 */
function moduleCardHtml(it) {
  // ⭐⭐ 第四轮（「移除莫名其妙的提示语：只简单介绍这个设置是干啥的即可
  //    （一句话介绍），不是讲解这个功能」＋「移除除了设置的齿轮图标外的所有图标」）：
  //    这张卡从前是「图标 ＋ 标题 ＋ 副标题 ＋ 功能行 ＋ 数据行 ＋ 安全提醒 ＋ 开关」——
  //    其中**数据行**（「数据按用户存储，关闭不会删除和影响其他用户数据。」）每张卡逐字重复一遍，
  //    是纯讲解；**图标**也在这一轮整个撤掉。现在只剩：**名称 ＋ 一句话 ＋ 开关**。
  //    ⚠️ `tip` 只留给**真会伤到人**的那两句（主密码忘了打不开 / 内容会发给 AI 服务）——
  //    其余模块的提醒是功能讲解，按这一轮的口径撤掉（两端接线表同时改，见 `module-ui.test.js`）。
  const tip = it.card.tip ? `<span class="mod-tip">${esc(it.card.tip)}</span>` : '';
  // ⭐⭐ 0.8.13：**带子开关清单**的模块（目前只有 `time`「番茄钟与日程表」）
  //    ⇒ 一张卡上画 **N 行**，每行各自翻**自己那一个键**（⛔ 绝不一次提交两个：会把另一台设备
  //    刚改的值覆盖掉）。⚠️ 外层**不能再用 `<button>`** —— 里面还有按钮，HTML 不允许嵌套按钮。
  if (Array.isArray(it.subs) && it.subs.length) {
    const rows = it.subs
      .map(
        (s) => `
        <button id="${it.card.id}-${s.field}" class="mod-subrow" type="button">
          <span class="mod-subname">${esc(s.label)}</span>
          <span class="mod-state">${s.on ? '已开启' : '已关闭'}</span>
          <span class="set-switch${s.on ? ' on' : ''}" aria-hidden="true"><i></i></span>
        </button>`,
      )
      .join('');
    return `
    <div id="${it.card.id}" class="mod-card mod-card-subs${it.on ? '' : ' off'}">
      <span class="mod-main">
        <span class="mod-title"><b>${esc(it.title)}</b><small>${esc(it.card.sub || '')}</small></span>
        <span class="mod-desc">${esc(it.card.desc)}</span>
        ${tip}
        <span class="mod-subs">${rows}</span>
      </span>
    </div>`;
  }
  // ⭐⭐ 0.8.24 任务四（「管理改名为：设置，且这个设置要在全局设置中设置，
  //    全局设置和设置应该指向同一个设置，不能两边独立代码」）：声明了 `card.settings` 的模块，
  //    卡片右侧多一颗「设置」按钮 —— 点它打开**模块自己的设置**（`core/slots.js` 的
  //    `openModuleSettings()` 按约定 import 模块的 `<端>-settings.js`，模块那边再转发到它自己
  //    屏里那颗「设置」用的同一个函数）。⇒ 全站只有一份设置实现，⛔ 没有「两边各写一套」。
  //    ⚠️⭐ HTML **不许按钮套按钮** ⇒ 这一支的卡片从 `<button>` 换成 `<div>`（与上面那支
  //    「带子开关清单」的卡同一个先例）；整块仍然可点（`bindPane()` 那份委托把点按钮那一下挑出去），
  //    并补 `role="button"` / `tabindex="0"` / 回车那两条，把原来 `<button>` 白送的键盘可达性还回来。
  if (it.card.settings) {
    return `
    <div id="${it.card.id}" class="mod-card${it.on ? '' : ' off'}" role="button" tabindex="0">
      <span class="mod-main">
        <span class="mod-title"><b>${esc(it.title)}</b><small>${esc(it.card.sub || '')}</small></span>
        <span class="mod-desc">${esc(it.card.desc)}</span>
        ${tip}
      </span>
      <span class="mod-side">
        <button id="${it.card.id}-set" class="btn btn-subtle btn-sm mod-set" type="button" data-mod-settings="${esc(
          it.name,
        )}" title="打开「${esc(it.title)}」的设置">设置</button>
        <span class="set-switch${it.on ? ' on' : ''}" aria-hidden="true"><i></i></span>
      </span>
    </div>`;
  }
  return `
    <button id="${it.card.id}" class="mod-card${it.on ? '' : ' off'}" type="button">
      <span class="mod-main">
        <span class="mod-title"><b>${esc(it.title)}</b><small>${esc(it.card.sub || '')}</small></span>
        <span class="mod-desc">${esc(it.card.desc)}</span>
        ${tip}
      </span>
      <span class="set-switch${it.on ? ' on' : ''}" aria-hidden="true"><i></i></span>
    </button>`;
}

/**
 * 功能：渲染「数据来源」栏 —— 只读信息：应用版本与存储后端（所有人），
 *      管理员另有数据目录（可复制）、数据文件与大小、读写方式、自动清理、结构版本、升级自动备份。
 *
 * 说明：⚠️ 浏览器**打不开** NAS 上的文件夹（页面在浏览器里、数据在 NAS 上），
 *      所以这里能做的就是「把路径摆清楚 + 一键复制」，用户自己去飞牛文件管理器粘贴。
 *      **别加「打开目录」按钮** —— 那是做不到的。
 *      ⚠️ 管理员的数据位置是**另拉一次接口**（`GET /api/admin/storage`）的：
 *      进设置页时不该为「可能不看的一栏」付一次请求，所以由 `ensureStorage()` 按需拉。
 *      ⭐ 0.4.1（第四轮）：标题旁不再写「这里只是看看，没有能改的东西」、
 *      底部不再摆「复制路径后…」那一整段 —— 这一栏本来就一个能点的东西都没有，
 *      两段解释只是在重复同一句话。⚠️ 别再加回来。
 *
 * @param {boolean} isAdmin - 当前账号是不是管理员
 * @returns {string} 该栏的 HTML
 */
function dataPaneHtml(isAdmin) {
  const h = state.health || {};
  const backend =
    h.backend === 'sqlite'
      ? '数据库文件（正常）'
      : h.backend === 'json'
        ? 'JSON 文件（数据库不可用时的备用方式）'
        : '未知';
  const base = `
      <dl class="kv-grid">
        <dt>应用版本</dt><dd>v${esc(h.version || '—')}${versionBadgeHtml()}</dd>
        <dt>存储后端</dt><dd>${backend}</dd>
      </dl>`;
  const note = `
      <div class="sec-note" style="margin-top: 12px; line-height: 1.7; font-size: 12px; color: var(--text-2)">
        数据都存在这台 NAS 上，每个账号各存各的。
      </div>`;
  if (!isAdmin) {
    return `
    <div class="set-sec">
      <div class="panel-card">${base}${note}</div>
      ${versionsCardHtml()}
    </div>`;
  }
  const s = state.storage;
  if (!s) {
    const why = state.storageError
      ? `读不到这些信息：${esc(state.storageError)}（点左下角「↻ 刷新」可以再试一次）`
      : '正在读取…';
    return `
    <div class="set-sec">
      <div class="panel-card">${base}<div class="es-text" style="margin-top: 12px">${why}</div></div>
      ${versionsCardHtml()}
    </div>`;
  }
  const warn = [];
  if (s.schemaUpgradeSkipped) {
    warn.push(
      `<div class="storage-warn">⚠️ 这次数据库升级被跳过了（你的数据一行都没动）：${esc(s.schemaUpgradeSkipped)}</div>`,
    );
  }
  if (s.degraded || s.readOnly) {
    warn.push(
      `<div class="storage-warn">⚠️ 应用现在是「只能看、不能改」的状态，界面上显示的未必是数据库里的内容：${esc(
        s.initError || '原因未知',
      )}</div>`,
    );
  }
  return `
    <div class="set-sec">
      <div class="panel-card">
        <div class="path-row">
          <code id="storage-path" class="path-text" title="数据目录（NAS 上的文件夹）">${esc(s.dataDir || '—')}</code>
          <button id="btn-copy-path" class="btn btn-subtle btn-sm" type="button">复制路径</button>
        </div>
        <dl class="kv-grid">
          <dt>应用版本</dt><dd>v${esc(h.version || '—')}</dd>
          <dt>数据文件</dt><dd>${esc(s.dbName || '—')}${s.dbSize == null ? '' : ` · ${formatBytes(s.dbSize)}`}</dd>
          <dt>数据存放方式</dt><dd>${backend}</dd>
          <dt>读写方式</dt><dd>${esc(
            s.journalMode === 'wal' ? '正常（读写并行，互不阻塞）' : s.journalMode ? '未开启（常见于网络共享盘）' : '—',
          )}</dd>
          <dt>自动清理</dt><dd>${s.foreignKeys ? '已开启（删除项目时连它下面的任务一起清掉）' : '未开启'}</dd>
          <dt>数据结构版本</dt><dd>v${esc(String(s.schemaVersion))}</dd>
          <dt>升级自动备份</dt><dd>${s.backupFiles && s.backupFiles.length ? `${s.backupFiles.length} 份` : '暂无'}</dd>
        </dl>
        ${warn.join('')}
      </div>
      ${versionsCardHtml()}
    </div>`;
}

/**
 * 功能：从「各端最新版本」的响应里挑出飞牛那一条（没查过 / 查失败了都是 null）。
 *
 * 说明：⚠️ 判据只看**服务端算好的** `state` / `stateLabel`，前端⛔ 不自己比版本号 ——
 *      「当前版本 > 服务器版本 = 测试版」这条口径只许有一份（`core/version-check.js` 的 `stateOf()`）。
 *
 * @returns {?Object} 飞牛那一条 `{platform,label,version,publishedAt,state,stateLabel,listLabel}`；没有则 null
 */
function fnosVersionItem() {
  const v = state.versions;
  if (!v || !v.ok || !Array.isArray(v.items)) return null;
  return v.items.find((it) => it.platform === 'fnos') || null;
}

/**
 * 功能：渲染「应用版本」后面那一小枚状态标 —— 前置版（比服务器新）标「测试版」，服务器更新标「有新版本」。
 *
 * 说明：⭐ 0.9.1（口径）：「当前版本 > 服务器版本 则提示 测试版」。
 *      ⚠️ 这一颗**只挂在「应用版本」后面**，用 `stateLabel`。「各端最新版本」那四行用 `listLabel`
 *      —— 那里的版本号都来自服务器、已经发布过，不可能是测试版（口径修正）。
 *      ⚠️ 没检查过 / 读不到 / 不可比时**什么都不标**（⛔ 不写「未知」，那会让人以为版本有问题）。
 *
 * @returns {string} 一枚 `<span>` 或空串
 */
function versionBadgeHtml() {
  const it = fnosVersionItem();
  if (!it || !it.stateLabel) return '';
  const cls = it.state === 'ahead' ? 'test' : it.state === 'behind' ? 'new' : 'same';
  return ` <span class="ver-badge ${cls}">${esc(it.stateLabel)}</span>`;
}

/**
 * 功能：渲染「各端最新版本」那张卡 —— 四端最新版本 ＋ 一颗「检查更新」。
 *
 * 说明：⭐⭐ **进页面不联网**（0.9.1）：许可协议 §四.2/3 写明「只有主动点『检查更新』才请求一次，
 *      不点就不通信」⇒ 这里只画状态，请求由 `checkVersions()` 在点击时发出。
 *      ⚠️ 三种状态各有各的话：**没查过**（引导去点）、**查失败**（说清是连不上，并声明不影响使用）、
 *      **有结果**（四行版本 ＋ 检查时刻）。⛔ 别把失败画成空白，那与「还没查」长得一样。
 *
 * @returns {string} 该卡的 HTML
 */
function versionsCardHtml() {
  const v = state.versions;
  const busy = !!state.versionsBusy;
  const btn = `<button id="btn-check-version" class="btn btn-subtle btn-sm" type="button"${
    busy ? ' disabled' : ''
  }>${busy ? '检查中…' : '检查更新'}</button>`;
  let body;
  if (!v) {
    body = `<div class="ver-note">
        还没检查过。点「检查更新」向更新服务器要一次各端最新版本 —— 只发本机的版本号与平台，不发任何账号与数据。
      </div>`;
  } else if (!v.ok) {
    body = `<div class="ver-note ver-note-bad">暂时读不到：${esc(v.message || '连接失败')}。不影响使用，需要时再点一次。</div>`;
  } else {
    body = `
      <dl class="kv-grid">
        ${v.items
          .map((it) => {
            const date = it.publishedAt ? String(it.publishedAt).slice(0, 10) : '';
            const val = it.version
              ? `v${esc(it.version)}${date ? ` <small class="ver-date">${esc(date)}</small>` : ''}`
              : '<span class="ver-empty">暂无发布记录</span>';
            // ⚠️ 列表里读的是 `listLabel`，不是 `stateLabel`（0.9.1 口径修正）：
            //    这四行版本号**都来自服务器、已经发布过**，已发布就不可能是测试版
            //    ⇒ 这里只可能出现「有新版本」。`stateLabel` 留给上面「应用版本」旁那一颗。
            const badge = it.listLabel
              ? ` <span class="ver-badge ${it.state === 'behind' ? 'new' : 'same'}">${esc(it.listLabel)}</span>`
              : '';
            return `<dt>${esc(it.label)}</dt><dd>${val}${badge}</dd>`;
          })
          .join('')}
      </dl>
      <div class="ver-note">检查于 ${esc(v.checkedAt || '—')}${
        v.fromCache ? '（10 分钟内再点不会重复联网）' : ''
      }</div>`;
  }
  return `
      <div class="panel-card" style="margin-top: 12px">
        <div class="ver-head"><b>各端最新版本</b>${btn}</div>
        ${body}
      </div>`;
}

/**
 * 功能：点「检查更新」—— 拉一次 `GET /api/versions` 并重画本栏。
 *
 * 说明：⭐ 这是**唯一**会触发对外联网的入口（许可协议）。`versionsBusy` 既是按钮的禁用态，
 *      也是防连点的闸门；失败照旧把 `{ok:false,message}` 存进 state，让界面说得出「为什么没有」。
 *      ⚠️ 请求前后都要判「还在这一栏」再重画：用户可能点完就切走了，别把别的栏刷成这一栏。
 *
 * @returns {Promise.<void>}
 */
async function checkVersions() {
  if (state.versionsBusy) return;
  state.versionsBusy = true;
  if (state.setPane === 'version') renderSettings();
  try {
    state.versions = await api('GET', '/api/versions');
  } catch (e) {
    state.versions = { ok: false, message: e.message || '连接失败' };
  } finally {
    state.versionsBusy = false;
  }
  if (state.setPane === 'version') renderSettings();
}

/**
 * 功能：渲染「账号设置」栏 —— 账号资料卡 + 改用户名 / 改密码 / 退出登录。
 *
 * 说明：⚠️ 资料卡的**正文在 `views/account.js` 的 `accountPaneHtml()`**（本函数只包一层容器）：
 *      账号资料是「我的账号」这件事的完整答案，把它复制一份到这里就会有两份会漂移的渲染。
 *      ⭐ 0.4.1（第二轮）起这里**不再有「成员管理」入口行** —— 它自己就是左菜单里的一栏
 *      （见 `membersPaneHtml()`），从「跳到另一个页面」改成「就地换一屏」。
 *
 * @returns {string} 该栏的 HTML
 */
function accountPaneHtmlWrap() {
  // ⭐ 设置页质检：栏名与介绍由栏头出（`paneHeadHtml()`），这里只保留「快捷键」这个**真子节**的标题。
  return `
    <div class="set-sec">
      ${accountPaneHtml()}
    </div>`;
}

/**
 * 功能：渲染「成员管理」栏（仅管理员）—— 本函数只给**容器**，成员列表 / 自主注册开关 /
 *      「添加成员」按钮全部由 `views/admin.js` 的 `renderAdmin()` 画进 `#admin-body`。
 *
 * 说明：⭐ 容器与内容分开是刻意的：成员数据要**异步**取，而本文件的渲染是同步的 ——
 *      容器先落位，`adminPaneInto()` 再把数据填进去（有缓存时先画缓存，避免一片空白）。
 *      ⚠️ 这一栏**只在管理员时才会出现在左菜单里**，但服务端才是真闸门（非管理员打 `/api/admin/*` 一律 403）。
 *
 * @returns {string} 该栏的 HTML
 */
function membersPaneHtml() {
  return `
    <div class="set-sec">
      <div class="set-sec-head">成员账号</div>
      <div id="admin-body">${state.adminUsers ? '' : '<div class="es-text">正在读取成员…</div>'}</div>
    </div>`;
}

/**
 * 功能：渲染「备份与恢复」栏 —— **我的数据**的两个入口（导出 / 导入）。
 *
 * 说明：⭐ 第四轮（「像【只管你自己】这个就不对，应该是【我的数据】」）：
 *      这一栏的定位从「只管你自己」改成「**我的数据**」—— 那是**用户视角**的四个字，
 *      「只管你自己」是在解释这条设置的口径（面向实现），不是介绍它干什么。
 *      同时按下一条要求把三颗行图标全部撤掉。
 *
 * @returns {string} 该栏的 HTML
 */
function backupPaneHtml() {
  return `
    <div class="set-sec">
      <button id="set-export" class="set-row" type="button">
        <span class="set-main"><b>导出我的数据</b><small>下载一份文件，里面是你的项目、任务、课表、收藏、硬件和密码</small></span>
        <span class="set-val">下载</span>
      </button>
      <button id="set-import" class="set-row" type="button">
        <span class="set-main"><b>导入我的数据</b><small>把一份备份放回你的账号，可以「合并」或「替换」</small></span>
        <span class="set-val">选择文件</span>
      </button>
      <div class="sec-note" style="margin-top: 12px; line-height: 1.7; font-size: 12px; color: var(--text-2)">
        要备份或还原<b>整个系统</b>（包括全部账号），去左菜单的「管理员设置」。
      </div>
    </div>`;
}

/**
 * 功能：渲染「整体备份」段（仅管理员）—— 导出全库快照 / 用备份替换整个系统。
 *
 * 说明：⭐ 它**刻意与「备份与恢复」分开**：一个只碰自己、一个动整库，
 *      并排放在一起时太容易点错，而点错的代价是所有人的数据被替换。
 *
 * @returns {string} 该段的 HTML
 */
function orgPaneHtml() {
  return `
    <div class="set-sec">
      <div class="set-sec-head">整体备份</div>
      <button id="set-org-export" class="set-row" type="button">
        <span class="set-main"><b>导出整体备份</b><small>下载全部账号的全部数据，用来整机搬家或留底</small></span>
        <span class="set-val">下载</span>
      </button>
      <button id="set-org-restore" class="set-row danger" type="button">
        <span class="set-main"><b>恢复整体备份</b><small>用备份把现在的数据整个换掉，做完收不回来</small></span>
        <span class="set-val">危险</span>
      </button>
      ${migrateRowHtml()}
      <div class="set-note warn" style="margin-top: 12px">
        这一栏会影响<b>所有人</b>：导出的备份里有全部账号和密码，等于整个系统的钥匙，请离线收好；
        还原会用备份把现在的数据整个换掉 —— 备份里没有的账号会被删掉，所以要你手打「恢复」两个字才放行。${
          MIGRATE_ENABLED
            ? '「迁移记账数据」动的是文件的存放位置，做完也收不回来，所以要你手打「迁移」两个字才放行。'
            : ''
        }
      </div>
    </div>`;
}

/**
 * 「迁移记账数据」这一行**现在不出现**（「移除迁移记账数据功能（隐藏），
 * 因为本项目还没有正式上线过」）。
 *
 * 说明：⭐ 这道口子只服务 **0.8.1 那一次换库**（把 1 期记在主库里的 `ledger_*` 表搬进
 *      `zxdesk-ledger.db`）。本项目至今**没有正式上线**，也就是说：不存在任何一份「1 期老库」
 *      需要被迁移 —— 每个库都是 0.8.1 之后建的，记账数据本来就在独立库里。
 *      ⇒ 按钮整块不画，**代码与接口一个字没删**（`POST /api/migrate-ledger` 仍在，
 *      真要处理将来某一份老库时，把 `MIGRATE_ENABLED` 翻成 `true` 就回来了）。
 *      ⛔ 别顺手删 `migrateLedger()` / `doMigrate()` / 那条路由 —— 那是「隐藏」不是「删除」，
 *      删了以后要恢复就得从头重写一遍（含手打二字确认那套）。
 *
 * @returns {string} 那一行的 HTML；关闭时是空串
 */
const MIGRATE_ENABLED = false;

/** 功能：按开关决定画不画「迁移记账数据」那一行。 @returns {string} HTML 或空串 */
function migrateRowHtml() {
  if (!MIGRATE_ENABLED) return '';
  return `
      <button id="set-org-migrate" class="set-row danger" type="button">
        <span class="set-main"><b>迁移记账数据</b><small>把 1 期记在主库里的记账数据搬进独立的记账库；可以重跑，不会重复搬</small></span>
        <span class="set-val">危险</span>
      </button>`;
}

/**
 * 功能：管理员进「数据来源」栏时按需补拉一次数据位置（`GET /api/admin/storage`）并重画。
 *
 * 说明：⚠️ 只在**当前分栏还是「数据来源」**时才重画 —— 用户可能已经点去别的栏了，
 *      这时重画会把人家正在看的那一栏顶掉。
 *      ⚠️ 失败要**说话**（静默降级不行）：把原因写进 `state.storageError`，
 *      分栏里会如实显示「读取数据位置失败」而不是空着。
 *      ⚠️ `state.storageError` 也是「别再自动重试」的闸门 —— 否则渲染 → 失败 → 再渲染会打转。
 *
 * @returns {Promise.<void>}
 */
async function ensureStorage() {
  const me = state.me;
  if (!me || !me.is_admin || state.storage || state.storageError) return;
  try {
    state.storage = await api('GET', '/api/admin/storage');
  } catch (e) {
    state.storageError = e.message;
  }
  // ⚠️⭐ 设置页质检：判据从 `'data'` 改成 `'version'` —— 那一栏 0.8.30 就改名成「版本数据」了，
  //    这里的旧值从来没命中过 ⇒ 数据到不了界面（页面上永远「正在读取…」）。
  if (state.setPane === 'version') renderSettings();
}

/**
 * 功能：给当前分栏里的按钮挂上处理函数 —— 分栏只画一块，所以没画到的节点直接跳过。
 * @param {string} id - 分栏标识
 * @returns {void}
 */
function bindPane(id) {
  // ⭐⭐ 0.8.30：**模块那一栏** —— 它的开关卡（含子开关与卡上那颗「设置」）＋「进入模块」都在这里挂。
  //    判据从「id 是不是 'modules'」换成「这一栏是不是带 `mods` 的模块栏」—— 开关从一栏拆到了六栏，
  //    但**挂法一个字没变**，改的只是「取哪几张卡」（`groupCards()`）。
  const p = PANES.find((x) => x.id === id);
  if (p && p.mods) {
    const items = groupCards(p);
    for (const it of items) {
      const node = document.getElementById(it.card.id);
      if (!node) continue;
      node.addEventListener('click', (e) => {
        const set = e.target.closest('[data-mod-settings]');
        if (set) {
          // ⚠️ 打不开要说话：模块被删掉 / 约定文件缺失时 `openModuleSettings()` 回 false
          openModuleSettings('desktop', set.getAttribute('data-mod-settings')).then((ok) => {
            if (!ok) toast(`${it.title}的设置打不开 —— 请刷新页面重试`);
          });
          return;
        }
        toggleModule(it);
      });
      // ⚠️ 卡片从 `<button>` 换成 `<div>` 之后，回车 / 空格翻开关要自己接（原来那是浏览器白送的）
      node.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('[data-mod-settings]')) return;
        e.preventDefault();
        toggleModule(it);
      });
    }
    // ⭐ 0.8.13：带**子开关清单**的模块（目前只有 `time`）——
    //    一张卡上的 N 行**各自翻自己那一个键**（⛔ 绝不一次提交两个）。
    for (const it of items)
      for (const sub of it.subs || []) on(`${it.card.id}-${sub.field}`, () => toggleModuleSub(sub.prefsKey, sub.field));
    // ⭐⭐ 0.8.30：「进入模块」—— **点侧栏那颗入口按钮**（⛔ 不新造第二条切屏通路，见 `modulePaneHtml()`）
    if (p.navId)
      on(`set-goto-${p.id}`, () => {
        const btn = document.getElementById(p.navId);
        if (btn) btn.click();
      });
    return;
  }
  if (id === 'version') {
    on('btn-copy-path', copyDataPath);
    // ⭐ 0.9.1：唯一会对外联网的那颗按钮（见 `checkVersions()` 的说明）
    on('btn-check-version', checkVersions);
    return;
  }
  if (id === 'account') {
    // ⚠️ 改名成功后要重画本栏（名字就写在资料卡里）—— 回调而不是让 account.js 反向 import 本文件
    on('btn-change-name', () => openUsernameModal(renderSettings));
    on('btn-change-pw', openPasswordModal);
    on('btn-logout', doLogout);
    return;
  }
  if (id === 'backup') {
    on('set-export', exportBackup);
    on('set-import', importBackup);
    return;
  }
  // ⭐ 0.8.30：合并后的**「管理员设置」**栏 = 成员管理 ＋ 整体备份 ＋ 日志 —— 三段各挂各的。
  if (id === 'admin') {
    adminPaneInto();
    on('log-copy-dir', copyLogDir);
    on('log-refresh', loadLogsPane);
    loadLogsPane();
    on('set-org-export', exportOrgBackup);
    on('set-org-restore', restoreOrgBackup);
    // ⭐ 0.8.1：记账数据迁移（`POST /api/migrate-ledger`）—— 与上面两颗同栏、同一种「危险」待遇
    on('set-org-migrate', migrateLedger);
  }
}

/**
 * 功能：往「成员管理」栏里填内容 —— 先用已有数据画一版（有的话），再向服务端要一次最新的。
 *
 * 说明：⚠️ **每次进这一栏 / 点刷新都重新拉一次**（不像「数据来源」那样拉一次就缓存住）：
 *      成员列表是会被**别人**改变的（有人在登录页自主注册、别的管理员加了人），
 *      拿一份陈旧的列表做「删除 / 重置密码」，删的可能是已经不存在的账号。
 *      ⚠️ 先用缓存画一版是为了**不白屏**：等接口回来的那一两百毫秒里，列表还在而不是空的。
 *
 * @returns {void}
 */
function adminPaneInto() {
  if (state.adminUsers) renderAdmin();
  loadAdmin();
}

/**
 * 功能：给某个 id 的节点挂点击处理 —— 节点不存在就什么都不做（分栏只画当前那一块）。
 * @param {string} id - 元素 id（不带 `#`）
 * @param {Function} fn - 点击处理函数
 * @returns {void}
 */
function on(id, fn) {
  const node = document.getElementById(id);
  if (node) node.addEventListener('click', fn);
}

/**
 * 功能：复制数据目录路径 —— 复制成功给提示；环境不允许自动复制时退而求其次，
 *      把路径文字**选中**让用户按 Ctrl+C。
 *
 * 说明：⚠️ 浏览器打不开 NAS 上的文件夹，所以「复制路径 + 去文件管理器粘贴」是唯一可行的路径交付方式。
 *
 * @returns {Promise.<void>}
 */
async function copyDataPath() {
  const path = (state.storage && state.storage.dataDir) || '';
  const ok = await copyText(path);
  if (ok) return toast('数据目录已复制，去文件管理器粘贴即可');
  try {
    const el = document.getElementById('storage-path');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_e) {
    /* 选不中也无所谓，路径就在上面 */
  }
  toast('这个环境不允许自动复制，路径已选中，请按 Ctrl+C', true);
}

/**
 * 功能：弹一个「说明 + 一个动作按钮」的确认框 —— 设置页的规矩是**页面上不摆任何提示**，
 *      所有「这么做的后果」都在点下去的那一刻说（指令）。
 *
 * 说明：与 `ui.js` 的 `openConfirmModal` 是同一套写法，只多一个 `danger` 开关 ——
 *      那个函数一律用红色按钮，而「关掉课表」「导出我的数据」并不危险，一律标红会让人误判。
 *
 * @param {string} title - 弹窗标题
 * @param {string} html - 正文 HTML（把原来摆在页面上的说明放这里）
 * @param {string} okLabel - 主按钮文案（写清会发生什么，别只写「确定」）
 * @param {boolean} danger - 主按钮是否用危险样式
 * @param {Function} fn - 确认后执行的异步动作
 * @returns {void}
 */
function confirmAction(title, html, okLabel, danger, fn) {
  openModal(title, html);
  setModalSave(okLabel, danger);
  $('#modal-save').onclick = async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：翻某个模块的显示开关 —— **一个函数管全部模块**（模块名与接口键都从清单与接线表来的）。
 *
 * 说明：⭐ **点了就生效**：不弹确认框、也不弹轻提示（指令）。唯一的反馈是卡片里
 *      那行「已开启 / 已关闭」—— 再拦一句「你确定吗」、事后再飘一句「已关掉课表」都是多余的。
 *      ⚠️ 之前那套「关闭不会删除数据：…」的确认框连文案一起撤了，别按老样子加回来。
 *      ⚠️ 0.5.0 起不再有 `toggleTimetable()` 这种「一个模块一个函数」的写法：加一个模块要在
 *      设置页里补一个函数、`bindPane()` 里补一行、`MODULES` 里补一条 —— 那正是这次重构要消灭的东西。
 *      ⚠️ 不可关的模块（`module.json` 的 `switchField` 是空的，如任务板）根本不会画卡，
 *      这里再守一道：没有接口键就直接返回，绝不拿空键去提交（服务端会 400）。
 *
 * @param {Object} it - `moduleItems()` 的一条（含 `prefsKey` / `switchField` / `on`）
 * @returns {Promise.<void>}
 */
export async function toggleModule(it) {
  if (!state.me) return toast('还没读到你的账号，点左下角「↻ 刷新」再试一次', true);
  if (!it || !it.prefsKey) return;
  return applyPref(it.prefsKey, !state.me[it.switchField]);
}

/**
 * 功能：翻**一个子开关**（一个模块里几个同级子模块各一颗，如 `time` 的课表 / 番茄钟 / 行程）。
 *
 * 说明：⭐ 0.8.13：卡上那 N 行**各自只提交自己那一个键** ——
 *      ⛔ 绝不一次提交两个（提交两个等于拿本地那份可能已过期的 `state.me` 去覆盖另一个开关）。
 *      ⚠️ 与 `toggleModule()` 分开写是刻意的：那条单键通道只服务「一个模块一颗开关」的模块，
 *      多子开关的模块走这条（`prefsKeyOf()` 对数组回空串，正好把两者分开）。
 *
 * @param {string} key - 接口键名（`'hideTimetable'` / …）
 * @param {string} field - `users` 上的列名（`'hide_timetable'` / …）—— 用来读「现在开着吗」
 * @returns {Promise.<void>}
 */
export async function toggleModuleSub(key, field) {
  if (!state.me) return toast('还没读到你的账号，点左下角「↻ 刷新」再试一次', true);
  if (!key || !field) return;
  return applyPref(key, !state.me[field]);
}

/**
 * 功能：把某一项个人偏好提交到服务端并就地应用 —— 更新 `state.me`、刷新入口显隐、重画设置页。
 *
 * 说明：⚠️ 每次**只提交一个键**（`hideTimetable` / `hideBookmarks` / `hideHardware` / `hideVault` /
 *      `hideTeamwork` 各发各的）：接口那边虽然是「请求里带了哪个就写哪个」，但这里把各开关彻底解耦更安全 ——
 *      提交两个键等于拿本地那份可能已经过期的 `state.me` 去覆盖另一个开关。
 *      ⚠️ **成功不说话，失败必须说话**：不再弹「已关掉 X」那种轻提示（点了就生效，卡片自己会变），
 *      但请求失败仍然要弹错误提示 —— 静默失败会让人以为开关坏了。
 *
 * @param {string} key - 接口键名（`'hideTimetable'` / …），由 `core/modules.js` 的 `prefsKeyOf()` 从
 *      `module.json` 的 `switchField` 换算而来
 * @param {boolean} next - 目标状态（true = 关闭）
 * @returns {Promise.<void>}
 */
async function applyPref(key, next) {
  try {
    const r = await api('PUT', '/api/auth/prefs', { [key]: next });
    if (r && r.user) state.me = r.user;
    applyPrefsVisibility();
    renderSettings();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 选文件 ----------
/**
 * 功能：弹一个系统文件选择框，用户选中后用 `File` 对象回调（取消则什么都不做）。
 *
 * 说明：用一个**临时 `input[type=file]`**，而不是在页面里常驻一个隐藏 input：
 *      设置页每次渲染都会重建 `#settings-body` 的 HTML，常驻 input 会被连根拔掉；
 *      临时元素用完即弃，也不怕用户取消（`cancel` 事件与 `change` 一起兜底清理）。
 *
 * @param {string} accept - `accept` 属性（如 `.json,application/json`）
 * @param {Function} onPick - 收到 `File` 后的回调
 * @returns {void}
 */
function pickBackupFile(accept, onPick) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = accept;
  inp.style.display = 'none';
  document.body.appendChild(inp);
  /** 功能：把临时 input 从 DOM 里摘掉（选中与取消两条路径共用） */
  const drop = () => {
    if (inp.parentNode) inp.parentNode.removeChild(inp);
  };
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    drop();
    if (f) onPick(f);
  });
  inp.addEventListener('cancel', drop);
  inp.click();
}

/**
 * 功能：读一个本地文件并解析成 JSON 对象；解析失败或不是一个对象时提示并返回 null。
 * @param {File} file - 用户选中的文件
 * @returns {Promise.<?Object>} 解析结果；失败时为 null（已弹提示）
 */
async function readJson(file) {
  let text;
  try {
    text = await file.text();
  } catch (_e) {
    toast('这个文件读不出来，请重新选择', true);
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_e) {
    toast('这不是一个有效的 JSON 文件', true);
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    toast('备份文件的顶层必须是一个 JSON 对象', true);
    return null;
  }
  return obj;
}

/** 功能：从备份对象里取数组（课表 5 张表认新旧两种键名，与后端一致） */
function arrOf(dump, ...keys) {
  for (const k of keys) if (Array.isArray(dump[k])) return dump[k];
  return [];
}

/** 功能：把备份对象里的各类条数整理成 `[[名称, 条数], …]`，供预览弹窗显示 */
function countsOf(dump) {
  return [
    ['项目', arrOf(dump, 'projects').length],
    ['项目任务', arrOf(dump, 'project_tasks').length],
    ['日常任务', arrOf(dump, 'daily_tasks').length],
    ['学期', arrOf(dump, 'timetable_terms', 'terms').length],
    ['课程', arrOf(dump, 'timetable_courses', 'courses').length],
    ['课次', arrOf(dump, 'timetable_sessions', 'course_sessions').length],
    ['书签', arrOf(dump, 'bookmarks').length],
    ['书签分类', arrOf(dump, 'bookmark_tags').length],
    // ⭐ 0.3.1 NAS硬件管理：台账与愿望单同一张表，导出键是 `hardware`
    ['数码台账', arrOf(dump, 'hardware').length],
    // ⭐ 0.3.2 密码库：`vault_items` 是条目数（`vault_meta` 是「开库材料」，一账号一行，
    //    把它当成一条「数据」显示会让人以为存了 1 条密码 —— 所以只显示条目数）
    ['密码库', arrOf(dump, 'vault_items').length],
  ];
}

/** 功能：把 `[[名称, 条数], …]` 渲染成一列「名称 · 条数」的碎片 */
function countsHtml(pairs) {
  return pairs.map(([k, n]) => `<span class="imp-chip">${esc(k)} <b>${n}</b></span>`).join('');
}

/** 功能：渲染备份文件的「来源信息」一行（导出时间 / 来源版本 / 文件名与体积） */
function metaHtml(dump, file) {
  return `<div class="imp-meta">
      文件：<b>${esc(file.name)}</b>（${esc(formatBytes(file.size))}）
      ${dump.exportedAt ? ` · 导出于 ${esc(dump.exportedAt)}` : ''}
      ${dump.version ? ` · 来源版本 v${esc(dump.version)}` : ''}
    </div>`;
}

// ---------- 个人数据 ----------
/**
 * 功能：导出当前账号的完整数据备份 —— 先确认（说明这是明文文件），确认后导航到 `/api/export`。
 *
 * 说明：用导航而不是 `fetch` + Blob：这样由浏览器自己处理下载与文件名，
 *      大库也不会在内存里多留一份。
 *
 * @returns {void}
 */
export function exportBackup() {
  confirmAction(
    '导出我的数据',
    `<p>会下载一份文件，里面是你自己的全部数据：项目、任务、课表、收藏、硬件和密码。</p>
     <p class="set-note">这个文件是<b>没加密</b>的，请自己收好。拿它导入回来时，不会动你的账号，也不影响别人。</p>
     <p class="set-note">🔐 里面的密码库仍然是<b>加过密的</b>，而且主密码<b>不在文件里</b> ——
       所以恢复之后还是原来那把主密码。⚠️ 「合并导入」不会导入密码库（两套密码库合不到一起），
       要恢复密码库请选「替换导入」。</p>`,
    '开始下载',
    false,
    () => {
      closeModal();
      window.location.href = BASE + '/api/export';
      toast('已开始下载备份文件');
    },
  );
}

/**
 * 功能：导入个人备份 —— 选文件 → 预览（条数 / 来源）→ 由用户选「合并」或「替换」→ 上传。
 *
 * 说明：⭐ 预览是**客户端**数出来的（数组长度），只是给个心理准备；真正的校验在服务端，
 *      不合格的文件会被退回并说明原因（且一行数据都不会写进去）。这样大文件不必传两遍。
 * ⚠️ 两个按钮的差别必须说人话：「合并」不删任何东西，「替换」会清掉本账号现有数据 ——
 *      后者做成红色，且文案里写清「账号本身不动」。
 *
 * @returns {Promise.<void>}
 */
export async function importBackup() {
  pickBackupFile('.json,application/json', async (file) => {
    if (await isBackupZip(file)) {
      return toast('这是整体备份压缩包，请到「恢复整体备份」里使用（需要管理员权限）', true);
    }
    const dump = await readJson(file);
    if (!dump) return;
    if (dump.kind === 'org-backup' || dump.tables) {
      return toast('这是整体备份文件，请到「恢复整体备份」里使用（需要管理员权限）', true);
    }
    if (dump.app !== 'ZXDesk') return toast('这不是 ZXDesk 的备份文件', true);

    const total = countsOf(dump).reduce((s, [, n]) => s + n, 0);
    openModal(
      '导入我的数据',
      `${metaHtml(dump, file)}
       <div class="imp-counts">${countsHtml(countsOf(dump))}</div>
       <div class="imp-pick">
         <b>合并导入</b>（推荐）：把上面这些东西<b>加</b>进你的账号，现有的一条都不删 ——
         同一份备份导两次，就会变成两份。
       </div>
       <div class="imp-pick danger">
         <b>替换导入</b>：先把你现在的项目 / 任务 / 课表 / 收藏 / 硬件 / 密码清空，再放进备份里的内容（做完收不回来）。
         你的<b>账号本身不受影响</b> —— 用户名、登录密码、是不是管理员、各个功能的开关，全都照旧。
       </div>
       <div class="set-note">🔐 密码库<b>只有「替换导入」能恢复</b>：两套密码库的钥匙不一样，合到一起会有一半密码永远打不开，
         所以合并导入会明确跳过它。</div>
       ${total === 0 ? '<div class="set-note warn">这份备份里一条数据都没有，导入不会有任何变化。</div>' : ''}
       <div class="imp-actions">
         <button id="imp-merge" class="btn btn-primary" type="button">合并导入</button>
         <button id="imp-replace" class="btn btn-danger" type="button">替换导入</button>
       </div>`,
    );
    // 通用弹窗的主按钮在这类「多按钮」弹窗里只当取消用 —— 具体动作在正文的两个按钮上
    setModalSave('取消', false);
    $('#modal-save').onclick = closeModal;
    $('#imp-merge').onclick = () => doImport(file, 'merge');
    $('#imp-replace').onclick = () => doImport(file, 'replace');
  });
}

/**
 * 功能：把备份文件原文 POST 给 `/api/import?mode=...`，成功后整页重载。
 *
 * 说明：⚠️ 直接发 `file` 本身（`FormData` 都不用）—— 服务端就是按原始字节读的 JSON，
 *      前端再 `JSON.stringify` 一遍只会白白多占一份内存。
 * ⚠️ 导入成功后走**整页重载**而不是「刷新一下列表」：导入会同时改动项目、任务、课表三类数据，
 *    而课表在 `state` 里另有一整套缓存（学期列表、当前周次）。整页重载是唯一不会漏掉某处的做法。
 *
 * @param {File} file - 用户选中的备份文件（其内容已在预览阶段确认是合法 JSON）
 * @param {string} mode - `'merge'` 或 `'replace'`
 * @returns {Promise.<void>}
 */
async function doImport(file, mode) {
  const btnM = $('#imp-merge');
  const btnR = $('#imp-replace');
  if (btnM) btnM.disabled = true;
  if (btnR) btnR.disabled = true;
  try {
    const res = await fetch(`/api/import?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: file,
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error((r && r.error) || `导入失败（HTTP ${res.status}）`);
    closeModal();
    const c = (r && r.counts) || {};
    const n = Object.keys(c)
      .filter((k) => k !== '_skipped')
      .reduce((s, k) => s + c[k], 0);
    toast(
      `${mode === 'replace' ? '已替换导入' : '已合并导入'} ${n} 条${c._skipped ? `（跳过 ${c._skipped} 条）` : ''}`,
    );
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    if (btnM) btnM.disabled = false;
    if (btnR) btnR.disabled = false;
    toast(e.message, true);
  }
}

// ---------- 整体备份（仅管理员） ----------
/**
 * 功能：导出整库备份 —— 先确认（说明这份文件等同于系统的钥匙），确认后导航到 `/api/backup`。
 *
 * 说明：⚠️ 这段「含全部账号的口令散列」的警告原来常驻在按钮下方，现在挪进确认框 ——
 *      读到它的时机正好是即将下载的那一刻，比挂在页面上更有用。
 *      下载的是一个 zip，里面有三份东西，所以这里把**每一份是干什么的**说清楚：
 *      用户打开压缩包看到 `zxdesk.db` 时至少知道那是什么，而不是猜。
 *      非管理员访问该地址会被服务端拒绝（403），页面会显示一行 JSON 错误，不影响数据。
 *
 * @returns {void}
 */
export function exportOrgBackup() {
  confirmAction(
    '⚠️ 导出整体备份',
    `<p>会下载一个 <b>zip 压缩包</b>（<code>ZXDesk-数据备份-日期-时间.zip</code>），
      里面是全部账号的全部数据。</p>
     <p>包里有三样东西：<b>backup.json</b>（「恢复整体备份」时上传的就是它）、
      <b>zxdesk.db</b>（应用的数据库文件，应用起不来时可以手工放回数据文件夹）、<b>manifest.json</b>（这份摘要）。</p>
     <p class="set-note warn">拿到这个包就等于<b>拿到整个系统</b> —— 谁都能看到所有人的数据，
      请离线收好、不要随手转发。</p>`,
    '开始下载',
    true,
    () => {
      closeModal();
      window.location.href = BASE + '/api/backup';
      toast('已开始下载整体备份（含全部账号，请妥善保管）');
    },
  );
}

/**
 * 功能：恢复整体备份 —— 选文件 → 显示将要发生什么 → 要求手打「恢复」二字 → 上传 → 送回登录页。
 *
 * 说明：⚠️ 这是全项目唯一会**删掉所有人数据**的操作，所以这里刻意做得「不顺手」：
 *      ① 必须输入「恢复」二字才能点确认（防手滑与误点）；
 *      ② 弹窗里明确写出「会被清空」「所有人会被登出」「系统会自动另存一份当前库」；
 *      ③ 服务端在覆盖前还会再快照一次，并把快照文件名回给前端显示出来 ——
 *         万一恢复错了，至少知道拿哪个文件去回滚。
 * ⭐ 两种文件都认：新版 `.zip` 压缩包与 0.2.0 及更早导出的纯 `.json`，按**首字节**分流。
 *      摘要读得出来就照常显示条数，读不出来（被别的工具重压过）就不显示条数、只显示文件名与体积 ——
 *      **猜出来的「账号 0 个」比不显示更糟**，何况恢复本来不靠这个数字。
 *
 * @returns {Promise.<void>}
 */
export async function restoreOrgBackup() {
  pickBackupFile('.zip,application/zip,.json,application/json', async (file) => {
    const zip = await isBackupZip(file);
    const manifest = zip ? await readZipManifest(file) : null;
    let src;
    let counts;
    if (zip) {
      src = manifest || {};
      counts = manifest && manifest.counts;
    } else {
      const dump = await readJson(file);
      if (!dump) return;
      if (!dump.tables || typeof dump.tables !== 'object') {
        return toast('这不是整体备份文件，请用「导入我的数据」', true);
      }
      src = dump;
      counts = dump.tables;
    }
    const preview = counts
      ? `<div class="imp-counts">${countsHtml(orgCounts(counts))}</div>`
      : `<div class="set-note" style="margin-top:12px">读不出包里的摘要（这个包可能被别的工具重新压过）。
         照样可以恢复 —— 服务端会把整份备份从头验一遍。</div>`;
    openModal(
      '⚠️ 恢复整体备份',
      `${metaHtml(src, file)}
       ${preview}
       <div class="set-note warn" style="margin-top:12px">
         恢复之后，系统里的账号和数据会<b>变成这份备份的样子</b>：<br />
         · 现在有、但备份里没有的账号会被<b>删掉</b>，连同它的全部数据；<br />
         · 备份里没有的东西<b>不会留着</b>（这是整个换掉，不是合并）；<br />
         · 所有人（<b>包括你自己</b>）都会被登出，要重新登录；<br />
         · 换掉之前，系统会自动把现在的数据另存一份（文件名会在做完后告诉你）。
       </div>
       <label class="imp-confirm">确认请输入「恢复」二字：<input id="rst-word" type="text" autocomplete="off" /></label>`,
    );
    setModalSave('确认恢复（危险）', true);
    $('#modal-save').onclick = async () => {
      if (($('#rst-word').value || '').trim() !== '恢复') {
        return toast('请输入「恢复」两个字才能继续', true);
      }
      await doRestore(file);
    };
  });
}

/**
 * 功能：上传整体备份并执行恢复；成功后弹出一个「已恢复」的结果弹窗，把人送回登录页。
 *
 * @param {File} file - 用户选中的整体备份文件
 * @returns {Promise.<void>}
 */
async function doRestore(file) {
  setModalSave('恢复中…', true);
  $('#modal-save').disabled = true;
  try {
    const res = await fetch(BASE + '/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error((r && r.error) || `恢复失败（HTTP ${res.status}）`);
    openModal(
      '恢复完成',
      `<div class="set-note">
         数据已经变成备份里的样子（账号 <b>${(r.counts && r.counts.users) || 0}</b> 个）。
         所有人的登录都失效了，请重新登录。
       </div>
       <div class="set-note" style="margin-top:10px">
         换掉之前的旧数据已另存为 <b>${esc((r.backupFile && r.backupFile) || '—')}</b>，
         就在 NAS 的数据文件夹里（路径见设置 →「数据来源」）。万一恢复错了，可以拿它退回去。
       </div>`,
    );
    const b = $('#modal-save');
    b.disabled = false;
    setModalSave('前往登录', false);
    b.onclick = () => {
      location.href = BASE + '/login.html';
    };
  } catch (e) {
    const b = $('#modal-save');
    b.disabled = false;
    setModalSave('确认恢复（危险）', true);
    toast(e.message, true);
  }
}

// ---------- 记账数据迁移（仅管理员，0.8.1 / T24） ----------
/**
 * 功能：记账数据迁移 —— 先讲清后果、要求手打「迁移」二字，再发一次 `POST /api/migrate-ledger`。
 *
 * 说明：⚠️ 这是**整库级别的文件操作**（把 1 期落在主库 `zxdesk.db` 的那几张 `ledger_*` 表
 *      搬进独立的记账库），所以照「恢复整体备份」那一套来：危险红行 ＋ 说明 ＋ 手打确认。
 *      ⭐ 它**幂等**（服务端跑三态：已迁移 / 只清残留 / 无需迁移）—— 所以文案里明说「可以重跑」，
 *      ⛔ 别写成"只能做一次"（那会让用户不敢在没搞清状态时点它）。
 *      ⚠️ 本地只拦「没打那两个字」这一条**表单语义**检查；能不能跑、跑出什么结果一律服务端说了算
 *      （非管理员 403、记账库不可用 503、复制失败 500，原样把话弹给用户，⛔ 前端不预判）。
 * @returns {void}
 */
function migrateLedger() {
  openModal(
    '⚠️ 迁移记账数据',
    `<p>会把 1 期记在<b>主库</b>里的那几张记账表，搬进记账自己的<b>独立库</b> ——
      数据一条不少，界面上看不出任何区别，只是换个地方存。</p>
     <p>这一步<b>可以重跑</b>：已经搬过的不会重复搬，最多把主库里的残留清掉。</p>
     <p class="set-note warn">开始之前会给两个库各留一份<b>快照</b>（文件名会在做完后告诉你）——
      万一要回滚，就是拿它人工放回去。</p>
     <label class="imp-confirm">确认请输入「迁移」二字：<input id="mig-word" type="text" autocomplete="off" /></label>`,
  );
  setModalSave('开始迁移', true);
  $('#modal-save').onclick = async () => {
    if (($('#mig-word').value || '').trim() !== '迁移') {
      return toast('请输入「迁移」两个字才能继续', true);
    }
    await doMigrate();
  };
}

/**
 * 功能：把迁移报告里那三态翻成一句人话（⛔ 不把服务端的 `state` 原样摆给用户看）。
 * @param {Object} r - `POST /api/migrate-ledger` 的响应
 * @param {number} total - `counts` 各表条数之和
 * @returns {string} 一句结果说明
 */
function migrateStateText(r, total) {
  const st = String((r && r.state) || '');
  if (st === 'migrated') {
    return r.mainCleaned
      ? `搬完了：一共 ${total} 条记账数据已在独立库里，主库那几张表也清空了。`
      : `搬完了：${total} 条记账数据已在独立库里；主库那边还有残留没清掉 —— 数据是安全的（不会重复搬），下次再点一次会把它清掉。`;
  }
  if (st === 'cleaned') {
    return `没有重复搬 —— 只清掉了主库里的残留 ${total} 条。`;
  }
  return '无需迁移：主库里没有记账数据（或者早就搬完了），这次什么都没动。';
}

/**
 * 功能：真正发一次迁移请求，并把「搬了几条 / 快照在哪」原样摆给用户看。
 *
 * 说明：⚠️ 结果里**必须带上快照文件名与目录**：那是唯一的人工回滚材料，
 *      只弹一句「迁移完成」等于把回滚的路藏起来了。
 *      ⚠️ 成功后 `#modal-save` 是**新节点**（`openModal()` 换掉了整块弹窗正文与按钮），
 *      所以按钮要**重新取一次**再改它 —— 拿旧引用改会静默失效（按钮一直灰着）。
 * @returns {Promise.<void>}
 */
async function doMigrate() {
  setModalSave('迁移中…', true);
  const old = $('#modal-save');
  if (old) old.disabled = true;
  try {
    const r = await api('POST', '/api/migrate-ledger');
    const c = (r && r.counts) || {};
    const total = Object.keys(c).reduce((s, k) => s + Number(c[k] || 0), 0);
    const snaps = (r && r.snapshots) || [];
    openModal(
      '迁移完成',
      `<div class="set-note">${esc(migrateStateText(r, total))}</div>
       <div class="set-note" style="margin-top:10px">
         迁移前的快照：<b>${snaps.length ? esc(snaps.join('、')) : '（这次没有生成）'}</b>${
           r && r.dir ? `，就在 NAS 的数据文件夹里（<code>${esc(r.dir)}</code>）。` : '。'
         }
       </div>${r && r.note ? `<div class="set-note" style="margin-top:10px">${esc(r.note)}</div>` : ''}`,
    );
    const b = $('#modal-save');
    if (b) {
      b.disabled = false;
      b.onclick = closeModal;
    }
    setModalSave('知道了', false);
  } catch (e) {
    const b = $('#modal-save');
    if (b) b.disabled = false;
    setModalSave('开始迁移', true);
    toast(e.message, true);
  }
}
