/**
 * mobile/views/more.js —— 「更多」页 + 「设置」页（两块界面都在这个文件里）
 *
 * 功能：手机版「更多 / 设置」两页的全部渲染与表单逻辑 ——
 *      `renderMore()` 画「更多」页：**底部放不下、又要「点进去用」的那几个模块入口**
 *      ＋ ⭐ 0.8.5 起末尾那块「**首页导航栏**」（挑哪几个模块摆到底部标签栏、长按 ⠿ 拖动排序；
 *      配套的 `navTabToggle()` / `saveNavTabs()` / `bindNavDrag()` 也在这个文件里）；
 *      `renderSettings()` 画「设置」页：**数据来源 / 模块功能 / 账号设置 / 备份与恢复 / 整体备份**
 *      （管理员另有「成员管理」），顺序与内容跟电脑版一一对应；
 *      `dataSectionHtml()`、`modulesSectionHtml()`、`acctSectionHtml()`、`adminSectionHtml()`、
 *      `backupSectionHtml()`、`orgSectionHtml()` 各渲染一块，`toggleSec()` 收起 / 展开某一块，
 *      `changeNameForm()`、`changePwForm()`、`memberAddForm()`、`memberRenameForm()`、`memberResetForm()`
 *      是五个底部弹层表单，
 *      `roleText()`、`initialOf()`、`lastLoginText()` 是账号信息的格式化小工具，
 *      `doLogout()` 负责退出登录，`ensureAdminData()` 负责管理员数据的按需加载。
 *
 * ⭐ **0.4.1 的两次改动（指令）**：
 *    ① 底部标签栏固定 6 个 —— 今天 / 任务板 / 项目 / 课表 / **更多** / **设置**
 *      （收藏夹与对话原来是各自的标签，现在搬进「更多」；「设置」此前占着内部 id `more`，界面上叫「设置」）；
 *      ⭐ 0.5.2 更新：项目删掉了，「对话」又升回底部标签顶替它的位置 —— 现在六颗是
 *      今天 / 任务板 / **对话** / 课表 / **更多** / **设置**，「更多」页剩三个入口；
 *    ② 设置页的分块顺序与内容**跟电脑版对齐**，并且**「模块功能」里每一行都带介绍 + 开关**。
 *    ⚠️ 所以「开关」与「入口」现在是**两处**，别合到一起：
 *       **设置 → 模块功能** = 要不要这个功能（每行一句介绍 + 一个开关）；
 *       **更多** = 进去用它（`进入 ›`）。
 *    ⚠️ 判据仍然是「这一行是开关还是入口」，只是入口从设置页搬到了「更多」。
 *    ⚠️ 折叠：`state.foldSecs`（只放内存、不落 localStorage），设置页各块都能折叠。
 *      ⭐ 0.5.5：**默认只有「数据来源」展开，其余一律收起**（
 *      「进入设置，除了数据来源展开，其余全部折叠」）—— 默认值住在 `isFolded()`，是**三态**
 *      （没动过 / 手动收起 / 手动展开），所以手点开的块不会在下次重画时自己收回去。
 *
 * ⭐ **0.5.0 模块化重构：这两块都不再手写「有哪几个模块」** ——
 *    改造成前是 `HUB_ITEMS`（四个入口）与 `MODULES`（五个开关）两张写死的表，所以删掉一个模块目录，
 *    入口与开关照样在（点了会 400）。现在两者都由「服务端 `bootstrap.modules` 清单 ×
 *    本端接线表 `mobile/modules.js`」生成，顺序取 `module.json` 的 `order`。
 *    ⚠️ 那一行点下去要做什么**不在这里**：`mobile/app.js` 的 `onAction()` 处理两个**通用动作**
 *    `mod-open`（切到那一屏）与 `mod-toggle`（翻这个模块的开关），模块名走 `data-mod`——
 *    「每加一个模块就多一个 case」正是这次重构要消灭的东西。
 *
 * ⭐ **0.8.1：记账数据迁移的入口挂在「整体备份」那一栏**（与「恢复整体备份」并排）——
 *    它与电脑版 `desktop/views/settings.js` 是同一条口径、同一套待遇（危险红行 ＋ 说明 ＋
 *    手打「迁移」二字），只是搬到手机端的底部弹层里（版式各写一份，**文案逐字一致**）。
 *    ⚠️ 和那边一样，⛔ 不新开一栏、⛔ 不并进「恢复整体备份」那颗：它动的是**文件的存放位置**
 *    （数据一条不少），不是「恢复」——并进去会让用户在两个后果之间点错。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.1
 * 相关：docs/公共/架构文档/04-多用户与账号.md、07-前端-电脑版与手机版.md、13-决策记录.md（决策 67 / 76）、
 *      docs/公共/开发方案/21-记账2期-记账.md（§7.6 /）
 */

import { api, BASE } from '../../core/api.js';
import { isBackupZip, orgCounts, readZipManifest } from '../../core/backup.js';
import { $, esc, formatBytes, skeletonHtml } from '../../core/dom.js';
import { MAX_NAV_TABS, entryOn, moduleItems, navTabItems, navTabsWire } from '../../core/modules.js';
// ⭐ 0.6.0：设置页是「模块贡献分块」的宿主—— 模块想在这里要一块配置页，
//    在本端接线表条目上声明 `settingsPane`（纯数据）+ `slots: ['settings-pane']`，
//    内容由 `core/slots.js` 动态挂载；本文件不 import 任何具体模块的片段。
//    ⚠️ 分块的标题与电脑版贡献分栏的 label 逐字一致。
import { mountModuleSlot, slotPaneDefs } from '../../core/slots.js';
import { loadAdminData, refresh } from '../data.js';
import { uiOf } from '../modules.js';
import { state } from '../state.js';
import { askConfirm, closeSheet, openSheet, secHeadFold, toast } from '../ui.js';

// ---------- 折叠：设置页各块的展开 / 收起 ----------
/**
 * 功能：设置页的某一块现在是不是收起的。
 *
 * 说明：⭐ 0.5.5（「进入设置，除了数据来源展开，其余全部折叠」）：
 *      改的是**默认值**，不是把映射反着存 —— 所以这里是**三态**：
 *        · `undefined` = 用户没动过这一块 ⇒ 按 `openByDefault` 走默认；
 *        · `true`  = 用户手动收起了；
 *        · `false` = 用户手动展开了。
 *      ⚠️ 为什么不能只把「收起的那些」记下来：那样用户**手点开**的块会在下一次重画
 *      （偏好提交 / 管理员数据到达都会触发）时又自己收回去 —— 那种「点了不管用」比默认展开更糟。
 *      ⚠️ `openByDefault` 必须**逐块显式传**：`state.foldSecs` 是**设置页与对话列表共用的一个对象**
 *      （对话那几块的 id 带 `teamwork-` 前缀，见 `modules/teamwork/mobile.js`），
 *      在这里写一条「除了某些 id 一律默认收起」的全局规则，会把对话那两块一起收掉。
 *
 * @param {string} id - 分块标识（`data` / `module` / `acct` / `admin` / `backup` / `org` / `slot-*`）
 * @param {boolean} [openByDefault] - 用户没动过时是否展开；缺省收起
 * @returns {boolean} 真 = 现在是收起的
 */
const isFolded = (id, openByDefault) => {
  const v = (state.foldSecs || {})[id];
  if (v === undefined) return !openByDefault;
  return v === true;
};

/**
 * 功能：给 `.sec` 拼上 `folded` 类 —— 收起时 CSS 只留标题行（`.sec >:not(.sec-head)`）。
 * @param {string} id - 分区标识
 * @param {boolean} [openByDefault] - 用户没动过时是否展开；缺省收起（见 `isFolded()` 的说明）
 * @returns {string} 拼进 class 属性的一段（展开时是空串）
 */
const foldCls = (id, openByDefault) => (isFolded(id, openByDefault) ? ' folded' : '');

/**
 * 功能：收起 / 展开设置页的某一块分区 —— 只改这一个节点的 class 与 `aria-expanded`，不整屏重画。
 *
 * 说明：⚠️ 这里**刻意就地改 DOM**，不调 `renderSettings()`：整屏重画会把滚动位置打回顶部，
 *      用户每收一块就被弹回页首，比不折叠还难用。状态写进 `state.foldSecs` 只是为了
 *      「偏好提交 / 管理员数据到达」触发的那些重画能保持住折叠状态。
 *      ⚠️ 取反要**以当前 DOM 的实际状态为准**，不能写 `!state.foldSecs[id]`：0.5.5 起有些分块
 *      **默认收起**（这时映射里是 `undefined`），拿映射取反会算出「还是收起」⇒ 用户永远点不开，
 *      而且不报任何错。DOM 上的 class 已经反映过默认值了，读它最准。
 *
 * @param {string} id - 分区标识，来自标题行按钮的 `data-sec`
 * @returns {void}
 */
export function toggleSec(id) {
  if (!id) return;
  const el = document.getElementById('sec-' + id);
  if (!el) return;
  const folded = !el.classList.contains('folded');
  state.foldSecs = state.foldSecs || {};
  state.foldSecs[id] = folded;
  el.classList.toggle('folded', folded);
  const head = el.querySelector('.sec-head');
  if (head) {
    head.classList.toggle('on', folded);
    head.setAttribute('aria-expanded', folded ? 'false' : 'true');
  }
}

// ---------- 渲染：账号设置 / 成员管理（设置页里的两块） ----------
/**
 * 功能：把用户对象翻译成中文角色名 —— 管理员或成员。
 * @param {?Object} u - 用户对象，按 `is_admin` 判断
 * @returns {string} '管理员' 或 '成员'
 */
export const roleText = (u) => (u && u.is_admin ? '管理员' : '成员');

/**
 * 功能：取头像上显示的首字 —— 优先显示名、其次用户名，取第一个字符，都没有则用 '?'。
 * @param {?Object} u - 用户对象
 * @returns {string} 一个字符，取不到时返回 '?'
 */
export const initialOf = (u) =>
  String((u && (u.display_name || u.username)) || '?')
    .trim()
    .slice(0, 1) || '?';

/**
 * 功能：把上次登录时间截短到分钟用于展示，没有记录时显示「从未登录」。
 * @param {?string} s - 服务端返回的登录时间字符串
 * @returns {string} 截短后的时间文本，或 '从未登录'
 */
export const lastLoginText = (s) => (s ? String(s).slice(0, 16) : '从未登录');

/**
 * 功能：渲染「账号设置」区块（与电脑版同名）—— 头像与昵称、修改用户名、修改密码与退出登录三个入口，
 *      末尾附一句数据可见性说明（自己是管理员时措辞不同）。
 *
 * 说明：⭐⭐ 第五轮（「设置中的首页导航栏移动到更多中」）：
 *      它原先末尾挂着「导航栏设置」那一段，现在**整段搬回「更多」页**（见 `navBoxHtml()`）
 *      ⇒ 这里只剩账号本身那几行，与电脑端的「账号设置」栏一一对应。
 *
 * @param {?Object} me - 当前登录用户对象；为空时返回空串
 * @returns {string} 该区块的 HTML 片段
 */
export function acctSectionHtml(me) {
  if (!me) return '';
  return `
    <div class="sec sec-card${foldCls('acct')}" id="sec-acct">
      ${secHeadFold('acct', '账号设置', '#0ea5e9', '', isFolded('acct'))}
      <div class="m-acct">
        <span class="m-ava">${esc(initialOf(me))}</span>
        <span class="m-acct-main">
          <b>${esc(me.display_name || me.username)}</b>
          <small>@${esc(me.username)} · ${roleText(me)}</small>
        </span>
      </div>
      <button class="mrow" type="button" data-act="change-name" style="width:100%;font:inherit;text-align:left;margin-top:9px">
        <span class="mtxt">修改用户名<small>改的是登录用的名字，旧名字立刻登不上</small></span>
      </button>
      <button class="mrow" type="button" data-act="change-pw" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">修改密码<small>改完其他设备上的登录会失效</small></span>
      </button>
      <button class="mrow" type="button" data-act="logout" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">退出登录<small>回到登录页，换别的账号</small></span>
      </button>
    </div>`;
}

