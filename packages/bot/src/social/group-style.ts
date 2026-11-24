// 从群的聊天记录里学「这个群怎么说话」（2026-11-14）。
//
// 用户要她「学会怎么养鱼、更好地融进去」。不做玄学人设：直接从导进来的 1400 多条里取统计——
// 只提供群聊统计，给她判断对话节奏用；群友原话不另摘出来当示范。
//
// 纯函数、不调模型；结果按群缓存，聊天记录变了才会重算（调用方自己决定什么时候算）。

import type { GroupEntry } from './group-chat.ts';

export interface GroupStyle {
    /** 别人每条平均几个字（她自己不算） */
    avgChars: number;
    /** 最多话的几个人 */
    talkers: { name: string; count: number }[];
    /** 一天里最热闹的时段（0-23，最多两个） */
    busiestHours: number[];
    /** 看了多少条 */
    sampleSize: number;
}

export function analyzeGroupStyle(entries: readonly GroupEntry[]): GroupStyle {
    const theirs = entries.filter(entry => !entry.mine && entry.content.trim());
    const avgChars = theirs.length
        ? Math.round(theirs.reduce((sum, entry) => sum + [...entry.content].length, 0) / theirs.length)
        : 0;

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

    return { avgChars, talkers, busiestHours, sampleSize: theirs.length };
}

/** 给她的说明里那一段：怎么说话像这个群的人 */
export function renderGroupStyle(style: GroupStyle | undefined): string | undefined {
    if (!style || !style.sampleSize) return undefined;
    const lines: string[] = [];
    if (style.avgChars) lines.push(`大家一条大概 ${style.avgChars} 个字`);
    if (style.talkers.length) lines.push(`话最多的是 ${style.talkers.map(item => `${item.name}（${item.count} 条）`).join('、')}`);
    if (style.busiestHours.length) lines.push(`最热闹大概 ${style.busiestHours.map(hour => `${hour} 点`).join('、')}`);
    return `[群聊节奏（按最近的 ${style.sampleSize} 条统计）：${lines.join('；')}。]`;
}
