// 公共节日（ADR 0076）：她知道今天是平安夜、除夕、情人节——真人的日子是跟着日历走的。
// 卡上的重要日子（生日、纪念日）是她和他自己的；这里是人人都过的那些，按年份换算成公历那一天，当成 ImportantDay 并进卡的 dates：
// 时间块（describeDays）提前几天起「明天是平安夜」，其中一部分到了那天由主动消息（dates 时机）带一句。
// 农历的日子每年落在不同的公历日，所以每条只在换算出的那一年算（ImportantDay.year）。
import { lunarMonthDay, type ImportantDay } from './proactive.ts';

/** off 不加；notes 只在时间块里提；greet 再加上挑出来的几个节日由她主动说一句 */
export const FESTIVAL_MODES = ['off', 'notes', 'greet'] as const;
export type FestivalMode = (typeof FESTIVAL_MODES)[number];

type Rule =
    | { solar: string }
    /** 农历 MM-DD；闰月里不过节 */
    | { lunar: string }
    /** 春节（正月初一）前后几天：除夕 -1、春节 0、元宵 +14 */
    | { spring: number }
    | { term: '清明' | '冬至' };

interface Festival {
    name: string;
    rule: Rule;
    /** 提前几天起时间块里提 */
    ahead: number;
    /** 她会主动提：morning 并进当天的早安，midnight 零点第一个说；不写只在时间块里出现 */
    greet?: 'morning' | 'midnight';
}

/**
 * 按一年里出现的先后排。主动说的只挑情侣之间一定会说一句的：新年两头、除夕、平安夜、元宵、情人节、520、七夕、端午、中秋；
 * 万圣节、双十一、冬至、圣诞、清明、劳动节这些只让她知道今天是什么日子（她要不要提自己定）。
 */
const FESTIVALS: readonly Festival[] = [
    { name: '元旦', rule: { solar: '01-01' }, ahead: 3, greet: 'midnight' },
    { name: '除夕', rule: { spring: -1 }, ahead: 7, greet: 'morning' },
    { name: '春节', rule: { spring: 0 }, ahead: 7, greet: 'midnight' },
    { name: '元宵节', rule: { spring: 14 }, ahead: 2, greet: 'morning' },
    { name: '情人节', rule: { solar: '02-14' }, ahead: 5, greet: 'morning' },
    { name: '妇女节', rule: { solar: '03-08' }, ahead: 1 },
    { name: '清明节', rule: { term: '清明' }, ahead: 1 },
    { name: '劳动节', rule: { solar: '05-01' }, ahead: 2 },
    { name: '520', rule: { solar: '05-20' }, ahead: 3, greet: 'morning' },
    { name: '儿童节', rule: { solar: '06-01' }, ahead: 1 },
    { name: '端午节', rule: { lunar: '05-05' }, ahead: 2, greet: 'morning' },
    { name: '七夕', rule: { lunar: '07-07' }, ahead: 3, greet: 'morning' },
    { name: '中秋节', rule: { lunar: '08-15' }, ahead: 3, greet: 'morning' },
    { name: '万圣节', rule: { solar: '10-31' }, ahead: 2 },
    { name: '双十一', rule: { solar: '11-11' }, ahead: 2 },
    { name: '冬至', rule: { term: '冬至' }, ahead: 1 },
    { name: '平安夜', rule: { solar: '12-24' }, ahead: 3, greet: 'morning' },
    { name: '圣诞节', rule: { solar: '12-25' }, ahead: 1 },
    { name: '跨年夜', rule: { solar: '12-31' }, ahead: 2 },
];

/**
 * 春节（正月初一）的公历日。系统自带的农历（Intl）在新月刚好落在零点前后几分钟的年份会差一天：
 * 2027 年新月在北京时间 2 月 6 日 23:56，Intl 给 2 月 7 日；2030 年新月在 2 月 3 日 06:03，Intl 给 2 月 2 日。
 * 所以近几年按公布的日期写死，表以外的年份才用 Intl（端午、七夕、中秋离新月远，Intl 对得上，测试里逐年核对过）
 */
