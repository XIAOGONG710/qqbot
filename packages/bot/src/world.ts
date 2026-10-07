// 她的世界（ADR 0021 W1、W2；ADR 0027 W3）：卡上的 extensions.qqbot.world（source/world.yml 按档位裁剪）→ 某一刻她身边的事实。
// - 从 startDay（学期开始）一天一天推到今天：天气、楼下的猫（喂没喂、猫粮还剩几天、没了就网购）、快递（下单 → 到驿站 → 取 / 退回）、
//   作业（上课时留、下次这门课之前交、多半拖到前一晚写）、相机基金（每周存一点）、和家里视频、学校和宿舍里的小事。
// - 随机都按「日期 + 名目」取哈希，同一天对所有人一样（各档的卡只是看得到的块不同），重启、重放都一样，不存随机状态；
//   每天的结果另写一份 <dataDir>/world/state.json 供查看；说出口的完成动作写在 actions.json，所有联系人和日记共用。
// - 进提示词的只有事实和约束（describeWorld），不写能原样照抄的整句（DSH 原则 1）；到「现在」为止发生了的才写，没发生的不写。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from './config.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { Episode } from './memory/episodes.ts';
import { classesOn, formatDate, herDay, type ClassToday, type Schedule } from './schedule.ts';
import { parseBody, type Body } from './body.ts';

export type WorldWindow = 'morning' | 'afternoon' | 'evening';

export interface World {
    startDay: string;
    awayHolidays: string[];
    weather?: { rainChance: number; temps: Record<string, [number, number]> };
    cat?: { name: string; feed: [string, string]; seenChance: number; food: { bagDays: number; left: number; reorderAt: number } };
    parcels?: { perWeek: number; arriveDays: [number, number]; keepDays: number; items: string[] };
    cameraFund?: { goal: number; saved: number; weekly: number; depositDay: number };
    homework?: { kinds: string[]; chance: number; earlyChance: number };
    familyCall?: { weekday: number; time: string };
    people: { id: string; name: string; relation: string }[];
    events: { id: string; text: string; person?: string; window: WorldWindow; chance: number; when: 'school' | 'class_day' | 'any'; weekday?: number }[];
    /** 她的身体（ADR 0025，body.ts） */
    body?: Body;
}

export interface Parcel {
    /** 不含隐私、各档一致的稳定标识。 */
    id: string;
    item: string;
    ordered: string;
    arrive: Date;
    /** 驿站最后一天（这天结束前取） */
    deadline: string;
    picked?: Date;
    returned?: boolean;
    /** 猫粮（喂完了自动下单的） */
    food?: boolean;
}

export interface Homework {
    /** 按布置日期、课型和上课时刻生成，各档即使看不到课名也一致。 */
    id: string;
    course: string;
    assigned: string;
    due: Date;
    done: Date;
}

/** W3：从她已经发出去的话里抽出的、会改变世界的动作。 */
export type WorldActionKind = 'feed_cat' | 'pick_parcel' | 'finish_homework' | 'family_call';

/** 模型抽取的形状；at 是那句已完成陈述所在的本地分钟（YYYY-MM-DDTHH:mm）。 */
export interface WorldActionDraft {
    kind: WorldActionKind;
    /** 必填：必须能和片段里她的一条消息对上，否则不回写。 */
    at: string;
    /** 快递物品或课程名；没说清时不填。 */
    subject?: string;
    /** 喂猫时明确说见到 / 没见到才填。 */
    seen?: boolean;
}

/** 落盘的动作；id 按联系人、片段和序号去重，day 按她的一天算。 */
export interface WorldAction extends WorldActionDraft {
    id: string;
    day: string;
    at: string;
    contact: number;
    episode: string;
    /** 运行时解析出的包裹 / 作业稳定标识，不由模型填写。 */
    target?: string;
}

/** 某一刻她身边的事实（到 now 为止发生了的） */
export interface WorldNow {
    day: string;
    atSchool: boolean;
    weather?: { rain: boolean; low: number; high: number };
    cat?: {
        name: string;
        /** 今天：喂了（几点、见没见到）/ 还没去（几点以后）/ 不去（为什么） */
        today: { fed: Date; seen?: boolean } | { later: string } | { skipped: 'rain' | 'away' | 'no_food' | 'class' };
        yesterdayFed: boolean;
        foodDays: number;
    };
    /** 在驿站的、今天取了的、今明两天到的 */
    parcels: { item: string; status: 'station' | 'picked_today' | 'arriving'; when: Date; deadline?: string }[];
    cameraFund?: { saved: number; goal: number };
    /** 三天内要交的 */
    /** doneAt：几点写完（还没到就是打算几点写），日记用 */
    homework: { course: string; due: Date; done: boolean; doneAt: Date }[];
    familyCall?: { at: Date; done: boolean };
    /** 今天已经发生的小事（text 已换好人名） */
    events: { id: string; text: string; at: Date; person?: { name: string; relation: string } }[];
}

