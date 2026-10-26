/**
 * 日志（`data/logs/boot.log`）与脱敏。
 *
 * 规矩（任务单 §三.9 / §11 坑 12）：日志里**永不出现**密码 / token / Cookie 值 / 完整 FNID。
 * 所有写日志的入口都先过 `redact()` —— ⛔ 不允许「这条应该没问题」直接拼字符串。
 */

import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEYS = ['password', 'passwd', 'token', 'longToken', 'accessToken', 'secret', 'ticket', 'cookie', 'authorization', 'entry-token', 'fnos-token'];

/** 把一条文本里的凭据抹掉。 */
export function redact(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  // key=value / "key":"value" / key: value 三种写法都盖掉
  for (const key of SECRET_KEYS) {
    const pattern = new RegExp(`("?${key}"?\\s*[:=]\\s*)("?)([^"\\s,;}&]+)`, 'gi');
    text = text.replace(pattern, (_m, head) => `${head}***`);
  }
  // Cookie 头整行抹（`Cookie: a=b; c=d`）
  text = text.replace(/(Cookie:\s*)[^\r\n]+/gi, '$1***');
  return text;
}

/** FNID 只留首尾：`ab***yz`。 */
export function maskFnId(fnId) {
  const text = String(fnId ?? '');
  if (text.length <= 4) return '***';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

/** URL 去掉查询串与 hash（地址里的 token 常在 query 上）。 */
export function stripQuery(url) {
  const text = String(url ?? '');
  const cut = text.search(/[?#]/);
  return cut < 0 ? text : text.slice(0, cut);
}

export class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    this.ready = false;
    this.inMemory = [];
  }

  ensure() {
    if (this.ready || !this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.ready = true;
      if (this.inMemory.length) {
        fs.appendFileSync(this.filePath, this.inMemory.join('\n') + '\n', 'utf8');
        this.inMemory = [];
      }
    } catch {
      // 目录不可写就先攒内存，`diagnose` 会把它打出来
    }
  }

  /** 一行带时间的日志。`level` ∈ info / warn / error。 */
  log(level, message, extra) {
    const time = new Date().toISOString();
    const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : safeJson(extra)}`;
    const line = `[${time}] ${level.toUpperCase()} ${redact(String(message))}${redact(tail)}`;
    if (!this.ready || !this.filePath) {
      this.inMemory.push(line);
      this.ensure();
      if (!this.ready) return line;
      return line;
    }
    try {
      fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    } catch {
      this.inMemory.push(line);
    }
    return line;
  }

  info(message, extra) {
    return this.log('info', message, extra);
  }

  warn(message, extra) {
    return this.log('warn', message, extra);
  }

  /** 异常：连堆栈一起写（脱敏后再写）。 */
  error(message, error) {
    const stack = error?.stack || (error ? String(error) : '');
    return this.log('error', message, stack ? `\n${stack}` : undefined);
  }

  /** 已经写进内存、还没来得及落盘的（目录不可写时给 `--diagnose` 用）。 */
  pending() {
    return [...this.inMemory];
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
