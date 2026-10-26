'use strict';
/**
 * modules/assets/store.js —— 个人资产管理业务方法（0.8.10）
 *
 * 功能：分组树与通用条目的业务方法 ——
 *      `listAssetGroups` / `getAssetGroup` / `ownsAssetGroup` / `createAssetGroup` /
 *      `updateAssetGroup` / `removeAssetGroup`；`listAssetItems` / `getAssetItem` /
 *      `ownsAssetItem` / `createAssetItem` / `updateAssetItem` / `removeAssetItem`。
 *
 * ⚠️ **方法名一律带模块前缀，绝不用 `list` / `get` 这种通用名**：`store/index.js` 用
 *    `Object.assign(Store.prototype, …)` 把各模块的业务方法平铺到**同一个原型**上 ——
 *    两个模块各写一个 `list()`，后来者会**静默覆盖**前者（`Object.assign` 不报错）。
 *    0.5.0 起这条由装配期护栏 `assertNoMethodClash()` 机械兜住（撞名一律启动即抛）。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走 `this._bk.<op>(...)`。
 *
 * ⭐ **树的组装与「删分组」的连带处理只在这里实现一份**（两个后端只提供「取该账号的全部行」
 *    与「删一行 / 解绑一个分组」这几条原语）—— 两个后端因此行为逐字一致。
 *
 * ⚠️⭐ **删分组 = 删子树 ＋ 条目解绑**：
 *    · 子树里的每一行都要删（它们都是这个分组的分类，留着就是永远显示不出来的孤儿）；
 *    · 挂在被删分组上的条目**只解绑、不删** —— 台账是已发生的事实，分组只是一层归类。
 *      ⚠️ 与任务板刻意相反（那边删项目会连任务一起删：任务属于项目）。
 *    · ⛔ 不做「运行期造模块」：本模块只写自己这两张表，⛔ 不碰别人的表。
 *
 * @author zx
 * @date   2026-10-02
 * @since 0.8.24
 * 相关：docs/公共/架构文档/26-个人资产管理.md、docs/公共/开发方案/30-个人资产管理.md
 */
const { nowStamp, notFoundErr, badRequest } = require('../../core/store/helpers.js');

/**
 * 第一层**自定义分组**的条数上限（「最多可以建 3 个自定义分组」）。
 *
 * 说明：⚠️ 只数「第一层且 `module_key` 为空」的那些（那才是「用户自建的分组」）——
 *      内置的「生活记账 / 数码管理」不算在内，数码管理**里面的子类别 / 子分类**也不受这条管
 *      （那是 `parent_id` 非空的行，另一个层级、另一个上限问题）。
 * @type {number}
 */
const CUSTOM_TOP_MAX = 3;

/**
 * 功能：同级分组的「下一个顺序号」—— 新建的永远排在同级**末尾**。
 *
 * 说明：⭐⭐ 「新建的分组应该在后面显示，怎么跑最前面去了」。
 *      根因是新建时 `sort_order` 落 **0**，而内置两格是 `10` / `20`，
 *      同级按 `sort_order` 升序 ⇒ 新建的永远插在最前。
 *      ⇒ 改成「同级已有的最大 `sort_order` ＋ 10」：永远往后排，且留出插空余量。
 *      ⚠️ 只算**同一个父项**下的（`parent_id` 相同的那些）—— 不同层各排各的。
 * @param {Object} store - Store 实例（要它的 `_bk`）
 * @param {number} uid - 账号 id
 * @param {?(number|string)} pid - 父分组 id（null = 第一层）
 * @returns {number} 新行该用的 `sort_order`
 */
function nextSortOrder(store, uid, pid) {
  const want = pid === null || pid === undefined || pid === '' ? null : Number(pid);
  let max = 0;
  for (const g of store._bk.listAssetGroups(Number(uid))) {
    if (pidOf(g) !== want) continue;
    const s = Number(g.sort_order) || 0;
    if (s > max) max = s;
  }
  return max + 10;
}

/**
 * 功能：在**同一个父项**下按名字找另一行 —— 找到了就说明要重名了（`null` = 没撞上）。
 *
 * 说明：⭐⭐ 0.8.24 任务四（「分类名称不能重复」）：口径是**同一层里不许重名** ——
 *      同一个类别下的两条分类不能同名（不同类别下的同名是允许的：「其他」这种名字各家都可能有一个），
 *      第一层（`parent_id` 为空）之间同样不许同名。
 *      ⚠️ 比的是 `trim()` 之后的原文（大小写不敏感属于另一件事，本应用不做猜测）；
 *      ⚠️ 名字是空串 / 没带名字时**一律放行**（「必填」是另一条路的判断，这里别抢）。
 *      ⚠️ `exceptId` 给改名那条路用：改的是自己那一行，自己不算撞名。
 *
 * @param {Object} store - Store 实例（要它的 `_bk`）
 * @param {number} uid - 账号 id
 * @param {?(number|string)} pid - 父分组 id（null = 第一层）
 * @param {?string} name - 想用的名字
 * @param {?(number|string)} exceptId - 排除掉的行 id（改名时是它自己）
 * @returns {?Object} 撞上的那一行；没撞上为 null
 */
