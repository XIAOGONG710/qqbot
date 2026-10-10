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
 * 10-11 买了相机以后（ADR 0053）：「拿新相机去校园里拍」「研究新相机的设置」也算。
 */
export function projectActivity(text: string): ProjectActivity | undefined {
    const step = text.trim();
    if (!/修.*片|摄影|相机|去.*拍/.test(step) || /刷|攒钱/.test(step)) return undefined;
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

/** 最近几天的摄影练习（生活账接进提示词的第一步，配置 lifeInPrompt）：只数已经落账的 */
/** days：这几天里有几天弄过（按开始那天的日历日）；minutes 留着给以后用，不进提示词（账上一段空闲活动占满整个下午 / 晚上，加起来的时长夸张） */
export interface RecentPractice { sessions: number; days: number; minutes: number; steps: string[]; last: Date }

export function recentPhotography(events: readonly LifeEvent[], now: Date, days = 3): RecentPractice | undefined {
    const from = now.getTime() - days * 86_400_000;
    const work = events
        .filter(event => event.kind === 'work_on_project' && event.target === PHOTOGRAPHY_PROJECT_ID && event.result !== 'failed')
        .filter(event => Date.parse(event.endedAt) <= now.getTime() && Date.parse(event.endedAt) > from)
        .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    if (!work.length) return undefined;
    const minutes = work.reduce((sum, event) => sum + Math.max(0, Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 60_000)), 0);
    const steps = [...new Set(work.map(event => event.subject).filter((step): step is string => Boolean(step)))].slice(-3);
    const dayKeys = new Set(work.map(event => { const d = new Date(event.startedAt); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }));
    return { sessions: work.length, days: dayKeys.size, minutes, steps, last: new Date(work.at(-1)!.endedAt) };
}

/**
 * 时间块里的一行：只写账上的事实和来源，不写台词（ADR 0021 决策 3）；没练就不写这一行。
 * 「上一回」按她的作息说今天 / 昨天 / 前天，再往前写几号
 */
export function describeRecentPhotography(practice: RecentPractice, now: Date, days = 3): string {
    // 按天说，不报总时长：账上一段空闲活动占满整个下午或晚上，加起来是「3 天 17 个半小时」，真人不这么算，她会跟着说夸张（10-10 场景 life-in-prompt）
    const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const ago = Math.round((dayOf(now) - dayOf(practice.last)) / 86_400_000);
    const part = practice.last.getHours() < 12 ? '上午' : practice.last.getHours() < 18 ? '下午' : '晚上';
    const when = ago === 0 ? `今天${part}` : ago === 1 ? `昨天${part}` : ago === 2 ? `前天${part}` : `${practice.last.getMonth() + 1} 月 ${practice.last.getDate()} 日`;
    return `[你这几天拍照修图（你自己过的日子，账上记着的；用不用、怎么说你自己定，没写的别编）：${days} 天里有 ${practice.days} 天在弄（${practice.steps.join('、')}）；上一回是${when}]`;
}
