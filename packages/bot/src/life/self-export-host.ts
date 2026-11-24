import { join } from 'node:path';
import type { StoredMessage } from '../memory/history.ts';
import { consumeSelfReceipts, type SelfReceiptPlanner } from '../memory/self-receipts.ts';
import { oneLifeAt, type AppConfig, type Contact } from '../platform/config.ts';
import type { ContactPipelineOptions, ContactResponder } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import { renderSelf, selfExportPath, writeSelfExport } from './self-export.ts';
import { SELF_RECEIPTS_FILE, type SelfPending } from './self-types.ts';

// 「此刻的她」（SELF.json，ADR 0347 第 2 层，配置 selfExport，默认关）在 App 里的那一摊：
// 他那条流水线的快照（拼 QQ「此刻」块的同一批模块）+ 攒着想跟他说的，写进灵魂目录；发给他一条之后稍后刷新；
// 桌面回执（selfReceipts）收进计划器。只给 deviceOwner（名单里第一个男朋友档，ADR 0020）。
// 原来在 app.ts 里（exportSelf / pendingOf / afterSentToOwner / ownerSnapshot / 收件箱那一拍里的回执），
// ADR 0336 收尾（docs/plans/2026-11-24-0336-finish.md）原样搬到这里；什么时候写仍由 self-export 模块的定时和 App 定。

export interface SelfExportHostDeps {
    config: Pick<AppConfig, 'dataDir' | 'oneLife'>;
    /** 名单里第一个男朋友档（deviceOwner） */
    owner: Contact | undefined;
    soulDir: () => string;
    worldNow: () => number;
    stopped: () => boolean;
    dormant: () => boolean;
    /** 危机暂停中（攒着的整块不出） */
    crisisPaused: (qq: number, now: number) => boolean;
    /** 他的聊天记录（最后一条的时刻） */
    history: (qq: number) => readonly StoredMessage[];
    /** 他的主动消息计划器（回执记成说过了）；搭 App 时第一次同步收件箱那会儿还没建好，是 undefined */
    planner: (qq: number) => SelfReceiptPlanner | undefined;
    /** 写 SELF 时取计划器（攒着的）：同原来直接读计划器表 */
    plannerForExport: (qq: number) => unknown;
    /** self-export 模块的「稍后刷新一次」 */
    refreshSoon: () => void;
    log: Log;
}

export interface SelfExportHost {
    /** 写一次 SELF.json；返回这一份的有效期（到点再写），没写返回 undefined */
    exportSelf(): Promise<number | undefined>;
    /** 建好一个联系人的回复器之后交过来：他那条流水线的快照留着（selfExport 开着才留） */
    watch(contact: Contact, responder: Pick<ContactResponder, 'snapshot'>): void;
    /** 发给他的一条发出去之后刷新 SELF.json（selfExport 关着、不是他时原样返回 send） */
    afterSentToOwner(contact: Contact, send: ContactPipelineOptions['send']): ContactPipelineOptions['send'];
    /** DSH 收件箱那一拍里的桌面回执（selfReceipts） */
    syncReceipts(now: Date): void;
}

export function selfExportHost({ config, owner: deviceOwner, soulDir, worldNow, stopped, dormant, crisisPaused, history, planner: plannerOf, plannerForExport, refreshSoon, log }: SelfExportHostDeps): SelfExportHost {
    // 他（deviceOwner）那条流水线的「此刻的她」快照：只有开了 selfExport 才留；别的联系人的流水线不留，SELF 只写他的（ADR 0020）
    let ownerSnapshot: ContactResponder['snapshot'] | undefined;
    // 休眠时不写；危机暂停时攒着的整块不出（paused: 'crisis'）。已经写过的那份不删，靠过期降级。
    // 攒着的由计划器给（pendingForSelf，ADR 0347 第 2 层 C 块）：计划器有这个方法才调。日志只记行数和件数
    let selfLogged: string | undefined;
    const pendingOf = (planner: unknown, now: number): SelfPending[] => {
        const provider = (planner as { pendingForSelf?: unknown } | undefined)?.pendingForSelf;
        return typeof provider === 'function' ? (provider as (now: number) => SelfPending[]).call(planner, now) : [];
    };
    const exportSelf = async (): Promise<number | undefined> => {
        const owner = deviceOwner;
        const snapshot = ownerSnapshot;
        if (!oneLifeAt(config.oneLife, 'export') || !owner || !snapshot || stopped() || dormant()) return undefined;
        try {
            const at = new Date(worldNow());
            const { pieces, facts } = await snapshot(at);
            if (stopped()) return undefined;
            const paused = crisisPaused(owner.qq, at.getTime());
            const lastAt = Date.parse(history(owner.qq).at(-1)?.time ?? '');
            const self = renderSelf({
                at, pieces, ...(facts.state ? { state: facts.state } : {}), ...(facts.schedule ? { schedule: facts.schedule } : {}),
                ...(Number.isFinite(lastAt) ? { lastChatAt: lastAt } : {}),
                pending: paused ? [] : pendingOf(plannerForExport(owner.qq), at.getTime()), paused,
            });
            if (writeSelfExport(selfExportPath(soulDir()), self)) {
                const counts = `${self.lines.length} 行、攒着 ${self.pending.length} 件${paused ? '（危机暂停中，攒着的不放）' : ''}`;
                if (counts !== selfLogged) log(`此刻的她：SELF.json ${counts}（不记内容）`);
                selfLogged = counts;
            }
            return Date.parse(self.validUntil);
        } catch (error) {
            log(`此刻的她：SELF.json 没写出去（${error instanceof Error ? error.message : String(error)}）`);
            return undefined;
        }
    };
    return {
        exportSelf,
        watch(contact, responder) {
            if (oneLifeAt(config.oneLife, 'export') && contact.qq === deviceOwner?.qq) ownerSnapshot = responder.snapshot;
        },
        afterSentToOwner(contact, send) {
            if (!oneLifeAt(config.oneLife, 'export') || contact.qq !== deviceOwner?.qq) return send;
            return async (userId, text, sendOptions) => {
                const id = await send(userId, text, sendOptions);
                refreshSoon();
                return id;
            };
        },
        syncReceipts(now) {
            // 桌面回执（ADR 0347 第 2 层，selfReceipts）：她在桌面上把攒着的话说出口了，计划器记成说过了，QQ 不再重发；收到了就刷新一次 SELF
            const owner = deviceOwner;
            const planner = owner && oneLifeAt(config.oneLife, 'export') ? plannerOf(owner.qq) : undefined;
            if (planner) {
                const counts = consumeSelfReceipts({
                    file: join(soulDir(), SELF_RECEIPTS_FILE),
                    stateFile: join(config.dataDir, 'memory', 'self-receipts-state.json'),
                    planner, now, log,
                });
                if (counts.receipts) refreshSoon();
            }
        },
    };
}
