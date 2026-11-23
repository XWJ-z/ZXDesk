/**
 * modules/ledger/calc.js —— 记账**两端共用**的展示口径
 *
 * 功能：`KIND_META`（九类账户的界面名 / 图标 / 色 / 表单首字段的 label）与
 * `fmtFen(fen, hidden)`（整数分 → `1,234.56` 这样的显示串；`hidden` 为真时糊成 `••••`）。
 * 追加：`BANKS`（十四家银行）＋ `CREDIT_PLATFORMS`（信用支付）＋
 * `brandOf()` / `optionsFor()` / `iconOf()` —— 给储蓄卡 / 信用卡那一栏做**输入辅助**
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

/**
 * 九类账户的**展示口径** —— 键必须与 `app/modules/ledger/lib/kinds.js` 的 `KINDS` 逐字同集合。
 * 「名称」—— 同一个输入框，九类各有一句更贴切的问题。
 */
/**
 */
export const VIEW_MAX = 3;
export const VIEW_NAME_MAX = 12;
export const TAG_MAX = 12;
/** 内置「按账户用途」最多几个字段（含「其它」）—— 与服务端 `lib/usages.js` 同值 */
export const USAGE_MAX = 12;

/**
 * 「收支」的两个取值 —— ⚠️ **只有这两个**（字段名 `ie`、取值就写中文）。
 *
 */
export const IE_EXPENSE = '支出';
/** 见 `IE_EXPENSE` —— 「收入」那一半 */
export const IE_INCOME = '收入';

export const KIND_META = {
  cash: {
    name: '现金',
    icon: '💵',
    color: '#10b981',
    nameLabel: '名称',
    hint: '',
  },
  savings: {
    name: '储蓄卡',
    icon: '🏦',
    color: '#3b82f6',
    nameLabel: '所在银行',
    hint: '',
  },
  // 信用卡是**负债侧**（它是「欠银行的钱」）
  credit: {
    name: '信用卡',
    icon: '💳',
    color: '#ef4444',
    nameLabel: '所在银行',
    hint: '各大银行的信用卡',
  },
  // 新增：**信用支付**独立成类—— 与 `credit` 同侧（都是欠钱）
  creditpay: {
    name: '信用支付',
    icon: '🛍️',
    color: '#6366f1',
    nameLabel: '平台',
    hint: '蚂蚁花呗 / 京东白条 / 微信分付 / 美团月付',
  },
  virtual: {
    name: '虚拟账户',
    icon: '📱',
    color: '#8b5cf6',
    nameLabel: '平台',
    hint: '支付宝 / 微信 / 云闪付 / 京东 / 美团 / 抖音',
  },
  invest: {
    name: '投资账户',
    icon: '📈',
    color: '#f59e0b',
    nameLabel: '账户名',
    hint: '股票 / 基金 / P2P',
  },
  debt: {
    name: '负债',
    icon: '🧾',
    color: '#f43f5e',
    nameLabel: '向谁借的',
    hint: '贷款 / 借入',
  },
  // 债权在**资产侧**（「应收 / 借出」是别人欠你）
  claim: {
    name: '债权',
    icon: '🤝',
    color: '#14b8a6',
    nameLabel: '借给谁',
    hint: '应收 / 借出',
  },
  custom: {
    name: '自定义资产',
    icon: '📦',
    color: '#64748b',
    nameLabel: '名称',
    hint: '装不进其它任何一类的',
  },
};

/**
 * 类目的**界面顺序** —— 与服务端 `KINDS` 逐字同序（现金 → 储蓄卡 → 信用卡 → 信用支付 →
 * @type {Array.<string>}
 */
export const KIND_ORDER = [
  'cash',
  'savings',
  'credit',
  'creditpay',
  'virtual',
  'invest',
  'debt',
  'claim',
  'custom',
];

/**
 * 功能：取某个类型的展示口径；认不出的类型给一份**中性兜底**（⛔ 不抛）。
 *
 * 说明：⚠️ 兜底是必要的：服务端下发的 `kind` 理论上必是九类之一，但老数据 / 手改过的库
 * 可能出现别的值，而**渲染路径上抛一下整屏就白**（本项目一贯口径：坏数据只许降级）。
 * 兜底里带着原样的 `kind` 当名字，用户至少看得出「这里有一行我没见过的类型」。
 */
export function metaOf(kind) {
  return (
    KIND_META[kind] || {
      name: String(kind || '其他'),
      icon: '❔',
      color: '#94a3b8',
      nameLabel: '名称',
      hint: '',
    }
  );
}

/**
 * 金额被「眼睛」藏起来时显示的那一串（要的「点一下把金额糊掉」）。
 *
 */
export const AMOUNT_MASK = '••••';

/**
 * 一万元 ＝ 多少分（`fmtAxisFen()` 折「万」的那个门槛）。
 * @type {number}
 */
const WAN_FEN = 1000000;

/**
 * 功能：按「这个账户的余额往哪边变」给一笔转账判方向，并给出对方账户的 id。
 *
 * 说明：⭐ 库里的真相只有 `from_id` / `to_id` 两个 id，**方向是看的人决定的** ——
 * 同一个 id 在两个账户的明细页里方向相反 ⇒ 这件事住这里（两端同一份，⛔ 各写一遍）。
 * 它**只看方向**，⛔ 不碰侧（资产 / 负债）：显示出来的符号是「钱往哪走」
 */
export function txOf(t, accountId) {
  const me = Number(accountId);
  const from = Number(t && t.from_id);
  const to = Number(t && t.to_id);
  // 兜底判「out」而不是抛：数据畸形时界面降级成一行正常的明细，
  return { dir: from === me ? 'out' : 'in', peerId: from === me ? to : from };
}

/**
 * 功能：一笔转账在**这个账户**的明细里该显示的金额串 —— 转出 `-`、转入 `+`（掩码时是圆点）。
 *
 * 说明：⚠️ 金额本身**恒为非负**（方向由 `from_id` / `to_id` 表达，见服务端 `schema.js`），
 * 符号是**显示层**按方向补的 —— 与 `fmtSide()` 那条「符号由类型决定」同一条纪律：
 * 用户永远不填负号，也就不可能填反。
 */
export function fmtTx(t, accountId, hidden) {
  if (hidden) return AMOUNT_MASK;
  const { dir } = txOf(t, accountId);
  return (dir === 'out' ? '-' : '+') + fmtFen(t && t.amount_fen);
}

/**
 * 功能：把 `YYYY-MM-DD` 截成月份键 `YYYY-MM`（形状不对回空串）。
 * @param {string} date - 服务端给的日期串
 * @returns {string} `YYYY-MM`，或空串
 */
export function monthOf(date) {
  const d = String(date == null ? '' : date);
  return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : '';
}

/**
 * @param {string} key - 月份键
 * @returns {string} 中文年月
 */
export function monthLabel(key) {
  const m = String(key || '');
  return /^\d{4}-\d{2}$/.test(m) ? `${m.slice(0, 4)}年${m.slice(5, 7)}月` : m;
}

/**
 * 功能：明细区那颗月份下拉该有哪些选项 —— 有记录的月份 ＋ **服务端今天所在的月份**，新的在前。
 *
 * 说明：⭐ 「今天那个月」**永远在选项里**（哪怕一条记录都没有）—— 那样一进来看到的是
 * 「这个月 + 暂无数据」，而不是一颗空下拉（参考图 1 就是这个状态）。
 * 月份来自**服务端给的日期串**：⛔ 前端不算本机日期。
 */
export function monthOptionsOf(transfers, today) {
  const set = new Set();
  const cur = monthOf(today);
  if (cur) set.add(cur);
  for (const t of Array.isArray(transfers) ? transfers : []) {
    const m = monthOf(t && t.date);
    if (m) set.add(m);
  }
  return [...set].sort().reverse();
}

/**
 * 功能：明细里**属于某个月**的那几条（月份键为空 ⇒ 全给）。
 * @param {Array.<Object>} transfers - 明细
 * @param {string} month - 月份键 `YYYY-MM`（空串 = 不筛）
 * @returns {Array.<Object>} 筛出来的行（顺序沿传入的顺序）
 */
export function txInMonth(transfers, month) {
  const m = String(month || '');
  const rows = Array.isArray(transfers) ? transfers : [];
  return m ? rows.filter((t) => monthOf(t && t.date) === m) : rows;
}

/**
 *
 * 说明：⭐ **显示层加千分位、输入框里不加**：记账户的数会到几十万，千分位是这个模块最便宜的
 */
