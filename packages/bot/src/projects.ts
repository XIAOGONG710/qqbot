// 长期项目的最小事实投影（ADR 0044）：项目进展只从已经落账的类型化行动派生，
// 不另存一个会和事件账漂移的“进度数字”。批次 B 再补期限、资源、阻碍和暂停条件。

import type { LifeEvent } from './life-events.ts';

export const PHOTOGRAPHY_PROJECT_ID = 'photography_growth';

export interface ProjectActivity {
    id: typeof PHOTOGRAPHY_PROJECT_ID;
    title: '摄影成长';
    step: string;
}

export interface ProjectProgress {
    id: typeof PHOTOGRAPHY_PROJECT_ID;
    title: '摄影成长';
    sessions: number;
    minutes: number;
    lastAt?: string;
    recentSteps: string[];
}

/**
 * 现有作息里真正服务于摄影成长的活动；普通刷手机、打游戏仍是 leisure。
 * 「刷摄影区」也是 leisure（10-09 Claude 改）：刷着看别人的片子是休闲，修片、出去拍才算在练；算成进展会把她的进度吹大。
 */
export function projectActivity(text: string): ProjectActivity | undefined {
    const step = text.trim();
    if (!/修.*片|摄影/.test(step) || /刷/.test(step)) return undefined;
    return { id: PHOTOGRAPHY_PROJECT_ID, title: '摄影成长', step };
}

/** 成功或做到一半被硬事件打断的时间都算真实投入；失败候选不算。 */
export function photographyProgress(events: readonly LifeEvent[]): ProjectProgress {
    const work = events.filter(event => event.kind === 'work_on_project' && event.target === PHOTOGRAPHY_PROJECT_ID && event.result !== 'failed');
    const minutes = work.reduce((sum, event) => sum + Math.max(0, Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 60_000)), 0);
    const recentSteps = [...new Set(work.map(event => event.subject).filter((step): step is string => Boolean(step)))].slice(-3);
    return {
        id: PHOTOGRAPHY_PROJECT_ID,
        title: '摄影成长',
        sessions: work.length,
        minutes,
        ...(work.length ? { lastAt: work.at(-1)!.endedAt } : {}),
        recentSteps,
    };
}
