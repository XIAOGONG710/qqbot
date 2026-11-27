// 她理解人的话（10-30 用户：「让她自己学习去理解人说的话」）。
//
// 信号很明确：他说「不是这个意思」「我说的是」「你理解错了」「我没这么说」——上一轮她接偏了。
// 记下三样：他当时说的、她回的、他纠正的那句。下次他说到同一件事时，把这条递给她：
// 「上次他说的 X，你接成 Y，他纠正说 Z，这次别再那样理解」。
// 纯规则 + 原文，不用模型；只留最近 20 条，30 天外的丢掉；文件坏了当没有。

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { acknowledgementHypotheses, isAmbiguousAcknowledgement, readSharedUnderstandingState, sharedUnderstandingLine, UNDERSTANDING_EXPORT, understandingKey, type SharedUnderstanding } from '../../../../dsh-plugins/dsh-linmengyao-memory/shared-understanding.mjs';

const DECLARED_INTENT = /(?:^|[，。；,;])\s*(?:我)?(?:只是|就是)?(?:想让你先忙|让你安心去忙)(?=$|[，。；,;])/;
const DENIED_ANGER = /(?:^|[，。；,;])\s*(?:我)?(?:没有|没|并没|不是在)生气[。！!]?(?:\s*)$/;
const REFERS_BACK = /昨天|前面那句|我当时|我之前/;
const TWO_DAYS = 2 * 86_400_000;

/** Current scope is a short go-ahead whose tone remains ambiguous until explicitly clarified. */
export function recordUnderstandingTurn(file: string, id: string, text: string, at: number): void {
    if (text.length > 240) return;
    const isAcknowledgement = isAmbiguousAcknowledgement(text);
    if (!isAcknowledgement && (!DECLARED_INTENT.test(text) || !DENIED_ANGER.test(text))) return;
    const { entries, withdrawn } = readSharedUnderstandingState(file, true);
    if (withdrawn.includes(id) || entries.some(item => item.id === id || item.revision?.id === id)) return;
    if (isAcknowledgement) {
        entries.push({ id, at, original: text, status: 'tentative', hypotheses: [...acknowledgementHypotheses] });
    } else {
        const quotes = [...text.matchAll(/[「“]([^」”]+)[」”]/g)].map(match => understandingKey(match[1]!));
        const candidates = entries.filter(item => item.status === 'tentative' && at > item.at && at - item.at <= TWO_DAYS
            && (quotes.length ? quotes.includes(understandingKey(item.original)) : REFERS_BACK.test(text)));
        if (candidates.length !== 1) return;
        const item = candidates[0]!;
        const corrected: SharedUnderstanding = { ...item, status: 'corrected', revision: {
            id, at, evidence: text, interpretation: '他说自己是想让你先忙，当时没有生气',
        } };
        entries[entries.indexOf(item)] = corrected;
    }
    writeJsonAtomic(file, { version: 1, entries: entries.slice(-UNDERSTANDING_KEPT), withdrawn });
}

export function withdrawUnderstandingTurn(file: string, id: string): void {
    const { entries, withdrawn } = readSharedUnderstandingState(file, true);
    if (withdrawn.includes(id) || !entries.some(entry => entry.id === id || entry.revision?.id === id)) return;
    const retained = entries.filter(entry => entry.id !== id).map(({ revision, ...entry }): SharedUnderstanding =>
        revision && revision.id !== id ? { ...entry, status: 'corrected', revision } : { ...entry, status: 'tentative' });
    writeJsonAtomic(file, { version: 1, entries: retained, withdrawn: [...withdrawn, id].slice(-100) });
}

