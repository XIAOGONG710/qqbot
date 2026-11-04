// 长期项目的事实投影（ADR 0044 / 0056）：摄影进展只从已经落账的类型化行动派生；
// B 阶段把课程、摄影和阅读统一成项目组合，仍不另存一个会和事实源漂移的“进度数字”。

import { localDate } from '../local-date.ts';
import { bookProgressAt, type ReadingBook } from './her-days.ts';
import type { LifeEvent } from '.././world/life-events.ts';
import { herDay, type Schedule } from './schedule.ts';
import type { WorldNow } from '.././world/world.ts';

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

export type LongTermProjectKind = 'course' | 'photography' | 'reading';
export type LongTermProjectStatus = 'active' | 'paused' | 'completed';

/**
 * B 阶段的项目事实层。状态只从已有事实源投影：
 * - 课程项目：WorldNow.homework（期限、完成时刻）；
 * - 摄影成长：生活事件账；
 * - 阅读：角色卡里按日期推进的读书进度。
 * 不单独落一个 project-state.json，避免重启或规则调整后和事实账漂移。
 */
export interface LongTermProject {
    id: string;
    kind: LongTermProjectKind;
    title: string;
    status: LongTermProjectStatus;
    progress: string;
    nextStep?: string;
    deadline?: Date;
    resources: string[];
    obstacle?: string;
    /** 只用于项目之间的确定性排序；不进提示词，也不是新的事实。 */
    priority: number;
}

export interface ProjectPortfolioInput {
    events: readonly LifeEvent[];
    world?: WorldNow;
    schedule: Schedule;
    books: readonly ReadingBook[];
    now: Date;
}

