'use strict';

/**
 * app/modules/registry.js —— 模块注册表：**扫目录**取代**手写清单**（0.5.0 模块化重构）
 *
 * 功能：扫 `app/modules/` 下的一级子目录，每个模块目录读一张 `module.json`（模块身份证），在加载时自检契约
 *      （字段齐全 / 类型对 / 名字与目录名一致 / `depends` 指向真实模块 / `backend/` 一旦存在就必须两个后端都在），
 *      再按 `order` 升序、同 `order` 按名字排出**稳定顺序**；对外提供五组聚合：
 *      schema 模块、后端 ops 对、路由表、导出片段、前端入口清单。
 *
 * 为什么要它（方案 `09-模块化重构` §一）：改造前一个模块散在 6 个目录、约 15 处，其中 8 处是
 * 「清单 / 注册」式的机械登记，**漏一处就出事故** —— 各方案里那句「漏一处就出事故」的清单，
 * 正是这个结构的症状。把登记从「人写」改成「扫目录」之后：加模块 = 建目录 + 写一张 `module.json`，
 * 删模块 = 删掉那个目录。
 *
 * ⭐ 验收标准（方案 §八）：**删掉整个模块目录，应用照常启动、界面少一个入口、其它模块一切正常。**
 *
 * ⚠️ 三条刻意的设计：
 *   ① **不做缓存**：模块只有个位数（方案 §四 实现要点 4：「可预测 > 快」）；
 *   ② **顺序必须确定**：`order` 升序、同 `order` 按名字 —— 否则「启动顺序不确定」会变成随机 bug
 *      （`ttt/test/modules.test.js` 有断言钉住它）；
 *   ③ **契约自检必须是启动硬失败**：字段缺失 / 类型不符 / `backend/` 里只有一个后端 —— 一律加载即抛，
 *      与 `store/schema/index.js` 的 `assertModules()`、`store/backend/index.js` 的 `assertOpsContract()`
 *      是同一个哲学：**契约在加载时兑现**（不允许「降级放行」，方案 §十一 明写）。
 *
 * ⚠️ 这一批是**渐进接管**：模块目录里还没有 `schema.js` / `routes.js` / `store.js` 时，调用方继续用
 *    它原来的那一份（`store/schema/<name>.js`、`routes/<name>.js`…）。「扫到谁就接管谁，没搬的照旧」——
 *    所以本文件里的 `xxxFor()` 在没搬迁时一律回 `null`，**回 null 不是错误**。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.8.13
 * 相关：docs/公共/架构文档/01-架构总览.md、02-存储层与数据模型.md、08-工程规范.md
 */

const fs = require('node:fs');
const path = require('node:path');

/** 模块根目录（= 本文件所在目录）。测试可以另指一个目录给 `loadModules()`。 */
const MODULES_DIR = __dirname;

/**
 * `module.json` 的契约：`[字段名, 期望类型]`。
 *
 * ⚠️ `switchField` 允许 `null`（不可关的模块，如任务板）；`test` 同样允许 `null`
 *    （测试分散在跨模块用例里的模块，如任务板）—— 「没有」与「写了个空串」是两件事，
 *    契约只接受前者，免得 `''` 这种半吊子值一路混到界面上。
 *
 * ⚠️ `apiPrefix` 允许**字符串或字符串数组**：多数模块只占一个顶层键（`/api/bookmarks`），
 *    但任务板一个人占着 `tasks` / `projects` / `daily` / `export` / `search` / `summary` / `today-count`
 *    七个（方案 §三 写的是单数 `apiPrefix`；这里放宽成「单数或复数」而不是改名，
 *    是为了不为一个模块的规模去改所有人都在读的字段名）。
 *
 * ⭐ `apiPrefix` **还允许空数组**（`0.8.7`）—— 给**纯屏模块**用的：
 *    那种模块只搭一屏骨架、数据全走别的模块的接口（范例 `webpass`「网址/密码夹」），
 *    它真的一条接口都没有 ⇒ `[]` 是**更诚实**的声明（造一个空转接口会误导后来者「这个前缀有东西」）。
 *    ⚠️ 护栏是白送的：`routesFor()` 会拒绝**任何**未在 `apiPrefix` 里声明的导出键 ⇒
 *    声明了空清单却还留着 `routes.js` 的模块**自己就会抛**，不必另写判据。
 *
 * ⭐⭐ `switchField` **允许是字符串数组**（`0.8.13`）—— 给「一个模块里装着
 *    几个同级子模块、每个都要能单独关掉」的那种模块用的（范例 `time`「番茄钟与日程表」：
 *    课表 / 番茄钟 / 行程各一颗）。⚠️ 它**仍然是「一个模块一张卡」**：卡上按这份清单画 N 行，
 *    每行只提交**自己那一个键**（⛔ 绝不一次提交两个 —— 会把另一台设备刚改的值覆盖掉）。
 *    ⚠️ 失败方向与「密码库那种宁可不给」**相反**：清单解析不出来 ⇒ 按**开着**处理
 *    （关掉是「少一个入口」，误关会让用户以为功能没了），并把这件事记进启动日志。
 *
 * @type {Array.<Array.<string>>}
 */
