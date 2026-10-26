'use strict';
/**
 * modules/ai/lib/openai-client.js —— ai辅助任务的**出网客户端**（0.6.0）
 *
 * 功能：本模块全部对外请求的唯一出口 —— 按 `base_url` 的协议选 `node:http` / `node:https`
 *      （**零 npm 依赖**，铁律 1 / 5），提供三个动作：
 *        · `listModels()`   测连通（GET `{base}/models`，省额度）；
 *        · `chatOnce()`     一次问答（POST `/chat/completions`，非流式 —— 指挥建任务用）；
 *        · `chatStream()`   流式问答（同一路径 + `stream:true`，SSE 逐帧回调 —— 对话页聊天用）；
 *      另导出 `parseLooseJson()`（模型回复的三层兜底 JSON 解析，指挥建任务用）。
 *
 * ⭐ **双闸超时**：
 *      · **建连闸**：从发请求到收到上游响应头，超过 `CONNECT_TIMEOUT_MS` 就 `req.destroy()` ——
 *        它抓的是「地址填错 / 对方不在线」这种永远握不上手的情形；
 *      · **总时长闸**：`startGate()` 的**外挂守卫**与消费流程 `Promise.race` ——
 *        从请求发出到**响应体消费完**的全流程都受它管。⚠️ 两个实测过的坑，别改回去：
 *        ① `req.setTimeout` 是 **socket 空闲超时**，流式响应只要帧不断就永不触发，总时长必须外挂；
 *        ② 闸门不能在「响应头到达」时就拆 —— 那样流式主体就不受控了（实测踩过：30 秒的闸
 *        只护住了建连，模型慢慢吐字的整段过程无人看管）。
 *
 * ⭐ **停止也是闸门的一部分**：`shouldAbort()` 由调用方提供（客户端断开 / 用户点停止），
 *      守卫每 250ms 轮询一次，到真就 `req.destroy()` 掐掉上游 —— 人走了还继续烧上游的额度
 *      是最坏的静默浪费。
 *
 * ⭐ **错误转译在这里一次做完**：上游的状态码 / 网络错误 / 垃圾响应都翻成**用户能照着做**的中文
 *      （`kind` + `message`），`message` 会被接口层原样带给前端；⚠️ **上游的错误响应体绝不透传**、
 *      **本文件一次日志都不打**（key 与消息原文一个字都不落 —— 方案 §八 红线 6 / 7）。
 *
 * ⭐ **本文件是纯 lib**：不 require 数据库 / context / 路由，输入输出全是参数与 Promise ——
 *      可独立测试（`ttt/test/ai.test.js` 全部打本地 stub，绝不打真实外网）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.61
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/11-AI辅助任务-1期.md、modules/vault/lib/crypto.js
 */

const http = require('node:http');
const https = require('node:https');
const toolsLib = require('./tools.js'); // ⭐ 只为了「已授权工具说明」：那个文件不 require 任何东西

/**
 * 建连闸（毫秒）：从发出请求到收到**响应头**的上限。
 * 本机 RTT≈0.1ms 没有参考意义；跨公网到模型接口的正常握手在 1~3 秒，10 秒已经非常宽裕。
 * @type {number}
 */
const CONNECT_TIMEOUT_MS = 10000;

/**
 * 总时长闸（毫秒）：这一次请求**从发出到响应体消费完**最多等多久（外挂守卫，与消费流程竞速）。
 * 取 30 秒 = 调研报告 §3.3 的建议默认值：模型生成一条任务 JSON 通常几秒，聊天长答也在 20 秒内。
 * ⚠️ 前端的等待上界必须**大于**这个数（片段里用 90 秒），否则前端先超时、错误话术被抢成「请求超时了」。
 * @type {number}
 */
const TOTAL_TIMEOUT_MS = 30000;

/**
 * 单次请求的 `max_tokens` 上限：聊天长答与任务 JSON 都够用，同时防止上游跑飞烧额度。
 * @type {number}
 */
const MAX_TOKENS = 2000;

/** OpenAI 兼容接口的两个路径（与 `base_url` 的拼接规则只在 `joinUrl()` 一处收口） @type {string} */
const CHAT_PATH = '/chat/completions';
const MODELS_PATH = '/models';

/** 守卫的轮询间隔（毫秒）：停止 / 超时的感知上界 @type {number} */
const GATE_TICK_MS = 250;

/**
 * ⭐ 用户话术里的**配置入口提示**（唯一一份，2 期修正）—— 2 期起 AI 的配置**不再住在「设置页的一栏」**里，
 *    搬到了它自己的位置：电脑端是左侧栏的「AI 辅助任务」卡片，手机端在「更多」页里那一行。
 *    ⚠️ 后端不知道这次请求来自哪一端 ⇒ 话术里**两端的位置都要说**，别只写一侧。
 *    ⚠️ 别把「设置页」/「设置 → AI 辅助任务」写回任何**用户可见字符串**：用户照旧话术去设置页
 *      找不到那一栏（已搬走），可自愈的问题会变成死路。`ttt/test/ai.test.js` 有一条红线用例
 *      扫本文件与 `store.js` 里 `aiError(...)` / `badRequest(...)` 的字符串字面量咬住这件事。
 * @type {string}
 */
const CFG_AT = '『AI 辅助任务』（电脑端左侧卡片 / 手机端在「更多」页）';

/**
 * ⭐ 用户话术：填了内网 / 本机地址但没打开开关时用（009 报告 R1）。
 *    ⚠️ 与 `CFG_AT` 同一条规矩：**只有这一份**，别再各处手写（`ai.test.js` 有红线用例盯着）。
 * @type {string}
 */
const PRIVATE_HINT =
  '这个地址在内网 / 本机网段，默认不允许访问 —— 要用局域网或本机的模型服务' +
  '（例如 http://127.0.0.1:11434 的 ollama），请先打开「允许访问内网地址」开关（就在接口地址下面）';

/**
 * 功能：判断一个接口地址是不是指向**内网 / 本机 / 链路本地**（009 报告 R1）。
 *
 * 说明：⭐ 为什么要有它：接口地址是**成员自己填的**，而错误转译表能把「连不上 / 不存在 / 超时」
 *      分成三种文案 ⇒ 不拦的话，局域网里任何一个能注册的人都能拿它扫 NAS 所在内网
 *      （叠加「自主注册默认开」与出网节流，可达人群与速率都不小）。
 *      ⚠️ 判定只覆盖**地址段**（不看域名解析结果）—— 刻意如此：解析要在出网那一刻才知道，
 *      而这一层是**保存与出网前的静态判定**，宁可在 DNS 那侧漏（真要防到底得靠网络层策略）。
 *      ⚠️ 不做 IP 归一化（`2130706433` 这类十进制写法 `new URL()` 会自己处理成 `127.0.0.1`）。
 *
 * @param {string} baseUrl - 用户填的接口地址（可能不合法 —— 不合法时返回 false，交给地址校验去报错）
 * @returns {boolean} 命中内网 / 本机 / 链路本地返回 true
 */
