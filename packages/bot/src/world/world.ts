// 她的世界（ADR 0021 W1、W2；ADR 0027 W3）：卡上的 extensions.qqbot.world（source/world.yml 按档位裁剪）→ 某一刻她身边的事实。
// - 从 startDay（学期开始）一天一天推到今天：天气、楼下的猫（喂没喂、猫粮还剩几天、没了就网购）、快递（下单 → 到驿站 → 取 / 退回）、
//   作业（上课时留、下次这门课之前交、多半拖到前一晚写）、相机基金（每周存一点）、和家里视频、学校和宿舍里的小事。
// - 随机都按「日期 + 名目」取哈希，同一天对所有人一样（各档的卡只是看得到的块不同），重启、重放都一样，不存随机状态；
//   每天的结果另写一份 <dataDir>/world/state.json 供查看；生活事件写在 events.json，actions.json 保留为旧版本兼容投影。
// - 进提示词的只有事实和约束（describeWorld），不写能原样照抄的整句（DSH 原则 1）；到「现在」为止发生了的才写，没发生的不写。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '.././config.ts';
import { readJsonOr, writeJsonAtomic } from '.././json-file.ts';
import { dishNote, dishOn, type Menu } from '.././menu.ts';
import type { Episode } from '.././memory/episodes.ts';
import { classesOn, formatDate, herDay, wakeOn, type ClassToday, type Schedule } from '.././schedule.ts';
import { realWeather, type DayWeather } from './weather.ts';
import { bodyAt, parseBody, unwell, type Body, type BodyNow } from '.././body.ts';
import { DEFAULT_NEWS_KINDS, type NewsKind } from '.././proactive.ts';
import { EVERYDAY_EVENT_DEFS, EVERYDAY_MAX_PER_DAY, quizEvents, type EventFeel } from '.././everyday.ts';
import { readLifeEvents, writeLifeEvents, type LifeEvent, type LifeEventDraft } from './life-events.ts';
import { describeNpc, npcAllows, npcSpans, npcStates, type NpcLife, type NpcState, type NpcStateKind } from './npc.ts';
import { DEFAULT_ASKS, judgeAsk, npcAsksOn, type AskFacts, type AskOutcome, type NpcAsk } from './npc-asks.ts';
import type { Plans } from '.././day-plan.ts';
import { ASK_HOME_TIME, depositFor, lastPayday, MISC_TIME, nextPayday, ORDER_TIME, PAY_TIME, parcelPrice, priceIn, sideJobOn, spendItems, type Money, type MoneyEntry } from '.././money.ts';

export type WorldWindow = 'morning' | 'afternoon' | 'evening';

