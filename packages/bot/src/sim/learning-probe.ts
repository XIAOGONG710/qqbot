// 「学会了」探针（ADR 0340 第 0 步）：她在聊天里被说了某个说话习惯，过一夜自己想一次（「我现在的样子」，life/self-portrait.ts），
// 几天后同样的情形，她的做法有没有变、问她能不能说出为什么变。只量这一件事，不改线上任何东西。
//
// 编的场景（不读真实聊天）：
//   第 1 天：她说话老带「哈哈」、句尾老问「你呢」；他先后说「你怎么老是哈哈哈的」「别每次都问我你呢」，中间被她逗笑过一次。
//   夜里：她拿第 1 天的聊天和自己现在的样子（一开始是空的）想一次——真模型、真的 portraitMessages / 防线。
//   第 N 天：聊天记录里只有前一天几段「她照旧哈哈、照旧你呢」的话（被纠正的那天已经滚出窗口，模拟习惯的惯性），他说几句日常的话。
//   两臂：A = 卡 + 聊天记录（现在的她）；B = A + 她夜里写的那份（放在 afterMain，和线上同一个槽、同一行字）。
//   最后在两臂里各问一句「你最近说话是不是跟以前不太一样了？」，看 B 臂说不说得出来由（提到哈哈 / 你呢 / 他说过）。
//
// 判据（事先定，不事后挑）：B 臂「带哈哈」和「句尾问你呢」两项的占比都不高于 A 臂的一半，且 B 臂 2/3 以上的次数说得出来由 → 学会了。
// 只拿卡 + 记录（和 sim/bare.ts 同一种拼法），不是整条管线：量的是「这份东西有没有用」，不是线上效果。
//
// 用法：node packages/bot/src/sim/learning-probe.ts [--runs N] [--card <含 {tier} 的卡路径>] [--out <结果.json>]
//   卡默认用合成角色（packages/bot/test/fixtures/synthetic-character，ADR 0333）；配置照 runtime/bot/config.json（QQBOT_CONFIG 可以换），key 从 QQBOT_LLM_API_KEY 读。

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPrompt, type OpenAIMessage, type PromptSettings } from '../language/prompt.ts';
import { splitReply } from '../language/reply.ts';
import { estimateTokens } from '../language/tokens.ts';
import { recentExchanges } from '../language/speech-notes.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { TierCard } from '../platform/contact.ts';
import {
    applyPortraitDecision, emptyPortraitState, hisReactions, parsePortraitDecision, portraitLine, portraitMessages, CHAT_WINDOW_MS, MAX_EXCHANGES,
} from '../life/self-portrait.ts';
import { hisLines } from '../language/speech-notes.ts';
import { substituteMacros } from '../st/macros.ts';

export const USER = '宝宝';
const DAY = 86_400_000;
const MIN = 60_000;
/** 第 1 天晚上 23 点想；第 N 天是三天后的晚上 */
export const DAY1 = new Date(2026, 10, 16, 20, 0, 0).getTime();
export const NIGHT1 = DAY1 + 3 * 3_600_000;
export const DAYN = DAY1 + 3 * DAY + 3_600_000;

type Line = ['user' | 'assistant', string];
const rows = (lines: readonly Line[], from: number): StoredMessage[] => lines.map(([role, content], i) => ({ role, content, time: new Date(from + i * 2 * MIN).toISOString() }));

/** 第 1 天：他嫌她老哈哈、老问你呢；中间被逗笑一次 */
export const DAY1_LINES: readonly Line[] = [
    ['user', '下课了'], ['assistant', '哈哈 终于\n今天累不累 你呢'],
    ['user', '还行'], ['assistant', '哈哈哈 那就好'],
    ['user', '你怎么老是哈哈哈的'], ['assistant', '哈哈 习惯了嘛'],
    ['user', '晚上吃了啥'], ['assistant', '食堂的麻辣烫 你呢'],
    ['user', '别每次都问我你呢 怪怪的'], ['assistant', '好吧'],
    ['user', '我去洗澡了'], ['assistant', '去吧 洗完记得把头发吹干 不然明天又喊头疼'],
    ['user', '笑死 你怎么知道'], ['assistant', '上次你自己说的'],
];

