// 她的世界（ADR 0021）：source/world.yml —— 她身边会自己变的东西（天气、楼下的猫、快递、作业、相机基金、和家里视频、宿舍和学校里的小事）。
// 这里只有资料和推进规则；运行时按日期推出每一天（packages/bot/src/world.ts），同一天对所有人一样。
// 资料从已有的事实长出来（persona.yml 的猫、相机、家里、宿舍；自传「作业拖到最后一晚」），不新发明大设定。

import type { CardWorld } from './st-format.ts';

export type WorldWindow = 'morning' | 'afternoon' | 'evening';

/** 天气：先按日期生成（济南各月大概的气温，按 rain_chance 下雨）；以后接真实天气（W5） */
export interface WeatherSource {
    tiers: string[];
    rain_chance: number;
    /** 月份（1–12）→ [最低, 最高] ℃ */
    temps: Record<string, [number, number]>;
    note?: string;
}

/** 楼下的流浪猫：晚上空的时候下楼喂；下雨、不在学校、晚上有课到窗口结束都不下楼；猫粮一袋喂几天，剩得少了就下单 */
export interface CatSource {
    name: string;
    tiers: string[];
    /** 下楼喂的时间窗口 HH:MM */
    feed: [string, string];
    /** 下楼了也不一定见到它 */
    seen_chance: number;
    /** 一袋猫粮够喂几天、开始那天还剩几天的、剩几天时下单 */
    food: { bag_days: number; left: number; reorder_at: number };
    note?: string;
}

/** 快递：平均每周几件，几天到驿站，驿站放几天；她空的时候去取，有时拖一天 */
export interface ParcelsSource {
    tiers: string[];
    per_week: number;
    arrive_days: [number, number];
    keep_days: number;
    items: string[];
    note?: string;
}

/** 相机基金：可改的设定（目标、开始那天攒了多少、每周存多少、星期几存） */
export interface CameraFundSource {
    tiers: string[];
    goal: number;
    saved: number;
    weekly: number;
    deposit_day: number;
    note?: string;
}

/** 作业：这几种课每节按概率留作业，下一次这门课之前交；多数拖到交的前一晚才写 */
export interface HomeworkSource {
    tiers: string[];
    kinds: string[];
    chance: number;
    early_chance: number;
    note?: string;
}

/** 和家里视频：每周星期几、几点（在学校的时候） */
export interface FamilyCallSource {
    tiers: string[];
    weekday: number;
    time: string;
    note?: string;
}

/**
 * 她世界里的人（NPC，不在 QQ 名单上，不写记忆库）：名字只给 named_tiers 看，别的档位用 label（「高中的闺蜜」）；
 * 室友、同学不起名，用群体称呼写进事件（自传 v1：室友都还行，没有特别亲的）
 */
export interface WorldPersonSource {
    id: string;
    name: string;
    label: string;
    relation: string;
    tiers: string[];
    named_tiers: string[];
    note?: string;
}

/** 学校和宿舍里的小事：符合条件的日子按概率发生在那个时段里；text 写事实，不写台词；{person} 换成 person 那个人这一档的叫法 */
export interface WorldEventSource {
    id: string;
    text: string;
    person?: string;
    tiers: string[];
    window: WorldWindow;
    chance: number;
    /** 只在上学的日子（school）、只在有课的日子（class_day）、哪天都行（any） */
    when: 'school' | 'class_day' | 'any';
    /** 只在星期几（1–7） */
    weekday?: number;
    note?: string;
}

/**
 * 她的身体（ADR 0025）：困、累、饿按作息推，tiers 里的档位都有；生理期按周期推（first 是某次的第一天，cycle 每个周期长短的范围），
 * 头两天按 cramps_chance 痛经（persona.yml body：「你有痛经」），说得出口的只有 detail_tiers，别的档位那几天只说身上不太舒服；小感冒按 per_month 的概率，持续 days 天
 */
export interface BodySource {
    tiers: string[];
    period?: { first: string; cycle: [number, number]; days: number; cramps_chance: number; detail_tiers: string[] };
    cold?: { per_month: number; days: number };
    note?: string;
}