export interface World {
    startDay: string;
    awayHolidays: string[];
    weather?: { rainChance: number; temps: Record<string, [number, number]> };
    cat?: { name: string; feed: [string, string]; seenChance: number; food: { bagDays: number; left: number; reorderAt: number } };
    /** afterMealFrom：从这天起取件的时刻撞上饭点就吃完再去（ADR 0042）；之前的日子照旧 */
    parcels?: { perWeek: number; arriveDays: [number, number]; keepDays: number; items: string[]; afterMealFrom?: string };
    cameraFund?: {
        goal: number; saved: number; weekly: number; depositDay: number;
        /** 攒够以后哪天去买（用户 10-10「这周末去买」）：那天 from 出门 minutes 分钟，去 where 买 what，花 price；那天钱不够就不买 */
        purchase?: { date: string; from: string; minutes: number; where: string; what: string; price: number };
    };
    homework?: { kinds: string[]; chance: number; earlyChance: number };
    familyCall?: { weekday: number; time: string };
    /** life：她们自己的日子（ADR 0033，npc.ts） */
    people: { id: string; name: string; relation: string; life?: NpcLife }[];
    /** skipWhen / onlyWhen：person 那天的状态（ADR 0033）：她感冒了就不一起吃饭，感冒了才有「帮她拍板书」 */
    events: {
        id: string; text: string; person?: string; window: WorldWindow; chance: number; when: 'school' | 'class_day' | 'any' | 'off_day'; weekday?: number; skipWhen?: NpcStateKind[]; onlyWhen?: NpcStateKind[];
        /** 花了钱（ADR 0035） */
        cost?: { amount: [number, number]; what: string };
        /** 以下是补充的日常小事才有的（ADR 0106，everyday.ts）：星期几 / 哪几个月 / 天气 / 一天一组最多一件 / 在她心里留下什么 / 要土豆见到了没见到 / 买了相机以后 */
        weekdays?: number[]; months?: number[]; weather?: 'rain' | 'dry' | 'cold' | 'hot'; group?: string; feel?: EventFeel;
        requires?: 'cat_seen' | 'cat_unseen'; afterCamera?: boolean; everyday?: boolean;
    }[];
    /** 小测的一条线开着（ADR 0106）：前一次课老师说、当天写、两天后出分 */
    quizzes?: boolean;
    /** 补充的小事和小测从这一天起才有（ADR 0106）：她已经过完的日子不被改写、不凭空多出没发生过的小测 */
    everydayFrom?: string;
    /** 每顿吃什么（ADR 0125，配置 menu）：菜单；有它，午饭 / 晚饭才有“吃的是什么”（日期的函数，不存状态） */
    menu?: Menu;
    /** 菜单从这一天起才有（ADR 0125）：她已经过完的日子不被改写 */
    menuFrom?: string;
    /** 她的身体（ADR 0025，body.ts） */
    body?: Body;
    /** 她的日常（ADR 0031）：午饭、晚饭、洗澡 */
    routine?: { lunch: { from: string; spread: number; minutes: number }; dinner: { from: string; spread: number; minutes: number }; takeoutChance: number; shower: { from: string; spread: number; minutes: [number, number]; chance: number } };
    /** 她一天的打算会改（ADR 0034，day-plan.ts） */
    plans?: Plans;
    /** 她的钱（ADR 0035，money.ts） */
    money?: Money;
    /** 闺蜜的约（ADR 0061，npc-asks.ts）：运行开关（配置 npcAsks，启动时和模拟器设上），不是卡上的块；没开就没有约 */
    asks?: boolean;
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
export type WorldActionKind = 'feed_cat' | 'pick_parcel' | 'finish_homework' | 'family_call' | 'receive_money';
/** 收到的钱说了是给她买相机的：动作的 target */
export const CAMERA_FUND_TARGET = 'camera_fund';
/** 一笔收到的钱最多认多少（防抽错） */
const MAX_GIFT = 50_000;

/** 模型抽取的形状；at 是那句已完成陈述所在的本地分钟（YYYY-MM-DDTHH:mm）。 */
export interface WorldActionDraft {
    kind: WorldActionKind;
    /** 必填：必须能和片段里她的一条消息对上，否则不回写。 */
    at: string;
    /** 快递物品或课程名；没说清时不填。 */
    subject?: string;
    /** 喂猫时明确说见到 / 没见到才填。 */
    seen?: boolean;
    /** receive_money：收到多少（整数元） */
    amount?: number;
    /** receive_money：说了是给她买相机的 */
    forCamera?: boolean;
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

/**
 * 闺蜜的一次约（ADR 0061）：她那一刻知道的样子。held：真的会发生（她答应了、对方没取消、改到的时间也没撞上别的事），占着一段时间；
 * 推掉的 declined 有理由；knownAt：她什么时候知道变了（迟到：到点没到；改约 / 取消：提前通知）
 */
export interface FriendDate {
    id: string;
    kind: string;
    person: { id: string; name: string; relation: string };
    what: string;
    doing: string;
    where?: string;
    askedAt: Date;
    start: Date;
    minutes: number;
    outcome: AskOutcome;
    actualStart?: Date;
    knownAt?: Date;
    reason?: string;
    declined?: string;
    /** 她推掉这件事的时刻：说的时候就推掉的是 askedAt；改约、迟到之后才撞上别的事的，是她知道变了的那一刻 */
    declinedAt?: Date;
    held: boolean;
}

/** 某一刻她身边的事实（到 now 为止发生了的） */
export interface WorldNow {
    day: string;
    atSchool: boolean;
    /** 真实天气有数据的日子带 real、这一刻的天况、下过雨的钟头（ADR 0048）；没有的按日期生成 */
    weather?: DayWeather;
    cat?: {
        name: string;
        /** 今天：喂了（几点、见没见到）/ 还没去（几点以后）/ 不去（为什么） */
        today: { fed: Date; seen?: boolean } | { later: string } | { skipped: 'rain' | 'away' | 'no_food' | 'class' };
        yesterdayFed: boolean;
        foodDays: number;
    };
    /** 在驿站的、今天取了的、今明两天到的 */
    parcels: { item: string; status: 'station' | 'picked_today' | 'arriving'; when: Date; deadline?: string }[];
    /** lastDeposit：最近一次存（7 天内；存 0 也算，那周钱要留着花）——有钱的规则时才有（ADR 0035） */
    cameraFund?: {
        saved: number; goal: number; lastDeposit?: { at: Date; amount: number };
        /** 买相机那一趟（那天及以后）：出门前是 planned，在外面是 buying，回来以后是 bought */
        camera?: CameraTrip & { state: 'planned' | 'buying' | 'bought' };
        /** 攒够了、明天就去买：前一天就知道 */
        tomorrow?: { start: Date; where: string; what: string };
    };
    /** 三天内要交的 */
    /** doneAt：几点写完（还没到就是打算几点写），日记用 */
    /** assigned：哪天布置的（她的一天）；约好之后才布置的作业算新的障碍（ADR 0066） */
    homework: { course: string; due: Date; done: boolean; doneAt: Date; assigned?: string }[];
    familyCall?: { at: Date; done: boolean };
    /** 她这一天的日常（ADR 0031）：午饭、晚饭在哪吃、几点到几点；洗澡几点到几点（不洗的日子没有） */
    routine?: { meals: { kind: 'lunch' | 'dinner'; start: Date; end: Date; where: 'canteen' | 'takeout' | 'home'; /** 吃的是什么（ADR 0125，配置 menu） */ dish?: string }[]; shower?: { start: Date; end: Date } };
    /** 今天已经发生的小事（text 已换好人名） */
    events: { id: string; text: string; at: Date; person?: { id: string; name: string; relation: string }; feel?: EventFeel }[];
    /** 她身边的人今天怎么样（ADR 0033）：只有有事的（病了、忙、回家了） */
    people?: { name: string; relation: string; states: NpcState[] }[];
    /** 她的钱（ADR 0035）：手上还有多少、下次几号到账、今天到现在花的；detail 是这一档说得出口 */
    /** askedHome：这个月（上次到账以后）跟家里多要了多少 */
    money?: { balance: number; nextPay: Date; today: { what: string; amount: number }[]; askedHome: number; detail: boolean };
    /** 闺蜜的约（ADR 0061，开着 World.asks 才有）：今天、明天的，已经说到她这里的 */
    dates?: FriendDate[];
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
    weather?: DayWeather;
    cat?: { fed?: Date; seen?: boolean; planned?: string; skipped?: 'rain' | 'away' | 'no_food' | 'class'; foodAfter: number };
    events: { id: string; text: string; at: Date; person?: string; feel?: EventFeel }[];
    call?: Date;
}

/** 买相机那一趟；gifts：相机基金里别人给的那几笔（谁、存进去多少），没有就是全靠自己攒的 */
export interface CameraTrip { start: Date; end: Date; where: string; what: string; price: number; gifts?: { contact: number; amount: number }[] }

/** 她那边刚发生、想第一时间告诉他的事（ADR 0057、0064，主动消息「她那边的事」）：kind 是事件类（买到相机 ADR 0053、赶完作业、一段不舒服的第一天）；at 是事情了结的时刻 */
export interface WorldNews { id: string; kind: NewsKind; at: Date; what: string; dish?: string; /** 这件小事让她有什么感觉（small_thing 用，ADR 0152）：说它的由头 */ feel?: EventFeel['kind'] }

/** 世界里定好了几点去做、占掉她一段空闲的事（ADR 0034 的打算里写这件）：现在只有买相机那一趟（ADR 0053），只在那一天 */
export function worldErrands(now: WorldNow): { start: Date; end: Date; text: string }[] {
    const camera = now.cameraFund?.camera;
    return camera && formatDate(camera.start) === now.day ? [{ start: camera.start, end: camera.end, text: `去${camera.where}买相机` }] : [];
}

/** 喂完见到土豆的日子里，这一天拍了照片的概率（平均一周两三次，不是天天） */
export const CAT_PHOTO_CHANCE = 0.35;
/** 喂完过了多久想起来发（分钟范围） */
const CAT_PHOTO_DELAY_MIN: [number, number] = [8, 25];

/**
 * 喂完土豆、见到它的日子里，有的天她拍了张照片想发给他（ADR 0110）：按“日期”取哈希，同一天每次一样。
 * 了结的时刻 = 喂完之后几分钟；没见到它的天没有照片可拍
 */
function newsCatPhoto(now: WorldNow): WorldNews[] {
    const cat = now.cat;
    if (!cat || !('fed' in cat.today) || cat.today.seen !== true) return [];
    if (unit(`${now.day} cat photo`) >= CAT_PHOTO_CHANCE) return [];
    const delay = CAT_PHOTO_DELAY_MIN[0] + Math.floor(unit(`${now.day} cat photo delay`) * (CAT_PHOTO_DELAY_MIN[1] - CAT_PHOTO_DELAY_MIN[0] + 1));
    return [{ id: `cat_photo:${now.day}`, kind: 'cat_photo', at: new Date(cat.today.fed.getTime() + delay * 60_000), what: `给${cat.name}拍了张照片` }];
}

/** 吃饭时拍了照片发给他的概率（每顿；平均一周两三次）和拍完过多久想起来发（分钟范围） */
export const FOOD_PHOTO_CHANCE = 0.18;
const FOOD_PHOTO_DELAY_MIN: [number, number] = [6, 18];

/**
 * 吃饭时拍了张照片想发给他（ADR 0128，配置 foodPhotos，要 menu 开着）：每顿按“日期 + 哪一顿”取哈希，约 FOOD_PHOTO_CHANCE 的顿数有；
 * 了结的时刻 = 饭点开始之后几分钟。菜名跟着走，发的时候只拿这道菜的照片
 */
function newsFoodPhoto(now: WorldNow): WorldNews[] {
    return (now.routine?.meals ?? []).flatMap(meal => {
        if (!meal.dish || unit(`${now.day} ${meal.kind} food photo`) >= FOOD_PHOTO_CHANCE) return [];
        const delay = FOOD_PHOTO_DELAY_MIN[0] + Math.floor(unit(`${now.day} ${meal.kind} food photo delay`) * (FOOD_PHOTO_DELAY_MIN[1] - FOOD_PHOTO_DELAY_MIN[0] + 1));
        return [{ id: `food_photo:${now.day}:${meal.kind}`, kind: 'food_photo' as const, at: new Date(meal.start.getTime() + delay * 60_000), what: `${meal.kind === 'lunch' ? '午饭' : '晚饭'}吃的${meal.dish}`, dish: meal.dish }];
    });
}

/** 哪些小事她会主动讲（ADR 0127）：有来由、有点画面的；天气、身体、学习、家里的不单发（天气和身体本来有自己的地方说） */
export const SMALL_TELL_GROUPS: ReadonlySet<string> = new Set(['food', 'class', 'phone', 'dorm', 'leisure', 'social', 'cat', 'shop', 'photo']);
/** 有小事的日子里，约这么多天她会拿一件去告诉他（平均一周三四次，不是天天） */
export const SMALL_TELL_CHANCE = 0.5;
/** 小事发生后过多久想起来说（分钟范围） */
const SMALL_TELL_DELAY_MIN: [number, number] = [10, 40];

/**
 * 今天碰到的一件小事，她随口告诉他（ADR 0127，配置 smallNews，要 everydayLife 开着）：
 * 从当天已经发生的日常小事（ADR 0106）里挑一件（按日期取哈希，同一天每次一样），过 10–40 分钟想起来说；一天最多一件
 */
function newsSmallThing(now: WorldNow): WorldNews[] {
    if (unit(`${now.day} small tell`) >= SMALL_TELL_CHANCE) return [];
    const groups = new Map(EVERYDAY_EVENT_DEFS.map(def => [def.id, def.group] as const));
    const feels = new Map(EVERYDAY_EVENT_DEFS.map(def => [def.id, def.feel?.kind] as const));
    const tellable = now.events.filter(event => SMALL_TELL_GROUPS.has(groups.get(event.id) ?? ''));
    if (!tellable.length) return [];
    const pick = tellable[Math.floor(unit(`${now.day} small tell pick`) * tellable.length)]!;
    const delay = SMALL_TELL_DELAY_MIN[0] + Math.floor(unit(`${now.day} small tell delay`) * (SMALL_TELL_DELAY_MIN[1] - SMALL_TELL_DELAY_MIN[0] + 1));
    const feel = feels.get(pick.id);
    return [{ id: `small:${now.day}:${pick.id}`, kind: 'small_thing', at: new Date(pick.at.getTime() + delay * 60_000), what: pick.text, ...(feel ? { feel } : {}) }];
}

/** what 不带「刚」：没说成的留到这一天后面的主动里说（ADR 0057 调整）；钱从哪来写在「你那边」那一行，那一行按是谁在看说 */
function newsCamera(now: WorldNow): WorldNews[] {
    const camera = now.cameraFund?.camera;
    return camera ? [{ id: 'camera', kind: 'camera', at: camera.end, what: `在${camera.where}买到了${camera.what}` }] : [];
}

/**
 * 24 小时内到期的作业写完了（ADR 0064 决策 3，ADR 0056 的紧急口径）：早早写完的、离交还远的不算。
 * 同一天写完的几份并成一件（id 按她写完的那一天）；课名按这一档看不看得到（WorldNow 里没有就不写）
 */
function newsHomework(now: WorldNow): WorldNews[] {
    const byDay = new Map<string, WorldNow['homework']>();
    for (const h of now.homework) {
        if (!h.done || h.due.getTime() - h.doneAt.getTime() > DAY_MS) continue;
        const day = formatDate(h.doneAt);
        byDay.set(day, [...(byDay.get(day) ?? []), h]);
    }
    return [...byDay].map(([day, list]) => {
        const courses = [...new Set(list.map(h => h.course).filter(Boolean))];
        const what = courses.length ? `把${courses.join('、')}的作业写完了` : list.length > 1 ? `把 ${list.length} 份作业都写完了` : '把作业写完了';
        return { id: `homework:${day}`, kind: 'homework_done' as const, at: new Date(Math.max(...list.map(h => h.doneAt.getTime()))), what };
    });
}

/**
 * 她那边的事（ADR 0057、0064）：一个快照里能看到的。kinds 开了哪几类，不传 = 只有相机（回复里顺带说用，ADR 0057 的行为不变）。
 * 不舒服（unwell）不在这里：身体不在世界快照里，见 unwellNews
 */
export function worldNews(now: WorldNow, kinds: readonly NewsKind[] = DEFAULT_NEWS_KINDS): WorldNews[] {
    return [...(kinds.includes('food_photo') ? newsFoodPhoto(now) : []), ...(kinds.includes('small_thing') ? newsSmallThing(now) : []), ...(kinds.includes('cat_photo') ? newsCatPhoto(now) : []), ...(kinds.includes('camera') ? newsCamera(now) : []), ...(kinds.includes('homework_done') ? newsHomework(now) : []), ...(kinds.includes('friend_changed') ? newsFriend(now) : []), ...(kinds.includes('friend_sick') ? newsFriendSick(now) : [])];
}

/**
 * 闺蜜病了的头一天（ADR 0064 的新事件类 friend_sick）：npc.ts 的状态里 sick 的第 1 天；之后几天不再单发（被问到时「你那边」有「感冒第 N 天」）。
 * 了结的时刻 = 她得知的时刻：上午 9:00–11:30 之间按哈希取一刻（对方发来微信的时候），同一天同一个人每次一样。
 * 看得到这个人的档位才有（now.people 按档位裁过）
 */
function newsFriendSick(now: WorldNow): WorldNews[] {
    return (now.people ?? []).flatMap(person => {
        if (!person.states.some(state => state.kind === 'sick' && state.day === 1)) return [];
        const minute = 9 * 60 + Math.floor(unit(`${now.day} ${person.name} sick told`) * 150);
        const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        return [{ id: `friend_sick:${person.name}:${now.day}`, kind: 'friend_sick' as const, at: at(parseDate(now.day), time), what: `${person.name}感冒了` }];
    });
}

/** 改到这么久以后才算「变了」值得说（只晚一会儿的改约不单发） */
const FRIEND_MOVED_MIN_MINUTES = 60;

/**
 * 闺蜜的约变了（ADR 0061 第 2 步，ADR 0064 的新事件类）：约的那天是今天、她已经知道了——对方临时去不了了，或者改到至少晚一小时；
 * 她自己推掉的、迟到几分钟的不算（太小）。了结的时刻 = 她得知的时刻（knownAt）；理由已经按档位裁过（私事理由只给说得出口的档位），没有就不写。
 * 开着 World.asks 才有 dates
 */
function newsFriend(now: WorldNow): WorldNews[] {
    return (now.dates ?? []).flatMap(d => {
        if (d.declined || !d.knownAt || formatDate(d.start) !== now.day) return [];
        const why = d.reason ? `（${d.reason}）` : '';
        const base = `${d.person.name}约好 ${clock(d.start)} ${d.what}`;
        if (d.outcome === 'cancelled') return [{ id: `friend:${d.id}`, kind: 'friend_changed' as const, at: d.knownAt, what: `${base}，她临时去不了了${why}` }];
        if (d.outcome === 'moved' && d.actualStart && d.actualStart.getTime() - d.start.getTime() >= FRIEND_MOVED_MIN_MINUTES * 60_000) {
            return [{ id: `friend:${d.id}`, kind: 'friend_changed' as const, at: d.knownAt, what: `${base}，她说改到 ${clock(d.actualStart)}${why}` }];
        }
        return [];
    });
}

/**
 * 一段不舒服的第一天（ADR 0064 决策 3 + 确认记录 1）：她的这一天（15:00 看）不舒服、前一天不是——连着几天疼只说头一天，之后被问到再说。
 * 了结的时刻是她起床：一醒来就不舒服，是她那天第一件有话可说的事（到点时在上课、在睡觉的由计划器推后或不发）。
 * bodyAt 由调用方按这一档的卡给，说得出口的程度（生理期细节）跟着档位
 */
export function unwellNews(day: Date, schedule: Schedule, bodyAt: (time: Date) => BodyNow): WorldNews[] {
    const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 15);
    const today = bodyAt(noon);
    if (!unwell(today) || unwell(bodyAt(new Date(noon.getTime() - DAY_MS)))) return [];
    const parts: string[] = [];
    if (today.period?.cramps) {
        parts.push(today.period.detail
            ? `肚子${today.period.cramps === 'bad' ? '疼得厉害' : '隐隐地疼'}（生理期）`
            : today.period.cramps === 'bad' ? '身上不太舒服，只想躺着' : '身上有点不舒服');
    }
    if (today.cold) parts.push('有点感冒，嗓子疼');
    return [{ id: `unwell:${formatDate(day)}`, kind: 'unwell', at: wakeOn(schedule, day), what: parts.join('，') }];
}

/**
 * 相机的钱从哪来（ADR 0053 调整，10-11）：他 10-10 转了 2000 买相机，「攒的钱买的」跟他知道的对不上（模拟器里还说成「攒的钱到账了」）。
 * giver：给钱的人在这一行里怎么称呼（正在看的人自己给的写他的称呼，contact.ts 给）；不给就是「别人」
 */
function cameraMoney(camera: CameraTrip, giver?: (qq: number) => string | undefined): string {
    const given = (camera.gifts ?? []).reduce((sum, g) => sum + g.amount, 0);
    if (!given) return `${camera.price} 元，攒的钱买的`;
    const who = [...new Set(camera.gifts!.map(g => giver?.(g.contact) ?? '别人'))].join('、');
    return given >= camera.price ? `${camera.price} 元，${who}给的钱买的` : `${camera.price} 元：${who}给的 ${given} 加上你自己攒的 ${camera.price - given}`;
}

interface Timeline {
    days: Map<string, DayRecord>;
    /** 买了相机的那一趟（钱够、到了那天才有） */
    camera?: CameraTrip;
    parcels: Parcel[];
    homework: Homework[];
    /** 每次存钱的时刻、存了多少、存完的金额 */
    deposits: { at: Date; saved: number; amount: number }[];
    /** 她的账（ADR 0035）：卡上有钱的规则时才有 */
    ledger: MoneyEntry[];
}

/** 从 startDay 推到 until（含），按天记下发生的事；纯函数，同样的输入同样的输出 */
export function simulateWorld(world: World, schedule: Schedule, until: Date, actions: readonly WorldAction[] = []): Timeline {
    const days = new Map<string, DayRecord>();
    const parcels: Parcel[] = [];
    const homework: Homework[] = [];
    const deposits: { at: Date; saved: number; amount: number }[] = [];
    const ledger: MoneyEntry[] = [];
    const money = world.money;
    let balance = money?.start ?? 0;
    const book = (time: Date, amount: number, what: string, kind: MoneyEntry['kind']) => {
        if (!money) return;
        ledger.push({ at: time, amount, what, kind });
        balance += amount;
    };
    let food = world.cat?.food.left ?? 0;
    let saved = world.cameraFund?.saved ?? 0;
    /** 相机基金里别人给的那几笔（买相机时带上） */
    let fundGifts: { contact: number; amount: number }[] = [];
    let camera: CameraTrip | undefined;
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
        // 真实天气（ADR 0048）：在学校按济南、放假在家按青岛；没有数据的日子照旧按日期生成
        if (world.weather) record.weather = realWeather()?.day(atSchool ? 'jinan' : 'qingdao', date, until) ?? weatherOn(world.weather, day);

        // 快递：到了驿站的，在学校、不上课时取；有时拖一天；过了最后一天没取就退回
        // 取件的时刻撞上饭点（12:20 总落在午饭里，ADR 0040 验证一节）：从 afterMealFrom 那天起吃完饭再去（ADR 0042）；之前的日子照旧，过完的日子不被新规则改写
        const meals = world.parcels?.afterMealFrom && date >= world.parcels.afterMealFrom && world.routine ? routineOn(world.routine, schedule, day, atSchool).meals : [];
        const afterMeal = (time: Date) => {
            const walk = new Date(time.getTime() + OCCUPATION_MINUTES.parcel * 60_000);
            return meals.find(meal => meal.start < walk && time < meal.end)?.end ?? time;
        };
        for (const parcel of parcels) {
            if (parcel.picked || parcel.returned || parcel.arrive > endOfDay(day)) continue;
            if (date > parcel.deadline) { parcel.returned = true; continue; }
            const late = !parcel.food && unit(`${parcel.ordered} ${parcel.item} late`) < 0.4 && formatDate(parcel.arrive) === date && date < parcel.deadline;
            if (!atSchool || late) continue;
            const time = PICKUP_TIMES.map(t => afterMeal(at(day, t))).find(t => t >= parcel.arrive && !inLesson(lessons, t));
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
            // 真实天气按喂猫那个钟头和前一个钟头下没下（ADR 0048）：还没到点不知道，过了点照实际；生成的天气照旧按一整天
            const rainy = record.weather?.rainHours ? record.weather.rainHours.some(h => h >= time.getHours() - 1 && h <= time.getHours()) : record.weather?.rain;
            const skipped = !atSchool ? 'away' : rainy ? 'rain' : food <= 0 ? 'no_food' : time > at(day, to) ? 'class' : undefined;
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
            if (event.everyday) continue;
            // 开了闺蜜的约（ADR 0061）：和苏雨桐吃午饭只通过「约」发生，免得一天两顿
            if (world.asks && event.id === 'lunch_with_friend') continue;
            if (event.weekday && (day.getDay() || 7) !== event.weekday) continue;
            const ok = event.when === 'any' || (event.when === 'school' ? atSchool : atSchool && lessons.length > 0);
            if (!ok || unit(`${date} ${event.id}`) >= event.chance) continue;
            // 和谁的事看那人那天怎么样（ADR 0033）
            const person = event.person ? world.people.find(p => p.id === event.person) : undefined;
            if (person && !npcAllows(npcStates(person.id, person.life, schedule, day), event.skipWhen, event.onlyWhen)) continue;
            const [from, to] = WINDOWS[event.window];
            const time = new Date(at(day, from).getTime() + Math.floor(unit(`${date} ${event.id} time`) * (minutes(to) - minutes(from))) * 60_000);
            record.events.push({ id: event.id, text: event.text, at: time, ...(event.person ? { person: event.person } : {}) });
            if (event.cost) book(time, -priceIn(event.cost.amount, `${date} ${event.id} cost`), event.cost.what, 'spend');
        }
        // 补充的日常小事（ADR 0106）：条件都满足的按各自的概率出现；同一组一天最多一件，一天最多 EVERYDAY_MAX_PER_DAY 件
        const extras: { event: World['events'][number]; time: Date; rank: number }[] = [];
        for (const event of world.events) {
            if (!event.everyday) continue;
            if (world.everydayFrom && date < world.everydayFrom) continue;
            const weekday = day.getDay() || 7;
            if (event.weekdays && !event.weekdays.includes(weekday)) continue;
            if (event.months && !event.months.includes(day.getMonth() + 1)) continue;
            const ok = event.when === 'any' || (event.when === 'school' ? atSchool : event.when === 'off_day' ? atSchool && lessons.length === 0 : atSchool && lessons.length > 0);
            if (!ok) continue;
            if (event.weather && !weatherMatches(record.weather, event.weather)) continue;
            if (event.requires === 'cat_seen' && !(record.cat?.fed && record.cat.seen)) continue;
            if (event.requires === 'cat_unseen' && !(record.cat?.fed && record.cat.seen === false)) continue;
            if (event.afterCamera && !camera) continue;
            if (unit(`${date} ${event.id}`) >= event.chance) continue;
            const person = event.person ? world.people.find(p => p.id === event.person) : undefined;
            if (event.person && !person) continue;
            if (person && !npcAllows(npcStates(person.id, person.life, schedule, day), event.skipWhen, event.onlyWhen)) continue;
            // 土豆的事发生在她喂完之后
            const time = event.requires && record.cat?.fed
                ? new Date(record.cat.fed.getTime() + (2 + Math.floor(unit(`${date} ${event.id} time`) * 7)) * 60_000)
                : new Date(at(day, WINDOWS[event.window][0]).getTime() + Math.floor(unit(`${date} ${event.id} time`) * (minutes(WINDOWS[event.window][1]) - minutes(WINDOWS[event.window][0]))) * 60_000);
            extras.push({ event, time, rank: unit(`${date} ${event.id} rank`) });
        }
        const groupsToday = new Set(record.events.map(e => e.id));
        let extraCount = 0;
        for (const { event, time } of extras.sort((a, b) => a.rank - b.rank)) {
            if (extraCount >= EVERYDAY_MAX_PER_DAY) break;
            const group = event.group ?? event.id;
            if (groupsToday.has(`group:${group}`)) continue;
            groupsToday.add(`group:${group}`);
            extraCount++;
            record.events.push({ id: event.id, text: event.text, at: time, ...(event.person ? { person: event.person } : {}), ...(event.feel ? { feel: event.feel } : {}) });
            if (event.cost) book(time, -priceIn(event.cost.amount, `${date} ${event.id} cost`), event.cost.what, 'spend');
        }
        // 小测的一条线（ADR 0106）
        if (world.quizzes && (!world.everydayFrom || date >= world.everydayFrom)) record.events.push(...quizEvents(schedule, day, atSchool));
        // 她的钱（ADR 0035）：到账、三餐、网购、线上单
        if (money) {
            if (day.getDate() === money.payday) book(at(day, PAY_TIME), money.allowance, '生活费到账', 'income');
            for (const meal of world.routine ? routineOn(world.routine, schedule, day, atSchool).meals : []) {
                if (meal.where === 'home') continue;
                const price = priceIn(meal.where === 'takeout' ? money.prices.takeout : money.prices.canteen, `${date} ${meal.kind} price`);
                book(meal.start, -price, `${meal.kind === 'lunch' ? '午饭' : '晚饭'}${meal.where === 'takeout' ? '外卖' : ''}`, 'spend');
            }
            // 在学校每天的零碎（零食饮料、日用品）；在家爸妈管
            if (atSchool) book(at(day, MISC_TIME), -priceIn(money.prices.misc, `${date} misc`), '零碎', 'spend');
            for (const parcel of parcels.filter(p => p.ordered === date)) book(at(day, ORDER_TIME), -parcelPrice(money, parcel.item, Boolean(parcel.food)), `网购${parcel.item}`, 'spend');
            const job = sideJobOn(money, day);
            if (job) {
                const time = new Date(at(day, WINDOWS.evening[0]).getTime() + Math.floor(unit(`${date} side job time`) * 120) * 60_000);
                record.events.push({ id: 'side_job', text: `接了个${job.kind}的单，收了 ${job.pay} 元`, at: time });
                book(time, job.pay, `${job.kind}的单`, 'income');
            }
        }
        // 他给的钱（10-10 用户裁决：打字发的「［转账］」也当真）：记一笔收入；说了是买相机的存进相机基金，存满目标为止，多的留在手上
        const purchase = world.cameraFund?.purchase?.date === date ? world.cameraFund.purchase : undefined;
        const tripStart = purchase ? at(day, purchase.from) : undefined;
        const buyCamera = () => {
            // 攒够以后去买（用户 10-10）：钱从相机基金出，剩下的回到手上；之后不再存
            if (!purchase || !tripStart || camera || saved < purchase.price) return;
            const end = new Date(tripStart.getTime() + purchase.minutes * 60_000);
            camera = { start: tripStart, end, where: purchase.where, what: purchase.what, price: purchase.price, ...(fundGifts.length ? { gifts: fundGifts } : {}) };
            if (saved > purchase.price) book(end, saved - purchase.price, '买完相机剩下的', 'income');
            saved = 0;
            fundGifts = [];
            deposits.push({ at: end, saved, amount: 0 });
        };
        const gifts = todayActions.filter(a => a.kind === 'receive_money' && a.amount).sort((a, b) => a.at.localeCompare(b.at));
        for (const action of gifts) {
            const time = new Date(action.at);
            if (tripStart && time >= tripStart) buyCamera();
            book(time, action.amount!, '收到的钱', 'income');
            if (action.target === CAMERA_FUND_TARGET && world.cameraFund && !camera && saved < world.cameraFund.goal) {
                const put = Math.min(action.amount!, world.cameraFund.goal - saved);
                saved += put;
                // 记他给的整笔（存满目标多出来的留在手上，也是给相机的）：说起来是「他给的 2000」，不是存进去的 1750
                fundGifts.push({ contact: action.contact, amount: action.amount! });
                book(time, -put, '存进相机基金', 'deposit');
                deposits.push({ at: time, saved, amount: put });
            }
        }
        buyCamera();
        // 相机基金：每周那天晚上存一笔，到目标就停；有钱的规则时存多少跟着手上的钱走（ADR 0035），没有时每周固定；买了相机就不存了
        if (world.cameraFund && !camera && (day.getDay() || 7) === world.cameraFund.depositDay && saved < world.cameraFund.goal) {
            const time = at(day, DEPOSIT_TIME);
            const amount = money
                ? depositFor(money, ledger.filter(e => e.at <= time).reduce((sum, e) => sum + e.amount, money.start), day, world.cameraFund.goal - saved)
                : Math.min(world.cameraFund.goal - saved, world.cameraFund.weekly);
            saved += amount;
            if (amount) book(time, -amount, '存进相机基金', 'deposit');
            deposits.push({ at: time, saved, amount });
        }
        // 花得只剩不到一天的钱、离到账还有几天：跟家里要（ADR 0035）；说得出口的档位才知道这件事
        if (money && balance < money.saving.keepPerDay && nextPayday(money, day) > addDays(day, 1)) {
            const time = at(day, ASK_HOME_TIME);
            book(time, money.askHome, '跟家里要的', 'income');
            if (money.detail) record.events.push({ id: 'ask_home', text: `钱快花完了，跟家里要了 ${money.askHome} 元`, at: time });
        }
        record.events.sort((a, b) => a.at.getTime() - b.at.getTime());
    }
    return { days, parcels, homework, deposits, ledger, ...(camera ? { camera } : {}) };
}

