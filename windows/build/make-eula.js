/**
 * 生成安装向导用的许可协议（`build/eula.txt` → `build/eula.rtf`）。
 *
 * 为什么要转换，不直接把 txt 交给 NSIS：
 * - NSIS 的 Unicode 安装包读 `.txt` 时按 UTF-16LE 解释，UTF-8 的中文会变成乱码；
 * - `.rtf` 是纯 ASCII（中文以 `\uNNNN?` 转义），任何 NSIS 版本、任何系统区域设置下都正常；
 * - 顺带能做排版：文档标题居中加粗、章节标题加粗、段间距，长协议在向导里更好读。
 *
 * 源文件格式约定（`build/eula.txt`，UTF-8）：
 *   `# 文字`  → 标题（第一个是文档标题，其余是章节标题）
 *   空行      → 段落间距
 *   其它行    → 正文段落
 *
 * 用法：
 *   node build/make-eula.js           生成（有变化才写盘）
 *   node build/make-eula.js --check   只校验 rtf 是否与 txt 同步（门禁用，不写盘）
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const sourceFile = path.join(root, 'build', 'eula.txt');
const outFile = path.join(root, 'build', 'eula.rtf');
/**
 * 装进安装目录的那份：**UTF-16LE + BOM**。
 * Windows 记事本（含旧版）对无 BOM 的 UTF-8 会按 ANSI 解释 —— 中文全是乱码；
 * UTF-16LE 带 BOM 从 Win7 到 Win11 都能正确打开。
 */
const outTxtFile = path.join(root, 'build', 'eula-utf16.txt');

const FONT_BODY = 'f0';
const FONT_HEAD = 'f1';

/**
 * 把一段文本转成 RTF 可用的 ASCII。
 *
 * ⚠️ `\uN` 里的 N 是**有符号 16 位**：码点大于 0x7FFF 要减 0x10000 变成负数，
 *    否则 Word / NSIS 会把它当成另一个字（中文大半落在这个区间，写错了满屏乱码）。
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRtf(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp === 0x09) out += '\\tab ';
    else if (cp <= 0xffff) out += `\\u${cp > 0x7fff ? cp - 0x10000 : cp}?`;
    else {
      // 补充平面（emoji 之类）：拆成代理对，两个 \u
      const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi - 0x10000}?\\u${lo - 0x10000}?`;
    }
  }
  return out;
}

/** 读源文件，返回 { title, lines }（lines 已去掉空行分组与 `#` 前缀）。 */
function parseSource(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  /** @type {{kind:'title'|'heading'|'body'|'gap', text?:string}[]} */
  const blocks = [];
  let titleSeen = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      blocks.push({ kind: 'gap' });
      continue;
    }
    if (line.startsWith('#')) {
      const body = line.replace(/^#+\s*/, '');
      if (!titleSeen) {
        titleSeen = true;
        blocks.push({ kind: 'title', text: body });
      } else {
        blocks.push({ kind: 'heading', text: body });
      }
      continue;
    }
    blocks.push({ kind: 'body', text: line });
  }

  // 连续空行压成一个间距
  const merged = [];
  for (const block of blocks) {
    if (block.kind === 'gap' && merged.at(-1)?.kind === 'gap') continue;
    merged.push(block);
  }
  // 首尾的间距没有意义
  while (merged[0]?.kind === 'gap') merged.shift();
  while (merged.at(-1)?.kind === 'gap') merged.pop();
  return merged;
}

/** 把区块拼成 RTF 文档。 */
function buildRtf(blocks) {
  const parts = [
    '{\\rtf1\\ansi\\ansicpg936\\deff0',
    '{\\fonttbl{\\f0\\fcharset134 SimSun;}{\\f1\\fcharset134 SimHei;}}',
    '\\viewkind4\\uc1',
  ];

  for (const block of blocks) {
    if (block.kind === 'gap') continue;
    const text = escapeRtf(block.text);
    if (block.kind === 'title') {
      // 文档标题：黑体、16pt、居中
      parts.push(`\\pard\\qc\\sb0\\sa120\\${FONT_HEAD}\\b\\fs32 ${text}\\b0\\par`);
    } else if (block.kind === 'heading') {
      // 章节标题：黑体、11pt、加粗、段前留白
      parts.push(`\\pard\\qj\\sb180\\sa80\\${FONT_HEAD}\\b\\fs22 ${text}\\b0\\par`);
    } else {
      parts.push(`\\pard\\qj\\sb0\\sa100\\${FONT_BODY}\\fs20 ${text}\\par`);
    }
  }

  parts.push('}');
  return `${parts.join('\n')}\n`;
}

// ---------------------------------------------------------------- 主流程

if (!fs.existsSync(sourceFile)) {
  console.error(`✗ 缺协议源文件：${path.relative(root, sourceFile)}`);
  process.exit(1);
}

const source = fs.readFileSync(sourceFile, 'utf8');
const blocks = parseSource(source);
const titleBlock = blocks.find((b) => b.kind === 'title');
if (!titleBlock) {
  console.error('✗ 协议源文件没有标题行（第一行应以「# 」开头）');
  process.exit(1);
}
const headingCount = blocks.filter((b) => b.kind === 'heading').length;
if (headingCount < 5) {
  console.error(`✗ 章节只有 ${headingCount} 个 —— 协议像是被截断了（至少 5 章）`);
  process.exit(1);
}

const rtf = buildRtf(blocks);
const ascii = [...rtf].every((ch) => ch.charCodeAt(0) < 0x80);
if (!ascii) {
  console.error('✗ 生成的 RTF 含有非 ASCII 字符（中文没有转义成功）');
  process.exit(1);
}

// 装到程序目录的那份：CRLF + UTF-16LE + BOM
const plain = source.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
const utf16 = Buffer.concat([Buffer.from('\uFEFF', 'utf16le'), Buffer.from(plain, 'utf16le')]);

const rtfChanged = !fs.existsSync(outFile) || fs.readFileSync(outFile, 'utf8') !== rtf;
const txtChanged = !fs.existsSync(outTxtFile) || !fs.readFileSync(outTxtFile).equals(utf16);
const changed = rtfChanged || txtChanged;

if (process.argv.includes('--check')) {
  if (changed) {
    console.error('✗ build/eula.rtf 或 build/eula-utf16.txt 与 eula.txt 不同步 —— 跑一次 node build/make-eula.js');
    process.exit(1);
  }
  console.log(`✓ 许可协议产物与源文件同步（${headingCount} 章，${(rtf.length / 1024).toFixed(1)} KB）`);
  process.exit(0);
}

if (changed) {
  if (rtfChanged) fs.writeFileSync(outFile, rtf, 'utf8');
  if (txtChanged) fs.writeFileSync(outTxtFile, utf16);
  console.log(
    `✓ 已生成 build/eula.rtf（${headingCount} 章，${(rtf.length / 1024).toFixed(1)} KB）` +
      `＋ build/eula-utf16.txt（${(utf16.length / 1024).toFixed(1)} KB）`,
  );
} else {
  console.log(`✓ 许可协议产物已是最新（${headingCount} 章）`);
}