function findSameNameRow(store, uid, pid, name, exceptId) {
  const nm = String(name == null ? '' : name).trim();
  if (!nm) return null;
  const want = pid === null || pid === undefined || pid === '' ? null : Number(pid);
  for (const g of store._bk.listAssetGroups(Number(uid))) {
    if (pidOf(g) !== want) continue;
    if (exceptId !== null && exceptId !== undefined && Number(g.id) === Number(exceptId)) continue;
    if (String(g.name == null ? '' : g.name).trim() === nm) return g;
  }
  return null;
}

/**
 * 默认第一层（子模块）—— **懒播种**：某个账号的 `asset_groups` 一行都没有时，
 * 由 `listAssetGroups()` 顺手把这两行建出来。
 *
 * ⚠️ 为什么是**懒播种**而不是迁移：老库升上来时用户数据必须**一个字节都不动**，
 *    而这两个默认格又是「老账号也必须有」的 ⇒ 放在「第一次真正读它」的那一刻建，
 *    老账号与新账号走的是同一条路。
 * ⚠️ 播种**只在「一行都没有」时发生**：用户把它删掉了就是删掉了（⛔ 不跟他抢）。
 * ⚠️ `module_key` 是**代码层的登记**：这两行的值是模块名（`ledger` / `digital`），
 *    界面据此走 `mountModuleSlot()` 借位挂对应的模块片段；
 *    ⛔ 用户自建的分组 `module_key` 恒为空（往树里插一行 ≠ 运行期造模块）。
 * @type {Array.<{name: string, module_key: string, icon: string, sort_order: number}>}
 */
const DEFAULT_GROUPS = [
  { name: '生活记账', module_key: 'ledger', icon: '💰', sort_order: 10 },
  { name: '我的设备', module_key: 'digital', icon: '🧩', sort_order: 20 },
];

/**
 * 功能：把该账号的分组行按树排好（父在前、同级按 sort_order）—— 广度优先展平。
 *
 * 说明：⚠️ **不依赖数据库的排序**（两个后端各排各的容易漂移）：这里统一按
 *      `sort_order` → `id` 排同级，再按层级展平，两个后端因此逐字一致。
 *      ⚠️ 环（手工改库 / 未来挪动分组造成）**不会死循环**：每个 id 只出栈一次（`seen`）。
 *
 * @param {Array.<Object>} rows - 该账号的全部分组行
 * @returns {Array.<Object>} 展平后的行（父在前），每行多挂一个 `depth`（0 = 第一层）
 */
