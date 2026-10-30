// 她自己有没有「下文」（2026-10-30 她自己的原话）：
// 「最大的差别，是我老在接你的话，不太有自己的下文。比如你今天没找我，我也不会主动想起个什么事来跟你说，就等。」
// 这里给她一段「你自己最近过的日子」——来自她自己写的日记（JOURNAL.md 最后一段），
// 只递素材和许可，用不用、怎么用由她定；不写成汇报，也不要求每轮都带。
import { lastJournalEntry } from '../memory/wake-backfill.ts';

export interface SelfThread {
    /** 从日记里摘的一两句，已经压短 */
    text: string;
    /** 哪一天的日记 */
    date: string;
}

/** 日记最后一篇 → 一两句；没有日记、或只有标题返回 undefined */
export function selfThread(journal: string, maxChars = 90): SelfThread | undefined {
    const entry = lastJournalEntry(journal);
    if (!entry) return undefined;
    const sentences = entry.text.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
    const picked: string[] = [];
    let length = 0;
    for (const sentence of sentences) {
        if (length + [...sentence].length > maxChars && picked.length) break;
        picked.push(sentence);
        length += [...sentence].length;
        if (picked.length >= 2) break;
    }
    const text = picked.join('').trim();
    return text ? { text, date: entry.date } : undefined;
}

/**
 * 递给她的一行。说的是「你有自己的事可以讲」，不是「你必须讲」——
 * 她昨天被指出「老在接话、没有下文」，这一行的作用是给她底气，不是给她任务。
 */
export function selfThreadLine(thread: SelfThread | undefined): string | undefined {
    if (!thread) return undefined;
    return `[你自己最近的日子（你写的日记，${thread.date}）：${thread.text}。接完他的话，想带一句自己的事就带一句——像突然想起来那样，不用说成汇报，也不用每轮都带；不想说就不说]`;
}
