'use strict';
/**
 * modules/vault/store.js —— 密码库业务方法（0.3.2）
 *
 * 功能：密码库的全部业务逻辑，一处收齐 ——
 *      `vaultStatus()`（是否已初始化 / 是否已解锁 / 自动锁定秒数）、
 *      `vaultInit()` / `vaultUnlock()` / `vaultLock()` / `vaultLockAll()`（开库、解锁、上锁）、
 *      `vaultLockMinutes()` / `setVaultLockMinutes()`（每个账号自己的自动锁定偏好）、
 *      `listVaultEntries()` / `getVaultEntry()` / `createVaultEntry()` / `updateVaultEntry()` /
 *      `removeVaultEntry()`（条目的增删改查，加解密都在这里）、`generateVaultPassword()`、
 *      `vaultRenameTag()` / `vaultRemoveTag()`（0.4.4 起：标签的改名与删除）。
 *
 * ⭐ **标签（0.4.4 起）与标题睡在同一个密文里** —— 密文载荷从
 *    `{title,username,password,url,note}` 变成 `{…, tags:[…]}`。
 *    所以本模块**没有任何一行代码需要碰标签的存储**：加解密、备份、导出、导入
 *    （导入不搬密文列，见 `methods/backup.js`）全都自动跟上，库里也没有第二张表
 *    —— 这就是「分类名不落明文」这条承诺在结构上的实现。
 *    ⚠️ 因此**筛选与关键词搜索在前端做**（数据本来就已经整份解密在内存里）：
 *    服务端看不见标签，也就不可能替前端筛。别为了「服务端筛选方便」把标签挪到明文列。
 *    ⚠️ 老条目解出来的对象里**没有 `tags` 键**，`normTags()` 会兜成空数组 —— 零迁移。
 *
 * ⭐ **解锁状态是本模块最敏感的一处**（方案 §4.5），它有四条铁律：
 *   ① **DEK 只活在进程内存里** —— 一个模块级 `Map<uid, {dek, at, timer}>`，
 *      **绝不落盘、绝不进日志、绝不进任何响应体**；
 *   ② **不写 `this.data` / 不写库**：解锁是「这台服务进程记得你刚解锁过」，
 *      不是一条要被备份、被复制、被同步的数据；
 *   ③ **到期就删引用**（`setTimeout` + 每次访问滑动续期），进程退出自然消失；
 *   ④ **未解锁一律拒绝** —— 条目接口连「有几条」都不回答（403，且响应体里没有条目信息）。
 *   ⚠️ 诚实边界：JS **无法可靠清零**内存里的 Buffer（没有 `mlock`，GC 也不保证及时回收），
 *      所以本模块不做「用完 `fill(0)`」这种看着安全实则无效的表演。真实的防护是
 *      **10 分钟自动锁定 + 密钥不写盘**；「攻击者已拿到 root 且在你解锁期间读进程内存」不在
 *      本期的威胁模型内（产品说明里如实写着，见 `docs/公共/架构文档/16-密码库.md`）。
 *
 * ⭐ **加密只在这里发生一次**：`lib/crypto.js` 提供原语，本模块负责「什么时候调哪个原语」。
 *    两个后端（SQLite / JSON）只提供「存密文行 / 取密文行」这一组原语，**完全不懂密码学** ——
 *    这样「换个后端密码库就打不开」这种事在结构上不可能发生（与收藏夹 / 硬件同一条理由）。
 *
 * 🔑 **密钥架构（信封加密，方案）**：
 *    主密码 --scrypt(salt)--> KEK --AES-GCM--> DEK --AES-GCM(每条独立 IV)--> 条目密文
 *    · KEK 只用来解开 DEK（`dek_cipher`），**永远不直接加密条目**；
 *    · 所以「改主密码」只需用新 KEK 重新封装那 32 字节的 DEK，**不必重加密整库**；
 *    · `verifier_*` 是用 KEK 加密的固定明文 —— 解得开就说明主密码对（**不另存口令哈希**，
 *      方案）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/vault.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。方法体一个字没动，
 *    只改了相对路径（`helpers.js` 多上跳一层、密码学原语改成模块自己的 `lib/crypto.js`）。
 *    ⚠️ **安全结论一个字都没改**：加密流程、解锁状态的四条铁律、响应体里不出现任何密钥材料
 *    —— 全都照旧。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.18
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md
 */
const { nowStamp, notFoundErr, badRequest } = require('../../core/store/helpers.js');
const vc = require('./lib/crypto.js');

/** 自动锁定的默认分钟数（方案 §十三-3 定案：10 分钟，可设置） @type {number} */
const DEFAULT_LOCK_MINUTES = 10;

/** 自动锁定分钟数的允许区间 —— 与 `validate.js` 的口径一致（**不允许 0**：自动锁定是安全特性） */
const LOCK_MINUTES_MIN = 1;
const LOCK_MINUTES_MAX = 120;

/** 一个标签名的长度上限 —— 与 `validate.js` 的 `MAX_SHORT_TEXT` 同口径（收藏夹分类名也是 50） */
const MAX_TAG_LEN = 50;

/** 一条记录最多几个标签 —— 与 `validate.js` 的 `MAX_VAULT_TAGS` 同口径 */
const MAX_TAGS = 20;

