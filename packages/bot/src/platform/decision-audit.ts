import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PromptManifest } from './prompt-manifest.ts';
import type { Log } from './log.ts';
import { inspectReply, type ExitIssue, type ReviewOptions } from '../language/exit-check.ts';
import type { Turn } from '../interpreter/interpreter.ts';
import type { AppOptions } from './app.ts';
import { SENSITIVE_OFF } from './sensitive.ts';

const PHASES = ['judgment', 'quality', 'delivery'] as const;
const OUTCOMES = ['selected', 'passed', 'rewritten', 'filtered', 'blocked', 'delivered', 'unconfirmed'] as const;
const REASONS = {
    'private-reply': '按当前私聊作答', 'planned-contact': '按已选主动话题开口', 'reflection': '仅作内部回顾',
    'memory-context': '本轮有可用记忆上下文', 'reading-context': '有在读资料作为依据',
    'relationship-state': '本轮关系中的别扭或修复影响回应', 'safety-route': '本轮走安全回应路径', 'interruption': '当前有打断事件',
    'group-addressed': '群友点名或引用', 'group-topic': '群里出现相关话题', 'group-other': '群聊触发了其他公开开口条件',
    'unsupported-action': '草稿声称要做当前出口不支持的动作', 'forbidden-word': '草稿命中出口禁止用词',
    'script-format': '草稿包含代写对话或提示词结构', 'media-format': '草稿照抄了输入媒体格式',
    'text-boundary': '草稿超出当前文字互动边界', 'factual-review': '草稿未通过事实检查',
    'style-review': '草稿有表达问题', 'quality-checked': '草稿通过最终出口检查', 'check-unavailable': '出口审查没有可用的检查上下文',
    'transport-result': '消息传输返回结果',
} as const;
export type AuditReason = keyof typeof REASONS;
type Phase = (typeof PHASES)[number];
type Outcome = (typeof OUTCOMES)[number];
type AuditRecord = { v: 1; id: string; phase: Phase; outcome: Outcome; reasons: AuditReason[] };
export type AuditEvent = (phase: Phase, outcome: Outcome, ...reasons: AuditReason[]) => void;

function allowedRecord(value: unknown): AuditRecord | undefined {
    const part = value as Partial<AuditRecord> | undefined;
    if (part?.v !== 1 || typeof part.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(part.id)
        || !PHASES.includes(part.phase as Phase) || !OUTCOMES.includes(part.outcome as Outcome) || !Array.isArray(part.reasons)) return undefined;
    const reasons = [...new Set(part.reasons.filter(reason => typeof reason === 'string' && Object.hasOwn(REASONS, reason)))];
    if (!reasons.length) return undefined;
    return { v: 1, id: part.id, phase: part.phase!, outcome: part.outcome!, reasons };
}

/** Rebuild every row from the safe schema, including when the source file was edited. */
export function exportDecisionAudit(jsonl: string): AuditRecord[] {
    return jsonl.split('\n').flatMap(line => {
        try { const row = allowedRecord(JSON.parse(line)); return row ? [row] : []; }
        catch { return []; }
    });
}

export function createDecisionAudit(dataDir: string, log: Log) {
    const dir = join(dataDir, 'logs');
    let warned = false;
    const begin = (): AuditEvent => {
        const id = randomUUID();
        return (phase, outcome, ...reasons) => {
            const row = allowedRecord({ v: 1, id, phase, outcome, reasons });
            if (!row) return;
            try {
                mkdirSync(dir, { recursive: true });
                const day = new Date().toISOString().slice(0, 10);
                appendFileSync(join(dir, `decision-audit-${day}.jsonl`), `${JSON.stringify(row)}\n`);
                warned = false;
            } catch {
                if (!warned) log('判断审计暂不可写');
                warned = true;
            }
            if (phase === 'quality' && outcome !== 'passed') log(`质量检查 ${id} ${outcome} ${row.reasons.map(reason => REASONS[reason]).join('、')}`);
        };
    };
    return {
        begin,
        manifest(manifest: PromptManifest) {
            if (manifest.kind === 'group') begin()('judgment', 'selected', manifest.reason === 'mentioned'
                ? 'group-addressed' : manifest.reason === 'topic' ? 'group-topic' : 'group-other');
        },
    };
}

export type DecisionAudit = ReturnType<typeof createDecisionAudit>;

export function withDecisionAudit(options: AppOptions): AppOptions {
    if (process.env.QQBOT_DECISION_AUDIT !== '1') return options;
    const decisionAudit = createDecisionAudit(options.config.dataDir, options.log);
    return { ...options, decisionAudit, log: () => {}, sensitive: SENSITIVE_OFF, promptManifest: decisionAudit.manifest };
}
const HARD_CODES: Partial<Record<ExitIssue['kind'], AuditReason>> = {
    promise: 'unsupported-action', banned: 'forbidden-word', script: 'script-format', media: 'media-format', 'text-intimacy': 'text-boundary',
};

export function judgmentReasons(turn: Turn): AuditReason[] {
    const facts = turn.facts;
    return [turn.thinking ? 'reflection' : turn.initiate ? 'planned-contact' : 'private-reply',
        ...(facts.crisis ? ['safety-route' as const] : []), ...(facts.grievanceActive ? ['relationship-state' as const] : []),
        ...(facts.recall && Object.values(facts.recall).some(Boolean) ? ['memory-context' as const] : []), ...(facts.books ? ['reading-context' as const] : []),
        ...(facts.interruption ? ['interruption' as const] : [])];
}

export function qualityReasons(text: string, options?: ReviewOptions): AuditReason[] {
    if (!options) return [];
    return [...new Set(inspectReply(text, options.banned, options.speech, options.books, options.faces, options.textIntimacy, options.imageStickers)
        .map(issue => HARD_CODES[issue.kind] ?? 'style-review'))];
}
