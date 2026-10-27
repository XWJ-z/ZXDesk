/**
 * routes/auth.js —— 鉴权 / 会话 / 内置管理员 / 成员管理路由
 *
 * 功能：`handleAuth` 管登录、注册、改密、**改自己的登录名**、退出、会话状态与**个人偏好**（`PUT /api/auth/prefs`，三项）；
 *      `handleAdmin` 管成员列表、增删成员、**改成员登录名**、
 *      重置成员密码、自治注册开关与「数据位置」；`ensureBuiltinAdmin` 负责出厂内置管理员
 *      `admin` / `admin123` 的兜底；`currentUser` 从签名 Cookie 解出当前账号；
 *      `loginThrottle` 是登录失败节流；`validateUsername` / `validateCredentials` 是账号入参校验。
 *
 * ⚠️ 拆自 `server.js`（002 报告 §5.1 ①），**只搬家不改逻辑**；运行期单例从 `../context.js` 取。
 * ⚠️ 越权与「不存在」统一 404（不是 403）—— 403 等于告诉对方「这条记录存在，只是不归你」。
 * ⚠️ **管理面板不显示成员的任务条数**（需求红线：管理员也看不到成员的数据）。
 * ⚠️ 登录失败节流按**「IP + 账号名」**计（并另有一条纯 IP 上限），换用户名绕不过去，
 *    也不能靠打某个名字把别人锁死。
 * ⚠️ 内置管理员**仍在使用初始凭据**时，除改用户名 / 改密码 / 登出 / 取自己信息之外一律拦下
 *    （`mustSetupUser()`，服务端与静态页两处都要拦）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.1
 * 相关：docs/公共/架构文档/04-多用户与账号.md
 */
'use strict';

const { AUTH_SECRET, BUILTIN_ADMIN, logLine, store } = require('../context.js');
// ⭐ 0.8.5：日志文件（目录 / 清单 / 读尾部 / 删账号时清）—— 见 `/api/admin/logs` 那两个分支
const logs = require('../logs.js');
const {
  MIN_PASSWORD_LENGTH,
  clearSessionCookie,
  hashPassword,
  issueSession,
  needsRehash,
  readSession,
  sessionCookie,
  verifyPassword,
} = require('../auth.js');
const { httpError, idParam, json, readBody } = require('../http-util.js');

/**
 * 功能：从 Cookie 携带的会话令牌解析出当前登录账号；任何一项校验不过都返回 null（即未登录）。
 *
 * 说明：以下任一情况都视为**未登录**：
 *   令牌缺失/签名不对/已过期、账号已被删除、账号改过密码（`session_epoch` 变了）。
 * 返回的是 `sanitizeUser` 过的元信息（**不含口令哈希**）。
 *
 * @param {Object} req - HTTP 请求对象（Node `http.IncomingMessage`），只使用 `headers.cookie`
 * @returns {?Object} 已登录时返回当前账号的公开元信息，未登录返回 null
 */
function currentUser(req) {
  const s = readSession(AUTH_SECRET, req.headers.cookie, Date.now());
  if (!s) return null;
  const epoch = store.sessionEpoch(s.uid);
  if (epoch === null || epoch !== s.epoch) return null;
  return store.getUser(s.uid);
}

/**
 * 「这个账号的口令是不是还是公开初始值」的记忆表（uid → { hash, yes }）。
 *
 * ⚠️⭐ 必须有：`verifyPassword` 内部是 **scrypt**（本机实测 ≈250 ms）。而这条判定挂在
 *      **每个已登录请求**上（`server.js` 的闸门之后、`static.js` 的静态页之前），
 *      不缓存就等于给管理员账号的每次点击加四分之一秒、还占满事件循环。
 * 缓存键取 `password_hash` 本身：口令一改散列就变 ⇒ 自动失效，不需要任何手动清理。
 *
 * @type {Map.<number, {hash: string, yes: boolean}>}
 */
const defaultPwCache = new Map();

/**
 * 功能：判断某个账号的口令是否**仍是公开的初始口令**（不看用户名）。
 *
 * 说明：给「首登改密」用的一条例外：账号还在用 `admin123` 时，改密接口允许不填「当前密码」——
 *      那串口令本来就是公开的，多问一次没有任何安全收益，只会让首登多一道坎。
 * ⚠️ 结果按散列记忆（见 `defaultPwCache`），别删 —— 删了就是每请求一次 scrypt。
 *
 * @param {Object} user - `currentUser()` 返回的账号元信息
 * @returns {boolean} 仍在用初始口令返回 true
 */
function usesDefaultPassword(user) {
  if (!user) return false;
  const row = store.findUserById(user.id);
  if (!row || !row.password_hash) return false;
  const hit = defaultPwCache.get(user.id);
  if (hit && hit.hash === row.password_hash) return hit.yes;
  const yes = verifyPassword(BUILTIN_ADMIN.password, row.password_hash);
  defaultPwCache.set(user.id, { hash: row.password_hash, yes });
  return yes;
}

