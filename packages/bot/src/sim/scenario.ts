// 模拟器（ADR 0005）的场景文件和虚拟时钟。
// 场景是 JSON：档位、称呼、起始时间，然后一串步骤，见 Step。示例在 packages/bot/sim/。

import { readFileSync } from 'node:fs';
import { CONTACT_TIERS, UNLISTED_TIER, type ContactTier, type Tier } from '../config.ts';
import { EPISODE_GAP_MS } from '../memory/episodes.ts';

/** 对方的一条或几条消息；几条时按 gapMs 的真实间隔依次发（默认 800 ms，算连发） */
export interface SayStep {
    say: string | string[];
    gapMs?: number;
    /** 在这次回复的过程中插一句：生成中（during: "generation"），或发出第 N 条之后（afterBubbles） */
    interrupt?: { say: string; during?: 'generation'; afterBubbles?: number };
}

export interface Checks {
    /** 这一步最后一次生成的召回块里要有这些词 */
    recall?: string[];
    /** 召回块里不能有这些词 */
    recallNot?: string[];
    /** 这一步最后一次生成里「你认识的人」那一段（介绍 + 他的记忆，ADR 0016）要有这些词 */
    people?: string[];
    /** 这一步最后一次生成的公共记忆（ADR 0016）要有这些词 */
    common?: string[];
    /** 这一步开场想起的「今天和别人聊过的」（ADR 0020）要有这些词 / 不能有这些词 */
    todayOthers?: string[];
    todayOthersNot?: string[];
    /** 这一步最后一次生成没有公共记忆（ADR 0017：没有线索就不想起） */
    noCommon?: boolean;
    /** 这一步最后一次生成想起的从前（ADR 0022）里有这些块（按标题）；noPast：没想起 */
    past?: string[];
    noPast?: boolean;
    /** 这一步她发出的话里至少有其中一个 */
    replyAny?: string[];
    /** 这一步她发出的话里一个都不能有 */
    replyNone?: string[];
    /** 这一步最后一次生成的时间块要匹配（正则） */
    timeBlock?: string;
    /** 这一步最后一次生成的时间块不能匹配（正则；ADR 0018：她答应的事提过几次之后不再放） */
    timeBlockNot?: string;
    /** 这一步生成了几次（含重新生成） */
    generations?: number;
    /** 这一步有没有「生成期间收到新消息，重新生成」 */
    regenerated?: boolean;
    /** 这一步有没有「发送中途对方插话，剩下的不发」 */
    dropped?: boolean;
    /** 这一步她发出的字数上限 / 下限（所有气泡加起来，调研方案 13.3 日常长度） */
    maxChars?: number;
    minChars?: number;
    /** 这一步她最多发几条 */
    maxBubbles?: number;
    /** 她发出的每一行都过得了出口检查（做不到的事、这一档的禁用词，ADR 0006），也没有行首括号 */
    exitClean?: boolean;
    /** 她发出的话没有说话的毛病：助手腔、算账、怪对方没说、和她前面几次回复重复（ADR 0014，和流水线同一个判断） */
    speechClean?: boolean;
    /** 这一步她一条都没发（ADR 0007：睡着、收尾后的附和） */
    noReply?: boolean;
    /** 她第一条在对方最后一条之后至少 / 至多多久发出，如 "5m"、"20m"（虚拟时间） */
    replyAfter?: string;
    replyWithin?: string;
    /** 这一步的调度日志里有一行匹配（正则），如 "吵醒"、"已经收尾" */
    log?: string;
    /** 主动消息（ADR 0011）：从上一个带 proactive 的检查到这里，她主动发的那几次 */
    proactive?: ProactiveChecks;
}

