'use strict';

/**
 * modules/idea/backend/json.js —— 灵感库的**JSON 版原语**
 *
 * 功能：本模块自己的存储原语（JSON 回退），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * 说明：⭐ 检索与筛选**不在这一层做**（见 `modules/idea/store.js`）—— 两个后端必须给出
 *      逐字一致的结果，语义只能有一份实现。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用）。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.15
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { nowStamp, uidOf } = require('../../../core/store/helpers.js');

const ops = {
  // ---- 灵感库（0.7.1）----
  /**
   * 功能：列出该账号的全部灵感（新的在前）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 灵感行数组（按 created_at、id 倒序）
   */
  listIdeas(uid) {
    return (this.data.idea_items || [])
      .filter((r) => uidOf(r) === Number(uid))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id);
  },

  /**
   * 功能：按 id + 归属取一条灵感；不存在或不属于该账号都返回 null。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 灵感 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getIdea(uid, id) {
    return (this.data.idea_items || []).find((r) => r.id === Number(id) && uidOf(r) === Number(uid)) || null;
  },

  /**
   * 功能：判断某条灵感是否属于该账号。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 灵感 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsIdea(uid, id) {
    return (this.data.idea_items || []).some((r) => r.id === Number(id) && uidOf(r) === Number(uid));
  },

  /**
   * 功能：删除一条灵感；返回是否真的删掉了一行。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 灵感 id
   * @returns {boolean} 行是否真的被删掉
   */
  deleteIdea(uid, id) {
    const u = Number(uid);
    const before = (this.data.idea_items || []).length;
    this.data.idea_items = (this.data.idea_items || []).filter((r) => !(r.id === Number(id) && uidOf(r) === u));
    if (this.data.idea_items.length < before) {
      // ⚠️ JSON 后端没有外键，级联必须自己写 —— 漏了它就会在列表里留下指向已删随手记的孤儿关联行
      this.data.idea_tag_links = (this.data.idea_tag_links || []).filter(
        (l) => !(l.idea_id === Number(id) && uidOf(l) === u),
      );
    }
    this._saveJson();
    return this.data.idea_items.length < before;
  },

  // ---- 随手记的标签（0.8.15）：与 sqlite 版同名同参 ----
  /**
   * 功能：列出该账号的全部标签，并带上**每个标签下有几条随手记**（按 sort_order、id 升序）。
   * @param {(number|string)} uid - 用户 id
   * @returns {Array.<Object>} 标签行数组（含 `count`）
   */
  listIdeaTags(uid) {
    const u = Number(uid);
    const links = this.data.idea_tag_links || [];
    return (this.data.idea_tags || [])
      .filter((t) => uidOf(t) === u)
      .map((t) => Object.assign({}, t, { count: links.filter((l) => l.tag_id === t.id && uidOf(l) === u).length }))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  },

  /**
   * 功能：新建一个标签；同账号内同名**直接返回已有的那一行**（幂等）。
   * @param {(number|string)} uid - 用户 id
   * @param {string} name - 标签名
   * @returns {Object} 标签行
   */
  createIdeaTag(uid, name) {
    const u = Number(uid);
    const n = String(name);
    const rows = this.data.idea_tags || (this.data.idea_tags = []);
    const existed = rows.find((t) => t.name === n && uidOf(t) === u);
    if (existed) return existed;
    const row = { id: this.data._seq++, user_id: u, name: n, sort_order: 0, created_at: nowStamp() };
    rows.push(row);
    this._saveJson();
    return row;
  },

  /**
   * 功能：把一个标签改名（links 指向 id ⇒ 只改这一行就够）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 标签 id
   * @param {string} name - 新名字
   * @returns {boolean} 改到行则为 true
   */
  renameIdeaTag(uid, id, name) {
    const row = (this.data.idea_tags || []).find((t) => t.id === Number(id) && uidOf(t) === Number(uid));
    if (!row) return false;
    row.name = String(name);
    this._saveJson();
    return true;
  },

  /**
   * 功能：删除一个标签，并连带清掉它的关联行（对应 SQLite 的 ON DELETE CASCADE）——
   *      **随手记本身保留**（只解除归类）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} id - 标签 id
   * @returns {boolean} 标签行是否真的被删掉
   */
  removeIdeaTag(uid, id) {
    const u = Number(uid);
    const before = (this.data.idea_tags || []).length;
    this.data.idea_tags = (this.data.idea_tags || []).filter((t) => !(t.id === Number(id) && uidOf(t) === u));
    if (this.data.idea_tags.length < before) {
      this.data.idea_tag_links = (this.data.idea_tag_links || []).filter(
        (l) => !(l.tag_id === Number(id) && uidOf(l) === u),
      );
    }
    this._saveJson();
    return this.data.idea_tags.length < before;
  },

  /**
   * 功能：列出**某一条**随手记已归入的标签（`{ idea_id, tag_id, name }`，按关联 id 升序）。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} ideaId - 随手记 id
   * @returns {Array.<Object>} 标签行数组
   */
  tagsOfIdea(uid, ideaId) {
    return this.tagsOfIdeas(uid, [Number(ideaId)]);
  },

  /**
   * 功能：**一次取回**一批随手记各自的标签（避免 N+1）。
   * @param {(number|string)} uid - 用户 id
   * @param {Array.<(number|string)>} ideaIds - 随手记 id 数组
   * @returns {Array.<Object>} `{ idea_id, tag_id, name }` 数组（按关联 id 升序）
   */
  tagsOfIdeas(uid, ideaIds) {
    const u = Number(uid);
    const ids = new Set((Array.isArray(ideaIds) ? ideaIds : []).map(Number));
    const nameOf = new Map((this.data.idea_tags || []).map((t) => [t.id, t.name]));
    return (this.data.idea_tag_links || [])
      .filter((l) => uidOf(l) === u && ids.has(Number(l.idea_id)))
      .sort((a, b) => a.id - b.id)
      .map((l) => ({ idea_id: l.idea_id, tag_id: l.tag_id, name: nameOf.get(l.tag_id) }))
      .filter((x) => x.name !== undefined);
  },

  /**
   * 功能：**整体替换**一条随手记的标签归属（收到的是**标签名数组**，不存在就顺手建出来）。
   * 说明：⚠️ 先把两次改动都做完再 `_saveJson()`（只写一次文件）—— JSON 后端没有事务。
   * @param {(number|string)} uid - 用户 id
   * @param {(number|string)} ideaId - 随手记 id
   * @param {Array.<string>} names - 目标标签名数组
   * @returns {boolean} 恒为 true
   */
  setIdeaTags(uid, ideaId, names) {
    const u = Number(uid);
    const id = Number(ideaId);
    const list = [
      ...new Set((Array.isArray(names) ? names : []).map((x) => String(x == null ? '' : x).trim())),
    ].filter((x) => x);
    const tags = this.data.idea_tags || (this.data.idea_tags = []);
    this.data.idea_tag_links = (this.data.idea_tag_links || []).filter((l) => !(l.idea_id === id && uidOf(l) === u));
    list.forEach((n) => {
      let t = tags.find((x) => x.name === n && uidOf(x) === u);
      if (!t) {
        t = { id: this.data._seq++, user_id: u, name: n, sort_order: 0, created_at: nowStamp() };
        tags.push(t);
      }
      this.data.idea_tag_links.push({ id: this.data._seq++, user_id: u, idea_id: id, tag_id: t.id });
    });
    this._saveJson();
    return true;
  },

  /**
   * 功能：数出该账号**一条标签都没有**的随手记条数（列表的「未分类」那一档）。
   * @param {(number|string)} uid - 用户 id
   * @returns {number} 未归类条数
   */
  untaggedCount(uid) {
    const u = Number(uid);
    const tagged = new Set((this.data.idea_tag_links || []).filter((l) => uidOf(l) === u).map((l) => Number(l.idea_id)));
    return (this.data.idea_items || []).filter((r) => uidOf(r) === u && !tagged.has(Number(r.id))).length;
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据（含 0.8.15 新增的两张标签表）。
   * @param {(number|string)} uid - 用户 id
   * @returns {{idea: Array.<Object>, idea_tags: Array.<Object>, idea_tag_links: Array.<Object>}} 备份里那三个键
   */
  exportIdeas(uid) {
    const d = this.data || {};
    /** 功能：深拷贝一个数组（借 JSON 序列化实现），入参为空时给空数组。 */
    const cp = (arr) => JSON.parse(JSON.stringify(arr || []));
    /** 功能：深拷贝后只保留属于该账号的行。 */
    const mine = (arr) => cp(arr).filter((r) => uidOf(r) === Number(uid));
    return {
      idea: mine(d.idea_items).sort(
        (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id,
      ),
      idea_tags: mine(d.idea_tags).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
      idea_tag_links: mine(d.idea_tag_links).sort((a, b) => a.id - b.id),
    };
  },
};

module.exports = { ops };
