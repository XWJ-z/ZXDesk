'use strict';

/**
 * modules/idea/backend/sqlite.js —— 灵感库的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * 说明：⭐ **检索与筛选刻意不在这一层做** —— 它们放在 `modules/idea/store.js`，这样两个后端
 *      （SQLite / JSON）的筛选语义**逐字一致**，不会出现「装的是哪个后端、搜出来的就不一样」这种漂移
 *      （与收藏夹的检索、硬件的寿命推算同一条理由）。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this.data` / `this._saveJson()` / `this._listSql()`。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.15
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { nowStamp } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 灵感库（0.7.1）----
  /**
   * 功能：列出该账号的全部灵感（新的在前）。
   *
   * 说明：⚠️ **一次全取回来**（未归档与归档都在里面）—— 筛选、检索、分组全在业务层做。
   *      灵感是本模块唯一的数据，量级是「个人随手记」，一次取回比多开几个接口简单得多，
   *      而且两个后端的语义天然一致。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 灵感行数组（按 created_at、id 倒序）
   */
  listIdeas(uid) {
    return this._listSql('SELECT * FROM idea_items WHERE user_id=? ORDER BY created_at DESC, id DESC', [uid]);
  },

  /**
   * 功能：按 id + 归属取一条灵感；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 灵感 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getIdea(uid, id) {
    return this.db.prepare('SELECT * FROM idea_items WHERE id=? AND user_id=?').get(id, uid) || null;
  },

  /**
   * 功能：判断某条灵感是否属于该账号（越权与不存在都由上层统一按 404 处理）。
   * @param {number} uid - 用户 id
   * @param {number} id - 灵感 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsIdea(uid, id) {
    return !!this.db.prepare('SELECT id FROM idea_items WHERE id=? AND user_id=?').get(id, uid);
  },

  /**
   * 功能：删除一条灵感；返回是否真的删掉了一行。
   *
   * 说明：⚠️ 界面上**主推「归档」**（`archived_at`），删除是给「确实写错了」留的出口 ——
   *      本表没有子表，所以不像 `deleteProject` / `deleteTag` 那样要连带清理。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 灵感 id
   * @returns {boolean} 删到行则为 true
   */
  deleteIdea(uid, id) {
    return this.db.prepare('DELETE FROM idea_items WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  // ---- 随手记的标签（0.8.15）：照收藏夹那批原语逐字同构，只换表名 ----
  /**
   * 功能：列出该账号的全部标签，并带上**每个标签下有几条随手记**（列表筛选与设置页都要用）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 标签行数组（含 `count`，按 sort_order、id 升序）
   */
  listIdeaTags(uid) {
    return this._listSql(
      `SELECT t.id, t.user_id, t.name, t.sort_order, t.created_at,
              (SELECT COUNT(*) FROM idea_tag_links l
                WHERE l.tag_id = t.id AND l.user_id = t.user_id) AS count
         FROM idea_tags t
        WHERE t.user_id = ?
        ORDER BY t.sort_order ASC, t.id ASC`,
      [uid],
    );
  },

  /**
   * 功能：新建一个标签；同账号内同名**直接返回已有的那一行**（靠唯一索引去重，幂等）。
   * @param {number} uid - 用户 id
   * @param {string} name - 标签名（已由调用方 trim）
   * @returns {Object} 标签行（已存在时是原来那一行）
   */
  createIdeaTag(uid, name) {
    const u = Number(uid);
    const n = String(name);
    const existed = this.db.prepare('SELECT * FROM idea_tags WHERE user_id=? AND name=?').get(u, n);
    if (existed) return existed;
    this.db
      .prepare('INSERT OR IGNORE INTO idea_tags (user_id, name, sort_order, created_at) VALUES (?,?,?,?)')
      .run(u, n, 0, nowStamp());
    return this.db.prepare('SELECT * FROM idea_tags WHERE user_id=? AND name=?').get(u, n);
  },

  /**
   * 功能：把一个标签改名（links 指向 id、不指向名字 ⇒ **一次 UPDATE** 就够）。
   * @param {number} uid - 用户 id
   * @param {number} id - 标签 id
   * @param {string} name - 新名字
   * @returns {boolean} 改到行则为 true
   */
  renameIdeaTag(uid, id, name) {
    return this.db.prepare('UPDATE idea_tags SET name=? WHERE id=? AND user_id=?').run(String(name), id, uid).changes > 0;
  },

  /**
   * 功能：删除一个标签 —— **随手记一条都不删**，它名下的关联行由外键一并清掉。
   * @param {number} uid - 用户 id
   * @param {number} id - 标签 id
   * @returns {boolean} 删到行则为 true
   */
  removeIdeaTag(uid, id) {
    return this.db.prepare('DELETE FROM idea_tags WHERE id=? AND user_id=?').run(id, uid).changes > 0;
  },

  /**
   * 功能：列出**某一条**随手记已归入的标签（`{ idea_id, tag_id, name }`，按关联 id 升序）。
   * @param {number} uid - 用户 id
   * @param {number} ideaId - 随手记 id
   * @returns {Array.<Object>} 标签行数组
   */
  tagsOfIdea(uid, ideaId) {
    return this._listSql(
      `SELECT l.idea_id, l.tag_id, t.name
         FROM idea_tag_links l JOIN idea_tags t ON t.id = l.tag_id
        WHERE l.user_id = ? AND l.idea_id = ?
        ORDER BY l.id ASC`,
      [uid, ideaId],
    );
  },

  /**
   * 功能：**一次取回**一批随手记各自的标签（列表页用，⛔ 绝不逐条查 = N+1）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ideaIds - 随手记 id 数组
   * @returns {Array.<Object>} `{ idea_id, tag_id, name }` 数组（按关联 id 升序）
   */
  tagsOfIdeas(uid, ideaIds) {
    const ids = [...new Set((Array.isArray(ideaIds) ? ideaIds : []).map(Number))].filter((n) => Number.isInteger(n));
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return this._listSql(
      `SELECT l.idea_id, l.tag_id, t.name
         FROM idea_tag_links l JOIN idea_tags t ON t.id = l.tag_id
        WHERE l.user_id = ? AND l.idea_id IN (${ph})
        ORDER BY l.id ASC`,
      [uid, ...ids],
    );
  },

  /**
   * 功能：**整体替换**一条随手记的标签归属（新建 / 编辑保存时用）—— 收到的是**标签名数组**
   *      （不存在就顺手建出来，即「智能新建」）。
   *
   * 说明：⭐ 必须在**一个事务**里：只删了一半或只插了一半，用户看到的就是「保存成功了，
   *      但标签少了一个」，而且没有任何报错。
   *
   * @param {number} uid - 用户 id
   * @param {number} ideaId - 随手记 id
   * @param {Array.<string>} names - 目标标签名数组（去重由这里兜一道）
   * @returns {boolean} 恒为 true
   */
  setIdeaTags(uid, ideaId, names) {
    const u = Number(uid);
    const id = Number(ideaId);
    const list = [...new Set((Array.isArray(names) ? names : []).map((x) => String(x == null ? '' : x).trim()))].filter(
      (x) => x,
    );
    const findTag = this.db.prepare('SELECT id FROM idea_tags WHERE user_id=? AND name=?');
    const insTag = this.db.prepare('INSERT OR IGNORE INTO idea_tags (user_id, name, sort_order, created_at) VALUES (?,?,?,?)');
    const insLink = this.db.prepare('INSERT OR IGNORE INTO idea_tag_links (user_id, idea_id, tag_id) VALUES (?,?,?)');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM idea_tag_links WHERE user_id=? AND idea_id=?').run(u, id);
      for (const n of list) {
        let t = findTag.get(u, n);
        if (!t) {
          insTag.run(u, n, 0, nowStamp());
          t = findTag.get(u, n);
        }
        if (t) insLink.run(u, id, t.id);
      }
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
   * 功能：数出该账号**一条标签都没有**的随手记条数（列表的「未分类」那一档）。
   * @param {number} uid - 用户 id
   * @returns {number} 未归类条数
   */
  untaggedCount(uid) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM idea_items i
          WHERE i.user_id = ?
            AND NOT EXISTS (SELECT 1 FROM idea_tag_links l WHERE l.idea_id = i.id AND l.user_id = i.user_id)`,
      )
      .get(uid);
    return Number((r && r.c) || 0);
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（含 0.8.15 新增的两张标签表）。
   *
   * 说明：⭐ 灵感是用户自己写的内容（常含私人情绪与工作想法）⇒ **必须进个人备份**
   *      （报告 §三 3.1 末行）。走的是**本模块自己的原语**，所以删掉本模块目录时这一份自然消失，
   *      备份里不会剩下一个「指向不存在模块」的键。
   *      ⚠️ 三张表**各按自己表的原样行**导出（⛔ 不复用 `listIdeaTags` —— 它多带一个 `count` 列，
   *      个人导入会去写一个不存在的列，照收藏夹 `exportBookmarks` 那条说明）。
   *
   * @param {number} uid - 用户 id
   * @returns {{idea: Array.<Object>, idea_tags: Array.<Object>, idea_tag_links: Array.<Object>}} 备份里那三个键
   */
  exportIdeas(uid) {
    return {
      idea: this.db.prepare('SELECT * FROM idea_items WHERE user_id=? ORDER BY created_at DESC, id DESC').all(uid),
      idea_tags: this.db.prepare('SELECT * FROM idea_tags WHERE user_id=? ORDER BY sort_order ASC, id ASC').all(uid),
      idea_tag_links: this.db.prepare('SELECT * FROM idea_tag_links WHERE user_id=? ORDER BY id ASC').all(uid),
    };
  },
};

module.exports = { ops };
