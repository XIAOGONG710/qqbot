// 桌面对话收进 QQ 自己的账（ADR 0347 第 3 层地基，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.1「采集」）。
// 只是纯读写，还没接线（开关 desktopDay 由主会话加），不改她的言行。
//
// - 来源：<数据目录>/memory/desktop-recent.jsonl，DSH 插件写（每轮一行 { at, user, assistant, userAt? }，最近 14 天），
//   而且是**整份重写**（临时文件再改名），不是只追加——所以不能用 dsh-inbox.ts 那种按行号的游标，按 id 去重。
// - 去处：<数据目录>/memory/desktop-log.jsonl，QQ 写、插件不读；每行
//   { v: 1, id: 'dk-<at 毫秒>-<sha256(user + assistant) 前 8 位>', at: ISO（一轮结束）, userAt?: ISO（他开口）, user: ≤600 字, assistant: ≤600 字 }。
//   id 用截成 600 字以后的 user / assistant 算，所以拿账里的一行就能重算出同一个 id；同一轮被插件重写多少次都只收一次。
// - 比现在晚 1 分钟以上（两台钟没对齐）、早于 14 天的行跳过；账本只留 14 天（日记补写回看 3 天、承诺 7 天、自我认识 14 天）。
// - 读：desktopTurns(dataDir, now) 给 { at, userAt?, user, assistant }（毫秒），可以直接交给 life/desktop-presence.ts 的 presenceAt / sessionsFromTurns。
// - 写账本先写同目录的临时文件再改名；账本读不了（不是「没有」）就不写，免得只剩这一批新行把 14 天的账盖掉。
// - 坏行跳过，日志只记行数、不记内容（里面是他在电脑上的原话）。
// 文件读写和时间都由调用方给（ops / now），测试里可以换。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { desktopRecentPath } from './cross-recent.ts';
import { MEMORY_THRESHOLDS } from './thresholds.ts';
import type { PresenceTurn } from '../life/desktop-presence.ts';

export const DESKTOP_LOG_FILE = 'desktop-log.jsonl';
export const DESKTOP_LOG_VERSION = 1;
/** 账本只留这么久，也只收这么久以内的回合（默认 14 天，记忆阈值表 desktopKeepMs，和插件留 desktop-recent.jsonl 的同一个数） */
export const DESKTOP_LOG_KEEP_MS = MEMORY_THRESHOLDS.desktopKeepMs;
/** 比现在晚这么多以内当作两台钟没对齐，照收；再晚就跳过（下一次收的时候不再是未来了再收） */
export const DESKTOP_LOG_FUTURE_SLACK_MS = 60_000;
/** 每边最多存这么多字（插件写的是这么多字加一个省略号；默认 600，desktopTextChars，和插件同一个数） */
export const DESKTOP_LOG_TEXT_CHARS = MEMORY_THRESHOLDS.desktopTextChars;
/** 他开口到一轮结束最长算这么久；userAt 比这还早（或晚于 at）就当没有 userAt，免得一个错的时刻把会话开始拉到几天前 */
export const DESKTOP_TURN_MAX_MS = 3 * 3_600_000;

const ID_RE = /^dk-\d{1,16}-[0-9a-f]{8}$/;

export const desktopLogPath = (dataDir: string): string => join(dataDir, 'memory', DESKTOP_LOG_FILE);
export const desktopRecentFile = (dataDir: string): string => desktopRecentPath(join(dataDir, 'memory'));

/** 账本里的一行（落盘格式） */
export interface DesktopLogRow {
    v: typeof DESKTOP_LOG_VERSION;
    id: string;
    at: string;
    userAt?: string;
    user: string;
    assistant: string;
}

/** 读出来的一轮（毫秒）；PresenceTurn 的超集，能直接切会话 */
export interface DesktopLogTurn extends PresenceTurn {
    at: number;
    userAt?: number;
    user: string;
    assistant: string;
}

/** 文件操作（测试里可以换成会失败的版本）；readText 遇到「没有这个文件」返回 undefined，别的错误照抛 */
export interface DesktopLogOps {
    readText(path: string): string | undefined;
    writeText(path: string, text: string): void;
    rename(from: string, to: string): void;
    unlink(path: string): void;
    mkdir(path: string): void;
}

