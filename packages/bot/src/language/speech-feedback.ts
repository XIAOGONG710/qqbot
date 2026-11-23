// 他一键标「这句像 AI」/「像真人」（ADR 0195，ADR 0190 的第 4 步，随 speechNotes 开关）。
//
// 用户 10-30：要让她「自主地去学习真人怎么说话聊天」。ADR 0193 让她每晚看自己说话的数字和真人的参照；这里补上最直接的一种反馈——
// 他觉得哪句像真人、哪句像 AI。他在 QQ 里打 `/像AI` 或 `/像真人`（可以跟一句理由，≤40 字），就把她**最近那一次说的话**（连着发的几条）
// 连同他前面说的话存下来；每晚想说话习惯的时候她会看到最近几条，**作为他的感受，不是规定**——想不想变、怎么变她自己定。
// 不在代码里按这个反馈改她的话、不设字数；只是让她看见。
//
// 存在 <数据目录>/speech-feedback.json：最多 60 条。这些是他私聊里的话，只进每晚想的那一次提示词，
// 不进聊天时的提示词；她写的笔记仍然不能引他说过的话（ADR 0193 的防线，理由里的话也算他说的）。
//
// 2026-10-31 指令收敛后 `/像AI` `/像真人` 不再执行，11-19 删了走不到的指令分支，11-24 删了只给它们用的
// 解析、取上一轮、写入、回执、/说话习惯 那一行（docs/reports/2026-11-24-dead-code.md）。现在只读：每晚想的时候还会看到 14 天内的旧标记。

import { readJsonOr } from '../memory/json-file.ts';
import { clip, isObject, num } from './speech-notes.ts';
import { join } from 'node:path';

export const SPEECH_FEEDBACK_FILE = 'speech-feedback.json';
export const speechFeedbackPath = (dataDir: string) => join(dataDir, SPEECH_FEEDBACK_FILE);

export type FeedbackLabel = 'human' | 'ai';
export const FEEDBACK_KEEP = 60;
/** 每晚想的时候看最近多少天的、每一类最多几条 */
export const FEEDBACK_WINDOW_MS = 14 * 86_400_000;
export const FEEDBACK_SHOW = 5;
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
