'use strict';
/**
 * modules/bookmarks/store.js —— 网址收藏夹业务方法
 * 功能：书签与分类的业务方法。书签侧：`listBookmarks`（检索 + 分类筛选）/ `get` / `create` /
 * `update` / `remove` / `ownsBookmark`；分类侧：`listTags` / `createTag` /
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/开发方案/03-网址收藏夹-1期.md
 */
const { nowStamp, notFoundErr, badRequest, splitTerms } = require('../../core/store/helpers.js');

/**
 * 功能：判断一条书签是否命中全部关键词，并给出「标题命中」这一相关度信号。
 *
 * 说明：⭐ 检索面是 **标题 + 网址 + 分类名** 三处：
 * 标题命中优先于「只在网址里命中」—— 用户多半记得的是名字而不是网址；
 * 判定与排序**分开**：`titleHit` 只用于排序，不影响是否命中。
 */
function matchBookmark(b, terms, tagText) {
  if (!terms.length) return { titleHit: false };
  const title = String(b.title || '').toLowerCase();
  const url = String(b.url || '').toLowerCase();
  const tags = String(tagText || '');
  let titleHit = false;
  for (const t of terms) {
    const inTitle = title.includes(t);
    const inUrl = url.includes(t);
    const inTag = tags.includes(t);
    if (!inTitle && !inUrl && !inTag) return null; // 多词 AND：有一个词没命中就整条不命中
    if (inTitle) titleHit = true;
  }
  return { titleHit };
}

