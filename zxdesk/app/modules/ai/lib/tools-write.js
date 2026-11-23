'use strict';
/**
 * modules/ai/lib/tools-write.js —— 工具面的**写侧**
 * 功能：V1 **唯一**的写工具 `tasks.propose_create` 的目录项、入参归一与执行体。
 * @author zx
 * @date   2026-09-18
 * @since 0.9.7
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/16-AI辅助任务-3期-AI工具调用与授权.md
 */

const { httpError } = require('./tools-read.js');

/**
 * 可以授权给 AI **写**的模块名（白名单）。
 *
 */
const WRITE_MODULES = ['tasks', 'ledger', 'bookmarks', 'idea', 'digital', 'trip', 'assets', 'calendar'];

/**
 * AI 卡片屏「AI 能力」那一块**逐字使用**的文案里**属于写侧 / 审计**的那几句。
 *
 */
const PANEL_WRITE = {
  // 「任务板（写）」旁边的解释
  tasksWrite: 'AI 可以提议新建任务；每次都会先给你看，你点确认才会建。',
  ledgerWrite: 'AI 可以提议记一笔账；每次都会先给你看，你点确认才会记进去。',
  bookmarksWrite: 'AI 可以提议收藏一个网址；每次都会先给你看，你点确认才会存进去。',
  ideaWrite: 'AI 可以提议记一条随手记；每次都会先给你看，你点确认才会记下来。',
  hardwareWrite: 'AI 可以提议登记一件数码设备；每次都会先给你看，你点确认才会写进台账。',
  // —— ⚠️ 多一句「归到哪趟行程由你自己选」：
  // 本期**不在卡上选行程**（AI 不提议建行程），用户回头自己把票拖进行程里。
  // 不写这一句的话，上线后一定会被当成 bug（「AI 建了票，怎么什么都没归？」）。
  tripWrite: 'AI 可以提议建几张车票；每次都会先给你看，你点确认才会加进去。票不会自动归到哪趟行程，你可以回头自己拖进去。',
  // 全面体检：资产与日历两块写面 —— 同样只有「提议新建」这一条
  assetsWrite: 'AI 可以提议记一条资产；每次都会先给你看，你点确认才会加进台账。',
  calendarWrite: 'AI 可以提议建一条日程；每次都会先给你看，你点确认才会写进日历。',
  // 审计开关旁边的解释
  audit: '只记工具名、参数摘要与成败 —— 不记内容，也不记任何密钥。',
};

/**
 * 工具定义表里**属于写侧**的那 5 条（表字段说明见 `tools.js` 的 `TOOLS`）。
 * @type {Array.<Object>}
 */
const WRITE_TOOLS = [
  {
    name: 'tasks.propose_create',
    module: 'tasks',
    mode: 'write',
    title: '提议建一条任务',
    purpose: '把聊天里说好的事整理成任务草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.tasksWrite,
    args: [
      '任务列表：每条 title 必填；可带 due（YYYY-MM-DD）、important、urgent、scope（daily 或项目 id）、' +
        'kind（plain 普通 / window 窗口 / cycle 周期）、rule（周期规则，仅 kind=cycle 时填：' +
        '{"freq":"daily"} 或 {"freq":"weekly","slots":[[1,1],[3,3]]}，其中 1 = 周一、每一期是 [起,止]）',
    ],
    returns: ['一条条待你确认的任务草稿'],
  },
  // 记账那一笔 —— 「参考任务的模式」（提议 → 卡片 → 点确认才写入）
  {
    name: 'ledger.propose_entry',
    module: 'ledger',
    mode: 'write',
    title: '提议记一笔账',
    purpose: '把聊天里说好的花销 / 收入整理成记账草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.ledgerWrite,
    args: [
      '账目列表：每条 amount（单位元，如 35.5）必填；可带 ie（支出 / 收入，默认支出）、' +
        'at（YYYY-MM-DD）、category（一级分类名，或「一级-二级」全称）、' +
        'subcategory（二级分类名）、account（账户名；不填就用用户设置的默认账户）、note（备注）',
    ],
    returns: ['一条条待你确认的记账草稿', '分类 / 账户在**本机**解析成 id；解析不到时把模型的原话带回来（卡上可见）'],
  },
  // 三块与上面两条**完全同款**：只提议、⛔ 不落库、一律过用户那张确认卡。
  {
    name: 'bookmarks.propose_create',
    module: 'bookmarks',
    mode: 'write',
    title: '提议收藏一个网址',
    purpose: '把聊天里提到的网址整理成收藏草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.bookmarksWrite,
    args: [
      '收藏列表：每条 url 必填（要写全，含 https://）；可带 title（标题）、' +
        'tags（分类名数组 —— 本机没有的分类名会在你点确认时顺手建出来）',
    ],
    returns: ['一条条待你确认的收藏草稿', '每条会标出「这条网址已经收藏过了」（避免点确认时才撞 400）'],
  },
  {
    name: 'idea.propose_create',
    module: 'idea',
    mode: 'write',
    title: '提议记一条随手记',
    purpose: '把聊天里说好要记下来的事整理成草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.ideaWrite,
    args: ['随手记列表：每条 content 必填（正文）；可带 tag（一个标签）'],
    returns: ['一条条待你确认的随手记草稿'],
  },
  {
    name: 'hardware.propose_create',
    module: 'digital',
    mode: 'write',
    title: '提议登记一件硬件',
    purpose: '把聊天里说好的「买了什么」整理成台账草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.hardwareWrite,
    args: [
      '硬件列表：每条 name 必填；可带 category、status（owned 在用 / wishlist 想买 / retired 已退役）、' +
        'brand、model、capacity（如 4TB）、purpose、purchase_date（YYYY-MM-DD）、' +
        'purchase_price（单位元）、expected_life_months（预期寿命，用户自己估的那个数）',
    ],
    returns: [
      '一条条待你确认的台账草稿',
      '⚠️ 序列号 / 位置 / 盘位 / 详细内容**不在这张卡上** —— 那些要你到硬件那一屏自己补',
    ],
  },
  {
    name: 'trips.propose_create',
    module: 'trip',
    mode: 'write',
    title: '提议建几张车票',
    purpose: '把聊天里说好的行程整理成车票草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.tripWrite,
    args: [
      '车票列表：每条 from（出发站）与 to（到达站）与 depart（出发时刻，如 2026-09-30 08:00）必填；' +
        '可带 kind（火车 / 高铁 / 飞机 / 汽车 / 船 / 其它）、code（车次 / 航班号）、' +
        'arrive（到达时刻）、seat（座位）、gate（检票口）、note（备注）',
    ],
    returns: [
      '一条条待你确认的车票草稿',
      '⚠️ 票号 / 订单号**不在这张卡上** —— 那要你自己填（它压根不进 AI 的出网面）',
    ],
  },
  {
    name: 'assets.propose_item',
    module: 'assets',
    mode: 'write',
    title: '提议记一条资产',
    purpose: '把聊天里说好的「我有一套…／这台…值多少」整理成台账草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.assetsWrite,
    args: [
      '条目列表：每条 name 必填；可带 group（分组名 —— 必须是**已有分组**的名字，' +
        '本机找不到的名字不会替你新建，会在卡上标出来）、amount（金额，单位**元**，可以带小数）、' +
        'date（YYYY-MM-DD）',
    ],
    returns: [
      '一条条待你确认的资产草稿',
      '⚠️ 备注**不在这张卡上** —— 那要你自己填（它压根不进 AI 的出网面）',
    ],
  },
  {
    name: 'calendar.propose_event',
    module: 'calendar',
    mode: 'write',
    title: '提议建一条日程',
    purpose: '把聊天里说好的「几号几点要做什么」整理成日程草稿 —— **只提议，落库永远由你点确认**。',
    share: PANEL_WRITE.calendarWrite,
    args: [
      '日程列表：每条 title 与 date（YYYY-MM-DD）必填；可带 all_day（true / false）、' +
        'start（HH:MM）、end（HH:MM）、end_date（跨天时填，YYYY-MM-DD）',
    ],
    returns: [
      '一条条待你确认的日程草稿',
      '⚠️ 备注**不在这张卡上** —— 那要你自己填（它压根不进 AI 的出网面）',
    ],
  },
];