function isPrivateBaseUrl(baseUrl) {
  let host;
  try {
    host = new URL(String(baseUrl || '').trim()).hostname;
  } catch (_e) {
    return false; // 地址本身就不合法：让「地址不合法」那条话术去说，别抢它的活
  }
  const h = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, ''); // IPv6 在 hostname 里带方括号
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:')) return true;
  if (h === '0.0.0.0') return true;
  if (/^(127|10|192\.168|169\.254)\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

/**
 * 功能：把用户填的 `base_url` 拼上接口路径 —— **`/v1` 有无都认**。
 *
 * 说明：⚠️ 拼接规则只有这一处：去掉结尾斜杠后直接接路径。
 *      `https://api.x.com/v1` + `/chat/completions` → `https://api.x.com/v1/chat/completions`；
 *      `https://api.x.com`（有的网关这么发）→ `https://api.x.com/chat/completions` —— 两种都放行，
 *      由用户按自己服务商的文档填（one-api / ollama / DeepSeek 对两种都认）。
 *
 * @param {string} baseUrl - 用户配置的接口地址（已过 `checkAiConfig` 的 http/https 校验）
 * @param {string} path - 接口路径（`CHAT_PATH` / `MODELS_PATH`）
 * @returns {URL} 拼好的 URL 对象；地址非法时抛出（配置层已拦，这里是最后一道保险）
 */
function joinUrl(baseUrl, path) {
  return new URL(
    String(baseUrl || '')
      .trim()
      .replace(/\/+$/, '') + path,
  );
}

/**
 * 功能：造一个带 `kind`（错误类别）与用户可读 `message` 的错误对象。
 *
 * 说明：⚠️ `message` 会被接口层**原样**带给前端（SSE error 帧 / `{ok:false, reason}`），
 *      所以它必须是**用户能照着做**的话；⚠️ 绝不把上游错误体、key、消息原文拼进 message。
 *
 * @param {string} kind - 错误类别（auth / rate / server / request / network / timeout / format / abort）
 * @param {string} message - 用户可读的中文说明
 * @returns {Error} 带 `kind` 的错误
 */
function aiError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/**
 * 功能：把一次上游失败翻成「类别 + 用户话术」—— 错误转译表。
 *
 * 说明：只认这几类，别的都落「接口出错了」兜底；⚠️ 网络错误的原始 message（含地址）**不进**结果。
 *
 * @param {number} status - 上游 HTTP 状态码（0 = 没拿到响应，网络层/超时类）
 * @param {string} rawKind - 网络层错误代号（如 ECONNREFUSED / ECONNRESET / 超时自造的 'timeout'）
 * @returns {Error} 带 `kind` 与用户话术的错误
 */
function translate(status, rawKind) {
  if (rawKind === 'timeout') return aiError('timeout', 'AI 接口响应超时了，请稍后再试');
  if (rawKind === 'abort') return aiError('abort', '这次请求已停止');
  if (status === 401 || status === 403) return aiError('auth', `API Key 不对或没有权限，请到${CFG_AT}检查密钥`);
  if (status === 429) return aiError('rate', '额度不足或被限流了，请稍后再试');
  if (status >= 500) return aiError('server', 'AI 接口出错了，请稍后再试');
  if (status >= 400) return aiError('request', 'AI 接口拒绝了这次请求，请检查模型名等配置');
  if (rawKind === 'ENOTFOUND' || rawKind === 'EAI_AGAIN')
    return aiError('network', '找不到这个接口地址，请检查是否填对');
  if (rawKind === 'ECONNREFUSED' || rawKind === 'ECONNRESET' || rawKind === 'EPROTO' || rawKind === 'EHOSTUNREACH') {
    return aiError('network', '连不上 AI 接口，请检查地址与网络');
  }
  if (rawKind === 'format') return aiError('format', 'AI 接口返回了无法理解的内容，请重试');
  return aiError('server', 'AI 接口出错了，请稍后再试');
}

/**
 * 功能：起一个「总时长 + 停止」的**外挂守卫**，与消费流程竞速。
 *
 * 说明：⭐ 从调用一刻起计时，**响应头到了也不拆**（总时长管的是全流程）；
 *      每 250ms 查一次 —— `shouldAbort()` 为真（客户端走了 / 用户点了停止）或计时到了，
 *      就 `req.destroy()` 掐掉上游并 reject 转译错误。`dispose()` 由消费流程收尾时调用
 *      （守卫没开火就正常拆掉，不留悬挂计时器）。
 *      ⚠️ 请求侧必须在 `mod.request()` 造出请求对象后调 `attachReq(req)` 登记 ——
 *      守卫开火时手里得有东西可掐。
 *
 * @param {{totalMs: number, shouldAbort: ?Function}} copts - 守卫参数
 * @returns {{promise: Promise.<never>, dispose: Function, attachReq: Function}} 竞速用的 promise、
 *          正常收尾的拆钩、与请求对象的登记口
 */
function startGate(copts) {
  let timer = null;
  let req = null;
  const promise = new Promise((_resolve, reject) => {
    const t0 = Date.now();
    const fire = (err) => {
      clearInterval(timer);
      timer = null;
      try {
        if (req) req.destroy();
      } catch (_e) {
        /* 已经没了 */
      }
      reject(err);
    };
    timer = setInterval(() => {
      if (copts.shouldAbort && copts.shouldAbort()) return fire(translate(0, 'abort'));
      if (Date.now() - t0 >= copts.totalMs) return fire(translate(0, 'timeout'));
    }, GATE_TICK_MS);
  });
  return { promise, dispose: () => clearInterval(timer), attachReq: (r) => (req = r) };
}

/**
 * 功能：竞速包装 —— 消费流程与守卫赛跑，谁先到谁说了算；收尾时把守卫拆干净。
 *
 * 说明：⚠️ 守卫抢先时，消费流程还会在其自己的异步上下文里收尾（流被 destroy 后自然终止），
 *      它随后的失败必须**吞掉**（`work.catch(() => {})`），否则就是一条 unhandledRejection ——
 *      给用户的错误以守卫的转译话术为准。
 *
 * @param {Function} work - 返回消费流程 promise 的工厂（入参是守卫句柄）
 * @param {{totalMs: number, shouldAbort: ?Function}} copts - 守卫参数
 * @returns {Promise.<*>} 胜者的结果
 */
function raceGate(work, copts) {
  const gate = startGate(copts);
  const p = work(gate);
  p.catch(() => {}); // 守卫抢先时后台收尾的失败不上报（话术以守卫为准）
  return Promise.race([p, gate.promise]).finally(() => gate.dispose());
}

/**
 * 功能：发一次上游请求，接住**响应头**（建连闸在这里兑现）。
 *
 * 说明：⭐ 返回 `{ req, res }` 交给调用方继续消费响应体 —— `chatOnce` 全量收、`chatStream` 逐帧读。
 *      失败路径在这里收口（建连闸超时 / 网络层错误 / 密钥非法字符）；总时长与停止归 `startGate()` 管。
 *      ⚠️ 造出来的请求对象经 `copts.onReq` 登记给守卫 —— 那是它开火时唯一能掐的东西。
 *
 * @param {{baseUrl: string, path: string, method: string, apiKey: string, body: ?string,
 *          connectMs: number, onReq: Function}} opts - 请求参数
 * @returns {Promise.<{req: Object, res: Object}>} 响应头到达后的请求/响应对
 */
function requestUpstream(opts) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = joinUrl(opts.baseUrl, opts.path);
    } catch (_e) {
      return reject(aiError('request', `接口地址不合法，请到${CFG_AT}检查`));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { Authorization: `Bearer ${opts.apiKey}` };
    if (opts.body !== undefined && opts.body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    let settled = false;
    let connectTimer = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      fn(arg);
    };
    // ⭐ 密钥 / 地址里的非法字符（HTTP 头只认 latin-1）是**同步** throw —— 在这里接住翻成人话，
    //    绝不把 Node 的原始报错（含配置内容）漏给调用方
    const badCharError = () =>
      aiError('request', `接口配置里有无法发送的字符（一般是密钥没复制完整），请到${CFG_AT}重新粘贴`);
    let req;
    try {
      req = mod.request(url, { method: opts.method, headers }, (res) => {
        // 响应头到了 = 建连成功，建连闸拆掉（总时长闸在守卫里继续管全程）
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        done(resolve, { req, res });
      });
    } catch (_e) {
      return reject(badCharError());
    }
    opts.onReq(req);
    // ⭐ 建连闸：到点还没拿到响应头就掐 —— 「地址填错 / 对方不在线」在这里被抓住
    connectTimer = setTimeout(() => {
      req.destroy();
      done(reject, translate(0, 'timeout'));
    }, opts.connectMs);
    req.on('error', (e) => {
      req.destroy();
      done(reject, translate(0, e && (e.code || e.name)));
    });
    try {
      if (opts.body !== undefined && opts.body !== null) req.end(opts.body);
      else req.end();
    } catch (_e) {
      req.destroy();
      done(reject, badCharError());
    }
  });
}

