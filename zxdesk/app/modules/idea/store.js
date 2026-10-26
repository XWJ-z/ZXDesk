'use strict';
/**
 * modules/idea/store.js —— 灵感库业务方法（0.7.1）
 *
 * 功能：灵感的业务方法 —— `listIdeas`（多词 AND 检索 + 未归档 / 归档筛选 + 标签筛选 + 汇总）/
 *      `getIdea` / `ownsIdea` / `createIdea` / `updateIdea`（含归档与「变成任务」的标记）/
 *      `removeIdea`；标签侧 `listIdeaTags` / `createIdeaTag` / `renameIdeaTag` / `removeIdeaTag`
 *      （0.8.15）；启动幂等回填 `backfillIdeaTagLinks()`；
 *      以及供路由层复用的归属校验 `_assertIdeaOwned`。
 *
 * ⭐⭐ 0.8.15标签改住**两张真表**（`idea_tags` ＋ `idea_tag_links`，与收藏夹逐字同构）
 *    ⇒ 读一条的标签 = `links` 里的标签；**links 为空而老的 `tags` 数组非空时兜底用它**
 *    （再兜更老的 `tag` 单值列）—— 这就是「老库升级不丢标签」的那条读侧双认。
 *    新写入**一律只写 links**，`idea_items.tags` 从此是**只读的历史列**。
 *    ⚠️ 那个兜底只该在「启动回填还没跑」时兜得住：`backfillIdeaTagLinks()` 会把老 `tags` 数组补成
 *    links，且**只往新表插行、一个字都不改 `idea_items`**，幂等靠唯一索引。
 *
 * ⚠️ **方法名一律带模块前缀，绝不用 `list` / `get` 这种通用名**：`store/index.js` 是把全部业务模块
 *    平铺到**同一个原型**上的 —— 两个模块各写一个 `list()`，后来者会**静默覆盖**前者
 *    （先例：0.3.1 硬件模块的 `list` 盖掉收藏夹的，由 `bookmarks.test.js` 当场抓住）。
 *    0.5.0 起这条规矩另有装配期护栏（`assertNoMethodClash()`）兜住，撞名一律启动即抛。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走 `this._bk.<op>(...)`。
 *
 * ⭐ **检索与筛选都只在文件里实现一份**：两个后端只提供「把该账号的行全取回来」这一条原语，
 *    匹配与分拣全在上层做 —— 这样「装的是 SQLite 还是 JSON 回退，结果就不一样」这种漂移
 *    **在结构上不可能发生**（与收藏夹检索、硬件寿命同一条理由）。
 *
 * ⭐ **归档（`archived`）在接口上是布尔，在库里是时间戳**：`true` 写当前时间（原本已归档则**不动**它，
 *    免得反复归档把时间戳刷新成"今天归的"）、`false` 清空。这层翻译只在这里做一份 ——
 *    界面不该知道库里存的是时间戳这件事。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.15
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md、
 *      docs/公共/开发方案/36-标签与分类统一.md、docs/公共/开发方案/37-随手记卡片与标题.md
 */
const { nowStamp, notFoundErr, badRequest, splitTerms } = require('../../core/store/helpers.js');

/** 三种视图（界面上那三颗胶囊的顺序与它一一对应） @type {Array.<string>} */
const VIEWS = ['inbox', 'archived', 'all'];

/**
 * 三种排序（⭐ 0.8.14「新增筛选：筛选排序 字段：时间、标签」）。
 *
 * ⚠️⭐ **判据只在这里**：两端只把 `sort` 原样传上来，排序在前端**不做** ——
 *    「时间」与「标签」两套比较器各写一份必然漂移，而那种漂移的表现是
 *    「手机上排得对、电脑上排得不对」，没人会想到是两份代码。
 *
 * @type {Object.<string, Function>}
 */
