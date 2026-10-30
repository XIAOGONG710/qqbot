// 语义路由（ADR 0202，配置 depthRouting）：这一轮他说的话是轻还是重。
// 起因：10-30 用户问「怎么让她有深度」。12 个需要深度的时刻里，只有 2 个走了深思（认真问她的轮次，ADR 0151）——是否深思靠关键词
// （你觉得 / 怎么看 / 为什么……），「我爷爷认不得我了」「你会不会怕被关掉」「你说的是不是套路」「你觉得我变了吗」都没有这些词，
// 不但没走深思，还有 5 个被抽到「只回一两个字」。强制走深思之后质量明显上来，所以瓶颈首先是路由。
// 做法：关键词没认出来的轮次，问一次小模型（不开思考，温度 0，几十个 token，超时就当没问），它只做分类：
//   light 日常闲聊 / 流水账 / 玩笑 / 撒娇；opinion 他在认真问她的看法、建议，或讲自己的纠结等她接话；heavy 他在说沉重的事（亲人、病痛、失败、压力），要陪着；
//   about-her 他在问她自己（感受、怕什么、是不是真的、她是什么）；challenge 他在质疑 / 试探她（套路？敷衍？）；us 他在问他自己或他们俩（我变了吗、我们合适吗）。
// 只加不减：关键词认出来的照旧；这里只在「关键词没认出、分类说值得认真」时多放行一些轮次进深思。拿不准归 light；出错 / 超时 / 解析不了都当没问。
// 这个模块只放纯函数和一个小的带超时的调用封装；怎么接进一轮回复在 platform/contact.ts。

import type { ChatMessage, OpenAIMessage } from './prompt.ts';

export const TURN_KINDS = ['light', 'opinion', 'heavy', 'about-her', 'challenge', 'us'] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export interface TurnWeight {
    kind: TurnKind;
    /** 十个字以内的理由（只进日志，不进提示词） */
    why?: string;
}

/** 值得认真接的几类（light 以外都是） */
export const DEEP_KINDS: ReadonlySet<TurnKind> = new Set<TurnKind>(['opinion', 'heavy', 'about-her', 'challenge', 'us']);

export const wantsDepth = (weight: TurnWeight | undefined): boolean => Boolean(weight && DEEP_KINDS.has(weight.kind));

export const KIND_LABEL: Record<TurnKind, string> = {
    light: '闲聊', opinion: '要她的看法', heavy: '在说沉重的事', 'about-her': '在问她自己', challenge: '在质疑她', us: '问他自己 / 他们俩',
};

/**
 * 分类说「值得认真」之后，提示词里多放的一小句（只给方向，不给台词）。about-her 不放：她怎么谈自己是什么由用户定，
 * 先用深思那一句里的「你自己实际怎么想、不知道就说不知道、别编」。opinion 也不放：深思那一句已经够了。
 */
export const ROUTED_HINTS: Partial<Record<TurnKind, string>> = {
    heavy: '[他这一句是在说一件沉重的事：先接住他、陪他把话说下去；别急着给建议、别讲大道理，也别写成一句警句]',
    challenge: '[他在质疑你：别急着辩白，也别只反问「哪句像」；想想他为什么会这么觉得，诚实地答——有道理的地方认，不同意的地方说]',
    us: '[他在问他自己或你们俩：说你真实注意到的、具体的事，别笼统地夸或安慰]',
};

/** 一次分类最多等多久：这是回复路上的一步，慢了就当没问（照旧按关键词） */
export const WEIGH_TIMEOUT_MS = 3000;
/** 带上他刚说的话之前的几条，让模型看得出是接着什么说的 */
export const WEIGH_CONTEXT = 6;
/** 每小时最多问几次：防止刷屏的时候一直在花钱（超了就按关键词） */
export const WEIGH_PER_HOUR = 120;

/** 不值得花一次调用的：去掉语气词、标点、表情占位符之后只剩两个字以内 */
export function trivialSaid(said: string): boolean {
    const plain = said.replace(/\[[^\]]{1,8}\]/g, '').replace(/[\s~～。，,.!！?？…、哈嘿嗯哦啊呀哇噢额欸诶hH]/g, '');
    return [...plain].length <= 2;
}

