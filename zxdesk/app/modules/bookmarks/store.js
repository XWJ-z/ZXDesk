'use strict';
/**
 * modules/bookmarks/store.js —— 网址收藏夹业务方法（0.3.0）
 *
 * 功能：书签与分类的业务方法。书签侧：`listBookmarks`（检索 + 分类筛选）/ `get` / `create` /
 *      `update` / `remove` / `ownsBookmark`；分类侧：`listTags` / `createTag` /
 *      `renameTag` / `removeTag` / `tagIdsOfBookmark` / `setBookmarkTags`；另有供路由层
 *      复用的归属校验 `_assertBookmarkOwned` / `_assertTagOwned`。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⭐ **检索只在这里实现一份**（`splitTerms` + `matchBookmark`）：两个后端只提供
 *    「把该账号的书签全取回来」这一条原语，排序与匹配全在上层做 —— 这样
 *    「装的是 SQLite 还是 JSON 回退，搜索结果就不一样」这种漂移在结构上不可能发生
 *    （调研报告 §4.2 实测：1 万条内存检索 3 ms、5 万条 17 ms，速度不是瓶颈）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/bookmarks.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。方法体一个字没动，只改了相对路径。
 *
 * ⭐ 0.8.15：`listBookmarks` 的 `tagId` 认**字符串哨兵** `'none'`
 *    —— 只回「一个分类都没有」的书签，并在返回的 `tags` 末尾追加一项 `{ id:'none', name:'未分类', count }`
 *    （由服务端给，与真分类同形）。⚠️ 判 `'none'` **必须排在 `Number()` 之前**，否则会被吞成 NaN。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.19
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/开发方案/03-网址收藏夹-1期.md
 */
const { nowStamp, notFoundErr, badRequest, splitTerms } = require('../../core/store/helpers.js');

