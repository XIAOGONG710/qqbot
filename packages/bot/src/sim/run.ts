// 模拟器入口（ADR 0005）：npm run sim -w @qqbot/bot -- <场景文件或目录>... [--runs 3] [--keep-bank] [--no-memory] [--card <目录>] [--pin-examples on|off] [--tag <名字>] [--parallel N]
// 用 runtime/bot/config.json 的模型、提示词、记忆和角色卡配置（key 同 bot，从 QQBOT_LLM_API_KEY 读），
// 每个场景跑 --runs 次（不带记忆的并行；带记忆的默认一次一个，免得挤爆和线上共用的 Postgres；--parallel 改），每次的数据和报告在 runtime/sim/<时间>/<场景>/r<n>/，Hindsight 用临时 bank，跑完删掉。
// 不碰 bot 的聊天记录、锁和 bank，bot 运行中也可以跑。
// --card：用这个目录里的卡（文件名同配置里的，A/B 用临时目录；改 characters/*/st/ 等于直接上线，ADR 0019）；
// --pin-examples：只对这次模拟改示例常驻（ADR 0019 决策 6），其余同配置。
// --context-turns N：开了记忆时原始聊天只放最近 N 轮、更早的整理成要点，代替最近 80 条（ADR 0043 离线实验，线上没有这个开关）；--context-step K：切口每 K 轮挪一次，默认 4。

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardKey, loadConfig } from '../config.ts';
import { loadTierCard } from '../contact.ts';
import { unlimitedModelGuard } from '../llm.ts';
import { HindsightClient } from '../memory/hindsight.ts';
import { checkSummary, exitSummary, renderReport } from './report.ts';
import { runScenario } from './runner.ts';
import { loadScenario } from './scenario.ts';

// 模拟器自己控制并发（--parallel），不受线上那套并发 / 日额度限制（ADR 0070 第 7 项）
unlimitedModelGuard();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };

const runs = Number(option('--runs') ?? 3);
const keepBank = flag('--keep-bank');
const noMemory = flag('--no-memory');
const cardDir = option('--card');
const pinExamples = option('--pin-examples');
const tag = option('--tag');
// 挑候选（ADR 0041）：不写照 bot 的配置，A/B 时写 --candidates 1 / 3
const candidatesOption = option('--candidates');
// 同时跑几次：不带记忆的默认全部并行；带记忆的默认一次一个——本机只有 6 GB 内存，3 次并行的带记忆场景两次把和线上共用的 Postgres 挤到
// out of memory、崩溃恢复（10-07 18:17、19:51，各 2–3 秒自动恢复，线上的库没事）
const parallelOption = option('--parallel');
const contextTurnsOption = option('--context-turns');
const contextStepOption = option('--context-step');
const contextTurns = contextTurnsOption === undefined ? undefined : { turns: Number(contextTurnsOption), step: Number(contextStepOption ?? 4) };
const parallel = parallelOption === undefined ? undefined : Number(parallelOption);
if (args.length === 0 || !Number.isInteger(runs) || runs < 1 || (parallel !== undefined && (!Number.isInteger(parallel) || parallel < 1)) || (pinExamples !== undefined && !['on', 'off'].includes(pinExamples))
    || (contextTurns && ![contextTurns.turns, contextTurns.step].every(n => Number.isInteger(n) && n >= 1))) {
    console.error('用法：npm run sim -w @qqbot/bot -- <场景文件或目录>... [--runs 3] [--keep-bank] [--no-memory] [--card <目录>] [--pin-examples on|off] [--tag <名字>] [--parallel N] [--candidates N] [--context-turns N [--context-step K]]');
    process.exit(2);
}

const files = args.flatMap(arg => {
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
    if (!existsSync(path)) throw new Error(`找不到 ${path}`);
    return statSync(path).isDirectory()
        ? readdirSync(path).filter(f => f.endsWith('.json')).sort().map(f => join(path, f))
        : [path];
});

const loaded = loadConfig(repoRoot);
const config = {
    ...loaded,
    ...(cardDir ? { characterCard: join(resolve(process.env.INIT_CWD ?? process.cwd(), cardDir), basename(loaded.characterCard)) } : {}),
    ...(pinExamples ? { prompt: { ...loaded.prompt, pinExamples: pinExamples === 'on' } } : {}),
};
if (contextTurns) console.log(`上下文：最近 ${contextTurns.turns} 轮原文 + 更早的要点（切口每 ${contextTurns.step} 轮挪一次）`);
if (cardDir || pinExamples) console.log(`卡：${config.characterCard}；示例常驻：${config.prompt.pinExamples ? '开' : '关'}`);
const hindsight = config.memory && !noMemory ? new HindsightClient(config.memory.baseUrl, config.memory.timeoutMs) : undefined;
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
// 批次目录：时间（到秒）加 --tag；同一秒起了几个批次（并行跑 A/B）时后面的加 -2、-3，不然会写进同一个目录、互相覆盖。
const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${tag ? `-${tag}` : ''}`;
let stamp = base;
for (let n = 2; existsSync(join(repoRoot, 'runtime', 'sim', stamp)); n++) stamp = `${base}-${n}`;
const root = join(repoRoot, 'runtime', 'sim', stamp);
mkdirSync(root, { recursive: true });

let failed = 0;
for (const [fileIndex, file] of files.entries()) {
    const scenario = loadScenario(file);
    const card = loadTierCard(config.characterCard, cardKey({ tier: scenario.tier, knowsBot: scenario.knowsBot }));
    // 日记里的世界按同学档（ADR 0026，和 bot 一样）
    const diaryCard = loadTierCard(config.characterCard, 'classmate').character;
    const diaryWorld = diaryCard.herWorld;
    const diaryWorldSchedule = diaryCard.schedule;
    const name = basename(file, '.json');
    console.log(`${name}：${scenario.tier} 档，跑 ${runs} 次${hindsight && scenario.memory ? '（带记忆）' : ''}……`);
    const width = parallel ?? (hindsight && scenario.memory ? 1 : runs);
    const results = await inBatches(runs, width, async i => {
        const dataDir = join(root, name, `r${i + 1}`);
        const result = await runScenario(scenario, {
            runId: `${stamp}-s${fileIndex + 1}r${i + 1}`,
            dataDir,
            card,
            llm: config.llm,
            prompt: config.prompt,
            speechCheck: config.speechCheck,
            herDays: config.herDays,
            candidates: candidatesOption === undefined ? config.candidates : Number(candidatesOption),
            ...(diaryWorld ? { diaryWorld } : {}),
            ...(diaryWorldSchedule ? { diaryWorldSchedule } : {}),
            hindsight,
            recallTimeoutMs: config.memory?.recallTimeoutMs,
            keepBank,
            ...(contextTurns ? { contextTurns } : {}),
        });
        writeFileSync(join(dataDir, 'report.md'), renderReport(result));
        writeFileSync(join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
        return result;
    });
    for (const [i, result] of results.entries()) {
        failed += result.checks.failed;
        console.log(`  r${i + 1}：检查 ${checkSummary(result.checks)} · ${exitSummary(result)} → ${join(result.dataDir, 'report.md')}`);
    }
}
process.exit(failed > 0 ? 1 : 0);

/** 跑 count 次 job，同时最多 width 个；结果按次序返回 */
async function inBatches<T>(count: number, width: number, job: (i: number) => Promise<T>): Promise<T[]> {
    const results: T[] = new Array(count);
    let next = 0;
    const worker = async () => { while (next < count) { const i = next++; results[i] = await job(i); } };
    await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
    return results;
}
