// 行为基线的并行跑法：和 baseline.test.ts 同一套场景（scenarios.ts）、同一个比对（compare.ts），分给几个子进程跑。
// 串行的 baseline.test.ts 要 25 分钟以上；ADR 0336 每一步都要核对基线，两边以前各自临时写分片脚本，这里收成一个。
//
// 用法（在 packages/bot 下，或仓库根加 -w @qqbot/bot）：
//   npm run baseline:fast                    全部场景，进程数 = CPU 数 - 1（最多 8）
//   npm run baseline:fast -- --jobs 4        指定进程数
//   npm run baseline:fast -- --only a,b      只跑这几个场景（逗号分隔的场景名）
// 有不一样的：退出码 1，每个不一样的场景给出第一处不同和实际结果的路径（和 baseline.test.ts 一样）。
// 更新快照不走这里：有意改行为时照旧 UPDATE_BASELINE=1 跑 baseline.test.ts，单独提交并写清为什么变。
//
// 分发：一个场景跑完再给这个进程下一个，上次跑得久的先发（场景长短差很多，静态分片或长的排在最后，都会剩一个进程拖着）。
// 每个子进程依次跑分到的场景，和 baseline.test.ts 在一个进程里依次跑全部一样；场景之间不共享进程以外的东西（harness 每次用新的临时目录）。

import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface Job { name: string }
export interface Result { name: string; ok: boolean; ms: number; problem?: string }

export interface Options { jobs: number; only?: string[] }

/** 命令行参数；不认识的返回错误说明 */
export function parseOptions(args: readonly string[], cpus: number): Options | string {
    let jobs = Math.max(1, Math.min(8, cpus - 1));
    let only: string[] | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = args[i + 1];
        if (arg === '--jobs' && value && /^\d+$/.test(value) && Number(value) >= 1) { jobs = Number(value); i++; continue; }
        if (arg === '--only' && value) { only = value.split(',').map(name => name.trim()).filter(Boolean); i++; continue; }
        return `不认识的参数：${arg}${arg === '--jobs' || arg === '--only' ? '（后面要跟值）' : ''}`;
    }
    return { jobs, ...(only?.length ? { only } : {}) };
}

/** 要跑哪些：--only 里有不存在的场景名就报错（别让打错名字的场景悄悄没跑） */
export function pickScenarios(all: readonly string[], only: readonly string[] | undefined): string[] | string {
    if (!only) return [...all];
    const unknown = only.filter(name => !all.includes(name));
    if (unknown.length) return `没有这些场景：${unknown.join('、')}`;
    return all.filter(name => only.includes(name));
}

/** 每个场景上次跑了多久（毫秒），存在系统临时目录；只用来排先后，丢了不要紧 */
export const TIMES_FILE = 'qqbot-baseline-times.json';

export function readTimes(path: string): Record<string, number> {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    } catch { return {}; }
}

/** 长的先发：没记过的当最长（先发，顺便记下来）；同样长的保持原顺序 */
export function longestFirst(names: readonly string[], times: Readonly<Record<string, number>>): string[] {
    const cost = (name: string) => times[name] ?? Infinity;
    return names.map((name, index) => ({ name, index })).sort((a, b) => cost(b.name) - cost(a.name) || a.index - b.index).map(item => item.name);
}

/** 汇总：几个过、几个不一样，不一样的逐个列出 */
export function summarize(results: readonly Result[], total: number, ms: number): { ok: boolean; text: string } {
    const failed = results.filter(result => !result.ok);
    const missing = total - results.length;
    const lines = [`行为基线：${results.length - failed.length}/${total} 逐字一致${missing ? `，${missing} 个没跑完` : ''}（${(ms / 1000).toFixed(0)} 秒）`];
    for (const result of failed) lines.push(`\n✖ ${result.name}\n${result.problem ?? ''}`);
    return { ok: failed.length === 0 && missing === 0, text: lines.join('\n') };
}

// ───────── 子进程：收到场景名就跑、比对、回报 ─────────

