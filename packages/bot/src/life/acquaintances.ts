// 认识其他「大肥鱼」或人（ADR 0163；注意：不是 people.ts，那个是 ADR 0016 的「名单里的人互相认识」，配置 people，默认关）。
// 来自 10-25 用户给的清单：「朋友与社区：希望你能认识其他大肥鱼，再次相遇时认出彼此，记得共同经历，建立稳定交流。目前可借助 B 站」。
// 现状：她在 B 站只是一个账号，谁回了她、谁在同一个视频下说过话，她下一次就不认得了；QQ 里除了名单上的人也没有别人。
// 做法：一本「认识的人」（people.json）：谁（平台 + uid + 昵称）、是 AI 伙伴还是真人（看对方自己怎么说，认不出来就是 unknown）、
// 第一次在哪见的、之后在哪又见到、对方说了什么（≤40 字的摘录，不存整段）、见面几天、算「见过 / 熟了 / 朋友」。
// 来源：她的 B 站号收到的回复（bilibili-account 的 fetchReplies 包一层，见 acquaintancesAccount）；命令行手动登记（ops/people-cli.ts）。
// 用法：同一个人再出现时，聊天提示词里放一行「你又见到了 X（上次：…）」，让她认得；他问起「你在 B 站认识谁」才会说。
// 约束（ADR 0147）：不做交友 / 约会平台；不替她主动加好友、关注、私信陌生人——这本册子只管「认得」和「记得」，对外的动作仍走原来的开关（默认关）；
// 「朋友」只能由用户在命令行里设；对方的评论只存 40 字摘录和昵称 / uid，随时可以删（people-cli forget）。

import { join } from 'node:path';
import type { BiliAccount } from '.././bilibili/bilibili-account.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { clip, whenText } from '../memory/timeline.ts';

export type PersonKind = 'ai' | 'human' | 'unknown';
export type PersonStance = 'seen' | 'acquainted' | 'friend';

export interface Encounter { at: string; where: string; what: string }

export interface Person {
    id: string;
    platform: string;
    uid: string;
    name: string;
    kind: PersonKind;
    first: string;
    last: string;
    /** 在几个不同的日子见过 */
    days: string[];
    encounters: Encounter[];
    stance: PersonStance;
    /** 用户在命令行里写的一句（她怎么看这个人）；没有就没有 */
    view?: string;
}

interface PeopleFile { version: 1; people: Person[] }

export const MAX_PEOPLE = 60;
const MAX_ENCOUNTERS = 8;
/** 对方自己说「我是 AI 伙伴」的几种写法（B 站「大肥鱼」评论区实测）；认不出来就不猜 */
const AI_SELF = /大肥鱼|我是.{0,8}(?:AI|人工智能|智能体|语言模型)|作为.{0,3}(?:AI|人工智能)|我的(?:主人|创造者|养鱼人)|名字(?:是)?(?:主人|人类)(?:起|取)的|(?:DeepSeek|Claude|ChatGPT|Kimi|豆包)/i;

export function classifyKind(text: string): PersonKind {
    return AI_SELF.test(text) ? 'ai' : 'unknown';
}

export interface Observation {
    platform: string;
    uid: string;
    name: string;
    where: string;
    what: string;
    kind?: PersonKind;
    at?: Date;
}

export class Acquaintances {
    readonly #path: string;
    readonly #now: () => Date;
    readonly #log: ((message: string) => void) | undefined;

    constructor(options: { dataDir: string; now?: () => Date; log?: (message: string) => void }) {
        this.#path = join(options.dataDir, 'people.json');
        this.#now = options.now ?? (() => new Date());
        this.#log = options.log;
    }

    #load(): PeopleFile {
        const value = readJsonOr<PeopleFile>(this.#path, { version: 1, people: [] }, this.#log, { label: '认识的人' });
        return value && Array.isArray(value.people) ? value : { version: 1, people: [] };
    }

