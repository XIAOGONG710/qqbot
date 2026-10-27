// 她答应过的事（ADR 0018 决策 2）：她说的、她之后要做的事（「下次给你讲」「周末打算去拍照」），到时候记得。
// - 抽：一段聊天结束（安静 45 分钟，和长期记忆同一个片段）后，用模型从这一段里抽，输出 JSON；同时把还没做的几件给模型，
//   这一段里她已经做了、或者他说不用了的划掉。做不到的事（发照片和语音、打电话、开视频、寄东西）不抽，同出口检查（ADR 0006）；约好见面、一起吃饭这些要抽（ADR 0046：见面可以答应）。
//   名单里的人都抽；刚上线时只抽最近 NEXT_TIME_DAYS 天里结束的片段（再早的反正也过期了）。
// - 用：到了日子（有日子的：那天和之后 DUE_DAYS 天；「下次」的：之后的聊天），时间块里加一行；这一段聊天里她回了 SHOWN_REPLIES 次还没提的，
//   这段聊天里不再放（ADR 0014：说明里的话她会每句都照做，不能一直挂着）。
// - 忘：有日子的过了 FORGET_DAYS 天、「下次」的过了 NEXT_TIME_DAYS 天还没做就忘了。
// - 她自己那天的打算写进日记材料（diary.ts），日记和她说过的对得上。
// - 约好的见面（ADR 0047）：抽的时候多记几点、在哪；到点前一刻钟到见完，状态行写她在赴约（appointmentsAt / describeAppointment），见完不再提醒。
// - 同一次抽取还出「挂着的事」（ADR 0023，open-loops.ts）：他之后会发生、她想知道结果的；她问了他没答的；说好的没成的。
//   存在同一个状态文件的 loops 里，生命周期和用法见 open-loops.ts。
// 每个人一个状态文件 <数据目录>/promises/<QQ>-<档位>.json。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '../platform/config.ts';
import { logBody } from '../platform/sensitive.ts';
import { MIDNIGHT_RULE } from '../proactive/follow-ups.ts';
import type { StoredMessage } from '../memory/history.ts';
import { writeJsonAtomic } from '../memory/json-file.ts';
import { PromiseStateUnavailable, readPromiseState, validPromiseState, type PromiseState } from './promise-state.ts';
import { calendarDate } from '../memory/state-schema.ts';
import { createTransientGate, describeError, isTransientIoError, TransientStateError } from '../memory/transient-io.ts';
import { ModelUnreachable } from '../language/llm.ts';
import { EPISODE_GAP_MS, episodeTranscript, splitEpisodes, type Episode } from '.././memory/episodes.ts';
import { dueLoops, isFeeling, loopForgotten, type DueLoops, type LoopKind, type OpenLoop } from './open-loops.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import { formatDate, herDay, type Schedule } from './schedule.ts';
import type { MacroNames } from '.././st/macros.ts';
import type { WorldActionDraft, WorldActionKind } from '.././world/world.ts';

/** 她答应的一件事 */
export interface HerPromise {
    id: string;
    /** 一句话：「给他讲《三体》的结局」 */
    what: string;
    /** 哪天（YYYY-MM-DD，本地）；「下次」「回头」没说哪天的没有 */
    date?: string;
    /** 哪天说的（YYYY-MM-DD，她的一天） */
    said: string;
    /** 从哪个聊天片段抽出来的 */
    episode: string;
    /** 约好的见面（ADR 0047）：几点、在哪；没说几点的没有 */
    meet?: Meetup;
    /** 片段还没结束时先抽出来的约见面（ADR 0047 调整）：再先抽、整段抽时都被这一段的新结果整个替换（改时间、不去了跟着变） */
    early?: true;
}

/** 约好的见面：time 是 HH:MM（她的一天里，凌晨的算第二天的日历日），minutes 是大概多久 */
export interface Meetup { time: string; where?: string; minutes: number }

/** 见面默认多久（分钟）：一顿饭、一场电影 */
export const MEET_MINUTES = 90;
/** 见面前多久算「快出门了」 */
export const MEET_LEAD_MINUTES = 15;

/** 这一刻在赴约或快出门的那一件（ADR 0047）：和谁约的、哪件、几点开始、几点完 */
export interface Appointment { contact: Contact; promise: HerPromise; start: Date; end: Date }

/** 聊天记录里的一条（只看谁说的、什么时候） */
type TimedMessage = { role: 'user' | 'assistant'; time?: string };

