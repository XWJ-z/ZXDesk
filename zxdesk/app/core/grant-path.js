'use strict';

/**
 * core/grant-path.js —— 「目录授权」的两条纯函数：路径归一化 ＋ 授权树判定
 * 功能：`normPath()` 把一个路径折成可以直接比较的形状；`isGranted()` 判断某个路径是否落在
 * 飞牛已授权的目录树里（相等或子目录）。
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md §6.7、docs/公共/开发方案/2026-11-09-0.9.8-第11轮修改-回单.md
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
 * 飞牛的目录授权是**树级**的 —— 授权了 `/vol1/1000` 就等于授权了它下面的一切。
 * 以前这里用 `includes()` 做**逐字符相等**，于是「授权的是上层目录、选的是子目录」
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
