import { join } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import type { AppConfig } from '../platform/config.ts';
import type { TierCard } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import type { ChatHistory } from '../memory/history.ts';
import type { CrisisState } from '../emotion/crisis-state.ts';
import { asleepSince } from '../life/bedtime.ts';
import { readingActivities } from '../life/her-days.ts';
import { herPlanActivities } from '../life/her-plans.ts';
import { describeState, stateAt, type Schedule } from '../life/schedule.ts';
import { dayMatches } from '../proactive/proactive.ts';
import type { ImageDescriber } from '../vision/media.ts';
import { POKE_OUT_TEXT, pokeOutMessageId, quietEnoughToPoke } from './pokes.ts';
import { createPresence, FESTIVAL_SIGNATURES, type Presence, type PresenceTransport } from './presence.ts';
import { qzoneComposer } from './qzone.ts';

// 存在感（ADR 0083）：在线状态 / 资料卡点赞 / 个性签名 / 说说 / 翻空间 / 主动戳他。
// 原来在 app.ts 里（startPresence），ADR 0336 第 6 步原样搬到这里（`presenceOwner(deps)`），函数体逐字不动；
// 第一次连上时由 App 调 start，醒来、连上时调 reapply，停法仍由 App 登记（lifetime.own('presence')）。
export interface PresenceOwnerDeps {
    config: AppConfig;
    log: Log;
    worldNow: () => number;
    cardFor: (tier: string) => TierCard;
    /** 她的世界用的那张卡（作息、在读的书、日子）；herDays 关时没有 */
    worldCard: TierCard['character'] | undefined;
    bedtimes: (schedule: Schedule, now: number) => readonly number[];
    exec: Pick<Executor, 'llm'>;
    chatHistory: Pick<ChatHistory, 'load' | 'append'>;
    transport: PresenceTransport;
    vision: ImageDescriber | undefined;
    /** 她那边这一刻在下雨 */
    rainyAt: (now: number) => boolean;
    /** 休眠：休眠时存在感全停 */
    dormancy: { isDormant(): boolean } | undefined;
    crisisState: Pick<CrisisState, 'pausedAt'>;
}

export interface PresenceOwner {
    /** 起存在感（已经起了的不重起；一个开关都没开、没有作息就不起） */
    start(): void;
    /** 重新套用在线状态等（醒来、重连后） */
    reapply(): void;
    /** 存在感那边记下的近况（聊天提示词用）；没起时没有 */
    selfNote(now: number): string | undefined;
    stop(): Promise<void> | undefined;
}