/** 有日子的：那天和之后几天提醒 */
export const DUE_DAYS = 2;
/** 有日子的过了那天几天还没做就忘了 */
export const FORGET_DAYS = 3;
/** 「下次」的过了说的那天几天还没做就忘了 */
export const NEXT_TIME_DAYS = 7;
/** 一段聊天里她回了几次还没提，这段聊天里就不再放 */
export const SHOWN_REPLIES = 3;

const DAY_MS = 86_400_000;

/** 挂着的事在给模型的列表里怎么写 */
const LOOP_LABELS: Record<LoopKind, string> = { waiting: '等结果', unanswered: '没回答', unsettled: '没了结' };

/** 抽取的提示词：系统说明 + 还没做的事、还挂着的事和这一段聊天（转写同长期记忆，带日期行） */
export function promisePrompt(transcript: string, pending: readonly HerPromise[], names: MacroNames, loops: readonly OpenLoop[] = []): OpenAIMessage[] {
    const { char, user } = names;
    const system = [
        `你在帮一个聊天程序记「${char}答应过的事」。下面是${char}和${user}的一段 QQ 私聊记录，${char}是 AI 扮演的女大学生，${user}是真人。`,
        `挑出${char}自己说的、她之后要做的事：答应给${user}讲、推荐、帮他问、提醒他的事，答应和${user}一起做的事（见面、一起吃饭、去看演出），她自己的打算（去拍照、去图书馆、看完一本书）。`,
        `不要：做不到的事（发照片、发语音、发视频、打电话、开视频、寄东西）；玩笑和客套；${user}已经说了不用的；`,
        `这段聊天里已经做完的；${user}自己的事。`,
        '有日子的按那句话被说出时的日期换算（记录里每天开头有一行日期，「明天」就是那一天加一天，「周末」写那个周六），写成 YYYY-MM-DD；',
        MIDNIGHT_RULE,
        '说「下次」「回头」「改天」没说哪天的，date 写 null。what 写一句话，不超过 20 个字。',
        `和${user}约好见面、一起吃饭、去看演出的，再加 meet：{"time":"HH:MM","where":"在哪"}，time 是约的几点（24 小时制），where 没说就不写；没说几点、没有日子的不写 meet。`,
        `另外，「还没做的事」里如果有哪件在这段聊天里${char}已经做了、或者${user}说不用了，把它的 id 写进 resolved。`,
        `再挑三类「挂着的事」，都只写发生了什么，不写谁什么感受、不写评价（不要「难过」「委屈」「介意」「失望」这类词）：`,
        `- waiting：${user}说的、之后会发生、${char}会想知道结果的事（面试、考试、比赛、出行、看病、等通知），what 写「${user}…」，`,
        '  不写「明天」「下周」这类相对的说法（第二天再看就错了，日子写在 date 里），',
        '  date 写那件事哪天（换算同上），没说哪天写 null；',
        `- unanswered：${char}问了${user}一件她真想知道答案、要他给个回答的事（约他做什么、问他的打算或决定、问一件对她要紧的事），`,
        `  他接着说了别的，这段聊天里一直没回答，what 写她问的是什么。随口的关心和闲聊里的问句不算（在干嘛、吃了没、几点下班、今天干什么了、笑什么、`,
        `  哪家店），反问、玩笑也不算；她约他、他没接茬的算这一类，不算 unsettled。一段聊天最多记一条，挑最要紧的那件；`,
        `- unsettled：两个人已经说好的事最后没成（约好了又取消、说好的没做到）、或者一件正事说到一半就断了，what 写发生了什么`,
        '  （例如「10月5日说好一起回青岛，最后没走成」）；她提了他还没答应的不算（那是 unanswered）。不高兴、闹别扭也只写那件事本身。',
        `下面「还挂着的事」（id 以 a-、q-、u- 开头）在这段聊天里有了结果、${user}回答了、或者那件事了结了，也把 id 写进 resolved。`,
        `最后抽取${char}在聊天里明确说自己已经做完、并会改变她身边现实的动作，写进 world：`,
        `- feed_cat：已经下楼喂猫；pick_parcel：已经取快递；finish_homework：已经写完作业；family_call：已经和家里视频。`,
        `- receive_money：${user}给${char}转账、发红包、给钱（聊天里可能写成「［转账］2000元」「红包 200」），${char}收下了（没拒绝、没退回去）；`
            + `amount 写金额（整数元）；说了是给她买相机的写 "forCamera":true。这是唯一可以记${user}做的事的一类，at 是${char}收下时那句话。`,
        `只看${char}的已完成事实陈述；计划、将来时、猜测、玩笑、否定句、${user}做的事（收钱除外）都不要。at 必须是那句${char}消息的本地分钟 YYYY-MM-DDTHH:mm；`,
        '取快递可把物品、写作业可把课程写进 subject，没说清不填；喂猫只有明确说见到或没见到时才写 seen。',
        '只输出一个 JSON 对象，不要别的文字，例如：',
        '{"add":[{"what":"给他讲《三体》的结局","date":null},{"what":"去拍银杏","date":"2026-10-10"},'
            + '{"what":"和他去东门吃麻辣烫","date":"2026-10-16","meet":{"time":"18:00","where":"东门口"}}],'
            + '"waiting":[{"what":"他周四下午去字节面试","date":"2026-10-08"}],"unanswered":[{"what":"他国庆回不回家"}],'
            + '"unsettled":[{"what":"10月6日说好一起看电影，他加班没去成"}],"resolved":["p-1"],'
            + '"world":[{"kind":"feed_cat","at":"2026-10-07T20:31","seen":true}]}',
        '没有就输出 {"add":[],"waiting":[],"unanswered":[],"unsettled":[],"resolved":[],"world":[]}。',
    ].join('\n');
    const list = pending.length ? pending.map(p => `- ${p.id}：${p.date ?? '下次'} ${p.what}`).join('\n') : '（没有）';
    const hanging = loops.length
        ? loops.map(l => `- ${l.id}：${LOOP_LABELS[l.kind]}${l.date ? ` ${l.date}` : ''} ${l.what}`).join('\n')
        : '（没有）';
    return [
        { role: 'system', content: system },
        { role: 'user', content: `还没做的事：\n${list}\n\n还挂着的事：\n${hanging}\n\n聊天记录：\n${transcript}` },
    ];
}

