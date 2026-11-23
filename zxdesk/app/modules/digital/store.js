'use strict';
/**
 * modules/hardware/store.js —— NAS硬件管理业务方法
 * 功能：硬件台账 / 愿望单的业务方法 —— `listHardware`（多词 AND 检索 + 状态 / 分类筛选 + 只看需关注
 * + **逐条挂上寿命口径** + **排序** + 汇总）/ `getHardware` / `ownsHardware` / `createHardware` /
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/架构文档/26-个人资产管理.md、docs/公共/开发方案/04-NAS硬件管理-1期.md
 */
const { nowStamp, today, notFoundErr, badRequest, splitTerms } = require('../../core/store/helpers.js');
const { lifeOf } = require('./lib/life.js');
const { BUILTIN_TEMPLATES, GENERIC_TEMPLATE_NAME } = require('./lib/templates.js');

/** 三值状态机：想买 → 在用 → 退役 */
const STATUSES = ['wishlist', 'owned', 'retired'];

/**
 * 旧的四档是 `alert` / `new` / `due` / `price`，界面上写成「该看的在前 / 最近添加 /
 * 快到期的在前 / 最贵的在前」—— 这些说法**描述的是结果而不是字段**，用户没法预判排出来是什么顺序。
 */
const SORTS = ['used', 'remain', 'price', 'new'];

/**
 * 功能：按排序键 + 方向把列表排好 —— 四档真字段：`used` / `remain` / `price` / `new`。
 *
 * 说明：⭐ 四个键都带 `id DESC` 兜底：同一档内必须**顺序确定**，
 * 「算不出来」的行（没填购买日期 / 没填预期寿命）**一律排最后**，
 * （见 `lib/life.js` 文件头红线 2）。
 */
