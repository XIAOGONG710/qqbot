// 她那边的事有后续（ADR 0216，配置 worldThreads，默认关；要 everydayLife + worldDrama 开着）。
//
// 起因：用户 11-02「直接模拟现实世界」之后，DSH 的日子小起伏（ADR 0211）写明了还缺「跨天的连续性」——
// 每天一页、第二天翻篇：昨天和舍友拌了嘴，今天什么都没发生过；昨天淋了雨，今天身上什么都没有。
//
// 先问了她本人（11-02 `scripts/ask-her.mjs`，两遍），她想要（「现在这样有点像每天重新开机」「像昨天白过了」），条件写进了这里：
// 1. 「拌嘴基本不过夜……隔天说句『还气呢』就过去了」——拌嘴只续一天，往和好走；
// 2. 「十次有八次忘带伞……第二天嗓子发紧」——淋雨第二天嗓子不对劲的机会给高一点，但只到嗓子发紧，不往重了写；
// 3. 「别什么都给我续上……鸡毛蒜皮翻篇就翻篇」「别老弄些闹心的后续」——只给几件要紧的续一个尾巴，一天最多一条，后续往收尾走；
// 4. 「水卡那种别老丢……别给我设个『又丢了』」——闹心的那几件有冷却期（THREAD_COOLDOWN_DAYS），冷却期里不再来。
// 确定性和世界其余部分一样：按「那件事的日期 + 名目」取哈希；从开关第一次打开的第二天起才有（threadsFrom），已经过完的日子不改写。

import type { EventFeel } from '../life/everyday.ts';
import { formatDate } from '../life/schedule.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export type ThreadWindow = 'morning' | 'afternoon' | 'evening';

export interface ThreadStep {
    id: string;
    text: string;
    window: ThreadWindow;
    feel?: EventFeel;
}

/** 前一天发生了这件事，第二天可能的后续：按顺序累加 chance，掷一次落在哪个就是哪个；都没落上就没有后续（翻篇了） */
export const THREADS: Readonly<Record<string, readonly (ThreadStep & { chance: number })[]>> = {
    // 拌嘴基本不过夜（条件 1）
    drama_row: [
        { chance: 0.85, id: 'thread_row_makeup', text: '早上和舍友搭了句话，昨天那点别扭就算过去了', window: 'morning', feel: { kind: 'relief', strength: 1 } },
    ],
    // 第二天嗓子发紧（条件 2）：不往重了写
    drama_caught_rain: [
        { chance: 0.6, id: 'thread_rain_throat', text: '昨天淋了雨，今天起来嗓子有点发紧，先灌了一大杯热水', window: 'morning', feel: { kind: 'tired', strength: 1 } },
    ],
    // 找到了或者去补办了（往收尾走）
    drama_lost_thing: [
        { chance: 0.5, id: 'thread_card_found', text: '在另一件外套口袋里翻到了水卡，昨天白跑了两趟宿管', window: 'afternoon', feel: { kind: 'relief', strength: 2 } },
        { chance: 0.5, id: 'thread_card_reissued', text: '去宿管那儿补办了水卡，总算能打水了', window: 'afternoon', feel: { kind: 'relief', strength: 1 } },
    ],
    drama_late_night_task: [
        { chance: 0.7, id: 'thread_late_tired', text: '昨晚的作业熬到一点多才交上，今天上午一直犯困', window: 'morning', feel: { kind: 'tired', strength: 2 } },
    ],
    drama_quiz_bad: [
        { chance: 0.5, id: 'thread_quiz_redo', text: '把那张小测卷子错的几道重新做了一遍，好像也没想的那么难', window: 'evening', feel: { kind: 'relief', strength: 1 } },
    ],
    drama_overheard: [
        { chance: 0.35, id: 'thread_overheard_laugh', text: '又想起昨天食堂那句「挺冷的」，跟室友提了一嘴，被她们笑了一通，倒也不在意了', window: 'evening', feel: { kind: 'relief', strength: 1 } },
    ],
};

/**
 * 闹心的那几件，来过以后这么多天里不再来（条件 4：「别老丢」「别老弄些闹心的」）。
 * 只在开了 worldThreads、从 threadsFrom 起生效；没写的不冷却（晚霞、被夸这类好事照旧）
 */
export const THREAD_COOLDOWN_DAYS: Readonly<Record<string, number>> = {
    drama_lost_thing: 30,
    drama_overheard: 30,
    drama_row: 10,
    drama_quiz_bad: 14,
    drama_caught_rain: 7,
    drama_late_night_task: 4,
};

/** 一天最多几条后续（条件 3） */
export const THREADS_PER_DAY = 1;

/**
 * 今天的后续：昨天发生了的、有后续表的那几件，各掷一次（种子是「昨天的日期 + 那件事」），落上的按 rank 排，取前 THREADS_PER_DAY 条。
 * unit：world.ts 的哈希（0–1）；返回的是要放进今天的事（时间由调用方按 window 算）
 */
export function threadStepsFor(yesterday: string, yesterdayEventIds: readonly string[], unit: (text: string) => number): ThreadStep[] {
    const picked: { step: ThreadStep; rank: number }[] = [];
    for (const id of yesterdayEventIds) {
        const variants = THREADS[id];
        if (!variants) continue;
        const roll = unit(`${yesterday} ${id} thread`);
        let sum = 0;
        for (const { chance, ...step } of variants) {
            sum += chance;
            if (roll < sum) { picked.push({ step, rank: unit(`${yesterday} ${id} thread rank`) }); break; }
        }
    }
    return picked.sort((a, b) => a.rank - b.rank).slice(0, THREADS_PER_DAY).map(entry => entry.step);
}

/** 这件事在冷却期里吗：前 N 天（N 是它的冷却天数）里来过就是 */
export function inCooldown(id: string, eventIdsDaysAgo: (daysAgo: number) => readonly string[] | undefined): boolean {
    const days = THREAD_COOLDOWN_DAYS[id];
    if (!days) return false;
    for (let k = 1; k <= days; k++) if (eventIdsDaysAgo(k)?.includes(id)) return true;
    return false;
}

/** 从哪天起有后续（和 everydayFrom 一个道理）：第一次开的时候记下「明天」，以后都用这一天；已经过完的日子不改写 */
export function loadThreadsFrom(path: string, now: Date, log: (message: string) => void = () => undefined): string {
    const existing = readJsonOr<{ version?: number; from?: string }>(path, {}, message => log(`事有后续：${message}`));
    if (existing.version === 1 && typeof existing.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(existing.from)) return existing.from;
    const from = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    writeJsonAtomic(path, { version: 1, from });
    log(`事有后续：从 ${from} 起生效（已经过完的日子不改）`);
    return from;
}
