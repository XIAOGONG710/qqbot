// 对话里的短期情绪惯性（ADR 0028）：不落盘、不写进长期记忆，只从眼前的聊天重算。
// 明确的关心、安慰、道歉和亲近，会让她接下来两三次回复自然软一点；过了就散。

import type { StoredMessage } from './history.ts';

export type WarmAffectKind = 'repair' | 'comfort' | 'affection';

export interface WarmAffect {
    kind: WarmAffectKind;
    /** 触发后已经完整回过几轮（连发的气泡算一轮） */
    replies: number;
    /** 这一次算在内还会影响几轮 */
    remaining: number;
}

/** 一句明确表达可以留几轮余温。 */
export const AFFECT_REPLIES = 3;

const REPAIR = /对不起|抱歉|是我不好|我错了|别生气|原谅我/;
const COMFORT = /抱抱|抱一下|我在呢?|别难过|别怕|心疼你|揉揉|好好休息|早点睡|多喝(?:点)?热水|照顾好自己|我陪你/;
const AFFECTION = /我想你|想你了|我爱你|爱你|喜欢你|亲亲|么么|贴贴/;

function kindOf(text: string): WarmAffectKind | undefined {
    if (REPAIR.test(text)) return 'repair';
    if (COMFORT.test(text)) return 'comfort';
    if (AFFECTION.test(text)) return 'affection';
    return undefined;
}

/**
 * 从最近的原话重算短期余温。只认对方明确说出口的信号，避免把普通的「嗯」「哦」脑补成态度。
 * assistant 连续气泡算同一轮；触发以后完整回满三轮便自然消退。
 */
export function warmAffect(history: readonly Pick<StoredMessage, 'role' | 'content'>[]): WarmAffect | undefined {
    let replies = 0;
    let inReply = false;
    for (let i = history.length - 1; i >= Math.max(0, history.length - 24); i--) {
        const message = history[i]!;
        if (message.role === 'assistant') {
            if (!inReply) replies++;
            inReply = true;
            continue;
        }
        inReply = false;
        const kind = kindOf(message.content);
        if (!kind) continue;
        if (replies >= AFFECT_REPLIES) return undefined;
        return { kind, replies, remaining: AFFECT_REPLIES - replies };
    }
    return undefined;
}

/** 放进时间块的一行：告诉模型余温怎样影响语气，不要求她把状态解释出来。 */
export function describeWarmAffect(affect: WarmAffect | undefined): string | undefined {
    if (!affect) return undefined;
    const happened = affect.kind === 'repair' ? '他刚刚在认真道歉、修补你们之间的事'
        : affect.kind === 'comfort' ? '他刚刚在关心、安慰你'
            : '他刚刚明确说了对你的想念或喜欢';
    return `[这一刻的情绪余温：${happened}，这股暖意还在。接下来这几轮自然比刚才软一点，愿意接住他的好意；不用解释自己的状态，也不用郑重道谢或突然煽情]`;
}