export interface ExtractedPromises {
    add: { what: string; date?: string; meet?: Meetup }[];
    /** ADR 0023：挂着的事（没写的按空的） */
    waiting: { what: string; date?: string }[];
    unanswered: { what: string }[];
    unsettled: { what: string }[];
    resolved: string[];
    /** ADR 0027 / W3：她说自己已经做完、会改变身边现实的动作。 */
    world: WorldActionDraft[];
    /** 写成了情绪、没记的几条（日志用） */
    feelings: string[];
}

/** 模型的输出 → 结构；不是要的格式就抛错（下次再抽） */
export function parsePromises(text: string): ExtractedPromises {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`模型输出里没有 JSON：${text.slice(0, 80).replace(/\s*\n\s*/g, ' / ')}`);
    const data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const items = (value: unknown) => (Array.isArray(value) ? value : []).flatMap(item => {
        const o = (item ?? {}) as Record<string, unknown>;
        const what = typeof o.what === 'string' ? o.what.trim() : '';
        const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date.trim()) ? o.date.trim() : undefined;
        // 保留旧版“周末/下次”等非日期文字的处理，但不存在的日历日不能滚动成另一日或降为无限期承诺。
        if (date && !calendarDate(date)) return [];
        return what ? [{ what: what.slice(0, 40), ...(date ? { date } : {}) }] : [];
    });
    // 挂着的事只记事实：写成情绪的丢掉（ADR 0023）
    const feelings: string[] = [];
    const facts = <T extends { what: string }>(list: T[]) => list.filter(item => (isFeeling(item.what) ? (feelings.push(item.what), false) : true));
    const resolved = (Array.isArray(data.resolved) ? data.resolved : []).filter((id): id is string => typeof id === 'string');
    const kinds = new Set<WorldActionKind>(['feed_cat', 'pick_parcel', 'finish_homework', 'family_call', 'receive_money']);
    const world = (Array.isArray(data.world) ? data.world : []).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const action = item as Record<string, unknown>;
        if (typeof action.kind !== 'string' || !kinds.has(action.kind as WorldActionKind)) return [];
        const at = typeof action.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(action.at.trim()) ? action.at.trim() : undefined;
        // at 是把动作钉回她原话的证据；缺了或格式错了宁可不回写，不能猜到片段最后一句。
        if (!at) return [];
        const subject = typeof action.subject === 'string' ? action.subject.trim().slice(0, 40) : undefined;
        return [{
            kind: action.kind as WorldActionKind,
            at,
            ...(subject ? { subject } : {}),
            ...(typeof action.seen === 'boolean' ? { seen: action.seen } : {}),
            ...(typeof action.amount === 'number' && Number.isInteger(action.amount) && action.amount > 0 ? { amount: action.amount } : {}),
            ...(action.forCamera === true ? { forCamera: true } : {}),
        }];
    });
    // 约好的见面（ADR 0047）：要有日子和几点才算
    const add = (Array.isArray(data.add) ? data.add : []).flatMap(item => {
        const [base] = items([item]);
        if (!base) return [];
        const meet = base.date ? meetOf((item as Record<string, unknown> | null)?.meet) : undefined;
        return [{ ...base, ...(meet ? { meet } : {}) }];
    });
    return {
        add,
        waiting: facts(items(data.waiting)),
        // 一段聊天最多一条没回答的（第一批：随口的问句都挂上了，她第二天把「哪个窗口」也追着问）
        unanswered: facts(items(data.unanswered).map(({ what }) => ({ what }))).slice(0, 1),
        unsettled: facts(items(data.unsettled).map(({ what }) => ({ what }))),
        resolved,
        world,
        feelings,
    };
}