/**
 * 功能：把上游的**错误状态码**翻成转译错误（读一小段响应体只为防止连接悬挂，内容不外传）。
 * @param {Object} res - 上游响应
 * @returns {Promise.<Error>} 转译后的错误
 */
async function errorFromStatus(res) {
  try {
    const chunks = [];
    for await (const c of res) {
      chunks.push(c);
      if (chunks.length > 8) break; // 读一小段就够了，避免对端不关连接时挂住
    }
  } catch (_e) {
    /* 响应体读不到就只按状态码翻 */
  }
  return translate(res.statusCode, '');
}

/**
 * 功能：非流式问答 —— POST `/chat/completions`，收全量响应，返回第一条回复文本。
 *
 * @param {Object} opts - 请求参数
 * @param {string} opts.baseUrl - 接口地址（http/https）
 * @param {string} opts.apiKey - API Key 明文（只进 Authorization 头，绝不落日志）
 * @param {string} opts.model - 模型名
 * @param {Array.<{role: string, content: string}>} opts.messages - 消息数组（V1 只有一两条）
 * @param {{connectMs?: number, totalMs?: number, shouldAbort?: Function}} [copts] - 可选：测试用的小超时 / 中止钩子
 * @returns {Promise.<string>} 模型回复文本
 * @throws {Error} 带 `kind` 的转译错误（响应不是 200 / 回复缺字段 / 响应体不是 JSON）
 */
async function chatOnce(opts, copts) {
  const c = copts || {};
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    max_tokens: MAX_TOKENS,
  });
  return raceGate(async (gate) => {
    const { res } = await requestUpstream({
      baseUrl: opts.baseUrl,
      path: CHAT_PATH,
      method: 'POST',
      apiKey: opts.apiKey,
      body,
      connectMs: c.connectMs || CONNECT_TIMEOUT_MS,
      onReq: gate.attachReq,
    });
    if (res.statusCode !== 200) throw await errorFromStatus(res);
    let raw = '';
    try {
      for await (const chunk of res) raw += chunk.toString('utf8');
    } catch (_e) {
      throw translate(0, 'format');
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch (_e) {
      throw translate(0, 'format');
    }
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof content !== 'string') throw translate(0, 'format');
    return content;
  }, c);
}

/**
 * 功能：流式问答 —— 同一路径 + `stream:true`，SSE 逐帧解析，`onDelta(text)` 逐段回调。
 *
 * 说明：SSE 的帧格式是 `data: {json}\n\n`（`chat/stream.js` 的 `frame()` 同源）；
 *      ⚠️ 网络分片可能把一帧撕成两半，所以**必须自己缓冲**到 `\n\n` 再解析。
 *      `[DONE]` 是 OpenAI 兼容接口的结束标记。回调抛错 = 调用方不想要了，掐上游并原样上抛。
 *
 * @param {Object} opts - 请求参数（同 `chatOnce`，另加）
 * @param {Function} opts.onDelta - 每收到一段增量文本就调用（入参是该段文本）
 * @param {?Function} [opts.onOpen] - 可选：上游回 200（= 已被接受）时调用一次 ——
 *        调用方用它决定「用户消息落库 / 发 start 帧」的时机
 * @param {{connectMs?: number, totalMs?: number, shouldAbort?: Function}} [copts] - 可选（同 `chatOnce`）
 * @returns {Promise.<string>} 拼好的完整回复文本
 * @throws {Error} 带 `kind` 的转译错误
 */
async function chatStream(opts, copts) {
  const c = copts || {};
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    max_tokens: MAX_TOKENS,
    stream: true,
  });
  return raceGate(async (gate) => {
    const { res } = await requestUpstream({
      baseUrl: opts.baseUrl,
      path: CHAT_PATH,
      method: 'POST',
      apiKey: opts.apiKey,
      body,
      connectMs: c.connectMs || CONNECT_TIMEOUT_MS,
      onReq: gate.attachReq,
    });
    if (res.statusCode !== 200) throw await errorFromStatus(res);
    // ⭐ 「上游接受了」以「状态码 200」为准 —— 401 / 429 不算接受，调用方据此决定
    //    用户消息落不入库（没被上游收到的东西不进会话历史）
    if (opts.onOpen) {
      try {
        opts.onOpen();
      } catch (_e) {
        /* 回调失败不打断流本身 */
      }
    }
    let full = '';
    let buf = '';
    for await (const chunk of res) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frameText = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frameText.split('\n')) {
          const m = /^data:\s?(.*)$/.exec(line.trim());
          if (!m) continue; // 注释帧（`: ping` 一类）与空行直接跳过
          const payload = m[1];
          if (payload === '[DONE]') return full;
          let j;
          try {
            j = JSON.parse(payload);
          } catch (_e) {
            continue; // 半截帧 / 非 JSON 的行当不存在（长连接不因一帧坏数据断掉）
          }
          const piece = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (typeof piece === 'string' && piece) {
            full += piece;
            if (opts.onDelta) opts.onDelta(piece);
          }
        }
      }
    }
    return full;
  }, c);
}

/**
 * 功能：测连通 —— GET `{base}/models`（只验「地址 + key + 网络」通不通，**不烧对话额度**）。
 * @param {Object} opts - `{ baseUrl, apiKey }`
 * @param {{connectMs?: number, totalMs?: number}} [copts] - 可选：测试用的小超时
 * @returns {Promise.<true>} 通了返回 true（调用方自己计时）
 * @throws {Error} 带 `kind` 的转译错误
 */
async function listModels(opts, copts) {
  const c = copts || {};
  return raceGate(async (gate) => {
    const { res } = await requestUpstream({
      baseUrl: opts.baseUrl,
      path: MODELS_PATH,
      method: 'GET',
      apiKey: opts.apiKey,
      connectMs: c.connectMs || CONNECT_TIMEOUT_MS,
      onReq: gate.attachReq,
    });
    if (res.statusCode !== 200) throw await errorFromStatus(res);
    try {
      for await (const _c of res) break; // 把响应体读掉一行，让连接正常收尾
    } catch (_e) {
      /* 读不动也当通 —— 状态码 200 已经说明鉴权与地址都对 */
    }
    return true;
  }, c);
}