export function sharedUnderstandingHost(soulDir: string, log: (message: string) => void) {
    const file = join(soulDir, UNDERSTANDING_EXPORT);
    const enabled = process.env.QQBOT_SHARED_UNDERSTANDING === '1';
    return {
        read: (text: string, at: number) => enabled ? sharedUnderstandingLine(file, text, at) || undefined : undefined,
        receive: (id: number, text: string, at: number) => {
            if (!enabled) return;
            try { mkdirSync(soulDir, { recursive: true }); recordUnderstandingTurn(file, String(id), text, at); }
            catch { log('共享理解记录未写入，保留原记录'); }
        },
        withdraw: (id: number) => { if (enabled) withdrawUnderstandingTurn(file, String(id)); },
    };
}

export const UNDERSTANDING_FILE = 'understanding.json';
export const UNDERSTANDING_KEPT = 20;
export const UNDERSTANDING_WINDOW_MS = 30 * 86_400_000;
const MAX_TEXT = 120;

export interface Correction {
    /** 他当时说的（被她接偏的那句） */
    his: string;
    /** 她当时的回复（只留一条） */
    her: string;
    /** 他纠正的那句 */
    fix: string;
    /** 他纠正的时刻 */
    at: string;
}

export interface UnderstandingState { corrections: Correction[] }

/** 他这句话是不是在纠正她 */
const CORRECTION = /不是这个意思|不是那个意思|我说的是|我指的是|你理解错|你搞错|我没这么说|我没说这个|别理解成/;

export function isCorrection(text: string): boolean {
    return CORRECTION.test(String(text || ''));
}

/** 用户当场纠正时只给这一轮的回复提示；不添加历史事件，也不推断她为什么接错。 */
export function correctionReplyLine(text: string): string | undefined {
    if (!isCorrection(text)) return undefined;
    return '[他正在纠正你刚才的理解。先就这次回应：把你听懂的具体意思简短复述，并确认是否理解对；如果仍没听清或没看懂，直接请他再说一遍，不要硬猜。若确认刚才确实说错，就承认并修正那一点；不要默认自己一定错，不要把他没告诉过你的事说成你记错了，不要编造误解原因，也不要翻旧账。]';
}

const clip = (text: string) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

export function readUnderstanding(dataDir: string, log?: (message: string) => void): UnderstandingState {
    const saved = readJsonOr<UnderstandingState>(JoinSafe(dataDir), { corrections: [] }, log);
    return saved && Array.isArray(saved.corrections) ? saved : { corrections: [] };
}

const JoinSafe = (dataDir: string) => join(dataDir, UNDERSTANDING_FILE);

/** 记一条；同一句纠正只留最后一次 */
export function recordCorrection(dataDir: string, item: Omit<Correction, 'at'> & { at?: string }, now = Date.now()): void {
    const his = clip(item.his);
    const her = clip(item.her);
    const fix = clip(item.fix);
    if (!fix || (!his && !her)) return;
    const state = readUnderstanding(dataDir);
    const fresh = state.corrections.filter(old => old.fix !== fix);
    fresh.push({ his, her, fix, at: item.at ?? new Date(now).toISOString() });
    writeJsonAtomic(JoinSafe(dataDir), { corrections: fresh.slice(-UNDERSTANDING_KEPT) });
}

/**
 * 这一轮要递给她的一行：他这句话和以前被纠正过的事撞上了（共享至少两个二字词），就把那条提醒给她。
 * 没有撞上、或者那条过期了，就不放——不主动翻旧账。
 */
export function understandingLine(dataDir: string, hisWords: string, now = Date.now()): string | undefined {
    const grams = (text: string) => {
        const clean = String(text || '').replace(/\s+/g, '');
        const set = new Set<string>();
        for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
        return set;
    };
    const q = grams(hisWords);
    if (!q.size) return undefined;
    const hit = readUnderstanding(dataDir).corrections
        .filter(item => now - Date.parse(item.at) < UNDERSTANDING_WINDOW_MS)
        .filter(item => [...grams(item.his)].filter(gram => q.has(gram)).length >= 2)
        .at(-1);
    if (!hit) return undefined;
    return `[这件事你以前理解偏过：他当时说的是「${hit.his}」，你接成了「${hit.her}」，他纠正说「${hit.fix}」。这次先按他的原话理解，别又接成之前那样]`;
}
