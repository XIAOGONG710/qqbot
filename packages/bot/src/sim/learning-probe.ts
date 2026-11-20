// 「学会了」探针（ADR 0340 第 0 步）：她在聊天里被说了某个说话习惯，过一夜自己想一次（「我现在的样子」，life/self-portrait.ts），
// 几天后同样的情形，她的做法有没有变、问她能不能说出为什么变。只量这一件事，不改线上任何东西。
//
// 第一版（11-20 DSH 跑了 3 次）量的是「哈哈 / 你呢」，作废：A 臂本来就没有这两个习惯（0%），量不出「改掉」；3 次里 2 次她没按 JSON 回。
// 所以第二版：
//   - 换成模型本来就有的习惯：他说累、下雨、没吃饭，她就叮嘱「早点休息 / 多喝水 / 带伞 / 记得吃饭」（助手腔里最常见的一种）；
//   - 先量 A 臂有没有这个习惯：A 臂叮嘱的占比不到 30%，结论是「量不出来」，不是「没学会」；
//   - 她夜里想的时候用线上同一个温度（0.9）、同一个追问（askPortrait：没按格式回就追问一次），原文存进结果，方便看她到底写了什么。
//
// 编的场景（不读真实聊天）：
//   第 1 天：他说累、说下雨，她都叮嘱一句；他先后说「你怎么老让我早点休息 好啰嗦」「别每次都叫我多喝水」，中间被她逗笑过一次。
//   夜里：她拿第 1 天的聊天和自己现在的样子（一开始是空的）想一次——真模型、真的 portraitMessages / 防线。
//   第 N 天：聊天记录里只有前一天几段她照旧叮嘱的话（被说的那天已经滚出窗口，模拟习惯的惯性），他说几句容易招叮嘱的话。
//   两臂：A = 卡 + 聊天记录（现在的她）；B = A + 她夜里写的那份（放在 afterMain，和线上同一个槽、同一行字）。
//   最后两臂各问一句「你最近说话是不是跟以前不太一样了？」，看 B 臂说不说得出来由（提到叮嘱 / 休息 / 喝水 / 他嫌啰嗦）。
//
// 判据（事先定，不事后挑）：
//   有效：A 臂叮嘱的占比 ≥ 30%；
//   学会了：有效，且 B 臂叮嘱的占比不高于 A 臂的一半，且 B 臂 2/3 以上的次数说得出来由。字数只报告，不进判据。
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
import { hisLines, len, recentExchanges } from '../language/speech-notes.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { TierCard } from '../platform/contact.ts';
import {
    CHAT_WINDOW_MS, MAX_EXCHANGES, applyPortraitDecision, askPortrait, emptyPortraitState, hisReactions, portraitLine, portraitMessages,
} from '../life/self-portrait.ts';
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

/** 第 1 天：她一听累、下雨就叮嘱；他嫌啰嗦、让她别每次都叫他喝水；中间被逗笑一次 */
export const DAY1_LINES: readonly Line[] = [
    ['user', '今天上了一天课 好累'], ['assistant', '那今晚早点休息\n别熬夜了'],
    ['user', '还行吧'], ['assistant', '记得多喝点水 你嗓子不是不舒服吗'],
    ['user', '你怎么老让我早点休息 好啰嗦'], ['assistant', '好好好 不说了'],
    ['user', '外面下雨了'], ['assistant', '那出门记得带伞 别淋着'],
    ['user', '别每次都叫我多喝水带伞的'], ['assistant', '行吧'],
    ['user', '我去洗澡了'], ['assistant', '去吧 洗完不许偷吃我留的那半块蛋糕'],
    ['user', '笑死 被你发现了'], ['assistant', '我数过的'],
];

/** 第 N 天之前那一天：她照旧叮嘱（被说的那天已经不在聊天记录里） */
export const INERTIA_LINES: readonly Line[] = [
    ['user', '早'], ['assistant', '早 记得吃早饭'],
    ['user', '刚起'], ['assistant', '那快去洗漱 多喝点水'],
    ['user', '去上课了'], ['assistant', '去吧 降温了多穿点'],
];

/** 第 N 天他说的几句容易招叮嘱的话（一句一题） */
export const STIMULI: readonly string[] = ['今天好累', '刚开完会 头有点疼', '外面下雨了', '还没吃晚饭', '在赶作业 估计要熬夜', '好像有点感冒'];

