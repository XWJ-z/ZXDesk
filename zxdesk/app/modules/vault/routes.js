/**
 * modules/vault/routes.js —— 密码库路由（0.3.2）
 *
 * 功能：`handleVault` 一处收全部密码库接口 —— 状态、初始化、解锁 / 锁定、条目增删改查、
 *      密码生成器、自动锁定偏好、标签改名 / 删除（0.4.4 起）。
 *
 * ⭐ **本文件最重要的两条规矩**：
 *   ① **解锁失败回 403，不回 401**：前端的规则是「遇到 401 一律跳登录页」，
 *      而「主密码输错了」把人踢回登录页是彻底的误伤（他账号好好的）。
 *   ② ⚠️ **响应体里绝不出现任何密钥材料**：`DEK` / `KEK` / `salt` / `dek_cipher` / 主密码
 *      一个都不回、一个都不进日志。`/api/vault/status` 只回三个布尔/数字，
 *      `/api/vault` 只回摘要（**不含密码**），只有 `/api/vault/:id` 才回明文条目。
 *
 * ⭐ **未解锁时的 403 与「主密码错误」的 403 是同一个状态码、不同文案**：
 *    前者是「你还没解锁」，后者是「你刚敲的那句不对」。前端按**调用上下文**区分
 *    （它自己知道刚才是在调 unlock 还是在读列表），不需要服务端再发明一个状态码 ——
 *    错误出口只有那四条规则。
 *
 * ⚠️ **节流**：解锁接口复用登录那套节流器（同一个 5 分钟 / 10 次窗口），
 *    但键名带 `vault:` 前缀 —— 否则「有人拿某个用户名猛试密码库」会把**那个用户的正常登录**
 *    一起挡掉（那是两个完全不相干的入口）。节流存在合理性见 `routes/auth.js` 的 `loginThrottle`：
 *    `scryptSync` 会阻塞事件循环，不设限就等于把「猜主密码」变成「打垮服务」。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/routes/vault.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了相对路径与导出键
 *    （`handleVault` → **`vault`** = `module.json` 的 `apiPrefix`）以及本段说明；
 *    处理函数体一个字没动。
 *    ⚠️ **安全结论一个字都没改**：上面那两条规矩（解锁失败回 403、响应体里不出现密钥材料）
 *    与节流口径全都照旧。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.18
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md
 */
'use strict';

const { logLine, store } = require('../../core/context.js');
const { httpError, idParam, json, notFound, readBody } = require('../../core/http-util.js');
const { loginThrottle } = require('../../core/routes/auth.js');
const {
  checkMasterPassword,
  checkVaultGenerator,
  checkVaultItem,
  checkVaultLockMinutes,
  checkVaultTagCreate,
  checkVaultTagRename,
  checkVaultTagRemove,
} = require('../../core/validate.js');

/**
 * 功能：给解锁接口用的节流键 —— **按账号 id**，并带 `vault:` 前缀与登录节流隔离。
 *
 * 说明：⚠️ 不能按主密码、也不能按用户名：前者会把密码本身写进内存键（没有任何道理），
 *      后者会让「试密码库」与「登登录」互相污染。按 uid 计数的已知局限与登录那边一样
 *      （换账号即可绕过），但那个局限在这里无关紧要 —— 攻击者绕过的同时也就换了一个库。
 *
 * @param {number} uid - 账号 id
 * @returns {string} 节流键
 */
function throttleKey(uid) {
  return `vault:${Number(uid)}`;
}

/**
 * 功能：处理 `/api/vault` 及其子路径 —— 密码库的解锁与条目增删改查。
 *
 * 说明：路由表（`parts = ['api','vault', …]`）——
 *      · `GET    /api/vault/status`      状态（已初始化 / 已解锁 / 自动锁定秒数）—— **不需要解锁**
 *      · `POST   /api/vault/init`        首次设置主密码（仅未初始化时允许）—— 不需要解锁
 *      · `POST   /api/vault/unlock`      解锁（带节流）—— 不需要解锁
 *      · `POST   /api/vault/lock`        锁定 —— 不需要解锁（锁自己永远允许）
 *      · `PUT    /api/vault/settings`    改自动锁定分钟数 —— 需要解锁
 *      · `GET    /api/vault`             条目列表（摘要，**不含密码**）—— 需要解锁
 *      · `POST   /api/vault`             新增条目 —— 需要解锁
 *      · `GET    /api/vault/:id`         详情（**含密码**）—— 需要解锁 + 归属校验
 *      · `PUT    /api/vault/:id`         编辑条目 —— 需要解锁 + 归属校验
 *      · `DELETE /api/vault/:id`         删除条目 —— 需要解锁 + 归属校验
 *      · `POST   /api/vault/generate`    生成强密码 —— 需要解锁
 *      · `POST   /api/vault/tags`        新建一个空标签（0.8.18）—— 需要解锁
 *      · `POST   /api/vault/tags/rename` 标签改名（影响多条记录）—— 需要解锁
 *      · `POST   /api/vault/tags/remove` 删除一个标签（记录保留）—— 需要解锁
 *      ⚠️「需要解锁」的判定**不在这一层**：它由 `store` 的条目方法自己抛 403
 *      （`_vaultDek()` 是唯一执行点），路由层只是把错误交给 `fail()` 收口。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @param {Object} ctx.user - 当前登录账号（拿用户名进日志）
 * @returns {void}
 */
