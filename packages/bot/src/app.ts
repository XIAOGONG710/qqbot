// 一个 bot 的编排：名单里每人一个回复器（contact.ts），名单外的好友按 unlisted 档（可关），连上 NapCat 时补回漏掉的消息再 catchUp，
// 定时写长期记忆，记下换档，同一个数据目录只跑一个。群聊、群临时会话由入口过滤掉，不进这里。
// 收发由入口传进来（ADR 0008）：独立入口 main.ts 是自写的 OneBot 客户端（onebot.ts），Koishi 插件是 adapter-onebot；
// 两边给的都是 NapCat 的原始 OneBot 数据，所以转文字（segmentsToText）、补回（findMissed）只有一份。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { acquireLock } from './lock.ts';
import type { Log } from './log.ts';
import { ChatHistory } from './history.ts';
import { BACKFILL_COUNT, CATCH_UP_WINDOW_MS, findMissed, shouldCatchUp, type HistoryMessage } from './backfill.ts';
import { segmentsToText, type MessageEvent } from './onebot.ts';
import type { Responder, ResponderStatus } from './responder.ts';
import { createContactResponder as createPipeline, loadTierCard, type ContactPipelineOptions, type TierCard } from './contact.ts';
import { currentTierHistory, TierRecord } from './tier-record.ts';
import { HindsightClient } from './memory/hindsight.ts';
import { arrivedWhileAsleep } from './reply-timing.ts';
import { LongTermMemory, type MemoryEvent } from './memory/long-term.ts';
import { describeState, stateAt } from './schedule.ts';

/** 写一次长期记忆的间隔 */
export const MEMORY_SYNC_MS = 5 * 60_000;

/** 入口提供的收发 */
export interface Transport {
    /** 发一条私聊文字，返回 QQ 消息 id */
    sendPrivateText(userId: number, text: string): Promise<number>;
    /** NapCat 的 get_friend_msg_history：某人最近 count 条私聊（含小号自己发的），从旧到新。没有任何记录时 NapCat 也报错 */
    friendHistory(userId: number, count: number): Promise<HistoryMessage[]>;
}

export interface App {
    /** 连上（或重连上）NapCat：补回漏掉的消息，补完之前到的消息攒着、补完按顺序处理，然后有没回的就回、写一次长期记忆 */
    connected(selfId: number): Promise<void>;
    /** 一条直接私聊（入口已经过滤掉群聊、群临时会话和小号自己发的） */
    receive(event: MessageEvent): void;
    /** 停下：回复器都停掉，不再写记忆，释放锁（Koishi 插件停用或重启时） */
    stop(): void;
    /** 此刻的状态（控制台「林梦瑶」页面，ADR 0010）；不含聊天内容 */
    status(): AppStatus;
}

export interface ContactStatus {
    qq: number;
    name: string;
    tier: Tier;
    /** 名单外的好友（按 unlisted 档临时建的回复器） */
    unlisted: boolean;
    /** 从什么时候起是这一档（tiers.json）；没换过档就没有 */
    tierSince?: string;
    responder: ResponderStatus;
    /** 最后一条消息的时间和谁发的，不含内容 */
    last?: { time: string; from: 'user' | 'assistant' };
    /** 作息开着时，这一档看到的「她现在在干什么」 */
    now?: string;
}

export interface AppStatus {
    contacts: ContactStatus[];
    unlistedFriends: boolean;
    schedule: boolean;
    /** 长期记忆开着时：服务探测结果（每分钟最多探一次）、最近一次写入和召回 */
    memory?: { baseUrl: string; health?: MemoryEvent; lastWrite?: MemoryEvent; lastRecall?: MemoryEvent };
}

/** Hindsight 健康检查的间隔 */
const HEALTH_PROBE_MS = 60_000;

export interface AppOptions {
    config: AppConfig;
    transport: Transport;
    log: Log;
    /** 测试用：替换每个回复器的生成、连发合并等待等 */
    pipeline?: Partial<Pick<ContactPipelineOptions, 'generate' | 'settle'>>;
}

/** 名单外的人在提示词里的称呼（{{user}}）：QQ 昵称，没有就叫「对方」 */
export function unlistedName(nickname: string | undefined): string {
    return nickname?.trim() || '对方';
}