/**
 * 功能：把「从密文里解出来的标签」或「请求里带上来的标签」归一化成 `string[]`。
 *
 * 说明：⭐ 它**同时**服务两个方向，这是刻意的：
 *      · 写入方向：请求里的 `tags` 已经过 `validate.js`，这里再兜一次（密文里存的东西
 *        不该依赖「上游一定校验过」）；
 *      · 读出方向：**密文是用户可以手工编辑的**（数据库文件就在他自己的 NAS 上），
 *        解出来的 `tags` 可能是字符串、可能是数字数组、可能根本没有这一键。
 *        读出方向若不做兜底，界面会在 `.map()` 上一头栽进去（表现是整屏白）。
 *      ⚠️ 上限**在这里是截断而不是报错**：读出方向的输入不可信，为了「一条坏记录」
 *        把整屏列表打崩是最差的选择；写入方向的报错已经在 `validate.js` 给过用户了。
 *
 * @param {*} raw - 原始值（数组 / 字符串 / null / 未定义）
 * @returns {Array.<string>} 去空白、丢空串、去重、截断后的标签名数组
 */
function normTags(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** @type {Array.<string>} */
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const name = String(item).trim();
    if (!name || name.length > MAX_TAG_LEN) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 进程内解锁表：`uid → { dek, at, minutes, timer }`。
 *
 * ⚠️ 它是**模块级的**（不是 `this.` 上的）：解锁状态压根不属于「存储层的数据」，
 *    它跟 Store 实例的生命周期无关（同一进程重新构造 Store 也不该把密钥丢了）。
 *    `ttt/test/vault.test.js` 用 `vaultLockAll()` 在用例之间清场。
 *
 * @type {Map.<number, {dek: Buffer, at: number, minutes: number, timer: ?Object}>}
 */
const unlocked = new Map();

/**
 * 功能：构造一个「需要解锁 / 主密码不对」的 403 错误。
 *
 * 说明：⭐ **刻意不用 401**：前端的规则是「遇到 401 一律跳登录页」，
 *      而「主密码输错了」把人踢回登录页是彻底的误伤（他账号明明好好的）。
 *      403 属于「授权结果」这一桶，响应体逐字固定、不掺 `readOnly` 之类字段。
 *
 * @param {string} message - 中文说明（会直接展示给用户）
 * @returns {Error} 带 `status = 403` 的错误
 */
function denied(message) {
  const e = new Error(message);
  e.status = 403;
  return e;
}

/**
 * 功能：把某个账号的解锁记录（连同它的定时器）从进程内存里彻底拿掉。
 * @param {number} uid - 账号 id
 * @returns {void}
 */
function dropUnlocked(uid) {
  const e = unlocked.get(Number(uid));
  if (e && e.timer) clearTimeout(e.timer);
  unlocked.delete(Number(uid));
}

/**
 * 功能：**只读**判断某个账号此刻在不在解锁态 —— 与 `vaultIsUnlocked()` 的唯一区别是**不续期**。
 *
 * 说明：⭐ 009 报告 S9：`GET /api/vault/status` 以前直接走 `vaultIsUnlocked()`，而那个方法每次访问
 *      都会把到期时间往后推 —— 于是**一个拿着 Cookie 的脚本低频轮询 status 就能让密码库永不自动锁定**
 *      （前端倒计时是纯本地的，不是前端缺陷）。「继续操作就续期」是给**真正在用密码库**的动作
 *      （查看 / 复制 / 增删改）准备的；「问一句现在锁没锁」不该享受这个待遇。
 *      ⚠️ 过期记录照样**当场清掉**（连同定时器）—— 只是不往后推而已。
 *
 * @param {number} uid - 账号 id
 * @returns {boolean} 处于解锁态返回 true（且**不改**到期时间）
 */
function peekUnlocked(uid) {
  const key = Number(uid);
  const e = unlocked.get(key);
  if (!e) return false;
  if (Date.now() - e.at > e.minutes * 60000) {
    dropUnlocked(key);
    return false;
  }
  return true;
}

/**
 * 功能：读某个账号的自动锁定分钟数（账号行上的 `vault_lock_minutes`，兜底默认 10 分钟）。
 *
 * 说明：⚠️ 兜底是**双向夹取**（既兜「老库没这一列 → undefined」，也兜「库里被写了个荒唐值」）：
 *      老 JSON 数据、以及结构升级前建出来的账号行都可能没有这一列 ——
 *      缺列的表现必须是「用默认的 10 分钟」，**不能是「永不锁定」**（那是一个安全特性的静默失效）。
 *
 * @param {Object} self - Store 实例（业务方法都挂在它的原型上）
 * @param {number} uid - 账号 id
 * @returns {number} 分钟数（1~120）
 */
function lockMinutesOf(self, uid) {
  const u = self.getUser(uid);
  const raw = u ? Number(u.vault_lock_minutes) : NaN;
  if (!Number.isInteger(raw) || raw < LOCK_MINUTES_MIN) return DEFAULT_LOCK_MINUTES;
  return Math.min(raw, LOCK_MINUTES_MAX);
}

module.exports = {
  DEFAULT_LOCK_MINUTES,
  LOCK_MINUTES_MIN,
  LOCK_MINUTES_MAX,

  /**
   * 功能：读某个账号的自动锁定分钟数（给路由层与前端用）。
   * @param {number} uid - 账号 id
   * @returns {number} 分钟数（1~120）
   */
  vaultLockMinutes(uid) {
    return lockMinutesOf(this, uid);
  },

  /**
   * 功能：改某个账号的自动锁定分钟数（**每个账号各管各的**，存在 `users` 行上）。
   *
   * 说明：⭐ 与四个显示开关同一条规矩：不进全局 `settings`、删账号随行消失、
   *      **不动 `session_epoch`**（改「多久自动锁」不该把人踢下线）。
   *      ⚠️ 改小之后**立刻生效**：已经在解锁态的那些会话，其到期时间按新值重算 ——
   *      否则「我刚改成 1 分钟，它却还按 10 分钟给我留着」，用户会以为设置没生效。
   *
   * @param {number} uid - 账号 id
   * @param {number} minutes - 分钟数（区间由 `validate.js` 保证）
   * @returns {number} 落库后的分钟数
   * @throws {Error} 数据层只读时抛 503
   */
  setVaultLockMinutes(uid, minutes) {
    this._assertWritable();
    const n = Number(minutes);
    if (!Number.isInteger(n) || n < LOCK_MINUTES_MIN || n > LOCK_MINUTES_MAX) {
      throw badRequest(`自动锁定时间应是 ${LOCK_MINUTES_MIN} 到 ${LOCK_MINUTES_MAX} 分钟之间的整数`);
    }
    if (!this._bk.setVaultLockMinutes(Number(uid), n, nowStamp())) {
      throw notFoundErr('这个账号');
    }
    const e = unlocked.get(Number(uid));
    if (e) {
      e.minutes = n;
      // 重设定时器：新值可以比原来更短，也可以更长，两种情况都得按新的来
      if (e.timer) clearTimeout(e.timer);
      e.timer = scheduleDrop(uid, n);
    }
    return n;
  },

  /**
   * 功能：密码库状态 —— **未解锁时也只回这三样**（`initialized` / `unlocked` / 锁定秒数），
   *      不含任何条目信息（连条数都不给）。
   *
   * 说明：⚠️ `initialized` 只说明「这个账号设过主密码」，它**不是**敏感信息 ——
   *      用户自己当然知道；而界面必须靠它决定「显示设置主密码页」还是「显示解锁页」。
   *      条目数量**刻意不给**：那是「你存了几个账号」的侧信道，未解锁时没有理由回答。
   *
   * @param {number} uid - 账号 id
   * @returns {{initialized: boolean, unlocked: boolean, lockAfterSeconds: number, lockMinutes: number}} 状态
   */
  vaultStatus(uid) {
    const minutes = lockMinutesOf(this, uid);
    return {
      initialized: !!this._bk.getVaultMeta(Number(uid)),
      // ⚠️ 只读判断（`peekUnlocked`）：这个接口是给界面问「现在锁没锁」的，
      //    **不算一次操作**、不续期 —— 否则脚本轮询就能让自动锁定永不触发（009 报告 S9）
      unlocked: peekUnlocked(uid),
      lockAfterSeconds: minutes * 60,
      lockMinutes: minutes,
    };
  },

  /**
   * 功能：判断某个账号此刻是否处于解锁态 —— 顺带**滑动续期**（把到期时间往后推）。
   *
   * 说明：⭐ 超时口径是**空闲超时**（每次访问都续期），不是「从解锁那刻起 10 分钟一到就锁」：
   *      后者会在用户正对着详情页抄密码的时候把他锁掉，而方案 §七 明确要求
   *      「避免用户写到一半被锁掉」（界面还有锁前 30 秒提示）。
   *      ⚠️ 过期记录**当场删除**（连同定时器）—— 「过期了但还留着引用」等于把超时做成了摆设。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 处于解锁态返回 true
   */
  vaultIsUnlocked(uid) {
    const key = Number(uid);
    if (!peekUnlocked(key)) return false;
    // ⭐ 只有走到这里才续期 —— 「问状态」走 `peekUnlocked()`，不推到期时间（009 报告 S9）
    const e = unlocked.get(key);
    e.at = Date.now();
    if (e.timer) clearTimeout(e.timer);
    e.timer = scheduleDrop(key, e.minutes);
    return true;
  },

  /**
   * 功能：初始化密码库 —— 第一次设置主密码（**每个账号一次**）。
   *
   * 说明：⭐ 一次性做三件事：生成随机盐 → 派生 KEK → 生成随机 DEK 并用 KEK 封装 →
   *      写一行 `vault_meta`（含用 KEK 加密的验证块）。**条目此时还是空的**。
   *      ⚠️ 重复初始化**明确报 400**（不是静默覆盖）：覆盖会让原密码库**永久打不开**
   *      （DEK 被换成新的，旧条目全部解不开），而用户以为只是「重新设了个密码」。
   *      ⚠️ 「已初始化」的判据是**库里有 `vault_meta` 行**，不是内存里的解锁表 ——
   *      所以服务重启之后 `initialized` 依然是 true。
   *
   * @param {number} uid - 账号 id
   * @param {string} masterPassword - 主密码明文（长度由 `validate.js` 保证）
   * @returns {{ok: true}} 固定返回体（**不回 DEK、不回任何库内材料**）
   * @throws {Error} 已初始化（400）、数据层只读（503）
   */
  vaultInit(uid, masterPassword) {
    this._assertWritable();
    const key = Number(uid);
    if (this._bk.getVaultMeta(key)) {
      throw badRequest('这个账号已经设置过主密码了，不能重复初始化（重新初始化会让原来的条目全部打不开）');
    }
    const params = vc.KDF_DEFAULT;
    const salt = vc.newSalt();
    const kek = vc.deriveKek(masterPassword, salt, params);
    const dek = vc.newDek();
    const sealed = vc.sealDek(kek, dek);
    const verifier = vc.makeVerifier(kek);
    const stamp = nowStamp();
    this._bk.insertVaultMeta(key, {
      kdf: 'scrypt',
      kdf_params: JSON.stringify({ N: params.N, r: params.r, p: params.p, keylen: params.keylen }),
      salt: salt.toString('base64'),
      dek_iv: sealed.iv,
      dek_cipher: sealed.cipher,
      dek_tag: sealed.tag,
      verifier_iv: verifier.iv,
      verifier_cipher: verifier.cipher,
      verifier_tag: verifier.tag,
      created_at: stamp,
      updated_at: stamp,
    });
    // ⭐ 初始化成功即视为已解锁：用户刚刚亲口设了主密码，再让他立刻输一遍是纯粹的添堵
    this._vaultHold(key, dek);
    return { ok: true };
  },

  /**
   * 功能：用主密码解锁密码库 —— 校验通过则把 DEK 放进**进程内**解锁表。
   *
   * 说明：⭐ 校验分两步、缺一不可：① 用主密码 + 库里那个盐派生 KEK；
   *      ② 用它解开 `verifier_*` 并比对固定明文。**不需要**先解 DEK ——
   *      验证块对不上的时候连 DEK 密文都不碰（少一次可能出错的解密）。
   *      ⚠️ 失败信息**只有一句「主密码不正确」**：不区分「密码错」与「密文被改过」，
   *      也不透露盐或参数。这两种情况的处置对用户来说是一样的（重试或放弃）。
   *      ⚠️ `kdf_params` 读不出来（手改坏了）时抛出的是**另一句话**（参数损坏）——
   *      因为那不是「密码错」，用户重试一百次也没用，必须让他知道该走备份恢复。
   *
   * @param {number} uid - 账号 id
   * @param {string} masterPassword - 主密码明文
   * @returns {{ok: true, lockAfterSeconds: number}} 成功结果
   * @throws {Error} 未初始化（400）、主密码不对（403）
   */
  vaultUnlock(uid, masterPassword) {
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) throw badRequest('这个账号还没有设置主密码，请先设置');
    if (String(meta.kdf) !== 'scrypt') throw badRequest('这个密码库用了本版本不认识的算法，请升级应用后再试');

    const params = vc.parseKdfParams(meta.kdf_params); // 参数损坏 → 抛「参数已损坏」，不是「密码错」
    const salt = Buffer.from(String(meta.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这个密码库的盐已损坏，无法解锁（请从备份恢复）');
    const kek = vc.deriveKek(masterPassword, salt, params);
    const ok = vc.checkVerifier(kek, {
      iv: meta.verifier_iv,
      cipher: meta.verifier_cipher,
      tag: meta.verifier_tag,
    });
    if (!ok) throw denied('主密码不正确');

    const dek = vc.openDek(kek, { iv: meta.dek_iv, cipher: meta.dek_cipher, tag: meta.dek_tag });
    const minutes = lockMinutesOf(this, key);
    this._vaultHold(key, dek, minutes);
    return { ok: true, lockAfterSeconds: minutes * 60 };
  },

  /**
   * 功能：把一个 DEK 放进进程内解锁表，并挂上到期自动清除的定时器。
   *
   * 说明：⭐ 定时器必须 `unref()` —— 否则它会**拖住事件循环**，
   *      表现为「关掉应用之后进程迟迟不退出」（真机上是停不下来的服务）。
   *      真正的到期判定在 `vaultIsUnlocked()` 里也做了一遍（定时器只是让引用尽早释放，
   *      不是正确性的唯一来源 —— 定时器可能因为进程忙碌而晚触发）。
   *
   * @param {number} uid - 账号 id
   * @param {Buffer} dek - 32 字节数据密钥
   * @param {number} [minutes] - 锁定分钟数；省略时读该账号的偏好
   * @returns {void}
   */
  _vaultHold(uid, dek, minutes) {
    const key = Number(uid);
    const m = Number.isInteger(minutes) ? minutes : lockMinutesOf(this, key);
    dropUnlocked(key);
    unlocked.set(key, { dek, at: Date.now(), minutes: m, timer: scheduleDrop(key, m) });
  },

  /**
   * 功能：取当前账号的 DEK（**本模块唯一的取密钥出口**）；未解锁或已超时一律抛 403。
   *
   * 说明：⚠️ 所有条目方法都必须先过这里 —— 它是「未解锁不返回任何条目信息」这条规矩的
   *      单一执行点。**不要**在任何地方绕过它去读 `unlocked`。
   *
   * @param {number} uid - 账号 id
   * @returns {Buffer} 32 字节 DEK
   * @throws {Error} 未解锁（403）
   */
  _vaultDek(uid) {
    if (!this.vaultIsUnlocked(uid)) throw denied('密码库已锁定，请先输入主密码解锁');
    return unlocked.get(Number(uid)).dek;
  },

  /**
   * 功能：手动锁定密码库（界面上的「🔒 锁定」按钮）。
   * @param {number} uid - 账号 id
   * @returns {{ok: true}} 固定返回体（**不回「锁没锁上」之外的任何东西**）
   */
  vaultLock(uid) {
    dropUnlocked(Number(uid));
    return { ok: true };
  },

  /**
   * 功能：清空**全部**账号的解锁状态（测试与运维用；也可作为「全局上锁」的入口）。
   * @returns {number} 被清掉的解锁记录条数
   */
  vaultLockAll() {
    const n = unlocked.size;
    [...unlocked.keys()].forEach(dropUnlocked);
    return n;
  },

  /**
   * 功能：**仅供测试** —— 看某个账号当前的解锁记录（**只回时间信息，绝不回密钥**）。
   *
   * 说明：⚠️ 这是给 `ttt/test/vault.test.js` 的**测试缝**（方案 §九 要求「超时自动锁定用
   *      可注入的时钟 / 短超时验证」）。它刻意**只返回 `{at, minutes}`、不返回 DEK** ——
   *      一个会吐密钥的测试钩子迟早会被用到请求路径上去。
   *      ⚠️ 生产代码里**不许调用它**（它存在的唯一理由是让超时可以被验证，而不必真等 10 分钟）。
   *
   * @param {number} uid - 账号 id
   * @returns {?{at: number, minutes: number}} 解锁记录的时间信息；未解锁时为 null
   */
  _vaultDebugLockState(uid) {
    const e = unlocked.get(Number(uid));
    return e ? { at: e.at, minutes: e.minutes } : null;
  },

  /**
   * 功能：**仅供测试** —— 把某个账号的解锁记录**标记为已过期**（把 `at` 往回拨到期限之外）。
   *
   * 说明：⚠️ 与 `_vaultDebugLockState` 同一性质：测试缝，生产代码不许调。
   *      它**不删记录**（那是 `vaultIsUnlocked()` 的职责）—— 这样测试才能验到
   *      「过期记录会被当场删掉」这一条（否则就变成了「测试自己把它删了」）。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 确实有一条记录被拨过期返回 true
   */
  _vaultDebugExpire(uid) {
    const e = unlocked.get(Number(uid));
    if (!e) return false;
    e.at = Date.now() - (e.minutes + 1) * 60000;
    return true;
  },

  /**
   * 功能：列出该账号的全部条目 —— **只回摘要，不回密码**（列表页用）。
   *
   * 说明：⭐ 为什么列表里也不给密码：界面上「列表 → 点进去 → 复制」是两步，
   *      把全部密码一次性吐给列表页，等于每打开一次密码库就把它整本摊在内存与网络里，
   *      而用户此刻可能只是在找「那个 GitHub 的账号叫什么」。
   *      ⚠️ 单条解密失败（密文被改过 / 手工编辑坏了）**不静默跳过**：
   *      跳过会让用户以为「这条记录不见了」，而实际情况是「这条被损坏了」。
   *      这里把它标成 `broken: true` 一并返回，标题留空，由界面明确显示一条告警。
   *      ⭐ 每条都带上 `tags`（0.4.4 起）：**筛选与搜索都在前端做**，所以标签必须跟着
   *      摘要一起回来 —— 但这**不是**「服务端也开始按标签筛了」，服务端只是把密文里的
   *      那几个字符串原样交给已经在内存里持有明文的那个界面（见文件头）。
   *      损坏的那条同样给 `tags: []`（**不是不给这一键**）：界面统一按数组用，
   *      「某一条没有这个字段」会变成一个只在损坏时才出现的分支。
   *      ⭐ 0.8.18：另回一份 `tagPool`（建过、但还没有任何记录用到的标签名，见 `vaultTagPool()`）
   *      —— 左栏与计数要把它并进去，否则「刚建的空标签」下一次取数就凭空消失。
   *
   * @param {number} uid - 账号 id
   * @returns {{items: Array.<Object>, broken: number, tagPool: Array.<string>}} 摘要列表、损坏条数与标签池
   * @throws {Error} 未解锁（403）
   */
  listVaultEntries(uid) {
    const dek = this._vaultDek(uid);
    /** @type {Array.<Object>} */
    const items = [];
    let broken = 0;
    for (const row of this._bk.listVaultItems(Number(uid))) {
      let obj;
      try {
        obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
      } catch (_e) {
        broken += 1;
        items.push({
          id: row.id,
          title: '',
          username: '',
          url: '',
          tags: [],
          broken: true,
          updated_at: row.updated_at,
        });
        continue;
      }
      items.push({
        id: row.id,
        title: String(obj.title || ''),
        username: String(obj.username || ''),
        url: String(obj.url || ''),
        tags: normTags(obj.tags),
        has_note: !!obj.note,
        broken: false,
        updated_at: row.updated_at,
      });
    }
    return { items, broken, tagPool: this.vaultTagPool(uid) };
  },

  /**
   * 功能：判断某条密码条目是否属于该账号（路由层在「详情 / 编辑 / 删除」前统一用它回 404）。
   *
   * 说明：⭐ 它**不需要解锁**：只比对 `id` 与 `user_id`，不碰任何密文列 ——
   *      所以「未解锁时探某个 id 存不存在」也只会得到 404，不泄露任何条目内容。
   *      路由层把这一步放在「取 DEK」之前，是为了让**越权与不存在**在任何状态下都回同一个 404。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsVaultEntry(uid, id) {
    return this._bk.ownsVaultItem(Number(uid), id);
  },

  /**
   * 功能：要求当前账号处于解锁态（不满足直接抛 403），顺带把解锁态**滑动续期**一次。
   *
   * 说明：给「不需要读条目、但仍要求在解锁态」的接口用（例如密码生成器，方案 §六 把它归在
   *      「登录 + 已解锁」那一档）—— 它本身不产生任何数据，但把它挂在解锁之后，
   *      「谁能调生成器」就和「谁能看密码」是同一个门槛，不会多出一条独立的判定路径。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 恒为 true（不满足时抛错）
   * @throws {Error} 未解锁时抛 403
   */
  vaultAssertUnlocked(uid) {
    this._vaultDek(uid);
    return true;
  },

  /**
   * 功能：取一条条目的**完整内容**（含密码），供详情页查看 / 复制。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {Object} `{ id, title, username, password, url, note, tags, updated_at }`
   * @throws {Error} 未解锁（403）、条目不存在或不属于本人（404）、密文损坏（500 之外另说，见下）
   */
  getVaultEntry(uid, id) {
    const dek = this._vaultDek(uid);
    const row = this._bk.getVaultItem(Number(uid), id);
    if (!row) throw notFoundErr('这条密码记录');
    let obj;
    try {
      obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
    } catch (_e) {
      // ⚠️ 这里**不冒充 404**：记录确实存在，只是解不开。回 404 会让用户以为记录被删了，
      //    而真相是「这条记录被改坏了，请从备份恢复」——两者的处置完全不同。
      throw badRequest('这条记录已损坏，解不出内容（可能是数据库被手工改动过，请从备份恢复）');
    }
    return {
      id: row.id,
      title: String(obj.title || ''),
      username: String(obj.username || ''),
      password: String(obj.password || ''),
      url: String(obj.url || ''),
      note: String(obj.note || ''),
      tags: normTags(obj.tags),
      updated_at: row.updated_at,
    };
  },

  /**
   * 功能：新建一条密码条目（整条加密后落库）。
   *
   * 说明：⚠️ 必填的 `password` 由路由层查（`validate.checkVaultItem` 只管「带了就校验」，
   *      与收藏夹的 `url`、硬件的 `name` 同一手法），这样编辑时「只改标题」不会被要求重发密码。
   *      ⚠️ IV 由 `vc.encryptJson()` 内部 `randomBytes(12)` 生成，**本层无从指定**（GCM 的 IV 绝不复用）。
   *      ⚠️ 标签**跟着这一条一起加密**（0.4.4 起）：库里因此没有明文分类名，
   *      代价是服务端没法按标签检索 —— 筛选在前端做（见文件头）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} item - 明文条目 `{ title, username, password, url, note, tags }`
   * @returns {{id: number}} 新条目 id
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  createVaultEntry(uid, item) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const sealed = vc.encryptJson(dek, {
      title: String((item && item.title) || ''),
      username: String((item && item.username) || ''),
      password: String((item && item.password) || ''),
      url: String((item && item.url) || ''),
      note: String((item && item.note) || ''),
      tags: normTags(item && item.tags),
    });
    const stamp = nowStamp();
    const row = this._bk.insertVaultItem(Number(uid), {
      iv: sealed.iv,
      cipher: sealed.cipher,
      tag: sealed.tag,
      sort_order: Number((item && item.sort_order) || 0) || 0,
      created_at: stamp,
      updated_at: stamp,
    });
    return { id: row.id };
  },

  /**
   * 功能：编辑一条条目 —— 只改请求里真的带了的字段，改完**整条重新加密**。
   *
   * 说明：⭐ 「整条重新加密」是刻意的（而不是只改密文里的某一段）：密文是**一整块**，
   *      字段级加密会让「一条记录里几个字段的 IV 一样不一样」变成需要推理的事。
   *      代价是要先把原明文解出来，收益是没有第二种密文形态。
   *      ⚠️ **每次写入都换新 IV**（`vc.encryptJson` 自己生成）—— 复用旧 IV 是 GCM 的致命错误
   *      （方案 §5.3 硬要求 2）。`ttt/test/vault.test.js` 断言了「改完之后 IV 与改之前不同」。
   *      ⚠️ 一条记录都没改到（不属于本人）→ 返回 false，由路由层收口成 404。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @param {Object} patch - 只含要改的字段（`title` / `username` / `password` / `url` / `note` / `tags`）
   * @returns {boolean} 是否真的改到了（不归本人时为 false）
   * @throws {Error} 未解锁（403）、条目不存在（404）、密文损坏（400）、数据层只读（503）
   */
  updateVaultEntry(uid, id, patch) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const key = Number(uid);
    const row = this._bk.getVaultItem(key, id);
    if (!row) throw notFoundErr('这条密码记录');
    let cur;
    try {
      cur = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
    } catch (_e) {
      throw badRequest('这条记录已损坏，解不出内容，无法修改（请从备份恢复）');
    }
    const next = {
      title: String(cur.title || ''),
      username: String(cur.username || ''),
      password: String(cur.password || ''),
      url: String(cur.url || ''),
      note: String(cur.note || ''),
      tags: normTags(cur.tags),
    };
    const src = patch && typeof patch === 'object' ? patch : {};
    ['title', 'username', 'password', 'url', 'note'].forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) next[k] = String(src[k] || '');
    });
    // ⚠️ 标签单独处理（它是数组）：**不带 `tags` 键 = 原样保留**，这一条是「改备注别把标签弄丢」的
    //    唯一保障 —— 界面上「只改标题」的那次 PUT 不会带上 tags，落到这里就必须是旧值。
    if (Object.prototype.hasOwnProperty.call(src, 'tags') && src.tags !== undefined) next.tags = normTags(src.tags);
    const sealed = vc.encryptJson(dek, next);
    return this._bk.updateVaultItem(
      key,
      id,
      ['iv', 'cipher', 'tag', 'updated_at'],
      [sealed.iv, sealed.cipher, sealed.tag, nowStamp()],
    );
  },

  /**
   * 功能：删除一条条目（密文行整行删掉）。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  removeVaultEntry(uid, id) {
    this._assertWritable();
    this._vaultDek(uid); // 未解锁不许删（删也是写操作，但它同时需要「证明你在场」）
    return this._bk.deleteVaultItem(Number(uid), id);
  },

  /**
   * 功能：把**所有**条目里叫 `from` 的标签改名为 `to`（0.4.4 起）—— 界面上的「标签改名」。
   *
   * 说明：⭐ 标签没有自己的表（它睡在每条记录的密文里），所以「改名」在物理上就是
   *      「把所有带着它的记录读出来、改一个字符串、再写回去」。这正是本模块为
   *      「分类名不落明文」付出的代价，也是它换来的东西：库里找不到「工作 / 银行 / 公司 VPN」
   *      这些字眼。
   *      ⚠️ 新名与**已有的另一个标签重名时是「合并」**（两条都带上新名，靠归一化去重）——
   *      这是用户心里最自然的语义，也是最省事的：不需要问「要不要合并」。
   *      ⚠️ 一条都没改到（没人用这个标签 / 界面拿的是旧数据）→ `changed: 0`，
   *      **不是 404**：标签在服务端不是一个「资源」，它只是密文里的一个字符串。
   *
   * @param {number} uid - 账号 id
   * @param {string} from - 原标签名（由 `validate.checkVaultTagRename` 归一化）
   * @param {string} to - 新标签名
   * @returns {{changed: number}} 实际被改写的记录条数
   * @throws {Error} 未解锁（403）、有记录解不开（400）、数据层只读（503）
   */
  vaultRenameTag(uid, from, to) {
    const r = this._vaultRewriteTags(uid, (tags) => tags.map((t) => (t === from ? to : t)));
    // ⭐ 0.8.18：标签池跟着改名（池里那个名字若还在，不改就会出现「刚建的空标签改完名还在」）——
    //    重名由 `normTags` 去重，正好等于「合并」。
    this._vaultSyncPool(uid, (pool) => pool.map((t) => (t === from ? to : t)));
    return r;
  },

  /**
   * 功能：把**所有**条目里叫 `name` 的标签拿掉（0.4.4 起）—— 界面上的「删除这个标签」。
   *
   * 说明：⚠️ 删标签**不删记录**（与收藏夹「删分类不删书签」同一条语义），
   *      只是把那个字符串从每条记录的标签数组里摘掉；记录本身一个字段都没变。
   *
   * @param {number} uid - 账号 id
   * @param {string} name - 要摘掉的标签名（由 `validate.checkVaultTagRemove` 归一化）
   * @returns {{changed: number}} 实际被改写的记录条数
   * @throws {Error} 未解锁（403）、有记录解不开（400）、数据层只读（503）
   */
  vaultRemoveTag(uid, name) {
    const r = this._vaultRewriteTags(uid, (tags) => tags.filter((t) => t !== name));
    // ⭐ 0.8.18：标签池也要摘掉它 —— 否则「删了的标签」会从池里原样冒回来（计数 0、筛出空列表）。
    this._vaultSyncPool(uid, (pool) => pool.filter((t) => t !== name));
    return r;
  },

  /**
   * 功能：读该账号的**标签池** —— 建过、但可能还没有任何记录用到的标签名（0.8.18）。
   *
   * 说明：⭐⭐ 池子**也是一份密文**（`vault_meta.tags_*`，用同一把 DEK 加解密），
   *      所以它**不是** `vault_tags` 明文表 —— 服务端照旧看不见任何标签名。
   *      ⚠️ 读它**必须已解锁**（`_vaultDek()` 是唯一门槛，与 `listVaultEntries` 同一处），
   *      未解锁一律 403 —— 「你有哪些分类」同样属于「你有哪些账号」那类信息。
   *      ⚠️ 密文解不开（手改坏了）时**返回空池而不是抛错**：条目里的标签一条都没丢，
   *      为一份辅助清单把整个列表页打崩是最差的选择（与 `normTags` 那条「读出方向兜底」同一取向）。
   *
   * @param {number} uid - 账号 id
   * @returns {Array.<string>} 标签池（归一化后的名字数组；没有时为空数组）
   * @throws {Error} 未解锁（403）
   */
  vaultTagPool(uid) {
    const dek = this._vaultDek(uid);
    const meta = this._bk.getVaultMeta(Number(uid));
    if (!meta || !meta.tags_cipher) return [];
    try {
      const obj = vc.decryptJson(dek, { iv: meta.tags_iv, cipher: meta.tags_cipher, tag: meta.tags_tag });
      return normTags(obj && obj.tags);
    } catch (_e) {
      return [];
    }
  },

  /**
   * 功能：往标签池里**新建一个空标签**（0.8.18，界面上的「写一个新标签 ＋ 新建」）。
   *
   * 说明：⭐ 这是密码库唯一一处「建出来时还没有任何记录用到它」的标签 —— 与随手记 / 收藏夹
   *      的空标签同形（它们靠明文标签表实现；密码库靠这份加密清单，见 `schema.js` 文件头）。
   *      ⚠️ 同名**不报错、直接回 `added: false`**：用户在输入框里连点两下不该看到红字，
   *      而这与「服务端已存在同名标签」是同一件事（筛选、计数都按名字走）。
   *      ⚠️ 上限与「一条记录的标签数」同一个 `MAX_TAGS`：池子只是让名字提前存在，
   *      没有理由比真正能挂上去的还多。
   *
   * @param {number} uid - 账号 id
   * @param {string} name - 标签名（已由 `validate.checkVaultTagCreate` 归一化）
   * @returns {{ok: true, name: string, added: boolean}} `added=false` 表示本来就有
   * @throws {Error} 未初始化（400）、未解锁（403）、池满（400）、数据层只读（503）
   */
  vaultAddTag(uid, name) {
    this._assertWritable();
    const key = Number(uid);
    if (!this._bk.getVaultMeta(key)) throw badRequest('这个账号还没有设置主密码，请先设置');
    const before = this.vaultTagPool(uid);
    if (before.includes(name)) return { ok: true, name, added: false };
    if (before.length >= MAX_TAGS) throw badRequest(`标签最多 ${MAX_TAGS} 个`);
    this._vaultSyncPool(uid, (pool) => pool.concat([name]));
    return { ok: true, name, added: true };
  },

  /**
   * 功能：把标签池整体改一遍并写回 —— 改名 / 删除 / 新建三条路径的**唯一写入点**。
   *
   * 说明：⚠️ 三列**一起写**（`iv` / `cipher` / `tag`）：单独换一个 `iv` 而不同时换密文
   *      会把这份清单直接毁掉（与 `vault_items` 那三列同一条纪律）。
   *      ⚠️ 没变化就不写（省一次磁盘写，也少一次无谓的密文重排）。
   *      ⚠️ **刻意不动 `updated_at`**：那一列在 `vault_meta` 上的语义是「开库材料最后一次重写」
   *      （改主密码 / 改自动锁定），标签池不属于开库材料 —— 动它会让「主密码什么时候改的」失真。
   *
   * @param {number} uid - 账号 id
   * @param {Function} mutate - `(pool: string[]) => string[]`
   * @returns {void}
   * @throws {Error} 未解锁（403）
   */
  _vaultSyncPool(uid, mutate) {
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) return;
    const dek = this._vaultDek(uid);
    const before = this.vaultTagPool(uid);
    const after = normTags(mutate(before));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const sealed = vc.encryptJson(dek, { tags: after });
    this._bk.updateVaultMeta(key, ['tags_iv', 'tags_cipher', 'tags_tag'], [sealed.iv, sealed.cipher, sealed.tag]);
  },

  /**
   * 功能：标签批量改写的**唯一实现** —— 「先全部解密成内存里的新值，全部成功之后再逐条写回」。
   *
   * 说明：⭐⭐ 这个两段式结构是刻意的，别把它改成「一边解密一边写」：
   *      · 第一段只读、只算，**任何一条解不开就整块抛 400**，一行都不写 ——
   *        否则会出现「前几条的标签改了、后面那条坏了没改」，而用户看到的是一句失败提示，
   *        他会以为「什么都没发生」；
   *      · 第二段才写，此时所有新密文都已经在内存里算好（`encryptJson` 也在这里调，
   *        每条各自一个新的随机 IV），写的动作再失败也只可能是数据层只读 —— 那种情况
   *        在第一步 `_assertWritable()` 就拦掉了，走不到这里。
   *      ⚠️ 每次写入都会**换新 IV + 整条重新加密**（GCM 的硬要求，见方案 §5.3）；
   *      所以「改一个标签」在磁盘上表现为「这些记录整条的密文都变了」，这是正常的。
   *      ⚠️ 没变化的记录**不写**（`before/after` 相同就跳过）：少一次写入、更新时间也不会白跳。
   *      ⚠️ **标签名不进日志**：本函数不做任何 `logLine`，路由层那里也只记条数（方案硬要求 4）。
   *
   * @param {number} uid - 账号 id
   * @param {Function} mutate - `(tags: string[]) => string[]`，返回该条记录的新标签数组
   * @returns {{changed: number}} 实际被改写的记录条数
   * @throws {Error} 未解锁（403）、有记录解不开（400）、数据层只读（503）
   */
  _vaultRewriteTags(uid, mutate) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const key = Number(uid);

    // ---- 第一段：只读只算，全部成功才算数 ----
    /** @type {Array.<{id: number, payload: Object}>} */
    const plans = [];
    for (const row of this._bk.listVaultItems(key)) {
      let obj;
      try {
        obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
      } catch (_e) {
        // ⚠️ 明确说「一行都没改」：用户接下来该做的是恢复那条记录，而不是再点一次
        throw badRequest('有一条记录已损坏（内容解不开），标签暂时改不了 —— 请先从备份恢复那条记录，一行都没有改动');
      }
      const before = normTags(obj.tags);
      const after = normTags(mutate(before));
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      plans.push({
        id: row.id,
        payload: {
          title: String(obj.title || ''),
          username: String(obj.username || ''),
          password: String(obj.password || ''),
          url: String(obj.url || ''),
          note: String(obj.note || ''),
          tags: after,
        },
      });
    }

    // ---- 第二段：逐条写回（新密文已算好，每条一个新 IV）----
    let changed = 0;
    for (const p of plans) {
      const sealed = vc.encryptJson(dek, p.payload);
      const ok = this._bk.updateVaultItem(
        key,
        p.id,
        ['iv', 'cipher', 'tag', 'updated_at'],
        [sealed.iv, sealed.cipher, sealed.tag, nowStamp()],
      );
      if (ok) changed += 1;
    }
    return { changed };
  },

  /**
   * 功能：生成一个强随机密码（密码生成器）。
   *
   * 说明：⚠️ 参数校验在 `validate.js` 做过一遍（给得出人话的 400），这里再兜一次
   *      ——因为原语层抛的是**英文/技术向**的错误，直接透给用户就成了一句看不懂的话。
   *
   * @param {Object} opts - `{ length?, charset?, noAmbiguous? }`
   * @returns {{password: string}} 生成的密码
   * @throws {Error} 参数不合法（400）
   */
  generateVaultPassword(opts) {
    try {
      return { password: vc.generatePassword(opts || {}) };
    } catch (e) {
      throw badRequest((e && e.message) || '生成参数不合法');
    }
  },
};

/**
 * 功能：给某个账号挂一个「到期就把解锁记录删掉」的定时器。
 *
 * 说明：⭐ 必须 `unref()`：不 unref 的定时器会拖住事件循环，真机上表现为
 *      「点了停止应用，进程却一直不退出」。⚠️ 它只是**尽早释放引用**的优化，
 *      正确性由 `vaultIsUnlocked()` 里的时间比对兜底（定时器可能晚触发）。
 *
 * @param {number} uid - 账号 id
 * @param {number} minutes - 锁定分钟数
 * @returns {Object} Node 的 Timeout 句柄（已 unref）
 */
function scheduleDrop(uid, minutes) {
  const t = setTimeout(() => dropUnlocked(uid), Math.max(1, minutes) * 60000);
  if (typeof t.unref === 'function') t.unref();
  return t;
}