/**
 * 功能：判断某个账号是否**仍在使用公开的初始凭据**（内置管理员的 `admin` / `admin123`）。
 *
 * 说明：⭐ 首登强制的唯一判据 —— 比对散列，不加标志位、不改表结构。好处是老库不用迁移、
 *      重启不丢、整库备份恢复后照样成立，管理员改过用户名或密码后**自动**不命中。
 *      只认「内置管理员仍在使用初始凭据」这一种，普通成员与其它管理员一律不受影响。
 *
 * @param {Object} user - `currentUser()` 返回的账号元信息（不含口令散列）
 * @returns {boolean} 命中时 true（调用方必须拦住它，逼用户先改用户名与密码）
 */
function mustSetupUser(user) {
  if (!user || user.username !== BUILTIN_ADMIN.username) return false;
  return usesDefaultPassword(user);
}

/**
 * 功能：判断本次请求是否走 HTTPS（决定会话 Cookie 要不要带 `Secure`）。
 *
 * 说明：线程内没有 TLS 时 `req.socket.encrypted` 是 undefined；经统一网关（Socket）时它也不是 TLS，
 *      所以再看一眼 `x-forwarded-proto`。两样都不成立就是明文 http（端口入口），不加 `Secure`。
 *
 * @param {Object} req - HTTP 请求对象
 * @returns {boolean} 走了 HTTPS 返回 true
 */
