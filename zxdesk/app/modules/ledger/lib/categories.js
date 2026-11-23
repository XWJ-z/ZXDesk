'use strict';
/**
 * modules/ledger/lib/categories.js —— 记账的**收支分类**预置与口径（全模块唯一出处）
 * 功能：给出内置的 **22 行**收支分类（`CATEGORY_PRESETS`）、旧清单名册（`LEGACY_PRESET_NAMES`）、兜底分类名（`OTHER_NAME`）、
 * 分类名长度上限（`MAX_CATEGORY_NAME`）、「这一行是不是兜底分类」的唯一判据（`isOther`）与
 * @author zx
 * @date   2026-09-22
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/21-记账2期-记账.md §4.4
 */

/**
 * 兜底分类名 —— 「移动到其它」的落点、永远留在选择器里的那个名字。
 *
 */
const OTHER_NAME = '其它';

/**
 * 分类名长度上限。
 *
 */
const MAX_CATEGORY_NAME = 60;

/**
 * **内置的收支分类 —— 22 行**（支出 15 ＋ 收入 7）：用户**不能删除、不能改名、不能归档**。
 *
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
  // 支出侧的兜底分类（见 OTHER_NAME）
  { ie: '支出', name: '其它' },
  // ── 收入 7 个
  { ie: '收入', name: '工资' },
  { ie: '收入', name: '奖金' },
  { ie: '收入', name: '补贴' },
  { ie: '收入', name: '兼职' },
  { ie: '收入', name: '理财' },
  { ie: '收入', name: '礼金' },
  // 收入侧的兜底分类（另一行「其它」，判据必须连 `ie` 一起看）
  { ie: '收入', name: '其它' },
];

/**
 *
 * 说明：⭐⭐ 这一份是**一次性历史包袱**，⛔ 不是第二个真相源：
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
 * ① 名字必须等于 `OTHER_NAME`；
 * ② 给了 `ie` 时，还要求**同一侧**（`category.ie === ie`）——
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
 * ⇒ 它与 `聚会` 下的 `早餐`（全称 `聚会-早餐`）**不算重复**。
 * 父取不到（清单里没有那一行）时**退化成它自己的名字**，⛔ 不抛、也不拼一个空的 `-`：
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
 * **不做全库唯一性体检**：内置兜底分类「其它」支出 / 收入**各有一行**（存量就有两个同名）
 * ⇒ 这条规则只拦「**新建 / 改名**那一下」，⛔ 不是对全库做一次唯一性校验。
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