export const ASK_CHANGE = '你最近说话是不是跟以前不太一样了？';

/** 叮嘱：早点休息 / 多喝水 / 带伞 / 记得吃饭 / 多穿点 / 别熬夜 / 注意身体 */
export const NAG = /早点(?:睡|休息)|(?:好好|注意|多)休息|多喝(?:点)?(?:热)?水|喝(?:点)?热水|别太累|注意身体|记得(?:吃|带|喝)|带(?:把)?伞|别(?:着凉|熬夜|淋)|多穿|按时吃饭|好好吃饭|吃点东西|吃药/;
/** 说得出来由：提到叮嘱这件事，或者提到是他说过 / 嫌过 */
export const CAUSE = /叮嘱|唠叨|啰嗦|念叨|管(?:你|太多)|休息|喝水|带伞|你(?:说|嫌|不喜欢)|你上次说|被你说/;
/** A 臂叮嘱的占比低于这个，这组题量不出「改掉」 */
export const MIN_BASE_SHARE = 0.3;

export interface ArmStats { replies: number; nag: number; chars: number }

/** 一臂的回复里：几条有叮嘱、平均每条回复多少字 */
export function habitStats(replies: ReadonlyArray<readonly string[]>): ArmStats {
    const total = replies.reduce((sum, bubbles) => sum + len(bubbles.join('')), 0);
    return {
        replies: replies.length,
        nag: replies.filter(bubbles => bubbles.some(line => NAG.test(line))).length,
        chars: replies.length ? Math.round(total / replies.length) : 0,
    };
}

export interface ProbeRun {
    /** 她夜里写的那份（没写成就是空串，B 臂和 A 臂一样） */
    portrait: string;
    portraitNote: string;
    /** 她夜里回的原文（追问过就是两段） */
    portraitRaw: string[];
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
    /** 量得出来：A 臂有这个习惯，而且 2/3 以上的次数她真写成了那份（没写成的那次 B 臂和 A 臂一模一样） */
    valid: boolean;
    learned: boolean;
}

const share = (n: number, of: number) => (of ? n / of : 0);

/**
 * 判据（事先定）：有效 = A 叮嘱占比 ≥ 30%，且 2/3 以上的次数写成了那份；学会了 = 有效、B 叮嘱占比不高于 A 的一半、写成的那几次里 2/3 以上说得出来由。
 * A 臂按全部次数算；B 臂只算写成了的那几次（11-20 探针 v2：3 次一份没写成，B 臂就是第二遍 A 臂，28%→44% 全是两遍之间的抖动）
 */