const DAY_MS = 86_400_000;
const WINDOWS: Record<WorldWindow, [string, string]> = { morning: ['09:00', '11:40'], afternoon: ['12:00', '17:40'], evening: ['19:00', '22:40'] };
/** 取快递的时刻：中午、傍晚、晚上，挑第一个不在上课的 */
const PICKUP_TIMES = ['12:20', '17:40', '20:10'];
/** 喂完了自动下单的猫粮：两天到，到了就取 */
const FOOD_ARRIVE_DAYS = 2;
/** 存相机基金的时刻（那天晚上） */
const DEPOSIT_TIME = '21:00';

// ---------- 推进 ----------

interface DayRecord {
    date: string;
    atSchool: boolean;
    weather?: { rain: boolean; low: number; high: number };
    cat?: { fed?: Date; seen?: boolean; planned?: string; skipped?: 'rain' | 'away' | 'no_food' | 'class'; foodAfter: number };
    events: { id: string; text: string; at: Date; person?: string }[];
    call?: Date;
}

interface Timeline {
    days: Map<string, DayRecord>;
    parcels: Parcel[];
    homework: Homework[];
    /** 每次存钱的时刻和存完的金额 */
    deposits: { at: Date; saved: number }[];
}

/** 从 startDay 推到 until（含），按天记下发生的事；纯函数，同样的输入同样的输出 */
export function simulateWorld(world: World, schedule: Schedule, until: Date, actions: readonly WorldAction[] = []): Timeline {
    const days = new Map<string, DayRecord>();
    const parcels: Parcel[] = [];
    const homework: Homework[] = [];
    const deposits: { at: Date; saved: number }[] = [];
    let food = world.cat?.food.left ?? 0;
    let saved = world.cameraFund?.saved ?? 0;
    const start = parseDate(world.startDay);
    const end = startOfDay(until);
    for (let day = start; day <= end; day = addDays(day, 1)) {
        const date = formatDate(day);
        const todayActions = actions.filter(action => action.day === date && new Date(action.at) <= until);
        const { lessons, outsideSemester } = classesOn(schedule, day);
        const holiday = schedule.holidays.find(h => h.start <= date && date <= h.end);
        const atSchool = !(holiday && world.awayHolidays.includes(holiday.name)) && !(outsideSemester && day > start);
        const record: DayRecord = { date, atSchool, events: [] };
        days.set(date, record);
        if (world.weather) record.weather = weatherOn(world.weather, day);

        // 快递：到了驿站的，在学校、不上课时取；有时拖一天；过了最后一天没取就退回
        for (const parcel of parcels) {
            if (parcel.picked || parcel.returned || parcel.arrive > endOfDay(day)) continue;
            if (date > parcel.deadline) { parcel.returned = true; continue; }
            const late = !parcel.food && unit(`${parcel.ordered} ${parcel.item} late`) < 0.4 && formatDate(parcel.arrive) === date && date < parcel.deadline;
            if (!atSchool || late) continue;
            const time = PICKUP_TIMES.map(t => at(day, t)).find(t => t >= parcel.arrive && !inLesson(lessons, t));
            if (!time) continue;
            parcel.picked = time;
            if (parcel.food && world.cat) food += world.cat.food.bagDays;
        }
        // 新下单的
        if (world.parcels && atSchool && unit(`${date} parcel`) < world.parcels.perWeek / 7) {
            const p = world.parcels;
            const item = p.items[Math.floor(unit(`${date} parcel item`) * p.items.length)]!;
            const wait = p.arriveDays[0] + Math.floor(unit(`${date} parcel days`) * (p.arriveDays[1] - p.arriveDays[0] + 1));
            const arrive = at(addDays(day, wait), '10:00');
                parcels.push({ id: `${date}:${item}`, item, ordered: date, arrive, deadline: formatDate(addDays(arrive, p.keepDays - 1)) });
        }

        // 楼下的猫：晚上空的时候下楼；下雨、不在学校、猫粮没了不去；晚上有课就下课后去，窗口里都在上课就不去
        if (world.cat) {
            const cat = world.cat;
            const [from, to] = cat.feed;
            const span = minutes(to) - minutes(from);
            const planned = at(day, from).getTime() + Math.floor(unit(`${date} cat time`) * Math.max(1, span - 30)) * 60_000;
            let time = new Date(planned);
            const blocking = lessons.find(l => l.start <= time && time < l.end);
            if (blocking) time = new Date(blocking.end.getTime() + 10 * 60_000);
            const skipped = !atSchool ? 'away' : record.weather?.rain ? 'rain' : food <= 0 ? 'no_food' : time > at(day, to) ? 'class' : undefined;
            if (skipped) record.cat = { skipped, foodAfter: food };
            else {
                food -= 1;
                record.cat = { fed: time, seen: unit(`${date} cat seen`) < cat.seenChance, planned: clock(time), foodAfter: food };
            }
            // 剩得少了就下单（没有在路上的）
            if (food <= cat.food.reorderAt && !parcels.some(p => p.food && !p.picked && !p.returned)) {
                const arrive = at(addDays(day, FOOD_ARRIVE_DAYS), '10:00');
                parcels.push({ id: `${date}:猫粮`, item: '猫粮', ordered: date, arrive, deadline: formatDate(addDays(arrive, (world.parcels?.keepDays ?? 3) - 1)), food: true });
            }
            // W3：她已经说自己喂过，就以实际说出的动作为准；原计划当天也会喂时不重复扣猫粮。
            const action = todayActions.filter(a => a.kind === 'feed_cat').at(-1);
            if (action) {
                const wasFed = Boolean(record.cat?.fed);
                if (!wasFed) food = Math.max(0, food - 1);
                const time = new Date(action.at);
                record.cat = {
                    fed: time,
                    ...(action.seen !== undefined ? { seen: action.seen } : record.cat?.seen !== undefined ? { seen: record.cat.seen } : {}),
                    planned: clock(time),
                    foodAfter: food,
                };
            }
        }

        // 作业：这几种课每节按概率留，下次这门课之前交；多半拖到交的前一晚写
        if (world.homework) {
            const hw = world.homework;
            for (const lesson of lessons) {
                if (!hw.kinds.includes(lesson.kind) || unit(`${date} ${clock(lesson.start)} homework`) >= hw.chance) continue;
                const due = nextLesson(schedule, lesson, day);
                if (!due) continue;
                const early = unit(`${date} ${clock(lesson.start)} homework early`) < hw.earlyChance;
                const done = early ? at(day, '21:30') : at(addDays(startOfDay(due), -1), '22:00');
                // 晚上的课下课比 21:30 还晚时，写完的时刻往后挪到下课后一小时
                homework.push({
                    id: `${date}:${lesson.id!}`,
                    course: lesson.name ?? '', assigned: date, due, done: new Date(Math.max(done.getTime(), lesson.end.getTime() + 3_600_000)),
                });
            }
            // W3：只改已经存在、当时还没交的作业；说清课名时优先对那一份。
            for (const action of todayActions.filter(a => a.kind === 'finish_homework')) {
                const time = new Date(action.at);
                const available = homework.filter(item => item.assigned <= date && item.due > time && item.done > time);
                const matched = action.target ? available.find(item => item.id === action.target) : action.subject
                    ? available.find(item => item.course.includes(action.subject!) || action.subject!.includes(item.course))
                    : available[0];
                if (matched) matched.done = time;
            }
        }

        // 相机基金：每周那天晚上存一笔，到目标就停
        if (world.cameraFund && (day.getDay() || 7) === world.cameraFund.depositDay && saved < world.cameraFund.goal) {
            saved = Math.min(world.cameraFund.goal, saved + world.cameraFund.weekly);
            deposits.push({ at: at(day, DEPOSIT_TIME), saved });
        }

        // 和家里视频
        if (world.familyCall && atSchool && (day.getDay() || 7) === world.familyCall.weekday) record.call = at(day, world.familyCall.time);
        const called = todayActions.filter(a => a.kind === 'family_call').at(-1);
        if (world.familyCall && called) record.call = new Date(called.at);

        // W3：她说已经取了快递，只能对上确实已经到站、没有退回的那一件；不凭一句话凭空造包裹。
        for (const action of todayActions.filter(a => a.kind === 'pick_parcel')) {
            const time = new Date(action.at);
            const available = parcels.filter(parcel => !parcel.returned && parcel.arrive <= time && (!parcel.picked || parcel.picked > time));
            const matched = action.target ? available.find(parcel => parcel.id === action.target) : action.subject
                ? available.find(parcel => parcel.item.includes(action.subject!) || action.subject!.includes(parcel.item))
                : available[0];
            if (matched) matched.picked = time;
        }

        // 学校和宿舍里的小事
        for (const event of world.events) {
            if (event.weekday && (day.getDay() || 7) !== event.weekday) continue;
            const ok = event.when === 'any' || (event.when === 'school' ? atSchool : atSchool && lessons.length > 0);
            if (!ok || unit(`${date} ${event.id}`) >= event.chance) continue;
            const [from, to] = WINDOWS[event.window];
            const time = new Date(at(day, from).getTime() + Math.floor(unit(`${date} ${event.id} time`) * (minutes(to) - minutes(from))) * 60_000);
            record.events.push({ id: event.id, text: event.text, at: time, ...(event.person ? { person: event.person } : {}) });
        }
        record.events.sort((a, b) => a.at.getTime() - b.at.getTime());
    }
    return { days, parcels, homework, deposits };
}