/** 一次最多提议几条（⛔ 超了**可见地拒绝**，不是静默截断 —— 静默截断＝用户以为全建了） @type {number} */
const PROPOSE_MAX = 20;

/**
 * 一笔账写错了就是账本里多了一笔钱，风险比一条任务大得多 ⇒ 一次只要它整理**一小段**
 * @type {number}
 */
const PROPOSE_ENTRY_MAX = 10;

/** 一次最多提议**几条收藏**（） @type {number} */
const PROPOSE_BM_MAX = 10;

/** 一次最多提议**几条随手记**（） @type {number} */
const PROPOSE_IDEA_MAX = 10;

/**
 * 容量 / 用途 / 购买日期 / 价格 / 预期寿命），一条要核的东西顶三条任务 ⇒ 一次让它整理
 * @type {number}
 */
const PROPOSE_HW_MAX = 5;

/**
 * （票型 / 车次 / 出发到达站 / 出发到达时刻 / 座位 / 检票口），而且**转机换乘算两张票**
 * @type {number}
 */
const PROPOSE_TRIP_MAX = 5;

/**
 * 日期四样，核起来不费事。
 * @type {number}
 */
const PROPOSE_ASSET_MAX = 10;

/**
 * 一次给多了用户根本核不过来（而错一条就是「那天白跑一趟」）。
 * @type {number}
 */
const PROPOSE_EVENT_MAX = 10;

/**
 * 车票「票型」的**关键词 → 枚举值**表 —— ⚠️⭐ **顺序即优先级**。
 *
 */
const TRIP_KIND_WORDS = [
  ['highspeed', ['高铁', '动车', '城际', 'g字头', 'g 字头', 'highspeed', 'high-speed']],
  ['train', ['火车', '列车', '普快', '特快', '直达', '绿皮', 'train']],
  ['flight', ['飞机', '航班', '机票', 'flight', 'plane']],
  ['bus', ['汽车', '大巴', '客车', '班车', '长途', 'bus', 'coach']],
  ['ship', ['船', '轮船', '渡轮', '邮轮', 'ship', 'ferry', 'boat']],
  ['other', ['其它', '其他', 'other']],
];

/** 车票六型 —— ⚠️ 与 `modules/trip/schema.js` 的 `CHECK (kind IN (…))` 逐字一致。 */
const TRIP_KINDS = ['train', 'highspeed', 'flight', 'bus', 'ship', 'other'];

/** 功能：两位补零。 @param {(string|number)} v - 值 @returns {string} 两位串 */
function pad2(v) {
  return String(v).padStart(2, '0');
}

/**
 * 功能：把模型给的票型**归一到六值枚举**。
 * @param {*} want - 模型原本说的（可能是中文、英文或枚举值本身）
 * @returns {{kind: string, kind_want: string}} 归一结果与「它原本说的」
 */
function normTripKind(want) {
  const raw = String(want == null ? '' : want).trim();
  const low = raw.toLowerCase();
  if (TRIP_KINDS.includes(low)) return { kind: low, kind_want: raw };
  for (const [kind, words] of TRIP_KIND_WORDS) {
    if (words.some((w) => low.includes(w))) return { kind, kind_want: raw };
  }
  return { kind: 'other', kind_want: raw };
}