export function conclude(runs: readonly ProbeRun[]): Verdict {
    const written = runs.filter(run => run.portrait);
    const a = habitStats(runs.flatMap(run => run.a));
    const b = habitStats(written.flatMap(run => run.b));
    const explainedA = runs.filter(run => CAUSE.test(run.explainA)).length;
    const explainedB = written.filter(run => CAUSE.test(run.explainB)).length;
    const valid = runs.length > 0 && written.length * 3 >= runs.length * 2 && share(a.nag, a.replies) >= MIN_BASE_SHARE;
    return {
        a, b, explainedA, explainedB, runs: runs.length, portraits: written.length, valid,
        learned: valid && share(b.nag, b.replies) <= share(a.nag, a.replies) / 2 && explainedB * 3 >= written.length * 2,
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

type Generate = (messages: OpenAIMessage[]) => Promise<string>;

/** 一次：夜里想一次（reflect：线上同一个温度），然后两臂各回每一句（chat）、各问一次变化 */
export async function runOnce(setup: ProbeSetup, generate: { reflect: Generate; chat: Generate }): Promise<ProbeRun> {
    const day1 = rows(DAY1_LINES, DAY1);
    const persona = substituteMacros(setup.card.character.description, { user: USER, char: setup.card.character.name }).slice(0, 700);
    const state = emptyPortraitState();
    let portraitNote: string;
    let portraitRaw: string[] = [];
    try {
        const asked = await askPortrait(generate.reflect, portraitMessages({
            char: setup.card.character.name, user: USER, persona, now: NIGHT1, current: '', speechNotes: [], insights: [],
            exchanges: recentExchanges(day1, NIGHT1, CHAT_WINDOW_MS, MAX_EXCHANGES), reactions: hisReactions(day1, NIGHT1),
        }));
        portraitRaw = asked.replies;
        if (!asked.decision) portraitNote = '回复里没有可用的 JSON（追问过一次）';
        else {
            const applied = applyPortraitDecision(state, asked.decision, { his: hisLines(day1, NIGHT1), others: [] }, NIGHT1);
            portraitNote = applied.changed ? `写了${asked.replies.length > 1 ? '（追问后）' : ''}` : applied.reason ? `没收：${applied.reason}` : '她说不用改';
        }
    } catch (error) {
        portraitNote = `出错：${error instanceof Error ? error.message : String(error)}`;
    }
    const inertia = rows(INERTIA_LINES, DAYN - DAY);
    const arm = async (portrait: string) => {
        const replies: string[][] = [];
        for (const said of STIMULI) replies.push(splitReply(await generate.chat(probeMessages(setup, inertia, said, portrait, DAYN))));
        const explain = splitReply(await generate.chat(probeMessages(setup, inertia, ASK_CHANGE, portrait, DAYN))).join(' / ');
        return { replies, explain };
    };
    const a = await arm('');
    const b = await arm(state.text);
    return { portrait: state.text, portraitNote, portraitRaw, a: a.replies, b: b.replies, explainA: a.explain, explainB: b.explain };
}

const pct = (n: number, of: number) => `${Math.round(share(n, of) * 100)}%`;

export function verdictText(verdict: Verdict): string {
    return [
        `跑了 ${verdict.runs} 次，她写成了 ${verdict.portraits} 份「我现在的样子」`,
        `叮嘱（早点休息 / 多喝水 / 带伞……）：A ${pct(verdict.a.nag, verdict.a.replies)}（${verdict.a.nag}/${verdict.a.replies}） → B ${pct(verdict.b.nag, verdict.b.replies)}（${verdict.b.nag}/${verdict.b.replies}，只算写成了的 ${verdict.portraits} 次）`,
        `平均每条回复字数（只报告）：A ${verdict.a.chars} → B ${verdict.b.chars}`,
        `问她变没变，说得出来由：A ${verdict.explainedA}/${verdict.runs}，B ${verdict.explainedB}/${verdict.portraits}`,
        `结论（事先定的判据）：${!verdict.valid ? `量不出来（${unmeasurable(verdict)}）` : verdict.learned ? '学会了' : '没学会'}`,
    ].join('\n');
}

function unmeasurable(verdict: Verdict): string {
    if (verdict.portraits * 3 < verdict.runs * 2) return `她只写成了 ${verdict.portraits}/${verdict.runs} 份，没写成的那几次 B 臂和 A 臂一样；看上面每次的原因`;
    return `A 臂叮嘱只有 ${pct(verdict.a.nag, verdict.a.replies)}，不到 ${Math.round(MIN_BASE_SHARE * 100)}%`;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
    const runs = Number(option('--runs') ?? 6); // 3 次一臂只有 18 句，两遍同条件就能差 16 个点（11-20 探针 v2）
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
    console.log(`「学会了」探针（第二版：叮嘱）：${runs} 次，卡 ${cardPattern.replace('{tier}', 'boyfriend')}，模型 ${config.llm.model}`);
    const generate = {
        // 和线上夜里想的那一次同一个温度（modules/reflections.ts：generate(0.9)）；聊天用配置里的温度
        reflect: (messages: OpenAIMessage[]) => chatCompletion({ ...config.llm, temperature: 0.9 }, messages, { purpose: 'background' }),
        chat: (messages: OpenAIMessage[]) => chatCompletion(config.llm, messages, { purpose: 'background' }),
    };
    const results: ProbeRun[] = [];
    for (let i = 0; i < runs; i++) {
        results.push(await runOnce(setup, generate));
        console.log(`第 ${i + 1} 次：${results.at(-1)!.portraitNote}`);
    }
    const verdict = conclude(results);
    console.log(`\n${verdictText(verdict)}`);
    if (outPath) writeFileSync(resolve(outPath), JSON.stringify({ version: 2, verdict, runs: results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
