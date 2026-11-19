import { canGiveFeedback } from './config.ts';
import type { AppConfig } from './config.ts';
import type { TierCard } from './contact.ts';
import type { createFeedbackChannel } from '../emotion/feedback.ts';
import { detectCrisis, type CrisisLevel } from '../emotion/crisis.ts';
import { CRISIS_PAUSE_MS } from '../emotion/crisis-state.ts';
import type { Executor } from '../executor/executor.ts';
import { BACKFILL_COUNT, CATCH_UP_WINDOW_MS, newerThanStored, shouldCatchUp, toStored, type HistoryMessage } from '../memory/backfill.ts';
import { sourceMessageSeq, type ChatHistory, type StoredMessage } from '../memory/history.ts';
import type { currentTierHistory, TierRecord } from '../memory/tier-record.ts';
import type { Responder } from '../social/responder.ts';
import { arrivedWhileAsleep } from '../social/reply-timing.ts';
import type { StickerShelf } from '../social/stickers.ts';
import type { IncomingDeps, incomingReceipts } from './incoming.ts';
import type { Log } from './log.ts';
import type { quotedContext } from './quoted-context.ts';
import type { SensitiveSwitch } from './sensitive.ts';

// 连上之后补回漏掉的消息（停机、断线期间他发的、她在别处发的）和补回复（有没回的就回，她睡着时来的起床后回）。
// 原来在 app.ts（syncMissed / catchUpAll），ADR 0336 第 6 步原样搬到这里；什么时候调（连上、唤醒、后台重试）照旧由 App 定。
export interface MissedMessagesDeps {
    config: Pick<AppConfig, 'contacts' | 'schedule'>;
    stopped: () => boolean;
    transport: Pick<Executor['qq'], 'friendHistory'>;
    history: ReturnType<typeof currentTierHistory>;
    chatHistory: ChatHistory;
    tierRecord: Pick<TierRecord, 'since'>;
    /** 他回的「假」/「像」（ADR 0073）：补回时也认 */
    feedback: ReturnType<typeof createFeedbackChannel> | undefined;
    collectingStickers: StickerShelf | undefined;
    ownStickerWork: (work: (signal: AbortSignal) => Promise<void>) => Promise<void>;
    readerFor: IncomingDeps['readerFor'];
    incoming: Pick<ReturnType<typeof incomingReceipts>, 'recoverIncoming' | 'incomingFailure' | 'tracksIncoming' | 'activeIncoming' | 'bufferedIncomingIds' | 'claimIncoming' | 'releaseIncoming'>;
    quoted: ReturnType<typeof quotedContext>;
    markCrisis: (qq: number, at: number, level: CrisisLevel) => void;
    sensitive: Pick<SensitiveSwitch, 'on'>;
    cardFor: (tier: string) => Pick<TierCard, 'character'>;
    responders: ReadonlyMap<number, Pick<Responder, 'catchUp'>>;
    log: Log;
}