/**
 * 功能：把模型给的时刻**尽量**认成 `YYYY-MM-DD HH:MM`；认不出来回**空串**。
 *
 * 说明：⭐⭐ **⛔ 绝不猜一个时间**：猜错的出发时刻会**连带算错三档提醒**
 *
 * @param {*} s - 原始串
 */
function normWhen(s, today) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(v);
  if (m) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59) return '';
    return `${m[1]}-${pad2(m[2])}-${pad2(m[3])} ${pad2(m[4])}:${m[5]}`;
  }
  m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?\s*(\d{1,2})[:：点](\d{1,2})?/.exec(v);
  if (m) {
    const y = m[1] || String(today || '').slice(0, 4) || String(new Date().getFullYear());
    const hh = Number(m[4]);
    const mi = m[5] === undefined ? 0 : Number(m[5]);
    if (hh > 23 || mi > 59) return '';
    return `${y}-${pad2(m[2])}-${pad2(m[3])} ${pad2(hh)}:${pad2(mi)}`;
  }
  return '';
}

/**
 * 功能：`trips.propose_create` 的提议构造器 —— ⭐ **只生成提议，⛔ 一个字都不落库**。
 *
 * 说明：⭐ 服务端在本机做两件事（照记账「名字由服务端解析」的既有做法）：
 * ① `kind` 归一化（见 `normTripKind`）；② `depart` / `arrive` 归一化（见 `normWhen`）。
 * **认不出来的那几条标 `bad: true` ＋ 一句人话**，卡上会显示出来 ——
 */
function proposeTrips(ctx, args, today) {
  const src = args && typeof args === 'object' ? args : {};
  const list = Array.isArray(src.tickets) ? src.tickets : [];
  if (!list.length) throw httpError(400, '没有整理出任何车票');
  if (list.length > PROPOSE_TRIP_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_TRIP_MAX} 张车票（这次给了 ${list.length} 张），请分批再来`);
  }
  const items = list.map((raw) => {
    const t = raw && typeof raw === 'object' ? raw : {};
    const kw = normTripKind(t.kind);
    const from = String(t.from == null ? '' : t.from).trim().slice(0, 60);
    const to = String(t.to == null ? '' : t.to).trim().slice(0, 60);
    const depart = normWhen(t.depart, today);
    const why = [];
    if (!depart) why.push('出发时刻没看懂（要像 2026-09-30 08:00 这样的）');
    if (!from) why.push('缺出发站');
    if (!to) why.push('缺到达站');
    return {
      kind: kw.kind,
      kind_want: kw.kind_want,
      code: String(t.code == null ? '' : t.code).trim().slice(0, 60),
      from,
      to,
      depart,
      arrive: normWhen(t.arrive, today),
      seat: String(t.seat == null ? '' : t.seat).trim().slice(0, 60),
      gate: String(t.gate == null ? '' : t.gate).trim().slice(0, 60),
      note: String(t.note == null ? '' : t.note).trim().slice(0, ENTRY_NOTE_MAX),
      bad: why.length > 0,
      why: why.join('；'),
    };
  });
  return { kind: 'trip', items };
}

/**
 * 随手记正文的长度上限（**与 `core/validate.js` 的 `MAX_LONG_TEXT` 同值**，也等于手机 / 电脑
 * @type {number}
 */
const IDEA_TEXT_MAX = 20000;

/** 记账备注的长度上限（与前端那个输入框同水位；⛔ 静默截断的是模型给的字，不是用户的输入） @type {number} */
const ENTRY_NOTE_MAX = 100;

/** 功能：把任意值收成 0/1（四象限列只认数字，传布尔会被后端的校验函数挡成 400）。 @param {*} v - 任意值 @returns {number} 0 / 1 */
function bit(v) {
  return v ? 1 : 0;
}

/**
 * 功能：写工具 `tasks.propose_create` —— 把模型给的任务清单**归一成提议**（⛔ 不落库）。
 *
 * 归属必须真是这个账号自己的项目（拿 `listProjects` 核）。任何一条不合格 ⇒ **400 且不静默**，
 * 归属只认两种：`daily`（日常任务）或**自己的**项目 id —— 归属是别人的项目时
 * 这里就挡住，⛔ 不留到落库那一刻才报错（那时用户已经在卡片上改过了，白改）。
 */
function proposeCreate(ctx, args) {
  const src = args && typeof args === 'object' ? args : {};
  if (!Array.isArray(src.tasks)) throw httpError(400, '要提议的任务必须是一个列表');
  if (!src.tasks.length) throw httpError(400, '这个提议里一条任务都没有');
  if (src.tasks.length > PROPOSE_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_MAX} 条任务（这次给了 ${src.tasks.length} 条），请分批再来`);
  }
  const own = new Set(ctx.store.listProjects(ctx.uid).map((p) => String(Number(p.id))));
  const items = [];
  for (const raw of src.tasks) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const title = String(it.title == null ? '' : it.title)
      .trim()
      .slice(0, 100);
    if (!title) throw httpError(400, '每一条提议都要有标题');
    let scope = 'daily';
    const want = it.project_id != null && it.project_id !== '' ? it.project_id : it.scope;
    if (want != null && want !== '' && String(want) !== 'daily') {
      const id = String(Number(want));
      if (!own.has(id)) throw httpError(400, '提议里有一条的归属不是你的项目');
      scope = id;
    }
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(it.due == null ? '' : it.due)) ? String(it.due) : '';
    // 「帮我建个每天背单词的打卡」只能变成一条普通任务，用户还得自己再改一遍类型）。
    // 认不出来的 kind 一律回落 plain（与 `modules/tasks/lib/tasks.js` 的整形同一条兜底）；
    // 只有 cycle 才带规则，且规则**必填** —— 周期任务没有规则等于一条永远不结束的普通任务，
    const kindWant = String(it.kind == null ? '' : it.kind).trim();
    const kind = ['plain', 'window', 'cycle'].includes(kindWant) ? kindWant : 'plain';
    const rule = kind === 'cycle' ? normRule(it.rule) : '';
    // 字段名叫 `task_kind` 而**不是** `kind`：提议产物顶层那格 `kind` 已经被
    // **模块名**占用（`routes.js` 的 `proposals.push({ ...it, kind: r.proposal.kind })`
    // 会把它盖成 `'tasks'`）—— 叫 `kind` 的话任务类型会在 done 帧里被静默吃掉，
    items.push({ title, scope, due, important: bit(it.important), urgent: bit(it.urgent), task_kind: kind, rule });
  }
  return { kind: 'tasks', items };
}

