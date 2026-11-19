import { writeDshState } from './dsh-state-export.ts';
import type { DshState } from './dsh-link.ts';
import type { Executor } from './executor/executor.ts';
import { humanStateAt } from './human-projection.ts';
import type { loadNeedsAnchor } from './life/needs.ts';
import type { currentTierHistory } from './memory/tier-record.ts';
import type { Contact } from './platform/config.ts';
import type { Log } from './platform/log.ts';
import type { AiPhotoDraftStore } from './vision/ai-photo-drafts.ts';
import type { settlingWorld } from './world/action-queue.ts';

// 给 DSH 的脱敏状态摘要（只有数值和事件类型，不带聊天原文）和写到灵魂目录的 STATE.json。
// `/dsh ask`、手机伴侣现取摘要；dsh-state 模块定时写快照。
// 原来在 app.ts（dshState / exportDshState），ADR 0336 第 6 步原样搬到这里；启动时写一次（或删掉旧的）仍在 App 原位。
export interface DshStateDeps {
    dshEnabled: boolean;
    needsAnchor: ReturnType<typeof loadNeedsAnchor> | undefined;
    sharedWorld: ReturnType<typeof settlingWorld> | undefined;
    deviceOwner: Contact | undefined;
    history: ReturnType<typeof currentTierHistory>;
    aiPhotoDrafts: AiPhotoDraftStore;
    worldNow: () => number;
    exec: Pick<Executor, 'files'>;
    /** 灵魂目录里的 STATE.json */
    dshStateFile: string;
    log: Log;
}

export function dshStateSource({ dshEnabled, needsAnchor, sharedWorld, deviceOwner, history, aiPhotoDrafts, worldNow, exec, dshStateFile, log }: DshStateDeps) {
    /** DSH 咨询只拿脱敏状态摘要，不带完整聊天记录。 */
    const dshState = (): DshState | undefined => {
        if (!needsAnchor) return undefined;
        const at = new Date(worldNow());
        try {
            const events = sharedWorld?.events?.() ?? [];
            // 只在本地用最近一小段 QQ 记录计算关系数值；传给 DSH 的仍然只有数值和事件类型，不外发原文。
            const recentHistory = deviceOwner ? history.load(deviceOwner.qq).slice(-24) : [];
            const { needs, values, development, trends } = humanStateAt({ anchor: needsAnchor, events, at, history: recentHistory, tier: deviceOwner?.tier ?? 'boyfriend' });
            const photoStatus = aiPhotoDrafts.status();
            const latestPhoto = aiPhotoDrafts.list().at(-1);
            return {
                at: at.toISOString(),
                tier: deviceOwner?.tier ?? 'boyfriend',
                needs: { energy: needs.energy, hunger: needs.hunger, stress: needs.stress },
                values: {
                    energy: values.energy, hunger: values.hunger, stress: values.stress, mood: values.mood,
                    health: values.health, loneliness: values.loneliness, motivation: values.motivation,
                    boredom: values.boredom, socialBattery: values.socialBattery,
                },
                relationship: values.relationship,
                development,
                trends,
                recentEvents: events.slice(-8).map(event => event.kind),
                photoDrafts: {
                    pending: photoStatus.pending,
                    approved: photoStatus.approved,
                    rejected: photoStatus.rejected,
                    ...(latestPhoto ? { lastKind: latestPhoto.kind, lastStatus: latestPhoto.status } : {}),
                },
            };
        } catch (error) {
            log(`DSH：读取状态摘要失败（${error instanceof Error ? error.message : String(error)}）`);
            return undefined;
        }
    };

    const exportDshState = (): void => {
        if (!dshEnabled) return;
        try {
            const state = dshState();
            if (state) writeDshState(dshStateFile, state, worldNow());
            else exec.files.remove(dshStateFile);
        } catch (error) {
            log(`DSH：状态快照没写出去（${error instanceof Error ? error.message : String(error)}）`);
        }
    };

    return { dshState, exportDshState };
}