const CONTRACT = [
  ['name', 'string'],
  ['title', 'string'],
  ['icon', 'string'],
  ['order', 'number'],
  ['defaultEnabled', 'boolean'],
  ['switchField', 'string|string[]|null'],
  ['apiPrefix', 'string|string[]'],
  ['tables', 'string[]'],
  ['depends', 'string[]'],
  ['archDoc', 'string'],
  ['test', 'string|null'],
];

/**
 * 功能：判断一个契约字段的值是否属于期望类型。
 *
 * 说明：⚠️ `array` / `object` / `string|null` 必须分开判 —— `typeof [] === 'object'`，
 *      只比 `typeof` 会把数组当对象放过；`string|null` 也不能退化成「非空字符串」，
 *      否则「不可关的模块」就没法表达。
 *
 * @param {*} value - 字段的实际值
 * @param {string} want - 期望类型，见 `CONTRACT`
 * @returns {boolean} 类型相符为 true
 */
function typeOk(value, want) {
  if (want === 'array') return Array.isArray(value);
  if (want === 'string[]') return Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');
  if (want === 'string|null') return value === null || (typeof value === 'string' && value !== '');
  if (want === 'string|string[]|null') {
    // ⭐ 0.8.13：数组那一支**不许是空数组** —— 「一个子开关都没有」应当写 `null`
    //    （「没有」与「写了个空清单」是两件事，同 `apiPrefix` 那条说明的精神）；
    //    元素照 `string[]` 的口径逐个判（非空串）。
    return (
      value === null ||
      (typeof value === 'string' && value !== '') ||
      (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== ''))
    );
  }
  if (want === 'string|string[]') {
    // ⚠️ `length > 0` 是**故意去掉**的（0.8.7）：空数组是「纯屏模块」的合法声明，见 `CONTRACT` 的说明。
    //    字符串那一支仍不许空串 —— 「没有接口」与「写了个空串」是两件事（同 `switchField` 的口径）。
    return (
      (typeof value === 'string' && value !== '') ||
      (Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== ''))
    );
  }
  if (want === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === want && (want !== 'string' || value !== '');
}

/**
 * 功能：把 `apiPrefix` 归一成数组（单数与复数两种写法都认，见 `CONTRACT` 的说明）。
 * @param {Object} meta - 一条模块身份证
 * @returns {Array.<string>} 顶层路由键数组
 */
function apiPrefixesOf(meta) {
  return Array.isArray(meta.apiPrefix) ? meta.apiPrefix.slice() : [meta.apiPrefix];
}

/**
 * 功能：把 `switchField` 归一成数组（`null` → 空数组；单数 → 一件；复数原样）。
 *
 * 说明：⭐ 0.8.13：`switchField` 现在允许**字符串数组**（一个模块里几个同级
 *      子模块各一颗开关）。归一成数组之后，消费方（`frontendList()` / 前端的 `moduleItems()`）
 *      只需认一种形状，⛔ 不必各自写一遍 `Array.isArray` 分支。
 *      ⚠️ `null`（不可关的模块）回**空数组** —— 调用方据此判「这个模块没有开关」。
 *
 * @param {?string|Array.<string>} field - `module.json` 的 `switchField`（传**值**，不是 meta）
 * @returns {Array.<string>} `users` 上的开关列名（可能为空）
 */
function switchFieldsOf(field) {
  if (field === null || field === undefined) return [];
  return Array.isArray(field) ? field.slice() : [field];
}

