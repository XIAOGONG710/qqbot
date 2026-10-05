// 待跟进的事（ADR 0011 第 9 节）：他说过的、之后会发生的事（面试、考试……），到时候问一次，问过就忘。
// - 记下：一段聊天结束（安静 45 分钟，和长期记忆写入同一个片段）后，用模型从这一段里抽，输出 JSON；
//   同时把还没问的几件给模型，这一段里他已经说了结果（或者取消了）的标成了结。
// - 问：在那件事的时间过后（上午的事 12:00 后、下午的 18:00 后、写了几点的过 2 小时）；晚上的事、以及第一天没问到的，
//   之后几天并进早安里问。过了那天 FOLLOW_UP_DAYS 天还没问到就忘了。
// - 这里只有纯函数；记录、抽取的时机、问过之后删掉在计划器里（proactive-planner.ts）。

import type { OpenAIMessage } from './prompt.ts';
import type { MacroNames } from './st/macros.ts';

/** 一件待跟进的事 */
export interface FollowUp {
    id: string;
    /** 一句话：「字节的面试」 */
    what: string;
    /** 哪天（YYYY-MM-DD，本地） */
    date: string;
    /** morning 上午、afternoon 下午、evening 晚上，或 HH:MM */
    time: string;
    /** 从哪个聊天片段抽出来的 */
    episode: string;
}

/** 过了那天这么多天还没问到就忘了 */
export const FOLLOW_UP_DAYS = 3;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARTS: Record<string, string> = { morning: '上午', afternoon: '下午', evening: '晚上' };

/** 「上午」「下午」「晚上」「14:00」 */
export function partText(time: string): string {
    return PARTS[time] ?? time;
}

/** 抽取的提示词：系统说明 + 还没问的事和这一段聊天（转写同长期记忆，带日期行） */
export function extractionPrompt(transcript: string, pending: readonly FollowUp[], names: MacroNames): OpenAIMessage[] {
    const { char, user } = names;
    const system = [
        `你在帮一个聊天程序记「待跟进的事」。下面是${char}和${user}的一段 QQ 私聊记录，${char}是 AI 扮演的女大学生，${user}是真人。`,
        `挑出${user}提到的、${user}自己之后要经历、过后值得问一句结果的事：考试、面试、比赛、看病、出行、重要的活动或约会等。`,
        `不要：${char}自己的事；已经发生完的事；吃饭、睡觉、上下班这类日常小事；没说是哪天的事。`,
        '日期按那件事被提到时的日期换算（记录里每天开头有一行日期，「明天」就是那一天加一天），写成 YYYY-MM-DD；',
        'time 写 morning（上午）、afternoon（下午）、evening（晚上）或 HH:MM（说了几点），只说了哪天没说几点就写 afternoon。',
        `另外，「还没问的事」里如果有哪件在这段聊天里${user}已经说了结果、或者说取消了，把它的 id 写进 resolved。`,
        '只输出一个 JSON 对象，不要别的文字，例如：{"add":[{"what":"字节的面试","date":"2026-10-09","time":"14:00"}],"resolved":["f-1"]}',
        '没有就输出 {"add":[],"resolved":[]}。',
    ].join('\n');
    const list = pending.length ? pending.map(f => `- ${f.id}：${f.date} ${partText(f.time)} ${f.what}`).join('\n') : '（没有）';
    return [
        { role: 'system', content: system },
        { role: 'user', content: `还没问的事：\n${list}\n\n聊天记录：\n${transcript}` },
    ];
}

export interface Extracted {
    add: { what: string; date: string; time: string }[];
    resolved: string[];
}

/** 模型的输出 → 结构；不是要的格式就抛错（下次再抽） */
export function parseExtraction(text: string): Extracted {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`待跟进：模型输出里没有 JSON：${text.slice(0, 80)}`);
    const data = JSON.parse(text.slice(start, end + 1)) as { add?: unknown; resolved?: unknown };
    const add = (Array.isArray(data.add) ? data.add : []).flatMap(item => {
        const o = item as Record<string, unknown>;
        const what = typeof o.what === 'string' ? o.what.trim() : '';
        const date = typeof o.date === 'string' ? o.date.trim() : '';
        let time = typeof o.time === 'string' ? o.time.trim() : 'afternoon';
        if (!(time in PARTS) && !TIME.test(time)) time = 'afternoon';
        // 说不出哪天的不记
        return what && DATE.test(date) ? [{ what: what.slice(0, 40), date, time }] : [];
    });
    const resolved = (Array.isArray(data.resolved) ? data.resolved : []).filter((id): id is string => typeof id === 'string');
    return { add, resolved };
}

/** 本地的某天 */
export function parseDay(date: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d);
}

/**
 * 第一天什么时候问（毫秒）：上午的事 12:00、下午的 18:00、写了几点的过 2 小时（再加 offset 抖动由调用方给）；
 * 晚上的事返回 undefined：第二天并进早安
 */
export function firstAsk(item: FollowUp): number | undefined {
    const day = parseDay(item.date);
    const at = (h: number, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
    if (item.time === 'morning') return at(12);
    if (item.time === 'afternoon') return at(18);
    if (item.time === 'evening') return undefined;
    const [h, m] = item.time.split(':').map(Number);
    return at(h!, m!) + 2 * 3_600_000;
}

/** 这件事过期了吗：她的这一天已经在那天 FOLLOW_UP_DAYS 天之后 */
export function expired(item: FollowUp, herDay: Date): boolean {
    const last = parseDay(item.date);
    return herDay.getTime() > new Date(last.getFullYear(), last.getMonth(), last.getDate() + FOLLOW_UP_DAYS).getTime();
}

/** 「今天下午」「昨天下午」「10月9日下午」（相对她的某一天） */
export function whenText(item: FollowUp, herDay: Date): string {
    const day = parseDay(item.date);
    const diff = Math.round((herDay.getTime() - day.getTime()) / 86_400_000);
    const dayText = diff === 0 ? '今天' : diff === 1 ? '昨天' : diff === -1 ? '明天' : `${day.getMonth() + 1}月${day.getDate()}日`;
    return `${dayText}${partText(item.time)}`;
}
