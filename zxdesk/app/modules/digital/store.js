'use strict';
/**
 * modules/hardware/store.js —— NAS硬件管理业务方法（0.3.1）
 *
 * 功能：硬件台账 / 愿望单的业务方法 —— `listHardware`（多词 AND 检索 + 状态 / 分类筛选 + 只看需关注
 *      + **逐条挂上寿命口径** + **排序** + 汇总）/ `getHardware` / `ownsHardware` / `createHardware` /
 *      `updateHardware` / `removeHardware`，以及供路由层复用的归属校验 `_assertHardwareOwned`。
 *
 * ⚠️ **方法名一律带模块前缀，绝不用 `list` / `get` 这种通用名**：`store/index.js` 是用
 *    `Object.assign(Store.prototype, …)` 把六个业务模块平铺到**同一个原型**上的 ——
 *    两个模块各写一个 `list()`，后来者会**静默覆盖**前者（`Object.assign` 不报错），
 *    表现是「收藏夹页打不开了」而代码看着毫无问题。这个坑在 0.3.1 落地时**真的踩到过一次**
 *    （硬件模块的 `list` 盖掉了收藏夹的 `list`），由 `ttt/test/bookmarks.test.js` 当场抓住。
 *    与 `modules/tasks/lib/projects.js` 的 `listProjects` / `listProjectTasks` 是同一条规矩。
 *    ⚠️ **0.5.0起这条规矩由装配期护栏机械兜住**（`store/index.js` 的 `assertNoMethodClash()`）——
 *    搬进模块目录之后「谁覆盖谁」不再只靠人眼，撞名一律启动即抛。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⭐ **检索、筛选与寿命推算都只在文件里实现一份**：两个后端只提供「把该账号的行全取回来」
 *    这一条原语，匹配与计算全在上层做 —— 这样「装的是 SQLite 还是 JSON 回退，结果就不一样」
 *    这种漂移**在结构上不可能发生**（与收藏夹的检索同一条理由）。
 *    ⚠️ 预警**不从索引走**：库里根本没有「到期日」这一列，它是算出来的（方案 §4.1 取舍 3）。
 *
 * ⭐ **只看需关注（`focus = 'alert'`）只统计「在用」的件**：退役件不参与预警计数
 *    （方案 §五）——「这台已经拆下来的旧盘快到期了」不是一件要人现在处理的事。
 *    愿望单天然没有购买日期 ⇒ 寿命算不出 ⇒ 也不会进预警。
 *
 * ⭐ 排序（0.4.4 起）与检索、寿命推算一样**只在这里实现一份**：两个后端只回「该账号的全部行」，
 *    排序在上层做 —— 电脑版与手机版的顺序因此**逐字一致**，也不会出现「换个后端顺序就不一样」。
 *    ⚠️ 默认是 `alert`（**该看的在前**）：`需关注` 那几条算出来了却埋在列表底部，
 *    等于白算 —— 这一屏唯一有价值的信号必须出现在最上面（批注「展示效果很差」）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/hardware.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。方法体一个字没动，
 *    只改了相对路径（`helpers.js` 多上跳一层、寿命纯函数改成模块自己的 `lib/life.js`）。
 *
 * ⭐⭐ 0.8.10：**「数码管理」是一个
 *    **容器** —— 层级三分，分类筛选的数据源从「自由文本 `category`」换成「`asset_groups` 的树」：
 *    · `rootId`：「数码管理」那一格（`module_key = 'digital'`），**界面不画它**；
 *    · **子类别**（它的直接子，`sections`）：两个**内置**格 `NAS硬件管理`（原来那整套硬件台账的
 *      **家**）与 `电子产品管理`（⭐ 0.8.22 补的第二个内置格，见 `_ensureDigitalSections()`），
 *      以及用户自建的 `电脑` / `手机`…。两边界面上左栏那一列就是它（**彼此独立**）；
 *    · **子分类**（子类别的直接子，`categories`）：`硬盘` / `相机`…，住在右栏的「子分类」下拉里。
 *    条目靠 `hardware_items.group_id` 归属；`group_id` 为空 / 悬空（那一格已删）的**落到第一个
 *    子类别**。
 *    · 老列 `category` **保留、只当历史数据**：首次取数时按名字把它搬成「NAS硬件管理」下面的
 *      子分类并回填 `group_id`，见 `_ensureDigitalSections()`；**只回填、不清空**。
 *    · 选一个节点时**连带它下面所有子分类**的条目（树语义）—— 见 `subtreeIdsOf()`。
 *    ⚠️ 分组树住在**别的模块的表**里（`assets` 的 `asset_groups`）⇒ 一律走那一边的**公共业务
 *    方法**（`listAssetGroups` / `createAssetGroup` / `ownsAssetGroup`），⛔ 不直接拿 `_bk`
 *    去读别人的表（铁律 11）；`listAssetGroups()` 的「懒播种」副作用正好保证「数码管理」这一格存在。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.24
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/架构文档/26-个人资产管理.md、docs/公共/开发方案/04-NAS硬件管理-1期.md
 */
const { nowStamp, today, notFoundErr, badRequest, splitTerms } = require('../../core/store/helpers.js');
const { lifeOf } = require('./lib/life.js');
const { BUILTIN_TEMPLATES, GENERIC_TEMPLATE_NAME } = require('./lib/templates.js');

/** 三值状态机：想买 → 在用 → 退役（方案 §4.1 取舍 1） */
const STATUSES = ['wishlist', 'owned', 'retired'];

/**
 * ⭐ 排序键（界面上下拉的顺序与它一一对应）—— 0.5.2 按整换了一遍：
 *   旧的四档是 `alert` / `new` / `due` / `price`，界面上写成「该看的在前 / 最近添加 /
 *   快到期的在前 / 最贵的在前」—— 这些说法**描述的是结果而不是字段**，用户没法预判排出来是什么顺序。
 *   现在改成**四个真字段**：`used`（使用时间）/ `remain`（剩余寿命）/ `price`（价格）/ `new`（最近添加），
 *   每一档都能升 / 降序（`desc`），名字与界面上的说法一一对应。
 *
 * ⚠️ `used` 必须排第一：默认值就是它（与界面上的默认选中项同源，改一处要改两处）。
 *    ⚠️ `alert`（该看的在前）**没有删、只是不再是选项**：顶部「⚠ 需关注」那枚胶囊就是它的入口
 *    （按批注，需关注的东西不能埋在底部 —— 那是一条**筛选**，不是一种排序）。
 */
const SORTS = ['used', 'remain', 'price', 'new'];

/**
 * 功能：按排序键 + 方向把列表排好 —— 四档真字段：`used` / `remain` / `price` / `new`。
 *
 * 说明：⭐ 四个键都带 `id DESC` 兜底：同一档内必须**顺序确定**，
 *      否则两次请求可能给出不同顺序，而用户会以为数据变了（在内存里排更容易踩这条）。
 *      ⭐ 0.5.2「算不出来」的行（没填购买日期 / 没填预期寿命）**一律排最后**，
 *      不管升序降序 —— 拿一个 0 去冒充「全新 / 没花钱」是编数据，那正是本模块最忌讳的事
 *      （见 `lib/life.js` 文件头红线 2）。
 *      ⚠️ `price` 取 `purchase_price`，**没有购买价时退回 `wish_target_price`**：
 *      愿望单里「价格」那一栏存的就是目标价，不这样的话切到「想买」再按价格排序会全部并列。
 *
 * @param {Array.<Object>} items - 已挂上 `life` 的行（会被就地排序）
 * @param {string} key - `used` / `remain` / `price` / `new`；不认识的值当 `used`
 * @param {boolean} [desc] - 为真时降序（大 / 新 / 贵的在前），缺省升序
 * @returns {Array.<Object>} 排好的同一个数组
 */
function sortHardware(items, key, desc) {
  const byIdDesc = (a, b) => Number(b.id) - Number(a.id);
  // ⚠️ 降序不是「把比较结果取反」就完事：取反会把「算不出来」一起翻到最前面。
  //    所以先按「有没有值」分堆（有值永远在前），再在堆内按方向比。
  const dir = desc ? -1 : 1;
  const sort = SORTS.includes(key) ? key : 'used';
  /** 功能：按「有没有可比的值」+ 方向排两堆。 @param {Function} val - 取值函数（算不出时返回 null） @returns {Function} 比较器 */
  const cmp = (val) => (a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return byIdDesc(a, b);
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * dir || byIdDesc(a, b);
  };
  if (sort === 'new') {
    // `created_at` 是 TEXT 时间戳，字典序即时间序；缺时间戳的行排最后
    return items.sort((a, b) => {
      const ca = String(a.created_at || '');
      const cb = String(b.created_at || '');
      if (!ca && !cb) return byIdDesc(a, b);
      if (!ca) return 1;
      if (!cb) return -1;
      return (ca < cb ? -1 : ca > cb ? 1 : 0) * dir || byIdDesc(a, b);
    });
  }
  if (sort === 'used') return items.sort(cmp((h) => (h.life && h.life.known ? h.life.usedMonths : null)));
  if (sort === 'remain') return items.sort(cmp((h) => (h.life && h.life.known ? h.life.remainMonths : null)));
  const price = (h) => {
    const n = Number(h.purchase_price);
    if (Number.isFinite(n) && n > 0) return n;
    const w = Number(h.wish_target_price);
    return Number.isFinite(w) && w > 0 ? w : null;
  };
  return items.sort(cmp(price));
}

