// 两位闺蜜自己的日子（ADR 0033）：卡上 world.people[].life（source/world.yml 按档位裁剪）→ 某一天她们各自怎么样。
// - 生病几天、忙几天（有考试、赶作业）、回家（济南本地的周末、放假），都按「日期 + 人 + 名目」取哈希，同一天对所有人一样，重启、重放都一样，不存状态。
// - 她们的状态管着和林梦瑶的来往（world.ts 里带 person 的小事看 skip_when / only_when）：苏雨桐感冒那几天不一起吃饭、上课帮她拍板书；
//   陈佳宁有考试那几天微信上不怎么互损。林梦瑶知道这些（同专业天天见、和死党天天微信），所以进「你那边」，问到那天也想得起。
// - 只写事实，不写台词、不写情绪（ADR 0021 决策 3）。

import { formatDate, type Schedule } from '../life/schedule.ts';
import { stateObject } from '../memory/state-schema.ts';

/** 一个人自己的日子怎么推（资料里没写的块就没有） */
export interface NpcLife {
    /** 生病：平均每月几次，每次几天 */
    sick?: { perMonth: number; days: [number, number] };
    /** 忙（有考试、赶作业）：平均每月几次，每次几天；label 按哈希挑一个 */
    busy?: { perMonth: number; days: [number, number]; labels: string[] };
    /** 回家：每个周末回家的概率；holidays：放假都回家（本地人） */
    home?: { weekendChance: number; holidays: boolean };
}

export type NpcStateKind = 'sick' | 'busy' | 'home';

/** 某一天的状态；day / of：第几天、共几天（回家没有） */
export type NpcState =
    | { kind: 'sick'; day: number; of: number }
    | { kind: 'busy'; day: number; of: number; label: string }
    | { kind: 'home' };

/** 往回找一段病、一段忙的起点最多找几天（比资料里最长的一段长就行） */
const MAX_SPAN = 14;
/** 月排程的资源边界：最多 31 个起点；不是把段数解释成每天发病的概率。 */
export const MAX_NPC_MONTHLY_SPANS = 31;

/** 配置加载和直接事实投影共用校验，防止坏次数形成无界循环；持续范围沿用 MAX_SPAN 的既有上限。 */
export function validateNpcLife(value: unknown, fail: (message: string) => never = message => { throw new RangeError(`NPC生活配置${message}`); }): asserts value is NpcLife | undefined {
    if (value === undefined) return;
    if (!stateObject(value)) fail('应为对象');
    for (const kind of ['sick', 'busy'] as const) {
        const span = value[kind];
        if (span === undefined) continue;
        if (!stateObject(span)) fail(`.${kind} 应为对象`);
        if (typeof span.perMonth !== 'number' || !Number.isFinite(span.perMonth) || span.perMonth < 0 || span.perMonth > MAX_NPC_MONTHLY_SPANS) fail(`.${kind}.perMonth 应为 0–${MAX_NPC_MONTHLY_SPANS} 内的有限数`);
        if (!Array.isArray(span.days) || span.days.length !== 2
            || !span.days.every(day => Number.isInteger(day) && day >= 1 && day <= MAX_SPAN)
            || span.days[0] > span.days[1]) fail(`.${kind}.days 应为 1–${MAX_SPAN} 内递增的整数范围`);
        if (kind === 'busy' && (!Array.isArray(span.labels) || !span.labels.length || !span.labels.every(label => typeof label === 'string' && Boolean(label.trim())))) fail('.busy.labels 应为非空字符串数组');
    }
    if (value.home !== undefined) {
        const home = value.home;
        if (!stateObject(home) || typeof home.weekendChance !== 'number' || !Number.isFinite(home.weekendChance)
            || home.weekendChance < 0 || home.weekendChance > 1 || typeof home.holidays !== 'boolean') fail('.home 的概率应在 0–1 之间，holidays 应为布尔值');
    }
}

/** 她这一天的状态（几种可以同时有：感冒了又赶上回家）；放假不忙 */
export function npcStates(id: string, life: NpcLife | undefined, schedule: Schedule, day: Date): NpcState[] {
    validateNpcLife(life);
    if (!Number.isFinite(day.getTime())) throw new RangeError('NPC 日期不合法');
    if (!life) return [];
    const date = formatDate(day);
    const holiday = schedule.holidays.some(h => h.start <= date && date <= h.end);
    const states: NpcState[] = [];
    const sick = life.sick && spanOn(`${id} sick`, life.sick.perMonth, life.sick.days, day);
    if (sick) states.push({ kind: 'sick', ...sick });
    const busy = life.busy && !holiday ? spanOn(`${id} busy`, life.busy.perMonth, life.busy.days, day) : undefined;
    if (busy && life.busy) {
        const label = life.busy.labels[Math.floor(unit(`${formatDate(busy.start)} ${id} busy label`) * life.busy.labels.length)]!;
        states.push({ kind: 'busy', day: busy.day, of: busy.of, label });
    }
    if (life.home) {
        const weekday = day.getDay();
        // 周六、周日按那个周六取哈希：一个周末要么都在家，要么都在学校
        const saturday = weekday === 6 ? day : weekday === 0 ? addDays(day, -1) : undefined;
        if ((holiday && life.home.holidays) || (saturday && unit(`${formatDate(saturday)} ${id} home`) < life.home.weekendChance)) states.push({ kind: 'home' });
    }
    return states;
}

