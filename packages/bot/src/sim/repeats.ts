// 模拟器的跨轮重复（DSH 复核 ADR 0036 P2-6）：同一次运行里她把同一句话（同一句式）说了第二遍。
// 出口检查的重复（speech-check.ts，ADR 0014）只和最近 8 次回复比、第三次才算，查的是口癖（开头、4 字片段）；这里查整句，第二次就算。
// 按短句比（逗号、句号、问号、空格……隔开的一段），归一之后一样就算同一句式：
// - 去掉标点、表情、空格和语气词（啊呀呢吧嘛哦……了），字母一律小写；
// - 数字算一样：阿拉伯数字、两个字以上连着的中文数字都换成 #（「还差1750」「还差2300」是一句）；
// - 太短的不算：归一后不到 4 个字（连着的字母、数字算一个字），「嗯」「好的」「去吧去吧」「晚安」这种短应答谁都天天说；
// - 他说过的不算：接他的话、复述他的安排（「九点二十五集合」）不是她自己在重复；
// - 一句是另一句加了一两个字（「刚跟室友扯了半天」「我刚跟室友扯了半天」）也算：短的那句至少 6 个字、占长的四分之三以上。
//   只差一两个字但意思可能相反的（「明天带你上分」「明天不带你上分了」）不算：编辑距离在旧批次上误伤太多。
// 场景里按步骤开（check 的 noRepeat）：他把同一个问题问两遍时她照答一遍是对的，这种步骤别开。
// 误伤评估见 ADR 0036「调整（2026-10-09，DSH 复核 P1-5、P2-6、P2-8）」：旧批次 747 次运行、4780 次回复每次都查，命中 56 次，逐条看过。

import type { StoredMessage } from '../history.ts';

/** 归一后至少几个字才比 */
export const MIN_SENTENCE = 4;
/** 「一句包含另一句」时短的那句至少几个字、占长的多少 */
const CONTAIN_MIN = 6;
const CONTAIN_RATIO = 0.75;

const CLAUSE = /[，,。.！!？?、~～…；;：:\s—]+/;
const PARTICLES = /[啊呀呢吧嘛哦噢喔哈啦咯嘞么诶欸哎唉嗯哟呗咧啰了]/g;

/** 一个短句归一之后的样子（比较用） */
export function sentenceKey(text: string): string {
    return text.toLowerCase()
        .replace(/[0-9]+/g, '#')
        .replace(/[零〇一二两三四五六七八九十百千万]{2,}/g, '#')
        .replace(/[^\p{L}\p{N}#]/gu, '')
        .replace(PARTICLES, '');
}

/** 几个字：汉字一个算一个，连着的字母、数字、# 算一个 */
export function keySize(key: string): number {
    return (key.match(/[a-z0-9#]+|[^a-z0-9#]/g) ?? []).length;
}

/** 两句归一之后算不算同一句式 */
export function sameSentence(a: string, b: string): boolean {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return keySize(short) >= CONTAIN_MIN && long.includes(short) && short.length / long.length >= CONTAIN_RATIO;
}

/** 够长、拿来比的短句 */
function sentences(text: string): { text: string; key: string }[] {
    return text.split(CLAUSE).map(part => ({ text: part.trim(), key: sentenceKey(part) })).filter(s => keySize(s.key) >= MIN_SENTENCE);
}

export interface RepeatHit {
    /** 这次说的那一句 */
    said: string;
    /** 前面说过的那一句 */
    before: string;
}

/**
 * 她这次说的（reply，几行）里和前面说过的同一句式的；earlier 是这次之前的聊天（她的、他的），他说过的不算。
 * 这次回复里自己说了两遍的也算
 */
export function repeatedSentences(reply: string, earlier: readonly Pick<StoredMessage, 'role' | 'content'>[]): RepeatHit[] {
    const his = earlier.filter(m => m.role === 'user').map(m => sentenceKey(m.content));
    const hers = earlier.filter(m => m.role === 'assistant').flatMap(m => sentences(m.content));
    const hits: RepeatHit[] = [];
    for (const sentence of sentences(reply)) {
        if (his.some(said => said.includes(sentence.key))) continue;
        const before = hers.find(s => sameSentence(s.key, sentence.key));
        if (before) hits.push({ said: sentence.text, before: before.text });
        hers.push(sentence);
    }
    return hits;
}
