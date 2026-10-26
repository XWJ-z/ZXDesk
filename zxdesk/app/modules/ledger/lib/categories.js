'use strict';
/**
 * modules/ledger/lib/categories.js —— 记账的**收支分类**预置与口径（全模块唯一出处）
 *
 * 功能：给出内置的 **22 行**收支分类（`CATEGORY_PRESETS`）、旧清单名册（`LEGACY_PRESET_NAMES`）、兜底分类名（`OTHER_NAME`）、
 *      分类名长度上限（`MAX_CATEGORY_NAME`）、「这一行是不是兜底分类」的唯一判据（`isOther`）与
 *      「全称唯一」这一族的两个纯函数（`fullNameOf` / `nameTaken`，与前端同口径）。
 *
 * ⭐⭐ **内置清单是定稿的，⛔ 不再照抄一手样本**：
 *    原来是「照 `docs/fnos/记账数据/鲨鱼记账明细*.csv` 的实测结果抄 34 行」（旧 第 4 条 / C-35）——
 *    他看过之后**自己定了一份 22 行**的清单（支出 15 ＋ 收入 7）⇒ 以后以他指定的清单为准。
 *    ⚠️ 这一份同时就是「**用户不可删除、不可改名、不可归档**」的那批
 *    （判据看行上的 `builtin` 字段，⛔ **不看名字** —— 用户也能建一个叫「餐饮」的）。
 *    ⚠️ 旧那份 34 行的名字留在 `LEGACY_PRESET_NAMES`（只给「恢复内置分类」认人用）。
 *
 * ⭐⭐ **`其它` 有两行**（支出侧一行、收入侧一行）—— 这把「兜底分类」的判据从
 *    「名字等于其它」收窄成了「**同一个 `ie` 下**名字等于其它」：
 *    · 它**不可归档 / 不可删除 / 永远留在选择器里**（否则「移动到其它」没有落点）；
 *    · ⭐ **「移动到其它」必须移到同一侧那一行**（父分类的 `ie`）——
 *      把 `餐饮` 的子分类挪到收入侧那个「其它」下面，是**静默把一笔支出变成收入**。
 *    ⇒ 判据一律走 `isOther(category, ie)`，⛔ 别在业务层自己写 `name === '其它'`
 *    （双份判据必然漂移）。
 *
 * ⚠️⭐ **「未分类」与「其它」是两个不同的东西**：没选分类 ⇒
 *    `ledger_entries.category_id` 为 `NULL`、界面显示「**未分类**」；而「其它」是一个
 *    **用户主动选的真分类**。⛔ 两个词不许混用（1 期在账户用途那一套就踩过"两个同名它"的坑）。
 *
 * ⚠️ **`sort_order` 怎么填**：本数组的**下标就是 `sort_order`**（0 起、全局 0~21）——
 *    seed 时照下标写。两侧各自内部的先后就是上面那张表的先后（前端按 `ie` 过滤后再按
 *    `sort_order` 排，于是"两侧各自从 0 开始"与"全局编号"在显示上等价）。
 *
 * ⚠️ **预置只在「这个账号一个分类都没有」时灌一次**（照 1 期 `seedLedger()` 的幂等做法，
 *    ⛔ 不做「缺哪行补哪行」—— 否则用户删掉的分类会**复活**）。灌库那一步不在这里，
 *    这里只有数据（本文件是纯数据 ＋ 纯函数，⛔ 不碰数据库）。
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.8.4
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/21-记账2期-记账.md §4.4
 */

/**
 * 兜底分类名 —— 「移动到其它」的落点、永远留在选择器里的那个名字。
 *
 * 说明：⚠️⭐ 它**两侧各有一行**（支出 / 收入）⇒ 光比名字**不够**，判据见 `isOther()`。
 * @type {string}
 */
const OTHER_NAME = '其它';

/**
 * 分类名长度上限。
 *
 * 说明：⚠️⭐ **与 1 期账户名同一个上限**（`modules/ledger/routes.js` 的 `NAME_MAX = 60`，
 *      那里注释写着「方案 §六 的入参校验表写的就是 60」）—— 分类名与账户名是同一档的
 *      "短标签"，取同一个数就少一条要维护的口径。
 *      ⚠️ 本文件**刻意不 require `routes.js`**：路由层会反过来 require 本模块的 lib，
 *      反向依赖会变成循环（而且 `NAME_MAX` 是路由层内部的局部常量，压根没导出）。
 *      ⇒ 两处各写一份，**靠这条注释互相指路**；改一处必须同改另一处。
 * @type {number}
 */
const MAX_CATEGORY_NAME = 60;

