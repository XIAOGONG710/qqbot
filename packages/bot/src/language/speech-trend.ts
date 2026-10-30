// 她说话的样子按周看（ADR 0196，ADR 0190 的第 5 步里不需要真人盲评的那一半；随 speechNotes 开关）。
//
// 为什么要有：ADR 0193 / 0195 让她自己总结、让他的感受进她的想法，但「提示词里放几行话压不过模型自己的长度先验」——
// 到底有没有变，要看真实聊天里的数字，而不是看笔记写得好不好。聊天记录本来就是原始数据，所以这里**不存任何状态**：
// 要看的时候从聊天记录里按周数一遍（一次回几条、每条多长、两字以内的短反应、问号、表情），再放上真人语料里同一组数字。
// **只是监测，不是目标线**：数字不进她的提示词、不在代码里卡她、也不拿去评分（ADR 0190 的约定）。
// 盲评（让真人分不分得出）要人，这里没有。

import type { StoredMessage } from '../memory/history.ts';
import { herTurns, speechStats, statsLine, type SpeechStats } from './speech-notes.ts';

export const WEEK_MS = 7 * 86_400_000;
/** 往回看几周 */
export const TREND_WEEKS = 4;
/** 一周里至少几个气泡，数字才当数（太少就只说有几条） */
export const TREND_MIN_BUBBLES = 6;

export interface TrendWindow {
    label: string;
    /** 这一周她发了多少个气泡；0 就是没说话 */
    bubbles: number;
    /** 够多才有；不够多是 undefined（数出来的比例没有意义） */
    stats?: SpeechStats;
}

const LABELS = ['最近 7 天', '7–14 天前', '14–21 天前', '21–28 天前', '28–35 天前'];

/** 从新到旧每周一个窗口。相邻的窗口在边界上不重叠（早的那个窗口的终点往前挪 1 毫秒） */
export function speechTrend(messages: readonly StoredMessage[], now: number, weeks = TREND_WEEKS): TrendWindow[] {
    return Array.from({ length: Math.min(weeks, LABELS.length) }, (_, index) => {
        const end = now - index * WEEK_MS - (index > 0 ? 1 : 0);
        const stats = speechStats(herTurns(messages, end, WEEK_MS));
        const bubbles = stats?.bubbles ?? 0;
        return { label: LABELS[index]!, bubbles, ...(stats && bubbles >= TREND_MIN_BUBBLES ? { stats } : {}) };
    });
}

/** /说话趋势 的回复：以「（」开头（运维提示，不进聊天记录）。real 是真人语料里的同一组数字（可以没有） */
export function describeTrend(windows: readonly TrendWindow[], real?: SpeechStats): string {
    const lines = windows.map(window => {
        if (!window.bubbles) return `${window.label}：没怎么说话`;
        if (!window.stats) return `${window.label}（${window.bubbles} 条）：太少了，数出来的比例不当数`;
        return `${window.label}（${window.bubbles} 条）：${statsLine(window.stats)}`;
    });
    return `（她说话的样子，按周看（从聊天记录里数出来的；只是给你看，没有目标线，不会拿去卡她，也不是评分）：\n${lines.join('\n')}${real ? `\n\n真人女生的参照（来自 ${real.bubbles} 条真实语料）：${statsLine(real)}` : ''}\n\n她每晚想说话习惯的时候看到的，是最近 3 天的这一组数字。盲评（真人分不分得出）这里没有。）`;
}
