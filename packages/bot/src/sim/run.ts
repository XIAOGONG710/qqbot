// 模拟器入口（ADR 0005）：npm run sim -w @qqbot/bot -- <场景文件或目录>... [--runs 3] [--keep-bank] [--no-memory]
// 用 runtime/bot/config.json 的模型、提示词、记忆和角色卡配置（key 同 bot，从 QQBOT_LLM_API_KEY 读），
// 每个场景跑 --runs 次（并行），每次的数据和报告在 runtime/sim/<时间>/<场景>/r<n>/，Hindsight 用临时 bank，跑完删掉。
// 不碰 bot 的聊天记录、锁和 bank，bot 运行中也可以跑。

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
if (args.length === 0 || !Number.isInteger(runs) || runs < 1) {
    console.error('用法：npm run sim -w @qqbot/bot -- <场景文件或目录>... [--runs 3] [--keep-bank] [--no-memory]');
    process.exit(2);
}

const files = args.flatMap(arg => {
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
    if (!existsSync(path)) throw new Error(`找不到 ${path}`);
    return statSync(path).isDirectory()
        ? readdirSync(path).filter(f => f.endsWith('.json')).sort().map(f => join(path, f))
        : [path];
});

const config = loadConfig(repoRoot);
const hindsight = config.memory && !noMemory ? new HindsightClient(config.memory.baseUrl, config.memory.timeoutMs) : undefined;
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const root = join(repoRoot, 'runtime', 'sim', stamp);

let failed = 0;
for (const [fileIndex, file] of files.entries()) {
    const scenario = loadScenario(file);
    const card = loadTierCard(config.characterCard, scenario.tier);
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