/**
 * 功能：把一批记录的价格加起来（汇总卡上的「合计」）。
 *
 * 说明：⚠️ **不乘数量** —— 「价格」这一栏问的是「这次花了多少」，数量是单独一栏；
 *      乘上去会把「两条内存 398 元」算成 796 元（界面上的口径提示写着这句话，别改一处）。
 *      ⚠️ 非法 / 空 / 负数一律当 0（老数据里可能是空的），**绝不因为一条脏数据整个汇总变 NaN**。
 *
 * @param {Array.<Object>} list - 已挂上 `life` 的行
 * @param {string} field - 要相加的列名（`purchase_price` / `wish_target_price`）
 * @returns {number} 整数元合计
 */
function sumValue(list, field) {
  return list.reduce((s, h) => {
    const n = Number(h[field]);
    return s + (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  }, 0);
}

/**
 * 功能：判断一条硬件记录是否命中全部关键词。
 *
 * 说明：⭐ 检索面是 **名称 + 品牌 + 型号 + 容量 + 串号 + 用途 + 位置 + 商家 + 详细内容** ——
 *      这九处哪一处命中都算。容量与商家必须在里面：用户想找一块盘时脑子里是
 *      「希捷 4T」（品牌 + 容量），而不是完整型号。
 *      ⚠️ 「详细内容」（`note`）**参与检索但不被解析** —— 它是用户自己写的正文，
 *      搜索它是「找得到」，解析它是「猜语义」，两件事（方案 §1.1 的硬约束只禁止后者）。
 *
 * @param {Object} h - 台账行
 * @param {Array.<string>} terms - 已小写化的关键词
 * @returns {boolean} 全部关键词都命中则为 true；空查询恒为 true
 */
function matchHardware(h, terms) {
  if (!terms.length) return true;
  const hay = [h.name, h.brand, h.model, h.capacity, h.serial, h.purpose, h.location, h.vendor, h.note]
    .map((v) => String(v == null ? '' : v).toLowerCase())
    .join('\u0000');
  return terms.every((t) => hay.includes(t));
}

/**
 * 功能：判断一条台账记录是否「需要看一眼」（寿命临近 / 超期，或保修临近 / 到期）。
 *
 * 说明：⚠️ 判据是「**该看一眼**」，不是「要坏了」—— 它只说明日期到了，
 *      不代表这件硬件出了问题（方案 的补充）。
 *      ⚠️ 只看**在用**的件：退役的不提醒（已经拆下来了），愿望单没有购买日期（天然不提醒）。
 *
 * @param {Object} item - 已挂上 `life` 的行
 * @returns {boolean} 需要关注则为 true
 */
function isAlert(item) {
  if (!item || item.status !== 'owned') return false;
  const life = item.life || {};
  if (life.level === 'soon' || life.level === 'over') return true;
  return life.warranty === 'soon' || life.warranty === 'over';
}

/**
 * 功能：从该账号的资产分组树里摘出「数码管理」那一格及其整棵子树，并**按层级归好**（0.8.10）。
 *
 * 说明：⭐ 判据是 `module_key === 'digital'` —— 那一行由 `assets` 模块**懒播种**出来
 *      （`listAssetGroups()` 在该账号一行分组都没有时建「生活记账 / 数码管理」两格）。
 *      ⚠️ 拿不到那一行（只读降级 / 播种失败）时回一个空树：分类下拉就是空的、筛选不生效，
 *      列表照常能看（⛔ 不能因为分类树读不到就整屏读不出来）。
 *      ⭐ **三层**（见文件头）：根（不画）→ 子类别（`sections`，左栏）→ 子分类（`cats` 里更深
 *      的，右栏下拉）。`cats` 里每行的 `depth` 是**相对根本身**归一化的：**0 = 子类别**、
 *      1 = 子分类、2+ = 更深 —— 调用方靠它分辨「这是子类别还是子分类」。
 *      ⚠️ 子树用「父链扩散」收集而不是递归下钻 —— `rows` 是**展平**的（只有 `parent_id`，
 *      没有 `children`），而且顺序不保证父一定在前一屏内看完；扩散循环每轮只增不减，
 *      所以**有环也一定会停**。
 *
 * @param {Array.<Object>} rows - `listAssetGroups()` 回的展平行（已按树排好，每行带 `depth`）
 * @returns {{ rootId: ?number, sections: Array.<Object>, cats: Array.<Object>, ids: Set.<number>, names: Map.<number, string> }}
 *     根行 id、子类别数组（= `cats` 里 `depth` 为 0 的那些，顺序照树）、全部后代（父在前、
 *     `depth` 相对根归一化）、整棵子树的 id 集、id → 名字
 */
function pickDigitalTree(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const root = list.find((g) => String(g.module_key || '') === 'digital') || null;
  if (!root) return { rootId: null, sections: [], cats: [], ids: new Set(), names: new Map() };
  const rootId = Number(root.id);
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of list) {
      const id = Number(g.id);
      if (ids.has(id)) continue;
      const p = g.parent_id === null || g.parent_id === undefined || g.parent_id === '' ? null : Number(g.parent_id);
      if (p !== null && ids.has(p)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  const base = Number(root.depth) || 0;
  const sections = [];
  const cats = [];
  const names = new Map();
  for (const g of list) {
    const id = Number(g.id);
    if (!ids.has(id) || id === rootId) continue;
    const name = String(g.name || '');
    names.set(id, name);
    const node = {
      id,
      parent_id: g.parent_id === null || g.parent_id === undefined || g.parent_id === '' ? null : Number(g.parent_id),
      name,
      depth: Math.max(0, (Number(g.depth) || 0) - base - 1),
      // ⭐⭐ 0.8.23：`asset_groups.builtin`（系统预置 = 界面上不给删）—— 随树带出来，
      //    左栏那两级与管理弹窗都靠它决定「这一行给不给删除键」。
      //    ⚠️ 判据只此一处：⛔ 前端别自己拿名字去比（用户能改名，比名字必然认错）。
      builtin: Number(g.builtin) > 0,
    };
    cats.push(node);
    // ⭐ `depth === 0` = 根的直接子 = **子类别**（左栏那一列）；`cats` 里更深的都是子分类。
    if (node.depth === 0) sections.push(node);
  }
  return { rootId, sections, cats, ids, names };
}

/**
 * 功能：取「某个分类 + 它下面所有子分类」的 id 集合（0.8.10，筛选用）。
 *
 * 说明：⭐ 选「电脑」时连带「电脑 › 相机」的条目一起出来 —— 树语义（父是汇总，子是细分）。
 *      ⚠️ 同样的扩散写法（只增不减）⇒ 有环也停得住。给了不在这棵树里的 id 时回一个只含它
 *      自己的集合，调用方据此判「这个分类已经没了」。
 *
 * @param {Array.<Object>} cats - `pickDigitalTree()` 回的分类数组
 * @param {(number|string)} gid - 选中的分类 id
 * @returns {Set.<number>} 该分类及其全部子孙的 id
 */
function subtreeIdsOf(cats, gid) {
  const out = new Set([Number(gid)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cats) {
      if (out.has(c.id)) continue;
      if (c.parent_id !== null && out.has(Number(c.parent_id))) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * 功能：从一个「选中的节点」往上找到它所属的**子类别**（`depth === 0` 那一层，0.8.10）。
 *
 * 说明：⭐ 界面上选中的可能是子类别（左栏那一列），也可能是它下面的子分类（右栏下拉）——
 *      两种都要能反推出「现在是哪个子类别」，左栏的高亮与右栏下拉的选项都靠它。
 *      ⚠️ 给了空值 / 不在这棵树里的值 ⇒ 回 `null`（调用方回落到第一个子类别）。
 *      ⚠️ 上溯带 `guard` 上限：树里有环时不会转死（与 `subtreeIdsOf` 同一套防御）。
 *
 * @param {Object} tree - `pickDigitalTree()` 回的树
 * @param {?(number|string)} gid - 选中的节点 id
 * @returns {?number} 所属子类别的 id；认不出来时为 null
 */
function sectionOf(tree, gid) {
  const want = String(gid === null || gid === undefined ? '' : gid).trim();
  if (!want) return null;
  let cur = tree.cats.find((c) => c.id === Number(want)) || null;
  let guard = 0;
  while (cur && cur.depth > 0 && guard < 64) {
    cur = tree.cats.find((c) => c.id === cur.parent_id) || null;
    guard += 1;
  }
  return cur && cur.depth === 0 ? cur.id : null;
}

/**
 * 三个**内置类别**的名字（`_ensureDigitalSections()` 首次取数时把它们建出来）。
 *
 * 说明：⭐⭐ 0.8.23（「预制的 NAS硬件管理、电子产品管理 不可以删除」）：
 *      · `NAS硬件管理`（v1）：原来那整套硬件台账的**家**（左栏第一格）；
 *      · `电子产品管理`（v2，0.8.22 补的第二格）；
 *      · `家用电器管理`（⭐ v4，0.8.24 补的第三格 —— 「还想引入家用电器
 *        类别管理」，模块显示名也跟着改成了「我的设备」）。
 *      ⚠️⭐ 这份名单**只用在「那几趟一次性迁移各自跑的那一次」**（建格 / 给已经建出来的格
 *      补 `builtin` 标记）—— ⛔ **绝不拿它当**「这一格是不是内置」的判据：存量库里那几格的
 *      名字可能已经被改过（见 `_ensureDigitalSections()` 的说明），靠名字认必然认错。
 *      界面与保护的判据都是**行上的 `builtin`**（`assets/store.js` 的 `seedAssetGroup()` 播种、
 *      `removeAssetGroup()` 拦删、`updateAssetGroup()` 拦改名）。
 *
 * @type {Array.<string>}
 */
const BUILTIN_SECTIONS = ['NAS硬件管理', '电子产品管理', '家用电器管理'];

/** 上面那三份内置格的「第几格」（v1 / v2 / v4 各自建一个）。 */
const SEC_NAS = BUILTIN_SECTIONS[0];
const SEC_ELEC = BUILTIN_SECTIONS[1];
const SEC_APPL = BUILTIN_SECTIONS[2];

/**
 * 三个内置类别下**各预置哪几条分类**（选的「每类 6 条」）。
 *
 * 说明：⚠️ 这些预置分类是**普通格**（⛔ 不带 `builtin`）：删得掉、改得了名，删了也不会自己长回来
 *      —— 只把「不可删除、不可改名」点名给了那三个**类别**本身（见 `assets/store.js`
 *      的 `removeAssetGroup()` / `updateAssetGroup()`）。
 *      ⚠️ 播种**按名字只建缺的**：老库里已经有的（v1 从老 `category` 搬过来的「硬盘」「网线」…）
 *      一条都不重复建；用户改过名的也照旧 —— 那几格此刻只是「同名的另一格」。
 *      ⚠️ 顺序 = 界面上从左到右的先后（`createAssetGroup()` 按「同级末尾」逐个排下去）。
 *
 * @type {Object.<string, Array.<string>>}
 */
const BUILTIN_CATS = {
  [SEC_NAS]: ['硬盘', '内存', '电源', '网线', '路由器', '机柜'],
  [SEC_ELEC]: ['笔记本', '手机', '平板', '显示器', '键鼠', '音箱'],
  [SEC_APPL]: ['冰箱', '洗衣机', '空调', '热水器', '电视', '微波炉'],
};

/**
 * 功能：建一个**内置**子类别格 —— 走 `assets` 的 `seedAssetGroup()`（它写 `builtin = 1`）。
 *
 * 说明：⭐⭐ 0.8.23：预制的格必须带 `builtin` 标记，否则界面上会摆出一颗「删了就不该删的」删除键。
 *      ⚠️ 回落 `createAssetGroup()` 是**跨版本**的过渡口子：`assets` 目录被整个删掉、或它还停在
 *      没有 `seedAssetGroup()` 的版本时，格照样建得出来（只是丢了「不可删」那层保护）——
 *      与 `typeof this.listAssetGroups === 'function'` 那处同一条退化口径：
 *      ⛔ 不因为少一层保护就把整屏打死。
 *
 * @param {Object} store - Store 实例（模块级函数 ＋ 调用点把 `store` 传进来，⛔ 不挂私有方法）
 * @param {number} uid - 账号 id
 * @param {Object} fields - `{ name, parent_id, icon?, sort_order? }`
 * @returns {Object} 新建的行（含 `id`）
 */
function seedSection(store, uid, fields) {
  if (typeof store.seedAssetGroup === 'function') return store.seedAssetGroup(uid, fields);
  return store.createAssetGroup(uid, fields);
}

// ---- ⭐⭐ 0.8.23：硬件模板（「预制新建硬件的模板菜单」）----

/**
 * 功能：归一化一份**下拉选项清单**（`opts`）—— 空串与重复项就地丢掉，其余按原次序保留。
 *
 * 说明：⭐⭐ 0.8.24（「要可以看到详细内容（包括添加和删除下拉字段）」）：
 *      从这一版起**用户自建的属性也能是下拉** —— `opts` 不再只是内置模板的专利
 *      （在 0.8.23 里它只住在 `lib/templates.js` 的代码里）。
 *      ⚠️ 丢掉空串只是**归一化**、不是截断用户意图：一个没有文字的选项在界面上是个空药丸，
 *      与「缺 `label` 的字段整条丢掉」是同一条口径。
 *      ⚠️ 刻意**不设条数 / 长度上限** —— 与既有的 `fields`（自定义属性条数）一样，
 *      整包的体积由请求体上限兜着；⛔ 别在这里静默砍用户的东西（本项目「超长一律 400
 *      且不静默截断」那条纪律）。
 *
 * @param {?Array} raw - 前端提交的选项数组（其它类型一律当空）
 * @returns {Array.<string>} 归一化后的选项清单（可能为空数组）
 */
function normOpts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    const v = String(o == null ? '' : o).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * 功能：把 `hardware_templates.fields` 那一列 JSON 文本解析成字段数组（**容错**）。
 *
 * 说明：⚠️ 解析失败**不上抛** —— 一列坏 JSON 不该把整屏打成「读取失败」。它是我们自己写进去的，
 *      坏了只可能是历史或手工改库 ⇒ 当成「这份模板还没有自定义属性」，用户重新加一遍即可。
 *      ⚠️ 缺 `label` 的条目一律丢掉：界面上没法显示一个没有名字的框。
 *      ⭐ 0.8.24：`opts`（下拉选项，见 `normOpts()`）跟着一起读回来 —— 少了它，用户自建的
 *      下拉属性**重新打开就变成纯文本框**，而库里那份清单还在（看着像「白填了」）。
 *
 * @param {?string} text - `hardware_templates.fields` 的原文
 * @returns {Array.<Object>} `[{ key, label, ph, opts? }]`
 */
function parseTemplateFields(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(String(text));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f) => f && typeof f === 'object' && f.key && f.label)
      .map((f) => {
        const out = { key: String(f.key), label: String(f.label), ph: f.ph ? String(f.ph) : '' };
        const opts = normOpts(f.opts);
        if (opts.length) out.opts = opts;
        return out;
      });
  } catch {
    return [];
  }
}

/**
 * 功能：把 `hardware_items.attrs` 那一列 JSON 文本解析成对象（同样容错）。
 * @param {?string} text - `hardware_items.attrs` 的原文
 * @returns {Object} `{ <字段key>: <值文本> }`
 */
function parseAttrs(text) {
  if (!text) return {};
  try {
    const o = JSON.parse(String(text));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined) continue;
      out[String(k)] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 功能：归一化一份字段定义（新建 / 更新模板都得过它）。
 *
 * 说明：⚠️ 认四样 —— `key`（进 `attrs` 的键）/ `label`（界面上的名字）/ `ph`（占位提示）/
 *      ⭐ 0.8.24 起还认 `opts`（下拉选项清单，走 `normOpts()`）。
 *      缺 `label` 的整条丢掉；`key` 缺了或是重复的，就地补一个（前端本来会生成，
 *      这里是兜底 —— 重复的键会让两个框写同一个位置，**后填的静默覆盖先填的**）。
 *      ⚠️ `opts` **空了就不落这个键**（`{ key, label, ph }` 的老形状照旧合法）——
 *      界面按「有没有 `opts`」判该渲染下拉还是文本框，留一个空数组会让它渲染成
 *      一颗只有「（不填）」的空下拉。
 *
 * @param {?Array} raw - 前端提交的字段数组
 * @returns {Array.<Object>} 归一化后的字段数组
 */
function normalizeFields(raw) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f !== 'object') continue;
    const label = String(f.label == null ? '' : f.label).trim();
    if (!label) continue;
    let key = String(f.key == null ? '' : f.key).trim();
    if (!key || seen.has(key)) {
      key = 'c' + (out.length + 1);
      while (seen.has(key)) key += 'x';
    }
    seen.add(key);
    const item = { key, label, ph: String(f.ph == null ? '' : f.ph).trim() };
    const opts = normOpts(f.opts);
    if (opts.length) item.opts = opts;
    out.push(item);
  }
  return out;
}