/** 某一刻她身边的事实（按她的一天：凌晨 2 点前算前一天） */
export function worldAt(world: World, schedule: Schedule, now: Date, actions: readonly WorldAction[] = []): WorldNow | undefined {
    const day = herDay(schedule, now);
    if (day < parseDate(world.startDay)) return undefined;
    // until 必须保留具体时刻：W3 动作按说出时间生效；只传 day 会把今天的动作都挡在 00:00 之后。
    const timeline = simulateWorld(world, schedule, now, actions);
    const date = formatDate(day);
    const record = timeline.days.get(date)!;
    const yesterday = timeline.days.get(formatDate(addDays(day, -1)));
    const result: WorldNow = { day: date, atSchool: record.atSchool, parcels: [], homework: [], events: [] };
    if (record.weather) result.weather = record.weather;
    if (world.cat && record.cat) {
        const c = record.cat;
        const today = c.fed && c.fed <= now ? { fed: c.fed, ...(c.seen !== undefined ? { seen: c.seen } : {}) }
            : c.fed ? { later: world.cat.feed[0] }
                : { skipped: c.skipped! };
        // 还没去的时候，猫粮按昨天晚上的算
        const foodDays = c.fed && c.fed > now ? c.foodAfter + 1 : c.foodAfter;
        result.cat = { name: world.cat.name, today, yesterdayFed: Boolean(yesterday?.cat?.fed), foodDays };
    }
    for (const parcel of timeline.parcels) {
        if (parcel.returned) continue;
        if (parcel.picked && parcel.picked <= now) {
            if (formatDate(parcel.picked) === date) result.parcels.push({ item: parcel.item, status: 'picked_today', when: parcel.picked });
        } else if (parcel.arrive <= now) {
            result.parcels.push({ item: parcel.item, status: 'station', when: parcel.arrive, deadline: parcel.deadline });
        } else if (parcel.arrive.getTime() - startOfDay(now).getTime() < 2 * DAY_MS && parcel.ordered <= date) {
            result.parcels.push({ item: parcel.item, status: 'arriving', when: parcel.arrive });
        }
    }
    if (world.cameraFund) {
        const last = timeline.deposits.filter(d => d.at <= now).at(-1);
        result.cameraFund = { saved: last?.saved ?? world.cameraFund.saved, goal: world.cameraFund.goal };
    }
    for (const item of timeline.homework) {
        if (item.assigned > date || item.due <= now || item.due.getTime() - startOfDay(now).getTime() > 3 * DAY_MS) continue;
        result.homework.push({ course: item.course, due: item.due, done: item.done <= now, doneAt: item.done });
    }
    if (record.call) result.familyCall = { at: record.call, done: record.call <= now };
    for (const event of record.events) {
        if (event.at > now) continue;
        const person = event.person ? world.people.find(p => p.id === event.person) : undefined;
        result.events.push({ id: event.id, text: event.text.replaceAll('{person}', person?.name ?? '朋友'), at: event.at, ...(person ? { person: { name: person.name, relation: person.relation } } : {}) });
    }
    return result;
}

