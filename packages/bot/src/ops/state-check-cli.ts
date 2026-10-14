// node src/ops/state-check-cli.ts <数据目录>：用当前代码的读取函数检查一份数据目录（先复制，不改原目录）。退出码 1 = 有文件会被拒绝或隔离。
import { resolve } from 'node:path';
import { checkStates } from './state-check.ts';

const dir = process.argv[2];
if (!dir) {
    console.error('用法：node src/ops/state-check-cli.ts <数据目录>（线上是 runtime/bot；先复制再检查，不会改它）');
    process.exit(2);
}
const checks = checkStates(resolve(process.env.INIT_CWD ?? process.cwd(), dir));
for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(28)} ${check.file.replaceAll(String.fromCharCode(92), '/').padEnd(34)} ${check.detail}`);
const bad = checks.filter(check => !check.ok);
console.log(bad.length ? `不通过：${bad.length} 个文件上线后会被拒绝或隔离` : `通过：${checks.length} 项`);
process.exit(bad.length ? 1 : 0);