export interface WorldSource {
    /** 从哪天开始推（学期开始那天）；猫粮、相机基金这些数是那天的 */
    start_day: string;
    /** 回家过的假期名字：那几天她不在学校，不喂猫、不取快递、不和家里视频 */
    away_holidays: string[];
    weather: WeatherSource;
    cat: CatSource;
    parcels: ParcelsSource;
    camera_fund: CameraFundSource;
    homework: HomeworkSource;
    family_call: FamilyCallSource;
    people: WorldPersonSource[];
    events: WorldEventSource[];
    body?: BodySource;
    note?: string;
}

/** 资料里每一块的 tiers（档位引用检查用） */
export function worldTiers(world: WorldSource): { at: string; tiers: string[] }[] {
    return [
        { at: 'weather', tiers: world.weather.tiers },
        { at: 'cat', tiers: world.cat.tiers },
        { at: 'parcels', tiers: world.parcels.tiers },
        { at: 'camera_fund', tiers: world.camera_fund.tiers },
        { at: 'homework', tiers: world.homework.tiers },
        { at: 'family_call', tiers: world.family_call.tiers },
        ...world.people.flatMap((person, i) => [{ at: `people[${i}]`, tiers: person.tiers }, { at: `people[${i}].named_tiers`, tiers: person.named_tiers }]),
        ...world.events.map((event, i) => ({ at: `events[${i}]`, tiers: event.tiers })),
        ...(world.body ? [{ at: 'body', tiers: world.body.tiers }, ...(world.body.period ? [{ at: 'body.period.detail_tiers', tiers: world.body.period.detail_tiers }] : [])] : []),
    ];
}

/** 一档的卡里放哪些：这一档看不到的整块不写（运行时推的时候用不到它，看得到的部分照样每档一样） */
export function worldForTier(world: WorldSource | undefined, tier: string): CardWorld | undefined {
    if (!world) return undefined;
    const sees = (tiers: string[]) => tiers.includes(tier);
    const card: CardWorld = {
        startDay: world.start_day,
        awayHolidays: [...world.away_holidays],
        ...(sees(world.weather.tiers) ? { weather: { rainChance: world.weather.rain_chance, temps: structuredClone(world.weather.temps) } } : {}),
        ...(sees(world.cat.tiers) ? {
            cat: { name: world.cat.name, feed: [...world.cat.feed] as [string, string], seenChance: world.cat.seen_chance, food: { bagDays: world.cat.food.bag_days, left: world.cat.food.left, reorderAt: world.cat.food.reorder_at } },
        } : {}),
        ...(sees(world.parcels.tiers) ? {
            parcels: { perWeek: world.parcels.per_week, arriveDays: [...world.parcels.arrive_days] as [number, number], keepDays: world.parcels.keep_days, items: [...world.parcels.items] },
        } : {}),
        ...(sees(world.camera_fund.tiers) ? {
            cameraFund: { goal: world.camera_fund.goal, saved: world.camera_fund.saved, weekly: world.camera_fund.weekly, depositDay: world.camera_fund.deposit_day },
        } : {}),
        ...(sees(world.homework.tiers) ? { homework: { kinds: [...world.homework.kinds], chance: world.homework.chance, earlyChance: world.homework.early_chance } } : {}),
        ...(sees(world.family_call.tiers) ? { familyCall: { weekday: world.family_call.weekday, time: world.family_call.time } } : {}),
        people: world.people.filter(person => sees(person.tiers)).map(person => ({
            id: person.id, name: sees(person.named_tiers) ? person.name : person.label, relation: person.relation,
        })),
        // 涉及的人这一档看不到的事件不写
        events: world.events.filter(event => sees(event.tiers) && (!event.person || sees(world.people.find(p => p.id === event.person)!.tiers))).map(event => ({
            id: event.id, text: event.text, window: event.window, chance: event.chance, when: event.when,
            ...(event.person ? { person: event.person } : {}), ...(event.weekday ? { weekday: event.weekday } : {}),
        })),
        ...(world.body && sees(world.body.tiers) ? {
            body: {
                ...(world.body.period ? { period: { first: world.body.period.first, cycle: [...world.body.period.cycle] as [number, number], days: world.body.period.days, crampsChance: world.body.period.cramps_chance, detail: sees(world.body.period.detail_tiers) } } : {}),
                ...(world.body.cold ? { cold: { perMonth: world.body.cold.per_month, days: world.body.cold.days } } : {}),
            },
        } : {}),
    };
    return card;
}

