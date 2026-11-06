// 作息（ADR 0007 决策 1、ADR 0010）：source/schedule.yml → 每一档角色卡的 extensions.qqbot.schedule。
// 运行时按它算她现在在干什么、什么时候看到消息（packages/bot/src/schedule.ts）。
// 按档位裁剪：课名、教室、课型名只给 course_detail 里的档位；空闲活动可以只给部分档位；地点和「他在哪」按档位写不同说法。

import type { ByTier, ScheduleSource } from './source.ts';
import type { CardSchedule, CourseKind } from './st-format.ts';

const KINDS: CourseKind[] = ['hard', 'machine', 'water', 'pe'];

/** 按档位写的说法里，这一档用哪句；每个档位恰好出现一次（checkScheduleTiers 保证） */
function forTier(list: ByTier[], tier: string): string {
    return list.find(item => item.tiers.includes(tier))!.text;
}

/** 看不到的空闲活动没写 cover 时的说法（ADR 0034） */
const FREE_COVER = '窝着刷手机';

/** 作息里引用的档位都要存在；按档位写的说法每个档位恰好一句 */
export function checkScheduleTiers(schedule: ScheduleSource, tierNames: string[]): void {
    const known = (tiers: string[], at: string) => {
        for (const name of tiers) if (!tierNames.includes(name)) throw new Error(`schedule.yml ${at}：没有档位 ${name}`);
    };
    const coverage = (list: ByTier[], at: string) => {
        const seen = new Set<string>();
        for (const item of list) {
            known(item.tiers, at);
            for (const name of item.tiers) {
                if (seen.has(name)) throw new Error(`schedule.yml ${at}：档位 ${name} 出现了两次`);
                seen.add(name);
            }
        }
        const missing = tierNames.filter(name => !seen.has(name));
        if (missing.length) throw new Error(`schedule.yml ${at}：缺少档位 ${missing.join('、')}`);
    };
    known(schedule.course_detail.tiers, 'course_detail');
    if (schedule.partner) known(schedule.partner.tiers, 'partner');
    coverage(schedule.where.by_tier, 'where');
    schedule.holidays.forEach((h, i) => { if (h.where) coverage(h.where, `holidays[${i}]（${h.name}）.where`); });
    schedule.free.forEach((f, i) => { if (f.tiers) known(f.tiers, `free[${i}]（${f.text}）`); });
}

/** 一个档位的作息 */
export function scheduleForTier(schedule: ScheduleSource, tier: string): CardSchedule {
    const periods = Object.fromEntries(Object.entries(schedule.periods).map(([slot, range]) => {
        const [start = '', end = ''] = range.split('-');
        return [slot, { start, end }];
    }));
    // 有早课的日子早起：第一节课
    const firstSlot = Object.entries(periods).sort(([, a], [, b]) => a.start.localeCompare(b.start))[0]?.[0];
    if (!firstSlot) throw new Error('schedule.yml 的 periods 是空的');

    const partnerTiers = new Set(schedule.partner?.tiers ?? []);
    const holidays = schedule.holidays.map(h => ({
        name: h.name,
        start: h.start,
        end: h.end,
        ...(h.where ? { where: forTier(h.where, tier) } : {}),
        ...(h.home ? { home: true } : {}),
        ...(h.partner && partnerTiers.has(tier) ? { partner: h.partner } : {}),
        ...(h.partner_back && partnerTiers.has(tier) ? { partnerBack: h.partner_back } : {}),
    }));

    const makeups = schedule.makeups.map(m => ({ date: m.date, asDay: m.as_day }));

    const detail = schedule.course_detail.tiers.includes(tier);
    const courses = schedule.courses.map(c => {
        const practice = c.practice === undefined ? undefined : {
            fromWeek: c.practice,
            ...(detail ? { room: c.practice_room! } : {}),
        };
        return {
            day: c.day,
            slot: c.slot,
            weeks: c.weeks,
            kind: c.kind,
            ...(c.course_group !== undefined ? { groupId: c.course_group } : {}),
            ...(detail ? { name: c.name, room: c.room } : {}),
            // 小测要写课名，只给看得到课名的档位
            ...(detail && c.quiz ? { quiz: c.quiz } : {}),
            ...(practice ? { practice } : {}),
        };
    });

    const free = { morning: [] as string[], afternoon: [] as string[], evening: [] as string[] };
    const later: { window: 'morning' | 'afternoon' | 'evening'; text: string; from: string; until?: string }[] = [];
    const home = { morning: [] as string[], afternoon: [] as string[], evening: [] as string[] };
    // 看不到的那条换成 cover，不删（ADR 0034）：空闲活动按「日期 + 时段」哈希挑格子，各档列表一样长才挑到同一件事
    // 有 from 的从那天起才进抽签列表（ADR 0053 之后），之前的日子抽到的不变
    for (const item of schedule.free) {
        const text = !item.tiers || item.tiers.includes(tier) ? item.text : item.cover ?? FREE_COVER;
        if (item.home) home[item.window].push(text);
        else if (item.from) later.push({ window: item.window, text, from: item.from, ...(item.until ? { until: item.until } : {}) });
        else free[item.window].push(text);
    }

    const kinds = Object.fromEntries(KINDS.map(kind => {
        const { label, see_after: seeAfterMin, max_bubbles: maxBubbles } = schedule.kinds[kind];
        return [kind, { ...(detail ? { label } : {}), ...(seeAfterMin ? { seeAfterMin } : {}), ...(maxBubbles ? { maxBubbles } : {}) }];
    })) as CardSchedule['kinds'];

    return {
        sleep: schedule.sleep,
        wake: {
            early: schedule.wakeup.early, lazy: schedule.wakeup.lazy, earlySlot: firstSlot,
            ...(schedule.wakeup.jitter ? { jitter: { from: schedule.wakeup.jitter.from, spreadMin: schedule.wakeup.jitter.spread_minutes, weekendMin: schedule.wakeup.jitter.weekend_minutes } } : {}),
        },
        periods,
        semester: { start: schedule.semester.start, weeks: schedule.semester.weeks },
        holidays,
        makeups,
        kinds,
        courses,
        // 空闲时段的分界：上午到 12:00，下午到 18:00，晚上到睡觉
        free: { ...free, afternoonFrom: '12:00', eveningFrom: '18:00', ...(later.length ? { later } : {}), ...(home.morning.length + home.afternoon.length + home.evening.length ? { home } : {}) },
        where: forTier(schedule.where.by_tier, tier),
        ...(schedule.partner && partnerTiers.has(tier) ? { partner: schedule.partner.text } : {}),
    };
}
