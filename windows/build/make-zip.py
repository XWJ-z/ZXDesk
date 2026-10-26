#!/usr/bin/env python3
"""把打包目录压成绿色 zip（本机没有 `zip` 命令，用标准库 zipfile）。

用法：
    python3 build/make-zip.py build/out/ZXDesk-win32-x64 ../../release/zxdesk-windows-0.1.0-x64.zip

规矩（任务单 §10.3）：
- 保留**顶层目录** `ZXDesk-win32-x64/`，解压即用；
- 包内**不得**出现 `node_modules`；
- 用 ZIP_DEFLATED；排除 `.dev-data/`、`data/`（那是用户数据，⛔ 不能打进包）。
"""

import os
import sys
import zipfile

EXCLUDE_DIRS = {"node_modules", ".dev-data", ".git", "__pycache__"}


def should_skip(rel_path: str) -> bool:
    parts = rel_path.replace("\\", "/").split("/")
    if any(part in EXCLUDE_DIRS for part in parts):
        return True
    # 顶层 data/ 是运行期生成的数据目录，绝不能进包
    if len(parts) > 1 and parts[0] == "data":
        return True
    return False


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: make-zip.py <源目录> <输出 zip>", file=sys.stderr)
        return 2

    src_dir = os.path.abspath(sys.argv[1])
    out_zip = os.path.abspath(sys.argv[2])
    if not os.path.isdir(src_dir):
        print(f"源目录不存在：{src_dir}", file=sys.stderr)
        return 2

    top = os.path.basename(src_dir)
    os.makedirs(os.path.dirname(out_zip), exist_ok=True)

    count = 0
    total = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src_dir).replace("\\", "/")
                if should_skip(rel):
                    continue
                arcname = f"{top}/{rel}"
                zf.write(full, arcname)
                count += 1
                total += os.path.getsize(full)

    size = os.path.getsize(out_zip)
    print(f"已打包 {count} 个文件（原始 {total/1024/1024:.1f} MB）")
    print(f"输出：{out_zip}（{size/1024/1024:.1f} MB）")
    print(f"顶层目录：{top}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