// ---------- 校验（结构；档位引用在 build.ts，隐私检查扫卡上的 world） ----------

type Json = Record<string, unknown>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOWS: WorldWindow[] = ['morning', 'afternoon', 'evening'];
const WHEN = ['school', 'class_day', 'any'] as const;
const COURSE_KINDS = ['hard', 'machine', 'water', 'pe'];

class At {
    private readonly where: string;
    constructor(where: string) { this.where = where; }
    at(path: string): At { return new At(path.startsWith('[') ? `${this.where}${path}` : `${this.where}.${path}`); }
    fail(message: string): never { throw new Error(`${this.where} ${message}`); }
    object(value: unknown): Json {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail('应为对象');
        return value as Json;
    }
    keys(obj: Json, allowed: string[]): void {
        const unknown = Object.keys(obj).filter(key => !allowed.includes(key));
        if (unknown.length) this.fail(`有不认识的键：${unknown.join('、')}`);
    }
    string(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) this.fail('应为非空字符串');
        return (value as string).trim();
    }
    note(value: unknown): { note?: string } {
        if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return {};
        return { note: this.string(value) };
    }
    strings(value: unknown, allowEmpty = true): string[] {
        if (!Array.isArray(value) || !value.every(x => typeof x === 'string' && x.trim())) this.fail('应为非空字符串的数组');
        const list = (value as string[]).map(x => x.trim());
        if (!allowEmpty && !list.length) this.fail('不能是空数组');
        return list;
    }
    number(value: unknown, min: number, max: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) this.fail(`应为 ${min}–${max} 的数`);
        return value as number;
    }
    integer(value: unknown, min: number, max: number): number {
        if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) this.fail(`应为 ${min}–${max} 的整数`);
        return value as number;
    }
    time(value: unknown): string {
        const text = this.string(value);
        if (!TIME.test(text)) this.fail(`应为 HH:MM：${text}`);
        return text;
    }
    range(value: unknown, min: number, max: number, integer: boolean): [number, number] {
        if (!Array.isArray(value) || value.length !== 2) this.fail('应为两个数 [小, 大]');
        const pair = (value as unknown[]).map((v, i) => (integer ? this.at(`[${i}]`).integer(v, min, max) : this.at(`[${i}]`).number(v, min, max))) as [number, number];
        if (pair[0] > pair[1]) this.fail('前一个不能比后一个大');
        return pair;
    }
}