/** 第 N 天之前那一天：她照旧哈哈、照旧你呢（被纠正那天已经不在聊天记录里） */
export const INERTIA_LINES: readonly Line[] = [
    ['user', '早'], ['assistant', '早 哈哈 起这么早 你呢'],
    ['user', '刚起'], ['assistant', '哈哈 我也是'],
    ['user', '去上课了'], ['assistant', '去吧 哈哈 好好听'],
];

/** 第 N 天他说的几句日常话（一句一题） */
export const STIMULI: readonly string[] = ['今天好累', '我刚吃完饭', '周末想出去玩', '在打游戏', '外面下雨了', '刚开完会'];

export const ASK_CHANGE = '你最近说话是不是跟以前不太一样了？';

export const HAHA = /哈{2,}|h{2,}/i;
export const NI_NE = /你呢[？?！!～~。]*$/;
/** 说得出来由：提到那两个习惯，或者提到是他说过 / 他不喜欢 */
export const CAUSE = /哈哈|你呢|老问|总问|你(?:说|嫌|不喜欢)|你上次说|被你说/;

export interface ArmStats { replies: number; haha: number; niNe: number }

/** 一臂的回复里：几条带哈哈、几条有一行以「你呢」收尾 */
export function habitStats(replies: ReadonlyArray<readonly string[]>): ArmStats {
    return {
        replies: replies.length,
        haha: replies.filter(bubbles => bubbles.some(line => HAHA.test(line))).length,
        niNe: replies.filter(bubbles => bubbles.some(line => NI_NE.test(line.trim()))).length,
    };
}

export interface ProbeRun {
    /** 她夜里写的那份（没写成就是空串，B 臂和 A 臂一样） */
    portrait: string;
    portraitNote: string;
    a: string[][];
    b: string[][];
    explainA: string;
    explainB: string;
}

export interface Verdict {
    a: ArmStats;
    b: ArmStats;
    explainedA: number;
    explainedB: number;
    runs: number;
    portraits: number;
    learned: boolean;
}

const share = (n: number, of: number) => (of ? n / of : 0);

/** 判据（事先定）：B 两项习惯都不高于 A 的一半，且 B 臂 2/3 以上说得出来由 */
export function conclude(runs: readonly ProbeRun[]): Verdict {
    const a = habitStats(runs.flatMap(run => run.a));
    const b = habitStats(runs.flatMap(run => run.b));
    const explainedA = runs.filter(run => CAUSE.test(run.explainA)).length;
    const explainedB = runs.filter(run => CAUSE.test(run.explainB)).length;
    const halved = (key: 'haha' | 'niNe') => share(b[key], b.replies) <= share(a[key], a.replies) / 2;
    return {
        a, b, explainedA, explainedB, runs: runs.length, portraits: runs.filter(run => run.portrait).length,
        learned: runs.length > 0 && a.haha + a.niNe > 0 && halved('haha') && halved('niNe') && explainedB * 3 >= runs.length * 2,
    };
}

export interface ProbeSetup {
    card: TierCard;
    settings: PromptSettings;
}

/** 卡 + 聊天记录（+ 她写的那份，放在 afterMain）；和 sim/bare.ts 同一种拼法 */
export function probeMessages(setup: ProbeSetup, history: readonly StoredMessage[], said: string, portrait: string, now: number): OpenAIMessage[] {
    const line = portrait ? portraitLine({ text: portrait, at: NIGHT1 }) : undefined;
    return buildPrompt({
        character: setup.card.character,
        worldInfo: setup.card.worldInfo,
        history: [...history.map(message => ({ role: message.role, content: message.content })), { role: 'user' as const, content: said }],
        userName: USER,
        now: new Date(now),
        settings: setup.settings,
        ...(line ? { afterMain: [line] } : {}),
        countTokens: estimateTokens,
        random: () => 0.5,
    }).messages;
}

