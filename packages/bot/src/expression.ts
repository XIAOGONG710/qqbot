// 表达层（ADR 0024）：真人发消息长短不一、会打错字再改口。
// - 长短：按他这一轮最后一条消息的时间和内容取哈希，SHORT_CHANCE 的轮次时间块里加「这一轮回句短的」，LONG_CHANCE 的加「这一轮话多一点」；
//   收尾、主动找他时不加；身体不舒服（痛经、感冒，ADR 0025）、心情安静时不加「话多」。只给一句约束，不给台词；气泡上限、出口检查照旧。
//   （改前 84 次回复：两条气泡的占 57%，一条的 12%，中位数每条 14 个字——DSH 侧说的「恒定 2 条 × 15–20 字」）
// - 打错字：发出去的气泡里有常见的同音错词（TYPOS）时，TYPO_CHANCE 的概率打错一个；多数紧跟一条「*正确的词」改口，少数懒得改。
//   不靠模型：模型很少自己打错，让它「偶尔打错」会写成刻意的错。聊天记录里存的是发出去的样子（他看到的就是这样）。

/** 回句短的、话多一点的概率（按轮） */
export const SHORT_CHANCE = 0.5;
export const LONG_CHANCE = 0.1;
/**
 * 想到哪说到哪、连着发三四条很短的（真人一轮 3 条以上占 14–23%，调研 C；候选 5 之后 73 题题库只剩 0%、两条占 44%，真人 22–28%）。
 * 和「话多一点」不一样：不是把话说完整，是几个字一条地连发。要他说的有分量（LONG_MIN_CHARS）、她没在难受 / 不舒服，不在他说不顺心的事、要接住他情绪的时候用
 */
export const BURST_CHANCE = 0.12;

export type LengthHint = 'short' | 'long' | 'burst';

/**
 * 这一轮要认真接话的意图行（先接他的情绪、替他高兴好事、回应他说的那件事、只接两个人的事、要亲近 / 要哄）：不加「回很短」。
 * 10-12 真模型回归：同时带「先接住他此刻的情绪」和「回很短」（哪怕写了「难受时不适用」）时，哭着来的那一轮她没有一句安慰；
 * 盲评 20 题里「短」在这类话题上输得多。只靠提示词里的例外不够，在代码里让路。
 */
export const ENGAGED_INTENT = /先接住他此刻的情绪|他刚说了件好事|回应他刚说的那件事|只接他刚说的你们两个人的事|他在向你要亲近|他在撒娇要你哄他/;

/**
 * 他这一段话里在说不顺心、担心的事（被打回、没过、怎么办、还有救吗）：意图行不是「先接情绪」时也不加「回很短」。
 * 10-18 题库 be-021：他说报告被老师打回来、问「你说我这还有救吗」，意图行是「先直接回答他刚问的」，她只回了「有吧」两个字。
 * 只认明确说法（和 intent.ts 的 needsCare 一样不从普通短句猜心情）；「服了」「烦」这类玩笑里也常用的词不收。
 */
export const WORRIED_TEXT = /被(?:老师|老板|导师|领导)?(?:打回|拒|刷|退回|淘汰)|没(?:过|通过|考好)|挂(?:了|科)|考砸|还有救|有救吗|怎么办|咋办|我是不是(?:不行|太)/;

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
    // 他明着让她讲（「你帮我认真讲讲」「详细说说」）就多说几句，不抽签（10-10 示例改短之后 boyfriend-tone T06 讲梯度下降只剩 53 字）
    if (!context.low && ASKS_TO_EXPLAIN.test(last.content)) return 'long';
    const roll = unit(`${last.time ?? ''} ${last.content} length`);
    if (roll < SHORT_CHANCE) return (context.intent && ENGAGED_INTENT.test(context.intent)) || WORRIED_TEXT.test(saidSinceReply(context.history)) ? undefined : 'short';
    // 话多要有由头：他这次说的太短（「到家了」）就不加（第一批：一句「到家了」她一口气说了 4 条 77 个字）
    if (roll < SHORT_CHANCE + LONG_CHANCE && !context.low && [...saidSinceReply(context.history)].length >= LONG_MIN_CHARS) return 'long';
    if (roll >= SHORT_CHANCE + LONG_CHANCE && roll < SHORT_CHANCE + LONG_CHANCE + BURST_CHANCE && !context.low
        && [...saidSinceReply(context.history)].length >= LONG_MIN_CHARS && !WORRIED_TEXT.test(saidSinceReply(context.history)) && !CARE_INTENT.test(context.intent ?? '')) return 'burst';
    return undefined;
}

/** 要先接住他情绪的轮次：连发很短的几条会像在敷衍，不用 burst */
export const CARE_INTENT = /先接住他此刻的情绪/;

/** 他明着让她讲、让她说详细 */
export const ASKS_TO_EXPLAIN = /讲讲|讲一下|详细|认真(?:说|讲|跟我说)|解释|教教?我|展开说|具体说说/;

/** 他这次说的不到这么多字，不加「话多一点」 */
export const LONG_MIN_CHARS = 8;

function saidSinceReply(history: LengthContext['history']): string {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('');
}

export function describeLength(hint: LengthHint): string {
    if (hint === 'burst') return '[这一轮说话：连着发三四条很短的，每条几个字，不用说成完整的句子，都围绕他刚说的这一件事，顺着他的话反应、接话；不另起话题，不报自己今天的别的事，别每条都问问题；他在难受或认真说事时不适用，照平常的说]';
    return hint === 'short'
        ? '[这一轮说话：只回很短的一句，一两个字也行——语气词、单个词、一句反问都可以，不用凑成完整的句子；不展开，不另起话题。他在难受、报大事、等安慰或闹别扭时不适用，照平常的说]'
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