function isSecureReq(req) {
  if (req.socket && req.socket.encrypted === true) return true;
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

/**
 * 功能：读「是否允许自主注册」。
 * @returns {boolean} 只有显式设成 '1' 才允许；缺键、空值、'0' 一律视为**关闭**
 */
function selfRegisterAllowed() {
  return store.getSetting('allow_self_register') === '1';
}

/**
 * 功能：登录失败节流器（内存 Map，按登录名计数）—— 对外只暴露 `check` / `fail` / `reset` 三个方法。
 *
 * 说明：窗口 5 分钟。两个维度同时计：**「来源 IP + 登录名」10 次**（防定向爆破某个账号）、
 * **「来源 IP」30 次**（防换着名字试，且不让攻击者靠打某个名字把别人锁死）。
 * 为什么必须有：登录是**唯一可被匿名反复尝试**的入口，而每次尝试都要跑一遍 scrypt，
 * 而 `scryptSync` 会阻塞事件循环 —— 不设限就等于把「猜密码」变成「打垮服务」。
 * 阈值刻意宽松，避免误伤：正常用户打错几次不会被锁。
 *
 * ⚠️ 计数只在内存里，进程重启即清空（这是刻意的：没有持久化就有没有「重启绕过」之外的副作用）。
 * ⚠️ 取的是 `req.socket.remoteAddress` —— 经网关时它是**本机**，此时真正的来源在
 *    `x-forwarded-for` 里；本项目不让用户配反代头，所以不做猜测（宁可退化成「按网关 IP 计数」）。
 */
const loginThrottle = (() => {
  const WINDOW_MS = 5 * 60 * 1000;
  /** 同一「IP + 登录名」的失败上限 */
  const MAX_FAILS = 10;
  /** 同一 IP（不分登录名）的失败上限 —— 挡住「换着名字试」 */
  const MAX_FAILS_IP = 30;
  const hits = new Map();
  const pairKey = (ip, name) => `${ip || '-'}|${name}`;
  const ipKey = (ip) => `ip:${ip || '-'}`;
  const prune = (now) => {
    for (const [k, v] of hits) if (now - v.at > WINDOW_MS) hits.delete(k);
  };
  const bump = (k, now) => {
    const v = hits.get(k);
    hits.set(k, { n: v && now - v.at <= WINDOW_MS ? v.n + 1 : 1, at: now });
  };
  const blockedFor = (v, now) => {
    if (!v || now - v.at > WINDOW_MS || v.n < 0) return null;
    return Math.max(1, Math.ceil((WINDOW_MS - (now - v.at)) / 60000));
  };
  return {
    /**
     * 功能：检查「这一对来源 IP + 登录名」以及「这个来源 IP」当前是否已被节流。
     * @param {string} name - 登录用户名
     * @param {string} [ip] - 来源地址（`req.socket.remoteAddress`）
     * @returns {?string} 被节流时返回含剩余分钟数的中文提示，否则返回 null
     */
    check(name, ip) {
      const now = Date.now();
      prune(now);
      const byPair = hits.get(pairKey(ip, name));
      if (byPair && byPair.n >= MAX_FAILS) {
        const mins = blockedFor(byPair, now);
        if (mins) return `登录失败次数过多，请约 ${mins} 分钟后再试`;
      }
      const byIp = hits.get(ipKey(ip));
      if (byIp && byIp.n >= MAX_FAILS_IP) {
        const mins = blockedFor(byIp, now);
        if (mins) return `该网络登录失败次数过多，请约 ${mins} 分钟后再试`;
      }
      return null;
    },
    /**
     * 功能：登记一次登录失败（同时累加「IP + 登录名」与「IP」两个计数）。
     * @param {string} name - 登录用户名
     * @param {string} [ip] - 来源地址
     * @returns {void}
     */
    fail(name, ip) {
      const now = Date.now();
      bump(pairKey(ip, name), now);
      bump(ipKey(ip), now);
    },
    /**
     * 功能：清掉这一对「IP + 登录名」的失败计数（登录成功后调用）。
     * @param {string} name - 登录用户名
     * @param {string} [ip] - 来源地址
     * @returns {void}
     */
    reset(name, ip) {
      hits.delete(pairKey(ip, name));
    },
    /**
     * 功能：清掉全部计数（只给测试用，生产代码不许调用）。
     * @returns {void}
     */
    _reset() {
      hits.clear();
    },
  };
})();

/**
 * 功能：注册 / 加成员 / **改名**共用的**用户名**校验（长度与字符集）。
 *
 * 说明：⭐ 0.2.1 从 `validateCredentials` 里拆出来，因为「改登录名」是**唯一一个不需要口令**的账号操作 ——
 *      复用整包校验会逼着改名请求也带上密码（前端得多问一次、后端多一处没意义的比较）。
 *      拆开还有一层好处：用户名规则**只有这一份**，将来放宽/收紧字符集不会出现两套口径。
 *
 * @param {string} username - 待校验的用户名
 * @returns {?string} 不合法时返回可展示的中文错误文案，合法返回 null
 */
function validateUsername(username) {
  if (!username) return '请输入用户名';
  if (username.length > 32) return '用户名过长（最多 32 位）';
  if (!/^[\w\u4e00-\u9fa5.@-]+$/.test(username)) return '用户名只能用中文、字母、数字、下划线、点、@ 或减号';
  return null;
}

/**
 * 功能：注册 / 改密 / 管理员加成员共用的用户名与口令校验。
 * @param {string} username - 待校验的用户名（长度与字符集都有限制）
 * @param {string} password - 待校验的口令（长度受 `MIN_PASSWORD_LENGTH` 与 200 位上限约束）
 * @returns {?string} 不合法时返回可展示的中文错误文案，合法返回 null
 */
function validateCredentials(username, password) {
  const badName = validateUsername(username);
  if (badName) return badName;
  if (String(password).length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (String(password).length > 200) return '密码过长（最多 200 位）';
  return null;
}

/** 一侧导航顺序最多允许几项（防滥用；真实模块总数远小于它） @type {number} */
const NAV_LIST_MAX = 24;
/** 单个模块名最长多少字符（真实模块名都是短的英文目录名） @type {number} */
const NAV_ITEM_MAX = 40;

/**
 * 功能：把 `PUT /api/auth/nav` 收到的一侧顺序值**校验并拼成落库用的字符串**（0.8.5 导航排序）。
 *
 * 说明：⚠️ 这里刻意**只做结构校验**，不做「这个模块名真的存在吗」的白名单 ——
 *      清单是「`app/modules/` 下的目录」决定的（`registry.frontendList()`），前端本来就按清单渲染，
 *      脏名字最坏只是在渲染时被忽略；在这里再维护一份白名单，等于给清单开了第二个真相
 *      （删掉一个模块目录时忘了同步它，用户存的顺序就会被我们自己判成 400）。
 *      ⚠️ 三种取值的语义**必须分清**（见 `schema/core.js` 的 `nav_order` / `nav_tabs`）：
 *      · `null`（显式传 null）⇒ 回 `null` ⇒ 落库 SQL NULL = **恢复默认顺序**；
 *      · 合法数组 ⇒ 回逗号分隔的串；**空数组回空串**（`''`）= 「用户明确排成空的」；
 *      · 其它（不是数组 / 项不是字符串 / 空项 / 超长 / 超项数）⇒ 400。
 *      ⚠️ 重复项按**首次出现**去重：同一个模块排两次会让界面画出两个一样的入口。
 *
 * @param {*} v - 请求体里 `desktop` 或 `mobile` 的值
 * @returns {?string} 落库值（null 或逗号分隔的模块名）
 * @throws {Error} 结构不合法时抛 400
 */
function navList(v) {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > NAV_LIST_MAX) throw httpError(400, 'bad body');
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') throw httpError(400, 'bad body');
    const s = x.trim();
    if (!s || s.length > NAV_ITEM_MAX) throw httpError(400, 'bad body');
    if (!out.includes(s)) out.push(s);
  }
  return out.join(',');
}

// ---- 认证与账号 ----
/**
 * 功能：处理 `/api/auth/*` 全部认证接口 —— 登录页状态查询、自主注册、登录、登出、取当前账号、修改本人密码。
 *
 * 说明：`state` / `register` / `login` 免登录（否则没人能进门），
 * `logout` / `me` / `password` / `username` / `prefs` 要求已登录。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @param {Array.<string>} parts - URL 路径按 `/` 切开后的片段（`parts[1]` 为 'auth'）
 * @param {?Object} user - 当前登录账号，未登录为 null
 * @returns {void}
 */