function meetOf(value: unknown): Meetup | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const o = value as Record<string, unknown>;
    const time = typeof o.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(o.time.trim()) ? o.time.trim() : undefined;
    if (!time) return undefined;
    const where = typeof o.where === 'string' && o.where.trim() ? o.where.trim().slice(0, 20) : undefined;
    return { time, ...(where ? { where } : {}), minutes: MEET_MINUTES };
}

/** 约好的见面从几点到几点（ADR 0047）；凌晨 5 点前的算她这一天之后的日历日 */
export function meetWindow(item: HerPromise): { start: Date; end: Date } | undefined {
    if (!item.meet || !item.date) return undefined;
    const [hour, minute] = item.meet.time.split(':').map(Number);
    const day = parseDay(item.date);
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (hour! < 5 ? 1 : 0), hour, minute);
    return { start, end: new Date(start.getTime() + item.meet.minutes * 60_000) };
}

/** 到了「快出门」的时候：从这一刻起时间块不再提醒这件，状态行接手 */
function meetStarted(item: HerPromise, at: Date): boolean {
    const window = meetWindow(item);
    return Boolean(window && at.getTime() >= window.start.getTime() - MEET_LEAD_MINUTES * 60_000);
}

/**
 * 状态行里赴约的那一句（ADR 0047）。和这个人约的写约了什么、见了面也在 QQ 上说；和别人约的只说在外面、约了人（不说和谁、做什么）
 */
export function describeAppointment(meeting: Appointment, viewer: Contact, at: Date): string {
    const { time, where } = meeting.promise.meet!;
    const mine = meeting.contact.qq === viewer.qq;
    if (at.getTime() < meeting.start.getTime()) return mine ? `快出门了，${time} 约好的：${meeting.promise.what}` : `快出门了，${time} 约了人`;
    return mine
        ? `约好的：${meeting.promise.what}（${time}${where ? `，${where}` : ''}），正在赴约；见了面你们也在 QQ 上打字说话`
        : `在外面，约了人（${time} 起）`;
}

/** 同一天同一钟点的约见面算同一件（先抽的和整段抽的说法可能不一样） */
function sameMeetup(a: HerPromise, b: HerPromise): boolean {
    return Boolean(a.meet && b.meet && a.date === b.date && a.meet.time === b.meet.time);
}

/** 这一段先抽出来的约见面 */
const earlyIn = (episode: string) => (p: HerPromise) => Boolean(p.early && p.episode === episode);

/**
 * 最近几句里有约见面、也有时间的字眼（ADR 0047 调整）：只用来决定要不要先抽，抽不抽得出来看模型。
 * 光说「吃饭」「等你」不算（聊吃什么、「等你回来」太常见，每 5 分钟多调一次模型不值）
 */
// DSH 10-15 复核 0066 问题 4：「我明天去楼下取个快递」被当成约（门口 / 楼下 + 明天），「明天约吗」这类问法却漏掉。
// 门口 / 楼下是地点，不是约；和取快递 / 外卖这类跑腿的话一起出现就不算（「三点东门口，别忘了」照旧算）。「约吗 / 约不约 / 约一下」要算
const MEET_WORDS = /见面|见个面|见一面|见见你|一起(?:去|吃|看|逛)|约(?:你|好|了|吗|不约|一下|个)|吃个饭|吃顿|请你吃|电影|演唱会|找你|接你/;
const MEET_PLACE = /门口|楼下/;
const ERRAND = /快递|外卖|驿站|取件|取货|取个|拿个/;
const MEET_TIME = /\d{1,2}\s*[:：点]|[一二两三四五六七八九十]+点|今晚|晚上|中午|下午|明天|后天|周[一二三四五六日天]|礼拜/;
export function mentionsMeetup(messages: readonly { content: string }[]): boolean {
    const text = messages.slice(-8).map(m => m.content).join('\n');
    return (MEET_WORDS.test(text) || (MEET_PLACE.test(text) && !ERRAND.test(text))) && MEET_TIME.test(text);
}

function parseDay(date: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d);
}

const daysFrom = (date: string, day: Date) => Math.round((day.getTime() - parseDay(date).getTime()) / DAY_MS);

