import type { Executor } from '../executor/executor.ts';
import type { currentTierHistory, TierRecord } from '../memory/tier-record.ts';
import { UNLISTED_TIER, type AppConfig, type Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { segmentsToText, type MessageEvent } from '../platform/onebot.ts';
import { SlidingWindowRateLimiter } from './rate-limit.ts';
import type { Responder } from './responder.ts';
import { greetingOnly, markSignature, MINOR_NOTICE, minorHint, strangerGuard } from './strangers.ts';

// 谁的私聊她回：名单里的人；名单外的好友（unlistedFriends 开着）按 unlisted 档临时建回复器，个人和全局限流；
// 陌生人的规矩（ADR 0209）：个性签名写明她是 AI 才回、看出是未成年人照实说一句之后不回、只打了招呼先不回、每天上限。
// 原来在 app.ts（unlistedLimiter / strangers / ensureAiSignature 和 processMessage 开头那一段），ADR 0336 第 6 步原样搬到这里。
export interface PrivateAdmissionDeps {
    config: Pick<AppConfig, 'contacts' | 'unlistedFriends' | 'dataDir'>;
    transport: Pick<Executor['qq'], 'sendPrivateText' | 'setSignature' | 'callAction'>;
    responders: Map<number, Responder>;
    /** 名单外临时建了回复器的好友（状态页要显示称呼和档位） */
    unlisted: Map<number, Contact>;
    createResponder: (contact: Contact) => Responder;
    tierRecord: Pick<TierRecord, 'update'>;
    history: ReturnType<typeof currentTierHistory>;
    unlistedName: (nickname: string | undefined) => string;
    worldNow: () => number;
    log: Log;
}

export function privateAdmission({ config, transport, responders, unlisted, createResponder, tierRecord, history, unlistedName, worldNow, log }: PrivateAdmissionDeps) {
    const unlistedLimiter = new SlidingWindowRateLimiter();
    /** 陌生人私聊的规矩（ADR 0209）：签名写明是 AI 才回、每天上限、只打招呼先不回、未成年人不陪 */
    const strangers = config.unlistedFriends ? strangerGuard(config.dataDir, log) : undefined;
    /** 个性签名里写明她是 AI（用户 11-02：陌生人从签名知道，聊天里不主动说）：每次连上都查一遍，没有就补「（AI）」；改不了就一直不回陌生人 */
    async function ensureAiSignature(selfId: number): Promise<void> {
        if (!strangers) return;
        if (!transport.setSignature) { log('陌生人：这条 QQ 通道改不了个性签名，签名没法写明她是 AI，所以不回陌生人（ADR 0209）'); return; }
        let current = '';
        try {
            const info = await transport.callAction?.('get_stranger_info', { user_id: selfId, no_cache: true }) as { long_nick?: string; longNick?: string } | undefined;
            current = info?.long_nick ?? info?.longNick ?? '';
        } catch (error) { log(`陌生人：读不到现在的个性签名（${error instanceof Error ? error.message : String(error)}），按空的补`); }
        const next = markSignature(current);
        try {
            if (next !== current.replace(/\s+/g, ' ').trim()) await transport.setSignature(next);
            strangers.markSigned(worldNow());
            log(`陌生人：个性签名写明了她是 AI（${next === current.replace(/\s+/g, ' ').trim() ? '本来就写着' : '补上了「（AI）」'}）`);
        } catch (error) {
            log(`陌生人：个性签名没改成（${error instanceof Error ? error.message : String(error)}），先不回陌生人`);
        }
    }

    /** 这条私聊回不回：回就给（必要时新建的）回复器，不回就 undefined（原因已记日志） */
    function admit(event: MessageEvent): Responder | undefined {
        // 陌生人（ADR 0209）：签名还没写明是 AI 的时候不回；看出是未成年人的号不再回
        const isStranger = !config.contacts.some(c => c.qq === event.user_id);
        if (isStranger && config.unlistedFriends && strangers) {
            if (!strangers.signed()) { log(`忽略 QQ ${event.user_id} 的私聊（个性签名还没写明她是 AI，先不回陌生人）`); return undefined; }
            if (strangers.isMinor(event.user_id)) { log(`忽略 QQ ${event.user_id} 的私聊（之前看出是未成年人，不再回）`); return undefined; }
        }
        let responder = responders.get(event.user_id);
        if (!responder) {
            if (!config.unlistedFriends) {
                log(`忽略 QQ ${event.user_id} 的私聊（不在名单）`);
                return undefined;
            }
            const decision = unlistedLimiter.take(event.user_id);
            if (!decision.allowed) {
                log(`忽略 QQ ${event.user_id} 的私聊（名单外好友${decision.scope === 'contact' ? '个人' : '全局'}限流；约 ${Math.ceil(decision.retryAfterMs / 60_000)} 分钟后恢复）`);
                return undefined;
            }
            // 名单外的好友：{{user}} 用对方的 QQ 昵称
            const contact: Contact = { qq: event.user_id, name: unlistedName(event.sender.nickname), tier: UNLISTED_TIER };
            // 换档时间取这条消息的 QQ 时间（秒）：取现在的话，这条消息的时间比换档时间早不到一秒，会被当成换档前的消息挡掉
            const warning = tierRecord.update(contact.qq, contact.tier, new Date(event.time * 1000));
            if (warning) log(warning);
            log(`QQ ${contact.qq}（${contact.name}）不在名单，按 ${UNLISTED_TIER} 档回复`);
            responder = createResponder(contact);
            responders.set(contact.qq, responder);
            unlisted.set(contact.qq, contact);
        } else if (unlisted.has(event.user_id)) {
            const decision = unlistedLimiter.take(event.user_id);
            if (!decision.allowed) {
                log(`忽略 QQ ${event.user_id} 的私聊（名单外好友${decision.scope === 'contact' ? '个人' : '全局'}限流；约 ${Math.ceil(decision.retryAfterMs / 60_000)} 分钟后恢复）`);
                return undefined;
            }
        }
        // 陌生人（ADR 0209）：未成年人照实说一句、之后不回；只打了招呼的先不回（她本人：「就一句"在吗"那种，我基本不回」）；每天上限
        if (isStranger && strangers && unlisted.has(event.user_id)) {
            const qq = event.user_id;
            const plain = segmentsToText(event.message).trim();
            const said = { time: new Date(event.time * 1000).toISOString(), role: 'user' as const, content: plain || '[消息]', messageId: event.message_id };
            if (minorHint(plain)) {
                strangers.markMinor(qq);
                history.append(qq, said);
                log(`陌生人 ${qq} 说了自己是未成年人：照实说一句她是 AI、不陪未成年人聊天，之后不再回`);
                void transport.sendPrivateText(qq, MINOR_NOTICE)
                    .then(messageId => history.append(qq, { time: new Date(worldNow()).toISOString(), role: 'assistant', content: MINOR_NOTICE, messageId }))
                    .catch(error => log(`陌生人 ${qq}：那句没发出去：${error instanceof Error ? error.message : String(error)}`));
                return undefined;
            }
            const stored = history.load(qq);
            const lastHers = stored.findLastIndex(m => m.role === 'assistant');
            const waiting = stored.slice(lastHers + 1).filter(m => m.role === 'user').map(m => m.content);
            if (greetingOnly([...waiting, plain])) {
                history.append(qq, said);
                log(`陌生人 ${qq} 只打了个招呼，先不回，等他说点什么`);
                return undefined;
            }
            const daily = strangers.take(qq, worldNow());
            if (!daily.allowed) { log(`忽略 QQ ${qq} 的私聊（${daily.reason}）`); return undefined; }
        }
        return responder;
    }

    return { strangers, ensureAiSignature, admit };
}
