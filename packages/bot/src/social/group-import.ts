// 把群里以前的聊天导进来（2026-11-14：她进群之前的那段，得让她「看过」，不然一开口就露馅）。
//
// 只做两件事：解析成 GroupEntry（history: true，标成「进来之前的」），写进 groups/<群号>.jsonl；
// 再按人记进成员底账（聊过几句、最近说了什么），这样她认识群里的人。
// 不动的话题额度、不触发回话——这些是过去的记录，不是刚到的消息。
//
// 认得的格式（一份文件里可以混着用）：
//   1) JSONL：{"time":"2026-11-01T20:13:00+08:00","from":123456,"name":"老王","content":"在吗"}（mine 可选）
//   2) 一行一条：[2026-11-01 20:13] 老王: 在吗   /   2026-11-01 20:13 老王：在吗
//   3) 只有人：老王：在吗
//   4) QQ 导出的两行一条：2026-11-01 20:13:02 老王(123456) 换行 内容

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GroupEntry } from './group-chat.ts';
import { groupPeople } from './group-people.ts';

export interface ImportedLine {
    time?: string;
    from?: number;
    name: string;
    content: string;
    mine?: true;
}

const CLOCK = /^\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*/;
const HEADER = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+?)\((\d{5,12})\)\s*$/;
const SPEAKER = /^([^\s:：]{1,16})\s*[:：]\s*(.*)$/;

/** 「2026-11-01 20:13」按北京时间解析（群里的人都在 +08:00） */
function beijingTime(year: number, month: number, day: number, hour: number, minute: number, second = 0): string | undefined {
    const stamp = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
    return Number.isFinite(stamp.getTime()) ? stamp.toISOString() : undefined;
}

export function parseGroupHistory(text: string): ImportedLine[] {
    const lines = text.replace(/\r/g, '').split('\n');
    const out: ImportedLine[] = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!.trim();
        if (!raw) continue;
        // 1) JSONL
        if (raw.startsWith('{')) {
            try {
                const item = JSON.parse(raw) as Record<string, unknown>;
                if (typeof item.content === 'string' && item.content.trim()) {
                    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '群友';
                    out.push({
                        ...(typeof item.time === 'string' ? { time: item.time } : {}),
                        ...(Number.isSafeInteger(item.from) ? { from: Number(item.from) } : {}),
                        name, content: item.content.trim(), ...(item.mine === true ? { mine: true as const } : {}),
                    });
                }
            } catch { /* 不是 JSON 就按下面的格式再试 */ }
            continue;
        }
        // 4) QQ 导出的两行一条：头一行是时间 + 昵称(QQ)，接下来的行是内容
        const head = HEADER.exec(raw);
        if (head) {
            const time = beijingTime(+head[1]!, +head[2]!, +head[3]!, +head[4]!, +head[5]!, head[6] ? +head[6] : 0);
            const name = head[7]!.trim();
            const from = Number(head[8]);
            const body: string[] = [];
            while (i + 1 < lines.length && lines[i + 1]!.trim() && !HEADER.test(lines[i + 1]!.trim()) && !CLOCK.test(lines[i + 1]!.trim())) {
                body.push(lines[i + 1]!.trim());
                i++;
            }
            const content = body.join(' ').trim();
            if (content) out.push({ ...(time ? { time } : {}), from, name, content });
            continue;
        }
        // 2) / 3) 一行一条：可选时间 + 「谁：说了什么」
        const clock = CLOCK.exec(raw);
        const rest = clock ? raw.slice(clock[0].length) : raw;
        const said = SPEAKER.exec(rest);
        if (!said) continue;
        const name = said[1]!.trim();
        const content = said[2]!.trim().replace(/^\[图片\]$/, '[图片]');
        if (!content) continue;
        const time = clock ? beijingTime(+clock[1]!, +clock[2]!, +clock[3]!, +clock[4]!, +clock[5]!, clock[6] ? +clock[6] : 0) : undefined;
        out.push({ ...(time ? { time } : {}), name, content });
    }
    return out;
}