//
// 本段只做两件事：① 把模型给的自然语言归一成一条**干净的账目草稿**；
// ② 把「用户说的分类名 / 账户名」在**本机**解析成 id。⛔ **不新建分类、⛔ 不新建账户、⛔ 不落库**

/**
 * 功能：把名字归一成**比较用**的形态（去掉空白、统一几种连字符、转小写）。
 *
 * 说明：⚠️ 只用于**比较**，⛔ 绝不改变落库的名字（落库用的永远是库里那一行的名字）。
 * 空白包含全角空格（`\\s` 在 JS 里本来就覆盖它，⛔ 别另写一个全角空格字面量 ——
 * eslint 的 `no-irregular-whitespace` 会当场报错）。
 */
function normName(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[—–－]/g, '-')
    .toLowerCase();
}

/**
 * 功能：把「元」收成**整数分** —— 认不出返回 `null`（⛔ 不兜成 0）。
 *
 * 说明：⚠️⭐ 先挡空值再转数字：`Number(null)` 是 0、`Number('')` 也是 0 ——
 * 认 `¥` / `￥` 与千分位逗号（模型很爱带），其余一律不认。
 * @param {*} v - 模型给的金额值
 */
function yuanToFen(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .replace(/[¥￥,]/g, '')
    .replace(/\s+/g, '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/**
 * 功能：一个分类行属于**哪一侧**（`支出` / `收入`）—— 二级继承父。
 *
 * 说明：⚠️ 二级分类自己的 `ie` 是空（`null`，见 `ledger/schema.js`）⇒ 必须往上看父。
 * 父取不到（数据脏 / 父已硬删）时回空串：调用方据此**不把它当作某一侧**（宁可匹配不上，
 * 也不要把一笔支出记到收入分类里）。
 */
function sideOf(c, byId) {
  const own = String((c && c.ie) || '');
  if (own) return own;
  const p = c && c.parent_id != null ? byId.get(Number(c.parent_id)) : null;
  return p ? String(p.ie || '') : '';
}

/** 功能：分类全称（一级 = 名字；二级 = `父名-名`）。 @param {Object} c - 分类行 @param {Map.<number, Object>} byId - 分类 id → 行 @returns {string} 全称 */
function fullOf(c, byId) {
  const p = c && c.parent_id != null ? byId.get(Number(c.parent_id)) : null;
  return p ? `${String(p.name || '')}-${String((c && c.name) || '')}` : String((c && c.name) || '');
}

/**
 *
 * **只看同一收支侧**（支出 / 收入）—— 「其它」两侧各有一条，不分侧就会把支出记到收入分类上；
 */
function findCategoryOf(rows, want, ie) {
  const key = normName(want);
  if (!key) return { cat: null, why: '' };
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map(list.map((c) => [Number(c.id), c]));
  // 已归档的不参与；父已归档的二级也不参与（表单里它同样选不到）
  const live = list.filter((c) => {
    if (!c || c.archived) return false;
    const p = c.parent_id != null ? byId.get(Number(c.parent_id)) : null;
    return !(p && p.archived);
  });
  const side = String(ie || '');
  const pool = side ? live.filter((c) => sideOf(c, byId) === side) : live;
  const fullHit = pool.filter((c) => normName(fullOf(c, byId)) === key);
  if (fullHit.length === 1) return { cat: fullHit[0], why: '' };
  const leafHits = new Map(pool.filter((c) => normName(c.name) === key).map((c) => [Number(c.id), c]));
  if (leafHits.size === 1) return { cat: [...leafHits.values()][0], why: '' };
  if (leafHits.size > 1) {
    const names = [...leafHits.values()].map((c) => `「${fullOf(c, byId)}」`).join('、');
    return { cat: null, why: `「${want}」在本机有多个分类（${names}），请用「一级-二级」全称` };
  }
  // 名字在**另一侧**存在 ⇒ 说清是方向不对（比「没有这个分类」有用得多）
  const other = live.find((c) => normName(fullOf(c, byId)) === key || normName(c.name) === key);
  if (other) {
    return { cat: null, why: `本机的「${want}」是${sideOf(other, byId) || '另一侧'}的分类，与这笔${ie}对不上` };
  }
  return { cat: null, why: '' };
}

/**
 * 功能：在**本机账户表**里按名字找一条（精确、不分大小写）—— 找不到返回 `null`。
 * @param {Array.<Object>} rows - `store.ledgerAccounts()` 的产物
 * @param {*} want - 模型说的账户名
 * @returns {?Object} 命中的账户行；没命中为 null
 */
function findAccountOf(rows, want) {
  const key = normName(want);
  if (!key) return null;
  return (Array.isArray(rows) ? rows : []).find((a) => normName(a && a.name) === key) || null;
}

/**
 * 功能：按记账表单的**同一条取值顺序**挑账户 —— 类别默认 → 该分类的父级默认 → 全局默认（按收支）→ 空账户。
 *
 * 这里给出的是**用户自己在记账设置里设的那个默认账户**（而不是「不关联」）。
 * 多认一层「父级默认」：AI 通常给到二级分类，而用户可能把默认账户设在**一级**上
 * （表单里选二级时不会回退，这里刻意回退一次 —— 两处口径的差异是有意的）：
 */
function pickDefaultAccountOf(p) {
  const o = p || {};
  const rows = Array.isArray(o.defaults && o.defaults.categories) ? o.defaults.categories : [];
  const cid = o.cat ? Number(o.cat.id) : 0;
  const pid = o.cat && o.cat.parent_id != null ? Number(o.cat.parent_id) : 0;
  const hit =
    rows.find((x) => Number(x.category_id) === cid && x.account_id != null) ||
    (pid ? rows.find((x) => Number(x.category_id) === pid && x.account_id != null) : null);
  const gid = o.ie === '收入' ? o.defaults && o.defaults.income : o.defaults && o.defaults.expense;
  const id = hit ? Number(hit.account_id) : gid != null ? Number(gid) : null;
  if (id == null) return { id: null, name: '', isDefault: true };
  const nameOf = new Map((Array.isArray(o.names) ? o.names : []).map((n) => [Number(n.id), n]));
  const n = nameOf.get(id);
  return {
    id,
    name: n ? (Number(n.special) === 1 ? '空账户' : String(n.name || '')) : '',
    isDefault: true,
  };
}

/**
 * 功能：把备注收成有上限的干净文本（这是**归一化模型输出**，不是校验用户输入 —— 截断没问题）。
 * @param {*} v - 任意值
 * @returns {string} trim 并按码点截断后的文本
 */
function capNote(v) {
  return [...String(v == null ? '' : v).trim()].slice(0, ENTRY_NOTE_MAX).join('');
}

/**
 * 功能：写工具 `ledger.propose_entry` —— 把模型给的账目清单**归一成提议**（⛔ 不落库）。
 *
 * 而不是「他提议了一笔非法的」）。
 * 日期：给了合法 `YYYY-MM-DD` 就用那一天的 **12:00:00**（记账的 `at` 带时刻，
 * 而模型只知道「哪一天」）；没给就用**服务端此刻**（`ctx.now`）—— 猜测一律以服务端时钟为准。
 */
function proposeEntry(ctx, args, today) {
  const src = args && typeof args === 'object' ? args : {};
  if (!Array.isArray(src.entries)) throw httpError(400, '要提议的账目必须是一个列表');
  if (!src.entries.length) throw httpError(400, '这个提议里一笔账都没有');
  if (src.entries.length > PROPOSE_ENTRY_MAX) {
    throw httpError(
      400,
      `一次最多提议 ${PROPOSE_ENTRY_MAX} 笔账（这次给了 ${src.entries.length} 笔），请分批再来`,
    );
  }
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const nowTime = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const cats = ctx.store.ledgerCategories(ctx.uid) || [];
  const byId = new Map(cats.map((c) => [Number(c.id), c]));
  const accts = ctx.store.ledgerAccounts(ctx.uid) || [];
  const names = ctx.store.ledgerAccountNames(ctx.uid) || [];
  const defaults = ctx.store.ledgerDefaults(ctx.uid) || {};
  const items = [];
  for (const raw of src.entries) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const fen = yuanToFen(it.amount);
    if (fen == null) throw httpError(400, '每一笔账都要有金额（单位元，例如 35 或 35.5）');
    if (fen <= 0) throw httpError(400, '每一笔账的金额要大于 0');
    const ie = String(it.ie == null ? '' : it.ie).trim() === '收入' ? '收入' : '支出';
    const date = String(it.at == null ? '' : it.at).trim();
    const at = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} 12:00:00` : `${String(today || '')} ${nowTime}`;
    // 一级 + 二级分别收 —— 拼成全称再解析（二级**允许重名**，只有全称能唯一定位）
    const parentWant = String(it.category == null ? '' : it.category).trim();
    const subWant = String(it.subcategory == null ? '' : it.subcategory).trim();
    const want = subWant ? `${parentWant}-${subWant}` : parentWant;
    const accountWantRaw = String(it.account == null ? '' : it.account).trim();
    const hitCat = findCategoryOf(cats, want, ie);
    const c = hitCat.cat;
    const a = findAccountOf(accts, accountWantRaw);
    const acc = a
      ? { id: Number(a.id), name: String(a.name || ''), isDefault: false }
      : pickDefaultAccountOf({ names, defaults, cat: c, ie });
    const why = hitCat.why;
    items.push({
      at,
      ie,
      amount_fen: fen,
      // 卡上直接显示的那一份（⛔ 不让前端自己除 100 —— 前端不算钱）
      amount: (fen / 100).toFixed(2),
      category_id: c ? Number(c.id) : null,
      // 卡上要显示**真实存在的那一行**的名字：二级带上一级（`餐饮 / 其它`），一级就只显示自己
      category_name: c ? String(c.name || '') : '',
      category_parent: c && c.parent_id != null ? String(((byId.get(Number(c.parent_id)) || {}).name) || '') : '',
      category_full: c ? fullOf(c, byId) : '',
      // 没解析到时把模型的原话带回去（卡上写「AI 说的『餐饮/其他』本机没有」）—— 空串 = 解析到了 / 没说
      category_want: c ? '' : want.slice(0, 40),
      category_why: c ? '' : why,
      // 账户**永远是一个真账户**：没点名 ⇒ 默认账户；连默认都没有 ⇒ 空账户（`id` 为 null 时落库会兜到它）
      account_id: acc.id,
      account_name: acc.name,
      account_default: !!acc.isDefault,
      account_want: a || !accountWantRaw ? '' : accountWantRaw.slice(0, 30),
      note: capNote(it.note),
    });
  }
  return { kind: 'ledger', items };
}

//
// 与上面两条**同一条规矩**：只把模型给的东西归一成**草稿**，⛔ 一条都不落库 ——
// 落库是用户点确认之后、由前端 `core/<模块>-create.js` 逐条走 REST 完成的。

/**
 * 功能：把一段自由文本收成**单行**干净串（去首尾空白、把换行压成空格、限长）。
 *
 * 说明：⚠️ 这是**归一化模型输出**（截断没问题），不是校验用户输入。
 * @param {*} v - 任意值
 * @param {number} max - 码点上限
 */
function capLine(v, max) {
  return [...String(v == null ? '' : v).replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/**
 * 功能：把任意值收成非负数字（认 `¥` / `￥` 与千分位逗号）；认不出返回 `null`（⛔ 不兜成 0）。
 *
 * 说明：⚠️ 先挡空值再转数字 —— `Number(null)` 与 `Number('')` 都是 0，
 * 直接转会把「没填价格」静默变成「花了 0 元」。
 * @param {*} v - 任意值
 */
function numOrNull(v) {
  const s = String(v == null ? '' : v)
    .replace(/[¥￥,]/g, '')
    .replace(/\s+/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/**
 * 功能：写工具 `bookmarks.propose_create` —— 把模型给的收藏清单**归一成提议**（⛔ 不落库）。
 *
 * 说明：⭐ 服务端**二次校验**：`url` 必填，且必须能被 `new URL()` 解析成**绝对地址**
 * （与 `validate.checkBookmark` 同一条要求）—— 提前在这里挡住，用户才不会点了确认才吃 400。
 * 顺带**标出重复**：库里已经有同一条 URL 的打 `dup: true`，卡上直接写「已经收藏过了」。
 */
function proposeBookmarks(ctx, args) {
  const src = args && typeof args === 'object' ? args : {};
  const list = src.bookmarks != null ? src.bookmarks : src.items;
  if (!Array.isArray(list)) throw httpError(400, '要提议的收藏必须是一个列表');
  if (!list.length) throw httpError(400, '这个提议里一条收藏都没有');
  if (list.length > PROPOSE_BM_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_BM_MAX} 条收藏（这次给了 ${list.length} 条），请分批再来`);
  }
  // 库里已经有哪些网址 —— 只为**标重复**（`listBookmarks` 是纯只读的，不写任何表）
  const existed = new Set(
    ((ctx.store.listBookmarks(ctx.uid, '', null) || {}).items || []).map((b) => String((b && b.url) || '')),
  );
  const items = [];
  for (const raw of list) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const url = String(it.url == null ? '' : it.url).trim();
    if (!url) throw httpError(400, '每一条提议都要有网址');
    let ok = true;
    try {
      new URL(url);
    } catch (_e) {
      ok = false;
    }
    if (!ok) throw httpError(400, '每一条提议的网址都要写全（含 https:// ，能被浏览器直接打开）');
    items.push({
      url,
      title: capLine(it.title, 200),
      tags: (Array.isArray(it.tags) ? it.tags : [])
        .map((t) => capLine(t, 50))
        .filter(Boolean)
        .slice(0, 10),
      dup: existed.has(url),
    });
  }
  return { kind: 'bookmarks', items };
}