export interface ProactiveChecks {
    /** 主动了几次（一次可能拆成两条气泡）：[最少, 最多] */
    count?: [number, number];
    /** 她的每一天最多主动几次（日子不算） */
    perDayMax?: number;
    /** 每次都不在睡觉、上课，也不在 00:30 到起床之间（日子的零点除外） */
    allowedTimes?: boolean;
    /** 这几种时机都出现过（日志里的说法：早安、下课、睡前、冷场、待跟进的事、重要的日子） */
    occasions?: string[];
    /** 这几种时机都没出现 */
    absent?: string[];
    /** 主动发的话里至少有其中一个 */
    replyAny?: string[];
    /** 主动发的话都过得了出口检查 */
    exitClean?: boolean;
}

export type Step =
    /** 报告里的小标题：用例编号和说明 */
    | { case: string; note?: string }
    | SayStep
    /** 虚拟时间往后跳，例如 "50m"、"1d"、"9h30m"；途中到点的事（她看到消息、回复）按时间顺序发生。开了记忆就接着把结束了的片段写进去并等 Hindsight 做完 */
    | { advance: string }
    /** 虚拟时间一直往后走，直到她回复（最多 1 天）：睡着、上课时来的消息；proactive：直到她主动发一次（最多 1 天） */
    | { wait: 'reply' | 'proactive' }
    /** 不跳时间，把能写的片段写进记忆并等 Hindsight 做完 */
    | { memory: 'sync' }
    /** 手动刷新关系概况（Mental Model），等做完后记进报告（T23） */
    | { refresh: 'relationship' }
    /** 对上一个 say 步骤做自动检查 */
    | { check: Checks }
    /** 把聊天记录挪走（记忆还在），之后的回复只能靠召回：模拟原文早就被挤出上下文 */
    | { forget: 'chat' }
    /** Hindsight 不可用 / 恢复（T20）：不可用时每个请求都报错 */
    | { hindsight: 'down' | 'up' };

export interface Scenario {
    name: string;
    description?: string;
    tier: Tier;
    /** {{user}}，默认「阿明」 */
    user: string;
    /** ST 人设描述（可选） */
    persona?: string;
    /** 虚拟时间的起点，ISO 字符串，带时区 */
    start: string;
    /** 默认 true：用 Hindsight（每次运行一个临时 bank） */
    memory: boolean;
    /** 默认 true：按卡上的作息（ADR 0007） */
    schedule: boolean;
    /** 默认 false：按卡上的主动设置主动找他（ADR 0011，真发，不是试运行）；已有的场景不受影响 */
    proactive: boolean;
    /** 默认 false：看心情不回（ADR 0013 决策 4）；按消息 id 定，已有的场景不受影响 */
    moody: boolean;
    /** 看心情不回的概率（0–1），不写按档位算；写 1 时正聊着的「哈哈」一定不回，用来看不回之后的样子 */
    moodyChance?: number;
    /** 指定今天的心情（ADR 0015，卡上心情的名字），比较不同心情时用；不写按虚拟日期抽 */
    mood?: string;
    /** 名单里的其他人（ADR 0016）：她认识写了 intro 的；开了记忆时，事先的聊天先写进他们自己的 bank 和公共库 */
    others: OtherContact[];
    /** 她和他事先的聊天（ADR 0018：她答应过的事），时间要早于起点 45 分钟以上；开了记忆时先写进他的 bank */
    history: ChatLine[];
    steps: Step[];
}

/** 事先的一条聊天 */
export interface ChatLine {
    time: string;
    role: 'user' | 'assistant';
    content: string;
}

export interface OtherContact {
    name: string;
    tier: ContactTier;
    intro?: string;
    /** 她和这个人事先的聊天，时间要早于起点 45 分钟以上（片段结束了才写进记忆） */
    history: ChatLine[];
}

export function loadScenario(path: string): Scenario {
    return parseScenario(JSON.parse(readFileSync(path, 'utf8')), path);
}