/** 文本格式里没有 QQ 号：按名字造一个稳定的假号（负数，和真人号不会撞），同一个名字每次一样 */
export function pseudoQq(name: string): number {
    let hash = 0x811c9dc5;
    for (const char of name) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return -(1 + (hash % 900_000_000));
}

export function fillTimes(lines: readonly ImportedLine[], end: number, gapMs = 3 * 60_000): ImportedLine[] {
    const unknown = lines.filter(line => !line.time).length;
    let seen = 0;
    return lines.map(line => {
        if (line.time) return line;
        // 第 k 条没时间的：离现在 (unknown - k) 个间隔，最后一条离现在一个间隔
        const offset = (unknown - seen) * gapMs;
        seen++;
        return { ...line, time: new Date(end - offset).toISOString() };
    });
}

export interface ImportOptions {
    groupId: number;
    lines: readonly ImportedLine[];
    dataDir: string;
    /** 她自己在这个群的 QQ 号（导进来的记录里她说过的话标成 mine） */
    selfQq?: number;
    /** 她自己在这个群被叫的名字（用来认出「我」说过的话） */
    selfName?: string;
    now?: number;
}

/** 写进群记录和成员底账；返回导进去几条、认出来几个人 */
export function importGroupHistory(options: ImportOptions): { added: number; people: number; first?: string; last?: string } {
    const now = options.now ?? Date.now();
    const lines = fillTimes(options.lines, now);
    const dir = join(options.dataDir, 'groups');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${options.groupId}.jsonl`);
    // 一条一条给稳定的负数 id：真实的群消息 id 都是正数，不会撞
    let next = -1_000_000_000;
    const existing: GroupEntry[] = existsSync(file)
        ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as GroupEntry]; } catch { return []; } })
        : [];
    const known = new Set(existing.map(entry => entry.messageId));
    const people = groupPeople(options.dataDir);
    const added: GroupEntry[] = [];
    for (const line of lines) {
        const mine = line.mine === true || (options.selfQq !== undefined && line.from === options.selfQq) || (options.selfName !== undefined && line.name === options.selfName);
        let messageId = next--;
        while (known.has(messageId)) messageId = next--;
        known.add(messageId);
        const entry: GroupEntry = {
            time: line.time ?? new Date(now).toISOString(),
            // 文本格式没有 QQ 号：按名字造一个稳定的假号，别让好几个人并成「同一个人」
            from: mine ? (options.selfQq ?? 0) : (line.from && line.from > 0 ? line.from : pseudoQq(line.name)),
            name: line.name,
            content: line.content,
            messageId,
            ...(mine ? { mine: true as const } : {}),
            history: true,
        };
        added.push(entry);
    }
    if (added.length) {
        const temp = `${file}.tmp`;
        writeFileSync(temp, [...existing, ...added].map(entry => `${JSON.stringify(entry)}\n`).join(''));
        renameSync(temp, file);
        for (const entry of added) {
            if (entry.mine) continue;
            people.note(options.groupId, { qq: entry.from, name: entry.name, content: entry.content, at: entry.time });
        }
    }
    return {
        added: added.length,
        people: new Set(added.filter(entry => !entry.mine).map(entry => entry.from)).size,
        ...(added[0] ? { first: added[0].time } : {}),
        ...(added.length ? { last: added[added.length - 1]!.time } : {}),
    };
}

/** 她在这个群有没有「以前的记录」（有就不算刚进群） */
export function hasHistory(dataDir: string, groupId: number): boolean {
    const file = join(dataDir, 'groups', `${groupId}.jsonl`);
    if (!existsSync(file)) return false;
    return readFileSync(file, 'utf8').split('\n').some(line => {
        try { return (JSON.parse(line) as GroupEntry).history === true; } catch { return false; }
    });
}
