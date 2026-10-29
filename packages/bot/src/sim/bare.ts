// 「不带框架」对照臂（ADR 0175）：同一份角色卡、同一段聊天记录，只走 SillyTavern 式的拼法（buildPrompt：卡 + 世界书 + 示例 + 聊天记录），
// 单次生成、不做任何后处理。用来回答用户 10-29 的直觉「可能是框架束缚了她」：
//   A = 现在的全套管线（sim/run.ts：运行时塞进去的时间 / 心情 / 记忆 / 提示行 + 出口检查 / shape / tailCap / deliberate …）
//   B = 这里（只有卡）
// 两边出的回复用 exchange/tools/measure/make-blind-pack.cjs 各出一份盲评包，让人评；B 更像真人 → 管线在束缚她，按组消融；B 不更像 → 瓶颈在模型脾气，去做提示词之外的状态与决定。
// 注意：卡本身也带规则（system_prompt / post_history_instructions 里写了怎么说话），这里不去掉——B 是「卡作者写的东西」，不是「一个空白模型」。
//
// 用法：node packages/bot/src/sim/bare.ts <cases.json> --out <hers.json> [--limit N] [--parallel N] [--thinking off]
//   cases.json：make-ctx-variants.cjs 写的 ctx-cases-*.json（[{ id, stimulus: [..], human: [..], context: [{ role, content }] }]）
//   hers.json：{ [id]: string[] } —— make-blind-pack.cjs 要的格式
// 配置照 runtime/bot/config.json（QQBOT_CONFIG 可以换），key 从 QQBOT_LLM_API_KEY 读；不碰聊天记录、记忆和线上的锁。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPrompt, type ChatMessage, type OpenAIMessage, type PromptSettings } from '../language/prompt.ts';
import { splitReply } from '../language/reply.ts';
import { estimateTokens } from '../language/tokens.ts';
import type { TierCard } from '../platform/contact.ts';

export interface BareCase {
    id: string;
    /** 他这一轮说的话，一条一个气泡 */
    stimulus: string[];
    /** 更早的聊天（旧到新） */
    context?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface BareSetup {
    card: TierCard;
    userName: string;
    settings: PromptSettings;
    now: Date;
}

/** 只有卡 + 聊天记录的提示词：不带运行时的 afterMain / afterHistory（时间、心情、记忆、提示行都没有） */
export function bareMessages(setup: BareSetup, item: BareCase): OpenAIMessage[] {
    const history: ChatMessage[] = [
        ...(item.context ?? []).map(line => ({ role: line.role, content: line.content })),
        ...item.stimulus.map(content => ({ role: 'user' as const, content })),
    ];
    return buildPrompt({
        character: setup.card.character,
        worldInfo: setup.card.worldInfo,
        history,
        userName: setup.userName,
        now: setup.now,
        settings: setup.settings,
        countTokens: estimateTokens,
        random: () => 0.5,
    }).messages;
}

/** 模型的回复按行拆成气泡（和线上发出去的拆法一样：换行 = 连发几条），其余原样 */
export const bubblesOf = (reply: string): string[] => splitReply(reply);

export interface BareRun {
    hers: Record<string, string[]>;
    failed: Array<{ id: string; error: string }>;
}

export async function runBare(
    cases: readonly BareCase[],
    deps: { setup: BareSetup; generate: (messages: OpenAIMessage[]) => Promise<string>; parallel?: number; log?: (message: string) => void },
): Promise<BareRun> {
    const hers: Record<string, string[]> = {};
    const failed: BareRun['failed'] = [];
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const item = cases[next++]!;
            try {
                const bubbles = bubblesOf(await deps.generate(bareMessages(deps.setup, item)));
                if (bubbles.length) hers[item.id] = bubbles;
                else failed.push({ id: item.id, error: '模型回了空话' });
            } catch (error) {
                failed.push({ id: item.id, error: error instanceof Error ? error.message : String(error) });
            }
            deps.log?.(`${Object.keys(hers).length + failed.length}/${cases.length}`);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.parallel ?? 4, cases.length)) }, worker));
    return { hers, failed };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
    const outPath = option('--out');
    const limit = option('--limit');
    const parallel = option('--parallel');
    const thinking = option('--thinking');
    const casesPath = args[0];
    if (!casesPath || !outPath || (thinking !== undefined && thinking !== 'off')) {
        console.error('用法：node packages/bot/src/sim/bare.ts <cases.json> --out <hers.json> [--limit N] [--parallel N] [--thinking off]');
        process.exit(2);
    }
    // 动态引入：测试里只用上面的纯函数，不要把整个配置 / 模型层拉进来
    const { cardKey, loadConfig } = await import('../platform/config.ts');
    const { loadTierCard } = await import('../platform/contact.ts');
    const { chatCompletion, unlimitedModelGuard } = await import('../language/llm.ts');
    unlimitedModelGuard();
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const config = loadConfig(repoRoot);
    const { reasoning_effort: _drop, ...extraWithoutEffort } = (config.llm.extraBody ?? {}) as Record<string, unknown>;
    const llm = thinking === 'off' ? { ...config.llm, extraBody: { ...extraWithoutEffort, thinking: { type: 'disabled' } } } : config.llm;
    // 和 make-ctx-variants.cjs 的场景一致：男朋友档、称呼「宝宝」、不知道她是程序的那张卡（-open）
    const card = loadTierCard(config.characterCard, cardKey({ tier: 'boyfriend' }));
    const all = JSON.parse(readFileSync(resolve(casesPath), 'utf8')) as BareCase[];
    const cases = limit === undefined ? all : all.slice(0, Number(limit));
    console.log(`不带框架：${cases.length} 题，卡 ${config.characterCard.replace('{tier}', cardKey({ tier: 'boyfriend' }))}，模型 ${llm.model}${thinking === 'off' ? '（关思考）' : ''}`);
    const { hers, failed } = await runBare(cases, {
        setup: { card, userName: '宝宝', settings: { ...config.prompt, maxTokens: llm.maxTokens }, now: new Date('2026-10-24T21:00:00+08:00') },
        generate: messages => chatCompletion(llm, messages, { purpose: 'background' }),
        ...(parallel !== undefined ? { parallel: Number(parallel) } : {}),
        log: message => process.stdout.write(`\r${message}`),
    });
    writeFileSync(resolve(outPath), JSON.stringify(hers, null, 2));
    console.log(`\n写了 ${Object.keys(hers).length} 题到 ${resolve(outPath)}${failed.length ? `；失败 ${failed.length} 题：${failed.slice(0, 3).map(item => `${item.id} ${item.error}`).join('；')}` : ''}`);
    process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
