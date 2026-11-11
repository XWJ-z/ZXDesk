'use strict';

/**
 * core/grant-path.js —— 「目录授权」的两条纯函数：路径归一化 ＋ 授权树判定
 *
 * 功能：`normPath()` 把一个路径折成可以直接比较的形状；`isGranted()` 判断某个路径是否落在
 *      飞牛已授权的目录树里（相等或子目录）。
 *
 * ⭐⭐ 为什么单独一个文件（从 `modules/secrets/store.js` **原样搬出**，两处必须逐字同构）：
 *      「个人授权目录」成了**跨模块**的东西（设置页要按同一口径判状态、加密信息要按同一口径
 *      挑目录），而这两条判据如果各写一份，出现分歧时的表现是**最难查的一类缺陷**——
 *      界面上说「已授权」、真正读文件时被判「不在授权范围」，两句话都对、谁都没错。
 *      搬家**只动位置不动逻辑**：两份实现逐字相同，`secrets.test.js` 的既有断言原样通过。
 *
 * ⚠️ 本文件**零依赖**（不 require 任何东西）：它被 core 的路由 / 业务方法 / 加密信息模块共用，
 *    再加依赖就会把模块之间绕成一张网。
 *
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md §6.7、docs/公共/开发方案/2026-11-09-0.9.8-第11轮修改-回单.md
 */

/**
 * 功能：把一个路径**归一化**成可以直接比较的形状（去尾斜杠、折叠重复斜杠）。
 *
 * 说明：⭐⭐ 存在的唯一理由是「有时候行、有时候不行」那个缺陷（2026-11-08 真机反馈）：
 *      飞牛选择器回来的路径与授权列表里的路径可能差一个**尾斜杠**（`/vol1/1000/测试` 与
 *      `/vol1/1000/测试/`），逐字符比较就会时灵时不灵 —— 而这与「有没有授权」毫无关系。
 *      ⚠️ 只做**纯文本归一化**：⛔ 不解析 `..`、⛔ 不做 `realpath`（那要读盘，而且会改掉用户
 *      实际选中的路径）；`..` 那类东西交给下面的「授权树」判定自然挡掉。
 * @param {string} p - 原始路径
 * @returns {string} 归一化后的路径（空输入回空串）
 */
function normPath(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return '';
  return raw.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
}

/**
 * 功能：判断某个路径**是否落在已授权的目录树里**（相等，或是某个授权目录的子目录）。
 *
 * 说明：⭐⭐ 这是「有时候行、有时候不行」的另一半原因，也是本函数存在的理由：
 *      飞牛的目录授权是**树级**的 —— 授权了 `/vol1/1000` 就等于授权了它下面的一切。
 *      以前这里用 `includes()` 做**逐字符相等**，于是「授权的是上层目录、选的是子目录」
 *      一律被判成「没有授权」，用户只能再授权一次同一个地方。
 *      ⚠️ 判定只往**下**放，⛔ 绝不往上看：选上层目录（`/vol1`）不能被 `/vol1/1000` 顶过去，
 *      那是扩大权限面，不是归一化。
 *      ⚠️ 用归一化后的字符串做前缀比较，并且要求边界是 `/` —— 否则 `/vol1/10002`
 *      会被 `/vol1/1000` 误判成子目录。
 * @param {string} want - 要判定的路径
 * @param {Array.<string>} granted - 已授权的目录列表
 * @returns {boolean} 已授权（或在其子树里）为 true
 */
function isGranted(want, granted) {
  const w = normPath(want);
  if (!w) return false;
  for (const g of Array.isArray(granted) ? granted : []) {
    const base = normPath(g);
    if (!base) continue;
    if (w === base) return true;
    if (base !== '/' && w.startsWith(base + '/')) return true;
    // 根目录授权：`/` 是唯一一个「加斜杠会变成 //」的特例，单独认一次
    if (base === '/' && w.startsWith('/')) return true;
  }
  return false;
}

module.exports = { normPath, isGranted };
