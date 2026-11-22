import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoredMessage } from '../memory/history.ts';

export type SilenceKind = 'asleep' | 'class' | 'busy' | 'forgotten' | 'lag' | 'closing' | 'moody' | 'declined' | 'failing';
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

const BY: Record<SilenceKind, SilenceBy> = { asleep: 'schedule', class: 'schedule', busy: 'schedule', forgotten: 'her', lag: 'schedule', closing: 'her', moody: 'her', declined: 'her', failing: 'system' };

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

const ASKED_ABOUT_SILENCE = /(?:^|[，,。！？!?\n])\s*(?=(?:[^，,。！？!?\n]*(?:怎么|为什么|咋)|[^，,。！？!?\n]+[？?]))(?:(?:刚才|刚刚|方才|之前|刚|怎么|为什么|咋|你|还|一直|都)\s*)+(?:没(?:有)?|不)回(?:复)?(?:我|消息|我消息)?(?:呀|啊|呢|吗)?\s*(?:$|[，,。！？!?\n])/;

/**
 * 「在睡」能不能照实说（她 2026-11-22 的条件：「大白天别动不动就写睡了，那也太假了」）：
 * 夜里（21 点到第二天 9 点，本地时间）按作息睡着的算；白天只有她自己在聊天里说过「睡了」的才算（那是她亲口说的，是真的）
 */
function sleepIsSayable(note: SilenceNote): boolean {
    const hour = new Date(note.at).getHours();
    return hour >= 21 || hour < 9 || /说了睡了/.test(note.reason);
}

/**
 * 他发的消息她没及时回，下一次正常回复时给她的一行提示（ADR 0173）。
 * 按她 2026-11-22 开 silenceNotice 时提的两条（原话见 ADR 0173「她的条件」）：
 * ① 原因得是真的：真在睡就说在睡，真在上课就说在上课，坏了就说坏了，不编；
 * ② 她自己不想回，就照实说当时不想回，不拿「在忙」顶上。
 */
export function silenceReplyCue(said: string, history: readonly StoredMessage[], notes: readonly SilenceNote[], now: number): string | undefined {
    const asked = ASKED_ABOUT_SILENCE.test(said);
    const firstPending = history.slice(history.findLastIndex(message => message.role === 'assistant') + 1).find(message => message.role === 'user');
    const since = firstPending ? Date.parse(firstPending.time) : Number.NaN;
    const note = notes.find(entry => entry.at >= since && entry.at <= now && entry.kind !== 'lag');
    if (note?.kind === 'asleep' && sleepIsSayable(note)) {
        return '[你刚才确实在睡，没看到。现在正常接话，可以顺口用自己的语气提一句在睡，别报时间或细节，不想解释也不用说。]';
    }
    if (note?.kind === 'class') {
        return '[你刚才确实在上课，没顾上回。现在正常接话，可以顺口用自己的语气提一句在上课，别报时间或细节，不想解释也不用说。]';
    }
    if (note?.kind === 'busy') {
        return '[你刚才确实在忙，没顾上回。现在正常接话，可以顺口用自己的语气提一句，别报时间或细节，不想解释也不用说。]';
    }
    if (note?.kind === 'failing') {
        return '[你刚才没回是因为出了故障，消息没能回出去，不是你不想回，也不是在忙。现在正常接话，可以顺口照实提一句刚才出故障了，别编别的原因。]';
    }
    if (note?.kind === 'forgotten') {
        return '[你刚才确实忘了回。现在正常接话，可以顺口用自己的语气提一句，不想解释也不用说。]';
    }
    if (!asked) return undefined;
    if (note?.kind === 'closing') {
        return '[他在问你刚才怎么没回。刚才话题已经收尾，愿意就简单说一句，以为已经聊完了；不想细讲也可以接着聊。]';
    }
    if (note?.kind === 'moody' || note?.kind === 'declined') {
        return '[他在问你刚才怎么没回。是你自己当时不想回：照实说当时不想回就行，别说在忙、别编别的原因；为什么不想回可以不细讲。]';
    }
    return '[他在问你刚才怎么没回。没有可确认、适合交代的原因就别编，尤其别猜自己忙了或忘了；不想细讲可以不说原因。]';
}