function flattenTree(rows) {
  const seen = new Set();
  const out = [];
  /** 功能：取某个父项下的直接子项（已排好序）。 @param {?(number|string)} pid - 父 id（null = 根） @returns {Array.<Object>} 子项数组 */
  const childrenOf = (pid) =>
    rows
      .filter((g) => {
        const p = g.parent_id === null || g.parent_id === undefined || g.parent_id === '' ? null : Number(g.parent_id);
        return p === (pid === null ? null : Number(pid));
      })
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id));
  /** 功能：从某一层往下展平。 @param {?(number|string)} pid - 父 id @param {number} depth - 层级 @returns {void} */
  const walk = (pid, depth) => {
    for (const g of childrenOf(pid)) {
      if (seen.has(Number(g.id))) continue;
      seen.add(Number(g.id));
      out.push(Object.assign({}, g, { depth }));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  // ⚠️ 兜底：`parent_id` 指向一个**不在本账号行里**的 id（孤儿行）时上面的遍历到不了它 ——
  //    照旧把它挂到第一层，总比「数据在库里、界面上永远看不见」好（删分组时不会漏掉它）。
  for (const g of rows) {
    if (!seen.has(Number(g.id))) out.push(Object.assign({}, g, { depth: 0 }));
  }
  return out;
}

/**
 * 功能：把一行分组的 `parent_id` 归一成「`null`（第一层）或数字」。
 *
 * 说明：⚠️ 两个后端给的空值形状不完全一样（SQLite 是 `null`、JSON 可能是缺失键），
 *      而 `Number(null) === 0`（本项目最贵的那条坑）⇒ 判「有没有父项」**必须先挡空值**。
 * @param {?Object} g - 分组行
 * @returns {?number} 父项 id（`null` = 第一层）
 */
function pidOf(g) {
  const v = g ? g.parent_id : null;
  return v === null || v === undefined || v === '' ? null : Number(v);
}

/**
 * 功能：把**一个**分组并进另一个（合并的原子动作）—— 条目改挂、子分类挪走、源那一行删掉。
 *
 * 说明：⭐⭐ 三件事的顺序是刻意的（`mergeAssetGroups()` 里那份说明的落地）：
 *      ① 条目**整批改挂**（`reassignAssetItems()` 一条 SQL，⛔ 不是「先解绑再挂」—— 中途失败会留孤儿）；
 *      ② 子分类挪到目标下面；⚠️ 目标下面**已经有同名**的 ⇒ 往那一格**再并一层**（递归）——
 *         否则下拉里会出现两个同名项，而 `<select>` 里两个同名 option 用户根本分不出来；
 *      ③ 源那一行**删掉**（此时它已经什么都不剩）。
 *      ⚠️ 递归的 `guard` 是**防呆**（手工改库造出的环 / 重复 id）：正常数据下永远命中不了，
 *      但它保证「一个节点最多被处理一次」，不会因为脏数据转不出来。
 * @param {Object} store - Store 实例（要它的 `_bk`）
 * @param {number} uid - 账号 id
 * @param {number} srcId - 源分组 id
 * @param {number} dstId - 目标分组 id
 * @param {Set.<number>} guard - 已经处理过的 id（防重复 / 防环）
 * @returns {void}
 */
function mergeGroupInto(store, uid, srcId, dstId, guard) {
  if (guard.has(srcId)) return;
  guard.add(srcId);
  store._bk.reassignAssetItems(uid, srcId, dstId);
  const kids = store._bk.listAssetGroups(uid).filter((g) => pidOf(g) === Number(srcId));
  for (const k of kids) {
    const kidId = Number(k.id);
    if (guard.has(kidId)) continue;
    const name = String(k.name || '').trim();
    // ⚠️ 每次**重新读一遍**（上一步可能刚把某一格挪到目标下面去了）—— 个人账本量级，一次全表读可忽略
    const twin = store._bk
      .listAssetGroups(uid)
      .find((g) => pidOf(g) === Number(dstId) && String(g.name || '').trim() === name && Number(g.id) !== kidId);
    if (twin) mergeGroupInto(store, uid, kidId, Number(twin.id), guard);
    else store._bk.reparentAssetGroup(uid, kidId, dstId);
  }
  store._bk.deleteAssetGroup(uid, srcId);
}

/**
 * 功能：合并分组的**实现**（模块级）—— 口径与逐条理由写在 `module.exports.mergeAssetGroups()` 上。
 *
 * 说明：⚠️ 写成模块级函数是**本文件的既有手法**（`nextSortOrder` / `mergeGroupInto` 同款）：
 *      业务层不挂 `_` 私有方法，调用点把 `store` 传进来（`_bk` 只转发后端原语）。
 *
 * @param {Object} store - Store 实例
 * @param {number} uid - 账号 id
 * @param {Array.<number>} ids - 要并掉的源分组 id（**不含**目标那一个）
 * @param {number} into - 并进哪一格（目标分组 id）
 * @returns {boolean} 成功时 true
 * @throws {Error} 源 / 目标不存在或不归本人时抛 404；跨父项 / 选中内置格 / 目标在源里时抛 400；只读时抛 503
 */
function mergeGroupsIn(store, uid, ids, into) {
  store._assertWritable();
  const me = Number(uid);
  const dst = Number(into);
  if (!store.ownsAssetGroup(me, dst)) throw notFoundErr('这个分组');
  const byId = new Map(store._bk.listAssetGroups(me).map((g) => [Number(g.id), g]));
  const dstRow = byId.get(dst);
  if (String((dstRow && dstRow.module_key) || '').trim()) throw badRequest('内置的那两格不能作为合并的目标');
  const parent = pidOf(dstRow);
  const srcs = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = Number(raw);
    if (id === dst) throw badRequest('目标那一格不能在「要合并的」里面');
    if (!store.ownsAssetGroup(me, id)) throw notFoundErr('这个分组');
    const row = byId.get(id);
    if (String((row && row.module_key) || '').trim()) throw badRequest('内置的那两格不能合并');
    if (pidOf(row) !== parent) throw badRequest('只能合并同一个子模块下面的分组（层级要一样）');
    srcs.push(id);
  }
  if (!srcs.length) throw badRequest('至少要选一格');
  const guard = new Set();
  for (const id of srcs) mergeGroupInto(store, me, id, dst, guard);
  return true;
}