export function missedMessages({ config, stopped, transport, history, chatHistory, tierRecord, feedback, collectingStickers, ownStickerWork, readerFor, incoming, quoted, markCrisis, sensitive, cardFor, responders, log }: MissedMessagesDeps) {
    const { recoverIncoming, incomingFailure, tracksIncoming, activeIncoming, bufferedIncomingIds, claimIncoming, releaseIncoming } = incoming;
    const { missingQuotes, fetchQuotes, missingForwards, fetchForwards, quoteLookup, forwardLookup } = quoted;

    async function syncMissed(selfId: number): Promise<void> {
        for (const contact of config.contacts) {
            if (stopped()) return;
            try {
                const beforeRecovery = history.load(contact.qq);
                try { await recoverIncoming(contact.qq); } catch (error) { incomingFailure(error); }
                if (stopped()) return;
                // 聊天先于副状态保存：上次中断可能已存同ID消息，不能只等NapCat重新补回。
                const recoveredAt = Date.now();
                for (const message of history.load(contact.qq)) {
                    const at = Date.parse(message.time);
                    if (message.role !== 'user' || !Number.isFinite(at) || at > recoveredAt || recoveredAt - at >= CRISIS_PAUSE_MS) continue;
                    const hit = detectCrisis(message.content);
                    if (hit) markCrisis(contact.qq, at, hit.level);
                }
                let fetched: HistoryMessage[] = [];
                try {
                    fetched = await transport.friendHistory(contact.qq, BACKFILL_COUNT);
                } catch (error) {
                    if (stopped()) return;
                    // 没有任何聊天记录时 NapCat 也报错（“消息…不存在”）
                    log(`[${contact.qq}] 拉取历史消息失败，跳过补回：${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                if (stopped()) return;
                let fresh = newerThanStored(beforeRecovery, fetched, tierRecord.since(contact.qq), selfId);
                fresh = fresh.filter(message => !chatHistory.hasMessage(contact.qq, message.message_id, {
                    role: (message.sender?.user_id ?? message.user_id) === selfId ? 'assistant' : 'user',
                    time: new Date(message.time * 1000).toISOString(), sourceTime: message.time, messageSeq: sourceMessageSeq(message.real_seq),
                }));
                // 停机期间他回的「假」/「像」：记下来，不当聊天补回（ADR 0073）
                if (feedback && canGiveFeedback(contact)) {
                    const stored = history.load(contact.qq);
                    fresh = fresh.filter(m => (m.sender?.user_id ?? m.user_id) === selfId
                        || !feedback.consume(contact.qq, contact.tier, m.message, m.message_id, new Date(m.time * 1000), stored));
                }
                // Reserve all user sources before the first asynchronous decode.
                // A live buffered receipt has its own owner and is drained later.
                let staged = fresh.map(message => {
                    try {
                        return { ...message, blocked: false, incomingId: tracksIncoming(contact.qq) && (message.sender?.user_id ?? message.user_id) !== selfId
                            ? chatHistory.stageIncoming(contact.qq, { source: {
                                messageId: message.message_id, role: 'user', time: new Date(message.time * 1000).toISOString(), messageSeq: sourceMessageSeq(message.real_seq),
                            }, message: message.message }) : undefined };
                    } catch (error) { incomingFailure(error); return { ...message, blocked: true, incomingId: undefined }; }
                }).filter(message => !message.blocked);
                staged = staged.filter(message => !message.incomingId || !activeIncoming.has(message.incomingId) && !bufferedIncomingIds.has(message.incomingId));
                const acquired = staged.flatMap(message => message.incomingId ? [message.incomingId] : []);
                for (const id of acquired) claimIncoming(id);
                try {
                    // 他发的语音、图片先听一听、看一看（ADR 0052）；读的时候实时收到的那条可能已经记下了，按 id 再筛一遍
                    const backReader = readerFor(contact.qq);
                    if (collectingStickers && contact.tier === 'boyfriend') {
                        for (const message of staged.filter(message => (message.sender?.user_id ?? message.user_id) !== selfId)) {
                            void ownStickerWork(signal => collectingStickers.consider(message.message, { from: contact.qq, messageId: message.message_id }, { signal }));
                        }
                    }
                    if (backReader && staged.some(m => backReader.needs(m.message))) {
                        const contactLog = (message: string) => log(`[${contact.qq}] ${message}`);
                        staged = await Promise.all(staged.map(async m => ({ ...m, message: await backReader.read(m.message, m.message_id, contactLog, {
                            messageId: m.message_id, peer: contact.qq, role: (m.sender?.user_id ?? m.user_id) === selfId ? 'assistant' : 'user',
                            time: new Date(m.time * 1000).toISOString(), sourceTime: m.time, messageSeq: sourceMessageSeq(m.real_seq),
                        }).catch(() => m.message) })));
                        if (stopped()) return;
                        staged = staged.filter(m => !chatHistory.hasMessage(contact.qq, m.message_id, {
                            role: (m.sender?.user_id ?? m.user_id) === selfId ? 'assistant' : 'user',
                            time: new Date(m.time * 1000).toISOString(), sourceTime: m.time, messageSeq: sourceMessageSeq(m.real_seq),
                        }));
                    }
                    // 补回消息里的引用和合并转发也要先补齐，再把正文提交给记忆与回复链。
                    const fetchIds = [...new Set(staged.flatMap(message => missingQuotes(contact.qq, message.message)))];
                    if (fetchIds.length) await fetchQuotes(contact.qq, fetchIds, selfId);
                    const forwardIds = [...new Set(staged.flatMap(message => missingForwards(message.message)))];
                    if (forwardIds.length) await fetchForwards(contact.qq, forwardIds);
                    if (stopped()) return;
                    const missed: StoredMessage[] = [];
                    for (const raw of staged) {
                        const decoded = toStored([raw], selfId, quoteLookup(contact.qq), forwardLookup(contact.qq, selfId))[0];
                        if (!decoded) { if (raw.incomingId) chatHistory.discardIncoming(contact.qq, raw.incomingId); continue; }
                        if (chatHistory.hasMessage(contact.qq, decoded.messageId!, decoded)) continue;
                        const accepted = raw.incomingId ? chatHistory.prepareIncoming(contact.qq, raw.incomingId, decoded, content => Boolean(detectCrisis(content))) : decoded;
                        history.append(contact.qq, accepted); missed.push(accepted);
                    }
                    // 停机期间他说过想伤害自己的话：补回时也记一笔（只记时间），暂停期从他说话的时候算（ADR 0068）
                    for (const message of missed) {
                        if (message.role !== 'user') continue;
                        const crisis = detectCrisis(message.content);
                        if (crisis) markCrisis(contact.qq, Date.parse(message.time), crisis.level);
                    }
                    if (missed.length) {
                        const lines = sensitive.on()
                            ? missed.map(m => `${m.role === 'user' ? '对方' : '她'}：${m.content}`).join(' / ')
                            : `${missed.filter(m => m.role === 'user').length} 条是对方的，${missed.filter(m => m.role !== 'user').length} 条是她的（共 ${missed.reduce((total, m) => total + [...m.content].length, 0)} 字）`;
                        log(`[${contact.qq}] 补回 ${missed.length} 条漏掉的消息：${lines}`);
                    }
                } catch (error) { incomingFailure(error); }
                finally { for (const id of acquired) releaseIncoming(id); }
            } catch (error) { incomingFailure(error); }
        }
    }

    function catchUpAll(): void {
        const now = new Date();
        for (const contact of config.contacts) {
            try {
                const stored = history.load(contact.qq);
                // 按作息时：她睡着时来的消息，起床后照样回（ADR 0007 决策 4）；还在睡就由回复器等到起床
                const schedule = config.schedule ? cardFor(contact.tier).character.schedule : undefined;
                if (shouldCatchUp(stored, now) || (schedule && arrivedWhileAsleep(stored, now.getTime(), schedule))) {
                    log(`[${contact.qq}] 有没回的消息，回复`);
                    responders.get(contact.qq)!.catchUp();
                } else if (stored.at(-1)?.role === 'user') {
                    log(`[${contact.qq}] 没回的消息已超过 ${CATCH_UP_WINDOW_MS / 3_600_000} 小时，只补记录，等对方下一条消息时一起回`);
                }
            } catch (error) { incomingFailure(error); }
        }
    }

    return { syncMissed, catchUpAll };
}
