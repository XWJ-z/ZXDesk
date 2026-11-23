/**
 * modules/vault/shared.js —— 密码库两端共用的**纯逻辑**
 *
 * 功能：把密码库**两端逐字重复**的那几个纯函数收成一份 —— 它们此前在 `vault/desktop.js` 与
 * `vault/mobile.js` 里各写一遍（007 实测 274 行 / 13 处重复）：`splitTerms`（切词）/
 * `formatLeft`（剩余时间文案）/ `vaultFiltering`（筛选是否生效）/ `vaultVisibleItems`（按筛选过滤）/
 * `vaultTagStats`（标签计数）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/审核报告/007-2026-09-14-0.5.0-自审.md（§6 D2）
 */
export const LOCK_CHOICES = [1, 5, 10, 30, 60];

/**
 * 功能：判断一个值是不是**「去空白后为空」** —— 密码「空不空」的唯一判据（前端）。
 *
 * ⇒ 只在密码框里敲一个空格也能提交，服务端那时也放行（两边同一条错）。
 * 现在服务端在 `core/store/helpers.js` 的 `isBlankPassword()` 里判、前端在这里判 ——
 * **两份实现、一条口径**（前端不能 import 后端那份：一个在 ESM、一个在 CJS，
 */
export function isBlankPassword(v) {
  return /^[\s\u200B\uFEFF]*$/.test(String(v == null ? '' : v));
}

/**
 * 功能：把搜索串按空白切词 —— 多词 AND 检索的第一步（口径与收藏夹的服务端检索一致）。
 *
 * 这边只能在**前端**：标签与标题都睡在密文里，服务端看不见，无从切起。
 * 两处语义刻意保持一致（小写化、空白分词、每个词都命中才算命中）——
 * 同一个应用里「搜索」不该有两套手感。
 */
export function splitTerms(q) {
  return String(q == null ? '' : q)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 功能：把剩余秒数写成「X 分 Y 秒」/「Y 秒」。
 * @param {number} s - 剩余秒数
 * @returns {string} 人类可读的剩余时间
 */
export function formatLeft(s) {
  const n = Math.max(0, Math.floor(Number(s) || 0));
  if (n < 60) return `${n} 秒`;
  const m = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

/**
 * 功能：当前筛选是否生效（决定空态该说「还没有记录」还是「没筛出来」）。
 * @returns {boolean} 有标签筛选或有搜索词时为 true
 */
export function vaultFiltering(state) {
  return !!state.vaultTag || !!String(state.vaultQuery || '').trim();
}

/**
 * 功能：按**当前筛选条件**过滤 `state.vaultItems`，返回要画进列表的那些条目。
 *
 * 说明：⭐ 两条筛选是**叠加**的（都满足才留下）：标签决定「哪一类」，关键词决定「哪一条」。
 * 检索面刻意**只有标题 / 用户名 / 网址**三处：备注与密码都不在摘要里
 * （列表接口压根不返回它们），所以它们搜不到 —— 这是「列表只拿摘要」那条取舍的
 */
export function vaultVisibleItems(state) {
  const items = state.vaultItems || [];
  const sel = state.vaultTag || null;
  const terms = splitTerms(state.vaultQuery);
  return items.filter((it) => {
    if (sel) {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      const hit = sel.kind === 'none' ? tags.length === 0 : tags.includes(sel.name);
      if (!hit) return false;
    }
    if (!terms.length) return true;
    const hay = `${it.title || ''}\n${it.username || ''}\n${it.url || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * 功能：把「网址收藏夹」的列表整理成 `密码库条目 id → 绑在它上面的收藏` 的映射。
 *
 * **可以取消绑定**，就是网址收藏夹要和密码库**互通**」。
 * 密码库这边**只读**它，于是「在收藏夹绑了密码」与「在密码库绑了网址」天然是**同一件事**，
 * 不可能出现「两边各记一份、然后不一致」。⛔ 别在密码库的密文里再存一个 `bmId`
 */
export function buildVaultLinkMap(bookmarks) {
  /** @type {Object.<string, Array.<Object>>} */
  const map = {};
  for (const b of Array.isArray(bookmarks) ? bookmarks : []) {
    const vid = Number(b && b.vault_entry_id);
    if (!Number.isInteger(vid) || vid <= 0) continue;
    const key = String(vid);
    if (!map[key]) map[key] = [];
    map[key].push({ id: Number(b.id), title: String(b.title || ''), url: String(b.url || '') });
  }
  return map;
}

/**
 * 功能：某个密码条目绑定的网址收藏（没有就是空数组）。
 * @param {Object} state - 本端的 state（读 `vaultBmLinks`）
 * @param {number|string} id - 密码条目 id
 * @returns {Array.<{id: number, title: string, url: string}>} 绑定的收藏夹条目
 */
export function vaultLinksOf(state, id) {
  return (state.vaultBmLinks || {})[String(id)] || [];
}

/**
 * 功能：一条密码记录的**有效网址** —— 绑定的收藏夹条目优先，没有绑定才用它自己填的那个。
 *
 * 说明：⚠️ 绑定优先是刻意的：用户既然把两条绑在一起，就说明它们指的是同一件事，
 * 而收藏夹那条是**他平时在维护的那份**（改网址是在收藏夹里改的）。
 * 两处都没有就回空串 —— 调用方据此**不画那颗「复制网址」按钮**（⛔ 别画一颗点了没反应的）。
 */
export function vaultEffUrl(state, it) {
  const links = vaultLinksOf(state, it && it.id);
  const first = links[0];
  if (first && first.url) return first.url;
  return String((it && it.url) || '');
}

/**
 * 功能：统计每个标签下有几条记录（**对全部条目统计，不受当前筛选影响**）。
 *
 *
 * @returns {{tags: Array.<{name: string, count: number}>, untagged: number, total: number}} 统计结果
 */
export function vaultTagStats(state) {
  const items = state.vaultItems || [];
  /** @type {Map.<string, number>} */
  const map = new Map();
  let untagged = 0;
  for (const it of items) {
    const tags = Array.isArray(it.tags) ? it.tags : [];
    if (!tags.length) untagged += 1;
    for (const t of tags) map.set(t, (map.get(t) || 0) + 1);
  }
  // **标签池**里那些「建过、但还没有任何记录用到」的标签也要出现在左栏（计数 0）。
  // 漏了这一句的表现是：在「管理标签」里新建完，弹层一重画/一取数它就**凭空消失**
  // （池子里的名字进不了这份统计 ⇒ 左栏与筛选都看不到它）。
  for (const name of Array.isArray(state.vaultTagPool) ? state.vaultTagPool : []) {
    if (!map.has(name)) map.set(name, 0);
  }
  const tags = [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    // 多的排前面；同样多按名字排（中文用 localeCompare 才有稳定顺序）
    // 空标签（count 0）自然落在**最后** —— 它们是「建了还没用」的，不该挤在真在用的分类中间
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return { tags, untagged, total: items.length };
}
