import type { StoredMessage } from '../memory/history.ts';
import { ownerOf, type AppConfig, type Contact } from '../platform/config.ts';
import type { AgencyShadow } from '../world/agency-shadow.ts';
import type { GroupDecisionTrace } from './group-chat.ts';
import { groupOpportunity, type GroupMotiveDecision } from './group-opportunity.ts';
import { defendWishFrom, type DefendWish } from './group-self.ts';

// 群自主（ADR 0341 / 0343）交给群聊那一摊（social/group-room.ts）的几样：群里用的时钟、表达机会的快照、决策痕迹、他要不要她出头。
// 快照只在这里取、observe / record 仍由 App 独占；模拟钩子（sim/group-runner.ts）不传时与原来逐字一致。
// 原来在 app.ts 里建 groupRoom 之前算，ADR 0336 收尾（docs/plans/2026-11-24-0336-finish.md）原样搬到这里。

/** 群自主的模拟钩子（仅 sim 用，线上不传）：替换动机快照、收集决策痕迹、给群聊一个假时钟 */
export interface GroupAgencyHooks {
    motiveOverride?: GroupMotiveDecision;
    onDecision?: (trace: GroupDecisionTrace) => void;
    now?: () => number;
}

export interface GroupAgencyWiringDeps {
    config: Pick<AppConfig, 'groupAgency' | 'contacts'>;
    hooks: GroupAgencyHooks | undefined;
    /** App 的时钟（没有模拟钩子时群里也用它） */
    worldNow: () => number;
    agencyShadow: AgencyShadow | undefined;
    /** 他的聊天记录（他在私聊里最近说的那句要不要她出头） */
    history: (qq: number) => readonly StoredMessage[];
}

export interface GroupAgencyWiring {
    worldNow: () => number;
    groupOpportunity?: () => GroupMotiveDecision;
    onDecision?: (trace: GroupDecisionTrace) => void;
    defendWish?: () => DefendWish | undefined;
}

export function groupAgencyWiring({ config, hooks: agencyHooks, worldNow, agencyShadow, history }: GroupAgencyWiringDeps): GroupAgencyWiring {
    const groupWorldNow = agencyHooks?.now ?? worldNow;
    const agencyActive = (config.groupAgency ?? 'off') !== 'off' || Boolean(agencyHooks?.motiveOverride);
    const agencyMotive = agencyActive ? (): GroupMotiveDecision =>
        agencyHooks?.motiveOverride ?? groupOpportunity(new Date(groupWorldNow()), agencyShadow) : undefined;
    const groupBoyfriend: Contact | undefined = ownerOf(config.contacts);
    return {
        worldNow: groupWorldNow,
        ...(agencyMotive ? { groupOpportunity: agencyMotive } : {}),
        ...(agencyHooks?.onDecision ? { onDecision: agencyHooks.onDecision } : {}),
        // 群里有人损他，她出不出头先看他自己的意思（groupAgency B，她 11-22：「你不想我掺和我就装没看见」）：他在私聊里最近说的那句
        ...(config.groupAgency !== 'off' && groupBoyfriend ? { defendWish: () => defendWishFrom(history(groupBoyfriend.qq)) } : {}),
    };
}
