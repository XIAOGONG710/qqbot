// 表达层（ADR 0024）：真人发消息长短不一、会打错字再改口。
// - 长短：按他这一轮最后一条消息的时间和内容取哈希，SHORT_CHANCE 的轮次时间块里加「这一轮回句短的」，LONG_CHANCE 的加「这一轮话多一点」；
//   收尾、主动找他时不加；身体不舒服（痛经、感冒，ADR 0025）、心情安静时不加「话多」。只给一句约束，不给台词；气泡上限、出口检查照旧。
//   （改前 84 次回复：两条气泡的占 57%，一条的 12%，中位数每条 14 个字——DSH 侧说的「恒定 2 条 × 15–20 字」）
// - 打错字：发出去的气泡里有常见的同音错词（TYPOS）时，TYPO_CHANCE 的概率打错一个；多数紧跟一条「*正确的词」改口，少数懒得改。
//   不靠模型：模型很少自己打错，让它「偶尔打错」会写成刻意的错。聊天记录里存的是发出去的样子（他看到的就是这样）。

/** 回句短的、话多一点的概率（按轮） */
export const SHORT_CHANCE = 0.15;
export const LONG_CHANCE = 0.1;

export type LengthHint = 'short' | 'long';

export interface LengthContext {
    history: readonly { role: 'user' | 'assistant'; content: string; time?: string }[];
    /** 这一轮的意图行（收尾时不加） */
    intent?: string;
    initiating?: boolean;
    /** 身体不舒服、心情安静：不加「话多」 */
    low?: boolean;
}

/** 这一轮说话的长短（没有就是照常） */
export function lengthHint(context: LengthContext): LengthHint | undefined {
    if (context.initiating || context.intent?.includes('收尾')) return undefined;
    const last = context.history.findLast(message => message.role === 'user');
    if (!last) return undefined;
    const roll = unit(`${last.time ?? ''} ${last.content} length`);
    if (roll < SHORT_CHANCE) return 'short';
    // 话多要有由头：他这次说的太短（「到家了」）就不加（第一批：一句「到家了」她一口气说了 4 条 77 个字）
    if (roll < SHORT_CHANCE + LONG_CHANCE && !context.low && [...saidSinceReply(context.history)].length >= LONG_MIN_CHARS) return 'long';
    return undefined;
}

/** 他这次说的不到这么多字，不加「话多一点」 */
export const LONG_MIN_CHARS = 8;

function saidSinceReply(history: LengthContext['history']): string {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('');
}

export function describeLength(hint: LengthHint): string {
    return hint === 'short'
        ? '[这一轮说话：只回一句短的，几个字也行；不展开，不另起话题]'
        : '[这一轮说话：话多一点，想说的可以多说几句、说完整，不用一两句就停]';
}

/** 常见的同音错词：[正确的, 打错的]（拼音输入法选错词）。第一批 348 次回复里原来那 10 个只出现在 2.6% 的回复里，补了几个常用的；「在宿舍」「在床上」她天天说，同一种错反复出现反而假，不放 */
export const TYPOS: readonly [string, string][] = [
    ['应该', '因该'],
    ['因为', '应为'],
    ['已经', '以经'],
    ['在干嘛', '再干嘛'],
    ['再说', '在说'],
    ['做作业', '作作业'],
    ['好像', '好象'],
    ['知道', '知到'],
    ['再见', '在见'],
    ['觉得', '觉的'],
    ['反正', '反证'],
    ['以后', '已后'],
    ['在家', '再家'],
    ['还在', '还再'],
    ['再来', '在来'],
];

/** 有能打错的词时打错的概率；打错了改口的概率 */
export const TYPO_CHANCE = 0.2;
export const CORRECT_CHANCE = 0.7;

export interface Typo {
    parts: string[];
    /** 日志用：「应该 → 因该（改口）」 */
    note?: string;
}

/**
 * 发出去之前：可能把一条里的一个词打错，后面跟一条改口。seed 让同一次回复的结果固定（测试、重放）。
 * 改口那条会超过这一轮的条数上限（上课只回一条）就不改（第二批：上课时多出一条「*在干嘛」）
 */
export function maybeTypo(parts: readonly string[], seed: string, maxBubbles = Infinity): Typo {
    const roll = unit(`${seed} typo`);
    if (roll >= TYPO_CHANCE) return { parts: [...parts] };
    for (const [i, part] of parts.entries()) {
        const found = TYPOS.find(([right]) => part.includes(right));
        if (!found) continue;
        const [right, wrong] = found;
        const typed = part.replace(right, wrong);
        const correct = unit(`${seed} correct`) < CORRECT_CHANCE && parts.length < maxBubbles;
        const out = [...parts];
        out[i] = typed;
        if (correct) out.splice(i + 1, 0, `*${right}`);
        return { parts: out, note: `${right} → ${wrong}${correct ? '（改口）' : '（没改）'}` };
    }
    return { parts: [...parts] };
}

function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x1_0000_0000;
}