// ---------- 进提示词（W2） ----------

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 时间块里的一段「你那边」：只有事实（几点、几件、还剩几天），没有能原样说出口的整句；用不用、怎么说她自己定。
 * 没有可写的就不返回
 */
export function describeWorld(now: WorldNow, at: Date): string | undefined {
    const parts: string[] = [];
    if (now.weather) parts.push(`天气：${now.weather.rain ? '下雨' : '没下雨'}，${now.weather.low}–${now.weather.high}℃`);
    if (now.cat) {
        const { today } = now.cat;
        // 昨天的也写上（第一批：今天喂过时不写昨天，他问「昨天喂了吗」她编了个「昨天没去」）
        const yesterday = now.cat.yesterdayFed ? '昨天喂过' : '昨天没喂';
        const seen = 'fed' in today && today.seen !== undefined ? `，${today.seen ? '见到了' : '没见着'}` : '';
        const state = 'fed' in today ? `今天 ${clock(today.fed)} 下楼喂过${seen}；${yesterday}`
            : 'later' in today ? `今天还没下楼喂，晚上空了再去；${yesterday}`
                : today.skipped === 'rain' ? `今天下雨没下楼；${yesterday}`
                    : today.skipped === 'no_food' ? `猫粮没了，新的在路上，今天没喂；${yesterday}`
                        : today.skipped === 'class' ? `今天晚上有课，没下楼；${yesterday}`
                            : '';
        const food = now.cat.foodDays <= 3 && !('skipped' in today && today.skipped === 'no_food') ? `，猫粮只够 ${Math.max(0, now.cat.foodDays)} 天了` : '';
        if (state) parts.push(`${now.cat.name}（楼下的流浪猫）：${state}${food}`);
    }
    if (now.parcels.length) {
        parts.push(`快递：${now.parcels.map(p => p.status === 'station' ? `${p.item}在驿站，还没取（${short(p.deadline!)} 前）`
            : p.status === 'picked_today' ? `${p.item}今天取了`
                : `${p.item}${sameDay(p.when, at) ? '今天' : '明天'}到`).join('；')}`);
    }
    if (now.homework.length) {
        // 看不到课名的档位，几份一样的合成一条
        const lines = new Map<string, number>();
        for (const h of now.homework) {
            // 先写写没写完、再写哪天交：问「作业写完没」时先看到的就是答案
            const line = `${h.course ? `${h.course}的作业` : '作业'}${h.done ? '已经写完了' : '还没写'}（${dueWord(h.due, at)}交）`;
            lines.set(line, (lines.get(line) ?? 0) + 1);
        }
        parts.push(`作业：${[...lines].map(([line, n]) => (n > 1 ? `${n} 份${line}` : line)).join('；')}`);
    }
    if (now.cameraFund) parts.push(`攒钱买相机：${now.cameraFund.saved} / ${now.cameraFund.goal} 元`);
    if (now.familyCall) parts.push(now.familyCall.done ? `今晚 ${clock(now.familyCall.at)} 和家里视频过了` : `今晚 ${clock(now.familyCall.at)} 要和家里视频`);
    if (now.events.length) {
        const people = [...new Map(now.events.flatMap(e => (e.person ? [[e.person.name, e.person.relation] as const] : []))).entries()];
        parts.push(`今天的小事：${now.events.map(e => e.text).join('；')}${people.length ? `（${people.map(([name, relation]) => `${name}：${relation}`).join('；')}）` : ''}`);
    }
    if (!parts.length) return undefined;
    return `[你那边（今天到现在的事实，用不用、怎么说你自己定，别照着念；这里没写的别编）：${parts.join('｜')}]`;
}

