// 情绪 → 行为（2026-10-30）：心境原来只往提示词里加一行字，她心情差跟平时回得一样长、一样爱发表情。
// 这里把已经算好的心境（emotion/feelings.ts，纯函数、有来由）映射成看得见的东西：
//   · 这一轮最多几条气泡
//   · 提示词里一句「这会儿话多/话少」的方向
// 不做的事：不改她说的内容（那是她的），不加新的状态字段（心境本来就是现算的）。
import type { Felt } from './feelings.ts';

/** 一条心境事实在提示词里的分量：faint 只算 0，clear/strong 才有用 */
const weight = (level: Felt['level']): number => (level === 'strong' ? 2 : level === 'clear' ? 1 : 0);

export interface MoodShape {
    sad: number;
    annoyed: number;
    joy: number;
    tired: number;
}

/** 从这一轮的心境事实里取出四项权重（没有就是 0） */
export function moodShape(feelings: readonly Pick<Felt, 'kind' | 'level'>[]): MoodShape {
    const shaped: MoodShape = { sad: 0, annoyed: 0, joy: 0, tired: 0 };
    for (const feeling of feelings) {
        if (feeling.kind === 'sad') shaped.sad += weight(feeling.level);
        else if (feeling.kind === 'annoyed') shaped.annoyed += weight(feeling.level);
        else if (feeling.kind === 'joy') shaped.joy += weight(feeling.level);
        else if (feeling.kind === 'tired') shaped.tired += weight(feeling.level);
    }
    return shaped;
}

/**
 * 这一轮最多几条气泡。难过/烦/累压过开心时收成一两条；开心明显又没有负面时允许多一泡。
 * base 是形状那套算出来的上限，这里只在它基础上收紧或放宽一格，不推翻它。
 */
export function tunedMaxBubbles(base: number, mood: MoodShape): number {
    const low = mood.sad + mood.annoyed + mood.tired;
    if (low >= 2 && low > mood.joy) return Math.max(1, Math.min(2, base));
    if (mood.joy >= 2 && low === 0) return Math.min(base + 1, 3);
    return base;
}

/** 提示词里一句方向：只说她这会儿说多说少，不教她内容 */
export function moodPaceLine(mood: MoodShape): string | undefined {
    const low = mood.sad + mood.annoyed + mood.tired;
    if (low >= 2 && low > mood.joy) return '（你这会儿提不起劲：话少一点，别硬开玩笑，也别写长句；不想接就只回一句）';
    if (mood.joy >= 2 && low === 0) return '（你这会儿心情好：话可以多一点，可以主动带一句自己的事，但不用刻意热闹）';
    return undefined;
}