/**
 * 功能：把一行模板**整形**成给前端的样子 —— ⭐ 内置模板的「预置字段」以**代码为准**。
 *
 * 说明：⭐⭐ 内置那 11 个的预置字段住在 `lib/templates.js`（代码），用户**追加**的自定义属性
 *      住在 `fields` 那一列。读的时候按代码**重建预置部分**、再把追加的接在后面 ⇒
 *      · 「预置字段不许删、**名字**不许改」**天然成立**（每次读都由代码覆盖，绕不过去）；
 *      · 将来给某个内置模板补一个预置字段，老账号**不用迁移**就会看到它；
 *      · 顺序永远是「预置在前（按代码里的次序）、自己加的在后」。
 *      ⭐⭐ 0.8.24 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的，
 *      只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
 *      **只有「选项清单」这一样归用户** —— 库里与预置同 key 的行就是那份覆盖（见下面的说明），
 *      `label` / `ph` / `when` 仍然每次读由代码重建。
 *      ⚠️ 判据是 `builtin`（⛔ **不是名字** —— 与 `builtin` 那一列的所有其它用途同一条纪律）。
 *      自建模板的整份 `fields` 就是用户自己那一份，原样返回。
 *
 * @param {Object} row - `hardware_templates` 的一行
 * @returns {{id: number, name: string, builtin: boolean, fields: Array.<Object>}} 给前端的模板
 */
