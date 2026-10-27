// 模拟器批次的统计（ADR 0019 步骤 2）：node src/sim/stats.ts <批次目录或场景目录>... [--card <卡>]
// 按场景汇总各次运行（r1、r2……），数模型第一版（出口检查之前）里的：
// - 算账、怪他没说、对照的酸话（speech-check.ts 的规则，不算重复）
// - 照抄状态行：第一版里出现「[你现在：…]」里 6 个字以上的连续片段
// - 复述示例：第一版的某一行和卡上示例里她的某句有 8 个字以上的相同片段（给了 --card 才数）
// - 真问句：问号或「吗」「呢」结尾的行，去掉反问（是吧、对吧、难道、不是吗……）
// - 短气泡：发出去的气泡里 6 个字以内的
// - 真人基线同口径的对话形状：每轮 1/2/3/4+ 条、每气泡字数分位、问句率
// 不调模型，只读 result.json。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { inspectSpeech } from '../language/speech-check.ts';
import type { RunResult } from './runner.ts';

export interface SceneStats {
    runs: number;
    replies: number;
    bubbles: number;
    ledger: number;
    blame: number;
    contrast: number;
    stateCopy: number;
    exampleEcho: number;
    questions: number;
    realQuestions: number;
    shortBubbles: number;
    shape: DialogueShapeStats;
    /** 命中的原句（第一版的那一行），人工读用 */
    samples: string[];
}

export interface DialogueShapeStats {
    /** 真正发出了至少一个气泡的轮数（一次 simulator step 算一轮） */
    replyTurns: number;
    /** 各轮发出的气泡数；4 条及以上合并，和真人基线口径一致 */
    bubblesPerReply: { one: number; two: number; three: number; fourPlus: number };
    /** Unicode 码点数；不去空格，不按 UTF-16 code unit 数 */
    bubbleChars: { median: number; p75: number; p90: number };
    /** 末尾是 ？/?/吗/呢/吧 的气泡数和占全部气泡的比例 */
    questionBubbles: number;
    questionRate: number;
}

const STATE = /\[你现在：([^\]]*)\]/;
const HAN = /[一-鿿]/;
const RHETORICAL = /(?:是吧|对吧|好吧|行吧|不是吗|难道|还不|又怎么|怎么了吗|谁让|凭什么|有意见吗|不行吗|可以吗你|是不是傻)[吗呢吧啊？?]*$/;
const QUESTION = /(?:[?？]|[吗呢么])[~～!！。.]*$/;
const BASELINE_QUESTION = /(?:[?？]|[吗呢吧])$/;