/**
 * 功能：写工具 `idea.propose_create` —— 把模型给的随手记清单归一成提议（⛔ 不落库）。
 *
 * @param {{store: Object, uid: number}} ctx - 执行上下文
 * @param {{notes: Array.<Object>}} args - 归一后的入参
 * @returns {{kind: string, items: Array.<Object>}} 提议（`{content, tag}`）
 */
function proposeIdeas(ctx, args) {
  const src = args && typeof args === 'object' ? args : {};
  const list = src.notes != null ? src.notes : src.items;
  if (!Array.isArray(list)) throw httpError(400, '要提议的随手记必须是一个列表');
  if (!list.length) throw httpError(400, '这个提议里一条都没有');
  if (list.length > PROPOSE_IDEA_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_IDEA_MAX} 条（这次给了 ${list.length} 条），请分批再来`);
  }
  const items = [];
  for (const raw of list) {
    const it = raw && typeof raw === 'object' ? raw : {};
    // 正文是**多行自由文本**：⛔ 不压换行（那是用户自己的排版，模型给的换行也留着），
    // 只去首尾空白 + 限长（`trim()` 不该动行内的东西）。
    const content = [...String(it.content == null ? '' : it.content).trim()].slice(0, IDEA_TEXT_MAX).join('');
    if (!content) throw httpError(400, '每一条提议都要有正文');
    items.push({ content, tag: capLine(it.tag, 50) });
  }
  return { kind: 'idea', items };
}

/**
 * 功能：写工具 `hardware.propose_create` —— 把模型给的硬件清单归一成提议（⛔ 不落库）。
 *
 * 说明：⚠️⭐ 只收**模型说得出来的那几样**：名称 / 分类 / 状态 / 品牌型号 / 容量 / 用途 /
 * 购买日期 / 价格 / 预期寿命。**序列号 / 位置 / 盘位 / 愿望链接 / 详细内容一律不收**
 * —— 前几样是这台机器的身份信息（而且模型无从知道），后两样是用户自己写的东西。
 */
function proposeHardware(ctx, args) {
  const src = args && typeof args === 'object' ? args : {};
  const list = src.hardware != null ? src.hardware : src.items;
  if (!Array.isArray(list)) throw httpError(400, '要提议的硬件必须是一个列表');
  if (!list.length) throw httpError(400, '这个提议里一件都没有');
  if (list.length > PROPOSE_HW_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_HW_MAX} 件（这次给了 ${list.length} 件），请分批再来`);
  }
  const items = [];
  for (const raw of list) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const name = capLine(it.name, 100);
    if (!name) throw httpError(400, '每一件提议都要有名称');
    const date = String(it.purchase_date == null ? '' : it.purchase_date).trim();
    const price = numOrNull(it.purchase_price);
    const life = numOrNull(it.expected_life_months);
    items.push({
      name,
      category: capLine(it.category, 50),
      // 不认识的状态**按「在用」算**（与表单里那个下拉的默认值同一条口径）
      status: ['owned', 'wishlist', 'retired'].includes(String(it.status || '')) ? String(it.status) : 'owned',
      brand: capLine(it.brand, 50),
      model: capLine(it.model, 100),
      capacity: capLine(it.capacity, 50),
      purpose: capLine(it.purpose, 100),
      purchase_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      purchase_price: price == null ? '' : String(price),
      expected_life_months: life != null && life > 0 ? String(Math.round(life)) : '',
    });
  }
  return { kind: 'digital', items };
}