async function worker(): Promise<void> {
    const { runScenario } = await import('./harness.ts');
    const { SCENARIOS } = await import('./scenarios.ts');
    const { compareSnapshot } = await import('./compare.ts');
    process.on('message', async (job: Job | 'exit') => {
        if (job === 'exit') { process.disconnect?.(); return; }
        const started = Date.now();
        let result: Result;
        try {
            const scenario = SCENARIOS.find(item => item.name === job.name);
            if (!scenario) throw new Error(`没有场景 ${job.name}`);
            const problem = compareSnapshot(scenario.name, await runScenario(scenario));
            result = { name: job.name, ok: !problem, ms: Date.now() - started, ...(problem ? { problem } : {}) };
        } catch (error) {
            result = { name: job.name, ok: false, ms: Date.now() - started, problem: `跑的时候出错：${error instanceof Error ? error.stack ?? error.message : String(error)}` };
        }
        process.send!(result);
    });
    process.send!('ready');
}

// ───────── 主进程：分发、收结果、汇总 ─────────

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2), availableParallelism());
    if (typeof options === 'string') {
        console.error(`${options}\n用法：npm run baseline:fast -- [--jobs N] [--only 场景名,场景名]`);
        process.exit(2);
    }
    const { SCENARIOS } = await import('./scenarios.ts');
    if (new Set(SCENARIOS.map(s => s.name)).size !== SCENARIOS.length) { console.error('场景名有重复'); process.exit(1); }
    const names = pickScenarios(SCENARIOS.map(s => s.name), options.only);
    if (typeof names === 'string') { console.error(names); process.exit(2); }
    // 上次每个场景跑了多久（本机临时目录）：长的先发，免得最后剩一个长场景拖着
    const timesFile = join(tmpdir(), TIMES_FILE);
    const times = readTimes(timesFile);
    const queue = longestFirst(names, times);
    const results: Result[] = [];
    const started = Date.now();
    const self = fileURLToPath(import.meta.url);
    // --import 要 URL：Windows 上的绝对路径（c:…）会被当成 c: 协议
    const tzSetup = pathToFileURL(resolve(import.meta.dirname, '..', 'time-zone-setup.ts')).href;
    const jobs = Math.min(options.jobs, names.length);
    console.log(`行为基线：${names.length} 个场景，${jobs} 个进程`);

    await Promise.all(Array.from({ length: jobs }, () => new Promise<void>(done => {
        const child: ChildProcess = fork(self, ['--worker'], { execArgv: ['--import', tzSetup], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        let current: string | undefined;
        const next = () => {
            current = queue.shift();
            if (current) child.send({ name: current } satisfies Job);
            else { child.send('exit'); }
        };
        child.on('message', (message: Result | 'ready') => {
            if (message !== 'ready') {
                results.push(message);
                console.log(`${message.ok ? '✔' : '✖'} ${message.name}（${(message.ms / 1000).toFixed(1)} 秒）  ${results.length}/${names.length}`);
            }
            next();
        });
        child.on('exit', code => {
            // 子进程中途死了：它手上那个算没过，剩下的交给别的进程
            if (current && !results.some(result => result.name === current)) {
                results.push({ name: current, ok: false, ms: 0, problem: `子进程退出了（退出码 ${code}），这个场景没跑完` });
            }
            done();
        });
    })));

    for (const result of results) if (result.ms > 0) times[result.name] = result.ms;
    try { writeFileSync(timesFile, JSON.stringify(times, null, 2)); } catch { /* 记不下就下次照原顺序 */ }
    const summary = summarize(results, names.length, Date.now() - started);
    console.log(`\n${summary.text}`);
    const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3);
    if (slowest.length) console.log(`最慢的：${slowest.map(result => `${result.name} ${(result.ms / 1000).toFixed(0)} 秒`).join('、')}`);
    process.exit(summary.ok ? 0 : 1);
}

if (process.argv.includes('--worker')) void worker();
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