/** 忘了吗：有日子的过了那天 FORGET_DAYS 天，「下次」的过了说的那天 NEXT_TIME_DAYS 天（today 是她的一天） */
export function forgotten(item: HerPromise, today: Date): boolean {
    return item.date ? daysFrom(item.date, today) > FORGET_DAYS : daysFrom(item.said, today) > NEXT_TIME_DAYS;
}

/**
 * 这一轮要不要提醒：有日子的在那天到之后 DUE_DAYS 天，「下次」的在说的那段聊天之后；
 * 这一段聊天（最后一个片段）里她已经回了 SHOWN_REPLIES 次的，都不放了。
 * 这一段聊天里说的（含片段还没结束时先抽出来的约见面，ADR 0047 调整）都不放：刚说完的事不用再提醒她，免得把「六点东门见」再说一遍
 */
export function duePromises(items: readonly HerPromise[], today: Date, chat: readonly TimedMessage[]): HerPromise[] {
    const current = splitEpisodes(chat.flatMap(m => (m.time ? [{ role: m.role, content: '', time: m.time }] : []))).at(-1);
    const replies = current ? current.messages.filter((m, i) => m.role === 'assistant' && current.messages[i - 1]?.role !== 'assistant').length : 0;
    if (replies >= SHOWN_REPLIES) return [];
    return items.filter(item => item.episode !== current?.id && (item.date
        ? daysFrom(item.date, today) >= 0 && daysFrom(item.date, today) <= DUE_DAYS
        : true));
}

/** 「10月5日」「今天」「昨天」（相对她的一天） */
function dayText(date: string, today: Date): string {
    const diff = daysFrom(date, today);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    const day = parseDay(date);
    return `${day.getMonth() + 1}月${day.getDate()}日`;
}

/** 时间块里的一行；没有就是 undefined */
export function describePromises(items: readonly HerPromise[], today: Date, userName: string): string | undefined {
    if (items.length === 0) return undefined;
    const list = items.map(item => `${item.what}（${dayText(item.said, today)}说的${item.date ? `，打算${dayText(item.date, today)}` : '，说下次'}）`);
    return `你之前答应过${userName}、还没做的事：${list.join('；')}。合适的时候接着说或者提一句，说过了就不用再提。`;
}

export interface PromiseKeeperOptions {
    /** 名单（名单外的不记） */
    contacts: readonly Contact[];
    history: { load(qq: number): StoredMessage[] };
    /** 每个人的名字（她的名字按那个人的档位卡） */
    names: (contact: Contact) => MacroNames;
    /** 她的一天怎么算（卡上的作息）；没有就按日历日 */
    schedule?: Schedule;
    /** 抽取的模型调用 */
    extract: (messages: OpenAIMessage[]) => Promise<string>;
    /** 状态文件目录（<数据目录>/promises） */
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    /** W3：复用这次抽取，不增加模型调用；成功落地后片段才标成已抽。 */
    onWorldActions?: (contact: Contact, episode: Episode, actions: readonly WorldActionDraft[]) => void;
}

type KeeperState = PromiseState;

const LOOP_PREFIX: Record<LoopKind, string> = { waiting: 'a', unanswered: 'q', unsettled: 'u' };

export interface PromiseKeeper {
    /** 验证约定来源是否可用；false 不是“没有约定”。损坏暂停直到重建 keeper。 */
    available(): boolean;
    /** 把结束了、还没抽的片段抽一遍，过期的忘掉；同一时间只跑一次 */
    sync(): Promise<void>;
    /** 这一轮时间块里的那一行（没有就是 undefined） */
    describe(contact: Contact, chat: readonly TimedMessage[], now: Date): string | undefined;
    /** 这一轮挂在心上的事（ADR 0023）：意图行、时间块用 */
    openLoops(contact: Contact, chat: readonly TimedMessage[], now: Date): DueLoops;
    /** 她那天的打算（日记材料用）：名单里所有人那儿说过的、日子是那天的 */
    plansOn(date: string): string[];
    /** 这一刻在赴约或快出门的（ADR 0047）：名单里所有人那儿约的 */
    appointmentsAt(at: Date): Appointment[];
    /** 一段时间内会占用她的约定；自主生活选择器用它预留出门到见完的时段。 */
    appointmentsBetween(from: Date, to: Date): Appointment[];
}

