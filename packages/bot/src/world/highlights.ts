import { herDay, type Schedule } from '../life/schedule.ts';
import { localDate } from '../local-date.ts';
import type { WorldNow } from './world.ts';

export interface WorldHighlight {
    at: string;
    text: string;
}

/** 这两天里的一件：yesterday 为真是她的昨天（按她的一天，02:00 之前算前一天），否则是今天 */
export interface DayHighlight extends WorldHighlight {
    yesterday: boolean;
}

type Kind = 'event' | 'cat' | 'meal' | 'parcel' | 'homework';

interface Candidate {
    at: Date;
    text: string;
    kind: Kind;
    /** 作业的课名：和今天 world 行里的作业对重叠用 */
    course?: string;
}

const MEAL_LABEL = { lunch: '午饭', dinner: '晚饭' } as const;

/** 世界账里到 now 为止已经发生的事实（没排序、没去重）；未来的、没有时刻的都不收 */
function candidatesOf(world: WorldNow, now: Date): Candidate[] {
    const candidates: Candidate[] = [];
    const add = (at: Date, text: string, kind: Kind, course?: string) => {
        if (!Number.isFinite(at.getTime()) || at > now || !text.trim()) return;
        candidates.push({ at, text: text.trim(), kind, ...(course !== undefined ? { course } : {}) });
    };

    for (const event of world.events ?? []) add(event.at, event.text, 'event');

    const cat = world.cat;
    if (cat && 'fed' in cat.today) {
        const ending = cat.today.seen === true ? '，也见到它了' : cat.today.seen === false ? '，但没见到它' : '';
        add(cat.today.fed, `喂过${cat.name}${ending}`, 'cat');
    }

    for (const meal of world.routine?.meals ?? []) {
        if (meal.dish) add(meal.end, `${MEAL_LABEL[meal.kind]}吃了${meal.dish}`, 'meal');
    }
    for (const parcel of world.parcels ?? []) {
        if (parcel.status === 'picked_today') add(parcel.when, `取了${parcel.item}`, 'parcel');
    }
    for (const homework of world.homework ?? []) {
        if (homework.done) add(homework.doneAt, `${homework.course}作业写完了`, 'homework', homework.course);
    }
    return candidates;
}

/** 新的在前，同一刻按文字排（确定）；同样的文字只留最新的那条 */
function newestUnique<T extends Candidate>(candidates: T[]): T[] {
    const seen = new Set<string>();
    return candidates
        .sort((a, b) => b.at.getTime() - a.at.getTime() || a.text.localeCompare(b.text, 'zh-CN'))
        .filter(candidate => {
            if (seen.has(candidate.text)) return false;
            seen.add(candidate.text);
            return true;
        });
}

/**
 * 把世界账里已经发生的事实压成控制台可读的「今天发生」。
 * 这里只做确定性投影：未来计划、模型猜测和没有时间依据的状态都不展示。
 */
export function worldHighlights(world: WorldNow | undefined, now: Date, limit = 3): WorldHighlight[] {
    if (!world || !Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit <= 0) return [];
    return newestUnique(candidatesOf(world, now))
        .slice(0, limit)
        .map(candidate => ({ at: candidate.at.toISOString(), text: candidate.text }));
}

export interface RecentDayOptions {
    /** 最多几件（默认 2，和原来那一行一样） */
    limit?: number;
    /**
     * 今天的小事（world.events）也放进来。默认不放：同一份提示词里今天的 world 行（describeWorld）
     * 已经把今天到此刻的小事逐条列在「今天的小事」里，再放一遍就是重复，还会把昨天的挤掉。
     * 只有调用处没有今天的 world 行时才开。
     */
    includeToday?: boolean;
}

/**
 * 「你这两天自己在做的」的真实来源（ADR 0347 第 2 层，方案第三节）：共享世界账里这两天已经发生的事。
 * - 昨天：她的昨天（按她的一天）23:30 的世界——和 contact.ts recapOf 取「那一天」同一个时刻——里已经发生、且确实落在昨天的；
 * - 今天：只有 includeToday 时才取，只取 world.events（她那边的小事），到 now 为止。
 * 不放的：
 * - 吃饭、喂猫：天天一样的日常，不是「自己在做的」（和 diaryWorld 一样，ADR 0026：天天一样的不写）；
 *   喂猫另外也已经在今天的 world 行里（「昨天喂过 / 昨天没喂」）；
 * - 昨天写完、今天 world 行还列着的作业（「X 的作业已经写完了（…交）」）；
 * - 今天的猫、快递、作业、吃的：world 行都有。
 * 新的在前、同样的文字只留一条、最多 limit 件；只依赖世界账和时刻，同一时刻结果相同。
 * worldAt：调用处的世界账，比如 `time => sharedWorld.at(worldCard.herWorld, schedule, time)`。
 */
export function recentDayHighlights(
    worldAt: (at: Date) => WorldNow | undefined,
    schedule: Schedule,
    now: Date,
    options: RecentDayOptions = {},
): DayHighlight[] {
    const limit = options.limit ?? 2;
    if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit <= 0) return [];
    const today = herDay(schedule, now);
    const yesterday = localDate(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const onDay = (at: Date, day: Date) => herDay(schedule, at).getTime() === day.getTime();
    const current = worldAt(now);
    // 今天 world 行里列着的、已经写完的作业：昨天写完的这些不再放
    const listedDone = new Set((current?.homework ?? []).filter(h => h.done).map(h => h.course));

    const picked: (Candidate & { yesterday: boolean })[] = [];
    const then = localDate(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 30);
    const before = worldAt(then);
    if (before) {
        for (const candidate of candidatesOf(before, then)) {
            if (candidate.kind === 'meal' || candidate.kind === 'cat') continue;
            if (candidate.kind === 'homework' && listedDone.has(candidate.course ?? '')) continue;
            if (!onDay(candidate.at, yesterday)) continue;
            picked.push({ ...candidate, yesterday: true });
        }
    }
    if (options.includeToday && current) {
        for (const candidate of candidatesOf(current, now)) {
            if (candidate.kind !== 'event' || !onDay(candidate.at, today)) continue;
            picked.push({ ...candidate, yesterday: false });
        }
    }
    return newestUnique(picked)
        .slice(0, limit)
        .map(candidate => ({ at: candidate.at.toISOString(), text: candidate.text, yesterday: candidate.yesterday }));
}

/**
 * 提示词里那一行，写法和第 1 层拆掉的那行一样：`[你这两天自己在做的：A；B]`，内容最多 80 字。
 * 昨天的前面写「昨天」：同一份提示词里 world 行说的是今天，不标的话她会把昨天取的快递说成今天的。
 * 没有可写的就不返回。
 */
export function ownDaysLine(items: readonly DayHighlight[]): string | undefined {
    const texts = items.map(item => (item.yesterday ? `昨天${item.text}` : item.text)).filter(text => text.trim());
    if (!texts.length) return undefined;
    return `[你这两天自己在做的：${texts.join('；').slice(0, 80)}]`;
}
