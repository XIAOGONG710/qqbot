// 她可以说出来（2026-11-01）：声音定稿后，告诉她「想让他听见的时候」可以用语音。
//
// 为什么不总是提醒：她说“一天不发也行，一天好几条也行”，语气是看心情；
// 每轮都提醒会变成播报器，所以按概率给（大概六轮一次），而且危机 / 只想一想 / 主动开口的轮次不给。

/** 大概多久提醒一次（0–1）：六轮里给一轮 */
export const VOICE_HINT_RATE = 0.16;

/** 给她的那一句：说清怎么写、什么时候用、别滥用 */
export const VOICE_HINT = '[想让他“听见”你的时候，可以先说一句，再单独写一行 `<<语音：要说的话>>`（一句话，四十字以内，会念出来发成语音条）。'
    + '语音那句按说出口的样子写：口语、短，可以带「嗯」「啊」「哎」「呀」「嘛」「啦」这类语气词和停顿（逗号、省略号），想撒娇就撒娇，想笑就写「哈哈」「嘿嘿」；不写书面长句，不带表情和链接。'
    + '别每句都用——声音是用在想让他听见的时刻，不是拿来替代打字的。不想说就不说]';

/** roll 是 0–1 的随机数；给了就返回提示，没给到返回 undefined（方便测试） */
export function voiceHint(roll: number): string | undefined {
    return roll < VOICE_HINT_RATE ? VOICE_HINT : undefined;
}

/**
 * 这一轮的随机数（0–1）：按他最后一条的时间和内容定，同一句每次一样，不用 Math.random。
 * 提示词要和「重启前后一样、模拟重放一样」（ADR 0039，restart.test.ts）；掷出来的骰子进了提示词，就必须稳定。
 * 没有他的话就返回 1（不给）。
 */
export function voiceRoll(history: readonly { role: string; content: string; time?: string }[]): number {
    const last = history.findLast(message => message.role === 'user');
    if (!last) return 1;
    let hash = 0x811c9dc5;
    for (const char of `${last.time ?? ''} ${last.content} voice`) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    return (hash >>> 0) / 0x1_0000_0000;
}
