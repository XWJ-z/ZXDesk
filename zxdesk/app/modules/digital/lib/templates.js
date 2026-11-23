'use strict';
/**
 * modules/digital/lib/templates.js —— 数码管理的**内置硬件模板**
 * 功能：声明 11 个**预置**模板（10 个专业 + 1 个「通用」兜底）与它们的**专业参数**。
 * `hardware_templates` 表第一次被读时由 `store.js` 的 `_ensureHardwareTemplates()`
 * @author zx
 * @date   2026-10-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-数码管理.md、modules/digital/schema.js 的 `hardware_templates`
 */

/**
 * 内置模板清单：`{ name, fields }`。
 *
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
    // 第二版：硬盘是「一个模板里分两种东西」的那一个 —— 先问**介质**，
    // 再按介质决定后面问什么（「机械和固态各自的参数又有区别」）。
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
 */
const GENERIC_TEMPLATE_NAME = '通用';

module.exports = { BUILTIN_TEMPLATES, GENERIC_TEMPLATE_NAME };
