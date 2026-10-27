// node src/ops/inner-cli.ts [--dir <主动消息状态目录>] [--last 30]
// 只读：打印她最近的念头（内心，ADR 0101）。念头存在 <数据目录>/proactive/<QQ>-<档位>.json 的 inner 里；
// 日志里默认只记字数（敏感调试关着），想看她在想什么就用这个。不改任何文件。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validInnerState, type InnerState } from '../proactive/inner.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? join(repoRoot, 'runtime/bot/proactive'));
const last = Number(one('--last') ?? 30);
const GOES = { tell: '想告诉他', ask: '想问他', keep: '自己想想' } as const;

if (!existsSync(dir)) {
    console.error(`没有这个目录：${dir}`);
    process.exit(2);
}
let shown = 0;
for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    const state = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { inner?: unknown };
    if (!state.inner) continue;
    if (!validInnerState(state.inner)) {
        console.log(`${file}：inner 不合格，跳过`);
        continue;
    }
    const inner = state.inner as InnerState;
    console.log(`${file}：共 ${inner.thoughts.length} 个念头${inner.lastThinkAt ? `，上一次想是 ${new Date(inner.lastThinkAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`);
    for (const thought of inner.thoughts.slice(-last)) {
        console.log(`  ${new Date(thought.at).toLocaleString('zh-CN', { hour12: false })}  [${GOES[thought.goes]}${thought.told ? '，已说' : ''}]  ${thought.text}`);
        shown++;
    }
}
if (!shown) console.log('还没有念头（innerLife 没开，或者还没到第一次想的时候）');