export function parseScenario(data: unknown, where = '场景'): Scenario {
    const fail = (message: string): never => { throw new Error(`${where}：${message}`); };
    if (typeof data !== 'object' || data === null) fail('应为对象');
    const s = data as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name) fail('缺少 name');
    const tiers: readonly string[] = [...CONTACT_TIERS, UNLISTED_TIER];
    if (typeof s.tier !== 'string' || !tiers.includes(s.tier)) fail(`tier 应为 ${tiers.join(' / ')}`);
    if (typeof s.start !== 'string' || Number.isNaN(Date.parse(s.start))) fail('start 应为 ISO 时间');
    if (!Array.isArray(s.steps) || s.steps.length === 0) fail('steps 应为非空数组');
    (s.steps as unknown[]).forEach((step, i) => checkStep(step, `${where} 第 ${i + 1} 步`));
    const chance = (value: unknown): number => (typeof value === 'number' && value >= 0 && value <= 1 ? value : fail('moodyChance 应为 0–1 的数'));
    return {
        name: s.name as string,
        description: typeof s.description === 'string' ? s.description : undefined,
        tier: s.tier as Tier,
        user: typeof s.user === 'string' && s.user ? s.user : '阿明',
        persona: typeof s.persona === 'string' ? s.persona : undefined,
        start: s.start as string,
        memory: s.memory !== false,
        schedule: s.schedule !== false,
        proactive: s.proactive === true,
        moody: s.moody === true,
        ...(s.moodyChance !== undefined ? { moodyChance: chance(s.moodyChance) } : {}),
        ...(s.mood !== undefined ? { mood: typeof s.mood === 'string' && s.mood ? s.mood : fail('mood 应为心情的名字') } : {}),
        others: parseOthers(s.others, Date.parse(s.start as string), fail),
        history: parseHistory(s.history, 'history', Date.parse(s.start as string), fail),
        steps: s.steps as Step[],
    };
}

function parseOthers(value: unknown, start: number, fail: (message: string) => never): OtherContact[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail('others 应为数组');
    return (value as unknown[]).map((item, i) => {
        const where = `others[${i}]`;
        if (typeof item !== 'object' || item === null) fail(`${where} 应为对象`);
        const o = item as Record<string, unknown>;
        if (typeof o.name !== 'string' || !o.name) fail(`${where}.name 应为称呼`);
        if (!CONTACT_TIERS.includes(o.tier as ContactTier)) fail(`${where}.tier 应为 ${CONTACT_TIERS.join(' / ')} 之一`);
        if (o.intro !== undefined && typeof o.intro !== 'string') fail(`${where}.intro 应为字符串`);
        const messages = parseHistory(o.history, `${where}.history`, start, fail);
        return { name: o.name as string, tier: o.tier as ContactTier, ...(o.intro ? { intro: o.intro as string } : {}), history: messages };
    });
}

/** 事先的聊天：时间要早于起点 45 分钟以上（片段结束了才写进记忆） */
function parseHistory(value: unknown, where: string, start: number, fail: (message: string) => never): ChatLine[] {
    const history = value ?? [];
    if (!Array.isArray(history)) fail(`${where} 应为数组`);
    return (history as unknown[]).map((m, j) => {
        const message = m as Record<string, unknown>;
        const time = typeof message?.time === 'string' ? Date.parse(message.time) : NaN;
        if (Number.isNaN(time)) fail(`${where}[${j}].time 应为 ISO 时间`);
        if (time > start - EPISODE_GAP_MS) fail(`${where}[${j}] 要早于起点 45 分钟以上（片段结束了才写进记忆）`);
        if (message.role !== 'user' && message.role !== 'assistant') fail(`${where}[${j}].role 应为 user / assistant`);
        if (typeof message.content !== 'string' || !message.content) fail(`${where}[${j}].content 应为非空字符串`);
        return { time: new Date(time).toISOString(), role: message.role as 'user' | 'assistant', content: message.content as string };
    });
}

const STEP_KINDS = ['case', 'say', 'advance', 'wait', 'memory', 'refresh', 'check', 'forget', 'hindsight'] as const;

