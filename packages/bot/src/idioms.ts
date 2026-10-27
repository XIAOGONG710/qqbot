// 被他带出来的口头习惯（ADR 0138，配置 idioms，默认关）：处久了的两个人会互相沾说话的习惯——他爱说「笑死」，她过阵子也会顺口来一句。
// 她原来的口头禅全是卡上写死的，和他怎么说话没关系；麦麦（MaiBot）的“表达学习”是从群友聊天里学说法，这里做成最小的一种：只学**说话的习惯**，不学内容。
// 做法照小梗（jokes.ts，ADR 0114）：隔一阵让模型从他最近的话里挑最多 8 个口头习惯（口头禅、句首句尾的语气词 / 感叹词、爱用的网络说法），
// 代码硬校验——必须是他自己的话里**原样出现过至少 4 条、分布在至少 3 个不同的日子**的 1–6 个字的短语；人名 / 地名 / 作品名这类名词、数字、脏话、危机相关的词、
// 卡上的禁用词、太泛的（嗯、哈哈、好的）一律丢掉。存在 <数据目录>/idioms/<QQ>.json（派生数据，可以随时删，会重新学；导出 / 遗忘时跟着走）。
// 用的时候：聊天提示词里约一半的轮次多一行“他平时爱说 X、Y，这一轮正好用得上就顺口用一个”；她自己最近三次回复里用过的不再给；他难过 / 危机 / 小别扭时不给。
// 她的语气、长短、条数都不变——只是偶尔多一个词。她不学他的内容，不学他的称呼，也不会提这件事。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectCrisis } from './emotion/crisis.ts';
import { pick } from './reply-timing.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Idiom {
    /** 原样出现在他的话里的短语 */
    phrase: string;
    kind: string;
    /** 窗口里有多少条他的消息里出现过 */
    count: number;
    /** 分布在几个不同的日子 */
    days: number;
}
export interface IdiomState {
    version: 1;
    items: Idiom[];
    /** 上一次学的时刻（ISO） */
    updatedAt?: string;
    /** 上一次学时他的消息一共多少条 */
    messageCount?: number;
}

/** 多久看一眼该不该学（学不学由下面的条件定） */
export const IDIOMS_CHECK_MS = 6 * HOUR;
/** 隔多久最多学一次 */
export const IDIOMS_REFRESH_MS = 20 * HOUR;
/** 最近这么多天他的话拿去学 */
export const IDIOMS_WINDOW_DAYS = 30;
/** 窗口里他至少发过这么多条才学（太少看不出习惯） */
export const IDIOMS_MIN_MESSAGES = 60;
/** 比上次学至少多这么多条他的新消息才再学 */
export const IDIOMS_MIN_NEW = 20;
/** 最多留几个 */
export const IDIOMS_KEPT = 8;
/** 短语要在他的几条不同消息里原样出现过 / 分布在几个不同的日子 */
export const IDIOM_MIN_OCCURRENCES = 4;
export const IDIOM_MIN_DAYS = 3;
/** 短语长度（字） */
export const IDIOM_MIN_CHARS = 1;
export const IDIOM_MAX_CHARS = 6;
/** 这一轮给她看的概率（按他最后一句取哈希） */
export const IDIOM_TURN_SHARE = 0.5;
/** 一次最多给她看几个 */
export const IDIOM_SHOWN = 2;
/** 他最近这么久之内还在说才给（不然是老习惯了） */
export const IDIOM_FRESH_DAYS = 14;
/** 她自己最近几次回复里用过就不再给 */
export const IDIOM_COOLDOWN_REPLIES = 3;

type Said = { role: 'user' | 'assistant'; content: string; time?: string };

/** 太泛的：每个人每天都在说，不算“他的习惯” */
const GENERIC = new Set(['嗯', '嗯嗯', '哦', '哦哦', '啊', '呀', '吧', '呢', '吗', '嘛', '的', '了', '好', '好的', '好吧', '行', '可以', '是', '对', '不', '没', '我', '你', '他', '她', '哈哈', '哈哈哈', '哈哈哈哈', '在', '在吗', '呃', '额', '哎', '诶']);
/** 脏话 / 辱骂：她不学（卡上也不让她说）；「卧槽」「我靠」这类也不收 */
const VULGAR = /操|艹|妈|逼|屌|婊|贱|傻|蠢|滚|nmsl|cnm|tmd|wc|sb|卧槽|我靠|他娘|尼玛/i;

