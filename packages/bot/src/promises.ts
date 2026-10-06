// 她答应过的事（ADR 0018 决策 2）：她说的、她之后要做的事（「下次给你讲」「周末打算去拍照」），到时候记得。
// - 抽：一段聊天结束（安静 45 分钟，和长期记忆同一个片段）后，用模型从这一段里抽，输出 JSON；同时把还没做的几件给模型，
//   这一段里她已经做了、或者他说不用了的划掉。做不到的事（见面、发照片和语音、打电话、寄东西）不抽，同出口检查（ADR 0006）。
//   名单里的人都抽；刚上线时只抽最近 NEXT_TIME_DAYS 天里结束的片段（再早的反正也过期了）。
// - 用：到了日子（有日子的：那天和之后 DUE_DAYS 天；「下次」的：之后的聊天），时间块里加一行；这一段聊天里她回了 SHOWN_REPLIES 次还没提的，
//   这段聊天里不再放（ADR 0014：说明里的话她会每句都照做，不能一直挂着）。
// - 忘：有日子的过了 FORGET_DAYS 天、「下次」的过了 NEXT_TIME_DAYS 天还没做就忘了。
// - 她自己那天的打算写进日记材料（diary.ts），日记和她说过的对得上。
// 每个人一个状态文件 <数据目录>/promises/<QQ>-<档位>.json。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from './config.ts';
import type { StoredMessage } from './history.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { EPISODE_GAP_MS, episodeTranscript, splitEpisodes } from './memory/episodes.ts';
import type { OpenAIMessage } from './prompt.ts';
import { formatDate, herDay, type Schedule } from './schedule.ts';
import type { MacroNames } from './st/macros.ts';

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
}

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** 抽取的提示词：系统说明 + 还没做的事和这一段聊天（转写同长期记忆，带日期行） */
export function promisePrompt(transcript: string, pending: readonly HerPromise[], names: MacroNames): OpenAIMessage[] {
    const { char, user } = names;
    const system = [
        `你在帮一个聊天程序记「${char}答应过的事」。下面是${char}和${user}的一段 QQ 私聊记录，${char}是 AI 扮演的女大学生，${user}是真人。`,
        `挑出${char}自己说的、她之后要做的事：答应给${user}讲、推荐、帮他问、提醒他的事，她自己的打算（去拍照、去图书馆、看完一本书）。`,
        `不要：做不到的事（见面、一起吃饭、发照片、发语音、发视频、打电话、开视频、寄东西或送东西）；玩笑和客套；${user}已经说了不用的；`,
        `这段聊天里已经做完的；${user}自己的事。`,
        '有日子的按那句话被说出时的日期换算（记录里每天开头有一行日期，「明天」就是那一天加一天，「周末」写那个周六），写成 YYYY-MM-DD；',
        '说「下次」「回头」「改天」没说哪天的，date 写 null。what 写一句话，不超过 20 个字。',
        `另外，「还没做的事」里如果有哪件在这段聊天里${char}已经做了、或者${user}说不用了，把它的 id 写进 resolved。`,
        '只输出一个 JSON 对象，不要别的文字，例如：{"add":[{"what":"给他讲《三体》的结局","date":null},{"what":"去拍银杏","date":"2026-10-10"}],"resolved":["p-1"]}',
        '没有就输出 {"add":[],"resolved":[]}。',
    ].join('\n');
    const list = pending.length ? pending.map(p => `- ${p.id}：${p.date ?? '下次'} ${p.what}`).join('\n') : '（没有）';
    return [
        { role: 'system', content: system },
        { role: 'user', content: `还没做的事：\n${list}\n\n聊天记录：\n${transcript}` },
    ];
}

export interface ExtractedPromises {
    add: { what: string; date?: string }[];
    resolved: string[];
}

/** 模型的输出 → 结构；不是要的格式就抛错（下次再抽） */
export function parsePromises(text: string): ExtractedPromises {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`模型输出里没有 JSON：${text.slice(0, 80).replace(/\s*\n\s*/g, ' / ')}`);
    const data = JSON.parse(text.slice(start, end + 1)) as { add?: unknown; resolved?: unknown };
    const add = (Array.isArray(data.add) ? data.add : []).flatMap(item => {
        const o = item as Record<string, unknown>;
        const what = typeof o.what === 'string' ? o.what.trim() : '';
        const date = typeof o.date === 'string' && DATE.test(o.date.trim()) ? o.date.trim() : undefined;
        return what ? [{ what: what.slice(0, 40), ...(date ? { date } : {}) }] : [];
    });
    const resolved = (Array.isArray(data.resolved) ? data.resolved : []).filter((id): id is string => typeof id === 'string');
    return { add, resolved };
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
 * 这一段聊天（最后一个片段）里她已经回了 SHOWN_REPLIES 次的，都不放了
 */
export function duePromises(items: readonly HerPromise[], today: Date, chat: readonly TimedMessage[]): HerPromise[] {
    const current = splitEpisodes(chat.flatMap(m => (m.time ? [{ role: m.role, content: '', time: m.time }] : []))).at(-1);
    const replies = current ? current.messages.filter((m, i) => m.role === 'assistant' && current.messages[i - 1]?.role !== 'assistant').length : 0;
    if (replies >= SHOWN_REPLIES) return [];
    return items.filter(item => (item.date
        ? daysFrom(item.date, today) >= 0 && daysFrom(item.date, today) <= DUE_DAYS
        : item.episode !== current?.id));
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
}