/**
 * 功能：模型回复的**三层兜底 JSON 解析**。
 *
 * 说明：依次尝试 —— ① 直接 parse；② 剥掉 ```json 围栏后 parse；
 *      ③ 从文本里截出**第一个配平的** `{…}` / `[…]` 块再 parse（模型爱在 JSON 前后加客气话）。
 *      三层都失败返回 null（调用方报 400 `reason:'format'`，绝不猜）。
 *      ⚠️ 字符串字面量里的引号 / 转义必须跳过，否则配平扫描会被 `"说}"` 这类内容骗走。
 *
 * @param {string} text - 模型回复原文
 * @returns {?*} 解析出的值；三层都失败为 null
 */
function parseLooseJson(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_e) {
    /* 第一层失败，继续 */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_e) {
      /* 第二层失败，继续 */
    }
  }
  const open = s.search(/[{[]/);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(open, i + 1));
        } catch (_e) {
          return null;
        }
      }
    }
  }
  return null;
}

// ==================== 3 期：文本协议的工具面 ====================
//
// ⚠️ 只 require 工具目录（`lib/tools.js`）—— 那个文件刻意不 require 任何东西，所以这里
//    不会顺着装配链把 `core/context.js` 拉进来（一 require 就建库，存储层单测会失去独立性）。

/**
 * 功能：拼「你可以用的工具」这一段 system 提示 —— ⭐ **只写已授权的**（方案 §13.2 步骤 2-3）。
 *
 * 说明：⭐ 这是文本协议（方案 §4.6 走 ①）：服务端在提示里约定「需要数据就输出一个
 *      `{"tool":…,"args":…}`」，解析后执行、把结果回灌为下一条消息。
 *      ⚠️ **没开工具 / 读与写一条都没授权 ⇒ 回空串** —— 出网请求体里因此一条工具说明都不带，
 *      与「没这个功能」时的请求逐字相同（用例 1 咬的就是这一点）。
 *      ⚠️ 只列**已授权**的那几条：列了不给，等于诱导模型去试，然后每轮都被拒。
 *      ⚠️ 方案 §4.3：读工具是「现在 / 占用 / 事情」一套 —— 只给其中一部分时**必须说清**
 *      「你的信息不完整」，否则模型会拿半份数据排出个像模像样的废计划。
 *
 * ⭐⭐ **0.7.8 修（「确认卡从上线起就不可达」那条缺陷）**：**提示词只许承诺模型真有的能力**。
 *      原来的实现只筛 `mode === 'read'` ⇒ 唯一的写工具 `tasks.propose_create` **从来不进提示词**，
 *      可 `CHAT_SYSTEM` 却写着「你提出的建议会变成一张待确认的卡片」⇒ 模型只能**用文字模仿**
 *      一张卡、再编一句「卡片已经发出去了」（正是提示词叫它别做的事）。三处一起改：
 *      · 读 / 写**分开筛**（授权判据仍走 `toolsLib.isAuthorized()` 那**一处**）；
 *      · 「一条都没有」要看**两者都空**（原来只判读 ⇒ **只授权写、不授权读**时返回空串，
 *        写工具照样不可达 —— 这是同一个 bug 的第二个入口）；
 *      · **没有写工具授权时必须明说「这项能力没开」** —— 旧提示词的病根不是「说错了」，
 *        而是**只说了一半**：它只写了「有卡片」，从没说「你现在没有」。
 *      ⚠️ 写工具段里⛔ 不写代码里的护栏（一次最多几条、最多几轮调用）——
 *      护栏在代码里，写进提示词只会被模型当成「必须复述的规则」。
 *
 * @param {{enabled: boolean, read: Array.<string>, write: Array.<string>}} auth - `store.aiAuthorizedTools()` 的产物
 * @returns {string} 提示词段落；不该带工具时为**空串**
 */
