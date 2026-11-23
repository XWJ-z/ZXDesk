/**
 * modules/vault/routes.js —— 密码库路由
 *
 * 功能：`handleVault` 一处收全部密码库接口 —— 状态、初始化、解锁 / 锁定、条目增删改查、
 * 密码生成器、自动锁定偏好、标签改名 / 删除。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
  // 「空密码」的唯一判据（`' '` / 全角空格 / 零宽空格 / BOM 全部算空）
  isBlankPassword,
} = require('../../core/validate.js');

/**
 * 功能：给解锁接口用的节流键 —— **按账号 id**，并带 `vault:` 前缀与登录节流隔离。
 *
 * 说明：⚠️ 不能按主密码、也不能按用户名：前者会把密码本身写进内存键（没有任何道理），
 * （换账号即可绕过），但那个局限在这里无关紧要 —— 攻击者绕过的同时也就换了一个库。
 *
 */
/**
 */
function checkPw(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (src.masterPassword !== undefined && src.masterPassword !== null) return checkMasterPassword(src);
  return checkMasterPassword({ masterPassword: src.password });
}

function throttleKey(uid) {
  return `vault:${Number(uid)}`;
}

/**
 * 功能：处理 `/api/vault` 及其子路径 —— 密码库的解锁与条目增删改查。
 *
 * 说明：路由表（`parts = ['api','vault', …]`）——
 * `GET    /api/vault/status`      状态（已初始化 / 已解锁 / 自动锁定秒数）—— **不需要解锁**
 * `POST   /api/vault/init`        首次设置主密码（仅未初始化时允许）—— 不需要解锁
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
        logLine('warn', `账号「${user.username}」初始化了密码库（此后忘记主密码将无法恢复）`);
        return json(res, 201, { ok: true, ...store.vaultStatus(uid) });
      });
    }

    if (method === 'POST' && parts[2] === 'unlock') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const key = throttleKey(uid);
        const limited = loginThrottle.check(key);
        // 429 直接 `json()`，响应体逐字固定
        if (limited) return json(res, 429, { error: limited });
        const pw = checkMasterPassword(b);
        try {
          const r = store.vaultUnlock(uid, pw);
          loginThrottle.reset(key);
          logLine('info', `账号「${user.username}」解锁了密码库`);
          return json(res, 200, { ok: true, lockAfterSeconds: r.lockAfterSeconds });
        } catch (e) {
          // 只有「主密码不正确」才计入节流：密码**格式**不合法（太短）已经被上面挡掉了，
          // 而「参数损坏 / 未初始化」不是猜测行为，把它们也计数只会误伤正常用户。
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

  // 标签动作 `tags/rename` / `tags/delete`：一次改多条记录，必须排在「单条」那一段之前
  // （`tags` 不是 id，走到 `idParam('tags')` 会变成 404）。实现在 `store._vaultRewriteTags()`。
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
          // 日志里只有**动作与条数**：标签名是用户内容（可能就是「银行」「公司 VPN」），
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

  // 必须排在下面「单条」那一段**之前**：`key` / `keys` 都不是 id，
  // 走到 `idParam('key')` 就变成 404 了（与 `/generate`、`/tags` 同一个原因）。
  // 响应体里绝不出现任何密钥材料（`kid` 是指纹，可以回）。
  if (parts[2] === 'key' && parts.length === 4) {
    if (method !== 'POST') return notFound(res);
    if (parts[3] === 'export') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const key = throttleKey(uid);
        const limited = loginThrottle.check(key);
        if (limited) return json(res, 429, { error: limited });
        const pw = checkPw(b);
        let out;
        try {
          out = store.keyExport(uid, pw);
        } catch (e) {
          // 只有「主密码不正确」才计入节流（与解锁同一条口径）
          if (e && e.status === 403) loginThrottle.fail(key);
          throw e;
        }
        loginThrottle.reset(key);
        const buf = Buffer.from(JSON.stringify(out, null, 2), 'utf8');
        const day = String(out.created_at || '').slice(0, 10).replace(/-/g, '') || 'key';
        // 文件名里有账号名（那是用户自己的信息），但 ⛔ 不含任何密钥材料
        const name = `zxdesk-key-${String(user.username || 'vault')}-${day}.zxkey`;
        // 日志里只有「谁导出了钥匙」——⛔ 不记文件名（文件名带账号名）
        logLine('warn', `账号「${user.username}」导出了钥匙文件（这是全部加密数据的总钥匙）`);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': String(buf.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(buf);
      });
    }
    if (parts[3] === 'inspect') {
      // **不验密码、不落库**：只回答「这是谁的钥匙、编号多少、以前导过没有」。
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const tkey = `reader:import:${Number(uid)}`;
        const limited = loginThrottle.check(tkey);
        if (limited) return json(res, 429, { error: limited });
        // 与 import 同样允许两种形态（对象 / 原始文本）
        let file = b.file;
        if (typeof file === 'string') {
          if (Buffer.byteLength(file, 'utf8') > 64 * 1024) {
            throw httpError(400, '这不是一个有效的钥匙文件');
          }
          try {
            file = JSON.parse(file);
          } catch (_e) {
            throw httpError(400, '这不是一个有效的钥匙文件');
          }
        }
        const r = store.keyInspect(uid, file);
        // 日志只说「谁识别了一把钥匙」——⛔ 不记编号、不记来源账号（那两样进日志没有排查价值）
        logLine('info', `账号「${user.username}」识别了一把钥匙文件`);
        return json(res, 200, r);
      });
    }
    if (parts[3] === 'import') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const tkey = `reader:import:${Number(uid)}`;
        const limited = loginThrottle.check(tkey);
        if (limited) return json(res, 429, { error: limited });
        const pw = checkPw(b);
        // 允许两种形态：直接给对象（前端 `JSON.parse` 过），或给原始文本（用户粘贴进来的）
        let file = b.file;
        if (typeof file === 'string') {
          if (Buffer.byteLength(file, 'utf8') > 64 * 1024) {
            throw httpError(400, '这不是一个有效的钥匙文件');
          }
          try {
            file = JSON.parse(file);
          } catch (_e) {
            throw httpError(400, '这不是一个有效的钥匙文件');
          }
        }
        let r;
        try {
          r = store.keyImport(uid, file, pw);
        } catch (e) {
          if (e && e.status === 403) loginThrottle.fail(tkey);
          throw e;
        }
        loginThrottle.reset(tkey);
        logLine(
          'warn',
          `账号「${user.username}」导入了一把钥匙${r.already ? '（本来就在）' : ''}（来自账号「${r.owner_name || r.owner_uid || '未知'}」）`,
        );
        return json(res, r.already ? 200 : 201, Object.assign({ ok: true }, r));
      });
    }
    return notFound(res);
  }
  if (parts[2] === 'keys' && parts.length <= 4) {
    if (parts.length === 3 && method === 'GET') {
      return json(res, 200, { keys: store.listImportedKeys(uid) });
    }
    if (parts.length === 4 && method === 'DELETE') {
      const kid = String(parts[3] || '');
      // `kid` 是 16 位十六进制（`sha256` 前缀）—— 形状不对直接 404，别把它当自由文本塞进 SQL
      if (!/^[0-9a-f]{16}$/.test(kid)) return notFound(res);
      const r = store.removeImportedKey(uid, kid);
      if (!r.removed) return notFound(res);
      logLine('info', `账号「${user.username}」删掉了一把导入的钥匙`);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }

  // ---- 自动锁定偏好（要解锁）----
  if (method === 'PUT' && parts.length === 3 && parts[2] === 'settings') {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const n = checkVaultLockMinutes(b);
      // 009 报告 S2：本分支的注释一直写着「要解锁」，实现里却漏了这道闸 —— 于是拿着 Cookie
      // 但**没有主密码**的人（Cookie 被偷 / 共享机器没关页面）能把自动锁定从 10 分钟改成 120 分钟，
      // 把 DEK 在服务进程内存里的暴露窗口拉满 12 倍。与 `/generate` 同一个门槛、同一行写法。
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
        // 密码是新增时唯一的必填项，且**在这里**查（校验层只管「带了就校验」，
        // 这样编辑时「只改标题」不会被要求重发密码）—— 与收藏夹的 url、硬件的 name 同一手法
        // 前者是**真假值**判据，而 `' '` 是真值 ⇒ 「只敲一个空格」照样 201（实测过）。
        if (isBlankPassword(fields.password))
          throw httpError(
            400,
            '密码不能为空（密码库不存「空密码」条目，只存用户名请填在用户名里）—— 只输空格不算密码',
          );
        const r = store.createVaultEntry(uid, fields);
        return json(res, 201, r);
      });
    }
    return notFound(res);
  }

  // ---- 单条 ----
  const id = idParam(parts[2]);
  if (id === null) return notFound(res);
  // 归属校验对**三种方法**都先做一遍，且必须在「取 DEK」之前：
  // ① 越权与不存在必须回**同一个** 404（403 等于告诉对方「这条记录存在，只是不归你」）；
  // ② 它只比对 `id` 与 `user_id`、不碰任何密文列，所以**未解锁时也不会泄露条目内容**；
  if (!store.ownsVaultEntry(uid, id)) return notFound(res);
  if (method === 'GET' && parts.length === 3) return json(res, 200, store.getVaultEntry(uid, id));
  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const fields = checkVaultItem(b);
      // 清空它等于把条目变成一条没有内容的空行（要删就删整条，那个动作是明确的）
      // 同样的真假值漏洞（`' '` 是真值）—— 换 `isBlankPassword()`。
      // 判据仍然只在「带了 `password` 键」时才跑：不带这个键的编辑（只改标题 / 标签）
      if (Object.prototype.hasOwnProperty.call(fields, 'password') && isBlankPassword(fields.password)) {
        throw httpError(400, '密码不能为空（要清掉这条记录请直接删除它）—— 只输空格不算密码');
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

// 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/vault` 上
module.exports = { vault: handleVault };
