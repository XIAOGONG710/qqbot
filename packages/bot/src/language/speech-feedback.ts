// 他一键标「这句像 AI」/「像真人」（ADR 0195，ADR 0190 的第 4 步，随 speechNotes 开关）。
//
// 用户 10-30：要让她「自主地去学习真人怎么说话聊天」。ADR 0193 让她每晚看自己说话的数字和真人的参照；这里补上最直接的一种反馈——
// 他觉得哪句像真人、哪句像 AI。他在 QQ 里打 `/像AI` 或 `/像真人`（可以跟一句理由，≤40 字），就把她**最近那一次说的话**（连着发的几条）
// 连同他前面说的话存下来；每晚想说话习惯的时候她会看到最近几条，**作为他的感受，不是规定**——想不想变、怎么变她自己定。
// 不在代码里按这个反馈改她的话、不设字数；只是让她看见。
//
// 存在 <数据目录>/speech-feedback.json：最多 60 条；同一次说的话再标一次，后一次覆盖前一次。这些是他私聊里的话，只进每晚想的那一次提示词，
// 不进聊天时的提示词；她写的笔记仍然不能引他说过的话（ADR 0193 的防线，理由里的话也算他说的）。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import { NOT_SPEECH, clip, isObject, num } from './speech-notes.ts';
import { join } from 'node:path';

export const SPEECH_FEEDBACK_FILE = 'speech-feedback.json';
export const speechFeedbackPath = (dataDir: string) => join(dataDir, SPEECH_FEEDBACK_FILE);

export type FeedbackLabel = 'human' | 'ai';
export const FEEDBACK_KEEP = 60;
/** 每晚想的时候看最近多少天的、每一类最多几条 */
export const FEEDBACK_WINDOW_MS = 14 * 86_400_000;
export const FEEDBACK_SHOW = 5;
/** 她最近一次说话离现在超过这么久，就不当成他指的那句 */
export const TURN_MAX_AGE_MS = 12 * 3_600_000;
/** 他说的话最多带几条、她说的话最多存几条、每条最多多少字、理由最多多少字 */
export const HIS_MAX = 3;
export const HERS_MAX = 6;
export const LINE_CHARS = 80;
export const WHY_CHARS = 40;

export interface FeedbackEntry {
    at: number;
    label: FeedbackLabel;
    /** 她这一次说话之前他说的话（最多 3 条，旧到新） */
    his: string[];
    /** 她这一次连着发的几条（旧到新） */
    hers: string[];
    /** 他跟着写的理由（可以没有） */
    why?: string;
}

export interface FeedbackBundle { human: FeedbackEntry[]; ai: FeedbackEntry[] }

/** `/像AI` / `/像ai` / `/像真人`，后面可以跟一句理由；不是这种格式返回 undefined */
export function parseFeedbackCommand(plain: string | undefined): { label: FeedbackLabel; why?: string } | undefined {
    const match = /^\/像(AI|ai|Ai|真人)(?:[\s：:，,]+(.{1,200}))?$/s.exec((plain ?? '').trim());
    if (!match) return undefined;
    const why = clip(match[2], WHY_CHARS);
    return { label: match[1] === '真人' ? 'human' : 'ai', ...(why ? { why } : {}) };
}

/**
 * 她最近一次说话（连着发的几条）和它前面他说的话。他后面又说了还没回的，不算——他标的是她说过的话。
 * 运维写进记录的行（B 站私信、戳一戳……）不算她说话。她最近一次说话在 12 小时以前，就当没有（他大概不是指它）。
 */
export function lastTurn(messages: readonly StoredMessage[], now: number): { his: string[]; hers: string[]; at: number } | undefined {
    let end = messages.length - 1;
    while (end >= 0 && (messages[end]!.role === 'user' || NOT_SPEECH.test(messages[end]!.content))) end--;
    if (end < 0) return undefined;
    let start = end;
    while (start - 1 >= 0 && (messages[start - 1]!.role === 'assistant')) start--;
    const hers = messages.slice(start, end + 1).filter(message => !NOT_SPEECH.test(message.content) && message.content.trim()).map(message => message.content.trim());
    if (!hers.length) return undefined;
    const at = Date.parse(messages[end]!.time);
    if (!Number.isFinite(at) || now - at > TURN_MAX_AGE_MS || at > now + 60_000) return undefined;
    let from = start;
    while (from - 1 >= 0 && messages[from - 1]!.role === 'user') from--;
    const his = messages.slice(from, start).map(message => message.content.trim()).filter(Boolean).slice(-HIS_MAX);
    return { his: his.map(text => clip(text, LINE_CHARS)), hers: hers.slice(-HERS_MAX).map(text => clip(text, LINE_CHARS)), at };
}