// ---------- 闺蜜的约（ADR 0061） ----------

/** 她那一天在不在学校（和 simulateWorld 里的口径一样；约只在她在学校的日子） */
function atSchoolOn(world: World, schedule: Schedule, day: Date): boolean {
    const date = formatDate(day);
    const { outsideSemester } = classesOn(schedule, day);
    const holiday = schedule.holidays.find(h => h.start <= date && date <= h.end);
    return !(holiday && world.awayHolidays.includes(holiday.name)) && !(outsideSemester && day > parseDate(world.startDay));
}

const KNOWN_MIN_BEFORE = { cancelled: 90, moved: 40 } as const;

/**
 * 这几天里闺蜜的约，按「她那一刻」(now) 知道的：说到她这里的（askedAt ≤ now）。她答不答应按规则判（judgeAsk：课、身上不舒服、快交的作业；
 * 他的约在约定那边，这里看不到）。只给看得到这两个人的档位（world.people 已经按档位裁过），私事理由只给说得出口的档位
 */
function friendDatesFor(world: World, schedule: Schedule, now: Date, days: readonly Date[], timeline: Timeline): FriendDate[] {
    if (!world.asks || !world.people.length) return [];
    const detail = world.body?.period?.detail ?? false;
    const anchors = {
        meal: (kind: 'lunch' | 'dinner', day: Date) => {
            if (!world.routine) return undefined;
            const meal = routineOn(world.routine, schedule, day, atSchoolOn(world, schedule, day)).meals.find(m => m.kind === kind);
            return meal && meal.where === 'canteen' ? meal : undefined;
        },
    };
    const out: FriendDate[] = [];
    for (const day of days) {
        for (const ask of npcAsksOn(world.people, schedule, day, DEFAULT_ASKS, anchors)) {
            if (ask.askedAt > now) continue;
            out.push(friendDate(world, schedule, ask, timeline, detail));
        }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function friendDate(world: World, schedule: Schedule, ask: NpcAsk, timeline: Timeline, detail: boolean): FriendDate {
    const person = world.people.find(p => p.id === ask.person)!;
    const day = new Date(`${ask.day}T00:00`);
    const askedOn = formatDate(startOfDay(ask.askedAt));
    const due = timeline.homework.filter(h => h.assigned <= askedOn && h.due > ask.askedAt && h.done > ask.askedAt).sort((a, b) => a.due.getTime() - b.due.getTime())[0]?.due;
    const facts: AskFacts = {
        classes: classesOn(schedule, day).lessons.map(l => ({ start: l.start, end: l.end })),
        meetups: [],
        ...(due ? { homeworkDue: due } : {}),
        unwell: world.body ? unwell(bodyAt(world.body, schedule, ask.start)) : false,
    };
    const first = judgeAsk(ask, facts);
    let verdict = first;
    // 迟到、改约之后的那一段也要对得上她的安排
    if (verdict.accept && ask.actualStart && ask.outcome !== 'cancelled') {
        verdict = judgeAsk(ask, facts, { start: ask.actualStart, end: new Date(ask.actualStart.getTime() + ask.minutes * 60_000) });
    }
    const reason = ask.reason && (!ask.reason.private || detail) ? ask.reason.text : undefined;
    const declined = verdict.accept ? undefined : verdict.reason;
    const knownAt = ask.outcome === 'cancelled' || ask.outcome === 'moved'
        ? new Date(Math.max(ask.askedAt.getTime() + 10 * 60_000, ask.start.getTime() - KNOWN_MIN_BEFORE[ask.outcome] * 60_000))
        : ask.outcome === 'late' ? ask.start : undefined;
    // 说的时候就推掉的，那一刻就知道；改约、迟到之后才撞上的，要等她知道变了
    const declinedAt = declined ? (first.accept ? knownAt ?? ask.askedAt : ask.askedAt) : undefined;
    return {
        id: ask.id, kind: ask.kind, person: { id: person.id, name: person.name, relation: person.relation },
        what: ask.what, doing: ask.doing, ...(ask.where ? { where: ask.where } : {}),
        askedAt: ask.askedAt, start: ask.start, minutes: ask.minutes, outcome: ask.outcome,
        ...(ask.actualStart ? { actualStart: ask.actualStart } : {}), ...(knownAt ? { knownAt } : {}), ...(reason ? { reason } : {}),
        ...(declined ? { declined, declinedAt: declinedAt! } : {}), held: !declined && ask.outcome !== 'cancelled',
    };
}

/**
 * 一天的打算里写的约（ADR 0061）：她那一刻相信会发生的——答应了的；改约的要等她知道才换成新时间，取消的要等她知道才去掉；她推掉的不写
 */
export function planDates(now: WorldNow, at: Date): { start: Date; text: string }[] {
    return (now.dates ?? []).filter(d => formatDate(d.start) === now.day).flatMap(d => {
        if (d.declined && d.declinedAt && at >= d.declinedAt) return [];
        const known = d.knownAt ? at >= d.knownAt : false;
        if (d.outcome === 'cancelled' && known) return [];
        return [{ start: d.outcome === 'moved' && known ? d.actualStart! : d.start, text: `和${d.person.name}${d.what}` }];
    });
}

/** 约真的发生的那一段：迟到、改约的按实际的时刻 */
export function dateSpan(d: FriendDate): { start: Date; end: Date } {
    const start = d.actualStart ?? d.start;
    return { start, end: new Date(start.getTime() + d.minutes * 60_000) };
}

/** 进「你那边」的一句：只写事实，没有台词；at 是此刻，变卦要到她知道的那一刻才写 */
export function describeDate(d: FriendDate, at: Date, herToday: Date): string {
    const who = d.person.name;
    const day = startOfDay(d.start).getTime() === herToday.getTime() ? '今天' : '明天';
    const time = `${day} ${clock(d.start)}`;
    const why = d.reason ? `（${d.reason}）` : '';
    const plain = `约好${time}和${who}${d.what}`;
    if (d.declined && d.declinedAt && at >= d.declinedAt) return `${who}约你${time} ${d.what}，你推掉了（${d.declined}）`;
    const known = d.knownAt ? at >= d.knownAt : false;
    switch (d.outcome) {
        case 'cancelled': return known ? `${who}约好${time} ${d.what}，她说去不了了${why}` : plain;
        case 'moved': return known ? `${who}约好${time} ${d.what}，她说改到 ${clock(d.actualStart!)}${why}` : plain;
        case 'late': {
            const late = Math.round((d.actualStart!.getTime() - d.start.getTime()) / 60_000);
            if (!known) return plain;
            return at < d.actualStart! ? `${plain}，她还没到${why}` : at >= dateSpan(d).end ? `${time}和${who}${d.what}了，她迟到了 ${late} 分钟${why}` : `${plain}，她迟到了 ${late} 分钟${why}`;
        }
        default: return at >= dateSpan(d).end ? `${time}和${who}${d.what}了` : plain;
    }
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
        const trip = timeline.camera && formatDate(herDay(schedule, timeline.camera.start)) <= date ? timeline.camera : undefined;
        const tripState = !trip ? undefined : now >= trip.end ? 'bought' as const : now >= trip.start ? 'buying' as const : 'planned' as const;
        result.cameraFund = {
            ...(trip && tripState ? { camera: { ...trip, state: tripState } } : {}),
            saved: tripState === 'bought' ? 0 : tripState ? world.cameraFund.goal : last?.saved ?? world.cameraFund.saved, goal: world.cameraFund.goal,
            ...(() => {
                const plan = world.cameraFund.purchase;
                const saved = last?.saved ?? world.cameraFund.saved;
                const next = addDays(day, 1);
                return !trip && plan && plan.date === formatDate(next) && saved >= plan.price ? { tomorrow: { start: at(next, plan.from), where: plan.where, what: plan.what } } : {};
            })(),
            ...(world.money && last && now.getTime() - last.at.getTime() < 7 * DAY_MS ? { lastDeposit: { at: last.at, amount: last.amount } } : {}),
        };
    }
    for (const item of timeline.homework) {
        if (item.assigned > date || item.due <= now || item.due.getTime() - startOfDay(now).getTime() > 3 * DAY_MS) continue;
        result.homework.push({ course: item.course, due: item.due, done: item.done <= now, doneAt: item.done, assigned: item.assigned });
    }
    if (record.call) result.familyCall = { at: record.call, done: record.call <= now };
    if (world.routine) result.routine = routineOn(world.routine, schedule, day, record.atSchool, world.menu ? { menu: world.menu, ...(world.menuFrom ? { from: world.menuFrom } : {}) } : undefined);
    for (const event of record.events) {
        if (event.at > now) continue;
        const person = event.person ? world.people.find(p => p.id === event.person) : undefined;
        result.events.push({ id: event.id, text: event.text.replaceAll('{person}', person?.name ?? '朋友'), at: event.at, ...(person ? { person: { id: person.id, name: person.name, relation: person.relation } } : {}), ...(event.feel ? { feel: event.feel } : {}) });
    }
    const people = world.people.map(p => ({ name: p.name, relation: p.relation, states: npcStates(p.id, p.life, schedule, day) })).filter(p => p.states.length);
    if (people.length) result.people = people;
    if (world.asks) {
        const dates = friendDatesFor(world, schedule, now, [day, addDays(day, 1)], timeline);
        if (dates.length) result.dates = dates;
    }
    if (world.money) {
        const past = timeline.ledger.filter(e => e.at <= now);
        const paid = lastPayday(world.money, day);
        result.money = {
            balance: past.reduce((sum, e) => sum + e.amount, world.money.start),
            nextPay: nextPayday(world.money, day),
            today: past.filter(e => e.kind === 'spend' && formatDate(herDay(schedule, e.at)) === date).map(e => ({ what: e.what, amount: -e.amount })),
            askedHome: past.filter(e => e.what === '跟家里要的' && e.at >= paid).reduce((sum, e) => sum + e.amount, 0),
            detail: world.money.detail,
        };
    }
    return result;
}

// ---------- 进提示词（W2） ----------

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 时间块里的一段「你那边」：只有事实（几点、几件、还剩几天），没有能原样说出口的整句；用不用、怎么说她自己定。
 * 没有可写的就不返回。giver：别人给的钱（买相机）在这一行里怎么称呼给钱的人（contact.ts 按正在看的人给）
 */
export function describeWorld(now: WorldNow, at: Date, giver?: (qq: number) => string | undefined): string | undefined {
    const parts: string[] = [];
    // 今天 / 明天 / 昨天按她的一天说（和 now.day 一样，凌晨 2 点前算前一天）：零点后她还没睡，下午买的相机还是「今天下午」、白天到的快递是「明天到」
    const herToday = new Date(`${now.day}T00:00:00`);
    const ahead = (d: Date) => Math.round((startOfDay(d).getTime() - herToday.getTime()) / DAY_MS);
    if (now.weather) parts.push(describeWeather(now.weather));
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
                : `${p.item}${ahead(p.when) <= 0 ? '今天' : '明天'}到`).join('；')}`);
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
    const camera = now.cameraFund?.camera;
    if (camera?.state === 'bought') {
        const day = ahead(camera.end) === 0 ? '今天' : ahead(camera.end) === -1 ? '昨天' : `${camera.end.getMonth() + 1} 月 ${camera.end.getDate()} 日`;
        parts.push(`相机：${day}${partOfDay(camera.start.getHours())}去${camera.where}买的${camera.what}（${cameraMoney(camera, giver)}）`);
    } else if (camera?.state === 'buying') {
        parts.push(`相机：钱攒够了，这会儿在${camera.where}挑相机，看中的是${camera.what}，${camera.price} 元左右`);
    } else if (camera?.state === 'planned') {
        parts.push(`相机：钱攒够了（${now.cameraFund!.goal} 元），今天 ${clock(camera.start)} 要去${camera.where}买，看中的是${camera.what}`);
    } else if (now.cameraFund) {
        const last = now.cameraFund.lastDeposit;
        // 周日 21:00 前看到的是上个周日存的
        const when = last && (ahead(last.at) === 0 ? '今天' : `${last.at.getDay() === herToday.getDay() ? '上' : ''}${WEEKDAYS[last.at.getDay()]}`);
        const note = !last ? '' : last.amount ? `（${when}存了 ${last.amount}）` : `（${when}没存，手上的钱留着花到月底）`;
        // 还差多少直接写上（ADR 0035 第二批：2750 / 4500 她说「还没到一半」）
        const left = now.cameraFund.goal - now.cameraFund.saved;
        const plan = now.cameraFund.tomorrow;
        parts.push(`攒钱买相机：${now.cameraFund.saved} / ${now.cameraFund.goal} 元${left > 0 ? `，还差 ${left}` : '，攒够了'}${note}${plan ? `；明天 ${clock(plan.start)} 打算去${plan.where}买，看中的是${plan.what}` : ''}`);
    }
    // 手上的钱（ADR 0035）：只给说得出口的档位
    if (now.money?.detail) {
        const days = Math.round((now.money.nextPay.getTime() - startOfDay(at).getTime()) / DAY_MS);
        const spent = now.money.today.reduce((sum, e) => sum + e.amount, 0);
        parts.push(`钱：手上还有 ${now.money.balance} 元（生活费每月 ${now.money.nextPay.getDate()} 号到，这个月的到了，离下次还有 ${days} 天${now.money.askedHome ? `；这个月跟家里多要了 ${now.money.askedHome}` : ''}）；${spent ? `今天花了 ${spent} 元（${spendItems(now.money.today)}）` : '今天还没花钱'}`);
    }
    // 今天吃的（ADR 0125，配置 menu）：已经到饭点的每一顿；没写的别编
    const eaten = (now.routine?.meals ?? []).filter(m => m.dish && m.start.getTime() <= at.getTime());
    if (eaten.length) parts.push(`吃的：${eaten.map(m => `${m.kind === 'lunch' ? '午饭' : '晚饭'}${mealWhere(m.where)}${m.dish}`).join('；')}`);
    if (now.familyCall) {
        // 视频的那半小时里写「还在视频」（ADR 0030：写成「视频过了」时，她 3/3 在视频中途说「刚跟我妈视频完」）
        const calling = now.familyCall.done && at.getTime() < now.familyCall.at.getTime() + OCCUPATION_MINUTES.call * 60_000;
        parts.push(calling ? `今晚 ${clock(now.familyCall.at)} 开始和家里视频，这会儿还在视频`
            : now.familyCall.done ? `今晚 ${clock(now.familyCall.at)} 和家里视频过了` : `今晚 ${clock(now.familyCall.at)} 要和家里视频`);
    }
    // 朋友今天怎么样（ADR 0033）：谁是谁写一次，小事里再出现就不重复
    const introduced = new Set<string>();
    if (now.people?.length) {
        parts.push(`朋友：${now.people.map(p => describeNpc(p.name, p.states)).join('；')}（${now.people.map(p => `${p.name}：${p.relation}`).join('；')}）`);
        for (const p of now.people) introduced.add(p.name);
    }
    if (now.dates?.length) {
        parts.push(`约：${now.dates.map(d => describeDate(d, at, herToday)).join('；')}${now.dates.some(d => !introduced.has(d.person.name)) ? `（${[...new Map(now.dates.filter(d => !introduced.has(d.person.name)).map(d => [d.person.name, d.person.relation] as const))].map(([name, relation]) => `${name}：${relation}`).join('；')}）` : ''}`);
        for (const d of now.dates) introduced.add(d.person.name);
    }
    if (now.events.length) {
        const people = [...new Map(now.events.flatMap(e => (e.person && !introduced.has(e.person.name) ? [[e.person.name, e.person.relation] as const] : []))).entries()];
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

/**
 * 她这一天的日常（ADR 0031）：按日期取哈希，同一天对所有人一样。和课撞上的那顿不吃（节次里午饭、晚饭的点本来不上课）；
 * 周末、放假按概率点外卖，不在学校就在家吃；洗澡按概率，洗的那天在 from 之后 spread 分钟内去
 */
function routineOn(routine: NonNullable<World['routine']>, schedule: Schedule, day: Date, atSchool: boolean, menu?: { menu: Menu; from?: string }): NonNullable<WorldNow['routine']> {
    const date = formatDate(day);
    const { lessons } = classesOn(schedule, day);
    const off = lessons.length === 0;
    const meals = (['lunch', 'dinner'] as const).flatMap(kind => {
        const plan = routine[kind];
        const start = new Date(at(day, plan.from).getTime() + Math.floor(unit(`${date} ${kind}`) * (plan.spread + 1)) * 60_000);
        const end = new Date(start.getTime() + plan.minutes * 60_000);
        if (lessons.some(l => l.start < end && start < l.end)) return [];
        const where = !atSchool ? 'home' as const : off && unit(`${date} ${kind} takeout`) < routine.takeoutChance ? 'takeout' as const : 'canteen' as const;
        const dish = menu && (!menu.from || date >= menu.from) ? dishOn(date, kind, menu.menu) : undefined;
        return [{ kind, start, end, where, ...(dish ? { dish } : {}) }];
    });
    if (unit(`${date} shower`) >= routine.shower.chance) return { meals };
    const [min, max] = routine.shower.minutes;
    const start = new Date(at(day, routine.shower.from).getTime() + Math.floor(unit(`${date} shower at`) * (routine.shower.spread + 1)) * 60_000);
    const end = new Date(start.getTime() + (min + Math.floor(unit(`${date} shower long`) * (max - min + 1))) * 60_000);
    return { meals, shower: { start, end } };
}

/** 此刻最近吃的那顿的菜（ADR 0128）：已经到饭点的最后一顿；还没吃过、没开 menu 就没有 */
export function lastMealDish(now: WorldNow, at: Date): { kind: 'lunch' | 'dinner'; dish: string } | undefined {
    const meals = (now.routine?.meals ?? []).filter(m => m.dish && m.start.getTime() <= at.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime());
    const last = meals.at(-1);
    return last?.dish ? { kind: last.kind, dish: last.dish } : undefined;
}

/** 这顿在哪吃（ADR 0125）：写在“吃的是什么”前面——「在食堂吃了黄焖鸡」「点外卖吃了麻辣烫」「在家吃了水饺」 */
function mealWhere(where: 'canteen' | 'takeout' | 'home'): string {
    return where === 'canteen' ? '在食堂吃的' : where === 'takeout' ? '点的外卖，' : '在家吃的';
}

/** 洗完澡后多久还算「刚洗完澡」（分钟，ADR 0031） */
export const AFTER_SHOWER_MINUTES = 20;

/** 这一刻看不到消息（ADR 0031）：在洗澡，洗完才看到 */
export function unavailableAt(now: WorldNow, at: Date): { until: Date; reason: string } | undefined {
    const shower = now.routine?.shower;
    return shower && at >= shower.start && at < shower.end ? { until: shower.end, reason: '在洗澡，洗完才看到' } : undefined;
}

/** 有时长的事各占多久（分钟，ADR 0030）：喂猫、取完快递往回走、和家里视频、写完作业之前在赶的那一段 */
export const OCCUPATION_MINUTES = { feed: 10, parcel: 15, call: 30, homework: 90, newCamera: 90, beforeTrip: 90 } as const;

/**
 * 此刻在做的事（ADR 0030，类型化行动的第一步）：世界里有时长的事，现在正好落在里面的那件；没有就是 undefined（照作息的空闲活动）。
 * 原来空闲活动一个时段固定一件（整晚「打独立游戏」），和世界里 18:55 喂猫、20:30 和家里视频各说各的。now 用这一档的卡算，看不到的块本来就没有
 */
export function occupationAt(now: WorldNow, at: Date): string | undefined {
    const within = (start: Date, minutes: number) => at.getTime() >= start.getTime() && at.getTime() < start.getTime() + minutes * 60_000;
    if (now.familyCall?.done && within(now.familyCall.at, OCCUPATION_MINUTES.call)) return '在和家里视频';
    if (now.cameraFund?.camera?.state === 'buying') return `在${now.cameraFund.camera.where}挑相机`;
    // 买完回来的那一会儿（10-11 模拟：16:30 买完，状态回到作息里下午那段，16:39 她说「我现在人在图书馆」）
    const camera = now.cameraFund?.camera;
    if (camera?.state === 'bought' && within(camera.end, OCCUPATION_MINUTES.newCamera)) return '刚买完相机回到宿舍，在摆弄新相机';
    // 洗澡（ADR 0031）：洗的时候看不到消息（reply-timing 按 unavailableAt 推迟）；洗完后一会儿还算刚洗完
    const shower = now.routine?.shower;
    if (shower && at >= shower.start && at < shower.end) return '在洗澡';
    if (shower && at >= shower.end && at.getTime() < shower.end.getTime() + AFTER_SHOWER_MINUTES * 60_000) return '刚洗完澡';
    if (now.cat && 'fed' in now.cat.today && within(now.cat.today.fed, OCCUPATION_MINUTES.feed)) return `在楼下喂${now.cat.name}`;
    const parcel = now.parcels.find(p => p.status === 'picked_today' && within(p.when, OCCUPATION_MINUTES.parcel));
    if (parcel) return `刚去驿站取了快递（${parcel.item}），在往回走`;
    const homework = now.homework.find(h => !h.done && within(new Date(h.doneAt.getTime() - OCCUPATION_MINUTES.homework * 60_000), OCCUPATION_MINUTES.homework));
    if (homework) return `在赶${homework.course ? `${homework.course}的` : ''}作业，${clock(homework.doneAt)} 左右能写完`;
    // 闺蜜的约（ADR 0061）：在一起的那一段（迟到、改约的按实际的时刻）；比吃饭先说，免得「在食堂吃午饭」盖掉「和苏雨桐」
    const together = now.dates?.find(d => d.held && at >= dateSpan(d).start && at < dateSpan(d).end);
    if (together) return together.doing;
    // 吃饭（ADR 0031）
    const meal = now.routine?.meals.find(m => at >= m.start && at < m.end);
    if (meal) return `${meal.where === 'canteen' ? '在食堂' : meal.where === 'takeout' ? '点了外卖，在' : '在家'}吃${meal.kind === 'lunch' ? '午饭' : '晚饭'}${dishNote(meal.dish)}`;
    // 出门买相机前那一会儿（排在吃饭后面）：不写作息里那一段的空闲活动（10-11 预览：13:30 还「在图书馆赶作业」，14:00 就到了山大路）
    if (camera?.state === 'planned' && at < camera.start && within(new Date(camera.start.getTime() - OCCUPATION_MINUTES.beforeTrip * 60_000), OCCUPATION_MINUTES.beforeTrip)) {
        return `在宿舍准备出门，${clock(camera.start)} 去${camera.where}买相机`;
    }
    return undefined;
}

/**
 * 过去某一天她那边的事（ADR 0032）：他问到这一天时放进提示词。now 是那天快结束时（23:30）按这一档的卡算的世界；
 * 和日记（ADR 0026，只挑值得记的、按同学档）不同，这里那天的事都写，用这一档看得到的说法
 */
export function recapDay(now: WorldNow): string[] {
    const lines: string[] = [];
    if (now.weather) lines.push(`${now.weather.rain ? '下雨' : '没下雨'}，${now.weather.low}–${now.weather.high}℃`);
    if (now.cat) {
        const { today } = now.cat;
        lines.push('fed' in today ? `${clock(today.fed)} 下楼喂了${now.cat.name}${today.seen === false ? '，没见着它' : ''}`
            : 'skipped' in today ? (today.skipped === 'rain' ? `下雨，没下楼喂${now.cat.name}` : today.skipped === 'no_food' ? `猫粮没了，没喂成${now.cat.name}` : today.skipped === 'class' ? `晚上有课，没下楼喂${now.cat.name}` : `不在学校，没喂${now.cat.name}`)
                : `没下楼喂${now.cat.name}`);
    }
    for (const parcel of now.parcels) {
        if (parcel.status === 'picked_today') lines.push(`${clock(parcel.when)} 去驿站取了快递（${parcel.item}）`);
        else if (parcel.status === 'station') lines.push(`快递（${parcel.item}）在驿站，还没去取`);
    }
    for (const h of now.homework.filter(h => h.done && formatDate(h.doneAt) === now.day)) {
        lines.push(`${h.doneAt.getHours() >= 21 ? '熬夜' : ''}写完了${h.course ? `${h.course}的` : ''}作业`);
    }
    if (now.familyCall?.done) lines.push(`${clock(now.familyCall.at)} 和家里视频了`);
    for (const event of now.events) lines.push(event.text);
    for (const d of (now.dates ?? []).filter(d => formatDate(d.start) === now.day)) lines.push(recapDate(d));
    for (const person of now.people ?? []) lines.push(describeNpc(person.name, person.states)!);
    // 那天花了多少（ADR 0035）：说得出口的档位才有
    if (now.money?.detail && now.money.today.length) lines.push(`花了 ${now.money.today.reduce((sum, e) => sum + e.amount, 0)} 元（${spendItems(now.money.today)}）`);
    const trip = now.cameraFund?.camera;
    if (trip?.state === 'bought' && formatDate(trip.end) === now.day) lines.push(`${partOfDay(trip.start.getHours())}去${trip.where}买了相机（${trip.what}，${trip.price} 元）`);
    else if (now.cameraFund?.lastDeposit && formatDate(now.cameraFund.lastDeposit.at) === now.day) lines.push(now.cameraFund.lastDeposit.amount ? `相机基金存了 ${now.cameraFund.lastDeposit.amount}` : '相机基金这周没存');
    for (const meal of now.routine?.meals ?? []) if (meal.dish) lines.push(`${meal.kind === 'lunch' ? '午饭' : '晚饭'}${mealWhere(meal.where)}${meal.dish}`);
    if (now.routine?.shower) lines.push(`${clock(now.routine.shower.start)} 去洗了澡`);
    return lines;
}

/** 过去那一天的约，一句（复盘、说起她时） */
function recapDate(d: FriendDate): string {
    const who = d.person.name;
    const why = d.reason ? `（${d.reason}）` : '';
    if (d.declined) return `你推掉了${who}约的${d.what}（${d.declined}）`;
    switch (d.outcome) {
        case 'cancelled': return `${who}约的${d.what}，她临时去不了${why}`;
        case 'moved': return `${who}约的${d.what}，她改到 ${clock(d.actualStart!)}${why}`;
        case 'late': return `${clock(d.start)} 和${who}${d.what}，她迟到了 ${Math.round((d.actualStart!.getTime() - d.start.getTime()) / 60_000)} 分钟${why}`;
        default: return `${clock(d.start)} 和${who}${d.what}`;
    }
}

/** 说起她身边的人时往回看几天（ADR 0033） */
export const RECENT_DAYS = 14;

/**
 * 他说起她身边的某个人时（ADR 0033）：那人最近 days 天怎么样（病过、忙过、回过家，连着的并成一段）、和她一起的事（每件只留最近一次），到 now 为止。
 * 都是她知道的（同专业天天见，和死党天天微信）；这一档看不到这个人就没有
 */
export function recentWith(world: World, schedule: Schedule, now: Date, id: string, days = RECENT_DAYS): string[] | undefined {
    const person = world.people.find(p => p.id === id);
    if (!person) return undefined;
    const today = herDay(schedule, now);
    const from = addDays(today, -(days - 1));
    const daily: { day: Date; states: NpcState[] }[] = [];
    for (let day = from; day <= today; day = addDays(day, 1)) daily.push({ day, states: npcStates(id, person.life, schedule, day) });
    const date = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
    // 往回看的头一天之前就开始、已经过去的那段不写（只看得到尾巴，「10月7日回家了」其实是国庆回家的最后一天）
    const before = npcStates(id, person.life, schedule, addDays(from, -1));
    const clipped = (span: ReturnType<typeof npcSpans>[number]) => sameDay(span.from, from) && !span.ongoing && before.some(s => s.kind === span.kind);
    const lines = npcSpans(daily).filter(span => !clipped(span)).map(span => {
        const what = span.kind === 'sick' ? '感冒' : span.kind === 'busy' ? `${span.label}，忙` : '回家了';
        if (span.ongoing) return sameDay(span.from, today) ? `今天${what}` : `${date(span.from)}起${what}${span.kind === 'sick' ? '，还没好' : span.kind === 'busy' ? '，还没忙完' : ''}`;
        return `${sameDay(span.from, span.to) ? date(span.from) : `${date(span.from)}–${date(span.to)}`}${what}`;
    });
    // 和她一起的事：每件只留最近一次（「下课一起去食堂」天天有，只说最近那回）
    const timeline = simulateWorld(world, schedule, now);
    const latest = new Map<string, string>();
    for (let day = from; day <= today; day = addDays(day, 1)) {
        for (const event of timeline.days.get(formatDate(day))?.events ?? []) {
            if (event.person !== id || event.at > now) continue;
            latest.set(event.id, `${sameDay(day, today) ? '今天' : date(day)}${event.text.replaceAll('{person}', person.name)}`);
        }
    }
    if (world.asks) {
        const dated: { day: Date; d: FriendDate }[] = [];
        for (let day = from; day <= today; day = addDays(day, 1)) {
            for (const d of friendDatesFor(world, schedule, now, [day], timeline).filter(d => d.person.id === id && d.start <= now)) dated.push({ day, d });
        }
        if (dated.length) {
            const count = (f: (d: FriendDate) => boolean) => dated.filter(x => f(x.d)).length;
            const bits = [
                [count(d => !d.declined && d.outcome === 'on_time'), '按时'], [count(d => !d.declined && d.outcome === 'late'), '迟到'],
                [count(d => !d.declined && d.outcome === 'moved'), '改时间'], [count(d => !d.declined && d.outcome === 'cancelled'), '她临时去不了'],
                [count(d => d.declined !== undefined), '你推掉'],
            ].filter(([n]) => n).map(([n, what]) => `${what} ${n}`);
            latest.set('ask:tally', `最近 ${days} 天约过 ${dated.length} 次（${bits.join('、')}）`);
            // 变卦的，最近两件
            for (const { day, d } of dated.filter(x => x.d.outcome !== 'on_time' || x.d.declined !== undefined).slice(-2)) {
                latest.set(`ask:${d.id}`, `${sameDay(day, today) ? '今天' : date(day)}${recapDate(d)}`);
            }
        }
    }
    return [...lines, ...latest.values()];
}

/** 一天的摘要（日志、state.json 用，不含聊天内容） */
export function summarizeWorld(now: WorldNow): string {
    const bits = [
        now.weather ? `${now.weather.rain ? '下雨' : '没下雨'} ${now.weather.low}–${now.weather.high}℃` : undefined,
        now.atSchool ? undefined : '不在学校',
        now.cat ? `${now.cat.name} 猫粮够 ${now.cat.foodDays} 天` : undefined,
        now.parcels.length ? `快递 ${now.parcels.length} 件` : undefined,
        now.homework.length ? `作业 ${now.homework.length} 份` : undefined,
        now.cameraFund?.camera?.state === 'bought' ? `相机已买（${now.cameraFund.camera.what}）` : now.cameraFund ? `相机基金 ${now.cameraFund.saved}/${now.cameraFund.goal}` : undefined,
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
    /** 聊天之外的模拟器 / 外部世界也从这里提交事件；成功、失败、中断都会入账。 */
    recordEvents(drafts: readonly LifeEventDraft[]): void;
    /** 测试、状态页和诊断用。 */
    actions(): readonly WorldAction[];
    events(): readonly LifeEvent[];
}

const ACTION_KINDS = new Set<WorldActionKind>(['feed_cat', 'pick_parcel', 'finish_homework', 'family_call', 'receive_money']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 全局世界状态：events.json 是事实源；actions.json 是旧版本可读的成功动作投影。 */
export function worldState(
    world: World,
    schedule: Schedule,
    log: (message: string) => void,
    dir: string,
    nowFn: () => number = Date.now,
): WorldState {
    mkdirSync(dir, { recursive: true });
    const actionsPath = join(dir, 'actions.json');
    const eventsPath = join(dir, 'events.json');
    const statePath = join(dir, 'state.json');
    const loaded = readJsonOr<Partial<WorldActionsFile>>(actionsPath, {}, message => log(`她的世界：${message}`));
    const legacyActions = (Array.isArray(loaded.actions) ? loaded.actions : []).filter(validAction);
    let events = readLifeEvents(eventsPath, message => log(`她的生活：${message}`));
    const eventIds = new Set(events.map(event => event.id));
    // 首次升级只在内存合并；下一次真正写事件时再迁移落盘，启动本身不改用户数据。
    events = [...events, ...legacyActions.filter(action => !eventIds.has(action.id)).map(actionToLifeEvent)]
        .sort(compareLifeEvents);
    let actions = projectWorldActions(events);
    let logged: string | undefined;

    const persistState = (now: Date) => {
        const state = worldAt(world, schedule, now, actions);
        if (state) writeJsonAtomic(statePath, { at: now.toISOString(), ...state });
    };
    const safely = (work: () => void, what: string) => {
        try { work(); }
        catch (error) { log(`她的世界：${what}失败（${error instanceof Error ? error.message : String(error)}）`); }
    };

    const persist = (nextEvents: LifeEvent[]) => {
        const nextActions = projectWorldActions(nextEvents);
        // 事件先落盘；旧投影失败时抛出，让上层重试。重试由事件 id 幂等，不会重复执行。
        writeLifeEvents(eventsPath, nextEvents);
        writeJsonAtomic(actionsPath, { actions: nextActions });
        events = nextEvents;
        actions = nextActions;
    };

    const append = (drafts: readonly LifeEventDraft[]): LifeEvent[] => {
        const added: LifeEvent[] = [];
        for (const draft of drafts) {
            const id = draft.id.trim();
            const kind = draft.kind.trim();
            const endedAt = new Date(draft.at);
            const startedAt = new Date(draft.startedAt ?? draft.at);
            if (!id || !kind || !['conversation', 'simulation', 'external'].includes(draft.source)
                || !['succeeded', 'failed', 'interrupted'].includes(draft.result)
                || !Number.isFinite(endedAt.getTime()) || !Number.isFinite(startedAt.getTime())
                || startedAt > endedAt || endedAt.getTime() > nowFn()) continue;
            if (events.some(event => event.id === id) || added.some(event => event.id === id)) continue;
            const day = formatDate(herDay(schedule, endedAt));
            if (day < world.startDay) continue;
            const subject = draft.subject?.trim().slice(0, 40) || undefined;
            const reason = draft.reason?.trim().slice(0, 80) || undefined;
            let result = draft.result;
            let target = draft.target?.trim() || undefined;
            if (result === 'succeeded' && ACTION_KINDS.has(kind as WorldActionKind)) {
                // 结算以事件发生前的现实为准；不满足前置条件时保留“尝试失败”，绝不硬改世界。
                const before = projectWorldActions([...events, ...added]);
                if (kind === 'feed_cat' && !world.cat) result = 'failed';
                if (kind === 'family_call' && !world.familyCall) result = 'failed';
                if (kind === 'pick_parcel' || kind === 'finish_homework') {
                    const timeline = simulateWorld(world, schedule, endedAt, before);
                    if (kind === 'pick_parcel') {
                        const available = timeline.parcels.filter(parcel => !parcel.returned && parcel.arrive <= endedAt && (!parcel.picked || parcel.picked > endedAt));
                        const matched = target ? available.find(parcel => parcel.id === target)
                            : subject ? available.find(parcel => parcel.item.includes(subject) || subject.includes(parcel.item)) : available[0];
                        if (matched) target = matched.id;
                        else result = 'failed';
                    } else {
                        const available = timeline.homework.filter(item => item.assigned <= day && item.due > endedAt && item.done > endedAt);
                        const matched = target ? available.find(item => item.id === target)
                            : subject ? available.find(item => item.course.includes(subject) || subject.includes(item.course)) : available[0];
                        if (matched) target = matched.id;
                        else result = 'failed';
                    }
                }
            }
            added.push({
                id, actor: 'linmengyao', kind, day,
                startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), source: draft.source, result,
                ...(reason ? { reason } : {}),
                ...(subject ? { subject } : {}), ...(target ? { target } : {}),
                ...(draft.meal !== undefined ? { meal: draft.meal } : {}),
                ...(draft.amount !== undefined ? { amount: draft.amount } : {}),
                ...(draft.seen !== undefined ? { seen: draft.seen } : {}),
                ...(draft.contact !== undefined ? { contact: draft.contact } : {}),
                ...(draft.episode ? { episode: draft.episode } : {}),
            });
        }
        if (!added.length) return [];
        persist([...events, ...added].sort(compareLifeEvents));
        for (const event of added) log(`她的生活：${event.result === 'succeeded' ? '完成' : event.result === 'failed' ? '失败' : '中断'} ${event.kind}（${event.source}）`);
        safely(() => persistState(new Date(nowFn())), 'state.json 写入');
        return added;
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
                const subject = draft.kind === 'receive_money' ? undefined : draft.subject?.trim().slice(0, 40) || undefined;
                // 收到的钱：要有金额，而且这段聊天里对方真发过带这个金额的转账 / 红包（她跟别人转述「他给我转了」不算，那段里没有他的转账）
                const amount = draft.kind === 'receive_money' ? draft.amount : undefined;
                if (draft.kind === 'receive_money') {
                    if (!amount || !Number.isInteger(amount) || amount <= 0 || amount > MAX_GIFT) continue;
                    const sent = episode.messages.some(m => m.role === 'user' && new Date(m.time) <= at && /转账|红包|转你|给你转/.test(m.content) && new RegExp(`(?<![0-9])${amount}(?![0-9])`).test(m.content.replace(/[,，]/g, '')));
                    if (!sent) continue;
                }
                // 同一天向不同人重复说同一件事，不重复改变世界；有物品/课程名时分别算。收到的钱按联系人和金额分开算
                const sameDayKind = (action: WorldAction) => action.day === day && action.kind === draft.kind
                    && (draft.kind !== 'receive_money' || (action.contact === contact.qq && action.amount === amount));
                // 任一边没说清物品 / 课程时保守地当成同一件，避免“Linux 作业写完”换个人说成“作业写完”后误完成第二份。
                if ([...actions, ...added].some(action => sameDayKind(action)
                    && (!subject || !action.subject || action.subject === subject))) continue;
                // 她只能改变卡上确实存在的东西；快递和作业在最完整档位解析成稳定 ID，低档位没有课名也能改同一件。
                let target: string | undefined;
                if (draft.kind === 'feed_cat' && !world.cat) continue;
                if (draft.kind === 'family_call' && !world.familyCall) continue;
                if (draft.kind === 'receive_money' && draft.forCamera && world.cameraFund) target = CAMERA_FUND_TARGET;
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
                    ...(amount ? { amount } : {}),
                };
                added.push(action);
            }
            if (!added.length) return;
            const settled = append(added.map(action => ({
                id: action.id, kind: action.kind, at: new Date(action.at).toISOString(), source: 'conversation' as const,
                result: 'succeeded' as const, contact: action.contact, episode: action.episode,
                ...(action.subject ? { subject: action.subject } : {}), ...(action.target ? { target: action.target } : {}),
                ...(action.seen !== undefined ? { seen: action.seen } : {}), ...(action.amount ? { amount: action.amount } : {}),
            })));
            for (const event of settled.filter(event => event.result === 'succeeded')) {
                const action = lifeEventToAction(event)!;
                log(`她的世界：[${contact.qq}] ${actionLabel(action, world)}`);
            }
        },
        recordEvents: drafts => { append(drafts); },
        actions: () => actions,
        events: () => events,
    };
}

function actionToLifeEvent(action: WorldAction): LifeEvent {
    const at = new Date(action.at).toISOString();
    return {
        id: action.id, actor: 'linmengyao', kind: action.kind, day: action.day,
        startedAt: at, endedAt: at, source: 'conversation', result: 'succeeded',
        contact: action.contact, episode: action.episode,
        ...(action.subject ? { subject: action.subject } : {}), ...(action.target ? { target: action.target } : {}),
        ...(action.seen !== undefined ? { seen: action.seen } : {}), ...(action.amount ? { amount: action.amount } : {}),
    };
}

function lifeEventToAction(event: LifeEvent): WorldAction | undefined {
    if (event.result !== 'succeeded' || !ACTION_KINDS.has(event.kind as WorldActionKind)) return undefined;
    return {
        id: event.id, kind: event.kind as WorldActionKind, day: event.day, at: localMinute(new Date(event.endedAt)),
        contact: event.contact ?? 0, episode: event.episode ?? event.id,
        ...(event.subject ? { subject: event.subject } : {}), ...(event.target ? { target: event.target } : {}),
        ...(event.seen !== undefined ? { seen: event.seen } : {}), ...(event.amount ? { amount: event.amount } : {}),
    };
}

function projectWorldActions(events: readonly LifeEvent[]): WorldAction[] {
    return events.flatMap(event => {
        const action = lifeEventToAction(event);
        return action ? [action] : [];
    }).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function compareLifeEvents(a: LifeEvent, b: LifeEvent): number {
    return a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id);
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
        && (action.seen === undefined || typeof action.seen === 'boolean')
        && (action.amount === undefined || (Number.isInteger(action.amount) && action.amount > 0));
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
    if (action.kind === 'receive_money') return `${clock(new Date(action.at))} 收到 ${action.amount} 元${action.target === CAMERA_FUND_TARGET ? '（买相机的）' : ''}`;
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

/**
 * 时间块里的天气（ADR 0048）。真实的：这一刻的天况和气温、今天的范围、下过没有、还没下时预报之后有没有；生成的照旧一句「下雨 / 没下雨」
 */
export function describeWeather(weather: DayWeather): string {
    if (!weather.real) return `天气：${weather.rain ? '下雨' : '没下雨'}，${weather.low}–${weather.high}℃`;
    const range = `今天 ${weather.low}–${weather.high}℃`;
    const parts = [weather.now ? `现在${weather.now.text}，${weather.now.temp}℃（${range}）` : range];
    const raining = weather.now !== undefined && /雨|雪/.test(weather.now.text);
    if (!raining) parts.push(weather.rain ? `今天${partOfDay(weather.rainHours?.[0] ?? 12)}下过雨` : '今天还没下过雨');
    if (weather.later) parts.push(weather.later);
    return `天气：${parts.join('；')}`;
}

function partOfDay(hour: number): string {
    return hour < 6 ? '凌晨' : hour < 11 ? '上午' : hour < 13 ? '中午' : hour < 18 ? '下午' : '晚上';
}

/** 补充的小事要的天气（ADR 0106）：rain 下雨；dry 没下雨；cold 最高气温 ≤ 12；hot 最高气温 ≥ 30；这一天没有天气资料就都不满足 */
function weatherMatches(weather: DayWeather | undefined, want: 'rain' | 'dry' | 'cold' | 'hot'): boolean {
    if (!weather) return false;
    return want === 'rain' ? weather.rain : want === 'dry' ? !weather.rain : want === 'cold' ? weather.high <= 12 : weather.high >= 30;
}

function weatherOn(weather: NonNullable<World['weather']>, day: Date): DayWeather {
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