function handleAuth(req, res, parts, user) {
  const method = req.method;

  // GET /api/auth/state —— 登录页据此决定显示「首次注册」还是「登录」
  if (method === 'GET' && parts[2] === 'state') {
    const hasUsers = store.countUsers() > 0;
    return json(res, 200, {
      hasUsers,
      allowSelfRegister: selfRegisterAllowed(),
      minPasswordLength: MIN_PASSWORD_LENGTH,
      authenticated: !!user,
      mustSetup: !!user && mustSetupUser(user),
      user: user || null,
    });
  }

  // POST /api/auth/register —— ⚠️ 注册出来的**一律是普通成员**
  //    （管理员来自内置账号或管理员的「添加成员」，见 ensureBuiltinAdmin 的说明）
  if (method === 'POST' && parts[2] === 'register') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      const bad = validateCredentials(username, password);
      if (bad) throw httpError(400, bad);

      // 库里**一个账号都没有**时（只读降级导致内置管理员没建成之类的极端情况）也要能进门，
      // 所以这种情况下不受开关限制；否则一律要求自主注册是开着的。
      const emptyLib = store.countUsers() === 0;
      if (!emptyLib && !selfRegisterAllowed()) {
        // ⚠️ 这是「授权结果」不是「输入不合法」：直接 json，不走 fail()（响应体要逐字固定）
        return json(res, 403, { error: '管理员已关闭自主注册，请联系管理员添加账号' });
      }
      const created = store.createUser({
        username,
        passwordHash: hashPassword(password),
        displayName: b.displayName || '',
        isAdmin: false,
      });
      return json(res, 201, { ok: true, user: created });
    });
  }

  // POST /api/auth/login
  if (method === 'POST' && parts[2] === 'login') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const username = String(b.username || '').trim();
      const password = String(b.password || '');

      const ip = (req.socket && req.socket.remoteAddress) || '';
      const limited = loginThrottle.check(username, ip);
      if (limited) return json(res, 429, { error: limited });

      const row = store.findUserByName(username);
      // ⚠️ 用户不存在与密码错误**返回同一句话**，不泄露「该用户名是否存在」
      if (!row || !verifyPassword(password, row.password_hash)) {
        loginThrottle.fail(username, ip);
        // ⚠️ 不写用户名字面值：用户可能把口令误粘到用户名框，写进去就是明文入日志
        logLine('warn', `登录失败: 用户名长度 ${username.length}，来源 ${ip || '未知'}`);
        return json(res, 401, { error: '用户名或密码不正确' });
      }
      loginThrottle.reset(username, ip);

      // ⭐ 首登强制：内置管理员仍在使用公开初始凭据 ⇒ 告诉前端去 /setup.html
      const mustSetup =
        row.username === BUILTIN_ADMIN.username && verifyPassword(BUILTIN_ADMIN.password, row.password_hash);

      // 成本参数升级：老散列在登录成功时静默重算（不会让老账号失效）。
      // 走 setPasswordHash 而非 setPassword —— 后者会递增 session_epoch，把该账号其他设备一并踢下线，
      // 而这里只是换了个等价的散列，不该产生副作用。
      if (needsRehash(row.password_hash)) store.setPasswordHash(row.id, hashPassword(password));
      store.touchLastLogin(row.id);

      const token = issueSession(AUTH_SECRET, row.id, store.sessionEpoch(row.id), Date.now());
      res.setHeader('Set-Cookie', sessionCookie(token, isSecureReq(req)));
      logLine('info', `登录成功: ${row.username}（uid=${row.id}）`);
      return json(res, 200, { ok: true, mustSetup, user: store.getUser(row.id) });
    });
  }

  // ---- 以下需要已登录 ----
  if (!user) return json(res, 401, { error: 'unauthorized' });

  // ⭐ 首登强制（服务端拦截 ①）：仍在使用公开初始凭据时，只放行「改用户名 / 改密码 / 登出 / 取自己信息」。
  //   ⚠️ 只拦接口不够 —— 静态页那一侧还有一道 302（见 `static.js`），两处缺一都会被绕过。
  if (mustSetupUser(user)) {
    const allowed =
      (method === 'POST' && (parts[2] === 'password' || parts[2] === 'logout')) ||
      (method === 'PUT' && parts[2] === 'username') ||
      (method === 'GET' && (parts[2] === 'me' || parts[2] === 'state'));
    if (!allowed) return json(res, 403, { error: 'must_setup' });
  }

  if (method === 'POST' && parts[2] === 'logout') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && parts[2] === 'me') return json(res, 200, user);

  // PUT /api/auth/prefs —— 改**自己**的个人偏好（0.2.1，0.3.0 加收藏夹，0.3.1 加硬件管理，0.3.2 加密码库，0.3.5 加对话，0.6.0 加 AI 辅助任务，0.7.1 加灵感库，0.7.5 加番茄钟与日历，0.8.0 加记账，0.8.6 加行程）
  //   现有十一项：`hideTimetable`（不显示课表）、`hideBookmarks`（不显示网址收藏夹）、
  //   `hideIdea`（不显示灵感库）、`hideHardware`（不显示 NAS硬件管理）、`hidePomodoro`（不显示番茄钟）、
  //   `hideCalendar`（不显示日历）、`hideLedger`（不显示记账）、`hideTrip`（不显示行程）、`hideVault`（不显示密码库）、
  //   `hideTeamwork`（不显示对话）、`hideAi`（不显示 AI 辅助任务）、`hideDigital`（不显示数码管理，0.8.10）。
  //   ⭐ 0.8.21 起**多一项、但类型不同**：`hideLedgerAmount`（记账里那颗眼睛的**初值**，`true` = 进记账就把
  //   金额糊成圆点）。⚠️ 那十一个是「关掉某个功能」（每个来自某个 `module.json` 的 `switchField`），
  //   而它是「金额默认糊不糊」——用户当场仍能点眼睛看回来，只是下次进来还按这个初值。⛔ 别把它
  //   与模块开关混在一起（`module-ui.test.js` 会把「模块派生出来的键」与这里逐项比）。
  //   ⚠️ `hideHardware` 自 0.8.10 起是**退役的键**（模块 hardware 改名 digital）：仍然接受、
  //   仍然写那一列，但界面上已没有任何入口会发它 —— 留着是为了不弄丢老用户残留的偏好。
  //   ⭐ 它们是**每账号各管各的**，所以放在 `/api/auth/*` 下而不是 `/api/admin/settings`
  //   （后者是全局开关，仅管理员可写）。
  //   ⭐ 写法与「入参校验只校验请求里真的带了的字段」一致：**只认请求里真的带了的键**，
  //   一次可以只带一个、也可以几个一起带；一个都不带、或者某个键的类型不是布尔 → 400。
  //   ⚠️ 五个键**各自落到各自的列**：改一个绝不能顺手把另一个也写一遍（那会让「我只想关课表」
  //   悄悄覆盖掉用户在另一台设备上刚打开的收藏夹 / 硬件管理 / 密码库 / 对话）。
  //   ⚠️ 密码库的**自动锁定分钟数**刻意**不放这里**（它是个整数、不是布尔）：
  //   它走 `PUT /api/vault/settings`，并且**要求先解锁** —— 「改自己的锁定时长」应当只有
  //   拿着主密码的人能做，与「关掉一个界面入口」不是一回事。
  if (method === 'PUT' && parts[2] === 'prefs') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      // ⚠️ 这个数组的**顺序要与「模块清单按 order 排出来的顺序」一致**（`module-ui.test.js` 逐项比对）：
      //    它只是用来「过滤出请求里带了哪些键」，顺序不影响行为 —— 但门禁要求两处一致，
      //    免得下次加开关时两边各写一份顺序、谁也说不清哪个对。
      //    ⭐ 0.8.13：课表 / 番茄钟 / 行程并成一个模块 `time`（`order` 20）
      //    ⇒ 它的三个子开关**连在一起**排在这一位；`hideHardware`（0.8.10 起由 `hideDigital` 取代）
      //    与 `hideCalendar`（0.8.7 起 `switchField` 已是 null）**继续收** —— 删键会让老设备
      //    提交时 400，而列也保留着（列保留、语义退役）。
      const keys = [
        'hideTimetable',
        'hidePomodoro',
        'hideTrip',
        'hideBookmarks',
        'hideIdea',
        'hideHardware',
        'hideDigital',
        'hideCalendar',
        'hideLedger',
        'hideVault',
        'hideTeamwork',
        'hideAi',
        // ⭐ 0.8.21（「隐藏要具有记忆功能…并且手机端和电脑端同步」）：**记账里那颗
        //    眼睛的初值**（`true` = 进记账就把金额糊成圆点）。⚠️ 它不是「关掉某个功能」那十一个
        //    模块开关之一（不来自任何 `module.json` 的 `switchField`）⇒ 放在**末尾**：
        //    `module-ui.test.js` 只要求「**共有键的顺序**一致」，排在末尾不扰动那个顺序。
        'hideLedgerAmount',
      ].filter(has);
      if (!keys.length) throw httpError(400, 'bad body');
      for (const k of keys) if (typeof b[k] !== 'boolean') throw httpError(400, 'bad body');
      const said = [];
      if (has('hideTimetable')) {
        store.setHideTimetable(user.id, b.hideTimetable);
        said.push(`${b.hideTimetable ? '关闭' : '打开'}了课表显示`);
      }
      if (has('hideBookmarks')) {
        store.setHideBookmarks(user.id, b.hideBookmarks);
        said.push(`${b.hideBookmarks ? '关闭' : '打开'}了收藏夹显示`);
      }
      if (has('hideHardware')) {
        store.setHideHardware(user.id, b.hideHardware);
        said.push(`${b.hideHardware ? '关闭' : '打开'}了硬件管理显示`);
      }
      // ⭐ 0.8.10：数码管理的开关 —— 模块 `hardware` 改名 `digital` 之后的继任者。
      //    ⚠️ 上面那一支**刻意留着**：老偏好键 `hideHardware` 仍被接受（用户残留的偏好，
      //    留着无害），它改的是退役的那一列 `hide_hardware`，界面上已没有任何入口写它。
      if (has('hideDigital')) {
        store.setHideDigital(user.id, b.hideDigital);
        said.push(`${b.hideDigital ? '关闭' : '打开'}了数码管理显示`);
      }
      if (has('hideVault')) {
        store.setHideVault(user.id, b.hideVault);
        said.push(`${b.hideVault ? '关闭' : '打开'}了密码库显示`);
      }
      if (has('hideTeamwork')) {
        store.setHideTeamwork(user.id, b.hideTeamwork);
        said.push(`${b.hideTeamwork ? '关闭' : '打开'}了对话显示`);
      }
      if (has('hideAi')) {
        store.setHideAi(user.id, b.hideAi);
        said.push(`${b.hideAi ? '关闭' : '打开'}了 AI 辅助任务显示`);
      }
      if (has('hideIdea')) {
        store.setHideIdea(user.id, b.hideIdea);
        said.push(`${b.hideIdea ? '关闭' : '打开'}了灵感库显示`);
      }
      if (has('hidePomodoro')) {
        store.setHidePomodoro(user.id, b.hidePomodoro);
        said.push(`${b.hidePomodoro ? '关闭' : '打开'}了番茄钟显示`);
      }
      if (has('hideCalendar')) {
        store.setHideCalendar(user.id, b.hideCalendar);
        said.push(`${b.hideCalendar ? '关闭' : '打开'}了日历显示`);
      }
      if (has('hideLedger')) {
        store.setHideLedger(user.id, b.hideLedger);
        said.push(`${b.hideLedger ? '关闭' : '打开'}了记账显示`);
      }
      if (has('hideTrip')) {
        store.setHideTrip(user.id, b.hideTrip);
        said.push(`${b.hideTrip ? '关闭' : '打开'}了行程显示`);
      }
      // ⭐ 0.8.21：记账里那颗眼睛的初值（不是「关掉某个功能」，见上面 `keys` 那一段）。
      if (has('hideLedgerAmount')) {
        store.setHideLedgerAmount(user.id, b.hideLedgerAmount);
        said.push(`${b.hideLedgerAmount ? '打开' : '关闭'}了记账的金额隐藏`);
      }
      logLine('info', `账号「${user.username}」${said.join('，')}`);
      return json(res, 200, { ok: true, user: store.getUser(user.id) });
    });
  }

  // PUT /api/auth/nav —— 改**自己**的导航顺序（0.8.5 导航排序：电脑端侧栏拖动 / 手机端底栏定制）
  //   body：`{ desktop?: string[]|null, mobile?: string[]|null }`，两项都可选，但至少带一项。
  //   · `desktop` = **电脑端侧栏**里模块入口的先后（排列；不在里面的模块按清单 `order` 排在其后）；
  //   · `mobile`  = **手机端底部标签栏**放哪几个模块（顺序即标签顺序；最多两个由前端把关，见下）。
  //   ⚠️⭐ 只认请求里**真的带了**的键 —— 与 `PUT /api/auth/prefs` 同一条规矩：
  //      改一个键**绝不许顺手把另一个也写一遍**，否则「我只在手机上挪了一下顺序」
  //      会悄悄把电脑端刚排好的那份覆盖掉（用户会以为是「拖了白拖」）。
  //   ⚠️ 「最多两个模块标签」那条判据**不在服务端**：它是「底栏固定 6 颗」这件界面事实的推论，
  //      住在前端 `core/modules.js`（两端/前后端各写一份就会漂移）。服务端只保证
  //      「存进去的是一个结构合理的字符串」——理由与 `navList()` 上那段一样。
  //   ⚠️ 传 `null` = 恢复默认顺序；传 `[]` = 明确排成空的（手机端合法：一个模块标签都不放）。
  if (method === 'PUT' && parts[2] === 'nav') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      if (!has('desktop') && !has('mobile')) throw httpError(400, 'bad body');
      const said = [];
      if (has('desktop')) {
        store.setNavOrder(user.id, navList(b.desktop));
        said.push('调整了电脑端的模块顺序');
      }
      if (has('mobile')) {
        store.setNavTabs(user.id, navList(b.mobile));
        said.push('调整了手机端的底部标签');
      }
      logLine('info', `账号「${user.username}」${said.join('，')}`);
      return json(res, 200, { ok: true, user: store.getUser(user.id) });
    });
  }

  // PUT /api/auth/username —— 改**自己**的登录名（0.2.1）
  //   ⚠️ 与改密码**恰好相反**：这里**不动 `session_epoch`**，一个设备都不踢 ——
  //      登录名不参与会话校验（Cookie 里是 `uid` + `session_epoch`），改个名字没有理由把人在
  //      其他设备上踢下线；但改完**旧名字立刻登不上**，这正是「改登录名」本身的含义。
  //   ⚠️ 走 `validateUsername` 而不是 `validateCredentials`：改名**不需要口令**
  //      （多问一次密码只是给用户添一道没有意义的门槛）。
  if (method === 'PUT' && parts[2] === 'username') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const username = String(b.username || '').trim();
      const bad = validateUsername(username);
      if (bad) throw httpError(400, bad);
      const updated = store.setUsername(user.id, username);
      // 账号在这一瞬间消失（理论上不可能：本次请求开头刚确认过它在）——按「已掉线」处理，
      // 前端遇到 401 一律跳登录页，正是这种时候该去的地方。
      if (!updated) return json(res, 401, { error: 'unauthorized' });
      logLine('info', `账号「${user.username}」改名为「${updated.username}」（uid=${user.id}）`);
      return json(res, 200, { ok: true, user: updated });
    });
  }

  // POST /api/auth/password —— 改**自己**的密码
  if (method === 'POST' && parts[2] === 'password') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const row = store.findUserByName(user.username);
      const currentOk = !!row && verifyPassword(String(b.current || ''), row.password_hash);
      // ⚠️ 首登例外：账号仍在用公开初始口令时不必填「当前密码」（见 `usesDefaultPassword()`）。
      //    除此之外一律要求校验 —— 这条不能放宽成「有会话就能改密」。
      if (!row || (!currentOk && !usesDefaultPassword(user))) {
        return json(res, 401, { error: '当前密码不正确' });
      }
      const next = String(b.next || '');
      if (next.length < MIN_PASSWORD_LENGTH) throw httpError(400, `新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      if (next.length > 200) throw httpError(400, '新密码过长（最多 200 位）');

      // setPassword 会把 session_epoch +1 → 该账号**所有**旧 Cookie（含本人其他设备）立即失效
      store.setPassword(row.id, hashPassword(next));
      // 但本次会话要续上，否则用户改完密码自己也被登出
      const token = issueSession(AUTH_SECRET, row.id, store.sessionEpoch(row.id), Date.now());
      res.setHeader('Set-Cookie', sessionCookie(token, isSecureReq(req)));
      logLine('info', `账号「${row.username}」修改了自己的密码（其他设备已下线）`);
      return json(res, 200, { ok: true });
    });
  }

  return json(res, 404, { error: 'not found' });
}

// ---- 管理（仅管理员） ----
/**
 * 功能：处理 `/api/admin/*` 全部管理员接口 —— 查看成员、添加成员、删除成员、重置成员密码、
 *      **改成员登录名（含管理员账号自己）**、读「数据位置」运维信息、读写「自主注册」开关；非管理员一律 403。
 *
 * 说明：`/api/admin/*` —— 需求 1 的全部能力：看成员、重置成员密码、开关自主注册、增删成员。
 *
 * ⭐ 架构红线（方案 §六 #2）：这里**只碰 `users` 表与 `settings` 表**。
 *    系统内**不存在**任何「以某成员身份查看其任务」的接口，管理员也看不到成员的任务数据，
 *    连任务条数这类统计都不返回 —— 列表走 `store.listUsers()`，字段由 `sanitizeUser` 白名单决定。
 *
 * ⚠️ 只加普通成员，**不提供「提升为管理员」**（方案 §十五）：本期只有一个管理员，
 *    忘记密码的兜底是离线重置；少一个提权入口就少一类「谁是管理员」的边界情况。
 *
 * @param {Object} req - HTTP 请求对象
 * @param {Object} res - HTTP 响应对象
 * @param {Array.<string>} parts - URL 路径按 `/` 切开后的片段（`parts[1]` 为 'admin'）
 * @param {Object} user - 当前登录账号，调用方已保证非 null；非管理员在此处回 403
 * @returns {void}
 */
function handleAdmin(req, res, parts, user) {
  const method = req.method;

  // 已登录但不是管理员：这里可以明说 403 —— 它不涉及任何人的数据
  if (!user.is_admin) return json(res, 403, { error: '需要管理员权限' });

  // ---- ⭐⭐ 0.8.5：日志 ----
  //   · `GET /api/admin/logs`             —— 日志目录 + 文件清单（「复制路径」与选文件用）
  //   · `GET /api/admin/logs/view/<name>` —— 读某个日志文件的**尾部 200 行**
  // ⚠️ 只给**管理员**（本函数开头已经 403 过了）：`app.log` 里有「账号「x」解锁了密码库」
  //    这类**别账号**的痕迹，`ai-<uid>.log` 更是别人的使用记录 —— 普通成员一律看不到。
  //    （这与「管理员也看不到成员的任务」不冲突：任务数据在这里**依然看不见**，
  //      能看的只有「谁在哪一刻登录/解锁/改了名」这种运维痕迹。）
  // ⚠️⭐ `<name>` 来自 URL，**必须过 `logs.isKnownLog()` 白名单**（`readTail` 内部还会再夹一道）：
  //    不设白名单就是目录穿越。⚠️ 文件名里的 `.` 不是 id，所以这一支**有意不用 `idParam()`**。
  if (method === 'GET' && parts[2] === 'logs' && parts.length === 3) {
    const dir = logs.dirOfStore(store);
    return json(res, 200, { dir, files: logs.listLogs(dir) });
  }
  if (method === 'GET' && parts[2] === 'logs' && parts[3] === 'view' && parts.length === 5) {
    const name = decodeURIComponent(String(parts[4] || ''));
    if (!logs.isKnownLog(name)) return json(res, 404, { error: '没有这个日志文件' });
    const r = logs.readTail(logs.dirOfStore(store), name);
    if (!r) return json(res, 404, { error: '没有这个日志文件' });
    return json(res, 200, r);
  }

  // GET /api/admin/users —— 成员列表（仅账号元信息）
  if (method === 'GET' && parts[2] === 'users' && parts.length === 3) {
    return json(res, 200, { users: store.listUsers(), meId: user.id });
  }

  // POST /api/admin/users —— 添加成员
  if (method === 'POST' && parts[2] === 'users' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      const bad = validateCredentials(username, password);
      if (bad) throw httpError(400, bad);
      const created = store.createUser({
        username,
        passwordHash: hashPassword(password),
        displayName: b.displayName || '',
        isAdmin: false,
      });
      logLine('info', `管理员「${user.username}」添加了成员「${created.username}」`);
      return json(res, 201, created);
    });
  }

  // /api/admin/users/:id 及子路径
  const targetId = idParam(parts[3]);
  if (parts[2] === 'users' && targetId !== null) {
    const target = store.getUser(targetId);
    if (!target) return json(res, 404, { error: '账号不存在' });

    // DELETE /api/admin/users/:id —— 删除成员**及其全部数据**（方案 §十二：二次确认由前端负责）
    if (method === 'DELETE' && parts.length === 4) {
      if (target.id === user.id) throw httpError(400, '不能删除自己的账号');
      if (target.is_admin) throw httpError(400, '不能删除管理员账号');
      store.deleteUser(target.id);
      // ⭐ 0.8.5：连他的 **AI 使用记录文件**一起删 —— 账号都删了、那份痕迹还留在磁盘上，
      //    等于数据没删干净（理由写在 `core/logs.js` 的 `removeAiLog` 上）。
      logs.removeAiLog(logs.dirOfStore(store), target.id);
      logLine('info', `管理员「${user.username}」删除了成员「${target.username}」及其全部数据`);
      return json(res, 200, { ok: true });
    }

    // POST /api/admin/users/:id/password —— 重置成员密码（其在线会话立即失效）
    if (method === 'POST' && parts.length === 5 && parts[4] === 'password') {
      // 管理员改自己的密码要走「修改我的密码」：那条路径会给本人续发 Cookie，
      // 在这里重置会把**自己**踢下线（本接口按设计不给本人续签），是个纯粹的坑。
      if (target.is_admin) throw httpError(400, '管理员自己的密码请在「设置 → 账号设置」里修改');
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const next = String(b.password || '');
        if (next.length < MIN_PASSWORD_LENGTH) throw httpError(400, `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
        if (next.length > 200) throw httpError(400, '密码过长（最多 200 位）');
        // setPassword 递增 session_epoch → 成员的所有旧 Cookie 立即失效
        store.setPassword(target.id, hashPassword(next));
        logLine('info', `管理员「${user.username}」重置了成员「${target.username}」的密码（其在线会话已失效）`);
        return json(res, 200, { ok: true });
      });
    }

    // PUT /api/admin/users/:id/username —— 改成员的登录名（0.2.1）
    //   ⚠️ 与「重置密码」不同，这里**对管理员账号一样放行**：「管理员账号也要能改名」
    //      （内置 `admin` 改成自己的名字就是主要用例）。改名不踢会话、不动口令，没有「把自己登出」那个坑，
    //      所以没有理由像重置密码那样把它挡在门外。
    if (method === 'PUT' && parts.length === 5 && parts[4] === 'username') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const username = String(b.username || '').trim();
        const bad = validateUsername(username);
        if (bad) throw httpError(400, bad);
        const updated = store.setUsername(target.id, username);
        if (!updated) return json(res, 404, { error: '账号不存在' });
        logLine(
          'info',
          `管理员「${user.username}」把账号「${target.username}」（uid=${target.id}）改名为「${updated.username}」`,
        );
        return json(res, 200, updated);
      });
    }
  }

  // /api/admin/storage —— 「数据位置」面板（v5）。
  // 只回答「东西放在哪、有多大、备份几份、外键开没开」，**不碰任何人的任务数据**，
  // 因此与 /api/admin/users 不同，这个接口连统计口径的问题都不涉及（它就是运维信息）。
  if (method === 'GET' && parts[2] === 'storage' && parts.length === 3) {
    return json(res, 200, store.storageInfo());
  }

  // /api/admin/settings —— 目前只有「自主注册」一个开关
  if (parts[2] === 'settings' && parts.length === 3) {
    if (method === 'GET') return json(res, 200, { allowSelfRegister: selfRegisterAllowed() });
    if (method === 'PUT') {
      return readBody(req, res, (b) => {
        if (!b || typeof b.allowSelfRegister !== 'boolean') throw httpError(400, 'bad body');
        store.setSetting('allow_self_register', b.allowSelfRegister ? '1' : '0');
        logLine('info', `管理员「${user.username}」${b.allowSelfRegister ? '打开' : '关闭'}了自主注册`);
        return json(res, 200, { allowSelfRegister: selfRegisterAllowed() });
      });
    }
  }

  return json(res, 404, { error: 'not found' });
}

module.exports = {
  currentUser,
  mustSetupUser,
  selfRegisterAllowed,
  loginThrottle,
  validateUsername,
  validateCredentials,
  handleAuth,
  handleAdmin,
};