/**
 * 功能：读一个模块目录下的可选文件（搬迁中间态里「还没有」是正常的）。
 * @param {string} dir - 模块目录绝对路径
 * @param {string} rel - 相对模块目录的文件名（如 `schema.js`）
 * @returns {?string} 文件存在时返回绝对路径，否则返回 null
 */
function optionalFile(dir, rel) {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? p : null;
}

/**
 * 功能：扫描模块目录并装配出一个注册表实例（**纯函数式**：目录可注入，测试指向临时夹具即可）。
 *
 * 说明：返回的对象把「五组聚合」做成方法，调用方（`store/schema`、`server.js`、`store/methods/stats.js`、
 *      `routes/system.js`）只认这个接口，不认目录细节。
 *
 * @param {string} [dir] - 模块根目录；省略时用 `app/modules/`
 * @returns {Object} 注册表实例，见下方 `return` 处的字段说明
 * @throws {Error} 某个目录缺 `module.json`、契约不合格、`depends` 指向不存在的模块、
 *      `backend/` 里缺少两个后端之一、或 `order` 不唯一且名字重复（重名目录）时抛出
 */
function loadModules(dir) {
  const root = dir || MODULES_DIR;
  const bad = [];
  const list = [];

  if (!fs.existsSync(root)) throw new Error(`[modules] 模块根目录不存在：${root}`);

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const name of dirs) {
    const mdir = path.join(root, name);
    const manifest = path.join(mdir, 'module.json');
    // ⚠️ 「目录建了却忘了写身份证」必须当场炸：只扫目录的话，这个模块会**静默消失**，
    //    表现是「界面上少一个入口、接口 404」，而启动日志里一个字都没有。
    if (!fs.existsSync(manifest)) {
      bad.push(`模块目录 ${name}/ 里没有 module.json（模块身份证是唯一的登记处，缺了它这个模块会静默消失）`);
      continue;
    }

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch (e) {
      bad.push(`modules/${name}/module.json 解析失败：${e.message}`);
      continue;
    }

    let fieldsOk = true;
    for (const [field, want] of CONTRACT) {
      if (!typeOk(meta[field], want)) {
        bad.push(`modules/${name}/module.json 的 ${field} 必须是 ${want}`);
        fieldsOk = false;
      }
    }
    if (!fieldsOk) continue;

    if (meta.name !== name) {
      bad.push(`modules/${name}/module.json 的 name 是「${meta.name}」，必须与目录名一致（唯一标识＝文件夹名）`);
      continue;
    }
    if (path.basename(mdir) !== name) bad.push(`模块目录名异常：${mdir}`);

    list.push({ meta, dir: mdir });
  }

  // 稳定顺序：order 升序，同 order 按名字 —— 顺序确定是正确性的一部分（见文件头 ②）
  list.sort(
    (a, b) => a.meta.order - b.meta.order || (a.meta.name < b.meta.name ? -1 : a.meta.name > b.meta.name ? 1 : 0),
  );

  const names = new Set(list.map((m) => m.meta.name));
  for (const { meta, dir: mdir } of list) {
    for (const dep of meta.depends) {
      if (dep === meta.name) bad.push(`modules/${meta.name}/module.json 的 depends 指向自己`);
      else if (!names.has(dep)) bad.push(`modules/${meta.name}/module.json 的 depends 指向不存在的模块「${dep}」`);
    }

    // ⚠️ `backend/` 一旦存在，两个后端就必须都在 —— 「同名同参」是模块内的新契约（原 `assertOpsContract`
    //    的语义下移到模块内），少一个的后果是运行期 `undefined is not a function`，
    //    而且只在走到那个后端那条路径时才炸。契约在**加载时**兑现。
    const backendDir = optionalFile(mdir, 'backend');
    if (backendDir) {
      for (const f of ['sqlite.js', 'json.js']) {
        if (!optionalFile(backendDir, f))
          bad.push(`modules/${meta.name}/backend/ 里缺少 ${f}（两个后端必须同名同参地成对存在）`);
      }
    }
  }

  if (bad.length) throw new Error(`[modules] 模块契约自检失败（共 ${bad.length} 处）：\n  - ${bad.join('\n  - ')}`);

  const byName = new Map(list.map((m) => [m.meta.name, m]));

  /**
   * 功能：取某模块目录下的可选 JS 文件并 require 之（没搬走时回 null）。
   * @param {string} name - 模块名
   * @param {string} rel - 相对模块目录的文件名
   * @returns {?*} require 的结果；文件不存在时为 null
   */
  const requireOptional = (name, rel) => {
    const entry = byName.get(name);
    if (!entry) return null;
    const p = optionalFile(entry.dir, rel);
    return p ? require(p) : null;
  };

  return {
    /** 模块根目录（诊断与测试用） */
    root,
    /** 排好序的模块身份证数组（`meta` 是 module.json 原样对象） */
    list: list.map((m) => m.meta),
    /** 模块名 → 目录绝对路径 */
    dirOf: (name) => (byName.has(name) ? byName.get(name).dir : null),
    /** 模块名 → 模块身份证；不存在的模块回 null（删掉目录之后就该是 null） */
    get: (name) => (byName.has(name) ? byName.get(name).meta : null),
    /** 模块名 → 本模块的表结构声明（`modules/<name>/schema.js`）；没搬走时 null */
    schemaFor: (name) => requireOptional(name, 'schema.js'),
    /** 模块名 → 本模块的业务方法（`modules/<name>/store.js`）；没搬走时 null */
    storeFor: (name) => requireOptional(name, 'store.js'),
    /** 模块名 → 本模块的导出片段（`modules/<name>/export.js`）；没搬走时 null */
    exportFragmentFor: (name) => requireOptional(name, 'export.js'),
    /**
     * 功能：取某模块的**一对**后端原语（`modules/<name>/backend/{sqlite,json}.js`）。
     * @param {string} name - 模块名
     * @returns {?{sqlite: Object, json: Object}} 成对存在时返回两个后端；没搬走时返回 null
     */
    backendFor(name) {
      const a = requireOptional(name, 'backend/sqlite.js');
      const b = requireOptional(name, 'backend/json.js');
      if (!a && !b) return null;
      return { sqlite: a, json: b };
    },
    /**
     * 功能：取某模块的路由模块（`modules/<name>/routes.js`），并核对它暴露的顶层键确实是本模块声明的。
     *
     * 说明：`routes.js` 的形态是 `module.exports = { <顶层键>: handler }` —— 键就是 `/api/<键>` 的第一段，
     *      由聚合方自动挂到 `API_ROUTES` 上，模块自己不用认识路由表。
     *
     * @param {string} name - 模块名
     * @returns {?Object} 顶层键 → 处理函数；没搬走时 null
     * @throws {Error} 暴露了本模块没在 `apiPrefix` 里声明的键时抛出（防手滑写错前缀）
     */
    routesFor(name) {
      const table = requireOptional(name, 'routes.js');
      if (!table) return null;
      const declared = apiPrefixesOf(byName.get(name).meta);
      const extra = Object.keys(table).filter((k) => !declared.includes(k));
      if (extra.length) {
        throw new Error(
          `modules/${name}/routes.js 暴露了未声明的接口前缀 [${extra.join(', ')}] —— ` +
            `请先在 module.json 的 apiPrefix 里登记（已声明：${declared.join(', ')}）`,
        );
      }
      return table;
    },
    /**
     * 功能：给浏览器看的入口清单（前端据此画侧栏入口 / 底部标签 / 设置页开关）。
     *
     * 说明：⚠️ **发全量，不过滤 `hide_*`**（方案 §八 第 2 条要的是「设置页开关消失」——
     *      关掉的模块若从清单里被剔掉，就再也没有地方把它打开了）。
     *      开关**状态**由 `me.hide_*` 决定，清单只管「有哪些模块、叫什么、什么图标、什么顺序」。
     *
     * @returns {Array.<Object>} `[{ name, title, icon, order, switchField, defaultEnabled }, …]`
     */
    frontendList: () =>
      list.map(({ meta }) => ({
        name: meta.name,
        title: meta.title,
        icon: meta.icon,
        order: meta.order,
        switchField: meta.switchField,
        defaultEnabled: meta.defaultEnabled,
      })),
  };
}

