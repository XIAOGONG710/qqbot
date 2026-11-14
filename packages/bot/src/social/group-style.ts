// 从群的聊天记录里学「这个群怎么说话」（2026-11-14）。
//
// 用户要她「学会怎么养鱼、更好地融进去」。不做玄学人设：直接从导进来的 1400 多条里取统计——
// 大家说话多长、常用哪些词、谁话最多、爱用什么表情、几点最热闹，再挑几条最有代表性的原话
// 当示范。这些都进群聊提示词，她照着这个群的口气说话。
//
// 纯函数、不调模型；结果按群缓存，聊天记录变了才会重算（调用方自己决定什么时候算）。

import type { GroupEntry } from './group-chat.ts';

export interface GroupStyle {
    /** 别人每条平均几个字（她自己不算） */
    avgChars: number;
    /** 出现最多的词（两个字以上，去掉常见虚词） */
    topWords: string[];
    /** 大家爱用的表情/颜文字 */
    emojis: string[];
    /** 最多话的几个人 */
    talkers: { name: string; count: number }[];
    /** 一天里最热闹的时段（0-23，最多两个） */
    busiestHours: number[];
    /** 有代表性的原话（不写是谁说的，给她学口气用） */
    exemplars: string[];
    /** 看了多少条 */
    sampleSize: number;
}

/** 这些词不算「群里的词」：虚词、口头禅之外没信息量的 */
const STOP = new Set([
    '这个', '那个', '就是', '不是', '可以', '什么', '怎么', '我们', '你们', '他们', '自己', '现在', '时候', '还是', '真的',
    '一个', '没有', '知道', '觉得', '因为', '所以', '但是', '如果', '然后', '而且', '已经', '这样', '那样', '一下', '一样',
    '起来', '出来', '进去', '东西', '事情', '问题', '感觉', '应该', '可能', '需要', '有点', '有点', '哈哈', '哈哈哈',
]);

const FACES = ['😂', '🤣', '😅', '😭', '🥲', '😊', '😄', '😆', '😁', '🤔', '😏', '😳', '🥹', '😮', '👍', '💀', '🙏', '👀'];

/** 中文里两字以上的词：不切词，直接用 2-4 字的连续汉字找高频片段（够用，也不怕没词典） */
function ngrams(text: string): string[] {
    const out: string[] = [];
    for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
        // 只取 2 字词：3 字会全是「这破显」「破显卡」这种互相重叠的碎片
        for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    }
    return out;
}

export function analyzeGroupStyle(entries: readonly GroupEntry[], options: { exemplars?: number } = {}): GroupStyle {
    const theirs = entries.filter(entry => !entry.mine && entry.content.trim());
    const avgChars = theirs.length
        ? Math.round(theirs.reduce((sum, entry) => sum + [...entry.content].length, 0) / theirs.length)
        : 0;

    const counts = new Map<string, number>();
    for (const entry of theirs) for (const gram of ngrams(entry.content)) counts.set(gram, (counts.get(gram) ?? 0) + 1);
    // 只留反复出现的（一段废话里偶然连起来的两个不算），再按出现次数排
    const topWords = [...counts]
        .filter(([word, count]) => count >= 3 && !STOP.has(word))
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
        .slice(0, 8)
        .map(([word]) => word);

    const emojis = FACES.map(face => ({ face, count: entries.reduce((sum, entry) => sum + entry.content.split(face).length - 1, 0) }))
        .filter(item => item.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(item => item.face);

    const talkers = [...theirs.reduce((map, entry) => map.set(entry.name, (map.get(entry.name) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => ({ name, count }));

    const hours = new Map<number, number>();
    for (const entry of theirs) {
        const at = Date.parse(entry.time);
        if (!Number.isFinite(at)) continue;
        const hour = new Date(at).getHours();
        hours.set(hour, (hours.get(hour) ?? 0) + 1);
    }
    const busiestHours = [...hours].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([hour]) => hour);

    // 示范原话：太短太长都不要，挑不同的人，尽量避开纯链接
    const wanted = options.exemplars ?? 6;
    const seen = new Set<string>();
    const exemplars: string[] = [];
    for (const entry of [...theirs].reverse()) {
        const text = entry.content.replace(/\s+/g, ' ').trim();
        const length = [...text].length;
        if (length < 3 || length > 40) continue;
        if (/^(?:\[|http|www\.)/.test(text)) continue;
        const key = text.slice(0, 8);
        if (seen.has(key)) continue;
        seen.add(key);
        exemplars.push(text);
        if (exemplars.length >= wanted) break;
    }

    return { avgChars, topWords, emojis, talkers, busiestHours, exemplars, sampleSize: theirs.length };
}

/** 给她的说明里那一段：怎么说话像这个群的人 */
export function renderGroupStyle(style: GroupStyle | undefined): string | undefined {
    if (!style || !style.sampleSize) return undefined;
    const lines: string[] = [];
    if (style.avgChars) lines.push(`大家一条大概 ${style.avgChars} 个字`);
    if (style.topWords.length) lines.push(`常出现：${style.topWords.join('、')}`);
    if (style.emojis.length) lines.push(`常用表情：${style.emojis.join('')}`);
    if (style.talkers.length) lines.push(`话最多的是 ${style.talkers.map(item => `${item.name}（${item.count} 条）`).join('、')}`);
    if (style.busiestHours.length) lines.push(`最热闹大概 ${style.busiestHours.map(hour => `${hour} 点`).join('、')}`);
    const head = `[这个群平时的味儿（从最近 ${style.sampleSize} 条里看出来的，学他们的口气）：${lines.join('；')}。`;
    const samples = style.exemplars.length ? `他们平时这么说：${style.exemplars.map(text => `「${text}」`).join('')}` : '';
    return `${head}${samples}]`;
}
