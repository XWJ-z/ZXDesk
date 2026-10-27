/**
 * modules/ledger/mobile.js —— 记账**手机版视图**（0.8.0；⭐ 0.8.1 记账 2 期）
 *
 * 功能：手机版记账这一块的取数与渲染 —— `mountLedger()` 拉一次 `GET /api/ledger/overview`
 *      并把这一块画出来；`lgNew` / `lgRetype` / `lgPick` / `lgEdit` / `lgSave` / `lgDel` 是
 *      「加一个账户」与「改一个账户」的两步弹层（类型选择 → 表单）。
 *
 * ⭐⭐ 0.8.10：**记账不再是自己的一屏** —— 它并进「个人资产管理」那一屏，
 *    与数码管理、用户自建分组一起做屏头药丸下的**三格**（同形同义）。
 *    · 骨架（那颗空的 `#view-ledger`）搬进视图片段 `mobile-assets-pane.js`，由它插进宿主的
 *      `#assets-body`；本文件只留**取数与渲染**（`mountLedger()`）＋屏内委托（`bindLedgerOnce()`）。
 *    · ⚠️ 「进屏 / 离开屏」那件事由药丸的切格代替 ⇒ 原来的 `openLedger()` 改名 `mountLedger()`，
 *      并且**整屏接管**那几处判据（顶栏 / 底栏 / 返回）从 `state.tab === 'ledger'` 换成
 *      `state.assetsPane === 'ledger'`（三处都在 `mobile/app.js`）。
 *    · ⚠️ 真正滚动的是**它所在的那颗 `.view`**（`#view-assets`）—— 见 `ledgerScrollNode`。
 *
 * ⭐⭐ 0.8.1：**进记账 = 全屏接管** ——
 *    · 宿主那套底部主导航（`#tabbar`）在这一屏**让位**（隐藏由宿主的 `updateChrome()` 做，
 *      判据 0.8.10起是 `state.assetsPane === 'ledger'`；从前是 `state.tab === 'ledger'`）；
 *      屏内自画一条**记账自己的导航**（`资产 ｜ 记账 ｜ 设置`，
 *      ⛔ **没有「图表」** —— 图表仍是「资产」那一屏里的第二个视图，1 期口径不变）。
 *    · ⛔ 它**不是第二层应用导航**（1 期 当初的顾虑正是这个：底部已有固定 6 颗标签，
 *      再叠一条同款会让人以为这是第二层）—— 现在前提变了：**这一屏把主导航藏起来了**，
 *      所以可以照参考图 D 那条底部标签栏做，但它**只在这三段之间切**。
 *    · ⭐ **默认落「记账」**（C-36：打开即记账 —— 这改了 1 期的首屏）。
 *    · ⚠️ **回主导航 = 走手机端自己的返回**（历史栈逐屏退回，/ 82）；
 *      ⛔ **不额外加「回主导航」按钮**（多一个入口就多一处要维护的状态， 第 5 条）。
 *    · ⭐⭐ **「记账设置」从二级屏升成第三格**（`设置`）—— 它与资产 / 记账
 *      **完全并列**：不收起宿主顶栏、不画「‹ 返回」那条自画头、**不压历史栈**（照那两段的切换
 *      手法），而它自己**要画底部三格**（因为它现在是三段之一，不再是二级屏）。
 *      ⇒ 记账屏顶部那颗 `⋯` **删掉了**（`lg-setopen` / `lg-setback` 连同 ACTIONS 登记一起撤）；
 *      ⚠️ `lg-setback` 这个名字**0.8.3 又回来了**，但换了一件事：它成了设置**子页**顶上
 *      那颗「‹ 返回」（见下面 0.8.3 那一段），⛔ 不是这颗 `⋯` 复活。
 *      ⚠️ **账户详情仍然是二级屏**（收起顶栏 ＋ 自画「‹ 返回」）—— 那条一个字都没动。
 *
 * ⭐ 0.8.3：**记账设置加了二级菜单**（「设置增加二级菜单，现在要滑动到底很不方便」）——
 *    「设置」那一格从**一条长滚动**改成**首页四条目 → 点进子页**（收支账户 / 收支分类 /
 *    导入三方数据 / 导出数据）：
 *    · 条目清单与判据住 `calc.js`（`SET_PAGES` / `setPageOf()`，与电脑端**同一份**）；
 *    · 子页是**二级屏**（照账户详情那条分寸）：宿主顶栏收起来（`state.lgSetPage` 进
 *      `mobile/app.js` 的 `topbar-bare` 判据）＋ 屏内自画「‹ 返回 ＋ 标题」那条头
 *      （复用 0.8.2 子屏那颗 `subHeadHtml()`）、⛔ **不画底部导航**（底栏留给第一层那四格）；
 *    · ⚠️ 两颗新键（`lg-setgo` / `lg-setback`）登记在 `mobile/app.js` 的 `ACTIONS` 里 ——
 *      漏了＝那颗按钮「点了没反应」且不报错。
 *
 * ⭐ 0.8.3：**撤掉底栏里「记账」那一格，入口改成一颗悬浮笔按钮**（「撤销记账中导航栏
 *    里的记账，改为悬浮 ＋ 标志进入记账，参考手机端的今天的 ＋ 创建任务」）——
 *    · 底栏从**五格**回落成 `calc.js` 的 `SEGS` 那**四格**（明细 ｜ 预算 ｜ 资产 ｜ 设置）；
 *      那一格的视图函数 `entryScreenHtml()` 与它的调用点**整块删掉**（⛔ 不留死代码，
 *      留着就是"一格谁也进不去的死屏"）；
 *    · 「＋ 记一笔」挪到**屏级**那颗悬浮钮（`#assets-new`，版式照宿主 `.fab` —— ⭐ 0.8.20 起
 *      它与数码管理的「＋ 新增」共用一颗，见 `paintAssetsFab()`）——
 *      ⚠️ **只在第一层那几格画**：⛔ 资产那一格不画（它有自己一整条「＋ 添加账户」主操作，
 *      会被盖住）、⛔ 明细 / 设置那两个**子屏**（账单屏 / 月详情页 / 设置子页）也不画
 *      —— 判据全从 `state` 判，⛔ 不挂 DOM class（这一屏整块重画）；
 *    · ⚠️ 动作名**沿用既有的 `lg-eadd`**（⛔ 别改名＝别让两端的动作表都跟着动）。
 *
 * ⭐ 0.8.0（两张参考图）：
 *    · **账户详情屏**（二级屏，照参考图 1）—— 点列表某一行进来，`state.lgAcct` 记着看的是谁；
 *      屏内自带「‹ 资产详情 ＋ 眼睛」那一条头，宿主那条顶栏在这一屏**收起来**
 *      （`mobile/app.js` 的 `.topbar-bare`，与对话的会话页同一手法）；
 *    · **转账**（照参考图 2）—— 详情屏底部那颗「转账」，走 `POST /api/ledger/transfers`；
 *      服务端一个事务里把两个余额与那条明细一起写完（⛔ 只做一半＝钱凭空消失）；
 *    · **调整余额** —— 既有那条逐键改接口（`opening` 一个键）；
 *    · **眼睛**（`state.lgHide`）—— 清单里的金额一处不漏地糊成圆点（判据只有 `calc.js` 那一处）。
 *    ⚠️ 明细是**单独一次请求**（按账户取），它**不进 `overview`**：那是列表屏的「一屏一次给全」，
 *    而明细会随年月变长，塞进去等于每次进列表都白拉一份。
 *      ⚠️ 明细的四个态（读取中 / 没读到 / 这个月没有 / 有列表）**各画各的** ——
 *      把「没读到」画成「一笔都没有」就是把错误藏起来。
 *
 * ⭐ **本轮刻意没有「资产 / 图表」分段控件**（方案 §十一纪律 1）：
 *    只有一个视图 ⇒ 没有控件这件事。⛔ 也**不加 `state.lgTab`**（没有第二个视图 = 没有消费者的
 *    state，与/ 15 同一条纪律）。
 *
 * ⭐⭐ **金额的加减一个都不在本文件里**：资产 / 负债 / 净值 / 每组小计**全部**是服务端
 *    `summarize()` 算好后随 overview 一起下来的（方案 §三）。本文件只做**显示**：
 *    `fmtFen()`（带千分位）与「负债侧加 `-`」（`fmtSide`，符号由**服务端的 `groups[].side`** 决定）。
 *    ⛔ 不许在这里 sum 一遍 —— 那会造出第二个真相源，而快照那三个数走的是服务端那份。
 *
 * ⚠️ **一屏一次给全**：净值卡、分组列表、账户行全来自**同一个响应**，
 *    ⛔ 不为列表单开一个接口。
 * ⚠️ **服务端「今天」搭车回来**（`overview.today`）：⛔ 本文件不算本机日期。
 * ⚠️ 两类输入框（余额 / 后四位）**不自己画数字键盘**：`inputmode` 交给手机 OS 去决定
 *    （方案 §4.3：图 C 下半屏那个键盘是系统键盘，不是我们画的）。
 * ⚠️ 渲染一律经 `esc()` 转义：账户名与备注是用户自由输入。
 *
 * ⚠️ 动作名与 `mobile/app.js` 的 `ACTIONS` 表**逐字一致**（`lg-new` / `lg-retype` / `lg-pick` /
 *    `lg-edit` / `lg-save` / `lg-del`，⭐ 0.8.1 又加了下面「2 期」那一批）——
 *    键对不上就是「点了没反应」，而且**不报错**。
 *
 * ⭐ 0.8.1在这一屏上又接了三件事：
 *    · **流水列表**（记账那一屏）：按月 ＋ 游标，按天分组，三态分开；
 *    · **记一笔**（上滑弹层）：一级分类网格 →（可选）二级，账户 ＋ 金额 ＋ 备注 ＋ 时间；
 *    · **账户详情**改用 `GET /accounts/:id/changes`（记账 ＋ 转账 ＋ 手动调整**三类混排**，三档颜色）。
 *    ⚠️ 展示口径（分组 / 月份选项 / 游标串 / 退款文案 / 三档色 / 默认账户顺序）**全住
 *    `entry-calc.js`**（两端共用一份，/ 99）—— ⛔ 本文件一个判据都不复制。
 *
 * ⭐⭐ 0.8.1 补（真机验收两条）在这一屏上又补了两块：
 *    · **条目详情 ＋ 改一笔 ＋ 删一笔**：点流水**整行**进上滑详情，正文里就能编辑 / 删除
 *      （`PUT` / `DELETE /api/ledger/entries/:id` —— 服务端早就写好了，前端从前一次都没调过）；
 *      编辑**复用「记一笔」那张弹层**（⛔ 不画第二份表单），保存走**逐键**、秒取**原条目**的秒；
 *    · **【收支分类】一栏**：支出 / 收入两棵两级树，能建一级 / 建二级 / 改名 / 归档
 *      （有子分类时让用户二选一：一起归档 or 挪到「其它」）。⛔ 不新开屏、不新增入口。
 *      ⚠️ 树的构造只走 `entry-calc.js` 的 `catTree()` / `topCats()` / `childCats()` / `hasKids()`。
 *      ⚠️⭐ 0.8.3：「删除＝归档」那条老口径**作废**（见下面 0.8.3 那一段）。
 *
 * ⭐ 0.8.3（本文件本轮）在这一屏上又改了两块：
 *    · **【收支账户】改成按需新增 ＋ 全部当场生效**：全局两行（默认收入 / 支出）与"每种类别"
 *      那一列的下拉**一改就提交**（逐键 `PUT /defaults`）、存完从服务端回读；
 *      "每种类别"那一列**只列已经设过的**，要设新的走底部「＋ 新增」那张弹层
 *      （`lgDefNew()`）—— 原来那颗整页「保存」（`.lg-setsave` / `lgSetSave`）**删掉了**；
 *    · **【收支分类】多了"重名拦截 ＋ 真删除 ＋ 恢复"**：
 *      ① 建 / 改名先拿 `calc.js` 的 `catFullName()` ＋ `catNameTaken()` 拦一道重名
 *         （全称全局唯一：二级是 `一级-二级`）—— 撞了就**当场拦下**，那条注定 400 的请求不发；
 *      ② 「删除」＝**真删**（`?mode=delete`，不可恢复）：先过一道把三件事说全的确认层，
 *         它名下的账与它下面的子分类都改挂到同侧「其它」；
 *      ③ 已归档的自定义行多了「恢复」（取消归档）与「删除」两颗 —— 归档不再是终点。
 *      ⚠️ 「归档」与「删除」从此是**两件事**（归档＝行留着、可恢复；删除＝行没了）。
 *
 * ⭐⭐ 0.8.1 补（本文件本轮）：
 *    · **分类行按服务端的 `builtin` 分内置 / 自定义**：内置行**不画**「改名」「归档」「删除」
 *      （服务端这几条路一律 400 —— 画了按钮才 400 是最差的一种），自定义行照旧画、并多一枚灰色
 *      「自定义」小字；⛔ **判据只看 `builtin` 这个字段，不比名字**（用户也能建一个叫「餐饮」的
 *      —— 那是自定义）。
 *    · **【收支分类】栏底部的「恢复内置分类」危险行**：红色 ＋ 手打「恢复」二字放行，
 *      调 `POST /api/ledger/restore-builtin`；它**不可逆**（旧版预置分类被硬删，
 *      用它们记过的账显示成「未分类」）⇒ 代价三件事在行上与确认页里都写全。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.9.5
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md、docs/公共/开发方案/21-记账2期-记账.md
 */

// ⭐ 0.8.2 三方导入：上传的是**文件原始字节**（⛔ 不是 JSON）⇒ 那条路走不了
//    `api()`（它只会 `JSON.stringify` 一个 body）—— 照课表导入那一套用裸 `fetch` ＋
//    `octet-stream`。⚠️ 于是「401 回登录页」与「非 2xx 取服务端那句人话」这两件事得自己接
//    ⇒ 额外 import `backToLogin` 与 `BASE`（本文件只在一处 `postRaw()` 里用，⛔ 不散到调用点）。
import { api, backToLogin, BASE } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, paintChrome, toast } from '../../mobile/ui.js';
import {
  PICK_OTHER,
  KIND_ORDER,
  pickShapeOf,
  fenToInput,
  fmtFen,
  fmtSide,
  fmtSignedFen,
  fmtTx,
  iconOf,
  metaOf,
  monthLabel,
  monthOf,
  needTailOf,
  needLimitOf,
  tailLabelOf,
  limitLinesOf,
  TIERS,
  usageGroupsOf,
  groupIdOf,
  reorderPayload,
  optionsFor,
  txOf,
  TAG_MAX,
  VIEW_MAX,
  VIEW_NAME_MAX,
  // ⭐：图表那一套（**只做画图** —— 占比 / 条长 / 排序 / 按月取点 / 扇段）
  sharePct,
  fmtPct,
  rankRows,
  trendSeries,
  trendGeometry,
  // ⭐ 0.8.10：纵轴刻度那两件 —— `AXIS_MONTHS`（点一下要知道是第几个月）
  //    与 `yTickLabels()`（刻度文字：**一次给一整组**，保证三个刻度互不相同）。
  //    ⛔ 本文件不自己拼「几月」、不自己截金额。
  AXIS_MONTHS,
  yTickLabels,
  // ⭐ 0.8.3（4 期 C-14）：按天折线那两件**也收口到共用几何**（见 `dayLineHtml()`）——
  //    ⛔ 本文件不再自己算 `lo/hi/xOf/yOf`（那是同一段算术的第二份拷贝）。
  dayAxisOf,
  dayValuesOf,
  donutArcs,
  ratioPair,
  debtRatioPct,
  USAGE_MAX,
  // ⭐⭐ 0.8.2：记账屏内导航那几格（`key` ＋ 文案的**唯一出处**，—— 两端共用；
  //    ⭐ 0.8.3 撤掉「记账」那一格 ⇒ 现在是四格，见 `calc.js` 的 `SEGS`）
  SEGS,
  SEG_KEYS,
  // ⭐⭐ 0.8.3（4 期）：**图表**那一套 —— 药丸两档、期间的标签，
  //    以及与折线共用的横轴（`chartAxisOf()`）。⛔ 本文件不自己拼标签、不自己数格数。
  //    ⚠️ 0.8.22：口径那颗 `<select>` 换成**两颗按键** ⇒ `CHART_DIRS` 这个 import 用不着了
  //    （`chartDirOf()` 自己认两档，⛔ 这里不必再列一遍）。
  SUB_TABS,
  subTabOf,
  chartDirOf,
  chartAxisOf,
  // ⭐ 0.8.3：记账设置**二级菜单**的条目清单与判据（同上：唯一出处，两端共用）
  SET_PAGES,
  setPageOf,
  // ⭐⭐ 0.8.3（4 期）：导出的「导什么」清单与范围文案（**唯一出处**在 `calc.js`，
  //    —— 两端共用）⇒ 本文件⛔ 不自己列那三样、⛔ 不自己拼「2024年05月」这种串。
  EXPORT_WHATS,
  EXPORT_WHAT_KEYS,
  exportDateOf,
  exportDateText,
  // ⭐⭐ 0.8.3：分类的**全称**与**重名判据**（二级分类本质上带着上级的名字
  //    ⇒ 判断重复也得带上）—— 判据只住 `calc.js` 那一处，⛔ 本文件不自己拼名字、
  //    不自己 `===` 比名字（服务端另有一份同口径的，两层必须一致）。
  catFullName,
  catNameTaken,
  // ⭐⭐ 0.8.2 记账 3 期：预算 / 账单那一套**两端共用**的纯口径 ——
  //    ⚠️ 三档的期间起点、卡片列名、占比读法全在 `calc.js` 里（判据只准一份）；
  //    ⛔ 本文件一个金额都不算（2 期 §5.4「前端不算钱」），这里只做「取值 → 文案」。
  PERIOD_TYPES,
  periodKeyOf,
  periodLabelOf,
  budgetLineLabels,
  billCardLabels,
  billColLabels,
  pct1,
  ringText,
  budgetBlockText,
  shiftMonth,
  weekRangeLabel,
} from './calc.js';
// ⭐⭐ 0.8.1 记账 2 期：流水那一套**两端共用的纯展示函数**。
//    ⚠️ 金额格式化 / 「眼睛」的掩码 / 月份口径都**直接复用 `calc.js` 那一份**（它自己 import），
//    本文件⛔ 一个实现都不复制（双份判据必然漂移）。
import {
  ENTRY_PAGE_SIZE,
  buildCursor,
  parseCursor,
  groupByDay,
  monthOptions,
  CAT_UNCLASSIFIED,
  catName,
  // ⭐ 0.8.1 补：分类的两级树与三条判据（一级 / 二级 / 有没有孩子）—— 分类管理那一栏要用，
  //    ⛔ 一律调它们，别在本文件再写 `filter((c) => !c.parent_id)`（判据只准一处）。
  catTree,
  childCats,
  hasKids,
  topCats,
  isRefund,
  refundNoteOf,
  entryTitle,
  signedFen,
  changeTone,
  toneStyle,
  matchNote,
  pickDefaultAccount,
} from './entry-calc.js';

/** 余额与名称的长度/形状上限由**服务端**判（`modules/ledger/routes.js`），这里只给输入框加 `maxlength` 提示 */
const NAME_MAX = 60;
const NOTE_MAX = 200;

/**
 * 收支分类名的长度上限 —— ⚠️ 与【账户名】那两个上限**各是一个常量**（值恰好都是 60，但它们是
 * 服务端两处不同的判据：`MAX_CATEGORY_NAME` 住 `lib/categories.js`）⇒ 别拿 `NAME_MAX` 顺手一起用
 * （哪天账户名上限改了，分类名的提示会跟着变成错的，而且**不报错**：服务端 400，用户只看到一句红话）。
 * ⚠️ 这里同样只是输入框的 `maxlength` 提示，⛔ 判据在服务端。
 * @type {number}
 */
const CAT_NAME_MAX = 60;

/**
 * 眼睛（睁眼 / 闭眼）—— 内联 SVG，**单色形状 + `currentColor` 上色**。
 *
 * 说明：⚠️ 刻意**不用 emoji**：同一个 emoji 在两端 / 各系统字体里长得不一样（本项目踩过
 *      「图标自带配色与 CSS 上色互斥」那条），而这一颗按钮的语义（藏 / 现）必须一眼看得出。
 *      ⛔ 图形本身是通用几何（椭圆眼 + 瞳孔），不是任何一家的品牌标。
 * @type {{on: string, off: string}}
 */
const EYE = {
  on:
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.2 12S5.8 5.8 12 5.8 21.8 12 21.8 12 18.2 18.2 12 18.2 2.2 12 2.2 12z"/>' +
    '<circle cx="12" cy="12" r="2.7"/></svg>',
  off:
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.2 12S5.8 5.8 12 5.8 21.8 12 21.8 12 18.2 18.2 12 18.2 2.2 12 2.2 12z"/>' +
    '<circle cx="12" cy="12" r="2.7"/><path d="M4.2 19.8 19.8 4.2"/></svg>',
};

/**
 * 分类图标回落用的色板（**零出网**：内置色块 ＋ 名字首字，照 1 期账户那套）。
 *
 * 说明：⚠️ 2 期**没有**分类图标文件（方案附录 C-37 说图标集在才落地，
 *      `public/modules/ledger/cats/` 目录现在**不存在**）⇒ 一律回落「色块 ＋ 首字」。
 *      色值住这里（它是**装饰**，不是「三档颜色」那种语义 —— 后者住 `entry-calc.js` 的
 *      `TONE_COLORS`，⛔ 两件事别混）。⚠️ 用 `id % len` 取色：同一个分类每次都是同一个颜色。
 * @type {Array.<string>}
 */
const CAT_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899'];

/**
 * 功能：一个分类的**回落色**（`id % 色板长度` ⇒ 同一个分类每次都是同一个颜色）。
 *
 * 说明：⭐ 判据**只住这一处**：记一笔的分类网格与明细行里那颗小图标都要用它 ——
 *      两处各写一遍 `% CAT_COLORS.length`，迟早会漂成"同一个分类在两个地方两种颜色"。
 * @param {number} catId - 分类 id（`0` / 空 ⇒ 用色板第一个）
 * @returns {string} 一个色值
 * @since 0.8.2
 */
function catColorOf(catId) {
  return CAT_COLORS[Math.abs(Number(catId) || 0) % CAT_COLORS.length];
}

/**
 * 「记一笔 / 记退款」那次流程里「点开那一刻」的**秒**（只活在那一次弹层里）。
 *
 * 说明：⭐⭐ 秒**必须由前端带上**（服务端只收 `YYYY-MM-DD HH:MM:SS`，它无从知道"用户点开
 *      这一格那一刻"的秒 ——  第 11 条）；而原生 `datetime-local` 只能到分钟
 *      （`step="60"`，秒不可调）⇒ 提交时把这一份补上去，⛔ 不动用户改过的日期与时刻。
 * @type {string}
 */
let edSec = '00';

/** 正在给哪一笔记退款（`0` = 没开退款弹层）。 @type {number} */
let refundOf = 0;

/**
 * 正在改哪一条流水（`0` = 新建）—— ⭐ 编辑**复用「记一笔」那张弹层**（⛔ 不另画第二份表单：
 * 两份表单必然漂移，改了金额那格忘了改分类那格的事就会静默发生）。
 * @type {number}
 */
let editId = 0;

/**
 * 编辑时那一条流水的**原值**（`{at, ie, amount, category_id, account_id, note}`）—— 逐键提交要比它。
 *
 * 说明：⭐⭐ 保存时**只带真改过的键**（逐键提交那条纪律，与 `putDefaults()` 同一套）：把整份表单原样 PUT 上去
 *      看着"也对"，但它连"我根本没动过的字段"也重写了一遍 —— 万一那一刻别的地方（另一台设备 /
 *      另一个标签页）刚改过同一个字段，这一下就**静默覆盖**回去了。带上原值就没有"猜"这件事。
 * @type {?Object}
 */
let editOrig = null;

/**
 * 正在改的这条流水**是不是退款条目**（是的话只让改金额与备注 —— 方向 / 分类 / 账户 / 时间都不动）。
 * @type {boolean}
 */
let editRefund = false;

/**
 * 正在问「新建 / 给某个收支分类改名」哪一个（`null` = 没在问）。
 *
 * 说明：⚠️ 与 `pendingView` / `pendingUsage` **分开住**：那两样是「账户分类（视图）」与
 *      「用途字段」，这一样是**收支分类**（界面上一律用全称「收支分类」，
 *      三样东西的叫法都不同）—— 合成一个变量就会出现「在收支分类这一栏点了改名、
 *      结果改的是别的」这种串味的事（与 `pendingUsage` 分开住是同一个理由）。
 * @type {?{mode: string, id: number, parentId: number, ie: string}}
 */
let catAsk = null;

/**
 * 上一次绑过事件的那颗 `#view-ledger` 节点（`null` = 还没绑过）。
 *
 * 说明：⭐ 0.8.10：这一块并进「个人资产管理」那一屏之后，`#view-ledger`
 *      由视图片段**每次挂载新建一颗**（`mountModuleSlot()` 会先清空容器）。所以「只挂一次」
 *      的判据从**一个布尔量**改成「**节点身份**」—— 新节点要重挂、同一颗重入不重挂。
 *      ⚠️ 用布尔量的后果是「第二次进这一格，屏内所有按钮点了没反应」且**不报错**。
 * @type {?HTMLElement}
 */
let ledgerViewNode = null;

/**
 * 上一次绑过 scroll 委托的那颗**滚动容器**（= 记账借住那一屏的 `.view`）。
 *
 * 说明：⭐ 0.8.10：记账不再是自己一屏 ⇒ 真正滚动的是它所在的那颗 `.view`
 *      （`#view-assets`，`overflow-y: auto`），而 `#view-ledger` 自己只铺内容、不滚。
 *      ⚠️ 那颗 `.view` 是**常驻节点**（片段每次只换 `#view-ledger`）⇒ 它的 scroll 监听
 *      同样要按**节点身份**防重，否则每切进这一格都会多挂一份（一次滚动发两次「加载更多」）。
 * @type {?HTMLElement}
 */
let ledgerScrollNode = null;

/**
 * 银行徽章**图标文件**的目录（⚠️ 两端不是同一个串）。
 *
 * 说明：⚠️ `mask` 的 URL 是相对**文档**解析的：手机端的文档在 `/mobile/` ⇒ 必须带 `../`
 *      （电脑版那份是 `modules/ledger/brands/`，与两端 `index.html` 里 `modulepreload` 的前缀差异同源）。
 *      ⚠️ 写错的表现是**图标静默不显示**（不报错、不留痕）⇒ `ttt/test/ledger.test.js` 钉住了两个前缀。
 */
const BRAND_DIR = '../modules/ledger/brands/';

/**
 * 本次「加 / 改一个账户」流程里的**草稿**。
 *
 * 说明：⚠️ 它只活在**一次弹层流程**里（选类型 → 填表单 → 保存），⛔ 不跨屏、不进 `state`。
 *      住在这里的理由与 `state` 里那些字段不同：它不需要在「重画整屏」之后还在
 *      （每次开表单都会重新建一份），所以没必要占 `state` 的一个位置。
 * @type {?{id: number, kind: string, name: string, tail: string, note: string, opening: string}}
 */
let draft = null;

/**
 * 本次「新建 / 给一套分类改名」的状态（只活在那一次弹窗里）。
 * @type {?{mode: string, id: number}}
 */
let pendingView = null;

/**
 * 本次「新建 / 给一个**用途字段**改名」的行 id（`0` = 新建）。
 *
 * 说明：⚠️ 与 `pendingView` 分开：分类与用途都能改名，但它们是**两样东西**
 *      （分类是「按什么看」、用途是那一列的取值）—— 合成一个变量会让
 *      「在分类那一格点了改名、结果改的是用途」这种串味的事悄悄发生。
 * @type {number}
 */
let pendingUsage = 0;

/**
 * 功能：把「生活记账」那一块画出来（取数 + 渲染）—— 由视图片段 `mobile-assets-pane.js` 调用。
 *
 * 说明：⭐ 0.8.10：记账**不再有自己的一屏** —— 它并进了「个人资产管理」
 *      那一屏（屏头药丸「生活记账 ｜ 数码管理 ｜ 自建分组」）。所以这里**不再切屏、不再画底栏**：
 *      骨架（那颗空的 `#view-ledger`）由片段自己造、片段自己插进宿主给的容器。
 *      ⛔ 别把 `switchTab()` / 底栏那一套加回来：屏名 `ledger` 已从 `mobile/app.js` 的
 *      视图清单里撤掉，调它会把整块藏掉（**整块空白**）。
 *
 *      ⭐ 与服务端口径同源：净值 / 分组 / 快照都可能在别处被改过（另一个标签页、另一台设备），
 *      而这一块摆的就是「现在有多少钱」⇒ 重取才对得上（与番茄钟 / 日历同款）。
 *
 *      ⚠️ 先铺一句「正在读取…」：`overview` 回来之前那颗刚造出来的空 div 会让用户先看到
 *      一片空白（`loadLedger()` 的失败分支会自己把它换成「读取失败」那句人话）。
 *
 * @returns {Promise.<void>}
 */
export async function mountLedger() {
  const box = $('#view-ledger');
  if (box) box.innerHTML = '<div class="m-tip">正在读取…</div>';
  // ⭐⭐ 0.8.21（「隐藏要具有记忆功能：我隐藏了，下次进入还是隐藏状态。并且
  //    手机端和电脑端同步」）：那颗眼睛的**初值来自账号偏好**（`users.hide_ledger_amount`
  //    经 `/api/auth/me` 下来）—— 每次进屏按它复位，所以「上次藏起来了」下次进来还藏着。
  //    ⚠️ 放在**取数之前**：下面每一次 `renderLedger()` 都按 `state.lgHide` 画金额，晚一步设
  //    就会先闪一帧"全都露着"的账（防肩窥那件事上，闪一帧就等于没藏）。
  state.lgHide = !!(state.me && state.me.hide_ledger_amount);
  // ⭐ 0.8.4：进记账把**排序模式**清掉（它是当前这一屏的临时态，⛔ 不跨次会话留着）
  sortMode = false;
  // ⭐ 0.8.21：同理把「明细」那一格的**搜索态**清掉（重进屏不该还停在搜索框上）
  searchOn = false;
  // ⭐ 2 期：取名口与 overview **一起发**（两个都是 GET）—— 下面每一次渲染都要用它，
  //    晚一步画出来的就是"已删账户没有名字的那一版"（而它**不报错**，只是看起来像名字丢了）。
  await Promise.all([loadLedger(), ensureAcctNames()]);
  // ⭐⭐ 0.8.1：进记账就把「记账」那一侧要用的三份取好 —— 收支分类 / 默认账户 /
  //    这个月的流水。⚠️ 分类与默认账户**取不到也不拦**这一屏画出来（记一笔会再试一次并说清
  //    原因）：一个可选的请求把整屏按住，用户看到的是「记账打不开」。
  await Promise.all([ensureCats(), ensureDefaults()]);
  // ⭐ 0.8.0：上次停在某个账户的**详情屏**上时，明细也重取一次 ——
  //    `overview` 里没有明细，只重取它会把上一次那一份原样画回来（过期、且不报错）。
  //    ⚠️ 那个账户如果已经不在了（另一台设备上删的），`renderLedger()` 已经回落列表并把
  //    `lgAcct` 清成 0 ⇒ 这里自然不会再取（⛔ 别自己去判一遍存在性 —— 判据只住一处）。
  if (Number(state.lgAcct)) {
    await openLedgerAccount(state.lgAcct);
  } else if (state.lgSeg === 'detail') {
    // ⭐⭐ 0.8.2：默认那一格是「明细」⇒ 进来直接把流水取回来
    //    （每次进来都重取，与番茄钟同款）。⚠️ 流水那一套渲染**只归明细屏**
    //    （流水列表按天分组的渲染从「记账」那一格**挪到**这里）
    //    ⇒ 只有这一格需要它，⛔ 「记账」那一格不再顺手取一份（它只画一颗「＋ 记一笔」）。
    await loadEntries(true);
  } else if (state.lgSeg === 'budget') {
    // ⭐⭐ 0.8.2：进「预算」那一格也把这一期取回来（进屏重取，与服务端口径同源）。
    await openBudget();
  } else {
    // 「资产」/「记账」/「设置」这三格：分类与默认账户刚到手，重画一次把它们填进去
    // （⭐ 「记账」那一格现在只画一颗「＋ 记一笔」；「设置」升成同级格之后走的也是这条）。
    renderLedger();
    // ⭐ 0.8.2：进「设置」那一格顺手取一次**三方导入概况**（进屏取一次，三态）。
    //    ⚠️ 只在这一格取（明细 / 预算那两格各自有自己的一份取数，⛔ 别顺手多拉一份）。
    if (segOf() === 'set') loadImportSummary();
  }
}

/**
 * 功能：拉一次 `GET /api/ledger/overview` 并重画；失败时把这一屏写成一句人话。
 * @returns {Promise.<void>}
 */
export async function loadLedger() {
  try {
    // ⭐：带上看的是哪一年（初值 0 = 还没取过 ⇒ 让服务端回「今年」）
    const y = Number(state.lgYear) || 0;
    const d = await api('GET', '/api/ledger/overview' + (y ? '?year=' + y : ''));
    state.lg = d;
    // ⚠️ 首次加载后把「今年」记住：否则每次重取都不带 year，用户换过的年份会被悄悄退回今年
    if (!y) state.lgYear = Number(String((d && d.today) || '').slice(0, 4)) || 0;
    renderLedger();
  } catch (e) {
    const box = $('#view-ledger');
    // ⚠️ 这里**不用** `mobile/ui.js` 的 `errHtml()`：它那颗「重新加载」打的是**整页**的
    //    `refresh`（重取 bootstrap / 任务 / 项目），**不会**重新取记账这一屏的数据 ⇒
    //    点了没反应。重试必须走记账自己的动作（`teamwork/mobile.js` 出于同一个理由也自写了一份）。
    if (box) {
      box.innerHTML = `<div class="err-box"><b>读取失败</b><p>${esc(e.message)}</p>
        <button class="chip on" type="button" data-act="lg-refresh" style="margin-top:14px">重新加载</button></div>`;
    }
    toast(e.message, true);
  }
}

// ============================================================================
// ⭐ 0.8.1 记账 2 期：取数层 —— 分类 / 默认账户 / 流水 / 三类变动
//    ⚠️ 这一层只做「取回来 + 折形状」，⛔ 一个展示判据都不写（它们全住 `entry-calc.js`）。
// ============================================================================

/**
 * 功能：本地时钟当前的 `HH:MM` 与 `SS` —— ⚠️ **只用于「时间」那一格的初值**。
 *
 * 说明：⭐⭐ 秒**必须由前端带上**（服务端只收 `YYYY-MM-DD HH:MM:SS`，它无从知道"用户点开
 *      这一格那一刻"的秒 ——  第 11 条）。日期用**服务端今天**（同源，
 *      ⛔ 不用本机日期），分钟用本机时钟 —— 服务端没给「现在几点」，这两件事在报告里写清。
 * @returns {{hm: string, ss: string}} `HH:MM` 与 `SS`（各两位）
 */
function nowPrefix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { hm: `${p(d.getHours())}:${p(d.getMinutes())}`, ss: p(d.getSeconds()) };
}

/**
 * 功能：取一次收支分类清单（`GET /api/ledger/categories`，两级一次性给全，含已归档）。
 * @param {boolean} [force] - 为真时不管缓存、重新取一次
 * @returns {Promise.<boolean>} 手上有分类清单返回 true
 */
async function ensureCats(force) {
  if (!force && state.lgCats.length) return true;
  try {
    const r = await api('GET', '/api/ledger/categories');
    state.lgCats = r && Array.isArray(r.categories) ? r.categories : [];
    return true;
  } catch (_e) {
    // ⚠️ 取不到**不抛**：流水列表照样能画（分类名降级成「未分类」），
    //    记一笔会再试一次并说清原因（一个可选的请求不该把整屏按住）。
    return false;
  }
}

/**
 * 功能：取一次默认账户（`GET /api/ledger/defaults`）—— 记一笔的预填与记账设置都读它。
 * @param {boolean} [force] - 为真时不管缓存、重新取一次
 * @returns {Promise.<boolean>} 手上有默认账户返回 true
 */
async function ensureDefaults(force) {
  if (!force && state.lgDefaults) return true;
  try {
    const r = await api('GET', '/api/ledger/defaults');
    state.lgDefaults = (r && r.defaults) || { income: null, expense: null, categories: [] };
    return true;
  } catch (_e) {
    state.lgDefaults = null;
    return false;
  }
}

/**
 * 功能：把服务端 `GET /defaults` 的响应折成 `pickDefaultAccount()` 要的行形状。
 *
 * 说明：⚠️ 这一步**只做形状转换**，⛔ 不重排取值顺序 —— 顺序只住 `entry-calc.js` 那一处
 *      （类别 → 全局（按收 / 支）→ 空账户）。
 *      ⚠️ 默认账户被删掉 ⇒ 服务端那一格回 `null` ⇒ `pickDefaultAccount()` 会跳过它继续往下兜。
 * @returns {Array.<{kind: string, category_id: number, account_id: ?number}>} 三级的行
 */
function defaultsRows() {
  const d = state.lgDefaults || {};
  const rows = [
    { kind: 'income', category_id: 0, account_id: d.income == null ? null : Number(d.income) },
    { kind: 'expense', category_id: 0, account_id: d.expense == null ? null : Number(d.expense) },
  ];
  for (const c of d.categories || []) {
    rows.push({
      kind: 'category',
      category_id: Number(c.category_id),
      account_id: c.account_id == null ? null : Number(c.account_id),
    });
  }
  return rows;
}

/**
 * 本次会话里 `GET /api/ledger/account-names` 的那一份结果（⭐ 2 期补上的取名口）。
 *
 * 说明：⭐⭐ 为什么要有它：`overview.accounts[]` **只有还活着的账户** —— 已删账户的原名与
 *      空账户的 id 都在它外面，而流水 / 转账 / 调整那几行恰恰要显示这些名字（§7.3 / §7.4 ＋
 *      真机验收第 8 条「删一个账户 ⇒ 它的转账 / 流水一条不少，列表里仍显示**原账户名**」）。
 *      取名判据在服务端**只准有一处**（`store.ledgerAccountNames()`，C-8）⇒ 这里只**照抄**
 *      它给的结果，⛔ 不猜、不造、不按 id 拼一个像样的名字（那正是"前端再拼一份取名口径"）。
 *      ⚠️ **只住内存**（⛔ 不落 localStorage）：账户名是屏幕上的一行字、不是状态，刷新自会重取。
 *      ⚠️ 取不到时它是 `null` ⇒ `acctNameMap()` 退回「只有活账户」那一份（整屏照样画得出来）。
 *      ⚠️ 那一份响应里还有个 `deleted_ids`（名字来自删除记录表的那些 id）—— 本轮只取名字，
 *      ⛔ 不为了"以后可能要用"先存一份（弱化样式哪天真要做，再看它）。
 *      ⚠️ 两端各有一份，但这**判据的名字与语义逐字一致**。
 * @type {?Object.<string, string>}
 */
let acctNameCache = null;

/**
 * 功能：取一次取名口（`GET /api/ledger/account-names`）并记进 `acctNameCache`。
 *
 * 说明：⭐⭐ 失败**绝不拦这一屏**：退回「只有活账户」那一份（与没有这条接口时的行为逐字一样），
 *      但**如实记一次**（`console.warn`）—— ⛔ 不静默吞掉（静默的表现是"已删账户的名字时有时无"，
 *      没人查得出来）；⚠️ 也 ⛔ **不弹红 toast** 打扰（这是"取名字"没取到，不是用户动作失败）。
 *      ⚠️ 刷新点：进记账屏 / 进资产屏（`mountLedger()`）/ 删账户成功之后。
 * @returns {Promise.<boolean>} 拿到了返回 true
 */
async function ensureAcctNames() {
  try {
    const r = await api('GET', '/api/ledger/account-names');
    acctNameCache = (r && r.names) || {};
    return true;
  } catch (e) {
    acctNameCache = null;
    console.warn('[ledger] 账户名没取到，退回「只有活账户」那一份：', e && e.message);
    return false;
  }
}

/**
 * 功能：账户 id → 显示名的映射 —— ⭐ **取值顺序只住这一处**：先活账户（`overview.accounts[]`），
 *      查不到再查那份合并视图（已删账户的原名 / 空账户的「不关联」）。
 *
 * 说明：⭐⭐ 顺序**只准有一处**（就是这里）：⛔ 不许在渲染点各写一遍 —— 两处顺序必然漂移，
 *      而漂移的表现是"同一个账户，在流水里显示得出名字、在转账明细里显示不出来"（C-8 的同一条理由）。
 *      ⚠️ 空账户在库里叫「空账户」，而界面上它代表**「不关联」**—— 这个转换住
 *      **服务端那条接口**（`routes.js` 的 `accountNamesOf()`），⛔ 前端不再判一次 `special`。
 *      ⚠️ 活账户这一份走 `labelOf()`（带后四位）；合并视图那一份只有名字、没有后四位（服务端没给）。
 * @returns {Map.<number, string>} 账户 id → 名字（活账户带后四位）
 */
function acctNameMap() {
  const m = new Map();
  for (const a of (state.lg && state.lg.accounts) || []) m.set(Number(a.id), labelOf(a));
  for (const [k, v] of Object.entries(acctNameCache || {})) {
    const id = Number(k);
    if (!m.has(id)) m.set(id, String(v));
  }
  return m;
}

/** 功能：流水该看哪个月 —— 空串时取**服务端今天那个月**（⛔ 不用本机时钟）。 @returns {string} @since 0.8.0 */
function monthKey() {
  return String(state.lgMonth || '').trim() || monthOf((state.lg && state.lg.today) || '');
}

/** 功能：账户详情那一屏该看哪个月（同上）。 @returns {string} @since 0.8.0 */
function chgMonthKey() {
  return String(state.lgChgMonth || '').trim() || monthOf((state.lg && state.lg.today) || '');
}

/**
 * 功能：把月份记进「这次会话见过的月」清单 —— 下拉要把**访问过的月**留住。
 *
 * 说明：⚠️ 「有记录的月」服务端**没有**一条接口给（报告里的阻塞项）⇒ 下拉选项只能拿
 *      `overview.snapshots` 里出现过的月（每次写操作都落当天快照 ⇒ 是"真实用过"的近似）
 *      ∪ 今天那个月 ∪ 这一份。⛔ 绝不凭空铺一整年空月份给用户挑（挑到空白页他不知道那不是 bug）。
 * @param {string} m - 月份键（`YYYY-MM`）
 * @returns {void}
 */
function rememberMonth(m) {
  const v = String(m || '').trim();
  if (!/^\d{4}-\d{2}$/.test(v) || state.lgMonths.includes(v)) return;
  state.lgMonths.push(v);
}

/**
 * 功能：流水那一屏月份下拉的选项（`monthOptions` 只做归一与去重，⛔ 不另立第二种顺序）。
 * @returns {Array.<string>} 月份键（`YYYY-MM`，倒序）
 */
function entryMonthOptions() {
  const todayMonth = monthOf((state.lg && state.lg.today) || '');
  const rows = (state.lgEntries || []).concat((state.lg && state.lg.snapshots) || []);
  const set = new Set(monthOptions(rows, todayMonth));
  for (const m of state.lgMonths) set.add(m);
  set.add(monthKey());
  return [...set]
    .filter((k) => /^\d{4}-\d{2}$/.test(k))
    .sort()
    .reverse();
}

/** 功能：详情屏月份下拉的选项（同上）。 @returns {Array.<string>} 月份键（倒序） @since 0.8.0 */
function chgMonthOptions() {
  const todayMonth = monthOf((state.lg && state.lg.today) || '');
  const set = new Set(monthOptions(state.lgChg || [], todayMonth));
  // ⭐⭐ 0.8.21（「这个月份选择根本选择不了，只有本月」）：**主来源是服务端的
  //    `/api/ledger/periods`**（`state.lgPeriods.months`：有数据的月，含**三方导入**的月）。
  //    ⚠️⚠️ 光靠上面那两行推不出来：`state.lgChg` 是**这一页明细**（接口一次只给一个月的 30 条）⇒
  //    `monthOptions()` 从它身上只能收回"当前那一个月"，下拉永远只有一项、点不动。
  //    ⚠️ 与电脑端逐字同一条修法，也与本文件 `loadPeriods()` 的既有用法同源。
  for (const m of (state.lgPeriods && state.lgPeriods.months) || []) set.add(String(m));
  for (const m of state.lgMonths) set.add(m);
  set.add(chgMonthKey());
  return [...set]
    .filter((k) => /^\d{4}-\d{2}$/.test(k))
    .sort()
    .reverse();
}

/**
 * 功能：取一页流水（`GET /api/ledger/entries`）—— 按月 ＋ **游标**，一次 30 条。
 *
 * 说明：⭐⭐ 分页⛔ **不用 offset**（C-15 /  第 3 条）：游标是**不透明串**，先
 *      `parseCursor()` 验一次形状再发 —— 认不出就当"没有游标"（＝从头取这一页），
 *      ⛔ 绝不把一个猜出来的值发上去（那会**静默翻错页**，界面上看不出任何异常）。
 *      ⚠️ 失败**不抛**：把三态写成 `error`，由界面画「读不到 ＋ 重试」——
 *      ⛔ 绝不能画成"这个月一笔都没有"（那是把错误藏起来）。
 * @param {boolean} reset - 为真时从第一页重取（换月 / 刚记完一笔 / 点重试）
 * @returns {Promise.<void>}
 */
async function loadEntries(reset) {
  if (reset) {
    state.lgEntries = [];
    state.lgCursor = null;
    state.lgDone = false;
    // ⚠️ 换月重取时把上一个月那两组合计也清掉：留着的话「流水还没回来」的那一瞬间，
    //    页首会拿**上个月**的合计去配**这个月**的标题（而它不报错，只是数对不上）。
    state.lgSum = null;
    state.lgDayTotals = null;
    // ⚠️⭐ 换月时把上一个月那份**导入行**也清掉：它是**服务端按月一次性给全**的
    //    （不分页），留着的话「新一个月还没回来」的那一瞬间，明细屏会拿上个月的导入行
    //    去配这个月的标题（与上面那两组合计同一条理由，而且**不报错**）。
    impRows = [];
  }
  state.lgLoad = 'loading';
  state.lgErr = '';
  renderLedger();
  const month = monthKey();
  const cur = parseCursor(state.lgCursor);
  let url = `/api/ledger/entries?month=${encodeURIComponent(month)}&limit=${ENTRY_PAGE_SIZE}`;
  if (cur) url += `&before=${encodeURIComponent(buildCursor(cur.at, cur.id))}`;
  try {
    const r = await api('GET', url);
    const rows = r && Array.isArray(r.entries) ? r.entries : [];
    state.lgEntries = reset ? rows : state.lgEntries.concat(rows);
    state.lgDone = rows.length < ENTRY_PAGE_SIZE;
    const last = rows[rows.length - 1];
    state.lgCursor = state.lgDone || !last ? null : buildCursor(last.at, last.id);
    // ⭐⭐ 0.8.2：明细屏那两组合计**搭车回来**
    //    —— 一是当月收入 / 支出（`summary`）、二是**按天**两个小计（`dayTotals`）。
    //    ⚠️⚠️ 两组数**一律由服务端给**（2 期 §5.4「前端不算钱」）：前端只按 `at` 的前 10 个
    //    字符分组、再拿这组数去排版，⛔ **不许自己把 `entries` 上的金额加一遍**
    //    （加出来的是"这一页的合计"，而屏幕上写的是"这一天 / 这个月的合计"—— 差得很远，
    //    而且它**不报错**，只是页首那个数随翻页一直变大）。
    //    ⚠️ 覆盖整月、与翻页无关（换月重取时一并刷新；翻页回来的是同一份，重设一次无害）。
    if (r && r.summary) state.lgSum = r.summary;
    if (r && r.dayTotals) state.lgDayTotals = r.dayTotals;
    // ⭐⭐ 0.8.2 三方导入：导入行**搭同一个响应**回来（`imported`，
    //    该月**全部**行、不分页）⇒ ⛔ 绝不为它再发第二个请求。
    //    ⚠️⚠️ 一律**整份替换**（`impRows = r.imported`），⛔ **绝不 `concat`** ——
    //    这一份与 `entries` 不同：`entries` 是"这一页"，导入行是"整个月"；
    //    把它拼进去、再随「加载更多」重画一遍，屏幕上就会**画第二遍**（最常见那个 bug）。
    //    ⚠️ 响应里没这个键（老服务端 / 该月一条都没有）时保持现状：
    //    `reset` 那一路已经清成空数组了，翻页这一路则不该把手上这份抹掉。
    if (r && Array.isArray(r.imported)) impRows = r.imported;
    rememberMonth(month);
    state.lgLoad = 'done';
  } catch (e) {
    state.lgLoad = 'error';
    state.lgErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：取一页「三类变动」（`GET /api/ledger/accounts/:id/changes`）—— 账户详情那一屏。
 *
 * 说明：⭐⭐ 与流水同一套：**按月 ＋ 游标**（⛔ 不用 offset）、三态**不抛**；账户不存在 ⇒ 404
 *      （服务端把越权与不存在统一成 404）。
 *      ⚠️ 请求飞回来时要**再确认一次**还停在同一个账户上：用户可能在请求期间点了返回 /
 *      点开了另一个账户 ⇒ 不判就会把上一个账户的明细画在当前这一屏上（**不报错**）。
 * @param {boolean} reset - 为真时从第一页重取（换月 / 换类型 / 点重试）
 * @returns {Promise.<void>}
 */
async function loadChanges(reset) {
  const aid = Number(state.lgAcct) || 0;
  if (!aid) return;
  if (reset) {
    state.lgChg = [];
    state.lgChgCursor = null;
    state.lgChgDone = false;
  }
  state.lgChgLoad = 'loading';
  state.lgChgErr = '';
  renderLedger();
  const month = chgMonthKey();
  const cur = parseCursor(state.lgChgCursor);
  let url = `/api/ledger/accounts/${aid}/changes?month=${encodeURIComponent(month)}&type=${encodeURIComponent(
    state.lgType,
  )}`;
  if (cur) url += `&before=${encodeURIComponent(buildCursor(cur.at, cur.id))}`;
  try {
    const r = await api('GET', url);
    if (Number(state.lgAcct) !== aid) return;
    const rows = r && Array.isArray(r.changes) ? r.changes : [];
    state.lgChg = reset ? rows : state.lgChg.concat(rows);
    state.lgChgDone = rows.length < ENTRY_PAGE_SIZE;
    const last = rows[rows.length - 1];
    state.lgChgCursor = state.lgChgDone || !last ? null : buildCursor(last.at, last.id);
    rememberMonth(month);
    state.lgChgLoad = 'done';
  } catch (e) {
    if (Number(state.lgAcct) !== aid) return;
    state.lgChgLoad = 'error';
    state.lgChgErr = e.message;
  }
  renderLedger();
}

/** 星期几的中文单字（`getDay()` 的下标：0 = 周日）。⚠️ 只住这一处，⛔ 别在别处再拼一份。 @type {Array.<string>} */
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 功能：把 `YYYY-MM-DD` 写成明细屏的**组标题**「09月19日 星期六」（认不出就把原串照显）。
 *
 * 说明：⭐ 版式权威是参考图 1 / 图 8（两处都是 `09月19日 星期六` / `09月22日 星期二`）——
 *      **月、日补零**、后面跟一个「星期X」。
 *      ⚠️⚠️ 星期用**本地时区**的 `getDay()`：与 `dateOf()` 的「今天」、`at` 的写法是同一条尺子
 *      （`at` 本来就是按本地时刻写出来的）—— 用 UTC 判会在跨零点时把组标题写成前一天。
 *      ⚠️ 日期串不合法（脏数据 / 只有月份）⇒ 原串照显，⛔ 不抛、⛔ 不编一个星期出来。
 * @param {string} date - `YYYY-MM-DD`
 * @returns {string} 组标题那半句
 * @since 0.8.2
 */
function dayHeadLabel(date) {
  const s = String(date || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${m[2]}月${m[3]}日 星期${WEEK_CN[d.getDay()]}`;
}

/** 功能：把时刻串截成「09-22 14:30」（给明细行当副标题用）。 @param {string} at - 时刻 @returns {string} @since 0.8.0 */
function shortAt(at) {
  const s = String(at || '');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.slice(5, 16) : s.slice(0, 10);
}

/**
 * 功能：把「金额该带什么符号」这件事从**服务端的 `groups[].side`** 推出来。
 *
 * 说明：⭐⭐ ⛔ 前端**不自己写一份「哪一类是负债」的表** —— 两份判据必然漂移，而它管的是
 *      金额前面的负号（漂移 = 把「欠 5908」显示成「有 5908」，且不报错）。
 *      ⚠️ 服务端没给侧的类型（理论上不该有）拿不到侧 ⇒ 显示不带符号，但**照样画出来**
 *      （⛔ 不许静默丢掉一行 —— 「数据明明在、界面上没有」是最难查的形态）。
 *
 * @param {Object} d - `state.lg` 的响应
 * @returns {Map.<string, string>} 类型键 → `'asset'` / `'debt'`
 */
function sideMapOf(d) {
  const m = new Map();
  for (const g of (d && d.groups) || []) m.set(g.kind, g.side);
  return m;
}

/**
 * 功能：画那颗**眼睛** —— 点一下把所有金额糊成圆点（要的「防肩窥」）。
 *
 * 说明：⚠️ 两态各一个图形（睁眼 = 现在看得见、闭眼 = 已藏起来），⛔ 不靠颜色深浅区分
 *      （「选中态靠 加粗+底色+描边」那条纪律同样适用）。
 *      ⚠️ 它只是**显示层**的开关：金额本来就随 `overview` 下来了，⛔ 别把它当成权限或加密
 *      （方案 §十二-5 的口径：状态只住内存、⛔ 不当安全机制）。
 * @returns {string} 这一颗按钮的 HTML
 */
function eyeHtml() {
  return `<button class="lg-eye" type="button" data-act="lg-eye" aria-label="${
    state.lgHide ? '显示金额' : '隐藏金额'
  }">${state.lgHide ? EYE.off : EYE.on}</button>`;
}

/**
 * 功能：画「净值卡」—— 品牌色底、净资产大字，下面两栏资产 / 负债。
 *
 * 说明：⚠️ 卡里那一栏 `负债` **刻意不带负号**（参考图 A 就是 `负债 25908.01`）——
 *      负号出现在**分组列表**里（那里才是「这一组要减掉」的位置）。
 *      ⭐ 卡角上那颗眼睛是**全屏的金额开关**（列表 / 分组小计 / 账户行 / 详情全跟着它）。
 *
 * @param {Object} t - `overview.totals`
 * @returns {string} 这一块的 HTML
 */
function heroHtml(t) {
  return `<div class="lg-hero">
    ${eyeHtml()}
    <span class="lg-hero-cap">净资产</span>
    <b class="lg-hero-num">${esc(fmtFen(t.net_fen, state.lgHide))}</b>
    <div class="lg-hero-cols">
      <div><span>资产</span><b>${esc(fmtFen(t.asset_fen, state.lgHide))}</b></div>
      <div><span>负债</span><b>${esc(fmtFen(t.debt_fen, state.lgHide))}</b></div>
    </div>
  </div>`;
}

/**
 * 功能：画账户的**图标块** —— 认得出银行 / 平台就画文件里的真实标，认不出回落类目那套。
 *
 * 说明：⚠️ 列表行与详情屏的头部卡共用它（同一份判据、同一个形状）：⛔ 别在详情里再抄一遍
 *      （两处一漂移，同一家银行在列表与详情里长得不一样，而且不报错）。
 *
 * @param {Object} a - 账户
 * @returns {string} 那个方块（`<span>`）的 HTML
 */
function icoBlockHtml(a) {
  const ic = iconOf(a.kind, a.name);
  // ⭐ 有图标文件（真实品牌标）⇒ 浅中性底 + **原色标**（⛔ 不涂白：涂白会把实心圆标变成一块白饼）；
  //    认不出是哪家 ⇒ 回落类目那套「浅底 + emoji」。
  return ic.badge
    ? `<span class="lg-ico lg-bank"><img class="lg-logo" src="${BRAND_DIR}${ic.file}" alt="" /></span>`
    : `<span class="lg-ico" style="--lg-c:${ic.color}">${ic.icon}</span>`;
}

/**
 * 功能：画一个账户行 —— 图标块 ＋ 名称（带后四位）＋ 副标题 ＋ 右侧金额；整行可点（进**详情**）。
 *
 * 说明：⭐ 0.8.0：图标走 `iconOf(kind, name)` —— 名字认得出是内置银行 / 信用支付平台就画
 *      **浅中性底 + 原色标**（`.lg-ico.lg-bank`），认不出就回落类目那套「浅底 + emoji」
 *      （⛔ 不是错误，用户手输「重庆银行」很常见）。
 *      ⭐ 0.8.0：整行点开的是**账户详情**（不再是编辑表单）——详情屏底部那颗
 *      「设置」才是编辑（照参考图 1 的三颗动作）。
 *
 * @param {Object} a - 一个账户（服务端排好序的那个数组里的一项）
 * @param {Map.<string, string>} sides - 类型 → 侧（决定金额带不带负号）
 * @returns {string} 这一行的 HTML
 */
function rowHtml(a, sides) {
  const title = a.tail ? `${a.name}(${a.tail})` : a.name;
  return `<button class="lg-row" type="button" data-act="lg-open" data-id="${Number(a.id)}" data-drag="acct" data-did="${Number(a.id)}">
    ${icoBlockHtml(a)}
    <span class="lg-main">
      <b class="lg-name">${esc(title)}</b>
      ${a.note ? `<i class="lg-sub">${esc(a.note)}</i>` : ''}
    </span>
    <b class="lg-amt">${esc(fmtSide(a.opening_fen, sides.get(a.kind), state.lgHide))}</b>${sortHandleHtml()}
  </button>`;
}

/**
 * 功能：画一个分组 —— 组名 + 组小计（`debt` 侧带 `−`）一行，下面各组内账户。
 *
 * 说明：⚠️ **空组整段不画**（方案 §三）：`groups` 里只含「有账户的组」，
 *      所以这里直接照它画就行，⛔ 不必自己判「这组有没有数据」。
 *      ⚠️ 一个组内的行**必然同侧**（侧由 `kind` 决定），所以 `sides` 那张表对组内每一行都命中。
 *
 * @param {Object} g - `overview.groups` 里的一项（`{kind, side, total_fen, count}`）
 * @param {Array.<Object>} accounts - 全部账户（已按 KINDS 顺序 × 组内 sort_order 排好）
 * @param {Map.<string, string>} sides - 类型 → 侧（决定金额带不带负号）
 * @returns {string} 这一组的 HTML
 */
function groupHtml(g, accounts, sides) {
  const m = metaOf(g.kind);
  const rows = accounts
    .filter((a) => a.kind === g.kind)
    .map((a) => rowHtml(a, sides))
    .join('');
  // ⭐ 0.8.0：组标题可拖（改九类的显示顺序）—— 凭据是 `ledger_groups` 的**行 id**，
  //    由 `overview.kindGroups` 给出（⛔ 不用类目键：那是代码常量，不是能重排的东西）
  const gid = groupIdOf((state.lg && state.lg.kindGroups) || [], g.kind);
  return `<div class="lg-group">
    <div class="lg-ghead"${gid ? ` data-drag="group" data-gid="${gid}"` : ''}><span>${esc(m.name)}</span><b>${esc(fmtSide(g.total_fen, g.side, state.lgHide))}</b>${sortHandleHtml()}</div>
    ${rows}
  </div>`;
}

/**
// ---------- 分类视图（按用途）：顶部胶囊 ＋ 分组列表 ＋ 建 / 改名 / 删 ─────────-

/**
 * 功能：当前这一屏的分类清单（**服务端排好序**的那一份）。
 * @returns {Array.<Object>} `overview.views` 里可用的那几项
 */
function viewList() {
  return ((state.lg && state.lg.views) || []).filter((v) => v && v.id);
}

/**
 * 功能：**表单**里要问「用途」的那几套视图 —— `viewList()` 去掉「按账户类型」（`builtin === 1`）。
 *
 * 说明：⭐⭐ 渲染（`tagFieldsHtml`）与读回（`captureForm`）**必须共用这一份**，
 *      ⛔ 别各写一次 `filter((v) => Number(v.builtin) !== 1)`：**只做一头就出事** ——
 *      画面里没有那一格、读回时却送一个空串上去，而服务端 `store.applyTags()` 对
 *      `builtin === 1` **一律拒**（不看值）⇒ **新建与修改全都保存不了**，
 *      表现是底部一条红 toast（报的就是它）。
 *
 * @returns {Array.<Object>} 要画格子的视图（⛔ 不含「按账户类型」）
 */
function tagViewList() {
  return viewList().filter((v) => Number(v.builtin) !== 1);
}

/**
 * 功能：画顶部那排「视图」胶囊 —— 「按账户类型」（内置）＋ 各套自定义分类 ＋ 一颗「⋯」。
 *
 * 说明：⭐ 切视图只重画列表、**不重新取数**（`overview` 一次就给全了）。
 *      ⚠️ 一颗自定义分类都没有时那颗「⋯」也要在（否则没有入口去建第一套）。
 *
 * @param {Array.<Object>} views - `overview.views`
 * @param {?Object} cur - 当前选中的那套（`null` = 按账户类型）
 * @returns {string} 这一行的 HTML
 */
function viewBarHtml(views, cur) {
  const chip = (id, name, on) =>
    `<button class="lg-vchip${on ? ' on' : ''}" type="button" data-act="lg-view" data-id="${Number(id)}" data-drag="chip" data-did="${Number(id)}">${esc(name)}${sortHandleHtml()}</button>`;
  // ⭐ 0.8.0：内置的两颗（按账户类型 / 按账户用途）**也在 `views` 里**（`builtin` 1 / 2）
  //    ⇒ 这一排直接按服务端给的顺序画。⛔ 别再手写一颗「按账户类型」——
  //    写死的话它的位置就永远在最前面，而「胶囊顺序也能拖」这条需求当场作废。
  return `<div class="lg-views">${views
    .map((v) => chip(v.id, v.name, !!cur && Number(cur.id) === Number(v.id)))
    .join('')}<button class="lg-vmore" type="button" data-act="lg-viewmore" title="管理分类">⋯</button></div>`;
}

/**
 * 功能：按**用途**把账户分组画出来（一套自定义分类下的列表）。
 *
 * 说明：⚠️ 组顺序与小计都是**服务端算好的**（`views[].groups`），前端只摆放。
 *      组小计是**代数和**（资产正 / 负债负）⇒ 这里直接用 `fmtFen`，⛔ 不像类型视图那样按侧补负号。
 *      ⚠️「其它」＝ 这套分类下没分的账户；一个都没有时整段不画。
 *
 * @param {Object} v - 一套自定义分类
 * @param {Array.<Object>} accounts - 全部账户
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 列表那一块的 HTML
 */
function tagGroupsHtml(v, accounts, sides) {
  const tagOf = (a) => String((a.tags || {})[v.id] || '').trim();
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));
  const rowOf = (a) => rowHtml(a, sides);
  // ⭐⭐：组内的先后**照服务端给的 `ids`** —— 那是这套分类自己的顺序
  //    （`ledger_view_tags.sort_order`；服务端算好、前端只摆放，与「排序只有一份实现」一致）。
  //    ⚠️ 兜底保留：`ids` 缺了（老响应 / 形状变了）就按「归属相符」过滤 ——
  //    ⛔ 不能让整组静默变成空的（那是「看着没数据」而不是「报错」，最难查）。
  const rowsOf = (key, ids) =>
    Array.isArray(ids) && ids.length
      ? ids
          .map((id) => byId.get(Number(id)))
          .filter(Boolean)
          .map(rowOf)
          .join('')
      : accounts
          .filter((a) => tagOf(a) === key)
          .map(rowOf)
          .join('');
  // ⚠️ `gid` 有值才可拖：内置「按账户用途」的组有 `ledger_groups` 的行 id（可拖），
  //    自建分类的组身份是**用途名文本**（没有行）⇒ 不给拖拽属性（拖了也没地方存顺序）
  const block = (name, total, rows, gid) => `<div class="lg-group">
    <div class="lg-ghead"${gid ? ` data-drag="group" data-gid="${Number(gid)}"` : ''}><span>${esc(name)}</span><b>${esc(fmtFen(total, state.lgHide))}</b>${sortHandleHtml()}</div>
    ${rows}
  </div>`;
  // ⭐⭐ 0.8.0：内置「按账户用途」与自建分类**有两种不同的组**——
  //    · 内置（`builtin = 2`）：组来自 `overview.usages`（**含空组**，因为那 7 个是「字段」），
  //      而归属那一列存的是**用途键**（`u3`）⇒ 必须用 `usageGroupsOf()` 把键翻成名字；
  //    · 自建（`builtin = 0`）：组就是服务端算出来的那几个（用途名当键，原有语义）。
  //    ⚠️ 账目金额两种都**一个不加**：这里只做摆放与翻译。
  const list =
    Number(v.builtin) === 2
      ? usageGroupsOf((state.lg && state.lg.usages) || [], v.groups)
      : (Array.isArray(v.groups) ? v.groups : []).map((g) => ({
          key: g.tag,
          // ⚠️ 自建分类的组身份就是用途名文本；组内顺序同样照服务端给的 ids
          name: g.tag,
          total_fen: g.total_fen,
          ids: g.ids,
        }));
  const out = list.map((g) => block(g.name, g.total_fen, rowsOf(g.key, g.ids), g.id));
  const un = v.unassigned || { total_fen: 0, count: 0 };
  if (Number(un.count) > 0) out.push(block('其它', un.total_fen, rowsOf('')));
  return out.join('');
}

/** 功能：画「管理分类」那一页（各套分类的改名 / 删除 ＋ 末尾「＋ 新建分类」）。 @returns {void} */
function viewManageSheet() {
  const views = viewList();
  const rows = views
    .map((v) => {
      // ⚠️⭐⭐ 内置那两颗（按账户类型 / 按账户用途）**不给改名 / 删除的按钮** ——
      //    它们的名字与存亡由产品定（接口层也会拒）。画了按钮才 400 是最差的一种，
      //    用户以为能改、点了才知道不行。
      const bi = Number(v.builtin) > 0;
      const acts = bi
        ? '<i class="lg-sub">内置</i>'
        : `<button class="btn ghost sm" type="button" data-act="lg-viewren" data-id="${Number(v.id)}">改名</button>` +
          `<button class="btn danger sm" type="button" data-act="lg-viewdel" data-id="${Number(v.id)}">删除</button>`;
      return (
        `<div class="lg-krow"><span class="lg-kmain"><b>${esc(v.name)}</b><i class="lg-sub">${Number(
          (v.groups || []).length,
        )} 组 · ${Number((v.unassigned || {}).count) || 0} 个没分</i></span>` +
        acts +
        '</div>'
      );
    })
    .join('');
  // ⚠️ 上限只数**自建**的：内置两颗不占用户的额度
  const full = views.filter((v) => !Number(v.builtin)).length >= VIEW_MAX;
  const newBtn =
    `<button class="lg-pick lg-newkind" type="button" data-act="lg-viewnew"${full ? ' disabled' : ''}>` +
    `${full ? `＋ 新建分类（已满 ${VIEW_MAX} 个）` : '＋ 新建分类'}</button>`;
  openSheet('管理分类', rows + newBtn + usageManageHtml());
}

/** 功能：「⋯」⇒ 管理分类那一页。 @returns {void} */
export function lgViewManage() {
  viewManageSheet();
}

/**
 * 功能：新建 / 给某套分类改名（同一张表单）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id` 有值 = 改名）
 * @returns {void}
 */
export function lgViewName(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const v = viewList().find((x) => Number(x.id) === id);
  if (id && !v) return;
  pendingView = { mode: id ? 'ren' : 'new', id };
  openSheet(
    id ? '给这个分类改名' : '新建分类',
    `<label class="fld"><span>分类名</span>
      <input id="lg-f-vname" type="text" maxlength="${VIEW_NAME_MAX}" value="${esc(id ? v.name : '')}" /></label>`,
    `<button class="btn primary" type="button" data-act="lg-viewsave" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：存下新建 / 改名，回「管理分类」那一页。
 * @returns {Promise.<void>}
 */
export async function lgViewSave() {
  const el = $('#lg-f-vname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个分类起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const p = pendingView || { mode: 'new', id: 0 };
  try {
    if (p.mode === 'ren') {
      await api('PUT', `/api/ledger/views/${Number(p.id)}`, { name });
    } else {
      const made = await api('POST', '/api/ledger/views', { name });
      // ⭐ 新建之后直接切过去（用户建一套分类就是为了马上按它看）
      state.lgView = Number(made.id);
    }
    await loadLedger();
    viewManageSheet();
    toast(p.mode === 'ren' ? '改好了' : '分类建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 功能：删一套分类（危险确认）—— 文案说清「账户一个都不会变」。 @param {Object} _act - 动作名（未用） @param {Object} n - 触发按钮（`data-id`） @returns {void} */
export function lgViewDel(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const v = viewList().find((x) => Number(x.id) === id);
  if (!v) return;
  askConfirm({
    title: '删除这个分类？',
    text: `删了就找不回来了。⚠️ 账户一个都不会变 —— 只是以后不能按「${v.name}」分组看了。`,
    ok: '永久删除',
    danger: true,
  }).then((ok) => {
    if (ok) viewDelGo(id);
  });
}

/** 功能：真的删（确认之后走这里）。 @param {number} id - 分类 id @returns {Promise.<void>} */
async function viewDelGo(id) {
  try {
    await api('DELETE', `/api/ledger/views/${Number(id)}`);
    if (Number(state.lgView) === Number(id)) state.lgView = 0;
    await loadLedger();
    viewManageSheet();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 内置「按账户用途」的字段管理（0.8.0：可改名 / 可增删） ----------

/**
 * 功能：内置「按账户用途」的那些**字段**（服务端排好序的那一份）。
 *
 * 说明：⭐⭐ 它们与「分类」（`ledger_views`）是两样东西：分类是「按什么看」（视图），
 *      用途是**那个视图里一列的取值**（字段）。所以增删改名住这里，⛔ 不去动分类那一块。
 *      ⚠️ **顺序不在这里管** —— 拖顺序就是「在列表屏长按拖动组标题」，复用同一套机制
 *      （⛔ 不为它单做一处弹层内拖拽，那等于把同一件事实现两遍）。
 *
 * @returns {Array.<Object>} 用途定义（`{id, gkey, name, sort_order, locked}`）
 */
function usageList() {
  return ((state.lg && state.lg.usages) || []).filter((u) => u && u.id);
}

/**
 * 功能：画「管理分类」那页里那块**用途字段**区（一个用途定义都没有时整块不画）。
 * @returns {string} 这一块的 HTML
 */
function usageManageHtml() {
  const list = usageList();
  if (!list.length) return '';
  const rows = list
    .map((u) => {
      // ⚠️ 「其它」是**兜底**（那些没分用途的账户唯一的去处）⇒ 不给删除按钮；
      //    接口层也会拒（`locked`），两头一致
      const locked = Number(u.locked) > 0;
      const acts = locked
        ? '<i class="lg-sub">兜底</i>'
        : `<button class="btn ghost sm" type="button" data-act="lg-usageren" data-id="${Number(u.id)}">改名</button>` +
          `<button class="btn danger sm" type="button" data-act="lg-usagedel" data-id="${Number(u.id)}">删除</button>`;
      return `<div class="lg-krow"><span class="lg-kmain"><b>${esc(u.name)}</b></span>${acts}</div>`;
    })
    .join('');
  const full = list.length >= USAGE_MAX;
  const newBtn =
    `<button class="lg-pick lg-newkind" type="button" data-act="lg-usagenew"${full ? ' disabled' : ''}>` +
    `${full ? `＋ 新建用途（已满 ${USAGE_MAX} 个）` : '＋ 新建用途'}</button>`;
  return (
    '<div class="lg-subcap"><b>「按账户用途」的字段</b>' +
    '<i class="lg-sub">改名之后，归在这组下面的账户会跟着新名走；顺序在列表里长按拖动组标题调整</i></div>' +
    rows +
    newBtn
  );
}

/**
 * 功能：新建 / 给某个用途字段改名（同一张小表单）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id` 有值 = 改名）
 * @returns {void}
 */
export function lgUsageName(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const u = usageList().find((x) => Number(x.id) === id);
  if (id && !u) return;
  pendingUsage = id;
  openSheet(
    id ? '给这个用途改名' : '新建用途',
    `<label class="fld"><span>用途名</span>
      <input id="lg-f-uname" type="text" maxlength="${TAG_MAX}" value="${esc(id ? u.name : '')}" /></label>` +
      // ⚠️ 这句必须写出来：用户最怕的就是「改个名，原来的账户全掉了」
      (id ? '<p class="lg-tip">已经归在这个用途下的账户会<b>跟着新名走</b>，一笔都不会掉。</p>' : ''),
    '<button class="btn primary" type="button" data-act="lg-usagesave" style="flex:1.4">保存</button>',
  );
}

/**
 * 功能：存下新建 / 改名的结果，回「管理分类」那一页。
 * @returns {Promise.<void>}
 */
export async function lgUsageSave() {
  const el = $('#lg-f-uname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个用途起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const id = Number(pendingUsage) || 0;
  try {
    if (id) await api('PUT', `/api/ledger/usages/${id}`, { name });
    else await api('POST', '/api/ledger/usages', { name });
    await loadLedger();
    viewManageSheet();
    toast(id ? '改好了' : '用途建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：删一个用途字段（危险确认）—— 文案说清「那些账户去哪了」。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id`）
 * @returns {void}
 */
export function lgUsageDel(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const u = usageList().find((x) => Number(x.id) === id);
  if (!u) return;
  askConfirm({
    title: '删除这个用途？',
    text: `删了就找不回来了。原本归在「${u.name}」下面的账户会挪到「其它」，账户本身一个都不会少。`,
    ok: '永久删除',
    danger: true,
  }).then((ok) => {
    if (ok) usageDelGo(id);
  });
}

/** 功能：真的删（确认之后走这里）。 @param {number} id - 用途字段的行 id @returns {Promise.<void>} */
async function usageDelGo(id) {
  try {
    await api('DELETE', `/api/ledger/usages/${Number(id)}`);
    await loadLedger();
    viewManageSheet();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：画账户表单里那几格「分类」（一套分类一格）—— 每套都问「这个账户算哪一类用途」。
 * @param {Object} d - 草稿（`d.tags` 是 `{ <viewId>: <用途> }`）
 * @returns {string} 这几格的 HTML（一套分类都没有时是空串）
 */
function tagFieldsHtml(d) {
  const tags = (d && d.tags) || {};
  // ⚠️⭐⭐ 「按账户类型」那一套**不画这一格**（指着截图指出来的）：
  //    账户的类型就是**左边选的那个**（组由 `kind` 决定），给它一格等于把同一个问题问第二遍；
  //    ⚠️ 而且它**本来就不许设** —— `store.applyTags()` 对 `builtin === 1` 一律 400，
  //    所以从前画了它，用户选「＋ 新建用途…」填完一提交**只会拿到一个报错**。
  //    ⇒ 服务端拒 + 前端不画，两头一致（⛔ 别只做一头）。
  // ⚠️⭐⭐ 用 `tagViewList()`（渲染与读回**同一份**清单，见它的说明）
  return tagViewList()
    .map((v) => tagFieldHtml(v, String(tags[v.id] || '')))
    .join('');
}

/**
 * 功能：点顶部胶囊 ⇒ 换个视图看（⛔ 不重新取数：`overview` 一次就给全了）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（`data-id`：0 = 按账户类型）
 * @returns {void}
 */
export function lgViewChip(_act, n) {
  state.lgView = Number((n && n.dataset && n.dataset.id) || 0);
  renderLedger();
}

/**
 * 功能：画「某个分类下，这个账户算哪一类用途」那一格。
 *
 * 说明：⚠️ 用途**从这套分类已有的用途里选**（＋「＋ 新建用途…」与「不分类」）——⛔ 不做自由文本
 *      （那会让「日常」和「日常使用」变成两个组）。结构是「label ＋ 可替换的盒子」：
 *      选了「＋ 新建用途…」只换盒子里的控件（⛔ 不重画整个弹层，免得抹掉别的字段）。
 *
 * @param {Object} v - 一套自定义分类
 * @param {string} cur - 当前用途（空串 = 没分）
 * @returns {string} 这一格的 HTML
 */
function tagFieldHtml(v, cur) {
  return `<label class="fld" id="lg-f-tag-${Number(v.id)}wrap"><span id="lg-f-taglabel-${Number(v.id)}">${esc(v.name)}</span>
      <span id="lg-f-tagbox-${Number(v.id)}">${tagSelectHtml(v, cur)}</span></label>`;
}

/**
 * 功能：画那一格里的下拉（不分类 / 已有的用途 / ＋ 新建用途…）。
 * @param {Object} v - 一套自定义分类
 * @param {string} cur - 当前用途
 * @returns {string} `<select>` 的 HTML
 */
function tagSelectHtml(v, cur) {
  const one = (val, text) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(text)}</option>`;
  // ⭐⭐ 内置「按账户用途」的选项来自 `overview.usages`：**值 = 用途键、文字 = 用途名**。
  //    ⛔ 不许拿名字当值 —— 那就等于把「改名不影响归属」这条设计从中间掐断
  //    （改一次名，归在那组下面的账户会静默掉到「其它」）。
  //    ⚠️ 也不给它「＋ 新建用途…」：内置那 7 个是**字段**，增删入口在「管理分类」那一页，
  //    混进这一格会让「新建」有两种语义（一个是加字段、一个是随手打个新组名）。
  const builtin = Number(v.builtin) || 0;
  const opts =
    builtin === 2
      ? ((state.lg && state.lg.usages) || []).map((u) => ({ val: String(u.gkey), text: String(u.name) }))
      : (Array.isArray(v.groups) ? v.groups : []).map((g) => ({ val: String(g.tag), text: String(g.tag) }));
  const newOpt = builtin === 2 ? '' : one('__new__', '＋ 新建用途…');
  return `<select id="lg-f-tag-${Number(v.id)}" data-tagview="${Number(v.id)}">${one('', '不分类')}${opts
    .map((o) => one(o.val, o.text))
    .join('')}${newOpt}</select>`;
}

/**
 * 功能：在下拉里选了「＋ 新建用途…」⇒ 把**那一格**换成输入框。
 * @param {Object} sel - 那个 `<select>` 元素
 * @returns {void}
 */
function askNewTag(sel) {
  const vid = Number(sel && sel.dataset && sel.dataset.tagview);
  const box = $(`#lg-f-tagbox-${vid}`);
  if (!box) return;
  box.innerHTML = `<input id="lg-f-tagnew-${vid}" type="text" maxlength="${TAG_MAX}" />`;
  const inp = $(`#lg-f-tagnew-${vid}`);
  if (inp) inp.focus();
}

// ---------- 账户详情（二级屏，照参考图 1）：转账 · 调整余额 · 明细 ----------

/**
 * 功能：按 id 从当前 `overview` 里找账户（找不到回 `null`）。
 * @param {number} id - 账户 id
 * @returns {?Object} 那个账户
 */
function accountOf(id) {
  const rid = Number(id) || 0;
  if (!rid) return null;
  return ((state.lg && state.lg.accounts) || []).find((x) => Number(x.id) === rid) || null;
}

/**
 * 功能：账户的显示名 —— 有后四位就带上（`工商银行(1904)`）。
 *
 * 说明：⚠️ 转账弹层、明细里的「对方账户」、详情卡的标题全用它 ⇒ 三处同一个写法
 *      （⛔ 别各拼一份：同一家银行在两处一个带后四位一个不带，看着像两个账户）。
 * @param {Object} a - 账户
 * @returns {string} 显示名
 */
function labelOf(a) {
  return a && a.tail ? `${a.name}(${a.tail})` : String((a && a.name) || '');
}

/**
 * 功能：画详情屏顶上那条 —— `‹ 返回` ＋ 「资产详情」 ＋ 眼睛。
 *
 * 说明：⭐ 顶栏（宿主那条 `ZX ｜ 记账`）在这一屏**收起来**（`.topbar-bare`，
 *      与对话的会话页同一手法）⇒ 标题与返回都在这里，⛔ 不会出现两个标题摞在一起。
 * @returns {string} 这一条的 HTML
 */
function detailHeadHtml() {
  return `<div class="lg-dhead">
    <button class="lg-back" type="button" data-act="lg-back" aria-label="返回">‹</button>
    <b>资产详情</b>
    ${eyeHtml()}
  </div>`;
}

/**
 * 功能：画详情屏顶上那张**账户卡** —— 图标 ＋ 名称 ＋ 类型 ＋ 备注 ＋ 余额 ＋「调整余额」。
 *
 * 说明：⚠️ 余额与列表行**同口径**（负债侧带 `-`）：同一个数在两处显示成两种样子是最容易
 *      让人怀疑「哪个才是真的」的那种不一致（侧由服务端 `groups[].side` 决定）。
 *
 * @param {Object} a - 账户
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 这张卡的 HTML
 */
function detailCardHtml(a, sides) {
  const m = metaOf(a.kind);
  return `<div class="lg-dcard">
    <div class="lg-dtop">${icoBlockHtml(a)}
      <span class="lg-dmain"><b>${esc(labelOf(a))}</b><i class="lg-dtag">${esc(m.name)}</i></span>
    </div>
    ${a.note ? `<div class="lg-dnote">${esc(a.note)}</div>` : ''}
    ${limitBlockHtml(a)}
    <div class="lg-dbal">
      <span><b>${esc(fmtSide(a.opening_fen, sides.get(a.kind), state.lgHide))}</b><i>余额</i></span>
      <button class="lg-dadj" type="button" data-act="lg-balance">调整余额</button>
    </div>
  </div>`;
}

/**
 * ⭐ 0.8.1（§7.4 / C-22）：账户详情那一段「变动类型」过滤的四个档。
 *
 * 说明：⚠️ 四个 key **就是服务端那条接口认识的四个值**（`routes.js` 已白名单校验）——
 *      ⛔ 这里不许另起一套名字再翻译一次（多一层映射就多一处会漂的地方）。
 *      ⚠️ 选中的那一档住 `state.lgType`（内存），⛔ 不落 localStorage。
 * @type {Array.<{key: string, name: string}>}
 */
const CHG_TYPES = [
  { key: 'all', name: '全部' },
  { key: 'entry', name: '记账' },
  { key: 'transfer', name: '转账' },
  { key: 'adjust', name: '调整' },
];

/**
 * 功能：画详情屏顶上那条 —— `收支明细` ＋ 两颗下拉（**变动类型** ＋ **月份**，并排）。
 *
 * 说明：⚠️ 月份那颗的 `id` 是 `lg-c-month`（c = changes）：**两端各一份 DOM**，
 *      所以两边的 id 也可以不一样 —— ⛔ 别为了"同名"去借 1 期那颗 `lg-f-month` 的 id
 *      （那是另一条屏上的控件，同一个框里出现两个同名节点是查起来最久的那种）。
 *      ⭐⭐ 0.8.21（「这几个【全部、记账、转账、调整】变成下拉列表放到日期下拉
 *      列表左侧，不再单独一行」）：那一排**胶囊撤了**，换成第二颗原生 `<select>`（`lg-c-type`），
 *      与月份那颗并排住同一条头里 —— 省掉整整一行，四项也仍然点得到。
 *      ⚠️⭐ 它走的是**原生 `change`**（与月份那颗同一条），判据住 `bindLedgerOnce()`；
 *      ⛔ 不再是 `data-act` 那颗胶囊（`lgChgType` 已随胶囊一起删掉）。
 * @returns {string} 这一条的 HTML
 */
function chgHeadHtml() {
  const opts = chgMonthOptions()
    .map((k) => `<option value="${esc(k)}"${k === chgMonthKey() ? ' selected' : ''}>${esc(monthLabel(k))}</option>`)
    .join('');
  const tOpts = CHG_TYPES.map(
    (t) => `<option value="${esc(t.key)}"${t.key === state.lgType ? ' selected' : ''}>${esc(t.name)}</option>`,
  ).join('');
  return `<div class="lg-txhead"><b>收支明细</b>
    <span class="lg-txfilters">
      <select id="lg-c-type" aria-label="选择变动类型">${tOpts}</select>
      <select id="lg-c-month" aria-label="选择月份">${opts}</select>
    </span></div>`;
}

/**
 * 功能：画账户详情里的一条**变动** —— 三类（记账 / 转账 / 手动调整）各画各的，颜色走三档令牌。
 *
 * 说明：⭐⭐ **三档颜色只住 `entry-calc.js` 的 `TONE_COLORS`**（C-21 / §7.4）：这一行只把
 *      `toneStyle(type)` 返回的那一句 CSS 声明贴到元素上，CSS 里写 `color: var(--lg-tone-*)`
 *      —— ⛔ 本文件一个色值都不许写（写两处就会出现"电脑端是蓝的、手机端是紫的"，
 *      而那两份色值还都是"对的"，没人会报错）。类名也由 `changeTone()` 给，⛔ 不手拼 `tone-*`。
 *      ⚠️ 转账那一行**不下发 `date` 而是 `at`**（手机端这份 `/changes` 的转账行时刻字段与 1 期
 *      `/transfers` 的 `date` 不同）⇒ 方向仍走 `txOf()`（它只读 `from_id` / `to_id`），
 *      而**时刻用 `shortAt(c.at)`**，`fmtTx()` 只用它的金额与方向（⛔ 不再自己算一遍符号）。
 *      ⚠️ 手动调整那一条**只显示「从 X 改成 Y」**，⛔ 不在这里算差额。
 * @param {Object} c - 一条变动（带 `type`）
 * @param {Object} a - 正在看哪个账户
 * @param {Map.<number, string>} names - 账户 id → 名字（⭐ 转账那一行要用它取**对方账户**的名字）
 * @returns {string} 这一行的 HTML
 */
function chgRowHtml(c, a, names) {
  const cls = `lg-chgrow ${changeTone(c.type)}`;
  const st = toneStyle(c.type);
  if (c.type === 'transfer') {
    const { dir, peerId } = txOf(c, a.id);
    // ⚠️⭐ 对方账户可能是**已删账户**（删账户不删转账，C-8）⇒ 走**同一个** `acctNameMap()`：
    //    「先活账户、查不到再查合并视图」这条顺序只住它那一处，⛔ 不在这里再判一遍。
    const name = names.get(Number(peerId)) || '已删除的账户';
    const sub = [shortAt(c.at), String(c.note || '')].filter(Boolean).join(' · ');
    // ⚠️ 「转出 / 转入」这几个字与符号各说一遍是**刻意的**：负债侧账户（信用卡）看着「转入」
    //    而欠款减少时，只给符号会读不通（1 期那次明细就是这个口径，⛔ 别在这里改掉）。
    return `<div class="${cls}" style="${st}">
      <span class="lg-chgmain"><b class="lg-chgtag">转账</b>${dir === 'out' ? '转出 · 到 ' : '转入 · 来自 '}${esc(name)}${
        sub ? `<i class="lg-sub">${esc(sub)}</i>` : ''
      }</span>
      <b class="lg-chgamt">${esc(fmtTx(c, a.id, state.lgHide))}</b>
    </div>`;
  }
  if (c.type === 'adjust') {
    return `<div class="${cls}" style="${st}">
      <span class="lg-chgmain"><b class="lg-chgtag">调整余额</b>
        <i class="lg-sub">${esc(shortAt(c.at))} · 从 ${esc(fmtFen(c.from_fen, state.lgHide))} 改成 ${esc(
          fmtFen(c.to_fen, state.lgHide),
        )}</i></span>
      <b class="lg-chgamt"></b>
    </div>`;
  }
  const rf = refundNoteOf(c, state.lgChg, state.lgHide);
  const parts = [];
  if (c.note) parts.push(String(c.note));
  return `<div class="${cls}" style="${st}">
    <span class="lg-chgmain"><b class="lg-chgtag">记账</b>${esc(entryTitle(c, state.lgCats))}${
      parts.length ? `<i class="lg-sub">${esc(parts.join(' · '))}</i>` : ''
    }${rf ? `<i class="lg-rfnote">${esc(rf)}</i>` : ''}</span>
    <b class="lg-chgamt">${esc(fmtSignedFen(signedFen(c.ie, c.amount_fen), state.lgHide))}</b>
  </div>`;
}

/**
 * 功能：画明细那一块 —— **三态分得开**：读取中 / 读不到（一句人话 ＋ 重试） / 这个月没有。
 *
 * 说明：⭐⭐ 三态必须分开：「读取中」「一条都没有」「没读到」是**三件不同的事**——
 *      把失败画成空态＝把错误藏起来（用户会以为"我确实没转过账"）。
 *      ⭐⭐ 0.8.21（「这个里的记账条数应该按天区分显示」）：**按天分组**显示 ——
 *      分组走 `entry-calc.js` 的 `groupByDay()`（**两端同一套**：天倒序、天内 `(at, id)` 倒序），
 *      所以"服务端已经排好"这件事在分组之后**依然成立**，⛔ 不会把「同一天里 记账 与 转账」
 *      的先后顺序换掉（那才是第二条顺序口径）。
 *      ⚠️ 组标题右那两个数是**这一天**的收入 / 支出，只由 `groupByDay()` 从带 `ie` 的**记账**行
 *      汇出来（转账 / 调整没有 `ie` ⇒ 不进那两个数）；两个数都为 0 时**整个小计不画**。
 * @param {Object} a - 正在看哪个账户
 * @returns {string} 明细那一块的 HTML
 */
function chgListHtml(a) {
  if (state.lgChgLoad === 'error') {
    return `<div class="err-box"><b>明细没读到</b><p>${esc(state.lgChgErr || '原因不明')}</p>
      <button class="chip on" type="button" data-act="lg-chgagain" style="margin-top:14px">重新加载</button></div>`;
  }
  if (state.lgChgLoad === 'loading' && !state.lgChg.length) return '<div class="lg-txwait">正在读取…</div>';
  if (!state.lgChg.length) {
    return `<div class="empty slim"><div class="e-ico">🧾</div><h3>这个月还没有记录</h3>
      <p>记账 / 转账 / 调整余额都会出现在这里。</p></div>`;
  }
  // ⚠️ 这一句「正在读取…」**只许画一处**：手上已经有行、还在取下一页时，指示条归
  //    `chgMoreHtml()`（列表底下，用户正看着的地方）；这里再画一条会让同一句话在一屏上
  //    出现两遍 —— 而且**不会报错**（换月 / 换类型时列表已被清空，走的是上面那条早返回）。
  // ⭐ 2 期：明细里的转账行要取**对方账户**的名字（可能是已删账户）⇒ 与流水用同一份 map
  const names = acctNameMap();
  return groupByDay(state.lgChg, 'at').map((g) => chgDayHtml(g, a, names)).join('');
}

/**
 * 功能：明细里的**一天** —— 日期头（左边日期 ＋ 星期，右边这一天的收支小计）＋ 当天那几条变动。
 *
 * 说明：⚠️ 日期头的版式与流水屏 `.lg-eday` **同一套**（类名与 `dayHeadLabel()` 都复用），
 *      ⛔ 不另起一个"账户详情专用的日期头"。
 *      ⚠️⚠️ 掩码那个实参**必须逐字写 `state.lgHide`** —— `ttt/test/ledger.test.js` 有一条护栏
 *      扫全文的 `fmtFen(` / `fmtSide(` / `fmtTx(`，要求每处都带这个开关。
 * @param {{date: string, items: Array.<Object>, income_fen: number, expense_fen: number}} g - 一天的分组
 * @param {Object} a - 正在看哪个账户
 * @param {Map.<number, string>} names - 账户 id → 名字
 * @returns {string} 这一天的 HTML
 * @since 0.8.21
 */
function chgDayHtml(g, a, names) {
  const inc = Number(g.income_fen) || 0;
  const exp = Number(g.expense_fen) || 0;
  // ⚠️ 两个小计中间那个**全角空格**走 `join()` 的**字符串字面量**参数（与流水屏同一句）：
  //    ⛔ 不直接嵌进模板串、也⛔ 不抄进注释 —— `no-irregular-whitespace` 不跳过模板串与注释。
  const sum =
    inc || exp
      ? `<span>${esc([`收入: ${fmtFen(inc, state.lgHide)}`, `支出: ${fmtFen(exp, state.lgHide)}`].join('　'))}</span>`
      : '';
  const head = `<div class="lg-eday"><b>${esc(g.date ? dayHeadLabel(g.date) : '时刻缺失')}</b>${sum}</div>`;
  return head + g.items.map((c) => chgRowHtml(c, a, names)).join('');
}

/**
 * 功能：详情屏底下那条「加载更多」（到底了 / 读不到时整条不画）。
 *
 * ⭐⭐ 0.8.21（「手机端-资产详情的【加载更多】应该是条目滑动到底才显示的，
 *      而不是一直显示」）：它现在**画在那条变动明细里面**（`detailHtml()` 把它放进 `.lg-txlist`）
 *      —— 它是那一格的**滚动内容**，只有滚到列表底部才看得到。
 *      ⚠️ 从前它是 `.lg-txlist` 的**兄弟**（纵向 flex 里被钉在列表下沿）⇒ 一进屏就顶在
 *      三颗动作上面，像一颗常驻按钮。与 0.8.21 明细屏那条「加载更多」同一条处置。
 * @returns {string} 这一段的 HTML
 */
function chgMoreHtml() {
  if (state.lgChgLoad === 'loading' && state.lgChg.length) return '<div class="lg-txwait">正在读取…</div>';
  if (state.lgChgLoad !== 'done' || state.lgChgDone) return '';
  return '<button class="lg-more" type="button" data-act="lg-chgmore">加载更多</button>';
}

/**
 * 功能：画详情屏整块（头部 ＋ 账户卡 ＋ 收支明细头（两颗下拉）＋ 三类明细 ＋ 底部三颗动作）。
 * @param {Object} a - 账户
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 这一屏的 HTML
 */
function detailHtml(a, sides) {
  return `<div class="lg-detail">
    ${detailHeadHtml()}
    ${detailCardHtml(a, sides)}
    ${chgHeadHtml()}
    <div class="lg-txlist">${chgListHtml(a)}${chgMoreHtml()}</div>
    <div class="lg-dacts">
      <button class="lg-dact" type="button" data-act="lg-transfer">转账</button>
      <button class="lg-dact" type="button" data-act="lg-edit" data-id="${Number(a.id)}">设置</button>
      <button class="lg-dact danger" type="button" data-act="lg-del" data-id="${Number(a.id)}">删除资产</button>
    </div>
  </div>`;
}

/**
 * 功能：进**账户详情**（取三类变动 + 重画这一屏）。
 *
 * 说明：⭐ 明细是**单独一次请求**（`GET /api/ledger/accounts/:id/changes`）：一屏一次给全那条
 *      纪律管的是**列表屏**，而这一屏的明细按账户 / 按月份 / 按类型取，塞进 `overview` 会让
 *      每次进列表都白拉一份可能很长的明细。
 *      ⚠️ 进这一屏要把类型过滤复位成「全部」（与电脑端同款：上次筛的是转账，这次进来
 *      只看到转账、而用户以为"记账没了"是不报错的那类错）。
 *
 * @param {number} id - 账户 id
 * @returns {Promise.<void>}
 */
export async function openLedgerAccount(id) {
  const rid = Number(id) || 0;
  if (!rid) return;
  state.lgAcct = rid;
  state.lgChg = [];
  state.lgChgLoad = 'idle';
  state.lgChgErr = '';
  state.lgType = 'all';
  // ⭐ 默认落在「服务端今天」那个月（⛔ 不用本机日期）
  state.lgChgMonth = monthOf((state.lg && state.lg.today) || '');
  await loadChanges(true);
  // ⭐⭐ 0.8.21（「这个月份选择根本选择不了，只有本月」）：月份下拉的主来源是
  //    服务端的期间清单（`/api/ledger/periods` 的 `months`，见 `chgMonthOptions()`）——
  //    第一次进详情时顺手取一次。⚠️⭐ 它**不 await**（明细那条请求已经先跑完了，不用拖住它）；
  //    取回来它自己会 `renderLedger()`（`loadPeriods()` 里那句），下拉就补齐了。
  if (!state.lgPeriods) loadPeriods();
}

/** 功能：列表屏点某一行 ⇒ 进它的详情。 @param {Object} _act - 动作名（未用） @param {Object} _n - 触发按钮（未用） @param {Function} id - 取 `data-id` 的函数 @returns {void} */
export function lgOpen(_act, _n, id) {
  openLedgerAccount(Number(id()));
}

/**
 * 功能：「‹ 返回」⇒ 回列表屏（并把这几个只属于详情屏的临时状态清掉）。
 *
 * 说明：⚠️ 必须清月份 / 明细 / 错误文案：不清的话，下次点开**另一个**账户会先带着上一个
 *      账户选过的月份与错误文案（错误文案尤其糟：一个已经取成功的账户顶上挂着"没读到"）。
 *      ⚠️ 回到哪一段？——⭐ **回到它原来那一段**（`state.lgSeg` 不动）：从「资产」点进来的
 *      就回资产，从「记账」点进来的就回记账（⛔ 别把人硬拽到另一段去 —— 那也是一次"导航"）。
 * @returns {void}
 */
export function lgBack() {
  state.lgAcct = 0;
  state.lgChg = [];
  state.lgChgCursor = null;
  state.lgChgDone = false;
  state.lgChgLoad = 'idle';
  state.lgChgErr = '';
  state.lgChgMonth = '';
  renderLedger();
}

/**
 * 功能：**按手机的系统返回键时退一层** —— 这一屏有没有自己的二级屏，有就退掉一个。
 *
 * 说明：⭐⭐ 0.8.5（「返回是回到**上一级**页面，而不是**上一次**页面」）：
 *      这一屏的二级屏（账户详情 / 月详情页 / 设置子页）以前**不参与历史** ⇒ 按返回会
 *      **直接离开记账**（退到上一个标签），而不是退回记账首页。宿主在 `popstate` 里问这里一句，
 *      由本函数按"由深到浅"依次退一层。
 *      ⚠️ 三个子屏互斥（同时只会有一个开着），所以顺序只是保险：设置子页 → 月详情 → 账户详情。
 *      ⚠️ 退的具体动作**复用各子屏自绘那颗「‹ 返回」的同一个函数**（`lgSetBack` / `lgMdBack` / `lgBack`）——
 *      ⛔ 别在这儿另写一份"清状态 + 重画"，那样两条路的收尾迟早会不一样。
 *
 * @returns {boolean} 真 = 退了一层（宿主据此吞掉这次返回）；假 = 已经在第一层，返回该往屏外走
 */
export function lgBackLayer() {
  if (state.lgSetPage) {
    lgSetBack();
    return true;
  }
  if (state.lgMdMonth) {
    lgMdBack();
    return true;
  }
  if (state.lgAcct) {
    lgBack();
    return true;
  }
  return false;
}

/**
 * 功能：切账户详情那颗「变动类型」下拉（`all` / `entry` / `transfer` / `adjust`）。
 *
 * 说明：⭐⭐ 换类型**必须重新取数**：那一份是按 `type` 在服务端筛的，手上这一页只有 30 条
 *      ⇒ 从手上这份里筛出来永远只有一小截，而界面**不报任何错**。
 *      ⚠️ 它是**原生 `<select>` 的 `change`**（不是 `data-act` 的动作）—— 那颗下拉由
 *      `chgHeadHtml()` 画、分支住 `bindLedgerOnce()`；动作表里的 `lg-chgtype` 已随胶囊撤掉。
 * @param {string} value - 下拉当前选中的档（不在白名单里就当没发生）
 * @returns {Promise.<void>}
 */
async function pickChgType(value) {
  const k = String(value || '');
  if (!CHG_TYPES.some((t) => t.key === k) || state.lgType === k) return;
  state.lgType = k;
  await loadChanges(true);
}

/** 功能：「明细没读到」那颗重试（从第一页重取）。 @returns {Promise.<void>} */
export async function lgChgAgain() {
  await loadChanges(true);
}

/** 功能：详情屏底下那颗「加载更多」（游标往后取一页）。 @returns {Promise.<void>} */
export async function lgChgMore() {
  await loadChanges(false);
}

/**
 * 功能：点眼睛 ⇒ 把所有金额糊成圆点 / 还原，并把这次的选择**记进账号偏好**（两端同步）。
 *
 * ⭐⭐ 0.8.21（「隐藏要具有记忆功能：也就是我隐藏了，下次进入还是隐藏状态。
 *      并且手机端和电脑端同步」）：从前它只改内存（`state.lgHide`），刷新就回来 —— 于是
 *      「我明明藏起来了，下次进来又全露着」。现在落成 `users.hide_ledger_amount`
 *      （走 `PUT /api/auth/prefs` 的 `hideLedgerAmount`，与那十一个模块开关同一条通道）。
 *
 * 说明：⚠️⭐ 本地那份 `state.me` 必须**一起改**：`mountLedger()` 每次进屏都拿它当初值
 *      ⇒ 只发请求不改它，同一会话里退出再进这一屏就会被旧值盖回去（看着像"没记住"）。
 *      ⚠️ 请求失败**不打扰用户**：记不住只是「下次又显示出来」，不值得为此打断一次点击；
 *      也**不把界面翻回去**（眼睛已经变了，再悄悄翻回来更让人困惑）。
 *      ⚠️ 与电脑端 `pickEye()` **逐字同款**（版式各一份，但这条是行为口径，改一处要改两处）。
 * @returns {void}
 */
export function lgEye() {
  state.lgHide = !state.lgHide;
  if (state.me) state.me.hide_ledger_amount = state.lgHide ? 1 : 0;
  api('PUT', '/api/auth/prefs', { hideLedgerAmount: !!state.lgHide }).catch(() => {});
  renderLedger();
}

/**
 * 功能：开「转账」弹层（从详情屏进，转出账户就是当前这个账户）。
 *
 * 说明：⚠️ 金额**不自己画数字键盘**（`inputmode="decimal"` 交给手机 OS —— 参考图 2 下半屏
 *      那个键盘是系统的，不是我们画的）。
 *      ⚠️ 一个别的账户都没有时**不去开一个空下拉**：直接把话说明白（点了没反应是最差的形态）。
 * @returns {void}
 */
export function lgTransfer() {
  const a = accountOf(state.lgAcct);
  if (!a) return;
  const others = ((state.lg && state.lg.accounts) || []).filter((x) => Number(x.id) !== Number(a.id));
  if (!others.length) {
    toast('还没有别的账户可以转 —— 先加一个', true);
    return;
  }
  const opts = others.map((x) => `<option value="${Number(x.id)}">${esc(labelOf(x))}</option>`).join('');
  openSheet(
    '转账',
    `<div class="lg-xfrom"><span>转出账户</span><b>${esc(labelOf(a))}</b>
       <i>余额 ${esc(fmtSide(a.opening_fen, sideMapOf(state.lg).get(a.kind), state.lgHide))}</i></div>
     <label class="fld"><span>转入账户</span><select id="lg-f-to">${opts}</select></label>
     <label class="fld"><span>转账金额</span><input id="lg-f-xamt" type="text" inputmode="decimal" /></label>
     <label class="fld"><span>备注（可以空着）</span><input id="lg-f-xnote" type="text" maxlength="${NOTE_MAX}" /></label>
     <div class="m-tip">转账只是把钱从一个账户挪到另一个账户，不是收入也不是支出 ——
       净资产一分都不会变。余额不够的话，先在详情页「调整余额」。</div>`,
    `<button class="btn primary" type="button" data-act="lg-xsave" style="flex:1.4">确认转账</button>`,
  );
  const el = $('#lg-f-xamt');
  if (el) el.focus();
}

/**
 * 功能：把转账提交上去 —— ⛔ **金额的校验交给服务端**（唯一一份判据）。
 *
 * 说明：⚠️ 本地只拦「没选转入账户」「金额空着」这两条**表单语义**检查；金额串原样发上去，
 *      服务端判不过就 400，那句文案原样弹给用户（「余额不够」「这张卡欠的没这么多」都在那边）。
 *      ⚠️ 成功后**两次重取**：`loadLedger()`（余额 / 净值 / 分组全变了）＋ `openLedgerAccount()`
 *      （刚转的那笔要出现在明细最上面）—— 少哪一次都会「界面上还显示着转账前的样子」。
 * @returns {Promise.<void>}
 */
export async function lgTransferSave() {
  const a = accountOf(state.lgAcct);
  if (!a) return;
  const to = Number(($('#lg-f-to') || {}).value || 0);
  const amt = String(($('#lg-f-xamt') || {}).value || '').trim();
  const note = String(($('#lg-f-xnote') || {}).value || '').trim();
  if (!to) {
    toast('选一个转给谁', true);
    return;
  }
  if (!amt) {
    toast('填一下转多少', true);
    const el = $('#lg-f-xamt');
    if (el) el.focus();
    return;
  }
  try {
    await api('POST', '/api/ledger/transfers', { from_id: Number(a.id), to_id: to, amount: amt, note });
    closeSheet();
    toast('转好了');
    await loadLedger();
    await openLedgerAccount(a.id);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：开「调整余额」弹层（照参考图 1 卡上那颗按钮）。
 *
 * 说明：⚠️ 走的是**既有的逐键改**接口（`PUT /api/ledger/accounts/:id` 只带 `opening`）——
 *      ⛔ 不为它单开一个接口（那会造出第二份「金额怎么解析」的路径）。
 * @returns {void}
 */
export function lgBalance() {
  const a = accountOf(state.lgAcct);
  if (!a) return;
  openSheet(
    '调整余额',
    `<label class="fld"><span>余额</span>
       <input id="lg-f-bal" type="text" inputmode="decimal" value="${esc(fenToInput(a.opening_fen))}" /></label>
     <div class="m-tip">「调整余额」之前的记账将不会导致余额变化</div>`,
    `<button class="btn primary" type="button" data-act="lg-bsave" style="flex:1.4">保存</button>`,
  );
  const el = $('#lg-f-bal');
  if (el) {
    el.focus();
    el.select();
  }
}

/**
 * 功能：存下新的余额（⛔ 格式校验同样交给服务端）。
 * @returns {Promise.<void>}
 */
export async function lgBalanceSave() {
  const a = accountOf(state.lgAcct);
  if (!a) return;
  const el = $('#lg-f-bal');
  const v = String((el && el.value) || '').trim();
  if (!v) {
    toast('填一下金额（没有就填 0）', true);
    if (el) el.focus();
    return;
  }
  try {
    await api('PUT', `/api/ledger/accounts/${Number(a.id)}`, { opening: v });
    closeSheet();
    toast('改好了');
    // ⚠️ 余额变了 ⇒ `overview` 与**明细**都要重取（调整余额本身也是三类变动里的一条）。
    await loadLedger();
    await loadChanges(true);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 拖动排序（手机端：长按进入拖动） ----------

/** 长按多久算「要拖东西」（毫秒）—— 太短会和滚动抢，太长用户以为没反应 */
const PRESS_MS = 380;

/**
 * 手指一动超过这么多像素就当成「想滚动」，放弃长按（⛔ 别和滚动抢）。
 *
 * ⚠️ 这个值**不能太小**：真机上手指按住 380ms 很难完全不动（轻微抖动很常见），
 * 阈值过紧的表现就是「我明明长按了，怎么没反应」—— 正是这个。
 * 12px 仍能可靠区分「我想滚」（一次滑动通常几十像素）与「手抖」。
 */
const PRESS_SLOP = 12;

/**
 * 长按中的那一次按下（`null` = 没在按）。
 * @type {?{el: HTMLElement, x: number, y: number, timer: number}}
 */
let press = null;

/**
 * 正在拖动的那一个（`null` = 没在拖）。
 * @type {?{el: HTMLElement, kind: string, siblings: Array.<HTMLElement>, over: ?HTMLElement}}
 */
let move = null;

/**
 * 刚拖完到这一刻之间到达的点击要**吞掉**。
 *
 * 说明：⚠️ 拖动结束那一下松手，浏览器还会照常派发一次 `click` ⇒ 不拦的话
 *      「长按把账户挪了个位置」会顺手把账户详情打开（用户看到的是一次莫名其妙的跳转）。
 * @type {number}
 */
let swallowUntil = 0;

/**
 * 「排序模式」开着没有（`true` = 用户刚长按过某个可拖元素、正等着拖）。
 *
 * 说明：⭐⭐ 0.8.4 起手机端的拖动**分两步**：① 长按 ⇒ **进排序模式**（不抓东西，只把
 *      「拖拽柄」画出来 ＋ 顶上给一条「完成」）；② 按住那颗柄才真的拖。
 *      ⚠️ 为什么必须分成两步（第三次报「一滑动就停」）：`touch-action`
 *      只在**手势开始的那一刻**被浏览器读一次 ⇒ 长按到点之后再补 `touch-action: none`
 *      **对手指这一趟完全无效**，浏览器照旧把手势判成滚动、当场派发 `pointercancel`
 *      把拖动打断。把柄在**手势开始之前**就已经画在屏幕上（它带静态 `touch-action: none`），
 *      所以按住它开始时浏览器一开始就知道"这一趟不滚" ⇒ 拖动才真的跟手。
 *      ⚠️ 它是**当前这一屏的临时态**：不落 state、不落库，换格 / 重进记账都清掉。
 * @type {boolean}
 */
let sortMode = false;

/** 功能：排序模式下挂在可拖元素里的**拖拽柄**（⚠️ 它带**静态** `touch-action: none`，见 app.css）。 @returns {string} */
function sortHandleHtml() {
  return sortMode ? '<i class="lg-handle" data-handle="1" aria-hidden="true"></i>' : '';
}

/** 功能：资产那一格顶上的**排序条**（只在排序模式里画）—— 说清怎么拖 ＋ 一颗「完成」。 @returns {string} */
function sortBarHtml() {
  if (!sortMode) return '';
  return `<div class="lg-sortbar"><span>按住右侧把手上下拖动，排好后点「完成」。</span>
    <button type="button" data-act="lg-sortdone">完成</button></div>`;
}

/**
 * 功能：一次拖动里「可以互换位置」的那些兄弟元素 —— 三类各成一组，⛔ 不能混着数。
 *
 * 说明：⚠️ 账户**只在同一个 `.lg-group` 内**换位：跨组换位等于改它的用途，那是另一件事
 *      （这一轮不做）。混进来会让用户以为改了用途，其实只改了顺序 —— 静默的那种错。
 *      ⚠️ 与桌面端那份（`desktop.js` 的 `dragSiblings()`）**逐字同语义**。
 *
 * @param {HTMLElement} el - 被按住的元素
 * @returns {Array.<HTMLElement>} 兄弟元素（含它自己，按 DOM 顺序）
 */
function pressSiblings(el) {
  const kind = String((el.dataset && el.dataset.drag) || '');
  if (kind === 'chip') return [...el.parentElement.querySelectorAll('[data-drag="chip"]')];
  if (kind === 'group') {
    const list = el.closest('.lg-list') || el.parentElement;
    return [...list.querySelectorAll('[data-drag="group"]')];
  }
  const box = el.closest('.lg-group');
  return box ? [...box.querySelectorAll('[data-drag="acct"]')] : [];
}

/** 功能：取消这次长按（手指动了 / 抬起来了）。 @returns {void} */
function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

/**
 * 功能：手指按在某个可拖元素上 —— 开始计时，长按到点就进拖动。
 * @param {PointerEvent} e - 按下事件
 * @param {HTMLElement} el - 被按住的元素
 * @returns {void}
 */
function startPress(e, el) {
  cancelPress();
  press = { el, x: e.clientX, y: e.clientY, timer: 0 };
  press.timer = setTimeout(() => {
    press = null;
    enterDrag(el);
  }, PRESS_MS);
}

/**
 * 功能：长按到点 ⇒ **进排序模式**（⛔ 不在这里抓东西，只把「拖拽柄」画出来）。
 *
 * 说明：⭐⭐ 见 `sortMode` 那段说明：`touch-action` 只在手势开始那一刻生效 ⇒ 必须在**手势
 *      之前**就把柄画在屏幕上，用户按住柄开始的那一趟才不会被浏览器判成滚动。
 *      ⚠️ 这里的"进模式"**永远不是"什么都不发生"**：屏幕上立刻多出排序条与一排柄
 *      （⛔ 别拿"同组只有一个元素"当早退 —— 那正是「长按毫无反应」）。
 *      ⚠️ 长按那一下松手，浏览器还会照常派发一次 `click` ⇒ 用 `swallowUntil` 吞掉
 *      （不吞的话「长按进排序模式」会顺手把账户详情打开）。
 * @returns {void}
 */
function enterDrag() {
  cancelPress();
  sortMode = true;
  swallowUntil = Date.now() + 600;
  renderLedger();
}

/**
 * 功能：真的抓起一个元素开始拖 —— 加样式与监听，⛔ 先不动任何数据。
 * @param {HTMLElement} el - 被拖的元素
 * @returns {void}
 */
function startDrag(el) {
  cancelPress();
  const kind = String((el.dataset && el.dataset.drag) || '');
  const siblings = pressSiblings(el);
  // ⚠️⭐ 兄弟只有它自己时也**照样进拖动状态**（抓起来、但没有落点、松手回原位）。
  //    从前这里是 `return` —— 表现是「长按毫无反应」，用户只能判定**功能坏了**
  //    （报的就是这个：他那份数据里同组往往只有一个账户）。
  //    ⇒ ⛔ 别把「这次拖动没有意义」翻译成「什么都不发生」：静默是这个项目最贵的一类 bug。
  move = { el, kind, siblings, over: null };
  el.classList.add('lg-dragging');
  document.body.classList.add('lg-sorting');
  // ⚠️ `passive: false` 是必需的：拖动时要 `preventDefault()` 把页面滚动按住
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
}

/** 功能：排序条那颗「完成」⇒ 退出排序模式并重画。 @returns {void} @since 0.8.2 */
export function lgSortDone() {
  sortMode = false;
  renderLedger();
}

/**
 * 功能：手指移动 ⇒ 换落点提示（⚠️ 只改提示，**真的换位在松手时一次做完**）。
 * @param {PointerEvent} e - 移动事件
 * @returns {void}
 */
function onDragMove(e) {
  if (!move) return;
  e.preventDefault();
  // ⚠️⭐ 判定轴跟着类型走：账户 / 组头是**竖排**（比 y），胶囊是**横排**（比 x）。
  //    从前一律比 y ⇒ 拖胶囊时那一排的 y 全在范围内，落点永远落在**第一个**胶囊上
  //    （表现是「拖了没反应 / 位置乱跳」，而且不报错）。
  const horiz = move.kind === 'chip';
  const pos = horiz ? e.clientX : e.clientY;
  let over = null;
  for (const el of move.siblings) {
    if (el === move.el) continue;
    const r = el.getBoundingClientRect();
    const lo = horiz ? r.left : r.top;
    const hi = horiz ? r.right : r.bottom;
    if (pos >= lo && pos <= hi) {
      over = el;
      break;
    }
  }
  if (over !== move.over) {
    if (move.over) move.over.classList.remove('lg-drop');
    move.over = over;
    if (over) over.classList.add('lg-drop');
  }
}

/**
 * 功能：松手 —— 收尾、必要时提交顺序。
 * @returns {Promise.<void>}
 */
async function endDrag() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', endDrag);
  document.removeEventListener('pointercancel', endDrag);
  document.body.classList.remove('lg-sorting');
  const d = move;
  move = null;
  if (!d) return;
  d.el.classList.remove('lg-dragging');
  if (d.over) d.over.classList.remove('lg-drop');
  if (!d.over || d.over === d.el) return;
  const from = d.siblings.indexOf(d.el);
  const to = d.siblings.indexOf(d.over);
  if (from < 0 || to < 0 || from === to) return;
  // ⚠️ 紧接着到达的那一次 click 要吞掉（见 `swallowUntil` 的说明）
  swallowUntil = Date.now() + 500;
  await commitOrder(d.kind, d.siblings, from, to);
}

/**
 * 功能：把一次拖动提交给服务端，然后重取这一屏。
 * @param {string} kind - 拖的类型（`data-drag` 的值）
 * @param {Array.<HTMLElement>} siblings - 兄弟元素（按拖动前的顺序）
 * @param {number} from - 原下标
 * @param {number} to - 目标下标
 * @returns {Promise.<void>}
 */
/**
 * 功能：当前选中的是不是「一套分类视图」—— 是就回它的 id，否则回 0（= 按账户类型看全部）。
 *
 * 说明：⭐⭐ 起的口径：**账户行的拖动，改的是「当前这套分类里组内的先后」**。
 *      · 没选任何分类（0）或在「按账户类型」视图里 ⇒ 回 0 ⇒ 走账户表的 `sort_order`
 *        （那时是对的：组就是账户类型本身，跨类型的拖动本来就不该发生）；
 *      · 在「按账户用途」或自建分类里 ⇒ 回那套分类的 id ⇒ 顺序落到 `ledger_view_tags`
 *        （一个用途组里混着不同 kind 的账户，账户表那一列永远排不出用户要的顺序）。
 *      ⚠️ 判据是 `builtin !== 1`，⛔ **不是** `id !== 0` —— 「按账户类型」现在也是库里的真行
 *      （`builtin = 1`，id 非 0），拿 id 去判别会把它当成普通分类，它的顺序就被写进 tags 表。
 *
 * @returns {number} 这套分类的 id；不在分类视图里时是 0
 */
function tagViewIdOf() {
  const views = (state.lg && state.lg.views) || [];
  const cur = views.find((v) => Number(v.id) === Number(state.lgView)) || null;
  if (!cur) return 0;
  return Number(cur.builtin) === 1 ? 0 : Number(cur.id) || 0;
}
async function commitOrder(kind, siblings, from, to) {
  const ids = siblings.map((el) => Number(kind === 'group' ? el.dataset.gid : el.dataset.did));
  const base = ((state.lg && state.lg.accounts) || []).map((a) => Number(a.id));
  const body = reorderPayload(kind, ids, from, to, base, tagViewIdOf());
  if (!body) return;
  try {
    await api('POST', '/api/ledger/reorder', body);
  } catch (e) {
    toast(e.message, true);
  }
  // ⚠️ 成功失败都重取：失败时这一下正好把顺序拉回真相
  await loadLedger();
}

/**
 * 功能：绑这一块的事件（change ＋ 长按拖动）—— ⚠️ **每颗节点只挂一次**。
 *
 * 说明：⭐⭐ 0.8.10：`#view-ledger` 由视图片段**每次挂载新建一颗**，所以
 *      「只挂一次」的判据是**节点身份**（`ledgerViewNode`）—— 换了一颗就重挂，同一颗重入不重挂。
 *      ⚠️ 挂重了的表现是「一次点击跑两遍」（切视图切两次、保存两次）——
 *      而它**不报错**，只是偶尔看着像"卡了一下"。
 *      ⚠️ 拖动那几颗监听**不进这里**（它们是拖动开始时才临时挂、松手就摘）——
 *      常驻监听只在按下时要一个「长按计时器」。
 *      ⚠️⭐ **必须导出**：片段 `mobile-assets-pane.js` 在另一个文件里，「进文档之后挂委托」
 *      那一步调的就是它（与电脑版导出 `bindLedgerEvents()` 同一形态）。
 *
 * @returns {void}
 */
export function bindLedgerOnce() {
  const box = $('#view-ledger');
  if (!box || box === ledgerViewNode) return;
  ledgerViewNode = box;
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return undefined;
    // ⭐ 0.8.1：账户详情那颗月份下拉 —— 换月**要重新取数**（那个月的变动根本不在手上），
    //    ⛔ 不是"从手上这份里筛"（手上只有当前这一页 30 条，筛出来永远只有一小截）。
    if (t.id === 'lg-c-month') {
      state.lgChgMonth = String(t.value || '');
      loadChanges(true);
    }
    // ⭐ 0.8.21：账户详情那颗**变动类型**下拉（0.8.21 起从胶囊换成原生 `<select>`）——
    //    与月份那颗同一条口径：换类型**要重新取数**（见 `pickChgType()` 的说明）。
    if (t.id === 'lg-c-type') {
      pickChgType(t.value);
    }
    // ⭐ 0.8.2：账单屏「月账单」那颗年份下拉 —— 换年 = 换一期（`period_key` 变）⇒ 重新取数。
    //    ⚠️ 流水那一颗 `#lg-e-month` 的 change 分支**已删**：明细屏的选月是**底部弹层**
    //    （T45），它走 `lg-month-ok` 那条动作，⛔ 不再是原生 `<select>` 的 change
    //    （留着就是一条永远配不上的死分支 —— 「删掉一格 UI 必须把读回那一头一起删」）。
    if (t.id === 'lg-bill-year') {
      state.lgBillKey = `${Number(t.value) || 0}-01-01`;
      loadBill(true);
    }
    // ⭐ 0.8.0：换年**要重新取数**（那一年的快照不在手上）—— 方案 §4.5 明写这是
    //    「用户主动动作」，允许转圈；⚠️ 与「切口径只重画」是两件事，⛔ 别混。
    if (t.id === 'lg-f-year') {
      state.lgYear = Number(t.value) || 0;
      loadLedger();
    }
    // ⭐ 0.8.3：设置子页【收支账户】**全部当场生效**（这一页没有「保存」那颗按钮了）——
    //    全局两层认 `id`，每类别那一层认行上的 `data-defacct`。
    //    ⚠️ 这两条就是「读回那一头」：改了上面 `setAcctHtml()` 里那几个钩子，
    //    这里必须一起改（「删掉一格 UI 必须把读回那一头一起删」）。
    //    ⭐ 0.8.21：判据**只住 `handleLedgerSetChange()` 一处** —— 设置页那一栏里也有这几个钩子
    //    （它的委托挂在**那一栏自己**的根上），两边调的是同一支。
    handleLedgerSetChange(t);
    return undefined;
  });
  // ⭐⭐ 0.8.21（「资产和图表 左右滑动切换」）：在「资产」这一格上**左右滑** ⇒
  //    切「台账 / 图表」两个视图（原来那排占满宽的「资产｜图表」药丸撤了，见 `tabDotsHtml()`）。
  //    ⚠️ 三条判据，缺一条都会误切：
  //      ① 只在**资产那一格**（别的几格各有自己的滚动 / 拖拽，⛔ 别抢它的手势）；
  //      ② 位移要**够横**（>45px 且横向明显大于纵向）⇒ 竖着滚列表不会被判成切视图；
  //      ③ **排序模式里一律不切**（那一下手势归长按拖拽）。
  //    ⚠️ 用 `touchstart` / `touchend`（松手时看落点），⛔ 不跟手位移 —— 跟手那一套住排序模式，
  //      两件事别混（混了就是"既有拖拽又切屏"，而且不报错）。
  let swX = 0;
  let swY = 0;
  box.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      swX = t.clientX;
      swY = t.clientY;
    },
    { passive: true },
  );
  box.addEventListener(
    'touchend',
    (e) => {
      // ⭐⭐ 0.8.22：这一对监听现在管**两处**左右滑动 ——
      //    「资产 / 图表」（资产格）与「列表 / 图表」（账单格），判据是**当前在哪一格**。
      //    ⚠️ 账单还挂着一个月详情**二级屏**（`state.lgMdMonth`）⇒ 在它里面不切
      //    （与「设置子页不画 FAB」同一条分寸：二级屏上不该有"切主视图"的手势）。
      const seg = segOf();
      if (seg === 'asset') {
        if (sortMode) return;
      } else if (seg === 'bill') {
        if (state.lgMdMonth) return;
      } else {
        return;
      }
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - swX;
      const dy = t.clientY - swY;
      // ⚠️ 两条门槛：横向位移够大（45px）**且**明显比纵向大（1.4 倍）—— 否则竖着滑列表也会切屏。
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      // 左滑（dx<0）⇒ 看后一页；右滑 ⇒ 回前一页
      if (seg === 'bill') {
        pickBillTab2(dx < 0 ? 'chart' : 'list');
        return;
      }
      const next = dx < 0 ? 'chart' : 'asset';
      if (next === tabOf()) return;
      state.lgTab = next;
      renderLedger();
    },
    { passive: true },
  );
  // ⭐ 0.8.1（§7.3）：**滚到底自动取下一 30 条** —— 它与底下那颗「加载更多」是**同一条路的两个入口**。
  //    ⛔ 不是 `window`：挂在 window 上永远不触发，表现是"滚到底什么也不发生"，且**不报任何错**。
  //    ⭐⭐ 0.8.20：这一屏改成两段式之后，`#view-assets` 那层 `.view` 已经 `overflow: hidden`
  //    （不再滚），真正滚的是**明细那一格内部的流水列表** `.lg-elist` ⇒ 监听仍挂在
  //    **常驻的** `.view` 上、走**捕获**阶段（`scroll` 不冒泡，但捕获会经过祖先），
  //    真正的容器由 `scrollHost()` 现取。
  //    ⛔ 别把监听改挂到 `.lg-elist` 上 —— 它每次重画都是**新节点**，逐次挂必然漏／重复挂。
  //    ⚠️ 那颗 `.view` 是常驻节点 ⇒ 仍按**节点身份**防重（见 `ledgerScrollNode`）。
  const scroller = (box.closest && box.closest('.view')) || box;
  if (scroller !== ledgerScrollNode) {
    ledgerScrollNode = scroller;
    scroller.addEventListener('scroll', maybeLoadMore, { passive: true, capture: true });
  }
  // ---- 长按拖动 ----
  box.addEventListener('pointerdown', (e) => {
    if (move) return;
    // ⭐⭐ 0.8.4：排序模式里**只认那颗拖拽柄** —— 它带静态 `touch-action: none`（见 app.css），
    //    浏览器因此不会把手势判成滚动、也不会派发 `pointercancel` ⇒ 拖动才真的跟手。
    //    ⚠️ 按在**行体**上时**什么都不做**（让位给滚动）：排序模式里行长按没有意义，
    //    而"按住行就能拖"正是被浏览器抢走手势的那条老路。
    const h = e.target.closest ? e.target.closest('[data-handle]') : null;
    if (h && sortMode) {
      const row = h.closest('[data-drag]');
      if (!row) return;
      // ⚠️ 指针捕获：手指滑出柄的范围后事件照样回它这儿（不捕获时中途会断）
      if (h.setPointerCapture) {
        try {
          h.setPointerCapture(e.pointerId);
        } catch (_e) {
          /* 个别环境不支持 pointerId 捕获：不影响（document 那层监听还在） */
        }
      }
      startDrag(row);
      return;
    }
    if (sortMode) return;
    const n = e.target.closest('[data-drag]');
    if (n) startPress(e, n);
  });
  box.addEventListener('pointermove', (e) => {
    // ⚠️ 手没抬起来就移动了 ⇒ 用户想滚动，立刻放弃长按（放过这次手势）
    if (press && (Math.abs(e.clientX - press.x) > PRESS_SLOP || Math.abs(e.clientY - press.y) > PRESS_SLOP)) {
      cancelPress();
    }
  });
  box.addEventListener('pointerup', cancelPress);
  box.addEventListener('pointercancel', cancelPress);
  // ⚠️⭐ 捕获阶段拦「刚拖完那一下点击」：宿主的委托挂在 `#app` 上走**冒泡**，
  //    所以在这里（内层）`stopPropagation()` 正好能拦住它
  box.addEventListener(
    'click',
    (e) => {
      // ⚠️⭐ 排序模式里**整屏的点击都不放行**（只放过排序条上那颗「完成」）：正在排版的时候
      //    顺手点开某个账户详情，是用户最不想要的那一下 —— 与「吞掉松手那一次 click」同一条道理。
      const inBar = e.target && e.target.closest ? e.target.closest('.lg-sortbar') : null;
      if (sortMode && !inBar) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (Date.now() < swallowUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

/**
 * 功能：把这一屏整块画出来 —— ⭐ 0.8.1 起它一共画**几块**：
 *      「明细」那一屏 / 「预算」那一屏 / 「资产」那一屏（1 期原样）/ 「设置」那一屏
 *      （⭐ 0.8.3 起它自己还分首页 / 子页）/ 账户详情二级屏 ＋ 账单屏 / 月详情页 / 设置子页。
 *
 * 说明：⚠️ `state.lgAcct` 有值时画详情；**它指向的账户不在了**（另一台设备上删的）⇒ 回落列表
 *      （与「选中的分类被删掉」同一条纪律：⛔ 别停在一个不存在的东西上，那样这一屏会一片空白
 *      且没有任何提示）。
 *      ⚠️⭐ **二级屏都不画底部那条记账导航**（账户详情 / 账单屏 / 月详情页 / 设置子页）：
 *      它们各自自带「‹ 返回」那一条头、宿主顶栏也收起来（`.topbar-bare`）
 *      ⇒ 底栏留给第一层，「手机端底部标签栏在子屏里不出现」是同一种分寸。
 *      ⚠️⭐ **那颗「记一笔」悬浮钮（屏级 `#assets-new`，见 `paintAssetsFab()`）只在第一层画，而且资产那一格不画**
 *      （它有自己一整条「＋ 添加账户」主操作，FAB 会正好盖在它头上）—— 判据是
 *      `segOf()` ＋ 那几个子屏的 `state`，⛔ 不挂 DOM class（这一屏整块重画）。
 *      ⚠️⭐ **「设置」那一格的第一层要画底部导航**：它是同级格之一（的），
 *      ⛔ 不是二级屏 —— 不收起顶栏、不画「‹ 返回」、不压历史栈（照资产 / 预算那两格）；
 *      **子页**才照二级屏那条分寸（见上面那条）。
 *
 * @returns {void}
 */
export function renderLedger() {
  // ⭐⭐ 0.8.21：设置页那一栏（`settings-pane` 片段）如果开着，**顺手也重画一次** ——
  //    「记账设置」那几块的写操作最后都走这里（改默认账户 / 建改归档分类 / 导入 / 导出…），
  //    而它们改的是**同一份 state** ⇒ 两处必须一起刷；只刷一处就是"改了但界面上没变"（不报错）。
  //    ⚠️ 必须排在下面那两个 `return` **前面**：用户只在设置页里、账本屏还没挂出来时，
  //    `#view-ledger` 是不存在的 ⇒ 排后面就永远刷不到那一栏。
  repaintSetPane();
  const box = $('#view-ledger');
  if (!box) return;
  const d = state.lg;
  if (!d) return;
  bindLedgerOnce();
  const sides = sideMapOf(d);
  // ⭐⭐ 0.8.20：屏级那颗悬浮「＋」**默认收起** —— 下面哪一格要它，谁自己打开
  //    （全部二级屏都不画它，判据与从前逐字一致，见 `paintAssetsFab()`）。
  //    ⚠️ 必须排在各个 `return` 分支**前面**，否则「切到资产格」那一条会把上一格留下的 ＋ 留在屏幕上。
  //    ⭐ 0.8.21：「资产」那一格要它了（`'account'` 档 ＝ 添加账户，见下面 ⑤）。
  paintAssetsFab('off');

  // ---- ① 账户详情二级屏 ----
  const acct = accountOf(state.lgAcct);
  if (Number(state.lgAcct) && !acct) {
    state.lgAcct = 0;
    state.lgChg = [];
    state.lgChgLoad = 'idle';
    state.lgChgErr = '';
  }
  if (Number(state.lgAcct) && acct) {
    box.innerHTML = detailHtml(acct, sides);
    paintChrome();
    return;
  }

  // ---- ② 「设置」那一屏（⭐ 同级格之一，C-11 / C-34；与资产 / 预算完全并列）----
  //    ⭐ 0.8.3：它里面**分了二级**（「设置增加二级菜单，现在要滑动到底很不方便」）——
  //    `state.lgSetPage` 空串 = 设置**首页**（四条目那张列表，画底部导航 ＋ FAB）；
  //    非空 = **子页**（`acct` / `cat` / `imp`）—— 照账户详情 / 账单屏那条分寸：
  //    宿主顶栏收起来（`mobile/app.js` 的 `.topbar-bare`）＋ 屏内自画「‹ 返回」那条头、
  //    ⛔ **不画底部导航、也不画 FAB**（底栏留给第一层那四格，与「手机端底部标签栏在子屏里不出现」同款）。
  //    ⚠️ 判据住 `calc.js` 的 `setPageOf()` 一处（⛔ 不在这里自己判白名单）。
  if (segOf() === 'set') {
    const page = setPageOf(state.lgSetPage);
    if (page) {
      const meta = SET_PAGES.find((p) => p.key === page);
      // ⚠️ 顶上那条「‹ 返回」头与正文**同住一个容器**（照账单屏 `.lg-bill` 那个结构）——
      //    容器负责子屏那一层内边距（`.lg-setp`），⛔ 三个子页函数自己不带容器。
      box.innerHTML = `<div class="lg-setp">${subHeadHtml(
        'lg-setback',
        (meta && meta.name) || '设置',
      )}${setPageBodyHtml(page)}</div>`;
      paintChrome();
      return;
    }
    box.innerHTML = `${setHomeHtml()}${segNavHtml()}`;
    paintAssetsFab();
    paintChrome();
    return;
  }

  // ---- ③ ⭐「明细」那一格（⭐ 默认格，T32：进记账即明细）----
  if (segOf() === 'detail') {
    box.innerHTML = `${detailScreenHtml()}${segNavHtml()}`;
    // ⭐ 0.8.21：开着搜索就要**重接**那个输入框（它随这一屏现造，监听器不跟着走）
    if (searchOn) bindSearchInput();
    paintAssetsFab();
    paintChrome();
    return;
  }

  // ---- ③b ⭐⭐ 0.8.3：「账单」那一格（「明细中的账单独立出来（两端都是），账单放到明细后面」）----
  //    ⭐ 它**从「明细的子屏」升成一级格**（原来是从明细里那颗「账单」按钮进去的新屏）⇒
  //    现在有自己的格子、⛔ **不再自带「‹ 返回」头**（一级格没有"上一层"可回）。
  //    ⚠️ 它下面那一层**月详情页**仍是二级屏（⭐ 只有「月」档有，T41）：自带「‹ 返回」头、
  //    ⛔ 不画底栏、也不画 FAB（与账户详情 / 设置子页同一条分寸）。
  //    ⚠️⭐ 判据**必须直接判 `state.lgMdMonth` 本身**（`'YYYY-MM'` 字符串；`0` = 不在这一屏），
  //    ⛔ **不许包一层 `Number(...)`** —— `Number('2026-12')` 是 `NaN`，而 `if (NaN)` 恒假
  //    ⇒ 这一屏**永远画不出来**：点了行尾那个 `›`，请求发了、服务端也正常回了，
  //    可屏幕上毫无变化，控制台还干净、不报错（真机上正是「点了没反应」那种最难查的形态）。
  if (segOf() === 'bill') {
    if (state.lgMdMonth) {
      box.innerHTML = monthDetailScreenHtml();
      paintChrome();
      return;
    }
    box.innerHTML = `${billScreenHtml()}${segNavHtml()}`;
    paintAssetsFab();
    paintChrome();
    return;
  }

  // ---- ④ ⭐ 0.8.2：「预算」那一屏（⭐ 空壳；真内容在）----
  if (segOf() === 'budget') {
    box.innerHTML = `${budgetScreenHtml()}${segNavHtml()}`;
    // ⭐ 0.8.22：这一格那颗「＋」＝ **添加分类预算**（通栏那条 `.lg-badd` 已撤，见 `paintAssetsFab()`）
    paintAssetsFab('budget');
    paintChrome();
    return;
  }

  // ---- ⑤ 「资产」那一屏（1 期原样 ＋ 底部那条记账导航）----
  //    ⭐⭐ 0.8.21（「在资产屏幕 点击加是添加账户，去掉独立按钮」）：
  //    这一格原来自己有一条通栏「＋ 添加账户」（`.lg-add`），与屏级那颗悬浮「＋」是同一件事
  //    （叠在一起分不清点哪个，`11` 记过）⇒ 通栏那条**撤了**，主操作交给悬浮那颗
  //    （`paintAssetsFab('account')`，见下面两处）。
  const t = d.totals || { asset_fen: 0, debt_fen: 0, net_fen: 0 };
  const accounts = Array.isArray(d.accounts) ? d.accounts : [];
  const groups = Array.isArray(d.groups) ? d.groups : [];
  const views = viewList();
  // ⭐：内置「按账户类型」也在 `views` 里（`builtin = 1`）⇒ **统一按 id 找**；
  //    找不到（初值 0 / 刚被别的设备删掉）就回落到它 —— ⛔ 别停在一个不存在的视图上
  // ⭐⭐ 0.8.3：那个"回落到它"改成**回落到排在最前面的那一个**（「谁在前面，进入的时候
  //    默认显示谁」）—— ⛔ 不再固定挑内置的「按账户类型」：胶囊里谁在第一位由**用户拖拽**决定，
  //    写死成"内置那个"会让用户把自己排到第一的视图白排（而且**不报错**，就是不生效）。
  let cur = views.find((v) => Number(v.id) === Number(state.lgView)) || null;
  if (!cur) {
    cur = views[0] || null;
    state.lgView = cur ? Number(cur.id) : 0;
  }
  const kindView = !cur || Number(cur.builtin) === 1;

  const body = accounts.length
    ? kindView
      ? groups.map((g) => groupHtml(g, accounts, sides)).join('')
      : tagGroupsHtml(cur, accounts, sides)
    : `<div class="empty slim"><div class="e-ico">💰</div><h3>还没记过账户</h3>
       <p>先记一个最常见的：现金 / 储蓄卡。</p></div>`;

  // ⭐ 0.8.0：图表是**同一屏的第二个视图**（方案 §三）。
  //    ⚠️ 0.8.1：它仍然是「资产」这一屏内部的事，⛔ **不是底部导航上的一项**。
  //    ⚠️⭐ 它是资产这一格的**第二个视图**（`tabOf()` 判的），同一条口径：**不画 FAB**。
  //    ⭐⭐ 0.8.21：切换**改成左右滑动**（那一排占满宽的「资产｜图表」药丸撤了）⇒
  //    顶部只剩 `tabDotsHtml()` 那两颗指示点；手势住 `bindLedgerOnce()` 的触摸那一对。
  if (tabOf() === 'chart') {
    box.innerHTML = `${tabDotsHtml()}${chartHtml(d, sides)}${segNavHtml()}`;
    // ⭐ 0.8.21：图表也是「资产」这一格的一部分 ⇒ 那颗「＋」同样是「添加账户」
    paintAssetsFab('account');
    paintChrome();
    return;
  }

  box.innerHTML = `${tabDotsHtml()}${sortBarHtml()}${heroHtml(t)}${viewBarHtml(views, cur)}<div class="lg-list">${body}</div>${segNavHtml()}`;
  // ⭐ 0.8.21：「资产」这一格的主操作 ＝ 屏级那颗悬浮「＋」（通栏那条已撤）
  paintAssetsFab('account');
  // ⭐⭐ 0.8.0：**进出详情屏都要请宿主重画一次顶栏**（`paintChrome()` 幂等、只写 class）。
  //    ⚠️ 不调的下场是「顶栏还留着 `ZX ｜ 记账 ｜ N 个账户`，屏内又画了一条『‹ 资产详情』」
  //    —— 两个标题摞着；返回时同理（`.topbar-bare` 摘不掉，顶栏一直收着）。
  //    ⚠️ 这条只能靠"换骨头的那一处顺手请宿主重画"来保证（渲染是模块自己发起的、不走 `render()`），
  //    与对话的 `renderTeamwork()` 同一个手法（`mobile/ui.js` 的窄入口，⛔ 不 import 宿主 `app.js`）。
  paintChrome();
}

// ============================================================================
// ⭐ 0.8.1 记账 2 期：「记账」那一屏 ＋ 记账自己的底部导航
// ============================================================================

/**
 * 功能：当前那一格（`'detail'` 明细 / `'budget'` 预算 / `'asset'` 资产 / `'set'` 设置）。
 *
 * 说明：⚠️ 认不出一律回落 `'detail'` —— ⭐ **它就是默认格**（打开即明细），
 *      ⛔ 别回落到 `'asset'` / `'set'`（那会把这个默认改掉，而且不报错）。
 *      ⚠️⭐ 0.8.2 起这一段从**三格升成五格**（「从左到右要有：
 *      明细（本期做）、预算（本期做）、记账、资产、设置」）⇒ 那五格**同一条判据**、同一个选中态。
 *      ⚠️⭐ 0.8.3：五格里的「记账」那一格**撤了**（入口换成屏内右下那颗悬浮笔按钮）⇒
 *      这一段回落成**四格**，`'entry'` 这个取值从此不存在（⛔ 别在判据里留一条永不命中的分支）。
 *      ⚠️ 白名单**不在这里写死**：走 `SEG_KEYS`（`calc.js` 的 `SEGS` 派生）——
 *      撤格 / 加格只改清单那一处。
 *      ⚠️ 电脑端**逐字同一条口径**（`desktop.js` 的 `segBarHtml()` ＋ `desktop/state.js` 的 `lgSeg`）——
 *      只改一端就是「一端四格、一端三段」，而它**不报错**。
 *      ⚠️ 底栏上的顺序是 `明细 ｜ 预算 ｜ 资产 ｜ 设置`（⛔ 不是这个函数的判据顺序）。
 * @returns {string} `'detail'` | `'budget'` | `'asset'` | `'set'`
 */
function segOf() {
  const k = state.lgSeg;
  return SEG_KEYS.includes(k) ? k : 'detail';
}

/**
 * 功能：切「明细 / 预算 / 资产 / 设置」那四格（记账自己的底部导航）。
 *
 * 说明：⭐⭐ **只换格、不重新取数**（选中态住 `state.lgSeg`）—— 资产那一侧是
 *      `overview` 一次给全；记账那一侧进来时 `mountLedger()` 已经取过流水。
 *      ⚠️ 例外一：切到「明细」而流水**从没取过**（`lgLoad === 'idle'`）⇒ 这时去取一次，
 *      否则用户看到的是一块永远空着的列表（⛔ 那正是"不报错的空"）。
 *      ⚠️ 例外一之二：切到「预算」要把这一期取回来（`openBudget()`，与进屏同一条路）。
 *      ⚠️⭐ 例外二：切到「设置」而**分类 / 默认账户还没到手** ⇒ 先补取一次；**取不到就不切**
 *      （照它从前是二级屏时 `lgSetOpen()` 的老口径）—— 切过去只会画出一片
 *      「还没有收支分类。」，那是把**「没读到」画成了「本来就没有」**（同一条纪律：
 *      三态必须分得开）。⚠️ 从「记账设置」升成同级格**不等于**要放宽这一条。
 *      ⚠️ 几格的切换**都不压历史栈**（`syncHistory()` 只认底部标签那一层）⇒ 在「设置」格按返回
 *      直接回主屏，与资产 / 记账完全一致（验收第 5 条）。
 *      ⚠️⭐ 换格时顺手把「账单屏 / 月详情页」这两个**子屏**清掉（它们都挂在明细那一格之下）——
 *      不清的话，从账单屏点底部「预算」，画出来的还是账单屏（⛔ 而且不报错）。
 *      ⚠️ `data-seg` 的判据走 `SEG_KEYS`（`calc.js` 的 `SEGS` 派生）—— 0.8.3 撤掉「记账」那一格
 *      之后，`data-seg="entry"` 这类旧值**自然落空**（⛔ 不用在这里补一条"entry 已撤"的分支）。
 *      ⚠️ 预算那一格的数据由它自己那一屏进屏时取（`openBudget()`），⛔ 不在这里顺手取
 *      （换格要快，取数是那一屏自己的事）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-seg` 取格）
 * @returns {Promise.<void>|void}
 */
export function lgSegPick(_act, n) {
  const k = String((n && n.dataset && n.dataset.seg) || '');
  if (!SEG_KEYS.includes(k)) return undefined;
  if (segOf() === k) return undefined;
  // ⚠️ ⭐ 0.8.3：账单升成**一级格**了 ⇒ 这里不再有 `lgBillOpen` 要清；
  //    但「月详情页」还挂在「账单」那一格之下 ⇒ 换格时必须清掉它
  //    （不清的话：从月详情点底栏「预算」，再切回「账单」，画出来的还是月详情 —— ⛔ 而且不报错）。
  state.lgMdMonth = 0;
  // ⭐ 0.8.4：换格也退出**排序模式**（它挂在「资产」那一格上，换走就不该再留着）
  sortMode = false;
  // ⭐ 0.8.21：换格也把「明细」那一格的**搜索态**收掉 —— 不收的话从别格切回来，
  //    落到的还是开着搜索框的那一版（⛔ 而且不报错）。
  searchOn = false;
  // ⭐ 0.8.3：换格也把「设置子页」清掉（它挂在「设置」那一格之下）——
  //    不清的话，从设置子页切走再切回来，落到的还是那个子页（⛔ 而且不报错）。
  state.lgSetPage = '';
  if (k === 'set' && (!state.lgCats.length || !state.lgDefaults)) {
    return Promise.all([ensureCats(false), ensureDefaults(false)]).then(([okC, okD]) => {
      if (!okC || !okD) {
        toast('记账设置没读到，稍后再试', true);
        return undefined;
      }
      state.lgSeg = k;
      renderLedger();
      // ⭐ 0.8.2：切进「设置」那一格也取一次三方导入概况（与 `mountLedger()` 同一条路）
      loadImportSummary();
      return undefined;
    });
  }
  state.lgSeg = k;
  if (k === 'budget') {
    return openBudget();
  }
  // ⭐⭐ 0.8.3：「账单」那一格要把它自己的数据取回来（它原来是从明细那颗按钮进去时才取）——
  //    与预算那条同款：**取数是这一格自己的事**，换格那一下顺手发（⛔ 别指望别人替它取）。
  if (k === 'bill') {
    return openBill();
  }
  // ⚠️ 只有「明细」那一格需要流水（流水归明细）—— 切到它而流水**从没取过**
  //    （`lgLoad === 'idle'`）就去取一次，否则用户看到的是一块永远空着的列表（⛔ 那正是"不报错的空"）。
  if (k === 'detail' && state.lgLoad === 'idle') return loadEntries(true);
  renderLedger();
  // ⭐ 0.8.2：切进「设置」那一格 ⇒ 取一次三方导入概况（见 `mountLedger()` 里那条说明）
  if (k === 'set') loadImportSummary();
  return undefined;
}

/** 明细那一格的图标（一份清单 —— 三行流水；线性 SVG，颜色由 CSS 的 `currentColor` 给 —— ⛔ 不自带配色） */
const NAV_ICO_DETAIL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.6h16"/><path d="M4 12h16"/>' +
  '<path d="M4 17.4h16"/></svg>';

/**
 * 账单那一格的图标（一张**带表头的表格**）—— ⭐ 与「明细」那三行流水**刻意不同形**：
 *      明细是"一条条流水"、账单是"汇总成表"（两个图标长得像，就等于没有图标）。
 *      ⚠️ 声明必须在本文件 `NAV_ICONS` **之前**（那些是 `const`，声明顺序反了会踩暂时性死区
 *      ⇒ 模块求值时整屏空白，而 lint / 单测**全看不出来**）。
 * @type {string}
 */
const NAV_ICO_BILL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.6" y="5.4" width="14.8" height="13.2" rx="2.2"/>' +
  '<path d="M4.6 10.2h14.8"/></svg>';

/** 预算那一格的图标（一个环形进度 —— 与预算屏里那个环同源，⛔ 不是第二套图形语言） */
const NAV_ICO_BUDGET =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4"/>' +
  '<path d="M12 3.6A8.4 8.4 0 0 1 20.4 12H12z"/></svg>';

/** 资产那一段的图标（线性 SVG，颜色由 CSS 的 `currentColor` 给 —— ⛔ 不自带配色） */
const NAV_ICO_ASSET =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.6h13.4a2.6 2.6 0 0 1 2.6 2.6v6.4H6.6A2.6 2.6 0 0 1 4 15z"/>' +
  '<path d="M4 8.6V7.4A2.4 2.4 0 0 1 6.4 5h8.2M15.6 13.2h2.2"/></svg>';

/** 设置那一段的图标（齿轮 —— 与电脑端那颗「[齿轮] 设置」**逐字同一个形状**）。
 *
 * 说明：⭐ 把电脑端那颗 `⋯` 换成「[图标] 设置」，理由是那个 `⋯` 与资产列表屏的
 *      「⋯ 管理分类」撞了符号（同一个屏上两颗一模一样的点，分不出哪颗开的是哪件事）。
 *      手机端这次把它升成底部第三格 ⇒ **同一个形状、同一套语言**，两端看同一个功能不会两种印象。
 *      ⚠️ 尺寸交给 CSS（`app.css` 里那条全局 `svg { width:21px; height:21px }`）——
 *      ⛔ 不在这里写 `width` / `height`（与上面两颗导航图标同一条写法）。
 * @type {string}
 */
const NAV_ICO_SET =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3.1"/>' +
  '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 ' +
  '1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1' +
  '-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 ' +
  '1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 ' +
  '4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 ' +
  '9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>';

/**
 * 功能：四格各自的图标（`key` → SVG 字符串）。
 *
 * 说明：⚠️⚠️ **它必须声明在全部 `NAV_ICO_*` 之后** —— 这些是 `const`（暂时性死区）：
 *      声明顺序反了，模块求值到这里就会 `ReferenceError`，整屏空白而 lint / 单测**全看不出来**
 *      （`11-踩坑与说明.md` 记过这条）。
 *      ⚠️ 这里只登记**图标**；「有哪几格、从左到右什么顺序、叫什么名字」住 `calc.js` 的 `SEGS`
 *      ——。
 *      ⚠️⭐ 0.8.3 撤了「记账」那一格 ⇒ 它的 `NAV_ICO_ENTRY` 与这里那一行**一并删掉**
 *      （那一格不再存在，留着就是一枚谁也画不到的图标）。
 * @type {Object.<string, string>}
 */
const NAV_ICONS = {
  detail: NAV_ICO_DETAIL,
  bill: NAV_ICO_BILL,
  budget: NAV_ICO_BUDGET,
  asset: NAV_ICO_ASSET,
  set: NAV_ICO_SET,
};

/**
 * 功能：画**记账自己的底部导航**（`明细 ｜ 预算 ｜ 资产 ｜ 设置`，四格，⛔ 没有「图表」）。
 *
 * 说明：⭐⭐  第 2 / 3 条 ＋，换成本端这条
 *      **同样式**的导航。⚠️ 它**只在这几格之间切**，⛔ 不是第二层应用导航；
 *      ⛔ 回主导航不走这里（走手机端自己的返回，历史栈逐屏退回， 第 4 条）。
 *      ⭐⭐ 「记账的底部导航，目前是资产、记账、设置，三个。从左到右要有：
 *      **明细（本期做）、预算（本期做）、记账、资产、设置**」⇒ 0.8.2 起从三格升成五格，
 *      ⛔ 顺序不能变（`明细` 必须在最左、`设置` 在最右）。
 *      ⭐⭐ 0.8.3：五格里的**「记账」那一格撤了**—— 它的入口改成屏内右下那颗
 *      悬浮钮（`paintAssetsFab()`，见那里）。⚠️ 那几格的名字 / 顺序 / 条数**一个都不在这里写死**：
 *      一律 `SEGS.map(...)`（`calc.js` 那一份是唯一出处）⇒ 撤格只改清单、不改这里。
 *      ⚠️ 样式与宿主那条 `.tabbar` **同源**（同一份 `--tabbar-h` / 圆角 / 阴影口径），
 *      但类名是 `.lg-nav`（一个类名别给两个组件用）。
 *      ⚠️⭐ 几格**共用同一套尺寸**（`.lg-nav-btn`：48px 高 ⇒ 触控目标 ≥ 44px、10.5px 字），
 *      ⛔ 不为某一格另造一套 —— 那会立刻出现「这一格比那一格矮一点」这种
 *      看不出来但摸得出来的事。⚠️ 并排要把宽度均分（CSS 用 `flex: 1 1 0` ＋ `min-width: 0`）。
 * @returns {string} 这一条的 HTML
 */
function segNavHtml() {
  const cur = segOf();
  const btn = (k, name, ico) =>
    `<button type="button" class="lg-nav-btn" data-act="lg-seg" data-seg="${k}" aria-selected="${
      cur === k
    }"${cur === k ? ' aria-current="page"' : ''}>${ico}<i>${name}</i></button>`;
  const tabs = SEGS.map((s) => btn(s.key, s.name, NAV_ICONS[s.key])).join('');
  return `<nav class="lg-nav" aria-label="记账内部导航">${tabs}</nav>`;
}

/* ⭐⭐ 0.8.21（「手机端的新建图标不是加号」）：这一格**不再改那颗钮的图形** ——
   与电脑端同款，就用屏级 `#assets-new` 自带的那个「＋」（`mobile/index.html` 里那个 SVG，
   数码管理的「＋ 新增」也是它、电脑端也是它）。
    ⚠️ 从前这里刷的是一支笔（0.8.3「记账」那一格的导航图标整块搬过来的）；本版按改回「＋」。
   ⛔ 别再往这里加一条 `innerHTML =` 去换图形 —— 两颗悬浮钮（记账 / 数码管理）本来就该长同一个样。 */

/**
 * 功能：把「记一笔」挂到**屏级**那颗悬浮「＋」（`#assets-new`）上；`on === false` 时把它收起来。
 *
 * 说明：⭐ 0.8.3 它替掉了底栏里「记账」那一格（「撤销记账中导航栏里的记账，
 *      改为悬浮 ＋ 标志进入记账，参考手机端的今天的 ＋ 创建任务」）。
 *      ⭐⭐ 0.8.20（「新建应该是固定的，切换的时候【新建+图标】不应该随着消失」）：
 *      ⚠️ 从前这里是 `lgFabHtml()` —— 本片段自己造一颗 `.lg-fab`、输出在**片段根**里 ⇒
 *      药丸切换那一趟，旧根被 `core/slots.js` 的交叉淡入处理（`is-leaving` → 淡出）⇒
 *      那颗 ＋ 跟着淡出、新片段那颗再淡入，看着就是「＋ 消失一下」。现在它住**屏级**
 *      （`mobile/index.html` 的 `#view-assets` 里、`#assets-body` **外面**，
 *      与网址/密码库那颗 `#webpass-new` 同一条纪律）⇒ 切 pane 时它不动。
 *      ⚠️ 手机端走的是**宿主 `mobile/app.js` 的 `ACTIONS` 表**（`data-act` ＋ `#app` 全局委托）
 *      ⇒ 这里只刷 `data-act` / 图标 / 文案 / 显隐，⛔ 不绑 click（绑了就是同一个动作触发两次）。
 *      ⚠️ 动作名**沿用既有的 `lg-eadd`**（⛔ 别顺手改名 —— 改了 `mobile/app.js` 的 `ACTIONS`
 *      与探针都得跟着动，而改名本身一分钱好处都没有）。
 *      ⚠️⭐ 显隐判据与从前逐字一致（**只在第一层画**）—— 三种地方**不画**，判据全从 `state` 判
 *      （这一屏整块重画，⛔ 不挂 DOM class）：
 *      · **资产那一格**：它有自己一整条「＋ 添加账户」（`.lg-add`）主操作，悬浮钮会正好盖在它头上；
 *      · **明细那两个子屏**（账单屏 / 月详情页）与**设置子页**：它们自带「‹ 返回」、是二级屏，
 *        悬在那儿既遮内容、又与"上一层"的语义打架；
 *      · **账户详情二级屏**：同上。
 *      ⇒ `renderLedger()` 一进门先 `paintAssetsFab(false)`，哪一格要它谁自己打开（那 4 处调用）。
 *      ⚠️ 它只在**本片段在场时**才有意义：宿主那颗是按当前那一格判的 —— 这一颗
 *      ⛔ 不要跨格去抢（切走之后由接替的那一段接管，见 `modules/digital/mobile.js`）。
 *
 * @param {string} [mode] - `'entry'`（默认，记一笔）/ `'account'`（添加账户）/
 *      `'budget'`（添加分类预算）/ `'off'`（收起）
 * @returns {void}
 * @since 0.8.2
 */
function paintAssetsFab(mode = 'entry') {
  const f = document.getElementById('assets-new');
  if (!f) return;
  if (mode === 'off') {
    f.classList.add('hidden');
    return;
  }
  // ⭐⭐ 0.8.21（「在资产屏幕 点击加是添加账户，去掉独立按钮」）：多了「添加账户」
  //    这一档 —— 「资产」那一格原来自己有一条通栏「＋ 添加账户」，两颗都是"加一个东西"、
  //    叠在一起分不清点哪个（`11` 记过）；现在那一格只剩这一颗，它就干这件事。
  // ⭐⭐ 0.8.22（「移除独立的【添加分类预算】按键，在预算页的【+新建】图标
  //    为添加分类预算」）：同一条口径推广到**「预算」那一格** —— 那条通栏 `.lg-badd` 一并撤了。
  //    ⇒ 这颗钮成**三档**：资产＝添加账户 / 预算＝添加分类预算 / 其余＝记一笔。
  //    ⚠️ 预算那一档的动作名沿用 `lg-budget-add`（它本来就在 `ACTIONS` 表里，是那条
  //    通栏按钮用过的那一支）—— ⛔ 不为"换了个触发点"新造一个动作名。
  const acct = mode === 'account';
  const bud = mode === 'budget';
  f.classList.remove('hidden');
  // ⭐ 0.8.21：图形**不改**（用屏级那颗自带的「＋」，见上面那段说明）
  f.title = acct ? '添加账户' : bud ? '添加分类预算' : '记一笔';
  f.setAttribute('aria-label', f.title);
  f.dataset.act = acct ? 'lg-new' : bud ? 'lg-budget-add' : 'lg-eadd';
}

/**
 * 功能：流水列表那一块（⭐ 明細屏的主体）—— **三态分得开**：读取中 / 读不到（一句人话 ＋ 重试） / 这个月没有。
 *
 * 说明：⭐⭐ 「读取中」「这个月一笔都没有」「没读到」是**三件不同的事** —— 把失败画成空态
 *      ＝把错误藏起来（用户会以为"我确实没记过账"）。「读不到」那颗重试**只重取流水**
 *      （⛔ 不是整页刷新：那个不会重新取记账这一屏的数据）。
 *      ⚠️ 按天分组走 `entry-calc.js` 的 `groupByDay()`（两端同一套：天倒序、天内 `(at, id)` 倒序）。
 *      ⚠️⭐ 但**组标题右边那两个小计不取它的** —— 它算的是"**这一页**里那一天的合计"
 *      （翻页加进来几条，那个数就变一次）；屏幕上要的是"**那一天**的合计" ⇒
 *      一律读服务端搭车回来的 `state.lgDayTotals`（按 `date` 取，⛔ 前端一个数都不加，
 *      2 期 §5.4「前端不算钱」）。取不到这一天的键时给两个 `0.00`（那天只有未来条目
 *      ⇒ 服务端刻意仍给这个键，见 `dayTotalsOf()`；真缺键也不许画成 `undefined`）。
 * @returns {string} 列表那一块的 HTML
 */
function entryGroupsHtml() {
  if (state.lgLoad === 'error') {
    return `<div class="err-box"><b>流水没读到</b><p>${esc(state.lgErr || '原因不明')}</p>
      <button class="chip on" type="button" data-act="lg-eretry" style="margin-top:14px">重新加载</button></div>`;
  }
  if (state.lgLoad === 'loading' && !state.lgEntries.length) return '<div class="lg-txwait">正在读取…</div>';
  // ⚠️⭐ 「这个月还没有」的判据是**两边都空**：只有自有流水那一边空、
  //    而导入行还有几条时，那不是"没有"，是"有这个月的账、只是它们是导进来的"。
  if (!state.lgEntries.length && !impRows.length) {
    return `<div class="empty slim"><div class="e-ico">🧾</div><h3>这个月还没有记过账</h3>
      <p>点底部「记账」那一格记一笔，这里就会按天列出来。</p></div>`;
  }
  const names = acctNameMap();
  const totals = state.lgDayTotals || {};
  // ⭐⭐ 0.8.2：**按天混排** —— 天的集合 = 自有流水 ∪ 导入行（两边并集），倒序；
  //    同一天里**自有流水在前、导入行在后**（各自保持服务端给的次序）。
  //    ⚠️⚠️ 导入行**一个都不许并进 `state.lgEntries`**：那一份是自有流水的分页缓存
  //    （「加载更多」是往它后面 `concat` 的）—— 把导入行塞进去、翻一页再重画一遍，
  //    它们就会在屏幕上**翻倍**（而且不报错）。这里只把两个数组**读着用**，各自一个字节不动。
  //    ⚠️ 天倒序的判据与 `groupByDay()` 同一套（`''` 那组是「时刻缺失」，排在最后）。
  const days = new Map();
  for (const g of groupByDay(state.lgEntries, 'at')) {
    days.set(g.date, { date: g.date, items: g.items, imported: [] });
  }
  for (const r of impRows) {
    const day = String((r && r.at) || '').slice(0, 10);
    const key = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
    let g = days.get(key);
    if (!g) {
      g = { date: key, items: [], imported: [] };
      days.set(key, g);
    }
    g.imported.push(r);
  }
  return [...days.values()]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
    .map((g) => {
      // ⚠️ 小计一律来自服务端（`dayTotals`）—— 按 `YYYY-MM-DD` 取，取不到就两个 0（见上面那段说明）。
      //    ⚠️⚠️ `dayTotals` **已经含导入行**⇒ ⛔ 前端**不许**再把导入行
      //    加进这个小计一次（那会把同一天的钱**算两遍**，而且它不报错）。
      const t = totals[g.date] || { income_fen: 0, expense_fen: 0, refund_fen: 0 };
      // ⚠️ 眼睛要盖住这里：小计走 `fmtFen`（掩码只住它一处）；隐藏态下**连符号都不给**
      //    （只留圆点），免得从"进还是出"上把信息漏出去。
      //    ⚠️⚠️ 掩码那个实参**必须逐字写 `state.lgHide`** —— `ttt/test/ledger.test.js`
      //    有一条护栏扫全文的 `fmtFen(` / `fmtSide(` / `fmtTx(`，要求每处都带这个开关
      //    （用个局部别名 `hide` 就会被判"漏了一处"，那正是它要防的静默漏点）。
      const inc = Number(t.income_fen) || 0;
      const exp = Number(t.expense_fen) || 0;
      // ⭐ 0.8.9 修订（「移除所有的退款红色字体」）—— 与电脑端逐字同款：
      //    每天小计旁边**不再有**那一栏「退款」，只剩收入与支出两个数。
      // ⚠️ 两个小计中间那个**全角空格**（图 8）走 `join()` 的**字符串字面量**参数，⛔ 不直接嵌进
      //    模板串：`no-irregular-whitespace` 默认不跳过模板串（`skipTemplates: false`）
      //    也**不跳过注释**（`skipComments: false`）—— 写在反引号里、或抄进注释里，
      //    `npm run lint` 都会当场红（而屏幕上它们看着完全正常）。
      //    ⚠️⚠️ 掩码那个实参**必须逐字写 `state.lgHide`** —— `ttt/test/ledger.test.js`
      //    有一条护栏扫全文的 `fmtFen(` / `fmtSide(` / `fmtTx(`，要求每处都带这个开关
      //    （用个局部别名 `hide` 就会被判"漏了一处"，那正是它要防的静默漏点）。
      const sum = [`收入: ${fmtFen(inc, state.lgHide)}`, `支出: ${fmtFen(exp, state.lgHide)}`].join('　');
      const head = `<div class="lg-eday"><b>${esc(g.date ? dayHeadLabel(g.date) : '时刻缺失')}</b><span>${esc(
        sum,
      )}</span></div>`;
      return (
        head + g.items.map((e) => entryRowHtml(e, names)).join('') + g.imported.map(impRowHtml).join('')
      );
    })
    .join('');
}

/**
 * 功能：画一条流水 —— **分类小图标** ＋ 分类名（没选就「未分类」）＋ 备注 / 账户名 ＋ 金额，
 *      退款行带「退款」字样。
 *
 * 说明：⚠️ 那颗小图标是**零出网**的「色块 ＋ 首字」（照记一笔的分类网格那套，
 *      ⛔ 本期不取图标文件）—— 色值走 `catColorOf()`（判据只住一处，⛔ 别在这里再 `%` 一遍）。
 *      首字取 `catName()` 的第一个字（「未分类」⇒ `未`）；拿不到名字时画 `·`。
 * @param {Object} e - 一条流水
 * @param {Map.<number, string>} names - 账户 id → 名字
 * @returns {string} 这一行的 HTML
 */
function entryRowHtml(e, names) {
  const parts = [];
  if (e.note) parts.push(String(e.note));
  const an = names.get(Number(e.account_id));
  if (an) parts.push(an);
  // ⭐ 0.8.9 修订：原交易那一行上的小字改成**带日期**的写法
  //    「9月30日已退款 127.50」（同电脑端 `desktop.js`）。
  //    ⚠️⭐ 它**不进 `parts`**（那一串会被整体 `esc()` 掉）—— 它要**红字**，所以单独画一个
  //    `<i class="lg-rfnote">`（见下面 return 处与 `app.css`）。
  const rf = refundNoteOf(e, state.lgEntries, state.lgHide);
  // ⚠️ 退款条目**自己也在列表里**（单独占一行，C-24）⇒ 那一行标题带「退款」字样；
  //    它自己**不再给**「记退款」入口（⛔ 不许给退款再退款 —— 服务端也会拒）。
  // ⭐ 0.8.1 补：**整行**都能点进详情（`data-act="lg-erow"`）。⚠️ 行里那颗「记退款」也是
  //    `data-act` ⇒ 宿主的委托 `closest('[data-act]')` 从按钮往上找，**先命中按钮自己**，
  //    所以点「记退款」不会同时进详情 —— ⛔ 别用 `stopPropagation` 去"补"这件事
  //    （委托里那一手拦不住、还会顺手吞掉下一个 action）。
  const act = isRefund(e)
    ? ''
    : `<button class="lg-erowact" type="button" data-act="lg-refund" data-id="${Number(e.id)}">记退款</button>`;
  // ⚠️ 分类小图标：色块 ＋ 首字（零出网，照）—— 名字走 `catName()`（「未分类」是它给的词），
  //    ⛔ 不在这里再判一次 `category_id` 有没有值（那是 `catName()` / `entryTitle()` 的事）。
  const cname = catName(e.category_id, state.lgCats);
  const ch = String(cname || '').trim().slice(0, 1) || '·';
  const ico = `<span class="lg-eico" style="--lg-c:${catColorOf(e.category_id)}">${esc(ch)}</span>`;
  return `<div class="lg-erow${isRefund(e) ? ' refund' : ''}" data-act="lg-erow" data-id="${Number(e.id)}">
    ${ico}
    <span class="lg-emain"><b class="lg-etitle">${esc(entryTitle(e, state.lgCats))}</b>${
      parts.length ? `<i class="lg-sub">${esc(parts.join(' · '))}</i>` : ''
    }${rf ? `<i class="lg-rfnote">${esc(rf)}</i>` : ''}</span>
    <b class="lg-eamt">${esc(fmtSignedFen(signedFen(e.ie, e.amount_fen), state.lgHide))}</b>
    ${act}
  </div>`;
}

/**
 * 功能：列表底下那条「加载更多」（到底了 / 读不到时整条不画）。
 * @returns {string} 这一段的 HTML
 */
function entryMoreHtml() {
  if (state.lgLoad === 'loading' && state.lgEntries.length) return '<div class="lg-txwait">正在读取…</div>';
  if (state.lgLoad !== 'done' || state.lgDone) return '';
  return '<button class="lg-more" type="button" data-act="lg-emore">加载更多</button>';
}

/** 功能：滚到底自动取下一 30 条的节流闸门（同一次滚动只发一次）。 @type {boolean} */
let moreBusy = false;

/**
 * 功能：这一屏**当前真正的滚动容器**。
 *
 * 说明：⭐⭐ 0.8.20（「滑动应该顶部固定，只滑动记录条目」）：明细那一格
 *      改成**两段式**（固定头 ＋ 内部滚动区，见 `app.css` 的 `#view-assets` 那一段）——
 *      工具条与月份卡不再滚，真正滚的是流水列表 `.lg-elist`。
 *      ⇒ 判据不能再看死那层 `.view`（它现在 `overflow: hidden`、压根不滚）。
 *      ⚠️ 拿不到 `.lg-elist`（还没画 / 停在别的格）时回落到 `.view`：账单 / 预算 / 资产 /
 *      月详情那几格仍住在 `#view-ledger` 里、由它自己滚。
 * @param {Element} box - `#view-ledger`
 * @returns {?Element} 滚动容器
 */
function scrollHost(box) {
  return (
    document.querySelector('#view-ledger .lg-elist') || (box.closest && box.closest('.view')) || box
  );
}

/**
 * 功能：滚到列表底部时自动「加载更多」（§7.3）；不满足条件时什么都不做。
 *
 * 说明：⚠️ 滚动容器**不是 `window`** —— ⛔ 挂在 `window` 上永远不触发。
 *      它同时是「底下的按钮」那条路的孪生入口：两条路都走 `loadEntries(false)`。
 *      ⚠️⭐ 0.8.20：明细那一格改成两段式之后，真正在滚的是 `.lg-elist` ⇒ 容器由
 *      `scrollHost()` 现取；而且监听挂在 `.view` 的**捕获**阶段（`scroll` 不冒泡）⇒
 *      这一条会收到**所有后代**的滚动，所以只认「恰好就是那个容器自己」发出来的那一条。
 * @param {?Event} [ev] - 滚动事件（捕获阶段送进来；缺省 = 直接调，不判来源）
 * @returns {void}
 */
function maybeLoadMore(ev) {
  if (moreBusy) return;
  // ⚠️⭐ 0.8.10：判据从 `state.tab === 'ledger'` 换成 `state.assetsPane === 'ledger'`
  //    —— 记账不再是一屏，它借「个人资产管理」那一屏的 `assets-pane` 槽住着
  //    （`state.assetsPane` 由 `modules/assets/mobile.js` 在挂载 / 切格时写）。
  //    ⛔ 留着 `state.tab` 那半句就是一条**永远命不中的死分支**，而它**不报错**。
  // ⚠️⭐ 只在「明细」那一格自动翻页 —— 判据**只有 `segOf()` 一处**（流水归明细）。
  //    账单屏 / 月详情 / 预算 / 设置那几格都没有流水，它们在滚动时会读到 `state.lgLoad`
  //    那份属于流水列表的状态 ⇒ 这句护栏一并管住，⛔ 别再补第二份判据。
  if (state.assetsPane !== 'ledger' || segOf() !== 'detail') return;
  // ⚠️ 月详情页开着时**也不触发**（⭐ 0.8.3：账单 / 预算 / 设置那几格已被上面那句
  //    `segOf()` 排除了）—— 它是「账单」那一格之下的子屏（自带返回头），
  //    滚动到底不该去取下一页流水（那时用户根本看不见列表）。
  if (state.lgMdMonth) return;
  if (state.lgLoad !== 'done' || state.lgDone || !state.lgCursor) return;
  // ⚠️ 弹层开着时不触发（记一笔 / 详情 / 恢复内置分类都在弹层里）——
  //    与电脑端的 `modalOpen()` 同款护栏（滚动事件可能来自别的容器）。
  if ($('#sheet') && $('#sheet').classList.contains('on')) return;
  // ⚠️ 「节点在不在文档里」这一层兜底必须留着：切走这一格之后 `#view-ledger` 被摘掉，
  //    而挂在常驻 `.view` 上的那条 scroll 监听还在（它收得到别的格子的滚动）。
  const box = $('#view-ledger');
  if (!box) return;
  const view = scrollHost(box);
  if (!view) return;
  // ⚠️⭐ 捕获监听会收到所有后代的滚动 —— 只认真正那个滚动容器自己发的那一条
  if (ev && ev.target && ev.target !== view) return;
  if (view.scrollTop + view.clientHeight < view.scrollHeight - 240) return;
  moreBusy = true;
  loadEntries(false).finally(() => {
    moreBusy = false;
  });
}

/** 功能：「流水没读到」那颗重试（从第一页重取）。 @returns {Promise.<void>} */
export async function lgEntryRetry() {
  await loadEntries(true);
}

/** 功能：底下那颗「加载更多」（游标往后取一页）。 @returns {Promise.<void>} */
export async function lgEntryMore() {
  await loadEntries(false);
}

// ============================================================================
// ⭐ 0.8.1 补（真机验收第 1 条）：**条目详情 ＋ 改一笔 ＋ 删一笔**
//    ⚠️ 服务端那两条（`PUT` / `DELETE /api/ledger/entries/:id`）**早就写好了**，前端一次都没调过
//    ⇒ 一条账记错了既改不掉也删不掉。这一段只做**消费**：⛔ 不动服务端一个字。
// ============================================================================

/**
 * 功能：点流水**整行** ⇒ 开「这笔账」详情弹层。
 *
 * 说明：⭐ 详情是**一张上滑弹层**（不是第二个屏）：这一屏（记账）本身没有二级屏的位置，
 *      而详情要摆的就是"一行信息 ＋ 三颗动作"。
 *      ⚠️ 分类名走 `entryTitle()`（退款条目自带「退款」字样）、账户名走**唯一的取名口**
 *      `acctNameMap()`、金额走 `fmtSignedFen(signedFen(...))` 并把**眼睛**传下去 ——
 *      三样都是别处已经定好的口径，⛔ 这里不各写一份。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一行（`data-id` = 流水 id）
 * @returns {void}
 */
export function lgEntryOpen(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const e = entryOf(id);
  // ⚠️ 找不到（这一页刚被换过 / 别处删了）⇒ 什么都不做：⛔ 别开一张空弹层
  if (!e) return;
  openSheet(
    isRefund(e) ? '这笔退款' : '这笔账',
    entryDetailHtml(e),
    `<button class="btn" type="button" data-act="lg-eclose">关闭</button>`,
  );
}

/** 功能：从**手上这一页**流水里按 id 找一条（找不到回 `null`）。 @param {number} id - 流水 id @returns {?Object} @since 0.8.0 */
function entryOf(id) {
  const rid = Number(id) || 0;
  if (!rid) return null;
  return (state.lgEntries || []).find((x) => Number(x.id) === rid) || null;
}

/**
 * 功能：画详情弹层的正文 —— 退款说明（仅退款条目）＋ 五格信息 ＋ 正文里的动作 ＋ 删除。
 *
 * 说明：⚠️ 三颗动作**画在正文里**：底部那颗主按钮（`openSheet` 的 foot）在这张弹层上
 *      只放「关闭」—— 这张弹层没有"主操作"可言，而"只依赖底部那一颗"就会让编辑 / 删除
 *      没地方放（"点开进入详情操作"）。
 *      ⚠️⭐ 「删除」住在**滚动区末尾**（`.del-row`，与课表「删除这条课次」同一手法，
 *      0.7.2 报过「删除很容易误点」）—— 它不与上面那几颗挨着，也**不是**底部主按钮。
 *      ⭐ 退款条目**不给**「记退款」入口（⛔ 不许给退款再退款 —— 服务端也会拒）。
 * @param {Object} e - 一条流水
 * @returns {string} 正文 HTML
 */
function entryDetailHtml(e) {
  const rf = isRefund(e);
  // ⭐ 退款条目要能看见"它退的是哪一笔"：原交易一般就在这一页（同一屏刚退完款）；
  //    ⚠️ 不在这一页时（翻过页 / 原交易在别的月）**如实说"不在这一页"**，⛔ 不编一个标题。
  const origin = (state.lgEntries || []).find((x) => Number(x.id) === Number(e.refund_of));
  const line = rf
    ? `<div class="lg-edcap2">${
        origin ? `这是「${esc(entryTitle(origin, state.lgCats))}」的退款。` : '这是退款记录（原交易不在这一页）。'
      }</div>`
    : '';
  const row = (k, v) => `<div class="lg-drow"><span>${k}</span><b>${esc(v)}</b></div>`;
  const refundBtn = rf
    ? ''
    : `<button class="lg-dact" type="button" data-act="lg-refund" data-id="${Number(e.id)}">记退款</button>`;
  return `<div class="lg-ed">
    ${line}
    <div class="lg-det">
      ${row('分类', entryTitle(e, state.lgCats))}
      ${row('金额', fmtSignedFen(signedFen(e.ie, e.amount_fen), state.lgHide))}
      ${row('账户', acctNameMap().get(Number(e.account_id)) || '（账户名没读到）')}
      ${row('时间', String(e.at || ''))}
      ${row('备注', String(e.note || '') || '（没填）')}
    </div>
    <div class="lg-dacts">
      <button class="lg-dact" type="button" data-act="lg-eedit" data-id="${Number(e.id)}">编辑</button>
      ${refundBtn}
    </div>
    <button class="del-row" type="button" data-act="lg-edel" data-id="${Number(e.id)}">${
      rf ? '删除这笔退款' : '删除这笔账'
    }</button>
  </div>`;
}

/** 功能：关掉详情弹层（foot 那颗「关闭」）。 @returns {void} @since 0.8.0 */
export function lgEntryClose() {
  closeSheet();
}

/**
 * 功能：从详情进「改一笔」—— ⭐ **复用「记一笔」那张弹层**，只把原条目灌进草稿。
 *
 * 说明：⭐⭐ 两条硬口径：
 *      · **秒取原条目的秒**（⛔ 不是"现在"的秒）：`datetime-local` 只到分钟，秒是提交时由前端
 *        补上的—— 新建时补"点开那一刻"的秒，**改的时候必须补回原来那个秒**，
 *        否则每改一次备注，那条账的时间就悄悄往后蹦一次（而且不报错）。
 *      · **逐键提交**：`editOrig` 记下原值，保存时只带真改过的键（见 `lgEntrySave()`）。
 *      ⚠️ 退款条目只让改**金额与备注**（`editRefund`）—— 方向 / 分类 / 账户 / 时间都不给改。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 详情里那颗「编辑」（`data-id` = 流水 id）
 * @returns {Promise.<void>}
 */
export async function lgEntryEdit(_act, n) {
  const e = entryOf(Number((n && n.dataset && n.dataset.id) || 0));
  if (!e) return;
  // ⚠️ 分类网格是这张弹层的主体 ⇒ 分类没读到就**不开**（与「记一笔」同一条纪律）
  const ok = await ensureCats();
  if (!ok || !state.lgCats.length) {
    toast('收支分类没读到，点「重新加载」再试一次', true);
    return;
  }
  await ensureDefaults();
  editId = Number(e.id);
  editRefund = isRefund(e);
  editOrig = {
    at: String(e.at || ''),
    ie: String(e.ie || ''),
    // ⚠️ 原金额按**输入框的样子**回填（`fenToInput`）：逐键比较要比同一口径的串，
    //    拿 '30.00' 与用户打的 '30' 比会永远"看着变了"（每次都发一遍没必要的 PUT）。
    amount: fenToInput(e.amount_fen),
    category_id: e.category_id == null ? null : Number(e.category_id),
    account_id: Number(e.account_id) || null,
    note: String(e.note || ''),
  };
  // ⭐ 秒：取原条目 `at` 的第 17~18 位（`YYYY-MM-DD HH:MM:SS`）；形状不对就回落 '00'
  const sec = editOrig.at.slice(17, 19);
  edSec = /^\d{2}$/.test(sec) ? sec : '00';
  // ⚠️ 二级分类：条目挂的是二级时，网格要**直接开在第二屏**（那一屏才会把二级高亮起来）
  const cat = state.lgCats.find((c) => Number(c.id) === Number(editOrig.category_id));
  const second = cat && cat.parent_id != null ? Number(cat.parent_id) : 0;
  state.lgDraft = {
    ie: editOrig.ie === '收入' ? '收入' : '支出',
    amount: editOrig.amount,
    catId: editOrig.category_id,
    acctId: Number(editOrig.account_id) || 0,
    note: editOrig.note,
    // `datetime-local` 的值形状是 `YYYY-MM-DDTHH:MM`（秒由 `edSec` 补）
    dt: editOrig.at ? editOrig.at.slice(0, 16).replace(' ', 'T') : '',
    second,
    // ⭐ 退款条目：弹层只画金额与备注两格（判据就是这一个字段，`entrySheetHtml()` 读它）
    refund: editRefund,
  };
  state.lgNotesCat = null;
  state.lgNotes = [];
  paintEntrySheet();
  loadNotes(state.lgDraft.catId);
}

/**
 * 功能：删这一笔（**二次确认**，文案逐字）—— 普通条目与退款条目各说清后果。
 *
 * 说明：⚠️ 确认手法照本文件现成那一套（`askConfirm()`，删账户 / 删分类 / 删成员同款），
 *      ⛔ 不自己发明第二套。两条文案各说一件事：
 *      · 普通条目：删了不能恢复；**它名下已记的退款会一起删掉**（服务端在一个事务里做，
 *        那条退款也属于这笔账）—— 有退款时才说这一句，没有就别吓人；
 *      · 退款条目：删它**不影响原交易**（钱回来这件事被撤销，原账照旧）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 详情里那颗「删除」（`data-id` = 流水 id）
 * @returns {void}
 */
export function lgEntryDel(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const e = entryOf(id);
  if (!e) return;
  const rf = isRefund(e);
  const text = rf
    ? '这是退款记录，删掉它不会影响原交易。'
    : `删除后不能恢复。${Number(e.refund_fen) > 0 ? '它名下已记的退款会一起删掉。' : ''}`;
  askConfirm({ title: rf ? '删掉这笔退款？' : '删掉这笔账？', text, ok: '永久删除', danger: true }).then((ok) => {
    if (ok) entryDeleteGo(id);
  });
}

/**
 * 功能：真的删（确认之后走这里）—— 删完刷新流水 / 账户卡 / 当天快照。
 *
 * 说明：⭐ **钱变了** ⇒ 账户余额与当天快照都变了（服务端算的）⇒ `loadLedger()` 必须重取；
 *      流水也从第一页重取（删掉的那条要从最上面消失）。⛔ 本地不自己减一遍。
 * @param {number} id - 流水 id
 * @returns {Promise.<void>}
 */
async function entryDeleteGo(id) {
  try {
    await api('DELETE', `/api/ledger/entries/${Number(id)}`);
    // ⚠️ 删掉的若是**正在改的那一条**（弹层还开着），编辑态要一起清掉 —— 否则下一次
    //    「记一笔」会带着一个已经不存在的 editId 去 PUT（那条路径 404，而且不报错）
    resetEdit();
    await loadLedger();
    await loadEntries(true);
    toast('删掉了');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 功能：把「正在编辑」这一整套临时态清干净（取消 / 存完 / 删完都要清）。 @returns {void} @since 0.8.0 */
function resetEdit() {
  editId = 0;
  editOrig = null;
  editRefund = false;
}

// ============================================================================
// ⭐ 0.8.1（§7.2）：「记一笔」上滑弹层 ＋「记退款」
// ============================================================================

/**
 * 功能：画分类那一片（第一屏＝一级网格 / 第二屏＝某个一级下面的二级）。
 *
 * 说明：⭐⭐ **只铺一级**：点了某个一级才出第二屏 —— 于是快路径
 *      仍是「金额 → 选一级 → 完成」三步。⚠️ 二级**可不选**⇒ 第二屏里
 *      点「‹ 返回」就停在那个一级上（流水只挂一级是合法的）。
 *      ⚠️ 「未分类」是一个**正经选项**（允许没有分类的账， 第 10 条），
 *      且与「其它」（真分类）**显示成两个不同的东西**（C-32）—— 它来自 `CAT_UNCLASSIFIED`。
 * @returns {string} 这一片的 HTML
 */
function edGridHtml() {
  const d = state.lgDraft || {};
  if (d.second) {
    const parent = state.lgCats.find((c) => Number(c.id) === Number(d.second));
    // ⭐ P2 收口：「谁是二级」的判据只住 `entry-calc.js` 一处—— 本文件从前在这里
    //    自己写了一遍同样三个条件的 filter，两处迟早会漂。
    const kids = childCats(state.lgCats, d.second);
    const rows = kids.length
      ? kids.map(catBtnHtml).join('')
      : '<div class="lg-txwait">这个分类没有下一级 —— 直接点「‹ 返回」就行。</div>';
    return `<div class="lg-edgridwrap">
      <div class="lg-edcap"><button class="lg-back" type="button" data-act="lg-edback" aria-label="返回">‹</button>
        <b>${esc(catName(parent || null, state.lgCats))}</b>
        <i>选二级（可以不选）</i></div>
      <div class="lg-edgrid">${rows}</div>
    </div>`;
  }
  // ⭐ 一级清单走 `topCats()`（同样是唯一判据：漏掉 `ie` 那一条件就是"收入侧混进支出分类"）
  const cats = topCats(state.lgCats, d.ie);
  const un =
    `<button class="lg-cat lg-cat-un${d.catId == null ? ' on' : ''}" type="button" data-act="lg-edcat" data-cid="0">` +
    `<span class="lg-cat-ico">—</span><span class="lg-cat-name">${CAT_UNCLASSIFIED}</span></button>`;
  return `<div class="lg-edgridwrap"><div class="lg-edgrid">${un}${cats.map(catBtnHtml).join('')}</div></div>`;
}

/**
 * 功能：画一颗分类按钮（**零出网**：内置色块 ＋ 名字首字，照 1 期回落那套）。
 *
 * 说明：⚠️ 2 期**没有**分类图标文件（C-37 的图标集在才落地，`cats/` 目录现在不存在）
 *      ⇒ 一律「色块 ＋ 首字」。⚠️ 有下一级的画一个 `›`，让"点进去还有一层"看得见。
 * @param {Object} c - 一个分类（`{id, name, parent_id}`）
 * @returns {string} 这颗按钮的 HTML
 */
function catBtnHtml(c) {
  const d = state.lgDraft || {};
  const on = Number(d.catId) === Number(c.id);
  // ⚠️ 局部变量别叫 `hasKids`：那会**盖住**从 `entry-calc.js` 引进来的同名函数，
  //    而下面那句判据正是要调它（判据只准一处 ——）
  const more = hasKids(state.lgCats, c.id);
  const color = catColorOf(c.id);
  const ch =
    String(c.name || '')
      .trim()
      .slice(0, 1) || '·';
  return (
    `<button class="lg-cat${on ? ' on' : ''}" type="button" data-act="lg-edcat" data-cid="${Number(c.id)}">` +
    `<span class="lg-cat-ico" style="--lg-c:${color}">${esc(ch)}</span>` +
    `<span class="lg-cat-name">${esc(c.name)}</span>` +
    `${more ? '<i class="lg-cat-more">›</i>' : ''}</button>`
  );
}

/**
 * 功能：画账户选择器里的选项 —— 第一项是**「不关联」**（＝空账户，T3-g /  第 14 条）。
 *
 * 说明：⚠️⭐ 这里**仍然**用**空值**表达"不关联"，由服务端按 `account_id: null` **落到空账户**上
 *      （`routes.js` 的校验表：`null` ⇒ 落空账户）—— 判据在服务端，前端不猜一个 id。
 *      ⚠️ 2 期补上取名口（`account-names`）之后，空账户的 id 确实查得到了，但这条路径**不改成**
 *      "先取空账户的 id 再发上来"：那会让"没关联账户"这个语义绕一圈回到一个具体 id 上，
 *      与服务端「`null` ⇒ 落空账户」这条口径分叉（分叉的表现是同一笔账在两处归到不同账户）。
 * @param {number} sel - 当前选中哪个账户（0 = 不关联）
 * @returns {string} `<option>` 串
 */
function acctOptionsHtml(sel) {
  const one = (v, t, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(t)}</option>`;
  const cur = Number(sel) || 0;
  const out = [one('', '不关联', !cur)];
  let hit = false;
  for (const a of (state.lg && state.lg.accounts) || []) {
    if (Number(a.id) === cur) hit = true;
    out.push(one(String(Number(a.id)), labelOf(a), Number(sel) === Number(a.id)));
  }
  // ⚠️⭐ 0.8.1（改一笔那条路要用它）：原账户**不在活账户清单里**时，照样给它画一项 ——
  //    两种账户会落到这里：① 空账户（＝「不关联」，它按 第 3 条**不进 `accounts[]`**）；
  //    ② 已经删掉的账户（流水一条不少地留着，C-8）。不画的话浏览器会**回落到第一项「不关联」**，
  //    用户只是改了个备注、一保存，这笔账的账户就**被静默换掉了**（不报错、也看不出来）。
  //    名字走**唯一的取名口** `acctNameMap()`（空账户在里面叫「不关联」、已删账户是它的原名）。
  if (cur && !hit) out.push(one(String(cur), acctNameMap().get(cur) || '原账户', true));
  return out.join('');
}

/** 功能：取备注输入框里当前的片段（弹层还没画出来时是空串）。 @returns {string} @since 0.8.0 */
function noteText() {
  const el = $('#lg-ed-note');
  return el ? String(el.value || '') : '';
}

/**
 * 功能：画备注历史候选那几颗小胶囊（`matchNote` 做**本地即时过滤**）。
 *
 * 说明：⭐⭐ 候选**来源只住服务端**（`GET /api/ledger/notes?category=`， 第 1 条 / C-17）
 *      —— 前端⛔ 不许自己 `distinct` 任何东西（反向验证 ⑧ 钉的就是这件事）。
 *      `matchNote()` 只回答"服务端给回来的这 20 条里，哪几条还要显示"。
 * @returns {string} 候选那一段的 HTML
 */
function noteChipsHtml() {
  const text = noteText();
  const list = (state.lgNotes || []).filter((n) => matchNote(text, n));
  if (!list.length) return '';
  return list
    .map(
      (n) => `<button class="lg-notechip" type="button" data-act="lg-ednote" data-note="${esc(n)}">${esc(n)}</button>`,
    )
    .join('');
}

/** 功能：只重画备注候选那一条（⛔ 不重画整张弹层 —— 会把别的格里打的字与光标一起抹掉）。 @returns {void} @since 0.8.0 */
function paintNoteChips() {
  const box = $('#lg-ed-notewrap');
  if (box) box.innerHTML = noteChipsHtml();
}

/**
 * 功能：画「记一笔 / 改一笔」弹层的正文（照方案 §7.2 的线框）。
 *
 * 说明：⚠️ 顶部是 `支出 ｜ 收入` 两段 ＋「取消」；正文是分类网格 ＋ 账户/金额 ＋ 备注/时间；
 *      底部那颗「完成」在弹层的 foot 上（宿主 `openSheet` 的第三参）。
 *      ⚠️ **不自画数字键盘**（金额那格 `inputmode="decimal"` 交给手机 OS —— 参考图 2 下半屏
 *      那个键盘是系统的）；⛔ **不放图片 / 定位**。
 *      ⚠️ 时间用**原生** `datetime-local`（`step="60"` = 秒不可调）；秒按"点开那一刻"在提交时补
 *      （`edSec`）—— 所以那句话只能写在 `title` 里。
 *      ⭐ 0.8.1 补：**改一笔也用它**（`editId > 0`）—— ⛔ 不另画第二份表单。⚠️ 改的是**退款条目**
 *      时只画金额与备注两格（`d.refund`）：退款是"钱退回来了"这件事，方向 / 分类 / 账户 / 时间
 *      都不该在这里动，画出来又能改就是给自己挖坑（服务端那条 PUT 只认它收的那几个键，
 *      改错了照样是 200，然后账就变形了）。
 * @returns {string} 弹层正文 HTML
 */
function entrySheetHtml() {
  const d = state.lgDraft || {};
  if (d.refund) {
    return `<div class="lg-ed">
      <div class="lg-edtop">
        <div class="lg-edcap2">这是退款记录 —— 只能改金额和备注。</div>
        <button class="btn sm" type="button" data-act="lg-edcancel">取消</button>
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-amt">金额</label>
        <input id="lg-ed-amt" type="text" inputmode="decimal" value="${esc(d.amount)}" />
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-note">备注</label>
        <input id="lg-ed-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" />
      </div>
      <div id="lg-ed-notewrap">${noteChipsHtml()}</div>
    </div>`;
  }
  const seg = (key, name) =>
    `<button class="lg-seg-btn${d.ie === key ? ' on' : ''}" type="button" role="tab" aria-selected="${
      d.ie === key
    }" data-act="lg-edie" data-ie="${key}">${name}</button>`;
  return `<div class="lg-ed">
    <div class="lg-edtop">
      <div class="lg-seg" role="tablist">${seg('支出', '支出')}${seg('收入', '收入')}</div>
      <button class="btn sm" type="button" data-act="lg-edcancel">取消</button>
    </div>
    ${edGridHtml()}
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-acct">账户</label>
      <select id="lg-ed-acct">${acctOptionsHtml(d.acctId)}</select>
    </div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-amt">金额</label>
      <input id="lg-ed-amt" type="text" inputmode="decimal" value="${esc(d.amount)}" />
    </div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-note">备注</label>
      <input id="lg-ed-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" />
    </div>
    <div id="lg-ed-notewrap">${noteChipsHtml()}</div>
    <div class="lg-edrow">
      <label class="lg-edlab" for="lg-ed-time">时间</label>
      <input id="lg-ed-time" type="datetime-local" step="60" value="${esc(d.dt)}" title="时间可以改；秒按点开那一刻记" />
    </div>
  </div>`;
}

/** 功能：把「记一笔 / 改一笔」弹层按草稿重画一遍（换收支 / 点分类 / 返回都要走它）。 @returns {void} @since 0.8.0 */
function paintEntrySheet() {
  bindPickChange();
  openSheet(
    // ⭐ 标题说清这一次是"新记"还是"改一条"（`editId` 是这两条路唯一的分叉）
    editId ? '改一笔' : '记一笔',
    entrySheetHtml(),
    `<button class="btn primary" type="button" data-act="lg-edsave" style="flex:1.4">完成</button>`,
  );
}

/**
 * 功能：把「记一笔」弹层上填的值读回草稿。
 *
 * 说明：⚠️ 选择器**必须带 `#`**：写成裸 id 会被 `$()` 当成标签名 ⇒ 恒回 `null` ⇒
 *      读成空串静默提交（11-踩坑第 32 条，1 期真踩过）。
 * @returns {void}
 */
function entryCapture() {
  const d = state.lgDraft;
  if (!d) return;
  const amt = $('#lg-ed-amt');
  if (amt) d.amount = String(amt.value || '').trim();
  const note = $('#lg-ed-note');
  if (note) d.note = String(note.value || '').trim();
  const acct = $('#lg-ed-acct');
  if (acct) d.acctId = Number(acct.value) || 0;
  const tm = $('#lg-ed-time');
  if (tm && tm.value) d.dt = String(tm.value);
}

/**
 * 功能：开「记一笔」—— 建一份草稿、按默认账户预填、画弹层，并去拉一次备注候选。
 *
 * 说明：⭐ 账户**按类别 → 全局（按收 / 支）→ 空账户**预填，取值顺序只住 `entry-calc.js` 的
 *      `pickDefaultAccount()`—— ⛔ 这里不写第二份 if/else。
 *      ⚠️ 时间预置"点开那一刻"：日期＝**服务端今天**，时:分＝本机时钟，
 *      秒留着提交时补（`edSec`）。
 *      ⚠️ 分类没读到就**不开这张弹层**并说清原因（分类网格是它的主体，空着没意义）。
 * @returns {Promise.<void>}
 */
export async function lgEntryAdd(prefill) {
  // ⭐⭐ 0.8.55：AI 确认卡点「修改」时带预填进来 —— 仍是这一张弹层、这一条创建路径
  const p = prefill && typeof prefill === 'object' ? prefill : null;
  const ok = await ensureCats();
  if (!ok || !state.lgCats.length) {
    toast('收支分类没读到，点「重新加载」再试一次', true);
    return;
  }
  await ensureDefaults();
  const today = (state.lg && state.lg.today) || '';
  const { hm, ss } = nowPrefix();
  edSec = ss;
  // ⭐ 这是**新建**那条路 ⇒ 把"正在编辑"那一套清干净（不清的话会带着上一条的 editId 发 PUT）
  resetEdit();
  state.lgDraft = {
    ie: p && (p.ie === '收入' || p.ie === '支出') ? p.ie : '支出',
    amount: p && p.amount != null ? String(p.amount) : '',
    catId: p && Number(p.catId) ? Number(p.catId) : null,
    acctId: 0,
    note: p && p.note != null ? String(p.note) : '',
    dt: p && p.dt ? String(p.dt) : today ? `${today}T${hm}` : '',
    second: 0,
  };
  state.lgDraft.acctId =
    p && p.acctId != null && Number(p.acctId) > 0
      ? Number(p.acctId)
      : pickDefaultAccount({
          defaults: defaultsRows(),
          categoryId: state.lgDraft.catId,
          ie: state.lgDraft.ie,
          emptyAccountId: 0,
        });
  state.lgNotesCat = null;
  state.lgNotes = [];
  paintEntrySheet();
  loadNotes(null);
}

/**
 * 功能：换「支出 / 收入」—— 重取默认账户，并清掉另一侧的类别。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-ie` 取方向）
 * @returns {void}
 */
export function lgEntryIe(_act, n) {
  const d = state.lgDraft;
  const ie = String((n && n.dataset && n.dataset.ie) || '');
  if (!d || (ie !== '支出' && ie !== '收入')) return;
  entryCapture();
  if (d.ie !== ie) {
    d.ie = ie;
    // ⚠️ 分类是按收 / 支分的 ⇒ 换一边就清掉（⛔ 别把一个支出分类挂到收入那一笔上）
    d.catId = null;
    d.second = 0;
    // ⭐ 改了**只影响这一次**，⛔ 不回写默认
    d.acctId = pickDefaultAccount({ defaults: defaultsRows(), categoryId: null, ie, emptyAccountId: 0 });
  }
  paintEntrySheet();
}

/**
 * 功能：点了一个分类（`0` = 「未分类」）—— 记进草稿、重取默认账户、必要时出第二屏。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-cid` 取分类 id）
 * @returns {void}
 */
export function lgEntryCat(_act, n) {
  const d = state.lgDraft;
  if (!d) return;
  entryCapture();
  const cid = Number((n && n.dataset && n.dataset.cid) || 0);
  if (!cid) {
    // 「未分类」是**正经选择**：显示成「未分类」，⛔ 不是「其它」（C-32）
    d.catId = null;
    d.second = 0;
  } else {
    d.catId = cid;
    // ⭐ 「有没有孩子」（进不进第二屏）走 `hasKids()` —— 它就是 `childCats().length > 0`：
    //    两边若各写一套过滤，就会出现"进了第二屏、里面是空的"（用户点了个不确定的东西，还不报错）
    // ⭐⭐ 0.8.22（「【记一笔】进入二级过后，选了二级不要返回一级界面」）：
    //    只在**还没进第二屏**（`d.second` 为空）时才按"它有没有下级"决定进不进那一屏；
    //    已经站在第二屏里点二级 ⇒ **保持 `d.second` 不动、留在这一屏**。
    //    ⚠️ 从前一律重算 `second`，而二级没有下级 ⇒ 当场弹回一级：用户刚点的那一格
    //    一闪就没了（他以为"没选中"）。要回一级有那颗「‹ 返回」（`lgEntryBack`），
    //    ⛔ 不是靠点一下自动跳回。⚠️ 电脑端 `edPickCat()` 逐字同款，改一处要改两处。
    if (!d.second) d.second = hasKids(state.lgCats, cid) ? cid : 0;
  }
  d.acctId = pickDefaultAccount({ defaults: defaultsRows(), categoryId: d.catId, ie: d.ie, emptyAccountId: 0 });
  paintEntrySheet();
  loadNotes(d.catId);
}

/**
 * 功能：分类网格第二屏的「‹ 返回」—— 停在那个一级分类上（二级**可以不选**， 第 8 条）。
 * @returns {void}
 */
export function lgEntryBack() {
  entryCapture();
  if (state.lgDraft) state.lgDraft.second = 0;
  paintEntrySheet();
}

/**
 * 功能：「取消」—— 连草稿一起清（不清的话下次「记一笔」会把上回没提交的那份填回来）。
 * @returns {void}
 */
export function lgEntryCancel() {
  state.lgDraft = null;
  state.lgNotes = [];
  state.lgNotesCat = null;
  // ⭐ 取消「改一笔」时也要把编辑态清掉：留着 `editId` 的话，下一次「记一笔」会去改那一条
  //   （而用户以为自己是在新记一笔 —— 表现是"记了一笔，结果旧的那条变了"）
  resetEdit();
  closeSheet();
}

/**
 * 功能：点了一颗备注候选 —— 填进备注框（⛔ 不关弹层、⛔ 不自动提交），并把候选重筛一遍。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗胶囊（从 `data-note` 取候选）
 * @returns {void}
 */
export function lgEntryNote(_act, n) {
  const el = $('#lg-ed-note');
  if (!el) return;
  el.value = String((n && n.dataset && n.dataset.note) || '');
  if (state.lgDraft) state.lgDraft.note = el.value;
  paintNoteChips();
  el.focus();
}

/**
 * 功能：拉一次备注历史候选（按当前类别过滤；没选类别就取全部）。
 *
 * 说明：⭐ 候选**只由服务端给**（⛔ 前端不 `distinct`）；读不到就**不给候选**，
 *      但⛔ 绝不因此拦着记账本身（那是一个可有可无的便利）。
 * @param {?number} catId - 当前类别（`null` = 全部类别）
 * @returns {Promise.<void>}
 */
async function loadNotes(catId) {
  state.lgNotesCat = catId == null ? null : Number(catId);
  try {
    const q = state.lgNotesCat == null ? '' : `?category=${state.lgNotesCat}`;
    const r = await api('GET', `/api/ledger/notes${q}`);
    state.lgNotes = Array.isArray(r && r.notes) ? r.notes : [];
  } catch (_e) {
    state.lgNotes = [];
  }
  paintNoteChips();
}

/**
 * 功能：把 `datetime-local` 的值（`YYYY-MM-DDTHH:MM`）拼成服务端要的 `YYYY-MM-DD HH:MM:SS`。
 *
 * 说明：⭐ 秒**由前端补**（`edSec` ＝ 点开那一刻的真实秒）：控件只到分钟、秒不可调
 *      —— 所以"秒"这件事只能在提交这一步补上，⛔ 不改用户改过的日期与时刻。
 * @param {Object} d - 草稿
 * @returns {string} 时刻串；形状不对时是空串
 */
function edAt(d) {
  const v = String((d && d.dt) || '').replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return '';
  return `${v}:${String(edSec || '00').padStart(2, '0')}`;
}

/**
 * 功能：提交「记一笔 / 改一笔」—— ⛔ 金额 / 金额边界的校验交给服务端（唯一一份判据）。
 *
 * 说明：⭐⭐ 改一笔走的是 **逐键** 那条路（`PUT /api/ledger/entries/:id`）：`editOrig` 里存着原值，
 *      这里**只把真改过的键**放进请求体。理由与 `putDefaults()` / `lgSave()` 逐字相同 ——
 *      整份原样提交会把"我没动过的字段"也重写一遍，万一同一个字段刚在别处被改过，
 *      这一下就**静默覆盖**回去了。
 *      ⚠️ 一个键都没变 ⇒ **不发请求**，说一句「没有改动」就关掉（发上去服务端也会 400
 *      「没有要改的内容」——让用户看见一句红话，纯属自找）。
 * @returns {Promise.<void>}
 */
export async function lgEntrySave() {
  const d = state.lgDraft;
  if (!d) return;
  entryCapture();
  const at = edAt(d);
  if (!at) {
    toast('时间没填全', true);
    return;
  }
  if (!d.amount) {
    toast('填一下金额（可以是 0）', true);
    const el = $('#lg-ed-amt');
    if (el) el.focus();
    return;
  }
  const catId = d.catId == null ? null : Number(d.catId);
  // ⚠️ 空值 ⇒ 服务端落到**空账户**上（「不关联」就是它）
  const acctId = d.acctId ? Number(d.acctId) : null;
  const note = String(d.note == null ? '' : d.note);
  const body = {};
  if (editId) {
    const o = editOrig || {};
    // ⚠️ 逐键比较的两边必须**同一口径**：时间比"补完秒之后"的串（`at` 比 `o.at`），
    //    金额比输入框里的串（`fenToInput` 出来的是什么就比什么）—— 否则会永远"看着变了"。
    if (at !== String(o.at || '')) body.at = at;
    if (d.ie !== String(o.ie || '')) body.ie = d.ie;
    if (String(d.amount) !== String(o.amount == null ? '' : o.amount)) body.amount = String(d.amount);
    if (catId !== (o.category_id == null ? null : Number(o.category_id))) body.category_id = catId;
    if (acctId !== (o.account_id == null ? null : Number(o.account_id))) body.account_id = acctId;
    if (note !== String(o.note == null ? '' : o.note)) body.note = note;
    if (!Object.keys(body).length) {
      toast('没有改动');
      state.lgDraft = null;
      state.lgNotes = [];
      resetEdit();
      closeSheet();
      return;
    }
  } else {
    body.at = at;
    body.ie = d.ie;
    body.amount = String(d.amount);
    body.category_id = catId;
    body.account_id = acctId;
    body.note = note;
  }
  try {
    if (editId) await api('PUT', `/api/ledger/entries/${Number(editId)}`, body);
    else await api('POST', '/api/ledger/entries', body);
    const editing = !!editId;
    closeSheet();
    state.lgDraft = null;
    state.lgNotes = [];
    resetEdit();
    // ⭐ 记完 / 改完都**重取**：余额 / 净值是服务端算的，在本地跟着改一遍就是第二套算术；
    //    流水也从第一页重取（新记的那笔要在最上面，改过的那条要显示新样子）。
    await loadLedger();
    await loadEntries(true);
    toast(editing ? '改好了' : '记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：开「记退款」弹层 —— 给这一笔原交易退一笔（`POST /api/ledger/entries/:id/refunds`）。
 *
 * 说明：⭐ 账户与类别**默认沿用原交易**（钱退回原卡、类别不变，C-25）⇒ 这里只问金额 / 时间 / 备注，
 *      ⛔ 不让用户在这儿改账户（那会让"退回原卡"这条口径多出第二个入口）。
 *      ⚠️ 「累计 ≤ 原额」由**服务端**在一个事务里判（C-13），前端不预判、不重复实现。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-id` 取原交易 id）
 * @returns {void}
 */
export function lgRefund(_act, n) {
  const rid = Number((n && n.dataset && n.dataset.id) || 0);
  const e = (state.lgEntries || []).find((x) => Number(x.id) === rid);
  if (!e) return;
  refundOf = rid;
  const today = (state.lg && state.lg.today) || '';
  const { hm, ss } = nowPrefix();
  edSec = ss;
  // 预填**还能退多少**（原额 − 已退），而不是原额：已经退过一部分时预填原额会直接撞上限
  const left = Math.max(0, Math.trunc(Number(e.amount_fen) || 0) - Math.trunc(Number(e.refund_fen) || 0));
  openSheet(
    '记退款',
    `<div class="lg-ed">
      <div class="lg-edcap2">给「${esc(entryTitle(e, state.lgCats))}」退款 —— 这笔会作为<b>收入</b>加回原账户。</div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-rfamt">退款金额</label>
        <input id="lg-ed-rfamt" type="text" inputmode="decimal" value="${esc(fenToInput(left))}" />
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-rftime">时间</label>
        <input id="lg-ed-rftime" type="datetime-local" step="60" value="${esc(today ? `${today}T${hm}` : '')}" />
      </div>
      <div class="lg-edrow">
        <label class="lg-edlab" for="lg-ed-rfnote">备注</label>
        <input id="lg-ed-rfnote" type="text" maxlength="${NOTE_MAX}" />
      </div>
    </div>`,
    `<button class="btn primary" type="button" data-act="lg-rfsave" style="flex:1.4">确认退款</button>`,
  );
}

/**
 * 功能：提交一笔退款 —— ⛔ 金额与「累计不许超原额」都交给服务端判。
 * @returns {Promise.<void>}
 */
export async function lgRefundSave() {
  const aid = Number(refundOf) || 0;
  if (!aid) return;
  const amtEl = $('#lg-ed-rfamt');
  const tmEl = $('#lg-ed-rftime');
  const noteEl = $('#lg-ed-rfnote');
  const amount = String((amtEl && amtEl.value) || '').trim();
  const at = edAt({ dt: tmEl ? tmEl.value : '' });
  const note = String((noteEl && noteEl.value) || '').trim();
  if (!amount) {
    toast('填一下退款金额', true);
    if (amtEl) amtEl.focus();
    return;
  }
  if (!at) {
    toast('时间没填全', true);
    return;
  }
  try {
    await api('POST', `/api/ledger/entries/${aid}/refunds`, { at, amount, note });
    closeSheet();
    refundOf = 0;
    // ⚠️ 退款会作为一条记账出现在原账户的明细里 ⇒ `overview` 与流水都重取。
    await loadLedger();
    await loadEntries(true);
    toast('退款记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

// ============================================================================
// ⭐ 0.8.1（§7.2 / C-11 / C-34）：**记账设置**（手机端是底部导航第三格；电脑端那边是宽弹窗）
// ============================================================================

/** 功能：画记账设置里某个下拉的选项。 @param {number} sel - 当前账户 id（0 = 没设） @param {boolean} allowEmpty - 允不允许「跟随全局默认」 @returns {string} @since 0.8.0 */
function defOptions(sel, allowEmpty) {
  const one = (v, t, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(t)}</option>`;
  const out = [];
  if (allowEmpty) out.push(one('', '跟随全局默认', !Number(sel)));
  for (const a of (state.lg && state.lg.accounts) || []) {
    out.push(one(String(Number(a.id)), labelOf(a), Number(sel) === Number(a.id)));
  }
  return out.join('');
}

// ---------- ⭐ 0.8.21：设置页那一栏（`settings-pane` 片段）对外的三件东西 ----------

/**
 * 设置页那一栏的**重画钩子** —— `mobile-settings-pane.js` 挂载时登记，⛔ 只登记一个。
 * @type {?function()}
 */
let setPaneRepaint = null;

/**
 * 功能：登记 / 注销设置页那一栏的重画钩子（片段挂载时传 `fn`，卸载时传 `null`）。
 * @param {?function()} fn - 重画函数；传非函数即注销
 * @returns {void}
 * @since 0.8.21
 */
export function setSettingsPaneRepaint(fn) {
  setPaneRepaint = typeof fn === 'function' ? fn : null;
}

/** 功能：重画设置页那一栏（没挂就什么都不做）。 @returns {void} @since 0.8.21 */
function repaintSetPane() {
  if (setPaneRepaint) setPaneRepaint();
}

/**
 * 功能：记账设置那几块的**正文**（设置页那一栏用；`page` 空串 = 首页四条目那张列表）。
 *
 * 说明：⚠️ 与账本屏里那一份是**同一支**（`setHomeHtml()` / `setPageBodyHtml()`）——
 *      ⛔ 别为设置页另写一套：那就是两份真相，迟早一处改了另一处不改（而且**不报错**）。
 * @param {string} page - `SET_PAGES` 里的 `key`（认不出一律回**首页**）
 * @returns {string} 正文的 HTML
 * @since 0.8.21
 */
export function ledgerSetHtml(page) {
  const k = setPageOf(page);
  return k ? setPageBodyHtml(k) : setHomeHtml(true);
}

/**
 * 功能：设置页那一栏**现在该展开哪一子页**（空串 = 只列那四条）。
 *
 * 说明：⚠️ 那一栏的展开状态**就是 `state.lgSetPage`**（与账本屏的设置格共用同一个值）——
 *      于是「点条目 / 点 ‹ 返回」那两下**不用另写一套**：`lgSetGo()` / `lgSetBack()` 改完它
 *      本来就会调 `renderLedger()`，而那一趟会回调本栏的重画钩子（见 `setSettingsPaneRepaint()`）。
 *      ⚠️ 用户从设置页点进去、再回账本屏时**不会串**：`lgSegPick()` 换格时会把 `lgSetPage` 清空。
 * @returns {string} `SET_PAGES` 的 `key` 或空串
 * @since 0.8.21
 */
export function ledgerSetPageNow() {
  return setPageOf(state.lgSetPage);
}

/**
 * 功能：设置页那一栏的 `change` —— 那三处「默认账户」（与账本屏那条委托是**同一支**）。
 *
 * 说明：⚠️ 判据只写在这里一处；`bindLedgerOnce()` 那条 `change` 也调它（⛔ 别再抄一份）。
 * @param {HTMLElement} t - 触发 `change` 的元素
 * @returns {void}
 * @since 0.8.21
 */
export function handleLedgerSetChange(t) {
  if (!t) return undefined;
  if (t.id === 'lg-def-income') globalDefChanged('income', t);
  else if (t.id === 'lg-def-expense') globalDefChanged('expense', t);
  else if (t.dataset && t.dataset.defacct) catDefChanged(t);
  return undefined;
}

/**
 * 功能：备好**记账设置**那几块要用的数据（设置页那一栏挂载时先调它）。
 *
 * 说明：⚠️⚠️ 那一栏完全可能**在账本屏从没挂过的时候**被打开（用户直接进设置页）⇒ 它得自己
 *      把这几份取回来，⛔ 不能指望 `mountLedger()` —— 那一个还会按当前那一格把流水 / 预算一起拉，
 *      在设置页里全是白拉的。
 *      ⚠️ 四份都**取不到也不拦**（与 `mountLedger()` 同一条口径）：分类读不到只是那几行的
 *      下拉空着；拦下来用户看到的是"记账设置打不开"。
 * @returns {Promise.<void>}
 * @since 0.8.21
 */
export async function prepareLedgerSettings() {
  await Promise.all([loadLedger(), ensureAcctNames(), ensureCats(true), ensureDefaults(true)]);
  // ⚠️ 「导入三方数据」那一页要的是**概况**（三态）——与 `lgSegPick()` 进设置格时同一条路。
  loadImportSummary();
}

/**
 * 功能：画「记账设置」的**首页** —— ⭐ 0.8.3 起它是**二级菜单的第一层**（四条目那张列表）。
 *
 * 说明：⭐⭐ 「设置增加二级菜单，现在要滑动到底很不方便」——
 *      原来这一屏是**一条长滚动**（收支账户 ＋ 收支分类 ＋ 导入三方数据 三栏叠在一起；
 *      「每种类别的默认账户」光预置分类就有 34 行，分类树更长）⇒ 改成**首页点进子页**。
 *      ⚠️ 四条目的清单（`key` / `name` / `desc`）与判据**只住 `calc.js`**
 *      （`SET_PAGES` / `setPageOf()`）—— 电脑端逐字同一份，⛔ 两端各写一份必然漂移。
 *      ⚠️ 首页**刻意不给**任何一格画状态摘要（如"34 个分类"）：那要么再取一次数、
 *      要么从手上这份猜一个（＝两份真相，迟早对不上），而这一层要的只是「知道里面有什么」。
 *      ⚠️ 它自己**要画底部那四格 ＋ 那颗悬浮笔按钮**（调用方 `renderLedger()` 拼上
 *      `paintAssetsFab()` / `segNavHtml()`）—— 首页是「设置」那一格的第一层，与资产 / 预算完全并列；
 *      **子页**才收起底栏、也不画那颗笔（见 `renderLedger()`）。
 *      ⚠️ 条目的键是 `data-act="lg-setgo"` ＋ `data-page="<key>"`（两端同名：电脑端是
 *      `data-lg="setgo"`）—— 漏登记宿主的 `ACTIONS` 表＝点了没反应且**不报错**。
 * @returns {string} 首页的 HTML
 * @since 0.8.2
 */
function setHomeHtml(plain) {
  const items = SET_PAGES.map(
    (p) =>
      `<button class="lg-setitem" type="button" data-act="lg-setgo" data-page="${p.key}">` +
      `<span class="lg-setitem-main"><b>${esc(p.name)}</b><i>${esc(p.desc)}</i></span>` +
      '<span class="lg-setitem-go" aria-hidden="true">›</span></button>',
  ).join('');
  // ⭐ 0.8.21：`plain` = **设置页那一栏**要的那一份 —— 那一栏自己已经有标题（`settingsPane.label`）
  //    ⇒ ⛔ 不再重复画「记账设置」那句小标题。账本屏里那一份照旧带标题。
  if (plain) return `<div class="lg-setlist">${items}</div>`;
  return `<div class="lg-set">
    <div class="lg-setcap"><b>记账设置</b><i>记账时按这里预填账户；分类改完当场生效。</i></div>
    <div class="lg-setlist">${items}</div>
  </div>`;
}

/**
 * 功能：按 `key` 画设置**子页**的正文（⛔ 不含顶上那条「‹ 返回」头 —— 那是调用方配的）。
 *
 * 说明：⚠️ `page` 必须是 `setPageOf()` 认得的值（调用方已经过它一道）⇒ 这里认不出就回空串，
 *      ⛔ 别再回落某一页（那会让人站在一个没点过的地方，而且**不报错**）。
 * @param {string} page - `'acct'`（收支账户）/ `'cat'`（收支分类）/ `'imp'`（导入三方数据）/
 *      `'exp'`（导出数据）
 * @returns {string} 这一页正文的 HTML
 * @since 0.8.2
 */
function setPageBodyHtml(page) {
  if (page === 'acct') return setAcctHtml();
  if (page === 'cat') return setCatHtml();
  if (page === 'imp') return setImpHtml();
  if (page === 'exp') return setExpHtml();
  return '';
}

/**
 * 功能：画设置子页【收支账户】—— 全局两行（默认收入 / 默认支出）＋「每种类别的默认账户」。
 *
 * 说明：⭐⭐ 两条口径（一起改）：
 *      · **全部当场生效**：这一页原来底部有一颗「保存」（`.lg-setsave`），现在**撤了** ——
 *        每一颗下拉 / 那枚 ✕ 一改就提交（**逐键** `PUT /api/ledger/defaults`），
 *        存完从服务端**回读**再重画 ⇒ 下拉里显示的是真值，而不是"我刚选的那一项"。
 *      · **「每种类别的默认账户」改成按需新增**：原来把手上**全部**分类都铺出来（内置就 22 行，
 *        还要一直往下滑），现在**只列已经设过的那几个**；要设新的走底部那颗「＋ 新增」
 *        （弹层里挑类别，见 `lgDefNew()`）。
 *      ⚠️ 全局两行（收入 / 支出）**只改不删**⇒ 界面上**不画 ✕**
 *        （画了才 400 是最差的一种：用户以为能删），下拉里也**没有**「跟随全局默认」那一档
 *        （它自己就是全局）—— 见 `defOptions()`。每类别那枚 ✕ 是**清掉那一行设置**
 *        （提交 `null` ⇒ 回落到全局默认），⛔ 不是删分类。
 *      ⚠️⭐ 两行全局下拉的 `id`（`#lg-def-income` / `#lg-def-expense`）与每类别那几颗的
 *        `data-defacct` 是**读回那一头的钩子**（`bindLedgerOnce()` 的 change 分支按它们认人）
 *        —— 改名 / 去掉就必须连读回那头一起改（「删掉一格 UI 必须把读回那一头一起删」）。
 *      ⚠️ 每类别的名字走 `catFullName()`（**二级带上级**：`餐饮-早餐`）—— 判据只住 `calc.js`
 *        ；⛔ 不用 `.lg-setind` 那种缩进（这里一行只有一个类别，缩进反而看不出是哪条）。
 *      ⛔ 别的栏等有了消费者再加。
 * @returns {string} 这一页的 HTML
 * @since 0.8.2
 */
function setAcctHtml() {
  const d = state.lgDefaults || { income: null, expense: null, categories: [] };
  const cats = state.lgCats || [];
  // ⚠️ 只列**已经设过**的那些（`d.categories` 就是"显式设过的"清单）—— 分类本身取不到
  //    （被硬删过：`restore-builtin` 那条路）就跳过：没有名字可显示，也清不掉它。
  const rows = (d.categories || [])
    .map((x) => {
      const c = catFind(x.category_id);
      if (!c) return '';
      const name = catFullName(cats, c);
      return (
        `<div class="lg-setrow"><span class="lg-setname">${esc(name)}</span>` +
        `<select data-defacct="${Number(c.id)}" aria-label="${esc(name)} 的默认账户">${
          defOptions(x.account_id, true)
        }</select>` +
        `<button class="lg-defx" type="button" data-act="lg-defdel" data-id="${Number(c.id)}" ` +
        `aria-label="取消「${esc(name)}」的默认账户">✕</button></div>`
      );
    })
    .join('');
  return `<div class="lg-setcap"><b>收支账户</b><i>记账时的默认账户，记账时自动选择，可以更改。</i></div>
    <div class="lg-setrow"><span class="lg-setname">默认收入账户</span><select id="lg-def-income" aria-label="默认收入账户">${defOptions(
      d.income,
      false,
    )}</select></div>
    <div class="lg-setrow"><span class="lg-setname">默认支出账户</span><select id="lg-def-expense" aria-label="默认支出账户">${defOptions(
      d.expense,
      false,
    )}</select></div>
    <div class="lg-setcap"><b>每种类别的默认账户</b><i>给单个类别设置独立的默认账户。</i></div>
    ${rows || '<div class="lg-txwait">还没给任何类别单设。</div>'}
    <button class="btn lg-defadd" type="button" data-act="lg-defnew">＋ 新增</button>`;
}

/**
 * 功能：画设置子页【收支分类】—— 支出 / 收入两棵树 ＋「＋ 新建一级分类」＋「恢复内置分类」。
 *
 * 说明：⭐ 0.8.1 补的这一栏（真机验收第 2 条「二级分类没有」）——
 *      预置的 34 行**全是零级**（照一手样本抄的，样本那一列就是 31 个扁平名字），
 *      所以补的不是数据、是**让用户自己建二级分类的界面**（分类可建、可改名、删除＝归档）。
 *      ⚠️⭐ 0.8.3：那一句「删除＝归档」**作废了** —— 归档与删除从此是**两件事**
 *      （归档＝行留着、可恢复；删除＝行没了、不可恢复）⇒ 这一页顶上那句摘要必须跟着改，
 *      ⛔ 留着旧说法就是把"删了还能恢复"说给用户听（他会放心地点下去）。
 *      ⚠️ 这一页里每个动作都是**当场生效**的（建 / 改名 / 归档 / 删除 / 恢复 / 恢复内置）
 *      ⇒ **没有**保存按钮。
 * @returns {string} 这一页的 HTML
 * @since 0.8.2
 */
function setCatHtml() {
  // ⭐⭐ 0.8.22（「这两个按键固定在底部」）：两颗底部动作包进 `.lg-capfoot`
  //    —— 它是 `position: sticky; bottom: 0`（钉在**滚动容器** `#view-ledger` 的底边）。
  return `<div class="lg-setcap"><b>收支分类</b><i>建好之后，「记一笔」里就会多出这一层。归档＝先收起来，还能恢复；删除＝真的去掉，用它记过的账会移到「其它」。</i></div>
    ${catTreeHtml('支出')}
    ${catTreeHtml('收入')}
    <div class="lg-capfoot">
      <button class="btn lg-capnew" type="button" data-act="lg-catnew">＋ 新建一级分类</button>
      ${catRestoreHtml()}
    </div>`;
}

/**
 * 功能：画设置子页【导入三方数据】—— 那两块说明 ＋「鲨鱼记账」那一行 ＋ 概况。
 *
 * 说明：⚠️ 概况是三态（正在读取 / 读不到 / 有数）—— 它由 `impSummaryHtml()` 一处画，
 *      进屏与这一页的重画都走同一个函数（⛔ 不在这里另判一遍三态）。
 * @returns {string} 这一页的 HTML
 * @since 0.8.2
 */
function setImpHtml() {
  return `<div class="lg-setcap"><b>导入三方数据</b><i>${IMP_HELP}</i></div>
    <div class="lg-setrow"><span class="lg-setname">${IMP_LABEL}</span>
      <button class="lg-impbtn" type="button" data-act="lg-imp-open">导入</button></div>
    ${impSummaryHtml()}`;
}

/**
 * 功能：画设置子页【导出数据】—— ① 导什么（多选）② 开始 / 结束时间 ③「导出」。
 *
 * 说明：⭐⭐ 三条硬口径：
 *      · **导什么**取自 `EXPORT_WHATS`（`calc.js` 的唯一出处）—— 勾几样就**下几个文件**
 *        （⛔ 不引 zip、⛔ 不引 Blob），每次一个 `.csv`；
 *      · ⭐ 0.8.4（给的那张图）：**时间范围改成「开始时间 / 结束时间」两行**
 *        （原来是「全部 / 某年 / 某月」一颗下拉）—— 那两颗的**起点**由服务端给
 *        （`/api/ledger/periods` 的 `export.from` / `.to`，见 `expFromOf()`），
 *        ⛔ 前端不算日期（项目纪律）；
 *      · **下载走浏览器导航**（先弹确认 → 再 `location.href`，照设置页那两处），
 *        ⛔ 不走「先取文本再拼 `Blob`」那条路（`Blob` / `URL.createObjectURL` 全仓零命中，
 *        不新开技术路径）。
 *      ⚠️ 导「账户余额」时时间**对它没有意义**（余额没有时间这一说）⇒ 那两行**画成不可选**
 *        ＋ 一句人话（⛔ 不静默忽略）；那一次请求也就**不带日期**。
 *      ⚠️ **空数据也要能导出**（接口回「表头 ＋ 0 行」）⇒ 前端⛔ 不拦「没有数据就不给下」。
 * @returns {string} 这一页的 HTML
 * @since 0.8.2
 */
function setExpHtml() {
  const keys = expWhatKeys();
  const applies = expRangeApplies(keys);
  const rows = EXPORT_WHATS.map(
    (w) =>
      `<label class="lg-expitem"><input type="checkbox" data-act="lg-exp-what" data-key="${esc(w.key)}"${
        keys.includes(w.key) ? ' checked' : ''
      }><span class="lg-expname">${esc(w.name)}</span><i class="lg-expdesc">${esc(w.desc)}</i></label>`,
  ).join('');
  return `<div class="lg-setcap"><b>导什么</b><i>勾选要导出的数据</i></div>
    ${rows}
    ${expDateRowHtml('lg-exp-from', '开始时间', expFromOf(), applies)}
    ${expDateRowHtml('lg-exp-to', '结束时间', expToOf(), applies)}
    ${
      applies
        ? ''
        : '<div class="lg-expnote">导出「账户余额」不看时间 —— 它导的是账户此刻的余额。</div>'
    }
    <div class="lg-expgo"><button class="btn primary lg-expbtn" type="button" data-act="lg-exp-dl">导出</button></div>`;
}

/**
 * 功能：导出页当前勾中的几样 —— ⭐ **按 `EXPORT_WHATS` 的顺序**并滤掉认不出的键（判据只住这一处）。
 * @returns {Array.<string>} 勾中的 `what` 键（顺序固定）
 * @since 0.8.2
 */
function expWhatKeys() {
  const raw = Array.isArray(state.lgExportWhat) ? state.lgExportWhat : [];
  return EXPORT_WHAT_KEYS.filter((k) => raw.includes(k));
}

/**
 * 功能：这一份**时间范围**对勾中的内容**有没有意义** —— ⭐ 只要勾了「账户余额」以外的一样，就有。
 *
 * 说明：⚠️ 「账户余额」是**此刻**的余额，没有时间这一说 ⇒ 只勾它时那两颗日期框要禁用
 *      （画成不可选 ＋ 一句人话，⛔ 不是静默忽略）。
 * @param {Array.<string>} keys - 勾中的几样
 * @returns {boolean} 时间范围是否有意义
 * @since 0.8.2
 */
function expRangeApplies(keys) {
  return keys.some((k) => k !== 'accounts');
}

/**
 * 功能：一样导出内容的**显示名**（确认文案与提示里要用）。
 * @param {string} what - `EXPORT_WHATS` 的 key
 * @returns {string} 显示名
 * @since 0.8.2
 */
function expWhatName(what) {
  const w = EXPORT_WHATS.find((x) => x.key === what);
  return (w && w.name) || String(what || '');
}

/**
 * 功能：导出的接口地址（⭐ 下载走**浏览器导航**，⛔ 不用 fetch + Blob）。
 *
 * 说明：⚠️ 两个日期**都空就不带这两个参数**（＝不限）—— 只勾「账户余额」时正是这一种
 *      （它没有时间这一维）。
 * @param {string} what - 导什么
 * @param {string} from - 开始日期 `YYYY-MM-DD`（空串 = 不限）
 * @param {string} to - 结束日期 `YYYY-MM-DD`（空串 = 不限）
 * @returns {string} 接口 URL
 * @since 0.8.2
 */
function expUrlOf(what, from, to) {
  let u = `${BASE}/api/ledger/export?what=${encodeURIComponent(what)}`;
  if (from) u += `&from=${encodeURIComponent(from)}`;
  if (to) u += `&to=${encodeURIComponent(to)}`;
  return u;
}

/**
 * 功能：下载前那句确认文案 —— ⭐ 必须能看出「这次导了什么、哪一段时间」。
 *
 * 说明：⚠️ **不编条数**：要让前端知道条数就得先取一次数据（多一趟请求，而且那一份与真正
 *      下载到的可能不是同一刻）⇒ 只说「导什么 + 哪一段」。空数据也照样导（只有表头）。
 * @param {string} what - 导什么
 * @param {string} from - 开始日期
 * @param {string} to - 结束日期
 * @returns {string} 一句人话
 * @since 0.8.2
 */
function expConfirmText(what, from, to) {
  const name = expWhatName(what);
  if (what === 'accounts') return `将下载一份 CSV：${name}。账户余额不看时间，导的是账户此刻的余额。`;
  return `将下载一份 CSV：${name}（${exportDateText(from)} ~ ${exportDateText(
    to,
  )}）。空数据也会导出，文件里只有表头。`;
}

/**
 * 功能：勾 / 取消勾一样「导什么」—— ⭐ 只改 state 再重画（⛔ 不取数、⛔ 不发请求）。
 *
 * 说明：⚠️ 勾选状态**必须住 state**（`state.lgExportWhat`）—— 重画会把写在 DOM 上的 checked
 *      抹掉；重画那一趟也把「范围要不要禁用」一起算对。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那颗复选框
 * @returns {void}
 * @since 0.8.2
 */
export function lgExpWhat(_act, n) {
  const key = String((n && n.dataset && n.dataset.key) || '');
  if (!EXPORT_WHAT_KEYS.includes(key)) return;
  const cur = new Set(expWhatKeys());
  if (n.checked) cur.add(key);
  else cur.delete(key);
  state.lgExportWhat = EXPORT_WHAT_KEYS.filter((k) => cur.has(k));
  renderLedger();
}

/**
 * 功能：画导出页那两颗**日期行**（`开始时间` / `结束时间`）—— 左边名字、右边 `2026.09.28` 加一个 `›`。
 *
 * 说明：⭐⭐ **原生 `<input type="date">` 透明铺满整行**（`opacity: 0; inset: 0`）：点整行任意处
 *      都开系统那套日期选择器（手机 / 电脑都是它），⛔ 不自造一个日历控件
 *      （本项目既有先例：日历 / 待办 / 聊天那几处都用原生 `type="date"`）。
 *      ⚠️ 右边那串字是**画出来的**（原生框在中文环境会显示成 `2026/09/28`，各浏览器还不一样）
 *      —— 两边都由 `calc.js` 的 `exportDateText()` 给（唯一一份口径）。
 *      ⚠️ `enabled` 为假（只勾了「账户余额」）⇒ 整行压淡 ＋ 原生框 `disabled`。
 * @param {string} id - 原生框的 id（`lg-exp-from` / `lg-exp-to`）
 * @param {string} label - 行首文案
 * @param {string} value - 当前值（`YYYY-MM-DD`；空串 = 还没定）
 * @param {boolean} enabled - 这一行能不能改
 * @returns {string} 那一行的 HTML
 * @since 0.8.2
 */
function expDateRowHtml(id, label, value, enabled) {
  const v = String(value || '');
  // ⭐⭐ 0.8.4（「点击 > 才会出现，改为点击日期出现日期选择器」）：整行都去**主动开**
  //    系统那套选择器（`showPicker()`）。⚠️ 光靠原生行为不行：`input[type=date]` 只有点它**最右边
  //    那个日历图标**才弹，点中间的日期文字只是选中某一段 —— 表现就是「只有点 › 才有反应」。
  return `<label class="lg-expdate${enabled ? '' : ' lg-expoff'}" data-act="lg-exp-date">
      <span class="lg-expdname">${esc(label)}</span>
      <b class="lg-expdval">${esc(exportDateText(v))}</b>
      <i class="lg-expdchev">›</i>
      <input class="lg-expdinput" type="date" id="${esc(id)}" value="${esc(v)}" aria-label="${esc(label)}"${
        enabled ? '' : ' disabled'
      }></label>`;
}

/** 功能：导出页「开始时间」当前该用哪个值（用户改过就用他的，否则用服务端给的默认）。 @returns {string} @since 0.8.2 */
function expFromOf() {
  const d = state.lgPeriods && state.lgPeriods.export;
  return exportDateOf(state.lgExportFrom, d && d.from);
}

/** 功能：同上，「结束时间」。 @returns {string} @since 0.8.2 */
function expToOf() {
  const d = state.lgPeriods && state.lgPeriods.export;
  return exportDateOf(state.lgExportTo, d && d.to);
}

/**
 * 功能：点导出页那颗**日期行** ⇒ 主动把系统那套日期选择器打开（⛔ 不发请求）。
 *
 * 说明：⭐⭐ 为什么必须"主动开"（「点击 > 才会出现，改为点击日期出现日期选择器」）：
 *      `input[type=date]` 的原生行为是**只有点它最右边那个日历图标**才弹选择器，点中间的日期
 *      文字只是把某一段（年 / 月 / 日）选中 —— 而那一行右边那个 `›` 正好就压在图标的位子上，
 *      于是"看起来只有点 `›` 才有反应"。`showPicker()` 一调就整个弹出来，点哪都一样。
 *      ⚠️ 拿不到 `showPicker`（很老的浏览器）时退回 `focus()`：至少把焦点落上去，不静默什么都不做。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一行（`.lg-expdate`）
 * @returns {void}
 * @since 0.8.2
 */
export function lgExpDateOpen(_act, n) {
  const row = n && n.closest ? n.closest('.lg-expdate') : null;
  const inp = row ? row.querySelector('input[type="date"]') : null;
  if (!inp || inp.disabled) return;
  // ⚠️ `showPicker()` 在"选择器已经开着"时会抛 InvalidStateError ⇒ 接住、不当成出错
  if (typeof inp.showPicker === 'function') {
    try {
      inp.showPicker();
      return;
    } catch (_e) {
      /* 已经开着 / 这个环境不让程序开 ⇒ 落下去 focus */
    }
  }
  inp.focus();
}

/**
 * 功能：改「开始 / 结束时间」—— 只改 state 再重画（⛔ 不发请求）。
 *
 * 说明：⚠️ 值来自本页那颗原生 `<input type="date">`，但这里仍按**严格形态**再挡一次
 *      （`YYYY-MM-DD`；空串 = 用户把它清空了）—— 脏值发出去只会换来一个 400，而且不报错。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那颗日期框（按 `id` 认是哪一行）
 * @returns {void}
 * @since 0.8.2
 */
export function lgExpDatePick(_act, n) {
  const id = String((n && n.id) || '');
  const v = String((n && n.value) || '');
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
  if (id === 'lg-exp-from') state.lgExportFrom = v;
  else if (id === 'lg-exp-to') state.lgExportTo = v;
  else return;
  renderLedger();
}

/**
 * 功能：点「下载 CSV」—— ⭐ **先弹确认框 → 再浏览器导航**（照设置页那两处的既有形态）。
 *
 * 说明：⭐⭐ 多选时**逐个下**（C-19：⛔ 不引 zip、⛔ 不引 Blob）：勾了三样就是**三次**
 *      「确认 → 导航」，每次一个 `.csv`；用户在任意一次点「取消」⇒ 剩下的**不再问**
 *      （⛔ 不把后面的当成"都同意"）。
 *      ⚠️ 一样都没勾时**说句话**再停下（⛔ 不静默什么都不做）。
 *      ⚠️ 走 `window.location.href`（附件响应不会离开当前页）—— ⛔ 不走「先取文本再拼
 *      `Blob`」那条路（`Blob` / `URL.createObjectURL` 全仓零命中，不新开技术路径）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} _n - 触发的那颗按钮（未用）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgExpDownload(_act, _n) {
  const keys = expWhatKeys();
  if (!keys.length) {
    toast('先勾一样要导出的内容', true);
    return;
  }
  // ⚠️ 只勾了「账户余额」⇒ 时间那一对对它没意义：**不带日期**（接口按「不限」算）
  const dated = expRangeApplies(keys);
  const from = dated ? expFromOf() : '';
  const to = dated ? expToOf() : '';
  if (dated && !(from && to)) {
    toast('先选好开始时间和结束时间', true);
    return;
  }
  if (dated && from > to) {
    toast('开始时间不能晚于结束时间', true);
    return;
  }
  for (const what of keys) {
    const ok = await askConfirm({ title: '导出', text: expConfirmText(what, from, to), ok: '开始下载' });
    if (!ok) return;
    window.location.href = expUrlOf(what, from, to);
    toast(`已开始下载：${expWhatName(what)}`);
  }
}

/**
 * 功能：从设置**首页**点进某一页（`data-page` 上带着 `SET_PAGES` 的 `key`）。
 *
 * 说明：⚠️ 判据走 `setPageOf()`（认不出＝留在首页，⛔ 不切）—— 认不出还切过去的话，
 *      用户会站在一个空白页上而**没有任何提示**。
 *      ⚠️ 只换页、**不重新取数**：那一页要的数据（分类 / 默认账户 / 导入概况）进「设置」这一格
 *      时已经取过（`mountLedger()` / `lgSegPick()` 那两处），⛔ 别在这儿再拉一遍。
 *      ⚠️ 唯一的例外是【导出数据】那一页的**期间清单**（`state.lgPeriods`）—— 它由图表那一侧
 *      按需取，用户完全可能直接进导出页 ⇒ 手上没有就顺手取一次（不 `await`，那一页照画）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗条目（从 `data-page` 取 key）
 * @returns {void}
 * @since 0.8.2
 */
export function lgSetGo(_act, n) {
  const k = setPageOf(n && n.dataset && n.dataset.page);
  if (!k) return;
  state.lgSetPage = k;
  renderLedger();
  // ⭐ 0.8.4：【导出数据】那一页那两颗日期框的**起点**取自服务端（`/api/ledger/periods`
  //    的 `export.from` / `.to`，与图表那边**共用同一个 state 键** `lgPeriods`）——
  //    手上没有就顺手取一次（⛔ 前端不算日期，也不许自己铺「今年 ± N 年」）。
  if (k === 'exp' && !state.lgPeriods) loadPeriods();
}

/**
 * 功能：设置子页的「‹ 返回」⇒ 回设置首页（⛔ 不是退出记账）。
 *
 * 说明：⚠️ 手机端的历史栈只认「底部标签」那一层（`syncHistory()` 只压 `#tab`）⇒ 这一层
 *      照账户详情 / 账单屏同款：屏内自带返回，⛔ 不去碰宿主的 hash 机制。
 *      ⚠️ 回首页**不重画顶栏以外的东西**：首页那四条目是静态的，分类 / 默认账户那一份
 *      还在手上（子页里改过的话，服务端那一份已经在各自成功路径里回读过）。
 * @returns {void}
 * @since 0.8.2
 */
export function lgSetBack() {
  state.lgSetPage = '';
  renderLedger();
}

/**
 * 功能：提交一条默认账户的改动 —— ⭐ **逐键**（只带要改的那**一个**键），存完**从服务端回读**。
 *
 * 说明：⭐⭐ 口径是「这一页全部当场生效」⇒ 原来那颗「保存」（`lgSetSave`）
 *      连同它"一次提交好几键"的写法**整块删掉**了（⛔ 不留两条保存路径：一条当场生效、
 *      一条攒着提交，迟早出现"我明明改过它却没生效"）。
 *      ⚠️⭐ **只带要改的那一个键**（`{income_id}` / `{expense_id}` / `{categories: {<cid>: …}}`）：
 *      不能"把整张表原样提交"—— 全局两层是 upsert（每次提交都会写一次无谓的更新），
 *      而每类别那一层提交 `null` 是**清掉** ⇒ 把没动过的类别也一起提交，等于把它们的默认
 *      悄悄清空（用户只是来改一个类别，回来发现别的都不见了，而且**不报错**）。
 *      多余的键**一个都不带**（`routes.js` 的 `checkDefaults` 对形状是严格的）。
 *      ⚠️ 存完把服务端那份**换到手上**（`state.lgDefaults`）并**重画**：下拉里显示的是真值，
 *      而不是"我刚选的那一项"（两者在服务端拒绝时不一样 —— 那是"界面在骗人"）。
 *      ⚠️ 失败也重画一次：用户刚选的那一项从下拉里退回去，**不许**留在界面上（同一条纪律）。
 *      ⚠️ 调用方在弹层里时，重画**不会**把弹层挤掉（`#sheet` 是独立节点）⇒ 成功之后照旧要
 *      `closeSheet()`（顺序：先等它回来、再关，见 `lgDefNewGo()`）。
 *      ⚠️ `state.lgSetPage` **不动**：重画按它画回同一页（清了就成了"一保存就被踢回首页"）。
 * @param {Object} body - `{income_id}` / `{expense_id}` / `{categories: {<分类 id>: <账户 id>|null}}`
 * @returns {Promise.<boolean>} 成功为 true（失败已经 `toast` 过了）
 */
async function putDefaults(body) {
  try {
    const r = await api('PUT', '/api/ledger/defaults', body);
    state.lgDefaults = (r && r.defaults) || state.lgDefaults;
    renderLedger();
    return true;
  } catch (e) {
    toast(e.message, true);
    renderLedger();
    return false;
  }
}

/**
 * 功能：全局两层（默认收入 / 默认支出）那颗下拉的 change —— 认 `#lg-def-income` / `#lg-def-expense`。
 *
 * 说明：⚠️ 它**不走宿主的 `ACTIONS` 表**（`<select>` 的 `change` 不是点击委托的那条路）——
 *      与账户详情那颗月份下拉（`#lg-c-month`）同一种手法，判据住 `bindLedgerOnce()`。
 *      ⚠️ 值**没变就什么都不做**（不发那条注定白跑的请求、也不弹一句"没有改动"）：
 *      `change` 本来只在真变过时才触发，这里再比一次是防"选了同一项又被触发"那条路。
 * @param {string} key - `'income'` / `'expense'`
 * @param {HTMLSelectElement} sel - 那一颗下拉
 * @returns {Promise.<void>}
 */
async function globalDefChanged(key, sel) {
  const d = state.lgDefaults || { income: null, expense: null };
  const v = Number(sel.value) || 0;
  if (!v) return;
  const old = Number(key === 'income' ? d.income : d.expense) || 0;
  if (v === old) return;
  await putDefaults(key === 'income' ? { income_id: v } : { expense_id: v });
}

/**
 * 功能：每类别那一颗下拉的 change —— 认那一行上的 `data-defacct`（= 分类 id）。
 *
 * 说明：⚠️ 选到「跟随全局默认」（值是空串）就是**清掉这一行**（提交 `null`）——
 *      与那枚 ✕ 是同一件事的两个入口，⛔ 别一个清、一个留在那儿。
 * @param {HTMLSelectElement} sel - 那一颗下拉（`data-defacct` 上带着分类 id）
 * @returns {Promise.<void>}
 */
async function catDefChanged(sel) {
  const cid = Number(sel.dataset.defacct) || 0;
  if (!cid) return;
  const d = state.lgDefaults || { categories: [] };
  const old = (d.categories || []).find((x) => Number(x.category_id) === cid);
  const oldV = old && old.account_id ? Number(old.account_id) : 0;
  const v = Number(sel.value) || 0;
  if (v === oldV) return;
  await putDefaults({ categories: { [String(cid)]: v ? v : null } });
}

/**
 * 功能：某一行的「✕」—— 把那个类别的默认账户**清掉**（回落到全局默认），⛔ 不是删分类。
 *
 * 说明：⚠️ 它是**一个明确动作**（用户点了才发生）⇒ 不需要二次确认（不是破坏性的：
 *      清掉之后还能再设回来，分类本身与记过的账一个字节都不动）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那一颗 ✕（`data-id` = 分类 id）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgDefDel(_act, n) {
  const cid = Number((n && n.dataset && n.dataset.id) || 0);
  if (!cid) return;
  const c = catFind(cid);
  const name = c ? catFullName(state.lgCats, c) : '';
  const ok = await putDefaults({ categories: { [String(cid)]: null } });
  if (ok) toast(name ? `「${name}」改回跟随全局默认了` : '改回跟随全局默认了');
}

/**
 * 功能：「＋ 新增」—— 开「给类别设默认账户」那张弹层（挑一个类别 ＋ 选一个账户）。
 *
 * 说明：⭐⭐ 这一页改成**按需新增**（「类别不要全部显示，默认就是
 *      【默认收入账户】，用户可以通过【新增】按钮来设置各个类别的默认」）⇒
 *      那一列只列**已经设过的**（`setAcctHtml()` 画），这一颗负责把新的设进来。
 *      ⚠️ 候选 = **没设过 + 没归档**的类别：已设的那些当然不再出现（选了它＝原地改，
 *      那一行本来就在列表里能改）；归档的**不给设**（它压根选不到，设了也白设）。
 *      ⚠️ 选项的文字走 `catFullName()`（二级带上级）。
 *      ⚠️⭐ **一个候选都没有时说一句实话**（`每个类别都设好了。`）并且**不给「保存」**——
 *      给一颗点了必然空转的按钮是最差的一种（同「画了按钮才 400」那条纪律）。
 * @returns {void}
 * @since 0.8.2
 */
export function lgDefNew() {
  const d = state.lgDefaults || { categories: [] };
  const cats = state.lgCats || [];
  const setIds = new Set((d.categories || []).map((x) => Number(x.category_id)));
  const opts = cats
    .filter((c) => !c.archived && !setIds.has(Number(c.id)))
    .map((c) => `<option value="${Number(c.id)}">${esc(catFullName(cats, c))}</option>`)
    .join('');
  if (!opts) {
    openSheet(
      '给类别设默认账户',
      '<div class="lg-tip">每个类别都设好了。</div>',
      '<button class="btn" type="button" data-act="sheet-close">知道了</button>',
    );
    return;
  }
  openSheet(
    '给类别设默认账户',
    `<label class="fld"><span>类别</span><select id="lg-f-defcat">${opts}</select></label>
     <label class="fld"><span>默认账户</span><select id="lg-f-defacct">${defOptions(0, true)}</select></label>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-defnewgo" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：存下「给类别设默认账户」那一张弹层 —— 提交 `{categories: {<分类 id>: <账户 id>|null}}`。
 *
 * 说明：⚠️ 存完**先 `closeSheet()` 再重画**（重画在 `putDefaults()` 里做过，但那时弹层还开着）——
 *      弹层是独立节点 `#sheet`，留在屏上会把刚重画好的列表整个盖住（看着像"点了没反应"）。
 *      ⚠️ 校验不过时**不关弹层**（用户就在那一格里，让他接着选）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgDefNewGo() {
  const catEl = $('#lg-f-defcat');
  const cid = Number((catEl && catEl.value) || 0);
  if (!cid) {
    toast('先挑一个类别', true);
    return;
  }
  const acctEl = $('#lg-f-defacct');
  const v = Number((acctEl && acctEl.value) || 0);
  const c = catFind(cid);
  const name = c ? catFullName(state.lgCats, c) : '';
  const ok = await putDefaults({ categories: { [String(cid)]: v ? v : null } });
  if (!ok) return;
  closeSheet();
  toast(name ? `「${name}」的默认账户设好了` : '设好了');
}

// ---------- ⭐ 0.8.1 补：【收支分类】那一栏（两级树 ＋ 建一级 / 建二级 / 改名 / 归档 / 恢复内置） ----------
//
// ⚠️ 这一栏**不新开屏、不新增入口按钮**：它就长在设置子页【收支分类】里（第 2 条要的是
//    "能建二级分类的地方"，不是"再一个列表页"）。电脑端那边是同一个宽弹窗里的同一栏。
//    ⭐ 0.8.1：那一屏本身升成底部导航第三格（见 `segNavHtml()`），这一栏一个字节都没搬。
//    ⭐ 0.8.3：那一格又分了二级菜单（首页 → 子页）⇒ 这一栏成了**子页**之一
//    （`setCatHtml()` 画它），内容照旧、一个字节都没改。
// ⚠️ 树的构造**只走 `entry-calc.js` 的 `catTree()`**（`includeArchived: true`：归档的要显示，
//    否则用户不知道"这个分类去哪了"）—— ⛔ 本文件一个 `filter(c => !c.parent_id)` 都不许有。

/**
 * 功能：画某一侧（支出 / 收入）的**两级树**：一级一行，它下面每个二级各一行（**含已归档的**）。
 *
 * 说明：⚠️ 侧别标题与「每种类别的默认账户」那几行用同一套小标题样式（`.lg-setcap2`）。
 *      ⚠️⭐ `includeArchived: true` ⇒ 归档的**一级与二级都要画**（分类管理这一页必须能看见
 *      "这个分类去哪了"，也才有地方点「恢复」/「删除」）—— ⛔ 别在这里筛掉归档的。
 *      ⚠️ 这一侧一条都没有时**如实说一句**（⛔ 不画一片空白 —— 空白与"没读到"在用户眼里一样）。
 * @param {string} ie - `'支出'` / `'收入'`
 * @returns {string} 这一整块的 HTML
 */
function catTreeHtml(ie) {
  const tops = catTree(state.lgCats, ie, { includeArchived: true });
  const rows = [];
  for (const t of tops) {
    const kids = t.kids || [];
    const open = !!state.lgCatOpen[Number(t.id)];
    rows.push(catRowHtml(t, false, kids.length, open));
    // ⭐⭐ 0.8.22（「设置-收支分类：默认全部折叠」）：子级**只在展开时才画**。
    //    ⚠️ 展开态住 `state.lgCatOpen`（默认空对象 ＝ 全部折叠）。
    if (open) for (const k of kids) rows.push(catRowHtml(k, true, 0, false));
  }
  return `<div class="lg-setcap2">${esc(ie)}</div>${
    rows.length ? rows.join('') : '<div class="lg-txwait">这一侧还没有收支分类。</div>'
  }`;
}

/**
 * 功能：画收支分类的一行 —— 名字（自定义的带一枚小字标记）＋ 这一行允许的那些动作。
 *
 * 说明：⭐⭐ 三件事**按服务端已经判好的标记**决定画不画，⛔ 前端不再自己比名字：
 *      · `builtin === true`（**内置**分类，既定的 22 行：支出 15 ＋ 收入 7）：
 *        **改名与归档都不给** —— 服务端这两条路一律 400（「内置分类不能改名」/「内置分类不能删除」），
 *        画了按钮才 400 是"最差的一种"（用户以为能改 / 能删，点下去才知道不行）。
 *        ⚠️⭐ **判据只看 `builtin` 这个字段，不比名字**：用户也能建一个叫「餐饮」的 —— 那一行是
 *        **自定义**、可以改名可以删（拿名字认人当场就错，而且服务端早就把这条口径钉住了）。
 *        ⚠️ 一级与二级**都照 `builtin` 判**：二级现在全是自定义，但那是**数据的巧合**、
 *        不是判据 —— 按判据走，将来服务端往二级里放内置行时不会静默漏判。
 *        ⚠️ 「＋ 子分类」**内置行照样给**（允许在内置一级下面挂子分类 ——
 *        服务端只拒改名 / 归档那两条路，这条是合法且常用的）。
 *        ⚠️ 这枚「自定义」标记是**唯一**区分内置 / 自定义的手段（内置行反过来什么都不画：
 *        靠"没有标记"识别，⛔ 不给内置行画一个「内置」徽章 —— 那是把默认态也做成噪音）。
 *      · `other === true`（兜底分类「其它」）：**改名 / 归档 / 删除都不给**（服务端这几条路都是 400）。
 *        ⚠️ 它同时也是内置行，两条判据叠在一起，结论一致（这里照旧两条各写各的 —— 判据不合并，
 *        因为将来服务端若把「其它」换成内置以外的身份，改名的禁令**仍然**成立）。
 *      · 已是**归档**态的行：灰化 ＋ 一句「已归档」（两样都照留），**自定义行多两颗按钮**：
 *        「恢复」（`lg-catunarc`，让它重新可选）与「删除」（`lg-catdel`，真从列表里去掉）。
 *        ⭐ 「已归档的也要可以恢复使用和删除」—— 归档不再是这一行的终点。
 *        ⚠️ 内置 / 兜底分类**本来就不能归档**，归档态那两支判据照旧（照旧不给按钮）。
 *      ⚠️⭐ 「删除」是这一栏里**唯一**会让东西永远消失的动作（归档还能恢复）⇒ 它走
 *        `.lg-capbtn.del` 那套**危险色**（⛔ 不能与「改名」「归档」长得一样 ——
 *        最不该误点的那一颗最容易被误点，正是"看起来都差不多"闹的）；确认层见 `lgCatDel()`。
 *      ⚠️⭐ 那枚标记**另起一格**（`.lg-caplead` 里的第二个孩子），⛔ **不塞进 `.lg-capname`**：
 *        `.lg-capname` 的**文本内容就是分类名**，`ttt/tools/ledger-probe.js` 有一批断言拿它跟
 *        `'探针一级丙'` / `'其它'` 做**相等比较** —— 名字里多出三个字，那些断言会**静默错位**。
 *      ⚠️ 二级的缩进给的是**整行**（`.lg-caprow.kid` 的 `margin-left`）—— 这一行还带着几颗按钮，
 *        只用 14px 的空格子太挤、层级也看不出来。
 * @param {Object} c - 一个分类（`catTree()` 给的一级或它的 `kids` 里的二级）
 * @param {boolean} kid - 是不是二级（决定缩进）
 * @returns {string} 这一行的 HTML
 */
function catRowHtml(c, kid, kidCount, open) {
  const builtin = !!c.builtin;
  // ⭐⭐ 0.8.22（「设置-收支分类：默认全部折叠」）：一级行前那颗 `▸ N` / `▾ N` 开关。
  //    ⚠️⭐ 它**另起一格**（`.lg-caplead` 的第一个孩子），⛔ **不进 `.lg-capname`** ——
  //    那个元素的文本内容就是分类名，探针有一批拿它做**相等比较**的断言。
  const n = Number(kidCount) || 0;
  const toggle =
    !kid && n > 0
      ? `<button class="lg-captoggle" type="button" data-act="lg-cattoggle" data-id="${Number(c.id)}"` +
        ` aria-expanded="${!!open}" aria-label="${open ? '折叠' : '展开'}子分类">${open ? '▾' : '▸'}<i>${n}</i></button>`
      : '';
  const lead = `<span class="lg-caplead">${toggle}<span class="lg-capname">${esc(c.name)}</span>${
    builtin ? '' : '<i class="lg-captag">自定义</i>'
  }</span>`;
  const cls = `lg-caprow${kid ? ' kid' : ''}${c.archived ? ' arch' : ''}`;
  const custom = !builtin && !c.other;
  if (c.archived) {
    // 归档态：灰化（`.arch`）＋「已归档」标记**照留**，自定义行多两颗（见上面那段说明）。
    const acts = [];
    if (custom) {
      acts.push(
        `<button class="lg-capbtn" type="button" data-act="lg-catunarc" data-id="${Number(c.id)}">恢复</button>`,
      );
      acts.push(
        `<button class="lg-capbtn del" type="button" data-act="lg-catdel" data-id="${Number(c.id)}">删除</button>`,
      );
    }
    return `<div class="${cls}">${lead}<i class="lg-caparch">已归档</i>${
      acts.length ? `<span class="lg-capacts">${acts.join('')}</span>` : ''
    }</div>`;
  }
  const acts = [];
  // ⚠️ 改名：内置与兜底分类都不给（服务端一律 400）
  if (custom) {
    acts.push(`<button class="lg-capbtn" type="button" data-act="lg-catren" data-id="${Number(c.id)}">改名</button>`);
  }
  // ⭐ 「＋ 子分类」只给一级（收支分类只有两级，服务端对二级当父会 400）；内置行也给
  if (!kid) {
    acts.push(
      `<button class="lg-capbtn" type="button" data-act="lg-catsub" data-id="${Number(c.id)}">＋子分类</button>`,
    );
  }
  // ⚠️ 归档：同上（内置 / 兜底都不给）
  if (custom) {
    acts.push(
      `<button class="lg-capbtn danger" type="button" data-act="lg-catarc" data-id="${Number(c.id)}">归档</button>`,
    );
    // ⭐ 0.8.3：「删除」—— 真删（不可恢复）⇒ 危险色，而且确认层写全三件事（见 `lgCatDel()`）
    acts.push(
      `<button class="lg-capbtn del" type="button" data-act="lg-catdel" data-id="${Number(c.id)}">删除</button>`,
    );
  }
  return `<div class="${cls}">${lead}<span class="lg-capacts">${acts.join('')}</span></div>`;
}

/**
 * 功能：画【收支分类】栏最底下那颗「恢复内置分类」—— **危险行**，确认层见 `lgCatRestore()`。
 *
 * 说明：⭐⭐ 它做的是"把这个账号的分类对齐到内置清单"，代价**不可逆**（旧版预置分类会被硬删，
 *      用它们记过的账显示成「未分类」）⇒ 版式照手机端设置页「恢复整体备份」/「迁移记账数据」
 *      那两处（`mobile/views/more.js` 的 `.mrow` ＋ `.mico.danger` ＋ `.mval.danger`）的**危险待遇**，
 *      只是长在记账这一栏里、类名走 `.lg-caprestore-*`（⛔ 不复用 `.mrow`：一个类名别给两个组件用，
 *      那边调间距会把这一行也带走）。
 *      ⚠️ 它只放在【收支分类】这一栏的底部，⛔ 不许塞进【收支账户】—— 这件事动的是**分类**，
 *      放进账户那一栏会让人以为它动的是账户默认值。
 *      ⚠️ 行上那句摘要把**三件事**点到（补齐 / 你自己加的不动 / 删掉旧版预置 ＋ 那些账会变「未分类」），
 *      ⛔ 不是只写「确定吗」——完整的代价写在确认层正文里（`lgCatRestore()`）。
 * @returns {string} 这一行的 HTML
 */
function catRestoreHtml() {
  return `<button class="lg-caprestore" type="button" data-act="lg-catrestore">
    <span class="lg-caprestore-ico" aria-hidden="true">⚠️</span>
    <span class="lg-caprestore-main"><b>恢复内置分类</b><small>补齐缺失内置、清理旧版配置；自定义数据不受影响，操作不可恢复！！！</small></span>
    <span class="lg-caprestore-val">危险</span>
  </button>`;
}

/**
 * 功能：开「恢复内置分类」的确认层 —— ⚠️ 危险动作，必须**手打「恢复」二字**才放行。
 *
 * 说明：⭐⭐ 确认这一下照抄手机端设置页那两处（`mobile/views/more.js` 的 `orgRestoreFlow()` /
 *      `migrateLedgerFlow()`）：`openSheet()` 一篇写清代价的正文 ＋ 一颗 `btn danger` 的主按钮，
 *      在提交函数里校验那两个字（不够格就 `toast` 拦下）。⛔ 不自己发明第二套。
 *      ⚠️⭐⭐ 正文必须把**代价**说全（只写一句"确定吗"的确认层谁都会顺手点过去）：
 *      ① 内置分类会补齐；② **自定义数据不受影响**；③ 旧版配置（旧的内置分类）会被清理
 *      ⇒ ④ 用它们记过的账显示成「未分类」。四件事**一件都不许漏**。
 *      ⚠️ 还要说清子分类的去向：它们**不会**跟着消失（改挂到同侧「其它」下面）——
 *      少了这句，用户会以为"删旧分类"把子分类一起带走了。
 * @returns {void}
 */
export function lgCatRestore() {
  openSheet(
    '⚠️ 恢复内置分类',
    '<div class="lg-tip">补齐缺失内置、清理旧版配置；自定义数据不受影响，<b>操作不可恢复</b>！</div>' +
      '<div class="lg-tip">用它们记过的账会显示成「未分类」。旧分类下面的子分类不会跟着消失，' +
      '会改挂到同一侧的「其它」下面。</div>' +
      '<div class="lg-tip"><b>操作不可恢复</b>：旧分类从列表里删除（记过的账目不会丢失）。</div>' +
      '<label class="fld lg-cfmlab"><span>确认请输入「恢复」二字：</span>' +
      '<input id="lg-rst-word" type="text" autocomplete="off" /></label>',
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="lg-catrestorego" style="flex:1.4">确认恢复（危险）</button>`,
  );
}

/**
 * 功能：展开 / 折叠一个一级分类的子级 —— ⭐ 0.8.22（「默认全部折叠」）。
 *
 * 说明：⭐⭐ 只翻 `state.lgCatOpen` 里的一个键，然后重画这一屏。
 *      ⚠️⭐ 手机端这一屏是**整页滚**的 ⇒ 重画前先记下滚动位置、画完再放回去：
 *      不然用户点开一个分类看子级，屏幕会**跳回顶部**（列表一长就完全找不到刚才那一条）。
 *      ⚠️ 滚动容器是 `#view-ledger`（它就住 `.assets-pane-body` 那一层）。
 *      ⚠️ 与电脑端那条 `cattoggle` **同一条口径**（那边只重画那一栏，因为它在弹窗里）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那颗 `▸ N` / `▾ N`（`data-id` = 一级分类 id）
 * @returns {void}
 * @since 0.8.22
 */
export function lgCatToggle(_act, n) {
  const cid = Number((n && n.dataset && n.dataset.id) || 0);
  if (!cid) return;
  if (state.lgCatOpen[cid]) delete state.lgCatOpen[cid];
  else state.lgCatOpen[cid] = true;
  const host = document.querySelector('#view-ledger');
  const top = host ? host.scrollTop : 0;
  renderLedger();
  if (host) host.scrollTop = top;
}

/**
 * 功能：校验那两个字，然后真调一次「恢复内置分类」，把结果用**真实计数**说给用户听。
 *
 * 说明：⭐⭐ 返回里**已经带着最新的整份 `categories`** ⇒ 直接换掉手上的清单（`state.lgCats`）
 *      ＋ 原地重画这一屏，⛔ **不再 GET 一次**（多取一次不只是白跑一趟：两份清单之间若有过期，
 *      表现就是"刚恢复完、看到的还是旧的那一份"，而且**不报错**）。
 *      ⚠️ 先 `closeSheet()` 再 `renderLedger()`：弹层是独立的节点（`#sheet`），
 *      留在屏上会把刚重画好的列表整个盖住（看着像"点了没反应"）。
 *      ⚠️ 校验不过时**不关弹层**（用户就在那一格里，让他接着打完）。
 * ⛔ 提示里的「有 N 笔流水变成未分类」**不在这里算**：服务端没给这个数，要算就得再查一次流水
 *      ⇒ 那是第二个真相源；只说"用它们记过的账会显示成「未分类」"这半句。
 * @returns {Promise.<void>}
 */
export async function lgCatRestoreGo() {
  const w = $('#lg-rst-word');
  if (String((w && w.value) || '').trim() !== '恢复') {
    toast('请输入「恢复」两个字才能继续', true);
    return;
  }
  try {
    const r = (await api('POST', '/api/ledger/restore-builtin')) || {};
    if (Array.isArray(r.categories)) state.lgCats = r.categories;
    closeSheet();
    renderLedger();
    toast(restoreBuiltinText(r));
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把「恢复内置分类」那四个计数翻成一句人话（⚠️ 0 的项**不显示**）。
 *
 * 说明：⚠️ 计数全为 0（清单本来就对齐）时要有一句"什么都没动"，⛔ 不能给一个空串 ——
 *      `toast('')` 是一条**空白提示条**，看起来像坏了。
 *      ⚠️ `moved` 也照实说：不然用户会以为那些子分类跟着旧分类一起没了（它们是改挂到「其它」）。
 *      ⚠️ 与电脑端 `desktop.js` 的同名私有函数**逐字一致**（两端同一件事不许两种说法，
 *      ④）—— 那边是本文件的镜像实现，⛔ 没法共享（跨端各写一份是 的口径）。
 * @param {Object} r - `POST /api/ledger/restore-builtin` 的响应（`{removed, added, marked, moved}`）
 * @returns {string} 一句结果说明
 */
function restoreBuiltinText(r) {
  const parts = [];
  if (r.removed) parts.push(`已删 ${r.removed} 个旧分类`);
  if (r.added) parts.push(`补上 ${r.added} 个内置`);
  if (r.marked) parts.push(`把 ${r.marked} 个标成内置`);
  if (r.moved) parts.push(`${r.moved} 个子分类改挂到「其它」`);
  if (!parts.length) return '内置分类本来就整齐，这次什么都没动。';
  const head = `${parts.join('、')}。`;
  return r.removed ? `${head}用它们记过的账会显示成「未分类」。` : head;
}

/**
 * 功能：画「新建 / 改名」那张小表单的正文（两级分类共用一张，`catAsk` 记着这次是哪种）。
 * @returns {string} 正文 HTML
 */
function catNameFormHtml() {
  const p = catAsk || { mode: 'new', id: 0, parentId: 0, ie: '支出' };
  const parent = catFind(p.parentId);
  const label =
    p.mode === 'ren' ? '分类名' : p.mode === 'sub' ? `挂在「${esc(parent ? parent.name : '')}」下面` : '分类名';
  // ⚠️ 侧别那颗下拉只在**新建一级**时出现（二级继承父、改名改不了侧 —— 服务端对这两个键 400）
  const side =
    p.mode === 'new'
      ? `<label class="fld"><span>属于哪一侧</span>
          <select id="lg-f-catie">
            <option value="支出"${p.ie === '收入' ? '' : ' selected'}>支出</option>
            <option value="收入"${p.ie === '收入' ? ' selected' : ''}>收入</option>
          </select></label>`
      : '';
  return `<label class="fld"><span>${label}</span>
      <input id="lg-f-capname" type="text" maxlength="${CAT_NAME_MAX}" value="${
        p.mode === 'ren' ? esc((catFind(p.id) || {}).name || '') : ''
      }" /></label>${side}`;
}

/** 功能：从手上那份分类清单里按 id 找一个（找不到回 `null`）。 @param {number} id - 分类 id @returns {?Object} @since 0.8.0 */
function catFind(id) {
  const cid = Number(id) || 0;
  if (!cid) return null;
  return (state.lgCats || []).find((c) => Number(c.id) === cid) || null;
}

/** 功能：「＋ 新建一级分类」——问名字与侧别。 @returns {void} @since 0.8.0 */
export function lgCatNew() {
  catAsk = { mode: 'new', id: 0, parentId: 0, ie: '支出' };
  openSheet(
    '新建一级分类',
    catNameFormHtml(),
    `<button class="btn primary" type="button" data-act="lg-catsave" style="flex:1.4">保存</button>`,
  );
}

/** 功能：某个一级分类上的「＋子分类」——只问名字（上一级是这一行）。 @param {string} _act - 动作名（未用） @param {HTMLElement} n - 那颗按钮（`data-id` = 一级分类 id） @returns {void} @since 0.8.0 */
export function lgCatSub(_act, n) {
  const p = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!p) return;
  catAsk = { mode: 'sub', id: 0, parentId: Number(p.id), ie: String(p.ie || '') };
  openSheet(
    '新建二级分类',
    catNameFormHtml(),
    `<button class="btn primary" type="button" data-act="lg-catsave" style="flex:1.4">保存</button>`,
  );
}

/** 功能：某一行的「改名」——名字回填好，改完就走逐键那条 PUT。 @param {string} _act - 动作名（未用） @param {HTMLElement} n - 那颗按钮（`data-id` = 分类 id） @returns {void} @since 0.8.0 */
export function lgCatRen(_act, n) {
  const c = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!c) return;
  catAsk = { mode: 'ren', id: Number(c.id), parentId: 0, ie: String(c.ie || '') };
  openSheet(
    '给这个分类改名',
    catNameFormHtml(),
    `<button class="btn primary" type="button" data-act="lg-catsave" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：存下「新建一级 / 新建二级 / 改名」—— 三条路各发各的形状（服务端对形状是**严格**的）。
 *
 * 说明：⭐⭐ 三个形状各是什么，一个字都不能多：
 *      · 新建一级：`{name, ie}`（一级必须说明侧别，否则 400）；
 *      · 新建二级：`{name, parent_id}`（`ie` 由父继承，服务端不接受）；
 *      · 改名：**只** `{name}` —— 带上 `ie` 或 `parent_id` 一律 400（`checkCategory(b, true)`
 *        第一句就是拦这两个键，见 `routes.js`）。
 *      ⭐⭐ 0.8.3：「类别名称要唯一不能重复，二级分类的全称应该是一级分类-二级
 *      分类」⇒ 保存前**先在前端拦一道重名**（`catFullName()` ＋ `catNameTaken()`，判据只住
 *      `calc.js`，⛔ 不在这里自己拼名字 / 自己比名字）：
 *      · 新建一级：候选全称＝输入的名字；
 *      · 新建二级：候选全称＝`父名-输入的名字`（父名由 `parent_id` **现取**，⛔ 不用缓存的那份）；
 *      · 改名：二级＝`父名-新名`、一级＝`新名`（**排除自己**，否则改回原名会说"重复"）。
 *      ⚠️ 判重清单是 `state.lgCats`（`GET /categories` 给的就是**含已归档**的全量）——
 *      归档的只是"选不到"，名字还占着（不然「恢复使用」会当场撞名）。
 *      ⚠️⭐ 撞了就**当场拦下、那条注定 400 的请求一个字节都不发**（只提示、不关弹层：
 *      用户就在那一格里，让他接着改）。⚠️ 真正的闸门在**服务端**（同口径），
 *      前端这一道只是"别让人白等一个 400"。
 *      ⚠️ 存完**只重取分类并重画这一屏**（⛔ 不 `loadLedger()`：分类不影响任何钱，那一趟是白拉）。
 * @returns {Promise.<void>}
 */
export async function lgCatSave() {
  const el = $('#lg-f-capname');
  const name = String((el && el.value) || '').trim();
  if (!name) {
    toast('给这个分类起个名字吧', true);
    if (el) el.focus();
    return;
  }
  const p = catAsk || { mode: 'new', id: 0, parentId: 0, ie: '支出' };
  // ⚠️ 候选全称：合成一个小"分类"交给 `catFullName()`（它按 `parent_id` **现从清单里取父名**）
  //    —— 二级的父名走这条路永远是**最新**的那一份，⛔ 不用打开弹层时缓存下来的名字。
  const self = p.mode === 'ren' ? catFind(p.id) : null;
  const full = catFullName(state.lgCats, {
    name,
    parent_id: p.mode === 'sub' ? Number(p.parentId) : self ? Number(self.parent_id) : 0,
  });
  if (catNameTaken(state.lgCats, full, p.mode === 'ren' ? Number(p.id) : 0)) {
    toast(`已经有叫「${full}」的分类了`, true);
    if (el) el.focus();
    return;
  }
  try {
    if (p.mode === 'ren') {
      await api('PUT', `/api/ledger/categories/${Number(p.id)}`, { name });
    } else if (p.mode === 'sub') {
      await api('POST', '/api/ledger/categories', { name, parent_id: Number(p.parentId) });
    } else {
      const ieEl = $('#lg-f-catie');
      const ie = ieEl && String(ieEl.value) === '收入' ? '收入' : '支出';
      await api('POST', '/api/ledger/categories', { name, ie });
    }
    closeSheet();
    catAsk = null;
    await ensureCats(true);
    renderLedger();
    toast(p.mode === 'ren' ? '改好了' : '分类建好了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：某一行的「归档」—— 没有子分类就一句确认；**有子分类要让用户二选一**（⛔ 不许静默处理）。
 *
 * 说明：⭐⭐  第 7 条 / C-29：「归档一个父分类时，它的子分类怎么办」**必须问**：
 *      · `archive`（缺省）＝ 子分类**一起归档**；
 *      · `move-children` ＝ 子分类**改挂到同一侧的「其它」**下面（名字不变）。
 *      判据「有没有子分类」走 `hasKids()`（＝ `childCats().length > 0`，只算未归档的）——
 *      与选择器那边**同一个判据**：两边各写一套就会出现"问都问了、子分类其实没有"这种怪事。
 *      ⚠️ 两颗按钮都要**真的把 mode 传对**（传错不会报错，只会把子分类静默归档 —— 用户以为挪走了）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那颗「归档」（`data-id` = 分类 id）
 * @returns {void}
 */
export function lgCatArc(_act, n) {
  const c = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!c) return;
  if (!hasKids(state.lgCats, c.id)) {
    askConfirm({
      title: `归档「${c.name}」？`,
      text: '归档后它不再出现在记账的分类里，但已经记过的账照旧显示这个名字。',
      ok: '归档',
    }).then((ok) => {
      if (ok) catArchiveGo(Number(c.id), 'archive');
    });
    return;
  }
  openSheet(
    `归档「${c.name}」？`,
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">它下面还有子分类，归档前得先决定它们怎么办。</p>
     <div class="lg-dacts">
       <button class="lg-dact" type="button" data-act="lg-catarcgo" data-id="${Number(c.id)}" data-mode="archive">子分类一起归档</button>
       <button class="lg-dact" type="button" data-act="lg-catarcgo" data-id="${Number(c.id)}" data-mode="move-children">子分类移到「其它」</button>
     </div>`,
    `<button class="btn" type="button" data-act="cf-no">取消</button>`,
  );
}

/** 功能：二选一之后真的归档（`mode` 从按钮的 `data-mode` 来）。 @param {string} _act - 动作名（未用） @param {HTMLElement} n - 二选一里那颗（带 `data-id` / `data-mode`） @returns {void} @since 0.8.0 */
export function lgCatArcGo(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const mode = String((n && n.dataset && n.dataset.mode) || '');
  if (!id || (mode !== 'archive' && mode !== 'move-children')) return;
  closeSheet();
  catArchiveGo(id, mode);
}

/**
 * 功能：真的归档（`DELETE /api/ledger/categories/:id?mode=…`）—— 存完重取分类并**重画这一屏**。
 *
 * 说明：⚠️ `mode` **走查询参数**（不是请求体）；缺省是 `archive`，但这里两颗按钮都显式带上
 *      —— 少带一次「移到其它」就变成「一起归档」，而且**不报错**。
 *      ⚠️ 归档完不关这一屏（那一段是底部第三格，`state.lgSeg` 不动）：用户还要接着管别的分类
 *      （重画那一屏即可）。
 * @param {number} id - 分类 id
 * @param {string} mode - `'archive'` / `'move-children'`
 * @returns {Promise.<void>}
 */
async function catArchiveGo(id, mode) {
  try {
    await api('DELETE', `/api/ledger/categories/${Number(id)}?mode=${encodeURIComponent(mode)}`);
    // ⚠️ 归档「父分类 ＋ 子分类」之后，那份"每种类别的默认账户"里可能还留着一行指向**已归档**的
    //    分类 ⇒ 它也要重取（那份默认账户**不进 `overview`**，必须单独取一次）。
    await Promise.all([ensureCats(true), ensureDefaults(true)]);
    renderLedger();
    toast('已归档');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- ⭐ 0.8.3：分类的**真删除**与**取消归档** ----------
//
// 「②自定义的要支持删除（已归档的也要可以恢复使用和删除），删除过后下的记账移动到其它」
// ⇒ 在这一栏上补两条路：
//   · 「删除」＝**真删**（`DELETE /api/ledger/categories/:id?mode=delete`）——
//     与「归档」（行留着、可恢复）是**两件事**，所以它必须先过一道把它代价说全的确认层；
//   · 「恢复」＝取消归档（`POST /api/ledger/categories/:id/restore`）—— 非破坏性，不要二次确认。
// ⚠️ 服务端那两条路**早就写好了**（`routes.js` / `store.js`），前端从前一次都没调过 ——
//    于是「删除」在这一栏里一直只有"归档"这一种表现（⚙️  第 5 条那条老口径）。

/**
 * 功能：某一行的「删除」—— 先出一道确认层（⚠️ 不可逆），再真的删。
 *
 * 说明：⭐⭐ 确认层正文必须把**三件事**说全（的；一件都不许漏）：
 *      ① 「`<全称>`」会从分类里永远消失（不可恢复）；
 *      ② 用这个分类记过的账会移到「其它」；
 *      ③ **它下面有子分类时**再加一句：那些子分类会改挂到「其它」。
 *      ⚠️ 第 ③ 句的判据走 `hasKids()`（＝ `childCats().length > 0`）—— 与电脑端
 *      （`desktop.js` 的 `openCatDel()`）、与「归档」那个二选一**同一个判据**（
 *      判据只准一处）。⚠️ 已知的窄缝：它**只算未归档的子分类**，而服务端那条
 *      `reassignLedgerCategoryChildren` 是 `WHERE parent_id = ?`（**归档的子分类也会一起改挂**）
 *      ⇒ "一个一级下面只有已归档的二级"那种情况这里不说第 ③ 句（两端同一条口径，⛔ 不是漏写）。
 *      ⚠️ 名字走 `catFullName()`（二级带上级）—— 与列表里显示的那一行**逐字相同**
 *      （确认层说 A、屏幕上写 B，是用户最没法判断的一种）；措辞与电脑端**逐字一致**
 *      （同一件事两端两种说法是最容易漂的地方）。
 *      ⚠️ 主按钮是**危险色**（`btn danger`）＋ 文案写「永久删除」——⛔ 不用「确定」这种看不出
 *      代价的词（同 `lgCatRestore()` 那条口径）。内置 / 兜底行本来就不画这颗按钮，
 *      万一还是走到了这里也**不发请求**（照电脑端那一条）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那一颗「删除」（`data-id` = 分类 id）
 * @returns {void}
 * @since 0.8.2
 */
export function lgCatDel(_act, n) {
  const c = catFind((n && n.dataset && n.dataset.id) || 0);
  if (!c || c.builtin || c.other) return;
  const full = catFullName(state.lgCats, c);
  const kidTip = hasKids(state.lgCats, c.id)
    ? '<div class="lg-tip">它下面的子分类会改挂到「其它」。</div>'
    : '';
  openSheet(
    '⚠️ 删除分类',
    `<div class="lg-tip">「${esc(full)}」会从分类里永远消失（不可恢复）。</div>` +
      '<div class="lg-tip">用这个分类记过的账会移到「其它」。</div>' +
      kidTip,
    `<button class="btn" type="button" data-act="cf-no">取消</button>
     <button class="btn danger" type="button" data-act="lg-catdelgo" data-id="${Number(c.id)}" style="flex:1.4">永久删除</button>`,
  );
}

/**
 * 功能：真的删掉那个分类（`DELETE /api/ledger/categories/:id?mode=delete`），把结果说成人话。
 *
 * 说明：⭐⭐ 服务端一个动作里把三件事都办了（顺序见 `store.ledgerDeleteCategory`）：它名下的账改挂
 *      同侧「其它」、它的子分类改挂同侧「其它」、清掉它自己的"每类别默认账户"那一行、删行本身。
 *      返回的是**真改到的两个行数**（`movedEntries` / `movedChildren`）⇒ 提示里说真实数字，
 *      ⛔ 不写死（`已删除；3 笔账和 1 个子分类移到「其它」`）。
 *      ⚠️ 那一行还可能有一条**每类别的默认账户**设置被服务端一起清掉 ⇒ 分类与默认账户**都要重取**
 *      （那份默认账户不进 `overview`）—— 不重取的话「每种类别的默认账户」那一列会留着一个
 *      已经不存在的类别（点它的 ✕ 会 404）。
 *      ⚠️ 先 `closeSheet()` 再重画（弹层是独立节点，留着会把列表盖住 —— 看着像"点了没反应"）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 确认层里那颗「永久删除」（`data-id` = 分类 id）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgCatDelGo(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  if (!id) return;
  try {
    const r = (await api('DELETE', `/api/ledger/categories/${id}?mode=delete`)) || {};
    closeSheet();
    await Promise.all([ensureCats(true), ensureDefaults(true)]);
    renderLedger();
    toast(catDelText(r));
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把「永久删除一个分类」那条接口的结果翻成一句人话（⛔ 数字全部来自返回体）。
 *
 * 说明：⭐ 形状照 `restoreBuiltinText()`：**0 的项不出现**，一件都没动时给一句干净的"已删除"，
 *      ⛔ 不给空串（`toast('')` 是一条**空白提示条**，看起来像坏了）。
 *      ⚠️ 措辞与电脑端 `desktop.js` 的 `catDelText()` **逐字一致**（同一件事两端
 *      两种说法是最容易漂的地方）；⚠️ 计数两项就是服务端返回体里的 `movedEntries` /
 *      `movedChildren`（`store.ledgerDeleteCategory` 的原话，⛔ 不猜别的字段名）。
 * @param {Object} r - `DELETE …?mode=delete` 的响应（`{ok, movedEntries, movedChildren}`）
 * @returns {string} 一句结果说明
 * @since 0.8.2
 */
function catDelText(r) {
  const parts = [];
  if (Number((r || {}).movedEntries)) parts.push(`${r.movedEntries} 笔账`);
  if (Number((r || {}).movedChildren)) parts.push(`${r.movedChildren} 个子分类`);
  if (!parts.length) return '已删除。';
  return `已删除；${parts.join('和')}移到「其它」。`;
}

/**
 * 功能：已归档那一行的「恢复」—— 取消归档（`POST /api/ledger/categories/:id/restore`）。
 *
 * 说明：⚠️ **不做二次确认**：它不是破坏性的（这一步没有任何东西消失，只是那一行重新可选；
 *      要收回去再归档一次就行）——「恢复内置分类」那种要手打二字的待遇是给**不可逆**动作的，
 *      ⛔ 别把两者拉平（拉平之后用户对"真危险"那一个也会麻痹）。
 *      ⚠️ 复用的是**同一个名字**：归档时名字一直占着（判重不排除已归档的）⇒ 恢复**不会撞名**，
 *      服务端也没有判重这一步（见 `store.ledgerRestoreCategory`）。
 *      ⚠️ 服务端回的**只是那一行**（不是整份清单）⇒ 这里老老实实重取一次
 *      （⛔ 不拿它去替换 `state.lgCats`：换掉就只剩一行了）。
 *      ⚠️ 默认账户**不用**重取：恢复不动那份设置（归档也没动过它）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那一颗「恢复」（`data-id` = 分类 id）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgCatUnArc(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  if (!id) return;
  const c = catFind(id);
  const name = c ? catFullName(state.lgCats, c) : '';
  try {
    await api('POST', `/api/ledger/categories/${id}/restore`);
    await ensureCats(true);
    renderLedger();
    toast(name ? `「${name}」能用了` : '能用了');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 图表（0.8.0）：走势 · 构成 · 排行 ----------

/**
 * 三种口径的文案与顺序（资产 / 负债 / 净资产）。
 *
 * 说明：⚠️ 与电脑端**逐字同值** —— 同一份口径在两处各写一遍必然漂移，而漂移的是用户看到的字。
 *      ⚠️ 净资产那一档**没有**排行榜（净资产是"资产 − 负债"一个数，没有"构成"可言，
 *      方案 §4.5：⛔ 别为了三态长得一样给它编一个环形 / 排行榜）。
 *      ⭐ 0.8.21：曾经还有一个 `trend`（「资产走势图」那三句标题）——
 *      **两端那张卡的标题都由三颗切换钮取代**（先手机端、再电脑端）⇒ 这一档**整块删掉**。
 *
 * @type {Array.<{key: string, name: string, now: string, rank: string, center: string}>}
 */
const RANGES = [
  { key: 'asset', name: '资产', now: '当前资产状况', rank: '资产排行榜', center: '总资产' },
  { key: 'debt', name: '负债', now: '当前负债状况', rank: '负债排行榜', center: '总负债' },
  { key: 'net', name: '净资产', now: '当前净资产状况', rank: '', center: '' },
];

/**
 * 走势图的画布（**手机端版式**；⚠️ 电脑端自己一份 —— 那边一栏更宽）。
 * ⚠️ `svg` 用 `width:100%; height:auto` + 默认的等比缩放 ⇒ 圆心 / 折点不会被拉成椭圆
 *    （⛔ 别用 `preserveAspectRatio="none"`，那会把圆点拉扁）。
 */
const TREND_BOX = { w: 330, h: 150, padL: 10, padR: 10, padT: 14, padB: 26 };

/**
 * ⭐ 0.8.10（「资产走势图 / 负债走势图 / 净资产走势图 没有纵坐标」）：
 * **带纵轴**的那一份画布 —— 只多让出左边那一栏（`padL` 10 → 52），其余逐字同 `TREND_BOX`。
 *
 * 说明：⚠️⭐ **刻意不复用 `TREND_BOX`**：那一份还被「记账图表」与「月详情页按天折线」用着，
 *      它们没有纵轴 ⇒ 跟着一起空出 42 个单位就是白白缩掉绘图区（窄屏上很贵）。
 * @type {{w: number, h: number, padL: number, padR: number, padT: number, padB: number}}
 */
const AXIS_BOX = { w: 330, h: 150, padL: 52, padR: 10, padT: 14, padB: 26 };

/**
 * 纵轴刻度文字的字号（**画布单位**，⛔ 不是屏幕像素）。
 * ⚠️ `svg` 是按容器宽度等比缩放的 ⇒ 它实际看着多大取决于卡片多宽；12.5 ≈ 缩到 10.5px，
 * 与横轴那排 `.lg-axis > i` 的 10.5px 对齐。
 * @type {number}
 */
const AXIS_FONT = 12.5;
/** 环形图的半径与描边宽度（画法住 `calc.js` 的 `donutArcs()`） */
const DONUT_R = 52;
const DONUT_SW = 20;

/**
 * 功能：当前选中的图表口径。
 *
 * 说明：⚠️ 认不出（初值 / 别的设备上删过什么）一律回落 `'asset'` —— ⛔ 别停在一个不存在
 *      的档上，那样这一屏会一片空白且没有任何提示。
 *
 * @returns {string} `'asset'` | `'debt'` | `'net'`
 */
function rangeOf() {
  const k = String(state.lgRange || '');
  return RANGES.some((r) => r.key === k) ? k : 'asset';
}

/**
 * 功能：当前选中的视图（`'asset'` 资产台账 / `'chart'` 图表）。
 * @returns {string} `'asset'` | `'chart'`
 */
function tabOf() {
  return state.lgTab === 'chart' ? 'chart' : 'asset';
}

/**
 * 功能：「资产 / 图表」两个视图的**滑动指示点**（⭐ 0.8.21：切换方式改成**左右滑动**）。
 *
 * 说明：⭐⭐ 0.8.21（「资产和图表 左右滑动切换」＋「三连药丸切换太丑也太占
 *      屏幕位置」）：原来这里是一行占满宽的「资产｜图表」分段控件（`.lg-seg`）——
 *      它与屏头那排药丸、以及下面「资产｜负债｜净资产」叠成**三排**，又重又占地方。
 *      现在：整行撤掉，换成**两颗小圆点**（20px 高的那一行）——
 *      ① 它是滑块的标准指示（用户一眼知道"这一屏有两页、现在在第几页"）；
 *      ② 它**可点**（`data-act="lg-tab"` 原样留着 ⇒ `lgTabPick()` 一个字没改）——
 *      那同时是**无障碍的那条路**（手势不是人人可用）。
 *      ⚠️ 真正的手势住在 `bindLedgerOnce()` 的 `touchstart/touchend` 那一对里
 *      （判据：只在「资产」这一格、位移够横、排序模式里不切）。
 *      ⛔ 别把 `.lg-seg` 那排加回来 —— 加回来就又是三排了。
 *
 * ⭐ 0.8.22（「手机端的账单：去掉列表和图表两个按键，改为左右滑动切换
 *      （参考资产中的左右滑动）」）：**同一颗点控件也被「账单」那一格复用** ⇒ 参数化：
 *      默认仍是资产那两颗（`资产 / 图表`、动作 `lg-tab`），账单屏传 `SUB_TABS` ＋ `'lg-btab2'`。
 *      ⚠️ 两处**共用同一份版式**（`.lg-dots`）—— ⛔ 别给账单另写一颗（那两套迟早长得不一样）。
 *
 * @param {Array.<{key: string, name: string}>} [items] - 要哪几颗点（默认「资产 / 图表」）
 * @param {string} [cur] - 当前亮的那一档（默认取资产的 `tabOf()`）
 * @param {string} [act] - 点它的动作名（默认 `lg-tab`；账单是 `lg-btab2`）
 * @returns {string} 这一行的 HTML
 * @since 0.8.2
 */
function tabDotsHtml(items, cur, act) {
  const list =
    items && items.length
      ? items
      : [
          { key: 'asset', name: '资产' },
          { key: 'chart', name: '图表' },
        ];
  const now = cur || tabOf();
  const action = act || 'lg-tab';
  const dot = (k, label) =>
    `<button class="lg-dots-i${now === k ? ' on' : ''}" type="button" data-act="${esc(action)}" data-tab="${esc(k)}"` +
    ` aria-label="${esc(label)}" aria-selected="${now === k}"></button>`;
  return `<div class="lg-dots" role="tablist">${list.map((t) => dot(t.key, t.name)).join('')}</div>`;
}

/**
 * 功能：图表的三态切换（资产 / 负债 / 净资产）。
 *
 * 说明：⚠️ 与上面那颗**同族但更轻**（`.lg-seg-sub`）：上面那颗回答"看哪一屏"，
 *      这颗回答"按哪个口径看" —— 层级不同，视觉上就不该一样重。
 *
 * @returns {string} 这一行的 HTML
 */
function rangeBarHtml() {
  const cur = rangeOf();
  const btn = (r) =>
    `<button class="lg-seg-btn${cur === r.key ? ' on' : ''}" type="button" data-act="lg-range" data-range="${
      r.key
    }" role="tab" aria-selected="${cur === r.key}">${r.name}</button>`;
  return `<div class="lg-seg lg-seg-sub" role="tablist">${RANGES.map(btn).join('')}</div>`;
}

/**
 * 功能：年度下拉 —— 选项**来自服务端**（`overview.years`：当前年 ∪ 有过快照的年）。
 *
 * 说明：⚠️⭐ 选项**必须来自真实数据**：写死「今年 ± N 年」会让用户选到一整年空白的走势图，
 *      而他没法知道那不是 bug。
 *      ⚠️ 用**原生 `<select>`**（⛔ 不自画下拉）。
 *
 * @param {Object} d - `state.lg`
 * @returns {string} 这一格的 HTML
 */
function yearSelectHtml(d) {
  const years = (Array.isArray(d && d.years) ? d.years : []).map((y) => Number(y)).filter((y) => y > 0);
  const want = Number(state.lgYear) || 0;
  const cur = years.indexOf(want) >= 0 ? want : years[0] || 0;
  const opts = years.map((y) => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}年</option>`).join('');
  return `<select id="lg-f-year" aria-label="选择年份">${opts}</select>`;
}

/**
 * 功能：走势图那一块（手写 `<svg>` ＋ `polyline`，方案 §4.5；⛔ 零图表库）。
 *
 * 说明：⚠️ `geo.empty`（这一年一个点都没有）时画**一句人话**，⛔ 不画一张空网格
 *      （"空着的坐标系"会被当成加载中）。⚠️ 只有一个点时也补一句 —— 一个孤点谁也看不出
 *      "这是趋势"。
 *      ⭐⭐ 0.8.10在这张卡上补了两件事（与电脑端 `desktop.js` 逐字同款）：
 *      · **纵坐标** —— 三条虚线 ＋ 左栏三个刻度字（值取真实数据的顶 / 中 / 底），画布 `AXIS_BOX`；
 *      · **点一个点看这一格多少钱** —— 每个点配一颗看不见的大命中圈（`.lg-thit`，r=12），
 *        点中在横轴下面写「几月 · 多少钱」。⚠️ 钱**画的时候就写进 `data-v`**（⛔ 不在点击时
 *        回头翻 `state` 判「哪一档的第几个点」—— 缺口会让下标错位，而且不报错）。
 *
 * @param {Object} geo - `trendGeometry()` 的返回值
 * @param {Array.<?number>} series - 这一档的 12 格值（缺口是 `null`；点某个点时要读它）
 * @param {Object} d - `state.lg`
 * @returns {string} 这张卡的 HTML
 */
function trendCardHtml(geo, series, d) {
  // ⭐⭐ 0.8.21（「把【资产、负债、净资产】放到资产走势图位置（也就是移除手机端
  //    【资产走势图】这个文字，由三个切换按钮代替）」）：卡标题那句**撤了**，位置交给三态控件
  //    （左三颗按钮 ＋ 右年份下拉，同住 `.lg-ccap` 那一行）。
  //    ⚠️ 它是**第二版**处置：上一版是把控件另起一行贴在卡标题下面（`.lg-seg-sub` 那套
  //    `margin: 9px 0 0 auto`），现在连标题一起收掉、只剩这一行 —— 手机上又省一行。
  //    ⭐ 电脑端当天稍后也照做了（`desktop.js` 同一条）⇒ `RANGES` 里的 `trend` 整块删了。
  const cap = `<div class="lg-ccap">${rangeBarHtml()}${yearSelectHtml(d)}</div>`;
  if (geo.empty) {
    const y = String((d && d.today) || '').slice(0, 4);
    return `<div class="lg-card">${cap}
      <div class="lg-wait">${esc(y)} 年还没有记录 —— 你每次改余额，我都会记下当天那一刻。</div></div>`;
  }
  const b = AXIS_BOX;
  const zero =
    geo.zeroY == null
      ? ''
      : `<line class="lg-tz" x1="${b.padL}" y1="${geo.zeroY}" x2="${b.w - b.padR}" y2="${geo.zeroY}" />`;
  // ⚠️ 纵轴刻度文字靠 `dy` 往下挪半行去**对中那三条线**（`dominant-baseline` 各家实现不一致）；
  //    `text-anchor` 住 `app.css` 的 `.lg-tyt`（⛔ 不在模板串里写样式）。
  //    ⭐⭐ 0.8.10（「这个怎么是一样的」）：刻度文字**一次算一整组** ——
  //    纵轴那三个字必须互不相同（1.7 万附近相差几百块时，单值短写法会把三个都写成 `1.7万`）。
  //    ⇒ 走共用的 `yTickLabels()`，⛔ 别在这里自己调单值写法（那正是那个缺陷的成因）。
  const yLabels = yTickLabels(
    geo.yTicks.map((t) => t.v),
    state.lgHide,
  );
  const yGrid = geo.yTicks
    .map((t) => `<line class="lg-tg" x1="${b.padL}" y1="${t.y}" x2="${b.w - b.padR}" y2="${t.y}" />`)
    .join('');
  const yText = geo.yTicks
    .map(
      (t, i) =>
        `<text class="lg-tyt" x="${b.padL - 6}" y="${t.y}" dy="${(AXIS_FONT * 0.35).toFixed(1)}">${esc(
          yLabels[i],
        )}</text>`,
    )
    .join('');
  const segs = geo.segs.map((p) => `<polyline class="lg-tl" points="${p}" />`).join('');
  const dots = geo.dots
    .map((p) => `<circle class="lg-td${p.open ? ' open' : ''}" cx="${p.x}" cy="${p.y}" r="3.4" />`)
    .join('');
  // ⚠️ 命中圈**画在圆点之后**（它盖在最上面才点得中），而且是 `fill: transparent` 而不是
  //    `none` —— `none` 不参与命中测试，那圈就等于不存在（而"点了没反应"不会报错）。
  const hits = geo.dots
    .map(
      (p) =>
        `<circle class="lg-thit" cx="${p.x}" cy="${p.y}" r="12" data-act="lg-tdot" data-lbl="${esc(
          AXIS_MONTHS[p.i] || '',
        )}" data-v="${Math.trunc(Number(series && series[p.i]) || 0)}" />`,
    )
    .join('');
  const ticks = geo.ticks.map((t) => `<i style="left:${t.pct.toFixed(2)}%">${esc(t.text)}</i>`).join('');
  const only = geo.dots.length === 1 ? '<div class="lg-wait">才记了第一条 —— 再记几天就看得出走势了。</div>' : '';
  return `<div class="lg-card">${cap}
    <div class="lg-trend">
      <svg class="lg-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">${yGrid}${zero}${segs}${dots}${hits}${yText}</svg>
      <div class="lg-axis">${ticks}</div>
      <div class="lg-tpick"></div>
    </div>${only}</div>`;
}

/**
 * 功能：「当前资产 / 负债状况」—— 环形图 ＋ 右侧图例（名称 ＋ 百分比）。
 *
 * 说明：⭐⭐ 环里的项是**类目组**（`d.groups` 按侧筛），⛔ 不是逐个账户 —— 账户的粒度由
 *      下面那块排行榜负责（两块回答的是不同问题）。
 *      ⚠️ 图例**含 0 的项**（那是文字，不是图形）；环里 0 的项不画（`donutArcs()` 已滤）。
 *      于是「全是 0」时是「一个空环 ＋ 一排 `—`」—— 那正是事实（⛔ 不是 0.0%）。
 *
 * @param {Object} meta - 当前那一档
 * @param {Object} d - `state.lg`
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 这张卡的 HTML
 */
function donutCardHtml(meta, d, sides) {
  const key = rangeOf();
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0 };
  const total = key === 'debt' ? t.debt_fen : t.asset_fen;
  const items = ((d && d.groups) || [])
    .filter((g) => sides.get(g.kind) === key)
    .map((g) => ({ key: g.kind, name: metaOf(g.kind).name, fen: g.total_fen, color: metaOf(g.kind).color }));
  const ring = donutArcs(items, DONUT_R);
  const box = (DONUT_R + DONUT_SW / 2) * 2;
  const mid = box / 2;
  const arcs = ring.arcs
    .map(
      (a) =>
        `<circle class="lg-arc" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke="${a.color}" stroke-width="${DONUT_SW}" stroke-dasharray="${a.len.toFixed(
          2,
        )} ${(ring.c - a.len).toFixed(2)}" stroke-dashoffset="${a.offset.toFixed(2)}" />`,
    )
    .join('');
  const legend = items
    .map(
      (it) =>
        `<div class="lg-lg-row"><i style="--lg-c:${it.color}"></i><span>${esc(it.name)}</span><b>${esc(
          fmtPct(sharePct(it.fen, total)),
        )}</b></div>`,
    )
    .join('');
  return `<div class="lg-card">
    <div class="lg-ccap"><b>${esc(meta.now)}</b></div>
    <div class="lg-donut">
      <div class="lg-ring">
        <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
          <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
          <g transform="rotate(-90 ${mid} ${mid})">${arcs}</g>
        </svg>
        <div class="lg-ring-mid"><i>${esc(meta.center)}</i><b>${esc(fmtFen(total, state.lgHide))}</b></div>
      </div>
      <div class="lg-legend">${legend}</div>
    </div>
  </div>`;
}

/**
 * 功能：「资产 / 负债排行榜」—— 逐个账户：图标 ＋ 名称 ＋ 占比 ＋ 金额 ＋ 条 ＋ 备注。
 *
 * 说明：⭐ 粒度是**账户**（参考图里就是「现金」「备用微信号」这种账户名），与上面环形的
 *      「类目」粒度刻意不同。
 *      ⚠️ 行序走 `rankRows()`（`|值|` 降序、平手按服务端数组下标 ⇒ 次序确定，方案 §4.2）。
 *      ⚠️ 条长按 `|值| / 该侧合计`；合计为 0 时 `sharePct()` 回 `null` ⇒ 条宽 0、文字显示 `—`
 *      （⛔ 不画一条"0.0%"的假条，也⛔ 不显示 0.0%）。
 *
 * @param {Object} meta - 当前那一档
 * @param {Object} d - `state.lg`
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 这张卡的 HTML（一个账户都没有时是空串 —— 上面那张卡已经说过空态了）
 */
function rankCardHtml(meta, d, sides) {
  const key = rangeOf();
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0 };
  const total = key === 'debt' ? t.debt_fen : t.asset_fen;
  const rows = rankRows((d && d.accounts) || [], key, sides);
  if (!rows.length) return '';
  const body = rows
    .map((a) => {
      const p = sharePct(a.opening_fen, total);
      // ⚠️⭐ 占比 0 的项**不画填充**（占位 0% 的填充是一条看不见的线，等于给自己加了个假元素）；
      //    而占比 > 0 的项靠 CSS 的 `min-width` 兜住最小可见宽度 —— 否则一个占比 0.0X% 的
      //    账户会画成 0 像素宽、**看着像"漏了它"**（探针里量 `offsetWidth` 才逮住）。
      //    ⚠️ 轨道（`.lg-rkb`）照画：它保住行高，也表达"这一项是 0"。
      const fill = p == null || p <= 0 ? '' : `<span style="width:${p.toFixed(2)}%"></span>`;
      return `<div class="lg-rank">
        ${icoBlockHtml(a)}
        <div class="lg-rkm">
          <div class="lg-rkt"><b>${esc(a.name)}</b><i>${esc(fmtPct(p))}</i>
            <b class="lg-rka">${esc(fmtSide(a.opening_fen, key, state.lgHide))}</b></div>
          <div class="lg-rkb">${fill}</div>
          ${a.note ? `<i class="lg-rkn">${esc(a.note)}</i>` : ''}
        </div>
      </div>`;
    })
    .join('');
  return `<div class="lg-card"><div class="lg-ccap"><b>${esc(meta.rank)}</b></div>
    <div class="lg-ranks">${body}</div></div>`;
}

/**
 * 功能：「当前净资产状况」—— 一条「资产 vs 负债」比例对比条 ＋ 四个数。
 *
 * 说明：⭐⭐ 净资产态**不画环形 / 排行榜**（方案 §4.5）：净资产没有"构成"可言，
 *      能画的只有"资产与负债各占多少"这条对比条。
 *      ⚠️ 两边都是 0 ⇒ 画一条**空的灰条**（⛔ 不是一条 50/50 的假条 —— 那是编数据）；
 *      一段为 0 是合法的（只有资产没负债 ⇒ 负债那段宽 0，那是真事实）。
 *      ⚠️ 资产负债率的分母是资产 ⇒ 资产为 0 时算不出来，显示 `—`（⛔ 不许出现 Infinity / NaN）。
 *
 * @param {Object} meta - 当前那一档（`net`）
 * @param {Object} d - `state.lg`
 * @returns {string} 这张卡的 HTML
 */
function netPanelHtml(meta, d) {
  const t = (d && d.totals) || { asset_fen: 0, debt_fen: 0, net_fen: 0 };
  const pair = ratioPair(t.asset_fen, t.debt_fen);
  const bar = pair
    ? `<div class="lg-nbar">
        <span class="a" style="width:${pair.asset_pct.toFixed(2)}%">${pair.asset_pct >= 14 ? '资产' : ''}</span>
        <span class="d" style="width:${pair.debt_pct.toFixed(2)}%">${pair.debt_pct >= 14 ? '负债' : ''}</span>
      </div>`
    : '<div class="lg-nbar empty"></div>';
  return `<div class="lg-card">
    <div class="lg-ccap"><b>${esc(meta.now)}</b></div>
    <div class="lg-nnums"><b>${esc(fmtFen(t.asset_fen, state.lgHide))}</b><b>${esc(
      fmtFen(t.debt_fen, state.lgHide),
    )}</b></div>
    ${bar}
    <div class="lg-nrow"><span>净资产</span><b>${esc(fmtFen(t.net_fen, state.lgHide))}</b></div>
    <div class="lg-nrow"><span>资产负债率</span><b>${esc(fmtPct(debtRatioPct(t.asset_fen, t.debt_fen)))}</b></div>
  </div>`;
}

/**
 * 功能：图表视图整块（三态控件 ＋ 走势 ＋ 构成/对比 ＋ 排行）。
 *
 * 说明：⚠️⭐ 三态共用**同一份 `state.lg`** ⇒ 切口径**只重画、不重新取数**（方案 §三  的
 *      同一条纪律）；换**年**才重新取数（那年快照不在手上，方案 §4.5 明写允许）。
 *
 * @param {Object} d - `state.lg`
 * @param {Map.<string, string>} sides - 类型 → 侧
 * @returns {string} 这一屏的 HTML
 */
function chartHtml(d, sides) {
  const meta = RANGES.filter((r) => r.key === rangeOf())[0] || RANGES[0];
  const rows = Array.isArray(d && d.snapshots) ? d.snapshots : [];
  // ⭐ 0.8.10：这一串值要**留一份**给走势卡（点某个点时显示那一格的钱）——
  //    从前它只是一个实参，算完几何就没了。⚠️ 画布同时换成带纵轴的 `AXIS_BOX`。
  const series = trendSeries(rows, meta.key);
  const geo = trendGeometry(series, AXIS_BOX);
  const body =
    meta.key === 'net'
      ? netPanelHtml(meta, d)
      : `<div class="lg-cgrid">${donutCardHtml(meta, d, sides)}${rankCardHtml(meta, d, sides)}</div>`;
  // ⭐⭐ 0.8.21（「图表中的【资产、负债、净资产】放到资产走势图框中」）：
  //    口径那一段**不再占屏顶一行**，改由 `trendCardHtml()` 画进那张卡里（见它里面的 `cap`）。
  //    ⛔ 别在这里又画一条 —— 画了就是两处都在（而且不报错）。
  return `${trendCardHtml(geo, series, d)}${body}`;
}

/**
 * 功能：切「资产 / 图表」两个视图。
 *
 * 说明：⭐ **只改 state 再重画，⛔ 不重新取数**（两个视图共用一份 `state.lg`）。
 *
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-tab` 取目标是哪一屏）
 * @returns {void}
 */
export function lgTabPick(_act, n) {
  const k = String((n && n.dataset && n.dataset.tab) || '');
  state.lgTab = k === 'chart' ? 'chart' : 'asset';
  renderLedger();
}

/**
 * 功能：切图表的三态（资产 / 负债 / 净资产）—— 同一份数据换个口径看，同样⛔ 不重新取数。
 *
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 触发的那颗按钮（从 `data-range` 取口径）
 * @returns {void}
 */
export function lgRangePick(_act, n) {
  const k = String((n && n.dataset && n.dataset.range) || '');
  state.lgRange = RANGES.some((r) => r.key === k) ? k : 'asset';
  renderLedger();
}

/**
 * 功能：点走势图上某一个点 ⇒ 在横轴下面那一行写「几月 · 多少钱」。
 *
 * 说明：⚠️⭐ 那笔钱是从**命中圈自己带的 `data-v`** 读的（画的时候就写进去了）——
 *      ⛔ 不在这里回头翻 `state.lg` 再判一遍「这是哪一档的第几个点」：缺口会让两者错位，
 *      而那种错法**不报错**，只是显示成另一个月的钱。
 *      ⚠️ 这里用**完整**的 `fmtFen()`（不是纵轴那种短写法）—— 用户点一个点问的是
 *      「这个月到底多少」，不是「大概多少」。⚠️ 眼睛关着时照样糊掉。
 *      ⚠️ 只重写那一行文字，⛔ **不 `renderLedger()`**（整屏重画会把刚点中的那颗圈整个换掉，
 *      看着像"点了一下就闪一下"）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那颗命中圈（`.lg-thit`）
 * @returns {void}
 */
export function lgTrendDot(_act, n) {
  const card = n && n.closest ? n.closest('.lg-card') : null;
  const box = card && card.querySelector('.lg-tpick');
  if (!box) return;
  const lbl = String((n.dataset && n.dataset.lbl) || '');
  const fen = Math.trunc(Number((n.dataset && n.dataset.v) || 0)) || 0;
  box.textContent = [lbl, fmtFen(fen, state.lgHide)].join(' · ');
}

// ---------- 两步弹层：先选类型，再填表单 ----------

/**
 * 功能：开「类型选择」弹层 —— 八行带副标题（照参考图 B），点一行进表单。
 *
 * 说明：⚠️ 文案是「添加**账户**」，⛔ **不是**参考图那个「添加资产」（方案 §三）：
 *      九类里包含「负债」，写「添加资产」就是错的。
 *
 * @param {string} title - 弹层标题（新建时「添加账户」、改类型时「换个类型」）
 * @returns {void}
 */
function pickSheet(title) {
  const rows = KIND_ORDER.map((k) => {
    const m = metaOf(k);
    return `<button class="lg-pick" type="button" data-act="lg-pick" data-kind="${k}">
      <span class="lg-ico" style="--lg-c:${m.color}">${m.icon}</span>
      <span class="lg-pick-main"><b>${esc(m.name)}</b>${m.hint ? `<i>${esc(m.hint)}</i>` : ''}</span>
    </button>`;
  }).join('');
  openSheet(title, `<div class="lg-picks">${rows}</div>`);
}

/**
 * 功能：给输入框里的值做一次「读回草稿」—— 保存前与换类型前都要做。
 *
 * 说明：⚠️⭐ 类型换成不需要「后四位」的那几类时，那个输入框是**藏起来**的 ——
 *      这时候必须把它当空（否则「储蓄卡改成现金」会把一个看不见的后四位一路带过去，
 *      而用户根本没机会看见它）。
 *      ⚠️⭐ 名字同理，但判据来自**形态**（方案 §三）：处在银行形态时，名字由**下拉**说了算 ——
 *      选了具体一家就是那家，选「其它」才是文本框里那个，**没选（空串）一律当空**
 *      （⛔ 否则一个看不见的旧名字会被静默存进去，而用户以为"我没填名字"）。
 *
 * @param {Object} d - 草稿对象（就地改）
 * @returns {void}
 */
function captureForm(d) {
  const bankWrap = $('#lg-f-pickwrap');
  const bankSel = $('#lg-f-pick');
  const name = $('#lg-f-name');
  if (bankWrap && bankSel && !bankWrap.classList.contains('hidden')) {
    const v = String(bankSel.value || '');
    d.name = v === PICK_OTHER ? (name ? String(name.value || '').trim() : '') : v;
  } else if (name) {
    d.name = String(name.value || '').trim();
  }
  const wrap = $('#lg-f-tailwrap');
  const tail = $('#lg-f-tail');
  d.tail = tail && wrap && !wrap.classList.contains('hidden') ? String(tail.value || '').trim() : '';
  const note = $('#lg-f-note');
  if (note) d.note = String(note.value || '').trim();
  const opening = $('#lg-f-opening');
  if (opening) d.opening = String(opening.value || '').trim();
  // ⭐ 卡属性：分级 ＋ 三个限额。⚠️ 与「后四位」同一条纪律：类型不需要这几格时（现金 / 投资…）
  //    那一整块是 **hidden** 的 ⇒ 必须当成**清空**，⛔ 别把看不见的旧值一路带过去
  //    （「储蓄卡改成现金」会留下一个谁也没机会看见的分级）。
  const needLimit = needLimitOf(d.kind);
  const tierSel = $('#lg-f-tier');
  d.tier = needLimit && tierSel ? String(tierSel.value || '') : '';
  // ⚠️⭐ 选择器**必须带 #**：写成裸的 'lg-f-limd' 会被当成**标签名** ⇒ $() 永远回 null ⇒
  //    这三个值静默变成空串（服务端按「清空」写成 null），而分级那格照旧读得到 ——
  //    两个分支只差一个 #，单测与结构断言都看不出来（探针里「真填真存」才逮住）。
  for (const [key, sel] of [
    ['limitDay', '#lg-f-limd'],
    ['limitMonth', '#lg-f-limm'],
    ['limitYear', '#lg-f-limy'],
  ]) {
    const el = $(sel);
    d[key] = needLimit && el ? String(el.value || '').trim() : '';
  }
  // ⭐ 分类（按用途）：每套一格 —— 选了具体用途就是它；「＋ 新建用途…」那时读的是那个输入框；
  //    空（含「不分类」）＝ 把这套的用途清掉（服务端那边就是把那一行删掉）
  const tags = {};
  // ⚠️⭐ 必须用 `tagViewList()`（⛔ 不是 `viewList()`）：这里若把「按账户类型」也送上去，
  //    服务端 `applyTags()` 对 `builtin === 1` **一律 400**（不看值）⇒
  //    **新建与修改全都保存不了**（报的「保存都不行」+ 红 toast 就是这个）。
  for (const v of tagViewList()) {
    const inp = $(`#lg-f-tagnew-${v.id}`);
    const sel = $(`#lg-f-tag-${v.id}`);
    const raw = inp ? String(inp.value || '') : String((sel && sel.value) || '');
    tags[v.id] = raw === '__new__' ? '' : raw.trim();
  }
  d.tags = tags;
}

/**
 * 功能：画「所在银行 / 银行 · 平台」那颗下拉 —— 按 `optionsFor(kind)` 分组渲染。
 *
 * 说明：⚠️ 用**原生 `<select>`**（⛔ 不自画下拉），`.fld select` 那份样式文件里已经有了。
 *      ⚠️ 选项**从 `BANKS` / `CREDIT_PLATFORMS` 生成**（⛔ 不在这里手抄名字）⇒ 加一家银行
 *      只改 `calc.js` 一处，两端同时生效。
 *      ⭐ 分组：`credit` 是 `银行` / `信用支付` 两组（`<optgroup>`），`savings` 只有一组
 *      （label 为空 ⇒ **不画 optgroup 标题**）；末尾一律补「其它（自己输入）」。
 *
 * @param {string} kind - 类型键（决定有哪些可选项）
 * @param {string} value - 该选中哪一项（项名 / `PICK_OTHER` / 空串 = 请选择）
 * @returns {string} 这颗下拉的 HTML
 */
function pickSelectHtml(kind, value) {
  const o = optionsFor(kind);
  if (!o) return '';
  const one = (v, text) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(text)}</option>`;
  const groups = o.groups
    .map((g) => {
      const items = g.items.map((b) => one(b.name, b.name)).join('');
      return g.label ? `<optgroup label="${esc(g.label)}">${items}</optgroup>` : items;
    })
    .join('');
  return `<select id="lg-f-pick">${one('', '请选择')}${groups}${one(PICK_OTHER, '其它（自己输入）')}</select>`;
}

/**
 * 功能：下拉换了值 —— 只切「自己填」那一格的显隐，⛔ 不重画弹层（重画会把别的字段与光标一起抹掉）。
 *
 * 说明：⚠️ 选了具体一家时**刻意不清空**那个文本框：用户改主意又选回「其它」时，刚才打的字还在。
 *      而它**不会漏进保存**：银行形态下 `captureForm()` 取的是下拉的值（见上）。
 *
 * @param {string} v - 下拉当前的值（银行名 / `PICK_OTHER` / 空串）
 * @returns {void}
 */
function pickFollow(v) {
  const wrap = $('#lg-f-namewrap');
  if (wrap) wrap.classList.toggle('hidden', v !== PICK_OTHER);
  if (v === PICK_OTHER) {
    const input = $('#lg-f-name');
    if (input) input.focus();
  }
}

/** `#sheet-body` 的 change 委托只挂一次（弹层容器是**常驻节点**，每次开弹层都挂一遍会叠加） */
let bankBound = false;

/**
 * 功能：挂弹层内容容器上的**非 click** 委托（`change` ＋ `input`，**只挂一次**）。
 *
 * 说明：⭐ 手机端这几处**不走 `mobile/app.js` 的 `ACTIONS` 表**：那张表派发的是 **click**，
 *      而 `<select>` 换值只发 `change`、打字只发 `input` —— 宿主那层两个通道都没有，
 *      要加就得改 `mobile/app.js`，而那不属于本模块（铁律 11）。⇒ 本模块自己挂在弹层内容容器上，
 *      与 `modules/timetable/mobile.js`（`#sheet-body` 上的 change）同一种手法。
 *      ⭐ 0.8.1（§7.2）：`input` 这一路是**备注入框的即时过滤** —— 边打边用 `matchNote()`
 *      筛服务端给回来的那 20 条候选（⛔ 前端不 distinct、⛔ 不重新出网）；只重画候选那一条，
 *      ⛔ 不重画整张弹层（那会把别的格里打的字与光标一起抹掉）。
 *
 * @returns {void}
 */
function bindPickChange() {
  if (bankBound) return;
  const body = $('#sheet-body');
  if (!body) return;
  bankBound = true;
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return undefined;
    if (t.id === 'lg-f-pick') return pickFollow(String(t.value || ''));
    if (t.dataset && t.dataset.tagview && String(t.value) === '__new__') return askNewTag(t);
    return undefined;
  });
  body.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || t.id !== 'lg-ed-note') return undefined;
    // ⚠️ 顺手把草稿里那一格也跟上（用户可能直接点「完成」，那时不会再有 change/click 帮我们读）
    if (state.lgDraft) state.lgDraft.note = String(t.value || '');
    paintNoteChips();
    return undefined;
  });
}

/**
 * 功能：把表单那一整块画出来（含「类型」那一行的入口）。
 *
 * 说明：⭐ 0.8.0：「名称」那一格有两种形态（储蓄卡 / 信用卡 = 银行下拉 + 「自己填」，其余六类 = 纯文本框），
 *      形态由 `pickShapeOf()` 一次算清 —— `#lg-f-name` 这个 id 与 `d.name` 的语义**都没变**
 *      （`captureForm()` 还是从它读），⛔ 别改 id、⛔ 别改字段名。
 *      ⚠️ 本端换类型是**整块重画**（`lgPick()` → `formSheet()`），所以形态与回填都在这里一次画对，
 *      ⛔ 不需要桌面端那个 `paintKind()`。
 *
 * @param {Object} d - 草稿
 * @returns {string} 表单 HTML
 */
/**
 * 功能：画「分级」那颗下拉 —— 候选值来自 `calc.js` 的 `TIERS`（⛔ 不在这里手抄）。
 *
 * 说明：⚠️ 刻意**不给自由填**：`1类` / `一类` / `I类` 会散成三种写法，而这是要给机器比的字段。
 *      空值 = 不填（老账户 / 不是银行卡的那些账户本来就没有这一格）。
 *
 * @param {string} cur - 当前值（`Ⅰ` / `Ⅱ` / `Ⅲ` / 空串）
 * @returns {string} 那颗下拉的 HTML
 */
function tierSelectHtml(cur) {
  const c = String(cur || '');
  const opts = [`<option value="">不填</option>`]
    .concat(TIERS.map((t) => `<option value="${t}"${t === c ? ' selected' : ''}>${t} 类</option>`))
    .join('');
  return `<select id="lg-f-tier">${opts}</select>`;
}

/**
 * 功能：详情卡上那段「分级 ＋ 已设的限额」—— 一条都没设时回空串（⛔ 不画一行空的）。
 * @param {Object} a - 一个账户
 * @returns {string} 那一段的 HTML（或空串）
 */
function limitBlockHtml(a) {
  const lines = limitLinesOf(a);
  if (!lines.length) return '';
  const body = lines.map((l) => `<span><i>${esc(l.label)}</i>${esc(l.value)}</span>`).join('');
  return `<div class="lg-dmeta">${body}</div>`;
}
function formFieldsHtml(d) {
  const m = metaOf(d.kind);
  const shape = pickShapeOf(d.kind, d.name);
  return `<button class="lg-type-row" type="button" data-act="lg-retype">
      <span class="lg-ico" style="--lg-c:${m.color}">${m.icon}</span>
      <span class="lg-type-name">${esc(m.name)}</span><em>换个类型</em>
    </button>
    <label class="fld${shape.needPick ? '' : ' hidden'}" id="lg-f-pickwrap">
      <span>${esc(m.nameLabel)}</span>${pickSelectHtml(d.kind, shape.select)}</label>
    <label class="fld${shape.nameHidden ? ' hidden' : ''}" id="lg-f-namewrap">
      <span id="lg-f-namelabel">${esc(shape.needPick ? '自己填' : m.nameLabel)}</span>
      <input id="lg-f-name" type="text" maxlength="${NAME_MAX}" value="${esc(shape.value)}" /></label>
    <label class="fld${needTailOf(d.kind) ? '' : ' hidden'}" id="lg-f-tailwrap">
      <span>${esc(tailLabelOf(d.kind))}（可以空着）</span>
      <input id="lg-f-tail" type="text" maxlength="4" inputmode="numeric" value="${esc(d.tail)}" /></label>
    <label class="fld${needLimitOf(d.kind) ? '' : ' hidden'}" id="lg-f-limitwrap">
      <span>分级（可以空着）</span>
      ${tierSelectHtml(d.tier)}
      <div class="lg-limits-cap">限额不填就是不限</div>
      <div class="lg-limits">
        <div><span>日限额</span>
          <input id="lg-f-limd" type="text" inputmode="decimal" value="${esc(d.limitDay)}" /></div>
        <div><span>月限额</span>
          <input id="lg-f-limm" type="text" inputmode="decimal" value="${esc(d.limitMonth)}" /></div>
        <div><span>年限额</span>
          <input id="lg-f-limy" type="text" inputmode="decimal" value="${esc(d.limitYear)}" /></div>
      </div></label>
    <label class="fld"><span>备注（可以空着）</span>
      <input id="lg-f-note" type="text" maxlength="${NOTE_MAX}" value="${esc(d.note)}" /></label>
    ${tagFieldsHtml(d)}
    <label class="fld"><span>余额</span>
      <input id="lg-f-opening" type="text" inputmode="decimal" value="${esc(d.opening)}" /></label>
    <div class="m-tip">账户初始化余额</div>`;
}

/**
 * 功能：开「表单」弹层 —— 新建与编辑**共用同一个函数**（⛔ 别各写一份）。
 *
 * 说明：⚠️ 编辑时底部多一颗「删除」（危险确认在 `lgDel` 里）。
 *
 * @param {Object} d - 草稿
 * @returns {void}
 */
function formSheet(d) {
  const editing = Number(d.id) > 0;
  // ⭐ 银行下拉的 change 委托在这里保证「挂过一次」（它挂在常驻的 `#sheet-body` 上，见 `bindPickChange()`）
  bindPickChange();
  openSheet(
    editing ? '改这个账户' : '添加账户',
    formFieldsHtml(d),
    editing
      ? `<button class="btn danger" type="button" data-act="lg-del" data-id="${Number(d.id)}">删除</button>` +
          `<button class="btn primary" type="button" data-act="lg-save" data-id="${Number(d.id)}" style="flex:1.4">保存</button>`
      : `<button class="btn primary" type="button" data-act="lg-save" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：「＋ 添加账户」—— 从空的草稿开始走两步。
 * @returns {void}
 */
export function lgNew() {
  draft = null;
  pickSheet('添加账户');
}

/**
 * 功能：⭐ 0.8.55 —— 接住 AI 确认卡上那颗「修改」：把卡片里的那一笔预填进「记一笔」。
 *
 * 说明：⭐⭐ 与电脑端同一套（留白事件 `zx:ai-proposal-edit`）：AI 只把 `{kind, items}` 交出来，
 *      表单、校验、落库全在本模块。`detail.handled = true` 是回执 —— 没认领的卡片类型由 AI 明说支持不了。
 *      ⚠️ 卡片状态不动；一张卡多笔时只开第一笔并如实说明。
 * @returns {void}
 */
export function bindAiProposalEdit() {
  if (bindAiProposalEdit._bound) return;
  bindAiProposalEdit._bound = true;
  document.addEventListener('zx:ai-proposal-edit', (e) => {
    const d = e && e.detail;
    if (!d || String(d.kind || '') !== 'ledger_proposal') return;
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) return;
    d.handled = true;
    const it = items[0] || {};
    const at = String(it.at == null ? '' : it.at);
    void lgEntryAdd({
      ie: String(it.ie || '') === '收入' ? '收入' : '支出',
      amount: it.amount == null ? '' : String(it.amount),
      catId: Number(it.category_id) || 0,
      acctId: Number(it.account_id) || 0,
      note: it.note == null ? '' : String(it.note),
      // `datetime-local` 要的形状；形状不对就给空串（让用户自己填，⛔ 不拼一个"看着像"的时刻）
      dt: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(at) ? `${at.slice(0, 10)}T${at.slice(11, 16)}` : '',
    }).then(() => {
      if (items.length > 1) toast(`这张卡有 ${items.length} 笔，先给你开了第一笔`);
    });
  });
}

/**
 * 功能：表单里那颗「换个类型」—— 先把当前填的值读回草稿，再开类型选择（⛔ 不许丢已填内容）。
 * @returns {void}
 */
export function lgRetype() {
  if (!draft) return;
  captureForm(draft);
  pickSheet('换个类型');
}

/**
 * 功能：在类型选择页选了某一类 ⇒ 建 / 更新草稿并进表单。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（读 `data-kind`）
 * @returns {void}
 */
export function lgPick(_act, n) {
  const kind = String((n && n.dataset && n.dataset.kind) || '');
  if (!KIND_ORDER.includes(kind)) return;
  // ⚠️⭐ 空草稿必须写成**一行**：`ttt/test/ledger.test.js` 拿源码形状钉住它（对象字面量一行写完，
  //    且里面必须带 `tier` / `limitDay` / `limitMonth` / `limitYear` 四个键）—— 拆成多行
  //    （`prettier` 一旦重排就会）那条护栏会当场判"找不到空草稿"。
  //    ⛔ 别为了"排版好看"把它摊开：这里 pin 的是「新账户草稿里有哪几个键」，不是排版。
  //    ⚠️ 也别在注释里照抄这段字面量：护栏扫的是**整个文件**，注释里抄一份就会被当成第二份草稿。
  const d = draft || { id: 0, kind, name: '', tail: '', note: '', opening: '', tier: '', limitDay: '', limitMonth: '', limitYear: '', tags: {} };
  d.kind = kind;
  draft = d;
  formSheet(d);
}

/**
 * 功能：点了某一行 ⇒ 直接开编辑弹层（方案 §4.3：账户一行只有一个数，中间再插一层详情就是白多一步）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} _n - 触发按钮（未用）
 * @param {Function} id - 取 `data-id` 的函数
 * @returns {void}
 */
export function lgEdit(_act, _n, id) {
  const rid = Number(id());
  const a = ((state.lg && state.lg.accounts) || []).find((x) => Number(x.id) === rid);
  if (!a) return;
  draft = {
    id: Number(a.id),
    kind: a.kind,
    name: a.name,
    tail: a.tail,
    note: a.note,
    opening: fenToInput(a.opening_fen),
    tier: String(a.tier || ''),
    limitDay: a.limit_day_fen == null ? '' : fenToInput(a.limit_day_fen),
    limitMonth: a.limit_month_fen == null ? '' : fenToInput(a.limit_month_fen),
    limitYear: a.limit_year_fen == null ? '' : fenToInput(a.limit_year_fen),
    tags: a.tags || {},
  };
  formSheet(draft);
}

/**
 * 功能：保存（新建或编辑）—— ⛔ 金额的**格式校验交给服务端**（那是唯一一份判据）。
 *
 * 说明：⚠️ 只做「名称不能空」这一条本地前置检查：它是**表单语义**（空的表单不该发出去），
 *      不是判据的复制。金额串原样发上去，服务端判不过就 400，那句文案原样弹给用户。
 *
 * @returns {Promise.<void>}
 */
export async function lgSave() {
  if (!draft) return;
  captureForm(draft);
  if (!draft.name) {
    // ⭐ 储蓄卡 / 信用卡的空名字有**两条**路：下拉选一家，或选「其它」自己填 ——
    //    文案要把两条路都说出来（只说「给它起个名字吧」等于没说：用户看不到该动哪儿），
    //    并把光标送到**该动的那一个**上。⚠️ 这条仍只是**表单语义**检查，⛔ 没碰服务端的判据。
    const sel = $('#lg-f-pick');
    const bankWrap = $('#lg-f-pickwrap');
    const inBank = !!(sel && bankWrap && !bankWrap.classList.contains('hidden'));
    toast(inBank ? '先选一家银行，或选「其它」自己填' : '给它起个名字吧', true);
    const target = inBank && String(sel.value || '') !== PICK_OTHER ? sel : $('#lg-f-name');
    if (target) target.focus();
    return;
  }
  const editing = Number(draft.id) > 0;
  const body = {
    kind: draft.kind,
    name: draft.name,
    tail: draft.tail,
    note: draft.note,
    opening: draft.opening,
    tier: draft.tier,
    limit_day: draft.limitDay,
    limit_month: draft.limitMonth,
    limit_year: draft.limitYear,
    tags: draft.tags || {},
  };
  try {
    if (editing) await api('PUT', `/api/ledger/accounts/${Number(draft.id)}`, body);
    else await api('POST', '/api/ledger/accounts', body);
    closeSheet();
    draft = null;
    await loadLedger();
    toast(editing ? '改好了' : '记下了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：删除这个账户（**危险确认**）—— 文案要说清「历史净值不会被改写」（方案 §三）。
 *
 * 说明：⚠️ 不写这句的危险：用户删完发现图表没变，会当成 bug 来报。
 *
 * @param {Object} _act - 动作名（未用）
 * @param {Object} _n - 触发按钮（未用）
 * @param {Function} id - 取 `data-id` 的函数
 * @returns {void}
 */
export function lgDel(_act, _n, id) {
  const rid = Number(id());
  if (!rid) return;
  askConfirm({
    title: '删除这个账户？',
    // ⭐⭐ 0.8.1（2 期）：这条文案**变了事实** —— 1 期删账户会连带删掉转账明细，2 期
    //    **一条都不删**（记账 / 转账 / 调整都留着，账户名按删除时的原名留档，
    //    见 `modules/ledger/store.js` 的 `ledgerDeleteAccount`）。
    //    ⚠️ 下面这段与电脑版 `desktop.js` 的那条**逐字一致**——同一件事
    //    两端两段说法，用户会以为是两回事。⛔ 别再按 1 期那句「转账会一起删掉」写。
    text:
      '删了就找不回来了。⚠️ 历史净值不会被改写 —— 那些天记下的是「你当时有多少钱」，删一个账户不会把它改掉。' +
      '✅ 它名下的记账 / 转账 / 调整记录都会保留（记的是"那笔钱确实动过"这件事）；' +
      '只是从今往后这一屏不再列它，那些记录里的账户名也不再随它改名。',
    ok: '永久删除',
    danger: true,
  }).then((ok) => {
    if (ok) lgDeleteGo(rid);
  });
}

/**
 * 功能：真的删（确认之后走这里）。
 * @param {number} rid - 账户 id
 * @returns {Promise.<void>}
 */
async function lgDeleteGo(rid) {
  try {
    await api('DELETE', `/api/ledger/accounts/${Number(rid)}`);
    draft = null;
    // ⚠️ 删除是从**详情屏**发起的 ⇒ 那两屏的临时态（看哪个账户 / 明细）要一起清掉：
    //    不清的话手上那份明细还挂着「刚刚被删掉的那个账户」，而这一屏正停在它上面。
    state.lgAcct = 0;
    state.lgChg = [];
    state.lgChgCursor = null;
    state.lgChgDone = false;
    state.lgChgLoad = 'idle';
    state.lgChgErr = '';
    state.lgChgMonth = '';
    // ⭐ 2 期：删完账户**先刷新取名口**（它刚进删除记录表 ⇒ 它的原名从这一刻起只能从这里取），
    //    再重取一屏。⚠️ 顺序反了的话，这一屏画出来的是"没有它名字的那一版"，而且**不报错**。
    await ensureAcctNames();
    await loadLedger();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

// ============================================================================
// ⭐⭐ 0.8.2 记账 3 期：明细屏 / 账单屏 / 月详情页 / 预算屏
//    ⚠️ 手机端与电脑端**逐字同一条口径**：两端各画一份视图，
//    但文案、口径、状态判据必须一致 ⇒ 判据只住一处（项目）。
//    ⚠️⭐ **所有金额都由服务端给**（2 期 §5.4「前端不算钱」）—— 这一节只做排版。
// ============================================================================

// ---------- 共用的两个小口子 ----------

/**
 * 功能：**服务端今天**（`YYYY-MM-DD`）—— 期间起点、周档的「当前自然周」都要用它。
 *
 * 说明：⭐⭐ 「今天」**只认服务端那一份**（`overview.today`，/ C-3）：手机日期不可信
 *      （用户可能设成别的时区 / 别的日子），拿本机 `new Date()` 去算 `period_key` 会让
 *      「本周」在两台设备上是两周，而它**不报错**。⛔ 别在本文件里另开一个日期来源。
 *      ⚠️ 还没取到 overview 时是空串 ⇒ 各调用方按三态画错误块（⛔ 不猜一个日期出来）。
 * @returns {string} `YYYY-MM-DD`；没取到时是空串
 * @since 0.8.2
 */
function todayOf() {
  return String((state.lg && state.lg.today) || '');
}

/**
 * 功能：子屏（账单屏 / 月详情页）**自带的「‹ 返回」头**。
 *
 * 说明：⭐ 手机端的历史栈只认「底部标签」那一层（`syncHistory()` 只压 `#tab`）——
 *      账户详情屏也是**屏内自带返回**的同款做法 ⇒ 这两个子屏照它办，
 *      ⛔ 不去改宿主的 hash 机制。
 *      ⚠️ 这两个子屏**不画底部那条记账导航**（底栏留给第一层那四格），所以它们的内容区
 *      不用给底栏留空间（`.lg-xbody` 那份内边距里没有 `--tabbar-h`）。
 * @param {string} act - 返回那颗按钮的动作名（`lg-md-back`；账户详情那颗是 `lg-back`，
 *      设置子页那颗是 `lg-setback` —— ⭐ 0.8.3 起「账单」升成一级格了，它**不再有返回头**）
 * @param {string} title - 屏标题
 * @returns {string} 这一条头的 HTML
 * @since 0.8.2
 */
function subHeadHtml(act, title) {
  return `<div class="lg-xhead">
    <button class="lg-xback" type="button" data-act="${esc(act)}" aria-label="返回">‹</button>
    <b>${esc(title)}</b>
  </div>`;
}

/**
 * 功能：「读不到 ＋ 重试」那一块（三态里的 error）—— ⛔ 绝不画成空态。
 * @param {string} what - 读的是什么（「流水」/「账单」/「这个月的账单」/「预算」）
 * @param {string} msg - 失败原因（用户能看的那句话）
 * @param {string} act - 重试那颗按钮的动作名
 * @param {string} [attrs] - 追加在重试按钮上的属性串（如 ` data-key="2026-09-01"`）——
 *      ⚠️ 月详情 / 预算那两处**必须**带上（重试时动作要知道"重取哪一期"），
 *      ⛔ 别让那颗按钮点了没反应（那是本项目最难查的一类错）。
 * @returns {string} 这一块的 HTML
 * @since 0.8.2
 */
function errBoxHtml(what, msg, act, attrs) {
  return `<div class="err-box"><b>${esc(what)}没读到</b><p>${esc(msg || '原因不明')}</p>
    <button class="chip on" type="button" data-act="${esc(act)}"${attrs || ''} style="margin-top:14px">重新加载</button></div>`;
}

// ---------- ① 明细屏（图 1 / 图 8） ----------

/** AI 助手那颗圆环（左上）—— 单色线性 SVG，颜色由 CSS 的 `currentColor` 给。 @type {string} */
const ICO_AI =
  '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/>' +
  '<circle cx="12" cy="12" r="3.1"/></svg>';

/** 放大镜（右上，搜索）—— ⚠️ 本期**只是图标**（点了弹一句「开发中，敬请期待~」）。 @type {string} */
const ICO_SEARCH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/>' +
  '<path d="M15.4 15.4 20 20"/></svg>';

/** 日历（右上）—— 同上，本期只是图标。 @type {string} */
const ICO_CAL =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3.6" y="5.4" width="16.8" height="15" rx="2.4"/><path d="M3.6 10h16.8"/>' +
  '<path d="M8 3.6v3.4M16 3.6v3.4"/></svg>';

/**
 * 搜索那一行里那颗「收起」—— 细线 ✕（把**就地展开**的搜索框收回去）。
 *
 * 说明：⭐ 0.8.21（「手机端的搜索图标：点击过后在旁边展开搜索框，不是弹窗」）：
 *      搜索不再是底部弹层 ⇒ 那一行上必须有一颗**明确的关闭**（不然用户只能再点一次放大镜去猜）。
 * @type {string}
 * @since 0.8.21
 */
const ICO_CLOSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4"/></svg>';

/**
 * 明细屏那一行工具条**是不是正开在搜索上**（内存态，⛔ 不落库、⛔ 不挂 DOM class）。
 *
 * 说明：⭐⭐ 0.8.21（「手机端的搜索图标：点击过后在旁边展开搜索框，不是弹窗」）：
 *      从前点放大镜开的是**底部弹层**（`openSheet()`）；现在改成**就在那一行里就地展开**一个
 *      输入框、流水区换成搜索结果。⚠️ 判据住这里一处 —— 换格 / 重进屏都要复位（见
 *      `lgSegPick()` 与 `mountLedger()`），否则切走再切回来会停在上一次那个搜索态。
 *      ⚠️ 它**不住 `state`**：这一屏整块重画，模块级的开关最省事、也不会被抹掉。
 * @type {boolean}
 * @since 0.8.21
 */
let searchOn = false;

/**
 * 功能：明细屏工具行里**就地展开**的那个搜索框（`#lg-search-q`）。
 *
 * 说明：⚠️ 它顶掉的是原来那个「撑开左右两头的空格」（`.lg-dtools-sp`）—— 开着搜索时那一行是
 *      `AI 圆环 ｜ 输入框 ｜ ✕`（⛔ 不再画日历那颗，把宽度让给输入框）。
 *      ⚠️ 输入框的 id / 类名（`lg-search-q` / `lg-sinput`）**沿用弹层版那一套** ——
 *      `searchInputChanged()` 与 `bindSearchInput()` 都按它们找节点。
 * @returns {string} 这一段的 HTML
 * @since 0.8.21
 */
function searchInlineHtml() {
  return (
    '<div class="lg-sinline">' +
    '<input class="lg-sinput" id="lg-search-q" type="text" autocomplete="off" aria-label="搜索关键字">' +
    '</div>'
  );
}

/**
 * 功能：明细屏顶部那一行工具条（AI 圆环 ＋ 搜索 / 收起 ＋ 日历）。
 *
 * 说明：⭐ 0.8.21：开着搜索时 `[AI] [输入框] [✕]`；没开时 `[AI] … [🔍] [📅]`（原来的样子）。
 *      ⚠️ 三颗图标仍是**零出网**的（AI 派事件切屏、日历派事件切屏、搜索只打记账自己的接口）。
 * @returns {string} 那一行的 HTML
 * @since 0.8.21
 */
function dtoolsHtml() {
  const aiBtn =
    '<button class="lg-ai" type="button" data-act="lg-ai-help" aria-label="AI 助手">' + ICO_AI + '</button>';
  const searchBtn =
    '<button class="lg-dico" type="button" data-act="lg-search" aria-label="' +
    (searchOn ? '收起搜索' : '搜索') +
    '">' +
    (searchOn ? ICO_CLOSE : ICO_SEARCH) +
    '</button>';
  const calBtn = searchOn
    ? ''
    : '<button class="lg-dico" type="button" data-act="lg-go-cal" aria-label="日历">' + ICO_CAL + '</button>';
  const mid = searchOn ? searchInlineHtml() : '<span class="lg-dtools-sp"></span>';
  return '<div class="lg-dtools">' + aiBtn + mid + searchBtn + calBtn + '</div>';
}

/**
 * 功能：把就地展开的搜索框接上（防抖输入 / 回车立刻搜）——⚠️ **每次重画都要重接一次**。
 *
 * 说明：⚠️⭐ 那个输入框是随这一屏**现造**的（`renderLedger()` 每次 `innerHTML=` 换骨头）
 *      ⇒ 监听器绑在上一份节点上就随它一起没了。所以每一趟画完明细屏、只要开着搜索就要重接
 *      （⛔ 别绑在委托层上：`#lg-search-q` 是个动态节点，宿主那张动作表够不着它）。
 *      ⛔ 这里**不 `focus()`** —— 重画（取数回来 / 切格回来）时抢焦点会让正在看列表的人很烦；
 *      开那一下的聚焦住 `lgSearch()`。
 * @returns {void}
 * @since 0.8.21
 */
function bindSearchInput() {
  const inp = $('#lg-search-q');
  if (!inp) return;
  inp.addEventListener('input', () => searchInputChanged(inp.value));
  inp.addEventListener('keydown', (e) => {
    // 回车 ⇒ 立刻搜（不等防抖那 250ms）
    if (e.key === 'Enter') {
      e.preventDefault();
      searchInputChanged(inp.value, true);
    }
  });
}

/**
 * 功能：画「明细」那一屏（版式权威 = 参考图 1 / 图 8）。
 *
 * 说明：⭐⭐ 这一屏一共五块（§7.3.1 逐条）：
 *      ① 顶部**工具行**：左侧 AI 圆环、右侧放大镜与日历 —— ⭐ **三颗都只弹一句
 *      「开发中，敬请期待~」、⛔ 一个请求都不发**（记账是**零出网**模块）；
 *      ② **年月选择**：`2026年 09月 ▾`，点它开**底部弹层**（T45）—— 默认**本月**（来自服务端 today）；
 *      ③ **当月合计**：收入 / 支出两个数（**不带符号**、两位小数，**由服务端 `summary` 给**）
 *      ＋ 右侧一颗**眼睛**（复用 `lgEye()` 与 `lgHide` —— 同一个字段、⛔ 不新开第二个）；
 *      ④ 一颗「**账单**」按钮 ⇒ 进账单屏（§7.3.2，`lg-bill`）；
 *      ⑤ **按天分组的流水列表**（组标题 ＋ 当天两个小计；行 = 分类小图标 ＋ 名称 ＋ 金额）。
 *      ⚠️⭐ 流水那一套渲染原本长在「记账」那一格上⇒ 现在**整块归这里**，
 *      ⛔ 不留第二份（判据与接口一律复用 `entryGroupsHtml()` 那一套）。
 *      ⚠️ 三态（读取中 / 读不到 ＋ 重试 / 这个月没有）照 2 期原样保留（`entryGroupsHtml()` 内部）。
 * @returns {string} 这一屏的 HTML
 */
function detailScreenHtml() {
  const cur = monthKey();
  const s = state.lgSum || null;
  // ⚠️ 合计还没到手（首次读取中 / 读不到）⇒ 画 `—`：⛔ 不画 0.00（那是"这个月一分没有"，
  //    而真相是"还没读到"——三态必须分得开）。金额一律 `fmtFen`（掩码只住它一处）。
  const money = (fen) => (s ? esc(fmtFen(fen, state.lgHide)) : '—');
  // ⚠️⭐ 容器类名是 `.lg-dpane`（**不是** `.lg-detail`）—— 那个名字已经被**账户详情屏**
  //    占了（`lgDetailHtml()` 那一屏用 `.lg-detail` / `.lg-dhead` / `.lg-dcard`）。
  //    两屏共用一个类名 ⇒ 给这边加的版式会顺手套到那边（而画面上只表现为"详情屏忽然变窄了"，
  //    不报错、也没人知道是这里改的）—— 「一个类名别给两个组件用」。
  // ⭐ 0.8.21：搜索是**就地展开**的（⛔ 不是底部弹层）⇒ 开着搜索时，流水区画搜索结果那一块。
  const list = searchOn
    ? '<div class="lg-sres" id="lg-search-out"><div class="lg-txwait">输入关键字开始搜。</div></div>'
    : entryGroupsHtml() + entryMoreHtml();
  return `<div class="lg-dpane">
    ${dtoolsHtml()}
    <div class="lg-dsum">
      <button class="lg-dmonth" type="button" data-act="lg-month-pick">${esc(monthLabel(cur))} ▾</button>
      <div class="lg-dsum-cols">
        <div><span>收入</span><b>${money(s ? s.income_fen : 0)}</b></div>
        <div><span>支出</span><b>${money(s ? s.expense_fen : 0)}</b></div>
 <!-- ⭐ 0.8.9 修订（「移除所有的退款红色字体」）—— 与电脑端同款：
             这张卡上**不再有**「退款」那一栏；退款只在它退的那一笔原消费那一行露面。 -->
      </div>
      ${eyeHtml()}
    </div>
    <div class="lg-elist">${list}</div>
  </div>`;
}

/** ⭐ AI 那个「会话对象」在对话模块里的键（= `modules/ai/shared.js` 的 `AI_CONV_KEY`）。
 *  ⚠️ 跨模块契约：那边改了这里也要改（改错了的表现是「跳过去停在对话列表」且**不报错**）。 @type {string} */
const AI_CONV_SLOT = 'ai';

/**
 * 功能：明细屏那颗**双圆环** ⇒ 跳到「对话」里的 **AI 助手对话界面**（0.8.4）。
 *
 * 说明：⭐⭐ 「第一个双圆环的：点击跳转到对话中的 AI 助手对话界面」。
 *      ⚠️⭐ 它**不是**把账目发给模型：本函数只**切屏**（派一个事件给宿主），一个 fetch 都没有 ——
 *      记账仍然是**零出网**模块（调研 §3.5 / §7.7）。真正与模型对话发生在 AI 助手那一屏，
 *      那一边有自己的授权与告知（项目）。
 *      ⛔ 也**不许**在这里 import 对话 / AI 模块（模块之间不直接调；而且被判禁用的
 *      模块一被 import，记账就跟着它挂）⇒ 定式：**派事件、宿主切屏**（见 mobile/app.js 的监听）。
 * @returns {void}
 * @since 0.8.4
 */
export function lgAiHelp() {
  document.dispatchEvent(new CustomEvent('zx:open-module', { detail: { mod: 'teamwork', slot: AI_CONV_SLOT } }));
}

/**
 * 功能：明细屏那颗**日历**图标 ⇒ 打开**首页看板**并进「日历视图」（0.8.4；⭐ 0.8.7 改形状）。
 *
 * 说明：⭐ 0.8.7：日历**不再有自己的屏**了 —— 它现在是首页看板里的第二个视图。
 *      ⇒ 这一颗从 `{ mod: 'calendar' }` 改成 `{ mod: 'home', slot: 'calendar' }`
 *      （`mod: 'home'` 是看板、不是模块；`slot` 是「要看哪个模块贡献的视图」）。
 *      ⚠️⭐ 与电脑端 `modules/ledger/desktop.js` 同一颗**必须一起改**；
 *      改错了的表现是「跳过去停在列表视图，而且**不报错**」。
 * @returns {void}
 * @since 0.8.7
 */
export function lgGoCal() {
  document.dispatchEvent(new CustomEvent('zx:open-module', { detail: { mod: 'home', slot: 'calendar' } }));
}

/**
 * 功能：明细屏那颗**放大镜** ⇒ 在那一行里**就地展开**搜索框（⭐ 0.8.21 改形状；0.8.4 起真能搜）。
 *
 * 说明：⭐⭐ 0.8.21（「手机端的搜索图标：点击过后在旁边展开搜索框，不是弹窗」）：
 *      从前它开的是**底部弹层**（`openSheet()`）；现在改成**就在工具行里展开**一个输入框，
 *      流水区换成搜索结果那一块（`detailScreenHtml()` 按 `searchOn` 画）。
 *      ⚠️ 再点一次（那颗图标这会儿是 ✕）就收回去，流水列表原样回来。
 *      ⚠️ 输入框的监听**每次重画都要重接**（见 `bindSearchInput()` 的说明）。
 *      ⚠️ 搜索本身一个字没改：仍是 `GET /api/ledger/search`（在**合并流**里按
 *      备注 / 分类 / 来源 / 金额 的子串找，最新在前）。
 *      ⚠️ 表单里**没有 `placeholder`**（硬规矩）：用一行说明代替。
 * @returns {void}
 * @since 0.8.4
 */
export function lgSearch() {
  searchOn = !searchOn;
  // 换了模式就把**在飞的那一次搜索**作废（序号一推，旧响应回来对不上号就自己丢掉）
  state.lgSearchSeq = Number(state.lgSearchSeq || 0) + 1;
  renderLedger();
  if (!searchOn) return;
  const inp = $('#lg-search-q');
  if (inp && typeof inp.focus === 'function') inp.focus();
}

/** 搜索输入的防抖定时器（`0` = 空闲）。 @type {number} */
let searchTimer = 0;

/**
 * 功能：搜索框内容变了 —— 防抖 250ms 再发请求（打字过程中**不发**）。
 *
 * 说明：⚠️ 每次请求都往 `state.lgSearchSeq` 上盖一个序号，回来时对不上就**丢掉** ——
 *      打字快的时候上一个请求可能后到，不丢的话会把**旧关键字**的结果画在新结果上，
 *      而界面看起来完全正常（一个不报错的错）。
 * @param {string} v - 输入框当前的值
 * @param {boolean} [now] - true = 立刻搜（回车）
 * @returns {void}
 * @since 0.8.4
 */
function searchInputChanged(v, now) {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = 0;
  }
  if (now) return void runSearch(v);
  searchTimer = setTimeout(() => {
    searchTimer = 0;
    runSearch(v);
  }, 250);
}

/**
 * 功能：真去搜一次并画结果（`GET /api/ledger/search`）。
 * @param {string} q - 关键字
 * @returns {Promise.<void>}
 * @since 0.8.4
 */
async function runSearch(q) {
  const kw = String(q || '').trim();
  const seq = Number(state.lgSearchSeq || 0) + 1;
  state.lgSearchSeq = seq;
  if (!kw) {
    paintSearchOut(null, '');
    return;
  }
  paintSearchOut({ loading: true }, '');
  try {
    const r = await api('GET', `/api/ledger/search?q=${encodeURIComponent(kw)}`);
    if (Number(state.lgSearchSeq) !== seq) return; // 有更新的请求在飞 ⇒ 这一份不要了
    paintSearchOut((r && r.search) || null, '');
  } catch (e) {
    if (Number(state.lgSearchSeq) !== seq) return;
    paintSearchOut(null, e.message);
  }
}

/**
 * 功能：把搜索结果画进 `#lg-search-out`（⭐ **就地重画那一块**，⛔ 不整屏重画）。
 * @param {?Object} d - `{ loading }` / 服务端的 `search` 对象 / `null`（空关键字）
 * @param {string} err - 失败原因（非空 ⇒ 画「读不到」）
 * @returns {void}
 * @since 0.8.4
 */
function paintSearchOut(d, err) {
  const box = $('#lg-search-out');
  if (!box) return;
  if (err) {
    box.innerHTML = `<div class="lg-txwait">没搜成：${esc(err)}</div>`;
    return;
  }
  if (!d) {
    box.innerHTML = '<div class="lg-txwait">输入关键字开始搜。</div>';
    return;
  }
  if (d.loading) {
    box.innerHTML = '<div class="lg-txwait">正在搜…</div>';
    return;
  }
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) {
    box.innerHTML = '<div class="lg-txwait">没有匹配的流水。</div>';
    return;
  }
  const cap = d.count > rows.length ? `找到 ${d.count} 笔（下面是最近的 ${rows.length} 笔）` : `找到 ${d.count} 笔`;
  box.innerHTML = `<div class="lg-scap">${esc(cap)}</div>${rows.map(searchRowHtml).join('')}`;
}

/**
 * 功能：搜索结果里的一行 —— `日期 ｜ 分类 · 备注 ｜ 金额`。
 * @param {Object} r - 服务端给的一行
 * @returns {string} 那一行的 HTML
 * @since 0.8.4
 */
function searchRowHtml(r) {
  const at = String((r && r.at) == null ? '' : r.at);
  const note = String((r && r.note) == null ? '' : r.note);
  const name = String((r && r.name) == null ? '' : r.name) || '未分类';
  return `<div class="lg-sres-row">
    <span class="lg-sres-d">${esc(at.slice(5, 10))}</span>
    <span class="lg-sres-m">${esc(name)}${note ? `<span class="lg-sres-n"> · ${esc(note)}</span>` : ''}</span>
    <span class="lg-sres-a">${esc(fmtFen((r && r.amount_fen) || 0, state.lgHide))}</span>
  </div>`;
}

// ---------- 月份选择弹层（图 8） ----------

/** 选月弹层里正在选的**年**（`0` = 还没开过弹层）。 ⚠️ 只活在这一次弹层里，⛔ 不进 state。 @type {number} */
let mpYear = 0;

/** 选月弹层里正在选的**月**（`1~12`）。 ⚠️ 同上。 @type {number} */
let mpMonth = 0;

/**
 * 功能：选月弹层里「年」那一列有哪些年 —— **服务端给的年 ∪ 已知的年 ∪ 今天那一年**（升序）。
 *
 * 说明：⭐⭐ 0.8.4 修：**主来源是服务端的 `/api/ledger/periods`**（`state.lgPeriods.years`）——
 *      它由 `statRowsOf()` 算出来（含**三方导入**的行）⇒ 从鲨鱼记账导进来的 2024 / 2025 年
 *      才选得到。⛔ 光靠 `entryMonthOptions()` **不行**：那份清单是从「手上这一页流水」推的，
 *      而流水一次只加载一个月 ⇒ 选择器里永远只有当前那一个月（报的
 *      「记账中的月份无法切换」就是这个）。⚠️ 服务端那份也**不是**「今年 ± N 年」——
 *      它只列**真有记录的**期（方案 §7.3.1：⛔ 不凭空铺空月份给用户挑，挑到空白页他不知道那不是 bug）。
 * @returns {Array.<number>} 年份（升序）
 * @since 0.8.2
 */
function mpYears() {
  const set = new Set();
  for (const y of (state.lgPeriods && state.lgPeriods.years) || []) {
    const n = Number(y);
    if (n > 0) set.add(n);
  }
  for (const k of entryMonthOptions()) set.add(Number(String(k).slice(0, 4)));
  const y = Number(todayOf().slice(0, 4));
  if (y) set.add(y);
  return [...set].filter((v) => v > 0).sort((a, b) => a - b);
}

/**
 * 功能：选月弹层里「月」那一列（选了哪一年，就列**那一年的**有记录的月 ∪ 今年那个月）。
 *
 * 说明：⭐⭐ 同 `mpYears()`：主来源是服务端的 `state.lgPeriods.months`（含三方导入的月）。
 * @param {number} year - 已选中的年
 * @returns {Array.<number>} 月份（`1~12`，升序）
 * @since 0.8.2
 */
function mpMonthsOf(year) {
  const set = new Set();
  for (const m of (state.lgPeriods && state.lgPeriods.months) || []) {
    if (Number(String(m).slice(0, 4)) === Number(year)) set.add(Number(String(m).slice(5, 7)));
  }
  for (const k of entryMonthOptions()) {
    if (Number(String(k).slice(0, 4)) === Number(year)) set.add(Number(String(k).slice(5, 7)));
  }
  const today = todayOf();
  if (Number(today.slice(0, 4)) === Number(year)) set.add(Number(today.slice(5, 7)));
  return [...set].filter((v) => v >= 1 && v <= 12).sort((a, b) => a - b);
}

/** 功能：选月弹层里那一列（年 / 月）的整体 HTML。 @param {string} kind - `'year'` | `'month'` @returns {string} @since 0.8.2 */
function mpColHtml(kind) {
  const year = kind === 'year';
  const cur = year ? mpYear : mpMonth;
  const vals = year ? mpYears() : mpMonthsOf(mpYear);
  const body = vals
    .map((v) => {
      const label = year ? String(v) : String(v).padStart(2, '0');
      return `<button class="lg-mpick-i${Number(cur) === v ? ' on' : ''}" type="button" role="option"
        aria-selected="${Number(cur) === v}" data-act="lg-month-sel" data-kind="${kind}" data-v="${v}">${label}</button>`;
    })
    .join('');
  return `<div class="lg-mpick-col" id="lg-mp-${year ? 'years' : 'months'}" role="listbox"
    aria-label="${year ? '年' : '月'}">${body}</div>`;
}

/**
 * 功能：点明细屏那颗年月 ⇒ 开「选择月份」底部弹层（图 8：`取消` ｜ 标题 ｜ `确定` ＋ 年· 月两列滚轮）。
 *
 * 说明：⚠️ 两列是**可点的列**（不是原生 `<select>`）：版式要的是图 8 那种「两列并排、选中加粗」，
 *      而 `确定` 那一下才真的换月（`lg-month-ok`）—— 点中间任何一列**不换数据**。
 *      ⚠️ 初值 = 当前正在看的那个月（`monthKey()`），不是"今天"（用户翻到 7 月再点开，
 *      选择器要停在 7 月，⛔ 不许跳回今天）。
 *      ⚠️⭐ 0.8.4：开弹层**之前**先 `await loadPeriods()` —— 那两列的候选住它里面
 *      （见 `mpYears()` 的说明），不先取就是"点进去只有当前那一个月"。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgMonthPick() {
  // ⭐⭐ 0.8.4 修：**先把「有记录的期间」取到手再开弹层** —— 那两列的候选就住它里面
  //    （`mpYears()` / `mpMonthsOf()`）。不先取的话，弹层里只有「手上这一页流水」那一个月，
  //    用户点了也切不动（而它**不报错**）。已经取过就是一次空跑（`loadPeriods()` 自己挡）。
  await loadPeriods();
  const cur = monthKey();
  mpYear = Number(cur.slice(0, 4)) || Number(todayOf().slice(0, 4)) || 0;
  mpMonth = Number(cur.slice(5, 7)) || Number(todayOf().slice(5, 7)) || 1;
  // ⚠️ 当前那年 / 那月在列里（数据是"已知的月"）—— 万一不在（比如从没取过），补进月份列：
  //    否则选择器里一个 `.on` 都没有（用户看到的是一份"没选中"的滚轮，而它不报错）。
  const months = mpMonthsOf(mpYear);
  if (!months.includes(mpMonth)) mpMonth = months[0] || mpMonth;
  openSheet(
    '选择月份',
    `<div class="lg-mpick">${mpColHtml('year')}${mpColHtml('month')}</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-month-ok" style="flex:1.4">确定</button>`,
  );
}

/**
 * 功能：选月弹层里点了某一列的一项（⚠️ 只改选择、**不换数据、不关弹层**）。
 *
 * 说明：⚠️⭐ 只做两件小事：① 记住选中的年 / 月；② 就地改那两列的 `.on`（⛔ 不重画整个弹层 ——
 *      重画会把两列的滚动位置一起弹回顶部）。⚠️ 换**年**时月份列要跟着重画（那一年有哪些月
 *      是跟着年走的），并且**保证选中的月仍在新列里**（否则确定出来是一个不存在的月）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一项（`data-kind` = `year`/`month`，`data-v` = 值）
 * @returns {void}
 * @since 0.8.2
 */
export function lgMonthSel(_act, n) {
  const kind = String((n && n.dataset && n.dataset.kind) || '') === 'year' ? 'year' : 'month';
  const v = Number((n && n.dataset && n.dataset.v) || 0);
  if (kind === 'year') {
    if (!v || v === mpYear) return;
    mpYear = v;
    const months = mpMonthsOf(mpYear);
    if (!months.includes(mpMonth)) mpMonth = months[0] || mpMonth;
    const box = $('#lg-mp-months');
    if (box) box.innerHTML = mpColHtml('month');
  } else if (v >= 1 && v <= 12) {
    mpMonth = v;
  }
  const root = $('#lg-mp-years');
  const scope = root ? root.parentNode : null;
  if (!scope) return;
  for (const b of scope.querySelectorAll('[data-act="lg-month-sel"]')) {
    const k = String(b.dataset.kind || '') === 'year' ? 'year' : 'month';
    const val = Number(b.dataset.v) || 0;
    b.classList.toggle('on', (k === 'year' ? mpYear : mpMonth) === val);
    b.setAttribute('aria-selected', String((k === 'year' ? mpYear : mpMonth) === val));
  }
}

/**
 * 功能：选月弹层那颗「确定」⇒ 换月并**重新取一次流水**。
 *
 * 说明：⭐⭐ 换月**必须重取**（`loadEntries(true)`）：那个月的数据根本不在手上
 *      （⛔ 不是"从手上这份里筛"—— 手上只有当前这一页 30 条，筛出来永远只有一小截）。
 *      ⚠️ 选中的还是同一个月 ⇒ **不重取**（关掉弹层就好，别白跑一趟、也别把列表滚回顶部）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgMonthOk() {
  const key = `${mpYear}-${String(mpMonth).padStart(2, '0')}`;
  closeSheet();
  if (!/^\d{4}-\d{2}$/.test(key) || key === monthKey()) return;
  state.lgMonth = key;
  await loadEntries(true);
}

// ---------- ② 账单屏（图 2） ----------

/**
 * 功能：账单屏当前那一档（`'week'` / `'month'` / `'year'`）。
 *
 * 说明：⚠️ 认不出一律回落 `'month'` —— ⭐ **它就是默认档**（C-19：照图 2 的选中态）。
 *      白名单走 `calc.js` 的 `PERIOD_TYPES`（⛔ 不在这里再手写一遍 `['week','month','year']`）。
 * @returns {string} 三档之一
 * @since 0.8.2
 */
function billTabOf() {
  const k = String(state.lgBillTab || '');
  return PERIOD_TYPES.includes(k) ? k : 'month';
}

/**
 * 功能：月账单那颗「年份」下拉里的年份 —— **服务端给过的年 ∪ 今天那一年**（降序）。
 *
 * 说明：⚠️⭐ 服务端**没有**一条「有记账的年」的接口给前端（`bill` 的 `year` 档表格里有，
 *      但那一档不在这里）⇒ 年份只能取手上**已有**的那一份：`overview.years`
 *      （＝ 服务端算的「今年 ∪ 有过快照的年」，与资产图表那颗年份下拉**同一个来源**）。
 *      ⛔ 不凭空铺「今年 ±5 年」那种范围（挑到一整年空白，用户不知道那不是 bug）。
 *      ⚠️ 这条是个**已知的近似**：只有快照、没有别的年份来源 —— 记进交付报告的待决项。
 * @returns {Array.<number>} 年份（降序）
 * @since 0.8.2
 */
function billYears() {
  const set = new Set();
  // ⭐⭐ 0.8.4 修：主来源换成服务端的 `/api/ledger/periods`（`state.lgPeriods.years`）——
  //    它含**三方导入**的行 ⇒ 从鲨鱼记账导进来的 2024 / 2025 年在这儿才选得到
  //    （`state.lg.years` 只从**快照**推，导入的年进不去 ——
  //    「月账单也选择不了其它年份」就是这条）。
  for (const y of (state.lgPeriods && state.lgPeriods.years) || []) {
    const n = Number(y);
    if (n > 0) set.add(n);
  }
  for (const y of (state.lg && state.lg.years) || []) {
    const n = Number(y);
    if (n > 0) set.add(n);
  }
  const t = Number(todayOf().slice(0, 4));
  if (t) set.add(t);
  const cur = Number(String(state.lgBillKey || '').slice(0, 4));
  if (cur) set.add(cur);
  return [...set].sort((a, b) => b - a);
}

/**
 * 功能：账单表格那一行的**第一列**写什么（服务端只给 `key`，文案由前端折 —— §7.3.2）。
 *
 * 说明：⭐ 行上没有 `label`（服务端刻意不下发文案，见 `sliceShape()`）：`key` 是该子期的
 *      **起始日** ⇒ 月档 `YYYY-MM-01` → `9月`、年档 `YYYY-01-01` → `2026年`、
 *      周档 → `9/21~9/27`（⭐ 0.8.4：周档一行 = **某一周**，见 `weekRangeLabel()`）。
 * @param {string} periodType - 三档之一
 * @param {string} key - 该子期的起始日 `YYYY-MM-DD`
 * @returns {string} 第一列文案
 * @since 0.8.2
 */
function billRowLabel(periodType, key) {
  const s = String(key || '');
  if (periodType === 'year') return `${s.slice(0, 4)}年`;
  // ⭐ 0.8.4：周档一行 = 某一周 ⇒ 写清这一周是哪几天到哪几天（「本周」只有一个）。
  if (periodType === 'week') return weekRangeLabel(s);
  return `${Number(s.slice(5, 7))}月`;
}

/**
 * 功能：账单这一档「当前该看哪一期」的键 —— ⚠️ **周档与月档是同一个形状**（该月 1 号）。
 *
 * 说明：⭐⭐ 0.8.4：把周账单从「本周」改成「**某个月内的各周**」⇒ 周档的 `period_key`
 *      与月档**完全同形**（`YYYY-MM-01`），两者只是「表格怎么摊」不同（月 → 12 个月 /
 *      周 → 该月各周）。年档照旧 `YYYY-01-01`。
 *      ⛔ 这里**不能**直接用 `periodKeyOf('week', ...)` —— 那给的是**周一**（预算那一档的形状），
 *      传给账单会被接口层按 400 挡下（两种形状互斥， 不静默纠正）。
 * @param {string} type - `week` / `month` / `year`
 * @returns {string} 该期的起始日 `YYYY-MM-DD`（拿不到服务端今天时为空串）
 * @since 0.8.4
 */
function billKeyOf(type) {
  return periodKeyOf(type === 'week' ? 'month' : type, todayOf());
}

/**
 * 功能：账单屏当前这一期的 `period_key` —— 用户选过（`state.lgBillKey`）就用他选的。
 * @returns {string} 该期起始日 `YYYY-MM-DD`（取不到服务端今天时为空串 ⇒ 这一屏落进「读不到」）
 * @since 0.8.4
 */
function billPeriodKey() {
  return String(state.lgBillKey || '') || billKeyOf(billTabOf());
}

/**
 * 功能：周档那颗「**‹ 2026年09月 ›**」—— 换**看哪个月的周**（0.8.4 新增）。
 *
 * 说明：⭐ 「要能看到本月内的所有周，并且通过 `‹ 月份 ›` 切换月」。
 *      ⚠️ 它只是**上一个月 / 下一个月**（`shiftMonth()` 纯月份算术），⛔ 不自造日历控件。
 * @returns {string} 那一行的 HTML
 * @since 0.8.4
 */
function billMonthSwitchHtml() {
  const raw = String(state.lgBillKey || '');
  const cur = /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 7) : String(todayOf()).slice(0, 7);
  return `<div class="lg-bmon">
    <button class="lg-bmonbtn" type="button" data-act="lg-bill-shift" data-delta="-1" aria-label="上一个月">‹</button>
    <b>${esc(`${cur.slice(0, 4)}年${cur.slice(5, 7)}月`)}</b>
    <button class="lg-bmonbtn" type="button" data-act="lg-bill-shift" data-delta="1" aria-label="下一个月">›</button>
  </div>`;
}

/**
 * 功能：周档那颗「‹ 月份 ›」—— 换**哪个月的周**（0.8.4）。
 *
 * 说明：⚠️ 换月 = 换**期** ⇒ 要重新取数（新那个月的周根本不在手上）。
 *      ⚠️ 步进**夹在有数据的月区间里**（`state.lgPeriods.months`，升序）：不夹的话用户能一路
 *      切到 1763 年，服务端按年份越界回 400、界面画「读不到」（看着像坏了）。拿不到清单就不夹。
 *      ⚠️ 与切档（`lgBillTab`）同一条口径：这一格在「图表」视图下就重取图表，⛔ 别重取表格。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那颗按钮（`data-delta` = `-1` / `1`）
 * @returns {Promise.<void>|undefined}
 * @since 0.8.4
 */
export async function lgBillShift(_act, n) {
  const delta = Number((n && n.dataset && n.dataset.delta) || 0);
  if (!delta) return undefined;
  const cur = String(billPeriodKey()).slice(0, 7) || String(todayOf()).slice(0, 7);
  const next = shiftMonth(cur, delta);
  if (!/^\d{4}-\d{2}$/.test(next) || next === cur) return undefined;
  const list = (state.lgPeriods && state.lgPeriods.months) || [];
  if (list.length) {
    const lo = String(list[0]);
    const hi = String(list[list.length - 1]);
    if (next < lo || next > hi) return undefined;
  }
  state.lgBillKey = `${next}-01`;
  if (subTabOf(state.lgBillTab2) === 'chart') return loadChart();
  return loadBill();
}

/**
 * 功能：取一次账单屏一屏（`GET /api/ledger/bill`）并重画 —— **三档共用**（靠 `period_type` 分派）。
 *
 * 说明：⭐⭐ `period_key` 由前端按**服务端今天**折出来（`periodKeyOf()`）；用户换过年
 *      （月档那颗下拉）时用他选的那一年 ⇒ `state.lgBillKey`。⚠️ `period_key` 是**必填**
 *      （服务端 400 而不是替你猜），所以 `today` 为空时这一屏就是**读不到**（三态里的 error），
 *      ⛔ 绝不拿本机日期兜一个上去。
 *      ⚠️ 进账单那一格（`openBill()`）与换档 / 换年都走它；失败**不抛**（画「读不到 ＋ 重试」）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function loadBill() {
  // ⭐⭐ 0.8.22（「手机端：月账单-只能选择当前年份」）：**进账单屏时顺手取一次
  //    期间清单**（`/api/ledger/periods`）—— 年份下拉的主来源就是它的 `years`
  //    （它含**三方导入**的年；`state.lg.years` 只从快照推、导入的年进不去）。
  //    ⚠️⭐ 从前这一趟只在 `loadChart()` 里发 ⇒ 手机端停在「列表」那一档时**根本看不到图表**、
  //    也就永远不取它 ⇒ 年份下拉只剩「今年」一项（截图里正是这样）。
  //    ⛔ 别把这一行删掉；它自己也判重（`loadPeriods()` 取过就直接返回）。
  if (!state.lgPeriods) loadPeriods();
  state.lgBillLoad = 'loading';
  state.lgBillErr = '';
  renderLedger();
  const type = billTabOf();
  const key = billPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/bill?period_type=${encodeURIComponent(type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgBill = (r && r.bill) || null;
    state.lgBillLoad = 'done';
  } catch (e) {
    state.lgBill = null;
    state.lgBillLoad = 'error';
    state.lgBillErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：进账单屏（明细屏那颗「账单」）—— ⭐ 是**新屏**（T34），回来走屏内自带的「‹ 返回」。
 *
 * 说明：⚠️⭐ 手机端的历史栈只认「底部标签」那一层 ⇒ 这里**不压历史栈**（账户详情屏同款：
 *      屏内自带返回头）。⚠️ 它同时是「读不到」那颗重试的落点（再点一次就是重取）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
/**
 * 功能：进「账单」那一格 ⇒ 把这一格的数据取回来（⭐ 0.8.3：它已是一级格，取数跟屏走）。
 *
 * 说明：⚠️ 与预算那条（`openBudget()`）同款 —— **取数是这一格自己的事**：
 *      `lgSegPick()` 切到它时顺手叫一次，⛔ 别指望别人替它取（那就是"切过去一片空白、不报错"）。
 *      ⚠️ 顺手清掉月详情（它是这一格的下一层）：不清的话，「从月详情返回 ⇒ 又落到月详情」
 *      而**不报错**（`lgMdMonth` 还指着那个月）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function openBill() {
  state.lgMdMonth = 0;
  await loadBill();
}

// ============================================================================
// ⭐⭐ 0.8.3（4 期）：**图表** —— 内嵌在「明细」与「账单」里的那个视图
//
//   功能：「明细和账单有自己的图表（图表功能不是独立的），通过**药丸开关**
//   切换」⇒ 两屏各自一颗药丸 `列表 ｜ 图表`（默认列表）；切到「图表」＝按**期间**（周 / 月 / 年）
//   看**支出 / 收入**：折线 ＋ 排行榜。版式权威是给的三张参考图（§7.2.1 的逐条转录）。
//
//   说明：⭐⭐ 三条纪律：
//   · **金额一律服务端算**（`GET /api/ledger/chart` 把序列、两个数、排行都给齐）——
//     本文件只排版（⛔ 一个金额都不加）；
//   · ⭐ **换口径（支出 ⇄ 收入）只重画、⛔ 不重取数**；只有**换期间档 / 换期间**才回服务端
//     （项目）；
//   · 图元**只准复用**（折线走 `trendGeometry()`、占比走 `sharePct()`/`fmtPct()`、
//     条目小图标走月详情页那套 `.lg-eico`）—— ⛔ 不许长第二套图表实现。
// ============================================================================

/**
 * 功能：图表**当前该看哪一期** —— ⭐ 就是**账单自己的三档与年份**（`lgBillTab` / `lgBillKey`）。
 *
 * 说明：⭐ 0.8.4：图表只长在「账单」那一屏（明细那一屏那颗药丸已撤）⇒ 方案 §7.2 那句
 *      「同一套图，**期间选择与账单的三档联动**」现在是**唯一**一条路：
 *      在账单上切到「周账单」，它的图表就是**这一周**的图。
 * @returns {{type: string, key: string}} 该期的档与键（`key` 空串 = 还没选，按服务端今天算）
 * @since 0.8.2
 */
function chartCtxOf() {
  return { type: billTabOf(), key: String(state.lgBillKey || '') };
}

/**
 * 功能：取**期间清单**（第二行那些候选）—— ⭐ 只取一次（`state.lgPeriods` 有了就不重复取）。
 *
 * 说明：⭐⭐ 这份清单是**服务端**给的（`/api/ledger/periods`）：有数据的年 / 月 / 周
 *      **∪ 当前期**。⛔ 前端不许自己铺「今年 ± N 年」—— 那会让**导入进来的 2024 年数据**
 *      永远选不到（报的正是这个现象）。
 *      ⚠️ 失败**不打扰用户**（第二行少几颗候选而已，图本身照画）：拿不到就保持 `null`。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function loadPeriods() {
  // ⭐ 0.8.4：已经取过就**直接返回**（它现在有三处调用方：图表 / 导出页 / 选月弹层，
  //    每进一格都重拉一遍是白跑的请求）。⚠️ 失败时 `lgPeriods` 仍是 `null` ⇒ 下次还会再试。
  if (state.lgPeriods) return;
  try {
    const r = await api('GET', '/api/ledger/periods');
    state.lgPeriods = (r && r.periods) || null;
  } catch (_e) {
    state.lgPeriods = null;
  }
  renderLedger();
}

/**
 * 功能：取**图表一屏**（折线 ＋ 两个数 ＋ 排行榜）。
 *
 * 说明：⚠️ 顺手把期间清单也拉一次（不 `await`：它是第二行的事，图不等它）。
 *      ⚠️ 三态与账单屏同款（读取中 / 读不到 ＋ 重试 / 这一期没有数据）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function loadChart() {
  if (!state.lgPeriods) loadPeriods();
  state.lgChartLoad = 'loading';
  state.lgChartErr = '';
  renderLedger();
  const ctx = chartCtxOf();
  const key = ctx.key || billPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/chart?dir=${encodeURIComponent(chartDirOf(state.lgChartDir))}` +
        `&period_type=${encodeURIComponent(ctx.type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgChart = (r && r.chart) || null;
    // ⚠️ 服务端回的 `period_key` 才是权威（它校验过、也归过一）⇒ 记回**当前屏那一份** state
    state.lgBillKey = String((state.lgChart && state.lgChart.period_key) || key);
    state.lgChartLoad = 'done';
  } catch (e) {
    state.lgChart = null;
    state.lgChartLoad = 'error';
    state.lgChartErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：画**折线**（期间走势）—— ⭐ 几何走共用的 `trendGeometry()`（⛔ 不自己算坐标）。
 *
 * 说明：⚠️ 缺口（还没到的日子 / 那一格没数据）是 `null` ⇒ 线在缺口处**断开**、不画点
 *      （1 期那六条判据的第一条）；⭐ **最后一个点画空心圈**（参考图里就是它）。
 *      ⚠️ 右上角那个**最大值**来自服务端（`max_fen`），横轴标签走 `chartAxisOf()`。
 * @param {Object} d - 服务端给的图表一屏
 * @returns {string} 折线那一块的 HTML
 * @since 0.8.2
 */
function chartLineHtml(side) {
  const series = side && Array.isArray(side.series) ? side.series : [];
  if (!series.length) return '';
  const vals = series.map((p) => (p && p.fen != null ? Number(p.fen) : null));
  const geo = trendGeometry(vals, TREND_BOX, chartAxisOf(chartCtxOf().type, series));
  if (geo.empty) return '<div class="lg-wait">这一期还没有数据。</div>';
  const lines = geo.segs.map((s) => `<polyline class="lg-tl" points="${s}" />`).join('');
  const dots = geo.dots
    .map((p) => `<circle class="lg-td${p.open ? ' open' : ''}" cx="${p.x}" cy="${p.y}" r="2.6" />`)
    .join('');
  const ticks = geo.ticks.map((t) => `<i style="left:${t.pct.toFixed(2)}%">${esc(t.text)}</i>`).join('');
  const mx = Number(side && side.max_fen) || 0;
  return `<div class="lg-trend lg-ctrend">
    <div class="lg-cmax">${mx ? esc(fmtFen(mx, state.lgHide)) : ''}</div>
    <svg class="lg-svg" viewBox="0 0 ${TREND_BOX.w} ${TREND_BOX.h}" aria-hidden="true">${lines}${dots}</svg>
    <div class="lg-axis">${ticks}</div>
  </div>`;
}

/**
 * 功能：画**排行榜**（支出 / 收入各分类）—— 图标 ＋ 名称 ＋ 占比 ＋ 金额 ＋ 进度条。
 *
 * 说明：⭐ 占比走 **`sharePct()`**（共用比例函数）＋ **`fmtPct()`**（`<0.1%` 那条判据住它那里）；
 *      ⚠️ **金额为 0 的桶不画条**（`sharePct` 对 0 给 0，条宽就是 0 —— 但服务端已经
 *      把 0 的桶滤掉了，见 `pctRowsOf()`）。
 *      ⚠️ 图标复用流水行那套 `.lg-eico`（色块 ＋ 首字，零出网）—— 记账的分类**没有图标体系**，
 *      所以参考图里那颗「分类图标」在这里就是首字色块（与月详情页一致，⛔ 不新造图形语言）。
 * @param {Object} d - 服务端给的图表一屏
 * @returns {string} 排行榜那一块的 HTML
 * @since 0.8.2
 */
function chartRanksHtml(side) {
  const list = (side && Array.isArray(side.ranks) ? side.ranks : []).filter((r) => Number(r && r.amount_fen));
  if (!list.length) return '<div class="lg-wait">还没有分类数据。</div>';
  const total = Number((side && side.total_fen) || 0);
  return `<div class="lg-cranks">${list
    .map((r) => {
      const pct = sharePct(r.amount_fen, total);
      const w = pct == null ? 0 : Math.min(100, Math.abs(pct));
      return `<div class="lg-crow">
      <i class="lg-eico">${esc(String((r && r.name) || '?').slice(0, 1))}</i>
      <div class="lg-cmain">
        <div class="lg-ctop"><b>${esc((r && r.name) || '')}</b><span>${esc(fmtPct(pct))}</span></div>
        <div class="lg-cbar"><i style="width:${w.toFixed(1)}%"></i></div>
      </div>
      <b class="lg-camt">${esc(fmtFen(r && r.amount_fen, state.lgHide))}</b>
    </div>`;
    })
    .join('')}</div>`;
}

/**
 * 功能：图表的口径（支出 / 收入）**两颗按键** —— ⭐ 0.8.22 取代原来那颗 `<select>`。
 *
 * 说明：⭐⭐ 「图表中的下拉选项变为【支出、收入】两个按键，放到【平均值】右侧」
 *      —— 两颗就在 `.lg-cnums` 那一行的末端（靠 `margin-left: auto` 顶到最右）。
 *      ⚠️ 手机端走的是**宿主 `mobile/app.js` 的 `ACTIONS` 表**（`data-act` ＋ `#app` 全局委托）
 *      ⇒ 动作名沿用既有的 `lg-chart-dir`，**只是触发方式从 `change` 换成 `click`**：
 *      那条 `if (e.target.id === 'lg-chart-dir')` 的 `change` 分支已经删掉
 *      （那张 `<select>` 没有了），⛔ 别再留着。
 *      ⚠️ 与电脑端 `chartDirBarHtml()` **逐字同款**（版式各一份，判据与文案只有一处）。
 * @param {string} cur - 当前口径（`'out'` / `'in'`）
 * @returns {string} 这一组的 HTML
 * @since 0.8.22
 */
function chartDirBarHtml(cur) {
  const one = (k, name) =>
    `<button class="lg-cdbtn${cur === k ? ' on' : ''}" type="button" data-act="lg-chart-dir" data-dir="${esc(k)}"` +
    ` aria-pressed="${cur === k}">${name}</button>`;
  return `<div class="lg-cdbar" role="group" aria-label="选择口径">${one('out', '支出')}${one('in', '收入')}</div>`;
}

/**
 * 功能：画**图表视图**（账单那一屏的「图表」那一档）—— 口径 ＋ 两个数 ＋ 折线 ＋ 排行。
 *
 * 说明：⭐ 0.8.4：它现在**只长在「账单」那一屏**（明细那一屏那颗药丸已撤，见 `detailScreenHtml()`）
 *      ⇒ 期间由账单自己的三档（`周账单 / 月账单 / 年账单`）与年份下拉决定，
 *      ⛔ 这里**不再自带**「期间档药丸 ＋ 期间选择行」（那一套只给明细屏用过）。
 *      ⚠️ 三态：读取中 / 读不到 ＋ 重试 / 这一期没有数据 —— ⛔ 绝不把「读不到」画成「没有」。
 * @returns {string} 图表视图的 HTML
 * @since 0.8.2
 */
function lgChartViewHtml() {
  const dir = chartDirOf(state.lgChartDir);
  const d = state.lgChart;
  if (state.lgChartLoad === 'error') {
    return `<div class="lg-chart">${errBoxHtml('图表', state.lgChartErr, 'lg-chart-retry')}</div>`;
  }
  // ⭐⭐ 服务端一次把**两侧**都给（`d.out` / `d.in`）⇒ 换口径只用换这里取哪一侧，
  //    ⛔ 不必再跑一趟服务端（方案 §7.2.3 /）。
  const side = d ? d[dir] || null : null;
  if (state.lgChartLoad !== 'done' || !side) {
    return `<div class="lg-chart"><div class="lg-txwait">正在读取…</div></div>`;
  }
  // ⚠️ `avg_fen` 可能是 `null`（期还没开始 ⇒ 分母 0）⇒ 画 `—`，⛔ 不画 `0.00`
  const money = (fen) => (fen == null ? '—' : esc(fmtFen(fen, state.lgHide)));
  // ⭐ 0.8.22：口径那两颗按键（支出 / 收入）排在「平均值」右侧（与电脑端同一处、同一套样式）
  const nums = `<div class="lg-cnums">
    <div><span>总${dir === 'in' ? '收入' : '支出'}</span><b>${money(side.total_fen)}</b></div>
    <div><span>平均值</span><b>${money(side.avg_fen)}</b></div>
    ${chartDirBarHtml(dir)}
  </div>`;
  // ⭐⭐ 0.8.22（「图表：同电脑端修改」）：右栏（这里是一整屏）拆成**两张卡** ——
  //    上面那张（两颗按键 ＋ 两个数 ＋ 折线）**固定**，下面那张（排行）**自己滚**。
  return `<div class="lg-chart">
    <div class="lg-ccard">${nums}${chartLineHtml(side)}</div>
    <div class="lg-crankcard">${chartRanksHtml(side)}</div>
  </div>`;
}

/**
 * 功能：切**账单屏**那颗药丸（`列表 ｜ 图表`）—— 同上，⭐ 只重画不重取数。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一档（`data-tab`）
 * @returns {Promise.<void>|undefined}
 * @since 0.8.2
 */
export function lgBillTab2(_act, n) {
  return pickBillTab2(n && n.dataset && n.dataset.tab);
}

/**
 * 功能：切账单那一格的**「列表 ⇄ 图表」两档** —— 点指示点与左右滑动**走同一条路**。
 *
 * 说明：⭐⭐ 0.8.22（「账单去掉列表和图表两个按键，改为左右滑动切换」）：
 *      原来那颗药丸（`subTabsHtml('lg-btab2', …)`）撤了，换成与「资产」那一格同款的
 *      两颗**指示点**＋左右滑动 ⇒ 两条入口（点 / 滑）必须落到**同一个函数**上，
 *      ⛔ 别在 `touchend` 里再抄一遍这段（抄了就是"点能切、滑不能"或反之，而且不报错）。
 *      ⚠️ 图表那一档第一次进去要**取数**（`/chart` 与账单那一份不是同一个接口）。
 * @param {*} raw - 目标档（`'list'` / `'chart'`，认不出一律回落 `'list'`）
 * @returns {Promise.<void>|undefined}
 * @since 0.8.22
 */
function pickBillTab2(raw) {
  const k = subTabOf(raw);
  if (k === subTabOf(state.lgBillTab2)) return undefined;
  state.lgBillTab2 = k;
  if (k === 'chart' && state.lgChartLoad === 'idle') return loadChart();
  renderLedger();
  return undefined;
}

/**
 * 功能：换**口径**（支出 ⇄ 收入）—— ⭐⭐ **只重画、⛔ 不重取数**（方案 §7.2.3 / C-13 / 项目）。
 *
 * 说明：⭐ 之所以能做到，是因为服务端 `/chart` **一次就把两侧都给回来了**
 *      （`state.lgChart` 里 `out` / `in` 各一份）⇒ 换口径只是「换取哪一侧」。
 *      ⚠️ 这与 1 期 `lgTab`（资产 / 图表两视图切换）**逐字同款**：都不回服务端。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 那颗 `select`
 * @returns {Promise.<void>|undefined}
 * @since 0.8.2
 */
export function lgChartDirPick(_act, n) {
  // ⭐⭐ 0.8.22：口径那颗 `<select>` 换成了**两颗按键** ⇒ 值的来源从 `n.value` 变成 `n.dataset.dir`
  //    （`n` 现在是那颗按钮）。⚠️ 名字没改：`ACTIONS` 表里那一条（`'lg-chart-dir'`）继续有效，
  //    改的只是"谁触发、从哪取值"。
  const v = chartDirOf(n && n.dataset && n.dataset.dir);
  if (v === chartDirOf(state.lgChartDir)) return undefined;
  state.lgChartDir = v;
  renderLedger();
  return undefined;
}

/**
 * 功能：「读不到 ⇒ 重新加载」那颗（`errBoxHtml()` 给的动作名）—— 就是**再取一次图表**。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export function lgChartRetry() {
  return loadChart();
}

/**
 * 功能：切账单屏的三档（`周账单 ｜ 月账单 ｜ 年账单`）。
 *
 * 说明：⚠️ 换档 = 换**期** ⇒ `period_key` 一起复位（一律回到**服务端今天**那一期；
 *      切完之后想看别的期就用这一档自己的**换期控件**：周档那颗 `‹ 月份 ›` /
 *      月档那颗年份下拉）。
 *      ⚠️ 换档**要重新取数**（新那一档的行根本不在手上）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一档（`data-tab` = `week` / `month` / `year`）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgBillTab(_act, n) {
  const k = String((n && n.dataset && n.dataset.tab) || '');
  if (!PERIOD_TYPES.includes(k) || k === billTabOf()) return;
  state.lgBillTab = k;
  state.lgBillKey = '';
  // ⭐ 0.8.3：这一格切到「图表」时，换档要重取的是**图表**那一条（方案 §7.2：
  //    「同一套图，**期间选择与账单的三档联动**」）—— ⛔ 别重取表格（那一屏根本没画）。
  if (subTabOf(state.lgBillTab2) === 'chart') return loadChart();
  await loadBill();
}

/**
 * 功能：画账单屏（版式权威 = 参考图 2）—— 返回头 ＋ 三档 ＋（月档）年份下拉 ＋ 红色大卡 ＋ 表格。
 *
 * 说明：⭐⭐ 四块（§7.3.2）：
 *      ① **三档** `周账单 ｜ 月账单 ｜ 年账单`（默认月档，C-19）＋ 一颗**换期**控件
 *      （周档 → `‹ 月份 ›`、月档 → 年份下拉 —— ⭐ 0.8.4 周档从「本周」改成了「该月各周」）；
 *      ② **红色大卡**：结余（大号）＋ 收入 / 支出（小字），**标签随档变**（`billCardLabels()`）；
 *      ③ **表格**：表头 `billColLabels()`、行**照服务端给的顺序**（月档 12 行倒序、年档各年倒序、
 *      周档 = ⭐ 该月内**每一周**一行，倒序 —— 0.8.4 改）；
 *      ④ 行尾那颗 `›` ⇒ 进**月详情页** —— ⭐ **只有月档的行有它**（T41：周 / 年没有详情页）。
 *      ⚠️ 数值一律 `fmtFen`（**不带符号**，照图 2；`-` 是 `fmtFen` 自己给的，⛔ 不额外补 `+`）。
 *      ⚠️ 三态（读取中 / 读不到 ＋ 重试）与"这一档没有数据"必须分得开。
 * @returns {string} 这一屏的 HTML
 * @since 0.8.2
 */
function billScreenHtml() {
  const type = billTabOf();
  const d = state.lgBill;
  // ⭐ 0.8.3：屏内那颗药丸（`列表 ｜ 图表`）—— 图表是这一格的**第二个视图**（方案 §7.2）：
  //    同一份期间选择（三档 ＋ 月档的年份），列表画表格、图表画折线 ＋ 排行。
  const tab2 = subTabOf(state.lgBillTab2);
  // ⭐ 0.8.3：它升成**一级格**了 ⇒ ⛔ **不再有「‹ 返回」那条自画头**
  //    （一级格没有"上一层"可回；它现在就在底栏上，与明细 / 预算并排）。
  const tabs = PERIOD_TYPES.map((k) => {
    const label = k === 'week' ? '周账单' : k === 'year' ? '年账单' : '月账单';
    return `<button class="lg-btab${type === k ? ' on' : ''}" type="button" data-act="lg-bill-tab"
      data-tab="${k}" role="tab" aria-selected="${type === k}">${label}</button>`;
  }).join('');
  // ⭐ 0.8.22（「预算和账单没有隐藏金额按键」）：三档行右侧补一颗**眼睛** ——
  //    账单屏（含它下面「图表」那一档）通篇都是金额，而从前只有明细屏藏得掉。
  //    ⚠️ 复用 `eyeHtml()` 与 `state.lgHide`（⛔ 不新开第二个开关）；动作名 `data-act="lg-eye"`
  //    已在 `mobile/app.js` 的 `ACTIONS` 表里（与明细屏那颗同一个）。
  //    ⚠️⭐ 它住在 `.lg-tabrow` 那一层、**在 `role="tablist"` 外面**：塞进 tablist 里会被
  //    辅助技术念成一颗 tab（这颗钮管的是"藏不藏金额"，与"看哪一期"不是一件事）。
  const bar = `<div class="lg-tabrow"><div class="lg-btabs" role="tablist">${tabs}</div>${eyeHtml()}</div>`;
  // ⭐ 0.8.3：那颗药丸（`列表 ｜ 图表`）画在三档**上面**（它管的是"这一格用什么画"，
  //    三档管的是"看哪一期" —— 粗的那层在上面）
  // ⭐⭐ 0.8.22（「手机端的账单：去掉列表和图表两个按键，改为左右滑动切换（参考
  //    资产中的左右滑动）」）：那颗「列表 ｜ 图表」药丸**撤了**，换成与「资产」那一格**同款**的
  //    两颗**指示点**（它可点 ⇒ 那同时是无障碍那条路）；真正的手势在 `bindLedgerOnce()` 的
  //    `touchend` 里（与资产那条挂在同一个监听上）。
  const sub = tabDotsHtml(SUB_TABS, tab2, 'lg-btab2');
  // ⭐⭐ 0.8.4：三档各自的「换期」控件 ——
  //    · **周档** ⇒ `‹ 2026年09月 ›`（周档的期间 = **某个月的各周**
  //      「要能看到本月内的所有周，并且通过 `‹ 月份 ›` 切换月」）；
  //    · **月档** ⇒ 年份下拉（照旧）；
  //    · **年档** ⇒ 都不画（用服务端今天那一年，T39 / C-19）。
  const pick =
    type === 'week'
      ? billMonthSwitchHtml()
      : type === 'month'
        ? (() => {
            const list = billYears();
            const cur =
              Number(String(state.lgBillKey || '').slice(0, 4)) || Number(todayOf().slice(0, 4)) || 0;
            const opts = list
              .map((y) => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}年</option>`)
              .join('');
            return `<div class="lg-byear"><select id="lg-bill-year" aria-label="选择年份">${opts}</select></div>`;
          })()
        : '';

  // ⭐ 0.8.3：切到「图表」⇒ 这一格画的是图表（⭐ 期间跟着上面那三档与年份走，方案 §7.2 的「联动」）——
  //    ⚠️ 它**在下面那三条三态之前**分派：图表模式下要取的是 `/chart`（`state.lgChartLoad`），
  //    而 `lgBillLoad` 可能还停在别处 ⇒ 拿它判三态会把一块已经画好的图盖成「正在读取…」。
  if (tab2 === 'chart') {
    return `<div class="lg-bill">${sub}${bar}${pick}${lgChartViewHtml()}</div>`;
  }

  if (state.lgBillLoad === 'error') {
    return `<div class="lg-bill">${sub}${bar}${pick}${errBoxHtml('账单', state.lgBillErr, 'lg-bill')}</div>`;
  }
  if (state.lgBillLoad !== 'done' || !d) {
    return `<div class="lg-bill">${sub}${bar}${pick}<div class="lg-txwait">正在读取…</div></div>`;
  }

  const card = d.card || { income_fen: 0, expense_fen: 0, balance_fen: 0 };
  const lb = billCardLabels(type);
  const cols = billColLabels(type);
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const body = rows
    .map((r) => {
      const month = type === 'month';
      // ⚠️ 行尾那颗 `›` 只有**月档**有（T41：周 / 年没有详情页）—— 非月档的整行也不可点，
      //    ⛔ 别留一个点了没反应的 `data-act`。
      const tap = month ? ` data-act="lg-md-open" data-key="${esc(r.key)}"` : '';
      // ⭐⭐ 0.8.10：与电脑端**同一条口径**（两端各一份版式，判据必须一致）——
      //    ① 加了「预算 / 超支」两列；② 还没到的期一律画「—」（⛔ 不是 `0.00`：
      //    图表那边那种期是**断点**，两边必须长得一样）。
      const live = r.started !== false;
      const bud = r.budget_fen === null || r.budget_fen === undefined ? null : Number(r.budget_fen);
      // ⭐⭐ 0.8.22（「手机端空间有限，不显示小数」）：这三格走 `fmtFen()` 的
      //    **整元档**（第三参传 `true` ⇒ 四舍五入到元）。⚠️ 电脑端那一份**不传**（它有地方摆小数）。
      const cell = (v) => (live ? esc(fmtFen(Number(v) || 0, state.lgHide, true)) : '—');
      const budCell = live && bud !== null ? esc(fmtFen(bud, state.lgHide, true)) : '—';
      const ovCell = live && bud !== null ? esc(fmtFen(Number(r.overspent_fen) || 0, state.lgHide, true)) : '—';
      return `<div class="lg-btr${month ? ' tap' : ''}"${tap}>
        <span class="lg-btr-c1">${esc(billRowLabel(type, r.key))}</span>
        <span>${cell(r.income_fen)}</span>
        <span>${cell(r.expense_fen)}</span>
        <span>${cell(r.balance_fen)}</span>
        <span>${budCell}</span>
        <span>${ovCell}</span>
        <span class="lg-bchev">${month ? '›' : ''}</span>
      </div>`;
    })
    .join('');
  // ⭐⭐ 0.8.22（「手机端账单：【周账单】的日期切换和【月账单】的年份选择，
  //    和电脑端一样，放到卡片中」）：换期控件（`pick`）从屏顶搬进结余卡的右上角 ——
  //    与电脑端同一条口径（那里叫 `.lg-bctop`）。⚠️ 红底上的控件要白系覆盖，见 `app.css`。
  return `<div class="lg-bill">${sub}${bar}
    <div class="lg-bcard">
      <div class="lg-bctop">
        <span class="lg-bcap">${esc(lb.balance)}</span>
        ${pick}
      </div>
      <b class="lg-bnum">${esc(fmtFen(card.balance_fen, state.lgHide))}</b>
      <div class="lg-bcols">
        <div><span>${esc(lb.income)}</span><b>${esc(fmtFen(card.income_fen, state.lgHide))}</b></div>
        <div><span>${esc(lb.expense)}</span><b>${esc(fmtFen(card.expense_fen, state.lgHide))}</b></div>
      </div>
    </div>
    <div class="lg-btb">
      <div class="lg-btr head"><span class="lg-btr-c1">${esc(cols.first)}</span>
        <span>${esc(cols.income)}</span><span>${esc(cols.expense)}</span><span>${esc(
          cols.balance,
        )}</span><span>${esc(cols.budget)}</span><span>${esc(cols.overspent)}</span>
        <span class="lg-bchev"></span></div>
      ${body || '<div class="lg-txwait">这一档还没有数据。</div>'}
    </div>
  </div>`;
}

// ---------- ③ 月详情页（图 5；⭐ 只有「月」有这一页） ----------

/**
 * 功能：取一次月详情页一屏（`GET /api/ledger/month-bill`）并重画。
 *
 * 说明：⭐⭐ 服务端**一次给全**（占比表 / 排行 / 趋势 / 对比 / 收入构成 / 成就，§5.3 最后一段）
 *      ⇒ 这一屏**一个请求**，⛔ 不是按块各取一次（不做 N+1）。
 *      ⚠️ 失败**不抛**（画「读不到 ＋ 重试」），⛔ 绝不画成"这个月没有账单"。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function loadMonthBill() {
  const month = String(state.lgMdMonth || '');
  if (!month) return;
  state.lgMdLoad = 'loading';
  state.lgMdErr = '';
  renderLedger();
  try {
    const r = await api('GET', `/api/ledger/month-bill?month=${encodeURIComponent(month)}`);
    // ⚠️ 请求飞回来时再确认一次还停在这个月（用户可能在期间点了返回 / 换了另一行）——
    //    不判就会把上一个月的那一屏画在当前这一屏上（**不报错**）。与 `loadChanges()` 同款。
    if (String(state.lgMdMonth) !== month) return;
    state.lgMd = (r && r.month_bill) || null;
    state.lgMdLoad = 'done';
  } catch (e) {
    if (String(state.lgMdMonth) !== month) return;
    state.lgMd = null;
    state.lgMdLoad = 'error';
    state.lgMdErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：点账单表格某一行尾的 `›` ⇒ 进**该月详情页**（⭐ 只有月档的行有这颗，T41）。
 *
 * 说明：⚠️ 行上传的是 **`period_key`**（`YYYY-MM-01`，服务端的口径），这一屏要的是
 *      `month`（`YYYY-MM`）⇒ 只在这里**切掉最后三位**（⛔ 不另存一份月）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一行（`data-key` = 该月的起始日 `YYYY-MM-01`）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgMdOpen(_act, n) {
  const key = String((n && n.dataset && n.dataset.key) || '');
  if (!/^\d{4}-\d{2}/.test(key)) return;
  state.lgMdMonth = key.slice(0, 7);
  state.lgMd = null;
  state.lgMdLoad = 'idle';
  await loadMonthBill();
}

/** 功能：月详情页那颗「‹ 返回」⇒ 回账单屏。 @returns {void} @since 0.8.2 */
export function lgMdBack() {
  state.lgMdMonth = 0;
  state.lgMd = null;
  state.lgMdLoad = 'idle';
  renderLedger();
}

/**
 * 功能：月详情页的标题（`9月账单` —— 参考图 5）。
 *
 * 说明：⚠️ （T47）：图里那句「这是我与鲨鱼记账相识的第 N 天」**暂时不做**
 *      ⇒ 标题区只留 `9月账单` 这一句，⛔ 不编一句运营文案。
 * @param {string} month - `YYYY-MM`
 * @returns {string} 标题
 * @since 0.8.2
 */
function monthTitle(month) {
  return `${Number(String(month || '').slice(5, 7))}月账单`;
}

/**
 * 功能：一行「类别 ｜ 占比 ｜ 金额」的占比该写什么。
 *
 * 说明：⚠️⭐ 占比**已经由服务端算好**（`pct`，一位小数，见 `pctOf()`）⇒ 这里只排版，
 *      ⛔ 不拿金额再除一遍（那是第二套算术）。
 *      三条口径：`null`（分母为 0）⇒ `—`；**非零但极小**（服务端已经舍成 0.0）⇒ `<0.1%`
 *      （⛔ 不写 `0.0%` —— 环里明明画着那么一小段，文字说"零"就是自相矛盾）；
 *      其余照 `pct1()` 补一个 `%`（那就是它唯一的活）。
 * @param {Object} row - 服务端那一行（`{pct, amount_fen}`）
 * @returns {string} 显示串
 * @since 0.8.2
 */
function shareText(row) {
  const p = Number(row && row.pct);
  if (!Number.isFinite(p)) return pct1(null);
  if (p === 0 && Number(row && row.amount_fen) > 0) return '<0.1%';
  return pct1(p);
}

/**
 * 功能：月详情页里的**柱状图**（近 6 个月的支出 / 收入对比）。
 *
 * 说明：⭐⭐ 图元**复用 1 期那一套**（方案 §1.3：⛔ 不许长第二套图表实现）：
 *      把「近 6 个月」按月份落进 `trendGeometry()` 的 **12 格**（月序即下标），
 *      于是横向位置、刻度、纵轴缩放**全是同一份几何**；柱子的高度直接从它给的点算
 *      （`geo.dots` 的 y 到基线）。⚠️ 缺数据的月 `null` ⇒ 那一格没有点 ⇒ 不画柱
 *      （⛔ 不补 0：那会画出一根"这个月花了 0"的假柱子）。
 *      ⚠️ 横轴刻度**不换行**（`.lg-axis > i` 的 `white-space: nowrap`）。
 * @param {Array.<Object>} months - 服务端的 `months`（近 6 月，升序）
 * @param {string} field - 取哪个字段当柱高（`'expense_fen'` / `'income_fen'`）
 * @returns {string} 这一块的 HTML
 * @since 0.8.2
 */
function barChartHtml(months, field) {
  const list = Array.isArray(months) ? months : [];
  const slots = new Array(12).fill(null);
  for (const m of list) {
    const i = Number(String(m && m.key).slice(5, 7));
    if (i >= 1 && i <= 12) slots[i - 1] = Number(m[field]) || 0;
  }
  const b = TREND_BOX;
  const geo = trendGeometry(slots, b);
  if (geo.empty) return '<div class="lg-wait">近半年还没有数据。</div>';
  const base = geo.zeroY == null ? b.h - b.padB : geo.zeroY;
  const span = b.w - b.padL - b.padR;
  // ⚠️ 由点的横坐标**反推**它是哪一个月（`trendGeometry` 只给 x / y，不给下标）——
  //    这样「第几根柱对应几月」与那份几何是同一个判据，⛔ 不另按 6 等分推一遍。
  const monthOfX = (x) => String(Math.round(((x - b.padL) / span) * 11) + 1);
  const bars = geo.dots
    .map((p) => {
      const top = Math.min(p.y, base);
      const hgt = Math.max(Math.abs(base - p.y), 1);
      return `<rect class="lg-bar" x="${(p.x - 5).toFixed(1)}" y="${top.toFixed(1)}" width="10"
        height="${hgt.toFixed(1)}" rx="3" />`;
    })
    .join('');
  const ticks = geo.dots
    .map((p) => `<i style="left:${((p.x / b.w) * 100).toFixed(2)}%">${monthOfX(p.x)}月</i>`)
    .join('');
  return `<div class="lg-trend"><svg class="lg-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">
    ${bars}</svg><div class="lg-axis">${ticks}</div></div>`;
}

/**
 * 功能：月详情页里的**折线图**（这个月每天的支出）。
 *
 * 说明：⚠️⭐ 这里**没法**复用 `trendGeometry()`：它的横轴被写死成**12 个月**
 *      （刻度取自 `AXIS_MONTHS`），而这一条是**同一个月里的每一天**（最多 31 个点）
 *      ⇒ 只在本函数里按「日」铺点（横轴 = 当月第几号，与图 5 的 `01 … 30` 对齐），
 *      但**描线 / 描点仍用同一套类名**（`.lg-tl` / `.lg-td`）与同一份画布常量 `TREND_BOX`。
 *      ⚠️ 只有 `≠0` 的天会下来（服务端已经滤过，"花 500 又退 500" 的天不在里面）。
 *      ⚠️ 横轴刻度**不换行**。⚠️ 全等 / 只有一个点 ⇒ 人造跨度（⛔ 不让 `hi - lo` 当分母）。
 * @param {Object} trend - 服务端的 `expense_trend`
 * @param {string} month - `YYYY-MM`（用来算这个月有几天）
 * @returns {string} 这一块的 HTML
 * @since 0.8.2
 */
function dayLineHtml(trend, month) {
  const days = (trend && Array.isArray(trend.days) ? trend.days : []).filter(
    (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x && x.day)),
  );
  if (!days.length) return '<div class="lg-wait">这个月还没有支出。</div>';
  const y = Number(String(month).slice(0, 4));
  const mo = Number(String(month).slice(5, 7));
  const dim = new Date(y, mo, 0).getDate() || 30;
  // ⭐⭐ 0.8.3（4 期 C-14）：几何**收口到共用层** —— 从前这里自己算了一遍
  //    `lo/hi/span/xOf/yOf`（与 `calc.js` 的 `trendGeometry()` 是同一段算术的第二份拷贝，
  //    连 ±10% 余量与 nudge 都逐字相同）⇒ 现在只有一条路：把「每天一格」的值得出来，
  //    连横轴标签一起交给 `trendGeometry()`。⚠️ 缺口是 `null`（⛔ 不是 0）⇒ 线在缺口处**断开**。
  const geo = trendGeometry(dayValuesOf(days, dim), TREND_BOX, dayAxisOf(dim));
  if (geo.empty) return '<div class="lg-wait">这个月还没有支出。</div>';
  const b = TREND_BOX;
  const lines = geo.segs.map((s) => `<polyline class="lg-tl" points="${s}" />`).join('');
  const dots = geo.dots.map((p) => `<circle class="lg-td" cx="${p.x}" cy="${p.y}" r="2.6" />`).join('');
  const ticks = geo.ticks.map((t) => `<i style="left:${t.pct.toFixed(2)}%">${t.text}</i>`).join('');
  return `<div class="lg-trend"><svg class="lg-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">
    ${lines}${dots}</svg><div class="lg-axis">${ticks}</div></div>`;
}

/**
 * 功能：画**月详情页**（版式权威 = 参考图 5；⭐ 只有「月」有这一页，T41）。
 *
 * 说明：⭐⭐ 九块（§7.3.3）：① 标题 `9月账单`；② 卡（本月结余 ＋ **上月结余灰字弱化** ＋ 支出 / 收入
 *      两条占比条）；③ 支出类别（饼图 ＋ `类别 ｜ 占比 ｜ 金额` 表，**一位小数**）；
 *      ④ 支出排行（前三）；⑤ 支出趋势（单日最高 / 日均 / 本月支出 ＋ 折线）；
 *      ⑥ 月支出对比（柱状 ＋「对比上月变化前三的类别」）；⑦ 收入（总收入 ＋ 各来源占比）；
 *      ⑧ 月收入对比（柱状）；⑨ 记账成就（连续打卡 / 总天数 / 总笔数）。
 *      ⚠️⭐ 图元**复用 1 期那两套**（`donutArcs()` / `trendGeometry()` ＋ `.lg-ring` / `.lg-svg`
 *      那一组类名）—— ⛔ 不许长第二套图表实现（方案 §1.3）。
 *      ⚠️ 占比 0 的项**不画扇段**（`donutArcs()` 已滤）；条给 `min-width: 3px`（CSS）；
 *      非零极小值显示 `<0.1%`（`shareText()`）。
 *      ⚠️ 三态：读取中 / 读不到 ＋ 重试 /（这份账单本来就没有）—— 后者照实画 0 与空句，
 *      ⛔ 绝不把「读不到」画成「没有」。
 * @returns {string} 这一屏的 HTML
 * @since 0.8.2
 */
function monthDetailScreenHtml() {
  const month = String(state.lgMdMonth || '');
  const head = subHeadHtml('lg-md-back', monthTitle(month));
  if (state.lgMdLoad === 'error') {
    return `<div class="lg-md">${head}${errBoxHtml(
      '这个月的账单',
      state.lgMdErr,
      'lg-md-open',
      ` data-key="${esc(month)}-01"`,
    )}</div>`;
  }
  const d = state.lgMd;
  if (state.lgMdLoad !== 'done' || !d) {
    return `<div class="lg-md">${head}<div class="lg-txwait">正在读取…</div></div>`;
  }
  const card = d.card || {};
  const cats = Array.isArray(d.expense_categories) ? d.expense_categories : [];
  const top = Array.isArray(d.expense_top) ? d.expense_top : [];
  const trend = d.expense_trend || {};
  const movers = Array.isArray(d.expense_movers) ? d.expense_movers : [];
  const incs = Array.isArray(d.income_categories) ? d.income_categories : [];
  const months = Array.isArray(d.months) ? d.months : [];
  const ach = d.achievement || {};

  // ---- ② 卡：本月结余 ＋ 上月结余（灰字弱化，T42-①：⛔ 不是删除线）＋ 两条占比条 ----
  const ratioBar = (label, fen, pct) => {
    const w = Math.max(Number(pct) || 0, 0);
    return `<div class="lg-mdbar">
      <div class="lg-mdbar-t"><span>${esc(label)}</span><b>${esc(fmtFen(fen, state.lgHide))}</b></div>
      <div class="lg-mdbar-b"><span style="width:${w.toFixed(2)}%"></span></div>
      <i class="lg-mdbar-p">${esc(pct1(pct))}</i>
    </div>`;
  };
  const cardHtml = `<div class="lg-card">
    <div class="lg-mdnum"><span>本月结余</span><b>${esc(fmtFen(card.balance_fen, state.lgHide))}</b></div>
    <div class="lg-mdnum weak"><span>上月结余</span><b>${esc(fmtFen(card.prev_balance_fen, state.lgHide))}</b></div>
    ${ratioBar('支出', card.expense_fen, card.expense_pct)}
    ${ratioBar('收入', card.income_fen, card.income_pct)}
  </div>`;

  // ---- ③ 支出类别：饼图 ＋ 表（类别 ｜ 占比 ｜ 金额）----
  const items = cats.map((c) => ({
    key: String(c.category_id == null ? 0 : c.category_id),
    name: String(c.name || '') || CAT_UNCLASSIFIED,
    fen: Number(c.amount_fen) || 0,
    color: catColorOf(c.category_id),
  }));
  const ring = donutArcs(items, DONUT_R);
  const box = (DONUT_R + DONUT_SW / 2) * 2;
  const mid = box / 2;
  const arcs = ring.arcs
    .map(
      (a) =>
        `<circle class="lg-arc" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke="${a.color}" stroke-width="${DONUT_SW}" stroke-dasharray="${a.len.toFixed(
          2,
        )} ${(ring.c - a.len).toFixed(2)}" stroke-dashoffset="${a.offset.toFixed(2)}" />`,
    )
    .join('');
  const catTable = cats.length
    ? cats
        .map(
          (c) => `<div class="lg-mdtrow">
        <i style="--lg-c:${catColorOf(c.category_id)}"></i>
        <span>${esc(String(c.name || '') || CAT_UNCLASSIFIED)}</span>
        <b>${esc(shareText(c))}</b>
        <b>${esc(fmtFen(c.amount_fen, state.lgHide))}</b>
      </div>`,
        )
        .join('')
    : '<div class="lg-wait">这个月还没有支出。</div>';
  const catHtml = `<div class="lg-card"><div class="lg-ccap"><b>支出类别</b></div>
    <div class="lg-donut"><div class="lg-ring">
      <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
        <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
        <g transform="rotate(-90 ${mid} ${mid})">${arcs}</g>
      </svg>
      <div class="lg-ring-mid"><i>支出</i><b>${esc(fmtFen(card.expense_fen, state.lgHide))}</b></div>
    </div></div>
    <div class="lg-mdtab">${catTable}</div></div>`;

  // ---- ④ 支出排行（前三：就是上面那张表的前三条，服务端已按金额降序）----
  const rankHtml = top.length
    ? `<div class="lg-card"><div class="lg-ccap"><b>支出排行</b></div>${top
        .map(
          (c, i) => `<div class="lg-mdrk">
        <span class="lg-mdrk-n">${i + 1}</span>
        <span class="lg-mdrk-m"><b>${esc(String(c.name || '') || CAT_UNCLASSIFIED)}</b>
          <span class="lg-mdrk-b"><span style="width:${Math.max(Number(c.pct) || 0, 0).toFixed(2)}%"></span></span></span>
        <b class="lg-mdrk-a">${esc(fmtFen(c.amount_fen, state.lgHide))}</b>
      </div>`,
        )
        .join('')}</div>`
    : '';

  // ---- ⑤ 支出趋势：三个数 ＋ 一条折线 ----
  const trendHtml = `<div class="lg-card"><div class="lg-ccap"><b>支出趋势</b></div>
    <div class="lg-mdnums">
      <div><span>单日支出最高</span><b>${esc(fmtFen(trend.max_day_fen, state.lgHide))}</b>
        <i>${esc(trend.max_day ? dayHeadLabel(String(trend.max_day)) : '—')}</i></div>
      <div><span>日均支出</span><b>${esc(fmtFen(trend.daily_avg_fen, state.lgHide))}</b><i></i></div>
      <div><span>本月支出</span><b>${esc(fmtFen(trend.total_fen, state.lgHide))}</b><i></i></div>
    </div>
    ${dayLineHtml(trend, month)}</div>`;

  // ---- ⑥ 月支出对比：柱状 ＋「对比上月变化前三的类别」（方向靠 ↑ / ↓，金额取绝对值）----
  const prevLabel = `${Number(shiftMonth(month, -1).slice(5, 7))}月`;
  const moverHtml = movers.length
    ? `<div class="lg-mdmovers"><b class="lg-mdmovers-t">${esc(
        `${Number(month.slice(5, 7))}月对比${prevLabel}变化前三的类别`,
      )}</b>${movers
        .map(
          (m, i) => `<div class="lg-mdrk">
        <span class="lg-mdrk-n">${i + 1}</span>
        <span class="lg-mdrk-m"><b>${esc(String(m.name || '') || CAT_UNCLASSIFIED)}</b>
          <i class="lg-mdrk-d">${Number(m.diff_fen) >= 0 ? '↑上升' : '↓下降'}</i></span>
        <b class="lg-mdrk-a">${esc(fmtFen(Math.abs(Number(m.diff_fen) || 0), state.lgHide))}</b>
      </div>`,
        )
        .join('')}</div>`
    : '';
  const expBarHtml = `<div class="lg-card"><div class="lg-ccap"><b>月支出对比</b></div>
    ${barChartHtml(months, 'expense_fen')}${moverHtml}</div>`;

  // ---- ⑦ 收入：总收入 ＋ 各来源占比 ----
  const incRows = incs.length
    ? incs
        .map(
          (c) => `<div class="lg-mdtrow">
        <i style="--lg-c:${catColorOf(c.category_id)}"></i>
        <span>${esc(String(c.name || '') || CAT_UNCLASSIFIED)}</span>
        <b>${esc(shareText(c))}</b>
        <b>${esc(fmtFen(c.amount_fen, state.lgHide))}</b>
      </div>`,
        )
        .join('')
    : '<div class="lg-wait">这个月还没有收入。</div>';
  const incHtml = `<div class="lg-card"><div class="lg-ccap"><b>收入</b></div>
    <div class="lg-mdnum"><span>总收入</span><b>${esc(fmtFen(card.income_fen, state.lgHide))}</b></div>
    <div class="lg-mdtab">${incRows}</div></div>`;

  // ---- ⑧ 月收入对比（柱状）----
  const incBarHtml = `<div class="lg-card"><div class="lg-ccap"><b>月收入对比</b></div>
    ${barChartHtml(months, 'income_fen')}</div>`;

  // ---- ⑨ 记账成就（⭐ 量的是「记账以来」，⛔ 不是本月）----
  const achHtml = `<div class="lg-card"><div class="lg-ccap"><b>记账成就</b></div>
    <div class="lg-mdach">
      <div><b>${Number(ach.streak_days) || 0}</b><span>天</span><i>已连续打卡</i></div>
      <div><b>${Number(ach.total_days) || 0}</b><span>天</span><i>记账总天数</i></div>
      <div><b>${Number(ach.total_count) || 0}</b><span>笔</span><i>记账总笔数</i></div>
    </div></div>`;

  return `<div class="lg-md">${head}${cardHtml}${catHtml}${rankHtml}${trendHtml}${expBarHtml}${incHtml}${incBarHtml}${achHtml}</div>`;
}

// ============================================================================
// ⭐⭐ 0.8.2 记账 3 期：**预算屏**（周 / 月 / 年 · 总预算 ＋ 分类预算）
//
// ⚠️ 本段三条纪律（与上面 ①②③ 三段同款 —— 错了都**不报错**，只是屏上的数悄悄不对）：
//   · ⭐ **一个金额都不在这里算**（2 期 §5.4「前端不算钱」）：已用 / 剩余 / 剩余 % / 超支
//     全是服务端 `ledgerBudgetView()` 算好、随 `GET /api/ledger/budget` **一屏**下来的
//     ⇒ 本段只做「取值 → 文案 → 排版」。
//   · 三档的**期间起点**（周 = 周一 / 月 = 1 号 / 年 = 1 月 1 日）只走 `calc.js` 的
//     `periodKeyOf()` —— ⛔ 不在本文件再写一份（同一个词只有一个意思）。
//   · 那个环**复用 1 期**那一份几何（`donutArcs()` ＋ `.lg-ring` / `.lg-arc` 那组类名）
//     —— ⛔ 不许长第二套图形实现（方案 §1.3）。
//   ⚠️⚠️ 三态（读取中 / 读不到 ＋ 重试 / 还没设预算）**必须分得开**：把「读不到」画成
//     「还没设预算」＝ 把错误藏起来（用户会以为自己没设过，于是又设一遍）。
// ============================================================================

/**
 * 本次「设 / 清一行预算」流程里的**目标**（`{type, key, cat}`，`null` = 没开过那一层）。
 *
 * 说明：⚠️ 它只活在**一次弹层流程**里（动作单 → 额度弹层 → 保存 / 清除），⛔ 不跨屏、不进 `state`
 *      —— 与 `draft` / `catAsk` 同款：开弹层时记下「这一期这一维度」，提交时照它发请求。
 *      住这里而不是 `state` 的理由同 `draft`：每次开弹层都会重建一份，没必要占 `state` 的位置。
 *      ⚠️ **弹层底下那三档点不到**（有遮罩）⇒ 记下的期就是提交时的期，⛔ 不必在提交那一刻重算
 *      （重算反而危险：万一同屏换过档，清掉的就是另一期）。
 * @type {?{type: string, key: string, cat: number}}
 */
let budTarget = null;

/**
 * 功能：预算屏当前那一档（`'week'` / `'month'` / `'year'`）。
 *
 * 说明：⚠️ 认不出一律回落 `'month'` —— ⭐ **它就是默认档**（方案附录 C 的 C-18：照图 4
 *      顶栏的选中态）。白名单走 `calc.js` 的 `PERIOD_TYPES`（⛔ 不在这里再抄一遍三档字面量）。
 * @returns {string} 三档之一
 * @since 0.8.2
 */
function budgetTabOf() {
  const k = String(state.lgBudgetTab || '');
  return PERIOD_TYPES.includes(k) ? k : 'month';
}

/**
 * 功能：预算屏当前这一期的 `period_key`（**该期起始日** `YYYY-MM-DD`）。
 *
 * 说明：⭐ 服务端要的就是「该期起始日」（周 = 周一、月 = 1 号、年 = 1 月 1 日，方案 §4.3 说明 2），
 *      折算是 `calc.js` 的 `periodKeyOf()`（判据只住那一处）。
 *      ⚠️⚠️ 里面的 `today` 必须是**服务端今天**（`overview.today`）——
 *      ⛔ 绝不传本机 `new Date()`：手机日期不可信，跨零点会把用户写进错的那一期。
 *      ⚠️ 取不到服务端今天 ⇒ 回空串 ⇒ 这一屏落进三态里的「读不到」（⛔ 不猜一个日期兜上去）。
 * @returns {string} `YYYY-MM-DD`（取不到服务端今天时为空串）
 * @since 0.8.2
 */
function budgetPeriodKey() {
  return String(state.lgBudgetKey || '') || periodKeyOf(budgetTabOf(), todayOf());
}

/**
 * 功能：总预算块那个标题（图 4 的 `09月总预算`、图 6 的 `2026年总预算`）。
 * @param {string} type - 三档之一
 * @param {string} key - 该期起始日 `YYYY-MM-DD`
 * @returns {string} 标题
 * @since 0.8.2
 */
function budgetTotalTitle(type, key) {
  const s = String(key || '');
  if (type === 'year') return `${s.slice(0, 4)}年总预算`;
  if (type === 'month') return `${s.slice(5, 7)}月总预算`;
  return `${periodLabelOf(type)}总预算`;
}

/**
 * 功能：某一个分类预算的名字（**与那一块行上写的是同一个来源**）。
 *
 * 说明：⚠️ 优先读服务端那一行给的名字（`state.lgBudget.categories[].name`）——
 *      分类被**硬删**过（`restore-builtin` 那条路）而预算行还在时名字是空串，
 *      那时回落到 `CAT_UNCLASSIFIED`（「未分类」这个词只住前端）。
 * @param {number} cat - 分类 id
 * @returns {string} 分类名
 * @since 0.8.2
 */
function budgetCatName(cat) {
  const list = (state.lgBudget && state.lgBudget.categories) || [];
  const row = list.find((c) => Number(c.category_id) === Number(cat));
  return String((row && row.name) || '') || CAT_UNCLASSIFIED;
}

/**
 * 功能：底部动作单上那两行写什么的主语（图 7 的 `编辑年度总预算` / `清除年度总预算`）。
 * @param {number} cat - `0` = 总预算；`> 0` = 分类预算
 * @param {string} type - 三档之一
 * @returns {string} 如 `本月总预算` / `餐饮预算`
 * @since 0.8.2
 */
function budgetTargetName(cat, type) {
  if (!Number(cat)) return `${periodLabelOf(type)}总预算`;
  return `${budgetCatName(cat)}预算`;
}

/**
 * 功能：一个预算块那个**环形**（环里写 `剩余 52%` / `已超支` / `未设`）。
 *
 * 说明：⭐⭐ 几何**复用 1 期**那一份（`donutArcs()` ＋ `.lg-ring` / `.lg-arc` 那组类名，
 *      方案 §1.3 明令不许长第二套）—— 这里只喂它两个「权重」：
 *      ① 已用、② 剩余（**负的夹到 0**：超支时环画满，那正是"这一期的额度用光了"）。
 *      ⚠️ 权重是**服务端给的两个数**（`used_fen` / `remain_fen`），本函数只把它们交给那份几何
 *      去按比值铺段 —— ⛔ 这里不做任何金额运算（2 期 §5.4）。
 *      ⚠️ 没设（`set=false`）或额度 = 0 ⇒ **一段都不画**（环里写着「未设」，画满就自相矛盾了）。
 * @param {?Object} block - 服务端给的那一块（`{amount_fen, used_fen, remain_fen, set, ...}`）
 * @returns {string} 这个环的 HTML
 * @since 0.8.2
 */
function budgetRingHtml(block) {
  const b = block || {};
  const amount = Number(b.amount_fen) || 0;
  const draw = !!b.set && amount > 0;
  const used = draw ? Math.abs(Number(b.used_fen) || 0) : 0;
  const remain = draw ? Math.max(Number(b.remain_fen) || 0, 0) : 0;
  const ring = donutArcs(
    [
      { key: 'u', fen: used },
      { key: 'r', fen: remain },
    ],
    DONUT_R,
  );
  const arc = ring.arcs.find((a) => a.key === 'u');
  const box = (DONUT_R + DONUT_SW / 2) * 2;
  const mid = box / 2;
  const seg = arc
    ? `<circle class="lg-arc lg-barc" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}"
      stroke-dasharray="${arc.len.toFixed(2)} ${(ring.c - arc.len).toFixed(2)}"
      stroke-dashoffset="${arc.offset.toFixed(2)}" />`
    : '';
  return `<div class="lg-ring lg-bring">
    <svg viewBox="0 0 ${box} ${box}" aria-hidden="true">
      <circle class="lg-arc-bg" cx="${mid}" cy="${mid}" r="${DONUT_R}" stroke-width="${DONUT_SW}" />
      ${seg ? `<g transform="rotate(-90 ${mid} ${mid})">${seg}</g>` : ''}
    </svg>
    <div class="lg-ring-mid"><b class="lg-brt">${esc(ringText(b))}</b></div>
  </div>`;
}

/**
 * 功能：预算块右侧那三行（`剩余预算` ＋ `预算` ＋ `支出`）。
 *
 * 说明：⚠️⭐ 三行的**数值**一律走 `calc.js` 的 `budgetBlockText(block, state.lgHide)` ——
 *      眼睛（`lgHide`）关掉时三串一起糊成圆点，⚡ 而且剩余**可以是负数**（超支照实显示，
 *      ⛔ 不取绝对值、⛔ 不夹到 0 —— 图 6 的 `-10045.00` 就是这么来的）。
 *      ⚠️ **两块的标签不一样**（照图 4 / 图 6）：总预算那块是「本月预算 / 本月支出」
 *      （随档变，`budgetLineLabels()`），分类那块只有「预算 / 支出」⇒ 由调用方把标签传进来。
 * @param {?Object} block - 服务端给的那一块
 * @param {{budget: string, used: string}} labels - 那两行的标签
 * @returns {string} 这三行的 HTML
 * @since 0.8.2
 */
function budgetLinesHtml(block, labels) {
  const t = budgetBlockText(block, state.lgHide);
  return `<div class="lg-blines">
    <div class="lg-bline big"><span>剩余预算</span><b>${esc(t.remain)}</b></div>
    <div class="lg-bline"><span>${esc(labels.budget)}</span><b>${esc(t.amount)}</b></div>
    <div class="lg-bline"><span>${esc(labels.used)}</span><b>${esc(t.used)}</b></div>
  </div>`;
}

/**
 * 功能：一块预算的骨架 —— 头（左边是谁 ＋ 右边「编辑」）＋ 环形 ＋ 右侧三行。
 *
 * 说明：⚠️⭐ 图元与总预算 / 分类预算**共用这一份**（图 4 里两块除了标签完全同构）——
 *      ⛔ 别给分类那块另写一套（两套必然漂移，而画面上没人看得出来）。
 * @param {?Object} block - 服务端给的那一块
 * @param {{budget: string, used: string}} labels - 那两行的标签
 * @param {number} cat - `0` = 总预算；`> 0` = 分类预算（`data-cat` 直接带上，编辑 / 清除都靠它）
 * @param {string} leftHtml - 头左边那一块（总预算 = 标题；分类 = 小图标 ＋ 名字）
 * @returns {string} 这一块的 HTML
 * @since 0.8.2
 */
function budgetBlockHtml(block, labels, cat, leftHtml) {
  return `<div class="lg-bhead">${leftHtml}
    <button class="lg-bedit" type="button" data-act="lg-budget-edit" data-mode="menu"
      data-cat="${Number(cat) || 0}">编辑</button>
  </div>
  <div class="lg-brow">${budgetRingHtml(block)}${budgetLinesHtml(block, labels)}</div>`;
}

/**
 * 功能：取一次预算屏一屏（`GET /api/ledger/budget`）并重画 —— **三档共用**（靠 `period_type` 分派）。
 *
 * 说明：⭐⭐ `period_key` 由前端按**服务端今天**折出来（`budgetPeriodKey()`）；⚠️ 它是**必填**
 *      （服务端 400 而不是替你猜），所以取不到服务端今天时这一屏就是**读不到**（三态里的 error），
 *      ⛔ 绝不拿本机日期兜一个上去。
 *      ⚠️ 进入这一屏（`openBudget()`）与换档（`lg-budget-tab`）都走它；失败**不抛**
 *      （画「读不到 ＋ 重试」）——⛔ 绝不画成「还没设预算」。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function loadBudget() {
  state.lgBudgetLoad = 'loading';
  state.lgBudgetErr = '';
  renderLedger();
  const type = budgetTabOf();
  const key = budgetPeriodKey();
  try {
    const r = await api(
      'GET',
      `/api/ledger/budget?period_type=${encodeURIComponent(type)}&period_key=${encodeURIComponent(key)}`,
    );
    state.lgBudget = (r && r.budget) || null;
    state.lgBudgetLoad = 'done';
  } catch (e) {
    state.lgBudget = null;
    state.lgBudgetLoad = 'error';
    state.lgBudgetErr = e.message;
  }
  renderLedger();
}

/**
 * 功能：进「预算」那一格 ⇒ 把这一期取回来（与进屏同一条路，`mountLedger()` / `lgSegPick()` 都走它）。
 *
 * 说明：⭐ 每次进这一格都重取（与服务端口径同源）：额度 / 已用都可能在别处被改过
 *      （另一个标签页、另一台设备），而这一屏摆的就是「这一期还剩多少」。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function openBudget() {
  await loadBudget();
}

/**
 * 功能：切预算屏那三档（`周预算 ｜ 月预算 ｜ 年预算`）。
 *
 * 说明：⚠️⭐ 换档 = 换**期** ⇒ `period_key` 一起复位（一律用**服务端今天**那一期，
 *      C-18 /，这一屏只编辑"当前这一期"）。
 *      ⚠️⭐ 点**已经在的那一档**时：数据在手（`done`）就什么都不做（别白跑一趟）；
 *      但**读不到时点了要能重来** —— 它同时是「读不到」那颗重试的落点
 *      （这一屏没有第二个进屏动作，`errBoxHtml()` 挂的就是这个键）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一档（`data-tab` = `week` / `month` / `year`）
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgBudgetTab(_act, n) {
  const k = String((n && n.dataset && n.dataset.tab) || '');
  if (!PERIOD_TYPES.includes(k)) return;
  const same = k === budgetTabOf();
  if (same && state.lgBudgetLoad === 'done') return;
  if (!same) state.lgBudgetKey = '';
  state.lgBudgetTab = k;
  await loadBudget();
}

/**
 * 功能：画**预算屏**（版式权威 = 参考图 4 / 6；⭐ 默认落「月预算」，C-18）。
 *
 * 说明：⭐⭐ 三块（§7.2 逐条）：
 *      ① **三档** `周预算 ｜ 月预算 ｜ 年预算`（默认月档）—— 顶部那一段控件；
 *      ② **总预算块**：标题（`09月总预算`）＋「编辑」＋ 环形 ＋ `剩余预算 / 本月预算 / 本月支出`；
 *      ③ **分类预算块**：小标题「分类预算」＋ 每类一块（图标 ＋ 名字 ＋「编辑」＋ 环形 ＋ 三行）
 *      ＋ 底部通栏 `＋ 添加分类预算`。
 *      ⚠️⭐ **超支态照图 6**：环里改写「已超支」（⛔ 不给百分比）、`剩余预算` 直接显示负数
 *      —— 这两条都由 `calc.js` 的 `ringText()` / `budgetBlockText()` 给，本函数不判。
 *      ⚠️⭐ **空态**（C-15）：一期里**总预算与分类预算都没设** ⇒ 画「还没设预算」＋
 *      「设置总预算」那颗引导（⛔ 不整块空白）；⚠️ 只要有一头设过就照常画两块
 *      （⛔ 别拿"总预算没设"当空态 —— 那会把用户已经设好的分类预算整块藏起来）。
 *      ⚠️ 读数一切正常的依据是 `total.set` / `categories[]` 与服务端那份 `budget`，
 *      ⛔ 本函数不看额度是不是 0（`0` 与「没设」是两件事，见 `budgetBlockShape()`）。
 * @returns {string} 这一屏的 HTML
 * @since 0.8.2
 */
function budgetScreenHtml() {
  const type = budgetTabOf();
  const tabs = PERIOD_TYPES.map((k) => {
    const label = k === 'week' ? '周预算' : k === 'year' ? '年预算' : '月预算';
    return `<button class="lg-btab${type === k ? ' on' : ''}" type="button" data-act="lg-budget-tab"
      data-tab="${k}" role="tab" aria-selected="${type === k}">${label}</button>`;
  }).join('');
  // ⭐ 0.8.22：三档行右侧那颗眼睛 —— 与账单屏同一条口径（见 `billScreenHtml()` 里那段说明）
  const bar = `<div class="lg-tabrow"><div class="lg-btabs" role="tablist">${tabs}</div>${eyeHtml()}</div>`;

  // ---- 三态之一：读不到（⛔ 绝不画成「还没设预算」）----
  if (state.lgBudgetLoad === 'error') {
    return `<div class="lg-budget">${bar}${errBoxHtml(
      '预算',
      state.lgBudgetErr,
      'lg-budget-tab',
      ` data-tab="${esc(type)}"`,
    )}</div>`;
  }
  // ---- 三态之二：读取中（与「还没设预算」是两件事）----
  if (state.lgBudgetLoad !== 'done' || !state.lgBudget) {
    return `<div class="lg-budget">${bar}<div class="lg-txwait">正在读取…</div></div>`;
  }

  const d = state.lgBudget;
  const total = d.total || {};
  const cats = Array.isArray(d.categories) ? d.categories : [];
  const key = String(d.period_key || '') || budgetPeriodKey();

  // ---- 三态之三：真的还没设过任何预算（两头都空）----
  if (!total.set && !cats.length) {
    return `<div class="lg-budget">${bar}
      <div class="empty slim"><div class="e-ico">🎯</div><h3>还没设预算</h3>
        <p>设一个总预算，或者先给几个分类各分一点。</p>
        <button class="btn primary" type="button" data-act="lg-budget-edit" data-mode="amount"
          data-cat="0" style="margin-top:12px">设置总预算</button></div></div>`;
  }

  const lb = budgetLineLabels(type);
  const totalCard = `<div class="lg-card">${budgetBlockHtml(
    total,
    lb,
    0,
    `<b class="lg-bttl">${esc(budgetTotalTitle(type, key))}</b>`,
  )}</div>`;
  const catBody = cats.length
    ? cats
        .map((c) => {
          const name = String(c.name || '') || CAT_UNCLASSIFIED;
          const ch = String(name).trim().slice(0, 1) || '·';
          const ico = `<span class="lg-eico" style="--lg-c:${catColorOf(c.category_id)}">${esc(ch)}</span>`;
          // ⚠️ 分类块那三行的标签是**素**的（图 4 / 图 6 都写 `预算` / `支出`，⛔ 不带「本月 / 年度」）
          return `<div class="lg-bblk">${budgetBlockHtml(
            c,
            { budget: '预算', used: '支出' },
            c.category_id,
            `<b class="lg-bttl">${ico}${esc(name)}</b>`,
          )}</div>`;
        })
        .join('')
    : '<div class="lg-wait">还没给哪个分类单独设额度。</div>';
  const catCard = `<div class="lg-card"><div class="lg-ccap"><b>分类预算</b></div>${catBody}</div>`;

  // ⭐⭐ 0.8.22（「移除独立的【添加分类预算】按键，在预算页的【+新建】图标
  //    为添加分类预算」）：底部那条通栏按钮（`.lg-badd`）**撤了** —— 主操作交给屏级那颗
  //    悬浮「＋」（`paintAssetsFab('budget')` 那一档）。⚠️ 与 0.8.21「资产」那条同款：
  //    悬浮钮旁边再压一条通栏按钮做同一件事，用户分不清该点哪个（`11` 记过）。
  return `<div class="lg-budget">${bar}${totalCard}${catCard}</div>`;
}

/**
 * 功能：底部**动作单**（图 7）—— `编辑XX预算` / `清除XX预算` / `取消`。
 *
 * 说明：⭐ 措辞里那句主语走 `budgetTargetName()`（总预算 = `本月总预算`、分类 = `<分类名>预算`）
 *      —— 与块头上那块写的是**同一个来源**，⛔ 不在这里另拼一份（两处各拼一次必然漂移）。
 *      ⚠️ 「清除」那一行是危险色（`.lg-bmi.danger`）：它删数据，样式上必须先声张。
 * @param {number} cat - `0` = 总预算；`> 0` = 分类预算
 * @returns {void}
 * @since 0.8.2
 */
function openBudgetMenu(cat) {
  const name = budgetTargetName(cat, budgetTabOf());
  const cid = Number(cat) || 0;
  openSheet(
    '编辑预算',
    `<div class="lg-bmenu">
      <button class="lg-bmi" type="button" data-act="lg-budget-edit" data-mode="amount"
        data-cat="${cid}">编辑${esc(name)}</button>
      <button class="lg-bmi danger" type="button" data-act="lg-budget-clear" data-cat="${cid}">清除${esc(
        name,
      )}</button>
    </div>`,
    '<button class="btn" type="button" data-act="sheet-close">取消</button>',
  );
}

/**
 * 功能：底部那颗「编辑XX预算」开的那张**额度输入弹层**（设 / 改额度）。
 *
 * 说明：⚠️⭐ `amount_fen` 提交时**必须是字符串**（`routes.js` 的 `parseFen()` 只收字符串：
 *      数字类型的 `8.7` 在解析成 double 那一刻就已经丢过精度了）⇒ 输入框的**原样串**
 *      直接交上去，⛔ 不在前端 `Number()` 一下再 `String()` 回来。
 *      ⚠️ 回填走 `fenToInput()`（**不带千分位**、不带符号 —— 输入框里带逗号的话，
 *      用户一改就可能把逗号留在里面 ⇒ 服务端 400，那是刻意的）。
 *      ⚠️ 弹层开着的时候底层那三档点不到（有遮罩）⇒ 这里记下的 `type` / `key`
 *      就是提交时的期，⛔ 不必在提交那一刻重算。
 * @param {number} cat - `0` = 总预算；`> 0` = 分类预算
 * @returns {void}
 * @since 0.8.2
 */
function openBudgetAmount(cat) {
  const type = budgetTabOf();
  const cid = Number(cat) || 0;
  budTarget = { type, key: budgetPeriodKey(), cat: cid };
  const row = cid
    ? ((state.lgBudget && state.lgBudget.categories) || []).find((c) => Number(c.category_id) === cid)
    : state.lgBudget && state.lgBudget.total;
  const cur = row && row.set ? fenToInput(row.amount_fen) : '';
  openSheet(
    `编辑${budgetTargetName(cid, type)}`,
    `<div class="lg-bset">
      <label class="fld"><span>额度</span>
        <input id="lg-bud-input" type="text" inputmode="decimal"
          value="${esc(cur)}" /></label>
      <div class="m-tip">填 0 就是这一期设成 0（与「没设过」是两回事）；改这一期只影响这一期，不回溯。</div>
    </div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-budget-set" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：点「编辑」那一颗（总预算 / 分类预算各一颗）—— ⚠️⭐ 它**不是**直接开输入框（图 7）。
 *
 * 说明：⭐ 两颗按钮两种下场，靠 `data-mode` 分（⛔ 不靠模块变量 —— 那会在重画 / 换档之后失同步）：
 *      `menu`（块头上那颗「编辑」）⇒ 先弹**动作单**；`amount`（动作单里的「编辑XX预算」）
 *      ⇒ 开**额度输入弹层**。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那颗（`data-mode` / `data-cat`）
 * @returns {void}
 * @since 0.8.2
 */
export function lgBudgetEdit(_act, n) {
  const mode = String((n && n.dataset && n.dataset.mode) || 'menu');
  const cat = Number((n && n.dataset && n.dataset.cat) || 0);
  if (mode === 'amount') {
    openBudgetAmount(cat);
    return;
  }
  openBudgetMenu(cat);
}

/**
 * 功能：`＋ 添加分类预算` ⇒ 开那张「先挑分类、再填额度」的弹层。
 *
 * 说明：⭐ 挑分类用的是**原生 `<select>` ＋ `<optgroup>`**（两级分类靠全角空格缩进）——
 *      服务端不收名字、只认 id，而原生选择器在手机上自带滚轮，比自己画一套更稳
 *      （⛔ 本期不为这一件事长第二套分类选择器）。
 *      ⚠️ 一个分类都没有（还没建过 / 分类没取到）时**不开这张弹层**：开了也无从选，
 *      而且提交上去会变成「设总预算」（`category_id` 落 0）—— 那是最坏的一种静默改错。
 * @returns {void}
 * @since 0.8.2
 */
export function lgBudgetAdd() {
  const groups = catTree(state.lgCats, '支出').length + catTree(state.lgCats, '收入').length;
  if (!groups) {
    toast('还没有收支分类，先去「设置」里建一个', true);
    return;
  }
  budTarget = { type: budgetTabOf(), key: budgetPeriodKey(), cat: 0 };
  openSheet(
    '添加分类预算',
    `<div class="lg-bset">
      <label class="fld"><span>分类</span>${budgetCatSelectHtml(0)}</label>
      <label class="fld"><span>额度</span>
        <input id="lg-bud-input" type="text" inputmode="decimal" value="" /></label>
      <div class="m-tip">给某一个分类单独设一份额度；它和总预算是各算各的，不互相扣。</div>
    </div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="lg-budget-set" style="flex:1.4">保存</button>`,
  );
}

/**
 * 功能：「添加分类预算」那张弹层里折一个两级分类的 `<select>`。
 *
 * 说明：⭐ 分类树只走 `entry-calc.js` 的 `catTree()`（⛔ 不在本文件再写一遍父子过滤）。
 *      ⚠️ 支出 / 收入**两组都给**：服务端对预算行不按收支方向设限
 *      （`resolveBudgetCategoryIdOf()` 只验「存在且是我的」）⇒ 前端也⛔ 不许自己加一条
 *      服务端没有的规矩。⚠️ `<option>` 的**取值一律是分类 id**，⛔ 别拿名字当值
 *      （同名不同级会被服务端判成"这个分类不存在"）。
 * @param {number} selected - 默认选中哪一个（`0` = 第一个）
 * @returns {string} 这个 `<select>` 的 HTML
 * @since 0.8.2
 */
function budgetCatSelectHtml(selected) {
  const one = (c, indent) =>
    `<option value="${Number(c.id)}"${Number(selected) === Number(c.id) ? ' selected' : ''}>${
      indent ? '　' : ''
    }${esc(String(c.name == null ? '' : c.name))}</option>`;
  const groups = [
    { label: '支出', rows: catTree(state.lgCats, '支出') },
    { label: '收入', rows: catTree(state.lgCats, '收入') },
  ].filter((g) => g.rows.length);
  const body = groups
    .map((g) => {
      const opts = g.rows
        .map((c) => one(c, false) + (c.kids || []).map((k) => one(k, true)).join(''))
        .join('');
      return `<optgroup label="${g.label}">${opts}</optgroup>`;
    })
    .join('');
  return `<select id="lg-bud-cat" aria-label="选择分类">${body}</select>`;
}

/**
 * 功能：额度弹层里那颗「保存」—— `PUT /api/ledger/budget`（设 / 改**一行**额度）。
 *
 * 说明：⭐⭐ 两条（都对得上服务端 `checkBudgetBody()` 的入参校验表）：
 *      · `amount_fen` 传**字符串原样**（`parseFen()` 只收字符串，见 `openBudgetAmount()` 的说明）；
 *      · `category_id` 也传字符串（`0` = 总预算哨兵；> 0 = 分类，服务端会验"存在且是我的"）。
 *      ⚠️⭐ **成功用响应里那一份 `budget` 直接重画**（服务端写完就把最新一屏给回来，
 *      照 `ledgerSetDefault` 一族）：界面上「编辑 → 设额度 → 回预算屏」因此**一个来回**就够。
 *      ⚠️ 弹层还开着时用户点了保存 ⇒ 只有拿到新数据才关弹层；失败**不关**
 *      （让用户接着改，⛔ 别把他填的数丢掉）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgBudgetSet() {
  const input = $('#lg-bud-input');
  if (!input) return;
  const value = String(input.value == null ? '' : input.value).trim();
  if (!value) {
    toast('填一下额度吧', true);
    input.focus();
    return;
  }
  const t = budTarget || { type: budgetTabOf(), key: budgetPeriodKey(), cat: 0 };
  const sel = $('#lg-bud-cat');
  const cat = sel ? Number(sel.value) || 0 : Number(t.cat) || 0;
  try {
    const r = await api('PUT', '/api/ledger/budget', {
      period_type: t.type,
      period_key: t.key,
      category_id: String(cat),
      amount_fen: value,
    });
    if (r && r.budget) state.lgBudget = r.budget;
    state.lgBudgetLoad = 'done';
    state.lgBudgetErr = '';
    closeSheet();
    budTarget = null;
    renderLedger();
    toast('额度已保存');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：真去清一行（`DELETE /api/ledger/budget`）—— 总预算 / 分类预算共用这一条。
 *
 * 说明：⭐⭐ `category_id = 0` 时**服务端连带清掉该期全部分类预算**（/ 图 9，
 *      一个事务：要么都成、要么一行都不删）⇒ 前端只要把 `category_id` 如实带上，
 *      ⛔ 别自己先删分类再删总预算（那是两笔请求、失败就留半截）。
 *      ⚠️ 幂等：本来就没有那一行也照样成功（服务端不把它当 404）。
 *      ⚠️ 成功用响应里那份 `budget` 重画（同 `lgBudgetSet`）。
 * @param {number} cat - `0` = 总预算；`> 0` = 分类预算
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function budgetClearGo(cat) {
  const t = budTarget || { type: budgetTabOf(), key: budgetPeriodKey(), cat: Number(cat) || 0 };
  const q =
    `period_type=${encodeURIComponent(t.type)}&period_key=${encodeURIComponent(t.key)}` +
    `&category_id=${encodeURIComponent(String(Number(cat) || 0))}`;
  try {
    const r = await api('DELETE', `/api/ledger/budget?${q}`);
    if (r && r.budget) state.lgBudget = r.budget;
    state.lgBudgetLoad = 'done';
    state.lgBudgetErr = '';
    closeSheet();
    budTarget = null;
    renderLedger();
    toast('清掉了');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：动作单里那颗「清除XX预算」。
 *
 * 说明：⭐⭐ 两条口径（图 9 /）：
 *      · **清除总预算** ⇒ 先弹一道「**警告**」二次确认（正文逐字是
 *        「清除总预算将同时为您清除所有分类预算」）—— 它连带清掉那一期**全部**分类预算，
 *        是不可逆的一步；确认那颗是**红色**（危险色）。
 *      · 清除**某个分类**预算 ⇒ 动作单本身就是那一步确认（一行一次点按），直接删。
 *      ⚠️ 确认层的「确定」挂的是 `lg-budget-clearok`（不是共用的 `cf-yes`）——
 *      这一句文案只对这一件事成立，⛔ 别拿通用确认层凑（它没人知道自己在确认什么）。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一行（`data-cat`）
 * @returns {Promise.<void>|void}
 * @since 0.8.2
 */
export function lgBudgetClear(_act, n) {
  const cat = Number((n && n.dataset && n.dataset.cat) || 0);
  budTarget = { type: budgetTabOf(), key: budgetPeriodKey(), cat };
  if (cat) return budgetClearGo(cat);
  openSheet(
    '警告',
    '<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">清除总预算将同时为您清除所有分类预算</p>',
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="lg-budget-clearok" style="flex:1.4">确定</button>`,
  );
  return undefined;
}

/** 功能：「警告」里那颗「确定」⇒ 真去清总预算（连带该期全部分类预算）。 @returns {Promise.<void>} @since 0.8.2 */
export async function lgBudgetClearok() {
  await budgetClearGo(0);
}

// ============================================================================
// ⭐⭐ 0.8.2 记账 · 三方导入（鲨鱼记账）——）
//    · 入口：**记账设置**那一屏里新加的一块「导入三方数据」（§6.1）；
//    · 向导：选文件 → 上传预览 → 预览层（取消 / 确认导入）→ 结果（§6.2）；
//    · 明细屏：自有流水与导入行**按天混排**、只读（§6.3，`entryGroupsHtml()` 那边）；
//    · 整批清除：二次确认后 `DELETE`（§6.4）。
//
//    ⭐ 契约：
//      GET    /api/ledger/import?source=shark           → { summary }（概况；`count=0` = 还没导入过）
//      POST   /api/ledger/import/preview?source=shark   → { draft }（请求体是**文件原始字节**；**不写库**）
//      POST   /api/ledger/import/commit?source=shark    → { result }（**同一个文件再发一次**）
//      DELETE /api/ledger/import?source=shark           → { deleted }（整批清除）
//    ⚠️⭐ 预览是 `POST` 且**不写库**；确认是**把同一个文件再发一次**（⛔ 不是把草稿发回去）。
//    ⚠️ 错误：未登录 401（走既有口径跳登录页）、`source` 不是 shark 400、超 2MB 413、
//    解析失败 400（`error` 是一句人话，**直接显示给用户**）。
//
//    ⛔ **零出网**：这一段只往**自己的服务端**发请求 —— ⛔ 不取图标、⛔ 不接 AI。
//    ⛔ **前端不算钱**：金额 / 合计 / 小计一律由服务端给（2 期 §5.4）——
//    这一段只做「取值 → `fmtFen` / `fmtSignedFen` → 排版」，⛔ 一个加减都没有。
//    ⚠️ 临时态（选到哪个文件 / 预览草稿）住**模块级变量**（照 `draft` 那一套先例）——
//    `public/mobile/state.js` **不在本次改动范围内**，所以连概况（`lgImp` / `lgImpLoad` / `lgImpErr`）
//    也一并住这里（方案 §6.5 原意是住 `state`，受文件边界所限降级到模块级 —— 见交付报告「待决」）。
// ============================================================================

/** 三方来源的 `source` 值（本期只适配鲨鱼）—— ⛔ 它不是文件名、也⛔ 不受理请求体带来的值。 @type {string} */
const IMP_SOURCE = 'shark';

/**
 * 设置屏那一行显示的名字（⚠️ 与 `lib/import-sources.js` 注册表里的 `label` 同一个词）。
 *
 * 说明：⚠️ 它是**前端自己的常量**，不是从服务端读的 —— 概况那一次请求可能失败
 *      （那时手上一个 `source_label` 都没有），而「鲨鱼记账」这一行**照样得画出来**
 *      （⛔ 不能因为读不到概况就把入口也藏了）。⚠️ 加一家只加一行 ＋ 一个常量。
 * @type {string}
 */
const IMP_LABEL = '鲨鱼记账';

/**
 * 「导入三方数据」那块的正文明细（给的定稿文案）。
 *
 * ⚠️⭐ 与旧文案的三处**实质变化**（改字之前先看这里）：
 *   · 不再写「不进分类预算」—— 0.8.4 起它**进**分类预算（同名的计入，见 `ledgerBudgetView`）；
 *   · 不再写「不进个人备份」—— 0.8.4 起它**进**个人备份（换机之后不用再导一次）；
 *   · 补一句「目前已经适配：鲨鱼记账」—— 来源现在是注册表（以后会多几家），界面上要说得出来。
 *   ⇒ ⛔ 别把这几句改回去：文案里写着的承诺与代码的行为**必须一致**，否则用户按文案理解就错了。
 * @type {string}
 */
const IMP_HELP =
  '导入三方记账数据，不关联账户，数据独立存储，自动过滤重复数据。目前已经适配：鲨鱼记账。';

/**
 * 导入概况（`GET /api/ledger/import` 的 `summary`；`null` = 还没取到）。 @type {?Object}
 */
let impSummary = null;

/** 概况的四态：`idle`（还没取）| `loading` | `done` | `error`。⚠️ `error` ⛔ 绝不许画成「还没导入过」。 @type {string} */
let impLoad = 'idle';

/** 概况读不到时的原因（用户能看的那句话）。 @type {string} */
let impErr = '';

/** 用户选中的那个文件（`File`）—— 只活在这次向导里。 @type {?File} */
let impFile = null;

/** 预览草稿（`POST …/import/preview` 的 `draft`）。⚠️ 确认时**不用它**（那一下是把同一个文件再发一次）。 @type {?Object} */
let impDraft = null;

/** 正在上传预览 / 正在确认导入（防重复点、防重复发）。 @type {boolean} */
let impBusy = false;

/**
 * 明细屏当前那个月**全部**导入行（服务端一次给全，**不分页**）。
 *
 * 说明：⚠️⚠️ 它**独立于** `state.lgEntries`（自有流水那一份分页缓存）——「加载更多」只往后翻
 *      `entries`，这一份每次响应**整份替换**（⛔ 绝不 `concat`）：拼进 `entries` 再随翻页重画
 *      就会把导入行画第二遍，而它**不报错**。
 * @type {Array.<Object>}
 */
let impRows = [];

/** 向导弹层里那条 `change` 委托只挂一次（`#sheet-body` 是常驻节点，每次重挂会一次选择跑两遍）。 @type {boolean} */
let impSheetBound = false;

/**
 * 功能：往**自己的服务端**发一次「原始字节体」的 POST（⛔ 不是 JSON）。
 *
 * 说明：⭐⭐ `core/api.js` 的 `api()` 只会 `JSON.stringify` 一个 body ⇒ 上传文件那条路走不了它，
 *      只能自己 `fetch`（照课表导入 `desktop-import.js` / `timetable/mobile.js` 那一套）。
 *      于是那两件本来由 `api()` 兜住的事得在这里补回来，且**只写一次**：
 *      · **401 ⇒ 回登录页**（`backToLogin()`）：会话可能在这一次上传上失效，不接的话用户
 *        只会看到「HTTP 401」卡在原地，而他唯一的出路（重新登录）恰好是他看不到的那一页；
 *      · **非 2xx ⇒ 抛出服务端那句人话**（`error` 字段；解析失败那一条就是给用户看的）。
 *      ⚠️ 超时**不在这里另设**：这一段是局域网上传一个小文件，`api()` 那条 15 秒上界
 *      （决策：防"永远悬着"）在这里同样够用 —— 但 `fetch` 没带上界，所以这里也**不设**
 *      （⛔ 不新造第二套超时口径）。
 * @param {string} path - 应用内绝对路径（前缀由 `BASE` 补）
 * @param {File|Blob} file - 文件内容（原样发）
 * @returns {Promise.<?Object>} 响应 JSON（不是 JSON 时为 null）
 * @throws {Error} 401 或非 2xx（错误对象上带 `status`）
 * @since 0.8.2
 */
async function postRaw(path, file) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await res.json().catch(() => null);
  if (res.status === 401) {
    backToLogin();
    const e401 = new Error('登录已过期，正在回到登录页…');
    e401.status = 401;
    throw e401;
  }
  if (!res.ok) {
    const err = new Error((j && j.error) || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return j;
}

/**
 * 功能：取一次导入概况（`GET /api/ledger/import?source=shark`）并重画这一屏。
 *
 * 说明：⚠️ 三态**分得开**：`loading` / `error`（读不到 ＋ 重试）/ `done`。
 *      ⚠️⭐ 「读不到」⛔ **绝不许画成「还没导入过」** —— 那是把错误藏起来
 *      （用户会以为"我确实没导过"，然后再导一次）。`count === 0` 才是「还没导入过」。
 *      ⚠️ 失败**不抛**（由界面画错误块 ＋ 一颗重试）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function loadImportSummary() {
  impLoad = 'loading';
  impErr = '';
  try {
    const r = await api('GET', `/api/ledger/import?source=${IMP_SOURCE}`);
    impSummary = (r && r.summary) || null;
    impLoad = 'done';
  } catch (e) {
    impLoad = 'error';
    impErr = e.message;
  }
  renderLedger();
}

/** 功能：概况那块「读不到」时那颗重试（只重取概况，⛔ 不整页刷新）。 @returns {Promise.<void>} @since 0.8.2 */
export async function lgImpRetry() {
  await loadImportSummary();
}

/**
 * 功能：画设置屏那一块「导入三方数据」的**下一行**（概况那三态）。
 *
 * 说明：⭐ 只有 `count > 0` 才画「已导入 N 笔（跨度）＋ [清除]」这一行；`count === 0` 画
 *      「还没导入过」（**不是**错误）；读不到画一句人话 ＋ 一颗重试（⛔ 与「还没导入过」分开）。
 *      ⚠️ 跨度那一段只在**两端日期都拿到**时才画（缺一个就只报笔数，⛔ 不拼出「~ 空」那种）。
 * @returns {string} 这一行的 HTML
 * @since 0.8.2
 */
function impSummaryHtml() {
  if (impLoad === 'idle' || impLoad === 'loading') {
    return '<div class="lg-imp-sum"><span class="lg-impnote">正在读取导入概况…</span></div>';
  }
  if (impLoad === 'error') {
    return `<div class="lg-imp-sum"><span class="lg-impnote err">导入概况没读到：${esc(
      impErr || '原因不明',
    )}</span>
      <button class="lg-impbtn" type="button" data-act="lg-imp-retry">重试</button></div>`;
  }
  const s = impSummary || {};
  const n = Number(s.count) || 0;
  if (!n) return '<div class="lg-imp-sum"><span class="lg-impnote">还没导入过</span></div>';
  const from = String(s.from || '');
  const to = String(s.to || '');
  const span = from && to ? `（${from} ~ ${to}）` : '';
  return `<div class="lg-imp-sum"><span class="lg-impnote">${esc(`已导入 ${n} 笔${span}`)}</span>
    <button class="lg-impbtn danger" type="button" data-act="lg-imp-clear">清除</button></div>`;
}

/**
 * 功能：画一条**导入行**（明细屏里那些三方数据）。
 *
 * 说明：⭐⭐ 三条口径：
 *      · **只读**：整行挂了 `data-act="lg-imp-item"` ⇒ 点开是**只读详情**，⛔ 没有编辑 / 删除；
 *      · **一眼分得出**（`.lg-erow.imp` ＋ 灰底的来源小徽标 ＋ 一颗 `source_label` 小标签）：
 *        行样式与自有流水明显不同，但用的是**同一套设计令牌**（色值全走 CSS 变量）；
 *      · 金额走 `fmtSignedFen(signedFen(ie, fen), lgHide)` —— ⚠️ 导入行的金额字段叫 `fen`
 *        （服务端给的整数分），**不是** `amount_fen`；方向由**原文** `ie`（`支出` / `收入`）定，
 *        `signedFen()` 那一处是唯一判据。
 *      ⚠️ 分类那格显示**原文类别**（⛔ 不映射到我们的分类），空 ⇒ `未分类`。
 * @param {Object} r - 一条导入行（`{id, source_label, at, ie, fen, date_raw, category, account, amount_raw, note}`）
 * @returns {string} 这一行的 HTML
 * @since 0.8.2
 */
function impRowHtml(r) {
  const src = String((r && r.source_label) || '').trim() || IMP_LABEL;
  const cat = String((r && r.category) || '').trim() || '未分类';
  const note = String((r && r.note) || '').trim();
  // ⚠️ 分类图标那一格（自有流水画的是"色块 ＋ 分类首字"）在这里放**来源小徽标**：
  //    导入行没有我们的 `category_id`，画一个分类色块只会让人以为它与某个分类有关。
  const ico = `<span class="lg-imp-badge" aria-hidden="true">${esc(src.slice(0, 1) || '·')}</span>`;
  const parts = [`<span class="lg-imp-tag">${esc(src)}</span>`];
  if (note) parts.push(esc(note));
  return `<div class="lg-erow imp" data-act="lg-imp-item" data-id="${Number((r && r.id) || 0)}">
    ${ico}
    <span class="lg-emain"><b class="lg-etitle">${esc(cat)}</b>
      <i class="lg-sub">${parts.join(' · ')}</i></span>
    <b class="lg-eamt">${esc(fmtSignedFen(signedFen(r && r.ie, r && r.fen), state.lgHide))}</b>
  </div>`;
}

/**
 * 功能：点一条导入行 ⇒ 开**只读详情**弹层。
 *
 * 说明：⭐⭐ **只读**：六列原样 ＋ 来源 ＋ 一句「三方导入的数据不能改，要撤就整批清除」。
 *      ⛔ **不许给编辑 / 删除按钮** —— 只读；撤走的路是设置里那条**整批清除**。
 *      ⚠️ 从**手上这份** `impRows` 里找（与 `entryOf()` 同一条手法）：找不到（刚换过月 / 别处清过）
 *      就什么都不做，⛔ 别开一张空弹层。
 * @param {string} _act - 动作名（未用）
 * @param {HTMLElement} n - 点中的那一行（`data-id` = 导入行 id）
 * @returns {void}
 * @since 0.8.2
 */
export function lgImpItem(_act, n) {
  const id = Number((n && n.dataset && n.dataset.id) || 0);
  const r = impRows.find((x) => Number(x && x.id) === id);
  if (!r) return;
  const row = (k, v) => `<div class="lg-drow"><span>${k}</span><b>${esc(v)}</b></div>`;
  openSheet(
    '这笔账（只读）',
    `<div class="lg-ed">
      <div class="lg-edcap2">三方导入的数据不能改，要撤就整批清除。</div>
      <div class="lg-det">
        ${row('日期', String(r.date_raw || ''))}
        ${row('收支', String(r.ie || ''))}
        ${row('类别', String(r.category || '') || '未分类')}
        ${row('账户', String(r.account || '') || '（没填）')}
        ${row('金额', String(r.amount_raw || ''))}
        ${row('备注', String(r.note || '') || '（没填）')}
        ${row('计入日', String(r.at || ''))}
        ${row('来源', String(r.source_label || '') || IMP_LABEL)}
      </div>
    </div>`,
    '<button class="btn" type="button" data-act="sheet-close">关闭</button>',
  );
}

/**
 * 功能：进**导入向导**第 1 步 —— 选文件那张弹层。
 *
 * 说明：⭐ 文件选择走**原生 `<input type="file">`** 的 `change`（⛔ 不是 `data-act`）——
 *      原生控件被藏在 `.fld` 里（`app.css` 那条 `.fld input[type='file']`），用户点的是
 *      我们自己画的那块（`.lg-imp-pick`，`<label for>` 等同于点 input）。
 *      ⚠️ `accept=".csv,text/csv"` 只是给系统对话框一个提示，⛔ 它不是判据（判据在服务端）。
 * @returns {void}
 * @since 0.8.2
 */
function openImportSheet() {
  openSheet(
    '导入三方数据',
    `<div class="lg-ed">
      <div class="lg-edcap2">选 ${esc(IMP_LABEL)}导出的 CSV（六列：日期 / 收支类型 / 类别 / 账户 / 金额 / 备注），原样存、只读。</div>
      <div class="fld"><span>文件</span>
        <label class="lg-imp-pick" for="lg-imp-file">
          <span class="lg-imp-pick-btn">选择文件</span>
          <span class="lg-imp-pick-name" id="lg-imp-name">未选择任何文件</span>
        </label>
        <input id="lg-imp-file" type="file" accept=".csv,text/csv" />
      </div>
      <div class="m-tip">文件最大 2MB；选完就上传预览（预览不写库，确认之后才真写入）。</div>
    </div>`,
    '<button class="btn" type="button" data-act="lg-imp-cancel">取消</button>',
  );
  bindImportSheetOnce();
}

/**
 * 功能：绑向导弹层里那条 `change`（选到文件 ⇒ 存下它、更新文件名、立刻上传预览）。
 *
 * 说明：⭐⭐ 挂的是 `#sheet-body`（常驻节点，弹层每次只换它的 `innerHTML`）——
 *      且**只挂一次**（`impSheetBound`）：挂重了的表现是"选一次文件、预览发两遍"
 *      （与 `bindLedgerOnce()` 里那条一模一样的坑，而且它**不报错**）。
 *      ⚠️ 这里判的是 `t.id === 'lg-imp-file'`（弹层是共用的，别把别的弹层的 change 也吞了）。
 * @returns {void}
 * @since 0.8.2
 */
function bindImportSheetOnce() {
  if (impSheetBound) return;
  const body = $('#sheet-body');
  if (!body) return;
  impSheetBound = true;
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.id !== 'lg-imp-file') return;
    const f = (t.files && t.files[0]) || null;
    if (!f) return;
    impFile = f;
    const nameEl = $('#lg-imp-name');
    if (nameEl) {
      nameEl.textContent = String(f.name || '');
      nameEl.classList.add('has-file');
    }
    impPreview();
  });
}

/**
 * 功能：设置屏那颗「[导入]」—— 开导入向导（并把这一次向导的临时态清干净）。
 * @returns {void}
 * @since 0.8.2
 */
export function lgImpOpen() {
  impFile = null;
  impDraft = null;
  impBusy = false;
  openImportSheet();
}

/**
 * 功能：把选好的文件发去**预览**（`POST …/import/preview`，⛔ 不写库）并弹预览层。
 *
 * 说明：⚠️ 失败**不关**这张选文件的弹层：重开一次（文件格清空），用户顺手再选一个
 *      —— 报错只由 `toast` 说一句（服务端那句人话，解析失败时它点得出哪一列 / 哪一行）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
async function impPreview() {
  if (!impFile || impBusy) return;
  impBusy = true;
  try {
    const r = await postRaw(`/api/ledger/import/preview?source=${IMP_SOURCE}`, impFile);
    impDraft = (r && r.draft) || null;
    openImportPreview();
  } catch (e) {
    // ⚠️ 401 那条路已经由 `postRaw()` 带走了（回登录页），这里只对真正的失败说话
    if (!(e && e.status === 401)) toast(e.message, true);
    impFile = null;
    impDraft = null;
    openImportSheet();
  } finally {
    impBusy = false;
  }
}

/**
 * 功能：画**预览层**—— 认得出 N 笔（跨度）/ 将写入 M / 跳过 K /
 *      认不出 J（仅当有）/ 按月小计一张小表 ＋ 两颗按钮。
 *
 * 说明：⭐⭐ 两颗按钮 `取消` ｜ `确认导入`，⚠️ **默认焦点不在「确认导入」那颗** ——
 *      这里刻意**什么都不 `focus()`**（谁也不自动抢焦点），也不给任何一颗 `autofocus`。
 *      ⚠️ 按月小表里的金额一样走 `fmtFen(x, state.lgHide)`（眼睛盖住时它也一起糊掉，
 *      否则"屏上还剩一个数没糊"）；⛔ 前端不加、不乘、不算占比。
 *      ⚠️ 「认不出 J」那行只在 `failed > 0` 时才画（0 笔是常态，画出来只是噪音）。
 * @returns {void}
 * @since 0.8.2
 */
function openImportPreview() {
  const d = impDraft || {};
  const parsed = Number(d.parsed) || 0;
  const insert = Number(d.insert) || 0;
  const skip = Number(d.skip) || 0;
  const failed = Number(d.failed) || 0;
  const from = String(d.from || '');
  const to = String(d.to || '');
  const span = from && to ? `（跨度 ${from} ~ ${to}）` : '';
  const months = Array.isArray(d.months) ? d.months : [];
  const rows = months.length
    ? months
        .map((m) => {
          const inc = Number(m.income_fen) || 0;
          const exp = Number(m.expense_fen) || 0;
          return `<div class="lg-imp-mrow"><span class="lg-imp-mk">${esc(
            monthLabel(String((m && m.month) || '')),
          )}</span>
            <span class="lg-imp-mv">收入 ${esc(fmtFen(inc, state.lgHide))}</span>
            <span class="lg-imp-mv">支出 ${esc(fmtFen(exp, state.lgHide))}</span>
            <span class="lg-imp-mc">${Number((m && m.count) || 0)} 笔</span></div>`;
        })
        .join('')
    : '<div class="lg-txwait">这份文件里没有按月的小计。</div>';
  openSheet(
    '预览 · 导入三方数据',
    `<div class="lg-ed">
      <div class="lg-impcap">认得出 <b>${parsed}</b> 笔${esc(span)}</div>
      <div class="lg-impkv">将写入 <b>${insert}</b> 笔</div>
      <div class="lg-impkv">跳过 <b>${skip}</b> 笔</div>
      ${failed ? `<div class="lg-impkv warn">认不出 <b>${failed}</b> 笔（已原样保存、不进统计）</div>` : ''}
      <div class="lg-edcap2">按月小计</div>
      <div class="lg-imp-months">${rows}</div>
      <div class="m-tip">确认之后才真写进库；同一个文件再导一次不会重复写。</div>
    </div>`,
    `<button class="btn" type="button" data-act="lg-imp-cancel">取消</button>
     <button class="btn primary" type="button" data-act="lg-imp-go" style="flex:1.4">确认导入</button>`,
  );
}

/**
 * 功能：预览层那颗「确认导入」⇒ **把同一个文件再发一次**（`POST …/import/commit`）。
 *
 * 说明：⭐⭐ 三条：
 *      · ⛔ **不是把草稿发回去**（方案 §5：确认＝同一个文件再发一次）—— `impDraft` 只用于预览的排版；
 *      · 成功之后把明细屏那份缓存**作废**（`impRows` 清空 ＋ `lgLoad` 回 `idle`）：
 *        导入行变了、合计也变了，切回「明细」必须**重取**（⛔ 别让它画上一次那一份）；
 *      · 结果用**一句话 ＋ 一颗「去明细看看」**收尾（§6.2 第 4 步），并顺手刷新设置屏那块概况。
 *      ⚠️ 失败**不关**预览层（用户还能再点一次），只弹服务端那句人话。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgImpGo() {
  if (!impFile || impBusy) return;
  impBusy = true;
  try {
    const r = await postRaw(`/api/ledger/import/commit?source=${IMP_SOURCE}`, impFile);
    const g = (r && r.result) || {};
    const ins = Number(g.inserted) || 0;
    const skp = Number(g.skipped) || 0;
    impFile = null;
    impDraft = null;
    // ⚠️ 明细屏那份缓存作废：⛔ 不清的话切回「明细」还画着导入前那一份（而且它不报错）。
    impRows = [];
    state.lgLoad = 'idle';
    openSheet(
      '导入完成',
      `<div class="lg-ed">
        <div class="lg-impcap">写入 <b>${ins}</b> 笔，跳过 <b>${skp}</b> 笔。</div>
        <div class="m-tip">这些账是只读的，列在「明细」里按天与自有流水混排。</div>
      </div>`,
      `<button class="btn" type="button" data-act="sheet-close">关闭</button>
       <button class="btn primary" type="button" data-act="lg-imp-godetail" style="flex:1.4">去明细看看</button>`,
    );
    await loadImportSummary();
  } catch (e) {
    if (!(e && e.status === 401)) toast(e.message, true);
  } finally {
    impBusy = false;
  }
}

/**
 * 功能：结果页那颗「去明细看看」⇒ 切到「明细」那一格并**重取**。
 *
 * 说明：⚠️ 不能只改 `state.lgSeg` 就重画：流水 / 合计 / 导入行都变了（刚导进来的那些
 *      根本不在手上），必须 `loadEntries(true)` 从第一页重取 —— 与 `mountLedger()`
 *      进明细那一格走的是**同一条路**。
 *      ⚠️ 顺手把「月详情页」那个子屏状态清掉（同 `lgSegPick()`）：不清的话画出来的
 *      会是上一次那张月详情页（⛔ 而且不报错）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgImpGoDetail() {
  closeSheet();
  state.lgSeg = 'detail';
  state.lgMdMonth = 0;
  await loadEntries(true);
}

/**
 * 功能：向导里那颗「取消」⇒ 关弹层并把这一次向导的临时态清干净。
 * @returns {void}
 * @since 0.8.2
 */
export function lgImpCancel() {
  impFile = null;
  impDraft = null;
  impBusy = false;
  closeSheet();
}

/**
 * 功能：设置里那颗「[清除]」⇒ 先弹一道**「警告」二次确认**。
 *
 * 说明：⚠️ 正文逐字是「将删除全部 N 笔鲨鱼记账导入的数据，且不可恢复」，确认那颗是**红色**。
 *      ⚠️ 确认层的「确定」挂的是 `lg-imp-clearok`（⛔ 不是共用的 `cf-yes`）—— 与预算那条
 *      「清除总预算」同一条理由：这一句文案只对这一件事成立，别拿通用确认层凑。
 * @returns {void}
 * @since 0.8.2
 */
export function lgImpClear() {
  const n = impSummary ? Number(impSummary.count) || 0 : 0;
  openSheet(
    '警告',
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">将删除全部 ${n} 笔${esc(
      IMP_LABEL,
    )}导入的数据，且不可恢复</p>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn danger" type="button" data-act="lg-imp-clearok" style="flex:1.4">确定</button>`,
  );
}

/**
 * 功能：「警告」里那颗「确定」⇒ 真去整批清除（`DELETE /api/ledger/import?source=shark`）。
 *
 * 说明：⭐⭐ 成功后两件事：
 *      · 刷新设置屏那块概况（`loadImportSummary()`）—— 笔数归零、那行变回「还没导入过」；
 *      · 把明细屏那份缓存**作废**（`impRows` 清空 ＋ `lgLoad` 回 `idle`）＋ 清掉两组合计，
 *        切回「明细」时重取（⛔ 不清的话它还会画着刚被删掉的那些行）。
 *      ⚠️ 清除是**整批**（服务端回 `deleted`），⛔ 没有"删一条"这条路（只读）。
 * @returns {Promise.<void>}
 * @since 0.8.2
 */
export async function lgImpClearok() {
  try {
    const r = await api('DELETE', `/api/ledger/import?source=${IMP_SOURCE}`);
    const deleted = Number(r && r.deleted) || 0;
    closeSheet();
    impRows = [];
    state.lgSum = null;
    state.lgDayTotals = null;
    state.lgLoad = 'idle';
    await loadImportSummary();
    toast(`清掉了 ${deleted} 笔`);
  } catch (e) {
    toast(e.message, true);
  }
}

