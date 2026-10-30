// 逐条事实检查（ADR 0137，配置 factCheck：off / log / fix，默认 off）。
// 她最容易露馅的地方不是语气，是编：事实里只有“土豆今天没下楼”，她写“土豆一见我撒腿就跑，跑两步又回头看我”；
// 状态是“在逛淘宝”，她写“刚放下手机”。出口检查（exit-check.ts）只拦得住几类固定的毛病，拦不住这种“看着很自然的新事实”。
// 做法照 ACL 2025 的“原子级人设一致性评估”（Shin 等，arXiv 2506.19352）：把回复拆成一条条关于她自己 / 她身边世界的具体说法，
// 逐条对照设定、这一轮的事实、聊天记录，找出“矛盾”和“事实里根本没有”的。拆和对照交给模型（一次额外的调用，温度 0，只输出一个小 JSON），
// 这里负责：拼审稿的提示词、解析输出（模型照抄不出来的片段当没说）、按档位处理：
//   log  只查、只记日志，回复照发（先看误报多不多）；
//   fix  有问题就带说明重写一次，重写后再查一次，还有就把那几行删掉（删完一行不剩就照发重写的）。
// 查不成（超时、模型不可用）一律照发，绝不因为审稿挡住回复。危机回合不查（contact.ts 里不调用）。

import { logBody } from '../platform/sensitive.ts';
import type { OpenAIMessage } from './prompt.ts';

export const FACT_CHECK_MODES = ['off', 'log', 'fix'] as const;
export type FactCheckMode = (typeof FACT_CHECK_MODES)[number];

export type FactKind = 'contradicts' | 'invented' | 'about-him';
export interface FactClaim {
    /** 回复里的原话片段 */
    quote: string;
    kind: FactKind;
    /** 审稿员给的一句理由 */
    why: string;
}

/** 回复里不到这么多个字（汉字 / 字母 / 数字）不查：「哈哈」「嗯嗯好的」里没有事实可对 */
export const FACT_MIN_CHARS = 6;
/** 一次最多采信几条 */
export const FACT_MAX_CLAIMS = 4;
/** 审稿最多等多久，超了就照发 */
export const FACT_TIMEOUT_MS = 25_000;

const AUDIT_RULES = `你是审稿员，只核对事实，不评价文风，也不评价她该不该这么说。
下面会给你：「林梦瑶」的设定和这一轮她能依据的事实、到现在为止的聊天、她准备发出去的回复。
找出回复里关于【她自己或她身边世界】的、具体可核对的事实说法：她此刻在做什么 / 刚做了什么 / 手上和身体的动作、吃了什么、去了哪、见了谁、谁说了什么、东西和动物的具体行为（猫怎么跑怎么看她）、发生了什么事、具体的数字和时间。
对每一条，到设定、事实、聊天里找依据：
- contradicts：和设定、事实或聊天里写的相矛盾（例：事实写她在逛淘宝，她说刚放下手机；事实写猫今天没下楼，她说猫跑过来了）
- invented：设定、事实、聊天里都没提过的具体新事实（例：编出一个室友的举动、一次出门、一件没提过的东西）
不要列：感受、想法、看法、玩笑和夸张的说法、对他的提问、对他说的话的回应或复述、她在聊天里已经说过的事、泛泛的常识、含糊的口头话（「忙死了」「困」这类和事实不冲突的）。拿不准就不列。
只输出一个 JSON 数组，没有问题就输出 []。每一项：{"quote":"回复里的原话片段（照抄，尽量短）","kind":"contradicts" 或 "invented","why":"一句话：矛盾在哪 / 事实里没有什么"}`;

/**
 * 第三类（配置 factHim，ADR 0203）：她替【他】说的事。前两类只管她自己和她身边的世界；深度的探针里（没有记忆撑着时）她会补「你数学不差」
 * 「你高中刷那么多题」「你又不是坐不住的人」——听着像懂他，其实是编的。有记忆时这些可能有依据（记忆块在设定和事实里），所以审稿员对照的是设定、事实、
 * 聊天——包括他自己这一次说过的话。
 */
