// App 对外的几个类型（收发、App 本身、状态页的数据）：2026-11-28 从 app.ts 原样搬出来，给 app.ts 腾行数（app-size.test.ts 的上限）。
// app.ts 照旧 re-export，别处 import 路径不用改。只有类型，没有运行时代码。

import type { AirQualityFetcherStatus } from '../world/air-quality.ts';
import type { CalendarStatus } from '../world/calendar.ts';
import type { CrisisLevel } from '../emotion/crisis.ts';
import type { DaylightFetcherStatus } from '../world/daylight.ts';
import type { DevelopmentSummary } from '../life/development.ts';
import type { DshProbeResult } from '../dsh-link.ts';
import type { ExternalDraftStore, ExternalDraftSummary } from '../social/external-drafts.ts';
import type { ExternalPlatformMode } from '../social/external-platforms.ts';
import type { FeatureStatus } from './features.ts';
import type { GroupMessageEvent, MessageEvent, PokeEvent, RecallEvent, Segment } from './onebot.ts';
import type { HistoryCursor, HistoryMessage } from '../memory/backfill.ts';
import type { HumanValueTrends, HumanValues } from '../human-values.ts';
import type { MemoryEvent } from '../memory/long-term.ts';
import type { MobileCompanionIntegration } from '../mobile-companion-dsh.ts';
import type { PlannerStatus } from '../proactive/proactive-planner.ts';
import type { PresenceTransport } from '../social/presence.ts';
import type { ProactiveMode } from '../proactive/proactive.ts';
import type { ResponderStatus } from '../social/responder.ts';
import type { RuntimeInfo } from './runtime-info.ts';
import type { Tier } from './config.ts';
import type { WeatherFetcherStatus } from '../world/weather.ts';