/**
 * 功能：把模型给的**周期规则**归一成服务端认的那一个 JSON 串；认不出来抛 400（⛔ 绝不猜）。
 *
 * 说明：⚠️⭐ 服务端的 `recur_rule` **不是** RRULE 串（`FREQ=DAILY`），而是
 * `{freq:'daily'}` / `{freq:'weekly',slots:[[1,1],[3,3]]}` / `{freq:'monthly',slots:[[1,9]]}`
 * 这套**规范化 JSON**（唯一出处在 `core/validate.js` 的 `checkRecurRule()`，
 */
function normRule(raw) {
  if (raw === undefined || raw === null || raw === '') throw httpError(400, '周期任务必须带一条循环规则');
  let o = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) throw httpError(400, '周期任务必须带一条循环规则');
    try {
      o = JSON.parse(s);
    } catch (_e) {
      // 人话 / iCal 写法：**只认「每天」**（它不需要 slots，语义唯一）。
      // 「每周 / 每月」必须带 slots（每一期是哪几天）—— 那句话在 iCal 串里表达不出来，
      // 硬猜一个「每周一」就是替用户改了规则，故一律回 400 让他重说。
      const low = s.toLowerCase();
      if (low.includes('daily') || s.includes('每天') || s.includes('每日')) return JSON.stringify({ freq: 'daily' });
      throw httpError(
        400,
        '循环规则没看懂 —— 要写成 {"freq":"daily"}，或 {"freq":"weekly","slots":[[1,1],[3,3]]}' +
          '（1 = 周一，每一期是 [起,止]）',
      );
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw httpError(400, '循环规则的格式不正确');
  const freq = String(o.freq == null ? '' : o.freq).trim();
  if (!['daily', 'weekly', 'monthly'].includes(freq)) throw httpError(400, '循环规则只能是「每天 / 每周 / 每月」');
  if (freq === 'daily') return JSON.stringify({ freq: 'daily' });
  const slots = Array.isArray(o.slots) ? o.slots : [];
  if (!slots.length) throw httpError(400, `「${freq}」的周期规则必须带 slots（每一期一个 [起,止]）`);
  // 只做形状检查（不重排、不并期）—— 规范化仍是服务端 `checkRecurRule()` 的事，
  // 这里再排一遍就是第二份真值。
  const clean = slots.map((s) => {
    const a = Array.isArray(s) ? s : [];
    const st = Number(a[0]);
    const en = a.length > 1 ? Number(a[1]) : st;
    if (!Number.isInteger(st) || !Number.isInteger(en)) throw httpError(400, 'slots 里每一项都要是 [起,止] 两个整数');
    return [st, en];
  });
  return JSON.stringify({ freq, slots: clean });
}