/** 小事要不要发生（world.ts）：skip_when 里有她今天的状态就不发生；写了 only_when 就得有其中一个 */
export function npcAllows(states: readonly NpcState[], skipWhen: readonly NpcStateKind[] = [], onlyWhen: readonly NpcStateKind[] = []): boolean {
    if (states.some(s => skipWhen.includes(s.kind))) return false;
    return !onlyWhen.length || states.some(s => onlyWhen.includes(s.kind));
}

/** 进「你那边」和「那天你那边的事」的一句：只写事实；没有可写的不返回 */
export function describeNpc(name: string, states: readonly NpcState[]): string | undefined {
    const parts = states.map(s => s.kind === 'sick' ? (s.day === 1 ? '感冒了' : s.day < s.of ? `感冒第 ${s.day} 天` : '感冒快好了')
        : s.kind === 'busy' ? `这几天${s.label}，忙` : '回家了');
    return parts.length ? `${name}${parts.join('，')}` : undefined;
}

/** 他这次的话里说起的人（名字或者名，「陈佳宁」「佳宁」）；只看她上次回复之后的 */
export function npcMentioned<P extends { id: string; name: string }>(history: readonly { role: 'user' | 'assistant'; content: string }[], people: readonly P[]): P[] {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const said = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (!said) return [];
    return people.filter(person => said.includes(person.name) || ([...person.name].length === 3 && said.includes(person.name.slice(1))));
}

/** 最近几段（连着的同一种状态并成一段；busy 换了忙的事算另一段），给 recentWith 用 */
export function npcSpans(states: readonly { day: Date; states: readonly NpcState[] }[]): { kind: NpcStateKind; label?: string; from: Date; to: Date; ongoing: boolean }[] {
    const spans: { kind: NpcStateKind; label?: string; from: Date; to: Date; ongoing: boolean }[] = [];
    const last = states.at(-1)?.day;
    for (const { day, states: today } of states) {
        for (const state of today) {
            const label = state.kind === 'busy' ? state.label : undefined;
            const open = spans.find(s => s.kind === state.kind && s.label === label && addDays(s.to, 1).getTime() === day.getTime());
            if (open) open.to = day;
            else spans.push({ kind: state.kind, ...(label ? { label } : {}), from: day, to: day, ongoing: false });
        }
    }
    for (const span of spans) span.ongoing = span.to.getTime() === last?.getTime();
    return spans.sort((a, b) => a.from.getTime() - b.from.getTime());
}

/**
 * 某段病、某段忙：按月排——每月 perMonth 段（整数部分一定有，小数部分按哈希），起始日按哈希散在那个月里，持续天数在范围里取；
 * 今天落在哪段里、是第几天（几段叠在一起取开始得早的）。不按天抛硬币：那样一年里会有几个月一段都没有（第一版苏雨桐 4 个半月没病过）
 */
function spanOn(key: string, perMonth: number, [min, max]: [number, number], day: Date): { start: Date; day: number; of: number } | undefined {
    let found: { start: Date; day: number; of: number } | undefined;
    // 上个月开始的可能拖到这个月（一段最长 MAX_SPAN 天）
    for (const first of [new Date(day.getFullYear(), day.getMonth() - 1, 1), new Date(day.getFullYear(), day.getMonth(), 1)]) {
        const month = formatDate(first).slice(0, 7);
        const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
        const count = Math.floor(perMonth) + (unit(`${month} ${key} extra`) < perMonth % 1 ? 1 : 0);
        for (let k = 0; k < count; k++) {
            const start = addDays(first, Math.floor(unit(`${month} ${key} ${k} start`) * length));
            const of = Math.min(MAX_SPAN, min + Math.floor(unit(`${month} ${key} ${k} days`) * (max - min + 1)));
            const index = Math.round((day.getTime() - start.getTime()) / 86_400_000);
            if (index >= 0 && index < of && (!found || start < found.start)) found = { start, day: index + 1, of };
        }
    }
    return found;
}

/** FNV-1a 加一道 murmur3 的 fmix32：只差几个字的键（日期 + 人 + 名目）在小概率那头也散得开 */
export function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
    hash ^= hash >>> 16;
    return (hash >>> 0) / 0x1_0000_0000;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
