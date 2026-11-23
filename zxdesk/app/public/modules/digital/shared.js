/**
 * modules/digital/shared.js —— 数码管理两端共用的**纯逻辑**
 *
 * 功能：把数码台账**两端逐字重复**的那几个纯函数收成一份 —— 它们此前在
 * `digital/desktop.js` 与 `digital/mobile.js` 里各写一遍（007 实测 152 行 / 8 处重复）：
 * `fmtMoney`（千位分隔）/ `hwCountText`（页头「几件 · 合计多少钱」文案）/ `hwCopySrc`（复制成「再记一件」）。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/审核报告/007-2026-09-14-0.5.0-自审.md（§6 D3）
 */
const HW_COPY_CLEAR = ['serial', 'purchase_date', 'warranty_until'];

/**
 * 功能：金额加千位分隔 —— 「12345」写成「12,345」。
 *
 * 说明：⚠️ **不用 `toLocaleString()`**：它的输出随浏览器语言环境变（同一个包在两台机器上
 * 可能显示成 `12.345`），而这是写进界面文案的数字。自己按三位一组插逗号是确定的。
 *
 */
export function fmtMoney(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 功能：拼出页头那句「几条记录 + 合计多少钱」。
 *
 * 说明：⭐ 金额口径**写在文字里**（「在用合计」/「想买目标价合计」/「已退役合计」）——
 * 同一个位置换口径而不写清，用户会以为「买了 8000 块的东西，怎么只显示 200」。
 * 合计按每条填的**价格原样相加，不乘数量**（界面的 `title` 上写着这句话，改一处要改两处）。
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
 * 重新手打一遍就是「新增交互不友好」的原话。
 *
 */
export function hwCopySrc(h) {
  const o = Object.assign({}, h);
  HW_COPY_CLEAR.forEach((k) => {
    o[k] = '';
  });
  return o;
}