/**
 * 功能：把模型给的时刻认成 `HH:MM`；认不出来回**空串**（⛔ 绝不猜一个时刻）。
 *
 * 说明：认三种写法：`09:00` / `9:00` / `9点` / `9点30`；`24:00` 与 `09:60` 一律认不出来。
 * 只给时刻、不给日期 —— 日期由 `date` 那一格单独管（两件事分开判，错哪格说哪格）。
 * @param {*} s - 原始串
 */
function normClock(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return '';
  let m = /^(\d{1,2})[:：](\d{2})$/.exec(v);
  if (m) {
    const hh = Number(m[1]);
    const mi = Number(m[2]);
    if (hh > 23 || mi > 59) return '';
    return `${pad2(hh)}:${m[2]}`;
  }
  m = /^(\d{1,2})\s*[点時时]\s*(\d{1,2})?\s*分?$/.exec(v);
  if (m) {
    const hh = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (hh > 23 || mi > 59) return '';
    return `${pad2(hh)}:${pad2(mi)}`;
  }
  return '';
}

/**
 * 功能：`assets.propose_item` 的提议构造器 —— ⭐ **只生成提议，⛔ 一个字都不落库**。
 *
 * 说明：⭐ 分组名由**服务端本机解析**成 id（与记账「分类 / 账户名由服务端解析」同一条做法）：
 * 模型只知道用户嘴里的「我的设备」「房产」，不知道分组 id。
 * **本机找不到的分组名不会替你新建**（与记账那条 `⛔ 不新建分类账户` 同一条红线）：
 */
