'use strict';
/**
 * modules/digital/lib/templates.js —— 数码管理的**内置硬件模板**（0.8.23，纯数据层）
 *
 * 功能：声明 11 个**预置**模板（10 个专业 + 1 个「通用」兜底）与它们的**专业参数**。
 *      `hardware_templates` 表第一次被读时由 `store.js` 的 `_ensureHardwareTemplates()`
 *      播种进库（`builtin = 1`），此后**只读不重建** —— 用户能往内置模板上**追加**自定义属性，
 *      所以这里的内容**不许覆盖**已经落库的那些行（见那个方法的说明）。
 *
 * 说明：⭐⭐ 「这个的作用是预制新建硬件的模板菜单。现在的新建硬件
 *      完全是一个模样，可是硬盘、主机、内存这些的参数属性不完全一样，用一套不专业」。
 *      ⇒ 每件硬件在新建时必须先选一个模板，表单据此多渲染一组**专业参数**；
 *      通用字段（名称 / 分类 / 状态 / 品牌 / 型号 / 序列号 / 容量 / 价格 / 日期 / 位置…）
 *      **一律照旧**，这一层只管「这个模板比别的模板多问哪几样」。
 *
 * ⚠️⭐ **`key` 是存进 `hardware_items.attrs` 的那个键 —— 它一旦发布就⛔ 不许再改**
 *      （改了等于把所有已填的值变成孤儿：界面上那几个框会全部空掉，而数据还在库里）。
 *      要改显示文字只改 `label`（key 不动）—— 与「内置模板不能改名」同一条纪律。
 * ⭐⭐ 0.8.23 第二版（「每个专业选项要有常见规格的下拉列表选择，选其它就自己输入」）：
 *      字段多了两个**可选项** —— `opts`（常见规格清单）与 `when`（条件显隐）：
 *      · `opts`：界面渲染成一颗下拉（末项恒是「其它…」，选了它就露出自填框）——
 *        存进 `attrs` 的**仍然是那一串文本**，与手打进来的值**没有区别**（⛔ 不加第二套存储）。
 *        没有 `opts` 的字段照旧是一颗纯文本框（型号这类本来就列不完）。
 *      · `when`：`{ key, in: [...] }` —— 只在**另一个字段的当前值命中 `in`** 时才显示。
 *        硬盘的「机械 / 固态」就是这么分的（「机械和固态各自的参数又有区别」）。
 *        ⚠️ 控制项的值是**界面上那一串文本**（含用户自填的），所以 `in` 里的字面量必须与 `opts`
 *        里那几个**逐字一致**；自填值命不中任何 `in` ⇒ 条件字段都不显示（这是想要的效果）。
 *      ⚠️ 这两个键**只对内置模板有效**：用户自加的属性一律是纯文本（`normalizeFields()` 只认
 *        `key` / `label` / `ph`，⛔ 界面也没有编辑规格清单的地方 —— 别为它先造一层 UI）。
 * ⚠️ 顺序 = 界面上那排模板的先后（给的顺序）：「通用」**排在最后** ——
 *      它是给老数据兜底的那一个（`template_id` 为空的行按它显示），不是给新用户首选的那个。
 *
 * @author zx
 * @date   2026-10-12
 * @since 0.8.23
 * 相关：docs/公共/架构文档/15-数码管理.md、modules/digital/schema.js 的 `hardware_templates`
 */

/**
 * 内置模板清单：`{ name, fields }`。
 *
 * ⚠️ 数组**顺序即界面顺序**（`sort_order` 由播种按 10 / 20 / 30… 生成）；
 *    ⛔ 别重排 —— 已经播种过的账号不会跟着变（播种只认缺的那些）。
 *
 * @type {Array.<{name: string, fields: Array.<Object>}>}
 */
