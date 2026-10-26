'use strict';

/**
 * modules/bookmarks/backend/json.js —— 网址收藏夹的表（书签 / 分类 / 分类关联）的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/json.js` 按段落**逐字节切出来**的，一个字都没重写
 *    （切块前后 sha256 见 0.5.0的提交说明）。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.19
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、docs/公共/开发方案/09-模块化重构.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 网址收藏夹（0.3.0）----
  /**
   * 功能：列出该账号的全部书签（倒序：最新添加的在最前）。
   * 说明：⭐ 检索与分类筛选**不在这一层做**（见 `modules/bookmarks/store.js`）—— 两个后端
   *      必须给出逐字一致的结果，语义只能有一份实现。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 书签行数组（按 created_at、id 倒序）
   */
  listBookmarks(uid) {
    return (this.data.bookmarks || [])
      .filter((b) => uidOf(b) === Number(uid))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id);
  },

  /**
   * 功能：按 id + 归属取一条书签；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 书签 id
   * @returns {?Object} 命中的书签行；未命中为 null
   */
  getBookmark(uid, id) {
    return (this.data.bookmarks || []).find((b) => b.id === Number(id) && uidOf(b) === Number(uid)) || null;
  },

  /**
   * 功能：判断某个书签是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 书签 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsBookmark(uid, id) {
    return (this.data.bookmarks || []).some((b) => b.id === Number(id) && uidOf(b) === Number(uid));
  },

  /**
   * 功能：按 URL 查该账号下是否已有同一条书签（新增时的重复提示用）。
   * @param {(number|string)} uid - 用户 id
   * @param {string} url - 目标网址（原样比对）
   * @returns {?Object} 命中的书签行；没有则为 null
   */
  findBookmarkByUrl(uid, url) {
    return (this.data.bookmarks || []).find((b) => b.url === url && uidOf(b) === Number(uid)) || null;
  },

  /**
   * 功能：找出「绑定了某个密码库条目」的那条书签 —— 0.8.19 一对一绑定校验用。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} vaultId - 密码库条目 id
   * @returns {?Object} 命中的书签行；没有则为 null
   */
  findBookmarkByVault(uid, vaultId) {
    const v = Number(vaultId);
    return (
      (this.data.bookmarks || []).find((b) => Number(b.vault_entry_id) === v && uidOf(b) === Number(uid)) ||
      null
    );
  },

  /**
   * 功能：删除一条书签，并连带清掉它的分类关联（对应 SQLite 的 ON DELETE CASCADE）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 书签 id
   * @returns {boolean} 书签行是否真的被删掉
   */
  deleteBookmark(uid, id) {
    const before = this.data.bookmarks.length;
    this.data.bookmarks = this.data.bookmarks.filter((b) => !(b.id === Number(id) && uidOf(b) === Number(uid)));
    if (this.data.bookmarks.length < before) {
      // ⚠️ JSON 后端没有外键，级联必须自己写 —— 漏了它就会在列表里留下指向已删书签的孤儿关联行
      this.data.bookmark_tag_links = (this.data.bookmark_tag_links || []).filter(
        (l) => !(l.bookmark_id === Number(id) && uidOf(l) === Number(uid)),
      );
    }
    this._saveJson();
    return this.data.bookmarks.length < before;
  },

  /**
   * 功能：列出该账号的全部分类，并带上**每个分类下有几条书签**。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 分类行数组（含 `count`，按 sort_order、id 升序）
   */
  listTags(uid) {
    const u = Number(uid);
    const links = this.data.bookmark_tag_links || [];
    return (this.data.bookmark_tags || [])
      .filter((t) => uidOf(t) === u)
      .map((t) => Object.assign({}, t, { count: links.filter((l) => l.tag_id === t.id && uidOf(l) === u).length }))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  },

  /**
   * 功能：按 id + 归属取一个分类；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分类 id
   * @returns {?Object} 命中的分类行；未命中为 null
   */
  getTag(uid, id) {
    return (this.data.bookmark_tags || []).find((t) => t.id === Number(id) && uidOf(t) === Number(uid)) || null;
  },

  /**
   * 功能：按名字取分类（「智能新建」查重用）。
   * @param {(number|string)} uid - 用户 id
   * @param {string} name - 分类名
   * @returns {?Object} 命中的分类行；没有则为 null
   */
  findTagByName(uid, name) {
    return (this.data.bookmark_tags || []).find((t) => t.name === name && uidOf(t) === Number(uid)) || null;
  },

  /**
   * 功能：判断某个分类是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分类 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsTag(uid, id) {
    return (this.data.bookmark_tags || []).some((t) => t.id === Number(id) && uidOf(t) === Number(uid));
  },

  /**
   * 功能：删除一个分类，并连带清掉它的关联行（对应 SQLite 的 ON DELETE CASCADE）；
   *      **书签本身保留**（只解除归类）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 分类 id
   * @returns {boolean} 分类行是否真的被删掉
   */
  deleteTag(uid, id) {
    const before = this.data.bookmark_tags.length;
    this.data.bookmark_tags = this.data.bookmark_tags.filter((t) => !(t.id === Number(id) && uidOf(t) === Number(uid)));
    if (this.data.bookmark_tags.length < before) {
      this.data.bookmark_tag_links = (this.data.bookmark_tag_links || []).filter(
        (l) => !(l.tag_id === Number(id) && uidOf(l) === Number(uid)),
      );
    }
    this._saveJson();
    return this.data.bookmark_tags.length < before;
  },

  /**
   * 功能：列出该账号的全部分类关联行（书签 ↔ 分类），供列表页一次性取回（避免 N+1）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 关联行数组
   */
  listBookmarkTags(uid) {
    return (this.data.bookmark_tag_links || []).filter((l) => uidOf(l) === Number(uid));
  },

  /**
   * 功能：列出某一条书签已归入的分类关联行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} bookmarkId - 书签 id
   * @returns {Array.<Object>} 关联行数组
   */
  listLinksForBookmark(uid, bookmarkId) {
    return (this.data.bookmark_tag_links || []).filter(
      (l) => l.bookmark_id === Number(bookmarkId) && uidOf(l) === Number(uid),
    );
  },

  /**
   * 功能：把一条书签归入一个分类；已存在的同一条关联不重复插入（对应 SQLite 的 INSERT OR IGNORE）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} bookmarkId - 书签 id
   * @param {(number|string)} tagId - 分类 id
   * @returns {boolean} 这次真的插入了新行则为 true
   */
  linkTag(uid, bookmarkId, tagId) {
    const u = Number(uid);
    const bid = Number(bookmarkId);
    const tid = Number(tagId);
    const rows = this.data.bookmark_tag_links || (this.data.bookmark_tag_links = []);
    if (rows.some((l) => l.bookmark_id === bid && l.tag_id === tid)) return false;
    rows.push({ id: this.data._seq++, user_id: u, bookmark_id: bid, tag_id: tid });
    this._saveJson();
    return true;
  },

  /**
   * 功能：解除一条书签与一个分类的归类关系。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} bookmarkId - 书签 id
   * @param {(number|string)} tagId - 分类 id
   * @returns {boolean} 真的删掉了关联行则为 true
   */
  unlinkTag(uid, bookmarkId, tagId) {
    const u = Number(uid);
    const before = (this.data.bookmark_tag_links || []).length;
    this.data.bookmark_tag_links = (this.data.bookmark_tag_links || []).filter(
      (l) => !(l.bookmark_id === Number(bookmarkId) && l.tag_id === Number(tagId) && uidOf(l) === u),
    );
    this._saveJson();
    return this.data.bookmark_tag_links.length < before;
  },

  /**
   * 功能：**整体替换**一条书签的分类归属（编辑保存时用）。
   * 说明：⚠️ 先把两次改动都做完再 `_saveJson()`（只写一次文件）—— JSON 后端没有事务，
   *      中途出错留下的半套关联无法回滚，所以把落盘压到最后一刻。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} bookmarkId - 书签 id
   * @param {Array.<number>} tagIds - 目标分类 id 列表
   * @returns {boolean} 恒为 true
   */
  setBookmarkTags(uid, bookmarkId, tagIds) {
    const u = Number(uid);
    const bid = Number(bookmarkId);
    const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number))].filter((n) => Number.isInteger(n));
    this.data.bookmark_tag_links = (this.data.bookmark_tag_links || []).filter(
      (l) => !(l.bookmark_id === bid && uidOf(l) === u),
    );
    ids.forEach((tid) => {
      this.data.bookmark_tag_links.push({ id: this.data._seq++, user_id: u, bookmark_id: bid, tag_id: tid });
    });
    this._saveJson();
    return true;
  },
  /**
   * 功能：把本模块三张表里属于该账号的行**整份取出来**（个人备份的导出片段用它，见 `../export.js`）。
   *
   * 说明：⚠️ 排序与深拷贝规则与搬家前 `store/backend/json.js` 的 `exportAll` 里那三行**逐字相同**
   *      （先 `JSON` 深拷贝再过滤排序，导出结果与内存里的数据完全脱钩）—— 备份内容因此不变。
   *
   * @param {number} uid - 用户 id
   * @returns {{bookmarks: Array.<Object>, bmTags: Array.<Object>, bmLinks: Array.<Object>}} 三张表的行
   */
  exportBookmarks(uid) {
    const d = this.data || {};
    /** 功能：深拷贝一个数组（借 JSON 序列化实现），入参为空时给空数组。 */
    const cp = (arr) => JSON.parse(JSON.stringify(arr || []));
    /** 功能：深拷贝后只保留属于该账号的行。 */
    const mine = (arr) => cp(arr).filter((r) => uidOf(r) === Number(uid));
    return {
      bookmarks: mine(d.bookmarks).sort(
        (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id,
      ),
      bmTags: mine(d.bookmark_tags).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
      bmLinks: mine(d.bookmark_tag_links).sort((a, b) => a.id - b.id),
    };
  },
};

module.exports = { ops };