function proposeAssets(ctx, args) {
  const src = args && typeof args === 'object' ? args : {};
  const list = src.items != null ? src.items : src.assets;
  if (!Array.isArray(list)) throw httpError(400, '要提议的资产必须是一个列表');
  if (!list.length) throw httpError(400, '这个提议里一条都没有');
  if (list.length > PROPOSE_ASSET_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_ASSET_MAX} 条（这次给了 ${list.length} 条），请分批再来`);
  }
  const tree = ctx.store.listAssetGroups(ctx.uid) || {};
  const groups = Array.isArray(tree.groups) ? tree.groups : [];
  const byName = new Map(groups.map((g) => [String(g.name || ''), Number(g.id)]));

  const items = list.map((raw) => {
    const it = raw && typeof raw === 'object' ? raw : {};
    const name = capLine(it.name, 100);
    const wantGroup = capLine(it.group, 50);
    const gid = wantGroup && byName.has(wantGroup) ? byName.get(wantGroup) : null;
    const date = String(it.date == null ? '' : it.date).trim();
    const yuan = numOrNull(it.amount);
    const why = [];
    if (!name) why.push('缺名称');
    if (wantGroup && gid === null) why.push(`本机没有「${wantGroup}」这个分组`);
    return {
      name,
      group_id: gid,
      group_name: gid === null ? '' : wantGroup,
      group_want: wantGroup,
      // 元 → 分（四舍五入到整数分）；没给金额 ⇒ null（「没记金额」与「0 元」不是一回事）
      amount_fen: yuan == null ? null : Math.round(yuan * 100),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      bad: why.length > 0,
      why: why.join('；'),
    };
  });
  if (!items.some((it) => it.name)) throw httpError(400, '每一条提议都要有名称');
  return { kind: 'assets', items };
}

/**
 * 功能：`calendar.propose_event` 的提议构造器 —— ⭐ **只生成提议，⛔ 一个字都不落库**。
 *
 * 说明：⚠️⭐ **时刻不猜**（与车票那条同一条纪律）：`HH:MM` 认不出来就留空并标 `bad`，
 * 让用户在卡上自己改 —— 猜错一个时间就是把日程排到别的日子上，比不给更糟。
 * `all_day` 交出去是**布尔**（`POST /api/calendar` 的 `checkCalendarEvent` 只认布尔，
 */
function proposeEvents(ctx, args) {
  const src = args && typeof args === 'object' ? args : {};
  const list = src.events != null ? src.events : src.items;
  if (!Array.isArray(list)) throw httpError(400, '要提议的日程必须是一个列表');
  if (!list.length) throw httpError(400, '这个提议里一条都没有');
  if (list.length > PROPOSE_EVENT_MAX) {
    throw httpError(400, `一次最多提议 ${PROPOSE_EVENT_MAX} 条日程（这次给了 ${list.length} 条），请分批再来`);
  }
  const items = list.map((raw) => {
    const it = raw && typeof raw === 'object' ? raw : {};
    const title = capLine(it.title, 100);
    const date = String(it.date == null ? '' : it.date).trim();
    const endDate = String(it.end_date == null ? '' : it.end_date).trim();
    const allDay = it.all_day === true || String(it.all_day) === 'true';
    const start = normClock(it.start);
    const end = normClock(it.end);
    const why = [];
    if (!title) why.push('缺标题');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) why.push('开始日期没看懂（要 2026-09-30 这样的）');
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) why.push('结束日期没看懂');
    if (!allDay && !start) why.push('开始时刻没看懂（要 09:00 这样的）');
    return {
      title,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      end_date: /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : '',
      all_day: allDay,
      // 全天 ⇒ 两个时刻都清空（接口层会拦「全天却带时刻」）
      start_time: allDay ? '' : start,
      end_time: allDay ? '' : end,
      bad: why.length > 0,
      why: why.join('；'),
    };
  });
  if (!items.some((it) => it.title)) throw httpError(400, '每一条提议都要有标题');
  return { kind: 'calendar', items };
}

/**
 * 写工具的**执行表**：`need` 是「跑它必须先有的 Store 方法」，`run` 是提议构造器。
 * @type {Object.<string, {need: Array.<string>, run: Function}>}
 */
const PROPOSE_EXEC = {
  // 只需要「列项目」—— 用来核归属是不是自己的（不写任何表）
  'tasks.propose_create': { need: ['listProjects'], run: (ctx, args) => proposeCreate(ctx, args) },
  // 记账要「列分类」「列账户」「默认账户」「账户名表」四条 —— 都是**只读**，
  // 用来把名字解析成 id、并在模型没点名账户时给出用户设的默认账户（⛔ 不写任何表）
  'ledger.propose_entry': {
    need: ['ledgerCategories', 'ledgerAccounts', 'ledgerAccountNames', 'ledgerDefaults'],
    run: (ctx, args, today) => proposeEntry(ctx, args, today),
  },
  // 那三条：只有收藏**要读一次列表**（为了标出「已经收藏过了」）；随手记与硬件
  // 什么都不读 —— `need: []` 表示它不依赖任何模块方法（提议只是把模型给的归一化）。
  'bookmarks.propose_create': { need: ['listBookmarks'], run: (ctx, args) => proposeBookmarks(ctx, args) },
  'idea.propose_create': { need: [], run: (ctx, args) => proposeIdeas(ctx, args) },
  'hardware.propose_create': { need: [], run: (ctx, args) => proposeHardware(ctx, args) },
  // 车票提议**什么都不读**（`need: []`）—— 它只是把模型给的归一化 ＋ 标出认不出来的。
  // 这不是「不需要行程模块」：确认卡落库时走的是 `POST /api/trip/tickets`（前端唯一入口），
  // 行程被整目录删掉时**那一步**会 404 —— 而那是**可见**的（卡上会写「成功 0 张 / 失败 N 张」）。
  'trips.propose_create': { need: [], run: (ctx, args, today) => proposeTrips(ctx, args, today) },
  // 资产要读一次分组树（把名字解成 id）；日程什么都不读。
  'assets.propose_item': { need: ['listAssetGroups'], run: (ctx, args) => proposeAssets(ctx, args) },
  'calendar.propose_event': { need: [], run: (ctx, args) => proposeEvents(ctx, args) },
};

module.exports = {
  WRITE_MODULES,
  PANEL_WRITE,
  WRITE_TOOLS,
  PROPOSE_MAX,
  PROPOSE_ENTRY_MAX,
  PROPOSE_BM_MAX,
  PROPOSE_IDEA_MAX,
  PROPOSE_HW_MAX,
  PROPOSE_TRIP_MAX,
  PROPOSE_EXEC,
};
