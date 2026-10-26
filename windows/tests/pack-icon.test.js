/**
 * 图标流水线护栏（0.1.6 现场：脚本打印了「已写入」，但发出去的包里 exe 还是 Electron 默认图标）。
 *
 * 真因有二，都得用断言钉住：
 * 1. 图标写完之后又跑了一次 pack，exe 被覆盖回默认 —— 所以**顺序**必须是 pack → apply-icon；
 * 2. `resedit` 会「不报错但没写进去」—— 所以 apply-icon 必须**解析产物复核**，失败非零退出。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('pack.js：图标步骤在打包**之后**，且失败会中止（⛔ 不许出无图标的包）', () => {
  const pack = read('build/pack.js');
  const packed = pack.indexOf('PACKAGED');
  const icon = pack.indexOf('apply-icon.js');
  assert.ok(packed > 0, 'pack.js 里应有 PACKAGED 输出');
  assert.ok(icon > packed, `apply-icon 必须在 PACKAGED 之后调用（packed@${packed}, icon@${icon}）`);
  assert.match(pack, /spawnSync\(process\.execPath, \[iconScript/, '用当前 node 跑图标脚本');
  assert.match(pack, /child\.status !== 0[\s\S]{0,160}throw new Error/, '图标失败必须抛错中止');
});

test('apply-icon.js：写完要解析产物复核（一组 / 中性语言 / 尺寸数 / RT_ICON 数）', () => {
  const script = read('build/apply-icon.js');
  assert.match(script, /RT_ICON/, '要数 RT_ICON 资源');
  assert.match(script, /IconGroupEntry\.fromEntries/, '要重新解析图标组');
  assert.match(script, /report\.groups === 1/, '只能留一个图标组（旧组会和我们的组并存）');
  assert.match(script, /Number\(report\.groupLang\) === 0/, '要写成语言中性（中文 Windows 才不会漏）');
  assert.match(script, /report\.sizes === wanted &&\s*report\.rt === wanted/, '尺寸数与 RT_ICON 数都要对上');
  assert.match(script, /process\.exit\(1\)/, '失败要非零退出');
  assert.match(script, /attempt <= 3/, '要重试（resedit 时灵时不灵）');
});

test('icon.ico：7 个尺寸全是 BMP(DIB)、无 PNG、每张都有实体数据', () => {
  const buf = fs.readFileSync(path.join(root, 'src', 'shell', 'assets', 'icon.ico'));
  const count = buf.readUInt16LE(4);
  assert.equal(count, 7, '应为 7 个尺寸');
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const blob = buf.subarray(offset, offset + size);
    assert.ok(size > 500, `第 ${i + 1} 张太小（${size} 字节）`);
    assert.notEqual(blob[0], 0x89, '⛔ 不许用 PNG 压缩（有些 shell 面读不出来就退回默认图标）');
    const biSize = blob.readUInt32LE(0);
    const biWidth = blob.readInt32LE(4);
    const biHeight = blob.readInt32LE(8);
    assert.equal(biSize, 40, 'BITMAPINFOHEADER 长度应为 40');
    assert.equal(biHeight, biWidth * 2, '高度应写两倍（XOR + AND 掩码）');
    sizes.push(biWidth);
  }
  for (const need of [16, 32, 48, 256]) assert.ok(sizes.includes(need), `ico 缺 ${need}px`);
});