/** 入口提供的收发 */
export interface Transport extends PresenceTransport {
    /** 发一条私聊文字，返回 QQ 消息 id；文字里白名单的小黄脸「[捂脸]」发成 face 段（qq-faces.ts textToSegments，ADR 0051） */
    sendPrivateText(userId: number, text: string, replyTo?: number): Promise<number>;
    /** 发群消息（ADR 0210，NapCat 的 send_group_msg）；没有就不在群里说话 */
    sendGroupText?(groupId: number, text: string, replyTo?: number): Promise<number>;
    /** 发群消息（段）：@某人、引用那一条（2026-11-14）；没有就退回 sendGroupText */
    sendGroupMessage?(groupId: number, segments: Segment[], replyTo?: number): Promise<number>;
    /** 在群里戳一下某人（NapCat 的 group_poke，配置 pokeOut）；没有就不戳 */
    pokeGroup?(groupId: number, userId: number): Promise<void>;
    /** 发一条 QQ 分享卡片（B 站小程序），返回消息 id；没有就不发卡片、用文字链接 */
    sendPrivateCard?(userId: number, cardJson: string): Promise<number>;
    /** 标已读（NapCat mark_private_msg_as_read，配置 readReceipts，ADR 0083）；没有就不标 */
    markRead?(userId: number): Promise<void>;
    /** 让对方那边显示「正在输入…」（配置 typingStatus，ADR 0077）；没有就不显示 */
    setInputStatus?(userId: number, eventType?: number): Promise<void>;
    /** 撤回自己发出去的一条（NapCat 的 delete_msg，配置 selfRecall，ADR 0086）；没有就不撤回 */
    deleteMessage?(messageId: number): Promise<void>;
    /** 戳他一下（NapCat 的 friend_poke，配置 pokeBack）；没有就不戳 */
    pokeFriend?(userId: number): Promise<void>;
    /** 发本地图片表情；配置 stickers 开时两个入口都提供。 */
    sendPrivateImage?(userId: number, file: string, summary: string): Promise<number>;
    /** 发一条语音（本机 wav，NapCat 转语音条）；没有就不发语音（2026-11-01） */
    sendPrivateVoice?(userId: number, file: string): Promise<number>;
    /** NapCat 的 get_friend_msg_history：某人最近 count 条私聊（含小号自己发的），从旧到新。没有任何记录时 NapCat 也报错 */
    friendHistory(userId: number, count: number, cursor?: HistoryCursor): Promise<HistoryMessage[]>;
    /** 通用 OneBot 调用（账号控制面用，ADR 0142）：传什么动作就发什么，闸由 account.ts 管；没有就不开控制面 */
    callAction?(action: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface App {
    /** 连上（或重连上）NapCat：补回漏掉的消息，补完之前到的消息攒着、补完按顺序处理，然后有没回的就回、写一次长期记忆 */
    connected(selfId: number): Promise<void>;
    /** 一条直接私聊（入口已经过滤掉群聊、群临时会话和小号自己发的） */
    receive(event: MessageEvent): void;
    /** 名单里的人私聊戳了她一下（ADR 0079，配置 pokes）：算数的话变成一条「[戳了戳你]」走原来的回复流程；其余的忽略 */
    receivePoke(event: PokeEvent): void;
    /** 名单里的人撤回了一条消息（ADR 0082，配置 recalls）：还没回的话记成「[撤回了一条消息]」；其余的忽略 */
    receiveRecall(event: RecallEvent): void;
    /** 有人申请加她（ADR 0142，qqControl 是 on 时）：名单内同意；名单外留着。不认识的申请不碰 */
    receiveFriendRequest(input: { userId: number; flag: string; comment?: string }): void;
    /** 群里别人发的一条（ADR 0210，配置 groupChat + groups）：只在名单里的群看、该开口时才说；不在名单的群什么都不做 */
    receiveGroup(event: GroupMessageEvent): void;
    /** 停下：拒绝新工作；已派发的记忆写入/回复发送确认并收尾后才释放锁。idle同步，忙时宿主须await。 */
    stop(): Promise<void> | undefined;
    /** 此刻的状态（控制台「林梦瑶」页面，ADR 0010）；不含聊天内容 */
    status(): AppStatus;
    /** DSH 开启时可供宿主挂 HTTPS / WebSocket 的手机伴侣运行时；默认关闭时为 undefined。 */
    mobileCompanion(): MobileCompanionIntegration | undefined;
    /** 外部平台草稿箱；只保存草稿和审计状态，不执行发布。 */
    externalDrafts(): ExternalDraftStore;
}

export interface ContactStatus {
    qq: number;
    name: string;
    tier: Tier;
    /** 配置里写的：这个人是否知道她是程序（ADR 0067）；没写就没有这个字段，按不知道处理 */
    knowsBot?: boolean;
    /** 实际用的卡：档位名，或承认版「<档位>-open」（ADR 0067） */
    card: string;
    /** 从什么时候起是这一档（tiers.json）；没换过档就没有 */
    tierSince?: string;
    /** 最近一次危机信号的时间和分级（不记内容），以及普通主动消息是否仍暂停；没触发过就没有。 */
    crisis?: { at: string; level: CrisisLevel; paused: boolean };
    responder: ResponderStatus;
    /** 最后一条消息的时间和谁发的，不含内容 */
    last?: { time: string; from: 'user' | 'assistant' };
    /** 作息开着时，这一档看到的「她现在在干什么」 */
    now?: string;
    /** 主动消息的计划（开着、这一档会主动时） */
    proactive?: PlannerStatus;
}

export interface AppStatus {
    /** 正在运行的提交、分支和启动时间；由启动脚本注入，不再靠 ADR 猜线上版本。 */
    runtime: RuntimeInfo;
    /** 进程此刻实际在用的时区（ADR 0331）：作息、饭点、日界都按它算；状态页据此显示她那边的本地时间 */
    timeZone: string;
    contacts: ContactStatus[];
    schedule: boolean;
    /** 看心情不回（ADR 0013）开没开；作息关着时不起作用 */
    moody: boolean;
    /** 出口检查里查不查说话的毛病（ADR 0014） */
    speechCheck: boolean;
    /** 她自己的日子（ADR 0015）开没开 */
    herDays: boolean;
    /** 开着、用到的档位卡上有心情或书时：她今天的心情和在读的书 */
    today?: HerDayStatus;
    proactive: ProactiveMode;
    /** 每个功能开关此刻开没开（ADR 0120）：状态页按模块分组画 */
    features: FeatureStatus[];
    /** 照片货架 / AI 照片草稿 / 小梗 / 最近一份周报；对应的功能没开就没有。 */
    extras?: { photos?: { count: number; cat: number; view: number; work: number; food: number }; aiPhotoDrafts?: { total: number; pending: number; approved: number; rejected: number }; jokes?: number; report?: { name: string; text: string } };
    /** 长期记忆开着时：服务探测结果（每分钟最多探一次）、最近一次写入和召回 */
    memory?: { baseUrl: string; health?: MemoryEvent; lastWrite?: MemoryEvent; lastRecall?: MemoryEvent };
    /** 手机伴侣安全摘要：不含配对码、nonce 或消息正文。 */
    mobileCompanion?: { enabled: boolean; pairedClientId?: string; connected: boolean; queued: number; maxQueuedPerClient: number };
    /** 真实天气缓存的新鲜度和覆盖范围，不含坐标和请求内容。 */
    weather?: WeatherFetcherStatus;
    /** 真实空气质量缓存的新鲜度和覆盖范围，不含坐标和请求内容。 */
    airQuality?: AirQualityFetcherStatus;
    /** 真实日照缓存的新鲜度和覆盖范围，不含坐标和请求内容。 */
    daylight?: DaylightFetcherStatus;
    /** 现实法定日历缓存的新鲜度和覆盖年份。 */
    calendar?: CalendarStatus;
    /** 外部内容平台接入模式。 */
    externalPlatforms: { tieba: ExternalPlatformMode; douyin: ExternalPlatformMode; xiaohongshu: ExternalPlatformMode };
    /** 外部平台统一草稿箱的计数摘要。 */
    externalDrafts: ExternalDraftSummary;
    /** DSH 连接摘要；探针只在 QQ 明确发起 /dsh probe 后更新。 */
    dsh: { enabled: boolean; lastProbe?: Pick<DshProbeResult, 'ok' | 'at' | 'model' | 'latencyMs'> };
    /** 自主生活开启且有需要锚点时的全局真人式状态；关系值也随同一快照提供给 DSH / 控制台。 */
    humanValues?: Pick<HumanValues, 'at' | 'energy' | 'hunger' | 'stress' | 'mood' | 'health' | 'loneliness' | 'confidence' | 'curiosity' | 'boredom' | 'motivation' | 'socialBattery' | 'selfEsteem' | 'openness' | 'satisfaction' | 'comfort' | 'frustration' | 'relationship'>;
    /** 由同一事实账重算的一小时变化量，不另存第二套分数。 */
    humanTrends?: HumanValueTrends;
    /** 人格与生活深化的脱敏派生摘要；不含聊天原文、事件正文或内部评分。 */
    development?: DevelopmentSummary;
}

/** 状态页的「今天」（ADR 0015） */
export interface HerDayStatus {
    /** 她的哪一天（02:00 之前算前一天） */
    day: string;
    mood?: { name: string; reason: string };
    books: { title: string; amount: number; unit: string; finished: boolean; stopped: boolean; putDown: boolean }[];
    /** 世界账里今天已经发生的近期事实；只给控制台看，不含计划和模型猜测。 */
    highlights?: { at: string; text: string }[];
}