module.exports = {
  /**
   * 功能：把**若干个子分类合并到其中一个里**（「把几个子类别合并到其中一个子类别中」）。
   *
   * 说明：⭐⭐ 语义 —— 每个源**自己挂着的条目**整批改挂到目标、**它下面的子分类**挪到目标下面
   *      （同名再并一层）、**源那一行删掉**；即「一格都不丢数据，只是换了个爹」。
   *      ⭐⭐ **只允许「同一个父项下的兄弟」之间并**（同一种层级）—— 这条约束买下两件事：
   *      · 「挪到自己子孙下面 ⇒ 成环」被**结构性地**排除（源是目标的兄弟 ⇒ 源的子树里不可能有目标），
   *        所以这里⛔ 不需要环检测，也⛔ 不该顺手把 `parent_id` 加进 `_update()` 的白名单
   *        （`schema.js` 把那条路封死了，理由写在那边）；
   *      · 顺手挡住「把一整块子模块并进别人的分类里」这种连语义都说不清的动作。
   *      ⚠️ 两个内置子模块（`生活记账` / `数码管理`）**不可并也不可当目标** —— 它们是 `module_key`
   *      非空的那两格，并掉就等于把 `ledger` / `digital` 两个模块彻底弄成不可达
   *      （⛔ 运行期造 / 灭模块）。
   *      ⚠️ 越权 / 不存在一律 **404**（「不存在」与「不是你的」逐字一致）；
   *      跨父项 / 选中内置格 / 目标是源之一这类**语义错误**一律 **400** 且说人话。
   *      ⚠️ 真正干活的是模块级函数 `mergeGroupsIn()`（与 `nextSortOrder` / `mergeGroupInto` 同款：
   *      模块级函数 ＋ 调用点把 `store` 传进去，⛔ 不在模块 store 上挂 `_` 私有方法）。
   *
   * @param {number} uid - 账号 id
   * @param {Array.<number>} ids - 要并掉的源分组 id（**不含**目标那一个）
   * @param {number} into - 并进哪一格（目标分组 id）
   * @returns {boolean} 成功时 true
   * @throws {Error} 源 / 目标不存在或不归本人时抛 404；跨父项 / 选中内置格 / 目标在源里时抛 400；只读时抛 503
   */
  mergeAssetGroups(uid, ids, into) {
    return mergeGroupsIn(this, uid, ids, into);
  },

  /**
   * 功能：列出该账号的分组树（展平、父在前，每行带 `depth`）与每个分组下的条目计数。
   *
   * 说明：⭐ 计数与树**一次回给前端**（与硬件台账把 `summary` 随列表带回同一条理由：
   *      少一次请求、少一处 401 分支，而且切分组时数字不会闪烁）。
   *
   * @param {number} uid - 账号 id
   * @returns {{ groups: Array.<Object>, counts: Object }} 分组树与 `{ <分组id>: 条目数 }`
   */
  listAssetGroups(uid) {
    let rows = this._bk.listAssetGroups(Number(uid));
    // ⭐ 懒播种（见 `DEFAULT_GROUPS`）：**只在「一行都没有」时**建这两个默认格。
    //    ⚠️ 只读降级时不播种（写进去必然失败）—— 那种状态下这一屏就画空态，如实反映
    //    「现在写不了」，⛔ 不假装有东西。
    if (!rows.length) {
      try {
        this._assertWritable();
        const stamp = nowStamp();
        for (const g of DEFAULT_GROUPS) {
          // ⚠️ 这里**不走 `createAssetGroup()`**：它刻意把 `module_key` 丢掉（⛔ 不许由界面写），
          //    而播种恰恰是**代码在写**它 —— 这是唯一一处允许写 `module_key` 的地方。
          this._insert('asset_groups', {
            user_id: Number(uid),
            name: g.name,
            kind: 'module',
            module_key: g.module_key,
            icon: g.icon,
            sort_order: g.sort_order,
            created_at: stamp,
            updated_at: stamp,
          });
        }
        rows = this._bk.listAssetGroups(Number(uid));
      } catch {
        // 只读降级 / 播种失败：这一屏就画空态（如实反映「现在写不了」）
        rows = [];
      }
    }
    // ⭐⭐ 0.8.24（「NAS/数码管理」→「我的设备」—— 名字要能盖住家用电器）：
    //    老库上那一行的名字还是旧的 ⇒ 顺手改一次。
    //    ⚠️ 只在**名字逐字等于某个旧名**时才动（改过一次之后不再命中；用户自己改过的名字
    //    一个字节都不会被覆盖）—— 所以**不需要**另加一次性标记，幂等天然成立。
    //    ⚠️ 旧名是**两个**（`数码管理` 是最早的名字、`NAS/数码管理` 是 0.8.20 改的那一版）——
    //    只认一个的话，跳过 0.8.20 直接升上来的库会停在 `数码管理` 上。
    //    ⚠️ 失败（只读降级）静默收尾：名字照旧显示，下次取数再试。⛔ 不上抛 ——
    //    一个显示名不该把整屏打成「读取失败」。
    const DIGI_OLD_NAMES = ['数码管理', 'NAS/数码管理'];
    const DIGI_NEW_NAME = '我的设备';
    for (const g of rows) {
      if (String(g.module_key || '') !== 'digital') continue;
      if (!DIGI_OLD_NAMES.includes(String(g.name || ''))) continue;
      try {
        this._assertWritable();
        this._update('asset_groups', Number(uid), g.id, { name: DIGI_NEW_NAME, updated_at: nowStamp() });
        g.name = DIGI_NEW_NAME;
      } catch {
        // 只读降级：名字照旧，不改库
      }
    }
    const counts = {};
    for (const it of this._bk.listAssetItems(Number(uid), null)) {
      const gid = it.group_id === null || it.group_id === undefined || it.group_id === '' ? null : Number(it.group_id);
      if (gid === null) continue;
      counts[gid] = (counts[gid] || 0) + 1;
    }
    return { groups: flattenTree(rows), counts };
  },

  /**
   * 功能：按 id 取一个分组。
   * @param {number} uid - 账号 id
   * @param {number} id - 分组 id
   * @returns {?Object} 分组行；不归本人或不存在时为 null
   */
  getAssetGroup(uid, id) {
    return this._bk.getAssetGroup(Number(uid), id);
  },

  /**
   * 功能：判断某个分组是否属于该账号。
   * @param {number} uid - 账号 id
   * @param {number} id - 分组 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsAssetGroup(uid, id) {
    return this._bk.ownsAssetGroup(Number(uid), id);
  },

  /**
   * 功能：新建一个分组（子模块或分类 —— 差别只在 `parent_id` 是否为空）。
   *
   * 说明：⚠️ 给了 `parent_id` 时**必须先确认那个父项真的是本人的**：
   *      否则就能把分组挂到别人的树下（越权写入 —— 虽然看不见，但会污染对方的树）。
   *      父项不存在 / 不归本人 ⇒ 404（与「分组不存在」同一个出口，不给探测信号）。
   *      ⚠️ `kind` 由调用方给（界面用），**没给就按「有没有父项」推**（没父项 = 子模块）。
   *      ⚠️ `module_key` **不收**（那是代码层的登记，⛔ 不许由界面写）。
   *      ⭐⭐ 0.8.10两条新口径：
   *      ① **第一层自定义分组最多 3 个**（`CUSTOM_TOP_MAX`）—— 只数「第一层且 `module_key` 为空」的，
   *         内置两格与数码管理里的子类别 / 子分类都不算；超了 ⇒ 400，且这是**唯一**的硬出口；
   *      ② **缺省顺序号 = 同级末尾**（`nextSortOrder()`）—— 从前写死 0，而内置两格是 10 / 20，
   *         同级升序 ⇒ 新建的会插到最前面（真机反馈的原话：「怎么跑最前面去了」）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - 已由 `validate.checkAssetGroup` 归一化
   * @returns {Object} 新建的行（含 `id`）
   * @throws {Error} 第一层自定义分组已满 / 名称过长 / **同层重名**时抛 400；父分组不归本人 / 不存在时抛 404；数据层只读时抛 503
   */
  createAssetGroup(uid, input) {
    this._assertWritable();
    const row = Object.assign({}, input);
    delete row.id;
    delete row.user_id;
    delete row.created_at;
    delete row.updated_at;
    delete row.module_key; // ⛔ 不许由界面写（决策 111）
    row.user_id = Number(uid);
    const pid = row.parent_id === undefined || row.parent_id === null || row.parent_id === '' ? null : Number(row.parent_id);
    if (pid === null) {
      // ⭐ 0.8.10：「最多可以建 3 个自定义分组」—— 只数**第一层且没有实现**
      //    的那些（内置的「生活记账 / 数码管理」`module_key` 非空，不算在内）。
      //    ⚠️ 校验必须在**写入之前**，而且这里是**唯一**的硬出口（界面那道只是提示，绕得过去）。
      const customs = this._bk.listAssetGroups(Number(uid)).filter((g) => {
        const p = g.parent_id === null || g.parent_id === undefined || g.parent_id === '' ? null : Number(g.parent_id);
        return p === null && !String(g.module_key || '').trim();
      });
      if (customs.length >= CUSTOM_TOP_MAX) throw badRequest(`最多只能建 ${CUSTOM_TOP_MAX} 个自定义分组`);
      delete row.parent_id;
    } else {
      if (!this.ownsAssetGroup(uid, pid)) throw notFoundErr('这个分组');
      row.parent_id = pid;
    }
    if (!row.kind) row.kind = pid === null ? 'module' : 'group';
    // ⭐⭐ 0.8.24 任务四（「分类名称不能重复」）：**同一个父项下名字唯一** ——
    //    重名会让左栏与那两张清单出现两条一模一样的行，用户根本分不清点的是哪一条。
    //    ⚠️ 只挡**代码这条新建路**：`seedAssetGroup()`（内置格播种）不走这里，它按代码清单建、天然不重。
    if (findSameNameRow(this, uid, pid, row.name, null)) {
      throw badRequest(`已经有同名的「${String(row.name || '').trim()}」了`);
    }
    // ⭐ 0.8.10：缺省顺序号 = **同级末尾**（见 `nextSortOrder()`）——
    //    ⛔ 不再是写死的 0（那会让新建的插到内置两格前面去）。
    if (row.sort_order === undefined || row.sort_order === null || row.sort_order === '') {
      row.sort_order = nextSortOrder(this, uid, pid);
    }
    const stamp = nowStamp();
    row.created_at = stamp;
    row.updated_at = stamp;
    return this._insert('asset_groups', row);
  },

  /**
   * 功能：改一个分组（1 期只改名称 / 图标 / 顺序，⛔ 不挪位置）。
   *
   * 说明：⭐⭐ 0.8.24（「内置：三个-NAS硬件管理、电子产品管理、家用电器管理，
   *      这三个不可删除、不可改名」）：**预置格的名字归代码管** ⇒ 改名一律 400。
   *      ⚠️ 判据是行上的 `builtin`，⛔ **不是名字**（存量库里那几格的名字可能已被改过 ——
   *      靠名字认必然认错，与 `removeAssetGroup()` 同一把尺子）。
   *      ⚠️ **同名原值是常态**（界面把整个对象回传）⇒ 名字没变就放行，⛔ 不该被打成 400。
   *      ⚠️ **顶层那两格（`module_key` 非空）不在这一条里** —— 只点名了那三个类别；
   *      顶层两格是「不可删」（见 `removeAssetGroup()`），名字仍归用户。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 分组 id
   * @param {Object} input - 已由 `validate.checkAssetGroup` 归一化
   * @returns {boolean} 是否真的更新到了（不归本人时为 false）
   * @throws {Error} 预置格改名 / **改成同层已有的名字** ⇒ 400；数据层只读时抛 503
   */
  updateAssetGroup(uid, id, input) {
    this._assertWritable();
    const row = this._bk.getAssetGroup(Number(uid), Number(id));
    if (row && Number(row.builtin) > 0 && input && input.name !== undefined) {
      if (String(input.name || '').trim() !== String(row.name || '')) {
        throw badRequest('这是预制的分类，改不了名');
      }
    }
    // ⭐⭐ 0.8.24 任务四（「分类名称不能重复」）：改名同样要查 ——
    //    只挡新建是没用的（改个名照样能造出两条同名的行）。
    //    ⚠️ 名字没变（界面把整个对象回传是常态）跳过：不然「改图标顺带带上原名字」会被自己撞红。
    if (row && input && input.name !== undefined) {
      const nm = String(input.name || '').trim();
      if (nm && nm !== String(row.name || '').trim() && findSameNameRow(this, uid, pidOf(row), nm, id)) {
        throw badRequest(`已经有同名的「${nm}」了`);
      }
    }
    return this._update('asset_groups', uid, id, input);
  },

  /**
   * 功能：**播种**一个系统预置的分组（`builtin = 1`）—— 只给「有实现的模块」补齐自己的内置格用。
   *
   * 说明：⭐⭐ 0.8.23（「预制的 NAS硬件管理、电子产品管理 不可以删除」）：
   *      预制的格子要有个**稳定判据**，⛔ 不能靠名字 —— 用户能给它改名，靠名字认必然认错。
   *      ⇒ 照 `ledger_groups.builtin` 的先例加了一列（见 schema.js 的 DDL）。
   *      ⚠️ 为什么**不**走 `createAssetGroup()`：它刻意把 `module_key` / `builtin` 丢掉
   *      （那两列⛔ 不许由界面写），而播种恰恰是**代码在写**它们 —— 与 `listAssetGroups()`
   *      里播种 `DEFAULT_GROUPS` 是同一条口径（那一条也是直接 `_insert`）。
   *      ⚠️ 父项归属照样要校验（与 `createAssetGroup()` 同一处理由）：不校验就能把格挂到别人的树下。
   *      ⚠️ 内置格**不占**「最多 3 个自定义分组」的额度（上限只数第一层且 `module_key` 为空的）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - `{ name, parent_id, icon?, sort_order? }`
   * @returns {Object} 新建的行（含 `id`）
   * @throws {Error} 名字为空 ⇒ 400；父项不归本人 / 不存在 ⇒ 404；数据层只读时抛 503
   */
  seedAssetGroup(uid, input) {
    this._assertWritable();
    const name = String((input && input.name) || '').trim();
    if (!name) throw badRequest('名称不能为空');
    const row = Object.assign({}, input, { name });
    delete row.id;
    row.user_id = Number(uid);
    row.builtin = 1;
    const pid =
      row.parent_id === undefined || row.parent_id === null || row.parent_id === '' ? null : Number(row.parent_id);
    if (pid === null) {
      delete row.parent_id;
      row.kind = 'module';
    } else {
      if (!this.ownsAssetGroup(uid, pid)) throw notFoundErr('这个分组');
      row.parent_id = pid;
      row.kind = 'group';
    }
    if (row.sort_order === undefined) row.sort_order = nextSortOrder(this, uid, pid);
    const stamp = nowStamp();
    row.created_at = stamp;
    row.updated_at = stamp;
    return this._insert('asset_groups', row);
  },

  /**
   * 功能：把一个**已经存在**的分组标成系统预置（`builtin = 1`）—— 幂等，供老库补标记。
   *
   * 说明：⭐⭐ 0.8.23：`seedAssetGroup()` 只对**新库 / 首次播种**有效 —— 真机上装过 0.8.22 的库里
   *      那两个内置子类别**早就建出来了**（`builtin` 是补列补出来的 0），光靠播种补不上标记，
   *      表现为「预制的格照样删得掉」。所以另给一条补标记的路（digital 那边跑一趟一次性标记）。
   *      ⚠️ 刻意**不走** `_update()`：`builtin` 不在列白名单里（它⛔ 不该由界面的普通写路径碰到），
   *      这里是**代码层**的登记 —— 与 `seedAssetGroup()` 直接 `_insert` 是同一条理由的另一面。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 分组 id
   * @returns {boolean} 是否真的改到了（不归本人 / 不存在时为 false）
   * @throws {Error} 数据层只读时抛 503
   */
  markAssetGroupBuiltin(uid, id) {
    this._assertWritable();
    if (!this.ownsAssetGroup(uid, id)) return false;
    return this._bk.update('asset_groups', Number(uid), Number(id), ['builtin'], [1]);
  },

  /**
   * 功能：删一个分组 —— **连它的整棵子树一起删**，并把挂在这些分组上的条目**解绑**。
   *
   * 说明：⭐ 见文件头那一段：条目只解绑、不删（附录 C-8）。
   *      ⚠️ 返回 `false` 只表示「这个分组不归本人 / 不存在」（上层的 404 由路由层先挡一次）。
   *      ⭐⭐ 0.8.23：**系统预置**的格子不给删（「预制的 NAS硬件管理、电子产品管理
   *      不可以删除」）。判据是行上的 `builtin`，⛔ 不是名字（用户能改名，靠名字认必然认错）。
   *      ⭐⭐ 0.8.23 第二轮（追认「要」）：**顶层那两格同样删不得** ——
   *      它们的判据是 `module_key` 非空（＝这一格**有实现**：`ledger` / `digital`），
   *      删掉等于把这两个模块彻底弄成不可达。⚠️ 用 `module_key` 而不是 `builtin`，
   *      是照 `mergeGroupsIn()` 那条「内置的那两格不能合并」的既有判据（同一件事同一把尺子）——
   *      顶层那两格是**懒播种**出来的，`builtin` 列到不了它们身上，而 `module_key` 一直在。
   *      ⚠️⭐ 这是**唯一的硬出口** —— 界面不给删除按钮只是提示，绕得过去（与「自定义分组最多
   *      3 个」同一条纪律：校验必须在写入之前，且只写一处）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 分组 id
   * @returns {boolean} 是否真的删掉了（不归本人 / 不存在时为 false）
   * @throws {Error} 预置格子 / 有实现的模块格 ⇒ 400；数据层只读时抛 503
   */
  removeAssetGroup(uid, id) {
    this._assertWritable();
    if (!this.ownsAssetGroup(uid, id)) return false;
    // ⚠️ 取的是**这一行**（不是整棵树）：两类保护都只可能落在「被点的这一格」上。
    const row = this._bk.getAssetGroup(Number(uid), Number(id));
    if (row && Number(row.builtin) > 0) throw badRequest('这是预制的分类，删不了');
    if (row && String(row.module_key || '').trim()) throw badRequest('这是内置的模块，删不了');
    const all = this._bk.listAssetGroups(Number(uid));
    const target = Number(id);
    const doomed = [];
    const seen = new Set();
    /** 功能：收集子树（含自己）。 @param {number} gid - 分组 id @returns {void} */
    const walk = (gid) => {
      if (seen.has(gid)) return;
      seen.add(gid);
      doomed.push(gid);
      for (const g of all) {
        if (Number(g.parent_id) === gid) walk(Number(g.id));
      }
    };
    walk(target);
    for (const gid of doomed) {
      this._bk.unbindAssetItems(Number(uid), gid);
      this._bk.deleteAssetGroup(Number(uid), gid);
    }
    return true;
  },

  /**
   * 功能：列出该账号的通用条目（`groupId` 为空时不过滤）。
   * @param {number} uid - 账号 id
   * @param {?(number|string)} groupId - 只看某个分组；null / '' 表示全部
   * @returns {{ items: Array.<Object>, total: number }} 条目数组与条数
   */
  listAssetItems(uid, groupId) {
    const items = this._bk.listAssetItems(Number(uid), groupId === undefined ? null : groupId);
    return { items, total: items.length };
  },

  /**
   * 功能：按 id 取一条通用条目。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {?Object} 条目行；不归本人或不存在时为 null
   */
  getAssetItem(uid, id) {
    return this._bk.getAssetItem(Number(uid), id);
  },

  /**
   * 功能：判断一条通用条目是否属于该账号。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsAssetItem(uid, id) {
    return this._bk.ownsAssetItem(Number(uid), id);
  },

  /**
   * 功能：新建一条通用条目。
   *
   * 说明：⚠️ 给了 `group_id` 时**必须先确认那个分组是本人的**（同 `createAssetGroup` 的理由）。
   *      ⚠️ `amount_fen` 允许为空（「这套房」可能不记金额），**空与 0 是两件事**：
   *      空 = 没填，0 = 真的是零元。⛔ 别把空归一成 0（那会凭空造一个数字）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - 已由 `validate.checkAssetItem` 归一化
   * @returns {Object} 新建的行（含 `id`）
   * @throws {Error} 分组不归本人 / 不存在时抛 404；数据层只读时抛 503
   */
  createAssetItem(uid, input) {
    this._assertWritable();
    const row = Object.assign({}, input);
    delete row.id;
    delete row.user_id;
    delete row.created_at;
    delete row.updated_at;
    row.user_id = Number(uid);
    const gid = row.group_id === undefined || row.group_id === null || row.group_id === '' ? null : Number(row.group_id);
    if (gid === null) {
      delete row.group_id;
    } else {
      if (!this.ownsAssetGroup(uid, gid)) throw notFoundErr('这个分组');
      row.group_id = gid;
    }
    const stamp = nowStamp();
    row.created_at = stamp;
    row.updated_at = stamp;
    return this._insert('asset_items', row);
  },

  /**
   * 功能：改一条通用条目（含「挂到别的分组 / 解绑」—— `group_id` 传空即解绑）。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @param {Object} input - 已由 `validate.checkAssetItem` 归一化
   * @returns {boolean} 是否真的更新到了（不归本人时为 false）
   * @throws {Error} 改挂到不归本人的分组时抛 404；数据层只读时抛 503
   */
  updateAssetItem(uid, id, input) {
    this._assertWritable();
    const patch = Object.assign({}, input);
    if (Object.prototype.hasOwnProperty.call(patch, 'group_id')) {
      const gid =
        patch.group_id === null || patch.group_id === undefined || patch.group_id === '' ? null : Number(patch.group_id);
      if (gid === null) patch.group_id = null;
      else {
        if (!this.ownsAssetGroup(uid, gid)) throw notFoundErr('这个分组');
        patch.group_id = gid;
      }
    }
    return this._update('asset_items', uid, id, patch);
  },

  /**
   * 功能：删除一条通用条目。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛 503
   */
  removeAssetItem(uid, id) {
    this._assertWritable();
    return this._bk.deleteAssetItem(Number(uid), id);
  },

  /**
   * 功能：校验分组归属：不属于 `uid`（或根本不存在）时抛 404。
   * @param {number} uid - 账号 id
   * @param {number} id - 分组 id
   * @returns {void}
   * @throws {Error} 不归该账号所有时抛 404
   */
  _assertAssetGroupOwned(uid, id) {
    if (!this.ownsAssetGroup(uid, id)) throw notFoundErr('这个分组');
  },

  /**
   * 功能：校验条目归属：不属于 `uid`（或根本不存在）时抛 404。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {void}
   * @throws {Error} 不归该账号所有时抛 404
   */
  _assertAssetItemOwned(uid, id) {
    if (!this.ownsAssetItem(uid, id)) throw notFoundErr('这条记录');
  },
};
