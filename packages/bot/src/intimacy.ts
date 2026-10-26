// 他发「/亲热」（ADR 0170）：接下来 10 条回复临时黏一点。
// 存 <dataDir>/intimacy.json（按 QQ 分开）；每生成一条回复取一次、减一，取到 0 就没了。
// 只影响男朋友档（调用方只在那一档接上），只在“回他”的回合生效，主动找他的那条不消耗。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

/** 一次 /亲热 管多少条回复 */
export const INTIMATE_REPLIES = 10;

interface IntimacyState {
    /** QQ → 还剩几条 */
    [qq: string]: { remaining: number; armedAt: string } | undefined;
}

const path = (dataDir: string): string => join(dataDir, 'intimacy.json');

function load(dataDir: string): IntimacyState {
    const stored = readJsonOr<IntimacyState>(path(dataDir), {});
    return stored && typeof stored === 'object' ? stored : {};
}

/** 开一次「亲热」：接下来 count 条回复（默认 10） */
export function armIntimate(dataDir: string, qq: number, count = INTIMATE_REPLIES): void {
    const state = load(dataDir);
    state[String(qq)] = { remaining: Math.max(0, Math.floor(count)), armedAt: new Date().toISOString() };
    writeJsonAtomic(path(dataDir), state);
}

/** 还剩几条（不改状态；面板 / 日志用） */
export function intimateRemaining(dataDir: string, qq: number): number {
    return load(dataDir)[String(qq)]?.remaining ?? 0;
}

/**
 * 这一轮用一条：还有就返回提示词里的那行（并减一），没有就返回 undefined。
 * 只在“回他”的回合调用；调用方保证同一轮只调一次。
 */
export function takeIntimateLine(dataDir: string, qq: number): string | undefined {
    const state = load(dataDir);
    const entry = state[String(qq)];
    if (!entry || entry.remaining <= 0) return undefined;
    entry.remaining -= 1;
    if (entry.remaining <= 0) delete state[String(qq)];
    writeJsonAtomic(path(dataDir), state);
    return '[他刚让你亲热一点：接下来这几条，说话软一点，主动要抱抱、亲一下、说想他都可以；只限这几条，别腻到不像你，也别每条都撒娇]';
}