export const idiomsPrompt = (userName: string, charName: string, lines: string) => `下面是${userName}最近一个月跟${charName}聊天时他自己发的话（只有他发的）。请找出他说话的**口头习惯**：口头禅、常挂在句首或句尾的语气词 / 感叹词、爱用的网络说法或缩写。
要求：
- 只输出一个 JSON 数组，最多 ${IDIOMS_KEPT} 个：[{"说法":"他的话里原样出现的短语（${IDIOM_MIN_CHARS}–${IDIOM_MAX_CHARS} 个字）","类型":"口头禅 或 语气词 或 网络说法"}]；没有就输出 []。
- “说法”必须是他的话里**原样**出现过的字，不许改写、概括、编；要挑他比一般人更爱说的，别挑谁都说的（嗯、好的、哈哈）。
- 只要说话的习惯，不要内容：不要人名、地名、学校 / 专业 / 课程名、游戏名 / 作品名这类名词，不要日期数字，不要抱怨 / 倾诉里的句子，不要脏话，不要他叫${charName}的称呼。
他的话：
${lines}`;

/** 他的话里去掉“[引用…]”前缀（那是她的话）和占位符 */
export function ownWords(content: string): string {
    return content.replace(/^\[引用.*?」\]/, '').replace(/\[(?:图片|语音|视频|表情|撤回了一条消息)[^\]]*\]/g, '').trim();
}

const localDay = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** 窗口里他的消息（带时间、去掉前缀占位符、危机相关的不要） */
export function hisMessages(history: readonly Said[], now: number): { content: string; time: string }[] {
    return history
        .filter(message => message.role === 'user' && message.time !== undefined)
        .map(message => ({ content: ownWords(message.content), time: message.time! }))
        .filter(message => message.content && now - Date.parse(message.time) < IDIOMS_WINDOW_DAYS * DAY && Date.parse(message.time) <= now && !detectCrisis(message.content));
}

/**
 * 把模型的回复解析成口头习惯，并硬校验：短语要在他的话里原样出现至少 IDIOM_MIN_OCCURRENCES 条不同的消息、分布在至少 IDIOM_MIN_DAYS 个不同的日子；
 * 1–6 个字；不是太泛的、不带数字、不带人名（blocked：联系人和角色的名字）、不带脏话 / 危机相关的词 / 卡上的禁用词
 */
