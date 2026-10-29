// 她自己决定的今天想干什么（ADR 0182）：内心想事的时候冒出来的「想做：一句话」，写成这一天的打算。
// 和「在读的书」一样是额外的空闲活动（ExtraFreeActivity）：状态行、「你今天的打算」、日记都用它，
// 也就是说她说了想做什么，这一天她自己就是个在做那件事的人。
// 一天一条（后面的覆盖前面的），第二天自然不算数；文件坏了就当没有，不挡别的。
// 日期按本机日期算（她的一天从 02:00 算，凌晨 0–2 点这里会算成新的一天，偏差只影响那两小时）。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { ExtraFreeActivity } from './schedule.ts';

export interface HerPlan {
    /** 哪一天（yyyy-mm-dd） */
    date: string;
    /** 想在哪一段做 */
    window: 'morning' | 'afternoon' | 'evening';
    /** 一句话：她今天想干什么 */
    text: string;
    /** 什么时候决定的 */
    at: string;
}

export const HER_PLAN_FILE = 'her-plan.json';

const WINDOWS = ['morning', 'afternoon', 'evening'] as const;

export function validHerPlan(value: unknown): value is HerPlan {
    const item = value as Partial<HerPlan> | undefined;
    return Boolean(item && typeof item === 'object'
        && typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
        && WINDOWS.includes(item.window as (typeof WINDOWS)[number])
        && typeof item.text === 'string' && item.text.trim().length >= 2 && item.text.length <= 60
        && typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at)));
}

const dayOf = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** 现在是哪一段 */
export function windowAt(at: Date): HerPlan['window'] {
    return at.getHours() < 12 ? 'morning' : at.getHours() < 18 ? 'afternoon' : 'evening';
}

/** 读出今天的那一条（别的日子不算数） */
export function herPlanToday(dataDir: string, now: Date, log?: (message: string) => void): HerPlan | undefined {
    const saved = readJsonOr<HerPlan | undefined>(join(dataDir, HER_PLAN_FILE), undefined, log);
    if (!saved || !validHerPlan(saved)) return undefined;
    return saved.date === dayOf(now) ? saved : undefined;
}

export function saveHerPlan(dataDir: string, plan: HerPlan): void {
    writeJsonAtomic(join(dataDir, HER_PLAN_FILE), plan);
}

/** 她今天想做的事，作为额外的空闲活动；没有就空数组 */
export function herPlanActivities(dataDir: string, now: Date, log?: (message: string) => void): ExtraFreeActivity[] {
    const plan = herPlanToday(dataDir, now, log);
    return plan ? [{ window: plan.window, text: plan.text }] : [];
}