/** 装配默认注册表 —— 加载即自检（`storage.js` / `server.js` 一 require 就会跑） */
const registry = loadModules(MODULES_DIR);

/**
 * 功能：装配 schema 模块数组 —— `core`（地基，不是模块、不可删）固定第一，其余按注册表顺序。
 *
 * 说明：⚠️ 顺序有意义：`core` 里的 `users` 是任务与课表的父表，重建时父表必须先存在。
 *      ⚠️ 已搬迁的模块取 `modules/<name>/schema.js`，没搬的仍取旧的 `store/schema/<name>.js`
 *      （由调用方传进来的 `legacyOf` 解析）—— 同一个模块**不允许**两边同时存在，
 *      否则表会被声明两遍，`assertModules()` 的「抢表名」检查会当场炸掉（这是刻意的）。
 *
 * @param {Object} reg - 注册表实例
 * @param {Object} coreSchema - `store/schema/core.js`（地基，永远第一）
 * @param {Function} legacyOf - `(name) => Object`：取未搬迁模块的旧 schema 模块
 * @returns {Array.<Object>} schema 模块数组
 */
function schemaModules(reg, coreSchema, legacyOf) {
  return [coreSchema, ...reg.list.map((meta) => reg.schemaFor(meta.name) || legacyOf(meta.name))];
}

