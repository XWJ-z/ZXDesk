'use strict';

/**
 * modules/bookmarks/backend/sqlite.js —— 网址收藏夹的表（书签 / 分类 / 分类关联）的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ 0.5.0 模块化重构（方案 `09-模块化重构` §四 第 2 行）：比对的粒度从「两个大文件」下移到**每个模块自己的一对**。
 *    ⚠️ **纯搬运**：方法体是从 `store/backend/sqlite.js` 按段落**逐字节切出来**的，一个字都没重写
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

const ops = {
  // ---- 网址收藏夹（0.3.0）----
  /**
   * 功能：列出该账号的全部书签（倒序：最新添加的在最前）。
   *
   * 说明：⭐ **检索与分类筛选刻意不在这一层做** —— 它们放在 `modules/bookmarks/store.js`，
   *      这样两个后端（SQLite / JSON）的检索语义**逐字一致**，不会出现
   *      「装的是哪个后端，搜索结果就不一样」这种最难查的漂移。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 书签行数组（按 created_at、id 倒序）
   */
  listBookmarks(uid) {
    return this._listSql('SELECT * FROM bookmarks WHERE user_id=? ORDER BY created_at DESC, id DESC', [uid]);
  },

  /**
   * 功能：按 id + 归属取一条书签；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 书签 id
   * @returns {?Object} 命中的书签行；未命中为 null
   */
  getBookmark(uid, id) {
    return this.db.prepare('SELECT * FROM bookmarks WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断某个书签是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 用户 id
   * @param {number} id - 书签 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsBookmark(uid, id) {
    return !!this.db.prepare('SELECT id FROM bookmarks WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：按 URL 查该账号下是否已有同一条书签（新增时的重复提示用）。
   * @param {number} uid - 用户 id
   * @param {string} url - 目标网址（**原样比对，不做归一化** —— 见 methods 层的说明）
   * @returns {?Object} 命中的书签行；没有则为 null
   */
  findBookmarkByUrl(uid, url) {
    return this.db.prepare('SELECT * FROM bookmarks WHERE user_id=? AND url=?').get(uid, url) || null;
  },

  /**
   * 功能：找出「绑定了某个密码库条目」的那条书签 —— 0.8.19 一对一绑定校验用。
   * @param {number} uid - 用户 id
   * @param {number} vaultId - 密码库条目 id
   * @returns {?Object} 命中的书签行；没有则为 null
   */
  findBookmarkByVault(uid, vaultId) {
    return (
      this.db
        .prepare('SELECT * FROM bookmarks WHERE user_id=? AND vault_entry_id=? LIMIT 1')
        .get(uid, Number(vaultId)) || null
    );
  },

  /**
   * 功能：删除一条书签；它名下的分类关联由外键 `ON DELETE CASCADE` 一并清掉。
   * @param {number} uid - 用户 id
   * @param {number} id - 书签 id
   * @returns {boolean} 删到行则为 true
   */
  deleteBookmark(uid, id) {
    const r = this.db.prepare('DELETE FROM bookmarks WHERE id=? AND user_id=?').run(id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：列出该账号的全部分类，并带上**每个分类下有几条书签**（列表筛选与设置页都要用）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 分类行数组（含 `count`，按 sort_order、id 升序）
   */
  listTags(uid) {
    return this._listSql(
      `SELECT t.id, t.user_id, t.name, t.sort_order, t.created_at,
              (SELECT COUNT(*) FROM bookmark_tag_links l
                WHERE l.tag_id = t.id AND l.user_id = t.user_id) AS count
         FROM bookmark_tags t
        WHERE t.user_id = ?
        ORDER BY t.sort_order ASC, t.id ASC`,
      [uid],
    );
  },

  /**
   * 功能：按 id + 归属取一个分类；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {?Object} 命中的分类行；未命中为 null
   */
  getTag(uid, id) {
    return this.db.prepare('SELECT * FROM bookmark_tags WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：按名字取分类（「智能新建」查重用：名字已存在就直接复用，不重复建）。
   * @param {number} uid - 用户 id
   * @param {string} name - 分类名
   * @returns {?Object} 命中的分类行；没有则为 null
   */
  findTagByName(uid, name) {
    return this.db.prepare('SELECT * FROM bookmark_tags WHERE user_id=? AND name=?').get(uid, name) || null;
  },

  /**
   * 功能：判断某个分类是否属于该账号。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsTag(uid, id) {
    return !!this.db.prepare('SELECT id FROM bookmark_tags WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：删除一个分类；它名下的关联行由外键一并清掉，**书签本身保留**。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {boolean} 删到行则为 true
   */
  deleteTag(uid, id) {
    const r = this.db.prepare('DELETE FROM bookmark_tags WHERE id=? AND user_id=?').run(id, uid);
    return r.changes > 0;
  },

  /**
   * 功能：列出该账号的全部分类关联行（书签 ↔ 分类），供列表页**一次性**取回。
   *
   * 说明：⭐ 这是刻意的「一次取全」而不是「逐条书签查一次」—— 逐条查就是 N+1，
   *      而 `node:sqlite` 全同步查询 + Node 单线程下，N+1 的代价会直接体现在首屏上。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 关联行数组（`{ id, user_id, bookmark_id, tag_id }`）
   */
  listBookmarkTags(uid) {
    return this._listSql('SELECT * FROM bookmark_tag_links WHERE user_id=? ORDER BY id ASC', [uid]);
  },

  /**
   * 功能：列出某一条书签已归入的分类 id（编辑弹窗回填勾选框用）。
   * @param {number} uid - 用户 id
   * @param {number} bookmarkId - 书签 id
   * @returns {Array.<Object>} 关联行数组
   */
  listLinksForBookmark(uid, bookmarkId) {
    return this._listSql('SELECT * FROM bookmark_tag_links WHERE user_id=? AND bookmark_id=? ORDER BY id ASC', [
      uid,
      bookmarkId,
    ]);
  },

  /**
   * 功能：把一条书签归入一个分类；已存在的同一条关联**不重复插入**（唯一索引兜底）。
   * @param {number} uid - 用户 id
   * @param {number} bookmarkId - 书签 id
   * @param {number} tagId - 分类 id
   * @returns {boolean} 这次真的插入了新行则为 true
   */
  linkTag(uid, bookmarkId, tagId) {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO bookmark_tag_links (user_id, bookmark_id, tag_id) VALUES (?,?,?)')
      .run(uid, bookmarkId, tagId);
    return r.changes > 0;
  },

  /**
   * 功能：解除一条书签与一个分类的归类关系。
   * @param {number} uid - 用户 id
   * @param {number} bookmarkId - 书签 id
   * @param {number} tagId - 分类 id
   * @returns {boolean} 真的删掉了关联行则为 true
   */
  unlinkTag(uid, bookmarkId, tagId) {
    const r = this.db
      .prepare('DELETE FROM bookmark_tag_links WHERE user_id=? AND bookmark_id=? AND tag_id=?')
      .run(uid, bookmarkId, tagId);
    return r.changes > 0;
  },

  /**
   * 功能：**整体替换**一条书签的分类归属（编辑保存时用）—— 先清掉旧关联，再按新列表插入。
   *
   * 说明：⭐ 必须在**一个事务**里：只删了一半或只插了一半，用户看到的就是
   *      「保存成功了，但分类少了一个」，而且没有任何报错。
   *
   * @param {number} uid - 用户 id
   * @param {number} bookmarkId - 书签 id
   * @param {Array.<number>} tagIds - 目标分类 id 列表（去重由调用方保证，这里再兜一道）
   * @returns {boolean} 恒为 true
   */
  setBookmarkTags(uid, bookmarkId, tagIds) {
    const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number))].filter((n) => Number.isInteger(n));
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO bookmark_tag_links (user_id, bookmark_id, tag_id) VALUES (?,?,?)',
    );
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM bookmark_tag_links WHERE user_id=? AND bookmark_id=?').run(uid, bookmarkId);
      ids.forEach((t) => ins.run(uid, bookmarkId, t));
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return true;
  },
  /**
   * 功能：把本模块三张表里属于该账号的行**整份取出来**（个人备份的导出片段用它，见 `../export.js`）。
   *
   * 说明：⚠️ 三条查询与搬家前 `store/backend/sqlite.js` 的 `exportAll` 里那三条**逐字相同**
   *      （连 `ORDER BY` 都一样）—— 搬家不改数据，所以备份里这三份与搬家前逐字节一致。
   *      ⚠️ **刻意不复用 `listTags`**：那个 op 多带回一个 `count` 列（界面上要显示分类下有几条），
   *      而备份要的是**表里的原样行** —— 多一个列，个人导入就会去写一个不存在的列。
   *
   * @param {number} uid - 用户 id
   * @returns {{bookmarks: Array.<Object>, bmTags: Array.<Object>, bmLinks: Array.<Object>}} 三张表的行
   */
  exportBookmarks(uid) {
    return {
      bookmarks: this.db.prepare('SELECT * FROM bookmarks WHERE user_id=? ORDER BY created_at DESC, id DESC').all(uid),
      bmTags: this.db.prepare('SELECT * FROM bookmark_tags WHERE user_id=? ORDER BY sort_order ASC, id ASC').all(uid),
      bmLinks: this.db.prepare('SELECT * FROM bookmark_tag_links WHERE user_id=? ORDER BY id ASC').all(uid),
    };
  },
};

module.exports = { ops };