export function loadFeedback(dataDir: string): FeedbackEntry[] {
    const raw = readJsonOr<unknown>(speechFeedbackPath(dataDir), {});
    if (!isObject(raw) || !Array.isArray(raw.entries)) return [];
    return raw.entries.flatMap((item): FeedbackEntry[] => {
        if (!isObject(item) || (item.label !== 'human' && item.label !== 'ai') || !Array.isArray(item.hers)) return [];
        const strings = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((text): text is string => typeof text === 'string' && text.trim().length > 0).map(text => clip(text, LINE_CHARS)).slice(-max) : []);
        const hers = strings(item.hers, HERS_MAX);
        if (!hers.length) return [];
        const why = typeof item.why === 'string' ? clip(item.why, WHY_CHARS) : '';
        return [{ at: num(item.at), label: item.label, his: strings(item.his, HIS_MAX), hers, ...(why ? { why } : {}) }];
    }).slice(-FEEDBACK_KEEP);
}

const sameTurn = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((text, i) => text === b[i]);

/** 记一次；同一次说的话已经标过就覆盖（后一次算数）。返回现在一共几条 */
export function recordFeedback(dataDir: string, entry: FeedbackEntry): number {
    const kept = loadFeedback(dataDir).filter(old => !sameTurn(old.hers, entry.hers));
    const next = [...kept, entry].slice(-FEEDBACK_KEEP);
    writeJsonAtomic(speechFeedbackPath(dataDir), { entries: next });
    return next.length;
}

/** 每晚想的时候看的：最近 14 天、每一类最近 5 条（旧到新） */
export function recentFeedback(entries: readonly FeedbackEntry[], now: number): FeedbackBundle {
    const fresh = entries.filter(entry => entry.at >= now - FEEDBACK_WINDOW_MS && entry.at <= now + 60_000);
    const take = (label: FeedbackLabel) => fresh.filter(entry => entry.label === label).slice(-FEEDBACK_SHOW);
    return { human: take('human'), ai: take('ai') };
}

export const feedbackCount = (bundle: FeedbackBundle) => bundle.human.length + bundle.ai.length;

/** 理由里他的话也算他说过的话：交给防照抄的检查 */
export const feedbackWhys = (bundle: FeedbackBundle): string[] => [...bundle.human, ...bundle.ai].flatMap(entry => (entry.why ? [entry.why] : []));

/** 放进每晚想的提示词里的一段；没有就是空串 */
export function feedbackBlock(bundle: FeedbackBundle, user: string): string {
    if (!feedbackCount(bundle)) return '';
    const render = (entry: FeedbackEntry) => `${entry.his.length ? `${user}：${entry.his.join(' / ')}\n` : ''}你：${entry.hers.join(' / ')}${entry.why ? `\n（${user}说：${entry.why}）` : ''}`;
    const part = (title: string, list: readonly FeedbackEntry[]) => (list.length ? `${title}\n${list.map(render).join('\n\n')}` : '');
    return [
        `${user}最近标过的（这是他的感受，不是规定；你想不想变、怎么变你自己定；他的话只让你想起当时的情形，别学他的说法）：`,
        part('他觉得「像真人」的：', bundle.human),
        part('他觉得「这句像 AI」的：', bundle.ai),
    ].filter(Boolean).join('\n\n');
}

/** 命令回给他的话：以「（」开头（运维提示，不进聊天记录） */
export function feedbackReceipt(label: FeedbackLabel, hers: readonly string[], total: number): string {
    const shown = hers.map(text => clip(text, 20)).join(' / ');
    return `（记下了：她刚才的「${shown}」标成「${label === 'human' ? '像真人' : '这句像 AI'}」。每晚她想说话习惯的时候会看到——是你的感受，不是规定，变不变她自己定。现在一共记着 ${total} 条。）`;
}

export const FEEDBACK_NO_TURN = '（她最近 12 小时里没有说过话，没有可标的。）';

export function describeFeedbackForOwner(entries: readonly FeedbackEntry[], now: number): string {
    const fresh = entries.filter(entry => entry.at >= now - FEEDBACK_WINDOW_MS && entry.at <= now + 60_000);
    return `他标过的（最近 14 天）：像真人 ${fresh.filter(entry => entry.label === 'human').length} 次、这句像 AI ${fresh.filter(entry => entry.label === 'ai').length} 次。`;
}
