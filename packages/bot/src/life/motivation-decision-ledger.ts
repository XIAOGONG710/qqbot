import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { validShadowDriveDecision, type ShadowDriveDecision } from './motivation-resolution.ts';

interface DecisionFile { version: 1; decisions: ShadowDriveDecision[] }
export interface MotivationDecisionLedger { decisions(): readonly ShadowDriveDecision[]; append(incoming: readonly ShadowDriveDecision[]): number }
const unique = (items: readonly ShadowDriveDecision[]) => new Set(items.map(item => item.id)).size === items.length;
const validFile = (value: unknown): value is DecisionFile => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Partial<DecisionFile>).version === 1 && Array.isArray((value as Partial<DecisionFile>).decisions)
    && (value as Partial<DecisionFile>).decisions!.every(validShadowDriveDecision) && unique((value as DecisionFile).decisions));

export function readMotivationDecisionLedger(path: string, driveIds: () => readonly string[], log: (message: string) => void = () => undefined): MotivationDecisionLedger {
    mkdirSync(dirname(path), { recursive: true });
    const loaded = readJsonOr<DecisionFile>(path, { version: 1, decisions: [] }, log, { validate: validFile, invalid: 'throw', label: '影子动机裁决账' });
    if (!loaded.decisions.every(decision => driveIds().includes(decision.driveId))) throw new Error('影子动机裁决引用了不存在的动机');
    let decisions = loaded.decisions;
    return {
        decisions: () => decisions,
        append: incoming => {
            const known = new Map(decisions.map(decision => [decision.id, decision]));
            for (const decision of incoming) {
                if (!validShadowDriveDecision(decision)) throw new Error('影子动机裁决格式无效');
                if (!driveIds().includes(decision.driveId)) throw new Error('影子动机裁决引用了不存在的动机');
                if (!known.has(decision.id)) known.set(decision.id, decision);
            }
            const next = [...known.values()].sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt) || a.id.localeCompare(b.id, 'zh-CN'));
            const added = next.length - decisions.length;
            if (added) { writeJsonAtomic(path, { version: 1, decisions: next } satisfies DecisionFile); decisions = next; }
            return added;
        },
    };
}