const SORTS = {
  // 时间：新的在前（默认，与这一屏历来一致）
  time: (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id,
  // 时间：旧的在前
  'time-asc': (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id - b.id,
    // 按标签：标签名升序（**没打标签的排在最后**），同一个标签里按时间倒序
  // ⚠️ 0.8.14：标签成了一组 ⇒ 比的是**这组标签拼起来的串**（同组内已按用户输入顺序，够了）。
  tag: (a, b) => {
    const at = (a.tags || []).join(' ');
    const bt = (b.tags || []).join(' ');
    if (!at !== !bt) return at ? -1 : 1;
    const t = at.localeCompare(bt, 'zh');
    return t || String(b.created_at || '').localeCompare(String(a.created_at || ''));
  },
};

/**
 * 功能：把一组标签名归一化 —— trim、去空、**去重（保留首次出现的先后）**。
 * @param {*} list - 任意值（不是数组时当成空）
 * @returns {Array.<string>} 干净的标签名数组
 */
function cleanNames(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((x) => {
    const v = String(x == null ? '' : x).trim();
    if (v && !out.includes(v)) out.push(v);
  });
  return out;
}

/**
 * 功能：从**老的只读列**里读出一组标签（0.8.15 起它只在 links 为空时兜底用）。
 *
 * 说明：⭐ `tags`（0.8.14 的规范化 JSON 数组文本）与 `tag`（更老的单值列）**都认** ——
 *      老库里有 `tag` 值、`tags` 是 NULL ⇒ 那一个标签照常出现（老数据一个字不丢）；
 *      新写入只写 links（见 `createIdea` / `updateIdea`）。
 *      ⚠️ 坏 JSON / 非数组一律当成「没有标签」（⛔ 一条脏数据不该把整屏打白，
 *      与 `core/recur.js` 的 `parseRule()` 同一条口径）。
 *
 * @param {Object} r - 库里的行（可能带 `tags` 也可能只有老的 `tag`）
 * @returns {Array.<string>} 标签数组（可能为空）
 */
function oldColTags(r) {
  const out = [];
  const raw = r && r.tags;
  if (Array.isArray(raw)) {
    raw.forEach((x) => {
      const v = String(x == null ? '' : x).trim();
      if (v && !out.includes(v)) out.push(v);
    });
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((x) => {
          const v = String(x == null ? '' : x).trim();
          if (v && !out.includes(v)) out.push(v);
        });
      }
    } catch (_e) {
      /* 坏 JSON = 没有标签，见上面说明 */
    }
  }
  // ⭐ 兜老列：只有 `tags` 是空的时候才拿 `tag` 顶上（两列都有值时以新列为准）
  if (!out.length && r && r.tag) out.push(String(r.tag));
  return out;
}

/**
 * 功能：一次取回一批随手记各自的标签名（`Map<随手记 id, 标签名数组>`）。
 *
 * 说明：⭐ 走 `_bk.tagsOfIdeas()` **一次查回**（⛔ 绝不逐条查 = N+1），与收藏夹列表同一手法。
 *      ⚠️ 只返回 Map、**不往行对象上挂字段** —— JSON 后端取回的是库里那些对象的**引用**，
 *      挂字段会随着下一次落盘混进 `zxdesk.json`（一条静默的数据污染）。
 *
 * @param {Object} store - Store 实例（要用它取后端原语）
 * @param {number} uid - 账号 id
 * @param {Array.<Object>} rows - 随手记行
 * @returns {Map.<number, Array.<string>>} 随手记 id → 标签名数组
 */
function tagNamesByIdea(store, uid, rows) {
  const byId = new Map();
  store._bk.tagsOfIdeas(Number(uid), rows.map((r) => Number(r.id))).forEach((l) => {
    const k = Number(l.idea_id);
    const list = byId.get(k) || [];
    list.push(String(l.name == null ? '' : l.name));
    byId.set(k, list);
  });
  return byId;
}

/**
 * 「这条灵感变成了哪张表里的任务」—— 只能是这两张之一（与 `idea_items.task_source` 的 CHECK 同源）。
 * ⚠️ 日常任务与项目任务是**两张表**，id 各自从 1 开始 ⇒ 只记 id 认不出是哪一张。
 * @param {*} s - 待判断的值
 * @returns {boolean} 是 `'daily'` / `'project'` 之一则为 true
 */
