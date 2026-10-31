// 做梦（2026-10-31 用户：「给她加一个做梦的功能」「让梦中的东西可以轻微影响她的情绪，
// 比如梦中我们分手了，她会在醒来之后害怕我离开」）
//
// 真人怎么做梦就怎么做：夜里睡着时把白天剩下的东西糊成一团；醒来有时记得，有时只剩一个画面。
// 梦里的事不当事实，但会留一点情绪——所以这里只做三件事：
//   1. 存梦（dreams/DREAMS.jsonl，一天一条），内容只进提示词、不进长期记忆；
//   2. 把「昨天那个梦」变成一条心境事实（source: 'self'，分量小、早散），于是她会怕、会黏；
//   3. 早上递一句「你昨晚梦见……」——用不用由她。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Appraisal, FeelingKind, Strength } from '../emotion/feelings.ts';

export interface Dream {
    /** 哪一晚（起床那天） */
    date: string;
    /** 3–5 句，像一团糊起来的记忆 */
    dream: string;
    /** 梦留下的情绪：种类 + 分量（1 小事、2 一般、3 很重） */
    feel?: { kind: FeelingKind; strength: Strength; why?: string };
    /** 写下来的时刻（毫秒） */
    at: number;
}

export const DREAMS_DIR = 'dreams';
const FILE = 'DREAMS.jsonl';

const dirPath = (dataDir: string) => join(dataDir, DREAMS_DIR);
const filePath = (dataDir: string) => join(dirPath(dataDir), FILE);

export function readDreams(dataDir: string): Dream[] {
    try {
        const path = filePath(dataDir);
        if (!existsSync(path)) return [];
        return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
            try {
                const parsed = JSON.parse(line) as Dream;
                return typeof parsed.dream === 'string' && parsed.dream.trim() ? [parsed] : [];
            } catch { return []; }
        });
    } catch { return []; }
}

export function appendDream(dataDir: string, dream: Dream): void {
    mkdirSync(dirPath(dataDir), { recursive: true });
    appendFileSync(filePath(dataDir), JSON.stringify(dream) + '\n');
}

/** 这一晚做过梦没有（同一天只做一次） */
export function hasDream(date: string, dataDir: string): boolean {
    return readDreams(dataDir).some(item => item.date === date);
}

/** 「该做梦了」的时段：她在睡觉（作息里睡下的那几个小时），本地时间 */
export function inSleepHours(hour: number): boolean {
    return hour >= 23 || hour < 7;
}

/** 昨晚那个梦（起床后的 14 小时内还算「昨晚的」） */
export function lastNightDream(dataDir: string, now: number, windowMs = 14 * 3_600_000): Dream | undefined {
    const dreams = readDreams(dataDir);
    const latest = dreams.reverse().find(item => now - item.at <= windowMs && now >= item.at);
    return latest;
}

/**
 * 「昨晚的梦」→ 一条心境事实。分量故意小：最低 2（1.5，“明显”里最轻的一档）——梦不能压过真事，
 * 但会让她早上黏一点、问一句「你会走吗」。半衰期 6 小时，中午就淡了。
 */
export function dreamAppraisals(dataDir: string, now: number): Appraisal[] {
    const dream = lastNightDream(dataDir, now);
    if (!dream?.feel) return [];
    const fixed: FeelingKind[] = ['joy', 'relief', 'worry', 'sad', 'annoyed', 'tired'];
    const kind = fixed.includes(dream.feel.kind) ? dream.feel.kind : 'worry';
    // 1 等于「刚能察觉」——那种分量根本写不进提示词，梦就白做了；所以最低也给 2（明显但不大）
    const strength = dream.feel.strength === 3 ? 3 : 2;
    return [{
        id: `dream:${dream.date}`,
        at: dream.at,
        kind,
        strength,
        cause: dream.feel.why?.trim() || `昨晚梦见${dream.dream.slice(0, 24)}，醒来还留着点味道`,
        source: 'self',
        halfLifeH: 6,
    } satisfies Appraisal];
}

/** 早上递给她的一行：说这是梦，别当成真事；提不提由她 */
export function dreamNoteLine(dream: Dream | undefined): string | undefined {
    if (!dream) return undefined;
    const feel = dream.feel ? `（醒来心里${dream.feel.kind === 'joy' ? '挺松的' : dream.feel.kind === 'relief' ? '松了口' : dream.feel.kind === 'sad' ? '有点闷' : dream.feel.kind === 'annoyed' ? '有点烦' : dream.feel.kind === 'tired' ? '很累' : '有点慌'}）` : '';
    return `[你昨晚做了个梦：${dream.dream.slice(0, 200)}${feel}。那是梦，不是真的事；想跟他说就提一句，不想说就搁着]`;
}

/** 做梦的提示词：素材只取她当天真实有的东西 */
export function dreamPrompt(materials: { events: readonly string[]; feelings: readonly string[]; journal: string; name: string }): { system: string; user: string } {
    return {
        system: `你是${materials.name}，刚睡下，正在做梦。用你自己的第一人称写一段梦：3–5 句，短句，有画面，允许荒诞（猫说话、教室变成海、人突然换了脸），但情绪要真——梦里怕的就是真怕的。

不要写"这梦说明什么"，不要解释，不要总结。梦可以出现他，可以出现你们吵架、他走了、他不理你——真人会做这种梦。

只输出 JSON：{"dream":"梦（3-5 句）","feel":{"kind":"worry|sad|joy|relief|annoyed|tired","strength":1,"why":"一句为什么"}}`,
        user: [
            `今天发生的（你自己的）：${materials.events.slice(0, 8).join('；') || '（没什么特别的）'}`,
            `今天的心境：${materials.feelings.join('；') || '（平平的）'}`,
            `今天日记里写的：${materials.journal.slice(0, 200) || '（没写）'}`,
            '写这个梦。',
        ].join('\n'),
    };
}
