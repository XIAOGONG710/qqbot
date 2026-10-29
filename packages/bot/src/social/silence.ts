// 她没回他的时候，总要让他知道原因（用户 10-29：「被晾着可以，但连续发消息不回时总该让我知道原因」，ADR 0173，配置 silenceNotice，默认关）。
//
// 为什么做：她以后会有越来越多「不马上回」的理由（作息、自己的事、气还没消、答应了别人……）。真人被晾着的人也想知道「是忙、是睡了、是不想回、还是坏了」；
// 而「是她自己的决定」和「是故障」对他来说完全是两回事——前者是她的自主，后者要他去修。所以每一次没回都要有一个记在账上的原因，并且说清是谁的决定。
//
// 做法：响应器本来就知道原因（等到几点才看到：在睡觉 / 在上课……；看到了决定不回；失败重试），只是只在控制台状态页里留最近一次、不告诉他。
// 这里：① 把这些原因归成几类、标明「作息 / 她的决定 / 故障」；② 逐条记账；③ 他连着发了几条都没回、过了一会儿，就用「（」开头的运维提示告诉他一次
// （和 /设定、/休眠 一样，不冒充她说话、不进她的聊天记录）；④ 他随时发 /为什么 也能问。
// 查不到原因时老实说「查不到」，不编。

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoredMessage } from '../memory/history.ts';

export type SilenceKind = 'asleep' | 'class' | 'busy' | 'lag' | 'closing' | 'moody' | 'declined' | 'failing' | 'dormant' | 'working' | 'generating' | 'unknown';
/** 谁的决定：作息安排 / 她自己的决定 / 系统（故障、休眠、工作模式） */
export type SilenceBy = 'schedule' | 'her' | 'system';

export interface SilenceNote {
    at: number;
    kind: SilenceKind;
    by: SilenceBy;
    /** 原样的原因（响应器 / 作息给的那句话） */
    reason: string;
    /** 预计什么时候看到 / 什么时候再试（毫秒时间戳） */
    until?: number;
    failures?: number;
}

/** 响应器的回调参数（见 responder.ts 的 onSilence） */
export interface SilenceInfo {
    phase: 'waiting' | 'skipped' | 'retry' | 'gaveUp';
    reason: string;
    seenAt?: number;
    retryAt?: number;
    failures?: number;
}

const BY: Record<SilenceKind, SilenceBy> = { asleep: 'schedule', class: 'schedule', busy: 'schedule', lag: 'schedule', closing: 'her', moody: 'her', declined: 'her', failing: 'system', dormant: 'system', working: 'system', generating: 'system', unknown: 'system' };

/** 「等到几点才看到」的原因（reply-timing.ts 的 whenSeen 给的话）归类 */
export function kindOfWaiting(reason: string): SilenceKind {
    if (/睡/.test(reason)) return 'asleep';
    if (/在上.{0,4}课|上课/.test(reason)) return 'class';
    if (/洗|忙/.test(reason) && !/在做别的/.test(reason)) return 'busy';
    return 'lag';
}

/** 「看到了决定不回」的原因（replySkip / moodySkip 给的话）归类；认不出的按她的决定算 */
export function kindOfSkip(reason: string): SilenceKind {
    if (/收尾|附和/.test(reason)) return 'closing';
    if (/心情/.test(reason)) return 'moody';
    return 'declined';
}

export function noteFromInfo(info: SilenceInfo, at: number): SilenceNote {
    const kind: SilenceKind = info.phase === 'waiting' ? kindOfWaiting(info.reason) : info.phase === 'skipped' ? kindOfSkip(info.reason) : 'failing';
    const until = info.phase === 'waiting' ? info.seenAt : info.retryAt;
    return { at, kind, by: BY[kind], reason: info.reason, ...(until !== undefined ? { until } : {}), ...(info.failures !== undefined ? { failures: info.failures } : {}) };
}

// ───────── 连着没回 ─────────

export interface Streak {
    /** 她上一次回复之后，他连着发了几条 */
    count: number;
    firstAt: number;
    lastAt: number;
}

/** 她最后一次回复之后他发的消息（只数他发的）；没有就 undefined */
export function unansweredStreak(history: readonly StoredMessage[]): Streak | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const pending = history.slice(lastReply + 1).filter(message => message.role === 'user');
    if (!pending.length) return undefined;
    return { count: pending.length, firstAt: Date.parse(pending[0]!.time), lastAt: Date.parse(pending.at(-1)!.time) };
}

export interface SilenceThresholds {
    /** 连着几条没回才通知 */
    minMessages: number;
    /** 第一条没回的消息过了多久才通知 */
    minAgeMs: number;
}
export const DEFAULT_THRESHOLDS: SilenceThresholds = { minMessages: 2, minAgeMs: 8 * 60_000 };
/** 同一串最多通知几次（原因变了才再通知，比如从「在忙」变成「连不上模型」） */
export const MAX_NOTICES_PER_STREAK = 3;

export interface NoticeState {
    /** 通知过的那一串（第一条的时间）和通知过的原因类别 */
    firstAt?: number;
    kinds?: SilenceKind[];
}

