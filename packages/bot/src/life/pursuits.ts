// 她自己的追求（ADR 0104，配置 pursuits，默认关）。
// 为什么：她现在有的是“事”（摄影成长、课程作业、读书，从生活账里投影出来的进度），没有“她想做成什么”：没有一件事是她为了它会说“等我弄完这张”、会因为它推进了一步开心、
// 几天没碰有点愧疚、隔几周回头看一眼的。ADR 0103 里“别修片了，陪我聊天，现在就陪”她答“来了来了”，就是因为手头那件事对她没有分量。
// 这里**不替她编未来**：内置的两条都是自传里写明的话——「这学期没什么大目标，就想别挂科」「用手机拍了两年，总觉得差点意思，在攒钱买相机」（买到了，下一步是用它拍出满意的东西）。
// 进度只来自她做过的事（生活账里的摄影 work_on_project、出分的小测），不存一个会漂的数字；作者可以在 <数据目录>/pursuits.json 里暂停 / 放下 / 加自己的（不会被代码改）。
// 毕业以后做什么、家里的期待这类悬着的问题**不是追求**，作者没定之前不碰（persona：「毕业打算还没想好，被问就避」）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Appraisal } from '.././emotion/feelings.ts';
import type { LifeEvent } from '.././world/life-events.ts';
import { PHOTOGRAPHY_PROJECT_ID } from './projects.ts';
import { quizReleaseAt, quizScore, quizzesOn } from './everyday.ts';
import { formatDate, type Schedule } from './schedule.ts';
import type { WorldNow } from '.././world/world.ts';

export type PursuitStatus = 'active' | 'paused' | 'dropped' | 'done';

export interface PursuitStep { text: string; /** 作者标的完成时刻（ISO）；内置的两条不用 */ doneAt?: string }

export interface Pursuit {
    id: string;
    title: string;
    /** 她为什么想要（作者的话，方向不是台词） */
    why: string;
    status: PursuitStatus;
    steps?: PursuitStep[];
    /** 内置的（进度从生活账 / 小测里来）还是作者自己加的（进度靠作者标） */
    builtin?: boolean;
}

export const CAMERA_STEPS = ['熟悉新相机的设置', '拍一组土豆', '拍一组校园的秋天', '挑十来张修好', '挑最满意的几张发到空间里'] as const;
/** 买了相机之后她认真弄过几回（生活账里的摄影 work_on_project），第 k 步做完 */
export const CAMERA_THRESHOLDS = [2, 5, 9, 13, 16] as const;
/** 买了相机、有几天没碰，就有点愧疚 */
export const CAMERA_STALL_DAYS = 7;

export const BUILTIN_PURSUITS: readonly Pursuit[] = [
    { id: 'courses', title: '别挂科', why: '这学期没什么大目标，就想别挂科；数学类最怕', status: 'active', builtin: true },
    { id: 'camera', title: '用新相机拍出自己满意的东西', why: '用手机拍了两年总觉得差点意思，攒钱买了相机，想拍出不是手机拍的感觉', status: 'active', builtin: true },
];

// ───────── 作者的文件：<数据目录>/pursuits.json ─────────

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const STATUSES: readonly PursuitStatus[] = ['active', 'paused', 'dropped', 'done'];

export function validPursuit(value: unknown): value is Pursuit {
    return isObject(value) && typeof value.id === 'string' && /^[\w-]{1,40}$/.test(value.id)
        && typeof value.title === 'string' && value.title.trim().length >= 2 && [...value.title].length <= 30
        && typeof value.why === 'string' && [...value.why].length <= 80
        && STATUSES.includes(value.status as PursuitStatus)
        && (value.steps === undefined || (Array.isArray(value.steps) && value.steps.length <= 12
            && value.steps.every(step => isObject(step) && typeof step.text === 'string' && step.text.trim().length >= 2 && [...step.text].length <= 40
                && (step.doneAt === undefined || (typeof step.doneAt === 'string' && !Number.isNaN(Date.parse(step.doneAt)))))));
}

export function validPursuits(value: unknown): value is { pursuits: Pursuit[] } {
    if (!isObject(value) || !Array.isArray(value.pursuits) || !value.pursuits.every(validPursuit)) return false;
    return new Set(value.pursuits.map(item => (item as Pursuit).id)).size === value.pursuits.length;
}

export const PURSUITS_FILE = 'pursuits.json';
export const pursuitsPath = (dataDir: string) => join(dataDir, PURSUITS_FILE);

