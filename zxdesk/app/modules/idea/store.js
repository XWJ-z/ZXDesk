'use strict';
/**
 * modules/idea/store.js —— 灵感库业务方法
 * 功能：灵感的业务方法 —— `listIdeas`（多词 AND 检索 + 未归档 / 归档筛选 + 标签筛选 + 汇总）/
 * `getIdea` / `ownsIdea` / `createIdea` / `updateIdea`（含归档与「变成任务」的标记）/
 * @author zx
 * @date   2026-09-17
 * @since 0.9.7
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md、
 */
const { nowStamp, notFoundErr, badRequest, splitTerms } = require('../../core/store/helpers.js');

/** 三种视图（界面上那三颗胶囊的顺序与它一一对应） @type {Array.<string>} */
const VIEWS = ['inbox', 'archived', 'all'];

/**
 *
 * **判据只在这里**：两端只把 `sort` 原样传上来，排序在前端**不做** ——
 */
const SORTS = {
  // 时间：新的在前（默认，与这一屏历来一致）
  time: (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id,
  // 时间：旧的在前
  'time-asc': (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id - b.id,
    // 按标签：标签名升序（**没打标签的排在最后**），同一个标签里按时间倒序
  // 标签成了一组 ⇒ 比的是**这组标签拼起来的串**（同组内已按用户输入顺序，够了）。
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
 *
 * 老库里有 `tag` 值、`tags` 是 NULL ⇒ 那一个标签照常出现（老数据一个字不丢）；
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
  // 兜老列：只有 `tags` 是空的时候才拿 `tag` 顶上（两列都有值时以新列为准）
  if (!out.length && r && r.tag) out.push(String(r.tag));
  return out;
}

/**
 * 功能：一次取回一批随手记各自的标签名（`Map<随手记 id, 标签名数组>`）。
 *
 * 说明：⭐ 走 `_bk.tagsOfIdeas()` **一次查回**（⛔ 绝不逐条查 = N+1），与收藏夹列表同一手法。
 * 只返回 Map、**不往行对象上挂字段** —— JSON 后端取回的是库里那些对象的**引用**，
 * 挂字段会随着下一次落盘混进 `zxdesk.json`（一条静默的数据污染）。
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
 * @param {*} s - 待判断的值
 */
function ownsSource(s) {
  return s === 'daily' || s === 'project';
}

/**
 * 功能：把一条灵感行整理成界面要的形状。
 *
 * 说明：⭐ `archived` 由 `archived_at` 派生出来（界面只关心「归没归档」这个布尔），
 * 而 `task_id` / `task_source` 一起给出 —— 只给 id 的话界面没法判断该跳去哪张表。
 * 输出里带 `title`（可能空串）—— 空 = 界面用「正文前 10 字」兜底，
 */
function shape(r, linkedNames) {
  const linked = cleanNames(linkedNames);
  const tags = linked.length ? linked : oldColTags(r);
  return {
    id: Number(r.id),
    content: String(r.content == null ? '' : r.content),
    title: String(r.title == null ? '' : r.title),
    tags,
    // 真机上装的旧包照着它显示与回填，于是「老包 + 新服务端」照样能用。
    // 新前端一律读 `tags`；写入侧再也不认 `tag`（见 schema.js 的 `allowedCols`）。
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
   * `q` 多词按 AND 匹配（对**标题 / 正文 / 标签**三处都查，大小写不敏感）；
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
    // 「未分类」用**具名哨兵** `'none'`，⚠️ 必须在任何 `Number()` 之前判掉，
    // 而且这里 `tag` 是**标签名精确匹配**（不是 id）—— 所以「叫 none 的标签」与「未分类」
    // 是两件事，必须显式分开，⛔ 不能让 `'none'` 落进名字匹配里。
    const wantNone = tag === 'none';
    const items = all
      .filter((r) => (view === 'all' ? true : view === 'archived' ? r.archived : !r.archived))
      // 标签是一组 ⇒ 命中**其中任意一个**就算这条匹配（收藏夹的分类筛选同口径）
      .filter((r) => (wantNone ? r.tags.length === 0 : tag ? r.tags.includes(tag) : true))
      // 检索打在**标题 + 正文 + 标签**三处：只搜正文的话，用户明明记得打了标签（或写了标题）
      // 却搜不到，而这一屏的成败就在「找得回来吗」（报告 §一 关键推论 1）
      .filter((r) =>
        terms.length
          ? terms.every((t) => `${r.title}\n${r.content}\n${r.tags.join(' ')}`.toLowerCase().includes(t))
          : true,
      );
    // 那样「新建的空标签」根本不会出现在左栏（它是这张表的全部意义）。
    // 从**全部**灵感里收的口径没变：给的是该账号的全部标签，不随本次筛选变化
    const tags = [...new Set(this._bk.listIdeaTags(Number(uid)).map((t) => String(t.name == null ? '' : t.name)))]
      .filter((n) => n)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    // 不认识的值**当默认**（与 `view` / `tag` 同一条口径：列表接口把参数打回 400，
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
   */
  createIdea(uid, input) {
    this._assertWritable();
    const stamp = nowStamp();
    const row = {
      user_id: Number(uid),
      content: String(input.content || ''),
      // 标题是一列平铺字段（可空）。⚠️ 空串 = 界面走「正文前 10 字」兜底。
      title: String(input.title == null ? '' : input.title),
      // 标签改住 `idea_tag_links`（见下面那句 `setIdeaTags`）。
      archived_at: input.archived ? stamp : null,
      task_id: null,
      task_source: null,
      created_at: stamp,
      updated_at: stamp,
    };
    const created = this._insert('idea_items', row);
    // 标签**只写 links**（把标签名交给原语，不存在就顺手建出来）。
    const names = cleanNames(input.tags);
    if (names.length) this._bk.setIdeaTags(Number(uid), Number(created.id), names);
    return shape(created, names);
  },

  /**
   * 功能：更新一条灵感 —— 改正文 / 标签、归档或取消归档、记下「已经变成哪个任务」。
   *
   * 说明：⚠️ 只改请求里真的带了的字段：局部更新是这个应用的常态。
   * `archived` 是**布尔**，这里翻成 `archived_at`；`true` 时若本来就已归档则
   * **保留原时间戳**（反复点归档不该把"哪天归的"刷成今天）。
   */
  updateIdea(uid, id, input) {
    this._assertWritable();
    const patch = Object.assign({}, input);
    // `tags` **不再是 `idea_items` 上的可写列**（它已被移出 `allowedCols`）
    // ⇒ 必须先摘出来单独处理 —— 直接混进 `_update` 会被白名单过滤掉，
    // 表现为「标签怎么都保存不上」（与收藏夹 `updateBookmark` 那条说明同源）。
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
    // 先把表上的列写完再换标签：`_update` 总会刷新 `updated_at` ⇒ 它顺带做了一次**归属校验**，
    // 返回 false（不归本人 / 不存在）时下面那句不会执行，⛔ 不会把标签挂到别人的随手记上。
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

  /**
   * 功能：列出该账号的标签（含每个标签下的条数）与**未分类**条数。
   *
   * 说明：⭐ 返回的就是 `GET /api/idea/tags` 的响应体 —— `{ tags, untagged }`，判据只在这里一份
   * （⛔ 不让前端合成「未分类」那一项）。
   * 排序是 `name` **拼音序**（与收藏夹标签的种类无关，随手记这一侧历来按名字排）。
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
   * 同名复用 200」（收藏夹那一条历来两者都 201，随手记这一侧按 分开）。
   *
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
   *
   * 说明：⚠️ 改名撞上同账号内已有的另一个标签名时明确 **400**（唯一索引兜底，这里先给人话）；
   * 改成自己原来的名字放行（保存时不动名字的常见路径）。
   *
   */
  renameIdeaTag(uid, id, name) {
    this._assertWritable();
    const n = String(name == null ? '' : name).trim();
    const mine = this._bk.listIdeaTags(Number(uid));
    // 归属先判、且**只 return false**（⛔ 不在这里抛 404）：路由层的 `writeResult` 会把它收口成
    // `notFound()` 那个**逐字固定**的响应体；在这里抛 `notFoundErr()` 走的是 `fail()`，
    // 那个响应体会多带一个 `readOnly` 字段 ⇒ 「越权」与「不存在」不再逐字一致。
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
   *
   * 说明：⭐⭐ 三条硬约束（`core/store/index.js` 的 `_backfillModuleData()` 那一段写着原话）——
   */
  backfillIdeaTagLinks() {
    if (this.readOnly) return;
    try {
      for (const u of this.listUsers()) {
        const uid = Number(u && u.id);
        if (!uid) continue;
        const rows = this._bk.listIdeas(uid);
        // 一次取回该账号的全部关联（⛔ 不逐条查），有 links 的行直接跳过 —— 幂等的判据就在这里。
        const linked = new Set(this._bk.tagsOfIdeas(uid, rows.map((r) => Number(r.id))).map((l) => Number(l.idea_id)));
        for (const r of rows) {
          if (linked.has(Number(r.id))) continue;
          const names = oldColTags(r);
          if (names.length) this._bk.setIdeaTags(uid, Number(r.id), names);
        }
      }
      this.ideaTagBackfillError = null;
    } catch (e) {
      // 绝不抛：如实记一个字段（启动日志靠它说出来），启动照常。
      this.ideaTagBackfillError = (e && e.message) || String(e);
    }
  },

  /**
   *
   * 说明：⭐ 它是「随手记 →（一键）→ 任务」那条通道在**服务端**的回程 —— 由任务侧在建完任务时
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
   *
   * 说明：⭐ 任务**迁入 done** 时由任务侧调它（落点在 `tasks/lib/tasks.js` 的
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
   * 手动归档 / 取消归档**不碰**绑定 —— 这一条只管「任务没了」。
   */
  /**
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
   * 「某项目任务 3」判成同一件事（与 schema 里那条取舍同源）。
   * 筛选只在**这里**实现一份（两个后端只提供「把该账号的行全取回来」这一条原语），
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