export function shouldNotify(streak: Streak | undefined, kind: SilenceKind, state: NoticeState, now: number, thresholds: SilenceThresholds = DEFAULT_THRESHOLDS): boolean {
    if (!streak || streak.count < thresholds.minMessages || now - streak.firstAt < thresholds.minAgeMs) return false;
    if (state.firstAt !== streak.firstAt) return true;
    const done = state.kinds ?? [];
    return !done.includes(kind) && done.length < MAX_NOTICES_PER_STREAK;
}

// ───────── 说给他听 ─────────

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const minutesAgo = (now: number, at: number) => Math.max(1, Math.round((now - at) / 60_000));

export interface ExplainContext {
    now: number;
    streak?: Streak | undefined;
    /** 休眠、工作模式这类不在响应器里的原因 */
    dormant?: boolean;
    working?: boolean;
}

/** 当前这一串没回的原因（响应器此刻的状态 + 外部原因）→ 一条记账用的原因；没有明确原因返回 'unknown' */
export function currentNote(status: { phase: string; seenAt?: number; reason?: string; retryAt?: number; failures?: number; skipped?: { at: number; reason: string } }, context: ExplainContext): SilenceNote {
    const { now } = context;
    if (context.dormant) return { at: now, kind: 'dormant', by: 'system', reason: '她在休眠' };
    if (context.working) return { at: now, kind: 'working', by: 'system', reason: '她在工作模式里帮他干活' };
    if (status.phase === 'waiting' && status.reason) return noteFromInfo({ phase: 'waiting', reason: status.reason, ...(status.seenAt !== undefined ? { seenAt: status.seenAt } : {}) }, now);
    if (status.phase === 'retry') return noteFromInfo({ phase: 'retry', reason: status.reason ?? '回复失败', ...(status.retryAt !== undefined ? { retryAt: status.retryAt } : {}), failures: status.failures ?? 0 }, now);
    if (status.skipped) return noteFromInfo({ phase: 'skipped', reason: status.skipped.reason }, now);
    // 重试都用完、放弃了：状态回到 idle，只剩失败次数（已排定的重试数；实际失败了这么多 + 1 次）
    if ((status.failures ?? 0) > 0) return noteFromInfo({ phase: 'gaveUp', reason: '回复一直失败', failures: (status.failures ?? 0) + 1 }, now);
    if (status.phase === 'settling' || status.phase === 'generating' || status.phase === 'sending') return { at: now, kind: 'generating', by: 'system', reason: status.phase === 'settling' ? '在等他说完' : '正在回' };
    return { at: now, kind: 'unknown', by: 'system', reason: '没有记录到原因' };
}

/** 给他看的说明：开头说他有几条没回，然后说原因，最后说「这是谁的决定、要不要他做什么」。「（」开头：运维提示，不进她的聊天记录 */
export function explain(note: SilenceNote, context: ExplainContext): string {
    const { now, streak } = context;
    const head = streak ? `你有 ${streak.count} 条消息她还没回（最早一条是 ${minutesAgo(now, streak.firstAt)} 分钟前）：` : '';
    const when = note.until && note.until > now ? `，约 ${clock(note.until)} 看到` : '';
    const body: Record<SilenceKind, string> = {
        asleep: `她在睡觉${when}，会接着回。这是作息，不是故障。`,
        class: `她在上课${when}。这是作息，不是故障。`,
        busy: `她在忙（${note.reason}）${when}。这是作息，不是故障。`,
        lag: `她看到得慢一点（${note.reason}）${when}。这是她的节奏，不是故障。`,
        closing: '她上一句已经是收尾（晚安、去忙吧……），你后面发的只是附和，她选择不回。这是她自己的决定；换个新话题她就会回。',
        moody: '她看到了，选择先不回：这一串只是「哈哈」「嗯」这类反应，她看心情。这是她自己的决定，不是故障；隔一分钟再发一条她一定回。',
        declined: `她看到了，选择先不回（${note.reason}）。这是她自己的决定，不是故障。`,
        failing: `她回不了：${note.reason}；已经连着失败 ${note.failures ?? 0} 次${note.until && note.until > now ? `，约 ${clock(note.until)} 再试` : '，这一轮不再自动重试，等你下一条消息再回'}。这是故障（多半是网络 / 模型），不是她不想回。`,
        dormant: '她在休眠，发 /唤醒 叫醒她。',
        working: '她在工作模式里帮你干活，还没做完；发 /QQ 可以切回聊天。',
        generating: `她正在回你（${note.reason}）。如果超过几分钟还没动静，可能卡住了，看控制台状态页或日志。`,
        unknown: '我这边查不到她没回的明确原因（她这会儿没有在等、也没有在生成）。刚发的话多等一会儿；如果已经过了十分钟还没动静，很可能掉线了——看控制台状态页或日志。',
    };
    return `（${head}${body[note.kind]}）`;
}

// ───────── 记账 ─────────

export const silencePath = (dataDir: string, qq: number) => join(dataDir, 'silence', `${qq}.jsonl`);
const KEEP = 300;