/**
 * ⭐⭐ **内置的收支分类 —— 22 行**（支出 15 ＋ 收入 7）：用户**不能删除、不能改名、不能归档**。
 *
 * 说明：⭐ **顺序即 `sort_order`**（数组下标，0 起）：支出侧 0~14、收入侧 15~21。
 *      ⚠️ `ie` 只在一级分类上填（二级为 `NULL`、继承父）—— 所以这里每一行都带 `ie`。
 *      ⚠️ 名字刻意**允许重名**（两侧各有一行 `其它`，分属收支）——
 *      `ledger_categories` 因此**没有唯一约束**（与账户名同一条纪律）。
 *      ⭐ 「哪几行是内置」**由行上的 `builtin` 字段说了算**（seed 写 1、用户新建写 0）——
 *      ⛔ 不靠名字认：用户也能建一个叫「餐饮」的，那一行是**自定义**、可以删可以改名。
 * @type {Array.<{ie: string, name: string}>}
 */
const CATEGORY_PRESETS = [
  // ── 支出 15 个（⭐ 既定的清单，顺序即是这里的先后）
  { ie: '支出', name: '餐饮' },
  { ie: '支出', name: '交通' },
  { ie: '支出', name: '日用' },
  { ie: '支出', name: '学习' },
  { ie: '支出', name: '通讯' },
  { ie: '支出', name: '购物' },
  { ie: '支出', name: '医疗' },
  { ie: '支出', name: '娱乐' },
  { ie: '支出', name: '快递' },
  { ie: '支出', name: '数码' },
  { ie: '支出', name: '办公' },
  { ie: '支出', name: '家庭' },
  { ie: '支出', name: '社交' },
  { ie: '支出', name: '长辈' },
  // ⭐ 支出侧的兜底分类（见 OTHER_NAME）
  { ie: '支出', name: '其它' },
  // ── 收入 7 个
  { ie: '收入', name: '工资' },
  { ie: '收入', name: '奖金' },
  { ie: '收入', name: '补贴' },
  { ie: '收入', name: '兼职' },
  { ie: '收入', name: '理财' },
  { ie: '收入', name: '礼金' },
  // ⭐ 收入侧的兜底分类（另一行「其它」，判据必须连 `ie` 一起看）
  { ie: '收入', name: '其它' },
];

/**
 * ⭐ **旧版（0.8.1 之前那一版）预置分类的名字全集** —— 只给「恢复内置分类」当**识别用的名单**。
 *
 * 说明：⭐⭐ 这一份是**一次性历史包袱**，⛔ 不是第二个真相源：
 *      · 把内置清单从 **34 行换成 22 行**（支出 15 ＋ 收入 7，见 `CATEGORY_PRESETS`）。
 *        换之前已经用过旧清单的账号，库里还留着旧的那些行（例如 `恋爱日常` / `各类会员`），
 *        而且**它们身上没有「内置」标记**（`builtin` 列是这回才加的）⇒ 光看行本身分不出
 *        「旧的预置」与「用户自己建的」。
 *      · ⇒ 「恢复内置分类」这个动作**按名字**认人：`name` 在这份名单里、且**不在**新清单里
 *        的那些一级分类，才算「旧预置」，才删。
 *        ⚠️ 副作用（已知并接受）：用户若**恰好**给自己的分类起了旧清单里的名字（例如他自己建了个
 *        「零食」），那次恢复会把它一起删掉 —— 名字撞车无法在数据层区分，这是这份名单的代价。
 *      · ⛔ **别再往这里加东西**：它是「换清单那一刻的遗留」，不是「所有用过的名字」。
 * @type {Array.<string>}
 */
const LEGACY_PRESET_NAMES = [
  '餐饮', '交通', '嵌入式', '恋爱日常', '日用', '学习', '通讯', '购物', '医疗',
  '各类会员', '娱乐', '快递', '数码', '打印', '红包', '保险', '汇总', '其它',
  '办公', '服饰', '零食', '社交', '头发', '学费', '长辈',
  '生活费', '宝宝给的', '理财', '奖金', '补贴', '赚外快', '宝宝的',
];