const enoent = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
};

export const desktopLogOps: DesktopLogOps = {
    readText(path) {
        try { return readFileSync(path, 'utf8'); } catch (error) { if (enoent(error)) return undefined; throw error; }
    },
    writeText: (path, text) => writeFileSync(path, text),
    rename: renameSync,
    unlink: unlinkSync,
    mkdir: path => { mkdirSync(path, { recursive: true }); },
};

const clipText = (text: string) => [...text].slice(0, DESKTOP_LOG_TEXT_CHARS).join('');

/** 一轮的 id：dk-<at 毫秒>-<sha256(user + assistant) 前 8 位>（user / assistant 是截过的） */
export function desktopLogId(at: number, user: string, assistant: string): string {
    return `dk-${at}-${createHash('sha256').update(user + assistant).digest('hex').slice(0, 8)}`;
}

const inWindow = (at: number, now: number) => at <= now + DESKTOP_LOG_FUTURE_SLACK_MS && at >= now - DESKTOP_LOG_KEEP_MS;

const validUserAt = (userAt: unknown, at: number): userAt is number =>
    typeof userAt === 'number' && Number.isSafeInteger(userAt) && userAt <= at && at - userAt <= DESKTOP_TURN_MAX_MS;

/** desktop-recent.jsonl 的一行 → 一轮；格式不对、两边都空、不在窗口里返回 undefined */
export function parseRecentRow(value: unknown, now: number): DesktopLogTurn | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value as { at?: unknown; userAt?: unknown; user?: unknown; assistant?: unknown };
    if (typeof row.at !== 'number' || !Number.isSafeInteger(row.at) || row.at < 0) return undefined;
    if (typeof row.user !== 'string' || typeof row.assistant !== 'string') return undefined;
    if (!inWindow(row.at, now)) return undefined;
    const user = clipText(row.user);
    const assistant = clipText(row.assistant);
    if (!user.trim() && !assistant.trim()) return undefined;
    return { at: row.at, ...(validUserAt(row.userAt, row.at) ? { userAt: row.userAt } : {}), user, assistant };
}

const isIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** 账本里的一行 → 一轮（带 id）；格式不对返回 undefined */
export function parseLogRow(value: unknown): (DesktopLogTurn & { id: string }) | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value as Partial<Record<keyof DesktopLogRow, unknown>>;
    if (row.v !== DESKTOP_LOG_VERSION || typeof row.id !== 'string' || !ID_RE.test(row.id) || !isIso(row.at)) return undefined;
    if (typeof row.user !== 'string' || typeof row.assistant !== 'string') return undefined;
    if ([...row.user].length > DESKTOP_LOG_TEXT_CHARS || [...row.assistant].length > DESKTOP_LOG_TEXT_CHARS) return undefined;
    if (row.userAt !== undefined && !isIso(row.userAt)) return undefined;
    const at = Date.parse(row.at);
    const userAt = row.userAt === undefined ? undefined : Date.parse(row.userAt);
    return { id: row.id, at, ...(userAt !== undefined && validUserAt(userAt, at) ? { userAt } : {}), user: row.user, assistant: row.assistant };
}

const toRow = (turn: DesktopLogTurn): DesktopLogRow => ({
    v: DESKTOP_LOG_VERSION,
    id: desktopLogId(turn.at, turn.user, turn.assistant),
    at: new Date(turn.at).toISOString(),
    ...(turn.userAt !== undefined ? { userAt: new Date(turn.userAt).toISOString() } : {}),
    user: turn.user,
    assistant: turn.assistant,
});

/** 按行解析；坏行只计数（不带内容） */
function parseLines<T>(text: string, parse: (value: unknown) => T | undefined): { rows: T[]; bad: number } {
    const rows: T[] = [];
    let bad = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { bad++; continue; }
        const row = parse(value);
        if (row === undefined) bad++; else rows.push(row);
    }
    return { rows, bad };
}

const byAt = <T extends { at: number }>(rows: T[]) => rows.map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.at - b.row.at || a.index - b.index).map(item => item.row);

