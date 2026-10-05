// 模拟器（ADR 0005）的场景文件和虚拟时钟。
// 场景是 JSON：档位、称呼、起始时间，然后一串步骤，见 Step。示例在 packages/bot/sim/。

import { readFileSync } from 'node:fs';
import { CONTACT_TIERS, UNLISTED_TIER, type Tier } from '../config.ts';

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
    /** 这一步她发出的话里至少有其中一个 */
    replyAny?: string[];
    /** 这一步她发出的话里一个都不能有 */
    replyNone?: string[];
    /** 这一步最后一次生成的时间块要匹配（正则） */
    timeBlock?: string;
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
    steps: Step[];
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
        steps: s.steps as Step[],
    };
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