/**
 * 功能：收集「已搬迁模块各自的一对后端 op」—— 交给 `assertOpsContract()` 逐个比对。
 *
 * 说明：⚠️ 未搬迁的模块不在这里（它们的 op 还在 `store/backend/` 两个大文件里，
 *      由调用方继续整体比对一次）。
 *
 * @param {Object} reg - 注册表实例
 * @returns {Array.<{label: string, sqlite: Object, json: Object}>} 待比对的后端对
 */
function opsPairs(reg) {
  const pairs = [];
  for (const meta of reg.list) {
    const pair = reg.backendFor(meta.name);
    if (pair) pairs.push({ label: `modules/${meta.name}/backend`, sqlite: pair.sqlite.ops, json: pair.json.ops });
  }
  return pairs;
}

/**
 * 功能：把已搬迁模块的路由并进旧的路由派发表（`API_ROUTES`）。
 *
 * 说明：⚠️ 同一个顶层键被**任何**两处登记都算撞车（旧的手写表里已经有一行、或另一个模块也声明了它）——
 *      后者会静默顶掉前者，而「谁赢了」取决于搬家的进度，那种 bug 找起来极痛苦。
 *      （旧表与模块里的处理函数**不可能**是同一个引用，所以这里不需要、也不该去比对函数本身。）
 *
 * @param {Object} reg - 注册表实例
 * @param {Object} legacyTable - 尚未搬迁的手写路由表
 * @returns {Object} 合并后的路由表（新对象，不改原表）
 */
function routeTable(reg, legacyTable) {
  const table = { ...legacyTable };
  for (const meta of reg.list) {
    const routes = reg.routesFor(meta.name);
    if (!routes) continue;
    for (const [prefix, handler] of Object.entries(routes)) {
      if (Object.prototype.hasOwnProperty.call(table, prefix)) {
        throw new Error(
          `[modules] 接口前缀 /api/${prefix} 被重复登记（模块 ${meta.name} 与旧路由表 / 另一个模块各一份）—— 搬迁时旧的那一行必须删掉`,
        );
      }
      table[prefix] = handler;
    }
  }
  return table;
}

/**
 * 功能：收集已搬迁模块的导出片段并合并成一份（个人备份的 `exportAll` 用它）。
 *
 * 说明：⚠️ 键撞车一律抛错：两份数据写进同一个备份键，表现是「另一份被静默覆盖」，
 *      而备份文件看上去完全正常。
 *
 * @param {Object} reg - 注册表实例
 * @param {Object} store - Store 实例（片段拿它读自己的表）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ <备份键>: 数据 }`；没有已搬迁模块时为空对象
 * @throws {Error} 两个模块导出同一个键时抛出
 */
function exportFragments(reg, store, uid) {
  const out = {};
  for (const meta of reg.list) {
    const frag = reg.exportFragmentFor(meta.name);
    if (!frag) continue;
    const piece = frag(store, uid) || {};
    for (const [key, value] of Object.entries(piece)) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new Error(`[modules] 备份键 ${key} 被两个模块同时导出（模块 ${meta.name}）—— 备份里会静默少一份数据`);
      }
      out[key] = value;
    }
  }
  return out;
}

module.exports = {
  MODULES_DIR,
  CONTRACT,
  apiPrefixesOf,
  switchFieldsOf,
  loadModules,
  registry,
  schemaModules,
  opsPairs,
  routeTable,
  exportFragments,
};