export function fmtFen(fen, hidden, intOnly) {
  if (hidden) return AMOUNT_MASK;
  const n = Number(fen);
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  const abs = Math.abs(v);
  // ：**整元档** —— 只到元、
  // 四舍五入（`-17.97` ⇒ `-18`）。手机端那几张账单表格在 390 宽的屏上塞 6 列，
  // 小数那两位把每一格都撑到贴着边。
  if (intOnly) {
    const y0 = Math.floor((abs + 50) / 100);
    const head0 = String(y0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${v < 0 && y0 > 0 ? '-' : ''}${head0}`;
  }
  const yuan = Math.floor(abs / 100);
  const cent = abs % 100;
  // `\B(?=(\d{3})+(?!\d))` 是从右往左每三位插一个逗号的标准写法（⛔ 别自己按字符数循环）
  const head = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}${head}.${String(cent).padStart(2, '0')}`;
}

/**
 * 功能：把整数分写成**纵坐标刻度**那种短样子（`1.2万` / `3,500`）。
 *
 * 说明：⭐⭐ 为什么不能直接用 `fmtFen()`：走势图的纵轴只有窄窄一条（`padL` 那几十个单位），
 * `fmtFen()` 出来的 `123,456.78` 会横向溢出、把绘图区挤没。⚠️ 它与 `fmtFen()` 是
 * **两个不同的量**：一个是「这一笔多少钱」（分毫不差），一个是「这条刻度大概在哪」
 */
export function fmtAxisFen(fen, hidden) {
  if (hidden) return AMOUNT_MASK;
  const v = Number.isFinite(Number(fen)) ? Math.trunc(Number(fen)) : 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= WAN_FEN) {
    const n = abs / WAN_FEN;
    const s = n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
    return `${sign}${s}万`;
  }
  return sign + String(Math.round(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 功能：把**一个**刻度值按「精度档」写成短标签 —— `yTickLabels()` 在**第一档不够用**时的细档实现。
 *
 * 说明：⚠️ 一万及以上用「万」，`p` 就是**万后面留几位小数**（1 / 2 / 3）。
 * 一律**去掉无意义的尾 0**（`1.70` ⇒ `1.7`、`2.00` ⇒ `2`）；千分位只加在整数部分
 * （加在小数部分会错成 `17,2.5`）。
 */
function axisTickText(v, p) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs === 0) return '0';
  if (abs >= WAN_FEN) {
    const s = (abs / WAN_FEN).toFixed(p).replace(/0+$/, '').replace(/\.$/, '');
    return `${sign}${s}万`;
  }
  const yuan = abs / 100;
  const s = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const parts = s.split('.');
  const head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + (parts[1] ? `${head}.${parts[1]}` : head);
}

/**
 * 功能：把整条纵轴的**一组刻度值**写成一组**互不相同**的短标签（`fmtAxisFen()` 只能一个值一个值地写）。
 *
 * 说明：⭐⭐ 装机反馈：「这个怎么是一样的」—— 纵轴三个刻度全显示成 `1.7万`。
 * 根因＝刻度值取的是**真实数据的顶 / 中 / 底**（那是刻意的：最上面那个数要能跟图上的点对上），
 * 而 `fmtAxisFen()` 只保留「万」后面的 **1 位**小数 ⇒ 1.7 万附近相差几百块的三个值
 */
export function yTickLabels(vals, hidden) {
  const list = (Array.isArray(vals) ? vals : []).map((v) =>
    Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0,
  );
  if (hidden) return list.map(() => AMOUNT_MASK);
  // 第 0 档**逐字沿用** `fmtAxisFen()`（最粗、最短）—— 绝大多数图停在这一档，行为与从前一致；
  // 之后逐档加一位小数（档 `p` ⇒ 「万」后面 `p + 1` 位）。
  for (let p = 0; p <= 3; p += 1) {
    const out = list.map((v) => (p === 0 ? fmtAxisFen(v, false) : axisTickText(v, p + 1)));
    if (new Set(out).size === out.length) return out;
  }
  // 兜底：四档都不够（只有「刻度值本身相等」才会走到这里）⇒ 用最细那档，别死循环
  return list.map((v) => axisTickText(v, 3));
}

/**
 *
 * 说明：⭐ 与 `fmtFen()` 是**两个方向**：那是「给人看」，这是「给人改」。
 */
export function fenToInput(fen) {
  const v = Math.abs(Math.trunc(Number(fen) || 0));
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
}

/**
 *
 * 说明：⭐⭐ 用户永远只填非负数，符号**由类型决定**。理由：让用户填负号，等于让
 */
export function fmtSide(fen, side, hidden) {
  if (hidden) return AMOUNT_MASK;
  return (side === 'debt' ? '-' : '') + fmtFen(Math.abs(Number(fen) || 0));
}

/**
 * 功能：把**带符号的整数分**格式化成显示串 —— 正数显式带 `+`、负数带 `-`（记账 2 期）。
 *
 * 说明：⭐ 与 `fmtTx()`（转账那一套）是同一个形状，区别只在**符号从哪来**：
 * 转账看方向（`from_id` / `to_id`），记账看 `ie`（支出为负）——
 * 两处的符号都是**显示层**补的，用户永远不填负号（与 同一条纪律）。
 */
export function fmtSignedFen(fen, hidden) {
  if (hidden) return AMOUNT_MASK;
  const n = Number(fen);
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  return (v >= 0 ? '+' : '-') + fmtFen(Math.abs(v));
}

// ---------- 银行 / 信用支付平台：输入辅助 + 列表行徽章 ----------

/**
 * 银行 / 信用支付平台 —— ⭐ 只是**输入辅助**（选了就把名字填进 `name`；⛔ 不新增列）。
 *
 */
export const BANKS = [
  { key: 'icbc', name: '工商银行', color: '#c8102e', alias: ['工行', 'ICBC'], file: 'icbc.svg' },
  { key: 'abc', name: '农业银行', color: '#0f8a4a', alias: ['农行', 'ABC'], file: 'abc.svg' },
  { key: 'boc', name: '中国银行', color: '#b0212c', alias: ['中行', 'BOC'], file: 'boc.png' },
  { key: 'ccb', name: '建设银行', color: '#0b4ea2', alias: ['建行', 'CCB'], file: 'ccb.svg' },
  { key: 'bocom', name: '交通银行', color: '#0a3d91', alias: ['交行', 'BOCOM'], file: 'bocom.png' },
  { key: 'psbc', name: '邮政储蓄银行', color: '#00703c', alias: ['邮储', '邮储银行', 'PSBC'], file: 'psbc.png' },
  { key: 'cmb', name: '招商银行', color: '#c7000b', alias: ['招行', '招商', 'CMB'], file: 'cmb.svg' },
  { key: 'citic', name: '中信银行', color: '#c8102e', alias: ['中信', 'CITIC'], file: 'citic.png' },
  { key: 'spdb', name: '浦发银行', color: '#005bac', alias: ['浦发', 'SPDB'], file: 'spdb.svg' },
  { key: 'cmbc', name: '民生银行', color: '#0a5ca8', alias: ['民生', 'CMBC'], file: 'cmbc.svg' },
  { key: 'cib', name: '兴业银行', color: '#0b4ea2', alias: ['兴业', 'CIB'], file: 'cib.svg' },
  { key: 'ceb', name: '光大银行', color: '#7b2d8b', alias: ['光大', 'CEB'], file: 'ceb.svg' },
  { key: 'pab', name: '平安银行', color: '#e8500f', alias: ['平安', '平安银行', 'PAB'], file: 'pab.svg' },
  { key: 'cgb', name: '广发银行', color: '#c8102e', alias: ['广发', 'CGB'], file: 'cgb.svg' },
];

/**
 * 信用支付平台 —— ⭐ **现在只出现在「信用支付」这一类目的下拉里**。
 *
 */
export const CREDIT_PLATFORMS = [
  {
    key: 'huabei',
    name: '蚂蚁花呗',
    color: '#1677ff',
    alias: ['花呗', '支付宝花呗'],
    file: 'huabei.svg',
  },
  {
    key: 'baitiao',
    name: '京东白条',
    color: '#e1251b',
    alias: ['白条', '京东金融'],
    file: 'baitiao.svg',
  },
  {
    key: 'fenfu',
    name: '微信分付',
    color: '#0a9a52',
    alias: ['分付', '微信支付分'],
    file: 'fenfu.svg',
  },
  {
    key: 'yuefu',
    name: '美团月付',
    color: '#a86a00',
    // 的顺序找，写上去会把**虚拟账户的「美团」平台遮住**（实测：`brandOf('美团')` 返回了美团月付，
    // 图标就画成了月付的）。跨表重名由 `ttt/test/ledger.test.js` 的一条护栏钉着。
    alias: ['月付'],
    file: 'yuefu.svg',
  },
  // 「抖音月付」也归信用支付。
  // `BANKS → CREDIT_PLATFORMS → PAY_PLATFORMS` 的顺序找，写上去会把**虚拟账户的
  // 「抖音」平台遮住**（`PAY_PLATFORMS` 里就有一项叫抖音，同一个坑 在
  {
    key: 'douyin-yuefu',
    name: '抖音月付',
    color: '#161823',
    alias: ['抖音月付'],
    // 暂时**复用抖音那一份图标**（同一个品牌；月付没有独立成套的行标可用）。
    // 别写一个不存在的文件名 —— 图标不显示是**静默**的（不报错、不留痕）。
    file: 'douyin.svg',
  },
];

/**
 *
 * 说明：⭐⭐ 与 `BANKS` / `CREDIT_PLATFORMS` **完全同形**（都是「输入辅助」：选了就把名字填进
 */
export const PAY_PLATFORMS = [
  {
    key: 'alipay',
    name: '支付宝',
    color: '#1677ff',
    alias: ['支付宝', 'alipay', 'Alipay'],
    file: 'alipay.svg',
  },
  {
    key: 'wechat',
    name: '微信',
    color: '#07c160',
    alias: ['微信', '微信支付', 'wechat', 'WeChat'],
    file: 'wechat.svg',
  },
  {
    key: 'quickpass',
    name: '云闪付',
    color: '#d7262c',
    alias: ['云闪付', 'quickpass', 'QuickPass', '银联'],
    file: 'quickpass.svg',
  },
  { key: 'jd', name: '京东', color: '#e1251b', alias: ['京东', 'jd', 'JD'], file: 'jd.svg' },
  {
    key: 'meituan',
    name: '美团',
    color: '#ffc300',
    alias: ['美团', 'meituan', 'Meituan'],
    file: 'meituan.svg',
  },
  {
    key: 'douyin',
    name: '抖音',
    color: '#161823',
    alias: ['抖音', 'douyin', 'Douyin', 'TikTok'],
    file: 'douyin.svg',
  },
];

/**
 *
 * 说明：⚠️ 与 `BANKS` / `CREDIT_PLATFORMS` / `PAY_PLATFORMS` **同形但刻意没有 `file`**：
 */
export const CASH_ITEMS = [
  { key: 'change', name: '零钱', alias: ['零钱'] },
  { key: 'ecny', name: '数字人民币', alias: ['数字人民币', '数币', 'e-CNY'] },
  { key: 'cd', name: '银行存单', alias: ['银行存单', '存单', '定期存单'] },
];

/** 下拉里那一项「其它（自己输入）」的哨兵值 —— ⛔ 它**不是**一个银行名，⛔ 不许当 `name` 存进去 */
export const PICK_OTHER = '__other__';

/**
 * 功能：把这个账户名在当前类目的下拉里选中哪一项算出来（认不出 / 不在本类目的选项里 ⇒ `null`）。
 *
 * 说明：⚠️⭐ **必须按当前类目筛**：信用卡的「花呗」在**储蓄卡**的下拉里没有对应项，
 * 硬把 `<select>` 的 value 设成它会得到一个**空选中** ⇒ `captureForm()` 读回空
 * 选不中就当作「认不出」：下拉停在「其它」、文本框**原样装着**那个名字。
 */
function pickOf(kind, name) {
  const o = optionsFor(kind);
  if (!o) return null;
  const n = String(name == null ? '' : name).trim().toLowerCase();
  if (!n) return null;
  // 改成**在当前类目的选项里找**，而不是先问 `brandOf()`。
  // 原因：现金那三样（零钱 / 数字人民币 / 银行存单）**刻意不在** `brandOf()` 那三张表里
  // （它们不是品牌，认出来也没有图标可画）⇒ 若走 `brandOf()`，
  for (const g of o.groups) {
    for (const it of g.items || []) {
      if (String(it.name).trim().toLowerCase() === n) return it;
      if ((it.alias || []).some((a) => String(a).trim().toLowerCase() === n)) return it;
    }
  }
  return null;
}

/**
 * 功能：把账户名认成某个内置品牌（银行 / 信用支付平台 / 虚拟账户平台），认不出返回 `null`。
 *
 * 说明：⚠️ 匹配**整串相等**：先去掉首尾空白，再统一小写（别名里有 `ICBC` / `ccb` 这类英文，
 * 中文本身无所谓大小写）。⛔ **不做前缀 / 模糊匹配** —— 理由见上面 `BANKS` 的注。
 * 认不出是**正常情况**（用户手输「重庆银行」/「我的小金库」都认不出）⇒ 调用方回落类目图标，
 */
export function brandOf(name) {
  const q = String(name == null ? '' : name)
    .trim()
    .toLowerCase();
  if (!q) return null;
  for (const b of BANKS.concat(CREDIT_PLATFORMS, PAY_PLATFORMS)) {
    if (b.name.toLowerCase() === q) return b;
    for (const a of b.alias) if (a.toLowerCase() === q) return b;
  }
  return null;
}

/**
 * 功能：某个类目的「名字」那一格该给哪些可选项 —— 按**分组**给，供两端画 `<optgroup>`。
 *
 * 说明：⭐ 分组是**数据**、不是各端自己拼的；`label` 为空 ⇒ 两端都**不画** `<optgroup>` 标题。
 * `savings`  → 银行（`BANKS`）
 * `creditpay`→ 信用支付（`CREDIT_PLATFORMS`）
 */
export function optionsFor(kind) {
  if (kind === 'cash') return { groups: [{ label: '', items: CASH_ITEMS }] };
  if (kind === 'savings') return { groups: [{ label: '', items: BANKS }] };
  if (kind === 'credit') return { groups: [{ label: '', items: BANKS }] };
  if (kind === 'creditpay') return { groups: [{ label: '', items: CREDIT_PLATFORMS }] };
  if (kind === 'virtual') return { groups: [{ label: '', items: PAY_PLATFORMS }] };
  return null;
}

/**
 * 功能：「卡号后四位」那一格该不该出现 —— ⭐ **只有储蓄卡 / 信用卡**。
 *
 * 现在虚拟账户与信用支付也有下拉了，但它们**没有卡号** ⇒ 再共用一条判据就会
 * 在「支付宝」的账户表单里冒出一格「卡号后四位」。
 * **它必须住在这里**（不是两端各判一次）：两端各写一份必然漂移。
 */
export function needTailOf(kind) {
  return kind === 'savings' || kind === 'credit' || kind === 'creditpay' || kind === 'virtual';
}

/**
 * 有「分级 ＋ 三个限额」那几格的类型 —— ⭐ 只有**储蓄卡 / 信用卡**。
 *
 */
export const CARD_KINDS = ['savings', 'credit'];

/** 银行卡分级（下拉候选值）—— ⛔ 不让自由填：否则「1类」「一类」「I类」会散成三种 */
export const TIERS = ['Ⅰ', 'Ⅱ', 'Ⅲ'];

/**
 * 功能：这一类的账户要不要那几格「分级 ＋ 三个限额」。
 * @param {string} kind - 类型键
 * @returns {boolean} 要就 true（只有储蓄卡 / 信用卡）
 */
export function needLimitOf(kind) {
  return CARD_KINDS.includes(String(kind || ''));
}

/**
 * 功能：把一个账户的「分级 ＋ **已设的**限额」翻成详情页要显示的那几行（两端共用）。
 *
 * 说明：⭐⭐ 判据是 `!= null`，⛔ **不是** `!fen`：本模块用 `null` 表示「没设这个限额」、
 * 用 `0` 表示「设成 0」（两件事，见 `routes.js` 的清空分支）—— 拿真值判断会把
 * 「限额 0 元」这条**有效信息**静默吞掉。
 */
export function limitLinesOf(a) {
  const out = [];
  const tier = String((a && a.tier) || '');
  if (tier) out.push({ label: '分级', value: `${tier} 类` });
  for (const [label, fen] of [
    ['日限额', a && a.limit_day_fen],
    ['月限额', a && a.limit_month_fen],
    ['年限额', a && a.limit_year_fen],
  ]) {
    if (fen == null) continue;
    out.push({ label, value: fmtFen(fen) });
  }
  return out;
}

/**
 *
 * 说明：⭐ 同一列（`ledger_accounts.tail`）两种含义：
 */
export function tailLabelOf(kind) {
  return kind === 'savings' || kind === 'credit' ? '卡号后四位' : '手机号 / 账号后 4 位';
}

/**
 * 功能：把一个元素从 `from` 挪到 `to`，返回**新数组**（拖排序两端共用的那一步算术）。
 *
 * 说明：⭐⭐ 拖拽的落点计算两端各写一份必然漂移（`splice` 的边界、越界、同位置），
 * 所以算术住这里（与 `pickShapeOf()` 同一条理由）。
 * 任何非法输入（不是数组 / 越界 / 同一个位置）都**原样返回一份拷贝** ——
 */
export function moveItem(list, from, to) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return arr;
  if (a < 0 || a >= arr.length || b < 0 || b >= arr.length || a === b) return arr;
  const [it] = arr.splice(a, 1);
  arr.splice(b, 0, it);
  return arr;
}

/**
 * 功能：算「名称」这一格该长成什么样 —— 银行下拉还是纯文本框、下拉选哪一项、文本框露不露 / 放什么。
 *
 * 名字认得出是内置银行 / 平台 ⇒ 下拉选中它、文本框藏起来且**清空**；
 * 认不出（含"认得出来但不在本类目的下拉里"）⇒ 下拉选「其它」、文本框露出来并
 * **原样填进那个名字**（⛔ 绝不能把已有的名字弄丢）。
 */
export function pickShapeOf(kind, name) {
  // 别在这里再抄一份类目名单 —— 加了类目忘改这里，表现就是「那一格又变成空白」。
  // 它与「卡号后四位」**已经不是同一条判据**了（见 `needTailOf()`）。
  const needPick = optionsFor(kind) !== null;
  const b = pickOf(kind, name);
  const n = String(name == null ? '' : name).trim();
  const nameHidden = needPick && (!!b || n === '');
  return {
    needPick,
    // 没有下拉的那几类 ⇒ 选中值一律回「请选择」（⛔ 别留一个「其它」在那儿 ——
    // 将来谁把下拉露出来就会莫名其妙地选中「其它」）
    select: needPick ? (b ? b.name : n ? PICK_OTHER : '') : '',
    nameHidden,
    value: nameHidden ? '' : n,
  };
}

/**
 * 功能：把「内置用途的定义」与「服务端算出的组小计」拼成这一屏要画的组 —— ⭐ 含**空组**。
 *
 * 说明：⭐⭐ 内置「按账户用途」的 7 个字段是**字段**，不是「有账户才出现」
 * 「新建了一个用途却看不到它」，只能以为没建成。
 * 服务端只给**有账户的组**（`summarizeTags()` 的口径不变，那份是金额的真相）；
 */
export function usageGroupsOf(usages, groups) {
  const defs = Array.isArray(usages) ? usages : [];
  const rows = Array.isArray(groups) ? groups : [];
  const byKey = new Map(rows.map((g) => [String((g && g.tag) || ''), g]));
  const out = [];
  const seen = new Set();
  for (const u of defs) {
    const k = String((u && u.gkey) || '');
    if (!k) continue;
    seen.add(k);
    const g = byKey.get(k);
    out.push({
      // 带上**行 id**（`ledger_groups` 的那一行）—— 拖组顺序时 `reorder` 要的是它，
      // 而组名可以随时改、`gkey` 也不是数字 ⇒ 两个都不能当拖拽的凭据。
      id: Number((u && u.id) || 0),
      key: k,
      name: String((u && u.name) || ''),
      total_fen: g ? Number(g.total_fen) || 0 : 0,
      count: g ? Number(g.count) || 0 : 0,
      // ：这一组里**行画的先后**（服务端按 ledger_view_tags.sort_order 算好的账户 id）
      ids: g && Array.isArray(g.ids) ? g.ids.map(Number) : [],
    });
  }
  for (const g of rows) {
    const k = String((g && g.tag) || '');
    if (!k || seen.has(k)) continue;
    // 认不出的键（脏数据 / 刚删掉的用途）**没有行** ⇒ 给 0，两端渲染时不给它拖拽属性
    out.push({
      id: 0,
      key: k,
      name: k,
      total_fen: Number(g.total_fen) || 0,
      count: Number(g.count) || 0,
      ids: Array.isArray(g.ids) ? g.ids.map(Number) : [],
    });
  }
  return out;
}

/**
 * 功能：把 `moved`（**一组**元素的新顺序）填回 `base` 里那些元素各自原来的位置上。
 *
 * 说明：⭐⭐ 这是「组内拖动」的算术。拖动只改**同一个组里**那几行的先后，⛔ 不该动别的组 ——
 * 但服务端排账户用的是**一整列 `sort_order`**，所以提交时必须给一份完整的顺序。
 * 直接把「屏上看到的一串 id」提交是不对的：在「按账户用途」这种视图里，同组的账户
 */
export function spliceOrder(base, moved) {
  const all = Array.isArray(base) ? base.slice() : [];
  const sub = Array.isArray(moved) ? moved.slice() : [];
  if (!sub.length) return all;
  // 硬填会把整张顺序表搅乱（比「这次拖动没生效」严重得多）。
  const uniq = new Set(sub);
  if (uniq.size !== sub.length) return all;
  if (!sub.every((id) => all.includes(id))) return all;
  let k = 0;
  return all.map((id) => (uniq.has(id) ? sub[k++] : id));
}

/**
 * 功能：把**类目键**翻成 `ledger_groups` 里那一行的 **id**（拖「按账户类型」的组顺序要它）。
 *
 * 说明：⚠️ 拖拽的凭据**必须是行 id**：类目键（`cash` / `savings`）是代码常量、不落库，
 * 而重排接口收的是一串行 id。`overview.kindGroups` 就是为这件事下发的。
 * 认不出（种子还没跑 / 老库）⇒ 回 `0`，两端据此**不给**拖拽属性 ——
 */
export function groupIdOf(kindGroups, key) {
  const list = Array.isArray(kindGroups) ? kindGroups : [];
  const row = list.find((g) => String((g && g.gkey) || '') === String(key == null ? '' : key));
  return row ? Number(row.id) || 0 : 0;
}

/**
 * 功能：把「拖了一下」翻成 `POST /api/ledger/reorder` 的请求体。
 *
 * 说明：⭐⭐ 三处拖拽（账户 / 组 / 胶囊）**共这一份算术**（与 `moveItem()` 同一条理由：
 * 两端各写一份必然漂移，而且漂移的是「提交了哪些 id、什么顺序」这种**静默**的错）。
 * `acct`：⚠️ 只换**同一个组内**的先后，但要提交**完整**的账户顺序 ⇒ 用 `spliceOrder()`
 */
export function reorderPayload(kind, ids, from, to, accountBase, viewId) {
  const list = Array.isArray(ids) ? ids : [];
  const moved = moveItem(list, from, to);
  if (kind === 'acct') {
    // ：在「分类视图」里拖动 ⇒ 改的是**这套分类自己的**顺序（`ledger_view_tags.sort_order`）。
    // 不能落到账户表的 `sort_order`：那一列只在**同一个 kind 内部**起作用，而一个用途组里
    // （报的「支付宝拖不到第一个」就是这个形状：拖完只有微信跟它换了位）。
    if (Number(viewId)) return { what: 'tags', view: Number(viewId), ids: moved };
    return { what: 'accounts', ids: spliceOrder(accountBase, moved) };
  }
  if (kind === 'group') return { what: 'groups', ids: moved };
  if (kind === 'chip') return { what: 'views', ids: moved };
  return null;
}

/**
 * 功能：列表行该画哪个徽章 —— 认得出银行 / 平台就用**实色底 + 白色自绘标记**，
 *
 * 说明：⚠️ 两种图标**共用同一个 `.lg-ico` 底色块**，靠 `.lg-bank` 这个修饰类分开
 * （实色底 vs 浅底）—— ⛔ 不新增第二套图标结构。两端都要一眼分得开：
 * **实色 = 银行 / 平台**，**浅底 emoji = 类目**。
 */
export function iconOf(kind, name) {
  const b = brandOf(name);
  if (!b) {
    const m = metaOf(kind);
    return { badge: false, icon: m.icon, color: m.color };
  }
  // 银行与信用支付平台**现在都有图标文件**（`brands/<key>.(svg|png)`）⇒ 形态只剩两种：
  // 有文件 = 徽章；没有 = 回落类目 emoji。⛔ 内联 `svg` 那条分支已经没有了。
  // `file` 由调用方拼上本端的 `BRAND_DIR` 前缀（电脑版 `modules/…`、手机端 `../modules/…`）。
  return { badge: true, file: b.file, color: b.color };
}

//
// 这一段的纪律：**只做画图**（占比 / 条长 / 排序 / 按月取点 / 扇段角度）。
// 一个金额都不在这里加总 —— 合计 / 净值 / 组小计一律是服务端 `lib/money.js` 给的

/** 走势图横轴的 12 个刻度 —— ⚠️ 与 `monthLabel()`（转账明细用的 `2026-09`）⛔ 不是一回事 */
export const AXIS_MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/**
 * 横轴上**画得出字**的那 5 个位置（1月 / 3月 / 6月 / 9月 / 12月）。
 *
 */
export const AXIS_LABEL_AT = [0, 2, 5, 8, 11];

/**
 * 功能：占该侧合计的百分比（**画环 / 画条**用）。
 *
 * 说明：⭐ 与「组小计是代数和」不冲突 —— 这里算的是**长度**，所以一律取绝对值。
 * 合计为 0 ⇒ 回 `null`（⛔ 不是 `0`）：调用方据此**不画**那一块，
 *
 */
export function sharePct(fen, total) {
  const a = Math.abs(Number(fen) || 0);
  const t = Math.abs(Number(total) || 0);
  if (!t) return null;
  return (a / t) * 100;
}

/**
 * 功能：百分比 → 显示串（`41.6%`）；`null` ⇒ `—`。
 *
 * 说明：⚠️ 保留一位小数（参考图就是一位）；⚠️ `null` 走 `—` 而不是 `0.0%`
 * —— 「算不出来」与「真的是 0」在界面上必须是两件事。
 *
 */
export function fmtPct(p) {
  const n = Number(p);
  if (p == null || !Number.isFinite(n)) return '—';
  // 「非零但小于 0.05」⇒ 显示 `<0.1%`，⛔ 不显示 `0.0%`：
  // 一看截图才发现的矛盾 —— 排行榜上那几行写着 `0.0%`，可它们的条**是画出来的**
  // （有三像素的可见宽度）⇒ 文字说"零"、图上有东西，用户只能当成 bug。
  if (n > 0 && n < 0.05) return '<0.1%';
  return `${n.toFixed(1)}%`;
}

/**
 * 功能：排行榜的行序 —— 按 `|值|` 降序；**同值时**按（类型顺序 → 名字 → id）升序。
 *
 * 所以这里把 (类型顺序, 名字, id) 显式写全（它是**全序**：同名同类型同 id 的行不存在）。
 * 名字用**码位比较**（`<` / `>`），⛔ 不用 `localeCompare`：后者依赖 ICU 数据，
 * 换个环境就可能给出另一个次序，而"排行榜自己变来变去"会被当成随机 bug。
 */
export function rankRows(accounts, side, sides) {
  const list = Array.isArray(accounts) ? accounts : [];
  const m = sides instanceof Map ? sides : new Map();
  const rankOf = (k) => {
    const i = KIND_ORDER.indexOf(String(k || ''));
    return i < 0 ? KIND_ORDER.length : i;
  };
  return list
    .filter((a) => m.get(a && a.kind) === side)
    .slice()
    .sort((x, y) => {
      const d = Math.abs(Number(y.opening_fen) || 0) - Math.abs(Number(x.opening_fen) || 0);
      if (d !== 0) return d;
      const kd = rankOf(x.kind) - rankOf(y.kind);
      if (kd !== 0) return kd;
      const nx = String((x && x.name) || '');
      const ny = String((y && y.name) || '');
      if (nx !== ny) return nx < ny ? -1 : 1;
      return (Number(x && x.id) || 0) - (Number(y && y.id) || 0);
    });
}

/**
 * 功能：把该年的快照摊成 **12 个格**（每格 = 那个月**最后一条**快照的值，缺的月是 `null`）。
 *
 * 而"这个月没记过"与"这个月是 0 元"是两件事 —— 后者会把走势图拽到底。
 * 服务端已按 `date ASC` 下发 ⇒ **后来的覆盖前面的**，天然就是「当月最后一条」。
 * 一天的多个值同源（服务端同一次 `summarize()` 存的），⛔ 这里不重算。
 */
export function trendSeries(snapshots, side) {
  const rows = Array.isArray(snapshots) ? snapshots : [];
  const key = side === 'debt' ? 'debt_fen' : side === 'net' ? 'net_fen' : 'asset_fen';
  const slots = new Array(12).fill(null);
  for (const r of rows) {
    const m = Number(String((r && r.date) || '').slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const v = Number(r && r[key]);
    slots[m - 1] = Number.isFinite(v) ? Math.trunc(v) : 0;
  }
  return slots;
}

/**
 * 功能：把一串格算成**能直接画进 `<svg>` 的坐标** —— 折线段（可能在缺口处断开）、
 * 每个点、以及横轴上要写字的那些刻度。
 *
 * 才连线 ⇒ 缺口处线**断开**，所以回的是 `segs`（**段的数组**，不是一条折线）。
 * y 的取值范围＝现值极值 **±10% 余量**；全等（或只有一个点）时给它一个人造跨度，
 */
export function trendGeometry(values, box, axis) {
  const vs = Array.isArray(values) ? values : [];
  const n = vs.length;
  const b = box || {};
  const w = Number(b.w) || 320;
  const h = Number(b.h) || 140;
  const padL = Number(b.padL) || 8;
  const padR = Number(b.padR) || 8;
  const padT = Number(b.padT) || 12;
  const padB = Number(b.padB) || 24;

  const idx = [];
  for (let i = 0; i < n; i++) if (vs[i] != null) idx.push(i);
  if (!idx.length) return { empty: true, segs: [], dots: [], ticks: [], zeroY: null, yTicks: [] };

  const vals = idx.map((i) => Number(vs[i]) || 0);
  let lo = Math.min.apply(null, vals);
  let hi = Math.max.apply(null, vals);
  // 全等 / 只有一个点 ⇒ 造一个跨度，⛔ 别让 (hi - lo) 当分母
  const flat = hi === lo;
  if (flat) {
    const nudge = Math.max(Math.abs(hi) * 0.1, 100);
    lo -= nudge;
    hi += nudge;
  }
  const span = hi - lo;
  // ：纵轴那三个刻度的**值**取
  // 真实数据的顶 / 中 / 底（⛔ 不是下面加过 10% 余量的 `lo`/`hi`）—— 这样最上面那个数
  // 就是这一段的最大值，用户能直接跟图上的点对上。⚠️ 只有一个值（`flat`）时只给一条。
  const axisVals = flat ? [lo + (hi - lo) / 2] : [hi, (hi + lo) / 2, lo];
  lo -= span * 0.1;
  hi += span * 0.1;

  // 只有一个格时 `n - 1` 是 0 ⇒ 拿 1 兜底（整条线缩成一个点，仍然画得出来）
  const step = Math.max(n - 1, 1);
  const xOf = (i) => padL + (i * (w - padL - padR)) / step;
  const yOf = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  const segs = [];
  let cur = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const x = xOf(i);
    const y = yOf(Number(vs[i]) || 0);
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    const next = idx[k + 1];
    if (next == null || next !== i + 1) {
      // 缺口 / 到头了 ⇒ 这一段落盘（只有一个点的段也留着，它就是「一个孤点」）
      segs.push(cur.join(' '));
      cur = [];
    }
  }

  const lastIdx = idx[idx.length - 1];
  const dots = idx.map((i) => ({
    // 带上**原始下标** —— 调用方靠它回答「点的这个是第几个月」（从前只给 x/y，
    // `barChartHtml()` 只好拿 `x` 反推月份）。⚠️ 它与 `dots` 自己的下标**不是一回事**
    i,
    x: Number(xOf(i).toFixed(1)),
    y: Number(yOf(Number(vs[i]) || 0).toFixed(1)),
    open: i === lastIdx,
  }));

  // 纵轴刻度：值 ＋ 它落在画布上的 y（`yOf` 是**加过余量**的那套 ⇒ 位置与图上的点同源）。
  const yTicks = axisVals.map((v) => ({ v: Math.trunc(v), y: Number(yOf(v).toFixed(1)) }));

  const y0 = yOf(0);
  const zeroY = y0 >= padT && y0 <= h - padB ? Number(y0.toFixed(1)) : null;

  // 横轴刻度：给的是**百分比**（调用方直接 `left: x%` 摆）——
  // 这样「点位算在哪」只有这一份实现，⛔ 别让两端各自按点数再推一遍（必然对不上）。
  // 默认那套（12 个月）只在**点数恰为 12** 时才套用（见上面的说明）。
  const a = axis && typeof axis === 'object' ? axis : null;
  let labels = a && Array.isArray(a.labels) ? a.labels : null;
  let at = a && Array.isArray(a.at) ? a.at : null;
  if (!labels && n === 12) {
    labels = AXIS_MONTHS;
    at = AXIS_LABEL_AT;
  }
  const ticks = (labels && at ? at : [])
    .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
    .map((i) => ({ text: String(labels[i] == null ? '' : labels[i]), pct: (xOf(i) / w) * 100 }));

  return { empty: false, segs, dots, ticks, zeroY, yTicks };
}

/**
 * 功能：**按天**那套横轴刻度（`trendGeometry()` 的 `axis` 实参）—— `01` / `15` / `30` 三个位置。
 *
 * 说明：⭐ 3 期的月详情页折线原来在 `dayLineHtml()` 里**自己算**这三个刻度（`[1, round(dim/2), dim]`
 * 只标三个：一整月 30 个刻度全写会糊成一条灰带（与 12 个月那套只标 5 个同一条理由）。
 * `at` 是 **0 起**的下标（`trendGeometry()` 的口径），所以它是 `0 / 中位 / 末位`；
 */
export function dayAxisOf(dim) {
  const n = Number(dim) > 0 ? Math.trunc(Number(dim)) : 30;
  const labels = [];
  for (let i = 0; i < n; i += 1) labels.push(String(i + 1).padStart(2, '0'));
  const at = [];
  for (const v of [0, Math.round(n / 2) - 1, n - 1]) {
    if (v >= 0 && v < n && !at.includes(v)) at.push(v);
  }
  return { labels, at };
}

/**
 * 功能：**按天**那一串的值（`trendGeometry()` 的 `values` 实参）—— 一整月每天一格。
 *
 * 说明：⭐⭐ 这一格是 `null` 而不是 `0` 的地方（1 期那六条判据的第一条）：**这天没记过账**
 * 与「这天花了 0 元」是两件事 —— 给 `0` 会把折线拽到底，而且**不报错**。
 * 所以这里**只把真有数的天写进去**，其余留 `null` ⇒ 折线的缺口处**断开**。
 */
export function dayValuesOf(days, dim) {
  const n = Number(dim) > 0 ? Math.trunc(Number(dim)) : 30;
  const out = new Array(n).fill(null);
  for (const x of Array.isArray(days) ? days : []) {
    const d = Number(String((x && x.day) || '').slice(8, 10));
    if (d >= 1 && d <= n) out[d - 1] = Number(x && x.amount_fen) || 0;
  }
  return out;
}

/**
 * 功能：把「几项 + 各自的值」算成环形图的**扇段**（`stroke-dasharray` 那套要的三个数）。
 *
 * 不引任何图表库（铁律 5）、⛔ 不用 `path` 弧线（算弧长要三角函数，没必要）。
 * **值为 0 的项直接不画**（⛔ 别留一段 `stroke-dasharray="0 …"` 的空转）；
 * 含 0 的项仍然出现在**图例**里（那是文字，不是图形）。
 */
export function donutArcs(items, radius) {
  const list = Array.isArray(items) ? items : [];
  const r = Number(radius) || 0;
  const c = 2 * Math.PI * r;
  const total = list.reduce((s, x) => s + Math.abs(Number(x && x.fen) || 0), 0);
  if (!r || !total) return { r, c, arcs: [] };
  const arcs = [];
  let acc = 0;
  for (const it of list) {
    const v = Math.abs(Number((it && it.fen) || 0));
    if (!v) continue;
    const frac = v / total;
    arcs.push({
      key: String((it && it.key) || ''),
      name: String((it && it.name) || ''),
      color: String((it && it.color) || ''),
      pct: frac * 100,
      len: frac * c,
      // 第一段写**字面的 0**，⛔ 别留下 `-0`（`-acc * c` 在 acc=0 时就是 `-0`）——
      // 它会一路印成 `stroke-dashoffset="-0.00"`，测试里的严格比较也会当场红。
      offset: acc === 0 ? 0 : -acc * c,
    });
    acc += frac;
  }
  return { r, c, arcs };
}

/**
 * 功能：「资产 vs 负债」那条对比条的两段宽度（**净资产**那一屏用）。
 *
 * 两边都是 0 ⇒ 回 `null`（⛔ 不画两条 0% 的假条）；**一段为 0 是合法的**
 * （只有资产没有负债 ⇒ 负债那段宽度 0，那是真事实，照画）。
 *
 */
export function ratioPair(assetFen, debtFen) {
  const a = Math.abs(Number(assetFen) || 0);
  const d = Math.abs(Number(debtFen) || 0);
  const t = a + d;
  if (!t) return null;
  return { asset_pct: (a / t) * 100, debt_pct: (d / t) * 100 };
}

/**
 * 功能：资产负债率（`负债 ÷ 资产 × 100`）—— 净资产那一屏最后一行。
 *
 * 这是一个**比值**（两个事实的商），与「占该侧合计」同类；⛔ 它不是评价、不是评分
 * 。
 *
 */
export function debtRatioPct(assetFen, debtFen) {
  const a = Math.abs(Number(assetFen) || 0);
  const d = Math.abs(Number(debtFen) || 0);
  if (!a) return null;
  return (d / a) * 100;
}

// ============================================================================
// 记账 3 期：记账自己那套屏内导航的格子清单
// 这一份是**两端共用**的纯数据（双份判据必然漂移）—— 手机端与电脑端

/**
 * 功能：记账**屏内导航**的格子清单 —— `key`（状态值）与 `name`（文案）的**唯一出处**。
 *
 * 说明：⭐⭐ 最终口径（两次调整后）：
 * `明细 ｜ 账单 ｜ 预算 ｜ 资产 ｜ 设置`。
 * 撤掉「记账」那一格（原话：「撤销记账中导航栏里的记账，改为悬浮 + 标志进入记账，
 */
export const SEGS = [
  { key: 'detail', name: '明细' },
  { key: 'bill', name: '账单' },
  { key: 'budget', name: '预算' },
  { key: 'asset', name: '资产' },
  { key: 'set', name: '设置' },
];

/**
 * 功能：电脑端屏内顶部那**四段**（= `SEGS` 去掉 `set`）。
 * @type {Array.<{key: string, name: string}>}
 */
export const SEG_TABS = SEGS.filter((s) => s.key !== 'set');

/**
 * @type {Array.<string>}
 */
export const SEG_KEYS = SEGS.map((s) => s.key);

// ============================================================================
// 记账设置**二级菜单**（设置首页 → 子页，两端共用）
//
// 功能：设置这一格/这一弹窗原来是一条长滚动（收支账户 ＋ 收支分类 ＋ 导入三方数据
// 三栏叠在一起，分类树一长就要一直往下滑）⇒ 改成**首页三条目、点进子页**。

/**
 * 功能：记账设置**首页**的条目清单 —— `key`（状态值）/ `name`（条目名）/ `desc`（一行说明）的唯一出处。
 *
 * 说明：⚠️ `name` 同时是**子页的标题**（手机端自画「‹ 返回 ＋ 标题」那一条头、电脑端子页正文顶上那行），
 * 别名一处名、标题另一处名（那是最容易出的那种"同一个东西两个叫法"）。
 * `desc` 是**首页那一行的小字**：让用户不用点进去就知道里面有什么 ——
 */
export const SET_PAGES = [
  { key: 'acct', name: '收支账户', desc: '默认收入 / 支出账户，每个类别还能各设一个' },
  { key: 'cat', name: '收支分类', desc: '建一级 / 二级分类，改名字、归档' },
  { key: 'imp', name: '导入三方数据', desc: '鲨鱼记账导出的 CSV，只读、不进余额' },
  { key: 'exp', name: '导出数据', desc: '把流水 / 账户余额 / 导入数据导成 CSV，Excel 直接打开' },
];

/**
 * @type {Array.<string>}
 */
export const SET_PAGE_KEYS = SET_PAGES.map((p) => p.key);

/**
 * 功能：认一个值是不是合法的设置子页 —— ⭐ 判据只住这一处（两端都调它）。
 *
 * 说明：⚠️ 认不出一律回落**空串**（＝设置首页），⛔ 别回落第一个子页：
 * `<select>.value = 不存在的选项` 会静默变成空串那一档 —— 同一条纪律：
 * 判据要能**认出默认**，而不是假设值一定合法。
 */
export function setPageOf(v) {
  const k = String(v || '');
  return SET_PAGE_KEYS.includes(k) ? k : '';
}

// ============================================================================
// 收支分类的**全称**与**重名判据**（两端共用；服务端另有一份同口径的）
//
// 功能：：「①【新建】要有检测：类别名称要唯一不能重复，二级分类的全称
// 应该是 一级分类-二级分类 …… 也就是说二级分类本质是带上了一级分类的名称，所以判断重复

/**
 * 功能：一个收支分类的**全称** —— 一级就是它自己的名字；二级是「父名-本名」。
 *
 * 说明：⭐ 这就是「二级分类本质带上了上级的名字」：`餐饮` 下的 `早餐` 全称是 `餐饮-早餐`
 * ⇒ 它与 `聚会` 下的 `早餐`（全称 `聚会-早餐`）**不算重复**。
 * 父取不到（清单里没有那一行）时**退化成它自己的名字**，⛔ 不抛、也不拼一个空的 `-`：
 */
export function catFullName(cats, cat) {
  const c = cat && typeof cat === 'object' ? cat : {};
  const name = String(c.name == null ? '' : c.name);
  const pid = Number(c.parent_id) || 0;
  if (!pid) return name;
  const parent = (Array.isArray(cats) ? cats : []).find((x) => Number(x.id) === pid);
  return parent ? `${String(parent.name == null ? '' : parent.name)}-${name}` : name;
}

/**
 * 功能：判一个**全称**是不是已经被别的分类占了（新建 / 改名时的检测）。
 * @param {Array.<Object>} cats - 整份分类清单（**含已归档的**，见上面那段说明）
 * @param {string} full - 候选全称（`catFullName()` 的产物）
 * @returns {string} 撞上的那个全称（没撞＝空串）
 */
export function catNameTaken(cats, full, selfId) {
  const want = String(full == null ? '' : full).trim();
  if (!want) return '';
  const self = Number(selfId) || 0;
  const list = Array.isArray(cats) ? cats : [];
  const hit = list.find((c) => Number(c.id) !== self && catFullName(list, c) === want);
  return hit ? want : '';
}

// ============================================================================
// 记账 3 期：预算 / 账单那一套**两端共用**的纯口径
// 判据只住一份（项目）：期间起点、期间文案、卡片列名、百分比读法

/**
 * 功能：预算 / 账单那三档的**白名单**（`week` / `month` / `year`）。
 * @type {Array.<string>}
 */
export const PERIOD_TYPES = ['week', 'month', 'year'];

/**
 * 功能：三档各自的**期间起点**（＝服务端要的 `period_key`）—— ⭐ 该期起始日 `YYYY-MM-DD`。
 *
 * 说明：⭐⭐ 口径与 `modules/ledger/lib/budget.js` 的 `periodRange()` **逐字一致**（C-3）：
 * **周 = 周一**（自然周，周一 00:00 ~ 周日 24:00）、月 = 1 号、年 = 1 月 1 日。
 * **`today` 必须是服务端今天**（接口回给的那一份 `today`），
 */
export function periodKeyOf(periodType, today) {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? String(today) : '';
  if (!t) return '';
  if (periodType === 'year') return t.slice(0, 4) + '-01-01';
  if (periodType !== 'week') return t.slice(0, 7) + '-01';
  const d = new Date(`${t}T00:00:00`);
  // `getDay()`：0 = 周日 ⇒ 往前退 `(day + 6) % 7` 天就是本周一
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 功能：三档各自的「这一期叫什么」—— 周档「本周」、月档「本月」、年档「年度」。
 *
 * 说明：⭐ 在台账里点头（T48-③）：周档写「**本周**预算 / 本周支出」。
 * 年档刻意用「**年度**」而不是「本年」（图 6 的年档写的就是「年度预算 / 年度支出」）。
 *
 */
export function periodLabelOf(periodType) {
  if (periodType === 'week') return '本周';
  if (periodType === 'year') return '年度';
  return '本月';
}

/**
 * 功能：预算块右侧那两行的**标签**（`预算` / `支出` 前面随档变的那半句）。
 *
 * 说明：照参考图 4（月档 `本月预算` / `本月支出`）与图 6（年档 `年度预算` / `年度支出`）。
 * @param {string} periodType - `'week'` / `'month'` / `'year'`
 * @returns {{budget: string, used: string}} 如 `{ budget: '本月预算', used: '本月支出' }`
 */
export function budgetLineLabels(periodType) {
  const k = periodLabelOf(periodType);
  return { budget: k + '预算', used: k + '支出' };
}

/**
 * 功能：账单页顶部大卡那三个数的**标签**（随档变，T36）。
 *
 * `month` 档的大卡是「**所选「年」的全年**」⇒ 写「年收入 / 年支出 / 年结余」；
 * `year`  档的大卡是「**记账以来的全部**」⇒ 写「总收入 / 总支出 / 总结余」；
 * `week`  档的大卡是「**当前自然周**」⇒ 写「周收入 / 周支出 / 周结余」。
 */
export function billCardLabels(periodType) {
  if (periodType === 'week') return { balance: '周结余', income: '周收入', expense: '周支出' };
  if (periodType === 'year') return { balance: '总结余', income: '总收入', expense: '总支出' };
  return { balance: '年结余', income: '年收入', expense: '年支出' };
}

/**
 * 功能：账单表格的**表头**（6 列）—— 前四列随档变，后两列固定。
 *
 * 在「收入 / 支出 / 结余」之后各加一列。「预算」= 那一期的**总预算**（没设过画「—」）、
 * 「超支」= `max(0, 净支出 − 预算)`（设过且没超 ⇒ `0.00`；没设 / 还没到的期 ⇒ `—`）。
 * 后两列**不随档改名**：「周超支」「年超支」都不是人话，而「预算 / 超支」三档都读得通。
 */
export function billColLabels(periodType) {
  const tail = { budget: '预算', overspent: '超支' };
  if (periodType === 'week') {
    return Object.assign({ first: '周', income: '周收入', expense: '周支出', balance: '周结余' }, tail);
  }
  if (periodType === 'year') {
    return Object.assign({ first: '年份', income: '年收入', expense: '年支出', balance: '年结余' }, tail);
  }
  return Object.assign({ first: '月份', income: '月收入', expense: '月支出', balance: '月结余' }, tail);
}

/**
 * 功能：把**已经算好的一位小数**百分比写成显示串（`40.2` → `'40.2%'`）。
 *
 * 说明：⭐ 服务端的占比 / 条形占比**都已经是一位小数**（图 5 六项我核过）⇒ 这里只补一个 `%`。
 * @param {?number} n - 一位小数的百分数
 * @returns {string} 如 `'40.2%'` / `'—'`
 */
export function pct1(n) {
  // 必须先挡 `null` / `undefined` / 空串：`Number(null) === 0` 是**有限数**，
  // 漏了这一句就会把「取不到占比」画成 `0%`（一个看着正常的假数 —— 最难查的一种）。
  if (n == null || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? `${v}%` : '—';
}

/**
 * 功能：预算块那个**环形里写什么** —— 正常态 `剩余 52%`、超支态 `已超支`、没设 `未设`。
 *
 * （超了多少由 `remain_fen` 的负数表达，见 `budgetBlockText()`）。
 * `remain_pct` 为 `null` 只在「额度 = 0」（⛔ 不除零）时出现 ⇒ 那时也不该显示百分比。
 * @param {?{remain_pct: ?number, overspent: boolean}} block - 服务端给的那一块（总预算 / 分类预算）
 */
export function ringText(block) {
  if (block && block.overspent) return '已超支';
  const p = block ? block.remain_pct : null;
  // 同 `pct1()`：`Number(null) === 0` ⇒ 漏了这一句会把「未设」画成「剩余 0%」。
  if (p == null || p === '') return '未设';
  const v = Number(p);
  return Number.isFinite(v) ? `剩余 ${v}%` : '未设';
}

/**
 * 功能：预算块右侧那三行「剩余预算 / 预算 / 支出」的**数值部分**（只排版，不算钱）。
 *
 * 说明：⚠️⭐ 剩余**可以是负数**（超支），那时**照实显示负数**（图 6 的 `-10045.00`）——
 * 不取绝对值、⛔ 不夹到 0（那会把「超了多少」抹掉，而且不报错）。
 * `hidden`（眼睛）时三串一起糊成圆点（与全屏其他金额同一条纪律）。
 */
export function budgetBlockText(block, hidden) {
  const b = block || { amount_fen: 0, used_fen: 0, remain_fen: 0 };
  return {
    remain: fmtFen(Number(b.remain_fen) || 0, hidden),
    amount: fmtFen(Number(b.amount_fen) || 0, hidden),
    used: fmtFen(Number(b.used_fen) || 0, hidden),
  };
}

/**
 * 功能：把 `YYYY-MM` 的月份串**平移**若干个月（明细屏翻月 / 月详情页取相邻月用）。
 *
 * 说明：⚠️ 走 `Date` 的「进位」语义（`2026-01` 往前 1 个月 = `2025-12`），
 * 不手写 `Number(m) - 1`（那会给出 `0` 月）。判据只住这一处。
 * @param {string} month - `YYYY-MM`
 */
export function shiftMonth(month, delta) {
  const s = String(month || '');
  if (!/^\d{4}-\d{2}$/.test(s)) return s;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = new Date(y, m - 1 + Math.trunc(Number(delta) || 0), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================================
// 记账 4 期（图表趋势 / 导出）—— 两端共用的那半
//
// 功能：① 图表的口径清单与期间标签；② 导出那两格（导什么 / 范围）的清单与标签。
// 说明：⭐⭐ 与 1~3 期同一条纪律（项目）：**清单与文案只住这里一份**，

/**
 * 功能：图表的**口径**清单（顶栏那颗下拉）—— `key` 与文案的唯一出处。
 *
 * 说明：⭐ 给的三张参考图里，顶栏是「支出 ▾」，点开能切「收入」⇒ 本期就这两档。
 * 与 1 期「资产」格里那套（`asset` / `liability` / `net`）**刻意不是一伙的**：
 * 那是**资产口径**、画在资产那一格；本期这两档是**记账口径**、内嵌在明细与账单里
 */
export const CHART_DIRS = [
  { key: 'out', name: '支出' },
  { key: 'in', name: '收入' },
];

/**
 * 功能：图表口径的 `key` 白名单（判据用；⛔ 别在别处再写一遍枚举）。
 * @type {Array.<string>}
 */
export const CHART_DIR_KEYS = CHART_DIRS.map((d) => d.key);

/**
 * 功能：认一个值是不是合法的图表口径 —— ⭐ 判据只住这一处（两端都调它）。
 * @param {*} v - 候选值（`state.lgChartDir`）
 * @returns {string} 命中的 `key`；认不出＝`'out'`（支出 —— 参考图默认就是它）
 */
export function chartDirOf(v) {
  const k = String(v || '');
  return CHART_DIR_KEYS.includes(k) ? k : 'out';
}

/**
 * 功能：**屏内那颗药丸**的两档（`列表 ｜ 图表`）—— `key` 与文案的唯一出处。
 *
 * 说明：⭐⭐ 「**明细和账单有自己的图表（图表功能不是独立的）**，
 * 「删除 明细中的图表」⇒ 明细屏永远是流水列表（它本来也是），账单屏那一颗照旧可切。
 * 它记在 `state.lgBillTab2`，**默认 `list`**。
 */
export const SUB_TABS = [
  { key: 'list', name: '列表' },
  { key: 'chart', name: '图表' },
];

/**
 * 功能：药丸两档的 `key` 白名单。
 * @type {Array.<string>}
 */
export const SUB_TAB_KEYS = SUB_TABS.map((t) => t.key);

/**
 * 功能：认一个值是不是合法的屏内视图档 —— ⭐ 判据只住这一处。
 *
 * 说明：⚠️ 认不出一律回落 **`'list'`**（默认那一档），⛔ 别回落 `'chart'` ——
 * 「没选过」应该落在列表上（3 期定的明细屏本来就是流水列表）。
 * @param {*} v - 候选值（`state.lgBillTab2`）
 */
export function subTabOf(v) {
  const k = String(v || '');
  return SUB_TAB_KEYS.includes(k) ? k : 'list';
}

/**
 * 功能：图表**折线横轴**上某一格的短标签（年档 `1月` / 月档 `01` / 周档 `09-21`）。
 *
 * 说明：照参考图：图 1 的年档横轴是 `1月 … 12月`、图 2 的月档是 `01 … 30`、
 * 短标签由前端排版（§7.5：期间标签住前端）—— ⛔ 别让服务端下发文案。
 * @param {string} periodType - `'week'` / `'month'` / `'year'`
 */
export function chartTickLabel(periodType, key) {
  const k = String(key || '');
  if (periodType === 'year') return /^\d{4}-\d{2}/.test(k) ? `${Number(k.slice(5, 7))}月` : k;
  if (periodType === 'week') return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k.slice(5, 10) : k;
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k.slice(8, 10) : k;
}

/**
 * 功能：一个周一 → **`M/D~M/D`**（账单周档表格的第一列文案）。
 *
 * 说明：⭐⭐ 把周账单从「本周」改成「**某个月内的各周**」之后，第一列
 * 不能再写「本周」（一行一个「本周」谁也分不清是哪一周）⇒ 写清**这一周是哪几天到哪几天**。
 * 周一是服务端给的那个 `key`，末日在它 **+6 天**。
 */
export function weekRangeLabel(key) {
  const s = String(key || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const e = new Date(y, m - 1, d + 6);
  return `${m}/${d}~${e.getMonth() + 1}/${e.getDate()}`;
}

/**
 * 功能：图表折线的**横轴**（`{labels, at}`，直接喂给 `trendGeometry()` 的第三参）。
 *
 * 说明：⭐ 三个档的刻度疏密**不一样**（照参考图）：
 * 年档 12 格 ⇒ 只标 `1月 / 3月 / 6月 / 9月 / 12月` 五处（与 1 期资产走势同一套位置）；
 * 月档最多 31 格 ⇒ 只标 `01 / 中位 / 末日` 三处（全写会糊成灰带）；
 */
export function chartAxisOf(periodType, series) {
  const list = Array.isArray(series) ? series : [];
  const n = list.length;
  const labels = list.map((p) => chartTickLabel(periodType, p && p.key));
  let at;
  if (periodType === 'year') at = [0, 2, 5, 8, 11];
  // 周档的点从「7 天」变成「该月各周」（4~5 个）⇒ 刻度口径与月档并成一条。
  // 从前那句 `[0, 3, 6]` 是照「恒 7 格」定的：现在点数不到 7 ⇒ 越界的刻度被下面
  // `filter` 一滤，图上只剩两个刻度（看着像"少标了两处"）。
  else at = [0, Math.round(n / 2) - 1, n - 1];
  return { labels, at: at.filter((i) => Number.isInteger(i) && i >= 0 && i < n) };
}

/**
 * 功能：一个日期属于**该年第几个自然周**（周一为起点）—— 周档期间选择行上的 `34周`。
 *
 * 说明：⭐⭐ 参考图 3 把周档写成 `34周 35周 36周`；口径定的是
 * 「**该年第 n 个自然周**」（C-23），⛔ **不是 ISO 周号** —— ISO 周号在跨年那一周
 * 两者一混就会出现「2026 年第 1 周」这种对不上的编号（与 3 期 `period_key` 同一个坑）。
 */
export function weekNoOf(date) {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : '';
  if (!s) return 0;
  const monday = periodKeyOf('week', s);
  if (!monday) return 0;
  const y = Number(monday.slice(0, 4));
  const first = periodKeyOf('week', `${y}-01-01`);
  const d1 = new Date(`${first}T00:00:00`).getTime();
  const d2 = new Date(`${monday}T00:00:00`).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return 0;
  return Math.round((d2 - d1) / 86400000 / 7) + 1;
}

/**
 * 功能：导出的**「导什么」**清单 —— `key` / `name` / `desc` 的唯一出处。
 *
 * 说明：⭐ 三样都要能导：① 自有明细流水 ② 账户余额 ③ 三方导入的**原样**数据。
 * **多选时逐个下**（C-19：⛔ 不引 zip 打包、⛔ 不引 Blob）——
 * 勾了三样就是三次「确认 → 下载」，每次一个 `.csv`。
 */
export const EXPORT_WHATS = [
  { key: 'entries', name: '明细流水', desc: '日期 / 时间 / 收支 / 分类 / 账户 / 金额 / 备注' },
  { key: 'accounts', name: '账户余额', desc: '账户 / 类型 / 余额 / 备注' },
  { key: 'imported', name: '三方导入的原样数据', desc: '鲨鱼记账导出的原始几列，只读' },
];

/**
 * 功能：导出「导什么」的 `key` 白名单。
 * @type {Array.<string>}
 */
export const EXPORT_WHAT_KEYS = EXPORT_WHATS.map((w) => w.key);

/**
 * 功能：导出页那颗日期框**该显示哪个值** —— state 上那个（用户改过的）优先，认不出才用服务端默认。
 *
 * 说明：⭐⭐ 起点由**服务端**给（`/api/ledger/periods` 的 `export.from` / `export.to`）——
 * 前端**不算日期**（项目纪律：`Date.now()` 只在服务端取一次， 同源）。
 * 这里只做「认得出就用、认不出就退」这一件事，⛔ 不做任何算术。
 */
export function exportDateOf(cur, fallback) {
  const c = String(cur || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  const f = String(fallback || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : '';
}

/**
 *
 * 说明：⭐ 原生 `<input type="date">` 在中文环境里显示成 `2026/09/28`（各浏览器还不一样）
 */
export function exportDateText(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '选择日期';
  return `${s.slice(0, 4)}.${s.slice(5, 7)}.${s.slice(8, 10)}`;
}

