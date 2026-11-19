import type { Dormancy } from '../memory/dormancy.ts';
import { shouldCatchUp } from '../memory/backfill.ts';
import { sourceMessageSeq, type ChatHistory, type StoredMessage } from '../memory/history.ts';
import { stateTimestamp } from '../memory/state-schema.ts';
import type { currentTierHistory, TierRecord } from '../memory/tier-record.ts';
import { describeError } from '../memory/transient-io.ts';
import { detectCrisis, type CrisisLevel } from '../emotion/crisis.ts';
import type { Executor } from '../executor/executor.ts';
import type { Responder } from '../social/responder.ts';
import type { mediaReading } from '../vision/media.ts';
import type { AppConfig, Contact } from './config.ts';
import type { Log } from './log.ts';
import { segmentsToText, type ForwardLookup, type MessageEvent, type QuoteLookup, type Segment } from './onebot.ts';

// 入站收据（私聊）：收到的消息先在聊天记录旁边记一笔（stageIncoming），读完图、听完语音才正式进记录；
// 中途停了、写盘失败了，下次连上或后台重试时从收据补上，不丢也不重复（命令和设备动作不重跑）。
// 每人一条队（inbox）：要读的消息读完才进记录，后面来的排在它后面。
// 原来在 app.ts（activeIncoming / bufferedIncoming / stageEvent / incomingFailure / scheduleIncomingRetry / recoverIncoming / queueIncomingRecovery ……），
// ADR 0336 第 6 步原样搬到这里；停法仍由 App 在原位登记（lifetime.own('incoming')），收消息、补回、撤回照旧在 App 和各模块里调这些。
export interface IncomingDeps {
    config: Pick<AppConfig, 'contacts' | 'recalls'>;
    stopped: () => boolean;
    /** 连上后正在补回漏掉的消息 */
    syncing: () => boolean;
    exec: Pick<Executor, 'after' | 'cancel'>;
    chatHistory: ChatHistory;
    history: ReturnType<typeof currentTierHistory>;
    tierRecord: Pick<TierRecord, 'since'>;
    dormancy: Pick<Dormancy, 'isDormant'> | undefined;
    responders: ReadonlyMap<number, Pick<Responder, 'catchUp'>>;
    readerFor: (qq: number) => ReturnType<typeof mediaReading> | undefined;
    quoteLookup: (qq: number) => QuoteLookup;
    forwardLookup: (qq: number) => ForwardLookup;
    markCrisis: (qq: number, at: number, level: CrisisLevel) => void;
    syncRecalledMemory: (qq: number) => void;
    deviceOwner: Contact | undefined;
    plainTextOf: (message: Segment[] | string) => string | undefined;
    /** 每人一条：要听、要看的消息读完才进聊天记录（收消息那边也排在这条队上） */
    inbox: Map<number, Promise<void>>;
    log: Log;
}