/** 内置的两条，被作者的文件按 id 改状态 / 文字；作者另加的跟在后面 */
export function mergePursuits(file: readonly Pursuit[]): Pursuit[] {
    const builtin = BUILTIN_PURSUITS.map(base => {
        const override = file.find(item => item.id === base.id);
        return override ? { ...base, ...override, builtin: true as const } : { ...base };
    });
    return [...builtin, ...file.filter(item => !BUILTIN_PURSUITS.some(base => base.id === item.id))];
}

/** 读作者的文件（按修改时间缓存）；不存在 = 只有内置的；读不了 / 不合格 = 当作没有（不挪走作者的文件，同一个错只记一次） */
export function pursuitsReader(dataDir: string, log: (message: string) => void): () => Pursuit[] {
    const path = pursuitsPath(dataDir);
    let cached: { key: string; list: Pursuit[] } | undefined;
    let complained = '';
    return () => {
        try {
            if (!existsSync(path)) return mergePursuits([]);
            const stat = statSync(path);
            const key = `${stat.mtimeMs}:${stat.size}`;
            if (cached?.key === key) return cached.list;
            const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
            if (!validPursuits(parsed)) throw new Error('内容不符合格式（{"pursuits":[{id, title, why, status, steps?}]}）');
            cached = { key, list: mergePursuits(parsed.pursuits) };
            return cached.list;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (complained !== detail) { complained = detail; log(`追求：${PURSUITS_FILE} 读不了（${detail}），只用内置的两条`); }
            return cached?.list ?? mergePursuits([]);
        }
    };
}

// ───────── 进度 ─────────

export interface PursuitFacts {
    now: Date;
    schedule: Schedule;
    /** 生活账（autonomousLife 才有） */
    events?: readonly LifeEvent[];
    world?: WorldNow;
    /** 小测的线开着（everydayLife）：别挂科的进度才有数 */
    quizzes: boolean;
    /** 小测从哪天起才有（everydayFrom）：之前的日子没有小测，不凭空数进去 */
    quizFrom?: string;
}

export interface PursuitView {
    pursuit: Pursuit;
    /** 进提示词的一小段（事实） */
    text: string;
    /** 进心境的评估（做完一步、好几天没碰） */
    appraisals: Appraisal[];
}

const DAY_MS = 86_400_000;
const clockDay = (at: Date, now: Date) => {
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / DAY_MS);
    return days <= 0 ? '今天' : days === 1 ? '昨天' : days === 2 ? '前天' : `${at.getMonth() + 1} 月 ${at.getDate()} 日`;
};

/** 别挂科：这学期到现在出了分的小测（出分 = 小测后两天） */
export function quizRecord(schedule: Schedule, now: Date, from?: string): { course: string; score: number; date: string }[] {
    const out: { course: string; score: number; date: string }[] = [];
    const semesterStart = new Date(`${schedule.semester.start}T00:00:00`);
    const start = from && new Date(`${from}T00:00:00`) > semesterStart ? new Date(`${from}T00:00:00`) : semesterStart;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let day = start; day.getTime() <= today.getTime() - 2 * DAY_MS; day = new Date(day.getTime() + DAY_MS)) {
        for (const quiz of quizzesOn(schedule, day)) {
            if (quizReleaseAt(quiz.course, day) <= now) out.push({ course: quiz.course, score: quizScore(quiz, formatDate(day)), date: formatDate(day) });
        }
    }
    return out;
}

function coursesView(pursuit: Pursuit, facts: PursuitFacts): PursuitView {
    const record = facts.quizzes ? quizRecord(facts.schedule, facts.now, facts.quizFrom) : [];
    const base = `${pursuit.title}——${pursuit.why}`;
    if (!record.length) return { pursuit, text: base, appraisals: [] };
    const low = record.reduce((min, item) => (item.score < min.score ? item : min));
    const mean = Math.round(record.reduce((sum, item) => sum + item.score, 0) / record.length);
    return { pursuit, text: `${base}；这学期到现在出了分的小测 ${record.length} 次，平均 ${mean}，最低 ${low.score}（${low.course}）`, appraisals: [] };
}

/** 买了相机以后她认真弄过几回、做到第几步、上一回是什么时候 */
export function cameraProgress(events: readonly LifeEvent[], boughtAt: Date, now: Date): { sessions: LifeEvent[]; step: number; last?: Date } {
    const sessions = events
        .filter(event => event.kind === 'work_on_project' && event.target === PHOTOGRAPHY_PROJECT_ID && event.result !== 'failed'
            && Date.parse(event.endedAt) >= boughtAt.getTime() && Date.parse(event.endedAt) <= now.getTime())
        .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const step = CAMERA_THRESHOLDS.filter(threshold => sessions.length >= threshold).length;
    return { sessions, step, ...(sessions.length ? { last: new Date(sessions.at(-1)!.endedAt) } : {}) };
}