export function checkWorld(raw: unknown): WorldSource {
    const root = new At('world.yml');
    const o = root.object(raw);
    root.keys(o, ['start_day', 'away_holidays', 'weather', 'cat', 'parcels', 'camera_fund', 'homework', 'family_call', 'people', 'events', 'body', 'note']);
    const startDay = root.at('start_day').string(o.start_day);
    if (!DATE.test(startDay)) root.at('start_day').fail(`应为 YYYY-MM-DD：${startDay}`);

    const w = root.at('weather');
    const weather = w.object(o.weather);
    w.keys(weather, ['tiers', 'rain_chance', 'temps', 'note']);
    const tempsRaw = w.at('temps').object(weather.temps);
    const temps: Record<string, [number, number]> = {};
    for (let month = 1; month <= 12; month++) {
        if (!(String(month) in tempsRaw)) w.at('temps').fail(`缺 ${month} 月`);
        temps[String(month)] = w.at(`temps.${month}`).range(tempsRaw[String(month)], -40, 50, true);
    }
    if (Object.keys(tempsRaw).length !== 12) w.at('temps').fail('只写 1–12 月');

    const c = root.at('cat');
    const cat = c.object(o.cat);
    c.keys(cat, ['name', 'tiers', 'feed', 'seen_chance', 'food', 'note']);
    if (!Array.isArray(cat.feed) || cat.feed.length !== 2) c.at('feed').fail('应为 [开始, 结束]');
    const feed = (cat.feed as unknown[]).map((t, i) => c.at(`feed[${i}]`).time(t)) as [string, string];
    if (feed[0] >= feed[1]) c.at('feed').fail('开始要早于结束');
    const food = c.at('food').object(cat.food);
    c.at('food').keys(food, ['bag_days', 'left', 'reorder_at']);

    const p = root.at('parcels');
    const parcels = p.object(o.parcels);
    p.keys(parcels, ['tiers', 'per_week', 'arrive_days', 'keep_days', 'items', 'note']);

    const f = root.at('camera_fund');
    const fund = f.object(o.camera_fund);
    f.keys(fund, ['tiers', 'goal', 'saved', 'weekly', 'deposit_day', 'note']);

    const h = root.at('homework');
    const homework = h.object(o.homework);
    h.keys(homework, ['tiers', 'kinds', 'chance', 'early_chance', 'note']);
    const kinds = h.at('kinds').strings(homework.kinds, false);
    for (const kind of kinds) if (!COURSE_KINDS.includes(kind)) h.at('kinds').fail(`${kind} 不是课型（${COURSE_KINDS.join(' / ')}）`);

    const fc = root.at('family_call');
    const call = fc.object(o.family_call);
    fc.keys(call, ['tiers', 'weekday', 'time', 'note']);

    const peopleRaw: unknown[] = o.people === undefined || o.people === null ? [] : Array.isArray(o.people) ? o.people : root.at('people').fail('应为数组');
    const people = peopleRaw.map((value, i): WorldPersonSource => {
        const e = root.at(`people[${i}]`);
        const person = e.object(value);
        e.keys(person, ['id', 'name', 'label', 'relation', 'tiers', 'named_tiers', 'note']);
        const tiers = e.at('tiers').strings(person.tiers);
        const named = e.at('named_tiers').strings(person.named_tiers);
        for (const tier of named) if (!tiers.includes(tier)) e.at('named_tiers').fail(`${tier} 不在 tiers 里`);
        return {
            id: e.at('id').string(person.id),
            name: e.at('name').string(person.name),
            label: e.at('label').string(person.label),
            relation: e.at('relation').string(person.relation),
            tiers,
            named_tiers: named,
            ...e.at('note').note(person.note),
        };
    });
    if (new Set(people.map(person => person.id)).size !== people.length) root.at('people').fail('id 重复');

    const eventsRaw: unknown[] = o.events === undefined || o.events === null ? [] : Array.isArray(o.events) ? o.events : root.at('events').fail('应为数组');
    const events = eventsRaw.map((value, i): WorldEventSource => {
        const e = root.at(`events[${i}]`);
        const event = e.object(value);
        e.keys(event, ['id', 'text', 'person', 'tiers', 'window', 'chance', 'when', 'weekday', 'note']);
        const person = event.person === undefined || event.person === null ? undefined : e.at('person').string(event.person);
        if (person && !people.some(p => p.id === person)) e.at('person').fail(`people 里没有 ${person}`);
        if (person && !String(event.text).includes('{person}')) e.at('text').fail('写了 person 就要在 text 里用 {person}');
        const window = e.at('window').string(event.window) as WorldWindow;
        if (!WINDOWS.includes(window)) e.at('window').fail(`应为 ${WINDOWS.join(' / ')}`);
        const when = e.at('when').string(event.when) as WorldEventSource['when'];
        if (!WHEN.includes(when)) e.at('when').fail(`应为 ${WHEN.join(' / ')}`);
        const weekday = event.weekday === undefined || event.weekday === null ? undefined : e.at('weekday').integer(event.weekday, 1, 7);
        return {
            id: e.at('id').string(event.id),
            text: e.at('text').string(event.text),
            ...(person ? { person } : {}),
            tiers: e.at('tiers').strings(event.tiers),
            window,
            chance: e.at('chance').number(event.chance, 0, 1),
            when,
            ...(weekday ? { weekday } : {}),
            ...e.at('note').note(event.note),
        };
    });
    if (new Set(events.map(event => event.id)).size !== events.length) root.at('events').fail('id 重复');

    const body = o.body === undefined || o.body === null ? undefined : checkBody(root.at('body'), o.body);
    const awayHolidays = o.away_holidays === undefined || o.away_holidays === null ? [] : root.at('away_holidays').strings(o.away_holidays);
    return {
        start_day: startDay,
        away_holidays: awayHolidays,
        weather: { tiers: w.at('tiers').strings(weather.tiers), rain_chance: w.at('rain_chance').number(weather.rain_chance, 0, 1), temps, ...w.at('note').note(weather.note) },
        cat: {
            name: c.at('name').string(cat.name),
            tiers: c.at('tiers').strings(cat.tiers),
            feed,
            seen_chance: c.at('seen_chance').number(cat.seen_chance, 0, 1),
            food: {
                bag_days: c.at('food.bag_days').integer(food.bag_days, 1, 365),
                left: c.at('food.left').integer(food.left, 0, 365),
                reorder_at: c.at('food.reorder_at').integer(food.reorder_at, 0, 365),
            },
            ...c.at('note').note(cat.note),
        },
        parcels: {
            tiers: p.at('tiers').strings(parcels.tiers),
            per_week: p.at('per_week').number(parcels.per_week, 0, 14),
            arrive_days: p.at('arrive_days').range(parcels.arrive_days, 1, 14, true),
            keep_days: p.at('keep_days').integer(parcels.keep_days, 1, 14),
            items: p.at('items').strings(parcels.items, false),
            ...p.at('note').note(parcels.note),
        },
        camera_fund: {
            tiers: f.at('tiers').strings(fund.tiers),
            goal: f.at('goal').integer(fund.goal, 1, 1_000_000),
            saved: f.at('saved').integer(fund.saved, 0, 1_000_000),
            weekly: f.at('weekly').integer(fund.weekly, 0, 100_000),
            deposit_day: f.at('deposit_day').integer(fund.deposit_day, 1, 7),
            ...f.at('note').note(fund.note),
        },
        homework: {
            tiers: h.at('tiers').strings(homework.tiers),
            kinds,
            chance: h.at('chance').number(homework.chance, 0, 1),
            early_chance: h.at('early_chance').number(homework.early_chance, 0, 1),
            ...h.at('note').note(homework.note),
        },
        family_call: {
            tiers: fc.at('tiers').strings(call.tiers),
            weekday: fc.at('weekday').integer(call.weekday, 1, 7),
            time: fc.at('time').time(call.time),
            ...fc.at('note').note(call.note),
        },
        people,
        events,
        ...(body ? { body } : {}),
        ...root.at('note').note(o.note),
    };
}