/**
 * 写日记用（ADR 0026）：那一天里**值得记一笔**的事，一件一句。天天一样的（没下雨、照常喂了猫、还有几份作业没写）不写：
 * 第一批日记把这些都写进去，召回时挤掉了那天真正的事（跟鸽鸽说过的麻辣烫）。
 * 日记进公共库，所以调用方传的是同学档的卡算出来的世界（宿舍、室友、闺蜜、相机基金、课名这些同学档看不到的块本来就不在里面）
 */
export function diaryWorld(now: WorldNow): string[] {
    const lines: string[] = [];
    if (now.weather?.rain) lines.push('下雨了');
    if (now.cat) {
        const { today } = now.cat;
        const cat = 'fed' in today ? (today.seen === false ? `下楼喂${now.cat.name}没见着它` : '')
            : 'skipped' in today ? (today.skipped === 'rain' ? `下雨没下楼喂${now.cat.name}` : today.skipped === 'no_food' ? '猫粮没了，没喂成' : today.skipped === 'class' ? '晚上有课，没下楼喂猫' : '')
                : '';
        if (cat) lines.push(cat);
    }
    for (const parcel of now.parcels) {
        if (parcel.status === 'picked_today') lines.push(`去驿站取了快递（${parcel.item}）`);
        else if (parcel.status === 'station') lines.push(`快递（${parcel.item}）到驿站了，还没去取`);
    }
    // 只算这一天写完的；晚上九点以后写完的是熬夜赶的（第二批：日记先写「写完两份」又写「一个字没动」，聊天里她 21:30 还没动笔）
    const doneToday = now.homework.filter(h => h.done && formatDate(h.doneAt) === now.day);
    const late = doneToday.filter(h => h.doneAt.getHours() >= 21).length;
    if (late) lines.push(`熬夜写完了 ${late} 份作业`);
    if (doneToday.length > late) lines.push(`写完了 ${doneToday.length - late} 份作业`);
    if (now.familyCall?.done) lines.push('晚上和家里视频了');
    for (const event of now.events) lines.push(event.text);
    return lines;
}

