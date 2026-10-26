/**
 * modules/vault/shared.js —— 密码库两端共用的**纯逻辑**（0.5.1 · 007 报告 D2「收成一份」）
 *
 * 功能：把密码库**两端逐字重复**的那几个纯函数收成一份 —— 它们此前在 `vault/desktop.js` 与
 *      `vault/mobile.js` 里各写一遍（007 实测 274 行 / 13 处重复）：`splitTerms`（切词）/
 *      `formatLeft`（剩余时间文案）/ `vaultFiltering`（筛选是否生效）/ `vaultVisibleItems`（按筛选过滤）/
 *      `vaultTagStats`（标签计数）。
 *
 * ⭐ **只收纯逻辑，渲染层一个都不动**（D2 的边界）：这些函数不碰 DOM、不 import 任何视图，
 *    读的只是 `state` 里**两端同名**的那几个字段（`vaultItems` / `vaultTag` / `vaultQuery`）——
 *    所以一律**显式传 `state`**（而不是各自去读自己那份单例），两端调用时各传各的。
 * ⚠️ 标签与标题都睡在**密文里**，服务端筛不了，所以筛选与搜索只能在前端做 —— 这也是为什么
 *    这几个函数必须两端一致：「同一个应用里『搜索』不该有两套手感」。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.18
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/审核报告/007-2026-09-14-0.5.0-自审.md（§6 D2）
 */

/**
 * 功能：自动锁定分钟数的**可选项**（**没有 0 / 没有「永不」** —— 自动锁定是这一屏唯一的安全网）。
 *
 * 说明：⭐⭐ 0.8.18（「自动锁定时间设置移动到全局设置中」）：
 *      这一份从两端各自的文件里**收进 `shared.js`** —— 它现在只有**一个**消费者
 *      （设置页那一栏的片段 `{desktop,mobile}-settings-pane.js`），
 *      而原先那两处（电脑端视图片段的工具条、手机端状态层）**都随着改版撤掉了**。
 *      ⚠️ 它必须与 `modules/vault/store.js` 的 `LOCK_MINUTES_MIN/MAX`、以及
 *      `validate.js` 的 `checkVaultLockMinutes` **同口径**（服务端不接受表外的值）。
 *
 * @type {Array.<number>}
 */
export const LOCK_CHOICES = [1, 5, 10, 30, 60];

/**
 * 功能：把搜索串按空白切词 —— 多词 AND 检索的第一步（口径与收藏夹的服务端检索一致）。
 *
 * 说明：⭐ 收藏夹那边切词在**服务端**（`core/store/helpers.js` 的 `splitTerms` —— 0.5.1 起服务端只有那一份），
 *      这边只能在**前端**：标签与标题都睡在密文里，服务端看不见，无从切起。
 *      两处语义刻意保持一致（小写化、空白分词、每个词都命中才算命中）——
 *      同一个应用里「搜索」不该有两套手感。
 *
 * @param {string} q - 原始查询串
 * @returns {Array.<string>} 小写化后的非空词数组（空查询 = 空数组 = 不过滤）
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
 *      ⚠️ 检索面刻意**只有标题 / 用户名 / 网址**三处：备注与密码都不在摘要里
 *      （列表接口压根不返回它们），所以它们搜不到 —— 这是「列表只拿摘要」那条取舍的
 *      直接后果，不是漏了。要按备注找，得先点进那条记录。
 *      ⚠️ 损坏的记录（解不开的那几条）没有标签，所以只在「全部 / 未分类」下出现；
 *      顶栏那句「有 N 条解不开」的告警**不受筛选影响**，照旧显示。
 *
 * @returns {Array.<Object>} 过滤后的摘要数组（顺序不变）
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
 * 说明：⭐⭐ 0.8.18 任务八：「同网址收藏夹绑定密码一样，在密码库也可以绑定网址，
 *      **可以取消绑定**，就是网址收藏夹要和密码库**互通**」。
 *      ⚠️⭐ 绑定关系的**唯一真相住在收藏夹那边**（`bookmarks.vault_entry_id`，0.8.5 就有）——
 *      密码库这边**只读**它，于是「在收藏夹绑了密码」与「在密码库绑了网址」天然是**同一件事**，
 *      不可能出现「两边各记一份、然后不一致」。⛔ 别在密码库的密文里再存一个 `bmId`
 *      （那会立刻制造出两个真相，且没有谁负责对账）。
 *      ⚠️ 一个密码条目**可以被多条收藏夹绑定**（一个账号有多个入口是常态）⇒ 值是数组。
 *      ⚠️ 收藏夹模块可以被整目录删掉（退化口径）⇒ 空数组 / 空对象都要能正常工作。
 *
 * @param {Array.<Object>} bookmarks - `/api/bookmarks` 返回的 `items`
 * @returns {Object.<string, Array.<{id: number, title: string, url: string}>>} 以**字符串 id** 为键
 */
export function buildVaultLinkMap(bookmarks) {
  /** @type {Object.<string, Array.<Object>>} */
  const map = {};
  for (const b of Array.isArray(bookmarks) ? bookmarks : []) {
    const vid = Number(b && b.vault_entry_id);
    // ⚠️ 先挡 null / '' 再转数字：`Number(null)` 与 `Number('')` 都是 0（本项目反复踩过的坑）
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
 *      而收藏夹那条是**他平时在维护的那份**（改网址是在收藏夹里改的）。
 *      两处都没有就回空串 —— 调用方据此**不画那颗「复制网址」按钮**（⛔ 别画一颗点了没反应的）。
 *
 * @param {Object} state - 本端的 state
 * @param {Object} it - 密码条目摘要（含 `id` / `url`）
 * @returns {string} 可复制的网址（可能是空串）
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
 * 说明：⚠️ 计数必须是「全部」的口径：否则一按标签筛，其它标签的角标全变成 0，
 *      看起来像数据没了（收藏夹那边踩过同一条）。未分类的计数另外给。
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
  // ⭐⭐ 0.8.18：**标签池**里那些「建过、但还没有任何记录用到」的标签也要出现在左栏（计数 0）。
  //    ⚠️ 漏了这一句的表现是：在「管理标签」里新建完，弹层一重画/一取数它就**凭空消失**
  //    （池子里的名字进不了这份统计 ⇒ 左栏与筛选都看不到它）。
  //    ⚠️ 计数仍是「只认真记录」：一个空标签永远是 0，⛔ 别为了让它显眼去 +1。
  for (const name of Array.isArray(state.vaultTagPool) ? state.vaultTagPool : []) {
    if (!map.has(name)) map.set(name, 0);
  }
  const tags = [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    // 多的排前面；同样多按名字排（中文用 localeCompare 才有稳定顺序）
    // ⚠️ 空标签（count 0）自然落在**最后** —— 它们是「建了还没用」的，不该挤在真在用的分类中间
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return { tags, untagged, total: items.length };
}