export interface ProjectChoice {
    project: LongTermProject;
    /** 状态行和行动账共同使用的自然语言，不各自重新拼一遍。 */
    text: string;
    action: { kind: 'study'; subject: string; target?: string };
    why: string;
    /** 这次项目行动最晚做到什么时候；课程作业用世界里原有的预计写完时刻。 */
    until?: Date;
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
export function photographyProgress(events: readonly LifeEvent[], until?: Date): ProjectProgress {
    const work = events
        .filter(event => event.kind === 'work_on_project' && event.target === PHOTOGRAPHY_PROJECT_ID && event.result !== 'failed'
            && Number.isFinite(Date.parse(event.endedAt)) && Date.parse(event.endedAt) <= (until?.getTime() ?? Infinity))
        .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
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

/**
 * 当前项目组合。只描述已经存在的三个来源，不凭空生成“课程大作业”；
 * 相机基金买完后是世界里的已完成事实，不再作为活跃项目重复出现。
 */
export function projectPortfolio({ events, world, schedule, books, now }: ProjectPortfolioInput): LongTermProject[] {
    const projects: LongTermProject[] = [];

    for (const homework of world?.homework ?? []) {
        const title = `${homework.course || '课程'}作业`;
        const hours = (homework.due.getTime() - now.getTime()) / 3_600_000;
        const status: LongTermProjectStatus = homework.done ? 'completed' : 'active';
        projects.push({
            id: `course:${homework.course || 'unknown'}:${homework.due.toISOString()}`,
            kind: 'course',
            title,
            status,
            progress: homework.done ? `已在 ${clock(homework.doneAt)} 写完` : '还没写完',
            ...(homework.done ? {} : { nextStep: `继续写${title}`, deadline: homework.due }),
            resources: ['课程资料', '电脑'],
            priority: homework.done ? -1 : deadlinePriority(hours),
        });
    }

    const photography = photographyProgress(events, now);
    const camera = world?.cameraFund?.camera;
    const cameraReady = camera?.state === 'bought';
    const recentStep = photography.recentSteps.at(-1);
    const last = photography.lastAt ? new Date(photography.lastAt) : undefined;
    const idleDays = last ? Math.max(0, Math.floor((now.getTime() - last.getTime()) / 86_400_000)) : Infinity;
    projects.push({
        id: photography.id,
        kind: 'photography',
        title: photography.title,
        status: 'active',
        progress: photography.sessions ? `练了 ${photography.sessions} 回${recentStep ? `；最近在${recentStep}` : ''}` : '还没有落账的练习',
        nextStep: cameraReady ? (photography.sessions ? '拿相机出去拍，或者整理最近拍的片子' : '先熟悉新相机的设置') : '继续练拍摄和修片',
        resources: cameraReady ? [camera.what] : ['现有拍摄设备'],
        priority: idleDays >= 3 ? 35 : 25,
    });

    for (const book of books) {
        const progress = bookProgressAt(schedule, book, now);
        const status: LongTermProjectStatus = progress.finished ? 'completed' : progress.stopped ? 'paused' : 'active';
        projects.push({
            id: `reading:${book.id}`,
            kind: 'reading',
            title: `读《${book.title}》`,
            status,
            progress: progress.finished ? `读完了（${progress.amount} ${progress.unit}）` : `读到 ${progress.amount} ${progress.unit}`,
            ...(status === 'active' ? { nextStep: `继续读《${book.title}》` } : {}),
            resources: [book.platform],
            ...(status === 'paused' ? { obstacle: book.progress.state === 'put_down' ? '自己放下了，暂时不继续' : `现有可靠进度只到 ${progress.amount} ${progress.unit}` } : {}),
            priority: status === 'active' ? 20 : -1,
        });
    }

    return projects.sort(compareProjects);
}

/** 活跃项目按确定性优先级排序；期限相同再按 id，重启和重放不会换顺序。 */
export function activeProjects(projects: readonly LongTermProject[]): LongTermProject[] {
    return projects.filter(project => project.status === 'active').sort(compareProjects);
}

/**
 * 当前唯一会主动抢占原空闲安排的项目决策：三天内未完成的课程作业。
 * 摄影和阅读仍只在原作息选到对应活动时推进，避免一个“最高优先级”把整天所有空闲时间吞掉。
 */
export function chooseProject(input: ProjectPortfolioInput): ProjectChoice | undefined {
    const project = activeProjects(projectPortfolio(input))
        .find(candidate => candidate.kind === 'course' && candidate.priority >= 80);
    if (!project) return;
    const homework = input.world?.homework.find(item => !item.done
        && project.id === `course:${item.course || 'unknown'}:${item.due.toISOString()}`);
    return {
        project,
        text: `在赶${project.title}`,
        action: { kind: 'study', subject: project.title },
        why: `${project.title}三天内截止`,
        ...(homework ? { until: homework.doneAt } : {}),
    };
}

function deadlinePriority(hours: number): number {
    if (hours <= 0) return 120;
    if (hours <= 24) return 100;
    if (hours <= 72) return 80;
    return 50;
}

function compareProjects(a: LongTermProject, b: LongTermProject): number {
    return b.priority - a.priority
        || (a.deadline?.getTime() ?? Infinity) - (b.deadline?.getTime() ?? Infinity)
        || a.id.localeCompare(b.id);
}

/** 她的哪一天：给了作息按作息日（02:00 前算前一天），没给按日历日 */
function herDayOf(at: Date, schedule: Schedule | undefined): Date {
    return schedule ? herDay(schedule, at) : localDate(at.getFullYear(), at.getMonth(), at.getDate());
}

function clock(at: Date): string {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** 最近几天的摄影练习（生活账接进提示词的第一步，配置 lifeInPrompt）：只数已经落账的 */
/** days：这几天里有几天弄过（按开始那天；给了作息就按她的作息日，02:00 前算前一天）；minutes 留着给以后用，不进提示词（账上一段空闲活动占满整个下午 / 晚上，加起来的时长夸张） */
export interface RecentPractice { sessions: number; days: number; minutes: number; steps: string[]; last: Date }

export function recentPhotography(events: readonly LifeEvent[], now: Date, days = 3, schedule?: Schedule): RecentPractice | undefined {
    const from = now.getTime() - days * 86_400_000;
    const work = events
        .filter(event => event.kind === 'work_on_project' && event.target === PHOTOGRAPHY_PROJECT_ID && event.result !== 'failed')
        .filter(event => Date.parse(event.endedAt) <= now.getTime() && Date.parse(event.endedAt) > from)
        .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    if (!work.length) return undefined;
    const minutes = work.reduce((sum, event) => sum + Math.max(0, Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 60_000)), 0);
    const steps = [...new Set(work.map(event => event.subject).filter((step): step is string => Boolean(step)))].slice(-3);
    const dayKeys = new Set(work.map(event => { const d = herDayOf(new Date(event.startedAt), schedule); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }));
    return { sessions: work.length, days: dayKeys.size, minutes, steps, last: new Date(work.at(-1)!.endedAt) };
}

/**
 * 时间块里的一行：只写账上的事实和来源，不写台词（ADR 0021 决策 3）；没练就不写这一行。
 * 「上一回」按她的作息说今天 / 昨天 / 前天，再往前写几号：给了作息就按她的作息日（10-11 00:07 测试：头天 20:27–22:07 弄的，她还没睡，原来按日历日说成「昨天晚上」）
 */
export function describeRecentPhotography(practice: RecentPractice, now: Date, schedule?: Schedule, days = 3): string {
    // 按天说，不报总时长：账上一段空闲活动占满整个下午或晚上，加起来是「3 天 17 个半小时」，真人不这么算，她会跟着说夸张（10-10 场景 life-in-prompt）
    const dayOf = (d: Date) => herDayOf(d, schedule).getTime();
    // 按这一段的最后一分钟算哪天：10-11 22:00 弄到 02:00 整（正好是她睡觉、作息日换天的时刻），按结束时刻算成第二天，第二天上午说「上一回是今天晚上」（10-12 线上副本试算）
    const lastMoment = new Date(practice.last.getTime() - 60_000);
    const ago = Math.round((dayOf(now) - dayOf(lastMoment)) / 86_400_000);
    const hour = lastMoment.getHours();
    // 零点以后到早上还没睡的那一段是头天的晚上
    const part = hour < 5 || hour >= 18 ? '晚上' : hour < 12 ? '上午' : '下午';
    const date = herDayOf(lastMoment, schedule);
    const when = ago === 0 ? `今天${part}` : ago === 1 ? `昨天${part}` : ago === 2 ? `前天${part}` : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    return `[你这几天拍照修图（你自己过的日子，账上记着的；用不用、怎么说你自己定，没写的别编）：${days} 天里有 ${practice.days} 天在弄（${practice.steps.join('、')}）；上一回是${when}]`;
}