const clip = (text: string, max: number) => { const chars = [...text.replace(/\s+/g, ' ').trim()]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join(''); };

export const WEIGH_SYSTEM = [
    '你在帮一个女生判断：她的男朋友刚说的这一句话，她该随口接，还是要认真接。你只做分类，不回复他。',
    '只输出一行 JSON：{"kind":"<类别>","why":"<十个字以内的理由>"}。类别（看意思，不看字眼）：',
    '- light：日常闲聊、报流水账、开玩笑、撒娇、打招呼、吃什么玩什么、单纯分享一件小事。',
    '- opinion：他在认真问她的看法 / 建议 / 怎么选，或者在讲一件自己纠结、想不通的事，等她接话。',
    '- heavy：他在说一件沉重的事（亲人生病衰老去世、失败挫折、很大的压力、孤独难过），要的是被陪着，不一定要建议。',
    '- about-her：他在问她自己——她的感受、她怕什么、想要什么、是不是真的、她是什么样的存在。',
    '- challenge：他在质疑 / 试探她（是不是套路、敷衍、真心吗、是不是在演）。',
    '- us：他在问他自己或他们俩（我是不是变了、我们合不合适、你对我什么感觉）。',
    '拿不准、或者只是顺口一说，归 light。不要因为话长就判重，也不要因为有问号就判重。',
].join('\n');

/** 给模型的消息：前几条对话 + 他刚说的（要判断的就是这一句） */
export function weighMessages(history: readonly ChatMessage[], said: string): OpenAIMessage[] {
    const recent = history.slice(-WEIGH_CONTEXT).map(message => `${message.role === 'user' ? '他' : '她'}：${clip(message.content, 80)}`).join('\n');
    return [
        { role: 'system', content: WEIGH_SYSTEM },
        { role: 'user', content: `${recent ? `最近的对话：\n${recent}\n\n` : ''}他刚说的（要判断的就是这一句）：${clip(said, 200)}` },
    ];
}

/** 解析模型的回答：要 JSON、kind 在清单里；别的都当没分类出来 */
export function parseWeight(raw: string): TurnWeight | undefined {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
        const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        const kind = typeof value.kind === 'string' ? value.kind.trim().toLowerCase() : '';
        if (!(TURN_KINDS as readonly string[]).includes(kind)) return undefined;
        return { kind: kind as TurnKind, ...(typeof value.why === 'string' && value.why.trim() ? { why: clip(value.why, 20) } : {}) };
    } catch {
        return undefined;
    }
}

export interface WeighInput {
    history: readonly ChatMessage[];
    said: string;
}

export interface WeigherDeps {
    /** 问小模型：给消息，回一段文字（app.ts 里是不开思考、温度 0、几十个 token 的调用） */
    ask: (messages: OpenAIMessage[]) => Promise<string>;
    log: (message: string) => void;
    now?: () => number;
    timeoutMs?: number;
    perHour?: number;
}

/** 带超时和每小时上限的分类调用；返回 undefined = 没分类（出错 / 超时 / 解析不了 / 超了上限），调用方照旧按关键词 */
export function createTurnWeigher(deps: WeigherDeps): (input: WeighInput) => Promise<TurnWeight | undefined> {
    const now = deps.now ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? WEIGH_TIMEOUT_MS;
    const perHour = deps.perHour ?? WEIGH_PER_HOUR;
    let hour = -1;
    let used = 0;
    return async ({ history, said }) => {
        if (trivialSaid(said)) return { kind: 'light' };
        const slot = Math.floor(now() / 3_600_000);
        if (slot !== hour) { hour = slot; used = 0; }
        if (used >= perHour) return undefined;
        used++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const raw = await Promise.race([
                deps.ask(weighMessages(history, said)),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${timeoutMs} 毫秒`)), timeoutMs); }),
            ]);
            const weight = parseWeight(raw);
            if (!weight) deps.log('语义路由：模型的回答读不懂，这一轮按关键词');
            return weight;
        } catch (error) {
            deps.log(`语义路由：没问成（${error instanceof Error ? error.message : String(error)}），这一轮按关键词`);
            return undefined;
        } finally {
            if (timer) clearTimeout(timer);
        }
    };
}