function shapeTemplate(row) {
  const own = parseTemplateFields(row.fields);
  const preset = Number(row.builtin) ? BUILTIN_TEMPLATES.find((t) => t.name === String(row.name || '')) : null;
  // ⚠️ 内置模板被人改过名（界面拦着，但库可能被手工改过）⇒ 退化成「整份按库里那一份」
  if (!preset) return { id: Number(row.id), name: String(row.name || ''), builtin: !!Number(row.builtin), fields: own };
  const presetKeys = new Set(preset.fields.map((f) => f.key));
  // ⭐⭐ 0.8.24 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的，
  //    只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
  //    库里与预置字段**同 key** 的那些行 = **用户对那一项「选项清单」的覆盖**（只认 `opts` ——
  //    `label` / `ph` / `when` 仍然由代码说了算，界面上也改不了它们）。
  const overrides = new Map();
  for (const f of own) if (presetKeys.has(f.key)) overrides.set(f.key, f);
  const extra = own.filter((f) => !presetKeys.has(f.key));
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    builtin: true,
    // ⚠️ 预置那几项带 `fixed: true` —— 界面据此把它们在「编辑专业参数」里**显示成只读**
    //    （名字 / 类型 / 条件都归代码；⭐ 任务五起**只有选项清单**归用户）。
    //    ⭐⭐ 0.8.23 第二版：`opts`（常见规格下拉）与 `when`（条件显隐）**跟着一起透传**。
    fields: [
      ...preset.fields.map((f) => {
        const ov = overrides.get(f.key);
        // ⭐⭐ 任务五：这一项被用户改过 ⇒ 以**他那一份**为准（包括「全删光」= 退化成文本）
        const opts = (ov ? (Array.isArray(ov.opts) ? ov.opts : []) : Array.isArray(f.opts) ? f.opts : []).map((o) =>
          String(o),
        );
        const out = { key: f.key, label: f.label, ph: f.ph || '', fixed: true };
        if (opts.length) out.opts = opts;
        // ⭐⭐ 任务五：**代码里是下拉**的那几项 ⇒ 选项清单归用户改 ——
        //    界面据此在这一行摆一颗「改选项」（⛔ 纯文本框那些没有这一颗）。
        //    ⚠️ 判据用**代码**那一份（⛔ 不是 `opts.length`）：用户把选项全删光之后
        //    那颗键得还在，否则他再也加不回来了（「删光就回不去」是本仓最不想要的坑）。
        if (Array.isArray(f.opts) && f.opts.length) out.optsEditable = true;
        if (f.when && f.when.key && Array.isArray(f.when.in) && f.when.in.length) {
          out.when = { key: String(f.when.key), in: f.when.in.map((v) => String(v)) };
        }
        return out;
      }),
      ...extra,
    ],
  };
}

/**
 * 功能：按名字在**本人**的模板里找同名的另一行 —— 找到了就是要撞名了（`null` = 没撞上）。
 *
 * 说明：⭐⭐ 0.8.24 任务六（「模板名称必须唯一」）：图里能建出两个都叫「测试」的
 *      自建模板 —— 模板是**选择**用的（新建硬件时先选一个），两条同名的摆在那一排里，
 *      用户根本分不清点的是哪一条（与「同一层不许重名」是同一族的坑，只是换了一张表）。
 *      ⚠️ 内置那 11 个名字**天然在这个集合里**（它们也各占一行、`builtin = 1`）——
 *      所以这条同时兜住了「与内置撞名」，不必再单独比代码清单（那条留着另给一句更准的文案）。
 *      ⚠️ 比的是 `trim()` 之后的原文；`exceptId` 给改名那条路用（改的是自己那一行，自己不算撞）。
 *      ⚠️ 走 `listHardwareTemplates(uid)`（会顺带播种内置那 11 行）—— 那是本账号模板的**唯一**真相。
 *
 * @param {Object} store - Store 实例（要它的 `_bk`）
 * @param {number} uid - 账号 id
 * @param {?string} name - 想用的名字
 * @param {?(number|string)} exceptId - 排除掉的行 id（改名时是它自己）
 * @returns {?Object} 撞上的那一行；没撞上为 null
 */
function findSameNameTemplate(store, uid, name, exceptId) {
  const nm = String(name == null ? '' : name).trim();
  if (!nm) return null;
  for (const t of store._bk.listHardwareTemplates(Number(uid))) {
    if (exceptId !== null && exceptId !== undefined && Number(t.id) === Number(exceptId)) continue;
    if (String(t.name == null ? '' : t.name).trim() === nm) return t;
  }
  return null;
}