/** 一天的摘要（日志、state.json 用，不含聊天内容） */
export function summarizeWorld(now: WorldNow): string {
    const bits = [
        now.weather ? `${now.weather.rain ? '下雨' : '没下雨'} ${now.weather.low}–${now.weather.high}℃` : undefined,
        now.atSchool ? undefined : '不在学校',
        now.cat ? `${now.cat.name} 猫粮够 ${now.cat.foodDays} 天` : undefined,
        now.parcels.length ? `快递 ${now.parcels.length} 件` : undefined,
        now.homework.length ? `作业 ${now.homework.length} 份` : undefined,
        now.cameraFund ? `相机基金 ${now.cameraFund.saved}/${now.cameraFund.goal}` : undefined,
    ].filter(Boolean);
    return `今天（${now.day.slice(5)}）：${bits.join('；')}`;
}

/** 按她的一天去重：这一天第一次调用时写一行摘要，dir 给了就写 state.json（那一刻算出来的事实） */
export function worldLogger(world: World, schedule: Schedule, log: (message: string) => void, dir?: string): (now: Date) => void {
    let logged: string | undefined;
    return now => {
        const day = formatDate(herDay(schedule, now));
        if (day === logged) return;
        logged = day;
        const state = worldAt(world, schedule, now);
        if (!state) return;
        log(`她的世界：${summarizeWorld(state)}`);
        if (!dir) return;
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'state.json'), `${JSON.stringify({ at: now.toISOString(), ...state }, null, 2)}\n`);
        } catch (error) {
            log(`她的世界：state.json 写不了（${error instanceof Error ? error.message : String(error)}）`);
        }
    };
}

// ---------- 说出口的行为回写（W3） ----------

interface WorldActionsFile {
    actions: WorldAction[];
}

export interface WorldState {
    /** 用任一档位可见的世界计算同一现实；动作是全局共享的。 */
    at(world: World, schedule: Schedule, now: Date): WorldNow | undefined;
    /** 每天第一轮写摘要和 state.json。 */
    note(now: Date): void;
    /** 一段对话抽完后，把她已经声称做完的动作落盘。 */
    record(contact: Contact, episode: Episode, drafts: readonly WorldActionDraft[]): void;
    /** 测试、状态页和诊断用。 */
    actions(): readonly WorldAction[];
}