export function presenceOwner(deps: PresenceOwnerDeps): PresenceOwner {
    const { config, log, worldNow, cardFor, worldCard, bedtimes, exec, chatHistory, transport, vision, rainyAt, dormancy, crisisState } = deps;
    /** 存在感（ADR 0083）：在线状态 / 资料卡点赞 / 个性签名 / 说说；第一次连上才起，一个开关都没开就不起 */
    let presence: Presence | undefined;
    function startPresence(): void {
        if (presence) return;
        if (!config.onlineStatus && !config.profileLikes && config.qzone === 'off' && !config.pokeOut) return;
        if (!worldCard?.schedule) {
            log('存在感：没有作息（herDays 关或卡上没有作息），不启动——在线状态、点赞、签名、说说都按她的作息排');
            return;
        }
        const schedule = worldCard.schedule;
        const extraFree = config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
        const dir = join(config.dataDir, 'presence');
        // 说说用最低隐私档的卡来写（陌生人档，没有就同学档）；两张都读不了就不发说说
        let lowest: TierCard | undefined;
        for (const tier of ['stranger', 'classmate']) {
            try { lowest = cardFor(tier); break; } catch { /* 试下一档 */ }
        }
        const publicSchedule = lowest?.character.schedule ?? schedule;
        const qzone = config.qzone !== 'off' && lowest
            ? qzoneComposer({
                character: { name: lowest.character.name, description: lowest.character.description, personality: lowest.character.personality, banned: lowest.character.banned },
                generate: messages => (exec.llm({ purpose: 'background', config: { ...config.llm, temperature: 1.1 }, messages }, log)),
                ...(vision ? { vision } : {}),
                photoDir: join(dir, 'photos'),
                situation: now => [
                    // 这一档自己的作息：空闲时她在干什么按这一档看得到的来（男朋友档知道的事——买相机、他——不能漏进谁都可能看到的说说里）
                    `你现在：${describeState(stateAt(publicSchedule, new Date(now), extraFree), publicSchedule)}`,
                    ...(rainyAt(now) ? ['天气：在下雨'] : []),
                ],
                log,
            })
            : undefined;
        if (config.qzone !== 'off' && !qzone) log('存在感：陌生人档和同学档的卡都读不了，不写说说');
        presence = createPresence({
            ...(dormancy ? { paused: () => dormancy.isDormant() } : {}),
            flags: { onlineStatus: config.onlineStatus, profileLikes: config.profileLikes, signature: config.qzone, qzone: qzone ? config.qzone : 'off', qzoneVisibility: config.qzoneVisibility, pokeOut: config.pokeOut, qzoneBrowse: config.qzone, qzonePeek: config.qzone, qzoneStrangers: config.qzone },
            transport, schedule, extraFree,
            likeTargets: config.contacts.filter(c => c.tier === 'boyfriend').map(c => c.qq),
            // 能看谁的空间：只放用户点名的（qqAllowFriends），名字用于提示词里说是谁的空间
            peekTargets: config.contacts.filter(c => (config.qqAllowFriends ?? []).includes(c.qq)).map(c => ({ qq: c.qq, name: c.name })),
            pokeTargets: config.contacts.filter(c => c.tier === 'boyfriend').map(c => c.qq),
            // 聊天安静了一阵、最后一条是她说的、不是刚道过晚安，且没在危机暂停里，才戳他（ADR 0087）
            canPokeOut: (qq, now) => !crisisState.pausedAt(qq, now) && quietEnoughToPoke(chatHistory.load(qq), now),
            recordPokeOut: (qq, now) => { chatHistory.append(qq, { time: new Date(now).toISOString(), role: 'assistant', content: POKE_OUT_TEXT, messageId: pokeOutMessageId(now) }); },
            dir, now: worldNow, log,
            saidSleep: now => Boolean(asleepSince(schedule, bedtimes(schedule, now), new Date(now))),
            festival: day => worldCard.dates.find(d => FESTIVAL_SIGNATURES[d.name] && dayMatches(d, day) === 'solar')?.name,
            rainy: rainyAt,
            ...(qzone ? { composeQzone: qzone } : {}),
        });
        presence.start();
        log(`存在感：${[config.onlineStatus && '在线状态', config.profileLikes && '资料卡点赞', config.pokeOut && '主动戳他', config.qzone !== 'off' && `个性签名（${config.qzone === 'dryRun' ? '只写草稿' : '真改'}）`, qzone && `说说（${config.qzone === 'dryRun' ? '只写草稿' : '真发'}，${config.qzoneVisibility === 'public' ? '所有人可见' : '仅好友可见'}）`, config.qzone !== 'off' && `翻空间（${config.qzone === 'dryRun' ? '只写草稿' : '记进提示词'}）`, config.qzone !== 'off' && `看好友空间（${config.qzone === 'dryRun' ? '只写草稿' : '记进提示词'}）`, config.qzone !== 'off' && `刷陌生人（${config.qzone === 'dryRun' ? '只写草稿' : '记进提示词 + 留样本'}）`].filter(Boolean).join('、')}`);
    }
    return {
        start: startPresence,
        reapply: () => presence?.reapply(),
        selfNote: now => presence?.selfNote(now),
        stop: () => presence?.stop(),
    };
}