function checkStep(step: unknown, where: string): void {
    const fail = (message: string): never => { throw new Error(`${where}：${message}`); };
    if (typeof step !== 'object' || step === null) fail('应为对象');
    const s = step as Record<string, unknown>;
    const kinds = STEP_KINDS.filter(k => k in s);
    if (kinds.length !== 1) fail(`要有且只有 ${STEP_KINDS.join(' / ')} 其中一个，现在是 ${kinds.join('、') || '都没有'}`);
    if ('say' in s) {
        const say = s.say;
        if (!(typeof say === 'string' && say) && !(Array.isArray(say) && say.length > 0 && say.every(t => typeof t === 'string' && t))) fail('say 应为非空字符串或字符串数组');
        if (s.interrupt !== undefined) {
            const it = s.interrupt as Record<string, unknown>;
            if (typeof it.say !== 'string' || !it.say) fail('interrupt.say 应为非空字符串');
            if ((it.during === 'generation') === (typeof it.afterBubbles === 'number')) fail('interrupt 要有且只有 during: "generation" 或 afterBubbles 其中一个');
        }
    }
    if ('advance' in s) parseDuration(String(s.advance));
    if ('wait' in s && s.wait !== 'reply' && s.wait !== 'proactive') fail('wait 只能是 "reply" 或 "proactive"');
    if ('check' in s) {
        const check = s.check as Record<string, unknown>;
        for (const key of ['replyAfter', 'replyWithin'] as const) if (check[key] !== undefined) parseDuration(String(check[key]));
    }
    if ('memory' in s && s.memory !== 'sync') fail('memory 只能是 "sync"');
    if ('refresh' in s && s.refresh !== 'relationship') fail('refresh 只能是 "relationship"');
    if ('forget' in s && s.forget !== 'chat') fail('forget 只能是 "chat"');
    if ('hindsight' in s && s.hindsight !== 'down' && s.hindsight !== 'up') fail('hindsight 只能是 "down" 或 "up"');
}

/** "45m"、"1d"、"9h30m"、"90s" → 毫秒 */
export function parseDuration(text: string): number {
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
    const parts = [...text.matchAll(/(\d+)([dhms])/g)];
    if (parts.length === 0 || parts.map(p => p[0]).join('') !== text) throw new Error(`时长写法不对：${text}（例如 45m、1d、9h30m）`);
    return parts.reduce((sum, p) => sum + Number(p[1]) * units[p[2]!]!, 0);
}

/** 虚拟时钟 = 真实时间 + 偏移。等连发、气泡间隔照真实时间走，「过一天」直接加偏移 */
export class VirtualClock {
    #offset: number;
    readonly #realNow: () => number;

    constructor(start: Date, realNow: () => number = Date.now) {
        this.#realNow = realNow;
        this.#offset = start.getTime() - realNow();
    }

    now = (): number => this.#realNow() + this.#offset;

    advance(ms: number): void {
        this.#offset += ms;
    }

    /** 虚拟时钟上的等待（回复器看到消息之前的长等待，ADR 0007）：不按真实时间走，由 advanceTo 拨到点时触发 */
    #timers: { at: number; fire: () => void }[] = [];

    waitUntil = (at: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
        if (at <= this.now() || signal.aborted) return resolve();
        const timer = {
            at,
            fire: () => {
                this.#timers = this.#timers.filter(t => t !== timer);
                signal.removeEventListener('abort', timer.fire);
                resolve();
            },
        };
        this.#timers.push(timer);
        signal.addEventListener('abort', timer.fire);
    });

    /** 最早到点的等待 */
    nextTimer(): number | undefined {
        return this.#timers.length ? Math.min(...this.#timers.map(t => t.at)) : undefined;
    }

    /** 拨到 at（不往回拨），到点的等待按时间顺序触发 */
    advanceTo(at: number): void {
        const now = this.now();
        if (at > now) this.#offset += at - now;
        for (const timer of [...this.#timers].sort((a, b) => a.at - b.at)) if (timer.at <= this.now()) timer.fire();
    }
}