const BUILTIN_TEMPLATES = [
  {
    name: '显卡',
    fields: [
      { key: 'chip', label: '核心', ph: '例如：RTX 4060' },
      { key: 'vram', label: '显存', opts: ['4GB', '6GB', '8GB', '12GB', '16GB', '24GB'] },
      {
        key: 'bus',
        label: '接口',
        opts: ['PCIe 3.0 x16', 'PCIe 4.0 x16', 'PCIe 5.0 x16', 'PCIe 4.0 x8'],
      },
      { key: 'tdp', label: '功耗', ph: '例如：115W' },
      {
        key: 'len',
        label: '长度',
        opts: ['200mm 以内', '200 - 250mm', '250 - 300mm', '300mm 以上'],
      },
    ],
  },
  {
    // ⭐⭐ 0.8.23 第二版：硬盘是「一个模板里分两种东西」的那一个 —— 先问**介质**，
    //    再按介质决定后面问什么（「机械和固态各自的参数又有区别」）。
    //    ⚠️ `media` 的取值必须与下面几条 `when.in` **逐字一致**，否则条件字段永远不出现。
    name: '硬盘',
    fields: [
      { key: 'media', label: '介质', opts: ['机械', '固态'] },
      {
        key: 'iface',
        label: '接口',
        opts: ['SATA', 'SAS', 'M.2 NVMe', 'M.2 SATA', 'U.2', 'mSATA'],
      },
      {
        key: 'rpm',
        label: '转速',
        when: { key: 'media', in: ['机械'] },
        opts: ['5400 rpm', '7200 rpm', '10000 rpm', '15000 rpm'],
      },
      { key: 'cache', label: '缓存', ph: '例如：256MB' },
      {
        key: 'size',
        label: '尺寸',
        opts: ['3.5 寸', '2.5 寸', '2280', '2242', '2230'],
      },
      // ---- 下面两条只在介质 = 固态时出现 ----
      { key: 'nand', label: '闪存类型', when: { key: 'media', in: ['固态'] }, opts: ['TLC', 'QLC', 'MLC', 'SLC'] },
      {
        key: 'speed',
        label: '读写速度',
        when: { key: 'media', in: ['固态'] },
        ph: '例如：读 3500MB/s / 写 3000MB/s',
      },
    ],
  },
  {
    name: '内存',
    fields: [
      { key: 'gen', label: '代数', opts: ['DDR3', 'DDR4', 'DDR5', 'LPDDR4X', 'LPDDR5'] },
      {
        key: 'mhz',
        label: '频率',
        opts: ['2133MHz', '2400MHz', '2666MHz', '3200MHz', '3600MHz', '4800MHz', '5600MHz', '6000MHz'],
      },
      { key: 'cl', label: '时序', opts: ['CL14', 'CL16', 'CL18', 'CL19', 'CL20', 'CL22', 'CL30', 'CL36', 'CL40'] },
      { key: 'stick', label: '单条容量', opts: ['4GB', '8GB', '16GB', '32GB', '48GB', '64GB'] },
    ],
  },
  {
    name: '路由器',
    fields: [
      { key: 'wifi', label: '无线标准', opts: ['WiFi 4', 'WiFi 5', 'WiFi 6', 'WiFi 6E', 'WiFi 7'] },
      { key: 'rate', label: '速率', opts: ['1200Mbps', '3000Mbps', '5400Mbps', '6000Mbps', '万兆'] },
      { key: 'ports', label: '网口', opts: ['4×千兆', '4×千兆 + 1×2.5G', '4×2.5G', '2×2.5G + 2×10G'] },
      { key: 'band', label: '频段', opts: ['单 2.4G', '2.4G / 5G', '2.4G / 5G / 6G'] },
    ],
  },
  {
    name: '交换机',
    fields: [
      { key: 'ports', label: '端口数', opts: ['5 口', '8 口', '16 口', '24 口', '48 口'] },
      { key: 'rate', label: '速率', opts: ['百兆', '千兆', '2.5G', '万兆'] },
      { key: 'mgmt', label: '管理型', opts: ['非管理（即插即用）', '网管型'] },
      { key: 'poe', label: 'PoE', opts: ['不支持', '支持'] },
    ],
  },
  {
    name: '网关',
    fields: [
      { key: 'tput', label: '吞吐', opts: ['1Gbps', '2Gbps', '5Gbps', '10Gbps'] },
      { key: 'ports', label: '接口', opts: ['4×千兆', '4×2.5G + 2×10G', '6×2.5G'] },
      { key: 'os', label: '系统', opts: ['iKuai', 'OpenWrt', 'pfSense', 'RouterOS'] },
    ],
  },
  {
    name: '主机',
    fields: [
      { key: 'cpu', label: 'CPU', ph: '例如：i5-12400' },
      { key: 'board', label: '主板', ph: '例如：B660M' },
      { key: 'mem', label: '内存', opts: ['8GB', '16GB', '32GB', '64GB', '128GB'] },
      { key: 'psu', label: '电源', opts: ['300W', '400W', '500W', '650W', '750W', '850W'] },
      { key: 'os', label: '系统', opts: ['fnOS', 'Windows', 'Linux', '群晖 DSM', 'TrueNAS'] },
    ],
  },
  {
    name: '笔记本',
    fields: [
      { key: 'cpu', label: 'CPU', ph: '例如：i5-13500H / R7-7840H' },
      { key: 'mem', label: '内存', opts: ['8GB', '16GB', '24GB', '32GB', '64GB'] },
      { key: 'screen', label: '屏幕尺寸', opts: ['13 寸', '14 寸', '15.6 寸', '16 寸', '17.3 寸'] },
      { key: 'os', label: '系统', opts: ['Windows', 'macOS', 'Linux'] },
      { key: 'weight', label: '重量', opts: ['1kg 以内', '1 - 1.5kg', '1.5 - 2kg', '2kg 以上'] },
    ],
  },
  {
    name: '手机',
    fields: [
      { key: 'screen', label: '屏幕', opts: ['6.1 寸', '6.4 寸', '6.7 寸', '6.8 寸'] },
      { key: 'storage', label: '存储', opts: ['64GB', '128GB', '256GB', '512GB', '1TB'] },
      { key: 'battery', label: '电池', opts: ['4000mAh', '4500mAh', '5000mAh', '5500mAh', '6000mAh'] },
      { key: 'os', label: '系统', opts: ['Android', 'iOS', 'HarmonyOS'] },
    ],
  },
  {
    name: '机柜',
    fields: [
      { key: 'u', label: 'U 数', opts: ['6U', '9U', '12U', '18U', '22U', '32U', '42U'] },
      { key: 'depth', label: '深度', opts: ['450mm', '600mm', '800mm', '1000mm', '1200mm'] },
      { key: 'load', label: '承重', opts: ['30kg', '60kg', '100kg', '150kg'] },
    ],
  },
  {
    name: '通用',
    fields: [],
  },
];

/**
 * 「通用」模板的名字 —— 老数据（`template_id` 为空）在界面上按它显示。
 *
 * ⚠️ 它是**惰性兜底**，不是一次数据迁移：⛔ 不往 `hardware_items.template_id` 里写值
 *    （本项目铁律：迁移绝不改写用户数据）。列表与详情取数时按「空 ⇒ 通用」算，
 *    用户哪天给某一条选了真模板，那一行自然就跟着走了。
 *
 * @type {string}
 */
const GENERIC_TEMPLATE_NAME = '通用';

module.exports = { BUILTIN_TEMPLATES, GENERIC_TEMPLATE_NAME };
