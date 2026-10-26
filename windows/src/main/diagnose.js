/**
 * `--diagnose`：无窗口自检（任务单 §5.2 第 6 条）。
 *
 * Windows 上打不开程序时，第一件事就是跑这个：版本、数据目录、目录可写、单实例锁，
 * 全部打出来，退出码 0/1。**它不建窗口、不联网、不读凭据** —— 所以一定能跑出来。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} input
 * @param {object} input.app - Electron `app`
 * @param {object} input.paths - `{dir, mode, warning}`
 * @param {object} input.logger
 * @param {boolean} input.singleInstanceOk
 * @param {boolean} input.safeStorageOk
 * @param {(line:string)=>void} [input.print]
 * @returns {number} 退出码
 */
export function runDiagnose(input) {
  const print = input.print || ((line) => console.log(line));
  const lines = [];
  const problems = [];
  const add = (label, value, ok = true) => {
    lines.push(`${ok ? '[ok]  ' : '[FAIL]'} ${label}: ${value}`);
    if (!ok) problems.push(label);
  };

  add('ZXDesk', `${input.app.getVersion()}`);
  add('Electron', process.versions.electron || '(非 Electron 环境)');
  add('Chromium', process.versions.chrome || '-');
  add('Node', process.versions.node);
  add('V8', process.versions.v8 || '-');
  add('平台', `${process.platform} ${process.arch} ${process.getSystemVersion?.() || ''}`.trim());

  const { dir, mode, warning } = input.paths;
  add('数据目录', `${dir}（${mode}${warning ? '，' + warning : ''}）`);
  add('数据目录可写', String(canWrite(dir)), canWrite(dir));

  for (const name of ['profile', 'logs', 'crashes']) {
    const target = path.join(dir, name);
    add(`子目录 ${name}`, fs.existsSync(target) ? '存在' : '缺失', fs.existsSync(target));
  }
  const logFile = path.join(dir, 'logs', 'boot.log');
  add('boot.log', fs.existsSync(logFile) ? `${logFile}（${sizeOf(logFile)} 字节）` : '尚未生成（首次启动后会有）');

  add('单实例锁', input.singleInstanceOk ? '已获得（无其它实例）' : '被占用（已有实例在跑）', true);
  add('safeStorage 加密', input.safeStorageOk ? '可用' : '不可用（会话 / 密码将不落盘）', true);

  print('ZXDesk 自检');
  print('─'.repeat(48));
  for (const line of lines) print(line);
  print('─'.repeat(48));
  if (problems.length) {
    print(`结论：${problems.length} 项异常 → ${problems.join('、')}`);
    return 1;
  }
  print('结论：全部正常');
  return 0;
}

function canWrite(dir) {
  try {
    const probe = path.join(dir, '.diagnose-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
