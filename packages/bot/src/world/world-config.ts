import type { World } from './world.ts';
import { calendarDate, stateObject } from '../memory/state-schema.ts';

/** 对运行时世界配置做边界校验；不修改输入，也不禁止未知扩展字段。 */
export function validateWorldConfig(value: unknown, fail: (message: string) => never): void {
    if (value === undefined || value === null) return;
    const object = (v: unknown, path: string): Record<string, unknown> => stateObject(v) ? v : fail(`${path} 应为对象`);
    const array = (v: unknown, path: string): unknown[] => Array.isArray(v) ? v : fail(`${path} 应为数组`);
    const text = (v: unknown, path: string): string => typeof v === 'string' && Boolean(v.trim()) ? v : fail(`${path} 应为非空字符串`);
    const number = (v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = true): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isSafeInteger(v))
            ? v : fail(`${path} 应为范围内的有限${integer ? '安全整数' : '数值'}`);
    const probability = (v: unknown, path: string) => number(v, path, 0, 1, false);
    const boolean = (v: unknown, path: string) => { if (typeof v !== 'boolean') fail(`${path} 应为布尔值`); };
    const date = (v: unknown, path: string): string => typeof v === 'string' && calendarDate(v) ? v : fail(`${path} 应为真实的 YYYY-MM-DD 日期`);
    const clock = (v: unknown, path: string): string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fail(`${path} 应为 HH:MM`);
    const strings = (v: unknown, path: string, nonempty = false): string[] => {
        const values = array(v, path).map((item, i) => text(item, `${path}[${i}]`));
        if (nonempty && !values.length) fail(`${path} 不能为空`);
        return values;
    };
    const range = (v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = true): [number, number] => {
        const values = array(v, path);
        if (values.length !== 2) fail(`${path} 应为两项区间`);
        const low = number(values[0], `${path}[0]`, min, max, integer);
        const high = number(values[1], `${path}[1]`, min, max, integer);
        if (low > high) fail(`${path} 下限不能大于上限`);
        return [low, high];
    };
    const oneOf = (v: unknown, path: string, choices: readonly string[]): string =>
        typeof v === 'string' && choices.includes(v) ? v : fail(`${path} 不是有效选项`);
    const w = object(value, '') as { [K in keyof World]?: unknown } & Record<string, unknown>;
    const start = date(w.startDay, '.startDay');
    const startTime = Date.parse(`${start}T00:00:00Z`);
    const dateOffset = (days: number, path: string) => {
        const result = new Date(startTime + days * 86_400_000);
        // UTC 在这里仅编码民用日历做中立运算，不把本地日期当成某个时区的真实时刻。
        if (!Number.isFinite(result.getTime()) || !calendarDate(result.toISOString().slice(0, 10))) fail(`${path} 超出支持的四位日期范围`);
    };
    strings(w.awayHolidays, '.awayHolidays');
    const people = array(w.people, '.people');
    const personIds = people.map((person, i) => text(object(person, `.people[${i}]`).id, `.people[${i}].id`));
    if (new Set(personIds).size !== personIds.length) fail('.people.id 不能重复');

    if (w.weather !== undefined) {
        const weather = object(w.weather, '.weather');
        probability(weather.rainChance, '.weather.rainChance');
        const temps = object(weather.temps, '.weather.temps');
        for (let month = 1; month <= 12; month++) range(temps[String(month)], `.weather.temps.${month}`, -100, 100, false);
        if (weather.places !== undefined) {
            const places = object(weather.places, '.weather.places');
            const ids = (['school', 'home'] as const).map(key => {
                const place = object(places[key], `.weather.places.${key}`);
                text(place.name, `.weather.places.${key}.name`);
                number(place.latitude, `.weather.places.${key}.latitude`, -90, 90, false);
                number(place.longitude, `.weather.places.${key}.longitude`, -180, 180, false);
                if (typeof place.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(place.id)) fail(`.weather.places.${key}.id 应为小写字母开头的字母、数字、- 或 _`);
                return place.id;
            });
            if (ids[0] === ids[1]) fail('.weather.places 的 school 和 home 的 id 不能一样');
        }
    }
    if (w.cat !== undefined) {
        const cat = object(w.cat, '.cat'); text(cat.name, '.cat.name');
        const feed = array(cat.feed, '.cat.feed');
        if (feed.length !== 2) fail('.cat.feed 应为两项时段');
        const from = clock(feed[0], '.cat.feed[0]'); const to = clock(feed[1], '.cat.feed[1]');
        if (from >= to) fail('.cat.feed 开始应早于结束');
        probability(cat.seenChance, '.cat.seenChance');
        const food = object(cat.food, '.cat.food');
        number(food.bagDays, '.cat.food.bagDays', 1); number(food.left, '.cat.food.left');
        // 负阈值已有“关闭自动补货”的使用方式，保留该安全整数哨兵语义。
        number(food.reorderAt, '.cat.food.reorderAt', -Number.MAX_SAFE_INTEGER);
    }
    if (w.parcels !== undefined) {
        const parcels = object(w.parcels, '.parcels');
        const perWeek = number(parcels.perWeek, '.parcels.perWeek', 0, 14, false); // 沿用源资料校验的上限。
        const arrive = range(parcels.arriveDays, '.parcels.arriveDays');
        const keep = number(parcels.keepDays, '.parcels.keepDays', 1);
        if (perWeek > 0) {
            dateOffset(arrive[1], '.parcels.arriveDays');
            // 到货当天已经是保管第一天，与实际 deadline 的 +keepDays-1 保持一致。
            dateOffset(arrive[1] + keep - 1, '.parcels.keepDays');
        }
        strings(parcels.items, '.parcels.items', perWeek > 0);
        if (parcels.afterMealFrom !== undefined) date(parcels.afterMealFrom, '.parcels.afterMealFrom');
    }
    if (w.cameraFund !== undefined) {
        const fund = object(w.cameraFund, '.cameraFund');
        number(fund.goal, '.cameraFund.goal', 1); number(fund.saved, '.cameraFund.saved'); number(fund.weekly, '.cameraFund.weekly');
        number(fund.depositDay, '.cameraFund.depositDay', 1, 7);
        if (fund.purchase !== undefined) {
            const purchase = object(fund.purchase, '.cameraFund.purchase');
            const day = date(purchase.date, '.cameraFund.purchase.date'); const from = clock(purchase.from, '.cameraFund.purchase.from');
            const minutes = number(purchase.minutes, '.cameraFund.purchase.minutes', 1, 600); // 源资料的行程上限为 600 分钟。
            const end = new Date(Date.parse(`${day}T${from}:00Z`) + minutes * 60_000);
            if (!Number.isFinite(end.getTime()) || !calendarDate(end.toISOString().slice(0, 10))) fail('.cameraFund.purchase.minutes 超出支持的四位日期范围');
            text(purchase.where, '.cameraFund.purchase.where'); text(purchase.what, '.cameraFund.purchase.what'); number(purchase.price, '.cameraFund.purchase.price', 1);
        }
    }
    if (w.homework !== undefined) {
        const homework = object(w.homework, '.homework');
        strings(homework.kinds, '.homework.kinds').forEach(kind => oneOf(kind, '.homework.kinds', ['hard', 'machine', 'water', 'pe']));
        probability(homework.chance, '.homework.chance'); probability(homework.earlyChance, '.homework.earlyChance');
        if (homework.groupedFrom !== undefined) date(homework.groupedFrom, '.homework.groupedFrom');
    }
    if (w.familyCall !== undefined) {
        const call = object(w.familyCall, '.familyCall'); number(call.weekday, '.familyCall.weekday', 1, 7); clock(call.time, '.familyCall.time');
    }
    if (w.routine !== undefined) {
        const routine = object(w.routine, '.routine'); probability(routine.takeoutChance, '.routine.takeoutChance');
        for (const kind of ['lunch', 'dinner']) {
            const path = `.routine.${kind}`; const meal = object(routine[kind], path);
            clock(meal.from, `${path}.from`); number(meal.spread, `${path}.spread`, 0, 1439); number(meal.minutes, `${path}.minutes`, 1, 1440);
        }
        const shower = object(routine.shower, '.routine.shower');
        clock(shower.from, '.routine.shower.from'); number(shower.spread, '.routine.shower.spread', 0, 1439);
        range(shower.minutes, '.routine.shower.minutes', 1, 1440); probability(shower.chance, '.routine.shower.chance');
    }
    if (w.money !== undefined) {
        const money = object(w.money, '.money');
        number(money.allowance, '.money.allowance'); number(money.payday, '.money.payday', 1, 28);
        number(money.start, '.money.start', -Number.MAX_SAFE_INTEGER); number(money.askHome, '.money.askHome'); boolean(money.detail, '.money.detail');
        const prices = object(money.prices, '.money.prices');
        for (const kind of ['canteen', 'takeout', 'misc']) range(prices[kind], `.money.prices.${kind}`);
        number(prices.catFood, '.money.prices.catFood');
        const parcelPrices = object(prices.parcels, '.money.prices.parcels');
        for (const [i, price] of Object.values(parcelPrices).entries()) number(price, `.money.prices.parcels[${i}]`);
        const saving = object(money.saving, '.money.saving');
        number(saving.keepPerDay, '.money.saving.keepPerDay'); number(saving.step, '.money.saving.step', 1); number(saving.max, '.money.saving.max');
        if (money.sideJobs !== undefined) {
            const jobs = object(money.sideJobs, '.money.sideJobs'); const perMonth = number(jobs.perMonth, '.money.sideJobs.perMonth', 0, 28, false);
            range(jobs.pay, '.money.sideJobs.pay'); strings(jobs.kinds, '.money.sideJobs.kinds', perMonth > 0);
        }
    }
    const events = array(w.events, '.events'); const eventIds = new Set<string>();
    events.forEach((value, i) => {
        const path = `.events[${i}]`; const event = object(value, path);
        const id = text(event.id, `${path}.id`);
        if (eventIds.has(id)) fail('.events.id 不能重复'); eventIds.add(id);
        text(event.text, `${path}.text`); oneOf(event.window, `${path}.window`, ['morning', 'afternoon', 'evening']);
        oneOf(event.when, `${path}.when`, ['school', 'class_day', 'off_day', 'any']); probability(event.chance, `${path}.chance`);
        if (event.person !== undefined) {
            const person = text(event.person, `${path}.person`);
            if (!personIds.includes(person)) fail(`${path}.person 必须引用已配置的NPC`);
        }
        if (event.weekday !== undefined) number(event.weekday, `${path}.weekday`, 1, 7);
        for (const [field, max] of [['weekdays', 7], ['months', 12]] as const) {
            if (event[field] !== undefined) array(event[field], `${path}.${field}`).forEach((item, j) => number(item, `${path}.${field}[${j}]`, 1, max));
        }
        for (const field of ['skipWhen', 'onlyWhen']) if (event[field] !== undefined) strings(event[field], `${path}.${field}`).forEach(kind => oneOf(kind, `${path}.${field}`, ['sick', 'busy', 'home']));
        if (event.cost !== undefined) {
            const cost = object(event.cost, `${path}.cost`); range(cost.amount, `${path}.cost.amount`); text(cost.what, `${path}.cost.what`);
        }
        if (event.weather !== undefined) oneOf(event.weather, `${path}.weather`, ['rain', 'dry', 'cold', 'hot']);
        if (event.group !== undefined) text(event.group, `${path}.group`);
        if (event.requires !== undefined) oneOf(event.requires, `${path}.requires`, ['cat_seen', 'cat_unseen']);
        for (const field of ['afterCamera', 'everyday']) if (event[field] !== undefined) boolean(event[field], `${path}.${field}`);
        if (event.feel !== undefined) {
            const feel = object(event.feel, `${path}.feel`); oneOf(feel.kind, `${path}.feel.kind`, ['joy', 'relief', 'worry', 'sad', 'annoyed', 'tired']); number(feel.strength, `${path}.feel.strength`, 1, 3);
        }
    });
    for (const field of ['everydayFrom', 'menuFrom']) if (w[field] !== undefined) date(w[field], `.${field}`);
    for (const field of ['quizzes', 'asks']) if (w[field] !== undefined) boolean(w[field], `.${field}`);
    if (w.plans !== undefined) {
        const plans = object(w.plans, '.plans'); strings(plans.study, '.plans.study'); text(plans.rest, '.plans.rest');
        array(plans.outings, '.plans.outings').forEach((value, i) => {
            const outing = object(value, `.plans.outings[${i}]`); text(outing.text, `.plans.outings[${i}].text`); text(outing.indoors, `.plans.outings[${i}].indoors`);
        });
    }
    if (w.menu !== undefined) {
        const menu = object(w.menu, '.menu'); strings(menu.lunch, '.menu.lunch'); strings(menu.dinner, '.menu.dinner');
    }
    if (w.cat !== undefined) {
        const food = object(object(w.cat, '.cat').food, '.cat.food');
        // 首日库存喂一顿后就可能触发补货。只检查确有可能发生的首批订单；后续投影另行守界。
        if ((food.reorderAt as number) >= 0 && (food.left as number) <= (food.reorderAt as number) + 1) {
            const keepDays = w.parcels === undefined ? 3 : object(w.parcels, '.parcels').keepDays as number;
            dateOffset(2 + keepDays - 1, '.cat.food');
        }
    }
}
