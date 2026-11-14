// 群里的人，她得认得（用户 2026-11-14：「不要出现以前聊过的人，再见就不认识的情况，要有基础的认知」）。
//
// 只记她自己在群里看得到的东西：用过哪些群名片、说过多少句、第一次和最后一次是什么时候、
// 最近说过的几句原话。不猜性格、不写印象、不跨群共享——群里的话就留在群里（ADR 0210 那条隐私）。
// 纯统计，不调模型；<数据目录>/groups/<群号>.people.json，一个群一份。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 每个群最多记多少人（记满就不再增，只更新老面孔） */
export const GROUP_PEOPLE_MAX = 60;
/** 每个人记几句原话（提示词里够她「想得起来」就行） */
export const GROUP_PEOPLE_LINES = 3;
/** 每句原话最多几个字 */
export const GROUP_PEOPLE_SAID_CHARS = 40;
/** 提示词里最多列几个人 */
export const GROUP_PEOPLE_RENDER = 6;
/** 一个人用过几个名字（改名还认得） */
const NAMES_KEPT = 3;

export interface GroupPerson {
    qq: number;
    /** 用过的群名片 / 昵称，最新的在前 */
    names: string[];
    /** 在这个群说过多少句 */
    msgs: number;
    firstAt: string;
    lastAt: string;
    /** 最近说过的几句（旧的在前） */
    said: string[];
}

export interface GroupPeople {
    load(groupId: number): GroupPerson[];
    /** 群里来了一条：认人、记数、留一句原话 */
    note(groupId: number, entry: { qq: number; name: string; content: string; at: string }): void;
    /** 给她的说明：这个群里她认识谁（认识 = 聊过；第一次见的直接说第一次见） */
    render(groupId: number, options?: { exclude?: number; now?: number; max?: number }): string | undefined;
}

const clip = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim();
    const chars = [...flat];
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
};

/** 「3 天前」这种人话；刚说过就是刚才 */
export function whenText(at: string, now: number): string {
    const time = Date.parse(at);
    if (!Number.isFinite(time)) return '之前';
    const gap = Math.max(0, now - time);
    const minutes = Math.floor(gap / 60_000);
    if (minutes < 2) return '刚才';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
}

export function groupPeople(dataDir: string): GroupPeople {
    const dir = join(dataDir, 'groups');
    const file = (groupId: number) => join(dir, `${groupId}.people.json`);
    const cache = new Map<number, GroupPerson[]>();

    const load = (groupId: number): GroupPerson[] => {
        const hit = cache.get(groupId);
        if (hit) return hit;
        const path = file(groupId);
        let list: GroupPerson[] = [];
        if (existsSync(path)) {
            try {
                const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
                if (Array.isArray(parsed)) {
                    list = parsed.filter((item): item is GroupPerson => Boolean(item) && typeof item === 'object'
                        && Number.isSafeInteger((item as GroupPerson).qq) && Array.isArray((item as GroupPerson).names)
                        && typeof (item as GroupPerson).lastAt === 'string');
                }
            } catch { /* 文件坏了：从空的开始，不挡说话 */ }
        }
        cache.set(groupId, list);
        return list;
    };

    const persist = (groupId: number, list: GroupPerson[]): void => {
        try {
            mkdirSync(dirname(file(groupId)), { recursive: true });
            const temp = `${file(groupId)}.tmp`;
            writeFileSync(temp, JSON.stringify(list));
            renameSync(temp, file(groupId));
        } catch { /* 写不进去只是下次认不出，不挡说话 */ }
    };

    return {
        load,
        note(groupId, entry) {
            if (!Number.isSafeInteger(entry.qq) || entry.qq <= 0) return;
            const list = load(groupId);
            const name = clip(entry.name, 16);
            const line = clip(entry.content, GROUP_PEOPLE_SAID_CHARS);
            const found = list.find(person => person.qq === entry.qq);
            if (!found) {
                list.push({
                    qq: entry.qq, names: name ? [name] : [], msgs: 1,
                    firstAt: entry.at, lastAt: entry.at, said: line ? [line] : [],
                });
                while (list.length > GROUP_PEOPLE_MAX) {
                    // 记满了先丢最久没说话的
                    const oldest = list.reduce((a, b) => (Date.parse(a.lastAt) <= Date.parse(b.lastAt) ? a : b));
                    list.splice(list.indexOf(oldest), 1);
                }
                persist(groupId, list);
                return;
            }
            found.msgs += 1;
            found.lastAt = entry.at;
            if (name && found.names[0] !== name) found.names = [name, ...found.names.filter(old => old !== name)].slice(0, NAMES_KEPT);
            if (line) {
                found.said.push(line);
                if (found.said.length > GROUP_PEOPLE_LINES) found.said.splice(0, found.said.length - GROUP_PEOPLE_LINES);
            }
            persist(groupId, list);
        },
        render(groupId, options = {}) {
            const now = options.now ?? Date.now();
            const max = options.max ?? GROUP_PEOPLE_RENDER;
            const list = load(groupId).filter(person => person.qq !== options.exclude && person.msgs > 0);
            if (!list.length) return undefined;
            const lines = list
                .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
                .slice(0, max)
                .map(person => {
                    const name = person.names[0] ?? '群友';
                    const aliases = person.names.slice(1);
                    const who = aliases.length ? `${name}（也叫${aliases.map(alias => `「${alias}」`).join('、')}）` : name;
                    if (person.msgs <= 1) return `${who}：今天第一次见`;
                    const said = person.said.length ? `；说过${person.said.map(line => `「${line}」`).join('')}` : '';
                    return `${who}：聊过 ${person.msgs} 句，最后一次是${whenText(person.lastAt, now)}${said}`;
                });
            return `[你在这个群认识的人（聊过就是认识，别问人家「你是谁」）：\n${lines.join('\n')}]`;
        },
    };
}
