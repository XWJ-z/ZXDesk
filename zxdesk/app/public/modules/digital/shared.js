/**
 * modules/digital/shared.js —— 数码管理两端共用的**纯逻辑**（0.5.1 · 007 报告 D3「收成一份」）
 *
 * 功能：把数码台账**两端逐字重复**的那几个纯函数收成一份 —— 它们此前在
 *      `digital/desktop.js` 与 `digital/mobile.js` 里各写一遍（007 实测 152 行 / 8 处重复）：
 *      `fmtMoney`（千位分隔）/ `hwCountText`（页头「几件 · 合计多少钱」文案）/ `hwCopySrc`（复制成「再记一件」）。
 *
 * ⭐ **只收纯逻辑，渲染层一个都不动**（D3 的边界）：三个函数都不碰 DOM，读的只是 `state` 里
 *    **两端同名**的那几个字段（`hwSummary` / `hwStatus` / `hwCategory` / `hwFocusAlert` / `hwQuery` / `hwItems`）——
 *    所以一律**显式传 `state`**，两端调用时各传各的。
 * ⚠️ **金额口径两端必须逐字一致**（写进文案里的「在用合计 / 想买目标价合计 / 已退役合计」）——
 *    这正是「这份重复是需求逼出来的、正确解法是收成一份」的典型（方案 §D3）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.10
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/审核报告/007-2026-09-14-0.5.0-自审.md（§6 D3）
 */

/** `hwCopySrc` 要清掉的列：同款硬件之间**必然不同**的那几个（序列号 / 购买日 / 保修到期日） */
const HW_COPY_CLEAR = ['serial', 'purchase_date', 'warranty_until'];

/**
 * 功能：金额加千位分隔 —— 「12345」写成「12,345」。
 *
 * 说明：⚠️ **不用 `toLocaleString()`**：它的输出随浏览器语言环境变（同一个包在两台机器上
 *      可能显示成 `12.345`），而这是写进界面文案的数字。自己按三位一组插逗号是确定的。
 *
 * @param {number} n - 金额（整数元）
 * @returns {string} 加了千位分隔的字符串
 */
export function fmtMoney(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 功能：拼出页头那句「几条记录 + 合计多少钱」。
 *
 * 说明：⭐ 金额口径**写在文字里**（「在用合计」/「想买目标价合计」/「已退役合计」）——
 *      同一个位置换口径而不写清，用户会以为「买了 8000 块的东西，怎么只显示 200」。
 *      ⚠️ 合计按每条填的**价格原样相加，不乘数量**（界面的 `title` 上写着这句话，改一处要改两处）。
 *      ⚠️ 没有任何金额时**整段不出现**（与「没填保修就不印」同一条规矩：不印零信息量的字）。
 *
 * @returns {string} 形如 `3 / 8 件 · 在用合计 12,345 元`；一件都没有时是「暂无记录」
 */
export function hwCountText(state) {
  const s = state.hwSummary;
  if (!s || !s.total) return '暂无记录';
  const filtering = !!(state.hwStatus || state.hwCategory || state.hwFocusAlert || (state.hwQuery || '').trim());
  const parts = [filtering ? `${(state.hwItems || []).length} / ${s.total} 件` : `${s.total} 件`];
  const [label, value] =
    state.hwStatus === 'wishlist'
      ? ['想买目标价合计', s.wishValue]
      : state.hwStatus === 'retired'
        ? ['已退役合计', s.retiredValue]
        : ['在用合计', s.ownedValue];
  if (Number(value) > 0) parts.push(`${label} ${fmtMoney(value)} 元`);
  return parts.join(' · ');
}

/**
 * 功能：把一条记录复制成「再记一件」的预填数据 —— 清掉序列号与三个日期。
 *
 * 说明：⚠️ 清的是**必然不同**的那几个（同款硬件的序列号、购买日、保修到期日绝不会一样）；
 *      价格 / 品牌 / 型号 / 用途 / 位置 / 预期寿命照抄 —— 那正是「一样的」那部分，
 *      重新手打一遍就是「新增交互不友好」的原话。
 *
 * @param {Object} h - 来源行
 * @returns {Object} 预填数据
 */
export function hwCopySrc(h) {
  const o = Object.assign({}, h);
  HW_COPY_CLEAR.forEach((k) => {
    o[k] = '';
  });
  return o;
}