function cameraView(pursuit: Pursuit, facts: PursuitFacts): PursuitView | undefined {
    const camera = facts.world?.cameraFund?.camera;
    if (camera?.state !== 'bought' || !facts.events) return undefined;
    const { sessions, step, last } = cameraProgress(facts.events, camera.end, facts.now);
    const appraisals: Appraisal[] = CAMERA_THRESHOLDS.flatMap((threshold, index): Appraisal[] => {
        const session = sessions[threshold - 1];
        if (!session) return [];
        return [{
            id: `pursuit:camera:step:${index + 1}`, at: Date.parse(session.endedAt), kind: 'joy', strength: index === CAMERA_THRESHOLDS.length - 1 ? 2 : 1,
            cause: `用新相机把“${CAMERA_STEPS[index]}”这一步做完了`, source: 'world', halfLifeH: 10,
        }];
    });
    const quiet = (last ?? camera.end).getTime();
    if (step < CAMERA_STEPS.length && facts.now.getTime() - quiet >= CAMERA_STALL_DAYS * DAY_MS) {
        appraisals.push({ id: `pursuit:camera:stall:${Math.floor(quiet / DAY_MS)}`, at: quiet + CAMERA_STALL_DAYS * DAY_MS, kind: 'worry', strength: 1, cause: '相机买了有一阵了，好几天没怎么拍', source: 'world', halfLifeH: 24 });
    }
    const now = step >= CAMERA_STEPS.length ? '这几步都做完了' : `现在在第 ${step + 1} 步（${CAMERA_STEPS[step]}）`;
    const done = step ? `，做完的有：${CAMERA_STEPS.slice(0, step).join('、')}` : '';
    const lastText = last ? `买了相机以后认真弄过 ${sessions.length} 回，上一回是${clockDay(last, facts.now)}` : '买了相机还没怎么认真拍过';
    return { pursuit, text: `${pursuit.title}——${pursuit.why}；${now}${done}；${lastText}`, appraisals };
}

function customView(pursuit: Pursuit, now: Date): PursuitView {
    const steps = pursuit.steps ?? [];
    const completed = (step: { doneAt?: string }) => Boolean(step.doneAt && Date.parse(step.doneAt) <= now.getTime());
    const open = steps.findIndex(step => !completed(step));
    const progress = !steps.length ? '' : open < 0 ? '；这几步都做完了' : `；现在在第 ${open + 1} 步（${steps[open]!.text}）${open ? `，做完的有：${steps.slice(0, open).map(step => step.text).join('、')}` : ''}`;
    const appraisals: Appraisal[] = steps.flatMap((step, index): Appraisal[] => (step.doneAt && completed(step)
        ? [{ id: `pursuit:${pursuit.id}:step:${index + 1}`, at: Date.parse(step.doneAt), kind: 'joy', strength: index === steps.length - 1 ? 2 : 1, cause: `“${pursuit.title}”的“${step.text}”做完了`, source: 'author', halfLifeH: 10 }]
        : []));
    return { pursuit, text: `${pursuit.title}${pursuit.why ? `——${pursuit.why}` : ''}${progress}`, appraisals };
}

/** 现在在做的（active）每一条的视图；没条件的（相机还没买）不返回 */
export function pursuitViews(list: readonly Pursuit[], facts: PursuitFacts): PursuitView[] {
    return list.filter(item => item.status === 'active').flatMap((item): PursuitView[] => {
        if (item.id === 'courses' && item.builtin) return [coursesView(item, facts)];
        if (item.id === 'camera' && item.builtin) {
            const view = cameraView(item, facts);
            return view ? [view] : [];
        }
        return [customView(item, facts.now)];
    });
}

/** 时间块里的一段：她自己想做成的事，不是任务；不用主动提，话题碰到或他问起才说 */
export function describePursuits(views: readonly PursuitView[]): string | undefined {
    if (!views.length) return undefined;
    return `[你自己想做成的事（是你的追求，不是任务；不用主动提，话题碰到或他问起才带一句，带点真的感觉；事实以这里写的为准，没写的进展别编）：${views.map((view, index) => `${'①②③④⑤'[index] ?? index + 1}${view.text}`).join('；')}]`;
}
