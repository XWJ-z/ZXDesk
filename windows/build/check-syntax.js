/**
 * 语法门禁：遍历 `src/`、`tests/`、`build/` 下的 .js / .cjs，逐个 `node --check`。
 * 任一失败退出 1（任务单 §10.2）。
 *
 * 为什么用 `node --check` 而不是 import：Electron 的模块在这里 import 会直接炸
 * （主进程代码依赖 electron 运行时），但**语法错**必须能在本机拦住。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const targets = ['src', 'tests', 'build'];
const files = [];

for (const dir of targets) {
  walk(path.join(root, dir));
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'tmp') continue;
      walk(full);
    } else if (/\.(js|cjs|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
}

let failed = 0;
for (const file of files.sort()) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok   ${path.relative(root, file)}`);
  } catch (e) {
    failed += 1;
    const detail = (e.stderr || e.stdout || '').toString().trim().split('\n').slice(0, 4).join('\n');
    console.error(`FAIL ${path.relative(root, file)}\n${detail}`);
  }
}

console.log(`\n语法检查：${files.length} 个文件，失败 ${failed} 个`);
process.exit(failed === 0 ? 0 : 1);
