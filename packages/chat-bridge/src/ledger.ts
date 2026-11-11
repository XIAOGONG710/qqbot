// 消息账：log.jsonl，只追加。消息和事件共用一条单调递增的 seq。
// 一行一条：{"m": Message} 或 {"e": {seq, at, event}}。撤回是一条事件，不回头改旧行；重读时再把 recalled 标回内存里的消息。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from './types.ts';
import type { LedgerEvent, Message, Part } from './types.ts';

export interface LedgerStorage {
    /** 整个文件；没有返回 undefined */
    read(): string | undefined;
    append(text: string): void;
}

export interface EventEntry {
    seq: number;
    at: number;
    event: LedgerEvent;
}

export type Entry = { message: Message } | { event: EventEntry };

export interface Ledger {
    /** 最新的 seq；空账是 0 */
    readonly seq: number;
    appendMessage(message: Omit<Message, 'seq' | 'recalled'>): Message;
    /** 撤回事件同时把那条消息标成 recalled */
    appendEvent(event: LedgerEvent, at: number): EventEntry;
    byId(id: number): Message | undefined;
    byClientId(clientId: string): Message | undefined;
    /** seq 大于 since 的，按 seq 升序；多于 limit 时只给最新的 limit 条 */
    after(since: number, limit: number): Entry[];
    /** seq 小于 before 的最新 limit 条消息（升序），以及落在这段 seq 范围内的事件 */
    before(before: number, limit: number): { messages: Message[]; events: EventEntry[] };
    /** 最新的 count 条消息（升序）；endId 给了就到那条为止（含） */
    recentMessages(count: number, endId?: number): Message[];
    lastFromMe(): Message | undefined;
    /** 最近一条已读事件读到的消息 id */
    lastReadUpTo(): number | undefined;
    /** 账里出现过的最大消息 id（不小于 floor 的那些里），没有返回 undefined */
    maxIdAtLeast(floor: number): number | undefined;
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function validPart(value: unknown): value is Part {
    if (!isRecord(value)) return false;
    switch (value.kind) {
        case 'text': return typeof value.text === 'string';
        case 'face': return isInt(value.id);
        case 'image': case 'voice': return typeof value.mediaId === 'string' && typeof value.mime === 'string';
        case 'card': return typeof value.title === 'string';
        case 'poke': return true;
        default: return false;
    }
}

function validMessage(value: unknown): value is Message {
    return isRecord(value) && isInt(value.seq) && value.seq > 0 && isInt(value.id)
        && (value.from === 'her' || value.from === 'me') && (value.via === 'app' || value.via === 'qq')
        && typeof value.at === 'number' && Number.isFinite(value.at)
        && Array.isArray(value.parts) && value.parts.every(validPart)
        && (value.replyTo === undefined || isInt(value.replyTo))
        && (value.clientId === undefined || typeof value.clientId === 'string');
}

function validEvent(value: unknown): value is EventEntry {
    if (!isRecord(value) || !isInt(value.seq) || value.seq <= 0 || typeof value.at !== 'number' || !isRecord(value.event)) return false;
    const event = value.event;
    switch (event.kind) {
        case 'recall': return isInt(event.id);
        case 'read': return isInt(event.upTo);
        case 'reaction': return isInt(event.id) && isInt(event.emojiId);
        default: return false;
    }
}

const seqOf = (entry: Entry): number => 'message' in entry ? entry.message.seq : entry.event.seq;

export function createLedger(storage: LedgerStorage): Ledger {
    const entries: Entry[] = [];
    const byId = new Map<number, Message>();
    const byClientId = new Map<string, Message>();
    let seq = 0;
    let lastFromMe: Message | undefined;
    let lastRead: number | undefined;

    const remember = (entry: Entry) => {
        entries.push(entry);
        seq = seqOf(entry);
        if ('message' in entry) {
            const message = entry.message;
            byId.set(message.id, message);
            if (message.clientId !== undefined) byClientId.set(message.clientId, message);
            if (message.from === 'me') lastFromMe = message;
        } else if (entry.event.event.kind === 'recall') {
            const target = byId.get(entry.event.event.id);
            if (target) target.recalled = true;
        } else if (entry.event.event.kind === 'read') {
            lastRead = entry.event.event.upTo;
        }
    };

    const text = storage.read() ?? '';
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        // 最后一行可能只写了一半（断电、进程被杀）；中间的坏行同样跳过，不让一行坏数据挡住整本账
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!isRecord(parsed)) continue;
        if (validMessage(parsed.m) && parsed.m.seq > seq) {
            const { recalled: _ignored, ...message } = parsed.m;
            remember({ message });
        } else if (validEvent(parsed.e) && parsed.e.seq > seq) {
            remember({ event: { seq: parsed.e.seq, at: parsed.e.at, event: parsed.e.event } });
        }
    }
    // 半行后面直接追加会把下一条也粘坏：先补一个换行
    if (text && !text.endsWith('\n')) storage.append('\n');

    /** 第一条 seq 大于 since 的下标 */
    const indexAfter = (since: number): number => {
        let low = 0;
        let high = entries.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (seqOf(entries[middle]!) > since) high = middle;
            else low = middle + 1;
        }
        return low;
    };

    return {
        get seq() { return seq; },
        appendMessage(input) {
            const message: Message = { ...input, seq: seq + 1 };
            storage.append(`${JSON.stringify({ m: message })}\n`);
            remember({ message });
            return message;
        },
        appendEvent(event, at) {
            const entry: EventEntry = { seq: seq + 1, at, event };
            storage.append(`${JSON.stringify({ e: entry })}\n`);
            remember({ event: entry });
            return entry;
        },
        byId: id => byId.get(id),
        byClientId: clientId => byClientId.get(clientId),
        after(since, limit) {
            const start = Math.max(indexAfter(since), entries.length - limit);
            return entries.slice(start);
        },
        before(before, limit) {
            const end = indexAfter(before - 1);
            const messages: Message[] = [];
            let start = end;
            while (start > 0 && messages.length < limit) {
                start--;
                const entry = entries[start]!;
                if ('message' in entry) messages.unshift(entry.message);
            }
            // 没翻到头就从最旧的那条消息起算；翻到头了把它前面的事件也带上
            const events: EventEntry[] = [];
            for (let index = start; index < end; index++) {
                const entry = entries[index]!;
                if ('event' in entry) events.push(entry.event);
            }
            return { messages, events };
        },
        recentMessages(count, endId) {
            const result: Message[] = [];
            let index = entries.length;
            if (endId !== undefined) {
                const target = byId.get(endId);
                if (target) index = indexAfter(target.seq);
            }
            while (index > 0 && result.length < count) {
                index--;
                const entry = entries[index]!;
                if ('message' in entry) result.unshift(entry.message);
            }
            return result;
        },
        lastFromMe: () => lastFromMe,
        lastReadUpTo: () => lastRead,
        maxIdAtLeast(floor) {
            let max: number | undefined;
            for (const id of byId.keys()) if (id >= floor && (max === undefined || id > max)) max = id;
            return max;
        },
    };
}

export function fileLedgerStorage(path: string): LedgerStorage {
    mkdirSync(dirname(path), { recursive: true });
    return {
        read() {
            try { return readFileSync(path, 'utf8'); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
            }
        },
        append(text) { appendFileSync(path, text, { mode: 0o600 }); },
    };
}

export function memoryLedgerStorage(initial?: string): LedgerStorage & { text(): string } {
    let text = initial;
    return {
        read: () => text,
        append(chunk) { text = (text ?? '') + chunk; },
        text: () => text ?? '',
    };
}