/**
 * 功能：判断一条书签是否命中全部关键词，并给出「标题命中」这一相关度信号。
 *
 * 说明：⭐ 检索面是 **标题 + 网址 + 分类名** 三处：
 *      · 标题命中优先于「只在网址里命中」—— 用户多半记得的是名字而不是网址；
 *      · 分类名也算命中，因为「搜『工具』」时用户的期待就是「我归到工具类下的那些网址」
 *        （只搜标题与网址会让这个再自然不过的用法一无所获）。
 *      判定与排序**分开**：`titleHit` 只用于排序，不影响是否命中。
 *
 * @param {Object} b - 书签行
 * @param {Array.<string>} terms - 已小写化的关键词
 * @param {string} [tagText] - 该条书签的分类名拼成的文本（已小写化）
 * @returns {?{ titleHit: boolean }} 命中返回相关度信号；有任一关键词未命中则返回 null
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
   *      `tags` 顺带把分类列表（含计数）也给了，前端不必再打一次 `/tags`。
   *      ⚠️ 分类列表里的计数是**该账号全部书签**的计数，不是本次筛选结果的计数
   *      （否则一筛选，其它分类的角标就会变成 0，看起来像数据没了）。
   *
   * @param {number} uid - 账号 id
   * @param {string} [q] - 关键词（空白分隔 = 多词 AND）；空则不按关键词过滤
   * @param {(number|string)} [tagId] - 分类 id（正整数）；⭐ `'none'` = **未分类**那一档（0.8.15）；
   *     不传（或非正整数）则不按分类过滤
   * @returns {{ items: Array.<Object>, total: number, tags: Array.<Object> }} 列表结果
   *     ⚠️⭐ 0.8.15：`tags` 末尾**多一项** `{ id: 'none', name: '未分类', count: N }`（由服务端给，
   *     /  / A-5 —— 让前端去合成就是第二份口径）。
   */
  listBookmarks(uid, q, tagId) {
    const terms = splitTerms(q);
    // ⚠️⭐ 0.8.15：「未分类」是一个**具名哨兵** `'none'`（不用 NULL / 0）——
    //    ⚠️ 它必须在 `Number()` **之前**判掉：`Number('none')` 是 `NaN`，而 `NaN` 在下面那句的
    //    语义是「不筛」⇒ 直接塞 `'none'` 会**静默退化成"列出全部"**（一个不会报错的错答案）。
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
      // ⭐ 「未分类」的判据是「这一条一条分类都没有」—— 从**全部**书签上数（不是筛完的 `out`）。
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
    // ⭐ 「未分类」那一项由**服务端**给，且**永远排在末尾**（既有客户端读 `tags[0]` 之类不受影响）。
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
   * ⭐⭐ 0.8.19 任务七：「密码与网址收藏夹：目前仅允许**一对一**绑定，
   *      不能一对多、多对多」⇒ 一个密码条目最多被**一条**收藏绑。
   *      ⚠️ 只挡**新的**写入：既有数据（老库里可能已经一对多）**一律不动**（铁律 18
   *      「启动与迁移绝不改写用户数据」）—— 所以判据是「**别的**书签」，同一条书签自己
   *      重复保存（改标题、改分类时顺手带上这一列）**不算冲突**，否则编辑一下就 400。
   *      ⚠️ `vaultId` 已由 `checkBookmark()` 归一过（解绑用的空串 / null 都变成 null）⇒
   *      调用方只需判 `!= null`。
   *
   * @param {number} uid - 账号 id
   * @param {number} vaultId - 想绑的密码条目 id
   * @param {?(number|string)} exceptId - 要排除的书签 id（编辑时传自己的 id；新建时传 null）
   * @returns {void}
   * @throws {Error} 已被别的收藏绑走时抛 400
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
   *      静默改成「更新了原来那条」会让人以为数据丢了。
   *      ⚠️ URL 的比对是**原样字符串比对**（不做归一化）：去尾斜杠、补 `https://` 这类
   *      「聪明」的归一化会让「我明明存了两个不同的地址，怎么就剩一个」变成无法解释的事。
   *
   * @param {number} uid - 账号 id
   * @param {Object} input - `{ url, title?, tags? }`，已由 `validate.checkBookmark` 归一化
   * @returns {Object} 新建的书签行（含 `id`）
   * @throws {Error} URL 已存在时抛 400；数据层只读时抛 503
   */
  createBookmark(uid, input) {
    this._assertWritable();
    const url = String(input.url || '');
    if (this._bk.findBookmarkByUrl(Number(uid), url)) {
      throw badRequest('这条网址已经收藏过了（同一条网址只收一次，请到列表里修改它）');
    }
    // ⭐ 0.8.19 任务七：一对一 —— 新建时还没有「自己」，所以不排除任何书签。
    if (input.vault_entry_id != null) this.assertVaultLinkFree(uid, input.vault_entry_id, null);
    const row = {
      user_id: Number(uid),
      url,
      title: input.title || '',
      source: 'manual',
      pinned: input.pinned ? 1 : 0,
      sort_order: Number(input.sort_order) || 0,
      // ⭐ 0.8.5：关联的密码库条目 id —— 没给 / 给了 `null` 都是「不关联」。
      //    ⚠️ 只在**建的时候**写它；之后改关联走通用 `PUT`（那一列在 `allowedCols` 里）。
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
   * 说明：⚠️ URL 改成**别人已有的那条**时同样报 400（否则唯一索引会直接抛，变成 500）；
   *      改成自己原来那条则放过（保存时不动网址的常见路径）。
   *      ⚠️ `tags` **不是** `bookmarks` 表上的列，所以先摘出来单独处理 —— 直接混进
   *      `_update` 会被 `allowedCols` 过滤掉，表现为「分类怎么都保存不上」。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 书签 id
   * @param {Object} input - `{ url?, title?, tags? }`
   * @returns {boolean} 是否真的更新到了（不归本人时为 false）
   * @throws {Error} URL 与他人重复时抛 400；数据层只读时抛 503
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

    // ⭐ 0.8.19 任务七：「密码与网址收藏夹**仅允许一对一绑定**」——
    //    要绑的那个密码条目若已经被**别的**收藏绑走了，这里直接 400。
    //    ⚠️ 解绑那一趟（前端送空串 ⇒ `checkBookmark` 归一成 null）不会走到这儿 ✓
    if (src.vault_entry_id != null) this.assertVaultLinkFree(uid, src.vault_entry_id, id);

    // ⚠️ `_update` 在「没有可改列」时返回 false —— 只改分类（不改标题/网址）是一次正常操作，
    //    所以这里把「只改分类」与「真的改动了」分开记账。
    //    `updated_at` 由 `_update` 自己总是刷新（见 methods/tasks.js 的 `_update`），这里不重复写。
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
   *      或**分类 id 数字**。两种混用也支持：名字先解析/创建，再与 id 一起去重。
   *      这样前端只用一个多选控件就能同时表达「选已有的」与「新建一个」。
   *
   * @param {number} uid - 账号 id
   * @param {number} bookmarkId - 书签 id
   * @param {Array.<(string|number)>} tags - 分类名或分类 id
   * @returns {Array.<Object>} 该分类的最终归属（`{ id, name }` 数组）
   * @throws {Error} 书签不归本人时抛 404；数据层只读时抛 503
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
   *      让他「先去别的页面建分类、再回来选」是纯浪费。
   *      重名不报错也让重复提交（连点两次保存）天然幂等。
   *
   * @param {number} uid - 账号 id
   * @param {string} name - 分类名（已由 `validate.checkTag` 归一化）
   * @returns {Object} 分类行（已存在时是原来那一行）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
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
   * @throws {Error} 重名时抛 400；数据层只读时抛 503
   */
  renameTag(uid, id, name) {
    this._assertWritable();
    if (!this._bk.ownsTag(Number(uid), id)) throw notFoundErr('分类');
    const n = String(name || '').trim();
    // ⚠️ 分类名是 `bookmark_tags` 表上的列，renameTag 走它自己的方法；这里只走 `_update`
    //    的通用白名单（`bookmark_tags` 登记了 `name` / `sort_order`）。
    const other = this._bk.findTagByName(Number(uid), n);
    if (other && Number(other.id) !== Number(id)) throw badRequest(`已经有一个叫「${n}」的分类了`);
    return this._update('bookmark_tags', uid, id, { name: n });
  },

  /**
   * 功能：删除一个分类 —— **书签本身保留**，只是解除归类。
   *
   * 说明：⚠️ 这一步会让匹配到该分类的书签「少一个分类标签」，所以前端必须把这件事
   *      在确认框里说清楚（「书签不会被删掉」）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 分类 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
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
   * @throws {Error} 书签不归该账号所有时抛 404
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
