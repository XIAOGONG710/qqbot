// node src/ops/platform-cli.ts status [--data-dir D]
// node src/ops/platform-cli.ts resume <平台> --acknowledge-account-risk [--data-dir D]
// 平台账号的持久熔断器（src/platform-breaker.ts，ADR 0147）：看哪些平台被熔断了，人确认过之后恢复。
// 恢复只能在这里做——程序和模型都没有恢复的入口。被风控之后先去平台那边看一眼账号有没有被限制，再恢复。

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { breakerPath, createBreaker } from '../bilibili/platform-breaker.ts';

const args = process.argv.slice(2);
const flagValue = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), flagValue('--data-dir') ?? 'runtime/bot');
const command = args[0];

function platforms(): string[] {
    const root = join(dataDir, 'platforms');
    return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
}

if (command === 'status') {
    const names = platforms();
    if (!names.length) console.log('还没有任何平台记录过熔断状态（没有被风控过）。');
    for (const platform of names) {
        const state = createBreaker({ dataDir, platform }).state();
        console.log(state
            ? `${platform}：已熔断 ${new Date(state.trippedAt).toLocaleString('zh-CN')}，原因 ${state.reason}${state.code !== undefined ? `（${state.code}）` : ''}`
            : `${platform}：正常`);
    }
} else if (command === 'resume') {
    const platform = args[1];
    if (!platform || platform.startsWith('--')) { console.error('用法：resume <平台> --acknowledge-account-risk'); process.exit(2); }
    if (!args.includes('--acknowledge-account-risk')) {
        console.error('恢复前请先去平台那边看一眼账号有没有被限制，确认了再加 --acknowledge-account-risk');
        process.exit(2);
    }
    if (!existsSync(breakerPath(dataDir, platform))) { console.error(`没有 ${platform} 的熔断记录（数据目录 ${dataDir}）`); process.exit(2); }
    createBreaker({ dataDir, platform, log: message => console.log(message) }).resume();
} else {
    console.error('用法：status | resume <平台> --acknowledge-account-risk   [--data-dir D]');
    process.exit(2);
}