interface KeeperState {
    promises: HerPromise[];
    /** 片段 id → 抽过了（true），或者抽失败了几次 */
    extracted: Record<string, true | number>;
}

export interface PromiseKeeper {
    /** 把结束了、还没抽的片段抽一遍，过期的忘掉；同一时间只跑一次 */
    sync(): Promise<void>;
    /** 这一轮时间块里的那一行（没有就是 undefined） */
    describe(contact: Contact, chat: readonly TimedMessage[], now: Date): string | undefined;
    /** 她那天的打算（日记材料用）：名单里所有人那儿说过的、日子是那天的 */
    plansOn(date: string): string[];
}

export function promiseKeeper(options: PromiseKeeperOptions): PromiseKeeper {
    const now = options.now ?? Date.now;
    mkdirSync(options.dir, { recursive: true });
    const path = (contact: Contact) => join(options.dir, `${contact.qq}-${contact.tier}.json`);
    const load = (contact: Contact): KeeperState => {
        const data = readJsonOr<Partial<KeeperState>>(path(contact), {}, message => options.log(`[${contact.qq}] 她答应的事：${message}`));
        return { promises: data.promises ?? [], extracted: data.extracted ?? {} };
    };
    const save = (contact: Contact, state: KeeperState) => {
        // 抽过的片段只留最近的（片段 id 是 ep-<毫秒>）
        const keepFrom = now() - 30 * DAY_MS;
        for (const id of Object.keys(state.extracted)) if (Number(id.slice(3)) < keepFrom) delete state.extracted[id];
        writeJsonAtomic(path(contact), state);
    };
    const today = (at: Date) => (options.schedule ? herDay(options.schedule, at) : new Date(at.getFullYear(), at.getMonth(), at.getDate()));

    async function syncContact(contact: Contact): Promise<void> {
        const state = load(contact);
        const log = (message: string) => options.log(`[${contact.qq}] 她答应的事：${message}`);
        const names = options.names(contact);
        const day = today(new Date(now()));
        const before = state.promises.length;
        for (const item of state.promises.filter(p => forgotten(p, day))) log(`过了日子没做，忘了「${item.what}」`);
        state.promises = state.promises.filter(p => !forgotten(p, day));
        let changed = state.promises.length !== before;
        const closed = splitEpisodes(options.history.load(contact.qq))
            .filter(e => now() - e.end.getTime() >= EPISODE_GAP_MS && state.extracted[e.id] !== true);
        for (const episode of closed) {
            // 只有一方说话的片段、太早的片段（刚上线时）不用抽
            const said = formatDate(today(episode.end));
            if (!episode.messages.some(m => m.role === 'assistant') || !episode.messages.some(m => m.role === 'user') || daysFrom(said, day) > NEXT_TIME_DAYS) {
                state.extracted[episode.id] = true;
                changed = true;
                continue;
            }
            let result: ExtractedPromises;
            try {
                result = parsePromises(await options.extract(promisePrompt(episodeTranscript(episode, names), state.promises, names)));
            } catch (error) {
                const tries = (typeof state.extracted[episode.id] === 'number' ? state.extracted[episode.id] as number : 0) + 1;
                // 连着失败 3 次就放弃这一段（别一直调模型）
                state.extracted[episode.id] = tries >= 3 ? true : tries;
                save(contact, state);
                log(`片段 ${episode.id} 抽取失败（第 ${tries} 次${tries >= 3 ? '，不再抽' : '，下次再抽'}）：${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            for (const id of result.resolved) {
                const item = state.promises.find(p => p.id === id);
                if (!item) continue;
                state.promises = state.promises.filter(p => p.id !== id);
                log(`划掉「${item.what}」（做了，或者他说不用了）`);
            }
            for (const [i, add] of result.add.entries()) {
                const item: HerPromise = { id: `p-${episode.start.getTime()}-${i + 1}`, what: add.what, ...(add.date ? { date: add.date } : {}), said, episode: episode.id };
                if (forgotten(item, day) || state.promises.some(p => p.what === item.what && p.date === item.date)) continue;
                state.promises.push(item);
                log(`记下「${item.what}」（${item.date ?? '下次'}）`);
            }
            state.extracted[episode.id] = true;
            save(contact, state);
            changed = false;
        }
        if (changed) save(contact, state);
    }

    let running: Promise<void> | undefined;
    return {
        sync: () => {
            running ??= (async () => {
                for (const contact of options.contacts) await syncContact(contact);
            })().finally(() => { running = undefined; });
            return running;
        },
        describe: (contact, chat, at) => {
            const day = today(at);
            const items = duePromises(load(contact).promises.filter(p => !forgotten(p, day)), day, chat);
            return describePromises(items, day, contact.name);
        },
        plansOn: date => options.contacts.flatMap(contact => load(contact).promises.filter(p => p.date === date).map(p => p.what)),
    };
}