export function parseIdioms(reply: string, his: readonly { content: string; time: string }[], blocked: readonly string[] = []): Idiom[] {
    const match = /\[[\s\S]*\]/.exec(reply);
    if (!match) return [];
    let raw: unknown;
    try { raw = JSON.parse(match[0]); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const out: Idiom[] = [];
    for (const item of raw) {
        const o = item as Record<string, unknown> | null;
        const phrase = typeof o?.['说法'] === 'string' ? o['说法'].trim() : '';
        const kind = typeof o?.['类型'] === 'string' ? o['类型'].trim().slice(0, 8) : '口头禅';
        const length = [...phrase].length;
        if (length < IDIOM_MIN_CHARS || length > IDIOM_MAX_CHARS || GENERIC.has(phrase)) continue;
        if (/\d/.test(phrase) || /[\s@#/\\:：]/.test(phrase) || VULGAR.test(phrase) || detectCrisis(phrase)) continue;
        if (blocked.some(word => word && (phrase.includes(word) || word.includes(phrase)))) continue;
        const hits = his.filter(message => message.content.includes(phrase));
        const days = new Set(hits.map(message => localDay(message.time))).size;
        if (hits.length < IDIOM_MIN_OCCURRENCES || days < IDIOM_MIN_DAYS) continue;
        if (out.some(idiom => idiom.phrase === phrase)) continue;
        out.push({ phrase, kind: kind || '口头禅', count: hits.length, days });
        if (out.length >= IDIOMS_KEPT) break;
    }
    return out;
}

export interface IdiomStoreOptions {
    dir: string;
    log: (message: string) => void;
}
export interface IdiomStore {
    load(qq: number): IdiomState;
    save(qq: number, state: IdiomState): void;
}

export function idiomStore(options: IdiomStoreOptions): IdiomStore {
    const file = (qq: number) => join(options.dir, `${qq}.json`);
    return {
        load(qq) {
            const path = file(qq);
            if (!existsSync(path)) return { version: 1, items: [] };
            try {
                const value = JSON.parse(readFileSync(path, 'utf8')) as IdiomState;
                if (value?.version !== 1 || !Array.isArray(value.items)) throw new Error('结构不对');
                return { ...value, items: value.items.filter(i => typeof i?.phrase === 'string' && typeof i.kind === 'string') };
            } catch (error) {
                options.log(`口头习惯：${qq} 的文件读不了（${error instanceof Error ? error.message : String(error)}），当作没有；原文件不动`);
                return { version: 1, items: [] };
            }
        },
        save(qq, state) {
            mkdirSync(options.dir, { recursive: true });
            const tmp = `${file(qq)}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            renameSync(tmp, file(qq));
        },
    };
}

export interface RefreshIdiomsOptions {
    qq: number;
    userName: string;
    charName: string;
    history: readonly Said[];
    store: IdiomStore;
    /** 不收进去的词：联系人和角色的名字、卡上的禁用词 */
    blocked: readonly string[];
    /** 调模型：返回原文 */
    extract: (messages: { role: 'user'; content: string }[]) => Promise<string>;
    now: number;
    log: (message: string) => void;
}

/** 该不该学、学一次；返回是否真的调了模型 */
export async function refreshIdioms(options: RefreshIdiomsOptions): Promise<boolean> {
    const { qq, store, now } = options;
    const state = store.load(qq);
    const his = hisMessages(options.history, now);
    if (his.length < IDIOMS_MIN_MESSAGES) return false;
    if (state.updatedAt && now - Date.parse(state.updatedAt) < IDIOMS_REFRESH_MS) return false;
    if (state.messageCount !== undefined && his.length - state.messageCount < IDIOMS_MIN_NEW) return false;
    const lines = his.slice(-300).map(message => message.content.replace(/\s+/g, ' ').slice(0, 60)).join('\n');
    const reply = await options.extract([{ role: 'user', content: idiomsPrompt(options.userName, options.charName, lines) }]);
    const fresh = parseIdioms(reply, his, options.blocked);
    // 旧的还成立（窗口里仍然够次数 / 够日子）的留着并更新次数，新的接在后面
    const stillThere = state.items.flatMap(old => {
        const again = parseIdioms(JSON.stringify([{ 说法: old.phrase, 类型: old.kind }]), his, options.blocked)[0];
        return again ? [again] : [];
    });
    const items = [...stillThere, ...fresh.filter(idiom => !stillThere.some(old => old.phrase === idiom.phrase))].slice(0, IDIOMS_KEPT);
    store.save(qq, { version: 1, items, updatedAt: new Date(now).toISOString(), messageCount: his.length });
    options.log(`口头习惯：学了一次，现在有 ${items.length} 个（新增 ${items.length - stillThere.length}；日志不记内容）`);
    return true;
}

/**
 * 这一轮要不要给她看他的口头习惯：约 IDIOM_TURN_SHARE 的轮次（按他最后一句和时间取哈希，同一句每次一样；share 可调，测试和模拟器用）；
 * 挑他最近 IDIOM_FRESH_DAYS 天还在说、她自己最近 IDIOM_COOLDOWN_REPLIES 次回复里没用过的，最多 IDIOM_SHOWN 个；没有就 undefined
 */
export function idiomLine(items: readonly Idiom[], history: readonly Said[], now: number, share = IDIOM_TURN_SHARE): string | undefined {
    if (!items.length) return undefined;
    const lastUser = history.findLast(message => message.role === 'user');
    if (!lastUser || pick(`${lastUser.time ?? ''} ${lastUser.content}`, 'idiom', [0, 999]) >= share * 1000) return undefined;
    const recentReplies = history.filter(message => message.role === 'assistant').slice(-IDIOM_COOLDOWN_REPLIES).map(message => message.content);
    const fresh = (idiom: Idiom) => history.some(message => message.role === 'user' && message.time !== undefined
        && now - Date.parse(message.time) < IDIOM_FRESH_DAYS * DAY && Date.parse(message.time) <= now && ownWords(message.content).includes(idiom.phrase));
    const usable = items.filter(idiom => fresh(idiom) && !recentReplies.some(reply => reply.includes(idiom.phrase)));
    if (!usable.length) return undefined;
    const start = pick(`${lastUser.time ?? ''} ${lastUser.content}`, 'idiom-which', [0, usable.length - 1]);
    const shown = [...usable.slice(start), ...usable.slice(0, start)].slice(0, IDIOM_SHOWN);
    return `[他平时爱说${shown.map(idiom => `「${idiom.phrase}」`).join('')}（他的口头习惯，处久了你也有点被他带着）：这一轮你想说的话里正好用得上，就顺口用一个；用不上就别用，别原样学他刚说的那句，别提这件事，也别每句都带]`;
}