export function startApp({ config, transport, log, pipeline }: AppOptions): App {
    // 每个档位一张角色卡和一本世界书，用到时读一次
    const cards = new Map<Tier, TierCard>();
    const cardFor = (tier: Tier) => {
        let card = cards.get(tier);
        if (!card) {
            card = loadTierCard(config.characterCard, tier);
            cards.set(tier, card);
        }
        return card;
    };
    // 先把要用到的都读一遍，缺文件立刻报错
    const tiersInUse = new Set<Tier>(config.contacts.map(c => c.tier));
    if (config.unlistedFriends) tiersInUse.add(UNLISTED_TIER);
    for (const tier of tiersInUse) {
        const { character, worldInfo } = cardFor(tier);
        log(`档位 ${tier}：角色 ${character.name}，世界书 ${character.world || '无'}（${worldInfo.length} 条）`);
    }
    const whitelist = config.contacts.map(c => `${c.qq}（${c.name}，${c.tier}）`).join('、');
    log(`名单：${whitelist}；名单外的好友${config.unlistedFriends ? '按 unlisted 档回复' : '不回复'}`);
    log(`作息：${config.schedule ? '按角色卡（她现在在干什么、什么时候看到、打字多久）' : '关（配置 schedule: false），随时几秒内回'}`);

    const chatHistory = new ChatHistory(config.dataDir);
    // 放在 ChatHistory 之后：它会建好数据目录
    const releaseLock = acquireLock(join(config.dataDir, 'bot.lock'));

    const tierRecord = new TierRecord(join(config.dataDir, 'tiers.json'));
    for (const contact of config.contacts) {
        const warning = tierRecord.update(contact.qq, contact.tier);
        if (warning) log(warning);
    }
    // 换过档的联系人只看换档之后的记录：提示词、长期记忆、补回都一样（ADR 0003 后果一节）
    const history = currentTierHistory(chatHistory, tierRecord);

    // 长期记忆（Hindsight）：补回之后写一次，之后每隔一段时间把结束了的片段写进去
    const hindsight = config.memory ? new HindsightClient(config.memory.baseUrl, config.memory.timeoutMs) : undefined;
    const memory = config.memory
        ? new LongTermMemory({
            api: hindsight!,
            dir: join(config.dataDir, 'memory'),
            bankPrefix: config.memory.bankPrefix,
            recallTimeoutMs: config.memory.recallTimeoutMs,
            log,
        })
        : undefined;
    log(memory ? `长期记忆：Hindsight ${config.memory!.baseUrl}（名单里的联系人）` : '长期记忆：未启用（配置里没有 memory）');
    function syncMemory(): void {
        if (!memory) return;
        for (const contact of config.contacts) {
            void memory.sync(contact, { user: contact.name, char: cardFor(contact.tier).character.name }, history.load(contact.qq));
        }
    }
    const memoryTimer = memory ? setInterval(syncMemory, MEMORY_SYNC_MS) : undefined;
    memoryTimer?.unref();

    // 每个联系人一个回复器：聊天记录、生成和重新生成都互不影响
    const responders = new Map<number, Responder>(config.contacts.map(contact => [contact.qq, createContactResponder(contact)]));
    /** 名单外临时建了回复器的好友（状态页要显示称呼和档位） */
    const unlisted = new Map<number, Contact>();

    function createContactResponder(contact: Contact): Responder {
        return createPipeline({
            contact,
            card: cardFor(contact.tier),
            llm: config.llm,
            prompt: config.prompt,
            schedule: config.schedule,
            history,
            memory,
            send: (userId, text) => transport.sendPrivateText(userId, text),
            log,
            // last-prompt.json 记录的是后处理之后、实际发给模型的消息
            onPrompt: prompt => writeFileSync(
                join(config.dataDir, 'last-prompt.json'),
                JSON.stringify({ qq: contact.qq, ...prompt }, null, 2),
            ),
            ...pipeline,
        });
    }

    let stopped = false;
    /** Hindsight 健康检查的结果（状态页用到时才探，见 status()） */
    let health: MemoryEvent | undefined;
    let probing = false;
    // 补完之前到的新消息先攒着，补完再按顺序处理
    let syncing = false;
    const buffered: MessageEvent[] = [];

    function onMessage(event: MessageEvent): void {
        let responder = responders.get(event.user_id);
        if (!responder) {
            if (!config.unlistedFriends) {
                log(`忽略 QQ ${event.user_id} 的私聊（不在名单）`);
                return;
            }
            // 名单外的好友：{{user}} 用对方的 QQ 昵称
            const contact: Contact = { qq: event.user_id, name: unlistedName(event.sender.nickname), tier: UNLISTED_TIER };
            // 换档时间取这条消息的 QQ 时间（秒）：取现在的话，这条消息的时间比换档时间早不到一秒，会被当成换档前的消息挡掉
            const warning = tierRecord.update(contact.qq, contact.tier, new Date(event.time * 1000));
            if (warning) log(warning);
            log(`QQ ${contact.qq}（${contact.name}）不在名单，按 ${UNLISTED_TIER} 档回复`);
            responder = createContactResponder(contact);
            responders.set(contact.qq, responder);
            unlisted.set(contact.qq, contact);
        }
        // 补回时可能已经从历史里拿到过这条
        if (history.load(event.user_id).some(m => m.messageId === event.message_id)) return;
        const text = segmentsToText(event.message).trim();
        if (!text) return;
        responder.receive(text, event.message_id, new Date(event.time * 1000));
    }

    async function syncMissed(selfId: number): Promise<void> {
        for (const contact of config.contacts) {
            let fetched: HistoryMessage[] = [];
            try {
                fetched = await transport.friendHistory(contact.qq, BACKFILL_COUNT);
            } catch (error) {
                // 没有任何聊天记录时 NapCat 也报错（“消息…不存在”）
                log(`[${contact.qq}] 拉取历史消息失败，跳过补回：${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            if (stopped) return;
            const missed = findMissed(history.load(contact.qq), fetched, selfId, tierRecord.since(contact.qq));
            for (const message of missed) history.append(contact.qq, message);
            if (missed.length) {
                const lines = missed.map(m => `${m.role === 'user' ? '对方' : '她'}：${m.content}`).join(' / ');
                log(`[${contact.qq}] 补回 ${missed.length} 条漏掉的消息：${lines}`);
            }
        }
    }

    function catchUpAll(): void {
        const now = new Date();
        for (const contact of config.contacts) {
            const stored = history.load(contact.qq);
            // 按作息时：她睡着时来的消息，起床后照样回（ADR 0007 决策 4）；还在睡就由回复器等到起床
            const schedule = config.schedule ? cardFor(contact.tier).character.schedule : undefined;
            if (shouldCatchUp(stored, now) || (schedule && arrivedWhileAsleep(stored, now.getTime(), schedule))) {
                log(`[${contact.qq}] 有没回的消息，回复`);
                responders.get(contact.qq)!.catchUp();
            } else if (stored.at(-1)?.role === 'user') {
                log(`[${contact.qq}] 没回的消息已超过 ${CATCH_UP_WINDOW_MS / 3_600_000} 小时，只补记录，等对方下一条消息时一起回`);
            }
        }
    }

    return {
        async connected(selfId) {
            if (stopped) return;
            syncing = true;
            try {
                await syncMissed(selfId);
            } finally {
                syncing = false;
                if (!stopped) {
                    for (const message of buffered.splice(0)) onMessage(message);
                    catchUpAll();
                    syncMemory();
                }
            }
        },
        receive(event) {
            if (stopped) return;
            if (syncing) buffered.push(event);
            else onMessage(event);
        },
        stop() {
            if (stopped) return;
            stopped = true;
            for (const responder of responders.values()) responder.stop();
            if (memoryTimer) clearInterval(memoryTimer);
            releaseLock();
        },
        status() {
            const now = new Date();
            const contactStatus = (contact: Contact, isUnlisted: boolean): ContactStatus => {
                const last = history.load(contact.qq).at(-1);
                const since = tierRecord.since(contact.qq);
                const schedule = config.schedule ? cardFor(contact.tier).character.schedule : undefined;
                return {
                    qq: contact.qq,
                    name: contact.name,
                    tier: contact.tier,
                    unlisted: isUnlisted,
                    ...(since ? { tierSince: since.toISOString() } : {}),
                    responder: responders.get(contact.qq)!.status(),
                    ...(last ? { last: { time: last.time, from: last.role } } : {}),
                    ...(schedule ? { now: describeState(stateAt(schedule, now), schedule, { userName: contact.name }) } : {}),
                };
            };
            if (hindsight && !stopped && !probing && (!health || now.getTime() - health.at >= HEALTH_PROBE_MS)) {
                probing = true;
                hindsight.health()
                    .then(() => { health = { at: Date.now(), ok: true }; }, error => {
                        health = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) };
                    })
                    .finally(() => { probing = false; });
            }
            return {
                contacts: [
                    ...config.contacts.map(contact => contactStatus(contact, false)),
                    ...[...unlisted.values()].map(contact => contactStatus(contact, true)),
                ],
                unlistedFriends: config.unlistedFriends,
                schedule: config.schedule,
                ...(config.memory ? { memory: { baseUrl: config.memory.baseUrl, health, ...memory!.status() } } : {}),
            };
        },
    };
}