let writeSequence = 0;

function writeAtomic(ops: DesktopLogOps, path: string, text: string): void {
    ops.mkdir(dirname(path));
    const tmp = `${path}.tmp-${process.pid}-${++writeSequence}`;
    try {
        ops.writeText(tmp, text);
        ops.rename(tmp, path);
    } catch (error) {
        try { ops.unlink(tmp); } catch { /* 保留最初的写入错误 */ }
        throw error;
    }
}

export interface DesktopIngestResult {
    /** 新收进几轮 */
    added: number;
    /** 账本里现在有几轮 */
    kept: number;
    /** 超过 14 天被清掉的 */
    pruned: number;
    /** 来源里跳过的行（坏行、未来、太老；已经收过的不算） */
    skipped: number;
    /** 账本里读不懂、这次重写时丢掉的行 */
    corrupt: number;
}

export interface DesktopIngestOptions {
    /** desktop-recent.jsonl（插件写） */
    recentFile: string;
    /** desktop-log.jsonl（QQ 写） */
    logFile: string;
    now: number;
    log?: (message: string) => void;
    ops?: DesktopLogOps;
}

/**
 * 从 desktop-recent.jsonl 收一次：按 id 去重、跳过未来 / 14 天前 / 坏行，清掉账本里 14 天前的，按时间排好整份重写。
 * 什么都没变就不写。账本暂时读不了时抛错、不写（下一次再收，插件那边最近 40 行还在）。
 */
export function ingestDesktopRecent(options: DesktopIngestOptions): DesktopIngestResult {
    const ops = options.ops ?? desktopLogOps;
    const { now } = options;
    const existing = parseLines(ops.readText(options.logFile) ?? '', parseLogRow);
    const kept = existing.rows.filter(row => row.at >= now - DESKTOP_LOG_KEEP_MS);
    const pruned = existing.rows.length - kept.length;
    const ids = new Set(kept.map(row => row.id));
    const source = parseLines(ops.readText(options.recentFile) ?? '', value => parseRecentRow(value, now));
    const added: DesktopLogTurn[] = [];
    for (const turn of source.rows) {
        const id = desktopLogId(turn.at, turn.user, turn.assistant);
        if (ids.has(id)) continue;
        ids.add(id);
        added.push(turn);
    }
    const result: DesktopIngestResult = { added: added.length, kept: kept.length + added.length, pruned, skipped: source.bad, corrupt: existing.bad };
    if (existing.bad) options.log?.(`桌面：账本里 ${existing.bad} 行读不懂，这次重写时丢掉（不记内容）`);
    if (!added.length && !pruned && !existing.bad) return result;
    const rows = byAt([...kept.map(({ id: _id, ...turn }) => turn), ...added]).map(toRow);
    writeAtomic(ops, options.logFile, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
    if (added.length) options.log?.(`桌面：收进 ${added.length} 轮（账本里共 ${result.kept} 轮${pruned ? `，清掉 14 天前的 ${pruned} 轮` : ''}）`);
    else if (pruned) options.log?.(`桌面：清掉 14 天前的 ${pruned} 轮`);
    return result;
}

/** 读账本：14 天以内、不晚于现在 1 分钟以上的回合，按时间排好；没有文件是空；坏行跳过（有 log 时记行数） */
export function readDesktopLog(logFile: string, now: number, options: { log?: (message: string) => void; ops?: DesktopLogOps } = {}): DesktopLogTurn[] {
    const ops = options.ops ?? desktopLogOps;
    const { rows, bad } = parseLines(ops.readText(logFile) ?? '', parseLogRow);
    if (bad) options.log?.(`桌面：账本里 ${bad} 行读不懂，跳过（不记内容）`);
    return byAt(rows.filter(row => inWindow(row.at, now)).map(({ id: _id, ...turn }) => turn));
}

/** <数据目录> 下的桌面回合（给 presenceAt / sessionsFromTurns、以后的回想和承诺用） */
export function desktopTurns(dataDir: string, now: number, options: { log?: (message: string) => void; ops?: DesktopLogOps } = {}): DesktopLogTurn[] {
    return readDesktopLog(desktopLogPath(dataDir), now, options);
}