function toolsPrompt(auth) {
  const a = auth || {};
  if (!a.enabled) return '';
  // ⭐ 0.7.8：读 / 写分开筛（原来只筛读 —— 写工具因此从来没机会出现在提示词里）
  const readOn = toolsLib.TOOLS.filter((t) => t.mode === 'read' && toolsLib.isAuthorized(t, a));
  const writeOn = toolsLib.TOOLS.filter((t) => t.mode === 'write' && toolsLib.isAuthorized(t, a));
  // ⚠️⭐ 0.7.8：**两者都空**才是「一条工具都没有」。原来只判 `readOn` ⇒
  //    「只授权写、不授权读」时这里就早退了，写工具永远到不了模型手里。
  if (!readOn.length && !writeOn.length) return '';
  const lines = [
    '【你可以用的工具】',
    '当回答需要用户自己的数据（他的任务、他的课表、他的账本）时，不要猜：先**只**输出一个 JSON 对象，',
    '形如 {"tool":"工具名","args":{…}}，不要输出任何其它字。服务端会执行它，并把结果发给你；',
    '你拿到结果后再用简体中文回答用户。可用工具：',
    '· now.info —— 现在是什么时候（日期 / 周几 / 当前时刻 / 本周剩余天数）。无入参。',
    // ⭐⭐ 0.8.55：「给ai更高的查询条件，可以让它自己选择日期、筛选条件」。
    //    这段必须写在**最前面**：模型原来会老老实实回「账单工具只有四档，我做不到」——
    //    数据明明在库里，是它不知道自己有权限自己算日期。
    '⭐⭐ 关于日期：下面这些工具大多可以用 {"from":"2026-09-01","to":"2026-09-30"} **自己指定区间**' +
      '（YYYY-MM-DD，含头含尾，一次最多 366 天）。用户说「上个月」「9 月那两周」「国庆那几天」时，' +
      '你要**自己按今天的日期算好区间再传**，⛔ 不要因为枚举里没有那一档就说「做不到」。',
  ];
  if (a.read.includes('tasks')) {
    lines.push(
      '· tasks.query —— 用户的任务（标题 / 截止日期 / 重要 / 紧急 / 完成状态 / 所属项目 / 任务类型）。' +
        '入参 {"range":"today"}，range 取 today（今日）、week（本周）、overdue（逾期）、open（全部未完成）；' +
        '也可以自己给日期：{"from":"2026-09-01","to":"2026-09-30"}（按截止日筛，含已完成的，每条带 status）。' +
        '⚠️⭐ 任务有三种类型（kind：plain 普通 / window 限时完成 / cycle 周期打卡）。' +
        '**周期任务（cycle）没有「逾期」这个概念** —— 它的截止日期是这一轮周期的终点，' +
        '⛔ 别把它说成「你逾期了」；它也不会出现在 overdue 那个范围里。',
    );
  }
  if (a.read.includes('timetable')) {
    lines.push(
      '· timetable.range —— 用户的占用时段（拿来判断哪些时间没空）。' +
        '入参 {"days":"today"}，days 取 today（今天）、week（今天起 7 天）、next_week（下周一~下周日）；' +
        '也可以自己给 {"from","to"}（最多 31 天）。',
      '· timetable.next —— 用户的下一节课（含还有多久上课）。无入参。',
    );
  }
  // ⭐⭐ 0.8.4：记账那三条 —— 账单 / 预算 / 资产。
  //    ⚠️⭐ 「金额单位是分」必须在这里说死：它是最容易让模型答错的一处（回一句「你花了 3500 元」）。
  if (a.read.includes('ledger')) {
    lines.push(
      '· ledger.bill —— 用户的收支账单（区间收入 / 支出 / 结余 ＋ 支出分类 ＋ 最近几笔）。' +
        '入参 {"range":"month"}，range 取 today（今天）、week（本周）、month（本月）、year（本年）；' +
        '⭐ 也可以自己给 {"from":"2026-09-01","to":"2026-09-30"}（任意区间，最多 366 天）——' +
        '**问「上个月花了多少」「9 月和 10 月比」时就用它**，别再回答「没有上月这一档」。' +
        '还能加 {"category":"餐饮"} 只统计这一个分类（分类名要用本机真有的；本机没有时会明确回 false）。',
      '· ledger.budget —— 用户的预算进度（总预算与各分类预算的额度 / 已用 / 剩余 / 超没超）。' +
        '入参 {"range":"month"}，range 取 week（本周）、month（本月）、year（本年）。',
      '· ledger.assets —— 用户的资产快照（资产合计 / 负债合计 / 净值 ＋ 各账户余额）。无入参。',
      '  ⚠️ 这三条回的所有金额字段，单位都是**分**（1 元 = 100 分）—— 说给用户听之前先除以 100，' +
        '别把 3500 分说成「3500 元」。',
    );
  }
  // ⭐⭐ 0.8.5（真机报的「这三块 AI 读不到」）：收藏夹 / 随手记 / 硬件 —— 三条读工具。
  //    ⚠️⭐ 这一段**曾经整个漏掉**：上面那些 `if` 是**手写清单**，加模块时只加了白名单（`READ_MODULES`）
  //    却没有加这里 ⇒ 已授权、执行器也在、用例也过，**但模型压根不知道有这些工具**，
  //    于是老实回答「我没有对应的工具可调用」。⇒ 定式：**加一条工具 = 白名单 ＋ 提示词，两处一起加**
  //    （`ttt/test/ai.test.js` 的 `toolsPrompt` 那条用例现在把三块也钉住了）。
  //    ⚠️ 这三块的出网面**比前面几条更窄**，必须在这里说清「你拿到的是什么、拿不到什么」——
  //    否则模型会以为自己能拿到完整网址 / 序列号，答不上来时就开始编。
  if (a.read.includes('bookmarks')) {
    lines.push(
      '· bookmarks.query —— 用户的网址收藏（标题 / 网站域名 / 分类名 / 来源）。' +
        '入参 {"tag":""}：不填 = 全部，这时结果里会带用户的**分类清单**' +
        '（第一次先这样查一次，就知道他到底有哪些分类）。' +
        '⚠️⭐ 想只看某个分类时，tag 必须填**那份清单里出现过的名字**；' +
        '⛔ 绝不自己编一个分类名 —— 编出来的名字一定查不到，你会误报「用户没有这条收藏」。' +
        '⚠️ 你只拿得到**域名**，拿不到完整网址的路径与查询串；用户要具体链接时如实说读不到。',
    );
  }
  if (a.read.includes('idea')) {
    lines.push(
      '· idea.query —— 用户的随手记（正文 / 标签 / 记录时间 / 是否已归档）。' +
        '入参 {"view":"inbox"}，view 取 inbox（未归档）、archived（已归档）、all（全部）。' +
        '⚠️ 每条正文最多给你 200 字，被截断的那条带 truncated:true —— 别把它当成全文。',
    );
  }
  if (a.read.includes('digital')) {
    lines.push(
      '· hardware.query —— 用户的数码设备台账（名称 / 状态 / 分类 / 品牌型号 / 购买日期 / 价格 / 寿命）。' +
        '入参 {"range":"all"}，range 取 all、owned（在用）、wishlist（想买）、retired（已退役）、alert（需关注）。' +
        '⚠️ 价格单位是**元**（与记账那种「分」不是一回事）；序列号 / 位置 / 详细内容读不到。',
    );
  }
  // ⭐⭐ 0.8.6（行程 / 车票）—— 照上面那些 `if` 同款加（方案 §9.7-2 明写照这个形状加）。
  //    ⚠️ `reason` 那一项要在这里讲明白：模型不看它就会把 disabled 说成「你最近没有出行安排」。
  if (a.read.includes('trip')) {
    lines.push(
      '· trips.query —— 用户的行程与车票（行程的标题与起止日期；车票的票型 / 车次 / 出发站 / 到达站 / ' +
        '出发时刻 / 到达时刻 / 座位 / 检票口）。' +
        '入参 {"range":"upcoming"}，range 取 upcoming（今天起 30 天，默认）、recent（最近 30 天）。' +
        '⚠️ 订单号（票号）与任何位置信息**读不到**；回里的 reason 是 ok（有数据）/ disabled（这块被用户关掉了）/ ' +
        'empty（确实没有）—— disabled 时如实说「这块关掉了」，⛔ 别当成「没有行程」。',
    );
  }
  // ⭐⭐ 0.8.55 全面体检（「几乎所有模块都有更新和变化，ai对话辅助几乎没有了」）：
  //    四块新读数 —— 资产 / 日历 / 番茄钟 / 协作项目。
  //    ⚠️⭐ 这一段是**手写清单**，历史上漏过一次（0.8.5 漏了收藏夹 / 随手记 / 硬件三块，
  //    表现是「模型老实回答我没有这个工具」）。定式不变：**加一条工具 = 白名单 ＋ 提示词，两处一起加**，
  //    `ttt/test/ai.test.js` 的 toolsPrompt 用例逐块钉住。
  if (a.read.includes('assets')) {
    lines.push(
      '· assets.query —— 用户的**个人资产台账**（分组与条目：这些东西值多少）。' +
        '入参 {"group":""}：不填 = 全部；填一个**已有分组名**就只看那一组（连同它的子组）。' +
        '⚠️⭐ 这是**存量**（他有什么、值多少），与记账的**流量**（这段时间花了多少）是两回事 —— ' +
        '⛔ 别把两者相加，也别说「你这个月收入 300 万」。' +
        '⚠️ 金额单位是**分**（与记账同一个坑）；条目的备注读不到。',
    );
  }
  if (a.read.includes('calendar')) {
    lines.push(
      '· calendar.query —— 用户自己在日历里建的**日程**（标题 / 日期 / 是否全天 / 起止时刻）。' +
        '入参 {"days":"week"}，days 取 today（今天）、week（今天起 7 天）、next_week（下周一到周日）、' +
        'month（今天起 30 天）。' +
        '⚠️⭐ 它**只回日程**：课表走 timetable.range、任务截止走 tasks.query —— ' +
        '三块别互相顶替（「明天有没有课」问 timetable，不是问它）。日程备注读不到。' +
        '⭐ 也可以自己给 {"from","to"}（YYYY-MM-DD）。',
    );
  }
  if (a.read.includes('pomodoro')) {
    lines.push(
      '· pomodoro.query —— 用户的番茄钟统计（专注次数 / 专注分钟数 / 休息次数与分钟数）。' +
        '入参 {"range":"today"}，range 取 today（今天）、week（本周一起）。' +
        '⚠️ 只有计数与时长，**没有任务名** —— 别编「你上午专注做的是哪件事」。',
    );
  }
  if (a.read.includes('collab')) {
    lines.push(
      '· collab.query —— 用户**参与的**协作项目（项目名 / 我的角色 / 未完成任务数）与其中的任务' +
        '（标题 / 状态 / 负责人显示名 / 截止日期）。无入参。' +
        '⚠️⭐ 只回他看得见的那些项目（他开共享的 ＋ 他作为成员加入的）；' +
        '⛔ 聊天记录、评论、附件、上报内容都读不到 —— 被问到就如实说读不到。' +
        '⚠️ reason 为 empty 表示他还没参与任何协作项目（⛔ 不是「读不到」）。',
    );
  }
  // ⭐⭐ 0.7.8：写工具这一段**有授权才列**；没授权就在下面明说「没开」。
  //    ⚠️ 入参形状照 `tools-write.js` 的 `args` 写（那里是给人看的说明）。
  //    ⛔ 不写内部字段名（`meta` / `task_proposal` / `items`）—— 那是内部约定，不该教给模型。
  if (a.write.includes('tasks')) {
    lines.push(
      '· tasks.propose_create —— 提议建一条任务。入参 ' +
        '{"tool":"tasks.propose_create","args":{"tasks":[{"title":"…","due":"…","important":true,"urgent":false,"scope":"daily","kind":"plain"}]}}；' +
        '每条 title 必填；due 是 YYYY-MM-DD（原文没说就留空）；important / urgent 填 true 或 false；' +
        'scope 取 daily（日常任务）或用户自己的项目 id（拿不准就留空或写 daily）；' +
        'kind 取 plain（普通，默认）/ window（限时完成）/ cycle（周期打卡）。',
      // ⭐ 0.8.55：周期任务要带规则 —— 用户说「每天背单词」时它才建得对
      '  ⚠️ 只有 kind=cycle 才带 rule，格式是 {"freq":"daily"} 或 {"freq":"weekly","slots":[[1,1],[3,3]]}' +
        '（1 = 周一；每一期是一个 [起,止] 闭区间）。用户没说清「哪几天」时**先问一句**，⛔ 别自己定成每周一。',
      '  什么时候用它：用户让你「记一条待办」「提一个任务」「把这段整理成任务」的时候。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现在对话里，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接创建任务，⛔ 不要说已经建好，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。',
      '  用户点「拒绝」时，你会看到「上一次的提议被拒绝了」这个事实：先问清哪里不对，' +
        '或者按用户接下来的说明改好再提一次，不要原样重复上一次的提议。',
    );
  }
  // ⭐⭐ 0.8.4：记账那一笔 —— 与任务同一套模式（提议 → 卡片 → 点确认才落库）。
  //    ⚠️ 金额单位反过来：**入参给「元」**（用户嘴上说的就是元），服务端换算成「分」再进卡。
  if (a.write.includes('ledger')) {
    lines.push(
      '· ledger.propose_entry —— 提议记一笔账。入参 ' +
        '{"tool":"ledger.propose_entry","args":{"entries":[{"amount":"35.5","ie":"支出","at":"2026-09-28","category":"餐饮","account":"微信","note":"午饭"}]}}；' +
        '每条 amount 必填（单位**元**，可以带小数）；ie 取「支出」或「收入」（没说就按支出）；' +
        'at 是 YYYY-MM-DD（原文没说就留空，服务端会按今天算）；category / account 填用户说的名字' +
        '（本机找不到就记成「未分类 / 不关联账户」，会在卡上标出来，⛔ 别自己编一个名字）；note 可留空。',
      '  什么时候用它：用户让你「记一笔」「记一下今天花了…」「这笔账也记上」的时候。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现在对话里，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接记账，⛔ 不要说已经记好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。',
      '  ⚠️ 一次最多 10 笔；用户一口气报十几笔时，先提议前几笔并说清分批来。',
      '  用户点「拒绝」时，你会看到「上一次的提议被拒绝了」这个事实：先问清哪里不对，' +
        '或者按用户接下来的说明改好再提一次，不要原样重复上一次的提议。',
    );
  }
  // ⭐⭐ 0.8.5：收藏 / 随手记 / 硬件那三笔 —— 与上面两条**同一套模式**（提议 → 卡片 → 点确认才落库）。
  //    ⚠️ 与读侧同一个漏法（这份提示词是手写清单）—— 一起补上。
  if (a.write.includes('bookmarks')) {
    lines.push(
      '· bookmarks.propose_create —— 提议收藏一个网址。入参 ' +
        '{"tool":"bookmarks.propose_create","args":{"bookmarks":[{"url":"https://example.com/","title":"…","tags":[]}]}}；' +
        '每条 url 必填（要写全，含 https://，能被浏览器直接打开）；title 可留空；' +
        'tags 是分类名数组 —— 只在**用户点名了分类**时才填，拿不准就留空' +
        '（本机没有的分类名会在用户点确认时顺手建出来）。',
      '  什么时候用它：用户让你「收藏一下这个网址」「把这个存进收藏夹」的时候。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接收藏，⛔ 不要说已经存好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。',
    );
  }
  if (a.write.includes('idea')) {
    lines.push(
      '· idea.propose_create —— 提议记一条随手记。入参 ' +
        '{"tool":"idea.propose_create","args":{"notes":[{"content":"…","tag":"…"}]}}；' +
        '每条 content 必填（就是那条随手记的正文）；tag 可选（一个标签）。',
      '  什么时候用它：用户让你「帮我记一条」「记下来」，而那是**一段想法而不是一件待办**的时候。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接记，⛔ 不要说已经记好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。',
    );
  }
  if (a.write.includes('digital')) {
    lines.push(
      '· hardware.propose_create —— 提议登记一件数码设备。入参 ' +
        '{"tool":"hardware.propose_create","args":{"hardware":[{"name":"…","category":"硬盘","status":"owned",' +
        '"brand":"…","model":"…","capacity":"4TB","purchase_date":"2026-01-01","purchase_price":"800",' +
        '"expected_life_months":"60"}]}}；每条 name 必填；status 取 owned（在用，默认）、wishlist（想买）、' +
        'retired（已退役）；purchase_price 单位是**元**（不是分）；expected_life_months 是用户自己估的月数。',
      '  什么时候用它：用户说「买了块 4T 硬盘」「帮我记一下这件设备」的时候。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接写进台账，⛔ 不要说已经登记好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。' +
        '序列号 / 位置 / 详细内容不在这张卡上（那些要用户到「数码管理」那一屏自己补）。',
    );
  }
  // ⭐ 0.8.6（行程 / 车票）
  if (a.write.includes('trip')) {
    lines.push(
      '· trips.propose_create —— 提议建几张车票。入参 ' +
        '{"tool":"trips.propose_create","args":{"tickets":[{"kind":"","code":"","from":"","to":"","depart":"","arrive":"","seat":"","gate":""}]}}；' +
        '每条 from（出发站）/ to（到达站）/ depart（出发时刻，写成 2026-09-30 08:00）必填；kind 可选' +
        '（火车 / 高铁 / 飞机 / 汽车 / 船 / 其它，拿不准就留空）。转机或换乘请**分成两张票**。',
      '  什么时候用它：用户说「帮我记一张票」「我明天坐 G1234 从北京南去上海虹桥」的时候。',
      '  ⚠️⭐ 时刻与站名**拿不准就不要猜**：填错的时间会连带算错出发提醒 —— ' +
        '宁可留空，服务端会把「没看懂」标在卡上让用户自己改。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接建票，⛔ 不要说已经建好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。',
      '  ⚠️ 票不会自动归到哪趟行程（归到哪趟由用户自己选）—— 别承诺「已经归好了」。',
    );
  }
  // ---- ⭐⭐ 0.8.55：资产与日历两块写面 ----
  if (a.write.includes('assets')) {
    lines.push(
      '· assets.propose_item —— 提议记一条资产。入参 ' +
        '{"tool":"assets.propose_item","args":{"items":[{"name":"…","group":"…","amount":"3000000","date":"2026-10-01"}]}}；' +
        '每条 name 必填；group 只能填**他已有分组**的名字（拿不准就留空 —— 本机没有的名字不会替你新建，' +
        '会在卡上标出来）；amount 单位是**元**（可以带小数）；date 是 YYYY-MM-DD（原文没说就留空）。',
      '  什么时候用它：用户说「我有一套房子值 300 万」「帮我把这台 NAS 记进资产」的时候。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接写进台账，⛔ 不要说已经记好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。' +
        '备注不在这张卡上（那要用户自己到资产那一屏补）。',
    );
  }
  if (a.write.includes('calendar')) {
    lines.push(
      '· calendar.propose_event —— 提议建一条日程。入参 ' +
        '{"tool":"calendar.propose_event","args":{"events":[{"title":"…","date":"2026-10-26","all_day":false,"start":"15:00","end":"16:00"}]}}；' +
        '每条 title 与 date（YYYY-MM-DD）必填；all_day 是 true / false（全天时不要带 start / end）；' +
        'start / end 写成 HH:MM；跨天时带 end_date（YYYY-MM-DD）。',
      '  什么时候用它：用户说「下周三下午三点提醒我开会」「十月三十号那天空出来」的时候。',
      '  ⚠️⭐ 日期与时刻**拿不准就问**：排错一天就是白跑一趟 —— ' +
        '宁可先问一句「是 10 月 26 日还是 27 日」，⛔ 不要猜一个填上去。',
      '  ⚠️ 它**只生成提议**：会变成一张待确认的卡片出现，由用户点「同意」或「拒绝」来决定 —— ' +
        '你不能直接建日程，⛔ 不要说已经建好了，⛔ 也不要用文字把卡片内容抄一遍来假装那张卡片。',
    );
  }
  // ⭐ 没开的那几种写能力必须**逐条明说「没有」**（0.7.8 的教训：只说「有卡片」、不说「你现在没有」，
  //    模型就会照着前半句编一张卡、还声称发出去了）。
  const noWrite = [];
  if (!a.write.includes('tasks')) noWrite.push('创建任务');
  if (!a.write.includes('ledger')) noWrite.push('记账');
  if (!a.write.includes('bookmarks')) noWrite.push('收藏网址');
  if (!a.write.includes('idea')) noWrite.push('记一条随手记');
  if (!a.write.includes('digital')) noWrite.push('登记数码设备');
  if (!a.write.includes('trip')) noWrite.push('建车票');
  if (!a.write.includes('assets')) noWrite.push('记一条资产');
  if (!a.write.includes('calendar')) noWrite.push('建一条日程');
  if (noWrite.length) {
    // ⚠️ 措辞必须说清「你现在没有」—— 且**不许**出现「待确认的卡片」这种承诺（t3 那条用例钉着）。
    lines.push(
      `注意：你现在**不能**${noWrite.map((m) => `提议${m}`).join('、')}（这些能力用户还没开）—— ` +
        '用户让你记待办或者记账时，如实说明这项能力没开、并让他去「AI 助手 → AI 写工具」里打开它；' +
        '⛔ 不要用文字描述一张卡片，⛔ 更不要说已经生成或已经建好。',
    );
  }
  lines.push(
    '规则：一次只输出一个 JSON 对象；不需要数据时直接正常回答；不确定的工具名不要调用；',
    '拿到工具结果后不要再输出 JSON，直接用中文回答用户。',
    // ⭐ 0.7.6（真机缺陷）：部分第三方部署不守上面的约定、把训练里的原生调用语法当正文吐出来
    //    （实测是 <|DSML|invoke …> 这种标记）。这里加一句禁令 —— 对听话的模型能防住，
    //    不听话的由轮末的 parseNativeToolCall() 兜住（两头都做，缺一不可）。
    '⛔ 不要用任何特殊标记或函数调用语法（例如 <|…|>、<tool_call> 之类的东西）：',
    '需要数据时就只输出上面约定的那个 JSON 对象，其余时候只输出普通话。',
  );
  // ⚠️ 只授权了一半 ⇒ 明说「信息不完整」：半份数据排出来的计划看着很像真的，这是最坏的一种。
  //    ⚠️⭐ 0.7.8：**这条判据仍然只看读授权** —— 写工具不提供任何「数据」，它只生成提议；
  //    把它算进「齐不齐」里，会让「写授权开了」冒充「信息完整」，而课表其实还是读不到。
  if (readOn.length && a.read.includes('tasks') !== a.read.includes('timetable')) {
    lines.push(
      '注意：用户只授权了一部分数据，你的信息是不完整的 —— 这种时候要如实说明' +
        '（例如「我读不到你的课表」），⛔ 不要凭空安排时间。',
    );
  }
  return lines.join('\n');
}