export function incomingReceipts({ config, stopped, syncing, exec, chatHistory, history, tierRecord, dormancy, responders, readerFor, quoteLookup, forwardLookup, markCrisis, syncRecalledMemory, deviceOwner, plainTextOf, inbox, log }: IncomingDeps) {
    const activeIncoming = new Map<string, number>();
    const claimIncoming = (id: string) => activeIncoming.set(id, (activeIncoming.get(id) ?? 0) + 1);
    const releaseIncoming = (id: string) => { const count = activeIncoming.get(id) ?? 0; if (count > 1) activeIncoming.set(id, count - 1); else activeIncoming.delete(id); };
    const bufferedIncoming = new WeakMap<MessageEvent, string>();
    const bufferedIncomingIds = new Set<string>();
    let incomingRetryTimer: ReturnType<Executor['after']> | undefined;
    const stop = () => {
        exec.cancel(incomingRetryTimer);
        try { chatHistory.flushIncoming(); } catch (error) { log(`停止时入站状态仍未确认持久（${describeError(error)}）`); }
    };
    let incomingRetryRunning = false;
    let incomingRetryLogged = false;

    const eventIdentity = (event: MessageEvent) => ({ role: 'user' as const, time: new Date(event.time * 1000).toISOString(), messageSeq: sourceMessageSeq(event.real_seq) });
    function validIncomingEvent(event: MessageEvent): boolean {
        if (!Number.isSafeInteger(event.user_id) || event.user_id <= 0 || !Number.isSafeInteger(event.message_id) || event.message_id < 0
            || !Number.isSafeInteger(event.time)) return false;
        const at = new Date(event.time * 1000);
        return Number.isFinite(at.getTime()) && stateTimestamp(at.toISOString());
    }
    const tracksIncoming = (qq: number) => config.recalls && config.contacts.some(contact => contact.qq === qq);
    function stageEvent(event: MessageEvent): string | undefined {
        return tracksIncoming(event.user_id) ? chatHistory.stageIncoming(event.user_id, {
            source: { ...eventIdentity(event), messageId: event.message_id }, message: event.message,
        }) : undefined;
    }
    function incomingFailure(error: unknown): void {
        if (!incomingRetryLogged) { log(`入站处理未完成，保留已知状态并重试（${describeError(error)}）`); incomingRetryLogged = true; }
        scheduleIncomingRetry();
    }
    function scheduleIncomingRetry(): void {
        if (stopped() || incomingRetryTimer) return;
        incomingRetryTimer = exec.after(() => {
            incomingRetryTimer = undefined;
            if (stopped() || syncing() || incomingRetryRunning) { if (!stopped()) scheduleIncomingRetry(); return; }
            incomingRetryRunning = true;
            void (async () => {
                let failed = false;
                for (const contact of config.contacts) {
                    if (stopped()) return;
                    try {
                        chatHistory.flushIncoming(contact.qq);
                        const count = await queueIncomingRecovery(contact.qq);
                        syncRecalledMemory(contact.qq);
                        if (count && !dormancy?.isDormant() && shouldCatchUp(history.load(contact.qq), new Date())) responders.get(contact.qq)?.catchUp();
                    } catch (error) { failed = true; incomingFailure(error); }
                }
                if (!failed) incomingRetryLogged = false;
            })().catch(incomingFailure).finally(() => { incomingRetryRunning = false; });
        }, 1000);
        incomingRetryTimer.unref?.();
    }

    function prepareReceived(event: MessageEvent, text: string, receipt?: string): StoredMessage {
        const decoded: StoredMessage = { ...eventIdentity(event), messageId: event.message_id, content: text };
        return receipt ? chatHistory.prepareIncoming(event.user_id, receipt, decoded, content => Boolean(detectCrisis(content))) : decoded;
    }
    /** Recovery never reruns an interrupted operational command or device action. */
    function interruptedCommand(qq: number, message: Segment[] | string): boolean {
        if (qq !== deviceOwner?.qq) return false;
        const plain = plainTextOf(message)?.trim();
        return Boolean(plain && (/^\/(?:dsh|休眠|屏幕|摄像头|设备)(?:\s|$)/.test(plain)
            || ['/设定', '/唤醒', '/主动', '批准', '拒绝'].includes(plain)));
    }
    async function recoverIncoming(qq: number): Promise<number> {
        if (!tracksIncoming(qq) || stopped() || dormancy?.isDormant()) return 0;
        let added = 0;
        const since = tierRecord.since(qq);
        for (const entry of chatHistory.pendingIncoming(qq)) {
            if (stopped() || dormancy?.isDormant()) break;
            if (activeIncoming.has(entry.id) || bufferedIncomingIds.has(entry.id)) continue;
            // A tier boundary limits disclosure, not ownership of old private data.
            if (since && Date.parse(entry.source.time) < since.getTime()) continue;
            claimIncoming(entry.id);
            try {
                let decoded = entry.prepared;
                if (!decoded) {
                    // Restoring a receipt is not authority to repeat an operational command.
                    if (!entry.withdrawn && interruptedCommand(qq, entry.message)) continue;
                    const reader = readerFor(qq);
                    const message = reader?.needs(entry.message)
                        ? await reader.read(entry.message, entry.source.messageId!, message => log(`[${qq}] ${message}`), { ...entry.source, peer: qq }).catch(() => entry.message)
                        : entry.message;
                    if (stopped()) break;
                    const text = segmentsToText(message, quoteLookup(qq), forwardLookup(qq)).trim();
                    if (!text) { chatHistory.discardIncoming(qq, entry.id); continue; }
                    decoded = { ...entry.source, role: 'user', content: text };
                }
                const accepted = chatHistory.prepareIncoming(qq, entry.id, decoded, content => Boolean(detectCrisis(content)));
                if (stopped() || dormancy?.isDormant()) break;
                history.append(qq, accepted);
                const hit = detectCrisis(accepted.content);
                if (hit) markCrisis(qq, Date.parse(accepted.time), hit.level);
                added++;
            } finally { releaseIncoming(entry.id); }
        }
        if (added) syncRecalledMemory(qq);
        return added;
    }
    function queueIncomingRecovery(qq: number): Promise<number> {
        const work = (inbox.get(qq) ?? Promise.resolve()).then(() => recoverIncoming(qq));
        const owned = work.then(() => undefined, () => undefined);
        inbox.set(qq, owned);
        void owned.then(() => { if (inbox.get(qq) === owned) inbox.delete(qq); });
        return work;
    }

    return {
        activeIncoming, claimIncoming, releaseIncoming, bufferedIncoming, bufferedIncomingIds, eventIdentity, validIncomingEvent, tracksIncoming, stageEvent,
        incomingFailure, prepareReceived, recoverIncoming, queueIncomingRecovery, stop,
    };
}