function ownsSource(s) {
  return s === 'daily' || s === 'project';
}

/**
 * 功能：把一条灵感行整理成界面要的形状。
 *
 * 说明：⭐ `archived` 由 `archived_at` 派生出来（界面只关心「归没归档」这个布尔），
 *      而 `task_id` / `task_source` 一起给出 —— 只给 id 的话界面没法判断该跳去哪张表。
 *      ⭐ 0.8.15：输出里带 `title`（可能空串）—— 空 = 界面用「正文前 10 字」兜底，
 *      ⛔ 那个兜底**不落库**（判据在前端 `modules/idea/shared.js`）。
 *      ⚠️ 标签**由调用方算好传进来**（`links` 优先、老列兜底）：这里不碰后端，
 *      所以 `shape()` 既能用于列表也能用于单条，两条路的口径必然一致。
 *
 * @param {Object} r - 库里的行
 * @param {Array.<string>} [linkedNames] - 该条在 `idea_tag_links` 里的标签名（空 = 走老列兜底）
 * @returns {Object} 界面用的对象（同一份字段名，两端共用）
 */
function shape(r, linkedNames) {
  const linked = cleanNames(linkedNames);
  const tags = linked.length ? linked : oldColTags(r);
  return {
    id: Number(r.id),
    content: String(r.content == null ? '' : r.content),
    title: String(r.title == null ? '' : r.title),
    tags,
    // ⚠️⭐ `tag` 是**给旧前端包留的只读派生字段**（0.8.14 之前那一版只认单标签）——
    //    真机上装的旧包照着它显示与回填，于是「老包 + 新服务端」照样能用。
    //    ⛔ 新前端一律读 `tags`；写入侧再也不认 `tag`（见 schema.js 的 `allowedCols`）。
    tag: tags[0] || '',
    archived: !!r.archived_at,
    archived_at: r.archived_at || '',
    task_id: r.task_id == null ? null : Number(r.task_id),
    task_source: r.task_source || '',
    created_at: r.created_at || '',
    updated_at: r.updated_at || '',
  };
}