module.exports = {
  STATUSES,
  SORTS,

  /**
   * 功能：列出（并按关键词 / 状态 / 分类筛选，或只看需关注）某账号的硬件台账，每条都挂上 `life`。
   *
   * 说明：⭐ 返回结构 `{ items, total, summary, sections, section_id, categories }` 是
   *      **一次请求就能画完整屏**的最小集合（左栏子类别 ＋ 右栏下拉 ＋ 概览行 ＋ 列表）——
   *      所以没有 `/api/hardware/summary` 这类接口（少一次请求、少一处 401 分支）。
   *
   *      ⭐ `summary` 的口径（0.8.10改的）：**只算当前这一摊**（选中的子类别 / 子分类
   *      子树里的东西）—— 各子类别彼此独立（「NAS硬件管理是独立于其它
   *      子类别的」），在「电脑」那一格下挂着 NAS 的金额比不显示更容易误导。
   *
   *      ⚠️ 筛选参数**不做校验式拦截**：`status` 给了不认识的值就当「不筛选」
   *      （列表接口把参数打回 400，只会让用户对着一个空白页，而不是「没筛出来」）——
   *      与收藏夹对 `q` / `tag` 的处理一致。`sort` 同一个道理。
   *
   * @param {number} uid - 账号 id
   * @param {Object} [opts] - 筛选条件
   * @param {string} [opts.q] - 关键词（空白分隔 = 多词 AND）
   * @param {string} [opts.status] - `wishlist` / `owned` / `retired`；不认识的值当作不筛选
   * @param {string} [opts.group] - 选中的节点 id：**子类别**（左栏那一列）或它下面的**子分类**
   *      （右栏下拉）。给了就**连带它下面的所有子分类**（树语义）；空 / 不认识的值回落
   *      到**第一个子类别**
   * @param {string} [opts.focus] - `'alert'` 时只回「需关注」的在用件
   * @param {string} [opts.sort] - `used`（默认，使用时间）/ `remain`（剩余寿命）/ `price`（价格）/ `new`（最近添加）
   * @param {boolean|string} [opts.desc] - 为真（或字符串 `'1'`）时降序：大 / 贵 / 新的在前
   * @returns {{ items: Array.<Object>, total: number, summary: Object, root_id: ?number, sections: Array.<Object>, section_id: ?number, categories: Array.<Object> }}
   *      列表结果 —— `root_id` = 「数码管理」那一格的 id（前端「新建子类别」要拿它当父格），
   *      `sections` = 左栏的子类别（含条数、`active` 标出的选中项，以及**自己的子分类** `cats`
   *      —— ⭐ 0.8.22 起左栏直接铺两级，`cats` 就是第二级）,
   *      `section_id` = 当前子类别 id（右栏下拉的基准），`categories` = 它下面的子分类
   */
  listHardware(uid, opts) {
    const o = opts || {};
    const terms = splitTerms(o.q);
    const status = STATUSES.includes(o.status) ? o.status : null;
    const group = String(o.group == null ? '' : o.group).trim();
    const onlyAlert = o.focus === 'alert';
    const d = today();

    // ⭐ 三个层级都来自「数码管理」那一格下面的子树（跨模块走 `listAssetGroups()`，见文件头）。
    //    ⚠️ `assets` 模块目录被整个删掉时那个方法不存在 —— 退化成空树（分类暂不可用），
    //    ⛔ 不让整个列表跟着一个 TypeError 挂掉（方案 §六·3 的退化口径）。
    const readTree = () =>
      typeof this.listAssetGroups === 'function'
        ? pickDigitalTree(this.listAssetGroups(Number(uid)).groups)
        : pickDigitalTree([]);
    let tree = readTree();
    // ⭐ 内置子类别 + 老 `category` 搬家：首次取数时做一趟（带一次性标记，见 `_ensureDigitalSections()`）。
    //    真的动过（建了格 / 落了标记）才重取一次树（新格子此刻还不在上面那份快照里）。
    if (this._ensureDigitalSections(Number(uid), tree)) tree = readTree();

    // ⭐ 默认落到**第一个子类别**（左栏第一项）—— `group` 没给 / 给了不在这棵树里的值时用它。
    //    一格子类别都没有（只读降级 / 树读不到）时是 null ⇒ 后面整段退化成「不按分类过滤」。
    const homeSecId = tree.sections.length ? tree.sections[0].id : null;
    // ⭐ 选中的**子类别**：`group` 可能就指着子类别，也可能指着它下面的子分类 ——
    //    靠 `sectionOf()` 往上溯（左栏高亮与右栏下拉都吃这一个值）。
    const secPick = sectionOf(tree, group);
    const secId = secPick === null ? homeSecId : secPick;

    // ⭐ 条目的**有效归属**：`group_id` 为空 / 悬空（那一格已被删）⇒ 落到第一个子类别
    //    ——  在这一屏的落地：老数据（未分类）与删掉的子分类都还有家可回，
    //    ⛔ 不能静默消失（列表里看不到、计数里也没有，用户会以为数据丢了）。
    // ⭐⭐ 0.8.23（「新建硬件必须选择一个模板」）：模板清单也随列表一起回来（与 sections /
    //    categories 同一条口径：一次请求画完整屏），并给每条硬件挂上**它的模板**与**专业参数值**。
    //    ⚠️⭐ `template_id` 为空（老数据）或指向一个已经删掉的模板时**兜底到「通用」**
    //    （选的口径：「自动归到默认模板」）—— 但这只是**读的时候算的**，
    //    ⛔ 一个字节都不往库里写（铁律：迁移绝不改写用户数据）。
    const templates = this.listHardwareTemplates(Number(uid));
    const tplIds = new Set(templates.map((t) => t.id));
    const genericId = (templates.find((t) => t.builtin && t.name === GENERIC_TEMPLATE_NAME) || {}).id || null;
    const tplNameOf = new Map(templates.map((t) => [t.id, t.name]));

    const gidOf = new Map();
    const all = this._bk.listHardware(Number(uid)).map((h) => {
      const raw = h.group_id === null || h.group_id === undefined || h.group_id === '' ? null : Number(h.group_id);
      const gid = raw !== null && tree.ids.has(raw) ? raw : homeSecId;
      gidOf.set(Number(h.id), gid);
      const rawTpl =
        h.template_id === null || h.template_id === undefined || h.template_id === '' ? null : Number(h.template_id);
      const tplId = rawTpl !== null && tplIds.has(rawTpl) ? rawTpl : genericId;
      return Object.assign({}, h, {
        life: lifeOf(h, d),
        // ⭐ 详情要显示的是**归属那一格的名字**（老 `category` 已退役）——
        //    在这里挂上，前端不必再查一次
        group_name: gid === null ? '' : tree.names.get(gid) || '',
        // ⭐⭐ 0.8.23：模板与专业参数 —— `attrs` 在这里就解析成对象（库里存的是 JSON 文本），
        //    两个后端因此给出**逐字一致**的形状，前端不必各写一份容错解析
        template_id: tplId,
        template_name: tplId === null ? '' : tplNameOf.get(tplId) || '',
        attrs: parseAttrs(h.attrs),
      });
    });

    // ⭐ 实际筛的节点：`group` 认识就用它（可能指着子分类），否则用选中的子类别。
    //    ⚠️ 「不认识 ⇒ 不筛选」那条老口径**改了**：现在左栏必有选中项，认不出来的一律回落
    //    到该子类别（列表接口把参数打回 400 只会让用户对着一个空白页，而不是「没筛出来」）。
    const scopeId = group && tree.ids.has(Number(group)) ? Number(group) : secId;
    const scope = scopeId === null ? null : subtreeIdsOf(tree.cats, scopeId);
    // ⭐ 概览与列表都只看**当前这一摊**里的东西 —— 各子类别彼此独立（
    //    「NAS硬件管理是独立于其它子类别的」）：在「电脑」那一格下挂着 NAS 的件数与金额，
    //    比不显示更容易误导。
    const inScope = scope ? all.filter((h) => scope.has(gidOf.get(Number(h.id)))) : all;

    // 汇总算在**状态 / 关键词筛选之前**（它就是「这一摊一共有多少件」的答案，不随筛选变化 ——
    // 否则一点筛选，其它计数就跟着变小，看起来像数据丢了）
    const owned = inScope.filter((h) => h.status === 'owned');
    const wishlist = inScope.filter((h) => h.status === 'wishlist');
    const retired = inScope.filter((h) => h.status === 'retired');
    const summary = {
      total: inScope.length,
      owned: owned.length,
      wishlist: wishlist.length,
      retired: retired.length,
      alert: owned.filter(isAlert).length,
      // ⭐ 三个金额合计（0.4.4）：价格一直存着，但从来没有求过和 ——
      //    「我这堆东西一共花了多少」是台账能给、而文件管理给不了的增量（方案 §1.1 第 2 条）。
      //    ⚠️ 全部都算在筛选之前，与计数同一条口径。
      ownedValue: sumValue(owned, 'purchase_price'),
      retiredValue: sumValue(retired, 'purchase_price'),
      wishValue: sumValue(wishlist, 'wish_target_price'),
      // ⭐⭐ 0.8.24 任务七（「在各自框底部显示总价」）：那排概览卡
      //    （全部 / 在用 / 想买 / 已退役 / 需关注）每格底部再显示**这一档的金额合计**——
      //    · 「全部」= 三条各自按自己的价相加（已买的用购买价、想买的用目标价）；
      //    · 「需关注」= 在用里**命中提醒**的那些的购买价合计。
      //    ⚠️ 口径与上面那三个金额**一模一样**（只算同一摊 `inScope`，与计数同一条界线）——
      //    界面上这两处挨着显示，差一分钱都会被当成 bug。
      allValue:
        sumValue(owned, 'purchase_price') +
        sumValue(retired, 'purchase_price') +
        sumValue(wishlist, 'wish_target_price'),
      alertValue: sumValue(owned.filter(isAlert), 'purchase_price'),
    };

    const items = inScope.filter((h) => {
      if (status && h.status !== status) return false;
      if (onlyAlert && !isAlert(h)) return false;
      return matchHardware(h, terms);
    });

    // ⭐ 排序在**筛选之后**做：排的是「这次要给用户看的那几条」。
    //    0.5.2 起默认是 `used`（使用时间），方向由 `desc` 决定 —— 见 `sortHardware()` 的说明。
    //    ⚠️ 查询串里带来的是字符串 `'0'` / `'1'`，所以这里按**真值**判（`'0'` 是假，正好对）。
    sortHardware(items, o.sort, !!o.desc && String(o.desc) !== '0');

    // ⭐ 左栏（子类别）与右栏下拉（子分类）的选项**随列表一起返回**（与收藏夹把分类列表随列表
    //    带回同理）：前端不必再打一次接口，而且筛选中它们都不会跟着变空。
    //    ⚠️ 计数同样是**全量**的（按有效归属算），与 `summary` 一个道理。
    const catCount = new Map();
    all.forEach((h) => {
      const gid = gidOf.get(Number(h.id));
      if (gid !== null) catCount.set(gid, (catCount.get(gid) || 0) + 1);
    });
    // ⚠️ 任意一格 → 它所属的**子类别**：`sections` 的计数要把子分类里的条目一并算上去
    //    （子类别个数很少，通常 1~5，逐个扩散可接受）。
    const secOf = new Map();
    for (const s of tree.sections) for (const id of subtreeIdsOf(tree.cats, s.id)) secOf.set(id, s.id);
    const secCount = new Map();
    all.forEach((h) => {
      const s = secOf.get(gidOf.get(Number(h.id)));
      if (s !== undefined) secCount.set(s, (secCount.get(s) || 0) + 1);
    });
    // ⚠️ 顺序照**树的顺序**（`sections` 已按 sort_order → id 排好）—— 不再按条目数排：
    //    「谁在谁下面」比「哪一类东西多」重要。
    //    ⭐⭐ 0.8.22（「子类别二级展开子分类」）：每一格**再带上自己的子分类**
    //    （`cats`）—— 左栏现在就直接铺两级，不再只靠右栏那枚下拉（那一枚本轮按关掉了）。
    //    ⚠️ 只给**直接子**（`parent_id === 这一格`）：更深的后代属于下一层的展开，不该在这一层混进来。
    //    ⚠️ 计数与 `categories` 同一条口径（全量、不随筛选变），顺序也照树。
    const sections = tree.sections.map((s) => ({
      id: s.id,
      name: s.name,
      count: secCount.get(s.id) || 0,
      active: s.id === secId,
      // ⭐⭐ 0.8.23：预制的子类别（`NAS硬件管理` / `电子产品管理`）—— 界面据此**不给删除键**
      //    （后端 `removeAssetGroup()` 另有一道硬拦，见 assets/store.js）。
      builtin: !!s.builtin,
      cats: tree.cats
        .filter((c) => c.parent_id === s.id)
        .map((c) => ({ id: c.id, name: c.name, count: catCount.get(c.id) || 0 })),
    }));

    // ⭐ 右栏「子分类」下拉 = **当前子类别下面**的全部子分类（不含子类别自己），
    //    `depth` 减 1（子类别的直接子变成 0：子类别本身在那枚下拉里不存在 ⇒ 缩进从 0 起）。
    const subIds = secId === null ? new Set() : subtreeIdsOf(tree.cats, secId);
    const categories = tree.cats
      .filter((c) => subIds.has(c.id) && c.id !== secId)
      .map((c) => ({
        id: c.id,
        name: c.name,
        depth: c.depth - 1,
        count: catCount.get(c.id) || 0,
      }));

    return {
      items,
      total: items.length,
      summary,
      root_id: tree.rootId,
      sections,
      section_id: secId,
      categories,
      // ⭐⭐ 0.8.23：模板清单（内置 11 个 + 自建）—— 「新建硬件先选模板」那一步与
      //    表单里的「专业参数」那一组，都靠它（⛔ 不再单独打一次接口）
      templates,
    };
  },

  /**
   * 功能：按 id 取一条台账记录（含 `life`），供详情 / 编辑回填。
   * @param {number} uid - 账号 id
   * @param {number} id - 台账 id
   * @returns {?Object} 台账行（含 `life`）；不归本人或不存在时为 null
   */
  getHardware(uid, id) {
    const h = this._bk.getHardware(Number(uid), id);
    if (!h) return null;
    return Object.assign({}, h, { life: lifeOf(h, today()) });
  },

  /**
   * 功能：判断一条台账记录是否属于该账号。
   * @param {number} uid - 账号 id
   * @param {number} id - 台账 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsHardware(uid, id) {
    return this._bk.ownsHardware(Number(uid), id);
  },

  /**
   * 功能：新建一条台账记录（也可以是愿望单条目 —— 同一张表，差别只在 `status`）。
   *
   * 说明：⚠️ `status` / `quantity` 没传时补上表定义里的默认值（`owned` / 1）：
   *      JSON 后端不会替我们补默认值，两个后端的行为必须一致。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - 已由 `validate.checkHardware` 归一化
   * @returns {Object} 新建的行（含 `id`）
   * @throws {Error} 数据层只读时抛 503
   */
  createHardware(uid, input) {
    this._assertWritable();
    const row = Object.assign({}, input);
    delete row.id;
    delete row.user_id;
    delete row.created_at;
    delete row.updated_at;
    // ⚠️ 挂了分类就必须确认**那个分组是本人的**（否则能把条目挂到别人的分类下 —— 越权写入）
    this._assertHwGroupOwned(uid, row.group_id);
    // ⭐⭐ 0.8.23：模板同款 —— 挂到别人的模板上同样是越权写入
    this._assertHwTemplateOwned(uid, row.template_id);
    row.user_id = Number(uid);
    if (!row.status) row.status = 'owned';
    if (row.quantity === undefined || row.quantity === null || row.quantity === '') row.quantity = 1;
    if (row.wish_priority === undefined || row.wish_priority === null || row.wish_priority === '') {
      row.wish_priority = 0;
    }
    const stamp = nowStamp();
    row.created_at = stamp;
    row.updated_at = stamp;
    return this._insert('hardware_items', row);
  },

  /**
   * 功能：更新一条台账记录 —— 包括「买回来了」（`wishlist` → `owned` 并补上购买信息）。
   *
   * 说明：⭐ 「买回来」**不是**复制一条再删一条，就是这一次 `PUT`（方案）。
   *      ⚠️ 只改请求里真的带了的字段：局部更新是这个应用的常态。
   *      ⚠️ 一个字段都没带时 `_update()` 仍会刷新 `updated_at`（白名单里有它），
   *      所以返回值只说明「行是不是本人的」。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 台账 id
   * @param {Object} input - 已由 `validate.checkHardware` 归一化
   * @returns {boolean} 是否真的更新到了（不归本人时为 false）
   * @throws {Error} 数据层只读时抛 503
   */
  updateHardware(uid, id, input) {
    this._assertWritable();
    // ⚠️ 改挂分类（含解绑）同样要过归属校验 —— 与 `createHardware` 那一句同一条理由
    if (input && Object.prototype.hasOwnProperty.call(input, 'group_id')) {
      this._assertHwGroupOwned(uid, input.group_id);
    }
    // ⭐⭐ 0.8.23：换模板同款（换到别人的模板上照样是越权写入）
    if (input && Object.prototype.hasOwnProperty.call(input, 'template_id')) {
      this._assertHwTemplateOwned(uid, input.template_id);
    }
    return this._update('hardware_items', uid, id, input);
  },

  /**
   * 功能：删除一条台账记录。
   * @param {number} uid - 账号 id
   * @param {number} id - 台账 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛 503
   */
  removeHardware(uid, id) {
    this._assertWritable();
    return this._bk.deleteHardware(Number(uid), id);
  },

  /**
   * 功能：校验台账归属：不属于 `uid`（或根本不存在）时抛 404。
   * @param {number} uid - 账号 id
   * @param {number} id - 台账 id
   * @returns {void}
   * @throws {Error} 不归该账号所有时抛 404
   */
  _assertHardwareOwned(uid, id) {
    if (!this.ownsHardware(uid, id)) throw notFoundErr('这条硬件记录');
  },

  /**
   * 功能：校验「这个分类分组是本人的」—— 不归本人 / 不存在一律 404（403 是探测通道）。
   *
   * 说明：⭐ 分类住在**别的模块的表**里（`assets` 的 `asset_groups`）⇒ 走那一边的公共业务方法
   *      `ownsAssetGroup()`，⛔ 不自己查别人的表（铁律 11 /）。
   *      ⚠️ 空值（`null` / `''` / `undefined`）= 未分类 / 解绑，**直接放过**：那是一个合法动作
   *      （与 `assets` 的 `updateAssetItem()` 对 `group_id` 的处理同一条口径）。
   *      ⚠️ `assets` 模块目录被整个删掉时那个方法不存在 —— 也按「这个分类不认」处理（404），
   *      因为那会儿分类功能本来就不可用了。
   *
   * @param {number} uid - 账号 id
   * @param {?(number|string)} gid - 分类（分组）id
   * @returns {void}
   * @throws {Error} 分组不归本人 / 不存在 / 分类功能不可用时抛 404
   */
  _assertHwGroupOwned(uid, gid) {
    if (gid === undefined || gid === null || gid === '') return;
    if (typeof this.ownsAssetGroup !== 'function' || !this.ownsAssetGroup(uid, gid)) {
      throw notFoundErr('这个分类');
    }
  },

  /**
   * 功能：确认某个模板是本人的（挂了模板就必须过这一道 —— 与 `_assertHwGroupOwned` 同一条理由）。
   *
   * 说明：⚠️ **空值直接放过**：没选模板是合法状态（老数据就那样，界面上按「通用」显示），
   *      所以这里只在「真的指了一个 id」时才查。
   *      ⚠️ 走到这里说明 `hardware_templates` 那张表在（列表读路径已经播种过它）；
   *      极端装配下原语缺失也不该把整次保存打死 ⇒ 用 `_bk` 直查，查不到就是 404。
   *
   * @param {number} uid - 账号 id
   * @param {(number|string|null|undefined)} tid - 模板 id
   * @returns {void}
   * @throws {Error} 模板不归本人 / 不存在时抛 404
   */
  _assertHwTemplateOwned(uid, tid) {
    if (tid === undefined || tid === null || tid === '') return;
    if (!this._bk.ownsHardwareTemplate(Number(uid), Number(tid))) throw notFoundErr('这个模板');
  },

  /**
   * 功能：把「数码管理」的层级补齐 ＋ 搬老数据（**两趟，各带一个一次性标记**）。
   *
   * 说明：⭐ 三趟各干各的，标记都住在全局键值表里：
   *      · **v1**（`digital_sections_v1_<uid>`）：① **内置子类别**「NAS硬件管理」—— 原来那整套
   *        硬件台账的**家**（左栏第一格）；② 老的自由文本 `category`（`硬盘` / `网线`…）⇒ 搬成它
   *        下面的**子分类**，并把这些行的 `group_id` 回填到那一格。不搬的话老用户升上来会看到
   *        「分类全空了」。
   *      · **v2**（`digital_sections_v2_<uid>`，⭐ 0.8.22）：第二个**内置子类别**「电子产品管理」。
   *        ⚠️⭐ 为什么另起一趟而不是并进 v1：v1 的标记**早就落在老账号的库里**，改 v1 等于那一趟
   *        再也不会重跑（新格永远建不出来）；而把 v1 的键换个名字，又会连同**老文本搬家**再跑一遍
   *        ——「用户主动清空归属之后不会被搬回来」那条口径当场破掉（见下面测试里那一条）。
   *      ⭐ **一次性标记**：⛔ 不用「选择条件本身」当幂等判据 —— 那样「用户把某条的分类清空」会让
   *      老文本**又搬回来**；⛔ 也不用「按名字找那一格」当判据 —— 用户给它**改名**之后会被骗到、
   *      重复建一格。⚠️ 按名字找**只在每一趟自己的那一次**里做（标记落下去之后就不再找）。
   *      ⚠️ **只回填、不清空** `category`（启动与迁移绝不改写用户数据）——
   *      原列留着，将来要回滚 / 核对还有得看。
   *      ⚠️ v1 的子分类**按名字复用**，但只认「NAS硬件管理」的**直接子**（⛔ 不认别的子类别下的同名格）。
   *      ⚠️ **失败不上抛**：只读降级 / 某一条写不动时静默收尾 —— 标记只在**这一趟做完之后**才落，
   *      于是失败时下一趟会整段重跑（重跑是安全的：已建过的格按名字复用、已回填的行不再命中）。
   *      · **v3**（`digital_sections_v3_<uid>`，⭐ 0.8.23）：给**已经建出来**的那两个内置子类别
   *        补 `builtin` 标记 —— 预制的格不可删（界面不给删除键 ＋ `assets` 的
   *        `removeAssetGroup()` 硬拦）。⚠️ 0.8.22 及更早的库里那两格的 `builtin` 是补列补出来的
   *        0，不补这一趟「预制不可删」对存量账号就形同虚设。
   *      · **v4**（`digital_sections_v4_<uid>`，⭐⭐ 0.8.24）：第三个内置类别「家用电器管理」
   *        （「还想引入家用电器类别管理」）。存量库里已经有一格**同名**的就地补 `builtin`
   *        （那说明它本来就是预制那一格，只是建于没有标记的版本）。
   *      · **v5**（`digital_sections_v5_<uid>`，⭐⭐ 0.8.24）：给三个内置类别各播
   *        `BUILTIN_CATS` 那 6 条**预置分类**（普通格，按名字只建缺的）。
   *        ⚠️ 它必须**另起一趟**（v3 的标记早落了 ⇒ 改 v3 等于永远不会重跑），而且这一趟
   *        **要按名字现读一次库**：v1~v4 可能刚建出那几格，而 `tree` 那份快照里还没有它们。
   *
   * @param {number} uid - 账号 id
   * @param {Object} tree - `pickDigitalTree()` 回的树（要它的 `rootId` / `sections` / `cats`）
   * @returns {boolean} 这一趟动过（true = 调用方应重取一次树）；各趟的标记都已在 / 压根没这棵树时 false
   */
  _ensureDigitalSections(uid, tree) {
    if (!tree || tree.rootId === null) return false;
    // ⚠️ `assets` 模块目录被整个删掉时没有这个方法 —— 那就不建（分类功能本来就不可用了）
    if (typeof this.createAssetGroup !== 'function') return false;
    const id = Number(uid);
    /** 功能：读一个一次性标记（极端装配下取不到 ⇒ 当成「没做过」，让这一趟照跑 —— 两趟都幂等）。 @param {string} k - 键名 @returns {string} 值 */
    const readFlag = (k) => (typeof this.getSetting === 'function' ? this.getSetting(k) : '');
    /** 功能：落一个一次性标记。 @param {string} k - 键名 @returns {void} */
    const setFlag = (k) => {
      if (typeof this.setSetting === 'function') this.setSetting(k, '1');
    };
    /** 这一趟有没有真动过东西（动过 ⇒ 调用方要重取一次树）。 @type {boolean} */
    let touched = false;

    // ---- v1：内置子类别「NAS硬件管理」（老数据的家）＋ 老 `category` 搬家 ----
    if (readFlag('digital_sections_v1_' + id) !== '1') {
      try {
        this._assertWritable();
        // ⚠️ 先置 `touched`：中途抛错时也要让调用方重取一次树（那一刻可能刚建出格子）
        touched = true;
        // ① 子类别的家：叫「NAS硬件管理」的那一格。
        const home = tree.sections.find((s) => s.name === SEC_NAS) || null;
        let homeId = home ? home.id : null;
        if (homeId === null) {
          // ⚠️ 0.8.23 起走 `seedSection()`：内置格带 `builtin = 1`（界面上不给删、后端也拦）
          homeId = Number(seedSection(this, id, { name: SEC_NAS, parent_id: tree.rootId }).id);
        }

        // ② 老 `category` 文本 → 「NAS硬件管理」下面的子分类（按名字复用），并回填 `group_id`
        const subOfHome = new Map();
        for (const c of tree.cats) if (c.parent_id === homeId) subOfHome.set(c.name, c.id);
        const created = new Map();
        const pending = this._bk
          .listHardware(id)
          .filter((h) => {
            const gid = h.group_id === null || h.group_id === undefined || h.group_id === '' ? null : Number(h.group_id);
            return gid === null && String(h.category || '').trim();
          })
          // ⚠️ 按 id 升序搬：子分类在树里的先后就照「这条硬件的记录顺序」定。
          //    ⛔ 不能依赖 `_bk` 的返回顺序 —— 那是后端的实现细节，换个后端顺序就变了
          //    （顺序对用户可见，两个后端必须给同一个）。
          .sort((a, b) => Number(a.id) - Number(b.id));
        for (const h of pending) {
          const name = String(h.category).trim();
          let gid = subOfHome.get(name) || created.get(name) || null;
          if (gid === null) {
            gid = Number(this.createAssetGroup(id, { name, parent_id: homeId }).id);
            created.set(name, gid);
          }
          this._update('hardware_items', id, h.id, { group_id: gid });
        }

        // ③ 标记：⛔ 必须排在最后 —— 中途抛错就靠「没标记」让下一趟重跑（见说明最后一条）
        setFlag('digital_sections_v1_' + id);
      } catch {
        // 只读降级 / 某一条写不动：静默收尾，下次取数再补（标记没落 ⇒ 会整段重跑，重跑安全）
      }
    }

    // ---- v2（⭐ 0.8.22）：第二个内置子类别「电子产品管理」----
    if (readFlag('digital_sections_v2_' + id) !== '1') {
      try {
        this._assertWritable();
        touched = true;
        // ⚠️ 按名字找**只在这一趟**（标记落下去之后就不再找）—— 用户改名不会被骗到、不会重复建一格。
        if (!tree.sections.some((s) => s.name === SEC_ELEC)) {
          seedSection(this, id, { name: SEC_ELEC, parent_id: tree.rootId });
        }
        setFlag('digital_sections_v2_' + id);
      } catch {
        // 只读降级：下次取数再补
      }
    }

    // ---- v3（⭐ 0.8.23）：给**已经建出来**的两个内置子类别补上 `builtin` 标记 ----
    if (readFlag('digital_sections_v3_' + id) !== '1') {
      try {
        this._assertWritable();
        // ⚠️⭐ 为什么必须另起一趟：真机上装过 0.8.22 的库里，那两格**早就建出来了**
        //    （`asset_groups.builtin` 是补列补出来的 0），v1/v2 的标记也早落了 ⇒ 不会再跑。
        //    光靠 `seedSection()` 补不上标记，表现就是「预制的格照样删得掉」。
        // ⚠️ 按名字找**只在这一趟**（与 v2 同一条纪律）：一次性、幂等、之后不再看名字。
        //    用户已经给内置格改过名的极端情形下补不上（只能任它去）—— 这是没有历史标识的存量
        //    数据必然要付的代价；从本版起新播种的格一律带着 `builtin` 出生，不再有这个问题。
        // ⚠️ 只在 `assets` 提供了那条通道时做（旧版 / 目录被删时静默放过，⛔ 不上抛）。
        if (typeof this.markAssetGroupBuiltin === 'function') {
          for (const name of BUILTIN_SECTIONS) {
            const sec = tree.sections.find((s) => s.name === name);
            if (sec && !sec.builtin) {
              touched = true;
              this.markAssetGroupBuiltin(id, sec.id);
            }
          }
        }
        setFlag('digital_sections_v3_' + id);
      } catch {
        // 只读降级：下次取数再补（标记没落 ⇒ 会重跑，重跑安全）
      }
    }

    // ---- v4（⭐⭐ 0.8.24）：第三个内置类别「家用电器管理」----
    if (readFlag('digital_sections_v4_' + id) !== '1') {
      try {
        this._assertWritable();
        touched = true;
        // ⚠️ 按名字找**只在这一趟**（与 v2 / v3 同一条纪律）：一次性、幂等、之后不再看名字。
        const hit = tree.sections.find((s) => s.name === SEC_APPL) || null;
        if (!hit) {
          seedSection(this, id, { name: SEC_APPL, parent_id: tree.rootId });
        } else if (!hit.builtin && typeof this.markAssetGroupBuiltin === 'function') {
          // 存量库里已经有一格同名的（用户自建 / 早版本建的）⇒ 就地补 `builtin`，
          // 否则「预制的格不可删不可改名」对它就形同虚设（与 v3 同一条理由）。
          this.markAssetGroupBuiltin(id, hit.id);
        }
        setFlag('digital_sections_v4_' + id);
      } catch {
        // 只读降级：下次取数再补（标记没落 ⇒ 会重跑，重跑安全）
      }
    }

    // ---- v5（⭐⭐ 0.8.24）：三个内置类别下各播 6 条**预置分类** ----
    if (readFlag('digital_sections_v5_' + id) !== '1') {
      try {
        this._assertWritable();
        // ⚠️⭐ 必须**按名字现读一次库**：v1~v4 可能刚把某几格建出来，而 `tree` 那份快照是
        //    调用方在**这一趟之前**取的，里面还没有它们（复用快照 = 分类永远播不上去，
        //    而且一句提示都没有）。
        const fresh = typeof this.listAssetGroups === 'function' ? this.listAssetGroups(id).groups : [];
        /** 取某一行的父 id（空值一律当「第一层」）。 @param {Object} g - 一行分组 @returns {?(number|string)} */
        const parentOf = (g) =>
          g.parent_id === null || g.parent_id === undefined || g.parent_id === '' ? null : Number(g.parent_id);
        let changed = false;
        for (const secName of BUILTIN_SECTIONS) {
          // ⚠️ 认「挂在根格下面、名字是内置名」的那一格 —— 只看名字会在用户自建了同名**顶层**格时认错。
          const sec = fresh.find((g) => g.name === secName && parentOf(g) === tree.rootId) || null;
          if (!sec) continue;
          const pid = Number(sec.id);
          const have = new Set(fresh.filter((g) => parentOf(g) === pid).map((g) => String(g.name)));
          for (const cat of BUILTIN_CATS[secName] || []) {
            if (have.has(cat)) continue;
            // ⚠️ 走普通 `createAssetGroup`（⛔ 不是 `seedSection`）：预置分类**不带** `builtin`
            //    —— 删得掉、改得了名（只把「不可删不可改名」给了那三个类别本身）。
            this.createAssetGroup(id, { name: cat, parent_id: pid });
            have.add(cat);
            changed = true;
          }
        }
        if (changed) touched = true;
        setFlag('digital_sections_v5_' + id);
      } catch {
        // 只读降级：下次取数再补（标记没落 ⇒ 会重跑，重跑安全）
      }
    }
    return touched;
  },

  // ---- ⭐⭐ 0.8.23：硬件模板（「预制新建硬件的模板菜单」）----

  /**
   * 功能：列出该账号的模板（内置 11 个 + 自建）—— 顺带把内置那些**幂等播种**出来。
   *
   * 说明：⭐ 返回值已经过 `shapeTemplate()` 整形（内置模板的预置字段以**代码**为准、
   *      用户追加的自定义属性接在后面）。⚠️ 与硬件列表同一条口径：**读的时候顺手把该有的补上**，
   *      前端不必先调一次「初始化」接口 —— 与 `_ensureDigitalSections()` / `assets` 的懒播种同款。
   *
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} `[{ id, name, builtin, fields }]`（内置在前、自建在后）
   */
  listHardwareTemplates(uid) {
    const id = Number(uid);
    this._ensureHardwareTemplates(id);
    return this._bk.listHardwareTemplates(id).map(shapeTemplate);
  },

  /**
   * 功能：把 `lib/templates.js` 里那 11 个**内置模板**幂等播种进库（只建缺的，⛔ 一个都不覆盖）。
   *
   * 说明：⭐ 与 `assets` 那边「懒播种两个默认格」同一条口径：**只在缺的时候建** ⇒
   *      用户永远不会被重复建一个，而「内置的一直在」也由它保证。
   *      ⚠️⭐ 只按**名字 + `builtin = 1`** 判「缺不缺」—— ⛔ 不拿名字当「是不是内置」的判据
   *      （那个判据永远是行上的 `builtin`）；这里用名字只是为了「同一个模板别播两遍」。
   *      ⚠️ `fields` 播成空数组：**内置模板的这一列只装用户追加的自定义属性**，预置那几项
   *      住在代码里（`shapeTemplate()` 每次读都会重建）⇒ 库里不会留一份会过期的副本。
   *      ⚠️ `sort_order` 接在**已有内置行**之后（+10 递进）；自建模板从 1000 往后
   *      （见 `_nextTemplateSort()`）⇒「预制的在前、自己加的在后」是**数据**保证的。
   *      ⚠️ 失败（只读降级）静默收尾：模板短几个不影响看台账，下次取数再补。
   *
   * @param {number} uid - 账号 id
   * @returns {void}
   */
  _ensureHardwareTemplates(uid) {
    let rows;
    try {
      rows = this._bk.listHardwareTemplates(Number(uid));
    } catch {
      return; // 表读不到（极端装配）⇒ 这一次就不播种
    }
    const have = new Set(rows.filter((r) => Number(r.builtin)).map((r) => String(r.name || '')));
    const missing = BUILTIN_TEMPLATES.filter((t) => !have.has(t.name));
    if (!missing.length) return;
    try {
      this._assertWritable();
      const stamp = nowStamp();
      // ⚠️ 起点接在**已有的内置行**之后（老库里可能已经播过一部分 —— 比如上一版播了 10 个、
      //    这一版才补上「通用」）⇒ 取「已有内置的最大 sort_order」再往上加，⛔ 别从 10 从头数
      //    （那会插到预制的中间去）。
      let order = 0;
      for (const r of rows) if (Number(r.builtin)) order = Math.max(order, Number(r.sort_order) || 0);
      for (const t of missing) {
        order += 10;
        this._insert('hardware_templates', {
          user_id: Number(uid),
          name: t.name,
          builtin: 1,
          fields: '[]',
          sort_order: order,
          created_at: stamp,
          updated_at: stamp,
        });
      }
    } catch {
      // 只读降级 / 播种失败：模板列表短几个，下次取数再补（⛔ 不上抛）
    }
  },

  /**
   * 功能：判断某个模板是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 账号 id
   * @param {number} id - 模板 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsHardwareTemplate(uid, id) {
    return this._bk.ownsHardwareTemplate(Number(uid), Number(id));
  },

  /**
   * 功能：新建一个**自建模板**（名字 + 一组专业参数）。
   *
   * 说明：⚠️ 名字与 11 个内置模板撞了直接 **400** —— 撞名的后果是「新建时那一排里出现两个
   *      『硬盘』」，用户分不清哪个是他自己建的（`hardware_templates` 上⛔ 没有唯一约束，
   *      这条规则只能写在业务层）。
   *      ⚠️ 自建模板的 `fields` 就是**全部字段**（与内置那 11 个「这一列只装追加部分」相反）——
   *      两边的差别由 `shapeTemplate()` 一处封住，调用方看不出来。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - `{ name, fields }`
   * @returns {Object} 新建的模板（已整形）
   * @throws {Error} 名字为空 / 与内置撞名 / **与本人已有的模板重名** ⇒ 400；数据层只读时抛 503
   */
  createHardwareTemplate(uid, input) {
    this._assertWritable();
    const name = String((input && input.name) || '').trim();
    if (!name) throw badRequest('模板名不能为空');
    if (BUILTIN_TEMPLATES.some((t) => t.name === name)) {
      throw badRequest(`「${name}」是预制的模板名，换一个`);
    }
    // ⭐⭐ 0.8.24 任务六（「模板名称必须唯一」）：本人已有的模板里也不许撞名
    if (findSameNameTemplate(this, uid, name, null)) throw badRequest(`已经有同名的模板「${name}」了`);
    const stamp = nowStamp();
    const row = this._insert('hardware_templates', {
      user_id: Number(uid),
      name,
      builtin: 0,
      fields: JSON.stringify(normalizeFields(input && input.fields)),
      sort_order: this._nextTemplateSort(Number(uid)),
      created_at: stamp,
      updated_at: stamp,
    });
    return shapeTemplate(row);
  },

  /**
   * 功能：改一个模板 —— **自建**的可改名 / 改字段；**内置**的只能**加自定义属性**
   *      ＋（⭐⭐ 任务五起）**改那几个下拉字段的选项清单**。
   *
   * 说明：⭐⭐ 「内置10个不可以删除和修改（但可以添加自定义属性）」
   *      ⇒ 内置模板传 `name` 且与当前**不同** ⇒ **400**（把同名原值传回来是常态，
   *      ⛔ 不该被打成 400）。
   *      ⭐⭐ 0.8.24 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和
   *      修改的，只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
   *      传 `fields` 时，与预置字段**同 key** 的那些**留**下来 —— 但只留 `key` 与 `opts`
   *      （那就是「用户改过的选项清单」，见 `shapeTemplate()`）；其余预置键上的东西
   *      （名字 / 提示 / 条件）一律丢掉，有人绕过界面塞进来只会被丢掉而不是「库变脏」
   *      （失败方向是安全的）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 模板 id
   * @param {Object} input - `{ name?, fields? }`
   * @returns {Object} 更新后的模板（已整形）
   * @throws {Error} 模板不存在 ⇒ 404；内置改名 / 名字为空 / **改成与本人别的模板同名** ⇒ 400；数据层只读时抛 503
   */
  updateHardwareTemplate(uid, id, input) {
    this._assertWritable();
    const cur = this._bk.getHardwareTemplate(Number(uid), Number(id));
    if (!cur) throw notFoundErr('这个模板');
    const builtin = Number(cur.builtin) > 0;
    const patch = {};
    if (input && input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!name) throw badRequest('模板名不能为空');
      if (builtin) {
        if (name !== String(cur.name || '')) throw badRequest('预制的模板不能改名');
      } else if (BUILTIN_TEMPLATES.some((t) => t.name === name) && name !== String(cur.name || '')) {
        throw badRequest(`「${name}」是预制的模板名，换一个`);
      } else {
        // ⭐⭐ 0.8.24 任务六（「模板名称必须唯一」）：改名同样不许撞上本人别的模板
        //    （只挡新建是没用的：改个名照样能造出两条同名的）。⚠️ 名字没变直接放行（回传同值是常态）。
        if (name !== String(cur.name || '') && findSameNameTemplate(this, uid, name, id)) {
          throw badRequest(`已经有同名的模板「${name}」了`);
        }
        patch.name = name;
      }
    }
    if (input && input.fields !== undefined) {
      const fields = normalizeFields(input.fields);
      const preset = builtin ? BUILTIN_TEMPLATES.find((t) => t.name === String(cur.name || '')) : null;
      if (preset) {
        // ⭐⭐ 0.8.24 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的，
        //    只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
        //    与预置字段**同 key** 的那些 = 用户改过的**选项清单**（覆盖），⛔ 只留 `key` 与 `opts`：
        //    `label` / `ph` 归代码（有人手工塞一份改过名的进来只会被丢掉 —— 失败方向是安全的）。
        //    ⚠️ `opts` 为空**照样落库**：那是「用户把选项全删了」（那一项退化成文本），
        //    所以这里按「键在不在」判，⛔ 不看 `opts` 长不长。
        const pset = new Set(preset.fields.map((f) => f.key));
        const overrides = [];
        const mine = [];
        for (const f of fields) {
          if (!pset.has(f.key)) {
            mine.push(f);
            continue;
          }
          const code = preset.fields.find((x) => x.key === f.key);
          const o = { key: f.key, label: code.label };
          const opts = normOpts(f.opts);
          if (opts.length) o.opts = opts;
          overrides.push(o);
        }
        patch.fields = JSON.stringify([...overrides, ...mine]);
      } else {
        patch.fields = JSON.stringify(fields);
      }
    }
    if (!Object.keys(patch).length) return shapeTemplate(cur);
    this._update('hardware_templates', Number(uid), Number(id), patch);
    return shapeTemplate(this._bk.getHardwareTemplate(Number(uid), Number(id)));
  },

  /**
   * 功能：删一个**自建**模板（预制的 400）。
   *
   * 说明：⚠️ 用它的那些硬件**一条都不会丢** —— `hardware_items.template_id` 上⛔ 没有外键，
   *      删掉模板之后那些行在界面上按「通用」显示（与「删分类只解绑」同一条口径；
   *      前端那个确认框里也要这么写，见 `delHwTemplate()`）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 模板 id
   * @returns {boolean} 是否真的删掉了
   * @throws {Error} 模板不存在 ⇒ 404；预制的模板 ⇒ 400；数据层只读时抛 503
   */
  removeHardwareTemplate(uid, id) {
    this._assertWritable();
    const cur = this._bk.getHardwareTemplate(Number(uid), Number(id));
    if (!cur) throw notFoundErr('这个模板');
    if (Number(cur.builtin) > 0) throw badRequest('预制的模板删不了');
    return this._bk.deleteHardwareTemplate(Number(uid), Number(id));
  },

  /**
   * 功能：给自建模板挑一个**排在所有内置之后**的顺序号。
   *
   * 说明：⚠️ 起点 1000（内置那 11 个最多到 110）—— 就算有人把某个内置行的 `sort_order`
   *      手工改大了，也只是「新的接在它后面」，⛔ 不会插到预制的中间去。
   *
   * @param {number} uid - 账号 id
   * @returns {number} 顺序号
   */
  _nextTemplateSort(uid) {
    let max = 990;
    for (const r of this._bk.listHardwareTemplates(Number(uid))) {
      const s = Number(r.sort_order) || 0;
      if (s > max) max = s;
    }
    return max + 10;
  },
};