export function promiseKeeper(options: PromiseKeeperOptions): PromiseKeeper {
    const now = options.now ?? Date.now;
    mkdirSync(options.dir, { recursive: true });
    const path = (contact: Contact) => join(options.dir, `${contact.qq}-${contact.tier}.json`);
    const paused = new Set<string>();
    const pause = (contact: Contact, error?: unknown) => {
        if (!paused.has(path(contact))) options.log(`[${contact.qq}] 承诺状态处理失败，暂停承诺抽取与使用；原文件未重建，请修复后重建 keeper${error === undefined ? '' : `（原因：${describeError(error)}）`}`);
        paused.add(path(contact));
    };
    // 暂时读不到 / 写不进（句柄或内存不足、杀毒软件占文件）不等于状态坏了：宽限期里跳过这一轮、下次再试，
    // 拖过宽限期才按永久处理（10-19 22:08 一次内存紧张曾让三处模块各自「暂停到重启」一小时）。读和写各记各的。
    const gate = createTransientGate();
    const transient = (contact: Contact, verb: '读' | '写', error: unknown) => {
        const key = `${verb}:${path(contact)}`;
        if (gate.fail(key, now()) === 'give-up') { pause(contact, error); return; }
        if (gate.shouldLog(key, now())) options.log(`[${contact.qq}] 承诺状态暂时${verb}不了（${describeError(error)}），这一轮先跳过、下一轮再试；持续 5 分钟才暂停`);
    };
    const recovered = (contact: Contact, verb: '读' | '写') => {
        if (gate.ok(`${verb}:${path(contact)}`)) options.log(`[${contact.qq}] 承诺状态${verb}得动了，恢复正常`);
    };
    const load = (contact: Contact): KeeperState | undefined => {
        if (paused.has(path(contact))) return undefined;
        try {
            const state = readPromiseState(path(contact));
            recovered(contact, '读');
            return state;
        } catch (error) {
            if (error instanceof TransientStateError) transient(contact, '读', error);
            else pause(contact, error);
            return undefined;
        }
    };
    const save = (contact: Contact, state: KeeperState) => {
        // 抽过的片段只留最近的（片段 id 是 ep-<毫秒>）
        const keepFrom = now() - 30 * DAY_MS;
        for (const id of Object.keys(state.extracted)) if (Number(id.slice(3)) < keepFrom) delete state.extracted[id];
        for (const id of Object.keys(state.early)) if (Number(id.slice(3)) < keepFrom || state.extracted[id] === true) delete state.early[id];
        if (paused.has(path(contact)) || !validPromiseState(state)) throw new PromiseStateUnavailable('承诺状态无效，拒绝写入');
        writeJsonAtomic(path(contact), state);
        recovered(contact, '写');
    };
    const available = (): boolean => options.contacts.map(contact => load(contact) !== undefined).every(Boolean);
    const knownAppointments = (from: Date, to: Date): Appointment[] => options.contacts.flatMap(contact =>
        (load(contact)?.promises ?? []).flatMap(promise => {
            const window = meetWindow(promise);
            if (!window) return [];
            const lead = window.start.getTime() - MEET_LEAD_MINUTES * 60_000;
            if (lead >= to.getTime() || window.end.getTime() <= from.getTime()) return [];
            return [{ contact, promise, ...window }];
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime()
            || a.contact.qq - b.contact.qq || a.promise.id.localeCompare(b.promise.id));
    const appointmentsBetween = (from: Date, to: Date): Appointment[] => {
        if (!available()) throw new PromiseStateUnavailable('约定来源不可用，不能将未知约定当成空日历继续安排');
        return knownAppointments(from, to);
    };
    const today = (at: Date) => (options.schedule ? herDay(options.schedule, at) : new Date(at.getFullYear(), at.getMonth(), at.getDate()));

    async function syncContact(contact: Contact): Promise<void> {
        const state = load(contact);
        if (!state) return;
        const log = (message: string) => options.log(`[${contact.qq}] 她答应的事：${message}`);
        const loopLog = (message: string) => options.log(`[${contact.qq}] 挂着的事：${message}`);
        const names = options.names(contact);
        const day = today(new Date(now()));
        const before = state.promises.length;
        for (const item of state.promises.filter(p => forgotten(p, day))) log(`过了日子没做，忘了「${logBody(item.what)}」`);
        state.promises = state.promises.filter(p => !forgotten(p, day));
        const loopsBefore = state.loops.length;
        for (const loop of state.loops.filter(l => loopForgotten(l, day))) loopLog(`过了几天，放下「${loop.what}」`);
        state.loops = state.loops.filter(l => !loopForgotten(l, day));
        let changed = state.promises.length !== before || state.loops.length !== loopsBefore;
        const closed = splitEpisodes(options.history.load(contact.qq))
            .filter(e => now() - e.end.getTime() >= EPISODE_GAP_MS && state.extracted[e.id] !== true);
        /** 这一轮没连上模型：后面的片段、还没结束的那段都不再抽 */
        let offline = false;
        for (const episode of closed) {
            // 只有一方说话的片段、太早的片段（刚上线时）不用抽
            const said = formatDate(today(episode.end));
            if (!episode.messages.some(m => m.role === 'assistant') || !episode.messages.some(m => m.role === 'user') || daysFrom(said, day) > NEXT_TIME_DAYS) {
                state.extracted[episode.id] = true;
                changed = true;
                continue;
            }
            let result: ExtractedPromises;
            // 这一段先抽出来的约见面不给模型（整段抽是这一段的定论，抽完整个替换）
            const pending = state.promises.filter(p => !earlyIn(episode.id)(p));
            try {
                result = parsePromises(await options.extract(promisePrompt(episodeTranscript(episode, names), pending, names, state.loops)));
            } catch (error) {
                if (error instanceof ModelUnreachable) {
                    // 没连上模型（断网、DNS）不算这一段的失败次数，不然断网一会儿她答应的事就丢了；后面的片段也连不上，这一轮先停
                    log(`片段 ${episode.id} 没连上模型，等网络好了再抽：${error.message}`);
                    offline = true;
                    break;
                }
                const tries = (typeof state.extracted[episode.id] === 'number' ? state.extracted[episode.id] as number : 0) + 1;
                // 模型回了、但连着 3 次都不对就放弃这一段（别一直调模型）
                state.extracted[episode.id] = tries >= 3 ? true : tries;
                save(contact, state);
                log(`片段 ${episode.id} 抽取失败（第 ${tries} 次${tries >= 3 ? '，不再抽' : '，下次再抽'}）：${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            if (paused.has(path(contact))) return;
            try {
                options.onWorldActions?.(contact, episode, result.world);
            } catch (error) {
                // 模型结果是好的，但事实文件没写成：不标已抽，下次重试同一片段，不能只在内存里生效。
                log(`片段 ${episode.id} 的世界动作写入失败（下次再试）：${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            for (const id of result.resolved) {
                const item = state.promises.find(p => p.id === id);
                if (item) {
                    state.promises = state.promises.filter(p => p.id !== id);
                    log(`划掉「${logBody(item.what)}」（做了，或者他说不用了）`);
                }
                const loop = state.loops.find(l => l.id === id);
                if (loop) {
                    state.loops = state.loops.filter(l => l.id !== id);
                    loopLog(`了结「${loop.what}」`);
                }
            }
            const earlier = state.promises.filter(earlyIn(episode.id));
            state.promises = state.promises.filter(p => !earlyIn(episode.id)(p));
            for (const [i, add] of result.add.entries()) {
                const item: HerPromise = {
                    id: `p-${episode.start.getTime()}-${i + 1}`, what: add.what, ...(add.date ? { date: add.date } : {}), said, episode: episode.id, ...(add.meet ? { meet: add.meet } : {}),
                };
                // 日子在今天之前的不记：晚了才抽到（刚上线补抽以前的片段），那天已经过去了，不该再提醒「打算那天」（10-07 线上日志）
                if (item.date && daysFrom(item.date, day) > 0) continue;
                if (forgotten(item, day) || state.promises.some(p => p.what === item.what && p.date === item.date)) continue;
                if (item.meet && state.promises.some(p => sameMeetup(p, item))) continue;
                state.promises.push(item);
                log(`记下「${logBody(item.what)}」（${item.date ?? '下次'}${item.meet ? ` ${item.meet.time}${item.meet.where ? ` ${logBody(item.meet.where)}` : ''}` : ''}）`);
            }
            for (const item of earlier) {
                if (!state.promises.some(p => sameMeetup(p, item))) log(`划掉先记下的「${logBody(item.what)}」（${item.date} ${item.meet!.time}；整段看下来改了或者不去了）`);
            }
            const found: [LoopKind, { what: string; date?: string }[]][] = [['waiting', result.waiting], ['unanswered', result.unanswered], ['unsettled', result.unsettled]];
            for (const [kind, list] of found) {
                for (const [i, add] of list.entries()) {
                    const loop: OpenLoop = {
                        id: `${LOOP_PREFIX[kind]}-${episode.start.getTime()}-${i + 1}`, kind, what: add.what, ...(add.date ? { date: add.date } : {}), said, episode: episode.id,
                    };
                    if (loopForgotten(loop, day) || state.loops.some(l => l.kind === kind && l.what === loop.what)) continue;
                    state.loops.push(loop);
                    loopLog(`记下「${logBody(loop.what)}」（${LOOP_LABELS[kind]}${loop.date ? `，${loop.date}` : ''}）`);
                }
            }
            if (result.feelings.length) loopLog(`写成了情绪、没记 ${result.feelings.length} 条（只记发生了什么）`);
            state.extracted[episode.id] = true;
            save(contact, state);
            changed = false;
        }
        // 还没结束的这一段（ADR 0047 调整）：聊着聊着约了见面、马上就见，等不到片段结束（安静 45 分钟）再抽；
        // 两个人都说过话、最近几句里有约见面和时间的字眼、又多了新消息，就先抽一次，只记约好的见面。
        // 每次先抽都用新结果整个替换这一段先记下的（改时间、不去了跟着变）；片段结束后整段抽是定论，同样整个替换
        const open = splitEpisodes(options.history.load(contact.qq)).at(-1);
        if (!offline && open && now() - open.end.getTime() < EPISODE_GAP_MS && state.extracted[open.id] !== true
            && (state.early[open.id] ?? 0) < open.messages.length
            && open.messages.some(m => m.role === 'assistant') && open.messages.some(m => m.role === 'user') && mentionsMeetup(open.messages)) {
            try {
                const pending = state.promises.filter(p => !earlyIn(open.id)(p));
                const result = parsePromises(await options.extract(promisePrompt(episodeTranscript(open, names), pending, names, state.loops)));
                if (paused.has(path(contact))) return;
                const said = formatDate(today(open.end));
                const earlier = state.promises.filter(earlyIn(open.id));
                const next: HerPromise[] = [];
                for (const [i, add] of result.add.entries()) {
                    if (!add.meet || !add.date || daysFrom(add.date, day) > 0) continue;
                    // id 带上这次先抽时的消息数：同一段第二次先抽不会和第一次撞
                    const item: HerPromise = { id: `p-${open.start.getTime()}-m${open.messages.length}-${i + 1}`, what: add.what, date: add.date, said, episode: open.id, meet: add.meet, early: true };
                    if (pending.some(p => sameMeetup(p, item)) || next.some(p => sameMeetup(p, item))) continue;
                    // 和上次先记下的是同一个约就留着原来那条（id 不变）
                    next.push(earlier.find(p => sameMeetup(p, item)) ?? item);
                }
                for (const item of earlier.filter(p => !next.includes(p))) log(`划掉先记下的「${logBody(item.what)}」（${item.date} ${item.meet!.time}；改了或者不去了）`);
                for (const item of next.filter(p => !earlier.includes(p))) {
                    log(`聊着就约了，先记下「${logBody(item.what)}」（${item.date} ${item.meet!.time}${item.meet!.where ? ` ${logBody(item.meet!.where)}` : ''}）`);
                }
                state.promises = [...pending, ...next];
                state.early[open.id] = open.messages.length;
            } catch (error) {
                // 没连上模型下一轮再试；别的错这几条消息不再试，片段结束后照常整段抽
                if (!(error instanceof ModelUnreachable)) state.early[open.id] = open.messages.length;
                log(`还没结束的片段 ${open.id} 先抽约见面没抽成：${error instanceof Error ? error.message : String(error)}`);
            }
            changed = true;
        }
        if (changed) save(contact, state);
    }

    let running: Promise<void> | undefined;
    return {
        sync: () => {
            running ??= (async () => {
                for (const contact of options.contacts) {
                    try { await syncContact(contact); }
                    catch (error) {
                        // 暂时的写失败：这一轮的改动没落盘，状态文件还是上一版，下一轮同一批片段会再抽一遍（抽取本来就幂等重试）
                        if (isTransientIoError(error)) transient(contact, '写', error);
                        else pause(contact, error);
                    }
                }
            })().finally(() => { running = undefined; });
            return running;
        },
        available,
        describe: (contact, chat, at) => {
            const state = load(contact);
            if (!state) return '承诺记录暂不可确认：不要编造过去答应的事或认定没有约定；涉及约见时先确认。不要把内部状态或错误信息说给对方。';
            const day = today(at);
            // 约好的见面到了快出门的时候就不在这里提醒了，状态行接手（ADR 0047）
            const items = duePromises(state.promises.filter(p => !forgotten(p, day) && !meetStarted(p, at)), day, chat);
            return describePromises(items, day, contact.name);
        },
        openLoops: (contact, chat, at) => dueLoops(load(contact)?.loops ?? [], today(at), at, chat),
        plansOn: date => {
            if (!available()) throw new PromiseStateUnavailable('承诺来源不可用，不能生成缺失计划来源的日记');
            return options.contacts.flatMap(contact => load(contact)!.promises.filter(p => p.date === date).map(p => p.what));
        },
        appointmentsAt: at => knownAppointments(at, new Date(at.getTime() + 1)),
        appointmentsBetween,
    };
}