const SPRING_FESTIVAL: Readonly<Record<number, string>> = {
    2026: '02-17', 2027: '02-06', 2028: '01-26', 2029: '02-13', 2030: '02-03', 2031: '01-23',
};

const pad = (n: number) => String(n).padStart(2, '0');
const monthDay = (date: Date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * 二十四节气里用到的两个（21 世纪的通用公式：[Y×0.2422 + C] − L，Y 是年份后两位）。
 * 清明在 2 月 29 日之后，L = ⌊Y/4⌋，C = 4.81；冬至 C = 21.94，L = ⌊Y/4⌋
 */
export function solarTerm(year: number, term: '清明' | '冬至'): string {
    const y = year % 100;
    const day = Math.floor(y * 0.2422 + (term === '清明' ? 4.81 : 21.94)) - Math.floor(y / 4);
    return term === '清明' ? `04-${pad(day)}` : `12-${pad(day)}`;
}

/** 这一年每个农历日子落在公历的哪一天（MM-DD）；闰月的不算 */
const lunarYears = new Map<number, Map<string, string>>();
function lunarCalendar(year: number): Map<string, string> {
    const cached = lunarYears.get(year);
    if (cached) return cached;
    const days = new Map<string, string>();
    for (let date = new Date(year, 0, 1); date.getFullYear() === year; date = new Date(year, date.getMonth(), date.getDate() + 1)) {
        const lunar = lunarMonthDay(date);
        // 腊月的日子在一个公历年里可能出现两次（年初是上一个农历年的腊月，年末是下一个的头几天）：留下先出现的
        if (lunar && !days.has(lunar)) days.set(lunar, monthDay(date));
    }
    lunarYears.set(year, days);
    return days;
}

/** 这一年里 rule 落在公历哪一天（MM-DD）；落不到就是 undefined */
function dateIn(year: number, rule: Rule, lunarDays: ReadonlyMap<string, string>): string | undefined {
    if ('solar' in rule) return rule.solar;
    if ('term' in rule) return solarTerm(year, rule.term);
    if ('lunar' in rule) return lunarDays.get(rule.lunar);
    const spring = SPRING_FESTIVAL[year] ?? lunarDays.get('01-01');
    if (!spring) return undefined;
    const [month, day] = spring.split('-').map(Number) as [number, number];
    return monthDay(new Date(year, month - 1, day + rule.spring));
}

/** 这些年的公共节日（ImportantDay，带 year，公历那天）。mode 为 off 时没有 */
export function festivalDays(years: readonly number[], mode: FestivalMode): ImportantDay[] {
    if (mode === 'off') return [];
    return years.flatMap(year => {
        const lunarDays = lunarCalendar(year);
        return FESTIVALS.flatMap((festival): ImportantDay[] => {
            const date = dateIn(year, festival.rule, lunarDays);
            if (!date) return [];
            const greet = mode === 'greet' ? festival.greet : undefined;
            return [{
                name: festival.name, date, year, ahead: festival.ahead,
                ...(greet === 'midnight' ? { midnight: true } : {}),
                ...(greet ? {} : { silent: true }),
            }];
        });
    });
}

/** 今年起三年（够一次开着跑很久） */
export function festivalYears(now: Date): number[] {
    return [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() + 2];
}

/** 把公共节日并进一档的重要的日子（读卡时用）；同一个角色对象并两次不会重复（模拟器几次运行共用一张卡） */
export function withFestivals(dates: readonly ImportantDay[], now: Date, mode: FestivalMode): ImportantDay[] {
    const have = new Set(dates.filter(d => d.year !== undefined).map(d => `${d.name}:${d.year}`));
    return [...dates, ...festivalDays(festivalYears(now), mode).filter(d => !have.has(`${d.name}:${d.year}`))];
}