/**
 * 功能：判断一个分类行是不是**兜底分类「其它」**（本模块判「不可归档 / 不可删除」的唯一判据）。
 *
 * 说明：⭐⭐ 判据有两层，**缺一层就会静默出错**：
 *      ① 名字必须等于 `OTHER_NAME`；
 *      ② 给了 `ie` 时，还要求**同一侧**（`category.ie === ie`）——
 *         因为「其它」有**两行**，而「移动到其它」必须是「移到**同一侧**那一行」。
 *      ⚠️ 不传 `ie` 就只判名字（用于「这一行是不是兜底分类」这种与侧无关的问题）；
 *      ⚠️ 二级分类的 `ie` 是 `NULL`（继承父）⇒ 传了 `ie` 时它不会命中（本来也不该命中：
 *      兜底分类只可能是一级）。
 *
 * @param {Object} category - 分类行（至少要有 `name`，可选 `ie`）
 * @param {?string} [ie] - 要校验的哪一侧（`'支出'` / `'收入'`）；省略 = 不校验侧
 * @returns {boolean} 是兜底分类为 true
 */
function isOther(category, ie) {
  const cat = category && typeof category === 'object' ? category : {};
  if (String(cat.name == null ? '' : cat.name) !== OTHER_NAME) return false;
  if (ie == null) return true;
  return String(cat.ie == null ? '' : cat.ie) === String(ie);
}

/**
 * 功能：一个收支分类的**全称** —— 一级就是它自己的名字；二级是「父名-本名」。
 *
 * 说明：⭐⭐ 这就是「二级分类本质是带上了上级的名字」：`餐饮` 下的 `早餐` 全称是 `餐饮-早餐`
 *      ⇒ 它与 `聚会` 下的 `早餐`（全称 `聚会-早餐`）**不算重复**。
 *      ⚠️ 父取不到（清单里没有那一行）时**退化成它自己的名字**，⛔ 不抛、也不拼一个空的 `-`：
 *      这一层只做判重，真正的动作在 `store.js`（那里父一定在）。
 *      ⚠️⚠️ 本函数与前端 `public/modules/ledger/calc.js` 的 `catFullName()` **必须同口径**
 *      —— `ttt/test/ledger.test.js` 有一条护栏拿同一组样例逐项比对两边（⛔ 别只改一份）。
 *
 * @param {Array.<Object>} cats - 整份分类清单（用来找父）
 * @param {Object} cat - 一个分类（`{id, name, parent_id}`）
 * @returns {string} 全称
 * @since 0.8.2
 */
function fullNameOf(cats, cat) {
  const c = cat && typeof cat === 'object' ? cat : {};
  const name = String(c.name == null ? '' : c.name);
  const pid = Number(c.parent_id) || 0;
  if (!pid) return name;
  const parent = (Array.isArray(cats) ? cats : []).find((x) => Number(x.id) === pid);
  return parent ? `${String(parent.name == null ? '' : parent.name)}-${name}` : name;
}

/**
 * 功能：判一个**全称**是不是已经被别的分类占了（新建 / 改名时的检测）。
 *
 * 说明：⭐⭐ **重名范围 = 全称全局唯一**：把每个分类都算成 `fullNameOf()` 的全称，
 *      **整个账号内**不许有两个分类的全称相同 —— 跨支出 / 收入也算、一级与二级的全称之间也算
 *      （所以已有二级叫 `餐饮-早餐` 时，不许再建一个**名字就叫** `餐饮-早餐` 的一级）。
 *      ⚠️⭐ **不排除已归档的**：归档的只是「选不到」，名字还占着（不然「恢复使用」会当场撞名）。
 *      ⚠️ **不做全库唯一性体检**：内置兜底分类「其它」支出 / 收入**各有一行**（存量就有两个同名）
 *      ⇒ 这条规则只拦「**新建 / 改名**那一下」，⛔ 不是对全库做一次唯一性校验。
 *      ⚠️⚠️ 本函数与前端 `public/modules/ledger/calc.js` 的 `catNameTaken()` **必须同口径**。
 *
 * @param {Array.<Object>} cats - 整份分类清单（**含已归档的**，见上面那段说明）
 * @param {string} full - 候选全称（`fullNameOf()` 的产物）
 * @param {number} [selfId] - 改名时传自己的 id（**排除自己**，否则改回原名会说「重复」）；新建传 0
 * @returns {string} 撞上的那个全称（没撞 ＝ 空串）
 * @since 0.8.2
 */
function nameTaken(cats, full, selfId) {
  const want = String(full == null ? '' : full).trim();
  if (!want) return '';
  const self = Number(selfId) || 0;
  const list = Array.isArray(cats) ? cats : [];
  const hit = list.find((c) => Number(c.id) !== self && fullNameOf(list, c) === want);
  return hit ? want : '';
}

module.exports = {
  CATEGORY_PRESETS,
  LEGACY_PRESET_NAMES,
  OTHER_NAME,
  MAX_CATEGORY_NAME,
  isOther,
  fullNameOf,
  nameTaken,
};