function handleVault({ req, res, parts, method, uid, user }) {
  // ---- 不需要解锁的四个（状态 / 初始化 / 解锁 / 锁定）----
  if (parts.length === 3) {
    if (method === 'GET' && parts[2] === 'status') return json(res, 200, store.vaultStatus(uid));

    if (method === 'POST' && parts[2] === 'init') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const pw = checkMasterPassword(b);
        store.vaultInit(uid, pw);
        // ⚠️ 日志里**只有账号名与动作**，绝不出现主密码、盐、任何密钥材料（方案 §5.3 硬要求 4）
        logLine('warn', `账号「${user.username}」初始化了密码库（此后忘记主密码将无法恢复）`);
        return json(res, 201, { ok: true, ...store.vaultStatus(uid) });
      });
    }

    if (method === 'POST' && parts[2] === 'unlock') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const key = throttleKey(uid);
        const limited = loginThrottle.check(key);
        // ⚠️ 429 直接 `json()`，响应体逐字固定
        if (limited) return json(res, 429, { error: limited });
        const pw = checkMasterPassword(b);
        try {
          const r = store.vaultUnlock(uid, pw);
          loginThrottle.reset(key);
          logLine('info', `账号「${user.username}」解锁了密码库`);
          return json(res, 200, { ok: true, lockAfterSeconds: r.lockAfterSeconds });
        } catch (e) {
          // ⚠️ 只有「主密码不正确」才计入节流：密码**格式**不合法（太短）已经被上面挡掉了，
          //    而「参数损坏 / 未初始化」不是猜测行为，把它们也计数只会误伤正常用户。
          if (e && e.status === 403) {
            loginThrottle.fail(key);
            logLine('warn', `账号「${user.username}」解锁密码库失败`);
          }
          throw e;
        }
      });
    }

    if (method === 'POST' && parts[2] === 'lock') {
      store.vaultLock(uid);
      logLine('info', `账号「${user.username}」锁定了密码库`);
      return json(res, 200, { ok: true });
    }
  }

  // ---- 生成器（要解锁；放在单条之前，避免 `/generate` 被当成 id）----
  if (method === 'POST' && parts.length === 3 && parts[2] === 'generate') {
    return readBody(req, res, (b) => {
      const opts = checkVaultGenerator(b || {});
      store.vaultAssertUnlocked(uid); // 未解锁 → 403（与「谁能看密码」同一个门槛）
      return json(res, 200, store.generateVaultPassword(opts));
    });
  }

  // ---- 标签：新建（0.8.18）/ 改名 / 删除（0.4.4 起；都要解锁）----
  // ⚠️ 必须放在下面「单条」那一段**之前**：`tags` 不是 id，走到 `idParam('tags')` 就变成
  //    404 了（与 `/generate` 同一个原因）。它的两个动作都**一次改多条记录**，
  //    实现在 `store._vaultRewriteTags()`（先全部解密、全部成功才写回）。
  //    ⭐ 0.8.18 的 `POST /api/vault/tags`（`parts.length === 3`）建的是一个**空标签** ——
  //    落在 `vault_meta.tags_*` 那份**加密清单**上（见 `schema.js` 文件头），
  //    ⛔ 不是明文 `vault_tags` 表；标签名照样进不了日志（同下面两条的口径）。
  if (parts[2] === 'tags') {
    if (method === 'POST' && parts.length === 3) {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const { name } = checkVaultTagCreate(b);
        const r = store.vaultAddTag(uid, name);
        logLine('info', `账号「${user.username}」新建了一个密码库标签`);
        return json(res, r.added ? 201 : 200, r);
      });
    }
    if (method === 'POST' && parts.length === 4) {
      if (parts[3] === 'rename') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const { from, to } = checkVaultTagRename(b);
          const r = store.vaultRenameTag(uid, from, to);
          // ⚠️ 日志里只有**动作与条数**：标签名是用户内容（可能就是「银行」「公司 VPN」），
          //    与主密码同一条硬要求 —— 明文绝不进日志（方案 §5.3 硬要求 4）。
          logLine('info', `账号「${user.username}」重命名了一个密码库标签（影响 ${r.changed} 条记录）`);
          return json(res, 200, { ok: true, changed: r.changed });
        });
      }
      if (parts[3] === 'remove') {
        return readBody(req, res, (b) => {
          if (!b) throw httpError(400, 'bad body');
          const { name } = checkVaultTagRemove(b);
          const r = store.vaultRemoveTag(uid, name);
          logLine('info', `账号「${user.username}」删除了一个密码库标签（影响 ${r.changed} 条记录）`);
          return json(res, 200, { ok: true, changed: r.changed });
        });
      }
    }
  }

  // ---- 自动锁定偏好（要解锁）----
  if (method === 'PUT' && parts.length === 3 && parts[2] === 'settings') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const n = checkVaultLockMinutes(b);
      // ⭐ 009 报告 S2：本分支的注释一直写着「要解锁」，实现里却漏了这道闸 —— 于是拿着 Cookie
      //    但**没有主密码**的人（Cookie 被偷 / 共享机器没关页面）能把自动锁定从 10 分钟改成 120 分钟，
      //    把 DEK 在服务进程内存里的暴露窗口拉满 12 倍。与 `/generate` 同一个门槛、同一行写法。
      store.vaultAssertUnlocked(uid);
      store.setVaultLockMinutes(uid, n);
      logLine('info', `账号「${user.username}」把密码库自动锁定设为 ${n} 分钟`);
      return json(res, 200, { ok: true, lockMinutes: n, lockAfterSeconds: n * 60 });
    });
  }

  // ---- 列表 / 新增 ----
  if (parts.length === 2) {
    if (method === 'GET') return json(res, 200, store.listVaultEntries(uid));
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkVaultItem(b);
        // ⚠️ 密码是新增时唯一的必填项，且**在这里**查（校验层只管「带了就校验」，
        //    这样编辑时「只改标题」不会被要求重发密码）—— 与收藏夹的 url、硬件的 name 同一手法
        if (!fields.password)
          throw httpError(400, '密码不能为空（密码库不存「空密码」条目，只存用户名请填在用户名里）');
        const r = store.createVaultEntry(uid, fields);
        return json(res, 201, r);
      });
    }
    return notFound(res);
  }

  // ---- 单条 ----
  const id = idParam(parts[2]);
  if (id === null) return notFound(res);
  // ⚠️ 归属校验对**三种方法**都先做一遍，且必须在「取 DEK」之前：
  //    ① 越权与不存在必须回**同一个** 404（403 等于告诉对方「这条记录存在，只是不归你」）；
  //    ② 它只比对 `id` 与 `user_id`、不碰任何密文列，所以**未解锁时也不会泄露条目内容**；
  //    ③ ⚠️ 删/改**不能只依赖 store 层的返回值** —— `removeVaultEntry` 在越权时返回 false 而
  //       不抛错，路由层若忽略它就会回一句 `{ok:true}`（第一次跑测试时就是这么错的：
  //       乙删甲的条目拿到了 200，而那条记录其实完好无损 —— 比真被删了更难查）。
  if (!store.ownsVaultEntry(uid, id)) return notFound(res);
  if (method === 'GET' && parts.length === 3) return json(res, 200, store.getVaultEntry(uid, id));
  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const fields = checkVaultItem(b);
      // ⚠️ 密码**带了就不许清空**：这条记录的意义就是「存着一个密码」，
      //    清空它等于把条目变成一条没有内容的空行（要删就删整条，那个动作是明确的）
      if (Object.prototype.hasOwnProperty.call(fields, 'password') && !fields.password) {
        throw httpError(400, '密码不能为空（要清掉这条记录请直接删除它）');
      }
      store.updateVaultEntry(uid, id, fields);
      return json(res, 200, { ok: true });
    });
  }
  if (method === 'DELETE' && parts.length === 3) {
    store.removeVaultEntry(uid, id);
    return json(res, 200, { ok: true });
  }
  return notFound(res);
}

// ⭐ 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/vault` 上
module.exports = { vault: handleVault };