/**
 * 功能：把模型的输出解析成一条**工具意图** —— ⛔ **解析失败一律返回 null（拒绝执行，不猜）**。
 *
 * 说明：⭐ 与 `parseLooseJson()` 的关键差别：那个函数有**第三层**兜底（从一段话里把平衡的
 *      JSON 抠出来）。那一层对「抽任务清单」没问题，对**意图**却是危险的 ——
 *      模型只要在正文里写个 `{"tool":…}` 的例子，第三层就会抠出来照执行。
 *      ⇒ 这里**只认整段就是 JSON**（或整段是一个 \\`\\`\\`json 围栏），一个字符的多余都不认。
 *      ⚠️ 这是反向验证 R4 的锚点：把这里改成「解析失败也返回一个默认意图」，
 *      用例 21 必红（没解析出来却执行了工具）。
 *
 * @param {string} text - 模型这一轮的完整输出
 * @returns {?{tool: string, args: Object}} 意图；不是意图（正常回答 / 解析失败）为 null
 */
function parseToolIntent(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  let body = s;
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
  if (fenced) body = fenced[1].trim();
  if (body.charAt(0) !== '{') return null; // 正常回答（散文）—— 不是意图
  let v;
  try {
    v = JSON.parse(body);
  } catch (_e) {
    return null; // ⛔ 解析失败：拒绝执行
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const name = typeof v.tool === 'string' ? v.tool.trim() : '';
  if (!name) return null;
  const args = v.args && typeof v.args === 'object' && !Array.isArray(v.args) ? v.args : {};
  return { tool: name, args };
}

// ==================== 0.7.6（真机缺陷修复）：原生调用标记泄漏 ====================
//
// 现象（真机截图）：问「这周还有哪些课程」，模型回了一整段
// `<|DSML|calls><|DSML|invoke name="timetable.range">…` —— 它想调的工具、参数全对
// （授权链路是通的），但没守 toolsPrompt() 的文本协议，用了它训练里的原生调用语法。
// 只认整段 JSON 的 parseToolIntent() 对它无能为力 ⇒ 原样显示、原文落库（历史被污染，
// 模型下一轮还会学着自己上一次的坏格式，越用越糟）。
// ⇒ 处理分两路（都收窄在「整段以 <| 开头」这个特征上，正常回答不受影响）：
//    ① 整段是调用标记且抽得出工具名 ⇒ 照常走执行链（判权 / 目录 / 二次校验 / 审计一道不少）；
//    ② 像标记但抽不出 ⇒ 由 routes.js 拦下：不显示、不落原文，给用户一句人话。

/**
 * 功能：判定「这一段输出**长得像**一段原生调用标记吗？」—— 只做形状判定，不抽内容。
 *
 * 说明：⚠️ 特殊 token 泄漏几乎必然以 `<|` 开头（各家推理栈的标记都是这个形状），
 *      而正常回答以 `<|` 开头的概率可以忽略 —— 所以判定刻意收窄在这里。
 *      散文**中间**引用这种语法（「它输出了 <|DSML|… 这样的标记」）不算 ——
 *      与 R4 同一种精神：拿不准就不认。
 *
 * @param {string} text - 模型这一轮的完整输出
 * @returns {boolean} trim 后以 `<|` 开头为 true
 */
/**
 * 「竖线」这一格：**半角 `|`（U+007C）与全角 `｜`（U+FF5C）都要认**。
 *
 * ⚠️⚠️ 的真机缺陷就是漏了全角这一半：DeepSeek 系的原生工具调用标记是
 *      `<｜｜DSML｜｜invoke name="tasks.query">`（**全角**竖线），而原来的判据写死 `^\s*<\|`，
 *      全角一个也认不出 ⇒ 形状判定为假 ⇒ 既没执行、也没拦截 ⇒ 那坨机器语法**原样落库、原样显示**。
 *      ⛔ 别把这里改回单写半角：`|` 与 `｜` 在等宽字体下几乎同形，靠肉眼复核根本看不出来。
 * @type {string}
 */
const PIPE = '[|\\uFF5C]';

/**
 * 功能：判断整段输出看起来是不是**原生工具调用标记**（而不是给用户看的正文）。
 *
 * 说明：⭐ 0.7.6 起有这条兜底：部分第三方部署不守文本协议，把训练里的原生调用语法
 *      （`<|DSML|invoke …`、DeepSeek 的 `<｜｜DSML｜｜calls>`、`<tool_call>`）直接当正文吐出来。
 *      ⚠️⭐ 这里**只认「整段以标记开头」**（`^` 锚定），而且这是**执行**的判据 ——
 *      判真之后调用方才走 `parseNativeToolCall()`，而它内部有「从文本抠 JSON」的兜底，
 *      对散文是危险的（R4 的教训：散文里引用一句这种语法就被执行了工具）。
 *      ⇒ 「散文里引用」永远不认。要判「这条该不该拦下来别显示」用 `hasNativeMarkers()`（宽版）。
 *      ⚠️ 竖线**全角半角都认**（见 `PIPE`）。
 * @param {*} text - 模型这一轮的完整输出
 * @returns {boolean} 整段以原生调用标记开头返回 true
 */
function nativeCallShaped(text) {
  const s = String(text == null ? '' : text);
  return new RegExp(`^\\s*<${PIPE}`).test(s);
}

/**
 * 功能：判断这段输出里**有没有**原生调用标记的特征串（⭐ 宽版，只用于「别把它显示出来」）。
 *
 * 说明：⭐⭐ 与 `nativeCallShaped()` 的分工是**刻意**分两档的（0.8.55 定）：
 *      · **严格版**（`^` 锚定）＝「可以拿去解析并执行」—— 必须是整段就是标记；
 *      · **宽版**（本函数）＝「这段里混着机器语法」—— 覆盖「先说半句、再吐一坨标记」
 *        以及**已经落库的历史垃圾**（读出来时换成人话，⛔ 不再喂给模型看）。
 *      判据是 DeepSeek 系的专有 token 形状（`<｜｜DSML｜｜` / `<|DSML|`），
 *      ⛔ 不认泛泛的 `<`（散文里出现 `<` 很正常，误伤代价太大）。
 * @param {*} text - 任意文本
 * @returns {boolean} 含机器语法特征串返回 true
 */
function hasNativeMarkers(text) {
  const s = String(text == null ? '' : text);
  if (nativeCallShaped(s)) return true;
  return new RegExp(`<${PIPE}{1,2}\\s*DSML\\s*${PIPE}{1,2}`, 'i').test(s);
}

/**
 * 功能：从「整段是原生调用标记」的输出里抽出一条工具意图（与 `parseToolIntent()` 同形）。
 *
 * 说明：⚠️ 只在 `nativeCallShaped()` 为真时才有意义 —— 抽取用的是 `parseLooseJson()`，
 *      它有「从文本里抠配平块」的兜底层；那个兜底对**散文**是危险的（R4），
 *      对**已确认整段都是标记**的输出才是安全的（要抽的本来就是标记里夹的参数）。
 *      ⭐ 0.8.55：认**两种**写法 ——
 *      · DeepSeek 原生：`<｜｜DSML｜｜parameter name="args" string="false">{…}</…>`
 *        ＋ `<｜｜DSML｜｜parameter name="tool" string="true">tasks.query</…>`
 *        （工具名也可能只写在 `invoke name="…"` 上）；
 *      · 老式半角：`<|DSML|invoke name="x">{…}</|…>`。
 *      ⚠️ 抽不出工具名返回 null —— 调用方据此改走「拦截话术」那一路；⛔ 这里绝不猜。
 *      工具名是否在目录内、参数是否合法由**执行链**校验（`runIntentForChat()`）。
 *
 * @param {string} text - 模型这一轮的完整输出
 * @returns {?{tool: string, args: Object}} 意图；不像原生调用标记 / 抽不出工具名为 null
 */
function parseNativeToolCall(text) {
  const s = String(text == null ? '' : text).trim();
  if (!nativeCallShaped(s)) return null;
  let tool = '';
  const inv = /invoke\s+name\s*=\s*"([^"]+)"/.exec(s);
  if (inv && String(inv[1]).trim()) tool = String(inv[1]).trim();
  const args = {};
  // 参数块：开标签 `…parameter name="X" string="true|false">值</…parameter>`
  // ⚠️ 属性里不会出现 `>`（只有 name / string 两个），所以 `[^>]*?` 够用；
  //    闭合标签的 `</｜｜DSML｜｜parameter>` 里那段前缀也由 `[^>]*?` 吃掉。
  const PARAM = new RegExp(
    `<[^>]*?parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)<\\/[^>]*?parameter>`,
    'gi',
  );
  let hit = 0;
  for (const m of s.matchAll(PARAM)) {
    hit += 1;
    const key = String(m[1] || '').trim();
    const raw = String(m[2] || '').trim();
    if (!key) continue;
    if (key === 'tool') {
      if (!tool) tool = raw;
      continue;
    }
    if (key === 'args') {
      // ⚠️ 不写 `let v = null`：初值一定会被下面两路覆盖，eslint 的 no-useless-assignment
      //    会把它当死赋值（本项目零警告门禁）
      let v;
      try {
        v = JSON.parse(raw);
      } catch (_e) {
        v = parseLooseJson(raw);
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(args, v);
      continue;
    }
    // 其它 name 一律当作「一个参数」收下（有些部署把参数平铺，不套 args）
    args[key] = raw;
  }
  // 老式写法（没有 parameter 块）：退回「从整段里抠第一个配平 JSON」
  if (!hit) {
    const v = parseLooseJson(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(args, v);
  }
  if (!tool) return null;
  return { tool, args };
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  MAX_TOKENS,
  CHAT_PATH,
  MODELS_PATH,
  CFG_AT,
  PRIVATE_HINT,
  isPrivateBaseUrl,
  joinUrl,
  chatOnce,
  chatStream,
  listModels,
  parseLooseJson,
  toolsPrompt,
  parseToolIntent,
  nativeCallShaped,
  hasNativeMarkers,
  parseNativeToolCall,
};