module.exports = {
  /**
   * 功能：列出该账号的灵感（新的在前），支持检索 / 视图筛选 / 标签筛选，并给出汇总。
   *
   * @param {number} uid - 账号 id
   * @param {Object} [opts] - `{ q, view, tag, sort }`；
   *     `q` 多词按 AND 匹配（对**标题 / 正文 / 标签**三处都查，大小写不敏感）；
   *     `view` 取 `inbox`（默认，未归档）/ `archived` / `all`，不认识的值当 `inbox`；
   *     `tag` 按**标签名**精确匹配其中任意一个（空 = 不筛；0.8.14 起标签是一组）；
   *     ⭐ `tag = 'none'`（具名哨兵）= 只看**一个标签都没有**的（收藏夹 `tag=none` 同款）；
   *     `sort` 取 `time`（默认，新在前）/ `time-asc` / `tag`（按标签；没打标签的排最后），
   *     不认识的值当 `time`
   * @returns {{items: Array.<Object>, total: number, inbox: number, archived: number, tags: Array.<string>}}
   *     `items` 是筛后的行；`total` / `inbox` / `archived` 是**未筛选前**的总量（三颗胶囊上的计数），
   *     `tags` 是该账号的**全部标签名**（从 `idea_tags` 读、去重、按拼音序；含一个都没挂的**新标签**）
   */
  listIdeas(uid, opts) {
    const o = opts || {};
    const rows = this._bk.listIdeas(Number(uid));
    const nameOf = tagNamesByIdea(this, uid, rows);
    const all = rows.map((r) => shape(r, nameOf.get(Number(r.id))));
    const view = VIEWS.includes(o.view) ? o.view : 'inbox';
    const kw = String(o.q || '').trim().toLowerCase();
    const tag = String(o.tag || '').trim();
    const terms = splitTerms(kw);
    // ⭐⭐ 0.8.15：「未分类」用**具名哨兵** `'none'`，⚠️ 必须在任何 `Number()` 之前判掉，
    //    而且这里 `tag` 是**标签名精确匹配**（不是 id）—— 所以「叫 none 的标签」与「未分类」
    //    是两件事，必须显式分开，⛔ 不能让 `'none'` 落进名字匹配里。
    const wantNone = tag === 'none';
    const items = all
      .filter((r) => (view === 'all' ? true : view === 'archived' ? r.archived : !r.archived))
      // ⭐ 0.8.14：标签是一组 ⇒ 命中**其中任意一个**就算这条匹配（收藏夹的分类筛选同口径）
      .filter((r) => (wantNone ? r.tags.length === 0 : tag ? r.tags.includes(tag) : true))
      // ⚠️ 检索打在**标题 + 正文 + 标签**三处：只搜正文的话，用户明明记得打了标签（或写了标题）
      //    却搜不到，而这一屏的成败就在「找得回来吗」（报告 §一 关键推论 1）
      .filter((r) =>
        terms.length
          ? terms.every((t) => `${r.title}\n${r.content}\n${r.tags.join(' ')}`.toLowerCase().includes(t))
          : true,
      );
    // ⚠️⭐ 标签清单从**标签表**读（0.8.15 起标签是两张真表）—— 不再「扫全表算标签」：
    //    那样「新建的空标签」根本不会出现在左栏（它是这张表的全部意义）。
    //    ⚠️ 从**全部**灵感里收的口径没变：给的是该账号的全部标签，不随本次筛选变化
    //    （否则「当前筛了某个标签 ⇒ 清单里只剩那一个」会把左栏越点越少）。
    const tags = [...new Set(this._bk.listIdeaTags(Number(uid)).map((t) => String(t.name == null ? '' : t.name)))]
      .filter((n) => n)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    // ⚠️ 不认识的值**当默认**（与 `view` / `tag` 同一条口径：列表接口把参数打回 400，
    //    只会让用户对着一个空白页，而不是「没排出来」）。
    items.sort(SORTS[o.sort] || SORTS.time);
    return {
      items,
      total: all.length,
      inbox: all.filter((r) => !r.archived).length,
      archived: all.filter((r) => r.archived).length,
      tags,
    };
  },

  /**
   * 功能：按 id 取一条灵感。
   * @param {number} uid - 账号 id
   * @param {number} id - 灵感 id
   * @returns {?Object} 界面用的对象；不存在或不归本人时为 null
   */
  getIdea(uid, id) {
    const r = this._bk.getIdea(Number(uid), id);
    if (!r) return null;
    return shape(r, tagNamesByIdea(this, uid, [r]).get(Number(r.id)));
  },

  /**
   * 功能：判断一条灵感是否属于该账号。
   * @param {number} uid - 账号 id
   * @param {number} id - 灵感 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsIdea(uid, id) {
    return this._bk.ownsIdea(Number(uid), id);
  },

  /**
   * 功能：新建一条灵感 —— **捕获那一刻只要求一个正文**（这是本功能的核心指标）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - 已由 `validate.checkIdea` 归一化
   * @returns {Object} 新建的行（界面形状）
   * @throws {Error} 数据层只读时抛 503
   */
  createIdea(uid, input) {
    this._assertWritable();
    const stamp = nowStamp();
    const row = {
      user_id: Number(uid),
      content: String(input.content || ''),
      // ⭐ 0.8.15：标题是一列平铺字段（可空）。⚠️ 空串 = 界面走「正文前 10 字」兜底。
      title: String(input.title == null ? '' : input.title),
      // ⚠️⭐ 老的 `tag` 列与 0.8.14 的 `tags` 列**一个字都不写** —— 它们从此是只读的历史列，
      //    标签改住 `idea_tag_links`（见下面那句 `setIdeaTags`）。
      archived_at: input.archived ? stamp : null,
      task_id: null,
      task_source: null,
      created_at: stamp,
      updated_at: stamp,
    };
    const created = this._insert('idea_items', row);
    // ⭐ 0.8.15：标签**只写 links**（把标签名交给原语，不存在就顺手建出来）。
    const names = cleanNames(input.tags);
    if (names.length) this._bk.setIdeaTags(Number(uid), Number(created.id), names);
    return shape(created, names);
  },

  /**
   * 功能：更新一条灵感 —— 改正文 / 标签、归档或取消归档、记下「已经变成哪个任务」。
   *
   * 说明：⚠️ 只改请求里真的带了的字段：局部更新是这个应用的常态。
   *      ⭐ `archived` 是**布尔**，这里翻成 `archived_at`；`true` 时若本来就已归档则
   *      **保留原时间戳**（反复点归档不该把"哪天归的"刷成今天）。
   *      ⚠️ `task_id` 与 `task_source` **必须成对写**（见 schema.js 的取舍 ②）——
   *      只给 id 的请求一律把两者一起清空，绝不留一个半截的状态。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 灵感 id
   * @param {Object} input - 已由 `validate.checkIdea` 归一化
   *     （`{ content?, title?, tags?, archived?, task_id?, task_source? }`）
   * @returns {boolean} 是否真的更新到了（不归本人时为 false）
   * @throws {Error} 数据层只读时抛 503
   */
  updateIdea(uid, id, input) {
    this._assertWritable();
    const patch = Object.assign({}, input);
    // ⚠️⭐ 0.8.15：`tags` **不再是 `idea_items` 上的可写列**（它已被移出 `allowedCols`）
    //    ⇒ 必须先摘出来单独处理 —— 直接混进 `_update` 会被白名单过滤掉，
    //    表现为「标签怎么都保存不上」（与收藏夹 `updateBookmark` 那条说明同源）。
    const hasTags = Object.prototype.hasOwnProperty.call(patch, 'tags');
    const tags = patch.tags;
    delete patch.tags;
    if (Object.prototype.hasOwnProperty.call(patch, 'archived')) {
      const want = !!patch.archived;
      delete patch.archived;
      const cur = this._bk.getIdea(Number(uid), id);
      // 取消归档恒清空；归档则"已经是归档的就别动它原来的时间"
      patch.archived_at = want ? (cur && cur.archived_at) || nowStamp() : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'task_id')) {
      if (!patch.task_id || !patch.task_source) {
        patch.task_id = null;
        patch.task_source = null;
      }
    }
    // ⚠️ 先把表上的列写完再换标签：`_update` 总会刷新 `updated_at` ⇒ 它顺带做了一次**归属校验**，
    //    返回 false（不归本人 / 不存在）时下面那句不会执行，⛔ 不会把标签挂到别人的随手记上。
    const ok = this._update('idea_items', uid, id, patch);
    if (ok && hasTags) this._bk.setIdeaTags(Number(uid), Number(id), cleanNames(tags));
    return ok;
  },

  /**
   * 功能：删除一条灵感。
   * @param {number} uid - 账号 id
   * @param {number} id - 灵感 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛 503
   */
  removeIdea(uid, id) {
    this._assertWritable();
    return this._bk.deleteIdea(Number(uid), id);
  },

  // ---------------- 标签（0.8.15）：与收藏夹的分类一套 ----------------
  /**
   * 功能：列出该账号的标签（含每个标签下的条数）与**未分类**条数。
   *
   * 说明：⭐ 返回的就是 `GET /api/idea/tags` 的响应体 —— `{ tags, untagged }`，判据只在这里一份
   *      （⛔ 不让前端合成「未分类」那一项）。
   *      ⚠️ 排序是 `name` **拼音序**（与收藏夹标签的种类无关，随手记这一侧历来按名字排）。
   *
   * @param {number} uid - 账号 id
   * @returns {{tags: Array.<{id: number, name: string, count: number}>, untagged: number}}
   *     标签数组（按名字拼音序；`count` 是该标签下的随手记条数）与「一条标签都没有」的条数
   */
  listIdeaTags(uid) {
    const tags = this._bk.listIdeaTags(Number(uid)).map((t) => ({
      id: Number(t.id),
      name: String(t.name == null ? '' : t.name),
      count: Number(t.count) || 0,
    }));
    tags.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return { tags, untagged: this._bk.untaggedCount(Number(uid)) };
  },

  /**
   * 功能：新建一个标签；同账号内同名**直接返回已有的那一个**（幂等，「智能新建」同款）。
   *
   * 说明：⭐ 返回值里多一个 `created` 给路由层区分 **201 / 200** —— 契约要求「新建 201、
   *      同名复用 200」（收藏夹那一条历来两者都 201，随手记这一侧按 分开）。
   *
   * @param {number} uid - 账号 id
   * @param {string} name - 标签名（已由 `validate.checkTag` 归一化）
   * @returns {{tag: {id: number, name: string, count: number}, created: boolean}} 标签与「是不是新建的」
   * @throws {Error} 数据层只读时抛 503
   */
  createIdeaTag(uid, name) {
    this._assertWritable();
    const n = String(name == null ? '' : name).trim();
    const existed = this._bk.listIdeaTags(Number(uid)).find((t) => String(t.name) === n);
    if (existed) {
      return { tag: { id: Number(existed.id), name: n, count: Number(existed.count) || 0 }, created: false };
    }
    const row = this._bk.createIdeaTag(Number(uid), n);
    return {
      tag: { id: Number(row.id), name: String(row.name == null ? '' : row.name), count: 0 },
      created: true,
    };
  },

  /**
   * 功能：把一个标签改名（⭐ **一次 `UPDATE` 改 tag 行就够** —— links 指向 id、不指向名字，
   *      这正是「加真表」换来的好处，⛔ 别再全表改写）。
   *
   * 说明：⚠️ 改名撞上同账号内已有的另一个标签名时明确 **400**（唯一索引兜底，这里先给人话）；
   *      改成自己原来的名字放行（保存时不动名字的常见路径）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 标签 id
   * @param {string} name - 新名字
   * @returns {boolean} 是否真的改到了（越权 / 不存在时 false，由路由层统一 404）
   * @throws {Error} 重名时抛 400；数据层只读时抛 503
   */
  renameIdeaTag(uid, id, name) {
    this._assertWritable();
    const n = String(name == null ? '' : name).trim();
    const mine = this._bk.listIdeaTags(Number(uid));
    // ⚠️ 归属先判、且**只 return false**（⛔ 不在这里抛 404）：路由层的 `writeResult` 会把它收口成
    //    `notFound()` 那个**逐字固定**的响应体；在这里抛 `notFoundErr()` 走的是 `fail()`，
    //    那个响应体会多带一个 `readOnly` 字段 ⇒ 「越权」与「不存在」不再逐字一致。
    if (!mine.some((t) => Number(t.id) === Number(id))) return false;
    const other = mine.find((t) => String(t.name) === n && Number(t.id) !== Number(id));
    if (other) throw badRequest(`已经有一个叫「${n}」的标签了`);
    return this._bk.renameIdeaTag(Number(uid), Number(id), n);
  },

  /**
   * 功能：删除一个标签 —— **随手记一条都不删**，只解除归类。
   * @param {number} uid - 账号 id
   * @param {number} id - 标签 id
   * @returns {boolean} 是否真的删掉了一行（越权 / 不存在时 false，由路由层统一 404）
   * @throws {Error} 数据层只读时抛 503
   */
  removeIdeaTag(uid, id) {
    this._assertWritable();
    return this._bk.removeIdeaTag(Number(uid), Number(id));
  },

  /**
   * 功能：把老的 `idea_items.tags` 数组**幂等回填**成两张新表的行（0.8.15， / A-3）。
   *
   * 说明：⭐⭐ 三条硬约束（`core/store/index.js` 的 `_backfillModuleData()` 那一段写着原话）——
   *      ① **只往新表插行，⛔ 一个字节都不改 `idea_items`**（启动与迁移绝不改写用户数据）；
   *      ② **幂等**：该条在 `idea_tag_links` 里已有行就跳过，重复启动不产生第二份；
   *      ③ ⚠️⚠️ **绝不许抛** —— 它跑在 `_init()` 的 SQLite `try` 里，抛出去会被判成「库打不开」
   *      ⇒ **整个数据层降级成只读**（一个回填小毛病换来「应用不能写」，代价完全不成比例）。
   *      失败就把原因记进 `this.ideaTagBackfillError` 然后**正常返回**
   *      （照 `time/timetable/store.js` 的 `seedSchoolTemplates()` 那个先例）。
   *      ⚠️ 只读降级时直接跳过：宁可不回填，也不在只读态下试图写盘。
   *
   * @returns {void}
   */
  backfillIdeaTagLinks() {
    if (this.readOnly) return;
    try {
      for (const u of this.listUsers()) {
        const uid = Number(u && u.id);
        if (!uid) continue;
        const rows = this._bk.listIdeas(uid);
        // ⭐ 一次取回该账号的全部关联（⛔ 不逐条查），有 links 的行直接跳过 —— 幂等的判据就在这里。
        const linked = new Set(this._bk.tagsOfIdeas(uid, rows.map((r) => Number(r.id))).map((l) => Number(l.idea_id)));
        for (const r of rows) {
          if (linked.has(Number(r.id))) continue;
          const names = oldColTags(r);
          if (names.length) this._bk.setIdeaTags(uid, Number(r.id), names);
        }
      }
      this.ideaTagBackfillError = null;
    } catch (e) {
      // ⚠️ 绝不抛：如实记一个字段（启动日志靠它说出来），启动照常。
      this.ideaTagBackfillError = (e && e.message) || String(e);
    }
  },

  /**
   * 功能：把一条灵感**绑定**到刚建出来的那条任务上（0.8.14）。
   *
   * 说明：⭐ 它是「随手记 →（一键）→ 任务」那条通道在**服务端**的回程 —— 由任务侧在建完任务时
   *      调它（`typeof` 守卫的可选调用），⛔ 不是随手记自己去 POST 一次。
   *      理由（方案 §四②末段）：表单交给任务板之后，刚建出来的任务 id **到不了随手记手里**，
   *      剩下的只有「再读一次任务列表猜哪条是刚建的」那种不可靠做法。
   *      ⚠️ `task_id` 与 `task_source` **必须成对写**（日常任务与项目任务是两张表、id 各自从 1 开始）。
   *      ⚠️ 只在**创建那一刻**调一次 —— 来源列写一次就定死（与 `from_message_id` 同一性质）。
   *
   * @param {number} uid - 账号 id
   * @param {number} ideaId - 灵感 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 刚建出来的任务 id
   * @returns {boolean} 是否真的写到了（灵感不存在 / 不归本人时 false）
   * @throws {Error} 数据层只读时抛 503
   */
  bindIdeaTask(uid, ideaId, source, taskId) {
    const tid = Number(taskId);
    if (!tid || !ownsSource(source)) return false;
    if (!this._bk.ownsIdea(Number(uid), Number(ideaId))) return false;
    return this._update('idea_items', Number(uid), Number(ideaId), {
      task_id: tid,
      task_source: source,
    });
  },

  /**
   * 功能：按「任务来源 + 任务 id」找到那条灵感并**归档**它（0.8.14）。
   *
   * 说明：⭐ 任务**迁入 done** 时由任务侧调它（落点在 `tasks/lib/tasks.js` 的
   *      `_maintainCompletedAt()` —— 那是「状态迁入 done」的唯一判定处）。
   *      ⚠️ **原本已经归档的就不动** —— 与 `updateIdea()` 同一口径（反复归档不该把
   *      「哪天归的」刷成今天）。
   *      ⚠️ 删掉的灵感 / 没绑定的任务在这里自然什么都不做（一次纯内存遍历）。
   *
   * @param {number} uid - 账号 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @returns {number} 本次真的归档了几条（0 或 1 —— 只可能有一条）
   * @throws {Error} 数据层只读时抛 503
   */
  archiveIdeaByTask(uid, source, taskId) {
    const hits = this._ideasBoundTo(uid, source, taskId);
    if (!hits.length) return 0;
    const stamp = nowStamp();
    let n = 0;
    for (const r of hits) {
      if (r.archived_at) continue; // 已经归档的：⛔ 不动它原来的时间戳
      this._update('idea_items', Number(uid), Number(r.id), { archived_at: stamp });
      n++;
    }
    return n;
  },

  /**
   * 功能：任务被删时**清掉**灵感上那条绑定（0.8.14）。
   *
   * 说明：⚠️ 不清的后果：那条随手记永远顶着一枚**指空的**「已变成任务」，
   *      而且再也点不了「变成任务」（因为绑定还在）。
   *      ⚠️ 手动归档 / 取消归档**不碰**绑定 —— 这一条只管「任务没了」。
   *
   * @param {number} uid - 账号 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 刚被删掉的任务 id
   * @returns {number} 本次清掉了几条绑定
   * @throws {Error} 数据层只读时抛 503
   */
  /**
   * 功能：把「绑在某条任务上」的灵感**改绑到另一条任务**（0.8.14，配合「任务改归属」）。
   *
   * 说明：⭐ 任务换归属是「往目标表插一行 + 删原行」（`daily_tasks` 与 `project_tasks` 是两张
   *      物理表）⇒ **任务 id 会变**，而随手记那条追溯是按 `task_id` + `task_source` 挂的。
   *      不跟着改，用户看到的就是「明明搬过去了，随手记却说还没变成任务」—— 而且**不报错**。
   *      ⚠️ 与 `clearIdeaTask()` 是两件事：那个是「任务没了 ⇒ 把绑定清掉」，这个是「任务换了个
   *      id ⇒ 把绑定**挪过去**」（清掉会丢追溯，用户得重新点一次「变成任务」）。
   *
   * @param {number} uid - 账号 id
   * @param {string} fromSource - 原来源 `'daily'` / `'project'`
   * @param {number} fromTaskId - 原任务 id
   * @param {string} toSource - 新来源
   * @param {number} toTaskId - 新任务 id
   * @returns {number} 改了几条（0 = 没有挂在它上面的灵感，正常）
   */
  rebindIdeaTask(uid, fromSource, fromTaskId, toSource, toTaskId) {
    const tid = Number(toTaskId);
    if (!ownsSource(fromSource) || !ownsSource(toSource) || !tid) return 0;
    const hits = this._ideasBoundTo(uid, fromSource, fromTaskId);
    let n = 0;
    for (const r of hits) {
      this._update('idea_items', Number(uid), Number(r.id), { task_id: tid, task_source: toSource });
      n++;
    }
    return n;
  },

  clearIdeaTask(uid, source, taskId) {
    const hits = this._ideasBoundTo(uid, source, taskId);
    let n = 0;
    for (const r of hits) {
      this._update('idea_items', Number(uid), Number(r.id), { task_id: null, task_source: null });
      n++;
    }
    return n;
  },

  /**
   * 功能：找出「绑在（来源, 任务 id）上」的全部灵感行（原始行，未过 `shape()`）。
   *
   * 说明：⚠️ 按 `task_id + task_source` **成对匹配** —— 只比 id 会把「日常任务 3」与
   *      「某项目任务 3」判成同一件事（与 schema 里那条取舍同源）。
   *      ⚠️ 筛选只在**这里**实现一份（两个后端只提供「把该账号的行全取回来」这一条原语），
   *      与 `listIdeas()` 的检索同一条纪律。
   *
   * @param {number} uid - 账号 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @returns {Array.<Object>} 命中的灵感原始行
   */
  _ideasBoundTo(uid, source, taskId) {
    const tid = Number(taskId);
    if (!tid || !ownsSource(source)) return [];
    return this._bk
      .listIdeas(Number(uid))
      .filter((r) => r && Number(r.task_id) === tid && String(r.task_source || '') === source);
  },

  /**
   * 功能：校验灵感归属：不属于 `uid`（或根本不存在）时抛 404。
   * @param {number} uid - 账号 id
   * @param {number} id - 灵感 id
   * @returns {void}
   * @throws {Error} 不归本人 / 不存在时抛 404
   */
  _assertIdeaOwned(uid, id) {
    if (!this._bk.ownsIdea(Number(uid), id)) throw notFoundErr();
  },
};
