// 模拟器入口（ADR 0005）：npm run sim -w @qqbot/bot -- <场景文件或目录>... [--runs 3] [--keep-bank] [--no-memory] [--card <目录>] [--pin-examples on|off] [--tag <名字>]
// 用 runtime/bot/config.json 的模型、提示词、记忆和角色卡配置（key 同 bot，从 QQBOT_LLM_API_KEY 读），
// 每个场景跑 --runs 次（并行），每次的数据和报告在 runtime/sim/<时间>/<场景>/r<n>/，Hindsight 用临时 bank，跑完删掉。
// 不碰 bot 的聊天记录、锁和 bank，bot 运行中也可以跑。
// --card：用这个目录里的卡（文件名同配置里的，A/B 用临时目录；改 characters/*/st/ 等于直接上线，ADR 0019）；
// --pin-examples：只对这次模拟改示例常驻（ADR 0019 决策 6），其余同配置。

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { loadTierCard } from '../contact.ts';
import { HindsightClient } from '../memory/hindsight.ts';
import { renderReport } from './report.ts';
import { runScenario } from './runner.ts';
import { loadScenario } from './scenario.ts';

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
if (args.length === 0 || !Number.isInteger(runs) || runs < 1 || (pinExamples !== undefined && !['on', 'off'].includes(pinExamples))) {
    console.error('用法：npm run sim -w @qqbot/bot -- <场景文件或目录>... [--runs 3] [--keep-bank] [--no-memory] [--card <目录>] [--pin-examples on|off] [--tag <名字>]');
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
    const card = loadTierCard(config.characterCard, scenario.tier);
    // 日记里的世界按同学档（ADR 0026，和 bot 一样）
    const diaryWorld = loadTierCard(config.characterCard, 'classmate').character.herWorld;
    const name = basename(file, '.json');
    console.log(`${name}：${scenario.tier} 档，跑 ${runs} 次${hindsight && scenario.memory ? '（带记忆）' : ''}……`);
    const results = await Promise.all(Array.from({ length: runs }, async (_, i) => {
        const dataDir = join(root, name, `r${i + 1}`);
        const result = await runScenario(scenario, {
            runId: `${stamp}-s${fileIndex + 1}r${i + 1}`,
            dataDir,
            card,
            llm: config.llm,
            prompt: config.prompt,
            speechCheck: config.speechCheck,
            herDays: config.herDays,
            ...(diaryWorld ? { diaryWorld } : {}),
            hindsight,
            recallTimeoutMs: config.memory?.recallTimeoutMs,
            keepBank,
        });
        writeFileSync(join(dataDir, 'report.md'), renderReport(result));
        writeFileSync(join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
        return result;
    }));
    for (const [i, result] of results.entries()) {
        failed += result.checks.failed;
        console.log(`  r${i + 1}：检查 ${result.checks.passed} 通过 / ${result.checks.failed} 不通过 → ${join(result.dataDir, 'report.md')}`);
    }
}
process.exit(failed > 0 ? 1 : 0);