/** 追加一条；和上一条同类同原因、不到一分钟就不重复记（响应器每分钟会重算几次） */
export function recordSilence(dataDir: string, qq: number, note: SilenceNote): void {
    const path = silencePath(dataDir, qq);
    mkdirSync(dirname(path), { recursive: true });
    const last = recentSilence(dataDir, qq, 1)[0];
    if (last && last.kind === note.kind && last.reason === note.reason && last.until === note.until && note.at - last.at < 60_000) return;
    appendFileSync(path, `${JSON.stringify(note)}\n`);
    // 文件长了（60 KB 以上，约几百条）就只留最近的（先写临时文件再改名）；平时不读整个文件
    try {
        if (statSync(path).size < 60_000) return;
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        if (lines.length > KEEP) {
            writeFileSync(`${path}.tmp`, `${lines.slice(-KEEP).join('\n')}\n`);
            renameSync(`${path}.tmp`, path);
        }
    } catch { /* 修剪失败不影响记账 */ }
}

export function recentSilence(dataDir: string, qq: number, count = 20): SilenceNote[] {
    try {
        return readFileSync(silencePath(dataDir, qq), 'utf8').split('\n').filter(Boolean).slice(-count).flatMap(line => {
            try { const note = JSON.parse(line) as SilenceNote; return typeof note.at === 'number' && typeof note.kind === 'string' ? [note] : []; } catch { return []; }
        }).reverse();
    } catch { return []; }
}

export const noticeStatePath = (dataDir: string) => join(dataDir, 'silence-notices.json');

function loadNoticeState(dataDir: string, qq: number): NoticeState {
    try { return (JSON.parse(readFileSync(noticeStatePath(dataDir), 'utf8')) as Record<string, NoticeState>)[String(qq)] ?? {}; } catch { return {}; }
}
function saveNoticeState(dataDir: string, qq: number, state: NoticeState): void {
    let all: Record<string, NoticeState> = {};
    try { all = JSON.parse(readFileSync(noticeStatePath(dataDir), 'utf8')) as Record<string, NoticeState>; } catch { /* 第一次 */ }
    all[String(qq)] = state;
    mkdirSync(dirname(noticeStatePath(dataDir)), { recursive: true });
    writeFileSync(`${noticeStatePath(dataDir)}.tmp`, JSON.stringify(all, null, 2));
    renameSync(`${noticeStatePath(dataDir)}.tmp`, noticeStatePath(dataDir));
}

// ───────── 看着他的消息：该通知就通知 ─────────

export interface WatcherDeps {
    dataDir: string;
    qq: number;
    now: () => number;
    history: () => readonly StoredMessage[];
    status: () => { phase: string; seenAt?: number; reason?: string; retryAt?: number; failures?: number; skipped?: { at: number; reason: string } };
    external: () => { dormant?: boolean; working?: boolean };
    tell: (text: string) => void;
    log: (message: string) => void;
    thresholds?: SilenceThresholds;
}

/** 每分钟调一次 tick：他连着发了几条都没回、过了一会儿，就告诉他一次原因（原因变了才再告诉） */
export function createSilenceWatcher(deps: WatcherDeps) {
    return {
        tick(): boolean {
            const now = deps.now();
            const streak = unansweredStreak(deps.history());
            const context: ExplainContext = { now, streak, ...deps.external() };
            if (!streak) return false;
            const note = currentNote(deps.status(), context);
            const state = loadNoticeState(deps.dataDir, deps.qq);
            if (!shouldNotify(streak, note.kind, state, now, deps.thresholds)) return false;
            // 记下来再发：发失败了也不重复轰炸（他还有 /为什么）
            const kinds = state.firstAt === streak.firstAt ? [...(state.kinds ?? []), note.kind] : [note.kind];
            saveNoticeState(deps.dataDir, deps.qq, { firstAt: streak.firstAt, kinds });
            deps.log(`她没回他 ${streak.count} 条（${note.kind}，${note.by === 'her' ? '她的决定' : note.by === 'schedule' ? '作息' : '系统'}）：告诉他原因`);
            recordSilence(deps.dataDir, deps.qq, note);
            deps.tell(explain(note, context));
            return true;
        },
    };
}

/** /为什么：他现在问。有没回的就说现在的原因；没有就说上一次没马上回是什么时候、为什么 */
export function answerWhy(deps: Pick<WatcherDeps, 'dataDir' | 'qq' | 'now' | 'history' | 'status' | 'external'>): string {
    const now = deps.now();
    const streak = unansweredStreak(deps.history());
    const context: ExplainContext = { now, streak, ...deps.external() };
    if (streak) return explain(currentNote(deps.status(), context), context);
    const last = recentSilence(deps.dataDir, deps.qq, 1)[0];
    if (!last) return '（你的消息她都回过了，也没有记录到她没回的情况。）';
    return `（你的消息她都回过了。最近一次没马上回是 ${new Date(last.at).toLocaleString('zh-CN', { hour12: false })}：${explain(last, { now }).slice(1, -1)}）`;
}