module.exports = {
  // ---------------- 书签 ----------------
  /**
   * 功能：列出（并按关键词 + 分类筛选）某账号的书签，每条都带上它所属的分类。
   *
   * 说明：⭐ 返回结构 `{ items, total, tags }` 是**一次请求就能画完整页**的最小集合 ——
   * `tags` 顺带把分类列表（含计数）也给了，前端不必再打一次 `/tags`。
   */
  listBookmarks(uid, q, tagId) {
    const terms = splitTerms(q);
    // 「未分类」是一个**具名哨兵** `'none'`（不用 NULL / 0）——
    // 它必须在 `Number()` **之前**判掉：`Number('none')` 是 `NaN`，而 `NaN` 在下面那句的
    // 语义是「不筛」⇒ 直接塞 `'none'` 会**静默退化成"列出全部"**（一个不会报错的错答案）。
    const rawTag = String(tagId == null ? '' : tagId).trim();
    const wantNone = rawTag === 'none';
    const tag = Number(rawTag);
    const byTag = Number.isInteger(tag) && tag > 0 ? tag : null;

    // 分类与关联**一次性取回**（原语层已保证两后端结果一致）
    const tags = this.listTags(uid);
    const links = this._bk.listBookmarkTags(Number(uid));
    const tagNameOf = new Map(tags.map((t) => [t.id, t.name]));

    /** @type {Array.<Object>} */
    const out = [];
    let untagged = 0;
    for (const b of this._bk.listBookmarks(Number(uid))) {
      const myTags = links.filter((l) => l.bookmark_id === b.id).map((l) => Number(l.tag_id));
      // 「未分类」的判据是「这一条一条分类都没有」—— 从**全部**书签上数（不是筛完的 `out`）。
      if (!myTags.length) untagged += 1;
      if (wantNone) {
        if (myTags.length) continue;
      } else if (byTag !== null && !myTags.includes(byTag)) {
        continue;
      }
      const tagText = myTags
        .map((id) => tagNameOf.get(id))
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const m = matchBookmark(b, terms, tagText);
      if (!m) continue;
      out.push(
        Object.assign({}, b, {
          tag_ids: myTags,
          tag_names: myTags.map((id) => tagNameOf.get(id)).filter(Boolean),
          _titleHit: m.titleHit,
        }),
      );
    }

    // 相关度：标题命中的排在「只命中 URL」前面；同档保持原语层给的倒序（新加的在前）
    out.sort((a, b) => Number(b._titleHit) - Number(a._titleHit));
    const items = out.map((b) => {
      const { _titleHit, ...rest } = b;
      return rest;
    });
    // 「未分类」那一项由**服务端**给，且**永远排在末尾**（既有客户端读 `tags[0]` 之类不受影响）。
    tags.push({ id: 'none', name: '未分类', count: untagged });
    return { items, total: items.length, tags };
  },

  /**
   * 功能：按 id 取一条书签（含所属分类），供详情/编辑回填。
   * @param {number} uid - 账号 id
   * @param {number} id - 书签 id
   * @returns {?Object} 书签行（含 `tag_ids` / `tag_names`）；不归本人或不存在时为 null
   */
  getBookmark(uid, id) {
    const b = this._bk.getBookmark(Number(uid), id);
    if (!b) return null;
    const names = new Map(this.listTags(uid).map((t) => [t.id, t.name]));
    const ids = this._bk.listLinksForBookmark(Number(uid), id).map((l) => Number(l.tag_id));
    return Object.assign({}, b, { tag_ids: ids, tag_names: ids.map((i) => names.get(i)).filter(Boolean) });
  },

  /**
   * 功能：判断一条书签是否属于该账号。
   * @param {number} uid - 账号 id
   * @param {number} id - 书签 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsBookmark(uid, id) {
    return this._bk.ownsBookmark(Number(uid), id);
  },

  /**
   * 功能：一对一绑定校验 —— 「这个密码条目是不是已经被**别的**书签绑走了」。
   *
   * 任务七：「密码与网址收藏夹：目前仅允许**一对一**绑定，
   * 不能一对多、多对多」⇒ 一个密码条目最多被**一条**收藏绑。
   * 只挡**新的**写入：既有数据（老库里可能已经一对多）**一律不动**（铁律 18
   */
  assertVaultLinkFree(uid, vaultId, exceptId) {
    const taken = this._bk.findBookmarkByVault(Number(uid), Number(vaultId));
    if (taken && Number(taken.id) !== Number(exceptId)) {
      throw badRequest('这条密码已经绑了别的网址了 —— 一条密码只能绑一个网址，请到那条收藏上先解绑');
    }
  },

  /**
   * 功能：新建一条书签，并把 `tags`（分类名数组）挂上去。
   *
   * 说明：⭐ 同账号内 URL 重复时**明确报 400**，绝不静默覆盖 —— 用户可能只是想再加一次，
   * URL 的比对是**原样字符串比对**（不做归一化）：去尾斜杠、补 `https://` 这类
   *
   */
  createBookmark(uid, input) {
    this._assertWritable();
    const url = String(input.url || '');
    if (this._bk.findBookmarkByUrl(Number(uid), url)) {
      throw badRequest('这条网址已经收藏过了（同一条网址只收一次，请到列表里修改它）');
    }
    // 任务七：一对一 —— 新建时还没有「自己」，所以不排除任何书签。
    if (input.vault_entry_id != null) this.assertVaultLinkFree(uid, input.vault_entry_id, null);
    const row = {
      user_id: Number(uid),
      url,
      title: input.title || '',
      source: 'manual',
      pinned: input.pinned ? 1 : 0,
      sort_order: Number(input.sort_order) || 0,
      // 关联的密码库条目 id —— 没给 / 给了 `null` 都是「不关联」。
      // 只在**建的时候**写它；之后改关联走通用 `PUT`（那一列在 `allowedCols` 里）。
      vault_entry_id: input.vault_entry_id == null ? null : Number(input.vault_entry_id),
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    const created = this._insert('bookmarks', row);
    // 分类是**另一条资源**：先建书签再挂分类（挂失败不回滚书签 —— 用户至少没丢掉那条网址）
    if (Array.isArray(input.tags) && input.tags.length) {
      this.setBookmarkTags(uid, created.id, input.tags);
    }
    return created;
  },

  /**
   * 功能：更新一条书签（URL / 标题 / 分类）。
   *
   * 改成自己原来那条则放过（保存时不动网址的常见路径）。
   * `tags` **不是** `bookmarks` 表上的列，所以先摘出来单独处理 —— 直接混进
   * `_update` 会被 `allowedCols` 过滤掉，表现为「分类怎么都保存不上」。
   */
  updateBookmark(uid, id, input) {
    this._assertWritable();
    const src = Object.assign({}, input);
    const hasTags = Array.isArray(src.tags);
    const tags = src.tags;
    delete src.tags;
    delete src.tag_ids;
    delete src.tag_names;

    if (src.url !== undefined) {
      const url = String(src.url || '');
      const other = this._bk.findBookmarkByUrl(Number(uid), url);
      if (other && Number(other.id) !== Number(id)) {
        throw badRequest('这条网址已经收藏过了（同一条网址只收一次）');
      }
      src.url = url;
    }

    // 任务七：「密码与网址收藏夹**仅允许一对一绑定**」——
    // 要绑的那个密码条目若已经被**别的**收藏绑走了，这里直接 400。
    // 解绑那一趟（前端送空串 ⇒ `checkBookmark` 归一成 null）不会走到这儿 ✓
    if (src.vault_entry_id != null) this.assertVaultLinkFree(uid, src.vault_entry_id, id);

    // `_update` 在「没有可改列」时返回 false —— 只改分类（不改标题/网址）是一次正常操作，
    // 所以这里把「只改分类」与「真的改动了」分开记账。
    // `updated_at` 由 `_update` 自己总是刷新（见 methods/tasks.js 的 `_update`），这里不重复写。
    const fields = Object.keys(src).filter((k) => k !== 'id' && k !== 'user_id' && k !== 'updated_at');
    if (fields.length) {
      if (!this._update('bookmarks', uid, id, src)) return false; // 书签不归本人 → 交给路由层 404
    } else if (!this.ownsBookmark(uid, id)) {
      return false;
    }
    if (hasTags) this.setBookmarkTags(uid, id, tags);
    return true;
  },

  /**
   * 功能：删除一条书签；它名下的分类关联由数据库外键（或 JSON 后端的等价清理）一并消失。
   * @param {number} uid - 账号 id
   * @param {number} id - 书签 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  removeBookmark(uid, id) {
    this._assertWritable();
    return this._bk.deleteBookmark(Number(uid), id);
  },

  /**
   * 功能：把一条书签归入一批分类 —— **整体替换**语义（编辑保存时用）。
   *
   * 说明：⭐ 传进来的可以是**分类名**（可能是不存在的新名字 → 自动建出来，即「智能新建」）
   * 或**分类 id 数字**。两种混用也支持：名字先解析/创建，再与 id 一起去重。
   * 这样前端只用一个多选控件就能同时表达「选已有的」与「新建一个」。
   */
  setBookmarkTags(uid, bookmarkId, tags) {
    this._assertWritable();
    if (!this.ownsBookmark(uid, bookmarkId)) throw notFoundErr('书签');
    const ids = [];
    for (const item of Array.isArray(tags) ? tags : []) {
      if (typeof item === 'number' || /^\d+$/.test(String(item || ''))) {
        const id = Number(item);
        // 只接受**属于本人**的分类 id（别人的 id 一律忽略，不给探测反馈）
        if (this._bk.ownsTag(Number(uid), id)) ids.push(id);
        continue;
      }
      const t = this.ensureTag(uid, String(item));
      if (t) ids.push(t.id);
    }
    const uniq = [...new Set(ids)];
    this._bk.setBookmarkTags(Number(uid), bookmarkId, uniq);
    const names = new Map(this.listTags(uid).map((t) => [t.id, t.name]));
    return uniq.map((id) => ({ id, name: names.get(id) }));
  },

  /**
   * 功能：取一条书签已归入的分类 id（编辑弹窗回填勾选框用）。
   * @param {number} uid - 账号 id
   * @param {number} bookmarkId - 书签 id
   * @returns {Array.<number>} 分类 id 数组
   */
  tagIdsOfBookmark(uid, bookmarkId) {
    return this._bk.listLinksForBookmark(Number(uid), bookmarkId).map((l) => Number(l.tag_id));
  },

  // ---------------- 分类（= 标签） ----------------
  /**
   * 功能：判断一个分类是否属于该账号（路由层在「改名 / 删除」前用它统一回 404）。
   * @param {number} uid - 账号 id
   * @param {number} id - 分类 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsTag(uid, id) {
    return this._bk.ownsTag(Number(uid), id);
  },

  /**
   * 功能：列出该账号的全部分类（含每个分类下有几条书签）。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 分类行数组（含 `count`）
   */
  listTags(uid) {
    return this._bk.listTags(Number(uid));
  },

  /**
   * 功能：新建一个分类；同名（同账号内）已存在时**直接返回已有的那个**而不是报错。
   *
   * 说明：⭐ 「智能新建」：用户在书签表单里输入一个还没用过的分类名，就应该顺手建出来 ——
   * 让他「先去别的页面建分类、再回来选」是纯浪费。
   * 重名不报错也让重复提交（连点两次保存）天然幂等。
   */
  createTag(uid, name) {
    this._assertWritable();
    const n = String(name || '').trim();
    const existed = this._bk.findTagByName(Number(uid), n);
    if (existed) return existed;
    return this._insert('bookmark_tags', {
      user_id: Number(uid),
      name: n,
      sort_order: 0,
      created_at: nowStamp(),
    });
  },

  /**
   * 功能：按名字取分类，没有就建一个（书签表单里「输入一个新分类名」走它）。
   * @param {number} uid - 账号 id
   * @param {string} name - 分类名
   * @returns {Object} 分类行
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  ensureTag(uid, name) {
    return this.createTag(uid, name);
  },

  /**
   * 功能：把一个分类改名；改名不该撞上同账号内已有的另一个分类名（唯一索引兜底，这里先给人话）。
   * @param {number} uid - 账号 id
   * @param {number} id - 分类 id
   * @param {string} name - 新名字
   * @returns {boolean} 是否真的更新到了
   */
  renameTag(uid, id, name) {
    this._assertWritable();
    if (!this._bk.ownsTag(Number(uid), id)) throw notFoundErr('分类');
    const n = String(name || '').trim();
    // 分类名是 `bookmark_tags` 表上的列，renameTag 走它自己的方法；这里只走 `_update`
    // 的通用白名单（`bookmark_tags` 登记了 `name` / `sort_order`）。
    const other = this._bk.findTagByName(Number(uid), n);
    if (other && Number(other.id) !== Number(id)) throw badRequest(`已经有一个叫「${n}」的分类了`);
    return this._update('bookmark_tags', uid, id, { name: n });
  },

  /**
   * 功能：删除一个分类 —— **书签本身保留**，只是解除归类。
   *
   * 在确认框里说清楚（「书签不会被删掉」）。
   *
   * @param {number} uid - 账号 id
   */
  removeTag(uid, id) {
    this._assertWritable();
    return this._bk.deleteTag(Number(uid), id);
  },

  // ---------------- 归属校验（路由层复用） ----------------
  /**
   * 功能：校验书签归属：不属于 `uid`（或根本不存在）时抛 404。
   * @param {number} uid - 账号 id
   * @param {number} id - 书签 id
   * @returns {void}
   */
  _assertBookmarkOwned(uid, id) {
    if (!this.ownsBookmark(uid, id)) throw notFoundErr('书签');
  },

  /**
   * 功能：校验分类归属：不属于 `uid`（或根本不存在）时抛 404。
   * @param {number} uid - 账号 id
   * @param {number} id - 分类 id
   * @returns {void}
   * @throws {Error} 分类不归该账号所有时抛 404
   */
  _assertTagOwned(uid, id) {
    if (!this._bk.ownsTag(Number(uid), id)) throw notFoundErr('分类');
  },
};
