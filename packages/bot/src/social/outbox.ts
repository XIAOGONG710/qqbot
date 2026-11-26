// 她自己想让他知道的事（ADR 0174）：常驻的她用 outbox_send 往 OUTBOX.jsonl 里写一句，这里把它发出去。
//
// 这条路原来是直通的：每 30 秒把文件里每一行直接发到他的 QQ，不看危机后 48 小时的暂停（ADR 0068，红线第 4 条）、不看她睡没睡、不过出口检查、
// 不限条数，发出去的话也不进聊天记录（她下一轮不知道自己说过），读完就清空文件（发不出去的行就丢了）。
// 现在：和别的主动消息一样守同一套规矩——
//   · 危机暂停 / 睡了 / 休眠：整个文件原样留着，等能说话了再发（不丢）；
//   · 每天最多 DAILY_MAX 条，两条之间至少隔 MIN_GAP_MS；一次只发一条；
//   · 出口检查里「硬」的那几类（做不到的承诺、禁用词、照抄的语音图片写法、编的对话）命中就不发、记日志；
//   · 超过 MAX_AGE_MS 的不发；确认未派出的才自动重试，结果不明的留待核对。
//   · 发出去的话记进聊天记录（role=assistant），她下一轮知道自己说过。
// 先用 .next 接管生产者的文件，再把待发队列和导入进度一并原子写入状态。

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { OneBotNotDispatched } from '../platform/onebot.ts';

export const OUTBOX_DAILY_MAX = 3;
export const OUTBOX_MIN_GAP_MS = 20 * 60_000;
export const OUTBOX_MAX_AGE_MS = 12 * 3_600_000;
export const OUTBOX_MAX_TRIES = 3;

interface Line { text: string; at: number; tries?: number }
type Stage = 'work' | 'next';
interface Attempt { startedAt: number; scope?: string }
interface Receipt extends Attempt { text: string; messageId: number; at: number }
interface State {
    day: string; sent: number; lastSentAt: number; pending: Line[]; imported?: Stage[];
    attempt?: Attempt;
    receipt?: Receipt;
}

export type OutboxReconciliation = { kind: 'delivered'; messageId: number; at: number }
    | { kind: 'not-delivered' } | { kind: 'unknown' };