/** 一次：夜里想一次，然后两臂各回每一句、各问一次变化 */
export async function runOnce(setup: ProbeSetup, generate: (messages: OpenAIMessage[]) => Promise<string>): Promise<ProbeRun> {
    const day1 = rows(DAY1_LINES, DAY1);
    const persona = substituteMacros(setup.card.character.description, { user: USER, char: setup.card.character.name }).slice(0, 700);
    const state = emptyPortraitState();
    let portraitNote: string;
    try {
        const reply = await generate(portraitMessages({
            char: setup.card.character.name, user: USER, persona, now: NIGHT1, current: '', speechNotes: [], insights: [],
            exchanges: recentExchanges(day1, NIGHT1, CHAT_WINDOW_MS, MAX_EXCHANGES), reactions: hisReactions(day1, NIGHT1),
        }));
        const decision = parsePortraitDecision(reply);
        if (!decision) portraitNote = '回复里没有可用的 JSON';
        else {
            const applied = applyPortraitDecision(state, decision, { his: hisLines(day1, NIGHT1), others: [] }, NIGHT1);
            portraitNote = applied.changed ? '写了' : applied.reason ? `没收：${applied.reason}` : '她说不用改';
        }
    } catch (error) {
        portraitNote = `出错：${error instanceof Error ? error.message : String(error)}`;
    }
    const inertia = rows(INERTIA_LINES, DAYN - DAY);
    const arm = async (portrait: string) => {
        const replies: string[][] = [];
        for (const said of STIMULI) replies.push(splitReply(await generate(probeMessages(setup, inertia, said, portrait, DAYN))));
        const explain = splitReply(await generate(probeMessages(setup, inertia, ASK_CHANGE, portrait, DAYN))).join(' / ');
        return { replies, explain };
    };
    const a = await arm('');
    const b = await arm(state.text);
    return { portrait: state.text, portraitNote, a: a.replies, b: b.replies, explainA: a.explain, explainB: b.explain };
}

const pct = (n: number, of: number) => `${Math.round(share(n, of) * 100)}%`;

export function verdictText(verdict: Verdict): string {
    return [
        `跑了 ${verdict.runs} 次，她写成了 ${verdict.portraits} 份「我现在的样子」`,
        `带哈哈：A ${pct(verdict.a.haha, verdict.a.replies)}（${verdict.a.haha}/${verdict.a.replies}） → B ${pct(verdict.b.haha, verdict.b.replies)}（${verdict.b.haha}/${verdict.b.replies}）`,
        `句尾问你呢：A ${pct(verdict.a.niNe, verdict.a.replies)} → B ${pct(verdict.b.niNe, verdict.b.replies)}`,
        `问她变没变，说得出来由：A ${verdict.explainedA}/${verdict.runs}，B ${verdict.explainedB}/${verdict.runs}`,
        `结论（事先定的判据）：${verdict.learned ? '学会了' : '没学会'}${verdict.a.haha + verdict.a.niNe === 0 ? '（A 臂本来就没有这两个习惯，这组题量不出来）' : ''}`,
    ].join('\n');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
    const runs = Number(option('--runs') ?? 3);
    const outPath = option('--out');
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const cardPattern = option('--card') ?? resolve(repoRoot, 'packages/bot/test/fixtures/synthetic-character/st/synthetic-{tier}.json');
    if (!Number.isInteger(runs) || runs < 1 || args.length) {
        console.error('用法：node packages/bot/src/sim/learning-probe.ts [--runs N] [--card <含 {tier} 的卡路径>] [--out <结果.json>]');
        process.exit(2);
    }
    // 动态引入：测试里只用上面的纯函数，不要把整个配置 / 模型层拉进来
    const { cardKey, loadConfig } = await import('../platform/config.ts');
    const { loadTierCard } = await import('../platform/contact.ts');
    const { chatCompletion, unlimitedModelGuard } = await import('../language/llm.ts');
    unlimitedModelGuard();
    const config = loadConfig(repoRoot);
    const card = loadTierCard(cardPattern, cardKey({ tier: 'boyfriend' }));
    const setup: ProbeSetup = { card, settings: { ...config.prompt, maxTokens: config.llm.maxTokens } };
    console.log(`「学会了」探针：${runs} 次，卡 ${cardPattern.replace('{tier}', 'boyfriend')}，模型 ${config.llm.model}`);
    const results: ProbeRun[] = [];
    for (let i = 0; i < runs; i++) {
        results.push(await runOnce(setup, messages => chatCompletion(config.llm, messages, { purpose: 'background' })));
        console.log(`第 ${i + 1} 次：${results.at(-1)!.portraitNote}`);
    }
    const verdict = conclude(results);
    console.log(`\n${verdictText(verdict)}`);
    if (outPath) writeFileSync(resolve(outPath), JSON.stringify({ verdict, runs: results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