function sortHardware(items, key, desc) {
  const byIdDesc = (a, b) => Number(b.id) - Number(a.id);
  // 降序不是「把比较结果取反」就完事：取反会把「算不出来」一起翻到最前面。
  // 所以先按「有没有值」分堆（有值永远在前），再在堆内按方向比。
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
 * 乘上去会把「两条内存 398 元」算成 796 元（界面上的口径提示写着这句话，别改一处）。
 *
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
 * 这九处哪一处命中都算。容量与商家必须在里面：用户想找一块盘时脑子里是
 * 「希捷 4T」（品牌 + 容量），而不是完整型号。
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
 * 不代表这件硬件出了问题（方案 的补充）。
 * 只看**在用**的件：退役的不提醒（已经拆下来了），愿望单没有购买日期（天然不提醒）。
 */
function isAlert(item) {
  if (!item || item.status !== 'owned') return false;
  const life = item.life || {};
  if (life.level === 'soon' || life.level === 'over') return true;
  return life.warranty === 'soon' || life.warranty === 'over';
}

/**
 *
 * 说明：⭐ 判据是 `module_key === 'digital'` —— 那一行由 `assets` 模块**懒播种**出来
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
      // `asset_groups.builtin`（系统预置 = 界面上不给删）—— 随树带出来，
      // 左栏那两级与管理弹窗都靠它决定「这一行给不给删除键」。
      // 判据只此一处：⛔ 前端别自己拿名字去比（用户能改名，比名字必然认错）。
      builtin: Number(g.builtin) > 0,
    };
    cats.push(node);
    // `depth === 0` = 根的直接子 = **子类别**（左栏那一列）；`cats` 里更深的都是子分类。
    if (node.depth === 0) sections.push(node);
  }
  return { rootId, sections, cats, ids, names };
}

/**
 *
 * 说明：⭐ 选「电脑」时连带「电脑 › 相机」的条目一起出来 —— 树语义（父是汇总，子是细分）。
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
 *
 * 说明：⭐ 界面上选中的可能是子类别（左栏那一列），也可能是它下面的子分类（右栏下拉）——
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
 */
const BUILTIN_SECTIONS = ['NAS硬件管理', '电子产品管理', '家用电器管理'];

/** 上面那三份内置格的「第几格」（v1 / v2 / v4 各自建一个）。 */
const SEC_NAS = BUILTIN_SECTIONS[0];
const SEC_ELEC = BUILTIN_SECTIONS[1];
const SEC_APPL = BUILTIN_SECTIONS[2];

/**
 * 三个内置类别下**各预置哪几条分类**（选的「每类 6 条」）。
 *
 */
const BUILTIN_CATS = {
  [SEC_NAS]: ['硬盘', '内存', '电源', '网线', '路由器', '机柜'],
  [SEC_ELEC]: ['笔记本', '手机', '平板', '显示器', '键鼠', '音箱'],
  [SEC_APPL]: ['冰箱', '洗衣机', '空调', '热水器', '电视', '微波炉'],
};

/**
 * 功能：建一个**内置**子类别格 —— 走 `assets` 的 `seedAssetGroup()`（它写 `builtin = 1`）。
 *
 * 回落 `createAssetGroup()` 是**跨版本**的过渡口子：`assets` 目录被整个删掉、或它还停在
 * 没有 `seedAssetGroup()` 的版本时，格照样建得出来（只是丢了「不可删」那层保护）——
 * 与 `typeof this.listAssetGroups === 'function'` 那处同一条退化口径：
 */
function seedSection(store, uid, fields) {
  if (typeof store.seedAssetGroup === 'function') return store.seedAssetGroup(uid, fields);
  return store.createAssetGroup(uid, fields);
}


/**
 * 功能：归一化一份**下拉选项清单**（`opts`）—— 空串与重复项就地丢掉，其余按原次序保留。
 *
 * 从这一版起**用户自建的属性也能是下拉** —— `opts` 不再只是内置模板的专利
 * 丢掉空串只是**归一化**、不是截断用户意图：一个没有文字的选项在界面上是个空药丸，
 * 与「缺 `label` 的字段整条丢掉」是同一条口径。
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
 * 坏了只可能是历史或手工改库 ⇒ 当成「这份模板还没有自定义属性」，用户重新加一遍即可。
 * 缺 `label` 的条目一律丢掉：界面上没法显示一个没有名字的框。
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
 * 起还认 `opts`（下拉选项清单，走 `normOpts()`）。
 * 缺 `label` 的整条丢掉；`key` 缺了或是重复的，就地补一个（前端本来会生成，
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
 * 住在 `fields` 那一列。读的时候按代码**重建预置部分**、再把追加的接在后面 ⇒
 * 将来给某个内置模板补一个预置字段，老账号**不用迁移**就会看到它；
 */
function shapeTemplate(row) {
  const own = parseTemplateFields(row.fields);
  const preset = Number(row.builtin) ? BUILTIN_TEMPLATES.find((t) => t.name === String(row.name || '')) : null;
  // 内置模板被人改过名（界面拦着，但库可能被手工改过）⇒ 退化成「整份按库里那一份」
  if (!preset) return { id: Number(row.id), name: String(row.name || ''), builtin: !!Number(row.builtin), fields: own };
  const presetKeys = new Set(preset.fields.map((f) => f.key));
  // 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的，
  // 只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
  // 库里与预置字段**同 key** 的那些行 = **用户对那一项「选项清单」的覆盖**（只认 `opts` ——
  const overrides = new Map();
  for (const f of own) if (presetKeys.has(f.key)) overrides.set(f.key, f);
  const extra = own.filter((f) => !presetKeys.has(f.key));
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    builtin: true,
    // 预置那几项带 `fixed: true` —— 界面据此把它们在「编辑专业参数」里**显示成只读**
    // （名字 / 类型 / 条件都归代码；⭐ 任务五起**只有选项清单**归用户）。
    // 第二版：`opts`（常见规格下拉）与 `when`（条件显隐）**跟着一起透传**。
    fields: [
      ...preset.fields.map((f) => {
        const ov = overrides.get(f.key);
        // 任务五：这一项被用户改过 ⇒ 以**他那一份**为准（包括「全删光」= 退化成文本）
        const opts = (ov ? (Array.isArray(ov.opts) ? ov.opts : []) : Array.isArray(f.opts) ? f.opts : []).map((o) =>
          String(o),
        );
        const out = { key: f.key, label: f.label, ph: f.ph || '', fixed: true };
        if (opts.length) out.opts = opts;
        // 任务五：**代码里是下拉**的那几项 ⇒ 选项清单归用户改 ——
        // 界面据此在这一行摆一颗「改选项」（⛔ 纯文本框那些没有这一颗）。
        // 判据用**代码**那一份（⛔ 不是 `opts.length`）：用户把选项全删光之后
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
 * 自建模板 —— 模板是**选择**用的（新建硬件时先选一个），两条同名的摆在那一排里，
 * 内置那 11 个名字**天然在这个集合里**（它们也各占一行、`builtin = 1`）——
 * 所以这条同时兜住了「与内置撞名」，不必再单独比代码清单（那条留着另给一句更准的文案）。
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
   * **一次请求就能画完整屏**的最小集合（左栏子类别 ＋ 右栏下拉 ＋ 概览行 ＋ 列表）——
   * 所以没有 `/api/hardware/summary` 这类接口（少一次请求、少一处 401 分支）。
   */
  listHardware(uid, opts) {
    const o = opts || {};
    const terms = splitTerms(o.q);
    const status = STATUSES.includes(o.status) ? o.status : null;
    const group = String(o.group == null ? '' : o.group).trim();
    const onlyAlert = o.focus === 'alert';
    const d = today();

    // 三个层级都来自「数码管理」那一格下面的子树（跨模块走 `listAssetGroups()`，见文件头）。
    // `assets` 模块目录被整个删掉时那个方法不存在 —— 退化成空树（分类暂不可用），
    const readTree = () =>
      typeof this.listAssetGroups === 'function'
        ? pickDigitalTree(this.listAssetGroups(Number(uid)).groups)
        : pickDigitalTree([]);
    let tree = readTree();
    // 内置子类别 + 老 `category` 搬家：首次取数时做一趟（带一次性标记，见 `_ensureDigitalSections()`）。
    // 真的动过（建了格 / 落了标记）才重取一次树（新格子此刻还不在上面那份快照里）。
    if (this._ensureDigitalSections(Number(uid), tree)) tree = readTree();

    // 默认落到**第一个子类别**（左栏第一项）—— `group` 没给 / 给了不在这棵树里的值时用它。
    // 一格子类别都没有（只读降级 / 树读不到）时是 null ⇒ 后面整段退化成「不按分类过滤」。
    const homeSecId = tree.sections.length ? tree.sections[0].id : null;
    // 选中的**子类别**：`group` 可能就指着子类别，也可能指着它下面的子分类 ——
    // 靠 `sectionOf()` 往上溯（左栏高亮与右栏下拉都吃这一个值）。
    const secPick = sectionOf(tree, group);
    const secId = secPick === null ? homeSecId : secPick;

    // 条目的**有效归属**：`group_id` 为空 / 悬空（那一格已被删）⇒ 落到第一个子类别
    // ——  在这一屏的落地：老数据（未分类）与删掉的子分类都还有家可回，
    // 不能静默消失（列表里看不到、计数里也没有，用户会以为数据丢了）。
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
        // 详情要显示的是**归属那一格的名字**（老 `category` 已退役）——
        // 在这里挂上，前端不必再查一次
        group_name: gid === null ? '' : tree.names.get(gid) || '',
        // 模板与专业参数 —— `attrs` 在这里就解析成对象（库里存的是 JSON 文本），
        // 两个后端因此给出**逐字一致**的形状，前端不必各写一份容错解析
        template_id: tplId,
        template_name: tplId === null ? '' : tplNameOf.get(tplId) || '',
        attrs: parseAttrs(h.attrs),
      });
    });

    // 「不认识 ⇒ 不筛选」那条老口径**改了**：现在左栏必有选中项，认不出来的一律回落
    const scopeId = group && tree.ids.has(Number(group)) ? Number(group) : secId;
    const scope = scopeId === null ? null : subtreeIdsOf(tree.cats, scopeId);
    // 概览与列表都只看**当前这一摊**里的东西 —— 各子类别彼此独立（
    // 「NAS硬件管理是独立于其它子类别的」）：在「电脑」那一格下挂着 NAS 的件数与金额，
    // 比不显示更容易误导。
    const inScope = scope ? all.filter((h) => scope.has(gidOf.get(Number(h.id)))) : all;

    // 汇总算在**状态 / 关键词筛选之前**（它就是「这一摊一共有多少件」的答案，不随筛选变化 ——
    const owned = inScope.filter((h) => h.status === 'owned');
    const wishlist = inScope.filter((h) => h.status === 'wishlist');
    const retired = inScope.filter((h) => h.status === 'retired');
    const summary = {
      total: inScope.length,
      owned: owned.length,
      wishlist: wishlist.length,
      retired: retired.length,
      alert: owned.filter(isAlert).length,
      // 全部都算在筛选之前，与计数同一条口径。
      ownedValue: sumValue(owned, 'purchase_price'),
      retiredValue: sumValue(retired, 'purchase_price'),
      wishValue: sumValue(wishlist, 'wish_target_price'),
      // 任务七（「在各自框底部显示总价」）：那排概览卡
      // （全部 / 在用 / 想买 / 已退役 / 需关注）每格底部再显示**这一档的金额合计**——
      // 「全部」= 三条各自按自己的价相加（已买的用购买价、想买的用目标价）；
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

    // 排序在**筛选之后**做：排的是「这次要给用户看的那几条」。
    // 起默认是 `used`（使用时间），方向由 `desc` 决定 —— 见 `sortHardware()` 的说明。
    // 查询串里带来的是字符串 `'0'` / `'1'`，所以这里按**真值**判（`'0'` 是假，正好对）。
    sortHardware(items, o.sort, !!o.desc && String(o.desc) !== '0');

    // 左栏（子类别）与右栏下拉（子分类）的选项**随列表一起返回**（与收藏夹把分类列表随列表
    // 带回同理）：前端不必再打一次接口，而且筛选中它们都不会跟着变空。
    // 计数同样是**全量**的（按有效归属算），与 `summary` 一个道理。
    const catCount = new Map();
    all.forEach((h) => {
      const gid = gidOf.get(Number(h.id));
      if (gid !== null) catCount.set(gid, (catCount.get(gid) || 0) + 1);
    });
    // 任意一格 → 它所属的**子类别**：`sections` 的计数要把子分类里的条目一并算上去
    // （子类别个数很少，通常 1~5，逐个扩散可接受）。
    const secOf = new Map();
    for (const s of tree.sections) for (const id of subtreeIdsOf(tree.cats, s.id)) secOf.set(id, s.id);
    const secCount = new Map();
    all.forEach((h) => {
      const s = secOf.get(gidOf.get(Number(h.id)));
      if (s !== undefined) secCount.set(s, (secCount.get(s) || 0) + 1);
    });
    // 顺序照**树的顺序**（`sections` 已按 sort_order → id 排好）—— 不再按条目数排：
    // 「谁在谁下面」比「哪一类东西多」重要。
    // ：每一格**再带上自己的子分类**
    const sections = tree.sections.map((s) => ({
      id: s.id,
      name: s.name,
      count: secCount.get(s.id) || 0,
      active: s.id === secId,
      // 预制的子类别（`NAS硬件管理` / `电子产品管理`）—— 界面据此**不给删除键**
      // （后端 `removeAssetGroup()` 另有一道硬拦，见 assets/store.js）。
      builtin: !!s.builtin,
      cats: tree.cats
        .filter((c) => c.parent_id === s.id)
        .map((c) => ({ id: c.id, name: c.name, count: catCount.get(c.id) || 0 })),
    }));

    // 右栏「子分类」下拉 = **当前子类别下面**的全部子分类（不含子类别自己），
    // `depth` 减 1（子类别的直接子变成 0：子类别本身在那枚下拉里不存在 ⇒ 缩进从 0 起）。
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
      // 模板清单（内置 11 个 + 自建）—— 「新建硬件先选模板」那一步与
      // 表单里的「专业参数」那一组，都靠它（⛔ 不再单独打一次接口）
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
   * JSON 后端不会替我们补默认值，两个后端的行为必须一致。
   *
   */
  createHardware(uid, input) {
    this._assertWritable();
    const row = Object.assign({}, input);
    delete row.id;
    delete row.user_id;
    delete row.created_at;
    delete row.updated_at;
    this._assertHwGroupOwned(uid, row.group_id);
    // 模板同款 —— 挂到别人的模板上同样是越权写入
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
   * 只改请求里真的带了的字段：局部更新是这个应用的常态。
   * 一个字段都没带时 `_update()` 仍会刷新 `updated_at`（白名单里有它），
   */
  updateHardware(uid, id, input) {
    this._assertWritable();
    // 改挂分类（含解绑）同样要过归属校验 —— 与 `createHardware` 那一句同一条理由
    if (input && Object.prototype.hasOwnProperty.call(input, 'group_id')) {
      this._assertHwGroupOwned(uid, input.group_id);
    }
    // 换模板同款（换到别人的模板上照样是越权写入）
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
   * `ownsAssetGroup()`，⛔ 不自己查别人的表（铁律 11 /）。
   * 空值（`null` / `''` / `undefined`）= 未分类 / 解绑，**直接放过**：那是一个合法动作
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
   * 所以这里只在「真的指了一个 id」时才查。
   * 走到这里说明 `hardware_templates` 那张表在（列表读路径已经播种过它）；
   */
  _assertHwTemplateOwned(uid, tid) {
    if (tid === undefined || tid === null || tid === '') return;
    if (!this._bk.ownsHardwareTemplate(Number(uid), Number(tid))) throw notFoundErr('这个模板');
  },

  /**
   * 功能：把「数码管理」的层级补齐 ＋ 搬老数据（**两趟，各带一个一次性标记**）。
   *
   * 说明：⭐ 三趟各干各的，标记都住在全局键值表里：
   * **v1**（`digital_sections_v1_<uid>`）：① **内置子类别**「NAS硬件管理」—— 原来那整套
   * 硬件台账的**家**（左栏第一格）；② 老的自由文本 `category`（`硬盘` / `网线`…）⇒ 搬成它
   */
  _ensureDigitalSections(uid, tree) {
    if (!tree || tree.rootId === null) return false;
    // `assets` 模块目录被整个删掉时没有这个方法 —— 那就不建（分类功能本来就不可用了）
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
        // 先置 `touched`：中途抛错时也要让调用方重取一次树（那一刻可能刚建出格子）
        touched = true;
        // ① 子类别的家：叫「NAS硬件管理」的那一格。
        const home = tree.sections.find((s) => s.name === SEC_NAS) || null;
        let homeId = home ? home.id : null;
        if (homeId === null) {
          // 起走 `seedSection()`：内置格带 `builtin = 1`（界面上不给删、后端也拦）
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
          // 按 id 升序搬：子分类在树里的先后就照「这条硬件的记录顺序」定。
          // 不能依赖 `_bk` 的返回顺序 —— 那是后端的实现细节，换个后端顺序就变了
          // （顺序对用户可见，两个后端必须给同一个）。
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

    if (readFlag('digital_sections_v2_' + id) !== '1') {
      try {
        this._assertWritable();
        touched = true;
        // 按名字找**只在这一趟**（标记落下去之后就不再找）—— 用户改名不会被骗到、不会重复建一格。
        if (!tree.sections.some((s) => s.name === SEC_ELEC)) {
          seedSection(this, id, { name: SEC_ELEC, parent_id: tree.rootId });
        }
        setFlag('digital_sections_v2_' + id);
      } catch {
        // 只读降级：下次取数再补
      }
    }

    if (readFlag('digital_sections_v3_' + id) !== '1') {
      try {
        this._assertWritable();
        // （`asset_groups.builtin` 是补列补出来的 0），v1/v2 的标记也早落了 ⇒ 不会再跑。
        // 光靠 `seedSection()` 补不上标记，表现就是「预制的格照样删得掉」。
        // 按名字找**只在这一趟**（与 v2 同一条纪律）：一次性、幂等、之后不再看名字。
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

    if (readFlag('digital_sections_v4_' + id) !== '1') {
      try {
        this._assertWritable();
        touched = true;
        // 按名字找**只在这一趟**（与 v2 / v3 同一条纪律）：一次性、幂等、之后不再看名字。
        const hit = tree.sections.find((s) => s.name === SEC_APPL) || null;
        if (!hit) {
          seedSection(this, id, { name: SEC_APPL, parent_id: tree.rootId });
        } else if (!hit.builtin && typeof this.markAssetGroupBuiltin === 'function') {
          // 存量库里已经有一格同名的（用户自建 / 早版本建的）⇒ 就地补 `builtin`，
          this.markAssetGroupBuiltin(id, hit.id);
        }
        setFlag('digital_sections_v4_' + id);
      } catch {
        // 只读降级：下次取数再补（标记没落 ⇒ 会重跑，重跑安全）
      }
    }

    if (readFlag('digital_sections_v5_' + id) !== '1') {
      try {
        this._assertWritable();
        // 必须**按名字现读一次库**：v1~v4 可能刚把某几格建出来，而 `tree` 那份快照是
        // 调用方在**这一趟之前**取的，里面还没有它们（复用快照 = 分类永远播不上去，
        // 而且一句提示都没有）。
        const fresh = typeof this.listAssetGroups === 'function' ? this.listAssetGroups(id).groups : [];
        /** 取某一行的父 id（空值一律当「第一层」）。 @param {Object} g - 一行分组 @returns {?(number|string)} */
        const parentOf = (g) =>
          g.parent_id === null || g.parent_id === undefined || g.parent_id === '' ? null : Number(g.parent_id);
        let changed = false;
        for (const secName of BUILTIN_SECTIONS) {
          // 认「挂在根格下面、名字是内置名」的那一格 —— 只看名字会在用户自建了同名**顶层**格时认错。
          const sec = fresh.find((g) => g.name === secName && parentOf(g) === tree.rootId) || null;
          if (!sec) continue;
          const pid = Number(sec.id);
          const have = new Set(fresh.filter((g) => parentOf(g) === pid).map((g) => String(g.name)));
          for (const cat of BUILTIN_CATS[secName] || []) {
            if (have.has(cat)) continue;
            // 走普通 `createAssetGroup`（⛔ 不是 `seedSection`）：预置分类**不带** `builtin`
            // —— 删得掉、改得了名（只把「不可删不可改名」给了那三个类别本身）。
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


  /**
   * 功能：列出该账号的模板（内置 11 个 + 自建）—— 顺带把内置那些**幂等播种**出来。
   *
   * 说明：⭐ 返回值已经过 `shapeTemplate()` 整形（内置模板的预置字段以**代码**为准、
   * 用户追加的自定义属性接在后面）。⚠️ 与硬件列表同一条口径：**读的时候顺手把该有的补上**，
   * 前端不必先调一次「初始化」接口 —— 与 `_ensureDigitalSections()` / `assets` 的懒播种同款。
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
   * 用户永远不会被重复建一个，而「内置的一直在」也由它保证。
   * 只按**名字 + `builtin = 1`** 判「缺不缺」—— ⛔ 不拿名字当「是不是内置」的判据
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
      // 起点接在**已有的内置行**之后（老库里可能已经播过一部分 —— 比如上一版播了 10 个、
      // 这一版才补上「通用」）⇒ 取「已有内置的最大 sort_order」再往上加，⛔ 别从 10 从头数
      // （那会插到预制的中间去）。
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
   * 『硬盘』」，用户分不清哪个是他自己建的（`hardware_templates` 上⛔ 没有唯一约束，
   * 这条规则只能写在业务层）。
   * 自建模板的 `fields` 就是**全部字段**（与内置那 11 个「这一列只装追加部分」相反）——
   */
  createHardwareTemplate(uid, input) {
    this._assertWritable();
    const name = String((input && input.name) || '').trim();
    if (!name) throw badRequest('模板名不能为空');
    if (BUILTIN_TEMPLATES.some((t) => t.name === name)) {
      throw badRequest(`「${name}」是预制的模板名，换一个`);
    }
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
   * ＋（⭐⭐ 任务五起）**改那几个下拉字段的选项清单**。
   *
   * 说明：⭐⭐ 「内置10个不可以删除和修改（但可以添加自定义属性）」
   * ⇒ 内置模板传 `name` 且与当前**不同** ⇒ **400**（把同名原值传回来是常态，
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
        // （只挡新建是没用的：改个名照样能造出两条同名的）。⚠️ 名字没变直接放行（回传同值是常态）。
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
        // 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的，
        // 只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
        // 与预置字段**同 key** 的那些 = 用户改过的**选项清单**（覆盖），⛔ 只留 `key` 与 `opts`：
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
   * 删掉模板之后那些行在界面上按「通用」显示（与「删分类只解绑」同一条口径；
   * 前端那个确认框里也要这么写，见 `delHwTemplate()`）。
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
   * 手工改大了，也只是「新的接在它后面」，⛔ 不会插到预制的中间去。
   *
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