export interface OutboxDeps {
    file: string;
    stateFile: string;
    now: () => number;
    /** 现在不能主动找他的原因（危机暂停 / 睡了 / 休眠）；undefined = 可以 */
    blocked: (now: number) => string | undefined;
    /** 出口检查：命中就返回说明，通过返回 undefined */
    inspect: (text: string) => string | undefined;
    send: (text: string) => Promise<number>;
    scope?: string;
    reconcile?: (text: string, startedAt: number) => Promise<OutboxReconciliation>;
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

export async function drainOutbox(deps: OutboxDeps): Promise<OutboxResult> {
    const now = deps.now();
    const stagePath = (stage: Stage) => `${deps.file}.${stage}`;
    const dailyMax = deps.dailyMax ?? OUTBOX_DAILY_MAX;
    const minGap = deps.minGapMs ?? OUTBOX_MIN_GAP_MS;
    const maxAge = deps.maxAgeMs ?? OUTBOX_MAX_AGE_MS;
    const maxTries = deps.maxTries ?? OUTBOX_MAX_TRIES;

    const state = readJsonOr<Partial<State>>(deps.stateFile, {}, deps.log, { invalid: 'throw' });
    const stages = (['work', 'next'] as const).filter(stage => existsSync(stagePath(stage)));
    if (!existsSync(deps.file) && !stages.length && !state.pending?.length && !state.attempt && !state.receipt) return { sent: 0, held: 0, dropped: 0 };

    const today = localDay(now);
    const day: State = { day: today, sent: state.day === today ? state.sent ?? 0 : 0,
        lastSentAt: state.lastSentAt ?? 0, pending: state.pending ?? [],
        ...(state.attempt ? { attempt: state.attempt } : {}), ...(state.receipt ? { receipt: state.receipt } : {}) };
    const pendingCheck = (reason: string): OutboxResult => ({ sent: 0, held: day.pending.length, dropped: 0, blockedBy: reason });
    const recordReceipt = () => {
        const receipt = day.receipt!;
        try { deps.record(receipt.text, receipt.messageId, receipt.at); }
        catch { return false; }
        delete day.receipt;
        writeJsonAtomic(deps.stateFile, day);
        return true;
    };
    const settle = (line: Line, messageId: number, at: number) => {
        const attempt = day.attempt!;
        delete day.attempt;
        day.pending = day.pending.slice(1);
        day.lastSentAt = Math.max(day.lastSentAt, at);
        if (localDay(at) === today) day.sent++;
        day.receipt = { ...attempt, text: line.text, messageId, at };
        writeJsonAtomic(deps.stateFile, day);
    };
    // 一直核对不了的，超过 maxAge（这条本来也过期不发了）就放弃这一条、队列继续。
    // 风控拦截、NapCat 回失败、超时都进「待核对」，这些其实没送达、历史里永远核对不到；没有这个出口，之后给他的留话会永久卡住
    // （2026-11-26 claude 审 3ac758b8；旧代码是 MAX_TRIES 次后丢）。最坏是那一条丢一次或重复一次。
    const stale = (since: number) => now - since > maxAge;
    const abandon = (what: string) => deps.log(`主动留话：${what}超过 ${Math.round(maxAge / 3_600_000)} 小时还核对不了，放弃这一条，后面的照常`);
    if (day.receipt) {
        if (day.receipt.scope !== deps.scope || !recordReceipt()) {
            if (!stale(day.receipt.at)) return pendingCheck('已投递，聊天记录待核对');
            abandon('聊天记录');
            delete day.receipt;
            writeJsonAtomic(deps.stateFile, day);
        }
    }
    if (day.attempt) {
        const line = day.pending[0];
        let result: OutboxReconciliation = { kind: 'unknown' };
        if (line && day.attempt.scope === deps.scope && deps.reconcile) {
            try { result = await deps.reconcile(line.text, day.attempt.startedAt); }
            catch { result = { kind: 'unknown' }; }
        }
        if (result.kind === 'delivered' && validMessageId(result.messageId) && Number.isFinite(new Date(result.at).getTime())) {
            settle(line!, result.messageId, result.at);
            if (!recordReceipt()) return pendingCheck('已投递，聊天记录待核对');
        } else if (result.kind === 'not-delivered') {
            delete day.attempt;
            writeJsonAtomic(deps.stateFile, day);
        } else if (stale(day.attempt.startedAt)) {
            abandon('投递结果');
            delete day.attempt;
            if (line) day.pending = day.pending.slice(1);
            writeJsonAtomic(deps.stateFile, day);
        } else return pendingCheck('投递结果待核对');
    }
    const blockedBy = deps.blocked(deps.now());
    if (blockedBy) return { sent: 0, held: 0, dropped: 0, blockedBy };
    let dropped = 0;
    const importStages = (batch: readonly Stage[], imported: readonly Stage[] = []) => {
        for (const stage of batch) {
            if (imported.includes(stage)) continue;
            const { lines, bad } = parse(readFileSync(stagePath(stage), 'utf8'));
            day.pending.push(...lines);
            dropped += bad;
        }
        writeJsonAtomic(deps.stateFile, { ...day, imported: batch });
        for (const stage of batch) rmSync(stagePath(stage), { force: true });
        // 清掉提交标记后才能重新使用 .next。
        writeJsonAtomic(deps.stateFile, day);
    };
    if (stages.length) importStages(stages, state.imported);
    else if (state.imported?.length) writeJsonAtomic(deps.stateFile, day);
    if (existsSync(deps.file)) {
        renameSync(deps.file, stagePath('next'));
        importStages(['next']);
    }
    if (dropped) deps.log(`主动留话：${dropped} 行读不懂，丢掉`);

    const lines = day.pending;
    const rest: Line[] = [];
    let sent = 0;
    for (const [index, line] of lines.entries()) {
        if (now - line.at > maxAge) { dropped++; deps.log(`主动留话：「${line.text.slice(0, 20)}」过期了，不发`); continue; }
        const problem = deps.inspect(line.text);
        if (problem) { dropped++; deps.log(`主动留话：「${line.text.slice(0, 20)}」没过出口检查（${problem}），不发`); continue; }
        if (sent > 0 || day.sent >= dailyMax || now - day.lastSentAt < minGap) { rest.push(line); continue; }
        day.pending = lines.slice(index);
        const startedAt = deps.now();
        day.attempt = { startedAt, ...(deps.scope !== undefined ? { scope: deps.scope } : {}) };
        writeJsonAtomic(deps.stateFile, day);
        let messageId: number;
        try {
            messageId = await deps.send(line.text);
            if (!validMessageId(messageId)) return pendingCheck('投递结果待核对');
        } catch (error) {
            if (!(error instanceof OneBotNotDispatched)) return pendingCheck('投递结果待核对');
            delete day.attempt;
            const tries = (line.tries ?? 0) + 1;
            deps.log(`主动留话发不出去（第 ${tries} 次）：${error instanceof Error ? error.message : String(error)}`);
            if (tries >= maxTries) dropped++;
            else rest.push({ ...line, tries });
            rest.push(...lines.slice(index + 1));
            break;
        }
        settle(line, messageId, startedAt);
        sent++;
        if (!recordReceipt()) return { sent, held: day.pending.length, dropped, blockedBy: '已投递，聊天记录待核对' };
    }

    if (rest.length !== day.pending.length || rest.some((line, index) => line !== day.pending[index])) {
        day.pending = rest;
        writeJsonAtomic(deps.stateFile, day);
    }
    return { sent, held: rest.length, dropped };
}

function validMessageId(id: number): boolean {
    return Number.isSafeInteger(id) && id > 0;
}