const HIM_RULES = `另外还有第三类，关于【他本人】的具体说法：他的本事 / 能力、过去的经历、性格、家里人、喜好、计划、他说过什么——回复把它当成已知的事来说，而设定、事实、聊天（包括他自己这次说过的话）里找不到依据。
- about-him：没有依据的、关于他的断言（例：他没说过数学，她说「你数学不差」；他没提过高中，她说「你高中刷那么多题」；聊天里没有，她说「你上次说想去北京」；他没说过自己是什么样的人，她说「你本来就不是会放弃的人」「你从小就这样」）
对 about-him 不要列：从这次聊天里直接看得出来的观察（「你今天老问这些将来的事」「你刚说怕找不到工作」）、问句、带猜测口气的话（「是不是」「可能」「感觉」「该不会」「我猜」）、她自己的感受、常识、没有具体内容的夸或安慰（「你没问题的」）。只列断言式的、具体的。拿不准就不列。`;

const OUTPUT_HIM = '只输出一个 JSON 数组，没有问题就输出 []。每一项：{"quote":"回复里的原话片段（照抄，尽量短）","kind":"contradicts" 或 "invented" 或 "about-him","why":"一句话：矛盾在哪 / 事实里没有什么 / 他哪里没说过"}';
const OUTPUT_LINE = AUDIT_RULES.slice(AUDIT_RULES.lastIndexOf('只输出一个 JSON 数组'));
/** 审稿的系统提示：aboutHim 开着时加第三类，输出说明也跟着换 */
export const auditRules = (aboutHim: boolean): string => (aboutHim ? `${AUDIT_RULES.slice(0, AUDIT_RULES.length - OUTPUT_LINE.length)}${HIM_RULES}
${OUTPUT_HIM}` : AUDIT_RULES);