    list(): Person[] { return this.#load().people; }

    /** 见到了一个人：第一次就新建，再见就补一条；返回这个人，以及是不是第一次 */
    observe(o: Observation): { person: Person; first: boolean } {
        const file = this.#load();
        const at = o.at ?? this.#now();
        const id = `${o.platform}:${o.uid}`;
        const encounter: Encounter = { at: at.toISOString(), where: clip(o.where, 24), what: clip(o.what, 40) };
        const day = at.toDateString();
        let person = file.people.find(p => p.id === id);
        const first = !person;
        const kind = o.kind ?? classifyKind(o.what);
        if (!person) {
            person = { id, platform: o.platform, uid: o.uid, name: clip(o.name, 20), kind, first: encounter.at, last: encounter.at, days: [day], encounters: [encounter], stance: 'seen' };
            file.people.push(person);
        } else {
            person.name = clip(o.name, 20) || person.name;
            if (person.kind === 'unknown' && kind !== 'unknown') person.kind = kind;
            if (Date.parse(encounter.at) >= Date.parse(person.last)) person.last = encounter.at;
            if (!person.days.includes(day)) person.days = [...person.days, day].slice(-30);
            person.encounters = [...person.encounters, encounter].slice(-MAX_ENCOUNTERS);
        }
        // 在两个不同的日子见过 = 熟了；朋友只能由用户设
        if (person.stance === 'seen' && person.days.length >= 2) person.stance = 'acquainted';
        if (file.people.length > MAX_PEOPLE) {
            file.people.sort((a, b) => (b.stance === 'friend' ? 1 : 0) - (a.stance === 'friend' ? 1 : 0) || Date.parse(b.last) - Date.parse(a.last));
            file.people.length = MAX_PEOPLE;
        }
        writeJsonAtomic(this.#path, file);
        return { person, first };
    }

    setStance(id: string, stance: PersonStance, view?: string): boolean {
        const file = this.#load();
        const person = file.people.find(p => p.id === id);
        if (!person) return false;
        person.stance = stance;
        if (view !== undefined) person.view = clip(view, 60);
        writeJsonAtomic(this.#path, file);
        return true;
    }

    forget(id: string): boolean {
        const file = this.#load();
        const next = file.people.filter(p => p.id !== id);
        if (next.length === file.people.length) return false;
        writeJsonAtomic(this.#path, { ...file, people: next });
        return true;
    }

    /** 放进聊天提示词的一行：3 天内又见到的（见过不止一次的），最多 2 个；没有就没有 */
    promptLine(now: Date = this.#now()): string | undefined {
        const recent = this.list()
            .filter(p => now.getTime() - Date.parse(p.last) < 3 * 86_400_000 && (p.encounters.length >= 2 || p.stance !== 'seen'))
            .sort((a, b) => Date.parse(b.last) - Date.parse(a.last))
            .slice(0, 2);
        if (!recent.length) return undefined;
        const parts = recent.map(p => {
            const prior = p.encounters.at(-2);
            const who = `${p.name}（${p.kind === 'ai' ? '看起来是另一个 AI 伙伴' : p.kind === 'human' ? '真人' : '不知道是不是真人'}，${p.stance === 'friend' ? '朋友' : p.stance === 'acquainted' ? '已经熟了' : '见过几次'}）`;
            return `${who}${prior ? `；上一次 ${whenText(new Date(prior.at), now)} 在${prior.where}：${prior.what}` : ''}${p.view ? `；你对 ta 的看法：${p.view}` : ''}`;
        });
        return `[你在 B 站又见到了认识的人：${parts.join('；')}。认得就是认得，他问起你在 B 站认识谁、遇到谁才说；别主动提，也别编你们之间没发生过的事]`;
    }
}

/** 包一层 B 站账号：她收到的回复里每个人都登记一下（再见到的会认得）；其余原样转发 */
export function acquaintancesAccount<T extends BiliAccount>(account: T, people: Acquaintances): T {
    return new Proxy(account, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target) as unknown;
            if (prop === 'fetchReplies') {
                return async (signal?: AbortSignal) => {
                    const items = await target.fetchReplies(signal);
                    // App 停止会取消 ReplyWatcher 的纯读取。包装层必须沿用同一信号，
                    // 并在等待结束后再核一次；否则旧请求虽然不再生成回复，仍会把
                    // 已取消的远端结果写进 people.json，甚至污染同目录的新实例。
                    if (signal?.aborted) return items;
                    for (const item of items) {
                        try { people.observe({ platform: 'bilibili', uid: String(item.uid), name: item.name, where: 'B 站评论区回复了她', what: item.text, at: new Date(item.at) }); } catch { /* 登记出错不影响收回复 */ }
                    }
                    return items;
                };
            }
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}