function checkBody(b: At, value: unknown): BodySource {
    const body = b.object(value);
    b.keys(body, ['tiers', 'period', 'cold', 'note']);
    const tiers = b.at('tiers').strings(body.tiers);
    let period: BodySource['period'];
    if (body.period !== undefined && body.period !== null) {
        const p = b.at('period');
        const raw = p.object(body.period);
        p.keys(raw, ['first', 'cycle', 'days', 'cramps_chance', 'detail_tiers']);
        const first = p.at('first').string(raw.first);
        if (!DATE.test(first)) p.at('first').fail(`应为 YYYY-MM-DD：${first}`);
        const detail = p.at('detail_tiers').strings(raw.detail_tiers);
        for (const tier of detail) if (!tiers.includes(tier)) p.at('detail_tiers').fail(`${tier} 不在 body.tiers 里`);
        period = { first, cycle: p.at('cycle').range(raw.cycle, 20, 45, true), days: p.at('days').integer(raw.days, 1, 10), cramps_chance: p.at('cramps_chance').number(raw.cramps_chance, 0, 1), detail_tiers: detail };
    }
    let cold: BodySource['cold'];
    if (body.cold !== undefined && body.cold !== null) {
        const c = b.at('cold');
        const raw = c.object(body.cold);
        c.keys(raw, ['per_month', 'days']);
        cold = { per_month: c.at('per_month').number(raw.per_month, 0, 10), days: c.at('days').integer(raw.days, 1, 14) };
    }
    return { tiers, ...(period ? { period } : {}), ...(cold ? { cold } : {}), ...b.at('note').note(body.note) };
}