/** nearest-rank 分位数；小样本也总返回实际观测值。 */
function percentile(values: readonly number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * 按真人语料的定义统计已经发出去的回复。一个元素是一轮，里面每个字符串是一条气泡。
 * 空轮（模型最终没有发出内容）不进入分母。
 */
export function dialogueShape(replies: readonly (readonly string[])[]): DialogueShapeStats {
    const emitted = replies.filter(reply => reply.length > 0);
    const counts = { one: 0, two: 0, three: 0, fourPlus: 0 };
    const bubbles = emitted.flat();
    for (const reply of emitted) {
        if (reply.length === 1) counts.one++;
        else if (reply.length === 2) counts.two++;
        else if (reply.length === 3) counts.three++;
        else counts.fourPlus++;
    }
    const lengths = bubbles.map(text => [...text].length);
    const questionBubbles = bubbles.filter(text => BASELINE_QUESTION.test(text.trim())).length;
    return {
        replyTurns: emitted.length,
        bubblesPerReply: counts,
        bubbleChars: {
            median: percentile(lengths, 0.5),
            p75: percentile(lengths, 0.75),
            p90: percentile(lengths, 0.9),
        },
        questionBubbles,
        questionRate: bubbles.length ? questionBubbles / bubbles.length : 0,
    };
}

/** 状态行里 6 个字以上的连续汉字片段（每个长度 6 的窗口） */
function stateGrams(timeBlock: string | undefined): string[] {
    const state = timeBlock ? STATE.exec(timeBlock)?.[1] : undefined;
    if (!state) return [];
    const grams = new Set<string>();
    for (const part of state.split(/[；，、（）()。\s]/)) {
        const chars = [...part];
        for (let i = 0; i + 6 <= chars.length; i++) {
            const gram = chars.slice(i, i + 6).join('');
            if ([...gram].every(c => HAN.test(c))) grams.add(gram);
        }
    }
    return [...grams];
}

/** 卡上示例里她说的句子 */
export function exampleReplies(mesExample: string): string[] {
    const replies: string[] = [];
    let mine = false;
    for (const line of mesExample.split('\n')) {
        if (line.startsWith('<START>')) { mine = false; continue; }
        if (line.startsWith('{{user}}:')) { mine = false; continue; }
        if (line.startsWith('{{char}}:')) { mine = true; replies.push(line.slice('{{char}}:'.length).trim()); continue; }
        if (mine && line.trim()) replies.push(line.trim());
    }
    return replies.filter(Boolean);
}

/** a、b 有没有 n 个字以上的相同片段 */
function shares(a: string, b: string, n: number): boolean {
    const chars = [...a];
    for (let i = 0; i + n <= chars.length; i++) if (b.includes(chars.slice(i, i + n).join(''))) return true;
    return false;
}

export function sceneStats(results: readonly RunResult[], examples: readonly string[] = []): SceneStats {
    const shape = dialogueShape(results.flatMap(result => result.steps.map(step => step.bubbles.map(bubble => bubble.text))));
    const stats: SceneStats = {
        runs: results.length, replies: 0, bubbles: 0, ledger: 0, blame: 0, contrast: 0, stateCopy: 0, exampleEcho: 0,
        questions: 0, realQuestions: 0, shortBubbles: 0, shape, samples: [],
    };
    for (const result of results) {
        for (const step of result.steps) {
            for (const bubble of step.bubbles) {
                stats.bubbles++;
                if ([...bubble.text.replace(/\s/g, '')].length <= 6) stats.shortBubbles++;
            }
            for (const generation of step.generations) {
                const raw = generation.raw;
                if (raw === undefined) continue;
                stats.replies++;
                const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
                for (const issue of inspectSpeech(raw, { recent: [], his: [] })) {
                    if (issue.kind === 'ledger' || issue.kind === 'blame' || issue.kind === 'contrast') {
                        stats[issue.kind]++;
                        // issue.line 是 inspectSpeech 按原文（不去空行）数的行号
                        stats.samples.push(`${issue.kind}｜${raw.split('\n')[issue.line]?.trim() ?? raw}`);
                    }
                }
                const grams = stateGrams(generation.timeBlock);
                const copied = grams.find(g => raw.includes(g));
                if (copied) { stats.stateCopy++; stats.samples.push(`stateCopy「${copied}」｜${raw.replace(/\n/g, ' / ')}`); }
                if (examples.length && lines.some(line => examples.some(e => shares(line, e, 8)))) {
                    stats.exampleEcho++;
                    stats.samples.push(`exampleEcho｜${raw.replace(/\n/g, ' / ')}`);
                }
                for (const line of lines) {
                    if (!QUESTION.test(line)) continue;
                    stats.questions++;
                    if (!RHETORICAL.test(line)) stats.realQuestions++;
                }
            }
        }
    }
    return stats;
}

/** 目录下的场景：<批次>/<场景>/r<n>/result.json，或者直接给 <场景> 目录 */
function scenes(dir: string): Map<string, RunResult[]> {
    const found = new Map<string, RunResult[]>();
    const runsIn = (sceneDir: string) => readdirSync(sceneDir).filter(r => /^r\d+$/.test(r) && existsSync(join(sceneDir, r, 'result.json')))
        .map(r => JSON.parse(readFileSync(join(sceneDir, r, 'result.json'), 'utf8')) as RunResult);
    const direct = runsIn(dir);
    if (direct.length) found.set(basename(dir), direct);
    else for (const name of readdirSync(dir)) {
        const sub = join(dir, name);
        if (statSync(sub).isDirectory()) { const runs = runsIn(sub); if (runs.length) found.set(name, runs); }
    }
    return found;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const cardIndex = args.indexOf('--card');
    const card = cardIndex >= 0 ? args.splice(cardIndex, 2)[1] : undefined;
    const examples = card ? exampleReplies(JSON.parse(readFileSync(resolve(card), 'utf8')).data.mes_example ?? '') : [];
    const verbose = args.includes('--samples');
    for (const dir of args.filter(a => a !== '--samples')) {
        for (const [name, results] of scenes(resolve(process.env.INIT_CWD ?? process.cwd(), dir))) {
            const s = sceneStats(results, examples);
            const rate = (n: number, total: number) => `${(total ? n / total * 100 : 0).toFixed(1)}%`;
            const counts = s.shape.bubblesPerReply;
            console.log(`${basename(dir)}/${name}：${s.runs} 次、回复 ${s.replies}、气泡 ${s.bubbles}；算账 ${s.ledger}、怪他没说 ${s.blame}、对照 ${s.contrast}、照抄状态行 ${s.stateCopy}`
                + `${examples.length ? `、复述示例 ${s.exampleEcho}` : ''}；问句 ${s.questions}（真问 ${s.realQuestions}）；短气泡 ${s.shortBubbles}`);
            console.log(`    对话形状（已发送 ${s.shape.replyTurns} 轮）：1/2/3/4+ 条 ${rate(counts.one, s.shape.replyTurns)} / ${rate(counts.two, s.shape.replyTurns)} / ${rate(counts.three, s.shape.replyTurns)} / ${rate(counts.fourPlus, s.shape.replyTurns)}`
                + `；气泡字数 中位/p75/p90 ${s.shape.bubbleChars.median}/${s.shape.bubbleChars.p75}/${s.shape.bubbleChars.p90}；问句率 ${rate(s.shape.questionBubbles, s.bubbles)}`);
            if (verbose) for (const sample of s.samples) console.log(`    ${sample}`);
        }
    }
}