/** 回复里值得核对的文字：去掉表情包 / 照片指令行；太短的什么都不返回（不查） */
export function auditableText(reply: string): string {
    const lines = reply.split('\n').map(line => line.trim()).filter(line => line && !/^<(?:sticker|photo):[a-f0-9]{12}>$/i.test(line));
    const text = lines.join('\n');
    return [...text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')].length >= FACT_MIN_CHARS ? text : '';
}

/**
 * 审稿用的提示词：设定和事实（拼提示词时的 system 部分，ST 后处理之前的原样——后处理会把后面的 system 改成 user，分不出哪些是事实）、
 * 聊天记录、她准备发的回复。太短的 system 片段（对话分隔、例句）不放
 */
export function auditMessages(source: readonly OpenAIMessage[], reply: string, names: { user: string; char: string }, options: { aboutHim?: boolean } = {}): OpenAIMessage[] {
    const facts: string[] = [];
    const chat: string[] = [];
    for (const message of source) {
        const content = (message.content ?? '').trim();
        if (!content) continue;
        if (message.role === 'system') {
            if (content.length >= 20 && !content.includes('[Start a new Chat]')) facts.push(content);
        } else {
            chat.push(`${message.role === 'user' ? names.user : names.char}：${content}`);
        }
    }
    return [
        { role: 'system', content: auditRules(Boolean(options.aboutHim)) },
        { role: 'user', content: `## 设定和这一轮的事实\n${facts.join('\n')}\n\n## 到现在为止的聊天\n${chat.join('\n') || '（还没聊）'}\n\n## 她准备发出去的回复\n${reply}` },
    ];
}

/** 解析审稿员的输出：容忍代码块、前后多余的字；类型不对的、照抄不出来的片段（不在回复里）丢掉 */
export function parseClaims(raw: string, reply: string, options: { aboutHim?: boolean } = {}): FactClaim[] {
    const body = raw.replace(/```(?:json)?/gi, '');
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end < start) return [];
    let data: unknown;
    try {
        data = JSON.parse(body.slice(start, end + 1));
    } catch {
        return [];
    }
    if (!Array.isArray(data)) return [];
    const claims: FactClaim[] = [];
    for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        const { quote, kind, why } = item as Record<string, unknown>;
        if (typeof quote !== 'string' || (kind !== 'contradicts' && kind !== 'invented' && !(kind === 'about-him' && options.aboutHim))) continue;
        const text = quote.trim();
        if ([...text].length < 2 || !reply.includes(text)) continue;
        claims.push({ quote: text, kind, why: typeof why === 'string' ? why.trim().slice(0, 80) : '' });
        if (claims.length >= FACT_MAX_CLAIMS) break;
    }
    return claims;
}

/** 重写时加在提示词末尾的说明（和 exit-check.ts 的 rewriteNote 同一个口气） */
export function factRewriteNote(claims: readonly FactClaim[]): string {
    const why = claims.map(claim => `「${claim.quote}」${claim.kind === 'contradicts' ? '和上面写的事实对不上' : claim.kind === 'about-him' ? '说的是他的事，上面没有写过' : '是上面事实里没有的'}${claim.why ? `（${claim.why}）` : ''}`);
    const him = claims.some(claim => claim.kind === 'about-him') ? '别替他说他没说过的事（他的本事、过去、性格）——想说你的感觉就说感觉，想知道就问他。' : '';
    return `[上一版回复没有发出去：${why.join('；')}。你只能说上面写了的事实，或者说你自己的感觉和想法；别添上面没写的小动作、小场景、别人的举动。${him}意思不变，重写这次的回复，只输出要发的消息。]`;
}

/** 把含有这几条说法的行删掉；删完一行不剩就原样返回 */
export function dropClaimLines(reply: string, claims: readonly FactClaim[]): string {
    const kept = reply.split('\n').filter(line => !claims.some(claim => line.includes(claim.quote)));
    return kept.some(line => line.trim()) ? kept.join('\n') : reply;
}

/**
 * 删掉的行太多、剩下的撑不住这一轮：这一轮想说的那部分被当成“没依据”删了，只剩个尾巴（10-29 22:14：
 * 要说的「作业写完了」被删掉，发出去的是两小时前的卤蛋梗）。剩下不到一半才算。主动找他时可以整条不发（宁可少发）。
 */
export function dropTooMuch(reply: string, claims: readonly FactClaim[]): boolean {
    const lines = reply.split('\n').filter(line => line.trim());
    if (lines.length < 2) return false;
    const kept = lines.filter(line => !claims.some(claim => line.includes(claim.quote)));
    return kept.length * 2 < lines.length;
}

/** 一次检查的记录（模拟器的报告用） */
export interface FactRecord {
    /** 审稿看的那一版 */
    reply: string;
    claims: FactClaim[];
    /** pass 没问题；logged 只记录（log 档）；rewritten 重写后过了；dropped 重写后还有、删了那几行；kept 重写后还有但删不了；skipped 没查成 */
    action: 'pass' | 'logged' | 'rewritten' | 'dropped' | 'kept' | 'skipped';
    /** 重写之后的回复 */
    rewritten?: string;
    /** 重写之后又查出来的 */
    again?: FactClaim[];
    /** 审稿调用的输入约多少字符（估用量） */
    chars: number;
}

export interface FactCheckOptions {
    mode: Exclude<FactCheckMode, 'off'>;
    /** 这一轮拼出来的提示词（ST 后处理之前） */
    source: readonly OpenAIMessage[];
    names: { user: string; char: string };
    /** 把审稿的提示词交给模型，返回它的原文 */
    audit: (messages: OpenAIMessage[]) => Promise<string>;
    regenerate: (note: string) => Promise<string>;
    log: (message: string) => void;
    onRecord?: (record: FactRecord) => void;
    /** 删完剩下的撑不住这一轮时返回空串（上层这轮不发）：只在主动找他时开，回复里必须发出去 */
    mayDropAll?: boolean;
    /** 审稿最多等多久（默认 FACT_TIMEOUT_MS；测试用短的） */
    timeoutMs?: number;
    /** 多查一类：她替他说的、没有依据的事（配置 factHim，ADR 0203） */
    aboutHim?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('审稿超时')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const describe = (claims: readonly FactClaim[]) => claims.map(claim => `${claim.kind === 'contradicts' ? '矛盾' : claim.kind === 'about-him' ? '替他说的' : '没依据'}「${logBody(claim.quote)}」`).join('、');

export async function checkFacts(reply: string, options: FactCheckOptions): Promise<string> {
    const text = auditableText(reply);
    if (!text) return reply;
    const record: FactRecord = { reply: text, claims: [], action: 'pass', chars: 0 };
    const finish = (result: string, patch: Partial<FactRecord> = {}): string => {
        options.onRecord?.({ ...record, ...patch });
        return result;
    };
    const run = async (body: string): Promise<FactClaim[]> => {
        const messages = auditMessages(options.source, body, options.names, { aboutHim: Boolean(options.aboutHim) });
        record.chars += messages.reduce((total, message) => total + message.content.length, 0);
        return parseClaims(await withTimeout(options.audit(messages), options.timeoutMs ?? FACT_TIMEOUT_MS), body, { aboutHim: Boolean(options.aboutHim) });
    };
    let claims: FactClaim[];
    try {
        claims = await run(text);
    } catch (error) {
        options.log(`事实检查：没查成（${error instanceof Error ? error.message : String(error)}），照发`);
        return finish(reply, { action: 'skipped' });
    }
    record.claims = claims;
    if (claims.length === 0) return finish(reply);
    options.log(`事实检查：${claims.length} 条说法对不上事实——${describe(claims)}${options.mode === 'log' ? '（只记录，照发）' : '，带说明重写一次'}`);
    if (options.mode === 'log') return finish(reply, { action: 'logged' });

    let rewritten: string;
    try {
        rewritten = await options.regenerate(factRewriteNote(claims));
    } catch (error) {
        if (options.mayDropAll && dropTooMuch(reply, claims)) {
            options.log(`事实检查：重写失败（${error instanceof Error ? error.message : String(error)}），删完剩下的撑不住这一轮，这轮不发`);
            return finish('', { action: 'dropped' });
        }
        const dropped = dropClaimLines(reply, claims);
        options.log(`事实检查：重写失败（${error instanceof Error ? error.message : String(error)}），${dropped === reply ? '照发' : '删掉这几行'}`);
        return finish(dropped, { action: dropped === reply ? 'kept' : 'dropped' });
    }
    const again = auditableText(rewritten);
    let remaining: FactClaim[] = [];
    if (again) {
        try {
            remaining = await run(again);
        } catch (error) {
            options.log(`事实检查：重写后没查成（${error instanceof Error ? error.message : String(error)}），用重写的`);
            return finish(rewritten, { action: 'rewritten', rewritten });
        }
    }
    if (remaining.length === 0) {
        options.log('事实检查：重写后通过');
        return finish(rewritten, { action: 'rewritten', rewritten });
    }
    if (options.mayDropAll && dropTooMuch(rewritten, remaining)) {
        options.log(`事实检查：重写后仍有 ${describe(remaining)}，删完剩下的撑不住这一轮（想说的被删了），这轮不发`);
        return finish('', { action: 'dropped', rewritten, again: remaining });
    }
    const dropped = dropClaimLines(rewritten, remaining);
    options.log(`事实检查：重写后仍有 ${describe(remaining)}，${dropped === rewritten ? '删不了，照发' : '删掉这几行'}`);
    return finish(dropped, { action: dropped === rewritten ? 'kept' : 'dropped', rewritten, again: remaining });
}
