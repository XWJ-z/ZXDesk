#!/usr/bin/env python3
"""检查打好的绿色 zip（`npm run dist` 的最后一步）。

用法：
    python3 build/verify-zip.py release/zxdesk-windows-0.1.6-x64.zip \
        --expect-version 0.1.6 \
        --dump-asar /tmp/app.asar --dump-exe /tmp/ZXDesk.exe

检查项（都是踩过的）：
- 压缩包能通过 CRC 校验（`testzip()`）；
- 顶层目录只有一个 `ZXDesk-win32-x64/`（解压即用，不套两层）；
- 里面**不许**有 `node_modules/`、`data/`、`.dev-data/`、`tests/`（体积 / 隐私 / 用户数据）；
- `ZXDesk.exe` 与 `resources/app.asar` 都在，且 exe 大小正常（> 100 MB，说明不是空壳）；
- `package.json`（asar 里，由调用方解）版本由 node 侧核对 —— 这里只把 asar/exe 抠出来。
"""

import argparse
import os
import sys
import zipfile

TOP = 'ZXDesk-win32-x64'
FORBIDDEN = ('node_modules/', '/data/', '.dev-data/', '/tests/')
MIN_EXE = 100 * 1024 * 1024


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('zip')
    ap.add_argument('--expect-version', default='')
    ap.add_argument('--dump-asar', default='')
    ap.add_argument('--dump-exe', default='')
    args = ap.parse_args()

    problems = []
    notes = []

    if not os.path.exists(args.zip):
        print(f'✗ 找不到包：{args.zip}')
        return 1

    with zipfile.ZipFile(args.zip) as z:
        names = z.namelist()
        bad = z.testzip()
        if bad:
            problems.append(f'CRC 校验失败：{bad}')
        else:
            notes.append(f'CRC 通过（{len(names)} 条目）')

        tops = sorted({n.split('/')[0] for n in names})
        if tops != [TOP]:
            problems.append(f'顶层目录应只有 {TOP}/，实际 {tops}')
        else:
            notes.append(f'顶层目录 {TOP}/')

        hit = [n for n in names if any(f in n for f in FORBIDDEN)]
        if hit:
            problems.append(f'包里不该有这些：{hit[:5]}')
        else:
            notes.append('无 node_modules / data / .dev-data / tests')

        exe_name = f'{TOP}/ZXDesk.exe'
        asar_name = f'{TOP}/resources/app.asar'
        for needed in (exe_name, asar_name):
            if needed not in names:
                problems.append(f'缺 {needed}')
        if exe_name in names:
            size = z.getinfo(exe_name).file_size
            if size < MIN_EXE:
                problems.append(f'exe 只有 {size} 字节，像是空壳')
            else:
                notes.append(f'exe {size:,} 字节')
            if args.dump_exe:
                with z.open(exe_name) as f, open(args.dump_exe, 'wb') as g:
                    g.write(f.read())
        if asar_name in names and args.dump_asar:
            with z.open(asar_name) as f, open(args.dump_asar, 'wb') as g:
                g.write(f.read())

    for line in notes:
        print(f'✓ {line}')
    for line in problems:
        print(f'✗ {line}')
    if problems:
        return 1
    print('✓ 包结构没问题')
    return 0


if __name__ == '__main__':
    sys.exit(main())