/**
 * 功能：渲染「成员管理」区块（仅管理员）—— 自主注册开关、成员列表（头像 / 显示名 / 账号 / 角色 / 上次登录）
 *      与「添加成员」入口；自己那一行标「（我）」，每一行都有「改名」，管理员账号只不给重置密码与删除。
 *
 * 说明：成员列表**只显示账号元信息**，不显示任何任务数据与条数 ——
 *      按需求 2，管理员看不到成员的数据，连"有几条任务"都属于统计泄露。往这里加字段前先想清楚这一点。
 *      ⚠️ 0.2.1 起「改名」对**管理员账号也开放**（要改内置 `admin` 的名字）—— 它不踢会话、不动口令，
 *      没有「重置密码会把自己登出」那个坑，所以不必像重置密码那样挡在门外。
 *
 * @returns {string} 该区块的 HTML 片段；成员数据还没拿到时返回空串
 */
export function adminSectionHtml() {
  const users = state.members;
  const on = !!state.allowSelfRegister;
  const rows = (users || [])
    .map(
      (u) => `
      <div class="m-user">
        <span class="m-ava sm">${esc(initialOf(u))}</span>
        <span class="m-user-main">
          <b>${esc(u.display_name || u.username)}${u.id === state.memberMeId ? '（我）' : ''}</b>
          <small>@${esc(u.username)} · ${roleText(u)} · 上次登录 ${esc(lastLoginText(u.last_login_at))}</small>
        </span>
        <span class="m-user-acts">
          <button class="m-mini" type="button" data-act="member-rename" data-id="${u.id}">改名</button>
          ${
            u.is_admin
              ? ''
              : `<button class="m-mini" type="button" data-act="member-reset" data-id="${u.id}">重置密码</button>
                 <button class="m-mini danger" type="button" data-act="member-del" data-id="${u.id}">删除</button>`
          }
        </span>
      </div>`,
    )
    .join('');
  // ⭐⭐ 第三轮（「手机端有 13 个设置条目，比电脑端多，请对齐电脑端」）：
  //    「成员管理」与「整体备份」在**电脑端是同一栏**（「管理员设置」＝ 成员 ＋ 整体备份 ＋ 日志），
  //    手机端从前各占一块 ⇒ 总数比电脑端多两块。现在按电脑端合成一块：
  //    卡里第一段是成员账号，第二段（子标题「整体备份」）是那三颗危险动作。
  //    ⚠️ 成员数据还没到手时**整块照样要出来** —— 从前这一段是 `if (!users) return ''`
  //    （整块不渲染），合成之后那会把「整体备份」一起藏掉，而且两块之间会闪。
  return `
    <div class="sec sec-card${foldCls('admin')}" id="sec-admin">
      ${secHeadFold('admin', '管理员设置', '#4f46e5', '仅管理员', isFolded('admin'))}
      <div class="sec-sub">成员账号</div>
      <button class="mrow" type="button" data-act="reg-toggle" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">自主注册<small>${on ? '知道地址的人都能自己注册账号' : '只有管理员能添加成员'}</small></span>
        <span class="mval ${on ? 'on' : 'off'}">${on ? '已开启' : '已关闭'}</span>
      </button>
      <div class="m-users">${users ? rows : '<div class="mrow plain">正在读取成员…</div>'}</div>
      <button class="mrow" type="button" data-act="member-add" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">添加成员<small>设置用户名与初始密码，交给对方</small></span>
      </button>
      ${orgSectionHtml(true)}
    </div>`;
}

/**
 * 功能：从「各端最新版本」的响应里挑出飞牛那一条（没查过 / 查失败了都是 null）。
 *
 * 说明：⚠️ 判据只看**服务端算好的** `state` / `stateLabel` —— 「当前版本 > 服务器版本 = 测试版」
 *      这条口径只许有一份（`app/core/version-check.js` 的 `stateOf()`），前端⛔ 不自己比版本号。
 *      ⚠️ 与电脑端 `desktop/views/settings.js` 的同名函数是**同一份判据的两处渲染**：
 *      改口径改服务端那份，这里与那边都跟着变。
 *
 * @returns {?Object} 飞牛那一条 `{platform,label,version,publishedAt,state,stateLabel,listLabel}`；没有则 null
 */
function fnosVersionItem() {
  const v = state.versions;
  if (!v || !v.ok || !Array.isArray(v.items)) return null;
  return v.items.find((it) => it.platform === 'fnos') || null;
}

/**
 * 功能：「应用版本」后面那一小枚状态标 —— 比服务器新标「测试版」，服务器更新标「有新版本」。
 *
 * 说明：⭐ 0.9.1（口径）：「当前版本 > 服务器版本 则提示 测试版」。
 *      ⚠️ 这一颗**只挂在「应用版本」后面**，用 `stateLabel`。「各端最新版本」那四行用 `listLabel`
 *      —— 那里的版本号都来自服务器、已经发布过，不可能是测试版（口径修正）。
 *      ⚠️ 没检查过 / 读不到 / 不可比时什么都不标（⛔ 不写「未知」，那会让人以为版本有问题）。
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
 * 功能：渲染「各端最新版本」这一小段 —— 四行最新版本 ＋ 一颗「检查更新」。
 *
 * 说明：⭐⭐ **进页面不联网**（0.9.1）：许可协议 §四.2/3 写明「只有主动点『检查更新』才请求一次，
 *      不点就不通信」⇒ 这里只画状态，请求由 `app.js` 的动作表 `check-updates` 在点击时发出。
 *      ⚠️ 三种状态的话各不相同：**没查过**（引导去点）、**查失败**（说清是连不上，并声明不影响使用）、
 *      **有结果**（四行 ＋ 检查时刻）。⛔ 别把失败画成空白，那与「还没查」长得一样。
 *
 * @returns {string} 该小段的 HTML
 */
function versionBlockHtml() {
  const v = state.versions;
  const busy = !!state.versionsBusy;
  const btn = `<button class="btn sm" type="button" data-act="check-updates"${busy ? ' disabled' : ''}>${
    busy ? '检查中…' : '检查更新'
  }</button>`;
  let body;
  if (!v) {
    body = `<div class="ver-note">
        还没检查过。点「检查更新」向更新服务器要一次各端最新版本 —— 只发本机的版本号与平台，不发任何账号与数据。
      </div>`;
  } else if (!v.ok) {
    body = `<div class="ver-note ver-note-bad">暂时读不到：${esc(v.message || '连接失败')}。不影响使用，需要时再点一次。</div>`;
  } else {
    const rows = v.items
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
      .join('');
    body = `<dl class="kv">${rows}</dl>
      <div class="ver-note">检查于 ${esc(v.checkedAt || '—')}${
        v.fromCache ? '（10 分钟内再点不会重复联网）' : ''
      }</div>`;
  }
  return `
        <div class="ver-head" style="margin-top:12px"><b>各端最新版本</b>${btn}</div>
        ${body}`;
}

/**
 * 功能：渲染「数据来源」区块 —— 只读信息：应用版本、服务端口、数据存放方式（所有人），
 *      管理员另有数据目录（可复制）、数据文件与大小、读写方式、自动清理、数据结构版本、升级自动备份。
 *
 * 说明：⚠️ 浏览器打不开 NAS 上的文件夹，所以这里能做的仍然是「把路径摆清楚 + 一键复制」。
 *      ⭐ 0.4.1 起这一块把原来的「数据位置」与「数据来源」**合成一块**，与电脑版的「数据来源」栏一一对应
 *      （「设置中的顺序和内容与电脑端相同」）。
 *      ⚠️ 文案是给用户看的：用「数据存放方式 / 读写方式 / 自动清理」，不用「存储后端 / 日志模式 / 外键」。
 *      ⭐ 0.4.1（第四轮）：块名从「数据源」改成「**数据来源**」、标题行不再挂「只读」小标、
 *      末尾不再摆「备份数据文件夹就等于备份了全部数据…」那两句 —— 与电脑版逐字对齐。⚠️ 别再加回来。
 *
 * @returns {string} 该区块的 HTML 片段
 */
export function dataSectionHtml() {
  // ⚠️ 这一块**是全设置页唯一默认展开的**（见 `isFolded()` 的说明）—— 里面的版本 / 数据位置
  //    是用户进设置最常来看的东西，折叠它等于把答案藏起来。
  const h = state.health || {};
  const s = state.storage;
  const backend =
    h.backend === 'sqlite'
      ? '数据库文件（正常）'
      : h.backend === 'json'
        ? 'JSON 文件（数据库不可用时的备用方式）'
        : '未知';
  const warn = [];
  if (s && s.schemaUpgradeSkipped) {
    warn.push(`⚠️ 这次数据库升级被跳过了（你的数据一行都没动）：${esc(s.schemaUpgradeSkipped)}`);
  }
  if (s && (s.degraded || s.readOnly)) {
    warn.push(`⚠️ 应用现在是「只能看、不能改」的状态：${esc(s.initError || '原因未知')}`);
  }
  return `
    <div class="sec sec-card${foldCls('data', true)}" id="sec-data">
      ${secHeadFold('data', '版本数据', '#0ea5e9', '', isFolded('data', true))}
      <div class="card sec-flat">
        <dl class="kv">
          <dt>应用版本</dt><dd>v${esc(h.version || '—')}${versionBadgeHtml()}</dd>
          <dt>服务端口</dt><dd>${esc(h.port == null ? '—' : h.port)}</dd>
          <dt>数据存放方式</dt><dd>${backend}</dd>
          ${
            s
              ? `<dt>数据文件</dt><dd>${esc(s.dbName || '—')}${s.dbSize == null ? '' : ' · ' + formatBytes(s.dbSize)}</dd>
                 <dt>读写方式</dt><dd>${esc(
                   s.journalMode === 'wal'
                     ? '正常（读写并行，互不阻塞）'
                     : s.journalMode
                       ? '未开启（常见于网络共享盘）'
                       : '—',
                 )}</dd>
                 <dt>自动清理</dt><dd>${s.foreignKeys ? '已开启（删除项目时连它下面的任务一起清掉）' : '未开启'}</dd>
                 <dt>数据结构版本</dt><dd>v${esc(String(s.schemaVersion))}</dd>
                 <dt>升级自动备份</dt><dd>${
                   s.backupFiles && s.backupFiles.length ? `${s.backupFiles.length} 份` : '暂无'
                 }</dd>`
              : ''
          }
        </dl>
        ${
          // 数据目录只有管理员拿得到（`/api/admin/storage` 本身就要管理员权限）
          // ⭐ 0.5.5（「复制数据目录这个就一个按键【复制路径】即可」）：
          //    原先这里是「一整张卡片」—— 48px 图标 + 两行文案（复制数据目录 / 去飞牛「文件管理」
          //    里粘贴即可打开）+ 右侧一颗「复制」。现在压成**一行**：路径 + 一颗「复制路径」。
          //    ⚠️ 这不是新设计：**电脑端那一栏本来就是 `路径 + 「复制路径」按钮`**
          //    （`desktop/views/settings.js` 的 `.path-row`），手机端只是跟上。
          s
            ? `<div class="path-row">
                 <code class="path-box">${esc(s.dataDir || '—')}</code>
                 <button class="btn sm" type="button" data-act="copy-path">复制路径</button>
               </div>`
            : ''
        }
        ${warn.map((w) => `<div class="storage-warn">${w}</div>`).join('')}
        ${versionBlockHtml()}
      </div>
      <button class="mrow" type="button" data-act="refresh" style="width:100%;font:inherit;text-align:left;margin-top:9px">
        <span class="mtxt">重新读取数据</span>
        <span class="mval">刷新</span>
      </button>
      <div class="sec-note" style="margin-top:10px;line-height:1.6">
        数据都存在这台 NAS 上，每个账号各存各的。
      </div>
    </div>`;
}

