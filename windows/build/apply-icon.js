/**
 * 把图标与版本资源写进 `ZXDesk.exe`（`resedit` 是纯 JS，免 Wine）。
 *
 * ⚠️ 为什么这个脚本这么啰嗦：`resedit` 在 Electron 45 的 ~250 MB exe 上**时灵时不灵**
 * （同一个文件同样的调用，有时字节不变、有时变）。0.1.6 就吃过一次：脚本打印了「已写入」，
 * 但**打好的包里 exe 还是 Electron 默认图标**（原因是图标写完之后又跑了一次 pack，把 exe 覆盖回去了）。
 *
 * 所以现在三道锁：
 * 1. 写完**重新解析产物**，确认图标组里有 7 个尺寸、RT_ICON 有 7 条（不是只看哈希变没变）；
 * 2. 不满足就**从原始字节重试**（最多 3 次），仍不行**退出码 1** —— 打包链会当场失败，
 *    ⛔ 不允许「静默出一个没有图标的包」；
 * 3. `build/pack.js` 在打包**之后**才调它（顺序写死在脚本里，见 pack.js 末尾）。
 *
 * 用法：`node build/apply-icon.js [exe 路径]`（默认为 `build/out/ZXDesk-win32-x64/ZXDesk.exe`）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const exePath = process.argv[2] || path.join(root, 'build', 'out', 'ZXDesk-win32-x64', 'ZXDesk.exe');
const icoPath = path.join(root, 'src', 'shell', 'assets', 'icon.ico');
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function fail(message) {
  console.error(`[图标] ✗ ${message}`);
  process.exit(1);
}

/** 读回产物，数一遍图标：组里几个尺寸、RT_ICON 几条。 */
function inspect(ResEdit, buffer) {
  const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const group = groups.find((g) => Number(g.id) === 1) || groups[0] || null;
  return {
    groups: groups.length,
    sizes: group ? group.icons.length : 0,
    rt: res.entries.filter((e) => e.type === RT_ICON).length,
    groupId: group ? group.id : null,
    groupLang: group ? group.lang : null,
  };
}

async function main() {
  if (!fs.existsSync(exePath)) fail(`找不到 exe：${exePath}（先跑打包）`);
  if (!fs.existsSync(icoPath)) fail(`找不到 ico：${icoPath}`);

  const ResEdit = await import('resedit');
  const original = fs.readFileSync(exePath);
  const before = sha256(original);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const wanted = iconFile.icons.length;

  console.log(`[图标] 目标：${path.relative(root, exePath)}（写 ${wanted} 个尺寸：${iconFile.icons.map((i) => `${i.width}x${i.height}`).join(' ')}）`);

  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // ⚠️ 每次都从**原始字节**重来：resedit 的失败模式是「改了一半」，链式重试只会更糟
    const exe = ResEdit.NtExecutable.from(original, { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);

    // ⚠️ 三个要点（0.1.6 后「挪目录图标变默认」就栽在这）：
    // ① **先删掉所有旧图标组**：Electron 自带的是 1/1033，留着会和我们的组并存，
    //    某些 shell 路径会挑到旧的那组（4 个尺寸、PNG 都没有），于是退回通用图标；
    // ② 用**语言中性（lang=0）**写：中文 Windows 的 UI 语言是 2052，中性组是标准做法，
    //    比钉死 1033 更不容易被某些 shell 面（大图标/缩略图/移动后的重读）漏掉；
    // ③ ico 里 256 尺寸也改成 **BMP(DIB)**，不带 PNG 压缩 —— 去掉解码依赖。
    // 旧的 RT_ICON 也一起清：留着会让新图标拿到 8..14 这种 id，数量和组里对不上（实测 14 条）
    res.entries = res.entries.filter((e) => e.type !== RT_GROUP_ICON && e.type !== RT_ICON);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      0,
      iconFile.icons.map((icon) => icon.data),
    );

    const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    if (versionInfos.length) {
      const info = versionInfos[0];
      info.setFileVersion(0, 1, 0, 0);
      info.setProductVersion(0, 1, 0, 0);
      info.setStringValues(
        { lang: 1033, codepage: 1200 },
        {
          ProductName: 'ZXDesk',
          FileDescription: 'ZXDesk 工作台',
          CompanyName: 'ZXDesk',
          OriginalFilename: 'ZXDesk.exe',
        },
      );
      info.outputToResourceEntries(res.entries);
    }

    res.outputResource(exe);
    const output = Buffer.from(exe.generate());
    const after = sha256(output);
    const report = inspect(ResEdit, output);
    last = { report, after };

    const ok =
      after !== before &&
      report.groups === 1 &&
      Number(report.groupLang) === 0 &&
      report.sizes === wanted &&
      report.rt === wanted;
    console.log(
      `[图标] 第 ${attempt} 次：字节${after === before ? '未变化' : `变了（${before.slice(0, 12)} → ${after.slice(0, 12)}）`}` +
        `，图标组 ${report.groups} 个（${report.groupId}/${report.groupLang}）里 ${report.sizes}/${wanted} 个尺寸，RT_ICON ${report.rt}/${wanted}` +
        `${ok ? ' ✓' : ' ✗'}`,
    );

    if (ok) {
      fs.writeFileSync(exePath, output);
      // 落盘后再读一次，防止「写盘失败/被别的东西覆盖」这类事（0.1.6 就是这么丢的）
      const onDisk = inspect(ResEdit, fs.readFileSync(exePath));
      if (onDisk.groups !== 1 || Number(onDisk.groupLang) !== 0 || onDisk.sizes !== wanted || onDisk.rt !== wanted) {
        fail(`写盘后复核不一致（组里 ${onDisk.sizes}/${wanted}，RT_ICON ${onDisk.rt}/${wanted}）`);
      }
      console.log(`[图标] ✓ 已写入并复核通过：${path.relative(root, exePath)}`);
      return;
    }
  }

  fail(
    `重试 3 次仍未写进图标（最后一次：组里 ${last?.report.sizes}/${wanted}，RT_ICON ${last?.report.rt}/${wanted}）。` +
      `\n        可能原因：pack 在图标之后又跑了一次（exe 被覆盖）、或 resedit 对这张 exe 不生效。\n` +
      `        处理：先 pack 再 apply-icon，别颠倒；确认无误后重试。⛔ 这个包不能发。`,
  );
}

main().catch((e) => fail(e.stack || e.message));