const ACTION_KINDS = new Set<WorldActionKind>(['feed_cat', 'pick_parcel', 'finish_homework', 'family_call']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 全局世界状态：<dataDir>/world/actions.json 是她已经说出口并做完的事。 */
export function worldState(
    world: World,
    schedule: Schedule,
    log: (message: string) => void,
    dir: string,
    nowFn: () => number = Date.now,
): WorldState {
    mkdirSync(dir, { recursive: true });
    const actionsPath = join(dir, 'actions.json');
    const statePath = join(dir, 'state.json');
    const loaded = readJsonOr<Partial<WorldActionsFile>>(actionsPath, {}, message => log(`她的世界：${message}`));
    let actions = (Array.isArray(loaded.actions) ? loaded.actions : []).filter(validAction);
    let logged: string | undefined;

    const persistState = (now: Date) => {
        const state = worldAt(world, schedule, now, actions);
        if (state) writeJsonAtomic(statePath, { at: now.toISOString(), ...state });
    };
    const safely = (work: () => void, what: string) => {
        try { work(); }
        catch (error) { log(`她的世界：${what}失败（${error instanceof Error ? error.message : String(error)}）`); }
    };

    return {
        at: (visibleWorld, visibleSchedule, now) => worldAt(visibleWorld, visibleSchedule, now, actions),
        note: now => {
            const day = formatDate(herDay(schedule, now));
            if (day === logged) return;
            logged = day;
            const state = worldAt(world, schedule, now, actions);
            if (!state) return;
            log(`她的世界：${summarizeWorld(state)}`);
            safely(() => persistState(now), 'state.json 写入');
        },
        record: (contact, episode, drafts) => {
            const assistant = episode.messages.filter(message => message.role === 'assistant');
            if (!assistant.length || !drafts.length) return;
            const added: WorldAction[] = [];
            for (const [i, draft] of drafts.entries()) {
                if (!ACTION_KINDS.has(draft.kind)) continue;
                // 模型给的时刻必须能和片段里她的一句话对上，防止抽取器凭空造时间。
                const message = assistant.findLast(item => localMinute(new Date(item.time)) === draft.at);
                if (!message) continue;
                const at = new Date(message.time);
                if (!Number.isFinite(at.getTime()) || at.getTime() > nowFn()) continue;
                const day = formatDate(herDay(schedule, at));
                if (day < world.startDay) continue;
                const subject = draft.subject?.trim().slice(0, 40) || undefined;
                // 同一天向不同人重复说同一件事，不重复改变世界；有物品/课程名时分别算。
                const sameDayKind = (action: WorldAction) => action.day === day && action.kind === draft.kind;
                // 任一边没说清物品 / 课程时保守地当成同一件，避免“Linux 作业写完”换个人说成“作业写完”后误完成第二份。
                if ([...actions, ...added].some(action => sameDayKind(action)
                    && (!subject || !action.subject || action.subject === subject))) continue;
                // 她只能改变卡上确实存在的东西；快递和作业在最完整档位解析成稳定 ID，低档位没有课名也能改同一件。
                let target: string | undefined;
                if (draft.kind === 'feed_cat' && !world.cat) continue;
                if (draft.kind === 'family_call' && !world.familyCall) continue;
                if (draft.kind === 'pick_parcel' || draft.kind === 'finish_homework') {
                    const timeline = simulateWorld(world, schedule, at, actions);
                    if (draft.kind === 'pick_parcel') {
                        const available = timeline.parcels.filter(parcel => !parcel.returned && parcel.arrive <= at && (!parcel.picked || parcel.picked > at));
                        const matched = subject
                            ? available.find(parcel => parcel.item.includes(subject) || subject.includes(parcel.item))
                            : available[0];
                        if (!matched) continue;
                        target = matched.id;
                    } else {
                        const available = timeline.homework.filter(item => item.assigned <= day && item.due > at && item.done > at);
                        const matched = subject
                            ? available.find(item => item.course.includes(subject) || subject.includes(item.course))
                            : available[0];
                        if (!matched) continue;
                        target = matched.id;
                    }
                }
                if (target && [...actions, ...added].some(action => sameDayKind(action) && action.target === target)) continue;
                const action: WorldAction = {
                    id: `${contact.qq}:${episode.id}:${i + 1}:${draft.kind}`,
                    kind: draft.kind,
                    day,
                    at: localMinute(at),
                    contact: contact.qq,
                    episode: episode.id,
                    ...(subject ? { subject } : {}),
                    ...(target ? { target } : {}),
                    ...(draft.kind === 'feed_cat' && draft.seen !== undefined ? { seen: draft.seen } : {}),
                };
                added.push(action);
            }
            if (!added.length) return;
            const next = [...actions, ...added].sort((a, b) => a.at.localeCompare(b.at));
            // actions.json 是事实来源：写不进去就抛给片段抽取器，下次同步重试；不能只让本进程假装成功。
            writeJsonAtomic(actionsPath, { actions: next });
            actions = next;
            for (const action of added) log(`她的世界：[${contact.qq}] ${actionLabel(action, world)}`);
            safely(() => persistState(new Date(nowFn())), 'state.json 写入');
        },
        actions: () => actions,
    };
}

function validAction(value: unknown): value is WorldAction {
    if (!value || typeof value !== 'object') return false;
    const action = value as Partial<WorldAction>;
    return typeof action.id === 'string' && typeof action.contact === 'number' && typeof action.episode === 'string'
        && typeof action.day === 'string' && DATE_ONLY.test(action.day)
        && typeof action.at === 'string' && LOCAL_MINUTE.test(action.at) && Number.isFinite(new Date(action.at).getTime())
        && typeof action.kind === 'string' && ACTION_KINDS.has(action.kind as WorldActionKind)
        && (action.subject === undefined || typeof action.subject === 'string')
        && (action.target === undefined || typeof action.target === 'string')
        && (action.seen === undefined || typeof action.seen === 'boolean');
}

function localMinute(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function actionLabel(action: WorldAction, world: World): string {
    const subject = action.subject ? `（${action.subject}）` : '';
    if (action.kind === 'feed_cat') return `${clock(new Date(action.at))} 喂了${world.cat?.name ?? '猫'}`;
    if (action.kind === 'pick_parcel') return `${clock(new Date(action.at))} 取了快递${subject}`;
    if (action.kind === 'finish_homework') return `${clock(new Date(action.at))} 写完作业${subject}`;
    return `${clock(new Date(action.at))} 和家里视频了`;
}

// ---------- 读卡 ----------

/** 校验卡上的 extensions.qqbot.world（转换器写的，手改坏了要早报错）；没有就是 undefined */
export function parseWorld(value: unknown, source: string): World | undefined {
    if (value === undefined || value === null) return undefined;
    const fail = (what: string): never => { throw new Error(`${source}：extensions.qqbot.world${what}`); };
    const obj = (v: unknown, where: string) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${where} 应为对象`));
    const w = obj(value, '');
    if (typeof w.startDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.startDay)) fail('.startDay 应为 YYYY-MM-DD');
    if (!Array.isArray(w.awayHolidays) || !Array.isArray(w.events) || !Array.isArray(w.people)) fail(' 缺 awayHolidays / people / events');
    for (const [i, e] of (w.events as unknown[]).entries()) {
        const event = obj(e, `.events[${i}]`);
        if (typeof event.text !== 'string' || !(String(event.window) in WINDOWS) || typeof event.chance !== 'number') fail(`.events[${i}] 格式不对`);
    }
    if (w.cat) {
        const cat = obj(w.cat, '.cat');
        if (!Array.isArray(cat.feed) || cat.feed.length !== 2) fail('.cat.feed 应为 [开始, 结束]');
    }
    parseBody(w.body, fail);
    return value as World;
}

// ---------- 小工具 ----------

function weatherOn(weather: NonNullable<World['weather']>, day: Date): { rain: boolean; low: number; high: number } {
    const date = formatDate(day);
    const [low, high] = weather.temps[String(day.getMonth() + 1)]!;
    const shift = Math.floor(unit(`${date} temp`) * 5) - 2;
    const rain = unit(`${date} rain`) < weather.rainChance;
    return { rain, low: low + shift, high: high + shift - (rain ? 3 : 0) };
}

/** 同一门课下一次上（有课名按课名，没有按星期几和开始时间），三周内找不到就不留 */
function nextLesson(schedule: Schedule, lesson: ClassToday, day: Date): Date | undefined {
    for (let i = 1; i <= 21; i++) {
        const next = addDays(day, i);
        const found = classesOn(schedule, next).lessons.find(l => l.id === lesson.id);
        if (found) return found.start;
    }
    return undefined;
}

function inLesson(lessons: readonly ClassToday[], time: Date): boolean {
    return lessons.some(l => l.start <= time && time < l.end);
}

function dueWord(due: Date, now: Date): string {
    const days = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / DAY_MS);
    if (days === 0) return `今天 ${clock(due)} 前`;
    if (days === 1) return '明天';
    if (days === 2) return '后天';
    return WEEKDAYS[due.getDay()]!;
}

function sameDay(a: Date, b: Date): boolean {
    return formatDate(a) === formatDate(b);
}

function short(date: string): string {
    return date.slice(5);
}

/** 0 ≤ x < 1，FNV-1a（和作息、心情的固定选法一致） */
function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x1_0000_0000;
}

function minutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h! * 60 + m!;
}

function clock(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function at(day: Date, time: string): Date {
    const [h, m] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function parseDate(text: string): Date {
    const [y, m, d] = text.split('-').map(Number);
    return new Date(y!, m! - 1, d);
}