/**
 * 功能：打开「修改密码」底部弹层（当前密码 / 新密码 / 再输一次），并把保存逻辑挂到 `state.sheetSave`：
 *      先校验新密码长度与两次输入是否一致，再提交修改，成功后关闭弹层并提示。
 *
 * 说明：改完之后其他设备上的登录会立即失效、这台手机不受影响，所以这里不重新登录。
 *
 * @returns {void}
 */
export function changePwForm() {
  openSheet(
    '修改密码',
    `<div class="field"><label>当前密码</label><input type="password" id="f-cur" autocomplete="current-password" /></div>
     <div class="field"><label>新密码（至少 6 位）</label><input type="password" id="f-new" autocomplete="new-password" /></div>
     <div class="field"><label>再输一次新密码</label><input type="password" id="f-new2" autocomplete="new-password" /></div>
     <div class="sec-note" style="line-height:1.6">改完之后，你在<b>其他设备</b>上的登录会立即失效；这台手机不受影响。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  /**
   * 功能：保存新密码 —— 校验长度与两次输入一致后提交给服务端，成功后关闭弹层并提示其他设备已下线。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    const n1 = $('#f-new').value;
    if (n1.length < 6) return toast('新密码至少 6 位', true);
    if (n1 !== $('#f-new2').value) return toast('两次输入的新密码不一致', true);
    await api('POST', '/api/auth/password', { current: $('#f-cur').value, next: n1 });
    closeSheet();
    toast('密码已修改，其他设备已下线');
  };
}

/**
 * 功能：打开「添加成员」底部弹层（用户名 / 显示名 / 初始密码），并把创建逻辑挂到 `state.sheetSave`：
 *      创建成功后关闭弹层、刷新数据，并提示新成员的用户名。
 *
 * 说明：初始密码在弹层里明文显示，方便管理员抄给成员 —— 这是刻意的交付方式，不是疏漏。
 *
 * @returns {void}
 */
export function memberAddForm() {
  openSheet(
    '添加成员',
    `<div class="field"><label>用户名 *（登录用）</label>
       <input type="text" id="f-m-name" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="中文、字母、数字、下划线、点、@ 或减号" /></div>
     <div class="field"><label>显示名</label><input type="text" id="f-m-disp" placeholder="可选，界面上显示的名字" /></div>
     <div class="field"><label>初始密码 *（至少 6 位）</label>
       <input type="text" id="f-m-pw" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
     <div class="sec-note" style="line-height:1.6">初始密码在这里明文显示，方便你抄给成员 —— 请私下告诉他；他登录后可以在「设置 → 账号设置」里自己改。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">创建</button>`,
  );
  /**
   * 功能：创建成员 —— 把用户名、显示名与初始密码提交给管理员接口，成功后关闭弹层、刷新数据并提示用户名。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    const u = await api('POST', '/api/admin/users', {
      username: $('#f-m-name').value,
      displayName: $('#f-m-disp').value,
      password: $('#f-m-pw').value,
    });
    closeSheet();
    await refresh();
    toast('已添加成员「' + u.username + '」');
  };
}

/**
 * 功能：打开「重置密码」底部弹层（标题带上目标用户名），并把重置逻辑挂到 `state.sheetSave`：
 *      调用管理员接口写入新密码，成功后关闭弹层并提示。
 *
 * 说明：重置后对方所有设备上的登录会立即失效，原密码无法查看也无法找回。
 *
 * @param {number} id - 目标成员的账号 id；在 `state.members` 里找不到该 id 时直接返回、不弹层
 * @returns {void}
 */
export function memberResetForm(id) {
  const u = (state.members || []).find((x) => x.id === id);
  if (!u) return;
  openSheet(
    '重置密码 · ' + u.username,
    `<div class="field"><label>新密码 *（至少 6 位）</label>
       <input type="text" id="f-r-pw" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
     <div class="sec-note" style="line-height:1.6">重置后，「${esc(
       u.username,
     )}」所有设备上的登录会立即失效，需要用新密码重新登录。原密码无法查看、也无法找回。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">重置</button>`,
  );
  /**
   * 功能：重置成员密码 —— 把新密码提交给管理员接口，成功后关闭弹层并提示目标用户名。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    await api('POST', '/api/admin/users/' + id + '/password', { password: $('#f-r-pw').value });
    closeSheet();
    toast('已重置「' + u.username + '」的密码');
  };
}

/**
 * 功能：打开「修改用户名」底部弹层（改的是**登录用**的名字），并把保存逻辑挂到 `state.sheetSave`：
 *      提交 `PUT /api/auth/username`，成功后刷新整页（头像旁的名字、成员列表里自己的那一行都要跟着变）。
 *
 * 说明：⚠️ 与改密码**恰好相反** —— 改名不踢会话，这台手机和其他设备都**继续在线**；
 *      但改完**旧名字立刻登不上**，这就是「改登录名」本身的含义。所以提示里两件事都要说清。
 * ⚠️ 校验只在服务端做（长度 / 字符集 / 重名），这里只挡「空」，免得两个口径漂移。
 *
 * @returns {void}
 */
export function changeNameForm() {
  const me = state.me || {};
  openSheet(
    '修改用户名',
    `<div class="field"><label>用户名（登录用）</label>
       <input type="text" id="f-n-name" autocapitalize="off" autocorrect="off" spellcheck="false"
              value="${esc(me.username || '')}" placeholder="中文、字母、数字、下划线、点、@ 或减号" /></div>
     <div class="sec-note" style="line-height:1.6">你现在用的是 <b>@${esc(
       me.username || '',
     )}</b>。改完<b>旧名字立刻不能登录</b>，要用新名字登；已经登录的设备<b>不会被踢下线</b>。最多 32 位。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  /**
   * 功能：提交新用户名 —— 成功后关闭弹层并整页刷新（名字出现在设置页与成员列表两处）。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    const name = $('#f-n-name').value.trim();
    if (!name) return toast('请输入用户名', true);
    await api('PUT', '/api/auth/username', { username: name });
    closeSheet();
    await refresh({ toast: '用户名已改为「' + name + '」' });
  };
}

/**
 * 功能：打开「改名」底部弹层（标题带上目标账号当前用户名），并把保存逻辑挂到 `state.sheetSave`：
 *      提交 `PUT /api/admin/users/<id>/username`，成功后关闭弹层并刷新成员列表。
 *
 * 说明：⚠️ 管理员**自己的账号也能改**（内置 `admin` 改名就是主要用例）—— 改名不踢会话、不动口令，
 *      没有「重置密码会把自己登出」那个坑，所以这里不做「不能改管理员」的限制。
 *
 * @param {number} id - 目标账号 id；在 `state.members` 里找不到该 id 时直接返回、不弹层
 * @returns {void}
 */
export function memberRenameForm(id) {
  const u = (state.members || []).find((x) => x.id === id);
  if (!u) return;
  openSheet(
    '修改用户名 · ' + u.username,
    `<div class="field"><label>用户名 *（登录用）</label>
       <input type="text" id="f-rn-name" autocapitalize="off" autocorrect="off" spellcheck="false"
              value="${esc(u.username)}" placeholder="中文、字母、数字、下划线、点、@ 或减号" /></div>
     <div class="sec-note" style="line-height:1.6">改完「${esc(
       u.username,
     )}」<b>旧名字立刻不能登录</b>，要用新名字登；他当前已登录的设备<b>不会被踢下线</b>。
     也可以让他自己在「设置 → 账号设置」里改。最多 32 位。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  /**
   * 功能：提交新用户名 —— 成功后关闭弹层并刷新成员列表。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    const name = $('#f-rn-name').value.trim();
    if (!name) return toast('请输入用户名', true);
    await api('PUT', '/api/admin/users/' + id + '/username', { username: name });
    closeSheet();
    await refresh({ toast: '已改名为「' + name + '」' });
  };
}

// ---------- 账号设置 / 成员管理（手机版；与电脑版同一套接口） ----------
/**
 * 功能：退出登录 —— 先弹确认，确认后调用登出接口，最后跳回登录页。
 *
 * 说明：登出接口报错也照样跳登录页（本来就已经掉线的情况无需区分），所以这里把异常吞掉。
 *
 * @returns {Promise.<void>}
 */
export async function doLogout() {
  const yes = await askConfirm({
    title: '退出登录',
    text: '退出后需要重新输入密码才能进来。确定吗？',
    ok: '退出登录',
  });
  if (!yes) return;
  try {
    await api('POST', '/api/auth/logout');
  } catch (_e) {
    /* 本来就已经掉线了也无所谓，照样回登录页 */
  }
  location.href = BASE + '/login.html';
}

/**
 * 功能：渲染手机版「更多」页 —— 底部放不下、又要「点进去用」的那几个模块的入口
 *      （⭐ 0.8.10 起是：网址收藏夹 / 个人资产管理 / 数码管理 / 生活记账 / 番茄钟 / 行程，
 *      随清单增减 —— 行本身是画出来的，⛔ 这里不写死）。
 *
 * 说明：⭐ 0.4.1（指令）：底部固定 6 个标签（今天 / 任务板 / 项目 / 课表 / 更多 / 设置），
 *      收藏夹与对话原来是各自的底部标签，现在和数码管理 / 密码库一样**收进这里**。
 *      ⭐ 0.5.2 更新：项目删掉了，「对话」又升回底部标签顶替它的位置 ——「更多」页剩三个入口。
 *      ⚠️ 这里**只是入口**：每个功能的开关在「设置 → 模块功能」里（两处各司其职，别合到一起）。
 *      ⭐ 0.5.0 模块化重构：这一页的行**不再手写**——由「服务端 `bootstrap.modules` 清单 ×
 *      本端接线表 `mobile/modules.js`」生成（`hub` 那一段），顺序取 `module.json` 的 `order`。
 *      ⇒ 删掉 `app/modules/<模块>/` 目录，这一页就少一行。
 *      ⚠️ 某个功能被自己的开关关掉时，它这一行**不渲染**（`moduleItems()` 已经算好 `on`）；
 *      ⚠️ 清单还没到手（首屏第一个请求回来之前）时给骨架屏，**不能说「都被关掉了」**——
 *      那会把「还没读到」说成「你关掉了」。
 *
 * @returns {void}
 */
/**
 * 功能：「点进去用」的模块入口行（`hub`）—— ⭐ **只列底部导航栏上没有的那些**。
 *
 * 说明：⭐⭐ 第五轮（「更多：模块进入（注意这里只显示导航栏**没有的**，
 *      在导航栏的不要显示）」）—— 这句话把这一页的定位钉死了：
 *      「更多」是**底栏放不下的那些功能的去处**，不是一份全量目录。
 *      ⚠️ 因此**摆在底栏上的模块不在这里重复出现**（它们点底栏就能进，这里再列一遍
 *      等于同一件事两个门）。判据就是 `navTabItems()` 那一份（⛔ 不另拼一套名字比对）。
 *      ⚠️ 一个入口都没有（全被关掉 / 全摆在底栏）时给一句能照着做的话 —— ⛔ 不能说成「还没读到」。
 * @returns {string} 入口行 HTML
 */
function hubRowsHtml() {
  const me = state.me || {};
  const items = moduleItems(state.modules, uiOf, me);
  const hub = items.filter((it) => it.hub);
  // ⭐ 0.8.32：判据从 `it.on` 换成 `entryOn()`（与电脑端 / 底部标签同一份）——
  //    纯屏模块（网址/密码夹、个人资产管理）的两个子模块**都关掉**时，它这一行也不出现。
  // ⭐⭐ 第五轮：**已经在底栏上的模块不重复列**（判据与底栏同一份 `navTabItems()`）。
  const onBar = new Set(navTabItems(items, me).map((it) => it.name));
  const rows = hub.filter((it) => entryOn(it, items) && !onBar.has(it.name));
  if (!rows.length) {
    // 两种「空」要分开说：全是关掉的（去打开）／全在底栏上（没有剩余的可列）。
    const offCount = hub.filter((it) => !entryOn(it, items)).length;
    if (hub.length && offCount === hub.length) {
      return `<div class="mrow plain">全部 ${hub.length} 个功能都被关掉了 —— 想用的话去「设置」里打开。</div>`;
    }
    return `<div class="mrow plain">能进的功能都已经摆到底部导航栏上了 —— 想换别的，在下面「导航栏」里调。</div>`;
  }
  return rows
    .map(
      (
        it,
      ) => `<button class="mrow" type="button" data-act="mod-open" data-mod="${esc(it.name)}" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">${esc(it.title)}<small>${esc(it.hub.sub || '')}</small></span>
        <span class="mval">进入 ›</span>
      </button>`,
    )
    .join('');
}

/**
 * 功能：「更多」页里的「**导航栏**」那一块（挑哪几个模块摆到底部标签栏 ＋ 长按拖动排序）。
 *
 * 说明：⭐⭐ 第五轮（「设置中的首页导航栏移动到更多中」）——
 *      它从前并进设置页的「账号设置」卡里（一段），现在**搬回「更多」页、单独一块**：
 *      「更多」管的是「进哪个功能 / 底栏摆哪些」，设置管的是「这个功能怎么配」，
 *      两者本来就是两件事。
 *      ⚠️ 实现只有一份（`hubRowsHtml()` / `navSectionHtml()`），⛔ 别在设置页再留一份。
 *
 * @param {Object} me - 当前登录账号
 * @returns {string} 该块的 HTML
 */
function navBoxHtml(me) {
  if (!state.modules) return '';
  return navSectionHtml(me);
}

/**
 * 功能：「更多」那一页 —— ⭐⭐ 第五轮起它**重新是底栏的一颗**（0.8.30 撤掉了「设置」那颗，
 *      改叫「更多」），内容按排成三块，**顺序即优先级**：
 *
 *      ① **模块进入** —— ⚠️ **只列底部导航栏上没有的那些**（「注意这里只显示导航栏没有的，
 *         在导航栏的不要显示」）；判据就是 `navTabItems()` 那一份（`hubRowsHtml()` 里做的）。
 *      ② **设置** —— 11 栏的全部配置（底栏放不下，所以从这儿进）。
 *      ③ **关于我们 / 联系与反馈** —— ⭐ 0.9.1：两张卡，点开是从底部升起的抽屉
 *         （内容与电脑版侧栏底部那两颗按钮**共用一份**，见 `core/about.js`）。
 *      ④ **导航栏** —— 挑哪几个模块摆到底栏、长按 ⠿ 排序（⭐ 本轮从设置页搬回来，
 *         「设置中的首页导航栏移动到更多中」）。
 *
 * 说明：⚠️ ②③ 各自是一张卡、① 是一列入口行 —— 三层都是「点一下就去某处」，没有开关，
 *      开关全在「设置 → 各模块那一栏」里。
 *      ⚠️ `id="navset"` 全文档**只能有一个**（`navRowsOf()` 按它算拖拽落点）——
 *      搬回来之后设置页那一段已经撤了，⛔ 别在那边再加一份。
 * @returns {void}
 */
export function renderMore() {
  const el = $('#view-more');
  if (!el) return;
  if (!state.modules) {
    el.innerHTML = skeletonHtml(4);
    return;
  }
  const me = state.me || {};
  // ⚠️ 这一屏**不画屏内大标题**：顶栏已经写着「更多 ＋ 模块进入 · 设置 · 导航栏」，
  //    再来一条「更多」就是同一句话说两遍（设置页那条要留 —— 那一屏长，需要它当路标；
  //    这一屏三张卡就到底了，不需要）。
  el.innerHTML = `
    <div class="sec sec-card">
      <div class="sec-head"><span class="sec-title">模块进入</span></div>
      ${hubRowsHtml()}
    </div>
    <div class="sec sec-card">
 <!-- ⭐⭐ 0.8.30：**「设置」是这一页里的一张卡** ——
           底栏那颗从「设置」改叫「更多」之后，设置就统一从这儿进。
           ⚠️ 动作复用通用的 dash-goto（app.js 的 onAction 里那条就是 switchTab），
           ⛔ 不新造第二条切屏通路（本文件反向 import app.js 会成静态环）。
           ⚠️⚠️ 这段 HTML 注释住在**模板串里面** ⇒ 里面⛔一个反引号都不能写（会截断整个串）。 -->
      <button class="mrow" type="button" data-act="dash-goto" data-tab="settings" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">设置<small>版本数据 · 账号 · 备份 · 每个模块的开关</small></span>
        <span class="mval">进入 ›</span>
      </button>
    </div>
    <div class="sec sec-card">
 <!-- ⭐ 0.9.1：与电脑版侧栏底部那两颗「关于我们 / 联系与反馈」是**同一件事的两处入口**
           （老大指定：手机端放这里，两个卡片）。内容两端共用 core/about.js，
           所以这里只管动作名，⛔ 不许在这一页把文案再写一遍。
           ⚠️⚠️ 这段注释住在模板串里面 ⇒ 里面⛔一个反引号都不能写（会截断整个串）。 -->
      <button class="mrow" type="button" data-act="about" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">关于我们<small>各平台介绍 · 官网与下载 · 打赏</small></span>
        <span class="mval">查看 ›</span>
      </button>
    </div>
    <div class="sec sec-card">
      <button class="mrow" type="button" data-act="contact" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">联系与反馈<small>交流群 · 问题反馈</small></span>
        <span class="mval">查看 ›</span>
      </button>
    </div>
    ${navBoxHtml(me)}`;
  // ⭐ 0.8.5：导航栏那一块的**长按拖动**（幂等，挂在常驻的 `#view-more` 上 —— 内容每次重画都换节点）
  bindNavDrag();
}

// ---------- ⭐ 0.8.5 首页导航栏（底部标签栏放哪几个模块、什么顺序） ----------
/**
 * 功能：由宿主（`mobile/app.js`）注入的「导航偏好变了」回调 —— 用来重画**底部标签栏**。
 *
 * 说明：⭐ 为什么不直接 `import { applyPrefsVisibility } from '../app.js'`：
 *      `app.js` 静态 import 本文件（要它的 `renderMore` / `renderSettings`），
 *      反向再来一条边就成了**静态环** —— 本项目一向避免它（同款理由见 `desktop/modules.js`
 *      的文件头、`desktop/shell.js` 里 `refreshHome()` 那一段）。注入的写法有先例：
 *      `core/api.js` 的 `setNotifier()` 就是宿主注入的通知器。
 *
 * @type {?Function}
 */
let onNavChanged = null;

/**
 * 功能：注册「导航偏好变了」的回调（宿主在初始化时调一次）。
 * @param {Function} fn - 回调（宿主传的是 `applyPrefsVisibility`）
 * @returns {void}
 */
export function setNavChangedHandler(fn) {
  onNavChanged = typeof fn === 'function' ? fn : null;
}

/** 正在拖的那一行（null = 没在拖） @type {?HTMLElement} */
let navDragRow = null;
/** 当前落点（拖到它身上） @type {?HTMLElement} */
let navDragOver = null;
/** 刚拖完那一小段时间内，把随之而来的 click 吞掉（时间戳） @type {number} */
let navSwallowUntil = 0;

/**
 * 功能：渲染「首页导航栏」那一块 —— 挑哪几个模块摆到底部标签栏、什么顺序（0.8.5）。
 *
 * 说明：⭐ 「手机端在更多中设置首页导航栏显示的东西和排序（今天不能移动和不显示）」——
 *      · **今天**（以及任务板 / 更多 / 设置）是底栏的固定四颗，压根不在这一块里 ⇒ 移不动、也藏不掉；
 *      · 这一块只调**模块标签**：挑中的（最多 `MAX_NAV_TABS` 个）排在上面、带拖拽柄，
 *        其余模块排在下面，点一下就能换进换出。
 *      ⚠️ 顺序就是 `navTabItems()` 给的那个数组的先后（库里存的 `nav_tabs` 顺序）；
 *      ⛔ 别在这里另排一份 —— 那会和底栏画出来的顺序对不上。
 *
 * @param {?Object} me - 当前登录账号（读它的 `nav_tabs`）
 * @returns {string} 这一块的 HTML；清单还没到手 / 一个带 `tab` 能力的模块都没有时回空串
 */
function navSectionHtml(me) {
  if (!state.modules) return '';
  const items = moduleItems(state.modules, uiOf, me || {});
  // ⭐⭐ 0.8.19 任务七**残留**：「协作**不能自定义**，必须显示在导航栏」——
  //    它是**固定档**（接线表里的 `tab.fixed`）⇒ **不进这张可选清单**（底栏上永远有它，
  //    没什么可挑的），也不参与拖动排序。清单里只剩「今天 / 任务 / 设置」之外的可选模块。
  const tabs = items.filter((it) => it.tab && !it.tab.fixed);
  const fixed = items.filter((it) => it.tab && it.tab.fixed);
  if (!tabs.length) return '';
  const picked = navTabItems(items, me || {}).filter((it) => !it.tab.fixed);
  const pickedNames = new Set(picked.map((it) => it.name));
  const rows = [
    ...picked.map((it, i) => navRowHtml(it, true, i + 1)),
    ...tabs.filter((it) => !pickedNames.has(it.name)).map((it) => navRowHtml(it, false, 0)),
  ].join('');
  const fixedNote = fixed.length
    ? `${fixed.map((it) => `「${it.tab.name || it.title}」`).join('')}固定在底栏上，不能取消；`
    : '';
  return `
    <div class="sec sec-card">
      <div class="sec-head"><span class="sec-title">导航栏</span></div>
      <div class="navset-tip">
        ${fixedNote}底部导航栏另固定「今天 / 任务 / 更多」三颗；下面点中的会插在它们后面，最多 ${MAX_NAV_TABS} 个。长按 ⠿ 换顺序。
      </div>
      <div class="navset" id="navset">${rows}</div>
    </div>`;
}

/**
 * 功能：画「首页导航栏」里的一行 —— 图标 + 名字 + 序号（或空位）。
 *
 * 说明：⚠️ 只有**已挑中**的行带拖拽柄（`data-handle`），且那颗柄带静态 `touch-action: none`
 *      （见 `app.css`）—— 这是拖动能不能跟手的关键，见 `bindNavDrag()` 里的说明。
 *      ⚠️ 整行是一颗 `<button data-act="navtab-toggle">`：点它 = 上底栏 / 下底栏。
 *
 * @param {Object} it - 入口项（`moduleItems()` 的产物，带 `tab`）
 * @param {boolean} on - 是不是已经摆在底栏上
 * @param {number} seq - 摆在底栏时的序号（1 起）；没摆时传 0
 * @returns {string} 一行的 HTML
 */
function navRowHtml(it, on, seq) {
  return `
    <button class="navset-row${on ? ' on' : ''}" type="button" data-act="navtab-toggle" data-mod="${esc(it.name)}">
      ${
        on
          ? '<span class="navset-handle" data-handle="1" aria-hidden="true">⠿</span>'
          : '<span class="navset-handle off" aria-hidden="true"></span>'
      }
      
      <span class="navset-name">${esc(it.tab.name || it.title)}</span>
      <span class="navset-badge">${on ? String(seq) : ''}</span>
    </button>`;
}

/**
 * 功能：把底栏的模块名单提交给服务端，然后重画底栏与这一页。
 *
 * 说明：⭐ 只发 `mobile` 这一个键（`PUT /api/auth/nav` 是「带哪个键改哪个键」）——
 *      电脑端侧栏那份 `nav_order` 绝不能被这一下顺手覆盖。
 *      ⚠️ `[]`（空数组）是**合法值**：用户就是可以一个模块标签都不摆（服务端会落成空串，
 *      与「从没排过」的 NULL 是两回事 —— 见 `core/modules.js` 的 `navTabItems()`）。
 *      ⚠️ 成功失败都重画：失败时这一下正好把界面拉回服务端的真相。
 *
 * @param {Array.<string>} names - 新的模块名单（顺序即标签顺序）
 * @returns {Promise.<void>}
 */
async function saveNavTabs(names) {
  try {
    // ⚠️ 0.8.19 任务七：必须走 `navTabsWire()` 带上版本前缀，否则读侧把这次的结果当老格式作废
    //    —— 表现是「在导航栏设置里改完，底栏一点没变」（而且不报错）。
    const r = await api('PUT', '/api/auth/nav', { mobile: navTabsWire(names) });
    if (r && r.user) state.me = r.user;
  } catch (e) {
    toast(e.message, true);
  }
  if (onNavChanged) onNavChanged(); // 宿主的 applyPrefsVisibility：底栏按新偏好重画
  // ⭐⭐ 第五轮（「设置中的首页导航栏移动到更多中」）：`#navset` 现在住在
  //    **「更多」页**（`renderMore()`）⇒ 这一句必须跟着搬回来。⛔ 别留成 `renderSettings()`：
  //    那样用户点一下某个模块，底栏变了、而眼前这一页那张清单纹丝不动（勾选态、序号、
  //    拖拽柄全不更新，看着像「点了没用」，其实已经生效）—— 0.8.19 就是这么踩过一次。
  if (state.tab === 'more') renderMore();
  // ⚠️ 设置页那边已经**没有**导航栏那一段了（本轮搬走），但它有「每栏进入」的行，
  //    顺序/显隐与底栏无关 ⇒ 不必重画。⚠️ 万一将来又把它放回去，这里要跟着补一句。
  else renderSettings();
}

/**
 * 功能：点一下「首页导航栏」里的一行 —— 在底栏上就移出，不在就加进去。
 * @param {string} name - 模块名
 * @returns {Promise.<void>}
 */
export async function navTabToggle(name) {
  const items = moduleItems(state.modules, uiOf, state.me || {});
  // ⭐ 0.8.19 任务七残留：「协作」固定在底栏 ⇒ 它压根不出现在那张清单里。这一行是**双保险**
  //    （手改接口、或别的入口残留也拦得住）。
  const hit = items.find((x) => x.name === name);
  if (hit && hit.tab && hit.tab.fixed) return toast('「协作」固定在底栏上，不能取消', true);
  const names = navTabItems(items, state.me || {})
    .filter((it) => !it.tab.fixed)
    .map((it) => it.name);
  const i = names.indexOf(name);
  if (i >= 0) {
    names.splice(i, 1);
  } else {
    if (names.length >= MAX_NAV_TABS) {
      return toast(`底部最多放 ${MAX_NAV_TABS} 个模块 —— 先移出一个再换`, true);
    }
    names.push(name);
  }
  await saveNavTabs(names);
}

/**
 * 功能：给「首页导航栏」那一块挂上**长按拖拽换位**（幂等，一次）。
 *
 * 说明：⚠️⭐ 只认那颗**常驻的拖拽柄**（`[data-handle]`，带静态 `touch-action: none`），
 *      ⛔ 不认行体：浏览器在**手势开始那一刻**就定好了这一趟能不能滚，按在行体上拖
 *      会被判成滚动、派发 `pointercancel` 把拖动打断（表现是「一滑就停」）。
 *      这是本项目在记账那一屏踩过并定下来的定式（`modules/ledger/mobile.js`）。
 *      ⚠️ 于是这里**不需要「先进排序模式再出柄」**那一步：柄本来就在（列表最多两行，
 *      常驻一颗柄不碍事），手势一开始就是 `touch-action: none` 的元素。
 *      ⚠️ 松手后浏览器可能补一次 click（落在按钮上 = 切换）⇒ 用 `navSwallowUntil` 吞掉。
 *
 * @returns {void}
 */
function bindNavDrag() {
  // ⚠️⭐ 第五轮（「设置中的首页导航栏移动到更多中」）：`#navset` 又回到
  //    **「更多」页**了 ⇒ 两个容器照旧各挂一次（幂等、挂过的用 `dataset.navDrag` 记住）。
  //    ⚠️ 两个都留着是刻意的：设置页那边虽然已经**没有**导航栏那一段，但这段委托是**幂等**的，
  //    多挂一个空容器零成本；将来谁再把清单挪回去，拖拽不会「完全没反应、也不报错」。
  ['#view-more', '#view-settings'].forEach(bindNavDragOn);
}

/**
 * 功能：给**一个**常驻容器挂上导航栏的拖拽（0.8.16 拆出来的 —— 原来只有「更多」那一屏用）。
 * @param {string} sel - 容器选择器（`'#view-more'` / `'#view-settings'`）
 * @returns {void}
 */
function bindNavDragOn(sel) {
  const box = $(sel);
  if (!box || box.dataset.navDrag === '1') return;
  box.dataset.navDrag = '1';
  box.addEventListener('pointerdown', (e) => {
    const h = e.target.closest ? e.target.closest('[data-handle]') : null;
    if (!h) return;
    const row = h.closest('.navset-row');
    if (!row) return;
    // 指针捕获：手指滑出柄的范围后事件照样回它这儿（不捕获时中途会断）
    if (h.setPointerCapture) {
      try {
        h.setPointerCapture(e.pointerId);
      } catch (_e) {
        /* 个别环境不支持 pointerId 捕获：不影响（document 那层监听还在） */
      }
    }
    startNavDrag(row);
  });
  // ⚠️ 捕获阶段拦「刚拖完那一下点击」：宿主的动作表挂在 `#app` 上走**冒泡**，在内层拦住最省事
  box.addEventListener(
    'click',
    (e) => {
      if (Date.now() < navSwallowUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

/** 功能：当前摆在底栏上的那几行（按 DOM 次序）。 @returns {Array.<HTMLElement>} 行元素数组 */
function navRowsOf() {
  const box = $('#navset');
  return box ? [...box.querySelectorAll('.navset-row.on')] : [];
}

/**
 * 功能：开始拖某一行 —— 加拖动态、临时挂 document 级监听（松手就摘）。
 * @param {HTMLElement} row - 被拖动的那一行
 * @returns {void}
 */
function startNavDrag(row) {
  navDragRow = row;
  navDragOver = null;
  row.classList.add('navset-drag');
  document.body.classList.add('navset-sorting');
  // ⚠️ `passive: false` 是必需的：拖动时要 `preventDefault()` 把页面滚动按住
  document.addEventListener('pointermove', onNavDragMove, { passive: false });
  document.addEventListener('pointerup', endNavDrag);
  document.addEventListener('pointercancel', endNavDrag);
}

/**
 * 功能：手指移动 ⇒ 换落点提示（只改提示，**真的换位在松手时一次做完**）。
 * @param {PointerEvent} e - 移动事件
 * @returns {void}
 */
function onNavDragMove(e) {
  if (!navDragRow) return;
  e.preventDefault();
  let over = null;
  for (const el of navRowsOf()) {
    if (el === navDragRow) continue;
    const r = el.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      over = el;
      break;
    }
  }
  if (over !== navDragOver) {
    if (navDragOver) navDragOver.classList.remove('navset-drop');
    navDragOver = over;
    if (over) over.classList.add('navset-drop');
  }
}

/**
 * 功能：松手 —— 收尾、必要时提交新顺序。
 * @returns {Promise.<void>}
 */
async function endNavDrag() {
  document.removeEventListener('pointermove', onNavDragMove);
  document.removeEventListener('pointerup', endNavDrag);
  document.removeEventListener('pointercancel', endNavDrag);
  document.body.classList.remove('navset-sorting');
  const d = navDragRow;
  const o = navDragOver;
  navDragRow = null;
  navDragOver = null;
  if (d) d.classList.remove('navset-drag');
  if (o) o.classList.remove('navset-drop');
  if (!d || !o) return;
  const rows = navRowsOf();
  const from = rows.indexOf(d);
  const to = rows.indexOf(o);
  if (from < 0 || to < 0 || from === to) return;
  rows.splice(to, 0, rows.splice(from, 1)[0]);
  navSwallowUntil = Date.now() + 500;
  await saveNavTabs(rows.map((r) => r.dataset.mod));
}

/**
 * 功能：渲染「模块功能」区块 —— **按清单**给每个可关的模块画一行：图标 + 名字 + **介绍** + 开关状态。
 *
 * 说明：⭐ 是「对各个模块功能做具体介绍和开关」，所以**介绍与开关必须在同一行里**：
 *      只看名字不知道它是干什么的（这一块以前只有一句「已开启 / 已关闭」）。
 *      ⭐ 0.5.0 模块化重构：这一块以前是手写的五条（`const MODULES = [...]`），所以删掉一个模块目录、
 *      行照样在（点了开关会 400）。现在按「清单 × 本端接线表」生成 —— 清单里少一个模块这里就少一行。
 *      ⚠️ 点整行就是翻开关，动作是**通用动作** `mod-toggle` + `data-mod`（见 `app.js` 的 `onAction`）：
 *      **点了就生效**：不弹确认层、也不弹轻提示（指令），
 *      行上那个「已开启 / 已关闭」就是唯一的反馈。
 *      ⚠️ 名字优先取接线表、没写就回落 `module.json` 的 `title`（`moduleItems()` 已经算好）。
 *
 * @param {?Object} me - 当前登录账号（`moduleItems()` 读它的 `hide_*` 决定每行显示「已开启 / 已关闭」）
 * @returns {string} 该区块的 HTML 片段
 */
/**
 * 功能：把**一批模块条目**画成开关行（介绍 ＋ 安全提醒 ＋ 三支：普通 / 带子开关 / 带「设置」键）。
 *
 * 说明：⭐ 0.8.30（「全局设置改造」）：它原来叫 `modulesSectionHtml()`，
 *      画的是**一整栏「模块功能」**；现在开关下放到各模块自己那一栏（`moduleSectionHtml()`），
 *      所以这里退回「只出行」—— ⛔ 别再给它套 `sec` 外壳。
 *
 * @param {Array.<Object>} list - `moduleItems()` 的条目（只画带 `card` 的那些）
 * @returns {string} 各行 HTML
 */
function modRowsHtml(list) {
  return list
    .filter((it) => it.card)
    .map((it) => {
      // 两段：功能行 +（有的话）安全提醒 —— 课表与收藏夹没有安全提醒，那一行就不渲染
      const tip = it.card.tip ? `<br /><b>${esc(it.card.tip)}</b>` : '';
      // ⭐⭐ 0.8.13：带**子开关清单**的模块（目前只有 `time`「番茄钟与日程表」）
      //    ⇒ 这一行下面再铺 **N 行**，每行各自翻**自己那一个键**（⛔ 绝不一次提交两个）。
      //    ⚠️ 外层**不能再用 `<button>`**（里面还有按钮 ⇒ HTML 不允许嵌套按钮，点了会串）。
      if (Array.isArray(it.subs) && it.subs.length) {
        const subs = it.subs
          .map(
            (s) => `<button class="mrow msubrow" type="button" data-act="mod-sub" data-key="${esc(
              s.prefsKey,
            )}" data-field="${esc(s.field)}" style="width:100%;font:inherit;text-align:left">
          <span class="mtxt">${esc(s.label)}</span>
          <span class="mval ${s.on ? 'on' : 'off'}">${s.on ? '已开启' : '已关闭'}</span>
        </button>`,
          )
          .join('');
        return `<div class="mrow msub">
          <span class="mtxt">${esc(it.title)}<small>${esc(it.card.desc)}${tip}</small></span>
          <span class="mval ${it.on ? 'on' : 'off'}">${it.on ? '已开启' : '已关闭'}</span>
        </div>${subs}`;
      }
      // ⭐⭐ 0.8.24 任务四（「这个设置要在全局设置中设置，全局设置和设置应该
      //    指向同一个设置，不能两边独立代码」）：声明了 `card.settings` 的模块（目前只有
      //    「我的设备」）多一颗「设置」—— 点它开模块自己的设置（`mod-settings` 动作转给
      //    `core/slots.js` 的 `openModuleSettings()`）。
      //    ⚠️⭐ HTML **不许按钮套按钮** ⇒ 有那颗键时这一行从 `<button>` 换成 `<div>`
      //    （`.mrow` 的样式全挂在类名上，换标签不影响观感；动作委托读的是 `closest('[data-act]')`，
      //    里面那颗键有自己的 `data-act` ⇒ 点它命中「设置」、点别处命中「翻开关」）。
      if (it.card.settings) {
        return `<div class="mrow" data-act="mod-toggle" data-mod="${esc(
          it.name,
        )}" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">${esc(it.title)}<small>${esc(it.card.desc)}${tip}</small></span>
        <button class="mset" type="button" data-act="mod-settings" data-mod="${esc(it.name)}">设置</button>
        <span class="mval ${it.on ? 'on' : 'off'}">${it.on ? '已开启' : '已关闭'}</span>
      </div>`;
      }
      return `<button class="mrow" type="button" data-act="mod-toggle" data-mod="${esc(it.name)}" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">${esc(it.title)}<small>${esc(it.card.desc)}${tip}</small></span>
        <span class="mval ${it.on ? 'on' : 'off'}">${it.on ? '已开启' : '已关闭'}</span>
      </button>`;
    })
    .join('');
}

/**
 * 功能：渲染「备份与恢复」区块 —— **个人数据**的导出与导入（只碰自己的账号）。
 * @returns {string} 该区块的 HTML 片段
 */
function backupSectionHtml() {
  return `
    <div class="sec sec-card${foldCls('backup')}" id="sec-backup">
      ${secHeadFold('backup', '备份与恢复', '#64748b', '我的数据', isFolded('backup'))}
      <button class="mrow" type="button" data-act="export" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">导出我的数据<small>下载一份文件：你的项目、任务、课表、收藏、数码和密码</small></span>
        <span class="mval">下载</span>
      </button>
      <button class="mrow" type="button" data-act="import" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">导入我的数据<small>把一份备份放回你的账号，可以「合并」或「替换」</small></span>
        <span class="mval">选择文件</span>
      </button>
      <div class="sec-note" style="margin-top:8px;line-height:1.6">
        要备份或还原整个系统，用「管理员设置」里的「整体备份」。
      </div>
    </div>`;
}

/**
 * 功能：渲染「整体备份」那一段（仅管理员）—— 导出全部账号的数据 / 用备份把系统整个换掉。
 *
 * 说明：⭐ 它**刻意与「备份与恢复」分开放**（与电脑版的两栏同一条道理）：一个只碰自己、
 *      一个动所有人，挨在一起时太容易点错，而点错的代价是所有人的数据被换掉。
 *      ⭐⭐ 第三轮（「手机端有 13 个设置条目，比电脑端多，请对齐电脑端」）：
 *      它从前是**独立一块**（`.sec.sec-card`），而电脑端里它是「管理员设置」那一栏里的第二段
 *      ⇒ 手机端因此比电脑端多出一块。现在改成**一段**（子标题 ＋ 三行），由
 *      `adminSectionHtml()` 嵌进「管理员设置」那张卡里。
 *      ⚠️ 因此这里**不再有 `folded`**：折叠归外层那张卡（`sec-admin`）。
 *
 * @param {boolean} isAdmin - 不是管理员时整段不渲染
 * @returns {string} 该段的 HTML 片段
 */
function orgSectionHtml(isAdmin) {
  if (!isAdmin) return '';
  return `
      <div class="sec-sub">整体备份</div>
      <button class="mrow" type="button" data-act="org-export" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">导出整体备份<small>下载全部账号的全部数据，用来整机搬家或留底</small></span>
        <span class="mval">下载</span>
      </button>
      <button class="mrow" type="button" data-act="org-restore" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">恢复整体备份<small>用备份把现在的数据整个换掉，做完收不回来</small></span>
        <span class="mval danger">危险</span>
      </button>
      ${migrateRowHtml()}
      <div class="sec-note" style="margin-top:8px;line-height:1.6">
        导出包等同整个系统的钥匙，请离线收好。
      </div>`;
}

/**
 * 「迁移记账数据」这一行**现在不出现**（「移除迁移记账数据功能（隐藏），
 * 因为本项目还没有正式上线过」）。
 *
 * 说明：⭐ 与电脑端**同一个开关、同一条理由**（`desktop/views/settings.js` 的 `MIGRATE_ENABLED`）：
 *      那次换库只服务「1 期老库」，而本项目至今没有正式上线 ⇒ 不存在需要迁移的库。
 *      按钮不画，**代码与接口一个字没删**（弹层 `migrateSheet` 与动作 `org-migrate` 都还在）。
 *      ⛔ 别顺手删它们 —— 那是「隐藏」不是「删除」，将来真要处理一份老库时翻成 `true` 就回来了。
 *
 * @returns {string} 那一行的 HTML；关闭时是空串
 */
const MIGRATE_ENABLED = false;

/** 功能：按开关决定画不画「迁移记账数据」那一行。 @returns {string} HTML 或空串 */
function migrateRowHtml() {
  if (!MIGRATE_ENABLED) return '';
  return `
      <button class="mrow" type="button" data-act="org-migrate" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">迁移记账数据<small>把 1 期记在主库里的记账数据搬进独立的记账库；可以重跑，不会重复搬</small></span>
        <span class="mval danger">危险</span>
      </button>`;
}

/**
 * 功能：渲染手机版「设置」页 —— ⭐ 0.4.1 起**分块顺序与内容跟电脑版一致**（指令）：
 *      数据来源 / 模块功能 / 账号设置 / 备份与恢复 / 整体备份（仅管理员）。
 *
 * 说明：管理员另有「成员管理」一块，紧跟在「账号设置」后面 —— 手机版没有独立的成员管理页，
 *      列表就排在这一页上（电脑版那一块是一个「进入 ›」的入口行）。
 *      每一块都能折叠（`secHeadFold` + `toggleSec`，状态在 `state.foldSecs`，见）。
 *      ⚠️ 以前这里叫「功能开关 + 模块功能」两块：0.4.1 把「开关」并进「模块功能」的每一行里
 *      （介绍与开关放一起），「模块功能」里原来的「进入 ›」入口行搬去了「更多」页。
 *
 * @returns {void}
 */
/**
 * 功能：手机端设置页的分栏清单 —— ⭐⭐ 0.8.30（「全局设置改造」）
 *      **与电脑版同一份口径**：前四栏是应用级的，后面每一栏各是一个模块。
 *
 * 说明：⚠️ 手机端**没有**「日志」栏与「快捷键」栏（那两样只在电脑端有），所以这里比电脑端少两块。
 *      ⚠️ `tab` = 那一栏「进入模块」要切到哪个屏（空串 = 这个模块没有自己的屏，如 AI）。
 *      ⚠️ `mods` = 这一栏要装哪些模块的开关与设置分栏（本端的界面配置，⛔ 不是判据）。
 * @type {Array.<Object>}
 */
const PANES = [
  { id: 'version', label: '版本数据' },
  { id: 'admin', label: '管理员设置', adminOnly: true },
  { id: 'account', label: '账号设置' },
  { id: 'backup', label: '备份与恢复' },
  {
    id: 'ai',
    label: 'AI 设置',
    desc: '模型服务地址与密钥。',
    mods: ['ai'],
    tab: '',
  },
  {
    id: 'home',
    label: '首页看板',
    desc: '「今天」那一屏的默认视图。',
    mods: ['calendar'],
    tab: 'today',
  },
  {
    id: 'tasks',
    label: '任务与随手记',
    desc: '任务板与随手记的开关。',
    mods: ['tasks', 'idea'],
    tab: 'board',
  },
  {
    id: 'teamwork',
    label: '团队协作',
    desc: '好友、私聊与实时推送。',
    mods: ['teamwork'],
    tab: 'teamwork',
  },
  {
    id: 'webpass',
    label: '网址/密码夹',
    desc: '网址收藏与密码库的开关。',
    mods: ['bookmarks', 'vault', 'webpass'],
    tab: 'webpass',
  },
  {
    id: 'assets',
    label: '个人资产管理',
    desc: '生活记账与我的设备的开关。',
    mods: ['assets', 'digital', 'ledger'],
    tab: 'assets',
  },
  {
    id: 'time',
    label: '番茄钟与日程表',
    desc: '日程表、番茄钟与行程的开关。',
    mods: ['time'],
    tab: 'time',
  },
];

/**
 * 功能：渲染**一个模块那一栏** —— 一句话介绍 ＋「进入」＋ 它的开关行 ＋ 它贡献的设置分栏。
 *
 * 说明：⭐⭐ 0.8.30：从前这三样散在三处（开关在「模块功能」那一栏、设置分栏各占一块、
 *      模块本体在「更多」页），现在**同一个模块的东西都在同一栏里**。
 *      ⚠️「进入」那颗键走通用的 `dash-goto`（`app.js` 的 `onAction` 里就是 `switchTab()`），
 *      ⛔ 本文件反向 import `app.js` 会成静态环。
 *
 * @param {Object} p - `PANES` 里带 `mods` 的那一条
 * @param {Object} me - 当前登录账号
 * @returns {string} 该栏 HTML
 */
function moduleSectionHtml(p, me) {
  const secId = `mod-${p.id}`;
  if (!state.modules) {
    return `
    <div class="sec sec-card${foldCls(secId)}" id="sec-${secId}">
      ${secHeadFold(secId, p.label, '#4f46e5', '', isFolded(secId))}
      ${skeletonHtml(3)}
    </div>`;
  }
  const cards = modRowsHtml(
    moduleItems(state.modules, uiOf, me || {}).filter((it) => (p.mods || []).includes(it.name)),
  );
  const panes = slotPaneDefs(state.modules, uiOf, me)
    .filter((d) => (p.mods || []).includes(d.name))
    .map((d) => {
      // ⚠️ 分节标题 = 那一栏的名字；**名字里已经带「设置」的（「AI 设置」）不再重复一次**
      //    （与电脑端 `modulePaneHtml()` 同一条规矩， 对齐）。从前手机端这一块
      //    **完全没有标题** ⇒ 一张卡片里冒出「自动锁定 / 收支分类…」，看不出它属于哪个模块。
      //    ⚠️⭐ 2026-10-19：**小标题与这一栏同名时整个不画**（与电脑端逐字同一条规矩）。
      const label = /设置$/.test(d.settingsPane.label) ? d.settingsPane.label : `${d.settingsPane.label}设置`;
      const sub = d.settingsPane.label === p.label ? '' : `<div class="sec-sub">${esc(label)}</div>`;
      return `
      ${sub}
      <div class="card sec-flat" data-slot-pane="${esc(d.settingsPane.id)}">
        <div class="mrow plain">正在读取…</div>
      </div>`;
    })
    .join('');
  const goto = p.tab
    ? `
      <button class="mrow" type="button" data-act="dash-goto" data-tab="${esc(p.tab)}" style="width:100%;font:inherit;text-align:left">
        <span class="mtxt">进入「${esc(p.label)}」</span>
        <span class="mval">前往</span>
      </button>`
    : '';
  // ⭐ 设置页质检：**块按栏头那句决定默认展开** —— 从前 `moduleSectionHtml()` 一律走
  //    `isFolded(secId)`（缺省收起）却**不带 `folded` 类** ⇒ 每一栏都是「标题看着能收、
  //    内容却在外面」的假折叠：点一下没有任何变化（点的是 `aria-expanded=true` 的标题，
  //    `toggleSec()` 给它加上 `folded`，于是「收起来」看着像第一次展开）。
  //    ⇒ 现在折叠态与 `isFolded()` 真正对上（仍默认收起，与「其余全部折叠」那条指令一致）。
  return `
    <div class="sec sec-card${foldCls(secId)}" id="sec-${secId}">
      ${secHeadFold(secId, p.label, '#4f46e5', '', isFolded(secId))}
      <div class="card sec-flat"><div class="mrow plain" style="padding:0">${esc(p.desc || '')}</div></div>
      ${goto}
      ${cards}
      ${panes}
    </div>`;
}

/**
 * 功能：把「模块」那几栏按 `PANES` 的顺序拼起来。
 * @param {Object} me - 当前登录账号
 * @returns {string} HTML
 */
function moduleSectionsHtml(me) {
  return PANES.filter((p) => p.mods)
    .map((p) => moduleSectionHtml(p, me))
    .join('');
}

export function renderSettings() {
  const el = $('#view-settings');
  const me = state.me || {};
  const isAdmin = !!me.is_admin;
  // ⭐⭐ 0.8.30：一屏下来就是 `PANES` 那 11 项 —— 模块那一栏里已经有「进入 ＋ 开关 ＋ 它的设置」，
  //    所以不再单独拼「模块功能」与那些散着的设置分栏（两份都并进各模块栏了）。
  // ⭐⭐ 第二轮（「手机端排版效果不好」）：顶部加一条**屏内小标题**
  //    —— 手机端的顶栏是全局固定栏（`#tb-title` 只写「设置」两个字），
  //    一进来看到的是「版本数据」那张卡，不知道自己在哪一屏、这屏有几件事。
  //    这条小标题与下面各块的标题同属这一屏，**不进触控路径**（纯文字）。
  // ⭐⭐ 第三轮（「手机端有 13 个设置条目，比电脑端多，请对齐电脑端」）：
  //    从前这里是 **7 个调用点**（data / admin / org / acct / navSettings / backup / modules），
  //    其中 `admin` ＋ `org` 在电脑端本来就是**同一栏**（「管理员设置」），
  //    `navSettings` 在电脑端**根本没有这一栏**（那是手机端独有的能力）——
  //    两者各占一块 ⇒ 手机端比电脑端多两块（13 vs 11）。
  //    ⇒ 现在 `orgSectionHtml()` 降成「管理员设置」卡里的**一段**，
  //    于是这一屏与电脑端的 11 栏**一一对应**：版本数据 / 管理员设置 / 账号设置 / 备份与恢复 ＋ 7 个模块栏。
  // ⭐⭐ 第五轮（「设置中的首页导航栏移动到更多中」）：那一小段**又搬走了** ——
  //    它是「底栏摆哪些功能」，属于目录（「更多」），不属于「这个功能怎么配」（设置）。
  //    ⇒ 设置页从此**没有任何**导航栏相关的行，与电脑端 11 栏仍然逐条对得上。
  el.innerHTML = `
    <div class="set-screen-head">
      <h2>设置</h2>
      <p>版本数据 · 账号 · 备份与恢复，以及每个模块的开关与设置</p>
    </div>
    ${dataSectionHtml()}
    ${isAdmin ? adminSectionHtml() : ''}
    ${acctSectionHtml(me)}
    ${backupSectionHtml()}
    ${moduleSectionsHtml(me)}
    <div class="set-screen-foot">ZXDesk工作台 · 手机版 · 与电脑版共用同一套数据</div>`;
  ensureAdminData();
  mountSlotSections();
}

/**
 * 功能：模块贡献的**设置分块**的 HTML（0.6.0）—— 声明了 `settingsPane` 且开着的模块。
 *
 * 说明：⭐ 电脑版的同一机制是「左菜单追加一颗分栏项」（`desktop/views/settings.js`），
 *      手机版没有左菜单，对应做法就是**在分块序列末尾追加一个同名分块**（可折叠）。
 *      内容是异步挂的（先画「正在读取…」，片段到了就地替换）。
 *
 * @param {Object} me - 当前登录账号
 * @returns {string} 分块 HTML（没有贡献者时是空串）
 */
// ⚠️⚠️ 0.8.30（「全局设置改造」）：原来这里有一个 `slotSectionHtmls()` ——
//   把模块贡献的设置分块单独拼成一串「正在读取…」。**它整块撤了**：那些设置分栏现在并进
//   **各模块自己那一栏**里（见 `moduleSectionHtml()` 里那个 `slotPaneDefs(...)`）。
//   ⛔ 别加回来 —— 那样同一个设置会在两处各出现一次。

/**
 * 功能：把每个模块贡献分块的内容挂上（`mountModuleSlot` 逐个动态 import，失败不静默）。
 * @returns {Promise.<void>}
 */
async function mountSlotSections() {
  const defs = slotPaneDefs(state.modules, uiOf, state.me || {});
  for (const d of defs) {
    const box = document.querySelector(`#view-settings [data-slot-pane="${d.settingsPane.id}"]`);
    if (!box) continue;
    await mountModuleSlot(box, 'mobile', d.name, 'settings-pane', {
      end: 'mobile',
      modules: state.modules,
      uiOf,
      me: state.me,
    });
  }
}

/**
 * 功能：管理员数据（成员列表 / 自主注册开关 / 数据位置）**按需加载** —— 只有当前登录的是管理员时才请求，
 *      且已在加载中或已加载过就直接跳过；数据到达后重画一次「设置」页把内容填进去（守卫在位，不会递归）。
 *
 * 说明：以前这三张表（users / settings / storage）是**首屏**就拉的，而且是在中间 `await` 掉的
 *      —— 等于把首屏切成三段串行。设置页是低频入口，没有理由为它拖慢打开速度。
 *      ⚠️ 数据到达时只在**用户还停在设置页**时重画：「更多」页不显示管理员数据，
 *      而用户完全可能已经点去别的标签了，那时重画会把人家正在看的页面顶掉。
 *
 * @returns {void}
 */
function ensureAdminData() {
  if (!(state.me && state.me.is_admin)) return;
  if (state.adminLoaded || state.adminLoading) return;
  state.adminLoading = true;
  loadAdminData()
    .then(() => {
      state.adminLoaded = true;
      state.adminLoading = false;
      if (state.tab === 'settings') renderSettings(); // 数据到了重画一次（守卫在位，不会递归）
    })
    .catch(() => {
      state.adminLoading = false;
    });
}

// ---------- 备份与恢复（0.2.1） ----------
/**
 * 当前正在导入 / 恢复的**原始文件**。
 *
 * 说明：⭐ 不再连解析结果一起存 —— 整体备份是个 zip，前端根本解不开它，
 *      硬要在这里存一份「解析后的对象」只会逼着调用方假装它是 JSON。
 *
 * 说明：放在**模块级**而不是 `state` 里：它是一份「正在进行的操作」的临时句柄，
 *      不属于界面状态，也没有任何视图需要读它；关掉弹层就该丢掉。
 */
let pending = null;

/**
 * 功能：弹一个系统文件选择框，选中后读成文本并解析；失败弹提示并返回 null。
 * @param {File} file - 用户选中的文件
 * @returns {Promise.<?Object>} 解析出的 JSON 对象；读失败 / 不是 JSON / 顶层不是对象时为 null
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

/**
 * 功能：弹文件选择框，选中后把**原始 File** 交给 `onPick`（不在这里解析）。
 *
 * 说明：⭐ 交给调用方自己读 —— 个人备份是 JSON、整体备份是 zip，两者读法不同；
 *      在这里统一解析就等于把「整体备份必须是 JSON」这个已经过时的假设写死在这里。
 *      手机上没有 `showOpenFilePicker`，只能靠一个临时 `input[type=file]`；
 *      用完即弃（`change` 与 `cancel` 两条路径都清掉），避免在 DOM 里留垃圾。
 *
 * @param {string} accept - `accept` 属性（如 `.zip,application/zip,.json,application/json`）
 * @param {Function} onPick - 选中文件后的回调，收到 `File`
 * @returns {void}
 */
export function pickBackup(accept, onPick) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = accept;
  inp.style.display = 'none';
  document.body.appendChild(inp);
  /** 功能：把临时 input 摘掉（选中与取消共用） */
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

/** 功能：从备份对象里取数组（课表 5 张表认新旧两种键名，与服务端一致） */
function arrOf(dump, ...keys) {
  for (const k of keys) if (Array.isArray(dump[k])) return dump[k];
  return [];
}

/** 功能：渲染「名称 · 条数」的碎片行 —— 手机上是换行排列的小胶囊 */
function chipsHtml(pairs) {
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${pairs
    .map(([k, n]) => `<span class="imp-chip">${esc(k)} <b>${n}</b></span>`)
    .join('')}</div>`;
}

/** 功能：渲染备份文件的来源信息（文件名 / 体积 / 导出时间 / 来源版本） */
function metaHtml(dump, file) {
  return `<div style="font-size:12.5px;color:var(--ink-2);line-height:1.6;word-break:break-all">
      文件：<b>${esc(file.name)}</b>（${esc(formatBytes(file.size))}）
      ${dump.exportedAt ? ` · 导出于 ${esc(dump.exportedAt)}` : ''}
      ${dump.version ? ` · 来源版本 v${esc(dump.version)}` : ''}
    </div>`;
}

/**
 * 功能：「导入我的数据」入口 —— 选文件 → 显示条数与来源 → 由用户选「合并」或「替换」。
 *
 * 说明：⭐ 预览的条数是**客户端**数出来的（数组长度），只作心理准备；真正的校验在服务端，
 *      不合格的文件会被退回并说明原因，且一行数据都不会写进去 —— 这样大文件不必传两遍。
 *
 * @returns {void}
 */
export function importFlow() {
  pickBackup('.json,application/json', async (file) => {
    if (await isBackupZip(file)) {
      return toast('这是整体备份压缩包，请用「恢复整体备份」（需管理员权限）', true);
    }
    const dump = await readJson(file);
    if (!dump) return;
    if (dump.kind === 'org-backup' || dump.tables) {
      return toast('这是整体备份文件，请用「恢复整体备份」（需管理员权限）', true);
    }
    if (dump.app !== 'ZXDesk') return toast('这不是 ZXDesk 的备份文件', true);

    const pairs = [
      ['项目', arrOf(dump, 'projects').length],
      ['项目任务', arrOf(dump, 'project_tasks').length],
      ['日常任务', arrOf(dump, 'daily_tasks').length],
      ['学期', arrOf(dump, 'timetable_terms', 'terms').length],
      ['课程', arrOf(dump, 'timetable_courses', 'courses').length],
      ['课次', arrOf(dump, 'timetable_sessions', 'course_sessions').length],
      ['书签', arrOf(dump, 'bookmarks').length],
      ['书签分类', arrOf(dump, 'bookmark_tags').length],
      // ⭐ 0.3.1 数码管理（0.8.10 由「NAS硬件管理」改名）：台账与愿望单同一张表，
      //    导出键仍是 `hardware`（表名 / 备份键，⛔ 不随显示名改）—— 只改界面上那个名字。
      ['数码台账', arrOf(dump, 'hardware').length],
      // ⭐ 0.3.2 密码库：只显示条目数（`vault_meta` 是「开库材料」，一账号一行，
      //    把它当成一条「数据」显示会让人以为存了 1 条密码）
      ['密码库', arrOf(dump, 'vault_items').length],
    ];
    const total = pairs.reduce((s, [, n]) => s + n, 0);
    pending = file;
    openSheet(
      '导入我的数据',
      `${metaHtml(dump, file)}${chipsHtml(pairs)}
       <div style="margin-top:14px;font-size:13px;line-height:1.65;color:var(--ink-2);border-left:3px solid var(--brand);padding-left:10px">
         <b style="color:var(--ink)">合并导入</b>（推荐）：把上面这些东西<b>加</b>进你的账号，
         现有数据一条都不删 —— 若同一份备份导两次，会出现两份。
       </div>
       <div style="margin-top:12px;font-size:13px;line-height:1.65;color:var(--ink-2);border-left:3px solid #dc2626;padding-left:10px">
         <b style="color:var(--ink)">替换导入</b>：先<b>清空你现有的</b>项目 / 任务 / 课表 / 收藏夹 / 数码台账 / 密码库，
         再写入备份内容（不可撤销）。你的<b>账号本身不受影响</b> —— 用户名、密码、身份都原样保留。
       </div>
       <div class="sec-note" style="margin-top:10px;line-height:1.6">🔐 密码库<b>只在「替换导入」里恢复</b>：
         两套密码库的密钥不同，合并到一起会有一半条目永远解不开，所以合并导入会明确跳过它。</div>
       ${total === 0 ? '<div class="sec-note warn" style="margin-top:12px">这份备份里一条数据都没有，导入不会有任何变化。</div>' : ''}`,
      `<button class="btn primary" type="button" data-act="imp-merge">合并导入</button>
       <button class="btn danger" type="button" data-act="imp-replace">替换导入</button>`,
    );
  });
}

/**
 * 功能：把已选中的备份上传给 `/api/import?mode=...`，成功后关了弹层并整页重载。
 *
 * 说明：⚠️ 直接发 `File` 本身 —— 服务端就是按原始字节读 JSON，前端不必再 `JSON.stringify` 一遍。
 *      整页重载是刻意的：导入会同时改动项目、任务、课表与收藏夹，而课表在 `state` 里另有一整套缓存。
 *
 * @param {string} mode - `'merge'` 或 `'replace'`
 * @returns {Promise.<void>}
 */
export async function importCommit(mode) {
  const file = pending;
  if (!file) return toast('请先选择备份文件', true);
  try {
    const res = await fetch(`/api/import?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: file,
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error((r && r.error) || `导入失败（HTTP ${res.status}）`);
    pending = null;
    closeSheet();
    const c = (r && r.counts) || {};
    const n = Object.keys(c)
      .filter((k) => k !== '_skipped')
      .reduce((s, k) => s + c[k], 0);
    toast(
      `${mode === 'replace' ? '已替换导入' : '已合并导入'} ${n} 条${c._skipped ? `（跳过 ${c._skipped} 条）` : ''}`,
    );
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：导出当前账号的完整数据备份 —— 先确认（说明这是明文文件），确认后导航到 `/api/export`。
 *
 * 说明：⭐ 设置页上**不摆任何提示**（指令）：原来常驻在导出按钮下方的那段说明
 *      挪到这里 —— 用户读到它的时机正好是「我要下载了」那一刻，比挂在页面上有用得多。
 *
 * @returns {Promise.<void>}
 */
export async function exportMine() {
  const ok = await askConfirm({
    title: '导出我的数据',
    text:
      '会下载一份 JSON 文件，里面是你自己的全部数据：项目、任务、课表、网址收藏夹、数码台账与密码库。' +
      '文件是明文的，请妥善保管。' +
      '密码库那部分在文件里仍然是密文 —— 但主密码不在文件里（它从来不落任何地方），所以恢复之后还是原来那把主密码。',
    ok: '开始下载',
  });
  if (!ok) return;
  window.location.href = BASE + '/api/export';
  toast('已开始下载备份文件');
}

/**
 * 功能：导出整库备份 —— 先确认（说明这份文件等同于系统的钥匙），确认后导航到 `/api/backup`。
 *
 * 说明：⚠️「含全部账号的口令散列」这条警告原来常驻在按钮下方，现在挪进确认框，
 *      而且按钮用**危险样式** —— 它下载的是一个拿到就能看遍所有人数据的文件。
 *      下载的是一个 zip，包里三份东西各是干什么的，这里一并说清楚。
 *
 * @returns {Promise.<void>}
 */
export async function exportOrgConfirmed() {
  const ok = await askConfirm({
    title: '⚠️ 导出整体备份',
    text:
      '会下载一个 zip 压缩包（ZXDesk-数据备份-日期-时间.zip），里面是全库快照：全部账号（含口令散列）及其全部数据。' +
      '包内的 backup.json 用于「恢复整体备份」，zxdesk.db 是原始库文件（应用起不来时可手工放回数据目录）。' +
      '整个包等同于整个系统的钥匙 —— 请离线保管、不要随手转发。',
    ok: '开始下载',
    danger: true,
  });
  if (!ok) return;
  window.location.href = BASE + '/api/backup';
  toast('已开始下载整体备份（含全部账号，请妥善保管）');
}

/**
 * 功能：「恢复整体备份」入口 —— 选文件 → 说明会发生什么 → 要求输入「恢复」二字 → 上传。
 *
 * 说明：⚠️ 这是全项目唯一会**删掉所有人数据**的操作，所以刻意做得「不顺手」：
 *      必须手打「恢复」二字才能提交，弹层里也把「会清空」「所有人会被登出」写清楚。
 * ⭐ 两种文件都认：新版 `.zip` 压缩包与 0.2.0 及更早导出的纯 `.json`，按**首字节**分流。
 *      摘要读得出来就照常显示条数，读不出来（被别的工具重压过）就不显示条数 —— 猜出来的
 *      「账号 0 个」比不显示更糟，何况恢复本来不靠这个数字。
 *
 * @returns {void}
 */
export function orgRestoreFlow() {
  pickBackup('.zip,application/zip,.json,application/json', async (file) => {
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
    pending = file;
    const preview = counts
      ? chipsHtml(orgCounts(counts))
      : '<div class="sec-note" style="margin-top:12px">读不出包内的摘要信息（这个包可能被别的工具重压过）。恢复仍然可用 —— 服务端会把整份备份完整校验一遍。</div>';
    openSheet(
      '⚠️ 恢复整体备份',
      `${metaHtml(src, file)}${preview}
       <div class="sec-note warn" style="margin-top:12px;line-height:1.65">
         恢复后系统里的账号与数据将<b>完全变成这份备份的样子</b>：<br />
         · 现有账号中<b>不在备份里的会被删掉</b>，连同其全部数据；<br />
         · 备份里没有的成员数据<b>不会保留</b>（这是替换，不是合并）；<br />
         · 所有人（<b>包括你自己</b>）都会被登出，需要重新登录；<br />
         · 系统会在覆盖前自动另存一份当前库。
       </div>
       <label style="display:block;margin-top:14px;font-size:13px;color:var(--ink-2)">
         确认请输入「恢复」二字：
         <input id="rst-word" type="text" autocomplete="off" style="margin-top:6px;width:100%" />
       </label>`,
      `<button class="btn" type="button" data-act="sheet-close">取消</button>
       <button class="btn danger" type="button" data-act="rst-go" style="flex:1.4">确认恢复</button>`,
    );
  });
}

/**
 * 功能：校验确认词并真正执行整体恢复；成功后提示并跳回登录页。
 *
 * 说明：无论成功失败都会把 `pending` 清掉 —— 恢复是一次性的，留着它只会让「再点一次」
 *      变得可能（那是我们最不希望发生的事）。
 * ⚠️ 请求头写 `application/octet-stream`：现在上传的多半是 zip，写 `application/json` 就是在说谎
 *      （服务端按**首字节**判形态，根本不看这个头）。
 *
 * @returns {Promise.<void>}
 */
export async function restoreCommit() {
  const file = pending;
  if (!file) return toast('请先选择备份文件', true);
  if (String(($('#rst-word') || {}).value || '').trim() !== '恢复') {
    return toast('请输入「恢复」二字以确认', true);
  }
  try {
    const res = await fetch(BASE + '/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error((r && r.error) || `恢复失败（HTTP ${res.status}）`);
    pending = null;
    closeSheet();
    toast(`恢复完成（${(r.counts && r.counts.users) || 0} 个账号），请重新登录`);
    setTimeout(() => {
      location.href = BASE + '/login.html';
    }, 1800);
  } catch (e) {
    pending = null;
    toast(e.message, true);
  }
}

// ---------- 记账数据迁移（仅管理员，0.8.1 / T24） ----------
/**
 * 功能：记账数据迁移 —— 先讲清后果、要求手打「迁移」二字，再发一次 `POST /api/migrate-ledger`。
 *
 * 说明：⚠️ 这是**整库级别的文件操作**（把 1 期落在主库 `zxdesk.db` 的那几张 `ledger_*` 表搬进独立
 *      记账库），所以照上面「恢复整体备份」那一套来：危险红行 ＋ 说明 ＋ 手打确认（⛔ 不是只弹一个
 *      「确定吗」—— 那种确认层谁都会顺手点过去）。版式与电脑版 `desktop/views/settings.js` 的
 *      `migrateLedger()` 同一份口径，只是搬到手机端的底部弹层里（版式各写一份）。
 *      ⭐ 它**幂等**（服务端跑三态：已迁移 / 只清残留 / 无需迁移）—— 所以文案里明说「可以重跑」，
 *      ⛔ 别写成「只能做一次」（那会让用户在没搞清状态时不敢点它）。
 *      ⚠️ 本地只拦「没打那两个字」这一条**表单语义**检查；能不能跑、跑出什么结果一律服务端说了算
 *      （非管理员 403、记账库不可用 503、复制失败 500，原样把话弹给用户，⛔ 前端不预判）。
 * @returns {void}
 */
export function migrateLedgerFlow() {
  openSheet(
    '⚠️ 迁移记账数据',
    `<div class="sec-note" style="line-height:1.65">
       会把 1 期记在<b>主库</b>里的那几张记账表，搬进记账自己的<b>独立库</b> ——
       数据一条不少，界面上看不出任何区别，只是换个地方存。
     </div>
     <div class="sec-note" style="margin-top:10px;line-height:1.65">
       这一步<b>可以重跑</b>：已经搬过的不会重复搬，最多把主库里的残留清掉。
     </div>
     <div class="sec-note warn" style="margin-top:10px;line-height:1.65">
       开始之前会给两个库各留一份<b>快照</b>（文件名会在做完后告诉你）——
       万一要回滚，就是拿它人工放回去。
     </div>
     <label style="display:block;margin-top:14px;font-size:13px;color:var(--ink-2)">
       确认请输入「迁移」二字：
       <input id="mig-word" type="text" autocomplete="off" style="margin-top:6px;width:100%" />
     </label>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="mig-go" style="flex:1.4">开始迁移</button>`,
  );
}

/**
 * 功能：把迁移报告里那三态翻成一句人话（⛔ 不把服务端的 `state` 原样摆给用户看）。
 *
 * 说明：⚠️ 与电脑版 `migrateStateText()` **逐字同一份文案** —— 同一件事在两端说法不一样，
 *      用户会以为是两回事。
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
 * 功能：校验确认词并真正发一次迁移请求，然后把「搬了几条 / 快照在哪」摆给用户看。
 *
 * 说明：⚠️ 结果里**必须带上快照文件名与目录**：那是唯一的人工回滚材料，
 *      只弹一句「迁移完成」等于把回滚的路藏起来了。
 *      ⚠️ 结果**换掉弹层正文**而不是飘一句轻提示：`toast()` 只有**一个**节点、后一条会把前一条
 *      顶掉（见 `mobile/ui.js`），连发四条等于用户只看得到最后一条。
 *      ⚠️ 这一步**不换屏、不重登**（与「恢复整体备份」不同）：它只是把数据挪个地方，账号与界面照旧。
 * @returns {Promise.<void>}
 */
export async function migrateGo() {
  if (String(($('#mig-word') || {}).value || '').trim() !== '迁移') {
    return toast('请输入「迁移」两个字才能继续', true);
  }
  try {
    const r = await api('POST', '/api/migrate-ledger');
    const c = (r && r.counts) || {};
    const total = Object.keys(c).reduce((s, k) => s + Number(c[k] || 0), 0);
    const snaps = (r && r.snapshots) || [];
    // ⚠️ 迁移报告里那个 `state` 是**技术口径**（`migrated` / `cleaned` / `none`），
    //    ⛔ 不原样摆出来 —— 一律走 `migrateStateText()` 翻成人话（与电脑版逐字同一句）。
    openSheet(
      '迁移完成',
      `<div class="sec-note" style="line-height:1.65">${esc(migrateStateText(r, total))}</div>
       <div class="sec-note" style="margin-top:10px;line-height:1.65">
         迁移前的快照：<b>${snaps.length ? esc(snaps.join('、')) : '（这次没有生成）'}</b>${
           r && r.dir ? `，就在 NAS 的数据文件夹里（<code>${esc(r.dir)}</code>）。` : '。'
         }
       </div>${r && r.note ? `<div class="sec-note" style="margin-top:10px;line-height:1.65">${esc(r.note)}</div>` : ''}`,
      `<button class="btn" type="button" data-act="sheet-close" style="flex:1">知道了</button>`,
    );
  } catch (e) {
    toast(e.message, true);
  }
}
