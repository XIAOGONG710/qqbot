// ADR 0338 的影子闭环：时间事件 → 影响 → 动机 → 内部候选。
// 此文件绝不调用消息、搜索、设备、媒体或其他执行器。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMotivationLedger, type MotivationLedger } from '../life/motivation-ledger.ts';
import { internalDrivesAt, type Drive } from '../life/motivation.ts';
import { resolveShadowDrives, shadowActivityForDecision } from '../life/motivation-resolution.ts';
import { readMotivationDecisionLedger, type MotivationDecisionLedger } from '../life/motivation-decision-ledger.ts';
import { expressionOpportunity } from '../life/expression-opportunity.ts';
import { readExpressionOpportunityLedger, type ExpressionOpportunityLedger } from '../life/expression-opportunity-ledger.ts';
import type { RegulationSnapshot } from '../life/regulation.ts';
import { readWorldEventLedger, type WorldEventLedger } from './event-ledger.ts';
import { readWorldImpactLedger, type WorldImpactLedger } from './impact-ledger.ts';
import type { WorldImpact } from './impacts.ts';
import { readTimeObserver, type TimeObserver } from './time-observer.ts';
import type { WorldEvent } from './events.ts';
import { observeWorldNow } from './world-event-observer.ts';
import type { WorldNow } from './world.ts';
import { associateWorldEvent } from './associations.ts';
import { readWorldAssociationLedger, type WorldAssociationLedger } from './association-ledger.ts';
import { externalObservationEvent, type ExternalObservation } from './external-sources.ts';

export interface AgencyShadow {
    observe(at: Date, regulation: RegulationSnapshot): { events: number; impacts: number; drives: number; candidates: number };
    /** 只登记“收到消息”这一事实，正文仍只留在既有聊天记录中；不产生影响或活动。 */
    recordUserMessage(qq: number, messageId: number, occurredAt: Date, observedAt: Date): number;
    /** 记录已有世界快照中的结构化环境事实；不联网、不发送、不保存供应商正文。 */
    recordWorld(now: WorldNow, observedAt: Date): number;
    /** 外部适配器只能传已清洗观察；原始供应商正文不进入影子账。 */
    recordExternal(observation: ExternalObservation, observedAt: Date): number;
    events: WorldEventLedger;
    impacts: WorldImpactLedger;
    associations: WorldAssociationLedger;
    motivations: MotivationLedger;
    decisions: MotivationDecisionLedger;
    opportunities: ExpressionOpportunityLedger;
}

function timeImpact(eventId: string, kind: string, at: string): WorldImpact {
    const aspect = kind === 'time.dayPhase.changed' ? 'availability' : 'world-context';
    return { id: `impact:${eventId}:self:${aspect}`, eventId, target: 'self', aspect, direction: 'uncertain', magnitude: kind === 'time.dayPhase.changed' ? 0.2 : 0.05, confidence: 1, assessedAt: at };
}

function contextImpact(event: WorldEvent, at: string): WorldImpact {
    if (event.source === 'time') return timeImpact(event.id, event.kind, at);
    const aspect = event.source === 'world' ? 'environment' : event.source === 'society' ? 'public-context' : 'local-context';
    return { id: `impact:${event.id}:self:${aspect}`, eventId: event.id, target: 'self', aspect, direction: 'uncertain', magnitude: 0.1, confidence: event.confidence, assessedAt: at };
}

function awarenessDrive(impact: WorldImpact): Drive {
    return {
        id: `drive:${impact.id}:awareness`, source: 'external', goal: '保持对世界变化的了解', target: 'self', impactIds: [impact.id],
        strength: impact.magnitude, urgency: 0, persistence: 0.35, createdAt: impact.assessedAt, status: 'active',
    };
}

export function readAgencyShadow(dataDir: string, initialAt: Date, log: (message: string) => void = () => undefined): AgencyShadow {
    const dir = join(dataDir, 'agency-shadow');
    mkdirSync(dir, { recursive: true });
    const events = readWorldEventLedger(join(dir, 'events.json'), log);
    const impacts = readWorldImpactLedger(join(dir, 'impacts.json'), events.events, log);
    const associations = readWorldAssociationLedger(join(dir, 'associations.json'), events.events, log);
    const motivations = readMotivationLedger(join(dir, 'motivations.json'), log);
    const decisions = readMotivationDecisionLedger(join(dir, 'decisions.json'), () => motivations.drives().map(drive => drive.id), log);
    const opportunities = readExpressionOpportunityLedger(join(dir, 'opportunities.json'), log);
    const time: TimeObserver = readTimeObserver(join(dir, 'time.json'), initialAt, events, log);
    return {
        events, impacts, associations, motivations, decisions, opportunities,
        recordUserMessage: (qq, messageId, occurredAt, observedAt) => {
            if (!Number.isSafeInteger(qq) || qq <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0
                || !Number.isFinite(occurredAt.getTime()) || !Number.isFinite(observedAt.getTime())) return 0;
            const event: WorldEvent = {
                id: `user-message:${qq}:${messageId}`,
                source: 'user',
                kind: 'user.message.received',
                occurredAt: occurredAt.toISOString(),
                observedAt: observedAt.toISOString(),
                status: 'active',
                subjects: [`user:${qq}`],
                details: { channel: 'private' },
                confidence: 1,
            };
            return events.append([event]);
        },
        recordWorld: (now, observedAt) => events.append(observeWorldNow(now, observedAt)),
        recordExternal: (observation, observedAt) => {
            const event = externalObservationEvent(observation, observedAt);
            return event ? events.append([event]) : 0;
        },
        observe: (at, regulation) => {
            const eventsAdded = time.observe(at);
            const knownAssociations = new Set(associations.associations().map(association => association.id));
            associations.append(events.events().flatMap(associateWorldEvent).filter(association => !knownAssociations.has(association.id)));
            const assessedEvents = new Set(impacts.impacts().map(impact => impact.eventId));
            const newImpacts = events.events().filter(event => !assessedEvents.has(event.id)
                && (event.source === 'time' || event.source === 'world' || event.source === 'society' || event.source === 'sandbox'))
                .map(event => contextImpact(event, at.toISOString()));
            const impactsAdded = impacts.append(newImpacts);
            const knownImpacts = new Set(motivations.drives().flatMap(drive => drive.impactIds ?? []));
            const drivesAdded = motivations.appendDrives([
                ...impacts.impacts().filter(impact => !knownImpacts.has(impact.id)).map(awarenessDrive),
                ...internalDrivesAt(regulation),
            ]);
            const knownDecisions = new Set(decisions.decisions().map(decision => decision.id));
            decisions.append(resolveShadowDrives(motivations.drives(), regulation, at).filter(decision => !knownDecisions.has(decision.id)));
            for (const decision of decisions.decisions()) {
                const drive = motivations.drives().find(item => item.id === decision.driveId);
                if (drive) opportunities.append(expressionOpportunity(decision, drive, regulation));
            }
            const knownDrives = new Set(motivations.candidates().map(candidate => candidate.driveId));
            const byDrive = new Map(motivations.drives().map(drive => [drive.id, drive]));
            const candidates = decisions.decisions().filter(decision => !knownDrives.has(decision.driveId))
                .map(decision => shadowActivityForDecision(decision, byDrive.get(decision.driveId)!, regulation, at))
                .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
            const candidatesAdded = motivations.appendCandidates(candidates);
            return { events: eventsAdded, impacts: impactsAdded, drives: drivesAdded, candidates: candidatesAdded };
        },
    };
}

