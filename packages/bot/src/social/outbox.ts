// 她自己想让他知道的事（ADR 0174）：常驻的她用 outbox_send 往 OUTBOX.jsonl 里写一句，这里把它发出去。
//
// 这条路原来是直通的：每 30 秒把文件里每一行直接发到他的 QQ，不看危机后 48 小时的暂停（ADR 0068，红线第 4 条）、不看她睡没睡、不过出口检查、
// 不限条数，发出去的话也不进聊天记录（她下一轮不知道自己说过），读完就清空文件（发不出去的行就丢了）。
// 现在：和别的主动消息一样守同一套规矩——
//   · 危机暂停 / 睡了 / 休眠：整个文件原样留着，等能说话了再发（不丢）；
//   · 每天最多 DAILY_MAX 条，两条之间至少隔 MIN_GAP_MS；一次只发一条；
//   · 出口检查里「硬」的那几类（做不到的承诺、禁用词、照抄的语音图片写法、编的对话）命中就不发、记日志；
//   · 超过 MAX_AGE_MS 的不发（「刚看了个视频」隔一天就不是刚看了）；发不出去重试，MAX_TRIES 次后丢；
//   · 发出去的话记进聊天记录（role=assistant），她下一轮知道自己说过。
// 读文件的办法：先改名成 .work 再处理，常驻进程这时再写会新建一个 OUTBOX.jsonl，两边不会互相覆盖。

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export const OUTBOX_DAILY_MAX = 3;
export const OUTBOX_MIN_GAP_MS = 20 * 60_000;
export const OUTBOX_MAX_AGE_MS = 12 * 3_600_000;
export const OUTBOX_MAX_TRIES = 3;

interface Line { text: string; at: number; tries?: number }
interface State { day: string; sent: number; lastSentAt: number }

export interface OutboxDeps {
    file: string;
    stateFile: string;
    now: () => number;
    /** 现在不能主动找他的原因（危机暂停 / 睡了 / 休眠）；undefined = 可以 */
    blocked: (now: number) => string | undefined;
    /** 出口检查：命中就返回说明，通过返回 undefined */
    inspect: (text: string) => string | undefined;
    send: (text: string) => Promise<number>;
    /** 发出去之后记进聊天记录 */
    record: (text: string, messageId: number, at: number) => void;
    log: (message: string) => void;
    dailyMax?: number;
    minGapMs?: number;
    maxAgeMs?: number;
    maxTries?: number;
}

export interface OutboxResult {
    sent: number;
    /** 还留在文件里等着的行数 */
    held: number;
    dropped: number;
    /** 整个暂停了的原因 */
    blockedBy?: string;
}

function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parse(raw: string): { lines: Line[]; bad: number } {
    const lines: Line[] = [];
    let bad = 0;
    for (const row of raw.split('\n').map(item => item.trim()).filter(Boolean)) {
        try {
            const value = JSON.parse(row) as { text?: unknown; at?: unknown; tries?: unknown };
            const text = typeof value.text === 'string' ? value.text.trim() : '';
            if (!text) { bad++; continue; }
            lines.push({ text, at: Number(value.at) || 0, ...(Number(value.tries) > 0 ? { tries: Number(value.tries) } : {}) });
        } catch { bad++; }
    }
    return { lines, bad };
}

const serialize = (lines: readonly Line[]): string => lines.map(line => `${JSON.stringify(line)}\n`).join('');

export async function drainOutbox(deps: OutboxDeps): Promise<OutboxResult> {
    const now = deps.now();
    const work = `${deps.file}.work`;
    const dailyMax = deps.dailyMax ?? OUTBOX_DAILY_MAX;
    const minGap = deps.minGapMs ?? OUTBOX_MIN_GAP_MS;
    const maxAge = deps.maxAgeMs ?? OUTBOX_MAX_AGE_MS;
    const maxTries = deps.maxTries ?? OUTBOX_MAX_TRIES;

    const hasWork = existsSync(work);
    if (!existsSync(deps.file) && !hasWork) return { sent: 0, held: 0, dropped: 0 };
    const blockedBy = deps.blocked(now);
    if (blockedBy) return { sent: 0, held: 0, dropped: 0, blockedBy };

    // 上次中途崩了留下的 .work 和新写的合在一起
    let raw = hasWork ? readFileSync(work, 'utf8') : '';
    if (existsSync(deps.file)) {
        renameSync(deps.file, `${deps.file}.next`);
        raw += readFileSync(`${deps.file}.next`, 'utf8');
        rmSync(`${deps.file}.next`, { force: true });
    }
    const { lines, bad } = parse(raw);
    let dropped = bad;
    if (bad) deps.log(`主动留话：${bad} 行读不懂，丢掉`);

    const state = readJsonOr<Partial<State>>(deps.stateFile, {});
    const today = localDay(now);
    const day: State = state.day === today ? { day: today, sent: state.sent ?? 0, lastSentAt: state.lastSentAt ?? 0 } : { day: today, sent: 0, lastSentAt: state.lastSentAt ?? 0 };

    const rest: Line[] = [];
    let sent = 0;
    for (const [index, line] of lines.entries()) {
        if (now - line.at > maxAge) { dropped++; deps.log(`主动留话：「${line.text.slice(0, 20)}」过期了，不发`); continue; }
        const problem = deps.inspect(line.text);
        if (problem) { dropped++; deps.log(`主动留话：「${line.text.slice(0, 20)}」没过出口检查（${problem}），不发`); continue; }
        if (sent > 0 || day.sent >= dailyMax || now - day.lastSentAt < minGap) { rest.push(line); continue; }
        try {
            const messageId = await deps.send(line.text);
            deps.record(line.text, messageId, now);
            day.sent++;
            day.lastSentAt = now;
            sent++;
        } catch (error) {
            const tries = (line.tries ?? 0) + 1;
            deps.log(`主动留话发不出去（第 ${tries} 次）：${error instanceof Error ? error.message : String(error)}`);
            if (tries >= maxTries) dropped++;
            else rest.push({ ...line, tries });
            rest.push(...lines.slice(index + 1));
            break;
        }
    }

    if (rest.length) appendFileSync(deps.file, serialize(rest));
    rmSync(work, { force: true });
    if (sent) writeJsonAtomic(deps.stateFile, day);
    return { sent, held: rest.length, dropped };
}
