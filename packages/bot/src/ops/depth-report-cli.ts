// node src/ops/depth-report-cli.ts <sim 输出目录> [<另一个目录> ...]（深度评估的数字，ADR 0205）
//   目录写 runtime/sim/<时间>-<tag> 或只写 <时间>-<tag>（相对 runtime/sim）。给两个以上就一行一个，方便比较。
//   只打印数字（走深思几轮、气泡多长、几种常见说法各占多少），不打印她说的话。

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRuns, numbersLine, numbersOf } from './depth-report.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const dirs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (!dirs.length) { console.error('用法：node src/ops/depth-report-cli.ts <sim 输出目录> [...]'); process.exit(2); }

let failed = false;
for (const arg of dirs) {
    const base = process.env.INIT_CWD ?? process.cwd();
    const dir = isAbsolute(arg) ? arg : [resolve(base, arg), resolve(repoRoot, 'runtime/sim', arg)].find(candidate => collectRuns(candidate).length) ?? resolve(base, arg);
    const runs = collectRuns(dir);
    if (!runs.length) { console.error(`${arg}：没找到 report.md`); failed = true; continue; }
    console.log(numbersLine(arg.replace(/^.*[\\/]/, ''), numbersOf(runs), runs.length));
}
if (failed) process.exitCode = 1;
