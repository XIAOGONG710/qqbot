// 群聊模拟入口（ADR 0341 G0）：npm run sim:group -w @qqbot/bot -- <剧本文件或目录>... [--runs 3] [--tag <名字>] [--model <名>] [--thinking off|high|max] [--card <含 {tier} 的卡文件>]
// 模型和 key 同 run.ts（runtime/bot/config.json + QQBOT_LLM_API_KEY）；角色默认用合成角色（ADR 0333），不读真实资料。
// 每个剧本跑 --runs 次（依次跑，真实时间，一次几十秒到几分钟），记录写到 runtime/sim/<时间>-group[-tag]/<剧本>/r<n>.md，汇总在 summary.md。
// 剧本格式见 group-runner.ts 的 GroupScenario；例子在 packages/bot/sim/group/。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../platform/config.ts';
import { unlimitedModelGuard } from '../language/llm.ts';
import { renderGroupRun, runGroupScenario, type GroupScenario } from './group-runner.ts';

unlimitedModelGuard();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
const runs = Number(option('--runs') ?? 3);
const tag = option('--tag');
const modelOption = option('--model');
const thinkingOption = option('--thinking');
const cardOption = option('--card');
if (args.length === 0 || !Number.isInteger(runs) || runs < 1
    || (thinkingOption !== undefined && !['off', 'high', 'max'].includes(thinkingOption))
    || (modelOption !== undefined && !/^[A-Za-z0-9._:-]{1,60}$/.test(modelOption))) {
    console.error('用法：npm run sim:group -w @qqbot/bot -- <剧本文件或目录>... [--runs 3] [--tag <名字>] [--model <名>] [--thinking off|high|max] [--card <含 {tier} 的卡文件>]');
    process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const files = args.flatMap(arg => {
    const path = resolve(cwd, arg);
    if (!existsSync(path)) throw new Error(`找不到 ${path}`);
    return statSync(path).isDirectory() ? readdirSync(path).filter(f => f.endsWith('.json')).sort().map(f => join(path, f)) : [path];
});

const loaded = loadConfig(repoRoot);
const { reasoning_effort: _dropEffort, ...extraWithoutEffort } = (loaded.llm.extraBody ?? {}) as Record<string, unknown>;
const llm = {
    ...loaded.llm,
    ...(modelOption !== undefined ? { model: modelOption } : {}),
    ...(thinkingOption === 'off' ? { extraBody: { ...extraWithoutEffort, thinking: { type: 'disabled' } } } : {}),
    ...(thinkingOption === 'high' || thinkingOption === 'max'
        ? { maxTokens: Math.max(loaded.llm.maxTokens, 4000), timeoutMs: Math.max(loaded.llm.timeoutMs, 180_000), extraBody: { ...extraWithoutEffort, thinking: { type: 'enabled' }, reasoning_effort: thinkingOption } }
        : {}),
};
const characterCard = cardOption ? resolve(cwd, cardOption) : join(repoRoot, 'packages', 'bot', 'test', 'fixtures', 'synthetic-character', 'st', 'synthetic-{tier}.json');
console.log(`模型：${llm.model}；思考：${thinkingOption ?? '同配置'}；卡：${characterCard}`);

const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-group${tag ? `-${tag}` : ''}`;
const root = join(repoRoot, 'runtime', 'sim', stamp);
mkdirSync(root, { recursive: true });

const summary: string[] = [`# 群聊模拟 ${stamp}`, '', `模型 ${llm.model}，思考 ${thinkingOption ?? '同配置'}，每个剧本 ${runs} 次`, '', '| 剧本 | 每次开口 | 理由 |', '|---|---|---|'];
for (const file of files) {
    const scenario = JSON.parse(readFileSync(file, 'utf8')) as GroupScenario;
    const name = basename(file, '.json');
    mkdirSync(join(root, name), { recursive: true });
    const counts: number[] = [];
    const reasons: Record<string, number> = {};
    for (let r = 1; r <= runs; r++) {
        console.log(`${name} r${r}…`);
        // 每次换一组消息编号：插话抽签按编号定，编号一样的话几次跑抽到的签一模一样（11-20 第一批 3 次结果逐项相同就是这个原因）
        const run = await runGroupScenario(scenario, { base: { ...loaded, llm }, characterCard, firstMessageId: 6000 + Math.floor(Math.random() * 1_000_000) * 100 });
        writeFileSync(join(root, name, `r${r}.md`), renderGroupRun(scenario, run));
        counts.push(run.spoke);
        for (const [reason, n] of Object.entries(run.reasons)) reasons[reason] = (reasons[reason] ?? 0) + n;
    }
    summary.push(`| ${name} | ${counts.join(' / ')} | ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join('、') || '无'} |`);
}
writeFileSync(join(root, 'summary.md'), summary.join('\n') + '\n');
console.log(`写在 ${root}`);
